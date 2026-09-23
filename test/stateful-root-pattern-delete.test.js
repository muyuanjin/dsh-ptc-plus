import assert from 'node:assert/strict'
import test from 'node:test'
import { appendRunCodeEvents, fixture, orderedSurfaceSession } from './plugin-fixture.js'

test('root pattern references preserve declaration deletion before and after publication', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('root-candidate-delete', `
var x=10,y=20
for(var [x,y=delete x] of [[1]]){}
const loop=[x,y]
const [first=delete second,second=2,remove=()=>delete second]=[]
let escaped
try{const [x, y=(escaped=()=>delete x, (()=>{throw Error('stop')})())]=[99]}catch{}
const object={value:1}
return [loop,first,second,remove(),escaped(),x,y,delete object.value]
`)
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [[1,false],false,2,false,false,1,false,true])
  assert.deepEqual((await state.run('root-candidate-delete', 'second=3;return [remove(),escaped(),second,x]')).value,
    [false,false,3,1])
  await state.run('root-candidate-delete', 'let failedRootDelete')
  const failed = await state.run('root-candidate-delete', `
const [x,y=(failedRootDelete=()=>delete x,(()=>{throw Error('stop')})())]=[99]
`)
  assert.ok(failed.error)
  assert.deepEqual((await state.run('root-candidate-delete', 'return [failedRootDelete(),x,y]')).value, [false,1,false])
  assert.deepEqual((await state.run('root-candidate-dynamic-delete', `
const [first=eval('delete later'),later=2]=[];return [first,later]
`)).value, [false,2])
})

test('empty root loop patterns consume every iteration value without creating bindings', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.runDurable('empty-root-loops', `
const visits = []
for (var [] of [[], []]) visits.push('array-of')
for (var {} of [{}, {}]) visits.push('object-of')
for (var [] in { first: 1, second: 2 }) visits.push('array-in')
for (var {} in { first: 1, second: 2 }) visits.push('object-in')
const {} = (visits.push('empty-object'), {}), kept = visits.length,
  [] = (visits.push('empty-array'), [])
return [visits, kept]
`)
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value, [[
    'array-of', 'array-of', 'object-of', 'object-of', 'array-in', 'array-in',
    'object-in', 'object-in', 'empty-object', 'empty-array',
  ], 9])
  assert.deepEqual(result.meta.dshPtcPlusBindings.memory.entries.map(entry => entry.name).sort(), ['kept', 'visits'])
  assert.deepEqual((await state.run('empty-root-loops', 'const kept = kept + 1; return [visits.length, kept]')).value, [10, 10])
})

test('empty root array patterns close iterators and retain abrupt completion effects', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('empty-root-array-effects', `
const effects = []
const input = {
  [Symbol.iterator]() {
    effects.push('inner-open')
    return { next() { effects.push('inner-next'); return { done: false, value: 1 } },
      return() { effects.push('inner-close'); return {} } }
  }
}
for (var [] of [input]) effects.push('body')
const outer = {
  [Symbol.iterator]() {
    effects.push('outer-open')
    return { next() { effects.push('outer-next'); return { done: false, value: 1 } },
      return() { effects.push('outer-close'); return {} } }
  }
}
try { for (var [] of outer) effects.push('unreachable') }
catch (error) { effects.push(error.name) }
return effects
`)
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, ['inner-open', 'inner-close', 'body', 'outer-open', 'outer-next', 'outer-close', 'TypeError'])
  assert.equal((await state.run('empty-root-array-effects', 'return effects.length')).value, 7)
})

test('empty root object patterns coerce values and close the outer iterator on null input', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('empty-root-object-effects', `
const effects = []
for (var {} of [0, false, 'text']) effects.push('body')
const outer = {
  [Symbol.iterator]() {
    return { next() { effects.push('next'); return { done: false, value: null } },
      return() { effects.push('close'); return {} } }
  }
}
try { for (var {} of outer) effects.push('unreachable') }
catch (error) { effects.push(error.name) }
let kept = 1
try { var {} = (effects.push('initializer'), undefined), kept = 2 }
catch (error) { effects.push(error.name) }
return [effects, kept]
`)
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [['body', 'body', 'body', 'next', 'close', 'TypeError', 'initializer', 'TypeError'], 1])
  assert.equal((await state.run('empty-root-object-effects', 'return kept')).value, 1)
})

test('ordinary and dynamic deletion share eval-var ownership and preserve ordinary declarations', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.runDurable('eval-delete-parity', `
eval('var ordinaryDelete = 1; var dynamicDelete = 2')
const readDeleted = () => ordinaryDelete
const removed = [delete ordinaryDelete, eval('delete dynamicDelete')]
let missing
try { readDeleted() } catch (error) { missing = error.name }
const lexical = 3
var ordinary = 4
return [removed, typeof ordinaryDelete, typeof dynamicDelete, missing,
  delete lexical, eval('delete lexical'), delete ordinary, eval('delete ordinary')]
`)
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value, [[true, true], 'undefined', 'undefined', 'ReferenceError', false, false, false, false])
  const names = result.meta.dshPtcPlusBindings.memory.entries.map(entry => entry.name)
  assert.equal(names.includes('ordinaryDelete'), false)
  assert.equal(names.includes('dynamicDelete'), false)
  assert.deepEqual((await state.run('eval-delete-parity', `
eval('var ordinaryDelete = 5; var dynamicDelete = 6')
return [readDeleted(), dynamicDelete, delete ordinaryDelete, eval('delete dynamicDelete')]
`)).value, [5, 6, true, true])
})

test('deleted eval vars expose ambient properties and subsequent assignment uses ordinary ambient semantics', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('eval-delete-fallback', `
globalThis.visible = 10
Object.defineProperty(globalThis, 'fixed', { value: 20, configurable: false })
eval('var visible = 1; var fixed = 2')
const readVisible = () => visible
const removed = [delete visible, eval('delete fixed')]
const fallback = [readVisible(), fixed, delete fixed]
visible = 30
const assigned = [visible, globalThis.visible]
const ambientRemoved = delete visible
eval('var visible = 40')
return [removed, fallback, assigned, ambientRemoved, typeof globalThis.visible, readVisible()]
`)
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [[true, true], [10, 20, false], [30, 30], true, 'undefined', 40])
  assert.deepEqual((await state.run('eval-delete-fallback', "eval('var recreated = 1'); return [delete recreated, typeof recreated]")).value, [true, 'undefined'])
  assert.deepEqual((await state.run('eval-delete-fallback', `
var recreated
return [typeof recreated, delete recreated, typeof globalThis.recreated]
`)).value, ['undefined', false, 'undefined'])
})

test('eval-var deletion and recreation retain only the provable frontier on cold continuation', async t => {
  const session = orderedSurfaceSession('eval-delete-recovery')
  const writer = fixture({ bindingUpdates: 'stateful' })
  t.after(() => writer.dispose())
  const calls = []
  const functions = { record: async value => { calls.push(value); return calls.length } }
  const durable = 'const receipt = await tools.record({ value: 1 }); return receipt'
  const recorded = await writer.runDurable(session.id, durable, functions, { session, recordSession: 'deferred-result', callId: 'eval-delete-receipt' })
  assert.equal(recorded.isError, false, recorded.error?.message)
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(session.events, 'eval-delete-receipt', durable, recorded)
  const setup = 'eval("var removed = receipt; var retained = 2"); const readRemoved = () => removed; return [removed, retained]'
  const created = await writer.runDurable(session.id, setup, functions, { session, recordSession: 'deferred-result', callId: 'eval-delete-setup' })
  assert.equal(created.isError, false, created.error?.message)
  appendRunCodeEvents(session.events, 'eval-delete-setup', setup, created)
  const deletion = 'return [delete removed, typeof removed, retained]'
  const deleted = await writer.runDurable(session.id, deletion, functions, { session, recordSession: 'deferred-result', callId: 'eval-delete-remove' })
  assert.equal(deleted.isError, false, deleted.error?.message)
  assert.deepEqual(deleted.value, [true, 'undefined', 2])
  assert.equal(deleted.meta.dshPtcPlusBindings.memory.entries.some(entry => entry.name === 'removed'), false)
  appendRunCodeEvents(session.events, 'eval-delete-remove', deletion, deleted)
  const replacement = 'eval("var removed = 3"); return [readRemoved(), retained, receipt]'
  const recreated = await writer.runDurable(session.id, replacement, functions, { session, recordSession: 'deferred-result', callId: 'eval-delete-recreated' })
  assert.equal(recreated.isError, false, recreated.error?.message)
  assert.deepEqual(recreated.value, [3, 2, 1])
  assert.equal(recreated.meta.dshPtcPlusBindings.memory.entries.some(entry => entry.name === 'removed'), true)
  assert.equal(recreated.meta.dshPtcPlus.status, 'volatile')
  assert.equal(recreated.meta.dshPtcPlus.volatileReason, 'ambient eval')
  appendRunCodeEvents(session.events, 'eval-delete-recreated', replacement, recreated)
  await writer.dispose()

  const reader = fixture({ bindingUpdates: 'stateful' })
  t.after(() => reader.dispose())
  const restored = await reader.runDurable(session.id, 'return [typeof removed, typeof retained, receipt]', functions, { session })
  assert.equal(restored.isError, false, restored.error?.message)
  assert.deepEqual(restored.value, ['undefined', 'undefined', 1])
  assert.equal(restored.meta.dshPtcPlusBindings.memory.entries.some(entry => entry.name === 'removed'), false)
  assert.equal(restored.meta.dshPtcPlus.diagnostics.some(diagnostic => diagnostic.code === 'PTC-R002'), true)
  assert.deepEqual(calls, [{ value: 1 }])
})
