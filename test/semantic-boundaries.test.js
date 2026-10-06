import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { entries } from './semantic-boundary-fixture.js'

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
