import traverseModule from '@babel/traverse'
import { types as t } from '@babel/core'
import { transform as transformOptional, transformOptionalChain } from '@babel/plugin-transform-optional-chaining'
import { isWriteIdentifier as isWriteTarget } from './binding-pattern.js'
import { withGeneratedNameAllocator } from './compiler-generated-names.js'

const traverse = traverseModule.default ?? traverseModule

/** Select intrinsic interfaces at owned source value and invocation boundaries. */
export function rewriteNativeCalls(tree, environment, { origin, skip, operations, originalCallees, allocate }) {
  const { internal } = operations
  let memberReceiver
  let programScope
  const helper = (name, args) => {
    return operations.operation(t.callExpression(t.memberExpression(t.cloneNode(environment), t.identifier(name)), args))
  }
  const skipOwned = path => path.isTSType() || skip(path)
    || operations.callee(path.node)
  const undefinedValue = () => t.unaryExpression('void', t.numericLiteral(0))
  if (originalCallees === undefined) {
    originalCallees = new WeakSet()
    traverse(tree, {
      enter(path) { if (path.isTSType() || skip(path)) path.skip() },
      'CallExpression|OptionalCallExpression'(path) { originalCallees.add(path.node.callee) },
    })
  }
  traverse(tree, { Program(path) { programScope = path.scope; path.stop() } })
  const expose = path => {
    // Only GetValue results select an interface. References must retain their
    // write/delete semantics, receivers and optional-chain short circuiting.
    const parent = path.parentPath
    if (operations.owns(path.node) && !operations.isValue(path.node)
      || !path.isReferenced() || isWriteTarget(path) || parent.isUnaryExpression({ operator: 'delete' })
      || parent.isUnaryExpression({ operator: 'typeof' }) && path.isIdentifier()
      || (parent.isCallExpression() || parent.isOptionalCallExpression()) && path.key === 'callee'
      || parent.isTaggedTemplateExpression() && path.key === 'tag'
      || parent.isDecorator()
      || parent.isOptionalMemberExpression() && path.key === 'object'
      || path.isIdentifier() && internal.has(path.node.name)) return
    if (parent.isObjectProperty() && parent.node.shorthand) {
      parent.node.shorthand = false
      parent.node.computed = true
      parent.node.key = t.stringLiteral(path.node.name)
    }
    if (path.isMemberExpression() && !t.isSuper(path.node.object) && !t.isPrivateName(path.node.property)) {
      const key = path.node.computed ? path.node.property : t.stringLiteral(path.node.property.name)
      path.replaceWith(t.inherits(helper('exposeProperty', [path.node.object, key]), path.node))
    } else path.replaceWith(t.inherits(helper('expose', [path.node]), path.node))
    path.skip()
  }
  const prepare = (callee, target, optional = false) => {
    const stamp = target === undefined ? undefinedValue() : t.valueToNode(target)
    const options = [stamp, t.booleanLiteral(optional)]
    const prepared = (name, args) => t.inherits(helper(name, args), callee)
    if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
      if (t.isSuper(callee.object)) return prepared('prepareInvocation', [callee, t.thisExpression(), ...options])
      if (memberReceiver === undefined) {
        memberReceiver = t.identifier(allocate('member_receiver'))
        programScope.push({ id: memberReceiver })
        internal.add(memberReceiver.name)
      }
      // Argument evaluation saves the receiver before key/getter reentrancy can
      // change the temporary; the member read itself stays in its source frame.
      const receiver = helper('releaseMemberReceiver', [t.cloneNode(memberReceiver),
        t.assignmentExpression('=', t.cloneNode(memberReceiver), undefinedValue())])
      return prepared('prepareMemberInvocation', [t.assignmentExpression('=', t.cloneNode(memberReceiver), callee.object),
        t.inherits(t.memberExpression(receiver, callee.property, callee.computed), callee), ...options])
    }
    return prepared('prepareInvocation', [callee, undefinedValue(), ...options])
  }
  const invoke = (prepared, args) => operations.operation(t.callExpression(helper('beginInvocation', [prepared, args]), []))
  // Receiver extraction must run after complete chains acquire their native
  // short-circuit boundary, including grouped calls and computed-key effects.
  traverse(tree, {
    enter(path) { if (skipOwned(path)) path.skip() },
    'OptionalCallExpression|OptionalMemberExpression'(path) {
      const assumptions = { pureGetters: false, noDocumentAll: false }
      withGeneratedNameAllocator(path.scope, allocate, () => {
        if (path.isOptionalMemberExpression() && path.parentPath.isTaggedTemplateExpression()) {
          const target = origin(path.parent)
          transformOptionalChain(path, assumptions, path, undefinedValue(), callee => helper('prepareTagInvocation', [prepare(callee, target)]))
        } else transformOptional(path, assumptions)
      })
    },
  })
  traverse(tree, {
    enter(path) { if (skipOwned(path)) path.skip() },
    'TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion': { enter(path) {
      path.replaceWith(path.node.expression)
    } },
    ExportSpecifier(path) {
      // Babel's printer compares identifier names when eliding an alias. Both
      // string ModuleExportNames otherwise appear equal as undefined names.
      const { local, exported } = path.node
      if (t.isStringLiteral(local) && t.isStringLiteral(exported)) exported.name = exported.value
      path.skip()
    },
    ReferencedIdentifier: { exit: expose },
    'MemberExpression|OptionalMemberExpression|AwaitExpression|YieldExpression': { exit: expose },
    ThrowStatement: { exit(path) {
      if (operations.owns(path.node)) return
      const argument = path.node.argument
      path.node.argument = t.inherits(helper('propagate', [argument, t.valueToNode(origin(argument))]), argument)
      path.skip()
    } },
    'CallExpression|OptionalCallExpression': { exit(path) {
      if (operations.owns(path.node)) {
        if (operations.isValue(path.node)) expose(path)
        return
      }
      if (t.isSuper(path.node.callee) || t.isImport(path.node.callee)
        || t.isIdentifier(path.node.callee, { name: 'eval' })) return
      const node = path.node
      // Babel expresses saved receivers through generated call/bind members.
      // The intrinsic interface already owns invocation, so use the saved
      // receiver directly without observing user-replaced call/bind properties.
      if (t.isMemberExpression(node.callee) && !originalCallees.has(node.callee)
        && t.isIdentifier(node.callee.property) && ['call', 'bind'].includes(node.callee.property.name)) {
        const prepared = helper('prepareInvocation', [node.callee.object, node.arguments[0],
          t.valueToNode(origin(node)), t.booleanLiteral(false)])
        path.replaceWith(t.inherits(node.callee.property.name === 'bind'
          ? helper('prepareTagInvocation', [prepared]) : invoke(prepared, t.arrayExpression(node.arguments.slice(1))), node))
        path.skip()
        return
      }
      const callee = prepare(node.callee, origin(node), node.optional === true)
      path.replaceWith(t.inherits(invoke(callee, t.arrayExpression(node.arguments)), node))
      path.skip()
    } },
    NewExpression: { exit(path) {
      if (operations.owns(path.node)) return
      const target = origin(path.node)
      const invocation = t.inherits(invoke(helper('prepareInvocation', [path.node.callee, undefinedValue(),
        target === undefined ? undefinedValue() : t.valueToNode(target), t.booleanLiteral(false), t.booleanLiteral(true)]), t.arrayExpression(path.node.arguments)), path.node)
      // Native Error construction records the continuation call site. Anchor
      // that private call to the original new expression, after its arguments.
      if (invocation.loc !== undefined) invocation.callee.loc = { ...invocation.loc, end: invocation.loc.start }
      path.replaceWith(invocation)
      path.skip()
    } },
    TaggedTemplateExpression: { exit(path) {
      if (operations.owns(path.node)) return
      const args = t.taggedTemplateExpression(t.memberExpression(t.cloneNode(environment), t.identifier('templateArguments')), path.node.quasi)
      path.replaceWith(t.inherits(invoke(prepare(path.node.tag, origin(path.node)), args), path.node))
      path.skip()
    } },
    Decorator: { exit(path) {
      if (operations.owns(path.node)) return
      path.node.expression = helper('prepareTagInvocation', [prepare(path.node.expression, origin(path.node))])
      path.skip()
    } },
  })
}
