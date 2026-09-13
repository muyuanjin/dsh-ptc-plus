/** Read binding names from Acorn or Babel patterns without compiler dependencies. */
export function walkBindingPattern(pattern, visit) {
  if (pattern === null || typeof pattern !== 'object') return
  if (pattern.type === 'Identifier') {
    visit(pattern)
    return
  }
  if (pattern.type === 'RestElement') return walkBindingPattern(pattern.argument, visit)
  if (pattern.type === 'AssignmentPattern') return walkBindingPattern(pattern.left, visit)
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) walkBindingPattern(element, visit)
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      walkBindingPattern(property.type === 'RestElement' ? property.argument : property.value, visit)
    }
  }
}

export function bindingNodes(pattern) {
  const nodes = []
  walkBindingPattern(pattern, node => nodes.push(node))
  return nodes
}
