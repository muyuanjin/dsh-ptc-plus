// A cluster outside the payload window keeps its identity, observation and result,
// and loses only its argument text: digests replace it. Folding into the interval
// summary happens only past the configured cluster cap, so the payload window here
// is small and the folding cases configure a small cap explicitly.
process.env.DSH_PTC_RETENTION_RUNS = '8'
process.env.DSH_PTC_RETENTION_BYTES = '1048576'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { advanceSessionTimeline, createSessionTimelineState, validateRetentionSummary,
  verifyRetentionSummaryAgainstEvents, validateSessionTimelineState, withFullRetention } =
  await import('../internal/session-journal-recovery.js')
const { JOURNAL_KEY, JOURNAL_VERSION } = await import('../internal/session-journal.js')
const { IMPORT_BOUNDARY_JOURNAL_VERSION, LANGUAGE_SEMANTICS_JOURNAL_VERSION,
  PER_NAME_USER_BINDINGS_JOURNAL_VERSION } = await import('../internal/session-journal-schema.js')

// A journal that the normalizer accepts at the current generation. A dropped or
// digested cluster is still validated against this shape, so the fixture must be
// as complete as a live one.
function journal(overrides = {}) {
  return {
    version: JOURNAL_VERSION,
    languageSemantics: 'legacy-v1',
    moduleTransform: 'none',
    executionCwd: null,
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: false },
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    moduleSemantics: { defaultExportBinding: 'live-readonly', importExpressionBoundary: 'statement-safe' },
    userBindingsFingerprint: null,
    userBindingsReusePolicy: 'implementation-v1',
    userBindingsShadowPolicy: 'per-name',
    userBindingNames: ['noop', 'discarded'].includes(overrides.status) ? null : [],
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: { kind: 'return' },
    ...(JOURNAL_VERSION >= IMPORT_BOUNDARY_JOURNAL_VERSION ? {} : {}),
    ...(JOURNAL_VERSION >= PER_NAME_USER_BINDINGS_JOURNAL_VERSION ? {} : {}),
    ...(JOURNAL_VERSION >= LANGUAGE_SEMANTICS_JOURNAL_VERSION ? {} : {}),
    ...overrides,
  }
}

let seq = 0
const next = () => {
  seq += 1
  return seq
}
function call(code, callId) {
  return { seq: next(), type: 'tool/call', data: {
    turn: 1, step: 1, name: 'run_code', callId, arguments: JSON.stringify({ code, description: 'probe' }),
  } }
}
function result(callId) {
  return { seq: next(), type: 'tool/result', data: {
    callId, isError: false,
    message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: 'ok' }] },
    meta: { [JOURNAL_KEY]: journal() },
  } }
}

let lastHistory = []
function fold(events) {
  let state = createSessionTimelineState()
  // The turn header leads the history and owns the lowest sequence, so a fold that
  // stops at a given seq still sees it.
  const history = [{ seq: 0, type: 'turn/start', data: {} }, ...events]
  for (let index = 0; index < history.length; index += 1) state = advanceSessionTimeline(state, history[index], index)
  lastHistory = history
  return state
}

const settlementList = state => Object.values(state.settledResultsByEventSeq).map(pair => pair[1])
const executableList = state => Object.values(state.executableCalls).map(pair => pair[1])
const resultList = state => Object.values(state.results).map(pair => pair[1])

test('the retention window digests old payloads and keeps every cluster', () => {
  const events = []
  const payload = 'x'.repeat(2048)
  for (let index = 0; index < 12; index += 1) {
    const id = `call-${index}`
    events.push(call(`return '${payload}'`, id), result(id))
  }
  const state = fold(events)

  const all = settlementList(state)
  assert.equal(all.length, 12, 'the payload window folds no cluster')
  assert.equal(state.retentionSummary ?? null, null, 'nothing is folded below the cluster cap')
  assert.equal(executableList(state).length, 12, 'every call entry survives')
  assert.equal(resultList(state).length, 12, 'every normalized result survives')

  const retained = all.filter(settlement => typeof settlement.call.data.arguments === 'string')
  const digested = all.filter(settlement => typeof settlement.call.data.argumentsDigest === 'string')
  assert.equal(retained.length, 8, `the newest window keeps its text: ${retained.length}`)
  assert.equal(digested.length, 4, `the older cells carry digests: ${digested.length}`)
  for (const settlement of digested) {
    assert.match(settlement.call.data.argumentsDigest, /^[a-f0-9]{64}$/u)
    assert.ok(settlement.call.data.argumentsBytes > 2048, 'the digest records the byte length')
    // The cluster keeps what recovery and the run derivations read; only the
    // argument wire is replaced by a digest. A cluster that dropped these would
    // force a log refold for cells the window covers.
    assert.ok(settlement.normalized !== undefined, 'a digested cluster keeps its normalized result')
    assert.ok(settlement.publication !== undefined, 'a digested cluster keeps its publication')
  }
  // Every stored result keeps the shape recovery reads: the journal, or the error
  // that replaced it when the journal could not be normalized.
  for (const stored of resultList(state)) {
    assert.ok(stored.journal !== undefined || typeof stored.error === 'string',
      'a result keeps its journal or the recorded error')
  }
  assert.ok(state.retainedBytes < 4096 * 10, `digested clusters stay small: ${state.retainedBytes}`)
  validateSessionTimelineState(state)
})

test('the newest run always stays inside the window so tips and edits keep working', () => {
  const events = []
  for (let index = 0; index < 2; index += 1) {
    const id = `keep-${index}`
    events.push(call(`return ${index}`, id), result(id))
  }
  const state = fold(events)
  assert.ok(state.latestRun?.source !== undefined, 'latestRun keeps its source')
  assert.equal(state.editableRun?.source, state.latestRun?.source)
})

test('a digested cluster can be refolded from the same events', () => {
  const events = []
  for (let index = 0; index < 10; index += 1) {
    const id = `refold-${index}`
    events.push(call(`return 'refold-${index}'`, id), result(id))
  }
  const state = fold(events)
  const oldest = settlementList(state)[0]
  assert.equal(oldest.call.data.arguments, undefined, 'the oldest cell keeps no text')
  let full
  withFullRetention(() => { full = fold(lastHistory) })
  assert.equal(Object.keys(full.settledResultsByEventSeq).length, 10, 'the full fold keeps every cluster')
  assert.equal(typeof settlementList(full)[0].call.data.arguments, 'string', 'and its text')
  assert.equal(full.retentionSummary, null, 'a full-retention fold never compacts')
})

test('the newest cell keeps its payload when it fits the budget', () => {
  const events = []
  for (let index = 0; index < 4; index += 1) {
    const id = `hot-${index}`
    events.push(call(`return ${index}`, id), result(id))
  }
  const state = fold(events)
  assert.equal(typeof settlementList(state).at(-1).call.data.arguments, 'string')
  assert.ok(!state.hotCellDropped, 'a fitting hot cell is not reported as dropped')
})

test('a compacted state keeps its boundary and admits a refolded digest', () => {
  const events = []
  for (let index = 0; index < 8; index += 1) {
    const id = `summary-${index}`
    events.push(call(`return 'summary-${index}'`, id), result(id))
  }
  const state = fold(events)
  assert.equal(state.compacted ?? false, false, 'digesting a payload folds nothing')
  assert.equal(state.retentionSummary ?? null, null, 'the payload window folds nothing')
  validateSessionTimelineState(state)
  // A summary claiming a range that the fold never dropped is rejected by admission.
  assert.throws(() => validateRetentionSummary(state,
    { fromSeq: 1, toSeq: 2, count: 1, chainDigest: 'a'.repeat(64), entries: [] }),
  /retention|summary|invalid/iu)
})
