import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { interceptWorkerMessages } from './runtime-observation.js'

test('TypeScript wrapped dynamic writes retain worker settlement and exact provenance', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = async program => {
    const execution = await runtime.runTentative('dynamic-typescript-writes', { program, bindings: [] })
    runtime.finalize(execution.settlement, true)
    assert.equal(execution.result.error, undefined, program)
    return execution
  }
  await run('const keep=7')
  for (const [source, name, expected] of [
    ['(assigned as number)=1', 'assigned', 1],
    ['(asserted!)=2', 'asserted', 2],
    ['(satisfied satisfies number)=3', 'satisfied', 3],
    ['({value: (destructured as number)}={value:4})', 'destructured', 4],
    ['[arrayValue as number]=[5]', 'arrayValue', 5],
  ]) {
    const result = await run(`function update(){eval("");${source}};update();return ${name}`)
    assert.equal(result.result.value, expected)
    assert.ok(result.settlement.replMemory.entries.find(entry => entry.name === name).definition.source.includes(name))
  }
  assert.deepEqual((await run('function increment(){eval("");(assigned as number)++;++(asserted!)};increment();return [keep,assigned,asserted]')).result.value, [7,2,3])
  assert.equal((await run('return keep')).result.value, 7)
})

test('dynamic root names retain exact call provenance across current and delayed eval', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const run = async program => {
    const execution = await runtime.runTentative('dynamic-provenance', { program, bindings: [] })
    runtime.finalize(execution.settlement, true)
    assert.equal(execution.result.error, undefined)
    return execution
  }
  const first = await run('eval("var generated=5"); const later=()=>eval("late=7"); return generated')
  assert.equal(first.result.value, 5)
  assert.equal(first.settlement.replMemory.entries.find(entry => entry.name === 'generated').definition.source,
    'eval("var generated=5")')
  assert.equal(first.settlement.replMemory.entries.some(entry => entry.name === 'late'), false)
  const second = await run('later(); return [generated,late]')
  assert.deepEqual(second.result.value, [5,7])
  assert.equal(second.settlement.replMemory.entries.find(entry => entry.name === 'late').definition.source,
    'eval("late=7")')
})

test('dynamic root evidence rejects unknown origins, mismatched names and invalid identifiers', async t => {
  const cases = [
    ['unknown origin', fact => { fact.write = 'foreign:"generated"' }],
    ['mismatched name', fact => { fact.name = 'other' }],
    ['non-identifier expression', fact => { fact.name = 'a-b' }],
    ['invalid identifier syntax', fact => { fact.name = 'class' }],
    ['noncanonical identifier', fact => { fact.name = 'x ' }],
    ['invalid target type', fact => { fact.write = 1 }],
  ]
  for (const [name, corrupt] of cases) await t.test(name, async t => {
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    assert.equal((await runtime.run('dynamic-corruption', { program: 'const saved=1', bindings: [] })).error, undefined)
    const intercepted = interceptWorkerMessages(runtime, 'dynamic-corruption', (message, deliver) => {
      if (message.type === 'done') {
        const fact = message.rootBindingFacts.find(fact => fact.name === 'generated')
        const origin = fact.write.slice(0, -':"generated"'.length)
        corrupt(fact)
        if (!['unknown origin','invalid target type'].includes(name)) fact.write = `${origin}:${JSON.stringify(fact.name)}`
        if (name === 'mismatched name') fact.write = `${origin}:"generated"`
      }
      deliver(message)
    })
    const execution = await runtime.runTentative('dynamic-corruption', { program: 'eval("var generated=5")', bindings: [] })
    intercepted.restore()
    runtime.finalize(execution.settlement, true)
    assert.equal(execution.result.error?.kind, 'worker-exit')
  })
})
