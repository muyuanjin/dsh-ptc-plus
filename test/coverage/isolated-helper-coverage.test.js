import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { IsolatedWorker } from '../../internal/isolated-worker.js'

function bounded(promise, ms, message) {
  let timer
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer))
}

test('runs the real helper entry so its child coverage is collected', async (t) => {
  const worker = new IsolatedWorker({
    helper: fileURLToPath(new URL('../../internal/kernel-child.js', import.meta.url)),
    entry: new URL('../../internal/kernel-worker.js', import.meta.url).href,
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
