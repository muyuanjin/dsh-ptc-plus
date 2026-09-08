import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { SessionRuntime } from '../internal/session-runtime.js'
import { unavailableReplMemorySnapshot, createReplMemorySnapshot } from '../internal/repl-memory-projection.js'

async function fixture(t) {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const first = await runtime.runTentative('preview', {
    program: 'let answer = await Promise.resolve(42); return answer', bindings: [],
  })
  assert.equal(first.result.value, 42)
  runtime.finalize(first.settlement, true)
  return { runtime, kernel: runtime.kernels.get('preview'), memory: first.settlement.replMemory, first }
}

test('opening after execution observes the settled worker without execution or journal changes', async t => {
  const { runtime, kernel, memory, first } = await fixture(t)
  const worker = kernel.client.worker
  const history = JSON.stringify(kernel.history)
  const journal = JSON.stringify(first.settlement.journal)
  const post = kernel.client.post.bind(kernel.client)
  const messages = []
  kernel.client.post = message => { messages.push(message.type); post(message) }
  assert.equal(memory.observation, undefined)
  const observed = await runtime.observe('preview', memory, new AbortController().signal)
  assert.equal(observed.observation.entries[0].text, '42')
  assert.deepEqual(messages, ['prepare', 'observe'])
  assert.equal(kernel.client.worker, worker)
  assert.equal(JSON.stringify(kernel.history), history)
  assert.equal(JSON.stringify(first.settlement.journal), journal)
  assert.equal(memory.observation, undefined)
  assert.equal((await runtime.run('preview', { program: 'answer++; return answer', bindings: [] })).value, 43)
  assert.equal((await runtime.observe('preview', observed)).observation.entries[0].text, '43')
})

test('inspection rejects unavailable, uncommitted and mismatched state without creating workers', async t => {
  const { runtime, kernel, memory } = await fixture(t)
  assert.equal(await runtime.observe('missing', memory), undefined)
  assert.equal(runtime.kernels.has('missing'), false)
  await assert.rejects(runtime.observe('preview', {}), /snapshot/)
  assert.equal(await runtime.observe('preview', unavailableReplMemorySnapshot()), undefined)
  assert.equal(await runtime.observe('preview', createReplMemorySnapshot([])), undefined)
  assert.equal(await runtime.observe('preview', { ...memory, entries: [{ ...memory.entries[0], name: 'different' }] }), undefined)
  assert.equal(await runtime.observe('preview', memory, AbortSignal.abort()), undefined)
  const second = await runtime.runTentative('preview', { program: 'answer++; return answer', bindings: [] })
  assert.equal(await runtime.observe('preview', memory), undefined)
  runtime.finalize(second.settlement, true)
  assert.equal((await runtime.observe('preview', memory)).observation.entries[0].text, '43')
  kernel.session = { surface: { replaceGeneration: 1 } }
  kernel.surfaceGeneration = 1
  kernel.session.surface.replaceGeneration++
  assert.equal(await runtime.observe('preview', memory), undefined)
  Object.defineProperty(kernel.session, 'surface', { get() { throw new Error('surface unavailable') } })
  assert.equal(await runtime.observe('preview', memory), undefined)
  runtime.reconfigure({ replViewEnabled: false })
  assert.equal(await runtime.observe('preview', memory), undefined)
  await runtime.dispose()
  assert.equal(await runtime.observe('preview', memory), undefined)
})

test('cancelled, timed-out and failed inspections preserve subsequent execution', async t => {
  const { runtime, kernel, memory } = await fixture(t)
  const worker = kernel.client.worker
  const post = kernel.client.post.bind(kernel.client)
  for (const mode of ['abort', 'timeout', 'prepare-error', 'observe-error', 'stale', 'duplicate-ready']) {
    const controller = new AbortController()
    let ready
    kernel.client.post = message => {
      if (message.type === 'prepare' && ['abort', 'timeout', 'stale', 'duplicate-ready'].includes(mode)) { ready = message; return }
      if (message.type === 'prepare' && mode === 'prepare-error') throw new Error('prepare failed')
      if (message.type === 'observe' && mode === 'observe-error') throw new Error('observe failed')
      post(message)
    }
    const pending = runtime.observe('preview', memory, controller.signal)
    await nextTurn()
    if (mode === 'abort') controller.abort()
    if (mode === 'timeout') assert.equal(await runtime.observe('preview', memory), undefined)
    if (mode === 'stale') {
      kernel.session = { surface: { replaceGeneration: 9 } }
      kernel.cellExecutor.onMessage({ type: 'ready', id: ready.id })
    }
    if (mode === 'duplicate-ready') {
      kernel.cellExecutor.onMessage({ type: 'ready', id: ready.id })
      kernel.cellExecutor.onMessage({ type: 'ready', id: ready.id })
    }
    const observed = await pending
    if (mode === 'duplicate-ready') assert.equal(observed.observation.entries[0].text, '42')
    else assert.equal(observed, undefined, mode)
    kernel.session = undefined
    if (ready !== undefined) kernel.cellExecutor.onMessage({ type: 'ready', id: ready.id })
    kernel.client.post = post
    assert.equal((await runtime.run('preview', { program: 'return answer', bindings: [] })).value, 42, mode)
    assert.equal(kernel.client.worker, worker)
  }
})

test('inspection waiting is bounded even before the queue is available', async t => {
  const { runtime, kernel, memory } = await fixture(t)
  let release
  kernel.tail = new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const pending = runtime.observe('preview', memory, controller.signal)
  controller.abort()
  assert.equal(await pending, undefined)
  release()
  await kernel.tail
  assert.equal((await runtime.run('preview', { program: 'return answer', bindings: [] })).value, 42)
})

test('an unstarted inspection cannot exempt background blocking from either execution budget', async t => {
  for (const [computeMs, maxWallMs, expected] of [
    [100, 2000, /compute budget exhausted/],
    [2000, 100, /wall-clock ceiling/],
  ]) {
    await t.test(expected.source, async t => {
      const { runtime, kernel, memory } = await fixture(t)
      const worker = kernel.client.worker
      await runtime.run('preview', {
        program: 'setTimeout(() => { while (true) {} }, 100)', bindings: [],
      })
      const post = kernel.client.post.bind(kernel.client)
      let request
      kernel.client.post = message => {
        // Hold observe after the real ready reply until the old callback blocks.
        if (message.type === 'observe') { request = message; return }
        post(message)
      }
      assert.equal(await runtime.observe('preview', memory), undefined)
      assert.equal(request.type, 'observe')
      post(request)
      kernel.client.post = post
      runtime.reconfigure({ computeMs, maxWallMs })
      const next = await runtime.runTentative('preview', {
        program: 'return answer', bindings: [], signal: AbortSignal.timeout(3000),
      })
      assert.equal(next.result.error.kind, 'timeout')
      assert.match(next.result.error.message, expected)
      assert.equal(next.settlement.journal.status, 'discarded')
      assert.equal(kernel.client.worker, undefined)
      runtime.finalize(next.settlement, true)
      assert.equal((await runtime.run('preview', { program: 'return 3', bindings: [] })).value, 3)
      assert.notEqual(kernel.client.worker, worker)
    })
  }
})

test('confirmed on-demand observation defers budgets beyond the presentation deadline', async t => {
  const { runtime, kernel, memory } = await fixture(t)
  const worker = kernel.client.worker
  const onMessage = kernel.cellExecutor.onMessage.bind(kernel.cellExecutor)
  let observation
  let acknowledged = false
  kernel.cellExecutor.onMessage = message => {
    if (message.type === 'observation') { observation = message; return }
    if (message.type === 'observation-started') acknowledged = true
    onMessage(message)
  }
  assert.equal(await runtime.observe('preview', memory), undefined)
  assert.equal(acknowledged, true)
  assert.equal(observation.observation.entries[0].text, '42')
  runtime.reconfigure({ computeMs: 100, maxWallMs: 100 })
  const post = kernel.client.post.bind(kernel.client)
  const posted = Promise.withResolvers()
  kernel.client.post = message => posted.resolve(message)
  const next = runtime.run('preview', {
    program: 'return answer', bindings: [], signal: AbortSignal.timeout(3000),
  })
  const prepare = await posted.promise
  await delay(150)
  assert.equal(kernel.active.computeTimer, undefined)
  assert.equal(kernel.active.wallTimer, undefined)
  kernel.client.post = post
  post(prepare)
  assert.equal((await next).value, 42)
  onMessage({ type: 'observation-started', id: observation.id })
  onMessage(observation)
  assert.equal(kernel.workerObservation, undefined)
  assert.equal(kernel.client.worker, worker)
})

test('late observation acknowledgements never suspend or reset running budgets', async t => {
  const { runtime, kernel, memory } = await fixture(t)
  const onMessage = kernel.cellExecutor.onMessage.bind(kernel.cellExecutor)
  const held = []
  kernel.cellExecutor.onMessage = message => {
    if (['observation-started', 'observation'].includes(message.type)) { held.push(message); return }
    onMessage(message)
  }
  assert.equal(await runtime.observe('preview', memory), undefined)
  assert.deepEqual(held.map(message => message.type), ['observation-started', 'observation'])
  const post = kernel.client.post.bind(kernel.client)
  const posted = Promise.withResolvers()
  kernel.client.post = message => posted.resolve(message)
  const next = runtime.run('preview', { program: 'return answer', bindings: [] })
  const prepare = await posted.promise
  const { computeTimer, wallTimer } = kernel.active
  assert.notEqual(computeTimer, undefined)
  assert.notEqual(wallTimer, undefined)
  for (const message of [
    { type: 'observation-started' }, { ...held[0], id: -1 },
    held[0], held[0], held[1], held[0], held[1],
  ]) {
    onMessage(message)
    assert.equal(kernel.active.computeTimer, computeTimer)
    assert.equal(kernel.active.wallTimer, wallTimer)
  }
  kernel.client.post = post
  post(prepare)
  assert.equal((await next).value, 42)
  assert.equal(kernel.workerObservation, undefined)
})

test('late observations and worker disposal cannot resurrect a preview', async t => {
  const { runtime, kernel, memory } = await fixture(t)
  const post = kernel.client.post.bind(kernel.client)
  let observe
  kernel.client.post = message => {
    if (message.type === 'observe') { observe = message; return }
    post(message)
  }
  const pending = runtime.observe('preview', memory)
  while (observe === undefined) await nextTurn()
  assert.equal(await pending, undefined)
  kernel.client.post = post
  assert.equal((await runtime.run('preview', { program: 'return answer', bindings: [] })).value, 42)
  kernel.cellExecutor.onMessage({ type: 'observation', id: observe.id, observation: { at: 1, entries: [] } })
  kernel.client.post = () => {}
  const disposed = runtime.observe('preview', memory)
  await nextTurn()
  await runtime.disposeSession('preview')
  assert.equal(await disposed, undefined)
  assert.equal(await runtime.observe('preview', memory), undefined)
})

test('an observation rejects worker failure and malformed replies without affecting an existing result', async t => {
  const { runtime, kernel, memory, first } = await fixture(t)
  const post = kernel.client.post.bind(kernel.client)
  let request
  kernel.client.post = message => {
    if (message.type === 'observe') { request = message; return }
    post(message)
  }
  const pending = runtime.observe('preview', memory)
  while (request === undefined) await nextTurn()
  kernel.cellExecutor.onMessage({ type: 'observation' })
  kernel.cellExecutor.onMessage({ type: 'observation', id: request.id, observation: { invalid: true } })
  assert.equal((await pending).observation, undefined)
  request = undefined
  const failed = runtime.observe('preview', memory)
  while (request === undefined) await nextTurn()
  await kernel.client.worker.terminate()
  assert.equal(await failed, undefined)
  assert.equal(first.result.value, 42)
  kernel.client.post = post
  assert.equal(await runtime.observe('preview', memory), undefined)
})
