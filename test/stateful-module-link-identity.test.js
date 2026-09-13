import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { managedGraph } from './managed-module-fixture.js'

for (const late of [false, true]) test(`static links retain their provider across public rewriting hooks (${late ? 'late' : 'early'})`, async t => {
  let graph
  let selected = 'first.mjs'
  const calls = []
  const install = () => {
    const hook = registerHooks({ resolve(source, context, next) {
      if (source !== 'probe-choice') return next(source, context)
      calls.push([context.parentURL, selected])
      return next(graph.url(selected), context)
    } })
    t.after(() => hook.deregister())
  }
  if (!late) install()
  graph = await managedGraph(t, {
    'root.mjs': `import {value} from 'probe-choice'; import * as ns from 'probe-choice';
      export {value as forwarded} from 'probe-choice'; export * as namespace from 'probe-choice';
      export * from 'probe-choice'; export function read(){return [value,ns.value]}
      export function load(){return import('probe-choice')}`,
    'first.mjs': 'export let value=42; export function change(){value=43}',
    'second.mjs': 'export const value=99',
  })
  if (late) install()
  const root = await graph.load()
  assert.deepEqual(root.read(), [42, 42])
  assert.deepEqual([root.forwarded, root.namespace.value, root.value], [42,42,42])
  assert.equal(calls.length, 1)
  selected = 'second.mjs'
  assert.equal((await root.load()).value, 99)
  assert.deepEqual(root.read(), [42, 42])
  root.change()
  assert.deepEqual([root.forwarded, root.namespace.value, root.value, ...root.read()], [43,43,43,43,43])
  assert.equal(calls.length, 2)
})

test('native require conditions do not replace the provider of an existing static link', async t => {
  let graph
  const calls = []
  const hook = registerHooks({ resolve(source, context, next) {
    if (source !== 'probe-conditional') return next(source, context)
    const require = context.conditions.includes('require')
    calls.push(require)
    return next(require ? fileURLToPath(graph.url('value.cjs')) : graph.url('value.mjs'), context)
  } })
  t.after(() => hook.deregister())
  graph = await managedGraph(t, {
    'root.mjs': `import {value} from 'probe-conditional'; import {createRequire} from 'node:module';
      export function read(){return value}; export function requireValue(){return createRequire(import.meta.url)('probe-conditional').value}`,
    'value.mjs': 'export const value=42',
    'value.cjs': 'exports.value=99',
  })
  const root = await graph.load()
  assert.equal(root.read(),42)
  assert.equal(root.requireValue(),99)
  assert.equal(root.read(),42)
  assert.deepEqual(calls,[false,true])
})

test('static links preserve native resolution failures that import.meta.resolve normally suppresses',async t => {
  const graph=await managedGraph(t,{'root.mjs':`import './missing.mjs';export const value=1`})
  await assert.rejects(graph.load(),error=>error.code==='ERR_MODULE_NOT_FOUND')
})

test('static links preserve exact user-thrown resolver failures and release their hooks',async t => {
  const graph=await managedGraph(t,{'root.mjs':`import 'probe-failure';export const value=1`})
  const failure={code:'ERR_MODULE_NOT_FOUND',url:graph.url('missing.mjs')}
  const hook=registerHooks({resolve(source,context,next){if(source==='probe-failure')throw failure;return next(source,context)}})
  t.after(()=>hook.deregister())
  await assert.rejects(graph.load(),error=>error===failure)
  assert.equal((await import('node:path')).basename('/a/b'),'b')
})
