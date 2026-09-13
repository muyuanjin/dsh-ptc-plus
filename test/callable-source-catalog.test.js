import assert from 'node:assert/strict'
import test from 'node:test'
import { createCallableSourceCatalog, createCallableSourceRegistry } from '../internal/callable-source-catalog.js'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'

test('shared source catalogs preserve nested ranges, Unicode and exact original text', () => {
  const generated = 'prefix function outer(){return function inner(){return "\ud800😀雪"}} suffix'
  const outer = generated.slice(7, -7)
  const start = generated.indexOf('function inner')
  const inner = generated.slice(start, -8)
  const original = 'original outer\r\noriginal inner\u2028\udc00'
  const catalog = createCallableSourceCatalog([generated, original], [
    [0, 7, generated.length - 7, 1, 0, 14],
    [0, start, generated.length - 8, 1, 16, original.length],
  ])
  const registry = createCallableSourceRegistry()
  registry.register(JSON.parse(JSON.stringify(catalog)))
  assert.equal(registry.get(outer), 'original outer')
  assert.equal(registry.get(inner), 'original inner\u2028\udc00')
  assert.equal(registry.get(`${outer} `), undefined)
  assert.equal(registry.get('unknown'), undefined)
  assert.equal(catalog.length, 2)
})

test('source catalogs share compressed buffers across overlapping large callables', () => {
  const source = 'function outer(){'.repeat(400) + '/*'.padEnd(200_000, 'x') + '*/' + '}'.repeat(400)
  const original = 'original 😀\ud800\r\n'.repeat(20_000)
  const ranges = []
  for (let index = 0; index < 400; index++) ranges.push([0, index * 17, source.length - index, 1, index, original.length - index])
  const catalog = createCallableSourceCatalog([source, original], ranges)
  assert.ok(JSON.stringify(catalog).length < source.length + original.length)
  const registry = createCallableSourceRegistry()
  registry.register(catalog)
  for (const index of [0, 399, 17, 0]) {
    assert.equal(registry.get(source.slice(index * 17, source.length - index)), original.slice(index, original.length - index))
  }
})

test('reflection verifies exact generated text after digest selection', () => {
  const expected = 'function test(){return 1}'
  const foreign = 'function test(){return 2}'
  const proof = createCallableSourceCatalog([expected, 'correct'], [[0, 0, expected.length, 1, 0, 7]])
  const forged = createCallableSourceCatalog([foreign, 'incorrect'], [[0, 0, foreign.length, 1, 0, 9]])
  forged.entries[0][6] = proof.entries[0][6]
  const registry = createCallableSourceRegistry()
  registry.register(proof)
  registry.register(forged)
  assert.equal(registry.get(expected), 'correct')
  assert.equal(registry.get(foreign), undefined)
})

test('registration snapshots inputs and preserves latest source facts across both formats', () => {
  const generated = 'function registered(){}'
  const first = createCallableSourceCatalog([generated, 'first second'], [
    [0, 0, generated.length, 1, 0, 5], [0, 0, generated.length, 1, 6, 12],
  ])
  const copy = JSON.parse(JSON.stringify(first))
  const registry = createCallableSourceRegistry()
  registry.register(first)
  assert.equal(registry.get(generated), 'second')
  first.buffers[1].blocks.length = 0
  first.entries.length = 0
  assert.equal(registry.get(generated), 'second')
  registry.register([[generated, 'literal']])
  assert.equal(registry.get(generated), 'literal')
  for (let index = 0; index < 20; index++) registry.register(JSON.parse(JSON.stringify(copy)))
  assert.equal(registry.get(generated), 'second')
  registry.register([[generated, 'final']])
  assert.equal(registry.get(generated), 'final')
})

test('empty source ranges and invalid compiler ranges have explicit behavior', () => {
  const empty = createCallableSourceCatalog([''], [[0, 0, 0, 0, 0, 0]])
  const registry = createCallableSourceRegistry()
  registry.register(empty)
  assert.equal(registry.get(''), '')
  registry.register(createCallableSourceCatalog([], []))
  for (const range of [[1, 0, 1, 0, 0, 1], [0, -1, 0, 0, 0, 1], [0, 1, 0, 0, 0, 1], [0, 0, 2, 0, 0, 1], [0, 0.5, 1, 0, 0, 1]]) {
    assert.throws(() => createCallableSourceCatalog(['x'], [range]), /invalid callable source range/)
  }
  assert.throws(() => registry.register({ format: 'unknown' }), /unsupported callable source catalog/)
})

test('native source reflection consumes compact facts without wrapping user functions', () => {
  const callable = function compactFact() { return 42 }
  const native = Function.prototype.toString.call(callable)
  const original = 'function compactFact(){return 42}'
  const runtime = createDynamicEnvironmentRuntime().installIntrinsics()
  runtime.registerSources(createCallableSourceCatalog([native, original], [[0, 0, native.length, 1, 0, original.length]]))
  const root = runtime.environment({ frames: [{ kind: 'lexical', bindings: new Map([
    ['callable', { kind: 'let', get: () => callable }],
  ]) }] })
  assert.deepEqual(runtime.evaluate(eval, undefined, ['[callable(),callable.toString(),callable]'], root), [42, original, callable])
  assert.equal(Function.prototype.toString.call(callable), native)
})
