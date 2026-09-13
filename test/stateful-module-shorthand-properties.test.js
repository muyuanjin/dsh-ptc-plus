import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './plugin-fixture.js'

const provider = `data:text/javascript,${encodeURIComponent('export const marker=7;export const value={marker};export default value')}`

for (const [policy, config] of [
  ['stateful', { bindingUpdates: 'stateful' }],
  ['protected', { bindingUpdates: 'protected' }],
  ['legacy', { legacyBindingSettings: true }],
]) test(`module import shorthands preserve own data properties (${policy})`, async t => {
  const state = fixture(config)
  t.after(() => state.dispose())
  for (const clause of ['{value as __proto__}', '__proto__', '* as __proto__']) {
    const source = `import ${clause} from ${JSON.stringify(provider)};
      const object={__proto__};
      const descriptor=Object.getOwnPropertyDescriptor(object,'__proto__');
      function shadow(__proto__){return {__proto__}}
      export const result=[Object.hasOwn(object,'__proto__'),
        Object.getPrototypeOf(object)===Object.prototype,Object.keys(object),
        object.__proto__===__proto__,JSON.parse(JSON.stringify(object)).__proto__.marker,
        descriptor.enumerable,descriptor.writable,descriptor.configurable,
        Object.hasOwn(shadow(3),'__proto__'),shadow(3).__proto__];`
    const url = `data:text/javascript,${encodeURIComponent(source)}`
    const expected = (await import(url)).result
    const result = await state.run('import-shorthand', `return (await import(${JSON.stringify(url)})).result`)
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, expected, clause)
  }
})
