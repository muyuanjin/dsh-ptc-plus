import {
  CONFIG_DEFAULTS,
  MAX_TIMER_DELAY_MS,
} from './config-spec.js'

export { MAX_TIMER_DELAY_MS }

/** Positive-safe-integer limits applied to runtime budget fields. */
const BUDGET_KEYS = Object.freeze([
  'computeMs',
  'maxOutputBytes',
  'maxOldGenerationSizeMb',
  'maxValueNodes',
  'maxValueEdges',
  'maxValueArrayLength',
  'maxValueBigIntDigits',
])

/** Boolean runtime behavior switches. */
const BOOLEAN_KEYS = Object.freeze([
  'enhancedToolView',
  'autoDescribeRunCode',
  'cordisToolsEnabled',
  'canonicalizeToolCalls',
  'looseTopLevelRedeclarations',
  'looseTopLevelFunctionClassRedeclarations',
  'durableReplay',
  'autoRewriteImports',
  'autoStripExports',
  'autoSplitRedeclarations',
  'tipsEnabled',
])

/** Positive-safe-integer field groups that validate like budgets. */
const POSITIVE_KEYS = Object.freeze([
  'maxNestedRunCodeDepth',
  'tipCooldownMessages',
  'tipEscalationFailures',
])

/**
 * Resolve plugin/runtime config from raw input, applying the shared defaults
 * and the same validation the Host Config schema exposes.
 * @param config - raw config object; unknown keys are preserved for forwards compatibility.
 * @returns a resolved config object.
 */
export function resolveConfig(config = {}) {
  const resolved = { ...CONFIG_DEFAULTS, ...config }
  if (typeof resolved.enabled !== 'boolean') {
    throw new TypeError('ptc-plus: enabled must be a boolean')
  }
  for (const key of [...BUDGET_KEYS, ...POSITIVE_KEYS]) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`ptc-plus: ${key} must be a positive safe integer`)
    }
  }
  validateMaxWallMs(resolved.maxWallMs)
  for (const key of BOOLEAN_KEYS) {
    if (typeof resolved[key] !== 'boolean') {
      throw new TypeError(`ptc-plus: ${key} must be a boolean`)
    }
  }
  return resolved
}

/**
 * Validate one wall-clock ceiling against the platform timer limit.
 * @param value - the configured maximum wall time in milliseconds.
 * @returns the validated value.
 */
export function validateMaxWallMs(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('ptc-plus: maxWallMs must be a positive safe integer')
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`ptc-plus: maxWallMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}
