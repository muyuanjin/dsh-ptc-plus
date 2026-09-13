import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { workerData } from 'node:worker_threads'
import test from 'node:test'

class MalformedWorker extends EventEmitter {
  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    queueMicrotask(() => this.emit('message', { ok: true, value: { malformed: true } }))
  }

  terminate() {
    return Promise.resolve(0)
  }
}

test('rejects malformed candidate result wires', async t => {
  t.mock.module('node:worker_threads', { namedExports: { Worker: MalformedWorker, workerData } })
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
    store: { filename: '/tmp/bindings.json' },
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  const result = await handler('run', { source: 'export const value = 1' })
  assert.equal(result.ok, false)
  await owner.dispose()
})
