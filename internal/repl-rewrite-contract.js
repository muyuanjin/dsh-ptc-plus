export const MIXED_REDECLARATION_REWRITE =
  'split a mixed top-level declaration while preserving native pattern initialization'

export const FUNCTION_REDECLARATION_REWRITE =
  'reassigned an existing top-level function declaration for REPL continuity'

export const CLASS_REDECLARATION_REWRITE =
  'reassigned an existing top-level class declaration for REPL continuity'

export const LEGACY_DEFAULT_EXPORT_BINDING = 'legacy-variable'
export const LIVE_DEFAULT_EXPORT_BINDING = 'live-readonly'

export function redeclarationCommitTarget(name, statementStart) {
  return `redeclaration:${statementStart}:${name}`
}
