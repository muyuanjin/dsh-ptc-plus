import assert from 'node:assert/strict'
import { getEventListeners, once } from 'node:events'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import test from 'node:test'
import { IsolatedWorker, UNANSWERED_SAMPLE_CODE } from '../internal/isolated-worker.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { relayWorkerOutput } from '../internal/worker-output-relay.js'
import { activeTimers, hasSessionKernel, interceptWorkerMessages, scratchDirectoryOf, sessionKernel, workerOf } from './runtime-observation.js'

function recordedReclamationFailures(kernel) {
  return [...kernel.reclamationRecords.values()]
    .filter(record => record.failed)
    .map(record => record.reason)
}

test('reports a destination failure while relaying worker output', async () => {
  const failure = new Error('worker output destination failed')
  const destination = { write(_chunk, callback) { callback(failure) } }
  await assert.rejects(relayWorkerOutput(Readable.from(['marker']), destination), failure)
})

test('retains a source failure while a relayed write is pending', async () => {
  const source = new Readable({ read() {} })
  const failure = new Error('worker output source failed')
  let finishWrite
  const relayed = relayWorkerOutput(source, {
    write(_chunk, callback) { finishWrite = callback },
  })
  const rejected = assert.rejects(relayed, failure)
  source.push('marker')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof finishWrite, 'function')
  source.emit('error', failure)
  finishWrite()
  await rejected
})

test('preserves a real helper signal, null exit code, and stderr', async t => {
  const worker = new IsolatedWorker({
    helper: new URL('../internal/kernel-child.js', import.meta.url),
    entry: new URL('./fixtures/isolated-signal-worker.mjs', import.meta.url),
    workerData: {},
    env: { ...process.env },
    protocol: 'parent-port',
  })
  t.after(() => { if (!worker.exited) worker.child.kill('SIGKILL') })
  const stderr = once(worker.stderr, 'data')
  assert.match(String((await stderr)[0]), /signal provenance marker/)
  const exited = once(worker, 'exit')
  const closed = new Promise(resolve => worker.once('close', resolve))
  assert.equal(worker.child.kill('SIGKILL'), true)
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  await closed
})

test('publishes an inner worker failure only after its final stderr drains', async t => {
  const worker = new IsolatedWorker({
    helper: new URL('../internal/kernel-child.js', import.meta.url),
    entry: new URL('./fixtures/isolated-throw-worker.mjs', import.meta.url),
    workerData: {},
    env: { ...process.env },
    protocol: 'parent-port',
  })
  t.after(() => { if (!worker.exited) worker.child.kill('SIGKILL') })
  const events = []
  let stderr = ''
  worker.stderr.on('data', chunk => { stderr += chunk; events.push('stderr') })
  worker.on('error', error => {
    assert.match(error.message, /inner worker terminal failure/)
    events.push('error')
  })
  worker.on('exit', () => events.push('exit'))
  const closed = new Promise(resolve => worker.once('close', resolve))
  await closed

  assert.match(stderr, /inner-worker-final-stderr-marker/)
  assert.deepEqual(events, ['stderr', 'error', 'exit'])
})

test('separates an awaited wait from compute and reclaims the isolated instance', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 2000 })
  t.after(() => runtime.dispose())
  const session = 'compute-versus-wait'

  // An awaited timer is not compute time: it must finish inside the wall ceiling.
  const waited = await runtime.run(session, {
    program: 'await new Promise(resolve => setTimeout(resolve, 400)); return 7', bindings: [],
  })
  assert.equal(waited.value, 7)

  const client = sessionKernel(runtime, session).client
  const scratch = await scratchDirectoryOf(runtime, session)
  const started = workerOf(runtime, session)
  const startedId = client.hostIds.get(started)
  assert.equal(client.owner.instances.has(startedId), true)

  // A synchronous dead loop can only be settled by the compute budget.
  const busy = await runtime.run(session, { program: 'while (true) {}', bindings: [] })
  assert.equal(busy.error.kind, 'timeout')
  assert.match(busy.error.message, /compute budget exhausted/)

  // The same runtime keeps serving this session on a fresh instance.
  assert.equal((await runtime.run(session, { program: 'return 8', bindings: [] })).value, 8)

  // The replaced instance is reclaimed: real exit, real output end, no owner entry.
  await client.owner.stop(startedId)
  assert.equal(started.exited, true)
  assert.equal(started.ioClosed, true)
  assert.equal(client.owner.instances.has(startedId), false)
  assert.notEqual(workerOf(runtime, session), undefined)

  // The shared scratch survives instance release and is removed with the client.
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(scratch), true)
  await runtime.disposeSession(session)
  await runtime.dispose()
  assert.equal(client.owner.instances.size, 0)
  assert.equal(existsSync(scratch), false)
})

test('retains a refused reset after an aborted ensure without an unhandled rejection', async () => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 2_000 })
  const session = 'abort-reset-refusal'
  let kernel
  let originalEnsure
  let originalReset
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    kernel = sessionKernel(runtime, session)
    originalEnsure = kernel.client.ensure.bind(kernel.client)
    originalReset = kernel.client.reset.bind(kernel.client)
    let resets = 0
    const signal = {
      aborted: false,
      reason: 'probe abort',
      addEventListener() {},
      removeEventListener() {},
    }
    // The first preflight sees a live signal. Abort while ensure is in flight so
    // only the post-ensure abort path owns the refused reclamation.
    kernel.client.ensure = async (...args) => {
      signal.aborted = true
      return originalEnsure(...args)
    }
    const refusal = new Error('probe refused reset')
    kernel.client.reset = () => {
      resets += 1
      throw refusal
    }

    const result = await runtime.run(session, {
      program: 'return 1',
      bindings: [],
      signal,
    })
    assert.equal(result.error.kind, 'abort')
    assert.match(result.error.message, /probe abort/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(resets, 1)
    assert.deepEqual(recordedReclamationFailures(kernel), [refusal])
  } finally {
    if (kernel !== undefined) {
      if (originalEnsure !== undefined) kernel.client.ensure = originalEnsure
      if (originalReset !== undefined) kernel.client.reset = originalReset
      kernel.reclamationRecords.clear()
    }
    await runtime.dispose()
  }
})

test('consumes a refused reset after late helper exit so disposal can finish', async () => {
  const runtime = new SessionRuntime({ computeMs: 50, maxWallMs: 2_000 })
  const session = 'late-exit-after-reset-refusal'
  let kernel
  let worker
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    kernel = sessionKernel(runtime, session)
    worker = workerOf(runtime, session)
    const startedId = kernel.client.hostIds.get(worker)
    const refusal = new Error('transient platform kill refusal')
    worker.terminate = async () => { throw refusal }

    const result = await runtime.run(session, { program: 'while (true) {}', bindings: [] })
    assert.equal(result.error.kind, 'timeout')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(recordedReclamationFailures(kernel), [refusal])
    assert.equal(kernel.client.owner.instances.has(startedId), true)

    assert.equal(worker.child.kill('SIGKILL'), true)
    await worker.closed
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(kernel.client.owner.instances.size, 0)

    const disposals = [runtime.dispose(), runtime.dispose()]
    assert.equal(disposals[0], disposals[1])
    const firstDisposal = await disposals[0].then(() => undefined, error => error)
    assert.ok(firstDisposal instanceof AggregateError)
    assert.deepEqual(firstDisposal.errors, [refusal])
    assert.equal(hasSessionKernel(runtime, session), true)

    await runtime.dispose()
    assert.equal(hasSessionKernel(runtime, session), false)
  } finally {
    if (worker !== undefined && !worker.exited) worker.child.kill('SIGKILL')
    if (kernel !== undefined) kernel.reclamationRecords.clear()
    await runtime.dispose().catch(() => {})
  }
})

test('reports every refused reset in start order after both helpers exit late', async () => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 2_000 })
  const session = 'multiple-late-reset-refusals'
  const firstFailure = new Error('first reset refusal')
  const secondFailure = new Error('second reset refusal')
  let kernel
  let firstWorker
  let secondWorker
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    kernel = sessionKernel(runtime, session)
    firstWorker = workerOf(runtime, session)
    firstWorker.terminate = async () => { throw firstFailure }

    const firstResult = await runtime.run(session, { program: 'while (true) {}', bindings: [] })
    assert.equal(firstResult.error.kind, 'timeout')
    await new Promise(resolve => setImmediate(resolve))

    const blocked = await runtime.run(session, { program: 'return 2', bindings: [] })
    assert.match(blocked.error.message, /previous computation helper reclamation failed/)
    assert.equal(workerOf(runtime, session), undefined)
    assert.equal(kernel.client.owner.instances.size, 1,
      'A later cell cannot create another helper after reclamation was refused.')

    // Exercise ordered reclamation directly at its owner. No second cell is
    // admitted; this explicit transport setup supplies the second failure.
    secondWorker = await kernel.client.ensure()
    assert.notEqual(secondWorker, firstWorker)
    secondWorker.terminate = async () => { throw secondFailure }
    await kernel.resetWorker(secondWorker)
    assert.deepEqual(recordedReclamationFailures(kernel), [firstFailure, secondFailure])

    assert.equal(firstWorker.child.kill('SIGKILL'), true)
    assert.equal(secondWorker.child.kill('SIGKILL'), true)
    await Promise.all([firstWorker.closed, secondWorker.closed])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(kernel.client.owner.instances.size, 0)

    const firstDisposal = await runtime.dispose().then(() => undefined, error => error)
    assert.ok(firstDisposal instanceof AggregateError)
    assert.equal(firstDisposal.errors.length, 1)
    assert.ok(firstDisposal.errors[0] instanceof AggregateError)
    assert.deepEqual(firstDisposal.errors[0].errors, [firstFailure, secondFailure])
    assert.equal(hasSessionKernel(runtime, session), true)

    await runtime.dispose()
    assert.equal(hasSessionKernel(runtime, session), false)
  } finally {
    if (firstWorker !== undefined && !firstWorker.exited) firstWorker.child.kill('SIGKILL')
    if (secondWorker !== undefined && !secondWorker.exited) secondWorker.child.kill('SIGKILL')
    if (kernel !== undefined) kernel.reclamationRecords.clear()
    await runtime.dispose().catch(() => {})
  }
})

test('fails the cell without dispatch when request baseline sampling fails', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  const session = 'sample-failure'
  let originalPost
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    kernel.client.worker.sampleUtilization = async () => {
      throw new Error('probe sample failure')
    }
    const posts = []
    originalPost = kernel.client.post.bind(kernel.client)
    kernel.client.post = message => { posts.push(message.type); return originalPost(message) }

    const result = await runtime.run(session, { program: 'return 2', bindings: [] })
    assert.equal(result.error.kind, 'worker-exit')
    assert.match(result.error.message, /probe sample failure/)
    assert.deepEqual(posts, [])
  } finally {
    const kernel = sessionKernel(runtime, session)
    if (kernel !== undefined && originalPost !== undefined) kernel.client.post = originalPost
    await runtime.dispose()
  }
})

test('keeps the live worker and its bindings when a sample goes unanswered by an answering helper', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  const session = 'sample-unanswered'
  try {
    await runtime.run(session, { program: 'const retained = 41', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    const catalog = kernel.bindingCatalog
    const sample = worker.sampleUtilization.bind(worker)
    let unanswered = 1
    worker.sampleUtilization = () => {
      if (unanswered-- > 0) {
        const error = new Error('kernel helper stayed alive but did not answer utilization sampling before its deadline')
        error.code = UNANSWERED_SAMPLE_CODE
        return Promise.reject(error)
      }
      return sample()
    }

    const execution = await runtime.runTentative(session, { program: 'return retained + 1', bindings: [] })
    assert.equal(execution.result.error.kind, 'budget-unavailable')
    assert.match(execution.result.error.message, /was not dispatched/)
    // The cell never ran, so its journal must not claim a step that recovery
    // could replay, and no earlier settlement may be discarded for it.
    assert.equal(execution.settlement.journal.status, 'noop')
    // Nothing was dispatched, so no earlier cell can have been discarded: the
    // live worker, its replayed timeline and the binding catalog stay as they were.
    assert.equal(kernel.client.worker, worker)
    assert.equal(kernel.replayed, true)
    assert.equal(kernel.bindingCatalog, catalog)

    assert.deepEqual(await runtime.run(session, { program: 'return retained + 1', bindings: [] }), {
      logs: [],
      value: 42,
    })
    // A settlement that arrives for a cell the kernel already ended is not its own.
    kernel.abandonCell({ settled: false }, { logs: [], error: { kind: 'timeout', message: 'stale settlement' } })
    assert.equal(kernel.active, undefined)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('keeps the worker for one unmeasured cell and drops it for the next', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  const session = 'sample-unreachable'
  try {
    await runtime.run(session, { program: 'const retained = 41', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    const sample = worker.sampleUtilization.bind(worker)
    let unmeasured = 2
    worker.sampleUtilization = () => {
      if (unmeasured > 0) {
        unmeasured -= 1
        const error = new Error('kernel helper did not answer utilization sampling before its deadline')
        error.code = UNANSWERED_SAMPLE_CODE
        return Promise.reject(error)
      }
      return sample()
    }

    const first = await runtime.runTentative(session, { program: 'return retained + 1', bindings: [] })
    assert.equal(first.result.error.kind, 'budget-unavailable')
    assert.equal(first.settlement.journal.status, 'noop')
    // One unmeasured cell is not evidence about the worker.
    assert.equal(kernel.client.worker, worker)
    assert.equal(kernel.replayed, true)

    const second = await runtime.runTentative(session, { program: 'return retained + 1', bindings: [] })
    assert.equal(second.result.error.kind, 'budget-unavailable')
    assert.match(second.result.error.message, /this worker was dropped/)
    assert.equal(second.settlement.journal.status, 'noop')
    // Two consecutive unmeasured cells drop the live worker while the proved
    // frontier stays, so the next cell replays it instead of losing it.
    assert.equal(kernel.client.worker, undefined)
    assert.equal(kernel.replayed, false)

    // A fresh worker gets its own first chance, so the count starts over for it.
    assert.equal(kernel.unmeasuredCells, 0)

    assert.deepEqual(await runtime.run(session, { program: 'return retained + 1', bindings: [] }), {
      logs: [],
      value: 42,
    })
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('a settled cell clears the consecutive unmeasured count', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  const session = 'sample-unreachable-reset'
  try {
    await runtime.run(session, { program: 'const retained = 7', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    const sample = worker.sampleUtilization.bind(worker)
    const miss = () => {
      const error = new Error('kernel helper did not answer utilization sampling before its deadline')
      error.code = UNANSWERED_SAMPLE_CODE
      return Promise.reject(error)
    }
    worker.sampleUtilization = miss

    const first = await runtime.runTentative(session, { program: 'return retained', bindings: [] })
    assert.equal(first.result.error.kind, 'budget-unavailable')

    // A cell that settles normally proves the worker answers, so the count restarts.
    worker.sampleUtilization = sample
    assert.deepEqual((await runtime.runTentative(session, { program: 'return retained', bindings: [] })).result.value, 7)

    worker.sampleUtilization = miss
    const later = await runtime.runTentative(session, { program: 'return retained', bindings: [] })
    assert.equal(later.result.error.kind, 'budget-unavailable')
    assert.doesNotMatch(later.result.error.message, /this worker was dropped/)
    assert.equal(kernel.client.worker, worker)
    assert.equal(kernel.unmeasuredCells, 1, 'the settled cell must clear the count')
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('abandoning a started cell releases its budgets and settles it as a no-op', async () => {
  const runtime = new SessionRuntime({ computeMs: 5_000, maxWallMs: 5_000 })
  const session = 'abandon-budget-release'
  let intercepted
  let compute
  let wall
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    const catalog = kernel.bindingCatalog
    // Hold the readiness handshake so the cell keeps a running compute interval
    // and cannot settle by itself.
    intercepted = interceptWorkerMessages(runtime, session, (message, deliver) => {
      if (message?.type !== 'ready') deliver(message)
    })
    const pending = runtime.runTentative(session, { program: 'return 2', bindings: [] })
    const deadline = Date.now() + 5_000
    while (compute === undefined) {
      if (Date.now() > deadline) assert.fail('the cell never started its compute budget')
      compute = activeTimers(runtime, session)?.compute
      wall = activeTimers(runtime, session)?.wall
      await new Promise(resolve => setImmediate(resolve))
    }
    const controller = new AbortController()
    kernel.active.request.signal = controller.signal
    kernel.active.onAbort = () => {}
    controller.signal.addEventListener('abort', kernel.active.onAbort, { once: true })
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
    kernel.abandonCell(kernel.active, { logs: [], error: { kind: 'budget-unavailable', message: 'abandoned for the test' } })
    const execution = await pending
    assert.equal(execution.result.error.message, 'abandoned for the test')
    assert.equal(execution.settlement.journal.status, 'noop')
    assert.equal(kernel.client.worker, worker)
    assert.equal(kernel.bindingCatalog, catalog)
    assert.equal(kernel.replayed, true)
    assert.equal(compute._destroyed, true, 'the abandoned cell must release its compute interval')
    assert.equal(wall._destroyed, true, 'the abandoned cell must release its wall timer')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the abandoned cell must release its cancellation listener')
    assert.equal(activeTimers(runtime, session), undefined)
  } finally {
    // A leaked interval would otherwise keep this test process alive.
    if (compute !== undefined) clearInterval(compute)
    if (wall !== undefined) clearTimeout(wall)
    if (intercepted?.restore !== undefined) intercepted.restore()
    await runtime.dispose().catch(() => {})
  }
})

test('reports an unchanged state for repeated failures that ran nothing', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  const session = 'noop-state-effect'
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    let last
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController()
      controller.abort('same failure every time')
      last = await runtime.run(session, {
        program: 'return 2', bindings: [], signal: controller.signal,
      })
    }
    // The journal proves nothing changed, so the repeated-failure hint must not
    // describe that state as unknown.
    assert.equal(last.error.kind, 'abort')
    assert.match(last.logs.join('\n'), /same error/)
    assert.match(last.logs.join('\n'), /state: unchanged/)
    assert.doesNotMatch(last.logs.join('\n'), /state: unknown/)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('a discarded settlement also clears the consecutive unmeasured count', async () => {
  // Replay is off so the worker replacement is not followed by a replay pass.
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 20_000, durableReplay: false })
  const session = 'terminate-clears-count'
  const original = IsolatedWorker.prototype.sampleUtilization
  const miss = () => {
    const error = new Error('kernel helper did not answer utilization sampling before its deadline')
    error.code = UNANSWERED_SAMPLE_CODE
    return Promise.reject(error)
  }
  try {
    IsolatedWorker.prototype.sampleUtilization = miss
    const first = await runtime.runTentative(session, { program: 'return 1', bindings: [] })
    assert.equal(first.result.error.kind, 'budget-unavailable')
    const kernel = sessionKernel(runtime, session)
    assert.equal(kernel.unmeasuredCells, 1)

    // A dispatched cell that exhausts its compute budget settles with a discard.
    IsolatedWorker.prototype.sampleUtilization = original
    runtime.reconfigure({ computeMs: 1, maxWallMs: 20_000 })
    const spinning = await runtime.runTentative(session, {
      program: 'const until = Date.now() + 60; while (Date.now() < until) {}; return 1', bindings: [],
    })
    assert.equal(spinning.result.error.kind, 'timeout')
    assert.equal(spinning.settlement.journal.status, 'discarded')
    assert.equal(kernel.unmeasuredCells, 0, 'a discarded settlement clears the count')

    // The replacement worker's first unmeasured cell must not be the second one.
    IsolatedWorker.prototype.sampleUtilization = miss
    runtime.reconfigure({ computeMs: 500, maxWallMs: 20_000 })
    const later = await runtime.runTentative(session, { program: 'return 1', bindings: [] })
    assert.equal(later.result.error.kind, 'budget-unavailable')
    assert.doesNotMatch(later.result.error.message, /this worker was dropped/)
    assert.equal(kernel.unmeasuredCells, 1)
  } finally {
    IsolatedWorker.prototype.sampleUtilization = original
    await runtime.dispose().catch(() => {})
  }
})

test('a settled cell releases its cancellation listener', async () => {
  const runtime = new SessionRuntime({ computeMs: 5_000, maxWallMs: 5_000 })
  const session = 'settled-listener-release'
  const controller = new AbortController()
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    const pending = runtime.run(session, {
      program: 'await new Promise(resolve => setTimeout(resolve, 80)); return 2',
      bindings: [],
      signal: controller.signal,
    })
    const deadline = Date.now() + 5_000
    while (getEventListeners(controller.signal, 'abort').length === 0) {
      if (Date.now() > deadline) assert.fail('the cell never registered its cancellation listener')
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
    assert.deepEqual(await pending, { logs: [], value: 2 })
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'a settled cell must release its cancellation listener')
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('aborting while request baseline sampling is pending does not dispatch', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  const session = 'sample-abort'
  let originalPost
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    let releaseSample
    let markSampleStarted
    const sampleStarted = new Promise(resolve => { markSampleStarted = resolve })
    kernel.client.worker.sampleUtilization = () => {
      markSampleStarted()
      return new Promise(resolve => { releaseSample = resolve })
    }
    const posts = []
    originalPost = kernel.client.post.bind(kernel.client)
    kernel.client.post = message => { posts.push(message.type); return originalPost(message) }

    const controller = new AbortController()
    const pending = runtime.run(session, {
      program: 'return 2',
      bindings: [],
      signal: controller.signal,
    })
    await sampleStarted
    controller.abort('sample abort')
    const result = await pending
    assert.equal(result.error.kind, 'abort')
    assert.match(result.error.message, /sample abort/)
    releaseSample({ idle: 0, active: 999 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(posts, [])
  } finally {
    const kernel = sessionKernel(runtime, session)
    if (kernel !== undefined && originalPost !== undefined) kernel.client.post = originalPost
    await runtime.dispose()
  }
})

test('wall timeout while request baseline sampling is pending does not dispatch', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000 })
  const session = 'sample-wall-timeout'
  let originalPost
  try {
    await runtime.run(session, { program: 'return 1', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    const catalog = kernel.bindingCatalog
    let releaseSample
    let markSampleStarted
    const sampleStarted = new Promise(resolve => { markSampleStarted = resolve })
    kernel.client.worker.sampleUtilization = () => {
      markSampleStarted()
      return new Promise(resolve => { releaseSample = resolve })
    }
    runtime.reconfigure({ computeMs: 1_000, maxWallMs: 20 })
    const posts = []
    originalPost = kernel.client.post.bind(kernel.client)
    kernel.client.post = message => { posts.push(message.type); return originalPost(message) }

    const execution = await runtime.runTentative(session, { program: 'return 2', bindings: [] })
    // A ceiling that ends a cell before dispatch is the same unmeasured outcome as
    // a missing baseline: nothing ran, so nothing earlier is discarded for it.
    assert.equal(execution.result.error.kind, 'budget-unavailable')
    assert.match(execution.result.error.message, /wall-clock ceiling/)
    assert.match(execution.result.error.message, /before this cell was dispatched/)
    assert.equal(execution.settlement.journal.status, 'noop')
    assert.equal(kernel.client.worker, worker)
    assert.equal(kernel.bindingCatalog, catalog)
    assert.equal(kernel.replayed, true)
    releaseSample({ idle: 0, active: 999 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(posts, [])
  } finally {
    const kernel = sessionKernel(runtime, session)
    if (kernel !== undefined && originalPost !== undefined) kernel.client.post = originalPost
    await runtime.dispose()
  }
})

test('waits for the sample bound the cell configuration carries', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 5_000, sampleBoundMs: 2_000 })
  const session = 'sample-bound-config'
  try {
    assert.deepEqual((await runtime.runTentative(session, { program: 'return 1', bindings: [] })).result.value, 1)
    const kernel = sessionKernel(runtime, session)
    assert.equal(kernel.client.worker.sampleBoundMs, 2_000)
    // The transport reads the bound per request, so a later change applies to the
    // next cell on the same live worker instead of needing a new worker.
    runtime.reconfigure({ sampleBoundMs: 3_000 })
    assert.deepEqual((await runtime.runTentative(session, { program: 'return 2', bindings: [] })).result.value, 2)
    assert.equal(kernel.client.worker.sampleBoundMs, 3_000)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('creates the session kernel with the configuration current when it starts', async () => {
  let releaseLog
  const gate = new Promise(resolve => { releaseLog = resolve })
  const runtime = new SessionRuntime(
    { computeMs: 500, maxWallMs: 5_000, workerReclaimMs: 7_000, startupProbeMs: 5_000 },
    { readSessionLog: async session => { await gate; return session } },
  )
  const session = 'kernel-created-after-reconfigure'
  try {
    // The cell is admitted under 7000/5000 and waits for its session log.
    const execution = runtime.runTentative(session, { program: 'return 1', bindings: [] })
    await new Promise(resolve => setImmediate(resolve))
    runtime.reconfigure({
      computeMs: 500,
      maxWallMs: 5_000,
      workerReclaimMs: 15_000,
      startupProbeMs: 9_000,
    })
    releaseLog()
    const settled = await execution
    assert.deepEqual(settled.result.value, 1)
    const kernel = sessionKernel(runtime, session)
    // The kernel starts the worker and serves later cells, so it must hold the
    // configuration current at creation rather than the admitted snapshot.
    assert.equal(kernel.config.workerReclaimMs, 15_000)
    assert.equal(kernel.client.worker.reclaimBoundMs, 15_000)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('starts a worker with the configuration current when it is created', async () => {
  const runtime = new SessionRuntime({
    computeMs: 500,
    maxWallMs: 5_000,
    workerReclaimMs: 7_000,
    startupProbeMs: 5_000,
  })
  const session = 'worker-created-after-reconfigure'
  try {
    // A parse-rejected cell creates the kernel without starting a worker.
    const broken = await runtime.runTentative(session, { program: 'const =', bindings: [] })
    assert.equal(broken.result.error.kind, 'exception')
    const kernel = sessionKernel(runtime, session)
    assert.equal(kernel.client.worker, undefined)
    let releasePrepare
    kernel.reclamationAttempts.add(new Promise(resolve => { releasePrepare = resolve }))
    let bounds
    const ensure = kernel.client.ensure.bind(kernel.client)
    kernel.client.ensure = (limit, value) => {
      bounds = typeof value === 'function' ? value() : value
      return ensure(limit, value)
    }
    // This cell is admitted under 7000/5000, before the settings change; the
    // worker it starts is reused by later cells, so it must take the current
    // configuration rather than the admitted snapshot.
    const execution = runtime.runTentative(session, { program: 'const kept = 1; return kept', bindings: [] })
    await new Promise(resolve => setImmediate(resolve))
    runtime.reconfigure({
      computeMs: 500,
      maxWallMs: 5_000,
      workerReclaimMs: 15_000,
      startupProbeMs: 9_000,
    })
    releasePrepare()
    const settled = await execution
    assert.deepEqual(settled.result.value, 1)
    assert.deepEqual(bounds, { reclaimBoundMs: 15_000, startupProbeMs: 9_000 })
    assert.equal(kernel.client.worker.reclaimBoundMs, 15_000)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('starts the next worker with the close and startup bounds the configuration carries', async () => {
  const runtime = new SessionRuntime({
    computeMs: 500,
    maxWallMs: 5_000,
    startupProbeMs: 9_000,
    workerReclaimMs: 7_000,
  })
  const session = 'worker-start-bounds-config'
  try {
    assert.deepEqual((await runtime.runTentative(session, { program: 'return 1', bindings: [] })).result.value, 1)
    const kernel = sessionKernel(runtime, session)
    let bounds
    const ensure = kernel.client.ensure.bind(kernel.client)
    kernel.client.ensure = (limit, value) => {
      bounds = typeof value === 'function' ? value() : value
      return ensure(limit, value)
    }
    // Dropping the live worker is the only path that starts another one, so the
    // next cell must hand both configured bounds to the transport it starts.
    await kernel.resetWorker(kernel.client.worker)
    assert.deepEqual((await runtime.runTentative(session, { program: 'return 2', bindings: [] })).result.value, 2)
    assert.deepEqual(bounds, { reclaimBoundMs: 7_000, startupProbeMs: 9_000 })
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('applies the reclamation bound to the live worker when the configuration changes', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 2_000, workerReclaimMs: 7_000 })
  const session = 'reclaim-bound-config'
  try {
    assert.deepEqual((await runtime.runTentative(session, { program: 'return 1', bindings: [] })).result.value, 1)
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    assert.equal(worker.reclaimBoundMs, 7_000)
    // A close that bypasses resetWorker (idle disposal, owner auto-close) reads the
    // transport, so the change has to reach the live worker immediately.
    runtime.reconfigure({ workerReclaimMs: 9_000 })
    assert.equal(worker.reclaimBoundMs, 9_000)
    await kernel.resetWorker(worker)
    assert.equal(worker.reclaimBoundMs, 9_000)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('settles an unmeasured cell by the configuration snapshot it was submitted with', async () => {
  const runtime = new SessionRuntime({ computeMs: 500, maxWallMs: 5_000, unmeasuredCellLimit: 2 })
  const session = 'unmeasured-snapshot'
  try {
    assert.deepEqual((await runtime.runTentative(session, { program: 'const retained = 1; return retained', bindings: [] })).result.value, 1)
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    let rejectSample
    worker.sampleUtilization = () => new Promise((_, reject) => { rejectSample = reject })
    const execution = runtime.runTentative(session, { program: 'return retained', bindings: [] })
    const deadline = Date.now() + 5_000
    while (rejectSample === undefined) {
      if (Date.now() > deadline) assert.fail('the cell never requested its compute baseline')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    // The cell was submitted under the default limit of two; a live change to one
    // must not decide the settlement of a cell that already started.
    runtime.reconfigure({ computeMs: 500, maxWallMs: 5_000, unmeasuredCellLimit: 1 })
    const error = new Error('kernel helper did not answer utilization sampling before its deadline')
    error.code = UNANSWERED_SAMPLE_CODE
    rejectSample(error)
    const settled = await execution
    assert.equal(settled.result.error.kind, 'budget-unavailable')
    assert.doesNotMatch(settled.result.error.message, /this worker was dropped/)
    assert.equal(kernel.client.worker, worker)
    assert.equal(kernel.unmeasuredCells, 1)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('reclaims the worker at the unmeasured limit the configuration carries', async () => {
  const runtime = new SessionRuntime({
    computeMs: 500,
    maxWallMs: 2_000,
    unmeasuredCellLimit: 1,
    workerReclaimMs: 6_000,
  })
  const session = 'sample-unreachable-config'
  try {
    await runtime.run(session, { program: 'const retained = 41', bindings: [] })
    const kernel = sessionKernel(runtime, session)
    const worker = kernel.client.worker
    // The worker started with 6000; only the drop path can read 8000 from the
    // configuration current at that moment.
    runtime.reconfigure({ computeMs: 500, maxWallMs: 2_000, unmeasuredCellLimit: 1, workerReclaimMs: 8_000 })
    kernel.client.worker.sampleUtilization = () => {
      const error = new Error('kernel helper did not answer utilization sampling before its deadline')
      error.code = UNANSWERED_SAMPLE_CODE
      return Promise.reject(error)
    }
    const first = await runtime.runTentative(session, { program: 'return retained + 1', bindings: [] })
    assert.equal(first.result.error.kind, 'budget-unavailable')
    assert.match(first.result.error.message, /this worker was dropped/)
    assert.equal(kernel.client.worker, undefined)
    // The real drop path, not a direct kernel call, applied the configured bound.
    assert.equal(worker.reclaimBoundMs, 8_000)
    assert.equal(kernel.replayed, false)
    assert.deepEqual(await runtime.run(session, { program: 'return retained + 1', bindings: [] }), {
      logs: [],
      value: 42,
    })
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

test('starts the worker with the configuration current after the scratch wait', async () => {
  const runtime = new SessionRuntime({
    computeMs: 500,
    maxWallMs: 5_000,
    workerReclaimMs: 7_000,
    startupProbeMs: 5_000,
  })
  const session = 'worker-bounds-scratch-window'
  try {
    const broken = await runtime.runTentative(session, { program: 'const =', bindings: [] })
    assert.equal(broken.result.error.kind, 'exception')
    const kernel = sessionKernel(runtime, session)
    assert.equal(kernel.client.worker, undefined)
    let releaseScratch
    kernel.client.scratchReady = new Promise(resolve => { releaseScratch = resolve })
    let started
    const start = kernel.client.owner.start.bind(kernel.client.owner)
    kernel.client.owner.start = options => {
      started = options
      return start(options)
    }
    // The cell is admitted under 7000/5000 and parks on the worker client's
    // scratch wait; the settings change lands inside that macrotask gap.
    const execution = runtime.runTentative(session, { program: 'const kept = 1; return kept', bindings: [] })
    await new Promise(resolve => setImmediate(resolve))
    runtime.reconfigure({
      computeMs: 500,
      maxWallMs: 5_000,
      workerReclaimMs: 15_000,
      startupProbeMs: 9_000,
    })
    releaseScratch(tmpdir())
    const settled = await execution
    assert.deepEqual(settled.result.value, 1)
    // Both bounds are read after the scratch wait, so the worker carries the
    // settings current when it is actually created.
    assert.equal(started.workerData.startupProbeMs, 9_000)
    assert.equal(started.reclaimBoundMs, 15_000)
    assert.equal(kernel.client.worker.reclaimBoundMs, 15_000)
  } finally {
    await runtime.dispose().catch(() => {})
  }
})
