import { types as t } from '@babel/core'

/** Binding descriptors belong to a compilation; each AST owns its new operations. */
export function createCompilerOperationPlanner({ bindings = [], internalBindings = [], environmentName, rootRuntime } = {}) {
  const compilerBindings = new Set(internalBindings)
  const sourceInitializers = new Set(bindings.filter(binding => binding.role === 'source-initializer')
    .map(binding => binding.physicalName))
  const transports = new Map(bindings.filter(binding => binding.property !== undefined || binding.accessor === true)
    .map(binding => [binding.physicalName, binding]))
  const roots = new Set([environmentName, rootRuntime].filter(name => name !== undefined))
  const ownedBindings = new Set([...compilerBindings, ...transports.keys(), ...roots])
  const declaration = path => (path.isVariableDeclarator() || path.isFunctionDeclaration())
    && (compilerBindings.has(path.node.id?.name) || roots.has(path.node.id?.name)) && !sourceInitializers.has(path.node.id.name)
  const transport = node => t.isIdentifier(node) ? transports.get(node.name)
    : t.isCallExpression(node) && t.isIdentifier(node.callee) && transports.get(node.callee.name)?.accessor === true
      ? transports.get(node.callee.name) : undefined
  const privateReceiver = node => t.isIdentifier(node) && roots.has(node.name)
  const compilerCall = node => {
    const callee = node.callee
    if (t.isIdentifier(callee)) return compilerBindings.has(callee.name) && !sourceInitializers.has(callee.name)
      || transports.get(callee.name)?.accessor === true
    if (!t.isMemberExpression(callee) || callee.computed) return false
    const owner = transport(callee.object)
    return privateReceiver(callee.object) || owner !== undefined && owner.property !== undefined
      && callee.property.name !== owner.property
  }
  return tree => {
    const addedBindings = new Set()
    const internal = { has: name => ownedBindings.has(name) || addedBindings.has(name), add: name => addedBindings.add(name) }
    const sourceNodes = new WeakSet()
    const operations = new WeakSet()
    const values = new WeakSet()
    const callees = new WeakSet()
    const operation = node => {
      operations.add(node)
      if (node.callee !== undefined) {
        callees.add(node.callee)
        t.traverseFast(node.callee, child => operations.add(child))
      }
      return node
    }
    t.traverseFast(tree, node => sourceNodes.add(node))
    t.traverseFast(tree, node => {
      if ((t.isCallExpression(node) || t.isNewExpression(node)) && compilerCall(node)) operation(node)
    })
    return {
      internal,
      sourceInitializers,
      declaration,
      owns: node => operations.has(node),
      callee: node => callees.has(node),
      isValue: node => values.has(node),
      value(node) { values.add(node); return node },
      operation,
      generated(output) {
        // Original argument nodes remain source-owned inside new helper shells.
        t.traverseFast(output, node => { if (!sourceNodes.has(node)) operations.add(node) })
      },
    }
  }
}
