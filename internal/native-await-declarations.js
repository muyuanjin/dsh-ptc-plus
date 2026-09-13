import traverseModule from '@babel/traverse'
import { types as t } from '@babel/core'

const traverse = traverseModule.default ?? traverseModule

/** Native await owns persistent declaration instantiation; references own writes. */
export function rewriteNativeAwaitDeclarations(tree, { hiddenBindings, nativePlaceholders, reference, initialize, namedValue, replaceIterationDeclaration }) {
  const placeholders = []
  const preserve = node => { nativePlaceholders.add(node); placeholders.push(node) }
  const rootIdentifiers = node => {
    if (t.isIdentifier(node)) return [node]
    if (t.isObjectPattern(node)) return node.properties.flatMap(property => rootIdentifiers(property.value ?? property.argument))
    if (t.isArrayPattern(node)) return node.elements.flatMap(element => rootIdentifiers(element))
    // Native REPL await registers direct pattern identifiers. Default targets
    // and array rest targets remain assignment references in that generation.
    return []
  }
  const lexicalPlaceholder = name => preserve(t.variableDeclaration('let', [
    t.variableDeclarator(t.identifier(name), t.identifier(name)),
  ]))
  const assignmentPattern = (node, path) => {
    if (t.isIdentifier(node)) return reference(path, node.name)
    if (t.isArrayPattern(node)) return t.arrayPattern(node.elements.map(element => element === null ? null : assignmentPattern(element, path)))
    if (t.isObjectPattern(node)) return t.objectPattern(node.properties.map(property => t.isRestElement(property)
      ? t.restElement(assignmentPattern(property.argument, path))
      : t.objectProperty(property.key, assignmentPattern(property.value, path), property.computed, false)))
    if (t.isAssignmentPattern(node)) return t.assignmentPattern(assignmentPattern(node.left, path),
      t.isIdentifier(node.left) ? namedValue(node.left.name, node.right) : node.right)
    return t.restElement(assignmentPattern(node.argument, path))
  }
  traverse(tree, {
    VariableDeclaration(path) {
      if (path.node.declarations.some(declaration => t.isIdentifier(declaration.id) && hiddenBindings.has(declaration.id.name))
        || path.getFunctionParent() !== null || path.node.kind !== 'var' && !path.parentPath.isProgram()) return
      const original = path.node
      if (original.kind === 'var') {
        const declaration = t.cloneNode(original, true)
        for (const item of declaration.declarations) item.init = t.unaryExpression('void', t.numericLiteral(0))
        preserve(t.ifStatement(t.booleanLiteral(false), t.blockStatement([declaration])))
      } else for (const item of original.declarations) for (const name of rootIdentifiers(item.id)) lexicalPlaceholder(name.name)
      const assignment = item => {
        const value = item.init ?? t.unaryExpression('void', t.numericLiteral(0))
        return t.isIdentifier(item.id) ? initialize(path, item.id.name, namedValue(item.id.name, value))
          : t.assignmentExpression('=', assignmentPattern(item.id, path), value)
      }
      if (path.parentPath.isForOfStatement() || path.parentPath.isForInStatement()) {
        replaceIterationDeclaration(path, assignmentPattern(original.declarations[0].id, path),
          original.declarations.filter(item => item.init !== null).map(assignment))
      } else {
        const assignments = original.declarations.map(assignment)
        const expression = t.inherits(assignments.length === 1 ? assignments[0] : t.sequenceExpression(assignments), original)
        path.replaceWith(path.parentPath.isForStatement() ? expression : t.expressionStatement(t.unaryExpression('void', expression)))
      }
      path.skip()
    },
    ClassDeclaration(path) {
      if (!path.parentPath.isProgram()) return
      const name = path.node.id.name
      lexicalPlaceholder(name)
      const target = reference(path.parentPath, name)
      path.node.type = 'ClassExpression'
      const assignment = t.inherits(t.assignmentExpression('=', target, path.node), path.node)
      path.replaceWith(t.expressionStatement(t.unaryExpression('void', assignment)))
      path.skip()
    },
  })
  tree.program.body.unshift(...placeholders)
}
