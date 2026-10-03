import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { parseArgs } from 'node:util'
import { assertSparkleMenuTypography, assertSparkleMenuFocus, assertSparkleMenuLayout, assertDraftReviewLayout, assertContentCounterexamples, assertControlVisual, assertToolLayout, assertToolStateVisual, assertToolTypography, assertVisualCounterexamples, assertVisualSurface, controlAppearance, setFixtureTheme } from './client-visual-contract.mjs'
import { SETTINGS_COPY } from '../src/client-copy.js'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' }, 'menu-only': { type: 'boolean', default: false } } })

const clientBundle = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const clientCss = clientBundle.match(/var CLIENT_CSS = `([\s\S]*?)`;/)?.[1]
assert.ok(clientCss, 'generated client bundle does not publish CLIENT_CSS')

const fixture = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'fallback-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {createPortal} from 'react-dom';
    import {Menu as NativeMenu} from '@deepseek-ai/dsh-client-ui-primitives';
    import {createActionButton,resolvePrimitives} from './src/client-primitives.js';
    import {installStyles} from './src/client-styles.js';
    import {createCatalogOwner} from './src/client-catalog.js';
    import {createMenuChildrenEvidence} from './src/client-host-compat.js';
    import {createAuthoringView} from './src/client-authoring-view.js';
    import {createUserBindingsWorkbench} from './src/client-workbench.js';
    import {createPtcSettingsView} from './src/client-settings-view.js';
    import {SETTINGS_COPY} from './src/client-copy.js';
    const h=React.createElement;
    installStyles();
    const {Menu,Modal}=resolvePrimitives(window.nativeMenu?{Menu:NativeMenu}:{},React,createPortal);
    let entries=Array.from({length:window.largeMenu?48:8},(_,index)=>({id:'entry-'+index,name:'Entry '+index,
      scope:'namespace',symbols:['value'],purpose:'Stored input',source:'export const value=1',enabled:!window.largeMenu||index%3===0}));
    if(window.largeMenu)entries[0]={...entries[0],name:'Entry 0 '+('long binding name '.repeat(20)),
      purpose:'A long stored computation input description '+('for continuous work '.repeat(20))};
    if(window.singleDisabled)entries=[{...entries[0],name:'escapes',enabled:false,
      purpose:'Generate correctly escaped literals and text for JS/TS, JSON and other output formats.'}];
    let settleCatalog;
    const catalogPending=new Promise(resolve=>{settleCatalog=resolve});
    let revision=1;
    const callUserBindings=async (endpoint,payload)=>{
      if(endpoint==='load')return {revision,entry:entries.find(entry=>entry.id===payload.id)};
      if(endpoint==='enable'||endpoint==='disable'){
        if(payload.expectedRevision!==revision)throw new Error('Revision mismatch');
        if(window.holdMenuWrite)await new Promise(resolve=>{window.settleMenuWrite=resolve});
        entries=entries.map(entry=>entry.id===payload.id?{...entry,enabled:endpoint==='enable'}:entry);
        revision++;
      }
      return window.deferCatalog?catalogPending:{revision,entries};
    };
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
    const t=(key,args={})=>window.menuLocale?Object.entries(args).reduce((text,[name,value])=>
      text.replaceAll('{'+name+'}',String(value)),SETTINGS_COPY[window.menuLocale][key]??key):key;
    const render=()=>root.render(h(BindingAuthorButton,{sessionId:'fallback-session',t,
      useInput:select=>select({draft:''}),inputActions:{setDraft:()=>{}},
      usePtcSettings:select=>select({status:'ready',writable:true,value:{enabled:true}}),useBindingCommand:()=>true}));
    window.setAttention=()=>{view.mounted=true;view.candidate={entry:{name:'Attention'}};view.message='Attention';render()};
    render();
    window.disposeFixture=()=>{root.unmount();catalogOwner.dispose()};
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'menu-fixture.js',
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { __PTC_PLUS_CLIENT_MODULE_ID__: JSON.stringify('dsh-ptc-plus'), 'process.env.NODE_ENV': JSON.stringify('production') },
})
const buttonFixture = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'button-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {Button,DisclosureRow,Modal as NativeModal} from '@deepseek-ai/dsh-client-ui-primitives';
    import {createPortal} from 'react-dom';
    import {createActionButton,resolvePrimitives} from './src/client-primitives.js';
    import {createAuthoringView} from './src/client-authoring-view.js';
    import {installStyles} from './src/client-styles.js';
    import {SETTINGS_COPY} from './src/client-copy.js';
    import {createPtcToolView} from './src/client-tool-view.js';
    const h=React.createElement;
    installStyles();
    const ActionButton=createActionButton(React,window.nativeButtons?Button:undefined);
    const candidate={requestId:'probe-request',commandId:'probe-command',version:1,mode:'new',
      entry:{id:'probe',name:'Inputs',scope:'namespace',purpose:'Input data',enabled:false,symbols:['value'],
      source:'export const value = 42',modelContext:{includeDeclaration:true,instructions:''}}};
    const projection={phase:'ready',commandId:candidate.commandId,capability:'probe-capability',history:[{commandId:candidate.commandId,acceptedSeq:4,candidate,action:null}]};
    const view={mounted:true,candidate,candidateKey:'probe',visibility:'expanded',reachable:true,action:null,message:null,writable:true,busy:false};
    window.actions=[];
    const review={attach:()=>()=>{},sync:()=>{},getSnapshot:()=>view,isCurrentCandidate:value=>value===candidate,reset:()=>{},act:(...args)=>window.actions.push(args),
      display:visibility=>{view.visibility=visibility;render();return true}};
    const {Modal}=resolvePrimitives(window.nativeButtons?{Modal:NativeModal}:{},React,createPortal);
    const Icon=()=>null;
    const IconButton=({icon:Icon,label,...props})=>h('button',{type:'button',className:'ptcPlusIconButton','aria-label':label,...props},h(Icon,{size:16}));
    const {BindingReviewDock,BindingCommandCard}=createAuthoringView(React,{ActionButton,IconButton,Modal,createPortal,
      useBindingReview:()=>[review,view],icons:{check:Icon,chevron:Icon}});
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
      h('div',{id:'draft-seat'},h(BindingReviewDock,{sessionId:'probe',useProjection:()=>projection,t:key=>SETTINGS_COPY[window.buttonLocale][key]??key})),
      h('div',{id:'controls'},
        h('div',{ref:element=>{review.access=element}},h(Button,{size:'sm',variant:'primary'},'Native reference')),
        h(ActionButton,{disabled:true},'Disabled action')),
      h(PTCPlusToolRow,{toolName:'run_code',block,inspect:()=>window.actions.push(['inspect']),
        t:key=>SETTINGS_COPY[window.buttonLocale][key]??key}),
      h('div',{id:'following-message'},'Let me do it. Also cleanup probe file later.'),
      h('div',{id:'draft-entry'},h(BindingCommandCard,{sessionId:'probe',node:{commandId:candidate.commandId,args:' new Inputs',outcome:null},
        useProjection:()=>projection,t:key=>SETTINGS_COPY[window.buttonLocale][key]??key})),
      h('div',{id:'native-neighbor'},h(Button,{size:'sm',variant:'primary'},'Neighbor action'))));
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
    window.setReviewError=message=>{view.message=message;render()};
    window.setReviewSource=source=>{candidate.entry.source=source;render()};
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
  if (!values['menu-only']) for (const { width, theme } of [320, 390, 1440].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme })))) {
    for (const native of [true, false]) {
      for (const locale of ['en', 'zh']) {
        await page.goto('about:blank')
        await page.setViewportSize({ width, height: 900 })
        await page.setContent(`<style>
          :root{--dsw-radius-sm:6px}
          body{margin:0;font:14px system-ui}button{font:inherit;background:none;border:0;padding:0}
          #draft-seat{position:fixed;bottom:32px;inset-inline:8px}#root{padding:8px}#controls{display:flex;gap:8px;margin-top:16px}
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
        const draft = page.locator('.ptcPlusBindingDock')
        await assertDraftReviewLayout(draft, 'floating draft')
        const beforeEnlarge = await page.locator('#controls').boundingBox()
        await page.getByRole('button', { name: locale === 'zh' ? '放大查看绑定草稿' : 'Enlarge binding draft', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        await assertDraftReviewLayout(draft, 'enlarged draft', true)
        await assertVisualSurface(page, dialog, 'enlarged draft')
        if (width === 1440 && theme === 'light' && locale === 'en') {
          for (const [rule, error] of [
            ['.ptcPlusBindingReviewModal{height:200px!important}', /enlarged review is still a preview/],
            ['.ptcPlusBindingDockBody{overflow:hidden!important}', /no scrollable reading area/],
            ['.ptcPlusBindingDockActions{transform:translateY(300px)}', /covered or clipped/],
            ['.ptcPlusBindingDockControls{gap:0!important}', /resize and close controls are too close/],
          ]) {
            const fault = await page.addStyleTag({ content: rule })
            try { await assert.rejects(() => assertDraftReviewLayout(draft, 'damaged enlarged review', true), error) }
            finally { await fault.evaluate(element => element.remove()) }
          }
          await assertDraftReviewLayout(draft, 'restored enlarged review', true)
        }
        assert.deepEqual(await page.locator('#controls').boundingBox(), beforeEnlarge, 'Enlarging displaced adjacent content')
        await actions.last().focus()
        await page.keyboard.press('Tab')
        assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab escaped review')
        await page.screenshot({path: `artifacts/button-styles/draft-enlarged-${width}-${theme}-${native}-${locale}.png`})
        await dialog.getByRole('button', { name: SETTINGS_COPY[locale]['bindings.reviewRestore'], exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        await page.waitForFunction(() => document.querySelector('.ptcPlusBindingDock')?.contains(document.activeElement))
        assert.equal(await draft.evaluate(element => element.contains(document.activeElement)), true, 'Close lost preview focus')
        assert.deepEqual(await page.evaluate(() => window.actions), [['save-draft', true]], 'Display dispatched an action')
        await page.getByRole('button', { name: SETTINGS_COPY[locale]['bindings.reviewEnlarge'], exact: true }).click()
        await dialog.waitFor()
        await dialog.getByRole('button', { name: SETTINGS_COPY[locale]['bindings.reviewClose'], exact: true }).click()
        await draft.waitFor({ state: 'detached' })
        await page.getByRole('button', { name: SETTINGS_COPY[locale]['bindings.reviewOpen'], exact: true }).click()
        await dialog.waitFor()
        await dialog.getByRole('button', { name: SETTINGS_COPY[locale]['bindings.reviewRestore'], exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        assert.deepEqual(await page.evaluate(() => window.actions), [['save-draft', true]], 'Resize/close changed draft actions')
        if (width === 320 && theme === 'light') {
          await page.evaluate(() => window.setReviewSource(Array.from({length:160},(_,index)=>'export const value'+index+' = '+index).join('\\n')))
          for (const height of [320, 400, 240, 425, 332]) {
            await page.setViewportSize({ width, height })
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            const previewMetrics = await assertDraftReviewLayout(draft, 'short preview')
            if (height === 240 || height === 320) assert.equal(previewMetrics.compact, true, 'short preview did not compact')
            assert.equal(await actions.last().isVisible(), !previewMetrics.compact, 'compact action visibility differs')
            assert.equal(await draft.locator('.ptcPlusBindingDockBody').getAttribute('inert'), previewMetrics.compact ? '' : null)
            await page.getByRole('button', { name: locale === 'zh' ? '放大查看绑定草稿' : 'Enlarge binding draft', exact: true }).click()
            await dialog.waitFor()
            await assertDraftReviewLayout(draft, 'short enlarged review', true)
            for (const message of [null, 'RPC failure: ' + 'long provider detail '.repeat(100)]) {
              await page.evaluate(message => window.setReviewError(message), message)
              if (message) await draft.locator('[role=status].ptcPlusDanger').waitFor()
              else await draft.locator('[role=status].ptcPlusDanger').waitFor({state:'detached'})
              await assertDraftReviewLayout(draft, 'short enlarged error review', true)
              const before = await draft.locator('.ptcPlusBindingDockActions').boundingBox()
              await draft.locator('.ptcPlusBindingDockBody').evaluate(element => { element.scrollTop = element.scrollHeight })
              assert.deepEqual(await draft.locator('.ptcPlusBindingDockActions').boundingBox(), before, 'source scroll moved actions')
              assert.equal(await draft.locator('.ptcPlusBindingDockBody').evaluate(element => element.scrollHeight > element.clientHeight), true)
            }
            await page.screenshot({path: 'artifacts/button-styles/draft-short-'+height+'-'+native+'-'+locale+'.png'})
            await page.keyboard.press('Escape')
            await dialog.waitFor({state:'detached'})
          }
          await page.evaluate(() => window.setReviewError(null))
          await page.setViewportSize({ width, height: 900 })
          await page.locator('.ptcPlusBindingDock[data-compact=false]').waitFor()
          await assertDraftReviewLayout(draft, 'restored tall preview')
          await page.setViewportSize({ width: 640, height: 480 })
          for (const top of [70, 80]) {
            await page.locator('#draft-seat').evaluate((element, top) => { element.style.top = top+'px'; element.style.bottom = 'auto' }, top)
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            await assertDraftReviewLayout(draft, 'compact full header budget')
            const placement = await draft.evaluate(element => ({ bottom: element.getBoundingClientRect().bottom,
              anchor: document.querySelector('.ptcPlusBindingDockAnchor').getBoundingClientRect().top }))
            assert.ok(placement.bottom <= placement.anchor, 'compact preview covers its dock')
          }
          for (const top of [40, 50]) {
            await page.locator('#draft-seat').evaluate((element, top) => { element.style.top = top+'px' }, top)
            await page.locator('#native-neighbor').evaluate((element, top) => {
              element.style.cssText = 'position:fixed;left:40px;top:'+(top+6)+'px;z-index:1'
            }, top)
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            await page.locator('.ptcPlusBindingPreviewLayer[data-available=false]').waitFor({state:'attached'})
            assert.equal(await draft.isVisible(), false, 'unfittable preview is still painted')
            assert.equal(await page.locator('.ptcPlusBindingPreviewLayer').getAttribute('inert'), '')
            await assertControlVisual(page.getByRole('button',{name:'Neighbor action'}), {action:true,label:'neighbor below unfittable preview'})
            await page.getByRole('button',{name:locale === 'zh' ? '打开草稿' : 'Open draft',exact:true}).click()
            await dialog.waitFor()
            await assertDraftReviewLayout(draft, 'manual enlarged unavailable preview', true)
            await page.keyboard.press('Escape')
            await dialog.waitFor({state:'detached'})
            await page.waitForFunction(() => document.activeElement?.textContent === 'Native reference')
          }
          await page.locator('#native-neighbor').evaluate(element => { element.style.cssText = '' })
          await page.locator('#draft-seat').evaluate(element => { element.style.top = ''; element.style.bottom = '' })
          await page.setViewportSize({ width, height: 900 })
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          await assertDraftReviewLayout(draft, 'restored anchor')

        }
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
  for (const native of [true, false]) for (const locale of ['en', 'zh']) for (const theme of ['light', 'dark']) {
    await page.goto('about:blank')
    await page.setViewportSize({ width: 390, height: 600 })
    await page.setContent('<style>body{font:24px/36px system-ui}</style><div id="composer" style="position:fixed;bottom:16px;left:16px"></div>')
    await page.evaluate(({ native, locale }) => {
      window.nativeMenu = native; window.menuLocale = locale; window.singleDisabled = true
    }, { native, locale })
    for (const output of fixture.outputFiles) {
      if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
      else await page.addScriptTag({ content: output.text })
    }
    await setFixtureTheme(page, theme)
    await page.locator('.ptcPlusAuthorButton').click()
    const menu = page.getByRole('menu')
    const group = menu.locator('[aria-expanded]')
    await group.waitFor()
    await group.press('Enter')
    await menu.locator('[data-binding-id]').waitFor()
    const label = `single-disabled/${native ? 'native' : 'fallback'}/${locale}/${theme}`
    await assertSparkleMenuTypography(menu, label)
    await assertSparkleMenuLayout(menu, label)
    const stretchedCaption = await page.addStyleTag({ content: '.ptcPlusOwnedMenuRow{align-items:stretch!important}' })
    try {
      await assert.rejects(() => assertSparkleMenuTypography(menu, `${label}/stretched caption`), /caret and caption are misaligned/)
    } finally {
      await stretchedCaption.evaluate(element => element.remove())
    }
    await assertSparkleMenuTypography(menu, `${label}/centered caption`)
    assert.equal(await menu.locator('.ptcPlusBindingQuickPurpose').getAttribute('title'),
      'Generate correctly escaped literals and text for JS/TS, JSON and other output formats.')
    for (const [property, error] of [['font-size', /menu base font size drifted/], ['line-height', /menu base line height drifted/]]) {
      const fault = await page.addStyleTag({ content: `.ptcPlusBindingMenuContent{${property}:inherit!important}` })
      try {
        await assert.rejects(() => assertSparkleMenuTypography(menu, `${label}/${property} fault`), error)
      } finally {
        await fault.evaluate(element => element.remove())
      }
      await assertSparkleMenuTypography(menu, `${label}/restored`)
    }
    // Smaller carrier typography is also legal; only the plugin menu owns its scale.
    await page.evaluate(() => { document.body.style.font = '14px/21px system-ui' })
    await assertSparkleMenuTypography(menu, `${label}/smaller carrier`)
    await page.screenshot({ path: `artifacts/button-styles/sparkle-single-disabled-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.disposeFixture())
  }
  for (const viewport of [{ width: 390, height: 600 }, { width: 320, height: 420 }, { width: 320, height: 240 }]) {
    for (const native of [true, false]) for (const locale of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      await page.goto('about:blank')
      await page.setViewportSize(viewport)
      await page.setContent('<div id="composer" style="position:fixed;bottom:16px;left:16px;width:calc(100vw - 32px);height:60px"></div>')
      await page.evaluate(({ native, locale }) => { window.nativeMenu = native; window.menuLocale = locale; window.largeMenu = true }, { native, locale })
      for (const output of fixture.outputFiles) {
        if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
        else await page.addScriptTag({ content: output.text })
      }
      await setFixtureTheme(page, theme)
      const trigger = page.locator('.ptcPlusAuthorButton')
      await trigger.click()
      const menu = page.getByRole('menu')
      await menu.locator('[data-binding-id]').first().waitFor()
      const groupName = SETTINGS_COPY[locale]['bindings.quickDisabled'].replace('{count}', '32')
      const group = menu.getByRole('menuitem', { name: groupName, exact: true })
      assert.equal(await group.getAttribute('aria-expanded'), 'false')
      assert.equal(await menu.locator('[data-binding-id]').count(), 16)
      const label = `${viewport.width}x${viewport.height}/${native ? 'native' : 'fallback'}/${locale}/${theme}`
      const initial = await assertSparkleMenuLayout(menu, label)
      await assertSparkleMenuTypography(menu, label)
      assert.equal(initial.scrollable, true, `${label}: large catalog does not scroll`)
      await group.press('Enter')
      assert.equal(await group.getAttribute('aria-expanded'), 'true')
      assert.equal(await menu.locator('[data-binding-id]').count(), 48)
      for (const end of [true, false]) {
        await menu.locator('.ptcPlusBindingMenuScroll').evaluate((scroll, end) => { scroll.scrollTop = end ? scroll.scrollHeight : 0 }, end)
        const current = await assertSparkleMenuLayout(menu, `${label}/${end ? 'end' : 'start'}`)
        assert.deepEqual(current.footer, initial.footer, `${label}: catalog scrolling moved the footer`)
      }
      if (viewport.height === 600 && locale === 'en' && theme === 'light') {
        const fault = await page.addStyleTag({ content: '.ptcPlusBindingMenuContent{display:block!important;overflow:auto!important}.ptcPlusBindingMenuScroll{overflow:visible!important}' })
        try {
          await assert.rejects(() => assertSparkleMenuLayout(menu, `${label}/shared scrolling fault`), /catalog overlaps footer|footer outside menu|action is clipped or covered/)
        } finally {
          await fault.evaluate(element => element.remove())
        }
        await assertSparkleMenuLayout(menu, `${label}/restored`)
      }
      await page.screenshot({ path: `artifacts/button-styles/sparkle-menu-${viewport.width}-${viewport.height}-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
      const edit = menu.getByRole('menuitem', { name: SETTINGS_COPY[locale]['bindings.authorEdit'], exact: true })
      await edit.click()
      const back = menu.getByRole('menuitem', { name: SETTINGS_COPY[locale]['bindings.back'], exact: true })
      await back.waitFor()
      const editing = await assertSparkleMenuLayout(menu, `${label}/edit`)
      await assertSparkleMenuTypography(menu, `${label}/edit`)
      await menu.locator('.ptcPlusBindingMenuScroll').evaluate(scroll => { scroll.scrollTop = scroll.scrollHeight })
      assert.deepEqual((await assertSparkleMenuLayout(menu, `${label}/edit end`)).footer, editing.footer)
      await back.click()
      await group.waitFor()
      await assertSparkleMenuFocus(menu, `${label}/back focus`)
      await group.press('Enter')
      assert.equal(await group.getAttribute('aria-expanded'), 'false')
      await menu.locator('.ptcPlusBindingMenuScroll').evaluate(scroll => { scroll.scrollTop = 0 })
      await menu.locator('[data-binding-id="entry-0"]').click()
      await page.waitForFunction(() => document.querySelectorAll('[data-binding-id]').length === 15)
      await assertSparkleMenuFocus(menu, `${label}/disable collapsed`)
      assert.deepEqual((await assertSparkleMenuLayout(menu, `${label}/regrouped`)).footer, initial.footer)
      const focusScroll = await menu.locator('.ptcPlusBindingMenuScroll').evaluate(scroll => scroll.scrollTop)
      assert.ok(focusScroll > 0)
      await menu.locator('.ptcPlusBindingMenuScroll').evaluate(scroll => { scroll.scrollTop = 0 })
      await assert.rejects(() => assertSparkleMenuFocus(menu, `${label}/missing reveal fault`), /focused catalog control is clipped or covered/)
      await menu.locator('.ptcPlusBindingMenuScroll').evaluate((scroll, top) => { scroll.scrollTop = top }, focusScroll)
      await assertSparkleMenuFocus(menu, `${label}/restored reveal`)
      const changedGroup = menu.locator('[aria-expanded]')
      await changedGroup.press('Enter')
      await menu.locator('[data-binding-id="entry-47"]').click()
      await page.waitForFunction(() => document.activeElement?.dataset.bindingId === 'entry-47'
        && document.activeElement.querySelector('[data-enabled=true]'))
      const enabledFocus = await assertSparkleMenuFocus(menu, `${label}/enable expanded`)
      assert.deepEqual(enabledFocus.pageScroll, { x: 0, y: 0 })
      assert.deepEqual((await assertSparkleMenuLayout(menu, `${label}/enable expanded`)).footer, initial.footer)
      if (viewport.height === 600 && locale === 'en' && theme === 'light') {
        await menu.locator('[data-binding-id="entry-0"]').click()
        await page.waitForFunction(() => document.activeElement?.dataset.bindingId === 'entry-0'
          && document.activeElement.querySelector('[data-enabled=true]'))
        await page.evaluate(() => { window.holdMenuWrite = true })
        await menu.locator('[data-binding-id="entry-0"]').click()
        await page.waitForFunction(() => typeof window.settleMenuWrite === 'function')
        await page.keyboard.press('Escape')
        await trigger.click()
        await page.waitForFunction(() => document.activeElement?.dataset.bindingId === 'entry-0')
        await page.evaluate(() => { window.holdMenuWrite = false; window.settleMenuWrite() })
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-expanded') === 'false')
        await assertSparkleMenuFocus(menu, `${label}/pending reopen focus`)
        assert.deepEqual((await assertSparkleMenuLayout(menu, `${label}/pending reopen footer`)).footer, initial.footer)
      }
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      assert.equal(await trigger.evaluate(button => button === document.activeElement), true)
      await page.evaluate(() => window.disposeFixture())
    }
  }
  if (!values['menu-only']) {
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
  }
  process.stdout.write(values['menu-only']
    ? 'Client: native/fallback sparkle menu pinned actions, grouped catalog and keyboard return passed\n'
    : 'Client: native/fallback dock button styles and save actions, pinned sparkle menu groups, viewport keyboard/pointer actions, composition draft, hover settlement, modal mask and focus return passed\n')
} finally {
  await browser.close()
}
