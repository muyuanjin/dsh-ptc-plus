import { compilerModuleReference } from './compiler-module-links.js'
import { readFileSync } from 'node:fs'
import { createRequire, findPackageJSON } from 'node:module'
import { basename, extname } from 'node:path'
import { compileModuleSource, detectModuleSourceFormat, attachNamespaceSource,
  linkCommonJsEvidenceSource } from './compiler-service.js'
import { managedModuleAdapter, loadManagedModuleAdapter, recordStatefulModuleResolution, reserveStatefulModule,
  statefulModuleLink, resolveStatefulModuleLink } from './stateful-module-runtime.js'
import { createCommonJsEvidence } from './commonjs-export-evidence.js'
import { USER_BINDING_TRANSFORM } from './module-transform-contract.js'
import { createDynamicEnvironmentRuntime } from './dynamic-environment-runtime.js'
import { moduleRuntimeIntrinsics } from './compiler-intrinsics.js'
import { compilerPlatformBridge } from './compiler-platform.js'

const { Map, Set, Object, Reflect, mapGet, mapHas, mapSet, setHas, setAdd, includes, startsWith,
  replaceAllString, includesString } = moduleRuntimeIntrinsics
const readSourceFile = readFileSync, nativeCreateRequire = createRequire, packageJsonPath = findPackageJSON
const pathBasename = basename, pathExtension = extname, parseJson = JSON.parse
const bufferFrom = Buffer.from, bufferToString = Buffer.prototype.toString
const sourceText = source => typeof source === 'string' ? source
  : Reflect.apply(bufferToString, bufferFrom(source), ['utf8'])
const sourcePath = compilerPlatformBridge.fileURLToPath

// Dependencies installed under a package's node_modules belong to Node's
// module owner. Compiling them as if they were session source needlessly
// parses and retains large third-party programs (for example TypeScript),
// while providing no PTC binding continuity: only session-owned modules can
// publish logical bindings. Namespace adaptation still wraps their native
// result at the managed module boundary.
function isExternalDependency(url) {
  if (!startsWith(url, 'file:')) return false
  const path = replaceAllString(sourcePath(url), '\\', '/')
  return includesString(path, '/node_modules/')
}

/** Source generation returns link facts; the runtime owns registration. */
export function compileStatefulModule(source, options) {
  const prepared = compileModuleSource(source, options)
  for (let index = 0; index < prepared.staticLinks.length; index++) {
    const link = prepared.staticLinks[index]
    statefulModuleLink(link.source, link.reference)
  }
  // Install reflection facts before Node can expose hoisted exports to a
  // cyclic importer. Catalog data never enters the user's executable source.
  if (prepared.callableSources?.length > 0) {
    createDynamicEnvironmentRuntime().installIntrinsics().registerSources(prepared.callableSources)
  }
  return prepared
}

function commonJsLoadFormat(url, source) {
  if (!startsWith(url, 'file:')) return undefined
  const extension = pathExtension(sourcePath(url))
  if (extension === '.mjs' || extension === '.mts') return 'module'
  if (extension === '.cjs' || extension === '.cts') return 'commonjs'
  if (extension !== '.js' && extension !== '.ts' && extension !== '') return undefined
  const packagePath = packageJsonPath(url)
  if (packagePath !== undefined && pathBasename(packagePath) === 'package.json') {
    const type = parseJson(readSourceFile(packagePath, 'utf8')).type
    if (type === 'module' || type === 'commonjs') return type
  }
  return detectModuleSourceFormat(source, { extension })
}

let nextNamespaceReference = 0
function attachModuleNamespace(url, source, attributes, references, sourceRegions) {
  const reference = compilerModuleReference('self', ++nextNamespaceReference)
  mapSet(references, reference, url)
  const text = sourceText(source)
  return attachNamespaceSource(text, attributes, reference, sourceRegions)
}

/** Track execution-owned module graphs without changing Node's URL identity. */
export function createUserModuleCompilationHooks({ transformForParent = () => undefined } = {}) {
  const modules = new Map()
  const compiled = new Set()
  const loaded = new Set()
  const interfaces = new Map()
  const namespaceReferences = new Map()
  const sourceRegionPlans = new Map()
  const commonJsSources = new Map()
  const commonJsEvidence = createCommonJsEvidence({ linkSource: linkCommonJsEvidenceSource })
  const bootstrapFiles = new Set()
  const bootstrapNames = Object.keys(nativeCreateRequire(import.meta.url).cache)
  for (let index = 0; index < bootstrapNames.length; index++) setAdd(bootstrapFiles, bootstrapNames[index])
  const internalRoot = compilerPlatformBridge.url('./', import.meta.url)
  const mark = (url, { transform = USER_BINDING_TRANSFORM, compiled: prepared = false, moduleInterface, commonJsSource, sourceRegions } = {}) => {
    if (!setHas(compiled, url) && !setHas(loaded, url)) mapSet(modules, url, transform)
    if (prepared) {
      setAdd(compiled, url)
      mapSet(sourceRegionPlans, url, sourceRegions)
      if (commonJsSource !== undefined) mapSet(commonJsSources, url, commonJsSource)
      if (moduleInterface !== undefined) {
        mapSet(interfaces, url, moduleInterface)
        reserveStatefulModule(url, moduleInterface)
      }
    }
  }
  const recordResolution = (parentUrl, specifier, importAttributes, result) => {
    recordStatefulModuleResolution(parentUrl, specifier, importAttributes, result.url)
    const transform = mapGet(modules, parentUrl) ?? transformForParent(parentUrl)
    // Runtime links are outside the user compilation graph. Skipping only
    // their load would still propagate user transforms to their dependencies.
    if (transform !== undefined && !startsWith(result.url, 'node:')
      && !startsWith(result.url, internalRoot) && !isExternalDependency(result.url)) mark(result.url, { transform })
  }
  return {
    mark,
    resolve(specifier, context, nextResolve) {
      const evidence = commonJsEvidence.resolve(specifier, context, recordResolution)
      if (evidence !== undefined) return evidence
      const link = resolveStatefulModuleLink(specifier, context)
      if (link !== undefined) return link
      const namespaceUrl = mapGet(namespaceReferences, specifier)
      if (namespaceUrl !== undefined) return { url: namespaceUrl, shortCircuit: true }
      const parentUrl = context.parentURL
      const parentAdapter = managedModuleAdapter(parentUrl)
      if (parentAdapter?.kind === 'module' && specifier === parentAdapter.source) {
        return { ...parentAdapter.resolution, shortCircuit: true }
      }
      const importAttributes = { ...context.importAttributes }
      const result = nextResolve(specifier, context)
      recordResolution(parentUrl, specifier, importAttributes, result)
      return result
    },
    load(url, context, nextLoad) {
      const evidence = commonJsEvidence.load(url)
      if (evidence !== undefined) return evidence
      const attributes = { ...context.importAttributes }
      const adapter = loadManagedModuleAdapter(url, attributes)
      if (adapter !== undefined) return adapter
      const result = nextLoad(url, context)
      const transform = mapGet(modules, url)
      if (transform === undefined
        || startsWith(url, internalRoot)
        || startsWith(url, 'file:') && setHas(bootstrapFiles, sourcePath(url))) return result
      if (setHas(compiled, url)) return mapHas(interfaces, url)
        ? { ...result, source: attachModuleNamespace(url, result.source, attributes, namespaceReferences, mapGet(sourceRegionPlans, url)) }
        : mapHas(commonJsSources, url) ? { ...result, source: commonJsEvidence.attach(url, result.source, mapGet(commonJsSources, url)) } : result
      const formats = ['module', 'commonjs', 'module-typescript', 'commonjs-typescript']
      if (result.format !== undefined && result.format !== 'typescript' && !includes(formats, result.format)) return result
      const source = result.source ?? readSourceFile(sourcePath(url))
      const text = sourceText(source)
      const format = result.format === undefined || result.format === 'typescript' ? commonJsLoadFormat(url, text) : result.format
      if (!includes(formats, format)) return result
      const target = startsWith(format, 'commonjs') ? 'commonjs' : 'module'
      const prepared = compileStatefulModule(text, { transform, target, url })
      setAdd(loaded, url)
      if (target === 'module') reserveStatefulModule(url, prepared.moduleInterface)
      return { ...result, format: target, source: target === 'module' ? attachModuleNamespace(url, prepared.code, attributes, namespaceReferences, prepared.sourceRegions)
        : commonJsEvidence.attach(url, prepared.code, prepared.commonJsSource) }
    },
  }
}
