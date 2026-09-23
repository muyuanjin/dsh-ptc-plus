import assert from 'node:assert/strict'
import test from 'node:test'
import { RELEASED_V0_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import {
  JOURNAL_KEY,
  RECOVERY_BOUNDARY_EVENT,
  RECOVERY_BOUNDARY_KEY,
  REWRITES_KEY,
  assertStateName,
  createJournal,
  derivedEditResultsEqual,
  journalsEqual,
  liveToolCallSeq,
  migrateRecoveryBoundaryEvents,
  normalizeRecoveryBoundaries,
  normalizeDerivedEditResult,
  normalizeJournal,
  normalizeRewrites,
  recoveryBoundariesEqual,
  reduceStateOperations,
  userBindingsForJournal,
  withJournal,
  withRecoveryBoundaries,
  withRewrites,
} from '../internal/session-journal.js'
import {
  pathToHead,
  recoverJournal,
  recoveryBoundaryForHistory,
  visibleExecutableCallSeqs,
} from '../internal/session-journal-recovery.js'
import {
  IMPORT_BOUNDARY_JOURNAL_VERSION,
  LANGUAGE_SEMANTICS_JOURNAL_VERSION,
  JOURNAL_VERSION,
  JOURNAL_VERSIONS,
  PER_NAME_USER_BINDINGS_JOURNAL_VERSION,
  normalizeUserBindingNames,
  usesCallSequenceConfirms,
} from '../internal/session-journal-schema.js'
import { editTargetForCall, projectSessionLog } from '../internal/session-log-view.js'
import {
  createUserBindingsSnapshot,
  USER_BINDINGS_META_KEY,
} from '../internal/user-bindings.js'
import { encodeValue } from '../internal/value-wire.js'
import { LEGACY_USER_BINDING_TRANSFORM, PREVIOUS_USER_BINDING_TRANSFORM,
  PROTECTED_MODULE_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/module-transform-contract.js'

function completion(value = 1) {
  return { kind: 'return', hasValue: true, value: encodeValue(value) }
}

test('only recognized journal generations use persisted sequence confirmations', () => {
  for (const version of JOURNAL_VERSIONS) {
    assert.equal(usesCallSequenceConfirms({ version }), version !== 1)
  }
  for (const value of [undefined, null, {}, { version: 0 }, { version: 999 }]) {
    assert.equal(usesCallSequenceConfirms(value), false)
  }
})

test('derives recovery boundaries from the selected frontier and consumes no history', () => {
  const first = { callSeq: 3, parent: undefined }
  const second = { callSeq: 7, parent: 0 }
  const history = { available: true, nodes: [first, second], head: 1, volatileSuffix: [] }
  assert.equal(recoveryBoundaryForHistory(history), undefined)
  assert.equal(recoveryBoundaryForHistory({ ...history, available: false }), undefined)
  assert.deepEqual(recoveryBoundaryForHistory(history, second), { failedCallSeq: 7, frontierCallSeq: 3 })
  assert.deepEqual(recoveryBoundaryForHistory(history, first), { failedCallSeq: 3, frontierCallSeq: null })
  const unavailable = { ...history, available: false, volatileSuffix: [{ seq: 11, reason: 'missing result' }] }
  assert.deepEqual(recoveryBoundaryForHistory(unavailable), { failedCallSeq: 11, frontierCallSeq: 7 })
  assert.deepEqual(recoveryBoundaryForHistory({ ...unavailable, head: undefined }), {
    failedCallSeq: 11, frontierCallSeq: null,
  })
  assert.deepEqual(recoveryBoundaryForHistory({ ...unavailable, head: 99 }), {
    failedCallSeq: 11, frontierCallSeq: null,
  })
  assert.deepEqual(history, { available: true, nodes: [first, second], head: 1, volatileSuffix: [] })
})

function journal(overrides = {}) {
  const version = overrides.version ?? JOURNAL_VERSION
  return {
    version,
    ...(version >= LANGUAGE_SEMANTICS_JOURNAL_VERSION ? { languageSemantics: 'legacy-v1' } : {}),
    ...(version > LANGUAGE_SEMANTICS_JOURNAL_VERSION ? { moduleTransform: LEGACY_USER_BINDING_TRANSFORM } : {}),
    ...(version >= 4 ? {
      bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: false },
      rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
      moduleSemantics: { defaultExportBinding: 'live-readonly',
        ...(version >= IMPORT_BOUNDARY_JOURNAL_VERSION ? { importExpressionBoundary: 'statement-safe' } : {}),
      },
      ...(version >= 5 ? { userBindingsFingerprint: null } : {}),
      ...(version >= 6 ? { userBindingsReusePolicy: 'implementation-v1' } : {}),
    } : {
      bindingMode: 'loose',
      ...(version === 1 ? {} : {
        rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
      }),
    }),
    ...(version >= PER_NAME_USER_BINDINGS_JOURNAL_VERSION ? {
      userBindingsShadowPolicy: 'per-name',
      userBindingNames: ['noop', 'discarded'].includes(overrides.status) ? null : [],
    } : {}),
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: completion(),
    ...overrides,
  }
}

function callEvent(seq, callId, code) {
  return { seq, type: 'tool/call', data: { name: 'run_code', callId, arguments: JSON.stringify({ code }) } }
}

function resultEvent(sourceSeq, value) {
  return { type: 'tool/result', sourceEventSeqs: [sourceSeq], data: { meta: { [JOURNAL_KEY]: value } } }
}

test('ignores an unjournaled edit call with an invalid historical sequence', () => {
  const session = { events: [{
    type: 'tool/call',
    data: { name: 'edit_run_code', callId: 'invalid-edit', arguments: '{"edits":[]}' },
  }] }
  assert.deepEqual(recoverJournal(session), {
    nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: false,
  })
})

test('normalizes complete journal values and detaches nested value wires', () => {
  const value = journal({
    bindingPolicy: { variableRedeclarations: false, functionClassRedeclarations: false },
    calls: [
      { global: 'code', member: 'run', args: encodeValue({ code: 'child-a' }), ok: false, error: 'missing', settle: 1 },
      { global: 'code', member: 'run', args: encodeValue({ code: 'child-b' }), ok: true, value: encodeValue(undefined), settle: 0 },
    ],
    operations: [
      { action: 'save', name: 'point.one' },
      { action: 'restore' },
      { action: 'delete', name: 'point.one' },
    ],
    confirms: [7],
    diagnostics: [{
      code: 'PTC-T001', severity: 'note', phase: 'replay', message: 'replayed', stateEffect: 'unchanged',
    }],
  })
  const normalized = normalizeJournal(value)
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.calls))
  assert.ok(Object.isFrozen(normalized.operations))
  assert.ok(Object.isFrozen(normalized.confirms))
  assert.ok(Object.isFrozen(normalized.diagnostics))
  assert.deepEqual(normalized.operations, value.operations)
  assert.notEqual(normalized.calls[0].args, value.calls[0].args)
  assert.equal(normalized.volatileReason, undefined)
  assert.deepEqual(normalized.moduleSemantics, { defaultExportBinding: 'live-readonly', importExpressionBoundary: 'statement-safe' })
  assert.equal(normalizeJournal(journal({
    status: 'volatile',
    volatileReason: 'ambient Date',
  })).volatileReason, 'ambient Date')

  assert.deepEqual(normalizeJournal(journal({
    status: 'discarded',
    completion: undefined,
  })).completion, undefined)
  assert.deepEqual(normalizeJournal(journal({
    completion: { kind: 'return', hasValue: false },
  })).completion, { kind: 'return', hasValue: false })
  assert.deepEqual(normalizeJournal(journal({
    completion: { kind: 'throw', error: { kind: 'TypeError', message: 'bad value' } },
  })).completion, { kind: 'throw', error: { kind: 'TypeError', message: 'bad value' } })
})

test('rejects malformed journal schemas exhaustively', () => {
  const invalid = [
    [null, /invalid dsh-ptc-plus journal/],
    [{}, /invalid dsh-ptc-plus journal/],
    [journal({ version: 999 }), /invalid dsh-ptc-plus journal/],
    [journal({ bindingPolicy: { variableRedeclarations: 'wide', functionClassRedeclarations: false } }), /binding policy/],
    [journal({ rewritePolicy: { autoRewriteImports: true } }), /rewrite policy/],
    [journal({ moduleSemantics: { defaultExportBinding: 'unknown' } }), /default export binding semantics/],
    [journal({ moduleSemantics: {} }), /binding semantics/],
    [journal({ userBindingsFingerprint: 'not-a-fingerprint' }), /user binding fingerprint/],
    [Object.fromEntries(Object.entries(journal()).filter(([key]) => key !== 'userBindingsFingerprint')), /user binding fingerprint/],
    [{ ...journal(), extra: true }, /journal field extra/],
    [journal({ calls: null }), /journal calls/],
    [journal({ calls: [{}] }), /journal call at index 0/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, settle: 0 }] }), /missing its value/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: false, settle: 0 }] }), /missing its error/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: false, error: 1, settle: 0 }] }), /missing its error/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, value: encodeValue(1), settle: -0 }] }), /journal call at index 0/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, value: encodeValue(1), settle: 1 }] }), /not contiguous/],
    [journal({ operations: null }), /journal operations/],
    [journal({ operations: [{}] }), /journal operation at index 0/],
    [journal({ operations: [{ action: 'save' }] }), /journal operation at index 0/],
    [journal({ operations: [{ action: 'restore', name: '' }] }), /journal operation at index 0/],
    [journal({ completion: undefined }), /journal completion/],
    [journal({ completion: null }), /journal completion/],
    [journal({ completion: { kind: 'return', hasValue: 'yes', value: encodeValue(1) } }), /journal return value/],
    [journal({ completion: { kind: 'return', hasValue: true } }), /journal return value/],
    [journal({ completion: { kind: 'return', hasValue: false, value: encodeValue(1) } }), /journal return value/],
    [journal({ completion: { kind: 'throw', error: null } }), /journal throw completion/],
    [journal({ completion: { kind: 'throw', error: { kind: 1, message: 'bad' } } }), /journal throw completion/],
    [journal({ confirms: 'call' }), /confirmed no-op/],
    [journal({ confirms: [-1] }), /confirmed no-op/],
    [journal({ confirms: [-0] }), /confirmed no-op/],
    [journal({ confirms: [1, 1] }), /duplicate/],
    [journal({ diagnostics: null }), /journal diagnostics/],
    [journal({ diagnostics: [{}] }), /journal diagnostic at index 0/],
    [Object.fromEntries(Object.entries(journal()).filter(([key]) => key !== 'diagnostics')), /journal diagnostics/],
    [journal({ status: 'discarded', calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, value: encodeValue(1), settle: 0 }], completion: undefined }), /must not contain/],
    [journal({ volatileReason: 42 }), /volatile reason/],
    [journal({ volatileReason: 'ambient Date' }), /requires volatile or discarded status/],
  ]
  for (const [value, expected] of invalid) assert.throws(() => normalizeJournal(value), expected)
})

test('creates journals, compares semantics, validates names, and merges metadata', () => {
  const policy = { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }
  assert.deepEqual(createJournal([4], 'strict', policy), {
    version: JOURNAL_VERSION,
    languageSemantics: 'legacy-v1',
    moduleTransform: LEGACY_USER_BINDING_TRANSFORM,
    bindingPolicy: { variableRedeclarations: false, functionClassRedeclarations: false },
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    moduleSemantics: { defaultExportBinding: 'live-readonly', importExpressionBoundary: 'statement-safe' },
    userBindingsFingerprint: null,
    userBindingsReusePolicy: 'implementation-v1',
    userBindingsShadowPolicy: 'per-name',
    userBindingNames: null,
    calls: [], operations: [], confirms: [4], diagnostics: [],
  })
  assert.throws(() => createJournal([], 'invalid', policy), /binding mode/)
  const value = journal()
  assert.equal(journalsEqual(value, structuredClone(value)), true)
  assert.equal(journalsEqual(value, journal({ status: 'volatile' })), false)
  assert.equal(journalsEqual(value, journal({ userBindingsReusePolicy: 'fingerprint-v1' })), false)
  assert.equal(journalsEqual(value, journal({ rewritePolicy: { ...value.rewritePolicy, autoStripExports: false } })), false)
  assert.equal(journalsEqual(value, null), false)
  assert.equal(assertStateName('A.state-1'), 'A.state-1')
  for (const name of ['', '.bad', 'bad/name', 'x'.repeat(65), 42]) {
    assert.throws(() => assertStateName(name), /REPL state name/)
  }

  assert.deepEqual(withJournal(undefined, value)[JOURNAL_KEY], normalizeJournal(value))
  assert.deepEqual(withJournal({ existing: true }, value).existing, true)
  assert.equal(withJournal('legacy', value).value, 'legacy')

  const rewrites = () => [
    { kind: 'import', description: 'converted static import of node:path', source: 'node:path' },
    { kind: 'redeclaration', description: 'split a mixed top-level declaration', source: 'r1' },
  ]
  assert.deepEqual(withRewrites(undefined, rewrites())[REWRITES_KEY], normalizeRewrites(rewrites()))
  assert.deepEqual(withRewrites({ existing: true }, rewrites()).existing, true)
  assert.equal(withRewrites('legacy', rewrites()).value, 'legacy')
  assert.deepEqual(normalizeRewrites([]), [])
  const invalidRewrites = [
    null, 'bad', [{ kind: 'import' }], [{ kind: 'other', description: 'x' }],
    [{ kind: 'import', description: '' }], [{ kind: 'import', description: 'x', source: 5 }],
    [{ kind: 'import', description: 'x', unknown: true }],
  ]
  for (const invalid of invalidRewrites) {
    assert.throws(() => normalizeRewrites(invalid), /rewrite/)
  }
})

test('requires a journal-bound user binding snapshot for run_code recovery', () => {
  const userBindings = createUserBindingsSnapshot({ entries: [] }, 7)
  const call = callEvent(1, 'bound-run', 'const bound = 1')
  const result = {
    seq: 2,
    type: 'tool/result',
    sourceEventSeqs: [1],
    data: { meta: {
      [JOURNAL_KEY]: journal({ userBindingsFingerprint: userBindings.fingerprint }),
      [USER_BINDINGS_META_KEY]: userBindings,
    } },
  }
  const recovered = recoverJournal({ events: [call, result] })
  assert.equal(pathToHead(recovered)[0].userBindings.fingerprint, userBindings.fingerprint)

  for (const mutate of [
    meta => { delete meta[USER_BINDINGS_META_KEY] },
    meta => { meta[JOURNAL_KEY].userBindingsFingerprint = '0'.repeat(64) },
    meta => { meta[JOURNAL_KEY].userBindingsFingerprint = null },
  ]) {
    const invalid = structuredClone(result)
    mutate(invalid.data.meta)
    const contracted = recoverJournal({ events: [call, invalid] })
    assert.deepEqual(pathToHead(contracted), [])
    assert.equal(contracted.available, false)
  }
})

test('contracts at PTC metadata on a non-REPL tool result instead of throwing', () => {
  const call = {
    seq: 0,
    type: 'tool/call',
    data: { name: 'read', callId: 'native-read', arguments: '{}' },
  }
  const result = {
    seq: 1,
    type: 'tool/result',
    data: {
      message: {
        role: 'user',
        source: { kind: 'tool', callId: 'native-read' },
        content: [{ type: 'tool-result', toolCallId: 'native-read', content: [] }],
      },
      meta: { [JOURNAL_KEY]: journal() },
    },
  }
  const recovered = recoverJournal({ events: [call, result] })
  assert.equal(recovered.available, false)
  assert.deepEqual(recovered.volatileSuffix.map(item => item.seq), [0])
  assert.match(recovered.volatileSuffix[0].reason, /non-REPL tool result/)
})

test('folds a recovery boundary from settled tool-result metadata', () => {
  const repeated = journal({
    operations: [
      { action: 'save', name: 'point' },
      { action: 'delete', name: 'old' },
    ],
  })
  const events = [
    callEvent(1, 'first', 'const first = 1'),
    resultEvent(1, repeated),
    callEvent(2, 'second', 'const second = 2'),
    resultEvent(2, repeated),
    callEvent(3, 'third', 'const third = 3'),
    resultEvent(3, journal({ operations: [{ action: 'save', name: 'descendant' }] })),
    callEvent(4, 'current', 'const current = 4'),
    (() => {
      const result = resultEvent(4, journal({ operations: [{ action: 'save', name: 'current' }] }))
      return {
        ...result,
        data: {
          meta: withRecoveryBoundaries(
            result.data.meta,
            [{ failedCallSeq: 2, frontierCallSeq: 1 }],
          ),
        },
      }
    })(),
  ]
  const session = { get events() { return Object.freeze([...events]) } }
  const recovered = recoverJournal(session)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const first = 1', 'const current = 4'])
  assert.deepEqual([...recovered.checkpoints.keys()], ['point', 'current'])
  assert.deepEqual(
    withRecoveryBoundaries(undefined, [{ failedCallSeq: 2, frontierCallSeq: 1 }])[RECOVERY_BOUNDARY_KEY],
    [{ failedCallSeq: 2, frontierCallSeq: 1 }],
  )
  assert.equal(recoveryBoundariesEqual(undefined, undefined), true)
  assert.equal(recoveryBoundariesEqual(undefined, []), false)
  assert.equal(recoveryBoundariesEqual(
    [{ failedCallSeq: 2, frontierCallSeq: 1 }],
    [{ failedCallSeq: 2, frontierCallSeq: 1 }],
  ), true)
  assert.equal(recoveryBoundariesEqual(
    [{ failedCallSeq: 2, frontierCallSeq: 1 }],
    [{ failedCallSeq: 3, frontierCallSeq: 1 }],
  ), false)
  assert.equal(recoveryBoundariesEqual('invalid', 'invalid'), false)
})

test('migrates retired recovery events without mutating the source log', () => {
  const source = [
    callEvent(0, 'failed', 'const failed = 1'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 0, frontierCallSeq: null } },
    callEvent(2, 'current', 'return 2'),
    {
      seq: 3,
      type: 'tool/result',
      sourceEventSeqs: [2],
      data: { meta: { [JOURNAL_KEY]: journal() } },
    },
  ]
  const migrated = migrateRecoveryBoundaryEvents(source)
  assert.equal(migrated.length, 3)
  assert.equal(migrated.some(event => event.type === RECOVERY_BOUNDARY_EVENT), false)
  assert.equal(migrated[1].seq, 1)
  assert.deepEqual(migrated[2].sourceEventSeqs, [1])
  assert.deepEqual(migrated[2].data.meta[RECOVERY_BOUNDARY_KEY], [{
    failedCallSeq: 0,
    frontierCallSeq: null,
  }])
  assert.equal(source.length, 4)
  assert.equal(source[1].type, RECOVERY_BOUNDARY_EVENT)
  assert.throws(
    () => migrateRecoveryBoundaryEvents(source.slice(0, 2)),
    /no later PTC journal result/,
  )
  assert.throws(
    () => migrateRecoveryBoundaryEvents([{
      seq: -1, type: RECOVERY_BOUNDARY_EVENT,
      data: { failedCallSeq: 0, frontierCallSeq: null },
    }]),
    /session event sequence/,
  )
  assert.throws(
    () => normalizeRecoveryBoundaries([{ failedCallSeq: 0, frontierCallSeq: null }], -1),
    /recovery boundary event sequence/,
  )
  for (const sequences of [
    [10, 11, 12, 13],
    [0, 1, 3, 4],
    [0, 2, 1, 3],
  ]) {
    assert.throws(() => migrateRecoveryBoundaryEvents([
      callEvent(sequences[0], 'damaged-failed', 'throw new Error("failed")'),
      { seq: sequences[1], type: RECOVERY_BOUNDARY_EVENT,
        data: { failedCallSeq: sequences[0], frontierCallSeq: null } },
      callEvent(sequences[2], 'damaged-carrier', 'return 1'),
      { ...resultEvent(sequences[2], journal()), seq: sequences[3] },
    ]), /not contiguous from zero/)
  }
})

test('recovery-boundary migration remaps every persisted event and PTC call relation', () => {
  const source = [
    callEvent(0, 'first', 'const first = 1'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 0, frontierCallSeq: null } },
    { ...resultEvent(0, journal()), seq: 2 },
    callEvent(3, 'noop', 'return first'),
    { seq: 4, type: 'tool/result', sourceEventSeqs: [3], data: { meta: {} } },
    callEvent(5, 'current', 'const current = 2'),
    { seq: 6, type: 'tool/result', sourceEventSeqs: [5], data: { meta: {
      [JOURNAL_KEY]: { version: 3, confirms: [3] },
      dshPtcPlusEdit: { targetCallSeq: 3 },
      [RECOVERY_BOUNDARY_KEY]: [{ failedCallSeq: 3, frontierCallSeq: 0 }],
    } } },
    { seq: 7, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 5, frontierCallSeq: 0 } },
    { seq: 8, type: 'tool/call', data: {
      name: 'edit_run_code', callId: 'edit', arguments: '{"edits":[]}',
    } },
    { seq: 9, type: 'tool/result', sourceEventSeqs: [8], data: { meta: {
      [JOURNAL_KEY]: journal(),
      dshPtcPlusEdit: { targetCallSeq: 5 },
    } } },
  ]
  const original = structuredClone(source)
  const migrated = migrateRecoveryBoundaryEvents(source)
  assert.deepEqual(source, original)
  assert.deepEqual(migrated.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(migrated.filter(event => event.type === 'tool/result').map(event => event.sourceEventSeqs),
    [[0], [2], [4], [6]])
  assert.deepEqual(migrated[1].data.meta[RECOVERY_BOUNDARY_KEY], [
    { failedCallSeq: 0, frontierCallSeq: null },
  ])
  assert.deepEqual(migrated[5].data.meta[JOURNAL_KEY].confirms, [2])
  assert.deepEqual(migrated[5].data.meta.dshPtcPlusEdit, { targetCallSeq: 2 })
  assert.deepEqual(migrated[5].data.meta[RECOVERY_BOUNDARY_KEY], [
    { failedCallSeq: 2, frontierCallSeq: 0 },
  ])
  assert.deepEqual(migrated[7].data.meta.dshPtcPlusEdit, { targetCallSeq: 4 })
  assert.deepEqual(migrated[7].data.meta[RECOVERY_BOUNDARY_KEY], [
    { failedCallSeq: 4, frontierCallSeq: 0 },
  ])

  const interleaved = migrateRecoveryBoundaryEvents([
    callEvent(0, 'failed-before-native', 'throw new Error("failed")'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 0, frontierCallSeq: null } },
    { seq: 2, type: 'tool/result', data: { meta: { [JOURNAL_KEY]: journal() } } },
    { seq: 3, type: 'tool/call', data: { name: 'read', callId: 'native', arguments: '{}' } },
    { seq: 4, type: 'tool/result', sourceEventSeqs: [3], data: {
      meta: { [JOURNAL_KEY]: journal() },
    } },
    callEvent(5, 'carrier', 'const recovered = true'),
    { ...resultEvent(5, journal()), seq: 6 },
  ])
  assert.equal(Object.hasOwn(interleaved[1].data.meta, RECOVERY_BOUNDARY_KEY), false)
  assert.equal(Object.hasOwn(interleaved[3].data.meta, RECOVERY_BOUNDARY_KEY), false)
  assert.deepEqual(interleaved[5].data.meta[RECOVERY_BOUNDARY_KEY], [
    { failedCallSeq: 0, frontierCallSeq: null },
  ])

  assert.throws(() => migrateRecoveryBoundaryEvents([
    callEvent(0, 'duplicate-a', 'return 1'),
    callEvent(0, 'duplicate-b', 'return 2'),
  ]), /duplicate session event sequence 0/)
  assert.throws(() => migrateRecoveryBoundaryEvents([{
    seq: 0, type: 'tool/result', sourceEventSeqs: [9], data: {},
  }]), /invalid source event reference 9/)
  assert.throws(() => migrateRecoveryBoundaryEvents([
    { seq: 0, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 1, frontierCallSeq: null } },
    callEvent(1, 'forward', 'return 1'),
    { seq: 2, type: 'tool/result', sourceEventSeqs: [1], data: {
      meta: { [JOURNAL_KEY]: journal() },
    } },
  ]), /unproved recovery-boundary failure call reference 1 at event 0/)

  assert.throws(() => migrateRecoveryBoundaryEvents([
    callEvent(0, 'frontier', 'return 0'),
    callEvent(1, 'failed', 'return 1'),
    { seq: 2, type: RECOVERY_BOUNDARY_EVENT,
      data: { failedCallSeq: 1, frontierCallSeq: 1 } },
    callEvent(3, 'carrier', 'return 3'),
    { ...resultEvent(3, journal()), seq: 4 },
  ]), /frontier must precede its failed call/)
})

test('recovery-boundary migration remaps host sequence relations as one closed operation', () => {
  const minimalData = (type, seq) => {
    if (type === 'command/done') return { sourceEventSeq: undefined }
    if (type === 'session/title') return { messageSeqs: [], source: { kind: 'user' } }
    if (type === 'session-log-deepseek/delivery-accepted') return { throughSeq: seq - 1 }
    if (type === 'session/title-llm-request') return { messageSeqs: [] }
    if (type === 'compaction/prune' || type === 'compaction/summary') {
      return { shadowedSeqs: [] }
    }
    return {}
  }
  const supportedVocabulary = [...RELEASED_V0_EVENT_TYPES]
    .map((type, seq) => ({ seq, type, data: minimalData(type, seq) }))
  assert.equal(migrateRecoveryBoundaryEvents(supportedVocabulary).length,
    RELEASED_V0_EVENT_TYPES.length)

  const source = [
    callEvent(0, 'failed', 'throw new Error("failed")'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT,
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    callEvent(2, 'current', 'const current = 2'),
    { ...resultEvent(2, journal()), seq: 3 },
    { seq: 4, type: 'assistant/message', data: { content: 'old surface' } },
    { seq: 5, type: 'compaction/prune', data: {
      shadowedSeqs: [3, 4],
      shadowedRange: { start: 3, end: 4 },
    } },
    { seq: 6, type: 'assistant/message', sourceEventSeqs: [3, 4],
      surfaceOp: { op: 'replace', start: 3, end: 4 }, data: { content: 'replacement' } },
    { seq: 7, type: 'user/message', surfaceOp: 'append',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'title source' }] } },
    { seq: 8, type: 'command/run', data: {
      commandId: 'migration-command', name: 'review', source: { kind: 'user' },
    } },
    { seq: 9, type: 'command/done', data: {
      commandId: 'migration-command', kind: 'success', sourceEventSeq: 7,
    } },
    { seq: 10, type: 'session/title', data: {
      title: 'Migrated title', messageSeqs: [7], source: { kind: 'fallback' },
    } },
    { seq: 11, type: 'compaction/summary', data: {
      compactionId: 'migration-summary', summary: [],
      shadowedSeqs: [6, 7], shadowedRange: { start: 6, end: 7 },
      shadowedTokenCount: 0, provider: 'fixture', model: 'fixture',
    } },
  ]

  const migrated = migrateRecoveryBoundaryEvents(source)
  assert.deepEqual(migrated.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(migrated[2].sourceEventSeqs, [1])
  assert.deepEqual(migrated[4].data.shadowedSeqs, [2, 3])
  assert.deepEqual(migrated[4].data.shadowedRange, { start: 2, end: 3 })
  assert.deepEqual(migrated[5].sourceEventSeqs, [2, 3])
  assert.deepEqual(migrated[5].surfaceOp, { op: 'replace', start: 2, end: 3 })
  assert.equal(migrated[8].data.sourceEventSeq, 6)
  assert.equal(migrated[migrated[8].data.sourceEventSeq].type, 'user/message')
  assert.deepEqual(migrated[9].data.messageSeqs, [6])
  assert.equal(migrated[migrated[9].data.messageSeqs[0]].type, 'user/message')
  assert.deepEqual(migrated[10].data.shadowedSeqs, [5, 6])
  assert.deepEqual(migrated[10].data.shadowedRange, { start: 5, end: 6 })
  assert.deepEqual(source[5].data.shadowedSeqs, [3, 4])
  assert.deepEqual(source[6].surfaceOp, { op: 'replace', start: 3, end: 4 })
  assert.equal(source[9].data.sourceEventSeq, 7)
  assert.deepEqual(source[10].data.messageSeqs, [7])
  assert.deepEqual(source[11].data.shadowedRange, { start: 6, end: 7 })

  const withRelation = (relation) => [
    callEvent(0, 'failed', 'return 0'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT,
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    callEvent(2, 'carrier', 'return 2'),
    { ...resultEvent(2, journal()), seq: 3 },
    relation,
  ]
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'compaction/prune',
    data: { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 } },
  })), /shadow range does not match the current surface/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'assistant/message',
    surfaceOp: { op: 'replace', start: 2, end: 99 },
  })), /invalid surface replacement end event reference 99/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'command/done',
    data: { commandId: 'removed-source', kind: 'success', sourceEventSeq: 1 },
  })), /unmapped command source event reference 1/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'session/title',
    data: { title: 'Removed', messageSeqs: [1], source: { kind: 'fallback' } },
  })), /must cite earlier human user\/message events/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'compaction/summary',
    data: { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 } },
  })), /shadow range does not match the current surface/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'future/required-event',
    data: { relatedSeq: 2 },
  })), /unsupported session event type "future\/required-event"/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'assistant/message',
    surfaceOp: { op: 'unknown' },
  })), /invalid surface operation/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'session/title',
    data: { title: 'Malformed', messageSeqs: 'invalid', source: { kind: 'fallback' } },
  })), /invalid session\/title message references/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'compaction/summary',
    data: { shadowedSeqs: 'invalid' },
  })), /invalid compaction\/summary shadow references/)
  assert.throws(() => migrateRecoveryBoundaryEvents(withRelation({
    seq: 4,
    type: 'compaction/prune',
    data: { shadowedSeqs: [2], shadowedRange: 'invalid' },
  })), /invalid compaction\/prune shadow range/)

  const withTail = tail => migrateRecoveryBoundaryEvents([
    callEvent(0, 'relation-failed', 'return 0'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT,
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    callEvent(2, 'relation-carrier', 'return 2'),
    { ...resultEvent(2, journal()), seq: 3 },
    ...tail,
  ])
  assert.throws(() => withTail([
    { seq: 4, type: 'assistant/message', sourceEventSeqs: [5], surfaceOp: 'append', data: {} },
    { seq: 5, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' } } },
  ]), /invalid source event reference 5 at event 4/)
  assert.throws(() => withTail([
    { seq: 4, type: 'assistant/message', sourceEventSeqs: [3, 3], surfaceOp: 'append', data: {} },
  ]), /duplicate source event reference 3/)
  assert.throws(() => withTail([
    { seq: 4, type: 'assistant/message', sourceEventSeqs: [],
      surfaceOp: { op: 'replace', start: 3, end: 3 }, data: {} },
  ]), /does not cite every replaced surface node/)
  assert.throws(() => withTail([
    { seq: 4, type: 'assistant/message', sourceEventSeqs: [3],
      surfaceOp: { op: 'replace', start: 3, end: 3 }, data: {} },
    { seq: 5, type: 'assistant/message', sourceEventSeqs: [3],
      surfaceOp: { op: 'replace', start: 3, end: 3 }, data: {} },
  ]), /does not identify a current ordered surface range/)
  assert.throws(() => withTail([
    { seq: 4, type: 'command/done', data: {
      commandId: 'failed-command', kind: 'error', sourceEventSeq: 3,
    } },
  ]), /source outside a successful result/)
  assert.throws(() => withTail([
    { seq: 4, type: 'command/run', data: { commandId: 'nested-command' } },
    { seq: 5, type: 'command/done', data: {
      commandId: 'nested-command', kind: 'success', sourceEventSeq: 4,
    } },
  ]), /cites a command lifecycle event/)
  assert.throws(() => withTail([
    { seq: 4, type: 'session/title', data: {
      title: 'Invalid source', messageSeqs: [3], source: { kind: 'fallback' },
    } },
  ]), /must cite earlier human user\/message events/)
  assert.throws(() => migrateRecoveryBoundaryEvents([
    callEvent(0, 'failed-relation', 'return 0'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT,
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    callEvent(2, 'relation-carrier', 'return 2'),
    { ...resultEvent(2, journal()), seq: 3 },
    { seq: 4, type: 'turn/end', data: {
      turn: 1, reason: { kind: 'completed' }, relatedEventSeq: 2,
    } },
  ]), /unsupported turn\/end data sequence relation "relatedEventSeq"/u)
  assert.throws(() => withTail([
    { seq: 4, type: 'session/title', data: {
      title: 'Missing automatic source', messageSeqs: [], source: { kind: 'provider' },
    } },
  ]), /cite at least one message seq/)
  assert.throws(() => withTail([
    { seq: 4, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' } } },
    { seq: 5, type: 'session/title', data: {
      title: 'Explicit rename with source', messageSeqs: [4], source: { kind: 'user' },
    } },
  ]), /cite no message seqs/)
  assert.throws(() => withTail([
    { seq: 4, type: 'assistant/message', surfaceOp: 'append', data: {} },
    { seq: 5, type: 'tool/result', sourceEventSeqs: [4],
      surfaceOp: { op: 'replace', start: 4, end: 4 }, data: {} },
  ]), /tool\/result surface replacement must target one current tool\/result/)
  const originalResultData = {
    message: { content: [{ type: 'tool-result', toolCallId: 'replace-result', content: 'before' }] },
    meta: { stable: true },
  }
  const contentOnlyReplacement = withTail([
    { seq: 4, type: 'tool/result', surfaceOp: 'append', data: originalResultData },
    { seq: 5, type: 'tool/result', sourceEventSeqs: [4],
      surfaceOp: { op: 'replace', start: 4, end: 4 }, data: {
        ...originalResultData,
        message: { content: [{ type: 'tool-result', toolCallId: 'replace-result', content: 'after' }] },
      } },
  ])
  assert.equal(contentOnlyReplacement.at(-1).data.message.content[0].content, 'after')
  assert.throws(() => withTail([
    { seq: 4, type: 'tool/result', surfaceOp: 'append', data: originalResultData },
    { seq: 5, type: 'tool/result', sourceEventSeqs: [4],
      surfaceOp: { op: 'replace', start: 4, end: 4 }, data: {
        ...originalResultData,
        message: { content: [{ type: 'tool-result', toolCallId: 'replace-result', content: 'after' }] },
        meta: { stable: false },
      } },
  ]), /may change only content/)
  assert.throws(() => withTail([
    { seq: 4, type: 'tool/result', surfaceOp: 'append', data: originalResultData },
    { seq: 5, type: 'tool/result', sourceEventSeqs: [4],
      surfaceOp: { op: 'replace', start: 4, end: 4 }, data: { meta: { stable: true } } },
  ]), /invalid message content/)
  assert.throws(() => withTail([
    { seq: 4, type: 'compaction/prune', data: {
      shadowedSeqs: [3, 3], shadowedRange: { start: 3, end: 3 },
    } },
  ]), /duplicate compaction shadow event reference 3/)
  assert.throws(() => withTail([
    { seq: 4, type: 'compaction/prune', data: { shadowedSeqs: [2] } },
  ]), /shadow list does not match the current surface/)
  assert.throws(() => withTail([
    { seq: 4, type: 'assistant/message', sourceEventSeqs: [3],
      surfaceOp: { op: 'replace', start: 3, end: 3, extra: true }, data: {} },
  ]), /invalid surface operation/)
  assert.throws(() => withTail([
    { seq: 4, type: 'command/run', sourceEventSeqs: [3], data: {} },
  ]), /is not surface-eligible/)
  assert.throws(() => withTail([
    { seq: 4, type: 'user/message', sourceEventSeqs: [], surfaceOp: 'append', data: {} },
  ]), /must not be empty except on assistant\/message/)
  const noRangeCompaction = withTail([
    { seq: 4, type: 'compaction/prune', data: { shadowedSeqs: [3] } },
  ])
  assert.deepEqual(noRangeCompaction.at(-1).data.shadowedSeqs, [2])
})

test('handles every released host relation and rejects malformed relation data with its own diagnostic', () => {
  const titlePreserved = [
    { seq: 0, type: 'user/message', surfaceOp: 'append',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { seq: 1, type: 'session/title-llm-request', data: {
      messages: [{ role: 'user', source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        content: [{ type: 'text', text: '{}' }] }],
      messageSeqs: [0],
    } },
    callEvent(2, 'failed', 'throw new Error("failed")'),
    { seq: 3, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 2, frontierCallSeq: null } },
    callEvent(4, 'current', 'return 2'),
    { ...resultEvent(4, journal()), seq: 5 },
  ]
  const migrated = migrateRecoveryBoundaryEvents(titlePreserved)
  assert.deepEqual(
    migrated.find(event => event.type === 'session/title-llm-request').data.messageSeqs,
    [0],
  )

  assert.throws(() => migrateRecoveryBoundaryEvents([
    callEvent(0, 'failed', 'throw new Error("failed")'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 0, frontierCallSeq: null } },
    { seq: 2, type: 'user/message', surfaceOp: 'append',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { seq: 3, type: 'session/title-llm-request', data: { messageSeqs: [2] } },
    callEvent(4, 'current', 'return 2'),
    { ...resultEvent(4, journal()), seq: 5 },
  ]), /session\/title-llm-request messageSeqs cannot be preserved/)

  const delivery = migrateRecoveryBoundaryEvents([
    callEvent(0, 'failed', 'throw new Error("failed")'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 0, frontierCallSeq: null } },
    { seq: 2, type: 'user/message', surfaceOp: 'append',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { seq: 3, type: 'session-log-deepseek/delivery-accepted',
      data: { sessionId: 'session', throughSeq: 2 } },
    callEvent(4, 'current', 'return 2'),
    { ...resultEvent(4, journal()), seq: 5 },
  ])
  assert.equal(
    delivery.find(event => event.type === 'session-log-deepseek/delivery-accepted').data.throughSeq,
    1,
  )

  assert.throws(() => migrateRecoveryBoundaryEvents([
    callEvent(0, 'failed', 'throw new Error("failed")'),
    { seq: 1, type: RECOVERY_BOUNDARY_EVENT, data: { failedCallSeq: 0, frontierCallSeq: null } },
    callEvent(2, 'current', 'return 2'),
    { ...resultEvent(2, journal()), seq: 3 },
    { seq: 4, type: 'command/done', data: null },
  ]), /command\/done event 4 has invalid data/)

  assert.throws(() => migrateRecoveryBoundaryEvents([
    { seq: 0, type: 'session/title-llm-request', data: { messageSeqs: 'invalid' } },
  ]), /invalid session\/title-llm-request message references/)
  assert.throws(() => migrateRecoveryBoundaryEvents([
    callEvent(0, 'not-a-message', 'return 1'),
    { seq: 1, type: 'session/title-llm-request', data: { messageSeqs: [0] } },
  ]), /must cite earlier user\/message events/)
  assert.throws(() => migrateRecoveryBoundaryEvents([
    { seq: 0, type: 'session-log-deepseek/delivery-accepted', data: null },
  ]), /delivery-accepted event 0 has invalid data/)
})

test('resolves the unique unpaired live named tool call event', () => {
  const events = [
    callEvent(1, 'reused', 'return 1'),
    resultEvent(1, journal()),
    callEvent(3, 'reused', 'return 2'),
    { seq: 4, type: 'tool/call', data: { name: 'read', callId: 'reused', arguments: '{}' } },
  ]
  assert.equal(liveToolCallSeq({ events }, 'reused', 'run_code'), 3)
  assert.equal(liveToolCallSeq({ events }, 'absent', 'run_code'), undefined)
  assert.equal(liveToolCallSeq(undefined, 'reused', 'run_code'), undefined)
  assert.equal(liveToolCallSeq({ events }, undefined, 'run_code'), undefined)
  assert.equal(liveToolCallSeq({ events }, 'reused', undefined), undefined)

  events.push({
    seq: 5,
    type: 'tool/call',
    data: { name: 'edit_run_code', callId: 'edit', arguments: '{"edits":[]}' },
  })
  assert.equal(liveToolCallSeq({ events }, 'edit', 'edit_run_code'), 5)

  assert.throws(() => liveToolCallSeq({ events: [
    callEvent(1, 'ambiguous', 'return 1'),
    callEvent(2, 'ambiguous', 'return 2'),
  ] }, 'ambiguous', 'run_code'), /multiple unpaired run_code calls/)

  const malformed = callEvent(-1, 'malformed', 'return 1')
  assert.throws(
    () => liveToolCallSeq({ events: [malformed] }, 'malformed', 'run_code'),
    /invalid session event sequence/,
  )

  for (const toolName of ['run_code', 'edit_run_code']) {
    const reused = `${toolName}-reused`
    const toolCall = (seq, argumentsValue) => ({
      seq,
      type: 'tool/call',
      data: { name: toolName, callId: reused, arguments: argumentsValue },
    })
    const damagedHistory = [
      toolCall(0, toolName === 'run_code' ? '{"code":"return 1"}' : '{"edits":[]}'),
      {
        seq: 1,
        type: 'tool/result',
        sourceEventSeqs: [-0],
        data: { message: { source: { kind: 'tool', callId: reused } } },
      },
      toolCall(2, toolName === 'run_code' ? '{"code":"return 2"}' : '{"edits":[]}'),
    ]
    assert.equal(liveToolCallSeq({ events: damagedHistory }, reused, toolName), 2)
  }

  for (const sourceEventSeqs of [[0, 99], [0, 0]]) {
    assert.throws(() => liveToolCallSeq({ events: [
      callEvent(0, 'malformed-multi-source', 'return 1'),
      callEvent(1, 'malformed-multi-source', 'return 2'),
      {
        seq: 2,
        type: 'tool/result',
        sourceEventSeqs,
        data: { message: { source: { callId: 'malformed-multi-source' } } },
      },
    ] }, 'malformed-multi-source', 'run_code'), /multiple unpaired run_code calls/)
  }

  const sourcedCall = (seq, callId, name, argumentsValue) => [
    { seq, type: 'assistant/message', data: { message: { content: [{
      type: 'tool-call', id: callId, name, arguments: argumentsValue,
    }] } } },
    { seq: seq + 1, type: 'tool/call', data: { callId, name, arguments: argumentsValue } },
  ]
  for (const [toolName, historicalArguments, currentArguments] of [
    ['run_code', { code: 'return 1', description: 'historical' }, { code: 'return 42', description: 'current' }],
    ['edit_run_code', { edits: [], description: 'historical' }, { edits: [], description: 'current' }],
  ]) {
    const callId = `missing-result-identity-${toolName}`
    const historicalRaw = JSON.stringify(historicalArguments)
    const currentRaw = JSON.stringify(currentArguments)
    for (const sourceEventSeqs of [[-0], [1, 99]]) {
      const eventsWithMissingIdentity = [
        ...sourcedCall(0, callId, toolName, historicalRaw),
        { seq: 2, type: 'tool/result', sourceEventSeqs, data: {} },
        ...sourcedCall(3, callId, toolName, currentRaw),
      ]
      assert.equal(liveToolCallSeq(
        { events: eventsWithMissingIdentity }, callId, toolName,
      ), 4)
    }

    const indistinguishable = [
      ...sourcedCall(0, callId, toolName, historicalRaw),
      { seq: 2, type: 'tool/result', sourceEventSeqs: [-0], data: {} },
      ...sourcedCall(3, callId, toolName, currentRaw),
    ]
    indistinguishable[3].data.message.content.push({
      ...indistinguishable[3].data.message.content[0],
    })
    assert.throws(
      () => liveToolCallSeq({ events: indistinguishable }, callId, toolName),
      new RegExp(`multiple unpaired ${toolName} calls`),
    )
  }
})

test('reads the current snapshotEvents session API and keeps the legacy events fallback', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    callEvent(1, 'current-api', 'return 1'),
    resultEvent(1, journal()),
    callEvent(3, 'current-api', 'return 2'),
  ]
  const current = {
    snapshotEvents: () => Object.freeze([...events]),
  }
  assert.equal(liveToolCallSeq(current, 'current-api', 'run_code'), 3)
  assert.equal(projectSessionLog({ session: current }).latestRun.callSeq, 1)
  assert.equal(recoverJournal(current).nodes.length, 1)
  assert.equal(liveToolCallSeq({ events }, 'current-api', 'run_code'), 3)
})

test('intersects recovery with the model-visible executable surface', () => {
  const events = [
    callEvent(0, 'visible', 'const visible = 1'),
    { ...resultEvent(0, journal()), seq: 1 },
    callEvent(2, 'hidden', 'const hidden = 2'),
    { ...resultEvent(2, journal()), seq: 3 },
  ]
  const session = {
    events,
    surface: { nodes: [1, 3], replaceGeneration: 0 },
  }
  const visible = visibleExecutableCallSeqs(session)
  assert.deepEqual([...visible], [])
  const resultOnly = recoverJournal(session, undefined, { visibleCallSeqs: visible })
  assert.deepEqual(pathToHead(resultOnly), [])
  assert.equal(resultOnly.available, false)
  const contracted = recoverJournal(session, undefined, { visibleCallSeqs: new Set([0]) })
  assert.deepEqual(pathToHead(contracted).map(node => node.code), ['const visible = 1'])
  assert.equal(contracted.available, false)
  assert.equal(contracted.volatileSuffix[0].seq, 2)
  const assistantSurface = {
    events: [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'visible' }] } } }],
    surface: { nodes: [0] },
  }
  assert.deepEqual([...visibleExecutableCallSeqs(assistantSurface)], [])
  const visibleRelation = (name, argumentsValue, block = {}) => ({
    events: [
      { seq: 0, type: 'assistant/message', data: { message: { content: [{
        type: 'tool-call', id: 'exact', name, arguments: argumentsValue, ...block,
      }] } } },
      { seq: 1, type: 'tool/call', data: {
        callId: 'exact', name, arguments: argumentsValue,
      } },
    ],
    surface: { nodes: [0] },
  })
  const runArguments = JSON.stringify({ code: 'return 1' })
  const editArguments = JSON.stringify({ edits: [] })
  assert.deepEqual([...visibleExecutableCallSeqs(
    visibleRelation('run_code', runArguments),
  )], [1])
  assert.deepEqual([...visibleExecutableCallSeqs(
    visibleRelation('edit_run_code', editArguments),
  )], [1])
  const currentHostSurface = visibleRelation('run_code', runArguments)
  currentHostSurface.events.push(
    { seq: 2, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'system' }] } } },
    { seq: 3, type: 'developer/message', data: { message: { content: [{ type: 'text', text: 'developer' }] } } },
  )
  currentHostSurface.surface.nodes.push(2, 3)
  assert.deepEqual([...visibleExecutableCallSeqs(currentHostSurface)], [1])
  for (const malformed of [
    visibleRelation('run_code', runArguments, { name: 'read' }),
    visibleRelation('run_code', runArguments, { arguments: JSON.stringify({ code: 'return 2' }) }),
    visibleRelation('run_code', runArguments, { arguments: undefined }),
    {
      events: [
        { seq: 0, type: 'assistant/message', data: { message: { content: [
          { type: 'tool-call', id: 'exact', name: 'run_code', arguments: runArguments },
          { type: 'tool-call', id: 'exact', name: 'run_code', arguments: runArguments },
        ] } } },
        { seq: 1, type: 'tool/call', data: {
          callId: 'exact', name: 'run_code', arguments: runArguments,
        } },
      ],
      surface: { nodes: [0] },
    },
  ]) assert.deepEqual([...visibleExecutableCallSeqs(malformed)], [])
  const reusedCallId = {
    events: [
      { seq: 0, type: 'turn/start' },
      { seq: 1, type: 'assistant/message', data: { message: { content: [{
        type: 'tool-call', id: 'reused', name: 'run_code',
        arguments: JSON.stringify({ code: 'const hiddenOld = 1' }),
      }] } } },
      callEvent(2, 'reused', 'const hiddenOld = 1'),
      { ...resultEvent(2, journal()), seq: 3 },
      { seq: 4, type: 'turn/end' },
      { seq: 5, type: 'turn/start' },
      { seq: 6, type: 'assistant/message', data: { message: { content: [{
        type: 'tool-call', id: 'reused', name: 'run_code',
        arguments: JSON.stringify({ code: 'const visibleNew = 2' }),
      }] } } },
      callEvent(7, 'reused', 'const visibleNew = 2'),
      { ...resultEvent(7, journal()), seq: 8 },
    ],
    surface: { nodes: [6, 8] },
  }
  assert.deepEqual([...visibleExecutableCallSeqs(reusedCallId)], [7])
  const reusedContracted = recoverJournal(reusedCallId, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(reusedCallId),
  })
  assert.equal(reusedContracted.available, false)
  assert.deepEqual(pathToHead(reusedContracted), [])
  assert.equal(reusedContracted.volatileSuffix[0].seq, 2)
  assert.deepEqual([...visibleExecutableCallSeqs({ events: [], surface: { nodes: [1] }})], [])
  assert.deepEqual([...visibleExecutableCallSeqs({ events, surface: { nodes: [0] } })], [])
  assert.deepEqual([...visibleExecutableCallSeqs({ events, surface: { nodes: [1, 1] } })], [])
  assert.deepEqual([...visibleExecutableCallSeqs({
    events: [{ ...events[0], seq: 0 }, { ...events[1], seq: 0 }],
    surface: { nodes: [0] },
  })], [])
})

test('resumes a durable prefix after a volatile historical cell', () => {
  const state = recoverJournal({ events: [
    callEvent(0, 'volatile', 'Date.now()'),
    resultEvent(0, journal({ status: 'volatile', volatileReason: 'Date.now()' })),
    callEvent(2, 'durable', 'const afterVolatile = 2'),
    resultEvent(2, journal()),
  ] })
  assert.deepEqual(pathToHead(state).map(node => node.code), ['const afterVolatile = 2'])
})

test('handles surface capability failure and ordered recovery boundaries', () => {
  const unavailableSurface = {
    events: [callEvent(0, 'hidden', 'const hidden = 9'), { ...resultEvent(0, journal()), seq: 1 }],
    get surface() { throw new Error('no surface') },
  }
  const visible = visibleExecutableCallSeqs(unavailableSurface)
  assert.deepEqual([...visible], [])
  const hidden = recoverJournal(unavailableSurface, undefined, { visibleCallSeqs: visible })
  assert.deepEqual(pathToHead(hidden), [])
  assert.equal(hidden.available, false)
  assert.match(hidden.volatileSuffix[0].reason, /model-visible provenance was shadowed/u)
  const first = resultEvent(0, journal())
  first.seq = 1
  first.data.meta[RECOVERY_BOUNDARY_KEY] = [{ failedCallSeq: 0, frontierCallSeq: null }]
  const later = resultEvent(2, journal())
  later.seq = 3
  const recovered = recoverJournal({ events: [callEvent(0, 'first', 'const first = 1'), first, callEvent(2, 'later', 'const later = 2'), later] })
  assert.deepEqual(pathToHead(recovered), [])
  assert.equal(recovered.available, false)
  assert.match(recovered.volatileSuffix[0].reason, /outside the verified frontier/u)
  const acknowledgedResult = resultEvent(0, { version: 3 })
  acknowledgedResult.seq = 1
  acknowledgedResult.data.meta[RECOVERY_BOUNDARY_KEY] = [{ failedCallSeq: 0, frontierCallSeq: null }]
  const acknowledged = recoverJournal({ events: [callEvent(0, 'bad', 'const bad = 1'), acknowledgedResult] })
  assert.equal(acknowledged.available, false)
})

test('contracts malformed recovery boundaries at the greatest proved prefix', () => {
  const recoveredWith = (boundary) => {
    const carrier = { ...resultEvent(4, journal()), seq: 5 }
    carrier.data.meta[RECOVERY_BOUNDARY_KEY] = [boundary]
    return recoverJournal({ events: [
      callEvent(0, 'first', 'const first = 1'),
      { ...resultEvent(0, journal()), seq: 1 },
      callEvent(2, 'second', 'const second = 2'),
      { ...resultEvent(2, journal()), seq: 3 },
      callEvent(4, 'carrier', 'const carrier = 4'),
      carrier,
    ] })
  }

  const wrongParent = recoveredWith({ failedCallSeq: 0, frontierCallSeq: 2 })
  assert.deepEqual(pathToHead(wrongParent), [])
  assert.equal(wrongParent.available, false)
  assert.match(wrongParent.volatileSuffix[0].reason, /frontier does not match/u)

  const missing = recoveredWith({ failedCallSeq: 1, frontierCallSeq: 0 })
  assert.deepEqual(pathToHead(missing).map(node => node.callSeq), [0])
  assert.equal(missing.available, false)
  assert.match(missing.volatileSuffix[0].reason, /earlier executable call/u)

  const future = recoveredWith({ failedCallSeq: 10, frontierCallSeq: 2 })
  assert.deepEqual(pathToHead(future).map(node => node.callSeq), [0, 2])
  assert.equal(future.available, false)
  assert.match(future.volatileSuffix[0].reason, /earlier executable call/u)
})

test('retires malformed recovery boundaries through their executable carrier', () => {
  for (const { malformedBoundary, missingResult, expectedPrefix, expectedBoundary } of [
    {
      malformedBoundary: { failedCallSeq: 1, frontierCallSeq: null },
      missingResult: false,
      expectedPrefix: [0],
      expectedBoundary: { failedCallSeq: 4, frontierCallSeq: 0 },
    },
    {
      malformedBoundary: { failedCallSeq: 2, frontierCallSeq: null },
      missingResult: false,
      expectedPrefix: [0],
      expectedBoundary: { failedCallSeq: 4, frontierCallSeq: 0 },
    },
    {
      malformedBoundary: { failedCallSeq: 1, frontierCallSeq: null },
      missingResult: true,
      expectedPrefix: [0],
      expectedBoundary: { failedCallSeq: 2, frontierCallSeq: 0 },
    },
    {
      malformedBoundary: { failedCallSeq: 0, frontierCallSeq: 2 },
      missingResult: true,
      expectedPrefix: [],
      expectedBoundary: { failedCallSeq: 2, frontierCallSeq: null },
    },
  ]) {
    const carrier = { ...resultEvent(4, journal()), seq: 5 }
    carrier.data.meta[RECOVERY_BOUNDARY_KEY] = [malformedBoundary]
    const events = [
      callEvent(0, 'stable', 'const stable = 1'),
      { ...resultEvent(0, journal()), seq: 1 },
      callEvent(2, 'discarded', 'const discarded = 2'),
      ...(missingResult ? [] : [{ ...resultEvent(2, journal()), seq: 3 }]),
      callEvent(4, 'carrier', 'const carrier = 4'),
      carrier,
    ]

    const first = recoverJournal({ events })
    assert.equal(first.available, false)
    assert.deepEqual(pathToHead(first).map(node => node.callSeq), expectedPrefix)
    assert.equal(first.volatileSuffix[0].seq, expectedBoundary.failedCallSeq)
    const boundary = recoveryBoundaryForHistory(first)
    assert.deepEqual(boundary, expectedBoundary)

    const current = { ...resultEvent(6, journal()), seq: 7 }
    current.data.meta[RECOVERY_BOUNDARY_KEY] = [boundary]
    events.push(callEvent(6, 'current', 'const current = 6'), current)
    const recovered = recoverJournal({ events })
    assert.equal(recovered.available, true)
    assert.deepEqual(pathToHead(recovered).map(node => node.callSeq), [...expectedPrefix, 6])
    assert.deepEqual(recovered.volatileSuffix, [])
  }
})

test('keeps delayed historical settlements inside an applied recovery contraction', () => {
  const carrier = { ...resultEvent(6, journal()), seq: 7 }
  carrier.data.meta[RECOVERY_BOUNDARY_KEY] = [{ failedCallSeq: 2, frontierCallSeq: 0 }]
  const recovered = recoverJournal({ events: [
    callEvent(0, 'stable', 'const stable = 0'),
    { ...resultEvent(0, journal()), seq: 1 },
    callEvent(2, 'missing', 'const missing = 2'),
    callEvent(4, 'delayed', 'const delayed = missing + 2'),
    callEvent(6, 'carrier', 'const carrier = 6'),
    carrier,
    { ...resultEvent(4, journal()), seq: 8 },
  ] })

  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.callSeq), [0, 6])
  assert.deepEqual(recovered.volatileSuffix, [])
})

test('ties a recovery contraction to its exact carrier when result sequences collide', () => {
  const carrier = { ...resultEvent(6, journal()), seq: 7 }
  carrier.data.meta[RECOVERY_BOUNDARY_KEY] = [{ failedCallSeq: 2, frontierCallSeq: 0 }]
  const recovered = recoverJournal({ events: [
    callEvent(0, 'stable', 'const stable = 0'),
    { ...resultEvent(0, journal()), seq: 1 },
    callEvent(2, 'missing', 'const missing = 2'),
    callEvent(4, 'delayed', 'const delayed = missing + 2'),
    callEvent(5, 'colliding', 'const colliding = missing + 3'),
    { ...resultEvent(5, journal()), seq: 7 },
    callEvent(6, 'carrier', 'const carrier = 6'),
    carrier,
    { ...resultEvent(4, journal()), seq: 8 },
  ] })

  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.callSeq), [0, 6])
  assert.deepEqual(recovered.volatileSuffix, [])
})

test('rejects a recovery boundary carried before its failed call', () => {
  const carrier = { ...resultEvent(2, journal()), seq: 5 }
  carrier.data.meta[RECOVERY_BOUNDARY_KEY] = [{ failedCallSeq: 4, frontierCallSeq: 0 }]
  const recovered = recoverJournal({ events: [
    callEvent(0, 'stable', 'const stable = 0'),
    { ...resultEvent(0, journal()), seq: 1 },
    callEvent(2, 'carrier', 'const carrier = 2'),
    callEvent(4, 'missing', 'const missing = 4'),
    carrier,
    callEvent(6, 'dependent', 'const dependent = missing + 2'),
    { ...resultEvent(6, journal()), seq: 7 },
  ] })

  assert.equal(recovered.available, false)
  assert.deepEqual(pathToHead(recovered).map(node => node.callSeq), [0])
  assert.match(recovered.volatileSuffix[0].reason, /carrier does not follow/u)
})

test('rejects conflicting sequence and call-id result identities', () => {
  const pairedResult = (seq, sourceSeq, callId, meta) => ({
    seq,
    type: 'tool/result',
    sourceEventSeqs: [sourceSeq],
    data: { message: { source: { callId } }, meta },
  })
  const matching = recoverJournal({ events: [
    callEvent(0, 'matching', 'const matching = 1'),
    pairedResult(1, 0, 'matching', { [JOURNAL_KEY]: journal() }),
  ] })
  assert.deepEqual(pathToHead(matching).map(node => node.callSeq), [0])

  const conflict = recoverJournal({ events: [
    callEvent(0, 'first', 'const first = 1'),
    callEvent(2, 'other', 'const other = 2'),
    pairedResult(3, 0, 'other', { [JOURNAL_KEY]: journal() }),
  ] })
  assert.deepEqual(pathToHead(conflict), [])
  assert.equal(conflict.available, false)
  assert.match(conflict.volatileSuffix[0].reason, /identities disagree/u)

  const editMeta = {
    [JOURNAL_KEY]: journal(),
    dshPtcPlusEdit: { targetCallSeq: 0 },
    dshPtcPlusDerivedRun: { code: 'base = 2', description: 'edit base' },
  }
  const editConflict = recoverJournal({ events: [
    callEvent(0, 'base', 'let base = 1'),
    pairedResult(1, 0, 'base', { [JOURNAL_KEY]: journal() }),
    { seq: 2, type: 'tool/call', data: { name: 'edit_run_code', callId: 'edit', arguments: '{"edits":[]}' } },
    pairedResult(3, 2, 'base', editMeta),
  ] })
  assert.deepEqual(pathToHead(editConflict).map(node => node.callSeq), [0])
  assert.equal(editConflict.available, false)
  assert.match(editConflict.volatileSuffix.at(-1).reason, /identities disagree/u)

  const confirmer = journal({ confirms: [0] })
  const conflictWithoutJournal = recoverJournal({ events: [
    callEvent(0, 'unsettled', 'const mustStayUnavailable = 1'),
    pairedResult(1, 0, 'other', undefined),
    callEvent(2, 'confirmer', 'const mustNotConfirmConflict = 2'),
    pairedResult(3, 2, 'confirmer', { [JOURNAL_KEY]: confirmer }),
  ] })
  assert.deepEqual(pathToHead(conflictWithoutJournal), [])
  assert.equal(conflictWithoutJournal.available, false)
  assert.match(conflictWithoutJournal.volatileSuffix[0].reason, /identities disagree/u)

  const duplicateOrdinaryResult = recoverJournal({ events: [
    callEvent(0, 'duplicated', 'const duplicated = 1'),
    pairedResult(1, 0, 'duplicated', undefined),
    pairedResult(2, 0, 'duplicated', { [JOURNAL_KEY]: journal() }),
  ] })
  assert.deepEqual(pathToHead(duplicateOrdinaryResult), [])
  assert.equal(duplicateOrdinaryResult.available, false)
  assert.match(duplicateOrdinaryResult.volatileSuffix[0].reason, /duplicate ordinary tool results/u)

  const malformedLaterRelation = recoverJournal({ events: [
    callEvent(0, 'settled-before-malformed', 'const settledBeforeMalformed = 1'),
    pairedResult(1, 0, 'settled-before-malformed', { [JOURNAL_KEY]: journal() }),
    {
      seq: 2,
      type: 'tool/result',
      sourceEventSeqs: ['invalid', 0],
      data: { message: { source: { callId: 'unrelated-result' } } },
    },
  ] })
  assert.deepEqual(pathToHead(malformedLaterRelation), [])
  assert.equal(malformedLaterRelation.available, false)
  assert.match(malformedLaterRelation.volatileSuffix[0].reason, /invalid source relation/u)
})

test('uses call identity only when historical result provenance is absent', () => {
  const legacyResult = {
    seq: 1,
    type: 'tool/result',
    data: {
      message: { source: { callId: 'legacy-result' } },
      meta: { [JOURNAL_KEY]: journal() },
    },
  }
  const legacy = recoverJournal({ events: [
    callEvent(0, 'legacy-result', 'const legacyResult = 1'),
    legacyResult,
  ] })
  assert.deepEqual(pathToHead(legacy).map(node => node.callSeq), [0])

  for (const sourceEventSeqs of [[-0], [-1], ['0'], [], [0, 0]]) {
    const malformed = recoverJournal({ events: [
      callEvent(0, 'malformed-result', 'const malformedResult = 1'),
      { ...legacyResult, sourceEventSeqs, data: {
        ...legacyResult.data,
        message: { source: { callId: 'malformed-result' } },
      } },
    ] })
    assert.deepEqual(pathToHead(malformed), [])
    assert.equal(malformed.available, false)
    assert.equal(malformed.volatileSuffix[0].seq, 0)
    assert.match(malformed.volatileSuffix[0].reason, /invalid source relation/u)
  }
})

test('requires one complete target-linked relation for derived edit replay', () => {
  const runCall = callEvent(1, 'run', 'let edited = 1')
  const editCall = {
    seq: 3,
    type: 'tool/call',
    data: { name: 'edit_run_code', callId: 'edit', arguments: '{"edits":[]}' },
  }
  const derivedMeta = {
    [JOURNAL_KEY]: journal(),
    dshPtcPlusEdit: { targetCallSeq: 1 },
    dshPtcPlusDerivedRun: { code: 'edited = 2', description: 'derived edit' },
  }
  const events = [
    { seq: 0, type: 'turn/start', data: {} },
    runCall,
    { ...resultEvent(1, journal()), seq: 2 },
    editCall,
    {
      seq: 4,
      type: 'tool/result',
      sourceEventSeqs: [3],
      data: { meta: derivedMeta },
    },
  ]
  assert.deepEqual(pathToHead(recoverJournal({ events })).map(node => node.code), [
    'let edited = 1',
    'edited = 2',
  ])
  assert.equal(normalizeDerivedEditResult(derivedMeta, 1).targetCallSeq, 1)
  assert.throws(() => normalizeDerivedEditResult({
    ...structuredClone(derivedMeta),
    dshPtcPlusEdit: { targetCallSeq: -0 },
  }, 0), /target does not match/u)
  assert.equal(derivedEditResultsEqual(derivedMeta, structuredClone(derivedMeta), 1), true)
  for (const mutate of [
    meta => { meta.dshPtcPlusDerivedRun.code = 'edited = 3' },
    meta => { meta.dshPtcPlusDerivedRun.description = 'changed description' },
    meta => { meta[JOURNAL_KEY].status = 'volatile' },
  ]) {
    const changed = structuredClone(derivedMeta)
    mutate(changed)
    assert.equal(derivedEditResultsEqual(derivedMeta, changed, 1), false)
  }
  assert.equal(derivedEditResultsEqual(derivedMeta, {}, 1), false)
  assert.equal(derivedEditResultsEqual(derivedMeta, {
    ...structuredClone(derivedMeta),
    [REWRITES_KEY]: {},
  }, 1), true)

  const boundaryDerivedMeta = {
    ...structuredClone(derivedMeta),
    [RECOVERY_BOUNDARY_KEY]: [{ failedCallSeq: 1, frontierCallSeq: null }],
  }
  assert.deepEqual(normalizeDerivedEditResult(boundaryDerivedMeta, 1).recoveryBoundaries, [
    { failedCallSeq: 1, frontierCallSeq: null },
  ])
  assert.equal(derivedEditResultsEqual(boundaryDerivedMeta, structuredClone(boundaryDerivedMeta), 1), true)
  const changedBoundary = structuredClone(boundaryDerivedMeta)
  changedBoundary[RECOVERY_BOUNDARY_KEY][0].failedCallSeq = 2
  assert.equal(derivedEditResultsEqual(boundaryDerivedMeta, changedBoundary, 1), false)
  assert.equal(derivedEditResultsEqual(derivedMeta, {
    ...structuredClone(derivedMeta),
    [REWRITES_KEY]: [{ kind: 'export', description: 'changed rewrite' }],
  }, 1), true)

  const userBindings = createUserBindingsSnapshot({ entries: [] }, 7)
  const boundDerivedMeta = {
    ...structuredClone(derivedMeta),
    [JOURNAL_KEY]: journal({ userBindingsFingerprint: userBindings.fingerprint }),
    [USER_BINDINGS_META_KEY]: userBindings,
  }
  assert.equal(
    normalizeDerivedEditResult(boundDerivedMeta, 1).userBindings.fingerprint,
    userBindings.fingerprint,
  )
  for (const mutate of [
    meta => { delete meta[USER_BINDINGS_META_KEY] },
    meta => { meta[JOURNAL_KEY].userBindingsFingerprint = '0'.repeat(64) },
    meta => { meta[JOURNAL_KEY].userBindingsFingerprint = null },
  ]) {
    const invalid = structuredClone(boundDerivedMeta)
    mutate(invalid)
    assert.throws(() => normalizeDerivedEditResult(invalid, 1), /user binding/)
    assert.equal(derivedEditResultsEqual(boundDerivedMeta, invalid, 1), false)
  }

  const invalidRewriteEvents = structuredClone(events)
  invalidRewriteEvents[4].data.meta[REWRITES_KEY] = {}
  assert.deepEqual(pathToHead(recoverJournal({ events: invalidRewriteEvents })).map(node => node.code), [
    'let edited = 1',
    'edited = 2',
  ])

  for (const mutate of [
    meta => { delete meta.dshPtcPlusEdit },
    meta => { meta.dshPtcPlusEdit = { targetCallSeq: 99 } },
    meta => { meta.dshPtcPlusEdit = { targetCallSeq: 1, extra: true } },
    meta => { meta.dshPtcPlusDerivedRun = { code: 'edited = 2' } },
  ]) {
    const invalidEvents = structuredClone(events)
    mutate(invalidEvents[4].data.meta)
    const recovered = recoverJournal({ events: invalidEvents })
    assert.deepEqual(pathToHead(recovered).map(node => node.code), ['let edited = 1'])
    assert.equal(recovered.volatileSuffix.length, 1)
  }

  const nextTurn = structuredClone(events)
  nextTurn.splice(3, 0, { type: 'turn/start', data: {} })
  const recovered = recoverJournal({ events: nextTurn })
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['let edited = 1'])
  assert.equal(recovered.volatileSuffix.length, 1)
})

test('validates derived edit targets from settlements visible at dispatch', () => {
  const pairedResult = (seq, sourceSeq, callId, meta) => ({
    seq,
    type: 'tool/result',
    sourceEventSeqs: [sourceSeq],
    data: { message: { source: { callId } }, meta },
  })
  const editCall = (seq, callId = 'edit') => ({
    seq,
    type: 'tool/call',
    data: { name: 'edit_run_code', callId, arguments: '{"edits":[]}' },
  })
  const derivedMeta = {
    [JOURNAL_KEY]: journal(),
    dshPtcPlusEdit: { targetCallSeq: 1 },
    dshPtcPlusDerivedRun: { code: 'const a = 2', description: 'edit A' },
  }
  const overlapping = [
    { seq: 0, type: 'turn/start', data: {} },
    callEvent(1, 'a', 'const a = 1'),
    callEvent(2, 'b', 'const b = 2'),
    pairedResult(3, 1, 'a', { [JOURNAL_KEY]: journal() }),
    editCall(4),
    pairedResult(5, 2, 'b', { [JOURNAL_KEY]: journal() }),
    pairedResult(6, 4, 'edit', derivedMeta),
  ]

  const recovered = recoverJournal({ events: overlapping })
  assert.deepEqual(pathToHead(recovered).map(node => node.code), [
    'const a = 1',
    'const b = 2',
    'const a = 2',
  ])
  assert.deepEqual(recovered.volatileSuffix, [])
  const projected = projectSessionLog({ session: { events: overlapping } })
  assert.equal(projected.latestRun.source, 'const a = 2')
  assert.equal(projected.editableRun.callSeq, 4)

  const premature = [
    { seq: 0, type: 'turn/start', data: {} },
    callEvent(1, 'a', 'const a = 1'),
    editCall(2),
    pairedResult(3, 1, 'a', { [JOURNAL_KEY]: journal() }),
    pairedResult(4, 2, 'edit', derivedMeta),
  ]
  const rejected = recoverJournal({ events: premature })
  assert.deepEqual(pathToHead(rejected).map(node => node.code), ['const a = 1'])
  assert.equal(rejected.volatileSuffix.length, 1)
  assert.equal(projectSessionLog({ session: { events: premature } }).editableRun.source, 'const a = 1')

  const secondDerivedMeta = structuredClone(derivedMeta)
  secondDerivedMeta.dshPtcPlusDerivedRun.code = 'const a = 3'
  const duplicateTarget = [
    { seq: 0, type: 'turn/start', data: {} },
    callEvent(1, 'a', 'const a = 1'),
    pairedResult(2, 1, 'a', { [JOURNAL_KEY]: journal() }),
    editCall(3, 'edit-first'),
    editCall(4, 'edit-second'),
    pairedResult(5, 4, 'edit-second', secondDerivedMeta),
    pairedResult(6, 3, 'edit-first', derivedMeta),
  ]
  const duplicateRejected = recoverJournal({ events: duplicateTarget })
  assert.deepEqual(pathToHead(duplicateRejected).map(node => node.code), [
    'const a = 1',
    'const a = 2',
  ])
  assert.equal(duplicateRejected.available, false)
  assert.match(duplicateRejected.volatileSuffix[0].reason, /eligible target call/)
  const duplicateView = projectSessionLog({ session: { events: duplicateTarget } })
  assert.equal(duplicateView.latestRun.source, 'const a = 2')
  assert.equal(duplicateView.editableRun.callSeq, 3)
})

test('folds delayed derived edits in persisted settlement order', () => {
  const derivedMeta = {
    [JOURNAL_KEY]: journal(),
    dshPtcPlusEdit: { targetCallSeq: 1 },
    dshPtcPlusDerivedRun: { code: 'order.push(3)', description: 'delayed edit' },
  }
  const events = [
    { seq: 0, type: 'turn/start', data: {} },
    callEvent(1, 'target', 'const order = [1]'),
    { ...resultEvent(1, journal()), seq: 2 },
    {
      seq: 3,
      type: 'tool/call',
      data: { name: 'edit_run_code', callId: 'edit', arguments: '{"edits":[]}' },
    },
    callEvent(4, 'later', 'order.push(4)'),
    { ...resultEvent(4, journal()), seq: 5 },
    {
      seq: 6,
      type: 'tool/result',
      sourceEventSeqs: [3],
      data: { message: { source: { callId: 'edit' } }, meta: derivedMeta },
    },
  ]

  assert.deepEqual(pathToHead(recoverJournal({ events })).map(node => node.code), [
    'const order = [1]',
    'order.push(4)',
    'order.push(3)',
  ])
})

test('uses event sequences when provider call ids repeat', () => {
  const prior = journal()
  const confirmer = journal({ confirms: [4] })
  const events = [
    callEvent(1, 'reused', 'const prior = 1'),
    resultEvent(1, prior),
    callEvent(3, 'reused', 'return prior'),
    callEvent(4, 'reused', 'never entered runtime'),
    callEvent(9, 'confirmer', 'const confirmed = true'),
    resultEvent(9, confirmer),
  ]
  const recovered = recoverJournal({ events }, 3)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const prior = 1', 'const confirmed = true'])
  assert.equal(recovered.volatileSuffix.length, 0)
  assert.equal(recovered.nodes[0].callId, undefined)
  assert.equal(recovered.nodes[0].callSeq, 1)
})

test('versions binding reuse without admitting missing, unknown or backdated policies', () => {
  for (const version of [1, 2, 3, 4, 5]) {
    const legacy = journal({ version })
    const normalized = normalizeJournal(legacy)
    assert.equal(normalized.version, JOURNAL_VERSION)
    assert.equal(normalized.userBindingsReusePolicy, 'fingerprint-v1')
    assert.deepEqual(normalizeJournal(normalized), normalized)
    assert.throws(() => normalizeJournal({ ...legacy, userBindingsReusePolicy: 'implementation-v1' }), /journal field userBindingsReusePolicy/)
  }
  const fingerprint = 'a'.repeat(64)
  assert.equal(normalizeJournal(journal({ version: 5, userBindingsFingerprint: fingerprint })).userBindingsFingerprint, fingerprint)
  const missing = journal()
  delete missing.userBindingsReusePolicy
  for (const invalid of [missing, ...[null, 1, {}, 'implementation-v2'].map(userBindingsReusePolicy => journal({ userBindingsReusePolicy }))]) {
    assert.throws(() => normalizeJournal(invalid), /user binding reuse policy/)
    const history = recoverJournal({ events: [
      callEvent(1, 'known', 'const known = 1'),
      resultEvent(1, journal()),
      callEvent(3, 'unknown', 'const unknown = 2'),
      resultEvent(3, invalid),
    ] })
    assert.deepEqual(pathToHead(history).map(node => node.code), ['const known = 1'])
    assert.equal(history.volatileSuffix.length, 1)
  }
})

test('versions import-expression boundaries without backdating current lowering semantics', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const historical = journal({ version })
    const normalized = normalizeJournal(historical)
    assert.equal(normalized.version, JOURNAL_VERSION)
    assert.equal(normalized.moduleSemantics.importExpressionBoundary, 'legacy')
    assert.equal(normalized.userBindingsReusePolicy, version === 6 ? 'implementation-v1' : 'fingerprint-v1')
    assert.deepEqual(normalizeJournal(normalized), normalized)
    if (version >= 4) {
      assert.throws(() => normalizeJournal({
        ...historical,
        moduleSemantics: { ...historical.moduleSemantics, importExpressionBoundary: 'statement-safe' },
      }), /module semantics field importExpressionBoundary/)
      assert.throws(() => normalizeJournal({ ...historical, moduleSemantics: null }), /module semantics/)
    }
  }
  assert.equal(normalizeJournal(journal()).moduleSemantics.importExpressionBoundary, 'statement-safe')
  for (const importExpressionBoundary of [undefined, null, false, 'unknown']) {
    assert.throws(() => normalizeJournal(journal({
      moduleSemantics: { defaultExportBinding: 'live-readonly', importExpressionBoundary },
    })), /import expression boundary semantics/)
  }
  assert.throws(() => normalizeJournal(journal({
    moduleSemantics: { defaultExportBinding: 'live-readonly' },
  })), /import expression boundary semantics/)
  assert.equal(journalsEqual(journal(), journal({
    moduleSemantics: { defaultExportBinding: 'live-readonly', importExpressionBoundary: 'legacy' },
  })), false)
})

test('records a closed language generation and migrates old cells without reinterpreting their source', () => {
  for (const version of JOURNAL_VERSIONS) {
    const historical = journal({ version })
    assert.equal(normalizeJournal(historical).languageSemantics, 'legacy-v1')
    if (version < LANGUAGE_SEMANTICS_JOURNAL_VERSION) {
      assert.throws(() => normalizeJournal({ ...historical, languageSemantics: 'stateful-v1' }), /journal field/)
    }
  }
  for (const [languageSemantics, moduleTransform] of [
    ['legacy-v1', LEGACY_USER_BINDING_TRANSFORM],
    ['stateful-v1', USER_BINDING_TRANSFORM],
    ['protected-v1', PROTECTED_MODULE_TRANSFORM],
  ]) {
    const normalized = normalizeJournal(journal({ languageSemantics, moduleTransform }))
    assert.equal(normalized.languageSemantics, languageSemantics)
    assert.deepEqual(normalizeJournal(normalized), normalized)
  }
  for (const languageSemantics of [undefined, null, 'unknown', {}, true]) {
    assert.throws(() => normalizeJournal(journal({ languageSemantics })), /language semantics/)
  }
  assert.equal(journalsEqual(journal({ languageSemantics: 'stateful-v1' }), journal()), false)
})

test('records the exact module transform and freezes version 9 language mappings', () => {
  for (const [languageSemantics, historicalTransform, currentTransform] of [
    ['legacy-v1', LEGACY_USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM],
    ['stateful-v1', PREVIOUS_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM],
    ['protected-v1', PROTECTED_MODULE_TRANSFORM, PROTECTED_MODULE_TRANSFORM],
  ]) {
    const historical = journal({ version: LANGUAGE_SEMANTICS_JOURNAL_VERSION, languageSemantics })
    const normalized = normalizeJournal(historical)
    assert.equal(normalized.moduleTransform, historicalTransform)
    assert.deepEqual(normalizeJournal(normalized), normalized)

    const current = normalizeJournal(journal({ languageSemantics, moduleTransform: currentTransform }))
    assert.equal(current.moduleTransform, currentTransform)
  }
  assert.throws(() => normalizeJournal(journal({ moduleTransform: 'unknown' })), /module transform/)
  assert.throws(() => normalizeJournal(journal({
    languageSemantics: 'legacy-v1', moduleTransform: USER_BINDING_TRANSFORM,
  })), /does not match/)
  assert.throws(() => normalizeJournal({
    ...journal({ version: LANGUAGE_SEMANTICS_JOURNAL_VERSION }),
    moduleTransform: PREVIOUS_USER_BINDING_TRANSFORM,
  }), /journal field moduleTransform/)
})

test('records per-name shadow evidence without changing any historical whole-entry generation', () => {
  for (const version of JOURNAL_VERSIONS) {
    const recorded = journal({ version })
    const normalized = normalizeJournal(recorded)
    assert.equal(normalized.userBindingsShadowPolicy,
      version < PER_NAME_USER_BINDINGS_JOURNAL_VERSION ? 'whole-entry' : 'per-name')
    assert.deepEqual(normalized.userBindingNames,
      version < PER_NAME_USER_BINDINGS_JOURNAL_VERSION ? null : [])
    assert.deepEqual(normalizeJournal(normalized), normalized)
    if (version < PER_NAME_USER_BINDINGS_JOURNAL_VERSION) {
      for (const extra of [{ userBindingsShadowPolicy: 'per-name' }, { userBindingNames: [] }]) {
        assert.throws(() => normalizeJournal({ ...recorded, ...extra }), /journal field/)
      }
    }
  }
  for (const status of ['durable', 'volatile', 'noop', 'discarded']) {
    const historical = journal({ status, userBindingsShadowPolicy: 'whole-entry', userBindingNames: null })
    assert.equal(normalizeJournal(historical).userBindingNames, null)
    assert.throws(() => normalizeJournal({ ...historical, userBindingNames: [] }), /unexpected user binding name evidence/)
    const current = journal({ status })
    assert.deepEqual(normalizeJournal(current).userBindingNames,
      ['noop', 'discarded'].includes(status) ? null : [])
    assert.throws(() => normalizeJournal({ ...current,
      userBindingNames: ['noop', 'discarded'].includes(status) ? [] : null,
    }), /user binding name evidence/)
  }
  for (const value of [undefined, null, false, 'entry', 'per-name-v2']) {
    assert.throws(() => normalizeJournal(journal({ userBindingsShadowPolicy: value })), /shadow policy/)
  }
  for (const field of ['userBindingsShadowPolicy', 'userBindingNames']) {
    const missing = journal()
    delete missing[field]
    assert.throws(() => normalizeJournal(missing), /user binding (shadow policy|name evidence)/)
  }
})

test('normalizes closed unique name facts and distinguishes source changes under identical void completions', () => {
  const facts = [
    { name: 'beta', state: 'provider', entryId: 'pair' },
    { name: 'alpha', state: 'local' },
    { name: 'removed', state: 'absent' },
    { name: 'uncertain', state: 'unknown' },
    { name: '值', state: 'provider', entryId: 'unicode' },
  ]
  const recorded = journal({ userBindingNames: facts, completion: { kind: 'return', hasValue: false } })
  const normalized = normalizeJournal(recorded)
  assert.deepEqual(normalized.userBindingNames.map(fact => fact.name), ['alpha', 'beta', 'removed', 'uncertain', '值'])
  assert.ok(Object.isFrozen(normalized.userBindingNames))
  assert.ok(normalized.userBindingNames.every(Object.isFrozen))
  assert.notEqual(normalized.userBindingNames[1], facts[0])
  assert.equal(journalsEqual(recorded, { ...recorded, userBindingNames: [...facts].reverse() }), true)
  for (const replacement of [
    { name: 'beta', state: 'local' },
    { name: 'beta', state: 'absent' },
    { name: 'beta', state: 'unknown' },
    { name: 'beta', state: 'provider', entryId: 'other' },
  ]) {
    assert.equal(journalsEqual(recorded, { ...recorded, userBindingNames: [replacement, ...facts.slice(1)] }), false)
  }
  const hiddenField = Object.defineProperty({ name: 'alpha', state: 'local' }, 'extra', { value: true })
  const nonEnumerableName = Object.defineProperty({ state: 'local' }, 'name', { value: 'alpha' })
  for (const invalid of [
    undefined, null, {}, [null], [1], [{}], [facts[0], facts[0]],
    [{ name: '', state: 'local' }], [{ name: '1invalid', state: 'local' }],
    [{ name: 'x'.repeat(129), state: 'local' }], [{ name: 'alpha', state: 'missing' }],
    [{ name: 'alpha', state: 'provider' }], [{ name: 'alpha', state: 'provider', entryId: '' }],
    [{ name: 'alpha', state: 'provider', entryId: 1 }],
    [{ name: 'alpha', state: 'provider', entryId: 'x'.repeat(65) }],
    [{ name: 'alpha', state: 'local', entryId: 'pair' }],
    [{ name: 'alpha', state: 'absent', value: undefined }],
    [{ name: 'alpha', state: 'unknown', [Symbol('extra')]: true }],
    [hiddenField], [nonEnumerableName],
  ]) assert.throws(() => normalizeUserBindingNames(invalid), /invalid user binding name evidence/)
})

test('requires complete name evidence tied to the full activated snapshot before recovering history', () => {
  const snapshot = createUserBindingsSnapshot({ entries: [
    { id: 'pair', name: 'pair', scope: 'top-level', enabled: true, source: 'export const alpha = 1; export const beta = 2' },
    { id: 'box', name: 'box', scope: 'namespace', enabled: true, source: 'export const value = 3' },
  ] }, 1)
  const validFacts = [
    { name: 'alpha', state: 'local' },
    { name: 'beta', state: 'provider', entryId: 'pair' },
    { name: 'box', state: 'provider', entryId: 'box' },
  ]
  const recorded = journal({ userBindingsFingerprint: snapshot.fingerprint, userBindingNames: validFacts })
  const meta = { [USER_BINDINGS_META_KEY]: snapshot, [JOURNAL_KEY]: recorded }
  assert.deepEqual(userBindingsForJournal(meta, normalizeJournal(recorded)), snapshot)
  assert.deepEqual(snapshot.entries.find(entry => entry.id === 'pair').symbols, ['alpha', 'beta'])
  for (const state of ['local', 'absent', 'unknown']) {
    assert.deepEqual(userBindingsForJournal(meta, normalizeJournal({ ...recorded,
      userBindingNames: validFacts.map(fact => fact.name === 'alpha' ? { name: 'alpha', state } : fact),
    })), snapshot)
  }
  for (const userBindingNames of [
    [], validFacts.slice(1),
    validFacts.map(fact => fact.name === 'beta' ? { ...fact, entryId: 'box' } : fact),
    [...validFacts, { name: 'value', state: 'provider', entryId: 'box' }],
  ]) {
    const invalid = { ...recorded, userBindingNames }
    assert.throws(() => userBindingsForJournal(meta, normalizeJournal(invalid)), /user binding name evidence/)
    const invalidResult = resultEvent(2, invalid)
    invalidResult.data.meta[USER_BINDINGS_META_KEY] = snapshot
    const recovered = recoverJournal({ events: [
      callEvent(0, 'anchor', 'const anchor = 1'), resultEvent(0, journal()),
      callEvent(2, 'unproved', 'const saved = beta'), invalidResult,
      callEvent(4, 'dependent', 'const dependent = saved'), resultEvent(4, journal()),
    ] })
    assert.equal(recovered.available, false)
    assert.deepEqual(pathToHead(recovered).map(node => node.callSeq), [0])
    assert.deepEqual(recoveryBoundaryForHistory(recovered), { failedCallSeq: 2, frontierCallSeq: 0 })
  }
  assert.throws(() => userBindingsForJournal({}, normalizeJournal(journal({
    userBindingNames: [{ name: 'alpha', state: 'provider', entryId: 'pair' }],
  }))), /matching provider/)
})

test('migrates predecessor journals and only unambiguous legacy call identities', () => {
  const relationless = normalizeJournal(journal({ version: 4 }))
  assert.equal(relationless.version, JOURNAL_VERSION)
  assert.equal(relationless.userBindingsFingerprint, null)
  const legacy = journal({
    version: 1,
    confirms: [],
  })
  delete legacy.rewritePolicy
  assert.deepEqual(normalizeJournal(legacy), {
    version: JOURNAL_VERSION,
    languageSemantics: 'legacy-v1',
    moduleTransform: LEGACY_USER_BINDING_TRANSFORM,
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: false },
    rewritePolicy: { autoRewriteImports: false, autoStripExports: false, autoSplitRedeclarations: false },
    moduleSemantics: { defaultExportBinding: 'legacy-variable', importExpressionBoundary: 'legacy' },
    userBindingsFingerprint: null,
    userBindingsReusePolicy: 'fingerprint-v1',
    userBindingsShadowPolicy: 'whole-entry',
    userBindingNames: null,
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: completion(),
  })
  const legacyV2 = journal({ version: 2 })
  legacyV2.bindingMode = 'loose'
  delete legacyV2.bindingPolicy
  assert.deepEqual(normalizeJournal(legacyV2).moduleSemantics, {
    defaultExportBinding: 'legacy-variable',
    importExpressionBoundary: 'legacy',
  })
  assert.throws(
    () => normalizeJournal(journal({ version: 1, confirms: ['legacy-call-id'] })),
    /session call identity/,
  )
  const legacyConfirmation = journal({ version: 1, confirms: ['legacy-call-id'] })
  delete legacyConfirmation.rewritePolicy
  assert.throws(
    () => normalizeJournal(legacyConfirmation),
    /session call identity/,
  )
  const invalidLegacyConfirmation = journal({ version: 1, confirms: [42] })
  delete invalidLegacyConfirmation.rewritePolicy
  assert.throws(
    () => normalizeJournal(invalidLegacyConfirmation),
    /confirmed no-op/,
  )
  const duplicateMappedConfirmation = journal({ version: 1, confirms: ['first', 'second'] })
  delete duplicateMappedConfirmation.rewritePolicy
  assert.throws(
    () => normalizeJournal(duplicateMappedConfirmation, { resolveLegacyConfirm: () => 7 }),
    /duplicate/,
  )
  assert.throws(
    () => normalizeJournal(journal({ version: 2, confirms: ['legacy-call-id'] })),
    /confirmed no-op/,
  )
})

test('recovers a version 1 journal and converts its unique predecessor confirmation', () => {
  const events = [
    callEvent(1, 'legacy-noop', 'never entered runtime'),
    { type: 'tool/result', sourceEventSeqs: [1], data: { meta: {} } },
    callEvent(2, 'legacy-cell', 'const restored = 42'),
    {
      type: 'tool/result',
      sourceEventSeqs: [2],
      data: { meta: { [JOURNAL_KEY]: {
        version: 1,
        bindingMode: 'loose',
        status: 'durable',
        calls: [],
        operations: [{ action: 'save', name: 'legacy-point' }],
        confirms: ['legacy-noop'],
        diagnostics: [],
        completion: completion(),
      } } },
    },
  ]
  const recovered = recoverJournal({ events })
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const restored = 42'])
  assert.equal(recovered.checkpoints.get('legacy-point'), 0)
  assert.equal(recovered.nodes[0].journal.rewritePolicy.autoRewriteImports, false)
})

test('rejects an ambiguous predecessor call-id confirmation without guessing', () => {
  const legacy = {
    version: 1,
    bindingMode: 'loose',
    status: 'durable',
    calls: [],
    operations: [],
    confirms: ['reused'],
    diagnostics: [],
    completion: completion(),
  }
  const events = [
    callEvent(1, 'reused', 'first missing journal'),
    { type: 'tool/result', sourceEventSeqs: [1], data: { meta: {} } },
    callEvent(2, 'reused', 'second missing journal'),
    { type: 'tool/result', sourceEventSeqs: [2], data: { meta: {} } },
    callEvent(3, 'legacy-cell', 'return 3'),
    resultEvent(3, legacy),
  ]
  const recovered = recoverJournal({ events })
  assert.match(recovered.volatileSuffix.at(-1).reason, /missing dsh-ptc-plus journal result/)
  assert.equal(recovered.head, undefined)
})

test('recovers durable branches, checkpoints, volatile suffixes, and confirmed no-ops', () => {
  const events = [
    callEvent(1, 'one', 'const one = 1'),
    resultEvent(1, journal({ operations: [{ action: 'save', name: 'one' }] })),
    callEvent(2, 'volatile', 'Date.now()'),
    resultEvent(2, journal({ status: 'volatile', operations: [{ action: 'restore', name: 'one' }], volatileReason: 'ambient Date' })),
    callEvent(3, 'discarded', 'discarded()'),
    resultEvent(3, journal({ status: 'discarded', completion: undefined })),
    callEvent(4, 'noop', 'noop()'),
    resultEvent(4, journal({ status: 'noop', completion: undefined })),
    callEvent(5, 'two', 'const two = 2'),
    resultEvent(5, journal({ operations: [{ action: 'delete', name: 'one' }] })),
    callEvent(6, 'confirmed', 'never ran'),
    callEvent(99, 'confirmer', 'const confirmed = true'),
    resultEvent(99, journal({ confirms: [6] })),
  ]
  const state = recoverJournal({ events })
  assert.equal(state.available, true)
  assert.deepEqual(pathToHead(state).map(node => node.code), ['const one = 1', 'const two = 2', 'const confirmed = true'])
  assert.deepEqual([...state.checkpoints], [])
  assert.deepEqual(state.volatileSuffix, [])

  const absent = recoverJournal()
  assert.deepEqual(absent, { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true })
  assert.equal(recoverJournal({ events }, 5).nodes.length, 2)
})

test('reduces ordered state operations independently of live and cold side effects', () => {
  const nodes = [
    { parent: undefined },
    { parent: 0 },
    { parent: 1 },
  ]
  const transition = reduceStateOperations({
    nodes,
    head: 1,
    checkpoints: new Map([['detached', 0], ['delete-me', 1]]),
  }, [
    { action: 'save', name: 'current' },
    { action: 'restore', name: 'detached' },
    { action: 'delete', name: 'delete-me' },
    { action: 'save', name: 'after-restore' },
    { action: 'restore' },
  ], 2)
  assert.deepEqual(transition, {
    head: 1,
    checkpoints: new Map([['detached', 0], ['current', 2], ['after-restore', 2]]),
    restored: true,
  })
  assert.throws(
    () => reduceStateOperations({ nodes, head: 1, checkpoints: new Map() }, [{ action: 'save', name: 'bad' }]),
    /volatile journal cannot save/,
  )
  assert.throws(
    () => reduceStateOperations({ nodes, head: 1, checkpoints: new Map() }, [{ action: 'restore', name: 'missing' }], 2),
    /restores unknown REPL state/,
  )
})

test('rejects confirmation sequences that are not earlier unjournaled run_code calls', () => {
  const otherTool = { seq: 4, type: 'tool/call', data: { name: 'read', callId: 'other', arguments: '{}' } }
  for (const events of [[
    otherTool,
    callEvent(5, 'confirmer', 'return 1'),
    resultEvent(5, journal({ confirms: [4] })),
  ], [
    callEvent(1, 'settled', 'return 1'),
    resultEvent(1, journal()),
    callEvent(2, 'confirmer', 'return 2'),
    resultEvent(2, journal({ confirms: [1] })),
  ], [
    callEvent(1, 'confirmer', 'return 1'),
    resultEvent(1, journal({ confirms: [2] })),
    callEvent(2, 'future', 'return 2'),
  ]]) {
    const recovered = recoverJournal({ events })
    assert.equal(recovered.available, false)
    assert.match(recovered.volatileSuffix.at(-1).reason, /earlier unjournaled run_code/)
  }

  const unavailable = recoverJournal({ events: [
    { type: 'tool/result', sourceEventSeqs: [7], data: { meta: { dshPtcPlus: journal() } } },
  ] })
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.volatileSuffix[0].seq, 7)

  const ambiguous = recoverJournal({ events: [
    callEvent(7, 'first', 'return 1'),
    callEvent(7, 'second', 'return 2'),
  ] })
  assert.equal(ambiguous.available, false)
  assert.deepEqual(pathToHead(ambiguous), [])
  assert.equal(ambiguous.volatileSuffix[0].seq, 7)
  assert.deepEqual(recoveryBoundaryForHistory(ambiguous), { failedCallSeq: 7, frontierCallSeq: null })
})

test('ignores pruned journal-result clones while retaining fail-closed corruption detection', () => {
  const original = callEvent(2747, 'call_00_x', 'const s = 1')
  const prunedClone = {
    ...resultEvent(2748, journal({ version: 3, bindingMode: 'loose' })),
    seq: 563467,
    data: {
      ...resultEvent(2748, journal({ version: 3, bindingMode: 'loose' })).data,
      message: { source: { callId: 'call_00_x' } },
    },
  }
  const events = [
    original,
    { seq: 563466, type: 'compaction/prune', data: { shadowedSeqs: [2748] } },
    prunedClone,
    callEvent(900, 'call_00_cur', 'return 2'),
  ]
  const recovered = recoverJournal({ events }, 900)
  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const s = 1'])

  const ghost = recoverJournal({ events: [
    { type: 'tool/result', sourceEventSeqs: [555], data: { meta: { [JOURNAL_KEY]: journal() } } },
  ] })
  assert.equal(ghost.available, false)
  assert.equal(ghost.volatileSuffix[0].seq, 555)
})

test('accepts a host-valid content-only replacement with the shadowed result present', () => {
  const originalData = {
    message: {
      id: 'message-a',
      role: 'user',
      source: { kind: 'tool', callId: 'call_a' },
      content: [{ type: 'tool-result', toolCallId: 'call_a', content: 'before' }],
    },
    meta: { [JOURNAL_KEY]: journal() },
  }
  const replacementData = {
    ...structuredClone(originalData),
    message: {
      ...structuredClone(originalData.message),
      content: [{ type: 'tool-result', toolCallId: 'call_a', content: 'after' }],
    },
  }
  const events = [
    callEvent(0, 'call_a', 'const a = 1'),
    { seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: structuredClone(originalData) },
    { seq: 2, type: 'compaction/prune', data: { shadowedSeqs: [1] } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [1],
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, data: replacementData },
    callEvent(4, 'call_b', 'const b = 2'),
    { seq: 5, type: 'tool/result', sourceEventSeqs: [4], data: { meta: { [JOURNAL_KEY]: journal() } } },
  ]
  const recovered = recoverJournal({ events }, 6)
  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const a = 1', 'const b = 2'])

  const tampered = structuredClone(events)
  tampered[3].data.meta = { ...tampered[3].data.meta, changed: true }
  const rejected = recoverJournal({ events: tampered }, 6)
  assert.equal(rejected.available, false)
  assert.deepEqual(pathToHead(rejected).map(node => node.code), ['const a = 1'])

  const wrongSurfaceOp = structuredClone(events)
  wrongSurfaceOp[3].surfaceOp = { op: 'append' }
  assert.equal(recoverJournal({ events: wrongSurfaceOp }, 6).available, false)
  const missingMessage = structuredClone(events)
  missingMessage[3].data = { meta: missingMessage[3].data.meta }
  assert.equal(recoverJournal({ events: missingMessage }, 6).available, false)

  const legacyReplacement = structuredClone(events)
  legacyReplacement[3].surfaceOp = { op: 'replace', start: 1, end: 1 }
  assert.equal(recoverJournal({ events: legacyReplacement }, 6).available, true)
})

test('keeps a derived edit settlement after a content-only result replacement', () => {
  const editData = {
    message: {
      id: 'message-edit',
      role: 'user',
      source: { kind: 'tool', callId: 'call_edit' },
      content: [{ type: 'tool-result', toolCallId: 'call_edit', content: 'before' }],
    },
    meta: {
      [JOURNAL_KEY]: journal(),
      dshPtcPlusEdit: { targetCallSeq: 0 },
      dshPtcPlusDerivedRun: { code: 'const a = 2', description: 'edited cell' },
    },
  }
  const events = [
    callEvent(0, 'call_a', 'const a = 1'),
    { seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { meta: { [JOURNAL_KEY]: journal() } } },
    { seq: 2, type: 'tool/call', data: {
      name: 'edit_run_code', callId: 'call_edit',
      arguments: JSON.stringify({ edits: [], expected_target_call_seq: 0 }),
    } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: structuredClone(editData) },
    { seq: 4, type: 'compaction/prune', data: { shadowedSeqs: [3] } },
    { seq: 5, type: 'tool/result', sourceEventSeqs: [3],
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
      data: {
        ...structuredClone(editData),
        message: {
          ...structuredClone(editData.message),
          content: [{ type: 'tool-result', toolCallId: 'call_edit', content: 'after' }],
        },
      } },
    callEvent(6, 'call_b', 'const b = 2'),
    { seq: 7, type: 'tool/result', sourceEventSeqs: [6], data: { meta: { [JOURNAL_KEY]: journal() } } },
  ]
  const recovered = recoverJournal({ events }, 8)
  assert.equal(recovered.available, true)
  assert.deepEqual(recovered.volatileSuffix, [])
})

test('requires an adjacent, uniquely identified prune replacement', () => {
  const call = callEvent(10, 'call_10', 'return 1')
  const clone = {
    ...resultEvent(11, journal()),
    seq: 21,
    data: {
      ...resultEvent(11, journal()).data,
      message: { source: { callId: 'call_10' } },
    },
    surfaceOp: { op: 'replace', start: 11, end: 11 },
  }
  const prune = { seq: 20, type: 'compaction/prune', data: { shadowedSeqs: [11] } }

  const accepted = recoverJournal({ events: [call, prune, clone] })
  assert.equal(accepted.available, true)
  assert.deepEqual(pathToHead(accepted).map(node => node.code), ['return 1'])

  const currentReplacement = recoverJournal({ events: [call, prune, {
    ...clone,
    surfaceOp: { op: 'replace', startSeq: 11, endSeq: 11 },
  }] })
  assert.equal(currentReplacement.available, true)
  assert.deepEqual(pathToHead(currentReplacement).map(node => node.code), ['return 1'])

  for (const malformed of [
    [call, prune, { type: 'tool/call', data: { name: 'read', callId: 'gap' } }, clone],
    [call, { ...prune, data: { shadowedSeqs: [99] } }, clone],
    [call, { ...prune, data: { shadowedSeqs: [11, 'malformed'] } }, clone],
    [call, { ...prune, data: { shadowedSeqs: [11, 10] } }, clone],
    [call, { ...prune, data: { shadowedSeqs: [11, 11] } }, clone],
    [call, { ...prune, data: { shadowedSeqs: [] } }, clone],
    [call, { ...prune, data: { shadowedSeqs: [11], shadowedRange: { start: 10, end: 11 } } }, clone],
    [call, { ...prune, seq: 21 }, clone],
    [call, { ...prune, seq: -1 }, clone],
    [call, { ...prune, seq: 10 }, { ...clone, seq: 11 }],
    [call, prune, { ...clone, seq: 30 }],
    [call, prune, { ...clone, seq: undefined }],
    [{ ...call, seq: -1 }, prune, clone],
    [{ ...call, seq: 12 }, prune, clone],
    [{ ...call, data: { ...call.data, name: 'read' } }, prune, clone],
    [call, { ...call, seq: 9 }, prune, clone],
    [call, prune, { ...clone, surfaceOp: { op: 'append' } }],
    [call, prune, { ...clone, surfaceOp: { op: 'replace', start: 10, end: 10 } }],
    [call, prune, { ...clone, surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 } }],
    [call, prune, { ...clone, surfaceOp: {
      op: 'replace', startSeq: 11, endSeq: 11, extra: true,
    } }],
    [call, prune, {
      ...clone,
      sourceEventSeqs: [11, 12],
    }],
    [call, prune, {
      ...clone,
      data: { ...clone.data, message: { source: { callId: 'other' } } },
    }],
    [call, prune, {
      ...clone,
      data: { ...clone.data, message: { source: { callId: 10 } } },
    }],
  ]) {
    const rejected = recoverJournal({ events: malformed })
    assert.equal(rejected.available, false)
  }
})

test('marks missing and corrupt recovery data untrusted and rejects invalid histories', () => {
  const malformedArguments = callEvent(1, 'bad-source', 'ignored')
  malformedArguments.data.arguments = '{'
  const missing = recoverJournal({ events: [malformedArguments] })
  assert.equal(missing.available, false)
  assert.equal(missing.volatileSuffix[0].code, undefined)

  const wrongShape = callEvent(2, 'wrong-source', 'ignored')
  wrongShape.data.arguments = JSON.stringify({ code: 42 })
  const corrupt = recoverJournal({ events: [
    wrongShape,
    resultEvent(2, { ...journal(), status: 'invalid' }),
  ] })
  assert.match(corrupt.volatileSuffix[0].reason, /invalid dsh-ptc-plus journal/)
  assert.equal(corrupt.available, false)

  const duplicate = resultEvent(1, journal())
  const duplicateState = recoverJournal({ events: [callEvent(1, 'duplicate', 'return 1'), duplicate, duplicate] })
  assert.equal(duplicateState.available, false)

  const ambiguousCallSequence = recoverJournal({ events: [
    callEvent(1, 'first-sequence-owner', 'return 1'),
    callEvent(1, 'second-sequence-owner', 'return 2'),
    { ...resultEvent(1, journal()), seq: 2 },
  ] })
  assert.equal(ambiguousCallSequence.available, false)
  assert.match(
    ambiguousCallSequence.volatileSuffix.at(-1).reason,
    /duplicate executable tool call sequence 1/,
  )
  const multipleAmbiguousCallSequences = recoverJournal({ events: [
    callEvent(1, 'first-sequence-owner', 'return 1'),
    callEvent(1, 'second-sequence-owner', 'return 2'),
    callEvent(2, 'third-sequence-owner', 'return 3'),
    callEvent(2, 'fourth-sequence-owner', 'return 4'),
  ] })
  assert.equal(multipleAmbiguousCallSequences.available, false)
  assert.match(
    multipleAmbiguousCallSequences.volatileSuffix.at(-1).reason,
    /duplicate executable tool call sequence 1/,
  )
  assert.throws(() => pathToHead({ head: 2, nodes: [] }), /invalid dsh-ptc-plus journal head/)

  const unknownRestore = [
    callEvent(1, 'one', 'return 1'),
    resultEvent(1, journal({ operations: [{ action: 'restore', name: 'missing' }] })),
  ]
  const unknownRestoreState = recoverJournal({ events: unknownRestore })
  assert.equal(unknownRestoreState.available, false)

  const volatileSave = [
    callEvent(1, 'one', 'Date.now()'),
    resultEvent(1, journal({ status: 'volatile', operations: [{ action: 'save', name: 'bad' }] })),
  ]
  const volatileSaveState = recoverJournal({ events: volatileSave })
  assert.equal(volatileSaveState.available, false)

  for (const meta of [
    null,
    [{ failedCallSeq: -1, frontierCallSeq: null }],
    [{ failedCallSeq: 1, frontierCallSeq: null, extra: true }],
    [{ failedCallSeq: 1 }],
  ]) {
    const malformedBoundary = recoverJournal({ events: [
      callEvent(0, 'bad-boundary', 'return 1'),
      (() => {
        const result = resultEvent(0, journal())
        return {
          ...result,
          data: { meta: { ...result.data.meta, [RECOVERY_BOUNDARY_KEY]: meta } },
        }
      })(),
    ] })
    assert.equal(malformedBoundary.available, false)
  }

  const legacyBoundary = recoverJournal({ events: [{ type: RECOVERY_BOUNDARY_EVENT, seq: 0, data: {} }] })
  assert.equal(legacyBoundary.available, false)

  const duplicateBoundary = recoverJournal({ events: [
      callEvent(0, 'duplicate-boundary', 'return 1'),
      resultEvent(0, journal()),
    ] }, undefined, {
      extraBoundaries: [
        { failedCallSeq: 0, frontierCallSeq: null },
        { failedCallSeq: 0, frontierCallSeq: null },
      ],
    })
  assert.equal(duplicateBoundary.available, false)
  assert.match(duplicateBoundary.volatileSuffix[0].reason, /outside the verified frontier/u)
  const malformedExtraBoundary = recoverJournal({ events: [] }, undefined, { extraBoundaries: 'invalid' })
  assert.equal(malformedExtraBoundary.available, false)
})

test('does not acknowledge a malformed result from its un-applied boundary', () => {
  const malformed = journal()
  malformed.unexpected = true
  const result = resultEvent(1, malformed)
  result.data.meta[RECOVERY_BOUNDARY_KEY] = [{ failedCallSeq: 1, frontierCallSeq: null }]
  const recovered = recoverJournal({ events: [callEvent(1, 'bad', 'return 1'), result] })
  assert.equal(recovered.available, false)
  assert.equal(recovered.volatileSuffix[0].seq, 1)
})

test('counts every record blocked by an unavailable journal result', () => {
  const malformed = journal()
  malformed.unexpected = true
  const recovered = recoverJournal({ events: [
    callEvent(0, 'stable', 'const stable = 1'),
    resultEvent(0, journal()),
    callEvent(2, 'malformed', 'const malformed = 2'),
    resultEvent(2, malformed),
    callEvent(4, 'dependent-one', 'const dependentOne = 3'),
    resultEvent(4, journal()),
    callEvent(6, 'dependent-two', 'const dependentTwo = 4'),
    resultEvent(6, journal()),
  ] })
  assert.equal(recovered.available, false)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const stable = 1'])
  assert.deepEqual(recovered.volatileSuffix.map(item => item.seq), [2, 4, 6])
})

test('contracts at an earlier missing result even when a later malformed result was found first', () => {
  const malformed = journal({ unexpected: true })
  const recovered = recoverJournal({ events: [
    callEvent(0, 'stable', 'const stable = 1'),
    resultEvent(0, journal()),
    callEvent(2, 'missing', 'const missing = 2'),
    callEvent(4, 'dependent', 'const dependent = missing + 1'),
    resultEvent(4, journal()),
    callEvent(6, 'malformed', 'const later = 6'),
    resultEvent(6, malformed),
  ] })
  assert.equal(recovered.available, false)
  assert.deepEqual(pathToHead(recovered).map(node => node.callSeq), [0])
  assert.deepEqual(recovered.volatileSuffix.map(item => item.seq), [2, 4, 6])
  assert.deepEqual(recoveryBoundaryForHistory(recovered), { failedCallSeq: 2, frontierCallSeq: 0 })
  for (const item of recovered.volatileSuffix) assert.match(item.reason, /missing dsh-ptc-plus journal result/)
})

test('persists malformed and invalid-operation contractions in a later cell', () => {
  const malformed = journal()
  malformed.unexpected = true
  for (const badJournal of [
    malformed,
    journal({ operations: [{ action: 'restore', name: 'missing' }] }),
  ]) {
    const recovery = resultEvent(4, journal())
    recovery.data.meta[RECOVERY_BOUNDARY_KEY] = [{ failedCallSeq: 2, frontierCallSeq: 0 }]
    const recovered = recoverJournal({ events: [
      callEvent(0, 'stable', 'const stable = 1'),
      resultEvent(0, journal()),
      callEvent(2, 'bad', 'const bad = 2'),
      resultEvent(2, badJournal),
      callEvent(4, 'recovered', 'const recovered = 4'),
      recovery,
    ] })
    assert.equal(recovered.available, true)
    assert.deepEqual(pathToHead(recovered).map(node => node.code), [
      'const stable = 1',
      'const recovered = 4',
    ])
  }
})

test('resolves surface contraction through a later valid boundary', () => {
  const boundary = [{ failedCallSeq: 2, frontierCallSeq: 0 }]
  const events = [
    callEvent(0, 'first', 'const first = 1'),
    resultEvent(0, journal()),
    callEvent(2, 'hidden', 'const hidden = 2'),
    resultEvent(2, journal()),
    callEvent(4, 'boundary', 'const later = 4'),
    { ...resultEvent(4, journal()), data: { meta: { [JOURNAL_KEY]: journal(), [RECOVERY_BOUNDARY_KEY]: boundary } } },
  ]
  const recovered = recoverJournal({ events }, undefined, { visibleCallSeqs: new Set([0, 4]) })
  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const first = 1', 'const later = 4'])
})

test('preserves a discarded external-effect boundary as an untrusted suffix', () => {
  const events = [
    callEvent(1, 'external-discard', 'await mutate()'),
    resultEvent(1, journal({
      status: 'discarded',
      completion: undefined,
      volatileReason: 'domain.write',
    })),
  ]
  const state = recoverJournal({ events })
  assert.equal(state.nodes.length, 0)
  assert.deepEqual(state.volatileSuffix, [{ seq: 1, code: 'await mutate()', reason: 'domain.write' }])
})

test('handles omitted confirms, unrelated results, and unnamed parent restores', () => {
  const withoutConfirms = journal()
  delete withoutConfirms.confirms
  assert.deepEqual(normalizeJournal(withoutConfirms).confirms, [])

  const events = [
    { type: 'tool/result', sourceEventSeqs: ['invalid'], data: {} },
    callEvent(1, 'one', 'const one = 1'),
    resultEvent(1, journal()),
    callEvent(2, 'two', 'const two = 2'),
    resultEvent(2, journal({ operations: [{ action: 'restore' }] })),
  ]
  assert.deepEqual(pathToHead(recoverJournal({ events })).map(node => node.code), ['const one = 1'])
})

function viewDiagnostic() {
  return {
    code: 'PTC-C001',
    severity: 'error',
    phase: 'parse',
    message: 'invalid cell',
    stateEffect: 'unchanged',
  }
}

function viewCall(callId, code, description = 'test cell', name = 'run_code', raw) {
  return {
    type: 'tool/call',
    data: {
      callId,
      name,
      arguments: raw ?? JSON.stringify({ code, description }),
    },
  }
}

function viewResult(callId, value, rewrites) {
  return {
    type: 'tool/result',
    data: {
      message: { source: { callId } },
      meta: {
        dshPtcPlus: value,
        ...(rewrites === undefined ? {} : { dshPtcPlusRewrites: rewrites }),
      },
    },
  }
}

function viewJournal(status, diagnostics = []) {
  return journal({
    status,
    diagnostics,
    ...(status === 'durable' ? {} : { completion: undefined }),
  })
}

test('projects open-turn facts and resets call identity between turns', () => {
  const events = [
    { type: 'request/header' },
    { type: 'turn/start' },
    viewCall('same-id', 'return )'),
    viewResult('same-id', viewJournal('noop', [viewDiagnostic()])),
    { type: 'turn/end' },
    { type: 'turn/start' },
    viewCall('same-id', 'return 1'),
    viewResult('same-id', viewJournal('durable')),
  ]
  const view = projectSessionLog({ session: { events } })
  assert.equal(view.openTurn, true)
  assert.equal(view.contextStep, 1)
  assert.equal(view.lastSuccessfulRunIndex, events.length - 1)
  assert.equal(view.latestRun.args.code, 'return 1')
  assert.ok(Object.isFrozen(view.latestRun.args))
  assert.ok(Object.isFrozen(view))
  assert.ok(Object.isFrozen(view.latestRun))
})

test('resolves an edit target by persisted call sequence when provider call ids repeat', () => {
  const events = [
    { type: 'turn/start', seq: 0 },
    { ...viewCall('reused', 'return 1'), seq: 1 },
    viewResult('reused', viewJournal('durable')),
    { ...viewCall('reused', undefined, undefined, 'edit_run_code', '{}'), seq: 3 },
  ]
  assert.deepEqual(editTargetForCall({ session: { events } }, 'reused', 3), {
    source: 'return 1',
    callSeq: 1,
  })
  assert.equal(editTargetForCall({ session: { events } }, 'reused', 4), undefined)
})

test('projects only unambiguous paired run_code results in the open turn', () => {
  const prefix = [{ type: 'turn/start' }]

  const malformed = projectSessionLog({ session: { events: [
    ...prefix,
    viewCall('malformed', undefined, undefined, 'run_code', '{'),
    viewResult('malformed', viewJournal('durable')),
  ] } })
  assert.equal(malformed.latestRun.args, undefined)

  const primitive = projectSessionLog({ session: { events: [
    ...prefix,
    viewCall('primitive', undefined, undefined, 'run_code', 'null'),
    viewResult('primitive', viewJournal('durable')),
  ] } })
  assert.equal(primitive.latestRun.args, undefined)

  const duplicate = projectSessionLog({ session: { events: [
    ...prefix,
    viewCall('duplicate', 'return 1'),
    viewCall('duplicate', 'return 2'),
    viewResult('duplicate', viewJournal('durable')),
  ] } })
  assert.equal(duplicate.latestRun, undefined)

  const closed = projectSessionLog({ session: { events: [
    ...prefix,
    viewCall('closed', 'return 1'),
    viewResult('closed', viewJournal('durable')),
    { type: 'turn/end' },
  ] } })
  assert.equal(closed.openTurn, false)
  assert.equal(closed.latestRun, undefined)
})
test('projects canonical named prompt snapshots and validates journal and rewrites independently', () => {
  const events = [
    { type: 'turn/start' },
    { type: 'assistant/message' },
    {
      type: 'user/message',
      data: {
        source: {
          kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
          sections: [{ name: 'tools:ptc-plus-tip/repeated-binding-failure/1', text: 'tip text' }],
        },
      },
    },
    { type: 'user/message', data: { source: { kind: 'plugin' }, content: 'direct text' } },
    {
      type: 'user/message',
      data: {
        source: {
          kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
          sections: [{ name: 'duplicate', text: 'one' }, { name: 'duplicate', text: 'two' }],
        },
      },
    },
    { type: 'user/message', data: { source: { kind: 'user' }, content: 'next' } },
    viewCall('rewritten', 'return )'),
    viewResult('rewritten', viewJournal('noop', [viewDiagnostic()]), [{ invalid: true }]),
  ]
  const view = projectSessionLog({ session: { events } })
  assert.equal(view.contextStep, 2)
  assert.deepEqual(view.systemPromptSnapshots, [
    {
      index: 2,
      contextStep: 1,
      sections: [{ name: 'tools:ptc-plus-tip/repeated-binding-failure/1', text: 'tip text' }],
    },
  ])
  assert.equal(view.latestRun.journal.status, 'noop')
  assert.equal(view.latestRun.rewrites, undefined)

  const empty = projectSessionLog()
  assert.equal(empty.openTurn, false)
  assert.ok(Object.isFrozen(empty.systemPromptSnapshots))
})

test('projects only target-linked derived edit sources with a valid execution journal', () => {
  const runCall = { ...viewCall('run', 'return 1'), seq: 1 }
  const editCall = { ...viewCall('edit', undefined, undefined, 'edit_run_code', '{"edits":[]}'), seq: 3 }
  const derived = viewResult('edit', viewJournal('durable'))
  derived.data.meta.dshPtcPlusEdit = { targetCallSeq: 1 }
  derived.data.meta.dshPtcPlusDerivedRun = { code: 'return 2', description: 'derived' }
  const view = projectSessionLog({ session: { events: [
    { type: 'turn/start' }, runCall, viewResult('run', viewJournal('durable')), editCall, derived,
  ] } })
  assert.equal(view.latestRun.source, 'return 2')
  assert.equal(view.latestRun.callSeq, 3)
  assert.equal(view.latestRun.journal.status, 'durable')
  assert.equal(view.latestRun.rewrites, undefined)

  for (const derivedValue of [null, [], {}, { code: 1, description: 'x' }, { code: 'x' }]) {
    const result = viewResult('bad-edit', viewJournal('durable'))
    result.data.meta.dshPtcPlusEdit = { targetCallSeq: 1 }
    result.data.meta.dshPtcPlusDerivedRun = derivedValue
    assert.equal(projectSessionLog({ session: { events: [
      { type: 'turn/start' }, runCall, viewResult('run', viewJournal('durable')),
      viewCall('bad-edit', undefined, undefined, 'edit_run_code', '{}'), result,
    ] } }).latestRun.source, 'return 1')
  }

  for (const mutate of [
    meta => { delete meta.dshPtcPlusEdit },
    meta => { meta.dshPtcPlusEdit = { targetCallSeq: 99 } },
    meta => { meta.dshPtcPlus = { invalid: true } },
    meta => { meta.dshPtcPlus = viewJournal('noop') },
  ]) {
    const result = structuredClone(derived)
    mutate(result.data.meta)
    const rejected = projectSessionLog({ session: { events: [
      { type: 'turn/start' }, runCall, viewResult('run', viewJournal('durable')), editCall, result,
    ] } })
    assert.equal(rejected.latestRun.source, 'return 1')
    assert.equal(rejected.editableRun.source, 'return 1')
  }

  const invalidRun = projectSessionLog({ session: { events: [
    { type: 'turn/start' },
    viewCall('invalid-journal', 'return 1'),
    viewResult('invalid-journal', { invalid: true }),
    viewCall('other', undefined, undefined, 'read', '{}'),
    viewResult('other', undefined),
  ] } })
  assert.equal(invalidRun.latestRun.source, 'return 1')
  assert.equal(invalidRun.editableRun.source, 'return 1')
})

test('preserves the editable run across unrelated native settlements', () => {
  const events = [
    { type: 'turn/start' },
    { ...viewCall('run', 'return 1'), seq: 1 },
    { ...viewResult('run', viewJournal('durable')), sourceEventSeqs: [1] },
    { ...viewCall('native', undefined, undefined, 'read', '{}'), seq: 2 },
    {
      type: 'tool/result',
      sourceEventSeqs: [2],
      data: { message: { source: { callId: 'native' } } },
    },
    { ...viewCall('edit', undefined, undefined, 'edit_run_code', '{}'), seq: 3 },
  ]
  const view = projectSessionLog({ session: { events } })
  assert.equal(view.latestRun.source, 'return 1')
  assert.equal(view.editableRun.source, 'return 1')
  assert.deepEqual(editTargetForCall({ session: { events } }, 'edit', 3), {
    source: 'return 1',
    callSeq: 1,
  })
})

test('orders a pruned journal clone at its settlement position', () => {
  const failed = callEvent(10, 'call_10', 'const a = 1')
  const carrier = callEvent(12, 'call_12', 'const b = 2')
  const later = callEvent(30, 'call_30', 'const c = 3')
  const failedResult = { ...resultEvent(10, journal()), seq: 11 }
  const carrierResult = (() => {
    const result = resultEvent(12, journal())
    return {
      ...result,
      seq: 13,
      data: {
        meta: withRecoveryBoundaries(
          result.data.meta,
          [{ failedCallSeq: 10, frontierCallSeq: null }],
        ),
      },
    }
  })()
  const laterResult = { ...resultEvent(30, journal()), seq: 31 }
  const boundaryPath = ['const b = 2', 'const c = 3']

  const control = recoverJournal({
    events: [failed, failedResult, carrier, carrierResult, later, laterResult],
  })
  assert.equal(control.available, true)
  assert.deepEqual(pathToHead(control).map(node => node.code), boundaryPath)

  // The Host pruner replaces the failed cell's settlement with a clone that
  // sits after the carrier. The clone is the same settlement representation, so
  // it keeps the settlement's position and the recorded boundary still applies.
  const prune = { seq: 20, type: 'compaction/prune', data: { shadowedSeqs: [11] } }
  const clone = {
    ...resultEvent(11, journal()),
    seq: 21,
    data: {
      ...resultEvent(11, journal()).data,
      message: { source: { callId: 'call_10' } },
    },
    surfaceOp: { op: 'replace', start: 11, end: 11 },
  }
  const replaced = recoverJournal({
    events: [failed, prune, clone, carrier, carrierResult, later, laterResult],
  })
  assert.equal(replaced.available, true)
  assert.deepEqual(pathToHead(replaced).map(node => node.code), boundaryPath)
})

test('contracts later-folded settlements when a recovery boundary is rejected', () => {
  const failed = callEvent(0, 'failed', 'const a = 1')
  const carrier = callEvent(2, 'carrier', 'const b = 2')
  const later = callEvent(4, 'later', 'const c = 3')
  const carrierResult = (() => {
    const result = resultEvent(2, journal())
    return {
      ...result,
      seq: 3,
      data: {
        meta: withRecoveryBoundaries(
          result.data.meta,
          [{ failedCallSeq: 0, frontierCallSeq: 2 }],
        ),
      },
    }
  })()
  // The failed cell's settlement arrives after the carrier that recorded the
  // boundary, so the boundary is rejected while that settlement is still
  // unfolded. The rejected boundary still contracts the window it computed.
  const recovered = recoverJournal({
    events: [
      failed,
      carrier,
      carrierResult,
      later,
      { ...resultEvent(0, journal()), seq: 5 },
      { ...resultEvent(4, journal()), seq: 6 },
    ],
  })
  assert.equal(recovered.available, false)
  assert.deepEqual(pathToHead(recovered), [])
  // The carrier and everything after it stay unproved; the contracted window
  // keeps no node at all.
  assert.deepEqual(recovered.volatileSuffix.map(item => item.seq).sort(), [2, 4])
})
