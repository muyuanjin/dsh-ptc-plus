import assert from 'node:assert/strict'
import test from 'node:test'
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
  pathToHead,
  recoveryBoundariesEqual,
  reduceStateOperations,
  recoverJournal,
  withJournal,
  withRecoveryBoundaries,
  withRewrites,
} from '../internal/session-journal.js'
import { editTargetForCall, projectSessionLog } from '../internal/session-log-view.js'
import { encodeValue } from '../internal/value-wire.js'

function completion(value = 1) {
  return { kind: 'return', hasValue: true, value: encodeValue(value) }
}

function journal(overrides = {}) {
  return {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
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
    bindingMode: 'strict',
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
    [journal({ bindingMode: 'wide' }), /binding mode/],
    [journal({ rewritePolicy: { autoRewriteImports: true } }), /rewrite policy/],
    [{ ...journal(), extra: true }, /journal field extra/],
    [journal({ calls: null }), /journal calls/],
    [journal({ calls: [{}] }), /journal call at index 0/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: true, settle: 0 }] }), /missing its value/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: false, settle: 0 }] }), /missing its error/],
    [journal({ calls: [{ global: 'g', member: 'm', args: encodeValue(1), ok: false, error: 1, settle: 0 }] }), /missing its error/],
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
    version: 3,
    bindingMode: 'strict',
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    calls: [], operations: [], confirms: [4], diagnostics: [],
  })
  assert.throws(() => createJournal([], 'invalid', policy), /binding mode/)
  const value = journal()
  assert.equal(journalsEqual(value, structuredClone(value)), true)
  assert.equal(journalsEqual(value, journal({ status: 'volatile' })), false)
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
    /no later tool\/result settlement/,
  )
  assert.throws(
    () => migrateRecoveryBoundaryEvents([{
      seq: -1, type: RECOVERY_BOUNDARY_EVENT,
      data: { failedCallSeq: 0, frontierCallSeq: null },
    }]),
    /recovery boundary event sequence/,
  )
  assert.throws(
    () => normalizeRecoveryBoundaries([{ failedCallSeq: 0, frontierCallSeq: null }], -1),
    /recovery boundary event sequence/,
  )
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
  assert.deepEqual(duplicateRejected.volatileSuffix, [])
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

test('migrates predecessor journals and only unambiguous legacy call identities', () => {
  const legacy = journal({
    version: 1,
    confirms: [],
  })
  delete legacy.rewritePolicy
  assert.deepEqual(normalizeJournal(legacy), {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: { autoRewriteImports: false, autoStripExports: false, autoSplitRedeclarations: false },
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: completion(),
  })
  assert.equal(normalizeJournal(journal({ version: 2 })).version, 3)
  assert.throws(
    () => normalizeJournal(journal({ version: 1, confirms: ['legacy-call-id'] })),
    /journal field rewritePolicy/,
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
  assert.match(recovered.volatileSuffix.at(-1).reason, /not uniquely persisted/)
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
  assert.throws(() => recoverJournal({ events: [
    otherTool,
    callEvent(5, 'confirmer', 'return 1'),
    resultEvent(5, journal({ confirms: [4] })),
  ] }), /earlier unjournaled run_code/)

  assert.throws(() => recoverJournal({ events: [
    callEvent(1, 'settled', 'return 1'),
    resultEvent(1, journal()),
    callEvent(2, 'confirmer', 'return 2'),
    resultEvent(2, journal({ confirms: [1] })),
  ] }), /earlier unjournaled run_code/)

  assert.throws(() => recoverJournal({ events: [
    callEvent(1, 'confirmer', 'return 1'),
    resultEvent(1, journal({ confirms: [2] })),
    callEvent(2, 'future', 'return 2'),
  ] }), /earlier unjournaled run_code/)

  assert.throws(() => recoverJournal({ events: [
    { type: 'tool/result', sourceEventSeqs: [7], data: { meta: { dshPtcPlus: journal() } } },
  ] }), /unavailable run_code call seq 7/)

  assert.throws(() => recoverJournal({ events: [
    callEvent(7, 'first', 'return 1'),
    callEvent(7, 'second', 'return 2'),
  ] }), /duplicate run_code call sequence/)
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

  const duplicate = resultEvent(1, journal())
  assert.throws(() => recoverJournal({ events: [duplicate, duplicate] }), /duplicate PTC journal/)
  assert.throws(() => pathToHead({ head: 2, nodes: [] }), /invalid dsh-ptc-plus journal head/)

  const unknownRestore = [
    callEvent(1, 'one', 'return 1'),
    resultEvent(1, journal({ operations: [{ action: 'restore', name: 'missing' }] })),
  ]
  assert.throws(() => recoverJournal({ events: unknownRestore }), /restores unknown REPL state/)

  const volatileSave = [
    callEvent(1, 'one', 'Date.now()'),
    resultEvent(1, journal({ status: 'volatile', operations: [{ action: 'save', name: 'bad' }] })),
  ]
  assert.throws(() => recoverJournal({ events: volatileSave }), /volatile journal cannot save/)

  for (const meta of [
    null,
    [{ failedCallSeq: -1, frontierCallSeq: null }],
    [{ failedCallSeq: 1, frontierCallSeq: null, extra: true }],
    [{ failedCallSeq: 1 }],
  ]) {
    assert.throws(() => recoverJournal({ events: [
      callEvent(0, 'bad-boundary', 'return 1'),
      (() => {
        const result = resultEvent(0, journal())
        return {
          ...result,
          data: { meta: { ...result.data.meta, [RECOVERY_BOUNDARY_KEY]: meta } },
        }
      })(),
    ] }), /recovery boundar/)
  }

  assert.throws(
    () => recoverJournal({ events: [{ type: RECOVERY_BOUNDARY_EVENT, seq: 0, data: {} }] }),
    /legacy recovery boundary requires migration/,
  )

  assert.throws(
    () => recoverJournal({ events: [
      callEvent(0, 'duplicate-boundary', 'return 1'),
      resultEvent(0, journal()),
    ] }, undefined, {
      extraBoundaries: [
        { failedCallSeq: 0, frontierCallSeq: null },
        { failedCallSeq: 0, frontierCallSeq: null },
      ],
    }),
    /recovery boundary references an unavailable failed cell/,
  )
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
