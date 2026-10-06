import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { SETTINGS_COPY } from '../src/client-copy.js'
import { parseArgs } from 'node:util'
import { controlAppearance, setFixtureTheme } from './client-visual-contract.mjs'
import { runBrowserCases, selectBrowserCases } from './browser-case-runner.mjs'

const { values } = parseArgs({ options: {
  'browser-channel': { type: 'string' }, case: { type: 'string', multiple: true },
  list: { type: 'boolean' }, focus: { type: 'boolean' },
} })
const cases = []
for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
  for (const locale of ['en', 'zh']) for (const nativeRow of [true, false]) {
    cases.push({ id: `preview/${width}/${theme}/${locale}/${nativeRow ? 'native' : 'fallback'}`,
      width, height: 600, theme, locale, nativeRow })
  }
}
for (const nativeRow of [true, false]) {
  const row = nativeRow ? 'native' : 'fallback'
  cases.push({ id: `placement/${row}`, width: 1200, height: 700, theme: 'light', locale: 'en', nativeRow, placement: true })
  cases.push({ id: `scroll/${row}`, width: 800, height: 600, theme: 'light', locale: 'en', nativeRow, scroll: true })
  cases.push({ id: `touch/${row}`, width: 390, height: 600, theme: 'light', locale: 'en', nativeRow, touch: true })
  cases.push({ id: `portal/${row}`, width: 320, height: 240, theme: 'dark', locale: 'zh', nativeRow, portalFallback: true })
}
const selected = selectBrowserCases(cases, values.case, { focus: values.focus, list: values.list })
if (values.list) { for (const item of selected) console.log(item.id); process.exit(0) }
const fixture = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'tool-hover-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {createPortal} from 'react-dom';
    import {CodeBlock,DisclosureRow} from '@deepseek-ai/dsh-client-ui-primitives';
    import {createPtcToolView} from './src/client-tool-view.js';
    import {installStyles} from './src/client-styles.js';
    import {SETTINGS_COPY} from './src/client-copy.js';
    if(window.portalFallback) HTMLElement.prototype.showPopover=undefined;
    const h=React.createElement;
    installStyles();
    const Icon=()=>null;
    const {PTCPlusToolRow}=createPtcToolView(React,{createPortal,
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
await mkdir('artifacts/tool-hover', { recursive: true })
await runBrowserCases(selected, async (browser, item) => {
  const { id, width, height, theme, locale, nativeRow } = item
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: !!item.touch,
    reducedMotion: width === 390 ? 'no-preference' : 'reduce' })
  try {
    await page.setContent('<style>body{margin:0;font:14px system-ui}#scroller{height:100vh;overflow:auto}#root{padding:8px}#clip{overflow:hidden;min-height:150px;margin-top:40px}</style><div id="scroller"><div id="root"></div><div style="height:2400px">Conversation content</div></div>')
    await setFixtureTheme(page, theme)
    await page.evaluate(config => {
      Object.assign(window, config)
      window.copies = []
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copies.push(text) } } })
    }, { nativeRow, locale, portalFallback: !!item.portalFallback })
    for (const file of fixture.outputFiles) {
      if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text })
      else await page.addScriptTag({ content: file.text })
    }
    const rows = page.locator('.ptcPlusTool')
    const header = rows.first().locator('[aria-expanded]')
    const preview = page.locator('.ptcPlusToolHover')
    await header.waitFor()
    const moveAway = async () => { await page.mouse.move(width - 3, height - 3); await preview.waitFor({ state: 'detached' }) }
    const openHover = async () => { await header.hover(); await preview.waitFor() }
    const assertBoundedCue = async () => {
      const cue = preview.locator('.ptcPlusToolHoverBounded')
      const footer = preview.locator('.ptcPlusToolHoverFooter')
      assert.equal(await cue.textContent(), SETTINGS_COPY[locale]['tool.previewBounded'], id + '/localized bound')
      assert.equal(await cue.isVisible(), true, id + '/invisible bounded cue')
      const cardBox = await preview.boundingBox()
      const footerBox = await footer.boundingBox()
      const cueBox = await cue.boundingBox()
      for (const [label, bounds, container] of [
        ['footer', footerBox, cardBox], ['bounded cue', cueBox, footerBox],
      ]) {
        assert.ok(bounds && container && bounds.width > 0 && bounds.height > 0, id + '/' + label + ' has no geometry')
        assert.ok(bounds.x >= container.x - 1 && bounds.y >= container.y - 1
          && bounds.x + bounds.width <= container.x + container.width + 1
          && bounds.y + bounds.height <= container.y + container.height + 1, id + '/' + label + ' clipped')
      }
      assert.ok((await controlAppearance(cue)).minContrast >= 3, id + '/unreadable bounded cue')
      assert.equal(await cue.evaluate(element => getComputedStyle(element).opacity), '1', id + '/transparent bounded cue')
    }
    const assertLongPreview = async () => {
      await page.evaluate(() => window.setLong())
      await openHover()
      await assertBoundedCue()
      assert.equal(await preview.evaluate(element => getComputedStyle(element).overflowY), 'clip', id)
      assert.equal(await preview.locator('.ptcPlusToolCode').textContent().then(text => text.includes('value119')), false, id)
      // A hidden label retains DOM text; the visible-bounds oracle must reject it.
      const hiddenCue = await page.addStyleTag({ content: '.ptcPlusToolHoverBounded{display:none!important}' })
      try { await assert.rejects(assertBoundedCue, /invisible bounded cue/) }
      finally { await hiddenCue.evaluate(element => element.remove()) }
      await assertBoundedCue()
      await page.screenshot({ path: `artifacts/tool-hover/${id.replaceAll('/', '-')}-long.png` })
    }
    const assertCompleteExpansion = async () => {
      await header.click()
      assert.ok((await rows.first().locator('.ptcPlusToolCode').textContent()).includes('value119'), id + '/expanded source truncated')
      assert.ok((await rows.first().locator('.ptcPlusIoText').textContent()).includes('Output 119'), id + '/expanded result truncated')
    }
    if (item.placement) {
      await page.addStyleTag({ content: '#root{width:480px;box-sizing:border-box}' })
      await openHover()
      const pointer = await header.boundingBox()
      let box = await preview.boundingBox()
      assert.equal(await preview.getAttribute('data-placement'), 'right', id + '/right preference')
      assert.ok(box.x >= pointer.x + pointer.width / 2 + 15, id + '/not right of pointer')
      // A live conversation width change alters the next hover's usable space.
      await moveAway()
      await page.evaluate(() => document.querySelector('#root').style.width = '1100px')
      await header.hover({ position: { x: 1000, y: 10 } })
      await preview.waitFor()
      assert.equal(await preview.getAttribute('data-placement'), 'bottom', id + '/right edge fallback')
      await moveAway()
      await page.evaluate(() => document.querySelector('#root').style.width = '480px')
      await openHover()
      await page.setViewportSize({ width: 600, height: 700 })
      await page.waitForFunction(() => document.querySelector('.ptcPlusToolHover')?.dataset.placement === 'bottom')
      box = await preview.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 600, id + '/resized viewport')
      await page.setViewportSize({ width: 1200, height: 700 })
      await page.waitForFunction(() => document.querySelector('.ptcPlusToolHover')?.dataset.placement === 'right')
      return
    }
    if (item.touch) {
      await header.dispatchEvent('pointerover', { pointerType: 'touch' })
      await page.waitForTimeout(700)
      assert.equal(await preview.count(), 0, id + '/touch opened preview')
      await header.tap()
      assert.equal(await header.getAttribute('aria-expanded'), 'true', id)
      assert.equal(await preview.count(), 0, id)
      return
    }
    if (item.scroll) {
      await page.evaluate(() => window.setLong())
      // Brief pointer passage must not open a card during navigation.
      await header.hover()
      await page.waitForTimeout(300)
      assert.equal(await preview.count(), 0, id + '/too eager')
      await page.mouse.wheel(0, 32)
      await page.waitForTimeout(700)
      assert.equal(await preview.count(), 0, id + '/opened during wheel navigation')
      await page.evaluate(() => document.querySelector('#scroller').scrollTop = 0)
      await page.waitForTimeout(550)
      await page.mouse.move(width - 3, height - 3)
      await openHover()
      const box = await preview.boundingBox()
      const x = box.x + box.width / 2
      const y = box.y + Math.min(70, box.height / 2)
      // Move under the overlay without injecting a fake wheel target. The
      // passive preview disappears; the same pixels remain conversation input.
      await page.mouse.move(x, y)
      const before = await page.evaluate(() => document.querySelector('#scroller').scrollTop)
      await page.mouse.wheel(0, 180)
      await page.waitForFunction(before => document.querySelector('#scroller').scrollTop > before, before)
      assert.equal(await preview.count(), 0, id + '/visible overlay stole wheel')
      await page.evaluate(() => document.querySelector('#scroller').scrollTop = 0)
      await page.waitForTimeout(550)
      await page.mouse.move(width - 3, height - 3)
      await openHover()
      // First wheel while the pointer is still on the anchor must scroll the
      // conversation and cancel the preview, even before its next React render.
      await page.mouse.wheel(0, 20)
      await preview.waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.querySelector('#scroller').scrollTop > 0)
      await page.waitForTimeout(1200)
      assert.equal(await preview.count(), 0, id + '/stationary pointer reopened')
      // Repeated wheel packets and their scroll events cannot re-arm dwell.
      await page.evaluate(() => document.querySelector('#scroller').scrollTop = 0)
      await page.waitForTimeout(550)
      await header.hover()
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 4)
        await page.waitForTimeout(140)
      }
      await page.waitForTimeout(1100)
      assert.equal(await preview.count(), 0, id + '/scroll crossing reopened')
      await page.evaluate(() => document.querySelector('#scroller').scrollTop = 0)
      await page.waitForTimeout(550)
      await page.mouse.move(width - 3, height - 3)
      await header.hover()
      await preview.waitFor()
      assert.equal(await preview.evaluate(element => getComputedStyle(element).pointerEvents), 'none', id)
      assert.equal(await preview.evaluate(element => getComputedStyle(element).overflowY), 'clip', id)
      // CSS counterexample: making the actual owned preview hit-testable must
      // be observable at the same coordinates, not pass a tautological fixture.
      const geometry = await preview.boundingBox()
      const point = { x: geometry.x + 5, y: geometry.y + 5 }
      assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.ptcPlusToolHover'), point), false, id)
      await page.addStyleTag({ content: '.ptcPlusToolHover{pointer-events:auto!important}' })
      assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.ptcPlusToolHover'), point), true, id + '/hit-test counterexample')
      return
    }
    await openHover()
    assert.equal(await header.getAttribute('aria-expanded'), 'false', id)
    assert.ok((await preview.locator('.ptcPlusToolCode').textContent()).includes('throw new Error("preview must not execute")'), id)
    assert.equal(await preview.locator('.ptcPlusIoText').textContent(), 'Recorded output', id)
    assert.equal(await preview.locator('.ptcPlusFeatureName').textContent(), SETTINGS_COPY[locale]['autoRewriteImports.label'], id)
    assert.equal(await preview.locator('button').count(), 0, id)
    assert.equal(await preview.evaluate(element => element.closest('#clip') === null), true, id + '/portal clipping')
    const material = await controlAppearance(preview)
    assert.ok(material.fillAlpha > 0, id + '/transparent material')
    for (const text of await preview.locator('.ptcPlusToolHoverHeading,.ptcPlusToolHoverState,.ptcPlusToolSectionLabel,.ptcPlusIoText,.ptcPlusToolHoverFooter').all()) {
      const appearance = await controlAppearance(text)
      assert.ok(appearance.minContrast >= 3, id + '/unreadable preview text ' + await text.textContent())
    }
    const box = await preview.boundingBox()
    const anchorBox = await header.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, id + '/viewport')
    if (await preview.getAttribute('data-placement') === 'right') {
      assert.ok(box.x >= anchorBox.x + anchorBox.width / 2 + 15, id + '/covers pointer')
    } else {
      assert.ok(box.y >= anchorBox.y + anchorBox.height || box.y + box.height <= anchorBox.y, id + '/covers trigger')
    }
    assert.equal(await preview.evaluate(element => getComputedStyle(element).pointerEvents), 'none', id)
    await page.screenshot({ path: `artifacts/tool-hover/${id.replaceAll('/', '-')}.png` })
    if (item.portalFallback) {
      assert.equal(await preview.getAttribute('data-clipped'), 'true', id + '/small height not clipped')
      await assertBoundedCue()
    }
    await moveAway()
    if (item.portalFallback) {
      await assertLongPreview()
      await assertCompleteExpansion()
      assert.equal(await header.getAttribute('aria-expanded'), 'true', id + '/small portal expansion')
      await page.evaluate(() => window.disposeFixture())
      assert.equal(await preview.count(), 0, id + '/unmount')
      return
    }
    for (const state of ['running', 'error', 'stopped']) {
      await page.evaluate(state => window.setState(state), state)
      await openHover()
      assert.equal(await preview.locator('.ptcPlusToolHoverHeader').getAttribute('data-state'), state, id)
      await page.keyboard.press('Escape')
      await preview.waitFor({ state: 'detached' })
      await page.mouse.move(width - 3, height - 3)
    }
    await page.evaluate(() => window.setState('ok'))
    await header.focus()
    await preview.waitFor()
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    assert.equal(await header.evaluate(element => element === document.activeElement), true, id)
    await page.keyboard.press('Enter')
    assert.equal(await header.getAttribute('aria-expanded'), 'true', id)
    assert.equal(await preview.count(), 0, id)
    await rows.first().locator('.ptcPlusInspect').click()
    assert.equal(await page.evaluate(() => window.inspections), 1, id)
    if (nativeRow) {
      await rows.first().getByRole('button', { name: SETTINGS_COPY[locale]['tool.copy'], exact: true }).click()
      await page.waitForFunction(() => window.copies.length === 1)
      assert.deepEqual(await page.evaluate(() => window.copies), ['throw new Error("preview must not execute")'], id)
    }
    await header.focus()
    await page.keyboard.press('Space')
    assert.equal(await header.getAttribute('aria-expanded'), 'false', id)
    await header.evaluate(element => element.blur())
    await moveAway()
    const second = rows.last().locator('[aria-expanded]')
    await second.hover()
    await preview.waitFor()
    assert.ok((await preview.locator('.ptcPlusToolCode').textContent()).includes('return "second row"'), id)
    await moveAway()
    await assertLongPreview()
    await assertCompleteExpansion()
    assert.equal(await page.evaluate(() => window.inspections), 1, id + '/hover inspection')
    await page.evaluate(() => window.disposeFixture())
    assert.equal(await preview.count(), 0, id + '/unmount')
  } catch (error) {
    throw new Error(id + ': ' + error.message, { cause: error })
  } finally {
    await page.close()
  }
}, {
  createWorker: async () => {
    const browser = await chromium.launch({ headless: true, channel: values['browser-channel'] })
    return { page: browser, close: () => browser.close() }
  },
})
console.log(`Tool hover: ${selected.length}/${cases.length} passive preview, placement, scroll, touch and portal cases passed.`)
