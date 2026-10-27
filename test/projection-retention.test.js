// A cluster outside the payload window keeps its identity, observation and result,
// and loses only its argument text: digests replace it. Folding into the interval
// summary happens only past the configured cluster cap, so the payload window here
// is small and the folding cases configure a small cap explicitly.
process.env.DSH_PTC_RETENTION_RUNS = '8'
process.env.DSH_PTC_RETENTION_BYTES = '1048576'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { advanceSessionTimeline, createSessionTimelineState, validateRetentionSummary,
  verifyRetentionSummaryAgainstEvents, refoldEditableSettlement, validateSessionTimelineState, withFullRetention } =
  await import('../internal/session-journal-recovery.js')
const { configureRetention } = await import('../internal/projection-retention.js')
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

// The digest-in-place policy is observable only while the cluster cap is above the
// payload window: with the shipped default the two coincide and everything past the
// window folds into the summary. These cases raise the cap on purpose.
function withClusterCap(cap, body) {
  configureRetention({ retentionClusters: cap })
  try {
    return body()
  } finally {
    configureRetention({})
  }
}

const settlementList = state => Object.values(state.settledResultsByEventSeq).map(pair => pair[1])
const executableList = state => Object.values(state.executableCalls).map(pair => pair[1])
const resultList = state => Object.values(state.results).map(pair => pair[1])

test('the retention window digests old payloads and keeps every cluster', () => withClusterCap(5000, () => {
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
}))

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

test('a digested cluster can be refolded from the same events', () => withClusterCap(5000, () => {
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
}))

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

// The floor is 8 cells: a window any smaller cannot keep the stored publication and
// the replay equal. At exactly that floor the property users buy must still hold —
// a digested cluster keeps what recovery reads, and an edit can refold its source.
test('at the supported floor a digested cluster still recovers bindings and refolds its source', () => withClusterCap(5000, () => {
  const events = []
  for (let index = 0; index < 12; index += 1) {
    const id = `floor-${index}`
    events.push(call(`return 'floor-${index}'`, id), result(id))
  }
  const state = fold(events)
  const settlements = settlementList(state)
  assert.equal(settlements.length, 12, 'no cluster is folded at the floor')
  const digested = settlements.filter(settlement => typeof settlement.call.data.argumentsDigest === 'string')
  assert.equal(digested.length, 4, 'cells beyond the floor window carry digests')
  for (const settlement of digested) {
    // Recovery reads the normalized result and the recorded observation, not the
    // argument text: both must survive for a cluster the window digested.
    assert.ok(settlement.normalized !== undefined, 'the normalized result survives digestion')
    assert.ok(settlement.publication !== undefined, 'the publication survives digestion')
    assert.equal(typeof settlement.identity, 'string', 'the observation identity survives digestion')
  }
  assert.equal(new Set(digested.map(settlement => settlement.identity)).size, 4,
    'each digested cluster keeps its own observation identity')
  // The edit path refolds the same slice at full retention and gets the source back.
  let full
  withFullRetention(() => { full = fold(lastHistory) })
  const recovered = Object.values(full.settledResultsByEventSeq)
    .map(pair => pair[1])
    .filter(settlement => typeof settlement.call.data.argumentsDigest !== 'string')
  assert.equal(recovered.length, 12, 'the refold restores the text for every cluster')
}))

test('a checkpoint stays below a small multiple of the payload budget', () => {
  // The budget bounds the retained payload, not the serialized checkpoint: the
  // selected run keeps its own copies (ADR 0032). Pin the multiplier rather than a
  // byte count, so the OOM bound stays checkable while the exact number moves.
  const budget = Number(process.env.DSH_PTC_RETENTION_BYTES)
  const payload = 'y'.repeat(300 * 1024)
  const events = []
  for (let index = 0; index < 12; index += 1) {
    const id = `big-${index}`
    events.push(call(`return '${payload}'`, id), result(id))
  }
  const state = fold(events)
  const total = Buffer.byteLength(JSON.stringify(state), 'utf8')
  const clusters = Object.keys(state.settledResultsByEventSeq).length
  const allowance = clusters * 2048
  assert.ok(total < budget * 3 + allowance,
    `checkpoint ${total} B must stay under 3x the ${budget} B budget plus ${allowance} B of cluster metadata`)
  assert.equal(state.hotCellDropped, false,
    'the newest cell fits the budget, so its payload is retained and no notice is due')
})

test('a compaction summary is refused when any part of it cannot be proved', () => {
  // Admission holds no session log, so a compacted checkpoint is admitted on the
  // summary alone. Every part of that claim is checked here: the shape, the range,
  // the retained window above the boundary, and one record per dropped cluster.
  const events = []
  const payload = 'x'.repeat(2048)
  for (let index = 0; index < 12; index += 1) {
    const id = `refuse-${index}`
    events.push(call(`return '${payload}'`, id), result(id))
  }
  const state = fold(events)
  const summary = state.retentionSummary
  assert.equal(validateRetentionSummary(state, summary), summary)
  const retainedSeqs = Object.values(state.settledResultsByEventSeq)
    .map(pair => Number(pair[0])).sort((left, right) => left - right)
  const refusals = [
    // The summary is a closed record: a field this generation never wrote cannot be
    // ignored, because it may describe a claim the reader does not know about.
    [{ ...summary, extra: true }, /invalid PTC session-log projection retention summary/u],
    [{ ...summary, count: 0 }, /invalid PTC session-log projection retention summary/u],
    [{ ...summary, fromSeq: summary.toSeq + 1 }, /invalid PTC session-log projection retention summary/u],
    [null, /invalid PTC session-log projection retention summary/u],
    // The retained window must sit strictly above the boundary.
    [{ ...summary, fromSeq: retainedSeqs[0], toSeq: retainedSeqs[0] }, /below its retention boundary/u],
    // Each dropped cluster needs one ordered record, and the range has to agree with
    // the records instead of being stated twice.
    [{ ...summary, entries: 'records' }, /inconsistent PTC session-log projection retention summary/u],
    [{ ...summary, entries: summary.entries.slice(0, -1) }, /inconsistent PTC session-log projection retention summary/u],
    [{ ...summary, entries: summary.entries.map(entry => ({ ...entry, argumentsDigest: 'not-a-digest' })) },
      /inconsistent PTC session-log projection retention summary/u],
    [{ ...summary, entries: [...summary.entries].reverse() }, /inconsistent PTC session-log projection retention summary/u],
    [{ ...summary, entries: summary.entries.map((entry, index) => index === 0 ? { ...entry, resultSeq: -0 } : entry) },
      /inconsistent PTC session-log projection retention summary/u],
    [{ ...summary, chainDigest: 'a'.repeat(63) }, /invalid PTC session-log projection retention summary/u],
  ]
  for (const [candidate, expected] of refusals) assert.throws(
    () => validateRetentionSummary(state, candidate), expected)
  // A retained entry that lost its settlement or its call cannot be proved either:
  // the window claims a cluster the checkpoint does not describe.
  assert.throws(() => validateRetentionSummary(
    { ...state, settledResultsByEventSeq: { ...state.settledResultsByEventSeq, broken: [undefined, undefined] } }, summary),
  /invalid PTC session-log projection retention window/u)
  assert.throws(() => validateRetentionSummary({ ...state, executableCalls: {} }, summary),
    /lost the call of a retained settlement/u)
})

test('a caller holding the log proves the recorded summary chain instead of trusting it', () => {
  // Admission receives no session log, so it can only check that a compacted
  // checkpoint's summary is internally consistent. A caller that does hold the log
  // recomputes the chain of the dropped range: a summary that certifies itself is
  // exactly what an earlier version let through.
  const events = []
  const payload = 'x'.repeat(2048)
  for (let index = 0; index < 12; index += 1) {
    const id = `verify-${index}`
    events.push(call(`return '${payload}'`, id), result(id))
  }
  const state = fold(events)
  const summary = state.retentionSummary
  assert.equal(summary.count, 4, 'the fixture folds four clusters into the summary')
  assert.deepEqual(verifyRetentionSummaryAgainstEvents(summary, lastHistory), summary)
  // Without the log there is nothing to verify, which is a refusal rather than an
  // acceptance: a caller that cannot read the events must not report a proved chain.
  assert.throws(() => verifyRetentionSummaryAgainstEvents(summary, undefined),
    /unverifiable PTC session-log projection retention summary/u)
  // A summary whose range no longer matches the log cannot be proved either.
  assert.throws(() => verifyRetentionSummaryAgainstEvents({ ...summary, chainDigest: 'b'.repeat(64) }, lastHistory),
    /inconsistent PTC session-log projection retention summary/u)
  assert.throws(() => verifyRetentionSummaryAgainstEvents({ ...summary, count: summary.count + 1 }, lastHistory),
    /inconsistent PTC session-log projection retention summary/u)
  // The same check refuses a range the log never dropped, so an empty claim is not
  // proved by vacuous agreement.
  assert.throws(() => verifyRetentionSummaryAgainstEvents({ ...summary, fromSeq: 0, toSeq: 0 }, lastHistory),
    /inconsistent PTC session-log projection retention summary/u)
})

test('an edit refolds the settlement its summary describes and refuses a disagreement', () => {
  // The checkpoint's summary and the log meet here: the log is folded again with
  // pruning disabled, the settlement behind the editable run is turned into a summary
  // record, and the recorded record must equal it.
  const events = []
  const payload = 'x'.repeat(2048)
  for (let index = 0; index < 12; index += 1) {
    const id = `refold-edit-${index}`
    events.push(call(`return '${payload}'`, id), result(id))
  }
  const state = fold(events)
  const summary = state.retentionSummary
  // The newest cluster is pinned, so a full refold of the whole log finds the run
  // outside the summary range and has nothing to compare.
  const newest = refoldEditableSettlement(lastHistory, summary)
  assert.equal(newest.run?.callSeq, state.editableRun.callSeq)
  assert.equal(newest.mismatch, false)
  // A log that ends inside the dropped range puts the editable run in the summary,
  // which is the only place both sides describe the same cluster. The recorded
  // record matches, so the edit may proceed on it.
  const cutoff = summary.toSeq
  const truncated = lastHistory.filter(event => event.seq <= cutoff)
  const matching = refoldEditableSettlement(truncated, summary)
  assert.ok(matching.run !== undefined, 'the refold reads the cell from the log')
  assert.equal(matching.mismatch, false, 'the summary describes the cluster the log holds')
  // The same cluster with a record that names different bytes is not the one the log
  // holds: neither side may be used, so the caller is told they disagree.
  const damaged = { ...summary, entries: summary.entries.map((entry, index) => index === summary.entries.length - 1
    ? { ...entry, argumentsDigest: 'c'.repeat(64) } : entry) }
  const mismatched = refoldEditableSettlement(truncated, damaged)
  assert.equal(mismatched.run?.callSeq, matching.run.callSeq)
  assert.equal(mismatched.mismatch, true)
  // A summary that does not name the cluster at all yields the run alone: there is
  // nothing to disagree with.
  const unnamed = refoldEditableSettlement(truncated, { ...summary, entries: summary.entries.slice(0, -1) })
  assert.equal(unnamed.run?.callSeq, matching.run.callSeq)
  assert.equal(unnamed.mismatch, false)
  // A caller without events gets no run and no disagreement claim.
  assert.deepEqual(refoldEditableSettlement(undefined, summary), { run: undefined, mismatch: false })
})
