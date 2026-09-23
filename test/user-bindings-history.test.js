import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { JOURNAL_KEY, normalizeJournal } from '../internal/session-journal.js'
import { JOURNAL_VERSION } from '../internal/session-journal-schema.js'
import { createUserBindingsSnapshot, USER_BINDINGS_META_KEY } from '../internal/user-bindings.js'
import { encodeValue } from '../internal/value-wire.js'
import { appendRunCodeEvents, orderedSurfaceSession } from './plugin-fixture.js'
import { interceptWorkerMessages } from './runtime-observation.js'

function withoutReuse(entry) {
  const { reuseCount, ...rest } = entry
  return rest
}

function pair(seed = 0, enabled = true) {
  return {
    id: 'pair', name: 'pair', scope: 'top-level', enabled,
    source: `await tools.observe({}); let count = ${seed}; export const alpha = { initial: ${seed} }; export function beta() { return ++count }`,
  }
}

function snapshot(entries, revision = 1) {
  return createUserBindingsSnapshot({ entries }, revision)
}

function nextEventSeq(events) {
  return Math.max(-1, ...events.map(event => event.seq)) + 1
}

function appendRecordedRunCodeEvents(events, callId, code, result) {
  const offset = nextEventSeq(events)
  const recorded = []
  const local = appendRunCodeEvents(recorded, callId, code, result)
  for (const event of recorded) {
    event.seq += offset
    event.time = event.seq
    if (event.sourceEventSeqs !== undefined) {
      event.sourceEventSeqs = event.sourceEventSeqs.map(seq => seq + offset)
    }
  }
  events.push(...recorded)
  return Object.freeze({
    assistantSeq: local.assistantSeq + offset,
    callSeq: local.callSeq + offset,
    resultSeq: local.resultSeq + offset,
  })
}

function eventAt(session, seq) {
  return session.events.find(event => event.seq === seq)
}

async function record(runtime, session, program, userBindings, functions = {}) {
  const callSeq = nextEventSeq(session.events) + 1
  const execution = await runtime.runTentative({ id: session.id, session, persistedCallSeq: callSeq }, {
    program, userBindings, bindings: [{ global: 'tools', functions }],
  })
  assert.equal(execution.result.error, undefined, execution.result.error?.message)
  const { settlement } = execution
  assert.equal(settlement.journal.status, 'durable')
  const meta = { [JOURNAL_KEY]: normalizeJournal(settlement.journal),
    ...(settlement.userBindings === undefined ? {} : { [USER_BINDINGS_META_KEY]: settlement.userBindings }),
    ...(settlement.recoveryBoundaries === undefined ? {} : { dshPtcPlusRecoveryBoundaries: settlement.recoveryBoundaries }),
  }
  runtime.finalize(settlement, true)
  const eventSeqs = appendRecordedRunCodeEvents(session.events, `history-${callSeq}`, program, { meta })
  assert.equal(eventSeqs.callSeq, callSeq)
  return { ...execution.result, meta, replMemory: settlement.replMemory, eventSeqs }
}

function historicalJournal(version, userBindings, calls = []) {
  // These fixtures record whole-entry activation. A later cell with one local
  // override has an empty activated snapshot even though its sibling was live.
  return {
    version,
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    moduleSemantics: { defaultExportBinding: 'live-readonly',
      ...(version === 7 ? { importExpressionBoundary: 'statement-safe' } : {}),
    },
    userBindingsFingerprint: userBindings?.fingerprint ?? null,
    userBindingsReusePolicy: 'implementation-v1',
    status: 'durable', calls, operations: [], confirms: [], diagnostics: [],
    completion: { kind: 'return', hasValue: false },
  }
}

function wholeEntryHistory(version) {
  const full = snapshot([pair()])
  const empty = snapshot([])
  const session = orderedSurfaceSession(`whole-entry-${version}`)
  const sources = [
    'const savedAlpha = alpha; const savedBeta = beta; const before = beta(); void 0',
    'alpha = { local: true }; const localAlpha = alpha; const inside = beta(); void 0',
    'const after = typeof beta; const savedAfter = savedBeta(); void 0',
  ]
  for (const [index, code] of sources.entries()) {
    const userBindings = index === 2 ? empty : full
    const calls = index === 0 ? [{
      global: 'tools', member: 'observe', args: encodeValue({}), ok: true,
      value: encodeValue('initialized'), settle: 0,
    }] : []
    appendRunCodeEvents(session.events, `whole-${index}`, code, { meta: {
      [JOURNAL_KEY]: historicalJournal(version, userBindings, calls),
      [USER_BINDINGS_META_KEY]: userBindings,
    } })
  }
  return { session, full }
}

test('top-level accessor capture cannot create durable setter ancestry', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  let initializations = 0
  const selected = snapshot([{ id: 'alpha', name: 'alpha', scope: 'top-level', enabled: true,
    source: 'await tools.observe({}); export const alpha = 1',
  }])
  const execution = await runtime.runTentative('volatile-setter-ancestry', {
    program: 'const savedSetter = Object.getOwnPropertyDescriptor(this, "alpha").set; return alpha',
    userBindings: selected,
    bindings: [{ global: 'tools', functions: { observe: async () => ++initializations } }],
  })
  runtime.finalize(execution.settlement, true)
  assert.equal(execution.result.value, 1)
  assert.equal(execution.settlement.journal.status, 'volatile')
  assert.equal(execution.settlement.journal.volatileReason, 'ambient globalThis')
  assert.equal(initializations, 1)
})

test('legacy retained setters remain callable after disabled ancestry and new per-name cells', async t => {
  for (const version of [6, 7]) await t.test(`journal ${version}`, async t => {
    const selected = snapshot([{ id: 'alpha', name: 'alpha', scope: 'top-level', enabled: true, source: 'export const alpha = 1' }])
    const session = orderedSurfaceSession(`legacy-retained-setter-${version}`)
    const source = 'const savedRoot = this; const savedSetter = Object.getOwnPropertyDescriptor(savedRoot, "alpha").set; const retained = 42; void 0'
    appendRunCodeEvents(session.events, 'legacy-setter', source, { meta: {
      [JOURNAL_KEY]: historicalJournal(version, selected), [USER_BINDINGS_META_KEY]: selected,
    } })
    appendRunCodeEvents(session.events, 'legacy-disabled', 'void 0', { meta: {
      [JOURNAL_KEY]: historicalJournal(version, undefined),
    } })
    const historical = structuredClone(session.events)
    for (let generation = 0; generation < 2; generation++) {
      const runtime = new SessionRuntime()
      t.after(() => runtime.dispose())
      const idle = await record(runtime, session, 'void 0', undefined)
      if (generation === 0) {
        assert.equal(idle.replMemory.entries.some(entry => entry.name === 'alpha'), false)
        assert.deepEqual(idle.meta[JOURNAL_KEY].userBindingNames, [])
      }
      const assigned = await record(runtime, session, 'savedSetter.call(savedRoot, 7); return [alpha, retained]', undefined)
      assert.deepEqual(assigned.value, [7, 42])
      assert.deepEqual(assigned.meta[JOURNAL_KEY].userBindingNames, [{ name: 'alpha', state: 'local' }])
      assert.equal(assigned.meta.dshPtcPlusRecoveryBoundaries, undefined)
      await runtime.dispose()
    }
    assert.deepEqual(session.events.slice(0, historical.length), historical)
  })
})

test('unknown-boundary contraction cannot retain discarded provider-name eligibility', async t => {
  const session = orderedSurfaceSession('contracted-setter-ancestry')
  const selected = snapshot([{ id: 'alpha', name: 'alpha', scope: 'top-level', enabled: true, source: 'export const alpha = 1' }])
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const anchor = await record(runtime, session, 'const anchor = 42; void 0', undefined)
  const savedProvider = await record(runtime, session, 'const savedProvider = alpha; void 0', selected)
  await record(runtime, session, 'void 0', undefined)
  await runtime.dispose()
  session.events = structuredClone(session.events)
  delete eventAt(session, savedProvider.eventSeqs.resultSeq).data.meta[JOURNAL_KEY].userBindingNames
  const restored = new SessionRuntime()
  t.after(() => restored.dispose())
  const contracted = await record(restored, session, 'return [anchor, typeof savedProvider, typeof alpha]', undefined)
  assert.deepEqual(contracted.value, [42, 'undefined', 'undefined'])
  assert.deepEqual(contracted.meta.dshPtcPlusRecoveryBoundaries,
    [{ failedCallSeq: savedProvider.eventSeqs.callSeq, frontierCallSeq: anchor.eventSeqs.callSeq }])
  const intercepted = interceptWorkerMessages(restored, session.id, (message, deliver) => {
    if (message.type === 'done') message.userBindingNames.push({ name: 'alpha', state: 'local' })
    deliver(message)
  })
  const forged = await restored.runTentative({
    id: session.id, session, persistedCallSeq: nextEventSeq(session.events) + 1,
  }, {
    program: 'return anchor', bindings: [],
  })
  intercepted.restore()
  restored.finalize(forged.settlement, true)
  assert.equal(forged.result.error.kind, 'worker-exit')
  assert.match(forged.result.error.message, /invalid ownership/)
  assert.equal(forged.settlement.journal.status, 'discarded')
})

test('retains per-name overrides and saved module identities through lifecycle changes and cold replay', async t => {
  const session = orderedSurfaceSession('per-name-lifecycle')
  let initializations = 0
  const functions = { observe: async () => { initializations++; return 'initialized' } }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const initial = snapshot([pair()])
  const updated = snapshot([pair(100)], 2)
  const first = await record(runtime, session,
    'const savedAlpha = alpha; const savedBeta = beta; const before = beta(); void 0', initial, functions)
  assert.equal(first.meta[JOURNAL_KEY].version, JOURNAL_VERSION)
  assert.equal(first.meta[JOURNAL_KEY].userBindingsShadowPolicy, 'per-name')
  const shadow = await record(runtime, session,
    'alpha = { local: true }; const localAlpha = alpha; const inside = beta(); void 0', initial, functions)
  assert.deepEqual(shadow.meta[JOURNAL_KEY].completion, { kind: 'return', hasValue: false })
  assert.deepEqual(shadow.meta[JOURNAL_KEY].userBindingNames, [
    { name: 'alpha', state: 'local' }, { name: 'beta', state: 'provider', entryId: 'pair' },
  ])
  assert.deepEqual(shadow.meta[USER_BINDINGS_META_KEY].entries[0].symbols, ['alpha', 'beta'])
  const sibling = await record(runtime, session,
    'const after = typeof beta; const savedAfter = savedBeta(); return [before, inside, after, savedAfter, beta === savedBeta, alpha === localAlpha]', initial, functions)
  assert.deepEqual(sibling.value, [1, 2, 'function', 3, true, true])
  assert.equal(initializations, 1)
  const changed = await record(runtime, session,
    'return [alpha === localAlpha, savedAlpha.initial, beta === savedBeta, beta(), savedBeta()]', updated, functions)
  assert.deepEqual(changed.value, [true, 0, false, 101, 4])
  assert.equal(initializations, 2)
  for (const removed of [snapshot([pair(100, false)], 3), snapshot([], 4), undefined]) {
    const inactive = await record(runtime, session,
      'return [alpha === localAlpha, typeof beta, typeof savedBeta]', removed, functions)
    assert.deepEqual(inactive.value, [true, 'undefined', 'function'])
    assert.deepEqual(inactive.meta[JOURNAL_KEY].userBindingNames, [{ name: 'alpha', state: 'local' }])
    assert.equal(initializations, 2)
  }
  const enabled = await record(runtime, session,
    'return [alpha === localAlpha, beta(), savedBeta()]', updated, functions)
  assert.deepEqual(enabled.value, [true, 101, 5])
  assert.equal(initializations, 3)
  await runtime.dispose()
  const restored = new SessionRuntime()
  t.after(() => restored.dispose())
  const continued = await record(restored, session,
    'return [alpha === localAlpha, before, inside, after, savedAfter, savedAlpha.initial, beta(), savedBeta()]', updated, functions)
  assert.deepEqual(continued.value, [true, 1, 2, 'function', 3, 0, 102, 6])
  assert.equal(initializations, 3)
  assert.deepEqual(continued.meta[JOURNAL_KEY].calls, [])
  assert.equal(continued.meta.dshPtcPlusRecoveryBoundaries, undefined)
})

test('replays imported aliases with truthful source and UI evidence across void cells and provider lifecycle', async t => {
  const cases = [
    ['named', 'alpha', 'import { format as alpha } from "node:util";', 'alpha("%s", "value")', 'import'],
    ['default', 'alpha', 'import alpha from "node:util";', 'alpha.format("%s", "value")', 'import'],
    ['namespace', 'alpha', 'import * as alpha from "node:util";', 'alpha.format("%s", "value")', 'import'],
    ['synthetic default', '__default', 'export default { value: "value" }', '__default.value', 'variable'],
  ]
  for (const [style, name, declaration, read, kind] of cases) await t.test(style, async t => {
    const session = orderedSurfaceSession(`import-alias-cold-replay-${style}`)
    let initializations = 0
    const functions = { observe: async () => { initializations++; return 'initialized' } }
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    const empty = snapshot([])
    const provider = (seed, enabled = true) => ({
      id: 'pair', name: 'pair', scope: 'top-level', enabled,
      source: `await tools.observe({}); export const ${name} = 1; export const beta = ${seed}`,
    })
    const selected = snapshot([provider(2)])
    const updated = snapshot([provider(20)], 2)
    const facts = [{ name, state: 'local' }, { name: 'beta', state: 'provider', entryId: 'pair' }]
    const definition = { name, kind, definition: { source: declaration, line: 1, column: 1 } }
    const assertEvidence = (result, enabled = true) => {
      assert.deepEqual(result.meta[JOURNAL_KEY].userBindingNames, enabled ? facts : [{ name, state: 'local' }])
      assert.deepEqual(withoutReuse(result.replMemory.entries.find(entry => entry.name === name)), definition)
      assert.equal(result.meta.dshPtcPlusRecoveryBoundaries, undefined)
    }
    const imported = await record(runtime, session,
      `${declaration}\nconst saved = ${name}; const read = () => ${read}; void 0`, empty, functions)
    assert.deepEqual(withoutReuse(imported.replMemory.entries.find(entry => entry.name === name)), definition)
    const attached = await record(runtime, session,
      `const observed = [${read}, beta, ${name} === saved]; void 0`, selected, functions)
    assert.deepEqual(attached.meta[JOURNAL_KEY].completion, { kind: 'return', hasValue: false })
    assert.equal(attached.meta[JOURNAL_KEY].calls.length, 1)
    assertEvidence(attached)
    const checked = await record(runtime, session,
      `return [observed, ${read}, beta, ${name} === saved, read()]`, selected, functions)
    assert.deepEqual(checked.value, [['value', 2, true], 'value', 2, true, 'value'])
    assertEvidence(checked)
    const changed = await record(runtime, session, 'void 0', updated, functions)
    assertEvidence(changed)
    assert.equal(initializations, 2)
    for (const removed of [snapshot([provider(20, false)], 3), snapshot([], 4)]) {
      const inactive = await record(runtime, session, `return [${read}, typeof beta, ${name} === saved]`, removed, functions)
      assert.deepEqual(inactive.value, ['value', 'undefined', true])
      assertEvidence(inactive, false)
    }
    const enabled = await record(runtime, session, 'void 0', updated, functions)
    assertEvidence(enabled)
    assert.equal(initializations, 3)
    const historical = structuredClone(session.events)
    await runtime.dispose()
    const restored = new SessionRuntime()
    t.after(() => restored.dispose())
    const continued = await record(restored, session,
      `return [observed, ${read}, beta, ${name} === saved, read()]`, updated, functions)
    assert.deepEqual(continued.value, [['value', 2, true], 'value', 20, true, 'value'])
    assertEvidence(continued)
    assert.deepEqual(continued.meta[JOURNAL_KEY].calls, [])
    assert.equal(initializations, 3)
    assert.deepEqual(session.events.slice(0, historical.length), historical)
  })
})

test('rejects false import alias absence during void replay without redispatching historical calls', async t => {
  const session = orderedSurfaceSession('false-import-absence')
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  let initializations = 0
  const functions = { observe: async () => { initializations++; return 'initialized' } }
  const selected = snapshot([pair()])
  const imported = await record(runtime, session,
    'import { format as alpha } from "node:util"; void 0', snapshot([]), functions)
  const attached = await record(runtime, session, 'const observed = [alpha("ok"), beta()]; void 0', selected, functions)
  assert.deepEqual(attached.meta[JOURNAL_KEY].completion, { kind: 'return', hasValue: false })
  assert.deepEqual(attached.meta[JOURNAL_KEY].userBindingNames, [
    { name: 'alpha', state: 'local' }, { name: 'beta', state: 'provider', entryId: 'pair' },
  ])
  assert.equal(initializations, 1)
  await runtime.dispose()
  session.events = structuredClone(session.events)
  eventAt(session, attached.eventSeqs.resultSeq).data.meta[JOURNAL_KEY].userBindingNames[0].state = 'absent'
  for (let generation = 0; generation < 2; generation++) {
    const restored = new SessionRuntime()
    t.after(() => restored.dispose())
    const continued = await record(restored, session,
      'return [alpha("ok"), typeof observed, typeof beta]', undefined, functions)
    assert.deepEqual(continued.value, ['ok', 'undefined', 'undefined'])
    assert.equal(initializations, 1)
    assert.deepEqual(continued.meta[JOURNAL_KEY].calls, [])
    assert.deepEqual(withoutReuse(continued.replMemory.entries.find(entry => entry.name === 'alpha')), {
      name: 'alpha', kind: 'import',
      definition: { source: 'import { format as alpha } from "node:util";', line: 1, column: 1 },
    })
    if (generation === 0) {
      assert.deepEqual(continued.meta.dshPtcPlusRecoveryBoundaries,
        [{ failedCallSeq: attached.eventSeqs.callSeq, frontierCallSeq: imported.eventSeqs.callSeq }])
      assert.equal(continued.meta[JOURNAL_KEY].diagnostics.filter(item => item.code === 'PTC-R002').length, 1)
    } else {
      assert.equal(continued.meta.dshPtcPlusRecoveryBoundaries, undefined)
      assert.deepEqual(continued.meta[JOURNAL_KEY].diagnostics, [])
    }
    await restored.dispose()
  }
})

test('fully activates changed entries when every public name is local and replays their initializer values', async t => {
  const session = orderedSurfaceSession('all-names-local')
  let initializations = 0
  const functions = { observe: async () => { initializations++; return 'initialized' } }
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const initial = snapshot([pair()])
  const updated = snapshot([pair(100)], 2)
  const local = await record(runtime, session,
    'alpha = alpha; beta = beta; const savedAlpha = alpha; const savedBeta = beta; void 0', initial, functions)
  const facts = [{ name: 'alpha', state: 'local' }, { name: 'beta', state: 'local' }]
  assert.deepEqual(local.meta[JOURNAL_KEY].userBindingNames, facts)
  const changed = await record(runtime, session,
    'const saved = [alpha === savedAlpha, beta === savedBeta, beta()]; void 0', updated, functions)
  assert.deepEqual(changed.meta[JOURNAL_KEY].userBindingNames, facts)
  assert.deepEqual(changed.meta[USER_BINDINGS_META_KEY], updated)
  assert.equal(changed.meta[JOURNAL_KEY].calls.length, 1)
  assert.equal(initializations, 2)
  await runtime.dispose()
  const restored = new SessionRuntime()
  t.after(() => restored.dispose())
  const continued = await record(restored, session,
    'return [saved, alpha === savedAlpha, beta === savedBeta, beta()]', updated, functions)
  assert.deepEqual(continued.value, [[true, true, 1], true, true, 2])
  assert.deepEqual(continued.meta[JOURNAL_KEY].userBindingNames, facts)
  assert.equal(continued.meta.dshPtcPlusRecoveryBoundaries, undefined)
  assert.deepEqual(continued.meta[JOURNAL_KEY].calls, [])
  assert.equal(initializations, 2)
})

test('replays historical whole-entry removal before appending new per-name cells', async t => {
  for (const version of [6, 7]) await t.test(`journal ${version}`, async t => {
    const { session, full } = wholeEntryHistory(version)
    const historical = structuredClone(session.events)
    let initializations = 0
    const functions = { observe: async () => { initializations++; return 'initialized' } }
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    const removed = await record(runtime, session,
      'return [before, inside, after, savedAfter, typeof beta, alpha === localAlpha, savedBeta()]', undefined, functions)
    assert.deepEqual(removed.value, [1, 2, 'undefined', 3, 'undefined', true, 4])
    assert.equal(initializations, 0)
    const activated = await record(runtime, session,
      'const currentBeta = beta; const mixedSaved = [alpha === localAlpha, beta(), savedBeta()]; void 0', full, functions)
    assert.deepEqual(activated.meta[JOURNAL_KEY].completion, { kind: 'return', hasValue: false })
    assert.deepEqual(activated.meta[JOURNAL_KEY].userBindingNames, [
      { name: 'alpha', state: 'local' }, { name: 'beta', state: 'provider', entryId: 'pair' },
    ])
    assert.equal(initializations, 1)
    await runtime.dispose()
    const restored = new SessionRuntime()
    t.after(() => restored.dispose())
    const continued = await record(restored, session,
      'return [mixedSaved, after, beta === currentBeta, alpha === localAlpha, beta(), savedBeta()]', full, functions)
    assert.deepEqual(continued.value, [[true, 1, 5], 'undefined', true, true, 2, 6])
    assert.equal(initializations, 1)
    assert.equal(continued.meta.dshPtcPlusRecoveryBoundaries, undefined)
    assert.deepEqual(session.events.slice(0, historical.length), historical)
  })
})

test('contracts corrupt or false name evidence once and continues from the greatest proved frontier', async t => {
  const full = snapshot([pair()])
  const original = orderedSurfaceSession('source-proof')
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  let initializations = 0
  const functions = { observe: async () => { initializations++; return 'initialized' } }
  const anchor = await record(runtime, original, 'const anchor = 40; void 0', undefined, functions)
  const corrupted = await record(runtime, original,
    'alpha = { local: true }; const saved = beta(); void 0', full, functions)
  await record(runtime, original, 'const dependent = saved + 1; void 0', full, functions)
  assert.equal(initializations, 1)
  await runtime.dispose()
  const corruptions = [
    ['missing facts', journal => { delete journal.userBindingNames }],
    ['missing sibling', journal => { journal.userBindingNames = journal.userBindingNames.slice(0, 1) }],
    ['duplicate name', journal => { journal.userBindingNames.push(journal.userBindingNames[0]) }],
    ['wrong provider identity', journal => { journal.userBindingNames[1].entryId = 'other' }],
    ['false provider source', journal => { journal.userBindingNames[0] = { name: 'alpha', state: 'provider', entryId: 'pair' } }],
    ['false local source', journal => { journal.userBindingNames[1] = { name: 'beta', state: 'local' } }],
    ['false absence', journal => { journal.userBindingNames[1] = { name: 'beta', state: 'absent' } }],
    ['unknown source', journal => { journal.userBindingNames[1] = { name: 'beta', state: 'unknown' } }],
    ['missing policy', journal => { delete journal.userBindingsShadowPolicy }],
  ]
  for (const [label, corrupt] of corruptions) for (const keepPrefix of [true, false]) {
    await t.test(`${label}, prefix ${keepPrefix}`, async t => {
      const session = orderedSurfaceSession(`${label}-${keepPrefix}`, structuredClone(original.events))
      corrupt(eventAt(session, corrupted.eventSeqs.resultSeq).data.meta[JOURNAL_KEY])
      if (!keepPrefix) session.events = session.events.filter(event => event.seq > anchor.eventSeqs.resultSeq)
      const source = structuredClone(session.events)
      for (let generation = 0; generation < 2; generation++) {
        const restored = new SessionRuntime()
        t.after(() => restored.dispose())
        const continued = await record(restored, session,
          'const current = 2; return [typeof anchor === "undefined" ? null : anchor, typeof saved, typeof dependent, typeof alpha, typeof beta, current]', undefined, functions)
        assert.deepEqual(continued.value, [keepPrefix ? 40 : null, 'undefined', 'undefined', 'undefined', 'undefined', 2])
        assert.equal(initializations, 1)
        assert.deepEqual(continued.meta[JOURNAL_KEY].calls, [])
        if (generation === 0) {
          assert.deepEqual(continued.meta.dshPtcPlusRecoveryBoundaries, [{
            failedCallSeq: corrupted.eventSeqs.callSeq,
            frontierCallSeq: keepPrefix ? anchor.eventSeqs.callSeq : null,
          }])
          assert.equal(continued.meta[JOURNAL_KEY].diagnostics.filter(item => item.code === 'PTC-R002').length, 1)
        } else {
          assert.equal(continued.meta.dshPtcPlusRecoveryBoundaries, undefined)
          assert.deepEqual(continued.meta[JOURNAL_KEY].diagnostics, [])
        }
        await restored.dispose()
      }
      assert.deepEqual(session.events.slice(0, source.length), source)
    })
  }
})
