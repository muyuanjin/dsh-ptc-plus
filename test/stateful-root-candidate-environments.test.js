import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './plugin-fixture.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'

test('candidate references share initialization, protection and atomic publication', () => {
  const changes = []
  const roots = createStatefulRootRuntime({ readAmbient: name => { throw new ReferenceError(name) },
    typeofAmbient: () => 'undefined', hasAmbient: () => false,
    changed: name => changes.push([name, roots.read('x'), roots.read('y')]) })
  const cell = roots.begin({ declared: ['x','y','fixed'], readOnly: ['fixed'],
    languageSemantics: 'protected-v1', declarationKinds: [['pattern','let'],['constant','const']], committed() {} })
  const candidate = cell.candidate(['x','y'])
  const reference = candidate.reference('x', true, 'source-write')
  assert.throws(() => reference.value, ReferenceError)
  assert.throws(() => { reference.value = 9 }, ReferenceError)
  candidate.values.x = 1
  candidate.values.y = 2
  reference.value = 3
  assert.equal(candidate.values.x, 3)
  assert.equal(reference.delete(), false)
  assert.deepEqual(changes, [])
  candidate.commit('pattern')
  assert.deepEqual(changes, [['x',3,2],['y',3,2]])
  reference.value = 4
  assert.equal(roots.read('x'), 4)
  assert.equal(reference.value, 4)
  assert.equal(reference.delete(), false)
  const fixed = cell.candidate(['fixed'])
  const readOnly = fixed.reference('fixed')
  fixed.values.fixed = 7
  assert.throws(() => { readOnly.value = 8 }, TypeError)
  fixed.commit('constant')
  assert.throws(() => { readOnly.value = 8 }, TypeError)
  assert.equal(readOnly.value, 7)
})

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`root pattern candidates share native reads and dynamic writes (${bindingUpdates})`, async t => {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const cases = [
      'var [x=x]=[];return typeof x',
      'const [x=1,y=eval("x")]=[];return [x,y]',
      'let [x=1,y=eval("x=3")]=[];return [x,y]',
      'let [x=1,y=(x=3)]=[];return [x,y]',
      'let {x=1,y=eval("x=3")}={};return [x,y]',
      'let [x=1,{y=eval("x")}={}]=[];return [x,y]',
      'let [x=1,y=eval("typeof x"),z=eval("delete x")]=[];return [x,y,z]',
      'let [x=1,f=eval("()=>x")]=[];x=2;return f()',
      'let [x=1,f=eval("value=>x=value")]=[];f(3);return [x,f(4)]',
      'let [x=1,f=eval("()=>delete x")]=[];return [f(),x]',
      'const [x=1,y=eval("(()=>{let x=4;return x})()")]=[];return [x,y]',
      'let error;try{const [x=x]=[]}catch(caught){error=caught.name}return error',
      'var [x=1,y=eval("var x=3;x")]=[];return [x,y]',
    ]
    for (const [index, source] of cases.entries()) {
      const result = await state.run(`candidate-${index}`, source)
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, Function(source)(), source)
    }
  })

  test(`failed root candidates retain escaped values without publishing (${bindingUpdates})`, async t => {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    await state.run('failed-candidate', 'let escaped,write')
    const source = `let [x=1,y=(escaped=eval('()=>x'),write=eval('value=>x=value'),(()=>{throw Error('stop')})())]=[]`
    const result = await state.run('failed-candidate', source)
    assert.ok(result.error)
    assert.deepEqual((await state.run('failed-candidate', 'return [escaped(),write(3),escaped(),typeof x]')).value, [1,3,3,'undefined'])
    const next = await state.run('failed-candidate', 'return [escaped(),write(4),escaped(),typeof x]')
    assert.equal(next.error, undefined, next.error?.message)
    assert.deepEqual(next.value, [3,4,4,'undefined'])
  })
}

test('stateful root candidates reuse existing values and follow publication across cells', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  await state.run('existing-candidate', 'const x=1;const old=()=>x')
  const result = await state.run('existing-candidate', `const [x=x+1,y=eval('x'),read=eval('()=>x')]=[];return [x,y,old(),read()]`)
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [2,2,2,2])
  assert.deepEqual((await state.run('existing-candidate', 'x=5;return [old(),read()]')).value, [5,5])
  const overwritten = await state.run('existing-candidate', 'const [x=undefined,y=x]=[];return [x===undefined,y===undefined]')
  assert.equal(overwritten.error, undefined, overwritten.error?.message)
  assert.deepEqual(overwritten.value, [true,true])
  const imported = await state.run('import-candidate', `import {sep as x} from 'node:path';const [x=x+'!']=[];return x`)
  assert.equal(imported.error, undefined, imported.error?.message)
  assert.equal(imported.value, (await import('node:path')).sep+'!')
})

test('protected candidate writes retain const and TDZ rules for static and dynamic references', async t => {
  const state = fixture({ bindingUpdates: 'protected' })
  t.after(() => state.dispose())
  const sources = [
    'const [x=1,y=(x=3)]=[]',
    'const [x=1,y=eval("x=3")]=[]',
    'let [x=(y=3),y=1]=[]',
    'let [x=eval("y=3"),y=1]=[]',
  ]
  for (const [index, source] of sources.entries()) {
    const expected = Function(`try{${source}}catch(caught){return caught.name}`)()
    const result = await state.run(`protected-candidate-${index}`, source)
    assert.ok(result.error)
    assert.match(result.error.message, new RegExp(expected))
  }
})
