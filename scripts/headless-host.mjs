/** Shared Windows/WSL host facts for model-backed acceptance runners. */
import { execFileSync, spawn } from 'node:child_process'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, posix, relative, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parseDocument, stringify } from 'yaml'
import { npmCliCommand } from './npm-cli.mjs'
import { RUNTIME_PROBE_PREFIX } from './repl-preflight.mjs'
import { hostPersonaPatch, hostProviderConfig, hostToolRuntime, ptcToolsMode, readHostPersona } from './dsh-host-contract.mjs'

export const NEUTRAL_PERSONA = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
export const HEADLESS_PREREQUISITE_CODE = 'PTC-EVAL-PREREQ'
export const HEADLESS_CONFIG_CODE = 'PTC-EVAL-CONFIG'
export const HEADLESS_TOOLS_MODE = 'ptc'
/** Bounded grace for one owned process tree to exit after a termination request. */
export const TERMINATION_GRACE_MS = 5_000
/** Bounded grace for the owned tree killer itself to finish before it is abandoned. */
export const TERMINATION_KILLER_MS = 2_000

const jsYamlTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: value => ({ expression: value }),
}
const cleanupErrors = new WeakMap()

function prerequisiteFailure(detail, cause = undefined) {
  return new Error(
    `${HEADLESS_PREREQUISITE_CODE}: Windows or WSL-forwarded headless evaluation prerequisite failed: ${detail}`,
    cause === undefined ? undefined : { cause },
  )
}

export function requiredModelRuntime(env, prefix) {
  const names = {
    provider: `${prefix}_PROVIDER`,
    model: `${prefix}_MODEL`,
    apiKeyEnv: `${prefix}_API_KEY_ENV`,
  }
  const runtime = {}
  for (const [field, name] of Object.entries(names)) {
    const value = env[name]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${HEADLESS_CONFIG_CODE}: ${name} must be set explicitly`)
    }
    runtime[field] = value.trim()
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtime.apiKeyEnv)) {
    throw new Error(`${HEADLESS_CONFIG_CODE}: ${names.apiKeyEnv} must name an environment variable`)
  }
  if (typeof env[runtime.apiKeyEnv] !== 'string' || env[runtime.apiKeyEnv].trim() === '') {
    throw new Error(`${HEADLESS_CONFIG_CODE}: ${runtime.apiKeyEnv} must contain the configured provider credential`)
  }
  return Object.freeze(runtime)
}

export function windowsPath(path) {
  if (/^[a-zA-Z]:[\\/]/.test(path)) return path.replaceAll('/', '\\')
  const match = path.match(/^\/mnt\/([a-zA-Z])\/(.*)$/)
  if (match === null) throw prerequisiteFailure(`cannot convert host path to a Windows drive path: ${path}`)
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`
}

export function wslPath(path) {
  if (/^\/mnt\/[a-zA-Z](?:\/|$)/.test(path)) return path
  const match = path.match(/^([a-zA-Z]):[\\/](.*)$/)
  if (match === null) throw prerequisiteFailure(`cannot convert Windows path to a WSL drive path: ${path}`)
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
}

export function powershellPath(value) {
  return value.replaceAll("'", "''")
}

function hasExited(child) {
  // Spawned children expose null before exit; injected fakes may omit the field entirely.
  return child.exitCode != null || child.signalCode != null
}

/**
 * Observe one owned child's exit and close boundaries from before an exit request can race them.
 * Exit only proves the process ended; close is the stdio boundary that carries complete output,
 * and a child that handed its pipes to a surviving descendant can exit long before it closes.
 * `dispose` removes every listener and timer this observation owns.
 */
function observeProcessLifecycle(child) {
  let exited = hasExited(child)
  let closed = false
  const waiters = new Set()
  const onExit = () => { exited = true }
  const onClose = () => {
    exited = true
    closed = true
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(true)
    }
    waiters.clear()
  }
  child.on('exit', onExit)
  child.on('close', onClose)
  return {
    exited: () => exited || hasExited(child),
    closed: () => closed,
    waitForClose(timeoutMs) {
      if (closed) return Promise.resolve(true)
      return new Promise((resolve) => {
        const waiter = { resolve, timer: undefined }
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          resolve(false)
        }, timeoutMs)
        waiter.timer.unref()
        waiters.add(waiter)
      })
    },
    dispose() {
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve(false)
      }
      waiters.clear()
    },
  }
}

/**
 * Request one owned tree's exit within a bounded window. A tree killer that stalls, fails, or
 * cannot start falls back to the direct child; the killer is itself owned and is terminated
 * rather than awaited once it outlives `killerMs`.
 */
function requestProcessTreeExit(child, platform, spawnProcess, killerMs) {
  if (platform !== 'win32') {
    child.kill('SIGTERM')
    return Promise.resolve()
  }
  let killer
  try {
    killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    child.kill()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (failed) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killer.removeListener('close', onClose)
      killer.removeListener('error', onError)
      // A killer we abandoned may still fail after we stop watching it.
      killer.on('error', () => {})
      if (failed) child.kill()
      resolve()
    }
    const onError = () => finish(true)
    const onClose = code => finish(code !== 0)
    killer.once('error', onError)
    killer.once('close', onClose)
    timer = setTimeout(() => {
      killer.kill()
      killer.unref?.()
      finish(true)
    }, killerMs)
    timer.unref()
  })
}

/**
 * Terminate one owned process tree within bounded waits. `terminated` reports observed exit;
 * `closed` reports the stdio boundary that carries complete output; `escalated` records that the
 * graceful request did not end the process before a forced kill was attempted. A process that
 * already exited is never signalled again, and no wait here is unbounded.
 */
export async function terminateProcessTree(child, options = {}) {
  const platform = options.platform ?? process.platform
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS
  const killerMs = options.killerMs ?? TERMINATION_KILLER_MS
  const lifecycle = observeProcessLifecycle(child)
  try {
    if (lifecycle.closed()) return Object.freeze({ terminated: true, escalated: false, closed: true })
    if (lifecycle.exited()) {
      // Only the output boundary is still unknown; the process itself must not be signalled.
      return Object.freeze({ terminated: true, escalated: false, closed: await lifecycle.waitForClose(graceMs) })
    }
    await requestProcessTreeExit(child, platform, options.spawn ?? spawn, killerMs)
    if (await lifecycle.waitForClose(graceMs)) return Object.freeze({ terminated: true, escalated: false, closed: true })
    if (lifecycle.exited()) {
      // A retained pipe keeps the output boundary open after the process itself is gone.
      return Object.freeze({ terminated: true, escalated: false, closed: false })
    }
    child.kill(platform === 'win32' ? undefined : 'SIGKILL')
    const forcedClose = await lifecycle.waitForClose(graceMs)
    return Object.freeze({ terminated: lifecycle.exited(), escalated: true, closed: forcedClose })
  } finally {
    lifecycle.dispose()
  }
}

export async function runProcess(command, args, options = {}) {
  return await new Promise((resolveProcess, reject) => {
    const startedAt = Date.now()
    const child = (options.spawn ?? spawn)(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timeout
    const releaseStreams = () => {
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
    }
    const settle = (result) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      releaseStreams()
      resolveProcess(result)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      releaseStreams()
      reject(error)
    }
    const abandonProcess = () => {
      // The owned process outlived its bounded cleanup window. Release our handles instead of
      // keeping the runner alive, and stop pretending its stdio will still deliver output.
      child.removeListener('close', onClose)
      child.on('error', () => {})
      for (const stream of [child.stdout, child.stderr]) {
        if (stream === undefined || stream === null) continue
        stream.on('error', () => {})
        stream.destroy?.()
      }
      child.unref?.()
    }
    const unconfirmed = (detail) => {
      // Bounded cleanup could not confirm the boundary this result needs; say so instead of waiting.
      abandonProcess()
      settle({
        code: 1,
        signal: undefined,
        stdout,
        stderr,
        timedOut: true,
        termination: 'unconfirmed',
        ...(detail === undefined ? {} : { terminationError: detail }),
        durationMs: Date.now() - startedAt,
      })
    }
    function onClose(code, signal) {
      settle({ code: code ?? 1, signal: signal ?? undefined, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    }
    timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      terminateProcessTree(child, {
        platform: options.platform,
        graceMs: options.graceMs,
        killerMs: options.killerMs,
        spawn: options.spawn,
      }).then((outcome) => {
        if (settled) return
        // Only an observed close settles through the close event with the real exit code and
        // complete output; an observed exit alone does not prove the output boundary.
        if (!outcome.terminated) unconfirmed('the owned process did not exit within the bounded termination grace')
        else if (!outcome.closed) unconfirmed('the owned process exited but its stdio did not close within the bounded termination grace')
      }, (error) => {
        if (!settled) unconfirmed(error.message)
      })
    }, options.timeoutMs)
    timeout?.unref()
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', (error) => { fail(error) })
    child.once('close', onClose)
  })
}

export function createProcessRunner(defaultCwd) {
  return (command, args, options = {}) => runProcess(command, args, {
    ...options,
    cwd: options.cwd ?? defaultCwd,
  })
}

/** Resolve every host prerequisite without creating or modifying evaluation files. */
export async function preflightHeadlessHost(repoRoot, options = {}) {
  const repoRootWindows = windowsPath(repoRoot)
  const probeUrl = pathToFileURL(win32.join(repoRootWindows, 'scripts', 'repl-preflight.mjs'), { windows: true }).href
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$dshCommand = (Get-Command dsh -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1).Source',
    `$env:NODE_OPTIONS = ($env:NODE_OPTIONS + ' --import "${powershellPath(probeUrl)}"').Trim()`,
    "$env:DSH_PTC_EVAL_PROBE = '1'",
    '$version = (& $dshCommand --version | Out-String).Trim()',
    "if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) { throw 'dsh --version failed' }",
    "$dshHomePath = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')",
    "if ([string]::IsNullOrWhiteSpace($dshHomePath)) { $dshHomePath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }",
    '$dshHomePath = [IO.Path]::GetFullPath($dshHomePath)',
    "if (-not (Test-Path -LiteralPath $dshHomePath -PathType Container)) { throw 'DSH home directory does not exist' }",
    "[PSCustomObject]@{ dshVersion = $version; dshCommand = $dshCommand; dshHome = $dshHomePath } | ConvertTo-Json -Compress",
  ].join('; ')
  let result
  try {
    result = await (options.runProcess ?? runProcess)('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-Command', command,
    ], {
      cwd: repoRoot,
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs ?? 30_000,
    })
  } catch (error) {
    throw prerequisiteFailure(`pwsh.exe could not start: ${error.message}`, error)
  }
  if (result.code !== 0) {
    throw prerequisiteFailure(`Windows DSH lookup exited with ${result.code}: ${result.stderr.trim() || 'no diagnostic'}`)
  }
  let resolved
  try {
    resolved = JSON.parse(result.stdout.trim())
  } catch (error) {
    throw prerequisiteFailure('Windows DSH lookup returned invalid JSON', error)
  }
  if (typeof resolved?.dshVersion !== 'string' || resolved.dshVersion.trim() === ''
    || typeof resolved?.dshCommand !== 'string' || resolved.dshCommand.trim() === ''
    || typeof resolved?.dshHome !== 'string' || resolved.dshHome.trim() === '') {
    throw prerequisiteFailure('Windows DSH lookup did not return dshVersion, dshCommand and dshHome')
  }
  let nodeRuntime
  try {
    const records = result.stderr.split(/\r?\n/).filter(line => line.startsWith(RUNTIME_PROBE_PREFIX))
    if (records.length !== 1) throw new Error('DSH must emit exactly one successful Node REPL probe')
    nodeRuntime = JSON.parse(records[0].slice(RUNTIME_PROBE_PREFIX.length))
    if (typeof nodeRuntime.nodeVersion !== 'string' || !nodeRuntime.nodeVersion.startsWith('v')) throw new Error('missing Node version')
    nodeRuntime.nodeExecutable = windowsPath(nodeRuntime.nodeExecutable)
    nodeRuntime.dshEntry = windowsPath(nodeRuntime.dshEntry)
  } catch (error) {
    throw prerequisiteFailure(`DSH runtime probe failed: ${error.message}`, error)
  }
  const dshHome = /^[a-zA-Z]:[\\/]/.test(repoRoot) ? windowsPath(resolved.dshHome) : wslPath(resolved.dshHome)
  return Object.freeze({
    repoRootWindows,
    dshVersion: resolved.dshVersion.trim(),
    dshCommand: windowsPath(resolved.dshCommand),
    ...nodeRuntime,
    dshHomeWindows: windowsPath(resolved.dshHome),
    dshHome,
    sessionsRoot: /^[a-zA-Z]:[\\/]/.test(dshHome)
      ? win32.join(dshHome, 'sessions')
      : posix.join(dshHome, 'sessions'),
  })
}

/** Reuse the exact Node and DSH entry whose real worker passed preflight. */
export function dshInvocation(runtime) {
  return `& '${powershellPath(runtime.nodeExecutable)}' '${powershellPath(runtime.dshEntry)}'`
}

export function parseConfigDump(text, label = 'DSH config dump') {
  const document = parseDocument(text, { customTags: [jsYamlTag] })
  if (document.errors.length > 0) {
    throw new Error(`${label} is invalid YAML: ${document.errors.map(error => error.message).join('; ')}`)
  }
  if (document.warnings.length > 0) {
    throw new Error(`${label} has YAML warnings: ${document.warnings.map(error => error.message).join('; ')}`)
  }
  const rows = document.toJS()
  if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`${label} must be an array of plugin rows`)
  }
  const ids = rows.map(row => row.id).filter(id => typeof id === 'string')
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate plugin ids`)
  return rows
}

function configRow(rows, id, label) {
  const row = rows.find(item => item.id === id)
  if (row === undefined) throw new Error(`${label} has no ${id} row`)
  return row
}

export function validateNeutralConfig(rows, label, ptcPlus = 'enabled') {
  for (const id of ['agent-instructions', 'skill', 'skill-filesystem', 'tool-skill', 'session-title-llm']) {
    if (configRow(rows, id, label).disabled !== true) throw new Error(`${label} does not disable ${id}`)
  }
  const customIdentity = rows.find(row => row.id === 'custom-harness-identity')
  if (customIdentity !== undefined && customIdentity.disabled !== true) {
    throw new Error(`${label} does not disable custom-harness-identity`)
  }
  for (const absent of ['agent-presets', 'agent-spine']) {
    if (rows.some(row => row.id === absent)) throw new Error(`${label} unexpectedly contains ${absent}`)
  }
  const systemPrompt = configRow(rows, 'system-prompt', label).config
  const persona = readHostPersona(systemPrompt)
  if (systemPrompt?.includeHarnessIdentity !== false
    || systemPrompt?.includeRuntimeContext !== true
    || persona.prefix !== NEUTRAL_PERSONA || persona.suffix !== '') {
    throw new Error(`${label} does not use the neutral system-prompt contract`)
  }
  const disabled = configRow(rows, 'ptc-plus', label).disabled === true
  if (ptcPlus === 'enabled' && disabled) throw new Error(`${label} disables ptc-plus`)
  if (ptcPlus === 'disabled' && !disabled) throw new Error(`${label} does not disable ptc-plus`)
  return true
}

function headlessRuntimePolicy(runtime) {
  const toolsMode = runtime?.toolsMode
  const permissionMode = runtime?.permissionMode
  if (typeof toolsMode !== 'string' || toolsMode.trim() === '') {
    throw new Error(`${HEADLESS_CONFIG_CODE}: toolsMode must be set explicitly`)
  }
  if (typeof permissionMode !== 'string' || permissionMode.trim() === '') {
    throw new Error(`${HEADLESS_CONFIG_CODE}: permissionMode must be set explicitly`)
  }
  return Object.freeze({
    toolsMode: toolsMode.trim() === HEADLESS_TOOLS_MODE
      ? ptcToolsMode(hostToolRuntime(runtime.dshEntry)) : toolsMode.trim(),
    permissionMode: permissionMode.trim(),
    approvalPolicy: permissionMode.trim() === 'danger-full-access' ? 'never' : 'ask',
  })
}

function mergeProviderLayers(base, user) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (user === undefined) return structuredClone(base)
  if (!record(base) || !record(user)) return structuredClone(user)
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(user)])]
    .map(key => [key, mergeProviderLayers(base[key], user[key])]))
}

/** Freeze only the chosen route before disabling unrelated user settings. */
export async function resolveHeadlessProvider(baseRows, runtime, dshHome, options = {}) {
  const settingsRow = baseRows.find(row => row.id === 'settings')
  let settings = {}
  if (settingsRow !== undefined && settingsRow.disabled !== true) {
    if (settingsRow.name !== '@deepseek-ai/dsh-settings-file'
      || Object.keys(settingsRow.config ?? {}).length > 0) {
      throw new Error(`${HEADLESS_CONFIG_CODE}: provider resolution requires the default DSH settings-file source or settings disabled with a complete provider in the profile`)
    }
    try {
      const document = parseDocument(await (options.readFile ?? readFile)(join(dshHome, 'settings.yaml'), 'utf8'))
      if (document.errors.length || document.warnings.length) throw new Error('invalid settings document')
      settings = document.toJS() ?? {}
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`${HEADLESS_CONFIG_CODE}: cannot read provider settings; check settings.yaml syntax`)
    }
  }
  const base = configRow(baseRows, 'llm-pi-ai', 'base DSH config')
  if (base.disabled === true) throw new Error(`${HEADLESS_CONFIG_CODE}: llm-pi-ai is disabled`)
  const selected = mergeProviderLayers(base.config?.providers?.[runtime.provider], settings['llm-pi-ai']?.providers?.[runtime.provider])
  if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) {
    throw new Error(`${HEADLESS_CONFIG_CODE}: selected provider must be configured in llm-pi-ai.providers`)
  }
  let providerConfig
  try {
    const Config = options.Config ?? hostProviderConfig(runtime.dshEntry)
    providerConfig = Config({ providers: { [runtime.provider]: { ...selected, apiKeyEnv: runtime.apiKeyEnv } } }).providers[runtime.provider]
  } catch {
    // Validator errors can quote private configuration values, including in their causes.
    throw new Error(`${HEADLESS_CONFIG_CODE}: selected provider configuration violates the installed DSH provider schema`)
  }
  let headers
  try {
    headers = new Headers(providerConfig.headers ?? {})
  } catch {
    throw new Error(`${HEADLESS_CONFIG_CODE}: selected provider headers must contain valid HTTP names and values`)
  }
  if (runtime.provider === 'opencode-go' && !headers.has('x-opencode-session')) {
    throw new Error(`${HEADLESS_CONFIG_CODE}: opencode-go requires an explicit x-opencode-session header`)
  }
  if (providerConfig.models?.length > 0 && !providerConfig.models.some(model => model.id === runtime.model)) {
    throw new Error(`${HEADLESS_CONFIG_CODE}: selected model absent from the provider's explicit model list`)
  }
  // Deployment values may contain private headers; manifests serialize only route identity.
  return Object.defineProperty(runtime, 'providerConfig', { value: providerConfig })
}

/** Configuration evidence retains header names without copying their values. */
export function redactHeadlessConfig(text) {
  const rows = parseConfigDump(text)
  for (const row of rows) {
    if (row.id !== 'llm-pi-ai') continue
    for (const provider of Object.values(row.config?.providers ?? {})) {
      if (provider.headers) provider.headers = Object.fromEntries(Object.keys(provider.headers).map(name => [name, '[redacted]']))
    }
  }
  return stringify(rows)
}

export function validateHeadlessRuntimeConfig(rows, label, runtime) {
  const policy = headlessRuntimePolicy(runtime)
  try {
    hostToolRuntime(runtime.dshEntry).Config(structuredClone(configRow(rows, 'tools', label).config))
  } catch (error) {
    throw new Error(`${HEADLESS_CONFIG_CODE}: ${label} violates the public DSH tools config: ${error.message}`, { cause: error })
  }
  if (configRow(rows, 'tools', label).config?.mode !== policy.toolsMode) {
    throw new Error(`${label} does not use tools mode ${policy.toolsMode}`)
  }
  if (configRow(rows, 'sandbox-policy', label).config?.mode !== policy.permissionMode) {
    throw new Error(`${label} does not use permission mode ${policy.permissionMode}`)
  }
  if (configRow(rows, 'approval', label).config?.policy !== policy.approvalPolicy) {
    throw new Error(`${label} does not use approval policy ${policy.approvalPolicy}`)
  }
  if (runtime.providerConfig !== undefined
    && !isDeepStrictEqual(configRow(rows, 'llm-pi-ai', label).config?.providers?.[runtime.provider], runtime.providerConfig)) {
    throw new Error(`${HEADLESS_CONFIG_CODE}: ${label} changed the resolved provider configuration`)
  }
  return true
}

export function headlessConfigPatch(baseRows, runtime, options = {}) {
  const policy = headlessRuntimePolicy(runtime)
  const prompt = configRow(baseRows, 'system-prompt', 'base DSH config').config
  return [
    '- id: settings',
    '  disabled: true',
    '- id: agent-instructions',
    '  disabled: true',
    '- id: tool-skill',
    '  disabled: true',
    '- id: skill-filesystem',
    '  disabled: true',
    '- id: skill',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    ...(baseRows.some(row => row.id === 'custom-harness-identity')
      ? ['- id: custom-harness-identity', '  disabled: true']
      : []),
    '- id: system-prompt',
    '  config:',
    '    includeHarnessIdentity: false',
    '    includeRuntimeContext: true',
    ...Object.entries(hostPersonaPatch(prompt, NEUTRAL_PERSONA))
      .map(([field, value]) => `    ${field}: ${JSON.stringify(value)}`),
    '- id: tools',
    '  config:',
    `    mode: ${JSON.stringify(policy.toolsMode)}`,
    '- id: sandbox-policy',
    '  config:',
    `    mode: ${JSON.stringify(policy.permissionMode)}`,
    '- id: approval',
    '  config:',
    `    policy: ${JSON.stringify(policy.approvalPolicy)}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(runtime.provider)}`,
    `    model: ${JSON.stringify(runtime.model)}`,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${JSON.stringify(runtime.provider)}:`,
    ...stringify(runtime.providerConfig ?? { apiKeyEnv: runtime.apiKeyEnv }).trimEnd().split('\n').map(line => `        ${line}`),
    ...(options.looseTopLevelFunctionClassRedeclarations === true
      ? [
        '- id: ptc-plus',
        '  config:',
        '    looseTopLevelFunctionClassRedeclarations: true',
      ]
      : []),
    ...(options.disablePtcPlus === true ? ['- id: ptc-plus', '  disabled: true'] : []),
    '',
  ].join('\n')
}

async function filesUnder(root) {
  const result = []
  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd'))) result.push(path)
    }
  }
  await visit(root)
  return result
}

export async function snapshotSessionLogs(root) {
  const snapshot = new Map()
  for (const file of await filesUnder(root)) snapshot.set(file, (await stat(file)).mtimeMs)
  return snapshot
}

export async function decodeSessionLog(file, options = {}) {
  if (file.endsWith('.jsonl')) return readFile(file, 'utf8')
  return (options.execFileSync ?? execFileSync)('zstd', ['-q', '-d', '-c', file], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

export function parseEvents(text) {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`)
    }
  })
}

export async function changedSessionLogs(root, before, startedAt, options = {}) {
  const after = await (options.snapshotSessionLogs ?? snapshotSessionLogs)(root)
  const files = []
  for (const [file, mtime] of after) {
    if (!before.has(file) || mtime > Math.max(startedAt - 1000, before.get(file) ?? 0)) files.push(file)
  }
  return await Promise.all(files.map(async (file) => {
    try {
      const text = await (options.decodeSessionLog ?? decodeSessionLog)(file)
      return { file, text, events: parseEvents(text) }
    } catch (error) {
      return { file, error: error.message }
    }
  }))
}

export function removeTree(path) {
  return rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}

/** Attach a cleanup failure to the primary error the shared formatter reports. */
export function recordCleanupFailure(primaryError, cleanupError) {
  if (primaryError !== null && (typeof primaryError === 'object' || typeof primaryError === 'function')) {
    cleanupErrors.set(primaryError, cleanupError)
  }
}

/** Remove one temporary tree while retaining an earlier failure as the primary diagnostic. */
export async function cleanupOwnedPath(path, primaryError, options = {}) {
  try {
    await (options.removeTree ?? removeTree)(path)
  } catch (cleanupError) {
    if (primaryError === undefined) throw cleanupError
    recordCleanupFailure(primaryError, cleanupError)
  }
}

export async function withOwnedPath(path, action, options = {}) {
  let primaryError
  try {
    return await action()
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await cleanupOwnedPath(path, primaryError, options)
  }
}

export function formatHeadlessError(error) {
  const primary = error?.stack ?? error?.message ?? String(error)
  const cleanup = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? cleanupErrors.get(error)
    : undefined
  return cleanup === undefined
    ? primary
    : `${primary}\nCleanup also failed: ${cleanup.stack ?? cleanup.message ?? String(cleanup)}`
}

/** Persist one process phase's output and reject the run when the phase itself failed. */
export async function checkedPhase(result, { stdoutPath, stderrPath, failed, failureMessage }) {
  await writeFile(stdoutPath, result.stdout)
  await writeFile(stderrPath, result.stderr)
  if (failed(result)) throw new Error(failureMessage)
  return result
}

/** Redacted stdout is only meaningful when the dump itself succeeded. */
function dumpArtifact(result) {
  return { ...result, stdout: result.code === 0 ? redactHeadlessConfig(result.stdout) : '' }
}

function dumpFailure(result) {
  return result.code !== 0 || result.stderr.trim() !== ''
}

/**
 * Install the development plugin and resolve the neutral isolated configuration for every
 * runner-declared variant. `host.dshHome` is the isolated home whose settings seed the route;
 * the runner passes the host-session collaborators it imported so its own injected host contract
 * stays authoritative; each runner keeps its variant patch options, validation oracle and report.
 */
export async function prepareHeadlessConfigs({
  repoRoot,
  env,
  runtime,
  host,
  artifactRoot,
  overlayRoot,
  variants,
  validate,
  label,
  invoke = dshInvocation,
  resolveProvider = resolveHeadlessProvider,
  runProcess: runProcessOption = runProcess,
}) {
  const relativeRoot = relative(repoRoot, artifactRoot)
  const invocation = invoke(runtime)
  const overlays = Object.fromEntries(variants.map(variant => [variant.id, join(overlayRoot, `${variant.id}.patch.yml`)]))
  const install = await runProcessOption('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', windowsPath(join(repoRoot, 'scripts', 'install-dev.ps1')), runtime.profile,
  ], { env: { ...env, DSH_DEV_INSTALL_NO_PAUSE: '1' }, timeoutMs: runtime.wallMs })
  await checkedPhase(install, {
    stdoutPath: join(artifactRoot, 'install.stdout.log'),
    stderrPath: join(artifactRoot, 'install.stderr.log'),
    failed: result => result.code !== 0,
    failureMessage: `${label} plugin installation failed; see ${relativeRoot}/install.*.log`,
  })

  const baseDump = await runProcessOption('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `${invocation} --profile '${powershellPath(runtime.profile)}' --dump-config`,
  ], { env, timeoutMs: runtime.wallMs })
  await checkedPhase(dumpArtifact(baseDump), {
    stdoutPath: join(artifactRoot, 'base-config.stdout.yml'),
    stderrPath: join(artifactRoot, 'base-config.stderr.log'),
    failed: dumpFailure,
    failureMessage: `${label} base DSH config preflight failed; see ${relativeRoot}`,
  })
  const baseRows = parseConfigDump(baseDump.stdout, 'base DSH config')
  await resolveProvider(baseRows, runtime, host.dshHome)

  const configs = {}
  for (const variant of variants) {
    await writeFile(overlays[variant.id], headlessConfigPatch(baseRows, runtime, variant.patchOptions))
    await writeFile(
      join(artifactRoot, `${variant.id}.patch.yml`),
      redactHeadlessConfig(await readFile(overlays[variant.id], 'utf8')),
    )
    const dump = await runProcessOption('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      `${invocation} --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlays[variant.id]))}' --dump-config`,
    ], { env, timeoutMs: runtime.wallMs })
    await checkedPhase(dumpArtifact(dump), {
      stdoutPath: join(artifactRoot, `${variant.id}-config.stdout.yml`),
      stderrPath: join(artifactRoot, `${variant.id}-config.stderr.log`),
      failed: dumpFailure,
      failureMessage: `${label} ${variant.id} config preflight failed; see ${relativeRoot}`,
    })
    configs[variant.id] = parseConfigDump(dump.stdout, `${variant.id} DSH config`)
  }
  return Object.freeze({ baseRows, overlays, configs, evidence: await validate(configs, baseRows) })
}

/** Run the keyless request-contract preflight both model-backed runners require before paid work. */
export async function preflightKeylessVerify({
  repoRoot,
  env,
  runtime,
  artifactRoot,
  label,
  runProcess: runProcessOption = runProcess,
}) {
  const command = npmCliCommand(['run', 'verify'])
  const result = await runProcessOption(command.executable, command.args, {
    cwd: repoRoot,
    env,
    timeoutMs: runtime.wallMs,
  })
  await checkedPhase(result, {
    stdoutPath: join(artifactRoot, 'keyless.stdout.log'),
    stderrPath: join(artifactRoot, 'keyless.stderr.log'),
    failed: value => value.code !== 0 || value.timedOut,
    failureMessage: `${label} keyless request-contract preflight failed; see ${relative(repoRoot, artifactRoot)}/keyless.*.log`,
  })
}

/**
 * Run one isolated DSH task and collect the session logs it produced.
 * The caller keeps its own match conditions, scenario oracle and report rendering.
 */
export async function runHeadlessTask({
  env,
  runtime,
  sessionsRoot,
  task,
  cwd,
  overlay,
  invoke = dshInvocation,
  runProcess: runProcessOption = runProcess,
}) {
  const before = await snapshotSessionLogs(sessionsRoot)
  const startedAt = Date.now()
  let process
  try {
    process = await runProcessOption('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      `${invoke(runtime)} --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlay))}' '${powershellPath(task)}'`,
    ], { cwd, env, timeoutMs: runtime.wallMs })
  } catch (error) {
    process = { code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, infrastructureError: error.message }
  }
  return Object.freeze({ process, decoded: await changedSessionLogs(sessionsRoot, before, startedAt) })
}
