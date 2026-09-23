import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Config } from '../index.js'
import { RECOVERY_BOUNDARY_KEY, normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import {
  JOURNAL_POLICY,
  appendOnlySession,
  appendRunCodeCall,
  appendRunCodeEvents,
  fixture,
} from './plugin-fixture.js'
import {
  hasSessionKernel,
  restartWorker,
  sessionKernel,
  workerOf,
} from './runtime-observation.js'

function appendVisibleToolCall(events, callId, name, args) {
  const argumentsValue = JSON.stringify(args)
  const assistantSeq = events.length
  events.push({
    seq: assistantSeq,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: callId, name, arguments: argumentsValue }] } },
  })
  const callSeq = events.length
  events.push({
    seq: callSeq,
    type: 'tool/call',
    data: { callId, name, arguments: argumentsValue },
  })
  return { assistantSeq, callSeq }
}

function appendToolResult(events, callId, callSeq, result) {
  const seq = events.length
  events.push({
    seq,
    type: 'tool/result',
    sourceEventSeqs: [callSeq],
    data: {
      message: { source: { kind: 'tool', callId } },
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    },
  })
  return seq
}

async function executeRecordedFixture(state, session, events, callId, program, functions = {}, options = {}) {
  const call = appendVisibleToolCall(events, callId, 'run_code', {
    code: program,
    description: options.description ?? 'test cell',
  })
  const execution = await state.executeRun(session.id, program, functions, {
    ...options,
    session,
    callId,
  })
  return { ...execution, ...call }
}

test('ambiguous historical call sequences persist a contraction across cold restarts', async t => {
  for (const prefix of [false, true]) {
    const events = []
    const session = appendOnlySession(`ambiguous-history-${prefix}`, events)
    const writer = fixture()
    t.after(() => writer.dispose())
    const recorded = await writer.runDurable(session.id, 'const stable=1', {}, {
      session,
      recordSession: false,
    })
    if (prefix) appendRunCodeEvents(events, 'stable', 'const stable=1', recorded)
    await writer.dispose()
    appendRunCodeEvents(events, 'ambiguous-a', 'throw Error("unproved source A")', recorded)
    const ambiguousCall = events.find(event => (
      event.type === 'tool/call' && event.data?.callId === 'ambiguous-a'
    ))
    const ambiguousSeq = ambiguousCall.seq
    const stableCallSeq = events.find(event => (
      event.type === 'tool/call' && event.data?.callId === 'stable'
    ))?.seq ?? null
    events.push({ ...ambiguousCall, data: { ...ambiguousCall.data,
      callId: 'ambiguous-b', arguments: JSON.stringify({ code: 'throw Error("unproved source B")' }) } })
    // Results associated by sequence or call identity must both remain unproved.
    events.push({ type: 'tool/result', seq: events.length, sourceEventSeqs: [ambiguousSeq],
      data: { message: { source: { kind: 'tool', callId: 'ambiguous-b' } }, meta: recorded.meta } })
    for (let round = 0; round < 3; round++) {
      const runtime = new SessionRuntime()
      t.after(() => runtime.dispose())
      const callId = `current-${round}`
      const program = round === 0 ? 'const continued=41;return continued' : 'return [continued,typeof stable]'
      const { callSeq } = appendVisibleToolCall(events, callId, 'run_code', {
        code: program,
        description: 'current',
      })
      const execution = await runtime.runTentative({ id: session.id, session, callId }, { program, bindings: [] })
      assert.equal(execution.result.error, undefined, execution.result.error?.message)
      assert.deepEqual(execution.result.value, round === 0 ? 41 : [41, prefix ? 'number' : 'undefined'])
      assert.equal(execution.result.logs.filter(log => log.includes('PTC-R002')).length, round === 0 ? 1 : 0)
      assert.deepEqual(execution.settlement.recoveryBoundaries, round === 0
        ? [{ failedCallSeq: ambiguousSeq, frontierCallSeq: stableCallSeq }] : undefined)
      const meta = { dshPtcPlus: normalizeJournal(execution.settlement.journal) }
      if (execution.settlement.recoveryBoundaries !== undefined) meta[RECOVERY_BOUNDARY_KEY] = execution.settlement.recoveryBoundaries
      events.push({ type: 'tool/result', seq: events.length, sourceEventSeqs: [callSeq], data: { meta } })
      runtime.finalize(execution.settlement, true)
      await runtime.dispose()
    }
  }
})

test('rejects replaced, corrupt, or extended persisted journals during confirmation', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const replacedEvents = []
  const replacedSession = appendOnlySession('replaced-journal', replacedEvents)
  const replaced = (await executeRecordedFixture(state, replacedSession, replacedEvents,
    'replaced-first', 'const replacedJournalValue = 1', {}, {
    finalizeResult(result) {
      return {
        ...result,
        meta: {
          ...result.meta,
          dshPtcPlus: {
            version: 3,
            rewritePolicy: JOURNAL_POLICY,
            status: 'noop',
            calls: [],
            operations: [],
            confirms: [],
          },
        },
      }
    },
    })).result
  assert.equal(replaced.meta.dshPtcPlus.status, 'noop')
  const afterReplacement = (await executeRecordedFixture(state, replacedSession, replacedEvents,
    'replaced-second', 'return replacedJournalValue')).result
  assert.equal(afterReplacement.value, 1)
  assert.equal(afterReplacement.meta.dshPtcPlus.status, 'volatile')

  const corruptEvents = []
  const corruptSession = appendOnlySession('corrupt-journal', corruptEvents)
  const corrupt = (await executeRecordedFixture(state, corruptSession, corruptEvents,
    'corrupt-first', 'const corruptJournalValue = 2', {}, {
    finalizeResult(result) {
      return { ...result, meta: { ...result.meta, dshPtcPlus: { version: 2 } } }
    },
    })).result
  assert.deepEqual(corrupt.meta.dshPtcPlus, { version: 2 })
  const afterCorruption = (await executeRecordedFixture(state, corruptSession, corruptEvents,
    'corrupt-second', 'return corruptJournalValue')).result
  assert.equal(afterCorruption.value, 2)
  assert.equal(afterCorruption.meta.dshPtcPlus.status, 'volatile')

  const extendedEvents = []
  const extendedSession = appendOnlySession('extended-journal', extendedEvents)
  const extended = (await executeRecordedFixture(state, extendedSession, extendedEvents,
    'extended-first', 'const extendedJournalValue = 3', {}, {
    finalizeResult(result) {
      return {
        ...result,
        meta: {
          ...result.meta,
          dshPtcPlus: { ...result.meta.dshPtcPlus, injected: true },
        },
      }
    },
    })).result
  assert.equal(extended.meta.dshPtcPlus.injected, true)
  const afterExtension = (await executeRecordedFixture(state, extendedSession, extendedEvents,
    'extended-second', 'return extendedJournalValue')).result
  assert.equal(afterExtension.value, 3)
  assert.equal(afterExtension.meta.dshPtcPlus.status, 'volatile')

  const diagnosticEvents = []
  const diagnosticSession = appendOnlySession('extended-diagnostic', diagnosticEvents)
  const extendedDiagnostic = (await executeRecordedFixture(
    state,
    diagnosticSession,
    diagnosticEvents,
    'diagnostic-first',
    'const diagnosticJournalValue = 4\nthrow new Error("expected failure")',
    {},
    {
      finalizeResult(result) {
        const diagnostics = result.meta.dshPtcPlus.diagnostics.map((item, index) => (
          index === 0 ? { ...item, injected: true } : item
        ))
        return {
          ...result,
          meta: {
            ...result.meta,
            dshPtcPlus: { ...result.meta.dshPtcPlus, diagnostics },
          },
        }
      },
    },
  )).result
  assert.equal(extendedDiagnostic.meta.dshPtcPlus.diagnostics[0].injected, true)
  const afterDiagnosticExtension = (await executeRecordedFixture(state, diagnosticSession, diagnosticEvents,
    'diagnostic-second', 'return diagnosticJournalValue')).result
  assert.equal(afterDiagnosticExtension.value, 4)
  assert.equal(afterDiagnosticExtension.meta.dshPtcPlus.status, 'volatile')
})
test('confirms pre-dispatch no-ops in the next durable journal', async (t) => {
  const events = []
  const session = appendOnlySession('session-confirm-noop', events)
  const first = fixture()
  t.after(() => first.dispose())

  const rejectedCode = 'const rejectedBinding = 1'
  events.push({
    seq: 0,
    type: 'tool/call',
    data: {
      callId: 'pre-denied-call',
      name: 'run_code',
      arguments: JSON.stringify({ code: rejectedCode, description: 'test cell' }),
    },
  })
  // The host rejects the call inside the top-level run_code hook, before the
  // runtime is dispatched.
  const execute = first.listeners.get('tools/execute')[0]
  const rejectedCall = {
    name: 'run_code',
    callId: 'pre-denied-call',
    agent: { id: session.id, session },
  }
  const rejected = await execute(rejectedCall, async () => ({
    isError: true,
    content: [],
    error: { message: 'rejected before runtime dispatch' },
  }))
  for (const listener of first.listeners.get('tools/result') ?? []) await listener(rejectedCall, rejected)
  events.push({ seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { meta: rejected.meta } })

  const durableCode = 'const acceptedBinding = 2'
  const durable = await first.runDurable(session.id, durableCode, {}, { session, recordSession: 'deferred-result', callId: 'accepted-call' })
  assert.deepEqual(durable.meta.dshPtcPlus.confirms, [0])
  appendRunCodeEvents(events, 'accepted-call', durableCode, durable)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const inspectCode = 'return { rejected: typeof rejectedBinding, acceptedBinding }'
  appendRunCodeCall(events, 'inspect-confirmed-noop', inspectCode, 'inspect confirmed no-op')
  const result = await restored.run(session.id, inspectCode, {}, {
    session,
    callId: 'inspect-confirmed-noop',
    description: 'inspect confirmed no-op',
  })
  assert.deepEqual(result.value, { rejected: 'undefined', acceptedBinding: 2 })
  assert.deepEqual(result.logs, [])
})

test('reconstructs the live REPL from only session-log journal metadata', async (t) => {
  const events = []
  const first = fixture()
  const session = appendOnlySession('session-a', events)
  t.after(() => first.dispose())

  let originalCalls = 0
  const firstCode = 'const persistedValue = await tools.readValue({})'
  const firstResult = await first.runDurable('session-a', firstCode, {
    readValue: async () => { originalCalls++; return 40 },
  }, { session, recordSession: 'deferred-result', callId: 'call-1' })
  assert.equal(originalCalls, 1)
  appendRunCodeEvents(events, 'call-1', firstCode, firstResult)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let replayedExternalCalls = 0
  let invoked = 0
  const secondCode = 'return persistedValue + await tools.answer({})'
  const secondResult = await restored.runDurable('session-a', secondCode, {
    readValue: async () => { replayedExternalCalls++; throw new Error('replayed external call') },
    answer: async () => { invoked++; return 2 },
  }, { session })
  assert.deepEqual(secondResult.value, 42)
  assert.equal(invoked, 1)
  assert.equal(replayedExternalCalls, 0)
})

test('replays imports without consuming user bindings that resemble private namespaces', async (t) => {
  const events = []
  const session = appendOnlySession('import-private-replay', events)
  const first = fixture()
  t.after(() => first.dispose())

  const userCode = 'const __dsh_ptc_import_namespace_0__ = 99'
  const userResult = await first.runDurable(session.id, userCode, {}, { session, recordSession: 'deferred-result', callId: 'private-user-binding' })
  appendRunCodeEvents(events, 'private-user-binding', userCode, userResult)

  const importCode = "import { inspect } from 'node:util'; const inspectType = typeof inspect"
  const importResult = await first.runDurable(session.id, importCode, {}, { session, recordSession: 'deferred-result', callId: 'private-import-binding' })
  assert.equal(importResult.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'private-import-binding', importCode, importResult)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, [
    'return [__dsh_ptc_import_namespace_0__, inspectType, typeof inspect]',
  ].join('\n'), {}, { session }), {
    logs: [],
    value: [99, 'function', 'function'],
  })
})

test('replays concurrent native tool calls in their recorded settlement order', async (t) => {
  const events = []
  const first = fixture()
  const session = appendOnlySession('session-race', events)
  t.after(() => first.dispose())
  const code = `
const recordedWinner = await Promise.race([
  tools.slow({}),
  tools.fast({}),
])
`
  const result = await first.runDurable('session-race', code, {
    slow: async () => new Promise(resolve => setTimeout(() => resolve('slow'), 25)),
    fast: async () => 'fast',
  }, { session, recordSession: 'deferred-result', callId: 'call-race' })
  appendRunCodeEvents(events, 'call-race', code, result)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let repeated = 0
  const read = await restored.runDurable('session-race', 'return recordedWinner', {
    slow: async () => { repeated++; return 'wrong' },
    fast: async () => { repeated++; return 'wrong' },
  }, { session })
  assert.equal(read.value, 'fast')
  assert.equal(repeated, 0)
})

test('repl.state saves and restores a named branch without model-visible ids', async (t) => {
  const events = []
  const session = appendOnlySession('session-a', events)
  const state = fixture()
  t.after(() => state.dispose())
  assert.deepEqual((await executeRecordedFixture(state, session, events, 'save-branch', `
let branchValue = 1
void await repl.state({ action: 'save', name: 'before-change' })
`)).raw, { logs: [] })
  assert.deepEqual((await executeRecordedFixture(state, session, events, 'restore-branch', `
branchValue = 2
void await repl.state({ action: 'restore', name: 'before-change' })
`)).raw, { logs: [] })
  assert.deepEqual((await executeRecordedFixture(state, session, events,
    'inspect-branch', 'return branchValue')).raw, { logs: [], value: 1 })
})

test('drops a tentative save when top-level global input makes the cell volatile', async (t) => {
  const events = []
  const session = appendOnlySession('late-volatile-save', events)
  const state = fixture()
  t.after(() => state.dispose())

  const result = (await executeRecordedFixture(state, session, events, 'volatile-save', `
const ambientRoot = this
void await repl.state({ action: 'save', name: 'must-not-persist' })
return ambientRoot['Math']['ran' + 'dom']()
`)).result
  assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(result.meta.dshPtcPlus.volatileReason, 'ambient globalThis')
  assert.deepEqual(result.meta.dshPtcPlus.operations, [])
  assert.deepEqual((await executeRecordedFixture(state, session, events, 'list-after-volatile-save', `
return await repl.state({ action: 'list' })
`)).raw, {
    logs: [],
    value: { names: [], mode: 'volatile', volatileReason: 'ambient globalThis' },
  })
})

test('can explicitly restore a durable state from a volatile suffix', async (t) => {
  const events = []
  const session = appendOnlySession('volatile-restore', events)
  const state = fixture()
  t.after(() => state.dispose())
  await executeRecordedFixture(state, session, events, 'save-stable', `
let restoredValue = 1
void await repl.state({ action: 'save', name: 'stable' })
`)
  await executeRecordedFixture(state, session, events, 'create-volatile-suffix', `
restoredValue = 2
void Math.random()
`)
  const restored = (await executeRecordedFixture(state, session, events, 'restore-stable', `
void await repl.state({ action: 'restore', name: 'stable' })
`)).result
  assert.equal(restored.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual((await executeRecordedFixture(state, session, events,
    'inspect-restored', 'return restoredValue')).raw, {
    logs: [],
    value: 1,
  })
})

test('restores the last durable head without a named checkpoint', async (t) => {
  const events = []
  const session = appendOnlySession('restore-durable-head', events)
  const first = fixture()
  t.after(() => first.dispose())

  const durableCode = 'let unnamedRestoreValue = 1'
  const durable = await first.runDurable(session.id, durableCode, {}, { session, recordSession: 'deferred-result', callId: 'unnamed-durable' })
  appendRunCodeEvents(events, 'unnamed-durable', durableCode, durable)

  const volatileCode = 'unnamedRestoreValue = 2; void Math.random()'
  const volatile = await first.runDurable(session.id, volatileCode, {}, { session, recordSession: 'deferred-result', callId: 'unnamed-volatile' })
  appendRunCodeEvents(events, 'unnamed-volatile', volatileCode, volatile)

  const restoreCode = 'return await repl.state({ action: "restore" })'
  const restoredHead = await first.runDurable(session.id, restoreCode, {}, { session, recordSession: 'deferred-result', callId: 'unnamed-restore' })
  assert.deepEqual(restoredHead.value, { action: 'restore', restored: true })
  assert.deepEqual(restoredHead.meta.dshPtcPlus.operations, [{ action: 'restore' }])
  appendRunCodeEvents(events, 'unnamed-restore', restoreCode, restoredHead)

  assert.deepEqual(await first.run(session.id, `
return { value: unnamedRestoreValue, state: await repl.state({ action: 'list' }) }
`), {
    logs: [],
    value: { value: 1, state: { names: [], mode: 'durable' } },
  })
  await first.dispose()

  const cold = fixture()
  t.after(() => cold.dispose())
  assert.deepEqual(await cold.run(session.id, 'return unnamedRestoreValue', {}, { session }), {
    logs: [],
    value: 1,
  })
})

test('named REPL branches survive transfer as session-log data alone', async (t) => {
  const events = []
  const session = appendOnlySession('session-branches', events)
  const first = fixture()
  const cells = [
    `let durableBranch = 1; void await repl.state({ action: 'save', name: 'one' })`,
    `durableBranch = 2; void await repl.state({ action: 'save', name: 'two' })`,
    `void await repl.state({ action: 'restore', name: 'one' })`,
  ]
  for (const [index, code] of cells.entries()) {
    const result = await first.runDurable('session-branches', code, {}, { session, recordSession: 'deferred-result', callId: `branch-${index}` })
    appendRunCodeEvents(events, `branch-${index}`, code, result)
  }
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const inspect = await restored.runDurable('session-branches', `
const listedStates = await repl.state({ action: 'list' })
return { durableBranch, names: listedStates.names }
`, {}, { session })
  assert.deepEqual(inspect.value, { durableBranch: 1, names: ['one', 'two'] })

  const switchResult = await restored.runDurable('session-branches', `
void await repl.state({ action: 'restore', name: 'two' })
`, {}, { session })
  assert.equal(switchResult.isError, false)
  assert.deepEqual(await restored.run('session-branches', 'return durableBranch'), { logs: [], value: 2 })
})

test('restores one imported binding catalog before live and cold continuation', async (t) => {
  const events = []
  const session = appendOnlySession('import-catalog-restore', events)
  const first = fixture()
  t.after(() => first.dispose())
  const imported = [
    "import { inspect } from 'node:util'",
    'const importedInspect = value => inspect(value)',
    "void await repl.state({ action: 'save', name: 'imported' })",
  ].join('\n')
  const importedResult = await executeRecordedFixture(
    first, session, events, 'catalog-import', imported,
  )
  assert.equal(importedResult.result.isError, false)

  const shadow = "const inspect = () => 'shadowed'"
  const shadowResult = await executeRecordedFixture(
    first, session, events, 'catalog-shadow', shadow,
  )
  assert.equal(shadowResult.result.isError, false)
  const shadowed = await executeRecordedFixture(first, session, events, 'catalog-shadow-read',
    'return [inspect({ a: 1 }), importedInspect({ a: 1 })]')
  assert.deepEqual(shadowed.raw, {
    logs: [], value: ['shadowed', 'shadowed'],
  })

  const restore = "void await repl.state({ action: 'restore', name: 'imported' })"
  const restoreResult = await executeRecordedFixture(
    first, session, events, 'catalog-restore', restore,
  )
  assert.equal(restoreResult.result.isError, false)
  const restoredRead = await executeRecordedFixture(first, session, events, 'catalog-restored-read',
    'return [inspect({ a: 1 }), importedInspect({ a: 1 })]')
  assert.deepEqual(restoredRead.raw, {
    logs: [], value: ['{ a: 1 }', '{ a: 1 }'],
  })
  await first.dispose()

  const cold = fixture()
  t.after(() => cold.dispose())
  const coldRead = await executeRecordedFixture(cold, session, events, 'catalog-cold-read',
    'return [inspect({ a: 1 }), importedInspect({ a: 1 })]')
  assert.deepEqual(coldRead.raw, {
    logs: [], value: ['{ a: 1 }', '{ a: 1 }'],
  })
})

test('contracts a broken replay node and continues the current request', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 5_000, maxWallMs: 20_000 })
  t.after(() => runtime.dispose())
  const events = []
  const session = appendOnlySession('replay-timeout', events)
  appendRunCodeEvents(events, 'timed-out-history', 'for (;;) {}', {
    meta: {
      dshPtcPlus: {
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: {
          kind: 'throw',
          error: { kind: 'timeout', message: 'recorded timeout' },
        },
      },
    },
  })
  const failedCallSeq = events.find(event => (
    event.type === 'tool/call' && event.data?.callId === 'timed-out-history'
  )).seq

  const { callSeq: currentCallSeq } = appendVisibleToolCall(
    events,
    'current-after-timeout',
    'run_code',
    { code: 'return 1', description: 'current' },
  )
  const execution = await runtime.runTentative(
    { id: session.id, session, callId: 'current-after-timeout' },
    { program: 'return 1', bindings: [], signal: new AbortController().signal },
  )
  runtime.finalize(execution.settlement, true)
  assert.equal(execution.result.value, 1)
  assert.match(execution.result.logs[0], /Restored the durable head and skipped 1/)
  const resultMeta = {
    dshPtcPlus: normalizeJournal(execution.settlement.journal),
    [RECOVERY_BOUNDARY_KEY]: execution.settlement.recoveryBoundaries,
  }
  events.push({
    seq: events.length,
    type: 'tool/result',
    sourceEventSeqs: [currentCallSeq],
    data: { meta: resultMeta },
  })
  assert.deepEqual(resultMeta[RECOVERY_BOUNDARY_KEY], [{ failedCallSeq, frontierCallSeq: null }])
})

test('contracts a live derived edit node by its persisted outer call sequence', async (t) => {
  const events = []
  const session = appendOnlySession('live-replay-contraction', events)
  const runtime = new SessionRuntime({ computeMs: 5_000, maxWallMs: 20_000 })
  t.after(() => runtime.dispose())

  const executeConfirmed = async (callId, program, options = {}) => {
    const name = options.name ?? 'run_code'
    const argumentsValue = JSON.stringify(name === 'run_code'
      ? { code: program, description: 'test cell' }
      : { edits: [{ old_string: options.targetSource, new_string: program }] })
    session.append('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name, arguments: argumentsValue }],
      },
    })
    const call = session.append('tool/call', {
      turn: 0,
      step: 0,
      callId,
      name,
      arguments: argumentsValue,
    })
    const context = {
      id: session.id,
      session,
      callId: name === 'run_code' ? callId : `${callId}:derived`,
      ...(name === 'edit_run_code' ? { persistedCallSeq: call.seq } : {}),
    }
    const execution = await runtime.runTentative(context, {
      program,
      bindings: [],
      signal: new AbortController().signal,
    })
    runtime.finalize(execution.settlement, true)
    const result = execution.result
    events.push(Object.freeze({
      type: 'tool/result',
      seq: events.length,
      time: events.length,
      sourceEventSeqs: [call.seq],
      data: {
        message: { source: { kind: 'tool', callId } },
        meta: {
          dshPtcPlus: normalizeJournal(execution.settlement.journal),
          ...(execution.settlement.recoveryBoundaries === undefined ? {} : {
            [RECOVERY_BOUNDARY_KEY]: execution.settlement.recoveryBoundaries,
          }),
          ...(name === 'edit_run_code' ? {
            dshPtcPlusEdit: { targetCallSeq: options.targetCallSeq },
            dshPtcPlusDerivedRun: { code: program, description: 'derived edit' },
          } : {}),
        },
      },
    }))
    return { call, context, result, kernel: sessionKernel(runtime, session.id) }
  }

  const parent = await executeConfirmed('live-parent', 'const stableHead = 3')
  assert.equal(parent.result.error, undefined)
  const child = await executeConfirmed(
    'live-child',
    'const failedHead = stableHead + 4; return failedHead',
    {
      name: 'edit_run_code',
      targetCallSeq: parent.call.seq,
      targetSource: 'const stableHead = 3',
    },
  )
  assert.equal(child.result.value, 7)
  assert.deepEqual(
    child.kernel.history.nodes.map(node => node.callSeq),
    [parent.call.seq, child.call.seq],
  )

  const childNode = child.kernel.history.nodes[1]
  child.kernel.history.nodes[1] = Object.freeze({
    ...childNode,
    journal: normalizeJournal({
      ...childNode.journal,
      completion: { kind: 'return', hasValue: true, value: encodeValue(999) },
    }),
  })
  await restartWorker(runtime, session.id)

  const fresh = await executeConfirmed(
    'live-fresh',
    `const freshHead = stableHead + 10
return { stableHead, failedType: typeof failedHead, freshHead }`,
  )
  assert.deepEqual(fresh.result.value, {
    stableHead: 3,
    failedType: 'undefined',
    freshHead: 13,
  })
  const boundary = events.find(event => event.data?.meta?.[RECOVERY_BOUNDARY_KEY] !== undefined)
  assert.deepEqual(boundary?.data.meta[RECOVERY_BOUNDARY_KEY], [{
    failedCallSeq: child.call.seq,
    frontierCallSeq: parent.call.seq,
  }])
  assert.equal(boundary.seq, fresh.call.seq + 1)

  const restarted = new SessionRuntime({ computeMs: 5_000, maxWallMs: 20_000 })
  t.after(() => restarted.dispose())
  const inspectArguments = JSON.stringify({
    code: 'return [stableHead, typeof failedHead, freshHead]',
    description: 'test cell',
  })
  session.append('assistant/message', {
    turn: 0,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'live-inspect', name: 'run_code', arguments: inspectArguments }],
    },
  })
  const inspectCall = session.append('tool/call', {
    turn: 0,
    step: 1,
    callId: 'live-inspect',
    name: 'run_code',
    arguments: inspectArguments,
  })
  const inspected = await restarted.run(
    { id: session.id, session, callId: inspectCall.data.callId },
    {
      program: 'return [stableHead, typeof failedHead, freshHead]',
      bindings: [],
      signal: new AbortController().signal,
    },
  )
  assert.deepEqual(inspected, { logs: [], value: [3, 'undefined', 13] })
})

test('rejects an ambiguous live run_code event identity before execution', async (t) => {
  const events = []
  const session = appendOnlySession('ambiguous-live-call', events)
  session.append('tool/call', {
    callId: 'duplicate-call',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'return 1', description: 'first' }),
  })
  session.append('tool/call', {
    callId: 'duplicate-call',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'return 2', description: 'second' }),
  })
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())

  const result = await runtime.run(
    { id: session.id, session, callId: 'duplicate-call' },
    {
      program: 'return 2',
      bindings: [],
      signal: new AbortController().signal,
    },
  )
  assert.equal(result.error.kind, 'recovery')
  assert.match(result.error.message, /multiple unpaired run_code calls/)
})

test('rejects an invalid explicit persisted call sequence before execution', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const result = await runtime.run({
    id: 'invalid-explicit-call-seq',
    session: { events: [] },
    callId: 'derived',
    persistedCallSeq: -1,
  }, {
    program: 'return 1',
    bindings: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.error.kind, 'recovery')
  assert.match(result.error.message, /persisted tool call sequence must be a non-negative safe integer/)
})

test('contracts a legacy recovery boundary while executing the current cell', async (t) => {
  const callId = 'current-after-malformed-boundary'
  const session = {
    id: 'malformed-recovery-boundary',
    events: [
      {
        type: 'ptc-plus/recovery-boundary',
        data: { failedCallSeq: 1, frontierCallSeq: null },
      },
      {
        seq: 2,
        type: 'tool/call',
        data: {
          callId,
          name: 'run_code',
          arguments: JSON.stringify({ code: 'globalThis.__malformed_boundary_ran__ = true', description: 'current' }),
        },
      },
    ],
  }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const result = await runtime.run(
    { id: session.id, session, callId },
    {
      program: 'globalThis.__malformed_boundary_ran__ = true',
      bindings: [],
      signal: new AbortController().signal,
    },
  )
  assert.equal(result.error, undefined)
  assert.equal(result.value, true)
  assert.equal(hasSessionKernel(runtime, session.id), true)
})

test('continues the current cell after an unprovable historical result', async (t) => {
  const session = {
    id: 'unprovable-history-current-cell',
    events: [
      {
        seq: 0,
        type: 'tool/call',
        data: {
          callId: 'historical',
          name: 'run_code',
          arguments: JSON.stringify({ code: 'const lost = 1', description: 'historical' }),
        },
      },
      {
        seq: 1,
        type: 'tool/result',
        sourceEventSeqs: [0],
        surfaceOp: 'append',
        data: { message: { source: { callId: 'historical' } } },
      },
      {
        seq: 2,
        type: 'tool/call',
        data: {
          callId: 'current',
          name: 'run_code',
          arguments: JSON.stringify({ code: 'return 42', description: 'current' }),
        },
      },
    ],
  }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const execution = await runtime.run(
    { id: session.id, session, callId: 'current' },
    {
      program: 'return 42',
      bindings: [],
      signal: new AbortController().signal,
    },
  )
  assert.equal(execution.value, 42)
  assert.equal(execution.error, undefined)
})

test('runs the current cell from an empty frontier when the session surface is unavailable or malformed', async (t) => {
  for (const [label, installSurface] of [
    ['unavailable', (session) => Object.defineProperty(session, 'surface', {
      get() { throw new Error('surface unavailable') },
    })],
    ['raw tool call', (session, historical) => {
      session.surface = { nodes: [historical.callSeq] }
    }],
    ['duplicate result', (session, historical) => {
      session.surface = { nodes: [historical.resultSeq, historical.resultSeq] }
    }],
  ]) await t.test(label, async t => {
    const events = []
    appendRunCodeEvents(events, 'surface-hidden', 'const surfaceHidden = 9', {
      meta: { dshPtcPlus: normalizeJournal({
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: { kind: 'return', hasValue: false },
      }) },
    })
    const historical = {
      callSeq: events.find(event => (
        event.type === 'tool/call' && event.data?.callId === 'surface-hidden'
      )).seq,
      resultSeq: events.find(event => (
        event.type === 'tool/result' && event.data?.message?.source?.callId === 'surface-hidden'
      )).seq,
    }
    appendVisibleToolCall(events, 'surface-call', 'run_code', {
      code: 'return typeof surfaceHidden',
      description: 'current',
    })
    const session = { id: `surface-${label}`, events }
    installSurface(session, historical)
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    const execution = await runtime.run(
      { id: session.id, session, callId: 'surface-call' },
      { program: 'return typeof surfaceHidden', bindings: [], signal: new AbortController().signal },
    )
    assert.equal(execution.value, 'undefined')
    assert.match(execution.logs[0], /Restored the durable head and skipped 1 unreconstructable historical cell/u)
  })
})

test('contracts explicit malformed result provenance before running the current cell', async (t) => {
  for (const [label, sourceEventSeqs] of [
    ['negative-zero', [-0]],
    ['negative', [-1]],
    ['non-number', ['1']],
    ['empty', []],
  ]) await t.test(label, async t => {
    const events = []
    const historical = appendRunCodeEvents(events, 'malformed-source', 'const malformedSource = 9', {
      meta: { dshPtcPlus: normalizeJournal({
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: { kind: 'return', hasValue: false },
      }) },
    })
    events[historical.resultSeq].sourceEventSeqs = sourceEventSeqs
    appendVisibleToolCall(events, `malformed-current-${label}`, 'run_code', {
      code: 'return typeof malformedSource',
      description: 'current',
    })
    const session = appendOnlySession(`malformed-source-${label}`, events)
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    const execution = await runtime.run(
      { id: session.id, session, callId: `malformed-current-${label}` },
      { program: 'return typeof malformedSource', bindings: [], signal: new AbortController().signal },
    )
    assert.equal(execution.value, 'undefined')
    assert.equal(execution.error, undefined)
    assert.match(execution.logs[0], /Restored the durable head and skipped 1 unreconstructable historical cell/u)
  })
})

test('runs a reused provider call ID after a malformed historical settlement', async (t) => {
  const events = []
  const historical = appendRunCodeEvents(events, 'reused-malformed', 'const damagedBinding = 9', {
    meta: { dshPtcPlus: normalizeJournal({
      version: 3,
      bindingMode: 'loose',
      rewritePolicy: JOURNAL_POLICY,
      status: 'durable',
      calls: [],
      operations: [],
      confirms: [],
      diagnostics: [],
      completion: { kind: 'return', hasValue: false },
    }) },
  })
  events[historical.resultSeq].sourceEventSeqs = [-0]
  delete events[historical.resultSeq].data.message
  appendVisibleToolCall(events, 'reused-malformed', 'run_code', {
    code: 'return 42',
    description: 'current',
  })
  const session = appendOnlySession('reused-malformed-settlement', events)
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const execution = await runtime.run(
    { id: session.id, session, callId: 'reused-malformed' },
    { program: 'return 42', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(execution.value, 42)
  assert.equal(execution.error, undefined)
  assert.equal(execution.logs.filter(log => log.includes('PTC-R002')).length, 1)
})

test('does not authorize hidden source from a mismatched visible assistant call', async (t) => {
  const hiddenArguments = JSON.stringify({ code: 'const mismatchedVisibleSource = 9', description: 'hidden' })
  const events = [
    {
      seq: 0,
      type: 'assistant/message',
      data: { message: { content: [{
        type: 'tool-call', id: 'mismatched-visible', name: 'read',
        arguments: JSON.stringify({ path: 'public.txt' }),
      }] } },
    },
    {
      seq: 1,
      type: 'tool/call',
      data: { callId: 'mismatched-visible', name: 'run_code', arguments: hiddenArguments },
    },
    {
      seq: 2,
      type: 'tool/result',
      sourceEventSeqs: [1],
      data: { meta: { dshPtcPlus: normalizeJournal({
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: { kind: 'return', hasValue: false },
      }) } },
    },
    {
      seq: 3,
      type: 'tool/call',
      data: {
        callId: 'mismatched-current',
        name: 'run_code',
        arguments: JSON.stringify({
          code: 'return typeof mismatchedVisibleSource',
          description: 'current',
        }),
      },
    },
  ]
  const session = {
    id: 'mismatched-visible-assistant-call',
    events,
    surface: { nodes: [0, 2], replaceGeneration: 0 },
  }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const execution = await runtime.run(
    { id: session.id, session, callId: 'mismatched-current' },
    { program: 'return typeof mismatchedVisibleSource', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(execution.value, 'undefined')
  assert.match(execution.logs[0], /Restored the durable head and skipped 1 unreconstructable historical cell/u)
})

test('rebuilds history when the model-visible surface generation changes', async (t) => {
  let generation = 0
  let surfaceNodes = []
  const events = []
  appendRunCodeEvents(events, 'surface-stable', 'const surfaceStable = 1', {
    meta: { dshPtcPlus: normalizeJournal({
      version: 3,
      bindingMode: 'loose',
      rewritePolicy: JOURNAL_POLICY,
      status: 'durable',
      calls: [],
      operations: [],
      confirms: [],
      diagnostics: [],
      completion: { kind: 'return', hasValue: false },
    }) },
  })
  appendRunCodeEvents(events, 'surface-hidden', 'const surfaceHidden = 2', {
    meta: { dshPtcPlus: normalizeJournal({
      version: 3,
      bindingMode: 'loose',
      rewritePolicy: JOURNAL_POLICY,
      status: 'durable',
      calls: [],
      operations: [],
      confirms: [],
      diagnostics: [],
      completion: { kind: 'return', hasValue: false },
    }) },
  })
  const visibleHistory = callId => ({
    assistantSeq: events.find(event => (
      event.type === 'assistant/message'
      && event.data?.message?.content?.some(block => block.id === callId)
    )).seq,
    resultSeq: events.find(event => (
      event.type === 'tool/result' && event.data?.message?.source?.callId === callId
    )).seq,
  })
  const stableHistory = visibleHistory('surface-stable')
  const hiddenHistory = visibleHistory('surface-hidden')
  const session = {
    id: 'surface-generation-change',
    events,
    surface: {
      get replaceGeneration() { return generation },
      get nodes() { return surfaceNodes },
    },
  }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const beforeReplacement = appendVisibleToolCall(events, 'surface-before-replacement', 'run_code', {
    code: 'return [surfaceStable, surfaceHidden]',
    description: 'before replacement',
  })
  surfaceNodes = [
    stableHistory.assistantSeq,
    stableHistory.resultSeq,
    hiddenHistory.assistantSeq,
    hiddenHistory.resultSeq,
    beforeReplacement.assistantSeq,
  ]
  const first = await runtime.run(
    { id: session.id, session, callId: 'surface-before-replacement' },
    { program: 'return [surfaceStable, surfaceHidden]', bindings: [], signal: new AbortController().signal },
  )
  assert.deepEqual(first.value, [1, 2])
  const firstWorker = workerOf(runtime, session.id)
  generation = 1
  const afterReplacement = appendVisibleToolCall(events, 'surface-after-replacement', 'run_code', {
    code: 'return [surfaceStable, typeof surfaceHidden]',
    description: 'after replacement',
  })
  surfaceNodes = [
    stableHistory.assistantSeq,
    stableHistory.resultSeq,
    afterReplacement.assistantSeq,
  ]
  const second = await runtime.run(
    { id: session.id, session, callId: 'surface-after-replacement' },
    { program: 'return [surfaceStable, typeof surfaceHidden]', bindings: [], signal: new AbortController().signal },
  )
  assert.deepEqual(second.value, [1, 'undefined'])
  assert.match(second.logs[0], /Restored the durable head and skipped/)
  assert.notEqual(workerOf(runtime, session.id), firstWorker)

  let disabledGeneration = 0
  const disabledEvents = []
  const disabledFirst = appendVisibleToolCall(disabledEvents, 'surface-disabled-first', 'run_code', {
    code: 'const disabledHidden = 1',
    description: 'declare hidden binding',
  })
  let disabledNodes = [disabledFirst.assistantSeq]
  const disabledSession = {
    id: 'surface-generation-disabled-replay',
    events: disabledEvents,
    surface: {
      get replaceGeneration() { return disabledGeneration },
      get nodes() { return disabledNodes },
    },
  }
  const disabledRuntime = new SessionRuntime({ durableReplay: false })
  t.after(() => disabledRuntime.dispose())
  assert.equal((await disabledRuntime.run(
    { id: disabledSession.id, session: disabledSession, callId: 'surface-disabled-first' },
    { program: 'const disabledHidden = 1', bindings: [], signal: new AbortController().signal },
  )).error, undefined)
  const disabledWorker = workerOf(disabledRuntime, disabledSession.id)
  disabledGeneration = 1
  const disabledSecond = appendVisibleToolCall(disabledEvents, 'surface-disabled-second', 'run_code', {
    code: 'return typeof disabledHidden',
    description: 'inspect hidden binding',
  })
  disabledNodes = [disabledFirst.assistantSeq, disabledSecond.assistantSeq]
  const disabledVisibleResult = await disabledRuntime.run(
    { id: disabledSession.id, session: disabledSession, callId: 'surface-disabled-second' },
    { program: 'return typeof disabledHidden', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(disabledVisibleResult.value, 'number')
  assert.deepEqual(disabledVisibleResult.logs, [])
  assert.equal(workerOf(disabledRuntime, disabledSession.id), disabledWorker)
  disabledGeneration = 2
  const disabledThird = appendVisibleToolCall(disabledEvents, 'surface-disabled-third', 'run_code', {
    code: 'return typeof disabledHidden',
    description: 'inspect hidden binding',
  })
  disabledNodes = [disabledThird.assistantSeq]
  const disabledHiddenResult = await disabledRuntime.run(
    { id: disabledSession.id, session: disabledSession, callId: 'surface-disabled-third' },
    { program: 'return typeof disabledHidden', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(disabledHiddenResult.value, 'undefined')
  assert.notEqual(workerOf(disabledRuntime, disabledSession.id), disabledWorker)

  let volatileGeneration = 0
  let volatileNodes = []
  const volatileEvents = []
  const volatileSession = {
    id: 'surface-generation-volatile',
    events: volatileEvents,
    surface: {
      get replaceGeneration() { return volatileGeneration },
      get nodes() { return volatileNodes },
    },
  }
  const volatileRuntime = new SessionRuntime()
  t.after(() => volatileRuntime.dispose())
  const executeVolatile = async (callId, program) => {
    const call = appendVisibleToolCall(volatileEvents, callId, 'run_code', {
      code: program,
      description: 'volatile surface cell',
    })
    volatileNodes = [...volatileNodes, call.assistantSeq]
    const execution = await volatileRuntime.runTentative(
      { id: volatileSession.id, session: volatileSession, callId },
      { program, bindings: [], signal: new AbortController().signal },
    )
    volatileRuntime.finalize(execution.settlement, true)
    return execution
  }
  const volatileFirst = await executeVolatile('surface-volatile-first', 'const surfaceVolatile = Date.now()')
  assert.equal(volatileFirst.settlement.journal.status, 'volatile')
  const volatileWorker = workerOf(volatileRuntime, volatileSession.id)
  volatileGeneration = 1
  const volatileVisible = await executeVolatile('surface-volatile-second', 'return typeof surfaceVolatile')
  assert.equal(volatileVisible.result.value, 'number')
  assert.deepEqual(volatileVisible.result.logs, [])
  assert.equal(workerOf(volatileRuntime, volatileSession.id), volatileWorker)
})

test('contracts live state when surface-generation evidence becomes or remains unavailable', async (t) => {
  for (const initiallyReadable of [true, false]) await t.test(
    initiallyReadable ? 'capability loss' : 'persistently unavailable',
    async (t) => {
      let readable = initiallyReadable
      let surfaceNodes = []
      const events = []
      const session = {
        id: `surface-generation-unavailable-${initiallyReadable}`,
        events,
        surface: {
          get replaceGeneration() {
            if (!readable) throw new Error('surface generation unavailable')
            return 0
          },
          get nodes() { return surfaceNodes },
        },
      }
      const first = appendVisibleToolCall(events, 'generation-first', 'run_code', {
        code: 'const generationHidden = 1',
        description: 'declare live binding',
      })
      surfaceNodes = [first.assistantSeq]
      const runtime = new SessionRuntime({ durableReplay: false })
      t.after(() => runtime.dispose())
      const declared = await runtime.run(
        { id: session.id, session, callId: 'generation-first' },
        { program: 'const generationHidden = 1', bindings: [], signal: new AbortController().signal },
      )
      assert.equal(declared.error, undefined)
      const firstWorker = workerOf(runtime, session.id)

      readable = false
      const second = appendVisibleToolCall(events, 'generation-second', 'run_code', {
        code: 'return typeof generationHidden',
        description: 'inspect contracted binding',
      })
      surfaceNodes = [second.assistantSeq]
      const inspected = await runtime.run(
        { id: session.id, session, callId: 'generation-second' },
        { program: 'return typeof generationHidden', bindings: [], signal: new AbortController().signal },
      )
      assert.equal(inspected.value, 'undefined')
      assert.match(inspected.logs[0], /Restored the durable head and skipped/u)
      assert.notEqual(workerOf(runtime, session.id), firstWorker)
    },
  )
})

test('revalidates live provenance when the readable surface generation is unchanged', async (t) => {
  for (const mode of ['visible', 'empty', 'malformed']) await t.test(mode, async (t) => {
    const events = []
    let surfaceNodes = []
    const session = {
      id: `surface-generation-unchanged-${mode}`,
      events,
      surface: {
        replaceGeneration: 0,
        get nodes() { return surfaceNodes },
      },
    }
    const runtime = new SessionRuntime({ durableReplay: false })
    t.after(() => runtime.dispose())
    const first = appendVisibleToolCall(events, `unchanged-first-${mode}`, 'run_code', {
      code: 'const unchangedLive = 1',
      description: 'declare live binding',
    })
    surfaceNodes = [first.assistantSeq]
    const declared = await runtime.runTentative(
      { id: session.id, session, callId: `unchanged-first-${mode}` },
      { program: 'const unchangedLive = 1', bindings: [], signal: new AbortController().signal },
    )
    assert.equal(declared.result.error, undefined)
    runtime.finalize(declared.settlement, true)
    const firstResultSeq = appendToolResult(events, `unchanged-first-${mode}`, first.callSeq, {
      meta: { dshPtcPlus: normalizeJournal(declared.settlement.journal) },
    })
    const firstWorker = workerOf(runtime, session.id)
    if (mode === 'malformed') {
      events[first.assistantSeq].data.message.content[0].arguments = JSON.stringify({
        code: 'const differentSource = 1',
        description: 'declare live binding',
      })
    }
    const second = appendVisibleToolCall(events, `unchanged-second-${mode}`, 'run_code', {
      code: 'return typeof unchangedLive',
      description: 'inspect live binding',
    })
    surfaceNodes = mode === 'empty'
      ? [second.assistantSeq]
      : [first.assistantSeq, firstResultSeq, second.assistantSeq]
    const inspected = await runtime.run(
      { id: session.id, session, callId: `unchanged-second-${mode}` },
      { program: 'return typeof unchangedLive', bindings: [], signal: new AbortController().signal },
    )
    assert.equal(inspected.value, mode === 'visible' ? 'number' : 'undefined')
    if (mode === 'visible') {
      assert.deepEqual(inspected.logs, [])
      assert.equal(workerOf(runtime, session.id), firstWorker)
    } else {
      assert.match(inspected.logs[0], /Restored the durable head and skipped/u)
      assert.notEqual(workerOf(runtime, session.id), firstWorker)
    }
  })
})

test('contracts to an empty frontier when ordered events fail during live recovery', async (t) => {
  const events = []
  let surfaceNodes = []
  const session = {
    id: 'surface-events-fail-during-recovery',
    events,
    surface: {
      replaceGeneration: 0,
      get nodes() { return surfaceNodes },
    },
  }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const first = appendVisibleToolCall(events, 'events-fail-first', 'run_code', {
    code: 'const eventsFailBinding = 1',
    description: 'declare live binding',
  })
  surfaceNodes = [first.assistantSeq]
  const declared = await runtime.runTentative(
    { id: session.id, session, callId: 'events-fail-first' },
    { program: 'const eventsFailBinding = 1', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(declared.result.error, undefined)
  runtime.finalize(declared.settlement, true)
  appendToolResult(events, 'events-fail-first', first.callSeq, {
    meta: { dshPtcPlus: normalizeJournal(declared.settlement.journal) },
  })

  const second = appendVisibleToolCall(events, 'events-fail-second', 'run_code', {
    code: 'return typeof eventsFailBinding',
    description: 'inspect contracted binding',
  })
  surfaceNodes = [second.assistantSeq]
  let reads = 0
  session.snapshotEvents = () => {
    reads += 1
    if (reads <= 2) return events
    throw new Error('ordered events became unavailable')
  }
  const inspected = await runtime.run(
    { id: session.id, session, callId: 'events-fail-second' },
    { program: 'return typeof eventsFailBinding', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(inspected.value, 'undefined')
  assert.match(inspected.logs[0], /Restored the durable head and skipped/u)
  assert.equal(reads, 3)
})

test('counts every historical cell excluded after an unavailable journal boundary', async (t) => {
  const stable = normalizeJournal({
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: JOURNAL_POLICY,
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: { kind: 'return', hasValue: false },
  })
  const malformed = { ...stable, unexpected: true }
  const events = []
  appendRunCodeEvents(events, 'count-stable', 'const countStable = 1', {
    meta: { dshPtcPlus: stable },
  })
  appendRunCodeEvents(events, 'count-malformed', 'const countMalformed = 2', {
    meta: { dshPtcPlus: malformed },
  })
  appendRunCodeEvents(events, 'count-dependent-one', 'const countDependentOne = 3', {
    meta: { dshPtcPlus: stable },
  })
  appendRunCodeEvents(events, 'count-dependent-two', 'const countDependentTwo = 4', {
    meta: { dshPtcPlus: stable },
  })
  appendVisibleToolCall(events, 'count-current', 'run_code', {
    code: 'return countStable',
    description: 'inspect recovered prefix',
  })
  const session = appendOnlySession('count-unavailable-suffix', events)
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const current = await runtime.run(
    { id: session.id, session, callId: 'count-current' },
    { program: 'return countStable', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(current.value, 1)
  assert.match(current.logs[0], /Restored the durable head and skipped 3 unreconstructable historical cell\(s\)/)
})

test('keeps disabled derived edit provenance through visible surface replacement', async (t) => {
  let generation = 0
  const events = []
  const sourceCall = appendVisibleToolCall(events, 'disabled-edit-source', 'run_code', {
    code: 'let editableSurface = 1',
    description: 'editable source',
  })
  let surfaceNodes = [sourceCall.assistantSeq]
  const session = {
    id: 'disabled-derived-edit-surface',
    events,
    surface: {
      get replaceGeneration() { return generation },
      get nodes() { return surfaceNodes },
    },
  }
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const first = await runtime.run(
    { id: session.id, session, callId: 'disabled-edit-source' },
    { program: 'let editableSurface = 1', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(first.error, undefined)
  const firstWorker = workerOf(runtime, session.id)

  const editCall = appendVisibleToolCall(events, 'disabled-edit-call', 'edit_run_code', {
    edits: [{ old_string: '1', new_string: '2' }],
  })
  surfaceNodes = [sourceCall.assistantSeq, editCall.assistantSeq]
  const edited = await runtime.run(
    {
      id: session.id,
      session,
      callId: 'disabled-edit-call:derived',
      persistedCallSeq: editCall.callSeq,
    },
    { program: 'editableSurface = 2', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(edited.error, undefined)
  assert.equal(workerOf(runtime, session.id), firstWorker)

  generation = 1
  const inspectCall = appendVisibleToolCall(events, 'disabled-edit-inspect', 'run_code', {
    code: 'return editableSurface',
    description: 'inspect edited source',
  })
  surfaceNodes = [sourceCall.assistantSeq, editCall.assistantSeq, inspectCall.assistantSeq]
  const visible = await runtime.run(
    { id: session.id, session, callId: 'disabled-edit-inspect' },
    { program: 'return editableSurface', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(visible.value, 2)
  assert.deepEqual(visible.logs, [])
  assert.equal(workerOf(runtime, session.id), firstWorker)

  generation = 2
  const hiddenCall = appendVisibleToolCall(events, 'disabled-edit-after-hide', 'run_code', {
    code: 'return typeof editableSurface',
    description: 'inspect hidden edit',
  })
  surfaceNodes = [inspectCall.assistantSeq, hiddenCall.assistantSeq]
  const hidden = await runtime.run(
    { id: session.id, session, callId: 'disabled-edit-after-hide' },
    { program: 'return typeof editableSurface', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(hidden.value, 'undefined')
  assert.match(hidden.logs[0], /Restored the durable head and skipped/)
  assert.notEqual(workerOf(runtime, session.id), firstWorker)
})

test('attaches post-recovery cells to the verified frontier across restarts', async (t) => {
  const events = []
  const session = appendOnlySession('replay-detach', events)
  appendRunCodeEvents(events, 'stable-head', 'const stableHead = 3', {
    meta: {
      dshPtcPlus: normalizeJournal({
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: { kind: 'return', hasValue: false },
      }),
    },
  })
  appendRunCodeEvents(events, 'timed-out-history', 'for (;;) {}', {
    meta: {
      dshPtcPlus: {
        version: 3,
        bindingMode: 'loose',
        rewritePolicy: JOURNAL_POLICY,
        status: 'durable',
        calls: [],
        operations: [],
        confirms: [],
        diagnostics: [],
        completion: { kind: 'throw', error: { kind: 'timeout', message: 'recorded timeout' } },
      },
    },
  })
  const timedOutResult = events.find(event => (
    event.type === 'tool/result'
    && event.data?.message?.source?.callId === 'timed-out-history'
  ))
  timedOutResult.data.meta.dshPtcPlus = normalizeJournal(timedOutResult.data.meta.dshPtcPlus)

  const recovering = fixture()
  t.after(() => recovering.dispose())
  const confirmed = await executeRecordedFixture(
    recovering,
    session,
    events,
    'fresh-head',
    'const freshHead = stableHead + 4',
    {},
  )
  assert.equal(confirmed.raw.error, undefined)

  const restarted = fixture()
  t.after(() => restarted.dispose())
  assert.deepEqual((await executeRecordedFixture(
    restarted,
    session,
    events,
    'inspect-fresh-head',
    'return [stableHead, freshHead]',
  )).raw, {
    logs: [],
    value: [3, 7],
  })
})

test('requires exact recovery boundaries before confirming a contracted cell', async (t) => {
  const mutations = [
    meta => {
      const changed = { ...meta }
      delete changed[RECOVERY_BOUNDARY_KEY]
      return changed
    },
    meta => ({
      ...meta,
      [RECOVERY_BOUNDARY_KEY]: [{ failedCallSeq: 99, frontierCallSeq: null }],
    }),
    meta => ({ ...meta, [RECOVERY_BOUNDARY_KEY]: 'invalid' }),
  ]
  for (const [index, mutate] of mutations.entries()) {
    const events = []
    const session = appendOnlySession(`boundary-confirmation-${index}`, events)
    appendRunCodeEvents(events, `broken-${index}`, 'for (;;) {}', {
      meta: {
        dshPtcPlus: normalizeJournal({
          version: 3,
          bindingMode: 'loose',
          rewritePolicy: JOURNAL_POLICY,
          status: 'durable',
          calls: [],
          operations: [],
          confirms: [],
          diagnostics: [],
          completion: { kind: 'throw', error: { kind: 'timeout', message: 'recorded timeout' } },
        }),
      },
    })
    const state = fixture()
    t.after(() => state.dispose())
    const contracted = await executeRecordedFixture(
      state,
      session,
      events,
      `contracted-${index}`,
      `const boundaryValue${index} = ${index + 1}`,
      {},
      { finalizeResult: result => ({ ...result, meta: mutate(result.meta) }) },
    )
    assert.equal(contracted.raw.error, undefined)
    const dependent = (await executeRecordedFixture(
      state,
      session,
      events,
      `dependent-${index}`,
      `return boundaryValue${index}`,
    )).result
    assert.equal(dependent.meta.dshPtcPlus.status, 'volatile')
  }

  const state = fixture()
  t.after(() => state.dispose())
  const unexpectedEvents = []
  const unexpectedSession = appendOnlySession('unexpected-boundary', unexpectedEvents)
  await executeRecordedFixture(state, unexpectedSession, unexpectedEvents,
    'unexpected-first', 'const unexpectedBoundary = 1', {}, {
    finalizeResult: result => ({
      ...result,
      meta: {
        ...result.meta,
        [RECOVERY_BOUNDARY_KEY]: [{ failedCallSeq: 1, frontierCallSeq: null }],
      },
    }),
  })
  const dependent = (await executeRecordedFixture(state, unexpectedSession, unexpectedEvents,
    'unexpected-second', 'return unexpectedBoundary')).result
  assert.equal(dependent.meta.dshPtcPlus.status, 'volatile')
})
