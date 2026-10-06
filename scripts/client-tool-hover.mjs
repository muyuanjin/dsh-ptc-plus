import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SETTINGS_COPY } from '../src/client-copy.js'
import { parseArgs } from 'node:util'
import { assertToolStateVisual, controlAppearance, setFixtureTheme } from './client-visual-contract.mjs'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' } } })
const fixture = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'tool-hover-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {CodeBlock,DisclosureRow,HoverCard} from '@deepseek-ai/dsh-client-ui-primitives';
    import {createPtcToolView} from './src/client-tool-view.js';
    import {installStyles} from './src/client-styles.js';
    import {SETTINGS_COPY} from './src/client-copy.js';
    const h=React.createElement;
    installStyles();
    const Icon=()=>null;
    const {PTCPlusToolRow}=createPtcToolView(React,{HoverCard,
      CodeBlock:window.nativeRow?CodeBlock:undefined,
      DisclosureRow:window.nativeRow?DisclosureRow:undefined,
      icons:{chevron:Icon,check:Icon,inspect:Icon}});
    const source='throw new Error("preview must not execute")';
    let block={kind:'tool-result',callId:'hover-first',call:{name:'run_code',
      argsRaw:JSON.stringify({code:source,description:'Recorded computation'})},
      content:[{type:'text',text:'Recorded output'}],isError:false,subCalls:[],meta:{
        dshPtcPlus:{version:3,bindingMode:'loose',rewritePolicy:{autoRewriteImports:true,
          autoStripExports:true,autoSplitRedeclarations:true},status:'durable',calls:[],operations:[],
          confirms:[],diagnostics:[],completion:{kind:'return',hasValue:false}},
        dshPtcPlusRewrites:[{kind:'import',description:'Adapted import.',source:'node:path'}]}};
    const second={...block,callId:'hover-second',call:{name:'edit_run_code',
      argsRaw:JSON.stringify({code:'return "second row"',description:'Second computation'})}};
    window.inspections=0;
    const root=createRoot(document.querySelector('#root'));
    const t=key=>SETTINGS_COPY[window.locale][key]??key;
    const render=()=>root.render(h('div',{id:'clip'},
      h(PTCPlusToolRow,{toolName:'run_code',block,t,inspect:()=>{window.inspections++}}),
      h(PTCPlusToolRow,{toolName:'edit_run_code',block:second,t})));
    window.setState=state=>{block={...block,...block.call,kind:state==='running'?'tool-call':'tool-result',
      isError:state==='error',error:state==='stopped'?{code:'interrupted'}:undefined};render()};
    window.setLong=()=>{block={...block,call:{...block.call,argsRaw:JSON.stringify({
      code:source+'\\n'+Array.from({length:120},(_,i)=>'const value'+i+' = "'+('long source '.repeat(25))+'"').join('\\n'),
      description:'Long recorded computation'})},content:[{type:'text',text:Array.from({length:120},(_,i)=>'Output '+i+' '+('long output '.repeat(25))).join('\\n')}]};render()};
    window.disposeFixture=()=>root.unmount();
    render();
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'tool-hover-fixture.js',
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
const browser = await chromium.launch({ headless: true, channel: values['browser-channel'] })
try {
  await mkdir('artifacts/tool-hover', { recursive: true })
  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    for (const locale of ['en', 'zh']) for (const nativeRow of [true, false]) {
      const label = `${width}/${theme}/${locale}/${nativeRow}`
      // Each scenario owns its initial viewport and input lifecycle.
      const page = await browser.newPage({ viewport: { width, height: 600 },
        reducedMotion: width === 390 && theme === 'light' && locale === 'en' ? 'no-preference' : 'reduce' })
      await page.setContent('<style>body{margin:0;font:14px system-ui}#root{padding:8px}#clip{overflow:hidden;height:150px;margin-top:40px}</style><div id="root"></div>')
      await setFixtureTheme(page, theme)
      await page.addStyleTag({ content: ':root{--dsw-specific-menu:var(--dsw-alias-bg-layer-3);--dsw-radius-lg:12px}' })
      await page.evaluate(config => {
        Object.assign(window, config)
        window.copies = []
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copies.push(text) } } })
      }, { nativeRow, locale })
      for (const file of fixture.outputFiles) {
        if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text })
        else await page.addScriptTag({ content: file.text })
      }
      const rows = page.locator('.ptcPlusTool')
      const header = rows.first().locator('[aria-expanded]')
      const preview = page.locator('.ptcPlusToolHover')
      await header.waitFor()
      await header.hover()
      await preview.waitFor()
      assert.equal(await header.getAttribute('aria-expanded'), 'false', label)
      assert.ok((await preview.locator('.ptcPlusToolCode').textContent()).includes('throw new Error("preview must not execute")'), label)
      assert.equal(await preview.locator('.ptcPlusIoText').textContent(), 'Recorded output', label)
      assert.equal(await preview.locator('.ptcPlusFeatureName').textContent(), SETTINGS_COPY[locale]['autoRewriteImports.label'], label)
      assert.equal(await preview.locator('.ptcPlusInspect').count(), 0, label)
      assert.equal(await preview.evaluate(element => element.closest('#clip') === null), true, 'preview is clipped by the transcript')
      await page.waitForFunction(() => {
        const preview = document.querySelector('.ptcPlusToolHover')
        return preview && getComputedStyle(preview.parentElement).opacity === '1'
      }, undefined, { timeout: 1000 })
      const material = await controlAppearance(preview.locator('..'))
      assert.ok(material.fillAlpha > 0, label + '/preview material is transparent')
      await assertToolStateVisual(preview, label + '/preview')
      for (const text of await preview.locator('.ptcPlusToolHoverHeading,.ptcPlusToolSectionLabel,.ptcPlusIoText').all()) {
        const appearance = await controlAppearance(text)
        assert.ok(appearance.minContrast >= 3, label + '/unreadable preview text')
      }
      await page.screenshot({ path: `artifacts/tool-hover/${width}-${theme}-${locale}-${nativeRow}-preview.png` })
      await preview.hover()
      // Survives beyond the departure grace while reading the portaled card.
      await page.waitForTimeout(350)
      assert.equal(await preview.isVisible(), true, label + '/pointer grace')
      await page.mouse.move(8, 550, { steps: 3 })
      await preview.waitFor({ state: 'detached' })
      for (const state of ['running', 'error', 'stopped']) {
        await page.evaluate(state => window.setState(state), state)
        await header.hover()
        await preview.waitFor()
        assert.equal(await preview.getAttribute('data-state'), state, label)
        assert.ok(await preview.locator('.ptcPlusToolState').textContent(), label)
        await page.keyboard.press('Escape')
        await preview.waitFor({ state: 'detached' })
        await page.mouse.move(8, 550, { steps: 3 })
      }
      await page.evaluate(() => window.setState('ok'))
      await page.keyboard.press('Tab')
      await header.focus()
      await preview.waitFor()
      await page.keyboard.press('Escape')
      await preview.waitFor({ state: 'detached' })
      assert.equal(await header.evaluate(element => element === document.activeElement), true, label)
      await header.evaluate(element => element.blur())
      await header.focus()
      await preview.waitFor()
      const sourceGeometry = await page.waitForFunction(() => {
        // Highlighting may replace its initial plain pre after mounting.
        // Resolve the current text node on each frame before taking coordinates.
        const element = document.querySelector('.ptcPlusToolHover pre')
        if (!element) return false
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          if (!node.textContent.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          const rect = range.getClientRects()[0]
          if (rect?.width > 0 && rect.height > 0) return {
            x: rect.x, y: rect.y, width: Math.min(rect.width, 50), height: rect.height,
          }
        }
        return false
      }, undefined, { timeout: 3000 }).catch(error => {
        throw new Error(label + '/preview source has no selectable text range', { cause: error })
      })
      const sourceRect = await sourceGeometry.jsonValue()
      await sourceGeometry.dispose()
      await page.mouse.move(sourceRect.x + 1, sourceRect.y + sourceRect.height / 2)
      await page.mouse.down()
      await page.mouse.move(sourceRect.x + sourceRect.width - 1, sourceRect.y + sourceRect.height / 2, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(350)
      assert.equal(await preview.count(), 1, label + '/pointer selection dismissed keyboard preview')
      assert.ok(await page.evaluate(() => window.getSelection()?.toString().length > 0), label + '/source selection lost')
      await page.evaluate(() => window.getSelection().removeAllRanges())
      if (nativeRow) {
        await header.focus()
        assert.equal(await header.evaluate(element => element === document.activeElement), true, label + '/copy starts from focused header')
        await preview.getByRole('button', { name: SETTINGS_COPY[locale]['tool.copy'], exact: true }).click()
        await page.waitForFunction(() => window.copies.length === 1)
        assert.deepEqual(await page.evaluate(() => window.copies), ['throw new Error("preview must not execute")'], label + '/pointer copy lost')
        await page.waitForTimeout(350)
        assert.equal(await preview.count(), 1, label + '/pointer copy dismissed keyboard preview')
      }
      await page.keyboard.press('Escape')
      await preview.waitFor({ state: 'detached' })
      await header.focus()
      await page.keyboard.press('Enter')
      await rows.first().locator('.ptcPlusToolBody').waitFor()
      assert.equal(await header.getAttribute('aria-expanded'), 'true', label)
      await header.hover()
      await page.waitForTimeout(200)
      assert.equal(await preview.count(), 0, label + '/expanded hover')
      await rows.first().locator('.ptcPlusInspect').click()
      assert.equal(await page.evaluate(() => window.inspections), 1, label)
      await header.focus()
      await page.keyboard.press('Space')
      assert.equal(await header.getAttribute('aria-expanded'), 'false', label)
      await header.evaluate(element => element.blur())
      await page.mouse.move(8, 550, { steps: 3 })
      await preview.waitFor({ state: 'detached' })
      const second = rows.last().locator('[aria-expanded]')
      await second.hover()
      await preview.waitFor()
      assert.ok((await preview.locator('.ptcPlusToolCode').textContent()).includes('return "second row"'), label)
      await page.mouse.move(8, 550, { steps: 3 })
      await preview.waitFor({ state: 'detached' })
      await page.evaluate(() => window.setLong())
      await header.hover()
      await preview.waitFor()
      const geometry = await preview.evaluate(element => {
        const card = element.parentElement
        const rect = card.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          scrollable: card.scrollHeight > card.clientHeight }
      })
      assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 600, label + JSON.stringify(geometry))
      assert.equal(geometry.scrollable, true, label + '/long content')
      await preview.evaluate(element => { element.parentElement.scrollTop = element.parentElement.scrollHeight })
      assert.equal(await preview.evaluate(element => element.parentElement.scrollTop > 0), true, label)
      await page.screenshot({ path: `artifacts/tool-hover/${width}-${theme}-${locale}-${nativeRow}.png` })
      assert.equal(await page.evaluate(() => window.inspections), 1, 'hover dispatched inspection')
      await page.evaluate(() => window.disposeFixture())
      await preview.waitFor({ state: 'detached' })
      await page.close()
    }
  }
  const touch = await browser.newPage({ viewport: { width: 390, height: 600 }, hasTouch: true })
  await touch.setContent('<div id="root"></div>')
  await touch.evaluate(() => { window.nativeRow = true; window.locale = 'en' })
  for (const file of fixture.outputFiles) {
    if (file.path.endsWith('.css')) await touch.addStyleTag({ content: file.text })
    else await touch.addScriptTag({ content: file.text })
  }
  const touchHeader = touch.locator('.ptcPlusTool [aria-expanded]').first()
  await touchHeader.dispatchEvent('pointerover', { pointerType: 'touch' })
  await touch.waitForTimeout(200)
  assert.equal(await touch.locator('.ptcPlusToolHover').count(), 0, 'touch hover opened a preview')
  await touchHeader.tap()
  assert.equal(await touchHeader.getAttribute('aria-expanded'), 'true', 'touch did not expand the card')
  assert.equal(await touch.locator('.ptcPlusToolHover').count(), 0, 'touch activation left a preview')
  await touch.close()
  process.stdout.write('Tool hover: 24 native/fallback, locale, theme and viewport cases passed.\n')
} finally {
  await browser.close()
}
