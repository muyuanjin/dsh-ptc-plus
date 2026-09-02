import { stripTypeScriptTypes } from 'node:module'
import { parse } from 'acorn'
import {
  STRIP_PREFIX,
  STRIP_SUFFIX,
  rewriteModuleImportsExports,
} from './cell-rewriter.js'
import {
  LEGACY_DEFAULT_EXPORT_BINDING,
  LIVE_DEFAULT_EXPORT_BINDING,
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
import { applySourceEdits, mapSourceSpan } from './source-position-map.js'
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
    line: Math.max(1, start.line - 1),
    column: start.column + 1,
    /* c8 ignore next */
    ...(end === undefined ? {} : {
      end: {
        line: Math.max(1, end.line - 1),
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

function functionBindings(node) {
  const names = new Set()
  if (node.id !== null && node.id !== undefined) names.add(node.id.name)
  /* c8 ignore next */
  for (const param of node.params ?? []) addPatternBindings(param, names)
  walkAst(node.body, (current) => {
    if (current !== node && isFunction(current)) {
      if (current.type === 'FunctionDeclaration' && current.id !== null) names.add(current.id.name)
      return SKIP_AST_CHILDREN
    }
    if (current.type === 'VariableDeclaration' && current.kind === 'var') {
      for (const declaration of current.declarations) addPatternBindings(declaration.id, names)
    }
  })
  return names
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

function globalThisMember(node) {
  return node?.type === 'MemberExpression'
    && node.object?.type === 'Identifier'
    && node.object.name === 'globalThis'
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
  const tree = parse(`${STRIP_PREFIX}${code}${STRIP_SUFFIX}`, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
  const outer = tree.body[0]
  /* c8 ignore next */
  if (outer?.type !== 'FunctionDeclaration') throw new Error('ptc-plus: failed to parse cell wrapper')
  const declared = topLevelBindings(outer.body.body)
  const rootBindings = new Set([...knownBindings, ...declared])
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
  walkAst(outer.body, (node, parent, parentKey, scopes) => {
    let nestedScopes = scopes
    if (isFunction(node)) {
      nestedScopes = [...scopes, functionBindings(node)]
    } else if (node.type === 'BlockStatement' && node !== outer.body) {
      nestedScopes = [...scopes, directBlockBindings(node.body)]
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
    if (node.type === 'MemberExpression'
      && ((node.object?.type === 'Identifier' && node.object.name === 'Math' && !isBound('Math', nestedScopes))
        || (globalThisMember(node.object) === 'Math' && !isBound('globalThis', nestedScopes)))
      && staticMemberName(node) === 'random') {
      addReason(Object.freeze({ kind: 'math-random' }))
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier'
      && node.object.name === 'globalThis' && !isBound('globalThis', nestedScopes)) {
      const member = staticMemberName(node)
      if (member === undefined) addReason(Object.freeze({ kind: 'computed-global-access' }))
      else if (member === 'process') addReason(Object.freeze({ kind: 'ambient', name: 'process' }))
      else if (AMBIENT_GLOBALS.has(member)) addReason(Object.freeze({ kind: 'ambient', name: member }))
    }
    return nestedScopes
  }, undefined, [rootBindings], outer, 'body')
  return {
    durability: reasons.size === 0 ? 'durable' : 'volatile',
    reasons: Object.freeze([...reasons.values()]),
    declared,
  }
}

function rewriteCellReturns(code, sourceMap, unavailableNames) {
  const wrapped = STRIP_PREFIX + code + STRIP_SUFFIX
  const tree = parse(wrapped, { ecmaVersion: 'latest', sourceType: 'script' })
  const outer = tree.body[0]
  /* c8 ignore next */
  if (outer?.type !== 'FunctionDeclaration') throw new Error('ptc-plus: failed to parse cell wrapper')
  const offset = STRIP_PREFIX.length
  const edits = []
  const allocateName = createGeneratedNameAllocator(tree, unavailableNames)
  const returnSignal = allocateName('return_signal')
  const signalReference = `this[${JSON.stringify(returnSignal)}]`

  walkAst(outer.body, (node) => {
    if (node !== outer.body && isFunction(node)) return SKIP_AST_CHILDREN
    if (node.type === 'ReturnStatement') {
      const start = node.start - offset
      const end = node.end - offset
      const argument = node.argument === null
        ? ''
        : code.slice(node.argument.start - offset, node.argument.end - offset)
      // A ReturnStatement may be the last clause body in a switch case. The
      // generated throw must terminate explicitly because the original return
      // statement's semicolon is part of the replaced AST range.
      edits.push({ start, end, text: `throw new ${signalReference}(${argument});` })
      return SKIP_AST_CHILDREN
    }
    if (node.type === 'CatchClause') {
      const bodyStart = node.body.start - offset + 1
      const temporary = allocateName('caught')
      if (node.param === null) {
        edits.push({ start: node.start - offset + 5, end: node.start - offset + 5, text: ` (${temporary})` })
        edits.push({ start: bodyStart, end: bodyStart, text: `\nif (${temporary} instanceof ${signalReference}) throw ${temporary};` })
      } else if (node.param.type === 'Identifier') {
        edits.push({
          start: bodyStart,
          end: bodyStart,
          text: `\nif (${node.param.name} instanceof ${signalReference}) throw ${node.param.name};`,
        })
      } else {
        const pattern = code.slice(node.param.start - offset, node.param.end - offset)
        edits.push({ start: node.param.start - offset, end: node.param.end - offset, text: temporary })
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

export function prepareProgram(program, knownBindings, bindingPolicy, reservedBindings = new Set(), rewritesEnabled, importBindings = new Map(), importNamespaces = new Set(), writableBindings = undefined, moduleSemantics = { defaultExportBinding: LIVE_DEFAULT_EXPORT_BINDING }) {
  if (typeof program !== 'string') throw new TypeError('ptc-plus: program must be a string')
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
      .includes(moduleSemantics.defaultExportBinding)) {
    throw new TypeError('ptc-plus: module semantics must define a supported defaultExportBinding')
  }
  const unavailableGeneratedNames = new Set([
    ...knownBindings,
    ...reservedBindings,
    ...importBindings.keys(),
    ...importNamespaces,
  ])
  const moduleRewrite = rewriteModuleImportsExports(
    program,
    rewritesEnabled,
    importBindings,
    importNamespaces,
    unavailableGeneratedNames,
    moduleSemantics,
  )
  const staticModuleReasons = staticModuleClassification(moduleRewrite.moduleLoads)
  const wrapped = STRIP_PREFIX + moduleRewrite.code + STRIP_SUFFIX
  let stripped = wrapped
  let tree
  try {
    tree = parse(wrapped, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
  } catch (javascriptError) {
    try {
      stripped = stripTypeScriptTypes(wrapped)
      tree = parse(stripped, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
    } catch {
      throw javascriptError
    }
  }
  const code = stripped.slice(STRIP_PREFIX.length, stripped.length - STRIP_SUFFIX.length)
  const sourceMap = moduleRewrite.sourceMap
  const outer = tree.body[0]
  const commitSignal = moduleRewrite.commitSignal
  /* c8 ignore next */
  const generatedDeclarations = outer?.type === 'FunctionDeclaration'
    ? topLevelDeclarations(outer.body.body, bindingPolicy.variableRedeclarations)
    : []
  const collisionFor = (declaration) => {
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
  const classifyPrepared = (preparedCode, preparedSourceMap) => {
    try {
      const classification = classifyDurability(preparedCode, knownBindings)
      const reasons = new Map()
      for (const reason of [...staticModuleReasons, ...classification.reasons]) {
        reasons.set(renderDurabilityReason(reason), reason)
      }
      return {
        ...classification,
        durability: reasons.size === 0 ? 'durable' : 'volatile',
        reasons: Object.freeze([...reasons.values()]),
        reason: renderDurabilityReasons([...reasons.values()]),
      }
    } catch (error) {
      if (error instanceof PreflightError && error.span !== undefined) {
        error.span = mapSourceSpan(error.span, preparedCode, program, preparedSourceMap)
      }
      throw error
    }
  }
  const importedNames = new Set(moduleRewrite.imports.keys())
  const originalDeclarationNames = new Set(moduleRewrite.exportDeclarations.map(declaration => declaration.name))
  const declarations = [
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
          definitionSpan: mapSourceSpan(declaration.definitionSpan, code, program, sourceMap),
        }),
      })),
  ]
  const normalizeClassification = classification => {
    const imports = new Map(moduleRewrite.imports)
    for (const name of classification.declared) {
      if (!moduleRewrite.generatedNamespaces.has(name)) imports.delete(name)
    }
    return {
      ...classification,
      imports,
      declared: new Set([...classification.declared, ...importedNames]),
    }
  }
  const reserved = declarations.filter(declaration => (
    reservedBindings.has(declaration.name)
    || moduleRewrite.importNamespaces.has(declaration.name)
    || (declaration.kind === 'import' && knownBindings.has(declaration.name))
  ))
  if (reserved.length > 0) {
    const classification = normalizeClassification(classifyPrepared(code, sourceMap))
    return {
      code,
      ...classification,
      declarations,
      imports: classification.imports,
      importNamespaces: moduleRewrite.importNamespaces,
      collisions: reserved.map(collisionFor),
      redeclared: [],
      rewrites: moduleRewrite.rewrites,
      moduleLoads: moduleRewrite.moduleLoads,
    }
  }
  const convenience = rewriteReplRedeclarations({
    code,
    sourceMap,
    body: outer?.type === 'FunctionDeclaration' ? outer.body.body : undefined,
    offset: STRIP_PREFIX.length,
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
  // Classification sees the rewritten program so declared bindings reflect the
  // split form; it must never see the return rewrite, whose computed
  // globalThis access would mark every returning cell volatile.
  const classification = normalizeClassification(classifyPrepared(executableCode, executableSourceMap))
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
    ...(lowered.returnSignal === undefined ? {} : { returnSignal: lowered.returnSignal }),
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
