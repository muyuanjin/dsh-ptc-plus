import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { encodeValue } from '../internal/value-wire.js'
import { interceptWorkerPosts, sessionCellExecutor, workerOf } from './runtime-observation.js'

const LIMITS = { maxNodes: 100000, maxEdges: 1000000, maxArrayLength: 1000000, maxBigIntDigits: 100000, maxStringBytes: 65536 }

/**
 * Recovery installs the values a volatile cell recorded.
 *
 * A volatile cell cannot be replayed: running its source again would reach the
 * ambient source that made it volatile. The restore path therefore carries
 * values only, and these cases pin that from the worker's own traffic and from
 * the value a later cell reads.
 */
test('restores a recorded binding without running a program', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  await runtime.run('restore', { program: 'let seeded = 1', bindings: [] })
  const executor = sessionCellExecutor(runtime, 'restore')
  const posts = []
  interceptWorkerPosts(runtime, 'restore', message => {
    posts.push(message)
    return message
  })

  const outcome = await executor.restoreBindings(
    [{ name: 'recorded', wire: encodeValue({ answer: 42 }, LIMITS) }],
    { ...runtime.config },
  )
  assert.deepEqual(outcome.restored, ['recorded'])
  assert.deepEqual(outcome.failed, [])
  // The only message this path posts carries values: a repeated ambient effect
  // is impossible by construction, because no program reaches the worker.
  assert.deepEqual(posts.map(message => message.type), ['restore'])

  // Restoring is idempotent for the same name: the second pass installs the
  // same value again instead of reporting a conflict.
  const again = await executor.restoreBindings(
    [{ name: 'recorded', wire: encodeValue({ answer: 42 }, LIMITS) }],
    { ...runtime.config },
  )
  assert.deepEqual(again.restored, ['recorded'])
})

test('reports each value the worker could not install', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  await runtime.run('restore-failure', { program: 'let seeded = 1', bindings: [] })
  const executor = sessionCellExecutor(runtime, 'restore-failure')

  const outcome = await executor.restoreBindings([
    { name: 'goodName', wire: encodeValue(1, LIMITS) },
    { name: 'badName', wire: { kind: 'unsupported' } },
  ], { ...runtime.config })
  assert.deepEqual(outcome.restored, ['goodName'])
  assert.deepEqual(outcome.failed.map(entry => entry.name), ['badName'])
})

test('a missing worker reports every binding instead of throwing', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  await runtime.run('restore-no-worker', { program: 'let seeded = 1', bindings: [] })
  const worker = workerOf(runtime, 'restore-no-worker')
  await worker.terminate()
  const executor = sessionCellExecutor(runtime, 'restore-no-worker')
  const outcome = await executor.restoreBindings([{ name: 'lost', wire: { kind: 'undefined' } }], {})
  assert.deepEqual(outcome.restored, [])
  assert.deepEqual(outcome.failed.map(entry => entry.name), ['lost'])
})
