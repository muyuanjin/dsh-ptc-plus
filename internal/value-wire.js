import { assertFields, isRecord } from './record-utils.js'
import {
  VALUE_CODEC,
  DEFAULT_VALUE_LIMITS,
  VALUE_ENVELOPE_FIELDS as ENVELOPE_FIELDS,
  VALUE_OBJECT_FIELDS as OBJECT_NODE_FIELDS,
  VALUE_ARRAY_FIELDS as ARRAY_NODE_FIELDS,
  VALUE_UNDEFINED_FIELDS as UNDEFINED_FIELDS,
  VALUE_NUMBER_FIELDS as NUMBER_FIELDS,
  VALUE_BIGINT_FIELDS as BIGINT_FIELDS,
  VALUE_REFERENCE_FIELDS as REFERENCE_FIELDS,
} from './value-wire-schema.js'

export { VALUE_CODEC, DEFAULT_VALUE_LIMITS } from './value-wire-schema.js'
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function limitsOf(options = {}) {
  const limits = { ...DEFAULT_VALUE_LIMITS, ...options }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid PTC value limit ${name}`)
  }
  return limits
}

function hasIntrinsicConstructor(prototype, name) {
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

function isIntrinsicObjectPrototype(value) {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

function plainObjectPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null) return 'null'
  if (typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype)) return 'object'
  return undefined
}

function hasPlainArrayPrototype(value) {
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype = Object.getPrototypeOf(prototype)
  return objectPrototype !== null && typeof objectPrototype === 'object'
    && isIntrinsicObjectPrototype(objectPrototype)
}

function invalid(path, detail) {
  throw new TypeError(`value at ${path} is not PTC Value V1: ${detail}`)
}

function stringBytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

/** Encode one supported JavaScript graph into the project-owned JSON-safe wire. */
export function encodeValue(value, options = {}) {
  const limits = limitsOf(options)
  const seen = new WeakMap()
  const pending = []
  const nodes = []
  let edgeCount = 0
  let textBytes = 0

  const accountText = (text, path) => {
    textBytes += stringBytes(text)
    if (textBytes > limits.maxStringBytes) invalid(path, `string budget exceeds ${limits.maxStringBytes} bytes`)
  }

  const atom = (current, path) => {
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') {
      accountText(current, path)
      return current
    }
    if (typeof current === 'number') {
      if (Number.isNaN(current)) return { tag: 'number', value: 'nan' }
      if (current === Infinity) return { tag: 'number', value: 'infinity' }
      if (current === -Infinity) return { tag: 'number', value: '-infinity' }
      if (Object.is(current, -0)) return { tag: 'number', value: '-0' }
      return current
    }
    if (current === undefined) return { tag: 'undefined' }
    if (typeof current === 'bigint') {
      const text = String(current)
      const digits = text[0] === '-' ? text.length - 1 : text.length
      if (digits > limits.maxBigIntDigits) invalid(path, `BigInt exceeds ${limits.maxBigIntDigits} digits`)
      accountText(text, path)
      return { tag: 'bigint', value: text }
    }
    if (typeof current !== 'object') invalid(path, typeof current)
    const prior = seen.get(current)
    if (prior !== undefined) return { tag: 'reference', index: prior }
    if (nodes.length >= limits.maxNodes) invalid(path, `node budget exceeds ${limits.maxNodes}`)
    const index = nodes.length
    seen.set(current, index)
    nodes.push(undefined)
    pending.push({ value: current, index, path })
    return { tag: 'reference', index }
  }

  const root = atom(value, '$')
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const item = pending[cursor]
    const current = item.value
    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) invalid(item.path, 'non-plain array')
      if (current.length > limits.maxArrayLength) invalid(item.path, `array length exceeds ${limits.maxArrayLength}`)
      const entries = []
      for (const key of Reflect.ownKeys(current)) {
        if (key === 'length') continue
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
          invalid(item.path, 'array has a symbol or non-index property')
        }
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index >= current.length) invalid(`${item.path}[${key}]`, 'invalid array index')
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          invalid(`${item.path}[${key}]`, 'array index must be an enumerable data property')
        }
        edgeCount += 1
        if (edgeCount > limits.maxEdges) invalid(item.path, `edge budget exceeds ${limits.maxEdges}`)
        entries.push([index, atom(descriptor.value, `${item.path}[${key}]`)])
      }
      nodes[item.index] = { type: 'array', length: current.length, entries }
      continue
    }

    const prototype = plainObjectPrototype(current)
    if (prototype === undefined) invalid(item.path, 'non-plain object')
    const entries = []
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') invalid(item.path, 'object has a symbol key')
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        invalid(`${item.path}.${key}`, 'object property must be an enumerable data property')
      }
      accountText(key, `${item.path}.${key}`)
      edgeCount += 1
      if (edgeCount > limits.maxEdges) invalid(item.path, `edge budget exceeds ${limits.maxEdges}`)
      entries.push([key, atom(descriptor.value, `${item.path}.${key}`)])
    }
    nodes[item.index] = { type: 'object', prototype, entries }
  }
  return { codec: VALUE_CODEC, root, nodes }
}

function decodeAtom(atom, nodes, limits, budget, path) {
  if (atom === null || typeof atom === 'boolean') return atom
  if (typeof atom === 'string') {
    budget.textBytes += stringBytes(atom)
    if (budget.textBytes > limits.maxStringBytes) throw new TypeError('PTC value string budget exceeded')
    return atom
  }
  if (typeof atom === 'number') {
    if (!Number.isFinite(atom) || Object.is(atom, -0)) throw new TypeError(`invalid PTC value number at ${path}`)
    return atom
  }
  if (!isRecord(atom) || typeof atom.tag !== 'string') throw new TypeError(`invalid PTC value atom at ${path}`)
  if (atom.tag === 'undefined') {
    assertFields(atom, UNDEFINED_FIELDS, 'PTC undefined atom')
    return undefined
  }
  if (atom.tag === 'number') {
    assertFields(atom, NUMBER_FIELDS, 'PTC number atom')
    if (atom.value === 'nan') return NaN
    if (atom.value === 'infinity') return Infinity
    if (atom.value === '-infinity') return -Infinity
    if (atom.value === '-0') return -0
    throw new TypeError('invalid PTC special number')
  }
  if (atom.tag === 'bigint') {
    assertFields(atom, BIGINT_FIELDS, 'PTC BigInt atom')
    if (typeof atom.value !== 'string' || !/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(atom.value)) {
      throw new TypeError('invalid PTC BigInt')
    }
    const digits = atom.value[0] === '-' ? atom.value.length - 1 : atom.value.length
    if (digits > limits.maxBigIntDigits) throw new TypeError('PTC BigInt digit budget exceeded')
    budget.textBytes += stringBytes(atom.value)
    if (budget.textBytes > limits.maxStringBytes) throw new TypeError('PTC value string budget exceeded')
    return BigInt(atom.value)
  }
  if (atom.tag === 'reference') {
    assertFields(atom, REFERENCE_FIELDS, 'PTC reference atom')
    if (!Number.isSafeInteger(atom.index) || atom.index < 0 || atom.index >= nodes.length) {
      throw new TypeError('dangling PTC value reference')
    }
    budget.reachable.add(atom.index)
    return nodes[atom.index]
  }
  throw new TypeError(`unknown PTC value atom tag ${JSON.stringify(atom.tag)}`)
}

/** Validate, hydrate, and own one canonical PTC value envelope without recursive stack growth. */
function decodeCanonicalValue(wire, options = {}) {
  const limits = limitsOf(options)
  assertFields(wire, ENVELOPE_FIELDS, 'PTC value envelope')
  if (wire.codec !== VALUE_CODEC || !Array.isArray(wire.nodes)) throw new TypeError('invalid PTC value codec')
  if (wire.nodes.length > limits.maxNodes) throw new TypeError('PTC value node budget exceeded')
  const targets = new Array(wire.nodes.length)
  for (let index = 0; index < wire.nodes.length; index += 1) {
    const node = wire.nodes[index]
    if (!isRecord(node)) throw new TypeError(`invalid PTC value node ${index}`)
    if (node.type === 'array') {
      assertFields(node, ARRAY_NODE_FIELDS, `PTC array node ${index}`)
      if (!Number.isSafeInteger(node.length) || node.length < 0 || node.length > limits.maxArrayLength) {
        throw new TypeError(`invalid PTC array length at node ${index}`)
      }
      if (!Array.isArray(node.entries)) throw new TypeError(`invalid PTC array entries at node ${index}`)
      targets[index] = new Array(node.length)
    } else if (node.type === 'object') {
      assertFields(node, OBJECT_NODE_FIELDS, `PTC object node ${index}`)
      if (!['object', 'null'].includes(node.prototype) || !Array.isArray(node.entries)) {
        throw new TypeError(`invalid PTC object node ${index}`)
      }
      targets[index] = node.prototype === 'null' ? Object.create(null) : {}
    } else {
      throw new TypeError(`unknown PTC value node type at ${index}`)
    }
  }

  const budget = { edges: 0, textBytes: 0, reachable: new Set() }
  const root = decodeAtom(wire.root, targets, limits, budget, '$')
  for (let nodeIndex = 0; nodeIndex < wire.nodes.length; nodeIndex += 1) {
    const node = wire.nodes[nodeIndex]
    const target = targets[nodeIndex]
    if (node.type === 'array') {
      let previous = -1
      for (const entry of node.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0])
          || entry[0] <= previous || entry[0] < 0 || entry[0] >= node.length) {
          throw new TypeError(`invalid PTC array entry at node ${nodeIndex}`)
        }
        previous = entry[0]
        budget.edges += 1
        if (budget.edges > limits.maxEdges) throw new TypeError('PTC value edge budget exceeded')
        Object.defineProperty(target, entry[0], {
          value: decodeAtom(entry[1], targets, limits, budget, `$nodes[${nodeIndex}][${entry[0]}]`),
          enumerable: true, configurable: true, writable: true,
        })
      }
      continue
    }
    const keys = new Set()
    for (const entry of node.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0])) {
        throw new TypeError(`invalid PTC object entry at node ${nodeIndex}`)
      }
      keys.add(entry[0])
      budget.textBytes += stringBytes(entry[0])
      if (budget.textBytes > limits.maxStringBytes) throw new TypeError('PTC value string budget exceeded')
      budget.edges += 1
      if (budget.edges > limits.maxEdges) throw new TypeError('PTC value edge budget exceeded')
      Object.defineProperty(target, entry[0], {
        value: decodeAtom(entry[1], targets, limits, budget, `$nodes[${nodeIndex}].${entry[0]}`),
        enumerable: true, configurable: true, writable: true,
      })
    }
  }
  if (budget.reachable.size !== wire.nodes.length) throw new TypeError('PTC value envelope contains unreachable nodes')
  const canonical = encodeValue(root, limits)
  const serialization = JSON.stringify(canonical)
  if (serialization !== JSON.stringify(wire)) throw new TypeError('non-canonical PTC value envelope')
  return { value: root, wire: canonical, serialization }
}

/** Validate and hydrate one canonical PTC value envelope without recursive stack growth. */
export function decodeValue(wire, options = {}) {
  return decodeCanonicalValue(wire, options).value
}

export function normalizeValueWire(wire, options = {}) {
  return decodeCanonicalValue(wire, options).wire
}

export function valueWiresEqual(left, right, options = {}) {
  try {
    return decodeCanonicalValue(left, options).serialization
      === decodeCanonicalValue(right, options).serialization
  } catch {
    return false
  }
}

/** True only when the outer structured-result projection preserves the complete value semantics. */
export function isPlainJsonTree(value) {
  const pending = [value]
  const seen = new WeakSet()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number' && Number.isFinite(current) && !Object.is(current, -0)) continue
    if (typeof current !== 'object') return false
    if (seen.has(current)) return false
    seen.add(current)
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) return false
        pending.push(current[index])
      }
    } else {
      for (const key of Object.keys(current)) pending.push(current[key])
    }
  }
  return true
}

function renderKey(key) {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key)
}

function atomText(atom) {
  if (atom === null || typeof atom === 'boolean' || typeof atom === 'number') return String(atom)
  if (typeof atom === 'string') return JSON.stringify(atom)
  if (atom.tag === 'undefined') return 'undefined'
  if (atom.tag === 'number') {
    return atom.value === 'nan' ? 'NaN'
      : atom.value === 'infinity' ? 'Infinity'
        : atom.value === '-infinity' ? '-Infinity' : '-0'
  }
  if (atom.tag === 'bigint') return `${atom.value}n`
  return undefined
}

/** Deterministic bounded TS-like presentation. It is never a decode format. */
export function renderValueWire(wire, options = {}) {
  const limits = limitsOf(options)
  return renderCanonicalValue(decodeCanonicalValue(wire, limits).wire, limits)
}

function renderCanonicalValue(normalized, limits) {
  const references = new Array(normalized.nodes.length).fill(0)
  const count = (atom) => {
    if (isRecord(atom) && atom.tag === 'reference') references[atom.index] += 1
  }
  count(normalized.root)
  for (const node of normalized.nodes) for (const entry of node.entries) count(entry[1])
  const labels = new Map()
  let nextLabel = 0
  for (let index = 0; index < references.length; index += 1) {
    if (references[index] > 1) labels.set(index, ++nextLabel)
  }

  const chunks = []
  let bytes = 0
  const append = (text) => {
    bytes += stringBytes(text)
    if (bytes > limits.maxStringBytes) throw new TypeError(`rendered PTC value exceeds ${limits.maxStringBytes} bytes`)
    chunks.push(text)
  }
  const emitted = new Set()
  const active = new Set()
  const tasks = [{ kind: 'atom', atom: normalized.root }]
  while (tasks.length > 0) {
    const task = tasks.pop()
    if (task.kind === 'text') {
      append(task.text)
      continue
    }
    if (task.kind === 'leave') {
      active.delete(task.index)
      continue
    }
    const primitive = atomText(task.atom)
    if (primitive !== undefined) {
      append(primitive)
      continue
    }
    const index = task.atom.index
    const label = labels.get(index)
    if (emitted.has(index)) {
      append(active.has(index) ? `[Circular *${label}]` : `[Reference *${label}]`)
      continue
    }
    emitted.add(index)
    active.add(index)
    if (label !== undefined) append(`<ref *${label}> `)
    const node = normalized.nodes[index]
    tasks.push({ kind: 'leave', index })
    if (node.type === 'array') {
      append('[')
      tasks.push({ kind: 'text', text: ']' })
      const entries = new Map(node.entries)
      if (node.length > 0 && !entries.has(node.length - 1)) tasks.push({ kind: 'text', text: ',' })
      for (let item = node.length - 1; item >= 0; item -= 1) {
        if (item < node.length - 1) tasks.push({ kind: 'text', text: ', ' })
        const value = entries.get(item)
        if (value !== undefined) tasks.push({ kind: 'atom', atom: value })
      }
      continue
    }
    append('{')
    tasks.push({ kind: 'text', text: '}' })
    for (let entryIndex = node.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const [key, value] = node.entries[entryIndex]
      if (entryIndex < node.entries.length - 1) tasks.push({ kind: 'text', text: ', ' })
      tasks.push({ kind: 'atom', atom: value })
      tasks.push({ kind: 'text', text: `${renderKey(key)}: ` })
    }
  }
  return chunks.join('')
}

/**
 * Return a lossless outer value: plain JSON values stay structured; richer values become rendered
 * text. The untagged ranges overlap because a plain JSON root may itself be a string.
 */
export function projectValueWire(wire, options = {}) {
  return prepareValueWire(wire, options).projectedValue
}

/** Validate once when canonical storage and outer presentation are both required. */
export function prepareValueWire(wire, options = {}) {
  const limits = limitsOf(options)
  const canonical = decodeCanonicalValue(wire, limits)
  return {
    wire: canonical.wire,
    projectedValue: isPlainJsonTree(canonical.value)
      ? canonical.value
      : renderCanonicalValue(canonical.wire, limits),
  }
}
