import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { uncoveredEnvironment } from './subprocess-environment.js'
import { createContext, runInContext } from 'node:vm'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureCompilerIntrinsics } from '../internal/compiler-intrinsics.js'
import { SessionRuntime } from '../internal/session-runtime.js'

test('owned cell preparation retains captured intrinsics after prototype changes', async t => {
  for (const mutation of [
    'Object.prototype.constructor=null',
    'Function.prototype.constructor=null',
    'Array.prototype.constructor=null',
    'String.prototype.constructor=null',
    'Number.prototype.constructor=null',
    'TypeError.prototype.constructor=null',
    'ReferenceError.prototype.constructor=null',
    'Symbol.prototype.constructor=null',
    'Object.getOwnPropertySymbols=()=>[]',
    'Object.defineProperty=null',
  ]) {
    const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
    t.after(() => runtime.dispose())
    const id = `captured-${mutation}`
    const run = async program => {
      const result = await runtime.run(id, { program, bindings: [] })
      assert.equal(result.error, undefined, `${mutation}: ${JSON.stringify(result.error)}`)
      return result.value
    }
    await run(`const originalFunction=Function;${mutation};return 1`)
    assert.equal(await run('function f(){let x=2;return x}return f()'), 2)
    assert.equal(await run(`function f(){let x=2;return [eval('x'),()=>x]}
      const pair=f();return JSON.stringify([pair[0],pair[1](),originalFunction('return 3')()])`), '[2,2,3]')
    assert.equal(await run(`const d=C=>C;@d class C{value=4}
      const p=()=>{};class Legacy{constructor(@p public value:number){}}
      class Private{#x=1;#x=2;read(){return this.#x}}
      return JSON.stringify([new C().value,new Legacy(5).value,new Private().read()])`), '[4,5,2]')
    assert.equal(await run('function source(){let x=2;return x}return source.toString()'), 'function source(){let x=2;return x}')
  }
})

test('compiler intrinsic capture retains realm identity and static operations', () => {
  const realm = createContext()
  const constructor = runInContext('Function', realm)
  const intrinsics = captureCompilerIntrinsics(constructor)
  assert.equal(captureCompilerIntrinsics(constructor), intrinsics)
  const native = runInContext('({Object,TypeError,ReferenceError,WeakMap})', realm)
  runInContext('Object.prototype.constructor=null;Function.prototype.constructor=null;Object.defineProperty=null', realm)
  const target = intrinsics.Object()
  intrinsics.Object.defineProperty(target, 'value', { value: 2 })
  assert.equal(target.value, 2)
  assert.equal(intrinsics.Object.getPrototypeOf(target), native.Object.prototype)
  assert.equal(intrinsics.TypeError, native.TypeError)
  assert.equal(intrinsics.ReferenceError, native.ReferenceError)
  assert.equal(intrinsics.WeakMap, native.WeakMap)
  runInContext('Reflect', realm).decorate = () => 3
  assert.equal(intrinsics.Reflect.decorate(), 3)
})

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`resource protocol capture survives replacement of the user Symbol global (${bindingUpdates})`, async t => {
    const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
    t.after(() => runtime.dispose())
    const run = async program => {
      const result = await runtime.run('symbol-global', { program, bindings: [] })
      assert.equal(result.error, undefined, result.error?.message)
      return result.value
    }
    await run('const savedSymbol=Symbol;const keep=41;globalThis.Symbol=1;return 1')
    assert.equal(await run('return keep+1'), 42)
    assert.deepEqual(await run(`const events=[];using r={[savedSymbol.dispose](){events.push('disposed')}};
      return [Function('return 7')(),events]`), [7,['disposed']])
    await run('delete globalThis.Symbol;return 1')
    assert.equal(await run('return eval("keep+1")'), 42)
    assert.equal(await run('globalThis.Symbol=savedSymbol;return Symbol===savedSymbol'), true)
  })
}

test('managed module helpers retain captured intrinsics after earlier module effects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-captured-intrinsics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const extension of ['mjs','cjs']) {
    const mutation = join(directory, `mutate.${extension}`)
    const use = join(directory, `use.${extension}`)
    await writeFile(mutation, 'Object.prototype.constructor=null;Function.prototype.constructor=null;')
    const body = `const d=C=>C;@d class C{value=4};
      const p=()=>{};class Legacy{constructor(@p public value:number){}}
      function f(){let x=2;return x};const result=[f(),new C().value,new Legacy(5).value];`
    await writeFile(use, body + (extension === 'mjs' ? 'export {result}' : 'exports.result=result'))
    const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
    t.after(() => runtime.dispose())
    const load = path => extension === 'mjs' ? `await import(${JSON.stringify(pathToFileURL(path).href)})`
      : `require(${JSON.stringify(path)})`
    const first = await runtime.run(`module-intrinsics-${extension}`, { program: `${load(mutation)};return 1`, bindings: [] })
    assert.equal(first.error, undefined, JSON.stringify(first.error))
    const result = await runtime.run(`module-intrinsics-${extension}`, { program: `return JSON.stringify((${load(use)}).result)`, bindings: [] })
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    assert.equal(result.value, '[2,4,5]')
  }
})

test('private method bookkeeping retains captured WeakSet operations in cells and modules', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const body = `
    class C{#m(){return 1}static #m(){return 2}
      read(){return [this.#m(),this.#m.name,this.#m]}
      static read(){return [this.#m(),this.#m.name,this.#m]}}
    const has=WeakSet.prototype.has,add=WeakSet.prototype.add;
    let observed=0;
    try{
      WeakSet.prototype.has=WeakSet.prototype.add=function(){observed++;throw Error('source operation')};
      const first=new C().read(),second=C.read();
      const repeated=new C().read();
      let sourceError;
      try{new WeakSet().has({})}catch(error){sourceError=error.message}
      return [first[0],first[1],second[0],second[1],first[2]===repeated[2],observed,sourceError];
    }finally{WeakSet.prototype.has=has;WeakSet.prototype.add=add}
  `
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export function run(){${body}}`)}`
  for (const program of [body, `return (await import(${JSON.stringify(moduleUrl)})).run()`]) {
    const result = await runtime.run('private-method-intrinsics', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [1,'#m',2,'#m',true,1,'source operation'])
  }
})

test('fresh module graphs consume compiler facts without user collection protocols', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-module-fact-intrinsics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  for (const mutation of ['iterator', 'collections']) {
    for (const extension of ['mjs', 'cjs']) {
      const dependency = join(directory, `${mutation}-value.${extension}`)
      const consumer = join(directory, `${mutation}-consumer.${extension}`)
      await writeFile(dependency, extension === 'mjs' ? 'export const answer=42' : 'exports.answer=42')
      await writeFile(consumer, extension === 'mjs' ? `export {answer} from './${mutation}-value.mjs'`
        : `module.exports=require('./${mutation}-value.cjs')`)
      const load = `await import(${JSON.stringify(pathToFileURL(consumer).href)})`
      const source = `export async function run(){
        const changes=${mutation === 'iterator' ? '[[Array.prototype,Symbol.iterator]]'
          : '[[Map.prototype,"get"],[Map.prototype,"set"],[Map.prototype,"has"],[Map.prototype,"delete"],[Set.prototype,"has"],[Set.prototype,"add"]]'};
        const saved=changes.map(([owner,key])=>owner[key]);
        try{
          for(let i=0;i<changes.length;i++)changes[i][0][changes[i][1]]=null;
          const namespace=${load};
          return [typeof namespace.answer,namespace.answer,changes[0][0][changes[0][1]]===null];
        }finally{for(let i=0;i<changes.length;i++)changes[i][0][changes[i][1]]=saved[i]}
      }`
      const driver = join(directory, `${mutation}-driver-${extension}.mjs`)
      await writeFile(driver, source)
      const expression = `(await import(${JSON.stringify(pathToFileURL(driver).href)})).run()`
      const native = spawnSync(process.execPath, ['--input-type=module', '--eval',
        `try{console.log(JSON.stringify({value:await ${expression}}))}catch(error){console.log(JSON.stringify({error:error.message}))}`],
      { encoding: 'utf8', timeout: 20_000, env: uncoveredEnvironment() })
      assert.equal(native.status, 0, native.stderr)
      const expected = JSON.parse(native.stdout)
      const result = await runtime.run('module-fact-intrinsics', {
        program: `return JSON.stringify(await ${expression})`, bindings: [],
      })
      if (expected.error !== undefined) assert.ok(result.error?.message.includes(expected.error), result.error?.message)
      else {
        assert.equal(result.error, undefined, `${mutation}/${extension}: ${result.error?.message}`)
        assert.deepEqual(JSON.parse(result.value), expected.value)
      }
    }
  }
})

test('opaque module callbacks retain logical root operations during combined collection mutation', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const source = `export function run(callback){
    const changes=[[Map.prototype,'get'],[Map.prototype,'set'],[Map.prototype,'has'],
      [Set.prototype,'has'],[Set.prototype,'add'],[Array.prototype,'includes'],[Array.prototype,'filter']];
    const originals=changes.map(([owner,key])=>owner[key]);
    try{
      for(let i=0;i<changes.length;i++)changes[i][0][changes[i][1]]=function(){throw Error('user collection operation')};
      return callback();
    }finally{for(let i=0;i<changes.length;i++)changes[i][0][changes[i][1]]=originals[i]}
  }`
  const url = `data:text/javascript,${encodeURIComponent(source)}`
  const result = await runtime.run('nested-collection-mutation', { bindings: [],
    program: `let value=1;const module=await import(${JSON.stringify(url)});
      return module.run(()=>{value++;return [value,eval('value'),Function('return value')()]})`,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [2,2,2])
})
