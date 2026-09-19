import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { create as createDomain } from 'node:domain'
import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { prepareConsoleProgram } from './compiler-service.js'
import { createStatefulRootRuntime } from './stateful-root-runtime.js'
import { managedModuleImport, managedRequire, readModuleImport } from './stateful-module-runtime.js'
import { compileStatefulModule, createUserModuleCompilationHooks } from './stateful-module-compiler.js'
import { USER_BINDING_TRANSFORM } from './module-transform-contract.js'
import { moduleRuntimeIntrinsics } from './compiler-intrinsics.js'
import { stringifyCompilerData } from './compiler-data.js'
import { createCellCompletionObserver } from './cell-completion.js'
import { WORKER_SHUTDOWN_ACKNOWLEDGEMENT, WORKER_SHUTDOWN_REQUEST } from './worker-shutdown.js'
import { WORKER_REPL_OPTIONS, createWorkerControlPromise, disableWorkerReplDomain,
  captureWorkerReplGlobals, restoreWorkerReplGlobals, runInWorkerReplRealm,
  workerReplContext } from './worker-repl-realm.js'

const { Object, Set, setHas, setAdd, setDelete, appendArray } = moduleRuntimeIntrinsics
const Promise = globalThis.Promise
const process = globalThis.process
const hasProperty = globalThis.Reflect.has
const ControlPromise = createWorkerControlPromise()

const evaluations = new AsyncLocalStorage()
const context = globalThis
const completionObserver = createCellCompletionObserver(runInWorkerReplRealm('Function'))
context.console = console
let retainedEvaluator
const completionKey = `__ptc_console_${randomUUID().replaceAll('-', '')}`
Object.defineProperty(context, completionKey, { value: value => {
  evaluations.getStore().completed = true
  return value
} })
const parentUrl = pathToFileURL(resolve(workerData.cwd, 'ptc-plus-console')).href
let moduleUrl
let replParent
let replModuleRealm
const adapterParents = new Set()
const knownBindings = new Set()
const roots = createStatefulRootRuntime({
  importModule: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm),
  errors: runInWorkerReplRealm('({ ReferenceError, TypeError })'),
  dynamicIntrinsics: runInWorkerReplRealm('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})'),
  readAmbient: name => runInWorkerReplRealm(name),
  typeofAmbient: name => runInWorkerReplRealm(`typeof ${name}`),
  writeAmbient(name, value, strict) {
    const argument = name === '__ptc_value' ? '__ptc_other_value' : '__ptc_value'
    runInWorkerReplRealm(`${strict ? '"use strict";' : ''}(${argument}) => (${name} = ${argument})`)(value)
  },
  deleteAmbient: name => runInWorkerReplRealm(`delete ${name}`),
  hasAmbient: name => hasProperty(context, name),
  publish: name => setAdd(knownBindings, name),
})
class ConsoleReturn {
  constructor(value) { this.value = value }
}
const moduleCompilation = createUserModuleCompilationHooks({
  transformForParent: parent => parent === replParent || parent === parentUrl ? USER_BINDING_TRANSFORM : undefined,
})
const providedRequire = managedRequire(parentUrl, createRequire(parentUrl))
Object.defineProperty(context, 'require', { configurable: true, value: providedRequire })
const importCanary = 'data:text/javascript,export default 1'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === importCanary) replParent = context.parentURL
  return moduleCompilation.resolve(specifier, context, (selected, original) =>
    nextResolve(selected, original.parentURL === moduleUrl || original.parentURL === replParent || setHas(adapterParents, original.parentURL)
      ? { ...original, parentURL: parentUrl } : original))
}, load: moduleCompilation.load })
const describe = value => inspect(value, {
  colors: false, customInspect: false, getters: false, depth: 4,
  maxArrayLength: 40, maxStringLength: Math.min(workerData.maxOutputBytes, 8192), breakLength: 100,
})
process.on('uncaughtException', error => {
  const state = evaluations.getStore()
  if (state?.finish(true, error) === true || state?.settled === true) return
  parentPort.postMessage({ fatal: true, error: describe(error) })
})

function evaluate(source) {
  const prepared = prepareConsoleProgram(source, { languageSemantics: 'stateful-v1', knownBindings })
  const helpers = [prepared.rootRuntimeName, prepared.returnSignal]
  Object.defineProperty(context, prepared.rootRuntimeName, {
    configurable: true, value: roots.begin({ ...prepared.rootBindings, committed: () => {} }),
  })
  Object.defineProperty(context, prepared.returnSignal, { configurable: true, value: ConsoleReturn })
  if (prepared.moduleLoads.length === 0) {
    const operation = evaluatePrepared(prepared.code, prepared.asyncCompletion)
    return new ControlPromise((resolve, reject) => operation.then(
      value => { removeHelpers(helpers); resolve(value) },
      error => { removeHelpers(helpers); reject(error) },
    ))
  }
  return evaluateWithModules(prepared, helpers)
}

function removeHelpers(helpers) {
  for (let index = 0; index < helpers.length; index++) delete context[helpers[index]]
}

async function evaluateWithModules(prepared, helpers) {
  try {
    for (let index = 0; index < prepared.moduleLoads.length; index++) {
      const load = prepared.moduleLoads[index]
      let attributes = ''
      const entries = Object.entries(load.options?.with ?? {})
      for (let entry = 0; entry < entries.length; entry++) {
        attributes += `${entry === 0 ? ' with {' : ','}${stringifyCompilerData(entries[entry][0])}:${stringifyCompilerData(entries[entry][1])}`
      }
      if (entries.length > 0) attributes += '}'
      const source = stringifyCompilerData(load.source)
      let required
      if (load.requiredExports !== undefined) {
        required = ''
        for (let entry = 0; entry < load.requiredExports.length; entry++) {
          required += `${entry === 0 ? '' : ','}${stringifyCompilerData(load.requiredExports[entry])} as __required_${entry}`
        }
      }
      const adapter = `data:text/javascript,${encodeURIComponent(`import * as namespace from ${source}${attributes};\n${required === undefined ? '' : `export { ${required} } from ${source}${attributes};`}\nexport { namespace };`)}#console-${randomUUID()}`
      setAdd(adapterParents, adapter)
      moduleCompilation.mark(adapter, { compiled: true })
      let namespace
      try {
        const native = await import(adapter)
        namespace = readModuleImport(adapter, load.source, null, () => native.namespace, load.options?.with)
      } finally { setDelete(adapterParents, adapter) }
      if (load.global !== undefined) {
        appendArray(helpers, load.global)
        Object.defineProperty(context, load.global, { configurable: true, value: namespace })
      }
    }
    return await evaluatePrepared(prepared.code, prepared.asyncCompletion)
  } finally {
    removeHelpers(helpers)
  }
}

function evaluatePrepared(javascript, asyncCompletion = false) {
  releaseRetainedEvaluator()
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const workerGlobalBaseline = captureWorkerReplGlobals(context)
  const server = repl.start({ input, output, terminal: false, prompt: '', ...WORKER_REPL_OPTIONS })
  workerReplContext(server)
  restoreWorkerReplGlobals(workerGlobalBaseline, context)
  Object.defineProperty(context, 'require', { configurable: true, value: providedRequire })
  const errorDomain = disableWorkerReplDomain(server.eval.domain ?? createDomain())
  const evaluator = { server, input, output, errorDomain }
  retainedEvaluator = evaluator
  return new ControlPromise((resolve, reject) => {
    const complete = `this[${stringifyCompilerData(completionKey)}]`
    // Preserve expression results while distinguishing rejection with null/undefined.
    const code = `${javascript}\n;{let completed = ${complete}();}\n;`
    let settled = false
    const state = { completed: false, finish(failed, value) {
      if (settled) return false
      settled = true
      state.settled = true
      if (failed && value instanceof ConsoleReturn) completionObserver.settle(value.value, resolve, reject)
      else if (failed) reject(value)
      else completionObserver.settle(value, resolve, reject)
      return true
    } }
    evaluator.state = state
    errorDomain.on('error', error => state.finish(true, error))
    evaluations.run(state, () => errorDomain.run(() => {
      server.eval(`${code}\n`, context, 'ptc-plus-console', (error, value) => {
        if (asyncCompletion && (error === null || error === undefined)) {
          completionObserver.observe(value, value => state.finish(false, value), error => state.finish(true, error))
          return
        }
        const failed = !state.completed || error !== null && error !== undefined
        state.finish(failed, failed ? error : value)
      })
    }))
  })
}

function releaseRetainedEvaluator() {
  const evaluator = retainedEvaluator
  if (evaluator === undefined) return undefined
  retainedEvaluator = undefined
  evaluator.errorDomain.removeAllListeners('error')
  evaluator.server.close()
  evaluator.input.destroy()
  evaluator.output.destroy()
}
try {
  replModuleRealm = await evaluatePrepared('({Promise,stringify:value=>`${value}`,importModule:(source,options)=>import(source,options)})')
  const prepared = compileStatefulModule(workerData.source)
  moduleUrl = `data:text/javascript,${encodeURIComponent(prepared.code)}#binding`
  moduleCompilation.mark(moduleUrl, { compiled: true, moduleInterface: prepared.moduleInterface, sourceRegions: prepared.sourceRegions })
  const namespace = await managedModuleImport(moduleUrl, moduleUrl)
  await evaluatePrepared(`import(${stringifyCompilerData(importCanary)})`)
  const names = Object.keys(namespace)
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    setAdd(knownBindings, name)
    Object.defineProperty(context, name, { configurable: true, enumerable: true, get: () => namespace[name] })
  }
  parentPort.on('message', (message) => {
    if (message?.type === WORKER_SHUTDOWN_REQUEST) {
      // Release the realm, REPL and domain this console owns, then report the
      // release before the host gives up on the thread; see worker-shutdown.js.
      releaseRetainedEvaluator()
      parentPort.postMessage({ type: WORKER_SHUTDOWN_ACKNOWLEDGEMENT })
      parentPort.close()
      return
    }
    const { id, code } = message
    const send = result => {
      const flushed = new ControlPromise(resolve => process.stdout.write('', () => process.stderr.write('', resolve)))
      moduleRuntimeIntrinsics.observeOwnedPromise(flushed, () => {
        parentPort.postMessage(result)
        releaseRetainedEvaluator()
      /* c8 ignore next 3 -- flushed has no reject capability */
      }, error => {
        releaseRetainedEvaluator()
        parentPort.postMessage({ id, error: describe(error) })
      })
    }
    let operation
    try {
      operation = evaluate(code)
    } catch (error) {
      send({ id, error: describe(error) })
      return
    }
    moduleRuntimeIntrinsics.observeOwnedPromise(operation,
      value => send({ id, output: describe(value) }),
      error => send({ id, error: describe(error) }))
  })
} catch (error) {
  parentPort.postMessage({ fatal: true, error: describe(error) })
}
