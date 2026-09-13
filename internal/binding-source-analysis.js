import { parse } from '@babel/parser'
import { AMBIENT_GLOBALS, renderDurabilityReasons } from './module-policy.js'
import { CELL_PARSER_PLUGINS, normalizeTypeScriptValues } from './repl-scope-normalizer.js'
import { identitySourceMap } from './source-position-map.js'
import { LEGACY_USER_BINDING_TRANSFORM, transformTypeScriptSource } from './typescript-transform.js'
import { compileStatefulModule } from './module-compilation.js'
import { prepareProgram, classifyDurability } from './cell-analysis.js'
import { createCompilerSourceCache } from './compiler-source-cache.js'

const MAX_NAME_LENGTH = 128
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

export function identifier(value, subject, reserved = false) {
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

export const exportedSymbols = createCompilerSourceCache(analyzeExportedSymbols)

function analyzeExportedSymbols(source, transform) {
  let ast
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: transform === LEGACY_USER_BINDING_TRANSFORM
        ? ['typescript', 'topLevelAwait', 'importAttributes'] : CELL_PARSER_PLUGINS,
      errorRecovery: transform !== LEGACY_USER_BINDING_TRANSFORM,
    })
  } catch (error) {
    throw new SyntaxError(`binding source could not be parsed: ${error.message}`)
  }
  const sourceTypeNames = new Set()
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
  }
  if (transform !== LEGACY_USER_BINDING_TRANSFORM) {
    source = normalizeTypeScriptValues(source, identitySourceMap(source.length), 'module').code
    ast = parse(source, { sourceType: 'module', plugins: CELL_PARSER_PLUGINS, errorRecovery: true })
  }
  const locals = new Map()
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
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

export const sourceDurability = createCompilerSourceCache(analyzeSourceDurability)

function analyzeSourceDurability(source, transform) {
  const compiled = compileStatefulModule(source, { transform })
  // Keep source imports visible to durability analysis after runtime adaptation.
  const javascript = transformTypeScriptSource(compiled.classificationCode,
    transform === LEGACY_USER_BINDING_TRANSFORM ? {} : { module: true, transform: { tsEnumIsMutable: true } }).code
  const prepared = transform !== LEGACY_USER_BINDING_TRANSFORM
    ? classifyDurability(javascript, new Set(), { sourceType: 'module',
      internalModules: new Set([new URL('./stateful-module-runtime.js', import.meta.url).href]) })
    : prepareProgram(javascript, {
    languageSemantics: 'legacy-v1',
    knownBindings: new Set(),
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
    reservedBindings: new Set(),
    rewritesEnabled: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
  })
  const reason = prepared.reason ?? renderDurabilityReasons(prepared.reasons)
  return {
    durability: prepared.durability,
    ...(reason === '' ? {} : { volatileReason: reason }),
  }
}
