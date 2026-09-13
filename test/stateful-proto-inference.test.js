import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { fixture } from './plugin-fixture.js'

function run(body) {
  return Function(normalizeStatefulScopes(`function example(){${body}} return example()`).code)()
}

test('normalized declarations and pattern defaults infer __proto__ callable names', async () => {
  for (const expression of ['()=>1', 'function(){return 1}', 'function*(){yield 1}',
    'async function(){return 1}', 'async function*(){yield 1}']) {
    for (const initialize of [`let __proto__=${expression}`, `let __proto__;let __proto__=${expression}`,
      `let {__proto__=${expression}}=Object.create(null)`]) {
      const value = run(`${initialize};return __proto__`)
      assert.equal(value.name, '__proto__', initialize)
      assert.deepEqual(Object.getOwnPropertyDescriptor(value, 'name'), {
        value: '__proto__', writable: false, enumerable: false, configurable: true,
      })
      const result = value()
      assert.equal(result?.next ? (await result.next()).value : await result, 1)
    }
  }
  assert.deepEqual(run('for(let __proto__=()=>1;;){return [__proto__.name,__proto__()]}'), ['__proto__',1])
  assert.deepEqual(run('let __proto__=function explicit(){return explicit};return [__proto__.name,__proto__()===__proto__]'),
    ['explicit',true])
})

test('normalized __proto__ classes observe inferred names before initializer effects', () => {
  const expression = 'class {static seen=this.name;static count=effects++;value=7}'
  for (const initialize of [`let __proto__=${expression}`, `let __proto__;let __proto__=${expression}`,
    `let {__proto__=${expression}}=Object.create(null)`]) {
    assert.deepEqual(run(`let effects=0;${initialize};return [__proto__.name,__proto__.seen,effects,new __proto__().value]`),
      ['__proto__','__proto__',1,7], initialize)
  }
  assert.deepEqual(run('let __proto__=class Explicit {static seen=this.name};return [__proto__.name,__proto__.seen]'),
    ['Explicit','Explicit'])
})

test('name inference preserves ordinary __proto__ prototype setters and data members', () => {
  const source = `
    let effects=0;
    const base={marker:3};
    const literal={__proto__:base};
    const functionPrototype={__proto__:function(){return 4}};
    const classPrototype={__proto__:class {static seen=this.name;static count=effects++}};
    const data={['__proto__']:class {static seen=this.name;static count=effects++}};
    const method={__proto__(){return 5}};
    const primitivePrototype={__proto__:6};
    const member={};member.__proto__=base;
    return [Object.getPrototypeOf(literal)===base,Object.hasOwn(literal,'__proto__'),literal.marker,
      Object.getPrototypeOf(functionPrototype).name,Object.getPrototypeOf(functionPrototype)(),
      Object.getPrototypeOf(classPrototype).name,Object.getPrototypeOf(classPrototype).seen,
      Object.hasOwn(data,'__proto__'),data.__proto__.name,data.__proto__.seen,
      method.__proto__.name,method.__proto__(),Object.getPrototypeOf(primitivePrototype)===Object.prototype,
      Object.hasOwn(primitivePrototype,'__proto__'),Object.getPrototypeOf(member)===base,effects];`
  assert.deepEqual(run(source), Function(source)())
})

test('parameter decorator lowering infers __proto__ class names without changing source prototype syntax', () => {
  const expression = 'class {static seen=this.name;constructor(@decorate value){this.value=value}}'
  for (const initialize of [`let __proto__=${expression}`, `let __proto__;__proto__=${expression}`,
    `let {__proto__=${expression}}=Object.create(null)`]) {
    assert.deepEqual(run(`const effects=[];const decorate=(target,key,index)=>effects.push([target.name,key,index]);
      ${initialize};return [__proto__.name,__proto__.seen,new __proto__(7).value,effects]`),
    ['__proto__','__proto__',7,[['__proto__',undefined,0]]], initialize)
  }
  assert.deepEqual(run(`const names=[];const decorate=target=>names.push(target.name);
    const literal={__proto__:${expression}},data={['__proto__']:${expression}};
    class Holder {__proto__=${expression}}
    const field=new Holder().__proto__;
    return [Object.hasOwn(literal,'__proto__'),Object.getPrototypeOf(literal).name,
      Object.getPrototypeOf(literal).seen,Object.hasOwn(data,'__proto__'),data.__proto__.name,
      data.__proto__.seen,field.name,field.seen,names]`),
  [false,'','',true,'__proto__','__proto__','__proto__','__proto__',['','__proto__','__proto__']])
})

test('worker preserves __proto__ inferred values and initializer effects across cells', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const first = await state.run('proto-inference', `
    const effects=[];
    function create(){
      let __proto__=()=>1;
      const read=()=>__proto__;
      const callable=[__proto__.name,__proto__()];
      let __proto__=class {static seen=this.name;static effect=effects.push(this.name);value=2};
      return {read,callable};
    }
    const retained=create();
    return [retained.callable,retained.read().name,retained.read().seen,effects];`)
  assert.equal(first.error, undefined, first.error?.message)
  assert.deepEqual(first.value, [['__proto__',1],'__proto__','__proto__',['__proto__']])
  const next = await state.run('proto-inference', 'return [retained.read().name,new (retained.read())().value,effects]')
  assert.equal(next.error, undefined, next.error?.message)
  assert.deepEqual(next.value, ['__proto__',2,['__proto__']])
})
