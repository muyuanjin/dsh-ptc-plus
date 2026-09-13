/** Compile each cell into a private native frame backed by session identities. */
import { adaptRootModuleImports } from './managed-module-operations.js'
import { parse } from '@babel/parser'
import { createHash } from 'node:crypto'
import traverseModule from '@babel/traverse'
import { bindingNodes, createGeneratedNameAllocator, isWriteIdentifier } from './binding-pattern.js'
import { applySourceEdits, createMappedTextBuilder, identitySourceMap, mapSourceSpan } from './source-position-map.js'
import { CELL_PARSER_PLUGINS, RECOVERABLE_CELL_PARSE_ERRORS } from './repl-scope-normalizer.js'
import { adaptDynamicCell } from './dynamic-environment-integration.js'
import { sourceBinding, varInitializerTarget } from './dynamic-scope-analysis.js'

const traverse = traverseModule.default ?? traverseModule
const PARSER_OPTIONS = {
  sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
  allowImportExportEverywhere: true, allowUndeclaredExports: true, plugins: CELL_PARSER_PLUGINS,
}
const TYPE_ONLY = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'])

function span(node) {
  return { line: node.loc.start.line, column: node.loc.start.column + 1,
    end: { line: node.loc.end.line, column: node.loc.end.column + 1 } }
}

function rootDeclarations(tree) {
  const declarations = []
  traverse(tree, { noScope: true,
    VariableDeclaration(path) {
      if (path.node.declare === true) return
      const direct = path.parent.type === 'Program' || path.parent.type === 'ExportNamedDeclaration'
      if (direct || path.node.kind === 'var' && path.getFunctionParent() === null
        && path.findParent(parent => parent.isClass() || parent.isStaticBlock()) === null) declarations.push(path)
    },
    FunctionDeclaration(path) {
      let owner = path.parentPath
      while (owner.isLabeledStatement()) owner = owner.parentPath
      if (owner.isProgram() || owner.isExportNamedDeclaration()
        || owner.isExportDefaultDeclaration()) declarations.push(path)
    },
    ClassDeclaration(path) {
      if (path.parent.type === 'Program' || path.parent.type === 'ExportNamedDeclaration'
        || path.parent.type === 'ExportDefaultDeclaration') declarations.push(path)
    },
  })
  return declarations
}

function patternText(pattern, code, reference) {
  const ids = new Set(bindingNodes(pattern))
  const edits = []
  const visit = (node, parent, grandparent) => {
    if (node === null || typeof node !== 'object') return
    if (ids.has(node)) {
      const shorthand = parent?.type === 'ObjectProperty' && parent.shorthand && parent.value === node
        || parent?.type === 'AssignmentPattern' && grandparent?.type === 'ObjectProperty' && grandparent.shorthand
      edits.push({ start: node.start, end: node.end,
        text: `${shorthand ? `[${JSON.stringify(node.name)}]: ` : ''}${reference(node)}` })
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(child => visit(child, node, parent))
      else if (value?.type !== undefined) visit(value, node, parent)
    }
  }
  visit(pattern)
  const selected = edits.sort((a, b) => a.start - b.start)
  const builder = createMappedTextBuilder(code)
  let offset = pattern.start
  for (const edit of selected) {
    builder.appendSource(offset, edit.start)
    builder.appendMapped(edit.text, edit.start, edit.end)
    offset = edit.end
  }
  builder.appendSource(offset, pattern.end)
  return builder.result()
}

function ownsImplicitArguments(path) {
  return path.node.name === 'arguments'
    && path.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression()) !== null
}

function rewriteRootReferences(code, sourceMap, runtime, candidateNames, candidateReferences, originalSource) {
  const tree = parse(code, PARSER_OPTIONS)
  const edits = []
  const classificationEdits = []
  const handled = new Set()
  const implicitDeclarations = new Map()
  const readNames = new Set()
  const dynamicFunctions = new WeakSet()
  traverse(tree, { CallExpression(path) {
    if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'eval') {
      const fn = path.getFunctionParent()
      if (fn !== null) dynamicFunctions.add(fn.node)
    }
  } })
  const sourceIdentity = createHash('sha256').update(originalSource).digest('hex')
  traverse(tree, { Identifier(path) {
    if (!isWriteIdentifier(path) || sourceBinding(path, path.node.name) !== undefined || ownsImplicitArguments(path)) return
    const assignment = path.findParent(parent => parent.isAssignmentExpression() || parent.isUpdateExpression()
      || parent.isForOfStatement() || parent.isForInStatement())
    const position = mapSourceSpan(span(path.node), code, originalSource, sourceMap)
    implicitDeclarations.set(path.node.start, { name: path.node.name, kind: 'variable', writable: true,
      target: `write:${sourceIdentity}:${position.line}:${position.column}:${path.node.name}`,
      definitionSpan: mapSourceSpan(span(assignment.node), code, originalSource, sourceMap) })
  } })
  const candidateFor = path => {
    const assignment = path.findParent(parent => parent.isAssignmentExpression()
      && (parent.node.left.type === 'ArrayPattern' || parent.node.left.type === 'ObjectPattern'))
    if (assignment === null || path.node.start > assignment.node.left.end) return undefined
    for (const [candidate, names] of candidateNames) {
      if (!names.has(path.node.name)) continue
      const mentions = node => {
        if (node === null || typeof node !== 'object') return false
        if (node.type === 'Identifier' && node.name === candidate) return true
        return Object.values(node).some(value => Array.isArray(value)
          ? value.some(mentions) : value?.type !== undefined && mentions(value))
      }
      if (mentions(assignment.node.left)) return candidate
    }
    return undefined
  }
  traverse(tree, { Decorator(path) {
    const expression = path.node.expression
    if (expression.extra?.parenthesized) return
    // A computed root reference has a wider grammar than a bare decorator name.
    const boundaries = [{ start: expression.start, end: expression.start, text: '(' },
      { start: expression.end, end: expression.end, text: ')' }]
    edits.push(...boundaries)
    classificationEdits.push(...boundaries)
  }, TSTypeAssertion(path) {
    const edit = { start: path.node.start, end: path.node.expression.start,
      text: ' '.repeat(path.node.expression.start - path.node.start) }
    edits.push(edit)
    classificationEdits.push(edit)
  }, Identifier(path) {
    if (handled.has(path.node.start) || sourceBinding(path, path.node.name) !== undefined || ownsImplicitArguments(path)) return
    if (!path.isReferencedIdentifier() && !isWriteIdentifier(path)) return
    if (path.findParent(parent => parent.isVariableDeclarator() && parent.node.id.name === runtime
      || parent.isCallExpression() && parent.node.callee.type === 'MemberExpression'
        && parent.node.callee.object.name === runtime && parent.node.callee.property.name === 'import'
        && path.node.start >= parent.node.arguments[1].start && path.node.end <= parent.node.arguments[1].end) !== null) return
    const parent = path.parent
    // The direct-eval environment adapter owns this syntax and its callable
    // identity check. A property read here would turn it into indirect eval.
    if (path.node.name === 'eval' && parent.type === 'CallExpression' && parent.callee === path.node) return
    const selectedCandidate = candidateFor(path)
    if (selectedCandidate === undefined && path.findParent(parent => parent.isWithStatement() && parent.get('body').isAncestor(path)) !== null) return
    if (path.findParent(parent => parent.isFunction() && dynamicFunctions.has(parent.node)) !== null) return
    if (parent.type.startsWith('TS') && parent.expression !== path.node) return
    // A static reference to an outer identity is a reuse event candidate.
    // `for (x of ...)` and `for (x in ...)` bind the left target without
    // reading its previous value, and `delete x` removes the reference without
    // reading it, so both stay out; compound assignment, updates and `typeof`
    // do read it.
    const write = isWriteIdentifier(path)
    const forHeadWrite = (parent.type === 'ForOfStatement' || parent.type === 'ForInStatement') && path.key === 'left'
    const deleted = parent.type === 'UnaryExpression' && parent.operator === 'delete'
    if ((path.isReferencedIdentifier() && !forHeadWrite && !deleted)
      || write && parent.type === 'AssignmentExpression' && parent.operator !== '=') readNames.add(path.node.name)
    const owner = selectedCandidate ?? runtime
    const selectedReference = candidateReferences.has(owner)
    let text = selectedReference ? `${owner}().value` : `${owner}.values[${JSON.stringify(path.node.name)}]`
    if (!selectedReference && isWriteIdentifier(path)) {
      text = `${owner}.reference(${JSON.stringify(path.node.name)}, ${path.isInStrictMode()}, ${JSON.stringify(implicitDeclarations.get(path.node.start).target)}).value`
    }
    if (parent.type === 'UnaryExpression' && (parent.operator === 'typeof' && owner === runtime
      || selectedReference && ['typeof', 'delete'].includes(parent.operator))) {
      edits.push({ start: parent.start, end: parent.end,
        text: selectedReference ? `${owner}().${parent.operator}()` : `${runtime}.typeof(${JSON.stringify(path.node.name)})` })
      handled.add(path.node.start)
      return
    }
    const callable = (parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && parent.callee === path.node
      || parent.type === 'TaggedTemplateExpression' && parent.tag === path.node
    if (callable) text = selectedReference ? `${owner}().callee` : `(0, ${text})`
    if (parent.type === 'ObjectProperty' && parent.shorthand && parent.value === path.node) text = `[${JSON.stringify(path.node.name)}]: ${text}`
    edits.push({ start: path.node.start, end: path.node.end, text,
      ...(callable ? { mappings: [{ generatedStart: 0, generatedEnd: text.length,
        originalStart: path.node.start, originalEnd: path.node.start + 1 }] } : {}) })
    if (callable) {
      // V8 reports an indirect call at its opening argument delimiter. Keep
      // that generated call frame anchored to the source callee; arguments
      // retain their own independent mappings.
      const end = parent.type === 'TaggedTemplateExpression' ? parent.quasi.start + 1
        : parent.arguments[0]?.start ?? parent.end
      const punctuation = code.slice(path.node.end, end)
      edits.push({ start: path.node.end, end, text: punctuation,
        mappings: [{ generatedStart: 0, generatedEnd: punctuation.length,
          originalStart: path.node.start, originalEnd: path.node.start + 1 }] })
    }
    handled.add(path.node.start)
  } })
  return { ...applySourceEdits(code, sourceMap, edits),
    classificationCode: applySourceEdits(code, sourceMap, classificationEdits).code,
    implicitDeclarations: [...implicitDeclarations.values()],
    readNames: [...readNames] }
}

export function compileStatefulRoot(program, {
  sourceMap = identitySourceMap(program.length), knownBindings = new Set(), reservedBindings = new Set(),
  originalSource = program,
  unavailableNames = [], languageSemantics = 'stateful-v1',
  importBindings = new Map(), writableBindings = new Set(),
  nativeBindings = new Set(),
  nativeLexicalBindings = new Set(),
  internalBindings = new Set(),
  dynamicBindings = [],
  privateBindings = [],
  dynamicOrigins = [],
  rootCandidates = new Map(),
  establishedRoots = new Map(),
  runtimeExpression, moduleExpression = global => `this[${JSON.stringify(global)}]`,
} = {}) {
  let file = parse(program, { ...PARSER_OPTIONS, errorRecovery: true })
  // Identifier name inference must precede root and pattern reference lowering.
  const inferredNames = []
  traverse(file, { noScope: true, 'AssignmentExpression|AssignmentPattern|VariableDeclarator'(path) {
    if (path.node.type === 'AssignmentExpression' && !['=', '&&=', '||=', '??='].includes(path.node.operator)) return
    const initializer = path.node.type === 'VariableDeclarator' ? path.node.init : path.node.right
    if (initializer === null) return
    let name = path.node.type === 'VariableDeclarator' ? path.node.id : path.node.left
    let value = initializer
    while ((name.type.startsWith('TS') || name.type === 'ParenthesizedExpression') && name.expression) name = name.expression
    while ((value.type.startsWith('TS') || value.type === 'ParenthesizedExpression') && value.expression) value = value.expression
    if (name.type !== 'Identifier' || !(value.type === 'ArrowFunctionExpression'
      || ['FunctionExpression', 'ClassExpression'].includes(value.type) && value.id === null)) return
    inferredNames.push({ start: initializer.start, end: initializer.start, text: `({[${JSON.stringify(name.name)}]:(` },
      { start: initializer.end, end: initializer.end, text: `)})[${JSON.stringify(name.name)}]` })
  } })
  if (inferredNames.length !== 0) {
    const named = applySourceEdits(program, sourceMap, inferredNames)
    program = named.code
    sourceMap = named.sourceMap
    file = parse(program, { ...PARSER_OPTIONS, errorRecovery: true })
  }
  const protectedError = file.errors.find(error => error.reasonCode !== 'UnexpectedUsingDeclaration')
  if (languageSemantics === 'protected-v1' && protectedError !== undefined) throw protectedError
  const syntaxError = file.errors.find(error => !RECOVERABLE_CELL_PARSE_ERRORS.has(error.reasonCode))
  if (syntaxError !== undefined) throw syntaxError
  const root = rootDeclarations(file).filter(path => path.node.type === 'VariableDeclaration'
    ? !path.node.declarations.every(declarator => {
      const bindings = bindingNodes(declarator.id)
      return bindings.length > 0 && bindings.every(binding => internalBindings.has(binding.name))
    })
    : !internalBindings.has(path.node.id?.name))
  const paths = new Map()
  traverse(file, { noScope: true, enter(path) { paths.set(path.node, path) } })
  const logicalNames = new Map(dynamicBindings.map(binding => [binding.physicalName, binding.name]))
  const allocate = createGeneratedNameAllocator(file, [...knownBindings, ...reservedBindings, ...unavailableNames])
  const runtime = allocate('root')
  const rootRuntimeName = allocate('root_runtime')
  const commitSignal = allocate('root_commit')
  const declarations = []
  const declarationKinds = new Map()
  const commitTargets = new Set()
  const candidateNames = new Map()
  const candidateReferences = new Set()
  const moduleLoads = []
  const imports = new Map()
  const rewrites = []
  const edits = []
  const prologue = []
  let varReferenceMarker
  const varReference = () => {
    if (!varReferenceMarker) {
      varReferenceMarker = allocate('var_reference')
      internalBindings.add(varReferenceMarker)
      dynamicBindings.push({ physicalName: varReferenceMarker, role: 'var-reference' })
      prologue.push(`const ${varReferenceMarker}=void 0;`)
    }
    return varReferenceMarker
  }
  const hoisted = []
  const readOnly = new Set()
  const rootKinds = new Map()
  const sourceCopies = new Map()
  const remember = (text, mappings) => { sourceCopies.set(text, mappings); return text }
  const mapParts = parts => {
    let offset = 0
    return parts.flatMap(text => {
      const mappings = (sourceCopies.get(text) ?? []).map(mapping => ({ ...mapping,
        generatedStart: mapping.generatedStart + offset, generatedEnd: mapping.generatedEnd + offset }))
      offset += text.length
      return mappings
    })
  }
  const emptyCompletion = expression => `const ${allocate('declaration_completion')} = (${expression});`
  for (const path of root) {
    const node = path.node
    for (const binding of node.type === 'VariableDeclaration'
      ? node.declarations.flatMap(declarator => bindingNodes(declarator.id)) : node.id === null ? [] : [node.id]) {
      const kinds = rootKinds.get(binding.name) ?? new Set()
      kinds.add(node.type === 'VariableDeclaration' ? node.kind : node.type)
      rootKinds.set(binding.name, kinds)
    }
  }
  const canInstantiate = name => !knownBindings.has(name) && !imports.has(name)
    && rootKinds.has(name)
    && [...rootKinds.get(name)].every(kind => kind === 'var' || kind === 'FunctionDeclaration')
  const record = (name, kind, node, binding = node, suffix = '') => {
    const target = `root:${node.start}:${name}${suffix}`
    declarationKinds.set(target, kind === 'import' ? 'const' : kind === 'function' ? 'hoisted'
      : kind === 'class' ? 'let' : node.kind ?? 'const')
    declarations.push({ name, kind, writable: languageSemantics === 'stateful-v1'
      || kind !== 'import' && (kind !== 'variable' || node.kind === 'let' || node.kind === 'var'),
      original: true, span: mapSourceSpan(span(binding), program, originalSource, sourceMap),
      definitionSpan: mapSourceSpan(span(node), program, originalSource, sourceMap), commitDependency: target })
    commitTargets.add(target)
    return target
  }
  const variable = (node, declarator, supplied = undefined) => {
    const bindings = bindingNodes(declarator.id)
    const names = [...new Set(bindings.map(binding => binding.name))]
    if (names.length === 0) {
      const original = supplied === undefined ? declarator : declarator.id
      const source = program.slice(original.start, original.end)
      const text = `const ${source}${supplied === undefined ? '' : ` = (${supplied})`};`
      return remember(text, [{ generatedStart: 6, generatedEnd: 6 + source.length,
        originalStart: original.start, originalEnd: original.end }])
    }
    const target = record(names[0], 'variable', node, bindings[0], `:${declarator.start}`)
    for (const binding of bindings.slice(1)) {
      record(binding.name, 'variable', node, binding, `:${declarator.start}`)
      declarations.at(-1).commitDependency = target
    }
    if (declarator.init === null && supplied === undefined) {
      return emptyCompletion(`${runtime}.declare(${JSON.stringify(names[0])}, ${JSON.stringify(target)})`)
    }
    let value = supplied ?? program.slice(declarator.init.start, declarator.init.end)
    const redirected = new Map()
    const initializerTargets = new Map()
    if (node.kind === 'var') for (const binding of bindings) {
      const selected = varInitializerTarget(paths.get(binding), file.program, binding.name,
        node => logicalNames.get(node.name) ?? node.name)
      initializerTargets.set(binding.name, selected)
      if (selected.catchNode) {
        redirected.set(binding.name, selected.catchNode.param.name)
      }
    }
    if (declarator.id.type === 'Identifier') {
      const selected = redirected.get(names[0])
      const withDepth = initializerTargets.get(names[0])?.withNodes.length
      const fallbackRead = selected ?? `${runtime}.values[${JSON.stringify(names[0])}]`
      const fallbackWrite = selected === undefined
        ? `${runtime}.assign(${JSON.stringify(names[0])}, next, ${JSON.stringify(target)})` : `${selected}=next`
      const text = withDepth
        ? emptyCompletion(`${varReference()}(${JSON.stringify(names[0])},${withDepth},{get:()=>${fallbackRead},set:next=>${fallbackWrite}}).value = (${value})`)
        : selected === undefined
        ? emptyCompletion(`${runtime}.assign(${JSON.stringify(names[0])}, (${value}), ${JSON.stringify(target)})`)
        : emptyCompletion(`(${selected} = (${value}), ${runtime}.declare(${JSON.stringify(names[0])}, ${JSON.stringify(target)}))`)
      if (supplied === undefined) {
        const original = program.slice(declarator.init.start, declarator.init.end)
        const start = text.indexOf(withDepth ? `= (${value})` : selected === undefined ? `, (${value}),` : `= (${value}),`) + 3 + value.indexOf(original)
        remember(text, [{ generatedStart: start, generatedEnd: start + original.length,
          originalStart: declarator.init.start, originalEnd: declarator.init.end }])
      }
      return text
    }
    const candidate = allocate('candidate')
    const rhs = allocate('candidate_rhs')
    const stored = names.filter(name => !redirected.has(name))
    candidateNames.set(candidate, new Set(stored))
    const captured = stored.filter(name => !initializerTargets.get(name)?.withNodes.length)
    if (captured.length > 0) dynamicBindings.push({ physicalName: candidate, names: captured,
      kind: node.kind, role: 'candidate', property: 'values', referenceMethod: 'reference' })
    const references = new Map()
    const referenceDeclarations = []
    for (const name of names) {
      const withDepth = initializerTargets.get(name)?.withNodes.length
      if (!withDepth) continue
      const reference = allocate('candidate_reference')
      const caught = redirected.get(name)
      const pending = allocate('candidate_written')
      const fallback = caught ?? `${candidate}.values[${JSON.stringify(name)}]`
      const get = caught ?? `${pending}?${fallback}:${runtime}.values[${JSON.stringify(name)}]`
      const set = caught === undefined ? `(${pending}=true,${fallback}=next)` : `${caught}=next`
      referenceDeclarations.push(`${caught === undefined ? `let ${pending}=false;` : ''}const ${reference}=()=>${varReference()}(${JSON.stringify(name)},${withDepth},{get:()=>${get},set:next=>${set}});`)
      internalBindings.add(pending)
      candidateReferences.add(reference)
      candidateNames.set(reference, new Set([name]))
      references.set(name, `${reference}().value`)
      dynamicBindings.push({ physicalName: reference, name, kind: 'let', role: 'candidate', reference: true, accessor: true })
    }
    const pattern = patternText(declarator.id, program, binding => references.get(binding.name) ?? redirected.get(binding.name)
      ?? `${candidate}.values[${JSON.stringify(binding.name)}]`)
    const text = `{ const ${rhs} = (${value}); const ${candidate} = ${runtime}.candidate(${JSON.stringify(stored)}); ${referenceDeclarations.join('')} ${emptyCompletion(`((${pattern.text} = ${rhs}), ${candidate}.commit(${JSON.stringify(target)}))`)} }`
    const valueStart = text.indexOf(`= (${value})`) + 3
    const patternStart = text.indexOf(pattern.text)
    return remember(text, [...(supplied === undefined ? [{ generatedStart: valueStart, generatedEnd: valueStart + value.length,
      originalStart: declarator.init.start, originalEnd: declarator.init.end }] : []),
    ...pattern.mappings.map(mapping => ({ ...mapping, generatedStart: patternStart + mapping.generatedStart,
      generatedEnd: patternStart + mapping.generatedEnd }))])
  }
  const addLoad = node => {
    const global = allocate('root_module')
    const requiredExports = node.type === 'ImportDeclaration' ? node.specifiers
      .filter(specifier => specifier.importKind !== 'type' && specifier.type !== 'ImportNamespaceSpecifier')
      .map(specifier => specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name ?? specifier.imported.value) : []
    const attributes = node.attributes?.length > 0 ? { with: Object.fromEntries(node.attributes
      .map(attribute => [attribute.key.name ?? attribute.key.value, attribute.value.value])) } : undefined
    moduleLoads.push({ source: node.source.value, global, position: mapSourceSpan(span(node.source), program, originalSource, sourceMap),
      ...(requiredExports.length === 0 ? {} : { requiredExports: [...new Set(requiredExports)] }),
      ...(attributes === undefined ? {} : { options: attributes }) })
    return global
  }
  for (const node of file.program.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind !== 'type' && (node.specifiers.length === 0
        || node.specifiers.some(specifier => specifier.importKind !== 'type'))) {
        const global = addLoad(node)
        for (const specifier of node.specifiers.filter(specifier => specifier.importKind !== 'type')) {
          const name = specifier.local.name
          readOnly.add(name)
          const imported = specifier.type === 'ImportNamespaceSpecifier' ? null
            : specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name ?? specifier.imported.value
          const target = record(name, 'import', node, specifier.local)
          imports.set(name, { namespace: global, ...(imported === null ? {} : { imported }), commitDependency: target })
          prologue.push(emptyCompletion(`${runtime}.import(${JSON.stringify(name)}, ${moduleExpression(global)}, ${JSON.stringify(imported)}, ${JSON.stringify(target)})`))
        }
        rewrites.push({ kind: 'import', description: `adapted the static import of ${JSON.stringify(node.source.value)}`, source: node.source.value })
      } else {
        rewrites.push({ kind: 'import', description: `removed the type-only import of ${JSON.stringify(node.source.value)}`, source: node.source.value })
      }
      edits.push({ start: node.start, end: node.end, text: '' })
    } else if (node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration' && node.declaration === null) {
      if (node.source !== null && node.exportKind !== 'type') addLoad(node)
      rewrites.push({ kind: 'export', description: node.exportKind === 'type'
        ? 'removed a type-only export declaration'
        : node.source == null ? 'removed a local re-export declaration'
          : `converted the re-export of ${JSON.stringify(node.source.value)} into a side-effect import` })
      edits.push({ start: node.start, end: node.end, text: '' })
    } else if (node.type === 'ExportNamedDeclaration') {
      rewrites.push({ kind: 'export', description: 'stripped the export modifier from a top-level declaration' })
      edits.push({ start: node.start, end: node.declaration.start, text: '' })
    } else if (node.type === 'ExportDefaultDeclaration') {
      rewrites.push({ kind: 'export', description: TYPE_ONLY.has(node.declaration.type)
        ? 'removed a type-only export declaration'
        : 'converted the default export into a local __default binding' })
      if (TYPE_ONLY.has(node.declaration.type)) {
        edits.push({ start: node.start, end: node.end, text: '' })
      } else if (!['FunctionDeclaration', 'ClassDeclaration'].includes(node.declaration.type)) {
        const target = record('__default', 'variable', node)
        edits.push({ start: node.start, end: node.end,
          text: emptyCompletion(`${runtime}.assign("__default", (${program.slice(node.declaration.start, node.declaration.end)}), ${JSON.stringify(target)})`) })
      }
    }
  }
  for (const path of root) {
    const node = path.node
    if (node.type === 'VariableDeclaration') {
      if (node.kind === 'const' || node.kind === 'using' || node.kind === 'await using') {
        for (const binding of node.declarations.flatMap(declarator => bindingNodes(declarator.id))) readOnly.add(binding.name)
      }
      if (node.kind === 'using' || node.kind === 'await using') {
        // Resource lifetime owns the acquired value even when the public
        // logical binding is replaced before the scope ends.
        const parts = node.declarations.flatMap(declarator => {
          const resource = allocate('root_resource')
          const value = program.slice(declarator.init.start, declarator.init.end)
          const resourceText = `${node.kind} ${resource} = (${value});`
          const valueStart = resourceText.indexOf(`= (${value})`) + 3
          remember(resourceText, [{ generatedStart: valueStart, generatedEnd: valueStart + value.length,
            originalStart: declarator.init.start, originalEnd: declarator.init.end }])
          return [resourceText, variable(node, declarator, resource)]
        })
        edits.push({ start: node.start, end: node.end, text: parts.join(''), mappings: mapParts(parts) })
        continue
      }
      for (const declarator of node.declarations) {
        if (node.kind !== 'var') continue
        for (const binding of bindingNodes(declarator.id)) {
          if (!canInstantiate(binding.name) || hoisted.includes(binding.name)) continue
          hoisted.push(binding.name)
          const target = record(binding.name, 'variable', node, binding, ':hoist')
          prologue.push(emptyCompletion(`${runtime}.declare(${JSON.stringify(binding.name)}, ${JSON.stringify(target)})`))
        }
      }
      if (path.parent.type === 'ForOfStatement' || path.parent.type === 'ForInStatement') {
        if (node.declarations[0].init !== null) {
          let owner = path.parentPath
          while (owner.parentPath?.isLabeledStatement()) owner = owner.parentPath
          const prefix = ['{ ', variable(node, node.declarations[0]), '\n']
          edits.push({ start: owner.node.start, end: owner.node.start, text: prefix.join(''), mappings: mapParts(prefix) })
          edits.push({ start: owner.node.end, end: owner.node.end, text: ' }' })
        }
        const temporary = allocate('iteration')
        edits.push({ start: node.start, end: node.end, text: `const ${temporary}` })
        const body = path.parent.body
        const assignments = variable(node, node.declarations[0], temporary)
        if (body.type === 'BlockStatement') edits.push({ start: body.start + 1, end: body.start + 1, text: assignments,
          mappings: sourceCopies.get(assignments) })
        else {
          edits.push({ start: body.start, end: body.start, text: `{ ${assignments}`, mappings: mapParts(['{ ', assignments]) })
          edits.push({ start: body.end, end: body.end, text: '}' })
        }
      } else {
        const variables = node.declarations.flatMap(declarator => [variable(node, declarator), '\n'])
        const parts = ['{ ', ...variables, ' }']
        if (path.parent.type === 'ForStatement') {
          let owner = path.parentPath
          while (owner.parentPath?.isLabeledStatement()) owner = owner.parentPath
          const prefix = ['{ ', ...parts]
          edits.push({ start: owner.node.start, end: owner.node.start, text: prefix.join(''), mappings: mapParts(prefix) })
          edits.push({ start: node.start, end: node.end, text: '' })
          edits.push({ start: owner.node.end, end: owner.node.end, text: ' }' })
        } else edits.push({ start: node.start, end: node.end, text: parts.join(''), mappings: mapParts(parts) })
      }
      continue
    }
    const name = node.id?.name ?? '__default'
    const kind = node.type === 'FunctionDeclaration' ? 'function' : 'class'
    const target = record(name, kind, node, node.id ?? node)
    let expression = program.slice(node.start, node.end)
    if (kind === 'function' && node.id !== null) {
      expression = `({ [${JSON.stringify(name)}]: ${program.slice(node.start, node.id.start)}${program.slice(node.id.end, node.end)} })[${JSON.stringify(name)}]`
    }
    if (node.id === null && path.parent.type === 'ExportDefaultDeclaration') {
      expression = `({ ["default"]: (${expression}) })["default"]`
    }
    const text = emptyCompletion(`${runtime}.assign(${JSON.stringify(name)}, (${expression}), ${JSON.stringify(target)})`)
    const expressionStart = text.indexOf(`, (${expression}),`) + 3
    const sourceStart = kind === 'function' && node.id !== null ? node.id.end : node.start
    const copied = program.slice(sourceStart, node.end)
    const copiedStart = expressionStart + expression.indexOf(copied)
    remember(text, [{ generatedStart: copiedStart, generatedEnd: copiedStart + copied.length,
      originalStart: sourceStart, originalEnd: node.end }])
    const canHoist = kind === 'function' && canInstantiate(name)
    if (canHoist) prologue.push(text)
    const defaultExport = path.parent.type === 'ExportDefaultDeclaration'
    const suffix = defaultExport
      ? emptyCompletion(`${runtime}.link("__default", ${JSON.stringify(name)}, ${JSON.stringify(record('__default', kind, path.parent))})`) : ''
    const replacement = [canHoist ? '' : text, suffix]
    if (path.parentPath.isLabeledStatement()) {
      replacement.unshift('{')
      replacement.push('}')
    }
    edits.push({ start: defaultExport ? path.parent.start : node.start,
      end: defaultExport ? path.parent.end : node.end, text: replacement.join(''),
      mappings: mapParts(replacement) })
  }
  const declared = new Set(declarations.map(declaration => declaration.name))
  const rootBindings = { declared: [...declared], known: [...knownBindings], candidates: [...rootCandidates],
    declarationKinds: [...declarationKinds],
    declaredKinds: [...new Map(declarations.map(declaration => [declaration.name, declarationKinds.get(declaration.commitDependency)]))],
    established: [...establishedRoots], readOnly: [...readOnly], languageSemantics,
    legacyImports: [...importBindings], legacyLexicals: [...knownBindings].filter(name => !importBindings.has(name)),
    legacyWritable: [...writableBindings].filter(name => !importBindings.has(name)),
    legacyNative: [...nativeBindings], legacyNativeLexicals: [...nativeLexicalBindings] }
  const accessRuntime = runtimeExpression === undefined ? `this[${JSON.stringify(rootRuntimeName)}]`
    : runtimeExpression(rootBindings)
  const prefixParts = [`;{\nconst ${runtime} = ${accessRuntime};\n`, ...prologue.flatMap(text => [text, '\n'])]
  const directiveEnd = file.program.directives.at(-1)?.end ?? 0
  if (directiveEnd === program.length) prefixParts.push('\n}')
  edits.unshift({ start: directiveEnd, end: directiveEnd, text: prefixParts.join(''), mappings: mapParts(prefixParts) })
  if (directiveEnd !== program.length) edits.push({ start: program.length, end: program.length, text: '\n}' })
  const merged = []
  for (const edit of edits.sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1)
    if (edit.start === edit.end && previous?.start === edit.start && previous.end === edit.end) {
      previous.mappings = [...(previous.mappings ?? []), ...(edit.mappings ?? []).map(mapping => ({ ...mapping,
        generatedStart: mapping.generatedStart + previous.text.length, generatedEnd: mapping.generatedEnd + previous.text.length }))]
      previous.text += edit.text
    } else merged.push({ ...edit })
  }
  const framed = applySourceEdits(program, sourceMap, merged)
  let rewritten = rewriteRootReferences(framed.code, framed.sourceMap, runtime, candidateNames, candidateReferences,
    originalSource)
  rewritten = adaptRootModuleImports(rewritten, runtime)
  rewritten = { ...rewritten, ...adaptDynamicCell(rewritten.code, rewritten.sourceMap, {
    rootRuntime: runtime, bindings: dynamicBindings, privateBindings, internalBindings, parserPlugins: CELL_PARSER_PLUGINS, originalSource,
  }) }
  rootBindings.dynamicOrigins = [...dynamicOrigins, ...rewritten.dynamicOrigins.map(origin => origin.target)]
  rootBindings.candidates = [...new Map([...rootCandidates, ...rewritten.implicitDeclarations.map(declaration => [declaration.target, declaration.name])])]
  // Each record carries the reason this owner determined, so the diagnostic surface does not
  // re-derive reserved-ness or protected policy from the request descriptors.
  const collisions = declarations.filter(declaration => reservedBindings.has(declaration.name)
    || languageSemantics === 'protected-v1' && knownBindings.has(declaration.name))
    .map(declaration => ({ name: declaration.name, kind: declaration.kind,
      reason: reservedBindings.has(declaration.name)
        ? 'reserved-program-binding-not-shadowable' : 'protected-root-redeclaration',
      start: { line: declaration.span.line, column: declaration.span.column }, end: declaration.span.end }))
  // A binding is reused only when this cell's rewritten source statically
  // references an identity that already existed and does not (re)declare that
  // same name. The count is a source fact, not a runtime trace: an unreached or
  // never-invoked reference still counts, and a redeclaration neither counts as
  // a reuse here nor resets the accumulated count it carries.
  const reusedNames = [...(rewritten.readNames ?? [])]
    .filter(name => knownBindings.has(name) && !declared.has(name))
  return {
    ...rewritten, languageSemantics, rootRuntimeName, rootFrameBinding: runtime, commitSignal, commitTargets, declarations, declared,
    rootPlan: rootBindings,
    rootBindings,
    rootBindingFacts: true, moduleLoads, imports, importNamespaces: new Set(), collisions,
    redeclared: declarations.filter(declaration => knownBindings.has(declaration.name)), rewrites,
    establishedRootLexicals: new Set(), reusedNames,
  }
}
