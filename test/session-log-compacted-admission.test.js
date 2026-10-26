import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionLogProjection } from '../internal/session-log-view.js'
import { configureRetention } from '../internal/projection-retention.js'
import { JOURNAL_KEY, JOURNAL_VERSION } from '../internal/session-journal.js'

// A compacted checkpoint is the one shape admission cannot compare against a
// replay: the fold that dropped the clusters dropped their payload too. These
// cases pin what admission still proves for it (the retention summary) and what
// it must still reject.

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
    userBindingNames: [],
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
function call(code, callId) {
  seq += 1
  return { seq, type: 'tool/call', data: {
    turn: 1, step: 1, name: 'run_code', callId, arguments: JSON.stringify({ code, description: 'probe' }),
  } }
}

function result(callId) {
  seq += 1
  return { seq, type: 'tool/result', data: {
    callId,
    isError: false,
    message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: 'ok' }] },
    meta: { [JOURNAL_KEY]: journal() },
  } }
}

function foldIntoProjection(projection, cells) {
  let checkpoint = projection.init()
  let index = 0
  const append = event => {
    checkpoint = projection.apply(checkpoint, { ...event, surfaceOp: { kind: 'append' } }, index)
    index += 1
  }
  append({ seq: 0, type: 'turn/start', data: {} })
  for (let cell = 0; cell < cells; cell += 1) {
    const id = `call_compacted_${cell}`
    append(call(`const value${cell} = ${cell}`, id))
    append(result(id))
  }
  return checkpoint
}

test('a compacted checkpoint is admitted by its retention summary', () => {
  const previous = configureRetention({ retentionPayloadRuns: 1, retentionClusters: 1 })
  try {
    const projection = createSessionLogProjection()
    const checkpoint = foldIntoProjection(projection, 4)
    assert.ok(checkpoint.timeline.retentionSummary, 'the window folded at least one cluster')
    const stored = JSON.parse(JSON.stringify(checkpoint))
    assert.deepEqual(projection.stateSchema.parse(stored), stored)
  } finally {
    configureRetention(previous)
  }
})

test('a compacted checkpoint whose summary disagrees with its retained window is rejected', () => {
  const previous = configureRetention({ retentionPayloadRuns: 1, retentionClusters: 1 })
  try {
    const projection = createSessionLogProjection()
    const checkpoint = foldIntoProjection(projection, 4)
    assert.ok(checkpoint.timeline.retentionSummary, 'the window folded at least one cluster')
    const tampered = JSON.parse(JSON.stringify(checkpoint))
    tampered.timeline.retentionSummary.chainDigest = 'f'.repeat(64)
    assert.throws(() => projection.stateSchema.parse(tampered), /PTC session-log projection/)
  } finally {
    configureRetention(previous)
  }
})

test('a checkpoint beyond the replay budget is admitted on its identity chain', () => {
  const projection = createSessionLogProjection({ replayBudgetBytes: 1 })
  const checkpoint = foldIntoProjection(projection, 1)
  const stored = JSON.parse(JSON.stringify(checkpoint))
  assert.deepEqual(projection.stateSchema.parse(stored), stored)
})
