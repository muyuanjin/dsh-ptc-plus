import { fileURLToPath } from 'node:url'

const encodeReference = encodeURIComponent

// These ambient inputs must remain outside source-owned CommonJS bindings.
export const commonJsCompilerGlobals = new Set(['process'])

/** Node's synchronous ESM linker validates protocols before public hooks.
 * Private references therefore use a native protocol and fail if unclaimed. */
export function compilerModuleReference(kind, identity) {
  return `data:text/javascript,throw%20new%20Error(%22Unresolved%20PTC%20module%20link%22)#ptc-${kind}/${encodeReference(identity)}`
}

/** Compiler helpers resolve from their own URL, independently of source-owned
 * wrapper bindings and the ESM translator's restricted CommonJS require. */
export function commonJsCompilerImport(url) {
  return `process.getBuiltinModule('module').createRequire(${JSON.stringify(url.href)})(${JSON.stringify(fileURLToPath(url))})`
}
