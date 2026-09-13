import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import {
  HEADLESS_TOOLS_MODE,
  HEADLESS_PREREQUISITE_CODE,
  TERMINATION_GRACE_MS,
  TERMINATION_KILLER_MS,
  changedSessionLogs,
  checkedPhase,
  dshInvocation,
  cleanupOwnedPath,
  formatHeadlessError,
  headlessConfigPatch,
  parseConfigDump,
  prepareHeadlessConfigs,
  preflightHeadlessHost,
  preflightKeylessVerify,
  requiredModelRuntime,
  runHeadlessTask,
  resolveHeadlessProvider,
  redactHeadlessConfig,
  runProcess,
  snapshotSessionLogs,
  terminateProcessTree,
  validateHeadlessRuntimeConfig,
  validateNeutralConfig,
  withOwnedPath,
  windowsPath,
  wslPath,
} from '../scripts/headless-host.mjs'
import { probeReplRuntime, RUNTIME_PROBE_PREFIX } from '../scripts/repl-preflight.mjs'
import * as hostContract from '../scripts/dsh-host-contract.mjs'

const runtime = {
  provider: 'provider',
  model: 'model',
  apiKeyEnv: 'API_KEY',
  toolsMode: HEADLESS_TOOLS_MODE,
  permissionMode: 'danger-full-access',
}

function configRows(disabled = false) {
  return [
    { id: 'agent-instructions', disabled: true },
    { id: 'skill', disabled: true },
    { id: 'skill-filesystem', disabled: true },
    { id: 'tool-skill', disabled: true },
    { id: 'session-title-llm', disabled: true },
    {
      id: 'system-prompt',
      config: {
        includeHarnessIdentity: false,
        includeRuntimeContext: true,
        persona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
      },
    },
    { id: 'ptc-plus', ...(disabled ? { disabled: true } : {}) },
  ]
}

test('converts only Windows and WSL-forwarded drive paths', () => {
  assert.equal(windowsPath('/mnt/x/fixture/project'), 'X:\\fixture\\project')
  assert.equal(windowsPath('X:/fixture/project'), 'X:\\fixture\\project')
  assert.equal(wslPath('X:\\fixture\\project'), '/mnt/x/fixture/project')
  assert.throws(() => windowsPath('/srv/project'), new RegExp(HEADLESS_PREREQUISITE_CODE))
  assert.throws(() => wslPath('/home/runner/.dsh'), new RegExp(HEADLESS_PREREQUISITE_CODE))
  assert.throws(() => wslPath('\\\\server\\share'), new RegExp(HEADLESS_PREREQUISITE_CODE))
})

test('requires an explicit configured model route before host evaluation', () => {
  assert.deepEqual(requiredModelRuntime({
    TEST_PROVIDER: 'provider',
    TEST_MODEL: 'model',
    TEST_API_KEY_ENV: 'TEST_SECRET',
    TEST_SECRET: 'credential',
  }, 'TEST'), { provider: 'provider', model: 'model', apiKeyEnv: 'TEST_SECRET' })
  assert.throws(() => requiredModelRuntime({}, 'TEST'), /PTC-EVAL-CONFIG: TEST_PROVIDER/)
  assert.throws(() => requiredModelRuntime({
    TEST_PROVIDER: 'provider', TEST_MODEL: 'model', TEST_API_KEY_ENV: 'bad-name',
  }, 'TEST'), /must name an environment variable/)
  assert.throws(() => requiredModelRuntime({
    TEST_PROVIDER: 'provider', TEST_MODEL: 'model', TEST_API_KEY_ENV: 'TEST_SECRET',
  }, 'TEST'), /TEST_SECRET must contain/)
})

test('materializes only the selected provider before neutralizing settings', async () => {
  const rows = [...configRows(), { id: 'settings', name: '@deepseek-ai/dsh-settings-file' }, {
    id: 'llm-pi-ai', config: { providers: {
      provider: { apiKeyEnv: 'OLD_KEY', baseURL: 'https://example.invalid',
        headers: { 'x-base': 'base', 'x-route': 'old' }, compat: { retained: true, changed: false }, models: [{ id: 'old' }] },
      unrelated: { headers: { authorization: 'unrelated-private-value' } },
    } },
  }]
  const options = { Config: value => value, readFile: async () => `llm-pi-ai:
  providers:
    provider:
      headers: { x-route: selected-route }
      compat: { changed: true }
      models: [{ id: model }]
` }
  const selected = await resolveHeadlessProvider(rows, { ...runtime }, '/unused', options)
  assert.deepEqual(selected.providerConfig, {
    apiKeyEnv: 'API_KEY', baseURL: 'https://example.invalid',
    headers: { 'x-base': 'base', 'x-route': 'selected-route' }, compat: { retained: true, changed: true }, models: [{ id: 'model' }],
  })
  assert.equal(JSON.stringify(selected).includes('selected-route'), false)
  const patch = headlessConfigPatch(rows, selected)
  const projected = parseConfigDump(patch)
  assert.deepEqual(projected.find(row => row.id === 'llm-pi-ai').config.providers, { provider: selected.providerConfig })
  assert.equal(validateHeadlessRuntimeConfig(projected, 'selected', selected), true)
  const baseline = parseConfigDump(headlessConfigPatch(rows, selected, { disablePtcPlus: true }))
  assert.deepEqual(baseline.find(row => row.id === 'llm-pi-ai'), projected.find(row => row.id === 'llm-pi-ai'))
  assert.equal(redactHeadlessConfig(patch).includes('selected-route'), false)
  delete projected.find(row => row.id === 'llm-pi-ai').config.providers.provider.headers
  assert.throws(() => validateHeadlessRuntimeConfig(projected, 'changed', selected), /changed the resolved provider configuration/)
  for (const document of ['[', 'llm-pi-ai: { providers: { provider: null } }',
    'llm-pi-ai: { providers: { provider: { models: [{ id: other }] } } }',
    'llm-pi-ai: { providers: { provider: { headers: { "bad name": value } } } }']) {
    await assert.rejects(resolveHeadlessProvider(rows, { ...runtime }, '/unused', { ...options, readFile: async () => document }), /PTC-EVAL-CONFIG/)
  }
  const absent = { ...options, readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }) } }
  await assert.rejects(resolveHeadlessProvider(rows, { ...runtime, provider: 'missing' }, '/unused', absent), /selected provider must be configured/)
  await assert.rejects(resolveHeadlessProvider(rows.map(row => row.id === 'settings' ? { ...row, name: 'custom' } : row),
    { ...runtime }, '/unused', options), /default DSH settings-file/)
})

test('requires provider-specific routing headers before paid model work', async () => {
  const rows = [...configRows(), { id: 'settings', name: '@deepseek-ai/dsh-settings-file' }, {
    id: 'llm-pi-ai', config: { providers: {
      'opencode-go': { api: 'openai-completions', baseURL: 'https://example.invalid', models: [{ id: 'model' }] },
    } },
  }]
  const options = { Config: value => value, readFile: async () => '' }
  await assert.rejects(resolveHeadlessProvider(rows, { ...runtime, provider: 'opencode-go' }, '/unused', options), /x-opencode-session/)
  rows.find(row => row.id === 'llm-pi-ai').config.providers['opencode-go'].headers = { 'X-Opencode-Session': 'session' }
  const resolved = await resolveHeadlessProvider(rows, { ...runtime, provider: 'opencode-go' }, '/unused', options)
  assert.equal(resolved.providerConfig.headers['X-Opencode-Session'], 'session')
})

test('provider validation errors never retain private values in diagnostics or causes', async () => {
  const secret = 'synthetic-private-header-value'
  const rows = headers => [{ id: 'llm-pi-ai', config: { providers: { provider: { headers } } } }]
  for (const headers of [
    { Authorization: `Bearer ${secret}\ninvalid` },
    { Cookie: `${secret}\rbroken` },
    { 'x-session': `${secret}\u0100` },
    { [`${secret} invalid-name`]: 'value' },
  ]) {
    await assert.rejects(resolveHeadlessProvider(rows(headers), { ...runtime }, '/unused', { Config: value => value }), error => {
      assert.match(error.message, /PTC-EVAL-CONFIG: selected provider headers/)
      assert.equal(error.cause, undefined)
      assert.equal(formatHeadlessError(error).includes(secret), false)
      return true
    })
  }
  await assert.rejects(resolveHeadlessProvider(rows({ Authorization: secret }), { ...runtime }, '/unused', {
    Config() { throw new Error(`invalid field: ${secret}`, { cause: new Error(secret) }) },
  }), error => {
    assert.match(error.message, /PTC-EVAL-CONFIG: selected provider configuration.*schema/)
    assert.equal(error.cause, undefined)
    assert.equal(formatHeadlessError(error).includes(secret), false)
    return true
  })
})

test('empty and absent model lists preserve the host catalog and model overrides', async () => {
  for (const models of [undefined, [], [{ id: runtime.model }], [{ id: 'other' }]]) {
    const provider = {
      ...(models === undefined ? {} : { models }),
      ...(models?.length ? {} : { modelOverrides: { [runtime.model]: { maxTokens: 512 } } }),
    }
    const rows = [...configRows(), { id: 'llm-pi-ai', config: { providers: { provider } } }]
    const resolveProvider = () => resolveHeadlessProvider(rows, { ...runtime }, '/unused', { Config: value => value })
    if (models?.[0]?.id === 'other') {
      await assert.rejects(resolveProvider(), /selected model absent/)
      continue
    }
    const selected = await resolveProvider()
    assert.deepEqual(selected.providerConfig, { ...provider, apiKeyEnv: runtime.apiKeyEnv })
    for (const disablePtcPlus of [false, true]) {
      const patch = parseConfigDump(headlessConfigPatch(rows, selected, { disablePtcPlus }))
      assert.deepEqual(patch.find(row => row.id === 'llm-pi-ai').config.providers.provider, selected.providerConfig)
    }
  }
})

test('resolves the Windows host before callers create artifacts', async () => {
  const calls = []
  const host = await preflightHeadlessHost('/mnt/x/fixture/project', {
    env: { DSH_HOME: 'ignored-by-host' },
    async runProcess(...args) {
      calls.push(args)
      return {
        code: 0,
        stdout: JSON.stringify({ dshVersion: 'dsh observed-release', dshCommand: 'X:\\fixture\\bin\\dsh.cmd', dshHome: 'X:\\fixture\\home\\.dsh' }),
        stderr: RUNTIME_PROBE_PREFIX + JSON.stringify({ nodeVersion: 'v24.0.0', nodeExecutable: 'X:\\fixture\\node.exe', dshEntry: 'X:\\fixture\\dsh.js' }),
      }
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'pwsh.exe')
  assert.equal(calls[0][2].cwd, '/mnt/x/fixture/project')
  assert.equal(host.repoRootWindows, 'X:\\fixture\\project')
  assert.equal(host.dshCommand, 'X:\\fixture\\bin\\dsh.cmd')
  assert.equal(host.nodeExecutable, 'X:\\fixture\\node.exe')
  assert.equal(host.nodeVersion, 'v24.0.0')
  assert.equal(dshInvocation(host), "& 'X:\\fixture\\node.exe' 'X:\\fixture\\dsh.js'")
  assert.equal(host.dshHome, '/mnt/x/fixture/home/.dsh')
  assert.equal(host.sessionsRoot, '/mnt/x/fixture/home/.dsh/sessions')

  let invoked = false
  await assert.rejects(preflightHeadlessHost('/srv/project', {
    async runProcess() { invoked = true },
  }), new RegExp(HEADLESS_PREREQUISITE_CODE))
  assert.equal(invoked, false)
  await assert.rejects(preflightHeadlessHost('/mnt/x/fixture/project', {
    async runProcess() { throw new Error('spawn ENOENT') },
  }), /PTC-EVAL-PREREQ:.*pwsh\.exe could not start: spawn ENOENT/)
})

test('missing runtime evidence prevents the paid runner from reaching model work', async () => {
  let modelCalls = 0
  await assert.rejects(async () => {
    await preflightHeadlessHost('/mnt/x/fixture/project', {
      runProcess: async () => ({ code: 0, stdout: JSON.stringify({
        dshVersion: 'observed', dshCommand: 'X:/dsh.cmd', dshHome: 'X:/home',
      }), stderr: '' }),
    })
    modelCalls++
  }, /runtime probe failed/)
  assert.equal(modelCalls, 0)
})

test('the keyless runtime probe executes real persistent cells with the current executable', async () => {
  const observed = await probeReplRuntime()
  assert.equal(observed.nodeExecutable, process.execPath)
  assert.equal(observed.nodeVersion, process.version)
})

test('owns neutral config parsing and projection for both runners', () => {
  const rows = configRows()
  assert.equal(validateNeutralConfig(rows, 'acceptance config'), true)
  assert.equal(validateNeutralConfig(configRows(true), 'baseline config', 'disabled'), true)
  const projected = parseConfigDump(headlessConfigPatch(rows, runtime))
  assert.equal(projected.find(row => row.id === 'system-prompt').config.includeRuntimeContext, true)
  assert.equal(projected.find(row => row.id === 'tools').config.mode, hostContract.ptcToolsMode())
  assert.equal(projected.find(row => row.id === 'sandbox-policy').config.mode, 'danger-full-access')
  assert.equal(projected.find(row => row.id === 'approval').config.policy, 'never')
  assert.equal(validateHeadlessRuntimeConfig(projected, 'projected config', runtime), true)
  assert.equal(projected.find(row => row.id === 'ptc-plus'), undefined)
  const baseline = parseConfigDump(headlessConfigPatch(rows, runtime, { disablePtcPlus: true }))
  assert.equal(baseline.find(row => row.id === 'ptc-plus').disabled, true)

  const restrictedRuntime = { ...runtime, permissionMode: 'workspace-write' }
  const restricted = parseConfigDump(headlessConfigPatch(rows, restrictedRuntime))
  assert.equal(restricted.find(row => row.id === 'approval').config.policy, 'ask')
  assert.equal(validateHeadlessRuntimeConfig(restricted, 'restricted config', restrictedRuntime), true)
  const functionClassLoose = parseConfigDump(headlessConfigPatch(rows, runtime, {
    looseTopLevelFunctionClassRedeclarations: true,
  }))
  assert.equal(functionClassLoose.find(row => row.id === 'ptc-plus').config.looseTopLevelFunctionClassRedeclarations, true)
  assert.throws(() => headlessConfigPatch(rows, { ...runtime, toolsMode: '' }), /toolsMode must be set explicitly/)
  assert.throws(() => headlessConfigPatch(rows, { ...runtime, permissionMode: undefined }), /permissionMode must be set explicitly/)
})

test('checks generated tools settings against the public Host schema, independently of runner expectations', () => {
  const rows = parseConfigDump(headlessConfigPatch(configRows(), runtime))
  assert.equal(rows.find(row => row.id === 'tools').config.mode, hostContract.ptcToolsMode())
  assert.equal(validateHeadlessRuntimeConfig(rows, 'accepted config', runtime), true)
  const unsupported = { ...runtime, toolsMode: 'unsupported-test-mode' }
  const unsupportedRows = parseConfigDump(headlessConfigPatch(configRows(), unsupported))
  assert.throws(() => validateHeadlessRuntimeConfig(unsupportedRows, 'unsupported config', unsupported), /PTC-EVAL-CONFIG:.*public DSH tools config/)
  rows.find(row => row.id === 'tools').config.maxParallelSubCalls = 0
  assert.throws(() => validateHeadlessRuntimeConfig(rows, 'invalid tools settings', runtime), /public DSH tools config/)
})

test('replaces both parts of the split host persona while retaining legacy configuration', () => {
  const rows = configRows()
  const prompt = rows.find(row => row.id === 'system-prompt').config
  const neutral = prompt.persona
  delete prompt.persona
  prompt.personaPrefix = 'Deployment prefix'
  prompt.personaSuffix = 'Deployment suffix'
  const patch = parseConfigDump(headlessConfigPatch(rows, runtime))
  const updated = patch.find(row => row.id === 'system-prompt').config
  assert.equal(updated.personaPrefix, neutral)
  assert.equal(updated.personaSuffix, '')
  assert.equal(Object.hasOwn(updated, 'persona'), false)
  Object.assign(prompt, updated)
  assert.equal(validateNeutralConfig(rows, 'split persona'), true)
  prompt.personaSuffix = 'Unexpected suffix'
  assert.throws(() => validateNeutralConfig(rows, 'split persona'), /neutral system-prompt contract/)
  prompt.personaSuffix = ''
  prompt.personaPrefix = 'Unexpected prefix'
  assert.throws(() => validateNeutralConfig(rows, 'split persona'), /neutral system-prompt contract/)
})

test('returns one timeout result after terminating the owned process', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => queueMicrotask(() => child.emit('close', null))
  const keepAlive = setInterval(() => {}, 100)
  const result = await runProcess('command', [], {
    cwd: '/tmp',
    timeoutMs: 1,
    platform: 'linux',
    spawn() { return child },
  }).finally(() => clearInterval(keepAlive))
  assert.equal(result.code, 1)
  assert.equal(result.timedOut, true)
  assert.equal(typeof result.durationMs, 'number')
})

test('discovers and decodes changed session logs through one owner', async (t) => {
  const root = join(tmpdir(), `ptc-headless-logs-${process.pid}-${Date.now()}`)
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'nested'), { recursive: true })
  const before = await snapshotSessionLogs(root)
  const file = join(root, 'nested', 'session.jsonl')
  await writeFile(file, '{"type":"session"}\n')
  const changed = await changedSessionLogs(root, before, 0)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].file, file)
  assert.deepEqual(changed[0].events, [{ type: 'session' }])
})

test('removes owned paths and preserves primary cleanup evidence', async (t) => {
  const root = join(tmpdir(), `ptc-headless-cleanup-${process.pid}-${Date.now()}`)
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'temporary.txt'), 'temporary')
  await cleanupOwnedPath(root)
  await assert.rejects(readFile(join(root, 'temporary.txt'), 'utf8'), { code: 'ENOENT' })

  const primary = new Error('validation failed')
  await cleanupOwnedPath(root, primary, {
    async removeTree() { throw new Error('cleanup failed') },
  })
  assert.match(formatHeadlessError(primary), /validation failed[\s\S]*Cleanup also failed:[\s\S]*cleanup failed/)
  await assert.rejects(cleanupOwnedPath(root, undefined, {
    async removeTree() { throw new Error('cleanup failed alone') },
  }), /cleanup failed alone/)
})

test('cleans an owned workspace after failures at every runner stage', async (t) => {
  const parent = join(tmpdir(), `ptc-headless-stages-${process.pid}-${Date.now()}`)
  t.after(() => rm(parent, { recursive: true, force: true }))
  for (const stage of ['snapshot', 'decode', 'validation', 'report']) {
    const workspace = join(parent, stage)
    await mkdir(workspace, { recursive: true })
    await assert.rejects(withOwnedPath(workspace, async () => {
      throw new Error(`${stage} failed`)
    }), new RegExp(`${stage} failed`))
    await assert.rejects(readFile(workspace, 'utf8'), { code: 'ENOENT' })
  }
})

function fakeChild(overrides = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    return true
  }
  return Object.assign(child, overrides)
}

/** Grace timers are unref'd, so a test without a live child must hold the loop open itself. */
function holdEventLoop(t) {
  const timer = setInterval(() => {}, 25)
  t.after(() => clearInterval(timer))
}

test('reports termination only after the owned child actually closes', async () => {
  const child = fakeChild({
    kill(signal) {
      child.signals.push(signal)
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('close', null, signal)
      })
      return true
    },
  })
  const outcome = await terminateProcessTree(child, { platform: 'linux', graceMs: 50 })
  assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(TERMINATION_GRACE_MS, 5_000)
  assert.equal(TERMINATION_KILLER_MS, 2_000)
})

test('treats a child without exit bookkeeping as running until it closes', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 7
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    queueMicrotask(() => child.emit('close', null, signal))
    return true
  }
  const outcome = await terminateProcessTree(child, { platform: 'linux', graceMs: 50 })
  assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('escalates to a forced kill when the child ignores the graceful request', async (t) => {
  holdEventLoop(t)
  const child = fakeChild({
    kill(signal) {
      child.signals.push(signal)
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          child.signalCode = 'SIGKILL'
          child.emit('close', null, 'SIGKILL')
        })
      }
      return true
    },
  })
  const outcome = await terminateProcessTree(child, { platform: 'linux', graceMs: 20 })
  assert.deepEqual(outcome, { terminated: true, escalated: true, closed: true })
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
})

test('does not signal an owned child that already exited and never claims its output boundary', async (t) => {
  holdEventLoop(t)
  const child = fakeChild({ exitCode: 0 })
  const outcome = await terminateProcessTree(child, { platform: 'linux', graceMs: 20 })
  // Exit is observed, but stdio never closed, so complete output is not established.
  assert.deepEqual(outcome, { terminated: true, escalated: false, closed: false })
  assert.deepEqual(child.signals, [])
})

test('terminates the Windows process tree through the injected tree killer', async () => {
  const child = fakeChild()
  const spawned = []
  const outcome = await terminateProcessTree(child, {
    platform: 'win32',
    graceMs: 50,
    spawn(command, args, options) {
      spawned.push({ command, args, options })
      const killer = new EventEmitter()
      queueMicrotask(() => {
        child.signalCode = 'SIGTERM'
        child.emit('close', 1, 'SIGTERM')
        killer.emit('close', 0)
      })
      return killer
    },
  })
  assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
  assert.deepEqual(spawned.map(item => item.command), ['taskkill.exe'])
  assert.deepEqual(spawned[0].args, ['/PID', '4242', '/T', '/F'])
  assert.deepEqual(spawned[0].options.stdio, 'ignore')
  assert.deepEqual(child.signals, [])
})

test('falls back to the direct child when the Windows tree killer fails', async () => {
  const failingKiller = (outcome) => () => {
    const killer = new EventEmitter()
    queueMicrotask(() => outcome === 'error' ? killer.emit('error', new Error('taskkill missing')) : killer.emit('close', 1))
    return killer
  }
  for (const outcome of ['error', 'nonzero']) {
    const child = fakeChild({
      kill(signal) {
        child.signals.push(signal)
        queueMicrotask(() => {
          child.exitCode = 1
          child.emit('close', 1)
        })
        return true
      },
    })
    const result = await terminateProcessTree(child, { platform: 'win32', graceMs: 50, spawn: failingKiller(outcome) })
    assert.deepEqual(result, { terminated: true, escalated: false, closed: true })
    assert.deepEqual(child.signals, [undefined])
  }
})

test('falls back to the direct child when the Windows tree killer cannot start', async () => {
  const child = fakeChild({
    kill(signal) {
      child.signals.push(signal)
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('close', 0)
      })
      return true
    },
  })
  const outcome = await terminateProcessTree(child, {
    platform: 'win32',
    graceMs: 50,
    spawn() { throw new Error('taskkill.exe is unavailable') },
  })
  assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
  assert.deepEqual(child.signals, [undefined])
})

test('abandons a tree killer that never finishes within its bounded window', async (t) => {
  holdEventLoop(t)
  const child = fakeChild({
    kill(signal) {
      child.signals.push(signal)
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('close', 0)
      })
      return true
    },
  })
  const killers = []
  const outcome = await terminateProcessTree(child, {
    platform: 'win32',
    graceMs: 200,
    killerMs: 20,
    spawn() {
      const killer = new EventEmitter()
      killer.killed = []
      killer.kill = signal => { killer.killed.push(signal); return true }
      killer.unref = () => {}
      killers.push(killer)
      return killer
    },
  })
  assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
  // The stalled killer is terminated rather than awaited, and the direct child is still requested to exit.
  assert.deepEqual(killers[0].killed, [undefined])
  assert.deepEqual(child.signals, [undefined])
})

test('keeps the close boundary observed while the tree killer is still pending', async () => {
  const child = fakeChild()
  let killerFinished = false
  const outcome = await terminateProcessTree(child, {
    platform: 'win32',
    graceMs: 500,
    killerMs: 1_000,
    spawn() {
      const killer = new EventEmitter()
      killer.kill = () => true
      queueMicrotask(() => {
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
        child.emit('close', null, 'SIGTERM')
        queueMicrotask(() => {
          killerFinished = true
          killer.emit('close', 0)
        })
      })
      return killer
    },
  })
  assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
  assert.equal(killerFinished, true)
  // A tree killer that succeeded is never second-guessed with a direct kill.
  assert.deepEqual(child.signals, [])
})

test('settles with an unconfirmed termination instead of waiting on a child that never exits', async (t) => {
  holdEventLoop(t)
  const child = fakeChild()
  const result = await runProcess('command', [], {
    cwd: '/tmp',
    timeoutMs: 1,
    graceMs: 10,
    platform: 'linux',
    spawn() { return child },
  })
  assert.equal(result.code, 1)
  assert.equal(result.timedOut, true)
  assert.equal(result.termination, 'unconfirmed')
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
})

test('settles once with the real exit code when the child closes during termination', async (t) => {
  holdEventLoop(t)
  const child = fakeChild({
    kill(signal) {
      child.signals.push(signal)
      setTimeout(() => {
        child.exitCode = 3
        child.emit('close', 3)
      }, 5)
      return true
    },
  })
  const result = await runProcess('command', [], {
    cwd: '/tmp',
    timeoutMs: 1,
    graceMs: 500,
    platform: 'linux',
    spawn() { return child },
  })
  assert.equal(result.code, 3)
  assert.equal(result.timedOut, true)
  assert.equal(result.termination, undefined)
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('keeps the final stderr chunk that arrives after exit and before close', async (t) => {
  holdEventLoop(t)
  const child = fakeChild({
    kill(signal) {
      child.signals.push(signal)
      queueMicrotask(() => {
        child.exitCode = 2
        child.emit('exit', 2)
        child.stderr.emit('data', 'final diagnostic')
        child.emit('close', 2)
      })
      return true
    },
  })
  const result = await runProcess('command', [], {
    cwd: '/tmp',
    timeoutMs: 1,
    graceMs: 100,
    platform: 'linux',
    spawn() { return child },
  })
  assert.equal(result.code, 2)
  assert.equal(result.timedOut, true)
  assert.equal(result.termination, undefined)
  assert.equal(result.stderr, 'final diagnostic')
})

test('settles unconfirmed when the owned child exits but its stdio never closes', async (t) => {
  holdEventLoop(t)
  const child = fakeChild({
    kill(signal) {
      child.signals.push(signal)
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('exit', 0)
      })
      return true
    },
  })
  const pending = runProcess('command', [], {
    cwd: '/tmp',
    timeoutMs: 1,
    graceMs: 20,
    platform: 'linux',
    spawn() { return child },
  })
  child.stderr.emit('data', 'partial diagnostic')
  const result = await pending
  assert.equal(result.code, 1)
  assert.equal(result.timedOut, true)
  assert.equal(result.termination, 'unconfirmed')
  assert.match(result.terminationError, /stdio did not close/)
  assert.equal(result.stderr, 'partial diagnostic')
  // An observed exit is not escalated and never promoted to complete output.
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('settles unconfirmed when a stalled tree killer leaves the child running', async (t) => {
  holdEventLoop(t)
  const child = fakeChild()
  let spawned = 0
  const result = await runProcess('command', [], {
    cwd: '/tmp',
    timeoutMs: 1,
    graceMs: 10,
    killerMs: 5,
    platform: 'win32',
    spawn() {
      // The first spawn is the managed child; the tree killer it requests never finishes.
      return spawned++ === 0 ? child : Object.assign(new EventEmitter(), { kill: () => true })
    },
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.termination, 'unconfirmed')
  assert.match(result.terminationError, /did not exit/)
  // The stalled killer is abandoned, the direct child is killed, then escalated.
  assert.deepEqual(child.signals, [undefined, undefined])
})

const posixOnly = process.platform === 'win32' ? 'the POSIX signal path is platform-specific' : false
const windowsOnly = process.platform === 'win32' ? false : 'the Windows tree killer is platform-specific'

test('terminates a real Windows process tree within the bounded grace', { skip: windowsOnly }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 250)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    const outcome = await terminateProcessTree(child, { graceMs: TERMINATION_GRACE_MS })
    assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
})

test('abandons a real tree killer that outlives its bounded window', { skip: windowsOnly }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 250)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    const startedAt = Date.now()
    const outcome = await terminateProcessTree(child, {
      graceMs: 1_000,
      killerMs: 500,
      // A real process stands in for a taskkill that never returns.
      spawn: () => spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 250)"], {
        stdio: 'ignore',
        windowsHide: true,
      }),
    })
    assert.deepEqual(outcome, { terminated: true, escalated: false, closed: true })
    assert.ok(Date.now() - startedAt < 5_000, 'bounded cleanup must not wait for the stalled killer')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
})

test('escalates a real child that ignores the graceful signal', { skip: posixOnly }, async () => {
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 250)",
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    // Terminating before the handler exists would only exercise the default disposition.
    await once(child.stdout, 'data')
    const outcome = await terminateProcessTree(child, { graceMs: 500 })
    assert.deepEqual(outcome, { terminated: true, escalated: true, closed: true })
    assert.equal(child.signalCode, 'SIGKILL')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('bounds a real child whose stdio stays open through a surviving descendant', { skip: posixOnly }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-retained-stdio-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pidFile = join(directory, 'descendant.pid')
  const script = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 250)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })",
    'descendant.unref()',
    `writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid))`,
  ].join('; ')
  let descendantPid
  t.after(() => {
    if (descendantPid === undefined) return
    try {
      process.kill(descendantPid, 'SIGKILL')
    } catch {
      // The descendant already exited.
    }
  })
  const result = await runProcess(process.execPath, ['-e', script], {
    cwd: directory,
    timeoutMs: 300,
    graceMs: 500,
  })
  descendantPid = Number(await readFile(pidFile, 'utf8'))
  assert.equal(Number.isInteger(descendantPid), true)
  assert.equal(result.timedOut, true)
  assert.equal(result.termination, 'unconfirmed')
  assert.match(result.terminationError, /stdio did not close/)
})

test('bounds a real child that outlives its timeout on this platform', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 250)'], {
    cwd: tmpdir(),
    timeoutMs: 100,
    graceMs: TERMINATION_GRACE_MS,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.termination, undefined)
  assert.notEqual(result.code, 0)
  assert.equal(typeof result.durationMs, 'number')
})

test('persists both phase logs before reporting a failed phase', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-checked-phase-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stdoutPath = join(root, 'phase.stdout.log')
  const stderrPath = join(root, 'phase.stderr.log')
  const options = {
    stdoutPath,
    stderrPath,
    failed: result => result.code !== 0,
    failureMessage: 'synthetic phase failure',
  }
  const passed = await checkedPhase({ code: 0, stdout: 'complete', stderr: '' }, options)
  assert.equal(passed.code, 0)
  assert.equal(await readFile(stdoutPath, 'utf8'), 'complete')
  await assert.rejects(
    checkedPhase({ code: 2, stdout: 'partial output', stderr: 'phase diagnostics' }, options),
    /synthetic phase failure/,
  )
  assert.equal(await readFile(stdoutPath, 'utf8'), 'partial output')
  assert.equal(await readFile(stderrPath, 'utf8'), 'phase diagnostics')
})

test('runs the keyless request-contract preflight and keeps both logs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-keyless-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { FIXTURE_KEY: 'synthetic-credential' }
  const calls = []
  const runProcessOption = async (executable, args, options) => {
    calls.push({ executable, args, options })
    return { code: 0, stdout: 'contract verified', stderr: '', timedOut: false }
  }
  await preflightKeylessVerify({
    repoRoot: '/mnt/x/repo',
    env,
    runtime: { wallMs: 1234 },
    artifactRoot: root,
    label: 'focused',
    runProcess: runProcessOption,
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.slice(-2), ['run', 'verify'])
  assert.equal(calls[0].options.cwd, '/mnt/x/repo')
  assert.equal(calls[0].options.env, env)
  assert.equal(calls[0].options.timeoutMs, 1234)
  assert.equal(await readFile(join(root, 'keyless.stdout.log'), 'utf8'), 'contract verified')
  assert.equal(await readFile(join(root, 'keyless.stderr.log'), 'utf8'), '')

  for (const failure of [{ code: 1, timedOut: false }, { code: 0, timedOut: true }]) {
    await assert.rejects(preflightKeylessVerify({
      repoRoot: '/mnt/x/repo',
      env,
      runtime: { wallMs: 1234 },
      artifactRoot: root,
      label: 'focused',
      runProcess: async () => ({ stdout: '', stderr: 'keyless diagnostics', ...failure }),
    }), /focused keyless request-contract preflight failed/)
  }
  assert.equal(await readFile(join(root, 'keyless.stderr.log'), 'utf8'), 'keyless diagnostics')
})

test('runs one isolated task and collects the session logs it produced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-headless-task-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionsRoot = join(root, 'sessions')
  const overlay = '/mnt/x/fixture/plugin.patch.yml'
  const env = { FIXTURE_KEY: 'synthetic-credential' }
  const calls = []
  const runProcessOption = async (executable, args, options) => {
    calls.push({ executable, args, options })
    await mkdir(sessionsRoot, { recursive: true })
    await writeFile(join(sessionsRoot, 'session.jsonl'), '{"type":"fixture"}\n')
    return { code: 0, stdout: 'task complete', stderr: '', timedOut: false }
  }
  const { process: result, decoded } = await runHeadlessTask({
    env,
    runtime: { profile: 'fixture-profile', nodeExecutable: 'X:\\node.exe', dshEntry: 'X:\\dsh.js', wallMs: 4321 },
    sessionsRoot,
    task: 'run the isolated fixture task',
    cwd: root,
    overlay,
    runProcess: runProcessOption,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, 'pwsh.exe')
  assert.equal(calls[0].options.cwd, root)
  assert.equal(calls[0].options.env, env)
  assert.equal(calls[0].options.timeoutMs, 4321)
  const command = calls[0].args.at(-1)
  assert.match(command, /--profile 'fixture-profile'/)
  assert.ok(command.includes(`--patch '${windowsPath(overlay)}'`))
  assert.match(command, /'run the isolated fixture task'$/)
  assert.equal(result.stdout, 'task complete')
  assert.deepEqual(decoded.map(entry => entry.events), [[{ type: 'fixture' }]])

  const infrastructure = await runHeadlessTask({
    env,
    runtime: { profile: 'fixture-profile', nodeExecutable: 'X:\\node.exe', dshEntry: 'X:\\dsh.js', wallMs: 4321 },
    sessionsRoot: join(root, 'absent-sessions'),
    task: 'run the isolated fixture task',
    cwd: root,
    overlay,
    runProcess: async () => { throw new Error('synthetic spawn failure') },
  })
  assert.equal(infrastructure.process.code, 1)
  assert.equal(infrastructure.process.infrastructureError, 'synthetic spawn failure')
  assert.deepEqual(infrastructure.decoded, [])
})

test('installs once and resolves every variant overlay before the runner oracle', async (t) => {
  // The host forwards its workspace to PowerShell, which only exists on Windows
  // or inside WSL; a native POSIX host cannot convert the path.
  if (process.platform !== 'win32' && process.env.WSL_DISTRO_NAME === undefined) {
    t.skip('requires a Windows or WSL-forwarded host')
    return
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await mkdir(join(repoRoot, 'artifacts'), { recursive: true })
  const root = await mkdtemp(join(repoRoot, 'artifacts', 'ptc-prepare-configs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifactRoot = join(root, 'artifacts')
  const overlayRoot = join(root, 'overlays')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(overlayRoot, { recursive: true })
  t.mock.module('../scripts/dsh-host-contract.mjs', {
    namedExports: { ...hostContract, hostProviderConfig: () => value => value },
  })
  const { prepareHeadlessConfigs } = await import('../scripts/headless-host.mjs?prepare-configs')
  const secret = 'synthetic-private-route'
  const baseRows = [
    { id: 'system-prompt', config: { persona: 'Deployment persona for {{model}} in {{cwd}}.' } },
    { id: 'llm-pi-ai', config: { providers: { fixture: { models: [{ id: 'model' }], headers: { 'x-route': secret } } } } },
    { id: 'ptc-plus' },
  ]
  const calls = []
  const runProcessOption = async (executable, args, options) => {
    calls.push({ executable, args, options })
    if (args.includes('-File')) return { code: 0, stdout: '', stderr: '' }
    const command = args.at(-1)
    assert.match(command, /--dump-config$/)
    const patch = command.match(/--patch '((?:[^']|'')+)'/)
    if (patch === null) return { code: 0, stdout: stringify(baseRows), stderr: '' }
    const windowsOverlay = patch[1].replaceAll("''", "'")
    const overlay = process.platform === 'win32' ? windowsOverlay : wslPath(windowsOverlay)
    assert.equal(windowsPath(overlay), windowsOverlay)
    const rows = parseConfigDump(await readFile(overlay, 'utf8'))
    assert.equal(rows.find(row => row.id === 'llm-pi-ai').config.providers.fixture.headers['x-route'], secret)
    return {
      code: 0,
      stdout: stringify([...baseRows.filter(base => !rows.some(row => row.id === base.id)), ...rows]),
      stderr: '',
    }
  }
  const variants = [{ id: 'plugin' }, { id: 'baseline', patchOptions: { disablePtcPlus: true } }]
  const validated = []
  const result = await prepareHeadlessConfigs({
    repoRoot,
    env: { FIXTURE_KEY: 'synthetic-credential' },
    runtime: {
      provider: 'fixture',
      model: 'model',
      apiKeyEnv: 'FIXTURE_KEY',
      profile: 'fixture-profile',
      nodeExecutable: 'X:\\node.exe',
      dshEntry: 'X:\\dsh.js',
      toolsMode: 'custom-tools-mode',
      permissionMode: 'danger-full-access',
    },
    host: { dshHome: root },
    artifactRoot,
    overlayRoot,
    variants,
    validate: (configs, rows) => {
      validated.push({ configs, rows })
      return { ok: true }
    },
    label: 'focused',
    runProcess: runProcessOption,
  })
  // One install plus one base dump plus one dump per variant.
  assert.equal(calls.length, 4)
  assert.equal(calls[0].args.includes('-File'), true)
  assert.equal(calls[0].options.env.DSH_DEV_INSTALL_NO_PAUSE, '1')
  assert.deepEqual(result.overlays, Object.fromEntries(variants.map(variant => [variant.id, join(overlayRoot, `${variant.id}.patch.yml`)])))
  assert.deepEqual(Object.keys(result.configs), ['plugin', 'baseline'])
  assert.equal(result.baseRows.length, baseRows.length)
  assert.equal(validated.length, 1)
  assert.equal(validated[0].rows, result.baseRows)
  assert.deepEqual(result.evidence, { ok: true })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(parseConfigDump(await readFile(result.overlays.baseline, 'utf8')).some(row => row.id === 'ptc-plus' && row.disabled === true), true)
  assert.equal(parseConfigDump(await readFile(result.overlays.plugin, 'utf8')).some(row => row.id === 'ptc-plus'), false)

  const artifacts = (await readdir(artifactRoot)).sort()
  assert.deepEqual(artifacts, [
    'base-config.stderr.log', 'base-config.stdout.yml',
    'baseline-config.stderr.log', 'baseline-config.stdout.yml', 'baseline.patch.yml',
    'install.stderr.log', 'install.stdout.log',
    'plugin-config.stderr.log', 'plugin-config.stdout.yml', 'plugin.patch.yml',
  ])
  for (const name of artifacts) {
    assert.equal((await readFile(join(artifactRoot, name), 'utf8')).includes(secret), false, name)
  }
})
