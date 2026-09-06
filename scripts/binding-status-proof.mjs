import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'

const traverse = traverseModule.default ?? traverseModule
const options = { sourceType: 'module', allowReturnOutsideFunction: true, plugins: ['typescript'] }
const EXPORT = Symbol('module export')
const UNKNOWN_PRIMITIVE = Symbol('unknown primitive')

export const parseWorkflowSource = source => parse(source, options)
export const workflowSymbol = node => node?.type === 'Identifier' ? node.name
  : node?.type === 'MemberExpression' && (!node.computed || node.property.type === 'StringLiteral')
    ? `${workflowSymbol(node.object)}.${node.property.name ?? node.property.value}` : undefined

/** Prove only the scenario's nullary, literal-return exports, never arbitrary JS purity. */
export function constantExportProof(entry, expected = []) {
  if (expected.length === 0) return new Map()
  const statements = parseWorkflowSource(entry.source).program.body
  if (statements.length !== expected.length) return new Map()
  const result = new Map()
  for (const statement of statements) {
    const fn = statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined
    const value = fn?.body?.body?.[0]?.argument
    const proof = expected.find(item => item.member === fn?.id?.name)
    if (fn?.type !== 'FunctionDeclaration' || fn.async || fn.generator || fn.params.length !== 0
      || fn.body.body.length !== 1 || fn.body.body[0].type !== 'ReturnStatement'
      || !['NumericLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral'].includes(value?.type)
      || proof === undefined || !Object.is(proof.value, value.type === 'NullLiteral' ? null : value.value)) return new Map()
    result.set(fn.id.name, proof.value)
  }
  return result
}

/** A bounded source proof. Unsupported syntax remains unknown; nothing here executes a cell. */
export function proveStatusSource(source, entry, constants = new Map()) {
  const ast = parseWorkflowSource(source)
  const observations = []
  const unreachable = []
  const problems = []
  const locals = new Map()
  let assignmentCount = 0
  const functions = new Map(entry?.symbols.map(name => [name, { kind: EXPORT, name }]) ?? [])
  const namespace = { functions }
  const unknown = node => { throw new Error(`unproved ${node?.type ?? 'missing expression'} at offset ${node?.start ?? 0}`) }
  const primitive = value => value === UNKNOWN_PRIMITIVE || value === null || !['object', 'function', 'symbol'].includes(typeof value)
  const evaluate = node => {
    if (node === null) return undefined
    if (['NumericLiteral', 'StringLiteral', 'BooleanLiteral'].includes(node.type)) return node.value
    if (node.type === 'NullLiteral') return null
    if (node.type === 'Identifier') {
      if (locals.has(node.name)) return locals.get(node.name).value
      if (entry?.scope === 'namespace' && node.name === entry.name) return namespace
      if (entry?.scope === 'top-level' && functions.has(node.name)) return functions.get(node.name)
      return unknown(node)
    }
    if (node.type === 'MemberExpression') {
      const object = evaluate(node.object)
      const member = node.computed ? evaluate(node.property) : node.property.name
      if (object === namespace && functions.has(member)) return functions.get(member)
      return unknown(node)
    }
    if (node.type === 'UnaryExpression' && node.operator === 'typeof') {
      const value = evaluate(node.argument)
      return value?.kind === EXPORT ? constants.has(value.name) ? 'function' : UNKNOWN_PRIMITIVE
        : value === UNKNOWN_PRIMITIVE ? UNKNOWN_PRIMITIVE : typeof value
    }
    if (node.type === 'AwaitExpression' || node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression') {
      const value = evaluate(node.argument ?? node.expression)
      if (primitive(value)) return value
      return unknown(node)
    }
    if (node.type === 'TemplateLiteral') {
      let value = node.quasis[0].value.cooked
      for (const [index, expression] of node.expressions.entries()) {
        const part = evaluate(expression)
        if (!primitive(part)) return unknown(expression)
        value = part === UNKNOWN_PRIMITIVE || value === UNKNOWN_PRIMITIVE ? UNKNOWN_PRIMITIVE
          : value + String(part) + node.quasis[index + 1].value.cooked
      }
      return value
    }
    if (node.type === 'BinaryExpression') {
      const left = evaluate(node.left)
      const right = evaluate(node.right)
      if (!primitive(left) || !primitive(right)) return unknown(node)
      if (left === UNKNOWN_PRIMITIVE || right === UNKNOWN_PRIMITIVE) return UNKNOWN_PRIMITIVE
      if (node.operator === '===') return left === right
      if (node.operator === '!==') return left !== right
      if (node.operator === '+' && typeof left === typeof right && ['number', 'string'].includes(typeof left)) return left + right
      return unknown(node)
    }
    if (node.type === 'LogicalExpression') {
      const left = evaluate(node.left)
      if (!primitive(left)) return unknown(node)
      if (left === UNKNOWN_PRIMITIVE) {
        const before = assignmentCount
        if (!primitive(evaluate(node.right)) || assignmentCount !== before) return unknown(node)
        return UNKNOWN_PRIMITIVE
      }
      if (node.operator === '&&') return left ? evaluate(node.right) : (unreachable.push(node.right), left)
      if (node.operator === '||') return left ? (unreachable.push(node.right), left) : evaluate(node.right)
      return unknown(node)
    }
    if (node.type === 'CallExpression') {
      const fn = evaluate(node.callee)
      if (fn?.kind !== EXPORT || !constants.has(fn.name) || node.arguments.length !== 0) return unknown(node)
      return constants.get(fn.name)
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') {
      const local = locals.get(node.left.name)
      const value = evaluate(node.right)
      if (local?.writable !== true || !primitive(value)) return unknown(node)
      assignmentCount++
      local.value = value
      return value
    }
    return unknown(node)
  }
  const block = statements => {
    for (const [index, statement] of statements.entries()) {
      if (visit(statement)) {
        unreachable.push(...statements.slice(index + 1))
        return true
      }
    }
    return false
  }
  const visit = node => {
    if (node.type === 'BlockStatement') {
      const outer = new Map(locals)
      try { return block(node.body) } finally {
        locals.clear()
        for (const [name, value] of outer) locals.set(name, value)
      }
    }
    if (node.type === 'EmptyStatement') return false
    if (node.type === 'VariableDeclaration') {
      if (node.kind === 'var') return unknown(node)
      for (const declaration of node.declarations) {
        if (declaration.id.type !== 'Identifier' || locals.has(declaration.id.name)
          || declaration.id.name === entry?.name || functions.has(declaration.id.name)) return unknown(declaration)
        const value = evaluate(declaration.init)
        if (!primitive(value)) return unknown(declaration)
        locals.set(declaration.id.name, { value, writable: node.kind !== 'const' })
      }
      return false
    }
    if (node.type === 'ExpressionStatement' || node.type === 'ReturnStatement') {
      const value = evaluate(node.expression ?? node.argument)
      if (!primitive(value)) return unknown(node)
      return node.type === 'ReturnStatement'
    }
    if (node.type === 'IfStatement') {
      const value = evaluate(node.test)
      if (!primitive(value) || value === UNKNOWN_PRIMITIVE) return unknown(node)
      const selected = value ? node.consequent : node.alternate
      const skipped = value ? node.alternate : node.consequent
      if (skipped) unreachable.push(skipped)
      return selected ? visit(selected) : false
    }
    if (node.type === 'TryStatement') {
      // Only a fully proved, non-throwing try body makes catch unreachable.
      const returned = visit(node.block)
      if (node.handler) unreachable.push(node.handler)
      const finalized = node.finalizer ? visit(node.finalizer) : false
      return finalized || returned
    }
    return unknown(node)
  }
  try { block(ast.program.body) } catch (error) { problems.push(error.message) }
  traverse(ast, {
    'CallExpression|NewExpression'(path) {
      observations.push({ target: workflowSymbol(path.node.callee) ?? 'unresolved function',
        offset: path.node.start,
        evidence: unreachable.some(node => path.node.start >= node.start && path.node.end <= node.end)
          ? 'unreachable-source' : 'potential-source',
      })
    },
    MemberExpression(path) {
      if (workflowSymbol(path.node) === 'repl.state'
        && !unreachable.some(node => path.node.start >= node.start && path.node.end <= node.end)) {
        problems.push('checkpoint API is not binding-existence evidence')
      }
    },
  })
  return { observations, problems }
}
