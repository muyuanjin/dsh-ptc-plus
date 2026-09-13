import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

function session(t, bindingUpdates) {
  const runtime = new SessionRuntime({ bindingUpdates })
  t.after(() => runtime.dispose())
  let sequence = 0
  const run = (program, id = `root-instantiation-${sequence++}`) => runtime.run(id, { program, bindings: [] })
  return {
    run,
    async value(program, id) {
      const result = await run(program, id)
      assert.equal(result.error, undefined, JSON.stringify(result.error))
      return result.value
    },
  }
}

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`${bindingUpdates} root var and function groups preserve native instantiation order`, async t => {
    const state = session(t, bindingUpdates)
    for (const source of [
      'return f();var f;function f(){return 7}',
      'return f();function f(){return 7}var f;',
      'const before=f();var f=9;function f(){return 7}return [before,f]',
      'const before=f();function f(){return 7}var f=9;return [before,f]',
      'return f();function f(){return 1}var f;function f(){return 2}',
      'return f();var f;function f(){return 1}var f;function f(){return 2}',
      'const before=f();if(false){var f=9}function f(){return 7}return [before,f()]',
      'const before=f();var f;outer:inner:function f(){return 7}return [before,f()]',
      'const before=f();var {f}={f:9};function f(){return 7}return [before,f]',
      'var f;function f(){return 7}eval("var f");return [f(),eval("f()")]',
    ]) assert.deepEqual(await state.value(source), Function(source)(), source)
    const failed = await state.run('var f=(()=>{throw Error("initializer")})();function f(){return 7}', 'function-failure')
    assert.match(failed.error?.message, /initializer/)
    assert.equal(await state.value('return f()', 'function-failure'), 7)
  })

  test(`${bindingUpdates} Annex B root for-in initializers run once before their source`, async t => {
    const state = session(t, bindingUpdates)
    for (const source of [
      'for(var x=1 in {}){}return x',
      'for(var x=1 in null){}return x',
      'for(var x=1 in undefined){}return x',
      'const effects=[];for(var x=(effects.push("init"),1) in (effects.push(x),{a:1,b:2}))effects.push(x);return [x,effects]',
      'const effects=[];outer:inner:for(var x=(effects.push("init"),1) in {a:1,b:2}){effects.push(x);continue outer}return [x,effects]',
      'let n=0;outer:for(var x=(n++,1) in {a:1}){for(var y=(n++,2) in {b:1})break outer}return [x,y,n]',
      'let calls=0;if(false)for(var x=(calls++,1) in {}){}return [calls,typeof x]',
      'var x=7;const obj={x:1};with(obj){for(var x=2 in {}){}}return [x,obj.x]',
      'var x=7;const obj={};with(obj){for(var x=2 in {}){}}return [x,obj.x===undefined]',
      'var x=7;let seen;try{throw 3}catch(x){for(var x=2 in {}){}seen=x}return [seen,x]',
      'var x=7;const obj={x:1};let seen;try{throw 3}catch(x){with(obj){for(var x=2 in {a:1}){}seen=x}}return [seen,x,obj.x]',
      'let read;for(var x=(read=()=>x,1) in {a:1}){}return [read(),x]',
      'const effects=[];try{for(var x=(()=>{effects.push("init");throw Error("stop")})() in (effects.push("source"),{})){effects.push("body")}}catch(error){effects.push(error.message)}return [effects,typeof x]',
    ]) assert.deepEqual(await state.value(source), Function(source)(), source)
  })

  test(`${bindingUpdates} root for-in publication survives source failure and preserves rejection`, async t => {
    const state = session(t, bindingUpdates)
    const failed = await state.run('for(var x=1 in (()=>{throw Error("source")})()){}', 'loop-source-failure')
    assert.match(failed.error?.message, /source/)
    assert.equal(await state.value('return x', 'loop-source-failure'), 1)
    const initializerFailure = await state.run('for(var x=(()=>{throw Error("init")})() in {}){}', 'loop-initializer-failure')
    assert.match(initializerFailure.error?.message, /init/)
    assert.equal(await state.value('return typeof x', 'loop-initializer-failure'), 'undefined')
    for (const source of ['"use strict";for(var x=1 in {}){}', 'for(var x=1 of []){}']) {
      assert.throws(() => Function(source), SyntaxError)
      const invalid = await state.run(source)
      assert.notEqual(invalid.error, undefined, source)
    }
    assert.equal(await state.value('for(var x=await Promise.resolve(2) in {}){}return x'), 2)
  })
}

test('stateful lexical and existing identities keep source-order publication', async t => {
  const state = session(t, 'stateful')
  assert.deepEqual(await state.value('let f=3;const before=f;var f;function f(){return 7}return [before,f()]'), [3,7])
  assert.deepEqual(await state.value('var f;let f=3;const before=f;function f(){return 7}return [before,f()]'), [3,7])
  await state.value('function f(){return 1};const read=()=>f()', 'existing-functions')
  assert.deepEqual(await state.value('const before=[f(),read()];var f;function f(){return 2}return [before,f(),read()]', 'existing-functions'), [[1,1],2,2])
  const failed = await state.run('var f;throw Error("before function");function f(){return 3}', 'existing-functions')
  assert.match(failed.error?.message, /before function/)
  assert.deepEqual(await state.value('return [f(),read()]', 'existing-functions'), [2,2])
  assert.deepEqual(await state.value('for(var f=()=>4 in {}){}return [f(),read()]', 'existing-functions'), [4,4])
})

test('protected root declaration groups retain lexical and cross-cell collision rules', async t => {
  const state = session(t, 'protected')
  const lexical = await state.run('let f=3;var f;function f(){return 7}')
  assert.notEqual(lexical.error, undefined)
  await state.value('function f(){return 1}', 'protected-function')
  const collision = await state.run('var f;function f(){return 2}', 'protected-function')
  assert.notEqual(collision.error, undefined)
  assert.equal(await state.value('return f()', 'protected-function'), 1)
})
