import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeWorkerEnvironment, WorkerClient } from '../internal/worker-client.js'
import { helperProcessEnvironment, isElectronHost } from '../internal/worker-environment.js'
import { WorkerOutputCapture } from '../internal/worker-output-capture.js'
import { outputFenceMarker } from '../internal/worker-output-fence.js'

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

test('an idle output-attribution failure resets immediately and fails the next ensure once', async () => {
  const messages = []
  const failures = []
  const client = new WorkerClient({
    cwd: undefined,
    onMessage: message => messages.push(message),
    onFailure: message => failures.push(message),
  })
  const worker = {}
  let stops = 0
  client.worker = worker
  client.workerLimit = 64
  client.workerReady = Promise.resolve(worker)
  client.port = { close() {} }
  client.hostIds.set(worker, 'idle-output-worker')
  client.owner.stop = async id => {
    assert.equal(id, 'idle-output-worker')
    stops++
  }

  client.handleCapturedOutput(worker, {
    type: 'worker-output-error',
    id: 1,
    message: 'late descriptor output',
  })
  assert.deepEqual(messages, [{ type: 'worker-output-error', id: 1, message: 'late descriptor output' }])
  assert.equal(client.worker, undefined)
  await assert.rejects(client.ensure(64), /worker output attribution failed: late descriptor output/u)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stops, 1)
  assert.deepEqual(failures, [])
})

test('an old-round output failure settles an active transport consumer without poisoning its successor', async () => {
  const messages = []
  const failures = []
  const client = new WorkerClient({
    cwd: undefined,
    onMessage(message) {
      messages.push(message)
      return false
    },
    onFailure() {},
    onUnmatchedOutputFailure(message) {
      failures.push(message)
      return true
    },
  })
  const worker = {}
  client.worker = worker
  client.workerLimit = 64
  client.workerReady = Promise.resolve(worker)
  client.port = { close() {} }
  client.hostIds.set(worker, 'active-output-worker')
  client.owner.stop = async id => assert.equal(id, 'active-output-worker')

  client.handleCapturedOutput(worker, {
    type: 'worker-output-error',
    id: 1,
    message: 'prior round wrote while the next cell was preparing',
  })
  assert.deepEqual(messages, [{
    type: 'worker-output-error',
    id: 1,
    message: 'prior round wrote while the next cell was preparing',
  }])
  assert.deepEqual(failures, [
    'worker output attribution failed: prior round wrote while the next cell was preparing',
  ])
  assert.equal(client.pendingOutputFailure, undefined)
  assert.equal(client.worker, undefined)
  await new Promise(resolve => setImmediate(resolve))
})

test('output protocol frames cannot bypass capture while completion waits for fences', async t => {
  const token = 'a'.repeat(48)
  for (const [name, invalidFrame, expected] of [
    ['repeated done', { type: 'done', id: 7, outputFence: token, logs: [] }, /repeated a completion/u],
    ['wrong-id done', { type: 'done', id: 8, outputFence: token, logs: [] }, /no matching output round/u],
    ['repeated output-start', { type: 'output-start', id: 7, outputFence: token }, /repeated an output start/u],
  ]) {
    await t.test(name, async () => {
      const messages = []
      const client = new WorkerClient({
        cwd: undefined,
        onMessage(message) {
          messages.push(message)
          return message.type === 'worker-output-error'
        },
        onFailure() {},
      })
      const worker = {}
      const capture = new WorkerOutputCapture()
      client.worker = worker
      client.port = { postMessage() {}, close() {} }
      client.hostIds.set(worker, name)
      client.owner.stop = async id => assert.equal(id, name)
      assert.equal(capture.begin(7, 1024, token), undefined)
      assert.equal(capture.start({ type: 'output-start', id: 7, outputFence: token }), undefined)
      capture.push('stdout', outputFenceMarker(token, 'stdout', 'start'))
      capture.push('stderr', outputFenceMarker(token, 'stderr', 'start'))

      client.handleWorkerMessage(worker, capture, { type: 'done', id: 7, outputFence: token, logs: [] })
      assert.equal(client.outputCompletionPending, 7)
      client.handleWorkerMessage(worker, capture, { type: 'observation', id: 7 })
      assert.equal(client.deferredOutputMessages.length, 1)
      client.handleWorkerMessage(worker, capture, invalidFrame)

      assert.equal(messages.length, 1)
      assert.equal(messages[0].type, 'worker-output-error')
      assert.match(messages[0].message, expected)
      assert.deepEqual(client.deferredOutputMessages, [])
      assert.equal(client.worker, undefined)
      await new Promise(resolve => setImmediate(resolve))
    })
  }
})

test('completion fences release deferred application messages in arrival order', () => {
  const token = 'b'.repeat(48)
  const messages = []
  const client = new WorkerClient({
    cwd: undefined,
    onMessage(message) {
      messages.push(message)
      return true
    },
    onFailure() {},
  })
  const worker = {}
  const capture = new WorkerOutputCapture()
  client.worker = worker
  client.port = { postMessage() {}, close() {} }
  assert.equal(capture.begin(9, 1024, token), undefined)
  assert.equal(capture.start({ type: 'output-start', id: 9, outputFence: token }), undefined)
  capture.push('stdout', outputFenceMarker(token, 'stdout', 'start'))
  capture.push('stderr', outputFenceMarker(token, 'stderr', 'start'))

  client.handleWorkerMessage(worker, capture, { type: 'done', id: 9, outputFence: token, logs: [] })
  client.handleWorkerMessage(worker, capture, { type: 'observation', id: 9, value: 'after' })
  client.handleCapturedOutput(worker, capture.push('stdout', outputFenceMarker(token, 'stdout', 'end')))
  client.handleCapturedOutput(worker, capture.push('stderr', outputFenceMarker(token, 'stderr', 'end')))

  assert.deepEqual(messages, [
    { type: 'done', id: 9, outputFence: token, logs: [] },
    { type: 'observation', id: 9, value: 'after' },
  ])
  assert.equal(client.outputCompletionPending, undefined)
  assert.deepEqual(client.deferredOutputMessages, [])
  assert.equal(client.worker, worker)
})

test('post resets an overlapping output round and postIfAlive remains best effort', async () => {
  const messages = []
  const posted = []
  const stops = []
  let closes = 0
  const client = new WorkerClient({
    cwd: undefined,
    onMessage(message) {
      messages.push(message)
      return true
    },
    onFailure() {},
  })
  const worker = {}
  client.worker = worker
  client.owner = {
    async stop(id) { stops.push(id) },
    async dispose() { return [] },
  }
  client.hostIds.set(worker, 'overlap-worker')
  client.outputCapture = new WorkerOutputCapture()
  client.port = { postMessage: message => posted.push(message), close() { closes += 1 } }
  client.post({ type: 'run', id: 1, maxOutputBytes: 1024 })
  client.post({ type: 'run', id: 2, maxOutputBytes: 1024 })
  while (stops.length === 0 || closes === 0) await new Promise(resolve => setImmediate(resolve))
  assert.equal(posted.length, 1)
  assert.deepEqual(messages, [{ type: 'worker-output-error', id: 2, message: 'worker output rounds overlapped' }])
  assert.deepEqual(stops, ['overlap-worker'])
  assert.equal(closes, 1)
  assert.equal(client.worker, undefined)
  assert.equal(client.outputCapture, undefined)
  client.postIfAlive({ type: 'reply', id: 3 })
  assert.equal(posted.length, 1)
  assert.doesNotThrow(() => client.postIfAlive({ type: 'reply', id: 4 }))
})

test('scratch cleanup failure stays best effort after transport disposal', async () => {
  const client = workerClient()
  client.scratchReady = Promise.reject(new Error('scratch cleanup failed'))
  await client.dispose()
})
