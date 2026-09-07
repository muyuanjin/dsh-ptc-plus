import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { create as createDomain } from 'node:domain'
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { parse } from 'acorn'
import { transformTypeScriptModule } from './typescript-transform.js'

const output = new PassThrough()
output.resume()
const evaluations = new AsyncLocalStorage()
const server = repl.start({
  input: new PassThrough(), output, terminal: false, prompt: '', useGlobal: false,
  writer(error) { evaluations.getStore()?.finish(true, error); return '' },
})
server.context.console = console
const errorDomain = server.eval.domain ?? createDomain()
errorDomain.removeAllListeners('error')
errorDomain.on('error', error => evaluations.getStore()?.finish(true, error))
const completionKey = `__ptc_console_${randomUUID().replaceAll('-', '')}`
Object.defineProperty(server.context, completionKey, { value: value => {
  evaluations.getStore().completed = true
  return value
} })
const parentUrl = pathToFileURL(resolve(workerData.cwd, 'ptc-plus-console')).href
let moduleUrl
let replParent
const importCanary = 'data:text/javascript,export default 1'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === importCanary) replParent = context.parentURL
  return nextResolve(specifier, context.parentURL === moduleUrl || context.parentURL === replParent
    ? { ...context, parentURL: parentUrl } : context)
} })
const describe = value => inspect(value, {
  colors: false, customInspect: false, getters: false, depth: 4,
  maxArrayLength: 40, maxStringLength: Math.min(workerData.maxOutputBytes, 8192), breakLength: 100,
})

function evaluate(source) {
  return new Promise((resolve, reject) => {
    const javascript = transformTypeScriptModule(source)
    const program = parse(javascript, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
    const last = program.body.at(-1)
    const complete = `this[${JSON.stringify(completionKey)}]`
    // Preserve expression results while distinguishing rejection with null/undefined.
    const code = last?.type === 'ExpressionStatement' && last.directive === undefined
      ? `${javascript.slice(0, last.expression.start)}${complete}(${javascript.slice(last.expression.start, last.expression.end)})${javascript.slice(last.expression.end)}`
      : `${javascript}\n;{let completed = ${complete}();}\n;`
    let settled = false
    const state = { completed: false, finish(failed, value) {
      if (settled) return
      settled = true
      if (failed) reject(value)
      else resolve(value)
    } }
    evaluations.run(state, () => errorDomain.run(() => {
      server.eval(`${code}\n`, server.context, 'ptc-plus-console', (error, value) => {
        const failed = !state.completed || error !== null && error !== undefined
        state.finish(failed, failed ? error : value)
      })
    }))
  })
}
try {
  const javascript = transformTypeScriptModule(workerData.source)
  moduleUrl = `data:text/javascript,${encodeURIComponent(javascript)}#binding`
  const namespace = await import(moduleUrl)
  await evaluate(`import(${JSON.stringify(importCanary)})`)
  for (const name of Object.keys(namespace)) Object.defineProperty(server.context, name, {
    configurable: true, enumerable: true, get: () => namespace[name],
  })
  parentPort.on('message', async ({ id, code }) => {
    let result
    try {
      const value = await evaluate(code)
      result = { id, output: describe(value) }
    } catch (error) {
      result = { id, error: describe(error) }
    }
    await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))))
    parentPort.postMessage(result)
  })
} catch (error) {
  parentPort.postMessage({ fatal: true, error: describe(error) })
}
