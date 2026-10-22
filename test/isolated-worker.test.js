import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'


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

test('does not miss an exit observed while the close deadline is initialized', async t => {
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started()
  const originalNow = Date.now
  let emitted = false
  t.mock.method(Date, 'now', () => {
    if (!emitted) {
      emitted = true
      current.emit('exit', 0, null)
    }
    return originalNow()
  })

  await Promise.race([
    worker.terminate(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('close missed the observed exit')), 100)),
  ])
  assert.equal(worker.exited, true)
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

test('accepts an exit delivered after the platform could not confirm the kill', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started({ killResult: false })
  const closing = worker.terminate()
  const outcome = closing.then(() => 'resolved', error => error.message)
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(current.kills, 1)
  current.emit('exit', 0, null)
  assert.equal(await outcome, 'resolved')
  assert.equal(worker.reclamationFailure, undefined)
})

test('reports a refused kill when the helper still does not exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  const worker = await started({ killResult: false })
  const closing = worker.terminate()
  const outcome = closing.then(() => 'resolved', error => error.message)
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(current.kills, 1)
  t.mock.timers.tick(4000)
  await flush()
  assert.match(await outcome, /could not be killed/)
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
  const { IsolatedWorker, ISOLATED_SAMPLE_MS, UNANSWERED_SAMPLE_CODE } =
    await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const outcome = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  t.mock.timers.tick(ISOLATED_SAMPLE_MS)
  await flush()
  const { error } = await outcome
  assert.match(error.message, /did not answer utilization sampling before its deadline/)
  // The transport reports only the observation, so this is what the caller reads.
  assert.equal(error.code, UNANSWERED_SAMPLE_CODE)
  assert.equal(worker.utilizationRequests.size, 0)
})

test('adopts an answer that is already waiting when the deadline expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker, ISOLATED_SAMPLE_MS } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const outcome = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  // A blocked host runs the expired timer before it reads its IPC pipe, so the
  // helper's answer arrives after the deadline fired but before the deferred
  // decision could conclude that no answer exists.
  t.mock.timers.tick(ISOLATED_SAMPLE_MS)
  current.emit('message', { type: 'utilization-sample', id: 1, utilization: { idle: 7, active: 11 } })
  const settled = await outcome
  assert.deepEqual(settled.value, { idle: 7, active: 11 })
  await flush()
  assert.equal(worker.utilizationRequests.size, 0)
})

test('keeps reading queued helper messages while an answer may still follow them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker, ISOLATED_SAMPLE_MS } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const outcome = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  t.mock.timers.tick(ISOLATED_SAMPLE_MS)
  // The read-out starts on the turn after the deadline, so a message delivered
  // during the following turn is what a one-turn decision would not survive.
  await flush()
  current.emit('message', { type: 'child-utilization', utilization: { idle: 1, active: 2 } })
  await flush()
  assert.equal(worker.utilizationRequests.size, 1, 'one delivered message must not conclude the sample')
  current.emit('message', { type: 'utilization-sample', id: 1, utilization: { idle: 3, active: 5 } })
  const settled = await outcome
  assert.deepEqual(settled.value, { idle: 3, active: 5 })
})

test('waits for the bound this transport instance carries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker, ISOLATED_SAMPLE_MS } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })
  assert.equal(worker.sampleBoundMs, ISOLATED_SAMPLE_MS)
  worker.sampleBoundMs = 40

  const outcome = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  t.mock.timers.tick(39)
  await flush()
  assert.equal(worker.utilizationRequests.size, 1, 'the sample must still be waiting before its own bound')
  t.mock.timers.tick(1)
  await flush()
  await flush()
  // A wait bounded by another constant would still be pending after this tick,
  // which fails here instead of leaving the sample unsettled.
  assert.equal(worker.utilizationRequests.size, 0, 'the deadline must follow the bound this instance carries')
  const settled = await outcome
  assert.match(settled.error.message, /did not answer utilization sampling before its deadline/)
})

test('reports a backlog it could not read out instead of claiming no answer was written', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker, ISOLATED_SAMPLE_MS, UNANSWERED_SAMPLE_CODE } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const outcome = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  t.mock.timers.tick(ISOLATED_SAMPLE_MS)
  await flush()
  // A helper that keeps writing gives the read-out a message on every turn, so
  // each turn continues reading until the bound ends it.
  for (let turn = 0; turn < 4_096; turn++) {
    current.emit('message', { type: 'child-utilization', utilization: { idle: turn, active: 0 } })
    await flush()
  }
  await flush()
  const { error } = await outcome
  assert.match(error.message, /wrote at least 4096 messages ahead of this utilization sample/)
  assert.equal(error.code, UNANSWERED_SAMPLE_CODE, 'a backlog sample is still an unobserved answer, not a lost worker')
})

// Scope: the message boundary. No complete answer exists when the read-out
// concludes, and the answer arrives complete afterwards. A real IPC fragment
// fixture would be needed to claim anything about Node's partial-frame parsing.
test('keeps the freshest answer the helper reported after the read-out concluded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker, ISOLATED_SAMPLE_MS } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const outcome = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  t.mock.timers.tick(ISOLATED_SAMPLE_MS)
  await flush()
  await flush()
  const settled = await outcome
  assert.match(settled.error.message, /did not answer utilization sampling/)
  // The late complete answer does not settle the request that already failed; it
  // only refreshes what the helper last reported.
  current.emit('message', { type: 'utilization-sample', id: 1, utilization: { idle: 9, active: 13 } })
  assert.deepEqual(worker.utilization, { idle: 9, active: 13 })
  assert.equal(worker.utilizationRequests.size, 0)
  assert.equal(settled.value, undefined)
})

test('does not let the answer of a concluded request settle the next one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.module('node:child_process', { namedExports: { fork: () => current } })
  current = new FakeChild()
  const { IsolatedWorker, ISOLATED_SAMPLE_MS } = await import('../internal/isolated-worker.js')
  const worker = new IsolatedWorker({ helper: '/helper.js', entry: 'kernel-worker.js', workerData: {}, env: {} })

  const first = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  t.mock.timers.tick(ISOLATED_SAMPLE_MS)
  await flush()
  await flush()
  assert.match((await first).error.message, /did not answer utilization sampling/)

  // The next request carries its own identity and its own deadline.
  const second = worker.sampleUtilization().then(value => ({ value }), error => ({ error }))
  let secondSettled = false
  void second.then(() => { secondSettled = true })
  current.emit('message', { type: 'utilization-sample', id: 1, utilization: { idle: 1, active: 2 } })
  assert.deepEqual(worker.utilization, { idle: 1, active: 2 })
  assert.equal(worker.utilizationRequests.size, 1, 'the new request must stay pending')
  await flush()
  await flush()
  assert.equal(secondSettled, false)

  current.emit('message', { type: 'utilization-sample', id: 2, utilization: { idle: 3, active: 4 } })
  assert.deepEqual((await second).value, { idle: 3, active: 4 })
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

test('ordinary and covered workers share absolute entry identity across accepted representations', async () => {
  const { isolatedWorkerEntry } = await import('../internal/isolated-worker.js')
  const filename = resolve('entry with spaces.mjs')
  const url = pathToFileURL(filename)
  for (const entry of [url, url.href, filename, 'entry with spaces.mjs']) {
    assert.equal(isolatedWorkerEntry(entry), url.href)
  }
  assert.equal(isolatedWorkerEntry(`FILE:${url.href.slice(5)}`), url.href)
  for (const entry of [undefined, null, '', 42, {}]) {
    assert.throws(() => isolatedWorkerEntry(entry), /URL or a non-empty string filename/)
  }
})
