/**
 * Compile-time evidence that a declaration's initializer is a bounded object
 * literal.
 *
 * Recovery records a binding's value at settlement so it can be installed
 * without re-executing the cell. Recording an arbitrary object is unsafe: the
 * value codec enumerates an object's own keys before it can apply any budget,
 * and enumerating a graph with millions of keys exhausts the worker heap before
 * a cap can reject it (a four-million-key object aborts a 128 MiB worker).
 *
 * This module decides the question where it is cheap — on the syntax tree of the
 * initializer — and returns the proven shape only for literals whose size is
 * fixed by their source: an object literal with a bounded number of plain,
 * non-computed properties whose values are primitives, array literals, or other
 * such literals up to a fixed depth. Everything else (an identifier, a call, a
 * class instance) yields no evidence, and its binding stays unrecorded and is
 * named by recovery instead of being captured.
 */

/** Maximum number of own properties a recordable literal may declare. */
export const RECORDED_LITERAL_MAX_PROPERTIES = 32

/** Maximum nesting depth of recordable literals, counting the outer object. */
export const RECORDED_LITERAL_MAX_DEPTH = 3

/** Maximum number of array elements a recordable array literal may declare. */
export const RECORDED_LITERAL_MAX_ELEMENTS = 64

const OBJECT_PROPERTY_TYPES = new Set(['ObjectProperty', 'Property'])
const LITERAL_KEY_TYPES = new Set(['StringLiteral', 'NumericLiteral', 'Literal', 'Identifier'])
const PRIMITIVE_LITERAL_TYPES = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral',
  'BigIntLiteral', 'RegExpLiteral'])

function isRecordableValue(node, depth) {
  if (node === null || node === undefined) return false
  // ESTree parsers emit `Literal`; Babel emits the typed variants above.
  if (node.type === 'Literal') {
    const value = node.value
    return value === null || ['number', 'string', 'boolean', 'bigint'].includes(typeof value)
      || node.regex !== undefined
  }
  if (PRIMITIVE_LITERAL_TYPES.has(node.type)) return true
  if (node.type === 'TemplateLiteral') return node.expressions.length === 0
  if (node.type === 'UnaryExpression') {
    return ['-', '+', '!', 'void'].includes(node.operator) && isRecordableValue(node.argument, depth)
  }
  if (node.type === 'ObjectExpression') return boundedLiteralEvidence(node, depth) !== undefined
  if (node.type === 'ArrayExpression') {
    return node.elements.length <= RECORDED_LITERAL_MAX_ELEMENTS
      && node.elements.every(element => isRecordableValue(element, depth))
  }
  return false
}

/**
 * Evidence for one object literal, or `undefined` when the literal's size is
 * not fixed by its source.
 *
 * @param {object} node an ESTree/Babel `ObjectExpression`
 * @param {number} [depth] nest level of this literal, 1 for the top object
 * @returns {{ properties: number, depth: number } | undefined}
 */
export function boundedLiteralEvidence(node, depth = 1) {
  if (node?.type !== 'ObjectExpression') return undefined
  if (depth > RECORDED_LITERAL_MAX_DEPTH) return undefined
  if (node.properties.length > RECORDED_LITERAL_MAX_PROPERTIES) return undefined
  let proven = 0
  for (const property of node.properties) {
    // `kind` is 'init' on most Babel versions and absent on some parses; an
    // accessor or method arrives as `ObjectMethod`, which this branch rejects
    // through the `type` check above.
    if (!OBJECT_PROPERTY_TYPES.has(property.type) || property.computed === true
      || (property.kind !== undefined && property.kind !== 'init') || property.method === true) return undefined
    const key = property.key
    if (!LITERAL_KEY_TYPES.has(key.type)) return undefined
    const valueNode = property.value
    if (valueNode.type === 'ObjectExpression') {
      if (boundedLiteralEvidence(valueNode, depth + 1) === undefined) return undefined
    } else if (!isRecordableValue(valueNode, depth)) {
      return undefined
    }
    proven += 1
  }
  return { properties: proven, depth }
}
