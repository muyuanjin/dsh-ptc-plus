import { commonJsCompilerImport } from './compiler-module-links.js'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { bindingNodes, createGeneratedNameAllocator } from './binding-pattern.js'
import { applySourceEdits, sourceOffsetAt } from './source-position-map.js'
import { visitRegionSource, applyRegionEdits } from './compiler-region-output.js'
import { visitSource } from './compiler-source-regions.js'
import { CELL_PARSER_PLUGINS, analyzeLogicalScopes } from './repl-scope-normalizer.js'
import { resolveSourceBinding } from './compiler-scope-facts.js'

const traverse = traverseModule.default ?? traverseModule

/** Every module environment owns imports, including runtime-created source. */
export function adaptModuleOperations(normalized, { target, url }) {
  let allocate, insertion, strictCommonJs = false, sourceRequire = false
  const calls = []
  visitRegionSource(normalized, { sourceType: target === 'module' ? 'module' : 'commonjs', plugins: CELL_PARSER_PLUGINS }, input => {
    allocate ??= normalized.sourceRegions?.allocate ?? createGeneratedNameAllocator(input.tree)
    if (input.region.kind === 'program') {
      insertion = input.tree.program.directives.at(-1)?.end ?? 0
      strictCommonJs = target === 'commonjs' && input.tree.program.directives.some(item => item.value.value === 'use strict')
      sourceRequire = target === 'commonjs' && input.tree.program.body.some(item =>
        item.type === 'FunctionDeclaration' && item.id.name === 'require')
    }
    visitSource(input.tree, { CallExpression(path) {
      if (path.node.callee.type === 'Import') calls.push({ start: sourceOffsetAt(input.sourceMap, path.node.callee.start),
        end: sourceOffsetAt(input.sourceMap, path.node.callee.end - 1) + 1 })
    } })
  })
  const runtime = allocate('module_operations')
  const importer = allocate('module_import')
  const runtimeUrl = new URL('./stateful-module-runtime.js', import.meta.url)
  const bootstrap = target === 'commonjs' ? allocate('module_bootstrap') : undefined
  const originalRequire = strictCommonJs && !sourceRequire ? allocate('wrapper_require') : undefined
  const parent = target === 'module' ? 'import.meta.url' : url === undefined
    ? `(typeof __filename === 'string' ? ${runtime}.pathToFileURL(__filename).href : ${JSON.stringify(import.meta.url)})` : JSON.stringify(url)
  const edits = calls.map(node => ({ start: node.start, end: node.end, text: importer }))
  const nativeRequire = `typeof __filename === 'string' ? process.getBuiltinModule('module').createRequire(__filename) : ${sourceRequire ? 'arguments[1]' : 'require'}`
  const loaderSetup = sourceRequire
    ? strictCommonJs ? `arguments[1]=${runtime}.managedRequire(${parent},${nativeRequire});` : ''
    : `${originalRequire ? `const ${originalRequire}=require;` : ''}require=${runtime}.managedRequire(${parent},${nativeRequire});`
      // Sloppy wrappers have mapped arguments. Strict wrappers need their
      // original host argument adapted once before source observes either path.
      + (originalRequire ? `if(arguments[1]===${originalRequire})arguments[1]=require;` : '')
  const setup = target === 'module'
    ? `import * as ${runtime} from ${JSON.stringify(runtimeUrl.href)};`
    : `const ${runtime}=${commonJsCompilerImport(runtimeUrl)};const ${bootstrap}=(()=>{${loaderSetup}})();`
  // Function declarations remain usable during cyclic module instantiation.
  const operation = `function ${importer}(source,options){return ${runtime}.managedModuleImport(${parent},source,options)}`
  edits.push({ start: insertion, end: insertion, text: `\n${setup}\n${operation}\n` })
  return { ...applyRegionEdits(normalized, edits), importOperation: importer,
    internalBindings: new Set([...normalized.internalBindings ?? [], runtime, importer,
      ...bootstrap ? [bootstrap] : [], ...originalRequire ? [originalRequire] : []]) }
}

/** Root compilation supplies the execution-owned operation without globals. */
export function adaptRootModuleImports(normalized, runtime) {
  const tree = parse(normalized.code, { sourceType: 'script', allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true, plugins: CELL_PARSER_PLUGINS })
  const edits = []
  traverse(tree, { noScope: true, CallExpression(path) {
    if (path.node.callee.type === 'Import') edits.push({ start: path.node.callee.start,
      end: path.node.callee.end, text: `${runtime}.importModule` })
  } })
  return { ...normalized, ...applySourceEdits(normalized.code, normalized.sourceMap, edits) }
}

/** Retain the frozen legacy lowering; adapt only its module operation entry. */
export function adaptLegacyModuleImports(prepared, options) {
  if (prepared.collisions.length !== 0) return prepared
  const tree = parse(prepared.code, { sourceType: 'script', allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true, plugins: CELL_PARSER_PLUGINS })
  const calls = []
  traverse(tree, { noScope: true, CallExpression(path) {
    if (path.node.callee.type === 'Import') calls.push(path.node.callee)
  } })
  if (calls.length === 0) return prepared
  const allocate = createGeneratedNameAllocator(tree, [...prepared.importNamespaces,
    ...options.knownBindings ?? [], ...options.reservedBindings ?? []])
  const importer = allocate('module_import')
  const global = allocate('module_import_global')
  const edits = calls.map(node => ({ start: node.start, end: node.end, text: importer }))
  const insertion = tree.program.directives.at(-1)?.end ?? tree.program.interpreter?.end ?? 0
  edits.push({ start: insertion, end: insertion, text: `;\nconst ${importer}=${global};\n` })
  return { ...prepared, ...applySourceEdits(prepared.code, prepared.sourceMap, edits),
    importNamespaces: new Set([...prepared.importNamespaces, importer]),
    moduleLoads: [...prepared.moduleLoads, { operation: 'import', global }] }
}

/** Legacy module bindings stay native; only reads cross the managed interface. */
export function adaptLegacyModuleReferences(normalized) {
  const facts = analyzeLogicalScopes(normalized.code, { target: 'module', compact: true })
  const { tree, allocate } = facts
  for (const [node, name] of facts.names) node.name = name
  const reader = allocate('module_import_read')
  const imported = new Map()
  const dynamicBindings = []
  const accessors = []
  const exports = []
  const stars = []
  const name = node => node.name ?? node.value
  const relation = node => ({ source: node.source.value, attributes: Object.fromEntries(
    (node.attributes ?? []).map(item => [name(item.key), item.value.value])) })
  for (const node of tree.program.body) {
    if (node.type !== 'ImportDeclaration') continue
    for (const item of node.specifiers) imported.set(item.local.name, { ...relation(node),
      imported: item.type === 'ImportNamespaceSpecifier' ? null
        : item.type === 'ImportDefaultSpecifier' ? 'default' : name(item.imported), local: item.local })
  }
  for (const node of tree.program.body) {
    if (node.type === 'ExportDefaultDeclaration') exports.push({ name: 'default', kind: 'native' })
    if (node.type === 'ExportAllDeclaration') stars.push(relation(node))
    if (node.type !== 'ExportNamedDeclaration') continue
    if (node.declaration != null) {
      const declaration = node.declaration
      const names = declaration.type === 'VariableDeclaration'
        ? declaration.declarations.flatMap(item => bindingNodes(item.id)).map(item => item.name) : [declaration.id.name]
      exports.push(...names.map(name => ({ name, kind: 'native' })))
    }
    for (const item of node.specifiers) {
      const exported = name(item.exported)
      const source = node.source == null ? imported.get(name(item.local)) : { ...relation(node),
        imported: item.type === 'ExportNamespaceSpecifier' ? null : name(item.local) }
      exports.push(source === undefined ? { name: exported, kind: 'native' }
        : { name: exported, kind: source.imported === null ? 'namespace' : 'forward',
          source: source.source, imported: source.imported, attributes: source.attributes })
    }
  }
  const edits = []
  const sourceFor = path => {
    const source = imported.get(path.node.name)
    return source !== undefined && resolveSourceBinding(facts, facts.paths.get(path.node), path.node.name)
      ?.occurrences.some(item => item.node === source.local) ? source : undefined
  }
  const read = (path, source) => `${reader}(import.meta.url,${JSON.stringify(source.source)},${JSON.stringify(source.imported)},()=>${path.node.name},${JSON.stringify(source.attributes)})`
  const write = path => {
    const source = sourceFor(path)
    if (source === undefined) return
    const value = allocate('module_import_value')
    // Read-modify-write observes the logical value and its coercion effects,
    // then delegates the forbidden import write to its native binding.
    edits.push({ start: path.node.start, end: path.node.end,
      text: `({get v(){return ${read(path, source)}},set v(${value}){${path.node.name}=${value}}}).v` })
  }
  visitSource(tree, {
    AssignmentExpression(path) { if (path.node.operator !== '=' && path.node.left.type === 'Identifier') write(path.get('left')) },
    UpdateExpression(path) { if (path.node.argument.type === 'Identifier') write(path.get('argument')) },
    ReferencedIdentifier(path) {
      const source = sourceFor(path)
      if (source === undefined || path.parentPath.isExportSpecifier() || path.parentPath.isUpdateExpression()
        || (path.parentPath.isForInStatement() || path.parentPath.isForOfStatement()) && path.key === 'left') return
      const value = `(${read(path, source)})`
      edits.push({ start: path.node.start, end: path.node.end,
        text: path.parentPath.isObjectProperty({ shorthand: true }) ? `[${JSON.stringify(path.node.name)}]:${value}` : value })
    },
  })
  const runtime = new URL('./stateful-module-runtime.js', import.meta.url).href
  for (const [name, source] of imported) {
    const physicalName = allocate('module_import_cell')
    const value = allocate('module_import_value')
    const get = `${reader}(import.meta.url,${JSON.stringify(source.source)},${JSON.stringify(source.imported)},()=>${name},${JSON.stringify(source.attributes)})`
    accessors.push(`function ${physicalName}(){return {get v(){return ${get}},set v(${value}){${name}=${value}}}}`)
    dynamicBindings.push({ name, physicalName, kind: 'module', accessor: true, property: 'v' })
  }
  edits.push({ start: 0, end: 0,
    text: `import {readModuleImport as ${reader}} from ${JSON.stringify(runtime)};\n${accessors.join('\n')}\n` })
  return { ...applyRegionEdits(normalized, edits),
    moduleInterface: { exports, stars }, dynamicBindings: [...normalized.dynamicBindings ?? [], ...dynamicBindings],
    internalBindings: new Set([...normalized.internalBindings ?? [], reader, ...imported.keys()]) }
}
