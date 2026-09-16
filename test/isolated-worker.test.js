import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

class FakeChild extends EventEmitter {
  constructor({ killResult = true } = {}) {
    super()
    this.sent = []
    this.kills = 0
    this.killResult = killResult
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.connected = true
  }

  send(message) { this.sent.push(message) }

  kill() {
    this.kills += 1
    return this.killResult
  }
}

let current
/** Let the async close path register its next timer before the clock advances. */
const flush = () => new Promise(resolve => setImmediate(resolve))

async function started(options) {
  current = new FakeChild(options)
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })
  worker.emit('message', { type: 'ready' })
  return worker
}

test('shares one close outcome across concurrent callers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started({ killResult: true })
  const first = worker.terminate()
  const second = worker.terminate()
  assert.equal(first, second)
  current.emit('message', { type: 'worker-message', value: { type: 'shutdown-released' } })
  current.emit('exit', 0, null)
  await Promise.all([first, second])
  assert.equal(current.kills, 0)
})

test('publishes process exit after final stderr and before transport close', async t => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started()
  const events = []
  worker.stderr.on('data', chunk => events.push(`stderr:${String(chunk)}`))
  worker.on('exit', (code, signal) => events.push(`exit:${code}:${signal}`))
  worker.on('close', () => events.push('close'))

  current.emit('exit', null, 'SIGKILL')
  current.stderr.end('late stderr')
  current.stdout.end()
  await flush()
  assert.deepEqual(events, ['stderr:late stderr'])

  current.emit('close', null, 'SIGKILL')
  assert.deepEqual(events, ['stderr:late stderr', 'exit:null:SIGKILL', 'close'])
})

test('fails observably when a killed helper never really exits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started({ killResult: true })
  const first = worker.terminate()
  const second = worker.terminate()
  const outcomes = [first, second].map(promise => promise.then(() => 'resolved', error => error.message))
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  t.mock.timers.tick(4000)
  await flush()
  t.mock.timers.tick(0)
  const settled = await Promise.all(outcomes)
  assert.match(settled[0], /did not exit before the close deadline/)
  assert.match(settled[1], /did not exit before the close deadline/)
  assert.equal(current.kills, 1)
  assert.match(worker.reclamationFailure.message, /did not exit/)
})

test('reclaims a released helper that exits inside the kill window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started({ killResult: true })
  const closing = worker.terminate()
  const outcome = closing.then(() => 'resolved', error => error.message)
  await flush()
  current.emit('message', { type: 'worker-message', value: { type: 'shutdown-released' } })
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(current.kills, 1)
  t.mock.timers.tick(500)
  current.emit('exit', 0, null)
  assert.equal(await outcome, 'resolved')
  assert.equal(worker.released, true)
  assert.equal(worker.reclamationFailure, undefined)
})

test('still kills the helper when the stop request cannot be sent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started({ killResult: true })
  current.send = message => {
    if (message.type === 'worker-message') throw new Error('ipc closed')
    current.sent.push(message)
  }
  const closing = worker.terminate()
  const outcome = closing.then(() => 'resolved', error => error.message)
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(current.kills, 1)
  t.mock.timers.tick(4000)
  await flush()
  assert.match(await outcome, /did not exit before the close deadline/)
})

test('reports a refused kill as a retained failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started({ killResult: false })
  const closing = worker.terminate()
  t.mock.timers.tick(1000)
  await assert.rejects(closing, /could not be killed/)
  assert.match(worker.reclamationFailure.message, /could not be killed/)
})

test('adopts an on-demand utilization sample instead of a stale cache', async (t) => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const sample = worker.sampleUtilization()
  assert.deepEqual(current.sent.at(-1), { type: 'sample-utilization', id: 1 })
  current.emit('message', { type: 'utilization-sample', id: 1, utilization: { idle: 12, active: 34 } })
  assert.deepEqual(await sample, { idle: 12, active: 34 })
  assert.deepEqual(worker.utilization, { idle: 12, active: 34 })
})

test('rejects a sample that the helper does not answer before its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const sample = worker.sampleUtilization()
  t.mock.timers.tick(1000)
  await assert.rejects(sample, /did not answer utilization sampling/)
  assert.equal(worker.utilizationRequests.size, 0)
})

test('rejects a sample when the helper IPC refuses the request', async (t) => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })
  current.send = () => { throw new Error('ipc closed') }

  await assert.rejects(worker.sampleUtilization(), /ipc closed/)
  assert.equal(worker.utilizationRequests.size, 0)
})

test('rejects pending samples when the helper disconnects or exits', async (t) => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const disconnected = worker.sampleUtilization()
  current.emit('disconnect')
  await assert.rejects(disconnected, /disconnected before answering utilization sampling/)
  assert.equal(worker.utilizationRequests.size, 0)

  const exited = worker.sampleUtilization()
  current.emit('exit', 0, null)
  await assert.rejects(exited, /exited before answering utilization sampling/)
  await assert.rejects(worker.sampleUtilization(), /not available for utilization sampling/)
  assert.equal(worker.utilizationRequests.size, 0)
})

test('rejects pending samples when the helper process emits an error', async (t) => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })
  worker.on('error', () => {})

  const sample = worker.sampleUtilization()
  current.emit('error', new Error('helper process error'))
  await assert.rejects(sample, /helper process error/)
  assert.equal(worker.utilizationRequests.size, 0)
})

test('retains the forked helper when the init send fails', async (t) => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const originalSend = current.send.bind(current)
  current.send = message => {
    if (message.type === 'init') throw new Error('init send failed')
    return originalSend(message)
  }
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')

  let failure
  try {
    new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })
  } catch (error) {
    failure = error
  }
  assert.match(failure.message, /init send failed/)
  assert.ok(failure.transport instanceof IsolatedWorker)
  assert.equal(failure.child, current)
})

test('port adapter supports once and off listeners', async (t) => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const ready = new Promise(resolve => worker.once('message', resolve))
  current.emit('message', { type: 'ready' })
  const { port } = await ready
  const seen = []
  const handler = value => { seen.push(value) }
  port.once('message', handler)
  port.off('message', handler)
  current.emit('message', { type: 'kernel-message', value: { kind: 'ignored' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen, [])
})
