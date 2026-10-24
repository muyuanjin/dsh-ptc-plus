// The retention window is a module constant; lower it before the recovery module
// loads so a small synthetic session can cross it. The byte budget is wide enough
// for a few 2 KB cells so the count window is what this file exercises; the
// oversized-cell case below shrinks it again on its own.
process.env.DSH_PTC_RETENTION_RUNS = '3'
process.env.DSH_PTC_RETENTION_BYTES = '65536'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { advanceSessionTimeline, createSessionTimelineState, validateRetentionSummary,
  verifyRetentionSummaryAgainstEvents, validateSessionTimelineState, withFullRetention } =
  await import('../internal/session-journal-recovery.js')
const { JOURNAL_KEY, JOURNAL_VERSION } = await import('../internal/session-journal.js')

function journal(overrides = {}) {
  return {
    version: JOURNAL_VERSION,
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: { kind: 'return' },
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

const settlements = state => Object.values(state.settledResultsByEventSeq).map(pair => pair[1])

test('the retention window drops whole clusters and keeps one summary', () => {
  const events = []
  const payload = 'x'.repeat(2048)
  for (let index = 0; index < 10; index += 1) {
    const id = `call-${index}`
    events.push(call(`return '${payload}'`, id), result(id))
  }
  const state = fold(events)

  // Only the window survives; a dropped cluster leaves no stub behind, because one
  // stub per settled cell would still scale with how many cells the session ran.
  const retained = settlements(state)
  assert.ok(retained.length >= 1 && retained.length <= 3, `the window keeps at most three runs: ${retained.length}`)
  for (const settlement of retained) {
    assert.equal(settlement.pruned, undefined, 'a retained settlement is a complete cluster')
    assert.equal(typeof settlement.call.data.arguments, 'string', 'window entries keep their text')
  }
  const droppedCount = 10 - retained.length
  assert.ok(droppedCount >= 7, `older settlements are dropped: ${droppedCount}`)

  // The dropped clusters are gone from every table they used to occupy.
  const retainedCallSeqs = new Set(retained.map(settlement => settlement.call.seq))
  assert.equal(Object.keys(state.executableCalls).length, retainedCallSeqs.size,
    'executable calls keep only the retained window')
  assert.equal(Object.keys(state.results).length, retained.length,
    'normalized results keep only the retained window')

  // One chained summary stands in for everything dropped.
  const summary = state.retentionSummary
  assert.ok(summary !== null && summary !== undefined, 'the checkpoint carries a retention summary')
  assert.equal(summary.count, droppedCount, 'the summary counts exactly the dropped settlements')
  assert.match(summary.chainDigest, /^[a-f0-9]{64}$/u)
  for (const key of Object.keys(state.settledResultsByEventSeq)) {
    const seq = Number(key.slice(1))
    assert.ok(seq > summary.toSeq, 'no settlement survives below the retention boundary')
  }
  assert.ok(state.retainedBytes <= 4096 * 2, `retained bytes stay bounded: ${state.retainedBytes}`)

  // The compacted checkpoint is still admissible under the summary claim.
  validateSessionTimelineState(state)
})

test('the newest run always stays inside the window so tips and edits keep working', () => {
  const events = []
  for (let index = 0; index < 6; index += 1) {
    const id = `keep-${index}`
    events.push(call(`return ${index}`, id), result(id))
  }
  const state = fold(events)
  assert.ok(state.latestRun?.source !== undefined, 'latestRun keeps its source')
  assert.equal(state.editableRun?.source, state.latestRun?.source)
})

test('a dropped cluster can be refolded from the same events', () => {
  const events = []
  for (let index = 0; index < 6; index += 1) {
    const id = `refold-${index}`
    events.push(call(`return 'refold-${index}'`, id), result(id))
  }
  const pruned = fold(events)
  const droppedCount = pruned.retentionSummary?.count ?? 0
  assert.ok(droppedCount >= 1, 'the window drops at least one cluster')
  assert.equal(Object.keys(pruned.settledResultsByEventSeq).length, 6 - droppedCount,
    'only the window survives in the checkpoint')

  // The same slice folded with retention disabled keeps what the checkpoint dropped,
  // which is exactly what the edit path does when it needs an old cell.
  let full
  withFullRetention(() => { full = fold(events) })
  assert.equal(full.retentionSummary, null, 'a full-retention fold never prunes')
  assert.equal(Object.keys(full.settledResultsByEventSeq).length, 6,
    'the refolded slice contains the dropped clusters')
})

test('the summary is proved against the log instead of certifying itself', () => {
  const events = []
  for (let index = 0; index < 8; index += 1) {
    const id = `summary-${index}`
    events.push(call(`return 'summary-${index}'`, id), result(id))
  }
  const state = fold(events)
  const logFacts = lastHistory.map((event, index) => ({ index, event }))
  const summary = state.retentionSummary
  assert.ok(summary !== undefined, 'the fold dropped at least one cluster')

  // Without the raw log admission can prove the boundary and the range only; the
  // state itself no longer carries the observations the dropped clusters owned.
  validateRetentionSummary(state, summary)

  // With the raw log in hand the chain must match what folding the dropped range
  // gives, and every tampered field must be rejected as a mismatch.
  verifyRetentionSummaryAgainstEvents(summary, lastHistory)
  assert.throws(() => verifyRetentionSummaryAgainstEvents({ ...summary, chainDigest: 'a'.repeat(64) }, lastHistory),
    /inconsistent PTC session-log projection retention summary/u)
  assert.throws(() => verifyRetentionSummaryAgainstEvents({ ...summary, count: summary.count + 1 }, lastHistory),
    /inconsistent PTC session-log projection retention summary/u)
  assert.throws(() => verifyRetentionSummaryAgainstEvents({ ...summary, fromSeq: 1 }, lastHistory),
    /inconsistent PTC session-log projection retention summary/u)
  // A caller that cannot supply the log must say so rather than accept silently.
  assert.throws(() => verifyRetentionSummaryAgainstEvents(summary, undefined),
    /unverifiable PTC session-log projection retention summary/u)
  // The boundary itself is still enforced from the state.
  assert.throws(() => validateRetentionSummary(state, { ...summary, toSeq: summary.toSeq + 2 }),
    /PTC session-log projection/u)
})
