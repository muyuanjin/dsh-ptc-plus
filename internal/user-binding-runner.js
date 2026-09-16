import { registerHooks } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { encodeValue } from './value-wire.js'
import { managedModuleImport } from './stateful-module-runtime.js'
import { compileStatefulModule, createUserModuleCompilationHooks } from './stateful-module-compiler.js'
import { WORKER_SHUTDOWN_ACKNOWLEDGEMENT, WORKER_SHUTDOWN_REQUEST } from './worker-shutdown.js'

if (parentPort === null) throw new Error('user binding runner requires a parent port')
const candidateCwd = workerData.cwd
if (typeof candidateCwd !== 'string' || !isAbsolute(candidateCwd)) {
  /* c8 ignore next */
  throw new Error('user binding runner requires an absolute cwd')
}
const candidateParent = pathToFileURL(resolve(candidateCwd, 'ptc-plus-bindings-candidate')).href
let candidateUrl
const moduleCompilation = createUserModuleCompilationHooks()
registerHooks({
  resolve(specifier, context, nextResolve) {
    return moduleCompilation.resolve(specifier, context, (selected, original) =>
      nextResolve(selected, original.parentURL === candidateUrl
        ? { ...original, parentURL: candidateParent } : original))
  },
  load: moduleCompilation.load,
})

parentPort.on('message', (message) => {
  if (message?.type !== WORKER_SHUTDOWN_REQUEST) return
  parentPort.postMessage({ type: WORKER_SHUTDOWN_ACKNOWLEDGEMENT })
  parentPort.close()
})

try {
  const prepared = compileStatefulModule(workerData.source)
  candidateUrl = `data:text/javascript,${encodeURIComponent(prepared.code)}#candidate`
  moduleCompilation.mark(candidateUrl, { compiled: true, moduleInterface: prepared.moduleInterface, sourceRegions: prepared.sourceRegions })
  const namespace = await managedModuleImport(candidateUrl, candidateUrl)
  let value = { symbols: Object.keys(namespace).sort() }
  if (workerData.invocation !== undefined) {
    const { symbol, args } = workerData.invocation
    if (!Object.hasOwn(namespace, symbol) || typeof namespace[symbol] !== 'function') {
      throw new TypeError(`candidate export ${JSON.stringify(symbol)} is not callable`)
    }
    value = await namespace[symbol](...args)
  }
  parentPort.postMessage({ ok: true, value: encodeValue(value, workerData.valueLimits) })
  // The result is delivered; nothing this worker owns may keep it alive now.
  parentPort.unref()
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
  parentPort.unref()
}
