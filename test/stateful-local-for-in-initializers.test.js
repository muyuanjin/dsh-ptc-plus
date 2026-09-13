import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

test('local for-in initializers preserve native declaration effects and order', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  const sources = [
    'for(var x=1 in {}){}return x',
    'for(var x=1 in null){}return x',
    'const events=[];for(var x=(events.push("init"),1) in (events.push(x),{a:1,b:2})){events.push(x)}return events',
    'const events=[];try{for(var x=(()=>{events.push("init");throw 2})() in (events.push("rhs"),{})){events.push("body")}}catch(error){events.push(error)}return [x,events]',
    'let n=0;outer:inner:for(var x=(n++,1) in {a:1,b:2}){n++;continue outer}return [x,n]',
    'let n=0;outer:for(var x=(n++,1) in {a:1}){break outer}return [x,n]',
    'var x=0;const o={x:2};with(o){for(var x=3 in {}){}}return [x,o.x]',
    'var x=0;try{throw 2}catch(x){for(var x=3 in {}){}if(x!==3)return 0}return x',
    'let read;for(var x=(read=()=>x,1) in {}){}return read()',
    'if(false)for(var x=(()=>{throw 1})() in {}){}return x',
  ]
  for (const [index, body] of sources.entries()) {
    const result = await runtime.run(`local-for-in-${index}`, { program: `return JSON.stringify([(function(){${body}})()])`, bindings: [] })
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    assert.deepEqual(result.value, JSON.stringify([Function(body)()]), body)
  }
})
