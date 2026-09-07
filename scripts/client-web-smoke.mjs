import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { stringify } from 'yaml'
import { npmCliCommand } from './npm-cli.mjs'
import { extractPackFilename } from './npm-pack-filename.mjs'

const { values } = parseArgs({ options: {
  'dsh-entry': { type: 'string' },
  'browser-channel': { type: 'string' },
  'binding-workflow': { type: 'boolean', default: false },
} })
assert.ok(values['dsh-entry'], 'Pass --dsh-entry with the installed latest DSH CLI JavaScript entry')
const dshEntry = resolve(values['dsh-entry'])
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

async function verifyReplLayout(state) {
  await page.locator('[data-composer-seat] [contenteditable=true]').waitFor({ state: 'hidden' })
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
      draft: document.querySelector('[data-composer-seat] [contenteditable=true]').textContent }
  })
  assert.ok(metrics.handles.length > 0, 'Missing host width handles in fixture')
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
      scroll: element.scrollWidth, buttons: [...element.querySelectorAll('button')].map(button => ({
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
      return rect.width > 0 && rect.height > 0 && rect.left < own.right - 1 && rect.right > own.left + 1
        && rect.top < own.bottom - 1 && rect.bottom > own.top + 1
    }).map(button => button.textContent)
  })
  assert.deepEqual(headerCollisions, [], `${state}/${width}: overlapping session header actions`)
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
      { id: 'tools', config: { mode: 'ptc' } },
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
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text().replace(/https?:\/\/\S+/g, '[URL]'))
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
      const response = await fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }) })
      const result = (await response.json()).result
      if (!result.ok) throw new Error(JSON.stringify(result))
      return result.value
    }, { method, args })
    const workspace = join(temporary, 'workspace')
    await mkdir(workspace)
    await rpc('settings/update', { ns: 'locale', patch: { preference: 'en' } })
    await rpc('settings/update', { ns: 'agent-presets', patch: { default: 'ptc' } })
    await rpc('workspace/create', { request: { path: workspace } })
    await page.getByText('workspace', { exact: true }).first().hover()
    await page.getByRole('button', { name: 'New session in workspace', exact: true }).click()
    const composer = page.locator('[data-composer-seat] [contenteditable=true]')
    await composer.waitFor({ timeout: 30000 })
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
      for (const width of [390, 1440]) await captureBinding(`ready-${locale}`, width)
    }
    await page.getByRole('button', { name: 'Save and enable', exact: true }).click()
    await page.locator('.ptcPlusBindingCommand[data-phase=saved]').waitFor()
    for (const locale of ['zh', 'en']) {
      await rpc('settings/update', { ns: 'locale', patch: { preference: locale } })
      await page.getByText(locale === 'zh' ? '草稿已保存并启用' : 'Draft saved and enabled', { exact: true }).waitFor()
      await page.reload()
      await page.locator('.ptcPlusBindingCommand[data-phase=saved]').waitFor()
      assert.equal(await cards.count(), 1)
      await cards.locator('summary').click()
      assert.match(await cards.innerText(), /export function value/)
      for (const width of [390, 1440]) await captureBinding(`saved-${locale}`, width)
    }
    await verifyBindingScroll(rpc)
    await submit('/binding edit workflow same helper')
    await page.getByRole('button', { name: 'Discard draft', exact: true }).waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await page.locator('.ptcPlusBindingCommand[data-phase=discarded]').waitFor()
    assert.equal(await cards.count(), 2)
    for (const locale of ['zh', 'en']) {
      await rpc('settings/update', { ns: 'locale', patch: { preference: locale } })
      await page.getByText(locale === 'zh' ? '草稿已丢弃' : 'Draft discarded', { exact: true }).waitFor()
      await captureBinding(`discarded-${locale}`)
    }
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
    assert.ok(handles.some(handle => handle.width > 0), 'Chat width handles have no hit area')
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
    assert.equal(await composer.innerText(), 'Unsent draft survives REPL navigation')
    assert.ok(await page.locator('[data-width-handle]').first().isVisible(), 'Chat width handles did not return')
    await page.getByRole('tab', { name: 'REPL', exact: true }).click()
    await composer.waitFor({ state: 'hidden' })
    await rpc('settings/update', { ns: 'ptc-plus', patch: { enabled: false } })
    await page.getByRole('tab', { name: 'REPL', exact: true }).waitFor({ state: 'detached' })
    await composer.waitFor({ state: 'visible' })
    assert.equal(await composer.innerText(), 'Unsent draft survives REPL navigation')
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
  assert.equal(errors.length, 0, errors.join('\n'))
  await writeFile(join(evidence, 'result.json'), JSON.stringify({
    dshVersion: version, packageIntegrity,
    browser: { version: browser.version(), channel: values['browser-channel'] ?? 'chromium' },
    settings: 'ready', conversation: 'ready', pageErrors: errors,
    bindingWorkflow: values['binding-workflow'] ? { model: 'deterministic-local-adapter', measurements: bindingMeasurements,
      scrollMeasurements: bindingScrollMeasurements, replMeasurements } : null,
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
