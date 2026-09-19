import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  WORKER_REPL_OPTIONS,
  captureWorkerReplGlobals,
  createWorkerReplErrorHandler,
  protectWorkerReplAsyncContext,
  restoreWorkerReplGlobals,
  runInWorkerReplRealm,
  workerReplContext,
} from '../internal/worker-repl-realm.js'

test('worker REPL protects only its platform AsyncLocalStorage receiver', () => {
  const scope = new AsyncLocalStorage()
  let evaluations = 0
  const server = { context: globalThis, eval(source, context, filename, callback) {
    evaluations++
    assert.equal(source, 'void 0\n')
    assert.equal(context, globalThis)
    assert.equal(filename, 'ptc-plus-repl-bootstrap')
    scope.run('bootstrap', () => callback(null))
  } }
  assert.equal(protectWorkerReplAsyncContext(server), true)
  assert.equal(evaluations, 1)
  const descriptors = Object.fromEntries(['getStore', 'enterWith', 'run'].map(name =>
    [name, Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, name)]))
  try {
    for (const name of Object.keys(descriptors)) AsyncLocalStorage.prototype[name] = null
    assert.equal(scope.run('private', () => scope.getStore()), 'private')
    for (const name of Object.keys(descriptors)) assert.equal(AsyncLocalStorage.prototype[name], null)
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      Object.defineProperty(AsyncLocalStorage.prototype, name, descriptor)
    }
  }
  assert.equal(protectWorkerReplAsyncContext(server), undefined)
  assert.equal(evaluations, 1)
})

test('worker REPL error handler settles only the active evaluation with the original value', () => {
  const scope = new AsyncLocalStorage()
  const handleError = createWorkerReplErrorHandler(scope, (finish, error) => finish(true, error))
  assert.equal(handleError(new Error('outside an evaluation')), 'unhandled')
  const marker = new Error('no formatting')
  Object.defineProperty(marker, 'stack', { get() { throw new Error('stack getter ran') } })
  for (const thrown of [marker, null, undefined, false, 0]) {
    let observed
    scope.run((failed, value) => { observed = { failed, value } }, () => {
      assert.equal(handleError(thrown), 'ignore')
    })
    assert.equal(observed.failed, true)
    assert.equal(observed.value, thrown)
  }
})

test('worker REPL helpers require and evaluate in the native Node realm', () => {
  assert.deepEqual(WORKER_REPL_OPTIONS, { useGlobal: true })
  assert.equal(Object.isFrozen(WORKER_REPL_OPTIONS), true)
  assert.equal(workerReplContext({ context: globalThis }), globalThis)
  assert.throws(() => workerReplContext({ context: {} }), /native global realm/)
  assert.equal(runInWorkerReplRealm('globalThis'), globalThis)
  assert.equal(runInWorkerReplRealm('Error'), Error)
})

test('worker REPL startup restores the exact native global surface', () => {
  const baseline = captureWorkerReplGlobals()
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const server = repl.start({ input, output, terminal: false, prompt: '', ...WORKER_REPL_OPTIONS })
  assert.equal(typeof globalThis.worker_threads, 'object')
  restoreWorkerReplGlobals(baseline)
  const restored = captureWorkerReplGlobals()
  assert.deepEqual([...restored].filter(([key]) => typeof key === 'string'),
    [...baseline].filter(([key]) => typeof key === 'string'))
  assert.equal(typeof globalThis.worker_threads, 'undefined')
  assert.throws(() => restoreWorkerReplGlobals(null), /baseline must be a Map/)
  server.close()
  input.destroy()
  output.destroy()
})

test('worker REPL cleanup rejects an undeletable added string global', () => {
  const globalObject = {}
  const baseline = captureWorkerReplGlobals(globalObject)
  Object.defineProperty(globalObject, 'injected', {
    configurable: false,
    enumerable: true,
    value: 1,
  })
  assert.throws(() => restoreWorkerReplGlobals(baseline, globalObject),
    /added a non-configurable global injected/)
})
