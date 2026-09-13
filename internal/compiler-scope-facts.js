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

function pattern(node, originals) {
  if (node === null) return null
  const result = shell(node, originals)
  if (t.isIdentifier(node)) return result
  if (t.isAssignmentPattern(node)) { result.left = pattern(node.left, originals); result.right = t.numericLiteral(0) }
  else if (t.isRestElement(node)) result.argument = pattern(node.argument, originals)
  else if (t.isArrayPattern(node)) result.elements = node.elements.map(item => pattern(item, originals))
  else if (t.isObjectPattern(node)) result.properties = node.properties.map(item => {
    if (t.isRestElement(item)) return pattern(item, originals)
    const property = shell(item, originals)
    property.value = pattern(item.value, originals)
    return property
  })
  return result
}

/** Babel assigns each declaration's owner on an ancestry witness. Complete
 * logical groups are merged afterward, never inferred from a partial scope. */
export function analyzeSourceDeclarations(tree, declarations) {
  const paths = indexSource(tree)
  const owners = new Map()
  for (const [declaration, occurrences] of declarations) {
    const originals = new Map()
    let selected = shell(declaration, originals)
    if (t.isVariableDeclaration(declaration)) {
      selected.declarations = declaration.declarations.map(item => {
        const declarator = shell(item, originals)
        declarator.id = pattern(item.id, originals)
        return declarator
      })
    } else if (t.isFunction(declaration)) {
      selected.id = declaration.id && pattern(declaration.id, originals)
      selected.params = declaration.params.map(item => pattern(item, originals))
    } else if (t.isClass(declaration)) selected.id = declaration.id && pattern(declaration.id, originals)
    else if (t.isCatchClause(declaration)) {
      selected.param = declaration.param && pattern(declaration.param, originals)
      selected.body = t.blockStatement([])
    } else if (t.isImportDeclaration(declaration)) {
      selected.source = declaration.source
      selected.specifiers = declaration.specifiers.map(item => ({ ...item, local: pattern(item.local, originals) }))
    }
    let path = paths.get(declaration)
    while (path.parentPath) {
      const parent = shell(path.parent, originals)
      if (path.listKey !== null) parent[path.listKey] = [selected]
      else parent[path.key] = selected
      selected = parent
      path = path.parentPath
    }
    const witness = t.file(selected)
    const byName = new Map(occurrences.map(occurrence => [occurrence.node.name, occurrence]))
    traverse(witness, { Identifier(path) {
      const occurrence = byName.get(path.node.name)
      if (occurrence === undefined || originals.get(path.node) !== occurrence.node) return
      const binding = path.scope.getBinding(path.node.name)
      const owner = occurrence.role === 'catch' ? declaration : originals.get(binding.scope.block)
      owners.set(occurrence.node, paths.scopeFor(owner))
    } })
  }
  return { paths, owners }
}
