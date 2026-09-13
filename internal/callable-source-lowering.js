import { parse } from '@babel/parser'
import { types as t } from '@babel/core'
import generatorImport from '@babel/generator'
import traverseImport from '@babel/traverse'
import { callableDefinitionOwner, closeDefinitionExpression } from './callable-definition-environment.js'

const generate = generatorImport.default ?? generatorImport
const traverse = traverseImport.default ?? traverseImport
const nativeParserOptions = { sourceType: 'script', allowAwaitOutsideFunction: true, allowYieldOutsideFunction: true,
  allowSuperOutsideMethod: true, allowNewTargetOutsideFunction: true }
const parserOptions = { sourceType: 'script', plugins: ['typescript', 'decorators', 'decoratorAutoAccessors'],
  ...nativeParserOptions, allowReturnOutsideFunction: true, errorRecovery: true }
const methodNode = node => t.isObjectMethod(node) || t.isClassMethod(node) || t.isClassPrivateMethod(node)
const text = node => generate(node).code

/** Definition-time decorators belong to the enclosing class, not the method value. */
export function undecoratedMethodSource(node) {
  const method = t.cloneNode(node, true)
  method.decorators = null
  method.static = false
  method.accessibility = null
  for (const parameter of method.params) parameter.decorators = null
  return text(method)
}

/** A decorated declaration's range may include its parent's export modifiers. */
export function decoratedClassSource(node) {
  const value = t.cloneNode(node, true)
  value.type = 'ClassExpression'
  value.abstract = false
  return text(value)
}

/** A body owns only the helper bindings it can use, including dependencies of
 * those helpers. Parameter and key activations obtain their own lexical set. */
function closeCallableHelpers(value, helpers) {
  const callable = t.isMethod(value) ? { ...value, type: 'ObjectMethod' } : value
  const tree = t.file(t.program([...helpers, t.expressionStatement(t.isMethod(callable)
    ? t.objectExpression([callable]) : callable)]))
  const bodies = new Map([[callable, new Set()]])
  const dependencies = new Map(helpers.map(node => [node, new Set()]))
  const statement = path => {
    while (!path.parentPath.isProgram()) path = path.parentPath
    return path.node
  }
  traverse(tree, { Function(path) {
    if (callableDefinitionOwner(path) && !dependencies.has(statement(path))) bodies.set(path.node, new Set())
  } })
  traverse(tree, { ReferencedIdentifier(path) {
    const binding = path.scope.getBinding(path.node.name)
    if (binding === undefined) return
    const helper = statement(binding.path)
    if (!dependencies.has(helper)) return
    const consumer = dependencies.get(statement(path))
    if (consumer) consumer.add(helper)
    else {
      let child = path
      while (child.parentPath) {
        const parent = child.parentPath
        if (bodies.has(parent.node) && child.key === 'body') {
          bodies.get(parent.node).add(helper)
          break
        }
        child = parent
      }
    }
  } })
  for (const [body, required] of bodies) {
    for (const helper of required) for (const dependency of dependencies.get(helper)) required.add(dependency)
    if (!t.isBlockStatement(body.body)) body.body = t.blockStatement([t.returnStatement(body.body)])
    body.body.body.unshift(...helpers.filter(node => required.has(node)).map(node => t.cloneNode(node, true)))
  }
  value.body = callable.body
}

/** Close generated language helpers over the source that actually needs them. */
export function lowerCallableSource(original, { method = false, lowerNativeSource, privateNames = [], sourceType = 'script' }) {
  // Grammar-only containers must not acquire logical declaration identities.
  // Every fragment crosses lowering as an expression, including method hosts.
  const prefix = method ? '(class {' : '('
  const suffix = method ? '})' : ')'
  let input = prefix + original + suffix
  const nativeOptions = { ...nativeParserOptions, sourceType, errorRecovery: true }
  const tree = parse(input, { ...parserOptions, sourceType })
  let contextual = privateNames.length > 0
  t.traverseFast(tree, node => {
    if (t.isSuper(node) || t.isMetaProperty(node) && node.meta.name === 'new') contextual = true
  })
  // Declaration ownership is assigned after dialect normalization. This
  // inspection only selects the detached fragment's surrounding grammar.
  traverse(tree, { noScope: true,
    ...traverse.visitors.environmentVisitor({ YieldExpression() { contextual = true } }),
  })
  if (!method && t.isClass(tree.program.body[0].expression) && tree.program.body[0].expression.id === null) {
    input = `({[""]:${input}})[""]`
  }
  if (contextual) {
    const body = `async *source(){return ${input}}`
    input = privateNames.length > 0 ? `(class{${privateNames.map(name => `#${name};`).join('')}${body}})`
      : `({${body}})`
  }
  const lowered = lowerNativeSource(input, { sourceType })
  const native = parse(lowered, nativeOptions)
  const helpers = native.program.body.slice(0, -1)
  let expression = native.program.body.at(-1).expression
  if (contextual) {
    const body = (privateNames.length > 0 ? expression.body.body : expression.properties)
      .find(methodNode).body.body
    helpers.push(...body.slice(0, -1))
    expression = body.at(-1).argument
  }
  const value = method ? expression.body.body.find(methodNode) : expression
  let source
  if (t.isFunction(value)) {
    closeCallableHelpers(value, helpers)
    source = text(value)
  } else {
    source = text(helpers.length === 0 ? value : closeDefinitionExpression(helpers, value))
  }
  const emittedSource = method ? `class Source{${source}}` : `(${source})`
  const emitted = parse(emittedSource, nativeOptions)
  return { source, emitted, emittedSource }
}
