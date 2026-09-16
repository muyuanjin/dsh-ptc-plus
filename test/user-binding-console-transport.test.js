import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

const options = { cwd: process.cwd(), maxWallMs: 10_000, maxOutputBytes: 64 * 1024, maxOldGenerationSizeMb: 128 }
const source = 'export const answer: number = 42'
/** Let a released worker finish its cooperative stop before asserting on it. */
const flushStops = () => new Promise(resolve => setImmediate(resolve))

test('console ownership bounds count and handles expiry, reconfiguration and transport failures', async t => {
  const workers = []
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); workers.push(this) }
    postMessage(message) { this.request = message }
    terminate() {
      this.terminated = true
      this.emit('exit', 0)
      return Promise.resolve(0)
    }
    reply(value = { output: '42' }) { this.emit('message', { id: this.request.id, ...value }) }
  }
  t.mock.module('../internal/isolated-worker.js', {
    namedExports: {
      IsolatedWorker: FakeWorker,
      IsolatedOwner: class FakeOwner {
        constructor() {
          this.instances = new Map()
          this.nextId = 0
        }

        start() {
          const id = String(++this.nextId)
          const transport = new FakeWorker()
          this.instances.set(id, transport)
          return { id, transport, record: {} }
        }

        async stop(id) {
          const transport = this.instances.get(id)
          this.instances.delete(id)
          await transport?.terminate()
        }

        async releaseAll() {
          const failures = []
          for (const id of [...this.instances.keys()]) {
            try {
              await this.stop(id)
            } catch (error) {
              failures.push(error)
            }
          }
          return failures
        }

        async dispose() {
          return this.releaseAll()
        }
      },
    },
  })
  const { UserBindingConsole: MockConsole, CONSOLE_IDLE_MS } = await import('../internal/user-binding-console.js')
  const owner = new MockConsole(options)
  t.after(() => owner.dispose())
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const firstRun = owner.run({ source, code: 'answer' })
  workers[0].stdout.emit('data', Buffer.from('log'))
  workers[0].stderr.emit('data', Buffer.from('warning'))
  workers[0].emit('message', { id: -1, output: 'stale' })
  workers[0].reply({ output: '42', unrelated: 1n })
  const first = await firstRun
  assert.equal(first.expiresAt, 1000 + CONSOLE_IDLE_MS)
  assert.equal(first.logs.length, 2)
  assert.equal(Object.hasOwn(first, 'unrelated'), false)
  const replacement = owner.run({ environment: first.environment, source: 'export const answer = 43', code: 'answer' })
  workers.at(-1).reply({ output: '43' })
  assert.equal((await replacement).reset, true)
  const activeHandle = [...owner.environments.keys()][0]
  const blocked = owner.run({ environment: activeHandle, source: 'export const answer = 43', code: 'answer' })
  await assert.rejects(owner.run({ environment: activeHandle, source, code: 'answer' }), /already running/)
  workers.at(-1).reply()
  await blocked
  await owner.reconfigure({ ...options })
  assert.equal(owner.environments.size, 1)
  t.mock.timers.tick(CONSOLE_IDLE_MS)
  assert.equal(owner.environments.size, 0)
  await flushStops()
  assert.equal(workers[0].terminated, true)
  for (let index = 0; index < 4; index++) {
    const pending = owner.run({ source, code: 'answer' })
    workers.at(-1).reply()
    await pending
  }
  await assert.rejects(owner.run({ source, code: 'answer' }), /too many/)
  await owner.reconfigure({ ...options, maxOutputBytes: 2048 })
  assert.equal(owner.environments.size, 0)
  const overflow = owner.run({ source, code: 'answer' })
  workers.at(-1).stdout.emit('data', Buffer.alloc(4096))
  assert.match((await overflow).error, /output limit/)
  for (const message of [null, {}, { id: 1 }, { id: 1, output: 'x'.repeat(3000) }, { fatal: true, error: 'failed' }]) {
    const pending = owner.run({ source, code: 'answer' })
    workers.at(-1).emit('message', message)
    if (message && !message.fatal && message.id !== 1) workers.at(-1).emit('error', new Error('transport failed'))
    assert.equal((await pending).environment, null)
  }
  const terminated = owner.run({ source, code: 'answer' })
  workers.at(-1).emit('exit', null, 'SIGKILL')
  assert.match((await terminated).error, /code null, signal SIGKILL/)
  const controller = new AbortController()
  const stopped = owner.run({ source, code: 'answer' }, controller.signal)
  controller.abort()
  assert.equal((await stopped).error, 'stopped')
  const timedOut = owner.run({ source, code: 'answer' })
  t.mock.timers.tick(options.maxWallMs)
  assert.match((await timedOut).error, /timed out/)
  const waiting = owner.run({ source, code: 'answer' })
  workers.at(-1).reply()
  const handle = (await waiting).environment
  workers.at(-1).postMessage = () => { throw new Error('post failed') }
  assert.match((await owner.run({ environment: handle, source, code: 'answer' })).error, /post failed/)
  owner.release('missing')
})
