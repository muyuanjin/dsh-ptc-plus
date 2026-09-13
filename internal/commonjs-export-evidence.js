import { createRequire } from 'node:module'
import { linkCommonJsEvidenceSource } from './compiler-service.js'
import { moduleRuntimeIntrinsics } from './compiler-intrinsics.js'
import { compilerPlatformBridge } from './compiler-platform.js'
import { registerModuleResolutionHook } from './module-runtime-platform.js'

const { Map, mapGet, mapHas, mapSet, mapDelete, startsWith, sliceString, stringify } = moduleRuntimeIntrinsics
const nativeCreateRequire = createRequire

let nextEvidence = 0

/** Own analysis-only source companions for modules that actually enter Node. */
export function createCommonJsEvidence({ linkSource = linkCommonJsEvidenceSource } = {}) {
  const sources = new Map()
  const modules = new Map()
  return {
    attach(url, code, source) {
      let record = mapGet(modules, url)
      if (record?.source !== source) {
        if (record !== undefined) mapDelete(sources, record.reference)
        // CJS resolution uses its native parent filename as well as the public
        // context. A sibling preserves package and extension lookup semantics.
        const reference = compilerPlatformBridge.url(`.__ptc_commonjs_evidence_${++nextEvidence}.cjs`, url)
        const prefix = `ptc-module:evidence-link/${nextEvidence}/`
        record = { url, source, reference, prefix, evidence: linkSource(source, prefix) }
        mapSet(modules, url, record)
        mapSet(sources, reference, record)
      }
      // This final assignment only contributes native linking evidence. The
      // original module executes once and remains the source of every value.
      return `${code}\n;if(false)module.exports=require(${stringify(record.reference)});\n`
    },
    resolve(specifier, context, recordResolution) {
      if (mapHas(sources, specifier)) return { url: specifier, format: 'commonjs', shortCircuit: true }
      const source = mapGet(sources, context.parentURL)
      if (source === undefined || !startsWith(specifier, source.prefix)) return undefined
      const originalSpecifier = sliceString(specifier, source.prefix.length)
      let resolution
      const request = `ptc-module:evidence-resolution/${++nextEvidence}`
      const resolved = {}
      const forwardedContext = { ...context, parentURL: source.url }
      const dispose = registerModuleResolutionHook((value, details, next) => {
        if (value !== request) return next(value, details)
        resolution = next(originalSpecifier, forwardedContext)
        // Stop this private request at resolution. Node's existing CJS linker
        // owns the subsequent load; neither the evidence nor user code runs.
        throw resolved
      })
      try { nativeCreateRequire(source.url)(request) } catch (error) {
        if (error !== resolved) throw error
      } finally { dispose() }
      recordResolution(source.url, originalSpecifier, context.importAttributes, resolution)
      return { ...resolution, shortCircuit: true }
    },
    load(url) {
      const record = mapGet(sources, url)
      if (record === undefined) return undefined
      // Node scans reexported CJS source without executing it. A return also
      // keeps accidental direct execution from running its original body.
      return { format: 'commonjs', shortCircuit: true, source: `return;\n${record.evidence}` }
    },
  }
}
