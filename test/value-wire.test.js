import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  VALUE_CODEC,
  decodeValue,
  encodeValue,
  isPlainJsonTree,
  normalizeValueWire,
  prepareValueWire,
  projectValueWire,
  renderValueWire,
  valueWiresEqual,
} from '../internal/value-wire.js'
import { valueLimitsFromConfig } from '../internal/value-wire-schema.js'

const ref = index => ({ tag: 'reference', index })

const envelope = (root, nodes = []) => ({ codec: VALUE_CODEC, root, nodes })

test('maps non-default runtime budgets without substituting codec defaults', () => {
  const config = {
    maxValueNodes: 7,
    maxValueEdges: 11,
    maxValueArrayLength: 13,
    maxValueBigIntDigits: 17,
    maxOutputBytes: 19,
  }
  assert.deepEqual(valueLimitsFromConfig(config), {
    maxNodes: 7, maxEdges: 11, maxArrayLength: 13, maxBigIntDigits: 17, maxStringBytes: 19,
  })
  assert.throws(() => prepareValueWire(encodeValue('x'.repeat(20)), valueLimitsFromConfig(config)), /string budget/)
})

test('prepares owned canonical storage and rich presentation in a single validation', () => {
  const shared = { value: 7 }
  const source = encodeValue([shared, shared])
  let rootReads = 0
  const input = { ...source }
  Object.defineProperty(input, 'root', {
    enumerable: true,
    get() { rootReads += 1; return source.root },
  })
  const prepared = prepareValueWire(input)
  assert.deepEqual(prepared.wire, source)
  assert.equal(prepared.projectedValue, '[<ref *1> {value: 7}, [Reference *1]]')
  // Decode and canonical serialization each read the input root once.
  assert.equal(rootReads, 2)
  source.nodes[1].entries[0][1] = 99
  assert.equal(decodeValue(prepared.wire)[0].value, 7)

  const plain = prepareValueWire(encodeValue({ nested: [1, 2] }))
  plain.projectedValue.nested[0] = 3
  assert.deepEqual(decodeValue(plain.wire), { nested: [1, 2] })
  for (const read of [decodeValue, normalizeValueWire, renderValueWire, projectValueWire, prepareValueWire]) {
    assert.throws(() => read({ ...prepared.wire, extra: true }), /invalid PTC value envelope field extra/)
  }
})

function expectInvalidWire(wire, pattern) {
  assert.throws(
    () => decodeValue(wire),
    error => error instanceof TypeError && (pattern === undefined || pattern.test(error.message)),
  )
}

function pseudoRandom(seed) {
  let state = seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function generatedGraph(seed) {
  const random = pseudoRandom(seed)
  const nodes = Array.from({ length: 4 + Math.floor(random() * 12) }, (_, index) => (
    index % 3 === 0 ? new Array(Math.floor(random() * 8)) : index % 4 === 0 ? Object.create(null) : {}
  ))
  const atoms = [null, true, false, '', 'ascii', '\u4e2d\ud83d\ude42', 0, 1.25, -31, undefined, NaN, Infinity, -Infinity, -0, 0n, -123456789n]
  const nextValue = () => random() < 0.45
    ? atoms[Math.floor(random() * atoms.length)]
    : nodes[Math.floor(random() * nodes.length)]
  const keys = ['a', 'two words', '__proto__', '0', 'quote"key', '\u4e2d']

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        if (random() < 0.65) node[index] = nextValue()
      }
      continue
    }
    const entryCount = 1 + Math.floor(random() * keys.length)
    for (let keyIndex = 0; keyIndex < entryCount; keyIndex += 1) {
      const key = `${keys[keyIndex]}${nodeIndex % 2 ? '' : nodeIndex}`
      Object.defineProperty(node, key, {
        value: nextValue(), enumerable: true, configurable: true, writable: true,
      })
    }
  }
  return nodes[0]
}

test('encodes every primitive atom and decodes it without JSON loss', () => {
  const values = [null, true, false, 'text', 0, 1.5, undefined, NaN, Infinity, -Infinity, -0, 123456789012345678901234567890n]
  for (const value of values) {
    const wire = encodeValue(value)
    assert.equal(wire.codec, VALUE_CODEC)
    assert.deepEqual(decodeValue(JSON.parse(JSON.stringify(wire))), value)
  }
  assert.deepEqual(encodeValue(NaN).root, { tag: 'number', value: 'nan' })
  assert.deepEqual(encodeValue(-0).root, { tag: 'number', value: '-0' })
  assert.deepEqual(encodeValue(12n).root, { tag: 'bigint', value: '12' })
})

test('uses the exact canonical atom spelling for every non-JSON primitive', () => {
  const cases = [
    [undefined, { tag: 'undefined' }],
    [NaN, { tag: 'number', value: 'nan' }],
    [Infinity, { tag: 'number', value: 'infinity' }],
    [-Infinity, { tag: 'number', value: '-infinity' }],
    [-0, { tag: 'number', value: '-0' }],
    [0n, { tag: 'bigint', value: '0' }],
    [-1n, { tag: 'bigint', value: '-1' }],
  ]
  for (const [value, atom] of cases) {
    assert.deepEqual(encodeValue(value), envelope(atom))
    assert.deepEqual(decodeValue(envelope(atom)), value)
  }
})

test('accepts genuine cross-realm plain objects and arrays', () => {
  const foreign = runInNewContext(`(() => {
    const shared = { value: 1 }
    const array = [shared, , shared]
    return { array, shared }
  })()`)
  const restored = decodeValue(encodeValue(foreign))
  assert.equal(Array.isArray(restored.array), true)
  assert.equal(1 in restored.array, false)
  assert.equal(restored.array[0], restored.shared)
  assert.equal(restored.array[2], restored.shared)
})

test('rejects spoofed intrinsic prototypes and survives hostile constructor metadata', () => {
  const fakeObjectPrototype = Object.create(null)
  fakeObjectPrototype.constructor = function Object() {}
  assert.throws(() => encodeValue(Object.create(fakeObjectPrototype)), /non-plain object/)

  const throwingConstructor = new Proxy(function Object() {}, {
    get(target, property, receiver) {
      if (property === 'name') throw new Error('hostile name')
      return Reflect.get(target, property, receiver)
    },
  })
  const hostilePrototype = Object.create(null)
  hostilePrototype.constructor = throwingConstructor
  assert.throws(() => encodeValue(Object.create(hostilePrototype)), /non-plain object/)

  const nullPrototypeArray = []
  Object.setPrototypeOf(nullPrototypeArray, null)
  assert.throws(() => encodeValue(nullPrototypeArray), /non-plain array/)

  const arrayPrototypeArray = []
  Object.setPrototypeOf(arrayPrototypeArray, [])
  assert.throws(() => encodeValue(arrayPrototypeArray), /non-plain array/)

  const detachedArrayPrototype = runInNewContext('[]')
  Object.setPrototypeOf(Object.getPrototypeOf(detachedArrayPrototype), Object.create(null))
  assert.throws(() => encodeValue(detachedArrayPrototype), /non-plain array/)
})

test('preserves graph identity, cycles, holes, null prototypes, and own __proto__', () => {
  const shared = { value: 7 }
  const sparse = new Array(4)
  sparse[1] = undefined
  const source = Object.create(null)
  Object.defineProperties(source, {
    first: { value: shared, enumerable: true, writable: true, configurable: true },
    second: { value: shared, enumerable: true, writable: true, configurable: true },
    sparse: { value: sparse, enumerable: true, writable: true, configurable: true },
  })
  Object.defineProperty(source, '__proto__', {
    value: shared, enumerable: true, writable: true, configurable: true,
  })
  source.self = source
  const wire = encodeValue(source)
  const output = decodeValue(wire)
  assert.equal(Object.getPrototypeOf(output), null)
  assert.equal(output.first, output.second)
  assert.equal(output.first, output.__proto__)
  assert.equal(output.self, output)
  assert.equal(0 in output.sparse, false)
  assert.equal(1 in output.sparse, true)
  assert.equal(2 in output.sparse, false)
  assert.deepEqual(encodeValue(output), wire)

  const ordinary = {}
  Object.defineProperty(ordinary, '__proto__', {
    value: { polluted: true }, enumerable: true, configurable: true, writable: true,
  })
  const decodedOrdinary = decodeValue(encodeValue(ordinary))
  assert.equal(Object.getPrototypeOf(decodedOrdinary), Object.prototype)
  assert.equal(Object.hasOwn(decodedOrdinary, '__proto__'), true)
  assert.deepEqual(decodedOrdinary.__proto__, { polluted: true })
  assert.equal(Object.prototype.polluted, undefined)
})

test('uses deterministic ECMAScript own-key order and normalizes descriptors', () => {
  const source = {}
  source.b = 2
  Object.defineProperty(source, 'a', { value: 1, enumerable: true })
  const wire = encodeValue(source)
  assert.deepEqual(wire.nodes[0].entries.map(entry => entry[0]), ['b', 'a'])
  const restored = decodeValue(wire)
  assert.deepEqual(Object.keys(restored), ['b', 'a'])
  assert.deepEqual(Object.getOwnPropertyDescriptor(restored, 'a'), {
    value: 1, enumerable: true, configurable: true, writable: true,
  })
})

test('rejects unsupported values and unsafe object shapes without invoking accessors', () => {
  let reads = 0
  const accessor = {}
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { reads += 1; return 1 } })
  assert.throws(() => encodeValue(accessor), /enumerable data property/)
  assert.equal(reads, 0)
  for (const value of [() => 1, Symbol('x'), new Date(), new Map(), new Set(), /x/, new Uint8Array(1), Promise.resolve(1)]) {
    assert.throws(() => encodeValue(value), /not PTC Value V1/)
  }
  const symbolKey = {}
  symbolKey[Symbol('x')] = 1
  assert.throws(() => encodeValue(symbolKey), /symbol key/)
  const extraArrayProperty = []
  Object.defineProperty(extraArrayProperty, 'extra', { value: 1, enumerable: true })
  assert.throws(() => encodeValue(extraArrayProperty), /non-index property/)
  const custom = Object.create({ inherited: true })
  custom.value = 1
  assert.throws(() => encodeValue(custom), /non-plain object/)
})

test('rejects every invalid own-property descriptor shape', () => {
  const hiddenObjectValue = {}
  Object.defineProperty(hiddenObjectValue, 'value', { value: 1, enumerable: false })
  assert.throws(() => encodeValue(hiddenObjectValue), /enumerable data property/)

  const hiddenArrayValue = [1]
  Object.defineProperty(hiddenArrayValue, '0', { enumerable: false })
  assert.throws(() => encodeValue(hiddenArrayValue), /enumerable data property/)

  const arrayAccessor = []
  Object.defineProperty(arrayAccessor, '0', {
    enumerable: true,
    configurable: true,
    get() { throw new Error('must not execute') },
  })
  assert.throws(() => encodeValue(arrayAccessor), /enumerable data property/)

  const missingObjectDescriptor = new Proxy({}, {
    ownKeys: () => ['ghost'],
    getOwnPropertyDescriptor: () => undefined,
  })
  assert.throws(() => encodeValue(missingObjectDescriptor), /enumerable data property/)

  const missingArrayDescriptor = new Proxy(new Array(1), {
    ownKeys: () => ['length', '0'],
    getOwnPropertyDescriptor(target, key) {
      return key === 'length' ? Reflect.getOwnPropertyDescriptor(target, key) : undefined
    },
  })
  assert.throws(() => encodeValue(missingArrayDescriptor), /enumerable data property/)
})

test('rejects hostile array key reports before reading values', () => {
  const beyondLength = new Proxy([], {
    ownKeys: () => ['length', '1'],
    getOwnPropertyDescriptor(target, key) {
      return key === 'length' ? Reflect.getOwnPropertyDescriptor(target, key) : {
        value: 1, enumerable: true, configurable: true, writable: true,
      }
    },
  })
  assert.throws(() => encodeValue(beyondLength), /invalid array index/)

  const unsafeIndex = new Proxy([], {
    ownKeys: () => ['length', '9007199254740992'],
    getOwnPropertyDescriptor(target, key) {
      return key === 'length' ? Reflect.getOwnPropertyDescriptor(target, key) : {
        value: 1, enumerable: true, configurable: true, writable: true,
      }
    },
  })
  assert.throws(() => encodeValue(unsafeIndex), /invalid array index/)

  const symbolIndex = []
  symbolIndex[Symbol('index')] = 1
  assert.throws(() => encodeValue(symbolIndex), /symbol or non-index property/)
})

test('enforces encode budgets and validates limit options', () => {
  assert.throws(() => encodeValue({ value: {} }, { maxNodes: 1 }), /node budget/)
  assert.throws(() => encodeValue([1, 2], { maxEdges: 1 }), /edge budget/)
  assert.throws(() => encodeValue({ a: 1, b: 2 }, { maxEdges: 1 }), /edge budget/)
  assert.throws(() => encodeValue(new Array(2), { maxArrayLength: 1 }), /array length/)
  assert.throws(() => encodeValue(12345n, { maxBigIntDigits: 4 }), /BigInt/)
  assert.throws(() => encodeValue('abcd', { maxStringBytes: 3 }), /string budget/)
  assert.doesNotThrow(() => encodeValue({ a: 'x' }, { maxNodes: 1, maxEdges: 1, maxStringBytes: 2 }))
  assert.doesNotThrow(() => encodeValue(1234n, { maxBigIntDigits: 4, maxStringBytes: 4 }))
  for (const options of [{ maxNodes: 0 }, { maxEdges: 1.2 }, { maxStringBytes: -1 }]) {
    assert.throws(() => encodeValue(null, options), /invalid PTC value limit/)
  }
})

test('bounds cumulative sparse-array allocation before hydration', () => {
  const source = { first: new Array(6), second: new Array(5) }
  assert.throws(() => encodeValue(source, { maxArrayLength: 10 }), /array slot budget/)
  assert.doesNotThrow(() => encodeValue(source, { maxArrayLength: 11 }))

  const wire = envelope(ref(0), [
    { type: 'object', prototype: 'object', entries: [['first', ref(1)], ['second', ref(2)]] },
    { type: 'array', length: 6, entries: [] },
    { type: 'array', length: 5, entries: [] },
  ])
  assert.throws(() => decodeValue(wire, { maxArrayLength: 10 }), /array slot budget/)
  assert.deepEqual(decodeValue(wire, { maxArrayLength: 11 }), source)

  const unreachable = envelope(ref(0), [
    { type: 'array', length: 10, entries: [] },
    { type: 'array', length: 1, entries: [] },
  ])
  assert.throws(() => decodeValue(unreachable, { maxArrayLength: 10 }), /array slot budget/)
  assert.throws(() => decodeValue(unreachable, { maxArrayLength: 11 }), /unreachable nodes/)

  const maximumPlatformLength = envelope(null, [
    { type: 'array', length: 0xffffffff, entries: [] },
  ])
  assert.throws(
    () => decodeValue(maximumPlatformLength, { maxArrayLength: Number.MAX_SAFE_INTEGER }),
    /unreachable nodes/,
  )
  const beyondPlatformLength = envelope(ref(0), [
    { type: 'array', length: 0x100000000, entries: [] },
  ])
  assert.throws(
    () => decodeValue(beyondPlatformLength, { maxArrayLength: Number.MAX_SAFE_INTEGER }),
    error => error instanceof TypeError && /invalid PTC array length/u.test(error.message),
  )

  const disconnectedSelfCycle = envelope(null, [
    { type: 'array', length: 100_000, entries: [[0, ref(0)]] },
  ])
  assert.throws(() => decodeValue(disconnectedSelfCycle, { maxArrayLength: 100_000 }), /unreachable nodes/)

  const disconnectedCycle = envelope(null, [
    { type: 'array', length: 1, entries: [[0, ref(1)]] },
    { type: 'array', length: 1, entries: [[0, ref(0)]] },
  ])
  assert.throws(() => decodeValue(disconnectedCycle, { maxArrayLength: 2 }), /unreachable nodes/)
})

test('counts UTF-8 key, string, and BigInt bytes cumulatively', () => {
  assert.doesNotThrow(() => encodeValue({ '\u4e2d': '\ud83d\ude42' }, { maxStringBytes: 7 }))
  assert.throws(() => encodeValue({ '\u4e2d': '\ud83d\ude42' }, { maxStringBytes: 6 }), /string budget/)
  assert.doesNotThrow(() => encodeValue({ a: 12n }, { maxStringBytes: 3 }))
  assert.throws(() => encodeValue({ a: 12n }, { maxStringBytes: 2 }), /string budget/)
})

test('enforces each decode budget at and immediately beyond its boundary', () => {
  const twoNodes = encodeValue({ child: {} })
  assert.doesNotThrow(() => decodeValue(twoNodes, { maxNodes: 2 }))
  assert.throws(() => decodeValue(twoNodes, { maxNodes: 1 }), /node budget/)

  const twoEdges = encodeValue([1, 2])
  assert.doesNotThrow(() => decodeValue(twoEdges, { maxEdges: 2 }))
  assert.throws(() => decodeValue(twoEdges, { maxEdges: 1 }), /edge budget/)

  const lengthTwo = encodeValue(new Array(2))
  assert.doesNotThrow(() => decodeValue(lengthTwo, { maxArrayLength: 2 }))
  assert.throws(() => decodeValue(lengthTwo, { maxArrayLength: 1 }), /array length/)

  const fourDigits = encodeValue(-1234n)
  assert.doesNotThrow(() => decodeValue(fourDigits, { maxBigIntDigits: 4, maxStringBytes: 5 }))
  assert.throws(() => decodeValue(fourDigits, { maxBigIntDigits: 3 }), /digit budget/)
  assert.throws(() => decodeValue(fourDigits, { maxBigIntDigits: 4, maxStringBytes: 4 }), /string budget/)

  const utf8 = encodeValue({ '\u4e2d': '\ud83d\ude42' })
  assert.doesNotThrow(() => decodeValue(utf8, { maxStringBytes: 7 }))
  assert.throws(() => decodeValue(utf8, { maxStringBytes: 6 }), /string budget/)
  assert.throws(() => decodeValue(encodeValue({ ab: null }), { maxStringBytes: 1 }), /string budget/)
})

test('rejects malformed, non-canonical, unreachable, and over-budget wires', () => {
  const valid = encodeValue({ a: 1 })
  const malformed = [
    { ...valid, extra: true },
    { ...valid, codec: 'other' },
    { ...valid, root: ref(3) },
    { codec: VALUE_CODEC, root: ref(0), nodes: [{ type: 'object', prototype: 'object', entries: [['a', 1], ['a', 2]] }] },
    { codec: VALUE_CODEC, root: ref(0), nodes: [{ type: 'object', prototype: 'object', entries: [] }, { type: 'object', prototype: 'object', entries: [] }] },
    { codec: VALUE_CODEC, root: ref(0), nodes: [{ type: 'array', length: 1, entries: [[0, 1], [0, 2]] }] },
    { codec: VALUE_CODEC, root: 1, nodes: [{ type: 'object', prototype: 'object', entries: [] }] },
    { codec: VALUE_CODEC, root: -0, nodes: [] },
    { codec: VALUE_CODEC, root: { tag: 'number', value: 'wat' }, nodes: [] },
    { codec: VALUE_CODEC, root: { tag: 'undefined', extra: true }, nodes: [] },
    { codec: VALUE_CODEC, root: { tag: 'bigint', value: '01' }, nodes: [] },
    { codec: VALUE_CODEC, root: Infinity, nodes: [] },
    { codec: VALUE_CODEC, root: ref(0), nodes: [{ type: 'array', length: 2, entries: [[1, 1], [0, 2]] }] },
    { codec: VALUE_CODEC, root: ref(0), nodes: [{ type: 'array', length: 1, entries: [[1, 1]] }] },
    { codec: VALUE_CODEC, root: { tag: 'reference', index: 0 }, nodes: [{ type: 'object', prototype: 'object', entries: [['__proto__', 1]], extra: true }] },
  ]
  for (const wire of malformed) assert.throws(() => decodeValue(wire))
  const hiddenCodec = encodeValue(null)
  Object.defineProperty(hiddenCodec, 'codec', { enumerable: false })
  assert.throws(() => decodeValue(hiddenCodec), /invalid PTC value envelope field codec/)
  const symbolField = encodeValue(null)
  symbolField[Symbol('extra')] = true
  assert.throws(() => decodeValue(symbolField), /invalid PTC value envelope field/)
  assert.throws(() => decodeValue(valid, { maxNodes: 0 }), /invalid PTC value limit/)
  assert.throws(() => decodeValue(encodeValue({ a: 1, b: 2 }), { maxEdges: 1 }), /edge budget/)
  assert.throws(() => decodeValue(encodeValue('abcd'), { maxStringBytes: 3 }), /string budget/)
  assert.throws(() => decodeValue(encodeValue(12345n), { maxBigIntDigits: 4 }), /digit budget/)
  assert.throws(() => decodeValue(encodeValue(new Array(2)), { maxArrayLength: 1 }), /array length/)
  assert.equal(Object.prototype.polluted, undefined)
})

test('rejects incomplete envelopes and malformed atom field sets', () => {
  for (const wire of [null, undefined, [], '', 1, {}, { codec: VALUE_CODEC }, { codec: VALUE_CODEC, root: null }]) {
    expectInvalidWire(wire, /invalid PTC value envelope/)
  }
  expectInvalidWire({ codec: VALUE_CODEC, root: null, nodes: {} }, /invalid PTC value codec/)

  const invalidAtoms = [
    [],
    {},
    { tag: 1 },
    { tag: 'undefined', value: 1 },
    { tag: 'number' },
    { tag: 'number', value: 'nan', extra: true },
    { tag: 'number', value: null },
    { tag: 'bigint' },
    { tag: 'bigint', value: 1 },
    { tag: 'bigint', value: '' },
    { tag: 'bigint', value: '-0' },
    { tag: 'bigint', value: '+1' },
    { tag: 'bigint', value: '1.0' },
    { tag: 'reference' },
    { tag: 'reference', index: -1 },
    { tag: 'reference', index: 0.5 },
    { tag: 'reference', index: Number.MAX_SAFE_INTEGER + 1 },
    { tag: 'reference', index: 0, extra: true },
    { tag: 'unknown' },
  ]
  for (const atom of invalidAtoms) expectInvalidWire(envelope(atom))

  for (const atom of [
    { tag: 'undefined' },
    { tag: 'number', value: 'nan' },
    { tag: 'bigint', value: '1' },
    { tag: 'reference', index: 0 },
  ]) {
    Object.defineProperty(atom, 'tag', { enumerable: false })
    expectInvalidWire(envelope(atom), /invalid PTC .* atom field tag/)
  }
})

test('rejects malformed node declarations before hydration', () => {
  const invalidNodes = [
    null,
    [],
    'node',
    {},
    { type: 'mystery' },
    { type: 'array', length: 0 },
    { type: 'array', length: 0, entries: [], extra: true },
    { type: 'array', length: -1, entries: [] },
    { type: 'array', length: 0.5, entries: [] },
    { type: 'array', length: Number.MAX_SAFE_INTEGER + 1, entries: [] },
    { type: 'array', length: 0, entries: {} },
    { type: 'object', prototype: 'object' },
    { type: 'object', prototype: 'array', entries: [] },
    { type: 'object', prototype: null, entries: [] },
    { type: 'object', prototype: 'object', entries: {} },
    { type: 'object', prototype: 'object', entries: [], extra: true },
  ]
  for (const node of invalidNodes) expectInvalidWire(envelope(ref(0), [node]))

  const hiddenType = { type: 'array', length: 0, entries: [] }
  Object.defineProperty(hiddenType, 'type', { enumerable: false })
  expectInvalidWire(envelope(ref(0), [hiddenType]), /invalid PTC array node 0 field type/)
})

test('rejects malformed array entries across tuple, index, order, and atom dimensions', () => {
  const badEntries = [
    [null],
    [[]],
    [[0]],
    [[0, null, true]],
    [['0', null]],
    [[0.5, null]],
    [[-1, null]],
    [[2, null]],
    [[1, null], [0, null]],
    [[0, null], [0, null]],
    [[0, { tag: 'unknown' }]],
  ]
  for (const entries of badEntries) {
    expectInvalidWire(envelope(ref(0), [{ type: 'array', length: 2, entries }]))
  }
})

test('rejects malformed object entries and non-canonical object ordering', () => {
  const badEntries = [
    [null],
    [[]],
    [['a']],
    [['a', null, true]],
    [[1, null]],
    [['a', null], ['a', true]],
    [['a', { tag: 'unknown' }]],
  ]
  for (const entries of badEntries) {
    expectInvalidWire(envelope(ref(0), [{ type: 'object', prototype: 'object', entries }]))
  }
  expectInvalidWire(envelope(ref(0), [{
    type: 'object', prototype: 'object', entries: [['2', 2], ['1', 1]],
  }]), /non-canonical/)
})

test('rejects non-canonical graph discovery order even when every node is reachable', () => {
  const wire = envelope(ref(0), [
    { type: 'object', prototype: 'object', entries: [['left', ref(2)], ['right', ref(1)]] },
    { type: 'object', prototype: 'object', entries: [['name', 'right']] },
    { type: 'object', prototype: 'object', entries: [['name', 'left']] },
  ])
  expectInvalidWire(wire, /non-canonical/)
})

test('normalizes and compares only canonical semantic graphs', () => {
  const wire = encodeValue({ x: -0, n: NaN })
  assert.deepEqual(normalizeValueWire(wire), wire)
  assert.equal(valueWiresEqual(wire, structuredClone(wire)), true)
  assert.equal(valueWiresEqual(encodeValue({ a: 1 }), encodeValue({ a: 2 })), false)
  assert.equal(valueWiresEqual(wire, { codec: 'bad', root: null, nodes: [] }), false)
  assert.equal(valueWiresEqual(wire, null), false)
})

test('renders and projects rich values with stable references and JSON fallback', () => {
  const shared = { value: 1 }
  const rich = encodeValue([shared, shared, undefined, NaN, -0, 2n, ,])
  assert.equal(renderValueWire(rich), '[<ref *1> {value: 1}, [Reference *1], undefined, NaN, -0, 2n, ,]')
  assert.deepEqual(projectValueWire(encodeValue({ a: [1, 'x'] })), { a: [1, 'x'] })
  assert.equal(typeof projectValueWire(rich), 'string')
  assert.equal(isPlainJsonTree({ a: [1, 'x', null] }), true)
  assert.equal(isPlainJsonTree([,]), false)
  assert.equal(isPlainJsonTree({ value: undefined }), false)
  assert.equal(isPlainJsonTree({ value: NaN }), false)
  assert.equal(isPlainJsonTree({ value: 1n }), false)
  const cycle = {}
  cycle.self = cycle
  assert.equal(isPlainJsonTree(cycle), false)
  const sharedJson = {}
  assert.equal(isPlainJsonTree([sharedJson, sharedJson]), false)
  assert.equal(isPlainJsonTree(null), true)
})

test('renders every atom, key style, cycle, reference, and sparse-array shape deterministically', () => {
  const atomCases = [
    [null, 'null'], [true, 'true'], [false, 'false'], [1.5, '1.5'], ['x', '"x"'],
    [undefined, 'undefined'], [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'],
    [-0, '-0'], [12n, '12n'],
  ]
  for (const [value, rendered] of atomCases) assert.equal(renderValueWire(encodeValue(value)), rendered)

  assert.equal(renderValueWire(encodeValue({ validKey: 1, 'two words': 2, 'quote"': 3 })),
    '{validKey: 1, "two words": 2, "quote\\\"": 3}')
  assert.equal(renderValueWire(encodeValue([])), '[]')
  assert.equal(renderValueWire(encodeValue(new Array(1))), '[,]')
  assert.equal(renderValueWire(encodeValue(new Array(2))), '[, ,]')
  assert.equal(renderValueWire(encodeValue([, 1, ,])), '[, 1, ,]')

  const cycle = { name: 'root' }
  cycle.self = cycle
  assert.equal(renderValueWire(encodeValue(cycle)), '<ref *1> {name: "root", self: [Circular *1]}')

  const shared = { x: 1 }
  assert.equal(renderValueWire(encodeValue({ first: shared, second: shared })),
    '{first: <ref *1> {x: 1}, second: [Reference *1]}')
})

test('applies a separate byte ceiling to rendered presentation', () => {
  const wire = encodeValue('x')
  assert.equal(renderValueWire(wire, { maxStringBytes: 3 }), '"x"')
  assert.throws(() => renderValueWire(wire, { maxStringBytes: 2 }), /rendered PTC value exceeds 2 bytes/)
})

test('projects exactly the JSON-safe subset and renders every richer graph', () => {
  const jsonCases = [null, true, 1, 'x', [], {}, [1, null, 'x'], { nested: { array: [1, 2] } }]
  for (const value of jsonCases) assert.deepEqual(projectValueWire(encodeValue(value)), value)
  assert.equal(typeof projectValueWire(encodeValue('x')), 'string')

  const shared = {}
  const cycle = {}
  cycle.self = cycle
  const richCases = [undefined, NaN, Infinity, -Infinity, -0, 1n, [,], [shared, shared], cycle]
  for (const value of richCases) assert.equal(typeof projectValueWire(encodeValue(value)), 'string')
})

test('round-trips a deterministic corpus of generated cyclic value graphs', () => {
  for (let seed = 1; seed <= 256; seed += 1) {
    const source = generatedGraph(seed)
    const wire = encodeValue(source)
    const persisted = JSON.parse(JSON.stringify(wire))
    const restored = decodeValue(persisted)
    assert.deepEqual(encodeValue(restored), wire, `round-trip mismatch for seed ${seed}`)
    assert.deepEqual(normalizeValueWire(persisted), wire, `normalization mismatch for seed ${seed}`)
    assert.equal(valueWiresEqual(wire, persisted), true, `equality mismatch for seed ${seed}`)
    assert.equal(renderValueWire(wire), renderValueWire(persisted), `render mismatch for seed ${seed}`)
  }
})

test('handles deeply nested graphs without recursive encode/decode/render calls', () => {
  let value = null
  for (let depth = 0; depth < 6000; depth += 1) value = [value]
  const wire = encodeValue(value)
  let restored = decodeValue(wire)
  for (let depth = 0; depth < 6000; depth += 1) restored = restored[0]
  assert.equal(restored, null)
  assert.equal(renderValueWire(encodeValue([value])), `[${renderValueWire(encodeValue(value))}]`)
})
