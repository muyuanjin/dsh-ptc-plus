import { Buffer } from 'node:buffer'
import { createHash, Hash } from 'node:crypto'
import { SourceMap, stripTypeScriptTypes } from 'node:module'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'
import { TextDecoder, TextEncoder, types } from 'node:util'
import { Script } from 'node:vm'
import { readFileSync } from 'node:fs'
import { compilerDescriptors } from './compiler-descriptors.js'

const apply = Reflect.apply
const define = compilerDescriptors.defineProperty
const descriptor = Object.getOwnPropertyDescriptor
// Node's named ESM exports can be updated by syncBuiltinESMExports. The bridge
// retains operations captured before user execution, not their live bindings.
const NativeURL = URL, NativeSourceMap = SourceMap
const NativeScript = Script, nativeReadFileSync = readFileSync
const NativeTextEncoder = TextEncoder, NativeTextDecoder = TextDecoder
const nativeCreateHash = createHash, nativeFileURLToPath = fileURLToPath
const nativePathToFileURL = pathToFileURL
const nativeStripTypeScriptTypes = stripTypeScriptTypes
const runInContext = Script.prototype.runInContext
const NativeUint8Array = Uint8Array
const NativeWeakRef = WeakRef, deref = WeakRef.prototype.deref
const NativeError = Error
const parseJson = JSON.parse
const hasOwn = Object.hasOwn
const byteLength = Buffer.byteLength
const codecs = {
  utf8: { write: Buffer.prototype.utf8Write, slice: Buffer.prototype.utf8Slice },
  utf16le: { write: Buffer.prototype.ucs2Write, slice: Buffer.prototype.ucs2Slice },
  base64: { write: Buffer.prototype.base64Write, slice: Buffer.prototype.base64Slice },
}
const encoderEncode = NativeTextEncoder.prototype.encode
const encoderEncodeInto = NativeTextEncoder.prototype.encodeInto
const decoderDecode = NativeTextDecoder.prototype.decode
const hashUpdate = Hash.prototype.update, hashDigest = Hash.prototype.digest
const sourceMapEntry = NativeSourceMap.prototype.findEntry
const sourceMapOrigin = NativeSourceMap.prototype.findOrigin
const urlFields = ['href', 'protocol', 'hostname', 'pathname']
const urlGetters = urlFields.map(name => descriptor(NativeURL.prototype, name).get)
const cwd = process.cwd()
const nodeVersion = process.versions.node
const platform = process.platform
const typescript = process.features.typescript
const typeChecks = { isMap: types.isMap, isSet: types.isSet, isUint32Array: types.isUint32Array }

function nativeUrl(input, base) {
  const url = new NativeURL(input, base)
  return ownUrl(url)
}

function ownUrl(url) {
  // fileURLToPath reads these public accessors. Snapshot their captured native
  // values on the private instance before calling the platform operation.
  for (let index = 0; index < urlFields.length; index++) {
    define(url, urlFields[index], { value: apply(urlGetters[index], url, []) })
  }
  return url
}

export const compilerPlatformBridge = {
  cwd, nodeVersion, platform, typescript,
  stripTypeScriptTypes: (source, options) => nativeStripTypeScriptTypes(source, options),
  url: (input, base) => nativeUrl(input, base).href,
  fileURLToPath: input => nativeFileURLToPath(nativeUrl(input)),
  pathToFileURL: input => ownUrl(nativePathToFileURL(input)),
  encode(source, encoding) {
    const buffer = new NativeUint8Array(byteLength(source, encoding))
    const length = apply(codecs[encoding].write, buffer, [source, 0, buffer.length])
    return { buffer, length }
  },
  decode: (buffer, encoding) => apply(codecs[encoding].slice, buffer, [0, buffer.length]),
  textEncoder() {
    const encoder = new NativeTextEncoder()
    return { encode: source => apply(encoderEncode, encoder, [source]),
      encodeInto: (source, output) => apply(encoderEncodeInto, encoder, [source, output]) }
  },
  textDecoder: (label, options) => {
    const decoder = new NativeTextDecoder(label, options)
    return (input, options) => apply(decoderDecode, decoder, [input, options])
  },
  hash(algorithm) {
    const hash = nativeCreateHash(algorithm)
    return { update: (source, encoding) => { apply(hashUpdate, hash, [source, encoding]) },
      digest: encoding => apply(hashDigest, hash, [encoding]) }
  },
  sourceMap(payload) {
    const map = new NativeSourceMap(payload)
    define(map, 'findEntry', { value: sourceMapEntry })
    return { findEntry: (line, column) => apply(sourceMapEntry, map, [line, column]),
      findOrigin: (line, column) => apply(sourceMapOrigin, map, [line, column]) }
  },
  typeChecks,
}

const platformUrl = new NativeURL('../compiler-platform.cjs', import.meta.url)
const platformFilename = nativeFileURLToPath(platformUrl)
let platformScript
const dependencyFiles = { __proto__: null,
  typescript: nativeFileURLToPath(new NativeURL('../compiler-typescript.cjs', import.meta.url)),
  amaro: nativeFileURLToPath(new NativeURL('../compiler-amaro.cjs', import.meta.url)),
}
const assetManifestUrl = new NativeURL('../compiler-assets.json', import.meta.url)
const assetManifestFilename = nativeFileURLToPath(assetManifestUrl)
const assetManifestHref = assetManifestUrl.href
let assetFiles

export function installCompilerPlatform(context) {
  platformScript ??= new NativeScript(nativeReadFileSync(platformFilename, 'utf8'),
    { __proto__: null, filename: platformFilename, displayErrors: false })
  define(context, 'module', { value: { exports: {} }, configurable: true, writable: true })
  apply(runInContext, platformScript, [context, { __proto__: null, displayErrors: false }])
  const dependencies = { __proto__: null }
  const platform = context.module.exports.createPlatform({ ...compilerPlatformBridge,
    loadAsset(name) {
      assetFiles ??= parseJson(nativeReadFileSync(assetManifestFilename, 'utf8'))
      if (!hasOwn(assetFiles, name)) throw new NativeError('unknown compiler asset')
      const filename = nativeFileURLToPath(nativeUrl(assetFiles[name], assetManifestHref))
      return parseJson(nativeReadFileSync(filename, 'utf8'))
    },
    loadDependency(name) {
      // Fixed optional modules own no program state. A caller holds exports
      // during use; idle compiler realms need not pin their code or WASM data.
      let dependency = dependencies[name] === undefined ? undefined : apply(deref, dependencies[name], [])
      if (dependency === undefined) {
        const filename = dependencyFiles[name]
        const script = new NativeScript(nativeReadFileSync(filename, 'utf8'), { __proto__: null, filename, displayErrors: false })
        dependency = apply(runInContext, script, [context, { __proto__: null, displayErrors: false }])
        dependencies[name] = new NativeWeakRef(dependency)
      }
      return dependency
    },
  })
  const names = ['require', 'process', 'Buffer', 'URL', 'TextEncoder', 'TextDecoder']
  for (let index = 0; index < names.length; index++) define(context, names[index], { value: platform[names[index]] })
}
