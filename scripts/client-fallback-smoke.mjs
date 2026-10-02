import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const fixture = await build({
  stdin: { resolveDir: process.cwd(), sourcefile: 'fallback-fixture.js', contents: `
    import * as React from 'react';
    import {createRoot} from 'react-dom/client';
    import {createPortal} from 'react-dom';
    import {resolvePrimitives} from './src/client-primitives.js';
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
    const ActionButton=({'data-kind':kind,...props})=>h('button',props);
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
    root.render(h(BindingAuthorButton,{sessionId:'fallback-session',t:key=>key,
      useInput:select=>select({draft:''}),inputActions:{setDraft:()=>{}},
      usePtcSettings:select=>select({status:'ready',writable:true,value:{enabled:true}}),useBindingCommand:()=>true}));
    window.disposeFixture=()=>{root.unmount();catalogOwner.dispose()};
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  define: { __PTC_PLUS_CLIENT_MODULE_ID__: JSON.stringify('dsh-ptc-plus'), 'process.env.NODE_ENV': JSON.stringify('production') },
})
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  for (const viewport of [{ width: 390, height: 600 }, { width: 320, height: 420 }]) {
    await page.goto('about:blank')
    await page.setViewportSize(viewport)
    await page.setContent(`<button id="background" style="position:fixed;top:10px;left:10px">Host control</button>
      <div id="composer" style="position:fixed;bottom:16px;left:16px;width:calc(100vw - 32px);height:60px;overflow:hidden;transform:translateZ(0)"></div>`)
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
    assert.equal(await dialog.evaluate(element => element.parentElement.parentElement === document.body), true)
    assert.equal(await page.locator('#background').evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), false, 'headless modal leaves the background clickable')
    await dialog.locator('.ptcPlusBindingSelect').first().click()
    await dialog.locator('.ptcPlusSourceActions button').click()
    await dialog.locator('.ptcPlusEntrySettings summary').click()
    const purpose = dialog.getByLabel('bindings.purpose', { exact: true })
    await purpose.fill('Unsaved purpose')
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
  process.stdout.write('fallback Client: viewport keyboard/pointer actions, composition draft, hover settlement, modal mask and focus return passed\n')
} finally {
  await browser.close()
}
