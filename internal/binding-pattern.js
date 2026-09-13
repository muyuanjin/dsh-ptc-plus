/** Shared binding-pattern traversal used by cell analysis and REPL policy code. */
import { types as t } from '@babel/core'

export { walkBindingPattern, bindingNodes } from './binding-pattern-traversal.js'

/** Recognize an actual assignment target through erased expression syntax. */
export function isWriteIdentifier(path) {
  let selected = path
  while (selected.parentPath?.isObjectProperty() && selected.key === 'value'
    || selected.parentPath?.isObjectPattern() || selected.parentPath?.isArrayPattern()
    || selected.parentPath?.isRestElement() && selected.key === 'argument'
    || selected.parentPath?.isAssignmentPattern() && selected.key === 'left'
    || selected.parent?.type.startsWith('TS') && selected.key === 'expression'
    || selected.parentPath?.isParenthesizedExpression() && selected.key === 'expression') selected = selected.parentPath
  const parent = selected.parentPath
  return parent?.isAssignmentExpression() && selected.key === 'left'
    || parent?.isUpdateExpression() && selected.key === 'argument'
    || (parent?.isForOfStatement() || parent?.isForInStatement()) && selected.key === 'left'
}

/** Allocate private identifiers outside both source and caller-owned name sets. */
export function createGeneratedNameAllocator(root, unavailableNames = [], { compact = false } = {}) {
  const used = new Set(unavailableNames)
  const pending = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item)
      continue
    }
    if (value.type === 'Identifier') used.add(value.name)
    for (const key of t.VISITOR_KEYS[value.type] ?? Object.keys(value)) {
      const child = value[key]
      if (Array.isArray(child)) for (const item of child) pending.push(item)
      else if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
  const sequences = new Map()
  let nextCompact = 0
  return (purpose) => {
    let sequence = sequences.get(purpose) ?? 0
    let name
    do {
      name = compact ? `__ptc$${(nextCompact++).toString(36)}` : `__dsh_ptc_${purpose}_${sequence++}__`
    } while (used.has(name))
    sequences.set(purpose, sequence)
    used.add(name)
    return name
  }
}
