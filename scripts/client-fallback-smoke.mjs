import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { parseArgs } from 'node:util'
import { assertContentCounterexamples, assertControlVisual, assertToolLayout, assertToolStateVisual, assertToolTypography, assertVisualCounterexamples, assertVisualSurface, controlAppearance, setFixtureTheme } from './client-visual-contract.mjs'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' } } })

const clientBundle = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const clientCss = clientBundle.match(/var CLIENT_CSS = `([\s\S]*?)`;/)?.[1]
assert.ok(clientCss, 'generated client bundle does not publish CLIENT_CSS')

const fixture = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'fallback-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {createPortal} from 'react-dom';
    import {createActionButton,resolvePrimitives} from './src/client-primitives.js';
    import {installStyles} from './src/client-styles.js';
    import {createCatalogOwner} from './src/client-catalog.js';
    import {createMenuChildrenEvidence} from './src/client-host-compat.js';
    import {createAuthoringView} from './src/client-authoring-view.js';
    import {createUserBindingsWorkbench} from './src/client-workbench.js';
    import {createPtcSettingsView} from './src/client-settings-view.js';
    const h=React.createElement;
    installStyles();
    const {Menu,Modal}=resolvePrimitives({},React,createPortal);
    const entries=Array.from({length:8},(_,index)=>({id:'entry-'+index,name:'Entry '+index,
      scope:'namespace',symbols:['value'],purpose:'Stored input',source:'export const value=1',enabled:true}));
    let settleCatalog;
    const catalogPending=new Promise(resolve=>{settleCatalog=resolve});
    const callUserBindings=async (endpoint,payload)=>endpoint==='load'
      ? {revision:1,entry:entries.find(entry=>entry.id===payload.id)} : window.deferCatalog
        ? catalogPending : {revision:1,entries};
    window.settleCatalog=()=>settleCatalog({revision:1,entries});
    const catalogOwner=createCatalogOwner({callUserBindings});
    const Icon=()=>h('span',null,'+');
    const ActionButton=createActionButton(React);
    const IconButton=({icon,label,...props})=>h('button',{...props,'aria-label':label},label);
    const workbench=createUserBindingsWorkbench(React,{TypeScriptEditor:()=>null,BindingConsole:()=>null,
      IconButton,ActionButton,Modal,catalogOwner,icons:{refresh:Icon,plus:Icon,close:Icon,search:Icon,chevron:Icon,
        edit:Icon,check:Icon,trash:Icon}});
    const {PTCPlusSettingsDialog}=createPtcSettingsView(React,{ActionButton,
      BindingsDialog:workbench.BindingsDialog,Modal,useWorkbenchController:workbench.useWorkbenchController,
      icons:{chevron:Icon}});
    const view={mounted:false,reachable:true,candidate:null,candidateKey:null,action:null,message:null};
    const review={reachable:()=>{},getSnapshot:()=>view};
    const {BindingAuthorButton}=createAuthoringView(React,{ActionButton,IconButton,Menu,MenuFallback:Menu,
      BindingsDialog:workbench.BindingsDialog,PTCPlusSettingsDialog,
      useWorkbenchController:workbench.useWorkbenchController,useBindingReview:()=>[review,view],
      catalogOwner,callUserBindings,subscribeReset:()=>()=>{},menuChildren:createMenuChildrenEvidence(),
      icons:{sparkle:Icon,chevron:Icon,close:Icon,check:Icon}});
    const root=createRoot(document.querySelector('#composer'));
    const render=()=>root.render(h(BindingAuthorButton,{sessionId:'fallback-session',t:key=>key,
      useInput:select=>select({draft:''}),inputActions:{setDraft:()=>{}},
      usePtcSettings:select=>select({status:'ready',writable:true,value:{enabled:true}}),useBindingCommand:()=>true}));
    window.setAttention=()=>{view.mounted=true;view.candidate={entry:{name:'Attention'}};view.message='Attention';render()};
    render();
    window.disposeFixture=()=>{root.unmount();catalogOwner.dispose()};
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  define: { __PTC_PLUS_CLIENT_MODULE_ID__: JSON.stringify('dsh-ptc-plus'), 'process.env.NODE_ENV': JSON.stringify('production') },
})
const buttonFixture = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'button-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {Button,DisclosureRow} from '@deepseek-ai/dsh-client-ui-primitives';
    import {createActionButton} from './src/client-primitives.js';
    import {createAuthoringView} from './src/client-authoring-view.js';
    import {installStyles} from './src/client-styles.js';
    import {SETTINGS_COPY} from './src/client-copy.js';
    import {createPtcToolView} from './src/client-tool-view.js';
    const h=React.createElement;
    installStyles();
    const ActionButton=createActionButton(React,window.nativeButtons?Button:undefined);
    const candidate={entry:{name:'Inputs',scope:'namespace',symbols:['value'],
      source:'export const value = 42',modelContext:{includeDeclaration:true,instructions:''}}};
    const view={candidate,candidateKey:'probe',visibility:'expanded',action:null,message:null,writable:true,busy:false};
    window.actions=[];
    const review={attach:()=>()=>{},sync:()=>{},act:(...args)=>window.actions.push(args),display:()=>{}};
    const Icon=()=>null;
    const IconButton=({label,...props})=>h('button',{type:'button',className:'ptcPlusIconButton','aria-label':label,...props},'+');
    const {BindingReviewDock}=createAuthoringView(React,{ActionButton,IconButton,
      useBindingReview:()=>[review,view],icons:{check:Icon,close:Icon,chevron:Icon}});
    const {PTCPlusToolRow}=createPtcToolView(React,{DisclosureRow:window.nativeButtons?DisclosureRow:undefined,
      icons:{chevron:Icon,check:Icon,inspect:Icon}});
    const toolSource='import path from "node:path"; export const answer = 42';
    const toolDescription='Test module syntax, top-level await, relative resolution and continuous state across computations';
    const rewrites=[{kind:'import',description:'Adapted import.',source:'node:path'},
      {kind:'export',description:'Removed export.'}];
    const block={kind:'tool-result',callId:'visual-tool',call:{name:'run_code',
      argsRaw:JSON.stringify({code:toolSource,description:toolDescription})},
      content:[{type:'text',text:'42'}],isError:false,subCalls:[],meta:{
        dshPtcPlus:{version:3,bindingMode:'loose',rewritePolicy:{autoRewriteImports:true,
          autoStripExports:true,autoSplitRedeclarations:true},status:'durable',calls:[],operations:[],
          confirms:[],diagnostics:[],completion:{kind:'return',hasValue:false}},
        dshPtcPlusRewrites:rewrites}};
    const root=createRoot(document.querySelector('#root'));
    const render=()=>root.render(h(React.Fragment,null,
      h(BindingReviewDock,{sessionId:'probe',useProjection:()=>null,t:key=>SETTINGS_COPY[window.buttonLocale][key]??key}),
      h('div',{id:'controls'},
        h(Button,{size:'sm',variant:'primary'},'Native reference'),
        h(ActionButton,{disabled:true},'Disabled action')),
      h(PTCPlusToolRow,{toolName:'run_code',block,inspect:()=>window.actions.push(['inspect']),
        t:key=>SETTINGS_COPY[window.buttonLocale][key]??key}),
      h('div',{id:'following-message'},'Let me do it. Also cleanup probe file later.')));
    window.setToolExample=example=>{
      block.call.argsRaw=JSON.stringify({code:toolSource,
        description:example==='empty'||example==='features-only'?'':example==='short'?'Compute the answer':toolDescription});
      block.meta.dshPtcPlusRewrites=example==='none'||example==='empty'?[]:example==='long'
        ? [{...rewrites[0],source:'file:///workspace/'+('long-provider-path/').repeat(20)+'module.ts'},
          rewrites[1],{kind:'redeclaration',
            description:'split a mixed top-level declaration while preserving native pattern initialization',source:'retainedValue'}]
        : rewrites;
      render();
    };
    window.setBusy=busy=>{view.busy=busy;render()};
    window.setToolState=state=>{
      block.kind=state==='running'?'tool-call':'tool-result';
      block.isError=state==='error';
      block.error=state==='stopped'?{code:'interrupted'}:undefined;
      render();
    };
    render();
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'button-fixture.js',
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
const browser = await chromium.launch({ headless: true, channel: values['browser-channel'] })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  await mkdir('artifacts/button-styles', { recursive: true })
  for (const { width, theme } of [320, 390, 1440].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme })))) {
    for (const native of [true, false]) {
      for (const locale of ['en', 'zh']) {
        await page.goto('about:blank')
        await page.setViewportSize({ width, height: 900 })
        await page.setContent(`<style>
          :root{--dsw-radius-sm:6px}
          body{margin:0;font:14px system-ui}button{font:inherit;background:none;border:0;padding:0}
          #root{padding:8px}#controls{display:flex;gap:8px;margin-top:16px}
        </style><div id="root"></div>`)
        await setFixtureTheme(page, theme)
        await page.evaluate(({ native, locale }) => { window.nativeButtons = native; window.buttonLocale = locale }, { native, locale })
        for (const file of buttonFixture.outputFiles) {
          if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text })
        }
        await page.addScriptTag({ content: buttonFixture.outputFiles.find(file => file.path.endsWith('.js')).text })
        await page.evaluate(css => {
          const style = document.getElementById('ptc-plus-client-style')
          if (!style) throw new Error('packed client style element was not installed')
          const workbenchStart = style.textContent.indexOf('.ptcPlusCandidateContext')
          if (workbenchStart < 0) throw new Error('source workbench styles are not installed')
          style.textContent = css + style.textContent.slice(workbenchStart)
        }, clientCss)
        const actions = page.locator('.ptcPlusBindingDockActions button')
        await actions.last().waitFor()
        const metrics = await actions.evaluateAll(buttons => buttons.map(button => {
          const rect = button.getBoundingClientRect()
          const style = getComputedStyle(button)
          return { className: button.className, height: rect.height, left: rect.left, right: rect.right,
            padding: parseFloat(style.paddingLeft), background: style.backgroundColor, color: style.color }
        }))
        assert.equal(metrics.length, 3)
        for (const button of metrics) {
          assert.ok(button.height >= 28 && button.padding >= 10, JSON.stringify({ width, native, locale, button }))
          assert.ok(button.left >= 0 && button.right <= width, 'dock action outside viewport')
          assert.equal(button.className.includes('ptcPlusButton'), !native)
        }
        assert.notEqual(metrics[2].background, 'rgba(0, 0, 0, 0)', 'primary action has no fill')
        assert.notEqual(metrics[2].background, metrics[2].color, 'primary action text is invisible')
        for (const action of await actions.all()) await assertControlVisual(action,
          { action: true, hover: true, disabled: true, label: `${width}/${theme}/${native}/${locale}/dock action` })
        await assertVisualSurface(page, page.locator('.ptcPlusBindingDock'), 'dock')
        if (native) {
          const reference = await page.getByRole('button', { name: 'Native reference' }).evaluate(button => {
            const style = getComputedStyle(button)
            return { height: button.getBoundingClientRect().height, padding: parseFloat(style.paddingLeft) }
          })
          assert.equal(metrics[2].height, reference.height)
          assert.equal(metrics[2].padding, reference.padding)
        }
        await actions.last().focus()
        await page.keyboard.press('Enter')
        assert.deepEqual(await page.evaluate(() => window.actions), [['save-draft', true]])
        assert.equal(await page.getByRole('button', { name: 'Disabled action' }).isDisabled(), true)
        await page.evaluate(() => window.setBusy(true))
        await page.waitForFunction(() => document.querySelector('.ptcPlusBindingDock').getAttribute('aria-busy') === 'true')
        for (const action of await actions.all()) {
          assert.equal(await action.isDisabled(), true, 'busy dock action remains enabled')
          await assertControlVisual(action, { action: true, label: 'busy dock action' })
        }
        assert.deepEqual(await page.evaluate(() => window.actions), [['save-draft', true]], 'visual probes dispatched an action')
        await page.evaluate(() => window.setBusy(false))
        await page.waitForFunction(() => !document.querySelector('.ptcPlusBindingDockActions button').disabled)
        const tool = page.locator('.ptcPlusTool')
        const following = page.locator('#following-message')
        for (const example of ['none', 'short', 'long', 'empty', 'features-only', 'rewrites']) {
          await page.evaluate(example => window.setToolExample(example), example)
          await page.waitForFunction(example => {
            const count=document.querySelectorAll('.ptcPlusFeature').length;
            return count===(example==='none'||example==='empty'?0:example==='long'?3:2);
          }, example)
          await assertToolLayout(tool, `${theme}/${native ? 'native' : 'fallback'}/${locale}/${example}`, following)
          await assertToolTypography(tool, `${theme}/${native ? 'native' : 'fallback'}/${locale}/${example}`)
        }
        await assertToolTypography(tool, `${theme}/${native ? 'native' : 'fallback'}/${locale}`)
        if (width === 320 && theme === 'light' && locale === 'en') {
          for (const [css, failure] of native ? [
            ['.ptcPlusTool .ptcPlusToolRow{height:24px!important;align-items:center!important}', /text is clipped|preview escapes/],
            ['.ptcPlusToolPreview{gap:0!important}', /readable vertical gap/],
            ['.ptcPlusTool{display:none!important}', /not rendered/],
          ] : [
            ['.ptcPlusTool{height:24px!important;overflow:hidden!important}', /text is clipped/],
            ['.ptcPlusToolSummary+.ptcPlusFeatures{margin-top:0!important}', /readable vertical gap/],
            ['.ptcPlusTool{display:none!important}', /not rendered/],
          ]) {
            const sheet = await page.addStyleTag({ content: css })
            try {
              await assert.rejects(() => assertToolLayout(tool, 'tool layout counterexample', following), failure)
            } finally {
              await sheet.evaluate(element => element.remove())
            }
          }
          await assertToolLayout(tool, 'restored tool layout', following)
        }
        for (const state of ['running', 'error', 'stopped', 'ok']) {
          await page.evaluate(state => window.setToolState(state), state)
          await page.waitForFunction(state => document.querySelector('.ptcPlusToolSummaryLine,.ptcPlusToolSummary')?.dataset.state === state, state)
          await assertToolTypography(tool, `${theme}/${native ? 'native' : 'fallback'}/${state}`)
          await assertToolLayout(tool, `${theme}/${native ? 'native' : 'fallback'}/${state}`, following)
          await assertToolStateVisual(tool, `${theme}/${native ? 'native' : 'fallback'}/${state}`)
          if (state === 'error' && width === 320 && locale === 'en') {
            const sheet = await page.addStyleTag({ content: '.ptcPlusToolState{color:#010101!important;background:#010101!important}' })
            try {
              await assert.rejects(() => assertToolStateVisual(tool), /unreadable tool state/)
            } finally {
              await sheet.evaluate(element => element.remove())
            }
          }
        }
        const disclosure = tool.locator(native ? '[data-disclosure-row]' : '.ptcPlusToolSummary')
        await assertControlVisual(disclosure, { label: 'tool disclosure' })
        await disclosure.focus()
        await page.keyboard.press('Enter')
        await tool.locator('.ptcPlusToolBody').waitFor()
        await assertToolTypography(tool, `${theme}/${native ? 'native' : 'fallback'}/expanded`)
        await assertToolLayout(tool, `${theme}/${native ? 'native' : 'fallback'}/expanded`, following)
        const inspect = tool.locator('.ptcPlusInspect')
        await page.keyboard.press('Tab')
        await inspect.focus()
        await page.waitForTimeout(180)
        assert.equal(await inspect.evaluate(element => getComputedStyle(element).opacity), '1', 'inspection action remains invisible on focus')
        await inspect.press('Enter')
        assert.deepEqual(await page.evaluate(() => window.actions), [['save-draft', true], ['inspect']])
        if (!native && width === 320 && locale === 'en') await assertVisualCounterexamples(page, actions.last())
        await page.screenshot({ path: `artifacts/button-styles/${width}-${theme}-${native ? 'native' : 'fallback'}-${locale}.png`, fullPage: true })
      }
    }
  }
  for (const { viewport, theme } of [{ width: 390, height: 600 }, { width: 320, height: 420 }]
    .flatMap(viewport => ['light', 'dark'].map(theme => ({ viewport, theme })))) {
    await page.goto('about:blank')
    await page.setViewportSize(viewport)
    await page.setContent(`<button id="background" style="position:fixed;top:10px;left:10px">Host control</button>
      <div id="composer" style="position:fixed;bottom:16px;left:16px;width:calc(100vw - 32px);height:60px;overflow:hidden;transform:translateZ(0)"></div>`)
    await setFixtureTheme(page, theme)
    await page.addScriptTag({ content: fixture.outputFiles[0].text })
    const trigger = page.locator('.ptcPlusAuthorButton')
    await trigger.click()
    const menu = page.locator('.ptcPlusFallbackMenuList')
    await menu.waitFor()
    assert.equal(await menu.evaluate(element => element.parentElement === document.body), true)
    await menu.getByRole('menuitem').first().focus()
    await page.keyboard.press('End')
    assert.equal(await menu.getByRole('menuitem', { name: 'settings.menuEntry', exact: true }).evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element === document.activeElement && rect.top >= 0 && rect.bottom <= innerHeight
        && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), true, 'keyboard navigation leaves the focused action clipped')
    for (const action of ['bindings.manage', 'settings.menuEntry']) {
      const button = menu.getByRole('menuitem', { name: action, exact: true })
      await button.scrollIntoViewIfNeeded()
      assert.equal(await button.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= innerHeight
          && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      }), true, `${viewport.width}x${viewport.height}: ${action} is not reachable`)
    }
    await menu.getByRole('menuitem', { name: 'bindings.manage', exact: true }).click()
    const dialog = page.locator('.ptcPlusBindingsModal')
    await dialog.waitFor()
    await page.evaluate(() => { window.deferCatalog = true })
    await dialog.getByRole('button', { name: 'bindings.reload', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.ptcPlusBindings')?.getAttribute('aria-busy') === 'true')
    for (const control of await dialog.locator('button:disabled').all()) {
      await assertControlVisual(control, { label: 'busy workbench control' })
    }
    await page.evaluate(() => { window.settleCatalog(); window.deferCatalog = false })
    await page.waitForFunction(() => document.querySelector('.ptcPlusBindings')?.getAttribute('aria-busy') === 'false')
    assert.equal(await dialog.evaluate(element => element.parentElement.parentElement === document.body), true)
    assert.equal(await page.locator('#background').evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), false, 'headless modal leaves the background clickable')
    await dialog.locator('.ptcPlusBindingSelect').first().click()
    await assertContentCounterexamples(page, { selected: dialog.locator('.ptcPlusBindingItem[data-selected=true] .ptcPlusBindingSelect') })
    await dialog.locator('.ptcPlusSourceActions button').click()
    await dialog.locator('.ptcPlusEntrySettings summary').click()
    const purpose = dialog.getByLabel('bindings.purpose', { exact: true })
    await purpose.fill('Unsaved purpose')
    await assertContentCounterexamples(page, { input: purpose })
    await purpose.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true, keyCode: 229 }))
    })
    assert.equal(await dialog.isVisible(), true, 'composition cancellation closed the draft')
    assert.equal(await purpose.inputValue(), 'Unsaved purpose')
    await purpose.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))
    })
    assert.equal(await dialog.isVisible(), true, 'composition-closing Escape discarded the draft')
    assert.equal(await purpose.inputValue(), 'Unsaved purpose')
    await purpose.evaluate(element => element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })))
    const close = dialog.getByRole('button', { name: 'bindings.close', exact: true })
    await close.click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
    await trigger.click()
    await menu.getByRole('menuitem', { name: 'settings.menuEntry', exact: true }).click()
    const settings = page.locator('.ptcPlusSettingsModal')
    await settings.waitFor()
    await settings.getByRole('button', { name: 'bindings.manage', exact: true }).click()
    await dialog.waitFor()
    await page.keyboard.down('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await settings.isVisible(), true)
    await page.keyboard.down('Escape')
    assert.equal(await settings.isVisible(), true, 'held Escape dismissed the outer layer')
    await page.keyboard.up('Escape')
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await page.evaluate(() => window.setAttention())
    const badge = page.locator('.ptcPlusDraftBadge[data-attention=true]')
    await badge.waitFor()
    assert.ok((await controlAppearance(badge)).minContrast >= 3, 'attention badge unreadable')
    await page.evaluate(() => window.disposeFixture())
  }
  await page.goto('about:blank')
  await page.setContent('<div id="composer" style="position:fixed;bottom:16px;left:16px;height:60px"></div>')
  await page.evaluate(() => { window.deferCatalog = true })
  await page.addScriptTag({ content: fixture.outputFiles[0].text })
  await page.locator('.ptcPlusAuthorButton').hover()
  const hoverMenu = page.locator('.ptcPlusFallbackMenuList')
  await hoverMenu.waitFor()
  await hoverMenu.hover()
  await page.mouse.move(319, 0)
  await page.waitForTimeout(50)
  await page.evaluate(() => window.settleCatalog())
  await hoverMenu.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.disposeFixture())
  process.stdout.write('Client: native/fallback dock button styles and save actions, viewport keyboard/pointer actions, composition draft, hover settlement, modal mask and focus return passed\n')
} finally {
  await browser.close()
}
