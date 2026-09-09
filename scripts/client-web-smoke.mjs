import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { stringify } from 'yaml'
import { npmCliCommand } from './npm-cli.mjs'
import { extractPackFilename } from './npm-pack-filename.mjs'
import { hostToolRuntime, ptcToolsMode } from './dsh-host-contract.mjs'
import { snapshotSessionLogs, decodeSessionLog } from './headless-host.mjs'

const { values } = parseArgs({ options: {
  'dsh-entry': { type: 'string' },
  'browser-channel': { type: 'string' },
  'binding-workflow': { type: 'boolean', default: false },
} })
assert.ok(values['dsh-entry'], 'Pass --dsh-entry with the installed latest DSH CLI JavaScript entry')
const dshEntry = resolve(values['dsh-entry'])
const ptcMode = ptcToolsMode(hostToolRuntime(dshEntry))
const repository = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'ptc-client-web-'))
const evidence = resolve(repository, 'artifacts/client-web-smoke')
const env = { ...process.env, DSH_HOME: join(temporary, 'dsh-home') }
let host
let browser
let page
const bindingMeasurements = []
const bindingScrollMeasurements = []
const replMeasurements = []
const reloadMeasurements = []
const dockMeasurements = []
let displayLogInvariant = false
const composerSelector = '[data-composer-seat] :is(textarea, [contenteditable=true])'

const composerValue = locator => locator.evaluate(element => 'value' in element ? element.value : element.textContent)

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
  assert.equal(await editor.innerText(), externalSource)
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

function run(executable, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd: repository, env, windowsHide: true, ...options })
    let output = ''
    let error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolveRun(output) : reject(new Error(
      `${executable} exited ${code}: ${error.slice(-4000)}`,
    )))
  })
}

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
      { id: 'approval', config: { policy: 'never' } },
    ] : []),
  ]))
  let output = ''
  host = spawn(process.execPath, [dshEntry, '--profile', 'web', '--patch', patch,
    '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: temporary, env, windowsHide: true })
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
    const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
      const response = await fetch('/api/ptcWebFixture/invoke', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'ptcWebFixture/invoke', payload: { args: { operation: method, payload: args } } }) })
      if (!response.ok) throw new Error(`Fixture ${method} failed: HTTP ${response.status}`)
      const result = (await response.json()).result
      if (!result.ok) throw new Error(JSON.stringify(result))
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
    await composer.fill('')
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
    await composer.fill('')
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
    await composer.fill('')
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
    await composer.fill('')
    await rpc('settings/update', { ns: 'ptc-plus', patch: { enabled: true } })
    await page.getByRole('tab', { name: 'REPL', exact: true }).waitFor()
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
      scrollMeasurements: bindingScrollMeasurements, replMeasurements, reloadMeasurements, dockMeasurements, displayLogInvariant } : null,
  }, null, 2) + '\n')
  console.log(`Packed Client Web smoke passed (${version})`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
    console.error((await page.locator('body').innerText()).slice(-6000))
  }
  throw error
} finally {
  await browser?.close()
  if (host && host.exitCode === null) {
    const ended = new Promise(resolveExit => host.once('exit', resolveExit))
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(host.pid), '/T', '/F'])
    else host.kill('SIGTERM')
    await ended
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
