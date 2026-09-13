/** Recorded compilation contracts. Live configuration cannot reinterpret history. */
export const LEGACY_LANGUAGE_SEMANTICS = 'legacy-v1'
export const STATEFUL_LANGUAGE_SEMANTICS = 'stateful-v1'
export const PROTECTED_LANGUAGE_SEMANTICS = 'protected-v1'
export const LANGUAGE_SEMANTICS = new Set([
  LEGACY_LANGUAGE_SEMANTICS,
  STATEFUL_LANGUAGE_SEMANTICS,
  PROTECTED_LANGUAGE_SEMANTICS,
])

export function normalizeLanguageSemantics(value) {
  if (!LANGUAGE_SEMANTICS.has(value)) throw new TypeError('invalid dsh-ptc-plus language semantics')
  return value
}
