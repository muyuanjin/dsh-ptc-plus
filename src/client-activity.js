const JOURNAL_VERSIONS = new Set([1, 2, 3])
const JOURNAL_STATUSES = new Set(['durable', 'volatile', 'discarded', 'noop'])
const BINDING_MODES = new Set(['loose', 'strict'])
const JOURNAL_FIELDS = new Set([
  'version', 'bindingMode', 'rewritePolicy', 'status', 'calls', 'operations',
  'confirms', 'diagnostics', 'completion', 'volatileReason',
])
const LEGACY_JOURNAL_FIELDS = new Set([...JOURNAL_FIELDS].filter(key => key !== 'rewritePolicy'))
const REWRITE_POLICY_FIELDS = new Set([
  'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations',
])
const CALL_SUCCESS_FIELDS = new Set(['global', 'member', 'args', 'ok', 'value', 'settle'])
const CALL_ERROR_FIELDS = new Set(['global', 'member', 'args', 'ok', 'error', 'settle'])
const OPERATION_FIELDS = new Set(['action', 'name'])
const RETURN_FIELDS = new Set(['kind', 'hasValue', 'value'])
const THROW_FIELDS = new Set(['kind', 'error'])
const ERROR_FIELDS = new Set(['kind', 'message'])
const DIAGNOSTIC_FIELDS = new Set([
  'code', 'severity', 'phase', 'message', 'stateEffect', 'dispatchState',
  'source', 'cause', 'help',
])
const SOURCE_FIELDS = new Set(['cell', 'start', 'end'])
const POSITION_FIELDS = new Set(['line', 'column'])
const CAUSE_FIELDS = new Set(['code', 'message'])
const SEVERITIES = new Set(['error', 'warning', 'note'])
const PHASES = new Set(['parse', 'preflight', 'execute', 'tool-dispatch', 'replay', 'recover'])
const STATE_EFFECTS = new Set(['unchanged', 'partially-applied', 'rolled-back', 'unknown'])
const DISPATCH_STATES = new Set(['not-dispatched', 'dispatched', 'completed', 'unknown'])
const REWRITE_FIELDS = new Set(['kind', 'description', 'source'])
const REWRITE_KINDS = new Set(['import', 'redeclaration', 'export'])
const REWRITE_POLICY_BY_KIND = Object.freeze({
  import: 'autoRewriteImports',
  redeclaration: 'autoSplitRedeclarations',
  export: 'autoStripExports',
})
const EDIT_TARGET_FIELDS = new Set(['targetCallSeq'])
const DERIVED_RUN_FIELDS = new Set(['code', 'description'])
const RECOVERY_BOUNDARY_FIELDS = new Set(['failedCallSeq', 'frontierCallSeq'])
const VALUE_ENVELOPE_FIELDS = new Set(['codec', 'root', 'nodes'])
const VALUE_OBJECT_FIELDS = new Set(['type', 'prototype', 'entries'])
const VALUE_ARRAY_FIELDS = new Set(['type', 'length', 'entries'])
const VALUE_UNDEFINED_FIELDS = new Set(['tag'])
const VALUE_NUMBER_FIELDS = new Set(['tag', 'value'])
const VALUE_BIGINT_FIELDS = new Set(['tag', 'value'])
const VALUE_REFERENCE_FIELDS = new Set(['tag', 'index'])
const MAX_VALUE_NODES = 100_000
const MAX_VALUE_EDGES = 1_000_000
const MAX_ARRAY_LENGTH = 1_000_000
const MAX_BIGINT_DIGITS = 100_000
const MAX_STRING_BYTES = 64 * 1024 * 1024
const textEncoder = new TextEncoder()

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasClosedFields(value, allowed, required = []) {
  if (!isRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key)
    || !Object.prototype.propertyIsEnumerable.call(value, key))) return false
  return [...required].every(key => Object.hasOwn(value, key))
}

function hasExactFields(value, fields) {
  return hasClosedFields(value, fields, fields) && Reflect.ownKeys(value).length === fields.size
}

function hasExactOrderedFields(value, fields) {
  if (!isRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  const ordered = [...fields]
  return keys.length === ordered.length && keys.every((key, index) => (
    key === ordered[index] && Object.prototype.propertyIsEnumerable.call(value, key)
  ))
}

function isLine(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value)
}

function isSafeSequence(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isValidPosition(value) {
  return hasExactFields(value, POSITION_FIELDS)
    && Number.isSafeInteger(value.line) && value.line >= 1
    && Number.isSafeInteger(value.column) && value.column >= 1
}

function isValidDiagnosticCause(value, depth) {
  if (depth > 16 || !isRecord(value)) return false
  if (Object.hasOwn(value, 'severity')) return isValidDiagnostic(value, depth + 1)
  return hasClosedFields(value, CAUSE_FIELDS, ['message'])
    && (value.code === undefined || isLine(value.code))
    && isLine(value.message)
}

function isValidDiagnostic(value, depth = 0) {
  if (!hasClosedFields(value, DIAGNOSTIC_FIELDS, [
    'code', 'severity', 'phase', 'message', 'stateEffect',
  ])) return false
  if (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9-]{2,31}$/.test(value.code)
    || !SEVERITIES.has(value.severity) || !PHASES.has(value.phase)
    || !STATE_EFFECTS.has(value.stateEffect) || !isLine(value.message)) return false
  if (value.dispatchState !== undefined && !DISPATCH_STATES.has(value.dispatchState)) return false
  if (value.source !== undefined) {
    if (!hasClosedFields(value.source, SOURCE_FIELDS, ['cell', 'start'])
      || !isLine(value.source.cell) || !isValidPosition(value.source.start)
      || (value.source.end !== undefined && !isValidPosition(value.source.end))) return false
    if (value.source.end !== undefined && (value.source.end.line < value.source.start.line
      || (value.source.end.line === value.source.start.line
        && value.source.end.column < value.source.start.column))) return false
  }
  if (value.cause !== undefined && !isValidDiagnosticCause(value.cause, depth)) return false
  return value.help === undefined || (Array.isArray(value.help) && value.help.length <= 3
    && value.help.every(isLine))
}

function isArrayIndexKey(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 4_294_967_295
    && String(parsed) === value
}

function accountText(value, state) {
  state.textBytes += textEncoder.encode(value).byteLength
  return state.textBytes <= MAX_STRING_BYTES
}

function isValidValueAtom(value, state) {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return accountText(value, state)
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (!isRecord(value) || typeof value.tag !== 'string') return false
  if (value.tag === 'undefined') return hasExactOrderedFields(value, VALUE_UNDEFINED_FIELDS)
  if (value.tag === 'number') {
    return hasExactOrderedFields(value, VALUE_NUMBER_FIELDS)
      && ['nan', 'infinity', '-infinity', '-0'].includes(value.value)
  }
  if (value.tag === 'bigint') {
    if (!hasExactOrderedFields(value, VALUE_BIGINT_FIELDS) || typeof value.value !== 'string'
      || !/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value.value)) return false
    const digits = value.value[0] === '-' ? value.value.length - 1 : value.value.length
    return digits <= MAX_BIGINT_DIGITS && accountText(value.value, state)
  }
  if (value.tag !== 'reference' || !hasExactOrderedFields(value, VALUE_REFERENCE_FIELDS)
    || !isSafeSequence(value.index) || value.index >= state.nodeCount) return false
  if (!state.discovered.has(value.index)) {
    if (value.index !== state.discovered.size) return false
    state.discovered.add(value.index)
  }
  return true
}

function isValidValueWire(value) {
  if (!hasExactOrderedFields(value, VALUE_ENVELOPE_FIELDS) || value.codec !== 'ptc-value-graph/v1'
    || !Array.isArray(value.nodes) || value.nodes.length > MAX_VALUE_NODES) return false
  const state = {
    nodeCount: value.nodes.length,
    discovered: new Set(),
    edges: 0,
    textBytes: 0,
  }
  if (!isValidValueAtom(value.root, state)) return false
  for (const [nodeIndex, node] of value.nodes.entries()) {
    if (!state.discovered.has(nodeIndex) || !isRecord(node)) return false
    if (node.type === 'array') {
      if (!hasExactOrderedFields(node, VALUE_ARRAY_FIELDS)
        || !Number.isSafeInteger(node.length) || node.length < 0 || node.length > MAX_ARRAY_LENGTH
        || !Array.isArray(node.entries)) return false
      let previous = -1
      for (const entry of node.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0])
          || entry[0] <= previous || entry[0] < 0 || entry[0] >= node.length) return false
        previous = entry[0]
        state.edges += 1
        if (state.edges > MAX_VALUE_EDGES || !isValidValueAtom(entry[1], state)) return false
      }
      continue
    }
    if (node.type !== 'object' || !hasExactOrderedFields(node, VALUE_OBJECT_FIELDS)
      || !['object', 'null'].includes(node.prototype) || !Array.isArray(node.entries)) return false
    const keys = new Set()
    let previousArrayIndex = -1
    let sawOtherKey = false
    for (const entry of node.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || keys.has(entry[0]) || !accountText(entry[0], state)) return false
      keys.add(entry[0])
      if (isArrayIndexKey(entry[0])) {
        const current = Number(entry[0])
        if (sawOtherKey || current <= previousArrayIndex) return false
        previousArrayIndex = current
      } else {
        sawOtherKey = true
      }
      state.edges += 1
      if (state.edges > MAX_VALUE_EDGES || !isValidValueAtom(entry[1], state)) return false
    }
  }
  return state.discovered.size === value.nodes.length
}

function isValidRewritePolicy(value) {
  return hasExactFields(value, REWRITE_POLICY_FIELDS)
    && [...REWRITE_POLICY_FIELDS].every(key => typeof value[key] === 'boolean')
}

function isValidCall(value) {
  if (!isRecord(value) || (value.ok !== true && value.ok !== false)) return false
  const fields = value.ok ? CALL_SUCCESS_FIELDS : CALL_ERROR_FIELDS
  if (!hasExactFields(value, fields) || typeof value.global !== 'string'
    || typeof value.member !== 'string' || !isValidValueWire(value.args)
    || !isSafeSequence(value.settle)) return false
  return value.ok ? isValidValueWire(value.value) : typeof value.error === 'string'
}

function isValidOperation(value) {
  if (!hasClosedFields(value, OPERATION_FIELDS, ['action'])
    || !['save', 'restore', 'delete'].includes(value.action)) return false
  if (value.action === 'restore' && value.name === undefined) return true
  return typeof value.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name)
}

function isValidCompletion(value) {
  if (!isRecord(value) || !['return', 'throw'].includes(value.kind)) return false
  if (value.kind === 'return') {
    if (!hasClosedFields(value, RETURN_FIELDS, ['kind', 'hasValue'])
      || typeof value.hasValue !== 'boolean') return false
    return value.hasValue
      ? Object.hasOwn(value, 'value') && isValidValueWire(value.value)
      : !Object.hasOwn(value, 'value')
  }
  return hasExactFields(value, THROW_FIELDS) && hasExactFields(value.error, ERROR_FIELDS)
    && typeof value.error.kind === 'string' && typeof value.error.message === 'string'
}

function isValidConfirms(value, version) {
  if (value === undefined) return true
  if (!Array.isArray(value) || new Set(value).size !== value.length) return false
  if (version === 1) return value.length === 0
  return value.every(isSafeSequence)
}

function isReadableJournalUnchecked(value) {
  if (!isRecord(value) || !JOURNAL_VERSIONS.has(value.version) || !JOURNAL_STATUSES.has(value.status)) {
    return false
  }
  const fields = value.version === 1 ? LEGACY_JOURNAL_FIELDS : JOURNAL_FIELDS
  const required = ['version', 'bindingMode', 'status', 'calls', 'operations', 'diagnostics']
  if (value.version !== 1) required.push('rewritePolicy')
  if (!hasClosedFields(value, fields, required) || !BINDING_MODES.has(value.bindingMode)
    || (value.version !== 1 && !isValidRewritePolicy(value.rewritePolicy))
    || !Array.isArray(value.calls) || !value.calls.every(isValidCall)
    || !Array.isArray(value.operations) || !value.operations.every(isValidOperation)
    || !isValidConfirms(value.confirms, value.version)
    || !Array.isArray(value.diagnostics) || !value.diagnostics.every(isValidDiagnostic)) return false
  const settlementOrder = value.calls.map(call => call.settle).sort((left, right) => left - right)
  if (settlementOrder.some((settle, index) => settle !== index)) return false
  const requiresCompletion = value.status === 'durable' || value.status === 'volatile'
  if ((requiresCompletion && !isValidCompletion(value.completion))
    || (!requiresCompletion && value.completion !== undefined && !isValidCompletion(value.completion))) return false
  if ((value.status === 'discarded' || value.status === 'noop')
    && (value.calls.length !== 0 || value.operations.length !== 0)) return false
  if (value.volatileReason !== undefined && (typeof value.volatileReason !== 'string'
    || (value.status !== 'volatile' && value.status !== 'discarded'))) return false
  return true
}

function isReadableJournal(value) {
  try {
    return isReadableJournalUnchecked(value)
  } catch {
    return false
  }
}

function isValidRewrites(value, journal) {
  try {
    return journal.status !== 'noop' && isValidRewritePolicy(journal.rewritePolicy)
      && Array.isArray(value) && value.every(rewrite => (
      hasClosedFields(rewrite, REWRITE_FIELDS, ['kind', 'description'])
      && REWRITE_KINDS.has(rewrite.kind)
      && journal.rewritePolicy[REWRITE_POLICY_BY_KIND[rewrite.kind]] === true
      && typeof rewrite.description === 'string' && rewrite.description.length > 0
      && (rewrite.source === undefined || typeof rewrite.source === 'string')
      ))
  } catch {
    return false
  }
}

function isValidEditTarget(value) {
  try {
    return hasExactFields(value, EDIT_TARGET_FIELDS) && isSafeSequence(value.targetCallSeq)
  } catch {
    return false
  }
}

function isValidDerivedRun(value) {
  try {
    return hasExactFields(value, DERIVED_RUN_FIELDS)
      && typeof value.code === 'string' && typeof value.description === 'string'
  } catch {
    return false
  }
}

function isValidRecoveryBoundaries(value) {
  try {
    return Array.isArray(value) && value.every(boundary => (
      hasExactFields(boundary, RECOVERY_BOUNDARY_FIELDS)
      && isSafeSequence(boundary.failedCallSeq)
      && (boundary.frontierCallSeq === null || isSafeSequence(boundary.frontierCallSeq))
    ))
  } catch {
    return false
  }
}

function isValidEditRelation(meta, args, journal) {
  try {
    if (!isRecord(meta) || !isRecord(args) || !isValidEditTarget(meta.dshPtcPlusEdit)
      || !isValidDerivedRun(meta.dshPtcPlusDerivedRun) || journal.status === 'noop') return false
    if (Object.hasOwn(meta, 'dshPtcPlusRecoveryBoundaries')
      && !isValidRecoveryBoundaries(meta.dshPtcPlusRecoveryBoundaries)) return false
    return !Object.hasOwn(args, 'expected_target_call_seq')
      || args.expected_target_call_seq === meta.dshPtcPlusEdit.targetCallSeq
  } catch {
    return false
  }
}

function rawArguments(block, settled) {
  const call = settled ? block.call : block
  return typeof call?.argsRaw === 'string' ? call.argsRaw
    : typeof call?.arguments === 'string' ? call.arguments
      : ''
}

function parseArguments(raw) {
  try {
    const value = JSON.parse(raw)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function resultText(block) {
  if (!Array.isArray(block.content)) return ''
  try {
    const parts = block.content.map(item => item?.type === 'text' && typeof item.text === 'string'
      ? item.text
      : JSON.stringify(item, null, 2))
    if (parts.length === 0 && isRecord(block.error)) {
      return [block.error.name, block.error.code].filter(value => typeof value === 'string').join(': ')
    }
    return parts.filter(value => typeof value === 'string').join('\n')
  } catch {
    return ''
  }
}

const MIXED_REDECLARATION = 'split a mixed top-level declaration while preserving native pattern initialization'

function rewriteFeature(rewrites, predicate, key) {
  const matching = rewrites.filter(predicate)
  if (matching.length === 0) return undefined
  const sources = [...new Set(matching.map(rewrite => rewrite.source).filter(source => source !== undefined))]
  return { key, detail: sources.join(', ') }
}

function operationFeatures(operations) {
  const keys = {
    save: 'feature.stateSaved',
    restore: 'feature.stateRestored',
    delete: 'feature.stateDeleted',
  }
  return operations.map(operation => ({
    key: keys[operation.action],
    detail: operation.name ?? '',
  }))
}

function uniqueFeatures(features) {
  const seen = new Set()
  return features.filter((feature) => {
    if (feature === undefined) return false
    const identity = `${feature.key}\u0000${feature.detail}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function isDurableRecoveryDiagnostic(diagnostic) {
  return diagnostic.code === 'PTC-R002'
    && diagnostic.severity === 'warning'
    && diagnostic.phase === 'recover'
    && diagnostic.stateEffect === 'rolled-back'
}

/** Derive one read-only body view from a DSH running or settled tool block. */
export function derivePtcToolView(block, toolName = undefined) {
  const settled = isRecord(block) && block.kind === 'tool-result'
  const argsRaw = isRecord(block) ? rawArguments(block, settled) : ''
  const args = parseArguments(argsRaw)
  const code = typeof args?.code === 'string' ? args.code : argsRaw
  const description = typeof args?.description === 'string' && args.description.length > 0
    ? args.description.split(/\r?\n/, 1)[0]
    : ''
  const output = settled ? resultText(block) : ''
  const state = !settled ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped'
      : block.isError === true ? 'error' : 'ok'
  const journal = settled && isRecord(block.meta) && isReadableJournal(block.meta.dshPtcPlus)
    ? block.meta.dshPtcPlus
    : undefined
  if (journal === undefined) {
    return Object.freeze({ state, description, code, output, ptc: false, features: Object.freeze([]) })
  }
  const rewrites = isValidRewrites(block.meta.dshPtcPlusRewrites, journal)
    ? block.meta.dshPtcPlusRewrites
    : []
  const resolvedToolName = typeof toolName === 'string'
    ? toolName
    : typeof block.call?.name === 'string' ? block.call.name : ''
  const recordedToolName = typeof block.call?.name === 'string' ? block.call.name : undefined
  const safeEdit = resolvedToolName === 'edit_run_code'
    && (recordedToolName === undefined || recordedToolName === 'edit_run_code')
    && isValidEditRelation(block.meta, args, journal)
  const features = uniqueFeatures([
    safeEdit
      ? { key: 'feature.safeEdit', detail: '' }
      : undefined,
    rewriteFeature(rewrites, rewrite => rewrite.kind === 'import', 'autoRewriteImports.label'),
    rewriteFeature(rewrites, rewrite => rewrite.kind === 'export', 'autoStripExports.label'),
    rewriteFeature(rewrites, rewrite => rewrite.kind === 'redeclaration'
      && rewrite.description === MIXED_REDECLARATION, 'autoSplitRedeclarations.label'),
    journal.calls.some(call => call.global === 'code' && call.member === 'run' && call.ok === true)
      ? { key: 'feature.codeRun', detail: '' }
      : undefined,
    journal.diagnostics.some(isDurableRecoveryDiagnostic)
      ? { key: 'durableReplay.label', detail: '' }
      : undefined,
    ...operationFeatures(journal.operations),
    journal.status === 'volatile'
      ? { key: 'feature.volatile', detail: '' }
      : undefined,
    journal.status === 'discarded'
      ? { key: 'feature.discarded', detail: '' }
      : undefined,
  ])
  return Object.freeze({ state, description, code, output, ptc: true, features: Object.freeze(features) })
}
