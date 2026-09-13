import { decodeValue, encodeValue, normalizeValueWire } from './value-wire.js'
import { normalizeDiagnostic } from './diagnostic.js'
import { assertOwnFields, isRecord } from './record-utils.js'
import { sessionEvents } from './session-events.js'
import { LEGACY_LANGUAGE_SEMANTICS, normalizeLanguageSemantics } from './language-semantics.js'
import {
  LEGACY_DEFAULT_EXPORT_BINDING,
  LEGACY_IMPORT_EXPRESSION_BOUNDARY,
  LIVE_MODULE_SEMANTICS,
} from './repl-rewrite-contract.js'
import { userBindingsSnapshotFromMeta } from './user-bindings.js'
import {
  JOURNAL_KEY,
  EDIT_TARGET_KEY,
  DERIVED_RUN_KEY,
  REWRITES_KEY,
  RECOVERY_BOUNDARY_KEY,
  JOURNAL_VERSION,
  IMPORT_BOUNDARY_JOURNAL_VERSION,
  PER_NAME_USER_BINDINGS_JOURNAL_VERSION,
  PER_NAME_JOURNAL_FIELDS,
  WHOLE_ENTRY_JOURNAL_FIELDS,
  LIVE_USER_BINDINGS_SHADOW_POLICY,
  LEGACY_USER_BINDINGS_SHADOW_POLICY,
  normalizeJournalUserBindingNames,
  LIVE_USER_BINDINGS_REUSE_POLICY,
  LEGACY_USER_BINDINGS_REUSE_POLICY,
  LEGACY_JOURNAL_VERSION,
  USER_BINDING_RELATIONLESS_JOURNAL_VERSION,
  FINGERPRINT_REUSE_JOURNAL_VERSION,
  VERSIONED_BINDING_REUSE_JOURNAL_VERSION,
  RECOVERY_BOUNDARY_EVENT,
  STATUSES,
  BINDING_MODES,
  JOURNAL_FIELDS,
  FINGERPRINT_REUSE_JOURNAL_FIELDS,
  RELATIONLESS_JOURNAL_FIELDS,
  PREDECESSOR_JOURNAL_FIELDS,
  LEGACY_JOURNAL_FIELDS,
  BINDING_POLICY_FIELDS,
  REWRITE_POLICY_FIELDS,
  MODULE_SEMANTICS_FIELDS,
  LEGACY_MODULE_SEMANTICS_FIELDS,
  IMPORT_EXPRESSION_BOUNDARIES,
  DEFAULT_EXPORT_BINDINGS,
  CALL_SUCCESS_FIELDS,
  CALL_ERROR_FIELDS,
  OPERATION_FIELDS,
  RETURN_FIELDS,
  THROW_FIELDS,
  ERROR_FIELDS,
  EDIT_TARGET_FIELDS,
  DERIVED_RUN_FIELDS,
  JOURNAL_VERSIONS,
  USER_BINDINGS_REUSE_POLICIES,
  RECOVERY_BOUNDARY_FIELDS,
  REWRITE_FIELDS,
  REWRITE_KINDS,
} from './session-journal-schema.js'

export {
  JOURNAL_KEY,
  EDIT_TARGET_KEY,
  DERIVED_RUN_KEY,
  REWRITES_KEY,
  RECOVERY_BOUNDARY_KEY,
  JOURNAL_VERSION,
  LIVE_USER_BINDINGS_REUSE_POLICY,
  RECOVERY_BOUNDARY_EVENT,
} from './session-journal-schema.js'

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
  if (!IMPORT_EXPRESSION_BOUNDARIES.has(value.importExpressionBoundary)) {
    throw new Error('invalid dsh-ptc-plus journal import expression boundary semantics')
  }
  return Object.freeze({
    defaultExportBinding: value.defaultExportBinding,
    importExpressionBoundary: value.importExpressionBoundary,
  })
}

function migrateLegacyModuleSemantics(value) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal module semantics')
  assertOwnFields(value, LEGACY_MODULE_SEMANTICS_FIELDS, 'journal module semantics')
  return { ...value, importExpressionBoundary: LEGACY_IMPORT_EXPRESSION_BOUNDARY }
}

function normalizeUserBindingsFingerprint(value) {
  if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('invalid dsh-ptc-plus journal user binding fingerprint')
  }
  return value
}

function migrateJournal(value, resolveLegacyConfirm) {
  if (value.version === JOURNAL_VERSION) return value
  if (value.version === PER_NAME_USER_BINDINGS_JOURNAL_VERSION) {
    assertOwnFields(value, PER_NAME_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
    return { ...value, version: JOURNAL_VERSION, languageSemantics: LEGACY_LANGUAGE_SEMANTICS }
  }
  const shadow = { userBindingsShadowPolicy: LEGACY_USER_BINDINGS_SHADOW_POLICY, userBindingNames: null,
    languageSemantics: LEGACY_LANGUAGE_SEMANTICS }
  if (value.version === IMPORT_BOUNDARY_JOURNAL_VERSION) {
    assertOwnFields(value, WHOLE_ENTRY_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
    return { ...value, version: JOURNAL_VERSION, ...shadow }
  }
  if (value.version === VERSIONED_BINDING_REUSE_JOURNAL_VERSION) {
    assertOwnFields(value, WHOLE_ENTRY_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
    return { ...value, version: JOURNAL_VERSION, ...shadow, moduleSemantics: migrateLegacyModuleSemantics(value.moduleSemantics) }
  }
  if (value.version === FINGERPRINT_REUSE_JOURNAL_VERSION) {
    assertOwnFields(value, FINGERPRINT_REUSE_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
    return {
      ...value,
      version: JOURNAL_VERSION,
      moduleSemantics: migrateLegacyModuleSemantics(value.moduleSemantics),
      userBindingsReusePolicy: LEGACY_USER_BINDINGS_REUSE_POLICY,
      ...shadow,
    }
  }
  if (value.version === USER_BINDING_RELATIONLESS_JOURNAL_VERSION) {
    assertOwnFields(value, RELATIONLESS_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
    return {
      ...value,
      version: JOURNAL_VERSION,
      moduleSemantics: migrateLegacyModuleSemantics(value.moduleSemantics),
      userBindingsFingerprint: null,
      userBindingsReusePolicy: LEGACY_USER_BINDINGS_REUSE_POLICY,
      ...shadow,
    }
  }
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
    moduleSemantics: {
      defaultExportBinding: LEGACY_DEFAULT_EXPORT_BINDING,
      importExpressionBoundary: LEGACY_IMPORT_EXPRESSION_BOUNDARY,
    },
    userBindingsFingerprint: null,
    userBindingsReusePolicy: LEGACY_USER_BINDINGS_REUSE_POLICY,
    ...shadow,
    confirms: legacy
      ? normalizeLegacyConfirms(value.confirms, resolveLegacyConfirm)
      : value.confirms,
  }
}

/** Validate and detach one journal emitted by the runtime. */
export function normalizeJournal(value, options = {}) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus journal')
  if (!JOURNAL_VERSIONS.has(value.version)
    || !STATUSES.has(value.status)) {
    throw new Error('invalid dsh-ptc-plus journal')
  }
  const migrated = migrateJournal(value, options.resolveLegacyConfirm)
  assertOwnFields(migrated, JOURNAL_FIELDS, 'dsh-ptc-plus journal')
  const languageSemantics = normalizeLanguageSemantics(migrated.languageSemantics)
  const bindingPolicy = normalizeBindingPolicy(migrated.bindingPolicy)
  const rewritePolicy = normalizeRewritePolicy(migrated.rewritePolicy)
  const moduleSemantics = normalizeModuleSemantics(migrated.moduleSemantics)
  const userBindingsFingerprint = normalizeUserBindingsFingerprint(migrated.userBindingsFingerprint)
  const userBindingsReusePolicy = migrated.userBindingsReusePolicy
  const userBindingNames = normalizeJournalUserBindingNames(migrated)
  if (!USER_BINDINGS_REUSE_POLICIES.has(userBindingsReusePolicy)) {
    throw new Error('invalid dsh-ptc-plus journal user binding reuse policy')
  }
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
    languageSemantics,
    bindingPolicy,
    rewritePolicy,
    moduleSemantics,
    userBindingsFingerprint,
    userBindingsReusePolicy,
    userBindingsShadowPolicy: migrated.userBindingsShadowPolicy,
    userBindingNames,
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
  const userBindings = userBindingsForJournal(meta, journal)
  return Object.freeze({
    targetCallSeq: target.targetCallSeq,
    code: derived.code,
    description: derived.description,
    journal,
    ...(recoveryBoundaries === undefined ? {} : { recoveryBoundaries }),
    ...(userBindings === undefined ? {} : { userBindings }),
  })
}

export function userBindingsForJournal(meta, journal) {
  const userBindings = userBindingsSnapshotFromMeta(meta)
  if (journal.userBindingsFingerprint === null) {
    if (userBindings !== undefined) {
      throw new Error('dsh-ptc-plus journal does not declare user binding metadata')
    }
    validateUserBindingNameProviders(journal, undefined)
    return undefined
  }
  if (userBindings === undefined) {
    throw new Error('dsh-ptc-plus journal requires user binding metadata')
  }
  if (userBindings.fingerprint !== journal.userBindingsFingerprint) {
    throw new Error('dsh-ptc-plus journal user binding fingerprint does not match metadata')
  }
  validateUserBindingNameProviders(journal, userBindings)
  return userBindings
}

function validateUserBindingNameProviders(journal, snapshot) {
  const providers = new Map((snapshot?.entries ?? []).flatMap(entry => (
    (entry.scope === 'namespace' ? [entry.name] : entry.symbols).map(name => [name, entry.id])
  )))
  for (const fact of journal.userBindingNames ?? []) {
    if (fact.state === 'provider' && providers.get(fact.name) !== fact.entryId) {
      throw new Error('journal user binding name evidence has no matching provider')
    }
  }
  if (journal.userBindingNames !== null) {
    const names = new Set(journal.userBindingNames.map(fact => fact.name))
    if ([...providers.keys()].some(name => !names.has(name))) {
      throw new Error('journal user binding name evidence is incomplete')
    }
  }
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
  assertOwnFields(value, RECOVERY_BOUNDARY_FIELDS, 'recovery boundary')
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
export function createJournal(confirms = [], bindingPolicy, rewritePolicy, languageSemantics = LEGACY_LANGUAGE_SEMANTICS) {
  if (typeof bindingPolicy === 'string') {
    if (!BINDING_MODES.has(bindingPolicy)) throw new TypeError('invalid dsh-ptc-plus journal binding mode')
    bindingPolicy = {
      variableRedeclarations: bindingPolicy === 'loose',
      functionClassRedeclarations: false,
    }
  }
  return {
    version: JOURNAL_VERSION,
    languageSemantics: normalizeLanguageSemantics(languageSemantics),
    bindingPolicy: normalizeBindingPolicy(bindingPolicy),
    rewritePolicy: normalizeRewritePolicy(rewritePolicy),
    moduleSemantics: normalizeModuleSemantics(LIVE_MODULE_SEMANTICS),
    userBindingsFingerprint: null,
    userBindingsReusePolicy: LIVE_USER_BINDINGS_REUSE_POLICY,
    userBindingsShadowPolicy: LIVE_USER_BINDINGS_SHADOW_POLICY,
    userBindingNames: null,
    calls: [],
    operations: [],
    confirms: [...confirms],
    diagnostics: [],
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

/** Merge the journal into the tool result's private metadata. */
export function withJournal(meta, journal) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: cloneJson(meta) }
  base[JOURNAL_KEY] = normalizeJournal(journal)
  return base
}

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
