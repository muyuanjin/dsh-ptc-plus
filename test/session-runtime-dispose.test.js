import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

test('dispose waits for every kernel and preserves all failures', async () => {
  const runtime = new SessionRuntime()
  const first = new Error('first kernel disposal failed')
  const second = new Error('second kernel disposal failed')
  let releaseSecond
  const secondGate = new Promise(resolve => { releaseSecond = resolve })
  runtime.kernels.set('ok', { async dispose() {} })
  runtime.kernels.set('first', { async dispose() { throw first } })
  runtime.kernels.set('second', { async dispose() { await secondGate; throw second } })

  let settled = false
  const disposal = runtime.dispose().then(
    () => { settled = true },
    error => { settled = true; return error },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(runtime.kernels.has('ok'), false)
  assert.equal(runtime.kernels.has('first'), true)
  assert.equal(runtime.kernels.has('second'), true)

  releaseSecond()
  const error = await disposal
  assert.ok(error instanceof AggregateError)
  assert.deepEqual(error.errors, [first, second])
  assert.equal(runtime.kernels.has('first'), true)
  assert.equal(runtime.kernels.has('second'), true)
})
