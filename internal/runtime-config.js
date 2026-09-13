import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  MAX_TIMER_DELAY_MS,
} from './config-spec.js'

export { MAX_TIMER_DELAY_MS }

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
export function resolveConfig(config = {}) {
  const resolved = { ...CONFIG_DEFAULTS, ...config }
  for (const field of CONFIG_FIELDS) assertField(field, resolved[field.key])
  // Migrate complete old policies; mixed choices retain their explicit
  // compatibility state until the user selects the unified language.
  const legacyKeys = [
    'looseTopLevelRedeclarations', 'looseTopLevelFunctionClassRedeclarations',
    'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations',
  ]
  if (!Object.hasOwn(config, 'bindingUpdates')
    && legacyKeys.some(key => Object.hasOwn(config, key))) {
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

/**
 * Validate one wall-clock ceiling against the platform timer limit.
 * @param value - the configured maximum wall time in milliseconds.
 * @returns the validated value.
 */
export function validateMaxWallMs(value) {
  assertIntegerField(MAX_WALL_MS_FIELD, value)
  return value
}
