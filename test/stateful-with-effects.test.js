import assert from 'node:assert/strict'
import test from 'node:test'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { fixture } from './plugin-fixture.js'

const operations = [
  'x=(events.push("rhs"),2)',
  'x+=(events.push("rhs"),2)',
  'x++',
  'x||=(events.push("rhs"),2)',
  'x&&=(events.push("rhs"),2)',
  'x=(delete target.x,events.push("rhs"),2)',
  'x+=(delete target.x,events.push("rhs"),2)',
  'x=(target[Symbol.unscopables].x=true,2)',
  'x+=(target[Symbol.unscopables].x=true,2)',
  'typeof x',
  'delete x',
]
const sources = operations.flatMap(operation => [false, true].map(block => `
  return (function(){
    let x=7;const events=[];
    const target={x:1,[Symbol.unscopables]:{}};
    const object=new Proxy(target,{
      has(target,key){events.push('has:'+String(key));return Reflect.has(target,key)},
      get(target,key,receiver){events.push('get:'+String(key));return Reflect.get(target,key,receiver)},
      set(target,key,value,receiver){events.push('set:'+String(key));return Reflect.set(target,key,value,receiver)},
      deleteProperty(target,key){events.push('delete:'+String(key));return Reflect.deleteProperty(target,key)},
    });
    with(object) ${block ? `{${operation}}` : `${operation};`}
    return [events,x,target.x===undefined ? 'missing' : target.x]
  })()
`))

test('dynamic with references match native effects at every read and write', () => {
  for (const body of sources) {
    const source = `(function(){${body}})()`
    const runtime = createDynamicEnvironmentRuntime()
    assert.deepEqual(runtime.evaluate(eval, undefined, [source], runtime.environment()), Function(body)(), body)
  }
})

for (const [mode, config] of [
  ['stateful', {}],
  ['protected', { bindingUpdates: 'protected' }],
  ['legacy', { legacyBindingSettings: true }],
]) {
  test(`${mode} with writes retain native effects and RHS-dependent targets`, async t => {
    const state = fixture(config)
    t.after(() => state.dispose())
    for (const source of sources) {
      const result = await state.run('with-effects', source)
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, Function(source)(), source)
    }
  })
}
