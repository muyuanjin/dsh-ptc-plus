import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'
import { sessionKernel } from './runtime-observation.js'

/**
 * A required surface with durable replay disabled contracts to an empty history
 * and records the skip, rather than replaying anything.
 *
 * The host can turn durable replay off; on a required surface the runtime then
 * has nothing to rebuild from and must stay honest about the contraction.
 */
test('a required surface without durable replay contracts to an empty history', async t => {
  const session = orderedSurfaceSession('provenance-no-durable-replay')
  let sequence = 0
  const seed = new SessionRuntime()
  t.after(() => seed.dispose())
  const seedRun = program => runRecordedCell(seed, session, `seed-${++sequence}`, { program, bindings: [] })
  assert.equal((await seedRun('const kept = 3')).error, undefined)

  const runtime = new SessionRuntime({ surfaceProvenanceRequired: true, durableReplay: false, session })
  t.after(() => runtime.dispose().catch(() => {}))
  const run = program => runRecordedCell(runtime, session, `read-${++sequence}`, { program, bindings: [] })

  // First cell creates the kernel; the surface then changes and the helper is
  // gone, so the provenance block runs with durable replay disabled.
  assert.equal((await run('return 1')).error, undefined)
  sessionKernel(runtime, session.id ?? session).client.worker = undefined
  session.surface.replaceGeneration += 1
  const read = await run('return 2')

  assert.equal(read.error, undefined)
  assert.match(read.logs.join('\n'), /skipped 1/iu)
})


