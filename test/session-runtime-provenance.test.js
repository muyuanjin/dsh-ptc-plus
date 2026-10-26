import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'

/**
 * The first replay of a session whose earliest volatile cell could not record
 * its value still speaks about it.
 *
 * The runtime only takes the surface-provenance path when the host requires it,
 * so this fixture enables it explicitly. The session's last cell records a
 * closure, which no value wire can carry, so the first fold leaves a non-empty
 * volatile suffix and the recovery notice must name the contraction once.
 */
test('a first replay reports the volatile suffix it could not replay', async t => {
  const session = orderedSurfaceSession('provenance-first-replay')
  let sequence = 0
  const seed = new SessionRuntime()
  t.after(() => seed.dispose())
  const seedRun = program => runRecordedCell(seed, session, `seed-${++sequence}`, { program, bindings: [] })

  assert.equal((await seedRun('const kept = 7')).error, undefined)
  assert.equal((await seedRun('const readClock = () => Date.now()')).error, undefined)

  const runtime = new SessionRuntime({ surfaceProvenanceRequired: true, session })
  t.after(() => runtime.dispose())
  // The provenance path runs when a required surface changes after construction;
  // a host republish is exactly that, so bump the generation before the cell.
  session.surface.replaceGeneration += 1
  const read = await runRecordedCell(runtime, session, `read-${++sequence}`, {
    program: 'return typeof kept',
    bindings: [],
  })
  assert.equal(read.error, undefined)

  const logs = read.logs.join('\n')
  assert.match(logs, /readClock|volatile/u)
  assert.equal(read.value, 'number', 'the durable prefix still replays its value')
})
