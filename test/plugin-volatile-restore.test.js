import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'

/**
 * A volatile cell keeps the bindings it declared.
 *
 * The cell reached an ambient source, so replaying it would dispatch that
 * source again. Recovery installs the values the settlement recorded instead:
 * the bindings survive, the completion stays unproven, and the suffix is not
 * dropped.
 */
test('a volatile cell keeps its bindings through recovery', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = orderedSurfaceSession('volatile-restore')
  let sequence = 0
  const run = (target, program) => runRecordedCell(target, session, `volatile-${++sequence}`, { program, bindings: [] })

  assert.equal((await run(runtime, 'const stamp = 41')).error, undefined)
  assert.equal((await run(runtime, 'const started = Date.now(); const total = stamp + 1')).error, undefined)
  const journal = session.events.at(-1).data.meta.dshPtcPlus
  assert.equal(journal.status, 'volatile')
  assert.deepEqual(journal.values.map(entry => entry.name).sort(), ['started', 'total'])

  const recovered = new SessionRuntime()
  t.after(() => recovered.dispose())
  const read = await runRecordedCell(recovered, session, `volatile-${++sequence}`, { program: 'return total', bindings: [] })
  assert.equal(read.error, undefined)
  assert.equal(read.value, 42)
})

test('a volatile cell whose values cannot be recorded is named in the contraction', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = orderedSurfaceSession('volatile-named')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `named-${++sequence}`, { program, bindings: [] })

  await run('const kept = 1')
  // A closure cannot be transferred, so this cell has nothing to restore and
  // must be reported as a contraction that names the binding it costs.
  await run('const readClock = () => Date.now()')
  const journal = session.events.at(-1).data.meta.dshPtcPlus
  assert.equal(journal.status, 'volatile')
  assert.deepEqual(journal.values, [])
  assert.deepEqual(journal.unrecordedBindings, ['readClock'])

  const recovered = new SessionRuntime()
  t.after(() => recovered.dispose())
  const read = await runRecordedCell(recovered, session, `named-${++sequence}`, { program: 'return typeof readClock', bindings: [] })
  assert.equal(read.error, undefined)
  assert.equal(read.value, 'undefined')
  assert.match(String(read.logs.join('\n')), /readClock/u)
})
