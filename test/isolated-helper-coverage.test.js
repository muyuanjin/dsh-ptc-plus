import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { IsolatedWorker } from '../internal/isolated-worker.js'

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

test('runs the real helper entry so its child coverage is collected', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../internal/kernel-child.js', import.meta.url)),
    entry: new URL('../internal/kernel-worker.js', import.meta.url).href,
    workerData: { cwd: process.cwd() },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    // The instrumentation variable is forwarded explicitly for this transport test
    // so the helper process writes coverage into the running gate's directory;
    // production callers keep normalizeWorkerEnvironment's filtering contract.
    env: { ...process.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
  })
  t.after(async () => { if (!worker.exited) await worker.terminate() })

  const ready = await bounded(
    new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    }),
    20_000,
    'helper never became ready',
  )
  assert.equal(ready.type, 'ready')
  assert.equal(typeof ready.port?.postMessage, 'function')

  // Real IPC proof: the kernel answers a prepare request over the private channel.
  const answered = await bounded(
    new Promise(resolve => {
      ready.port.on('message', value => { if (value?.type === 'ready' && value.id === 5) resolve(true) })
      ready.port.postMessage({ type: 'prepare', id: 5 })
    }),
    20_000,
    'kernel never answered the prepare request',
  )
  assert.equal(answered, true)

  await worker.terminate()
  assert.equal(worker.exited, true)
  // terminate() proves the process exit; the pipe close is its own fact.
  await bounded(worker.closed, 20_000, 'helper output never closed')
  assert.equal(worker.ioClosed, true)
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
