import assert from 'node:assert/strict'
import test from 'node:test'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'
import { fixture } from './plugin-fixture.js'

test('protected root writes check TDZ before effects and readonly errors through every reference entry', () => {
  const ambient = { x: 9 }
  let reads = 0, writes = 0, overlay = false
  const runtime = createStatefulRootRuntime({
    readAmbient(name) { reads++; return ambient[name] },
    writeAmbient(name, value) { writes++; ambient[name] = value },
    typeofAmbient: name => typeof ambient[name], hasAmbient: name => name in ambient,
    deleteAmbient: name => delete ambient[name], hasOverlay: () => overlay,
  })
  const cell = runtime.begin({ declared: ['x', 'fixed', 'pending'], readOnly: ['fixed'],
    languageSemantics: 'protected-v1', committed() {} })
  for (const name of ['x', 'fixed', 'pending']) {
    assert.throws(() => { cell.values[name] = 1 }, ReferenceError)
    assert.throws(() => { cell.reference(name, false).value = 1 }, ReferenceError)
    assert.throws(() => { cell.dynamic().reference(name).value = 1 }, ReferenceError)
  }
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  assert.deepEqual(ambient, { x: 9 })
  cell.assign('x', 2, 'x')
  cell.reference('x', false).value = 3
  assert.equal(cell.values.x, 3)
  assert.equal(ambient.x, 9)
  cell.assign('fixed', 2, 'fixed')
  assert.throws(() => { cell.values.fixed = 3 }, TypeError)
  overlay = true
  cell.reference('pending', false).value = 4
  assert.equal(ambient.pending, 4)
})

test('protected cells retain native TDZ errors, RHS effects and successful declaration initialization', async t => {
  const state = fixture({ bindingUpdates: 'protected' })
  t.after(() => state.dispose())
  let sequence = 0
  for (const declaration of ['let x=2', 'const x=2', 'class x{}']) {
    for (const write of ['x=(events.push("rhs"),1)', 'eval("x=(events.push(\\"rhs\\"),1)")',
      '[x]=[1]', '({x}={x:1})', 'for(x of [1]){}', 'x++', 'x+=1']) {
      const id = `protected-tdz-${sequence++}`
      const source = `const events=[];globalThis.x=9;let kind;
        try{${write}}catch(error){kind=error.name}
        ${declaration};return [kind,events,globalThis.x,typeof x]`
      const expected = Function(source)()
      delete globalThis.x
      const result = await state.run(id, source)
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, expected, source)
    }
  }
})

test('failed protected TDZ writes publish no ambient value and permit a later declaration', async t => {
  const state = fixture({ bindingUpdates: 'protected' })
  t.after(() => state.dispose())
  const failed = await state.run('protected-tdz-recovery', 'x=1;let x=2')
  assert.equal(failed.error?.kind, 'exception')
  assert.match(failed.error.message, /ReferenceError/)
  const continued = await state.run('protected-tdz-recovery', 'let x=3;return [x,globalThis.x===undefined]')
  assert.equal(continued.error, undefined, continued.error?.message)
  assert.deepEqual(continued.value, [3, true])
})
