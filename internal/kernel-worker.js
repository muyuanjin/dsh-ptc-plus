import { AsyncLocalStorage } from 'node:async_hooks'
import { create as createDomain } from 'node:domain'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { formatWithOptions } from 'node:util'
import { MessageChannel, parentPort, workerData } from 'node:worker_threads'
import { synchronizeBuiltinEsmExports } from './builtin-esm-sync.js'
import { errorDetails, messageOf, programBindingError } from './failure-reporting.js'
import { AMBIENT_GLOBALS, DURABLE_IMPORTS, FORBIDDEN_IMPORTS } from './module-policy.js'
import { decodeValue, encodeValue } from './value-wire.js'
import { installWorkerCwdVirtualization } from './worker-cwd-virtualization.js'
import { createReplValueObserver } from './repl-value-observer.js'

if (parentPort === null) throw new Error('ptc-plus kernel worker started without a parent port')
const emitWarning = process.emitWarning
try {
  process.emitWarning = () => {}
  stripTypeScriptTypes('')
} finally {
  process.emitWarning = emitWarning
}
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
const valueObserver = createReplValueObserver(context)
const REPL_IMPORT_CANARY = 'data:text/javascript,export default 1'
let replParent
const sessionReplParent = sessionCwd === undefined ? undefined : pathToFileURL(resolve(sessionCwd, 'repl')).href
const staticAdapterParents = new Set()
const userBindingModuleParents = new Map()
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === REPL_IMPORT_CANARY && replParent === undefined) replParent = context.parentURL
    const userBindingParent = userBindingModuleParents.get(context.parentURL)
    return nextResolve(specifier, userBindingParent !== undefined
      ? { ...context, parentURL: userBindingParent }
      : context.parentURL === replParent || staticAdapterParents.has(context.parentURL)
        ? { ...context, parentURL: sessionReplParent ?? replParent }
        : context)
  },
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
const assignedUserBindingNames = new Set()
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
    .map(name => [name, globalThis[name]]),
)
Object.defineProperty(context, 'require', {
  configurable: true,
  value(specifier) {
    if (FORBIDDEN_IMPORTS.has(specifier)) throw new Error(`module ${specifier} is forbidden because it exposes kernel control`)
    if (!DURABLE_IMPORTS.has(specifier)) markVolatile(`require(${JSON.stringify(specifier)})`)
    return originalRequire(specifier)
  },
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

function evaluate(program, completionSignal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (failed, value) => {
      if (settled) return
      settled = true
      if (failed && value instanceof CellReturn) {
        Promise.resolve(value.value).then(
          value => resolve({ hasValue: true, value }),
          reject,
        )
      } else if (failed) reject(value)
      else {
        Promise.resolve(value).then(
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
      const suffix = completionSignal === undefined ? CELL_FRAME_SUFFIX
        : `${CELL_FRAME_SUFFIX}{ let completed = this[${JSON.stringify(completionSignal)}].complete(); }${CELL_FRAME_SUFFIX}`
      server.eval(program + suffix, context, activeFilename, (error, value) => {
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
  const source = JSON.stringify(load.source)
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
  const adapter = `data:text/javascript,${encodeURIComponent(staticAdapterSource(load))}#${++nextStaticAdapterId}`
  staticAdapterParents.add(adapter)
  try {
    const completion = await evaluate(`import(${JSON.stringify(adapter)})`)
    return completion.value.namespace
  } finally {
    staticAdapterParents.delete(adapter)
  }
}

function callHost(runId, global, member, args, errorClass) {
  if (runId === undefined || activeRun !== runId) return Promise.reject(programBindingError('lease', 'PTC execution lease expired'))
  const activation = userBindingActivationScope.getStore()
  if (activation !== undefined) {
    activation.called = true
    if (activation.failed) {
      markVolatile(`failed user binding ${JSON.stringify(activation.id)} issued a host call`)
    }
  }
  const id = ++nextCallId
  let settle
  const result = new Promise((resolve, reject) => { settle = { resolve, reject, errorClass, member } })
  void result.catch(() => {})
  pending.set(id, { ...settle, runId })
  try {
    channel.postMessage({
      type: 'call', runId, id, global, member,
      args: encodeValue(args, activeExecution?.valueLimits),
    })
  } catch (error) {
    pending.delete(id)
    settle.reject(error)
  }
  return result
}

function dynamicNamespace(name) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      const descriptor = dynamicNamespaces.get(name)
      if (descriptor === undefined || !descriptor.members.has(property)) return undefined
      return (...args) => {
        const current = dynamicNamespaces.get(name)
        if (current === undefined || !current.members.has(property)) {
          return Promise.reject(programBindingError('capability', `unknown binding ${name}.${property}`))
        }
        return callHost(
          logScope.getStore()?.id,
          name,
          property,
          args.length === 0 && current.emptyObjectMembers.has(property) ? {} : args[0],
          current.errorClass,
        )
      }
    },
    has(_target, property) {
      return typeof property === 'string' && dynamicNamespaces.get(name)?.members.has(property) === true
    },
    ownKeys() {
      return [...dynamicNamespaces.get(name)?.members ?? []]
    },
    getOwnPropertyDescriptor(_target, property) {
      return typeof property === 'string' && dynamicNamespaces.get(name)?.members.has(property) === true
        ? { configurable: true, enumerable: true }
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
      && userBindingNames.get(name) !== original.userGlobalEntryId) {
      delete context[name]
    } else if (original.descriptor === undefined) delete context[name]
    else Object.defineProperty(context, name, original.descriptor)
  }
  installedGlobals.clear()
  installedGlobalOriginals.clear()
  dynamicNamespaces.clear()

  for (const namespace of message.namespaces) {
    const view = Object.create(null)
    const emptyObjectMembers = new Set(namespace.emptyObjectMembers ?? [])
    dynamicNamespaces.set(namespace.global, {
      members: new Set(namespace.members),
      emptyObjectMembers,
      errorClass: namespace.errorClass,
    })
    for (const member of namespace.members) {
      Object.defineProperty(view, member, {
        enumerable: true,
        value: (...args) => callHost(
          message.id,
          namespace.global,
          member,
          args.length === 0 && emptyObjectMembers.has(member) ? {} : args[0],
          namespace.errorClass,
        ),
      })
    }
    Object.freeze(view)
    installedGlobalOriginals.set(namespace.global, capturedGlobalDescriptor(namespace.global))
    Object.defineProperty(context, namespace.global, { configurable: true, value: view })
    installedGlobals.add(namespace.global)

    if (namespace.errorClass !== undefined) {
      const descriptor = namespace.errorClass
      const BoundError = class extends Error {
        constructor(member, detail, cause) {
          super(detail)
          this.name = descriptor.name
          Object.defineProperty(this, descriptor.memberNameProperty, { enumerable: true, value: member })
          if (cause !== undefined) Object.defineProperty(this, 'ptcCause', { value: cause })
        }
      }
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
      ? { userGlobalEntryId }
      : {}),
  }
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

async function evaluateUserBinding(entry, cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('user binding activation requires an absolute storage directory')
  }
  const javascript = stripTypeScriptTypes(entry.source, { mode: 'transform', sourceMap: false })
  const url = `data:text/javascript,${encodeURIComponent(javascript)}#ptc-plus-${entry.fingerprint}-${++nextUserBindingModuleId}`
  userBindingModuleParents.set(url, pathToFileURL(resolve(cwd, 'bindings.json')).href)
  try {
    return { namespace: await import(url), moduleUrl: url }
  } catch (error) {
    userBindingModuleParents.delete(url)
    throw error
  }
}

async function activateUserBindings(snapshot, shadowedNames, cwd, initialFailures = []) {
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
    if (next === undefined || next.fingerprint !== current.fingerprint) {
      removeUserBindingEntry(id, shadowedNames)
    }
  }
  const activated = []
  const failures = [...initialFailures]
  for (const entry of desired.values()) {
    const current = userBindingEntries.get(entry.id)
    if (current?.fingerprint === entry.fingerprint) {
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
        () => evaluateUserBinding(entry, cwd),
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
            assignedUserBindingNames.add(entry.name)
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
              assignedUserBindingNames.add(symbol)
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
        fingerprint: entry.fingerprint,
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

function sendCompletion(response, message) {
  const names = message.observeNames ?? []
  channel.postMessage({ ...response, observing: names.length > 0 })
  if (response.error === undefined) valueObserver.record(message.program)
  if (names.length > 0) {
    channel.postMessage({ type: 'observation', id: message.id, observation: valueObserver.observe(names) })
  }
}

async function runCell(message) {
  if (activeRun !== undefined) throw new Error('kernel received overlapping cells')
  activeRun = message.id
  assignedUserBindingNames.clear()
  installBindings(message)
  const execution = {
    id: message.id,
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
            committedRedeclarations.add(name)
          },
        })
        cellGlobals.push(message.commitSignal)
        userBindings = await activateUserBindings(
          message.userBindings,
          new Set(message.shadowedUserBindingNames ?? []),
          message.userBindingsCwd,
          message.userBindingFailures,
        )
        for (const failure of userBindings.failures) {
          appendText(execution, `Global binding ${JSON.stringify(failure.id)} was not activated: ${failure.error}`)
        }
        for (const load of message.moduleLoads ?? []) {
          let namespace
          try {
            namespace = await loadStaticModule(load)
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
        return evaluate(message.program, message.returnSignal)
      })
      activeRun = undefined
      execution.open = false
      const calls = [...pending.values()]
        .filter(call => call.runId === message.id)
        .map(call => new Promise(resolve => {
          const originalResolve = call.resolve
          const originalReject = call.reject
          call.resolve = value => { originalResolve(value); resolve() }
          call.reject = error => { originalReject(error); resolve() }
        }))
      if (calls.length > 0) await Promise.all(calls)
    } catch (error) {
      activeRun = undefined
      execution.open = false
      reconcileUserBindingShadows(assignedUserBindingNames)
      const failure = error instanceof StaticImportFailure ? error.error : error
      const detail = errorDetails(failure, activeFilename)
      const position = error instanceof StaticImportFailure ? error.position : detail.position
      sendCompletion({
        type: 'done',
        id: message.id,
        logs: execution.logs,
        error: detail.message,
        errorName: detail.name,
        ...(detail.toolName === undefined ? {} : { toolName: detail.toolName }),
        ...(error instanceof StaticImportFailure ? { moduleLoadFailed: true } : {}),
        ...(position === undefined ? {} : { position }),
        ...(detail.cause === undefined ? {} : { cause: detail.cause }),
        ...(detail.failureOrigin === undefined ? {} : { failureOrigin: detail.failureOrigin }),
        ...completionDurability(execution),
        committedRedeclarations: [...committedRedeclarations],
        ...(message.userBindings === undefined ? {} : {
          activatedUserBindings: userBindings.activated,
          userBindingFailures: userBindings.failures,
          shadowedUserBindings: [...assignedUserBindingNames],
        }),
      }, message)
      return
    }

    let response
    reconcileUserBindingShadows(assignedUserBindingNames)
    try {
      const encodedValue = completion.hasValue
        ? encodeValue(completion.value, execution.valueLimits)
        : undefined
      response = {
        type: 'done',
        id: message.id,
        logs: execution.logs,
        hasValue: completion.hasValue,
        ...(encodedValue === undefined ? {} : { value: encodedValue }),
        ...completionDurability(execution),
        committedRedeclarations: [...committedRedeclarations],
        ...(message.userBindings === undefined ? {} : {
          activatedUserBindings: userBindings.activated,
          userBindingFailures: userBindings.failures,
          shadowedUserBindings: [...assignedUserBindingNames],
        }),
      }
    } catch (error) {
      const detail = messageOf(error)
      response = {
        type: 'done',
        id: message.id,
        logs: execution.logs,
        invalidOutput: detail,
        ...completionDurability(execution),
        committedRedeclarations: [...committedRedeclarations],
        ...(message.userBindings === undefined ? {} : {
          activatedUserBindings: userBindings.activated,
          userBindingFailures: userBindings.failures,
          shadowedUserBindings: [...assignedUserBindingNames],
        }),
      }
    }
    sendCompletion(response, message)
  } finally {
    for (const name of cellGlobals) delete context[name]
    activeRun = undefined
    activeExecution = undefined
    execution.open = false
  }
}

channel.on('message', (message) => {
  if (message?.type === 'prepare') {
    channel.postMessage({ type: 'ready', id: message.id })
    return
  }
  if (message?.type === 'reply') {
    const call = pending.get(message.id)
    if (call === undefined || call.runId !== message.runId) return
    pending.delete(message.id)
    if (message.ok) call.resolve(decodeValue(message.value, activeExecution?.valueLimits))
    else if (call.errorClass === undefined) {
      const error = new Error(message.error)
      if (message.cause !== undefined) error.ptcCause = message.cause
      call.reject(error)
    } else call.reject(new context[call.errorClass.name](call.member, message.error, message.cause))
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
  parentPort.postMessage({ type: 'ready', port: port1 }, [port1])
} catch (error) {
  parentPort.postMessage({
    type: 'startup-error',
    error: `PTC runtime prerequisite failed on Node ${process.version}: ${messageOf(error)}. No user cell executed; use a DSH-supported runtime that passes the REPL conformance probe. Editing the cell cannot fix this host failure.`,
  })
} finally {
  clearTimeout(startupTimer)
}
