/** Adapts TypeScript module declarations to the async function-body grammar used by PTC cells. */
import { parse } from '@babel/parser'
import traverseModule, { Hub, NodePath } from '@babel/traverse'
import { bindingNodes, createGeneratedNameAllocator } from './binding-pattern.js'
import { applySourceEdits, createMappedTextBuilder, identitySourceMap } from './source-position-map.js'
import {
  LEGACY_DEFAULT_EXPORT_BINDING,
  LIVE_DEFAULT_EXPORT_BINDING,
} from './repl-rewrite-contract.js'

export const STRIP_PREFIX = 'async function __ptc_cell__(){\n'
export const STRIP_SUFFIX = '\n}'

export class ModuleRewriteError extends SyntaxError {
  constructor(message, cellPosition) {
    super(message)
    if (cellPosition !== undefined) this.cellPosition = cellPosition
  }
}

const PARSER_PLUGINS = ['typescript', 'importAttributes']
const TYPE_DECLARATIONS = new Set([
  'TSDeclareFunction',
  'TSEnumDeclaration',
  'TSInterfaceDeclaration',
  'TSModuleDeclaration',
  'TSTypeAliasDeclaration',
])
const traverse = traverseModule.default ?? traverseModule

function declaredTypeNames(program) {
  const names = new Set()
  for (const node of program.body) {
    const declaration = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
      ? node.declaration
      : node
    if (TYPE_DECLARATIONS.has(declaration?.type) && declaration.id?.type === 'Identifier') {
      names.add(declaration.id.name)
    }
  }
  return names
}

function createProgramScope(file) {
  const hub = new Hub()
  hub.buildError = (node, message, ErrorType = TypeError) => {
    const error = new ErrorType(message)
    error.loc = node.loc?.start
    return error
  }
  const path = NodePath.get({ hub, parent: file, container: file, key: 'program' })
  path.setContext()
  path.scope = path.getScope()
  path.scope.init()
  return path.scope
}

function validateLocalExports(file, programScope) {
  const localExports = file.program.body.filter(node => node.type === 'ExportNamedDeclaration'
    && node.source === null && node.declaration === null)
  const valueSpecifiers = localExports.flatMap(node => node.specifiers
    .filter(specifier => specifier.exportKind !== 'type'))
  if (valueSpecifiers.length === 0) return
  const typeNames = declaredTypeNames(file.program)
  const missing = valueSpecifiers.find(specifier => (
    programScope.getBinding(specifier.local.name) === undefined && !typeNames.has(specifier.local.name)
  ))
  if (missing === undefined) return
  throw new ModuleRewriteError(`Export '${missing.local.name}' is not defined.`, {
    line: missing.local.loc.start.line,
    column: missing.local.loc.start.column + 1,
  })
}

function parseCell(code) {
  try {
    const file = parse(code, {
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
      plugins: PARSER_PLUGINS,
    })
    validateLocalExports(file, createProgramScope(file))
    return file.program
  } catch (error) {
    if (error instanceof ModuleRewriteError) throw error
    const loc = error?.loc
    throw new ModuleRewriteError(error instanceof Error ? error.message : String(error),
      Number.isSafeInteger(loc?.line) && Number.isSafeInteger(loc?.column)
        ? { line: loc.line, column: loc.column + 1 }
        : undefined)
  }
}

function parseSource(node) { return node.source.value }
function importOptions(node) {
  if (!node.attributes || node.attributes.length === 0) return undefined
  const attributes = Object.fromEntries(node.attributes.map((attribute) => {
    const key = attribute.key.type === 'Identifier' ? attribute.key.name : attribute.key.value
    return [key, attribute.value.value]
  }))
  const keyword = node.attributes[0].type === 'ImportAttribute' ? 'with' : 'assert'
  return { [keyword]: attributes }
}
function moduleLoad(node, source, global = undefined, requiredExports = []) {
  return {
    source,
    ...(global === undefined ? {} : { global }),
    ...(requiredExports.length === 0 ? {} : { requiredExports }),
    ...(importOptions(node) === undefined ? {} : { options: importOptions(node) }),
    position: {
      line: node.source.loc.start.line,
      column: node.source.loc.start.column + 1,
      end: {
        line: node.source.loc.end.line,
        column: node.source.loc.end.column + 1,
      },
    },
  }
}
function record(kind, description, node, source) {
  return { kind, description, ...(source === undefined ? {} : { source }), at: node.start }
}
function preserveLines(original, replacement = '') {
  const missing = (original.match(/\n/g)?.length ?? 0) - (replacement.match(/\n/g)?.length ?? 0)
  return missing > 0 ? replacement + '\n'.repeat(missing) : replacement
}
function editNode(edits, node, code, replacement = '') {
  const mapped = typeof replacement === 'string' ? { text: replacement } : replacement
  const separated = node.end < code.length && code[node.end] !== '\n' && code[node.end] !== '\r'
    ? `${mapped.text}\n`
    : mapped.text
  edits.push({
    start: node.start,
    end: node.end,
    text: preserveLines(code.slice(node.start, node.end), separated),
    ...(mapped.mappings === undefined ? {} : { mappings: mapped.mappings }),
  })
}
function edit(edits, start, end, text) { edits.push({ start, end, text }) }
function localName(specifier) { return specifier.local.name }
function importedName(specifier) {
  if (specifier.type === 'ImportDefaultSpecifier') return 'default'
  if (specifier.type === 'ImportNamespaceSpecifier') return undefined
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

function importEdits(
  node,
  code,
  edits,
  rewrites,
  imports,
  importDeclarations,
  moduleLoads,
  namespaceCaptures,
  allocateNamespace,
  allocateGlobal,
) {
  const source = parseSource(node)
  const rewrite = record('import', `adapted the static import of ${JSON.stringify(source)} for REPL execution`, node, source)
  if (node.importKind === 'type') {
    editNode(edits, node, code)
    rewrites.push(record('import', `removed the type-only import of ${JSON.stringify(source)}`, node, source))
    return
  }
  if (node.specifiers.length > 0 && node.specifiers.every(specifier => specifier.importKind === 'type')) {
    editNode(edits, node, code)
    rewrites.push(record('import', `removed the type-only import of ${JSON.stringify(source)}`, node, source))
    return
  }
  const specifiers = node.specifiers.filter(specifier => specifier.importKind !== 'type')
  if (specifiers.length === 0) {
    moduleLoads.push(moduleLoad(node, source))
    editNode(edits, node, code)
    rewrites.push(rewrite)
    return
  }
  const namespace = allocateNamespace('import_namespace')
  const global = allocateGlobal('import_global')
  const requiredExports = []
  for (const specifier of specifiers) {
    const imported = importedName(specifier)
    imports.set(localName(specifier), { namespace, imported })
    if (imported !== undefined && !requiredExports.includes(imported)) requiredExports.push(imported)
    importDeclarations.push({
      name: localName(specifier),
      kind: 'import',
      span: {
        line: specifier.local.loc.start.line,
        column: specifier.local.loc.start.column + 1,
        end: {
          line: specifier.local.loc.end.line,
          column: specifier.local.loc.end.column + 1,
        },
      },
      definitionSpan: {
        line: node.loc.start.line,
        column: node.loc.start.column + 1,
        end: {
          line: node.loc.end.line,
          column: node.loc.end.column + 1,
        },
      },
      original: true,
    })
  }
  moduleLoads.push(moduleLoad(node, source, global, requiredExports))
  namespaceCaptures.push({ namespace, global, source: node.source })
  editNode(edits, node, code)
  rewrites.push(rewrite)
}

function importPrologueEdit(program, tree, namespaceCaptures) {
  if (namespaceCaptures.length === 0) return undefined
  const directive = tree.directives.at(-1)
  let insertion = directive?.end ?? tree.interpreter?.end ?? 0
  if (directive === undefined && tree.interpreter !== null && tree.interpreter !== undefined) {
    if (program[insertion] === '\r' && program[insertion + 1] === '\n') insertion += 2
    else if (program[insertion] === '\r' || program[insertion] === '\n') insertion += 1
  }
  const builder = createMappedTextBuilder(program)
  if (directive !== undefined && program[insertion - 1] !== ';') builder.append(';')
  for (const capture of namespaceCaptures) {
    builder.append('const ')
    builder.appendMapped(capture.namespace, capture.source.start, capture.source.end)
    builder.append(' = ')
    builder.appendMapped(capture.global, capture.source.start, capture.source.end)
    builder.append(';')
  }
  return { start: insertion, end: insertion, ...builder.result() }
}

function importMember(namespace, imported) {
  return imported === undefined ? namespace
    : /^[A-Za-z_$][\w$]*$/.test(imported) ? `${namespace}.${imported}`
      : `${namespace}[${JSON.stringify(imported)}]`
}

function appendReadonlyImportWrite(builder, appendValue) {
  builder.append("((__dsh_ptc_import_value__) => { throw new TypeError('Assignment to constant variable.'); })(")
  appendValue()
  builder.append(')')
}

function importedBindingFor(path, identifier, imports) {
  const binding = imports.get(identifier.name)
  return binding !== undefined && path.scope.getBinding(identifier.name) === undefined ? binding : undefined
}

function importedWriteBinding(path, imports) {
  if (path.isAssignmentExpression() && path.node.left.type === 'Identifier') {
    return importedBindingFor(path, path.node.left, imports)
  }
  return undefined
}

function assertNoImportedWriteAncestor(path, imports) {
  if (path.findParent(parent => importedWriteBinding(parent, imports) !== undefined) !== null) {
    throw new ModuleRewriteError('nested assignment to an imported binding is not supported')
  }
}

function preserveExpressionStatementBoundary(path, edits) {
  const statement = path.findParent(parent => parent.isExpressionStatement())
  if (statement?.node.expression.start === path.node.start) {
    edits.push({ start: path.node.start, end: path.node.start, text: ';' })
  }
}

function assertNoDynamicImportResolution(tree, imports) {
  if (imports.size === 0) return
  traverse(tree, {
    WithStatement() {
      throw new ModuleRewriteError('with statement is not supported while imported bindings are active')
    },
    CallExpression(path) {
      if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'eval'
        && !imports.has('eval') && path.scope.getBinding('eval') === undefined) {
        throw new ModuleRewriteError('direct eval is not supported while imported bindings are active')
      }
    },
  })
}

function rewriteImportReferences(code, sourceMap, imports) {
  if (imports.size === 0) return { code, sourceMap }
  const parseRewritten = source => parse(source, {
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      plugins: PARSER_PLUGINS,
    })
  let file = parseRewritten(code)
  const writeEdits = []
  traverse(file, {
    AssignmentExpression(path) {
      if (path.node.left.type !== 'Identifier') {
        const names = bindingNodes(path.node.left).map(node => node.name)
        if (names.some(name => imports.has(name) && path.scope.getBinding(name) === undefined)) {
          throw new ModuleRewriteError('destructuring assignment to an imported binding is not supported')
        }
        return
      }
      const binding = importedBindingFor(path, path.node.left, imports)
      if (binding === undefined) return
      assertNoImportedWriteAncestor(path, imports)
      const member = importMember(binding.namespace, binding.imported)
      const builder = createMappedTextBuilder(code)
      const appendMember = () => builder.appendMapped(member, path.node.left.start, path.node.left.end)
      const appendRight = () => builder.appendSource(path.node.right.start, path.node.right.end)
      if (path.node.operator === '=') appendReadonlyImportWrite(builder, appendRight)
      else if (['&&=', '||=', '??='].includes(path.node.operator)) {
        const operator = path.node.operator.slice(0, -1)
        appendMember()
        builder.append(` ${operator} `)
        appendReadonlyImportWrite(builder, appendRight)
      } else {
        appendReadonlyImportWrite(builder, () => {
          appendMember()
          builder.append(` ${path.node.operator.slice(0, -1)} (`)
          appendRight()
          builder.append(')')
        })
      }
      writeEdits.push({
        start: path.node.start,
        end: path.node.end,
        ...builder.result(),
      })
    },
    UpdateExpression(path) {
      if (path.node.argument.type !== 'Identifier') return
      const binding = importedBindingFor(path, path.node.argument, imports)
      if (binding === undefined) return
      assertNoImportedWriteAncestor(path, imports)
      const member = importMember(binding.namespace, binding.imported)
      const builder = createMappedTextBuilder(code)
      builder.append('((__dsh_ptc_import_value__) => { ')
      builder.append(path.node.operator === '++' ? '__dsh_ptc_import_value__++' : '__dsh_ptc_import_value__--')
      builder.append("; throw new TypeError('Assignment to constant variable.'); })(")
      builder.appendMapped(member, path.node.argument.start, path.node.argument.end)
      builder.append(')')
      writeEdits.push({
        start: path.node.start,
        end: path.node.end,
        ...builder.result(),
      })
    },
    UnaryExpression(path) {
      if (path.node.operator !== 'delete' || path.node.argument.type !== 'Identifier') return
      if (importedBindingFor(path, path.node.argument, imports) !== undefined) {
        throw new ModuleRewriteError('delete of an imported binding is not supported')
      }
    },
    ForInStatement(path) {
      if (path.node.left.type === 'VariableDeclaration') return
      const names = bindingNodes(path.node.left)
      if (names.some(node => importedBindingFor(path, node, imports) !== undefined)) {
        throw new ModuleRewriteError('for-in assignment to an imported binding is not supported')
      }
    },
    ForOfStatement(path) {
      if (path.node.left.type === 'VariableDeclaration') return
      const names = bindingNodes(path.node.left)
      if (names.some(node => importedBindingFor(path, node, imports) !== undefined)) {
        throw new ModuleRewriteError('for-of assignment to an imported binding is not supported')
      }
    },
  })
  const written = applySourceEdits(code, sourceMap, writeEdits)
  file = parseRewritten(written.code)
  const readEdits = []
  traverse(file, {
    ReferencedIdentifier(path) {
      const binding = imports.get(path.node.name)
      if (binding === undefined || path.scope.getBinding(path.node.name) !== undefined) return
      const member = importMember(binding.namespace, binding.imported)
      const parent = path.parent
      if (((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && parent.callee === path.node)
        || (parent.type === 'TaggedTemplateExpression' && parent.tag === path.node)) {
        preserveExpressionStatementBoundary(path, readEdits)
        readEdits.push({ start: path.node.start, end: path.node.end, text: `(0, ${member})` })
        return
      }
      if (parent.type === 'ObjectProperty' && parent.shorthand && parent.value === path.node) {
        readEdits.push({ start: parent.start, end: parent.end, text: `${path.node.name}: ${member}` })
        return
      }
      readEdits.push({ start: path.node.start, end: path.node.end, text: member })
    },
  })
  return applySourceEdits(written.code, written.sourceMap, readEdits)
}

function exportNamedEdits(node, code, edits, rewrites, moduleLoads) {
  const onlyTypeSpecifiers = node.specifiers.length > 0
    && node.specifiers.every(specifier => specifier.exportKind === 'type')
  if (node.exportKind === 'type' || onlyTypeSpecifiers
    || (node.declaration && ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'].includes(node.declaration.type))) {
    editNode(edits, node, code)
    const source = node.exportKind === 'type' || onlyTypeSpecifiers ? 'type' : node.declaration.type
    rewrites.push(record('export', 'removed a type-only export declaration', node, source))
    return
  }
  if (node.source !== null && node.source !== undefined) {
    const source = parseSource(node)
    moduleLoads.push(moduleLoad(node, source))
    editNode(edits, node, code)
    rewrites.push(record('export', `converted the re-export of ${JSON.stringify(source)} into a side-effect import`, node, source))
    return
  }
  if (node.declaration !== null && node.declaration !== undefined) {
    edit(edits, node.start, node.declaration.start, preserveLines(code.slice(node.start, node.declaration.start)))
    rewrites.push(record('export', 'stripped the export modifier from a top-level declaration', node))
    return
  }
  editNode(edits, node, code)
  rewrites.push(record('export', 'removed a local re-export declaration', node))
}

function exportAllEdits(node, code, edits, rewrites, moduleLoads) {
  if (node.exportKind === 'type') {
    editNode(edits, node, code)
    rewrites.push(record('export', 'removed a type-only export declaration', node, 'type'))
    return
  }
  const source = parseSource(node)
  moduleLoads.push(moduleLoad(node, source))
  editNode(edits, node, code)
  rewrites.push(record('export', `converted the re-export of ${JSON.stringify(source)} into a side-effect import`, node, source))
}

function exportDefaultEdits({
  node,
  code,
  edits,
  rewrites,
  defaultNameAvailable,
  exportDeclarations,
  imports,
  allocateNamespace,
  commitSignal,
  commitTargets,
}) {
  const declaration = node.declaration
  if (declaration.type === 'TSInterfaceDeclaration') {
    editNode(edits, node, code)
    rewrites.push(record('export', 'removed a type-only export declaration', node, 'interface'))
    return
  }
  if (!defaultNameAvailable) {
    throw new ModuleRewriteError(
      'export default cannot be exposed as __default because that name is already declared',
      { line: node.loc.start.line, column: node.loc.start.column + 1 },
    )
  }
  const namedDeclaration = (declaration.type === 'FunctionDeclaration'
    || declaration.type === 'ClassDeclaration') && declaration.id !== null
  const retainedNamedDeclaration = namedDeclaration && declaration.id.name !== '__default'
  const existingAlias = imports.get('__default')
  const reuseAlias = existingAlias?.syntheticDefault === true
  const namespace = reuseAlias ? existingAlias.namespace : allocateNamespace('default_namespace')
  const member = importMember(namespace, 'default')
  imports.set('__default', {
    namespace,
    imported: 'default',
    syntheticDefault: true,
    commitDependency: '__default',
  })
  commitTargets.add('__default')
  if (declaration.type === 'ClassDeclaration' && declaration.id !== null) {
    commitTargets.add(declaration.id.name)
  }
  exportDeclarations.push({
    name: '__default',
    kind: declaration.type === 'FunctionDeclaration'
      ? 'function'
      : declaration.type === 'ClassDeclaration' ? 'class' : 'variable',
    commitDependency: '__default',
    span: {
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      end: {
        line: node.loc.end.line,
        column: node.loc.end.column + 1,
      },
    },
    definitionSpan: {
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      end: {
        line: node.loc.end.line,
        column: node.loc.end.column + 1,
      },
    },
    original: true,
  })
  const rewrite = record('export', 'converted the default export into a local __default binding', node)
  const commit = [...new Set([...(declaration.type === 'ClassDeclaration' && declaration.id !== null
    ? [declaration.id.name]
    : []), '__default'])]
    .map(name => ` this[${JSON.stringify(commitSignal)}](${JSON.stringify(name)});`)
    .join('')
  const assignmentPrefix = reuseAlias ? `${member} = ` : `const ${namespace} = { default: `
  const assignmentSuffix = reuseAlias ? '' : ' }'
  if (retainedNamedDeclaration) {
    edit(edits, node.start, declaration.start, preserveLines(code.slice(node.start, declaration.start)))
    edit(edits, node.end, node.end,
      `; ${assignmentPrefix}${declaration.id.name}${assignmentSuffix};${commit}`)
  } else if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    const prefix = code.slice(node.start, declaration.start)
    edit(edits, node.start, declaration.start, preserveLines(prefix, assignmentPrefix))
    edit(edits, node.end, node.end, `${assignmentSuffix};${commit}`)
  } else {
    const prefix = code.slice(node.start, declaration.start)
    edit(edits, node.start, declaration.start, preserveLines(prefix, assignmentPrefix))
    edit(edits, node.end, node.end, `${assignmentSuffix};${commit}`)
  }
  rewrites.push(rewrite)
}

function legacyExportDefaultEdits(node, code, edits, rewrites, defaultNameAvailable, exportDeclarations) {
  const declaration = node.declaration
  if (declaration.type === 'TSInterfaceDeclaration') {
    editNode(edits, node, code)
    rewrites.push(record('export', 'removed a type-only export declaration', node, 'interface'))
    return
  }
  if (declaration.id?.name === '__default') {
    edit(edits, node.start, declaration.start, preserveLines(code.slice(node.start, declaration.start)))
    rewrites.push(record('export', 'stripped the export modifier from the __default declaration', node))
    return
  }
  if (!defaultNameAvailable) {
    throw new ModuleRewriteError(
      'export default cannot be exposed as __default because that name is already declared',
      { line: node.loc.start.line, column: node.loc.start.column + 1 },
    )
  }
  exportDeclarations.push({
    name: '__default',
    kind: declaration.type === 'FunctionDeclaration'
      ? 'function'
      : declaration.type === 'ClassDeclaration' ? 'class' : 'variable',
    span: {
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      end: {
        line: node.loc.end.line,
        column: node.loc.end.column + 1,
      },
    },
    definitionSpan: {
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      end: {
        line: node.loc.end.line,
        column: node.loc.end.column + 1,
      },
    },
    original: true,
  })
  const rewrite = record('export', 'converted the default export into a local __default binding', node)
  if (declaration.type === 'FunctionDeclaration' && declaration.id !== null) {
    const prefix = code.slice(node.start, declaration.start)
    edit(edits, node.start, declaration.start, preserveLines(prefix, `const __default = ${declaration.id.name}; `))
  } else if (declaration.type === 'ClassDeclaration' && declaration.id !== null) {
    edit(edits, node.start, declaration.start, preserveLines(code.slice(node.start, declaration.start)))
    edit(edits, node.end, node.end, `; const __default = ${declaration.id.name};`)
  } else if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    const prefix = code.slice(node.start, declaration.start)
    edit(edits, node.start, declaration.start, preserveLines(prefix, 'const __default = '))
    edit(edits, node.end, node.end, ';')
  } else {
    const prefix = code.slice(node.start, declaration.start)
    edit(edits, node.start, declaration.start, preserveLines(prefix, 'const __default = '))
  }
  rewrites.push(rewrite)
}

function ascending(left, right) { return left.at - right.at }

export function rewriteModuleImportsExports(program, enabled, existingImports = new Map(), existingNamespaces = new Set(), unavailableNames = new Set(), moduleSemantics = { defaultExportBinding: LIVE_DEFAULT_EXPORT_BINDING }) {
  if (![LEGACY_DEFAULT_EXPORT_BINDING, LIVE_DEFAULT_EXPORT_BINDING]
    .includes(moduleSemantics?.defaultExportBinding)) {
    throw new TypeError('ptc-plus: unsupported default export binding semantics')
  }
  const tree = parseCell(program)
  const edits = []
  const rewrites = []
  const imports = new Map(existingImports)
  const importDeclarations = []
  const exportDeclarations = []
  const moduleLoads = []
  const importNamespaces = new Set(existingNamespaces)
  const allocateName = createGeneratedNameAllocator(tree, [...unavailableNames, ...importNamespaces])
  const commitSignal = allocateName('redeclaration_commit')
  const generatedNamespaces = new Set()
  const allocateImportName = purpose => {
    const name = allocateName(purpose)
    importNamespaces.add(name)
    generatedNamespaces.add(name)
    return name
  }
  const namespaceCaptures = []
  const commitTargets = new Set()
  const currentCellDefaultNameAvailable = !tree.body.some((node) => {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (declaration?.type === 'VariableDeclaration' && declaration.declare !== true) {
      return declaration.declarations.some(entry => bindingNodes(entry.id).some(binding => binding.name === '__default'))
    }
    if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
      return declaration.id?.name === '__default'
    }
    return node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.specifiers.some(specifier => (
      specifier.importKind !== 'type' && specifier.local.name === '__default'
    ))
  })
  const existingDefault = existingImports.get('__default')
  const persistentDefaultNameAvailable = !unavailableNames.has('__default')
    || existingDefault?.syntheticDefault === true
  const defaultNameAvailable = currentCellDefaultNameAvailable
    && (moduleSemantics.defaultExportBinding === LEGACY_DEFAULT_EXPORT_BINDING
      || persistentDefaultNameAvailable)
  for (const node of tree.body) {
    if (node.type === 'ImportDeclaration' && enabled.autoRewriteImports) {
      importEdits(node, program, edits, rewrites, imports, importDeclarations,
        moduleLoads, namespaceCaptures, allocateImportName, allocateName)
    }
    else if (node.type === 'ExportNamedDeclaration' && enabled.autoStripExports) {
      exportNamedEdits(node, program, edits, rewrites, moduleLoads)
    }
    else if (node.type === 'ExportAllDeclaration' && enabled.autoStripExports) {
      exportAllEdits(node, program, edits, rewrites, moduleLoads)
    }
    else if (node.type === 'ExportDefaultDeclaration' && enabled.autoStripExports) {
      if (moduleSemantics.defaultExportBinding === LEGACY_DEFAULT_EXPORT_BINDING) {
        legacyExportDefaultEdits(
          node, program, edits, rewrites, defaultNameAvailable, exportDeclarations,
        )
      } else {
        exportDefaultEdits({
          node,
          code: program,
          edits,
          rewrites,
          defaultNameAvailable,
          exportDeclarations,
          imports,
          allocateNamespace: allocateImportName,
          commitSignal,
          commitTargets,
        })
      }
    }
  }
  assertNoDynamicImportResolution(tree, imports)
  const prologue = importPrologueEdit(program, tree, namespaceCaptures)
  if (prologue !== undefined) edits.push(prologue)
  const applied = applySourceEdits(program, identitySourceMap(program.length), edits)
  const rewritten = rewriteImportReferences(applied.code, applied.sourceMap, imports)
  rewrites.sort(ascending)
  return {
    ...rewritten,
    imports,
    importNamespaces,
    generatedNamespaces,
    importDeclarations,
    exportDeclarations,
    moduleLoads,
    commitSignal,
    commitTargets,
    rewrites: rewrites.map(({ at: _at, ...rest }) => rest),
  }
}
