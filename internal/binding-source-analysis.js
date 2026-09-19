import { parse } from '@babel/parser'
import { AMBIENT_GLOBALS, renderDurabilityReasons } from './module-policy.js'
import { CELL_PARSER_PLUGINS, normalizeTypeScriptValues } from './repl-scope-normalizer.js'
import { identitySourceMap } from './source-position-map.js'
import { LEGACY_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM, transformTypeScriptSource } from './typescript-transform.js'
import { compileStatefulModule } from './module-compilation.js'
import { prepareProgram, classifyDurability } from './cell-analysis.js'
import { createCompilerSourceCache } from './compiler-source-cache.js'
import { bindingTypeNamespaceToken } from './binding-declaration-contract.js'

const MAX_NAME_LENGTH = 128
const LEGACY_GLOBAL_TYPE_NAMES = new Set([
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

function typeReferenceRootNode(node) {
  let current = node
  while (current?.type === 'TSQualifiedName') current = current.left
  return current?.type === 'Identifier' ? current : undefined
}

function projectedType(source, node, outerTypeNames, typeContext, usedTypeNames) {
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
    if (!typeContext.modern && (current.type === 'TSImportType' || current.type === 'TSTypeQuery')) {
      replacements.push({ start: current.start, end: current.end, text: 'unknown' })
      return
    }
    if (current.type === 'TSTypeQuery') {
      const reference = current.exprName
      const name = typeReferenceRoot(reference)
      if (typeContext.modern && name !== undefined && !typeNames.has(name)) {
        if (typeContext.importedNames.has(name)) {
          throw new TypeError(`imported value ${JSON.stringify(name)} cannot be represented in the binding interface; use an explicit import(...) type query`)
        }
        if (typeContext.localValues.has(name)) {
          const declaration = typeContext.localDeclarations.get(name)
          if (declaration === undefined
            || !['ClassDeclaration', 'TSEnumDeclaration'].includes(declaration.type)
            || (reference.type !== 'Identifier' && declaration.type !== 'TSEnumDeclaration')) {
            throw new TypeError(`local value query ${JSON.stringify(name)} cannot be represented in the binding interface; use an explicit structural type`)
          }
          usedTypeNames.add(name)
          const root = typeReferenceRootNode(reference)
          replacements.push({ start: root.start, end: root.end,
            text: `${typeContext.typeNamespaceToken}.${name}` })
        }
      }
    } else if (current.type === 'TSTypeReference' || current.type === 'TSExpressionWithTypeArguments') {
      const reference = current.typeName ?? current.expression
      const name = typeReferenceRoot(reference)
      if (!typeContext.modern && (name === undefined || !typeNames.has(name)
        && (typeContext.sourceTypeNames.has(name) || !LEGACY_GLOBAL_TYPE_NAMES.has(name)))) {
        replacements.push({ start: current.start, end: current.end, text: 'unknown' })
        return
      }
      if (typeContext.modern && name !== undefined && !typeNames.has(name)) {
        if (typeContext.importedNames.has(name)) {
          throw new TypeError(`imported type ${JSON.stringify(name)} cannot be represented in the binding interface; use an explicit import(...) type or a local structural type`)
        }
        if (typeContext.localDeclarations.has(name)) {
          usedTypeNames.add(name)
          const root = typeReferenceRootNode(reference)
          replacements.push({ start: root.start, end: root.end,
            text: `${typeContext.typeNamespaceToken}.${name}` })
        }
      }
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === 'loc' || key === 'start' || key === 'end'
        || key === 'typeParameters' || key === 'typeName' || key === 'expression' || key === 'exprName') continue
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

function typeParameters(source, node, outerTypeNames, typeContext, usedTypeNames) {
  const declaration = node?.typeParameters
  if (declaration?.type !== 'TSTypeParameterDeclaration') {
    return { text: '', names: outerTypeNames }
  }
  const names = new Set([...outerTypeNames, ...typeParameterNames(declaration)])
  return { text: projectedType(source, declaration, names, typeContext, usedTypeNames), names }
}

function annotation(source, node, typeNames, typeContext, usedTypeNames) {
  const type = node?.typeAnnotation?.typeAnnotation
  return type === undefined ? 'unknown' : projectedType(source, type, typeNames, typeContext, usedTypeNames)
}

function parameter(source, node, index, typeNames, typeContext, usedTypeNames) {
  if (node?.type === 'TSParameterProperty') {
    return parameter(source, node.parameter, index, typeNames, typeContext, usedTypeNames)
  }
  if (node?.type === 'RestElement') {
    const argument = node.argument
    return argument?.type === 'Identifier'
      ? `...${argument.name}: ${node.typeAnnotation === undefined ? 'unknown[]' : annotation(source, node, typeNames, typeContext, usedTypeNames)}`
      : `...args${index}: unknown[]`
  }
  const optional = node?.type === 'AssignmentPattern'
  const target = optional ? node.left : node
  if (target?.type !== 'Identifier') return `arg${index}: unknown`
  return `${target.name}${optional || target.optional === true ? '?' : ''}: ${annotation(source, target, typeNames, typeContext, usedTypeNames)}`
}

function returnType(source, node, typeNames, typeContext, usedTypeNames) {
  const explicit = node?.returnType?.typeAnnotation
  if (explicit !== undefined) return projectedType(source, explicit, typeNames, typeContext, usedTypeNames)
  return node?.async === true ? 'Promise<unknown>' : 'unknown'
}

function functionType(source, node, outerTypeNames, typeContext, usedTypeNames) {
  const generics = typeParameters(source, node, outerTypeNames, typeContext, usedTypeNames)
  const parameters = (node.params ?? [])
    .map((item, index) => parameter(source, item, index, generics.names, typeContext, usedTypeNames)).join(', ')
  return `${generics.text}(${parameters}) => ${returnType(source, node, generics.names, typeContext, usedTypeNames)}`
}

function inferredType(source, node, depth, typeContext, usedTypeNames) {
  if (depth > 2 || node === null || node === undefined) return 'unknown'
  if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') return 'string'
  if (node.type === 'NumericLiteral') return 'number'
  if (node.type === 'BooleanLiteral') return 'boolean'
  if (node.type === 'BigIntLiteral') return 'bigint'
  if (node.type === 'NullLiteral') return 'null'
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    return functionType(source, node, new Set(), typeContext, usedTypeNames)
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
      members.push(`${name}: ${inferredType(source, property.value, depth + 1, typeContext, usedTypeNames)}`)
    }
    return `{ ${members.join('; ')} }`
  }
  return 'unknown'
}

function classMemberName(member) {
  return member.key?.type === 'Identifier'
    ? member.key.name
    : member.key?.type === 'StringLiteral' ? JSON.stringify(member.key.value) : undefined
}

function modernClassMemberName(member) {
  const key = classMemberKey(member)
  return classMemberName(member) ?? (key === undefined ? undefined : JSON.stringify(key))
}

function classMemberKey(member) {
  if (member.computed && !['StringLiteral', 'NumericLiteral', 'BigIntLiteral'].includes(member.key?.type)) {
    throw new TypeError('computed class member key cannot be represented in the binding interface; use a literal property key')
  }
  return member.key?.type === 'Identifier'
    ? member.key.name
    : member.key?.type === 'StringLiteral' ? member.key.value
      : member.key?.type === 'NumericLiteral' ? String(member.key.value)
        : member.key?.type === 'BigIntLiteral' ? String(BigInt(member.key.value)) : undefined
}

function isPublicClassMember(member) {
  return !member.static
    && member.accessibility !== 'private' && member.accessibility !== 'protected'
    && member.key?.type !== 'PrivateName'
}

function parameterPropertyMember(source, node, classTypeNames, typeContext, usedTypeNames) {
  if (node?.type !== 'TSParameterProperty' || node.accessibility === 'private' || node.accessibility === 'protected') return undefined
  const parameterNode = node.parameter
  const optional = parameterNode?.type === 'AssignmentPattern'
  const target = optional ? parameterNode.left : parameterNode
  if (target?.type !== 'Identifier') return undefined
  return `${node.readonly === true ? 'readonly ' : ''}${target.name}${optional || target.optional === true ? '?' : ''}: ${annotation(source, target, classTypeNames, typeContext, usedTypeNames)}`
}

function parameterPropertyName(node) {
  if (node?.type !== 'TSParameterProperty' || node.accessibility === 'private' || node.accessibility === 'protected') return undefined
  const parameter = node.parameter?.type === 'AssignmentPattern' ? node.parameter.left : node.parameter
  return parameter?.type === 'Identifier' ? parameter.name : undefined
}

function legacyClassMembers(source, node, classTypeNames, typeContext, usedTypeNames) {
  const members = []
  const memberNames = new Set()
  let constructorParameters = '...args: unknown[]'
  for (const member of node.body?.body ?? []) {
    if (!['ClassMethod', 'TSDeclareMethod'].includes(member.type)
      || member.static || member.computed || member.accessibility === 'private' || member.key?.type === 'PrivateName') continue
    const name = classMemberName(member)
    if (name === undefined) continue
    const generics = typeParameters(source, member, classTypeNames, typeContext, usedTypeNames)
    const parameters = (member.params ?? [])
      .map((item, index) => parameter(source, item, index, generics.names, typeContext, usedTypeNames)).join(', ')
    if (member.kind === 'constructor') {
      constructorParameters = parameters
    }
    else if (member.kind === 'get' || member.kind === 'set') {
      const signature = `${member.kind}:${name}`
      if (memberNames.has(signature)) continue
      members.push(member.kind === 'get'
        ? `get ${name}(): ${returnType(source, member, generics.names, typeContext, usedTypeNames)}`
        : `set ${name}(${parameters})`)
      memberNames.add(signature)
    }
    else if (member.kind === 'method') {
      members.push(`${name}${member.optional === true ? '?' : ''}${generics.text}(${parameters}): ${returnType(source, member, generics.names, typeContext, usedTypeNames)}`)
      memberNames.add(name)
    }
  }
  return { constructorParameters, members, instance: `{ ${members.join('; ')} }` }
}

function classMembers(source, node, classTypeNames, typeContext, usedTypeNames) {
  if (!typeContext.modern) return legacyClassMembers(source, node, classTypeNames, typeContext, usedTypeNames)
  const body = node.body?.body ?? []
  const fields = new Map()
  const parameterProperties = new Map()
  const prototypeMembers = new Map()
  let constructorNode
  for (const member of body) {
    if (['ClassProperty', 'TSAbstractPropertyDefinition'].includes(member.type)) {
      if (!isPublicClassMember(member)) continue
      const key = classMemberKey(member)
      if (key !== undefined) fields.set(key, member)
      continue
    }
    if (member.type === 'ClassAccessorProperty') {
      if (!isPublicClassMember(member)) continue
      const key = classMemberKey(member)
      if (key !== undefined) prototypeMembers.set(key, { kind: 'accessor', get: member, set: member })
      continue
    }
    if (!['ClassMethod', 'TSDeclareMethod'].includes(member.type) || !isPublicClassMember(member)) continue
    const key = classMemberKey(member)
    if (key === undefined) continue
    if (member.kind === 'constructor') {
      constructorNode = member
    } else if (member.kind === 'get' || member.kind === 'set') {
      const current = prototypeMembers.get(key)
      const descriptor = current?.kind === 'accessor' ? { ...current } : { kind: 'accessor' }
      descriptor[member.kind] = member
      prototypeMembers.set(key, descriptor)
    } else if (member.kind === 'method') {
      prototypeMembers.set(key, { kind: 'method', node: member })
    }
  }
  for (const parameter of constructorNode?.params ?? []) {
    const name = parameterPropertyName(parameter)
    if (name !== undefined) parameterProperties.set(name, parameter)
  }
  const ownMember = name => parameterProperties.get(name) ?? fields.get(name)
  const members = []
  let constructorParameters = '...args: unknown[]'
  for (const member of body) {
    if (['ClassProperty', 'TSAbstractPropertyDefinition'].includes(member.type)) {
      if (!isPublicClassMember(member)) continue
      const key = classMemberKey(member)
      if (key === undefined || ownMember(key) !== member) continue
      const name = modernClassMemberName(member)
      members.push(`${member.readonly === true ? 'readonly ' : ''}${name}${member.optional === true ? '?' : ''}: ${annotation(source, member, classTypeNames, typeContext, usedTypeNames)}`)
      continue
    }
    if (member.type === 'ClassAccessorProperty') {
      if (!isPublicClassMember(member)) continue
      const key = classMemberKey(member)
      const name = modernClassMemberName(member)
      const selected = key === undefined || ownMember(key) !== undefined ? undefined : prototypeMembers.get(key)
      if (selected?.kind !== 'accessor') continue
      if (selected.get === member && selected.set === member) {
        members.push(`${name}${member.optional === true ? '?' : ''}: ${annotation(source, member, classTypeNames, typeContext, usedTypeNames)}`)
      } else {
        const type = annotation(source, member, classTypeNames, typeContext, usedTypeNames)
        if (selected.get === member) members.push(`get ${name}(): ${type}`)
        if (selected.set === member) members.push(`set ${name}(value: ${type})`)
      }
      continue
    }
    if (!['ClassMethod', 'TSDeclareMethod'].includes(member.type) || !isPublicClassMember(member)) continue
    const key = classMemberKey(member)
    if (key === undefined) continue
    const name = modernClassMemberName(member)
    if (member.kind === 'constructor') {
      if (member !== constructorNode) continue
      const generics = typeParameters(source, member, classTypeNames, typeContext, usedTypeNames)
      const parameters = (member.params ?? [])
        .map((item, index) => parameter(source, item, index, generics.names, typeContext, usedTypeNames)).join(', ')
      constructorParameters = parameters
      for (const item of member.params ?? []) {
        const fieldName = parameterPropertyName(item)
        if (fieldName === undefined || ownMember(fieldName) !== item) continue
        members.push(parameterPropertyMember(source, item, classTypeNames, typeContext, usedTypeNames))
      }
      continue
    }
    if (ownMember(key) !== undefined) continue
    const selected = prototypeMembers.get(key)
    if (member.kind === 'get' || member.kind === 'set') {
      if (selected?.kind !== 'accessor' || selected[member.kind] !== member) continue
      const generics = typeParameters(source, member, classTypeNames, typeContext, usedTypeNames)
      const parameters = (member.params ?? [])
        .map((item, index) => parameter(source, item, index, generics.names, typeContext, usedTypeNames)).join(', ')
      members.push(member.kind === 'get'
        ? `get ${name}(): ${returnType(source, member, generics.names, typeContext, usedTypeNames)}`
        : `set ${name}(${parameters})`)
    } else if (member.kind === 'method' && selected?.kind === 'method' && selected.node === member) {
      const generics = typeParameters(source, member, classTypeNames, typeContext, usedTypeNames)
      const parameters = (member.params ?? [])
        .map((item, index) => parameter(source, item, index, generics.names, typeContext, usedTypeNames)).join(', ')
      members.push(`${name}${member.optional === true ? '?' : ''}${generics.text}(${parameters}): ${returnType(source, member, generics.names, typeContext, usedTypeNames)}`)
    }
  }
  return { constructorParameters, members, instance: `{ ${members.join('; ')} }` }
}

function valueReferenceRootNode(node) {
  let current = node
  while (current?.type === 'MemberExpression' && !current.computed) current = current.object
  return current?.type === 'Identifier' ? current : undefined
}

function classHeritage(source, node, classTypeNames, typeContext, usedTypeNames) {
  const base = node.superClass
  if (base === null || base === undefined) return { clause: '', instance: '' }
  const root = valueReferenceRootNode(base)
  if (root === undefined || !['Identifier', 'MemberExpression'].includes(base.type)) {
    throw new TypeError('class heritage cannot be represented in the binding interface; use a named class base')
  }
  if (typeContext.importedNames.has(root.name)) {
    throw new TypeError(`imported class ${JSON.stringify(root.name)} cannot be represented in the binding interface; use an explicit structural type`)
  }
  let reference = sourceSlice(source, base)
  if (base.type === 'Identifier' && typeContext.localDeclarations.has(root.name)) {
    const declaration = typeContext.localDeclarations.get(root.name)
    if (declaration.type !== 'ClassDeclaration') {
      throw new TypeError(`local class base ${JSON.stringify(root.name)} cannot be represented in the binding interface; use a class declaration`)
    }
    usedTypeNames.add(root.name)
    reference = `${typeContext.typeNamespaceToken}.${root.name}`
  } else if (typeContext.localValues.has(root.name)) {
    throw new TypeError(`local class base ${JSON.stringify(root.name)} cannot be represented in the binding interface; use a class declaration`)
  }
  const argumentsNode = node.superTypeParameters ?? node.superTypeArguments
  const typeArguments = argumentsNode === undefined ? ''
    : projectedType(source, argumentsNode, classTypeNames, typeContext, usedTypeNames)
  const instance = `${reference}${typeArguments}`
  return { clause: ` extends ${instance}`, instance }
}

function localTypeDeclaration(source, name, node, typeContext, usedTypeNames) {
  if (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration'
    || node.type === 'TSEnumDeclaration') {
    const ownTypeNames = new Set(typeParameterNames(node.typeParameters))
    const text = projectedType(source, node, ownTypeNames, typeContext, usedTypeNames)
      .replace(/^declare\s+/, '')
    return `export ${text}`
  }
  if (node.type === 'ClassDeclaration') {
    const generics = typeParameters(source, node, new Set(), typeContext, usedTypeNames)
    const heritage = classHeritage(source, node, generics.names, typeContext, usedTypeNames)
    const shape = classMembers(source, node, generics.names, typeContext, usedTypeNames)
    return `export ${node.abstract === true ? 'abstract ' : ''}class ${name}${generics.text}${heritage.clause} { constructor(${shape.constructorParameters});${shape.members.length === 0 ? '' : ` ${shape.members.join('; ')};`} }`
  }
  throw new TypeError(`local type ${JSON.stringify(name)} cannot be represented in the binding interface; use a local interface, type alias, enum, or class`)
}

function typeDependencyDeclarations(source, roots, typeContext) {
  if (!typeContext.modern) return []
  const pending = [...roots]
  const seen = new Set()
  const declarations = []
  while (pending.length > 0) {
    const name = pending.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const node = typeContext.localDeclarations.get(name)
    if (node === undefined) continue
    const dependencies = new Set()
    declarations.push(localTypeDeclaration(source, name, node, typeContext, dependencies))
    for (const dependency of dependencies) if (!seen.has(dependency)) pending.push(dependency)
  }
  return declarations
}

function jsdocPurpose(...nodes) {
  const comment = nodes.flatMap(node => node?.leadingComments ?? [])
    .find(item => item.type === 'CommentBlock' && item.value.startsWith('*'))
  if (comment === undefined) return ''
  return comment.value.slice(1).split(/\r?\n/)
    .map(line => line.replace(/^\s*\*?\s?/, '').trim())
    .find(line => line !== '' && !line.startsWith('@')) ?? ''
}

function symbolDescriptor(source, name, node, exportNode, typeContext) {
  const usedTypeNames = new Set()
  const complete = descriptor => ({
    ...descriptor,
    typeNamespaceToken: typeContext.typeNamespaceToken,
    typeDeclarations: typeDependencyDeclarations(source, usedTypeNames, typeContext),
  })
  if (node?.type === 'FunctionDeclaration') {
    const generics = typeParameters(source, node, new Set(), typeContext, usedTypeNames)
    const parameters = (node.params ?? [])
      .map((item, index) => parameter(source, item, index, generics.names, typeContext, usedTypeNames)).join(', ')
    return complete({
      name,
      kind: 'function',
      purpose: jsdocPurpose(exportNode, node),
      declaration: `function ${name}${generics.text}(${parameters}): ${returnType(source, node, generics.names, typeContext, usedTypeNames)}`,
      member: `${name}${generics.text}(${parameters}): ${returnType(source, node, generics.names, typeContext, usedTypeNames)}`,
    })
  }
  if (node?.type === 'ClassDeclaration') {
    const generics = typeParameters(source, node, new Set(), typeContext, usedTypeNames)
    const heritage = classHeritage(source, node, generics.names, typeContext, usedTypeNames)
    const shape = classMembers(source, node, generics.names, typeContext, usedTypeNames)
    const instance = heritage.instance === '' ? shape.instance : `${heritage.instance} & ${shape.instance}`
    return complete({
      name,
      kind: 'class',
      purpose: jsdocPurpose(exportNode, node),
      declaration: `${node.abstract === true ? 'abstract ' : ''}class ${name}${generics.text}${heritage.clause} { constructor(${shape.constructorParameters});${shape.members.length === 0 ? '' : ` ${shape.members.join('; ')};`} }`,
      member: node.abstract === true
        ? `${name}: abstract new${generics.text}(${shape.constructorParameters}) => ${instance}`
        : `${name}: { new${generics.text}(${shape.constructorParameters}): ${instance} }`,
    })
  }
  const declarator = node?.type === 'VariableDeclarator' ? node : undefined
  const type = declarator?.id?.type !== 'Identifier'
    ? 'unknown'
    : declarator.id.typeAnnotation !== undefined
      ? annotation(source, declarator.id, new Set(), typeContext, usedTypeNames)
      : inferredType(source, declarator.init, 0, typeContext, usedTypeNames)
  return complete({
    name,
    kind: 'variable',
    purpose: jsdocPurpose(exportNode, node),
    declaration: `const ${name}: ${type}`,
    member: `${name}: ${type}`,
  })
}

export const exportedSymbols = createCompilerSourceCache(analyzeExportedSymbols)

function analyzeExportedSymbols(source, transform) {
  const metadataSource = source
  let metadataAst
  try {
    metadataAst = parse(metadataSource, {
      sourceType: 'module',
      plugins: transform === LEGACY_USER_BINDING_TRANSFORM
        ? ['typescript', 'topLevelAwait', 'importAttributes'] : CELL_PARSER_PLUGINS,
      errorRecovery: transform !== LEGACY_USER_BINDING_TRANSFORM,
    })
  } catch (error) {
    throw new SyntaxError(`binding source could not be parsed: ${error.message}`)
  }
  const importedNames = new Set()
  const localDeclarations = new Map()
  const localValueNames = new Set()
  const metadataLocals = new Map()
  const metadataExportNodes = new Map()
  for (const statement of metadataAst.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) importedNames.add(specifier.local.name)
    }
    if (declaration?.type === 'TSTypeAliasDeclaration'
      || declaration?.type === 'TSInterfaceDeclaration'
      || declaration?.type === 'TSEnumDeclaration'
      || declaration?.type === 'TSModuleDeclaration'
      || declaration?.type === 'ClassDeclaration') {
      if (declaration.id?.type === 'Identifier') localDeclarations.set(declaration.id.name, declaration)
    }
    if (declaration?.type === 'TSEnumDeclaration' || declaration?.type === 'TSModuleDeclaration') {
      if (declaration.id?.type === 'Identifier') localValueNames.add(declaration.id.name)
    }
    if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
      if (declaration.id !== null) {
        localValueNames.add(declaration.id.name)
        metadataLocals.set(declaration.id.name, declaration)
        if (statement.type === 'ExportNamedDeclaration') metadataExportNodes.set(declaration.id.name, statement)
      }
    } else if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        for (const name of bindingNames(item.id)) {
          localValueNames.add(name)
          metadataLocals.set(name, item)
          if (statement.type === 'ExportNamedDeclaration') metadataExportNodes.set(name, statement)
        }
      }
    }
    if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ExportSpecifier' && specifier.local.type === 'Identifier') {
          metadataExportNodes.set(specifier.local.name, statement)
        }
      }
    }
  }
  const typeContext = {
    modern: transform === USER_BINDING_TRANSFORM,
    importedNames,
    localDeclarations,
    localValues: localValueNames,
    sourceTypeNames: new Set([...importedNames, ...localDeclarations.keys()]),
    typeNamespaceToken: bindingTypeNamespaceToken(metadataSource),
  }
  let ast = metadataAst
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
  const descriptor = (name, runtimeNode, exportNode, localName = name) => {
    const metadataNode = metadataLocals.get(localName)
    return metadataNode === undefined
      ? symbolDescriptor(source, name, runtimeNode, exportNode, typeContext)
      : symbolDescriptor(metadataSource, name, metadataNode,
        metadataExportNodes.get(localName) ?? metadataNode, typeContext)
  }
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
      exports.set(declaration.id.name, descriptor(declaration.id.name, declaration, statement))
      continue
    }
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        for (const name of bindingNames(item.id)) {
          exports.set(name, descriptor(name, item, statement))
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
      exports.set(exported, descriptor(exported, target, target, local))
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
