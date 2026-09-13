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
import { runInContext } from 'node:vm'
import { prepareConsoleProgram } from './compiler-service.js'
import { createStatefulRootRuntime } from './stateful-root-runtime.js'
import { managedModuleImport, managedRequire, readModuleImport } from './stateful-module-runtime.js'
import { compileStatefulModule, createUserModuleCompilationHooks } from './stateful-module-compiler.js'
import { USER_BINDING_TRANSFORM } from './module-transform-contract.js'
import { moduleRuntimeIntrinsics } from './compiler-intrinsics.js'
import { stringifyCompilerData } from './compiler-data.js'
import { createCellCompletionObserver } from './cell-completion.js'

const { Object, Set, setHas, setAdd, setDelete, appendArray } = moduleRuntimeIntrinsics

const output = new PassThrough()
output.resume()
const evaluations = new AsyncLocalStorage()
const server = repl.start({
  input: new PassThrough(), output, terminal: false, prompt: '', useGlobal: false,
  writer(error) { evaluations.getStore()?.finish(true, error); return '' },
})
const completionObserver = createCellCompletionObserver(runInContext('Function', server.context))
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
let replModuleRealm
const adapterParents = new Set()
const knownBindings = new Set()
const roots = createStatefulRootRuntime({
  importModule: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm),
  errors: runInContext('({ ReferenceError, TypeError })', server.context),
  dynamicIntrinsics: runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', server.context),
  readAmbient: name => runInContext(name, server.context),
  typeofAmbient: name => runInContext(`typeof ${name}`, server.context),
  writeAmbient(name, value, strict) {
    const argument = name === '__ptc_value' ? '__ptc_other_value' : '__ptc_value'
    runInContext(`${strict ? '"use strict";' : ''}(${argument}) => (${name} = ${argument})`, server.context)(value)
  },
  deleteAmbient: name => runInContext(`delete ${name}`, server.context),
  hasAmbient: name => Reflect.has(server.context, name),
  publish: name => setAdd(knownBindings, name),
})
class ConsoleReturn {
  constructor(value) { this.value = value }
  static complete() { evaluations.getStore().completed = true }
}
const moduleCompilation = createUserModuleCompilationHooks({
  transformForParent: parent => parent === replParent || parent === parentUrl ? USER_BINDING_TRANSFORM : undefined,
})
server.context.require = managedRequire(parentUrl, createRequire(parentUrl))
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

async function evaluate(source) {
  const prepared = prepareConsoleProgram(source, { languageSemantics: 'stateful-v1', knownBindings })
  const helpers = [prepared.rootRuntimeName, prepared.returnSignal]
  Object.defineProperty(server.context, prepared.rootRuntimeName, {
    configurable: true, value: roots.begin({ ...prepared.rootBindings, committed: () => {} }),
  })
  Object.defineProperty(server.context, prepared.returnSignal, { configurable: true, value: ConsoleReturn })
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
        Object.defineProperty(server.context, load.global, { configurable: true, value: namespace })
      }
    }
    return await evaluatePrepared(prepared.code, prepared.asyncCompletion)
  } finally {
    for (let index = 0; index < helpers.length; index++) delete server.context[helpers[index]]
  }
}

function evaluatePrepared(javascript, asyncCompletion = false) {
  return new Promise((resolve, reject) => {
    const complete = `this[${stringifyCompilerData(completionKey)}]`
    // Preserve expression results while distinguishing rejection with null/undefined.
    const code = `${javascript}\n;{let completed = ${complete}();}\n;`
    let settled = false
    const state = { completed: false, finish(failed, value) {
      if (settled) return
      settled = true
      if (failed && value instanceof ConsoleReturn) completionObserver.settle(value.value, resolve, reject)
      else if (failed) reject(value)
      else completionObserver.settle(value, resolve, reject)
    } }
    evaluations.run(state, () => errorDomain.run(() => {
      server.eval(`${code}\n`, server.context, 'ptc-plus-console', (error, value) => {
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
    Object.defineProperty(server.context, name, { configurable: true, enumerable: true, get: () => namespace[name] })
  }
  parentPort.on('message', async ({ id, code }) => {
    let result
    try {
      const value = await evaluate(code)
      result = { id, output: describe(value) }
    } catch (error) {
      result = { id, error: describe(error) }
    }
    await new Promise(resolve => process.stdout.write('', () => process.stderr.write('', resolve)))
    parentPort.postMessage(result)
  })
} catch (error) {
  parentPort.postMessage({ fatal: true, error: describe(error) })
}
