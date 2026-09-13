import { managedModuleImport } from '../internal/stateful-module-runtime.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { compileStatefulModule, createUserModuleCompilationHooks } from '../internal/stateful-module-compiler.js'
import { LEGACY_USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'

let sequence = 0
const evaluate = async (source, options = {}) => {
  const prepared = compileStatefulModule(source, options)
  const url = `data:text/javascript,${encodeURIComponent(prepared.code)}#module-test-${++sequence}`
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(url, { compiled: true, moduleInterface: prepared.moduleInterface, ...options })
  const hook = registerHooks({ resolve: compilation.resolve, load: compilation.load })
  try { return await managedModuleImport(url, url) } finally { hook.deregister() }
}

test('modules normalize exported and local revisions before native compilation', async () => {
  const module = await evaluate(`
    export const value: number = 1;
    export const value: number = value + 1;
    export function read(input = 3) { const input = input + 1; const local = 1; const local = 2; local++; return input + local + value }
    export function update() { value += 1 }
  `)
  assert.equal(module.value, 2)
  assert.equal(module.read(), 9)
  module.update()
  assert.equal(module.value, 3)
  assert.equal(module.read(), 10)
})

test('duplicate export mappings preserve prior initializer effects and native live values', async () => {
  const module = await evaluate(`
    const effects = [];
    let first = effects.push('first'); let second = effects.push('second');
    export { first as value }; export { second as value };
    export default effects.push('default-first'); export default effects.push('default-last');
    export { effects }; export function increment() { second += 1 }
  `)
  assert.equal(module.value, 2)
  assert.equal(module.default, 4)
  assert.deepEqual(module.effects, ['first', 'second', 'default-first', 'default-last'])
  module.increment()
  assert.equal(module.value, 3)
  const anonymous = await evaluate('export default async function* () { yield 3 }')
  assert.equal((await anonymous.default().next()).value, 3)
  assert.equal(anonymous.default.name, 'default')
})

test('anonymous default declarations preserve kinds and last export mapping without running discarded bodies', async () => {
  for (const source of ['function () { return 3 }', 'async function () { return 3 }',
    'function* () { yield 3 }', 'async function* () { yield 3 }']) {
    assert.equal((await evaluate(`export default ${source}`)).default.name, 'default')
  }
  const lastFunction = await evaluate(`
    export const effects = [];
    export default (effects.push('expression'), 1);
    export default function () { throw new Error('discarded body') }
    export default function () { return effects.length }
  `)
  assert.equal(lastFunction.default.name, 'default')
  assert.equal(lastFunction.default(), 1)
  assert.deepEqual(lastFunction.effects, ['expression'])
  const lastMapping = await evaluate(`
    export default function () { throw new Error('discarded body') }
    const value = 7; export { value as default };
  `)
  assert.equal(lastMapping.default, 7)
})

test('legacy module transforms retain readonly source semantics and reject unknown generations', async () => {
  const source = 'export function run() { const value = 1; value = 2; return value }'
  const module = await evaluate(source, { transform: LEGACY_USER_BINDING_TRANSFORM })
  assert.throws(() => module.run(), TypeError)
  assert.equal((await evaluate(source)).run(), 2)
  assert.throws(() => compileStatefulModule(source, { transform: 'unknown' }), /historical TypeScript transform/)
})

test('protected module compilation indexes bounded regions and adapts its interface', async () => {
  const module = await evaluate('export const value: number = 1; export function read(){return value}', {
    transform: PROTECTED_MODULE_TRANSFORM,
  })
  assert.equal(module.value, 1)
  assert.equal(module.read(), 1)
})

test('resource fallback preserves protected module lexical TDZ, readonly exports and native local policy', async () => {
  const options = { transform: PROTECTED_MODULE_TRANSFORM, nativeUsing: false }
  const module = await evaluate(`
    import {sep} from 'node:path';
    export const events=[];
    using resource={ [Symbol.dispose](){events.push('disposed')} };
    export const value=1;
    export let current=2;
    export function change(){current++;return current}
    export function forbidden(){value=3}
    export function local(){const value=1;value=2}
    export function read(){return [value,sep]}
    export const [first,second=readFirst()]=[5];
    function readFirst(){return first}
    export default class { static answer=4 }
  `, options)
  assert.deepEqual(module.events, ['disposed'])
  assert.equal(module.value, 1)
  assert.equal(module.change(), 3)
  assert.equal(module.current, 3)
  assert.equal(module.default.answer, 4)
  assert.equal(module.read()[0], 1)
  assert.equal(module.second, 5)
  assert.throws(() => module.forbidden(), /constant variable/)
  assert.throws(() => module.local(), /constant variable/)
  await assert.rejects(evaluate('export const before=typeof value; using resource=null; export const value=1', options),
    /before initialization/)
  const probe = `__ptcResourcePartial${++sequence}`
  try {
    await assert.rejects(evaluate(`
      using resource=null;
      globalThis[${JSON.stringify(probe)}]=()=>first;
      const [first,second=(()=>{throw new Error('stop')})()]=[1];
    `, options), /stop/)
    assert.equal(globalThis[probe](), 1)
  } finally { delete globalThis[probe] }
  const nested = await evaluate('export function run(){const value=1;using resource=null;value=2}', options)
  assert.throws(() => nested.run(), /constant variable/)
  assert.throws(() => compileStatefulModule('using resource=null; export const value=1; export const value=2', options),
    /already been declared/)
})

test('module resource names survive native and fallback acquisition in both policies', async () => {
  for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM]) {
    for (const nativeUsing of [false, undefined]) {
      const resourceSource = `
        using resource=class {static {events.push(this.name)}static [Symbol.dispose](){events.push(this.name)}};
        await using asyncResource:any=(class {static observed=this.name;static async [Symbol.asyncDispose](){events.push(this.name)}} as any);`
      const source = `export const events=[];${resourceSource}export {resource,asyncResource};`
      const module = await evaluate(source, { transform, nativeUsing })
      assert.equal(module.resource.name, 'resource')
      assert.equal(module.asyncResource.observed, 'asyncResource')
      assert.deepEqual(module.events, ['resource','asyncResource','resource'])
    }
  }
})

test('module exports retain native dependencies, namespace objects and default identities', async () => {
  const module = await evaluate(`
    export type Type = number;
    export declare const absent: number;
    export { format as value } from 'node:util';
    export { sep as value } from 'node:path';
    export * as paths from 'node:path';
    export {} from 'node:util';
    export default class Current { value = 2 }
    export function revise() { class Current { value = 3 }; return Current }
  `)
  const paths = await import('node:path')
  assert.equal(module.value, paths.sep)
  assert.equal(module.paths, paths)
  assert.equal(new module.default().value, 2)
  assert.equal(new (module.revise())().value, 3)
  assert.equal(new (await evaluate('export default class { value = 4 }')).default().value, 4)
  for (const source of ['export default class {}', 'export default (class {})',
    'export default (() => 4)', 'export default (function(){})']) {
    assert.equal((await evaluate(source)).default.name, 'default')
  }
  assert.deepEqual(Object.keys(await evaluate('const value = 1; value = 2')), [])
  await assert.rejects(evaluate('export { missing } from "node:util"; export const missing = 1'), /does not provide an export/)
  await assert.rejects(evaluate('export * from "node:util"; export { missing } from "node:path"'), /does not provide an export/)
})

test('stateful module enum writes are not replaced by original constant values', async () => {
  const module = await evaluate('enum E { Value = 1 }; E.Value = 2; export const value = E.Value')
  assert.equal(module.value, 2)
})

test('module export planning receives erased types and executable abstract classes', async () => {
  assert.deepEqual(Object.keys(await evaluate(`
    export default interface Hidden { value: number }
    export default function signature(): void;
    export type * from 'missing-type-only-module';
    export type * as Types from 'another-missing-type-only-module';
  `)), [])
  const named = await evaluate('export default abstract class Named { value=3 }')
  assert.equal(named.default.name, 'Named')
  assert.equal(new named.default().value, 3)
  const anonymous = await evaluate('export default abstract class { value=4 }')
  assert.equal(anonymous.default.name, 'default')
  assert.equal(new anonymous.default().value, 4)
  const signature = await evaluate(`export default function select(): number;
    export default function select(){return 5}`)
  assert.equal(signature.default(), 5)
})

test('native function groups keep the selected declaration identity and lexical resources commit normally', async () => {
  const module = await evaluate(`
    export function selected() { return 1 }
    export const saved = selected;
    export function selected() { return 2 }
    export const effects = [];
    using resource = { value: 7, [Symbol.dispose]() { effects.push('dispose') } };
    export { resource };
  `)
  assert.equal(module.saved, module.selected)
  assert.equal(module.selected.name, 'selected')
  assert.equal(module.selected(), 2)
  assert.equal(module.resource.value, 7)
  assert.deepEqual(module.effects, ['dispose'])
})

test('user module graphs compile ESM, CommonJS and data URLs without changing source files', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-module-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const esm = 'export const value = 1; export const value = 2'
  const commonjs = 'const value = 1; const value = 3; module.exports = { value }'
  await writeFile(join(cwd, 'value.mjs'), esm)
  await writeFile(join(cwd, 'value.cjs'), commonjs)
  const data = `data:text/javascript,${encodeURIComponent('export const value = 1; export const value = 4')}`
  const rootUrl = pathToFileURL(join(cwd, 'root.mjs')).href
  await writeFile(join(cwd, 'root.mjs'), `import { value as esm } from './value.mjs'; import cjs from './value.cjs'; import { value as data } from ${JSON.stringify(data)}; export const values = [esm, cjs.value, data]`)
  const compilation = createUserModuleCompilationHooks()
  compilation.mark(rootUrl)
  const hook = registerHooks({ resolve: compilation.resolve, load: compilation.load })
  t.after(() => hook.deregister())
  assert.deepEqual((await managedModuleImport(rootUrl, rootUrl)).values, [2, 3, 4])
  assert.equal(await readFile(join(cwd, 'value.mjs'), 'utf8'), esm)
  assert.equal(await readFile(join(cwd, 'value.cjs'), 'utf8'), commonjs)
  const returning = compileStatefulModule('module.exports = 4; return; module.exports = 5', { target: 'commonjs' })
  const target = {}
  Function('module', 'require', returning.code)(target, createRequire(import.meta.url))
  assert.equal(target.exports, 4)
  assert.equal((await evaluate('#!/usr/bin/env node\nexport const value = 7')).value, 7)
  const hashbang = compileStatefulModule('#!/usr/bin/env node\nmodule.exports = 8', { target: 'commonjs' })
  Function('module', 'require', hashbang.code)(target, createRequire(import.meta.url))
  assert.equal(target.exports, 8)
})

test('CommonJS wrapper scopes share local hoisting and update rules', () => {
  const prepared = compileStatefulModule(`
    const before=[read(),value];
    function read(){return 2}
    var value;
    const retained=()=>value;
    value=3;
    const local=4;const local=5;
    module.exports={before,value:retained(),local,name:read.name,path:require('node:path').basename('/a/b')};
  `, { target: 'commonjs' })
  const output = {}
  Function('module', 'require', prepared.code)(output, createRequire(import.meta.url))
  assert.deepEqual(output.exports, { before:[2,undefined], value:3, local:5, name:'read', path:'b' })
})

test('resource fallback disposes CommonJS resources before returning from the wrapper', () => {
  for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM]) {
    const prepared = compileStatefulModule(`
      const events=[];
      using resource={[Symbol.dispose](){events.push('disposed')}};
      module.exports=events;
      return;
    `, { target: 'commonjs', transform, nativeUsing: false })
    const output = {}
    Function('module', 'require', prepared.code)(output, createRequire(import.meta.url))
    assert.deepEqual(output.exports, ['disposed'])
  }
})

test('module hooks preserve external formats, prepared roots and historical graphs', () => {
  const hook = createUserModuleCompilationHooks({ transformForParent: url => url === 'user' ? USER_BINDING_TRANSFORM : undefined })
  const resolved = { url: 'data:text/javascript,export const value = 1' }
  assert.equal(hook.resolve('value', { parentURL: 'user' }, () => resolved), resolved)
  const source = { format: 'module', source: 'export const value = 1' }
  assert.match(hook.load(resolved.url, {}, () => source).source, /value/)
  const json = { format: 'json', source: '{"value":1}' }
  assert.equal(hook.load(resolved.url, {}, () => json), json)
  hook.mark(resolved.url, { compiled: true })
  assert.equal(hook.load(resolved.url, {}, () => source), source)
  const old = 'data:text/javascript,export const legacy = 1'
  hook.mark(old, { transform: LEGACY_USER_BINDING_TRANSFORM })
  assert.match(hook.load(old, {}, () => source).source, /export const value = 1/)
  assert.equal(hook.load('untracked', {}, () => source), source)
  assert.equal(hook.resolve('node:fs', { parentURL: 'user' }, () => ({ url: 'node:fs' })).url, 'node:fs')
  const binaryUrl = 'data:text/javascript,buffer'
  hook.mark(binaryUrl)
  assert.match(hook.load(binaryUrl, {}, () => ({ format: 'module-typescript', source: Buffer.from('export const value: number = 2') })).source, /value/)
  const own = new URL('../internal/typescript-transform.js', import.meta.url).href
  hook.mark(own)
  assert.equal(hook.load(own, {}, () => source), source)
})
