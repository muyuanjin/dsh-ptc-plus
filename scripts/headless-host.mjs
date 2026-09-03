/** Shared Windows/WSL host facts for model-backed acceptance runners. */
import { execFileSync, spawn } from 'node:child_process'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { parseDocument } from 'yaml'

export const NEUTRAL_PERSONA = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
export const HEADLESS_PREREQUISITE_CODE = 'PTC-EVAL-PREREQ'
export const HEADLESS_CONFIG_CODE = 'PTC-EVAL-CONFIG'

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

function terminateProcessTree(child, platform = process.platform) {
  if (platform !== 'win32') {
    child.kill()
    return
  }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  killer.once('error', () => child.kill())
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
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      terminateProcessTree(child, options.platform)
    }, options.timeoutMs)
    timeout?.unref()
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      resolveProcess({ code: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    })
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
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$version = (& dsh --version | Out-String).Trim()',
    "if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) { throw 'dsh --version failed' }",
    "$dshHomePath = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')",
    "if ([string]::IsNullOrWhiteSpace($dshHomePath)) { $dshHomePath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }",
    '$dshHomePath = [IO.Path]::GetFullPath($dshHomePath)',
    "if (-not (Test-Path -LiteralPath $dshHomePath -PathType Container)) { throw 'DSH home directory does not exist' }",
    "[PSCustomObject]@{ dshVersion = $version; dshHome = $dshHomePath } | ConvertTo-Json -Compress",
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
    || typeof resolved?.dshHome !== 'string' || resolved.dshHome.trim() === '') {
    throw prerequisiteFailure('Windows DSH lookup did not return dshVersion and dshHome')
  }
  const dshHome = /^[a-zA-Z]:[\\/]/.test(repoRoot) ? windowsPath(resolved.dshHome) : wslPath(resolved.dshHome)
  return Object.freeze({
    repoRootWindows,
    dshVersion: resolved.dshVersion.trim(),
    dshHomeWindows: windowsPath(resolved.dshHome),
    dshHome,
    sessionsRoot: /^[a-zA-Z]:[\\/]/.test(dshHome)
      ? win32.join(dshHome, 'sessions')
      : posix.join(dshHome, 'sessions'),
  })
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
  if (systemPrompt?.includeHarnessIdentity !== false
    || systemPrompt?.includeRuntimeContext !== true
    || systemPrompt?.persona !== NEUTRAL_PERSONA) {
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
    toolsMode: toolsMode.trim(),
    permissionMode: permissionMode.trim(),
    approvalPolicy: permissionMode.trim() === 'danger-full-access' ? 'never' : 'ask',
  })
}

export function validateHeadlessRuntimeConfig(rows, label, runtime) {
  const policy = headlessRuntimePolicy(runtime)
  if (configRow(rows, 'tools', label).config?.mode !== policy.toolsMode) {
    throw new Error(`${label} does not use tools mode ${policy.toolsMode}`)
  }
  if (configRow(rows, 'sandbox-policy', label).config?.mode !== policy.permissionMode) {
    throw new Error(`${label} does not use permission mode ${policy.permissionMode}`)
  }
  if (configRow(rows, 'approval', label).config?.policy !== policy.approvalPolicy) {
    throw new Error(`${label} does not use approval policy ${policy.approvalPolicy}`)
  }
  return true
}

export function headlessConfigPatch(baseRows, runtime, options = {}) {
  const policy = headlessRuntimePolicy(runtime)
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
    `    persona: ${JSON.stringify(NEUTRAL_PERSONA)}`,
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
    `        apiKeyEnv: ${JSON.stringify(runtime.apiKeyEnv)}`,
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

/** Remove one temporary tree while retaining an earlier failure as the primary diagnostic. */
export async function cleanupOwnedPath(path, primaryError, options = {}) {
  try {
    await (options.removeTree ?? removeTree)(path)
  } catch (cleanupError) {
    if (primaryError === undefined) throw cleanupError
    if (primaryError !== null && (typeof primaryError === 'object' || typeof primaryError === 'function')) {
      cleanupErrors.set(primaryError, cleanupError)
    }
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
