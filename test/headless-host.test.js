import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  HEADLESS_TOOLS_MODE,
  HEADLESS_PREREQUISITE_CODE,
  changedSessionLogs,
  dshInvocation,
  cleanupOwnedPath,
  formatHeadlessError,
  headlessConfigPatch,
  parseConfigDump,
  preflightHeadlessHost,
  requiredModelRuntime,
  resolveHeadlessProvider,
  redactHeadlessConfig,
  runProcess,
  snapshotSessionLogs,
  validateHeadlessRuntimeConfig,
  validateNeutralConfig,
  withOwnedPath,
  windowsPath,
  wslPath,
} from '../scripts/headless-host.mjs'
import { probeReplRuntime, RUNTIME_PROBE_PREFIX } from '../scripts/repl-preflight.mjs'
import { ptcToolsMode } from '../scripts/dsh-host-contract.mjs'

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
  assert.equal(projected.find(row => row.id === 'tools').config.mode, ptcToolsMode())
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
  assert.equal(rows.find(row => row.id === 'tools').config.mode, ptcToolsMode())
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
