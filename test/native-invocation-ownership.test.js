import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'

function fixture() {
  const context = createContext()
  const native = source => runInContext(source, context)
  const intrinsics = native('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})')
  const create = values => {
    const runtime = createDynamicEnvironmentRuntime(intrinsics).installIntrinsics()
    const environment = runtime.environment({ nativeBindings: Object.entries(values)
      .map(([name, value]) => [name, { kind: 'let', get: () => value }]) })
    runtime.setRootEnvironment(() => environment)
    return source => runtime.evaluate(intrinsics.intrinsicEval, undefined, [source], environment)
  }
  return { create, native }
}

test('opaque catch resumes its invoking root after a compiled callback throws', () => {
  const { create, native } = fixture()
  const first = create({ value: 1 })
  const opaque = native('(callback, savedEval) => { try { callback() } catch {} return savedEval("value") }')
  for (const source of ['() => JSON.parse("invalid")', '(arg = JSON.parse("invalid")) => arg',
    '(function callback(arg = JSON.parse("invalid")) { return arg })',
    '({ method(arg = JSON.parse("invalid")) { return arg } }).method']) {
    const second = create({ value: 2, opaque, callback: first(source) })
    assert.equal(second('opaque(callback, eval)'), 2, source)
  }
})

test('nested native invocation aliases retain their ordinary source caller', () => {
  const { create } = fixture()
  const run = create({})
  for (const call of ['Function.prototype.call.apply(f, [null])',
    'Reflect.apply(Function.prototype.call, f, [null])',
    'Reflect.apply(Function.prototype.apply, f, [null, []])',
    'f.bind(null).apply(null, [])']) {
    assert.equal(run(`function f(){return f.caller===g} function g(){return ${call}};g()`), true, call)
  }
})
