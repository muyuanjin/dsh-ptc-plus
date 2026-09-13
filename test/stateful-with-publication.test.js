import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './plugin-fixture.js'

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`${bindingUpdates} publishes a new var when its initializer writes through with`, async t => {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const result = await state.run('with-var-publication', `
      const object={untouched:5};
      with(object){var [untouched,fresh]=[6,7]}
      return [object.untouched,untouched===undefined,fresh,delete untouched]
    `)
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [6,true,7,false])
    const continued = await state.run('with-var-publication', 'return [untouched===undefined,fresh,delete untouched]')
    assert.equal(continued.error, undefined, continued.error?.message)
    assert.deepEqual(continued.value, [true,7,false])
    const declaration = await state.run('with-var-publication', 'let untouched=9;return untouched')
    if (bindingUpdates === 'protected') {
      assert.ok(declaration.error, 'the prior var must remain known to name protection')
    } else {
      assert.equal(declaration.error, undefined, declaration.error?.message)
      assert.equal(declaration.value, 9)
    }
  })
}

test('with writes preserve an existing root import source and its saved reader', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const imported = await state.run('with-import-publication', `
    import {readFile as alias} from 'node:fs';
    const original=alias;const read=()=>alias;
    const object={alias:0};
  `)
  assert.equal(imported.error, undefined, imported.error?.message)
  const result = await state.run('with-import-publication', `
    with(object){var [alias]=[7]}
    return [object.alias,alias===original,read()===original]
  `)
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [7,true,true])
  const continued = await state.run('with-import-publication', 'return [alias===original,read()===original]')
  assert.equal(continued.error, undefined, continued.error?.message)
  assert.deepEqual(continued.value, [true,true])
})
