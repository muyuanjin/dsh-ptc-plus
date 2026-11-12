import { environmentResetMessage } from '../internal/runtime-messages.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendOnlySession, runRecordedCell, orderedSurfaceSession, appendRunCodeCall, appendRunCodeResult, fixture,
} from './plugin-fixture.js'
import { recoverJournal } from '../internal/session-journal-recovery.js'
import { isEnvironmentResetEvent } from '../internal/session-journal-schema.js'
import { SessionRuntime } from '../internal/session-runtime.js'

test('damaged reset metadata contracts once and preserves new computation across cold recovery', async t => {
  for (const version of [undefined, 2]) {
    const events = []
    const session = orderedSurfaceSession(`damaged-reset-${version}`, events)
    let effects = 0
    let sequence = 0
    const bindings = [{ global: 'tools', functions: { effect: async () => ++effects } }]
    const cold = () => {
      const runtime = new SessionRuntime()
      t.after(() => runtime.dispose())
      return runtime
    }
    const run = async (runtime, program, confirmed = true) => {
      const callId = `damaged-${++sequence}`
      const { callSeq } = appendRunCodeCall(events, callId, program)
      const execution = await runtime.runTentative({ id: session.id, session, callId }, { program, bindings })
      runtime.finalize(execution.settlement, confirmed)
      appendRunCodeResult(events, callId, callSeq, confirmed ? { meta: {
        dshPtcPlus: execution.settlement.journal,
        ...(execution.settlement.recoveryBoundaries === undefined ? {} : {
          dshPtcPlusRecoveryBoundaries: execution.settlement.recoveryBoundaries,
        }),
      } } : {})
      return execution
    }
    let runtime = cold()
    await run(runtime, 'let old = await tools.effect(); await repl.state({ action: "save", name: "old" })')
    await runtime.dispose()
    const message = structuredClone(environmentResetMessage())
    if (version === undefined) delete message.source.version
    else message.source.version = version
    const resetSeq = events.length
    events.push({ seq: resetSeq, type: 'user/message', data: message, surfaceOp: 'append' })
    runtime = cold()
    const unpublished = await run(runtime, 'let unpublished = 3; return unpublished', false)
    assert.equal(unpublished.result.value, 3)
    await runtime.dispose()
    runtime = cold()
    const fresh = await run(runtime, 'let fresh = await tools.effect(); return fresh')
    assert.equal(fresh.result.value, 2)
    assert.equal(fresh.result.logs.filter(log => log.includes('PTC-R002')).length, 1)
    assert.deepEqual(fresh.settlement.recoveryBoundaries, [{ failedResetSeq: resetSeq, frontierCallSeq: null }])
    await runtime.dispose()
    for (let restart = 0; restart < 2; restart++) {
      runtime = cold()
      const recovered = await run(runtime, 'return [typeof old, typeof unpublished, fresh, (await repl.state({ action: "list" })).names]')
      assert.deepEqual(recovered.result.value, ['undefined', 'undefined', 2, []])
      assert.equal(recovered.settlement.recoveryBoundaries, undefined)
      assert.deepEqual(recovered.result.logs, [])
      assert.equal(recoverJournal(session).available, true)
      await runtime.dispose()
    }
    const fork = orderedSurfaceSession(`${session.id}-fork`, JSON.parse(JSON.stringify(events)))
    const forkRuntime = cold()
    const forkCall = appendRunCodeCall(fork.events, 'fork-read', 'return fresh')
    const forked = await forkRuntime.runTentative({ id: fork.id, session: fork, callId: 'fork-read' },
      { program: 'return fresh', bindings })
    forkRuntime.finalize(forked.settlement, true)
    assert.equal(forked.result.value, 2)
    assert.equal(forked.settlement.recoveryBoundaries, undefined)
    assert.equal(forkCall.callSeq, fork.events.length - 1)
    assert.equal(effects, 2, 'cold recovery must not repeat old or new native effects')
  }
})

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

test('Host reset clears bindings and checkpoints across cold recovery without repeating effects', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = appendOnlySession('host-reset')
  let sequence = 0
  let effects = 0
  const bindings = [{ global: 'tools', functions: { effect: async () => ++effects } }]
  const run = (target, program) => runRecordedCell(target, session, `reset-${++sequence}`, { program, bindings })
  assert.equal((await run(runtime, 'let oldValue = await tools.effect(); await repl.state({ action: "save", name: "old" }); return oldValue')).value, 1)
  await runtime.resetEnvironment(session)
  assert.equal(session.events.filter(isEnvironmentResetEvent).length, 1)
  assert.equal(recoverJournal(session).nodes.length, 0)
  assert.equal((await run(runtime, 'return typeof oldValue')).value, 'undefined')
  assert.deepEqual((await run(runtime, 'return await repl.state({ action: "list" })')).value.names, [])
  assert.equal((await run(runtime, 'let newValue = 7; return newValue')).value, 7)
  await runtime.disposeAgent(session.id)
  const cold = new SessionRuntime()
  t.after(() => cold.dispose())
  assert.deepEqual((await run(cold, 'return [typeof oldValue, newValue]')).value, ['undefined', 7])
  assert.equal(effects, 1)
})

test('ordinary Agent disposal retains proven session computation', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = appendOnlySession('agent-dispose-recovery')
  assert.equal((await runRecordedCell(runtime, session, 'before', { program: 'let kept = 42', bindings: [] })).error, undefined)
  await runtime.disposeAgent(session.id)
  assert.equal((await runRecordedCell(runtime, session, 'after', { program: 'return kept', bindings: [] })).value, 42)
  assert.equal(session.events.some(isEnvironmentResetEvent), false)
})

test('Host reset reports cleanup and journal failures and permits retry', async () => {
  const runtime = new SessionRuntime()
  const events = []
  let appendFailure = true
  const session = { id: 'reset-failure', append(type, data) {
    if (appendFailure) throw new Error('append failed')
    events.push({ type, data })
  } }
  let cleanupFailure = true
  runtime.kernels.set(session.id, { async dispose() { if (cleanupFailure) throw new Error('cleanup failed') } })
  await assert.rejects(runtime.resetEnvironment(session), /cleanup failed/)
  assert.equal(runtime.kernels.has(session.id), true)
  assert.equal(events.length, 0)
  cleanupFailure = false
  await assert.rejects(runtime.resetEnvironment(session), /append failed/)
  assert.equal(events.length, 0)
  appendFailure = false
  await runtime.resetEnvironment(session)
  assert.equal(events.length, 1)
  assert.equal(isEnvironmentResetEvent(events[0]), true)
  assert.equal(events[0].data.content[0].text, environmentResetMessage().content[0].text)
  await runtime.dispose()
})


test('Host reset without a public append API preserves the live computation', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const session = appendOnlySession('reset-missing-append')
  await runRecordedCell(runtime, session, 'before', { program: 'let kept = 42', bindings: [] })
  const kernel = runtime.kernels.get(session.id)
  const eventCount = session.events.length
  for (const invalid of [undefined, { id: session.id }, { id: session.id, append: true }]) {
    await assert.rejects(runtime.resetEnvironment(invalid), {
      name: 'TypeError', message: 'ptc-plus: environment reset requires the public session append API',
    })
    assert.equal(runtime.kernels.get(session.id), kernel)
    assert.equal(session.events.length, eventCount)
  }
  assert.equal((await runRecordedCell(runtime, session, 'after', { program: 'return kept', bindings: [] })).value, 42)
})


test('public provider release clears live bindings and records the Host environment reset', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = appendOnlySession('provider-reset')
  await state.run(session.id, 'let kept = 42', {}, { session })
  await state.runtime.release({ id: session.id, session })
  assert.equal(session.events.filter(isEnvironmentResetEvent).length, 1)
  assert.equal((await state.run(session.id, 'return typeof kept', {}, { session })).value, 'undefined')
})
