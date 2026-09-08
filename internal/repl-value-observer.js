import { types } from 'node:util'
import { runInContext } from 'node:vm'
import { parse } from 'acorn'
import { randomUUID } from 'node:crypto'
import { walkAst, SKIP_AST_CHILDREN } from './ast-traversal.js'
import { bindingNodes } from './binding-pattern.js'

const MAX_ENTRIES = 128
const MAX_TEXT = 512
const MAX_PROPERTIES = 5
const ownDescriptor = Object.getOwnPropertyDescriptor
const isArray = Array.isArray
const isProxy = types.isProxy
const stringify = JSON.stringify
const now = Date.now
const bigintText = BigInt.prototype.toString
const BIGINT_LIMIT = 10n ** 128n
const unreadable = () => ({ status: 'unreadable', text: '', truncated: false })

function primitiveText(value) {
  if (typeof value === 'string') return stringify(value.slice(0, MAX_TEXT))
  if (typeof value === 'bigint') return value > -BIGINT_LIMIT && value < BIGINT_LIMIT
    ? `${bigintText.call(value)}n` : '[bigint: more than 128 digits]'
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}: unreadable]`
  if (value === null) return 'null'
  if (typeof value === 'object') return isProxy(value) ? '[proxy: unreadable]' : '[object]'
  return Object.is(value, -0) ? '-0' : String(value)
}

/** Inspect own descriptors only, rejecting proxies before any reflective operation. */
export function previewBindingValue(value) {
  if (['function', 'symbol'].includes(typeof value)) return unreadable()
  if (value === null || typeof value !== 'object') {
    const text = primitiveText(value)
    return { status: 'readable', text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT
      || (typeof value === 'bigint' && (value <= -BIGINT_LIMIT || value >= BIGINT_LIMIT)) }
  }
  // Only arrays provide a finite slot range without enumerating the whole object.
  if (isProxy(value) || !isArray(value)) return unreadable()
  const keys = Array.from({ length: Math.min(ownDescriptor(value, 'length').value, MAX_PROPERTIES) }, (_value, index) => String(index))
  const properties = keys.map(key => {
    const descriptor = ownDescriptor(value, key)
    const text = descriptor === undefined ? '[empty]'
      : Object.hasOwn(descriptor, 'value') ? primitiveText(descriptor.value) : '[accessor: unreadable]'
    return `${stringify(key)}: ${text}`
  })
  const text = `array { ${properties.join(', ')} }`
  // Uninspected own properties remain unknown even when all indexed slots fit.
  return { status: 'readable', text: text.slice(0, MAX_TEXT), truncated: true }
}

/** Probe the actual evaluator without consulting a Node version or any session value. */
export async function supportsAwaitLexicals(context, evaluate) {
  const prefix = `__ptc_observation_${randomUUID().replaceAll('-', '')}`
  const names = [`${prefix}_let`, `${prefix}_const`]
  try {
    await evaluate(`let ${names[0]} = await Promise.resolve(41); const ${names[1]} = 42;`)
    return names.every((name, index) => ownDescriptor(context, name) === undefined
      && runInContext(name, context, { timeout: 25 }) === index + 41)
  } catch {
    return false
  } finally {
    // Lexical probe names are private and never enter the binding inventory.
    for (const name of names) delete context[name]
  }
}

/** Successful programs prove storage; await lexical reads additionally require a runtime probe. */
export function createReplValueObserver(context, { awaitLexicals = false } = {}) {
  const lexicals = new Set()
  const globals = new Set()
  return {
    record(program) {
      try {
        const tree = parse(program, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true })
        let awaits = false
        walkAst(tree, node => {
          if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return SKIP_AST_CHILDREN
          if (node.type === 'AwaitExpression' || node.await === true) awaits = true
        })
        if (awaits && !awaitLexicals) return
        for (const statement of tree.body) {
          if (statement.type !== 'VariableDeclaration') continue
          for (const declaration of statement.declarations) {
            for (const binding of bindingNodes(declaration.id)) {
              (statement.kind === 'var' ? globals : lexicals).add(binding.name)
            }
          }
        }
      } catch {}
    },
    observe(names) {
      const at = now()
      const entries = names.slice(0, MAX_ENTRIES).map(name => {
        let preview = unreadable()
        try {
          if (lexicals.has(name)) {
            // Lexical storage shadows global properties, even while uninitialized.
            if (/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name) && now() - at < 100) {
              preview = previewBindingValue(runInContext(name, context, { timeout: 25, displayErrors: false }))
            }
          } else if (globals.has(name)) {
            const descriptor = ownDescriptor(context, name)
            if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
              preview = previewBindingValue(descriptor.value)
            }
          }
        } catch {}
        return { name, ...preview }
      })
      return { at, entries }
    },
  }
}
