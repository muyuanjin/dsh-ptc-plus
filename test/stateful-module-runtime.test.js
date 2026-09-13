import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { managedModuleNamespace, readModuleImport, reserveStatefulModule,
  recordStatefulModuleResolution, recordStatefulModuleNamespace, managedRequire,
  managedModuleImport, moduleBindingIntrinsics } from '../internal/stateful-module-runtime.js'

import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { captureCompilerIntrinsics } from '../internal/compiler-intrinsics.js'
import { loadManagedSource } from './managed-module-fixture.js'

const reserve = (url, exports, stars = []) => reserveStatefulModule(url, { exports, stars })
const native = values => Object.preventExtensions(Object.defineProperties(Object.create(null), {
  ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name,
    { value, enumerable: true, configurable: false, writable: true }])),
  [Symbol.toStringTag]: { value: 'Module' },
}))

test('loader metadata decodes exact values and live descriptors without probing function shapes', () => {
  const original = function __dsh_ptc_local_binding_0__() { return { v: 'ordinary function' } }
  const first = { value: 1 }
  let value = first
  const raw = native({ fn: original, live: () => ({ get v() { return value } }) })
  reserve('reflection:source', [{ name: 'live', kind: 'accessor' }, { name: 'fn', kind: 'native' }])
  const namespace = managedModuleNamespace('reflection:source', raw)
  assert.equal(namespace, managedModuleNamespace('reflection:source', raw))
  assert.equal(namespace, managedModuleNamespace('reflection:source', namespace))
  assert.equal(namespace.fn, original)
  const saved = namespace.live
  value = original
  assert.equal(namespace.live, original)
  assert.equal(saved, first)
  assert.deepEqual(Object.getOwnPropertyDescriptor(namespace, 'live'), {
    value: original, enumerable: true, writable: true, configurable: false,
  })
  assert.equal(Object.getPrototypeOf(namespace), null)
  assert.equal(Object.isExtensible(namespace), false)
  assert.equal(Object.isSealed(namespace), true)
  assert.equal(Object.isFrozen(namespace), false)
  assert.equal(Object.prototype.toString.call(namespace), '[object Module]')
  assert.deepEqual(Reflect.ownKeys(namespace), ['fn', 'live', Symbol.toStringTag])
  assert.equal(namespace.missing, undefined)
  assert.equal(Object.getOwnPropertyDescriptor(namespace, 'missing'), undefined)
  assert.equal(Reflect.set(namespace, 'live', 3), false)
  assert.equal(Reflect.set(namespace, 'new', 3), false)
  assert.equal(Reflect.deleteProperty(namespace, 'live'), false)
  assert.equal(Reflect.deleteProperty(namespace, 'missing'), true)
  assert.equal(Reflect.setPrototypeOf(namespace, null), true)
  assert.equal(Reflect.setPrototypeOf(namespace, {}), false)
  assert.equal(Reflect.preventExtensions(namespace), true)
  for (const descriptor of [{ value: 3 }, { writable: false }, { configurable: true },
    { enumerable: false }, { get() {} }, { set(_) {} }]) {
    assert.equal(Reflect.defineProperty(namespace, 'live', descriptor), false)
  }
  assert.equal(Reflect.defineProperty(namespace, 'new', { value: 1 }), false)
  assert.equal(Reflect.defineProperty(namespace, 'live', {}), true)
  assert.equal(Reflect.defineProperty(namespace, 'live', { value: original, writable: true }), true)
  assert.equal(Reflect.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' }), true)
  assert.equal(Reflect.defineProperty(namespace, Symbol.toStringTag, { value: 'Other' }), false)
  assert.throws(() => { namespace.live = 3 }, TypeError)
  assert.throws(() => Object.freeze(namespace), TypeError)
})

test('native source relations distinguish attributes, namespaces and unknown providers', () => {
  const raw = native({ value: () => ({ v: 1 }) })
  const other = native({ value: () => ({ v: 2 }) })
  for (const url of ['attributes:first', 'attributes:second']) reserve(url, [{ name: 'value', kind: 'accessor' }])
  recordStatefulModuleResolution('attributes:consumer', './value', { type: 'json', flavor: 'one' }, 'attributes:first')
  recordStatefulModuleResolution('attributes:consumer', './value', { flavor: 'two', type: 'json' }, 'attributes:second')
  assert.equal(readModuleImport('attributes:consumer', './value', 'value', () => raw.value, { flavor: 'one', type: 'json' }), 1)
  assert.equal(readModuleImport('attributes:consumer', './value', 'value', () => other.value, { type: 'json', flavor: 'two' }), 2)
  const namespace = readModuleImport('attributes:consumer', './value', null, () => raw, { type: 'json', flavor: 'one' })
  assert.equal(namespace, managedModuleNamespace('attributes:first', raw))
  assert.equal(readModuleImport('untracked', 'source', null, () => raw), namespace)
  const unknown = native({ fn: () => ({v:7}) })
  assert.equal(readModuleImport('untracked', 'source', null, () => unknown), unknown)
  assert.equal(readModuleImport('untracked', 'source', 'value', () => raw.value), raw.value)
  const failure = new ReferenceError('uninitialized')
  reserve('tdz:source', [{ name: 'value', kind: 'accessor' }])
  const pending = managedModuleNamespace('tdz:source', native({ value: () => ({ get v() { throw failure } }) }))
  assert.deepEqual(Reflect.ownKeys(pending), ['value', Symbol.toStringTag])
  assert.throws(() => pending.value, error => error === failure)
  assert.throws(() => Object.getOwnPropertyDescriptor(pending, 'value'), error => error === failure)
})

test('forward and star plans retain exact source relations through cycles and native providers', () => {
  const raw = native({ value: () => ({ v: 7 }) })
  reserve('links:source', [{ name: 'value', kind: 'accessor' }])
  reserve('links:forward', [{ name: 'alias', kind: 'forward', source: 'source', imported: 'value' },
    { name: 'namespace', kind: 'namespace', source: 'source' },
    { name: 'ordinary', kind: 'forward', source: 'builtin', imported: 'ordinary' }])
  recordStatefulModuleResolution('links:forward', 'source', {}, 'links:source')
  const forwarded = managedModuleNamespace('links:forward', native({ alias: raw.value, namespace: raw, ordinary: 3 }))
  assert.equal(forwarded.alias, 7)
  assert.equal(forwarded.namespace, managedModuleNamespace('links:source', raw))
  assert.equal(forwarded.ordinary, 3)
  reserve('links:star', [], [{ source: 'cycle' }, { source: 'source' }, { source: 'builtin' }])
  recordStatefulModuleResolution('links:star', 'cycle', {}, 'links:star')
  recordStatefulModuleResolution('links:star', 'source', {}, 'links:source')
  recordStatefulModuleResolution('links:star', 'builtin', {}, 'links:builtin')
  recordStatefulModuleNamespace('links:builtin', native({ ordinary: 3 }))
  const star = managedModuleNamespace('links:star', native({ value: raw.value, ordinary: 3 }))
  assert.equal(star.value, 7)
  assert.equal(star.ordinary, 3)
  assert.equal(star.default, undefined)
  assert.equal(managedModuleNamespace('links:star', native({ default: 1 })).default, 1)
  assert.equal(moduleBindingIntrinsics.Reflect.decorate, Reflect.decorate)
})

test('module metadata indexing and first namespace creation do not consult user array protocols', () => {
  const attributes = { type: 'json', flavor: 'test' }
  const expected = { value: 7 }
  const raw = native({ value: () => ({ v: expected }) })
  const forwarded = native({ value: raw.value })
  const rawNative = native({ ordinary: expected })
  const stars = native({ ordinary: expected })
  const find = Array.prototype.find, some = Array.prototype.some, includes = Array.prototype.includes
  const iterator = Array.prototype[Symbol.iterator], sort = Array.prototype.sort
  let result, namespace, ordinary, imported
  try {
    const reject = () => { throw new Error('user array operation') }
    Array.prototype.find = reject
    Array.prototype.some = reject
    Array.prototype.includes = reject
    Array.prototype.sort = reject
    Array.prototype[Symbol.iterator] = reject
    reserve('metadata:source', [{ name: 'value', kind: 'accessor' }])
    reserve('metadata:forward', [], [{ source: 'source', attributes }])
    reserve('metadata:native-star', [], [{ source: 'native' }])
    recordStatefulModuleResolution('metadata:forward', 'source', attributes, 'metadata:source')
    recordStatefulModuleResolution('metadata:native-star', 'native', {}, 'metadata:native')
    recordStatefulModuleNamespace('metadata:native', rawNative)
    namespace = managedModuleNamespace('metadata:source', raw)
    result = managedModuleNamespace('metadata:forward', forwarded).value
    ordinary = managedModuleNamespace('metadata:native-star', stars).ordinary
    imported = readModuleImport('metadata:forward', 'source', 'value', () => raw.value,
      { flavor: 'test', type: 'json' })
  } finally {
    Array.prototype.find = find
    Array.prototype.some = some
    Array.prototype.includes = includes
    Array.prototype.sort = sort
    Array.prototype[Symbol.iterator] = iterator
  }
  assert.equal(namespace.value, expected)
  assert.equal(result, expected)
  assert.equal(ordinary, expected)
  assert.equal(imported, expected)
})

test('first namespace construction and compiler intrinsic lookup survive ambient object and collection mutation', () => {
  const expected = { value: 42 }
  const raw = native({ value: () => ({ v: expected }) })
  const knownIntrinsics = captureCompilerIntrinsics()
  const owners = [Object, Object, Object, Object, Object, Reflect,
    Map.prototype, Map.prototype, Set.prototype, Set.prototype, WeakMap.prototype, WeakMap.prototype]
  const names = ['hasOwn', 'create', 'defineProperty', 'getOwnPropertyDescriptor', 'preventExtensions', 'ownKeys',
    'get', 'set', 'has', 'add', 'get', 'set']
  const saved = names.map((name, index) => owners[index][name])
  let namespace, observed, descriptor, intrinsics
  const getDescriptor = Object.getOwnPropertyDescriptor
  try {
    for (let index = 0; index < owners.length; index++) owners[index][names[index]] = () => { throw new Error('changed intrinsic') }
    reserve('intrinsics:source', [{ name: 'value', kind: 'accessor' }])
    recordStatefulModuleNamespace('intrinsics:source', raw)
    namespace = managedModuleNamespace('intrinsics:source', raw)
    observed = namespace.value
    descriptor = getDescriptor(namespace, 'value')
    intrinsics = captureCompilerIntrinsics()
  } finally {
    for (let index = 0; index < owners.length; index++) owners[index][names[index]] = saved[index]
  }
  assert.equal(observed, expected)
  assert.equal(descriptor.value, expected)
  assert.equal(managedModuleNamespace('intrinsics:source', raw), namespace)
  assert.equal(intrinsics, knownIntrinsics)
})

test('managed require preserves callable properties and decodes only formally owned returns', () => {
  const url = new URL('./managed-require-source.mjs', import.meta.url).href
  let result = { v: 3 }
  let calls = 0
  const require = function (source) { calls++; assert.equal(source, 'module'); assert.equal(this, receiver); return result }
  require.resolve = () => 'module'
  const receiver = {}
  const managed = managedRequire('require:parent', require)
  assert.equal(managed.resolve, require.resolve)
  assert.equal(managed.name, require.name)
  assert.equal(managed.call(receiver, 'module'), result)
  reserve(url, [{ name: 'value', kind: 'accessor' }])
  result = native({ value: () => ({ v: 4 }) })
  require.cache = { [fileURLToPath(url)]: { exports: result } }
  recordStatefulModuleNamespace(url, result)
  assert.equal(managed.call(receiver, 'module').value, 4)
  reserve(url, [{ name: 'module.exports', kind: 'accessor' }])
  const original = () => 5
  result = () => ({ v: original })
  require.cache[fileURLToPath(url)].exports = result
  recordStatefulModuleNamespace(url, native({ 'module.exports': result }))
  assert.equal(managed.call(receiver, 'module'), original)
  assert.equal(calls, 3)
})

test('managed require cache lookup retains captured container and invocation operations after user code runs', () => {
  const url = new URL('./managed-require-intrinsics.mjs', import.meta.url).href
  const expected = new Error('original error realm')
  const promise = Promise.resolve(42)
  const raw = native({ error: () => ({ v: expected }), promise: () => ({ v: promise }) })
  reserve(url, [{ name: 'error', kind: 'accessor' }, { name: 'promise', kind: 'accessor' }])
  recordStatefulModuleNamespace(url, raw)
  const owners = [Map.prototype, Map.prototype, Map.prototype, Map.prototype, WeakMap.prototype, Set.prototype, Reflect, Reflect]
  const names = ['get', 'forEach', Symbol.iterator, 'set', 'get', 'has', 'apply', 'construct']
  const saved = names.map((name, index) => owners[index][name])
  const require = function () {
    for (let index = 0; index < owners.length; index++) owners[index][names[index]] = () => { throw new Error('changed intrinsic') }
    return raw
  }
  require.cache = { [fileURLToPath(url)]: { exports: raw } }
  const managed = managedRequire('intrinsics:require', require)
  let namespace, errorValue, promiseValue, constructed
  try {
    namespace = managed('module')
    errorValue = namespace.error
    promiseValue = namespace.promise
    constructed = new managed('module')
  } finally {
    for (let index = 0; index < owners.length; index++) owners[index][names[index]] = saved[index]
  }
  assert.equal(errorValue, expected)
  assert.equal(promiseValue, promise)
  assert.equal(constructed, namespace)
  assert.ok(errorValue instanceof Error)
  assert.ok(promiseValue instanceof Promise)
})

test('managed import rejects native coercion and option errors as promises', async () => {
  const failure = new Error('coercion failed')
  await assert.rejects(managedModuleImport('parent', { toString() { throw failure } }), error => error === failure)
  await assert.rejects(managedModuleImport('parent', Symbol('specifier')), TypeError)
  await assert.rejects(managedModuleImport('parent', 'node:fs', 1), TypeError)
})

test('managed import continuation ignores source Promise catch replacement', async t => {
  const module = await loadManagedSource(t, `export async function run(){
    const previous = Promise.prototype.catch;
    try {
      Promise.prototype.catch = () => { throw Error('source catch') };
      return (await import('data:text/javascript,export const value=42')).value;
    } finally { Promise.prototype.catch = previous }
  }`)
  assert.equal(await module.run(), 42)
})


test('standalone root and dynamic environments retain native import defaults', async () => {
  const source = 'data:text/javascript,export const answer=42'
  const root = createStatefulRootRuntime({}).begin({committed(){}})
  const native = await root.importModule(source)
  assert.equal(native.answer, 42)
  const dynamic = createDynamicEnvironmentRuntime().environment()
  assert.equal(await dynamic.importModule(source), native)
})
