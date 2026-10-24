// The retention window is a module constant; lower it before the recovery module
// loads so a small synthetic session can cross it.
process.env.DSH_PTC_RETENTION_RUNS = '3'
process.env.DSH_PTC_RETENTION_BYTES = '4096'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { advanceSessionTimeline, createSessionTimelineState, validateSessionTimelineState } =
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

function fold(events) {
  let state = createSessionTimelineState()
  const history = [{ seq: next(), type: 'turn/start', data: {} }, ...events]
  for (let index = 0; index < history.length; index += 1) state = advanceSessionTimeline(state, history[index], index)
  return state
}

const settlements = state => Object.values(state.settledResultsByEventSeq).map(pair => pair[1])

test('the retention window drops old payloads and keeps the projection bounded', () => {
  const events = []
  const payload = 'x'.repeat(2048)
  for (let index = 0; index < 10; index += 1) {
    const id = `call-${index}`
    events.push(call(`return '${payload}'`, id), result(id))
  }
  const state = fold(events)
  const all = settlements(state)
  assert.equal(all.length, 10, 'every call settles')

  const retained = all.filter(settlement => settlement.pruned !== true)
  const pruned = all.filter(settlement => settlement.pruned === true)
  assert.ok(retained.length >= 1 && retained.length <= 3, `the window keeps at most three runs: ${retained.length}`)
  assert.ok(pruned.length >= 7, `older settlements are pruned: ${pruned.length}`)
  assert.ok(state.retainedBytes <= 4096 * 2, `retained bytes stay bounded: ${state.retainedBytes}`)

  for (const settlement of pruned) {
    assert.equal(settlement.call.data.arguments, undefined, 'pruned call keeps no argument text')
    assert.match(settlement.call.data.argumentsDigest, /^[a-f0-9]{64}$/u)
    assert.ok(settlement.call.data.argumentsBytes > 0)
    assert.equal(settlement.normalized.journal, undefined, 'pruned result keeps no journal text')
    assert.match(settlement.normalized.payloadDigest, /^[a-f0-9]{64}$/u)
  }
  for (const settlement of retained) {
    assert.equal(typeof settlement.call.data.arguments, 'string', 'window entries keep their text')
  }

  // The pruned checkpoint is still admissible under the digest-bound claim.
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
