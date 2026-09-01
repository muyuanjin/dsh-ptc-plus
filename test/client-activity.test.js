import assert from 'node:assert/strict'
import test from 'node:test'
import { derivePtcToolView } from '../src/client-activity.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { encodeValue } from '../internal/value-wire.js'

const REWRITE_POLICY = Object.freeze({
  autoRewriteImports: true,
  autoStripExports: true,
  autoSplitRedeclarations: true,
})

function diagnostic() {
  return {
    code: 'PTC-T001',
    severity: 'note',
    phase: 'execute',
    message: 'Recorded.',
    stateEffect: 'unchanged',
  }
}

function call(global, member, settle) {
  return {
    global,
    member,
    args: encodeValue({}),
    ok: true,
    value: encodeValue(undefined),
    settle,
  }
}

function failedCall(global, member, settle) {
  return {
    global,
    member,
    args: encodeValue({}),
    ok: false,
    error: 'failed',
    settle,
  }
}

function journal(overrides = {}) {
  return {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: REWRITE_POLICY,
    status: 'durable',
    calls: [call('tools', 'read', 0)],
    operations: [],
    confirms: [],
    diagnostics: [diagnostic()],
    completion: { kind: 'return', hasValue: true, value: encodeValue('done') },
    ...overrides,
  }
}

function result(meta, options = {}) {
  return {
    kind: 'tool-result',
    callId: 'call-1',
    call: {
      name: options.toolName ?? 'run_code',
      argsRaw: JSON.stringify({
        code: options.code ?? 'return 1',
        description: options.description ?? 'Run code',
      }),
    },
    content: [{ type: 'text', text: options.output ?? '1' }],
    isError: options.isError === true,
    subCalls: [],
    meta,
  }
}

test('derives useful feature events without exposing counters or recovery boundaries', () => {
  const value = normalizeJournal(journal({
    status: 'volatile',
    calls: [call('tools', 'cordis_run', 0), call('code', 'run', 1)],
    operations: [
      { action: 'save', name: 'before-edit' },
      { action: 'restore' },
      { action: 'delete', name: 'old' },
    ],
    diagnostics: [{
      ...diagnostic(),
      code: 'PTC-R002',
      severity: 'warning',
      phase: 'recover',
      stateEffect: 'rolled-back',
    }],
  }))
  const view = derivePtcToolView(result({
    dshPtcPlus: value,
    dshPtcPlusRewrites: [
      { kind: 'import', description: 'Adapted import.', source: 'node:path' },
      { kind: 'export', description: 'Removed export.' },
      {
        kind: 'redeclaration',
        description: 'reassigned an existing top-level declaration for REPL continuity',
        source: 'answer',
      },
      {
        kind: 'redeclaration',
        description: 'split a mixed top-level declaration while preserving native pattern initialization',
        source: 'existing',
      },
    ],
    dshPtcPlusEdit: { targetCallSeq: 12 },
    dshPtcPlusDerivedRun: { code: 'return 1', description: 'Apply safe edit' },
    dshPtcPlusRecoveryBoundaries: [{ failedCallSeq: 9, frontierCallSeq: 4 }],
  }, {
    toolName: 'edit_run_code',
    code: undefined,
    description: 'Apply safe edit',
  }), 'edit_run_code')
  assert.deepEqual(view.features, [
    { key: 'feature.safeEdit', detail: '' },
    { key: 'autoRewriteImports.label', detail: 'node:path' },
    { key: 'autoStripExports.label', detail: '' },
    { key: 'autoSplitRedeclarations.label', detail: 'existing' },
    { key: 'feature.codeRun', detail: '' },
    { key: 'durableReplay.label', detail: '' },
    { key: 'feature.stateSaved', detail: 'before-edit' },
    { key: 'feature.stateRestored', detail: '' },
    { key: 'feature.stateDeleted', detail: 'old' },
  ])
  assert.equal(JSON.stringify(view).includes('recovery'), false)
  assert.equal(JSON.stringify(view).includes('cells'), false)
})

test('does not infer canonicalizer provenance from model-copyable code and description', () => {
  const valid = normalizeJournal(journal())
  const canonical = derivePtcToolView(result(
    { dshPtcPlus: valid },
    { code: '{\n  return await tools.read({"path":"README.md"})\n}', description: 'Call read inside the session REPL' },
  ))
  assert.deepEqual(canonical.features, [])

  const ordinary = derivePtcToolView(result(
    { dshPtcPlus: valid },
    { code: 'return await tools.read({ path: "README.md" })', description: 'Call read inside the session REPL' },
  ))
  assert.deepEqual(ordinary.features, [])

})

test('requires the complete non-noop edit relation and edit tool identity', () => {
  const valid = normalizeJournal(journal())
  const meta = {
    dshPtcPlus: valid,
    dshPtcPlusEdit: { targetCallSeq: 7 },
    dshPtcPlusDerivedRun: { code: 'return fixed', description: 'Apply fix' },
  }
  assert.deepEqual(derivePtcToolView(
    result(meta, { toolName: 'edit_run_code' }),
    'edit_run_code',
  ).features, [{ key: 'feature.safeEdit', detail: '' }])
  assert.deepEqual(derivePtcToolView(result(meta), 'run_code').features, [])
  assert.deepEqual(derivePtcToolView(result(meta), 'edit_run_code').features, [])
  assert.deepEqual(derivePtcToolView(result({
    ...meta,
    dshPtcPlusDerivedRun: { ...meta.dshPtcPlusDerivedRun, extra: true },
  }, { toolName: 'edit_run_code' }), 'edit_run_code').features, [])

  const malformedBoundary = {
    ...meta,
    dshPtcPlusRecoveryBoundaries: [{ failedCallSeq: 9, frontierCallSeq: '4' }],
  }
  assert.deepEqual(derivePtcToolView(result(
    malformedBoundary,
    { toolName: 'edit_run_code' },
  ), 'edit_run_code').features, [])

  const conflictingTarget = result(meta, { toolName: 'edit_run_code' })
  conflictingTarget.call.argsRaw = JSON.stringify({
    edits: [{ old_text: 'broken', new_text: 'fixed' }],
    expected_target_call_seq: 8,
    description: 'Apply fix',
  })
  assert.deepEqual(derivePtcToolView(conflictingTarget, 'edit_run_code').features, [])

  const matchingTarget = structuredClone(conflictingTarget)
  matchingTarget.call.argsRaw = JSON.stringify({
    edits: [{ old_text: 'broken', new_text: 'fixed' }],
    expected_target_call_seq: 7,
    description: 'Apply fix',
  })
  assert.deepEqual(derivePtcToolView(matchingTarget, 'edit_run_code').features, [
    { key: 'feature.safeEdit', detail: '' },
  ])

  const noop = journal({ status: 'noop', calls: [], diagnostics: [] })
  delete noop.completion
  assert.deepEqual(derivePtcToolView(result({
    ...meta,
    dshPtcPlus: normalizeJournal(noop),
  }, { toolName: 'edit_run_code' }), 'edit_run_code').features, [])
})

test('does not infer official Cordis ownership from a tool member prefix', () => {
  const valid = normalizeJournal(journal({ calls: [call('tools', 'cordis_run', 0)] }))
  assert.deepEqual(derivePtcToolView(result({ dshPtcPlus: valid })).features, [])
})

test('distinguishes successful code.run from failed or discarded state', () => {
  const failed = normalizeJournal(journal({ calls: [failedCall('code', 'run', 0)] }))
  assert.deepEqual(derivePtcToolView(result({ dshPtcPlus: failed })).features, [])

  const discarded = journal({ status: 'discarded', calls: [], diagnostics: [] })
  delete discarded.completion
  assert.deepEqual(derivePtcToolView(result({
    dshPtcPlus: normalizeJournal(discarded),
  })).features, [])
})

test('requires the complete durable recovery diagnostic tuple', () => {
  const recovery = {
    ...diagnostic(),
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    stateEffect: 'rolled-back',
  }
  assert.deepEqual(derivePtcToolView(result({
    dshPtcPlus: normalizeJournal(journal({ diagnostics: [recovery] })),
  })).features, [{ key: 'durableReplay.label', detail: '' }])

  for (const damage of [
    value => { value.severity = 'note' },
    value => { value.phase = 'execute' },
    value => { value.stateEffect = 'unchanged' },
  ]) {
    const contradictory = structuredClone(recovery)
    damage(contradictory)
    const view = derivePtcToolView(result({
      dshPtcPlus: normalizeJournal(journal({ diagnostics: [contradictory] })),
    }))
    assert.equal(view.ptc, true)
    assert.deepEqual(view.features, [])
  }
})

test('does not present enabled defaults as feature events without provenance', () => {
  const view = derivePtcToolView(result(
    { dshPtcPlus: normalizeJournal(journal({ bindingMode: 'loose' })) },
    { code: 'const answer = 42', description: 'Declare a value' },
  ))
  assert.deepEqual(view.features, [])
})

test('accepts self-contained legacy journals and both generations of tool argument fields', () => {
  const legacy = journal({ version: 1, calls: [], confirms: [], diagnostics: [] })
  delete legacy.rewritePolicy
  const oldBlock = result({
    dshPtcPlus: legacy,
    dshPtcPlusRewrites: [{ kind: 'import', description: 'Adapted.' }],
  })
  oldBlock.call.arguments = oldBlock.call.argsRaw
  delete oldBlock.call.argsRaw
  const view = derivePtcToolView(oldBlock)
  assert.equal(view.description, 'Run code')
  assert.equal(view.code, 'return 1')
  assert.equal(view.ptc, true)
  assert.deepEqual(view.features, [])

  const pending = derivePtcToolView({
    callId: 'pending', name: 'run_code', argsRaw: '{"code":"await work()","description":"Working"}',
  })
  assert.equal(pending.state, 'running')
  assert.equal(pending.description, 'Working')
  assert.equal(pending.output, '')
  assert.equal(pending.ptc, false)
})

test('rejects legacy confirms that require unavailable session call identity', () => {
  const legacy = journal({
    version: 1,
    status: 'volatile',
    calls: [],
    operations: [{ action: 'save', name: 'legacy' }],
    confirms: ['legacy-call-id'],
    diagnostics: [],
  })
  delete legacy.rewritePolicy
  const view = derivePtcToolView(result({ dshPtcPlus: legacy }))
  assert.equal(view.ptc, false)
  assert.equal(view.code, 'return 1')
  assert.equal(view.output, '1')
  assert.deepEqual(view.features, [])
})

test('rejects non-canonical Value V1 property order', () => {
  const reordered = []

  const envelope = structuredClone(encodeValue({ value: 1 }))
  reordered.push({ nodes: envelope.nodes, root: envelope.root, codec: envelope.codec })

  const objectNode = structuredClone(encodeValue({ value: 1 }))
  const object = objectNode.nodes[0]
  objectNode.nodes[0] = { entries: object.entries, prototype: object.prototype, type: object.type }
  reordered.push(objectNode)

  const arrayNode = structuredClone(encodeValue([1]))
  const array = arrayNode.nodes[0]
  arrayNode.nodes[0] = { entries: array.entries, length: array.length, type: array.type }
  reordered.push(arrayNode)

  const reference = structuredClone(encodeValue({ value: 1 }))
  reference.root = { index: reference.root.index, tag: reference.root.tag }
  reordered.push(reference)

  const number = structuredClone(encodeValue(-0))
  number.root = { value: number.root.value, tag: number.root.tag }
  reordered.push(number)

  const bigint = structuredClone(encodeValue(1n))
  bigint.root = { value: bigint.root.value, tag: bigint.root.tag }
  reordered.push(bigint)

  for (const args of reordered) {
    const candidate = structuredClone(normalizeJournal(journal({
      calls: [call('code', 'run', 0)],
    })))
    candidate.calls[0].args = args
    const view = derivePtcToolView(result({ dshPtcPlus: candidate }))
    assert.equal(view.ptc, false)
    assert.deepEqual(view.features, [])
  }
})

test('ignores journals rejected by the complete closed metadata contract', () => {
  const valid = normalizeJournal(journal())
  const malformed = [
    value => { delete value.bindingMode },
    value => { value.status = 'corrupt' },
    value => { value.extra = true },
    value => { delete value.calls[0].member },
    value => { value.calls[0].args.root = { tag: 'reference', index: 99 } },
    value => { value.calls[0].settle = 1 },
    value => { value.operations = [{ action: 'save' }] },
    value => { value.confirms = ['call-id'] },
    value => { value.diagnostics[0].message = 'two\nlines' },
    value => { delete value.completion.hasValue },
  ]
  for (const damage of malformed) {
    const candidate = structuredClone(valid)
    damage(candidate)
    const view = derivePtcToolView(result({
      dshPtcPlus: candidate,
      dshPtcPlusRewrites: [{ kind: 'import', description: 'Adapted.', source: 'sentinel' }],
      dshPtcPlusEdit: { targetCallSeq: 1 },
    }))
    assert.deepEqual(view.features, [])
  }
})

test('suppresses a complete malformed adjunct instead of partially presenting it', () => {
  const valid = normalizeJournal(journal())
  const malformedRewrites = derivePtcToolView(result({
    dshPtcPlus: valid,
    dshPtcPlusRewrites: [
      { kind: 'import', description: 'Adapted.', source: 'node:path' },
      { kind: 'export', description: 'Removed.', extra: true },
    ],
  }))
  assert.deepEqual(malformedRewrites.features, [])

  const malformedEdit = derivePtcToolView(result({
    dshPtcPlus: valid,
    dshPtcPlusEdit: { targetCallSeq: -1 },
  }))
  assert.deepEqual(malformedEdit.features, [])
})

test('requires rewrite adjuncts to agree with execution status and recorded policy', () => {
  const importRewrite = [{ kind: 'import', description: 'Adapted.', source: 'node:path' }]
  const disabledImport = normalizeJournal(journal({
    rewritePolicy: { ...REWRITE_POLICY, autoRewriteImports: false },
  }))
  assert.deepEqual(derivePtcToolView(result({
    dshPtcPlus: disabledImport,
    dshPtcPlusRewrites: importRewrite,
  })).features, [])

  const noop = journal({ status: 'noop', calls: [], diagnostics: [] })
  delete noop.completion
  assert.deepEqual(derivePtcToolView(result({
    dshPtcPlus: normalizeJournal(noop),
    dshPtcPlusRewrites: importRewrite,
  })).features, [])

  const partiallyDisabled = normalizeJournal(journal({
    rewritePolicy: { ...REWRITE_POLICY, autoStripExports: false },
  }))
  assert.deepEqual(derivePtcToolView(result({
    dshPtcPlus: partiallyDisabled,
    dshPtcPlusRewrites: [
      ...importRewrite,
      { kind: 'export', description: 'Removed export.' },
    ],
  })).features, [])
})

test('preserves source, result, and lifecycle fallbacks for the replacement tool row', () => {
  const failed = result(undefined, { isError: true, output: 'Failure\nDetails' })
  failed.call.argsRaw = '{bad json'
  const view = derivePtcToolView(failed)
  assert.equal(view.state, 'error')
  assert.equal(view.code, '{bad json')
  assert.equal(view.output, 'Failure\nDetails')
  assert.deepEqual(view.features, [])

  const stopped = result(undefined)
  stopped.error = { name: 'AbortError', code: 'interrupted' }
  stopped.content = []
  assert.deepEqual(derivePtcToolView(stopped), {
    state: 'stopped',
    description: 'Run code',
    code: 'return 1',
    output: 'AbortError: interrupted',
    ptc: false,
    features: [],
  })
})
