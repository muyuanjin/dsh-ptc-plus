import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime, vanishedBindingDiagnostic } from '../internal/session-runtime.js'
import { SessionCellExecutor } from '../internal/session-cell-executor.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'
import { sessionKernel } from './runtime-observation.js'

/**
 * One recovery that both installs a recorded value and drops an unrecorded one
 * reports the two sets apart.
 *
 * The first volatile cell produced a transferable value, so recovery installs
 * it. The second produced a closure, which no value wire can carry, so recovery
 * cannot install it and must name it rather than call it live. The notice has to
 * carry both facts in one sentence: what is live and what is not.
 */
test('a recovery that restores one binding and drops another names both', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = orderedSurfaceSession('notice-restored-and-dropped')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `both-${++sequence}`, { program, bindings: [] })

  assert.equal((await run('const stamp = 41')).error, undefined)
  // Reach an ambient source so the settlement is volatile, yet keep the value
  // transferable so recovery can install it.
  assert.equal((await run('const total = Date.now() > 0 ? stamp + 1 : 0')).error, undefined)
  // A closure cannot cross the value wire, so this settlement records no value.
  assert.equal((await run('const readClock = () => Date.now()')).error, undefined)

  const results = session.events.filter(event => event.type === 'tool/result')
  const totalJournal = results.at(-2).data.meta.dshPtcPlus
  assert.equal(totalJournal.status, 'volatile')
  assert.deepEqual(totalJournal.values.map(entry => entry.name), ['total'])
  const clockJournal = results.at(-1).data.meta.dshPtcPlus
  assert.deepEqual(clockJournal.values, [])
  assert.deepEqual(clockJournal.unrecordedBindings, ['readClock'])

  const recovered = new SessionRuntime()
  t.after(() => recovered.dispose())
  const read = await runRecordedCell(recovered, session, `both-${++sequence}`, {
    program: 'return [total, typeof readClock]',
    bindings: [],
  })
  assert.equal(read.error, undefined)
  assert.deepEqual(read.value, [42, 'undefined'])

  const logs = read.logs.join('\n')
  // The value the recovery installed is usable, so the cell reads 42...
  assert.deepEqual(read.value, [42, 'undefined'])
  // ...and the binding it could not install is named, so the model never reads
  // the two outcomes as the same thing. A complete restore stays silent; this
  // notice exists because one name did not survive.
  assert.match(logs, /readClock/u)
  assert.doesNotMatch(logs, /readClock[^\n]*live/iu)
})

/**
 * A recovery repeated in the same runtime explains itself once.
 *
 * The help pair states what a notice means rather than what happened, so a second
 * recovery that reports the same facts carries the explanation only once: the
 * model cannot act on the same sentence twice. The notice itself still reaches it,
 * because the facts are still true of the environment it is about to use.
 */
test('a repeated recovery keeps its facts and drops the explanation', async t => {
  const runtime = new SessionRuntime({ surfaceProvenanceRequired: true })
  t.after(() => runtime.dispose().catch(() => {}))
  const session = orderedSurfaceSession('repeated-recovery-help')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `repeat-${++sequence}`, { program, bindings: [] })
  const dropWorker = () => {
    sessionKernel(runtime, session.id ?? session).client.worker = undefined
  }

  // A checkpoint, a cell that declares a binding after it, and a recorded rewind
  // back to the checkpoint: the replay ends the binding, which is what PTC-R005
  // reports apart from a loss.
  assert.equal((await run('return await repl.state({action:"save",name:"cut"})')).error, undefined)
  assert.equal((await run('const kept = 1; return kept')).value, 1)
  assert.equal((await run('return await repl.state({action:"restore",name:"cut"})')).value.restored, true)

  // The first recovery after the rewind does not report it: the surface window it
  // folds has not moved past the rewind yet. The next one replays the rewind and
  // states it once, with the help pair that explains what it means.
  dropWorker()
  await run('return typeof kept')
  await run('return 2')
  dropWorker()
  const first = await run('return 3')
  const explained = first.logs.filter(line => line.includes('PTC-R005'))
  assert.equal(explained.length, 1, JSON.stringify(first.logs))
  assert.match(explained[0], /\(kept\)/u)
  assert.match(explained[0], /help: this is not a recovery failure/u)

  // The same facts after another lost worker: the notice stays, the help does not.
  await run('return 4')
  dropWorker()
  const again = await run('return 5')
  const repeated = again.logs.filter(line => line.includes('PTC-R005'))
  assert.equal(repeated.length, 1, JSON.stringify(again.logs))
  assert.match(repeated[0], /\(kept\)/u)
  assert.doesNotMatch(repeated[0], /help: /u)
})

test('consecutive recoveries each report the facts they replay', async t => {
  // Two recoveries in a row, with no ordinary cell between them: the second one
  // replays the same recorded rewind and owes the same fact. Suppressing it left the
  // withdrawn names reported nowhere while the runtime had already recorded them as
  // announced, so a later reference would fail as the model's own mistake.
  const runtime = new SessionRuntime({ surfaceProvenanceRequired: true })
  t.after(() => runtime.dispose().catch(() => {}))
  const session = orderedSurfaceSession('consecutive-recovery-notices')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `consecutive-${++sequence}`, { program, bindings: [] })
  const dropWorker = () => {
    sessionKernel(runtime, session.id ?? session).client.worker = undefined
  }

  assert.equal((await run('return await repl.state({action:"save",name:"cut"})')).error, undefined)
  assert.equal((await run('const kept = 1; return kept')).value, 1)
  assert.equal((await run('return await repl.state({action:"restore",name:"cut"})')).value.restored, true)
  dropWorker()
  await run('return typeof kept')
  dropWorker()
  const first = await run('return 3')
  const reported = first.logs.filter(line => line.includes('PTC-R005'))
  assert.equal(reported.length, 1, JSON.stringify(first.logs))
  assert.match(reported[0], /\(kept\)/u)
  dropWorker()
  const second = await run('return 4')
  const repeated = second.logs.filter(line => line.includes('PTC-R005'))
  assert.equal(repeated.length, 1, JSON.stringify(second.logs))
  assert.match(repeated[0], /\(kept\)/u)
  assert.doesNotMatch(repeated[0], /help: /u, 'the explanation is stated once')
})

/**
 * A binding a recovery promised as live, then reported missing by the engine,
 * is named once — and the name is drained so a repeat stays quiet.
 *
 * The model did nothing wrong when it wrote `total`: the recovery said the name
 * was live, so a plain `ReferenceError` would read as its own mistake. Naming
 * the vanishing binding separates "your source is wrong" from "the value this
 * cell expected is gone". Nothing else is worth repeating on the next cell, so
 * the second failure stays silent.
 */test('a binding a recovery called live and then vanished is named once', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = orderedSurfaceSession('vanished-announced-binding')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `vanished-${++sequence}`, { program, bindings: [] })

  assert.equal((await run('const stamp = 7')).error, undefined)
  // A transferable volatile value and a closure in the same session: recovery
  // installs `total`, cannot install `readClock`, so the notice names what is
  // live — that announcement is what `announcedLive` remembers.
  assert.equal((await run('const total = Date.now() > 0 ? stamp + 35 : 0')).error, undefined)
  assert.equal((await run('const readClock = () => Date.now()')).error, undefined)

  const recovered = new SessionRuntime()
  t.after(() => recovered.dispose())
  const first = await runRecordedCell(recovered, session, `vanished-${++sequence}`, {
    program: 'return total',
    bindings: [],
  })
  assert.equal(first.error, undefined)
  assert.equal(first.value, 42)
  // The recovery speaks about the name it could not install; `total` is installed
  // silently and remembered as announced-live, which is what the next assertion uses.
  assert.match(first.logs.join('\n'), /readClock/u)

  const expected = vanishedBindingDiagnostic(['total'])
  const prefix = expected.message.slice(0, 24)

  // The engine reports a name the recovery promised as live. The notice exists so
  // a correct reference is not read as the model's own mistake.
  const lost = await runRecordedCell(recovered, session, `vanished-${++sequence}`, {
    program: 'throw new ReferenceError("total is not defined")',
    bindings: [],
  })
  assert.match(lost.error.message, /total is not defined/u)
  assert.ok(lost.logs.some(line => line.includes(prefix)), `expected the vanished notice, got ${JSON.stringify(lost.logs)}`)

  // Drained: the same reference in the next cell is a plain failure again.
  const again = await runRecordedCell(recovered, session, `vanished-${++sequence}`, {
    program: 'throw new ReferenceError("total is not defined")',
    bindings: [],
  })
  assert.equal(again.logs.some(line => line.includes(prefix)), false)
})

/**
 * A recorded value that the restore could not install is reported as not live.
 *
 * Without this branch the projection would either stay silent (the model assumes
 * the value survived) or report it as dropped. Both are wrong: the record exists,
 * the install failed, so the notice has to say which name is missing and that
 * nothing else was lost.
 */
test('a recorded value that could not be installed is named as not live', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = orderedSurfaceSession('failed-install-notice')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `install-${++sequence}`, { program, bindings: [] })

  assert.equal((await run('const stamp = 41')).error, undefined)
  assert.equal((await run('const total = Date.now() > 0 ? stamp + 1 : 0')).error, undefined)

  // The install seam is the executor's restore; make the worker unable to accept
  // the recorded value so the runtime composes its "could not be installed"
  // sentence instead of silently claiming the binding is live.
  const original = SessionCellExecutor.prototype.restoreBindings
  SessionCellExecutor.prototype.restoreBindings = async function (values) {
    return { restored: [], failed: values.map(entry => ({ name: entry.name, reason: 'no live worker' })) }
  }
  t.after(() => { SessionCellExecutor.prototype.restoreBindings = original })

  const recovered = new SessionRuntime()
  t.after(() => recovered.dispose())
  const read = await runRecordedCell(recovered, session, `install-${++sequence}`, {
    program: 'return 1',
    bindings: [],
  })

  const logs = read.logs.join('\n')
  assert.match(logs, /could not be installed/u)
  assert.match(logs, /total/u)
  assert.doesNotMatch(logs, /PTC-R002/u)
})

/**
 * With a required surface, losing the worker between cells re-derives history and
 * reports the volatile suffix instead of silently replaying it.
 *
 * The first cell leaves live state, the worker is then gone, so the provenance
 * block runs on the next execution and must record the recovery boundary.
 */
test('a required surface reports the volatile suffix when the worker is gone', async t => {
  const runtime = new SessionRuntime({ surfaceProvenanceRequired: true })
  t.after(() => runtime.dispose().catch(() => {}))
  const session = orderedSurfaceSession('provenance-worker-gone')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `prov-${++sequence}`, { program, bindings: [] })

  assert.equal((await run('const kept = 1')).error, undefined)
  assert.equal((await run('const held = () => Date.now()')).error, undefined)
  assert.deepEqual((await run('return kept + 1')).value, 2)

  // Drop the helper without going through the runtime, so the next execution sees
  // no worker and has to decide from the surface whether to rebuild.
  sessionKernel(runtime, session.id ?? session).client.worker = undefined
  const after = await run('return typeof held')
  assert.equal(after.error, undefined)

  const logs = after.logs.join('\n')
  assert.match(logs, /recover|Restored|skipped|volatile/iu)
})

/**
 * An unavailable recovered suffix has no verified frontier, so the first replay
 * records the boundary it contracted to instead of replaying through the gap.
 */
test('a first replay records the boundary of an unavailable recovered suffix', async t => {
  const runtime = new SessionRuntime({ surfaceProvenanceRequired: true })
  t.after(() => runtime.dispose().catch(() => {}))
  const session = orderedSurfaceSession('provenance-unavailable-suffix')
  let sequence = 0
  const run = program => runRecordedCell(runtime, session, `suffix-${++sequence}`, { program, bindings: [] })

  assert.equal((await run('const kept = 1')).error, undefined)
  sessionKernel(runtime, session.id ?? session).client.worker = undefined

  // Two executable calls claiming the same canonical sequence disprove the log,
  // so the fold reports an unavailable suffix with no trusted frontier.
  const duplicated = {
    surface: { nodes: [] },
    events: [
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'dup-a', name: 'run_code', arguments: '{}' } },
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'dup-b', name: 'run_code', arguments: '{}' } },
    ],
  }
  const execution = await runtime.runTentative(
    { id: session.id, session, callId: `suffix-${++sequence}`, sessionLog: duplicated },
    { program: 'return typeof kept', bindings: [] },
  )
  const logs = (execution.result.logs ?? []).join('\n')
  // The suffix is unavailable, so the model is told what was skipped rather than
  // being handed a head it cannot trust.
  assert.match(logs, /Restored the durable head and (skipped|dropped)/u)
})
