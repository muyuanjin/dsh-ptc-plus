import { fileURLToPath } from 'node:url'

const encodeReference = encodeURIComponent
const objectEntries = Object.entries
const sortArray = Function.prototype.call.bind(Array.prototype.sort)
const jsonStringify = JSON.stringify

// These ambient inputs must remain outside source-owned CommonJS bindings.
export const commonJsCompilerGlobals = new Set(['process'])

/** Node's synchronous ESM linker validates protocols before public hooks.
 * Private references therefore use a native protocol and fail if unclaimed. */
export function compilerModuleReference(kind, identity) {
  return `data:text/javascript,throw%20new%20Error(%22Unresolved%20PTC%20module%20link%22)#ptc-${kind}/${encodeReference(identity)}`
}

const STATIC_LINK_KIND = 'static'
const ATTRIBUTED_LINK_KIND = 'static-attributed'

/** Reference one static link. Node 22.19 binds every edge that shares a request
 * URL to the module of the last resolution, so attribute-distinct imports of
 * one source need distinct native requests. Attribute-bearing links use their
 * own reference kind and a JSON identity, which no source specifier can equal;
 * attribute-free links keep the reference they had before attributes were
 * distinguished. */
export function staticModuleLinkReference(source, attributes) {
  const entries = objectEntries(attributes ?? {})
  if (entries.length === 0) return compilerModuleReference(STATIC_LINK_KIND, source)
  sortArray(entries, (left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
  return compilerModuleReference(ATTRIBUTED_LINK_KIND, jsonStringify([source, entries]))
}

/** Compiler helpers resolve from their own URL, independently of source-owned
 * wrapper bindings and the ESM translator's restricted CommonJS require. */
export function commonJsCompilerImport(url) {
  return `process.getBuiltinModule('module').createRequire(${jsonStringify(url.href)})(${jsonStringify(fileURLToPath(url))})`
}
