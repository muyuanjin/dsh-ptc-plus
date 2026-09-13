import assert from 'node:assert/strict'
import test from 'node:test'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { createCallableSourceCatalog, createCallableSourceRegistry } from '../internal/callable-source-catalog.js'
import { loadManagedSource } from './managed-module-fixture.js'
import { createContext, runInContext } from 'node:vm'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'

const defineProperty = Object.defineProperty
const descriptor = Object.getOwnPropertyDescriptor
const iterator = Symbol.iterator
const species = Symbol.species
const metadataMethods = [
  [Array.prototype, 'map'], [Array.prototype, 'push'], [Array.prototype, 'slice'],
  [Array.prototype, 'findIndex'], [Array.prototype, 'includes'], [Array.prototype, 'join'],
  [Array.prototype, iterator], [Array, species], [Array, 'isArray'],
  [Map.prototype, 'get'], [Map.prototype, 'set'], [Map.prototype, 'has'],
  [Map.prototype, 'delete'], [Map.prototype, 'forEach'], [Map.prototype, 'keys'],
  [Map.prototype, 'size'], [Map.prototype, iterator],
  [Set.prototype, 'add'], [Set.prototype, 'has'], [Set.prototype, 'forEach'], [Set.prototype, iterator],
  [WeakMap.prototype, 'get'], [WeakMap.prototype, 'set'], [WeakMap.prototype, 'has'],
  [String.prototype, 'slice'], [String.prototype, 'startsWith'],
  [Object, 'keys'], [Number, 'isInteger'], [Math, 'floor'], [Math, 'min'], [Math, 'max'],
]

function withChangedMetadataMethods(run) {
  const originals = metadataMethods.map(([owner, key]) => descriptor(owner, key))
  const changes = metadataMethods.map(([, key]) => () => { throw new Error(`user metadata method called: ${String(key)}`) })
  try {
    for (let index = 0; index < metadataMethods.length; index++) {
      const pair = metadataMethods[index]
      defineProperty(pair[0], pair[1], { configurable: true, writable: true, value: changes[index] })
    }
    return run()
  } finally {
    for (let index = 0; index < metadataMethods.length; index++) {
      const pair = metadataMethods[index]
      defineProperty(pair[0], pair[1], originals[index])
    }
  }
}

test('managed eval and Function ignore mutated metadata operations while source calls retain overrides', async t => {
  const module = await loadManagedSource(t, `export function evaluate(){
    const result=[];
    result[0]=(function(){let x=7;return eval('x+1')})();
    result[1]=(function(x=eval('9')){return eval('x')})();
    result[2]=(function(){return eval('function created(){return 10};created()')})();
    result[3]=(function(){let x=11;return ()=>eval('x')})()();
    result[4]=Function('let x=12;return eval("x")')();
    const original=eval('(function reflected(){return 13})');
    result[5]=original.toString();
    result[6]=original();
    result[7]=(new Map()).get('source');
    result[8]=[].map(x=>x);
    return result;
  }`)
  const actual = withChangedMetadataMethods(() => {
    Map.prototype.get = () => 'source map'
    Array.prototype.map = () => 'source array'
    return module.evaluate()
  })
  assert.deepEqual(actual, [8, 9, 10, 11, 12, 'function reflected(){return 13}', 13, 'source map', 'source array'])
})

test('dynamic frame creation and native invocation bookkeeping use captured collection operations', () => {
  const initial = createDynamicEnvironmentRuntime().installIntrinsics()
  let current = 1
  const variable = { kind: 'var', get: () => current, set: value => { current = value } }
  const lexical = { kind: 'let', get: () => 2 }
  const self = { kind: 'self', get: () => 3 }
  const root = initial.environment({ nativeBindings: [['outer', lexical]] })
  const shadow = { value: 4, hidden: 5, [Symbol.unscopables]: { hidden: true } }
  const actual = withChangedMetadataMethods(() => {
    const runtime = createDynamicEnvironmentRuntime({ interfaceOwner: {} }).installIntrinsics()
    const environment = runtime.environment({ frames: [{ kind: 'lexical', bindings: new Map() }], nativeBindings: [['outer', lexical]] })
    const active = environment.activation([['local', variable]], undefined, undefined, false, true, [['self', self]])
    const scope = active.capture([[['hidden', lexical]]]).withObject(shadow)
    scope.reference('local').value = 6
    scope.reference('value').value = 7
    const parametersKey = {}
    const parameters = active.parameters(parametersKey, [], undefined, undefined, false, true, [['self', self]])
    const cached = active.parameters(parametersKey, []) === parameters
    const awaiting = root.awaitActivation().capture([[['hoisted', { kind: 'hoisted', get: () => 8 }]]], false, 0)
    awaiting.declareEvalVars(['hoisted', 'temporary'])
    awaiting.initializeEvalDeclarations([['created', () => 9, true]])
    awaiting.reference('temporary').value = 10
    const deleted = awaiting.reference('temporary').delete()
    const arrow = scope.parameterArrow((key, value) => value, 'arrow')
    const tagged = scope.prepareCall(value => value + 1, undefined)
    const deferred = scope.deferredReference('local').value
    const exposed = runtime.exposedIntrinsic(Function)
    return [scope.reference('local').value, scope.reference('outer').value, scope.reference('self').value,
      scope.reference('value').value, scope.reference('hidden').value, parameters.reference('arguments').value === parametersKey,
      cached, awaiting.reference('hoisted').value, awaiting.reference('created').value(), deleted,
      arrow(11), tagged(12), deferred, typeof exposed]
  })
  assert.deepEqual(actual, [6, 2, 3, 7, 2, true, true, 8, 9, true, 11, 13, 6, 'function'])
  assert.equal(shadow.value, 7)
})

test('source registry snapshots, digest matching and block eviction ignore mutable metadata protocols', () => {
  const generated = `function large(){/*${'x'.repeat(180_000)}*/}`
  const original = 'original\ud800\r\n'.repeat(18_000)
  const catalog = createCallableSourceCatalog([generated, original], [[0, 0, generated.length, 1, 0, original.length]])
  const registry = createCallableSourceRegistry()
  const actual = withChangedMetadataMethods(() => {
    registry.register(catalog)
    const first = registry.get(generated)
    registry.register([[generated, 'literal']])
    const second = registry.get(generated)
    registry.register(catalog)
    const third = registry.get(generated)
    catalog.buffers.length = 0
    catalog.entries.length = 0
    return [first, second, third, registry.get(generated), registry.get('missing')]
  })
  assert.deepEqual(actual, [original, 'literal', original, original, undefined])
})

test('logical candidate publication and native root fallback preserve values during combined metadata mutation', () => {
  const realm = createContext()
  const intrinsics = runInContext('({realmFunction:Function,intrinsicEval:eval,globalObject:globalThis})', realm)
  const dynamic = createDynamicEnvironmentRuntime(intrinsics).installIntrinsics()
  const indirect = dynamic.exposedIntrinsic(intrinsics.intrinsicEval)
  const roots = createStatefulRootRuntime({ hasAmbient: () => false, readAmbient: () => undefined })
  const actual = withChangedMetadataMethods(() => {
    let commits = 0
    const root = roots.begin({ declared: ['first','second'], committed() { commits++ } })
    root.assign('first', 1)
    const candidate = root.candidate(['first', 'second'])
    candidate.values.first = 2
    candidate.values.second = 3
    candidate.commit('pattern')
    candidate.values.first = 4
    const global = indirect('var created=5;created+=1;created')
    const deleted = indirect('delete created')
    const absent = indirect('typeof created')
    let readError
    try { indirect('created') } catch (error) { readError = error.name }
    return [roots.read('first'), roots.read('second'), commits, global, deleted, absent, readError,
      indirect('var created=7;created')]
  })
  assert.deepEqual(actual, [4,3,2,6,true,'undefined','ReferenceError',7])
})
