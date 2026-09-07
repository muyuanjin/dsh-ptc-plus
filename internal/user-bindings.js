import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { parse } from '@babel/parser'
import { prepareProgram } from './cell-analysis.js'
import { AMBIENT_GLOBALS } from './module-policy.js'
import { assertOwnFields, isRecord } from './record-utils.js'
import { bindingModelPreferences, normalizeBindingModelContext } from './user-binding-model-context.js'

export const USER_BINDINGS_META_KEY = 'dshPtcPlusUserBindings'
export const USER_BINDINGS_SNAPSHOT_VERSION = 1

const MAX_ENTRIES = 64
export const USER_BINDING_ID_MAX_LENGTH = 64
const MAX_NAME_LENGTH = 128
const MAX_PURPOSE_LENGTH = 240
const MAX_SOURCE_LENGTH = 64 * 1024
const MAX_SOURCE_TOTAL_LENGTH = 256 * 1024
const MAX_DECLARATION_TOTAL_LENGTH = 16 * 1024
const DOCUMENT_FIELDS = new Set(['entries'])
const ENTRY_FIELDS = new Set(['id', 'name', 'scope', 'symbols', 'purpose', 'enabled', 'source', 'modelContext'])
const SNAPSHOT_FIELDS = new Set(['version', 'revision', 'fingerprint', 'entries'])
const SNAPSHOT_ENTRY_FIELDS = new Set([...ENTRY_FIELDS, 'fingerprint', 'declaration', 'bindings', 'durability', 'volatileReason'])
const BINDING_FIELDS = new Set(['name', 'kind', 'declaration'])
const SCOPES = new Set(['namespace', 'top-level'])
const KINDS = new Set(['variable', 'function', 'class'])
const GLOBAL_TYPE_NAMES = new Set([
  'Array', 'ArrayBuffer', 'ArrayBufferView', 'AsyncIterable', 'AsyncIterableIterator',
  'AsyncIterator', 'Awaited', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean',
  'Buffer', 'ConstructorParameters', 'DataView', 'Date', 'Error', 'EvalError', 'Exclude',
  'Extract', 'Float32Array', 'Float64Array', 'Function', 'Generator', 'GeneratorFunction',
  'InstanceType', 'Int8Array', 'Int16Array', 'Int32Array', 'Iterable', 'IterableIterator',
  'Iterator', 'Map', 'NonNullable', 'Number', 'Object', 'Omit', 'OmitThisParameter',
  'Parameters', 'Partial', 'Pick', 'Promise', 'PromiseLike', 'RangeError', 'Readonly',
  'ReadonlyArray', 'ReadonlyMap', 'ReadonlySet', 'Record', 'ReferenceError', 'RegExp',
  'Required', 'ReturnType', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError',
  'ThisParameterType', 'ThisType', 'TypeError', 'URIError', 'Uint8Array', 'Uint8ClampedArray',
  'Uint16Array', 'Uint32Array', 'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
  'WeakMap', 'WeakSet',
])
const RESERVED_BINDINGS = new Set([
  ...AMBIENT_GLOBALS,
  'capabilities',
  'code',
  'repl',
  'tools',
  'CapabilityExplorationError',
  'CodeExecutionError',
  'ToolCallError',
  'Buffer',
  'console',
  'global',
  'globalThis',
  'module',
  'process',
])

function identifier(value, subject, reserved = false) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${subject} must be a non-empty identifier of at most ${MAX_NAME_LENGTH} characters`)
  }
  try {
    const { program } = parse(`const ${value} = 0`, { sourceType: 'module' })
    const declaration = program.body[0]
    const binding = declaration.declarations[0].id
    if (program.body.length !== 1 || declaration.declarations.length !== 1
      || binding.type !== 'Identifier' || binding.name !== value) {
      throw new TypeError('identifier spelling must match the complete binding name')
    }
  } catch {
    throw new TypeError(`${subject} must be a valid JavaScript identifier`)
  }
  if (reserved && RESERVED_BINDINGS.has(value)) {
    throw new TypeError(`${subject} conflicts with reserved REPL binding ${JSON.stringify(value)}`)
  }
  return value
}

function displayName(value) {
  if (typeof value !== 'string') throw new TypeError('binding name must be a string')
  const name = value.replace(/\s+/g, ' ').trim()
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`binding name must contain 1-${MAX_NAME_LENGTH} characters`)
  }
  return name
}

function sourceSlice(source, node) {
  return Number.isSafeInteger(node?.start) && Number.isSafeInteger(node?.end)
    ? source.slice(node.start, node.end)
    : ''
}

function bindingNames(pattern, names = []) {
  if (pattern?.type === 'Identifier') names.push(pattern.name)
  else if (pattern?.type === 'RestElement') bindingNames(pattern.argument, names)
  else if (pattern?.type === 'AssignmentPattern') bindingNames(pattern.left, names)
  else if (pattern?.type === 'ArrayPattern') {
    for (const element of pattern.elements) bindingNames(element, names)
  } else if (pattern?.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      bindingNames(property.type === 'RestElement' ? property.argument : property.value, names)
    }
  }
  return names
}

function typeParameterNames(node) {
  return (node?.params ?? [])
    .map(parameter => parameter?.name)
    .filter(name => typeof name === 'string')
}

function typeReferenceRoot(node) {
  let current = node
  while (current?.type === 'TSQualifiedName') current = current.left
  return current?.type === 'Identifier' ? current.name : undefined
}

function projectedType(source, node, outerTypeNames = new Set(), sourceTypeNames = new Set()) {
  const replacements = []
  const commentRanges = new Set()
  const visit = (current, inheritedNames) => {
    if (current === null || typeof current !== 'object') return
    if (current.type === 'CommentBlock' || current.type === 'CommentLine') {
      if (Number.isSafeInteger(current.start) && Number.isSafeInteger(current.end)
        && current.start >= node.start && current.end <= node.end) {
        const key = `${current.start}:${current.end}`
        if (!commentRanges.has(key)) {
          commentRanges.add(key)
          replacements.push({ start: current.start, end: current.end, text: ' ' })
        }
      }
      return
    }
    let typeNames = inheritedNames
    if (current.typeParameters?.type === 'TSTypeParameterDeclaration') {
      typeNames = new Set([...inheritedNames, ...typeParameterNames(current.typeParameters)])
    }
    if (current.type === 'TSMappedType' && typeof current.typeParameter?.name === 'string') {
      typeNames = new Set([...typeNames, current.typeParameter.name])
    }
    if (current.type === 'TSImportType' || current.type === 'TSTypeQuery') {
      replacements.push({ start: current.start, end: current.end, text: 'unknown' })
      return
    }
    if (current.type === 'TSTypeReference' || current.type === 'TSExpressionWithTypeArguments') {
      const name = typeReferenceRoot(current.typeName ?? current.expression)
      if (name === undefined || (!typeNames.has(name)
        && (sourceTypeNames.has(name) || !GLOBAL_TYPE_NAMES.has(name)))) {
        replacements.push({ start: current.start, end: current.end, text: 'unknown' })
        return
      }
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === 'loc' || key === 'start' || key === 'end'
        || key === 'typeParameters' || key === 'typeName' || key === 'expression') continue
      if (Array.isArray(value)) value.forEach(item => visit(item, typeNames))
      else visit(value, typeNames)
    }
    if (current.typeParameters !== undefined) visit(current.typeParameters, typeNames)
  }
  visit(node, outerTypeNames)
  let text = sourceSlice(source, node) || 'unknown'
  const start = node.start ?? 0
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    text = text.slice(0, replacement.start - start)
      + replacement.text
      + text.slice(replacement.end - start)
  }
  return text
}

function typeParameters(source, node, outerTypeNames = new Set(), sourceTypeNames = new Set()) {
  const declaration = node?.typeParameters
  if (declaration?.type !== 'TSTypeParameterDeclaration') {
    return { text: '', names: outerTypeNames }
  }
  const names = new Set([...outerTypeNames, ...typeParameterNames(declaration)])
  return { text: projectedType(source, declaration, names, sourceTypeNames), names }
}

function annotation(source, node, typeNames = new Set(), sourceTypeNames = new Set()) {
  const type = node?.typeAnnotation?.typeAnnotation
  return type === undefined ? 'unknown' : projectedType(source, type, typeNames, sourceTypeNames)
}

function parameter(source, node, index, typeNames = new Set(), sourceTypeNames = new Set()) {
  if (node?.type === 'TSParameterProperty') {
    return parameter(source, node.parameter, index, typeNames, sourceTypeNames)
  }
  if (node?.type === 'RestElement') {
    const argument = node.argument
    return argument?.type === 'Identifier'
      ? `...${argument.name}: ${node.typeAnnotation === undefined ? 'unknown[]' : annotation(source, node, typeNames, sourceTypeNames)}`
      : `...args${index}: unknown[]`
  }
  const optional = node?.type === 'AssignmentPattern'
  const target = optional ? node.left : node
  if (target?.type !== 'Identifier') return `arg${index}: unknown`
  return `${target.name}${optional || target.optional === true ? '?' : ''}: ${annotation(source, target, typeNames, sourceTypeNames)}`
}

function returnType(source, node, typeNames = new Set(), sourceTypeNames = new Set()) {
  const explicit = node?.returnType?.typeAnnotation
  if (explicit !== undefined) return projectedType(source, explicit, typeNames, sourceTypeNames)
  return node?.async === true ? 'Promise<unknown>' : 'unknown'
}

function functionType(source, node, outerTypeNames = new Set(), sourceTypeNames = new Set()) {
  const generics = typeParameters(source, node, outerTypeNames, sourceTypeNames)
  const parameters = (node.params ?? [])
    .map((item, index) => parameter(source, item, index, generics.names, sourceTypeNames)).join(', ')
  return `${generics.text}(${parameters}) => ${returnType(source, node, generics.names, sourceTypeNames)}`
}

function inferredType(source, node, depth = 0, sourceTypeNames = new Set()) {
  if (depth > 2 || node === null || node === undefined) return 'unknown'
  if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') return 'string'
  if (node.type === 'NumericLiteral') return 'number'
  if (node.type === 'BooleanLiteral') return 'boolean'
  if (node.type === 'BigIntLiteral') return 'bigint'
  if (node.type === 'NullLiteral') return 'null'
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    return functionType(source, node, new Set(), sourceTypeNames)
  }
  if (node.type === 'ArrayExpression') return 'unknown[]'
  if (node.type === 'ObjectExpression') {
    const members = []
    for (const property of node.properties) {
      if (property.type !== 'ObjectProperty' || property.computed || property.method) return 'Record<string, unknown>'
      const name = property.key.type === 'Identifier'
        ? property.key.name
        : property.key.type === 'StringLiteral' ? JSON.stringify(property.key.value) : undefined
      if (name === undefined) return 'Record<string, unknown>'
      members.push(`${name}: ${inferredType(source, property.value, depth + 1, sourceTypeNames)}`)
    }
    return `{ ${members.join('; ')} }`
  }
  return 'unknown'
}

function classMembers(source, node, classTypeNames, sourceTypeNames) {
  const members = []
  let constructorParameters = '...args: unknown[]'
  for (const member of node.body?.body ?? []) {
    if (member.type !== 'ClassMethod' || member.static || member.computed
      || member.accessibility === 'private' || member.key?.type === 'PrivateName') continue
    const name = member.key?.type === 'Identifier'
      ? member.key.name
      : member.key?.type === 'StringLiteral' ? JSON.stringify(member.key.value) : undefined
    if (name === undefined) continue
    const generics = typeParameters(source, member, classTypeNames, sourceTypeNames)
    const parameters = (member.params ?? [])
      .map((item, index) => parameter(source, item, index, generics.names, sourceTypeNames)).join(', ')
    if (member.kind === 'constructor') constructorParameters = parameters
    else if (member.kind === 'method') {
      members.push(`${name}${generics.text}(${parameters}): ${returnType(source, member, generics.names, sourceTypeNames)}`)
    }
  }
  return { constructorParameters, members, instance: `{ ${members.join('; ')} }` }
}

function jsdocPurpose(...nodes) {
  const comment = nodes.flatMap(node => node?.leadingComments ?? [])
    .find(item => item.type === 'CommentBlock' && item.value.startsWith('*'))
  if (comment === undefined) return ''
  return comment.value.slice(1).split(/\r?\n/)
    .map(line => line.replace(/^\s*\*?\s?/, '').trim())
    .find(line => line !== '' && !line.startsWith('@')) ?? ''
}

function symbolDescriptor(source, name, node, exportNode = node, sourceTypeNames = new Set()) {
  if (node?.type === 'FunctionDeclaration') {
    const generics = typeParameters(source, node, new Set(), sourceTypeNames)
    const parameters = (node.params ?? [])
      .map((item, index) => parameter(source, item, index, generics.names, sourceTypeNames)).join(', ')
    return {
      name,
      kind: 'function',
      purpose: jsdocPurpose(exportNode, node),
      declaration: `function ${name}${generics.text}(${parameters}): ${returnType(source, node, generics.names, sourceTypeNames)}`,
      member: `${name}${generics.text}(${parameters}): ${returnType(source, node, generics.names, sourceTypeNames)}`,
    }
  }
  if (node?.type === 'ClassDeclaration') {
    const generics = typeParameters(source, node, new Set(), sourceTypeNames)
    const shape = classMembers(source, node, generics.names, sourceTypeNames)
    return {
      name,
      kind: 'class',
      purpose: jsdocPurpose(exportNode, node),
      declaration: `class ${name}${generics.text} { constructor(${shape.constructorParameters});${shape.members.length === 0 ? '' : ` ${shape.members.join('; ')};`} }`,
      member: `${name}: { new${generics.text}(${shape.constructorParameters}): ${shape.instance} }`,
    }
  }
  const declarator = node?.type === 'VariableDeclarator' ? node : undefined
  const type = declarator?.id?.type !== 'Identifier'
    ? 'unknown'
    : declarator.id.typeAnnotation !== undefined
      ? annotation(source, declarator.id, new Set(), sourceTypeNames)
      : inferredType(source, declarator.init, 0, sourceTypeNames)
  return {
    name,
    kind: 'variable',
    purpose: jsdocPurpose(exportNode, node),
    declaration: `const ${name}: ${type}`,
    member: `${name}: ${type}`,
  }
}

function exportedSymbols(source) {
  let ast
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'topLevelAwait', 'importAttributes'],
      errorRecovery: false,
    })
  } catch (error) {
    throw new SyntaxError(`binding source could not be parsed: ${error.message}`)
  }
  const sourceTypeNames = new Set()
  const locals = new Map()
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) sourceTypeNames.add(specifier.local.name)
    }
    if (declaration?.type === 'TSTypeAliasDeclaration'
      || declaration?.type === 'TSInterfaceDeclaration'
      || declaration?.type === 'TSEnumDeclaration'
      || declaration?.type === 'TSModuleDeclaration'
      || declaration?.type === 'ClassDeclaration') {
      if (declaration.id?.type === 'Identifier') sourceTypeNames.add(declaration.id.name)
    }
    if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
      if (declaration.id !== null) locals.set(declaration.id.name, declaration)
    } else if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        for (const name of bindingNames(item.id)) locals.set(name, item)
      }
    }
  }
  const exports = new Map()
  for (const statement of ast.program.body) {
    if (statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration') {
      throw new TypeError('binding source supports named exports only')
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue
    if (statement.source !== null && statement.source !== undefined) {
      throw new TypeError('binding source cannot re-export from another module')
    }
    const declaration = statement.declaration
    if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
      if (declaration.id === null) throw new TypeError('binding source exports must be named')
      exports.set(declaration.id.name, symbolDescriptor(
        source, declaration.id.name, declaration, statement, sourceTypeNames,
      ))
      continue
    }
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        for (const name of bindingNames(item.id)) {
          exports.set(name, symbolDescriptor(source, name, item, statement, sourceTypeNames))
        }
      }
      continue
    }
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === 'type' || specifier.type !== 'ExportSpecifier') continue
      const exported = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
      const local = specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value
      identifier(exported, 'exported binding name')
      const target = locals.get(local)
      if (target === undefined) throw new TypeError(`export ${JSON.stringify(exported)} has no local value declaration`)
      exports.set(exported, symbolDescriptor(source, exported, target, target, sourceTypeNames))
    }
  }
  if (exports.size === 0) throw new TypeError('binding source must contain at least one named value export')
  return exports
}

function normalizePurpose(value) {
  if (typeof value !== 'string') throw new TypeError('binding purpose must be a string')
  const purpose = value.replace(/\s+/g, ' ').trim()
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new TypeError(`binding purpose must not exceed ${MAX_PURPOSE_LENGTH} characters`)
  }
  return purpose
}

function entryFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function selectedDescriptors(source, symbols) {
  const exported = exportedSymbols(source)
  const selected = symbols === undefined || symbols.length === 0 ? [...exported.keys()] : symbols
  const unique = new Set()
  return selected.map((name) => {
    identifier(name, 'binding symbol')
    if (unique.has(name)) throw new TypeError(`binding symbol ${JSON.stringify(name)} is duplicated`)
    unique.add(name)
    const descriptor = exported.get(name)
    if (descriptor === undefined) throw new TypeError(`binding symbol ${JSON.stringify(name)} is not a named value export`)
    return descriptor
  })
}

function sourceDurability(source) {
  const javascript = stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false })
  const prepared = prepareProgram(
    javascript,
    new Set(),
    { variableRedeclarations: true, functionClassRedeclarations: true },
    new Set(),
    { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
  )
  return {
    durability: prepared.durability,
    ...(prepared.reason === '' ? {} : { volatileReason: prepared.reason }),
  }
}

function declarationFor(entry, descriptors) {
  const comment = entry.purpose === '' ? '' : `/** ${entry.purpose.replaceAll('*/', '* /')} */\n`
  if (entry.scope === 'namespace') {
    return `${comment}declare const ${entry.name}: {\n${descriptors.map(item => `  ${item.member};`).join('\n')}\n}`
  }
  return descriptors.map((item, index) => `${index === 0 ? comment : ''}declare ${item.declaration}`).join('\n')
}

export function normalizeUserBindingEntry(value) {
  if (!isRecord(value)) throw new TypeError('binding entry must be an object')
  const permitted = new Set([...ENTRY_FIELDS].filter(field => field !== 'symbols'))
  if (Object.hasOwn(value, 'symbols')) permitted.add('symbols')
  assertOwnFields(value, permitted, 'binding entry')
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)) {
    throw new TypeError(`binding id must match [A-Za-z0-9][A-Za-z0-9._-]{0,${USER_BINDING_ID_MAX_LENGTH - 1}}`)
  }
  const scope = value.scope ?? 'namespace'
  if (!SCOPES.has(scope)) throw new TypeError('binding scope must be namespace or top-level')
  const name = scope === 'namespace'
    ? identifier(value.name, 'binding name')
    : displayName(value.name)
  if (typeof value.source !== 'string' || value.source.length === 0 || value.source.length > MAX_SOURCE_LENGTH) {
    throw new TypeError(`binding source must contain 1-${MAX_SOURCE_LENGTH} characters`)
  }
  if (typeof value.enabled !== 'boolean') throw new TypeError('binding enabled must be a boolean')
  const purpose = normalizePurpose(value.purpose ?? '')
  if (value.symbols !== undefined && !Array.isArray(value.symbols)) {
    throw new TypeError('binding symbols must be an array')
  }
  const descriptors = selectedDescriptors(value.source, value.symbols)
  if (scope === 'namespace') identifier(name, 'binding name', true)
  else descriptors.forEach(item => identifier(item.name, 'binding symbol', true))
  const durability = sourceDurability(value.source)
  const symbols = descriptors.map(item => item.name)
  const modelContext = normalizeBindingModelContext(value.modelContext)
  const stored = Object.freeze({
    id: value.id,
    name,
    scope,
    symbols: Object.freeze(symbols),
    purpose,
    enabled: value.enabled,
    source: value.source,
    ...(modelContext === undefined ? {} : { modelContext }),
  })
  const effectivePurpose = purpose || normalizePurpose(
    descriptors.map(item => item.purpose).find(candidate => candidate !== '') ?? '',
  )
  const declarationEntry = effectivePurpose === purpose
    ? stored
    : { ...stored, purpose: effectivePurpose }
  const bindings = scope === 'namespace'
    ? [Object.freeze({ name, kind: 'variable', declaration: declarationFor(declarationEntry, descriptors) })]
    : descriptors.map(item => Object.freeze({
        name: item.name,
        kind: item.kind,
        declaration: declarationFor({
          ...stored,
          purpose: item === descriptors[0] ? effectivePurpose : '',
        }, [item]),
      }))
  return Object.freeze({
    ...stored,
    fingerprint: entryFingerprint(stored),
    declaration: declarationFor(declarationEntry, descriptors),
    bindings: Object.freeze(bindings),
    ...durability,
  })
}

function validateConflicts(entries) {
  const ids = new Set()
  const activeNames = new Map()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new TypeError(`binding id ${JSON.stringify(entry.id)} is duplicated`)
    ids.add(entry.id)
    if (!entry.enabled) continue
    const names = entry.scope === 'namespace' ? [entry.name] : entry.symbols
    for (const name of names) {
      const existing = activeNames.get(name)
      if (existing !== undefined) {
        throw new TypeError(`active binding ${JSON.stringify(name)} conflicts between entries ${JSON.stringify(existing)} and ${JSON.stringify(entry.id)}`)
      }
      activeNames.set(name, entry.id)
    }
  }
}

function validateAggregateBudgets(entries, includeDeclarations) {
  const sourceLength = entries.reduce((total, entry) => total + entry.source.length, 0)
  if (sourceLength > MAX_SOURCE_TOTAL_LENGTH) {
    throw new TypeError(`binding sources exceed the ${MAX_SOURCE_TOTAL_LENGTH} character document limit`)
  }
  if (!includeDeclarations) return
  const declarationLength = entries.reduce((total, entry) => total + entry.declaration.length, 0)
    + Math.max(0, entries.length - 1) * 2
  if (declarationLength > MAX_DECLARATION_TOTAL_LENGTH) {
    throw new TypeError(`binding declarations exceed the ${MAX_DECLARATION_TOTAL_LENGTH} character model-context limit`)
  }
  const modelLength = entries.reduce((total, entry) => {
    const { includeDeclaration, instructions } = bindingModelPreferences(entry.modelContext)
    return total + (includeDeclaration ? entry.declaration.length : 0) + instructions.length
  }, 0)
  if (modelLength > MAX_DECLARATION_TOTAL_LENGTH) {
    throw new TypeError(`binding model context exceeds the ${MAX_DECLARATION_TOTAL_LENGTH} character model-context limit`)
  }
}

export function normalizeUserBindingsDocument(value) {
  if (!isRecord(value)) throw new TypeError('bindings document must be an object')
  assertOwnFields(value, DOCUMENT_FIELDS, 'bindings document')
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new TypeError(`bindings document must contain at most ${MAX_ENTRIES} entries`)
  }
  const entries = value.entries.map(normalizeUserBindingEntry)
  validateAggregateBudgets(entries, false)
  validateConflicts(entries)
  return Object.freeze({ entries: Object.freeze(entries) })
}

function snapshotFingerprint(revision, entries) {
  return entryFingerprint({ revision, entries: entries.map(entry => entry.fingerprint) })
}

export function createUserBindingsSnapshot(document, revision = 0) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('binding revision must be a non-negative safe integer')
  const normalized = normalizeUserBindingsDocument(document)
  const entries = normalized.entries.filter(entry => entry.enabled)
  validateAggregateBudgets(entries, true)
  return Object.freeze({
    version: USER_BINDINGS_SNAPSHOT_VERSION,
    revision,
    fingerprint: snapshotFingerprint(revision, entries),
    entries: Object.freeze(entries),
  })
}

export function normalizeUserBindingsSnapshot(value) {
  if (!isRecord(value)) throw new TypeError('user binding snapshot must be an object')
  assertOwnFields(value, SNAPSHOT_FIELDS, 'user binding snapshot')
  if (value.version !== USER_BINDINGS_SNAPSHOT_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new TypeError('invalid user binding snapshot')
  }
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry)) throw new TypeError('invalid user binding snapshot entry')
    assertOwnFields(entry, SNAPSHOT_ENTRY_FIELDS, 'user binding snapshot entry')
    const normalized = normalizeUserBindingEntry(Object.fromEntries(
      [...ENTRY_FIELDS].filter(field => Object.hasOwn(entry, field)).map(field => [field, entry[field]]),
    ))
    if (entry.fingerprint !== normalized.fingerprint || entry.declaration !== normalized.declaration
      || entry.durability !== normalized.durability
      || entry.volatileReason !== normalized.volatileReason
      || !Array.isArray(entry.bindings) || entry.bindings.length !== normalized.bindings.length) {
      throw new TypeError('user binding snapshot entry does not match its source')
    }
    entry.bindings.forEach((binding, index) => {
      assertOwnFields(binding, BINDING_FIELDS, 'user binding snapshot binding')
      const expected = normalized.bindings[index]
      if (!KINDS.has(binding.kind) || binding.name !== expected.name
        || binding.kind !== expected.kind || binding.declaration !== expected.declaration) {
        throw new TypeError('user binding snapshot binding does not match its source')
      }
    })
    if (!normalized.enabled) throw new TypeError('user binding snapshot cannot contain a disabled entry')
    return normalized
  })
  validateAggregateBudgets(entries, true)
  validateConflicts(entries)
  if (value.fingerprint !== snapshotFingerprint(value.revision, entries)) {
    throw new TypeError('user binding snapshot fingerprint does not match its entries')
  }
  return Object.freeze({
    version: USER_BINDINGS_SNAPSHOT_VERSION,
    revision: value.revision,
    fingerprint: value.fingerprint,
    entries: Object.freeze(entries),
  })
}

export function userBindingsDeclaration(snapshot) {
  const normalized = normalizeUserBindingsSnapshot(snapshot)
  return normalized.entries.map(entry => entry.declaration).join('\n\n')
}

export function userBindingsContext(snapshot) {
  const normalized = normalizeUserBindingsSnapshot(snapshot)
  const entries = normalized.entries.filter(entry => bindingModelPreferences(entry.modelContext).includeDeclaration)
  if (entries.length === 0) return undefined
  const calls = entries.map(entry => entry.scope === 'namespace'
    ? `${entry.name} (${entry.symbols.join(', ')})`
    : entry.symbols.join(', '))
  const declaration = entries.map(entry => entry.declaration).join('\n\n')
  return {
    name: 'tools:ptc-plus-user-bindings',
    text: `The following saved, enabled user-global REPL bindings have successfully activated for this request: ${calls.join('; ')}. Disabled in-memory drafts cannot activate. These are ordinary writable REPL values: reuse them directly, and keep any redeclaration session-local. This proves the matching saved snapshot and current activation, not that disk cannot change afterward. For availability, use this declaration or a side-effect-free observation of the known name; do not run write/delete tests. repl.state is a function managing named checkpoints, not a binding inventory.\n\n\`\`\`ts\n${declaration}\n\`\`\``,
  }
}

export function userBindingsPromptSection(snapshot) {
  const entries = normalizeUserBindingsSnapshot(snapshot).entries
    .filter(entry => {
      const { includeDeclaration, instructions } = bindingModelPreferences(entry.modelContext)
      return includeDeclaration || instructions !== ''
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  if (entries.length === 0) return undefined
  const content = entries.map(entry => {
    const { includeDeclaration, instructions } = bindingModelPreferences(entry.modelContext)
    return [
      `Binding: ${entry.name}`,
      instructions,
      includeDeclaration ? `\`\`\`ts\n${entry.declaration}\n\`\`\`` : '',
    ].filter(Boolean).join('\n\n')
  }).join('\n\n')
  return {
    name: 'tools:ptc-plus-user-binding-defaults',
    text: `Configured Global User Bindings for this request. Use these ordinary REPL values directly inside run_code when relevant. The saved modules initialize before cell execution; this configuration does not prove successful activation. Initialization can fail, and a session-local redeclaration can shadow a default. Follow current execution diagnostics and any active-binding context. These helpers are not native tools and do not change DSH authority. Each binding's prompt is provided by the user; any included interface is derived from its source. This configuration applies to the current request, including bindings saved or enabled during this session.\n\n${content}`,
  }
}

export function userBindingCatalogEntries(snapshot) {
  const normalized = normalizeUserBindingsSnapshot(snapshot)
  return normalized.entries.flatMap(entry => entry.bindings.map(binding => ({
    name: binding.name,
    kind: binding.kind,
    entryId: entry.id,
    fingerprint: entry.fingerprint,
    definition: Object.freeze({ source: binding.declaration, line: 1, column: 1 }),
  })))
}

export function selectUserBindingsSnapshot(snapshot, entryIds) {
  const normalized = normalizeUserBindingsSnapshot(snapshot)
  const ids = entryIds instanceof Set ? entryIds : new Set(entryIds)
  const document = {
    entries: normalized.entries.filter(entry => ids.has(entry.id)).map(entry => ({
      id: entry.id,
      name: entry.name,
      scope: entry.scope,
      symbols: [...entry.symbols],
      purpose: entry.purpose,
      enabled: entry.enabled,
      source: entry.source,
      ...(entry.modelContext === undefined ? {} : { modelContext: entry.modelContext }),
    })),
  }
  return createUserBindingsSnapshot(document, normalized.revision)
}

export function storedUserBindingsDocument(document) {
  const projected = isRecord(document) && Array.isArray(document.entries)
    ? {
        entries: document.entries.map(entry => isRecord(entry)
          ? Object.fromEntries([...ENTRY_FIELDS]
              .filter(field => Object.hasOwn(entry, field))
              .map(field => [field, entry[field]]))
          : entry),
      }
    : document
  const normalized = normalizeUserBindingsDocument(projected)
  return {
    entries: normalized.entries.map(entry => ({
      id: entry.id,
      name: entry.name,
      scope: entry.scope,
      symbols: [...entry.symbols],
      purpose: entry.purpose,
      enabled: entry.enabled,
      source: entry.source,
      ...(entry.modelContext === undefined ? {} : { modelContext: entry.modelContext }),
    })),
  }
}

/** Merge the exact request snapshot into private tool-result metadata. */
export function withUserBindingsSnapshot(meta, snapshot) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: meta }
  base[USER_BINDINGS_META_KEY] = normalizeUserBindingsSnapshot(snapshot)
  return base
}

/** Read one validated snapshot from private result metadata. */
export function userBindingsSnapshotFromMeta(meta) {
  if (!isRecord(meta) || !Object.hasOwn(meta, USER_BINDINGS_META_KEY)) return undefined
  return normalizeUserBindingsSnapshot(meta[USER_BINDINGS_META_KEY])
}

/** Compare snapshots without trusting caller-owned object identity. */
export function userBindingsSnapshotsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right
  try {
    return JSON.stringify(normalizeUserBindingsSnapshot(left))
      === JSON.stringify(normalizeUserBindingsSnapshot(right))
  } catch {
    return false
  }
}
