import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'

for (const declaration of ['let value=1', 'var value=1', 'function value(){return 1}']) {
  test(`migration preserves native writable storage for ${declaration}`, async t => {
    const runtime = new SessionRuntime({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
    t.after(() => runtime.dispose())
    const run = async program => {
      const result = await runtime.run('writable-native-migration', { program, bindings: [] })
      assert.equal(result.error, undefined, result.error?.message)
      return result.value
    }
    await run(`${declaration};const read=()=>value;const write=next=>value=next`)
    runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false })
    assert.deepEqual(await run('let value=2;return [read(),value]'), [2,2])
    assert.deepEqual(await run('let [value]=[3];return [read(),value]'), [3,3])
    assert.deepEqual(await run('write(4);return [read(),value]'), [4,4])
    runtime.reconfigure({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
    assert.deepEqual(await run('return [read(),value]'), [4,4])
  })
}

for (const prefix of ['', 'await 0;']) test(`migration keeps native lexical precedence and excludes absent object storage (${prefix || 'sync'})`, async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('native-migration-storage', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
  await run(`${prefix}let value=1;Object.defineProperty(globalThis,'value',{value:50,configurable:false});
    removed=2;const deleted=delete globalThis.removed;const read=()=>value;const write=next=>value=next;return [deleted,typeof removed]`).then(value => {
    assert.deepEqual(value, [true,'undefined'])
  })
  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false })
  assert.deepEqual(await run('let [value,removed]=[3,4];return [read(),value,globalThis.value,removed,typeof globalThis.removed]'),
    [3,3,50,4,'undefined'])
  runtime.reconfigure({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
  assert.deepEqual(await run('write(5);return [eval("value"),Function("return value")(),read(),globalThis.value]'), [5,5,5,50])
  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false })
  assert.deepEqual(await run('let [value]=[6];return [read(),value,globalThis.value]'), [6,6,50])
})

test('failed native lexical initialization cannot make unrelated object storage writable', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
  t.after(() => runtime.dispose())
  const run = program => runtime.run('uninitialized-native-lexical', { program, bindings: [] })
  const failed = await run(`Object.defineProperty(globalThis,'value',{value:50,configurable:false});
    const read=()=>{try{return value}catch(error){return error.name}};let value=(()=>{throw Error('initializer')})()`)
  assert.match(failed.error.message, /initializer/)
  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false })
  const result = await run('let [value]=[3];return [read(),value,globalThis.value]')
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, ['ReferenceError',3,50])
})

test('native object declaration evidence does not override current property protection', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('protected-native-object', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
  await run('var value=1;const read=()=>value;Object.defineProperty(globalThis,"value",{value:1,writable:false,configurable:false});void 0')
  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false })
  assert.deepEqual(await run('let [value]=[3];return [read(),<number>value,globalThis.value]'), [1,3,1])
})

test('pattern revisions preserve migrated writable storage and captured references', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('legacy-pattern-publication', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
  await run(`let x=1,y=2;const fixed=3;
    const read=()=>[x,y,fixed];const write=value=>x=value`)
  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false })
  assert.deepEqual(await run('let [x,y]=[10,20];return [read(),x,y]'), [[10,20,3],10,20])
  assert.deepEqual(await run('const {x,y,fixed}={x:11,y:21,fixed:31};return [read(),x,y,fixed]'), [[11,21,3],11,21,31])
  assert.deepEqual(await run(`
    const effects=[];
    try{let [x,y=(()=>{effects.push('default');throw Error('stop')})()]=[99]}catch(error){effects.push(error.message)}
    return [read(),x,y,fixed,effects]`), [[11,21,3],11,21,31,['default','stop']])
  assert.deepEqual(await run('const [x,readCandidate=()=>x]=[12];write(13);return [read(),readCandidate(),x]'), [[13,21,3],13,13])
  assert.deepEqual(await run('let x=14;return [read(),readCandidate(),x]'), [[14,21,3],14,14])
  assert.deepEqual(await run('for(var [x,y] of [[15,25]]){};return [read(),readCandidate()]'), [[15,25,3],15])
  runtime.reconfigure({ legacyBindingSettings: true, looseTopLevelRedeclarations: false, durableReplay: false })
  assert.deepEqual(await run('return [read(),x,y,fixed]'), [[15,25,3],15,25,3])
})

test('whole-pattern publication completes storage before announcing changed bindings', () => {
  const native = { old: 1, overlay: 9 }
  const observations = []
  let observing = false
  const owner = createStatefulRootRuntime({
    readAmbient: name => native[name],
    writeAmbient: (name, value) => { native[name] = value },
    hasOverlay: name => name === 'overlay',
    changed(name) { if (observing) observations.push([name, native.old, owner.read('fresh')]) },
  })
  const root = owner.begin({ declared: ['fresh'], known: ['old'], legacyWritable: ['old'], committed() {} })
  const candidate = root.candidate(['old', 'fresh', 'overlay'])
  candidate.values.old = 2
  candidate.values.fresh = 3
  candidate.values.overlay = 10
  observing = true
  candidate.commit('pattern')
  assert.deepEqual(observations, [['old',2,3],['fresh',2,3]])
  assert.deepEqual(native, { old: 2, overlay: 10 })
  native.old = 4
  assert.equal(candidate.values.old, 4)
  candidate.values.old = 5
  assert.equal(native.old, 5)
})
