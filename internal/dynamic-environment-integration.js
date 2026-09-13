import { commonJsCompilerImport } from './compiler-module-links.js'
import { createHash } from 'node:crypto'
import { createGeneratedNameAllocator } from './binding-pattern.js'
import { compileDynamicEnvironmentSource } from './dynamic-environment-compiler.js'
import { applySourceEdits, mappedSourceTransform, mapSourceSpan, sourceLineStarts, sourceTextAtSpan, sourceOffsetAt } from './source-position-map.js'
import { visitRegionSource, applyRegionEdits } from './compiler-region-output.js'
import { visitSource } from './compiler-source-regions.js'

/** Keep dynamic name resolution behind the lexical facts of the cell compiler. */
export function adaptDynamicCell(code, sourceMap, options) {
  const parserOptions = { sourceType: options.sourceType ?? 'script',
    ...(options.sourceType === 'commonjs' ? {} : { allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }),
    plugins: options.parserPlugins }
  let rootEnd, directiveEnd, strict, allocate
  let lexicalDynamic = options.sourceRegions?.lexicalDynamic ?? false
  const discoverDynamics = options.sourceRegions?.lexicalDynamic === undefined
  const inspectRegion = region => region.kind === 'program' || discoverDynamics || options.rootRuntime !== undefined
  visitRegionSource({ code, sourceMap, sourceRegions: options.sourceRegions }, parserOptions, input => {
    allocate ??= options.sourceRegions?.allocate ?? createGeneratedNameAllocator(input.tree, options.reservedBindings ?? [])
    if (input.region.kind === 'program') {
      directiveEnd = input.tree.program.directives.at(-1)?.end ?? input.tree.program.interpreter?.end ?? 0
      strict = input.tree.program.directives.some(directive => directive.value.value === 'use strict')
    }
    if (discoverDynamics || options.rootRuntime !== undefined) visitSource(input.tree, {
      VariableDeclarator(path) {
        if (path.node.id.name === options.rootRuntime) rootEnd = sourceOffsetAt(input.sourceMap, path.parent.end - 1) + 1
      },
      CallExpression(path) { if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'eval') lexicalDynamic = true },
      WithStatement() { lexicalDynamic = true },
    })
  }, inspectRegion)
  const environmentName = allocate('dynamic_environment')
  let expression
  let setup
  if (options.module === true) {
    const runtimeUrl = new URL('./dynamic-environment-runtime.js', import.meta.url)
    if (options.sourceType === 'module') {
      const factory = allocate('dynamic_factory')
      setup = `\nimport {createDynamicEnvironmentRuntime as ${factory}} from ${JSON.stringify(runtimeUrl.href)};\n`
      expression = `${factory}(${options.importOperation === undefined ? '' : `{importModule:${options.importOperation}}`}).installIntrinsics().environment({strict:true,getThis:()=>void 0})`
      options = { ...options, internalBindings: new Set([...options.internalBindings ?? [], factory]) }
    } else {
      const names = ['exports', 'module', 'require', '__filename', '__dirname', 'arguments']
      const bindings = names.map(name => `[${JSON.stringify(name)},{kind:"param",get:()=>${name}${name === 'arguments' && strict ? '' : `,set:v=>${name}=v`}}]`).join(',')
      setup = `\nconst ${environmentName}=${commonJsCompilerImport(runtimeUrl)}.createDynamicEnvironmentRuntime(${options.importOperation === undefined ? '' : `{importModule:${options.importOperation}}`}).installIntrinsics().environment({strict:${strict},getThis:()=>this,getNewTarget:()=>new.target,allowNewTarget:true,nativeBindings:[${bindings}]});\n`
    }
  } else setup = options.nativeRoot === true ? `\nconst ${environmentName}=${options.environmentGlobal};\n`
    : `\nconst ${environmentName}=${options.rootRuntime}.dynamic();\n`
  const insertion = options.module === true || options.nativeRoot === true
    ? directiveEnd : rootEnd
  const framed = applyRegionEdits({ code, sourceMap, sourceRegions: options.sourceRegions }, [{ start: insertion, end: insertion, text: setup }])
  const callableRanges = options.callableRanges?.map(range => ({ ...range,
    start: range.start >= insertion ? range.start + setup.length : range.start,
    end: range.end > insertion ? range.end + setup.length : range.end }))
  const dynamicOrigins = []
  const sourceIdentity = createHash('sha256').update(options.originalSource).digest('hex')
  const originalLineStarts = sourceLineStarts(options.originalSource)
  const coordinates = { generatedStarts: sourceLineStarts(framed.code), originalStarts: originalLineStarts }
  const evalOrigin = node => {
    const definitionSpan = mapSourceSpan({ line: node.loc.start.line, column: node.loc.start.column + 1,
      end: { line: node.loc.end.line, column: node.loc.end.column + 1 } }, framed.code, options.originalSource, framed.sourceMap, coordinates)
    const target = `eval:${sourceIdentity}:${definitionSpan.line}:${definitionSpan.column}`
    dynamicOrigins.push({ target, definitionSpan })
    return target
  }
  const writeTarget = node => {
    const position = mapSourceSpan({ line: node.loc.start.line, column: node.loc.start.column + 1 },
      framed.code, options.originalSource, framed.sourceMap, coordinates)
    return `write:${sourceIdentity}:${position.line}:${position.column}:${node.name}`
  }
  const calleeSource = node => sourceTextAtSpan(options.originalSource, mapSourceSpan({
    line: node.loc.start.line, column: node.loc.start.column + 1,
    end: { line: node.loc.end.line, column: node.loc.end.column + 1 },
  }, framed.code, options.originalSource, framed.sourceMap, coordinates), originalLineStarts)
  const result = compileDynamicEnvironmentSource(framed.code, { cell: { ...options, environmentName,
    sourceRegions: framed.sourceRegions,
    callableRanges,
    staticOnly: !lexicalDynamic && options.logicalRoots !== true,
    calleeSource,
    environmentExpression: expression, evalOrigin: options.module === true ? undefined : evalOrigin,
    writeTarget: options.module === true ? undefined : writeTarget } })
  const emission = result.sourceOffsets === undefined
    ? mappedSourceTransform(framed.code, framed.sourceMap, { code: result.code, map: result.sourceMap })
    : applySourceEdits(framed.code, framed.sourceMap, [{ start: 0, end: framed.code.length, text: result.code, mappings: result.sourceOffsets }])
  return { ...emission, sourceRegions: result.sourceRegions, callableRanges: result.callableRanges,
    dynamicOrigins, dynamicEnvironmentName: environmentName }
}
