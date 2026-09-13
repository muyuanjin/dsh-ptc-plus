import { AsyncLocalStorage } from 'node:async_hooks'
import { create as createDomain } from 'node:domain'
import { createRequire, registerHooks } from 'node:module'
import { managedModuleImport, managedRequire, readModuleImport, statefulModuleLink } from './stateful-module-runtime.js'
import { compileStatefulModule, createUserModuleCompilationHooks } from './stateful-module-compiler.js'
import { USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM, moduleTransformForLanguage } from './module-transform-contract.js'
import { isAbsolute, resolve } from 'node:path'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { formatWithOptions } from 'node:util'
import { MessageChannel, parentPort, workerData } from 'node:worker_threads'
import { runInContext } from 'node:vm'
import { synchronizeBuiltinEsmExports } from './builtin-esm-sync.js'
import { createExceptionOriginScope, errorDetails, messageOf, programBindingError } from './failure-reporting.js'
import { AMBIENT_GLOBALS, DURABLE_IMPORTS, FORBIDDEN_IMPORTS } from './module-policy.js'
import { decodeValue, encodeValue } from './value-wire.js'
import { LEGACY_USER_BINDINGS_REUSE_POLICY, LIVE_USER_BINDINGS_SHADOW_POLICY, normalizeUserBindingNames } from './session-journal-schema.js'
import { installWorkerCwdVirtualization } from './worker-cwd-virtualization.js'
import { createReplValueObserver, supportsAwaitLexicals, previewBindingValue } from './repl-value-observer.js'
import { createStatefulRootRuntime } from './stateful-root-runtime.js'
import { createNativeRootDynamic } from './native-root-dynamic.js'
import { moduleRuntimeIntrinsics } from './compiler-intrinsics.js'
import { compilerDescriptors } from './compiler-descriptors.js'
import { createCellCompletionObserver } from './cell-completion.js'

const { Object, mapGet, mapSet, mapHas, mapDelete, setHas, setAdd, setDelete } = moduleRuntimeIntrinsics
const hasProperty = Reflect.has

if (parentPort === null) throw new Error('ptc-plus kernel worker started without a parent port')
const { port1, port2: channel } = new MessageChannel()

const input = new PassThrough()
const output = new PassThrough()
output.resume()
const evaluationScope = new AsyncLocalStorage()
const sessionCwd = typeof workerData?.cwd === 'string' ? workerData.cwd : undefined
if (sessionCwd !== undefined && !isAbsolute(sessionCwd)) {
  throw new Error(`ptc-plus session cwd must be absolute, got ${JSON.stringify(sessionCwd)}`)
}
const server = repl.start({
  input,
  output,
  terminal: false,
  prompt: '',
  useGlobal: false,
  ignoreUndefined: true,
  // The writer is a fallback for REPL error paths not captured by the domain.
  // Successful direct eval values arrive through its callback.
  writer(error) {
    evaluationScope.getStore()?.(true, error)
    return ''
  },
})
// domain.bind exposes its owner on a bound evaluator in older Node REPLs.
// Newer REPLs honor an explicitly entered domain. Capture before REPL error
// formatting can evaluate user-defined stack/name getters.
const errorDomain = server.eval.domain ?? createDomain()
errorDomain.removeAllListeners('error')
errorDomain.on('error', error => evaluationScope.getStore()?.(true, error))
const context = server.context
const contextGlobal = runInContext('globalThis', context)
const completionObserver = createCellCompletionObserver(runInContext('Function', context))
let replModuleRealm
const statefulRoots = createStatefulRootRuntime({
  refresh: name => refreshLegacyPublication(name),
  importModule: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm),
  errors: runInContext('({ ReferenceError, TypeError })', context),
  dynamicIntrinsics: runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context),
  readAmbient: name => runInContext(name, context),
  typeofAmbient: name => runInContext(`typeof ${name}`, context),
  canWriteAmbient: name => writableRootProperty(name),
  writeAmbient(name, value, strict) {
    const argument = name === '__ptc_value' ? '__ptc_other_value' : '__ptc_value'
    runInContext(`${strict ? '"use strict";' : ''}(${argument}) => (${name} = ${argument})`, context)(value)
  },
  deleteAmbient: name => runInContext(`delete ${name}`, context),
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
  intrinsics: runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context),
  importModule: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm),
  read: name => runInContext(name, context),
  typeOf: name => runInContext(`typeof ${name}`, context),
  write(name, value, strict) {
    const argument = name === '__ptc_value' ? '__ptc_other_value' : '__ptc_value'
    runInContext(`${strict ? '"use strict";' : ''}(${argument}) => (${name} = ${argument})`, context)(value)
  },
  remove: name => runInContext(`delete ${name}`, context),
})
let valueObserver
const REPL_IMPORT_CANARY = 'data:text/javascript,export default 1'
let replParent
const sessionReplParent = sessionCwd === undefined ? undefined : pathToFileURL(resolve(sessionCwd, 'repl')).href
const staticAdapterParents = new Set()
const userBindingModuleParents = new Map()
const userModuleCompilation = createUserModuleCompilationHooks({
  transformForParent: parent => (parent === replParent || parent === sessionReplParent) && activeExecution !== undefined
    ? moduleTransformForLanguage(activeExecution.languageSemantics) : undefined,
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
const logScope = new AsyncLocalStorage()
const userBindingActivationScope = new AsyncLocalStorage()
const pending = new Map()
const installedGlobals = new Set()
const installedGlobalOriginals = new Map()
const PROCESS_CONTROLS = new Set(['exit', 'abort', 'kill', 'chdir'])
const CELL_FRAME_SUFFIX = '\n;'
let filenameSequence = 0
let activeFilename = 'ptc-plus-repl'
const CONFORMANCE_CELL = `"use strict";
{
  if (this !== globalThis) throw new Error('invalid REPL global receiver semantics')
  const __ptc_canary = await Promise.resolve(1)
  if (__ptc_canary !== 1) throw new Error('invalid REPL await semantics')
  const __ptc_import_canary = await import(${JSON.stringify(REPL_IMPORT_CANARY)})
  if (__ptc_import_canary.default !== 1) throw new Error('invalid REPL import semantics')
}`
let activeRun
let activeExecution
let pendingVolatileReason
let nextCallId = 0
let nextStaticAdapterId = 0
let nextUserBindingModuleId = 0
const userBindingEntries = new Map()
const userBindingNames = new Map()
const userBindingSources = new Map()
const dynamicNamespaces = new Map()
const originalDynamicNamespaceGlobals = new Map()
let retainedUserBindingRuntime = false

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
  const bytes = Buffer.byteLength(JSON.stringify(text), 'utf8') + (current.logs.length === 0 ? 0 : 1)
  if (current.logBytes + bytes > current.maxOutputBytes) {
    current.outputLimited = true
    channel.postMessage({ type: 'output-limit', id: current.id, logs: current.logs })
    return
  }
  current.logBytes += bytes
  current.logs.push(text)
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
  const callback = [rest[0], rest[1]].find(value => typeof value === 'function')
  if (callback !== undefined) queueMicrotask(() => callback(null))
  return true
}
process.stdout.write = captureWrite
process.stderr.write = captureWrite

function markVolatile(reason) {
  const current = activeExecution
  if (current === undefined) {
    pendingVolatileReason ??= reason
    return
  }
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

const originalRequire = context.require

function guardProcessControls() {
  for (const property of PROCESS_CONTROLS) {
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
installWorkerCwdVirtualization(sessionCwd, originalRequire)
synchronizeBuiltinEsmExports()
const originalGlobals = Object.fromEntries(
  [...AMBIENT_GLOBALS].filter(name => name !== 'require')
    .map(name => [name, name === 'eval' || name === 'Function' ? runInContext(name, context) : globalThis[name]]),
)
const providedRequire = sessionReplParent === undefined ? originalRequire : createRequire(sessionReplParent)
function selectProvidedRequire(args) {
  const specifier = args[0]
  if (FORBIDDEN_IMPORTS.has(specifier)) throw new Error(`module ${specifier} is forbidden because it exposes kernel control`)
  if (!DURABLE_IMPORTS.has(specifier)) markVolatile(`require(${JSON.stringify(specifier)})`)
  return managedRequire(activeExecution?.languageSemantics === 'legacy-v1' ? replParent : sessionReplParent ?? replParent,
    activeExecution?.languageSemantics === 'legacy-v1' ? originalRequire : providedRequire)
}
Object.defineProperty(context, 'require', {
  configurable: true,
  value: new Proxy(providedRequire, {
    apply: (_, receiver, args) => Reflect.apply(selectProvidedRequire(args), receiver, args),
    construct: (_, args, newTarget) => Reflect.construct(selectProvidedRequire(args), args, newTarget),
  }),
})

for (const [name, value] of Object.entries(originalGlobals)) {
  Object.defineProperty(context, name, {
    configurable: true,
    get() {
      markVolatile(`ambient ${name}`)
      return value
    },
    set(next) {
      markVolatile(`ambient ${name}`)
      Object.defineProperty(context, name, { configurable: true, writable: true, value: next })
    },
  })
}

const capturedOutput = Object.freeze({ write: captureWrite })
const processView = new Proxy(process, {
  get(target, property) {
    if (property === 'stdout' || property === 'stderr') return capturedOutput
    if (property === 'cwd') {
      if (sessionCwd !== undefined) return () => sessionCwd
      markVolatile('process.cwd')
      return target.cwd.bind(target)
    }
    if (PROCESS_CONTROLS.has(property)) return Reflect.get(target, property, target)
    markVolatile(`process.${String(property)}`)
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
  set(target, property, value) {
    if (property === 'stdout' || property === 'stderr') return false
    markVolatile(`process.${String(property)}`)
    return Reflect.set(target, property, value, target)
  },
  ownKeys(target) {
    markVolatile('process reflection')
    return Reflect.ownKeys(target)
  },
})
Object.defineProperty(context, 'process', { configurable: true, value: processView })

const mathDescriptors = Object.getOwnPropertyDescriptors(Math)
mathDescriptors.random = {
  ...mathDescriptors.random,
  value: () => {
    markVolatile('Math.random')
    return Math.random()
  },
}
const mathView = Object.defineProperties(Object.create(Object.getPrototypeOf(Math)), mathDescriptors)
Object.defineProperty(context, 'Math', {
  configurable: true,
  value: Object.freeze(mathView),
})

function evaluate(program, completionSignal, asyncCompletion = false) {
  return new Promise((resolve, reject) => {
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
    evaluationScope.run(finish, () => errorDomain.run(() => {
      // Older REPL callbacks conflate null/undefined await rejection with a
      // successful empty result. A reached EOF distinguishes those outcomes.
      // A block-scoped declaration has empty completion and preserves the
      // preceding non-await expression value without adding a session binding.
      // Keep the final semicolon so REPL cannot guess a block is an object literal.
      const suffix = completionSignal === undefined || asyncCompletion ? CELL_FRAME_SUFFIX
        : `${CELL_FRAME_SUFFIX}{ let completed = this[${JSON.stringify(completionSignal)}].complete(); }${CELL_FRAME_SUFFIX}`
      server.eval(program + suffix, context, activeFilename, (error, value) => {
        if (asyncCompletion && (error === null || error === undefined)) {
          completionObserver.observe(value, value => finish(false, value), error => finish(true, error))
          return
        }
        const failed = error !== null && error !== undefined || completionSignal !== undefined && finish.completed !== true
        finish(failed, failed ? error : value)
      })
    }))
  })
}

async function verifyEvaluation() {
  await evaluate(CONFORMANCE_CELL)
  const marker = new Error('PTC Plus REPL settlement probe')
  Object.defineProperty(marker, 'stack', { get() { throw new Error('REPL must not format an error before settlement') } })
  context.__ptc_settlement_probe__ = marker
  context.__ptc_completion_probe__ = CellReturn
  try {
    for (const value of [marker, null, undefined, false, 0]) {
      context.__ptc_settlement_probe__ = value
      for (const source of ['throw __ptc_settlement_probe__', 'await Promise.reject(__ptc_settlement_probe__)']) {
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
    context.__ptc_settlement_probe__ = new CellReturn(Promise.resolve(marker))
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

function staticImportAttributes(options) {
  if (options === undefined) return ''
  const [keyword, attributes] = Object.entries(options)[0]
  const entries = Object.entries(attributes)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  return ` ${keyword} { ${entries.join(', ')} }`
}

function staticAdapterSource(load) {
  const source = JSON.stringify(statefulModuleLink(load.source))
  const attributes = staticImportAttributes(load.options)
  if (load.global === undefined) return `import ${source}${attributes};`
  const requirements = load.requiredExports?.map((name, index) => {
    const imported = name === 'default' ? 'default' : JSON.stringify(name)
    return `${imported} as __required_${index}__`
  }) ?? []
  return [
    `import * as namespace from ${source}${attributes};`,
    ...(requirements.length === 0 ? [] : [
      `export { ${requirements.join(', ')} } from ${source}${attributes};`,
    ]),
    'export { namespace };',
  ].join('\n')
}

async function loadStaticModule(load) {
  if (load.operation === 'native-dynamic') return { namespace: nativeRootDynamic.environment(load.callableSources,
    load.awaitRoot === true, load.logicalRoots.filter(name => statefulRoots.has(name)
      && rootBindingStorage(name, moduleRuntimeIntrinsics.includes(load.nativeLexicals, name)) !== 'lexical'), load.writableRoots) }
  if (load.operation === 'import') {
    return { namespace: (source, options) => managedModuleImport(replParent, source, options, replModuleRealm) }
  }
  const adapter = `data:text/javascript,${encodeURIComponent(staticAdapterSource(load))}#${++nextStaticAdapterId}`
  staticAdapterParents.add(adapter)
  userModuleCompilation.mark(adapter, { compiled: true,
    transform: moduleTransformForLanguage(activeExecution?.languageSemantics) })
  try {
    const completion = await evaluate(`import(${JSON.stringify(adapter)})`)
    if (load.global === undefined) return { namespace: undefined }
    const namespace = readModuleImport(adapter, load.source, null, () => completion.value.namespace, load.options?.with)
    return { namespace }
  } finally {
    staticAdapterParents.delete(adapter)
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
    return Promise.reject(programBindingError('lease', 'PTC execution lease expired'))
  }
  const activation = userBindingActivationScope.getStore()
  if (activation !== undefined) {
    activation.called = true
    if (activation.failed) {
      markVolatile(`failed user binding ${JSON.stringify(activation.id)} issued a host call`)
    }
  }
  const id = ++nextCallId
  const valueLimits = activeExecution.valueLimits
  let settle
  const result = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const settled = result.then(() => {}, () => {})
  pending.set(id, { ...settle, runId, valueLimits, settled, member, BoundError })
  try {
    channel.postMessage({
      type: 'call', runId, id, global, member,
      args: encodeValue(args, valueLimits),
    })
  } catch (error) {
    pending.delete(id)
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
      const descriptor = dynamicNamespaces.get(name)
      if (descriptor === undefined || !descriptor.members.has(property)) return undefined
      return (...args) => {
        if (!hasExecutionLease(logScope.getStore()?.id)) {
          return Promise.reject(programBindingError('lease', 'PTC execution lease expired'))
        }
        const current = dynamicNamespaces.get(name)
        if (current === undefined || !current.members.has(property)) {
          return Promise.reject(programBindingError('capability', `unknown binding ${name}.${property}`))
        }
        return callHost(
          logScope.getStore()?.id,
          name,
          property,
          args.length === 0 && current.emptyObjectMembers.has(property) ? {} : args[0],
          current.BoundError,
        )
      }
    },
    has(_target, property) {
      assertLease()
      return typeof property === 'string' && dynamicNamespaces.get(name)?.members.has(property) === true
    },
    ownKeys() {
      assertLease()
      return [...dynamicNamespaces.get(name)?.members ?? []]
    },
    getOwnPropertyDescriptor(_target, property) {
      assertLease()
      return typeof property === 'string' && dynamicNamespaces.get(name)?.members.has(property) === true
        ? compilerDescriptors.descriptor({ configurable: true, enumerable: true })
        : undefined
    },
    set() { return false },
  })
}

function installDynamicNamespaceGlobals() {
  const pendingGlobals = []
  for (const name of dynamicNamespaces.keys()) {
    if (originalDynamicNamespaceGlobals.has(name)) continue
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    if (original !== undefined) {
      throw new Error(
        `program namespace ${JSON.stringify(name)} cannot be bridged into Global User Binding modules because the worker global already exists`,
      )
    }
    pendingGlobals.push(name)
  }
  for (const name of pendingGlobals) {
    originalDynamicNamespaceGlobals.set(name, undefined)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: false,
      value: dynamicNamespace(name),
    })
  }
}

function restoreDynamicNamespaceGlobals() {
  for (const [name, original] of originalDynamicNamespaceGlobals) {
    if (original === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, original)
  }
  originalDynamicNamespaceGlobals.clear()
}

function installBindings(message) {
  for (const name of installedGlobals) {
    const original = installedGlobalOriginals.get(name)
    if (original.userGlobalEntryId !== undefined
      && (userBindingNames.get(name) !== original.userGlobalEntryId
        || userBindingEntries.get(original.userGlobalEntryId)?.descriptors.get(name) !== original.attachment)) {
      delete context[name]
    } else if (original.descriptor === undefined) delete context[name]
    else Object.defineProperty(context, name, original.descriptor)
  }
  installedGlobals.clear()
  installedGlobalOriginals.clear()
  dynamicNamespaces.clear()

  for (const namespace of message.namespaces) {
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
    const emptyObjectMembers = new Set(namespace.emptyObjectMembers ?? [])
    dynamicNamespaces.set(namespace.global, {
      members: new Set(namespace.members),
      shadowable: namespace.shadowable === true,
      emptyObjectMembers,
      BoundError,
    })
    for (const member of namespace.members) {
      Object.defineProperty(view, member, {
        enumerable: true,
        value: (...args) => callHost(
          message.id,
          namespace.global,
          member,
          args.length === 0 && emptyObjectMembers.has(member) ? {} : args[0],
          BoundError,
        ),
      })
    }
    Object.freeze(view)
    installedGlobalOriginals.set(namespace.global, capturedGlobalDescriptor(namespace.global))
    Object.defineProperty(context, namespace.global, { configurable: true, value: view })
    installedGlobals.add(namespace.global)

    if (descriptor !== undefined) {
      installedGlobalOriginals.set(descriptor.name, capturedGlobalDescriptor(descriptor.name))
      Object.defineProperty(context, descriptor.name, { configurable: true, value: BoundError })
      installedGlobals.add(descriptor.name)
    }
  }
}

function capturedGlobalDescriptor(name) {
  const descriptor = Object.getOwnPropertyDescriptor(context, name)
  const userGlobalEntryId = userBindingNames.get(name)
  const installed = userBindingEntries.get(userGlobalEntryId)?.descriptors.get(name)
  return {
    descriptor,
    ...(userGlobalEntryId !== undefined && descriptorsEqual(descriptor, installed)
      ? { userGlobalEntryId, attachment: installed }
      : {}),
  }
}

function underlyingUserBindingDescriptor(name) {
  return installedGlobals.has(name)
    ? installedGlobalOriginals.get(name).descriptor
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
      runInContext(name, context, { displayErrors: false })
      return nativeLexical ? 'lexical' : 'local'
    } catch {
      return 'unknown'
    }
  }
  let propertyRead = false
  try {
    Object.defineProperty(context, name, { configurable: true, get() { propertyRead = true } })
    runInContext(name, context, { displayErrors: false })
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
  const namespace = activeExecution.importBindingNamespaces?.get(name)
  if (namespace === undefined) return rootBindingStorage(name)
  // Compiler-validated imports use native namespace slots, not public alias
  // properties. Probe only the slot; reading an export could invoke user code.
  return rootBindingStorage(namespace) === 'lexical' ? 'lexical' : 'unknown'
}

function reconcileUserBindingNames() {
  for (const name of userBindingSources.keys()) {
    const storage = userBindingRootStorage(name)
    const descriptor = underlyingUserBindingDescriptor(name)
    const id = userBindingNames.get(name)
    const installed = userBindingEntries.get(id)?.descriptors.get(name)
    const state = storage === 'lexical' || storage === 'local' ? 'local'
      : storage === 'unknown' ? 'unknown'
        : descriptor === undefined ? 'absent'
          : installed !== undefined && descriptorsEqual(descriptor, installed) ? 'provider' : 'local'
    userBindingSources.set(name, { state, ...(state === 'provider' ? { entryId: id } : {}) })
    if (state !== 'provider') userBindingNames.delete(name)
  }
}

function removePerNameUserBindingEntry(id) {
  const entry = userBindingEntries.get(id)
  for (const name of entry.names) {
    if (userBindingNames.get(name) !== id) continue
    const installed = entry.descriptors.get(name)
    userBindingNames.delete(name)
    if (installedGlobals.has(name)) {
      const original = installedGlobalOriginals.get(name)
      if (original.attachment === installed) original.descriptor = undefined
    } else if (descriptorsEqual(Object.getOwnPropertyDescriptor(context, name), installed)) delete context[name]
    // Lifecycle removal permits reattachment; explicit deletion retains absent.
    userBindingSources.delete(name)
  }
  userBindingEntries.delete(id)
}

async function activatePerNameUserBindings(snapshot, shadowedNames, cwd, reusePolicy, initialFailures = []) {
  // Import preceding legacy attachments into the new source owner once.
  for (const [name, entryId] of userBindingNames) {
    if (userBindingSources.has(name)) continue
    userBindingSources.set(name, { state: 'provider', entryId })
    // The legacy catalog includes actual setter writes as well as descriptor
    // changes. Do not reattach a restored local accessor by descriptor equality.
    if (shadowedNames.has(name) && !installedGlobals.has(name)) userBindingNames.delete(name)
  }
  reconcileUserBindingNames()
  const blockedIds = new Set(initialFailures.map(failure => failure.id))
  const desired = new Map((snapshot?.entries ?? []).filter(entry => !blockedIds.has(entry.id)).map(entry => [entry.id, entry]))
  try {
    if (desired.size > 0 || retainedUserBindingRuntime) installDynamicNamespaceGlobals()
  } catch (error) {
    for (const id of userBindingEntries.keys()) removePerNameUserBindingEntry(id)
    return { activated: [], failures: [...initialFailures, ...[...desired.keys()].map(id => ({ id, error: messageOf(error) }))], error }
  }
  for (const [id, current] of userBindingEntries) {
    const next = desired.get(id)
    if (next === undefined || current.transform !== snapshot.transform || !(reusePolicy === LEGACY_USER_BINDINGS_REUSE_POLICY
      ? next.fingerprint === current.entry.fingerprint : userBindingImplementationMatches(next, current.entry))) {
      removePerNameUserBindingEntry(id)
    }
  }
  const activated = []
  const failures = [...initialFailures]
  for (const entry of desired.values()) {
    const current = userBindingEntries.get(entry.id)
    if (current !== undefined) {
      current.entry = entry
      activated.push(entry.id)
      continue
    }
    const names = entry.scope === 'namespace' ? [entry.name] : entry.symbols
    const previousSources = new Map(names.map(name => [name, userBindingSources.get(name)]))
    const installedNames = []
    let evaluated
    const activation = { id: entry.id, called: false, failed: false }
    try {
      if (entry.durability === 'volatile') markVolatile(`user binding ${JSON.stringify(entry.id)}: ${entry.volatileReason ?? 'non-replayable source'}`)
      evaluated = await userBindingActivationScope.run(activation, () => evaluateUserBinding(entry, cwd, snapshot.transform))
      const namespace = evaluated.namespace
      for (const symbol of entry.symbols) {
        if (!Object.hasOwn(namespace, symbol)) throw new Error(`named export ${JSON.stringify(symbol)} is unavailable after evaluation`)
      }
      const view = Object.create(null)
      for (const symbol of entry.symbols) Object.defineProperty(view, symbol, { enumerable: true, get: () => namespace[symbol] })
      Object.freeze(view)
      const descriptors = new Map()
      for (const name of names) {
        const storage = userBindingRootStorage(name)
        const prior = userBindingSources.get(name)
        if (storage === 'lexical' || storage === 'unknown') {
          userBindingSources.set(name, { state: storage === 'lexical' ? 'local' : 'unknown' })
        } else if (prior === undefined && shadowedNames.has(name)) {
          const descriptor = underlyingUserBindingDescriptor(name)
          userBindingSources.set(name, { state: descriptor === undefined ? 'unknown' : 'local' })
        }
        const source = userBindingSources.get(name)
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
        installedNames.push({ name, descriptor })
        descriptors.set(name, Object.getOwnPropertyDescriptor(context, name))
        userBindingNames.set(name, entry.id)
        userBindingSources.set(name, { state: 'provider', entryId: entry.id })
      }
      userBindingEntries.set(entry.id, { entry, transform: snapshot.transform, moduleUrl: evaluated.moduleUrl, names, descriptors })
      retainedUserBindingRuntime = true
      activated.push(entry.id)
    } catch (error) {
      activation.failed = true
      if (activation.called) markVolatile(`failed user binding ${JSON.stringify(entry.id)} issued a host call`)
      for (const installed of installedNames.reverse()) {
        userBindingNames.delete(installed.name)
        if (installed.descriptor === undefined) delete context[installed.name]
        else Object.defineProperty(context, installed.name, installed.descriptor)
      }
      for (const [name, prior] of previousSources) {
        if (prior === undefined) userBindingSources.delete(name)
        else userBindingSources.set(name, prior)
      }
      if (evaluated !== undefined) userBindingModuleParents.delete(evaluated.moduleUrl)
      failures.push({ id: entry.id, error: messageOf(error) })
    }
  }
  if (userBindingEntries.size === 0 && !retainedUserBindingRuntime) restoreDynamicNamespaceGlobals()
  return { activated, failures }
}

function removeUserBindingEntry(id, shadowedNames) {
  const previous = userBindingEntries.get(id)
  if (previous === undefined) return
  for (const name of previous.names) {
    if (userBindingNames.get(name) !== id) continue
    userBindingNames.delete(name)
    if (!shadowedNames.has(name)) delete context[name]
  }
  userBindingEntries.delete(id)
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
  for (const [id, entry] of userBindingEntries) {
    for (const name of entry.names) {
      if (userBindingNames.get(name) !== id) continue
      const installed = entry.descriptors.get(name)
      const current = Object.getOwnPropertyDescriptor(context, name)
      if (!descriptorsEqual(current, installed)) shadowedNames.add(name)
    }
  }
}

async function evaluateUserBinding(entry, cwd, transform) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('user binding activation requires an absolute storage directory')
  }
  const prepared = compileStatefulModule(entry.source, { transform })
  const url = `data:text/javascript,${encodeURIComponent(prepared.code)}#ptc-plus-${entry.fingerprint}-${++nextUserBindingModuleId}`
  userBindingModuleParents.set(url, pathToFileURL(resolve(cwd, 'bindings.json')).href)
  userModuleCompilation.mark(url, { transform, compiled: true, moduleInterface: prepared.moduleInterface, sourceRegions: prepared.sourceRegions })
  try {
    return { namespace: transform === LEGACY_USER_BINDING_TRANSFORM ? await import(url)
      : await managedModuleImport(url, url), moduleUrl: url }
  } catch (error) {
    userBindingModuleParents.delete(url)
    throw error
  }
}

function userBindingImplementationMatches(left, right) {
  return left.source === right.source
    && left.scope === right.scope
    && (left.scope !== 'namespace' || left.name === right.name)
    && left.symbols.length === right.symbols.length
    && left.symbols.every((symbol, index) => symbol === right.symbols[index])
}

async function activateUserBindings(snapshot, shadowedNames, cwd, reusePolicy, initialFailures = []) {
  reconcileUserBindingShadows(shadowedNames)
  const blockedIds = new Set(initialFailures.map(failure => failure.id))
  const desired = new Map((snapshot?.entries ?? [])
    .filter((entry) => {
      const names = entry.scope === 'namespace' ? [entry.name] : entry.symbols
      return !blockedIds.has(entry.id) && !names.some(name => shadowedNames.has(name))
    })
    .map(entry => [entry.id, entry]))
  if (desired.size > 0 || retainedUserBindingRuntime) installDynamicNamespaceGlobals()
  for (const id of [...userBindingEntries.keys()]) {
    const current = userBindingEntries.get(id)
    const next = desired.get(id)
    // Historical cells retain fingerprint-based resets, including presentation edits.
    const reusable = next !== undefined && current.transform === snapshot.transform && (reusePolicy === LEGACY_USER_BINDINGS_REUSE_POLICY
      ? next.fingerprint === current.entry.fingerprint
      : userBindingImplementationMatches(next, current.entry))
    if (!reusable) {
      removeUserBindingEntry(id, shadowedNames)
    }
  }
  const activated = []
  const failures = [...initialFailures]
  for (const entry of desired.values()) {
    const current = userBindingEntries.get(entry.id)
    if (current !== undefined) {
      current.entry = entry
      activated.push(entry.id)
      continue
    }
    let evaluated
    const installedNames = []
    const activation = { id: entry.id, called: false, failed: false }
    try {
      if (entry.durability === 'volatile') {
        markVolatile(`user binding ${JSON.stringify(entry.id)}: ${entry.volatileReason ?? 'non-replayable source'}`)
      }
      evaluated = await userBindingActivationScope.run(
        activation,
        () => evaluateUserBinding(entry, cwd, snapshot.transform),
      )
      const namespace = evaluated.namespace
      for (const symbol of entry.symbols) {
        if (!Object.hasOwn(namespace, symbol)) {
          throw new Error(`named export ${JSON.stringify(symbol)} is unavailable after evaluation`)
        }
      }
      const names = []
      if (entry.scope === 'namespace') {
        const view = Object.create(null)
        for (const symbol of entry.symbols) {
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
        installedNames.push({
          name: entry.name,
          descriptor,
        })
        userBindingNames.set(entry.name, entry.id)
        names.push(entry.name)
      } else {
        for (const symbol of entry.symbols) {
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
          installedNames.push({ name: symbol, descriptor })
          userBindingNames.set(symbol, entry.id)
          names.push(symbol)
        }
      }
      userBindingEntries.set(entry.id, {
        entry,
        transform: snapshot.transform,
        moduleUrl: evaluated.moduleUrl,
        names,
        descriptors: new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(context, name)])),
      })
      retainedUserBindingRuntime = true
      activated.push(entry.id)
    } catch (error) {
      activation.failed = true
      if (activation.called) {
        markVolatile(`failed user binding ${JSON.stringify(entry.id)} issued a host call`)
      }
      for (const installed of installedNames.reverse()) {
        userBindingNames.delete(installed.name)
        if (installed.descriptor === undefined) delete context[installed.name]
        else Object.defineProperty(context, installed.name, installed.descriptor)
      }
      if (evaluated !== undefined) userBindingModuleParents.delete(evaluated.moduleUrl)
      removeUserBindingEntry(entry.id, shadowedNames)
      failures.push({
        id: entry.id,
        error: messageOf(error),
      })
    }
  }
  if (userBindingEntries.size === 0 && !retainedUserBindingRuntime) restoreDynamicNamespaceGlobals()
  return { activated, failures }
}

async function closeExecution(execution) {
  activeRun = undefined
  execution.open = false
  await Promise.all([...pending.values()]
    .filter(call => call.runId === execution.id)
    .map(call => call.settled))
}

function failureOutcome(error, phase) {
  if (phase === 'encode') return { invalidOutput: messageOf(error) }
  const failure = error instanceof StaticImportFailure ? error.error : error
  const detail = errorDetails(failure, activeFilename)
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
  return { ...observation, entries: observation.entries.map(entry => {
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
  for (const name of execution.nativePublications?.keys() ?? []) refreshLegacyPublication(name)
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
    committedRedeclarations: [...committedRedeclarations],
    ...(message.rootBindings === undefined ? {} : { rootBindingFacts: statefulRoots.facts() }),
    ...(perName ? { userBindingNames: normalizeUserBindingNames([...userBindingSources].map(([name, source]) => ({
      name, state: source.state, ...(source.state === 'provider' ? { entryId: source.entryId } : {}),
    }))) } : {}),
    ...(message.userBindings === undefined ? {} : {
      activatedUserBindings: userBindings.activated,
      userBindingFailures: userBindings.failures,
      ...(perName ? {} : { shadowedUserBindings: [...shadowedNames] }),
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
  installBindings(message)
  const execution = {
    id: message.id,
    exceptionOrigins: createExceptionOriginScope(),
    languageSemantics: message.languageSemantics,
    userBindingsShadowPolicy: message.userBindingsShadowPolicy,
    importBindingNamespaces: message.importBindingNamespaces,
    legacyAssignedUserBindingNames: new Set(),
    logs: [],
    open: true,
    outputLimited: false,
    logBytes: 2,
    maxOutputBytes: message.maxOutputBytes,
    valueLimits: message.valueLimits,
    durability: message.durability === 'volatile' || pendingVolatileReason !== undefined ? 'volatile' : 'durable',
    volatileReason: pendingVolatileReason,
  }
  pendingVolatileReason = undefined
  activeExecution = execution
  const cellGlobals = []
  const committedRedeclarations = new Set()

  try {
    let completion
    let outcome
    let userBindings = { activated: [], failures: [] }
    try {
      completion = await logScope.run(execution, async () => {
        Object.defineProperty(context, message.returnSignal, {
          configurable: true,
          value: CellReturn,
        })
        cellGlobals.push(message.returnSignal)
        Object.defineProperty(context, message.commitSignal, {
          configurable: true,
          value(name) {
            setAdd(committedRedeclarations, name)
          },
        })
        cellGlobals.push(message.commitSignal)
        if (message.rootRuntimeName !== undefined) {
          const nativeLexicals = new Set(message.rootBindings.legacyNativeLexicals)
          const legacyStorage = new Map(message.rootBindings.legacyLexicals
            .filter(name => !statefulRoots.has(name)).map(name => [name, rootBindingStorage(name, nativeLexicals.has(name))]))
          const legacyLexicals = message.rootBindings.legacyLexicals.filter(name => legacyStorage.get(name) === 'lexical')
          const legacyNative = new Set(message.rootBindings.legacyNative)
          const legacyWritable = message.rootBindings.legacyWritable.filter(name => {
            const storage = legacyStorage.get(name)
            return storage === 'lexical' || legacyNative.has(name)
              && (storage === 'local' || storage === 'property') && writableRootProperty(name)
          })
          Object.defineProperty(context, message.rootRuntimeName, {
            configurable: true,
            value: statefulRoots.begin({ ...message.rootBindings,
              legacyLexicals,
              legacyWritable,
              legacyObjects: legacyWritable.filter(name => legacyStorage.get(name) !== 'lexical'),
              committed(name) {
                setDelete(committedRedeclarations, name)
                setAdd(committedRedeclarations, name)
              } }),
          })
          cellGlobals.push(message.rootRuntimeName)
        }
        const activate = message.userBindingsShadowPolicy === LIVE_USER_BINDINGS_SHADOW_POLICY
          ? activatePerNameUserBindings : activateUserBindings
        userBindings = await activate(
          message.userBindings,
          new Set(message.shadowedUserBindingNames ?? []),
          message.userBindingsCwd,
          message.userBindingsReusePolicy,
          message.userBindingFailures,
        )
        if (userBindings.error !== undefined) throw userBindings.error
        for (const failure of userBindings.failures) {
          appendText(execution, `Global binding ${JSON.stringify(failure.id)} was not activated: ${failure.error}`)
        }
        for (const load of message.moduleLoads ?? []) {
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
            cellGlobals.push(load.global)
          }
        }
        // Preload failure leaves prior aliases authoritative. Once evaluation
        // starts, new slots must prove their own initialization, including TDZ.
        execution.importBindingNamespaces = message.preparedImportBindingNamespaces
        execution.nativePublications = new Map((message.moduleLoads ?? []).flatMap(load =>
          (load.nativePublications ?? []).map(publication => [publication.name, publication])))
        return execution.exceptionOrigins.run(() => evaluate(message.program, message.returnSignal, message.asyncCompletion))
      })
    } catch (error) {
      outcome = failureOutcome(error, 'execute')
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
        outcome = failureOutcome(error, 'encode')
      }
    }
    sendCompletion(message, execution, userBindings, committedRedeclarations, outcome)
  } finally {
    for (const name of cellGlobals) delete context[name]
    activeRun = undefined
    activeExecution = undefined
    execution.exceptionOrigins.close()
    execution.open = false
  }
}

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
    const call = pending.get(message.id)
    if (call === undefined || call.runId !== message.runId) return
    pending.delete(message.id)
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
