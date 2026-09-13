import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { managedModuleAdapter, managedModuleImport } from '../internal/stateful-module-runtime.js'
import { managedGraph } from './managed-module-fixture.js'

function observeAdapters(t) {
  const loaded = new Set()
  const hook = registerHooks({
    load(url, context, next) {
      if (managedModuleAdapter(url)?.kind === 'module') loaded.add(url)
      return next(url, context)
    },
  })
  t.after(() => hook.deregister())
  return { loaded }
}

test('sequential and concurrent imports reuse one native adapter and one provider evaluation', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `export const events=[];events.push('once');export const value={}`,
  })
  const observations = observeAdapters(t)
  const first = await graph.load()
  for (let index = 0; index < 30; index++) assert.equal(await graph.load(), first)
  const concurrent = await Promise.all(Array.from({ length: 30 }, () => graph.load()))
  assert.ok(concurrent.every(namespace => namespace === first))
  assert.deepEqual(first.events, ['once'])
  assert.equal(observations.loaded.size, 1)
})

test('each import resolves its actual source once before reusing an adapter', async t => {
  let graph
  let selected = 'first.mjs'
  const resolutions = []
  const hook = registerHooks({ resolve(source, context, next) {
    if (source === 'ptc-cache-choice') {
      resolutions.push(selected)
      return { url: graph.url(selected), shortCircuit: true }
    }
    return next(source, context)
  } })
  t.after(() => hook.deregister())
  graph = await managedGraph(t, {
    'root.mjs': 'export const unused=0',
    'first.mjs': 'export const value=1',
    'second.mjs': 'export const value=2',
  })
  const observations = observeAdapters(t)
  const load = () => managedModuleImport(graph.url('root.mjs'), 'ptc-cache-choice')
  const first = await load()
  assert.equal(await load(), first)
  selected = 'second.mjs'
  const second = await load()
  assert.equal(second.value, 2)
  assert.equal(first.value, 1)
  assert.notEqual(first, second)
  assert.deepEqual(resolutions, ['first.mjs', 'first.mjs', 'second.mjs'])
  assert.equal(observations.loaded.size, 2)
})

test('hooks installed after PTC resolve the original source on every import', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': 'export const unused=0',
    'first.mjs': 'export const value=1',
    'second.mjs': 'export const value=2',
  })
  let selected = 'first.mjs'
  const resolutions = []
  const hook = registerHooks({ resolve(source, context, next) {
    if (source === 'ptc-cache-late-choice') {
      resolutions.push(selected)
      return next(graph.url(selected), context)
    }
    return next(source, context)
  } })
  t.after(() => hook.deregister())
  const load = () => managedModuleImport(graph.url('root.mjs'), 'ptc-cache-late-choice')
  assert.equal((await load()).value, 1)
  selected = 'second.mjs'
  assert.equal((await load()).value, 2)
  assert.deepEqual(resolutions, ['first.mjs', 'second.mjs'])
})

test('reentrant option getters retain each import resolution and release their hooks', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': 'export const value=1',
    'second.mjs': 'export const value=2',
  })
  let nested
  const result = await graph.load('root.mjs', { get with() {
    nested = graph.load('second.mjs')
    return {}
  } })
  assert.equal(result.value, 1)
  assert.equal((await nested).value, 2)
  assert.equal(await graph.load(), result)
  assert.equal((await import('node:path')).basename('/a/b'), 'b')
})

test('cached adapters retain per-call native option validation and getter effects', async t => {
  const graph = await managedGraph(t, { 'root.mjs': 'export const value=0' })
  const observations = observeAdapters(t)
  const source = 'data:application/json,{"value":7}'
  const events = []
  const options = { get with() {
    events.push('with')
    return { get type() { events.push('type'); return 'json' } }
  } }
  const load = value => managedModuleImport(graph.url('root.mjs'), source, value)
  const first = await load(options)
  assert.equal(await load(options), first)
  assert.deepEqual(events, ['with', 'type', 'with', 'type'])
  assert.equal(first.default.value, 7)
  assert.equal(observations.loaded.size, 1)
  await assert.rejects(load({ with: { type: 1 } }), TypeError)
  await assert.rejects(load(), /attribute/)
  await assert.rejects(load({ with: { type: 'invalid' } }), /attribute/)
  const failure = new Error('options failed')
  await assert.rejects(load({ get with() { throw failure } }), error => error === failure)
  assert.equal(await load({ with: { type: 'json' } }), first)
})

test('reusing an adapter still assimilates the real then once per import', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `let calls=0;export function then(resolve){calls++;resolve({calls,receiver:this})}`,
  })
  const observations = observeAdapters(t)
  const first = await graph.load()
  const second = await graph.load()
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => graph.load()))
  assert.deepEqual([first, second, ...concurrent].map(result => result.calls),
    Array.from({ length: 12 }, (_, index) => index + 1))
  assert.ok([second, ...concurrent].every(result => result.receiver === first.receiver))
  assert.equal(observations.loaded.size, 1)
})
