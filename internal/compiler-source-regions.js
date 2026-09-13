import traverseModule, { NodePath } from '@babel/traverse'
import { types as t } from '@babel/core'

const traverse = traverseModule.default ?? traverseModule
const SOURCE_CONTEXT = Object.freeze({ opts: Object.freeze({ noScope: true }) })

class SourceScope {
  constructor(id, nodeId, parentId) { this.id = id; this.nodeId = nodeId; this.parentId = parentId }
  get path() { return this.index.get(this.block) }
  getFunctionParent() {
    for (let scope = this; scope; scope = scope.parent) {
      if (t.isFunction(scope.block) || t.isStaticBlock(scope.block)) return scope
    }
    return null
  }
  getProgramParent() {
    let scope = this
    while (scope.parent) scope = scope.parent
    return scope
  }
}

export function sourcePath(node, parentPath, container, key, listKey = null, scope = null) {
  const path = new NodePath(undefined, parentPath?.node ?? container)
  path.parentPath = parentPath
  path.container = container
  path.key = key
  path.listKey = listKey
  path.node = node
  path.type = node.type
  path.setContext(SOURCE_CONTEXT)
  path.scope = scope
  return path
}

/** Visit source facts with Babel's syntax predicates, retaining only ancestry.
 * These paths do not enter Babel's whole-tree path/scope caches. Mutating
 * transforms use separately bounded work trees instead. */
export function visitSource(tree, visitor) {
  const handlers = traverse.visitors.explode({ ...visitor, noScope: true })
  const callbacks = new Map()
  let stopped = false
  const visit = (parentPath, container, key, listKey) => {
    const node = container[key]
    if (node === null || node === undefined) return
    const path = sourcePath(node, parentPath, container, key, listKey)
    let selected = callbacks.get(node.type)
    if (selected === undefined) {
      selected = { enter: [...handlers.enter ?? [], ...handlers[node.type]?.enter ?? []],
        exit: [...handlers[node.type]?.exit ?? [], ...handlers.exit ?? []] }
      callbacks.set(node.type, selected)
    }
    for (const handler of selected.enter) {
      handler(path)
      if (path.shouldStop) { stopped = true; return }
      if (path.shouldSkip) return
    }
    for (const field of t.VISITOR_KEYS[node.type] ?? []) {
      if (path.skipKeys?.[field]) continue
      const child = node[field]
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length && !stopped; index++) visit(path, child, index, field)
      } else if (!stopped) visit(path, node, field, null)
    }
    for (const handler of selected.exit) {
      handler(path)
      if (path.shouldStop) { stopped = true; return }
    }
  }
  if (tree.type === 'File') visit(null, tree, 'program', null)
  else visit(null, { root: tree }, 'root', null)
}

/** Compact ancestry survives a work tree; NodePaths are materialized on demand. */
export function indexSource(tree) {
  const ids = new WeakMap()
  const nodes = [], parentIds = [], keys = [], lists = [], scopeIds = []
  const scopes = []
  const visit = (node, parentId, key, listKey) => {
    if (node === null || node === undefined) return
    const parent = parentId === undefined ? tree : nodes[parentId]
    const id = nodes.length
    ids.set(node, id)
    nodes.push(node)
    parentIds.push(parentId ?? -1)
    keys.push(key)
    lists.push(listKey)
    let parentScope = parentId === undefined ? -1 : scopeIds[parentId]
    if (parentId !== undefined && (key === 'key' || listKey === 'decorators') && t.isMethod(parent)
      || parentId !== undefined && key === 'discriminant' && t.isSwitchStatement(parent)) {
      parentScope = scopes[parentScope]?.parentId ?? -1
    }
    let scopeId = parentScope
    if (t.isScope(node, parent)) {
      scopeId = scopes.length
      scopes.push(new SourceScope(scopeId, id, parentScope))
    }
    scopeIds.push(scopeId)
    for (const field of t.VISITOR_KEYS[node.type] ?? []) {
      const child = node[field]
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index++) visit(child[index], id, index, field)
      } else visit(child, id, field, null)
    }
  }
  visit(tree.type === 'File' ? tree.program : tree, undefined, tree.type === 'File' ? 'program' : 'root', null)
  const parents = Int32Array.from(parentIds)
  const nodeScopes = Int32Array.from(scopeIds)
  const get = node => {
    let id = ids.get(node)
    if (id === undefined) return undefined
    const ancestors = []
    while (id >= 0) { ancestors.push(id); id = parents[id] }
    let path = null
    for (let index = ancestors.length - 1; index >= 0; index--) {
      id = ancestors[index]
      const node = nodes[id]
      const container = lists[id] === null ? path?.node ?? tree : path.node[lists[id]]
      path = sourcePath(node, path, container, keys[id], lists[id], scopes[nodeScopes[id]])
    }
    return path
  }
  const index = { get, ids, nodes, scopes, scopeFor: node => scopes[nodeScopes[ids.get(node)]],
    parentFor: node => nodes[parents[ids.get(node)]] ?? tree,
  }
  for (const scope of scopes) {
    scope.block = nodes[scope.nodeId]
    scope.parent = scopes[scope.parentId] ?? null
    scope.index = index
  }
  return index
}
