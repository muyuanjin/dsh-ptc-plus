import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { stringify } from 'yaml'
import { probeMarker, probeReason } from '../test/binding-web-adapter.js'
import { npmCliCommand } from './npm-cli.mjs'
import { extractPackFilename } from './npm-pack-filename.mjs'
import { hostToolRuntime, ptcToolsMode } from './dsh-host-contract.mjs'
import {
  TERMINATION_GRACE_MS,
  decodeSessionLog,
  formatHeadlessError,
  parseEvents,
  recordCleanupFailure,
  runProcess,
  snapshotSessionLogs,
  terminateProcessTree,
} from './headless-host.mjs'

let values = {}
let dshEntry
let ptcMode
let repository
let temporary
let evidence
let env
let host
let hostEnd
let browser
let page
const bindingMeasurements = []
const bindingScrollMeasurements = []
const replMeasurements = []
const reloadMeasurements = []
const dockMeasurements = []
const bindingWorkbenchEvidence = {}
let displayLogInvariant = false
const composerSelector = '[data-composer-seat] :is(textarea, [contenteditable=true])'

const composerValue = locator => locator.evaluate(element => 'value' in element ? element.value : element.textContent)

/**
 * Read a CodeMirror document from its rendered lines. innerText renders an empty line as a
 * <br> inside its own block, so every blank line contributes two breaks instead of one.
 */
const editorText = locator => locator.evaluate(element =>
  [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))

/**
 * Clear the composer with real input and confirm it took effect. An empty programmatic fill
 * types Delete into whatever holds focus, and dismissing the composer menu can restore focus
 * to the composer entry after the fill already selected the text, so the clear owns focus first.
 */
const clearComposer = async locator => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await locator.click()
    await locator.press('Control+a')
    await locator.press('Delete')
    if (await composerValue(locator) === '') return
  }
  assert.fail('The composer did not clear')
}

async function sessionLogBytes() {
  const files = await snapshotSessionLogs(join(env.DSH_HOME, 'sessions'))
  assert.ok(files.size > 0, 'No real session log was produced')
  return Promise.all([...files.keys()].sort().map(async file => [file, await decodeSessionLog(file)]))
}

async function verifyDock(label, width = 1440, height = 1000) {
  await page.setViewportSize({ width, height })
  if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
  const panel = page.locator('.ptcPlusBindingDock')
  await panel.waitFor()
  await panel.evaluate(async element => {
    let previous
    let stable = 0
    for (let frame = 0; frame < 120 && stable < 6; frame++) {
      await new Promise(requestAnimationFrame)
      const current = JSON.stringify(element.getBoundingClientRect().toJSON())
      stable = previous === current ? stable + 1 : 0
      previous = current
    }
    assertLayout: if (stable < 6) throw new Error('Dock layout did not settle')
  })
  const metrics = await panel.evaluate(element => {
    const body = element.querySelector('.ptcPlusBindingDockBody')
    const composer = document.querySelector('[data-composer-seat] :is(textarea, [contenteditable=true])')
    const bounds = node => node.getBoundingClientRect().toJSON()
    return { panel: bounds(element), composer: bounds(composer), viewport: { width: innerWidth, height: innerHeight },
      scrollMode: element.dataset.scroll,
      position: getComputedStyle(element).position, background: getComputedStyle(element).backgroundColor,
      shadow: getComputedStyle(element).boxShadow,
      anchor: bounds(element.parentElement),
      seat: bounds(document.querySelector('[data-composer-seat]')),
      scrollWidth: document.documentElement.scrollWidth,
      body: body ? { ...bounds(body), scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null,
      buttons: [...element.querySelectorAll('.ptcPlusBindingDockHead button,.ptcPlusBindingDockActions button')].map(button => {
        const rect = bounds(button)
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { ...rect, reachable: button.contains(hit), hit: hit?.outerHTML.slice(0, 350) }
      }) }
  })
  assert.ok(metrics.panel.bottom <= metrics.composer.top + 1, `${label}: dock is not above the input`)
  assert.equal(metrics.position, 'absolute', `${label}: review grows the composer mask`)
  assert.equal(metrics.anchor.height, 0, `${label}: review occupies transcript flow`)
  assert.ok(metrics.panel.bottom <= metrics.seat.top - 7, `${label}: review covers other composer content`)
  assert.notEqual(metrics.shadow, 'none', `${label}: floating review has no elevation`)
  assert.ok(!/rgba\(.*,[\s]*0\)|transparent/.test(metrics.background), `${label}: review background is transparent`)
  assert.ok(metrics.panel.top >= -1, `${label}: dock title is unreachable: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.composer.bottom <= height, `${label}: input is outside the viewport`)
  assert.ok(metrics.scrollWidth <= width, `${label}: document overflows horizontally`)
  if (metrics.scrollMode === 'panel') {
    metrics.buttons = []
    for (const button of await panel.locator('.ptcPlusBindingDockHead button,.ptcPlusBindingDockActions button').all()) {
      await button.focus()
      metrics.buttons.push(await button.evaluate(element => {
        const rect = element.getBoundingClientRect().toJSON()
        return { ...rect, reachable: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) }
      }))
    }
    await panel.evaluate(element => { element.scrollTop = 0 })
  }
  for (const button of metrics.buttons) {
    assert.ok(button.left >= 0 && button.right <= width + 1 && button.height >= 24 && button.bottom <= height && button.reachable,
      `${label}: action is unreachable: ${JSON.stringify(button)}`)
  }
  dockMeasurements.push({ label, ...metrics })
  await page.screenshot({ path: join(evidence, `dock-${label}-${width}-${height}.png`), animations: 'disabled' })
}

async function captureCandidateContext(owner, label, width, prompt = null) {
  await page.setViewportSize({ width, height: 1000 })
  const context = owner.locator('.ptcPlusCandidateContext')
  await context.scrollIntoViewIfNeeded()
  assert.equal(await context.locator('input,button,textarea').count(), 0, `${label}: read-only context contains form controls`)
  const text = context.locator('.ptcPlusCandidatePrompt dd')
  if (prompt === null) assert.equal(await text.getAttribute('data-empty'), 'true')
  else assert.equal(await text.textContent(), prompt)
  assert.equal(await context.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${label}: context overflows`)
  await context.screenshot({ path: join(evidence, `model-context-${label}-${width}.png`), animations: 'disabled' })
}

async function verifyWorkbenchReload(workbench, label) {
  await workbench.locator('.ptcPlusBindingEditor').waitFor()
  await page.waitForFunction(() => document.querySelector('.ptcPlusBindings')?.getAttribute('aria-busy') === 'false')
  const filename = join(env.DSH_HOME, 'ptc-plus', 'bindings.json')
  const original = JSON.parse(await readFile(filename, 'utf8'))
  const id = await workbench.locator('.ptcPlusEntrySettings input').first().inputValue()
  const entry = original.entries.find(entry => entry.id === id)
  assert.ok(entry)
  const externalSource = 'export function value(): number { return 202 }'
  const next = structuredClone(original)
  next.entries.find(entry => entry.id === id).source = externalSource
  await writeFile(filename, JSON.stringify(next, null, 2) + '\n')
  await workbench.getByRole('button', { name: 'Reload', exact: true }).click()
  await workbench.getByRole('status').filter({ hasText: 'Reloaded from disk.' }).waitFor()
  await workbench.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = workbench.locator('.ptcPlusSourceBody .cm-content')
  await editor.waitFor()
  assert.equal(await editorText(editor), externalSource)
  await workbench.getByRole('button', { name: 'Save', exact: true }).click()
  await workbench.getByRole('status').filter({ hasText: 'Entry saved' }).waitFor()
  const saved = JSON.parse(await readFile(filename, 'utf8'))
  assert.equal(saved.entries.find(entry => entry.id === id).source, externalSource)
  reloadMeasurements.push({ entry: label, source: externalSource, saved: true })
  await writeFile(filename, JSON.stringify(original, null, 2) + '\n')
  await workbench.getByRole('button', { name: 'Reload', exact: true }).click()
  await workbench.getByRole('status').filter({ hasText: 'Reloaded from disk.' }).waitFor()
}

async function verifyReplLayout(state) {
  await page.locator(composerSelector).waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.ptcPlusConsole [role=tab]').count(), 0)
  assert.equal(await page.locator('.ptcPlusConsole .ptcPlusSessionBindings').count(), 1)
  assert.equal(await page.locator('.ptcPlusConsole .ptcPlusBindings').count(), 1)
  const metrics = await page.locator('.ptcPlusConsole').evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const scroller = document.querySelector('[data-conversation-scroll]')
    const frame = scroller.getBoundingClientRect()
    const handles = [...document.querySelectorAll('[data-width-handle]')]
      .map(handle => ({ display: getComputedStyle(handle).display, height: handle.getBoundingClientRect().height }))
    const intercepted = []
    for (const x of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      for (const y of [0.25, 0.5, 0.85]) {
        const hit = document.elementFromPoint(bounds.left + bounds.width * x, bounds.top + bounds.height * y)
        if (!element.contains(hit)) intercepted.push({ x, y, hit: hit?.className })
      }
    }
    return { width: innerWidth, height: innerHeight, console: bounds.toJSON(), frame: frame.toJSON(),
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, handles, intercepted,
      draft: (() => {
        const input = document.querySelector('[data-composer-seat] :is(textarea, [contenteditable=true])')
        return 'value' in input ? input.value : input.textContent
      })() }
  })
  assert.ok(metrics.handles.every(handle => handle.display === 'none' && handle.height === 0),
    `${state}: transcript width handles remain active`)
  assert.deepEqual(metrics.intercepted, [], `${state}: host chrome intercepts the REPL view`)
  assert.ok(Math.abs(metrics.console.height - metrics.frame.height) <= 1, `${state}: REPL did not fill the view`)
  assert.ok(metrics.scrollHeight <= metrics.clientHeight + 1, `${state}: REPL escaped its scrollport`)
  assert.equal(metrics.draft, 'Unsent draft survives REPL navigation')
  replMeasurements.push({ state, ...metrics })
}

async function captureBindingScroll(state) {
  for (const fraction of [0, 0.5, 1]) {
    await page.locator('[data-conversation-scroll]').evaluate((element, fraction) => {
      element.scrollTop = fraction * (element.scrollHeight - element.clientHeight)
    }, fraction)
    await page.waitForTimeout(150)
    const metrics = await page.evaluate(() => {
      const scroller = document.querySelector('[data-conversation-scroll]')
      const composer = document.querySelector('[data-composer-seat]')
      const flow = document.querySelector('[data-chat-flow]')
      const bounds = element => {
        const { top, bottom, height } = element.getBoundingClientRect()
        return { top, bottom, height }
      }
      const overflowingAncestors = []
      for (let element = flow; element !== scroller; element = element.parentElement) {
        if (getComputedStyle(element).display === 'contents') continue
        if (element.scrollHeight > element.clientHeight + 1) overflowingAncestors.push(element.className)
      }
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentHeight: document.documentElement.scrollHeight,
        scroller: { ...bounds(scroller), topOffset: scroller.scrollTop,
          extent: scroller.scrollHeight - scroller.clientHeight },
        composer: { ...bounds(composer), position: getComputedStyle(composer).position },
        overflowingAncestors,
      }
    })
    const label = `${state}/${metrics.viewport.width}x${metrics.viewport.height}/${fraction}`
    assert.ok(metrics.documentHeight <= metrics.viewport.height + 1, `${label}: document overflow`)
    assert.equal(metrics.composer.position, 'sticky', `${label}: composer positioning changed`)
    assert.ok(Math.abs(metrics.composer.bottom - metrics.scroller.bottom) <= 1,
      `${label}: composer left the scrollport floor: ${JSON.stringify(metrics)}`)
    assert.deepEqual(metrics.overflowingAncestors, [], `${label}: transcript escaped its layout ancestors`)
    bindingScrollMeasurements.push({ state, fraction, ...metrics })
  }
}

async function verifyBindingScroll(rpc) {
  if (await page.locator('[data-turn-process]').count() === 0) {
    console.log('Host has no collapsible turn process; skipping process-disclosure layout checks')
    return
  }
  for (const mode of ['enhanced', 'native-tool', 'native-client']) {
    await rpc('settings/update', { ns: 'ptc-plus', patch: {
      enabled: mode !== 'native-client', enhancedToolView: mode === 'enhanced',
    } })
    await page.locator('.ptcPlusBindingCommand').waitFor({ state: mode === 'native-client' ? 'detached' : 'visible' })
    await page.locator('.ptcPlusTool').waitFor({ state: mode === 'enhanced' ? 'attached' : 'detached' })
    for (const [width, height] of [[390, 1000], [1440, 1000], [1440, 1200]]) {
      await page.setViewportSize({ width, height })
      if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
      const process = page.locator('[data-turn-process]').first()
      await process.waitFor()
      const source = page.locator('.ptcPlusBindingSourceDetails').first()
      const states = mode === 'native-client' ? [[false, false], [true, false], [false, false]]
        : [[false, false], [true, false], [true, true], [true, false], [false, false]]
      for (const [processOpen, sourceOpen] of states) {
        if ((await process.getAttribute('aria-expanded') === 'true') !== processOpen) await process.click()
        if (mode !== 'native-client' && (await source.getAttribute('open') !== null) !== sourceOpen) {
          await source.locator('summary').click()
        }
        await captureBindingScroll(`${mode}/process-${processOpen}/source-${sourceOpen}`)
      }
    }
  }
  assert.ok(bindingScrollMeasurements.some(item => item.scroller.extent > 0), 'Scroll fixture never overflowed')
  const desktop = bindingScrollMeasurements.filter(item => item.viewport.width === 1440 && item.viewport.height === 1200)
  assert.ok(desktop.some(item => item.state === 'enhanced/process-false/source-false' && item.scroller.extent === 0),
    'Collapsed desktop fixture did not fit the scrollport')
  assert.ok(desktop.some(item => item.state === 'enhanced/process-true/source-false' && item.scroller.extent > 0),
    'Process disclosure did not cross the desktop scroll boundary')
  await rpc('settings/update', { ns: 'ptc-plus', patch: { enabled: true, enhancedToolView: true } })
  await page.locator('.ptcPlusBindingCommand').waitFor()
}

async function captureBinding(state, width = 1440) {
  await page.setViewportSize({ width, height: 1000 })
  if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
  await page.evaluate(async () => {
    let previous
    let stable = 0
    for (let frame = 0; frame < 120 && stable < 4; frame++) {
      await new Promise(requestAnimationFrame)
      const boxes = JSON.stringify([...document.querySelectorAll('.ptcPlusBindingCommand')]
        .map(element => element.getBoundingClientRect().toJSON()))
      stable = boxes === previous ? stable + 1 : 0
      previous = boxes
    }
    if (stable < 4) throw new Error('Binding layout did not settle')
  })
  const cards = await page.locator('.ptcPlusBindingCommand').evaluateAll(elements => elements.map(element => {
    const bounds = node => {
      const { left, right, width, height } = node.getBoundingClientRect()
      return { left, right, width, height }
    }
    return { phase: element.dataset.phase, bounds: bounds(element), client: element.clientWidth,
      scroll: element.scrollWidth, buttons: [...element.querySelectorAll('button')].filter(button => button.getClientRects().length > 0).map(button => ({
        text: button.textContent, bounds: bounds(button), owner: bounds(button.parentElement),
        action: button.closest('.ptcPlusBindingCommandActions') !== null,
      })) }
  }))
  assert.ok(cards.length > 0)
  for (const card of cards) {
    assert.ok(card.bounds.width >= 200 && card.bounds.left >= 0 && card.bounds.right <= width + 1,
      `${state}/${width}: squeezed card ${JSON.stringify(card.bounds)}`)
    assert.ok(card.scroll <= card.client + 1, `${state}/${width}: card overflow`)
    for (const button of card.buttons) {
      assert.ok(button.bounds.width > 0 && button.bounds.height >= (button.action ? 24 : 16), `unusable button: ${button.text}`)
      assert.ok(button.bounds.left >= button.owner.left - 1 && button.bounds.right <= button.owner.right + 1,
        `${state}/${width}: button outside owner: ${button.text}`)
    }
  }
  const headerCollisions = await page.locator('.ptcPlusActive').evaluate(indicator => {
    const own = indicator.getBoundingClientRect()
    return [...document.querySelectorAll('button')].filter(button => {
      if (button === indicator) return false
      const rect = button.getBoundingClientRect()
      if (!(rect.width > 0 && rect.height > 0 && rect.left < own.right - 1 && rect.right > own.left + 1
        && rect.top < own.bottom - 1 && rect.bottom > own.top + 1)) return false
      // Scrolled history may have overlapping bounds while clipped out by its scrollport.
      const hit = document.elementFromPoint((Math.max(rect.left, own.left) + Math.min(rect.right, own.right)) / 2,
        (Math.max(rect.top, own.top) + Math.min(rect.bottom, own.bottom)) / 2)
      return button.contains(hit)
    }).map(button => button.textContent)
  })
  assert.deepEqual(headerCollisions, [], `${state}/${width}: overlapping session header actions`)
  if (width <= 560) {
    assert.equal(await page.locator('.ptcPlusActive').isVisible(), false)
    const unreachable = await page.locator('.ptcPlusActive').evaluate(indicator =>
      [...indicator.closest('header').querySelectorAll('button')].filter(button => {
        const rect = button.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !button.disabled
          && !button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      }).map(button => button.getAttribute('aria-label') || button.textContent))
    assert.deepEqual(unreachable, [], `${state}/${width}: native header action is unreachable`)
  }
  await page.screenshot({ path: join(evidence, `binding-${state}-${width}.png`), fullPage: true, animations: 'disabled' })
  bindingMeasurements.push({ state, width, cards })
}

const workbenchModal = () => page.locator('.ptcPlusBindingsModal')

/** Read the document the Host store persists for Global User Bindings. */
async function readStoredBindings() {
  return JSON.parse(await readFile(join(env.DSH_HOME, 'ptc-plus', 'bindings.json'), 'utf8'))
}

/** Poll the persisted document from outside the browser so a hidden completion stays observable. */
async function waitForStoredBinding(id, present, label) {
  const deadline = Date.now() + 15000
  for (;;) {
    const stored = await readStoredBindings()
    if (stored.entries.some(entry => entry.id === id) === present) return stored
    if (Date.now() > deadline) {
      throw new Error(`${label}: stored binding ${JSON.stringify(id)} did not reach present=${present}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Record every Global User Binding Remote call with the payload it carried. */
function recordBindingCalls() {
  const calls = []
  const listener = request => {
    if (!request.url().endsWith('/api/ptcPlusBindings/invoke')) return
    const args = request.postDataJSON()?.payload?.args
    if (typeof args?.operation !== 'string') return
    calls.push({ operation: args.operation, payload: args.payload ?? null })
  }
  page.on('request', listener)
  return { calls, stop: () => page.off('request', listener) }
}

/**
 * Invoke one binding Remote operation exactly as the Host's authenticated client does.
 * The Remote result envelope wraps the owner's own result, so the transport envelope is
 * unwrapped once here the same way the Host client does before it reads ok/value/error.
 */
async function invokeBindingOperation(operation, payload) {
  return page.evaluate(async ({ operation, payload }) => {
    const method = 'ptcPlusBindings/invoke'
    const response = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method,
        payload: { args: { operation, payload } } }),
    })
    const envelope = (await response.json()).result
    return envelope.ok === true ? envelope.value : envelope
  }, { operation, payload })
}

/**
 * Select the public Chat view, which owns the composer entry the workbench opens from.
 * A REPL election leaves the composer chain mounted but hidden, so the entry must be
 * brought back through the same public navigation a user has before it is used.
 */
async function showChatComposer() {
  const composer = page.locator(composerSelector)
  if (await composer.isVisible()) return composer
  const chat = page.getByRole('tab', { name: /^(Chat|对话)$/ })
  assert.ok(await chat.count() > 0, 'The public Chat view is unavailable, so its composer entry cannot be reached')
  await chat.click()
  await composer.waitFor({ state: 'visible' })
  return composer
}

/**
 * Switch the session view while the workbench dialog is open. The Host dialog is modal: its own
 * full-viewport mask owns the pointer over the view bar, so a pointer cannot reach the tab while
 * the dialog is open. The switch is dispatched on the real tab element — the same Host handler a
 * pointer reaches once the dialog is closed — and the blocking element is recorded, not assumed.
 * The plugin's own management dialog is that modal, so it covers the view bar by design; only an
 * unrelated plugin surface over the view bar is a defect.
 */
async function switchViewThroughDialog(name) {
  const tab = page.getByRole('tab', { name, exact: true })
  const blocker = await tab.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return { missing: true }
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
    if (hit === null || element.contains(hit)) return null
    const className = typeof hit.className === 'string' ? hit.className : ''
    return { tag: hit.tagName, className, plugin: /ptcPlus/.test(className),
      managementDialog: hit.closest?.('.ptcPlusBindingsModal') !== null }
  })
  assert.notEqual(blocker?.missing, true, `The ${name} view tab has no layout box`)
  if (blocker === null) {
    await tab.click()
    return null
  }
  assert.ok(blocker.plugin === false || blocker.managementDialog === true,
    `An unrelated plugin surface covers the ${name} view tab: ${JSON.stringify(blocker)}`)
  await tab.evaluate(element => element.click())
  return blocker
}

/** Open the workbench from the public composer menu and wait for its auto-loaded draft. */
async function openBindingWorkbench() {
  await showChatComposer()
  await page.locator('.ptcPlusAuthorButton').hover()
  await page.getByRole('menuitem', { name: 'Manage global bindings', exact: true }).click()
  await workbenchModal().waitFor()
  await page.waitForFunction(() => {
    const surface = document.querySelector('.ptcPlusBindingsModal .ptcPlusBindings')
    return surface?.getAttribute('aria-busy') === 'false'
      && surface.querySelector('.ptcPlusBindingEditor') !== null
  })
  return workbenchModal()
}

/**
 * A new draft is saved against the catalog revision it was created from, so creation must
 * wait for a confirmed revision instead of starting a draft whose save baseline is null.
 * The Host is held on every catalog read while the workbench opens, which is the real
 * first-load latency a user sees; releasing it must make creation available immediately.
 */
async function verifyDeferredFirstCatalog() {
  await showChatComposer()
  let release
  const held = new Promise(resolve => { release = resolve })
  const routePattern = '**/api/ptcPlusBindings/invoke'
  const handler = async route => {
    if (route.request().postDataJSON()?.payload?.args?.operation === 'list') await held
    await route.continue()
  }
  // A held read is only proven held while no answer for it has been seen, so the
  // answers are counted rather than assumed.
  let answered = 0
  const countAnswer = response => {
    if (!response.url().endsWith('/api/ptcPlusBindings/invoke')) return
    if (response.request().postDataJSON()?.payload?.args?.operation === 'list') answered += 1
  }
  page.on('response', countAnswer)
  await page.route(routePattern, handler)
  try {
    const catalogRequested = page.waitForRequest(request => request.url().endsWith('/api/ptcPlusBindings/invoke')
      && request.postDataJSON()?.payload?.args?.operation === 'list')
    await page.locator('.ptcPlusAuthorButton').hover()
    await page.getByRole('menuitem', { name: 'Manage global bindings', exact: true }).click()
    await workbenchModal().waitFor()
    const workbench = workbenchModal().locator('.ptcPlusBindings')
    const newEntry = workbench.getByRole('button', { name: 'New entry', exact: true })
    await catalogRequested
    assert.equal(answered, 0, 'The first catalog read was answered while the Host still held it')
    assert.equal(await newEntry.isDisabled(), true,
      'New entry is available before the first catalog read confirms a revision')
    assert.equal(await workbench.locator('.ptcPlusBindingEditor').count(), 0,
      'A draft started before the catalog revision was confirmed')
    release()
    await page.waitForFunction(() => {
      const surface = document.querySelector('.ptcPlusBindingsModal .ptcPlusBindings')
      return surface?.getAttribute('aria-busy') === 'false'
        && surface.querySelector('.ptcPlusBindingEditor') !== null
    })
    assert.equal(await newEntry.isDisabled(), false,
      'New entry stayed unavailable after the catalog revision was confirmed')
    bindingWorkbenchEvidence.deferredCatalog = { heldWhileLoading: true, disabledWhileLoading: true,
      enabledAfterCatalog: true }
    await closeBindingWorkbench()
  } finally {
    release()
    await page.unroute(routePattern, handler)
    page.off('response', countAnswer)
  }
}

/** Load one stored entry so a check starts from the same draft whatever the previous one left. */
async function focusStoredBinding(workbench, id) {
  const cancel = workbench.getByRole('button', { name: 'Cancel', exact: true })
  if (await cancel.count() > 0) await cancel.click()
  await workbench.getByRole('button', { name: `${id} namespace`, exact: true }).click()
  await page.waitForFunction(expected => {
    const surface = document.querySelector('.ptcPlusBindingsModal .ptcPlusBindings')
    return surface?.getAttribute('aria-busy') === 'false'
      && surface.querySelector('.ptcPlusEntrySettings input')?.value === expected
  }, id)
}

/** Read the element that owns focus, so a close can assert a live keyboard target. */
async function readFocusTarget() {
  return page.evaluate(() => {
    const active = document.activeElement
    const target = active !== null && active !== document.body
    return {
      tag: active?.tagName ?? null,
      role: active?.getAttribute?.('role') ?? null,
      label: active?.getAttribute?.('aria-label') ?? null,
      className: typeof active?.className === 'string' ? active.className : null,
      text: active?.textContent?.trim().slice(0, 40) ?? null,
      composerEntry: active?.matches?.('.ptcPlusAuthorButton') ?? false,
      chatTab: active?.matches?.('[role=tab]') === true && /^(Chat|对话)$/.test(active.textContent.trim()),
      body: !target,
      connected: target && active.isConnected,
      visible: target && active.getClientRects().length > 0,
      enabled: target && !active.matches(':disabled, [aria-disabled="true"]'),
      keyboardTarget: target && (active.tabIndex >= 0 || active.isContentEditable === true),
      hiddenAncestor: target && active.closest('[hidden], [inert], [aria-hidden="true"]') !== null,
    }
  })
}

/** The focus targets an explicit close may return to, and how each one is recognised. */
const closeFocusExpectations = {
  composerEntry: {
    label: 'the public composer entry the workbench was opened from',
    matches: focus => focus.composerEntry === true,
  },
  chatTab: {
    label: 'the Chat view tab that reopened the workbench',
    matches: focus => focus.chatTab === true,
  },
  liveTarget: {
    label: 'a live visible enabled connected keyboard target',
    matches: focus => focus.body === false && focus.connected === true && focus.visible === true
      && focus.enabled === true && focus.keyboardTarget === true && focus.hiddenAncestor === false,
  },
}

/**
 * Close the workbench and prove the explicit close returned focus to a live keyboard target.
 * The plugin's BindingsDialog owns focus restoration (src/client-workbench.js): the Host Modal
 * renders and positions the dialog but restores no focus of its own. The dialog remembers the
 * element that owned focus when it appeared, so a composer-menu open returns to the public
 * composer entry and a dialog reopened from the Chat view returns to that view tab. A Host
 * approval that hid the dialog must still leave a live, visible, enabled, connected keyboard
 * target rather than the document body.
 */
async function closeBindingWorkbench(expect = 'composerEntry') {
  const expectation = closeFocusExpectations[expect]
  await workbenchModal().getByRole('button', { name: 'Close global bindings workbench' }).click()
  await workbenchModal().waitFor({ state: 'detached' })
  const deadline = Date.now() + 5000
  let focus = await readFocusTarget()
  while (!expectation.matches(focus) && Date.now() < deadline) {
    await page.waitForTimeout(50)
    focus = await readFocusTarget()
  }
  assert.ok(expectation.matches(focus),
    `An explicit close did not return focus to ${expectation.label}: ${JSON.stringify(focus)}`)
  return focus
}

/**
 * The workbench addresses stored entries by identity. Creating an entry whose id already
 * exists keeps both the stored document and the user's draft; editing a stored entry saves
 * against the entry it was loaded from; and the Host rejects a forged identity even when the
 * Client form is bypassed.
 */
async function verifyBindingSaveIntent() {
  const file = join(env.DSH_HOME, 'ptc-plus', 'bindings.json')
  const originalText = await readFile(file, 'utf8')
  const original = JSON.parse(originalText)
  const stored = original.entries.find(entry => entry.id === 'workflow')
  assert.ok(stored !== undefined, 'The binding workflow fixture is missing from the stored document')
  const updateSource = 'export function value(): number { return 61 }'
  const duplicateSource = 'export function value(): number { return 62 }'
  const observed = { storedId: stored.id, update: null, duplicate: null, forged: {}, restored: false }
  const modal = await openBindingWorkbench()
  const workbench = modal.locator('.ptcPlusBindings')
  await focusStoredBinding(workbench, 'workflow')
  const idInput = workbench.locator('.ptcPlusEntrySettings input').first()
  const nameInput = workbench.locator('.ptcPlusEntrySettings input').nth(1)
  const editor = workbench.locator('.ptcPlusSourceBody .cm-content')
  // A stored entry is addressed by this id; only a new draft may choose one.
  assert.equal(await idInput.inputValue(), 'workflow')
  assert.equal(await idInput.isDisabled(), true, 'A stored binding id is editable in the workbench form')
  await workbench.getByRole('button', { name: 'Edit', exact: true }).click()
  await editor.waitFor()
  assert.equal(await editorText(editor), stored.source)
  await editor.fill(updateSource)
  const updateCalls = recordBindingCalls()
  try {
    await workbench.getByRole('button', { name: 'Save', exact: true }).click()
    await workbench.getByRole('status').filter({ hasText: 'Entry saved' }).waitFor()
  } finally {
    updateCalls.stop()
  }
  const update = updateCalls.calls.filter(call => call.operation === 'save').at(-1)
  assert.ok(update !== undefined, 'Saving an edited stored entry sent no save request')
  assert.equal(update.payload.intent, 'update')
  assert.equal(update.payload.originalId, 'workflow')
  assert.equal(update.payload.entry.id, 'workflow')
  assert.ok(Number.isSafeInteger(update.payload.expectedRevision))
  observed.update = { intent: update.payload.intent, originalId: update.payload.originalId,
    id: update.payload.entry.id, expectedRevision: update.payload.expectedRevision }
  const updated = await readStoredBindings()
  assert.equal(updated.entries.length, original.entries.length, 'Editing a stored entry changed the entry count')
  assert.equal(updated.entries.find(entry => entry.id === 'workflow').source, updateSource)
  await workbench.getByRole('button', { name: 'New entry', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ptcPlusBindingsModal .ptcPlusEntrySettings input')?.disabled === false)
  assert.equal(await idInput.inputValue(), '', 'A new draft started with a pre-filled id')
  await editor.fill(duplicateSource)
  await idInput.fill('workflow')
  await nameInput.fill('workflowTools')
  const duplicateCalls = recordBindingCalls()
  try {
    await workbench.getByRole('button', { name: 'Save', exact: true }).click()
    await workbench.getByRole('status').filter({ hasText: 'already exists' }).waitFor()
  } finally {
    duplicateCalls.stop()
  }
  const create = duplicateCalls.calls.filter(call => call.operation === 'save').at(-1)
  assert.ok(create !== undefined, 'A duplicate create sent no save request')
  assert.equal(create.payload.intent, 'create')
  assert.equal(create.payload.originalId, null)
  assert.equal(create.payload.entry.id, 'workflow')
  assert.equal(await idInput.inputValue(), 'workflow', 'A rejected duplicate draft lost its id')
  assert.equal(await nameInput.inputValue(), 'workflowTools', 'A rejected duplicate draft lost its name')
  assert.equal(await editorText(editor), duplicateSource, 'A rejected duplicate draft lost its source')
  assert.equal(await workbench.getByRole('button', { name: 'Save', exact: true }).count(), 1,
    'A rejected duplicate draft left the editing state')
  observed.duplicate = { intent: create.payload.intent, originalId: create.payload.originalId,
    id: create.payload.entry.id, message: await workbench.locator('.ptcPlusWorkbenchFeedback').innerText() }
  const afterDuplicate = await readStoredBindings()
  assert.equal(afterDuplicate.entries.length, original.entries.length, 'A rejected duplicate create added an entry')
  assert.equal(afterDuplicate.entries.find(entry => entry.id === 'workflow').source, updateSource,
    'A rejected duplicate create overwrote the stored entry')
  // The Host owns identity, not the form: a forged write is rejected with the same rules.
  const listed = await invokeBindingOperation('list', {})
  assert.equal(listed.ok, true, 'Reading the binding catalog through the Host failed')
  const revision = listed.value.revision
  const forged = { id: 'workflow', name: 'workflowTools', scope: 'namespace', symbols: ['value'],
    purpose: '', enabled: false, source: duplicateSource }
  const forgedCreate = await invokeBindingOperation('save', { intent: 'create', originalId: null,
    entry: forged, expectedRevision: revision })
  assert.equal(forgedCreate.ok, false, 'The Host accepted a create for an existing id')
  assert.match(forgedCreate.error.message, /already exists/)
  const forgedRename = await invokeBindingOperation('save', { intent: 'update', originalId: 'other-entry',
    entry: forged, expectedRevision: revision })
  assert.equal(forgedRename.ok, false, 'The Host accepted an update for a different original id')
  assert.match(forgedRename.error.message, /original id/)
  const forgedMissing = await invokeBindingOperation('save', { intent: 'update', originalId: 'missing-entry',
    entry: { ...forged, id: 'missing-entry', name: 'missingTools' }, expectedRevision: revision })
  assert.equal(forgedMissing.ok, false, 'The Host accepted an update for a missing entry')
  assert.match(forgedMissing.error.message, /does not exist/)
  observed.forged = { create: forgedCreate.error.message, rename: forgedRename.error.message,
    missing: forgedMissing.error.message }
  assert.deepEqual(await readStoredBindings(), afterDuplicate, 'A rejected Host write changed the stored document')
  await writeFile(file, originalText)
  await workbench.getByRole('button', { name: 'Reload', exact: true }).click()
  await workbench.getByRole('status').filter({ hasText: 'Catalog reloaded' }).waitFor()
  assert.deepEqual(await readStoredBindings(), original, 'Restoring the stored binding document failed')
  observed.restored = true
  await focusStoredBinding(workbench, 'workflow')
  await closeBindingWorkbench()
  bindingWorkbenchEvidence.saveIntent = observed
}

/**
 * Draft form text is data, not document identity. Retyping the id of a new draft keeps
 * the same CodeMirror documents, the live selection, the undo history and the temporary
 * console environment. Ending that new draft must equally keep the stored entry it returns
 * to on one identity, so a later reload or cancel reuses the same console document and
 * environment instead of rebuilding the console and releasing its temporary state.
 */
async function verifyBindingDocumentIdentity() {
  const observed = { draftId: 'sampleIdentity', draftName: 'helperTools', runs: 0, releases: 0 }
  const modal = await openBindingWorkbench()
  const workbench = modal.locator('.ptcPlusBindings')
  await focusStoredBinding(workbench, 'workflow')
  // New -> Cancel -> the stored entry again, then run the console and exercise both
  // transitions that must not be mistaken for a different document.
  await workbench.getByRole('button', { name: 'New entry', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ptcPlusBindingsModal .ptcPlusEntrySettings input')?.disabled === false)
  await workbench.getByRole('button', { name: 'Cancel', exact: true }).click()
  await focusStoredBinding(workbench, 'workflow')
  const storedConsole = workbench.locator('.ptcPlusExecution')
  if (await storedConsole.getAttribute('open') === null) await storedConsole.locator('summary').click()
  const storedConsoleInput = workbench.locator('.ptcPlusExecutionInput .cm-content')
  await storedConsoleInput.fill('value()')
  const storedCalls = recordBindingCalls()
  try {
    await storedConsoleInput.press('ControlOrMeta+Enter')
    await workbench.locator('.ptcPlusExecutionOutput').last().filter({ hasText: '43' }).waitFor()
    const storedSource = storedCalls.calls.find(call => call.operation === 'console-run').payload.source
    // Mark the live console document so a rebuilt editor is observable.
    await page.evaluate(() => {
      document.querySelector('.ptcPlusBindingsModal .ptcPlusExecutionInput .cm-content')
        .dataset.ptcSmokeDocument = 'stored-console'
    })
    const storedConsoleState = () => page.evaluate(() => ({
      document: document.querySelector('.ptcPlusBindingsModal .ptcPlusExecutionInput .cm-content')
        ?.dataset.ptcSmokeDocument ?? null,
      records: document.querySelectorAll('.ptcPlusBindingsModal .ptcPlusExecutionRecord').length,
    }))
    await workbench.getByRole('button', { name: 'Reload', exact: true }).click()
    await workbench.getByRole('status').filter({ hasText: 'Reloaded from disk.' }).waitFor()
    assert.deepEqual(await storedConsoleState(), { document: 'stored-console', records: 1 },
      'Reloading the unchanged entry rebuilt the console document or lost its history')
    await workbench.getByRole('button', { name: 'Edit', exact: true }).click()
    await workbench.locator('.ptcPlusSourceBody .cm-content').waitFor()
    assert.equal(await editorText(workbench.locator('.ptcPlusSourceBody .cm-content')), storedSource,
      'Editing after a canceled new draft did not open the stored source')
    await workbench.getByRole('button', { name: 'Cancel', exact: true }).click()
    await workbench.getByRole('button', { name: 'Edit', exact: true }).waitFor()
    assert.deepEqual(await storedConsoleState(), { document: 'stored-console', records: 1 },
      'Canceling the unchanged entry rebuilt the console document or lost its history')
    // The temporary environment is still live: the next run continues it.
    await storedConsoleInput.fill('value() + 1')
    await storedConsoleInput.press('ControlOrMeta+Enter')
    await workbench.locator('.ptcPlusExecutionOutput').last().filter({ hasText: '44' }).waitFor()
    assert.doesNotMatch(await workbench.locator('.ptcPlusExecutionHistory').innerText(),
      /Started again from the current draft/, 'The console restarted instead of reusing its environment')
  } finally {
    storedCalls.stop()
  }
  const storedRuns = storedCalls.calls.filter(call => call.operation === 'console-run')
  const storedReleases = storedCalls.calls.filter(call => call.operation === 'console-release')
  assert.equal(storedRuns.length, 2, `Expected one console run per evaluation, saw ${storedRuns.length}`)
  assert.equal(storedRuns[0].payload.environment, undefined, 'The first console run reused an environment')
  assert.ok(typeof storedRuns[1].payload.environment === 'string' && storedRuns[1].payload.environment !== '',
    'Ending the new draft released the console environment')
  assert.equal(storedReleases.length, 0, 'Ending the new draft released the console environment')
  observed.creating = { document: 'stored-console', records: 1, runs: storedRuns.length,
    releases: storedReleases.length, reusedEnvironment: true }
  await workbench.getByRole('button', { name: 'New entry', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ptcPlusBindingsModal .ptcPlusEntrySettings input')?.disabled === false)
  const idInput = workbench.locator('.ptcPlusEntrySettings input').first()
  const nameInput = workbench.locator('.ptcPlusEntrySettings input').nth(1)
  const sourceEditor = workbench.locator('.ptcPlusSourceBody .cm-content')
  const source = 'export function helper(): number { return 7 }'
  await sourceEditor.waitFor()
  await sourceEditor.fill(source)
  await nameInput.fill(observed.draftName)
  const consolePane = workbench.locator('.ptcPlusExecution')
  if (await consolePane.getAttribute('open') === null) await consolePane.locator('summary').click()
  const consoleInput = workbench.locator('.ptcPlusExecutionInput .cm-content')
  await consoleInput.fill('helper()')
  const calls = recordBindingCalls()
  try {
    await consoleInput.press('ControlOrMeta+Enter')
    await workbench.locator('.ptcPlusExecutionOutput').last().filter({ hasText: '7' }).waitFor()
    // Mark the two live editors so a rebuilt document is observable.
    await page.evaluate(() => {
      const modal = document.querySelector('.ptcPlusBindingsModal')
      modal.querySelector('.ptcPlusSourceBody .cm-content').dataset.ptcSmokeDocument = 'source'
      modal.querySelector('.ptcPlusExecutionInput .cm-content').dataset.ptcSmokeDocument = 'console'
    })
    // A real edit leaves an undo step that a rebuilt editor would not have.
    await sourceEditor.click()
    await sourceEditor.press('ControlOrMeta+End')
    await page.keyboard.type('X')
    await page.waitForTimeout(700)
    await page.keyboard.press('Shift+ArrowLeft')
    observed.selection = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    assert.equal(observed.selection, 'X', 'CodeMirror selection is not observable in the DOM')
    // Form text is data: a synthetic input event must not rebuild either document.
    const synthetic = await page.evaluate(() => {
      const input = document.querySelector('.ptcPlusBindingsModal .ptcPlusEntrySettings input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, `${input.value}x`)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })
    assert.equal(synthetic, 'x')
    await page.waitForTimeout(100)
    assert.equal(await idInput.inputValue(), 'x', 'A synthetic draft id edit did not reach React state')
    const afterSynthetic = await page.evaluate(() => {
      const modal = document.querySelector('.ptcPlusBindingsModal')
      return { active: document.activeElement?.className ?? '', selection: window.getSelection()?.toString() ?? '',
        source: modal.querySelector('.ptcPlusSourceBody .cm-content')?.dataset.ptcSmokeDocument,
        console: modal.querySelector('.ptcPlusExecutionInput .cm-content')?.dataset.ptcSmokeDocument }
    })
    assert.equal(afterSynthetic.selection, 'X', 'Typing the draft id dropped the CodeMirror selection')
    assert.match(afterSynthetic.active, /cm-content/, 'Typing the draft id moved focus out of the editor')
    assert.equal(afterSynthetic.source, 'source', 'Typing the draft id rebuilt the source document')
    assert.equal(afterSynthetic.console, 'console', 'Typing the draft id rebuilt the console document')
    // Real keystrokes into the required id keep the same two documents.
    await idInput.click()
    await idInput.press('ControlOrMeta+a')
    await idInput.pressSequentially(observed.draftId)
    assert.equal(await idInput.inputValue(), observed.draftId)
    const afterTyping = await page.evaluate(() => {
      const modal = document.querySelector('.ptcPlusBindingsModal')
      return { source: modal.querySelector('.ptcPlusSourceBody .cm-content')?.dataset.ptcSmokeDocument,
        console: modal.querySelector('.ptcPlusExecutionInput .cm-content')?.dataset.ptcSmokeDocument }
    })
    assert.deepEqual(afterTyping, { source: 'source', console: 'console' })
    // The undo history survived: the stray edit is still undoable.
    await sourceEditor.click()
    await sourceEditor.press('ControlOrMeta+z')
    assert.equal(await editorText(sourceEditor), source, 'Draft id typing dropped the CodeMirror undo history')
    // The console environment survived: the second run reuses it without a restart.
    await consoleInput.fill('helper() + 1')
    await consoleInput.press('ControlOrMeta+Enter')
    await workbench.locator('.ptcPlusExecutionOutput').last().filter({ hasText: '8' }).waitFor()
    assert.doesNotMatch(await workbench.locator('.ptcPlusExecutionHistory').innerText(),
      /Started again from the current draft/, 'The console restarted instead of reusing its environment')
  } finally {
    calls.stop()
  }
  const runs = calls.calls.filter(call => call.operation === 'console-run')
  const releases = calls.calls.filter(call => call.operation === 'console-release')
  assert.equal(runs.length, 2, `Expected one console run per evaluation, saw ${runs.length}`)
  assert.equal(runs[0].payload.environment, undefined, 'The first console run reused an environment')
  assert.ok(typeof runs[1].payload.environment === 'string' && runs[1].payload.environment !== '',
    'Typing the draft id released the console environment')
  assert.equal(releases.length, 0, 'Typing the draft id released the console environment')
  observed.runs = runs.length
  observed.releases = releases.length
  observed.reusedEnvironment = true
  observed.undoRestored = true
  await focusStoredBinding(workbench, 'workflow')
  await closeBindingWorkbench()
  bindingWorkbenchEvidence.documentIdentity = observed
}

/**
 * The workbench dialog follows the public composer, but the draft does not. A takeover by
 * the REPL view hides the dialog while the mounted author surface keeps the draft and a pending
 * save; an explicit close ends the management session, restores focus and releases the console.
 * The dialog is a Host modal whose mask owns the pointer over the view bar, so the view switch is
 * dispatched on the real tab element and the blocking element is recorded as evidence.
 */
async function verifyWorkbenchDraftTakeover() {
  const observed = { logInvariant: false, navigation: null, pendingSave: null, explicitClose: null }
  const beforeWorkbench = await sessionLogBytes()
  const modal = await openBindingWorkbench()
  const workbench = modal.locator('.ptcPlusBindings')
  await focusStoredBinding(workbench, 'workflow')
  const idInput = workbench.locator('.ptcPlusEntrySettings input').first()
  const nameInput = workbench.locator('.ptcPlusEntrySettings input').nth(1)
  const editor = workbench.locator('.ptcPlusSourceBody .cm-content')
  const draft = { id: 'sampleIdentity', name: 'helperTools', source: 'export function value(): number { return 71 }' }
  await workbench.getByRole('button', { name: 'New entry', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ptcPlusBindingsModal .ptcPlusEntrySettings input')?.disabled === false)
  await editor.fill(draft.source)
  await idInput.fill(draft.id)
  await nameInput.fill(draft.name)
  // A REPL view election takes over the Host composer chain; the composer bar stays mounted
  // inside the Host's overlay fallback, so the author surface and its controller stay alive.
  const viewBlocker = await switchViewThroughDialog('REPL')
  await page.locator('.ptcPlusConsole').waitFor()
  await modal.waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-chain-overlay-fallback="conversation.composer"]')
    .evaluate(element => getComputedStyle(element).display), 'none', 'The REPL view did not take over the Host composer chain')
  assert.equal(await page.locator('.ptcPlusAuthorButton').count(), 1,
    'The author surface unmounted, so a hidden draft could not be observed')
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await modal.waitFor()
  await page.waitForFunction(expected => {
    const node = document.querySelector('.ptcPlusBindingsModal .ptcPlusSourceBody .cm-content')
    return node !== null && [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n') === expected
  }, draft.source)
  assert.equal(await idInput.inputValue(), draft.id, 'The unsaved draft id did not survive REPL navigation')
  assert.equal(await nameInput.inputValue(), draft.name, 'The unsaved draft name did not survive REPL navigation')
  assert.equal(await editorText(editor), draft.source, 'The unsaved draft source did not survive REPL navigation')
  observed.navigation = { id: draft.id, name: draft.name, survived: true, viewBlocker }
  // A save that is still in flight completes while the dialog is hidden.
  const calls = recordBindingCalls()
  let release
  const held = new Promise(resolve => { release = resolve })
  const routePattern = '**/api/ptcPlusBindings/invoke'
  const handler = async route => {
    if (route.request().postDataJSON()?.payload?.args?.operation === 'save') await held
    await route.continue()
  }
  await page.route(routePattern, handler)
  try {
    const saveRequested = page.waitForRequest(request => request.url().endsWith('/api/ptcPlusBindings/invoke')
      && request.postDataJSON()?.payload?.args?.operation === 'save')
    await workbench.getByRole('button', { name: 'Save', exact: true }).click()
    await saveRequested
    await page.waitForFunction(() => document.querySelector('.ptcPlusBindingsModal .ptcPlusBindings')
      ?.getAttribute('aria-busy') === 'true')
    assert.equal((await readStoredBindings()).entries.some(entry => entry.id === draft.id), false,
      'The held save reached the stored document before the Host answered')
    const saveViewBlocker = await switchViewThroughDialog('REPL')
    await modal.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.ptcPlusAuthorButton').count(), 1,
      'The author surface unmounted, so a hidden save completion could not be observed')
    await page.waitForTimeout(300)
    assert.equal((await readStoredBindings()).entries.some(entry => entry.id === draft.id), false,
      'The pending save reached the stored document while the Host still held the request')
    release()
    await waitForStoredBinding(draft.id, true, 'pending save')
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    await modal.waitFor()
    assert.equal(await workbench.getByRole('button', { name: 'Save', exact: true }).count(), 0,
      'The completed hidden save left the draft editable')
    assert.equal(await idInput.inputValue(), draft.id)
    assert.equal(await workbench.locator('.ptcPlusWorkbenchFeedback').innerText(),
      'Entry saved; it takes effect from the next run_code request.')
    const saves = calls.calls.filter(call => call.operation === 'save')
    assert.equal(saves.length, 1, `Expected exactly one save request, saw ${saves.length}`)
    assert.equal(saves[0].payload.intent, 'create')
    observed.pendingSave = { id: draft.id, intent: saves[0].payload.intent, saves: saves.length,
      completedHidden: true, expectedRevision: saves[0].payload.expectedRevision, viewBlocker: saveViewBlocker }
    await workbench.getByRole('button', { name: 'Remove', exact: true }).click()
    await waitForStoredBinding(draft.id, false, 'draft cleanup')
  } finally {
    release()
    await page.unroute(routePattern, handler)
    calls.stop()
  }
  // An explicit close ends the management session: focus returns, the live console environment
  // is released exactly once, and a tab round-trip does not reopen the workbench.
  await focusStoredBinding(workbench, 'workflow')
  const consolePane = workbench.locator('.ptcPlusExecution')
  if (await consolePane.getAttribute('open') === null) await consolePane.locator('summary').click()
  await consolePane.locator('.cm-content').fill('value()')
  const runResponse = page.waitForResponse(response => response.url().endsWith('/api/ptcPlusBindings/invoke')
    && response.request().postDataJSON()?.payload?.args?.operation === 'console-run')
  await consolePane.getByRole('button', { name: 'Run', exact: true }).click()
  await consolePane.locator('.ptcPlusExecutionOutput').last().filter({ hasText: '43' }).waitFor()
  // Remote envelope, then the owner envelope, then the console-run value.
  const environment = (await (await runResponse).json()).result.value.value.environment
  assert.ok(typeof environment === 'string' && environment !== '', 'The console run created no environment')
  const closeCalls = recordBindingCalls()
  const released = page.waitForRequest(request => request.url().endsWith('/api/ptcPlusBindings/invoke')
    && request.postDataJSON()?.payload?.args?.operation === 'console-release')
  let closeFocus = null
  try {
    closeFocus = await closeBindingWorkbench('chatTab')
    assert.equal((await released).postDataJSON().payload.args.payload.environment, environment)
  } finally {
    closeCalls.stop()
  }
  assert.equal(closeCalls.calls.filter(call => call.operation === 'console-release').length, 1,
    'An explicit close did not release exactly one console environment')
  await page.getByRole('tab', { name: 'REPL', exact: true }).click()
  await page.locator('.ptcPlusConsole').waitFor()
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await page.locator(composerSelector).waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  assert.equal(await workbenchModal().count(), 0, 'The workbench reopened after an explicit close')
  const reopenCalls = recordBindingCalls()
  try {
    await openBindingWorkbench()
  } finally {
    reopenCalls.stop()
  }
  assert.ok(reopenCalls.calls.some(call => call.operation === 'list'),
    'Reopening the workbench did not re-read the catalog from the Host')
  await closeBindingWorkbench()
  observed.explicitClose = { releasedEnvironment: true, releases: 1, reopened: false, reread: true, closeFocus }
  await page.waitForTimeout(300)
  assert.deepEqual(await sessionLogBytes(), beforeWorkbench, 'Workbench draft checks changed the real session log')
  observed.logInvariant = true
  bindingWorkbenchEvidence.takeover = observed
}

/** Read the real session log as events, so a Host audit pair stays observable after commit. */
async function sessionEvents() {
  const logs = await sessionLogBytes()
  return logs.flatMap(([, text]) => parseEvents(text))
}

/** Wait for the durable log to carry a matching event, so an audit read never races the commit. */
async function waitForSessionEvent(type, match, label) {
  const deadline = Date.now() + 15000
  for (;;) {
    const event = (await sessionEvents()).filter(candidate => candidate.type === type && match(candidate)).at(-1)
    if (event !== undefined) return event
    if (Date.now() > deadline) throw new Error(`${label}: the session log never recorded ${type}`)
    await page.waitForTimeout(200)
  }
}

/** Wait until the fixture holds the armed probe open, so the acceptance acts before the ask. */
async function waitForProbeHold(rpc, label) {
  const deadline = Date.now() + 30000
  for (;;) {
    const status = await rpc('probe/status', {})
    if (status.holding > 0) return status
    if (Date.now() > deadline) throw new Error(`${label}: the fixture never held the approval probe`)
    await page.waitForTimeout(200)
  }
}

/**
 * A real Host approval takes the composer. The fixture probe is the only ask source in
 * this profile, so every other tool keeps its policy and DSH owns the decision, the audit pair
 * and the buttons. A pending approval must not lose unsaved workbench text, and no plugin
 * surface may cover it.
 */
async function verifyApprovalTakeover(rpc) {
  const observed = { repl: null, allowed: null, draft: null, audit: null, logInvariant: false }
  const composer = await showChatComposer()
  await rpc('settings/update', { ns: 'locale', patch: { preference: 'en' } })
  const approvalEvents = async type => (await sessionEvents()).filter(event => event.type === type)
  const before = { asked: (await approvalEvents('approval/asked')).length,
    decided: (await approvalEvents('approval/decided')).length }
  const armProbe = async label => {
    await rpc('probe/arm', {})
    await composer.fill(`Approval probe ${probeMarker}`)
    await composer.press('Enter')
    await waitForProbeHold(rpc, label)
  }
  const releaseProbe = async label => {
    await rpc('probe/release', {})
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 30000 })
    return panel
  }
  const inspectApproval = () => page.evaluate(() => {
    const panel = document.querySelector('[data-approval-key]')
    const seat = document.querySelector('[data-composer-seat]')
    const fallback = document.querySelector('[data-chain-overlay-fallback="conversation.composer"]')
    return {
      text: panel.innerText,
      buttons: [...panel.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect()
        return { label: button.textContent, disabled: button.disabled,
          reachable: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) }
      }),
      pluginMarkup: panel.querySelectorAll('[class*="ptcPlus"]').length,
      insideSeat: seat !== null && seat.contains(panel),
      bounds: panel.getBoundingClientRect().toJSON(),
      fallback: fallback === null ? null : getComputedStyle(fallback).display,
      authorVisible: [...document.querySelectorAll('.ptcPlusAuthorButton')].some(node => node.getClientRects().length > 0),
      workbench: document.querySelectorAll('.ptcPlusBindingsModal').length,
      dock: document.querySelectorAll('.ptcPlusBindingDock').length,
    }
  })
  const assertApproval = async (label, options) => {
    const snapshot = await inspectApproval()
    assert.match(snapshot.text, /Waiting for approval/, `${label}: the Host approval panel is not presented`)
    assert.ok(snapshot.text.includes(probeReason), `${label}: the ask reason did not reach the approval panel: ${snapshot.text}`)
    assert.deepEqual(snapshot.buttons.map(button => button.label), ['Reject', 'Allow once'],
      `${label}: the Host does not own both approval decisions: ${JSON.stringify(snapshot.buttons)}`)
    assert.ok(snapshot.buttons.every(button => button.disabled === false && button.reachable),
      `${label}: a Host decision button is disabled or covered: ${JSON.stringify(snapshot.buttons)}`)
    assert.equal(snapshot.pluginMarkup, 0, `${label}: plugin markup is stacked inside the approval panel`)
    assert.equal(snapshot.authorVisible, false, `${label}: the plugin composer entry stayed visible under the takeover`)
    assert.equal(snapshot.dock, 0, `${label}: a plugin dock stayed over the approval UI`)
    if (options.insideSeat) assert.equal(snapshot.insideSeat, true, `${label}: the approval panel left the composer seat`)
    const viewport = page.viewportSize()
    assert.ok(snapshot.bounds.top >= 0 && snapshot.bounds.bottom <= viewport.height,
      `${label}: the approval panel left the viewport`)
    return snapshot
  }

  // The plugin's REPL console is a full-view surface; the Host approval still owns the composer,
  // and a denied probe stays a Host decision.
  await armProbe('repl approval probe')
  await page.getByRole('tab', { name: 'REPL', exact: true }).click()
  await page.locator('.ptcPlusConsole').waitFor()
  const denyPanel = await releaseProbe('repl approval probe')
  const pendingInRepl = await assertApproval('repl approval probe', { insideSeat: false })
  await denyPanel.getByRole('button', { name: 'Reject', exact: true }).click()
  await denyPanel.waitFor({ state: 'detached', timeout: 30000 })
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await composer.waitFor({ state: 'visible', timeout: 60000 })
  const rejected = await waitForSessionEvent('approval/decided',
    event => event.data.outcome === 'rejected', 'repl approval probe')
  const rejectedDispatch = await waitForSessionEvent('tool/ptc-dispatch',
    event => event.data.name === 'ptcSmokeApprovalProbe', 'repl approval probe')
  assert.equal(rejected.data.outcome, 'rejected', 'The Host did not record the rejection')
  assert.equal(rejectedDispatch.data.name, 'ptcSmokeApprovalProbe', 'The probe did not dispatch through the program')
  assert.equal(rejectedDispatch.data.isError, true, 'A rejected probe reported success')
  observed.repl = { ...pendingInRepl, outcome: rejected.data.outcome, dispatchError: rejectedDispatch.data.isError }

  // The workbench holds unsaved text while the real approval takes the composer.
  await armProbe('workbench approval probe')
  const modal = await openBindingWorkbench()
  const workbench = modal.locator('.ptcPlusBindings')
  await focusStoredBinding(workbench, 'workflow')
  const idInput = workbench.locator('.ptcPlusEntrySettings input').first()
  const nameInput = workbench.locator('.ptcPlusEntrySettings input').nth(1)
  const editor = workbench.locator('.ptcPlusSourceBody .cm-content')
  const draft = { id: 'approvalTakeover', name: 'approvalTools', source: 'export function value(): number { return 91 }' }
  await workbench.getByRole('button', { name: 'New entry', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ptcPlusBindingsModal .ptcPlusEntrySettings input')?.disabled === false)
  await editor.fill(draft.source)
  await idInput.fill(draft.id)
  await nameInput.fill(draft.name)
  const allowPanel = await releaseProbe('workbench approval probe')
  await modal.waitFor({ state: 'detached', timeout: 30000 })
  const pendingUnderWorkbench = await assertApproval('workbench approval probe', { insideSeat: true })
  assert.equal(pendingUnderWorkbench.workbench, 0, 'The workbench stayed mounted over the Host approval UI')
  assert.equal((await readStoredBindings()).entries.some(entry => entry.id === draft.id), false,
    'The takeover stored an unsaved draft')
  await allowPanel.getByRole('button', { name: 'Allow once', exact: true }).click()
  await allowPanel.waitFor({ state: 'detached', timeout: 30000 })
  // The composer returns, and the same unsaved text comes back with it.
  await composer.waitFor({ state: 'visible', timeout: 60000 })
  await modal.waitFor({ timeout: 60000 })
  await page.waitForFunction(expected => {
    const node = document.querySelector('.ptcPlusBindingsModal .ptcPlusSourceBody .cm-content')
    return node !== null && [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n') === expected
  }, draft.source, { timeout: 30000 })
  assert.equal(await idInput.inputValue(), draft.id, 'The unsaved draft id did not survive the approval takeover')
  assert.equal(await nameInput.inputValue(), draft.name, 'The unsaved draft name did not survive the approval takeover')
  const allowed = await waitForSessionEvent('approval/decided',
    event => event.data.outcome === 'allowed-once', 'workbench approval probe')
  const allowedDispatch = await waitForSessionEvent('tool/ptc-dispatch',
    event => event.data.name === 'ptcSmokeApprovalProbe' && event.data.isError === false, 'workbench approval probe')
  assert.equal(allowed.data.outcome, 'allowed-once', 'The Host did not record the grant')
  assert.equal(allowedDispatch.data.name, 'ptcSmokeApprovalProbe', 'The probe did not dispatch through the program')
  assert.equal(allowedDispatch.data.isError, false, 'The approved probe reported an error')
  observed.allowed = { ...pendingUnderWorkbench, outcome: allowed.data.outcome }
  observed.draft = { id: draft.id, name: draft.name, restored: true, stored: false }

  // Explicit close still ends the management session: no auto-reopen and no draft to recover.
  const approvalCloseFocus = await closeBindingWorkbench('liveTarget')
  assert.equal((await readStoredBindings()).entries.some(entry => entry.id === draft.id), false,
    'An explicit close stored the draft it discarded')
  await page.getByRole('tab', { name: 'REPL', exact: true }).click()
  await page.locator('.ptcPlusConsole').waitFor()
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await composer.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  assert.equal(await workbenchModal().count(), 0, 'The workbench reopened after an explicit close')
  // Reopening starts from the current stored baseline, not the discarded draft. The workbench
  // auto-loads the first stored entry in read mode, so the exact source comparison enters the
  // editor through Edit rather than reading a highlighted preview.
  const reopened = await openBindingWorkbench()
  const reopenedId = await reopened.locator('.ptcPlusEntrySettings input').first().inputValue()
  const baseline = (await readStoredBindings()).entries.find(entry => entry.id === reopenedId)
  assert.ok(baseline !== undefined, `Reopening after an explicit close loaded no stored entry: ${reopenedId}`)
  assert.notEqual(reopenedId, draft.id, 'Reopening after an explicit close returned to the discarded draft')
  await reopened.getByRole('button', { name: 'Edit', exact: true }).click()
  const reopenedEditor = reopened.locator('.ptcPlusSourceBody .cm-content')
  await reopenedEditor.waitFor()
  assert.equal(await editorText(reopenedEditor), baseline.source,
    'Reopening after an explicit close did not show the stored baseline source')
  await closeBindingWorkbench()
  observed.closeFocus = approvalCloseFocus

  // Display-only actions never write to the real session log.
  const beforeDisplay = await sessionLogBytes()
  await page.getByRole('tab', { name: 'REPL', exact: true }).click()
  await page.locator('.ptcPlusConsole').waitFor()
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await composer.waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  assert.deepEqual(await sessionLogBytes(), beforeDisplay, 'Approval display controls changed the real session log')
  observed.logInvariant = true

  // Recovery: the durable log replays the audit pair and no plugin dialog reopens.
  await page.reload()
  await composer.waitFor({ timeout: 60000 })
  await page.waitForTimeout(300)
  assert.equal(await workbenchModal().count(), 0, 'A reload reopened the workbench')
  const after = { asked: (await approvalEvents('approval/asked')).length,
    decided: (await approvalEvents('approval/decided')).length }
  assert.equal(after.asked - before.asked, 2, 'This profile raised approvals outside the probe')
  assert.equal(after.decided - before.decided, 2, 'The Host did not close both approval pairs')
  const asked = (await approvalEvents('approval/asked')).slice(-2)
  assert.ok(asked.every(event => event.data.toolName === 'ptcSmokeApprovalProbe' && event.data.reason === probeReason),
    `The Host audit did not record the probe ask: ${JSON.stringify(asked)}`)
  observed.audit = { asked: after.asked - before.asked, decided: after.decided - before.decided,
    toolName: asked.at(-1).data.toolName }
  bindingWorkbenchEvidence.approval = observed
}

/**
 * Collect one child's full output through the shared close-based runner, keeping the smoke
 * runner's own result format and diagnostics.
 */
export async function runCommand(executable, args, options = {}) {
  const result = await runProcess(executable, args, { cwd: repository, env, windowsHide: true, ...options })
  if (result.code !== 0) {
    throw new Error(`${executable} exited ${result.code}: ${result.stderr.slice(-4000)}`)
  }
  return result.stdout
}

function run(executable, args, options = {}) {
  return runCommand(executable, args, options)
}

/**
 * Own one-time exit/close bookkeeping for a runner-spawned process.
 * Must be created before the process can exit, because a process that already exited
 * never delivers another event; cleanup then reuses this state instead of waiting for one.
 */
export function watchProcessEnd(child) {
  let resolveClosed
  const state = {
    exited: () => child.exitCode != null || child.signalCode != null,
    closed: new Promise(resolve => { resolveClosed = resolve }),
  }
  child.once('close', () => resolveClosed(true))
  return state
}

async function closedWithin(state, timeoutMs) {
  let timer
  const expired = await Promise.race([
    state.closed.then(() => false),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(true), timeoutMs)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
  return !expired
}

/**
 * Stop one runner-owned process within a bounded grace, whether or not it already exited.
 * A process that already exited never delivers another close event, so only that branch waits
 * on the observed state; the termination path owns both bounds and reports them itself.
 */
export async function stopOwnedProcess(child, options = {}) {
  if (child === undefined) return
  const state = options.state ?? watchProcessEnd(child)
  if (state.exited()) {
    if (!await closedWithin(state, options.closeMs ?? TERMINATION_GRACE_MS)) {
      throw new Error('owned process exited but its stdio did not close within the bounded grace')
    }
    return
  }
  const outcome = await terminateProcessTree(child, options)
  if (!outcome.terminated) throw new Error('owned process did not exit within the bounded termination grace')
  if (!outcome.closed) throw new Error('owned process exited but its stdio did not close within the bounded grace')
}

/**
 * Release every runner-owned resource independently; the primary acceptance failure stays primary.
 */
export async function releaseResources(steps, primaryError) {
  const failures = []
  for (const [label, action] of steps) {
    try {
      await action()
    } catch (error) {
      failures.push(new Error(`${label}: ${error?.message ?? String(error)}`, { cause: error }))
    }
  }
  if (failures.length === 0) return
  const combined = failures.length === 1 ? failures[0] : new Error(failures.map(failure => failure.message).join('; '))
  if (primaryError === undefined) throw combined
  recordCleanupFailure(primaryError, combined)
}

export async function main(argv = process.argv.slice(2)) {
  ;({ values } = parseArgs({ args: argv, options: {
    'dsh-entry': { type: 'string' },
    'browser-channel': { type: 'string' },
    'binding-workflow': { type: 'boolean', default: false },
  } }))
  assert.ok(values['dsh-entry'], 'Pass --dsh-entry with the installed latest DSH CLI JavaScript entry')
  dshEntry = resolve(values['dsh-entry'])
  ptcMode = ptcToolsMode(hostToolRuntime(dshEntry))
  repository = resolve(import.meta.dirname, '..')
  temporary = await mkdtemp(join(tmpdir(), 'ptc-client-web-'))
  evidence = resolve(repository, 'artifacts/client-web-smoke')
  env = { ...process.env, DSH_HOME: join(temporary, 'dsh-home') }
  let primaryError
  try {
    await mkdir(evidence, { recursive: true })
    await rm(join(evidence, 'result.json'), { force: true })
    const version = (await run(process.execPath, [dshEntry, '--version'])).trim()
    const pack = npmCliCommand(['pack', '--silent', '--json', '--pack-destination', temporary])
    const packReport = JSON.parse(await run(pack.executable, pack.args))
    const tarball = join(temporary, extractPackFilename(packReport))
    const { integrity: packageIntegrity } = Object.values(packReport)[0]
    console.log('Installing packed Client into an isolated Web profile')
    await run(process.execPath, [dshEntry, 'plugin', '--profile', 'web', 'add', tarball])
    const patch = join(temporary, 'smoke.patch.yml')
    const adapterEntry = join(temporary, 'fixture', 'index.mjs')
    if (values['binding-workflow']) {
      await mkdir(join(env.DSH_HOME, 'ptc-plus'), { recursive: true })
      await writeFile(join(env.DSH_HOME, 'ptc-plus', 'bindings.json'), JSON.stringify({ entries: [
        { id: 'fileTools', name: 'fileTools', scope: 'namespace', enabled: false,
          source: 'throw new Error("Menu must not initialize bindings"); export const value = 1', purpose: 'Read and write files.' },
        { id: 'textTools', name: 'textTools', scope: 'namespace', enabled: true,
          source: 'export const value = 2', purpose: 'Format and compare text.' },
        { id: 'jsonTools', name: 'jsonTools', scope: 'namespace', enabled: true,
          source: 'export const value = 3', purpose: 'Read structured data.' },
      ] }))
      await mkdir(join(temporary, 'fixture'))
      await writeFile(join(temporary, 'fixture', 'package.json'), JSON.stringify({ name: 'ptc-binding-web-fixture', type: 'module' }))
      await writeFile(adapterEntry, `export { apply, inject } from ${JSON.stringify(pathToFileURL(join(repository, 'test/binding-web-adapter.js')).href)}\n`)
    }
    await writeFile(patch, stringify([
      { id: 'ptc-plus', config: { enabled: true, userBindingsEnabled: true } },
      ...(values['binding-workflow'] ? [
        { insert: [{ id: 'binding-web-fixture', name: pathToFileURL(adapterEntry).href }] },
        { id: 'agent-default-model', config: { provider: 'binding-web-fixture', model: 'fixture' } },
        ...['agent-instructions', 'skill-filesystem', 'tool-skill', 'session-title-llm'].map(id => ({ id, disabled: true })),
        { id: 'tools', config: { mode: ptcMode } },
        { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
        // The fixture's scoped probe is the only ask source, so the default policy still
        // leaves every other tool unanswered and the Host owns the probe decision.
        { id: 'approval', config: { policy: 'ask' } },
        // A patch replaces the row's whole config, so restate the shipped presets and add
        // the full-access-plus-ask bundle that the composed defaults now match.
        { id: 'permission', config: { presets: {
          'read-only': { sandbox: 'read-only', approval: 'ask' },
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
          'danger-full-access-ask': { sandbox: 'danger-full-access', approval: 'ask' },
        } } },
      ] : []),
    ]))
    let output = ''
    host = spawn(process.execPath, [dshEntry, '--profile', 'web', '--patch', patch,
      '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: temporary, env, windowsHide: true })
    hostEnd = watchProcessEnd(host)
    host.stdout.on('data', chunk => { output += chunk })
    host.stderr.on('data', chunk => { output += chunk })
    const url = await new Promise((resolveUrl, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(poll)
        reject(new Error(`Web Host did not start: ${output.replace(/https?:\/\/\S+/g, '[URL]').slice(-4000)}`))
      }, 60000)
      const poll = setInterval(() => {
        const match = /https?:\/\/127\.0\.0\.1:\d+[^\s\u001b]*/.exec(output)
        if (!match) return
        clearTimeout(timeout)
        clearInterval(poll)
        resolveUrl(match[0])
      }, 50)
      host.once('error', reject)
      host.once('exit', code => {
        clearTimeout(timeout)
        clearInterval(poll)
        reject(new Error(`Web Host exited ${code}: ${output.slice(-4000)}`))
      })
    })
    browser = await chromium.launch({ headless: true, channel: values['browser-channel'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(10000)
    const errors = []
    const consoleErrors = []
    const hostIconFallbacks = new Set()
    const pluginRpc = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (/^\/ptc-plus-(bindings|repl)\//.test(path)) errors.push(`Unexpected dedicated plugin route: ${path}`)
      if (/^\/api\/ptcPlus(Bindings|Repl)\/invoke$/.test(path)) {
        const wire = request.postDataJSON()
        pluginRpc.push({ path, operation: wire.payload?.args?.operation })
      }
    })
    page.on('response', response => {
      const target = new URL(response.url())
      // The Host returns 404 for an unavailable application icon and renders a generic glyph.
      if (response.status() === 404 && response.request().method() === 'GET'
        && target.origin === new URL(url).origin && /^\/open-in-app\/icon\/[^/]+$/.test(target.pathname)) {
        hostIconFallbacks.add(response.url())
      }
    })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url })
    })
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector('[data-slot="root"]'), null, { timeout: 60000 })
    assert.equal(await page.getByText('Failed to load plugins', { exact: true }).count(), 0)
    const welcome = page.getByRole('button', { name: /^(Continue|继续)$/ })
    await welcome.waitFor({ timeout: 5000 }).catch(error => {
      if (error.name !== 'TimeoutError') throw error
    })
    if (await welcome.isVisible()) await welcome.click()
    const skipCredentials = page.getByRole('button', { name: /^(Set up later|Configure later|稍后配置)$/ })
    await skipCredentials.waitFor({ timeout: 5000 }).catch(error => {
      if (error.name !== 'TimeoutError') throw error
    })
    if (await skipCredentials.isVisible()) await skipCredentials.click()
    if (values['binding-workflow']) {
      // The Remote result envelope wraps the fixture's own result, exactly as the Host
      // client unwraps it once before reading the owner's ok/value.
      const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
        const response = await fetch('/api/ptcWebFixture/invoke', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'ptcWebFixture/invoke', payload: { args: { operation: method, payload: args } } }) })
        if (!response.ok) throw new Error(`Fixture ${method} failed: HTTP ${response.status}`)
        const envelope = (await response.json()).result
        const result = envelope.ok === true ? envelope.value : envelope
        if (result?.ok !== true) throw new Error(JSON.stringify(result))
        return result.value
      }, { method, args })
      const workspace = join(temporary, 'workspace')
      await mkdir(workspace)
      await rpc('settings/update', { ns: 'locale', patch: { preference: 'en' } })
      await rpc('settings/update', { ns: 'agent-presets', patch: { default: ptcMode } })
      await rpc('workspace/create', { request: { path: workspace } })
      await page.getByText('workspace', { exact: true }).first().hover()
      await page.getByRole('button', { name: 'New session in workspace', exact: true }).click()
      const composer = page.locator(composerSelector)
      await composer.waitFor({ timeout: 30000 })
      const beforeMenu = await sessionLogBytes()
      const entry = page.locator('.ptcPlusAuthorButton')
      const verifyPendingMenuDismissal = async operation => {
        const matches = request => request.url().endsWith('/api/ptcPlusBindings/invoke')
          && request.postDataJSON()?.payload?.args?.operation === operation
        let release
        const held = new Promise(resolve => { release = resolve })
        const routePattern = '**/api/ptcPlusBindings/invoke'
        const handler = async route => { if (matches(route.request())) await held; await route.continue() }
        await page.route(routePattern, handler)
        const requested = page.waitForRequest(matches)
        const response = page.waitForResponse(response => matches(response.request()))
        try {
          await page.keyboard.press('Enter')
          await requested
          await page.keyboard.press('Escape')
          await page.getByRole('menu').waitFor({ state: 'detached' })
          await page.waitForFunction(() => document.activeElement?.matches('.ptcPlusAuthorButton'))
        } finally {
          release()
          await response
          await page.unroute(routePattern, handler)
        }
      }
      const bindingsFile = join(env.DSH_HOME, 'ptc-plus', 'bindings.json')
      const bindingsSource = await readFile(bindingsFile, 'utf8')
      await writeFile(bindingsFile, '{')
      await page.evaluate(async () => {
        const method = 'ptcPlusBindings/invoke'
        const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method,
            payload: { args: { operation: 'reload', payload: {} } } }) })
        if (!response.ok) throw new Error(`Binding reload setup failed: HTTP ${response.status}`)
        await response.json()
      })
      await entry.hover()
      await page.getByRole('menuitem', { name: 'Reload', exact: true }).focus()
      await verifyPendingMenuDismissal('reload')
      await page.keyboard.press('ArrowUp')
      await page.getByRole('menuitem', { name: 'Reload', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem'
        && document.activeElement.textContent === 'Reload')
      await writeFile(bindingsFile, bindingsSource)
      await page.keyboard.press('Enter')
      await page.getByRole('menuitem', { name: /fileTools/ }).waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem'
        && document.activeElement.textContent.includes('fileTools'))
      await entry.hover()
      await page.getByRole('menuitem', { name: /fileTools/ }).waitFor()
      assert.equal(await page.locator('.ptcPlusBindingCommand').count(), 0)
      const globalToggle = page.getByRole('menuitem', { name: /fileTools/ })
      await globalToggle.focus()
      await page.keyboard.press('Enter')
      await page.locator('.ptcPlusBindingQuickRow[data-enabled=true]').filter({ hasText: 'fileTools' }).waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem'
        && document.activeElement.textContent.includes('fileTools'))
      await page.keyboard.press('Enter')
      await page.locator('.ptcPlusBindingQuickRow[data-enabled=false]').filter({ hasText: 'fileTools' }).waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem'
        && document.activeElement.textContent.includes('fileTools'))
      await page.keyboard.press('Enter')
      await page.locator('.ptcPlusBindingQuickRow[data-enabled=true]').filter({ hasText: 'fileTools' }).waitFor()
      await globalToggle.focus()
      await verifyPendingMenuDismissal('disable')
      await page.keyboard.press('ArrowUp')
      await globalToggle.focus()
      await page.keyboard.press('Enter')
      await page.locator('.ptcPlusBindingQuickRow[data-enabled=true]').filter({ hasText: 'fileTools' }).waitFor()
      const storedBindings = () => readFile(join(env.DSH_HOME, 'ptc-plus', 'bindings.json'), 'utf8').then(JSON.parse)
      assert.equal((await storedBindings()).entries.find(entry => entry.id === 'fileTools').enabled, true)
      for (const width of [1440, 390]) {
        await page.keyboard.press('Escape')
        await page.setViewportSize({ width, height: 1000 })
        if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
        await page.mouse.move(0, 0)
        await entry.hover()
        await page.getByRole('menuitem', { name: /fileTools/ }).waitFor()
        const menu = page.getByRole('menu').filter({ has: page.locator('.ptcPlusBindingQuickRow') })
        const bounds = await menu.boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= (await composer.boundingBox()).y,
          'Global menu obscures the composer input')
        for (const item of await menu.getByRole('menuitem').all()) {
          assert.equal(await item.evaluate(element => {
            const rect = element.getBoundingClientRect()
            return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
          }), true)
        }
        await page.screenshot({ path: join(evidence, `binding-entry-blank-${width}.png`), animations: 'disabled' })
      }
      await page.getByRole('menuitem', { name: /fileTools/ }).click()
      await page.locator('.ptcPlusBindingQuickRow[data-enabled=false]').filter({ hasText: 'fileTools' }).waitFor()
      assert.equal((await storedBindings()).entries.find(entry => entry.id === 'fileTools').enabled, false)
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 390, height: 400 })
      await composer.fill(Array.from({ length: 8 }, (_, index) => `Message line ${index + 1}`).join('\n'))
      await entry.click()
      const shortMenu = page.getByRole('menu').filter({ has: page.locator('.ptcPlusBindingQuickRow') })
      await shortMenu.waitFor()
      for (const item of await shortMenu.getByRole('menuitem').all()) {
        await item.scrollIntoViewIfNeeded()
        assert.equal(await item.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        }), true, 'Global menu action is unreachable in a short viewport')
      }
      const shortBounds = await shortMenu.boundingBox()
      const inputBounds = await composer.boundingBox()
      assert.ok(inputBounds.y < 156, 'Short viewport does not exercise limited space above the input')
      assert.ok(shortBounds.y >= 0 && shortBounds.y + shortBounds.height <= inputBounds.y,
        'Global menu obscures the expanded composer input in a short viewport')
      await page.screenshot({ path: join(evidence, 'binding-entry-short-390.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'detached' })
      await clearComposer(composer)
      await page.setViewportSize({ width: 390, height: 1000 })
      await entry.hover()
      await page.getByRole('menuitem', { name: /fileTools/ }).waitFor()
      assert.equal(await composerValue(composer), '')
      assert.deepEqual(await sessionLogBytes(), beforeMenu, 'Global menu actions before a turn alter the session log')
      await page.getByRole('menuitem', { name: 'Manage global bindings', exact: true }).click()
      const quickManager = page.getByRole('dialog')
      for (const name of ['fileTools', 'textTools', 'jsonTools']) {
        await quickManager.getByRole('button', { name: `${name} namespace`, exact: true }).click()
        await quickManager.getByRole('button', { name: 'Remove', exact: true }).click()
        await quickManager.getByRole('button', { name: `${name} namespace`, exact: true }).waitFor({ state: 'detached' })
      }
      await quickManager.getByRole('button', { name: 'Close global bindings workbench' }).click()
      await page.setViewportSize({ width: 1440, height: 1000 })
      const submit = async text => { await composer.fill(text); await composer.press('Enter') }
      await submit('/binding new constant workflow helper')
      const cards = page.locator('.ptcPlusBindingCommand')
      await page.locator('.ptcPlusBindingCommand[data-phase=pending]').waitFor()
      await captureBinding('pending')
      await page.getByRole('button', { name: 'Save and enable', exact: true }).waitFor({ timeout: 30000 })
      assert.equal(await cards.count(), 1)
      assert.equal(await page.getByText('Global User Binding authoring started.', { exact: false }).count(), 0)
      for (const locale of ['zh', 'en']) {
        await rpc('settings/update', { ns: 'locale', patch: { preference: locale } })
        await page.getByRole('button', { name: locale === 'zh' ? '保存并启用' : 'Save and enable', exact: true }).waitFor()
        for (const width of [390, 1440]) {
          await captureBinding(`ready-${locale}`, width)
          await captureCandidateContext(page.locator('.ptcPlusBindingDock'), `dock-${locale}`, width)
        }
      }
      const dock = page.locator('.ptcPlusBindingDock')
      assert.equal(await cards.locator('.ptcPlusBindingDockActions').count(), 0)
      assert.equal(await cards.locator('button').filter({ hasText: 'Save' }).count(), 0)
      assert.equal(await cards.locator('.ptcPlusBindingSourceDetails').getAttribute('open'), null)
      await dock.getByText('Model context', { exact: true }).waitFor()
      for (const [width, height] of [[1440, 1000], [1280, 800], [1920, 1080], [390, 800], [320, 600], [640, 480]]) {
        await verifyDock('ready', width, height)
      }
      // Reserve an adjacent dock's footprint in the real composer stack without changing Host code.
      await dock.evaluate(element => {
        const neighbor = document.createElement('div')
        neighbor.dataset.ptcSmokeNeighbor = ''
        neighbor.style.cssText = 'height:64px;flex:none;box-sizing:border-box;padding:8px'
        neighbor.textContent = 'Neighbor dock layout fixture'
        element.parentElement.before(neighbor)
      })
      await verifyDock('neighbor', 640, 480)
      await page.locator('[data-ptc-smoke-neighbor]').evaluate(element => {
        const rect = element.getBoundingClientRect()
        if (!element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))) {
          throw new Error('Neighbor dock content is obscured')
        }
        element.style.height = '128px'
      })
      await verifyDock('tall-neighbor', 640, 480)
      await page.locator('[data-ptc-smoke-neighbor]').evaluate(element => { element.remove() })
      await composer.fill(Array.from({ length: 8 }, (_, index) => `Draft line ${index + 1}`).join('\n'))
      await verifyDock('multiline-composer', 640, 480)
      await clearComposer(composer)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByText('Review item 14: the binding draft is ready for review.', { exact: true }).waitFor()
      // Wait for the official persistence writer before comparing the unchanged log.
      await page.waitForTimeout(300)
      const beforeDisplay = await sessionLogBytes()
      const disclosureLayout = () => page.evaluate(() => ({
        seat: document.querySelector('[data-composer-seat]').getBoundingClientRect().toJSON(),
        extent: document.querySelector('[data-conversation-scroll]').scrollHeight,
        transform: getComputedStyle(document.querySelector('.ptcPlusBindingDockChevron')).transform,
      }))
      const expandedLayout = await disclosureLayout()
      await dock.getByRole('button', { name: 'Collapse binding draft', exact: true }).click()
      assert.equal(await dock.locator('.ptcPlusBindingDockBody').count(), 0)
      await verifyDock('collapsed')
      const collapsedLayout = await disclosureLayout()
      assert.deepEqual(collapsedLayout.seat, expandedLayout.seat, 'Disclosure moved the composer')
      assert.equal(collapsedLayout.extent, expandedLayout.extent, 'Disclosure changed transcript height')
      assert.notEqual(collapsedLayout.transform, expandedLayout.transform, 'Disclosure chevron did not change direction')
      // Click the title itself; a tiny icon-only target must fail this acceptance check.
      await dock.locator('.ptcPlusBindingDockHeading strong').click()
      await dock.locator('.ptcPlusBindingDockBody').waitFor()
      await dock.getByRole('button', { name: 'Collapse binding draft', exact: true }).focus()
      await page.keyboard.press('Enter')
      assert.equal(await dock.locator('.ptcPlusBindingDockBody').count(), 0)
      await page.keyboard.press('Space')
      await dock.locator('.ptcPlusBindingDockBody').waitFor()
      await dock.locator('.ptcPlusBindingDockHeading strong').click()
      await page.getByRole('tab', { name: 'REPL', exact: true }).click()
      await dock.waitFor({ state: 'hidden' })
      await page.getByRole('tab', { name: 'Chat', exact: true }).click()
      await dock.getByRole('button', { name: 'Expand binding draft', exact: true }).waitFor()
      await dock.getByRole('button', { name: 'Close binding draft panel', exact: true }).click()
      await dock.waitFor({ state: 'detached' })
      const reopen = page.locator('.ptcPlusAuthorButton')
      await reopen.waitFor()
      await page.waitForFunction(() => document.activeElement?.matches('.ptcPlusAuthorButton'))
      assert.equal(await page.locator('.ptcPlusDraftAccess').count(), 0)
      assert.equal(await reopen.count(), 1)
      assert.equal(await reopen.locator('.ptcPlusDraftBadge').innerText(), '1')
      const draftItem = page.getByRole('menuitem').filter({ has: page.locator('.ptcPlusDraftMenuItem') })
      for (const [width, height] of [[1440, 1000], [390, 800], [640, 480]]) {
        await page.setViewportSize({ width, height })
        await reopen.hover()
        await draftItem.waitFor()
        await draftItem.hover()
        await page.waitForTimeout(500)
        assert.equal(await draftItem.isVisible(), true, 'Hover transit dismissed the draft menu')
        const bounds = await page.getByRole('menu').boundingBox()
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height,
          'Draft menu escaped the viewport')
        await page.screenshot({ path: resolve(evidence, `draft-menu-${width}-${height}.png`) })
        await draftItem.click()
        await dock.waitFor()
        await dock.getByRole('button', { name: 'Close binding draft panel', exact: true }).click()
        await dock.waitFor({ state: 'detached' })
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await reopen.click()
      await draftItem.waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
      await page.keyboard.press('Tab')
      await page.waitForFunction(() => document.activeElement?.textContent === 'Write a new binding')
      await page.keyboard.press('Escape')
      await draftItem.waitFor({ state: 'detached' })
      await page.mouse.move(0, 0)
      await reopen.hover()
      await draftItem.waitFor()
      await page.getByRole('tab', { name: 'REPL', exact: true }).click()
      await draftItem.waitFor({ state: 'detached' })
      await page.getByRole('tab', { name: 'Chat', exact: true }).click()
      assert.equal(await page.getByRole('menu').count(), 0)
      await rpc('settings/update', { ns: 'ptc-plus', patch: { bindingAuthorButtonVisible: false } })
      await page.setViewportSize({ width: 390, height: 400 })
      await composer.fill(Array.from({ length: 9 }, (_, index) => `Draft message line ${index + 1}`).join('\n'))
      await reopen.hover()
      await draftItem.waitFor()
      await draftItem.scrollIntoViewIfNeeded()
      const draftMenuBounds = await page.getByRole('menu').boundingBox()
      const draftInputBounds = await composer.boundingBox()
      assert.ok(draftInputBounds.y < 156, 'Draft menu check needs limited space above the input')
      assert.ok(draftMenuBounds.y >= 0 && draftMenuBounds.y + draftMenuBounds.height <= draftInputBounds.y,
        'Draft-only menu obscures the composer input')
      assert.equal(await draftItem.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      }), true, 'Draft-only menu item is unreachable')
      await page.screenshot({ path: join(evidence, 'binding-draft-menu-short-390.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'detached' })
      await clearComposer(composer)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await reopen.focus()
      await page.keyboard.press('Enter')
      await draftItem.waitFor()
      await page.getByRole('menuitem', { name: 'Write a new binding', exact: true }).waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
      await page.keyboard.press('Escape')
      await draftItem.waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.activeElement?.matches('.ptcPlusAuthorButton'))
      await page.keyboard.press('ArrowUp')
      await draftItem.waitFor()
      await page.keyboard.press('Enter')
      await dock.waitFor()
      await dock.locator('.ptcPlusBindingDockBody').focus()
      await page.keyboard.press('End')
      await dock.getByRole('button', { name: 'Close binding draft panel', exact: true }).click()
      await dock.waitFor({ state: 'detached' })
      await cards.getByRole('button', { name: 'Open draft', exact: true }).click()
      await dock.waitFor()
      await page.waitForTimeout(1800)
      assert.deepEqual(await sessionLogBytes(), beforeDisplay, 'Display controls changed the real session log')
      displayLogInvariant = true
      await rpc('settings/update', { ns: 'ptc-plus', patch: { bindingAuthorButtonVisible: true } })
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('.ptcPlusBindingDockActions button')]
          .find(item => item.textContent?.includes('Save and enable'))
        return button?.disabled === false
      }, null, { timeout: 30000 })
      await dock.getByRole('button', { name: 'Save and enable', exact: true }).scrollIntoViewIfNeeded()
      await dock.getByRole('button', { name: 'Save and enable', exact: true }).click()
      await dock.waitFor({ state: 'detached', timeout: 30000 })
      await page.locator('.ptcPlusBindingCommand[data-phase=saved]').waitFor({ timeout: 30000 })
      await page.waitForFunction(() => document.activeElement?.matches('.ptcPlusAuthorButton'))
      assert.equal(await reopen.locator('.ptcPlusDraftBadge').count(), 0)
      for (const locale of ['zh', 'en']) {
        await rpc('settings/update', { ns: 'locale', patch: { preference: locale } })
        await page.getByText(locale === 'zh' ? '草稿已保存并启用' : 'Draft saved and enabled', { exact: true }).first().waitFor()
        await page.reload()
        await page.locator('.ptcPlusBindingCommand[data-phase=saved]').waitFor()
        assert.equal(await page.locator('.ptcPlusBindingDock').count(), 0)
        assert.equal(await cards.count(), 1)
        await cards.locator('.ptcPlusBindingSourceDetails > summary').click()
        assert.match(await cards.innerText(), /export function value/)
        for (const width of [390, 1440]) {
          await captureBinding(`saved-${locale}`, width)
          await captureCandidateContext(cards, `history-${locale}`, width)
        }
      }
      await verifyBindingScroll(rpc)
      await submit('/binding edit workflow same helper')
      await page.getByRole('button', { name: 'Discard draft', exact: true }).waitFor({ timeout: 30000 })
      for (const [width, height] of [[1440, 1000], [390, 800], [640, 480]]) {
        await verifyDock('long-source', width, height)
        const scroller = await dock.getAttribute('data-scroll') === 'panel' ? dock : dock.locator('.ptcPlusBindingDockBody')
        await scroller.focus()
        await scroller.press('Control+End')
        await page.waitForFunction(() => {
          const panel = document.querySelector('.ptcPlusBindingDock')
          const scroller = panel.dataset.scroll === 'panel' ? panel : panel.querySelector('.ptcPlusBindingDockBody')
          return scroller.scrollTop > 0
        })
        const instructions = dock.getByText('Use this helper to return a number.', { exact: true })
        await instructions.scrollIntoViewIfNeeded()
        assert.equal(await instructions.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        }), true, 'Long-source model context cannot be reached')
        assert.match(await dock.locator('.ptcPlusBindingCommandCode').innerText(), /End of long binding source/)
      }
      await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'dark' } })
      await page.locator('body[data-ds-dark-theme]').waitFor()
      await verifyDock('long-source-dark', 390, 800)
      await captureCandidateContext(dock, 'dock-dark', 390, 'Use this helper to return a number.')
      await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'light' } })
      await page.locator('body:not([data-ds-dark-theme])').waitFor()
      await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
      await dock.waitFor({ state: 'detached', timeout: 30000 })
      await page.locator('.ptcPlusBindingCommand[data-phase=discarded]').waitFor()
      await page.waitForFunction(() => document.activeElement?.matches('.ptcPlusAuthorButton'))
      assert.equal(await cards.count(), 2)
      for (const locale of ['zh', 'en']) {
        await rpc('settings/update', { ns: 'locale', patch: { preference: locale } })
        await page.getByText(locale === 'zh' ? '草稿已丢弃' : 'Draft discarded', { exact: true }).first().waitFor()
        await captureBinding(`discarded-${locale}`)
      }
      await page.reload()
      await page.locator('.ptcPlusBindingCommand[data-phase=discarded]').waitFor()
      assert.equal(await page.locator('.ptcPlusBindingDock').count(), 0)
      await submit('/binding edit missing-binding')
      await page.locator('.ptcPlusBindingCommand[data-phase=failed]').waitFor()
      assert.equal(await cards.count(), 3)
      for (const locale of ['zh', 'en']) {
        await rpc('settings/update', { ns: 'locale', patch: { preference: locale } })
        await page.getByText(locale === 'zh' ? '未生成可保存的草稿' : 'No saveable draft was produced', { exact: true }).waitFor()
        await captureBinding(`failed-${locale}`)
      }
      await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'dark' } })
      await page.locator('body[data-ds-dark-theme]').waitFor()
      await captureBinding('dark', 390)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await composer.fill('Unsent draft survives REPL navigation')
      const handles = await page.locator('[data-width-handle]').evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect()
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * 0.85, width: bounds.width }
      }))
      if (handles.length > 0) assert.ok(handles.some(handle => handle.width > 0), 'Chat width handles have no hit area')
      const widthPreference = () => page.locator('[data-conversation-scroll]').evaluate(element => (
        getComputedStyle(element).getPropertyValue('--dsh-chat-user-width')
      ))
      const originalWidth = await widthPreference()
      await page.getByRole('tab', { name: 'REPL', exact: true }).click()
      await page.locator('.ptcPlusConsole').waitFor()
      await composer.waitFor({ state: 'hidden' })
      for (const handle of handles.filter(handle => handle.width > 0)) {
        await page.mouse.move(handle.x, handle.y)
        await page.mouse.down()
        await page.mouse.move(handle.x + 40, handle.y, { steps: 4 })
        await page.mouse.up()
      }
      assert.equal(await widthPreference(), originalWidth, 'REPL drag changed the transcript width')
      assert.ok(await page.getByRole('heading', { name: 'Session bindings', exact: true }).isVisible())
      assert.ok(await page.getByRole('heading', { name: 'Global bindings', exact: true }).isVisible())
      for (const [name, value] of [['previewNumber', '42'], ['previewText', '"hello"'], ['previewBigint', '123n']]) {
        const row = page.locator('.ptcPlusObservationTable tr').filter({ has: page.getByRole('button', { name, exact: true }) })
        await row.locator('.ptcPlusObservationValue code').waitFor()
        assert.equal(await row.locator('.ptcPlusObservationValue code').innerText(), value,
          `${name}: opening REPL after execution did not obtain its value`)
      }
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 })
        if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
        await verifyReplLayout('session')
        await page.screenshot({ path: join(evidence, `repl-${width}.png`), fullPage: true, animations: 'disabled' })
        assert.ok(await page.locator('.ptcPlusConsole').evaluate(element => element.clientWidth >= 240), 'REPL view remained squeezed after sidebar collapse')
        assert.equal(await page.locator('.ptcPlusConsole').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      }
      const observationSelect = page.locator('.ptcPlusObservationSelect').first()
      await observationSelect.focus()
      await page.keyboard.press('Enter')
      const definition = page.locator('.ptcPlusObservationCode').first()
      await definition.locator('pre.shiki').waitFor()
      const tokenColors = await definition.locator('pre.shiki span[style]').evaluateAll(elements => (
        [...new Set(elements.map(element => getComputedStyle(element).color))]
      ))
      assert.ok(tokenColors.length > 1, 'Binding definition has no syntax highlighting')
      const copiedSource = await definition.locator('pre').textContent()
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await definition.getByRole('button', { name: 'Copy code', exact: true }).click()
      const clipboardSource = await page.evaluate(() => navigator.clipboard.readText())
      assert.equal(clipboardSource.replace(/\r\n/g, '\n'), copiedSource.replace(/\r\n/g, '\n'))
      await page.locator('.ptcPlusBindingSelect').first().click()
      await verifyWorkbenchReload(page.locator('.ptcPlusConsole .ptcPlusBindings'), 'repl')
      assert.equal(await page.locator('.ptcPlusSourceBody .cm-content').count(), 0)
      await page.locator('.ptcPlusSourceToggle').click()
      await page.locator('.ptcPlusSourceCode pre.shiki').waitFor()
      const sourceColors = await page.locator('.ptcPlusSourceCode pre.shiki span[style]').evaluateAll(elements => (
        [...new Set(elements.map(element => getComputedStyle(element).color))]
      ))
      assert.ok(sourceColors.length > 1, 'Read-only implementation source has no syntax highlighting')
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      const codeEditor = page.locator('.ptcPlusConsole .ptcPlusSourceBody .cm-content')
      await codeEditor.waitFor()
      const editorColors = await codeEditor.locator('span[class]').evaluateAll(elements => (
        [...new Set(elements.map(element => getComputedStyle(element).color))]
      ))
      assert.ok(editorColors.length > 1, 'Editable TypeScript source has no syntax highlighting')
      assert.ok(await page.locator('.ptcPlusCodeEditor .cm-lineNumbers').count() > 0, 'Editor has no line numbers')
      const originalSource = await codeEditor.innerText()
      await codeEditor.fill('export function value(): number { return 43 }')
      await page.waitForFunction(() => [...document.querySelectorAll('.ptcPlusConsole .cm-line span')].some(node => node.textContent === '43'))
      await codeEditor.press('ControlOrMeta+z')
      assert.equal(await codeEditor.innerText(), originalSource)
      const editedSource = [
        'interface BindingSummary {',
        '  name: string',
        '  count: number',
        '  values: readonly number[]',
        '}',
        '',
        'function summarize(name: string, values: number[]): BindingSummary {',
        '  return {',
        '    name,',
        '    count: values.length,',
        '    values: values.filter(value => Number.isFinite(value)),',
        '  }',
        '}',
        '',
        '/** Return the current sample value. */',
        'export function value(): number {',
        '  const report = summarize("sample", [12, 15, 16])',
        '  return report.values.reduce((sum, item) => sum + item, 0)',
        '}',
      ].join('\n')
      await codeEditor.fill(editedSource)
      if (await page.locator('.ptcPlusExecution').getAttribute('open') === null) {
        await page.locator('.ptcPlusExecution > summary').click()
      }
      const consoleInput = page.locator('.ptcPlusExecutionInput .cm-content')
      const execute = async (code, expected) => {
        await consoleInput.fill(code)
        await consoleInput.press('ControlOrMeta+Enter')
        await page.locator('.ptcPlusExecutionOutput').last().filter({ hasText: expected }).waitFor()
        await page.getByRole('button', { name: 'Run', exact: true }).waitFor()
      }
      await execute('const current: number = value(); current', '43')
      await execute('current + 1', '44')
      await execute('let changed = 1; changed = 2; throw new Error("ordinary failure")', 'ordinary failure')
      await execute('changed', '2')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.ptcPlusConsole [role=status]').filter({ hasText: 'Entry saved' }).waitFor()
      assert.equal(await page.locator('.ptcPlusSourceBody .cm-content').count(), 0)
      await execute('typeof current', 'undefined')
      await page.locator('.ptcPlusSourceToggle').click()
      await page.locator('.ptcPlusSourceCode').getByRole('button', { name: 'Copy code', exact: true }).click()
      const savedSource = await page.evaluate(() => navigator.clipboard.readText())
      assert.equal(savedSource.replace(/\r\n/g, '\n'), editedSource)
      await consoleInput.fill('await new Promise(() => {})')
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await page.getByRole('button', { name: 'Run', exact: true }).waitFor()
      await execute('value()', '43')
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 })
        if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
        await page.locator('.ptcPlusConsole').evaluate(element => { element.scrollTop = 0 })
        await verifyReplLayout('global')
        await page.screenshot({ path: join(evidence, width === 1440 ? 'repl-global.png' : `repl-global-${width}.png`),
          fullPage: true, animations: 'disabled' })
        assert.equal(await page.locator('.ptcPlusBindings').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      }
      await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'light' } })
      await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'detached' })
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 })
        if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
        await verifyReplLayout('global-light')
        await page.screenshot({ path: join(evidence, `repl-global-light-${width}.png`), fullPage: true, animations: 'disabled' })
      }
      await rpc('settings/update', { ns: 'locale', patch: { preference: 'zh' } })
      await page.getByRole('heading', { name: '会话绑定', exact: true }).waitFor()
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 })
        if (width < 1024) await page.locator('[data-sidebar-collapsed=true]').waitFor()
        await verifyReplLayout('session-light')
        await page.screenshot({ path: join(evidence, `repl-light-${width}.png`), fullPage: true, animations: 'disabled' })
        if (width < 1024) {
          await page.locator('.ptcPlusConsole .ptcPlusCodeEditor').scrollIntoViewIfNeeded()
          await page.screenshot({ path: join(evidence, `repl-editor-light-${width}.png`), fullPage: true, animations: 'disabled' })
          await page.locator('.ptcPlusConsole').evaluate(element => { element.scrollTop = 0 })
        }
      }
      await rpc('settings/update', { ns: 'locale', patch: { preference: 'en' } })
      await page.getByRole('heading', { name: 'Session bindings', exact: true }).waitFor()
      await page.getByRole('tab', { name: 'Chat', exact: true }).click()
      await composer.waitFor({ state: 'visible' })
      assert.equal(await composerValue(composer), 'Unsent draft survives REPL navigation')
      if (handles.length > 0) assert.ok(await page.locator('[data-width-handle]').first().isVisible(), 'Chat width handles did not return')
      await page.getByRole('tab', { name: 'REPL', exact: true }).click()
      await composer.waitFor({ state: 'hidden' })
      await page.waitForFunction(() => document.querySelector('.ptcPlusConsole .ptcPlusEntrySettings input')?.value === 'workflow')
      await rpc('settings/update', { ns: 'ptc-plus', patch: { enabled: false } })
      await page.getByRole('tab', { name: 'REPL', exact: true }).waitFor({ state: 'detached' })
      await composer.waitFor({ state: 'visible' })
      assert.equal(await composerValue(composer), 'Unsent draft survives REPL navigation')
      await clearComposer(composer)
      await rpc('settings/update', { ns: 'ptc-plus', patch: { enabled: true } })
      await page.getByRole('tab', { name: 'REPL', exact: true }).waitFor()
      // The workbench shares the composer's public entry; these run last so the session
      // fixtures above stay untouched by the drafts and writes they exercise.
      await verifyDeferredFirstCatalog()
      await verifyBindingSaveIntent()
      await verifyBindingDocumentIdentity()
      await verifyWorkbenchDraftTakeover()
      await verifyApprovalTakeover(rpc)
    }
    await page.screenshot({ path: join(evidence, 'conversation.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: /^(Settings|设置)$/ }).first().click()
    await page.getByText(/^(Plugins|插件)$/).click()
    await page.locator('.ptcPlusCard').waitFor()
    await page.locator('.ptcPlusCard .ptcPlusHeader').click()
    const manage = page.getByRole('button', { name: /^(Manage global bindings|管理全局绑定)$/ })
    await manage.click()
    await page.locator('.ptcPlusBindingsModal .ptcPlusBindings').waitFor()
    if (values['binding-workflow']) await verifyWorkbenchReload(page.locator('.ptcPlusBindingsModal .ptcPlusBindings'), 'settings')
    await page.getByRole('button', { name: /^(Close global bindings workbench|关闭全局绑定工作台)$/ }).click()
    const bindingsSwitch = page.getByRole('switch', { name: /Global User Binding|全局用户 Binding/ })
    await bindingsSwitch.click()
    await manage.waitFor({ state: 'detached' })
    assert.equal(await bindingsSwitch.isChecked(), false)
    await bindingsSwitch.click()
    await manage.waitFor()
    assert.equal(await bindingsSwitch.isChecked(), true)
    await manage.click()
    if (values['binding-workflow']) {
      const consolePane = page.locator('.ptcPlusBindingsModal .ptcPlusExecution')
      await consolePane.waitFor()
      if (await consolePane.getAttribute('open') === null) await consolePane.locator('summary').click()
      assert.equal(await consolePane.locator('.ptcPlusExecutionRecord').count(), 0)
      for (const [code, expected] of [['const saved = value(); saved', '43'], ['saved + 1', '44']]) {
        await consolePane.locator('.cm-content').fill(code)
        await consolePane.getByRole('button', { name: 'Run', exact: true }).click()
        await consolePane.locator('.ptcPlusExecutionOutput').last().filter({ hasText: expected }).waitFor()
      }
      await consolePane.locator('summary').click()
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.locator('.ptcPlusBindingsModal').waitFor()
      assert.equal(await page.locator('.ptcPlusBindingsDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      await page.screenshot({ path: join(evidence, `bindings-modal-${width}.png`), fullPage: true, animations: 'disabled' })
    }
    await page.keyboard.press('Escape')
    await page.locator('.ptcPlusBindingsModal').waitFor({ state: 'detached' })
    await page.screenshot({ path: join(evidence, 'settings.png'), fullPage: true, animations: 'disabled' })
    errors.push(...consoleErrors.filter(({ text, url }) => !(hostIconFallbacks.has(url)
      && text === 'Failed to load resource: the server responded with a status of 404 (Not Found)'))
      .map(({ text }) => text.replace(/https?:\/\/\S+/g, '[URL]')))
    assert.equal(errors.length, 0, errors.join('\n'))
    if (values['binding-workflow']) {
      for (const operation of ['list', 'save-draft', 'watch', 'observe']) {
        assert.ok(pluginRpc.some(request => request.operation === operation), `Missing Remote operation: ${operation}`)
      }
      const unauthorized = await fetch(new URL('/api/ptcPlusBindings/invoke', url), { method: 'POST', body: '{}' })
      assert.equal(unauthorized.status, 401, 'Plugin Remote requires Host authentication')
    }
    await writeFile(join(evidence, 'result.json'), JSON.stringify({
      dshVersion: version, packageIntegrity,
      browser: { version: browser.version(), channel: values['browser-channel'] ?? 'chromium' },
      settings: 'ready', conversation: 'ready', pageErrors: errors,
      pluginRpc,
      hostIconFallbacks: [...hostIconFallbacks].map(value => new URL(value).pathname),
      bindingWorkflow: values['binding-workflow'] ? { model: 'deterministic-local-adapter', measurements: bindingMeasurements,
        scrollMeasurements: bindingScrollMeasurements, replMeasurements, reloadMeasurements, dockMeasurements, displayLogInvariant,
        workbench: bindingWorkbenchEvidence, workbenchLogInvariant: bindingWorkbenchEvidence.takeover?.logInvariant === true,
        approval: bindingWorkbenchEvidence.approval ?? null,
        approvalLogInvariant: bindingWorkbenchEvidence.approval?.logInvariant === true } : null,
    }, null, 2) + '\n')
    console.log(`Packed Client Web smoke passed (${version})`)
  } catch (error) {
    primaryError = error
    if (page) {
      await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
      console.error((await page.locator('body').innerText()).slice(-6000))
    }
    throw error
  } finally {
    await releaseResources([
      ['browser', async () => { await browser?.close() }],
      ['web host process', () => stopOwnedProcess(host, { state: hostEnd })],
      ['temporary profile', () => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })],
    ], primaryError)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(formatHeadlessError(error))
    process.exitCode = 1
  })
}
