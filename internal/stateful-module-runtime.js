import { compilerModuleReference } from './compiler-module-links.js'
import { compilerDescriptors } from './compiler-descriptors.js'
import { fileURLToPath, registerModuleResolutionHook } from './module-runtime-platform.js'
import { moduleCompilerIntrinsics, moduleRuntimeIntrinsics } from './compiler-intrinsics.js'
export { pathToFileURL } from './module-runtime-platform.js'

// Node owns URLs, graph membership and evaluation. Only loader-proved export
// relations may decode the transport used by compiled source.
const { Object, Reflect, Map, Set, WeakMap, Proxy, mapGet, mapSet, mapForEach,
  setHas, setAdd, weakMapGet, weakMapSet, sort, compare, startsWith, stringify, observeOwnedPromise } = moduleRuntimeIntrinsics
const modules = new Map()
const namespaces = new WeakMap()
const adapters = new Map()
const adapterRequests = new Map()
const adapterModules = new Map()
const staticLinks = new Map()
let nextAdapter = 0

// Native imports make these helpers available to hoisted functions before the
// importing module evaluates, without consulting any source-owned bindings.
export const moduleBindingIntrinsics = moduleCompilerIntrinsics

function moduleRecord(url) {
  let record = mapGet(modules, url)
  if (record === undefined) {
    record = { resolutions: new Map(), links: new Map() }
    mapSet(modules, url, record)
  }
  return record
}

/** Reserve the compiler's closed interface before Node instantiates cycles. */
export function reserveStatefulModule(url, moduleInterface) {
  const record = moduleRecord(url)
  record.interface = moduleInterface
  record.exports = new Map()
  if (moduleInterface === undefined) return
  for (let index = 0; index < moduleInterface.exports.length; index++) {
    const descriptor = moduleInterface.exports[index]
    mapSet(record.exports, descriptor.name, descriptor)
  }
}

function resolutionKey(specifier, attributes) {
  const entries = Object.entries(attributes ?? {})
  sort(entries, (left, right) => compare(left[0], right[0]))
  return stringify([specifier, entries])
}

/** Capture the native linker's actual attribute-aware source relation. */
export function recordStatefulModuleResolution(parentUrl, specifier, attributes, url) {
  mapSet(moduleRecord(parentUrl).resolutions, resolutionKey(specifier, attributes), url)
}

/** Compiler-owned source references distinguish static links from later requests. */
export function statefulModuleLink(source) {
  const reference = compilerModuleReference('static', source)
  mapSet(staticLinks, reference, source)
  return reference
}

/** Resolve the original source through the complete current public hook chain. */
export function resolveStatefulModuleLink(reference, context) {
  const source = mapGet(staticLinks, reference)
  if (source === undefined) return undefined
  const parentUrl = context.parentURL
  const attributes = { ...context.importAttributes }
  let resolution
  let failure
  const request = `ptc-module:resolve/${++nextAdapter}`
  const dispose = registerModuleResolutionHook((specifier, details, nextResolve) => {
    if (specifier !== request) return nextResolve(specifier, details)
    try {
      resolution = nextResolve(source, context)
      return resolution
    } catch (error) {
      failure = { error }
      throw error
    }
  })
  try {
    // This native operation resolves only; the original linker still owns all
    // loading, export validation, evaluation ordering and cyclic instantiation.
    import.meta.resolve(request)
  } finally {
    dispose()
  }
  // import.meta.resolve converts some native not-found errors into URLs. The
  // actual static linker must receive that exact original failure instead.
  if (failure !== undefined) throw failure.error
  mapSet(moduleRecord(parentUrl).links, resolutionKey(source, attributes), resolution.url)
  return { ...resolution, shortCircuit: true }
}

/** Native self namespaces settle exported membership, including require interop. */
export function recordStatefulModuleNamespace(url, namespace) {
  const names = Reflect.ownKeys(namespace)
  const keys = new Set()
  for (let index = 0; index < names.length; index++) setAdd(keys, names[index])
  moduleRecord(url).nativeKeys = keys
}

function sourceUrl(parent, source, attributes) {
  const record = mapGet(modules, parent)
  const key = resolutionKey(source, attributes)
  return record === undefined ? undefined : mapGet(record.links, key) ?? mapGet(record.resolutions, key)
}

function exportTransport(url, name, visited = new Set()) {
  const record = mapGet(modules, url)
  const plan = record?.interface
  if (plan === undefined) return record?.nativeKeys !== undefined && setHas(record.nativeKeys, name) ? { kind: 'native' } : undefined
  const key = stringify([url, name])
  if (setHas(visited, key)) return undefined
  setAdd(visited, key)
  const descriptor = mapGet(record.exports, name)
  if (descriptor !== undefined) {
    if (descriptor.kind === 'accessor' || descriptor.kind === 'native') return descriptor
    const provider = sourceUrl(url, descriptor.source, descriptor.attributes)
    return descriptor.kind === 'namespace' ? { kind: 'namespace', url: provider }
      : mapGet(modules, provider)?.interface === undefined ? { kind: 'native' }
        : exportTransport(provider, descriptor.imported, visited)
  }
  if (name === 'default') return undefined
  // Node's namespace keys have already excluded ambiguous star exports. An
  // uncompiled provider cannot contribute an accessor; no value is inspected.
  for (let index = 0; index < plan.stars.length; index++) {
    const star = plan.stars[index]
    const transport = exportTransport(sourceUrl(url, star.source, star.attributes), name, visited)
    if (transport !== undefined) return transport
  }
  return undefined
}

function decode(url, name, value) {
  const transport = exportTransport(url, name)
  if (transport?.kind === 'accessor') return value().v
  if (transport?.kind === 'namespace') return managedModuleNamespace(transport.url, value)
  return value
}

/** Read lazily, including hoisted accesses before a provider's body executes. */
export function readModuleImport(parentUrl, specifier, name, getNative, attributes) {
  const url = sourceUrl(parentUrl, specifier, attributes)
  const native = getNative()
  return name === null ? managedModuleNamespace(url, native) : decode(url, name, native)
}

/** Stable readonly reflection with exact live values, without a native brand. */
export function managedModuleNamespace(url, native) {
  const cached = weakMapGet(namespaces, native)
  if (cached !== undefined) return cached
  const keys = Reflect.ownKeys(native)
  let managed = false
  for (let index = 0; index < keys.length; index++) {
    if (typeof keys[index] !== 'string') continue
    const kind = exportTransport(url, keys[index])?.kind
    if (kind === 'accessor' || kind === 'namespace') { managed = true; break }
  }
  if (!managed) return native
  const target = Object.create(null)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    Object.defineProperty(target, key, typeof key === 'string'
      ? { value: undefined, enumerable: true, writable: true, configurable: false }
      : Object.getOwnPropertyDescriptor(native, key))
  }
  Object.preventExtensions(target)
  const read = key => typeof key === 'string' && Object.hasOwn(target, key) ? decode(url, key, native[key]) : native[key]
  const namespace = new Proxy(target, {
    get: (_, key) => read(key),
    getOwnPropertyDescriptor(_, key) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      if (descriptor !== undefined && typeof key === 'string') descriptor.value = read(key)
      return descriptor
    },
    set: () => false,
    defineProperty(_, key, descriptor) {
      descriptor = compilerDescriptors.descriptor(descriptor)
      const current = Object.getOwnPropertyDescriptor(target, key)
      if (current === undefined) return false
      if (typeof key !== 'string') return Reflect.defineProperty(target, key, descriptor)
      return !('get' in descriptor || 'set' in descriptor) && descriptor.configurable !== true
        && descriptor.enumerable !== false && descriptor.writable !== false
        && (!('value' in descriptor) || Object.is(descriptor.value, read(key)))
    },
    deleteProperty: (_, key) => !Object.hasOwn(target, key),
  })
  weakMapSet(namespaces, native, namespace)
  weakMapSet(namespaces, namespace, namespace)
  return namespace
}

/** Import a non-then wrapper, then assimilate the source's real then exactly once. */
const nativeModuleRealm = {
  Promise,
  stringify: value => `${value}`,
  importModule: (source, options) => import(source, options),
}

export function managedModuleImport(parentUrl, specifier, options, realm = nativeModuleRealm) {
  return new realm.Promise((resolve, reject) => {
    // Template conversion follows native import's ToString (including Symbols).
    const source = realm.stringify(specifier)
    const key = stringify([parentUrl, source])
    let url = mapGet(adapterRequests, key)
    if (url === undefined) {
      url = `ptc-module:request/${++nextAdapter}`
      mapSet(adapterRequests, key, url)
      mapSet(adapters, url, { kind: 'request', parentUrl, source })
    }
    // Public synchronous resolve hooks run within the import expression. This
    // scope includes hooks registered by user code after PTC's loader, while
    // the cached wrapper later consumes the resolved edge without repeating it.
    const dispose = registerModuleResolutionHook((request, context, nextResolve) => {
      if (request !== url) return nextResolve(request, context)
      const resolution = nextResolve(source, { ...context, parentURL: parentUrl })
      const attributes = resolution.importAttributes ?? context.importAttributes
      return { url: resolveManagedModuleAdapter(resolution, attributes), format: 'module',
        importAttributes: attributes, shortCircuit: true }
    })
    try {
      const promise = realm.importModule(url, options)
      observeOwnedPromise(promise, wrapper => {
        resolve(managedModuleNamespace(wrapper.url, wrapper.namespace))
      }, reject)
    } finally {
      dispose()
    }
  })
}

/** Private virtual entries preserve native import option validation and linking. */
export function managedModuleAdapter(url) { return mapGet(adapters, url) }

/** Reuse evaluated wrappers only after this call's native resolution succeeds. */
function resolveManagedModuleAdapter(resolution, attributes) {
  const key = stringify([resolutionKey(resolution.url, attributes), resolution.format])
  let url = mapGet(adapterModules, key)
  if (url === undefined) {
    url = `ptc-module:namespace/${++nextAdapter}`
    mapSet(adapterModules, key, url)
    mapSet(adapters, url, { kind: 'module', source: `${url}/source`, resolution, attributes })
  }
  return url
}

export function loadManagedModuleAdapter(url) {
  const adapter = mapGet(adapters, url)
  if (adapter?.kind !== 'module') return undefined
  const entries = Object.entries(adapter.attributes ?? {})
  let suffix = ''
  for (let index = 0; index < entries.length; index++) {
    suffix += `${index === 0 ? ' with {' : ','}${stringify(entries[index][0])}:${stringify(entries[index][1])}`
  }
  if (entries.length > 0) suffix += '}'
  return { format: 'module', shortCircuit: true,
    source: `import * as namespace from ${stringify(adapter.source)}${suffix};export {namespace};export const url=${stringify(adapter.resolution.url)};` }
}

/** Only PTC-provided require paths decode formally compiled ESM returns. */
export function managedRequire(parentUrl, nativeRequire) {
  const acquire = (target, receiver, args) => {
    let url
    let value
    const dispose = registerModuleResolutionHook((source, context, nextResolve) => {
      const result = nextResolve(source, context)
      if (source === args[0] && url === undefined) url = result.url
      return result
    })
    try {
      value = Reflect.apply(target, receiver, args)
    } finally {
      dispose()
    }
    // Node may satisfy a CommonJS relative-resolution cache hit without
    // invoking resolve hooks. Its exact cached exports identity still proves
    // the compiled URL; do not resolve or evaluate the request a second time.
    if (url === undefined) {
      mapForEach(modules, (record, candidate) => {
        if (url !== undefined) return
        const cached = record.interface !== undefined && startsWith(candidate, 'file:')
          ? nativeRequire.cache?.[fileURLToPath(candidate)] : undefined
        if (record.interface !== undefined && cached !== undefined && cached.exports === value) {
          url = candidate
        }
      })
    }
    const record = mapGet(modules, url)
    const plan = record?.interface
    if (plan === undefined) return value
    return setHas(record.nativeKeys, 'module.exports')
      ? decode(url, 'module.exports', value) : managedModuleNamespace(url, value)
  }
  return new Proxy(nativeRequire, {
    apply: acquire,
    construct(target, args, newTarget) {
      // Native require is a base function. Decode inside its construction frame
      // so a primitive interop value retains native constructor return rules.
      return Reflect.construct(function (...values) { return acquire(target, this, values) }, args, newTarget)
    },
  })
}
