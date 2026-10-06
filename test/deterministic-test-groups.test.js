import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { runDeterministicTestGroups } from '../scripts/deterministic-test-groups.mjs'

function processes() {
  const children = []
  return {
    children,
    spawnProcess(executable, args) {
      const child = new EventEmitter()
      child.args = args
      children.push(child)
      return child
    },
  }
}

test('large machines overlap complete groups and wait for both results', async () => {
  const state = processes()
  let done = false
  const running = runDeterministicTestGroups({ ...state, parallelism: 24 }).then(() => { done = true })
  assert.equal(state.children.length, 2)
  assert.ok(state.children[0].args.includes('test:client:visual'))
  assert.ok(state.children[1].args.includes('test:backend'))
  state.children[0].emit('close', 0, null)
  await setImmediate()
  assert.equal(done, false)
  state.children[1].emit('close', 0, null)
  await running
})

test('small CI runners preserve serial phases and the focused CI runtime inventory', async () => {
  const state = processes()
  const running = runDeterministicTestGroups({ ...state, ci: true, parallelism: 4 })
  assert.equal(state.children.length, 1)
  state.children[0].emit('close', 0, null)
  await setImmediate()
  assert.equal(state.children.length, 2)
  assert.ok(state.children[1].args.includes('test:ci:runtime'))
  state.children[1].emit('close', 0, null)
  await running
})

test('parallel group failures retain codes and signals while draining the other group', async () => {
  const state = processes()
  const running = runDeterministicTestGroups({ ...state, parallelism: 24 })
  state.children[0].emit('close', 3, null)
  state.children[1].emit('close', null, 'SIGTERM')
  await assert.rejects(running, error => error instanceof AggregateError
    && error.errors.some(item => /exited 3/.test(item.message))
    && error.errors.some(item => /SIGTERM/.test(item.message)))
})
