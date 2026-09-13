import { types as t } from '@babel/core'
import traverseImport from '@babel/traverse'

const traverse = traverseImport.default ?? traverseImport

/** Parameters and computed keys evaluate before a callable body scope exists.
 * Return that callable's path; an intervening callable body owns its own scope. */
export function callableDefinitionOwner(path) {
  let child = path
  while (child.parentPath && !child.parentPath.isFunction()) child = child.parentPath
  return child.parentPath && child.key !== 'body' ? child.parentPath : undefined
}

/** Close definition helpers without losing surrounding suspension or lexical
 * this/new.target. The outer owner only supports Babel's arrow conversion. */
export function closeDefinitionExpression(helpers, value, parameters = [], argumentsList = []) {
  const body = t.blockStatement([...helpers, t.returnStatement(value)])
  const factory = t.arrowFunctionExpression(parameters, body)
  const owner = t.functionExpression(null, [], t.blockStatement([t.returnStatement(factory)]))
  const tree = t.file(t.program([t.expressionStatement(owner)]))
  let awaited = false, yielded = false
  traverse(tree, { ArrowFunctionExpression(path) {
    if (path.node !== factory) return
    path.get('body').traverse(traverse.visitors.environmentVisitor({
      ArrowFunctionExpression(path) { path.skip() },
      AwaitExpression() { awaited = true },
      YieldExpression() { yielded = true },
    }))
    factory.async = awaited
    if (yielded) {
      const converted = path.arrowFunctionToExpression()
      converted.node.generator = true
    }
    path.stop()
  } })
  if (yielded) {
    owner.type = 'ArrowFunctionExpression'
    return t.yieldExpression(t.callExpression(t.callExpression(owner, []), argumentsList), true)
  }
  const expression = t.callExpression(factory, argumentsList)
  return awaited ? t.awaitExpression(expression) : expression
}
