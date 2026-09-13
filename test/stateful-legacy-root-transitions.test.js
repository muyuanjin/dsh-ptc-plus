import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { prepareProgram } from '../internal/cell-analysis.js'
import { BindingCatalog } from '../internal/session-state.js'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { appendRunCodeEvents } from './plugin-fixture.js'
import { createHostContext } from './host-fixture.js'
import { apply } from '../index.js'
import { createContext, runInContext } from 'node:vm'
import { createNativeRootDynamic } from '../internal/native-root-dynamic.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'

function fixture(t, bindingUpdates = 'stateful') {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false, maxWallMs: 10_000 })
  t.after(() => runtime.dispose())
  const session = { id: `root-transitions-${t.name}` }
  return {
    runtime,
    configure(config) { runtime.reconfigure({ durableReplay: false, maxWallMs: 10_000, ...config }) },
    result(program) { return runtime.run(session, { program, bindings: [] }) },
    async run(program) {
      const result = await runtime.run(session, { program, bindings: [] })
      assert.equal(result.error, undefined, result.error?.message)
      return result.value
    },
  }
}

test('readonly legacy properties are replaced by logical declarations without rewriting old captures', async t => {
  for (const afterTransition of [false,true]) for (const accessor of [false,true]) {
    await t.test(`after=${afterTransition}, accessor=${accessor}`, async t => {
      const { run, configure } = fixture(t)
      configure({ legacyBindingSettings: true, looseTopLevelRedeclarations: false })
      // Node 26 gives the REPL a realm global, where a fresh `var` binding is
      // non-configurable; an existing property keeps its descriptor, so the
      // fixture establishes the global every supported host must observe.
      await run("Object.defineProperty(globalThis,'x',{value:1,writable:true,enumerable:true,configurable:true});return 1")
      await run('var x=1;const old=()=>x')
      if (afterTransition) {
        configure({ bindingUpdates: 'stateful' })
        await run('return x')
      }
      await run(`Object.defineProperty(globalThis,'x',${accessor ? '{get(){return 1},configurable:true}' : '{value:1,writable:false}'});return 1`)
      configure({ bindingUpdates: 'stateful' })
      assert.deepEqual(await run('const x=2;return [x,old(),globalThis.x]'), [2,1,1])
      assert.deepEqual(await run('x=3;return [x,old(),globalThis.x]'), [3,1,1])
    })
  }
})

test('legacy bridge declaration provenance replaces earlier assignment evidence', async t => {
  const { runtime, run, configure } = fixture(t)
  configure({ legacyBindingSettings: true, looseTopLevelRedeclarations: false })
  await run('let x=1;const old=()=>x')
  configure({ bindingUpdates: 'stateful' })
  const source = () => [...runtime.kernels.values()][0].bindingCatalog.snapshot().find(item => item.name === 'x').definition.source
  assert.equal(await run('x=2;return old()'), 2)
  assert.equal(source(), 'x=2')
  assert.equal(await run('let x=3;return old()'), 3)
  assert.equal(source(), 'let x=3;')
  await run('x=4;return x')
  assert.equal(await run('let [x]=[5];return old()'), 5)
  assert.equal(source(), 'let [x]=[5];')
})

test('legacy accessor setters remain the shared writable binding after transition', async t => {
  const { run, configure } = fixture(t)
  configure({ legacyBindingSettings: true, looseTopLevelRedeclarations: false })
  // The accessor replaces an existing property, so its descriptor must not
  // depend on how the host REPL creates a fresh global `var` (see above).
  await run("Object.defineProperty(globalThis,'x',{value:1,writable:true,enumerable:true,configurable:true});return 1")
  await run(`var x=1;let stored=1;const writes=[];const old=()=>x;
    Object.defineProperty(globalThis,'x',{get(){return stored},set(value){writes.push(value);stored=value},configurable:true});return 1`)
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('const x=2;return [x,old(),globalThis.x,writes]'), [2,2,2,[2]])
  assert.deepEqual(await run('const [x]=[3];return [x,old(),globalThis.x,writes]'), [3,3,3,[2,3]])
})

test('stateful roots survive an old-setting update to legacy and back', async t => {
  const { run, configure } = fixture(t)
  await run('let value=1;const read=()=>value')
  configure({ looseTopLevelRedeclarations: false })
  assert.deepEqual(await run('return [value,read()]'), [1,1])
  assert.deepEqual(await run('value=2;return [value,read()]'), [2,2])
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('return [value,read()]'), [2,2])
})

test('legacy closures capture bridged roots and preserve native local declarations', async t => {
  const { run, configure } = fixture(t)
  await run('let value=1;const read=()=>value')
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run(`
    const fromLegacy=()=>value;
    const updateLegacy=next=>value=next;
    function local(){let value=7;const read=()=>value;value++;return read()}
    return [fromLegacy(),local()]`), [1,8])
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('value=3;return [fromLegacy(),updateLegacy(4),read(),local()]'), [3,4,4,8])
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run('let value=5;return [fromLegacy(),read(),local()]'), [5,5,8])
})

test('every live language transition keeps mutable roots and saved closures', async t => {
  const modes = { stateful: { bindingUpdates: 'stateful' }, protected: { bindingUpdates: 'protected' },
    legacy: { legacyBindingSettings: true } }
  for (const [first, initial] of Object.entries(modes)) for (const [second, next] of Object.entries(modes)) {
    await t.test(`${first} to ${second}`, async t => {
      const { run, configure } = fixture(t)
      configure(initial)
      await run('let value=1;const read=()=>value')
      configure(next)
      assert.deepEqual(await run('value++;return [value,read()]'), [2,2])
      configure(initial)
      assert.deepEqual(await run('value++;return [value,read()]'), [3,3])
    })
  }
})

test('protected roots retain writability and declaration collision policy in legacy', async t => {
  const { run, result, configure } = fixture(t, 'protected')
  await run('let value=1;const fixed=7;const read=()=>[value,fixed]')
  configure({ looseTopLevelRedeclarations: false })
  assert.deepEqual(await run('value=2;return read()'), [2,7])
  assert.match((await result('fixed=9')).error.message, /constant/)
  assert.match((await result('let value=9')).error.message, /value/)
  assert.match((await result('const fixed=9')).error.message, /fixed/)
  configure({ bindingUpdates: 'protected' })
  assert.deepEqual(await run('return read()'), [2,7])
  assert.match((await result('fixed=9')).error.message, /constant/)
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('const fixed=8;return read()'), [2,8])
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run('fixed=9;return read()'), [2,9])
})

test('logical imports stay live and legacy writes change their shared source', async t => {
  const { run, result, configure } = fixture(t)
  await run(`import {basename as value} from 'node:path';const saved=value;const read=()=>value`)
  configure({ looseTopLevelRedeclarations: false })
  assert.deepEqual(await run(`return [value('a/b'),read()===saved]`), ['b',true])
  assert.match((await result(`import {dirname as value} from 'node:path'`)).error.message, /value/)
  assert.deepEqual(await run(`value=()=> 'local';return [value(),read()(),saved('a/b')]`), ['local','local','b'])
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run(`return [value(),read()()]`), ['local','local'])
  await run(`import {dirname as value} from 'node:path'`)
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run(`return [value('a/b'),read()===value,saved('a/b')]`), ['a',true,'b'])
  assert.deepEqual(await run(`const value=()=> 'redeclared';return [value(),read()()]`), ['redeclared','redeclared'])
})

test('legacy native import closures retain their namespace after a logical round trip', async t => {
  const { run, configure } = fixture(t)
  configure({ legacyBindingSettings: true })
  await run(`import {basename as value} from 'node:path';const read=()=>value`)
  configure({ bindingUpdates: 'stateful' })
  assert.equal(await run(`const logicalRead=()=>value;value('a/b')`), 'b')
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run(`const value=()=> 'native';return [value(),logicalRead()(),read()('a/b')]`), ['native','native','b'])
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run(`return [value(),read()('a/b')]`), ['native','b'])
})

test('failed legacy cells preserve completed writes and original logical closures', async t => {
  const { run, result, configure } = fixture(t)
  await run('let value=1;const read=()=>value;const later=()=>introduced=7')
  configure({ legacyBindingSettings: true })
  assert.match((await result(`value=2;throw new Error('stopped')`)).error.message, /stopped/)
  assert.deepEqual(await run('return [value,read()]'), [2,2])
  assert.match((await result(`let value=(()=>{throw new Error('initializer')})();`)).error.message, /initializer/)
  assert.deepEqual(await run('return [value,read()]'), [2,2])
  assert.match((await result(`later();throw new Error('after publication')`)).error.message, /after publication/)
  assert.equal(await run('introduced'), 7)
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('return [value,read(),introduced]'), [2,2,7])
})

test('bridged legacy eval, constructors, with scopes and await share current roots', async t => {
  const { run, configure } = fixture(t)
  await run('let value=1;const read=()=>value')
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run(`
    eval('value++');
    const direct=eval('value');
    const constructed=Function('return value')();
    const indirect=['value'].map(eval)[0];
    const box={value:10};with(box){value++;}
    const pending=await Promise.resolve('value').then(eval);
    return [direct,constructed,indirect,pending,value,read(),box.value]`), [2,2,2,2,2,2,11])
  assert.deepEqual(await run(`await Promise.resolve();value++;return [value,read()]`), [3,3])
  configure({ bindingUpdates: 'protected' })
  assert.deepEqual(await run('return [value,read()]'), [3,3])
})

test('legacy bridge preparation uses proved roots and preserves source generations', () => {
  const legacy={languageSemantics:'legacy-v1',bindingPolicy:{variableRedeclarations:true,functionClassRedeclarations:true},
    rewritesEnabled:{autoRewriteImports:true,autoStripExports:true,autoSplitRedeclarations:true}}
  const source='let value=1;const read=()=>value'
  const first=prepareProgram(source,{languageSemantics:'stateful-v1'})
  const catalog=new BindingCatalog().advance(first,source,first.commitTargets,
    [{name:'value',source:'local'},{name:'read',source:'local'}])
  const prepared=prepareProgram('value=2',{...catalog.inputs(),...legacy})
  assert.equal(prepared.languageSemantics,'legacy-v1')
  assert.deepEqual(prepared.rootBindings.established,[['value','local'],['read','local']])
  assert.equal(prepareProgram('value=2',{knownBindings:new Set(['value']),...legacy}).rootBindings,undefined)
  const next=catalog.advance(prepared,'value=2',new Set(),[{name:'value',source:'local'},{name:'read',source:'local'}])
  assert.equal(next.inputs().nativeBindings.has('value'),false)
})

test('mixed logical and legacy journals replay their recorded policies and shared writes', async t => {
  const session = { id: 'mixed-root-generations', events: [] }
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', maxWallMs: 10_000 })
  t.after(() => runtime.dispose())
  const cells = [
    ['stateful-v1', { bindingUpdates: 'stateful' }, 'let value=1;const read=()=>value;return read()', 1],
    ['legacy-v1', { looseTopLevelRedeclarations: false }, 'value=2;return read()', 2],
    ['protected-v1', { bindingUpdates: 'protected' }, 'value=3;return read()', 3],
    ['legacy-v1', { legacyBindingSettings: true }, 'let value=4;return read()', 4],
  ]
  for (const [languageSemantics, config, program, expected] of cells) {
    runtime.reconfigure({ maxWallMs: 10_000, ...config })
    const execution = await runtime.runTentative({ id: session.id, session, persistedCallSeq: session.events.length }, { program, bindings: [] })
    assert.equal(execution.result.error, undefined, execution.result.error?.message)
    assert.equal(execution.result.value, expected)
    assert.equal(execution.settlement.journal.status, 'durable')
    assert.equal(execution.settlement.journal.languageSemantics, languageSemantics)
    runtime.finalize(execution.settlement, true)
    appendRunCodeEvents(session.events, `mixed-root-${session.events.length}`, program,
      { meta: { [JOURNAL_KEY]: execution.settlement.journal } })
  }
  await runtime.disposeSession(session.id)
  runtime.reconfigure({ bindingUpdates: 'protected', maxWallMs: 10_000 })
  const replayed = await runtime.runTentative({ id: session.id, session, persistedCallSeq: session.events.length },
    { program: 'return [value,read()]', bindings: [] })
  assert.equal(replayed.result.error, undefined, replayed.result.error?.message)
  assert.equal(replayed.settlement.recoveryBoundaries, undefined)
  assert.deepEqual(replayed.result.value, [4,4])
  runtime.finalize(replayed.settlement, true)
})

test('public settings updates preserve the active worker logical roots', async t => {
  const host = createHostContext()
  t.after(async () => { while (host.cleanups.length > 0) await host.cleanups.pop()() })
  let current = { enabled: true, durableReplay: false, maxWallMs: 10_000 }
  let update
  const settings = {
    installSection(_owner, _namespace, _schema, _entry, hooks) {
      hooks.setSource(() => current)
      update = async next => { current = next; await hooks.onChange() }
      hooks.onChange()
    },
    async update(_namespace, patch) { await update({ ...current, ...patch }) },
  }
  const definition = { name: 'run_code', parameters: { type: 'object', properties: {
    code: { type: 'string' }, description: { type: 'string' },
  }, required: ['code', 'description'], additionalProperties: false }, output: {} }
  const codeRuntime = { language: 'typescript', isolation: 'worker-thread', run() { throw new Error('unexpected upstream execution') } }
  const ctx = { ...host.ctx, fiber: { state: 2 }, codeRuntime,
    tools: { ...host.ctx.tools, get: () => definition, schemas: () => [definition] },
    inject(names, callback) { if (names.length === 1 && names[0] === 'settings') callback({ settings, effect: host.ctx.effect, fiber: { state: 2 } }); return () => {} },
  }
  await apply(ctx)
  let sequence = 0
  const run = async program => {
    const exec = { name: 'run_code', callId: `root-settings-${++sequence}`, agent: { id: 'root-settings' } }
    let raw
    const result = await host.listeners.get('tools/execute')[0](exec, async () => {
      raw = await codeRuntime.run({ program, bindings: [] })
      return { isError: raw.error !== undefined, value: raw.value, content: [],
        meta: definition.output.presentationMeta?.({}, raw.value) }
    })
    for (const listener of host.listeners.get('tools/result') ?? []) await listener(exec, result)
    assert.equal(raw.error, undefined, raw.error?.message)
    return raw.value
  }
  await run('let value=1;const read=()=>value')
  await settings.update('ptc-plus', { looseTopLevelRedeclarations: false })
  assert.deepEqual(await run('value=2;return [value,read()]'), [2,2])
  await settings.update('ptc-plus', { bindingUpdates: 'stateful' })
  assert.deepEqual(await run('return [value,read()]'), [2,2])
})

test('legacy replacement import publication is visible to saved logical default readers', async t => {
  const { run, configure } = fixture(t)
  configure({ legacyBindingSettings: true })
  await run('export default 1')
  configure({ bindingUpdates: 'stateful' })
  await run('const readDefault=()=>__default')
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run('export default 2;return [__default,readDefault()]'), [2,2])
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('return [__default,readDefault()]'), [2,2])
})

test('legacy dynamic declarations preserve proved root variable and lexical kinds', async t => {
  const { run, configure } = fixture(t)
  await run(`var shared=1;let lexical=2;eval('var removable=3');const read=()=>[shared,lexical]`)
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run(`
    eval('var shared=4,newNative=5');
    let rejected=false;try{eval('var lexical=9')}catch(error){rejected=error instanceof SyntaxError}
    const before=removable;
    const removed=eval('delete removable');
    const missing=typeof removable;
    eval('var removable');const empty=removable===undefined;removable=6;
    return [read(),newNative,rejected,before,removed,missing,empty,removable,delete shared]`),
  [[4,2],5,true,3,true,'undefined',true,6,false])
  configure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('return [shared,lexical,removable,newNative]'), [4,2,6,5])
})

test('legacy bridge names do not collide with user roots or real ambient properties', async t => {
  const { run, configure } = fixture(t)
  await run(`let __dsh_ptc_native_environment_global_0__=1;
    let __dsh_ptc_dynamic_environment_0__=2;
    let Object=3;const read=()=>Object`)
  configure({ legacyBindingSettings: true })
  assert.deepEqual(await run(`__dsh_ptc_native_environment_global_0__++;
    __dsh_ptc_dynamic_environment_0__++;Object=4;
    return [__dsh_ptc_native_environment_global_0__,__dsh_ptc_dynamic_environment_0__,Object,read(),typeof globalThis.Object]`),
  [2,3,4,4,'function'])
})

test('legacy native declarations restore deleted logical names and catalog availability', async t => {
  const { run, runtime, configure } = fixture(t)
  await run(`eval('var restored=1');eval('delete restored')`)
  configure({ legacyBindingSettings: true })
  assert.equal(await run('var restored=7;return restored'), 7)
  const execution = await runtime.runTentative({ id: `root-transitions-${t.name}` },
    { program: 'return restored', bindings: [] })
  assert.equal(execution.result.error, undefined, execution.result.error?.message)
  assert.equal(execution.result.value, 7)
  assert.ok(execution.settlement.replMemory.entries.some(entry => entry.name === 'restored'))
  runtime.finalize(execution.settlement, true)
  configure({ bindingUpdates: 'stateful' })
  assert.equal(await run('restored=8;return restored'), 8)
})

test('native bridge environments preserve references, intrinsics, deletion and publication owners', () => {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const ambient = {
    read: name => runInContext(name, context),
    typeOf: name => runInContext(`typeof ${name}`, context),
    remove: name => runInContext(`delete ${name}`, context),
    write(name, value, strict) { runInContext(`${strict ? '"use strict";' : ''}incoming=>${name}=incoming`, context)(value) },
  }
  const publications = new Map()
  const roots = createStatefulRootRuntime({
    readAmbient: ambient.read, typeofAmbient: ambient.typeOf, writeAmbient: ambient.write, deleteAmbient: ambient.remove,
    hasAmbient: name => Reflect.has(context, name), errors: intrinsics.errors, dynamicIntrinsics: intrinsics,
    publish(name, read, write) { publications.set(name, { read, write }) },
  })
  let current = roots.begin({ declared: ['value', 'fixed'], readOnly: ['fixed'], languageSemantics: 'protected-v1', committed() {} })
  current.assign('value', 1)
  current.assign('fixed', 2)
  current = roots.begin({ committed() {} })
  current.dynamic().reference('eval').evalInvocation(current.dynamic(), ['var removable=3'])()
  const native = createNativeRootDynamic({ intrinsics, ...ambient, logicalReference: (name, writable) => roots.legacyReference(name, writable) })
  const before = native.environment([])
  const bridge = native.environment([], false, ['value', 'fixed', 'removable'], ['value', 'removable'])
  const run = source => bridge.reference('eval').evalInvocation(bridge, [source])()
  assert.equal(before.reference('eval').value, bridge.reference('eval').value)
  assert.equal(run('value+=4;value'), 5)
  assert.equal(roots.read('value'), 5)
  assert.equal(run('typeof value'), 'number')
  assert.equal(before.reference('value').typeof(), 'undefined')
  assert.throws(() => run('fixed=9'), intrinsics.errors.TypeError)
  assert.equal(run('delete value'), false)
  assert.equal(run('delete removable'), true)
  assert.equal(roots.legacyReference('removable', true).typeof(), 'undefined')
  assert.equal(run('var removable;removable===undefined'), true)
  assert.equal(run('removable=6;var nativeOnly=7;nativeOnly'), 7)
  assert.equal(roots.read('removable'), 6)
  assert.equal(ambient.read('nativeOnly'), 7)
  assert.equal(run('Function("return value")()'), 5)
  assert.equal(run('let value=9;value'), 9)
  const awaiting = native.environment([], true, ['value'], ['value'])
  assert.equal(awaiting.reference('eval').evalInvocation(awaiting, ['var value=11;value'])(), 11)
  assert.equal(roots.read('value'), 5)

  runInContext('let migrated=10;const namespace={value:12};var objectRoot=13', context)
  roots.publishLegacy('value', true, undefined)
  runInContext('let value=10', context)
  assert.equal(publications.get('value').read(), 10)
  publications.get('value').write(11)
  assert.equal(ambient.read('value'), 11)
  roots.publishLegacy('imported', false, { namespace: 'namespace', imported: 'value' })
  assert.equal(publications.get('imported').read(), 12)
  runInContext('namespace.value=14', context)
  assert.equal(roots.read('imported'), 14)
  roots.publishLegacy('whole', false, { namespace: 'namespace' })
  assert.equal(roots.read('whole'), ambient.read('namespace'))
  roots.publishLegacy('objectRoot', true, undefined, true)
  assert.equal(roots.has('objectRoot'), false)
  assert.equal(roots.read('objectRoot'), 13)
})
