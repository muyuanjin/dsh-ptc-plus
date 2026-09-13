import traverseModule from '@babel/traverse'
import { types as t } from '@babel/core'
import { indexSource } from './compiler-source-regions.js'
import { sourceScopePath, sourceInParameters } from './dynamic-scope-analysis.js'

const traverse = traverseModule.default ?? traverseModule

/** Node supplies these parameters to the CommonJS source activation. */
export const COMMONJS_PARAMETERS = Object.freeze(['exports', 'require', 'module', '__filename', '__dirname'])

/** Resolve original names against complete declaration ownership, including
 * parameter/body separation and immutable callable/class self environments. */
export function resolveSourceBinding(facts, path, name) {
  for (const scope of sourceScopePath(path)) {
    const parameterEnvironment = sourceInParameters(path, scope)
    const bodyScope = facts.functionBodyScopes.get(scope)
    const body = facts.scopes.get(bodyScope)?.get(name)
    if (body !== undefined && !parameterEnvironment) return body
    const own = facts.scopes.get(scope)?.get(name)
    if (own !== undefined && !(parameterEnvironment && !own.occurrences.some(item => item.role === 'parameter' || item.role === 'self'))) return own
    const self = facts.scopes.get(facts.functionSelfScopes.get(scope))?.get(name)
    if (self !== undefined) return self
    if (t.isClass(scope.block) && facts.names.get(scope.block.id) === name) return undefined
  }
  return undefined
}

/** Retain the grammar's scope edges while omitting unrelated expression work. */
function shell(node, originals) {
  const result = { ...node }
  originals.set(result, node)
  for (const key of t.VISITOR_KEYS[node.type] ?? []) result[key] = Array.isArray(node[key]) ? [] : null
  if (t.isFunction(node)) { result.params = []; result.body = t.blockStatement([]) }
  if (t.isClass(node)) result.body = t.classBody([])
  if (t.isLabeledStatement(node)) result.label = { ...node.label }
  if (t.isMethod(node) || t.isObjectProperty(node) || t.isClassProperty(node) || t.isClassPrivateProperty(node)) {
    result.key = t.isPrivateName(node.key) ? t.privateName(t.identifier(node.key.id.name)) : t.numericLiteral(0)
  }
  return result
}

function pattern(node, copy) {
  if (node === null) return null
  const result = copy(node)
  if (t.isIdentifier(node)) return result
  if (t.isAssignmentPattern(node)) { result.left = pattern(node.left, copy); result.right ??= t.numericLiteral(0) }
  else if (t.isRestElement(node)) result.argument = pattern(node.argument, copy)
  else if (t.isArrayPattern(node)) result.elements = node.elements.map(item => pattern(item, copy))
  else if (t.isObjectPattern(node)) result.properties = node.properties.map(item => {
    if (t.isRestElement(item)) return pattern(item, copy)
    const property = copy(item)
    property.value = pattern(item.value, copy)
    return property
  })
  return result
}

/** Unique occurrence names let bounded groups share their ancestry witness.
 * Babel still owns declaration placement; unrelated expressions stay absent. */
export function analyzeSourceDeclarations(tree, declarations) {
  const paths = indexSource(tree)
  const owners = new Map()
  const entries = [...declarations]
  for (let offset = 0; offset < entries.length; offset += 64) {
    const batch = entries.slice(offset, offset + 64)
    const originals = new Map(), copies = new Map(), linked = new Set()
    const copy = node => {
      let result = copies.get(node)
      if (result === undefined) { result = shell(node, originals); copies.set(node, result) }
      return result
    }
    for (const [declaration] of batch) {
      let selected = copy(declaration)
      if (t.isVariableDeclaration(declaration)) {
        selected.declarations = declaration.declarations.map(item => {
          const declarator = copy(item)
          declarator.id = pattern(item.id, copy)
          return declarator
        })
      } else if (t.isFunction(declaration)) {
        selected.id = declaration.id && pattern(declaration.id, copy)
        selected.params = declaration.params.map(item => pattern(item, copy))
      } else if (t.isClass(declaration)) selected.id = declaration.id && pattern(declaration.id, copy)
      else if (t.isCatchClause(declaration)) {
        selected.param = declaration.param && pattern(declaration.param, copy)
        selected.body ??= t.blockStatement([])
      } else if (t.isImportDeclaration(declaration)) {
        selected.source = declaration.source
        selected.specifiers = declaration.specifiers.map(item => ({ ...item, local: pattern(item.local, copy) }))
      }
      let path = paths.get(declaration)
      while (path.parentPath && !linked.has(path.node)) {
        linked.add(path.node)
        const parent = copy(path.parent)
        if (path.listKey !== null) {
          if (!parent[path.listKey].includes(selected)) parent[path.listKey].push(selected)
        }
        else parent[path.key] = selected
        selected = parent
        path = path.parentPath
      }
    }
    const witness = t.file(copies.get(tree.program))
    const byName = new Map(batch.flatMap(([declaration, occurrences]) => occurrences
      .map(occurrence => [occurrence.node.name, { occurrence, declaration }])))
    traverse(witness, { Identifier(path) {
      const { occurrence, declaration } = byName.get(path.node.name) ?? {}
      if (occurrence === undefined || originals.get(path.node) !== occurrence.node) return
      const binding = path.scope.getBinding(path.node.name)
      const owner = occurrence.role === 'catch' ? declaration : originals.get(binding.scope.block)
      owners.set(occurrence.node, paths.scopeFor(owner))
    } })
  }
  return { paths, owners }
}
