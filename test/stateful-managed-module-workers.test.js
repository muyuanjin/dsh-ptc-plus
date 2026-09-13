import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { UserBindingConsole } from '../internal/user-binding-console.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'
import { decodeValue } from '../internal/value-wire.js'
import { fixture } from './plugin-fixture.js'

const source = `import {readFile} from 'node:fs'; export {readFile};
  export const effects=[];effects.push('once');export function override(next){readFile=next}`
const setup = `
  const fs=require('node:fs'),sync=require('node:module').syncBuiltinESMExports;
  const original=fs.readFile;
  const retain=require('node:vm').runInThisContext('(ns)=>{const saved=ns.readFile;return {saved,read:()=>ns.readFile}}');
  const opaque=retain(ns);
  const updated=function updated(){};
  fs.readFile=updated;sync();
`
const check = `const live=opaque.read()===updated && ns.readFile===updated;
  const snapshot=opaque.saved===original;
  const replacement={value:7};ns.override(replacement);fs.readFile=original;sync();
  return [live,snapshot,opaque.read()===replacement,ns.readFile===replacement,ns.effects.length]`

async function files(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-managed-worker-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await Promise.all(Object.entries({
    'value.mjs': source,
    'chain.mjs': `export * from './value.mjs'`,
    'wrapper.cjs': `module.exports=require('./chain.mjs')`,
    'then.mjs': `export let calls=0;export function then(resolve){calls++;resolve(42)}`,
    'effect.mjs': `globalThis.moduleSideEffect=7`,
  }).map(([name, code]) => writeFile(join(cwd, name), code)))
  return cwd
}

test('actual root static, dynamic, eval and provided require entries share live namespaces across cells', async t => {
  const cwd = await files(t)
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const session = { id: 'managed-root', session: { header: { cwd } } }
  const run = program => runtime.run(session, { program, bindings: [] })
  const cold = await run(`const cold=new require('./value.mjs');return [typeof cold.readFile,cold.effects.length]`)
  assert.deepEqual(cold.value, ['function',1], cold.error?.message)
  const first = await run(`import * as ns from './chain.mjs';import './effect.mjs';
    const dynamic=await import('./chain.mjs');const required=require('./chain.mjs');
    const wrapped=require('./wrapper.cjs');const evaluated=await eval("import('./chain.mjs')");
    ${setup}
    return [ns===dynamic,ns===required,ns===wrapped,ns===evaluated,require('node:vm').runInThisContext('moduleSideEffect'),opaque.read()===updated]`)
  assert.deepEqual(first.value, [true,true,true,true,7,true], first.error?.message)
  const second = await run(check)
  assert.deepEqual(second.value, [true,true,true,true,1], second.error?.message)
  const then = await run(`import * as thenNamespace from './then.mjs';const before=thenNamespace.calls;
    const result=await import('./then.mjs');return [before,result,thenNamespace.calls]`)
  assert.deepEqual(then.value, [0,42,1], then.error?.message)
})

test('candidate runner and binding activation use managed namespaces at the binding storage base', async t => {
  const cwd = await files(t)
  const bindingSource = `import * as ns from './chain.mjs';
    export async function probe(){const dynamic=await import('./chain.mjs');
      const cjs=(await import('./wrapper.cjs')).default;
      const fs=(await import('node:fs')).default;const sync=(await import('node:module')).syncBuiltinESMExports;
      const original=fs.readFile;const retain=(await import('node:vm')).runInThisContext('(ns)=>{const saved=ns.readFile;return {saved,read:()=>ns.readFile}}');
      const opaque=retain(ns);const updated=function updated(){};fs.readFile=updated;sync();
      const live=opaque.read()===updated&&cjs.readFile===updated;fs.readFile=original;sync();
      return [ns===dynamic,live,opaque.saved===original,ns.effects.length]}`
  const worker = new Worker(new URL('../internal/user-binding-runner.js', import.meta.url), {
    workerData: { source: bindingSource, cwd, invocation: { symbol: 'probe', args: [] } }, execArgv: [],
  })
  t.after(() => worker.terminate())
  const candidate = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
  assert.equal(candidate.ok, true, candidate.error)
  assert.deepEqual(decodeValue(candidate.value), [true,true,true,1])
  const bindings = createUserBindingsSnapshot({ entries: [{ id:'helpers',name:'helpers',scope:'namespace',
    purpose:'',enabled:true,source:bindingSource }] })
  const runtime = new SessionRuntime({ bindingUpdates:'stateful',durableReplay:false }, { userBindingsCwd:cwd })
  t.after(() => runtime.dispose())
  const result = await runtime.run('managed-binding', { program:'return helpers.probe()',userBindings:bindings,bindings:[] })
  assert.deepEqual(result.value, [true,true,true,1], result.error?.message)
})

test('continuous console static, dynamic, eval and provided require entries use exact managed values', async t => {
  const cwd = await files(t)
  const owner = new UserBindingConsole({ cwd,maxWallMs:10_000,maxOutputBytes:64*1024,maxOldGenerationSizeMb:128 })
  t.after(() => owner.dispose())
  const source = `export const value=1`
  const cold = await owner.run({source,code:`const cold=require('./chain.mjs');[typeof cold.readFile,cold.effects.length]`})
  assert.equal(cold.output, "[ 'function', 1 ]", cold.error)
  const first = await owner.run({ source, environment:cold.environment, code:`import * as ns from './chain.mjs';
    const dynamic=await import('./chain.mjs');const required=require('./chain.mjs');
    const wrapped=require('./wrapper.cjs');const evaluated=await eval("import('./chain.mjs')");
    ${setup}
    [ns===dynamic,ns===required,ns===wrapped,ns===evaluated,opaque.read()===updated]` })
  assert.equal(first.error, undefined, first.error)
  assert.equal(first.output, '[ true, true, true, true, true ]')
  const second = await owner.run({ source,environment:first.environment,code:check })
  assert.equal(second.output, '[ true, true, true, true, 1 ]', second.error)
})

test('child-owned graphs preserve builtin updates for opaque namespace consumers and isolate state', async t => {
  const cwd = await files(t)
  const state = fixture({ bindingUpdates:'stateful' })
  t.after(() => state.dispose())
  const child = `import * as ns from './chain.mjs';${setup}${check}`
  const result = await state.run('managed-child', `const parentOnly=42;const child=await code.run({code:${JSON.stringify(child)},description:'Observe managed imports'});return [child.result,parentOnly,typeof ns]`, {}, {
    session:{id:'managed-child',events:[],header:{cwd}},
  })
  assert.deepEqual(result.value, [[true,true,true,true,1],42,'undefined'], result.error?.message)
})
