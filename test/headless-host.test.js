import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  HEADLESS_PREREQUISITE_CODE,
  changedSessionLogs,
  cleanupOwnedPath,
  formatHeadlessError,
  headlessConfigPatch,
  parseConfigDump,
  preflightHeadlessHost,
  requiredModelRuntime,
  runProcess,
  snapshotSessionLogs,
  validateHeadlessRuntimeConfig,
  validateNeutralConfig,
  withOwnedPath,
  windowsPath,
  wslPath,
} from '../scripts/headless-host.mjs'

const runtime = {
  provider: 'provider',
  model: 'model',
  apiKeyEnv: 'API_KEY',
  toolsMode: 'code',
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

test('resolves the Windows host before callers create artifacts', async () => {
  const calls = []
  const host = await preflightHeadlessHost('/mnt/x/fixture/project', {
    env: { DSH_HOME: 'ignored-by-host' },
    async runProcess(...args) {
      calls.push(args)
      return {
        code: 0,
        stdout: JSON.stringify({ dshVersion: 'dsh 1.2.3', dshHome: 'X:\\fixture\\home\\.dsh' }),
        stderr: '',
      }
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'pwsh.exe')
  assert.equal(calls[0][2].cwd, '/mnt/x/fixture/project')
  assert.equal(host.repoRootWindows, 'X:\\fixture\\project')
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

test('owns neutral config parsing and projection for both runners', () => {
  const rows = configRows()
  assert.equal(validateNeutralConfig(rows, 'acceptance config'), true)
  assert.equal(validateNeutralConfig(configRows(true), 'baseline config', 'disabled'), true)
  const projected = parseConfigDump(headlessConfigPatch(rows, runtime))
  assert.equal(projected.find(row => row.id === 'system-prompt').config.includeRuntimeContext, true)
  assert.equal(projected.find(row => row.id === 'tools').config.mode, 'code')
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
