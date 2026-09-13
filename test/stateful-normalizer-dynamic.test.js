import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { fixture } from './plugin-fixture.js'

test('normalizer exposes logical cells, candidates and parameters from their actual owners', () => {
  const result = normalizeStatefulScopes('function f(value){const value=2;const [next,read=()=>value]=[3,undefined];return read()}', undefined, { deferDecorators: true })
  const values = result.dynamicBindings.filter(binding => binding.name === 'value')
  assert.ok(values.some(binding => binding.role === 'binding' && binding.property === 'v'))
  assert.ok(values.some(binding => binding.role === 'parameter' && binding.property === undefined))
  const candidate = values.find(binding => binding.role === 'candidate')
  assert.equal(candidate.linkPhysicalName, values.find(binding => binding.role === 'binding').physicalName)
  assert.ok(candidate.patternStart < candidate.patternEnd)
  assert.ok(candidate.patternEnd <= candidate.initializerStart)
  assert.ok(candidate.initializerStart < candidate.initializerEnd)
  assert.ok(result.dynamicBindings.every(binding => result.code.includes(binding.physicalName)))
})

test('local with lookup keeps object ownership and direct versus indirect calls', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('normalizer-with', `function example(){
    const value=1;
    const object={value:4,method(){return this===object}};
    let observed;
    with(object){value+=1;observed=[value,method(),(0,method)()];const local=2;observed.push(local)}
    return [value,object.value,observed];
  }return example()`)
  assert.deepEqual(result.value, [1,5,[5,true,false,2]], JSON.stringify(result.error))
})

test('local eval uses committed and candidate identities across declaration publication', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('normalizer-eval', `function example(){
    let value=1,read;
    const old=()=>eval('value');
    const [value,read=()=>eval('value')]=[2,undefined];
    eval('value=3');
    return [old(),read(),eval('value')];
  }return example()`)
  assert.deepEqual(result.value, [3,3,3], JSON.stringify(result.error))
})
