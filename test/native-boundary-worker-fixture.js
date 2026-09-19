import { parentPort, workerData } from 'node:worker_threads'
// The worker isolates each oracle from the test runner. Source and native
// modules execute in its main realm, matching the session kernel contract.
// Native loader rejections are recorded separately from the source completion
// rather than leaking into unrelated test cases.
const unhandled = []
process.on('unhandledRejection', error => unhandled.push({ name: error.name, message: error.message }))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const then = Promise.prototype.then
const completion = new AsyncFunction(workerData.source)()
Object.defineProperty(completion, 'constructor', { __proto__: null, value: undefined })
Reflect.apply(then, completion, [value => {
  setImmediate(() => parentPort.postMessage({ value, unhandled }))
}, error => { throw error }])
