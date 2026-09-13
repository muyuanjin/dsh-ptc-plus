import assert from 'node:assert/strict'
import test from 'node:test'
import { UserBindingConsole } from '../internal/user-binding-console.js'
import { fixture } from './plugin-fixture.js'

test('generated cell helpers have empty completion and preserve user expression values', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  assert.deepEqual(await state.run('helper-completion', 'const seed:number=40;async function add(value:number){return seed+value}'), { logs: [] })
  assert.deepEqual(await state.run('helper-completion', '41;const typed:number=1;function empty(){}'), { logs: [], value: 41 })
  assert.deepEqual(await state.run('helper-completion', 'const typed:number=2;function empty(){};add(2)'), { logs: [], value: 42 })
  assert.deepEqual(await state.run('helper-completion', 'const decorate=value=>value;class C{@decorate #m(){}#m(){}}'), { logs: [] })
})

test('binding console declaration completion excludes generated helpers', async t => {
  const owner = new UserBindingConsole({ cwd: process.cwd(), maxWallMs: 10_000,
    maxOutputBytes: 64 * 1024, maxOldGenerationSizeMb: 128 })
  t.after(() => owner.dispose())
  let environment
  const run = async code => {
    const result = await owner.run({ source: 'export const answer:number=42', code, environment })
    environment = result.environment
    return result
  }
  const declaration = await run('const seed:number=40;async function add(value:number){return seed+value}')
  assert.equal(declaration.output, 'undefined', declaration.error)
  const preceding = await run('41;const typed:number=1;function empty(){}')
  assert.equal(preceding.output, '41', preceding.error)
  const final = await run('const typed:number=2;function empty(){};await add(2)')
  assert.equal(final.output, '42', final.error)
})
