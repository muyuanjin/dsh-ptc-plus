import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { normalizeBindingDescriptors } from '../internal/binding-descriptors.js'
import { outputFenceMarker } from '../internal/worker-output-fence.js'
import {
  failUnmatchedOutput,
  isCellActive,
  sessionCellExecutor,
} from './runtime-observation.js'

const behaviors = []
let workerCreated

class FakePort extends EventEmitter {
  constructor(worker, behavior) {
    super()
    this.worker = worker
    this.behavior = behavior
    this.runId = undefined
    this.runMessage = undefined
    this.outputFence = undefined
  }

  emit(event, message, ...rest) {
    if (event === 'message' && message?.type === 'done' && this.outputFence !== undefined) {
      message = { ...message, outputFence: this.outputFence }
    }
    const emitted = super.emit(event, message, ...rest)
    if (event === 'message' && message?.type === 'done' && this.outputFence !== undefined) {
      this.worker.stdout.emit('data', outputFenceMarker(this.outputFence, 'stdout', 'end'))
      this.worker.stderr.emit('data', outputFenceMarker(this.outputFence, 'stderr', 'end'))
      this.outputFence = undefined
    }
    return emitted
  }

  postMessage(message) {
    if (message.type === 'prepare') {
      if (this.behavior === 'prepare-post-error') throw new Error('private port rejected prepare message')
      queueMicrotask(() => this.emit('message', { type: 'ready', id: message.id }))
      return
    }
    if (message.type === 'run') {
      if (this.behavior === 'post-error') throw new Error('private port rejected run message')
      this.runId = message.id
      this.runMessage = message
      this.outputFence = message.outputFence
      queueMicrotask(() => {
        this.emit('message', { type: 'output-start', id: message.id, outputFence: message.outputFence })
        this.worker.stdout.emit('data', outputFenceMarker(message.outputFence, 'stdout', 'start'))
        this.worker.stderr.emit('data', outputFenceMarker(message.outputFence, 'stderr', 'start'))
      })
      return
    }
    if (message.type === 'output-start-ack') {
      const runMessage = this.runMessage
      if (runMessage !== undefined && message.id === runMessage.id
        && message.outputFence === runMessage.outputFence) {
        this.runMessage = undefined
        queueMicrotask(() => this.start(runMessage))
      }
      return
    }
    if (message.type === 'reply') {
      queueMicrotask(() => this.done())
    }
  }

  start(message) {
    const base = {
      type: 'done', id: message.id, logs: [], durability: 'durable', committedRedeclarations: [],
      activatedUserBindings: [], userBindingFailures: [], userBindingNames: [],
      rootBindingFacts: [],
    }
    if (this.behavior === 'invalid-durability') {
      this.emit('message', { ...base, durability: 'invalid', hasValue: false })
    } else if (this.behavior === 'invalid-legacy-shadow' || this.behavior === 'missing-legacy-activation') {
      this.emit('message', { ...base, hasValue: false,
        shadowedUserBindings: this.behavior === 'invalid-legacy-shadow' ? ['unknown'] : [] })
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
    } else if (this.behavior === 'invalid-user-bindings') {
      this.emit('message', { ...base, hasValue: false, activatedUserBindings: true })
    } else if (this.behavior === 'unknown-user-binding-entry') {
      this.emit('message', { ...base, hasValue: false, activatedUserBindings: ['unknown'] })
    } else if (this.behavior === 'missing-user-binding-names') {
      const { userBindingNames: _names, ...missing } = base
      this.emit('message', { ...missing, hasValue: false })
    } else if (this.behavior === 'malformed-user-binding-names') {
      this.emit('message', { ...base, hasValue: false, userBindingNames: [{ name: 'globalHelpers' }] })
    } else if (this.behavior === 'incomplete-user-binding-names') {
      this.emit('message', {
        ...base, hasValue: false, activatedUserBindings: ['global'], userBindingNames: [],
      })
    } else if (this.behavior === 'invalid-user-binding-ownership') {
      this.emit('message', {
        ...base,
        hasValue: false,
        activatedUserBindings: ['global'],
        userBindingNames: [{ name: 'globalHelpers', state: 'provider', entryId: 'other' }],
      })
    } else if (this.behavior === 'invalid-user-binding-failures') {
      this.emit('message', {
        ...base, hasValue: false, activatedUserBindings: ['global'], userBindingFailures: 'none',
      })
    } else if (this.behavior === 'omitted-user-binding-outcomes') {
      this.emit('message', {
        ...base, hasValue: false, activatedUserBindings: [], userBindingNames: [],
      })
    } else if (this.behavior === 'activated-request-owned-user-binding') {
      this.emit('message', {
        ...base, hasValue: false, activatedUserBindings: ['api-entry'], userBindingNames: [],
      })
    }
  }

  done() {
    this.emit('message', {
      type: 'done', id: this.runId, logs: [], durability: 'durable', hasValue: false,
      committedRedeclarations: [], activatedUserBindings: [], userBindingFailures: [],
      userBindingNames: [],
      rootBindingFacts: [],
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
    this.sampleUtilization = async () => this.performance.eventLoopUtilization()
    if (this.behavior === 'stderr-then-exit') {
      queueMicrotask(() => {
        this.stderr.emit('data', Buffer.from('V8 crash\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'))
        this.emit('exit', null, 'SIGABRT')
      })
      return
    }
    const ready = () => {
      if (this.behavior === 'error-before-ready') this.emit('error', new Error('startup error event'))
      else if (this.behavior === 'exit-before-ready') this.emit('exit', 9)
      else if (this.behavior === 'startup-error') this.emit('message', { type: 'startup-error', error: 'worker startup rejected' })
      else if (this.behavior === 'invalid-channel') this.emit('message', { type: 'ready', port: {} })
      else this.emit('message', { type: 'ready', port: new FakePort(this, this.behavior) })
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

        async dispose() {
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
      },
    },
  })
  t.mock.module('node:worker_threads', {
    namedExports: {
      parentPort: {},
      workerData: { cwd: 'relative' },
    },
  })
  const { SessionRuntime } = await import('../internal/session-runtime.js')

  for (const behavior of ['error-before-ready', 'exit-before-ready', 'startup-error', 'invalid-channel']) {
    behaviors.push(behavior)
    const runtime = new SessionRuntime()
    const result = await runtime.run(behavior, { program: 'return 1', bindings: [] })
    assert.equal(result.error.kind, 'worker-exit')
    await runtime.dispose()
  }

  behaviors.push('pending')
  const unmatched = new SessionRuntime()
  const unmatchedResult = unmatched.run('active-unmatched-output', {
    program: 'await new Promise(() => {})', bindings: [],
  })
  while (!isCellActive(unmatched, 'active-unmatched-output')) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(failUnmatchedOutput(
    unmatched,
    'active-unmatched-output',
    'worker output attribution failed: prior physical round',
  ), true)
  const failedUnmatched = await unmatchedResult
  assert.equal(failedUnmatched.error.kind, 'worker-exit')
  assert.match(failedUnmatched.error.message, /prior physical round/u)
  await unmatched.dispose()

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

  for (const [behavior, type] of [['post-error', 'run'], ['prepare-post-error', 'prepare']]) {
    behaviors.push(behavior)
    const postError = new SessionRuntime()
    const postErrorResult = await postError.run(behavior, { program: 'return 1', bindings: [] })
    assert.equal(postErrorResult.error.kind, 'worker-exit')
    assert.match(postErrorResult.error.message, new RegExp(`private port rejected ${type} message`))
    await postError.dispose()
  }

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
  assert.match(stderrResult.error.message, /code null, signal SIGABRT/)
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

  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'global', name: 'globalHelpers', scope: 'namespace', purpose: '', enabled: true,
    source: 'export const value = 1',
  }] })

  for (const behavior of ['invalid-legacy-shadow', 'missing-legacy-activation']) {
    behaviors.push(behavior)
    const runtime = new SessionRuntime()
    assert.equal((await runtime.run(behavior, { program: 'return 1', bindings: [] })).error, undefined)
    const replay = normalizeJournal({ version: 3, bindingMode: 'loose',
      rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
      status: 'durable', calls: [], operations: [], confirms: [], diagnostics: [],
      completion: { kind: 'return', hasValue: false } })
    const result = await sessionCellExecutor(runtime, behavior).executeCell({
      program: 'return 1', bindings: [], bindingDescriptors: normalizeBindingDescriptors([]), userBindings,
    }, replay)
    assert.match(result.error.message, behavior === 'invalid-legacy-shadow'
      ? /invalid shadowed user binding set/ : /recorded user bindings could not be reactivated/)
    await runtime.dispose()
  }

  behaviors.push('invalid-user-bindings')
  const invalidUserBindings = new SessionRuntime()
  const invalidUserBindingsResult = await invalidUserBindings.run('invalid-user-bindings', {
    program: 'return 1', bindings: [], userBindings,
  })
  assert.equal(invalidUserBindingsResult.error.kind, 'worker-exit')
  assert.match(invalidUserBindingsResult.error.message, /invalid activated user binding set/)
  await invalidUserBindings.dispose()

  // Every completion carries closed per-name source facts and a complete
  // activation partition; each injected fault must fail at its own check.
  for (const [behavior, expected, options = {}] of [
    ['unknown-user-binding-entry', /activated an unknown user binding entry/, { userBindings }],
    ['missing-user-binding-names', /invalid user binding name evidence/],
    ['malformed-user-binding-names', /invalid user binding name evidence/],
    ['incomplete-user-binding-names', /incomplete user binding name evidence/, { userBindings }],
    ['invalid-user-binding-ownership', /user binding name evidence with invalid ownership/, { userBindings }],
    ['invalid-user-binding-failures', /invalid user binding failures/, { userBindings }],
    ['omitted-user-binding-outcomes', /omitted user binding activation outcomes/, { userBindings }],
    ['activated-request-owned-user-binding', /activated a request-owned user binding name/, {
      userBindings: createUserBindingsSnapshot({ entries: [{
        id: 'api-entry', name: 'api', scope: 'namespace', purpose: '', enabled: true,
        source: 'export const value = 1',
      }] }),
      bindings: [{ global: 'api', functions: { call: async () => null } }],
    }],
  ]) {
    behaviors.push(behavior)
    const runtime = new SessionRuntime()
    const result = await runtime.run(behavior, {
      program: 'return 1', bindings: options.bindings ?? [], userBindings: options.userBindings,
    })
    assert.equal(result.error.kind, 'worker-exit')
    assert.match(result.error.message, expected)
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

  await assert.rejects(import('../internal/user-binding-runner.js'), /absolute cwd/)

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
