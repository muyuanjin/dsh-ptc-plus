import assert from 'node:assert/strict'
import test from 'node:test'
import { createReplObservationInterest, REPL_OBSERVATION_RPC_CONTRACT } from '../internal/repl-observation-interest.js'
import { SessionRuntime } from '../internal/session-runtime.js'

function fixture(scoped = true, observe) {
  let handler
  let registered = false
  let connect
  const effects = []
  const effect = register => { const release = register(); effects.push(release); return release }
  const ctx = {
    effect,
    inject(names, callback) {
      assert.deepEqual(names, ['ptcPlusRpc'])
      connect = callback
      callback({ ...(scoped ? { effect } : {}), ptcPlusRpc: { register(channel, next) {
        assert.equal(channel, REPL_OBSERVATION_RPC_CONTRACT)
        registered = true
        handler = next
        return () => { registered = false }
      } } })
      return scoped ? { dispose: async () => { for (const release of effects) await release() } }
        : async () => { for (const release of effects) await release() }
    },
  }
  const owner = createReplObservationInterest(ctx, true, observe)
  return { owner, effects, call: (...args) => handler(...args), get registered() { return registered },
    connect: scope => connect(scope) }
}

test('visible observation interest is bounded, cancellable and scoped to its public connection', async () => {
  for (const scoped of [true, false]) {
    const target = fixture(scoped)
    assert.equal(target.owner.has('session'), false)
    const controller = new AbortController()
    const pending = target.call('watch', { sessionId: 'session' }, controller.signal)
    assert.equal(target.owner.has('session'), true)
    assert.equal(target.owner.has('other'), false)
    controller.abort()
    assert.deepEqual(await pending, { ok: true, value: null })
    assert.equal(target.owner.has('session'), false)
    await target.call('watch', { sessionId: 'session' }, controller.signal)
    assert.equal(target.owner.has('session'), false)
    for (const [endpoint, payload, signal] of [
      ['missing', {}, controller.signal], ['watch', null, controller.signal],
      ['watch', { sessionId: '' }, controller.signal], ['watch', { sessionId: 'x'.repeat(257) }, controller.signal],
      ['watch', { sessionId: 'session' }, undefined],
    ]) assert.equal((await target.call(endpoint, payload, signal)).ok, false)
    const watchers = Array.from({ length: 64 }, (_, index) => target.call('watch', { sessionId: String(index) }, new AbortController().signal))
    assert.equal((await target.call('watch', { sessionId: 'overflow' }, new AbortController().signal)).ok, false)
    target.owner.reconfigure(false)
    await Promise.all(watchers)
    assert.equal(target.owner.has('0'), false)
    assert.equal((await target.call('watch', { sessionId: 'disabled' }, new AbortController().signal)).ok, false)
    target.owner.reconfigure(true)
    const disconnected = target.call('watch', { sessionId: 'session' }, new AbortController().signal)
    await target.effects[0]()
    await disconnected
    assert.equal(target.registered, false)
    assert.equal(target.owner.has('session'), false)
    target.connect({ ptcPlusRpc: {} })
    await target.owner.dispose()
    await target.owner.dispose()
  }
  await createReplObservationInterest({}, false).dispose()
})

test('one-shot observation validates requests and cancels reads on owner disablement', async () => {
  let release
  let captured
  const target = fixture(true, async (sessionId, memory, signal) => {
    captured = { sessionId, memory, signal }
    if (memory === 'invalid') throw new Error('bad snapshot')
    if (memory === 'value') return { observation: 'sample' }
    return new Promise(resolve => {
      release = resolve
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  const call = memory => target.call('observe', { sessionId: 'preview', memory }, new AbortController().signal)
  assert.deepEqual(await call('value'), { ok: true, value: { observation: 'sample' } })
  assert.equal((await call('invalid')).ok, false)
  const pending = call('pending')
  assert.equal(captured.sessionId, 'preview')
  assert.equal(captured.memory, 'pending')
  target.owner.reconfigure(false)
  assert.equal(captured.signal.aborted, true)
  assert.deepEqual(await pending, { ok: true, value: null })
  target.owner.reconfigure(true)
  const bounded = Array.from({ length: 64 }, () => call('pending'))
  assert.deepEqual(await call('overflow'), { ok: true, value: null })
  release()
  await target.owner.dispose()
  await Promise.all(bounded)
  const absent = fixture()
  assert.deepEqual(await absent.call('observe', { sessionId: 'missing' }, new AbortController().signal), { ok: true, value: null })
  await absent.owner.dispose()
})

test('observation interest changes only future live-cell previews and leaves execution evidence untouched', async t => {
  const target = fixture()
  const observed = new SessionRuntime({}, { observeSession: session => target.owner.has(session) })
  const unobserved = new SessionRuntime()
  t.after(async () => { await observed.dispose(); await unobserved.dispose(); await target.owner.dispose() })
  const run = async (runtime, program) => {
    const result = await runtime.runTentative('session', { program, bindings: [] })
    runtime.finalize(result.settlement, true)
    return result
  }
  const first = await run(observed, 'let value = 42; return value')
  await run(unobserved, 'let value = 42; return value')
  assert.equal(first.settlement.replMemory.observation, undefined)
  const watch = target.call('watch', { sessionId: 'session' }, new AbortController().signal)
  assert.equal(first.settlement.replMemory.observation, undefined)
  const second = await run(observed, 'value += 1; return value')
  const control = await run(unobserved, 'value += 1; return value')
  assert.equal(second.settlement.replMemory.observation.entries[0].text, '43')
  assert.deepEqual(second.result, control.result)
  assert.deepEqual(second.settlement.journal, control.settlement.journal)
  observed.reconfigure({ replViewEnabled: false })
  assert.equal((await run(observed, 'return value')).settlement.replMemory.observation, undefined)
  observed.reconfigure({ replViewEnabled: true })
  target.owner.reconfigure(false)
  await watch
  assert.equal((await run(observed, 'return value')).settlement.replMemory.observation, undefined)
})
