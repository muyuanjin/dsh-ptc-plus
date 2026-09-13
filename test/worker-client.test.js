import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeWorkerEnvironment, WorkerClient } from '../internal/worker-client.js'

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
