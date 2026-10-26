import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'

/**
 * With durable replay disabled the runtime keeps no recorded history at all.
 *
 * A session that already carries cells therefore has to tell the model that
 * the earlier cells were skipped, exactly as a failed replay does: the caller
 * opted out of replay, not out of honesty about the frontier.
 */
test('durable replay disabled reports the skipped frontier instead of replaying', async t => {
  const session = orderedSurfaceSession('durable-replay-off')
  const writer = new SessionRuntime()
  t.after(() => writer.dispose())
  assert.equal((await runRecordedCell(writer, session, 'before-off', {
    program: 'const kept = 7',
    bindings: [],
  })).error, undefined)

  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runRecordedCell(runtime, session, 'after-off', {
    program: 'return [1, typeof kept]',
    bindings: [],
  })

  assert.equal(result.error, undefined)
  // The earlier cell is not replayed, so its binding is absent rather than stale.
  assert.deepEqual(result.value, [1, 'undefined'])
})
