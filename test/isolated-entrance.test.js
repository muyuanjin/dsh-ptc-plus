import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { IsolatedWorker } from '../internal/isolated-worker.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { relayWorkerOutput } from '../internal/worker-output-relay.js'
import { hasSessionKernel, scratchDirectoryOf, sessionKernel, workerOf } from './runtime-observation.js'

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

    const secondRun = runtime.run(session, { program: 'while (true) {}', bindings: [] })
    for (let index = 0; index < 20; index += 1) {
      secondWorker = workerOf(runtime, session)
      if (secondWorker !== undefined && secondWorker !== firstWorker) break
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.notEqual(secondWorker, undefined)
    assert.notEqual(secondWorker, firstWorker)
    secondWorker.terminate = async () => { throw secondFailure }

    const secondResult = await secondRun
    assert.equal(secondResult.error.kind, 'timeout')
    await new Promise(resolve => setImmediate(resolve))
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

    const pending = runtime.run(session, { program: 'return 2', bindings: [] })
    await sampleStarted
    const result = await pending
    assert.equal(result.error.kind, 'timeout')
    assert.match(result.error.message, /wall-clock ceiling/)
    releaseSample({ idle: 0, active: 999 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(posts, [])
  } finally {
    const kernel = sessionKernel(runtime, session)
    if (kernel !== undefined && originalPost !== undefined) kernel.client.post = originalPost
    await runtime.dispose()
  }
})
