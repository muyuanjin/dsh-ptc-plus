import { readFileSync } from 'node:fs'
import { constants, createContext, Script } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { workerData } from 'node:worker_threads'
import { deserialize } from 'node:v8'
import { copyCompilerData } from './compiler-data.js'
import { PreflightError } from './cell-analysis-contract.js'
import { ModuleRewriteError } from './cell-error.js'
import { installCompilerPlatform } from './compiler-platform.js'
import { compilerDescriptors } from './compiler-descriptors.js'

export { PreflightError } from './cell-analysis-contract.js'

const bundleUrl = new URL('../compiler-core.cjs', import.meta.url)
const filename = fileURLToPath(bundleUrl)
const directory = fileURLToPath(new URL('./', bundleUrl))
const compilerSource = readFileSync(bundleUrl, 'utf8')
const NativeScript = Script
const nativeCreateContext = createContext
const dontContextify = constants.DONT_CONTEXTIFY
const runInContext = Script.prototype.runInContext
const createCachedData = Script.prototype.createCachedData
const NativeUint8Array = Uint8Array
const apply = Reflect.apply
const hasInstance = Function.prototype[Symbol.hasInstance]
const nativeErrors = { Error, SyntaxError, TypeError, RangeError, ReferenceError,
  EvalError, URIError, ModuleRewriteError, PreflightError }
const define = compilerDescriptors.defineProperty
const keys = Object.keys
let compiler
let compilerScript
const coverageEnabled = Boolean(process.env.NODE_V8_COVERAGE)
const bytecodeFile = process.env.DSH_PTC_COMPILER_BYTECODE
let workerCache = bytecodeFile ? deserialize(readFileSync(bytecodeFile)) : undefined
if (workerCache?.source !== compilerSource) workerCache = undefined
// Bytecode contains no compiler realm or program state. Match the complete
// source: V8's cache validation alone does not prove source text equality.
let cachedData = workerData?.compilerCache?.source === compilerSource
  ? new NativeUint8Array(workerData.compilerCache.data) : undefined
// Keep the snapshot private before source code can inspect workerData.
if (workerData !== null && typeof workerData === 'object') delete workerData.compilerCache

/** Reuse compiled compiler code across fresh workers, never their realm state. */
export function compilerWorkerCache() {
  if (compilerScript === undefined) return undefined
  // Instrumented compiler instances neither produce nor consume bytecode.
  // Coverage's runner supplies a snapshot from its uninstrumented preparation.
  if (workerCache === undefined && coverageEnabled) return undefined
  workerCache ??= { source: compilerSource, data: apply(createCachedData, compilerScript, []) }
  return { source: workerCache.source, data: new NativeUint8Array(workerCache.data) }
}

/** Service errors are rehomed here before execution-realm translation. */
export const isCompilerSyntaxError = error => apply(hasInstance, nativeErrors.SyntaxError, [error])

function compilerEntry() {
  if (compiler !== undefined) return compiler
  // Workers can execute host-prepared cells without compiling dynamic source.
  // Capture source and platform before user code, but parse only on first use.
  compilerScript = new NativeScript(compilerSource, { __proto__: null, filename, displayErrors: false,
    cachedData: coverageEnabled ? undefined : cachedData })
  cachedData = undefined
  const context = nativeCreateContext(dontContextify)
  define(context, '__compilerBaseUrl', { value: import.meta.url })
  define(context, '__filename', { value: filename })
  define(context, '__dirname', { value: directory })
  installCompilerPlatform(context)
  apply(runInContext, compilerScript, [context, { __proto__: null, displayErrors: false }])
  compiler = context.module.exports.compile
  return compiler
}

function compile(operation, args, originalSource) {
  const result = compilerEntry()(operation, args, originalSource)
  if (result.error !== undefined) {
    const { kind, message, properties } = result.error
    const ErrorClass = nativeErrors[kind] ?? nativeErrors.Error
    const error = ErrorClass === PreflightError
      ? new PreflightError(message, undefined, copyCompilerData(properties.span?.value)) : new ErrorClass(message)
    const names = keys(properties)
    for (let index = 0; index < names.length; index++) {
      const name = names[index]
      const property = properties[name]
      if (name === 'stack' || !('value' in property)) continue
      define(error, name, { ...property, value: copyCompilerData(property.value) })
    }
    throw error
  }
  return copyCompilerData(result.value)
}

export const prepareProgram = (source, options) => compile('prepareProgram', [source, options])
export const prepareConsoleProgram = (source, options) => compile('prepareConsoleProgram', [source, options])
export const classifyDurability = (source, known, options) => compile('classifyDurability', [source, known, options])
export const compileModuleSource = (source, options) => compile('compileStatefulModule', [source, options])
export const detectModuleSourceFormat = (source, options) => compile('detectModuleSourceFormat', [source, options])
export const attachNamespaceSource = (source, attributes, reference, regions) =>
  compile('attachModuleNamespace', [source, attributes, reference, regions])
export const linkCommonJsEvidenceSource = (source, prefix) => compile('linkCommonJsEvidenceSource', [source, prefix])
export const identifier = (value, subject, reserved) => compile('identifier', [value, subject, reserved])
export const exportedSymbols = (source, transform) => compile('exportedSymbols', [source, transform])
export const sourceDurability = (source, transform) => compile('sourceDurability', [source, transform])
export const hashText = (source, encoding, format) => compile('hashText', [source, encoding, format])
export const deflateText = source => compile('deflateText', [source])
export const inflateText = (source, maxOutputBytes) => compile('inflateText', [source, maxOutputBytes])
export const createCallableSourceCatalog = (buffers, ranges) => compile('createCallableSourceCatalog', [buffers, ranges])
export function compileDynamicSource(source, { resolveOriginalSource, ...options } = {}) {
  return compile('compileDynamicEnvironmentSource', [source, options], resolveOriginalSource)
}
