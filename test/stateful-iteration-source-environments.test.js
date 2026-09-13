import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

function session(t, bindingUpdates) {
  const runtime = new SessionRuntime({ bindingUpdates })
  t.after(() => runtime.dispose())
  let sequence = 0
  return async source => {
    const id = `iteration-source-${sequence++}`
    try {
      const result = await runtime.run(id, { program: source, bindings: [] })
      assert.equal(result.error, undefined, JSON.stringify(result.error))
      return result.value
    } finally { await runtime.disposeSession(id) }
  }
}

const guarded = source => `try{${source}}catch(error){return error.name}`
const sources = [
  'let n=0;for(const x of (0,[1,2]))n+=x;return n',
  'let n="";for(const x in (0,{a:1,b:2}))n+=x;return n',
  'let x=[1];for(let x of x){return "body"}',
  'let x=[1];for(let x of eval("x")){return "body"}',
  'let x=[1];for(const x of (()=>eval("x"))()){return "body"}',
  'let x=[1];for(const {x} of eval("x")){return "body"}',
  'let x={a:1};for(let x in eval("x")){return "body"}',
  'let x=[1];for(let x of (eval("x=[2]"),[1])){return "body"}',
  'let x=[1];for(let x of (x=[2],[1])){return "body"}',
  'let x=[1];for(let x of eval("typeof x")){return "body"}',
  'let x=[1];for(let x of (()=>{let x=[2];return eval("x")})()){return x}',
  'var x=[1];for(var x of eval("x")){return x}',
  'let read;for(let x of (read=()=>x,[1])){}return read()',
  'let read;for(let x of (read=()=>eval("x"),[])){}return read()',
  'let write;for(let x of (write=value=>eval("x=value"),[1])){}write(2)',
  'let read;for(let x in (read=()=>eval("x"),{a:1})){}return read()',
  'const reads=[];for(let x of [1,2]){reads.push(()=>eval("x"));x+=10}return reads.map(read=>read())',
  'const reads=[];for(let [x,y=x+1] of [[1],[2]])reads.push(()=>eval("x+y"));return reads.map(read=>read())',
  'const effects=[];for(let x of (effects.push("source"),[1,2])){effects.push(x)}return effects',
  'let n=0;outer:inner:for(let x of [1,2]){n+=x;continue outer}return n',
  'let n=0;outer:inner:for(let x in {a:1,b:2}){n++;continue inner}return n',
  'let n=0;outer:for(let x of [1,2]){inner:for(let y of [3,4]){n+=x+y;continue outer}}return n',
  'let x=[1];outer:for(let x of (0,[2])){break outer}return x',
  'let read;for(let x of (read=class{static value(){return eval("x")}},[1])){}return read.value()',
]

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`${bindingUpdates} iteration sources preserve grouping and lexical head environments`, async t => {
    const run = session(t, bindingUpdates)
    for (const source of sources) {
      const body = guarded(source)
      const expected = Function(body)()
      assert.deepEqual(await run(body), expected, source)
      assert.deepEqual(await run(`return (function(){${body}})()`), expected, source)
    }
  })

  test(`${bindingUpdates} dynamic and module iteration sources retain source environments`, async t => {
    const run = session(t, bindingUpdates)
    for (const source of sources.slice(0, 16)) {
      const body = guarded(source)
      const expected = Function(body)()
      assert.deepEqual(await run(`return eval(${JSON.stringify(`(function(){${body}})()`)});`), expected, source)
      assert.deepEqual(await run(`return Function(${JSON.stringify(body)})()`), expected, source)
      // Modules use native strict mode, including strict eval's delete behavior.
      const moduleExpected = Function(`"use strict";${body}`)()
      const url = `data:text/javascript,${encodeURIComponent(`export const value=(function(){${body}})()`)}#${bindingUpdates}`
      assert.deepEqual(await run(`return (await import(${JSON.stringify(url)})).value`), moduleExpected, source)
    }
  })
}

test('iteration source suspension retains activation, effects and completion', async t => {
  const run = session(t, 'stateful')
  const AsyncFunction = (async function () {}).constructor
  for (const source of [
    'const effects=[];for await(let x of (effects.push("source"),[1,2]))effects.push(x);return effects',
    'let x=[1];for await(let x of await Promise.resolve(eval("x"))){return "body"}',
    'let read;for await(let x of (read=()=>eval("x"),await Promise.resolve([1]))){}return read()',
    'let n=0;outer:for await(let x of [1,2]){n+=x;continue outer}return n',
  ]) {
    const body = guarded(source)
    assert.deepEqual(await run(body), await AsyncFunction(body)(), source)
  }
  const generator = `function* f(){let read;for(let x of (read=()=>eval('x'),yield 1)){}
    try{return read()}catch(error){return error.name}}
    const iterator=f();return [iterator.next(),iterator.next([2])]`
  assert.deepEqual(await run(generator), Function(generator)())
  assert.equal(await run(`return eval('for(let x of (0,[1,2])) x')`), 2)
  assert.equal(await run(`return eval('for(let x of []) x')===undefined`), true)
})
