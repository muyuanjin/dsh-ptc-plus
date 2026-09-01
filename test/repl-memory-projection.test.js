import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPL_MEMORY_META_KEY,
  createReplMemoryProjection,
  createReplMemorySnapshot,
  normalizeReplMemorySnapshot,
  unavailableReplMemorySnapshot,
  withReplMemorySnapshot,
} from '../internal/repl-memory-projection.js'
import { prepareProgram } from '../internal/cell-analysis.js'
import { BindingCatalog } from '../internal/session-state.js'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'

const GENERATION = 'test-runtime-generation'
const OTHER_GENERATION = 'other-runtime-generation'
const REWRITES = Object.freeze({
  autoRewriteImports: true,
  autoStripExports: true,
  autoSplitRedeclarations: true,
})

function toolCall(seq, callId = `call-${seq}`, name = 'run_code') {
  return {
    type: 'tool/call',
    seq,
    data: { turn: 1, step: 1, callId, name, arguments: '{}' },
  }
}

function toolResult(seq, callId, meta, options = {}) {
  return {
    type: 'tool/result',
    seq,
    surfaceOp: options.surfaceOp ?? 'append',
    ...(options.sourceEventSeqs === undefined
      ? {}
      : { sourceEventSeqs: options.sourceEventSeqs }),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `message-${callId}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
      },
      ...(meta === undefined ? {} : { meta }),
    },
  }
}

function projection(generation = GENERATION) {
  return createReplMemoryProjection(generation)
}

function foldProjection(events, generation = GENERATION) {
  const definition = projection(generation)
  return events.reduce(
    (state, event) => definition.apply(state, event),
    definition.init({}),
  )
}

function projectedMemory(events, generation = GENERATION) {
  const definition = projection(generation)
  return definition.wire.view(foldProjection(events, generation))
}

function resultMemory(result) {
  return result.meta[REPL_MEMORY_META_KEY].memory
}

function binding(name, kind = 'variable', source = `const ${name} = 1`, line = 1, column = 1) {
  return { name, kind, definition: { source, line, column } }
}

test('retains bounded definition provenance without reading runtime values', () => {
  const source = "import path from 'node:path'\nconst answer = 42\nfunction load() { return answer }\nclass Widget {}"
  const prepared = prepareProgram(source, new Set(), true, new Set(), REWRITES)
  const snapshot = new BindingCatalog().advance(prepared, source).snapshot()
  assert.deepEqual(snapshot, [
    binding('Widget', 'class', 'class Widget {}', 4),
    binding('load', 'function', 'function load() { return answer }', 3),
    binding('answer', 'variable', 'const answer = 42', 2),
    binding('path', 'import', "import path from 'node:path'"),
  ])
})

test('retains original provenance for every synthetic default-export binding', () => {
  for (const [source, kind] of [
    ['export default function namedDefault() {}', 'function'],
    ['export default function () {}', 'function'],
    ['export default class NamedDefault {}', 'class'],
    ['export default class {}', 'class'],
    ['export default 42', 'variable'],
  ]) {
    const prepared = prepareProgram(source, new Set(), true, new Set(), REWRITES)
    const entry = new BindingCatalog().advance(prepared, source).snapshot()
      .find(bindingEntry => bindingEntry.name === '__default')
    assert.deepEqual(entry, binding('__default', kind, source), source)
  }
})

test('indexes source once and reuses bounded definitions shared by many bindings', () => {
  const names = Array.from({ length: 160 }, (_, index) => `value${index}`)
  const source = `let ${names.map((name, index) => `${name} = ${index}`).join(', ')}`
  const prepared = prepareProgram(source, new Set(), true, new Set(), REWRITES)
  const snapshot = new BindingCatalog().advance(prepared, source).snapshot()
  const firstDefinition = snapshot[0].definition

  assert.equal(firstDefinition.source.length, 1024)
  assert.match(firstDefinition.source, /\.\.\.$/)
  for (const entry of snapshot) assert.equal(entry.definition, firstDefinition)
})

test('presents bindings as a LIFO stack and moves redeclarations to the top', () => {
  const firstSource = 'const first = 1\nconst second = 2'
  const first = new BindingCatalog().advance(
    prepareProgram(firstSource, new Set(), true, new Set(), REWRITES),
    firstSource,
  )
  const secondSource = 'const third = 3\nconst first = 4'
  const second = first.advance(
    prepareProgram(secondSource, first.inputs().knownBindings, true, new Set(), REWRITES),
    secondSource,
  )
  assert.deepEqual(second.snapshot().map(entry => entry.name), ['first', 'third', 'second'])
  assert.equal(second.snapshot()[0].definition.source, 'const first = 4')
})

test('projects a bounded value-independent binding inventory through formal call identity', () => {
  const snapshot = createReplMemorySnapshot([
    binding('Widget', 'class', 'class Widget {}', 4),
    binding('answer', 'variable', 'const answer = 42', 2),
    binding('load', 'function', 'function load() { return answer }', 3),
    binding('path', 'import', "import path from 'node:path'"),
  ])
  assert.deepEqual(snapshot, {
    available: true,
    entries: [
      binding('Widget', 'class', 'class Widget {}', 4),
      binding('answer', 'variable', 'const answer = 42', 2),
      binding('load', 'function', 'function load() { return answer }', 3),
      binding('path', 'import', "import path from 'node:path'"),
    ],
    total: 4,
    omitted: 0,
  })
  const projected = foldProjection([
    toolCall(4, 'memory-call'),
    toolResult(5, 'memory-call', withReplMemorySnapshot(undefined, snapshot, GENERATION)),
  ])
  assert.deepEqual(projection().wire.view(projected), snapshot)
  assert.equal(Object.hasOwn(projected.memory.entries[0], 'value'), false)
})

test('accepts callId pairing without optional source provenance', () => {
  const snapshot = createReplMemorySnapshot([binding('answer')])
  const withoutSources = projectedMemory([
    toolCall(0, 'without-sources'),
    toolResult(1, 'without-sources', withReplMemorySnapshot(undefined, snapshot, GENERATION)),
  ])
  assert.deepEqual(withoutSources, snapshot)

  const unrelatedSources = projectedMemory([
    toolCall(2, 'with-unrelated-sources'),
    toolResult(3, 'with-unrelated-sources', withReplMemorySnapshot(undefined, snapshot, GENERATION), {
      sourceEventSeqs: [0],
    }),
  ])
  assert.deepEqual(unrelatedSources, snapshot)
})

test('bounds inventories and rejects malformed snapshots', () => {
  const bindings = Array.from({ length: 140 }, (_, index) => ({
    name: `binding${String(index).padStart(3, '0')}`,
    kind: 'variable',
    definition: { source: `const binding${String(index).padStart(3, '0')} = 1`, line: 1, column: 1 },
  }))
  bindings[0] = binding('x'.repeat(129))
  const bounded = createReplMemorySnapshot(bindings)
  assert.equal(bounded.entries.length, 128)
  assert.equal(bounded.total, 139)
  assert.equal(bounded.omitted, 11)

  const sourceBounded = createReplMemorySnapshot(Array.from(
    { length: 40 },
    (_, index) => binding(`large${String(index).padStart(2, '0')}`, 'variable', 'x'.repeat(600)),
  ))
  assert.equal(sourceBounded.entries.length, 27)
  assert.equal(sourceBounded.total, 40)
  assert.equal(sourceBounded.omitted, 13)

  for (const malformed of [
    { ...bounded, extra: true },
    { ...bounded, omitted: 0 },
    { available: true, entries: [{ ...binding('x'), extra: true }], total: 1, omitted: 0 },
    { available: true, entries: [{ ...binding('x'), definition: { source: '', line: 1, column: 1 } }], total: 1, omitted: 0 },
    { available: true, entries: [binding('x', 'value')], total: 1, omitted: 0 },
    { available: true, entries: [binding('x'), binding('x', 'class')], total: 2, omitted: 0 },
    { available: false, entries: [binding('x')], total: 1, omitted: 0 },
  ]) assert.throws(() => normalizeReplMemorySnapshot(malformed), /dsh-ptc-plus REPL (?:memory|binding)/)

  assert.throws(() => normalizeReplMemorySnapshot({
    available: true,
    entries: Array.from(
      { length: 17 },
      (_, index) => binding(`aggregate${String(index).padStart(2, '0')}`, 'variable', 'x'.repeat(1024)),
    ),
    total: 17,
    omitted: 0,
  }), /presentation budget/)
})

test('does not let missing, malformed, foreign, or replacement results erase proven memory', () => {
  const snapshot = createReplMemorySnapshot([binding('safe')])
  const current = foldProjection([
    toolCall(0, 'observed'),
    toolResult(1, 'observed', withReplMemorySnapshot(undefined, snapshot, GENERATION)),
  ])
  const definition = projection()

  assert.equal(definition.apply(current, toolCall(2, 'read-call', 'read')), current)
  assert.equal(definition.apply(current, toolResult(3, 'read-call', {})), current)
  assert.equal(definition.apply(current, toolResult(3, 'unknown', {})), current)

  const missingPending = definition.apply(current, toolCall(4, 'missing'))
  const missing = definition.apply(missingPending, toolResult(5, 'missing', {}))
  assert.deepEqual(definition.wire.view(missing), snapshot)
  assert.deepEqual(missing.pendingReplCalls, [])

  const malformedPending = definition.apply(current, toolCall(6, 'malformed', 'edit_run_code'))
  const malformed = definition.apply(malformedPending, toolResult(7, 'malformed', {
    [REPL_MEMORY_META_KEY]: { available: true },
  }))
  assert.deepEqual(definition.wire.view(malformed), snapshot)

  const foreignPending = definition.apply(current, toolCall(8, 'foreign'))
  const foreign = definition.apply(foreignPending, toolResult(9, 'foreign',
    withReplMemorySnapshot(undefined,
      createReplMemorySnapshot([binding('stale')]),
      OTHER_GENERATION)))
  assert.deepEqual(definition.wire.view(foreign), snapshot)

  const replacementPending = definition.apply(current, toolCall(10, 'replacement'))
  assert.equal(definition.apply(replacementPending, toolResult(11, 'replacement',
    withReplMemorySnapshot(undefined, snapshot, GENERATION), { surfaceOp: 'replace' })), replacementPending)
})

test('invalidates live proof at runtime-generation and session-seed boundaries', () => {
  const snapshot = createReplMemorySnapshot([binding('liveOnly')])
  const events = [
    toolCall(0, 'old-generation'),
    toolResult(1, 'old-generation', withReplMemorySnapshot(undefined, snapshot, OTHER_GENERATION)),
  ]
  assert.deepEqual(projectedMemory(events), unavailableReplMemorySnapshot())

  const current = foldProjection([
    toolCall(2, 'current-generation'),
    toolResult(3, 'current-generation', withReplMemorySnapshot(undefined, snapshot, GENERATION)),
  ])
  const definition = projection()
  assert.deepEqual(definition.wire.view(current), snapshot)
  assert.deepEqual(
    definition.wire.view(definition.apply(current, { type: 'session/end-seed', seq: 4, data: {} })),
    unavailableReplMemorySnapshot(),
  )
})

test('validates generation-bound projection state and bounded pending calls', () => {
  for (const generation of [null, 7, '', 'x'.repeat(129)]) {
    assert.throws(() => projection(generation), /REPL memory generation/)
  }
  const definition = projection()
  const initial = definition.init({})
  assert.deepEqual(definition.stateSchema.parse(structuredClone(initial)), initial)
  assert.deepEqual(definition.stateSchema.parse({
    generation: OTHER_GENERATION,
    memory: { corrupt: true },
    pendingReplCalls: 'corrupt',
  }), initial)
  for (const malformed of [
    unavailableReplMemorySnapshot(),
    { generation: GENERATION, memory: unavailableReplMemorySnapshot(), pendingReplCalls: [{ callId: 'b', seq: 2 }, { callId: 'a', seq: 1 }] },
    { generation: GENERATION, memory: unavailableReplMemorySnapshot(), pendingReplCalls: [{ callId: 'same', seq: 1 }, { callId: 'same', seq: 2 }] },
    {
      generation: GENERATION,
      memory: createReplMemorySnapshot([binding('stale')]),
      pendingReplCalls: null,
    },
    {
      generation: GENERATION,
      memory: unavailableReplMemorySnapshot(),
      pendingReplCalls: Array.from({ length: 257 }, (_, index) => ({ callId: `call-${index}`, seq: index })),
    },
  ]) assert.throws(() => definition.stateSchema.parse(malformed), /dsh-ptc-plus/)

  let overflow = initial
  for (let seq = 0; seq <= 512; seq += 2) {
    overflow = definition.apply(overflow, toolCall(seq, `overflow-${seq}`))
  }
  assert.deepEqual(overflow, {
    generation: GENERATION,
    memory: unavailableReplMemorySnapshot(),
    pendingReplCalls: null,
  })
  assert.deepEqual(definition.stateSchema.parse(structuredClone(overflow)), overflow)
  assert.equal(definition.apply(overflow, toolCall(513, 'ignored')), overflow)
  assert.equal(definition.apply(overflow, toolResult(514, 'overflow-0', {})), overflow)
  assert.equal(definition.apply(initial, { type: 'message/create', seq: 515, data: {} }), initial)
})

test('distinguishes unavailable memory from an observed empty REPL', () => {
  assert.deepEqual(unavailableReplMemorySnapshot(), {
    available: false, entries: [], total: 0, omitted: 0,
  })
  assert.deepEqual(createReplMemorySnapshot([]), {
    available: true, entries: [], total: 0, omitted: 0,
  })
})

test('publishes the complete post-cell reusable inventory as private metadata', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const first = await state.runDurable('memory-session', `
const answer = 42
function load() { return answer }
class Widget {}
return answer
`)
  assert.equal(first.meta[REPL_MEMORY_META_KEY].version, 3)
  assert.equal(typeof first.meta[REPL_MEMORY_META_KEY].generation, 'string')
  assert.deepEqual(resultMemory(first).entries, [
    binding('Widget', 'class', 'class Widget {}', 4),
    binding('load', 'function', 'function load() { return answer }', 3),
    binding('answer', 'variable', 'const answer = 42', 2),
  ])

  const second = await state.runDurable('memory-session', 'const next = answer + 1; return next')
  assert.equal(
    second.meta[REPL_MEMORY_META_KEY].generation,
    first.meta[REPL_MEMORY_META_KEY].generation,
  )
  assert.deepEqual(resultMemory(second).entries.map(entry => entry.name), [
    'next', 'Widget', 'load', 'answer',
  ])
})

test('shows volatile live bindings but rejects them after runtime reactivation', async (t) => {
  const events = []
  const session = { id: 'volatile-memory-session', events }
  const live = fixture()
  t.after(() => live.dispose())
  const code = 'const volatileOnly = Date.now()'
  const result = await live.runDurable(session.id, code, {}, {
    session, callId: 'volatile-memory-call',
  })
  assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(resultMemory(result).entries, [
    binding('volatileOnly', 'variable', code),
  ])
  appendRunCodeEvents(events, 'volatile-memory-call', code, result)
  const liveGeneration = result.meta[REPL_MEMORY_META_KEY].generation
  assert.deepEqual(projectedMemory(events, liveGeneration), resultMemory(result))
  await live.dispose()

  const cold = fixture()
  t.after(() => cold.dispose())
  const recoveredCode = 'return typeof volatileOnly'
  const recovered = await cold.runDurable(session.id, recoveredCode, {}, {
    session, callId: 'cold-memory-call',
  })
  assert.equal(recovered.value, 'undefined')
  assert.equal(recovered.meta.dshPtcPlus.diagnostics[0]?.code, 'PTC-R002')
  const coldGeneration = recovered.meta[REPL_MEMORY_META_KEY].generation
  assert.notEqual(coldGeneration, liveGeneration)
  assert.deepEqual(projectedMemory(events, coldGeneration), unavailableReplMemorySnapshot())
  appendRunCodeEvents(events, 'cold-memory-call', recoveredCode, recovered)
  assert.deepEqual(projectedMemory(events, coldGeneration), createReplMemorySnapshot([]))
})

test('repopulates the restored binding surface after the reset is materialized', async (t) => {
  const events = []
  const session = { id: 'restored-memory-session', events }
  const state = fixture()
  t.after(() => state.dispose())

  const setupCode = `
let stableValue = 1
void await repl.state({ action: 'save', name: 'stable' })
`
  const setup = await state.runDurable(session.id, setupCode, {}, { session, callId: 'setup' })
  appendRunCodeEvents(events, 'setup', setupCode, setup)
  const generation = setup.meta[REPL_MEMORY_META_KEY].generation
  assert.deepEqual(projectedMemory(events, generation).entries.map(entry => entry.name), ['stableValue'])

  const volatileCode = 'const liveOnly = Date.now()'
  const volatile = await state.runDurable(session.id, volatileCode, {}, { session, callId: 'volatile' })
  appendRunCodeEvents(events, 'volatile', volatileCode, volatile)
  assert.deepEqual(projectedMemory(events, generation).entries.map(entry => entry.name), [
    'liveOnly', 'stableValue',
  ])

  const restoreCode = "void await repl.state({ action: 'restore', name: 'stable' })"
  const restored = await state.runDurable(session.id, restoreCode, {}, { session, callId: 'restore' })
  appendRunCodeEvents(events, 'restore', restoreCode, restored)
  assert.deepEqual(projectedMemory(events, generation), unavailableReplMemorySnapshot())

  const materializeCode = 'return stableValue'
  const materialized = await state.runDurable(session.id, materializeCode, {}, {
    session, callId: 'materialized',
  })
  appendRunCodeEvents(events, 'materialized', materializeCode, materialized)
  assert.equal(materialized.value, 1)
  assert.deepEqual(projectedMemory(events, generation).entries.map(entry => entry.name), ['stableValue'])
})
