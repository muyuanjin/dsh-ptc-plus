import assert from 'node:assert/strict'
import test from 'node:test'
import { managedGraph } from './managed-module-fixture.js'
import { LEGACY_USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'

async function legacyGraph(t, source) {
  const graph = await managedGraph(t, {
    'root.mjs': source,
    'provider.mjs': `export default class Value { constructor(){this.value=42} }
      export const events=[];export const counter={ [Symbol.toPrimitive](hint){events.push(hint);return 1} };
      export const falsy=0; export let value=42;
      export function change(){value=43};export function called(){return this}`,
    'wrapper.cjs': `module.exports=require('./provider.mjs')`,
    'value.json': '{"value":42}',
  })
  const provider=await graph.load('provider.mjs')
  graph.compilation.mark(graph.url('root.mjs'), {transform:LEGACY_USER_BINDING_TRANSFORM})
  return {graph,provider,root:await graph.load()}
}

test('legacy modules decode imports while retaining native constructors, receiver rules, exports and local shadows',async t => {
  const {root,provider}=await legacyGraph(t,`import Value,{value,called,change} from './provider.mjs';
    import * as namespace from './provider.mjs';
    export {value as forwarded,namespace}; export * as nested from './provider.mjs';export * from './provider.mjs';
    export default Value;export class Local {};
    export function read(value=7){const local=value;return [local,new Value().value,called(),called\`tag\`]}
    export function snapshot(){return {value}}
    export function get(){return value};export function changeValue(){change()}
    export async function dynamic(){return import('./provider.mjs')}
    export function evaluated(){return eval('[value,new Value().value,called(),typeof namespace.change]')}
    export function readonlyEval(){try{eval('const value=1;value=2')}catch(error){return error instanceof TypeError}}
    export function invalidEval(){try{eval('const value=1;const value=2')}catch(error){return error instanceof SyntaxError}}
    export async function common(){return (await import('./wrapper.cjs')).default}`)
  assert.equal(root.default,provider.default)
  assert.equal(root.namespace,provider)
  assert.equal(root.nested,provider)
  assert.deepEqual(root.read(),[7,42,undefined,undefined])
  assert.deepEqual(root.snapshot(),{value:42})
  root.changeValue()
  assert.equal(root.get(),43)
  assert.equal(root.forwarded,43)
  assert.deepEqual(root.evaluated(),[43,42,undefined,'function'])
  assert.equal(root.readonlyEval(),true)
  assert.equal(root.invalidEval(),true)
  assert.equal(await root.dynamic(),provider)
  const required=await root.common()
  assert.equal(required.default,provider.default)
  assert.equal(required.value,43)
})

test('legacy import writes preserve logical coercion, short circuiting and native readonly failures',async t => {
  const {root,provider}=await legacyGraph(t,`import {counter,falsy,events} from './provider.mjs';
    export {events};
    export function update(){counter++}
    export function compound(){counter+=1}
    export function logical(){falsy||=(events.push('rhs'),1)}
    export function skipped(){counter||=(events.push('wrong'),1)}
    export function iteration(){for(counter of [1]){}}
    export function keys(){for(counter in {a:1}){}}
    export function shadow(){let counter=1;counter++;counter+=1;return counter}
    export function property(){const box={value:1};box.value++;return box.value}
  `)
  for(const call of [root.update,root.compound,root.logical,root.iteration,root.keys]) assert.throws(call,TypeError)
  root.skipped()
  assert.equal(root.shadow(),3)
  assert.equal(root.property(),2)
  assert.deepEqual(provider.events,['number','default','rhs'])
})

test('legacy module links retain cyclic hoisting against compiled providers',async t => {
  const reader=compileStatefulModule(`import {answer} from './root.mjs';export function probe(){return answer()}`)
  const graph=await managedGraph(t,{
    'root.mjs': `import {probe} from './reader.mjs'; export function answer(){return 42};export const observed=probe()`,
    'reader.mjs': reader.code,
  })
  graph.compilation.mark(graph.url('root.mjs'),{transform:LEGACY_USER_BINDING_TRANSFORM})
  graph.compilation.mark(graph.url('reader.mjs'),{compiled:true,moduleInterface:reader.moduleInterface})
  assert.equal((await graph.load()).observed,42)
})

test('legacy module interfaces preserve native lexical TDZ in mixed cyclic graphs',async t => {
  const reader=compileStatefulModule(`import {value} from './root.mjs';export function probe(){return value}`)
  const graph=await managedGraph(t,{
    'root.mjs': `import {probe} from './reader.mjs';export const value=probe()`,
    'reader.mjs': reader.code,
  })
  graph.compilation.mark(graph.url('root.mjs'),{transform:LEGACY_USER_BINDING_TRANSFORM})
  graph.compilation.mark(graph.url('reader.mjs'),{compiled:true,moduleInterface:reader.moduleInterface})
  await assert.rejects(graph.load(),ReferenceError)
})

test('legacy interfaces preserve import attributes and string-valued export names',async t => {
  const {root}=await legacyGraph(t,`import data from './value.json' with {type:'json'};
    import {value as imported} from './provider.mjs';
    const local=data.value;export {local as 'json value',imported as 'forwarded value'};
    export {default as 'json namespace'} from './value.json' with {type:'json'};`)
  assert.equal(root['json value'],42)
  assert.equal(root['forwarded value'],42)
  assert.deepEqual(root['json namespace'],{value:42})
})
