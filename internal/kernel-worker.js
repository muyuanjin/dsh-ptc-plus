import { create as createDomain } from 'node:domain'
import { createRequire, registerHooks } from 'node:module'
import { managedModuleImport, managedRequire, readModuleImport, statefulModuleLink } from './stateful-module-runtime.js'
import { staticModuleLinkReference } from './compiler-module-links.js'
import { compileStatefulModule, createUserModuleCompilationHooks } from './stateful-module-compiler.js'
import { USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM } from './module-transform-contract.js'
import { isAbsolute, resolve } from 'node:path'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { formatWithOptions } from 'node:util'
import { MessageChannel, parentPort, workerData } from 'node:worker_threads'
import { synchronizeBuiltinEsmExports } from './builtin-esm-sync.js'
import { createPrivateAsyncLocalStorage } from './async-local-storage-intrinsics.js'
import { createExceptionOriginScope, errorDetails, messageOf, programBindingError } from './failure-reporting.js'
import { DURABLE_IMPORTS, FORBIDDEN_IMPORTS } from './module-policy.js'
import { decodeValue, encodeValue } from './value-wire.js'
import { LEGACY_USER_BINDINGS_REUSE_POLICY, LIVE_USER_BINDINGS_SHADOW_POLICY, normalizeUserBindingNames } from './session-journal-schema.js'
import { installWorkerCwdVirtualization } from './worker-cwd-virtualization.js'
import { createReplValueObserver, supportsAwaitLexicals, previewBindingValue } from './repl-value-observer.js'
import { createStatefulRootRuntime } from './stateful-root-runtime.js'
import { createNativeRootDynamic } from './native-root-dynamic.js'
import { moduleRuntimeIntrinsics } from './compiler-intrinsics.js'
import { compilerDescriptors } from './compiler-descriptors.js'
import { createCellCompletionObserver } from './cell-completion.js'
import { WORKER_SHUTDOWN_ACKNOWLEDGEMENT, WORKER_SHUTDOWN_REQUEST } from './worker-shutdown.js'
import { WORKER_REPL_OPTIONS, createWorkerControlPromise, createWorkerReplErrorHandler,
  createWorkerUncaughtExceptionHandler,
  disableWorkerReplDomain,
  captureWorkerReplGlobals, protectWorkerReplAsyncContext, restoreWorkerReplGlobals, runInWorkerReplRealm,
  workerReplContext } from './worker-repl-realm.js'
import { installProgramAmbientResolver } from './dynamic-environment-runtime.js'

const { Object, Map, Set, Proxy, Error,
  mapGet, mapSet, mapHas, mapDelete, mapClear, mapSize, mapForEach,
  setHas, setAdd, setDelete, setClear, setForEach,
  everyArray, someArray, appendArray, copyArray, join, Reflect: privateReflect, promiseResolve, promiseReject } = moduleRuntimeIntrinsics
const PublicPromise = globalThis.Promise
const jsonStringify = globalThis.JSON.stringify
const bufferByteLength = globalThis.Buffer.byteLength
const String = globalThis.String
const process = globalThis.process
const ControlPromise = createWorkerControlPromise()
const hasProperty = privateReflect.has

function mapArray(values, visit) {
  const result = []
  for (let index = 0; index < values.length; index++) appendArray(result, visit(values[index], index))
  return result
}

function filterArray(values, select) {
  const result = []
  for (let index = 0; index < values.length; index++) {
    if (select(values[index], index)) appendArray(result, values[index])
  }
  return result
}

function mapFromArray(values, visit) {
  const result = new Map()
  for (let index = 0; index < values.length; index++) {
    const entry = visit(values[index], index)
    mapSet(result, entry[0], entry[1])
  }
  return result
}

function setFromArray(values) {
  const result = new Set()
  for (let index = 0; index < values.length; index++) setAdd(result, values[index])
  return result
}

function mapKeysArray(value) {
  const result = []
  mapForEach(value, (_item, key) => appendArray(result, key))
  return result
}

function mapEntriesArray(value) {
  const result = []
  mapForEach(value, (item, key) => appendArray(result, [key, item]))
  return result
}

function mapValuesArray(value) {
  const result = []
  mapForEach(value, item => appendArray(result, item))
  return result
}

function setValuesArray(value) {
  const result = []
  setForEach(value, item => appendArray(result, item))
  return result
}

if (parentPort === null) throw new Error('ptc-plus kernel worker started without a parent port')
const { port1, port2: channel } = new MessageChannel()

const input = new PassThrough()
const output = new PassThrough()
output.resume()
const evaluationScope = createPrivateAsyncLocalStorage()
const sessionCwd = typeof workerData?.cwd === 'string' ? workerData.cwd : undefined
if (sessionCwd !== undefined && !isAbsolute(sessionCwd)) {
  throw new Error(`ptc-plus session cwd must be absolute, got ${jsonStringify(sessionCwd)}`)
}
const workerGlobalBaseline = captureWorkerReplGlobals()
const server = repl.start({
  input,
  output,
  terminal: false,
  prompt: '',
  ...WORKER_REPL_OPTIONS,
  handleError: createWorkerReplErrorHandler(evaluationScope, (finish, error) => finish(true, error)),
  ignoreUndefined: true,
})
protectWorkerReplAsyncContext(server)
const originalRequire = server.context.require
// domain.bind exposes its owner on a bound evaluator in older Node REPLs.
// Newer REPLs honor an explicitly entered domain. Capture before REPL error
// formatting can evaluate user-defined stack/name getters.
const errorDomain = disableWorkerReplDomain(server.eval.domain ?? createDomain())
errorDomain.removeAllListeners('error')
errorDomain.on('error', error => evaluationScope.getStore()?.(true, error))
const handleUncaughtException = createWorkerUncaughtExceptionHandler(evaluationScope, process)
process.on('uncaughtException', handleUncaughtException)
const context = workerReplContext(server)
restoreWorkerReplGlobals(workerGlobalBaseline, context)
const workerBaselineGlobals = setFromArray(mapKeysArray(workerGlobalBaseline))
const contextGlobal = runInWorkerReplRealm('globalThis')
const completionObserver = createCellCompletionObserver(runInWorkerReplRealm('Function'))
let replModuleRealm
const statefulRoots = createStatefulRootRuntime({
  refresh: name => refreshLegacyPublication(name),
  importModule: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm),
  errors: runInWorkerReplRealm('({ ReferenceError, TypeError })'),
  dynamicIntrinsics: runInWorkerReplRealm('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})'),
  readAmbient: name => runInWorkerReplRealm(name),
  typeofAmbient: name => runInWorkerReplRealm(`typeof ${name}`),
  canWriteAmbient: name => writableRootProperty(name),
  writeAmbient(name, value, strict) {
    const argument = name === '__ptc_value' ? '__ptc_other_value' : '__ptc_value'
    runInWorkerReplRealm(`${strict ? '"use strict";' : ''}(${argument}) => (${name} = ${argument})`)(value)
  },
  deleteAmbient: name => runInWorkerReplRealm(`delete ${name}`),
  hasAmbient: name => setHas(installedGlobals, name)
    ? mapGet(installedGlobalOriginals, name).descriptor !== undefined : hasProperty(context, name),
  // Request namespaces stay on globalThis; source declarations own separate
  // logical storage. Provider overlays retain their existing write-through.
  hasOverlay: name => setHas(installedGlobals, name) && mapGet(dynamicNamespaces, name)?.shadowable !== true,
  publish(name) {
    // Logical lexical identities do not redefine the global object's properties.
    if (mapHas(userBindingSources, name)) recordUserBindingAssignment(name)
  },
})
const nativeRootDynamic = createNativeRootDynamic({
  logicalReference: (name, writable) => statefulRoots.legacyReference(name, writable),
  intrinsics: runInWorkerReplRealm('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})'),
  importModule: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm),
  read: name => runInWorkerReplRealm(name),
  typeOf: name => runInWorkerReplRealm(`typeof ${name}`),
  write(name, value, strict) {
    const argument = name === '__ptc_value' ? '__ptc_other_value' : '__ptc_value'
    runInWorkerReplRealm(`${strict ? '"use strict";' : ''}(${argument}) => (${name} = ${argument})`)(value)
  },
  remove: name => runInWorkerReplRealm(`delete ${name}`),
})
let valueObserver
const REPL_IMPORT_CANARY = 'data:text/javascript,export default 1'
let replParent
const sessionReplParent = sessionCwd === undefined ? undefined : pathToFileURL(resolve(sessionCwd, 'repl')).href
const staticAdapterParents = new Set()
const userBindingModuleParents = new Map()
const userModuleCompilation = createUserModuleCompilationHooks({
  transformForParent: parent => (parent === replParent || parent === sessionReplParent) && activeExecution !== undefined
    ? activeExecution.moduleTransform : undefined,
})
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === REPL_IMPORT_CANARY && replParent === undefined) replParent = context.parentURL
    return userModuleCompilation.resolve(specifier, context, (source, resolvedContext) => {
      const userBindingParent = mapGet(userBindingModuleParents, resolvedContext.parentURL)
      return nextResolve(source, userBindingParent !== undefined
        ? { ...resolvedContext, parentURL: userBindingParent }
        : resolvedContext.parentURL === replParent || setHas(staticAdapterParents, resolvedContext.parentURL)
          ? { ...resolvedContext, parentURL: sessionReplParent ?? replParent }
          : resolvedContext)
    })
  },
  load: userModuleCompilation.load,
})
const logScope = createPrivateAsyncLocalStorage()
const userBindingActivationScope = createPrivateAsyncLocalStorage()
const pending = new Map()
const installedGlobals = new Set()
const installedGlobalOriginals = new Map()
const PROCESS_CONTROLS = setFromArray(['exit', 'abort', 'kill', 'chdir'])
const CELL_FRAME_SUFFIX = '\n;'
let filenameSequence = 0
let activeFilename = 'ptc-plus-repl'
const CONFORMANCE_CELL = `"use strict";
{
  if (this !== globalThis) throw new Error('invalid REPL global receiver semantics')
  const __ptc_canary = await Promise.resolve(1)
  if (__ptc_canary !== 1) throw new Error('invalid REPL await semantics')
  const __ptc_import_canary = await import(${jsonStringify(REPL_IMPORT_CANARY)})
  if (__ptc_import_canary.default !== 1) throw new Error('invalid REPL import semantics')
}`
let activeRun
let activeExecution
let suppressReplCwdObservation = false
let nextCallId = 0
let nextStaticAdapterId = 0
let nextUserBindingModuleId = 0
const userBindingEntries = new Map()
const userBindingNames = new Map()
const userBindingSources = new Map()
const dynamicNamespaces = new Map()
const originalDynamicNamespaceGlobals = new Map()
const dynamicNamespaceViews = new Map()
const dynamicNamespaceGlobalGetters = new Map()
let retainedLegacyUserBindingRuntime = false

installProgramAmbientResolver(name => {
  if (!mapHas(dynamicNamespaces, name) && !mapHas(originalDynamicNamespaceGlobals, name)
    && !mapHas(dynamicNamespaceViews, name)) return undefined
  return {
    get: () => dynamicNamespaceView(name),
    set() { throw new TypeError(`${name} cannot be overwritten because reserved program bindings are not shadowable`) },
    typeof: () => 'object',
    delete: () => false,
  }
})

class StaticImportFailure {
  constructor(error, position) {
    this.error = error
    this.position = position
  }
}

class CellReturn extends Error {
  constructor(value) {
    super('cell returned')
    this.value = value
  }

  static complete() {
    evaluationScope.getStore().completed = true
  }
}
function appendLog(...values) {
  const current = logScope.getStore()
  if (current?.open !== true) return
  appendText(current, formatWithOptions({ colors: false, depth: 4, maxArrayLength: 100, maxStringLength: 10_000 }, ...values))
}

function appendText(current, text) {
  if (current.open !== true || current.outputLimited) return
  const bytes = bufferByteLength(jsonStringify(text), 'utf8') + (current.logs.length === 0 ? 0 : 1)
  if (current.logBytes + bytes > current.maxOutputBytes) {
    current.outputLimited = true
    channel.postMessage({ type: 'output-limit', id: current.id, logs: current.logs })
    return
  }
  current.logBytes += bytes
  appendArray(current.logs, text)
}

const consoleView = Object.freeze({
  log: appendLog,
  info: appendLog,
  warn: appendLog,
  error: appendLog,
  debug: appendLog,
  dir: value => appendLog(value),
})
Object.defineProperty(context, 'console', { configurable: true, value: consoleView })

function captureWrite(chunk, ...rest) {
  const current = logScope.getStore()
  if (current?.open === true) appendText(current, typeof chunk === 'string' ? chunk : String(chunk))
  const callback = typeof rest[0] === 'function' ? rest[0]
    : typeof rest[1] === 'function' ? rest[1] : undefined
  if (callback !== undefined) queueMicrotask(() => callback(null))
  return true
}
process.stdout.write = captureWrite
process.stderr.write = captureWrite

function markVolatile(reason) {
  const current = activeExecution
  if (current === undefined) return
  if (current.durability === 'volatile') return
  current.durability = 'volatile'
  current.volatileReason ??= reason
  channel.postMessage({ type: 'volatile', id: current.id, reason: current.volatileReason })
}

function completionDurability(execution) {
  return {
    durability: execution.durability,
    ...(execution.volatileReason === undefined ? {} : { volatileReason: execution.volatileReason }),
  }
}

function guardProcessControls() {
  const properties = setValuesArray(PROCESS_CONTROLS)
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index]
    const descriptor = Object.getOwnPropertyDescriptor(process, property)
    Object.defineProperty(process, property, {
      configurable: false,
      enumerable: descriptor?.enumerable ?? true,
      writable: false,
      value: () => {
        throw new Error(`process.${property} is forbidden inside the REPL kernel`)
      },
    })
  }
}

guardProcessControls()
installWorkerCwdVirtualization(sessionCwd, originalRequire, reason => {
  if (suppressReplCwdObservation) {
    suppressReplCwdObservation = false
    return
  }
  markVolatile(reason)
})
synchronizeBuiltinEsmExports()
const providedRequire = sessionReplParent === undefined ? originalRequire : createRequire(sessionReplParent)
function selectProvidedRequire(args) {
  const specifier = args[0]
  if (setHas(FORBIDDEN_IMPORTS, specifier)) throw new Error(`module ${specifier} is forbidden because it exposes kernel control`)
  if (!setHas(DURABLE_IMPORTS, specifier)) markVolatile(`require(${jsonStringify(specifier)})`)
  return managedRequire(activeExecution?.languageSemantics === 'legacy-v1' ? replParent : sessionReplParent ?? replParent,
    activeExecution?.languageSemantics === 'legacy-v1' ? originalRequire : providedRequire)
}
Object.defineProperty(context, 'require', {
  configurable: true,
  value: new Proxy(providedRequire, {
    apply: (_, receiver, args) => privateReflect.apply(selectProvidedRequire(args), receiver, args),
    construct: (_, args, newTarget) => privateReflect.construct(selectProvidedRequire(args), args, newTarget),
  }),
})
function evaluate(program, completionSignal, asyncCompletion = false) {
  return new ControlPromise((resolve, reject) => {
    let settled = false
    const finish = (failed, value) => {
      if (settled) return
      settled = true
      if (failed && value instanceof CellReturn) {
        completionObserver.settle(value.value,
          value => resolve({ hasValue: true, value }),
          reject,
        )
      } else if (failed) reject(value)
      else {
        completionObserver.settle(value,
          value => resolve({ hasValue: value !== undefined, value }),
          reject,
        )
      }
    }
    activeFilename = `ptc-plus-repl-${++filenameSequence}`
    suppressReplCwdObservation = true
    evaluationScope.run(finish, () => errorDomain.run(() => {
      // Older REPL callbacks conflate null/undefined await rejection with a
      // successful empty result. A reached EOF distinguishes those outcomes.
      // A block-scoped declaration has empty completion and preserves the
      // preceding non-await expression value without adding a session binding.
      // Keep the final semicolon so REPL cannot guess a block is an object literal.
      const suffix = completionSignal === undefined || asyncCompletion ? CELL_FRAME_SUFFIX
        : `${CELL_FRAME_SUFFIX}{ let completed = this[${jsonStringify(completionSignal)}].complete(); }${CELL_FRAME_SUFFIX}`
      server.eval(program + suffix, context, activeFilename, (error, value) => {
        if (asyncCompletion && (error === null || error === undefined)) {
          completionObserver.observe(value, value => finish(false, value), error => finish(true, error))
          return
        }
        const failed = error !== null && error !== undefined || completionSignal !== undefined && finish.completed !== true
        finish(failed, failed ? error : value)
      })
    }))
    suppressReplCwdObservation = false
  })
}

async function verifyEvaluation() {
  await evaluate(CONFORMANCE_CELL)
  const marker = new Error('PTC Plus REPL settlement probe')
  Object.defineProperty(marker, 'stack', { get() { throw new Error('REPL must not format an error before settlement') } })
  context.__ptc_settlement_probe__ = marker
  context.__ptc_completion_probe__ = CellReturn
  try {
    const values = [marker, null, undefined, false, 0]
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      const value = values[valueIndex]
      context.__ptc_settlement_probe__ = value
      const sources = ['throw __ptc_settlement_probe__', 'await Promise.reject(__ptc_settlement_probe__)']
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
        const source = sources[sourceIndex]
        let caught = false
        try { await evaluate(source, '__ptc_completion_probe__') } catch (error) {
          if (error !== value) throw new Error('REPL did not preserve the original thrown value')
          caught = true
        }
        if (!caught) throw new Error('REPL did not reject a failed evaluation')
      }
    }
    let syntaxRejected = false
    try { await evaluate('const =') } catch (error) { syntaxRejected = error?.name === 'SyntaxError' }
    if (!syntaxRejected) throw new Error('REPL did not preserve syntax failure')
    context.__ptc_settlement_probe__ = new CellReturn(promiseResolve(marker))
    const returned = await evaluate('throw __ptc_settlement_probe__')
    if (!returned.hasValue || returned.value !== marker) throw new Error('REPL did not preserve cell return')
    await evaluate(CONFORMANCE_CELL)
    await evaluate('{ const value = await Promise.resolve(42); if (value !== 42) throw new Error("invalid block await") }', '__ptc_completion_probe__')
    const expression = await evaluate('42', '__ptc_completion_probe__')
    if (expression.value !== 42) throw new Error('REPL did not preserve expression completion')
  } finally {
    delete context.__ptc_settlement_probe__
    delete context.__ptc_completion_probe__
  }
}

function staticImportClause(options) {
  if (options === undefined) return { attributes: undefined, clause: '' }
  const option = Object.entries(options)[0]
  const keyword = option[0]
  const attributes = option[1]
  const entries = mapArray(Object.entries(attributes), entry => `${jsonStringify(entry[0])}: ${jsonStringify(entry[1])}`)
  return { attributes, clause: ` ${keyword} { ${join(entries, ', ')} }` }
}

function staticAdapterSource(load) {
  const { attributes, clause } = staticImportClause(load.options)
  const source = jsonStringify(statefulModuleLink(load.source, staticModuleLinkReference(load.source, attributes)))
  if (load.global === undefined) return `import ${source}${clause};`
  const requirements = load.requiredExports === undefined ? [] : mapArray(load.requiredExports, (name, index) => {
    const imported = name === 'default' ? 'default' : jsonStringify(name)
    return `${imported} as __required_${index}__`
  })
  const lines = [`import * as namespace from ${source}${clause};`]
  if (requirements.length > 0) appendArray(lines, `export { ${join(requirements, ', ')} } from ${source}${clause};`)
  appendArray(lines, 'export { namespace };')
  return join(lines, '\n')
}

async function loadStaticModule(load) {
  if (load.operation === 'native-dynamic') return { namespace: nativeRootDynamic.environment(load.callableSources,
    load.awaitRoot === true, filterArray(load.logicalRoots, name => statefulRoots.has(name)
      && rootBindingStorage(name, moduleRuntimeIntrinsics.includes(load.nativeLexicals, name)) !== 'lexical'), load.writableRoots) }
  if (load.operation === 'import') {
    return { namespace: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm) }
  }
  const adapter = `data:text/javascript,${encodeURIComponent(staticAdapterSource(load))}#${++nextStaticAdapterId}`
  setAdd(staticAdapterParents, adapter)
  userModuleCompilation.mark(adapter, { compiled: true,
    transform: activeExecution?.moduleTransform })
  try {
    const completion = await evaluate(`import(${jsonStringify(adapter)})`)
    if (load.global === undefined) return { namespace: undefined }
    const namespace = readModuleImport(adapter, load.source, null, () => completion.value.namespace, load.options?.with)
    return { namespace }
  } finally {
    setDelete(staticAdapterParents, adapter)
  }
}

function hasExecutionLease(runId) {
  return runId !== undefined && activeRun === runId && logScope.getStore()?.id === runId
}

// BoundError is the error class installed by this cell's wrapper, not a name
// looked up later: the cell can replace or delete the context binding while a
// call is pending, and the call must keep its submitted error identity.
function callHost(runId, global, member, args, BoundError) {
  if (!hasExecutionLease(runId)) {
    return promiseReject(programBindingError('lease', 'PTC execution lease expired'))
  }
  const activation = userBindingActivationScope.getStore()
  if (activation !== undefined) {
    activation.called = true
    if (activation.failed) {
      markVolatile(`failed user binding ${jsonStringify(activation.id)} issued a host call`)
    }
  }
  const id = ++nextCallId
  const valueLimits = activeExecution.valueLimits
  let settle
  const result = new PublicPromise((resolve, reject) => { settle = { resolve, reject } })
  const settled = new ControlPromise(resolve => {
    moduleRuntimeIntrinsics.Reflect.apply(moduleRuntimeIntrinsics.promiseThen, result, [resolve, resolve])
  })
  mapSet(pending, id, { ...settle, runId, valueLimits, settled, member, BoundError })
  try {
    channel.postMessage({
      type: 'call', runId, id, global, member,
      args: encodeValue(args, valueLimits),
    })
  } catch (error) {
    mapDelete(pending, id)
    settle.reject(error)
  }
  return result
}

function dynamicNamespace(name) {
  const assertLease = () => {
    if (!hasExecutionLease(logScope.getStore()?.id)) {
      throw programBindingError('lease', 'PTC execution lease expired')
    }
  }
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      assertLease()
      const descriptor = mapGet(dynamicNamespaces, name)
      if (descriptor === undefined || !setHas(descriptor.members, property)) return undefined
      return (...args) => {
        if (!hasExecutionLease(logScope.getStore()?.id)) {
          return promiseReject(programBindingError('lease', 'PTC execution lease expired'))
        }
        const current = mapGet(dynamicNamespaces, name)
        if (current === undefined || !setHas(current.members, property)) {
          return promiseReject(programBindingError('capability', `unknown binding ${name}.${property}`))
        }
        return callHost(
          logScope.getStore()?.id,
          name,
          property,
          args.length === 0 && setHas(current.emptyObjectMembers, property) ? {} : args[0],
          current.BoundError,
        )
      }
    },
    has(_target, property) {
      assertLease()
      const descriptor = mapGet(dynamicNamespaces, name)
      return typeof property === 'string' && descriptor !== undefined && setHas(descriptor.members, property)
    },
    ownKeys() {
      assertLease()
      const descriptor = mapGet(dynamicNamespaces, name)
      return descriptor === undefined ? [] : setValuesArray(descriptor.members)
    },
    getOwnPropertyDescriptor(_target, property) {
      assertLease()
      const descriptor = mapGet(dynamicNamespaces, name)
      return typeof property === 'string' && descriptor !== undefined && setHas(descriptor.members, property)
        ? compilerDescriptors.descriptor({ configurable: true, enumerable: true })
        : undefined
    },
    set() { return false },
  })
}

function dynamicNamespaceView(name) {
  let view = mapGet(dynamicNamespaceViews, name)
  if (view === undefined) {
    view = dynamicNamespace(name)
    mapSet(dynamicNamespaceViews, name, view)
  }
  return view
}

function namespaceGlobalGetter(name) {
  let getter = mapGet(dynamicNamespaceGlobalGetters, name)
  if (getter === undefined) {
    getter = () => mapGet(dynamicNamespaces, name)?.cellView ?? dynamicNamespaceView(name)
    mapSet(dynamicNamespaceGlobalGetters, name, getter)
  }
  return getter
}

function installNamespaceGlobal(name) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: namespaceGlobalGetter(name),
  })
}

function installDynamicNamespaceGlobals() {
  const pendingGlobals = []
  const names = mapKeysArray(dynamicNamespaces)
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (mapHas(originalDynamicNamespaceGlobals, name)) {
      installNamespaceGlobal(name)
      continue
    }
    const original = setHas(installedGlobals, name)
      ? mapGet(installedGlobalOriginals, name)
      : capturedGlobalDescriptor(name)
    if (setHas(workerBaselineGlobals, name)) {
      throw new Error(
        `program namespace ${jsonStringify(name)} cannot be bridged into Global User Binding modules because the worker global already exists`,
      )
    }
    appendArray(pendingGlobals, [name, original.descriptor])
  }
  for (let index = 0; index < pendingGlobals.length; index += 1) {
    const entry = pendingGlobals[index]
    const name = entry[0]
    const descriptor = entry[1]
    mapSet(originalDynamicNamespaceGlobals, name, descriptor)
    if (!setHas(installedGlobals, name)) installNamespaceGlobal(name)
  }
}

function restoreDynamicNamespaceGlobals() {
  const names = mapKeysArray(originalDynamicNamespaceGlobals)
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    setHas(installedGlobals, name) ? installNamespaceGlobal(name) : privateReflect.deleteProperty(globalThis, name)
  }
  mapClear(originalDynamicNamespaceGlobals)
}

function installBindings(message) {
  const installedNames = setValuesArray(installedGlobals)
  for (let index = 0; index < installedNames.length; index += 1) {
    const name = installedNames[index]
    const original = mapGet(installedGlobalOriginals, name)
    const attachedEntry = original.userGlobalEntryId === undefined
      ? undefined : mapGet(userBindingEntries, original.userGlobalEntryId)
    const attachment = attachedEntry === undefined ? undefined : mapGet(attachedEntry.descriptors, name)
    if (mapHas(originalDynamicNamespaceGlobals, name)) {
      installNamespaceGlobal(name)
    } else if (original.userGlobalEntryId !== undefined
      && (mapGet(userBindingNames, name) !== original.userGlobalEntryId
        || attachment !== original.attachment)) {
      delete context[name]
    } else if (original.descriptor === undefined) delete context[name]
    else Object.defineProperty(context, name, original.descriptor)
  }
  setClear(installedGlobals)
  mapClear(installedGlobalOriginals)
  mapClear(dynamicNamespaces)
  let namespaceError

  for (let namespaceIndex = 0; namespaceIndex < message.namespaces.length; namespaceIndex += 1) {
    const namespace = message.namespaces[namespaceIndex]
    const descriptor = namespace.errorClass
    // The wrapper owns the constructor, so a pending call keeps its submitted
    // error identity even after the cell shadows the context binding.
    const BoundError = descriptor === undefined ? undefined : class extends Error {
      constructor(member, detail, cause) {
        super(detail)
        this.name = descriptor.name
        Object.defineProperty(this, descriptor.memberNameProperty, { enumerable: true, value: member })
        if (cause !== undefined) Object.defineProperty(this, 'ptcCause', { value: cause })
      }
    }
    const view = Object.create(null)
    const emptyObjectMembers = setFromArray(namespace.emptyObjectMembers ?? [])
    mapSet(dynamicNamespaces, namespace.global, {
      members: setFromArray(namespace.members),
      shadowable: namespace.shadowable === true,
      emptyObjectMembers,
      BoundError,
      cellView: view,
    })
    for (let memberIndex = 0; memberIndex < namespace.members.length; memberIndex += 1) {
      const member = namespace.members[memberIndex]
      Object.defineProperty(view, member, {
        enumerable: true,
        value: (...args) => callHost(
          message.id,
          namespace.global,
          member,
          args.length === 0 && setHas(emptyObjectMembers, member) ? {} : args[0],
          BoundError,
        ),
      })
    }
    Object.freeze(view)
    const original = capturedGlobalDescriptor(namespace.global)
    mapSet(installedGlobalOriginals, namespace.global, original)
    if (setHas(workerBaselineGlobals, namespace.global)) {
      namespaceError ??= new Error(
        `program namespace ${jsonStringify(namespace.global)} cannot be bridged into the worker realm because the global already exists`,
      )
    } else {
      installNamespaceGlobal(namespace.global)
      setAdd(installedGlobals, namespace.global)
    }

    if (descriptor !== undefined) {
      mapSet(installedGlobalOriginals, descriptor.name, capturedGlobalDescriptor(descriptor.name))
      Object.defineProperty(context, descriptor.name, { configurable: true, value: BoundError })
      setAdd(installedGlobals, descriptor.name)
    }
  }
  return namespaceError
}

function capturedGlobalDescriptor(name) {
  const descriptor = mapHas(originalDynamicNamespaceGlobals, name)
    ? mapGet(originalDynamicNamespaceGlobals, name)
    : Object.getOwnPropertyDescriptor(context, name)
  const userGlobalEntryId = mapGet(userBindingNames, name)
  const entry = mapGet(userBindingEntries, userGlobalEntryId)
  const installed = entry === undefined ? undefined : mapGet(entry.descriptors, name)
  return {
    descriptor,
    ...(userGlobalEntryId !== undefined && descriptorsEqual(descriptor, installed)
      ? { userGlobalEntryId, attachment: installed }
      : {}),
  }
}

function underlyingUserBindingDescriptor(name) {
  return setHas(installedGlobals, name)
    ? mapGet(installedGlobalOriginals, name).descriptor
    : Object.getOwnPropertyDescriptor(context, name)
}

function recordUserBindingAssignment(name, legacy = false) {
  if (!legacy || activeExecution?.userBindingsShadowPolicy === LIVE_USER_BINDINGS_SHADOW_POLICY) {
    if (!setHas(installedGlobals, name)) {
      mapDelete(userBindingNames, name)
      mapSet(userBindingSources, name, { state: 'local' })
    }
  } else {
    // Historical setters record invocation before defining the property. A
    // restored accessor does not erase that operation, even for the same value.
    if (activeExecution !== undefined) setAdd(activeExecution.legacyAssignedUserBindingNames, name)
  }
}

// A temporary private getter distinguishes native lexical storage without
// invoking provider/user getters or comparing arbitrary values. A failed read
// proves no initialized value; it must never be promoted from the static catalog.
function rootBindingStorage(name, nativeLexical = false) {
  const original = Object.getOwnPropertyDescriptor(context, name)
  if (original?.configurable === false) {
    if (!nativeLexical && !Object.hasOwn(original, 'value')) return 'unknown'
    try {
      // Both an own data property and an initialized lexical can be read
      // without executing an accessor. Either proves an available local name.
      runInWorkerReplRealm(name, { displayErrors: false })
      return nativeLexical ? 'lexical' : 'local'
    } catch {
      return 'unknown'
    }
  }
  let propertyRead = false
  try {
    Object.defineProperty(context, name, { configurable: true, get() { propertyRead = true } })
    runInWorkerReplRealm(name, { displayErrors: false })
    return propertyRead ? 'property' : 'lexical'
  } catch {
    return 'unknown'
  } finally {
    if (original === undefined) delete context[name]
    else Object.defineProperty(context, name, original)
  }
}

function writableRootProperty(name) {
  const descriptor = Object.getOwnPropertyDescriptor(context, name)
  return descriptor !== undefined && (Object.hasOwn(descriptor, 'value')
    ? descriptor.writable === true : typeof descriptor.set === 'function')
}

function userBindingRootStorage(name) {
  if (statefulRoots.has(name)) return 'local'
  const namespaces = activeExecution.importBindingNamespaces
  const namespace = namespaces === undefined ? undefined : mapGet(namespaces, name)
  if (namespace === undefined) return rootBindingStorage(name)
  // Compiler-validated imports use native namespace slots, not public alias
  // properties. Probe only the slot; reading an export could invoke user code.
  return rootBindingStorage(namespace) === 'lexical' ? 'lexical' : 'unknown'
}

function reconcileUserBindingNames() {
  const names = mapKeysArray(userBindingSources)
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    const storage = userBindingRootStorage(name)
    const descriptor = underlyingUserBindingDescriptor(name)
    const id = mapGet(userBindingNames, name)
    const entry = mapGet(userBindingEntries, id)
    const installed = entry === undefined ? undefined : mapGet(entry.descriptors, name)
    const state = storage === 'lexical' || storage === 'local' ? 'local'
      : storage === 'unknown' ? 'unknown'
        : descriptor === undefined ? 'absent'
          : installed !== undefined && descriptorsEqual(descriptor, installed) ? 'provider' : 'local'
    mapSet(userBindingSources, name, { state, ...(state === 'provider' ? { entryId: id } : {}) })
    if (state !== 'provider') mapDelete(userBindingNames, name)
  }
}

function removePerNameUserBindingEntry(id) {
  const entry = mapGet(userBindingEntries, id)
  for (let index = 0; index < entry.names.length; index += 1) {
    const name = entry.names[index]
    if (mapGet(userBindingNames, name) !== id) continue
    const installed = mapGet(entry.descriptors, name)
    mapDelete(userBindingNames, name)
    if (setHas(installedGlobals, name)) {
      const original = mapGet(installedGlobalOriginals, name)
      if (original.attachment === installed) original.descriptor = undefined
    } else if (descriptorsEqual(Object.getOwnPropertyDescriptor(context, name), installed)) delete context[name]
    // Lifecycle removal permits reattachment; explicit deletion retains absent.
    mapDelete(userBindingSources, name)
  }
  mapDelete(userBindingEntries, id)
}

async function activatePerNameUserBindings(snapshot, shadowedNames, cwd, reusePolicy, initialFailures = []) {
  // Import preceding legacy attachments into the new source owner once.
  const existingNames = mapEntriesArray(userBindingNames)
  for (let index = 0; index < existingNames.length; index += 1) {
    const name = existingNames[index][0]
    const entryId = existingNames[index][1]
    if (mapHas(userBindingSources, name)) continue
    mapSet(userBindingSources, name, { state: 'provider', entryId })
    // The legacy catalog includes actual setter writes as well as descriptor
    // changes. Do not reattach a restored local accessor by descriptor equality.
    if (setHas(shadowedNames, name) && !setHas(installedGlobals, name)) mapDelete(userBindingNames, name)
  }
  reconcileUserBindingNames()
  const blockedIds = setFromArray(mapArray(initialFailures, failure => failure.id))
  const desired = mapFromArray(filterArray(snapshot?.entries ?? [], entry => !setHas(blockedIds, entry.id)), entry => [entry.id, entry])
  try {
    if (mapSize(desired) > 0 || retainedLegacyUserBindingRuntime) installDynamicNamespaceGlobals()
  } catch (error) {
    const ids = mapKeysArray(userBindingEntries)
    for (let index = 0; index < ids.length; index += 1) removePerNameUserBindingEntry(ids[index])
    const failures = copyArray(initialFailures)
    const desiredFailures = mapArray(mapKeysArray(desired), id => ({ id, error: messageOf(error) }))
    for (let index = 0; index < desiredFailures.length; index += 1) appendArray(failures, desiredFailures[index])
    return { activated: [], failures, error }
  }
  const currentEntries = mapEntriesArray(userBindingEntries)
  for (let index = 0; index < currentEntries.length; index += 1) {
    const id = currentEntries[index][0]
    const current = currentEntries[index][1]
    const next = mapGet(desired, id)
    if (next === undefined || current.transform !== snapshot.transform || !(reusePolicy === LEGACY_USER_BINDINGS_REUSE_POLICY
      ? next.fingerprint === current.entry.fingerprint : userBindingImplementationMatches(next, current.entry))) {
      removePerNameUserBindingEntry(id)
    }
  }
  const activated = []
  const failures = copyArray(initialFailures)
  const desiredEntries = mapValuesArray(desired)
  for (let entryIndex = 0; entryIndex < desiredEntries.length; entryIndex += 1) {
    const entry = desiredEntries[entryIndex]
    const current = mapGet(userBindingEntries, entry.id)
    if (current !== undefined) {
      current.entry = entry
      appendArray(activated, entry.id)
      continue
    }
    const names = entry.scope === 'namespace' ? [entry.name] : entry.symbols
    const previousSources = mapFromArray(names, name => [name, mapGet(userBindingSources, name)])
    const installedNames = []
    let evaluated
    const activation = { id: entry.id, called: false, failed: false }
    try {
      if (entry.durability === 'volatile') markVolatile(`user binding ${jsonStringify(entry.id)}: ${entry.volatileReason ?? 'non-replayable source'}`)
      evaluated = await userBindingActivationScope.run(activation, () => evaluateUserBinding(entry, cwd, snapshot.transform))
      const namespace = evaluated.namespace
      for (let symbolIndex = 0; symbolIndex < entry.symbols.length; symbolIndex += 1) {
        const symbol = entry.symbols[symbolIndex]
        if (!Object.hasOwn(namespace, symbol)) throw new Error(`named export ${jsonStringify(symbol)} is unavailable after evaluation`)
      }
      const view = Object.create(null)
      for (let symbolIndex = 0; symbolIndex < entry.symbols.length; symbolIndex += 1) {
        const symbol = entry.symbols[symbolIndex]
        Object.defineProperty(view, symbol, { enumerable: true, get: () => namespace[symbol] })
      }
      Object.freeze(view)
      const descriptors = new Map()
      for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        const name = names[nameIndex]
        const storage = userBindingRootStorage(name)
        const prior = mapGet(userBindingSources, name)
        if (storage === 'lexical' || storage === 'unknown') {
          mapSet(userBindingSources, name, { state: storage === 'lexical' ? 'local' : 'unknown' })
        } else if (prior === undefined && setHas(shadowedNames, name)) {
          const descriptor = underlyingUserBindingDescriptor(name)
          mapSet(userBindingSources, name, { state: descriptor === undefined ? 'unknown' : 'local' })
        }
        const source = mapGet(userBindingSources, name)
        if (source !== undefined && source.state !== 'provider') continue
        const descriptor = Object.getOwnPropertyDescriptor(context, name)
        Object.defineProperty(context, name, {
          configurable: true,
          enumerable: true,
          get: () => entry.scope === 'namespace' ? view : namespace[name],
          set(value) {
            const receiver = this === contextGlobal ? context : this
            Object.defineProperty(receiver, name, { configurable: true, enumerable: true, writable: true, value })
            if (receiver === context) recordUserBindingAssignment(name)
          },
        })
        appendArray(installedNames, { name, descriptor })
        mapSet(descriptors, name, Object.getOwnPropertyDescriptor(context, name))
        mapSet(userBindingNames, name, entry.id)
        mapSet(userBindingSources, name, { state: 'provider', entryId: entry.id })
      }
      mapSet(userBindingEntries, entry.id, { entry, transform: snapshot.transform, moduleUrl: evaluated.moduleUrl, names, descriptors })
      if (snapshot.transform !== USER_BINDING_TRANSFORM) retainedLegacyUserBindingRuntime = true
      appendArray(activated, entry.id)
    } catch (error) {
      activation.failed = true
      if (activation.called) markVolatile(`failed user binding ${jsonStringify(entry.id)} issued a host call`)
      for (let index = installedNames.length - 1; index >= 0; index--) {
        const installed = installedNames[index]
        mapDelete(userBindingNames, installed.name)
        if (installed.descriptor === undefined) delete context[installed.name]
        else Object.defineProperty(context, installed.name, installed.descriptor)
      }
      const previousEntries = mapEntriesArray(previousSources)
      for (let previousIndex = 0; previousIndex < previousEntries.length; previousIndex += 1) {
        const name = previousEntries[previousIndex][0]
        const prior = previousEntries[previousIndex][1]
        if (prior === undefined) mapDelete(userBindingSources, name)
        else mapSet(userBindingSources, name, prior)
      }
      if (evaluated !== undefined) mapDelete(userBindingModuleParents, evaluated.moduleUrl)
      appendArray(failures, { id: entry.id, error: messageOf(error) })
    }
  }
  if (mapSize(userBindingEntries) === 0 && !retainedLegacyUserBindingRuntime) restoreDynamicNamespaceGlobals()
  return { activated, failures }
}

function removeUserBindingEntry(id, shadowedNames) {
  const previous = mapGet(userBindingEntries, id)
  if (previous === undefined) return
  for (let index = 0; index < previous.names.length; index += 1) {
    const name = previous.names[index]
    if (mapGet(userBindingNames, name) !== id) continue
    mapDelete(userBindingNames, name)
    if (!setHas(shadowedNames, name)) delete context[name]
  }
  mapDelete(userBindingEntries, id)
}

function descriptorsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right
  return left.configurable === right.configurable
    && left.enumerable === right.enumerable
    && left.get === right.get
    && left.set === right.set
    && left.value === right.value
    && left.writable === right.writable
}

function reconcileUserBindingShadows(shadowedNames) {
  const entries = mapEntriesArray(userBindingEntries)
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const id = entries[entryIndex][0]
    const entry = entries[entryIndex][1]
    for (let nameIndex = 0; nameIndex < entry.names.length; nameIndex += 1) {
      const name = entry.names[nameIndex]
      if (mapGet(userBindingNames, name) !== id) continue
      const installed = mapGet(entry.descriptors, name)
      const current = Object.getOwnPropertyDescriptor(context, name)
      if (!descriptorsEqual(current, installed)) setAdd(shadowedNames, name)
    }
  }
}

async function evaluateUserBinding(entry, cwd, transform) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('user binding activation requires an absolute storage directory')
  }
  const prepared = compileStatefulModule(entry.source, {
    transform,
    programBindings: transform === USER_BINDING_TRANSFORM,
  })
  const url = `data:text/javascript,${encodeURIComponent(prepared.code)}#ptc-plus-${entry.fingerprint}-${++nextUserBindingModuleId}`
  mapSet(userBindingModuleParents, url, pathToFileURL(resolve(cwd, 'bindings.json')).href)
  userModuleCompilation.mark(url, { transform, compiled: true, moduleInterface: prepared.moduleInterface, sourceRegions: prepared.sourceRegions })
  try {
    return { namespace: transform === LEGACY_USER_BINDING_TRANSFORM ? await import(url)
      : await managedModuleImport(url, url), moduleUrl: url }
  } catch (error) {
    mapDelete(userBindingModuleParents, url)
    throw error
  }
}

function userBindingImplementationMatches(left, right) {
  return left.source === right.source
    && left.scope === right.scope
    && (left.scope !== 'namespace' || left.name === right.name)
    && left.symbols.length === right.symbols.length
    && everyArray(left.symbols, (symbol, index) => symbol === right.symbols[index])
}

async function activateUserBindings(snapshot, shadowedNames, cwd, reusePolicy, initialFailures = []) {
  reconcileUserBindingShadows(shadowedNames)
  const blockedIds = setFromArray(mapArray(initialFailures, failure => failure.id))
  const desired = mapFromArray(filterArray(snapshot?.entries ?? [], (entry) => {
      const names = entry.scope === 'namespace' ? [entry.name] : entry.symbols
      return !setHas(blockedIds, entry.id) && !someArray(names, name => setHas(shadowedNames, name))
    }), entry => [entry.id, entry])
  try {
    if (mapSize(desired) > 0 || retainedLegacyUserBindingRuntime) installDynamicNamespaceGlobals()
  } catch (error) {
    const ids = mapKeysArray(userBindingEntries)
    for (let index = 0; index < ids.length; index += 1) removeUserBindingEntry(ids[index], shadowedNames)
    const failures = copyArray(initialFailures)
    const desiredFailures = mapArray(mapKeysArray(desired), id => ({ id, error: messageOf(error) }))
    for (let index = 0; index < desiredFailures.length; index += 1) appendArray(failures, desiredFailures[index])
    return { activated: [], failures, error }
  }
  const existingIds = mapKeysArray(userBindingEntries)
  for (let index = 0; index < existingIds.length; index += 1) {
    const id = existingIds[index]
    const current = mapGet(userBindingEntries, id)
    const next = mapGet(desired, id)
    // Historical cells retain fingerprint-based resets, including presentation edits.
    const reusable = next !== undefined && current.transform === snapshot.transform && (reusePolicy === LEGACY_USER_BINDINGS_REUSE_POLICY
      ? next.fingerprint === current.entry.fingerprint
      : userBindingImplementationMatches(next, current.entry))
    if (!reusable) {
      removeUserBindingEntry(id, shadowedNames)
    }
  }
  const activated = []
  const failures = copyArray(initialFailures)
  const desiredEntries = mapValuesArray(desired)
  for (let entryIndex = 0; entryIndex < desiredEntries.length; entryIndex += 1) {
    const entry = desiredEntries[entryIndex]
    const current = mapGet(userBindingEntries, entry.id)
    if (current !== undefined) {
      current.entry = entry
      appendArray(activated, entry.id)
      continue
    }
    let evaluated
    const installedNames = []
    const activation = { id: entry.id, called: false, failed: false }
    try {
      if (entry.durability === 'volatile') {
        markVolatile(`user binding ${jsonStringify(entry.id)}: ${entry.volatileReason ?? 'non-replayable source'}`)
      }
      evaluated = await userBindingActivationScope.run(
        activation,
        () => evaluateUserBinding(entry, cwd, snapshot.transform),
      )
      const namespace = evaluated.namespace
      for (let symbolIndex = 0; symbolIndex < entry.symbols.length; symbolIndex += 1) {
        const symbol = entry.symbols[symbolIndex]
        if (!Object.hasOwn(namespace, symbol)) {
          throw new Error(`named export ${jsonStringify(symbol)} is unavailable after evaluation`)
        }
      }
      const names = []
      if (entry.scope === 'namespace') {
        const view = Object.create(null)
        for (let symbolIndex = 0; symbolIndex < entry.symbols.length; symbolIndex += 1) {
          const symbol = entry.symbols[symbolIndex]
          Object.defineProperty(view, symbol, {
            enumerable: true,
            get: () => namespace[symbol],
          })
        }
        Object.freeze(view)
        const descriptor = Object.getOwnPropertyDescriptor(context, entry.name)
        Object.defineProperty(context, entry.name, {
          configurable: true,
          enumerable: true,
          get: () => view,
          set(value) {
            recordUserBindingAssignment(entry.name, true)
            Object.defineProperty(context, entry.name, {
              configurable: true,
              enumerable: true,
              writable: true,
              value,
            })
          },
        })
        appendArray(installedNames, {
          name: entry.name,
          descriptor,
        })
        mapSet(userBindingNames, entry.name, entry.id)
        appendArray(names, entry.name)
      } else {
        for (let symbolIndex = 0; symbolIndex < entry.symbols.length; symbolIndex += 1) {
          const symbol = entry.symbols[symbolIndex]
          const descriptor = Object.getOwnPropertyDescriptor(context, symbol)
          Object.defineProperty(context, symbol, {
            configurable: true,
            enumerable: true,
            get: () => namespace[symbol],
            set(value) {
              recordUserBindingAssignment(symbol, true)
              Object.defineProperty(context, symbol, {
                configurable: true,
                enumerable: true,
                writable: true,
                value,
              })
            },
          })
          appendArray(installedNames, { name: symbol, descriptor })
          mapSet(userBindingNames, symbol, entry.id)
          appendArray(names, symbol)
        }
      }
      mapSet(userBindingEntries, entry.id, {
        entry,
        transform: snapshot.transform,
        moduleUrl: evaluated.moduleUrl,
        names,
        descriptors: mapFromArray(names, name => [name, Object.getOwnPropertyDescriptor(context, name)]),
      })
      if (snapshot.transform !== USER_BINDING_TRANSFORM) retainedLegacyUserBindingRuntime = true
      appendArray(activated, entry.id)
    } catch (error) {
      activation.failed = true
      if (activation.called) {
        markVolatile(`failed user binding ${jsonStringify(entry.id)} issued a host call`)
      }
      for (let index = installedNames.length - 1; index >= 0; index--) {
        const installed = installedNames[index]
        mapDelete(userBindingNames, installed.name)
        if (installed.descriptor === undefined) delete context[installed.name]
        else Object.defineProperty(context, installed.name, installed.descriptor)
      }
      if (evaluated !== undefined) mapDelete(userBindingModuleParents, evaluated.moduleUrl)
      removeUserBindingEntry(entry.id, shadowedNames)
      appendArray(failures, {
        id: entry.id,
        error: messageOf(error),
      })
    }
  }
  if (mapSize(userBindingEntries) === 0 && !retainedLegacyUserBindingRuntime) restoreDynamicNamespaceGlobals()
  return { activated, failures }
}

async function closeExecution(execution) {
  activeRun = undefined
  execution.open = false
  const settling = []
  mapForEach(pending, call => {
    if (call.runId === execution.id) appendArray(settling, call.settled)
  })
  for (let index = 0; index < settling.length; index++) await settling[index]
}

function failureOutcome(error, phase, program) {
  if (phase === 'encode') return { invalidOutput: messageOf(error) }
  const failure = error instanceof StaticImportFailure ? error.error : error
  // The V8 frame is reported in the executed text; validate it there so an
  // out-of-range frame is an explicit absence instead of a mapped position.
  const detail = errorDetails(failure, activeFilename, program)
  // A compiler-created call error has only an adapter stack. Its source fact
  // owns the operation; ordinary exceptions retain their native stack position.
  const position = error instanceof StaticImportFailure ? error.position
    : activeExecution.exceptionOrigins.sourceFailure(failure) ? undefined : detail.position
  return {
    error: detail.message,
    errorName: detail.name,
    ...(detail.toolName === undefined ? {} : { toolName: detail.toolName }),
    ...(error instanceof StaticImportFailure ? { moduleLoadFailed: true } : {}),
    ...(position === undefined ? {} : { position }),
    ...(position === undefined ? { exceptionOrigins: activeExecution.exceptionOrigins.origins(failure) } : {}),
    ...(detail.cause === undefined ? {} : { cause: detail.cause }),
    ...(detail.failureOrigin === undefined ? {} : { failureOrigin: detail.failureOrigin }),
  }
}

function observeBindings(names) {
  const observation = valueObserver.observe(names)
  return { ...observation, entries: mapArray(observation.entries, entry => {
    const local = statefulRoots.localValue(entry.name)
    return local === undefined ? entry : { name: entry.name, ...previewBindingValue(local.value) }
  }) }
}

function refreshLegacyPublication(name) {
  const publications = activeExecution?.nativePublications
  const publication = publications === undefined ? undefined : mapGet(publications, name)
  // A completed native declaration is visible to saved logical closures in
  // the same cell. A failed or pending initializer retains the prior source.
  if (publication === undefined) return
  const storage = rootBindingStorage(publication.import?.namespace ?? name, publication.nativeLexical)
  if (storage === 'lexical' || publication.import === undefined
    && (storage === 'local' || storage === 'property' && Object.hasOwn(context, name))) {
    mapDelete(publications, name)
    statefulRoots.publishLegacy(name, publication.writable, publication.import, storage !== 'lexical')
  }
}

function sendCompletion(message, execution, userBindings, committedRedeclarations, outcome) {
  const publicationNames = execution.nativePublications === undefined
    ? [] : mapKeysArray(execution.nativePublications)
  for (let index = 0; index < publicationNames.length; index += 1) refreshLegacyPublication(publicationNames[index])
  const shadowedNames = execution.legacyAssignedUserBindingNames
  const perName = message.userBindingsShadowPolicy === LIVE_USER_BINDINGS_SHADOW_POLICY
  if (perName) reconcileUserBindingNames()
  else reconcileUserBindingShadows(shadowedNames)
  const names = message.observeNames ?? []
  channel.postMessage({
    type: 'done',
    id: message.id,
    logs: execution.logs,
    ...completionDurability(execution),
    committedRedeclarations: setValuesArray(committedRedeclarations),
    ...(message.rootBindings === undefined ? {} : { rootBindingFacts: statefulRoots.facts() }),
    ...(perName ? { userBindingNames: normalizeUserBindingNames(mapArray(mapEntriesArray(userBindingSources), entry => ({
      name: entry[0], state: entry[1].state, ...(entry[1].state === 'provider' ? { entryId: entry[1].entryId } : {}),
    }))) } : {}),
    ...(message.userBindings === undefined ? {} : {
      activatedUserBindings: userBindings.activated,
      userBindingFailures: userBindings.failures,
      ...(perName ? {} : { shadowedUserBindings: setValuesArray(shadowedNames) }),
    }),
    ...outcome,
    observing: names.length > 0,
  })
  if (outcome.error === undefined) valueObserver.record(message.program)
  if (names.length > 0) {
    channel.postMessage({ type: 'observation', id: message.id, observation: observeBindings(names) })
  }
}

async function runCell(message) {
  if (activeExecution !== undefined) throw new Error('kernel received overlapping cells')
  activeRun = message.id
  const execution = {
    id: message.id,
    exceptionOrigins: createExceptionOriginScope(),
    languageSemantics: message.languageSemantics,
    moduleTransform: message.moduleTransform,
    userBindingsShadowPolicy: message.userBindingsShadowPolicy,
    importBindingNamespaces: message.importBindingNamespaces,
    legacyAssignedUserBindingNames: new Set(),
    logs: [],
    open: true,
    outputLimited: false,
    logBytes: 2,
    maxOutputBytes: message.maxOutputBytes,
    valueLimits: message.valueLimits,
    durability: message.durability === 'volatile' ? 'volatile' : 'durable',
    volatileReason: message.volatileReason,
  }
  activeExecution = execution
  const cellGlobals = []
  const committedRedeclarations = new Set()

  try {
    let completion
    let outcome
    let userBindings = { activated: [], failures: [] }
    try {
      completion = await logScope.run(execution, async () => {
        const namespaceError = installBindings(message)
        Object.defineProperty(context, message.returnSignal, {
          configurable: true,
          value: CellReturn,
        })
        appendArray(cellGlobals, message.returnSignal)
        Object.defineProperty(context, message.commitSignal, {
          configurable: true,
          value(name) {
            setAdd(committedRedeclarations, name)
          },
        })
        appendArray(cellGlobals, message.commitSignal)
        if (message.rootRuntimeName !== undefined) {
          const nativeLexicals = setFromArray(message.rootBindings.legacyNativeLexicals)
          const legacyStorage = mapFromArray(filterArray(message.rootBindings.legacyLexicals,
            name => !statefulRoots.has(name)), name => [name, rootBindingStorage(name, setHas(nativeLexicals, name))])
          const legacyLexicals = filterArray(message.rootBindings.legacyLexicals, name => mapGet(legacyStorage, name) === 'lexical')
          const legacyNative = setFromArray(message.rootBindings.legacyNative)
          const legacyWritable = filterArray(message.rootBindings.legacyWritable, name => {
            const storage = mapGet(legacyStorage, name)
            return storage === 'lexical' || setHas(legacyNative, name)
              && (storage === 'local' || storage === 'property') && writableRootProperty(name)
          })
          Object.defineProperty(context, message.rootRuntimeName, {
            configurable: true,
            value: statefulRoots.begin({ ...message.rootBindings,
              legacyLexicals,
              legacyWritable,
              legacyObjects: filterArray(legacyWritable, name => mapGet(legacyStorage, name) !== 'lexical'),
              committed(name) {
                setDelete(committedRedeclarations, name)
                setAdd(committedRedeclarations, name)
              } }),
          })
          appendArray(cellGlobals, message.rootRuntimeName)
        }
        const activate = message.userBindingsShadowPolicy === LIVE_USER_BINDINGS_SHADOW_POLICY
          ? activatePerNameUserBindings : activateUserBindings
        userBindings = await activate(
          message.userBindings,
          setFromArray(message.shadowedUserBindingNames ?? []),
          message.userBindingsCwd,
          message.userBindingsReusePolicy,
          message.userBindingFailures,
        )
        if (userBindings.error !== undefined) throw userBindings.error
        if (namespaceError !== undefined) throw namespaceError
        for (let failureIndex = 0; failureIndex < userBindings.failures.length; failureIndex += 1) {
          const failure = userBindings.failures[failureIndex]
          appendText(execution, `Global binding ${jsonStringify(failure.id)} was not activated: ${failure.error}`)
        }
        const moduleLoads = message.moduleLoads ?? []
        for (let loadIndex = 0; loadIndex < moduleLoads.length; loadIndex += 1) {
          const load = moduleLoads[loadIndex]
          let namespace
          try {
            namespace = (await loadStaticModule(load)).namespace
          } catch (error) {
            throw new StaticImportFailure(error, load.position)
          }
          if (load.global !== undefined) {
            Object.defineProperty(context, load.global, {
              configurable: true,
              value: namespace,
            })
            appendArray(cellGlobals, load.global)
          }
        }
        // Preload failure leaves prior aliases authoritative. Once evaluation
        // starts, new slots must prove their own initialization, including TDZ.
        execution.importBindingNamespaces = message.preparedImportBindingNamespaces
        execution.nativePublications = new Map()
        for (let loadIndex = 0; loadIndex < moduleLoads.length; loadIndex += 1) {
          const load = moduleLoads[loadIndex]
          const publications = load.nativePublications ?? []
          for (let publicationIndex = 0; publicationIndex < publications.length; publicationIndex += 1) {
            const publication = publications[publicationIndex]
            mapSet(execution.nativePublications, publication.name, publication)
          }
        }
        return execution.exceptionOrigins.run(() => evaluate(message.program, message.returnSignal, message.asyncCompletion))
      })
    } catch (error) {
      outcome = failureOutcome(error, 'execute', message.program)
    } finally {
      await closeExecution(execution)
    }

    if (outcome === undefined) {
      try {
        const encodedValue = completion.hasValue
          ? encodeValue(completion.value, execution.valueLimits)
          : undefined
        outcome = {
          hasValue: completion.hasValue,
          ...(encodedValue === undefined ? {} : { value: encodedValue }),
        }
      } catch (error) {
        outcome = failureOutcome(error, 'encode', message.program)
      }
    }
    sendCompletion(message, execution, userBindings, committedRedeclarations, outcome)
  } finally {
    for (let index = 0; index < cellGlobals.length; index += 1) delete context[cellGlobals[index]]
    activeRun = undefined
    activeExecution = undefined
    execution.exceptionOrigins.close()
    execution.open = false
  }
}

// The host stops this worker cooperatively so the release below runs while the
// realms, REPL and ports it owns are still alive.
parentPort.on('message', (message) => {
  if (message?.type !== WORKER_SHUTDOWN_REQUEST) return
  server.close()
  input.destroy()
  output.destroy()
  errorDomain.removeAllListeners('error')
  process.removeListener('uncaughtException', handleUncaughtException)
  channel.close()
  parentPort.postMessage({ type: WORKER_SHUTDOWN_ACKNOWLEDGEMENT })
  parentPort.close()
})

channel.on('message', (message) => {
  if (message?.type === 'prepare') {
    channel.postMessage({ type: 'ready', id: message.id })
    return
  }
  if (message?.type === 'observe') {
    channel.postMessage({ type: 'observation-started', id: message.id })
    channel.postMessage({ type: 'observation', id: message.id,
      observation: observeBindings(message.names) })
    return
  }
  if (message?.type === 'reply') {
    const call = mapGet(pending, message.id)
    if (call === undefined || call.runId !== message.runId) return
    mapDelete(pending, message.id)
    try {
      if (message.ok) call.resolve(decodeValue(message.value, call.valueLimits))
      else if (call.BoundError === undefined) {
        const error = new Error(message.error)
        if (message.cause !== undefined) error.ptcCause = message.cause
        call.reject(error)
      } else call.reject(new call.BoundError(call.member, message.error, message.cause))
    } catch (error) {
      call.reject(error)
    }
    return
  }
  if (message?.type === 'run') void runCell(message)
})

let startupTimer
try {
  await Promise.race([
    verifyEvaluation(),
    new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error('REPL settlement probe timed out')), 5000)
    }),
  ])
  replModuleRealm = (await evaluate('({Promise,stringify:value=>`${value}`,importModule:(source,options)=>import(source,options)})')).value
  valueObserver = createReplValueObserver(context, {
    awaitLexicals: await supportsAwaitLexicals(context, evaluate),
  })
  parentPort.postMessage({ type: 'ready', port: port1 }, [port1])
} catch (error) {
  parentPort.postMessage({
    type: 'startup-error',
    error: `PTC runtime prerequisite failed on Node ${process.version}: ${messageOf(error)}. No user cell executed; use a DSH-supported runtime that passes the REPL conformance probe. Editing the cell cannot fix this host failure.`,
  })
} finally {
  clearTimeout(startupTimer)
}
