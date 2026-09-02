import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { formatWithOptions } from 'node:util'
import { MessageChannel, parentPort, workerData } from 'node:worker_threads'
import { synchronizeBuiltinEsmExports } from './builtin-esm-sync.js'
import { errorDetails, messageOf } from './failure-reporting.js'
import { AMBIENT_GLOBALS, DURABLE_IMPORTS, FORBIDDEN_IMPORTS } from './module-policy.js'
import { decodeValue, encodeValue } from './value-wire.js'
import { installWorkerCwdVirtualization } from './worker-cwd-virtualization.js'

if (parentPort === null) throw new Error('ptc-plus kernel worker started without a parent port')
const { port1, port2: channel } = new MessageChannel()

const input = new PassThrough()
const output = new PassThrough()
output.resume()
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
})
const context = server.context
const REPL_IMPORT_CANARY = 'data:text/javascript,export default 1'
let replParent
const sessionReplParent = sessionCwd === undefined ? undefined : pathToFileURL(resolve(sessionCwd, 'repl')).href
const staticAdapterParents = new Set()
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === REPL_IMPORT_CANARY && replParent === undefined) replParent = context.parentURL
    return nextResolve(specifier, context.parentURL === replParent || staticAdapterParents.has(context.parentURL)
      ? { ...context, parentURL: sessionReplParent ?? replParent }
      : context)
  },
})
const logScope = new AsyncLocalStorage()
const pending = new Map()
const installedGlobals = new Set()
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

function evaluate(program) {
  return new Promise((resolve, reject) => {
    // REPLServer routes runtime throws to its domain instead of the eval
    // callback. Cells are serialized, so temporarily replacing that one error
    // handler gives both syntax and runtime failures one settlement path.
    const domain = server._domain
    const prior = domain.listeners('error')
    domain.removeAllListeners('error')
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      domain.removeListener('error', onError)
      for (const listener of prior) domain.on('error', listener)
      if (error instanceof CellReturn) {
        Promise.resolve(error.value).then(
          value => resolve({ hasValue: true, value }),
          reject,
        )
      } else if (error) reject(error)
      else {
        Promise.resolve(value).then(
          value => resolve({ hasValue: value !== undefined, value }),
          reject,
        )
      }
    }
    const onError = error => finish(error)
    domain.on('error', onError)
    activeFilename = `ptc-plus-repl-${++filenameSequence}`
    server.eval(program + CELL_FRAME_SUFFIX, context, activeFilename, finish)
  })
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
  if (activeRun !== runId) return Promise.reject(new Error('PTC execution lease expired'))
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

function installBindings(message) {
  for (const name of installedGlobals) delete context[name]
  installedGlobals.clear()

  for (const namespace of message.namespaces) {
    const view = Object.create(null)
    const emptyObjectMembers = new Set(namespace.emptyObjectMembers ?? [])
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
      Object.defineProperty(context, descriptor.name, { configurable: true, value: BoundError })
      installedGlobals.add(descriptor.name)
    }
  }
}

async function runCell(message) {
  if (activeRun !== undefined) throw new Error('kernel received overlapping cells')
  activeRun = message.id
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
        return evaluate(message.program)
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
      const failure = error instanceof StaticImportFailure ? error.error : error
      const detail = errorDetails(failure, activeFilename)
      const position = error instanceof StaticImportFailure ? error.position : detail.position
      channel.postMessage({
        type: 'done',
        id: message.id,
        logs: execution.logs,
        error: detail.message,
        errorName: detail.name,
        ...(detail.toolName === undefined ? {} : { toolName: detail.toolName }),
        ...(error instanceof StaticImportFailure ? { moduleLoadFailed: true } : {}),
        ...(position === undefined ? {} : { position }),
        ...(detail.cause === undefined ? {} : { cause: detail.cause }),
        ...completionDurability(execution),
        committedRedeclarations: [...committedRedeclarations],
      })
      return
    }

    let response
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
      }
    }
    channel.postMessage(response)
  } finally {
    for (const name of cellGlobals) delete context[name]
    activeRun = undefined
    activeExecution = undefined
    execution.open = false
  }
}

channel.on('message', (message) => {
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

try {
  await evaluate(CONFORMANCE_CELL)
  parentPort.postMessage({ type: 'ready', port: port1 }, [port1])
} catch (error) {
  parentPort.postMessage({
    type: 'startup-error',
    error: `Node REPL does not satisfy the PTC Plus cell framing contract: ${messageOf(error)}`,
  })
}
