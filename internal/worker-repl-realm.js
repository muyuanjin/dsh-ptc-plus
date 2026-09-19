import { createContext, runInContext, runInThisContext } from 'node:vm'
import { types } from 'node:util'

export const WORKER_REPL_OPTIONS = Object.freeze({ useGlobal: true })
const NativeMap = Map
const ownKeys = Reflect.ownKeys
const deleteProperty = Reflect.deleteProperty
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const defineProperty = Object.defineProperty
const createObject = Object.create
const hasOwn = Object.hasOwn
const sameValue = Object.is
const isMap = types.isMap
const mapSet = Function.prototype.call.bind(Map.prototype.set)
const mapHas = Function.prototype.call.bind(Map.prototype.has)
const mapForEach = Function.prototype.call.bind(Map.prototype.forEach)
const DESCRIPTOR_FIELDS = ['configurable', 'enumerable', 'writable', 'value', 'get', 'set']

/** Snapshot the native worker surface before Node installs REPL conveniences. */
export function captureWorkerReplGlobals(globalObject = globalThis) {
  const baseline = new NativeMap()
  const keys = ownKeys(globalObject)
  for (let index = 0; index < keys.length; index += 1) {
    mapSet(baseline, keys[index], getOwnPropertyDescriptor(globalObject, keys[index]))
  }
  return baseline
}

function descriptorsEqual(left, right) {
  const field = (descriptor, name) => descriptor !== undefined && hasOwn(descriptor, name)
    ? descriptor[name] : undefined
  return left !== undefined && right !== undefined
    && field(left, 'configurable') === field(right, 'configurable')
    && field(left, 'enumerable') === field(right, 'enumerable')
    && field(left, 'writable') === field(right, 'writable')
    && sameValue(field(left, 'value'), field(right, 'value'))
    && field(left, 'get') === field(right, 'get')
    && field(left, 'set') === field(right, 'set')
}

function detachedDescriptor(descriptor) {
  const detached = createObject(null)
  for (let index = 0; index < DESCRIPTOR_FIELDS.length; index += 1) {
    const name = DESCRIPTOR_FIELDS[index]
    if (hasOwn(descriptor, name)) detached[name] = descriptor[name]
  }
  return detached
}

/** Remove Node's REPL-only module shortcuts and restore changed native globals. */
export function restoreWorkerReplGlobals(baseline, globalObject = globalThis) {
  if (!isMap(baseline)) throw new TypeError('worker REPL global baseline must be a Map')
  const keys = ownKeys(globalObject)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (typeof key === 'string' && !mapHas(baseline, key) && !deleteProperty(globalObject, key)) {
      throw new Error(`worker REPL added a non-configurable global ${String(key)}`)
    }
  }
  mapForEach(baseline, (descriptor, key) => {
    if (!descriptorsEqual(getOwnPropertyDescriptor(globalObject, key), descriptor)) {
      defineProperty(globalObject, key, detachedDescriptor(descriptor))
    }
  })
  return globalObject
}

/** A dedicated worker is the native realm shared by its REPL and Node modules. */
export function workerReplContext(server) {
  if (server.context !== globalThis) {
    throw new Error('worker REPL did not use its native global realm')
  }
  return server.context
}

export function runInWorkerReplRealm(source, options) {
  return runInThisContext(source, options)
}

/** Control promises stay outside the user-mutable worker realm. */
export function createWorkerControlPromise() {
  return runInContext('Promise', createContext())
}

/** PTC owns settlement; the REPL's legacy domain would run Node bookkeeping
 * through user-mutable prototypes in the shared worker realm. */
export function disableWorkerReplDomain(domain) {
  domain.enter = () => domain
  domain.exit = () => domain
  return domain
}
