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
import { JOURNAL_POLICY, appendOnlySession, appendRunCodeEvents, fixture } from './plugin-fixture.js'

test('rejects replaced, corrupt, or extended persisted journals during confirmation', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const replaced = await state.runDurable('replaced-journal', 'const replacedJournalValue = 1', {}, {
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
  })
  assert.equal(replaced.meta.dshPtcPlus.status, 'noop')
  const afterReplacement = await state.runDurable('replaced-journal', 'return replacedJournalValue')
  assert.equal(afterReplacement.value, 1)
  assert.equal(afterReplacement.meta.dshPtcPlus.status, 'volatile')

  const corrupt = await state.runDurable('corrupt-journal', 'const corruptJournalValue = 2', {}, {
    finalizeResult(result) {
      return { ...result, meta: { ...result.meta, dshPtcPlus: { version: 2 } } }
    },
  })
    assert.deepEqual(corrupt.meta.dshPtcPlus, { version: 2 })
  const afterCorruption = await state.runDurable('corrupt-journal', 'return corruptJournalValue')
  assert.equal(afterCorruption.value, 2)
  assert.equal(afterCorruption.meta.dshPtcPlus.status, 'volatile')

  const extended = await state.runDurable('extended-journal', 'const extendedJournalValue = 3', {}, {
    finalizeResult(result) {
      return {
        ...result,
        meta: {
          ...result.meta,
          dshPtcPlus: { ...result.meta.dshPtcPlus, injected: true },
        },
      }
    },
  })
  assert.equal(extended.meta.dshPtcPlus.injected, true)
  const afterExtension = await state.runDurable('extended-journal', 'return extendedJournalValue')
  assert.equal(afterExtension.value, 3)
  assert.equal(afterExtension.meta.dshPtcPlus.status, 'volatile')

  const extendedDiagnostic = await state.runDurable(
    'extended-diagnostic',
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
  )
  assert.equal(extendedDiagnostic.meta.dshPtcPlus.diagnostics[0].injected, true)
  const afterDiagnosticExtension = await state.runDurable('extended-diagnostic', 'return diagnosticJournalValue')
  assert.equal(afterDiagnosticExtension.value, 4)
  assert.equal(afterDiagnosticExtension.meta.dshPtcPlus.status, 'volatile')
})
test('confirms pre-dispatch no-ops in the next durable journal', async (t) => {
  const events = []
  const session = { id: 'session-confirm-noop', events }
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
  const rejected = await first.rejectBeforeRuntime(session.id, {
    callId: 'pre-denied-call',
    session,
  })
  events.push({ seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { meta: rejected.meta } })

  const durableCode = 'const acceptedBinding = 2'
  const durable = await first.runDurable(session.id, durableCode, {}, { session })
  assert.deepEqual(durable.meta.dshPtcPlus.confirms, [0])
  appendRunCodeEvents(events, 'accepted-call', durableCode, durable)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, `
return { rejected: typeof rejectedBinding, acceptedBinding }
`, {}, { session })
  assert.deepEqual(result.value, { rejected: 'undefined', acceptedBinding: 2 })
  assert.deepEqual(result.logs, [])
})

test('reconstructs the live REPL from only session-log journal metadata', async (t) => {
  const events = []
  const first = fixture()
  const session = { id: 'session-a', events }
  t.after(() => first.dispose())

  let originalCalls = 0
  const firstCode = 'const persistedValue = await tools.readValue({})'
  const firstResult = await first.runDurable('session-a', firstCode, {
    readValue: async () => { originalCalls++; return 40 },
  }, { session })
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
  const session = { id: 'import-private-replay', events }
  const first = fixture()
  t.after(() => first.dispose())

  const userCode = 'const __dsh_ptc_import_namespace_0__ = 99'
  const userResult = await first.runDurable(session.id, userCode, {}, { session })
  appendRunCodeEvents(events, 'private-user-binding', userCode, userResult)

  const importCode = "import { inspect } from 'node:util'; const inspectType = typeof inspect"
  const importResult = await first.runDurable(session.id, importCode, {}, { session })
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
  const session = { id: 'session-race', events }
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
  }, { session })
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
  const state = fixture()
  t.after(() => state.dispose())
  assert.deepEqual(await state.run('session-a', `
let branchValue = 1
void await repl.state({ action: 'save', name: 'before-change' })
`), { logs: [] })
  assert.deepEqual(await state.run('session-a', `
branchValue = 2
void await repl.state({ action: 'restore', name: 'before-change' })
`), { logs: [] })
  assert.deepEqual(await state.run('session-a', 'return branchValue'), { logs: [], value: 1 })
})

test('drops a tentative save when the cell becomes volatile at runtime', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.runDurable('late-volatile-save', `
void await repl.state({ action: 'save', name: 'must-not-persist' })
return Math['ran' + 'dom']()
`)
  assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(result.meta.dshPtcPlus.operations, [])
  assert.deepEqual(await state.run('late-volatile-save', `
return await repl.state({ action: 'list' })
`), {
    logs: [],
    value: { names: [], mode: 'volatile', volatileReason: 'Math.random' },
  })
})

test('can explicitly restore a durable state from a volatile suffix', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('volatile-restore', `
let restoredValue = 1
void await repl.state({ action: 'save', name: 'stable' })
`)
  await state.run('volatile-restore', `
restoredValue = 2
void Math.random()
`)
  const restored = await state.runDurable('volatile-restore', `
void await repl.state({ action: 'restore', name: 'stable' })
`)
  assert.equal(restored.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(await state.run('volatile-restore', 'return restoredValue'), {
    logs: [],
    value: 1,
  })
})

test('restores the last durable head without a named checkpoint', async (t) => {
  const events = []
  const session = { id: 'restore-durable-head', events }
  const first = fixture()
  t.after(() => first.dispose())

  const durableCode = 'let unnamedRestoreValue = 1'
  const durable = await first.runDurable(session.id, durableCode, {}, { session })
  appendRunCodeEvents(events, 'unnamed-durable', durableCode, durable)

  const volatileCode = 'unnamedRestoreValue = 2; void Math.random()'
  const volatile = await first.runDurable(session.id, volatileCode, {}, { session })
  appendRunCodeEvents(events, 'unnamed-volatile', volatileCode, volatile)

  const restoreCode = 'return await repl.state({ action: "restore" })'
  const restoredHead = await first.runDurable(session.id, restoreCode, {}, { session })
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
  const session = { id: 'session-branches', events }
  const first = fixture()
  const cells = [
    `let durableBranch = 1; void await repl.state({ action: 'save', name: 'one' })`,
    `durableBranch = 2; void await repl.state({ action: 'save', name: 'two' })`,
    `void await repl.state({ action: 'restore', name: 'one' })`,
  ]
  for (const [index, code] of cells.entries()) {
    const result = await first.runDurable('session-branches', code, {}, { session })
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
  const session = { id: 'import-catalog-restore', events }
  const first = fixture()
  const imported = [
    "import { inspect } from 'node:util'",
    'const importedInspect = value => inspect(value)',
    "void await repl.state({ action: 'save', name: 'imported' })",
  ].join('\n')
  const importedResult = await first.runDurable(session.id, imported, {}, { session })
  appendRunCodeEvents(events, 'catalog-import', imported, importedResult)

  const shadow = "const inspect = () => 'shadowed'"
  const shadowResult = await first.runDurable(session.id, shadow, {}, { session })
  appendRunCodeEvents(events, 'catalog-shadow', shadow, shadowResult)
  assert.deepEqual(await first.run(session.id, 'return [inspect({ a: 1 }), importedInspect({ a: 1 })]'), {
    logs: [], value: ['shadowed', '{ a: 1 }'],
  })

  const restore = "void await repl.state({ action: 'restore', name: 'imported' })"
  const restoreResult = await first.runDurable(session.id, restore, {}, { session })
  appendRunCodeEvents(events, 'catalog-restore', restore, restoreResult)
  assert.deepEqual(await first.run(session.id, 'return [inspect({ a: 1 }), importedInspect({ a: 1 })]'), {
    logs: [], value: ['{ a: 1 }', '{ a: 1 }'],
  })
  await first.dispose()

  const cold = fixture()
  t.after(() => cold.dispose())
  assert.deepEqual(await cold.run(session.id, 'return [inspect({ a: 1 }), importedInspect({ a: 1 })]', {}, { session }), {
    logs: [], value: ['{ a: 1 }', '{ a: 1 }'],
  })
})

test('contracts a broken replay node and continues the current request', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 20, maxWallMs: 1_000 })
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

  const currentCallSeq = events.length
  events.push({
    seq: currentCallSeq,
    type: 'tool/call',
    data: {
      callId: 'current-after-timeout',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return 1', description: 'current' }),
    },
  })
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
    seq: currentCallSeq + 1,
    type: 'tool/result',
    sourceEventSeqs: [currentCallSeq],
    data: { meta: resultMeta },
  })
  assert.deepEqual(resultMeta[RECOVERY_BOUNDARY_KEY], [{ failedCallSeq: 0, frontierCallSeq: null }])
})

test('contracts a live derived edit node by its persisted outer call sequence', async (t) => {
  const events = []
  const session = appendOnlySession('live-replay-contraction', events)
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())

  const executeConfirmed = async (callId, program, options = {}) => {
    const name = options.name ?? 'run_code'
    const call = session.append('tool/call', {
      turn: 0,
      step: 0,
      callId,
      name,
      arguments: JSON.stringify(name === 'run_code'
        ? { code: program, description: 'test cell' }
        : { edits: [{ old_string: options.targetSource, new_string: program }] }),
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
    return { call, context, result, kernel: execution.settlement.kernel }
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
  await child.kernel.client.reset(child.kernel.client.worker)
  child.kernel.rollbackToDurable()

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

  const restarted = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => restarted.dispose())
  const inspectCall = session.append('tool/call', {
    turn: 0,
    step: 1,
    callId: 'live-inspect',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'return [stableHead, typeof failedHead, freshHead]', description: 'test cell' }),
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
  assert.equal(runtime.kernels.has(session.id), true)
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

test('keeps availability when the optional session surface is unavailable', async (t) => {
  const session = {
    id: 'surface-unavailable',
    events: [{ seq: 0, type: 'tool/call', data: { callId: 'surface-call', name: 'run_code', arguments: '{"code":"return 7","description":"current"}' } }],
    get surface() { throw new Error('surface unavailable') },
  }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const execution = await runtime.run(
    { id: session.id, session, callId: 'surface-call' },
    { program: 'return 7', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(execution.value, 7)
})

test('rebuilds history when the model-visible surface generation changes', async (t) => {
  let generation = 0
  let surfaceNodes = [1, 3]
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
  events.push({
    seq: 4,
    type: 'tool/call',
    data: {
      callId: 'surface-before-replacement',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return [surfaceStable, surfaceHidden]', description: 'before replacement' }),
    },
  })
  surfaceNodes = [1, 3, 4]
  const first = await runtime.run(
    { id: session.id, session, callId: 'surface-before-replacement' },
    { program: 'return [surfaceStable, surfaceHidden]', bindings: [], signal: new AbortController().signal },
  )
  assert.deepEqual(first.value, [1, 2])
  const firstWorker = runtime.kernels.get(session.id).client.worker
  generation = 1
  events.push({
    seq: 5,
    type: 'tool/call',
    data: {
      callId: 'surface-after-replacement',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return [surfaceStable, typeof surfaceHidden]', description: 'after replacement' }),
    },
  })
  surfaceNodes = [1, 5]
  const second = await runtime.run(
    { id: session.id, session, callId: 'surface-after-replacement' },
    { program: 'return [surfaceStable, typeof surfaceHidden]', bindings: [], signal: new AbortController().signal },
  )
  assert.deepEqual(second.value, [1, 'undefined'])
  assert.match(second.logs[0], /Restored the durable head and skipped/)
  assert.notEqual(runtime.kernels.get(session.id).client.worker, firstWorker)

  let disabledGeneration = 0
  let disabledNodes = [0]
  const disabledEvents = [{
    seq: 0,
    type: 'tool/call',
    data: {
      callId: 'surface-disabled-first',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'const disabledHidden = 1', description: 'declare hidden binding' }),
    },
  }]
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
  const disabledWorker = disabledRuntime.kernels.get(disabledSession.id).client.worker
  disabledGeneration = 1
  disabledEvents.push({
    seq: 1,
    type: 'tool/call',
    data: {
      callId: 'surface-disabled-second',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return typeof disabledHidden', description: 'inspect hidden binding' }),
    },
  })
  disabledNodes = [0, 1]
  const disabledVisibleResult = await disabledRuntime.run(
    { id: disabledSession.id, session: disabledSession, callId: 'surface-disabled-second' },
    { program: 'return typeof disabledHidden', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(disabledVisibleResult.value, 'number')
  assert.deepEqual(disabledVisibleResult.logs, [])
  assert.equal(disabledRuntime.kernels.get(disabledSession.id).client.worker, disabledWorker)
  disabledGeneration = 2
  disabledEvents.push({
    seq: 2,
    type: 'tool/call',
    data: {
      callId: 'surface-disabled-third',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return typeof disabledHidden', description: 'inspect hidden binding' }),
    },
  })
  disabledNodes = [2]
  const disabledHiddenResult = await disabledRuntime.run(
    { id: disabledSession.id, session: disabledSession, callId: 'surface-disabled-third' },
    { program: 'return typeof disabledHidden', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(disabledHiddenResult.value, 'undefined')
  assert.notEqual(disabledRuntime.kernels.get(disabledSession.id).client.worker, disabledWorker)

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
  const executeVolatile = async (seq, callId, program) => {
    volatileEvents.push({
      seq,
      type: 'tool/call',
      data: {
        callId,
        name: 'run_code',
        arguments: JSON.stringify({ code: program, description: 'volatile surface cell' }),
      },
    })
    volatileNodes = [...volatileNodes, seq]
    const execution = await volatileRuntime.runTentative(
      { id: volatileSession.id, session: volatileSession, callId },
      { program, bindings: [], signal: new AbortController().signal },
    )
    volatileRuntime.finalize(execution.settlement, true)
    return execution
  }
  const volatileFirst = await executeVolatile(0, 'surface-volatile-first', 'const surfaceVolatile = Date.now()')
  assert.equal(volatileFirst.settlement.journal.status, 'volatile')
  const volatileWorker = volatileRuntime.kernels.get(volatileSession.id).client.worker
  volatileGeneration = 1
  const volatileVisible = await executeVolatile(1, 'surface-volatile-second', 'return typeof surfaceVolatile')
  assert.equal(volatileVisible.result.value, 'number')
  assert.deepEqual(volatileVisible.result.logs, [])
  assert.equal(volatileRuntime.kernels.get(volatileSession.id).client.worker, volatileWorker)
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
  events.push({
    seq: 8,
    type: 'tool/call',
    data: {
      callId: 'count-current',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return countStable', description: 'inspect recovered prefix' }),
    },
  })
  const session = { id: 'count-unavailable-suffix', events }
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
  let surfaceNodes = [0]
  const events = [{
    seq: 0,
    type: 'tool/call',
    data: {
      callId: 'disabled-edit-source',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'let editableSurface = 1', description: 'editable source' }),
    },
  }]
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
  const firstWorker = runtime.kernels.get(session.id).client.worker

  events.push({
    seq: 1,
    type: 'tool/call',
    data: {
      callId: 'disabled-edit-call',
      name: 'edit_run_code',
      arguments: JSON.stringify({ edits: [{ old_string: '1', new_string: '2' }] }),
    },
  })
  surfaceNodes = [0, 1]
  const edited = await runtime.run(
    {
      id: session.id,
      session,
      callId: 'disabled-edit-call:derived',
      persistedCallSeq: 1,
    },
    { program: 'editableSurface = 2', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(edited.error, undefined)
  assert.equal(runtime.kernels.get(session.id).client.worker, firstWorker)

  generation = 1
  events.push({
    seq: 2,
    type: 'tool/call',
    data: {
      callId: 'disabled-edit-inspect',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return editableSurface', description: 'inspect edited source' }),
    },
  })
  surfaceNodes = [0, 1, 2]
  const visible = await runtime.run(
    { id: session.id, session, callId: 'disabled-edit-inspect' },
    { program: 'return editableSurface', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(visible.value, 2)
  assert.deepEqual(visible.logs, [])
  assert.equal(runtime.kernels.get(session.id).client.worker, firstWorker)

  generation = 2
  surfaceNodes = [2]
  events.push({
    seq: 3,
    type: 'tool/call',
    data: {
      callId: 'disabled-edit-after-hide',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return typeof editableSurface', description: 'inspect hidden edit' }),
    },
  })
  const hidden = await runtime.run(
    { id: session.id, session, callId: 'disabled-edit-after-hide' },
    { program: 'return typeof editableSurface', bindings: [], signal: new AbortController().signal },
  )
  assert.equal(hidden.value, 'undefined')
  assert.match(hidden.logs[0], /Restored the durable head and skipped/)
  assert.notEqual(runtime.kernels.get(session.id).client.worker, firstWorker)
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
  events[3].data.meta.dshPtcPlus = normalizeJournal(events[3].data.meta.dshPtcPlus)

  const recovering = fixture({ computeMs: 20, maxWallMs: 1_000 })
  t.after(() => recovering.dispose())
  const confirmed = await recovering.executeRun(
    session.id,
    'const freshHead = stableHead + 4',
    {},
    { session },
  )
  appendRunCodeEvents(events, 'fresh-head', 'const freshHead = stableHead + 4', confirmed.result)
  assert.equal(confirmed.raw.error, undefined)

  const restarted = fixture({ computeMs: 20, maxWallMs: 1_000 })
  t.after(() => restarted.dispose())
  assert.deepEqual(await restarted.run(session.id, 'return [stableHead, freshHead]', {}, { session }), {
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
    const state = fixture({ computeMs: 20, maxWallMs: 1_000 })
    t.after(() => state.dispose())
    const contracted = await state.executeRun(
      session.id,
      `const boundaryValue${index} = ${index + 1}`,
      {},
      { session, finalizeResult: result => ({ ...result, meta: mutate(result.meta) }) },
    )
    assert.equal(contracted.raw.error, undefined)
    const dependent = await state.runDurable(
      session.id,
      `return boundaryValue${index}`,
      {},
      { session },
    )
    assert.equal(dependent.meta.dshPtcPlus.status, 'volatile')
  }

  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('unexpected-boundary', 'const unexpectedBoundary = 1', {}, {
    finalizeResult: result => ({
      ...result,
      meta: {
        ...result.meta,
        [RECOVERY_BOUNDARY_KEY]: [{ failedCallSeq: 1, frontierCallSeq: null }],
      },
    }),
  })
  const dependent = await state.runDurable('unexpected-boundary', 'return unexpectedBoundary')
  assert.equal(dependent.meta.dshPtcPlus.status, 'volatile')
})
