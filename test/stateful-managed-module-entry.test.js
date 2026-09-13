import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { types } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { adaptModuleOperations } from '../internal/managed-module-operations.js'
import { identitySourceMap } from '../internal/source-position-map.js'
import test from 'node:test'
import { managedModuleImport, managedRequire } from '../internal/stateful-module-runtime.js'
import { managedGraph } from './managed-module-fixture.js'

const builtin = `import {readFile} from 'node:fs'; export {readFile};
  export function override(value){readFile=value}`
const opaque = `export function retain(namespace){const saved=namespace.readFile;return {saved,read:()=>namespace.readFile}};
  export function nativeImport(url){return import(url)};`

test('actual managed imports give opaque retained namespaces live builtin values and exact saved functions', async t => {
  const original = fs.readFile
  t.after(() => { fs.readFile = original; syncBuiltinESMExports() })
  const graph = await managedGraph(t, {
    'root.mjs': builtin,
    'chain.mjs': `export * from './root.mjs'; export * as nested from './root.mjs'`,
    'consumer.mjs': `import * as ns from './chain.mjs'; import {readFile} from './chain.mjs';
      import {retain} from './opaque.mjs'; export const retained=retain(ns);
      export function read(){return [readFile,ns.readFile,ns.nested.readFile]};
      export async function again(){return import('./root.mjs')}`,
    'opaque.mjs': opaque,
  }, 'consumer.mjs', ['opaque.mjs'])
  const consumer = await graph.load()
  const root = await graph.load('root.mjs')
  assert.equal(await consumer.again(), root)
  assert.equal(consumer.retained.saved, original)
  const updated = function updated() {}
  fs.readFile = updated
  syncBuiltinESMExports()
  assert.deepEqual(consumer.read(), [updated, updated, updated])
  assert.equal(consumer.retained.read(), updated)
  const replacement = { value: 7 }
  root.override(replacement)
  fs.readFile = original
  syncBuiltinESMExports()
  assert.deepEqual(consumer.read(), [replacement, replacement, replacement])
  assert.equal(consumer.retained.read(), replacement)
  assert.equal(consumer.retained.saved, original)
  const raw = await graph.opaque['opaque.mjs'].nativeImport(graph.url('root.mjs'))
  assert.notEqual(raw, root)
  assert.notEqual(raw.readFile, replacement)
  assert.equal(types.isModuleNamespaceObject(raw), true)
  assert.equal(types.isModuleNamespaceObject(root), false)
  assert.equal((await managedModuleImport(graph.url('consumer.mjs'), 'node:module')).createRequire, createRequire)
})

test('PTC CommonJS require and dynamic/eval imports share live values and once-only native evaluation', async t => {
  const graph = await managedGraph(t, {
    'root.cjs': `const namespace=require('./value.mjs'); module.exports={namespace,
      read(){return namespace.value}, dynamic(){return import('./value.mjs')},
      evaluate(){return eval("import('./value.mjs')")},
      requireAgain(){return require('./value.mjs')}, json:require('./value.json')};`,
    'value.mjs': `export const object={}; export let value=1;export const effects=[];
      effects.push('once');export function update(next){value=next}`,
    'value.json': '{"value":4}',
  }, 'root.cjs')
  const namespace = (await graph.load()).default
  assert.equal(namespace.read(), 1)
  assert.equal(namespace.json.value, 4)
  namespace.namespace.update(3)
  assert.equal(namespace.read(), 3)
  assert.equal((await namespace.dynamic()).value, 3)
  assert.equal((await namespace.evaluate()).value, 3)
  assert.equal(namespace.requireAgain(), namespace.namespace)
  assert.deepEqual(namespace.namespace.effects, ['once'])
  const nativeRequire = createRequire(graph.url('root.cjs'))
  const raw = nativeRequire('./value.mjs')
  assert.notEqual(raw.value, 3)
  assert.equal(managedRequire(graph.url('root.cjs'), nativeRequire)('./value.mjs'), namespace.namespace)
})

test('require module.exports interop returns the original value, including forward and star exports', async t => {
  const graph = await managedGraph(t, {
    'root.cjs': `module.exports=[require('./value.mjs'),require('./forward.mjs'),require('./star.mjs'),require('./native-star.mjs')];`,
    'value.mjs': `export function callable(){return 42}; export {callable as 'module.exports'};`,
    'forward.mjs': `export {'module.exports'} from './value.mjs'`,
    'star.mjs': `export * from './value.mjs'`,
    'native.mjs': `const object={value:7};export {object as 'module.exports'}`,
    'native-star.mjs': `export * from './native.mjs';export const own=1`,
  }, 'root.cjs', ['native.mjs'])
  const values = (await graph.load()).default
  assert.equal(values[0], values[1])
  assert.equal(values[0], values[2])
  assert.equal(values[0](), 42)
  assert.equal(values[3], graph.opaque['native.mjs']['module.exports'])
})

test('then exports retain native linking and apply the real thenable exactly once per dynamic import', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `import * as namespace from './then.mjs';export {namespace};
      export function load(){return import('./then.mjs')};export function evaluated(){return eval("import('./then.mjs')")};`,
    'then.mjs': `export let calls=0;export const result={value:42};
      export function then(resolve){result.receiver=this;calls++;resolve(result)};`,
    'number.mjs': `export const then=7;export const value=3`,
    'native.mjs': `export function then(resolve){resolve(17)}`,
    'failure.mjs': `export function then(){throw new Error('real then failure')}`,
  }, 'root.mjs', ['native.mjs'])
  const root = await graph.load()
  assert.equal(root.namespace.calls, 0)
  assert.equal(typeof root.namespace.then, 'function')
  assert.equal(await root.load(), root.namespace.result)
  assert.equal(root.namespace.calls, 1)
  assert.equal(root.namespace.result.receiver, root.namespace)
  assert.equal(await root.evaluated(), root.namespace.result)
  assert.equal(root.namespace.calls, 2)
  assert.equal((await graph.load('number.mjs')).then, 7)
  assert.equal(await graph.load('native.mjs'), 17)
  await assert.rejects(graph.load('failure.mjs'), /real then failure/)
})

test('native options, attributes, missing exports, TLA and module cache remain authoritative', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `export async function json(options){return import('./value.json',options)};
      export function same(){return import('./await.mjs')}`,
    'value.json': '{"answer":42}',
    'await.mjs': `export const events=[];events.push('start');await Promise.resolve();events.push('end');export const object={}`,
    'missing.mjs': `import {absent} from './await.mjs';export {absent}`,
  })
  const root = await graph.load()
  const order = []
  const options = { get with(){order.push('with');return {get type(){order.push('type');return 'json'}}} }
  assert.equal((await root.json(options)).default.answer, 42)
  assert.deepEqual(order, ['with', 'type'])
  await assert.rejects(root.json(), /attribute/)
  await assert.rejects(root.json({with:{type:'invalid'}}), /attribute/)
  await assert.rejects(root.json({with:{type:1}}), TypeError)
  const failure = new Error('attribute getter')
  await assert.rejects(root.json({get with(){throw failure}}), error => error === failure)
  const first = await root.same()
  assert.equal(await root.same(), first)
  assert.deepEqual(first.events, ['start', 'end'])
  await assert.rejects(graph.load('missing.mjs'), /does not provide an export/)
  const namespace = await managedModuleImport(graph.url('root.mjs'), 'node:fs')
  assert.equal(namespace, await import('node:fs'))
})


test('compiled CommonJS source uses its native wrapper filename when no loader URL was supplied', async t => {
  const graph = await managedGraph(t, { 'root.mjs': 'export const value=7' })
  const code = `"use strict";module.exports={load(){return import('./root.mjs')},read(){return require('./root.mjs').value}}`
  const prepared = compileStatefulModule(code, { target:'commonjs' })
  const filename = join(graph.directory, 'prepared.cjs')
  await writeFile(filename, prepared.code)
  graph.compilation.mark(graph.url('prepared.cjs'), { compiled:true })
  const module = createRequire(graph.url('root.mjs'))(filename)
  assert.equal((await module.load()).value, 7)
  assert.equal(module.read(), 7)
})

test('standalone import adaptation preserves directives and the promise rejection boundary', async t => {
  const graph = await managedGraph(t, { 'root.mjs': 'export const value=7' })
  const source = '"use strict"; import(Symbol("bad"))'
  const prepared = adaptModuleOperations({code:source,sourceMap:identitySourceMap(source.length)}, {target:'commonjs'})
  const program = prepared.code
  // Returning the completion keeps this synthetic wrapper independent of REPL state.
  const expression = program.lastIndexOf('\n')
  const run = Function('require', program.slice(0,expression+1)+'return '+program.slice(expression+1))
  await assert.rejects(run(createRequire(graph.url('root.mjs'))), TypeError)
})


test('cyclic forwarding searches remaining native star sources and retains self namespace identity', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `export * from './cycle.mjs';export * from './source.mjs';export * as self from './root.mjs'`,
    'cycle.mjs': `export {value,update} from './root.mjs'`,
    'source.mjs': `export let value=1;export function update(){value++}`,
  })
  const namespace = await graph.load()
  assert.equal(namespace.self, namespace)
  assert.equal(namespace.value, 1)
  const cycle = await graph.load('cycle.mjs')
  cycle.update()
  assert.equal(namespace.value, 2)
  assert.equal(cycle.value, 2)
})


test('require interop follows native namespace membership when module.exports is ambiguous', async t => {
  const graph = await managedGraph(t, {
    'root.cjs': `module.exports={ambiguous:require('./ambiguous.mjs'),namespace:require('./namespace.mjs')}`,
    'first.mjs': `export const first=1;export {first as 'module.exports'}`,
    'second.mjs': `export const second=2;export {second as 'module.exports'}`,
    'ambiguous.mjs': `export * from './first.mjs';export * from './second.mjs'`,
    'namespace.mjs': `export * as 'module.exports' from './ambiguous.mjs'`,
  }, 'root.cjs')
  const result = (await graph.load()).default
  assert.deepEqual(Object.keys(result.ambiguous), ['first','second'])
  assert.equal(result.ambiguous.first, 1)
  assert.equal(result.ambiguous.second, 2)
  assert.equal(result.namespace, result.ambiguous)
})


test('fresh CommonJS require compiles native extensions and detected module syntax before execution', async t => {
  const graph = await managedGraph(t, {
    'root.cjs': `module.exports=['./common.cjs','./plain.js','./esm.js','./typed.mts','./typed.cts','./typed.ts','./noext','./value.json','./lexical.js','./class.js'].map(path=>require(path))`,
    'common.cjs': `const value=1;const value=2;module.exports={value}`,
    'plain.js': `const value=1;const value=3;module.exports={value}`,
    'esm.js': `export const value=1;export const value=4`,
    'typed.mts': `export const value:number=1;export const value:number=5`,
    'typed.cts': `const value:number=1;const value:number=6;module.exports={value}`,
    'typed.ts': `const value:number=1;const value:number=7;module.exports={value}`,
    'noext': `const value=1;const value=8;module.exports={value}`,
    'value.json': '{"value":9}',
    'lexical.js': `const require=1;const require=10;globalThis.managedWrapperLexical=require`,
    'class.js': `class __filename {};globalThis.managedWrapperClass=__filename.name`,
  }, 'root.cjs')
  t.after(() => {delete globalThis.managedWrapperLexical;delete globalThis.managedWrapperClass})
  const values = (await graph.load()).default
  assert.deepEqual(values.slice(0,8).map(item=>item.value), [2,3,4,5,6,7,8,9])
  assert.deepEqual(Object.keys(values[8]), [])
  assert.equal(globalThis.managedWrapperLexical, 10)
  assert.equal(globalThis.managedWrapperClass, '__filename')
})

test('CommonJS hook format fallback preserves explicit package module types', async t => {
  for (const type of ['module','commonjs']) {
    const graph = await managedGraph(t, {
      'package.json': JSON.stringify({type}),
      'root.cjs': `module.exports=require('./value.js')`,
      'value.js': type==='module' ? 'export const value=1;export const value=2'
        : 'const value=1;const value=2;module.exports={value}',
    }, 'root.cjs', [], { load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      return url.endsWith('/value.js') ? { ...result, format: undefined } : result
    } })
    assert.equal((await graph.load()).default.value, 2)
  }
})


test('loader-owned namespace metadata preserves accepted attributes without resolving its URL again', async t => {
  const seen = []
  const graph = await managedGraph(t, {
    'root.mjs': `export const effects=[];effects.push('once');export const value=42`,
  }, 'root.mjs', [], {load(url,context,nextLoad){
    if (url.endsWith('/root.mjs')) {
      seen.push(context.importAttributes.flavor)
      return nextLoad(url,{...context,importAttributes:{}})
    }
    return nextLoad(url,context)
  }})
  const selfRelations = []
  const requests = []
  const observer = registerHooks({resolve(source,context,nextResolve){
    const parent = context.parentURL
    const flavor = context.importAttributes.flavor
    const result = nextResolve(source,context)
    if (parent === graph.url('root.mjs') && flavor !== undefined) {
      const relations = source === graph.url('root.mjs') ? requests : selfRelations
      relations.push({url:result.url,flavor})
    }
    return result
  }})
  t.after(() => observer.deregister())
  const namespace = await graph.load('root.mjs',{with:{flavor:'accepted'}})
  assert.equal(namespace.value, 42)
  assert.deepEqual(namespace.effects, ['once'])
  assert.deepEqual(seen, ['accepted'])
  assert.deepEqual(selfRelations, [{url:graph.url('root.mjs'),flavor:'accepted'}])
  assert.equal(requests.length, 1)
  assert.equal(await graph.load('root.mjs',{with:{flavor:'accepted'}}), namespace)
  assert.equal(requests.length, 2)
  assert.equal(selfRelations.length, 1)
})


test('constructed provided require preserves namespace values and primitive constructor return rules', async t => {
  const graph = await managedGraph(t, {
    'root.cjs': `module.exports=[new require('./value.mjs'),Reflect.construct(require,['./primitive.mjs']),require.prototype]`,
    'value.mjs': 'export const value=7',
    'primitive.mjs': `const value=8;export {value as 'module.exports'}`,
  }, 'root.cjs')
  const [namespace,primitive,prototype] = (await graph.load()).default
  assert.equal(namespace.value, 7)
  assert.equal(Object.getPrototypeOf(primitive), prototype)
  const require = managedRequire(graph.url('root.cjs'),createRequire(graph.url('root.cjs')))
  assert.equal(require('./primitive.mjs'), 8)
})


test('native CommonJS resolution cache hits retain managed values without resolving or evaluating again', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `export let value=1;export const effects=[];effects.push('once');export function update(){value++}`,
  })
  const resolutions = []
  const observer = registerHooks({resolve(source,context,nextResolve){
    if (source==='./root.mjs') resolutions.push(context.parentURL)
    return nextResolve(source,context)
  }})
  t.after(() => observer.deregister())
  const firstParent = graph.url('first.cjs')
  const secondParent = graph.url('second.cjs')
  const first = managedRequire(firstParent,createRequire(firstParent))('./root.mjs')
  const second = managedRequire(secondParent,createRequire(secondParent))('./root.mjs')
  assert.deepEqual(resolutions, [firstParent])
  assert.equal(first, second)
  first.update()
  assert.equal(second.value, 2)
  assert.deepEqual(second.effects, ['once'])
})
