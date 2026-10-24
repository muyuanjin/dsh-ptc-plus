// The retention window is a module constant; this file lowers it before the
// recovery module loads so a small synthetic session can cross it.
process.env.DSH_PTC_RETENTION_RUNS = '3'
process.env.DSH_PTC_RETENTION_BYTES = '4096'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { foldSessionTimeline, validateSessionTimelineState } = await import('../internal/session-journal-recovery.js')

const journal = completion => ({
  version: 1, bindingMode: 'loose', status: 'durable',
  calls: [], operations: [], confirms: [], diagnostics: [], completion,
})

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
function result(callId, body) {
  return { seq: next(), type: 'tool/result', data: {
    callId, isError: false,
    message: { role: 'tool', content: [{ type: 'text', text: body }] },
    meta: { 'dsh-ptc-plus': { journal: journal({ kind: 'return', value: 'ok' }) } },
  } }
}

test('the retention window drops old payloads and keeps the projection bounded', () => {
  const events = []
  const payload = 'x'.repeat(2048)
  for (let index = 0; index < 10; index += 1) {
    const id = `call-${index}`
    events.push(call(`return '${payload}'`, id), result(id, 'ok'))
  }
  const state = foldSessionTimeline(events)
  const settlements = Object.values(state.settledResultsByEventSeq)

  const retained = settlements.filter(settlement => settlement.pruned !== true)
  const pruned = settlements.filter(settlement => settlement.pruned === true)
  assert.equal(retained.length, 3, 'the window keeps the newest three runs')
  assert.equal(pruned.length, 7, 'older settlements are pruned')
  assert.ok(state.retainedBytes <= 4096 * 2, `retained bytes stay bounded: ${state.retainedBytes}`)

  for (const settlement of pruned) {
    assert.equal(settlement.call.data.arguments, undefined, 'pruned call keeps no argument text')
    assert.match(settlement.call.data.argumentsDigest, /^[a-f0-9]{64}$/u)
    assert.ok(settlement.call.data.argumentsBytes > 0)
    assert.equal(settlement.normalized.journal, undefined, 'pruned result keeps no journal text')
    assert.match(settlement.normalized.payloadDigest, /^[a-f0-9]{64}$/u)
    assert.equal(settlement.publication.journal, undefined)
    assert.match(settlement.publication.payloadDigest, /^[a-f0-9]{64}$/u)
  }
  for (const settlement of retained) {
    assert.equal(typeof settlement.call.data.arguments, 'string', 'window entries keep their text')
  }

  // The pruned checkpoint is still admissible under the digest-bound claim.
  validateSessionTimelineState(state)

  // Deleting an argument digest makes the checkpoint inadmissible again.
  const tampered = JSON.parse(JSON.stringify(state))
  const firstPruned = Object.values(tampered.settledResultsByEventSeq).find(entry => entry.pruned === true)
  firstPruned.call.data.argumentsDigest = 'f'.repeat(64)
  assert.throws(() => validateSessionTimelineState(tampered), /timeline checkpoint/u)
})

test('the newest run always stays inside the window so tips and edits keep working', () => {
  const events = []
  for (let index = 0; index < 6; index += 1) {
    const id = `keep-${index}`
    events.push(call(`return ${index}`, id), result(id, 'ok'))
  }
  const state = foldSessionTimeline(events)
  assert.ok(state.latestRun?.source !== undefined, 'latestRun keeps its source')
  assert.equal(state.editableRun?.source, state.latestRun?.source)
})
