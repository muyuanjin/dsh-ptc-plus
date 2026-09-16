import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { workerData } from 'node:worker_threads'
import test from 'node:test'

let workerOutcome = 'malformed'

class MalformedWorker extends EventEmitter {
  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (workerOutcome === 'signal') this.emit('exit', null, 'SIGKILL')
      else this.emit('message', { ok: true, value: { malformed: true } })
    })
  }

  terminate() {
    return Promise.resolve(0)
  }
}

test('rejects malformed candidate result wires and preserves every owner failure', async t => {
  const ownerFailures = []
  const ownerInstances = []
  class FakeOwner {
    constructor() {
      this.instances = new Map()
      this.nextId = 0
      this.failure = new Error(`owner ${ownerFailures.length + 1} disposal failure`)
      this.releaseFailures = []
      this.releaseResults = []
      this.releaseCalls = 0
      ownerFailures.push(this.failure)
      ownerInstances.push(this)
    }

    start() {
      const id = String(++this.nextId)
      const transport = new MalformedWorker()
      this.instances.set(id, transport)
      return { id, transport, record: {} }
    }

    async stop(id) {
      const transport = this.instances.get(id)
      this.instances.delete(id)
      await transport?.terminate()
    }

    async releaseAll() {
      this.releaseCalls += 1
      return [...(this.releaseResults.shift() ?? this.releaseFailures)]
    }

    async dispose() { return [this.failure] }
  }

  t.mock.module('../internal/isolated-worker.js', {
    namedExports: { IsolatedWorker: MalformedWorker, IsolatedOwner: FakeOwner },
  })
  t.mock.module('node:worker_threads', { namedExports: { workerData } })
  const { UserBindingConsole } = await import('../internal/user-binding-console.js')
  const { createUserBindingsOwner, USER_BINDINGS_RPC_CONTRACT } = await import('../internal/user-bindings-owner.js')
  let handler
  const ctx = {
    agents: { list: () => [] },
    tools: { get: () => undefined },
    inject(services, callback) {
      if (services[0] === 'tools') {
        callback({ tools: ctx.tools, on() { return () => {} } })
        return () => {}
      }
      if (services[0] !== 'ptcPlusRpc') return () => {}
      callback({ ptcPlusRpc: {
        register(channel, next) {
          assert.equal(channel, USER_BINDINGS_RPC_CONTRACT)
          handler = next
          return () => {}
        },
      } })
      return () => {}
    },
    effect(register) {
      return register()
    },
  }
  const owner = createUserBindingsOwner(ctx, {
    enabled: true,
    store: { filename: '/tmp/bindings.json', list: async () => [] },
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  const result = await handler('run', { source: 'export const value = 1' })
  assert.equal(result.ok, false)
  assert.equal(ownerFailures.length, 2)

  workerOutcome = 'signal'
  const signaled = await handler('run', { source: 'export const value = 1' })
  assert.equal(signaled.ok, false)
  assert.match(signaled.error.message, /code null, signal SIGKILL/)
  workerOutcome = 'malformed'

  const nextConfig = {
    userBindingsEnabled: true,
    maxWallMs: 2_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    maxValueNodes: 100,
    maxValueEdges: 100,
    maxValueArrayLength: 100,
    maxValueBigIntDigits: 100,
  }
  const consoleOwner = ownerInstances[1]
  const reconfigureFailure = new Error('console helper release failed')
  consoleOwner.releaseFailures = [reconfigureFailure]
  await assert.rejects(owner.reconfigure(nextConfig), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [reconfigureFailure])
    return true
  })
  assert.equal(consoleOwner.releaseCalls, 1)
  consoleOwner.releaseFailures = []
  await owner.reconfigure(nextConfig)
  assert.equal(consoleOwner.releaseCalls, 2)

  const disableFailure = new Error('console disable release failed')
  consoleOwner.releaseFailures = [disableFailure]
  await assert.rejects(owner.reconfigure({ ...nextConfig, userBindingsEnabled: false }), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [disableFailure])
    return true
  })
  assert.equal(consoleOwner.releaseCalls, 3)
  assert.equal((await handler('list', {})).ok, true)

  const disablePrimaryFailure = new Error('changed console disable release failed')
  const disableRollbackFailure = new Error('console option rollback failed')
  consoleOwner.releaseFailures = []
  consoleOwner.releaseResults = [[], [disablePrimaryFailure], [disableRollbackFailure]]
  await assert.rejects(owner.reconfigure({
    ...nextConfig,
    userBindingsEnabled: false,
    maxWallMs: 3_000,
  }), (caught) => {
    assert.ok(caught instanceof AggregateError)
    assert.match(caught.message, /reconfiguration and rollback failed/)
    assert.deepEqual(caught.errors[0].errors, [disablePrimaryFailure])
    assert.deepEqual(caught.errors[1].errors, [disableRollbackFailure])
    return true
  })
  assert.equal(consoleOwner.releaseCalls, 6)
  assert.equal((await handler('list', {})).ok, true)

  consoleOwner.releaseResults = []
  consoleOwner.releaseFailures = []
  await owner.reconfigure({ ...nextConfig, userBindingsEnabled: false })
  assert.equal(consoleOwner.releaseCalls, 8)

  const error = await owner.dispose().then(() => undefined, caught => caught)
  assert.ok(error instanceof AggregateError)
  assert.deepEqual(error.errors, ownerFailures)

  const directOptions = {
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
  }
  const directConsole = new UserBindingConsole(directOptions)
  const directOwner = ownerInstances.at(-1)
  const directFailure = new Error('direct console release failed')
  directOwner.releaseFailures = [directFailure]
  await assert.rejects(
    directConsole.reconfigure({ ...directOptions, maxWallMs: 2_000 }),
    (caught) => {
      assert.ok(caught instanceof AggregateError)
      assert.deepEqual(caught.errors, [directFailure])
      return true
    },
  )
  assert.equal(directConsole.options.maxWallMs, 1_000)
  assert.equal(directOwner.releaseCalls, 1)
  directOwner.releaseFailures = []
  await directConsole.reconfigure({ ...directOptions, maxWallMs: 2_000 })
  assert.equal(directConsole.options.maxWallMs, 2_000)
  assert.equal(directOwner.releaseCalls, 2)
  assert.deepEqual(await directConsole.dispose(), [directOwner.failure])
})
