import { ModuleRewriteError } from './cell-rewriter.js'
import { declarationSpan, PreflightError } from './cell-analysis-contract.js'
export { declarationSpan, PreflightError } from './cell-analysis-contract.js'
import { parse } from 'acorn'
import { parse as parseSource } from '@babel/parser'
import { parseExecutableCell } from './cell-parser.js'
import { redeclarationCommitTarget } from './repl-rewrite-contract.js'
import {
  bindingNodes,
  createGeneratedNameAllocator,
  walkBindingPattern as walkPattern,
} from './binding-pattern.js'
import {
  AMBIENT_GLOBALS,
  DYNAMIC_MODULE_REASON,
  classifyModuleSource,
  renderDurabilityReason,
  renderDurabilityReasons,
} from './module-policy.js'
import { applySourceEdits, mapSourcePosition, mapSourceSpan } from './source-position-map.js'
import { SKIP_AST_CHILDREN, walkAst } from './ast-traversal.js'
import { compileStatefulRoot } from './stateful-root-compiler.js'
import { CELL_PARSER_PLUGINS, bindCompilerIntrinsics, lowerStatefulDecorators, lowerStatefulResources, lowerNativeLanguageSource, normalizeStatefulScopes } from './repl-scope-normalizer.js'
import { markCallableSources, collectCallableSources } from './callable-source-facts.js'
import { LegacyPreflightError, prepareLegacyProgram } from './legacy-cell-analysis.js'
import { adaptLegacyModuleImports } from './managed-module-operations.js'
import { adaptNativeRootDynamic } from './native-root-compilation.js'
import { sourceRegionData } from './compiler-region-output.js'

/**
 * Pure AST analysis for PTC cells: binding inventory, durability classification,
 * return rewriting, and program preparation. This module owns no worker, journal,
 * or session state so its behavior is fully testable in isolation.
 */


function addPatternBindings(pattern, names) {
  walkPattern(pattern, node => names.add(node.name))
}

function addPatternDeclarations(pattern, declarations, kind = 'variable', definitionSpan = undefined, writable = false) {
  bindingNodes(pattern).forEach(node => declarations.push({
    name: node.name,
    kind,
    span: declarationSpan(node),
    definitionSpan,
    writable,
  }))
}

function topLevelBindings(body) {
  return new Set(topLevelDeclarations(body).map(declaration => declaration.name))
}

function rootVarDeclarations(body, declarations, seen) {
  walkAst({ type: 'Program', body }, node => {
    if (node.type === 'VariableDeclaration' && node.kind === 'var' && !seen.has(node)) {
      seen.add(node)
      const definitionSpan = declarationSpan(node)
      for (const declaration of node.declarations) {
        addPatternDeclarations(declaration.id, declarations, 'variable', definitionSpan, true)
      }
    }
    if (isFunction(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression'
      || node.type === 'StaticBlock') return SKIP_AST_CHILDREN
  })
}

function topLevelDeclarations(body, variableRedeclarations = false) {
  const declarations = []
  const seen = new Set()
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration') {
      seen.add(statement)
      const definitionSpan = declarationSpan(statement)
      for (const declaration of statement.declarations) {
        addPatternDeclarations(
          declaration.id,
          declarations,
          'variable',
          definitionSpan,
          statement.kind !== 'const' || variableRedeclarations,
        )
      }
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      && statement.id !== null) {
      declarations.push({
        name: statement.id.name,
        kind: statement.type === 'ClassDeclaration' ? 'class' : 'function',
        span: declarationSpan(statement.id),
        definitionSpan: declarationSpan(statement),
        commitDependency: redeclarationCommitTarget(statement.id.name, statement.start),
        writable: true,
      })
    }
  }
  rootVarDeclarations(body, declarations, seen)
  return declarations
}

function directBlockBindings(body) {
  const names = new Set()
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declaration of statement.declarations) addPatternBindings(declaration.id, names)
    } else if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      && statement.id !== null) {
      names.add(statement.id.name)
    }
  }
  return names
}

function functionParameterBindings(node) {
  const names = new Set()
  if (node.id !== null && node.id !== undefined) names.add(node.id.name)
  /* c8 ignore next */
  for (const param of node.params ?? []) addPatternBindings(param, names)
  return names
}

function hasStrictDirective(body) {
  if (body.type !== 'BlockStatement') return false
  for (const statement of body.body) {
    if (statement.directive === undefined) break
    if (statement.directive === 'use strict') return true
  }
  return false
}

function addFunctionVariables(body, names, strict) {
  const addBlockFunction = (node, blocked) => {
    if (!strict && node.type === 'FunctionDeclaration' && !node.async && !node.generator
      && !blocked.has(node.id.name)) names.add(node.id.name)
  }
  walkAst(body, (current, parent, key, blocked) => {
    if (isFunction(current)) {
      addBlockFunction(current, blocked)
      return SKIP_AST_CHILDREN
    }
    if (current.type === 'StaticBlock') return SKIP_AST_CHILDREN
    if (current.type === 'VariableDeclaration' && current.kind === 'var') {
      for (const declaration of current.declarations) addPatternBindings(declaration.id, names)
    }
    const statements = current.type === 'BlockStatement' ? current.body
      : current.type === 'SwitchCase' ? parent.cases.flatMap(branch => branch.consequent) : undefined
    if (statements !== undefined) {
      // Annex B creates a function-scope var only when intervening lexical
      // declarations permit it. The declaration's own block binding is excluded.
      for (const statement of statements) addBlockFunction(statement, blocked)
      return new Set([...blocked, ...directBlockBindings(statements)])
    }
    if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(current.type)) {
      return new Set([...blocked, ...loopBindings(current)])
    }
    if (current.type === 'CatchClause' && current.param !== null && current.param.type !== 'Identifier') {
      // The Annex B catch exception admits var names through a simple parameter,
      // but a destructured catch binding still blocks function-scope promotion.
      const nested = new Set(blocked)
      addPatternBindings(current.param, nested)
      return nested
    }
  }, undefined, new Set())
}

function loopBindings(node) {
  const declaration = node.type === 'ForStatement' ? node.init : node.left
  if (declaration?.type !== 'VariableDeclaration' || declaration.kind === 'var') return new Set()
  const names = new Set()
  for (const entry of declaration.declarations) addPatternBindings(entry.id, names)
  return names
}

function isReferenceIdentifier(node, parent, key) {
  /* c8 ignore next */
  if (parent === undefined) return false
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression')
    && key === 'property' && !parent.computed) return false
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
    && key === 'key' && !parent.computed && !parent.shorthand) return false
  if (['VariableDeclarator', 'FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression']
    .includes(parent.type) && key === 'id') return false
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression')
    && key === 'params') return false
  if (parent.type === 'CatchClause' && key === 'param') return false
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return false
  return true
}

function isStableProcessMember(node, parent) {
  /* c8 ignore next */
  if (node.name !== 'process' || parent?.type !== 'MemberExpression' || parent.object !== node) return false
  const member = parent.computed
    ? parent.property?.type === 'Literal' ? parent.property.value : undefined
    /* c8 ignore next */
    : parent.property?.type === 'Identifier' ? parent.property.name : undefined
  return ['stdout', 'stderr', 'cwd'].includes(member)
}

function staticMemberName(node) {
  if (node?.type !== 'MemberExpression') return undefined
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name
  if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value
  }
  return undefined
}

function globalObjectMember(node) {
  return node?.type === 'MemberExpression'
    && node.object?.type === 'Identifier'
    && ['global', 'globalThis'].includes(node.object.name)
    ? staticMemberName(node)
    : undefined
}

function isFunction(node) {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
}


function staticModuleClassification(moduleLoads) {
  const reasons = new Map()
  for (const load of moduleLoads) {
    const classification = classifyModuleSource(load.source)
    if (classification.status === 'forbidden') {
      throw new PreflightError(
        `cell import of ${load.source} is forbidden because it exposes kernel control`,
        undefined,
        load.position,
      )
    }
    if (classification.reason !== undefined) {
      reasons.set(renderDurabilityReason(classification.reason), classification.reason)
    }
  }
  return [...reasons.values()]
}

/** Conservatively classify a cell before giving it non-journalable capability. */
export function classifyDurability(code, knownBindings = new Set(), { sourceType = 'script', internalModules = new Set() } = {}) {
  let body
  let moduleLoads = []
  if (sourceType === 'module') {
    const program = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    knownBindings = new Set(knownBindings)
    moduleLoads = program.body.filter(statement => statement.source != null
      && ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type)
      && !internalModules.has(statement.source.value)).map(statement => ({
      source: statement.source.value, position: declarationSpan(statement.source),
    }))
    body = { type: 'BlockStatement', body: program.body.flatMap(statement => {
      if (statement.type === 'ImportDeclaration') {
        for (const specifier of statement.specifiers) knownBindings.add(specifier.local.name)
        return []
      }
      if (statement.type === 'ExportAllDeclaration') return []
      if (statement.type === 'ExportNamedDeclaration') return statement.declaration === null ? [] : [statement.declaration]
      if (statement.type === 'ExportDefaultDeclaration') return [statement.declaration]
      return [statement]
    }) }
  } else ({ body } = parseExecutableCell(code))
  const declared = topLevelBindings(body.body)
  const rootBindings = new Set([...knownBindings, ...declared])
  const rootStrict = sourceType === 'module' || hasStrictDirective(body)
  addFunctionVariables(body, rootBindings, rootStrict)
  // A `var` is instantiated with the cell even on the path that never runs its
  // initializer, so it occupies the shared environment but does not by itself
  // replace a name an earlier cell bound.
  const hoistedVars = new Set()
  walkAst(body, (node) => {
    if (isFunction(node)) return SKIP_AST_CHILDREN
    if (node.type === 'StaticBlock') return SKIP_AST_CHILDREN
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const declaration of node.declarations) addPatternBindings(declaration.id, hoistedVars)
    }
  })
  const reasons = new Map()
  const addReason = reason => reasons.set(renderDurabilityReason(reason), reason)
  for (const reason of staticModuleClassification(moduleLoads)) addReason(reason)
  const classifyModule = (source) => {
    if (source?.type !== 'Literal' || typeof source.value !== 'string') {
      addReason(DYNAMIC_MODULE_REASON)
      return
    }
    const classification = classifyModuleSource(source.value)
    if (classification.status === 'forbidden') {
      throw new PreflightError(`cell import of ${source.value} is forbidden because it exposes kernel control`, source)
    }
    if (classification.reason !== undefined) addReason(classification.reason)
  }
  const isBound = (name, scopes) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (scopes[index].has(name)) return true
    }
    return false
  }
  walkAst(body, (node, parent, parentKey, { scopes, strict }) => {
    let nestedScopes = scopes
    if (isFunction(node)) {
      strict ||= hasStrictDirective(node.body)
      nestedScopes = [...scopes, functionParameterBindings(node)]
    } else if (node.type === 'BlockStatement' && node !== body) {
      const names = directBlockBindings(node.body)
      if (isFunction(parent)) addFunctionVariables(node, names, strict)
      nestedScopes = [...scopes, names]
    } else if (node.type === 'StaticBlock') {
      const names = directBlockBindings(node.body)
      for (const statement of node.body) addFunctionVariables(statement, names, true)
      strict = true
      nestedScopes = [...scopes, names]
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      strict = true
      nestedScopes = [...scopes, new Set(node.id === null ? [] : [node.id.name])]
    } else if (node.type === 'SwitchCase') {
      nestedScopes = [...scopes, directBlockBindings(parent.cases.flatMap(branch => branch.consequent))]
    } else if (node.type === 'CatchClause') {
      const names = new Set()
      addPatternBindings(node.param, names)
      nestedScopes = [...scopes, names]
    } else if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
      nestedScopes = [...scopes, loopBindings(node)]
    }
    if (node.type === 'ImportExpression') {
      classifyModule(node.source)
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require'
      && !isBound('require', nestedScopes)) {
      classifyModule(node.arguments[0])
    }
    if (node.type === 'Identifier' && isReferenceIdentifier(node, parent, parentKey)
      && !isBound(node.name, nestedScopes) && AMBIENT_GLOBALS.has(node.name)
      && !(node.name === 'require' && parent?.type === 'CallExpression' && parent.callee === node)) {
      addReason(Object.freeze({ kind: 'ambient', name: node.name }))
    }
    if (node.type === 'Identifier' && isReferenceIdentifier(node, parent, parentKey)
      && !isBound('process', nestedScopes) && node.name === 'process' && !isStableProcessMember(node, parent)) {
      addReason(Object.freeze({ kind: 'ambient', name: 'process' }))
    }
    if (node.type === 'Identifier' && ['global', 'globalThis'].includes(node.name)
      && isReferenceIdentifier(node, parent, parentKey) && !isBound(node.name, nestedScopes)
      && !(parent?.type === 'MemberExpression' && parent.object === node)) {
      addReason(Object.freeze({ kind: 'ambient', name: node.name }))
    }
    if (node.type === 'Identifier' && node.name === 'Math'
      && isReferenceIdentifier(node, parent, parentKey) && !isBound('Math', nestedScopes)
      && !(parent?.type === 'MemberExpression' && parent.object === node && staticMemberName(parent) !== undefined)) {
      addReason(Object.freeze({ kind: 'ambient', name: 'Math' }))
    }
    if (node.type === 'MemberExpression'
      && ((node.object?.type === 'Identifier' && node.object.name === 'Math' && !isBound('Math', nestedScopes))
        || (globalObjectMember(node.object) === 'Math' && !isBound(node.object.object.name, nestedScopes)))
      && staticMemberName(node) === 'random') {
      addReason(Object.freeze({ kind: 'math-random' }))
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier'
      && ['global', 'globalThis'].includes(node.object.name) && !isBound(node.object.name, nestedScopes)) {
      const member = staticMemberName(node)
      if (member === undefined) addReason(Object.freeze({ kind: 'computed-global-access' }))
      else if (member === 'process') addReason(Object.freeze({ kind: 'ambient', name: 'process' }))
      else if (AMBIENT_GLOBALS.has(member)) addReason(Object.freeze({ kind: 'ambient', name: member }))
      else if (member === 'global' || member === 'globalThis') addReason(Object.freeze({ kind: 'ambient', name: member }))
      else if (member === 'Math' && !(parent?.type === 'MemberExpression' && parent.object === node
        && staticMemberName(parent) !== undefined)) {
        addReason(Object.freeze({ kind: 'ambient', name: 'Math' }))
      }
    }
    return { scopes: nestedScopes, strict }
  }, undefined, { scopes: [rootBindings], strict: rootStrict })
  return {
    durability: reasons.size === 0 ? 'durable' : 'volatile',
    reasons: Object.freeze([...reasons.values()]),
    declared,
    hoistedVars,
  }
}

function rewriteCellReturns(code, sourceMap, unavailableNames) {
  const { body } = parseExecutableCell(code)
  const edits = []
  const allocateName = createGeneratedNameAllocator(body, unavailableNames)
  const returnSignal = allocateName('return_signal')
  const signalReference = `this[${JSON.stringify(returnSignal)}]`
  const completion = allocateName('cell_completion')
  const exit = allocateName('cell_exit')
  const ignored = allocateName('completion_effect')
  let asyncCompletion = false

  walkAst(body, (node) => {
    if (node !== body && isFunction(node)) return SKIP_AST_CHILDREN
    if (node.type === 'AwaitExpression' || node.await === true
      || node.type === 'VariableDeclaration' && node.kind === 'await using') asyncCompletion = true
    if (node.type === 'ReturnStatement') {
      const start = node.start
      const end = node.end
      const argument = node.argument === null
        ? ''
        : code.slice(node.argument.start, node.argument.end)
      // Break leaves resource and finally scopes without making disposal
      // suppress a private error for an otherwise successful return.
      edits.push({ start, end, text: `{let ${ignored}=(${completion}=new ${signalReference}(${argument}));break ${exit};}` })
    }
  })

  const directiveEnd = body.body.findLast(node => node.directive !== undefined)?.end ?? 0
  // Fallthrough cancels a return overridden by finally break/continue. Empty
  // declaration completions preserve the source's ordinary expression value.
  edits.push({ start: directiveEnd, end: directiveEnd,
    text: `\n{let ${completion};${exit}:{\n` })
  edits.push({ start: code.length, end: code.length,
    text: `\n;{let ${ignored}=(${completion}=void 0);}}{let ${ignored}=${completion}&&(()=>{throw ${completion}})();}}\n` })
  let lowered = applySourceEdits(code, sourceMap, edits)
  if (asyncCompletion) {
    // The frame result is compiler-owned transport. Letting Node create it
    // would hide the promise from our observer and re-enter source protocols
    // when the host REPL awaits this realm's completion.
    lowered = applySourceEdits(lowered.code, lowered.sourceMap, [
      { start: 0, end: 0, text: '(async()=>{' },
      { start: lowered.code.length, end: lowered.code.length, text: '\n})()' },
    ])
  }
  return { ...lowered, returnSignal, asyncCompletion }
}

/** Workbench completion uses the same source grammar and compilation boundary. */
export function prepareConsoleProgram(source, options) {
  const program = parseSource(source, { sourceType: 'script', errorRecovery: true,
    allowImportExportEverywhere: true, allowUndeclaredExports: true,
    allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, plugins: CELL_PARSER_PLUGINS }).program
  const last = program.body.at(-1)
  const input = last?.type !== 'ExpressionStatement' ? source
    : `${source.slice(0, last.start)}return (${source.slice(last.expression.start, last.expression.end)});${source.slice(last.end)}`
  return prepareProgram(input, options)
}

export function prepareProgram(program, options = {}) {
  if (typeof program !== 'string') throw new TypeError('ptc-plus: program must be a string')
  if (options.languageSemantics === undefined || options.languageSemantics === 'legacy-v1') {
    try {
      // Logical imports have no persistent native namespace slot. Their proved
      // identity enters the native execution environment with the other roots.
      const nativeOptions = { ...options, importBindings: new Map([...options.importBindings ?? []]
        .filter(([name]) => !options.establishedRoots?.has(name) || options.nativeBindings?.has(name))) }
      const prepared = adaptNativeRootDynamic(adaptLegacyModuleImports(prepareLegacyProgram(program, nativeOptions), nativeOptions), options, program)
      return { ...prepared, sourceRegions: sourceRegionData(prepared.sourceRegions), languageSemantics: 'legacy-v1' }
    } catch (error) {
      if (error instanceof LegacyPreflightError) throw new PreflightError(error.message, undefined, error.span)
      throw error
    }
  }
  if (options.languageSemantics === 'stateful-v1' || options.languageSemantics === 'protected-v1') {
    let normalized
    let prepared
    let callableSources
    const intrinsicContext = { bindings: new Set() }
    try {
      const marked = markCallableSources(program, undefined, { plugins: CELL_PARSER_PLUGINS, allowImportExportEverywhere: true, allowUndeclaredExports: true },
        { lowerNativeSource: lowerNativeLanguageSource, nativeUsing: options.nativeUsing })
      callableSources = marked.callableSources
      normalized = normalizeStatefulScopes(marked.code, marked.sourceMap, { mode: options.languageSemantics,
        nativeJavaScript: marked.nativeJavaScript, deferDecorators: true, deferResources: true, intrinsicContext })
      prepared = compileStatefulRoot(normalized.code, { ...options, sourceMap: normalized.sourceMap,
        internalBindings: normalized.internalBindings, dynamicBindings: normalized.dynamicBindings,
        privateBindings: normalized.privateBindings, originalSource: program })
    } catch (error) {
      if (error instanceof ModuleRewriteError) throw error
      const position = error.loc === undefined ? undefined : { line: error.loc.line, column: error.loc.column + 1 }
      throw new ModuleRewriteError(error.message, normalized === undefined ? position
        : mapSourcePosition(position, normalized.code, program, normalized.sourceMap))
    }
    prepared = { ...prepared, deferredHelpers: normalized.deferredHelpers }
    intrinsicContext.expression = `this[${JSON.stringify(prepared.rootRuntimeName)}].intrinsics`
    const classificationSource = bindCompilerIntrinsics(lowerStatefulDecorators(
      { ...prepared, code: prepared.classificationCode }, undefined, intrinsicContext), intrinsicContext).code
    prepared = bindCompilerIntrinsics(lowerStatefulDecorators(prepared, undefined, intrinsicContext), intrinsicContext)
    prepared = lowerStatefulResources(prepared, { intrinsicContext, nativeUsing: options.nativeUsing })
    const parsed = parseExecutableCell(prepared.code, { eraseTypes: true })
    const classification = classifyDurability(parseExecutableCell(classificationSource, { eraseTypes: true }).code,
      new Set([...(options.knownBindings ?? []), ...prepared.declared]))
    const reasons = [...staticModuleClassification(prepared.moduleLoads), ...classification.reasons]
    const lowered = rewriteCellReturns(parsed.code, prepared.sourceMap,
      new Set([...prepared.declared, ...(options.knownBindings ?? [])]))
    prepared.rootBindings.callableSources = collectCallableSources(lowered.code, callableSources)
    return { ...prepared, ...lowered,
      sourceRegions: sourceRegionData(prepared.sourceRegions),
      returnSignal: lowered.returnSignal,
      durability: reasons.length === 0 ? 'durable' : 'volatile', reasons: Object.freeze(reasons),
      reason: renderDurabilityReasons(reasons),
    }
  }
  throw new TypeError('ptc-plus: unsupported language semantics')
}
