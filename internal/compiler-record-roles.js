import { types as t } from '@babel/core'

/** Prove ownership from consumers, before helper operations lose binding facts.
 * Reading a field exposes its value, not its record. Passing or publishing the
 * record itself requires a known private consumer; uncertainty retains the
 * ordinary source-facing object contract. */
export function privateGeneratedRecords(file) {
  const records = new WeakSet()
  const resolve = path => {
    if (!path.isIdentifier()) return path
    const binding = path.scope.getBinding(path.node.name)
    return binding?.constant && binding.path.isVariableDeclarator() ? binding.path.get('init') : path
  }
  const privateBinding = (binding, seen) => {
    if (!binding || binding.identifier.loc) return false
    if (seen.has(binding)) return true
    seen.add(binding)
    return binding.referencePaths.every(path => privateUse(path, seen))
  }
  const privateUse = (path, seen) => {
    const parent = path.parentPath
    if (parent.isMemberExpression() && path.key === 'object') {
      return !parent.parentPath.isCallExpression({ callee: parent.node })
        && !parent.parentPath.isOptionalCallExpression({ callee: parent.node })
        && !parent.parentPath.isTaggedTemplateExpression({ tag: parent.node })
    }
    if (parent.isVariableDeclarator() && path.key === 'init' && t.isIdentifier(parent.node.id)) {
      return privateBinding(parent.scope.getBinding(parent.node.id.name), seen)
    }
    if (parent.isAssignmentExpression({ operator: '=' }) && path.key === 'right' && t.isIdentifier(parent.node.left)) {
      return privateBinding(parent.scope.getBinding(parent.node.left.name), seen)
        && (parent.parentPath.isExpressionStatement() || privateUse(parent, seen))
    }
    if (!parent.isCallExpression() || path.listKey !== 'arguments') return false
    const callee = resolve(parent.get('callee'))
    if (!callee.isMemberExpression() || callee.node.computed) return false
    const receiver = resolve(callee.get('object'))
    if (callee.node.property.name === 'bind' && receiver.isFunctionExpression() && !receiver.node.loc && path.key > 0) {
      const parameter = receiver.node.params[path.key - 1]
      return t.isIdentifier(parameter) && privateBinding(receiver.scope.getBinding(parameter.name), seen)
    }
    // Captured descriptor operations consume own fields, never publish the
    // transport object. Source Object calls have locations and are excluded.
    return path.key === 2 && callee.node.property.name === 'defineProperty'
      && receiver.isIdentifier({ name: 'Object' }) && !receiver.node.loc
  }
  file.path.traverse({ ObjectExpression(path) {
    if (!path.node.loc && path.node.properties.every(property => t.isObjectProperty(property)
      && !property.computed && !t.isIdentifier(property.key, { name: '__proto__' })
      && !t.isStringLiteral(property.key, { value: '__proto__' })) && privateUse(path, new Set())) records.add(path.node)
  } })
  return records
}
