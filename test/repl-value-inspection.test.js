import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { SessionRuntime } from '../internal/session-runtime.js'
import { unavailableReplMemorySnapshot, createReplMemorySnapshot } from '../internal/repl-memory-projection.js'
import {
  activeTimers,
  durableHistorySnapshot,
  hasSessionKernel,
  holdKernelQueue,
  interceptWorkerMessages,
  interceptWorkerPosts,
  setSessionSurface,
  terminateWorker,
  workerObservationOf,
  workerOf,
} from './runtime-observation.js'

async function fixture(t) {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const first = await runtime.runTentative('preview', {
    program: 'let answer = await Promise.resolve(42); return answer', bindings: [],
  })
  assert.equal(first.result.value, 42)
  runtime.finalize(first.settlement, true)
  return { runtime, memory: first.settlement.replMemory, first }
}

test('opening after execution observes the settled worker without execution or journal changes', async t => {
  const { runtime, memory, first } = await fixture(t)
  const worker = workerOf(runtime, 'preview')
  const history = durableHistorySnapshot(runtime, 'preview')
  const journal = JSON.stringify(first.settlement.journal)
  const messages = []
  interceptWorkerPosts(runtime, 'preview', message => { messages.push(message.type); return message })
  assert.equal(memory.observation, undefined)
  const observed = await runtime.observe('preview', memory, new AbortController().signal)
  assert.equal(observed.observation.entries[0].text, '42')
  assert.deepEqual(messages, ['prepare', 'observe'])
  assert.equal(workerOf(runtime, 'preview'), worker)
  assert.equal(durableHistorySnapshot(runtime, 'preview'), history)
  assert.equal(JSON.stringify(first.settlement.journal), journal)
  assert.equal(memory.observation, undefined)
  assert.equal((await runtime.run('preview', { program: 'answer++; return answer', bindings: [] })).value, 43)
  assert.equal((await runtime.observe('preview', observed)).observation.entries[0].text, '43')
})

test('inspection rejects unavailable, uncommitted and mismatched state without creating workers', async t => {
  const { runtime, memory } = await fixture(t)
  assert.equal(await runtime.observe('missing', memory), undefined)
  assert.equal(hasSessionKernel(runtime, 'missing'), false)
  await assert.rejects(runtime.observe('preview', {}), /snapshot/)
  assert.equal(await runtime.observe('preview', unavailableReplMemorySnapshot()), undefined)
  assert.equal(await runtime.observe('preview', createReplMemorySnapshot([])), undefined)
  assert.equal(await runtime.observe('preview', { ...memory, entries: [{ ...memory.entries[0], name: 'different' }] }), undefined)
  assert.equal(await runtime.observe('preview', memory, AbortSignal.abort()), undefined)
  const second = await runtime.runTentative('preview', { program: 'answer++; return answer', bindings: [] })
  assert.equal(await runtime.observe('preview', memory), undefined)
  runtime.finalize(second.settlement, true)
  assert.equal((await runtime.observe('preview', memory)).observation.entries[0].text, '43')
  setSessionSurface(runtime, 'preview', { replaceGeneration: 1 })
  setSessionSurface(runtime, 'preview', { replaceGeneration: 2 }, false)
  assert.equal(await runtime.observe('preview', memory), undefined)
  setSessionSurface(runtime, 'preview', {
    get replaceGeneration() { throw new Error('surface unavailable') },
  }, false)
  assert.equal(await runtime.observe('preview', memory), undefined)
  runtime.reconfigure({ replViewEnabled: false })
  assert.equal(await runtime.observe('preview', memory), undefined)
  await runtime.dispose()
  assert.equal(await runtime.observe('preview', memory), undefined)
})

test('cancelled, timed-out and failed inspections preserve subsequent execution', async t => {
  const { runtime, memory } = await fixture(t)
  const worker = workerOf(runtime, 'preview')
  const frames = interceptWorkerMessages(runtime, 'preview', (message, deliver) => deliver(message))
  for (const mode of ['abort', 'timeout', 'prepare-error', 'observe-error', 'stale', 'duplicate-ready']) {
    const controller = new AbortController()
    let ready
    const link = interceptWorkerPosts(runtime, 'preview', message => {
      if (message.type === 'prepare' && ['abort', 'timeout', 'stale', 'duplicate-ready'].includes(mode)) { ready = message; return }
      if (message.type === 'prepare' && mode === 'prepare-error') throw new Error('prepare failed')
      if (message.type === 'observe' && mode === 'observe-error') throw new Error('observe failed')
      return message
    })
    const pending = runtime.observe('preview', memory, controller.signal)
    await nextTurn()
    if (mode === 'abort') controller.abort()
    if (mode === 'timeout') assert.equal(await runtime.observe('preview', memory), undefined)
    if (mode === 'stale') {
      setSessionSurface(runtime, 'preview', { replaceGeneration: 9 }, false)
      frames.deliver({ type: 'ready', id: ready.id })
    }
    if (mode === 'duplicate-ready') {
      frames.deliver({ type: 'ready', id: ready.id })
      frames.deliver({ type: 'ready', id: ready.id })
    }
    const observed = await pending
    if (mode === 'duplicate-ready') assert.equal(observed.observation.entries[0].text, '42')
    else assert.equal(observed, undefined, mode)
    setSessionSurface(runtime, 'preview', undefined)
    if (ready !== undefined) frames.deliver({ type: 'ready', id: ready.id })
    link.restore()
    assert.equal((await runtime.run('preview', { program: 'return answer', bindings: [] })).value, 42, mode)
    assert.equal(workerOf(runtime, 'preview'), worker)
  }
})

test('inspection waiting is bounded even before the queue is available', async t => {
  const { runtime, memory } = await fixture(t)
  const queue = holdKernelQueue(runtime, 'preview')
  const controller = new AbortController()
  const pending = runtime.observe('preview', memory, controller.signal)
  controller.abort()
  assert.equal(await pending, undefined)
  queue.release()
  await queue.tail
  assert.equal((await runtime.run('preview', { program: 'return answer', bindings: [] })).value, 42)
})

test('an unstarted inspection cannot exempt background blocking from either execution budget', async t => {
  for (const [computeMs, maxWallMs, expected] of [
    [100, 2000, /compute budget exhausted/],
    [2000, 100, /wall-clock ceiling/],
  ]) {
    await t.test(expected.source, async t => {
      const { runtime, memory } = await fixture(t)
      const worker = workerOf(runtime, 'preview')
      await runtime.run('preview', {
        program: 'setTimeout(() => { while (true) {} }, 100)', bindings: [],
      })
      let request
      const link = interceptWorkerPosts(runtime, 'preview', message => {
        // Hold observe after the real ready reply until the old callback blocks.
        if (message.type === 'observe') { request = message; return }
        return message
      })
      assert.equal(await runtime.observe('preview', memory), undefined)
      assert.equal(request.type, 'observe')
      link.post(request)
      link.restore()
      runtime.reconfigure({ computeMs, maxWallMs })
      const next = await runtime.runTentative('preview', {
        program: 'return answer', bindings: [], signal: AbortSignal.timeout(3000),
      })
      assert.equal(next.result.error.kind, 'timeout')
      assert.match(next.result.error.message, expected)
      assert.equal(next.settlement.journal.status, 'discarded')
      assert.equal(workerOf(runtime, 'preview'), undefined)
      runtime.finalize(next.settlement, true)
      assert.equal((await runtime.run('preview', { program: 'return 3', bindings: [] })).value, 3)
      assert.notEqual(workerOf(runtime, 'preview'), worker)
    })
  }
})

test('confirmed on-demand observation defers budgets beyond the presentation deadline', async t => {
  const { runtime, memory } = await fixture(t)
  const worker = workerOf(runtime, 'preview')
  let observation
  let acknowledged = false
  const frames = interceptWorkerMessages(runtime, 'preview', (message, deliver) => {
    if (message.type === 'observation') { observation = message; return }
    if (message.type === 'observation-started') acknowledged = true
    deliver(message)
  })
  assert.equal(await runtime.observe('preview', memory), undefined)
  assert.equal(acknowledged, true)
  assert.equal(observation.observation.entries[0].text, '42')
  runtime.reconfigure({ computeMs: 100, maxWallMs: 100 })
  const posted = Promise.withResolvers()
  const link = interceptWorkerPosts(runtime, 'preview', message => { posted.resolve(message); return undefined })
  const next = runtime.run('preview', {
    program: 'return answer', bindings: [], signal: AbortSignal.timeout(3000),
  })
  const prepare = await posted.promise
  await delay(150)
  assert.equal(activeTimers(runtime, 'preview').compute, undefined)
  assert.equal(activeTimers(runtime, 'preview').wall, undefined)
  link.restore()
  link.post(prepare)
  assert.equal((await next).value, 42)
  frames.deliver({ type: 'observation-started', id: observation.id })
  frames.deliver(observation)
  assert.equal(workerObservationOf(runtime, 'preview'), undefined)
  assert.equal(workerOf(runtime, 'preview'), worker)
})

test('late observation acknowledgements never suspend or reset running budgets', async t => {
  const { runtime, memory } = await fixture(t)
  const held = []
  const frames = interceptWorkerMessages(runtime, 'preview', (message, deliver) => {
    if (['observation-started', 'observation'].includes(message.type)) { held.push(message); return }
    deliver(message)
  })
  assert.equal(await runtime.observe('preview', memory), undefined)
  assert.deepEqual(held.map(message => message.type), ['observation-started', 'observation'])
  const posted = Promise.withResolvers()
  const link = interceptWorkerPosts(runtime, 'preview', message => { posted.resolve(message); return undefined })
  const next = runtime.run('preview', { program: 'return answer', bindings: [] })
  const prepare = await posted.promise
  const { compute, wall } = activeTimers(runtime, 'preview')
  assert.notEqual(compute, undefined)
  assert.notEqual(wall, undefined)
  for (const message of [
    { type: 'observation-started' }, { ...held[0], id: -1 },
    held[0], held[0], held[1], held[0], held[1],
  ]) {
    frames.deliver(message)
    assert.equal(activeTimers(runtime, 'preview').compute, compute)
    assert.equal(activeTimers(runtime, 'preview').wall, wall)
  }
  link.restore()
  link.post(prepare)
  assert.equal((await next).value, 42)
  assert.equal(workerObservationOf(runtime, 'preview'), undefined)
})

test('late observations and worker disposal cannot resurrect a preview', async t => {
  const { runtime, memory } = await fixture(t)
  let observe
  const link = interceptWorkerPosts(runtime, 'preview', message => {
    if (message.type === 'observe') { observe = message; return }
    return message
  })
  const pending = runtime.observe('preview', memory)
  while (observe === undefined) await nextTurn()
  assert.equal(await pending, undefined)
  link.restore()
  assert.equal((await runtime.run('preview', { program: 'return answer', bindings: [] })).value, 42)
  const frames = interceptWorkerMessages(runtime, 'preview', (message, deliver) => deliver(message))
  frames.deliver({ type: 'observation', id: observe.id, observation: { at: 1, entries: [] } })
  interceptWorkerPosts(runtime, 'preview', () => undefined)
  const disposed = runtime.observe('preview', memory)
  await nextTurn()
  await runtime.disposeSession('preview')
  assert.equal(await disposed, undefined)
  assert.equal(await runtime.observe('preview', memory), undefined)
})

test('an observation rejects worker failure and malformed replies without affecting an existing result', async t => {
  const { runtime, memory, first } = await fixture(t)
  let request
  const link = interceptWorkerPosts(runtime, 'preview', message => {
    if (message.type === 'observe') { request = message; return }
    return message
  })
  const pending = runtime.observe('preview', memory)
  while (request === undefined) await nextTurn()
  const frames = interceptWorkerMessages(runtime, 'preview', (message, deliver) => deliver(message))
  frames.deliver({ type: 'observation' })
  frames.deliver({ type: 'observation', id: request.id, observation: { invalid: true } })
  assert.equal((await pending).observation, undefined)
  request = undefined
  const failed = runtime.observe('preview', memory)
  while (request === undefined) await nextTurn()
  await terminateWorker(runtime, 'preview')
  assert.equal(await failed, undefined)
  assert.equal(first.result.value, 42)
  link.restore()
  assert.equal(await runtime.observe('preview', memory), undefined)
})
