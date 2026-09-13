import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@babel/parser'
import { markCallableSources, collectRegionCallableRanges } from '../internal/callable-source-facts.js'
import { indexSourceRegions } from '../internal/compiler-region-output.js'
import { visitSource } from '../internal/compiler-source-regions.js'
import { adaptDynamicCell } from '../internal/dynamic-environment-integration.js'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { createDynamicScopeAnalysis } from '../internal/dynamic-scope-analysis.js'
import { identitySourceMap } from '../internal/source-position-map.js'

test('partitioned native adaptation carries exact nested callable ranges through environment insertion', () => {
  const source = `function outer(){${'void 0;'.repeat(6_000)}return function inner(){return 41}}`
  const options = { sourceType: 'script' }
  const marked = markCallableSources(source, undefined, options)
  const sourceRegions = indexSourceRegions(marked.code, options)
  const callableRanges = [...collectRegionCallableRanges({ ...marked, sourceRegions }, marked.callableSources, options).values()]
  const result = adaptDynamicCell(marked.code, identitySourceMap(marked.code.length), {
    sourceRegions, callableRanges, originalSource: marked.code, nativeRoot: true, environmentGlobal: 'environment',
  })
  assert.ok(result.sourceRegions.regions.length > 1)
  assert.equal(result.callableRanges.length, 2)
  const runtime = createDynamicEnvironmentRuntime()
  const outer = Function('environment', `${result.code};return outer`)(runtime.environment())
  const inner = outer()
  assert.equal(inner(), 41)
  for (const [index, callable] of [outer, inner].entries()) {
    const range = result.callableRanges.find(range => range.marker === marked.callableSources.entries[index].marker)
    assert.equal(result.code.slice(range.start, range.end), Function.prototype.toString.call(callable))
  }
})

test('direct eval containment keeps parameter requirements separate from shadow introduction', () => {
  const source = `function parameters(first=()=>eval('1'),second=2){return second}
function body(first=2){eval('var second=3');return ()=>second}
function strict(first=()=>{'use strict';return eval('1')}){return first}
function plain(first=()=>globalThis.eval('1')){return first}`
  const tree = parse(source)
  const analysis = createDynamicScopeAnalysis(tree)
  const [parameters, body, strict, plain] = tree.program.body
  assert.equal(analysis.containsDirectEval(parameters.params[0]), true)
  assert.equal(analysis.containsDirectEval(parameters.params[1]), false)
  assert.equal(analysis.containsDirectEval(body.params[0]), false)
  assert.equal(analysis.containsDirectEval(strict.params[0]), true)
  assert.equal(analysis.containsDirectEval(plain), false)
  const references = new Map()
  visitSource(tree, { ReferencedIdentifier(path) {
    if (path.node.name === 'second') references.set(path.parent.type, path)
  } })
  assert.equal(analysis.mayEvalShadow(references.get('ReturnStatement'), parameters), false)
  assert.equal(analysis.mayEvalShadow(references.get('ArrowFunctionExpression'), tree.program), true)
  const runtime = createDynamicEnvironmentRuntime()
  assert.deepEqual(runtime.evaluate(eval, undefined,
    [`${source};[parameters(),body()(),strict()(),plain()()]`], runtime.environment()), [2, 3, 1, 1])
})
