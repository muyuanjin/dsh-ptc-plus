import { staticModuleLinkReference } from './compiler-module-links.js'
import { parse } from '@babel/parser'
import { types as t } from '@babel/core'
import { CELL_PARSER_PLUGINS, normalizeStatefulScopes, normalizeTypeScriptValues, lowerNativeLanguageSource,
  hasModuleResources } from './repl-scope-normalizer.js'
import { bindingNodes, createGeneratedNameAllocator } from './binding-pattern.js'
import { applySourceEdits, identitySourceMap, sourceOffsetAt } from './source-position-map.js'
import { applyRegionEdits, indexSourceRegions, visitRegionSource, transformRegionSource, validateRegionSource, sourceRegionData } from './compiler-region-output.js'
import { adaptDynamicCell } from './dynamic-environment-integration.js'
import { adaptLegacyModuleReferences, adaptModuleOperations } from './managed-module-operations.js'
import { markCallableSources, collectRegionCallableRanges, createRegionCallableCollector, emitRegionCallableSources, callableSourceCatalog } from './callable-source-facts.js'
import { commonJsExportEvidence } from './commonjs-source-evidence.js'
export { commonJsExportEvidence, linkCommonJsEvidenceSource } from './commonjs-source-evidence.js'
import { COMMONJS_PARAMETERS } from './compiler-scope-facts.js'
import {
  LEGACY_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM,
  supportedUserBindingTransform, transformTypeScriptSource,
} from './typescript-transform.js'

const topLevelRegion = region => region.kind === 'program' || region.top === true

/** Keep one native export mapping while executing every source occurrence. */
function normalizeModuleExports(source, sourceMap) {
  const tree = parse(source, { sourceType: 'module', errorRecovery: true,
    plugins: CELL_PARSER_PLUGINS })
  for (const error of tree.errors) if (error.reasonCode === 'ModuleExportUndefined') throw error
  const allocate = createGeneratedNameAllocator(tree)
  const exports = new Map()
  const edits = []
  const anonymousFunctions = []
  const dependencyEdits = []
  const exportName = node => node.type === 'Identifier' ? node.name : node.value
  for (const statement of tree.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration
      const named = ['FunctionDeclaration', 'ClassDeclaration'].includes(declaration.type)
      if (declaration.type === 'FunctionDeclaration' && declaration.id === null) {
        // Its synthetic native binding is inaccessible to source writes. Keep
        // instantiation-time identity and the native inferred name "default".
        exports.set('default', { nativeFunction: statement })
        anonymousFunctions.push(statement)
        continue
      }
      const local = named && declaration.id !== null ? declaration.id.name : allocate('module_default')
      exports.set('default', local)
      if (named && declaration.id !== null) {
        edits.push({ start: statement.start, end: declaration.start, text: '' })
      } else {
        const value = source.slice(declaration.start, declaration.end)
        const anonymous = declaration.type === 'ClassDeclaration'
          || ['FunctionExpression', 'ClassExpression', 'ArrowFunctionExpression'].includes(declaration.type) && declaration.id == null
        edits.push({ start: statement.start, end: statement.end,
          text: `let ${local} = (${anonymous ? `({default: (${value})}).default` : value});` })
      }
      continue
    }
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration
    if (declaration !== null && declaration !== undefined) {
      const names = declaration.type === 'VariableDeclaration'
        ? declaration.declarations.flatMap(item => bindingNodes(item.id)).map(item => item.name)
        : declaration.id?.type === 'Identifier' ? [declaration.id.name] : []
      for (const name of names) exports.set(name, name)
      edits.push({ start: statement.start, end: declaration.start, text: '' })
      continue
    }
    const dependencies = []
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === 'type') continue
      const name = exportName(specifier.exported)
      if (statement.source === null || statement.source === undefined) {
        exports.set(name, exportName(specifier.local))
      } else {
        const local = allocate('module_export')
        const binding = specifier.type === 'ExportNamespaceSpecifier'
          ? `* as ${local}` : `{ ${JSON.stringify(exportName(specifier.local))} as ${local} }`
        const dependency = `import ${binding} from ${source.slice(statement.source.start, statement.end)}`
        const mapping = specifier.type === 'ExportNamespaceSpecifier' ? `* as ${JSON.stringify(name)}`
          : `{ ${JSON.stringify(exportName(specifier.local))} as ${JSON.stringify(name)} }`
        const selected = { native: `export ${mapping} from ${source.slice(statement.source.start, statement.end)}` }
        exports.set(name, selected)
        dependencies.push({ name, selected, dependency })
      }
    }
    if (statement.source != null && statement.specifiers.length === 0) {
      dependencies.push(`import ${source.slice(statement.source.start, statement.end)}`)
    }
    dependencyEdits.push({ start: statement.start, end: statement.end, dependencies })
  }
  for (const statement of anonymousFunctions) {
    if (exports.get('default')?.nativeFunction !== statement) {
      // An anonymous function declaration has no initializer effects or local
      // source name once a later export mapping replaces its only exposure.
      edits.push({ start: statement.start, end: statement.end, text: '' })
    }
  }
  for (const { start, end, dependencies } of dependencyEdits) {
    // A retained native re-export already owns linking. An extra named import
    // can make Node reject an otherwise valid cyclic forwarding graph. Only
    // replaced mappings need a separate import to retain their source effects
    // and missing-export validation.
    edits.push({ start, end, text: dependencies.filter(item => typeof item === 'string' || exports.get(item.name) !== item.selected)
      .map(item => typeof item === 'string' ? item : item.dependency).join('\n') })
  }
  const locals = [...exports].filter(([, binding]) => typeof binding === 'string')
  const native = [...exports.values()].filter(binding => binding.native !== undefined).map(binding => binding.native)
  if (exports.size > 0) edits.push({ start: source.length, end: source.length,
    text: `\n${locals.length > 0 ? `export { ${locals.map(([name, local]) => `${local} as ${JSON.stringify(name)}`).join(', ')} };\n` : ''}${native.join('\n')}\n` })
  return applySourceEdits(source, sourceMap, edits)
}

function moduleLinkPlan(source) {
  const tree = parse(source, { sourceType: 'module', errorRecovery: true,
    allowUndeclaredExports: true, plugins: CELL_PARSER_PLUGINS })
  const allocate = createGeneratedNameAllocator(tree)
  const reader = allocate('module_import_read')
  const nativeReader = allocate('module_native_read')
  const internalBindings = [reader, nativeReader]
  const exports = []
  const stars = []
  const exportName = node => node.name ?? node.value
  for (const statement of tree.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') exports.push({ name: 'default', kind: 'native' })
    if (!['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type)) continue
    const relation = statement.source ? { source: statement.source.value,
      attributes: Object.fromEntries((statement.attributes ?? [])
        .map(attribute => [exportName(attribute.key), attribute.value.value])) } : undefined
    if (statement.type === 'ExportAllDeclaration') stars.push(relation)
    else for (const item of statement.specifiers) {
      const name = exportName(item.exported)
      exports.push(relation === undefined ? { name, kind: 'accessor' }
        : item.type === 'ExportNamespaceSpecifier' ? { name, kind: 'namespace', ...relation }
          : { name, kind: 'forward', imported: exportName(item.local), ...relation })
    }
  }
  const runtime = new URL('./stateful-module-runtime.js', import.meta.url).href
  return { reader, internalBindings, moduleInterface: { exports, stars },
    prefix: `import {readModuleImport as ${nativeReader}} from ${JSON.stringify(runtime)};\nfunction ${reader}(source,name,get,attributes){return ${nativeReader}(import.meta.url,source,name,get,attributes)}\n` }
}

function adaptStaticModuleLinks(normalized, staticLinks) {
  const edits = []
  visitRegionSource(normalized, { sourceType: 'module', plugins: CELL_PARSER_PLUGINS }, input => {
    for (const node of input.selected.body) {
      if (node.source == null || !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) continue
      const source = node.source.value
      const attributes = Object.fromEntries((node.attributes ?? []).map(item => [item.key.name ?? item.key.value, item.value.value]))
      const reference = staticModuleLinkReference(source, attributes)
      staticLinks.push({ source, reference })
      edits.push({ start: sourceOffsetAt(input.sourceMap, node.source.start),
        end: sourceOffsetAt(input.sourceMap, node.source.end - 1) + 1,
        text: JSON.stringify(reference) })
    }
  }, topLevelRegion)
  return applyRegionEdits(normalized, edits)
}

function commonJsBodyRange(source) {
  const body = parse(source).program.body[0].body
  return { start: body.start + 1, end: body.end - 1 }
}

/** Module activations share lexical updates while retaining the native linker. */
export function compileStatefulModule(source, {
  transform = USER_BINDING_TRANSFORM, target = 'module', url, nativeUsing,
} = {}) {
  if (transform !== PROTECTED_MODULE_TRANSFORM && !supportedUserBindingTransform(transform)) {
    throw new TypeError('user binding snapshot cannot prove its historical TypeScript transform')
  }
  const staticLinks = []
  const sourceType = target === 'commonjs' ? 'commonjs' : 'module'
  const callableParserOptions = { sourceType, plugins: CELL_PARSER_PLUGINS,
    ...(target === 'commonjs' ? { allowAwaitOutsideFunction: undefined, allowReturnOutsideFunction: undefined } : {}) }
  let mapped = { code: source, sourceMap: identitySourceMap(source.length) }
  let callableSources = []
  let nativeJavaScript = false
  if (source.startsWith('#!')) {
    // Interpreter directives belong to the source's first line, never to the
    // prefixed module or CommonJS wrapper. Retain its original line boundary.
    const directive = source.match(/^#![^\n\r\u2028\u2029]*/u)
    mapped = applySourceEdits(source, mapped.sourceMap, [{ start: 0,
      end: directive[0].length, text: '' }])
  }
  if (transform !== LEGACY_USER_BINDING_TRANSFORM) {
    const marked = markCallableSources(mapped.code, mapped.sourceMap, callableParserOptions,
      { lowerNativeSource: lowerNativeLanguageSource, nativeUsing })
    callableSources = marked.callableSources
    nativeJavaScript = marked.nativeJavaScript
    mapped = marked
    if (!nativeJavaScript) mapped = normalizeTypeScriptValues(mapped.code, mapped.sourceMap, target)
    if (target !== 'commonjs' && (transform === USER_BINDING_TRANSFORM
      || transform === PROTECTED_MODULE_TRANSFORM && hasModuleResources(mapped.code))) {
      mapped = normalizeModuleExports(mapped.code, mapped.sourceMap)
    }
  }
  const commonJsSource = target === 'commonjs'
    ? commonJsExportEvidence(mapped.code, { legacy: transform === LEGACY_USER_BINDING_TRANSFORM }) : undefined
  const links = transform === USER_BINDING_TRANSFORM && target === 'module'
    ? moduleLinkPlan(mapped.code) : undefined
  let normalized = transform === LEGACY_USER_BINDING_TRANSFORM ? mapped
    : normalizeStatefulScopes(mapped.code, mapped.sourceMap, { target, moduleImport: links?.reader, nativeJavaScript, nativeUsing,
      mode: transform === PROTECTED_MODULE_TRANSFORM ? 'protected-v1' : 'stateful-v1' })
  // Protected entries retain native declaration policy; adapters still need
  // bounded source regions after TypeScript and decorator lowering.
  if (transform === PROTECTED_MODULE_TRANSFORM && normalized.sourceRegions === undefined) normalized = { ...normalized,
    sourceRegions: indexSourceRegions(normalized.code, callableParserOptions) }
  let protectedInterface
  if (transform === PROTECTED_MODULE_TRANSFORM && target === 'module') {
    const lexicalExports = normalized.moduleLexicalExports
    normalized = adaptLegacyModuleReferences(normalized)
    protectedInterface = normalized.moduleInterface
    if (lexicalExports !== undefined) protectedInterface = { ...protectedInterface,
      exports: protectedInterface.exports.map(entry => lexicalExports.has(entry.name) ? { ...entry, kind: 'accessor' } : entry) }
  }
  if (links !== undefined) normalized = { ...applyRegionEdits(normalized,
    [{ start: 0, end: 0, text: links.prefix }]),
    internalBindings: new Set([...normalized.internalBindings ?? [], ...links.internalBindings]) }
  const classificationCode = normalized.code
  if (links !== undefined || protectedInterface !== undefined) normalized = adaptStaticModuleLinks(normalized, staticLinks)
  if (transform !== LEGACY_USER_BINDING_TRANSFORM) normalized = adaptModuleOperations(normalized, { target, url })
  if (transform !== LEGACY_USER_BINDING_TRANSFORM) normalized = { ...normalized, ...adaptDynamicCell(normalized.code, normalized.sourceMap, {
    sourceRegions: normalized.sourceRegions,
    callableCollector: createRegionCallableCollector(callableSources),
    module: true, compactOutput: true, importOperation: normalized.importOperation, sourceType, originalSource: source,
    bindings: normalized.dynamicBindings, privateBindings: normalized.privateBindings,
    internalBindings: normalized.internalBindings, parserPlugins: CELL_PARSER_PLUGINS,
  }) }
  // The published legacy map ends at its maintained transform input.
  const wrapper = target === 'commonjs' ? 'function __ptc_commonjs__(){\n' : ''
  let input = normalized
  if (transform === LEGACY_USER_BINDING_TRANSFORM && wrapper) {
    input = applySourceEdits(input.code, input.sourceMap, [{ start: 0, end: 0, text: wrapper }])
    input = applySourceEdits(input.code, input.sourceMap, [{ start: input.code.length, end: input.code.length, text: '\n}' }])
  }
  let transformed, nativeExtraction, emission, sources
  let moduleInterface = links?.moduleInterface ?? protectedInterface
  if (transform === LEGACY_USER_BINDING_TRANSFORM) {
    // Preserve the historical TypeScript lowering before adapting native
    // bindings. Its unexpanded output is the source indexed by shared regions.
    transformed = transformTypeScriptSource(input.code)
    let code = transformed.code
    if (wrapper) {
      nativeExtraction = commonJsBodyRange(code)
      code = code.slice(nativeExtraction.start, nativeExtraction.end)
    }
    let entry = { code, sourceMap: identitySourceMap(code.length),
      sourceRegions: indexSourceRegions(code, callableParserOptions) }
    if (target === 'commonjs') entry = normalizeStatefulScopes(code, entry.sourceMap,
      { mode: 'protected-v1', target, nativeJavaScript: true, deferDecorators: true, deferResources: true })
    if (target === 'module') {
      entry = adaptLegacyModuleReferences(entry)
      moduleInterface = entry.moduleInterface
      entry = adaptStaticModuleLinks(entry, staticLinks)
    }
    entry = adaptModuleOperations(entry, { target, url })
    emission = adaptDynamicCell(entry.code, entry.sourceMap, { module: true,
      sourceRegions: entry.sourceRegions,
      importOperation: entry.importOperation, sourceType, originalSource: source,
      bindings: entry.dynamicBindings, internalBindings: entry.internalBindings, parserPlugins: CELL_PARSER_PLUGINS,
    })
  } else {
    const owners = normalized.callableRanges === undefined ? collectRegionCallableRanges(normalized, callableSources, callableParserOptions)
      : new Map(normalized.callableRanges.map(range => [range.start, range]))
    // Native JavaScript has no remaining TypeScript emission work. Retain the
    // generator's exact source and owner facts instead of expanding it again.
    const output = nativeJavaScript ? { ...normalized, callableRanges: [...owners.values()] }
      : transformRegionSource(normalized, { ...callableParserOptions, wrapCommonJs: true }, region => {
      const generated = transformTypeScriptSource(region.code, {
        module: target === 'module' && !region.prefix, sourceMap: true,
        // Type-only declarations and the complete module interface were
        // resolved before partitioning; omitted bodies cannot erase imports.
        transform: { tsEnumIsMutable: true, verbatimModuleSyntax: true,
          noEmptyExport: target === 'commonjs' || !!region.prefix },
      })
      return emitRegionCallableSources(region, generated, owners, callableParserOptions)
    })
    emission = nativeJavaScript ? output : { ...output, ...applySourceEdits(normalized.code, normalized.sourceMap,
      [{ start: 0, end: normalized.code.length, text: output.code, mappings: output.sourceMap }]) }
    sources = callableSourceCatalog(emission.code, callableSources, output.callableRanges)
  }
  // Callable ownership collection validates native output's exact grammar
  // regions. Only the later TypeScript/legacy emitter changes that code.
  if (!nativeJavaScript) validateRegionSource(emission, { sourceType, plugins: ['importAttributes'] })
  return { code: emission.code, classificationCode, transform, target, moduleInterface, commonJsSource,
    staticLinks, callableSources: sources,
    sourceRegions: sourceRegionData(emission.sourceRegions),
    sourceMap: { normalization: input.sourceMap, typescript: transformed?.map, nativeExtraction,
      ...(transform === LEGACY_USER_BINDING_TRANSFORM ? {} : { emission: emission.sourceMap }) },
  }
}

export function detectModuleSourceFormat(source, { extension } = {}) {
  // Synchronous CommonJS hooks may leave format undefined. For an untyped
  // package Node detects module syntax, including lexical wrapper-name clashes.
  // Parse without executing source, allowing the repetitions PTC owns.
  if (extension === '.ts') source = normalizeTypeScriptValues(source, identitySourceMap(source.length)).code
  const tree = parse(source, { sourceType: 'unambiguous', errorRecovery: true,
    allowReturnOutsideFunction: true, allowNewTargetOutsideFunction: true, plugins: CELL_PARSER_PLUGINS })
  const wrapperNames = new Set(COMMONJS_PARAMETERS)
  const lexicalWrapperName = tree.program.body.some(node => node.type === 'VariableDeclaration' && node.kind !== 'var'
    ? node.declarations.some(item => bindingNodes(item.id).some(binding => wrapperNames.has(binding.name)))
    : node.type === 'ClassDeclaration' && wrapperNames.has(node.id.name))
  return tree.program.sourceType === 'module' || lexicalWrapperName ? 'module' : 'commonjs'
}

export function attachModuleNamespace(source, attributes, reference, sourceRegions) {
  const text = source
  const names = new Set()
  visitRegionSource({ code: text, sourceMap: identitySourceMap(text.length), sourceRegions }, { sourceType: 'module' }, input => {
    t.traverseFast(input.tree, node => { if (t.isIdentifier(node)) names.add(node.name) })
  })
  const allocate = createGeneratedNameAllocator(undefined, names)
  const namespace = allocate('module_native_namespace')
  const register = allocate('module_register_namespace')
  const runtime = new URL('./stateful-module-runtime.js', import.meta.url).href
  // A namespace import adds no named-import validation and reads no exports.
  // Register after successful evaluation, before native require can return.
  const entries = Object.entries(attributes ?? {})
  const suffix = entries.length === 0 ? '' : ` with {${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`
  return `${text}\nimport * as ${namespace} from ${JSON.stringify(reference)}${suffix};\nimport {recordStatefulModuleNamespace as ${register}} from ${JSON.stringify(runtime)};\n${register}(import.meta.url,${namespace});\n`
}
