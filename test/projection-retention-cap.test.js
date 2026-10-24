// A single cell larger than the whole byte budget must not defeat the bound: the
// window drops it and the edit path refolds it from the same log. Lower the budget
// before the recovery module loads.
process.env.DSH_PTC_RETENTION_RUNS = '3'
process.env.DSH_PTC_RETENTION_BYTES = '65536'

const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const { advanceSessionTimeline, createSessionTimelineState, withFullRetention } =
  await import('../internal/session-journal-recovery.js')
const { JOURNAL_KEY, JOURNAL_VERSION } = await import('../internal/session-journal.js')

function journal() {
  return {
    version: JOURNAL_VERSION, status: 'durable', calls: [], operations: [], confirms: [], diagnostics: [],
    completion: { kind: 'return' },
  }
}

let seq = 0
const next = () => { seq += 1; return seq }

function fold(events) {
  let state = createSessionTimelineState()
  const history = [{ seq: next(), type: 'turn/start', data: {} }, ...events]
  for (let index = 0; index < history.length; index += 1) state = advanceSessionTimeline(state, history[index], index)
  return state
}

test('a cell larger than the byte budget keeps its cluster and drops its payload', () => {
  const payload = 'x'.repeat(131072)
  const callSeq = next()
  const resultSeq = next()
  const events = [
    { seq: callSeq, type: 'tool/call', data: {
      turn: 1, step: 1, name: 'run_code', callId: 'huge',
      arguments: JSON.stringify({ code: `return '${payload}'`, description: 'huge cell' }),
    } },
    { seq: resultSeq, type: 'tool/result', data: {
      callId: 'huge', isError: false,
      message: { role: 'tool', source: { callId: 'huge' }, content: [{ type: 'text', text: 'ok' }] },
      meta: { [JOURNAL_KEY]: journal() },
    } },
  ]
  const state = fold(events)

  // The cell alone is larger than the budget, so its argument text never reaches the
  // checkpoint. The cluster itself stays: recovery reads its identity, observation and
  // normalized result, and only the source text is gone.
  const settlements = Object.values(state.settledResultsByEventSeq).map(pair => pair[1])
  assert.equal(settlements.length, 1, 'the cluster survives with a digested payload')
  assert.equal(typeof settlements[0].call.data.argumentsDigest, 'string')
  assert.equal(settlements[0].call.data.arguments, undefined, 'the argument text is not stored')
  assert.equal(Object.keys(state.executableCalls).length, 1, 'its executable entry survives')
  assert.equal(state.latestRun, undefined, 'the cached run no longer carries the dropped text')
  assert.equal(state.editableRun, undefined)
  assert.equal(state.retentionSummary ?? null, null, 'the payload window folds no cluster')

  // With the payload gone the serialized checkpoint is tiny even though the cell
  // carried 128 KB of code, twice the configured budget.
  const size = JSON.stringify(state).length
  assert.ok(size < 4096, `checkpoint stays bounded: ${size} bytes`)

  // The same events folded without the window still carry the cell, which is what
  // the edit path uses to recover it.
  let full
  withFullRetention(() => { full = fold(events) })
  const recovered = Object.values(full.settledResultsByEventSeq)[0]?.[1]
  assert.equal(recovered?.call?.data?.arguments, JSON.stringify({ code: `return '${payload}'`, description: 'huge cell' }))
})
