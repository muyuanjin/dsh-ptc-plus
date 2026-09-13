import assert from 'node:assert/strict'
import test from 'node:test'
import { copyCompilerData, stringifyCompilerData } from '../internal/compiler-data.js'
import { captureCompilerIntrinsics, moduleRuntimeIntrinsics } from '../internal/compiler-intrinsics.js'
import { createContext, runInContext } from 'node:vm'
import { createExceptionOriginScope, recordExceptionOrigin, programBindingError } from '../internal/failure-reporting.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { UserBindingConsole } from '../internal/user-binding-console.js'
import { loadManagedSource, managedGraph } from './managed-module-fixture.js'
import { createCompilerDescriptors, compilerDescriptorSource } from '../internal/compiler-descriptors.js'
import { compilerStorageSource } from '../internal/compiler-storage-source.js'
import { parse } from '@babel/parser'
import traverseImport from '@babel/traverse'
import loadTypeScript from '../internal/compiler-typescript.cjs'
import { lowerNativeLanguageSource } from '../internal/repl-scope-normalizer.js'

for (const poison of ['value', 'accessor']) {
  test(`decorator private records exclude inherited state while public contexts retain it (${poison})`, async t => {
    const body = `let reads=0,writes=0,late,result;const observations=[],events=[];
      const previous=Object.getOwnPropertyDescriptor(Object.prototype,'v');
      try{
        Object.defineProperty(Object.prototype,'v',{configurable:true,${poison === 'value' ? 'value:true,writable:true'
          : "get(){reads++;return true},set(){writes++;throw Error('inherited write')}"}});
        function decorate(value,context){
          observations.push(Object.getPrototypeOf(context)===Object.prototype,context.v===true);
          if(context.access)observations.push(Object.getPrototypeOf(context.access)===Object.prototype,context.access.v===true);
          if(context.kind==='accessor')observations.push(Object.getPrototypeOf(value)===Object.prototype,value.v===true);
          context.addInitializer(function(){events.push(context.kind)});late=context.addInitializer;
        }
        @decorate class C{@decorate method(){return 42} @decorate accessor value=1}
        const c=new C();let rejected=false;try{late(()=>{})}catch(error){rejected=error instanceof TypeError}
        result=[c.method(),c.value,observations,events,rejected,reads,writes];
      }finally{if(previous===undefined)delete Object.prototype.v;else Object.defineProperty(Object.prototype,'v',previous)}
      return result`
    const ts = loadTypeScript()
    const oracle = ts.transpileModule(`function run(){${body}}`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    const expected = runInContext(`${oracle};run()`, createContext())
    assert.deepEqual(structuredClone(expected), [42,1,Array(12).fill(true),['class','method','accessor'],true,poison === 'value' ? 0 : 6,0])
    const reflected = lowerNativeLanguageSource(`function run(){${body}}`)
    assert.deepEqual(structuredClone(runInContext(`${reflected};run()`,createContext())),structuredClone(expected))
    for (const bindingUpdates of ['stateful','protected']) {
      const runtime = new SessionRuntime({bindingUpdates,durableReplay:false})
      t.after(()=>runtime.dispose())
      for (const program of [body,`return (await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(`export function run(){${body}}`)}`)})).run()`]) {
        const result = await runtime.run('decorator-private-records',{program,bindings:[]})
        assert.equal(result.error,undefined,result.error?.message)
        assert.deepEqual(result.value,structuredClone(expected))
      }
    }
  })
}

test('emitted intrinsic factories have no implicit lexical capability inputs', () => {
  const traverse = traverseImport.default ?? traverseImport
  for (const source of [compilerStorageSource, compilerDescriptorSource]) {
    const unbound = new Set()
    traverse(parse(`(${source})`), { ReferencedIdentifier(path) {
      if (!path.scope.hasBinding(path.node.name, { noGlobals:true })) unbound.add(path.node.name)
    } })
    assert.deepEqual([...unbound], [])
  }
})

test('internal diagnostics retain captured constructors without evaluating rejected data accessors', () => {
  const nativeError = Error, nativeTypeError = TypeError
  const failures = []
  let reads = 0
  try {
    globalThis.Error = globalThis.TypeError = null
    for (const input of [() => {}, Symbol('source'), { get value() { reads++; return 1 } }]) {
      try { copyCompilerData(input) } catch (error) { failures.push(error) }
    }
    failures.push(programBindingError('lease', 'expired'))
  } finally {
    globalThis.Error = nativeError
    globalThis.TypeError = nativeTypeError
  }
  assert.equal(reads, 0)
  assert.equal(failures.length, 4)
  for (const error of failures.slice(0, 3)) assert.equal(Object.getPrototypeOf(error), nativeTypeError.prototype)
  assert.equal(Object.getPrototypeOf(failures[3]), nativeError.prototype)
  assert.equal(failures[3].message, 'expired')
})

test('owned Object conversion preserves identity and primitive brands', () => {
  const owned = createCompilerDescriptors(Object, Reflect)
  const object = {}, callable = () => {}, symbol = Symbol('source')
  for (const value of [object, callable]) assert.equal(owned.Object(value), value)
  for (const value of [42, 'text', true, 42n, symbol]) {
    const boxed = owned.Object(value)
    assert.equal(Object.getPrototypeOf(boxed), Object.getPrototypeOf(Object(value)))
    assert.equal(boxed.valueOf(), value)
  }
  assert.equal(owned.getOwnPropertyDescriptor(object, 'absent'), undefined)
})

test('internal data keys ignore inherited serialization hooks and preserve distinct nested data', () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
  const data = ['source', { attributes: [['type','json']], missing: undefined }, undefined]
  let keys, source
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { return 'source hook' } })
    keys = [stringifyCompilerData(data), stringifyCompilerData(['other', { attributes: [['type','json']] }])]
    source = JSON.stringify(data)
  } finally {
    if (previous === undefined) delete Object.prototype.toJSON
    else Object.defineProperty(Object.prototype, 'toJSON', previous)
  }
  assert.deepEqual(keys, ['["source",{"attributes":[["type","json"]]},null]', '["other",{"attributes":[["type","json"]]}]'])
  assert.equal(source, '"source hook"')
})

test('owned storage construction retains native brands and operations during protocol mutation', () => {
  const intrinsics = captureCompilerIntrinsics()
  const changes = [[WeakMap.prototype,'get'],[WeakMap.prototype,'set'],[WeakMap.prototype,'delete'],
    [WeakSet.prototype,'has'],[WeakSet.prototype,'add'],[WeakSet.prototype,'delete'],
    [Array.prototype,Symbol.iterator],[Object.getPrototypeOf([][Symbol.iterator]()),'next']]
  const originals = changes.map(([owner,key]) => Object.getOwnPropertyDescriptor(owner,key))
  let result
  try {
    for (let i=0;i<changes.length;i++) Object.defineProperty(changes[i][0],changes[i][1],{configurable:true,value:null})
    const map=intrinsics.weakMapStore(), set=intrinsics.weakSetStore(), key={}
    map.set(key,42);set.add(key)
    result=[map instanceof WeakMap,set instanceof WeakSet,map.get(key),set.has(key),map.delete(key),set.delete(key),
      ...intrinsics.array([1,2])]
  } finally {
    for (let i=0;i<changes.length;i++) Object.defineProperty(changes[i][0],changes[i][1],originals[i])
  }
  assert.deepEqual(result,[true,true,42,true,true,true,1,2])
})

test('private storage closes indexed inheritance and iterator completion protocols', () => {
  const realm = createContext()
  const intrinsics = captureCompilerIntrinsics(runInContext('Function', realm))
  runInContext(`Object.defineProperty(Array.prototype,'0',{set(){throw Error('source index')}});
    Object.getPrototypeOf([][Symbol.iterator]()).return=()=>{throw Error('source return')};`, realm)
  const values = intrinsics.array(runInContext('[]', realm))
  assert.equal(values.push(2), 1)
  assert.equal(values.unshift(1), 2)
  assert.deepEqual(Array.from(values), [1,2])
  values.splice(1,0,3)
  assert.equal(values.pop(), 2)
  for (const value of values) { assert.equal(value, 1); break }
  const sparse = intrinsics.array(runInContext('[,]', realm))
  assert.equal(sparse.pop(), undefined)
  assert.equal(sparse.length, 0)
  runInContext(`Array.prototype.push=Array.prototype.pop=()=>{throw Error('source method')}`, realm)
  const derived = values.concat(intrinsics.array(runInContext('[]', realm)))
  assert.equal(derived.push(4), 3)
  assert.equal(derived.pop(), 4)
  const removed = derived.splice(0, 1)
  assert.equal(removed.pop(), 1)
  assert.equal(removed.push(5), 1)
})

test('compiler continuations route callback failures and preserve source promise identity', async () => {
  const failure = new Error('callback'), source = Promise.resolve(42)
  const intrinsics = captureCompilerIntrinsics()
  assert.equal(await intrinsics.awaitValue(source, value => value), 42)
  assert.equal(Object.getPrototypeOf(source), Promise.prototype)
  await assert.rejects(intrinsics.awaitValue(Promise.reject(failure), () => {}), error => error === failure)
  await assert.rejects(new Promise((resolve, reject) => {
    moduleRuntimeIntrinsics.observeOwnedPromise(Promise.resolve(42), () => {throw failure}, reject)
  }), error => error === failure)
})

test('exception provenance preserves thrown identity, reset and close under collection mutation', () => {
  const scope=createExceptionOriginScope(), sentinel={}
  const changes=[[Map.prototype,'get'],[Map.prototype,'set'],[Map.prototype,'delete'],[Map.prototype,'clear'],
    [Set.prototype,'has'],[Set.prototype,'add'],[Set.prototype,'delete'],[Set.prototype,'clear'],
    [Array.prototype,'includes'],[Array.prototype,'push']]
  const originals=changes.map(([owner,key])=>owner[key])
  let before,reset,closed,caught
  try {
    for(let i=0;i<changes.length;i++)changes[i][0][changes[i][1]]=null
    scope.run(()=>{
      recordExceptionOrigin(sentinel,'one',{sourceFailure:true})
      recordExceptionOrigin(sentinel,'one')
      before=[scope.origins(sentinel),scope.sourceFailure(sentinel)]
      recordExceptionOrigin(sentinel,'two',{reset:true})
      reset=[scope.origins(sentinel),scope.sourceFailure(sentinel)]
      try{throw sentinel}catch(error){recordExceptionOrigin(error,'two');caught=error}
      scope.close();recordExceptionOrigin(sentinel,'late')
      closed=[scope.origins(sentinel),scope.sourceFailure(sentinel)]
    })
  } finally {for(let i=0;i<changes.length;i++)changes[i][0][changes[i][1]]=originals[i]}
  assert.equal(caught,sentinel)
  assert.deepEqual(before,[['one'],true])
  assert.deepEqual(reset,[['two'],false])
  assert.deepEqual(closed,[undefined,false])
})

test('managed graph keys and native hook scopes survive source serialization and synchronized export changes', async t => {
  const module=await loadManagedSource(t, `import module from 'node:module';export async function run(){
    const register=module.registerHooks,sync=module.syncBuiltinESMExports;
    const previous=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');
    const late=register({resolve(source,context,next){return next(source,context)}});
    let value,sourceJSON,sourceError;
    try{
      module.registerHooks=()=>{throw Error('source hook')};sync();
      Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return 'source JSON'}});
      sourceJSON=JSON.stringify([]);
      try{module.registerHooks({})}catch(error){sourceError=error.message}
      const first=await import('data:text/javascript,export const value=42');
      const other=await import('data:text/javascript,export const value=43');
      const repeated=await import('data:text/javascript,export const value=42');
      value=[first.value,other.value,first===repeated];
    }finally{
      module.registerHooks=register;sync();late.deregister();
      if(previous===undefined)delete Object.prototype.toJSON;else Object.defineProperty(Object.prototype,'toJSON',previous)
    }
    return [value,sourceJSON,sourceError]
  }`)
  assert.deepEqual(await module.run(),[[42,43,true],'"source JSON"','source hook'])
})

test('computed decorator registries preserve names and source effects during WeakMap mutation', async t => {
  const runtime=new SessionRuntime({durableReplay:false})
  t.after(()=>runtime.dispose())
  const body=`const previous=[WeakMap.prototype.get,WeakMap.prototype.set,WeakMap.prototype.delete];
    const events=[];const decorator=(value,context)=>{events.push(context.name);return value};let result;
    try{WeakMap.prototype.get=WeakMap.prototype.set=WeakMap.prototype.delete=null;
      class C{@decorator [(events.push('key'),'a')](){return 1} b(){return 2}}
      const c=new C();result=[c.a(),c.b(),c.a.name,events];
    }finally{[WeakMap.prototype.get,WeakMap.prototype.set,WeakMap.prototype.delete]=previous}return result`
  for(const program of [body,`return (await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(`export function run(){${body}}`)}`)})).run()`]) {
    const result=await runtime.run('decorator-storage',{program,bindings:[]})
    assert.equal(result.error,undefined,result.error?.message)
    assert.deepEqual(result.value,[1,2,'a',['key','a']])
  }
})

test('dynamic super forwarding uses owned iteration while explicit source spreads remain observable', async t => {
  const module=await loadManagedSource(t, `export function run(){
    const previous=Array.prototype[Symbol.iterator];let sourceError;
    class Base{constructor(value){this.value=value}}
    class Derived extends Base{constructor(){try{
      Array.prototype[Symbol.iterator]=()=>{throw Error('source iterator')};
      try{eval('super(...[2])')}catch(error){sourceError=error.message}
      eval('super(3)');
    }finally{Array.prototype[Symbol.iterator]=previous}}}
    const value=new Derived();return [value.value,value instanceof Base,value instanceof Derived,sourceError]
  }`)
  assert.deepEqual(module.run(),[3,true,true,'source iterator'])
})

test('source exceptions cross worker callbacks without diagnostic substitution', async t => {
  const runtime=new SessionRuntime({durableReplay:false})
  t.after(()=>runtime.dispose())
  const module=`export function run(callback){const previous=Map.prototype.get;
    try{Map.prototype.get=null;return callback()}finally{Map.prototype.get=previous}}`
  const result=await runtime.run('exception-identity',{bindings:[],program:`
    const module=await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(module)}`)});
    const sentinel={};try{module.run(()=>{throw sentinel})}catch(error){return error===sentinel}`})
  assert.equal(result.error,undefined,result.error?.message)
  assert.equal(result.value,true)
})

test('private descriptor construction rejects inherited fields without changing source reflection', () => {
  const owned = createCompilerDescriptors(Object, Reflect)
  const define = Object.defineProperty, get = Object.getOwnPropertyDescriptor
  const changes = ['get', 'set', 'value', 'writable', 'enumerable', 'configurable']
  for (const field of changes) {
    const previous = get(Object.prototype, field)
    let result, sourceError
    try {
      define(Object.prototype, field, { __proto__: null, configurable: true, value: () => 7 })
      const target = {}, key = Symbol('private')
      const fields = { [key]: { value: 42 }, hidden: { get: () => 3 } }
      define(fields, 'omitted', { __proto__: null, value: { value: 9 } })
      owned.defineProperties(target, fields)
      result = [target[key], target.hidden, owned.reflectDefineProperty(target, key, { value: 42 }), 'omitted' in target]
      try { define({}, 'source', field === 'value' || field === 'writable' ? { get: () => 1 } : { value: 1 }) }
      catch (error) { sourceError = error.name }
    } finally {
      if (previous === undefined) delete Object.prototype[field]
      else define(Object.prototype, field, { __proto__: null, ...previous })
    }
    assert.deepEqual(result, [42, 3, true, false], field)
    if (['get', 'set', 'value', 'writable'].includes(field)) assert.equal(sourceError, 'TypeError', field)
  }
})

test('CommonJS evidence shares captured hook disposal while source calls retain their effects', async t => {
  const graph = await managedGraph(t, {
    'provider.cjs': 'exports.value=42',
    'forward.cjs': "module.exports=require('./provider.cjs')",
    'root.mjs': `import {registerHooks} from 'node:module';export async function run(){
      const hook=registerHooks({}),prototype=Object.getPrototypeOf(hook),original=prototype.deregister;
      hook.deregister();let result,hits=0;
      try{prototype.deregister=()=>{hits++;throw Error('source disposer')};
        const namespace=await import('./forward.cjs');
        result=[namespace.value,namespace===(await import('./forward.cjs')),hits];
        try{hook.deregister()}catch(error){result.push(error.message,hits)}
      }finally{prototype.deregister=original}return result
    }`,
  })
  assert.deepEqual(await (await graph.load()).run(), [42, true, 0, 'source disposer', 1])
})

test('late dynamic environments use captured ToObject while source Object remains replaceable', async t => {
  const lateSource = `export function run(){return [Function('with({x:42})return x')(),Function('with("abc")return length')()]}`
  const lateUrl = JSON.stringify(`data:text/javascript,${encodeURIComponent(lateSource)}`)
  const module = await loadManagedSource(t, `export async function run(){
    const original=Object;let result;
    try{globalThis.Object=()=>({x:99});
      const module=await import(${lateUrl});
      result=[module.run(),Object({x:42}).x];
    }finally{globalThis.Object=original}return result
  }`)
  assert.deepEqual(await module.run(), [[42, 3], 99])
})

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`decorator descriptions keep source callables separate from private lists (${bindingUpdates})`, async t => {
    const body = `let calls=0,spreads=0,keys=0;
      function d(value){calls++;return value}
      const owner={d(value){if(this!==owner)throw Error('receiver');calls++;return value}};
      for(const fn of [d,owner.d])Object.defineProperty(fn,Symbol.isConcatSpreadable,
        {get(){spreads++;throw Error('source spread')}});
      function factory(){return d}
      function key(name){keys++;return name}
      @d class C{
        @d single(){return 1}
        @d @d multiple(){return 2}
        @owner.d bound(){return 3}
        @(factory()) [key('computed')](){return 4}
        @owner.d @d [key('paired')](){return 5}
      }
      let invalid=false,explicit=false;
      try{class Invalid{@([d]) method(){}}}catch(error){invalid=error instanceof TypeError}
      try{[].concat(d)}catch(error){explicit=error.message==='source spread'}
      const value=new C();
      return [value.single()+value.multiple()+value.bound()+value.computed()+value.paired(),
        calls,spreads,keys,invalid,explicit]`
    const runtime = new SessionRuntime({bindingUpdates,durableReplay:false})
    t.after(() => runtime.dispose())
    const moduleUrl = `data:text/javascript,${encodeURIComponent(`export function run(){${body}}`)}`
    for (const program of [body, `return (await import(${JSON.stringify(moduleUrl)})).run()`]) {
      const result = await runtime.run('decorator-lists',{program,bindings:[]})
      assert.equal(result.error,undefined,result.error?.message)
      assert.deepEqual(result.value,[15,8,1,2,true,true])
    }
  })

  test(`generated decorator operations share the storage and invocation contract (${bindingUpdates})`, async t => {
    const body = `let effects='';
      function initializer(value){effects+='init;';return value+1}
      function field(){return initializer}
      function accessor(){return {init:initializer}}
      function method(value){return value}
      for(const fn of [initializer,field,accessor,method]){
        fn.call=fn.apply=fn.bind=()=>{throw Error('source call')};
      }
      let explicit=false;try{method.call()}catch(error){explicit=error.message==='source call'}
      class C{
        @field value=40;
        @accessor accessor exposed=40;
        @accessor accessor #hidden=40;
        @method read(){return this.value+this.exposed+this.#hidden}
      }
      const instance=new C();return [instance.read(),effects,explicit]`
    const runtime = new SessionRuntime({ bindingUpdates, durableReplay:false })
    t.after(() => runtime.dispose())
    const moduleUrl = `data:text/javascript,${encodeURIComponent(`export function run(){${body}}`)}`
    for (const program of [body, `return (await import(${JSON.stringify(moduleUrl)})).run()`]) {
      const result = await runtime.run('helper-operations', {program,bindings:[]})
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, [123,'init;init;init;',true])
    }
  })
}

test('cell and workbench completion isolate private promises across persistent source mutations', async t => {
  const runtime = new SessionRuntime({durableReplay:false})
  const console = new UserBindingConsole({cwd:process.cwd(),maxWallMs:10_000,
    maxOutputBytes:64*1024,maxOldGenerationSizeMb:128})
  t.after(() => runtime.dispose())
  t.after(() => console.dispose())
  let environment
  const entries = [
    async program => {
      const result=await runtime.run('completion-protocols',{program,bindings:[]})
      assert.equal(result.error,undefined,result.error?.message)
      return result.value
    },
    async code => {
      const result=await console.run({source:'export const initial=0',code,environment})
      environment=result.environment
      assert.equal(result.error,undefined,result.error)
      return JSON.parse(result.output)
    },
  ]
  for(const run of entries){
    assert.equal(await run(`const savedThen=Promise.prototype.then;
      const savedSpecies=Object.getOwnPropertyDescriptor(Promise,Symbol.species);
      const sourcePromise=Promise.resolve(42);let constructorReads=0;
      Object.defineProperty(sourcePromise,'constructor',{get(){constructorReads++;return Promise}});
      Promise.prototype.then=()=>{throw Error('source then')};
      Object.defineProperty(Promise,Symbol.species,{configurable:true,get(){throw Error('source species')}});
      return 1`),1)
    assert.equal(await run('await null; await null; return sourcePromise'),42)
    assert.equal(await run(`let explicit=false;
      try{sourcePromise.then()}catch(error){explicit=error.message==='source then'}
      return explicit&&constructorReads===1&&Object.getPrototypeOf(sourcePromise)===Promise.prototype`),true)
    assert.equal(await run(`Promise.prototype.then=savedThen;
      Object.defineProperty(Promise,Symbol.species,savedSpecies);return 2`),2)
    assert.equal(await run(`try{await Promise.reject(null)}catch(error){return error===null}`),true)
    assert.equal(await run('return await sourcePromise'),42)
  }
})

test('file module ownership uses captured string operations while source calls remain mutable', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `export async function run(){
      const replace=String.prototype.replaceAll,includes=String.prototype.includes;
      let explicit=false,value;
      try{
        String.prototype.replaceAll=String.prototype.includes=null;
        try{'source'.replaceAll('s','S')}catch(error){explicit=error instanceof TypeError}
        value=(await import('./value.mjs')).value;
      }finally{String.prototype.replaceAll=replace;String.prototype.includes=includes}
      return [value,explicit]
    }`,
    'value.mjs': 'export const value=42',
  })
  assert.deepEqual(await (await graph.load()).run(), [42,true])
})

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`resource continuations preserve Await across worker and module entries (${bindingUpdates})`, async t => {
    const body = `const species=Object.getOwnPropertyDescriptor(Promise,Symbol.species);
      let events='';
      try{
        Object.defineProperty(Promise,Symbol.species,{configurable:true,get(){throw Error('source species')}});
        using first={[Symbol.dispose](){events+='first;'}};
        await using empty=null;
        await using last={[Symbol.asyncDispose]:async function(){events+='last;'}};
      }finally{Object.defineProperty(Promise,Symbol.species,species)}
      return events`
    const runtime = new SessionRuntime({ bindingUpdates, durableReplay:false })
    t.after(() => runtime.dispose())
    const moduleUrl = `data:text/javascript,${encodeURIComponent(`export async function run(){${body}}`)}`
    for (const program of [body, `return await (await import(${JSON.stringify(moduleUrl)})).run()`]) {
      const result = await runtime.run('resource-species', {program,bindings:[]})
      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.value, 'last;first;')
    }
  })
}
