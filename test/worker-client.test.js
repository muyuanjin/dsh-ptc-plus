import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeWorkerEnvironment, WorkerClient } from '../internal/worker-client.js'
import { helperProcessEnvironment, isElectronHost } from '../internal/worker-environment.js'

function workerClient(workerUrl = undefined) {
  return new WorkerClient({ workerUrl, cwd: undefined, onMessage() {}, onFailure() {} })
}

test('normalizes Windows worker environment keys without losing host values', () => {
  const normalized = normalizeWorkerEnvironment({
    Path: 'fallback-path',
    PATH: 'canonical-path',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    MixedCaseApplicationValue: 'kept',
    NODE_test_CONTEXT: 'host-only',
    node_v8_coverage: 'host-only',
    DSH_PTC_COMPILER_BYTECODE: 'host-only',
  }, 'win32')
  assert.deepEqual(normalized, {
    PATH: 'canonical-path',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    MixedCaseApplicationValue: 'kept',
  })
})

test('preserves POSIX case-sensitive keys while removing host instrumentation', () => {
  assert.deepEqual(normalizeWorkerEnvironment({
    PATH: '/bin',
    Path: 'application-value',
    NODE_TEST_CONTEXT: 'host-only',
    absent: undefined,
  }, 'linux'), {
    PATH: '/bin',
    Path: 'application-value',
  })
})

test('adds Electron Node mode only to the helper process projection', () => {
  assert.equal(isElectronHost({ electron: '43.3.0' }), true)
  assert.equal(isElectronHost({ node: process.versions.node }), false)
  assert.equal(isElectronHost(), false)

  const source = {
    PATH: 'canonical-path',
    Electron_Run_As_Node: '0',
    ApplicationValue: 'kept',
  }
  assert.deepEqual(helperProcessEnvironment(source, 'win32', true), {
    PATH: 'canonical-path',
    ELECTRON_RUN_AS_NODE: '1',
    ApplicationValue: 'kept',
  })
  assert.deepEqual(source, {
    PATH: 'canonical-path',
    Electron_Run_As_Node: '0',
    ApplicationValue: 'kept',
  })
  assert.equal(helperProcessEnvironment(source, 'win32', false), source)
  assert.deepEqual(helperProcessEnvironment({ PATH: '/bin' }, 'linux', true), {
    PATH: '/bin',
    ELECTRON_RUN_AS_NODE: '1',
  })
})

test('reports a signaled helper after its stderr drains', async () => {
  let reportFailure
  const failure = new Promise(resolve => { reportFailure = resolve })
  const client = new WorkerClient({
    workerUrl: new URL('./fixtures/isolated-signal-worker.mjs', import.meta.url),
    cwd: process.cwd(),
    onMessage() {},
    onFailure: reportFailure,
  })
  try {
    const worker = await client.ensure(32)
    const stderr = once(worker.stderr, 'data')
    client.post({ type: 'stderr-marker' })
    assert.match(String((await stderr)[0]), /worker-client-stderr-marker/)
    assert.equal(worker.child.kill('SIGKILL'), true)
    const message = await failure
    assert.match(message, /code null, signal SIGKILL/)
    assert.match(message, /last stderr: worker-client-stderr-marker/)
  } finally {
    await client.dispose()
  }
})

test('dispose delegates active and retained workers to one owner aggregation', async () => {
  const client = workerClient()
  const worker = {}
  const portFailure = new Error('host port close failure')
  const activeFailure = new Error('active owner failure')
  const retainedFailure = new Error('retained owner failure')
  let stopCalls = 0
  let disposeCalls = 0
  let portCloses = 0
  client.worker = worker
  client.workerLimit = 64
  client.workerReady = Promise.resolve(worker)
  client.port = {
    close() {
      portCloses++
      throw portFailure
    },
  }
  client.hostIds.set(worker, 'active')
  client.owner.stop = async () => {
    stopCalls++
    throw activeFailure
  }
  client.owner.dispose = async () => {
    disposeCalls++
    return [activeFailure, retainedFailure]
  }
  await assert.rejects(client.dispose(), error => error instanceof AggregateError
    && error.errors.length === 3
    && error.errors[0] === portFailure
    && error.errors[1] === activeFailure
    && error.errors[2] === retainedFailure)
  assert.equal(stopCalls, 0)
  assert.equal(disposeCalls, 1)
  assert.equal(portCloses, 1)
  assert.equal(client.worker, undefined)
  assert.equal(client.workerLimit, undefined)
  assert.equal(client.workerReady, undefined)
  assert.equal(client.port, undefined)
  assert.equal(client.hostIds.has(worker), false)
})

test('rejects a worker limit outside the reserved cell generation', async () => {
  const client = workerClient()
  client.workerLimit = 64
  await assert.rejects(client.ensure(128), /differs from the submitted cell configuration/)
})

test('releases worker reservations after root, scratch, disposal, and constructor failures', async (t) => {
  const environment = {
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  }
  t.after(() => {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  process.env.TMPDIR = 'relative-temp-root'
  process.env.TEMP = 'relative-temp-root'
  process.env.TMP = 'relative-temp-root'
  const rootFailure = workerClient()
  await assert.rejects(rootFailure.ensure(64), /host temporary directory must be absolute/)
  assert.equal(rootFailure.workerLimit, undefined)
  rootFailure.scratchReady = Promise.reject(new Error('different-limit retry reached scratch'))
  await assert.rejects(rootFailure.ensure(128), /different-limit retry reached scratch/)
  assert.equal(rootFailure.workerLimit, undefined)

  const scratchFailure = workerClient()
  scratchFailure.scratchReady = Promise.reject(new Error('scratch unavailable'))
  await assert.rejects(scratchFailure.ensure(64), /scratch unavailable/)
  assert.equal(scratchFailure.workerLimit, undefined)

  const disposed = workerClient()
  disposed.scratchReady = Promise.resolve('/tmp/dsh-ptc-plus-disposed-test')
  disposed.disposed = true
  await assert.rejects(disposed.ensure(64), /session kernel disposed/)
  assert.equal(disposed.workerLimit, undefined)

  const constructorFailure = workerClient()
  constructorFailure.scratchReady = Promise.resolve('/tmp/dsh-ptc-plus-constructor-test')
  await assert.rejects(constructorFailure.ensure(64), /filename|URL|string/i)
  assert.equal(constructorFailure.workerLimit, undefined)
})

test('a refused startup reset stays owned without an unhandled rejection', () => {
  const probe = fileURLToPath(new URL('./fixtures/worker-client-reset-refusal.mjs', import.meta.url))
  for (const [mode, expectedError] of [
    ['startup-error', 'probe startup failed'],
    ['invalid-channel', 'kernel worker returned an invalid private channel'],
  ]) {
    const result = spawnSync(process.execPath, [probe, mode], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      startupError: expectedError,
      unhandled: [],
      retained: 1,
    })
  }
})
