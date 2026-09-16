import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { IsolatedOwner } from '../internal/isolated-worker.js'

class FakeTransport extends EventEmitter {
  constructor({ refuse = false, pendingOutput = false, terminateGate = undefined,
    refusalMessage = 'helper could not be killed' } = {}) {
    super()
    this.exited = false
    this.stops = 0
    this.refuse = refuse
    this.refusalMessage = refusalMessage
    this.terminateGate = terminateGate
    this.ioClosed = !pendingOutput
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  /** Report the real stream close the transport observes after its process exits. */
  closeOutput() {
    this.ioClosed = true
    this.resolveClosed()
    this.emit('close')
  }

  async terminate() {
    this.stops += 1
    if (this.terminateGate !== undefined) await this.terminateGate
    if (this.refuse) throw new Error(this.refusalMessage)
    this.exited = true
    this.emit('exit', 0)
  }
}

test('a fork failure is its own terminal fact and leaves nothing owned', async () => {
  const owner = new IsolatedOwner({
    create: () => { throw new Error('fork failed before start') },
  })
  assert.throws(() => owner.start({}), /fork failed before start/)
  await Promise.resolve()
  assert.equal(owner.instances.size, 0)
  assert.deepEqual(await owner.dispose(), [])
})

test('retries synchronous cleanup after a never-started instance fails', async () => {
  let cleanups = 0
  const owner = new IsolatedOwner({
    create: () => { throw new Error('fork failed before start') },
  })
  assert.throws(() => owner.start({
    cleanup: () => {
      cleanups += 1
      if (cleanups === 1) throw new Error('synchronous cleanup failure')
    },
  }), /fork failed before start/)
  await Promise.resolve()
  assert.equal(cleanups, 1)
  assert.equal(owner.instances.size, 1)

  assert.deepEqual(await owner.dispose(), [])
  assert.equal(cleanups, 2)
  assert.equal(owner.instances.size, 0)
})

test('a late real exit releases an instance whose close was refused', async () => {
  const transport = new FakeTransport({ refuse: true })
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({})
  await assert.rejects(owner.stop(started.id), /could not be killed/)
  assert.equal(owner.instances.size, 1)
  transport.exited = true
  transport.emit('exit', 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(owner.instances.size, 0)
  assert.deepEqual(await owner.dispose(), [])
})

test('a control error makes the owner reclaim the instance itself', async () => {
  const transport = new FakeTransport()
  const owner = new IsolatedOwner({ create: () => transport })
  owner.start({})
  transport.emit('error', new Error('transport failed'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.stops, 1)
  assert.equal(owner.instances.size, 0)
})

test('dispose refuses new starts and shares one result', async () => {
  const transport = new FakeTransport()
  const owner = new IsolatedOwner({ create: () => transport })
  owner.start({})
  const first = owner.dispose()
  const second = owner.dispose()
  assert.equal(first, second)
  assert.throws(() => owner.start({}), /is disposing/)
  assert.deepEqual(await first, [])
})

test('runs the instance cleanup before releasing it', async () => {
  const transport = new FakeTransport()
  const cleaned = []
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({ cleanup: async () => { cleaned.push(started.id) } })
  await owner.stop(started.id)
  assert.deepEqual(cleaned, [started.id])
  assert.equal(owner.instances.size, 0)
})

test('keeps a cleanup failure as a disposal failure', async () => {
  const transport = new FakeTransport()
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({ cleanup: async () => { throw new Error('scratch removal failed') } })
  await owner.stop(started.id).catch(() => {})
  const failures = await owner.dispose()
  assert.equal(failures.length, 1)
  assert.match(failures[0].message, /scratch removal failed/)
  assert.equal(owner.instances.size, 1)
})

test('retries a cleanup failure on a later dispose without terminating an exited transport again', async () => {
  const transport = new FakeTransport()
  let cleanups = 0
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({
    cleanup: async () => {
      cleanups += 1
      if (cleanups === 1) throw new Error('transient cleanup failure')
    },
  })
  const first = await owner.dispose()
  assert.equal(first.length, 1)
  assert.match(first[0].message, /transient cleanup failure/)
  assert.equal(owner.instances.size, 1)
  assert.equal(started.record.state, 'cleanup-failed')
  assert.equal(transport.stops, 1)
  assert.throws(() => owner.start({}), /is disposing/)

  const second = await owner.dispose()
  assert.deepEqual(second, [])
  assert.equal(cleanups, 2)
  assert.equal(transport.stops, 1)
  assert.equal(owner.instances.size, 0)
})

test('releaseAll retries a retained cleanup failure once the instance can be reclaimed', async () => {
  const transport = new FakeTransport()
  let cleanups = 0
  const owner = new IsolatedOwner({ create: () => transport })
  owner.start({
    cleanup: async () => {
      cleanups += 1
      if (cleanups === 1) throw new Error('transient cleanup failure')
    },
  })
  const first = await owner.releaseAll()
  assert.equal(first.length, 1)
  assert.match(first[0].message, /transient cleanup failure/)
  assert.equal(owner.instances.size, 1)
  assert.equal(transport.stops, 1)

  const second = await owner.releaseAll()
  assert.deepEqual(second, [])
  assert.equal(cleanups, 2)
  assert.equal(transport.stops, 1)
  assert.equal(owner.instances.size, 0)
})

test('reclaims an instance whose creation threw after the fork existed', async () => {
  const transport = new FakeTransport()
  const owner = new IsolatedOwner({
    create: () => {
      const error = new Error('init send failed')
      error.transport = transport
      throw error
    },
  })
  assert.throws(() => owner.start({}), /init send failed/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.stops, 1)
  assert.equal(owner.instances.size, 0)
})

test('keeps a second transport error observable instead of uncaught', async () => {
  const transport = new FakeTransport({ refuse: true })
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({})
  transport.emit('error', new Error('first'))
  transport.emit('error', new Error('second'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.stops >= 1, true)
  assert.equal(owner.instances.has(started.id), true)
  const failures = await owner.dispose()
  assert.equal(failures.length, 1)
})

test('reports a still-unresolved cleanup failure again on dispose', async () => {
  const transport = new FakeTransport()
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({ cleanup: async () => { throw new Error('scratch removal failed') } })
  await owner.stop(started.id).catch(() => {})
  const released = await owner.releaseAll()
  assert.equal(released.length, 1)
  const disposed = await owner.dispose()
  assert.equal(disposed.length, 1)
  assert.match(disposed[0].message, /scratch removal failed/)
})

test('releases only after the output pipes really ended', async () => {
  const transport = new FakeTransport({ pendingOutput: true })
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({})
  await owner.stop(started.id).catch(() => {})
  assert.equal(owner.instances.size, 1)
  assert.equal(started.record.state, 'output-pending')
  transport.closeOutput()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(owner.instances.size, 0)
})

test('dispose reports a refusal it cannot confirm', async () => {
  const transport = new FakeTransport({ refuse: true })
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({})
  assert.equal(started.record.state, 'running')
  const failures = await owner.dispose()
  assert.equal(failures.length, 1)
  assert.match(failures[0].message, /could not be killed/)
  assert.equal(owner.instances.size, 1)
})

test('releaseAll reports every refused stop', async () => {
  const transport = new FakeTransport({ refuse: true })
  const owner = new IsolatedOwner({ create: () => transport })
  const started = owner.start({})
  const failures = await owner.releaseAll()
  assert.equal(started.record.state, 'unreclaimed')
  assert.equal(failures.length, 1)
  assert.match(failures[0].message, /could not be killed/)
  assert.equal(owner.instances.size, 1)
})

for (const method of ['releaseAll', 'dispose']) {
  test(`${method} starts every worker shutdown before awaiting the first`, async () => {
    let releaseFirst
    const firstGate = new Promise(resolve => { releaseFirst = resolve })
    const first = new FakeTransport({ terminateGate: firstGate })
    const second = new FakeTransport()
    const transports = [first, second]
    const owner = new IsolatedOwner({ create: () => transports.shift() })
    owner.start({})
    owner.start({})

    const released = owner[method]()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(first.stops, 1)
    assert.equal(second.stops, 1)

    releaseFirst()
    assert.deepEqual(await released, [])
    assert.equal(owner.instances.size, 0)
  })
}

test('bulk release aggregates stop failures in registration order', async () => {
  const transports = [
    new FakeTransport({ refuse: true, refusalMessage: 'first refusal' }),
    new FakeTransport({ refuse: true, refusalMessage: 'second refusal' }),
  ]
  const owner = new IsolatedOwner({ create: () => transports.shift() })
  owner.start({})
  owner.start({})
  const failures = await owner.releaseAll()
  assert.deepEqual(failures.map(error => error.message), ['first refusal', 'second refusal'])
})

test('start failure waits for its pending cleanup before release', async () => {
  let releaseCleanup
  const pendingCleanup = new Promise(resolve => { releaseCleanup = resolve })
  const owner = new IsolatedOwner({
    create: () => { throw new Error('fork failed before start') },
  })
  assert.throws(
    () => owner.start({ cleanup: () => pendingCleanup }),
    /fork failed before start/,
  )
  assert.equal(owner.instances.size, 1)

  let disposed = false
  const disposal = owner.dispose().then(failures => { disposed = true; return failures })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.equal(owner.instances.size, 1)

  releaseCleanup()
  assert.deepEqual(await disposal, [])
  assert.equal(owner.instances.size, 0)
})
