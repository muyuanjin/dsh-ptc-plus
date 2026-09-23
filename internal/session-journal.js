import { isDeepStrictEqual } from 'node:util'
import { decodeValue, encodeValue, normalizeValueWire } from './value-wire.js'
import { normalizeDiagnostic } from './diagnostic.js'
import { assertOwnFields, isRecord } from './record-utils.js'
import { sessionEvents } from './session-events.js'
import { LEGACY_LANGUAGE_SEMANTICS, normalizeLanguageSemantics } from './language-semantics.js'
import { LEGACY_USER_BINDING_TRANSFORM, historicalModuleTransformForLanguage,
  moduleTransformForLanguage, normalizeModuleTransform } from './module-transform-contract.js'
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
  LANGUAGE_SEMANTICS_JOURNAL_VERSION,
  LANGUAGE_SEMANTICS_JOURNAL_FIELDS,
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
  REPL_TOOL_NAMES,
  REWRITE_FIELDS,
  REWRITE_KINDS,
  usesCallSequenceConfirms,
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

export function isCanonicalSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function normalizeCalls(value) {
  if (!Array.isArray(value)) throw new Error('invalid dsh-ptc-plus journal calls')
  const calls = value.map((call, index) => {
    if (!isRecord(call) || typeof call.global !== 'string' || typeof call.member !== 'string'
      || !Object.hasOwn(call, 'args') || (call.ok !== true && call.ok !== false)
      || !isCanonicalSequence(call.settle)) {
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
  if (confirms.some(callSeq => !isCanonicalSequence(callSeq))) {
    throw new Error('legacy dsh-ptc-plus confirmed no-op call is not uniquely persisted')
  }
  if (new Set(confirms).size !== confirms.length) {
    throw new Error('duplicate dsh-ptc-plus confirmed no-op call')
  }
  return confirms
}

function normalizeConfirms(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(callSeq => !isCanonicalSequence(callSeq))) {
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
  if (value.version === LANGUAGE_SEMANTICS_JOURNAL_VERSION) {
    assertOwnFields(value, LANGUAGE_SEMANTICS_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
    const languageSemantics = normalizeLanguageSemantics(value.languageSemantics)
    return { ...value, version: JOURNAL_VERSION, moduleTransform: historicalModuleTransformForLanguage(languageSemantics) }
  }
  if (value.version === PER_NAME_USER_BINDINGS_JOURNAL_VERSION) {
    assertOwnFields(value, PER_NAME_JOURNAL_FIELDS, 'dsh-ptc-plus journal')
    return { ...value, version: JOURNAL_VERSION, languageSemantics: LEGACY_LANGUAGE_SEMANTICS,
      moduleTransform: LEGACY_USER_BINDING_TRANSFORM }
  }
  const shadow = { userBindingsShadowPolicy: LEGACY_USER_BINDINGS_SHADOW_POLICY, userBindingNames: null,
    languageSemantics: LEGACY_LANGUAGE_SEMANTICS, moduleTransform: LEGACY_USER_BINDING_TRANSFORM }
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
  const moduleTransform = normalizeModuleTransform(migrated.moduleTransform, languageSemantics)
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
    moduleTransform,
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
  if (!isCanonicalSequence(expectedTargetCallSeq)) {
    throw new Error('derived edit does not identify an eligible target call')
  }
  if (!isRecord(meta)) throw new Error('invalid dsh-ptc-plus derived edit metadata')
  const target = meta[EDIT_TARGET_KEY]
  const derived = meta[DERIVED_RUN_KEY]
  if (!isRecord(target)) throw new Error('invalid dsh-ptc-plus edit target metadata')
  assertOwnFields(target, EDIT_TARGET_FIELDS, 'edit target metadata')
  if (!isCanonicalSequence(target.targetCallSeq)
    || target.targetCallSeq !== expectedTargetCallSeq) {
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
    || !isCanonicalSequence(value.failedCallSeq)
    || (value.frontierCallSeq !== null
      && !isCanonicalSequence(value.frontierCallSeq))) {
    throw new Error('invalid dsh-ptc-plus recovery boundary')
  }
  assertOwnFields(value, RECOVERY_BOUNDARY_FIELDS, 'recovery boundary')
  if (eventSeq !== undefined && !isCanonicalSequence(eventSeq)) {
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

const HOST_SEQUENCE_RELATION_POLICY_V0 = new Map([
  ['agent-preset/selected', null],
  ['agent/inbox/spliced', null],
  ['approval/asked', null],
  ['approval/decided', null],
  ['approval/policy', null],
  ['assistant/chunk', null],
  ['assistant/message', null],
  ['command/done', 'command-source'],
  ['command/run', null],
  // Released format 0 also wrote the legacy spellings of the compaction events
  // and a steering message that its own v0-to-v1 stage normalizes to
  // `compaction/*` and `user/message`. They belong to the same frozen
  // vocabulary, so the retired-boundary converter accepts them with their
  // normalized relation semantics. `request/header-delta` and `mode/set` stay
  // unsupported because that stage refuses them as well.
  ['compact/end', null],
  ['compact/prune', 'compaction-shadow'],
  ['compact/start', null],
  ['compact/summary', 'compaction-shadow'],
  ['compaction/end', null],
  ['compaction/prune', 'compaction-shadow'],
  ['compaction/start', null],
  ['compaction/summary', 'compaction-shadow'],
  ['feedback/record', null],
  ['goal/change', null],
  ['hook/invoked', null],
  ['hook/result', null],
  ['llm/retry', null],
  ['llm/retry-started', null],
  ['model/selection', null],
  ['permission/preset', null],
  ['plan/mode', null],
  ['request/context', null],
  ['request/header', null],
  ['sandbox/mode', null],
  ['schedule/change', null],
  ['session-log-deepseek/delivery-accepted', 'delivery-through'],
  ['session/end-seed', null],
  ['session/title', 'title-messages'],
  ['session/title-llm-request', 'title-request-messages'],
  ['step/end', null],
  ['step/start', null],
  ['steering/message', null],
  ['subagent/descriptor', null],
  ['subagent/model-selection-policy', null],
  ['team/member', null],
  ['team/message/delivered', null],
  ['team/message/queued', null],
  ['team/task', null],
  ['todo/write', null],
  ['tool-workflow/agent-end', null],
  ['tool-workflow/agent-start', null],
  ['tool-workflow/run-end', null],
  ['tool-workflow/run-start', null],
  ['tool/call', null],
  ['tool/code-dispatch', null],
  ['tool/code-dispatch-start', null],
  ['tool/result', null],
  ['turn/end', null],
  ['turn/start', null],
  ['user/message', null],
  ['web/deepseek-search-llm-request', null],
])

const V0_SURFACE_EVENT_TYPES = new Set([
  'user/message', 'steering/message', 'assistant/message', 'tool/result',
])
const HOST_DATA_SEQUENCE_RELATIONS_V0 = new Map([
  ['command/done', new Set(['sourceEventSeq'])],
  ['compact/prune', new Set(['shadowedSeqs'])],
  ['compact/summary', new Set(['shadowedSeqs'])],
  ['compaction/prune', new Set(['shadowedSeqs'])],
  ['compaction/summary', new Set(['shadowedSeqs'])],
  ['session-log-deepseek/delivery-accepted', new Set(['throughSeq'])],
  ['session/title', new Set(['messageSeqs'])],
  ['session/title-llm-request', new Set(['messageSeqs'])],
])
const SEQUENCE_RELATION_FIELD = /Seqs?$/u

function validateKnownDataSequenceRelations(event) {
  if (!isRecord(event.data)) return
  const allowed = HOST_DATA_SEQUENCE_RELATIONS_V0.get(event.type) ?? new Set()
  for (const field of Reflect.ownKeys(event.data)) {
    if (typeof field === 'string' && SEQUENCE_RELATION_FIELD.test(field) && !allowed.has(field)) {
      throw new Error(`unsupported ${event.type} data sequence relation ${JSON.stringify(field)}`)
    }
  }
}

function validateEarlierEventReference(events, event, seq, label) {
  if (!isCanonicalSequence(seq) || seq >= event.seq || events[seq]?.seq !== seq) {
    throw new Error(`invalid ${label} event reference ${JSON.stringify(seq)} at event ${event.seq}`)
  }
  return events[seq]
}

function validateEarlierEventReferences(events, event, seqs, label) {
  if (!Array.isArray(seqs)) throw new Error(`invalid ${label} event references`)
  const seen = new Set()
  return seqs.map(seq => {
    if (seen.has(seq)) throw new Error(`duplicate ${label} event reference ${JSON.stringify(seq)} at event ${event.seq}`)
    seen.add(seq)
    return validateEarlierEventReference(events, event, seq, label)
  })
}

function sameSequences(left, right) {
  return left.length === right.length && left.every((seq, index) => seq === right[index])
}

function validateSurfaceRelation(events, event, surface) {
  const eligible = V0_SURFACE_EVENT_TYPES.has(event.type)
  if (!eligible) {
    if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
      throw new Error(`session event ${JSON.stringify(event.type)} is not surface-eligible`)
    }
    return
  }
  if (event.sourceEventSeqs !== undefined) {
    validateEarlierEventReferences(events, event, event.sourceEventSeqs, 'source')
  }
  if (event.sourceEventSeqs?.length === 0 && event.type !== 'assistant/message') {
    throw new Error('source event references must not be empty except on assistant/message')
  }
  const op = event.surfaceOp
  // Historical host formats predate the mandatory append marker.
  if (op === undefined || op === 'append') {
    surface.push(event.seq)
    return
  }
  if (!isRecord(op) || op.op !== 'replace'
    || Reflect.ownKeys(op).length !== 3
    || !isCanonicalSequence(op.start)
    || !isCanonicalSequence(op.end)) {
    throw new Error('invalid surface operation during recovery-boundary migration')
  }
  validateEarlierEventReference(events, event, op.start, 'surface replacement start')
  validateEarlierEventReference(events, event, op.end, 'surface replacement end')
  const start = surface.indexOf(op.start)
  const end = surface.indexOf(op.end)
  if (start < 0 || end < start) {
    throw new Error(`surface replacement at event ${event.seq} does not identify a current ordered surface range`)
  }
  const shadowed = surface.slice(start, end + 1)
  const provenance = new Set(event.sourceEventSeqs ?? [])
  if (shadowed.some(seq => !provenance.has(seq))) {
    throw new Error(`surface replacement at event ${event.seq} does not cite every replaced surface node`)
  }
  if (event.type === 'tool/result'
    && (shadowed.length !== 1 || events[shadowed[0]]?.type !== 'tool/result')) {
    throw new Error('tool/result surface replacement must target one current tool/result')
  }
  if (event.type === 'tool/result') {
    const withoutContent = candidate => {
      const data = candidate?.data
      const message = data?.message
      const content = message?.content
      if (!isRecord(data) || !isRecord(message) || !Array.isArray(content)
        || content.length !== 1 || !isRecord(content[0])) {
        throw new Error('tool/result surface replacement has invalid message content')
      }
      return {
        ...data,
        message: { ...message, content: [{ ...content[0], content: null }] },
      }
    }
    if (!isDeepStrictEqual(withoutContent(events[shadowed[0]]), withoutContent(event))) {
      throw new Error('tool/result surface replacement may change only content')
    }
  }
  surface.splice(start, shadowed.length, event.seq)
}

function validateCommandSource(events, event) {
  if (!isRecord(event.data)) {
    throw new Error(`command/done event ${event.seq} has invalid data`)
  }
  if (event.data.sourceEventSeq === undefined) return
  if (!isRecord(event.data) || event.data.kind !== 'success') {
    throw new Error(`command/done event ${event.seq} has a source outside a successful result`)
  }
  const source = validateEarlierEventReference(events, event, event.data.sourceEventSeq, 'command source')
  if (source.type === 'command/run' || source.type === 'command/done') {
    throw new Error(`command/done event ${event.seq} cites a command lifecycle event as its source`)
  }
}

function validateTitleRequestSources(events, event) {
  if (!isRecord(event.data) || !Array.isArray(event.data.messageSeqs)) {
    throw new Error('invalid session/title-llm-request message references')
  }
  const sources = validateEarlierEventReferences(
    events, event, event.data.messageSeqs, 'session title request message',
  )
  if (sources.some(source => source.type !== 'user/message')) {
    throw new Error(`session/title-llm-request event ${event.seq} must cite earlier user/message events`)
  }
}

function validateDeliveryThrough(events, event) {
  if (!isRecord(event.data)) {
    throw new Error(`session-log-deepseek/delivery-accepted event ${event.seq} has invalid data`)
  }
  validateEarlierEventReference(events, event, event.data.throughSeq, 'session delivery through')
}

function validateTitleSources(events, event) {
  if (!isRecord(event.data) || !Array.isArray(event.data.messageSeqs)) {
    throw new Error('invalid session/title message references')
  }
  if ((event.data.messageSeqs.length === 0) !== (event.data.source?.kind === 'user')) {
    const requirement = event.data.source?.kind === 'user'
      ? 'cite no message seqs'
      : 'cite at least one message seq'
    throw new Error(`session/title event ${event.seq} must ${requirement}`)
  }
  const sources = validateEarlierEventReferences(events, event, event.data.messageSeqs, 'session title message')
  if (sources.some(source => source.type !== 'user/message' || source.data?.source?.kind !== 'user')) {
    throw new Error(`session/title event ${event.seq} must cite earlier human user/message events`)
  }
}

function validateCompactionSources(events, event, surface) {
  if (!isRecord(event.data) || !Array.isArray(event.data.shadowedSeqs)) {
    throw new Error(`invalid ${event.type} shadow references`)
  }
  const shadowed = event.data.shadowedSeqs
  validateEarlierEventReferences(events, event, shadowed, 'compaction shadow')
  if (event.data.shadowedRange === undefined) {
    if (shadowed.length === 0) return
    const start = surface.indexOf(shadowed[0])
    if (start < 0 || !sameSequences(surface.slice(start, start + shadowed.length), shadowed)) {
      throw new Error(`${event.type} event ${event.seq} shadow list does not match the current surface`)
    }
    return
  }
  const range = event.data.shadowedRange
  if (!isRecord(range)) throw new Error(`invalid ${event.type} shadow range`)
  validateEarlierEventReference(events, event, range.start, 'compaction range start')
  validateEarlierEventReference(events, event, range.end, 'compaction range end')
  const start = surface.indexOf(range.start)
  const end = surface.indexOf(range.end)
  if (start < 0 || end < start
    || !sameSequences(surface.slice(start, end + 1), shadowed)) {
    throw new Error(`${event.type} event ${event.seq} shadow range does not match the current surface`)
  }
}

function validateHostSequenceRelations(events) {
  const surface = []
  for (const event of events) {
    if (event.type === RECOVERY_BOUNDARY_EVENT) continue
    if (!HOST_SEQUENCE_RELATION_POLICY_V0.has(event.type)) {
      throw new Error(`unsupported session event type ${JSON.stringify(event.type)} during recovery-boundary migration`)
    }
    validateKnownDataSequenceRelations(event)
    validateSurfaceRelation(events, event, surface)
    const relation = HOST_SEQUENCE_RELATION_POLICY_V0.get(event.type)
    if (relation === 'command-source') validateCommandSource(events, event)
    else if (relation === 'title-messages') validateTitleSources(events, event)
    else if (relation === 'title-request-messages') validateTitleRequestSources(events, event)
    else if (relation === 'delivery-through') validateDeliveryThrough(events, event)
    else if (relation === 'compaction-shadow') validateCompactionSources(events, event, surface)
  }
}

function rewriteHostSequenceRelations(event, mapEvent) {
  const relation = HOST_SEQUENCE_RELATION_POLICY_V0.get(event.type)
  if (Object.hasOwn(event, 'sourceEventSeqs')) {
    event.sourceEventSeqs = event.sourceEventSeqs.map(seq => mapEvent(seq, 'source'))
  }
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
    event.surfaceOp = {
      ...event.surfaceOp,
      start: mapEvent(event.surfaceOp.start, 'surface replacement start'),
      end: mapEvent(event.surfaceOp.end, 'surface replacement end'),
    }
  }
  if (relation === 'command-source') {
    if (event.data.sourceEventSeq !== undefined) {
      event.data = {
        ...event.data,
        sourceEventSeq: mapEvent(event.data.sourceEventSeq, 'command source'),
      }
    }
  } else if (relation === 'title-messages') {
    event.data = {
      ...event.data,
      messageSeqs: event.data.messageSeqs.map(seq => mapEvent(seq, 'session title message')),
    }
  } else if (relation === 'title-request-messages') {
    const mapped = event.data.messageSeqs.map(seq => mapEvent(seq, 'session title request message'))
    if (mapped.some((seq, index) => seq !== event.data.messageSeqs[index])) {
      throw new Error('session/title-llm-request messageSeqs cannot be preserved across removed events')
    }
  } else if (relation === 'delivery-through') {
    event.data = {
      ...event.data,
      throughSeq: mapEvent(event.data.throughSeq, 'session delivery through'),
    }
  } else if (relation === 'compaction-shadow') {
    const data = {
      ...event.data,
      shadowedSeqs: event.data.shadowedSeqs.map(seq => mapEvent(seq, 'compaction shadow')),
    }
    if (event.data.shadowedRange !== undefined) {
      data.shadowedRange = {
        ...event.data.shadowedRange,
        start: mapEvent(event.data.shadowedRange.start, 'compaction range start'),
        end: mapEvent(event.data.shadowedRange.end, 'compaction range end'),
      }
    }
    event.data = data
  }
  return event
}

/**
 * Convert the retired custom boundary event in a raw log before DSH restores it.
 * The returned log is a detached, renumbered copy; the input is never mutated.
 */
export function migrateRecoveryBoundaryEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('recovery-boundary migration expects an event array')
  const sequenceMap = new Map()
  let nextSeq = 0
  for (const [index, event] of events.entries()) {
    if (!isCanonicalSequence(event?.seq)) {
      throw new Error('invalid session event sequence during recovery-boundary migration')
    }
    if (sequenceMap.has(event.seq)) {
      throw new Error(`duplicate session event sequence ${event.seq} during recovery-boundary migration`)
    }
    if (event.seq !== index) {
      throw new Error(`session event sequence ${event.seq} at index ${index} is not contiguous from zero`)
    }
    const retainedSeq = event.type === RECOVERY_BOUNDARY_EVENT ? undefined : nextSeq++
    sequenceMap.set(event.seq, { event, retainedSeq })
  }
  validateHostSequenceRelations(events)
  const mapEvent = (seq, label) => {
    if (!isCanonicalSequence(seq)) throw new Error(`invalid ${label} event reference`)
    const target = sequenceMap.get(seq)
    if (target === undefined || target.retainedSeq === undefined) {
      throw new Error(`unmapped ${label} event reference ${seq}`)
    }
    return target.retainedSeq
  }
  const mapCall = (seq, resultSeq, label) => {
    const target = sequenceMap.get(seq)
    if (!isCanonicalSequence(seq) || target === undefined
      || target.retainedSeq === undefined || target.event?.type !== 'tool/call'
      || !REPL_TOOL_NAMES.has(target.event.data?.name) || seq >= resultSeq) {
      throw new Error(`unproved ${label} call reference ${JSON.stringify(seq)} at event ${resultSeq}`)
    }
    return target.retainedSeq
  }
  const mapBoundary = (boundary, resultSeq) => ({
    failedCallSeq: mapCall(boundary.failedCallSeq, resultSeq, 'recovery-boundary failure'),
    frontierCallSeq: boundary.frontierCallSeq === null ? null : (() => {
      if (boundary.frontierCallSeq >= boundary.failedCallSeq) {
        throw new Error('recovery-boundary frontier must precede its failed call')
      }
      return mapCall(boundary.frontierCallSeq, resultSeq, 'recovery-boundary frontier')
    })(),
  })
  const migrated = []
  const pending = []
  const boundaryOrigins = new Map()
  for (const event of events) {
    if (event?.type === RECOVERY_BOUNDARY_EVENT) {
      pending.push({ boundary: normalizeRecoveryBoundaryValue(event.data), eventSeq: event.seq })
      continue
    }
    const detached = cloneJson(event)
    const sourceSeqs = detached?.sourceEventSeqs
    const source = Array.isArray(sourceSeqs) && sourceSeqs.length === 1
      ? sequenceMap.get(sourceSeqs[0]) : undefined
    const carriesJournal = detached?.type === 'tool/result'
      && isRecord(detached.data?.meta) && Object.hasOwn(detached.data.meta, JOURNAL_KEY)
      && source?.retainedSeq !== undefined && source.event?.type === 'tool/call'
      && REPL_TOOL_NAMES.has(source.event.data?.name) && source.event.seq < event.seq
    if (pending.length > 0 && carriesJournal) {
      const data = { ...detached.data }
      const meta = { ...data.meta }
      const existing = meta[RECOVERY_BOUNDARY_KEY] === undefined
        ? []
        : normalizeRecoveryBoundaries(meta[RECOVERY_BOUNDARY_KEY])
      meta[RECOVERY_BOUNDARY_KEY] = [...pending.map(item => item.boundary), ...existing]
      boundaryOrigins.set(event.seq, {
        pendingCount: pending.length,
        pendingEventSeqs: pending.map(item => item.eventSeq),
      })
      data.meta = meta
      detached.data = data
      pending.length = 0
    }
    migrated.push(detached)
  }
  if (pending.length > 0) {
    throw new Error('recovery boundary has no later PTC journal result for migration')
  }
  return Object.freeze(migrated.map((event) => {
    const oldSeq = event.seq
    rewriteHostSequenceRelations(event, mapEvent)
    if (event.type === 'tool/result' && isRecord(event.data?.meta)) {
      const meta = event.data.meta
      const journal = meta[JOURNAL_KEY]
      if (usesCallSequenceConfirms(journal) && journal.confirms !== undefined) {
        if (!Array.isArray(journal.confirms)) throw new Error('invalid dsh-ptc-plus confirmed no-op calls')
        journal.confirms = journal.confirms.map(seq => mapCall(seq, oldSeq, 'journal confirmation'))
      }
      if (meta[EDIT_TARGET_KEY] !== undefined) {
        if (!isRecord(meta[EDIT_TARGET_KEY])) throw new Error('invalid dsh-ptc-plus edit target')
        meta[EDIT_TARGET_KEY].targetCallSeq = mapCall(
          meta[EDIT_TARGET_KEY].targetCallSeq, oldSeq, 'edit target',
        )
      }
      if (meta[RECOVERY_BOUNDARY_KEY] !== undefined) {
        const origins = boundaryOrigins.get(oldSeq)
        meta[RECOVERY_BOUNDARY_KEY] = normalizeRecoveryBoundaries(meta[RECOVERY_BOUNDARY_KEY])
          .map((boundary, index) => mapBoundary(boundary,
            origins !== undefined && index < origins.pendingCount
              ? origins.pendingEventSeqs[index]
              : oldSeq))
      }
    }
    event.seq = sequenceMap.get(oldSeq).retainedSeq
    return Object.freeze(event)
  }))
}

function currentAssistantCallSeq(events, candidates, callId, toolName) {
  let assistantIndex = events.length - 1
  while (assistantIndex >= 0 && events[assistantIndex]?.type !== 'assistant/message') {
    assistantIndex -= 1
  }
  if (assistantIndex < 0) return undefined
  const content = events[assistantIndex].data?.message?.content
  if (!Array.isArray(content)) return undefined
  const blocks = content.filter(part => part?.type === 'tool-call'
    && part.id === callId && part.name === toolName)
  if (blocks.length !== 1) return undefined
  const eventIndexes = new Map(events.map((event, index) => [event, index]))
  const current = candidates.filter(event => eventIndexes.get(event) > assistantIndex
    && event.data.arguments === blocks[0].arguments)
  return current.length === 1 ? current[0].seq : undefined
}

/** Resolve the persisted event identity for one named tool call being dispatched. */
export function liveToolCallSeq(session, callId, toolName) {
  const events = sessionEvents(session)
  if (!Array.isArray(events) || typeof callId !== 'string' || callId.length === 0
    || typeof toolName !== 'string' || toolName.length === 0) return undefined

  const pendingCalls = new Map()
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.callId === callId) {
      if (event.data.name === toolName && !isCanonicalSequence(event.seq)) {
        throw new Error(`current ${toolName} call has an invalid session event sequence`)
      }
      if (isCanonicalSequence(event.seq)) pendingCalls.set(event.seq, event)
      continue
    }
    if (event?.type !== 'tool/result') continue
    const sourceRelation = event.sourceEventSeqs
    const canonicalSourceRelation = Array.isArray(sourceRelation)
      && sourceRelation.length === 1
      && isCanonicalSequence(sourceRelation[0])
    if (canonicalSourceRelation) {
      pendingCalls.delete(sourceRelation[0])
      continue
    }
    // A damaged result cannot recover state, but its ordered call identity can
    // still prove that the sole preceding same-id call is no longer live.
    if (event.data?.message?.source?.callId === callId
      && pendingCalls.size === 1) {
      pendingCalls.clear()
    }
  }

  const candidates = [...pendingCalls.values()]
    .filter(event => event.data?.name === toolName)
  if (candidates.length > 1) {
    const current = currentAssistantCallSeq(events, candidates, callId, toolName)
    if (current !== undefined) return current
  }
  if (candidates.length > 1) {
    throw new Error(`session log contains multiple unpaired ${toolName} calls for callId ${JSON.stringify(callId)}`)
  }
  return candidates[0]?.seq
}

/** Start a mutable journal for one live cell. */
export function createJournal(confirms = [], bindingPolicy, rewritePolicy, languageSemantics = LEGACY_LANGUAGE_SEMANTICS,
  moduleTransform = moduleTransformForLanguage(languageSemantics)) {
  if (typeof bindingPolicy === 'string') {
    if (!BINDING_MODES.has(bindingPolicy)) throw new TypeError('invalid dsh-ptc-plus journal binding mode')
    bindingPolicy = {
      variableRedeclarations: bindingPolicy === 'loose',
      functionClassRedeclarations: false,
    }
  }
  languageSemantics = normalizeLanguageSemantics(languageSemantics)
  return {
    version: JOURNAL_VERSION,
    languageSemantics,
    moduleTransform: normalizeModuleTransform(moduleTransform, languageSemantics),
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
