import { bindingNodes, createGeneratedNameAllocator } from './binding-pattern.js'
import {
  CLASS_REDECLARATION_REWRITE,
  FUNCTION_REDECLARATION_REWRITE,
  MIXED_REDECLARATION_REWRITE,
  redeclarationCommitTarget,
} from './repl-rewrite-contract.js'
import { applySourceEdits, createMappedTextBuilder, identitySourceMap } from './source-position-map.js'
import { SKIP_AST_CHILDREN, walkAst } from './ast-traversal.js'

/**
 * Optional compatibility policy for a persistent REPL. The cell language does
 * not own this policy: callers may replace it when persistence uses separate
 * lexical frames instead of one shared REPL environment.
 */

function containsTopLevelAwait(node) {
  let found = false
  walkAst(node, current => {
    if (current.type === 'AwaitExpression') found = true
    if (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression'
      || current.type === 'ArrowFunctionExpression') return SKIP_AST_CHILDREN
  })
  return found
}

function mixedDeclaratorText(statement, declarator, bindings, code, offset, allocateName) {
  const fresh = bindings.filter(binding => !binding.existing)
  const existing = bindings.filter(binding => binding.existing)
  const valueName = allocateName('mixed_value')
  const commitName = allocateName('mixed_commit')
  const valuesName = allocateName('mixed_values')
  const positions = new Map(bindings.map((binding, index) => [binding.name, index]))
  const asynchronous = containsTopLevelAwait(declarator.id)
  const builder = createMappedTextBuilder(code, offset)
  const appendBindingName = binding => builder.appendMapped(binding.name, binding.start, binding.end)
  builder.append(statement.kind === 'var' ? 'var [' : 'let [')
  fresh.forEach((binding, index) => {
    if (index > 0) builder.append(', ')
    appendBindingName(binding)
  })
  builder.append(`] = ${asynchronous ? 'await ' : ''}(`)
  builder.append(`(${asynchronous ? 'async ' : ''}(${valueName}, ${commitName}) => { ${statement.kind} `)
  builder.appendSource(declarator.id.start, declarator.id.end)
  builder.append(` = ${valueName}; return ${commitName}([`)
  bindings.forEach((binding, index) => {
    if (index > 0) builder.append(', ')
    appendBindingName(binding)
  })
  builder.append(`]); })((`)
  if (declarator.init === null) builder.append('undefined')
  else builder.appendSource(declarator.init.start, declarator.init.end)
  builder.append(`), (${valuesName}) => { `)
  existing.forEach((binding, index) => {
    if (index > 0) builder.append(' ')
    appendBindingName(binding)
    builder.append(` = ${valuesName}[${positions.get(binding.name)}];`)
  })
  builder.append(' return [')
  fresh.forEach((binding, index) => {
    if (index > 0) builder.append(', ')
    builder.append(valuesName)
    builder.append(`[${positions.get(binding.name)}]`)
  })
  builder.append(']; }) );')
  return builder.result()
}

function existingDeclaratorText(declarator, code, offset) {
  const builder = createMappedTextBuilder(code, offset)
  builder.append(';(')
  builder.appendSource(declarator.id.start, declarator.id.end)
  builder.append(' = ')
  if (declarator.init === null) builder.append('undefined')
  else builder.appendSource(declarator.init.start, declarator.init.end)
  builder.append(');')
  return builder.result()
}

function freshDeclaratorText(statement, declarator, code, offset) {
  const builder = createMappedTextBuilder(code, offset)
  builder.append(statement.kind === 'var' ? 'var ' : 'let ')
  builder.appendSource(declarator.start, declarator.end)
  builder.append(';')
  return builder.result()
}

function bindingEntries(pattern, declarationSpan) {
  return bindingNodes(pattern).map(node => ({
    name: node.name,
    start: node.start,
    end: node.end,
    span: declarationSpan(node),
  }))
}

function existingFunctionText(statement, code, offset) {
  const builder = createMappedTextBuilder(code, offset)
  builder.append(';(')
  builder.appendMapped(statement.id.name, statement.id.start, statement.id.end)
  builder.append(' = ')
  builder.appendSource(statement.start, statement.id.start)
  builder.appendSource(statement.id.end, statement.end)
  builder.append(');')
  return builder.result()
}

function existingClassText(statement, code, offset) {
  const builder = createMappedTextBuilder(code, offset)
  builder.append(';(')
  builder.appendMapped(statement.id.name, statement.id.start, statement.id.end)
  builder.append(' = ')
  builder.appendSource(statement.start, statement.end)
  builder.append(');')
  return builder.result()
}

export function rewriteReplRedeclarations({
  code,
  sourceMap = identitySourceMap(code.length),
  body,
  offset,
  knownBindings,
  variableRedeclarationBindings = knownBindings,
  writableBindings,
  declarations,
  declarationSpan,
  collisionFor,
  bindingPolicy,
  autoSplitRedeclarations,
  commitSignal,
}) {
  const redeclared = []
  const rewrites = []
  if (body === undefined) {
    return {
      executableCode: code,
      executableSourceMap: sourceMap,
      collisions: declarations.filter(declaration => knownBindings.has(declaration.name)).map(collisionFor),
      redeclared,
      rewrites,
    }
  }
  const replacements = []
  const rejected = []
  const allocateName = createGeneratedNameAllocator(body)
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') {
      if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
        && statement.id !== null && knownBindings.has(statement.id.name)) {
        const kind = statement.type === 'ClassDeclaration' ? 'class' : 'function'
        if (!writableBindings.has(statement.id.name)) {
          rejected.push({
            name: statement.id.name,
            kind,
            reason: 'binding-not-writable',
            span: declarationSpan(statement.id),
          })
        } else if (!bindingPolicy.functionClassRedeclarations) {
          rejected.push({
            name: statement.id.name,
            kind,
            reason: 'function-class-redeclarations-disabled',
            span: declarationSpan(statement.id),
          })
        } else {
          const commitDependency = redeclarationCommitTarget(statement.id.name, statement.start)
          const replacement = kind === 'class'
            ? existingClassText(statement, code, offset)
            : existingFunctionText(statement, code, offset)
          replacement.text += ` void 0; this[${JSON.stringify(commitSignal)}](${JSON.stringify(commitDependency)});`
          replacements.push({
            start: statement.start - offset,
            end: statement.end - offset,
            text: replacement.text,
            mappings: replacement.mappings,
          })
          redeclared.push(collisionFor({
            name: statement.id.name,
            kind,
            commitDependency,
            span: declarationSpan(statement.id),
          }))
          rewrites.push({
            kind: 'redeclaration',
            description: kind === 'class'
              ? CLASS_REDECLARATION_REWRITE
              : FUNCTION_REDECLARATION_REWRITE,
            source: statement.id.name,
          })
        }
      }
      continue
    }
    const entries = []
    let statementRejected = false
    for (const declarator of statement.declarations) {
      const bindings = bindingEntries(declarator.id, declarationSpan)
      const existing = bindings.filter(binding => variableRedeclarationBindings.has(binding.name))
      const immutable = existing.filter(binding => !writableBindings.has(binding.name))
      if (immutable.length > 0) {
        rejected.push(...immutable.map(binding => ({
          ...binding,
          reason: 'binding-not-writable',
        })))
        statementRejected = true
        continue
      }
      if (existing.length > 0 && !bindingPolicy.variableRedeclarations) {
        rejected.push(...existing.map(binding => ({
          ...binding,
          reason: 'variable-redeclarations-disabled',
        })))
        statementRejected = true
        continue
      }
      if (existing.length > 0 && existing.length < bindings.length) {
        if (autoSplitRedeclarations) entries.push({ declarator, bindings, existing })
        else {
          rejected.push(...existing)
          statementRejected = true
        }
        continue
      }
      entries.push({ declarator, bindings, existing })
    }
    if (statementRejected) continue
    if (!entries.some(entry => entry.existing.length > 0)) {
      if (statement.kind === 'const' && bindingPolicy.variableRedeclarations) {
        replacements.push({
          start: statement.start - offset,
          end: statement.start - offset + statement.kind.length,
          text: 'let',
        })
      }
      continue
    }
    let replacementText = ''
    const replacementMappings = []
    const appendPart = (part) => {
      if (replacementText.length > 0) replacementText += '\n'
      const partOffset = replacementText.length
      replacementText += part.text
      part.mappings.forEach(mapping => replacementMappings.push({
        ...mapping,
        generatedStart: mapping.generatedStart + partOffset,
        generatedEnd: mapping.generatedEnd + partOffset,
      }))
    }
    for (const { declarator, bindings, existing } of entries) {
      if (existing.length > 0 && existing.length < bindings.length) {
        appendPart(mixedDeclaratorText(
          statement,
          declarator,
          bindings.map(binding => ({ ...binding, existing: existing.includes(binding) })),
          code,
          offset,
          allocateName,
        ))
        redeclared.push(...existing.map(collisionFor))
        rewrites.push({
          kind: 'redeclaration',
          description: MIXED_REDECLARATION_REWRITE,
          source: existing.map(binding => binding.name).join(', '),
        })
      } else if (existing.length === bindings.length && bindings.length > 0) {
        redeclared.push(...existing.map(collisionFor))
        appendPart(existingDeclaratorText(declarator, code, offset))
      } else {
        appendPart(freshDeclaratorText(statement, declarator, code, offset))
      }
    }
    replacements.push({
      start: statement.start - offset,
      end: statement.end - offset,
      text: replacementText,
      mappings: replacementMappings,
    })
  }
  const collisions = rejected.map(collisionFor)
  let executableCode = code
  let executableSourceMap = sourceMap
  if (collisions.length === 0) {
    const applied = applySourceEdits(code, sourceMap, replacements)
    executableCode = applied.code
    executableSourceMap = applied.sourceMap
  }
  return { executableCode, executableSourceMap, collisions, redeclared, rewrites }
}
