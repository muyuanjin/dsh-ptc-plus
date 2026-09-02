import { decodeValue, encodeValue, normalizeValueWire } from './value-wire.js'
import { normalizeDiagnostic } from './diagnostic.js'
import { assertOwnFields, isRecord } from './record-utils.js'
import { sessionEvents } from './session-events.js'
import {
  LEGACY_DEFAULT_EXPORT_BINDING,
  LIVE_DEFAULT_EXPORT_BINDING,
} from './repl-rewrite-contract.js'

export const JOURNAL_KEY = 'dshPtcPlus'
export const EDIT_TARGET_KEY = 'dshPtcPlusEdit'
export const DERIVED_RUN_KEY = 'dshPtcPlusDerivedRun'
export const REWRITES_KEY = 'dshPtcPlusRewrites'
export const RECOVERY_BOUNDARY_KEY = 'dshPtcPlusRecoveryBoundaries'
export const JOURNAL_VERSION = 4
const LEGACY_JOURNAL_VERSION = 1
const INTERMEDIATE_JOURNAL_VERSION = 2
const PREVIOUS_JOURNAL_VERSION = 3
export const RECOVERY_BOUNDARY_EVENT = 'ptc-plus/recovery-boundary'

const STATUSES = new Set(['durable', 'volatile', 'discarded', 'noop'])
const BINDING_MODES = new Set(['loose', 'strict'])
const JOURNAL_FIELDS = new Set(['version', 'bindingPolicy', 'rewritePolicy', 'moduleSemantics', 'status', 'calls', 'operations', 'confirms', 'diagnostics', 'completion', 'volatileReason'])
const PREDECESSOR_JOURNAL_FIELDS = new Set(['version', 'bindingMode', 'rewritePolicy', 'status', 'calls', 'operations', 'confirms', 'diagnostics', 'completion', 'volatileReason'])
const LEGACY_JOURNAL_FIELDS = new Set([...PREDECESSOR_JOURNAL_FIELDS].filter(field => field !== 'rewritePolicy'))
const BINDING_POLICY_FIELDS = new Set(['variableRedeclarations', 'functionClassRedeclarations'])
const REWRITE_POLICY_FIELDS = new Set(['autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations'])
const MODULE_SEMANTICS_FIELDS = new Set(['defaultExportBinding'])
const DEFAULT_EXPORT_BINDINGS = new Set([
  LEGACY_DEFAULT_EXPORT_BINDING,
  LIVE_DEFAULT_EXPORT_BINDING,
])
const CALL_SUCCESS_FIELDS = new Set(['global', 'member', 'args', 'ok', 'value', 'settle'])
const CALL_ERROR_FIELDS = new Set(['global', 'member', 'args', 'ok', 'error', 'settle'])
const OPERATION_FIELDS = new Set(['action', 'name'])
const RETURN_FIELDS = new Set(['kind', 'hasValue', 'value'])
const THROW_FIELDS = new Set(['kind', 'error'])
const ERROR_FIELDS = new Set(['kind', 'message'])
const EDIT_TARGET_FIELDS = new Set(['targetCallSeq'])
const DERIVED_RUN_FIELDS = new Set(['code', 'description'])

function cloneJson(value) {
  if (value === undefined) return undefined
  return decodeValue(encodeValue(value))
}

function validName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

function normalizeCalls(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal calls')
  const calls = value.map((call, index) => {
    if (!isRecord(call) || typeof call.global !== 'string' || typeof call.member !== 'string'
      || !Object.hasOwn(call, 'args') || (call.ok !== true && call.ok !== false)
      || !Number.isSafeInteger(call.settle) || call.settle < 0) {
      throw new Error(`invalid dsh-ptc-plus journal call at index ${index}`)
    }
    assertOwnFields(call, call.ok ? CALL_SUCCESS_FIELDS : CALL_ERROR_FIELDS, `journal call at index ${index}`)
    if (call.ok === true && !Object.hasOwn(call, 'value')) {
      throw new Error(`journal call at index ${index} is missing its value`)
    }
    if (call.ok === false && typeof call.error !== 'string') {
      throw new Error(`journal call at index ${index} is missing its error`)
    }
    return {
      global: call.global,
      member: call.member,
      args: normalizeValueWire(call.args),
      ok: call.ok,
      settle: call.settle,
      ...(call.ok ? { value: normalizeValueWire(call.value) } : { error: call.error }),
    }
  })
  const order = calls.map(call => call.settle).sort((left, right) => left - right)
  if (order.some((settle, index) => settle !== index)) {
    throw new Error('dsh-ptc-plus journal call settlement order is not contiguous')
  }
  return calls
}

function normalizeOperations(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal operations')
  return value.map((operation, index) => {
    if (!isRecord(operation) || !['save', 'restore', 'delete'].includes(operation.action)
      || ((operation.action !== 'restore' || operation.name !== undefined) && !validName(operation.name))) {
      throw new Error(`invalid dsh-ptc-plus journal operation at index ${index}`)
    }
    assertOwnFields(operation, OPERATION_FIELDS, `journal operation at index ${index}`)
    return { action: operation.action, ...(operation.name === undefined ? {} : { name: operation.name }) }
  })
}

function normalizeCompletion(value, required) {
  if (value === undefined && !required) return undefined
  if (!isRecord(value) || !['return', 'throw'].includes(value.kind)) {
    throw new Error('invalid dsh-ptc-plus journal completion')
  }
  if (value.kind === 'return') {
    assertOwnFields(value, RETURN_FIELDS, 'journal return completion')
    if (typeof value.hasValue !== 'boolean'
      || (value.hasValue ? !Object.hasOwn(value, 'value') : Object.hasOwn(value, 'value'))) {
      throw new Error('invalid dsh-ptc-plus journal return value')
    }
    return Object.freeze({
      kind: 'return',
      hasValue: value.hasValue,
      ...(value.hasValue ? { value: normalizeValueWire(value.value) } : {}),
    })
  }
  if (!isRecord(value.error) || typeof value.error.kind !== 'string' || typeof value.error.message !== 'string') {
    throw new Error('invalid dsh-ptc-plus journal throw completion')
  }
  assertOwnFields(value, THROW_FIELDS, 'journal throw completion')
  assertOwnFields(value.error, ERROR_FIELDS, 'journal completion error')
  return Object.freeze({
    kind: 'throw',
    error: Object.freeze({ kind: value.error.kind, message: value.error.message }),
  })
}

const LEGACY_REWRITE_POLICY = Object.freeze({
  autoRewriteImports: false,
  autoStripExports: false,
  autoSplitRedeclarations: false,
})

function normalizeLegacyConfirms(value, resolveLegacyConfirm) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(callId => typeof callId !== 'string' || callId.length === 0)) {
    throw new Error('invalid dsh-ptc-plus confirmed no-op calls')
  }
  if (new Set(value).size !== value.length) throw new Error('duplicate dsh-ptc-plus confirmed no-op call')
  if (value.length === 0) return []
  if (typeof resolveLegacyConfirm !== 'function') {
    throw new Error('legacy dsh-ptc-plus confirmed no-op calls require session call identity')
  }
  const confirms = value.map(callId => resolveLegacyConfirm(callId))
  if (confirms.some(callSeq => !Number.isSafeInteger(callSeq) || callSeq < 0)) {
    throw new Error('legacy dsh-ptc-plus confirmed no-op call is not uniquely persisted')
  }
  if (new Set(confirms).size !== confirms.length) {
    throw new Error('duplicate dsh-ptc-plus confirmed no-op call')
  }
  return confirms
}

function normalizeConfirms(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(callSeq => !Number.isSafeInteger(callSeq) || callSeq < 0)) {
    throw new Error('invalid dsh-ptc-plus confirmed no-op calls')
  }
  const confirms = [...new Set(value)]
  if (confirms.length !== value.length) throw new Error('duplicate dsh-ptc-plus confirmed no-op call')
  return confirms
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal diagnostics')
  return value.map((diagnostic, index) => {
    try {
      return normalizeDiagnostic(diagnostic)
    } catch (error) {
      throw new Error(`invalid dsh-ptc-plus journal diagnostic at index ${index}: ${error.message}`)
    }
  })
}

function normalizeRewritePolicy(value) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal rewrite policy')
  assertOwnFields(value, REWRITE_POLICY_FIELDS, 'journal rewrite policy')
  for (const key of REWRITE_POLICY_FIELDS) {
    if (typeof value[key] !== 'boolean') throw new Error(`invalid dsh-ptc-plus journal rewrite policy ${key}`)
  }
  return Object.freeze({
    autoRewriteImports: value.autoRewriteImports,
    autoStripExports: value.autoStripExports,
    autoSplitRedeclarations: value.autoSplitRedeclarations,
  })
}

function normalizeBindingPolicy(value) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal binding policy')
  assertOwnFields(value, BINDING_POLICY_FIELDS, 'journal binding policy')
  for (const key of BINDING_POLICY_FIELDS) {
    if (typeof value[key] !== 'boolean') throw new Error(`invalid dsh-ptc-plus journal binding policy ${key}`)
  }
  return Object.freeze({
    variableRedeclarations: value.variableRedeclarations,
    functionClassRedeclarations: value.functionClassRedeclarations,
  })
}

function normalizeModuleSemantics(value) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal module semantics')
  assertOwnFields(value, MODULE_SEMANTICS_FIELDS, 'journal module semantics')
  if (!DEFAULT_EXPORT_BINDINGS.has(value.defaultExportBinding)) {
    throw new Error('invalid dsh-ptc-plus journal default export binding semantics')
  }
  return Object.freeze({ defaultExportBinding: value.defaultExportBinding })
}

function migrateJournal(value, resolveLegacyConfirm) {
  if (value.version === JOURNAL_VERSION) return value
  const legacy = value.version === LEGACY_JOURNAL_VERSION
  assertOwnFields(
    value,
    legacy ? LEGACY_JOURNAL_FIELDS : PREDECESSOR_JOURNAL_FIELDS,
    'dsh-ptc-plus journal',
  )
  if (!BINDING_MODES.has(value.bindingMode)) throw new Error('invalid dsh-ptc-plus journal binding mode')
  const { bindingMode, ...rest } = value
  return {
    ...rest,
    version: JOURNAL_VERSION,
    bindingPolicy: {
      variableRedeclarations: bindingMode === 'loose',
      functionClassRedeclarations: false,
    },
    rewritePolicy: legacy ? LEGACY_REWRITE_POLICY : value.rewritePolicy,
    moduleSemantics: { defaultExportBinding: LEGACY_DEFAULT_EXPORT_BINDING },
    confirms: legacy
      ? normalizeLegacyConfirms(value.confirms, resolveLegacyConfirm)
      : value.confirms,
  }
}

/** Validate and detach one journal emitted by the runtime. */
export function normalizeJournal(value, options = {}) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal')
  if (![LEGACY_JOURNAL_VERSION, INTERMEDIATE_JOURNAL_VERSION, PREVIOUS_JOURNAL_VERSION, JOURNAL_VERSION].includes(value.version)
    || !STATUSES.has(value.status)) {
    throw new Error('invalid dsh-ptc-plus journal')
  }
  const migrated = migrateJournal(value, options.resolveLegacyConfirm)
  assertOwnFields(migrated, JOURNAL_FIELDS, 'dsh-ptc-plus journal')
  const bindingPolicy = normalizeBindingPolicy(migrated.bindingPolicy)
  const rewritePolicy = normalizeRewritePolicy(migrated.rewritePolicy)
  const moduleSemantics = normalizeModuleSemantics(migrated.moduleSemantics)
  const calls = normalizeCalls(migrated.calls)
  const operations = normalizeOperations(migrated.operations)
  const confirms = normalizeConfirms(migrated.confirms)
  const diagnostics = normalizeDiagnostics(migrated.diagnostics)
  const completion = normalizeCompletion(
    migrated.completion,
    migrated.status === 'durable' || migrated.status === 'volatile',
  )
  if ((migrated.status === 'discarded' || migrated.status === 'noop')
    && (calls.length !== 0 || operations.length !== 0)) {
    throw new Error(`${migrated.status} dsh-ptc-plus journal must not contain calls or operations`)
  }
  if (migrated.volatileReason !== undefined && typeof migrated.volatileReason !== 'string') {
    throw new Error('invalid dsh-ptc-plus volatile reason')
  }
  if (migrated.volatileReason !== undefined && migrated.status !== 'volatile' && migrated.status !== 'discarded') {
    throw new Error('dsh-ptc-plus volatile reason requires volatile or discarded status')
  }
  return Object.freeze({
    version: JOURNAL_VERSION,
    bindingPolicy,
    rewritePolicy,
    moduleSemantics,
    status: migrated.status,
    calls: Object.freeze(calls),
    operations: Object.freeze(operations),
    confirms: Object.freeze(confirms),
    diagnostics: Object.freeze(diagnostics),
    ...(completion === undefined ? {} : { completion }),
    ...(migrated.volatileReason === undefined ? {} : { volatileReason: migrated.volatileReason }),
  })
}

/** Validate the required persisted relation that makes one edit result executable history. */
export function normalizeDerivedEditResult(meta, expectedTargetCallSeq) {
  if (!Number.isSafeInteger(expectedTargetCallSeq) || expectedTargetCallSeq < 0) {
    throw new Error('derived edit does not identify an eligible target call')
  }
  if (!isRecord(meta)) throw new Error('invalid dsh-ptc-plus derived edit metadata')
  const target = meta[EDIT_TARGET_KEY]
  const derived = meta[DERIVED_RUN_KEY]
  if (!isRecord(target)) throw new Error('invalid dsh-ptc-plus edit target metadata')
  assertOwnFields(target, EDIT_TARGET_FIELDS, 'edit target metadata')
  if (target.targetCallSeq !== expectedTargetCallSeq) {
    throw new Error('derived edit target does not match the eligible target call')
  }
  if (!isRecord(derived) || typeof derived.code !== 'string' || typeof derived.description !== 'string') {
    throw new Error('invalid dsh-ptc-plus derived run metadata')
  }
  assertOwnFields(derived, DERIVED_RUN_FIELDS, 'derived run metadata')
  const journal = normalizeJournal(meta[JOURNAL_KEY])
  if (journal.status === 'noop') throw new Error('derived edit journal must not be noop')
  const recoveryBoundaries = meta[RECOVERY_BOUNDARY_KEY] === undefined
    ? undefined
    : normalizeRecoveryBoundaries(meta[RECOVERY_BOUNDARY_KEY])
  return Object.freeze({
    targetCallSeq: target.targetCallSeq,
    code: derived.code,
    description: derived.description,
    journal,
    ...(recoveryBoundaries === undefined ? {} : { recoveryBoundaries }),
  })
}

/** Compare only the required persisted relation for one derived edit. */
export function derivedEditResultsEqual(leftMeta, rightMeta, expectedTargetCallSeq) {
  try {
    const left = encodeValue(normalizeDerivedEditResult(leftMeta, expectedTargetCallSeq))
    const right = encodeValue(normalizeDerivedEditResult(rightMeta, expectedTargetCallSeq))
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/** Compare journal semantics without recursive traversal of nested JSON. */
export function journalsEqual(left, right) {
  try {
    const leftWire = encodeValue(normalizeJournal(left))
    const rightWire = encodeValue(normalizeJournal(right))
    return JSON.stringify(leftWire) === JSON.stringify(rightWire)
  } catch {
    return false
  }
}

/** Compare the optional recovery frontier attached to one settlement. */
export function recoveryBoundariesEqual(left, right) {
  if (left === undefined || right === undefined) return left === right
  try {
    return JSON.stringify(normalizeRecoveryBoundaries(left))
      === JSON.stringify(normalizeRecoveryBoundaries(right))
  } catch {
    return false
  }
}

function normalizeRecoveryBoundaryValue(value, eventSeq = undefined) {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.failedCallSeq) || value.failedCallSeq < 0
    || (value.frontierCallSeq !== null
      && (!Number.isSafeInteger(value.frontierCallSeq) || value.frontierCallSeq < 0))) {
    throw new Error('invalid dsh-ptc-plus recovery boundary')
  }
  assertOwnFields(value, new Set(['failedCallSeq', 'frontierCallSeq']), 'recovery boundary')
  if (eventSeq !== undefined && (!Number.isSafeInteger(eventSeq) || eventSeq < 0)) {
    throw new Error('invalid dsh-ptc-plus recovery boundary event sequence')
  }
  return {
    failedCallSeq: value.failedCallSeq,
    frontierCallSeq: value.frontierCallSeq,
    ...(eventSeq === undefined ? {} : { eventSeq }),
  }
}

/** Validate recovery boundaries stored on a settled tool result. */
export function normalizeRecoveryBoundaries(value, eventSeq = undefined) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus recovery boundaries')
  return Object.freeze(value.map(boundary => Object.freeze(
    normalizeRecoveryBoundaryValue(boundary, eventSeq),
  )))
}

/** Merge replay contractions into private tool-result metadata. */
export function withRecoveryBoundaries(meta, boundaries) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: cloneJson(meta) }
  base[RECOVERY_BOUNDARY_KEY] = normalizeRecoveryBoundaries(boundaries)
  return base
}

/**
 * Convert the retired custom boundary event in a raw log before DSH restores it.
 * The returned log is a detached, renumbered copy; the input is never mutated.
 */
export function migrateRecoveryBoundaryEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('recovery-boundary migration expects an event array')
  const migrated = []
  const pending = []
  for (const event of events) {
    if (event?.type === RECOVERY_BOUNDARY_EVENT) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
        throw new Error('invalid dsh-ptc-plus recovery boundary event sequence')
      }
      pending.push(normalizeRecoveryBoundaryValue(event.data))
      continue
    }
    const detached = cloneJson(event)
    if (pending.length > 0 && detached?.type === 'tool/result') {
      const data = isRecord(detached.data) ? { ...detached.data } : {}
      const meta = isRecord(data.meta) ? { ...data.meta } : {}
      const existing = meta[RECOVERY_BOUNDARY_KEY] === undefined
        ? []
        : normalizeRecoveryBoundaries(meta[RECOVERY_BOUNDARY_KEY])
      meta[RECOVERY_BOUNDARY_KEY] = [...existing, ...pending]
      data.meta = meta
      detached.data = data
      pending.length = 0
    }
    migrated.push(detached)
  }
  if (pending.length > 0) {
    throw new Error('recovery boundary has no later tool/result settlement for migration')
  }
  const sequenceMap = new Map()
  for (const [index, event] of migrated.entries()) {
    if (Number.isSafeInteger(event?.seq) && event.seq >= 0) sequenceMap.set(event.seq, index)
  }
  return Object.freeze(migrated.map((event, index) => Object.freeze({
    ...event,
    seq: index,
    ...(Array.isArray(event.sourceEventSeqs)
      ? { sourceEventSeqs: event.sourceEventSeqs.map(seq => sequenceMap.get(seq) ?? seq) }
      : {}),
  })))
}

/** Resolve the persisted event identity for one named tool call being dispatched. */
export function liveToolCallSeq(session, callId, toolName) {
  const events = sessionEvents(session)
  if (!Array.isArray(events) || typeof callId !== 'string' || callId.length === 0
    || typeof toolName !== 'string' || toolName.length === 0) return undefined

  const pairedCallSeqs = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/result' || !Array.isArray(event.sourceEventSeqs)) continue
    for (const sourceSeq of event.sourceEventSeqs) {
      if (Number.isSafeInteger(sourceSeq) && sourceSeq >= 0) pairedCallSeqs.add(sourceSeq)
    }
  }

  const candidates = []
  for (const event of events) {
    if (event?.type !== 'tool/call' || event.data?.name !== toolName
      || event.data.callId !== callId || pairedCallSeqs.has(event.seq)) continue
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new Error(`current ${toolName} call has an invalid session event sequence`)
    }
    candidates.push(event.seq)
  }
  if (candidates.length > 1) {
    throw new Error(`session log contains multiple unpaired ${toolName} calls for callId ${JSON.stringify(callId)}`)
  }
  return candidates[0]
}

/** Start a mutable journal for one live cell. */
export function createJournal(confirms = [], bindingPolicy, rewritePolicy) {
  if (typeof bindingPolicy === 'string') {
    if (!BINDING_MODES.has(bindingPolicy)) throw new TypeError('invalid dsh-ptc-plus journal binding mode')
    bindingPolicy = {
      variableRedeclarations: bindingPolicy === 'loose',
      functionClassRedeclarations: false,
    }
  }
  return {
    version: JOURNAL_VERSION,
    bindingPolicy: normalizeBindingPolicy(bindingPolicy),
    rewritePolicy: normalizeRewritePolicy(rewritePolicy),
    moduleSemantics: normalizeModuleSemantics({
      defaultExportBinding: LIVE_DEFAULT_EXPORT_BINDING,
    }),
    calls: [],
    operations: [],
    confirms: [...confirms],
    diagnostics: [],
  }
}

function sourceForRunCall(call) {
  try {
    const args = JSON.parse(call.data.arguments)
    return isRecord(args) && typeof args.code === 'string' ? args.code : undefined
  } catch {
    return undefined
  }
}

/** Return an owned state transition; reject volatile saves and unknown named restores. */
export function reduceStateOperations({ nodes, head, checkpoints }, operations, nodeIndex) {
  const nextCheckpoints = new Map(checkpoints)
  let nextHead = head
  let restored = false
  for (const operation of operations) {
    if (operation.action === 'save') {
      if (nodeIndex === undefined) throw new Error('volatile journal cannot save a durable REPL state')
      nextCheckpoints.set(operation.name, nodeIndex)
      continue
    }
    if (operation.action === 'delete') {
      nextCheckpoints.delete(operation.name)
      continue
    }
    const target = operation.name === undefined
      ? nodeIndex === undefined ? nextHead : nodes[nodeIndex]?.parent
      : nextCheckpoints.get(operation.name)
    if (operation.name !== undefined && target === undefined) {
      throw new Error(`session log restores unknown REPL state "${operation.name}"`)
    }
    nextHead = target
    restored = true
  }
  return { head: nextHead, checkpoints: nextCheckpoints, restored }
}

function applyOperations(state, operations, nodeIndex) {
  const transition = reduceStateOperations(state, operations, nodeIndex)
  state.head = transition.head
  state.checkpoints = transition.checkpoints
  if (transition.restored) {
    state.trusted = true
    state.volatileSuffix.length = 0
  }
}

function applyRecord(state, record, invalidCallSeqs) {
  const { call, code, result } = record
  if (invalidCallSeqs.has(call.seq)) return
  if (code === undefined || result?.journal === undefined) {
    state.trusted = false
    state.volatileSuffix.push({ seq: call.seq, code, reason: result?.error ?? 'missing dsh-ptc-plus journal result' })
    return
  }
  const journal = result.journal
  if (journal.status === 'noop') return
  if (journal.status === 'discarded') {
    if (journal.volatileReason !== undefined) {
      state.trusted = false
      state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason })
    }
    return
  }
  if (journal.status === 'volatile') {
    state.trusted = false
    state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason ?? 'volatile cell' })
    applyOperations(state, journal.operations, undefined)
    return
  }
  if (!state.trusted) {
    state.trusted = true
    state.volatileSuffix.length = 0
  }
  const node = Object.freeze({
    code,
    journal,
    callSeq: call.seq,
    parent: state.head,
  })
  const index = state.nodes.push(node) - 1
  state.head = index
  applyOperations(state, journal.operations, index)
}

function forceRecoveryHead(state, boundary) {
  state.head = boundary.frontierCallSeq === null
    ? undefined
    : state.nodes.findIndex(node => node.callSeq === boundary.frontierCallSeq)
  if (state.head === -1) throw new Error('recovery boundary frontier is not reconstructable')
  state.trusted = true
  state.volatileSuffix = []
}

function recordEventSeq(record) {
  return record.result?.eventSeq ?? record.call.seq
}

function foldRecords(records, invalidCallSeqs, boundaries = []) {
  const state = {
    nodes: [],
    head: undefined,
    checkpoints: new Map(),
    volatileSuffix: [],
    trusted: true,
  }
  let boundaryIndex = 0
  for (const record of records) {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].eventSeq < recordEventSeq(record)) {
      forceRecoveryHead(state, boundaries[boundaryIndex++])
    }
    applyRecord(state, record, invalidCallSeqs)
  }
  while (boundaryIndex < boundaries.length) forceRecoveryHead(state, boundaries[boundaryIndex++])
  return state
}

function dependsOn(nodes, index, ancestor) {
  for (let cursor = index; cursor !== undefined; cursor = nodes[cursor]?.parent) {
    if (cursor === ancestor) return true
  }
  return false
}

function timelineRun(call, result, eventIndex, journal) {
  let args
  try {
    const parsed = JSON.parse(call.data.arguments)
    if (isRecord(parsed)) args = Object.freeze(parsed)
  } catch {
    // Invalid persisted arguments cannot support derived source facts.
  }
  return Object.freeze({
    index: eventIndex,
    callSeq: Number.isSafeInteger(call.seq) ? call.seq : undefined,
    args,
    source: typeof args?.code === 'string' ? args.code : undefined,
    journal,
    rewrites: validatedRewrites(result.data?.meta),
  })
}

function timelineDerivedRun(call, result, eventIndex, derived) {
  return Object.freeze({
    index: eventIndex,
    callSeq: Number.isSafeInteger(call.seq) ? call.seq : undefined,
    args: Object.freeze({ description: derived.description }),
    source: derived.code,
    journal: derived.journal,
    rewrites: validatedRewrites(result.data?.meta),
  })
}

function successfulTimelineRun(run) {
  return run.journal?.completion?.kind === 'return' && run.journal.status !== 'noop'
}

/**
 * Fold persisted tool events once into the call/result and edit-target timeline
 * shared by prompt projection and cold journal recovery.
 */
export function foldSessionTimeline(events) {
  const empty = {
    openTurn: false,
    executableCalls: new Map(),
    calls: [],
    results: new Map(),
    boundaries: [],
    found: false,
    unavailableResultSeq: undefined,
    lastSuccessfulRunIndex: undefined,
    latestRun: undefined,
    editableRun: undefined,
    editTargets: new Map(),
  }
  if (!Array.isArray(events)) return empty

  const state = { ...empty }
  const pendingByCallId = new Map()
  const seenCallIds = new Set()
  const claimedEditTargets = new Set()
  const editClaims = new Map()
  const journalResultSeqs = new Set()
  let scope = 0

  const resetTurn = (openTurn) => {
    state.openTurn = openTurn
    scope += 1
    pendingByCallId.clear()
    seenCallIds.clear()
    claimedEditTargets.clear()
    state.latestRun = undefined
    state.editableRun = undefined
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]
    if (event?.type === 'turn/start') {
      resetTurn(true)
      continue
    }
    if (event?.type === 'turn/end') {
      resetTurn(false)
      continue
    }
    if (event?.type === RECOVERY_BOUNDARY_EVENT) {
      throw new Error('legacy recovery boundary requires migration before DSH session restore')
      continue
    }
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      const executable = event.data.name === 'run_code' || event.data.name === 'edit_run_code'
      let entry = { event, eventIndex, scope }
      if (executable) {
        if (Number.isSafeInteger(event.seq) && event.seq >= 0 && state.executableCalls.has(event.seq)) {
          throw new Error('session log contains a duplicate run_code call sequence')
        }
        if (event.data.name === 'edit_run_code') {
          const targetCallSeq = state.editableRun?.callSeq
          const target = targetCallSeq !== undefined && state.editableRun.source !== undefined
            && !claimedEditTargets.has(targetCallSeq)
            ? Object.freeze({ source: state.editableRun.source, callSeq: targetCallSeq })
            : undefined
          entry = { ...entry, editTarget: target }
          state.editTargets.set(event.seq, target)
          if (target !== undefined) {
            claimedEditTargets.add(target.callSeq)
            editClaims.set(event.seq, target.callSeq)
          }
        }
        state.calls.push(event)
        if (Number.isSafeInteger(event.seq) && event.seq >= 0) {
          state.executableCalls.set(event.seq, entry)
        }
      }
      if (seenCallIds.has(event.data.callId)) pendingByCallId.set(event.data.callId, null)
      else {
        seenCallIds.add(event.data.callId)
        pendingByCallId.set(event.data.callId, entry)
      }
      continue
    }
    if (event?.type !== 'tool/result') continue

    const sourceSeq = event.sourceEventSeqs?.[0]
    const callId = event.data?.message?.source?.callId
    let entry = Number.isSafeInteger(sourceSeq) ? state.executableCalls.get(sourceSeq) : undefined
    if (entry === undefined && !Number.isSafeInteger(sourceSeq) && typeof callId === 'string') {
      entry = pendingByCallId.get(callId)
    }
    if (typeof callId === 'string') pendingByCallId.delete(callId)
    if (entry === null) {
      state.latestRun = undefined
      state.editableRun = undefined
      continue
    }

    const call = entry?.event
    const callSeq = call?.seq
    const meta = event.data?.meta
    let normalized
    if (isRecord(meta) && Object.hasOwn(meta, JOURNAL_KEY)) {
      if (Number.isSafeInteger(sourceSeq) && journalResultSeqs.has(sourceSeq)) {
        throw new Error(`session log contains duplicate PTC journal results for call seq ${sourceSeq}`)
      }
      if (Number.isSafeInteger(sourceSeq)) journalResultSeqs.add(sourceSeq)
      if (entry === undefined) {
        if (Number.isSafeInteger(sourceSeq)) state.unavailableResultSeq ??= sourceSeq
        continue
      }
      const resultSeq = Number.isSafeInteger(sourceSeq) ? sourceSeq : callSeq
      const raw = {
        meta,
        eventSeq: Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : resultSeq,
        eventIndex,
      }
      if (Object.hasOwn(meta, RECOVERY_BOUNDARY_KEY)) {
        state.boundaries.push(...normalizeRecoveryBoundaries(
          meta[RECOVERY_BOUNDARY_KEY], raw.eventSeq,
        ))
      }
      try {
        if (call.data.name === 'edit_run_code') {
          const derived = normalizeDerivedEditResult(meta, entry.editTarget?.callSeq)
          normalized = { ...raw, journal: derived.journal, derived }
        } else if (call.data.name === 'run_code') {
          const rawJournal = meta[JOURNAL_KEY]
          const resolveLegacyConfirm = rawJournal?.version === LEGACY_JOURNAL_VERSION
            ? legacyCallId => {
              const candidates = [...state.executableCalls.values()]
                .filter(candidate => candidate.eventIndex < eventIndex
                  && candidate.event.data?.name === 'run_code'
                  && candidate.event.data.callId === legacyCallId
                  && !state.results.has(candidate.event.seq))
              return candidates.length === 1 ? candidates[0].event.seq : undefined
            }
            : undefined
          normalized = { ...raw, journal: normalizeJournal(rawJournal, { resolveLegacyConfirm }) }
        }
      } catch (error) {
        normalized = { ...raw, error: error.message }
      }
      if (Number.isSafeInteger(resultSeq)) state.results.set(resultSeq, normalized)
      state.found = true
    }

    const claimedTarget = editClaims.get(callSeq)
    if (claimedTarget !== undefined) {
      editClaims.delete(callSeq)
      if (normalized?.derived === undefined) claimedEditTargets.delete(claimedTarget)
    }
    if (entry === undefined || entry.scope !== scope) continue
    if (call.data.name === 'edit_run_code') {
      if (normalized?.derived !== undefined) {
        const run = timelineDerivedRun(call, event, eventIndex, normalized.derived)
        state.latestRun = run
        state.editableRun = run
        if (successfulTimelineRun(run)) state.lastSuccessfulRunIndex = eventIndex
      }
      continue
    }
    if (call.data.name !== 'run_code') {
      // Unrelated native settlements do not change the current editable cell.
      // The edit target is captured at dispatch time and remains valid until a
      // new executable cell or turn boundary supersedes it.
      continue
    }
    const run = timelineRun(call, event, eventIndex, normalized?.journal)
    state.latestRun = run
    state.editableRun = run
    if (successfulTimelineRun(run)) state.lastSuccessfulRunIndex = eventIndex
  }
  return state
}

/** Fold the session log into the last exactly replayable frontier. */
export function recoverJournal(session, currentCallSeq, options = {}) {
  const events = sessionEvents(session)
  if (!Array.isArray(events)) {
    return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
  }
  const timeline = foldSessionTimeline(events)
  const calls = timeline.calls.filter(call => call.seq !== currentCallSeq)
  const { executableCalls, results, found } = timeline
  const extraBoundaries = options?.extraBoundaries ?? []
  const boundaries = [
    ...timeline.boundaries,
    ...normalizeRecoveryBoundaries(extraBoundaries, undefined).map(boundary => ({
      ...boundary,
      eventSeq: Number.POSITIVE_INFINITY,
    })),
  ].sort((left, right) => left.eventSeq - right.eventSeq)
  if (timeline.unavailableResultSeq !== undefined) {
    throw new Error(`PTC journal result references unavailable run_code call seq ${timeline.unavailableResultSeq}`)
  }

  const confirmedNoops = new Set()
  for (const { journal, eventIndex } of results.values()) {
    for (const callSeq of journal?.confirms ?? []) {
      const confirmed = executableCalls.get(callSeq)
      if (confirmed === undefined || confirmed.eventIndex >= eventIndex || results.has(callSeq)) {
        throw new Error(`confirmed no-op does not identify an earlier unjournaled run_code call seq ${callSeq}`)
      }
      confirmedNoops.add(callSeq)
    }
  }
  const records = []
  const orderedRecords = []
  const invalidCallSeqs = new Set()
  const appliedBoundaries = []
  let state = foldRecords(records, invalidCallSeqs)
  let boundaryIndex = 0
  const applyBoundariesBefore = (seq) => {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].eventSeq <= seq) {
      const boundary = boundaries[boundaryIndex++]
      const failedIndex = state.nodes.findIndex(node => node.callSeq === boundary.failedCallSeq)
      if (failedIndex < 0) throw new Error('recovery boundary references an unavailable failed cell')
      const expectedFrontier = state.nodes[failedIndex].parent
      const frontierIndex = boundary.frontierCallSeq === null
        ? undefined
        : state.nodes.findIndex(node => node.callSeq === boundary.frontierCallSeq)
      if (frontierIndex !== expectedFrontier) {
        throw new Error('recovery boundary does not identify the failed cell parent')
      }
      for (let index = 0; index < state.nodes.length; index += 1) {
        if (dependsOn(state.nodes, index, failedIndex)) invalidCallSeqs.add(state.nodes[index].callSeq)
      }
      appliedBoundaries.push(boundary)
      state = foldRecords(records, invalidCallSeqs, appliedBoundaries)
    }
  }
  for (const call of calls) {
    const result = results.get(call.seq)
    const code = call.data?.name === 'edit_run_code' ? result?.derived?.code : sourceForRunCall(call)
    const record = { call, code, result }
    if (call.data?.name === 'edit_run_code' && record.code === undefined && result === undefined) continue
    if (result?.journal === undefined && confirmedNoops.has(call.seq)) continue
    orderedRecords.push(record)
  }
  orderedRecords.sort((left, right) => (
    recordEventSeq(left) - recordEventSeq(right) || left.call.seq - right.call.seq
  ))
  for (const record of orderedRecords) {
    applyBoundariesBefore(recordEventSeq(record))
    records.push(record)
    applyRecord(state, record, invalidCallSeqs)
  }
  applyBoundariesBefore(Number.POSITIVE_INFINITY)
  return {
    nodes: state.nodes,
    head: state.head,
    checkpoints: state.checkpoints,
    volatileSuffix: state.volatileSuffix,
    available: found,
  }
}

/** Return source nodes from the empty state to a selected durable head. */
export function pathToHead(state) {
  const path = []
  for (let cursor = state.head; cursor !== undefined;) {
    const node = state.nodes[cursor]
    if (node === undefined) throw new Error('invalid dsh-ptc-plus journal head')
    path.push(node)
    cursor = node.parent
  }
  path.reverse()
  return path
}

/** Merge the journal into the tool result's private metadata. */
export function withJournal(meta, journal) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: cloneJson(meta) }
  base[JOURNAL_KEY] = normalizeJournal(journal)
  return base
}

const REWRITE_FIELDS = new Set(['kind', 'description', 'source'])
const REWRITE_KINDS = new Set(['import', 'redeclaration', 'export'])

/** Validate and detach one rewrite record emitted by the runtime. */
export function normalizeRewrites(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus rewrites')
  return Object.freeze(value.map((rewrite, index) => {
    if (!isRecord(rewrite) || !REWRITE_KINDS.has(rewrite.kind) || typeof rewrite.description !== 'string'
      || rewrite.description.length === 0) {
      throw new Error(`invalid dsh-ptc-plus rewrite at index ${index}`)
    }
    assertOwnFields(rewrite, REWRITE_FIELDS, `dsh-ptc-plus rewrite at index ${index}`)
    if (rewrite.source !== undefined && typeof rewrite.source !== 'string') {
      throw new Error(`invalid dsh-ptc-plus rewrite source at index ${index}`)
    }
    return Object.freeze({
      kind: rewrite.kind,
      description: rewrite.description,
      ...(rewrite.source === undefined ? {} : { source: rewrite.source }),
    })
  }))
}

/** Read optional rewrite provenance without letting malformed metadata affect settlement. */
export function validatedRewrites(meta) {
  if (!isRecord(meta) || !Object.hasOwn(meta, REWRITES_KEY)) return undefined
  try {
    return normalizeRewrites(meta[REWRITES_KEY])
  } catch {
    return undefined
  }
}

/** Merge rewrite records into the tool result's private metadata. */
export function withRewrites(meta, rewrites) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: cloneJson(meta) }
  base[REWRITES_KEY] = normalizeRewrites(rewrites)
  return base
}

export function assertStateName(name) {
  if (!validName(name)) {
    throw new Error('REPL state name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
  }
  return name
}
