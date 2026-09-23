import assert from 'node:assert/strict'
import test from 'node:test'
import { compileStatefulRoot } from '../internal/stateful-root-compiler.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { BindingCatalog } from '../internal/session-state.js'
import { interceptWorkerMessages, restartWorker } from './runtime-observation.js'
import { createContext, runInContext, runInNewContext } from 'node:vm'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

test('protected closures check later binding identities when they write', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'protected', durableReplay: false })
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('later-protection', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
  await run('function setLater(){later=2};function evalLater(){eval("later=3")};function readLater(){return later}')
  await run('const later=1')
  assert.deepEqual(await run(`const outcomes=[];for(const setter of [setLater,evalLater]){
    try{setter();outcomes.push(false)}catch(error){outcomes.push(error instanceof TypeError)}}
    return [outcomes,later,readLater()]`), [[true,true],1,1])
  runtime.reconfigure({ bindingUpdates: 'stateful' })
  assert.equal(await run('later=4;return readLater()'), 4)
})

test('direct eval declares a logical var over an existing implicit global property', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture()
  t.after(() => state.dispose())
  const source = `implicit=1;
    return eval("function implicit(){return 2}; [implicit(),globalThis.implicit]")`
  const native = runInNewContext(`(function(){${source}})()`)
  const first = await state.run('eval-over-implicit', source)
  assert.deepEqual(first.value, Array.from(native), JSON.stringify(first.error))
  const next = await state.run('eval-over-implicit', 'return [implicit(),globalThis.implicit]')
  assert.deepEqual(next.value, [2,1], JSON.stringify(next.error))
  const removed = await state.run('eval-over-implicit', 'return eval("delete implicit; [implicit,globalThis.implicit]")')
  assert.deepEqual(removed.value, [1,1], JSON.stringify(removed.error))
  const replaced = await state.run('eval-over-implicit', 'return eval("var implicit=3; [implicit,globalThis.implicit]")')
  assert.deepEqual(replaced.value, [3,1], JSON.stringify(replaced.error))
})

test('logical binding errors use the execution realm and retain captured constructor identity', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture({ bindingUpdates: 'protected' })
  t.after(() => state.dispose())
  await state.run('binding-error-realm', 'const NativeTypeError=TypeError; const NativeReferenceError=ReferenceError; const fixed=1')
  assert.equal((await state.run('binding-error-realm', 'try{fixed=2}catch(error){return error instanceof NativeTypeError}')).value, true)
  await state.run('binding-error-realm', 'function TypeError(){}; function ReferenceError(){}')
  assert.equal((await state.run('binding-error-realm', 'try{fixed=3}catch(error){return error instanceof NativeTypeError}')).value, true)
  assert.equal((await state.run('binding-error-realm', 'try{return later}catch(error){return error instanceof NativeReferenceError}; const later=1')).value, true)
  assert.equal((await state.run('binding-error-realm', 'try{const [first=second,second=2]=[]}catch(error){return error instanceof NativeReferenceError}')).value, true)
})

function session(options = {}) {
  const context = Object.create(null)
  const known = new Set()
  const runtime = createStatefulRootRuntime({
    typeofAmbient: name => typeof (Object.hasOwn(context, name) ? context[name] : globalThis[name]),
    readAmbient(name) {
      if (Object.hasOwn(context, name)) return context[name]
      if (name in globalThis) return globalThis[name]
      throw new ReferenceError(`${name} is not defined`)
    },
    publish(name, get, set) { Object.defineProperty(context, name, { configurable: true, get, set }) },
  })
  return {
    context, runtime,
    async run(source) {
      const prepared = compileStatefulRoot(source, { knownBindings: known, ...options })
      const committed = new Set()
      context[prepared.rootRuntimeName] = runtime.begin({ ...prepared.rootPlan, committed: name => committed.add(name) })
      for (const load of prepared.moduleLoads) context[load.global] = await import(load.source)
      try { return await new AsyncFunction(prepared.code).call(context) } finally {
        for (const declaration of prepared.declarations) {
          if (committed.has(declaration.commitDependency)) known.add(declaration.name)
        }
        delete context[prepared.rootRuntimeName]
        for (const load of prepared.moduleLoads) delete context[load.global]
      }
    },
  }
}

test('root compiler candidate references retain binding deletion across publication and failure', async () => {
  const state = session()
  assert.deepEqual(await state.run(`
    const [before=delete later,later=2,remove=()=>delete later]=[];
    const object={value:1};let escaped;
    return [before,later,remove(),delete object.value]
  `), [false,2,false,true])
  await assert.rejects(state.run(`
    let [later,capture=(escaped=()=>delete later,(()=>{throw Error('candidate failure')})())]=[99]
  `), /candidate failure/)
  assert.deepEqual(await state.run('return [escaped(),remove(),later,typeof capture]'), [false,false,2,'undefined'])
  assert.deepEqual(await state.run('later=3;return [escaped(),remove(),later]'), [false,false,3])
})

test('root declarations update one identity across cells and keep saved values', async () => {
  const state = session()
  assert.deepEqual(await state.run('function item() { return 1 }; const saved = item; const read = () => item(); return [read(), saved()]'), [1, 1])
  assert.deepEqual(await state.run('function item() { return 2 }; return [read(), saved()]'), [2, 1])
  assert.equal(await state.run('const item = () => 3; return read()'), 3)
  assert.equal(await state.run('let item = () => 4; return read()'), 4)
  assert.equal(await state.run('var item = () => 5; return read()'), 5)
  assert.equal(await state.run('class item {}; return item.name'), 'item')
  assert.equal(await state.run('const item = 7; const item; let item; var item; return item'), 7)
})

test('ordinary functions own arguments across reads, writes and nested arrows', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture()
  t.after(() => state.dispose())
  assert.deepEqual((await state.run('native-arguments', `
    function read(value) { const nested=()=>arguments[0]; return [arguments[0], nested()] }
    function replace(value) { arguments={0:3}; return (()=>arguments[0])() }
    return [read(2),replace(2)]
  `)).value, [[2,2],3])
  assert.equal((await state.run('native-arguments', 'return typeof arguments')).value, 'undefined')
})

test('labelled root functions preserve their logical owner and declaration timing', async () => {
  const state = session()
  assert.deepEqual(await state.run('let h=1; const before=h===1; const read=()=>h; outer: inner: function h(){return 2}; return [before,h(),read()===h]'), [true,2,true])
  assert.deepEqual(await state.run('const before=h(); label: function h(){return 3}; return [before,read()()]'), [2,3])
  assert.deepEqual(await state.run('const before=f(); label: function f(){return 4}; return [before,f.name]'), [4,'f'])
  await assert.rejects(session({languageSemantics:'protected-v1'}).run('"use strict"; label: function h(){}'), SyntaxError)
})

test('root patterns commit atomically and successful candidates follow later state', async () => {
  const state = session()
  await state.run('const x=10, y=20; const current = () => [x,y]')
  await assert.rejects(state.run('const [x, y = (() => { throw new Error("pattern") })()] = [1]'), /pattern/)
  assert.deepEqual(await state.run('return current()'), [10, 20])
  assert.deepEqual(await state.run('const {x = 1, y = x} = {}; return [x,y]'), [1, 1])
  assert.equal(await state.run('const [x, x = x + 1] = [1]; return x'), 2)
  await state.run('const [x, reader = () => x] = [3]')
  assert.deepEqual(await state.run('const x = 4; return [reader(), current()]'), [4, [4, 1]])
  await assert.rejects(state.run('const x = 5, y = (() => { throw new Error("later") })()'), /later/)
  assert.deepEqual(await state.run('return current()'), [5, 1])
})

test('failed and unexecuted lexical declarations do not reserve root names', async () => {
  const state = session()
  await assert.rejects(state.run('const failed = (() => { throw new Error("failed") })()'), /failed/)
  assert.equal(await state.run('const failed = 3; return failed'), 3)
  await state.run('return; const absent = 1')
  assert.equal(await state.run('const absent = 4; return absent'), 4)
  assert.equal(await state.run('if (false) { var hoisted = 3 }; return hoisted'), undefined)
  assert.equal(await state.run('const hoisted = 5; return hoisted'), 5)
})

test('import identities preserve live reads and accept every ordinary write form', async () => {
  const state = session()
  const module = 'data:text/javascript,export let value=1; export function bump(){value++}'
  await state.run(`import {value as item, value as other, bump} from ${JSON.stringify(module)}; const read = () => item; const readOther = () => other`)
  assert.deepEqual(await state.run('bump(); return [read(), readOther()]'), [2, 2])
  assert.deepEqual(await state.run('item += 3; return [read(), readOther()]'), [5, 2])
  assert.equal(await state.run(`import {value as item} from ${JSON.stringify(module)}; return read()`), 2)
  assert.equal(await state.run('item++; return read()'), 3)
  assert.equal(await state.run('({item} = {item: 7}); return read()'), 7)
  assert.equal(await state.run('for (item of [8,9]) {}; return read()'), 9)
  assert.equal(await state.run('item &&= 11; return read()'), 11)
  assert.equal(await state.run(`import {value as item} from ${JSON.stringify(module)}; const item = 12; return read()`), 12)
})

test('static imports precede body declarations regardless of their text position', async () => {
  const state = session()
  assert.deepEqual(await state.run(`
    const initial = typeof join;
    const join = () => 'LOCAL';
    const read = () => join;
    import { join } from 'node:path';
    return [initial, read()('a', 'b')]
  `), ['function', 'LOCAL'])
  assert.equal(await state.run(`import { join } from 'node:path'; return read() === (await import('node:path')).join`), true)
  assert.deepEqual(await state.run(`
    const join = () => 'LOCAL';
    const before = read()();
    join = (await import('node:path')).join;
    return [before, read() === (await import('node:path')).join]
  `), ['LOCAL', true])
})

test('root function and class values preserve native callable details and local shadows', async () => {
  const state = session()
  assert.deepEqual(await state.run('function* item(a) { yield a }; return [item.name,item.length,[...item(2)]]'), ['item', 1, [2]])
  assert.deepEqual(await state.run('const item = (a,b) => a+b; return [item.name,item.length,item(2,3)]'), ['item', 2, 5])
  assert.equal(await state.run('const x=1; function get(){ const x=2; return x }; return get()'), 2)
  assert.deepEqual(await state.run('const result=[]; for (var x of [3,4]) result.push(x); return [result,x]'), [[3,4], 4])
  assert.equal(await state.run('export default function item() { return 6 }; return __default()'), 6)
  assert.equal(await state.run('function item() { return 7 }; return __default()'), 7)
})

test('worker and catalog agree on root state after failed patterns, imports and recovery', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const id = 'stateful-root-integration'
  assert.equal((await state.run(id, 'const x=1; const read=()=>x; return read()')).value, 1)
  assert.equal((await state.run(id, 'const x=2; return read()')).value, 2)
  const failed = await state.run(id, 'const [x, absent = (()=>{throw new Error("pattern")})()]=[8]')
  assert.equal(failed.error.kind, 'exception')
  assert.deepEqual((await state.run(id, 'return [read(), typeof absent]')).value, [2, 'undefined'])
  assert.equal((await state.run(id, 'const absent=3; return absent')).value, 3)
  assert.equal((await state.run(id, 'import {basename as x} from "node:path"; return read()("/a/b")')).value, 'b')
  assert.equal((await state.run(id, 'x=5; return read()')).value, 5)
  assert.equal((await state.run(id, 'import {basename as x} from "node:path"; return read()("/c/d")')).value, 'd')
})

test('root exports and static dependency forms use the same update semantics', async () => {
  const state = session()
  assert.equal(await state.run('export const x=1; export {x}; return x'), 1)
  assert.equal(await state.run('export default (1,2); return __default'), 2)
  assert.deepEqual(await state.run('export default function() {return 3}; return [__default(),__default.name]'), [3,'default'])
  assert.equal(await state.run('export default class {}; return __default.name'), 'default')
  assert.equal(await state.run('export default class __default {static value=4}; return __default.value'), 4)
  assert.equal(await state.run('export default class item {static value=5}; return __default.value'), 5)
  assert.equal(await state.run('const __default=6; return __default'), 6)
  assert.equal(await state.run('import path from "node:path"; import * as ns from "node:path"; return path.basename("/a/b") === ns.basename("/a/b")'), true)
  assert.equal(await state.run('import "node:path"; export * from "node:path"; export {basename} from "node:path"; return 7'), 7)
  assert.equal(await state.run('import type {Stats} from "node:fs"; import {type Dirent} from "node:fs"; export type {Stats}; export default interface A {}; return 8'), 8)
  assert.equal(await state.run('const {} = {}; const [] = []; return 9'), 9)
  assert.equal(await state.run('const [,x,...rest]=[0,2,3]; return typeof x'), 'number')
  assert.equal(await state.run('for(var x=0;x<2;x++) {}; return x'), 2)
  assert.equal(await state.run('for(var x in {a:1,b:2}) {}; return x'), 'b')
  const compiled = compileStatefulRoot('import data from "data:application/json,%7B%22x%22%3A1%7D" with {type:"json"}; return data.x', {
    runtimeExpression: bindings => `runtime.begin(${JSON.stringify(bindings)})`, moduleExpression: () => 'moduleValue',
  })
  assert.deepEqual(compiled.moduleLoads[0].options, { with: { type: 'json' } })
  assert.match(compiled.code, /runtime\.begin/)
  assert.equal(compileStatefulRoot('').declared.size, 0)
  assert.equal(compileStatefulRoot('const tools = 1', {reservedBindings: new Set(['tools'])}).collisions[0].name, 'tools')
  assert.equal(compileStatefulRoot('const x = 1', {languageSemantics: 'protected-v1', knownBindings: new Set(['x'])}).collisions[0].name, 'x')
  assert.throws(() => compileStatefulRoot('const x=1; const x=2', {languageSemantics: 'protected-v1'}), SyntaxError)
  assert.throws(() => compileStatefulRoot('const =1'), SyntaxError)
  assert.throws(() => compileStatefulRoot('"use strict"; delete x'), SyntaxError)
  assert.equal(await state.run('"use strict"; const tag = (parts)=>parts[0]; return tag`hello`'), 'hello')
  assert.equal(await state.run('const maker=function(){return 10}; return maker?.()'), 10)
  assert.equal(await state.run('const Shape=class {}; return Shape.name'), 'Shape')
  assert.deepEqual(await state.run('const [a,b=a]=[1]; const [c,d=c]=[2]; return [b,d]'), [1,2])
  assert.equal(await state.run('import {"sep" as separator} from "node:path"; return typeof separator'), 'string')
  assert.match(compileStatefulRoot('declare const description: string; const value = 1; return value as description').code, /value/)
  assert.deepEqual(compileStatefulRoot('return value', {knownBindings:new Set(['value']),writableBindings:new Set(['value']),importBindings:new Map([['value',{namespace:'old'}]])}).rootBindings.legacyWritable,[])
})

test('root runtime keeps protected closures, failed candidates and legacy bridges distinct', async () => {
  const state = session({ languageSemantics: 'protected-v1' })
  await state.run('const x=1; const put=()=>x=2')
  await assert.rejects(state.run('put()'), /constant variable/)
  assert.equal(await state.run('return x'), 1)

  const legacy = { x: 1, oldFixed: 10, namespace: {value: 2} }
  const publicSlots = new Map()
  const commits = []
  const runtime = createStatefulRootRuntime({
    typeofAmbient(name) {
      if (name === 'throws') throw new TypeError('ambient')
      return typeof legacy[name]
    },
    readAmbient(name) {
      if (name === 'throws') throw new TypeError('ambient')
      if (!Object.hasOwn(legacy,name)) throw new ReferenceError('missing')
      return legacy[name]
    },
    writeAmbient(name,value) { legacy[name]=value },
    deleteAmbient: name => delete legacy[name],
    deleteAmbient(name) { return Reflect.deleteProperty(legacy, name) },
    publish(name,get,set) { publicSlots.set(name,{get,set}) },
  })
  let current = runtime.begin({ declared: ['fresh'], known: ['x'], legacyWritable: ['x'], legacyLexicals: ['oldFixed'],
    legacyImports: [['imported',{namespace:'namespace',imported:'value'}],['ns',{namespace:'namespace'}]], committed: value => commits.push(value) })
  assert.equal(current.values.imported, 2)
  assert.equal(current.values.ns, legacy.namespace)
  assert.equal(current.values.oldFixed, 10)
  current.values.oldFixed = 11
  assert.equal(current.values.oldFixed, 11)
  assert.equal(legacy.oldFixed, 10)
  current.values.x=3
  assert.equal(legacy.x,3)
  assert.equal(publicSlots.get('x').get(),3)
  publicSlots.get('x').set(4)
  assert.equal(legacy.x,4)
  assert.equal(current.typeof('x'),'number')
  assert.equal(current.typeof('missing'),'undefined')
  assert.throws(() => current.typeof('fresh'), ReferenceError)
  assert.throws(() => current.typeof('throws'), /ambient/)
  assert.equal(Reflect.deleteProperty(current.values,'missing'),true)
  assert.equal(Reflect.deleteProperty(current.values,'x'),false)
  const candidate=current.candidate(['fresh'])
  assert.throws(()=>candidate.values.fresh,ReferenceError)
  candidate.values.fresh=5
  candidate.commit('fresh')
  assert.equal(publicSlots.get('fresh').get(),5)
  publicSlots.get('fresh').set(5)
  candidate.values.fresh=6
  assert.equal(current.values.fresh,6)
  assert.equal(publicSlots.get('fresh').get(),6)
  publicSlots.get('fresh').set(7)
  assert.equal(candidate.values.fresh,7)
  current.link('default','fresh','default')
  assert.equal(publicSlots.get('default').get(),7)
  publicSlots.get('default').set(8)
  assert.equal(current.values.default,8)
  current.import('alias',legacy.namespace,'value','alias')
  assert.equal(publicSlots.get('alias').get(),2)
  publicSlots.get('alias').set(9)
  assert.equal(current.values.alias,9)
  assert.deepEqual(runtime.localValue('fresh'),{value:7})
  assert.equal(runtime.localValue('x'),undefined)
  assert.equal(runtime.has('fresh'),true)
  assert.ok(runtime.facts().some(fact=>fact.name==='fresh'&&fact.source==='local'))
  current=runtime.begin({ languageSemantics:'protected-v1', readOnly:['fixed'], declared:['fixed'], committed:()=>{} })
  const protectedCandidate=current.candidate(['fixed'])
  protectedCandidate.values.fixed=1
  protectedCandidate.commit('fixed')
  assert.throws(()=>{protectedCandidate.values.fixed=2},/constant variable/)
  assert.throws(()=>{current.values.fixed=2},/constant variable/)
  const protectedContinuation=runtime.begin({languageSemantics:'protected-v1',committed:()=>{}})
  assert.throws(()=>{protectedContinuation.values.fixed=2},/constant variable/)
  const later=runtime.begin({ languageSemantics:'stateful-v1', committed:()=>{} })
  later.values.fixed=3
  assert.equal(current.values.fixed,3)
  const inherited=runtime.begin({ languageSemantics:'protected-v1', committed:()=>{} })
  inherited.values.fixed=4
  assert.equal(current.values.fixed,4)
  assert.ok(commits.includes('fresh'))
  const isolated=createStatefulRootRuntime({readAmbient:()=>undefined})
  isolated.begin({committed:()=>{}}).assign('value',1,'value')
  assert.equal(isolated.read('value'),1)
})

test('logical realm declarations preserve global deletion and separate lexical storage', () => {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const owner = createStatefulRootRuntime({ dynamicIntrinsics: intrinsics,
    hasAmbient: name => name in intrinsics.globalObject,
    readAmbient: name => runInContext(name, context),
    typeofAmbient: name => runInContext(`typeof ${name}`, context),
    deleteAmbient: name => runInContext(`delete ${name}`, context),
    writeAmbient(name, value, strict) { runInContext(`${strict ? '"use strict";' : ''}value=>${name}=value`, context)(value) },
  })
  const root = owner.begin({ committed() {}, declared: ['lexical'] })
  const candidate = root.candidate(['lexical'])
  candidate.values.lexical = 42
  candidate.commit('lexical')
  const environment = root.dynamic({ realm: true })
  const evaluate = source => environment.reference('eval').evalInvocation(environment, [source])()
  assert.equal(evaluate('var created=7;created'), 7)
  assert.equal(runInContext('created', context), 7)
  assert.equal(evaluate('delete created'), true)
  assert.equal(evaluate('typeof created'), 'undefined')
  assert.equal(evaluate('var created=8;created'), 8)
  assert.throws(() => evaluate('var lexical=9'), intrinsics.errors.SyntaxError)
  assert.equal(root.values.lexical, 42)
  assert.equal(runInContext('typeof lexical', context), 'undefined')
  runInContext('var original=11', context)
  const legacy = owner.begin({ committed() {}, legacyWritable: ['original'], legacyObjects: ['original'] })
  const replacement = legacy.candidate(['original'])
  replacement.values.original = 10
  replacement.commit('original')
  assert.equal(runInContext('original', context), 10)
  assert.equal(legacy.values.original, 10)
})

test('root loop initialization supports await and labeled control flow', async () => {
  const state=session()
  assert.equal(await state.run('for (var i=await Promise.resolve(0);i<1;i++) {}; return i'),1)
  assert.equal(await state.run('again: for(var i=await Promise.resolve(0);i<3;i++){if(i<2)continue again;break again};return i'),2)
  assert.deepEqual(await state.run('for(var [i,j=await Promise.resolve(1)] = [0];i<1;i++){};return [i,j]'),[1,1])
})

test('protected worker writes through TypeScript wrappers retain protection', async t => {
  const {fixture}=await import('./plugin-fixture.js')
  const state=fixture({bindingUpdates:'protected'})
  t.after(()=>state.dispose())
  assert.equal((await state.run('protected-ts-root','const x=1; return x')).value,1)
  for(const source of ['(x as number)=2; return x','x! += 2; return x','(<number>x)++; return x']) {
    const result=await state.run('protected-ts-root',source)
    assert.equal(result.error?.kind,'exception',source)
    assert.match(result.error.message,/constant variable/,source)
    assert.equal((await state.run('protected-ts-root','return x')).value,1)
  }
})

test('root resources keep their disposal lifetime independently of binding updates', async t => {
  const {fixture}=await import('./plugin-fixture.js')
  const state=fixture({bindingUpdates:'stateful'})
  t.after(()=>state.dispose())
  const first=await state.run('root-resources', 'const events=[]; using resource = {[Symbol.dispose](){events.push("disposed")}}; const resource = 3; events.push("body"); return events')
  assert.deepEqual(first.value,['body','disposed'])
  assert.equal((await state.run('root-resources','return resource')).value,3)
  const second=await state.run('root-resources','await using resource = {[Symbol.asyncDispose]:async()=>{events.push("async")}}; return events')
  assert.deepEqual(second.value,['body','disposed','async'])
})

test('typeof distinguishes missing ambient names from getter failures across realms', () => {
  const ambient = Object.create(null)
  const foreignError = runInNewContext('new ReferenceError("getter failed")')
  let calls = 0
  Object.defineProperty(ambient, 'broken', { get() { calls++; throw foreignError } })
  const runtime = createStatefulRootRuntime({
    readAmbient: name => ambient[name], typeofAmbient: name => typeof ambient[name],
  })
  const cell = runtime.begin({ declared: ['fresh'], committed() {} })
  assert.equal(cell.typeof('missing'), 'undefined')
  assert.throws(() => cell.typeof('broken'), error => error === foreignError)
  assert.equal(calls, 1)
  assert.throws(() => cell.typeof('fresh'), /before initialization/)
})

test('ambient object references preserve native writes, deletion, strictness and overlays', () => {
  const context = createContext({})
  let overlay = false
  const runtime = createStatefulRootRuntime({
    readAmbient: name => runInContext(name, context),
    typeofAmbient: name => runInContext(`typeof ${name}`, context),
    writeAmbient: (name, value, strict) => runInContext(`${strict ? '"use strict";' : ''}(input)=>${name}=input`, context)(value),
    deleteAmbient: name => runInContext(`delete ${name}`, context),
    hasAmbient: name => Reflect.has(context, name),
    hasOverlay: name => overlay && name === 'lexical',
  })
  const cell = runtime.begin({ declared: ['lexical','missingProvider'], known: ['missingProvider'], committed() {} })
  cell.declare('missingProvider', 'missingProvider')
  assert.equal(runtime.has('missingProvider'), true)
  assert.equal(cell.typeof('missingProvider'), 'undefined')
  cell.assign('lexical', 1, 'lexical')
  cell.reference('object', false).value = 2
  cell.reference('object', false).value++
  assert.equal(context.object, 3)
  assert.equal(runtime.has('object'), false)
  assert.equal(runtime.localValue('object'), undefined)
  assert.equal(cell.typeof('object'), 'number')
  assert.equal(Reflect.deleteProperty(cell.values, 'object'), true)
  assert.equal(cell.typeof('object'), 'undefined')
  assert.deepEqual(runtime.facts().find(fact => fact.name === 'object'), {name:'object',source:'absent'})
  assert.throws(() => { cell.reference('strictMissing', true).value = 1 }, /strictMissing is not defined/)
  context.lexical = 9
  overlay = true
  assert.equal(cell.values.lexical, 9)
  assert.equal(cell.typeof('lexical'), 'number')
  cell.values.lexical = 10
  assert.equal(context.lexical, 10)
  overlay = false
  assert.equal(cell.values.lexical, 1)
})
test('a non-declaration write to a reserved overlay fails instead of being discarded', () => {
  const context = createContext({})
  const runtime = createStatefulRootRuntime({
    readAmbient: name => runInContext(name, context),
    writeAmbient: (name, value, strict) => runInContext(`${strict ? '"use strict";' : ''}(input)=>${name}=input`, context)(value),
    hasOverlay: name => name === 'tools',
    canWriteAmbient: name => Object.getOwnPropertyDescriptor(context, name)?.writable === true,
  })
  const cell = runtime.begin({ declared: ['tools'], committed() {} })
  Object.defineProperty(context, 'tools', { configurable: true, value: Object.create(null) })
  // The hard overlay pre-empts a declaration, but an actual store must not vanish.
  cell.assign('tools', 1, 'tools')
  assert.equal(typeof context.tools, 'object')
  assert.equal(cell.values.tools, context.tools)
  assert.throws(() => { cell.reference('tools', false).value = 2 },
    /tools cannot be overwritten because reserved program bindings are not shadowable/)
  assert.throws(() => { cell.values.tools = 2 },
    /tools cannot be overwritten because reserved program bindings are not shadowable/)
  assert.equal(typeof context.tools, 'object')
})

test('root deletion applies to reflected ambient properties while preserving lexical identities', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture()
  t.after(() => state.dispose())
  assert.deepEqual((await state.run('ambient-delete', `
    globalThis.ambientDelete=1;
    Object.defineProperty(globalThis,'fixedDelete',{value:2,configurable:false});
    const localDelete=3;
    const result=[delete ambientDelete, 'ambientDelete' in globalThis,
      delete absentDelete,delete fixedDelete,delete localDelete,delete laterDelete];
    const laterDelete=4;
    return [...result,localDelete,laterDelete,fixedDelete]
  `)).value, [true,false,true,false,false,false,3,4,2])
})

test('root reflection keeps lexical identities separate from actual global properties', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('root-reflection', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
  assert.deepEqual(await run('let lexical=1; implicit=2; return [lexical,implicit,typeof globalThis.lexical,globalThis.implicit]'), [1, 2, 'undefined', 2])
  assert.deepEqual(await run('Object.defineProperty(globalThis,"lexical",{value:10,configurable:true}); Object.defineProperty(globalThis,"implicit",{value:20,configurable:true}); return [lexical,implicit,globalThis.lexical]'), [1, 20, 10])
  assert.deepEqual(await run('delete globalThis.lexical; delete globalThis.implicit; return [lexical,typeof implicit]'), [1, 'undefined'])
  assert.deepEqual(await run('return [lexical,typeof implicit]'), [1, 'undefined'])
  assert.equal(await run('implicit=30; return implicit'), 30)
  assert.equal(await run('Object.defineProperty(globalThis,"implicit",{get(){throw new ReferenceError("getter failure")},configurable:true}); return 1'), 1)
  const failure = await runtime.run('root-reflection', { program: 'return typeof implicit', bindings: [] })
  assert.match(failure.error.message, /getter failure/)
  assert.equal(await run('Object.defineProperty(globalThis,"implicit",{value:40,configurable:true}); return implicit'), 40)
})

test('request namespaces cover existing lexical roots and old closures until the next request', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = (program, bindings = []) => runtime.run('root-request-overlay', { program, bindings })
  assert.equal((await run('let service={value:()=>"session"}; const read=()=>service.value(); return read()')).value, 'session')
  assert.equal((await run('return read()', [{global:'service', functions:{value:async ()=>'request'}}])).value, 'request')
  assert.equal((await run('return read()')).value, 'session')
})

test('old closures resolve names first initialized in later cells through their root identity', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = program => runtime.run('future-root', { program, bindings: [] })
  assert.equal((await run('const read=()=>future; return typeof future')).value, 'undefined')
  assert.equal((await run('let future=2; return read()')).value, 2)
  assert.equal((await run('Object.defineProperty(globalThis,"future",{value:20,configurable:true}); return read()')).value, 2)
  assert.equal((await run('future=3; return read()')).value, 3)
})

test('implicit global writes carry source proof only after actual execution and survive replay', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = async program => {
    const execution = await runtime.runTentative('root-implicit', { program, bindings: [] })
    runtime.finalize(execution.settlement, true)
    return execution
  }
  const first = await run('value=3; if(false) neverWritten=9; const createLater=()=>later=4; return value')
  assert.equal(first.result.value, 3)
  assert.equal(first.settlement.replMemory.entries.find(entry => entry.name === 'value').definition.source, 'value=3')
  assert.equal(first.settlement.replMemory.entries.some(entry => ['neverWritten','later'].includes(entry.name)), false)
  const later = await run('createLater(); return later')
  assert.equal(later.result.value, 4)
  assert.equal(later.settlement.replMemory.entries.find(entry => entry.name === 'later').definition.source, 'later=4')
  const failed = await run('left=5; right=(()=>{throw new Error("rhs")})();')
  assert.match(failed.result.error.message, /rhs/)
  assert.ok(failed.settlement.replMemory.entries.some(entry => entry.name === 'left'))
  assert.equal(failed.settlement.replMemory.entries.some(entry => entry.name === 'right'), false)
  const strict = await run('"use strict"; forbiddenImplicit=7')
  assert.match(strict.result.error.message, /forbiddenImplicit is not defined/)
  assert.equal(strict.settlement.replMemory.entries.some(entry => entry.name === 'forbiddenImplicit'), false)
  await restartWorker(runtime, 'root-implicit')
  const recovered = await run('return [value,later,left,typeof right,typeof forbiddenImplicit]')
  assert.deepEqual(recovered.result.value, [3,4,5,'undefined','undefined'])
})

test('write provenance identifies the executed occurrence, including delayed closures', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = async program => {
    const execution = await runtime.runTentative('write-provenance', { program, bindings: [] })
    runtime.finalize(execution.settlement, true)
    assert.equal(execution.result.error, undefined, execution.result.error?.message)
    return execution
  }
  const first = await run('if(false) selected=1; selected=2; const writeLater=()=>delayed=3')
  assert.equal(first.settlement.replMemory.entries.find(entry => entry.name === 'selected').definition.source, 'selected=2')
  const later = await run('if(false) delayed=4; writeLater(); return delayed')
  assert.equal(later.result.value, 3)
  assert.equal(later.settlement.replMemory.entries.find(entry => entry.name === 'delayed').definition.source, 'delayed=3')
  const ignored = await run('if(false) selected=99; return selected')
  assert.equal(ignored.result.value, 2)
  assert.equal(ignored.settlement.replMemory.entries.find(entry => entry.name === 'selected').definition.source, 'selected=2')
})

test('protected root metadata distinguishes writable declarations from const and imports', () => {
  const source = 'let changeable=1; var ordinary=2; const fixed=3; import {sep} from "node:path"'
  const prepared = compileStatefulRoot(source, { languageSemantics: 'protected-v1' })
  const catalog = new BindingCatalog().advance(prepared, source, prepared.commitTargets)
  assert.deepEqual([...catalog.inputs().writableBindings].sort(), ['changeable','ordinary'])
  assert.equal(catalog.inputs().importBindings.has('sep'), true)
})

test('stateful access can override a verified legacy readonly lexical without rewriting old closures', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true, looseTopLevelRedeclarations: false })
  t.after(() => runtime.dispose())
  const run = program => runtime.run('legacy-readonly-root', { program, bindings: [] })
  assert.equal((await run('const value=1; const readOld=()=>value; return value')).value, 1)
  runtime.reconfigure({ bindingUpdates: 'stateful', legacyBindingSettings: false })
  assert.deepEqual((await run('value=2; return [value,readOld()]')).value, [2,1])
  assert.deepEqual((await run('const value; return [value,readOld()]')).value, [2,1])
})

test('bare declarations restore deleted implicit identities without discarding existing values', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = program => runtime.run('bare-root', { program, bindings: [] })
  assert.equal((await run('value=3; let value; return value')).value, 3)
  assert.deepEqual((await run('delete value; let value; return [typeof value,typeof globalThis.value]')).value, ['undefined','undefined'])
  assert.equal((await run('value=4; return value')).value, 4)
})

test('root catalog follows committed declarations and actual import source transitions', () => {
  const imported = compileStatefulRoot('import {sep as value} from "node:path"')
  const initial = new BindingCatalog().advance(imported, 'import {sep as value} from "node:path"', imported.commitTargets,
    [{name:'value',source:'import'}])
  const failed = compileStatefulRoot('const value=fail()', initial.inputs())
  const retained = initial.advance(failed, 'const value=fail()', new Set(), [{name:'value',source:'import'}])
  assert.deepEqual(retained.snapshot(), initial.snapshot())
  assert.deepEqual(retained.inputs().importBindings, initial.inputs().importBindings)
  const write = compileStatefulRoot('value=3', retained.inputs())
  const local = retained.advance(write, 'value=3', new Set(), [{name:'value',source:'local'}])
  assert.equal(local.inputs().importBindings.has('value'), false)
  assert.equal(local.snapshot()[0].kind, 'variable')
  const again = compileStatefulRoot('import {delimiter as value} from "node:path"', local.inputs())
  const restored = local.advance(again, 'import {delimiter as value} from "node:path"', again.commitTargets,
    [{name:'value',source:'import'}])
  assert.equal(restored.inputs().importBindings.get('value').imported, 'delimiter')
})

test('worker root facts are closed, complete and bound to executed declarations', async t => {
  const corruptions = [
    ['missing', message => { delete message.rootBindingFacts }],
    ['not an array', message => { message.rootBindingFacts = {} }],
    ['incomplete', message => { message.rootBindingFacts = [] }],
    ['null', message => { message.rootBindingFacts = [null] }],
    ['primitive', message => { message.rootBindingFacts = ['value'] }],
    ['array record', message => { message.rootBindingFacts[0] = Object.assign([], message.rootBindingFacts[0]) }],
    ['inherited source', message => { message.rootBindingFacts[0] = Object.assign(Object.create({source:'local'}), {name:'value',extra:true}) }],
    ['extra key', message => { message.rootBindingFacts[0].extra = true }],
    ['missing source', message => { delete message.rootBindingFacts[0].source }],
    ['invalid name', message => { message.rootBindingFacts[0].name = 1 }],
    ['unknown name', message => { message.rootBindingFacts[0].name = 'foreign' }],
    ['duplicate', message => { message.rootBindingFacts.push(message.rootBindingFacts[0]) }],
    ['invalid source', message => { message.rootBindingFacts[0].source = 'provider' }],
    ['unproved import', message => { message.rootBindingFacts[0].source = 'import' }],
    ['absent declaration', message => { message.rootBindingFacts.find(fact => fact.name === 'fresh').source = 'absent' }],
    ['unexecuted declaration', message => { message.rootBindingFacts.push({name:'unexecuted',source:'local'}) }],
    ['missing write proof', message => { delete message.rootBindingFacts.find(fact => fact.name === 'implicit').write }],
    ['invalid write proof', message => { message.rootBindingFacts.find(fact => fact.name === 'implicit').write = 1 }],
    ['unknown write proof', message => { message.rootBindingFacts.find(fact => fact.name === 'implicit').write = 'foreign' }],
    ['wrong write owner', message => { message.rootBindingFacts.find(fact => fact.name === 'implicit').write = message.rootBindingFacts.find(fact => fact.name === 'other').write }],
    ['import with write proof', message => { message.rootBindingFacts.find(fact => fact.name === 'implicit').source = 'import' }],
  ]
  for (const [label, corrupt] of corruptions) await t.test(label, async t => {
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    assert.equal((await runtime.run('invalid-root-proof', { program: 'let value=1', bindings: [] })).error, undefined)
    const intercepted = interceptWorkerMessages(runtime, 'invalid-root-proof', (message, deliver) => {
      if (message.type === 'done') corrupt(message)
      deliver(message)
    })
    const invalid = await runtime.runTentative('invalid-root-proof', {
      program: 'let fresh=2; implicit=7; other=8; return; let unexecuted=3', bindings: [],
    })
    intercepted.restore()
    runtime.finalize(invalid.settlement, true)
    assert.equal(invalid.result.error?.kind, 'worker-exit', label)
    assert.match(invalid.result.error.message, /root binding facts/)
    assert.equal(invalid.settlement.journal.status, 'discarded')
    assert.deepEqual((await runtime.run('invalid-root-proof', { program: 'return [value,typeof fresh]', bindings: [] })).value, [1,'undefined'])
  })
})
