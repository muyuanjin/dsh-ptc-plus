import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

const behaviors = []
let workerCreated

class FakePort extends EventEmitter {
  constructor(behavior) {
    super()
    this.behavior = behavior
    this.runId = undefined
  }

  postMessage(message) {
    if (message.type === 'run') {
      if (this.behavior === 'post-error') throw new Error('private port rejected run message')
      this.runId = message.id
      queueMicrotask(() => this.start(message))
      return
    }
    if (message.type === 'reply') {
      queueMicrotask(() => this.done())
    }
  }

  start(message) {
    const base = {
      type: 'done', id: message.id, logs: [], durability: 'durable', committedRedeclarations: [],
    }
    if (this.behavior === 'invalid-durability') {
      this.emit('message', { ...base, durability: 'invalid', hasValue: false })
    } else if (this.behavior === 'missing-commits') {
      const { committedRedeclarations: _committed, ...missing } = base
      this.emit('message', { ...missing, hasValue: false })
    } else if (this.behavior === 'malformed-commits') {
      this.emit('message', { ...base, committedRedeclarations: true, hasValue: false })
    } else if (this.behavior === 'unknown-commit') {
      this.emit('message', { ...base, committedRedeclarations: ['unknown'], hasValue: false })
    } else if (this.behavior === 'duplicate-commit') {
      this.emit('message', { ...base, committedRedeclarations: ['x', 'x'], hasValue: false })
    } else if (this.behavior === 'oversized-completion') {
      this.emit('message', { ...base, logs: ['too large'], hasValue: false })
    } else if (this.behavior === 'invalid-envelope') {
      this.emit('message', { ...base, hasValue: 'yes' })
    } else if (this.behavior === 'invalid-logs') {
      this.emit('message', { ...base, logs: [1], hasValue: false })
    } else if (this.behavior === 'error-without-name') {
      this.emit('message', { ...base, error: 'plain failure' })
    } else if (this.behavior === 'error-empty-name') {
      this.emit('message', { ...base, error: 'plain failure', errorName: '' })
    } else if (this.behavior === 'unknown-binding') {
      this.emit('message', { type: 'call', runId: message.id, id: 1, global: 'missing', member: 'call', args: { codec: 'ptc-value-graph/v1', root: null, nodes: [] } })
    } else if (this.behavior === 'invalid-args') {
      this.emit('message', { type: 'call', runId: message.id, id: 1, global: 'api', member: 'call', args: { invalid: true } })
    } else if (this.behavior === 'expired-lease') {
      this.emit('message', { type: 'call', runId: message.id + 1, id: 1, global: 'api', member: 'call', args: { codec: 'ptc-value-graph/v1', root: null, nodes: [] } })
    }
  }

  done() {
    this.emit('message', {
      type: 'done', id: this.runId, logs: [], durability: 'durable', hasValue: false,
      committedRedeclarations: [],
    })
  }

  close() {}
}

class FakeWorker extends EventEmitter {
  constructor() {
    super()
    this.behavior = behaviors.shift()
    this.stdout = Object.assign(new EventEmitter(), { resume() {} })
    this.stderr = Object.assign(new EventEmitter(), { resume() {} })
    this.performance = { eventLoopUtilization: () => ({ active: 0 }) }
    if (this.behavior === 'stderr-then-exit') {
      queueMicrotask(() => {
        this.stderr.emit('data', Buffer.from('V8 crash\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'))
        this.emit('exit', 134)
      })
      return
    }
    const ready = () => {
      if (this.behavior === 'error-before-ready') this.emit('error', new Error('startup error event'))
      else if (this.behavior === 'exit-before-ready') this.emit('exit', 9)
      else if (this.behavior === 'startup-error') this.emit('message', { type: 'startup-error', error: 'worker startup rejected' })
      else if (this.behavior === 'invalid-channel') this.emit('message', { type: 'ready', port: {} })
      else this.emit('message', { type: 'ready', port: new FakePort(this.behavior) })
    }
    workerCreated?.()
    if (this.behavior === 'delayed-ready') setTimeout(ready, 10)
    else queueMicrotask(ready)
  }

  terminate() {
    return Promise.resolve(0)
  }
}

test('fails closed for every worker startup and private-protocol fault', async (t) => {
  t.mock.module('node:worker_threads', { namedExports: { Worker: FakeWorker } })
  const { SessionRuntime } = await import('../internal/session-runtime.js')

  for (const behavior of ['error-before-ready', 'exit-before-ready', 'startup-error', 'invalid-channel']) {
    behaviors.push(behavior)
    const runtime = new SessionRuntime()
    const result = await runtime.run(behavior, { program: 'return 1', bindings: [] })
    assert.equal(result.error.kind, 'worker-exit')
    await runtime.dispose()
  }

  behaviors.push('invalid-durability')
  const durability = new SessionRuntime()
  assert.equal((await durability.run('invalid-durability', { program: 'return 1', bindings: [] })).error.kind, 'worker-exit')
  await durability.dispose()

  for (const behavior of ['missing-commits', 'malformed-commits', 'unknown-commit', 'duplicate-commit']) {
    behaviors.push(behavior)
    const runtime = new SessionRuntime()
    const result = await runtime.run(behavior, { program: 'return 1', bindings: [] })
    assert.equal(result.error.kind, 'worker-exit')
    assert.match(result.error.message, /invalid committed redeclaration set/)
    await runtime.dispose()
  }

  behaviors.push('post-error')
  const postError = new SessionRuntime()
  const postErrorResult = await postError.run('post-error', { program: 'return 1', bindings: [] })
  assert.equal(postErrorResult.error.kind, 'worker-exit')
  assert.match(postErrorResult.error.message, /private port rejected run message/)
  await postError.dispose()

  behaviors.push('oversized-completion')
  const oversized = new SessionRuntime({ maxOutputBytes: 8 })
  assert.equal((await oversized.run('oversized', { program: 'return 1', bindings: [] })).error.kind, 'output-limit')
  await oversized.dispose()

  behaviors.push('invalid-envelope')
  const envelope = new SessionRuntime()
  assert.equal((await envelope.run('invalid-envelope', { program: 'return 1', bindings: [] })).error.kind, 'invalid-output')
  await envelope.dispose()

  behaviors.push('invalid-logs')
  const invalidLogs = new SessionRuntime()
  assert.deepEqual((await invalidLogs.run('invalid-logs', { program: 'return 1', bindings: [] })).logs, [])
  await invalidLogs.dispose()

  behaviors.push('stderr-then-exit')
  const stderrExit = new SessionRuntime()
  const stderrResult = await stderrExit.run('stderr-exit', { program: 'return 1', bindings: [] })
  assert.equal(stderrResult.error.kind, 'worker-exit')
  assert.match(stderrResult.error.message, /last stderr: FATAL ERROR: Reached heap limit/)
  await stderrExit.dispose()

  behaviors.push('error-without-name')
  const unnamed = new SessionRuntime()
  assert.match((await unnamed.run('unnamed-error', { program: 'return 1', bindings: [] })).error.message, /uncaught Error/)
  await unnamed.dispose()

  behaviors.push('error-empty-name')
  const emptyName = new SessionRuntime()
  assert.match((await emptyName.run('empty-name-error', { program: 'return 1', bindings: [] })).error.message, /uncaught exception/)
  await emptyName.dispose()

  for (const behavior of ['unknown-binding', 'invalid-args', 'expired-lease']) {
    behaviors.push(behavior)
    const runtime = new SessionRuntime()
    const result = await runtime.run(behavior, {
      program: 'return 1',
      bindings: [{ global: 'api', functions: { call: async () => null } }],
    })
    assert.equal(result.error, undefined)
    await runtime.dispose()
  }

  behaviors.push('delayed-ready')
  let signalCreated
  const created = new Promise(resolve => { signalCreated = resolve })
  workerCreated = signalCreated
  const duringStartup = new SessionRuntime()
  const controller = new AbortController()
  const pending = duringStartup.run('abort-during-startup', {
    program: 'return 1', bindings: [], signal: controller.signal,
  })
  await created
  controller.abort('cancel startup')
  assert.equal((await pending).error.kind, 'abort')
  await duringStartup.dispose()
  workerCreated = undefined

  behaviors.push('normal')
  let checks = 0
  const racingSignal = {
    get aborted() { checks += 1; return checks >= 3 },
    reason: 'raced abort',
    addEventListener() {},
    removeEventListener() {},
  }
  const racing = new SessionRuntime()
  assert.equal((await racing.run('racing-abort', {
    program: 'return 1', bindings: [], signal: racingSignal,
  })).error.kind, 'abort')
  await racing.dispose()
})
