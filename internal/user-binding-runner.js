import { registerHooks } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { encodeValue } from './value-wire.js'
import { transformTypeScriptModule } from './typescript-transform.js'

if (parentPort === null) throw new Error('user binding runner requires a parent port')
const candidateCwd = workerData.cwd
if (typeof candidateCwd !== 'string' || !isAbsolute(candidateCwd)) {
  /* c8 ignore next */
  throw new Error('user binding runner requires an absolute cwd')
}
const candidateParent = pathToFileURL(resolve(candidateCwd, 'ptc-plus-bindings-candidate')).href
let candidateUrl
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, context.parentURL === candidateUrl
      ? { ...context, parentURL: candidateParent }
      : context)
  },
})

try {
  const javascript = transformTypeScriptModule(workerData.source)
  candidateUrl = `data:text/javascript,${encodeURIComponent(javascript)}#candidate`
  const namespace = await import(candidateUrl)
  let value = { symbols: Object.keys(namespace).sort() }
  if (workerData.invocation !== undefined) {
    const { symbol, args } = workerData.invocation
    if (!Object.hasOwn(namespace, symbol) || typeof namespace[symbol] !== 'function') {
      throw new TypeError(`candidate export ${JSON.stringify(symbol)} is not callable`)
    }
    value = await namespace[symbol](...args)
  }
  parentPort.postMessage({ ok: true, value: encodeValue(value, workerData.valueLimits) })
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
}
