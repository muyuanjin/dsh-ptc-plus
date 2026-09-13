import { managedModuleImport } from '../internal/stateful-module-runtime.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './plugin-fixture.js'
import { UserBindingConsole } from '../internal/user-binding-console.js'
import { compileStatefulModule, createUserModuleCompilationHooks } from '../internal/stateful-module-compiler.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

test('direct eval updates logical root bindings across actual worker cells', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const id = 'dynamic-root'
  assert.equal((await state.run(id, 'const value=1; return eval("value")')).value, 1)
  assert.equal((await state.run(id, 'eval("value += 2"); return value')).value, 3)
  assert.equal((await state.run(id, 'return eval("value")')).value, 3)
  assert.equal((await state.run(id, 'return eval("typeof absent")')).value, 'undefined')
  assert.equal((await state.run(id, 'try{eval("let =")}catch(error){return error instanceof SyntaxError}')).value, true)
})

test('with object lookup reaches root values and preserves native receiver semantics', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const id = 'dynamic-with'
  const result = await state.run(id, 'const value=1; const object={value:2,check(){return this===object}}; with(object){value++; return [value,check()]}')
  assert.deepEqual(result.value, [3, true])
  assert.equal((await state.run(id, 'return value')).value, 1)
})

test('native eval respects root declaration kinds and retains deletion evidence', async t => {
  const state = fixture({ bindingUpdates: 'protected' })
  t.after(() => state.dispose())
  const id = 'dynamic-kinds'
  assert.equal((await state.run(id, 'const fixed=1; try{eval("var fixed=2")}catch(error){return error instanceof SyntaxError}')).value, true)
  assert.equal((await state.run(id, 'try{eval("fixed=2")}catch(error){return error instanceof TypeError}')).value, true)
  assert.equal((await state.run(id, 'eval("var dynamicValue=3"); return dynamicValue')).value, 3)
  assert.equal((await state.run(id, 'return eval("delete dynamicValue")')).value, true)
  assert.equal((await state.run(id, 'return typeof dynamicValue')).value, 'undefined')
  assert.equal((await state.run(id, 'eval("var dynamicValue=4"); return dynamicValue')).value, 4)
})

test('worker eval retains class field, super and private native contexts', async t => {
  const state = fixture({ bindingUpdates: 'protected' })
  t.after(() => state.dispose())
  const id = 'dynamic-class-context'
  const result = await state.run(id, `class Base { constructor(value){this.value=value} method(){return this.value} }
    class Derived extends Base { #secret=2; self=eval("this"); constructor(){eval("super(4)")} read(){return eval("super.method()+this.#secret")} }
    const instance=new Derived(); return [instance.self===instance,instance.read()]`)
  assert.deepEqual(result.value, [true, 6], result.error?.message)
})

test('binding console eval uses its own continuous computation environment', async t => {
  const owner = new UserBindingConsole({ cwd: process.cwd(), maxWallMs: 10_000,
    maxOutputBytes: 64 * 1024, maxOldGenerationSizeMb: 128 })
  t.after(() => owner.dispose())
  const source = 'export const answer=2'
  const first = await owner.run({ source, code: 'const value=1; eval("value += answer")' })
  assert.equal(first.output, '3', first.error)
  const next = await owner.run({ source, environment: first.environment,
    code: 'eval("var introduced=4"); with({value:5}){introduced+=value}; [value,introduced]' })
  assert.equal(next.output, '[ 3, 9 ]', next.error)
})

test('stateful local and private identities stay visible through eval and with', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const id = 'dynamic-local-stateful'
  const local = await state.run(id, 'function read(){const value=1; const value=2; eval("value+=3"); return value}; return read()')
  assert.equal(local.value, 5, local.error?.message)
  const nested = await state.run(id, 'function read(){const value=1; with({value:7}){return eval("value")}}; return read()')
  assert.equal(nested.value, 7, nested.error?.message)
  const privateValue = await state.run(id, 'class Item{#value=1;#value=2;read(){return eval("this.#value+=3")}};return new Item().read()')
  assert.equal(privateValue.value, 5, privateValue.error?.message)
  const dynamic = await state.run(id, 'function read(){eval("var inner=4"); return ()=>++inner};const readInner=read();return [readInner(),readInner(),typeof inner]')
  assert.deepEqual(dynamic.value, [5, 6, 'undefined'], dynamic.error?.message)
})

test('compiled module eval updates the same exported logical identity', async t => {
  const compiled = compileStatefulModule('export const value=1; export function update(){return eval("value+=2")}; export function read(){return eval("value")}')
  const url = `data:text/javascript,${encodeURIComponent(compiled.code)}`
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(url, { compiled: true, moduleInterface: compiled.moduleInterface })
  const hook = registerHooks({ resolve: compilation.resolve, load: compilation.load })
  t.after(() => hook.deregister())
  const module = await managedModuleImport(url, url)
  assert.equal(module.update(), 3)
  assert.equal(module.value, 3)
  assert.equal(module.read(), 3)
})

test('compiled CommonJS eval retains wrapper bindings and local updates', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-dynamic-cjs-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const filename = join(cwd, 'example.cjs')
  const compiled = compileStatefulModule('const value=1; const value=2; module.exports={read(){return eval("value+(__filename===module.filename?1:0)")}}', { target: 'commonjs' })
  await writeFile(filename, compiled.code)
  const module = createRequire(import.meta.url)(filename)
  assert.equal(module.read(), 3)
})

test('parameter eval owns a persistent environment distinct from the body and root', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('dynamic-parameters', `function read(first=eval("var own=2"),second=eval("own")){
    return [second,own,eval("arguments.length")]
  }; return [read(),read(),typeof own]`)
  assert.deepEqual(result.value, [[2, 2, 0], [2, 2, 0], 'undefined'], result.error?.message)
  const arrow = await state.run('dynamic-parameters', 'const next=(input=eval("var arrowOnly=3"),other=eval("arrowOnly"))=>[other,arrowOnly]; return [next(),next(),typeof arrowOnly,next.name,next.length]')
  assert.deepEqual(arrow.value, [[3, 3], [3, 3], 'undefined', 'next', 0], arrow.error?.message)
  const closure = await state.run('dynamic-parameters', 'function later(seed=eval("var remembered=7"),read=function(){return eval("remembered")}){return read};const retained=later();return retained()')
  assert.equal(closure.value, 7, closure.error?.message)
})

test('direct eval preserves local intrinsic identity', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const id = 'dynamic-local-eval'
  const alias = await state.run(id, 'function read(){const value=4;const eval=globalThis.eval;return eval("value")};return read()')
  assert.equal(alias.value, 4, alias.error?.message)
})

test('direct eval preserves initializer binding selection', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const id = 'dynamic-local-initializer'
  const initializer = await state.run(id, 'function read(){const value=4;const value=eval("value+1");return value};return read()')
  assert.equal(initializer.value, 5, initializer.error?.message)
  const pattern = await state.run(id, 'function read(){const first=1,second=2;const [first,second=eval("first")]=[3];return [first,second]};return read()')
  assert.deepEqual(pattern.value, [3, 3], pattern.error?.message)
})

test('eval private method reads preserve logical names and write protection', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('dynamic-private-names', 'class Item{#read(){return 1};#read(){return 2};inspect(){let rejected=false;try{eval("this.#read=3")}catch(error){rejected=error instanceof TypeError};return [eval("this.#read.name"),eval("this.#read()"),rejected]}};return new Item().inspect()')
  assert.deepEqual(result.value, ['#read', 2, true], result.error?.message)
  const mixed = await state.run('dynamic-private-names', 'class Mixed{#read(){return 1};static #read(){return 2};inspect(){return [eval("this.#read.name"),eval("this.#read()")]}static inspect(){return [eval("this.#read.name"),eval("this.#read()")]} };return [new Mixed().inspect(),Mixed.inspect()]')
  assert.deepEqual(mixed.value, [['#read', 1], ['#read', 2]], mixed.error?.message)
})

test('with object traps observe user names and exclude compiler-owned cells', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('dynamic-with-helpers', `function example(){
    const events=[];
    const object=new Proxy({}, {has(target,name){events.push(name);return false}});
    let result;
    with(object){const local=2;result=local}
    return [result,events];
  }return example()`)
  assert.deepEqual(result.value, [2, ['result']], result.error?.message)
})

test('cyclic module eval resolves native hoisted functions, vars and lexical TDZ', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-dynamic-cycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'consumer.mjs')
  await writeFile(filename, `import {observed} from './reader.mjs';
    export function read(){let blocked=false;try{eval('lexical')}catch(error){blocked=error instanceof ReferenceError};
      return [eval('value=4; next()+value'),blocked]}
    export function next(){return 3}
    export var value;
    export const lexical=9;
    export {observed};
    export function later(){return eval('lexical+value')}`)
  await writeFile(join(directory, 'reader.mjs'), "import {read} from './consumer.mjs';export const observed=read()")
  const url = pathToFileURL(filename).href
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(url)
  const hook = registerHooks(compilation)
  t.after(() => hook.deregister())
  const module = await managedModuleImport(url, url)
  assert.deepEqual(module.observed, [7, true])
  assert.equal(module.value, 4)
  assert.equal(module.later(), 13)
})
