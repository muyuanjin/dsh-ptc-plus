import {
  LEGACY_DEFAULT_EXPORT_BINDING,
  LIVE_DEFAULT_EXPORT_BINDING,
  LEGACY_IMPORT_EXPRESSION_BOUNDARY,
  LIVE_IMPORT_EXPRESSION_BOUNDARY,
} from './repl-rewrite-contract.js'

export const JOURNAL_KEY = 'dshPtcPlus'
export const EDIT_TARGET_KEY = 'dshPtcPlusEdit'
export const DERIVED_RUN_KEY = 'dshPtcPlusDerivedRun'
export const REWRITES_KEY = 'dshPtcPlusRewrites'
export const RECOVERY_BOUNDARY_KEY = 'dshPtcPlusRecoveryBoundaries'
export const IMPORT_BOUNDARY_JOURNAL_VERSION = 7
export const PER_NAME_USER_BINDINGS_JOURNAL_VERSION = 8
export const LANGUAGE_SEMANTICS_JOURNAL_VERSION = 9
export const MODULE_TRANSFORM_JOURNAL_VERSION = 10
export const JOURNAL_VERSION = MODULE_TRANSFORM_JOURNAL_VERSION
export const LIVE_USER_BINDINGS_SHADOW_POLICY = 'per-name'
export const LEGACY_USER_BINDINGS_SHADOW_POLICY = 'whole-entry'
export const LIVE_USER_BINDINGS_REUSE_POLICY = 'implementation-v1'
export const LEGACY_USER_BINDINGS_REUSE_POLICY = 'fingerprint-v1'
export const LEGACY_JOURNAL_VERSION = 1
export const INTERMEDIATE_JOURNAL_VERSION = 2
export const PREVIOUS_JOURNAL_VERSION = 3
export const USER_BINDING_RELATIONLESS_JOURNAL_VERSION = 4
export const FINGERPRINT_REUSE_JOURNAL_VERSION = 5
export const VERSIONED_BINDING_REUSE_JOURNAL_VERSION = 6
export const RECOVERY_BOUNDARY_EVENT = 'ptc-plus/recovery-boundary'

export const STATUSES = new Set(['durable', 'volatile', 'discarded', 'noop'])
export const BINDING_MODES = new Set(['loose', 'strict'])
export const WHOLE_ENTRY_JOURNAL_FIELDS = new Set(['version', 'bindingPolicy', 'rewritePolicy', 'moduleSemantics', 'userBindingsFingerprint', 'userBindingsReusePolicy', 'status', 'calls', 'operations', 'confirms', 'diagnostics', 'completion', 'volatileReason'])
export const PER_NAME_JOURNAL_FIELDS = new Set([...WHOLE_ENTRY_JOURNAL_FIELDS, 'userBindingsShadowPolicy', 'userBindingNames'])
export const LANGUAGE_SEMANTICS_JOURNAL_FIELDS = new Set([...PER_NAME_JOURNAL_FIELDS, 'languageSemantics'])
export const JOURNAL_FIELDS = new Set([...LANGUAGE_SEMANTICS_JOURNAL_FIELDS, 'moduleTransform'])
export const FINGERPRINT_REUSE_JOURNAL_FIELDS = new Set([...WHOLE_ENTRY_JOURNAL_FIELDS].filter(field => field !== 'userBindingsReusePolicy'))
export const RELATIONLESS_JOURNAL_FIELDS = new Set([...FINGERPRINT_REUSE_JOURNAL_FIELDS].filter(field => field !== 'userBindingsFingerprint'))
export const PREDECESSOR_JOURNAL_FIELDS = new Set(['version', 'bindingMode', 'rewritePolicy', 'status', 'calls', 'operations', 'confirms', 'diagnostics', 'completion', 'volatileReason'])
export const LEGACY_JOURNAL_FIELDS = new Set([...PREDECESSOR_JOURNAL_FIELDS].filter(field => field !== 'rewritePolicy'))
export const BINDING_POLICY_FIELDS = new Set(['variableRedeclarations', 'functionClassRedeclarations'])
export const REWRITE_POLICY_FIELDS = new Set(['autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations'])
export const LEGACY_MODULE_SEMANTICS_FIELDS = new Set(['defaultExportBinding'])
export const MODULE_SEMANTICS_FIELDS = new Set([...LEGACY_MODULE_SEMANTICS_FIELDS, 'importExpressionBoundary'])
export const IMPORT_EXPRESSION_BOUNDARIES = new Set([
  LEGACY_IMPORT_EXPRESSION_BOUNDARY,
  LIVE_IMPORT_EXPRESSION_BOUNDARY,
])
export const DEFAULT_EXPORT_BINDINGS = new Set([
  LEGACY_DEFAULT_EXPORT_BINDING,
  LIVE_DEFAULT_EXPORT_BINDING,
])
export const CALL_SUCCESS_FIELDS = new Set(['global', 'member', 'args', 'ok', 'value', 'settle'])
export const CALL_ERROR_FIELDS = new Set(['global', 'member', 'args', 'ok', 'error', 'settle'])
export const OPERATION_FIELDS = new Set(['action', 'name'])
export const RETURN_FIELDS = new Set(['kind', 'hasValue', 'value'])
export const THROW_FIELDS = new Set(['kind', 'error'])
export const ERROR_FIELDS = new Set(['kind', 'message'])
export const EDIT_TARGET_FIELDS = new Set(['targetCallSeq'])
export const DERIVED_RUN_FIELDS = new Set(['code', 'description'])

export const JOURNAL_VERSIONS = new Set([LEGACY_JOURNAL_VERSION, INTERMEDIATE_JOURNAL_VERSION, PREVIOUS_JOURNAL_VERSION, USER_BINDING_RELATIONLESS_JOURNAL_VERSION, FINGERPRINT_REUSE_JOURNAL_VERSION, VERSIONED_BINDING_REUSE_JOURNAL_VERSION, IMPORT_BOUNDARY_JOURNAL_VERSION, PER_NAME_USER_BINDINGS_JOURNAL_VERSION, LANGUAGE_SEMANTICS_JOURNAL_VERSION, JOURNAL_VERSION])
export const USER_BINDINGS_REUSE_POLICIES = new Set([LEGACY_USER_BINDINGS_REUSE_POLICY, LIVE_USER_BINDINGS_REUSE_POLICY])
export const USER_BINDINGS_SHADOW_POLICIES = new Set([LEGACY_USER_BINDINGS_SHADOW_POLICY, LIVE_USER_BINDINGS_SHADOW_POLICY])
const USER_BINDING_NAME_STATES = new Set(['provider', 'local', 'absent', 'unknown'])
const isArray = Array.isArray
const freeze = Object.freeze
const ownKeys = Reflect.ownKeys
const defineProperty = Object.defineProperty
const uncurry = Function.prototype.bind.bind(Function.prototype.call)
const setHas = uncurry(Set.prototype.has)
const setAdd = uncurry(Set.prototype.add)
const sort = uncurry(Array.prototype.sort)
const enumerable = uncurry(Object.prototype.propertyIsEnumerable)

/** Closed, value-free evidence shared by worker settlement, persistence and Client. */
export function normalizeUserBindingNames(value) {
  if (!isArray(value)) throw new TypeError('invalid user binding name evidence')
  const names = new Set()
  const normalized = []
  for (let index = 0; index < value.length; index++) {
    const fact = value[index]
    if (fact === null || typeof fact !== 'object'
      || !setHas(USER_BINDING_NAME_STATES, fact.state)
      || typeof fact.name !== 'string' || fact.name.length > 128
      || !/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(fact.name)
      || setHas(names, fact.name)) throw new TypeError('invalid user binding name evidence')
    const fields = fact.state === 'provider' ? ['name', 'state', 'entryId'] : ['name', 'state']
    let validFields = ownKeys(fact).length === fields.length
    for (let field = 0; validFields && field < fields.length; field++) validFields = enumerable(fact, fields[field])
    if (!validFields
      || (fact.state === 'provider' && (typeof fact.entryId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fact.entryId)))) {
      throw new TypeError('invalid user binding name evidence')
    }
    setAdd(names, fact.name)
    defineProperty(normalized, normalized.length, { configurable: true, enumerable: true, writable: true,
      value: freeze({ name: fact.name, state: fact.state,
        ...(fact.state === 'provider' ? { entryId: fact.entryId } : {}) }) })
  }
  sort(normalized, (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  return freeze(normalized)
}

export function normalizeJournalUserBindingNames(journal) {
  if (!USER_BINDINGS_SHADOW_POLICIES.has(journal.userBindingsShadowPolicy)) {
    throw new TypeError('invalid user binding shadow policy')
  }
  if (journal.userBindingsShadowPolicy === LEGACY_USER_BINDINGS_SHADOW_POLICY
    || journal.status === 'noop' || journal.status === 'discarded') {
    if (journal.userBindingNames !== null) throw new TypeError('unexpected user binding name evidence')
    return null
  }
  return normalizeUserBindingNames(journal.userBindingNames)
}
export const RECOVERY_BOUNDARY_FIELDS = new Set(['failedCallSeq', 'frontierCallSeq'])
export const REPL_TOOL_NAMES = new Set(['run_code', 'edit_run_code'])
export const REWRITE_FIELDS = new Set(['kind', 'description', 'source'])
export const REWRITE_KINDS = new Set(['import', 'redeclaration', 'export'])

/** Journal v1 uses call IDs; later recognized generations use persisted event sequences. */
export function usesCallSequenceConfirms(journal) {
  return JOURNAL_VERSIONS.has(journal?.version) && journal.version !== LEGACY_JOURNAL_VERSION
}
