import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Screenshots are diagnostic output; the old absolute G:\Temp paths broke CI.
const screenshotDir = join(tmpdir(), 'dsh-ptc-plus-visual')
await mkdir(screenshotDir, { recursive: true })
import { build } from 'esbuild'
import { browserConcurrency, runBrowserCases, selectBrowserCases } from './browser-case-runner.mjs'
import { parseArgs } from 'node:util'
import { assertSparkleMenuTypography, assertSparkleMenuFocus, assertSparkleMenuLayout, assertDraftReviewLayout, assertContentCounterexamples, assertControlVisual, assertToolLayout, assertToolStateVisual, assertToolTypography, assertVisualCounterexamples, assertVisualSurface, controlAppearance, settleVisual, setFixtureTheme } from './client-visual-contract.mjs'
import { SETTINGS_COPY } from '../src/client-copy.js'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' }, 'menu-only': { type: 'boolean', default: false }, concurrency: { type: 'string' }, case: { type: 'string', multiple: true }, list: { type: 'boolean' }, focus: { type: 'boolean' } } })

const variants = [true, false].flatMap(native => ['en', 'zh'].flatMap(locale =>
  ['light', 'dark'].map(theme => ({ native, locale, theme }))))
const allCases = [
  ...[320, 390, 1440].flatMap(width => variants.map(item => ({ family: 'dock', width, ...item }))),
  ...variants.map(item => ({ family: 'single-disabled', ...item })),
  ...[{ width: 390, height: 600 }, { width: 320, height: 420 }, { width: 320, height: 240 }]
    .flatMap(viewport => variants.map(item => ({ family: 'catalog', viewport, ...item }))),
  ...[{ width: 390, height: 600 }, { width: 768, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 320, height: 420 }, { width: 320, height: 240 }]
    .flatMap(viewport => variants.map(item => ({ family: 'session-capabilities', viewport, ...item }))),
  ...[{ width: 390, height: 600 }, { width: 320, height: 420 }]
    .flatMap(viewport => ['light', 'dark'].map(theme => ({ family: 'dialogs', viewport, theme }))),
  ...[{ width: 390, height: 600 }, { width: 320, height: 420 }]
    .flatMap(viewport => ['light', 'dark'].map(theme => ({ family: 'dialogs', viewport, theme, native: true }))),
  ...[240, 420, 600].flatMap(height => variants.map(item => ({ family: 'settings-dialog', viewport: { width: 1440, height }, ...item }))),
  ...[320, 390].flatMap(width => variants.filter(item => item.native).map(item => ({ family: 'settings-dialog', viewport: { width, height: 240 }, ...item }))),
  ...[320, 390, 1440].flatMap(width => ['en', 'zh'].flatMap(locale =>
    ['light', 'dark'].map(theme => ({ family: 'settings-page', width, locale, theme })))),
  ...[320, 1920].flatMap(width => variants.map(item => ({ family: 'capability-workbench', width, ...item }))),
  { family: 'hover-settlement' },
].map(item => ({ ...item, id: [item.family, item.width ?? (item.viewport && `${item.viewport.width}x${item.viewport.height}`),
  item.theme, item.native === undefined ? undefined : item.native ? 'native' : 'fallback', item.locale].filter(Boolean).join('/') }))
const availableCases = values['menu-only'] ? allCases.filter(item => ['single-disabled', 'catalog', 'session-capabilities'].includes(item.family)) : allCases
const cases = selectBrowserCases(availableCases, values.case, values)
const focused = cases.length !== availableCases.length
const concurrency = browserConcurrency(values.concurrency)
if (values.list) {
  console.log(cases.map(item => item.id).join('\n'))
} else {
  const started = performance.now()
  const clientBundle = await readFile(new URL('../client.cjs', import.meta.url), 'utf8')
  const clientCss = clientBundle.match(/var CLIENT_CSS = `([\s\S]*?)`;/)?.[1]
  assert.ok(clientCss, 'generated client bundle does not publish CLIENT_CSS')

  const fixture = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'fallback-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {createPortal} from 'react-dom';
    import {Menu as NativeMenu,Modal as NativeModal} from '@deepseek-ai/dsh-client-ui-primitives';
    import {createActionButton,resolvePrimitives} from './src/client-primitives.js';
    import {installStyles} from './src/client-styles.js';
    import {createCatalogOwner} from './src/client-catalog.js';
    import {createMenuChildrenEvidence} from './src/client-host-compat.js';
    import {createAuthoringView} from './src/client-authoring-view.js';
    import {createUserBindingsWorkbench} from './src/client-workbench.js';
    import {createPtcSettingsView} from './src/client-settings-view.js';
    import {createCapabilityCommandCard,createCapabilityRefreshView,createCapabilitySurfaceView} from './src/client-capabilities-view.js';
    import {capabilityCommandReceipt} from './internal/capability-command-receipt.js';
    import {SETTINGS_COPY} from './src/client-copy.js';
    import {capabilityProfileConfiguration} from './internal/runtime-config.js';
    const h=React.createElement;
    installStyles();
    const {Menu,Modal,Select}=resolvePrimitives({...window.nativeMenu?{Menu:NativeMenu}:{},...window.nativeSettingsModal?{Modal:NativeModal}:{}},React,createPortal);
    window.nativeModalUsed=Modal===NativeModal;
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
      IconButton,ActionButton,Modal,Select,catalogOwner,icons:{refresh:Icon,plus:Icon,close:Icon,search:Icon,chevron:Icon,
        edit:Icon,check:Icon,trash:Icon}});
    window.refreshCalls=[];
    const CapabilityRefreshButton=createCapabilityRefreshView(React,{
      source:()=>({getSnapshot:()=>true,subscribe:()=>()=>{}}),
      run:async(sessionId,input,signal)=>{window.refreshCalls.push({sessionId,input});
        signal.throwIfAborted();return {kind:'success',text:'Host accepted refresh'};}
    });
    window.capabilityWorkbenchCatalog=[
      {id:'tools.read',name:'read',category:'tool',source:{kind:'host'}},
      {id:'tools.edit',name:'edit',category:'tool',source:{kind:'host'}},
      {id:'tools.bash',name:'bash',category:'tool',source:{kind:'host'}},
      {id:'tools.mcp__github__search',name:'search',category:'tool',mcpServer:'github',source:{kind:'mcp',server:'github'}},
      {id:'tools.mcp__'+('a'.repeat(64))+'__search',name:'search',category:'tool',mcpServer:'a'.repeat(64),source:{kind:'mcp',server:'a'.repeat(64)}},
      {id:'skills.rightapi-image-generator',name:'rightapi-image-generator',category:'skill',source:{kind:'skill',bucket:'user-agents',provider:'filesystem'}},
      {id:'skills.documentation-freshness-auditor',name:'documentation-freshness-auditor',category:'skill',source:{kind:'skill',bucket:'project-agents',provider:'filesystem'}},
      {id:'mcp.project-docs',name:'project-docs',category:'resource',mcpServer:'project-docs',source:{kind:'mcp',server:'project-docs'}}];
    window.capabilityEntries=[...Array.from({length:80},(_,index)=>({id:'tools.probe'+index,name:'probe'+index,category:'tool',
      description:'A capability with its own choices.',source:{kind:'host'},saved:'automatic',sessionSourceSelection:'automatic',temporary:'inherit',effective:'on-demand'})),
      {id:'tools.mcp__docs__deep__search',name:'deep search',category:'tool',source:{kind:'mcp',servers:['docs','docs__deep']},saved:'automatic',sessionSourceSelection:'automatic',temporary:'inherit',effective:'on-demand'},
      {id:'skills.design',name:'design',category:'skill',source:{kind:'skill',bucket:'project-dsh'},saved:'automatic',sessionSourceSelection:'automatic',temporary:'inherit',effective:'on-demand'},
      {id:'mcpServers.docs',name:'docs',category:'server',source:{kind:'mcp',server:'docs'},saved:'automatic',sessionSourceSelection:'automatic',temporary:'inherit',effective:'enabled'},
      {id:'tools.mcp__docs__search',name:'docs search',category:'tool',source:{kind:'mcp',server:'docs'},saved:'automatic',sessionSourceSelection:'automatic',temporary:'inherit',effective:'on-demand'}];
    // The v2 session catalogue answers three permanent questions per row: which rows
    // the Host supplies, what this session recorded for each row and whether an
    // execution proved it. The saved and session columns are two decisions; a row
    // states both without either deriving the other.
    window.capabilityRows=window.capabilityEntries.map(entry=>({
      id:entry.id,
      kind:entry.category==='server'?'server':'capability',
      name:entry.name,
      category:entry.category,
      source:entry.source,
      saved:entry.category==='server'?{availability:'closed'}
        :entry.category==='skill'?{availability:'enabled',disclosure:'full'}
          :{availability:'enabled',disclosure:'on-demand'},
      session:entry.category==='server'?{availability:'inherit'}
        :entry.id==='tools.probe5'?{availability:'closed',disclosure:'inherit'}
          :entry.category==='skill'?{availability:'enabled',disclosure:'full'}
            :{availability:'inherit',disclosure:'inherit'},
      // The record's own words and the layer that wrote them: both columns state these
      // words, and the receipt names the layer.
      record:entry.id==='tools.probe5'
        ?{availability:'closed',layers:{availability:null,disclosure:null}}
        :entry.category==='skill'
          ?{availability:'enabled',disclosure:'full',layers:{availability:null,disclosure:null}}
          :{layers:{availability:null,disclosure:null}},
      evidence:entry.id==='tools.probe3'
    }));
    const capabilityChannelState={getSnapshot:()=>true,subscribe:()=>()=>{}};
    const recordCapabilityCommand=async(sessionId,input,signal)=>{
      signal.throwIfAborted();window.sessionCapabilityCalls.push({sessionId,input});
      const [,scope,id,dimension,choice]=input.split(' ');
      const row=window.capabilityRows.find(candidate=>candidate.id===decodeURIComponent(id));
      const column=scope==='session'?'session':'saved';
      if(['automatic','inherit'].includes(choice))delete row[column][dimension];else row[column][dimension]=choice;
      if(column==='session'){
        if(['automatic','inherit'].includes(choice))delete row.record[dimension];
        else row.record[dimension]=choice;
        row.record.layers[dimension]=null;
      }
      // The receipt names the record this command wrote, the way the capabilities
      // command does: the panel footer states that sentence instead of the payload.
      const written={scope,id:decodeURIComponent(id),selection:choice};
      if(dimension)written.dimension=dimension;
      return {kind:'success',text:['session','global'].includes(scope)
        ?capabilityCommandReceipt('recorded',sessionId,undefined,undefined,written)
        :capabilityCommandReceipt('recorded',sessionId)};
    };
    const SessionCapabilityControls=createCapabilitySurfaceView(React,{
      commands:{source:()=>capabilityChannelState,run:recordCapabilityCommand},
      bindingCommands:{source:()=>capabilityChannelState,run:recordCapabilityCommand},
      Modal,Select,
      // One read serves both entrances: the settings dialog states the catalogue the
      // workbench declares, the session panel states the session's own supplied rows.
      inspectSessionCatalog:async(sessionId,signal)=>{
        signal.throwIfAborted();
        if(window.capabilityWorkbench&&window.capabilityWorkbenchCatalog){
          const policy=JSON.parse(window.settingsValue.capabilityPolicy);
          // The saved column states the words this document wrote for that object, and nothing a
          // category, server or bottom layer would answer at runtime.
          const value=entry=>{
            const rule=policy.items?.[entry.id]??{};
            return {availability:rule.availability??'automatic',disclosure:rule.disclosure??'automatic'};
          };
          return {schema:'ptc-capability-session-catalog/v2',sessionId,
            rows:window.capabilityWorkbenchCatalog.map(entry=>({...entry,kind:'capability',
              saved:value(entry),session:{availability:'inherit',disclosure:'inherit'},evidence:false})),
            config:{bindingsEnabled:false}};
        }
        return {schema:'ptc-capability-session-catalog/v2',sessionId,rows:structuredClone(window.capabilityRows),
          config:{bindingsEnabled:false}};
      }
    });
    const CapabilityCommandCard=createCapabilityCommandCard(React);
    window.showCapabilityReceipt=(args='refresh',text=capabilityCommandReceipt('recorded','fallback-session'))=>{
      const composer=document.querySelector('#composer');
      composer.style.cssText='position:relative;width:min(760px,calc(100vw - 32px));height:auto;margin:48px auto';
      root.render(h(CapabilityCommandCard,{node:{name:'capabilities',args,
        outcome:{kind:'success',text}},
        t:(key,args={})=>Object.entries(args).reduce((text,[name,value])=>
          text.replaceAll('{'+name+'}',String(value)),SETTINGS_COPY[window.menuLocale][key]??key)}));
    };
    window.sessionCapabilityCalls=[];
    const {PTCPlusSettingsDialog,PTCPlusSettingsCard}=createPtcSettingsView(React,{ActionButton,
      BindingsDialog:workbench.BindingsDialog,Modal,Select,useWorkbenchController:workbench.useWorkbenchController,
      icons:{chevron:Icon},CapabilityRefreshButton,
      inspectCapabilityTargets:async()=>[{sessionId:'ptc-session'},{sessionId:'other-session'}],
      inspectCapabilityAllocation:async({sessionId,configuration})=>({sessionId,workspace:'G:/Project',configuration,
        plan:{enabled:configuration.capabilityManagementEnabled,budgets:{contractBytes:1200,directoryBytes:400,overageBytes:0},
          entries:[{id:'tools.read',selection:'full',reason:'baseline'},{id:'tools.bash',selection:'full',reason:'statistical-coverage'},
            {id:'tools.edit',selection:'on-demand',reason:'contract-budget'}]},
        capabilities:[{id:'tools.read',contractBytes:320},{id:'tools.bash',contractBytes:640},{id:'tools.edit',contractBytes:280}],
        coverage:{'tools.read':{workspace:{status:'usable',used:14,eligible:20,coverage:.7},global:{status:'usable',used:40,eligible:100,coverage:.4}},
          'tools.bash':{workspace:{status:'usable',used:18,eligible:20,coverage:.9},global:{status:'usable',used:60,eligible:100,coverage:.6}}}}),
      // The settings entrance mounts the one capability surface, so its read is the same
      // session-catalogue read the session entrance makes. The saved column states only the
      // entry this document wrote for the object (policy.items[id], or automatic when it wrote
      // none), and no category, server or bottom layer reaches it (§8.1c).
      CapabilitySurface:SessionCapabilityControls,
      inspectCapabilityPlans:async()=>window.capabilityWorkbench?[{sessionId:'ptc-session',pendingRefresh:true,
        configuration:capabilityProfileConfiguration({capabilityManagementEnabled:true,capabilityBaseline:'["tools.read"]'}),
        effective:{budgets:{contractBytes:1200,overageBytes:0},entries:[{id:'skills.rightapi-image-generator',category:'skill',selection:'on-demand',reason:'baseline-not-selected',statisticsReason:'statistics-disabled'}]}}]:[]});
    const view={mounted:false,reachable:true,candidate:null,candidateKey:null,action:null,message:null};
    const review={reachable:()=>{},getSnapshot:()=>view};
    const {BindingAuthorButton}=createAuthoringView(React,{ActionButton,IconButton,Menu,MenuFallback:Menu,
      BindingsDialog:workbench.BindingsDialog,PTCPlusSettingsDialog,SessionCapabilityControls,
      useWorkbenchController:workbench.useWorkbenchController,useBindingReview:()=>[review,view],
      catalogOwner,callUserBindings,subscribeReset:()=>()=>{},menuChildren:createMenuChildrenEvidence(),
      icons:{sparkle:Icon,chevron:Icon,close:Icon,check:Icon}});
    const root=createRoot(document.querySelector('#composer'));
    const t=(key,args={})=>window.menuLocale?Object.entries(args).reduce((text,[name,value])=>
      text.replaceAll('{'+name+'}',String(value)),SETTINGS_COPY[window.menuLocale][key]??key):key;
    let settingsValue={enabled:true,...window.capabilityWorkbench?{capabilityManagementEnabled:true,
      capabilityBaseline:JSON.stringify(['tools.read','tools.bash','skills.rightapi-image-generator']),
      capabilityOverrides:JSON.stringify({'tools.edit':'full','tools.mcp__github__search':'on-demand','skills.rightapi-image-generator':'full','tools.previous':'closed'})}: {}};
    settingsValue={...settingsValue,...capabilityProfileConfiguration(settingsValue.capabilityManagementEnabled?Object.fromEntries(Object.entries(settingsValue).filter(([key])=>key.startsWith('capability'))):{})};window.settingsValue=settingsValue;window.settingsWrites=[];
    const updateSetting=async(key,value)=>{window.settingsWrites.push([key,value]);settingsValue={...settingsValue,[key]:value};window.settingsValue=settingsValue;render();return 'status.applied'};
    const updateCapabilityConfiguration=async configuration=>{window.settingsWrites.push(['configuration',configuration]);settingsValue={...settingsValue,...configuration};window.settingsValue=settingsValue;render();return 'status.applied'};
    const usePtcSettings=select=>select({status:'ready',writable:true,value:settingsValue});
    const render=()=>root.render(window.settingsDialog?h(PTCPlusSettingsDialog,{t,onClose:()=>{},
      usePtcSettings,updateSetting,updateCapabilityConfiguration,callUserBindings}):window.settingsPage?h(PTCPlusSettingsCard,{view:'page',t,
      usePtcSettings,updateSetting,updateCapabilityConfiguration,callUserBindings}):h(BindingAuthorButton,{sessionId:'fallback-session',t,
      useInput:select=>select({draft:''}),inputActions:{setDraft:draft=>{window.commandDraft=draft}},useCapabilityCommand:()=>true,
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
    const {PTCPlusToolRow}=createPtcToolView(React,{createPortal,DisclosureRow:window.nativeButtons?DisclosureRow:undefined,
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
  await mkdir('artifacts/button-styles', { recursive: true })
  console.log(`Fallback visual: ${cases.length}/${availableCases.length} cases, ${concurrency} isolated browsers`)
  await runBrowserCases(cases, async (page, { family, width, theme, native, locale, viewport }) => {
    const chooseSelect = async (root, label, option) => {
      await root.getByRole('combobox', { name: label, exact: true }).click()
      await page.getByRole('option', { name: option, exact: true }).click()
    }
    // One decision through the control the row renders: the list brings the row's
    // control into view on every surface, so no surface needs a separate path.
    const openContextDisclosure = async root => {
      const labels = SETTINGS_COPY[locale]
      await root.locator('.ptcPlusSettingsNav [data-section=capabilities]').click()
      const workbench = root.locator('.ptcPlusCapabilityWorkbench')
      await workbench.getByRole('tab', { name: labels['capabilities.tab.budgets'], exact: true }).click()
      await workbench.getByRole('tab', { name: labels['capabilities.context.description'], exact: true }).click()
      await workbench.getByRole('combobox', { name: labels['capabilities.defaultDisclosure'], exact: true }).click()
    }
      if (family === 'dock') {
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
            const count=document.querySelector('.ptcPlusTool').querySelectorAll('.ptcPlusFeature').length;
            return count===(example==='none'||example==='empty'?0:example==='long'?3:2);
          }, example)
          if (example === 'features-only') {
            await tool.hover()
            await page.getByRole('tooltip').waitFor()
          }
          await assertToolLayout(tool, `${theme}/${native ? 'native' : 'fallback'}/${locale}/${example}`, following)
          await assertToolTypography(tool, `${theme}/${native ? 'native' : 'fallback'}/${locale}/${example}`)
          if (example === 'features-only') {
            await page.mouse.move(0, 0)
            await page.keyboard.press('Escape')
            await page.getByRole('tooltip').waitFor({ state: 'hidden' })
          }
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
        await settleVisual(page)
        assert.equal(await inspect.evaluate(element => getComputedStyle(element).opacity), '1', 'inspection action remains invisible on focus')
        await inspect.press('Enter')
        assert.deepEqual(await page.evaluate(() => window.actions), [['save-draft', true], ['inspect']])
        if (!native && width === 320 && locale === 'en') await assertVisualCounterexamples(page, actions.last())
        await page.screenshot({ path: `artifacts/button-styles/${width}-${theme}-${native ? 'native' : 'fallback'}-${locale}.png`, fullPage: true })
        return
      }
      if (family === 'single-disabled') {
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
        const groupName = SETTINGS_COPY[locale]['bindings.quickDisabled'].replace('{count}', '1')
        const group = menu.getByRole('menuitem', { name: groupName, exact: true })
        await group.waitFor()
        assert.equal(await group.getAttribute('aria-expanded'), 'false')
        await group.press('Enter')
        assert.equal(await group.getAttribute('aria-expanded'), 'true')
        await menu.locator('[data-binding-id]').waitFor()
        const label = `single-disabled/${native ? 'native' : 'fallback'}/${locale}/${theme}`
        await assertSparkleMenuTypography(menu, label)
        await assertSparkleMenuLayout(menu, label)
        if (native && locale === 'zh' && theme === 'light') {
          for (const [property, value] of [['border-width', '0'], ['border-radius', '0'], ['box-shadow', 'none']]) {
            const fault = await page.addStyleTag({ content: `.ptcPlusBindingMenu{${property}:${value}!important}` })
            try {
              await assert.rejects(() => assertSparkleMenuTypography(menu, `${label}/${property} fault`), /menu surface styles lost/)
            } finally {
              await fault.evaluate(element => element.remove())
            }
            await assertSparkleMenuTypography(menu, `${label}/restored surface`)
          }
          for (const [property, value] of [['text-align', 'left'], ['border', '1px solid black']]) {
            const fault = await page.addStyleTag({ content: `.ptcPlusMenuButton{${property}:${value}!important}` })
            try {
              await assert.rejects(() => assertSparkleMenuTypography(menu, `${label}/${property} fault`), /centered caption and no border/)
            } finally {
              await fault.evaluate(element => element.remove())
            }
            await assertSparkleMenuTypography(menu, `${label}/restored action`)
          }
        }
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
        return
      }
      if (family === 'session-capabilities') {
        await page.goto('about:blank')
        await page.setViewportSize(viewport)
        await page.setContent('<style>body{font:24px/36px system-ui,sans-serif}</style><div id="composer" style="position:fixed;bottom:16px;left:16px;width:calc(100vw - 32px);height:60px"></div>')
        await page.evaluate(({ native, locale }) => { window.nativeMenu = native; window.nativeSettingsModal = native; window.menuLocale = locale }, { native, locale })
        for (const output of fixture.outputFiles) {
          if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
          else await page.addScriptTag({ content: output.text })
        }
        await setFixtureTheme(page, theme)
        const labels = SETTINGS_COPY[locale]
        const caseLabel = `${viewport.width}x${viewport.height}/${native ? 'native' : 'fallback'}/${locale}/${theme}`
        await page.locator('.ptcPlusAuthorButton').click()
        const menu = page.getByRole('menu')
        const toggle = menu.getByRole('menuitem', { name: labels['capabilities.quick.title'], exact: true })
        await toggle.click()
        const panel = page.getByRole('dialog', { name: labels['capabilities.quick.modalTitle'] })
        assert.equal(await page.evaluate(() => window.nativeModalUsed), native, 'fixture must resolve the requested Modal implementation')
        assert.equal(await panel.evaluate(element => element.classList.contains('ptcPlusFallbackModal')), !native,
          'native workbench must render the official Modal DOM')
        assert.equal(await panel.evaluate(element => element.parentElement.parentElement === document.body), true,
          'workbench Modal must be portaled outside the composer')
        const items = panel.locator('.ptcPlusSessionCapabilityRow')
        await items.first().waitFor()
        assert.equal(await items.count(), 84, 'one row per supplied capability and MCP source')
        // Seven columns plus the receipt, one owner each. A header that can order the
        // table carries the control that does it and states the ordering it would apply
        // next; the receipt column states a sentence, so it offers none.
        const table = panel.locator('.ptcPlusSessionCapabilityTable')
        assert.equal(await table.count(), 1)
        assert.equal(await table.locator('[data-capability-id]').count(), 84, 'every capability row lives in the one table')
        const columnKeys = ['capabilities.column.object', 'capabilities.typesColumn', 'capabilities.sourceColumn',
          'capabilities.column.savedEnabled', 'capabilities.column.savedDisclosure',
          'capabilities.column.sessionEnabled', 'capabilities.column.sessionDisclosure',
          'capabilities.column.receipt']
        assert.deepEqual(await table.locator('[role=columnheader]').allTextContents(),
          [...columnKeys.slice(0, -1).map(key => `${labels[key]}↕`), labels[columnKeys.at(-1)]],
          'the table states its seven columns in the documented order')
        assert.equal(await table.locator('[aria-sort=none]').count(), 7, 'every orderable header states that nothing is sorted')
        assert.equal(await table.locator('[role=columnheader] button').count(), 7, 'every orderable header carries its sort control')
        // The Host supplies the binding document whether or not this session used any
        // of it, so the group is always present and a zero-row group is an empty table.
        const bindings = panel.locator('.ptcPlusBindingGroup')
        assert.equal(await bindings.count(), 1, 'the binding group renders for every session')
        assert.equal(await bindings.locator('h3').innerText(), labels['bindings.title'])
        assert.equal(await bindings.locator('.ptcPlusSessionCapabilityRow').count(), 0, 'this session used no binding')
        assert.deepEqual(await bindings.locator('[role=columnheader]').allTextContents(),
          [...columnKeys.slice(0, -1).map(key => `${labels[key]}↕`), labels[columnKeys.at(-1)]],
          'the binding group answers the same questions in the same places')
        // The row set is the supply's order; the panel invents neither rows nor a ranking.
        const order = () => items.evaluateAll(rows => rows.map(row => row.dataset.capabilityId))
        const initialOrder = await order()
        assert.deepEqual(initialOrder.slice(0, 3), ['tools.probe0', 'tools.probe1', 'tools.probe2'])
        assert.deepEqual(initialOrder.slice(-3), ['skills.design', 'mcpServers.docs', 'tools.mcp__docs__search'])
        // Each cell states its own fact; no cell borrows another's answer.
        const cell = (id, className) => panel.locator(`[data-capability-id="${id}"] .${className}`)
        assert.equal(await panel.locator('[data-capability-id="tools.probe0"]').getAttribute('data-kind'), 'capability')
        assert.equal(await panel.locator('[data-capability-id="mcpServers.docs"]').getAttribute('data-kind'), 'server')
        assert.equal(await cell('tools.probe0', 'ptcPlusSessionCapabilityName').innerText(), 'probe0')
        assert.equal(await cell('tools.probe0', 'ptcPlusCapabilityIdentityText').locator('code').innerText(), 'tools.probe0')
        assert.equal(await cell('tools.probe0', 'ptcPlusCapabilityBadge').innerText(), labels['capabilities.type.tool'])
        assert.equal(await cell('tools.probe0', 'ptcPlusCapabilitySource').innerText(), labels['capabilities.source.host'])
        assert.equal(await cell('skills.design', 'ptcPlusCapabilityBadge').innerText(), labels['capabilities.type.skill'])
        assert.equal(await cell('skills.design', 'ptcPlusCapabilitySource').innerText(), labels['capabilities.source.project-dsh'])
        assert.equal(await cell('mcpServers.docs', 'ptcPlusCapabilityBadge').innerText(), labels['capabilities.type.server'])
        assert.equal(await cell('mcpServers.docs', 'ptcPlusCapabilitySource').innerText(), labels['capabilities.source.mcp'])
        assert.equal(await cell('tools.mcp__docs__search', 'ptcPlusCapabilityBadge').innerText(), labels['capabilities.type.resource'])
        assert.equal(await cell('tools.mcp__docs__search', 'ptcPlusCapabilitySource').innerText(), 'docs')
        // A name declared by two server namespaces states both of them: the source
        // column names what exists instead of reporting that its owner is unknown.
        assert.equal(await cell('tools.mcp__docs__deep__search', 'ptcPlusCapabilitySource').innerText(),
          ['docs', 'docs__deep'].join(labels['capabilities.source.separator']))
        // The saved address is stated on both dimensions and never controlled: this
        // entrance fixes the session record, so a control here would write an address it
        // does not own.
        assert.equal(await cell('tools.probe0', 'ptcPlusSessionCapabilitySaved').innerText(), labels['capabilities.word.enabled'])
        assert.equal(await cell('tools.probe0', 'ptcPlusSessionCapabilitySavedDisclosure').innerText(),
          labels['capabilities.word.on-demand'])
        assert.equal(await cell('skills.design', 'ptcPlusSessionCapabilitySavedDisclosure').innerText(),
          labels['capabilities.word.full'])
        assert.equal(await cell('mcpServers.docs', 'ptcPlusSessionCapabilitySaved').innerText(), labels['capabilities.word.closed'])
        assert.equal(await cell('mcpServers.docs', 'ptcPlusSessionCapabilitySavedDisclosure').innerText(),
          labels['capabilities.word.perMember'])
        assert.equal(await panel.locator('.ptcPlusSessionCapabilitySaved button, .ptcPlusSessionCapabilitySaved select, .ptcPlusSessionCapabilitySaved input, .ptcPlusSessionCapabilitySavedDisclosure button, .ptcPlusSessionCapabilitySavedDisclosure select, .ptcPlusSessionCapabilitySavedDisclosure input').count(), 0,
          'the saved columns state values instead of offering controls')
        // The receipt column names the record this row's decision leaves, and a row that
        // recorded nothing states that address's own unwritten receipt.
        assert.equal(await cell('tools.probe0', 'ptcPlusSessionCapabilityReceipt').innerText(),
          `${labels['capabilities.word.sessionRecord']} · ${labels['capabilities.word.unwritten']}`)
        assert.equal(await cell('tools.probe5', 'ptcPlusSessionCapabilityReceipt').innerText(),
          `${labels['capabilities.word.sessionRecord']} · availability closed`)
        // A capability decides availability and disclosure; a server states its own
        // availability only, because a disclosure belongs to its members.
        const availabilityOf = id => panel.getByRole('combobox', { name: labels['capabilities.control.sessionEnabled'].replace('{name}', id), exact: true })
        const disclosureOf = id => panel.getByRole('combobox', { name: labels['capabilities.control.sessionDisclosure'].replace('{name}', id), exact: true })
        assert.equal(await availabilityOf('tools.probe0').count(), 1)
        assert.equal(await disclosureOf('tools.probe0').count(), 1)
        assert.equal(await availabilityOf('mcpServers.docs').count(), 1)
        assert.equal(await disclosureOf('mcpServers.docs').count(), 0, 'a server states no disclosure of its own')
        // Each dimension owns a cell of its own: the header names the decision and the
        // cell holds only that one control, so no unlabelled pair shares a cell.
        const decisionsIn = (id, className) => panel.locator(`[data-capability-id="${id}"] .${className}`)
          .locator('[role=combobox], .ptcPlusBindingToggle')
        assert.equal(await decisionsIn('tools.probe0', 'ptcPlusSessionCapabilityAvailability').count(), 1,
          'the availability cell carries only the availability decision')
        assert.equal(await decisionsIn('tools.probe0', 'ptcPlusSessionCapabilityDisclosure').count(), 1,
          'the disclosure cell carries only the disclosure decision')
        assert.equal(await decisionsIn('mcpServers.docs', 'ptcPlusSessionCapabilityAvailability').count(), 1)
        assert.equal(await decisionsIn('mcpServers.docs', 'ptcPlusSessionCapabilityDisclosure').count(), 0,
          'a server row has no disclosure decision to state')
        assert.equal(await cell('mcpServers.docs', 'ptcPlusSessionCapabilityDisclosure').innerText(),
          labels['capabilities.word.perMember'],
          'a server row states where its disclosure decision lives instead of claiming one')
        // A session that recorded nothing states `inherit`, and a recorded choice is
        // that session's own value: neither cell is blank or a denial.
        assert.equal(await availabilityOf('tools.probe0').innerText(), labels['capabilities.word.inherit'])
        assert.equal(await disclosureOf('tools.probe0').innerText(), labels['capabilities.word.inherit'])
        assert.equal(await availabilityOf('tools.probe5').innerText(), labels['capabilities.word.closed'])
        assert.equal(await disclosureOf('skills.design').innerText(), labels['capabilities.word.full'])
        const rowText = (await table.innerText()).toLocaleLowerCase()
        for (const word of ['unavailable', 'not available', 'denied', 'blocked', 'unconfirmed', 'unknown',
          '不可用', '未观察', '未证明', '未确认', '未知']) {
          assert.equal(rowText.includes(word.toLowerCase()), false, `${caseLabel}: a session row states no denial word (${word})`)
        }
        // Typography and control geometry are the panel's own, not the carrier's.
        const typography = await panel.evaluate(element => {
          const trigger = element.querySelector('.ptcPlusSelectTrigger')
          const icon = trigger.querySelector('svg').getBoundingClientRect(), bounds = trigger.getBoundingClientRect()
          return { modal: getComputedStyle(element).fontSize,
            name: getComputedStyle(element.querySelector('.ptcPlusSessionCapabilityName')).fontSize,
            saved: getComputedStyle(element.querySelector('.ptcPlusSessionCapabilitySaved')).fontSize,
            receipt: getComputedStyle(element.querySelector('.ptcPlusSessionCapabilityReceipt')).fontSize,
            iconOffset: Math.abs((icon.top + icon.bottom - bounds.top - bounds.bottom) / 2) }
        })
        assert.equal(typography.modal, '13px', 'the workbench owns its readable body typography')
        assert.equal(typography.name, viewport.width <= 650 && viewport.height <= 480 ? '12px' : '13px',
          'a row name keeps the readable scale the compact surface declares')
        assert.equal(typography.saved, '12px')
        // The shortest surface compacts the receipt so one whole row still fits the list.
        assert.equal(typography.receipt, viewport.height <= 480 ? '10px' : '11px')
        assert.ok(typography.iconOffset < 1, 'Select SVG is vertically centered')
        const controls = await assertVisualSurface(page, panel, 'session capability workbench')
        assert.ok(controls.includes('select'), 'session workbench Select must receive visual coverage')
        await panel.locator('.ptcPlusSessionCapabilityList').evaluate(element => { element.scrollTop = 0 })
        const geometry = await panel.evaluate(element => {
          const rect = element.getBoundingClientRect(), list = element.querySelector('.ptcPlusSessionCapabilityList')
          return { bounded: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
            scrollable: list.scrollHeight > list.clientHeight,
            overflowX: element.scrollWidth > element.clientWidth + 1 }
        })
        assert.equal(geometry.bounded, true, 'session workbench must stay in the viewport')
        assert.equal(geometry.scrollable, true, 'session catalog must scroll independently')
        assert.equal(geometry.overflowX, false, `session workbench must not overflow horizontally: ${JSON.stringify(await panel.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { width: element.clientWidth, scroll: element.scrollWidth, rectWidth: rect.width, children: [...element.children].map(child => ({ name: child.className, width: child.clientWidth, scroll: child.scrollWidth })) }
        }))}`)
        await page.screenshot({ path: `artifacts/button-styles/session-capabilities-${viewport.width}-${viewport.height}-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
        // A reader must be able to read one catalog row completely, on every surface.
        // The measured quantity is the row against the list viewport *under its sticky
        // header*: every surface, the shortest captured one included, has to show one
        // whole row, so no surface may buy its fit by asking for less than the row.
        const rowFit = await items.first().evaluate(element => {
          const row = element.getBoundingClientRect()
          const list = element.closest('.ptcPlusSessionCapabilityList')
          const clip = list.getBoundingClientRect()
          const header = list.querySelector('.ptcPlusSessionCapabilityColumns').getBoundingClientRect()
          return { height: row.height, top: row.top, bottom: row.bottom,
            viewport: { top: clip.top + header.height, bottom: clip.bottom } }
        })
        const shortfall = Math.max(0, rowFit.viewport.top - rowFit.top) + Math.max(0, rowFit.bottom - rowFit.viewport.bottom)
        assert.equal(shortfall, 0, `${caseLabel}: one catalog row must be readable in full ${JSON.stringify(rowFit)}`)
        const kind = panel.getByRole('combobox', { name: labels['capabilities.quick.kind'] })
        await kind.click()
        const popup = page.getByRole('listbox')
        await page.getByRole('option', { name: labels['capabilities.quick.mcp_tools'] }).waitFor()
        assert.equal(await popup.evaluate(element => element.closest('[role=dialog]') === null), true,
          'Select must use its own portal above the native or fallback Modal')
        assert.equal(await popup.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        }), true, 'Select popup must stay in the viewport')
        await page.screenshot({ path: `artifacts/button-styles/session-capabilities-open-select-${viewport.width}-${viewport.height}-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
        await page.keyboard.press('Escape')
        assert.equal(await panel.isVisible(), true, 'first Escape closes only the Select popup')
        assert.equal(await popup.count(), 0, 'Escape must dismiss the Select listbox')
        await page.waitForFunction(label => document.activeElement?.getAttribute('role') === 'combobox'
          && document.activeElement.getAttribute('aria-label') === label, labels['capabilities.quick.kind'])
        assert.equal(await kind.evaluate(element => document.activeElement === element), true,
          'Select dismissal returns focus to its trigger')
        await kind.focus()
        await page.keyboard.press('ArrowDown')
        await popup.waitFor()
        await page.keyboard.press('End')
        await page.waitForFunction(label => document.activeElement?.getAttribute('role') === 'option'
          && document.activeElement.textContent.includes(label), labels['capabilities.quick.mcp_tools'])
        await page.keyboard.press('Enter')
        assert.equal(await kind.locator('span').first().innerText(), labels['capabilities.quick.mcp_tools'])
        assert.deepEqual(await order(), ['tools.mcp__docs__deep__search', 'tools.mcp__docs__search'],
          'the category filter narrows the table to the supplied MCP tools')
        await page.waitForFunction(label => document.activeElement?.getAttribute('role') === 'combobox'
          && document.activeElement.getAttribute('aria-label') === label, labels['capabilities.quick.kind'])
        await page.keyboard.press('ArrowDown')
        await popup.waitFor()
        await page.keyboard.press('Home')
        await page.waitForFunction(label => document.activeElement?.getAttribute('role') === 'option'
          && document.activeElement.textContent.includes(label), labels['capabilities.quick.all'])
        await page.keyboard.press('Enter')
        assert.equal(await kind.locator('span').first().innerText(), labels['capabilities.quick.all'])
        assert.deepEqual(await order(), initialOrder, 'clearing the category restores the supplied order')
        await page.waitForFunction(label => document.activeElement?.getAttribute('role') === 'combobox'
          && document.activeElement.getAttribute('aria-label') === label, labels['capabilities.quick.kind'])
        await page.keyboard.press('Tab')
        assert.equal(await panel.getByRole('combobox', { name: labels['capabilities.sourceFilter'] }).evaluate(element => document.activeElement === element), true,
          `Tab from the category Select reaches the source filter: ${await page.evaluate(() => document.activeElement?.outerHTML)}`)
        await kind.focus()
        await page.keyboard.press('ArrowDown')
        await popup.waitFor()
        await page.keyboard.press('s')
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option'
          && document.activeElement.textContent.startsWith('Skills'))
        await page.keyboard.press('Enter')
        assert.deepEqual(await order(), ['skills.design'], 'typeahead chooses the Skills filter')
        await chooseSelect(panel, labels['capabilities.quick.kind'], labels['capabilities.quick.all'])
        // Non-interactive space inside a row belongs to the row: it stays hit-testable
        // and issues no command, because the table has no row-selection state to enter.
        // These read-only checks run before the first write, because a write's receipt
        // is what the shortest captured surface renders at the expense of the list.
        const probeRow = panel.locator('[data-capability-id="tools.probe79"]')
        await probeRow.scrollIntoViewIfNeeded()
        const gutter = await probeRow.evaluate(element => {
          const row = element.getBoundingClientRect()
          const list = element.closest('.ptcPlusSessionCapabilityList')
          const clip = list.getBoundingClientRect()
          const header = list.querySelector('.ptcPlusSessionCapabilityColumns').getBoundingClientRect()
          const top = Math.max(row.top, clip.top + header.height) + 2
          const bottom = Math.min(row.bottom, clip.bottom) - 2
          return { x: row.left + 3, y: (top + bottom) / 2 }
        })
        const gutterHit = await probeRow.evaluate((element, point) => {
          const hit = document.elementFromPoint(point.x, point.y)
          const list = element.closest('.ptcPlusSessionCapabilityList')
          return { inside: hit !== null && element.contains(hit), interactive: hit === null || hit.closest('button,label,input,a,select') !== null,
            hit: hit === null ? null : `${hit.tagName}.${hit.className}`,
            row: element.getBoundingClientRect().toJSON(), clip: list.getBoundingClientRect().toJSON(),
            point }
        }, gutter)
        assert.equal(gutterHit.inside, true, `${caseLabel}: the row keeps non-interactive space of its own ${JSON.stringify(gutterHit)}`)
        assert.equal(gutterHit.interactive, false, `${caseLabel}: a row gutter is not a control ${JSON.stringify(gutterHit)}`)
        const callsBeforeGutter = await page.evaluate(() => window.sessionCapabilityCalls.length)
        await page.mouse.click(gutter.x, gutter.y)
        assert.equal(await page.evaluate(() => window.sessionCapabilityCalls.length), callsBeforeGutter,
          'clicking a row gutter issues no command')
        await panel.getByRole('searchbox').fill('probe79')
        assert.deepEqual(await order(), ['tools.probe79'])
        await panel.getByRole('searchbox').fill('')
        assert.deepEqual(await order(), initialOrder, 'clearing the search restores the supplied order')
        assert.equal(await page.evaluate(() => window.sessionCapabilityCalls.length), callsBeforeGutter,
          'reading, filtering and arranging are not writes')
        // A row's own control writes this session's record: one command per decision,
        // and the row then states the value a re-read returns.
        for (const index of [0, 79]) {
          const id = `tools.probe${index}`
          const availability = labels['capabilities.control.sessionEnabled'].replace('{name}', id)
          const disclosure = labels['capabilities.control.sessionDisclosure'].replace('{name}', id)
          // Align the whole row with the list's own end: on the shortest captured
          // surface the sticky header overlaps the scrollport's first pixels, and a
          // control hidden beneath it could not be operated at all. Both decision cells
          // belong to the row, so they move into view together.
          const alignRow = () => panel.locator(`[data-capability-id="${id}"]`)
            .evaluate(element => element.scrollIntoView({ block: 'end' }))
          await alignRow()
          await chooseSelect(panel, availability, labels['capabilities.word.closed'])
          await page.waitForFunction(({ name, aria, text }) => {
            const trigger = document.querySelector(`[data-capability-id="${name}"] [aria-label="${aria}"]`)
            return trigger?.textContent?.trim() === text
          }, { name: id, aria: availability, text: labels['capabilities.word.closed'] })
          assert.equal(await page.evaluate(() => window.sessionCapabilityCalls.at(-1).input),
            `set session ${id} availability closed`, 'the availability control writes only its own dimension')
          await alignRow()
          await chooseSelect(panel, disclosure, labels['capabilities.word.full'])
          await page.waitForFunction(({ name, aria, text }) => {
            const trigger = document.querySelector(`[data-capability-id="${name}"] [aria-label="${aria}"]`)
            return trigger?.textContent?.trim() === text
          }, { name: id, aria: disclosure, text: labels['capabilities.word.full'] })
          assert.equal(await page.evaluate(() => window.sessionCapabilityCalls.at(-1).input),
            `set session ${id} disclosure full`, 'the disclosure control writes only its own dimension')
          assert.equal(await availabilityOf(id).innerText(), labels['capabilities.word.closed'],
            'the row states the value its own write recorded')
        }
        // The v1 table opened a detail pane from a selected row and staged pending
        // drafts; neither form is part of this table any more.
        for (const selector of ['.ptcPlusSessionCapabilityDetail', '.ptcPlusSessionCapabilityPending',
          '[data-capability-id="tools.probe0"] .ptcPlusCapabilityAvailability']) {
          assert.equal(await panel.locator(selector).count(), 0, `${caseLabel}: ${selector} is not part of the session table`)
        }
        assert.equal(await panel.locator('[role=row][aria-selected]').count(), 0, 'a row states no selection')
        assert.equal(await panel.locator('.ptcPlusSessionCapabilityName').evaluateAll(names =>
          names.filter(name => name.closest('button,a') !== null).length), 0,
          'a row name is not a navigation control: the table states values instead of opening a pane')
        // Multi-select batch: the dialog lists exactly the picked rows and the footer
        // writes one record per row and dimension.
        const beforeBatchCalls = await page.evaluate(() => window.sessionCapabilityCalls.length)
        const pickRow = async name => {
          const box = panel.getByLabel(labels['capabilities.selectForBatch'].replace('{name}', name), { exact: true })
          await box.check()
        }
        await pickRow('probe1')
        await pickRow('probe2')
        assert.equal((await panel.getByRole('button', { name: labels['capabilities.batchSettings'], exact: true })
          .textContent()).includes('2'), true, 'the batch button reports the selected count')
        await panel.getByRole('button', { name: labels['capabilities.batchSettings'], exact: true }).click()
        const sessionBatch = page.getByRole('dialog', { name: labels['capabilities.batchSettings'], exact: true })
        await sessionBatch.waitFor()
        assert.equal(await sessionBatch.locator('.ptcPlusCapabilityBatchTargets li').count(), 2,
          'the batch window lists exactly the picked rows')
        assert.deepEqual(await sessionBatch.locator('.ptcPlusCapabilityBatchTargets li code').allTextContents(),
          ['tools.probe1', 'tools.probe2'])
        assert.equal(await sessionBatch.getByText(labels['capabilities.batch.selected'].replace('{count}', '2'), { exact: true }).count(), 1)
        await chooseSelect(sessionBatch, `${labels['capabilities.batch.address.session']} · ${labels['capabilities.dimension.availability']}`, labels['capabilities.word.closed'])
        const sessionBatchGeometry = await sessionBatch.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { width: bounds.width, left: bounds.left, right: bounds.right, overflow: element.scrollWidth > element.clientWidth + 1 }
        })
        assert.ok(sessionBatchGeometry.width <= 480 && sessionBatchGeometry.left >= -1 && sessionBatchGeometry.right <= viewport.width + 1,
          'session batch stays a small in-viewport surface')
        assert.equal(sessionBatchGeometry.overflow, false, 'session batch does not overflow horizontally')
        await sessionBatch.getByRole('button', { name: labels['capabilities.batch.record'].replace('{count}', '2') }).click()
        await sessionBatch.waitFor({ state: 'hidden' })
        await page.waitForFunction(() => window.sessionCapabilityCalls.length >= 2)
        assert.equal(await page.evaluate(() => window.sessionCapabilityCalls.length), beforeBatchCalls + 2,
          'a batch writes exactly one record per picked row')
        assert.deepEqual(await page.evaluate(() => window.sessionCapabilityCalls.slice(-2).map(call => call.input)),
          ['set session tools.probe1 availability closed', 'set session tools.probe2 availability closed'])
        await page.waitForFunction(() => document.querySelector('.ptcPlusSessionCapabilityFooter [role=status]'))
        const receipt = await panel.locator('.ptcPlusSessionCapabilityFooter [role=status]').innerText()
        // The footer states the record this write named, in the current language and
        // with no degree of proof: which entry, which choice, which session.
        assert.equal(receipt, labels['capabilities.receipt.record']
          .replace('{session}', 'fallback-session')
          .replace('{record}', `tools.probe2 · ${labels['capabilities.dimension.availability']} ${labels['capabilities.word.closed']}`),
        'the panel states the record its command wrote')
        assert.equal(receipt.includes('ptc-capability-command/v1'), false, 'the footer shows no raw payload')
        for (const word of ['Saved:', 'Delivered:', 'Usable:', 'unproven', '未证明', '不可用', '未记录'])
          assert.equal(receipt.includes(word), false, `the receipt states no proof verdict (${word})`)
        // The receipt is bounded to the two lines the footer may spend on it and stays
        // readable through its own scrollbar: a receipt is a log line, not a layout
        // that may take the list's height or cover a control below it.
        const receiptBox = await panel.locator('.ptcPlusSessionCapabilityFooter [role=status]').evaluate(element => {
          const style = getComputedStyle(element)
          const bounds = element.getBoundingClientRect()
          return { height: bounds.height, maxHeight: parseFloat(style.maxHeight), lineHeight: parseFloat(style.lineHeight),
            scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowY: style.overflowY }
        })
        assert.equal(receiptBox.height <= receiptBox.maxHeight + 1, true,
          `the receipt keeps the footer's height budget ${JSON.stringify(receiptBox)}`)
        assert.equal(receiptBox.height <= receiptBox.lineHeight * 2 + 1, true,
          `the receipt stops at two lines ${JSON.stringify(receiptBox)}`)
        assert.equal(receiptBox.scrollHeight <= receiptBox.clientHeight + 1 || receiptBox.overflowY === 'auto', true,
          `a receipt longer than its two lines stays readable by scrolling ${JSON.stringify(receiptBox)}`)
        const listAfterReceipt = await panel.locator('.ptcPlusSessionCapabilityList').evaluate(element => {
          const clip = element.getBoundingClientRect()
          const header = element.querySelector('.ptcPlusSessionCapabilityColumns').getBoundingClientRect()
          return { viewport: clip.bottom - clip.top - header.height, row: element.querySelector('[data-capability-id]').getBoundingClientRect().height }
        })
        assert.ok(listAfterReceipt.viewport >= listAfterReceipt.row,
          `a receipt never costs the list its row ${JSON.stringify(listAfterReceipt)}`)
        assert.equal(await panel.evaluate(element => {
          const footer = element.querySelector('.ptcPlusSessionCapabilityFooter').getBoundingClientRect()
          const list = element.querySelector('.ptcPlusSessionCapabilityList').getBoundingClientRect()
          return list.bottom <= footer.top + 1 && footer.top >= list.top
        }), true, 'the receipt stays in the footer and never reaches into the list')
        assert.equal(await availabilityOf('tools.probe1').innerText(), labels['capabilities.word.closed'])
        assert.equal(await availabilityOf('tools.probe2').innerText(), labels['capabilities.word.closed'])
        await page.keyboard.press('Escape')
        await panel.waitFor({ state: 'hidden' })
        assert.equal(await page.locator('.ptcPlusAuthorButton').evaluate(element => document.activeElement === element), true,
          'closing the workbench returns focus to the sparkle button')
        await page.evaluate(() => window.showCapabilityReceipt())
        const notice = page.locator('.ptcPlusCapabilityCommandNotice')
        await notice.waitFor()
        assert.equal(await notice.innerText(), labels['capabilities.card.recorded'])
        assert.equal(await notice.locator('code, details, .ptcPlusCapabilityReceiptState').count(), 0)
        assert.equal(await page.locator('.ptcPlusCapabilityReceipt').count(), 0, 'refresh renders no command card')
        assert.equal(await notice.evaluate(element => getComputedStyle(element).fontSize), '13px')
        assert.ok((await notice.boundingBox()).height <= 22, 'refresh receipt is a single text line')
        await notice.screenshot({ path: `artifacts/button-styles/capability-refresh-notice-${viewport.width}-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
        if (viewport.width === 1440 && native) {
          await page.evaluate(() => window.showCapabilityReceipt('list all', JSON.stringify({schema:'ptc-capability-catalog/v1',entries:window.capabilityEntries})))
          const card = page.locator('.ptcPlusCapabilityReceipt')
          await card.getByText(labels['capabilities.card.catalogCount'].replace('{count}', '84'), {exact:true}).waitFor()
          assert.ok((await card.boundingBox()).height < 190, 'catalog does not dump JSON into the conversation')
          await card.getByText(labels['capabilities.card.browse'], {exact:true}).click()
          assert.equal(await card.locator('tbody tr').count(), 84)
          await card.screenshot({path:`artifacts/button-styles/capability-catalog-command-card-native-${locale}-${theme}.png`})
          await card.getByText(labels['capabilities.card.source'], {exact:true}).click()
          await page.waitForFunction(() => document.querySelector('.ptcPlusCapabilityReceiptSource pre'))
          assert.equal(await card.locator('pre').innerText(), await page.evaluate(() => JSON.stringify({schema:'ptc-capability-catalog/v1',entries:window.capabilityEntries})))

        }
        await page.evaluate(() => window.disposeFixture())
        return
      }
      if (family === 'catalog') {
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
        const refresh = menu.getByRole('menuitem', { name: SETTINGS_COPY[locale]['capabilities.applySession'], exact: true })
        assert.equal(await refresh.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element.querySelector(".ptcPlusBindingMenuAction"))
          const lines = [...range.getClientRects()].filter(rect => rect.height > 0)
          return new Set(lines.map(rect => Math.round(rect.top))).size
        }), 1, 'sparkle capability refresh wraps across lines')
        await refresh.click()
        assert.equal(await page.evaluate(() => window.commandDraft), '/capabilities refresh')
        assert.deepEqual(await page.evaluate(() => window.refreshCalls), [])
        await page.getByRole('button', { name: SETTINGS_COPY[locale]['bindings.open'] }).click()
        await menu.locator('[data-binding-id]').first().waitFor()
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
        if (viewport.height === 600 && locale === 'en' && theme === 'light') {
          const fault = await page.addStyleTag({ content: '.ptcPlusBindingQuickState{color:#666!important;background:#eee!important}' })
          try {
            await assert.rejects(() => assertSparkleMenuTypography(menu, `${label}/indistinguishable state fault`), /enabled and disabled badges need distinct/)
          } finally {
            await fault.evaluate(element => element.remove())
          }
          await assertSparkleMenuTypography(menu, `${label}/restored states`)
        }
        await menu.screenshot({ path: `artifacts/button-styles/sparkle-edit-${viewport.width}-${viewport.height}-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
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
        const changedGroup = menu.locator('.ptcPlusBindingMenuScroll [aria-expanded]')
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
        return
      }
      if (family === 'capability-workbench') {
        await page.goto('about:blank')
        await page.setViewportSize({ width, height: 1080 })
        await page.setContent('<style>body{margin:0;font:14px Arial,sans-serif}</style><div id="composer"></div>')
        await setFixtureTheme(page, theme)
        await page.evaluate(({ native, locale }) => {
          window.settingsDialog = true; window.nativeSettingsModal = native; window.menuLocale = locale; window.capabilityWorkbench = true
        }, { native, locale })
        for (const output of fixture.outputFiles) {
          if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
          else await page.addScriptTag({ content: output.text })
        }
        const dialog = page.locator('.ptcPlusSettingsModal')
        await dialog.waitFor()
        await dialog.locator('[data-section=capabilities]').evaluate(element => element.click())
        const labels = SETTINGS_COPY[locale]
        const label = `${width}/${theme}/${native ? 'native' : 'fallback'}/${locale}`
        const workbench = dialog.locator('.ptcPlusCapabilityWorkbench')
        // The capability page is the one renderer, mounted with the address this entrance
        // fixes. It states its own address set, its own columns and its own receipt — and
        // no session column exists here at all.
        const surface = workbench.locator('.ptcPlusCapabilitySurface')
        await surface.waitFor()
        assert.equal(await surface.locator('.ptcPlusSessionCapabilityAddresses').innerText(),
          labels['capabilities.surface.addresses.settings'], `${label}: the page states its address set`)
        assert.deepEqual(await surface.locator('.ptcPlusSessionCapabilityColumns [role=columnheader]').allTextContents(),
          ['capabilities.column.object', 'capabilities.typesColumn', 'capabilities.sourceColumn',
            'capabilities.column.savedEnabled', 'capabilities.column.savedDisclosure'].map(key => `${labels[key]}↕`),
          `${label}: the settings entrance states five orderable columns and no session address`)
        assert.equal(await surface.locator('.ptcPlusSessionCapabilityAvailability').count(), 0,
          `${label}: the session availability column must not exist at this entrance`)
        assert.equal(await surface.locator('.ptcPlusSessionCapabilityDisclosure').count(), 0,
          `${label}: the session disclosure column must not exist at this entrance`)
        assert.equal(await surface.locator('.ptcPlusSessionCapabilityReceipt').count(), 0,
          `${label}: this entrance states no receipt column`)
        const rows = surface.locator('[data-capability-id]')
        assert.equal(await rows.count(), 8, `${label}: one row per supplied entry`)
        const capabilityRows = await surface.locator('[data-capability-id]:not([data-kind=server])').count()
        assert.equal(await surface.locator('.ptcPlusSessionCapabilitySaved [role=combobox]').count(), capabilityRows,
          `${label}: every capability row's saved availability cell is a control at this entrance`)
        assert.equal(await surface.locator('.ptcPlusSessionCapabilitySavedDisclosure [role=combobox]').count(), capabilityRows,
          `${label}: every capability row's saved disclosure cell is a control at this entrance`)
        // Every row at this entrance carries a pick except a server row, whose saved cell edits the
        // scope's rule on its own and takes no part in a batch (§8.1a).
        assert.equal(await surface.locator('.ptcPlusPick').count(), capabilityRows,
          `${label}: one pick per capability row and none on a server row`)
        assert.equal(await surface.locator('[role=columnheader] button').count(), 5, `${label}: every orderable header carries its sort control`)
        assert.equal(await workbench.locator('textarea').count(), 0)
        // A saved cell writes the object's own rule through the settings writer and no
        // other capability key.
        const writesBefore = await page.evaluate(() => window.settingsWrites.length)
        await chooseSelect(surface, labels['capabilities.control.savedEnabled'].replace('{name}', 'tools.read'),
          labels['capabilities.word.closed'])
        await page.waitForFunction(() => JSON.parse(window.settingsValue.capabilityPolicy).items['tools.read']?.availability === 'closed')
        assert.deepEqual(await page.evaluate(writesBefore => window.settingsWrites.slice(writesBefore).map(([key]) => key), writesBefore),
          ['capabilityPolicy'], `${label}: one saved cell writes one field`)
        // The receipt the write leaves names the record it wrote.
        assert.match(await workbench.locator('.ptcPlusSessionCapabilityFooter [role=status]').innerText(),
          new RegExp(labels['capabilities.receipt.record.global'].replace(/\{[^}]+\}/g, '.+')), `${label}: the footer states one receipt`)
        await page.screenshot({ path: `artifacts/button-styles/capability-surface-${width}-${theme}-${native ? 'native' : 'fallback'}-${locale}.png` })
        // The rule chain that answers for objects this address has not decided one by one
        // stays a rule editor beside the page.
        await workbench.getByRole('button', { name: labels['capabilities.inheritedRules'], exact: true }).click()
        const rules = page.getByRole('dialog', { name: labels['capabilities.inheritedRules'], exact: true })
        await rules.waitFor()
        const rulesBounds = await rules.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
        })
        assert.ok(rulesBounds.left >= 0 && rulesBounds.right <= width && rulesBounds.top >= 0 && rulesBounds.bottom <= 1080,
          `${label}: the inherited-rules window stays inside the viewport`)
        await rules.getByRole('button', { name: labels['capabilities.dialogDone'], exact: true }).click()
        await rules.waitFor({ state: 'hidden' })
        // The rest of the workbench is settings, not the page: its tabs still switch.
        const combinationChoices = workbench.locator('.ptcPlusCombinationChoices button')
        assert.equal(await combinationChoices.count(), 6)
        await workbench.getByRole('tab', { name: labels['capabilities.tab.budgets'], exact: true }).click()
        await workbench.locator('.ptcPlusContextNavigation').waitFor()
        await assertVisualSurface(page, workbench.locator('.ptcPlusCapabilityPane:not([hidden])'), `${label}: capability workbench`)
        await page.evaluate(() => window.disposeFixture())
        return
      }

      if (family === 'settings-dialog') {
        await page.goto('about:blank')
        await page.setViewportSize(viewport)
        await page.setContent('<style>body{margin:0;font:14px Arial,sans-serif}</style><div id="composer"></div>')
        await setFixtureTheme(page, theme)
        await page.evaluate(({ native, locale }) => {
          window.settingsDialog = true; window.nativeSettingsModal = native; window.menuLocale = locale
        }, { native, locale })
        for (const output of fixture.outputFiles) {
          if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
          else await page.addScriptTag({ content: output.text })
        }
        const dialog = page.locator('.ptcPlusSettingsModal')
        await dialog.waitFor()
        const navigation = dialog.locator('.ptcPlusSettingsNav')
        const label = `${viewport.width}x${viewport.height}/${native ? 'native' : 'fallback'}/${locale}/${theme}`
        const fields = dialog.locator('.ptcPlusFields')
        const scrollFrame = () => dialog.evaluate(element => {
          const rail = element.querySelector('.ptcPlusSettingsNav').getBoundingClientRect()
          const head = element.querySelector('.ptcPlusSettingsDialogHead').getBoundingClientRect()
          return { railTop: rail.top, railLeft: rail.left, railHeight: rail.height, headTop: head.top,
            bodyScroll: element.querySelector('.ptcPlusSettingsDialogContent').scrollTop, documentScroll: scrollY }
        })
        assert.equal(await dialog.locator('.ptcPlusSettingsHero,.ptcPlusSettingsNavSwitch,.ptcPlusStatus').count(), 0,
          `${label}: duplicate switch or workspace/status chrome remains`)
        const titleSwitch = navigation.locator('.ptcPlusSettingsTitleSwitch')
        assert.equal(await titleSwitch.locator('strong').innerText(), 'PTC Plus')
        assert.equal(await titleSwitch.evaluate(element => getComputedStyle(element).borderTopWidth), '0px')
        await titleSwitch.locator('strong').click()
        await page.waitForFunction(() => {
          const toggle = document.querySelector('.ptcPlusSettingsTitleSwitch input')
          return toggle.checked === false && !toggle.disabled
        })
        const toggle = titleSwitch.locator('input[role=switch]')
        await toggle.focus()
        await page.keyboard.press('Space')
        await page.waitForFunction(() => {
          const toggle = document.querySelector('.ptcPlusSettingsTitleSwitch input')
          return toggle.checked === true && !toggle.disabled
        })
        assert.deepEqual(await page.evaluate(() => window.settingsWrites), [['enabled', false], ['enabled', true]],
          `${label}: title pointer and keyboard toggle bypassed the settings writer`)
        const hierarchy = await navigation.evaluate(element => {
          const caption = element.querySelector('.ptcPlusSettingsNavModuleTitle')
          const row = element.querySelector('.ptcPlusSettingsNavItem')
          const title = element.querySelector('.ptcPlusSettingsTitleSwitch strong').getBoundingClientRect()
          const toggle = element.querySelector('.ptcPlusSettingsTitleSwitch input').getBoundingClientRect()
          const capability = element.querySelector('[data-section=capabilities] .ptcPlusSettingsNavLabel')
          const word = document.createRange()
          word.setStart(capability.firstChild, 0)
          word.setEnd(capability.firstChild, capability.textContent.startsWith('Capabilities') ? 'Capabilities'.length : capability.textContent.length)
          return { titleGap: toggle.left - title.right, capabilityWordLines: word.getClientRects().length,
            captionSize: parseFloat(getComputedStyle(caption).fontSize),
            itemSize: parseFloat(getComputedStyle(row).fontSize), captionClickable: Boolean(caption.closest('button,a')),
            icons: element.querySelectorAll('.ptcPlusSettingsNavIcon').length,
            arrows: element.querySelectorAll('.ptcPlusSettingsNavArrow').length }
        })
        assert.ok(hierarchy.titleGap >= 7 && hierarchy.titleGap <= 10, `${label}: title switch is separated from PTC Plus`)
        if (viewport.width >= 860) assert.equal(hierarchy.capabilityWordLines, 1, `${label}: capability navigation word is split by its badge`)
        assert.ok(hierarchy.itemSize >= hierarchy.captionSize + 2 && !hierarchy.captionClickable
          && hierarchy.icons === 7 && hierarchy.arrows === 7, `${label}: module captions resemble navigation rows`)
        let fixedFrame = await scrollFrame()
        await fields.hover()
        await page.mouse.wheel(0, 200)
        await page.waitForFunction(() => document.querySelector('.ptcPlusSettingsDialog .ptcPlusFields').scrollTop > 0)
        assert.deepEqual(await scrollFrame(), fixedFrame, `${label}: settings wheel scroll moved navigation or modal frame`)
        const assertNavigationFocus = async control => {
          const result = await control.evaluate(element => {
            const rect = element.getBoundingClientRect()
            const viewport = element.closest('.ptcPlusSettingsDialogContent').getBoundingClientRect()
            const rail = element.closest('.ptcPlusSettingsNav').getBoundingClientRect()
            const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
            return { text: element.textContent, left: rect.left, right: rect.right, list: element.closest('.ptcPlusSettingsNavList')?.getBoundingClientRect().toJSON(), hitClass: document.elementFromPoint(x, y)?.className, focused: document.activeElement === element, top: rect.top, bottom: rect.bottom,
              clipTop: Math.max(viewport.top, rail.top), clipBottom: Math.min(viewport.bottom, rail.bottom),
              navigationHeight: rail.height, navigationLimit: getComputedStyle(element.closest('.ptcPlusSettingsNav')).maxHeight, contentHeight: viewport.height,
              hit: element.contains(document.elementFromPoint(x, y)) }
          })
          assert.ok(result.focused && result.top >= result.clipTop - 1
            && result.bottom <= result.clipBottom + 1 && result.hit,
          `${label}: focused settings navigation is clipped or covered ${JSON.stringify(result)}`)
        }
        const checkNavigation = async () => {
          const toggle = navigation.locator('input[role=switch]')
          await toggle.focus()
          await assertNavigationFocus(toggle)
          for (const key of ['syntax', 'recovery', 'extensions', 'calls', 'interface', 'limits', 'capabilities']) {
            const button = navigation.locator(`[data-section=${key}]`)
            await page.keyboard.press('Tab')
            await assertNavigationFocus(button)
            await page.keyboard.press('Enter')
            await assertNavigationFocus(button)
            const visible = await dialog.locator(`#ptc-plus-settings-dialog-group-${key}`).evaluate(element => {
              const heading = element.getBoundingClientRect(), clip = element.closest('.ptcPlusFields').getBoundingClientRect()
              return { visible: heading.top >= clip.top - 1 && heading.bottom <= clip.bottom + 1, headingTop: heading.top, headingBottom: heading.bottom, clipTop: clip.top, clipBottom: clip.bottom, navDirection: getComputedStyle(element.closest('.ptcPlusSettingsModal').querySelector('.ptcPlusSettingsNav')).flexDirection, modalHeight: element.closest('.ptcPlusSettingsModal').clientHeight, navHeight: element.closest('.ptcPlusSettingsModal').querySelector('.ptcPlusSettingsNav').clientHeight, headHeight: element.closest('.ptcPlusSettingsModal').querySelector('.ptcPlusSettingsDialogHead').clientHeight }
            })
            assert.equal(visible.visible, true, `${label}/${key}: selected heading is clipped ${JSON.stringify(visible)}`)
            assert.deepEqual(await scrollFrame(), fixedFrame, `${label}: section navigation moved the rail or modal frame`)
            assert.equal(await button.getAttribute('aria-current'), 'location')
          }
          const close = dialog.locator('.ptcPlusDialogClose')
          assert.equal(await close.evaluate(element => {
            const rect = element.getBoundingClientRect()
            return rect.top >= 0 && rect.bottom <= innerHeight
              && element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
          }), true, `${label}: navigation obscured the fixed close action`)
        }
        await checkNavigation()
        if (viewport.height === 600 && theme === 'light' && locale === 'en') {
          const fault = await page.addStyleTag({ content: '.ptcPlusSettingsDialogContent{overflow:auto!important}.ptcPlusSettingsDialog,.ptcPlusSettingsDialog .ptcPlusBody,.ptcPlusSettingsDialog .ptcPlusBodyInner,.ptcPlusSettingsDialog .ptcPlusSettingsLayout{height:auto!important}.ptcPlusSettingsDialog .ptcPlusFields{height:auto!important;overflow:visible!important}' })
          try {
            await dialog.locator('.ptcPlusSettingsDialogContent').evaluate(element => { element.scrollTop = 240 })
            assert.notDeepEqual(await scrollFrame(), fixedFrame, `${label}: frame oracle did not reject shared navigation/content scrolling`)
          } finally {
            await fault.evaluate(element => element.remove())
            await dialog.locator('.ptcPlusSettingsDialogContent').evaluate(element => { element.scrollTop = 0 })
          }
          await checkNavigation()
        }
        if (viewport.height === 420) {
          const fault = await page.addStyleTag({ content: '.ptcPlusSettingsDialog .ptcPlusSettingsNav{max-height:none!important;overflow:visible!important}' })
          try {
            await assert.rejects(checkNavigation, /focused settings navigation is clipped or covered/)
          } finally {
            await fault.evaluate(element => element.remove())
          }
          await checkNavigation()
        }
        if (native) {
          await page.evaluate(() => document.documentElement.style.setProperty('--dsh-frame-overlay-top', '64px'))
          fixedFrame = await scrollFrame()
          await checkNavigation()
          if (viewport.width < 860) {
            for (const key of ['syntax', 'recovery', 'extensions', 'calls', 'interface', 'limits', 'capabilities']) {
              const group = dialog.locator(`#ptc-plus-settings-dialog-group-${key}`).locator('..')
              const control = group.locator('input:not(:disabled),button:not(:disabled),select:not(:disabled)').first()
              await control.focus()
              const reachable = await control.evaluate(element => {
                const rect = element.getBoundingClientRect(), clip = element.closest('.ptcPlusFields').getBoundingClientRect()
                return rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1
                  && element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
              })
              assert.equal(reachable, true, `${label}: focused section control is clipped under Host inset`)
            }
            const fault = await page.addStyleTag({ content: '.ptcPlusSettingsDialog .ptcPlusSettingsNav{flex-direction:column!important;align-items:stretch!important}' })
            try {
              await assert.rejects(checkNavigation, /selected heading is clipped|focused settings navigation is clipped or covered/)
            } finally {
              await fault.evaluate(element => element.remove())
            }
            await checkNavigation()
          }
        }
        for (const zoom of [1, 1.25]) {
          await dialog.evaluate((element, zoom) => { element.style.zoom = zoom }, zoom)
          for (const key of ['syntax', 'calls', 'limits', 'capabilities']) {
            await fields.evaluate((element, { key, zoom }) => {
              const group = element.querySelector('[aria-labelledby="ptc-plus-settings-dialog-group-' + key + '"]')
              // The fixture applies this exact zoom; do not infer it from rounded offsetHeight.
              element.scrollTop += (group.getBoundingClientRect().top - element.getBoundingClientRect().top) / zoom - element.clientTop
              element.dispatchEvent(new Event('scroll'))
            }, { key, zoom })
            await page.waitForFunction(key => document.querySelector('[data-section=' + key + ']').getAttribute('aria-current') === 'location', key)
            assert.equal(await navigation.locator('[aria-current=location]').count(), 1)
          }
          await fields.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')) })
          await page.waitForFunction(() => document.querySelector('[data-section=capabilities]').getAttribute('aria-current') === 'location')
        }
        await dialog.evaluate(element => { element.style.zoom = '' })
        await page.evaluate(() => {
          document.querySelector('.ptcPlusSettingsDialog .ptcPlusFields').scrollTop = 0
          document.querySelector('.ptcPlusSettingsNav').scrollTop = 0
        })
        await page.screenshot({ path: `artifacts/button-styles/settings-dialog-${viewport.width}x${viewport.height}-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
        if (viewport.width === 1440 && viewport.height >= 600) {
          await openContextDisclosure(dialog)
          await page.getByRole('option').first().waitFor()
          await page.screenshot({ path: `artifacts/button-styles/settings-dialog-open-select-${viewport.width}x${viewport.height}-${native ? 'native' : 'fallback'}-${locale}-${theme}.png` })
          await page.keyboard.press('Escape')
        }
        await page.evaluate(() => window.disposeFixture())
        return
      }
      if (family === 'settings-page') {
        await page.goto('about:blank')
        await page.setViewportSize({ width, height: 900 })
        await page.setContent(`<style>body{margin:0;font:14px Arial,sans-serif}#host-page{height:850px;overflow:auto;padding:18px}
          #host-header{height:240px}#composer{margin:0 auto}#host-footer{height:800px}</style>
          <div style="height:30px">Host frame</div><div id="host-page"><header id="host-header"><h1>PTC Plus</h1>Plugin configuration</header>
          <div id="composer"></div><div id="host-footer"></div></div><div style="height:800px"></div>`)
        await setFixtureTheme(page, theme)
        await page.evaluate(locale => { window.settingsPage = true; window.menuLocale = locale }, locale)
        for (const output of fixture.outputFiles) {
          if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
          else await page.addScriptTag({ content: output.text })
        }
        const settings = page.locator('#composer .ptcPlusCard')
        await settings.waitFor()
        // Keep both external scroll ancestors nonzero, with the navigation visible.
        await page.evaluate(() => { window.scrollTo(0, 20); document.querySelector('#host-page').scrollTop = 240 })
        const baseline = await page.evaluate(() => ({ document: window.scrollY, host: document.querySelector('#host-page').scrollTop }))
        const navigation = settings.locator('.ptcPlusSettingsNav')
        const geometry = await settings.evaluate(element => {
          const outer = element.getBoundingClientRect(), nav = element.querySelector('.ptcPlusSettingsNav').getBoundingClientRect()
          const content = element.querySelector('.ptcPlusFields').getBoundingClientRect()
          return { leftInset: nav.left - outer.left, topInset: nav.top - outer.top,
            rightInset: outer.right - content.right, navRight: nav.right, contentLeft: content.left,
            navLeft: nav.left, navTop: nav.top, contentTop: content.top }
        })
        assert.ok(geometry.leftInset >= 14 && geometry.topInset >= 14 && geometry.rightInset >= 14,
          `${width}/${theme}/${locale}: official settings page lacks inner spacing ${JSON.stringify(geometry)}`)
        if (width === 1440) assert.ok(geometry.navRight < geometry.contentLeft, 'official page lost two columns')
        else assert.ok(Math.abs(geometry.navLeft - geometry.contentLeft) <= 1, 'narrow official page did not stack')
        for (const key of ['capabilities', 'calls', 'syntax']) {
          const target = settings.locator(`#ptc-plus-settings-group-${key}`)
          const button = navigation.locator(`[data-section=${key}]`)
          await button.evaluate(element => {
            const track = element.closest('.ptcPlusSettingsNavList')
            if (getComputedStyle(track).overflowX === 'auto') track.scrollLeft += element.getBoundingClientRect().left - track.getBoundingClientRect().left
          })
          if (key === 'calls') {
            await button.evaluate(element => element.focus({ preventScroll: true }))
            await page.keyboard.press('Enter')
          } else await button.click()
          const result = await page.evaluate(() => ({ document: window.scrollY, host: document.querySelector('#host-page').scrollTop }))
          assert.deepEqual(result, baseline, `${width}/${locale}: settings navigation moved the Host page`)
          const visible = await target.evaluate(element => {
            const heading = element.getBoundingClientRect(), viewport = element.closest('.ptcPlusFields').getBoundingClientRect()
            return heading.top >= viewport.top && heading.bottom <= viewport.bottom
          })
          assert.equal(visible, true, `${width}/${locale}: selected settings heading was not revealed`)
          assert.equal(await button.getAttribute('aria-current'), 'location')
          assert.equal(await navigation.locator('[aria-current=location]').count(), 1)
        }
        await settings.locator('#ptc-plus-settings-group-capabilities').evaluate(element => element.scrollIntoView({ block: 'start' }))
        const misplaced = await page.evaluate(() => ({ document: window.scrollY, host: document.querySelector('#host-page').scrollTop }))
        assert.notDeepEqual(misplaced, baseline, 'outer-scroll assertion cannot reject the original scrollIntoView behavior')
        await page.evaluate(baseline => {
          window.scrollTo(0, baseline.document)
          document.querySelector('#host-page').scrollTop = baseline.host
          document.querySelector('.ptcPlusFields').scrollTop = 0
        }, baseline)
        if (width === 1440) {
          await page.locator('#composer').evaluate(element => { element.style.width = '600px' })
          const stacked = await settings.evaluate(element => {
            const nav = element.querySelector('.ptcPlusSettingsNav').getBoundingClientRect(), content = element.querySelector('.ptcPlusFields').getBoundingClientRect()
            return Math.abs(nav.left - content.left) <= 1 && content.top >= nav.bottom
          })
          assert.equal(stacked, true, 'narrow official page container kept desktop columns')
          await page.locator('#composer').evaluate(element => { element.style.width = '' })
        }
        await page.screenshot({ path: `artifacts/button-styles/settings-page-${width}-${theme}-${locale}.png` })
        if (width === 1440) {
          await openContextDisclosure(settings)
          await page.getByRole('option').first().waitFor()
          await page.screenshot({ path: `artifacts/button-styles/settings-page-open-select-${width}-${theme}-${locale}.png` })
          await page.keyboard.press('Escape')
        }
        await page.evaluate(() => window.disposeFixture())
        return
      }
      if (family === 'dialogs') {
        await page.goto('about:blank')
        await page.setViewportSize(viewport)
        await page.setContent(`<button id="background" style="position:fixed;top:10px;left:10px">Host control</button>
        <div id="composer" style="position:fixed;bottom:16px;left:16px;width:calc(100vw - 32px);height:60px;overflow:hidden;transform:translateZ(0)"></div>`)
        await page.evaluate(native => { window.nativeMenu = native === true; window.nativeSettingsModal = native === true }, native)
        for (const output of fixture.outputFiles) {
          if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text })
          else await page.addScriptTag({ content: output.text })
        }
        await setFixtureTheme(page, theme)
        const trigger = page.locator('.ptcPlusAuthorButton')
        await trigger.click()
        const menu = page.getByRole('menu')
        await menu.waitFor()
        assert.equal(await menu.evaluate(element => element.closest('#composer') === null), true, 'menu must escape the clipped composer')
        if (native !== true) assert.equal(await menu.evaluate(element => element.parentElement === document.body), true)
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
        assert.equal(await page.evaluate(() => window.nativeModalUsed), native === true)
        assert.equal(await dialog.evaluate(element => element.classList.contains('ptcPlusFallbackModal')), native !== true)
        assert.equal(await dialog.locator('.ptcPlusBindings').count(), 1, 'Manage global bindings must render its complete workbench')
        await page.evaluate(() => { window.deferCatalog = true })
        await dialog.getByRole('button', { name: 'bindings.reload', exact: true }).click()
        await page.waitForFunction(() => document.querySelector('.ptcPlusBindings')?.getAttribute('aria-busy') === 'true')
        for (const control of await dialog.locator('button:disabled').all()) {
          if (!await control.isVisible()) continue
          await assertControlVisual(control, { label: `busy workbench control/${await control.getAttribute('aria-label') ?? await control.innerText()}` })
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
        return
      }
      if (family === 'hover-settlement') {
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
        return
      }

  }, { concurrency, channel: values['browser-channel'], reducedMotion: 'reduce' })
  process.stdout.write(focused
    ? `Focused fallback visual passed: ${cases.length}/${availableCases.length} cases\n`
    : values['menu-only']
      ? 'Client: native/fallback sparkle menu pinned actions, grouped catalog and keyboard return passed\n'
      : 'Client: native/fallback dock button styles and save actions, pinned sparkle menu groups, viewport keyboard/pointer actions, composition draft, hover settlement, modal mask and focus return passed\n')
  console.log(`Fallback visual completed in ${((performance.now() - started) / 1000).toFixed(1)} s`)
}
