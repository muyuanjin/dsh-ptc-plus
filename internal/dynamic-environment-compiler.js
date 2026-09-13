import { parse, parseExpression } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { transformFromAstSync, types as t } from '@babel/core'
import generatorImport from '@babel/generator'
import { createGeneratedNameAllocator, isWriteIdentifier as isWrite } from './binding-pattern.js'
import { rewriteNativeCalls } from './dynamic-native-calls.js'
import { markCallableSources, collectCallableSources, regionCallableRanges } from './callable-source-facts.js'
import { identitySourceMap, mapSourceSpan, sourceLineStarts, sourceTextAtSpan } from './source-position-map.js'
import { transformRegionSource } from './compiler-region-output.js'
import { rewriteNativeAwaitDeclarations } from './native-await-declarations.js'
import { createDynamicScopeAnalysis, sourceBinding, sourceScopePath, sourceInParameters, sourceBindingVisible } from './dynamic-scope-analysis.js'
import { bindingNodes } from './binding-pattern.js'
import { visitSource } from './compiler-source-regions.js'
import { createCompilerOperationPlanner } from './compiler-operations.js'

const traverse = traverseModule.default ?? traverseModule
const generate = generatorImport.default ?? generatorImport
const member = (object, name) => t.memberExpression(t.cloneNode(object), t.identifier(name))
const call = (object, name, args = []) => t.callExpression(member(object, name), args)
const undefinedValue = () => t.unaryExpression('void', t.numericLiteral(0))
const namedValue = (name, value) => {
  if (!t.isArrowFunctionExpression(value) && !((t.isFunctionExpression(value) || t.isClassExpression(value)) && value.id === null)) return value
  const key = typeof name === 'string' ? t.stringLiteral(name) : name
  const object = t.inherits(t.objectExpression([t.objectProperty(t.cloneNode(key), value, true)]), value)
  return t.inherits(t.memberExpression(object, t.cloneNode(key), true), value)
}
const replaceIterationDeclaration = (path, target, initializers, allocate, nativeAwait = false) => {
  if (initializers.length === 0) return path.replaceWith(target)
  const loop = path.parentPath.node
  if (nativeAwait) {
    // The REPL await lowerer rejects initialized for-in headers. Its explicit
    // cell result remains separate from declaration initialization effects.
    loop.right = t.inherits(t.sequenceExpression([...initializers, loop.right]), loop.right)
    return path.replaceWith(target)
  }
  // Retain the native initialized for-in form: its completion differs from an
  // assignment-target loop. Private declarations contribute no body completion.
  const iteration = t.identifier(allocate('initialized_iteration'))
  path.replaceWith(t.variableDeclaration('var', [t.variableDeclarator(iteration,
    t.sequenceExpression([...initializers, undefinedValue()]))]))
  loop.body = t.blockStatement([
    t.variableDeclaration('let', [t.variableDeclarator(t.identifier(allocate('iteration_write')),
      t.assignmentExpression('=', target, t.cloneNode(iteration)))]), loop.body,
  ])
}
const strictAt = path => path.isInStrictMode()
  || path.isFunction() && path.node.body.directives?.some(directive => directive.value.value === 'use strict') === true
const lexicalOwner = path => path.findParent(parent =>
  parent.isFunction() && !parent.isArrowFunctionExpression()
    && (parent.get('body').isAncestor(path) || parent.node.params.some(parameter => parameter.start <= path.node.start && parameter.end >= path.node.end))
  || parent.isStaticBlock()
  || (parent.isClassProperty() || parent.isClassPrivateProperty() || parent.isClassAccessorProperty())
    && parent.node.value !== null && (parent.node.value === path.node || parent.get('value').isAncestor(path)))

function compileStaticRegions(source, cell, parserOptions) {
  const environment = cell.environmentExpression === undefined ? t.identifier(cell.environmentName) : parseExpression(cell.environmentExpression)
  const sourceStarts = sourceLineStarts(source)
  const planOperations = createCompilerOperationPlanner(cell)
  const result = transformRegionSource({ code: source, sourceMap: identitySourceMap(source.length), sourceRegions: cell.sourceRegions }, parserOptions, input => {
    const operations = planOperations(input.tree)
    const allocate = cell.sourceRegions?.allocate ?? createGeneratedNameAllocator(input.tree)
    const envelope = input.prefix ? input.tree.program.body[0] : undefined
    const invocations = new WeakMap()
    const originalCallees = new WeakSet()
    const coordinates = { generatedStarts: sourceLineStarts(input.code), originalStarts: sourceStarts }
    const absoluteNode = node => {
      const span = mapSourceSpan({ line: node.loc.start.line, column: node.loc.start.column + 1,
        end: { line: node.loc.end.line, column: node.loc.end.column + 1 } }, input.code, source, input.sourceMap, coordinates)
      return { ...node, loc: { start: { line: span.line, column: span.column - 1 }, end: { line: span.end.line, column: span.end.column - 1 } } }
    }
    traverse(input.tree, {
      Scopable(path) {
        // A partition cannot prove that a binding is unchanged in other source
        // regions. Babel must retain receivers across every potentially mutating
        // getter/call; global source allocation owns all new temporary names.
        for (const binding of Object.values(path.scope.bindings)) binding.constant = false
      },
      'CallExpression|OptionalCallExpression|NewExpression|TaggedTemplateExpression|Decorator'(path) {
        if (path.isCallExpression() || path.isOptionalCallExpression()) originalCallees.add(path.node.callee)
        if (operations.owns(path.node)) return
        const expression = path.node.callee ?? path.node.tag ?? path.node.expression
        // Literal callables cannot produce the non-callable diagnostic. Keep
        // invocation adaptation without retaining their overlapping bodies.
        if (t.isFunctionExpression(expression) || t.isArrowFunctionExpression(expression)) return
        const callee = absoluteNode(expression)
        invocations.set(path.node, cell.calleeSource?.(callee) ?? sourceTextAtSpan(source, {
          line: callee.loc.start.line, column: callee.loc.start.column + 1,
          end: { line: callee.loc.end.line, column: callee.loc.end.column + 1 },
        }, sourceStarts))
      },
    })
    rewriteNativeCalls(input.tree, environment, {
      operations, allocate,
      originalCallees,
      origin: node => ({ target: node.loc === undefined ? undefined : cell.evalOrigin?.(absoluteNode(node)), callee: invocations.get(node) }),
      skip: operations.declaration,
    })
    if (envelope !== undefined) {
      // Babel hoists optional-chain temporaries to the analysis envelope.
      // Publish those private declarations in the real output body, retaining
      // its directive prologue and native variable owner.
      const declarations = [...input.tree.program.body, ...envelope.body.body]
        .filter(node => t.isVariableDeclaration(node) && node.loc === undefined)
      const body = input.region.kind === 'block' ? input.selected.body[0].body : input.selected.body
      let insertion = 0
      while (t.isExpressionStatement(body[insertion]) && t.isStringLiteral(body[insertion].expression)) insertion++
      body.splice(insertion, 0, ...declarations)
    }
    const generated = generate(t.program(input.selected.body, input.selected.directives, input.tree.program.sourceType),
      { sourceMaps: true, sourceFileName: 'ptc-region.ts', compact: cell.compactOutput === true }, input.code)
    generated.callableRanges = regionCallableRanges(input, generated, cell.callableRanges, parserOptions)
    return generated
  }, cell.callableCollector?.collect)
  return { code: result.code, sourceOffsets: result.sourceMap, sourceRegions: result.sourceRegions,
    callableRanges: cell.callableCollector === undefined ? result.callableRanges
      : [...cell.callableCollector.resolve(result.callableRanges).values()], environmentName: cell.environmentName, varNames: [] }
}

/** Compile standard eval syntax against an explicit calling environment. */
export function compileDynamicEnvironmentSource(source, { strict = false, allowNewTarget = false, cell,
  privateNames = [], allowSuper = false, allowSuperCall = false, forbidArguments = false, functionConstructor = false, resolveOriginalSource } = {}) {
  const commonJs = cell?.sourceType === 'commonjs'
  const parserOptions = { sourceType: cell?.sourceType ?? 'script', strictMode: strict || cell?.sourceType === 'module',
    ...(commonJs ? {} : { allowNewTargetOutsideFunction: allowNewTarget }), allowSuperOutsideMethod: allowSuper,
    errorRecovery: privateNames.length > 0,
    ...(cell === undefined ? {} : { ...(commonJs ? {} : { allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }),
      plugins: cell.parserPlugins }) }
  if (cell?.staticOnly === true) return compileStaticRegions(source, cell, parserOptions)
  const originalSource = source
  const originalLineStarts = sourceLineStarts(originalSource)
  const marked = cell === undefined ? markCallableSources(source, undefined, parserOptions, { resolveOriginalSource }) : undefined
  if (marked !== undefined) source = marked.code
  const tree = parse(source, parserOptions)
  const operations = createCompilerOperationPlanner(cell)(tree)
  const dynamicScopeAnalysis = createDynamicScopeAnalysis(tree)
  // Capture references before lexical resolution or value exposure replaces them.
  const invocationSources = new WeakMap()
  visitSource(tree, { 'CallExpression|OptionalCallExpression|NewExpression|TaggedTemplateExpression|Decorator'(path) {
    if (operations.owns(path.node)) return
    const callee = path.node.callee ?? path.node.tag ?? path.node.expression
    if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) return
    const span = { line: callee.loc.start.line, column: callee.loc.start.column + 1,
      end: { line: callee.loc.end.line, column: callee.loc.end.column + 1 } }
    invocationSources.set(path.node, cell?.calleeSource?.(callee)
      ?? sourceTextAtSpan(originalSource, marked === undefined ? span : mapSourceSpan(span, source, originalSource, marked.sourceMap), originalLineStarts))
  } })
  const callOrigin = node => ({
    target: node.loc === undefined ? undefined : cell?.evalOrigin?.(node),
    callee: invocationSources.get(node),
  })
  if (functionConstructor) {
    const fn = tree.program.body[0].expression
    fn.id = null
    tree.program.body[0].expression = namedValue('anonymous', fn)
  }
  const externalPrivate = new Set()
  for (const error of tree.errors) {
    if (error.reasonCode !== 'InvalidPrivateFieldResolution' || !privateNames.includes(error.details.identifierName)) throw error
    externalPrivate.add(error.pos)
  }
  const { sourceInitializers, declaration: internalDeclaration } = operations
  // Babel models the block lexical declaration but deliberately omits Annex B's
  // additional var binding. Expose that native binding before resolving names.
  const annexFunctions = new WeakSet()
  const annexVars = new Map()
  traverse(tree, {
    FunctionDeclaration(path) {
      if (cell !== undefined || strict || strictAt(path) || path.node.async || path.node.generator) return
      if (path.parentPath.isProgram() || path.parentPath.isBlockStatement() && path.parentPath.parentPath.isFunction()) return
      if (!path.parentPath.isBlockStatement() && !path.parentPath.isSwitchCase()) {
        path.replaceWith(t.blockStatement([path.node]))
        return
      }
      const owner = path.getFunctionParent()?.scope ?? path.findParent(parent => parent.isProgram()).scope
      let current = path.scope.parent
      while (current !== null) {
        const binding = current.getOwnBinding(path.node.id.name)
        if (binding !== undefined && binding.path.node !== path.node && !['var', 'param', 'hoisted'].includes(binding.kind)) return
        if (current === owner) break
        current = current.parent
      }
      const names = annexVars.get(owner) ?? new Set()
      names.add(path.node.id.name)
      annexVars.set(owner, names)
      if (owner.path.isProgram()) annexFunctions.add(path.node)
    },
  })
  for (const [scope, names] of annexVars) {
    const body = scope.path.isProgram() ? scope.path.node : scope.path.node.body
    body.body.unshift(t.variableDeclaration('var', [...names].map(name => t.variableDeclarator(t.identifier(name)))))
  }
  traverse(tree, { Program(path) { path.scope.crawl(); path.stop() } })
  const allocate = createGeneratedNameAllocator(tree)
  const environmentName = cell?.environmentName ?? allocate('eval_environment')
  const incoming = cell?.environmentExpression === undefined ? t.identifier(environmentName) : parseExpression(cell.environmentExpression)
  const logicalBindings = new Map((cell?.bindings ?? []).map(binding => [binding.physicalName, binding]))
  const candidateRegions = new Map()
  // Candidate identifiers are proven by the normalizer. Their assignment owns
  // the pattern and initializer, independently of later source-map insertions.
  // A containing native scope can outlive that region, as in a for initializer.
  const candidateTargets = (node, region) => {
    if (t.isMemberExpression(node)) {
      const receiver = t.isMemberExpression(node.object) && t.isIdentifier(node.object.object)
        && logicalBindings.get(node.object.object.name)?.property === node.object.property.name
        ? node.object.object : node.object
      const physical = t.isCallExpression(receiver) ? receiver.callee : receiver
      const binding = t.isIdentifier(physical) ? logicalBindings.get(physical.name) : undefined
      if (binding?.role === 'candidate') {
        const regions = candidateRegions.get(binding.physicalName) ?? []
        regions.push(region)
        candidateRegions.set(binding.physicalName, regions)
      }
    } else if (t.isArrayPattern(node)) {
      for (const element of node.elements) candidateTargets(element, region)
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties) candidateTargets(t.isRestElement(property) ? property.argument : property.value, region)
    } else if (t.isAssignmentPattern(node)) candidateTargets(node.left, region)
    else if (t.isRestElement(node)) candidateTargets(node.argument, region)
  }
  traverse(tree, { AssignmentExpression(path) { candidateTargets(path.node.left, path.node) } })
  const hiddenBindings = new Set([environmentName, cell?.rootRuntime, ...cell?.internalBindings ?? []].filter(name => name !== undefined))
  const states = new WeakMap()
  const generated = new WeakSet()
  const nativePlaceholders = new WeakSet()
  const functionPlans = []
  const functionScopes = new Map()
  const creationPlans = []
  const withPlans = []
  const varNames = new Set()
  const varDeclarations = []
  const functions = []
  const annexPublications = []
  let programPath
  let programState
  const withSensitive = path => {
    let child = path
    for (let parent = path.parentPath; parent !== null; child = parent, parent = parent.parentPath) {
      if (parent.isFunction()) return false
      if (parent.isWithStatement() && child.key === 'body') return true
    }
    return false
  }
  const mark = node => { generated.add(node); return node }
  const replace = (path, node) => path.replaceWith(mark(t.inherits(node, path.node)))
  const stateFor = path => {
    for (let current = path; current !== null; current = current.parentPath) {
      const state = states.get(current.node)
      if (state !== undefined) return state
    }
  }
  const inferredCallableKey = path => {
    const owner = path.parentPath
    if (owner.isObjectProperty()) {
      if (owner.node.computed) {
        const key = t.identifier(allocate('callable_key'))
        hiddenBindings.add(key.name)
        let scope = owner.scope
        while (scope.path.isFunction() && sourceInParameters(path, scope)) scope = scope.parent
        scope.push({ id: t.cloneNode(key), kind: 'let' })
        owner.node.key = t.assignmentExpression('=', t.cloneNode(key),
          call(incoming, 'propertyKey', [owner.node.key]))
        return key
      }
      const name = owner.node.key.name ?? String(owner.node.key.value)
      return name === '__proto__' ? undefined : t.stringLiteral(name)
    }
    const target = owner.isVariableDeclarator() ? owner.node.id
      : owner.isAssignmentPattern() || owner.isAssignmentExpression() ? owner.node.left : undefined
    return t.isIdentifier(target) ? t.stringLiteral(target.name) : undefined
  }
  const isSelfBinding = binding => binding?.kind === 'local' && binding.scope.path.isFunctionExpression()
    && binding.identifier === binding.scope.path.node.id
  // Babel combines a named expression's self and same-name body declarations
  // under kind local. Recover native declaration ownership before lowering.
  const bodyKinds = new WeakMap()
  const bodyBindingKind = binding => {
    if (!isSelfBinding(binding)) return undefined
    if (!bodyKinds.has(binding)) {
      const declaration = binding.constantViolations.find(path =>
        (path.isVariableDeclarator() || path.isClassDeclaration() || path.isFunctionDeclaration())
          && path.getFunctionParent()?.scope === binding.scope
          && bindingNodes(path.node.id).some(node => node.name === binding.identifier.name))
      bodyKinds.set(binding, declaration?.isVariableDeclarator() ? declaration.parent.kind
        : declaration?.isClassDeclaration() ? 'let' : declaration?.isFunctionDeclaration() ? 'hoisted' : undefined)
    }
    return bodyKinds.get(binding)
  }
  const descriptorMap = (scope, extraArguments = false, exclude = new Set(), strictBindings = strictAt(scope.path), parametersOnly = false, origin = scope.path) => {
    const entries = Object.entries(scope.bindings).filter(([name]) => !exclude.has(name) && !hiddenBindings.has(name))
      .filter(([, binding]) => sourceBindingVisible(origin, binding))
      .filter(([, binding]) => !isSelfBinding(binding) || bodyBindingKind(binding) !== undefined)
      .filter(([, binding]) => !parametersOnly || binding.kind === 'param')
      .map(([name, binding]) => ({ physicalName: name, name, kind: bodyBindingKind(binding) ?? binding.kind, ...logicalBindings.get(name) }))
      .flatMap(binding => binding.names === undefined ? [binding] : binding.names.map(name => ({ ...binding, name })))
      .filter(binding => binding.role !== 'candidate' || candidateRegions.get(binding.physicalName)?.some(region =>
        origin.node.start >= region.start && origin.node.end <= region.end))
    if (extraArguments && !entries.some(binding => binding.name === 'arguments')) {
      entries.push({ physicalName: 'arguments', name: 'arguments', kind: 'param' })
    }
    return t.arrayExpression(entries.map(({ name, physicalName, property, kind, accessor, reference: delegated, referenceMethod }) => {
      const physical = accessor === true ? t.callExpression(t.identifier(physicalName), []) : t.identifier(physicalName)
      if (delegated === true || referenceMethod !== undefined) return t.arrayExpression([t.stringLiteral(name), t.objectExpression([
        t.objectProperty(t.identifier('kind'), t.stringLiteral(kind)),
        t.objectProperty(t.identifier('reference'), t.arrowFunctionExpression([], referenceMethod === undefined ? physical
          : call(physical, referenceMethod, [t.stringLiteral(name), t.booleanLiteral(strictBindings)]))),
      ])])
      const value = t.identifier(allocate('eval_write'))
      const target = property === undefined ? physical : member(physical, property)
      return t.arrayExpression([t.stringLiteral(name), t.objectExpression([
        t.objectProperty(t.identifier('kind'), t.stringLiteral(kind)),
        t.objectProperty(t.identifier('get'), t.arrowFunctionExpression([], t.cloneNode(target))),
        ...(name === 'arguments' && strictBindings ? [] : [
          t.objectProperty(t.identifier('set'), t.arrowFunctionExpression([value],
            t.assignmentExpression('=', t.cloneNode(target), t.cloneNode(value)))),
        ]),
      ])])
    }))
  }
  const capture = (path, state, origin = path) => {
    const scopes = []
    let rootIndex = -1
    let base = state.id
    for (const scope of sourceScopePath(path, origin)) {
      if (scope === state.boundary) break
      const plan = functionScopes.get(scope)
      if (plan?.parameters && sourceInParameters(origin, scope)) {
        base = parameterEnvironment(plan)
        break
      }
      if (cell?.nativeAwait === true && scope === programPath.scope) rootIndex = scopes.length
      scopes.push(descriptorMap(scope, false, new Set(), strictAt(scope.path), false, origin))
    }
    return scopes.length === 0 ? t.cloneNode(base)
      : call(base, 'capture', [t.arrayExpression(scopes), t.booleanLiteral(state.strict || strictAt(path)),
        ...(rootIndex < 0 ? [] : [t.numericLiteral(rootIndex)])])
  }
  const selfBindingsFor = (plan, parameters = false) => plan.selfName === undefined
    || (parameters ? plan.scope.getOwnBinding(plan.selfName)?.kind === 'param'
      : !isSelfBinding(plan.scope.getOwnBinding(plan.selfName)) || bodyBindingKind(plan.scope.getOwnBinding(plan.selfName)) !== undefined) ? undefined : t.arrayExpression([t.arrayExpression([
    t.stringLiteral(plan.selfName), t.objectExpression([
      t.objectProperty(t.identifier('kind'), t.stringLiteral('self')),
      t.objectProperty(t.identifier('get'), t.arrowFunctionExpression([], t.identifier(plan.selfName))),
    ]),
  ])])
  const parameterEnvironment = plan => call(capture(plan.path.parentPath, plan.parent, plan.path), 'parameters', [
    plan.parameterKey ?? t.identifier('arguments'), descriptorMap(plan.scope, false, new Set(), plan.state.strict, true),
    plan.arrow ? undefinedValue() : t.arrowFunctionExpression([], t.thisExpression()),
    plan.arrow ? undefinedValue() : t.arrowFunctionExpression([], t.metaProperty(t.identifier('new'), t.identifier('target'))),
    t.booleanLiteral(plan.state.strict), t.booleanLiteral(!plan.arrow),
    ...(selfBindingsFor(plan, true) === undefined ? [] : [selfBindingsFor(plan, true)]),
  ])
  const outerParameterPlan = path => {
    for (let current = path.parentPath; current !== null; current = current.parentPath) if (current.isFunction()) {
      if (!sourceInParameters(path, current.scope)) return undefined
      const plan = functionScopes.get(current.scope)
      if (plan?.parameters) return plan
    }
    return undefined
  }
  const captureCreation = path => {
    const outer = outerParameterPlan(path)
    if (outer === undefined) return undefined
    const parent = stateFor(path.parentPath)
    if (parent.creation === true) return parent
    const state = { id: t.identifier(allocate('parameter_closure')), boundary: outer.scope,
      strict: parent.strict, creation: true }
    creationPlans.push({ path, parent, state })
    hiddenBindings.add(state.id.name)
    return state
  }
  const declarationMarker = node => t.isCallExpression(node) && t.isIdentifier(node.callee)
    && logicalBindings.get(node.callee.name)?.role === 'var-reference'
  traverse(tree, {
    enter(path) {
      if (declarationMarker(path.node)) mark(path.node)
      if (path.isVariableDeclarator()) {
        const initializer = logicalBindings.get(path.node.id.name)
        if (initializer?.role === 'parameter-initializer') {
          functionScopes.get(path.getFunctionParent().scope).parameterInitializers.push({ node: path.node, name: initializer.name })
        }
      }
      if (internalDeclaration(path) || generated.has(path.node)) path.skip()
    },
    Program(path) {
      programPath = path
      const actualStrict = strict || path.node.sourceType === 'module' || path.node.directives.some(directive => directive.value.value === 'use strict')
      if (cell === undefined && !actualStrict) for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (binding.kind === 'var' || binding.kind === 'hoisted') varNames.add(name)
      }
      const id = cell === undefined ? t.identifier(allocate('eval_scope')) : incoming
      programState = { id, boundary: cell?.module === true || cell?.nativeRoot === true ? null : path.scope, strict: actualStrict }
      states.set(path.node, programState)
    },
    Function(path) {
      const owner = path.parentPath
      const physicalName = path.node.id?.name ?? (owner.isVariableDeclarator() ? owner.node.id.name : undefined)
      if (physicalName !== undefined && (hiddenBindings.has(physicalName) && !sourceInitializers.has(physicalName)
        || logicalBindings.get(physicalName)?.accessor === true)) {
        mark(path.node)
        path.skip()
        return
      }
      if (path.isFunctionDeclaration() && varNames.has(path.node.id.name) && path.parentPath.isProgram()) {
        functions.push(path)
      }
      if (annexFunctions.has(path.node)) annexPublications.push(path)
      const parent = path.isFunctionExpression() || path.isArrowFunctionExpression()
        ? captureCreation(path) ?? stateFor(path.parentPath) : stateFor(path.parentPath)
      const id = t.identifier(allocate('eval_activation'))
      const selfName = path.isFunctionExpression() && path.node.id !== null ? path.node.id.name : undefined
      const state = { id, boundary: path.scope, strict: parent.strict || strictAt(path), selfName }
      states.set(path.node.body, state)
      const plan = { path, parent, state, scope: path.scope, node: path.node, arrow: path.isArrowFunctionExpression(), selfName,
        parameterInitializers: [],
        parameters: path.node.params.some(parameter => dynamicScopeAnalysis.containsDirectEval(parameter)) }
      if (plan.parameters && plan.arrow) {
        plan.parameterKey = t.identifier(allocate('parameter_key'))
        hiddenBindings.add(plan.parameterKey.name)
        path.node.params.unshift(plan.parameterKey)
        plan.inferredKey = inferredCallableKey(path)
      }
      if (plan.parameters && path.scope.getOwnBinding('arguments')?.kind === 'param') {
        const physicalName = allocate('parameter_arguments')
        path.scope.rename('arguments', physicalName)
        logicalBindings.set(physicalName, { physicalName, name: 'arguments', kind: 'param' })
      }
      functionPlans.push(plan)
      functionScopes.set(path.scope, plan)
    },
    'ObjectExpression|ClassExpression'(path) {
      const state = captureCreation(path)
      if (state !== undefined) states.set(path.node, state)
    },
    WithStatement(path) {
      const parent = stateFor(path.parentPath)
      const id = t.identifier(allocate('with_environment'))
      const state = { id, boundary: path.scope, strict: false }
      states.set(path.node.body, state)
      withPlans.push({ path, parent, state })
    },
    VariableDeclaration(path) {
      if (path.node.kind !== 'var') return
      if (cell === undefined && path.getFunctionParent() === null && !programState.strict
        || withSensitive(path)) varDeclarations.push(path)
    },
    AssignmentExpression(path) {
      if (['=', '&&=', '||=', '??='].includes(path.node.operator) && t.isIdentifier(path.node.left)) {
        path.node.right = namedValue(path.node.left.name, path.node.right)
      }
    },
    AssignmentPattern(path) {
      if (t.isIdentifier(path.node.left)) path.node.right = namedValue(path.node.left.name, path.node.right)
    },
  })
  // Adapting an initializer does not remove its native variable declaration.
  // Keep hoisted storage for function/strict/cell owners; sloppy eval roots
  // instead publish these names through the incoming environment's varFrame.
  const nativeVars = new Map()
  for (const path of varDeclarations) {
    const owner = path.getFunctionParent() ?? programPath
    if (owner === programPath && cell === undefined && !programState.strict) continue
    const names = nativeVars.get(owner) ?? new Set()
    for (const item of path.node.declarations) for (const identifier of bindingNodes(item.id)) names.add(identifier.name)
    nativeVars.set(owner, names)
  }
  for (const [owner, names] of nativeVars) {
    const body = owner.isProgram() ? owner.node : owner.node.body
    body.body.unshift(t.variableDeclaration('var', [...names].map(name => t.variableDeclarator(t.identifier(name)))))
  }
  if (nativeVars.size > 0) programPath.scope.crawl()
  const rootVar = binding => binding !== undefined && binding.scope === programPath.scope && varNames.has(binding.identifier.name)
  const shadowedByWith = (path, binding) => {
    for (let current = path.parentPath; current !== null; current = current.parentPath) {
      if (current.node === binding?.scope.block) return false
      if (current.isWithStatement() && current.get('body').isAncestor(path)) return true
    }
    return false
  }
  const reference = (path, name, deferred = false) => call(capture(path, stateFor(path)), deferred ? 'deferredReference' : 'reference', [t.stringLiteral(name),
    ...isWrite(path) && cell?.writeTarget !== undefined ? [t.stringLiteral(cell.writeTarget(path.node))] : []])
  const lexicalContext = (path, environment) => {
    const owner = lexicalOwner(path)
    const properties = []
    if (owner !== null && !owner.isFunction()) {
      properties.push(t.objectProperty(t.identifier('getThis'), t.arrowFunctionExpression([], t.thisExpression())),
        t.objectProperty(t.identifier('getNewTarget'), t.arrowFunctionExpression([], t.metaProperty(t.identifier('new'), t.identifier('target')))),
        t.objectProperty(t.identifier('allowNewTarget'), t.booleanLiteral(true)),
        t.objectProperty(t.identifier('forbidArguments'), t.booleanLiteral(true)),
        t.objectProperty(t.identifier('strict'), t.booleanLiteral(true)))
    }
    if (owner !== null && (owner.isClassMethod() || owner.isClassPrivateMethod() || owner.isObjectMethod() || !owner.isFunction())) {
      const key = t.identifier(allocate('super_key'))
      const value = t.identifier(allocate('super_value'))
      const target = t.memberExpression(t.super(), t.cloneNode(key), true)
      properties.push(t.objectProperty(t.identifier('getSuper'), t.arrowFunctionExpression([key], t.objectExpression([
        t.objectProperty(t.identifier('get'), t.arrowFunctionExpression([], t.cloneNode(target))),
        t.objectProperty(t.identifier('set'), t.arrowFunctionExpression([value], t.assignmentExpression('=', t.cloneNode(target), t.cloneNode(value)))),
      ]))))
      if (owner.isClassMethod({ kind: 'constructor' }) && owner.parentPath.parentPath.node.superClass !== null) {
        const args = t.identifier(allocate('super_arguments'))
        properties.push(t.objectProperty(t.identifier('callSuper'), t.arrowFunctionExpression([t.restElement(args)],
          t.callExpression(t.super(), [t.spreadElement(call(t.cloneNode(environment, true), 'internalArray', [t.cloneNode(args)]))]))))
      }
    }
    const visiblePrivate = new Map()
    for (let current = path.parentPath; current !== null; current = current.parentPath) if (current.isClass()) {
      const physicalNames = new Set(current.node.body.body.filter(item => t.isPrivateName(item.key)).map(item => item.key.id.name))
      for (const group of cell?.privateBindings ?? []) {
        for (const name of group.hiddenNames ?? []) physicalNames.delete(name)
        for (const binding of group.names) {
          if (!binding.targets.some(target => physicalNames.has(target.physicalName))) continue
          if (!visiblePrivate.has(binding.name)) visiblePrivate.set(binding.name, { bridgeExpression: binding.bridgeExpression })
          for (const target of binding.targets) physicalNames.delete(target.physicalName)
        }
      }
      for (const name of physicalNames) if (!visiblePrivate.has(name)) {
        visiblePrivate.set(name, { physicalName: name })
      }
    }
    if (visiblePrivate.size > 0) properties.push(t.objectProperty(t.identifier('privateReferences'), t.objectExpression([...visiblePrivate].map(([name, { physicalName, bridgeExpression }]) => {
      const receiver = t.identifier(allocate('private_receiver'))
      const value = t.identifier(allocate('private_value'))
      if (bridgeExpression !== undefined) {
        // The scope normalizer owns logical private member selection, names,
        // and write rules. Retain its adapter in the original class context.
        const bridge = parseExpression(bridgeExpression, { errorRecovery: true })
        const access = () => member(t.callExpression(t.cloneNode(bridge), [t.cloneNode(receiver)]), 'v')
        return t.objectProperty(t.stringLiteral(name), t.arrowFunctionExpression([receiver], t.objectExpression([
          t.objectProperty(t.identifier('get'), t.arrowFunctionExpression([], access())),
          t.objectProperty(t.identifier('set'), t.arrowFunctionExpression([value], t.assignmentExpression('=', access(), t.cloneNode(value)))),
          t.objectProperty(t.identifier('has'), t.arrowFunctionExpression([], t.callExpression(t.cloneNode(bridge), [
            t.cloneNode(receiver), t.booleanLiteral(false), t.booleanLiteral(true),
          ]))),
        ])))
      }
      const key = t.privateName(t.identifier(physicalName))
      const target = t.memberExpression(t.cloneNode(receiver), t.cloneNode(key))
      return t.objectProperty(t.stringLiteral(name), t.arrowFunctionExpression([receiver], t.objectExpression([
        t.objectProperty(t.identifier('get'), t.arrowFunctionExpression([], t.cloneNode(target))),
        t.objectProperty(t.identifier('set'), t.arrowFunctionExpression([value], t.assignmentExpression('=', t.cloneNode(target), t.cloneNode(value)))),
        t.objectProperty(t.identifier('has'), t.arrowFunctionExpression([], t.binaryExpression('in', key, t.cloneNode(receiver)))),
      ])))
    }))))
    return properties.length === 0 ? environment : call(environment, 'context', [t.objectExpression(properties)])
  }
  const replaceReference = (path, resolved, optional = false) => {
    const callable = ((path.parentPath.isCallExpression() || path.parentPath.isOptionalCallExpression()) && path.key === 'callee')
      || path.parentPath.isTaggedTemplateExpression() && path.key === 'tag'
    replace(path, operations.value(optional ? t.optionalMemberExpression(resolved, t.identifier(callable ? 'callee' : 'value'), false, true)
      : member(resolved, callable ? 'callee' : 'value')))
    path.skip()
  }
  // Marker callbacks address compiler-owned storage. Expand them with their
  // actual source environment while keeping that storage out of user lookup.
  traverse(tree, { CallExpression(path) {
    if (!declarationMarker(path.node)) return
    replace(path, call(capture(path, stateFor(path)), 'withReference', path.node.arguments))
    path.skip()
  } })
  traverse(tree, {
    enter(path) {
      if (generated.has(path.node) || path.isTSType()
        || internalDeclaration(path)
        || cell !== undefined && path.isVariableDeclarator() && path.node.id.name === environmentName) path.skip()
    },
    CallExpression: { exit(path) {
      if (cell === undefined && path.node.callee.type === 'Import') {
        replace(path, call(stateFor(path).id, 'importModule', path.node.arguments))
        return
      }
      if (!t.isIdentifier(path.node.callee, { name: 'eval' })) return
      const state = stateFor(path)
      const callee = call(capture(path, state), 'reference', [t.stringLiteral('eval')])
      const invocationOrigin = callOrigin(path.node)
      const origin = invocationOrigin.target
      const environment = lexicalContext(path, origin === undefined ? capture(path, state) : call(capture(path, state), 'at', [t.stringLiteral(origin)]))
      replace(path, t.callExpression(t.callExpression(member(callee, 'evalInvocation'), [environment,
        t.arrayExpression(path.node.arguments), t.valueToNode(invocationOrigin)]), []))
      path.skip()
    } },
    'TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion': { exit(path) {
      // These wrappers have no runtime operation. Erase them after reference
      // ownership has been resolved, before code generation changes precedence.
      path.replaceWith(path.node.expression)
    } },
    'MemberExpression|OptionalMemberExpression': { exit(path) {
      if (externalPrivate.has(path.node.property.start)) {
        const resolved = call(stateFor(path).id, 'privateReference', [t.stringLiteral(path.node.property.id.name), path.node.object,
          t.booleanLiteral(path.node.optional === true)])
        replaceReference(path, resolved, path.node.optional === true)
      } else if (t.isSuper(path.node.object) && lexicalOwner(path) === null) {
        const resolved = call(stateFor(path).id, 'superReference', [path.node.computed ? path.node.property : t.stringLiteral(path.node.property.name)])
        replaceReference(path, resolved)
      }
    } },
    BinaryExpression: { exit(path) {
      if (path.node.operator !== 'in' || !t.isPrivateName(path.node.left) || !externalPrivate.has(path.node.left.start)) return
      replace(path, call(stateFor(path).id, 'privateHas', [t.stringLiteral(path.node.left.id.name), path.node.right]))
      path.skip()
    } },
    Super(path) {
      if (lexicalOwner(path) !== null || !path.parentPath.isCallExpression()) return
      if (!allowSuperCall) throw new SyntaxError('super() is only valid in a derived constructor')
      replace(path, member(stateFor(path).id, 'superCall'))
      path.skip()
    },
    Identifier(path) {
      if (path.parentPath.isCallExpression() && path.key === 'callee' && path.node.name === 'eval') return
      if (!path.isReferencedIdentifier() && !isWrite(path)) return
      // Physical cells and private helpers are compiler-owned lexical names.
      // The normalizer leaves original with-visible references for this pass.
      if (hiddenBindings.has(path.node.name) || logicalBindings.has(path.node.name)) return
      if (forbidArguments && path.node.name === 'arguments' && lexicalOwner(path) === null) throw new SyntaxError("'arguments' is not allowed in class field initializer or static initialization block")
      const binding = sourceBinding(path, path.node.name)
      const state = stateFor(path)
      const selfReference = isSelfBinding(binding) && (bodyBindingKind(binding) === undefined || sourceInParameters(path, binding.scope))
      const awaitRootBinding = cell?.nativeAwait === true && binding?.scope === programPath.scope
      const withShadow = shadowedByWith(path, binding)
      if (binding !== undefined && !rootVar(binding) && !awaitRootBinding && !withShadow
        && !dynamicScopeAnalysis.mayEvalShadow(path, binding.scope.block, selfReference)) return
      if (path.node.name === 'arguments') {
        const fn = path.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression())
        if (fn !== null && !functionScopes.get(fn.scope)?.parameters && !shadowedByWith(path, { scope: fn.scope })) return
      }
      const deferred = isWrite(path)
        && (withShadow || dynamicScopeAnalysis.mayEvalShadow(path, binding?.scope.block, selfReference))
      const resolved = reference(path, path.node.name, deferred)
      if (path.parentPath.isUnaryExpression({ operator: 'typeof' })) {
        replace(path.parentPath, call(resolved, 'typeof'))
        path.parentPath.skip()
      } else if (path.parentPath.isUnaryExpression({ operator: 'delete' })) {
        replace(path.parentPath, call(resolved, 'delete'))
        path.parentPath.skip()
      } else {
        const callable = ((path.parentPath.isCallExpression() || path.parentPath.isOptionalCallExpression()) && path.key === 'callee')
          || path.parentPath.isTaggedTemplateExpression() && path.key === 'tag'
        if (path.parentPath.isObjectProperty() && path.parent.shorthand) {
          path.parent.shorthand = false
          path.parent.computed = true
          path.parent.key = t.stringLiteral(path.node.name)
        }
        replace(path, operations.value(member(resolved, callable ? 'callee' : 'value')))
        path.skip()
      }
    },
    ThisExpression(path) {
      if (cell !== undefined) return
      const fn = lexicalOwner(path)
      if (fn !== null) return
      replace(path, operations.value(call(stateFor(path).id, 'thisValue')))
      path.skip()
    },
    MetaProperty(path) {
      if (cell !== undefined) return
      if (path.node.meta.name !== 'new' || path.node.property.name !== 'target') return
      const fn = lexicalOwner(path)
      if (fn !== null) return
      replace(path, operations.value(call(stateFor(path).id, 'newTarget')))
      path.skip()
    },
  })
  if (cell?.nativeAwait === true) rewriteNativeAwaitDeclarations(tree, {
    hiddenBindings, nativePlaceholders, namedValue,
    replaceIterationDeclaration: (path, target, initializers) => replaceIterationDeclaration(path, target, initializers, allocate, true),
    reference: (path, name) => member(reference(path, name), 'value'),
    initialize: (path, name, value) => call(capture(path, stateFor(path)), 'initialize', [t.stringLiteral(name), value]),
  })
  for (const plan of creationPlans) plan.environment = capture(plan.path.parentPath, plan.parent, plan.path)
  for (const path of varDeclarations.reverse()) {
    const redirectPattern = node => {
      if (t.isIdentifier(node)) return member(call(capture(path, stateFor(path)), 'deferredReference', [t.stringLiteral(node.name)]), 'value')
      if (t.isArrayPattern(node)) return t.arrayPattern(node.elements.map(element => element === null ? null : redirectPattern(element)))
      if (t.isObjectPattern(node)) return t.objectPattern(node.properties.map(property => t.isRestElement(property)
        ? t.restElement(redirectPattern(property.argument))
        : t.objectProperty(property.key, redirectPattern(property.value), property.computed, false)))
      if (t.isAssignmentPattern(node)) return t.assignmentPattern(redirectPattern(node.left),
        t.isIdentifier(node.left) ? namedValue(node.left.name, node.right) : node.right)
      return t.restElement(redirectPattern(node.argument))
    }
    const expressions = path.node.declarations.filter(item => item.init !== null)
      .map(item => t.isIdentifier(item.id)
        ? call(capture(path, stateFor(path)), 'initialize', [t.stringLiteral(item.id.name), namedValue(item.id.name, item.init)])
        : t.assignmentExpression('=', redirectPattern(item.id), item.init))
    if (path.parentPath.isForOfStatement() || path.parentPath.isForInStatement()) {
      replaceIterationDeclaration(path, redirectPattern(path.node.declarations[0].id), expressions, allocate)
    } else if (path.parentPath.isForStatement()) {
      path.replaceWith(expressions.length === 0 ? t.unaryExpression('void', t.numericLiteral(0)) : t.sequenceExpression(expressions))
    } else path.replaceWith(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(allocate('eval_declaration')),
      expressions.length === 0 ? null : t.sequenceExpression(expressions))]))
  }
  for (const plan of functionPlans.reverse()) {
    const { path, parent, state, scope, node, arrow } = plan
    let parentEnvironment = plan.parameters ? parameterEnvironment(plan) : capture(path.parentPath, parent, path)
    const setup = []
    const nativeArguments = !arrow && scope.getOwnBinding('arguments')?.kind === 'var'
    if (plan.parameters && (nativeArguments || plan.parameterInitializers.length > 0)) {
      const parameterFrame = t.identifier(allocate('parameter_frame'))
      setup.push(t.variableDeclaration('const', [t.variableDeclarator(parameterFrame, parentEnvironment)]))
      if (nativeArguments) setup.push(t.expressionStatement(t.assignmentExpression('=', t.identifier('arguments'),
          member(call(parameterFrame, 'reference', [t.stringLiteral('arguments')]), 'value'))))
      for (const initializer of plan.parameterInitializers) {
        initializer.node.init = member(call(parameterFrame, 'reference', [t.stringLiteral(initializer.name)]), 'value')
      }
      parentEnvironment = parameterFrame
    }
    const activationBindings = descriptorMap(scope, !arrow && !plan.parameters, new Set(), state.strict)
    const selfBindings = plan.parameters ? undefined : selfBindingsFor(plan)
    const activation = call(parentEnvironment, 'activation', [activationBindings,
      arrow ? undefinedValue() : t.arrowFunctionExpression([], t.thisExpression()),
      arrow ? undefinedValue() : t.arrowFunctionExpression([], t.metaProperty(t.identifier('new'), t.identifier('target'))),
      t.booleanLiteral(state.strict), t.booleanLiteral(!arrow), ...(selfBindings === undefined ? [] : [selfBindings])])
    const declaration = t.variableDeclaration('const', [t.variableDeclarator(t.cloneNode(state.id), activation)])
    if (node.body.type === 'BlockStatement') node.body.body.unshift(...setup, declaration)
    else node.body = t.blockStatement([declaration, t.returnStatement(node.body)])
    if (plan.parameters && arrow) {
      // Arrow-internal comments include source identity marks. Babel would
      // inherit them onto the replacement call, outside the actual callable.
      if (node.innerComments !== undefined) {
        t.addComments(node.body.body[0], 'leading', node.innerComments)
        delete node.innerComments
      }
      path.replaceWith(call(capture(path.parentPath, parent), 'parameterArrow', [
        plan.inferredKey === undefined ? node : namedValue(plan.inferredKey, node)]))
    }
  }
  for (const { path, parent, state } of withPlans.reverse()) {
    const initialization = call(capture(path, parent), 'withObject', [path.node.object])
    path.replaceWith(t.blockStatement([
      t.variableDeclaration('const', [t.variableDeclarator(t.cloneNode(state.id), initialization)]), path.node.body,
    ]))
  }
  for (const path of annexPublications) path.insertAfter(t.variableDeclaration('const', [
    t.variableDeclarator(t.identifier(allocate('eval_function')), call(incoming, 'initializeEvalFunction', [
      t.stringLiteral(path.node.id.name), t.identifier(path.node.id.name),
    ])),
  ]))
  const functionValues = new Map()
  for (const path of functions) {
    const node = path.node
    const name = node.id.name
    const expression = t.functionExpression(null, node.params, node.body, node.generator, node.async)
    const named = namedValue(name, expression)
    functionValues.set(name, named)
    path.replaceWith(t.emptyStatement())
  }
  for (const { path, environment, state } of creationPlans.reverse()) {
    let value = path.node
    if (t.isArrowFunctionExpression(value) || (t.isFunctionExpression(value) || t.isClassExpression(value)) && value.id === null) {
      const key = inferredCallableKey(path)
      if (key !== undefined) value = namedValue(key, value)
    }
    path.replaceWith(t.callExpression(t.arrowFunctionExpression([state.id], value), [environment]))
  }
  if (cell === undefined) {
    const initializers = varNames.size === 0 ? [] : [t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier(allocate('eval_declarations')), call(incoming, 'initializeEvalDeclarations', [
        t.arrayExpression([...varNames].map(name => t.arrayExpression([t.stringLiteral(name),
          ...(functionValues.has(name) ? [functionValues.get(name), t.booleanLiteral(true)] : [])]))),
      ])),
    ])]
    const captureRoot = call(incoming, 'capture', [t.arrayExpression([descriptorMap(programPath.scope, false, varNames)]), t.booleanLiteral(programState.strict)])
    tree.program.body.unshift(t.variableDeclaration('const', [t.variableDeclarator(t.cloneNode(programState.id), captureRoot)]), ...initializers)
  }
  if (strict && !tree.program.directives.some(directive => directive.value.value === 'use strict')) {
    tree.program.directives.unshift(t.directive(t.directiveLiteral('use strict')))
  }
  operations.generated(tree)
  for (const name of hiddenBindings) operations.internal.add(name)
  rewriteNativeCalls(tree, incoming, {
    operations, allocate,
    origin: callOrigin,
    skip: path => nativePlaceholders.has(path.node) || t.isFunction(path.node) && generated.has(path.node)
      || internalDeclaration(path),
  })
  const result = transformFromAstSync(tree, source, { babelrc: false, configFile: false, browserslistConfigFile: false, sourceMaps: true,
    cloneInputAst: false, generatorOpts: { compact: cell?.compactOutput === true } })
  return { code: result.code, sourceMap: result.map, environmentName, varNames: [...varNames],
    callableSources: marked === undefined ? [] : collectCallableSources(result.code, marked.callableSources, parserOptions) }
}
