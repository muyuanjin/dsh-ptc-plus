import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { encodeValue } from '../internal/value-wire.js'
import { interceptWorkerPosts, sessionCellExecutor, workerOf, failScratchDirectory } from './runtime-observation.js'

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

test('a transport that refuses the restore reports every binding instead of rejecting', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  await runtime.run('restore-refused', { program: 'let seeded = 1', bindings: [] })
  const executor = sessionCellExecutor(runtime, 'restore-refused')
  // A worker can disappear between the liveness check and the frame, so the post
  // itself may throw. The caller still has to name every binding it could not
  // install: a rejection here would replace the model's recovery report with a
  // cell failure.
  interceptWorkerPosts(runtime, 'restore-refused', () => { throw new Error('transport refused the frame') })
  const outcome = await executor.restoreBindings(
    [{ name: 'lost', wire: encodeValue(1, LIMITS) }],
    { ...runtime.config },
  )
  assert.deepEqual(outcome.restored, [])
  assert.deepEqual(outcome.failed, [{ name: 'lost', reason: 'transport refused the frame' }])
})

test('a name a running cell overlays keeps its overlay instead of a recorded value', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  let started
  const running = new Promise(resolve => { started = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const execution = runtime.runTentative('restore-overlay', {
    program: 'return tools.wait()',
    bindings: [{ global: 'tools', functions: { wait: async () => { started(); await gate; return 'ran' } } }],
  })
  await running
  // The suspended cell still owns its request namespace, so the name is a hard
  // overlay: a recorded value cannot take it over and must be reported instead of
  // silently winning or silently disappearing.
  const executor = sessionCellExecutor(runtime, 'restore-overlay')
  const outcome = await executor.restoreBindings(
    [{ name: 'tools', wire: encodeValue({ recorded: true }, LIMITS) }],
    { ...runtime.config },
  )
  // Release before asserting: a suspended cell holds its program bindings
  // installed, so an expectation that fails here must not leave the kernel running
  // a program the test never finishes.
  release()
  const settled = await execution
  assert.deepEqual(outcome.restored, [])
  assert.deepEqual(outcome.failed, [{ name: 'tools', reason: 'the store cannot publish a session identity for this name' }])
  assert.equal(settled.result.value, 'ran')
})

test('a restore-only cell whose worker cannot start fails as a worker exit', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  await runtime.run('restore-no-start', { program: 'let seeded = 1', bindings: [] })
  const worker = workerOf(runtime, 'restore-no-start')
  await worker.terminate()
  failScratchDirectory(runtime, 'restore-no-start', new Error('scratch unavailable'))
  const executor = sessionCellExecutor(runtime, 'restore-no-start')
  const outcome = await executor.executeCell({
    program: 'return 1',
    restoreValues: [{ name: 'early', wire: encodeValue(7, LIMITS) }],
  })
  // Nothing ran and nothing was installed: the cell reports the infrastructure
  // failure instead of claiming the bindings came back.
  assert.deepEqual(outcome.logs, [])
  assert.equal(outcome.error.kind, 'worker-exit')
  assert.match(outcome.error.message, /scratch unavailable/u)
  assert.equal(outcome.restored, undefined)
})

/**
 * A restore-only request installs recorded values and never touches the program.
 *
 * An off-path node is dead by definition: it is not on the path to the head, so
 * its source may reference bindings a recorded rewind ended. Preparing that source
 * used to reject the request, which is why the off-path repair installed nothing;
 * the request now installs the values and advances the catalog from their names.
 */
test('installs recorded values without compiling the dead program', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  await runtime.run('restore-only', { program: 'let seeded = 1', bindings: [] })
  const executor = sessionCellExecutor(runtime, 'restore-only')

  const outcome = await executor.executeCell({
    // If this program ever ran, the request would fail: the proof of "no execution"
    // is that the restore succeeds while the source would throw.
    program: 'throw new Error("the dead program must not run")',
    restoreValues: [{ name: 'early', wire: encodeValue(7, LIMITS) }],
  })
  assert.deepEqual(outcome.restored, ['early'])
  assert.deepEqual(outcome.failed, [])

  // The catalog advanced from the recorded name, so a later cell compiles against it.
  const read = await runtime.run('restore-only', { program: 'return early', bindings: [] })
  assert.equal(read.error, undefined)
  assert.equal(read.value, 7)
})
