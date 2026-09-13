import { parse } from '@babel/parser'
import { bindingNodes, createGeneratedNameAllocator } from './binding-pattern.js'
import { markCallableSources, collectCallableSources } from './callable-source-facts.js'
import { adaptDynamicCell } from './dynamic-environment-integration.js'
import { CELL_PARSER_PLUGINS } from './repl-scope-normalizer.js'

/** Native declarations remain frozen; dynamic entries retain their native root. */
export function adaptNativeRootDynamic(prepared, options, originalSource) {
  if (prepared.collisions.length !== 0) return { ...prepared, nativeLexicals: new Set() }
  const parser = { sourceType: 'script', allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true, plugins: CELL_PARSER_PLUGINS }
  const marked = markCallableSources(prepared.code, prepared.sourceMap, parser)
  const tree = parse(marked.code, parser)
  const nativeLexicals = new Set(tree.program.body.flatMap(statement =>
    statement.type === 'VariableDeclaration' && statement.kind !== 'var'
      ? statement.declarations.flatMap(declaration => bindingNodes(declaration.id).map(binding => binding.name))
      : statement.type === 'ClassDeclaration' ? [statement.id.name] : []))
  const nativeAwait = hasRootAwait(tree.program)
  const reservedBindings = new Set([...prepared.importNamespaces,
    ...options.knownBindings ?? [], ...options.reservedBindings ?? []])
  const allocate = createGeneratedNameAllocator(parse(marked.code, parser), reservedBindings)
  const global = allocate('native_environment_global')
  const established = [...options.establishedRoots ?? []]
  const logicalRoots = established.filter(([, source]) => source !== 'absent').map(([name]) => name)
  const nativePublications = prepared.declarations.filter(declaration => options.establishedRoots?.has(declaration.name)
    && !prepared.redeclared.some(redeclaration => redeclaration.name === declaration.name))
    .map(declaration => ({ name: declaration.name, writable: declaration.writable,
      nativeLexical: nativeLexicals.has(declaration.name),
      import: prepared.imports.get(declaration.name) }))
  const dynamic = adaptDynamicCell(marked.code, marked.sourceMap, { nativeRoot: true,
    environmentGlobal: global, reservedBindings, internalBindings: prepared.importNamespaces,
    originalSource, parserPlugins: CELL_PARSER_PLUGINS, nativeAwait, logicalRoots: logicalRoots.length > 0 })
  const callableSources = collectCallableSources(dynamic.code, marked.callableSources, parser)
  return { ...prepared, code: dynamic.code, sourceMap: dynamic.sourceMap, nativeLexicals,
    ...(established.length === 0 ? {} : { rootBindingFacts: true, rootBindings: {
      known: [...options.knownBindings ?? []], established, candidates: [...options.rootCandidates ?? []],
      dynamicOrigins: options.dynamicOrigins ?? [], legacyImports: [...options.importBindings ?? []],
    } }),
    importNamespaces: new Set([...prepared.importNamespaces, dynamic.dynamicEnvironmentName]),
    moduleLoads: [...prepared.moduleLoads, { operation: 'native-dynamic', global, callableSources, awaitRoot: nativeAwait,
      nativeLexicals: [...options.nativeLexicalBindings ?? []],
      logicalRoots, writableRoots: logicalRoots.filter(name => options.writableBindings?.has(name)), nativePublications }] }
}

function hasRootAwait(node) {
  if (node === null || typeof node !== 'object') return false
  if (node.type === 'AwaitExpression' || node.type === 'ForOfStatement' && node.await) return true
  if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return false
  if (['ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type)) {
    return node.computed && hasRootAwait(node.key)
  }
  return Object.entries(node).some(([key, value]) => !['loc', 'extra', 'start', 'end'].includes(key)
    && (Array.isArray(value) ? value.some(hasRootAwait) : value?.type !== undefined && hasRootAwait(value)))
}
