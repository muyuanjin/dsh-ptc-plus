import { commonJsCompilerImport, commonJsCompilerGlobals } from './compiler-module-links.js'
import { compilerStorageSource } from './compiler-storage-source.js'
import { compilerDescriptorSource } from './compiler-descriptors.js'
import { privateGeneratedRecords } from './compiler-record-roles.js'
import { lowerResourceOperations } from './compiler-resource-lowering.js'
import { callableDefinitionOwner, closeDefinitionExpression } from './callable-definition-environment.js'
/** Build logical binding identities from recovered syntax and Babel scope facts. */
import { parse } from '@babel/parser'
import traverseImport from '@babel/traverse'
import { SourceMap } from 'node:module'
import loadTypeScript from './compiler-typescript.cjs'
import { fileURLToPath } from 'node:url'
import { transformSync, transformFromAstSync, types as babelTypes } from '@babel/core'
import decoratorTransform from '@babel/plugin-proposal-decorators'
import typescriptTransform from '@babel/plugin-transform-typescript'
import resourceTransform from '@babel/plugin-transform-explicit-resource-management'
import generatorImport from '@babel/generator'
import { injectInitialization } from '@babel/helper-create-class-features-plugin'
import * as legacyDecoratorHelpers from 'tslib'
import { bindingNodes, createGeneratedNameAllocator } from './binding-pattern.js'
import { applySourceEdits, identitySourceMap, mappedSourceTransform, mapSourcePosition } from './source-position-map.js'
import { supportsNativeUsing, transformTypeScriptSource } from './typescript-transform.js'
import { createDynamicScopeAnalysis, varInitializerTarget } from './dynamic-scope-analysis.js'
import { visitSource } from './compiler-source-regions.js'
import { analyzeSourceDeclarations, resolveSourceBinding, COMMONJS_PARAMETERS } from './compiler-scope-facts.js'
import { callableMarkerPosition } from './callable-source-facts.js'
import { createSourcePieces } from './compiler-source-pieces.js'
import { indexSourceRegions, validateRegionSource, sourceFeatures } from './compiler-region-output.js'

export const CELL_PARSER_PLUGINS = ['typescript', 'importAttributes', 'decorators', 'decoratorAutoAccessors']

/** Babel parse errors the stateful cell compiler recovers from by design. */
export const RECOVERABLE_CELL_PARSE_ERRORS = new Set(['VarRedeclaration', 'DeclarationMissingInitializer',
  'DuplicateExport', 'DuplicateDefaultExport', 'UnexpectedUsingDeclaration'])

const PARSER_OPTIONS = {
  sourceType: 'script',
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  allowUndeclaredExports: true,
  plugins: CELL_PARSER_PLUGINS,
}

const parserOptionsForTarget = target => ({ ...PARSER_OPTIONS,
  sourceType: target === 'module' || target === 'reflection-module' ? 'module' : target === 'commonjs' ? 'commonjs' : 'script',
  ...(target === 'commonjs' ? { allowAwaitOutsideFunction: undefined, allowReturnOutsideFunction: undefined } : {}),
})

const LOOP_HEADS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement'])

function isFunctionNode(node) {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression' || node.type === 'ObjectMethod'
    || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod'
}

function eachNode(root, visit) {
  babelTypes.traverseFast(root, visit)
}

function parseRecovered(code) {
  return parse(code, { ...PARSER_OPTIONS, errorRecovery: true }).program
}

function singleStatementBodies(program) {
  const bodies = new Map()
  eachNode(program, (node) => {
    if (node.type === 'IfStatement') {
      if (node.consequent !== null) bodies.set(node.consequent, node)
      if (node.alternate !== null) bodies.set(node.alternate, node)
      return
    }
    if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement'
      || LOOP_HEADS.has(node.type) || node.type === 'WithStatement' || node.type === 'LabeledStatement') {
      bodies.set(node.body, node)
    }
  })
  return bodies
}

/**
 * A function declaration written as the body of an `if`, loop, `with`, or `do`
 * statement is the Annex B single-statement form, which the language defines as
 * if it were written in a block.  Writing that block keeps the declaration's own
 * binding: without it, the parser's scope analysis reads the declaration as a
 * var collision with an enclosing lexical and rejects a cell the language runs.
 * A labelled function declaration hoists into the enclosing scope instead, so it
 * is not this form and stays as written.
 */
function annexBBlockEdits(program) {
  const bodies = singleStatementBodies(program)
  const edits = []
  for (const [body, statement] of bodies) {
    if (body.type !== 'FunctionDeclaration' || statement.type === 'LabeledStatement') continue
    edits.push({ start: body.start, end: body.start, text: '{' })
    edits.push({ start: body.end, end: body.end, text: '}' })
  }
  return edits
}

const traverseScopes = traverseImport.default ?? traverseImport
const generate = generatorImport.default ?? generatorImport

/** Owned entries obtain compiler operations from their prepared realm. Source
 * bindings and mutable constructor properties never select helper authority. */
function intrinsicBootstrap(name, target, intrinsicContext) {
  if (intrinsicContext) {
    intrinsicContext.bindings.add(name)
    return `const ${name}=(${intrinsicContext.expression ?? 'void 0'});\n`
  }
  if (target === 'module') return `import {moduleBindingIntrinsics as ${name}} from ${JSON.stringify(new URL('./stateful-module-runtime.js', import.meta.url).href)};\n`
  if (target === 'commonjs') return `const ${name}=${commonJsCompilerImport(new URL('./compiler-intrinsics.js', import.meta.url))}.moduleCompilerIntrinsics;\n`
  return `const ${name}=(()=>{const native=(function(){}).constructor("return {WeakMap,WeakSet,Reflect,Promise,Array,Function,SuppressedError:typeof SuppressedError==='function'?SuppressedError:void 0}")(),object=(${compilerDescriptorSource})(({}).constructor,native.Reflect).Object;let typeError,referenceError;try{null.x}catch(error){typeError=error.constructor}try{const value=value}catch(error){referenceError=error.constructor}return {Object:object,WeakMap:native.WeakMap,WeakSet:native.WeakSet,Reflect:{apply:(function(){}).call.bind((function(){}).apply),get decorate(){return native.Reflect.decorate}},TypeError:typeError,ReferenceError:referenceError,Error:object.getPrototypeOf(typeError),Symbol:object.getOwnPropertySymbols([].constructor.prototype)[0].constructor,String:''.constructor,Number:(0).constructor,Promise:{resolve:native.Promise.resolve.bind(native.Promise),reject:native.Promise.reject.bind(native.Promise)},SuppressedError:native.SuppressedError,...(${compilerStorageSource})(object,native.WeakMap,native.WeakSet,object.getOwnPropertySymbols([].constructor.prototype)[0].constructor,native.Promise,native.Reflect,native.Array,native.Function.prototype)}})();\n`
}

/** Resolve only compiler-recorded bootstrap declarations after the root frame
 * has an execution owner. User declarations never select this private input. */
export function bindCompilerIntrinsics(result, intrinsicContext) {
  if (intrinsicContext.bindings.size === 0) return result
  const edits = []
  eachNode(parseRecovered(result.code), node => {
    if (node.type !== 'VariableDeclarator' || !intrinsicContext.bindings.has(node.id.name)) return
    edits.push({ start: node.init.start, end: node.init.end, text: `(${intrinsicContext.expression})` })
  })
  return { ...result, ...applySourceEdits(result.code, result.sourceMap, edits) }
}

function mappedTransform(code, sourceMap, transformed) {
  return mappedSourceTransform(code, sourceMap, transformed)
}

const TRANSPARENT_NAME_PARENTS = new Set(['ParenthesizedExpression', 'TSAsExpression',
  'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion'])

/** Native name inference sees through parentheses and type-only wrappers. */
function namedExpressionPath(path) {
  while (path.parentPath && TRANSPARENT_NAME_PARENTS.has(path.parent.type)) path = path.parentPath
  return path
}

/** Definition regions have no callable body scope. Give each class evaluation
 * a lexical frame before Babel assigns decorator initialization helpers. */
function isolateDefinitionClassEvaluations(file, allocate, intrinsics) {
  const visited = new WeakSet()
  // A computed field key is coerced once per class evaluation while its field value is created per
  // instance. The key therefore travels through a parameter of the containing class's own frame,
  // instead of shared storage that a later evaluation or a detached callable would overwrite or miss.
  const capturedKeys = new Map()
  file.path.traverse({ ClassExpression: { exit(path) {
    const node = path.node
    if (visited.has(node)) return
    visited.add(node)
    const captured = capturedKeys.get(node) ?? []
    const decorated = Boolean(node.decorators?.length
      || node.body.body.some(member => member.decorators?.length || member.type === 'ClassAccessorProperty'))
    if (!decorated && captured.length === 0) return
    const expression = namedExpressionPath(path)
    const parent = expression.parent
    const field = ['ClassProperty', 'ClassPrivateProperty', 'ClassAccessorProperty'].includes(parent.type)
    const propertyValue = expression.key === 'value' && (parent.type === 'ObjectProperty' || field)
    if (node.id === null && propertyValue && parent.type === 'ObjectProperty' && parent.computed) {
      // Coerce the original key before entering the definition frame. Its own
      // data property carries the exact string/symbol without a shared cache.
      const record = babelTypes.identifier(allocate('decorated_class_key_object'))
      const key = babelTypes.identifier(allocate('decorated_class_key'))
      const nativeObject = babelTypes.memberExpression(babelTypes.identifier(intrinsics), babelTypes.identifier('Object'))
      const keys = method => babelTypes.memberExpression(babelTypes.callExpression(
        babelTypes.memberExpression(nativeObject, babelTypes.identifier(method)), [record]), babelTypes.numericLiteral(0), true)
      const declaration = babelTypes.variableDeclaration('const', [babelTypes.variableDeclarator(key,
        babelTypes.objectExpression([babelTypes.objectProperty(babelTypes.identifier('value'),
          babelTypes.logicalExpression('??', keys('getOwnPropertyNames'), keys('getOwnPropertySymbols')))]))])
      const namedKey = babelTypes.memberExpression(babelTypes.cloneNode(key), babelTypes.identifier('value'))
      const value = babelTypes.objectExpression([babelTypes.objectProperty(namedKey, expression.node, true)])
      expression.parentPath.replaceWith(babelTypes.spreadElement(closeDefinitionExpression([declaration], value, [record, ...captured], [
        babelTypes.objectExpression([babelTypes.objectProperty(parent.key, babelTypes.numericLiteral(0), true)]),
      ])))
      return
    }
    // Definition regions have no enclosing callable scope to host the frame, so the owner gate
    // selects them. An anonymous decorated class needs that frame for its inferred name and for a
    // computed field value's per-evaluation key wherever the class expression appears.
    if (!callableDefinitionOwner(path) && captured.length === 0
      && !(node.id === null && decorated && (!propertyValue || field))) return
    let name
    if (node.id === null) {
      name = babelTypes.stringLiteral('')
      if (expression.key === 'right' && (parent.type === 'AssignmentPattern' || parent.type === 'AssignmentExpression')
        && parent.left.type === 'Identifier') {
        name = babelTypes.stringLiteral(parent.left.name)
      } else if (expression.key === 'init' && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        name = babelTypes.stringLiteral(parent.id.name)
      } else if (propertyValue) {
        if (!parent.computed) {
          const key = parent.key.type === 'PrivateName' ? '#' + parent.key.id.name : parent.key.name ?? String(parent.key.value)
          if (parent.type !== 'ObjectProperty' || key !== '__proto__') name = babelTypes.stringLiteral(key)
        } else {
          const key = babelTypes.identifier(allocate('decorated_class_key'))
          const object = babelTypes.identifier(allocate('decorated_class_key_object'))
          const nativeObject = babelTypes.memberExpression(babelTypes.identifier(intrinsics), babelTypes.identifier('Object'))
          const keys = method => babelTypes.memberExpression(babelTypes.callExpression(
            babelTypes.memberExpression(nativeObject, babelTypes.identifier(method)), [object]), babelTypes.numericLiteral(0), true)
          const convert = babelTypes.arrowFunctionExpression([object], babelTypes.logicalExpression('??', keys('getOwnPropertyNames'), keys('getOwnPropertySymbols')))
          parent.key = babelTypes.assignmentExpression('=', key, babelTypes.callExpression(convert,
            [babelTypes.objectExpression([babelTypes.objectProperty(parent.key, babelTypes.numericLiteral(0), true)])]))
          const containing = expression.parentPath.findParent(path => path.isClass()).node
          capturedKeys.set(containing, [...(capturedKeys.get(containing) ?? []), babelTypes.cloneNode(key)])
          name = babelTypes.cloneNode(key)
        }
      }
    }
    const parameter = name !== undefined && !babelTypes.isStringLiteral(name)
      ? babelTypes.identifier(allocate('decorated_class_name')) : undefined
    const key = parameter === undefined ? name : babelTypes.memberExpression(parameter, babelTypes.identifier('value'))
    const value = name === undefined ? node : babelTypes.memberExpression(babelTypes.objectExpression([
      babelTypes.objectProperty(babelTypes.cloneNode(key), node, true),
    ]), babelTypes.cloneNode(key), true)
    path.replaceWith(closeDefinitionExpression([], value,
      [...(parameter === undefined ? [] : [parameter]), ...captured], parameter === undefined ? [] : [
        babelTypes.objectExpression([babelTypes.objectProperty(babelTypes.identifier('value'), name)]),
      ]))
  } } })
}

/** Give potentially colliding public methods distinct physical keys. Babel then
 * decorates every original descriptor, and the first class decorator publishes
 * their final descriptors in source order before user class decorators run. */
function computedDecoratorMembers(helper, allocate, intrinsics, lazy = false) {
  const access = name => babelTypes.memberExpression(lazy
    ? babelTypes.callExpression(babelTypes.identifier(helper), []) : babelTypes.identifier(helper), babelTypes.identifier(name))
  const wrap = expression => {
    if (expression.type !== 'MemberExpression') return babelTypes.callExpression(access('wrap'), [expression])
    const receiver = babelTypes.identifier(allocate('computed_decorator_receiver'))
    const key = babelTypes.identifier(allocate('computed_decorator_key'))
    return babelTypes.callExpression(babelTypes.arrowFunctionExpression([receiver, key],
      babelTypes.callExpression(access('wrap'), [babelTypes.memberExpression(receiver, key, true), receiver])),
    [expression.object, expression.computed ? expression.property : babelTypes.stringLiteral(expression.property.name)])
  }
  return () => ({ pre(file) {
    isolateDefinitionClassEvaluations(file, allocate, intrinsics)
    file.path.traverse({ ObjectProperty(path) {
      const {node}=path
      let value=node.value
      while((value.type.startsWith('TS')||value.type==='ParenthesizedExpression')&&value.expression) value=value.expression
      if(node.computed||value.type!=='ClassExpression'||value.id!==null
        ||!value.decorators?.length&&!value.body.body.some(member=>member.decorators?.length)) return
      const name=node.key.name??String(node.key.value)
      if(name==='__proto__') return
      node.key=babelTypes.stringLiteral(name)
      node.computed=true
    } })
    file.scope.crawl()
  }, visitor: { Class(path) {
    const members = path.node.body.body.filter(member => member.type === 'ClassMethod' && member.kind !== 'constructor')
    if (members.length < 2 || !members.some(member => member.computed)
      || !members.some(member => member.decorators?.length)) return
    for (const member of members) {
      const key = member.computed ? member.key : babelTypes.stringLiteral(member.key.name ?? String(member.key.value))
      member.key = babelTypes.callExpression(access('key'), [key,
        babelTypes.stringLiteral(member.kind), babelTypes.booleanLiteral(member.static)])
      member.computed = true
      member.decorators = [...(member.decorators ?? []).map(decorator => babelTypes.decorator(wrap(decorator.expression))),
        babelTypes.decorator(access('prepare'))]
    }
    path.node.decorators = [...path.node.decorators ?? [], babelTypes.decorator(access('publish'))]
  } } })
}

function computedDecoratorBootstrap(helper, intrinsics, storage) {
  return `${storage ? `var ${storage};function ${helper}(){return ${storage}??=` : `const ${helper}=`}(()=>{const O=${intrinsics}.Object,records=${intrinsics}.weakMapStore();const display=name=>typeof name==="symbol"?(${intrinsics}.symbolDescription(name)===void 0?"":"["+${intrinsics}.symbolDescription(name)+"]"):name;return {
    key(value,kind,isStatic){const object={[value]:0},name=O.getOwnPropertyNames(object)[0]??O.getOwnPropertySymbols(object)[0];if(isStatic&&name==="prototype")throw new ${intrinsics}.TypeError("Classes may not have a static property named prototype");const symbol=${intrinsics}.Symbol();records.set(symbol,{name,kind});return symbol},
    prepare(value,context){const record=records.get(context.name);O.defineProperty(value,"name",{value:(record.kind==="get"?"get ":record.kind==="set"?"set ":"")+display(record.name),configurable:true})},
    wrap(decorator,receiver){return function(value,context){const name=records.get(context.name).name;context.name=name;context.access={has:object=>name in object,...(context.kind==="setter"?{}:{get:object=>object[name]}),...(context.kind==="method"||context.kind==="getter"?{}:{set:(object,value)=>{object[name]=value}})};return ${intrinsics}.Reflect.apply(decorator,receiver,[value,context])}},
    publish(C){for(const target of ${intrinsics}.array([C,C.prototype]))for(const symbol of ${intrinsics}.array(O.getOwnPropertySymbols(target))){const record=records.get(symbol);if(!record)continue;const descriptor=O.getOwnPropertyDescriptor(target,symbol);if(record.kind==="get"||record.kind==="set"){const previous=O.getOwnPropertyDescriptor(target,record.name);const other=record.kind==="get"?"set":"get";descriptor[other]=previous?.[other]}O.defineProperty(target,record.name,descriptor);delete target[symbol];records.delete(symbol)}return C}
  }})();${storage ? '}' : ''}\n`
}

/** Lowerers supply helper and source provenance; this pass captures generated
 * operations. Source nodes retain their locations and never enter this visitor's
 * adaptation, even inside generated calls. Both lowerers consume one contract. */
function generatedHelperOperations(intrinsics, intrinsicNames, { arrays = true, records } = {}) {
  const operation = name => babelTypes.memberExpression(babelTypes.identifier(intrinsics), babelTypes.identifier(name))
  const functionOperations = { call: 'functionCall', apply: 'functionApply', bind: 'functionBind' }
  const invocationTarget = node => babelTypes.isMemberExpression(node) && !node.computed && !node.loc
    && Object.hasOwn(functionOperations, node.property.name) ? operation(functionOperations[node.property.name]) : node
  return {
    ObjectExpression: { exit(path) {
      if (!records?.has(path.node)) return
      path.replaceWith(babelTypes.callExpression(operation('record'), [path.node]))
      path.skip()
    } },
    ArrayExpression: { exit(path) {
      if (path.node.loc || !arrays) return
      path.replaceWith(babelTypes.callExpression(operation('array'), [path.node]))
      path.skip()
    } },
    CallExpression: { exit(path) {
      const callee = path.node.callee
      if (path.node.loc || !babelTypes.isMemberExpression(callee) || callee.computed) return
      const kind = callee.property.name
      if (Object.hasOwn(functionOperations, kind)) {
        const [receiver, ...args] = kind === 'bind' ? [callee.object, ...path.node.arguments] : path.node.arguments
        const target = kind === 'bind' ? operation('functionBind') : invocationTarget(callee.object)
        const argumentList = kind === 'apply' ? args[0] : babelTypes.arrayExpression(args)
        path.replaceWith(babelTypes.callExpression(babelTypes.memberExpression(operation('Reflect'),
          babelTypes.identifier('apply')), [target, invocationTarget(receiver), argumentList]))
      } else return
      path.skip()
    } },
    Identifier(path) {
      if (path.node.loc || !intrinsicNames.has(path.node.name) || !path.isReferencedIdentifier()) return
      path.replaceWith(operation(path.node.name))
      path.skip()
    },
  }
}

/** The maintained helper accepts a scalar-or-list member decorator slot.
 * Normalize that union at emission: source values are elements, and only
 * generated arrays (including memoized ones) carry the private list role. */
function normalizeGeneratedDecoratorLists(file) {
  const helper = file.declarations.applyDecs2311
  if (helper === undefined) return
  const isList = (path, seen = new Set()) => {
    if (!path.node || path.node.loc || seen.has(path.node)) return false
    if (path.isArrayExpression()) return true
    if (!path.isIdentifier()) return false
    seen.add(path.node)
    const binding = path.scope.getBinding(path.node.name)
    if (binding === undefined) return false
    const values = []
    if (binding.path.isVariableDeclarator() && binding.path.node.init) values.push(binding.path.get('init'))
    for (const write of binding.constantViolations) if (write.isAssignmentExpression()) values.push(write.get('right'))
    return values.length > 0 && values.every(value => isList(value, seen))
  }
  file.path.traverse({ CallExpression(path) {
    if (path.node.loc || !babelTypes.isIdentifier(path.node.callee, helper)) return
    // applyDecs2311: [class, class decorators, member descriptions, ...].
    for (const info of path.get('arguments')[2].get('elements')) {
      const list = info.get('elements')[0]
      if (!isList(list)) list.replaceWith(babelTypes.arrayExpression([list.node]))
    }
  } })
}

/** Babel owns decorator application and initialization. Only compiler-created
 * identifiers are redirected to captured intrinsics; user expressions retain
 * their own lexical resolution. Native fields/private methods need no lowering
 * on the supported Node runtime. */
export function lowerStatefulDecorators(result, target, intrinsicContext) {
  if (result.sourceRegions?.decorated === false && !result.deferredHelpers?.size) return result
  if (result.deferredHelpers?.size) {
    const edits = []
    eachNode(parseRecovered(result.code), node => {
      if (node.type !== 'VariableDeclaration' || node.declarations.length !== 1) return
      const text = result.deferredHelpers.get(node.declarations[0].id.name)
      if (text) edits.push({ start: node.start, end: node.end, text })
    })
    result = { ...result, ...applySourceEdits(result.code, result.sourceMap, edits) }
  }
  const tree = parse(result.code, { ...parserOptionsForTarget(target), errorRecovery: true })
  let decorated = false
  eachNode(tree, node => { if (node.decorators?.length || node.type === 'ClassAccessorProperty') decorated = true })
  if (!decorated) return result
  const allocate = createGeneratedNameAllocator(tree)
  const intrinsics = allocate('decorator_intrinsics')
  const computedMembers = allocate('computed_members')
  const computedStorage = target === 'module' ? allocate('computed_records') : undefined
  const internalBindings = new Set(result.internalBindings)
  internalBindings.add(intrinsics)
  const intrinsicNames = new Set(['Object', 'Reflect', 'TypeError', 'ReferenceError', 'Error', 'Symbol', 'String', 'Number'])
  const frameDeclaration = statement => statement.type === 'VariableDeclaration'
    && statement.declarations.some(binding => binding.id.name === result.rootFrameBinding)
  const cellFrame = program => program.body.find(statement => statement.type === 'BlockStatement'
    && statement.body.some(frameDeclaration))
  // The feature scan owns this tree through lowering. Transfer it to Babel;
  // recovered syntax retains Babel's original parsing and diagnostic path.
  const transform = tree.errors.length === 0
    ? options => transformFromAstSync(tree, result.code, { ...options, cloneInputAst: false })
    : options => transformSync(result.code, options)
  const transformed = transform({
    filename: 'ptc-cell.ts', babelrc: false, configFile: false, browserslistConfigFile: false, sourceMaps: true,
    parserOpts: parserOptionsForTarget(target),
    plugins: [computedDecoratorMembers(computedMembers, allocate, intrinsics, target === 'module'),
      [typescriptTransform, { allowDeclareFields: true, onlyRemoveTypeImports: true }],
      [decoratorTransform, { version: '2023-11' }],
      () => ({ post(file) {
        normalizeGeneratedDecoratorLists(file)
        file.path.traverse(generatedHelperOperations(intrinsics, intrinsicNames, {
          arrays: !!intrinsicContext || target === 'module' || target === 'commonjs',
          records: privateGeneratedRecords(file),
        }))
        for (const binding of Object.values(file.scope.bindings)) {
          if (!binding.identifier.loc) internalBindings.add(binding.identifier.name)
        }
        if (result.rootFrameBinding !== undefined) {
          const frame = cellFrame(file.ast.program)
          const helpers = file.ast.program.body.filter(statement => statement !== frame && statement.type !== 'EmptyStatement')
          file.ast.program.body = file.ast.program.body.filter(statement => statement === frame || statement.type === 'EmptyStatement')
          frame.body.splice(frame.body.findIndex(frameDeclaration) + 1, 0, ...helpers.map(statement => {
            if (!babelTypes.isFunctionDeclaration(statement)) return statement
            // Native REPL block functions produce a value and may escape via
            // Annex B. Helpers initialize before any user code in this frame.
            const value = babelTypes.toExpression(statement)
            return babelTypes.variableDeclaration('const', [babelTypes.variableDeclarator(babelTypes.cloneNode(value.id), value)])
          }))
        }
      } })],
  })
  const applied = mappedTransform(result.code, result.sourceMap, transformed)
  const parsed = parse(applied.code, parserOptionsForTarget(target))
  const offset = result.rootFrameBinding === undefined ? parsed.program.directives.at(-1)?.end ?? 0
    : cellFrame(parsed.program).body.find(frameDeclaration).end
  const hasComputedMembers = transformed.code.includes(computedMembers)
  if (hasComputedMembers) internalBindings.add(computedMembers)
  if (hasComputedMembers && computedStorage) internalBindings.add(computedStorage)
  const output = applySourceEdits(applied.code, applied.sourceMap, [
    { start: offset, end: offset, text: '\n' + intrinsicBootstrap(intrinsics, target, intrinsicContext)
      + (hasComputedMembers ? computedDecoratorBootstrap(computedMembers, intrinsics, computedStorage) : '') },
  ])
  return { ...result, ...output, internalBindings,
    ...(result.sourceRegions === undefined ? {} : { sourceRegions: indexSourceRegions(output.code, parserOptionsForTarget(target)) }) }
}

/** Erase type-only declarations and lower runtime TypeScript values before
 * logical ownership and module export/link plans consume the source. */
export function normalizeTypeScriptValues(code, sourceMap, target) {
  const tree=parse(code,{...parserOptionsForTarget(target),errorRecovery:true})
  let parameterProperties = false
  let tokens
  const declarationTokens = (node, owner = node) => {
    tokens ??= new Map()
    let result = tokens.get(node)
    if (result === undefined) {
      result = parse(code.slice(owner.start, owner.end), { ...parserOptionsForTarget(target), errorRecovery: true, tokens: true }).tokens
        .map(token => ({ ...token, start: token.start + owner.start, end: token.end + owner.start }))
      tokens.set(node, result)
    }
    return result
  }
  const edits=[]
  visitSource(tree,{
    TSParameterProperty() { parameterProperties = true },
    Decorator(path) {
      const expression=path.node.expression
      if(expression.extra?.parenthesized) return
      edits.push({start:expression.start,end:expression.start,text:'('},
        {start:expression.end,end:expression.end,text:')'})
    },
    'ExportNamedDeclaration|ExportDefaultDeclaration|ExportAllDeclaration'(path) {
      if(path.node.exportKind==='type') {
        edits.push({start:path.node.start,end:path.node.end,text:''})
        path.skip()
        return
      }
      const declaration=path.node.declaration
      if(declaration?.type!=='ClassDeclaration'||declaration.declare===true
        ||declaration.decorators?.[0]?.start!==path.node.start) return
      const afterDecorators=declaration.decorators.at(-1).end
      const modifiers=declarationTokens(path.node).filter(token=>token.start>=afterDecorators&&token.end<=declaration.body.start
        &&(token.type.label==='export'||token.type.label==='default'))
      let prefix=''
      const mappings=[]
      for(const token of modifiers) {
        const text=code.slice(token.start,token.end)
        mappings.push({generatedStart:prefix.length,generatedEnd:prefix.length+text.length,
          originalStart:token.start,originalEnd:token.end})
        prefix+=text+' '
        edits.push({start:token.start,end:token.end,text:''})
      }
      edits.push({start:path.node.start,end:path.node.start,text:prefix,mappings})
    },
    'TSTypeAliasDeclaration|TSInterfaceDeclaration|TSDeclareFunction'(path) {
      const owner=path.parentPath.isExportNamedDeclaration()||path.parentPath.isExportDefaultDeclaration()?path.parent:path.node
      edits.push({start:owner.start,end:owner.end,text:''})
      path.skip()
    },
    'TSDeclareMethod|ClassProperty|ClassPrivateProperty|ClassAccessorProperty'(path) {
      if(path.node.type!=='TSDeclareMethod'&&path.node.abstract!==true&&path.node.declare!==true) return
      edits.push({start:path.node.start,end:path.node.end,text:''})
      path.skip()
    },
    ImportDeclaration(path) {
      if(path.node.importKind==='type') {
        edits.push({start:path.node.start,end:path.node.end,text:''})
        return
      }
      const specifiers=path.node.specifiers.filter(specifier=>specifier.type==='ImportSpecifier')
      if(!specifiers.some(specifier=>specifier.importKind==='type')) return
      const kept=specifiers.filter(specifier=>specifier.importKind!=='type')
      if(kept.length===0&&specifiers.length===path.node.specifiers.length) {
        edits.push({start:path.node.start,end:path.node.end,text:''})
        return
      }
      edits.push({start:specifiers[0].start,end:specifiers.at(-1).end,
        text:kept.map(specifier=>code.slice(specifier.start,specifier.end)).join(',')})
    },
    'VariableDeclaration|ClassDeclaration'(path) {
      if(path.node.type==='ClassDeclaration'&&path.node.abstract===true&&path.node.declare!==true) {
        const start=path.node.decorators?.at(-1)?.end??path.node.start
        const owner=path.parentPath.isExportDefaultDeclaration()?path.parent:path.node
        const modifier=declarationTokens(path.node,owner).find(token=>token.start>=start&&token.end<=path.node.body.start
          &&token.type.label==='name'&&token.value==='abstract')
        edits.push({start:modifier.start,end:modifier.end,text:''})
      }
      if(path.node.declare!==true) return
      const owner=path.parentPath.isExportNamedDeclaration()||path.parentPath.isExportDefaultDeclaration()?path.parent:path.node
      edits.push({start:owner.start,end:owner.end,text:''})
      path.skip()
    },
    'TSEnumDeclaration|TSModuleDeclaration'(path) {
      const owner=path.parentPath.isExportNamedDeclaration()?path.parent:path.node
      let source=code.slice(path.node.start,path.node.end)
      const enumEdits=[]
      babelTypes.traverseFast(path.node,node=>{
        if(node.type!=='TSEnumDeclaration'||node.const!==true) return
        const modifier=declarationTokens(node).find(token=>token.type.label==='const')
        enumEdits.push({start:modifier.start-path.node.start,end:modifier.end-path.node.start,
          text:' '.repeat(modifier.end-modifier.start)})
      })
      if(enumEdits.length>0) source=applySourceEdits(source,identitySourceMap(source.length),enumEdits).code
      const transformed=transformTypeScriptSource(source,{module:target!=='commonjs',sourceMap:true,
        transform:{tsEnumIsMutable:true,noEmptyExport:true}})
      const nativeMap=new SourceMap(JSON.parse(transformed.map))
      const starts=[0]
      for(let index=0;index<source.length;index++) if(source[index]==='\n') starts.push(index+1)
      const mappings=[]
      let line=1,column=1
      for(let index=0;index<transformed.code.length;index++) {
        const origin=nativeMap.findOrigin(line,column)
        const start=Math.min(source.length,Math.max(0,(starts[origin.lineNumber-1]??0)+(origin.columnNumber??1)-1))
        mappings.push({generatedStart:index,generatedEnd:index+1,originalStart:path.node.start+start,
          originalEnd:Math.min(owner.end,path.node.start+start+1)})
        if(transformed.code[index]==='\n'){line++;column=1}else column++
      }
      const exported=owner!==path.node&&transformed.code.trim()!==''?`\nexport {${path.node.id.name}};`:''
      edits.push({start:owner.start,end:owner.end,text:transformed.code+exported,mappings})
      path.skip()
    },
  })
  const result = applySourceEdits(code,sourceMap,edits)
  return parameterProperties ? lowerParameterProperties(result) : result
}

/** Shared language lowering without logical binding or dynamic-environment rewriting. */
export function lowerNativeLanguageSource(code, { sourceType = 'script', nativeUsing } = {}) {
  // Module syntax is a parsing context here, not a module bootstrap dependency.
  const target = sourceType === 'module' ? 'reflection-module' : undefined
  const options = parserOptionsForTarget(target)
  const typed = normalizeTypeScriptValues(code, identitySourceMap(code.length), target)
  const parameters = lowerLegacyParameterDecorators(typed, target)
  const tree = parse(parameters.code, { ...options, errorRecovery: true })
  const result = tree.errors.length > 0 ? normalizeStatefulScopes(code, undefined, { target, nativeUsing })
    : lowerStatefulResources(lowerStatefulDecorators(parameters, target), { target, nativeUsing })
  try {
    parse(result.code, { ...options, plugins: [], errorRecovery: true })
    return result.code
  } catch {
    return transformSync(result.code, { filename: 'ptc-source.ts', babelrc: false, configFile: false, browserslistConfigFile: false,
      parserOpts: { ...options, errorRecovery: true },
      plugins: [[typescriptTransform, { allowDeclareFields: true, onlyRemoveTypeImports: true }]],
    }).code
  }
}

/** Parameter properties must become ordinary parameters and writes before scope
 * ownership is assigned. Babel owns insertion after every reachable super(). */
function lowerParameterProperties(result) {
  let needed = false
  eachNode(parseRecovered(result.code), node => { if (node.type === 'TSParameterProperty') needed = true })
  if (!needed) return result
  const parameterProperties = new Map()
  const facts = analyzeLogicalScopes(result.code, { parameterProperties, mutablePaths: true })
  for (const [node, name] of facts.names) node.name = name
  for (const [node, path] of facts.paths) {
    if (node.type !== 'ClassMethod' || node.kind !== 'constructor') continue
    const properties = parameterProperties.get(node) ?? []
    if (!properties.length) continue
    if (path.parent.body.findLast(member => member.type === 'ClassMethod' && member.kind === 'constructor') !== node) continue
    const names = properties.map(property => bindingNodes(property.parameter)[0].name)
    const skeleton = `class C{constructor(${names.map(name => `public ${name}:unknown`).join(',')}){}}`
    const lowered = transformTypeScriptSource(skeleton, { transform: { noEmptyExport: true } }).code
    const members = parse(lowered, { ...PARSER_OPTIONS, errorRecovery: true }).program.body[0].body.body
    const assignments = members.find(member => member.type === 'ClassMethod').body.body
    path.parent.body.unshift(...members.filter(member => member.type === 'ClassProperty'))
    injectInitialization(path.parentPath.parentPath, path, assignments)
  }
  return mappedTransform(result.code, result.sourceMap, generate(facts.tree,
    { sourceMaps: true, sourceFileName: 'ptc-cell.ts' }, result.code))
}

/** Parameter decorators select TypeScript's legacy decorator convention. The
 * maintained compiler lowers their class/parameter phases before logical scopes;
 * tslib helpers are private compiler bindings with captured language intrinsics. */
function lowerLegacyParameterDecorators(result, target, intrinsicContext) {
  let needed = false
  eachNode(parseRecovered(result.code), node => {
    if (isFunctionNode(node) && node.params.some(parameter => parameter.decorators?.length)) needed = true
  })
  if (!needed) return result
  const ts = loadTypeScript()
  const expressionIntrinsics = createGeneratedNameAllocator(parseRecovered(result.code))('legacy_intrinsics')
  const expressionBindings = new Set()
  const internalPrivateNames = new Set()
  const expressionClasses = new Map()
  while (true) {
    const facts = analyzeLogicalScopes(result.code, { mutablePaths: true })
    const expressionTree = facts.tree
    const names = createGeneratedNameAllocator(expressionTree, expressionClasses.keys())
    let selected = [...facts.paths.values()].filter(path => path.isClassExpression()
      && path.node.body.body.some(member => member.params?.some(parameter => parameter.decorators?.length)))
      .sort((left, right) => left.node.end - left.node.start - (right.node.end - right.node.start))[0]
    if (!selected) break
    // A computed field initializer runs after its key was evaluated. Its key
    // cache belongs to this class definition, including repeated loop entries.
    while (['ClassProperty', 'ClassAccessorProperty'].includes(selected.parent.type)
      && selected.parent.computed && !['StringLiteral', 'NumericLiteral'].includes(selected.parent.key.type)) {
      const owner = selected.findParent(path => path.isClass())
      if (expressionClasses.has(facts.names.get(owner.node.id))) break
      selected = owner
    }
    const node = selected.node
    const declarationId = selected.isClassDeclaration() ? node.id : undefined
    const name = names('legacy_class_expression')
    const parent = selected.parent
    let inferredName = ''
    let inferredKey
    if ((parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier')
      || (parent.type === 'AssignmentPattern' || parent.type === 'AssignmentExpression') && parent.right === node && parent.left.type === 'Identifier') {
      const identifier = parent.id ?? parent.left
      inferredName = facts.names.get(identifier) ?? identifier.name
    } else if (['ObjectProperty', 'ClassProperty', 'ClassAccessorProperty'].includes(parent.type) && parent.value === node
      && (!parent.computed || ['StringLiteral', 'NumericLiteral'].includes(parent.key.type))) {
      inferredName = parent.key.name ?? String(parent.key.value)
      if (parent.type === 'ObjectProperty' && !parent.computed && inferredName === '__proto__') inferredName = ''
    } else if (['ObjectProperty', 'ClassProperty', 'ClassAccessorProperty'].includes(parent.type)
      && parent.value === node && parent.computed) {
      inferredKey = names('legacy_class_key')
      expressionBindings.add(inferredKey)
      const object = names('legacy_key_object')
      expressionBindings.add(object)
      selected.scope.push({ id: babelTypes.identifier(inferredKey), kind: 'let', unique: true })
      const coercion = parse(`(${inferredKey}=((${object})=>${expressionIntrinsics}.Object.getOwnPropertyNames(${object})[0]??${expressionIntrinsics}.Object.getOwnPropertySymbols(${object})[0])({[0]:0}))`, PARSER_OPTIONS).program.body[0].expression
      coercion.right.arguments[0].properties[0].key = parent.key
      parent.key = coercion
      if (parent.type !== 'ObjectProperty') {
        const owner = selected.findParent(path => path.isClass()).node
        const ownerName = facts.names.get(owner.id)
        const metadata = expressionClasses.get(ownerName)
        if (metadata.suspending) {
          const storage = names('legacy_field_key')
          const field = babelTypes.classPrivateProperty(babelTypes.privateName(babelTypes.identifier(storage)),
            babelTypes.identifier(inferredKey))
          field.static = true
          owner.body.body.unshift(field)
          internalPrivateNames.add(storage)
          metadata.retainSelf = metadata.originalName === undefined
          inferredKey = `${metadata.originalName ?? ownerName}.#${storage}`
        }
      }
    } else if (parent.type === 'ExportDefaultDeclaration') inferredName = 'default'
    expressionClasses.set(name, { originalName: facts.names.get(node.id), inferredName, inferredKey })
    node.type = 'ClassDeclaration'
    node.id = babelTypes.identifier(name)
    const invocation = babelTypes.callExpression(babelTypes.arrowFunctionExpression([], babelTypes.blockStatement([
      node, babelTypes.returnStatement(babelTypes.identifier(name)),
    ])), [])
    if (declarationId) {
      const publicName = babelTypes.cloneNode(declarationId)
      facts.names.set(publicName, facts.names.get(declarationId))
      selected.replaceWith(babelTypes.variableDeclaration('let', [babelTypes.variableDeclarator(publicName, invocation)]))
      selected = selected.get('declarations.0.init')
    } else selected.replaceWith(invocation)
    const wrapper = selected.get('callee')
    const decorators = []
    // Legacy decorators evaluate in the outer lexical environment. Include
    // their expressions when classifying suspension, then restore their phase.
    wrapper.get('body').traverse(traverseScopes.visitors.environmentVisitor({ Class(path) {
      for (const owner of [path.node, ...path.node.body.body.flatMap(member => [member, ...member.params ?? []])]) {
        if (!owner.decorators?.length) continue
        const values = owner.decorators.map(decorator => {
          const expression = babelTypes.cloneNode(decorator.expression)
          const parsed = babelTypes.file(babelTypes.program([babelTypes.expressionStatement(expression)]))
          traverseScopes(parsed, { noScope: true, Identifier(path) {
            // The TypeScript parameter-decorator parser treats these tokens as
            // identifiers; native lexical conversion requires their real nodes.
            if (!path.isReferencedIdentifier() || !['this', 'super'].includes(path.node.name)) return
            const replacement = path.node.name === 'this' ? babelTypes.thisExpression() : babelTypes.super()
            replacement.loc = path.node.loc
            path.replaceWith(replacement)
          } })
          return { decorator, statement: parsed.program.body[0] }
        })
        decorators.push({ owner, values })
        owner.decorators = []
      }
    } }))
    const probes = new Set(decorators.flatMap(({ values }) => values.map(({ statement }) => statement)))
    wrapper.node.body.body.unshift(...probes)
    let awaited = false, yielded = false
    wrapper.get('body').traverse(traverseScopes.visitors.environmentVisitor({
      ArrowFunctionExpression(path) { path.skip() },
      AwaitExpression() { awaited = true },
      YieldExpression() { yielded = true },
    }))
    if (yielded) {
      wrapper.node.type = 'FunctionExpression'
      wrapper.node.generator = true
      wrapper.node.async = awaited
    } else if (awaited) wrapper.node.async = true
    expressionClasses.get(name).suspending = awaited || yielded
    wrapper.node.body.body = wrapper.node.body.body.filter(statement => !probes.has(statement))
    for (const { owner, values } of decorators) {
      owner.decorators = values.map(({ decorator, statement }) => {
        decorator.expression = statement.expression
        return decorator
      })
    }
    eachNode(expressionTree, current => {
      if (current.type !== 'VariableDeclarator' || current.id.type !== 'Identifier' || current.id.loc) return
      expressionBindings.add(current.id.name)
    })
    for (const [identifier, originalName] of facts.names) identifier.name = originalName
    result = mappedTransform(result.code, result.sourceMap, generate(expressionTree,
      { sourceMaps: true, sourceFileName: 'ptc-cell.ts' }, result.code))
  }
  const tree = parse(result.code, { ...PARSER_OPTIONS, errorRecovery: true })
  const allocate = createGeneratedNameAllocator(tree)
  const marker = allocate('legacy_module_marker')
  const preserved = new Map()
  const masks = []
  const preserve = (node, accessor = false) => {
    const name = allocate('standard_decorator')
    preserved.set(name, { text: result.code.slice(node.start, node.end), accessor })
    masks.push({ start: node.start, end: node.end, text: accessor ? `${name}(){}` : `/*${name}*/` })
  }
  traverseScopes(tree, { noScope: true, Class(path) {
    if (path.node.body.body.some(member => member.params?.some(parameter => parameter.decorators?.length))) return
    for (const decorator of path.node.decorators ?? []) preserve(decorator)
    for (const member of path.node.body.body) {
      if (member.type === 'ClassAccessorProperty') { preserve(member, true); continue }
      for (const decorator of member.decorators ?? []) preserve(decorator)
    }
  } })
  const masked = applySourceEdits(result.code, result.sourceMap, masks)
  const transformed = ts.transpileModule(masked.code + `\nexport const ${marker}=0;`, {
    fileName: 'ptc-cell.ts', compilerOptions: { target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext, experimentalDecorators: true, importHelpers: true,
      sourceMap: true, verbatimModuleSyntax: true },
  })
  let applied = mappedTransform(masked.code, masked.sourceMap,
    { code: transformed.outputText, map: transformed.sourceMapText })
  const lowered = parse(applied.code, { ...PARSER_OPTIONS, errorRecovery: true })
  const emittedMap = new SourceMap(JSON.parse(transformed.sourceMapText))
  const intrinsics = expressionIntrinsics
  const internalBindings = new Set([intrinsics, ...expressionClasses.keys(), ...expressionBindings])
  const deferredHelpers = new Map([[intrinsics, intrinsicBootstrap(intrinsics, target, intrinsicContext)]])
  const edits = []
  const restore = (start, end, text) => edits.push({ start, end, text, mappings: [{
    generatedStart: 0, generatedEnd: text.length, originalStart: start, originalEnd: end,
  }] })
  for (const comment of lowered.comments) {
    const kept = preserved.get(comment.value)
    if (kept && !kept.accessor) restore(comment.start, comment.end, kept.text)
  }
  eachNode(lowered, node => {
    if (node.type !== 'ClassMethod') return
    const kept = preserved.get(node.key.name)
    if (kept?.accessor) restore(node.start, node.end, kept.text)
  })
  for (const node of lowered.program.body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.declarations?.[0]?.id.name === marker) {
      edits.push({ start: node.start, end: node.end, text: '' })
    }
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'tslib'
      || emittedMap.findEntry(node.loc.start.line - 1, node.loc.start.column).originalLine !== undefined
      || !node.specifiers.every(specifier => specifier.imported?.name in legacyDecoratorHelpers)) continue
    const helpers = node.specifiers.map(specifier => {
      const name = specifier.local.name
      internalBindings.add(name)
      const helper = parse(`(${legacyDecoratorHelpers[specifier.imported.name].toString()})`, PARSER_OPTIONS)
      traverseScopes(helper, { Identifier(path) {
        if (!['Object', 'Reflect'].includes(path.node.name) || !path.isReferencedIdentifier()) return
        path.replaceWith(babelTypes.memberExpression(babelTypes.identifier(intrinsics), babelTypes.identifier(path.node.name)))
        path.skip()
      } })
      const declaration = helper.program.body[0].expression
      if (target === 'module') {
        declaration.type = 'FunctionDeclaration'
        declaration.id = babelTypes.identifier(name)
        deferredHelpers.set(name, generate(declaration).code)
      } else deferredHelpers.set(name, `const ${name}=${generate(declaration).code};`)
      return `const ${name}=void 0;`
    }).join('\n')
    edits.push({ start: node.start, end: node.end, text: `const ${intrinsics}=void 0;\n` + helpers })
  }
  applied = applySourceEdits(applied.code, applied.sourceMap, edits)
  if (expressionClasses.size) {
    const expressionEdits = []
    eachNode(parseRecovered(applied.code), node => {
      if (node.type !== 'ClassExpression' && node.type !== 'ClassDeclaration') return
      const metadata = expressionClasses.get(node.id?.name)
      if (!metadata) return
      const inferred = metadata.originalName === undefined
      const object = allocate('legacy_class_value')
      internalBindings.add(object)
      const keyPrefix = metadata.inferredKey
        ? `((${object})=>${object}[${intrinsics}.Object.getOwnPropertyNames(${object})[0]??${intrinsics}.Object.getOwnPropertySymbols(${object})[0]])({[${metadata.inferredKey}]:`
        : `({[${JSON.stringify(metadata.inferredName)}]:`
      const prefix = (node.type === 'ClassDeclaration' ? `let ${node.id.name}=` : '') + (inferred ? keyPrefix : '(')
      const suffix = (inferred ? metadata.inferredKey ? '})' : `})[${JSON.stringify(metadata.inferredName)}]` : ')')
        + (node.type === 'ClassDeclaration' ? ';' : '')
      expressionEdits.push({ start: node.start, end: node.start, text: prefix },
        { start: node.id.start, end: node.id.end, text: metadata.originalName ?? (metadata.retainSelf ? node.id.name : '') },
        { start: node.end, end: node.end, text: suffix })
      if (metadata.retainSelf) {
        const displayName = metadata.inferredKey
          ? `({[${metadata.inferredKey}]:class{}})[${metadata.inferredKey}].name`
          : JSON.stringify(metadata.inferredName)
        expressionEdits.push({ start: node.body.start + 1, end: node.body.start + 1,
          text: `static{if(${intrinsics}.Object.getOwnPropertyDescriptor(this,"name")?.value===${JSON.stringify(node.id.name)})${intrinsics}.Object.defineProperty(this,"name",{value:${displayName}})}` })
      }
    })
    applied = applySourceEdits(applied.code, applied.sourceMap, expressionEdits)
  }
  // Suspension scaffolds are never executed. Restore their statements to the
  // original expression so await/yield retain their native continuation points.
  while ([...expressionClasses.values()].some(metadata => metadata.suspending)) {
    const tree = parse(applied.code, { ...PARSER_OPTIONS, errorRecovery: true, allowSuperOutsideMethod: true })
    let selected
    traverseScopes(tree, { noScope: true, CallExpression: { exit(path) {
      const body = path.node.callee.body
      if (selected || !body || body.type !== 'BlockStatement') return
      const returned = body.body.at(-1)
      if (returned?.type === 'ReturnStatement' && expressionClasses.get(returned.argument?.name)?.suspending) selected = path
    } } })
    if (!selected) break
    const body = selected.node.callee.body.body
    const metadata = expressionClasses.get(body.at(-1).argument.name)
    const declarations = []
    const statements = body.map(statement => {
      if (statement.type === 'VariableDeclaration') return { ...statement, kind: 'var' }
      if (statement.type === 'ReturnStatement') return babelTypes.expressionStatement(statement.argument)
      return statement
    })
    const expression = babelTypes.toSequenceExpression(statements, { push({ id }) { declarations.push(id) } })
    const owner = selected.findParent(path => path.isBlockStatement() || path.isStaticBlock() || path.isProgram())
    for (const identifier of declarations) internalBindings.add(identifier.name)
    owner.node.body.unshift(babelTypes.variableDeclaration('let', declarations.map(id => babelTypes.variableDeclarator(id))))
    selected.replaceWith(expression)
    metadata.suspending = false
    applied = mappedTransform(applied.code, applied.sourceMap, generate(tree,
      { sourceMaps: true, sourceFileName: 'ptc-cell.ts' }, applied.code))
  }
  return { ...applied, internalBindings, deferredHelpers, internalPrivateNames }
}

/**
 * Recover syntax first, then give Babel unique declaration occurrences to build
 * scope facts without imposing JavaScript's repeated-declaration early errors.
 * Logical names are grouped only after Babel has assigned their actual owners.
 */
export function analyzeLogicalScopes(code, { target, parameterProperties, compact = false, compactNames = false, mutablePaths = false, onPhase } = {}) {
  const tree = parse(code, { ...parserOptionsForTarget(target), errorRecovery: true, attachComment: !compact })
  onPhase?.('scope-parsed')
  // Read-only normalization owns exact UTF-16 ranges and its input map. The
  // duplicated line/column objects are needed only by AST-generating clients.
  if (compact) babelTypes.traverseFast(tree, node => { node.loc = undefined })
  onPhase?.('scope-locations')
  if (parameterProperties) eachNode(tree, node => {
    if (node.type !== 'ClassMethod') return
    parameterProperties.set(node, node.params.filter(parameter => parameter.type === 'TSParameterProperty'))
    node.params = node.params.map(parameter => {
      if (parameter.type !== 'TSParameterProperty') return parameter
      parameter.parameter.decorators = parameter.decorators
      return parameter.parameter
    })
  })
  const invalidDelete=tree.errors.find(error=>error.reasonCode==='DeletePrivateField'||error.reasonCode==='StrictDelete')
  if(invalidDelete) throw invalidDelete
  const allocate = createGeneratedNameAllocator(tree, [], { compact: compactNames })
  const occurrences = new Map()
  const declarations = new Map()
  const names = new Map()
  const parameterExpressions = new Set()
  const register = (node, declaration, role, declarator) => {
    for (const binding of bindingNodes(node)) {
      const occurrence = { node: binding, name: binding.name, declaration, declarator, role }
      occurrences.set(binding, occurrence)
      const list = declarations.get(declaration) ?? []
      list.push(occurrence)
      declarations.set(declaration, list)
      names.set(binding, binding.name)
      binding.name = allocate('scope_occurrence')
    }
  }
  visitSource(tree, {
    TSType(path) { path.skip() },
    VariableDeclaration(path) {
      for (const declarator of path.node.declarations) register(declarator.id, path.node, 'variable', declarator)
    },
    Function(path) {
      const node = path.node
      for (const parameter of node.params) eachNode(parameter, child => {
        if (child.type === 'AssignmentPattern' || child.type === 'ObjectProperty' && child.computed) parameterExpressions.add(node)
      })
      if (node.id) register(node.id, node, node.type === 'FunctionDeclaration' ? 'function' : 'self')
      for (const parameter of node.params) register(parameter.type === 'TSParameterProperty' ? parameter.parameter : parameter, node, 'parameter', parameter)
    },
    Class(path) {
      if (path.node.id) register(path.node.id, path.node, path.isClassDeclaration() ? 'class' : 'self')
    },
    CatchClause(path) {
      if (path.node.param) register(path.node.param, path.node, 'catch', path.node.param)
    },
    ImportDeclaration(path) {
      for (const specifier of path.node.specifiers) register(specifier.local, path.node, 'import')
    },
  })
  const scopes = new Map()
  const functionSelfScopes = new Map()
  const functionBodyScopes = new Map()
  const { paths, owners } = analyzeSourceDeclarations(tree, declarations)
  onPhase?.('scope-owners')
  visitSource(tree, {
    Identifier(path) {
      const occurrence = occurrences.get(path.node)
      if (occurrence === undefined) return
      let scope = owners.get(path.node)
      // Babel groups a named function's immutable self with its parameters and
      // body declarations. The native self environment encloses both, so its
      // identity must not participate in updates to a shadowing local binding.
      if (occurrence.role === 'self' && occurrence.declaration.type === 'FunctionExpression') {
        const self = { block: scope.block, parent: scope.parent }
        functionSelfScopes.set(scope, self)
        scope = self
      }
      const groups = scopes.get(scope) ?? new Map()
      scopes.set(scope, groups)
      const group = groups.get(occurrence.name) ?? { name: occurrence.name, scope, occurrences: [],
        nativeInput: target === 'commonjs' && scope.block.type === 'Program' && (COMMONJS_PARAMETERS.includes(occurrence.name)
          || occurrence.name === 'arguments' && occurrence.declaration.kind === 'var') }
      groups.set(occurrence.name, group)
      group.occurrences.push(occurrence)
      occurrence.group = group
      occurrence.scope = scope
    },
  })
  for (const [scope, groups] of scopes) {
    if (!parameterExpressions.has(scope.block)) continue
    for (const group of [...groups.values()]) {
      const parameters = group.occurrences.filter(item => item.role === 'parameter')
      const body = group.occurrences.filter(item => item.role !== 'parameter')
      // A valid var/function redeclaration after parameter expressions creates
      // a body binding. Conflicting lexical declarations retain the selected
      // stateful parameter-update policy instead.
      if (!parameters.length || !body.length
        || body.some(item => item.role !== 'function' && item.declaration.kind !== 'var')) continue
      let bodyScope = functionBodyScopes.get(scope)
      if (!bodyScope) {
        bodyScope = { block: scope.block.body, parent: scope }
        functionBodyScopes.set(scope, bodyScope)
        scopes.set(bodyScope, new Map())
      }
      const local = { name: group.name, scope: bodyScope, occurrences: body, parameterSource: group }
      scopes.get(bodyScope).set(group.name, local)
      group.occurrences = parameters
      for (const occurrence of body) {
        occurrence.group = local
        occurrence.scope = bodyScope
      }
    }
  }
  let emissionPaths = paths
  if (mutablePaths) {
    emissionPaths = new Map()
    traverseScopes(tree, { enter(path) { emissionPaths.set(path.node, path) } })
  }
  return { tree, allocate, occurrences, declarations, names, scopes, functionSelfScopes, functionBodyScopes, paths: emissionPaths }
}

function annexBPromotions(facts, target) {
  if (target === 'module') return []
  const promotions = []
  for (const groups of facts.scopes.values()) for (const group of groups.values()) {
    if (facts.functionBodyScopes.get(group.scope.parent) === group.scope) continue
    if (!['BlockStatement', 'SwitchStatement'].includes(group.scope.block.type)
      || !group.occurrences.every(item => item.role === 'function'
        && !item.declaration.async && !item.declaration.generator)) continue
    if (facts.paths.get(group.occurrences[0].declaration).isInStrictMode()) continue
    const owner = group.scope.getFunctionParent() ?? group.scope.getProgramParent()
    let blocked = false
    for (let scope = group.scope.parent; scope; scope = scope.parent) {
      const outer = facts.scopes.get(scope)?.get(group.name)
      const simpleCatch = outer?.occurrences.every(item => item.role === 'catch' && item.declaration.param.type === 'Identifier')
      if (outer && !simpleCatch && (scope !== owner || outer.occurrences.some(item => item.role === 'parameter'
        || item.role === 'import' || item.role === 'class'
        || item.role === 'variable' && item.declaration.kind !== 'var'))) { blocked = true; break }
      if (scope === owner) break
    }
    if (!blocked) promotions.push({ group, owner, outer: facts.scopes.get(owner)?.get(group.name) })
  }
  return promotions
}

function prepareAnnexBBlocks(code, sourceMap, target, onPhase) {
  const program = parseRecovered(code)
  onPhase?.('annex-parsed')
  let promote = false
  if (target !== 'module') visitSource(program, { FunctionDeclaration(path) {
    if (path.node.async || path.node.generator || path.isInStrictMode() || path.parentPath.isProgram()
      || path.parentPath.isBlockStatement() && path.parentPath.parentPath.isFunction()) return
    promote = true
    path.stop()
  } })
  return { ...applySourceEdits(code, sourceMap, annexBBlockEdits(program)),
    promote }
}

function introduceAnnexBVars(code, sourceMap, target, onPhase) {
  const blocks = prepareAnnexBBlocks(code, sourceMap, target, onPhase)
  onPhase?.('annex-blocks')
  if (!blocks.promote) return blocks
  code = blocks.code
  sourceMap = blocks.sourceMap
  const facts = analyzeLogicalScopes(code, { target, compact: true, onPhase })
  const missing = new Map()
  for (const promotion of annexBPromotions(facts, target)) {
    if (promotion.outer) continue
    const names = missing.get(promotion.owner) ?? new Map()
    names.set(promotion.group.name, promotion.group.occurrences[0].node)
    missing.set(promotion.owner, names)
  }
  const edits = []
  for (const [owner, names] of missing) {
    const node = owner.block.type === 'Program' ? owner.block : owner.block.body
    const start = node.directives?.at(-1)?.end ?? (node.type === 'Program' ? 0 : node.start + 1)
    const text = '\n' + [...names.keys()].map(name => `var ${name};`).join('') + '\n'
    edits.push({ start, end: start, text, mappings: [...names].map(([name, binding]) => ({
      generatedStart: text.indexOf(`var ${name}`) + 4,
      generatedEnd: text.indexOf(`var ${name}`) + 4 + name.length,
      originalStart: binding.start, originalEnd: binding.end,
    })) })
  }
  return applySourceEdits(code, sourceMap, edits)
}

/**
 * Later phases parse and execute the emitted text again, and an expression
 * rewrite can turn the reference that starts an expression statement into a
 * parenthesized token. Automatic semicolon insertion would then join it to the
 * previous statement, so make that boundary explicit before any rewrite runs.
 *
 * A later rewrite can emit such a leading token for an expression statement's
 * callable reference, a declaration protected module/CommonJS mode emits as
 * `(pattern = (init));` (including one wrapped in an export), an exported
 * declaration or default value, and a block-level function declaration the
 * scope planner republishes as a candidate assignment. Every such boundary is
 * made explicit before any rewrite runs. A statement the module phases delete
 * as a whole cannot own the separator, because that deletion removes a trailing
 * semicolon with it, so the separator is attached to the last statement that
 * survives.
 *
 * The pass is semantics-neutral and idempotent. It changes the compiled form
 * of a stateful-v1/protected-v1 cell, so a journal recorded with an earlier
 * build may no longer reproduce its recorded completion; that cell is then
 * unreconstructable and recovery contracts the frontier as designed.
 */
export function preserveStatementBoundaries(code, sourceMap = identitySourceMap(code.length), parserOptions = {}) {
  let tree
  try {
    tree = parse(code, { ...PARSER_OPTIONS, ...parserOptions, errorRecovery: true })
  } catch {
    // Invalid source keeps its existing diagnostic owner; this pass only
    // protects boundaries the parser already proved.
    return { code, sourceMap }
  }
  // A parse error outside the recoverable set owns its diagnostic: inserting
  // anything would change the program that diagnostic describes.
  if (tree.errors.some(error => !RECOVERABLE_CELL_PARSE_ERRORS.has(error.reasonCode))) return { code, sourceMap }
  const edits = []
  // A later module phase deletes these statements as a whole, a trailing
  // semicolon included, and a reparsed `;` placed directly before the next
  // statement is itself absorbed as that deleted statement's terminator. The
  // separator therefore belongs to the last statement that survives.
  const removedAsWhole = node => node.type === 'ImportDeclaration'
    || node.type === 'ExportAllDeclaration'
    || node.type === 'ExportNamedDeclaration' && node.declaration === null
    || node.type === 'ExportDefaultDeclaration'
  // Every statement form a later rewrite can emit with a `(` first token.
  // A declaration-less export or an import is deleted rather than re-emitted,
  // so only a surviving or re-emitted statement needs the guard.
  const parenthesized = (node, blockLevel) => node.type === 'ExpressionStatement'
    || node.type === 'VariableDeclaration'
    || node.type === 'ExportNamedDeclaration' && node.declaration !== null
    || node.type === 'ExportDefaultDeclaration'
    || blockLevel && node.type === 'FunctionDeclaration'
  const list = (statements, directives, blockLevel) => {
    const entries = [...directives ?? [], ...statements]
    let survivor
    let guardedAt
    for (const next of entries) {
      if (parenthesized(next, blockLevel) && survivor !== undefined && survivor.end !== guardedAt
        && code[survivor.end - 1] !== ';' && code[survivor.end] !== ';') {
        edits.push({ start: survivor.end, end: survivor.end, text: ';' })
        guardedAt = survivor.end
      }
      if (!removedAsWhole(next)) survivor = next
    }
  }
  const walk = node => {
    if (node.type === 'Program') list(node.body, node.directives, false)
    else if (node.type === 'BlockStatement' || node.type === 'StaticBlock') list(node.body, node.directives, true)
    else if (node.type === 'SwitchCase') list(node.consequent, undefined, true)
    for (const key of babelTypes.VISITOR_KEYS[node.type] ?? []) {
      const child = node[key]
      if (Array.isArray(child)) { for (const value of child) if (value?.type !== undefined) walk(value) }
      else if (child?.type !== undefined) walk(child)
    }
  }
  walk(tree.program)
  return edits.length === 0 ? { code, sourceMap } : applySourceEdits(code, sourceMap, edits)
}

/**
 * stateful-v1 local activations use stable cells. A declaration evaluates into
 * candidate cells and links them to the committed identity only on success.
 * Escaped candidate closures consequently retain failed candidates, while a
 * successful candidate follows later writes to the original identity.
 * The root compiler owns Program bindings and calls this pass after lowering
 * those declarations. protected-v1 keeps native local binding policy.
 */
export function normalizeStatefulScopes(code, sourceMap = identitySourceMap(code.length), options = {}) {
  const { outputPlan, ...metadata } = normalizeStatefulScopeInput(code, sourceMap, options)
  let result = metadata
  if (outputPlan) {
    // Release declaration ASTs and scope ancestry before materializing the
    // expanded output. This phase retains only numeric pieces and source facts.
    const { pieces, root, code, sourceMap, regionFacts } = outputPlan
    options.onPhase?.('mapping')
    const output = pieces.emit(root)
    result = { ...metadata, ...applySourceEdits(code, sourceMap,
      [{ start: 0, end: code.length, ...output }]),
    sourceRegions: { ...regionFacts, regions: output.regions } }
  }
  options.onPhase?.('validation')
  if (options.target === 'module' || options.target === 'commonjs') validateRegionSource(result, parserOptionsForTarget(options.target))
  result = options.deferDecorators ? result : lowerStatefulDecorators(result, options.target, options.intrinsicContext)
  return options.deferResources ? result : lowerStatefulResources(result, options)
}

/** Resource lifetime is lowered only after declaration owners have consumed
 * the original lexical kind. Babel places lifetime boundaries; the shared
 * resource emitter keeps source operations in their owning activation. */
export function lowerStatefulResources(result, { target, nativeUsing = supportsNativeUsing(), intrinsicContext } = {}) {
  if (nativeUsing || result.sourceRegions?.resources === false || !result.code.includes('using')) return result
  const parserOpts = parserOptionsForTarget(target)
  const tree = parse(result.code, parserOpts)
  let resources = false
  eachNode(tree, node => {
    if (node.type === 'VariableDeclaration' && (node.kind === 'using' || node.kind === 'await using')) resources = true
  })
  if (!resources) return result
  const allocate = createGeneratedNameAllocator(tree)
  const intrinsics = allocate('resource_intrinsics')
  const internalBindings = new Set(result.internalBindings)
  internalBindings.add(intrinsics)
  const intrinsicNames = new Set(['Object', 'TypeError', 'Error', 'Symbol', 'Promise', 'SuppressedError'])
  const ownsFrame = node => {
    let found = false
    eachNode(node, child => {
      if (child.type === 'VariableDeclarator' && child.id.name === result.rootFrameBinding) found = true
    })
    return found
  }
  const transformed = transformFromAstSync(tree, result.code, {
    filename: 'ptc-resource.js', babelrc: false, configFile: false, browserslistConfigFile: false, sourceMaps: true, parserOpts,
    cloneInputAst: false,
    plugins: [() => ({ pre(file) {
      // Keep the head's native lexical environment while expressing async
      // disposal as a body lifetime supported by the maintained lowerer.
      file.path.traverse({ ForOfStatement(path) {
        const { left } = path.node
        if (!babelTypes.isVariableDeclaration(left, { kind: 'await using' })) return
        const resource = babelTypes.identifier(allocate('iteration_resource'))
        const acquired = babelTypes.cloneNode(left.declarations[0].id)
        left.kind = 'const'
        path.node.body = babelTypes.blockStatement([
          babelTypes.variableDeclaration('await using', [babelTypes.variableDeclarator(resource, acquired)]),
          path.node.body,
        ])
      } })
      if (file.ast.program.sourceType !== 'module' && file.ast.program.body.some(node =>
        node.type === 'VariableDeclaration' && (node.kind === 'using' || node.kind === 'await using'))) {
        file.ast.program.body = [babelTypes.blockStatement(file.ast.program.body)]
      }
    } }), resourceTransform, () => ({ post(file) {
      lowerResourceOperations(file, intrinsics, allocate)
      file.path.traverse(generatedHelperOperations(intrinsics, intrinsicNames))
      for (const binding of Object.values(file.scope.bindings)) {
        if (!binding.identifier.loc) internalBindings.add(binding.identifier.name)
      }
      if (result.rootFrameBinding !== undefined) {
        const frame = file.ast.program.body.find(ownsFrame)
        const helpers = file.ast.program.body.filter(statement => statement !== frame && statement.type !== 'EmptyStatement')
        file.ast.program.body = [babelTypes.blockStatement([...helpers.map(statement => {
          if (!babelTypes.isFunctionDeclaration(statement)) return statement
          const value = babelTypes.toExpression(statement)
          return babelTypes.variableDeclaration('const', [babelTypes.variableDeclarator(babelTypes.cloneNode(value.id), value)])
        }), frame])]
      }
    } })],
  })
  const applied = mappedSourceTransform(result.code, result.sourceMap, transformed)
  const parsed = parse(applied.code, parserOpts)
  const offset = result.rootFrameBinding === undefined ? parsed.program.directives.at(-1)?.end ?? 0
    : parsed.program.body[0].start + 1
  const output = applySourceEdits(applied.code, applied.sourceMap, [
    { start: offset, end: offset, text: '\n' + intrinsicBootstrap(intrinsics, target, intrinsicContext) },
  ])
  return { ...result, ...output, internalBindings,
    ...(result.sourceRegions === undefined ? {} : { sourceRegions: indexSourceRegions(output.code, parserOpts) }) }
}

export function hasModuleResources(code) {
  return code.includes('using') && parse(code, parserOptionsForTarget('module')).program.body.some(node =>
    node.type === 'VariableDeclaration' && (node.kind === 'using' || node.kind === 'await using'))
}

function normalizeStatefulScopeInput(code, sourceMap, { mode = 'stateful-v1', target, moduleImport, intrinsicContext, onPhase,
  nativeJavaScript = false, nativeUsing = supportsNativeUsing() } = {}) {
  if (mode !== 'stateful-v1' && mode !== 'protected-v1') throw new TypeError('ptc-plus: unsupported scope semantics')
  onPhase?.('typescript')
  const typescript = nativeJavaScript ? { code, sourceMap }
    : lowerLegacyParameterDecorators(normalizeTypeScriptValues(code,sourceMap,target),target,intrinsicContext)
  const separated = preserveStatementBoundaries(typescript.code, typescript.sourceMap, parserOptionsForTarget(target))
  code=separated.code
  sourceMap=separated.sourceMap
  const finish = result => {
    result = { ...result, deferredHelpers: typescript.deferredHelpers,
      internalBindings: new Set([...typescript.internalBindings ?? [], ...result.internalBindings ?? []]) }
    return result
  }
  // Acquisition bindings own lifetime independently of exported identities.
  // Shared module cells retain lexical policy across native disposal, fallback
  // try regions and cyclic linking, without exporting a native using binding.
  const protectedModule = mode === 'protected-v1' && target === 'module' && hasModuleResources(code)
  const protectedCommonJs = mode === 'protected-v1' && target === 'commonjs'
  if (mode === 'protected-v1' && !protectedModule && !protectedCommonJs) return finish({ code, sourceMap })
  if (protectedCommonJs) {
    const parserOptions = parserOptionsForTarget(target)
    const tree = parse(code, parserOptions)
    let compilerBinding = false
    // A declaration-free name cannot shadow bootstrap. Prove that absence
    // from binding positions before allocating logical scope ancestry. If any
    // declaration might bind it, the complete scope planner decides ownership.
    eachNode(tree, node => {
      const patterns = node.type === 'VariableDeclarator' ? [node.id]
        : babelTypes.isFunction(node) ? [node.id, ...node.params]
          : babelTypes.isClass(node) ? [node.id]
            : node.type === 'CatchClause' ? [node.param] : []
      for (const pattern of patterns) {
        if (pattern && bindingNodes(pattern).some(binding => commonJsCompilerGlobals.has(binding.name))) compilerBinding = true
      }
    })
    if (!compilerBinding) return finish({ code, sourceMap, sourceRegions: indexSourceRegions(code, parserOptions, tree) })
  }
  onPhase?.('annex')
  const annex = introduceAnnexBVars(code, sourceMap, target, onPhase)
  code = annex.code
  sourceMap = annex.sourceMap
  onPhase?.('facts')
  const facts = analyzeLogicalScopes(code, { target, compact: true, compactNames: target === 'module' || target === 'commonjs', onPhase })
  onPhase?.('planning')
  const { tree, allocate, occurrences, scopes, paths } = facts
  const { decorated, resources, lexicalDynamic } = sourceFeatures(tree)
  const dynamicScopes = createDynamicScopeAnalysis(tree)
  const guardedBodies = singleStatementBodies(tree.program)
  const factory = allocate('local_cell')
  const intrinsics = allocate('local_intrinsics')
  const decoratorAdapter = allocate('member_decorator')
  const privateNames = allocate('private_names')
  const promotedFunctions = new Map(annexBPromotions(facts, target).flatMap(({ group, outer }) =>
    group.occurrences.map(item => [item.declaration, outer])))
  const protectedGroups = new Set()
  if (protectedCommonJs) {
    const root = [...scopes.values()].flatMap(scope => [...scope.values()])
      .filter(group => group.scope.block.type === 'Program')
    for (const group of root) if (commonJsCompilerGlobals.has(group.name)) protectedGroups.add(group)
    // A native declaration pattern owns all of its names together. Preserve
    // that ownership when only one name conflicts with bootstrap inputs.
    for (const group of protectedGroups) {
      const declarations = new Set(group.occurrences.map(item => item.declaration))
      for (const peer of root) if (peer.occurrences.some(item => declarations.has(item.declaration))) protectedGroups.add(peer)
    }
    if (protectedGroups.size === 0) return finish({ code, sourceMap,
      sourceRegions: indexSourceRegions(code, parserOptionsForTarget(target)) })
  }
  const groups = [...scopes.values()].flatMap(scope => [...scope.values()])
    .filter(group => (target === 'module' || target === 'commonjs' || group.scope.block.type !== 'Program')
      && !group.occurrences.some(item => item.role === 'self')
      && !(group.scope.block.type === 'Program' && typescript.internalBindings?.has(group.name))
      && (!protectedCommonJs || protectedGroups.has(group))
      && (!protectedModule || group.scope.block.type === 'Program' && group.occurrences.every(item =>
        item.role === 'class' || item.role === 'variable' && item.declaration.kind !== 'var')))
  const active = new Set(groups)
  const introductions = new Map()
  const declarationGroups = new Map()
  const parameterNames = new Map()
  const dynamicBindings = []
  const compilerLocalBindings = new Set()
  const rootPublications = new Map()
  const referenceCells = new Set()
  let varReferenceMarker
  const varReference = () => {
    if (!varReferenceMarker) {
      varReferenceMarker = allocate('var_reference')
      compilerLocalBindings.add(varReferenceMarker)
      dynamicBindings.push({ physicalName: varReferenceMarker, role: 'var-reference' })
    }
    return varReferenceMarker
  }
  const moduleExports = new Map()
  const importNames = new Map()
  const defaultExports = new Map()
  const labels = new Map()
  const jumps = new Map()
  const replacedConstructors = new Set()
  const privateClasses = new Map()
  const privateDeclarations = new Map()
  const privateMembers = new Map()
  const privateAccesses = new Map()
  const privateBrands = new Map()
  const decoratorContexts = new Map()
  visitSource(tree, {
    LabeledStatement(path) { labels.set(path.node, allocate('local_label')) },
    'BreakStatement|ContinueStatement'(path) {
      if (path.node.label === null) return
      const owner = path.findParent(parent => parent.isLabeledStatement() && parent.node.label.name === path.node.label.name)
      if (owner) jumps.set(path.node, owner.node)
    },
    ClassBody(path) {
      const implementations = path.node.body.filter(member => member.type === 'ClassMethod' && member.kind === 'constructor' && member.body)
      for (const member of implementations.slice(0,-1)) replacedConstructors.add(member)
      const publicMethods = new Map()
      for (const member of path.node.body) {
        if (member.type !== 'ClassMethod' || member.kind === 'constructor'
          || member.computed && !['StringLiteral', 'NumericLiteral'].includes(member.key.type)) continue
        const name = member.key.name ?? String(member.key.value)
        const key = `${member.static}:${name}`
        const members = publicMethods.get(key) ?? []
        members.push(member)
        publicMethods.set(key, members)
      }
      for (const members of publicMethods.values()) {
        if (members.length < 2 || !members.some(member => member.decorators?.length)) continue
        let selected = new Map()
        for (const member of members) {
          const accessor = member.kind === 'get' || member.kind === 'set'
          if (!accessor || ![...selected.keys()].every(kind => kind === 'get' || kind === 'set')) selected = new Map()
          selected.set(accessor ? member.kind : 'value', member)
        }
        const kept = new Set(selected.values())
        for (const member of members) {
          if (kept.has(member)) continue
          const physical = allocate('decorated_effect')
          privateMembers.set(member, { physical, public: true })
          for (const decorator of member.decorators ?? []) decoratorContexts.set(decorator, {
            name: member.key.name ?? String(member.key.value), private: false,
          })
        }
      }
      const grouped = new Map()
      for (const member of path.node.body) {
        if (member.key?.type !== 'PrivateName') continue
        const name = member.key.id.name
        const group = grouped.get(name) ?? { name, members: [], targets: new Map() }
        grouped.set(name,group)
        group.members.push(member)
        const owner = group.targets.get(member.static) ?? { static: member.static, members: [] }
        group.targets.set(member.static,owner)
        owner.members.push(member)
      }
      const groups = [...grouped.values()].filter(group => group.members.length > 1
        && !(group.members.length === 2 && group.targets.size === 1
          && new Set(group.members.map(member=>member.kind)).has('get')
          && new Set(group.members.map(member=>member.kind)).has('set')))
      privateDeclarations.set(path.parent,new Set(grouped.keys()))
      if (groups.length === 0) return
      const classNode = path.parent
      const plan = { node: classNode, groups: new Map() }
      privateClasses.set(classNode,plan)
      for (const group of groups) {
        plan.groups.set(group.name,group)
        for (const owner of group.targets.values()) {
          owner.physical = group.targets.size===1?group.name:allocate('private_member')
          let selected = new Map()
          for (const member of owner.members) {
            const accessor = member.kind === 'get' || member.kind === 'set'
            if (!accessor || ![...selected.keys()].every(kind=>kind==='get'||kind==='set')) selected = new Map()
            selected.set(accessor ? member.kind : 'value',member)
          }
          owner.selected = new Set(selected.values())
          if(owner.physical!==group.name&&[...owner.selected].some(member=>member.type==='ClassPrivateMethod'&&member.kind==='method'&&!member.decorators?.length)) {
            owner.nameReady=true
          }
          owner.last = owner.members.at(-1).start
          for (const member of owner.members) {
            const physical = owner.selected.has(member) ? owner.physical
              : member.type === 'ClassPrivateProperty' || member.type === 'ClassAccessorProperty' || member.decorators?.length
                ? allocate('private_effect') : undefined
            privateMembers.set(member, { physical })
            if (physical !== group.name) for (const decorator of member.decorators ?? []) {
              decoratorContexts.set(decorator, { name: '#' + group.name, private: true })
            }
          }
        }
      }
    },
  })
  visitSource(tree,{
    'MemberExpression|OptionalMemberExpression'(path) {
      if(path.node.property.type!=='PrivateName') return
      const owner=path.findParent(parent=>parent.isClass()&&privateDeclarations.get(parent.node)?.has(path.node.property.id.name))
      const group=owner&&privateClasses.get(owner.node)?.groups.get(path.node.property.id.name)
      if(group) privateAccesses.set(path.node,group)
    },
    BinaryExpression(path) {
      if(path.node.operator!=='in'||path.node.left.type!=='PrivateName') return
      const owner=path.findParent(parent=>parent.isClass()&&privateDeclarations.get(parent.node)?.has(path.node.left.id.name))
      const group=owner&&privateClasses.get(owner.node)?.groups.get(path.node.left.id.name)
      if(group) privateBrands.set(path.node,group)
    },
  })
  for (const group of groups) {
    group.cell = allocate('local_binding')
    group.occurrences.sort((a, b) => a.node.start - b.node.start)
    const parameters = group.occurrences.filter(item => item.role === 'parameter' || item.role === 'catch')
    for (const item of parameters) parameterNames.set(item.node, allocate('local_parameter'))
    group.parameter = parameters.at(-1)
    const kind = group.parameter || group.nativeInput ? 'param' : group.occurrences[0].declaration.kind
      ?? (group.occurrences[0].role === 'function' ? 'hoisted' : 'let')
    group.readOnly = mode === 'protected-v1' && ['const', 'using', 'await using'].includes(kind)
    for (const parameter of parameters) {
      const physicalName = parameterNames.get(parameter.node)
      if (typescript.internalBindings?.has(group.name)) compilerLocalBindings.add(physicalName)
      else dynamicBindings.push({ physicalName, name: group.name, kind: 'param', role: 'parameter',
        scopeStart: group.scope.block.start, scopeEnd: group.scope.block.end })
    }
    for (const item of group.occurrences.filter(item => item.role === 'import')) {
      const physicalName = allocate('local_import')
      importNames.set(item.node, physicalName)
      compilerLocalBindings.add(physicalName)
    }
    group.hoistedDeclaration = group.occurrences.filter(item => item.role === 'function').at(-1)?.declaration
    group.hoisted = group.hoistedDeclaration !== undefined && group.occurrences.every(item =>
      item.role === 'function' || item.role === 'parameter' || item.declaration.kind === 'var')
    if (target === 'module' && group.scope.block.type === 'Program') {
      group.publicName = allocate('module_binding')
      group.accessor = group.cell
      group.storage = allocate('module_record')
      group.cell = `${group.accessor}()`
      if (group.hoisted) group.publicName = group.name
      group.nativeLexical = !group.hoisted && !group.occurrences.some(item => item.role === 'import' || item.declaration.kind === 'var')
      compilerLocalBindings.add(group.storage)
    }
    if (group.publicName && !group.hoisted) compilerLocalBindings.add(group.publicName)
    const physicalName = group.accessor ?? group.cell
    if (typescript.internalBindings?.has(group.name)) compilerLocalBindings.add(physicalName)
    else dynamicBindings.push({ physicalName, name: group.name, kind, property: 'v',
      ...(group.accessor ? { accessor: true } : {}),
      role: 'binding', scopeStart: group.scope.block.start, scopeEnd: group.scope.block.end })
    const owner = group.scope.block
    const list = introductions.get(owner) ?? []
    list.push(group)
    introductions.set(owner, list)
    for (const item of group.occurrences) {
      const list = declarationGroups.get(item.declaration) ?? new Set()
      list.add(group)
      declarationGroups.set(item.declaration, list)
    }
  }
  if (target === 'module') {
    for (const statement of tree.program.body) {
      if (statement.type === 'ExportDefaultDeclaration') {
        const declaration = statement.declaration
        if (declaration.type === 'FunctionDeclaration' && declaration.id === null) {
          defaultExports.set(statement, { native: true })
          continue
        }
        const originalGroup = declaration.id ? occurrences.get(declaration.id)?.group : undefined
        const group = active.has(originalGroup) ? originalGroup : undefined
        if (protectedModule && declaration.type === 'FunctionDeclaration') {
          defaultExports.set(statement, { native: true })
          continue
        }
        const exported = group ?? { publicName: allocate('module_default') }
        defaultExports.set(statement, { group, exported })
        moduleExports.set('default', exported)
        continue
      }
      if (statement.type !== 'ExportNamedDeclaration' || statement.source) continue
      if (statement.declaration) {
        for (const occurrence of facts.declarations.get(statement.declaration) ?? []) {
          moduleExports.set(occurrence.name, active.has(occurrence.group) ? occurrence.group : { publicName: occurrence.name })
        }
      } else {
        for (const specifier of statement.specifiers) {
          const group = scopes.get(paths.scopeFor(statement))?.get(specifier.local.name)
          if (group) moduleExports.set(specifier.exported.name ?? specifier.exported.value,
            active.has(group) ? group : { publicName: specifier.local.name })
        }
      }
    }
  }
  if (groups.length === 0 && defaultExports.size === 0 && labels.size === 0 && replacedConstructors.size === 0
    && privateClasses.size === 0 && privateMembers.size === 0) return finish({ code, sourceMap })
  const resolve = (path, name) => resolveSourceBinding(facts, path, name)
  const references = new Map()
  const initializerTargets = new Map()
  for (const occurrence of occurrences.values()) {
    if (occurrence.declaration.kind !== 'var') continue
    const target = varInitializerTarget(paths.get(occurrence.node), occurrence.scope.block,
      occurrence.name, node => facts.names.get(node))
    if (target.catchNode || target.withNodes.length) {
      initializerTargets.set(occurrence.node, { withDepth: target.withNodes.length,
        catchGroup: target.catchNode && occurrences.get(target.catchNode.param).group })
    }
  }
  const deferredDynamicReferences = new Set()
  const deleteOperands = new Map()
  visitSource(tree, {
    UnaryExpression(path) {
      if (path.node.operator !== 'delete') return
      let operand = path.node.argument
      while ((operand.type.startsWith('TS') || operand.type === 'ParenthesizedExpression') && operand.expression) operand = operand.expression
      if (operand.type === 'Identifier') deleteOperands.set(path.node, operand)
    },
    Identifier(path) {
      if (occurrences.has(path.node)) return
      if (!path.isReferencedIdentifier() && !path.isBindingIdentifier()) return
      const sourcePath = paths.get(path.node)
      const group = resolve(sourcePath, path.node.name)
      if (active.has(group)) {
        references.set(path.node, group)
        const withOwner = sourcePath.findParent(parent => parent.isWithStatement()
          && path.node.start >= parent.node.body.start
          && !(group.scope.block.start >= parent.node.body.start && group.scope.block.end <= parent.node.body.end))
        if (withOwner || dynamicScopes.mayEvalShadow(sourcePath, group.scope.block)) {
          deferredDynamicReferences.add(path.node)
        }
      }
    },
  })
  onPhase?.('references')
  const pieces = createSourcePieces(code)
  const { text: part, join, original, mapped } = pieces
  const empty = () => part('')
  const regionContext = node => {
    const path = paths.get(node)
    const owner = isFunctionNode(node) ? path : path.findParent(parent => parent.isFunction())
    const privateNames = new Set()
    const regionLabels = []
    for (let current = path; current; current = current.parentPath) {
      if (current.isClass()) {
        for (const name of privateDeclarations.get(current.node) ?? []) privateNames.add(name)
        for (const group of privateClasses.get(current.node)?.groups.values() ?? []) {
          for (const target of group.targets.values()) privateNames.add(target.physical)
        }
      }
      if (current.isLabeledStatement()) regionLabels.push(labels.get(current.node))
    }
    return { strict: path.isInStrictMode() || owner?.node.body.directives?.some(item => item.value.value === 'use strict'),
      async: owner?.node.async ?? target === 'module', generator: owner?.node.generator ?? false,
      labels: regionLabels, privateNames: [...privateNames], top: node.type === 'Program' }
  }
  const statementPieces = (values, node) => {
    if (values.length === 0) return empty()
    const chunks = []
    let pending = [], size = 0
    const flush = () => {
      const piece = join(pending)
      chunks.push(pieces.region(piece, { kind: 'statements', ...regionContext(node) }))
      pending = []; size = 0
    }
    for (const value of values) {
      pending.push(value)
      size += pieces.length(value)
      if (size >= 16384) flush()
    }
    if (pending.length) flush()
    return join(chunks)
  }
  const cellFor = (group, candidates) => candidates.get(group) ?? group.cell
  // A lazy cell may call its accessor. Keep that complete reference grouped
  // when source uses it as a constructor or the base of a constructor member.
  const read = (group, candidates) => {
    if (!active.has(group)) return `(${group.name})`
    const cell = cellFor(group, candidates)
    return referenceCells.has(cell) ? `(${cell}().value)` : `(${cell}.v)`
  }
  const parameterReference = (node, group) => {
    const owner = group.scope.block
    if (!isFunctionNode(owner) || node.start >= owner.body.start) return undefined
    const parameters = group.occurrences.filter(item=>item.role==='parameter').map(item=>parameterNames.get(item.node)).reverse()
    if(parameters.length===0) return undefined
    if(parameters.length===1) return parameters[0]
    const fallback=parameters.at(-1)
    const read=parameters.slice(0,-1).map(name=>`try{return ${name}}catch{}`).join('')+`return ${fallback}`
    const write=parameters.slice(0,-1).map(name=>`try{${name};${name}=value;return}catch{}`).join('')+`${fallback}=value`
    return `({get v(){${read}},set v(value){${write}}}).v`
  }
  const initialization = (group, candidates) => {
    if (group.publicName) {
      const imported = group.occurrences.filter(item => item.role === 'import').at(-1)
      const initial = group.hoisted ? group.publicName : 'void 0'
      let getter = imported ? `()=>${importNames.get(imported.node)}` : 'void 0'
      if (moduleImport && imported) {
        const specifier = imported.declaration.specifiers.find(specifier => specifier.local === imported.node)
        const name = specifier.type === 'ImportNamespaceSpecifier' ? null : specifier.type === 'ImportDefaultSpecifier' ? 'default'
          : specifier.imported.name ?? specifier.imported.value
        const attributes = Object.fromEntries((imported.declaration.attributes ?? [])
          .map(attribute => [attribute.key.name ?? attribute.key.value, attribute.value.value]))
        getter = `()=>${moduleImport}(${JSON.stringify(imported.declaration.source.value)},${JSON.stringify(name)},${getter},${JSON.stringify(attributes)})`
      }
      // Hoisted accessors expose the cell before evaluation. Creating a record
      // neither reads an import nor initializes a lexical source declaration.
      return part(`${group.hoisted || group.nativeLexical ? '' : `var ${group.publicName};`}var ${group.storage};function ${group.accessor}(){if(${group.storage})return ${group.storage};return ${group.storage}=${factory}(${JSON.stringify(group.name)},${initial},${!group.nativeLexical},${getter},void 0,${group.nativeLexical},${group.readOnly})}${group.cell};`)
    }
    if (group.parameter || group.nativeInput) {
      const bridge = group.nativeInput ? allocate('native_parameter') : undefined
      if (bridge) compilerLocalBindings.add(bridge)
      const name = group.parameter && parameterNames.get(group.parameter.node)
      const reference = bridge ? `${bridge}.get,${bridge}.set` : `()=>${name},v=>${name}=v`
      return join([...(bridge ? [part(`const ${bridge}={get:()=>${group.name},set:next=>${group.name}=next};`)] : []),
        part(`let ${group.cell}=${factory}(${JSON.stringify(group.name)},void 0,false,${reference});`),
        ...(group.hoisted ? [part(`${group.cell}.v=(`),
          emit(group.hoistedDeclaration, candidates, new Set([group.hoistedDeclaration])), part(');')] : [])])
    }
    if (group.hoisted) {
      const declaration = group.hoistedDeclaration
      return join([part(`let ${group.cell}=${factory}(${JSON.stringify(group.name)},(`),
        emit(declaration, candidates, new Set([declaration])), part('),true);')])
    }
    if (group.parameterSource) return part(`let ${group.cell}=${factory}(${JSON.stringify(group.name)},${read(group.parameterSource, candidates)},true);`)
    const hoistedVar = group.occurrences.some(item => item.declaration.kind === 'var')
    const owner = group.scope.block
    const initial = hoistedVar && group.name === 'arguments' && isFunctionNode(owner)
      && owner.type !== 'ArrowFunctionExpression' ? allocate('parameter_initial') : undefined
    if (initial !== undefined) {
      // The initial value belongs to the parameter environment, before the body
      // cell exists. Dynamic adaptation must not resolve it as a body reference.
      compilerLocalBindings.add(initial)
      dynamicBindings.push({ physicalName: initial, name: group.name, role: 'parameter-initializer' })
    }
    return part(`${initial === undefined ? '' : `const ${initial}=arguments;`}let ${group.cell}=${factory}(${JSON.stringify(group.name)},${initial ?? 'void 0'},${hoistedVar},void 0,void 0,${mode === 'protected-v1' && !hoistedVar},${group.readOnly});`)
  }
  const initializations = (node, candidates) => statementPieces((introductions.get(node) ?? []).map(group => initialization(group, candidates)), node)
  const emitPattern = (node, candidates) => {
    const result=emit(node,candidates)
    if(node.type==='Identifier'||!node.typeAnnotation) return result
    return pieces.slice(result, 0, pieces.length(result) - (node.end - node.typeAnnotation.start))
  }
  const emitInitializer = (node, candidates, name) => {
    let expression = node
    while ((expression.type.startsWith('TS') || expression.type === 'ParenthesizedExpression') && expression.expression) expression = expression.expression
    const anonymous = expression.type === 'ArrowFunctionExpression'
      || ['FunctionExpression', 'ClassExpression', 'ClassDeclaration', 'FunctionDeclaration'].includes(expression.type) && expression.id === null
    return anonymous && name !== undefined
      ? join([part(`({[${JSON.stringify(name)}]:(`), emit(node, candidates), part(`)})[${JSON.stringify(name)}]`)])
      : emit(node, candidates)
  }
  const declarator = (node, candidates, expression = false, iterationValue) => {
    const involved = [...new Set(bindingNodes(node.id).map(binding => occurrences.get(binding)?.group).filter(group => active.has(group)))]
    if (involved.length === 0) return expression ? emit(node, candidates)
      : join([part(paths.parentFor(node).kind + ' '), emit(node, candidates), part(';')])
    const lexical = involved.filter(group => group.nativeLexical && group.occurrences[0].node.start >= node.start
      && group.occurrences[0].node.end <= node.end)
    if (node.init === null && iterationValue === undefined) return part(lexical.map(group => `let ${group.publicName};`).join('')
      + involved.map(group => `${group.cell}.ensure()`).join(',') + (expression ? '' : ';'))
    const initializer = () => iterationValue ?? emitInitializer(node.init, candidates,
      node.id.type === 'Identifier' ? occurrences.get(node.id).name : undefined)
    if (mode === 'protected-v1') {
      // Native lexical patterns initialize each binding as its element is
      // reached. The readonly write path is distinct from initialization;
      // callbacks during later defaults can already observe earlier elements.
      const initializing = new Map(candidates)
      const declarations = []
      for (const binding of bindingNodes(node.id)) {
        const group = occurrences.get(binding)?.group
        if (!active.has(group)) continue
        const target = initializerTargets.get(binding)
        if (target?.withDepth) {
          const name = allocate('local_var_reference')
          const fallback = read(target.catchGroup ?? group, candidates)
          declarations.push(`${name}=()=>${varReference()}(${JSON.stringify(group.name)},${target.withDepth},{get:()=>${fallback},set:value=>${fallback}=value})`)
          compilerLocalBindings.add(name)
          referenceCells.add(name)
          initializing.set(target.catchGroup ?? group, name)
        } else if (!target?.catchGroup) initializing.set(group,
          `({get v(){return ${group.cell}.v},set v(value){${group.cell}.initialize(value)}})`)
      }
      const assignment = join([part('('), emitPattern(node.id, initializing), part('=('), initializer(), part('))')])
      return expression ? join([part(`${declarations.length ? declarations.join(',') + ',' : ''}${allocate('local_initialization')}=`), assignment])
        : join([part(declarations.length ? `{const ${declarations.join(',')};` : ''), assignment,
          part(declarations.length ? ';}' : ';')])
    }
    const targets = new Map(bindingNodes(node.id).map(binding =>
      [occurrences.get(binding)?.group, initializerTargets.get(binding)]))
    const stored = involved.filter(group => !targets.get(group)?.catchGroup)
    const candidateMap = new Map(candidates)
    const baseCandidates = new Map()
    const names = []
    for (const group of stored) {
      const name = allocate('local_candidate')
      if (typescript.internalBindings?.has(group.name) || targets.get(group)?.withDepth) compilerLocalBindings.add(name)
      else dynamicBindings.push({ physicalName: name, name: group.name, kind: 'let', property: 'v',
        role: 'candidate', linkPhysicalName: group.accessor ?? group.cell,
        ...(group.accessor ? { linkAccessor: true } : {}), scopeStart: node.start, scopeEnd: node.end,
        ...(node.init === null ? {} : { initializerStart: node.init.start, initializerEnd: node.init.end }),
        patternStart: node.id.start, patternEnd: node.id.end })
      candidateMap.set(group, name)
      baseCandidates.set(group, name)
      names.push(`${name}=${factory}(${JSON.stringify(group.name)},void 0,false,()=>${group.cell}.v)`)
    }
    for (const group of involved) {
      const target = targets.get(group)
      if (!target?.withDepth) continue
      const name = allocate('local_var_reference')
      const fallback = target.catchGroup ? read(target.catchGroup, candidates) : `${baseCandidates.get(group)}.v`
      names.push(`${name}=()=>${varReference()}(${JSON.stringify(group.name)},${target.withDepth},{get:()=>${fallback},set:value=>${fallback}=value})`)
      referenceCells.add(name)
      candidateMap.set(group, name)
      if (target.catchGroup) candidateMap.set(target.catchGroup, name)
      dynamicBindings.push({ physicalName: name, name: group.name, kind: 'let', role: 'candidate', reference: true, accessor: true,
        linkPhysicalName: group.accessor ?? group.cell, scopeStart: node.start, scopeEnd: node.end })
    }
    const candidateNames = stored.map(group => baseCandidates.get(group))
    const body = join([
      part(names.length ? `let ${names.join(',')};` : ''),
      part('('), emitPattern(node.id, candidateMap), part('=('),
      initializer(), part('));'),
      part(lexical.map(group => `let ${group.publicName}=${candidateMap.get(group)}.v;`).join('')),
      part(stored.map((group, index) => `${candidateNames[index]}.commit(${group.cell});`).join('')),
    ])
    if (expression) {
      return join([part(`${names.length ? names.join(',') + ',' : ''}${allocate('local_initialization')}=(`),
        part('('), emitPattern(node.id, candidateMap), part('=('),
        initializer(), part('))'),
        part(stored.map((group, index) => `,${candidateNames[index]}.commit(${group.cell})`).join('')), part(')')])
    }
    return lexical.length ? body : join([part('{'), body, part('}')])
  }
  const privateBridge = group => {
    const targets = [...group.targets.values()].sort((a,b)=>b.last-a.last)
    const branches = targets.map(owner => {
      const names = target === 'module' ? `(${privateNames}??=${intrinsics}.weakSetStore())` : privateNames
      const name = owner.nameReady ? `if(!${names}.has(receiver.#${owner.physical})){${intrinsics}.Object.defineProperty(receiver.#${owner.physical},"name",{value:${JSON.stringify('#'+group.name)},configurable:true});${privateNames}.add(receiver.#${owner.physical});}` : ''
      const setter = [...owner.selected].some(member => member.type === 'ClassPrivateMethod' && member.kind === 'method')
        ? `throw new ${intrinsics}.TypeError("Private method is not writable")` : `receiver.#${owner.physical}=value`
      return `if(#${owner.physical} in receiver){if(test)return true;${name}return {get v(){return receiver.#${owner.physical}},set v(value){${setter}},get call(){const fn=receiver.#${owner.physical};return fn==null?fn:(...args)=>${intrinsics}.Reflect.apply(fn,receiver,args)}}}`
    }).join('')
    // Private names themselves carry the class lexical environment. Keeping the
    // bridge there avoids manufacturing a class self-name and preserves native
    // inferred names even in delayed computed field initializers.
    return `((receiver,optional=false,test=false)=>{if(optional&&receiver==null)return void 0;${branches}if(test)return false;throw new ${intrinsics}.TypeError(${JSON.stringify(`Cannot access private member #${group.name} on this receiver`)})})`
  }
  const emit = (node, candidates = new Map(), suppress = new Set(), loopLabels = '') => {
    if (babelTypes.isTSType(node)) return original(node.start, node.end)
    if (node.type === 'Decorator') {
      const context = decoratorContexts.get(node)
      if (!context) return join([part('@('), emit(node.expression, candidates), part(')')])
      const tail = `,${JSON.stringify(context.name)},${context.private})`
      const expression = node.expression
      if (expression.type === 'MemberExpression') {
        const receiver = allocate('decorator_receiver')
        const key = allocate('decorator_key')
        return join([part(`@(((${receiver},${key})=>${decoratorAdapter}(${receiver}[${key}],${receiver}${tail})(`),
          emit(expression.object, candidates), part(','),
          expression.computed ? emit(expression.property, candidates) : part(JSON.stringify(expression.property.name)), part('))')])
      }
      return join([part(`@(${decoratorAdapter}(`), emit(expression, candidates), part(',void 0' + tail + ')')])
    }
    const member = paths.parentFor(node)
    if (privateMembers.get(member)?.public && member.key === node) {
      return mapped(`#${privateMembers.get(member).physical}`, node)
    }
    if(privateMembers.has(node)) {
      const plan=privateMembers.get(node)
      if(plan.physical===undefined) return part('')
    }
    if (replacedConstructors.has(node)) return part('')
    if (node.type === 'LabeledStatement') {
      let loop = node
      let prefix = ''
      while (loop.type === 'LabeledStatement') {
        prefix += `${labels.get(loop)}:`
        loop = loop.body
      }
      if ((loop.type === 'ForOfStatement' || loop.type === 'ForInStatement')
        && (introductions.has(loop) || declarationGroups.has(loop.left) && loop.left.declarations[0].init)) {
        return emit(loop, candidates, suppress, prefix)
      }
      return join([part(`${labels.get(node)}:`),emit(node.body,candidates)])
    }
    if (jumps.has(node)) return mapped(`${node.type === 'BreakStatement' ? 'break' : 'continue'} ${labels.get(jumps.get(node))};`,node)
    if(node.type==='PrivateName' && privateMembers.has(member)) {
      return mapped(`#${privateMembers.get(member).physical}`,node)
    }
    if(privateBrands.has(node)) {
      const group=privateBrands.get(node)
      return join([part(`${privateBridge(group)}((`),emit(node.right,candidates),part('),false,true)')])
    }
    if((node.type==='CallExpression'||node.type==='OptionalCallExpression')&&privateAccesses.has(node.callee)) {
      const member=node.callee
      const group=privateAccesses.get(member)
      return join([part(`${privateBridge(group)}((`),emit(member.object,candidates),
        part(`)${member.optional?',true':''})${member.optional?'?.':'.'}call${node.optional?'?.':''}(`),
        ...node.arguments.flatMap((argument,index)=>[...(index?[part(',')]:[]),emit(argument,candidates)]),part(')')])
    }
    if(node.type==='TaggedTemplateExpression'&&privateAccesses.has(node.tag)) {
      const group=privateAccesses.get(node.tag)
      return join([part(`${privateBridge(group)}((`),emit(node.tag.object,candidates),part(')).call'),emit(node.quasi,candidates)])
    }
    if(privateAccesses.has(node)) {
      const group=privateAccesses.get(node)
      return join([part(`(${privateBridge(group)}((`),emit(node.object,candidates),part(`)${node.optional?',true':''}))${node.optional?'?.':'.'}v`)])
    }
    if (deleteOperands.has(node)) {
      const operand = deleteOperands.get(node)
      if (paths.get(node).isInStrictMode()) {
        const position = mapSourcePosition({ line: 1, column: node.start + 1 }, code, code, identitySourceMap(code.length))
        throw Object.assign(new SyntaxError('Delete of an unqualified identifier in strict mode.'),
          { loc: { line: position.line, column: position.column - 1 } })
      }
      // Deleting a declarative reference never reads its value, even in TDZ.
      // With-object and eval-created references keep their dynamic owner.
      const group = references.get(operand)
      const candidate = candidates.get(group)
      if (referenceCells.has(candidate) && !dynamicScopes.mayEvalShadow(paths.get(operand), group.scope.block)) {
        return mapped(`${candidate}().delete()`, node)
      }
      if (references.has(operand) && !deferredDynamicReferences.has(operand)) return mapped('false', node)
      return join([mapped('delete (', node), emit(operand, candidates), part(')')])
    }
    if (node.type === 'Identifier') {
      const referenced = references.get(node)
      const candidate = candidates.get(referenced)
      if (deferredDynamicReferences.has(node) && (!referenceCells.has(candidate)
        || dynamicScopes.mayEvalShadow(paths.get(node), referenced.scope.block))) return original(node.start, node.end)
      if (node.name === 'eval' && member.type === 'CallExpression' && member.callee === node) return original(node.start, node.end)
      const occurrence = occurrences.get(node)
      if (active.has(occurrence?.group) && initializerTargets.has(node)) {
        return mapped(read(initializerTargets.get(node).catchGroup ?? occurrence.group, candidates), node)
      }
      if (importNames.has(node)) return mapped(importNames.get(node), node)
      if (parameterNames.has(node)) return mapped(parameterNames.get(node), node)
      const group = references.get(node) ?? (active.has(occurrence?.group) ? occurrence.group : undefined)
      if (group !== undefined && !(occurrence && ['function', 'class'].includes(occurrence.role))) {
        let text = parameterReference(node, group) ?? read(group, candidates)
        const path = paths.get(node)
        if ((path.parent.type === 'CallExpression' || path.parent.type === 'OptionalCallExpression') && path.key === 'callee'
          || path.parent.type === 'TaggedTemplateExpression' && path.key === 'tag') {
          text = referenceCells.has(candidate) ? `${candidate}().callee` : `(0,${text})`
        }
        return mapped(text, node)
      }
      return original(node.start, node.end)
    }
    if (target === 'module' && node.type === 'ImportDeclaration') {
      const edits = node.specifiers.filter(specifier => importNames.has(specifier.local)).map(specifier => ({ start: specifier.local.start, end: specifier.local.end,
        text: `${specifier.type === 'ImportSpecifier' && specifier.imported.start === specifier.local.start
          ? `${code.slice(specifier.imported.start, specifier.imported.end)} as ` : ''}${importNames.get(specifier.local)}` }))
      let cursor = node.start
      const parts = []
      for (const edit of edits) { parts.push(original(cursor, edit.start), part(edit.text)); cursor = edit.end }
      parts.push(original(cursor, node.end))
      return join(parts)
    }
    if (target === 'module' && node.type === 'ExportNamedDeclaration' && !node.source) {
      return node.declaration ? emit(node.declaration, candidates) : part('')
    }
    if (target === 'module' && node.type === 'ExportDefaultDeclaration') {
      const { group, exported, native } = defaultExports.get(node)
      if (native) return join([original(node.start, node.declaration.start), emit(node.declaration, candidates)])
      return group ? emit(node.declaration,candidates)
        : join([part(`let ${exported.publicName}=(`),emitInitializer(node.declaration,candidates,'default'),part(');')])
    }
    if (target === 'module' && (node.type === 'ExportAllDeclaration'
      || node.type === 'ExportNamedDeclaration' && node.source)) return original(node.start,node.end)
    if (node.type === 'ObjectProperty' && node.shorthand) {
      return join([part(`[${JSON.stringify(node.key.name)}]: `), emit(node.value, candidates, suppress)])
    }
    if (node.type === 'AssignmentPattern') {
      return join([emit(node.left, candidates), part('=('), emitInitializer(node.right, candidates,
        occurrences.get(node.left)?.name ?? node.left.name), part(')')])
    }
    if (node.type === 'AssignmentExpression' && ['=', '&&=', '||=', '??='].includes(node.operator)) {
      let target = node.left
      while ((target.type.startsWith('TS') || target.type === 'ParenthesizedExpression') && target.expression) target = target.expression
      if (target.type === 'Identifier') return join([emit(node.left, candidates), part(`${node.operator}(`),
        emitInitializer(node.right, candidates, target.name), part(')')])
    }
    if (LOOP_HEADS.has(node.type)) {
      const head = node.type === 'ForStatement' ? node.init : node.left
      if (head?.type === 'VariableDeclaration' && declarationGroups.has(head)) {
        const headGroups = introductions.get(node) ?? []
        if (node.type === 'ForStatement') {
          const heads = headGroups.map(group => `${group.cell}=${factory}(${JSON.stringify(group.name)})`)
          const firstIteration=headGroups.length?allocate('local_first_iteration'):undefined
          const inputs = head.declarations.map(entry => {
            if (entry.init !== null) return declarator(entry, candidates, true)
            const ensures = bindingNodes(entry.id).map(binding => occurrences.get(binding).group)
              .map(group => `${group.cell}.ensure()`).join(',')
            return part(`${allocate('local_initialization')}=(${ensures})`)
          })
          return join([part(`for(let ${heads.length ? `${heads.join(',')},` : ''}`),
            ...inputs.flatMap((input, index) => index ? [part(','), input] : [input]),
            part(firstIteration?`,${firstIteration}=true;${firstIteration}&&(${firstIteration}=false,${headGroups.map(group=>`${group.cell}=${group.cell}.copy()`).join(',')}),`:';'),
            ...(node.test ? [emit(node.test, candidates)] : firstIteration?[part('true')]:[]), part(';'),
            part(headGroups.map(group => `${group.cell}=${group.cell}.copy()`).join(',')),
            ...(node.update ? [part(headGroups.length ? ',' : ''), emit(node.update, candidates)] : []),
            part(')'), emit(node.body, candidates)])
        }
        const iteration = allocate('local_iteration')
        const keyword = head.kind === 'using' || head.kind === 'await using' ? head.kind : 'let'
        const sourceInitialization = node.type === 'ForInStatement' && head.declarations[0].init !== null
          ? declarator(head.declarations[0], candidates) : undefined
        const sourceCandidates = new Map(candidates)
        const headCells = headGroups.map(group => {
          const physicalName = allocate('iteration_head')
          sourceCandidates.set(group, physicalName)
          dynamicBindings.push({ physicalName, name: group.name, kind: 'let', property: 'v',
            role: 'binding', scopeStart: node.start, scopeEnd: node.right.end })
          return `let ${physicalName}=${factory}(${JSON.stringify(group.name)},void 0,false,void 0,void 0,true);`
        }).join('')
        // The source sees a separate uninitialized head environment. Escaped
        // source closures retain it; each iteration creates its own live cells.
        const wrapped = headCells || sourceInitialization
        return join([part(wrapped ? `{${headCells}` : ''), ...(sourceInitialization ? [sourceInitialization] : []),
          part(`${loopLabels}for${node.await ? ' await' : ''}(${keyword} ${iteration} ${node.type === 'ForOfStatement' ? 'of' : 'in'} (`),
          emit(node.right, sourceCandidates), part(')){'), initializations(node, candidates),
          declarator(head.declarations[0], candidates, false, part(iteration)), emit(node.body, candidates),
          part(wrapped ? '}}' : '}')])
      }
    }
    if (node.type === 'VariableDeclaration' && declarationGroups.has(node) && !suppress.has(node)) {
      if (node.kind === 'using' || node.kind === 'await using') {
        return join(node.declarations.flatMap(entry => {
          const resource = allocate('local_resource')
          const group = occurrences.get(entry.id)?.group
          if (group?.nativeLexical && group.occurrences[0].node === entry.id) {
            return [part(`${node.kind} ${resource}=(`), emitInitializer(entry.init, candidates, occurrences.get(entry.id).name),
              part(`);let ${group.publicName}=${resource};${group.cell}.initialize(${resource});`)]
          }
          return mode === 'protected-v1'
            ? [part(`${node.kind} ${resource}=(`), emitInitializer(entry.init, candidates, occurrences.get(entry.id).name),
              part(`);${group.cell}.initialize(${resource});`)]
            : [part(`${node.kind} ${resource}=(`), emitInitializer(entry.init, candidates, occurrences.get(entry.id).name), part(');('),
              emitPattern(entry.id, candidates), part(`=${resource});`)]
        }))
      }
      const operations = join(node.declarations.map(entry => declarator(entry, candidates)))
      return guardedBodies.has(node)
        ? join([part('{'), operations, part('}')]) : operations
    }
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration')
      && node.id && declarationGroups.has(node) && !suppress.has(node)) {
      const group = occurrences.get(node.id).group
      if (active.has(group)) {
        if (group.hoisted) {
          if (group.accessor) return node === group.hoistedDeclaration
            ? emit(node, candidates, new Set([node])) : part(';')
          const promoted = promotedFunctions.get(node)
          if (!promoted) return part(';')
          if (active.has(promoted)) return mapped(`${read(promoted, candidates)}=${read(group, candidates)};`, node)
          // Annex B publishes to the proven var owner, outside any with or
          // catch environment surrounding the block declaration's execution.
          let publication = rootPublications.get(promoted)
          if (!publication) {
            publication = allocate('annex_publication')
            rootPublications.set(promoted, publication)
            compilerLocalBindings.add(publication)
          }
          return mapped(`${publication}(${read(group, candidates)});`, node)
        }
        if (group.nativeLexical && node === group.occurrences[0].declaration) {
          return join([part(`let ${group.publicName}=(`), emit(node, candidates, new Set([node])),
            part(`);${group.cell}.initialize(${group.publicName});`)])
        }
        return join([part(mode === 'protected-v1' ? `${group.cell}.initialize(` : `${group.cell}.v=(`),
          emit(node, candidates, new Set([node])), part(');')])
      }
    }
    const discriminant = node.type === 'SwitchStatement' && introductions.has(node)
      ? allocate('switch_discriminant') : undefined
    if (discriminant) {
      compilerLocalBindings.add(discriminant)
      dynamicBindings.push({ physicalName: discriminant, role: 'source-initializer' })
    }
    const children = []
    for (const key of babelTypes.VISITOR_KEYS[node.type] ?? []) {
      const value = node[key]
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof child.type === 'string'
          && Number.isInteger(child.start) && child.start >= node.start && child.end <= node.end) children.push(child)
      }
    }
    children.sort((a, b) => a.start - b.start || b.end - a.end)
    let cursor = node.start
    const parts = []
    const statementList = node.type === 'BlockStatement' || node.type === 'Program' ? new Set(node.body) : undefined
    const statements = []
    for (const child of children) {
      if (child.start < cursor) continue
      const privateKey = privateMembers.get(node)?.public && node.computed && child === node.key
      const gap = original(cursor, privateKey ? code.lastIndexOf('[', child.start) : child.start)
      const value = discriminant && child === node.discriminant ? mapped(discriminant, child) : emit(child, candidates, suppress)
      if (statementList?.has(child)) {
        if (statements.length === 0) parts.push(gap)
        else statements.push(gap)
        statements.push(value)
      } else parts.push(gap, value)
      cursor = privateKey ? code.indexOf(']', child.end) + 1 : child.end
    }
    if (statements.length) parts.push(statementPieces(statements, node))
    parts.push(original(cursor, node.end))
    let result = join(parts)
    const parent = paths.parentFor(node)
    const owner = introductions.has(node) ? node
      : node.type === 'BlockStatement' && (isFunctionNode(parent) || parent.type === 'CatchClause')
        && introductions.has(parent) ? parent : undefined
    if (owner && (node.type === 'BlockStatement' || node.type === 'StaticBlock')) {
      const prefix = join([...(owner === node && isFunctionNode(parent) ? [initializations(parent, candidates)] : []),
        initializations(owner, candidates)])
      const offset = node.directives?.length ? node.directives.at(-1).end-node.start
        : node.type === 'StaticBlock' ? code.indexOf('{', node.start) - node.start + 1 : 1
      // The opening token precedes every copied child, so inserting here cannot
      // split a transformed identifier or declaration.
      result = join([pieces.slice(result, 0, offset), prefix, pieces.slice(result, offset)])
    }
    if (discriminant) {
      // The physical case cells must also be outside the discriminant's
      // environment, including direct eval and closures that escape it.
      result = join([part(`{const ${discriminant}=(`), emit(node.discriminant, candidates),
        part(');{'), initializations(node, candidates), result, part('}}')])
    }
    if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement' && introductions.has(node)) {
      const body = emit(node.body, candidates)
      const arrowEnd = callableMarkerPosition(node, code, tree.comments) + 2
      const head = []
      let headCursor = node.start
      for (const parameter of node.params) {
        head.push(original(headCursor, parameter.start), emit(parameter, candidates))
        headCursor = parameter.end
      }
      head.push(original(headCursor, arrowEnd))
      result = join([...head, part('{'), initializations(node, candidates), part('return ('), body, part(');}')])
    }
    return node.type === 'BlockStatement' && pieces.length(result) > 16384
      ? pieces.region(result, { kind: 'block', ...regionContext(node) }) : result
  }
  onPhase?.('emit')
  const transformed = emit(tree.program)
  onPhase?.('emitted')
  const adapter = decoratorContexts.size === 0 ? '' : `${target === 'module' ? '' : `const ${decoratorAdapter}=`}function ${decoratorAdapter}(decorator,receiver,name,isPrivate){return function(value,context){context.name=name;context.private=isPrivate;if(typeof value==="function")${intrinsics}.Object.defineProperty(value,"name",{value:(context.kind==="getter"?"get ":context.kind==="setter"?"set ":"")+name,configurable:true});if(!isPrivate){context.access={has:object=>name in object,...(context.kind==="setter"?{}:{get:object=>object[name]}),...(context.kind==="method"||context.kind==="getter"?{}:{set:(object,value)=>{object[name]=value}})}}return ${intrinsics}.Reflect.apply(decorator,receiver,[value,context])}}${target === 'module' ? '' : ';'}\n`
  const needsPrivateNames = [...privateClasses.values()].some(plan => [...plan.groups.values()]
    .some(group => [...group.targets.values()].some(owner => owner.nameReady)))
  const helper = intrinsicBootstrap(intrinsics, target, intrinsicContext) + adapter
    + (needsPrivateNames ? target === 'module' ? `var ${privateNames};\n` : `const ${privateNames}=${intrinsics}.weakSetStore();\n` : '')
    + (varReferenceMarker ? `const ${varReferenceMarker}=void 0;\n` : '')
    + (target === 'module' ? '' : `const ${factory}=`)
    + `function ${factory}(name,value,ready=false,get,set,lexical=false,readOnly=false){let target;return {get v(){if(target)return target.v;if(get)return get();if(!ready)throw new ${intrinsics}.ReferenceError("Cannot access '"+name+"' before initialization");return value},set v(next){if(lexical&&!ready)throw new ${intrinsics}.ReferenceError("Cannot access '"+name+"' before initialization");if(readOnly)throw new ${intrinsics}.TypeError("Assignment to constant variable.");this.initialize(next)},initialize(next){if(target){target.v=next;return}if(set){set(next);return}value=next;ready=true;get=void 0},ensure(){if(!ready&&!get)this.initialize(void 0)},commit(next){if(!ready)return;next.initialize(this.v);target=next},copy(){return ${factory}(name,this.v,true)}}}${target === 'module' ? '' : ';'}\n`
  const exports = moduleExports.size === 0 ? '' : `\nexport {${[...moduleExports].map(([name,group])=>`${group.accessor??group.publicName} as ${JSON.stringify(name)}`).join(',')}};`
  const directiveEnd=tree.program.directives.at(-1)?.end??0
  const body = pieces.slice(transformed, directiveEnd)
  const publications = [...rootPublications].map(([group, name]) => mapped(
    `function ${name}(value){${group.name}=value;}\n`, group.occurrences[0].node))
  const result = join([original(0,directiveEnd),part('\n'+helper), ...publications,
    initializations(tree.program,new Map()), body, part(exports)])
  const privateBindings = [...privateDeclarations].map(([node, declared]) => ({ scopeStart: node.start, scopeEnd: node.end,
    hiddenNames: [...declared].filter(name => typescript.internalPrivateNames?.has(name)),
    names: [...privateClasses.get(node)?.groups ?? []].filter(([name]) => !typescript.internalPrivateNames?.has(name)).map(([name, group]) => ({ name, bridgeExpression: privateBridge(group),
      targets: [...group.targets.values()].map(owner => ({ physicalName: owner.physical, static: owner.static, sourceStart: owner.last })) })) }))
  return finish({ outputPlan: { pieces, root: result, code, sourceMap,
    regionFacts: { allocate, decorated, resources, lexicalDynamic } },
  dynamicBindings, privateBindings,
  ...(protectedModule ? { moduleLexicalExports: new Set([...moduleExports].filter(([, group]) => active.has(group)).map(([name]) => name)) } : {}),
  internalBindings: new Set([factory, intrinsics, ...compilerLocalBindings, ...(decoratorContexts.size ? [decoratorAdapter] : []),
    ...(needsPrivateNames ? [privateNames] : [])]) })
}
