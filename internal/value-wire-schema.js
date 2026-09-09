export const VALUE_CODEC = 'ptc-value-graph/v1'

export const DEFAULT_VALUE_LIMITS = Object.freeze({
  maxNodes: 100_000,
  maxEdges: 1_000_000,
  maxArrayLength: 1_000_000,
  maxBigIntDigits: 100_000,
  maxStringBytes: 64 * 1024 * 1024,
})

export const VALUE_ENVELOPE_FIELDS = new Set(['codec', 'root', 'nodes'])
export const VALUE_OBJECT_FIELDS = new Set(['type', 'prototype', 'entries'])
export const VALUE_ARRAY_FIELDS = new Set(['type', 'length', 'entries'])
export const VALUE_UNDEFINED_FIELDS = new Set(['tag'])
export const VALUE_NUMBER_FIELDS = new Set(['tag', 'value'])
export const VALUE_BIGINT_FIELDS = new Set(['tag', 'value'])
export const VALUE_REFERENCE_FIELDS = new Set(['tag', 'index'])

/** Map one resolved runtime configuration to its value codec budgets. */
export function valueLimitsFromConfig(config) {
  return {
    maxNodes: config.maxValueNodes,
    maxEdges: config.maxValueEdges,
    maxArrayLength: config.maxValueArrayLength,
    maxBigIntDigits: config.maxValueBigIntDigits,
    maxStringBytes: config.maxOutputBytes,
  }
}
