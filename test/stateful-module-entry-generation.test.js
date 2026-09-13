import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

async function sessionRuntime(t, config) {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-generation-entry-'))
  t.after(() => rm(cwd,{ recursive:true,force:true }))
  await writeFile(join(cwd,'value.mjs'), 'export const value=42')
  await writeFile(join(cwd,'then.mjs'), 'export let calls=0; export function then(resolve){calls++;resolve(42)}')
  await writeFile(join(cwd,'consumer.mjs'), `import {value} from './value.mjs';import * as ns from './value.mjs';
    export const copy=value;export {value as forwarded};export {value as direct} from './value.mjs';
    export * as view from './value.mjs';export * from './value.mjs';
    export function read(){return [value,ns.value]};export function write(){value=0};
    export async function dynamic(){return (await import('./value.mjs')).value}`)
  const runtime = new SessionRuntime({ durableReplay:false,maxWallMs:5000,...config },{ userBindingsCwd:cwd })
  t.after(() => runtime.dispose())
  const session = { id:'generation-entry',session:{ header:{ cwd } } }
  return { runtime,cwd,run: (program, extra={}) => runtime.run(session,{ program,bindings:[],...extra }) }
}

for (const bindingUpdates of ['stateful','protected']) test(`dynamic imports preserve caller Promise, parameter errors and exact user failures (${bindingUpdates})`,async t => {
  const {run} = await sessionRuntime(t,{bindingUpdates})
  const result = await run(`const events=[];const failure={};
    const promise=import('node:buffer');const checks=[promise instanceof Promise];
    for(const operation of [()=>import(Symbol()),()=>import('node:buffer',1),
      ()=>import('node:buffer',{with:1}),()=>import('node:buffer',{with:{type:1}})]) {
      try{await operation();checks.push(false)}catch(error){checks.push(error instanceof TypeError)}
    }
    try{await import({toString(){throw failure}})}catch(error){checks.push(error===failure)}
    try{await import('node:buffer',{get with(){throw failure}})}catch(error){checks.push(error===failure)}
    const source={toString(){events.push('source');return 'node:buffer'}};
    const options={get with(){events.push('with');return {}}};
    const ns=await import(source,options);checks.push(ns===await promise);
    const evaluated=eval("import('node:buffer')");checks.push(evaluated instanceof Promise);
    return [checks,events]`)
  assert.deepEqual(result.value,[Array(9).fill(true),['source','with']],result.error?.message)
})

for (const mixed of [false,true]) test(`legacy PTC entries decode cached compiled providers (${mixed ? 'global binding' : 'generation change'})`,async t => {
  const {run,runtime} = await sessionRuntime(t,mixed ? {legacyBindingSettings:true} : {bindingUpdates:'stateful'})
  let userBindings
  if (mixed) {
    userBindings=createUserBindingsSnapshot({entries:[{id:'helpers',name:'helpers',scope:'namespace',enabled:true,purpose:'',
      source:`import {value as imported} from './value.mjs'; import * as ns from './then.mjs'; export const value=imported; export const view=ns`} ]})
    const first=await run('return helpers.value',{userBindings})
    assert.equal(first.value,42,first.error?.message)
  } else {
    const first=await run(`import {value} from './value.mjs'; import * as ns from './then.mjs';return value`)
    assert.equal(first.value,42,first.error?.message)
    runtime.reconfigure({legacyBindingSettings:true,maxWallMs:5000})
  }
  const result=await run(`import {value as saved} from './value.mjs'; import * as view from './then.mjs';
    const dynamic=await import('./value.mjs'); const required=require('./value.mjs');
    const before=view.calls;const then=await import('./then.mjs');
    function savedLoader(){return import('./value.mjs')}
    return [saved,dynamic.value,required.value,before,then,view.calls,import('node:buffer') instanceof Promise]`,{userBindings})
  assert.deepEqual(result.value,[42,42,42,0,42,1,true],result.error?.message)
  const later=await run('return (await savedLoader()).value',{userBindings})
  assert.equal(later.value,42,later.error?.message)
  const transitive=await run(`const descendant=await import('./consumer.mjs');let readonly=false;
    try{descendant.write()}catch(error){readonly=error.name==='TypeError'}
    return [descendant.copy,descendant.forwarded,descendant.direct,descendant.view.value,descendant.value,
      ...descendant.read(),await descendant.dynamic(),readonly]`,{userBindings})
  assert.deepEqual(transitive.value,[42,42,42,42,42,42,42,42,true],transitive.error?.message)
})

test('legacy import entry retains directives, native values and captured closures across cells',async t => {
  const {run}=await sessionRuntime(t,{legacyBindingSettings:true})
  const first=await run(`"use strict";function saved(){return [this,import('./value.mjs')]};return [saved.name,saved.length]`)
  assert.deepEqual(first.value,['saved',0],first.error?.message)
  const later=await run(`const pair=saved();const ns=await pair[1];const again=await import('./value.mjs');
    return [pair[0]===undefined,pair[1] instanceof Promise,ns===again,ns.value]`)
  assert.deepEqual(later.value,[true,true,true,42],later.error?.message)
})

test('current protected modules preserve native protection and retained source facts after policy changes', async t => {
  const {run,runtime,cwd} = await sessionRuntime(t,{bindingUpdates:'protected'})
  await writeFile(join(cwd,'protected.mjs'), `export const value=1;export function write(){value=2}`)
  await writeFile(join(cwd,'duplicates.mjs'), `export function duplicate(){let value=1;let value=2;return value}`)
  const first = await run(`const local=await import('./protected.mjs'),consumer=await import('./consumer.mjs');
    const checks=[];for(const write of [local.write,consumer.write])try{write();checks.push(false)}catch(error){checks.push(error.name)}
    try{await import('./duplicates.mjs');checks.push(false)}catch(error){checks.push(error.name)}
    function retained(){return [local.write.toString(),consumer.read.toString(),local.value]}
    return [checks,retained()]`)
  const expected = ['function write(){value=2}','function read(){return [value,ns.value]}',1]
  assert.deepEqual(first.value,[['TypeError','TypeError','SyntaxError'],expected],first.error?.message)
  runtime.reconfigure({bindingUpdates:'stateful',maxWallMs:5000})
  const next = await run('return retained()')
  assert.deepEqual(next.value,expected,next.error?.message)
})

test('actual static named, namespace and forwarded links survive a later rewriting hook and dynamic retarget',async t => {
  const {run,cwd}=await sessionRuntime(t,{bindingUpdates:'stateful'})
  await writeFile(join(cwd,'second.mjs'),'export const value=99')
  await writeFile(join(cwd,'consumer.mjs'),`import {value} from 'probe-choice';import * as ns from 'probe-choice';
    export {value as forwarded} from 'probe-choice';export * as view from 'probe-choice';export * from 'probe-choice';
    export function read(){return [value,ns.value]};export function load(){return import('probe-choice')}`)
  const setup=await run(`const selections=[];let selected='value.mjs';const path=require('node:path'),url=require('node:url');
    const hook=require('node:module').registerHooks({resolve(source,context,next){
      if(source!=='probe-choice')return next(source,context);
      selections.push(selected);return next(url.pathToFileURL(path.join(${JSON.stringify(cwd)},selected)).href,context)
    }});return true`)
  assert.equal(setup.value,true,setup.error?.message)
  const initial=await run(`import * as consumer from './consumer.mjs';
    return [...consumer.read(),consumer.forwarded,consumer.view.value,consumer.value,selections.length]`)
  assert.deepEqual(initial.value,[42,42,42,42,42,1],initial.error?.message)
  const changed=await run(`selected='second.mjs';const changed=await consumer.load();
    return [changed.value,...consumer.read(),consumer.forwarded,consumer.view.value,consumer.value,selections.length]`)
  assert.deepEqual(changed.value,[99,42,42,42,42,42,2],changed.error?.message)
})
