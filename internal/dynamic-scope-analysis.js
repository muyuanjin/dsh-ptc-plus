import { visitSource } from './compiler-source-regions.js'

/** A switch creates its case environment after evaluating the discriminant.
 * Babel parents nested discriminant scopes to the switch, so filter that
 * synthetic edge using the reference's actual source ancestry. */
export function* sourceScopePath(path, origin = path) {
  const excluded = new Set()
  for (let child = origin; child.parentPath; child = child.parentPath) {
    if (child.key === 'discriminant' && child.parentPath.isSwitchStatement()) excluded.add(child.parentPath.scope)
  }
  for (let scope = path.scope; scope; scope = scope.parent) {
    if (!excluded.has(scope)) yield scope
  }
}

export function sourceBinding(path, name) {
  for (const scope of sourceScopePath(path)) {
    const binding = scope.getOwnBinding(name)
    if (binding !== undefined && sourceBindingVisible(path, binding)) return binding
  }
  return undefined
}

/** Lookup and dynamic descriptor capture share the same visibility test. */
export function sourceBindingVisible(path, binding) {
  return !sourceInParameters(path, binding.scope) || binding.kind === 'param'
    || binding.kind === 'local' && binding.path.node === binding.scope.block
}

/** A parameter expression (including a closure inside it) cannot see its
 * function's body declarations. Source ancestry owns this visibility edge. */
export function sourceInParameters(path, scope) {
  for (let child = path; child.parentPath; child = child.parentPath) {
    if (child.parentPath.node === scope.block) return child.listKey === 'params'
  }
  return false
}

/** Source environments that can introduce a binding between a reference and
 * its static owner. Strict closures still inherit outer sloppy activations. */
export function createDynamicScopeAnalysis(tree) {
  const evalActivations = new WeakSet()
  const parameterEvalActivations = new WeakSet()
  const directEvalSubtrees = new WeakSet()
  visitSource(tree, { CallExpression(path) {
    if (path.node.callee.type !== 'Identifier' || path.node.callee.name !== 'eval') return
    // Parameter plans need syntactic eval containment, including strict and
    // nested callables; shadow introduction separately follows real owners.
    for (let current = path; current && !directEvalSubtrees.has(current.node); current = current.parentPath) {
      directEvalSubtrees.add(current.node)
    }
    if (path.isInStrictMode()) return
    let child = path
    for (let parent = path.parentPath; parent; child = parent, parent = parent.parentPath) {
      if (parent.isFunction()) {
        if (child.key === 'body') { evalActivations.add(parent.node); return }
        if (child.listKey === 'params') { parameterEvalActivations.add(parent.node); return }
      }
      if (parent.isProgram()) evalActivations.add(parent.node)
    }
  } })
  return {
    containsDirectEval(node) { return directEvalSubtrees.has(node) },
    mayEvalShadow(path, ownerNode, self = false) {
      let child = path
      for (let parent = path.parentPath; parent; child = parent, parent = parent.parentPath) {
        if (parent.node === ownerNode && !self) return false
        if (evalActivations.has(parent.node) && (parent.isProgram() || child.key === 'body')) return true
        if (parameterEvalActivations.has(parent.node) && (child.key === 'body' || child.listKey === 'params')) return true
        if (parent.node === ownerNode) return false
      }
      return false
    },
  }
}

/** Var storage belongs to its variable scope, while initialization can select
 * a simple catch binding or an intervening with object. Ordinary block lexical
 * declarations retain their independent stateful identity. */
export function varInitializerTarget(path, ownerNode, name, sourceName = node => node.name) {
  const withNodes = []
  let child = path
  for (let parent = path.parentPath; parent && parent.node !== ownerNode;
    child = parent, parent = parent.parentPath) {
    if (parent.isWithStatement() && child.key === 'body') withNodes.push(parent.node)
    if (parent.isCatchClause() && child.key === 'body' && parent.node.param?.type === 'Identifier'
      && sourceName(parent.node.param) === name) return { catchNode: parent.node, withNodes }
  }
  return { withNodes }
}
