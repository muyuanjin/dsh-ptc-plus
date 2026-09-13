import { parentPort, workerData } from 'node:worker_threads'
import { constants, createContext, runInContext } from 'node:vm'

// Native modules execute in the worker's main realm. Isolate the entire
// oracle from the test runner, while retaining both that realm and the source
// VM realm used by the REPL. Native loader rejections are recorded separately
// from the source completion rather than leaking into unrelated test cases.
const unhandled = []
process.on('unhandledRejection', error => unhandled.push({ name: error.name, message: error.message }))
const context = createContext()
const then = runInContext('Promise.prototype.then', context)
const completion = runInContext(`(async function(){${workerData.source}})()`, context, {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
})
Object.defineProperty(completion, 'constructor', { value: undefined })
Reflect.apply(then, completion, [value => {
  setImmediate(() => parentPort.postMessage({ value, unhandled }))
}, error => { throw error }])
