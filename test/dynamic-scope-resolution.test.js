import assert from 'node:assert/strict'
import test from 'node:test'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'

function run(source) {
  const runtime = createDynamicEnvironmentRuntime()
  const environment = runtime.environment()
  return runtime.evaluate(eval, undefined, [source], environment)
}

function native(source) {
  return Function('source', 'return eval(source)')(source)
}

test('eval var initialization retains catch identity and with target selection', () => {
  const source = 'let seen;try{throw 1}catch(error){var error=2;seen=error};[seen,typeof error]'
  assert.deepEqual(run(source), native(source))
  const withSource = `const object={value:1};with(object){var value=2};[object.value,typeof value]`
  assert.deepEqual(run(withSource), native(withSource))
  const patternSource = `const object={value:1};with(object){var {value}= {value:2}};[object.value,typeof value]`
  assert.deepEqual(run(patternSource), native(patternSource))
})

test('with var initializers evaluate the value before resolving the write target', () => {
  const source = `const events=[];const object=new Proxy({value:1},{
    has(target,key){if(key==='value')events.push('has');return Reflect.has(target,key)},
    set(target,key,value){if(key==='value')events.push('set');return Reflect.set(target,key,value)},
  });with(object){var value=(events.push('rhs'),2)};[events,object.value]`
  const expected = native(source)
  const actual = run(source)
  assert.deepEqual(actual, expected)
  assert.deepEqual(actual[0].filter(event => event === 'rhs' || event === 'set'), ['rhs', 'set'])
})

test('sloppy eval vars shadow lexical bindings for reads, writes and strict child closures', () => {
  const source = `(function(){let outer=1;function f(){eval("var outer=2");outer=3;return [eval("outer"),outer,function(){"use strict";return outer}()]}return [f(),outer]})()`
  assert.deepEqual(run(source), native(source))
})

test('named function self bindings stay outside parameter and body var frames', () => {
  const source = `(function own(first=eval("var own=2"),second=eval("own")){
    return [first,second,own,eval("own")]
  })()`
  assert.deepEqual(run(source), native(source))
  const strictSource = `(function own(){"use strict";eval("var own=2");return own===eval("own")})()`
  assert.deepEqual(run(strictSource), native(strictSource))
  const constructorSource = `Function("const object={value:1};with(object){var value=2};return [object.value,typeof value]")()`
  assert.deepEqual(run(constructorSource), native(constructorSource))
})

test('native self shadows preserve body storage, deletion and mapped arguments', () => {
  const cases = [
    '(function own(){var own=3;return [own,eval("own")]})()',
    '(function(){var own=7;return (function own(){return eval("own.name")})()})()',
    '(function own(){eval("var own=2");return [eval("delete own"),eval("typeof own"),own.name]})()',
    '(function own(own){var own=3;return [own,arguments[0],eval("own")]})(1)',
    '(function own(read=eval("()=>own")){var own=3;return [read().name,own,eval("own")]})()',
    '(function own(read=eval("()=>own")){let own=3;return [read().name,own,eval("own")]})()',
    '(function own(read=eval("()=>own")){const own=3;return [read().name,own,eval("own")]})()',
    '(function own(read=eval("()=>own")){class own{};return [read()===own,eval("own")===own]})()',
    '(function own(read=eval("()=>own")){function own(){return 3};return [read()===own,eval("own()"),own()]})()',
    '(function own(){own=3;return [own.name,eval("own.name")]})()',
    '(function own(){"use strict";try{eval("own=3")}catch(error){return [error.name,own.name]}})()',
  ]
  for (const source of cases) assert.deepEqual(run(source), native(source), source)
})

test('adapting with initializers retains native var storage and pattern sequencing', async () => {
  const cases = [
    '(function(){const object={x:1};with(object){var x=2};return [object.x,x===undefined,eval("x===undefined"),delete x]})()',
    '(function(){const object={x:1};with(object){var [x,y]=[2,3]};return [object.x,x===undefined,y]})()',
    '(function(){const object={x:1};with(object){for(var x of [2,3]){}};return [object.x,x===undefined]})()',
    '(function(){const object={x:1};with(object){for(var x in {a:1,b:2}){}};return [object.x,x===undefined]})()',
    '(function(){const object={x:1};with(object){for(var x=2;false;){}};return [object.x,x===undefined]})()',
    '(function(){const object={x:1};with(object){var x};return [object.x,x===undefined]})()',
    '(function(x){const object={x:1};with(object){var x=2};return [object.x,x,arguments[0]]})(7)',
    '(function(){const object={x:1};with(object){return (function(){var x=2;return [x,object.x]})()}})()',
    '(function(){let x=0,y=0;const object={};try{with(object){[x,y=(()=>{throw 1})()]=[2]}}catch{};return [x,y]})()',
    '(function(){var x=0,y=0;const object={x:1};with(object){var [x,y=x]=[2]};return [object.x,x,y]})()',
    '(async function(){const object={x:1};with(object){var [x,y]=await Promise.resolve([2,3])};return [object.x,x===undefined,y]})()',
    '(function(){const iterator=(function*(){const object={x:1};with(object){var [x,y]=yield 0};return [object.x,x===undefined,y]})();iterator.next();return iterator.next([2,3]).value})()',
  ]
  for (const source of cases) assert.deepEqual(await run(source), await native(source), source)
})

test('with references stop at the proven declaration fallback and retain native operations', () => {
  const runtime = createDynamicEnvironmentRuntime()
  let value = 7
  const fallback = { kind: 'var', get: () => value, set: next => { value = next } }
  const outer = { x: 99 }, inner = { x: 1, [Symbol.unscopables]: {} }
  const environment = runtime.environment().withObject(outer).withObject(inner)
    .capture([[['x', { kind: 'let', get: () => 42 }]]])
  const selected = environment.withReference('x', 1, fallback)
  assert.equal(selected.value, 1)
  selected.value = 2
  assert.equal(inner.x, 2)
  inner[Symbol.unscopables].x = true
  assert.equal(selected.value, 7)
  selected.value = 8
  assert.equal(value, 8)
  delete inner.x
  assert.equal(selected.value, 8)
  assert.equal(outer.x, 99)
  assert.equal(environment.withReference('x', 2, fallback).value, 99)
  inner[Symbol.unscopables] = null
  inner.x = function () { return this }
  assert.equal(selected.callee(), inner)
  assert.equal(selected.typeof(), 'function')
  assert.equal(selected.delete(), true)
  assert.equal(selected.value, 8)
  assert.equal(selected.delete(), false)

  const evalEnvironment = runtime.environment({ varFrame: new Map([['x', fallback]]) }).withObject(inner)
  const evalReference = evalEnvironment.withReference('eval', 1, { kind: 'var', get: () => eval })
  assert.equal(evalReference.evalInvocation(evalEnvironment, ['x'])(), 8)
  inner.eval = function (source) { return [this === inner, source] }
  assert.deepEqual(evalReference.evalInvocation(evalEnvironment, ['x'])(), [true, 'x'])
  const delegated = evalEnvironment.capture([[['alias', {
    kind: 'var', reference: () => evalEnvironment.withReference('x', 1, fallback),
  }]]])
  assert.equal(runtime.evaluate(eval, undefined, ['alias+=2'], delegated), 10)
  assert.equal(value, 10)
})
