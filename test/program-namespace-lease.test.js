import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

test('binding modules preserve every reserved program namespace operation', async t => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'program-operations', name: 'programOperations', scope: 'namespace', enabled: true,
    source: `
export function inspect() { return [typeof tools, Function('return delete tools')()] }
export function overwrite() { tools = {} }
`,
  }] }, 1)
  const options = {
    program: 'return programOperations.inspect()',
    userBindings,
    bindings: [{ global: 'tools', functions: { echo: async () => 1 } }],
  }
  const inspected = await runtime.run('program-operations', options)
  assert.equal(inspected.error, undefined, inspected.error?.message)
  assert.deepEqual(inspected.value, ['object', false])
  const overwritten = await runtime.run('program-operations', {
    ...options,
    program: 'programOperations.overwrite()',
  })
  assert.match(overwritten.error.message, /tools cannot be overwritten because reserved program bindings are not shadowable/u)
  const preserved = await runtime.run('program-operations', options)
  assert.equal(preserved.error, undefined, preserved.error?.message)
  assert.deepEqual(preserved.value, ['object', false])
})

test('expired module continuations cannot inspect or call a request namespace between cells', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  let calls = 0
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'lease', name: 'helper', scope: 'namespace', enabled: true,
    source: `
const outcomes = []
export function read() { return outcomes }
export function schedule() {
  const saved = tools.echo
  setTimeout(async () => {
    for (const operation of [
      () => tools.missing(), () => saved({}), () => 'echo' in tools,
      () => Object.keys(tools), () => Object.getOwnPropertyDescriptor(tools, 'echo'),
    ]) {
      try { await operation(); outcomes.push('allowed') }
      catch (error) { outcomes.push(error.message) }
    }
  }, 20)
}
`,
  }] }, 1)
  const started = await runtime.run('lease-gap', {
    program: 'helper.schedule()', userBindings,
    bindings: [{ global: 'tools', functions: { echo: async () => { calls++; return 1 } } }],
  })
  assert.equal(started.error, undefined)
  await delay(100)
  const finished = await runtime.run('lease-gap', {
    program: 'return helper.read()', userBindings,
    bindings: [{ global: 'tools', functions: {} }],
  })
  assert.deepEqual(finished.value, Array(5).fill('PTC execution lease expired'))
  assert.equal(calls, 0)
})

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`dynamic declarations preserve hard request overlays and refuse overwriting them (${bindingUpdates})`, async t => {
    const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
    t.after(() => runtime.dispose())
    let calls = 0
    const bindings = [{ global: 'tools', functions: { echo: async () => ++calls } }]
    const declared = await runtime.run('dynamic-request-overlay', { bindings,
      program: `const bare=eval('var tools;typeof tools');
        return [bare,tools===globalThis.tools,await tools.echo({})]`,
    })
    assert.equal(declared.error, undefined, declared.error?.message)
    assert.deepEqual(declared.value, ['object',true,1])
    // The overlay pre-empts the dynamic declaration, and the initializer's own write to the
    // non-shadowable name must not be discarded silently.
    // A realm-level var declaration is absorbed by the overlay; only an actual store fails.
    const realmDeclared = await runtime.run('dynamic-request-overlay-realm-declaration', { bindings,
      program: `return (0, eval)('var tools; typeof tools')`,
    })
    assert.equal(realmDeclared.error, undefined, realmDeclared.error?.message)
    assert.equal(realmDeclared.value, 'object')
    const written = await runtime.run('dynamic-request-overlay-write', { bindings,
      program: `eval('var tools=2;typeof tools')`,
    })
    assert.match(written.error.message, /tools cannot be overwritten because reserved program bindings are not shadowable/u)
    const preserved = await runtime.run('dynamic-request-overlay-preserved', { bindings,
      program: `return [typeof tools,tools===globalThis.tools,await tools.echo({})]`,
    })
    assert.equal(preserved.error, undefined, preserved.error?.message)
    assert.deepEqual(preserved.value, ['object',true,2])
  })

  test(`root lexical shadows preserve request namespaces and leases (${bindingUpdates})`, async t => {
    for (const [name, member] of [['code','run'],['repl','state'],['capabilities','tree']]) {
      const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
      t.after(() => runtime.dispose())
      let calls = 0
      const bindings = [{ global: name, functions: { [member]: async () => ++calls } },
        { global: 'tools', functions: {} }]
      const run = program => runtime.run(`namespace-shadow-${name}`, { program, bindings })
      const first = await run(`const ${name}='local';const readLocal=()=>${name};
        const savedHost=globalThis.${name}.${member};return [${name},await globalThis.${name}.${member}({})]`)
      assert.equal(first.error, undefined, first.error?.message)
      assert.deepEqual(first.value, ['local',1])
      runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false })
      const next = await run(`let [${name}]=['next'];let expired;
        try{await savedHost({})}catch(error){expired=error.message}
        return [readLocal(),${name},await globalThis.${name}.${member}({}),expired]`)
      assert.equal(next.error, undefined, next.error?.message)
      assert.deepEqual(next.value, ['next','next',2,'PTC execution lease expired'])
      const refused = await run('const tools="shadow"')
      assert.match(refused.error.message, /PTC-N001/)
      assert.match(refused.error.message, /state: unchanged/)
      assert.equal(calls, 2)
    }
  })
}
