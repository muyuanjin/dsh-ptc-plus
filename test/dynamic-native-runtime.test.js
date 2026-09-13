import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'

function fixture(values = {}) {
  const runtime = createDynamicEnvironmentRuntime()
  const bindings = new Map(Object.entries(values).map(([name, value]) => [name,
    { kind: 'let', get: () => value, set: next => { value = next } }]))
  const root = runtime.environment({ frames: [{ kind: 'lexical', bindings }] })
  runtime.setRootEnvironment(() => root)
  return { run: source => runtime.evaluate(eval, undefined, [source], root), root }
}

test('native constructor coercion, syntax validation and newTarget effects occur once in native order', () => {
  const { run, root } = fixture({ value: 3 })
  assert.equal(root.reference('Function').callee('return value')(), 3)
  assert.deepEqual(run('[Function.apply(null,["return value"])(),typeof Function.apply(null,null)()]'), [3,'undefined'])
  assert.equal(run('Reflect.apply(Function.prototype.call,Function,[null,"return value"])()'), 3)
  assert.equal(run('Reflect.apply(Function.prototype.apply,Function,[null,["return value"]])()'), 3)
  assert.equal(run('const Bound=Function.bind(null,"return value");Reflect.construct(Bound,[])()'), 3)
  assert.equal(run('Function.bind(null,"return value")()()'), 3)
  assert.equal(run('new (Function.bind(null,"return value"))()()'), 3)
  assert.deepEqual(run(`const events=[];
    const parameter={toString(){events.push('parameter');return 'x'}};
    const body={toString(){events.push('body');return 'return x+value'}};
    const fn=Function(parameter,body);
    let blocked=false;try{Function('a=','return 1')}catch(error){blocked=error instanceof SyntaxError}
    [fn(2),events,blocked]`), [5,['parameter','body'],true])
  assert.deepEqual(run(`const events=[];
    const args={get length(){events.push('length');return 1},get 0(){events.push('body');return 'return value'}};
    const prototype={};
    const NewTarget=new Proxy(function(){},{get(target,key,receiver){if(key==='prototype'){events.push('prototype');return prototype}return Reflect.get(target,key,receiver)}});
    const fn=Reflect.construct(Function,args,NewTarget);
    [fn(),Object.getPrototypeOf(fn)===prototype,events]`), [3,true,['length','body','prototype']])
  assert.deepEqual(run(`const effects=[];
    const args={get length(){effects.push('length');return 0}};
    let errors=0;try{Reflect.construct(Function,args,()=>{})}catch(error){errors+=error instanceof TypeError}
    try{Function.prototype.apply.call(1,null,args)}catch(error){errors+=error instanceof TypeError}
    try{Function(Symbol())}catch(error){errors+=error instanceof TypeError}
    [effects,errors]`), [[],3])
  assert.deepEqual(run('const fn=Function("return [typeof anonymous,arguments.callee===fn]"); [fn.name,fn.length,Function("return typeof anonymous")()]'), ['anonymous',0,'undefined'])
})

test('ordinary functions, bound constructors and optional/private calls retain native behavior', () => {
  const { run } = fixture()
  assert.deepEqual(run(`(()=>{function Function(...args){return args};return Function('ordinary',2)})()`), ['ordinary',2])
  assert.equal(run('function Item(value){this.value=value};const Bound=Item.bind(null,4);new Bound().value'), 4)
  assert.equal(run('const toString=Function.prototype.toString;try{Reflect.apply(toString,{},[])}catch(error){error instanceof TypeError}'), true)
  assert.deepEqual(run(`const events=[];const absent=null;const present={method:null};
    const first=absent?.[events.push(1)](events.push(2));
    const second=present?.method?.(events.push(3));[typeof first,typeof second,events]`), ['undefined','undefined',[]])
  assert.equal(run('class Item{#run(){return this};call(){return this.#run()===this}};new Item().call()'), true)
  assert.equal(run('class Parent{method(){return 4}};class Child extends Parent{method(){return super.method()+1}};new Child().method()'), 5)
  assert.equal(run('function tag(parts,value){return parts[0]+value};const object={tag};object.tag`result:${4}`'), 'result:4')
  assert.equal(run('const nativeEval=eval;const value={};nativeEval(value)===value'), true)
})

test('constructors and eval from a separately created realm retain that realm root', () => {
  const foreign = runInNewContext('({Function,eval,globalThis})')
  foreign.globalThis.value = 8
  const { run } = fixture({ value: 3, foreign })
  assert.deepEqual(run('[foreign.Function("return value")(),foreign.eval("value"),Function("return value")()]'), [8,8,3])
})

test('non-callable diagnostics retain original references, realm errors and argument effects', () => {
  const { create, intrinsics } = ownedRealm()
  const runtime = create().installIntrinsics()
  const root = runtime.environment()
  const run = source => runtime.evaluate(intrinsics.intrinsicEval, undefined, [source], root)
  const plain = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(run(`const events=[];
    const service={get value(){events.push('get');return 3}};
    function key(){events.push('key');return 'value'};
    let result;
    try{service[key()](events.push('arg'),...{*[Symbol.iterator](){events.push('spread');yield 1}})}
    catch(error){result=[error instanceof TypeError,error.message]}
    [result,events]`)), [[true,'service[key()] is not a function'],['key','get','arg','spread']])
  assert.deepEqual(plain(run(`const value=1;let result;
    with({value:2}){try{value()}catch(error){result=[error instanceof TypeError,error.message]}}
    result`)), [true,'value is not a function'])
  assert.deepEqual(plain(run(`const service={value:3};let result;
    try{service.value?.()}catch(error){result=[error instanceof TypeError,error.message]};result`)),
  [true,'service.value is not a function'])
  assert.deepEqual(plain(run('const service={value:3};let result;try{service.value`tag`}catch(error){result=[error instanceof TypeError,error.message]};result')),
    [true,'service.value is not a function'])
})

test('call adapters preserve revoked callables, explicit Reflect failures and exact user exceptions', async () => {
  const { create, intrinsics, run: nativeRun } = ownedRealm()
  const runtime = create().installIntrinsics()
  const root = runtime.environment()
  const run = source => runtime.evaluate(intrinsics.intrinsicEval, undefined, [source], root)
  const nativeReflect = nativeRun('try{Reflect.apply(undefined,null,[])}catch(error){error.message}')
  const nativeRevoked = nativeRun('const revoked=Proxy.revocable(function(){},{});revoked.revoke();try{revoked.proxy()}catch(error){error.message}')
  assert.equal(run('try{Reflect.apply(undefined,null,[])}catch(error){error.message}'), nativeReflect)
  assert.equal(run('const revoked=Proxy.revocable(function(){},{});revoked.revoke();try{revoked.proxy()}catch(error){error.message}'), nativeRevoked)
  const actual = await run(`const marker=Object.freeze(new TypeError('Function.prototype.apply was called on undefined'));
    const service={value(){throw marker}};
    const proxy=new Proxy(function(){},{apply(){throw marker}});
    const getter={get value(){throw marker}};
    const missing={value:undefined};
    let exact=0;
    for(const execute of [()=>service.value(),()=>proxy(),()=>getter.value(),()=>missing.value(service.value())]){
      try{execute()}catch(error){exact+=error===marker}
    }
    (async()=>{try{await Promise.reject(marker)}catch(error){exact+=error===marker};return exact})()`)
  assert.equal(actual, 5)
})

test('the native module realm creates indirect eval globals with actual function declarations', () => {
  const runtime = createDynamicEnvironmentRuntime()
  const root = runtime.environment()
  const source = '(0,eval)("var __ptcNativeIndirect=3;function __ptcNativeRead(){return __ptcNativeIndirect}");[globalThis.__ptcNativeIndirect,globalThis.__ptcNativeRead()]'
  try {
    assert.deepEqual(runtime.evaluate(eval, undefined, [source], root), [3,3])
    assert.deepEqual(runtime.evaluate(eval, undefined, ['(0,eval)("[delete __ptcNativeIndirect,delete __ptcNativeRead]")'], root), [true,true])
  } finally {
    delete globalThis.__ptcNativeIndirect
    delete globalThis.__ptcNativeRead
  }
})

function ownedRealm() {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const create = () => createDynamicEnvironmentRuntime(intrinsics)
  return { context, create, intrinsics, run: source => runInContext(source, context) }
}

test('installed intrinsic callbacks retain validation, coercion, newTarget and native metadata', async () => {
  const { create, intrinsics, run: nativeRun } = ownedRealm()
  const runtime = create().installIntrinsics()
  const root = runtime.environment({ nativeBindings: [['value', { kind: 'let', get: () => 7 }]] })
  runtime.setRootEnvironment(() => root)
  const run = source => runtime.evaluate(intrinsics.intrinsicEval, undefined, [source], root)
  assert.equal(nativeRun('eval'), intrinsics.intrinsicEval)
  assert.equal(nativeRun('Function'), intrinsics.realmFunction)
  assert.notEqual(nativeRun('Function.prototype.toString'), runtime.exposedIntrinsic(nativeRun('Function.prototype.toString')))
  assert.equal(nativeRun('(function(){const local=41;return eval("local")})()'), 41)
  const plain = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(run('["typeof value","value"].map(eval)')), ['number',7])
  assert.equal(run('Function("return value")()'), 7)
  assert.equal(await run('(async function(){}).constructor("return value")()'), 7)
  assert.equal(run('(function*(){}).constructor("yield value")().next().value'), 7)
  assert.equal((await run('(async function*(){}).constructor("yield value")().next()')).value, 7)
  assert.deepEqual(plain(run(`(()=>{const events=[];
    const parameter={toString(){events.push('parameter');return 'x'}};
    const body={toString(){events.push('body');return 'return x+value'}};
    const prototype={};
    const NewTarget=new Proxy(function(){},{get(target,key,receiver){if(key==='prototype'){events.push('prototype');return prototype}return Reflect.get(target,key,receiver)}});
    const fn=Reflect.construct(Function,{get length(){events.push('length');return 2},0:parameter,1:body},NewTarget);
    return [fn(2),Object.getPrototypeOf(fn)===prototype,events]})()`)), [9,true,['length','parameter','body','prototype']])
  assert.deepEqual(plain(run(`(()=>{const events=[];let errors=0;
    const args={get length(){events.push('length');return 0}};
    for(const execute of [()=>Reflect.construct(Function,args,()=>{}),()=>Function(Symbol()),
      ()=>Function('a=','return 1'),()=>new eval('1'),()=>new Function.prototype.toString(),
      ()=>Function.prototype.toString.call({})]){try{execute()}catch(error){errors+=error instanceof TypeError||error instanceof SyntaxError}}
    return [events,errors]})()`)), [[],6])
  assert.deepEqual(plain(run(`(()=>{const functions=[Function,(async function(){}).constructor,(function*(){}).constructor,(async function*(){}).constructor];
    return functions.map(ctor=>[ctor.name,ctor.length,ctor.prototype.constructor===ctor,ctor('return 1').name])})()`)),
  [['Function',1,true,'anonymous'],['AsyncFunction',1,true,'anonymous'],['GeneratorFunction',1,true,'anonymous'],['AsyncGeneratorFunction',1,true,'anonymous']])
  assert.equal(run('Function.prototype.toString.call(Function)'), 'function Function() { [native code] }')
  assert.equal(run('Function.prototype.toString.call(eval)'), 'function eval() { [native code] }')
  assert.equal(run('const object={};[object].map(eval)[0]===object'), true)
  assert.equal(run('Function.bind(null,"return value")()()'), 7)
  assert.equal(run('new (Function.bind(null,"return value"))()()'), 7)
  assert.equal(run('eval.bind(null,"value")()'), 7)
  assert.equal(run('const source=Function.prototype.toString.bind(Function("return value"));[0].map(source)[0]'), 'function anonymous(\n) {\nreturn value\n}')
})

test('realm installation is idempotent across runtime owners and preserves user overrides', () => {
  const { create, run, context, intrinsics } = ownedRealm()
  const first = create()
  assert.equal(first.exposedIntrinsic(intrinsics.intrinsicEval), intrinsics.intrinsicEval)
  first.installIntrinsics()
  const identities = run('[eval,Function,Function.prototype.toString,(async function(){}).constructor]')
  assert.notEqual(first.exposedIntrinsic(intrinsics.intrinsicEval), identities[0])
  assert.equal(identities[0], intrinsics.intrinsicEval)
  const ordinary = () => 1
  assert.equal(first.exposedIntrinsic(ordinary), ordinary)
  const second = create().installIntrinsics()
  const exposedIntrinsics = run('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})')
  createDynamicEnvironmentRuntime(exposedIntrinsics).installIntrinsics()
  assert.deepEqual(run('[eval,Function,Function.prototype.toString,(async function(){}).constructor]'), identities)
  const root = second.environment({ nativeBindings: [['value', { kind: 'let', get: () => 13 }]] })
  second.setRootEnvironment(() => root)
  assert.equal(second.evaluate(identities[0], undefined, ['["value"].map(eval)[0]'], root), 13)
  const fn = second.evaluate(identities[0], undefined, ['x=>x+1'], root)
  context.fn = fn
  assert.equal(run('Function.prototype.toString'), identities[2])
  assert.equal(second.evaluate(identities[0], undefined, ['Function.prototype.toString.call(fn)'], root), 'x=>x+1')
  const before = second.evaluate(identities[0], undefined, ['Function.prototype.toString.bind(fn)'], root)
  run('globalThis.eval=x=>x;globalThis.Function=x=>x;Object.getPrototypeOf(fn).toString=()=>"override"')
  first.installIntrinsics()
  create().installIntrinsics()
  assert.equal(run('eval("value")'), 'value')
  assert.equal(run('Function("value")'), 'value')
  assert.equal(run('fn.toString()'), 'override')
  assert.equal(before(), 'x=>x+1')
})

test('installation respects overrides captured after bootstrap and keeps original eval private', () => {
  const { create, run } = ownedRealm()
  const runtime = create()
  run('globalThis.eval=x=>x;globalThis.Function=x=>x;Object.defineProperty((async function(){}).__proto__,"constructor",{value:()=>"user"})')
  runtime.installIntrinsics()
  assert.equal(run('eval("value")'), 'value')
  assert.equal(run('Function("value")'), 'value')
  assert.equal(run('(async function(){}).constructor()'), 'user')
  assert.equal(run('Object.getPrototypeOf((function*(){}).constructor)===(function(){}).constructor'), true)
})

test('opaque asynchronous callbacks retain their invoking runtime and source provenance', async () => {
  const { create, run } = ownedRealm()
  const first = create().installIntrinsics()
  const second = create().installIntrinsics()
  const writes = []
  let value = 1
  const root = second.environment({ nativeBindings: [['value', { kind: 'let', get: () => value,
    set(next, strict, origin) { value = next; writes.push(origin) } }]] })
  second.setRootEnvironment(() => root)
  const fn = second.evaluate(run('eval'), undefined, ['()=>Promise.resolve("++value").then(eval)'], root)
  assert.equal(await fn(), 2)
  const sourceRoot = root.at('opaque-origin')
  assert.equal(await sourceRoot.prepareCall(run('callback=>Promise.resolve("++value").then(callback)'), undefined, 'opaque-origin')(second.exposedIntrinsic(run('eval'))), 3)
  assert.deepEqual(writes, [undefined,'opaque-origin'])
  assert.equal(first.evaluate(run('eval'), undefined, ['typeof value'], first.environment()), 'undefined')
})
