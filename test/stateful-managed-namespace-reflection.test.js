import assert from 'node:assert/strict'
import test from 'node:test'
import { managedGraph } from './managed-module-fixture.js'

test('managed namespace reflection retains native export ordering for numeric names', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `let value=1;export {value as '2',value as '10',value as '1'};
      export function update(){value++}`,
  })
  const namespace = await graph.load()
  const native = await import(graph.url('root.mjs'))
  assert.deepEqual(Reflect.ownKeys(namespace), Reflect.ownKeys(native))
  assert.deepEqual(Object.keys(namespace), Object.keys(native))
  assert.deepEqual(Object.values(namespace).slice(0, 3), [1, 1, 1])
  namespace.update()
  assert.equal(Object.getOwnPropertyDescriptor(namespace, '10').value, 2)
  assert.equal(Reflect.defineProperty(namespace, '10', { value: 2 }), true)
  assert.equal(Reflect.defineProperty(namespace, '10', { value: 1 }), false)
  assert.equal(Reflect.set(namespace, '10', 3), false)
  assert.deepEqual(Object.values(namespace).slice(0, 3), [2, 2, 2])
})

test('managed exports retain values and reflection when an opaque consumer changes array protocols', async t => {
  const graph = await managedGraph(t, {
    'provider.mjs': `export let value={revision:1}; export function update(next){value=next}`,
    'forward.mjs': `export {value as forwarded} from './provider.mjs'; export * as nested from './provider.mjs'`,
    'star.mjs': `export * from './provider.mjs'; export * from './cycle.mjs'; export * from 'node:path'`,
    'cycle.mjs': `export * from './star.mjs'`,
    'consumer.mjs': `export function inspect(namespace,name,operation){
      const old=Array.prototype[operation];
      try {
        Array.prototype[operation]=function(){throw new Error('user array operation')};
        return {value:namespace[name],descriptor:Object.getOwnPropertyDescriptor(namespace,name).value};
      } finally {Array.prototype[operation]=old}
    }`,
    'root.mjs': `import * as direct from './provider.mjs';
      import * as forward from './forward.mjs'; import * as star from './star.mjs';
      import {inspect} from './consumer.mjs';
      export function read(operation){return [
        inspect(direct,'value',operation),inspect(forward,'forwarded',operation),
        inspect(star,'value',operation),inspect(forward,'nested',operation),inspect(star,'sep',operation)
      ]}
      export {direct,forward,star}`,
  }, 'root.mjs', ['consumer.mjs'])
  const module = await graph.load()
  const first = module.direct.value
  const operations = ['find', 'includes', 'some', 'sort', 'map', 'join', Symbol.iterator]
  for (const operation of operations) {
    const values = module.read(operation)
    assert.equal(values[0].value, first)
    assert.equal(values[0].descriptor, first)
    assert.equal(values[1].value, first)
    assert.equal(values[1].descriptor, first)
    assert.equal(values[2].value, first)
    assert.equal(values[2].descriptor, first)
    assert.equal(values[3].value, module.direct)
    assert.equal(values[3].descriptor, module.direct)
    assert.equal(values[4].value, (await import('node:path')).sep)
  }
  const next = { revision: 2 }
  module.direct.update(next)
  const values = module.read('find')
  assert.equal(values[0].value, next)
  assert.equal(values[1].value, next)
  assert.equal(values[2].value, next)
})

test('namespace operations use captured intrinsics while opaque source observes its own prototype changes', async t => {
  const graph = await managedGraph(t, {
    'provider.mjs': `export let value={revision:1};export function update(valueNext){value=valueNext}`,
    'forward.mjs': `export {value as forwarded} from './provider.mjs';export * as nested from './provider.mjs'`,
    'star.mjs': `export * from './provider.mjs'`,
    'consumer.mjs': `export function inspect(namespace,name,owner,key){
      const old=owner[key], descriptor=Object.getOwnPropertyDescriptor, define=Reflect.defineProperty;
      const missing=Reflect.deleteProperty, ownKeys=Reflect.ownKeys;
      try {
        owner[key]=()=> 'source-result';
        const value=namespace[name];
        return {value,descriptor:descriptor(namespace,name).value,keys:ownKeys(namespace),
          same:define(namespace,name,{value}),different:define(namespace,name,{value:{}}),
          missing:namespace.missing,remove:missing(namespace,name),explicit:owner[key]()};
      } finally {owner[key]=old}
    }`,
    'root.mjs': `import * as direct from './provider.mjs';import * as forward from './forward.mjs';
      import * as star from './star.mjs';import {inspect} from './consumer.mjs';
      export function read(owner,key){return [inspect(direct,'value',owner,key),
        inspect(forward,'forwarded',owner,key),inspect(star,'value',owner,key),inspect(forward,'nested',owner,key)]}
      export {direct}`,
  }, 'root.mjs', ['consumer.mjs'])
  const module = await graph.load()
  const expected = module.direct.value
  const operations = [
    [Object, 'hasOwn'], [Object, 'getOwnPropertyDescriptor'], [Object, 'defineProperty'], [Object, 'create'],
    [Object, 'preventExtensions'], [Object, 'is'], [Object, 'entries'],
    [Object.prototype, 'hasOwnProperty'], [Object.prototype, 'propertyIsEnumerable'],
    [Reflect, 'ownKeys'], [Reflect, 'defineProperty'],
    [Map.prototype, 'get'], [Map.prototype, 'set'], [Map.prototype, 'forEach'], [Map.prototype, Symbol.iterator],
    [Set.prototype, 'has'], [Set.prototype, 'add'], [Set.prototype, Symbol.iterator],
    [WeakMap.prototype, 'get'], [WeakMap.prototype, 'set'],
  ]
  for (const [owner, operation] of operations) {
    const results = module.read(owner, operation)
    for (let index = 0; index < results.length; index++) {
      const result = results[index], value = index === 3 ? module.direct : expected
      assert.equal(result.value, value)
      assert.equal(result.descriptor, value)
      assert.equal(result.same, true)
      assert.equal(result.different, false)
      assert.equal(result.remove, false)
      assert.equal(result.missing, undefined)
      assert.equal(result.explicit, 'source-result')
      assert.ok(result.keys.length > 0)
    }
  }
  const next = { revision: 2 }
  module.direct.update(next)
  assert.equal(module.read(Object, 'hasOwn')[0].value, next)
})
