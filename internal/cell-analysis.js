import { ModuleRewriteError, rewriteModuleImportsExports } from './cell-rewriter.js'
import { parseExecutableCell } from './cell-parser.js'
import {
  LEGACY_DEFAULT_EXPORT_BINDING,
  LIVE_DEFAULT_EXPORT_BINDING,
  LIVE_MODULE_SEMANTICS,
  LEGACY_IMPORT_EXPRESSION_BOUNDARY,
  LIVE_IMPORT_EXPRESSION_BOUNDARY,
  redeclarationCommitTarget,
} from './repl-rewrite-contract.js'
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
import { rewriteReplRedeclarations } from './repl-convenience.js'
import { applySourceEdits, mapSourcePosition, mapSourceSpan } from './source-position-map.js'
import { SKIP_AST_CHILDREN, walkAst } from './ast-traversal.js'

/**
 * Pure AST analysis for PTC cells: binding inventory, durability classification,
 * return rewriting, and program preparation. This module owns no worker, journal,
 * or session state so its behavior is fully testable in isolation.
 */

export function declarationSpan(node) {
  const start = node.loc?.start
  /* c8 ignore next */
  const end = node.loc?.end ?? start
  /* c8 ignore next */
  if (start === undefined) return undefined
  return {
    line: start.line,
    column: start.column + 1,
    /* c8 ignore next */
    ...(end === undefined ? {} : {
      end: {
        line: end.line,
        column: end.column + 1,
      },
    }),
  }
}

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

function topLevelDeclarations(body, variableRedeclarations = false) {
  const declarations = []
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration') {
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

export class PreflightError extends Error {
  constructor(message, node, span = undefined) {
    super(message)
    this.span = span ?? declarationSpan(node)
  }
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
export function classifyDurability(code, knownBindings = new Set()) {
  const { body } = parseExecutableCell(code)
  const declared = topLevelBindings(body.body)
  const rootBindings = new Set([...knownBindings, ...declared])
  const rootStrict = hasStrictDirective(body)
  addFunctionVariables(body, rootBindings, rootStrict)
  const reasons = new Map()
  const addReason = reason => reasons.set(renderDurabilityReason(reason), reason)
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
  }
}

function rewriteCellReturns(code, sourceMap, unavailableNames) {
  const { body } = parseExecutableCell(code)
  const edits = []
  const allocateName = createGeneratedNameAllocator(body, unavailableNames)
  const returnSignal = allocateName('return_signal')
  const signalReference = `this[${JSON.stringify(returnSignal)}]`

  walkAst(body, (node) => {
    if (node !== body && isFunction(node)) return SKIP_AST_CHILDREN
    if (node.type === 'ReturnStatement') {
      const start = node.start
      const end = node.end
      const argument = node.argument === null
        ? ''
        : code.slice(node.argument.start, node.argument.end)
      // A ReturnStatement may be the last clause body in a switch case. The
      // generated throw must terminate explicitly because the original return
      // statement's semicolon is part of the replaced AST range.
      edits.push({ start, end, text: `throw new ${signalReference}(${argument});` })
      return SKIP_AST_CHILDREN
    }
    if (node.type === 'CatchClause') {
      const bodyStart = node.body.start + 1
      const temporary = allocateName('caught')
      if (node.param === null) {
        edits.push({ start: node.start + 5, end: node.start + 5, text: ` (${temporary})` })
        edits.push({ start: bodyStart, end: bodyStart, text: `\nif (${temporary} instanceof ${signalReference}) throw ${temporary};` })
      } else if (node.param.type === 'Identifier') {
        edits.push({
          start: bodyStart,
          end: bodyStart,
          text: `\nif (${node.param.name} instanceof ${signalReference}) throw ${node.param.name};`,
        })
      } else {
        const pattern = code.slice(node.param.start, node.param.end)
        edits.push({ start: node.param.start, end: node.param.end, text: temporary })
        edits.push({
          start: bodyStart,
          end: bodyStart,
          text: `\nif (${temporary} instanceof ${signalReference}) throw ${temporary};\nconst ${pattern} = ${temporary};`,
        })
      }
    }
  })

  /* c8 ignore next */
  edits.sort((left, right) => right.start - left.start || right.end - left.end)
  return { ...applySourceEdits(code, sourceMap, edits), returnSignal }
}

function normalizePreparationOptions({
  knownBindings = new Set(),
  bindingPolicy,
  reservedBindings = new Set(),
  rewritesEnabled,
  importBindings = new Map(),
  importNamespaces = new Set(),
  writableBindings,
  moduleSemantics = LIVE_MODULE_SEMANTICS,
}) {
  if (typeof bindingPolicy === 'boolean') {
    bindingPolicy = {
      variableRedeclarations: bindingPolicy,
      functionClassRedeclarations: false,
    }
  }
  if (bindingPolicy === null || typeof bindingPolicy !== 'object' || Array.isArray(bindingPolicy)
    || typeof bindingPolicy.variableRedeclarations !== 'boolean'
    || typeof bindingPolicy.functionClassRedeclarations !== 'boolean') {
    throw new TypeError('ptc-plus: binding policy must define variableRedeclarations and functionClassRedeclarations booleans')
  }
  writableBindings ??= bindingPolicy.variableRedeclarations ? new Set(knownBindings) : new Set()
  if (rewritesEnabled === null || typeof rewritesEnabled !== 'object' || Array.isArray(rewritesEnabled)
    || typeof rewritesEnabled.autoRewriteImports !== 'boolean'
    || typeof rewritesEnabled.autoStripExports !== 'boolean'
    || typeof rewritesEnabled.autoSplitRedeclarations !== 'boolean') {
    throw new TypeError('ptc-plus: rewrite policy must define autoRewriteImports, autoStripExports, and autoSplitRedeclarations booleans')
  }
  if (moduleSemantics === null || typeof moduleSemantics !== 'object' || Array.isArray(moduleSemantics)
    || ![LEGACY_DEFAULT_EXPORT_BINDING, LIVE_DEFAULT_EXPORT_BINDING]
      .includes(moduleSemantics.defaultExportBinding)
    || ![LEGACY_IMPORT_EXPRESSION_BOUNDARY, LIVE_IMPORT_EXPRESSION_BOUNDARY]
      .includes(moduleSemantics.importExpressionBoundary)) {
    throw new TypeError('ptc-plus: module semantics must define supported default-export and import-expression rules')
  }
  return { knownBindings, bindingPolicy, reservedBindings, rewritesEnabled,
    importBindings, importNamespaces, writableBindings, moduleSemantics }
}

function parseMappedCell(moduleRewrite, program) {
  try {
    return parseExecutableCell(moduleRewrite.code, { eraseTypes: true })
  } catch (error) {
    if (error instanceof ModuleRewriteError) {
      error.cellPosition = mapSourcePosition(error.cellPosition, moduleRewrite.code, program, moduleRewrite.sourceMap)
    }
    throw error
  }
}

function collisionMapper(code, program, sourceMap) {
  return declaration => {
    /* c8 ignore next */
    const mapped = declaration.original === true ? declaration.span : declaration.span === undefined
      ? { line: 1, column: 1 }
      : mapSourceSpan(declaration.span, code, program, sourceMap)
    return {
      name: declaration.name,
      kind: declaration.kind,
      replaceableByVariableDeclaration: declaration.replaceableByVariableDeclaration === true,
      ...(declaration.reason === undefined ? {} : { reason: declaration.reason }),
      ...(declaration.commitDependency === undefined
        ? {}
        : { commitDependency: declaration.commitDependency }),
      start: { line: mapped.line, column: mapped.column },
      /* c8 ignore next */
      ...(mapped.end === undefined ? {} : { end: mapped.end }),
    }
  }
}

function preparedDeclarations(moduleRewrite, parsed, program, bindingPolicy) {
  const generatedDeclarations = topLevelDeclarations(parsed.body.body, bindingPolicy.variableRedeclarations)
  const originalDeclarationNames = new Set(moduleRewrite.exportDeclarations.map(declaration => declaration.name))
  return [
    ...moduleRewrite.importDeclarations.map(declaration => ({ ...declaration, writable: false })),
    ...moduleRewrite.exportDeclarations.map(declaration => ({
      ...declaration,
      writable: bindingPolicy.variableRedeclarations,
    })),
    ...generatedDeclarations
      .filter(declaration => !moduleRewrite.generatedNamespaces.has(declaration.name)
        && !originalDeclarationNames.has(declaration.name))
      .map(declaration => ({
        ...declaration,
        ...(declaration.definitionSpan === undefined ? {} : {
          definitionSpan: mapSourceSpan(declaration.definitionSpan, parsed.code, program, moduleRewrite.sourceMap),
        }),
      })),
  ]
}

function classifyPrepared({ code, sourceMap }, program, knownBindings, moduleRewrite, staticModuleReasons) {
  let classification
  try {
    classification = classifyDurability(code, knownBindings)
  } catch (error) {
    if (error instanceof PreflightError && error.span !== undefined) {
      error.span = mapSourceSpan(error.span, code, program, sourceMap)
    }
    throw error
  }
  const reasons = new Map()
  for (const reason of [...staticModuleReasons, ...classification.reasons]) {
    reasons.set(renderDurabilityReason(reason), reason)
  }
  const imports = new Map(moduleRewrite.imports)
  for (const name of classification.declared) {
    if (!moduleRewrite.generatedNamespaces.has(name)) imports.delete(name)
  }
  return {
    ...classification,
    durability: reasons.size === 0 ? 'durable' : 'volatile',
    reasons: Object.freeze([...reasons.values()]),
    reason: renderDurabilityReasons([...reasons.values()]),
    imports,
    declared: new Set([...classification.declared, ...moduleRewrite.imports.keys()]),
  }
}

export function prepareProgram(program, options = {}) {
  if (typeof program !== 'string') throw new TypeError('ptc-plus: program must be a string')
  const { knownBindings, bindingPolicy, reservedBindings, rewritesEnabled,
    importBindings, importNamespaces, writableBindings, moduleSemantics } = normalizePreparationOptions(options)
  const unavailableGeneratedNames = new Set([
    ...knownBindings, ...reservedBindings, ...importBindings.keys(), ...importNamespaces,
  ])
  const moduleRewrite = rewriteModuleImportsExports(
    program, rewritesEnabled, importBindings, importNamespaces, unavailableGeneratedNames, moduleSemantics,
  )
  const staticModuleReasons = staticModuleClassification(moduleRewrite.moduleLoads)
  const parsed = parseMappedCell(moduleRewrite, program)
  const { code } = parsed
  const { sourceMap, commitSignal } = moduleRewrite
  const declarations = preparedDeclarations(moduleRewrite, parsed, program, bindingPolicy)
  const collisionFor = collisionMapper(code, program, sourceMap)
  const reserved = declarations.filter(declaration => (
    reservedBindings.has(declaration.name)
    || moduleRewrite.importNamespaces.has(declaration.name)
    || (declaration.kind === 'import' && knownBindings.has(declaration.name))
  ))
  const convenience = reserved.length > 0 ? {
    executableCode: code, executableSourceMap: sourceMap,
    collisions: reserved.map(collisionFor), redeclared: [], rewrites: [],
  } : rewriteReplRedeclarations({
    code,
    sourceMap,
    body: parsed.body.body,
    knownBindings,
    variableRedeclarationBindings: bindingPolicy.variableRedeclarations
      ? new Set([...knownBindings].filter(name => !importBindings.has(name)))
      : new Set(knownBindings),
    writableBindings: new Set([...writableBindings].filter(name => !importBindings.has(name))),
    declarations,
    declarationSpan,
    collisionFor,
    bindingPolicy,
    autoSplitRedeclarations: rewritesEnabled.autoSplitRedeclarations,
    commitSignal,
  })
  const { executableCode, executableSourceMap, collisions, redeclared, rewrites } = convenience
  const commitTargets = new Set(moduleRewrite.commitTargets)
  for (const declaration of redeclared) {
    if (declaration.kind === 'function' || declaration.kind === 'class') {
      commitTargets.add(declaration.commitDependency)
    }
  }
  // Generated control helpers are not ambient inputs from the user's program.
  const classification = classifyPrepared(
    { code: executableCode, sourceMap: executableSourceMap },
    program, knownBindings, moduleRewrite, staticModuleReasons,
  )
  let lowered = { code, sourceMap }
  if (collisions.length === 0) {
    lowered = rewriteCellReturns(
      executableCode,
      executableSourceMap,
      unavailableGeneratedNames,
    )
  }
  return {
    code: lowered.code,
    sourceMap: lowered.sourceMap,
    returnSignal: lowered.returnSignal,
    ...classification,
    declarations,
    imports: classification.imports,
    importNamespaces: moduleRewrite.importNamespaces,
    collisions,
    redeclared,
    rewrites: [...moduleRewrite.rewrites, ...rewrites],
    moduleLoads: moduleRewrite.moduleLoads,
    commitSignal,
    commitTargets,
  }
}
