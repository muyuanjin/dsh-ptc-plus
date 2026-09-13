import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'

function legacySession(t) {
  const runtime = new SessionRuntime({ legacyBindingSettings: true, looseTopLevelRedeclarations: false })
  t.after(() => runtime.dispose())
  return {
    run: program => runtime.run('legacy-patterns', { program, bindings: [] }),
    migrate: () => runtime.reconfigure({ bindingUpdates: 'stateful', legacyBindingSettings: false }),
  }
}

test('scalar, array and object declarations retain legacy writable storage and captured setters', async t => {
  for (const declaration of ['let value=2', 'let [value]=[2]', 'const {value}={value:2}']) {
    await t.test(declaration, async t => {
      const state = legacySession(t)
      const setup = await state.run(`
let value=1
const readOld=()=>value
const writeOld=next=>value=next
const retained={read:readOld,write:writeOld}
return readOld()
`)
      assert.equal(setup.error, undefined, setup.error?.message)
      assert.equal(setup.value, 1)
      state.migrate()
      const updated = await state.run(`${declaration}; return [value,readOld(),retained.read===readOld,retained.write===writeOld]`)
      assert.equal(updated.error, undefined, updated.error?.message)
      assert.deepEqual(updated.value, [2,2,true,true])
      const oldWrite = await state.run('writeOld(3); return [value,readOld()]')
      assert.equal(oldWrite.error, undefined, oldWrite.error?.message)
      assert.deepEqual(oldWrite.value, [3,3])
      const newWrite = await state.run('value=4; return [value,retained.read()]')
      assert.equal(newWrite.error, undefined, newWrite.error?.message)
      assert.deepEqual(newWrite.value, [4,4])
      const repeat = await state.run('let [value]=[5]; return [value,retained.read()]')
      assert.equal(repeat.error, undefined, repeat.error?.message)
      assert.deepEqual(repeat.value, [5,5])
    })
  }
})

test('mixed migration patterns retain old readonly captures and rebase successful candidate closures', async t => {
  const state = legacySession(t)
  const setup = await state.run(`
let writable={id:1}
const fixed={id:10}
const readOld=()=>[writable.id,fixed.id]
const writeOld=next=>writable=next
const oldFixed=fixed
const effects=[]
`)
  assert.equal(setup.error, undefined, setup.error?.message)
  state.migrate()
  const updated = await state.run(`
const {
  writable,
  fixed,
  fresh=3,
  readCandidate=()=>[writable.id,fixed.id,fresh],
  writeCandidate=next=>writable=next
}={
  get writable(){effects.push(readOld());return {id:2}},
  get fixed(){effects.push(readOld());return {id:20}}
}
return [readOld(),readCandidate(),effects,fixed===oldFixed]
`)
  assert.equal(updated.error, undefined, updated.error?.message)
  assert.deepEqual(updated.value, [[2,10],[2,20,3],[[1,10],[1,10]],false])
  const oldWrite = await state.run('writeOld({id:4}); fixed={id:30}; fresh=5; return [readOld(),readCandidate(),oldFixed.id]')
  assert.equal(oldWrite.error, undefined, oldWrite.error?.message)
  assert.deepEqual(oldWrite.value, [[4,10],[4,30,5],10])
  const candidateWrite = await state.run('writeCandidate({id:6}); return [readOld(),readCandidate(),writable.id]')
  assert.equal(candidateWrite.error, undefined, candidateWrite.error?.message)
  assert.deepEqual(candidateWrite.value, [[6,10],[6,30,5],6])
})

test('failed migration patterns retain previous bindings and keep escaped candidate closures private', async t => {
  const state = legacySession(t)
  const setup = await state.run(`
let x=1,y=2
const readOld=()=>[x,y]
const writeOld=value=>x=value
const escaped=[]
const effects=[]
const input={
  [Symbol.iterator](){
    let index=0
    return {
      next(){effects.push('next');return {done:false,value:index++===0?9:undefined}},
      return(){effects.push('close');return {done:true}}
    }
  }
}
`)
  assert.equal(setup.error, undefined, setup.error?.message)
  state.migrate()
  const failed = await state.run(`
let [x,capture=(escaped.push({read:()=>x,write:value=>x=value}),0),
  y=(()=>{effects.push(readOld());throw new Error('pattern marker')})(),absent]=input
`)
  assert.equal(failed.error?.kind, 'exception')
  assert.match(failed.error.message, /pattern marker/)
  const retained = await state.run('return [readOld(),x,y,typeof capture,typeof absent,escaped[0].read(),effects]')
  assert.equal(retained.error, undefined, retained.error?.message)
  assert.deepEqual(retained.value, [[1,2],1,2,'undefined','undefined',9,['next','next','next',[1,2],'close']])
  const oldWrite = await state.run('writeOld(3); escaped[0].write(8); return [readOld(),x,escaped[0].read()]')
  assert.equal(oldWrite.error, undefined, oldWrite.error?.message)
  assert.deepEqual(oldWrite.value, [[3,2],3,8])
  const replacement = await state.run('let [x,y]=[4,5]; return [readOld(),x,y,escaped[0].read()]')
  assert.equal(replacement.error, undefined, replacement.error?.message)
  assert.deepEqual(replacement.value, [[4,5],4,5,8])
})

test('pattern publication observers see the complete migrated state and rebased candidates', () => {
  const legacy = { writable: 1, fixed: 10 }
  const observations = []
  let candidate
  const runtime = createStatefulRootRuntime({
    readAmbient: name => legacy[name],
    writeAmbient(name, value) { legacy[name] = value },
    publish(name, get) {
      observations.push(['publish',name,get(),legacy.writable,legacy.fixed,
        runtime.read('fresh'),candidate.values.writable,candidate.values.fixed])
    },
    changed(name, source) { observations.push(['changed',name,source]) },
  })
  const current = runtime.begin({ declared: ['writable','fixed','fresh'],
    legacyWritable: ['writable'], legacyLexicals: ['fixed'],
    committed: target => observations.push(['commit',target]) })
  candidate = current.candidate(['writable','fixed','fresh'])
  candidate.values.writable = 2
  candidate.values.fixed = 20
  candidate.values.fresh = 3
  candidate.commit('pattern')
  assert.deepEqual(observations, [
    ['publish','writable',2,2,10,3,2,20], ['changed','writable','local'],
    ['publish','fixed',20,2,10,3,2,20], ['changed','fixed','local'],
    ['publish','fresh',3,2,10,3,2,20], ['changed','fresh','local'],
    ['commit','pattern'],
  ])
  assert.equal(runtime.localValue('writable'), undefined)
  assert.deepEqual(runtime.localValue('fixed'), { value: 20 })
})
