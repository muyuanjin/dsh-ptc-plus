import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { SessionRuntime } from '../internal/session-runtime.js'

for (const [mode, options] of [['stateful', { bindingUpdates: 'stateful' }],
  ['protected', { bindingUpdates: 'protected' }], ['legacy', { legacyBindingSettings: true }]]) {
  test(`internal argument transport ignores slice, species and iterators (${mode})`, async t => {
    const runtime = new SessionRuntime({ ...options, durableReplay: false })
    t.after(() => runtime.dispose())
    const result = await runtime.run('argument-transport', { bindings: [], program: `
      const savedSlice=Array.prototype.slice,savedIterator=Array.prototype[Symbol.iterator];
      const savedSpecies=Object.getOwnPropertyDescriptor(Array,Symbol.species);
      let effects=0;const values=[];function f(x){return x};function C(x){this.x=x}
      Array.prototype.slice=()=>{effects++;return [99]};Array.prototype[Symbol.iterator]=null;
      Object.defineProperty(Array,Symbol.species,{configurable:true,get(){effects++;return Array}});
      try{
        values[0]=f.call(null,7);values[1]=f.apply(null,{0:8,length:1});
        values[2]=f.bind(null,9)();values[3]=new (C.bind(null,10))().x;
        values[4]=Function.bind(null,'return 11')()();
        values[5]=Reflect.apply(f,null,{0:12,length:1});
        values[6]=await Promise.resolve(13).then(f.bind(null));
      }finally{Array.prototype.slice=savedSlice;Array.prototype[Symbol.iterator]=savedIterator;
        Object.defineProperty(Array,Symbol.species,savedSpecies)}
      return [values,effects]
    ` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [[7,8,9,10,11,12,13],0])
  })

  test(`dynamic frame transport ignores user array iterators (${mode})`, async t => {
    const runtime = new SessionRuntime({ ...options, durableReplay: false })
    t.after(() => runtime.dispose())
    const result = await runtime.run('frame-transport', { bindings: [], program: `
      const saved=Array.prototype[Symbol.iterator];const values=[];
      Array.prototype[Symbol.iterator]=null;
      try{
        values[0]=(function(){let x=7;return eval('x')})();
        values[1]=(function(x=eval('8')){return eval('x')})();
        values[2]=(function(){eval('function created(){return 9}');return created()})();
        values[3]=(function(){let x=10;return ()=>eval('x')})()();
        values[4]=Function('let x=11;return eval("x")')();
      }finally{Array.prototype[Symbol.iterator]=saved}
      return values
    ` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [7,8,9,10,11])
  })
}

test('runtime views keep the original realm reflection operations after user mutation', () => {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const initial = createDynamicEnvironmentRuntime(intrinsics)
  runInContext(`globalThis.ambient=2;
    Reflect.get=()=>99;Reflect.has=()=>false;Reflect.set=()=>false;Reflect.deleteProperty=()=>false;
    Reflect.defineProperty=()=>false`, context)
  for (const runtime of [initial, createDynamicEnvironmentRuntime(intrinsics)]) {
    const environment = runtime.environment()
    assert.equal(environment.reference('ambient').value, 2)
    environment.reference('ambient').value = 3
    assert.equal(environment.reference('ambient').value, 3)
    assert.equal(environment.reference('ambient').typeof(), 'number')
    environment.reference('temporary').value = 4
    assert.equal(environment.reference('temporary').delete(), true)
    assert.equal(environment.reference('temporary').typeof(), 'undefined')
    const object = { value: 5, removable: 6 }
    const selected = environment.withObject(object)
    assert.equal(selected.reference('value').value, 5)
    selected.reference('value').value = 7
    assert.equal(object.value, 7)
    assert.equal(selected.reference('removable').delete(), true)
    assert.equal('removable' in object, false)
    const callable = environment.parameterArrow((key, value) => value, 'arrow')
    assert.equal(callable.name, 'arrow')
    assert.equal(callable.length, 1)
    assert.equal(callable(8), 8)
    environment.reference('ambient').value = 2
  }
  assert.deepEqual(Array.from(runInContext('[Reflect.get({},"value"),Reflect.has({},"value"),Reflect.set({},"value",1),Reflect.deleteProperty({},"value"),Reflect.defineProperty({},"value",{value:1})]', context)),
    [99, false, false, false, false])
})

test('worker references preserve user Reflect overrides across cells and legacy runtime views', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false, maxWallMs: 10_000 })
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('reference-intrinsics', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
  const expected = [[5, 7, true], 5, false]
  assert.deepEqual(await run(`const reflectionCalls=[];
    function inspectReferences(){
      const object={value:2,removable:6,hidden:9,[Symbol.unscopables]:{hidden:true}};
      const hidden=7;let result;
      with(object){value+=3;result=[value,hidden,delete removable]}
      return [result,object.value,'removable' in object]
    }
    Reflect.get=(...args)=>{reflectionCalls.push('get');return 99};
    Reflect.has=(...args)=>{reflectionCalls.push('has');return false};
    Reflect.set=(...args)=>{reflectionCalls.push('set');return false};
    Reflect.deleteProperty=(...args)=>{reflectionCalls.push('delete');return false};
    return [inspectReferences(),reflectionCalls]`), [expected, []])
  const inspect = `return [inspectReferences(),
    [Reflect.get({},'value'),Reflect.has({},'value'),Reflect.set({},'value',1),Reflect.deleteProperty({},'value')],
    reflectionCalls.splice(0)]`
  const observed = [expected, [99, false, false, false], ['get', 'has', 'set', 'delete']]
  assert.deepEqual(await run(inspect), observed)
  runtime.reconfigure({ legacyBindingSettings: true, durableReplay: false, maxWallMs: 10_000 })
  assert.deepEqual(await run(`let legacyView=3;
    with({value:2}){legacyView+=value};
    ${inspect.replace('inspectReferences(),', 'inspectReferences(),legacyView,')}`),
  [expected, 5, observed[1], observed[2]])
  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false, maxWallMs: 10_000 })
  assert.deepEqual(await run(inspect), observed)
})
