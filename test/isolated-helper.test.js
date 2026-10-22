import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ISOLATED_SAMPLE_MS, IsolatedWorker } from '../internal/isolated-worker.js'

/** Resolve with the promise value or reject when the bound expires. */
function bounded(promise, ms, message) {
  let timer
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer))
}

test('starts an Electron helper in Node mode without changing the inner worker environment', async (t) => {
  Object.defineProperty(process.versions, 'electron', { value: '43.3.0', configurable: true })
  t.after(() => { delete process.versions.electron })
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('./fixtures/isolated-environment-helper.mjs', import.meta.url)),
    entry: new URL('./fixtures/isolated-ready-busy-worker.mjs', import.meta.url).href,
    workerData: {},
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: { PTC_PLUS_ENVIRONMENT_MARKER: 'preserved' },
    protocol: 'parent-port',
  })
  t.after(async () => { if (!worker.exited) await worker.terminate() })

  const report = await bounded(
    new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    }),
    20_000,
    'Electron helper never reported its environment',
  )
  assert.deepEqual(report, { helper: '1', worker: null })
  await bounded(worker.closed, 20_000, 'Electron helper output never closed')
})

test('adopts the ready handshake utilization instead of an older sample', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('./fixtures/isolated-ready-busy-worker.mjs', import.meta.url).href,
    workerData: {},
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: {},
  })
  t.after(async () => {
    if (worker.exited) return
    try { await worker.terminate() } catch {}
  })

  const ready = await bounded(
    new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    }),
    20_000,
    'helper never became ready',
  )
  assert.equal(ready.type, 'ready')
  assert.ok(worker.utilization.active > 0, 'real startup work must be visible in the ready sample')

  const baseline = worker.performance.eventLoopUtilization()
  await new Promise(resolve => setTimeout(resolve, 80))
  const delta = worker.performance.eventLoopUtilization(baseline)
  assert.ok(delta.active < 20, `post-ready idle time reported ${delta.active}ms of active work`)

  await worker.terminate()
  await bounded(worker.closed, 20_000, 'helper output never closed')
})

test('adopts a real helper answer read out from behind queued messages after the deadline', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('./fixtures/isolated-ready-busy-worker.mjs', import.meta.url).href,
    workerData: {},
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: { ...process.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
  })
  t.after(async () => {
    if (worker.exited) return
    try { await worker.terminate() } catch {}
  })

  const ready = await bounded(
    new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    }),
    20_000,
    'helper never became ready',
  )
  assert.equal(ready.type, 'ready')

  // The helper writes one periodic sample every 50 ms and Node delivers one
  // helper message per event-loop turn, so a blocked host ends up with messages
  // queued ahead of its answer. The answer exists before the deadline; only
  // reading the channel out reaches it.
  const queueUntil = Date.now() + 200
  while (Date.now() < queueUntil) {}
  const sample = worker.sampleUtilization()
  const busyUntil = Date.now() + ISOLATED_SAMPLE_MS + 300
  while (Date.now() < busyUntil) {}
  const utilization = await bounded(sample, 20_000, 'the host never adopted the helper answer it had already received')

  // Only the returned answer is this request's baseline. `worker.utilization` is a
  // cache that later periodic samples keep overwriting, so it may legitimately
  // hold a different sample by the time this line runs.
  assert.equal(typeof utilization.idle, 'number')
  assert.equal(typeof utilization.active, 'number')
  assert.ok(utilization.active > 0, 'the adopted answer must be the real helper baseline')
  assert.ok(worker.utilization.active > 0, 'the transport keeps the latest sample it received')
  await worker.terminate()
  await bounded(worker.closed, 20_000, 'helper output never closed')
})

test('rejects a helper init before the kernel worker starts', async (t) => {
  const child = fork(
    fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    [],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
      env: { ...process.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
    },
  )
  t.after(() => {
    if (!child.connected) return
    child.disconnect()
    child.kill()
  })
  child.send({ type: 'ping' })

  const message = await bounded(
    new Promise((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
    }),
    20_000,
    'helper never rejected the missing init message',
  )
  assert.deepEqual(message, {
    type: 'child-error',
    message: 'helper requires one init message before the kernel worker starts',
  })
  child.disconnect()
  await bounded(
    new Promise(resolve => child.once('exit', resolve)),
    20_000,
    'helper did not exit after the invalid init channel closed',
  )
})

test('rejects an invalid private-channel handshake', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('./fixtures/isolated-invalid-channel-worker.mjs', import.meta.url).href,
    workerData: {},
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: { ...process.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
  })
  t.after(async () => {
    if (worker.exited) return
    try { await worker.terminate() } catch {}
  })

  const error = await bounded(
    new Promise((resolve, reject) => {
      worker.once('error', resolve)
      worker.once('exit', code => reject(new Error(`helper exited with code ${code}`)))
    }),
    20_000,
    'helper never rejected the invalid private channel',
  )
  assert.match(error.message, /invalid private channel/)
  await worker.terminate()
  await bounded(worker.closed, 20_000, 'helper output never closed')
})

test('forwards a kernel startup failure as a helper error', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('../internal/kernel-worker.js', import.meta.url).href,
    workerData: { cwd: process.cwd() },
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: {
      ...process.env,
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '',
      NODE_OPTIONS: '--no-experimental-repl-await',
    },
  })
  t.after(async () => {
    if (worker.exited) return
    try { await worker.terminate() } catch {}
  })

  const error = await bounded(
    new Promise((resolve, reject) => {
      worker.once('error', resolve)
      worker.once('exit', code => reject(new Error(`helper exited with code ${code}`)))
    }),
    20_000,
    'helper never reported the kernel startup failure',
  )
  assert.match(error.message, /PTC runtime prerequisite failed/)
  await worker.terminate()
  await bounded(worker.closed, 20_000, 'helper output never closed')
})

test('forwards an inner worker error event as a helper error', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('./fixtures/isolated-error-worker.mjs', import.meta.url).href,
    workerData: {},
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: { ...process.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
  })
  t.after(async () => {
    if (worker.exited) return
    try { await worker.terminate() } catch {}
  })

  const error = await bounded(
    new Promise((resolve, reject) => {
      worker.once('error', resolve)
      worker.once('exit', code => reject(new Error(`helper exited with code ${code}`)))
    }),
    20_000,
    'helper never forwarded the inner worker error',
  )
  assert.match(error.message, /isolated worker startup failure/)
  assert.equal(error.name, 'Error')
  await worker.terminate()
  await bounded(worker.closed, 20_000, 'helper output never closed')
})

test('rejects a relative session cwd in the real kernel worker', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('../internal/kernel-worker.js', import.meta.url).href,
    workerData: { cwd: 'relative' },
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: { ...process.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
  })
  t.after(async () => {
    if (worker.exited) return
    try { await worker.terminate() } catch {}
  })

  const error = await bounded(
    new Promise((resolve, reject) => {
      worker.once('error', resolve)
      worker.once('exit', code => reject(new Error(`helper exited with code ${code}`)))
    }),
    20_000,
    'helper never reported the relative session cwd',
  )
  assert.match(error.message, /session cwd must be absolute/)
  await worker.terminate()
  await bounded(worker.closed, 20_000, 'helper output never closed')
})

test('rejects a REPL runtime that formats the settlement probe before settlement', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('./fixtures/bad-repl-kernel-worker.mjs', import.meta.url).href,
    workerData: { cwd: process.cwd() },
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    env: { ...process.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
  })
  t.after(async () => {
    if (worker.exited) return
    try { await worker.terminate() } catch {}
  })

  const error = await bounded(
    new Promise((resolve, reject) => {
      worker.once('error', resolve)
      worker.once('exit', code => reject(new Error(`helper exited with code ${code}`)))
    }),
    20_000,
    'helper never rejected the bad REPL runtime',
  )
  assert.match(error.message, /PTC runtime prerequisite failed on Node .*REPL did not preserve the original thrown value/)
  await worker.terminate()
  await bounded(worker.closed, 20_000, 'helper output never closed')
})
