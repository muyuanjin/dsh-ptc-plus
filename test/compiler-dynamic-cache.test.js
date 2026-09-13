import assert from 'node:assert/strict'
import test from 'node:test'
import { createCachedDynamicCompiler } from '../internal/compiler-dynamic-cache.js'
import { compileDynamicEnvironmentSource } from '../internal/dynamic-environment-compiler.js'
import { compileDynamicSource } from '../internal/compiler-service.js'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'

test('repeated eval preparation still creates fresh activations and reads the current lexical environment', () => {
  const runtime = createDynamicEnvironmentRuntime()
  const first = runtime.environment(), second = runtime.environment()
  const run = (source, environment = first) => runtime.evaluate(eval, undefined, [source], environment)
  run('var value=1')
  run('var value=10', second)
  const readFirst = run('value++; (()=>value)')
  const readSecond = run('value++; (()=>value)', second)
  assert.equal(readFirst(), 2)
  assert.equal(readSecond(), 11)
  run('value=3')
  assert.equal(readFirst(), 3)
  const source = 'let local=0; (()=>++local)'
  const left = run(source), right = run(source)
  assert.equal(left(), 1)
  assert.equal(left(), 2)
  assert.equal(right(), 1)
})

test('cached dynamic syntax revalidates callable source facts and isolates returned metadata', () => {
  let calls = 0, original
  const compile = createCachedDynamicCompiler((...args) => {
    calls++
    return compileDynamicEnvironmentSource(...args)
  })
  const source = '(function read(){return 42})'
  const options = { resolveOriginalSource: () => original }
  const initial = compile(source, options)
  const expected = structuredClone(initial)
  initial.callableSources[0][1] = 'caller mutation'
  assert.deepEqual(compile(source, options), expected)
  assert.equal(calls, 1)
  for (const value of ['function read(){return 41+1}', 'function read(){return 40+2}', undefined]) {
    original = value
    const result = compile(source, options)
    assert.equal(result.callableSources[0][1], original ?? 'function read(){return 42}')
    assert.deepEqual(compile(source, options), result)
  }
  assert.equal(calls, 4)
  const transported = compileDynamicSource(source)
  transported.callableSources[0][1] = 'changed transport'
  assert.notEqual(compileDynamicSource(source).callableSources[0][1], 'changed transport')
})

test('dynamic syntax cache preserves context validation and does not retain failures', () => {
  let calls = 0
  const compile = createCachedDynamicCompiler((...args) => {
    calls++
    return compileDynamicEnvironmentSource(...args)
  })
  for (const [source, accepted, rejected] of [
    ['with({}){}', { strict: false }, { strict: true }],
    ['new.target', { allowNewTarget: true }, {}],
    ['super.value', { allowSuper: true }, {}],
    ['object.#value', { privateNames: ['value'] }, { privateNames: ['other'] }],
  ]) {
    compile(source, accepted)
    const before = calls
    compile(source, accepted)
    assert.equal(calls, before)
    for (let i = 0; i < 2; i++) assert.throws(() => compile(source, rejected), SyntaxError)
    assert.equal(calls, before + 2)
  }
})

test('dynamic compilation cache bounds retained input and output and leaves cell plans to their owner', () => {
  let calls = 0
  const compute = source => { calls++; return { code: String(source) } }
  const compile = createCachedDynamicCompiler(compute, { maxEntries: 2, maxCharacters: 140 })
  compile('one'); compile('two'); compile('one'); compile('three'); compile('two')
  assert.equal(calls, 4)
  compile('x'.repeat(100)); compile('x'.repeat(100))
  compile('x'.repeat(200)); compile('x'.repeat(200))
  compile(null); compile(null)
  compile('cell', { cell: {} }); compile('cell', { cell: {} })
  assert.equal(calls, 12)
  const uncached = createCachedDynamicCompiler(compute, { maxEntries: 0 })
  uncached('one'); uncached('one')
  assert.equal(calls, 14)
})
