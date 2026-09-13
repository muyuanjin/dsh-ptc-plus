import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { SessionRuntime } from '../internal/session-runtime.js'
import { uncoveredEnvironment } from './subprocess-environment.js'

// Independent axes compose complete source programs. No expected result is
// derived from compiler output; the same program executes first in native Node.
const operations = [
  ['eval', 'eval("let x=40;(()=>x+2)()")'],
  ['Function', 'Function("let x=40;return (()=>x+2)()")()'],
  ['callback', '["40+2"].map(eval)[0]'],
  ['super', '(new (class extends class{constructor(x){this.x=x}}{constructor(){eval("super(42)")}})).x'],
  ['module', '(await import("data:text/javascript,export const value=42")).value'],
  ['with', 'Function("with({x:42})return x")()'],
]
const protocols = [
  { name: 'map methods', target: 'Map.prototype', key: 'get', source: 'new Map().get("source")' },
  { name: 'weak storage', target: 'WeakMap.prototype', key: 'set', source: 'new WeakMap().set({},1)' },
  { name: 'array iteration', target: 'Array.prototype', key: 'Symbol.iterator', computed: true, source: '[...[]]' },
  { name: 'internal serialization', target: 'Object.prototype', key: 'toJSON', source: 'JSON.stringify({})' },
  { name: 'promise catch', target: 'Promise.prototype', key: 'catch', source: 'Promise.resolve().catch(()=>{})' },
  { name: 'promise then', target: 'Promise.prototype', key: 'then', source: 'Promise.resolve().then(()=>{})' },
  { name: 'promise species', target: 'Promise', key: 'Symbol.species', computed: true, source: 'Promise[Symbol.species]()' },
  { name: 'descriptor inheritance', target: 'Object.prototype', key: 'get',
    source: 'Object.defineProperty({},"value",{value:1})', error: 'TypeError' },
]
const entries = [
  ['root', body => body],
  ['function', body => `return await (async function(){${body}})()`],
  ['dynamic', body => `return await eval(${JSON.stringify(`(async function(){${body}})()`)})`],
  ['module', body => `return await (await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(`export async function run(){${body}}`)}`)})).run()`],
]

async function nativeSource(source) {
  const worker = new Worker(new URL('./native-boundary-worker-fixture.js', import.meta.url), {
    workerData: { source }, env: uncoveredEnvironment(),
  })
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`native oracle exited before completion (${code})`)))
    })
    // A native loader failure may also reject its internal promises. It must
    // agree with the observed source error; an unrelated driver failure is
    // never accepted as the expected result of a source program.
    for (const error of result.unhandled) assert.deepEqual(error, result.value.error)
    return result.value
  } finally { await worker.terminate() }
}

for (const scope of ['function', 'arrow', 'nested']) for (const bodyEval of [false, true]) {
  const read = scope === 'nested' ? '()=>()=>x' : '()=>x'
  const body = `var x='inside';${bodyEval ? 'eval("");' : ''}return ${scope === 'nested' ? '()=>read()()' : 'read'}`
  const callable = scope === 'arrow' ? `const f=(read=${read})=>{${body}}`
    : `function f(read=${read}){${body}}`
  const source = `let x='outside';${callable};const saved=f();return [saved(),f()()]`
  test(`parameter environment matrix: ${scope} / body eval ${bodyEval}`, async t => {
    const expected = Function(source)()
    assert.deepEqual(expected, ['outside', 'outside'])
    for (const bindingUpdates of ['stateful', 'protected']) for (const [entry, wrap] of entries) {
      await t.test(`${bindingUpdates} / ${entry}`, async t => {
        const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
        t.after(() => runtime.dispose())
        const result = await runtime.run('parameter-boundary', { program: wrap(source), bindings: [] })
        assert.equal(result.error, undefined, result.error?.message)
        assert.deepEqual(result.value, expected)
      })
    }
  })
}

for (const field of ['get', 'set', 'value', 'writable', 'enumerable', 'configurable']) {
  const source = `const namespace=await import('data:text/javascript,export const value=42');
    const key=${JSON.stringify(field)},define=Object.defineProperty,remove=Reflect.deleteProperty;
    let result;try{
      define(Object.prototype,key,{__proto__:null,configurable:true,value:()=>7});
      const descriptor=Object.getOwnPropertyDescriptor(namespace,'value');
      result=[descriptor.value,Reflect.defineProperty(namespace,'value',{__proto__:null,value:42}),
        Object.getOwnPropertyDescriptor(namespace,Symbol.toStringTag).value,
        Reflect.defineProperty(namespace,Symbol.toStringTag,{__proto__:null,value:'Module'}),
        Object.getPrototypeOf(descriptor)===Object.prototype];
    }finally{remove(Object.prototype,key)}return result`
  test(`namespace descriptor matrix: ${field}`, async t => {
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
    const expected = await new AsyncFunction(source)()
    assert.deepEqual(expected, [42, true, 'Module', true, true])
    for (const [entry, wrap] of entries) await t.test(entry, async t => {
      const runtime = new SessionRuntime({ durableReplay: false })
      t.after(() => runtime.dispose())
      const result = await runtime.run('descriptor-boundary', { program: wrap(source), bindings: [] })
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, expected)
    })
  })
}

for (const expression of ['eval(")")', '[")"].map(eval)', 'Function(")")']) {
  const source = `const Original=SyntaxError;let result;
    try{globalThis.SyntaxError=null;try{${expression}}catch(error){result=[error.name,error instanceof Original]}}
    finally{globalThis.SyntaxError=Original}return result`
  test(`dynamic error classification: ${expression}`, async t => {
    assert.deepEqual(Function(source)(), ['SyntaxError', true])
    for (const [entry, wrap] of entries) await t.test(entry, async t => {
      const runtime = new SessionRuntime({ durableReplay: false })
      t.after(() => runtime.dispose())
      const result = await runtime.run('syntax-boundary', { program: wrap(source), bindings: [] })
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, ['SyntaxError', true])
    })
  })
}

for (const protocol of protocols) for (const [operation, expression] of operations) {
  const key = protocol.computed ? protocol.key : JSON.stringify(protocol.key)
  const body = `
    const target=${protocol.target},key=${key};
    const define=Object.defineProperty,remove=Reflect.deleteProperty;
    const previous=Object.getOwnPropertyDescriptor(target,key);
    let value,sourceEffect=false;
    try{
      define(target,key,{configurable:true,writable:true,value(){throw new Error('source-protocol')}});
      try{${protocol.source}}catch(error){sourceEffect=${protocol.error ? `error.name===${JSON.stringify(protocol.error)}` : "error.message==='source-protocol'"}}
      value=${expression};
    }finally{if(previous===undefined)remove(target,key);else define(target,key,previous)}
    return [value,sourceEffect]`
  test(`boundary matrix: ${protocol.name} / ${operation}`, async t => {
    for (const [entry, wrap] of entries) {
      await t.test(entry, async t => {
        // Compare the same realm/entry placement, including genuine source
        // failures when a module changes the native loader's own Promise realm.
        const program = `try{${wrap(body)}}catch(error){return {error:{name:error.name,message:error.message}}}`
        const expected = await nativeSource(program)
        if (expected.error === undefined) assert.deepEqual(expected, [42, true])
        const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
        t.after(() => runtime.dispose())
        const result = await runtime.run('boundary', { program, bindings: [] })
        assert.equal(result.error, undefined, `${entry}: ${result.error?.message}`)
        assert.deepEqual(result.value, expected)
      })
    }
  })
}
