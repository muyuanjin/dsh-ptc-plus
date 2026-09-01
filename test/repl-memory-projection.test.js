import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPL_MEMORY_META_KEY,
  createReplMemorySnapshot,
  normalizeReplMemorySnapshot,
  replMemoryProjection,
  unavailableReplMemorySnapshot,
  withReplMemorySnapshot,
} from '../internal/repl-memory-projection.js'
import { prepareProgram } from '../internal/cell-analysis.js'
import { BindingCatalog } from '../internal/session-state.js'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'

const REWRITES = Object.freeze({
  autoRewriteImports: true,
  autoStripExports: true,
  autoSplitRedeclarations: true,
})

function toolCall(seq, name = 'run_code') {
  return { type: 'tool/call', seq, data: { name } }
}

function toolResult(seq, sourceEventSeqs, meta) {
  return {
    type: 'tool/result',
    seq,
    sourceEventSeqs,
    data: meta === undefined ? {} : { meta },
  }
}

function foldProjection(events) {
  return events.reduce(
    (state, event) => replMemoryProjection.apply(state, event),
    replMemoryProjection.init({}),
  )
}

test('classifies persistent variables, functions, classes, and imports without reading values', () => {
  const prepared = prepareProgram(`
import path from 'node:path'
const answer = 42
function load() { return answer }
class Widget {}
`, new Set(), true, new Set(), REWRITES)
  const snapshot = new BindingCatalog().advance(prepared).snapshot()
  assert.deepEqual(snapshot, [
    { name: 'Widget', kind: 'class' },
    { name: 'answer', kind: 'variable' },
    { name: 'load', kind: 'function' },
    { name: 'path', kind: 'import' },
  ])
})

test('projects a bounded value-free binding inventory from result metadata', () => {
  const snapshot = createReplMemorySnapshot([
    { name: 'Widget', kind: 'class' },
    { name: 'answer', kind: 'variable' },
    { name: 'load', kind: 'function' },
    { name: 'path', kind: 'import' },
  ])
  assert.deepEqual(snapshot, {
    available: true,
    entries: [
      { name: 'Widget', kind: 'class' },
      { name: 'answer', kind: 'variable' },
      { name: 'load', kind: 'function' },
      { name: 'path', kind: 'import' },
    ],
    total: 4,
    omitted: 0,
  })
  const projected = foldProjection([
    toolCall(4),
    toolResult(5, [4], withReplMemorySnapshot(undefined, snapshot)),
  ])
  assert.deepEqual(replMemoryProjection.wire.view(projected), snapshot)
  assert.equal(Object.hasOwn(projected.memory.entries[0], 'value'), false)
})

test('bounds oversized inventories and rejects malformed or non-canonical snapshots', () => {
  const bindings = Array.from({ length: 140 }, (_, index) => ({
    name: `binding${String(index).padStart(3, '0')}`,
    kind: 'variable',
  }))
  bindings[0] = { name: 'x'.repeat(129), kind: 'variable' }
  const bounded = createReplMemorySnapshot(bindings)
  assert.equal(bounded.entries.length, 128)
  assert.equal(bounded.total, 140)
  assert.equal(bounded.omitted, 12)

  for (const malformed of [
    { ...bounded, extra: true },
    { ...bounded, omitted: 0 },
    { available: true, entries: [{ name: 'x', kind: 'value' }], total: 1, omitted: 0 },
    { available: true, entries: [{ name: 'z', kind: 'variable' }, { name: 'a', kind: 'class' }], total: 2, omitted: 0 },
    { available: false, entries: [{ name: 'x', kind: 'variable' }], total: 1, omitted: 0 },
  ]) assert.throws(() => normalizeReplMemorySnapshot(malformed), /dsh-ptc-plus REPL memory/)

  const previous = foldProjection([
    toolCall(0),
    toolResult(1, [0], withReplMemorySnapshot(undefined,
      createReplMemorySnapshot([{ name: 'safe', kind: 'variable' }]))),
  ])
  const pending = replMemoryProjection.apply(previous, toolCall(2))
  assert.equal(replMemoryProjection.wire.view(pending), replMemoryProjection.wire.view(previous))
  const unavailable = replMemoryProjection.apply(pending, toolResult(3, [2], {
    [REPL_MEMORY_META_KEY]: { status: 'corrupt' },
  }))
  assert.equal(replMemoryProjection.wire.view(unavailable), unavailableReplMemorySnapshot())
  assert.equal(replMemoryProjection.apply(previous, { type: 'assistant/message' }), previous)
})

test('fails closed only when a linked REPL result omits or damages memory metadata', () => {
  const snapshot = createReplMemorySnapshot([{ name: 'safe', kind: 'variable' }])
  const current = foldProjection([
    toolCall(0),
    toolResult(1, [0], withReplMemorySnapshot(undefined, snapshot)),
  ])
  const unrelatedCall = replMemoryProjection.apply(current, toolCall(2, 'read'))
  assert.equal(unrelatedCall, current)
  const unrelatedResult = replMemoryProjection.apply(current, toolResult(3, [2], {}))
  assert.equal(unrelatedResult, current)
  assert.equal(replMemoryProjection.apply(current, toolResult(3, undefined, {})), current)

  const runPending = replMemoryProjection.apply(current, toolCall(4))
  assert.equal(replMemoryProjection.apply(runPending, toolCall(4)), runPending)
  const missing = replMemoryProjection.apply(runPending, toolResult(5, [4], {}))
  assert.equal(replMemoryProjection.wire.view(missing), unavailableReplMemorySnapshot())

  const editPending = replMemoryProjection.apply(current, toolCall(6, 'edit_run_code'))
  const malformed = replMemoryProjection.apply(editPending, toolResult(7, [6], {
    [REPL_MEMORY_META_KEY]: { available: true },
  }))
  assert.equal(replMemoryProjection.wire.view(malformed), unavailableReplMemorySnapshot())
})

test('validates the bounded plain-JSON projection state separately from its wire value', () => {
  const initial = replMemoryProjection.init({})
  assert.deepEqual(replMemoryProjection.stateSchema.parse(structuredClone(initial)), initial)
  for (const malformed of [
    unavailableReplMemorySnapshot(),
    { memory: unavailableReplMemorySnapshot(), pendingReplCallSeqs: [2, 1] },
    { memory: unavailableReplMemorySnapshot(), pendingReplCallSeqs: [1, 1] },
    {
      memory: createReplMemorySnapshot([{ name: 'stale', kind: 'variable' }]),
      pendingReplCallSeqs: null,
    },
    {
      memory: unavailableReplMemorySnapshot(),
      pendingReplCallSeqs: Array.from({ length: 257 }, (_, index) => index),
    },
  ]) assert.throws(() => replMemoryProjection.stateSchema.parse(malformed), /dsh-ptc-plus/)

  let overflow = initial
  for (let seq = 0; seq <= 512; seq += 2) {
    overflow = replMemoryProjection.apply(overflow, toolCall(seq))
  }
  assert.deepEqual(overflow, {
    memory: unavailableReplMemorySnapshot(),
    pendingReplCallSeqs: null,
  })
  assert.deepEqual(replMemoryProjection.stateSchema.parse(structuredClone(overflow)), overflow)
  assert.equal(replMemoryProjection.apply(overflow, toolCall(513)), overflow)
  assert.equal(replMemoryProjection.apply(overflow, toolResult(514, [0], {})), overflow)

  const observed = foldProjection([
    toolCall(0),
    toolResult(1, [0], withReplMemorySnapshot(undefined,
      createReplMemorySnapshot([{ name: 'safe', kind: 'variable' }]))),
  ])
  assert.deepEqual(replMemoryProjection.apply(observed, toolCall('invalid')), overflow)
})

test('distinguishes an unavailable legacy snapshot from an empty observed REPL', () => {
  assert.deepEqual(unavailableReplMemorySnapshot(), {
    available: false, entries: [], total: 0, omitted: 0,
  })
  assert.deepEqual(createReplMemorySnapshot([]), {
    available: true, entries: [], total: 0, omitted: 0,
  })
})

test('publishes the complete post-cell binding inventory as private presentation metadata', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const first = await state.runDurable('memory-session', `
const answer = 42
function load() { return answer }
class Widget {}
return answer
`)
  assert.deepEqual(first.meta[REPL_MEMORY_META_KEY].entries, [
    { name: 'Widget', kind: 'class' },
    { name: 'answer', kind: 'variable' },
    { name: 'load', kind: 'function' },
  ])

  const second = await state.runDurable('memory-session', 'const next = answer + 1; return next')
  assert.deepEqual(second.meta[REPL_MEMORY_META_KEY].entries.map(entry => entry.name), [
    'Widget', 'answer', 'load', 'next',
  ])
})

test('does not advertise volatile-only bindings before or after cold recovery', async (t) => {
  const events = []
  const session = { id: 'volatile-memory-session', events }
  const live = fixture()
  t.after(() => live.dispose())
  const code = 'const volatileOnly = Date.now()'
  const result = await live.runDurable(session.id, code, {}, { session })
  assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(result.meta[REPL_MEMORY_META_KEY], unavailableReplMemorySnapshot())
  appendRunCodeEvents(events, 'volatile-memory-call', code, result)
  assert.deepEqual(
    replMemoryProjection.wire.view(foldProjection(events)),
    unavailableReplMemorySnapshot(),
  )
  await live.dispose()

  const cold = fixture()
  t.after(() => cold.dispose())
  const recovered = await cold.run(session.id, 'return typeof volatileOnly', {}, { session })
  assert.equal(recovered.value, 'undefined')
  assert.match(recovered.logs[0], /warning\[PTC-R002\]/)
})
