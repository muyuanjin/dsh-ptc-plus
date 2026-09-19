import assert from 'node:assert/strict'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  WORKER_REPL_OPTIONS,
  captureWorkerReplGlobals,
  restoreWorkerReplGlobals,
  runInWorkerReplRealm,
  workerReplContext,
} from '../internal/worker-repl-realm.js'

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
