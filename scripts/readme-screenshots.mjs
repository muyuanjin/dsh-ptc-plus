/**
 * Refresh the README's bilingual interface screenshots from a real packed Host.
 *
 * `assets/ptc-plus-repl-workspace-<locale>.png` and `assets/ptc-plus-settings-<locale>.png`
 * are the frames both READMEs embed, and this runner is their producer. It packs the current
 * checkout, installs the tarball through `dsh plugin` into an isolated `DSH_HOME`, boots the
 * official Web Host with `scripts/readme-screenshots-fixture.mjs` as a deterministic provider,
 * drives one PTC session per locale plus the plugin settings dialog, and writes the frames.
 *
 * Framing follows the product rather than the window: the settings frame photographs the
 * dialog element at the width the product gives it on a wide window, and the REPL frame
 * photographs the window with its sidebar collapsed, which is the layout both READMEs
 * describe. Both are rasterized at `CAPTURE_SCALE`, the pixel density of the committed frames.
 *
 * The operator's profile, credentials and model route stay untouched, and the run makes no
 * model request. Each capture asserts its surface is present, settled and laid out first, so a
 * broken candidate fails instead of replacing a README image with an empty or pending frame.
 * Frames are photographed into a staging directory and copied into the output directory only
 * after the whole run, including its page-error assertion, succeeds.
 *
 * Requires an installed DSH CLI, its `pnpm`, a Playwright browser, and a font that covers the
 * captured locales. Host lifecycle follows the packed Web smoke's exported owners, so both
 * runners terminate and clean up identically.
 *
 * Usage: npm run readme:screenshots -- --dsh-entry /absolute/path/to/dsh/lib/bin.js
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { stringify } from 'yaml'
import { SETTINGS_COPY } from '../src/client-copy.js'
import { releaseResources, stopOwnedProcess, watchProcessEnd } from './client-web-smoke.mjs'
import { settleVisual } from './client-visual-contract.mjs'
import { hostToolRuntime, ptcToolsMode } from './dsh-host-contract.mjs'
import { formatHeadlessError, runProcess } from './headless-host.mjs'
import { extractPackFilename } from './npm-pack-filename.mjs'
import { npmCliCommand } from './npm-cli.mjs'
import { CAPTURE_PROMPTS, CAPTURE_REPLY } from './readme-screenshots-fixture.mjs'

const README_LOCALES = Object.freeze(['zh', 'en'])
/** Conventional exit status per interruption signal, matching the repository's coverage runner. */
const INTERRUPTION_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 })
/** Raster scale and window sizes the committed frames use. */
const CAPTURE_SCALE = 1.5
const SETTINGS_VIEWPORT = Object.freeze({ width: 1600, height: 1000 })
const REPL_VIEWPORT = Object.freeze({ width: 1440, height: 1200 })
/** Every captured surface is Host- or plugin-owned; the capture only locates it. */
const COMPOSER_SELECTOR = '[data-composer-seat] :is(textarea, [contenteditable=true])'
const SIDEBAR_TOGGLE = 'button[class*="_toggle"]'
const SESSION_ROW = '[class*="_sessionRow"]'
const HOST_SETTINGS_BUTTON = Object.freeze({ zh: '设置', en: 'Settings' })
/**
 * The workspace row's session action is Host copy. Sessions are always created while the
 * interface is English, so this label and the workspace name below are the only Host copy the
 * capture reads for creation.
 */
const WORKSPACE_NAME = 'workspace'
const NEW_SESSION_ACTION = `New session in ${WORKSPACE_NAME}`

/**
 * Seeded global catalog. The enabled entries become session bindings and the disabled one
 * exercises the workbench's disabled group, so the REPL frame shows a populated workbench.
 */
const README_BINDINGS = Object.freeze([
  {
    id: 'fileTools', name: 'fileTools', scope: 'namespace', enabled: true,
    purpose: 'File-name helpers shared by every cell in the session.',
    modelContext: { includeDeclaration: true, instructions: 'Use these helpers to format file names.' },
    source: [
      'import { basename, extname } from "node:path"',
      '',
      '/** Split a file path into the parts a report needs. */',
      'export function stem(file: string): string {',
      '  return basename(file, extname(file))',
      '}',
      '',
      'export function extension(file: string): string {',
      '  return extname(file)',
      '}',
      '',
      'export function describe(files: readonly string[]): string {',
      '  return files.map(file => stem(file) + extension(file)).join(", ")',
      '}',
    ].join('\n'),
  },
  {
    id: 'textTools', name: 'textTools', scope: 'namespace', enabled: true,
    purpose: 'Normalize and compare short text values.',
    modelContext: { includeDeclaration: true, instructions: 'Use these helpers before comparing text.' },
    source: [
      '/** Normalize and compare short text values. */',
      'export function normalize(value: string): string {',
      '  return value.trim().replace(/\\s+/g, " ")',
      '}',
      '',
      'export function same(left: string, right: string): boolean {',
      '  return normalize(left) === normalize(right)',
      '}',
    ].join('\n'),
  },
  {
    id: 'jsonTools', name: 'jsonTools', scope: 'namespace', enabled: false,
    purpose: 'Read structured data from a JSON document.',
    source: [
      '/** Read structured data from a JSON document. */',
      'export function field<T>(document: Record<string, T>, name: string): T | undefined {',
      '  return document[name]',
      '}',
    ].join('\n'),
  },
])

async function waitForHostUrl(child, output, timeoutMs = 60_000) {
  return await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error(`Web Host did not start: ${output().replace(/https?:\/\/\S+/g, '[URL]').slice(-4000)}`))
    }, timeoutMs)
    const poll = setInterval(() => {
      const match = /https?:\/\/127\.0\.0\.1:\d+[^\s\u001b]*/.exec(output())
      if (match === null) return
      clearTimeout(timeout)
      clearInterval(poll)
      resolveUrl(match[0])
    }, 50)
    child.once('error', error => { clearTimeout(timeout); clearInterval(poll); reject(error) })
    child.once('exit', code => {
      clearTimeout(timeout)
      clearInterval(poll)
      reject(new Error(`Web Host exited ${code}: ${output().slice(-4000)}`))
    })
  })
}

/** The Host's own sidebar toggle, asserted through its published collapsed state. */
async function setSidebarCollapsed(page, collapsed) {
  const isCollapsed = () => page.evaluate(() => document.querySelector('[data-sidebar-collapsed]')
    ?.getAttribute('data-sidebar-collapsed') === 'true')
  if (await isCollapsed() === collapsed) return
  await page.locator(SIDEBAR_TOGGLE).first().click()
  await page.waitForFunction(expected => (document.querySelector('[data-sidebar-collapsed]')
    ?.getAttribute('data-sidebar-collapsed') === 'true') === expected, collapsed, { timeout: 10_000 })
}

/** Locale changes apply live, so the captured session keeps its live REPL observation. */
async function setLocale(page, rpc, locale) {
  await rpc('settings/update', { ns: 'locale', patch: { preference: locale } })
  await page.getByRole('button', { name: HOST_SETTINGS_BUTTON[locale], exact: true }).first()
    .waitFor({ timeout: 20_000 })
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'dsh-entry': { type: 'string' },
    'browser-channel': { type: 'string' },
    out: { type: 'string', default: 'assets' },
    locale: { type: 'string', multiple: true, default: [] },
    'keep-temp': { type: 'boolean', default: false },
  } })
  assert.ok(values['dsh-entry'], 'Pass --dsh-entry with the installed latest DSH CLI JavaScript entry')
  const dshEntry = resolve(values['dsh-entry'])
  const locales = values.locale.length === 0 ? [...README_LOCALES] : values.locale
  for (const locale of locales) assert.ok(README_LOCALES.includes(locale), `--locale must be ${README_LOCALES.join(' or ')}`)
  const repository = resolve(import.meta.dirname, '..')
  const output = resolve(repository, values.out)
  const ptcMode = ptcToolsMode(hostToolRuntime(dshEntry))
  const temporary = await mkdtemp(join(tmpdir(), 'ptc-readme-screenshots-'))
  // Frames are photographed into this staging directory and published to `output` only after the
  // whole run, including its page-error assertion, succeeds.
  const staging = await mkdtemp(join(temporary, 'frames-'))
  const env = { ...process.env, DSH_HOME: join(temporary, 'dsh-home') }
  let host
  let hostEnd
  let browser
  let page
  let primaryError
  /**
   * The `finally` below covers failures, but not signals: with no listener Node terminates on the
   * spot, so an interrupted refresh would strand its isolated profile and the Host it owns.
   */
  const ownedResources = () => [
    ['browser', async () => { await browser?.close() }],
    ['web host process', () => stopOwnedProcess(host, { state: hostEnd })],
    ['temporary profile', async () => { if (!values['keep-temp']) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }],
  ]
  const interruptions = new Map()
  for (const [signal, code] of Object.entries(INTERRUPTION_EXIT_CODES)) {
    const handler = () => {
      const exit = () => process.exit(code)
      // Cleanup that fails anyway must not keep an interrupted run alive.
      releaseResources(ownedResources(), undefined).then(exit, exit)
    }
    interruptions.set(signal, handler)
    process.on(signal, handler)
  }
  const releaseInterruptions = () => { for (const [signal, handler] of interruptions) process.off(signal, handler) }
  const run = async (executable, args, options = {}) => {
    const result = await runProcess(executable, args, { cwd: repository, env, windowsHide: true, ...options })
    if (result.code !== 0) throw new Error(`${executable} exited ${result.code}: ${result.stderr.slice(-4000)}`)
    return result.stdout
  }
  try {
    await mkdir(output, { recursive: true })
    const version = (await run(process.execPath, [dshEntry, '--version'])).trim()
    const pack = npmCliCommand(['pack', '--silent', '--json', '--pack-destination', temporary])
    const tarball = join(temporary, extractPackFilename(JSON.parse(await run(pack.executable, pack.args))))
    console.log(`Installing packed Client ${version} into an isolated Web profile`)
    await run(process.execPath, [dshEntry, 'plugin', '--profile', 'web', 'add', tarball])

    await mkdir(join(env.DSH_HOME, 'ptc-plus'), { recursive: true })
    await writeFile(join(env.DSH_HOME, 'ptc-plus', 'bindings.json'),
      `${JSON.stringify({ entries: README_BINDINGS }, null, 2)}\n`)

    const fixtureDirectory = join(temporary, 'fixture')
    await mkdir(fixtureDirectory)
    await writeFile(join(fixtureDirectory, 'package.json'),
      `${JSON.stringify({ name: 'ptc-readme-screenshot-fixture', type: 'module' })}\n`)
    await writeFile(join(fixtureDirectory, 'index.mjs'),
      `export { apply, inject } from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/readme-screenshots-fixture.mjs')).href)}\n`)

    // A patch replaces the whole row, so the permission row restates the shipped presets and
    // adds the full-access-plus-ask bundle the fixture's composed defaults match. The fixture
    // registers no ask source, so ordinary cell execution keeps the profile's decision.
    const patch = join(temporary, 'screenshots.patch.yml')
    await writeFile(patch, stringify([
      { insert: [{ id: 'readme-screenshot-fixture', name: pathToFileURL(join(fixtureDirectory, 'index.mjs')).href }] },
      { id: 'agent-default-model', config: { provider: 'readme-screenshot-fixture', model: 'fixture' } },
      ...['agent-instructions', 'skill-filesystem', 'tool-skill', 'session-title-llm'].map(id => ({ id, disabled: true })),
      { id: 'tools', config: { mode: ptcMode } },
      { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
      { id: 'approval', config: { policy: 'ask' } },
      { id: 'permission', config: { presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
        'danger-full-access-ask': { sandbox: 'danger-full-access', approval: 'ask' },
      } } },
    ]))

    let hostOutput = ''
    host = spawn(process.execPath,
      [dshEntry, '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: temporary, env, windowsHide: true })
    hostEnd = watchProcessEnd(host)
    host.stdout.on('data', chunk => { hostOutput += chunk })
    host.stderr.on('data', chunk => { hostOutput += chunk })
    const url = await waitForHostUrl(host, () => hostOutput)

    // The runner owns interruption cleanup, so Playwright must not install its own SIGINT/SIGTERM
    // handlers: they would `process.exit` before this run releases the Host and its profile.
    browser = await chromium.launch({ headless: true, channel: values['browser-channel'],
      handleSIGINT: false, handleSIGTERM: false })
    page = await browser.newPage({ viewport: REPL_VIEWPORT, deviceScaleFactor: CAPTURE_SCALE })
    page.setDefaultTimeout(20_000)
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector('[data-slot="root"]'), null, { timeout: 60_000 })
    assert.equal(await page.getByText('Failed to load plugins', { exact: true }).count(), 0, 'the packed plugin failed to load')
    for (const label of [/^(Continue|继续)$/, /^(Set up later|Configure later|稍后配置)$/]) {
      const button = page.getByRole('button', { name: label })
      await button.waitFor({ timeout: 5_000 }).catch(error => {
        if (error.name !== 'TimeoutError') throw error
      })
      if (await button.isVisible()) await button.click()
    }
    await page.locator('#ptc-plus-client-style').waitFor({ state: 'attached' })

    const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
      const service = 'ptcReadmeScreenshot'
      const response = await fetch(`/api/${service}/invoke`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(),
          method: `${service}/invoke`, payload: { args: { operation: method, payload: args } } }) })
      if (!response.ok) throw new Error(`Fixture ${method} failed: HTTP ${response.status}`)
      const envelope = (await response.json()).result
      const result = envelope.ok === true ? envelope.value : envelope
      if (result?.ok !== true) throw new Error(JSON.stringify(result))
      return result.value
    }, { method, args })
    const composer = page.locator(COMPOSER_SELECTOR)

    await setLocale(page, rpc, 'en')
    await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'light' } })
    // The REPL tab, header indicator and composer entry appear only under a PTC preset. The
    // profile default belongs to the operator, so the capture asks for the PTC preset first.
    await rpc('settings/update', { ns: 'agent-preset-registry', patch: { selectedDefault: ptcMode } })
    const workspace = join(temporary, WORKSPACE_NAME)
    await mkdir(workspace)
    await rpc('workspace/create', { request: { path: workspace } })
    await page.getByText(WORKSPACE_NAME, { exact: true }).first().waitFor({ timeout: 20_000 })

    const captured = []
    for (const locale of locales) {
      // The session title is its first user message, so each locale gets its own session and
      // therefore its own title. Creation runs in English, whose row action this capture knows.
      await setSidebarCollapsed(page, false)
      await setLocale(page, rpc, 'en')
      await page.getByText(WORKSPACE_NAME, { exact: true }).first().hover()
      await page.getByRole('button', { name: NEW_SESSION_ACTION, exact: true }).click()
      await composer.waitFor({ timeout: 30_000 })
      await composer.fill(CAPTURE_PROMPTS[locale])
      await composer.press('Enter')
      await page.getByText(CAPTURE_REPLY, { exact: false }).first().waitFor({ timeout: 90_000 })
      await page.locator('.ptcPlusTool').first().waitFor({ state: 'attached', timeout: 30_000 })
      await setLocale(page, rpc, locale)
      await page.getByText(CAPTURE_PROMPTS[locale], { exact: false }).first().waitFor({ timeout: 20_000 })

      await page.setViewportSize(SETTINGS_VIEWPORT)
      await page.locator('.ptcPlusAuthorButton').click()
      await page.getByRole('menuitem', { name: SETTINGS_COPY[locale]['settings.menuEntry'], exact: true }).click()
      const modal = page.locator('.ptcPlusSettingsModal')
      await modal.waitFor({ timeout: 30_000 })
      await page.locator('.ptcPlusSettingsModule').first().waitFor({ timeout: 30_000 })
      // The dialog takes its widest product layout in this window; a narrower frame would
      // reflow the same settings and stop matching the interface readers see.
      const modalBounds = await modal.boundingBox()
      assert.ok(modalBounds !== null && modalBounds.width >= 1200 && modalBounds.height >= 400,
        `The settings dialog does not fill a photographable area: ${JSON.stringify(modalBounds)}`)
      await settleVisual(page)
      const settingsFile = join(staging, `ptc-plus-settings-${locale}.png`)
      await modal.screenshot({ path: settingsFile, animations: 'disabled' })
      captured.push(settingsFile)
      await page.keyboard.press('Escape')
      await modal.waitFor({ state: 'detached', timeout: 30_000 })

      await page.setViewportSize(REPL_VIEWPORT)
      await setSidebarCollapsed(page, true)
      await page.getByRole('tab', { name: 'REPL', exact: true }).click()
      await page.locator('.ptcPlusConsole').waitFor({ timeout: 30_000 })
      await page.locator('.ptcPlusConsole .ptcPlusSessionBindings').waitFor({ timeout: 30_000 })
      await page.locator('.ptcPlusConsole .ptcPlusBindings').waitFor({ timeout: 30_000 })
      // Value previews arrive from the plugin's observation after the session resolves, so the
      // frame waits for that observation instead of photographing pending rows.
      await page.waitForFunction(([unobserved, pending]) => {
        const time = document.querySelector('.ptcPlusConsole .ptcPlusObservationTime')
        if (time === null || time.textContent.trim() === unobserved) return false
        return ![...document.querySelectorAll('.ptcPlusConsole .ptcPlusObservationValue')]
          .some(cell => cell.textContent.trim() === pending)
      }, [SETTINGS_COPY[locale]['console.unobserved'], SETTINGS_COPY[locale]['console.unobservedValue']],
      { timeout: 30_000 })
      const names = await page.locator('.ptcPlusConsole .ptcPlusObservationTable tbody tr')
        .evaluateAll(rows => rows.map(row => row.textContent ?? ''))
      assert.ok(names.length >= 2 && names.some(name => name.includes('summary')),
        `The captured session did not observe its bindings: ${JSON.stringify(names)}`)
      const consoleBounds = await page.locator('.ptcPlusConsole').boundingBox()
      assert.ok(consoleBounds !== null && consoleBounds.width >= 320 && consoleBounds.height >= 400,
        `The REPL console does not fill a photographable area: ${JSON.stringify(consoleBounds)}`)
      await settleVisual(page)
      const replFile = join(staging, `ptc-plus-repl-workspace-${locale}.png`)
      await page.screenshot({ path: replFile, animations: 'disabled' })
      captured.push(replFile)
    }
    assert.deepEqual(pageErrors, [], `the captured client reported page errors: ${pageErrors.join('; ')}`)
    await mkdir(output, { recursive: true })
    for (const frame of captured) {
      const published = join(output, basename(frame))
      await copyFile(frame, published)
      console.log(`Captured ${published}`)
    }
    console.log(`README screenshots refreshed from packed Client ${version} (${locales.join(', ')})`)
  } catch (error) {
    primaryError = error
    if (page !== undefined) {
      const failureDirectory = resolve(repository, 'artifacts/readme-screenshots')
      await mkdir(failureDirectory, { recursive: true })
      await page.screenshot({ path: join(failureDirectory, 'failure.png') }).catch(() => undefined)
      console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000))
    }
    throw error
  } finally {
    releaseInterruptions()
    if (values['keep-temp']) console.log(`Retained temporary profile at ${temporary}`)
    await releaseResources(ownedResources(), primaryError)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(formatHeadlessError(error))
    process.exitCode = 1
  })
}
