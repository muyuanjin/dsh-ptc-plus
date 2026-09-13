import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { managedGraph } from './managed-module-fixture.js'
import { managedModuleAdapter } from '../internal/stateful-module-runtime.js'
import { LEGACY_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

const source = `
  function load(){return Function("return import('./value.mjs')")()}
  function alias(){const build=Function;return build("return import('./value.mjs')")()}
  function asyncAlias(){const build=(async function(){}).constructor;return build("return import('./value.mjs')")()}
  function generator(){const build=(function*(){}).constructor;return build("return import('./value.mjs')")().next().value}
  function callback(invoke){return invoke(Function,"return import('./value.mjs')")}
  function json(options){return Function('options',"return import('./value.json',options)")(options)}
  function thenable(){return Function("return import('./then.mjs')")()}
`
const names = 'load,alias,asyncAlias,generator,callback,json,thenable'
const opaque = (compile, code) => Promise.resolve(code).then(compile).then(invoke => invoke())

for (const transform of [USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
  for (const extension of ['mjs', 'cjs']) {
    test(`runtime-created imports retain module ownership without outer import expressions (${transform}, ${extension})`, async t => {
      const rootName = `root.${extension}`
      const graph = await managedGraph(t, {
        [rootName]: source + (extension === 'mjs' ? `export {${names}}` : `module.exports={${names}}`),
        'value.mjs': `export const value=42;export const effects=[];effects.push('once')`,
        'value.json': '{"value":42}',
        'then.mjs': `export let calls=0;export function then(resolve){calls++;resolve({calls})}`,
      }, rootName)
      graph.compilation.mark(graph.url(rootName), { transform })
      const wrappers = new Set()
      const hook = registerHooks({ load(url, context, nextLoad) {
        const adapter = managedModuleAdapter(url)
        if (adapter?.kind === 'module' && adapter.resolution.url === graph.url('value.mjs')) wrappers.add(url)
        return nextLoad(url, context)
      } })
      t.after(() => hook.deregister())
      const namespace = await graph.load()
      const root = extension === 'mjs' ? namespace : namespace.default
      const first = await root.load()
      assert.equal(first.value, 42)
      for (const load of [root.alias, root.asyncAlias, root.generator, () => root.callback(opaque)]) {
        assert.equal(await load(), first)
      }
      const concurrent = await Promise.all(Array.from({ length: 12 }, () => root.load()))
      assert.ok(concurrent.every(value => value === first))
      assert.deepEqual(first.effects, ['once'])
      assert.equal(wrappers.size, 1)
      const events = []
      const options = { get with() { events.push('with');return { get type() { events.push('type');return 'json' } } } }
      const json = await root.json(options)
      assert.equal(json.default.value, 42)
      assert.equal(await root.json(options), json)
      assert.deepEqual(events, ['with', 'type', 'with', 'type'])
      await assert.rejects(root.json({ with: { type: 1 } }), TypeError)
      const failure = {}
      await assert.rejects(root.json({ get with() { throw failure } }), error => error === failure)
      assert.deepEqual([await root.thenable(), await root.thenable()], [{ calls: 1 }, { calls: 2 }])
    })
  }
}

test('separate module compilation units keep their own sibling imports through eval aliases and opaque callbacks', async t => {
  const graphs = await Promise.all([42,99].map(value => managedGraph(t, {
    'root.mjs': `export function viaEval(){return eval("import('./value.mjs')")}
      export function indirect(){const evaluate=eval;return evaluate("import('./value.mjs')")}
      export function callback(invoke){return invoke(Function,"return import('./value.mjs')")}`,
    'value.mjs': `export const value=${value}`,
  })))
  const roots = await Promise.all(graphs.map(graph => graph.load()))
  for (const [index, root] of roots.entries()) {
    const first = await root.viaEval()
    assert.equal(first.value, [42,99][index])
    assert.equal(await root.indirect(), first)
    assert.equal(await root.callback(opaque), first)
  }
})

test('worker module imports and global binding activation retain their source-owned dynamic import bases', async t => {
  const graph = await managedGraph(t, {
    'root.mjs': `export function load(){return Function("return import('./value.mjs')")()}`,
    'root.cjs': `exports.load=()=>Function("return import('./value.mjs')")()`,
    'value.mjs': `export const value=42;export const effects=[];effects.push('once')`,
  })
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false }, { userBindingsCwd: graph.directory })
  t.after(() => runtime.dispose())
  const session = { id: 'module-dynamic-owner', session: { header: { cwd: graph.directory } } }
  const userBindings = createUserBindingsSnapshot({ entries: [{ id: 'helpers', name: 'helpers', scope: 'namespace',
    purpose: '', enabled: true, source: `export function load(){return Function("return import('./value.mjs')")()}` }] })
  const first = await runtime.run(session, { bindings: [], userBindings,
    program: `import * as root from './root.mjs';const cjs=require('./root.cjs');
      const values=await Promise.all([root.load(),cjs.load(),helpers.load()]);
      const retained=values[0];return [retained.value,values.every(value=>value===retained),retained.effects.length]` })
  assert.deepEqual(first.value, [42,true,1], first.error?.message)
  const next = await runtime.run(session, { bindings: [], userBindings,
    program: `return [(await root.load())===retained,(await helpers.load())===retained,retained.effects.length]` })
  assert.deepEqual(next.value, [true,true,1], next.error?.message)
})
