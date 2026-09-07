import { types } from 'node:util'
import { runInContext } from 'node:vm'
import { parse } from 'acorn'
import { walkAst } from './ast-traversal.js'
import { bindingNodes } from './binding-pattern.js'

const MAX_ENTRIES = 128
const MAX_TEXT = 512
const MAX_PROPERTIES = 5
const ownDescriptor = Object.getOwnPropertyDescriptor
const isArray = Array.isArray
const isProxy = types.isProxy
const stringify = JSON.stringify
const now = Date.now
const unreadable = () => ({ status: 'unreadable', text: '', truncated: false })

function primitiveText(value) {
  if (typeof value === 'string') return stringify(value.slice(0, MAX_TEXT))
  if (typeof value === 'bigint') return '[bigint: unreadable]'
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}: unreadable]`
  if (value === null) return 'null'
  if (typeof value === 'object') return isProxy(value) ? '[proxy: unreadable]' : '[object]'
  return Object.is(value, -0) ? '-0' : String(value)
}

/** Inspect own descriptors only, rejecting proxies before any reflective operation. */
export function previewBindingValue(value) {
  if (['function', 'symbol', 'bigint'].includes(typeof value)) return unreadable()
  if (value === null || typeof value !== 'object') {
    const text = primitiveText(value)
    return { status: 'readable', text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT }
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
  return { status: 'readable', text: `array { ${properties.join(', ')} }`.slice(0, MAX_TEXT), truncated: true }
}

/** A successful, non-await REPL program proves its lexical declarations exist, including TDZs. */
export function createReplValueObserver(context) {
  const lexicals = new Set()
  const globals = new Set()
  return {
    record(program) {
      try {
        const tree = parse(program, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true })
        let awaits = false
        walkAst(tree, node => { if (node.type === 'AwaitExpression' || node.await === true) awaits = true })
        // Node's REPL may lower await declarations into global properties. Do not infer lexical storage.
        if (awaits) return
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
