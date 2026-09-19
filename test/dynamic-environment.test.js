import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createDynamicEnvironmentRuntime, installProgramAmbientResolver } from '../internal/dynamic-environment-runtime.js'
import { compileDynamicEnvironmentSource } from '../internal/dynamic-environment-compiler.js'

function fixture(values = {}, options = {}) {
  const variables = new Map(Object.entries(values).map(([name, value]) => {
    let current = value
    return [name, { kind: 'var', get: () => current, set: value => { current = value } }]
  }))
  const runtime = createDynamicEnvironmentRuntime()
  const environment = runtime.environment({ varFrame: variables, ...options })
  return { runtime, environment, variables, run: source => runtime.evaluate(eval, undefined, [source], environment) }
}

test('program ambient resolver owns reads, writes, typeof, deletion, and installation lifetime', () => {
  let value = 3
  const reference = {
    get: () => value,
    set: next => { value = next },
    typeof: () => typeof value,
    delete: () => false,
  }
  assert.throws(() => installProgramAmbientResolver(null), /must be a function/)
  const uninstall = installProgramAmbientResolver(name => name === 'programValue' ? reference : undefined)
  assert.throws(() => installProgramAmbientResolver(() => undefined), /already installed/)
  const runtime = createDynamicEnvironmentRuntime()
  const environment = runtime.environment()
  assert.equal(environment.reference('programValue').value, 3)
  environment.reference('programValue').value = 4
  assert.equal(value, 4)
  assert.equal(runtime.evaluate(eval, undefined, ['typeof programValue'], environment), 'number')
  assert.equal(runtime.evaluate(eval, undefined, ['delete programValue'], environment), false)
  uninstall()
  uninstall()
  assert.equal(createDynamicEnvironmentRuntime().environment().reference('programValue').typeof(), 'undefined')
})

test('parameter-created callable values preserve native inferred and absent names with captured values', () => {
  const source = `function outer(value=3, trigger=eval('value'),
    arrow=()=>value, callable=function(){return value}, Type=class {read(){return value}},
    unnamed=[()=>value,function(){return value},class {read(){return value}}]) {
    var value=9;return [arrow.name,callable.name,Type.name,arrow(),callable(),new Type().read(),
      ...unnamed.map(value=>value.name),unnamed[0](),unnamed[1](),new unnamed[2]().read()]
  };outer()`
  const context = createContext()
  const inputs = runInContext('({realmFunction:Function,intrinsicEval:eval,globalObject:globalThis})', context)
  const runtime = createDynamicEnvironmentRuntime(inputs)
  const environment = runtime.environment()
  const compiled = compileDynamicEnvironmentSource(source)
  context[compiled.environmentName] = environment
  const actual = runInContext(compiled.code, context)
  assert.deepEqual(Array.from(actual), Array.from(runInContext(source, createContext())))
})

test('with protocol keys stay fixed after the realm Symbol global changes', () => {
  const realm = createContext()
  const inputs = runInContext('({realmFunction:Function,intrinsicEval:eval,globalObject:globalThis})', realm)
  const runtime = createDynamicEnvironmentRuntime(inputs)
  const symbol = runInContext('Symbol.unscopables', realm)
  const object = { x: 2, [symbol]: { x: true } }
  const fallback = { kind: 'let', get: () => 1, set() {} }
  const env = runtime.environment({ frames: [{ kind: 'object', object },
    { kind: 'lexical', bindings: new Map([['x', fallback]]) }] })
  runInContext('globalThis.Symbol=1', realm)
  assert.equal(env.reference('x').value, 1)
  assert.equal(env.withReference('x', 1, fallback).value, 1)
})

test('global eval declarations preserve native eligibility and partial instantiation order', () => {
  const descriptors = ['{value:1}', '{get(){return 1}}', '{value:1,writable:true}',
    '{value:1,writable:true,enumerable:true}', '{value:1,configurable:true}',
    '{get(){return 1},set(value){events.push(typeof value)},configurable:true}']
  const declarations = ['var created;function blocked(){}',
    'function created(){return 2};function blocked(){}',
    'function blocked(){};function created(){}',
    'var later=1;function blocked(){};var created=2',
    'function created(){return 1};function created(){return 2};function blocked(){}']
  for (const descriptor of descriptors) for (const declaration of declarations) {
    const source = `events.push('body');${declaration}`
    const results = []
    for (const managed of [false, true]) {
      const context = createContext()
      const inputs = runInContext('({realmFunction:Function,intrinsicEval:eval,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError}})', context)
      const runtime = managed ? createDynamicEnvironmentRuntime(inputs).installIntrinsics() : undefined
      runInContext(`globalThis.events=[];Object.defineProperty(globalThis,'blocked',${descriptor})`, context)
      let error
      try {
        if (managed) runtime.evaluate(inputs.intrinsicEval, undefined, [`(0,eval)(${JSON.stringify(source)})`], runtime.environment())
        else runInContext(`(0,eval)(${JSON.stringify(source)})`, context)
      } catch (caught) { error = caught.name }
      const state = runInContext(`JSON.stringify([events,Object.hasOwn(globalThis,'created'),
        typeof created,typeof created==='function'?created():null,Object.hasOwn(globalThis,'later'),
        typeof later,typeof blocked])`, context)
      results.push({ error, state })
    }
    assert.deepEqual(results[1], results[0], `${descriptor}: ${declaration}`)
  }
})

test('local and strict eval functions do not inherit ambient property restrictions', () => {
  const context = createContext()
  const inputs = runInContext('({realmFunction:Function,intrinsicEval:eval,globalObject:globalThis})', context)
  const runtime = createDynamicEnvironmentRuntime(inputs)
  runInContext('Object.defineProperty(globalThis,"blocked",{value:1})', context)
  const environment = runtime.environment()
  const run = source => runtime.evaluate(inputs.intrinsicEval, undefined, [source], environment)
  assert.equal(run('eval(\'"use strict";function blocked(){return 2};blocked()\')'), 2)
  assert.equal(run('function local(){eval("function blocked(){return 3}");return blocked()};local()'), 3)
  assert.equal(run('globalThis.blocked'), 1)
})

test('native eval syntax reads and writes calling logical identities with native completions', () => {
  const { run, environment } = fixture({ x: 1 })
  assert.equal(run('x += 2'), 3)
  assert.equal(environment.reference('x').value, 3)
  assert.equal(run('3; var y = 4'), 3)
  assert.equal(run('y'), 4)
  assert.equal(run('var y'), undefined)
  assert.equal(run('y'), 4)
  assert.equal(run('let local = 4; local'), 4)
  assert.equal(run('typeof local'), 'undefined')
  assert.equal(run('function next() { return ++x }; next()'), 4)
  assert.equal(run('next()'), 5)
  assert.equal(run('var callable=()=>0; callable.name'), 'callable')
  assert.equal(run('var { fallback=()=>0 }={}; fallback.name'), 'fallback')
  assert.equal(run('callable=function(){}; callable.name'), 'callable')
  assert.throws(() => run('let x=1;let x=2'), SyntaxError)
  assert.throws(() => run('const x;'), SyntaxError)
  assert.throws(() => run('return 1'), SyntaxError)
})

test('native lexical TDZ, strict eval isolation and caller lexical conflicts remain observable', () => {
  let value = 1
  const { run } = fixture({}, { frames: [{ kind: 'lexical', bindings: new Map([
    ['value', { kind: 'let', get: () => value, set: next => { value = next } }],
    ['pending', { kind: 'let', get: () => { throw new ReferenceError('TDZ') }, set: () => {} }],
  ]) }] })
  assert.equal(run('value = 2'), 2)
  assert.equal(value, 2)
  assert.throws(() => run('typeof pending'), /TDZ/)
  assert.throws(() => run('var value = 3'), SyntaxError)
  assert.equal(value, 2)
  assert.equal(run('"use strict"; var value = 4; value'), 4)
  assert.equal(value, 2)
  assert.throws(() => run('later; let later=1'), ReferenceError)
  const strict = fixture({}, { strict: true })
  assert.equal(strict.run('var internal=3; internal'), 3)
  assert.equal(strict.run('typeof internal'), 'undefined')
  assert.throws(() => strict.run('with({}){}'), SyntaxError)
})

test('eval identity, non-string inputs and indirect calls retain their original behavior', () => {
  const { runtime, environment, run } = fixture({ x: 42 })
  const value = {}
  assert.equal(runtime.evaluate(eval, undefined, [value], environment), value)
  assert.equal(runtime.evaluate(eval, undefined, [], environment), undefined)
  assert.deepEqual(runtime.evaluate(function (...args) { return [this, args] }, value, ['x', 2], environment), [value, ['x', 2]])
  assert.equal(run('const eval = source => source; eval("x")'), 'x')
  assert.equal(run('eval("x")'), 42)
  assert.equal(run('(0, eval)("typeof x")'), 'undefined')
  assert.equal(run('eval?.("typeof x")'), 'undefined')
})

test('with resolves has, unscopables, getters and call receivers once in native order', () => {
  const log = []
  const target = {
    x: 1,
    call() { return this === proxy },
    [Symbol.unscopables]: { hidden: true },
  }
  const proxy = new Proxy(target, {
    has(target, name) { log.push(`has:${String(name)}`); return Reflect.has(target, name) },
    get(target, name, receiver) { log.push(`get:${String(name)}`); return Reflect.get(target, name, receiver) },
    set(target, name, value, receiver) { log.push(`set:${String(name)}`); return Reflect.set(target, name, value, receiver) },
  })
  const { run } = fixture({ object: proxy, hidden: 7 })
  assert.equal(run('with(object) { x += 2; call() }'), true)
  assert.equal(target.x, 3)
  assert.deepEqual(log, ['has:x', 'get:Symbol(Symbol.unscopables)', 'get:x',
    'has:x', 'get:Symbol(Symbol.unscopables)', 'set:x',
    'has:call', 'get:Symbol(Symbol.unscopables)', 'get:call'])
  log.length = 0
  assert.equal(run('with(object) { hidden }'), 7)
  assert.deepEqual(log, ['has:hidden'])
  const read = run('with(object) { () => x }')
  target.x = 8
  assert.equal(read(), 8)
})

test('nested eval sees native locals, this, arguments and newly created function vars', () => {
  const { run } = fixture({ x: 2 }, { getThis: () => undefined })
  assert.equal(run('this'), undefined)
  assert.equal(run('(() => this)()'), undefined)
  assert.deepEqual(run('function read(input) { let local=3; eval("local += input; var dynamic=4"); return [local,eval("dynamic"),arguments[0],this.value] }; read.call({value:9},2)'), [5, 4, 2, 9])
  assert.equal(run('let local=5; eval("local")'), 5)
  assert.throws(() => run('new.target'), SyntaxError)
  assert.equal(run('function Creator(){ return eval("new.target.name") }; new Creator()').constructor.name, 'Creator')
})

test('with retains lexical shadows, nested environments and declaration assignment targets', () => {
  const { run, environment } = fixture({ object: { x: 9 }, other: { x: 10 }, x: 1 })
  assert.equal(run('let native = 2; with(object) { native + x }'), 11)
  assert.equal(run('with(object) { let x=3; x }'), 3)
  assert.equal(run('with(object) { with(other) { x } }'), 10)
  assert.equal(run('with(object) { eval("x += 1") }'), 10)
  assert.equal(run('with(object) { var x = 11 }'), undefined)
  assert.equal(environment.reference('x').value, 1)
  assert.equal(environment.reference('object').value.x, 11)
  assert.equal(run('var {a,b=2,...rest}={a:1,c:3}; [a,b,rest.c]')[2], 3)
  assert.equal(run('var total=0; for(var i of [1,2]) total+=i; total'), 3)
  assert.equal(run('for(var j=0;j<2;j++){}; j'), 2)
  assert.deepEqual(run('var [first,,...restItems]=[1,2,3,4]; [first,restItems]'), [1, [3, 4]])
  assert.equal(run('for(var key in {one:1,two:2}){}; key'), 'two')
  assert.equal(run('for(var noInitializer;false;){}; noInitializer'), undefined)
  assert.throws(() => run('with(null){}'), TypeError)
})

test('dynamic output includes source mappings and native lexical declarations', () => {
  const compiled = compileDynamicEnvironmentSource('let x=1; x')
  assert.ok(compiled.sourceMap)
  assert.deepEqual(compiled.varNames, [])
  assert.match(compiled.code, /let x = 1/)
})

test('dynamic for-in declarations preserve native initialization, effects and completion', () => {
  const sources = [
    'var calls=0;for(var key=(calls++,"before") in {}){};[calls,key]',
    'for(var key="before" in null){};key',
    'var events=[];for(var key=(events.push("init"),"before") in (events.push(key),{a:1,b:2})){events.push(key)};[key,events]',
    'var events=[];try{for(var key=(()=>{events.push("init");throw 2})() in (events.push("source"),{})){events.push("body")}}catch(error){events.push(error)};[key,events]',
    'var key;try{for(var key=7 in (()=>{throw 2})()){} }catch{};key',
    'if(false)for(var key=(()=>{throw 1})() in {}){};key',
    'var count=0;outer:inner:for(var key=(count++,"before") in {a:1,b:2}){count++;continue outer};[key,count]',
    'var key=1;const object={key:2};with(object){for(var key=3 in {}){}};[key,object.key]',
    'var key=1;try{throw 2}catch(key){for(var key=3 in {}){};if(key!==3)throw 4};key',
    'var read;for(var key=(read=()=>key,"before") in {}){};read()',
    '11;for(var key=7 in {}){}',
  ]
  const native = Function('source', 'return eval(source)')
  for (const source of sources) {
    assert.deepEqual(fixture().run(source), native(source), source)
    assert.deepEqual(fixture().run(`eval(${JSON.stringify(source)})`), native(source), `nested ${source}`)
  }
})

test('dynamic callable publication uses native data-property name inference', async () => {
  const native = Function('source', 'return eval(source)')
  for (const kind of ['function', 'function*', 'async function', 'async function*']) {
    const source = `${kind} __proto__(){${kind.endsWith('*') ? 'yield' : 'return'} 7};__proto__`
    const expected = native(source), actual = fixture().run(source)
    assert.equal(actual.name, expected.name)
    assert.deepEqual(Object.getOwnPropertyDescriptor(actual, 'name'), Object.getOwnPropertyDescriptor(expected, 'name'))
    const value = actual()
    assert.equal(value?.next ? (await value.next()).value : await value, 7)
  }
  const sources = [
    'function create(a=eval("var x=7"),__proto__=function(){return eval("x")}){return [__proto__.name,__proto__()]};create()',
    'function create(a=eval("var x=7"),__proto__=class {read(){return eval("x")}}){return [__proto__.name,new __proto__().read()]};create()',
    'function create(a=eval("var x=7"),object={__proto__:function(){return eval("x")}}){const fn=Object.getPrototypeOf(object);return [fn.name,fn(),Object.hasOwn(object,"__proto__")]};create()',
  ]
  for (const source of sources) assert.deepEqual(fixture().run(source), native(source), source)
})

test('dynamic function publication does not depend on the optional prototype accessor', () => {
  const context = createContext()
  runInContext('delete Object.prototype.__proto__', context)
  const intrinsicEval = runInContext('eval', context)
  const runtime = createDynamicEnvironmentRuntime({ intrinsicEval, realmFunction: runInContext('Function', context), globalObject: context })
  const environment = runtime.environment()
  const value = runtime.evaluate(intrinsicEval, undefined,
    ['function __proto__(){return 7};__proto__'], environment)
  assert.equal(value.name, '__proto__')
  assert.equal(value(), 7)
})

test('parameter arrow names consume native property keys once in their source scope', () => {
  const native = Function('source', 'return eval(source)')
  const sources = [
    'const key="actual";const object={[key]:(x=eval("1"))=>x};[object.actual.name,object.actual()]',
    'const effects=[];const key={[Symbol.toPrimitive](hint){effects.push(hint);return "actual"}};const object={[key]:(x=eval("1"))=>x};[object.actual.name,object.actual(),effects]',
    'const key=Symbol("actual");const object={[key]:(x=eval("1"))=>x};[object[key].name,object[key]()]',
    'const key=Symbol();const object={[key]:(x=eval("1"))=>x};[object[key].name,object[key]()]',
    'const object={7:(x=eval("1"))=>x,__proto__:(x=eval("2"))=>x,["__proto__"]:(x=eval("3"))=>x};[object[7].name,Object.getPrototypeOf(object).name,object.__proto__.name]',
    'const key="actual";function create(a=eval("var value=4"),object={[key]:(x=eval("value"))=>x}){return object};const object=create();[object.actual.name,object.actual()]',
    'const effects=[];const key={toString(){effects.push("key");return "actual"}};function create(a=eval("1"),object={[key]:(x=eval("2"))=>x}){return object};const first=create(),second=create();[first.actual.name,first.actual(),second.actual.name,second.actual(),effects]',
  ]
  for (const source of sources) assert.deepEqual(fixture().run(source), native(source), source)
})

test('eval deletion, strict functions and call evaluation follow native behavior', () => {
  const { run, environment } = fixture({ existing: 1 })
  assert.equal(run('var created=1; delete created'), true)
  assert.equal(run('typeof created'), 'undefined')
  assert.equal(run('delete existing'), false)
  assert.equal(run('var recreated=1; recreated += (delete recreated, 2); recreated'), 3)
  assert.equal(environment.reference('recreated').value, 3)
  assert.equal(run('function strict(input) { "use strict"; return eval("arguments[0]") }; strict(7)'), 7)
  assert.deepEqual(run('let events=[]; let fn=1; try { fn(events.push(1)) } catch{}; events'), [1])
  assert.equal(run('let fn=null; let called=false; fn?.(called=true); called'), false)
  assert.equal(run('let source="1 + 1"; let eval = input => input; eval(source)'), '1 + 1')
  assert.equal(run('this'), globalThis)
  assert.equal(fixture({}, { allowNewTarget: true }).run('new.target'), undefined)
})

test('Annex B function publication follows executed declarations and enclosing lexical conflicts', () => {
  const cases = [
    'if(false) function f(){return 4}; typeof f',
    'if(true){function f(){return 4}}; f()',
    'if(false){function f(){return 4}}; typeof f',
    'function f(){if(true){function g(){return 5}}; return g()};f()',
    'let f=1; {function f(){return 4}}; f',
    'let f=1; {function f(){return 4}; f()}',
    'switch(1){case 1: function f(){return 4}};f()',
    '{function* generator(){yield 1}}; typeof generator',
    '{async function asyncFunction(){}}; typeof asyncFunction',
    '"use strict";{function f(){return 4}};typeof f',
    'function f(input){"use strict";{function g(){return input}};return typeof g};f(2)',
    '{ let eval=s=>s; eval("42") }',
    'function f(){with({arguments:7}){return arguments}};f()',
  ]
  const native = Function('source', 'return eval(source)')
  for (const source of cases) assert.deepEqual(fixture().run(source), native(source), source)
})

test('class eval retains native this, super and private lexical context', () => {
  const cases = [
    'class A { value=eval("this"); }; const a=new A(); a.value===a',
    'class A { static value=eval("this"); }; A.value===A',
    'class A { static value; static { this.value=eval("this") } }; A.value===A',
    'class A { value=eval("new.target"); }; new A().value',
    'class A { #x=1; read(){ return eval("this.#x += 2") } }; new A().read()',
    'class A { #x=1; read(){ const obj=this; return eval("#x in obj") } }; new A().read()',
    'class A { #x=1; read(){ const obj=null; return eval("obj?.#x") } }; new A().read()',
    'class A { #method(){return this}; read(){ return eval("this.#method()")===this } }; new A().read()',
    'class A { get value(){return this.x} }; class B extends A {x=3;read(){return eval("super.value")}};new B().read()',
    'class A { method(){return this.x} }; class B extends A {x=3;read(){return eval("super.method()")}};new B().read()',
    'class A { constructor(x){this.x=x} }; class B extends A {constructor(){eval("super(4)")}};new B().x',
    'class A { #x=1; read(){ return ()=>eval("this.#x") } }; new A().read()()',
    'class A { read(){const key="toString";return eval("super[key]()")}};new A().read()',
    'class A { set value(x){this.x=x} }; class B extends A {read(){return eval("super.value=3")}};new B().read()',
  ]
  const native = Function('source', 'return eval(source)')
  for (const source of cases) assert.deepEqual(fixture().run(source), native(source), source)
  assert.throws(() => fixture().run('class A { value=eval("arguments") }; new A()'), SyntaxError)
  assert.throws(() => fixture().run('class A { #x; read(){ return eval("this.#missing") } }; new A().read()'), SyntaxError)
  assert.throws(() => compileDynamicEnvironmentSource('super()', { allowSuper: true }), SyntaxError)
  assert.equal(fixture({}, { strict: true }).run('"use strict"; 2'), 2)
})

test('ordinary parameter eval preserves argument bindings and activation isolation', () => {
  const cases = [
    'function f(a=eval("var x=1"),b=eval("x")){return [b,x]};[f(),typeof x]',
    'function f(a=eval("var x=1")){var x;return x};f()',
    'function f(a=eval("arguments.length")){return a};f()',
    'function f(a=eval("arguments=5"),b=eval("arguments")){return [b,arguments]};f()',
    'function f(arguments=eval("3")){return eval("arguments")};f()',
    'const object={f(a=eval("var x=2"),b=eval("x")){return [b,x]}};object.f()',
    'function f(a=eval("arguments=5")){var arguments;return arguments};f()',
    'const f=(a=eval("var x=1"),b=eval("x"))=>[b,x];[f(),f(),typeof x,f.name,f.length]',
    'function f(){return ((a=eval("arguments[0]"))=>a)()};f(3)',
    'function f(a=eval("var x=2"),read=function(){return eval("x")}){return read};f()()',
    'function f(a=eval("var x=2"),object={read(){return eval("x")}}){return object};f().read()',
    'function f(a=eval("var x=2"),Class=class{value=eval("x");read(){return eval("x")}}){return new Class};const instance=f();[instance.value,instance.read()]',
    'function outer(undefined){const arrow=()=>eval("this");return arrow()===this};outer.call({value:1},7)',
    'function outer(undefined){return ((input=eval("this"))=>input)()===this};outer.call({value:1},7)',
  ]
  const native = Function('source', 'return eval(source)')
  for (const source of cases) assert.deepEqual(fixture().run(source), native(source), source)
})

test('dynamic ambient and object references preserve failed writes and deletion', () => {
  const globalObject = Object.assign(Object.create(null), { writable: 1 })
  Object.defineProperty(globalObject, 'fixed', { value: 2, configurable: false })
  const runtime = createDynamicEnvironmentRuntime({ globalObject })
  const environment = runtime.environment()
  const run = source => runtime.evaluate(eval, undefined, [source], environment)
  assert.equal(run('created=3'), 3)
  assert.equal(globalObject.created, 3)
  assert.equal(run('fixed=4'), 4)
  assert.equal(globalObject.fixed, 2)
  assert.equal(run('delete created'), true)
  assert.equal(run('typeof created'), 'undefined')
  assert.equal(run('delete fixed'), false)
  assert.throws(() => run('"use strict"; absent=3'), ReferenceError)
  assert.throws(() => run('"use strict"; fixed=3'), TypeError)
  const object = { removable: 1 }
  Object.defineProperty(object, 'fixed', { value: 2, configurable: false })
  const objectEnvironment = environment.withObject(object)
  assert.equal(runtime.evaluate(eval, undefined, ['delete removable'], objectEnvironment), true)
  assert.equal(runtime.evaluate(eval, undefined, ['delete fixed'], objectEnvironment), false)
  const strictEnvironment = objectEnvironment.capture([], true)
  assert.throws(() => { strictEnvironment.reference('fixed').value = 4 }, TypeError)
  assert.throws(() => strictEnvironment.reference('fixed').delete(), TypeError)
})

test('saved dynamic closures retain the originating source proof for later writes', () => {
  const runtime = createDynamicEnvironmentRuntime()
  const writes = []
  let value = 1
  const environment = runtime.environment({ nativeBindings: [['value', { kind: 'var', get: () => value,
    set(next, strict, origin) { value = next; writes.push({ value, strict, origin }) } }]] })
  const later = runtime.evaluate(eval, undefined, ['() => ++value'], environment.at('original-source'))
  assert.equal(later(), 2)
  assert.deepEqual(writes, [{ value: 2, strict: false, origin: 'original-source' }])
})

test('dynamic imports retain the selected module operation and exact option effects', async () => {
  const calls = []
  const namespace = Object.freeze({ value: 42 })
  const options = { with: { type: 'json' } }
  const runtime = createDynamicEnvironmentRuntime({ importModule(source, attributes) {
    calls.push([source, attributes])
    return Promise.resolve(namespace)
  } })
  const environment = runtime.environment({ nativeBindings: [
    ['options', { kind: 'const', get: () => options }],
  ] })
  const result = runtime.evaluate(eval, undefined,
    ['let reads=0;const selected={get source(){reads++;return "./values.json"}};import(selected.source,options).then(ns=>[ns,reads])'], environment)
  const [actual, reads] = await result
  assert.equal(actual, namespace)
  assert.equal(reads, 1)
  assert.deepEqual(calls, [['./values.json', options]])
  const native = fixture()
  assert.equal(await native.run('import("node:buffer").then(namespace=>namespace.Buffer)'), Buffer)
  assert.equal(native.run('(0,eval)("this")'), globalThis)
  assert.throws(() => native.run('(0,eval)("new.target")'), SyntaxError)
})

test('TypeScript reference wrappers preserve writes and receivers in both dynamic preparation paths', () => {
  const runtime = createDynamicEnvironmentRuntime()
  for (const staticOnly of [false, true]) {
    const source = `let value=1;
      (value as number)+=2;
      const object={method(){return this===object}};
      const receiver=(object.method satisfies Function)!();
      const before=(<number>value)++;
      return [before,value,receiver]`
    const compiled = compileDynamicEnvironmentSource(source, { cell: {
      environmentName: 'environment', parserPlugins: ['typescript'], staticOnly, nativeRoot: true,
    } })
    assert.deepEqual(new Function('environment', compiled.code)(runtime.environment()), [3, 4, true])
  }
})

test('direct dynamic compiler retains sloppy block-function publication and initialized iteration effects', () => {
  const sources = [
    'var effects=[];if(true){function read(){return 7}};[read(),effects]',
    'var effects=[];for(var key=(effects.push("init"),"before") in (effects.push(key),{a:1,b:2})){effects.push(key)};[key,effects]',
  ]
  for (const source of sources) {
    const runtime = createDynamicEnvironmentRuntime()
    const compiled = compileDynamicEnvironmentSource(source)
    const actual = new Function(compiled.environmentName, `return eval(${JSON.stringify(compiled.code)})`)(runtime.environment())
    assert.deepEqual(actual, (0, eval)(`(()=>{return eval(${JSON.stringify(source)})})()`))
  }
})
