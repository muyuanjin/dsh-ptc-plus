import { types } from 'node:util'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createContext, isContext, runInContext, runInThisContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { runtimeIntrinsics as internal } from './runtime-intrinsics.js'
import { deleteWorkerRealmProperty, WORKER_REALM_MUTATION } from './worker-realm-surfaces.js'

const MAX_ENTRIES = 128
const MAX_TEXT = 512
const MAX_PROPERTIES = 5
const isProxy = types.isProxy
const now = Date.now
const BIGINT_LIMIT = 10n ** 128n
const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u
const AST_METADATA_KEYS = new internal.Set(['start', 'end', 'loc', 'range'])
const {
  Set: PrivateSet,
  appendArray,
  bigintToString,
  isArray,
  jsonStringify,
  min,
  objectCreate,
  objectGetOwnPropertyDescriptor: ownDescriptor,
  objectHasOwn,
  objectIs,
  objectKeys,
  regexpTest,
  replaceAllString,
  setAdd,
  setHas,
  sliceString,
  toString,
} = internal
const unreadable = () => ({ status: 'unreadable', text: '', truncated: false })
const runInRealm = (source, context, options) => isContext(context)
  ? runInContext(source, context, options)
  : runInThisContext(source, options)

function createPrivateParser() {
  const require = createRequire(import.meta.url)
  const exports = objectCreate(null)
  const module = objectCreate(null)
  module.exports = exports
  const context = createContext({ exports, module })
  runInContext(readFileSync(require.resolve('acorn'), 'utf8'), context,
    { filename: require.resolve('acorn') })
  return module.exports.parse
}

const parse = createPrivateParser()

function parseProgram(program) {
  const options = objectCreate(null)
  options.ecmaVersion = 'latest'
  options.allowAwaitOutsideFunction = true
  return parse(program, options)
}

function containsAwait(node) {
  if (node === null || typeof node !== 'object') return false
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression') return false
  if (node.type === 'AwaitExpression' || node.await === true) return true
  const keys = objectKeys(node)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (setHas(AST_METADATA_KEYS, key)) continue
    const value = node[key]
    if (isArray(value)) {
      for (let child = 0; child < value.length; child += 1) {
        if (containsAwait(value[child])) return true
      }
    } else if (containsAwait(value)) return true
  }
  return false
}

function recordBindingNames(pattern, names) {
  if (pattern === null || typeof pattern !== 'object') return
  if (pattern.type === 'Identifier') {
    setAdd(names, pattern.name)
    return
  }
  if (pattern.type === 'RestElement') return recordBindingNames(pattern.argument, names)
  if (pattern.type === 'AssignmentPattern') return recordBindingNames(pattern.left, names)
  if (pattern.type === 'ArrayPattern') {
    for (let index = 0; index < pattern.elements.length; index += 1) {
      recordBindingNames(pattern.elements[index], names)
    }
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (let index = 0; index < pattern.properties.length; index += 1) {
      const property = pattern.properties[index]
      recordBindingNames(property.type === 'RestElement' ? property.argument : property.value, names)
    }
  }
}

function primitiveText(value) {
  if (typeof value === 'string') return jsonStringify(sliceString(value, 0, MAX_TEXT))
  if (typeof value === 'bigint') return value > -BIGINT_LIMIT && value < BIGINT_LIMIT
    ? `${bigintToString(value)}n` : '[bigint: more than 128 digits]'
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}: unreadable]`
  if (value === null) return 'null'
  if (typeof value === 'object') return isProxy(value) ? '[proxy: unreadable]' : '[object]'
  return objectIs(value, -0) ? '-0' : toString(value)
}

/** Inspect own descriptors only, rejecting proxies before any reflective operation. */
export function previewBindingValue(value) {
  if (typeof value === 'function' || typeof value === 'symbol') return unreadable()
  if (value === null || typeof value !== 'object') {
    const text = primitiveText(value)
    return { status: 'readable', text: sliceString(text, 0, MAX_TEXT), truncated: text.length > MAX_TEXT
      || (typeof value === 'bigint' && (value <= -BIGINT_LIMIT || value >= BIGINT_LIMIT)) }
  }
  // Only arrays provide a finite slot range without enumerating the whole object.
  if (isProxy(value) || !isArray(value)) return unreadable()
  const keys = []
  const length = min(ownDescriptor(value, 'length').value, MAX_PROPERTIES)
  for (let index = 0; index < length; index += 1) appendArray(keys, toString(index))
  const properties = []
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const descriptor = ownDescriptor(value, key)
    const text = descriptor === undefined ? '[empty]'
      : objectHasOwn(descriptor, 'value') ? primitiveText(descriptor.value) : '[accessor: unreadable]'
    appendArray(properties, `${jsonStringify(key)}: ${text}`)
  }
  let text = 'array { '
  for (let index = 0; index < properties.length; index += 1) {
    if (index > 0) text += ', '
    text += properties[index]
  }
  text += ' }'
  // Uninspected own properties remain unknown even when all indexed slots fit.
  return { status: 'readable', text: sliceString(text, 0, MAX_TEXT), truncated: true }
}

/** Probe the actual evaluator without consulting a Node version or any session value. */
export async function supportsAwaitLexicals(context, evaluate) {
  const prefix = `__ptc_observation_${replaceAllString(randomUUID(), '-', '')}`
  const names = [`${prefix}_let`, `${prefix}_const`]
  try {
    await evaluate(`let ${names[0]} = await Promise.resolve(41); const ${names[1]} = 42;`)
    for (let index = 0; index < names.length; index += 1) {
      if (ownDescriptor(context, names[index]) !== undefined
        || runInRealm(names[index], context, { timeout: 25 }) !== index + 41) return false
    }
    return true
  } catch {
    return false
  } finally {
    // Lexical probe names are private and never enter the binding inventory.
    for (let index = 0; index < names.length; index += 1) {
      deleteWorkerRealmProperty(
        WORKER_REALM_MUTATION.RESTORE,
        'await lexical probe',
        context,
        names[index],
      )
    }
  }
}

/** Successful programs prove storage; await lexical reads additionally require a runtime probe. */
export function createReplValueObserver(context, { awaitLexicals = false } = {}) {
  const lexicals = new PrivateSet()
  const globals = new PrivateSet()
  return {
    record(program) {
      try {
        const tree = parseProgram(program)
        if (containsAwait(tree) && !awaitLexicals) return
        for (let statementIndex = 0; statementIndex < tree.body.length; statementIndex += 1) {
          const statement = tree.body[statementIndex]
          if (statement.type !== 'VariableDeclaration') continue
          const names = statement.kind === 'var' ? globals : lexicals
          for (let index = 0; index < statement.declarations.length; index += 1) {
            recordBindingNames(statement.declarations[index].id, names)
          }
        }
      } catch {}
    },
    observe(names) {
      const at = now()
      const entries = []
      const length = min(names.length, MAX_ENTRIES)
      for (let index = 0; index < length; index += 1) {
        const name = names[index]
        let preview = unreadable()
        try {
          if (setHas(lexicals, name)) {
            // Lexical storage shadows global properties, even while uninitialized.
            if (regexpTest(IDENTIFIER, name) && now() - at < 100) {
              preview = previewBindingValue(runInRealm(name, context, { timeout: 25, displayErrors: false }))
            }
          } else if (setHas(globals, name)) {
            const descriptor = ownDescriptor(context, name)
            if (descriptor !== undefined && objectHasOwn(descriptor, 'value')) {
              preview = previewBindingValue(descriptor.value)
            }
          }
        } catch {}
        appendArray(entries, { name, ...preview })
      }
      return { at, entries }
    },
  }
}
