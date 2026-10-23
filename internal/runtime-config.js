import { capabilityPolicyForConfig } from './capability-policy.js'
import { validatePromptTextDocument } from './prompt-text.js'
import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  MAX_TIMER_DELAY_MS,
} from './config-spec.js'

export { MAX_TIMER_DELAY_MS }

/** Reusable configurations contain capability settings, never session evidence. */
export const CAPABILITY_CONFIGURATION_KEYS = Object.freeze(CONFIG_FIELDS
  .filter(field => (field.key.startsWith('capability') && field.key !== 'capabilityProfiles') || ['modelPreviewTokens', 'modelPreviewEnabled'].includes(field.key))
  .map(field => field.key))

export function capabilityProfileConfiguration(value, { allowInvalidStatistics = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !CAPABILITY_CONFIGURATION_KEYS.includes(key))) {
    throw new TypeError('ptc-plus: invalid capability configuration fields')
  }
  const resolved = resolveConfig(value)
  let statistics
  try { statistics = JSON.parse(resolved.capabilityStatistics) } catch {}
  if (!allowInvalidStatistics && (!statistics || typeof statistics.enabled !== 'boolean'
    || !Number.isSafeInteger(statistics.windowSize) || statistics.windowSize < 1
    || !Number.isSafeInteger(statistics.minimumSamples) || statistics.minimumSamples < 1 || statistics.minimumSamples > statistics.windowSize
    || !Number.isFinite(statistics.fullThreshold) || statistics.fullThreshold < 0 || statistics.fullThreshold > 1)) {
    throw new TypeError('ptc-plus: invalid saved capability statistics settings')
  }
  return Object.fromEntries(CAPABILITY_CONFIGURATION_KEYS.map(key => [key, resolved[key]]))
}

export function validateCapabilityProfiles(value) {
  if (!value || value.schema !== 'ptc-capability-profiles/v1' || !Array.isArray(value.profiles) || value.profiles.length > 100) {
    throw new TypeError('ptc-plus: invalid capability profiles document')
  }
  const ids = new Set()
  const names = new Set()
  return { schema: value.schema, profiles: value.profiles.map(profile => {
    if (!profile || typeof profile.id !== 'string' || !profile.id.trim() || profile.id.length > 100
      || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80
      || ids.has(profile.id) || names.has(profile.name.trim())) throw new TypeError('ptc-plus: invalid or duplicate capability profile')
    ids.add(profile.id); names.add(profile.name.trim())
    return { id: profile.id, name: profile.name.trim(), configuration: capabilityProfileConfiguration(profile.configuration) }
  }) }
}

/** The wall-clock ceiling field carries the platform timer limit as its maximum. */
const MAX_WALL_MS_FIELD = CONFIG_FIELDS.find(field => field.key === 'maxWallMs')

/** Validate one integer field against the bounds declared in CONFIG_FIELDS. */
function assertIntegerField(field, value) {
  if (!Number.isSafeInteger(value) || value < field.min) {
    throw new TypeError(`ptc-plus: ${field.key} must be a positive safe integer`)
  }
  if (value > field.max) {
    throw new TypeError(`ptc-plus: ${field.key} must not exceed ${field.max}`)
  }
}

/** Validate one field against its CONFIG_FIELDS declaration. */
function assertField(field, value) {
  if (field.type === 'string') {
    if (typeof value !== 'string') throw new TypeError(`ptc-plus: ${field.key} must be a string`)
    return
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new TypeError(`ptc-plus: ${field.key} must be a boolean`)
    }
    return
  }
  if (field.type === 'enum') {
    if (!field.options.includes(value)) {
      throw new TypeError(`ptc-plus: ${field.key} must be one of ${field.options.join(', ')}`)
    }
    return
  }
  assertIntegerField(field, value)
}

/**
 * Resolve plugin/runtime config from raw input, applying the shared defaults
 * and validating every declared field with the rules the Host Config schema
 * exposes. Unknown keys are preserved for forwards compatibility.
 * @param config - raw config object.
 * @returns a resolved config object.
 */
/**
 * A volatile schema field validates to a live `{ get }` handle. A field that
 * has no schema default arrives as a handle with an undefined live value and
 * keeps the runtime default.
 */
function liveConfigValue(value, fallback) {
  if (value !== null && typeof value === 'object'
    && typeof value.get === 'function' && Object.keys(value).length === 1) {
    const live = value.get()
    return live === undefined ? fallback : live
  }
  return value
}

export function resolveConfig(config = {}) {
  const provided = new Set()
  for (const field of CONFIG_FIELDS) {
    if (!Object.hasOwn(config, field.key)) continue
    const value = config[field.key]
    if (value !== null && typeof value === 'object'
      && typeof value.get === 'function' && Object.keys(value).length === 1) {
      if (value.get() !== undefined) provided.add(field.key)
    } else {
      provided.add(field.key)
    }
  }
  const resolved = { ...CONFIG_DEFAULTS, ...config }
  for (const field of CONFIG_FIELDS) {
    resolved[field.key] = liveConfigValue(resolved[field.key], CONFIG_DEFAULTS[field.key])
  }
  for (const field of CONFIG_FIELDS) assertField(field, resolved[field.key])
  validateCapabilityProfiles(JSON.parse(resolved.capabilityProfiles))
  validatePromptTextDocument(resolved.promptText)
  for (const [key, array] of [['capabilityBaseline', true], ['capabilityOverrides', false]]) {
    let value
    try { value = JSON.parse(resolved[key]) } catch { throw new TypeError(`ptc-plus: ${key} must contain valid JSON`) }
    if (array ? !Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())
      : value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.entries(value).some(([id, selection]) => !id.trim() || !['full', 'on-demand', 'closed'].includes(selection)
          || (id.startsWith('mcpServers.') && (id === 'mcpServers.' || selection !== 'closed')))) {
      throw new TypeError(`ptc-plus: invalid ${key}`)
    }
  }
  resolved.capabilityPolicy = JSON.stringify(capabilityPolicyForConfig(provided.has('capabilityPolicy') ? resolved : { ...resolved, capabilityPolicy: undefined }))
  if (!provided.has('capabilityPolicy') && resolved.capabilityManagementEnabled) {
    if (!provided.has('capabilityRecoveryEnabled')) resolved.capabilityRecoveryEnabled = true
    if (!provided.has('modelPreviewEnabled')) resolved.modelPreviewEnabled = true
  }
  // Migrate complete old policies; mixed choices retain their explicit
  // compatibility state until the user selects the unified language.
  const legacyKeys = [
    'looseTopLevelRedeclarations', 'looseTopLevelFunctionClassRedeclarations',
    'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations',
  ]
  if (!provided.has('bindingUpdates')
    && legacyKeys.some(key => provided.has(key))) {
    if (legacyKeys.every(key => resolved[key] === true)) {
      resolved.bindingUpdates = 'stateful'
    } else if (legacyKeys.slice(0, 2).every(key => resolved[key] === false)
      && resolved.autoSplitRedeclarations === false
      && resolved.autoRewriteImports && resolved.autoStripExports) {
      resolved.bindingUpdates = 'protected'
    } else resolved.legacyBindingSettings = true
  }
  return resolved
}

/** Whether a validated config carries live volatile field handles. */
export function hasVolatileFields(config) {
  if (config === null || typeof config !== 'object') return false
  return Object.values(config).some(value => value !== null && typeof value === 'object'
    && typeof value.get === 'function' && Object.keys(value).length === 1)
}

/**
 * Follow the host's volatile-only commit into the running fiber.
 *
 * The loader updates the retained handles in place and emits
 * `loader/volatile-update` on the owning fiber; listeners on a child scope are
 * filtered out, so the listener belongs to the plugin's own context and is
 * released with the runtime scope it serves.
 *
 * @param host - the plugin's own context, owning the loader event listener.
 * @param scope - the runtime scope whose disposal removes the listener.
 * @param config - the validated config carrying the volatile handles.
 * @param listener - receives the newly resolved plain configuration.
 * @returns whether a volatile listener was installed.
 */
export function watchVolatileConfig(host, scope, config, listener) {
  if (!hasVolatileFields(config) || typeof host?.on !== 'function') return false
  const update = () => listener(resolveConfig(config))
  if (typeof scope?.effect === 'function') {
    scope.effect(() => host.on('loader/volatile-update', update), 'ptc-plus volatile settings lifecycle')
  } else {
    host.on('loader/volatile-update', update)
  }
  return true
}

/**
 * Validate one wall-clock ceiling against the platform timer limit.
 * @param value - the configured maximum wall time in milliseconds.
 * @returns the validated value.
 */
export function validateMaxWallMs(value) {
  assertIntegerField(MAX_WALL_MS_FIELD, value)
  return value
}
