import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'

function fixture() {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const runtime = createDynamicEnvironmentRuntime(intrinsics).installIntrinsics()
  const environment = runtime.environment()
  return { context, runtime, environment, run: source => runtime.evaluate(intrinsics.intrinsicEval, undefined, [source], environment) }
}

test('ordinary invocation keeps the source caller across native call forms and parameters', () => {
  const { run } = fixture()
  const calls = ['f()', '({f}).f()', 'f?.()', '({f}).f?.()', 'f.call(null)', 'f.apply(null,[])',
    'Reflect.apply(f,null,[])', 'f.bind(null)()', 'f`tag`']
  for (const call of calls) {
    assert.equal(run(`(function(){function f(){return f.caller===g}function g(){return ${call}}return g()})()`), true, call)
  }
  assert.equal(run('(function(){function f(){return f.caller===g}function g(value=f()){return value}return g()})()'), true)
  assert.equal(run('(function(){function F(){this.ok=F.caller===g}function g(){return new F()}return g().ok})()'), true)
  assert.equal(run('(function(){function F(){this.ok=F.caller===g}function g(){return Reflect.construct(F,[])}return g().ok})()'), true)
})

test('native ordinary dispatch does not observe extra callable properties', () => {
  const { run } = fixture()
  assert.equal(run(`(function(){const events=[];function f(){return f.caller===g}
    const proxy=new Proxy(f,{get(target,key,receiver){events.push(key);return Reflect.get(target,key,receiver)}});
    function g(){return proxy()};const value=g();return value&&events.length===0})()`), true)
})

test('native alias argument lists are read once with the original source caller', () => {
  const { run } = fixture()
  assert.equal(run(`(function(){let reads=0,caller=true;
    function length(){reads++;caller=caller&&length.caller===g;return 1}
    const args={get 0(){reads++;return null}};
    Object.defineProperty(args,'length',{get:length});
    function f(){return f.caller===g}
    function g(){return Reflect.apply(Function.prototype.call,f,args)}
    return g()&&caller&&reads===2
  })()`), true)
})

test('catch destructuring restores context before native getters execute', () => {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const create = value => {
    const runtime = createDynamicEnvironmentRuntime(intrinsics).installIntrinsics()
    const root = runtime.environment({ nativeBindings: [['value', { kind: 'let', get: () => value }]] })
    runtime.setRootEnvironment(() => root)
    return { runtime, run: source => runtime.evaluate(intrinsics.intrinsicEval, undefined, [source], root) }
  }
  const first = create(1)
  const second = create(2)
  context.savedEval = first.runtime.exposedIntrinsic(intrinsics.intrinsicEval)
  runInContext('globalThis.fail=()=>{throw {get value(){return savedEval("value")}}}', context)
  context.old = first.run('()=>fail()')
  assert.equal(second.run('(function(){try{old()}catch({value}){return value}})()'), 2)
})

test('template arguments finish before non-callable validation and failed contexts restore', () => {
  const { run } = fixture()
  assert.deepEqual(JSON.parse(JSON.stringify(run(`const events=[];let message;
    const object={get tag(){events.push('get');return 1}};
    try{object.tag\`first\${events.push('argument')}last\`}catch(error){message=error.message}
    [events,message]`))), [['get','argument'],'object.tag is not a function'])
})

test('native tags retain cached frozen template objects, receivers and substitution order', () => {
  const { run } = fixture()
  assert.equal(run(`(function(){
    const events=[];let saved;
    const object={get tag(){events.push('get');return function tag(parts,value){
      events.push(value);const stable=saved===undefined||saved===parts;saved=parts;
      return stable&&Object.isFrozen(parts)&&Object.isFrozen(parts.raw)&&this===object&&tag.caller===g
    }}};
    function g(){return object.tag\`first\${(events.push('argument'),'value')}last\`}
    return g()&&g()&&events.join(',')==='get,argument,value,get,argument,value'
  })()`), true)
  assert.equal(run(`(function(){let calls=0;const object={tag(){return this===object}};
    const first=(object?.tag)\`a\${++calls}\`;
    try{(null?.tag)\`b\${++calls}\`}catch{}
    return first&&calls===2
  })()`), true)
})

test('source eval shadowing and overrides do not change native invocation lifetime', () => {
  const { run } = fixture()
  assert.equal(run(`(function(){function f(){return f.caller===g}
    function g(eval=f){return eval()};return g()
  })()`), true)
  assert.equal(run(`globalThis.eval=()=>false;
    (function(){function f(){return f.caller===g}function g(){return f()}return g()})()`), true)
})

test('an opaque catch restores its owner after a compiled callback throws', () => {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const interfaceOwner = {}
  const first = createDynamicEnvironmentRuntime({ ...intrinsics, interfaceOwner }).installIntrinsics()
  const second = createDynamicEnvironmentRuntime({ ...intrinsics, interfaceOwner }).installIntrinsics()
  const firstRoot = first.environment({ nativeBindings: [['value', { kind: 'let', get: () => 1 }]] })
  const secondRoot = second.environment({ nativeBindings: [['value', { kind: 'let', get: () => 2 }]] })
  first.setRootEnvironment(() => firstRoot)
  second.setRootEnvironment(() => secondRoot)
  runInContext('globalThis.fail=()=>{throw 1};globalThis.opaque=(callback,next)=>{try{callback()}catch{};return next("value")}', context)
  context.old = first.evaluate(intrinsics.intrinsicEval, undefined, ['()=>fail()'], firstRoot)
  assert.equal(second.evaluate(intrinsics.intrinsicEval, undefined, ['opaque(old,eval)'], secondRoot), 2)
  context.old = first.evaluate(intrinsics.intrinsicEval, undefined, ['(value=fail())=>value'], firstRoot)
  assert.equal(second.evaluate(intrinsics.intrinsicEval, undefined, ['opaque(old,eval)'], secondRoot), 2)
})
