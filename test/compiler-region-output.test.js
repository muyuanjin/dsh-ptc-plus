import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { createCallableSourceRegistry } from '../internal/callable-source-catalog.js'
import { markCallableSources, collectRegionCallableRanges, emitRegionCallableSources,
  callableSourceCatalog } from '../internal/callable-source-facts.js'
import { indexSourceRegions, regionInput, transformRegionSource, validateRegionSource } from '../internal/compiler-region-output.js'
import { identitySourceMap } from '../internal/source-position-map.js'
import { transformTypeScriptSource } from '../internal/typescript-transform.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'

test('protected CommonJS retains bounded regions when bootstrap names need no root adaptation', () => {
  const body = Array.from({ length: 800 }, (_, index) => `function value${index}(){return ${index}}`).join('\n')
  for (const extra of ['', 'function nested(process){return process}']) {
    const code = `${body}\n${extra}`
    const prepared = normalizeStatefulScopes(code, undefined, { mode: 'protected-v1', target: 'commonjs', nativeJavaScript: true })
    assert.equal(prepared.code, code)
    assert.ok(prepared.sourceRegions.regions.length > 0)
    validateRegionSource(prepared, { sourceType: 'commonjs' })
  }
})

const emit = source => {
  const marked = markCallableSources(source)
  const options = { sourceType: 'script' }
  const mapped = { ...marked, sourceMap: identitySourceMap(marked.code.length),
    sourceRegions: indexSourceRegions(marked.code, options) }
  const owners = collectRegionCallableRanges(mapped, marked.callableSources, options)
  let regions = 0
  const emitted = transformRegionSource(mapped, options, input => {
    regions++
    return emitRegionCallableSources(input, transformTypeScriptSource(input.code, {
      sourceMap: true, module: false, transform: { noEmptyExport: true },
    }), owners, options)
  })
  validateRegionSource(emitted, options)
  const registry = createCallableSourceRegistry()
  registry.register(callableSourceCatalog(emitted.code, marked.callableSources, emitted.callableRanges))
  return { ...emitted, regions, registry }
}

test('private source regions require their actual enclosing class names', () => {
  const source = '{return this.#value}'
  const options = { sourceType: 'script' }
  const input = regionInput(source, { start: 0, end: source.length, kind: 'block',
    children: [], privateNames: ['value'] }, options)
  const generated = transformTypeScriptSource(input.code, { sourceMap: true,
    module: false, transform: { noEmptyExport: true } })
  const emitted = emitRegionCallableSources(input, generated, new Map(), options)
  assert.equal(Function(`class Box{#value=7;read()${emitted.code}}return new Box().read()`)(), 7)
  assert.throws(() => emitRegionCallableSources({ ...input,
    region: { ...input.region, privateNames: [] } }, generated, new Map(), options), /Private name #value/)
})

test('bounded emission retains parent and child callable spans across discarded grammar envelopes', () => {
  const nested = 'function nested(){return 17}'
  const outer = `function outer(){${'0;\n'.repeat(14000)}return ${nested}}`
  const source = `${outer}\nouter`
  const output = emit(source)
  assert.ok(output.regions > 3)
  const callable = runInNewContext(output.code)
  assert.equal(callable()(), 17)
  assert.equal(output.registry.get(Function.prototype.toString.call(callable)), outer)
  assert.equal(output.registry.get(Function.prototype.toString.call(callable())), nested)
  assert.equal(output.callableRanges.length, 2)
  for (const fact of output.callableRanges) {
    const generated = output.code.slice(fact.start, fact.end)
    assert.ok(output.registry.get(generated))
    assert.equal(output.registry.get(`${generated} `), undefined)
  }
})

test('region indexing carries private class names through outlined method bodies', () => {
  const method = `read(){${'0;\n'.repeat(14000)}return this.#value}`
  const shape = `class Box{#value=41;${method}}`
  const output = emit(`${shape};[Box,new Box()]`)
  assert.ok(output.regions > 3)
  const [Box, value] = runInNewContext(output.code)
  assert.equal(value.read(), 41)
  assert.equal(output.registry.get(Function.prototype.toString.call(Box)), shape)
  assert.equal(output.registry.get(Function.prototype.toString.call(Box.prototype.read)), method)
})

test('callable ranges distinguish static methods, classes, arrows and marker-like user comments', () => {
  const shape = 'class Shape{static method(){return 19}read(){return 23}}'
  const arrow = '() => 29'
  const source = `${shape};const arrow=${arrow};/*__dsh_ptc_callable_unowned__*/[Shape,Shape.method,Shape.prototype.read,arrow]`
  const output = emit(source)
  const callables = runInNewContext(output.code)
  assert.deepEqual(Array.from(callables, value => output.registry.get(Function.prototype.toString.call(value))),
    [shape, 'method(){return 19}', 'read(){return 23}', arrow])
  assert.equal(output.callableRanges.length, 4)
})

test('complete module preflight rejects exports absent from all declaration regions', () => {
  assert.throws(() => compileStatefulModule('export { missing }'), /Export 'missing' is not defined/)
})

test('instrumented IIFE boundaries retain invocation arguments outside an outlined body', () => {
  const source = `module.exports=(()=>{${'0;\n'.repeat(14000)}return 31})()`
  const output = compileStatefulModule(source, { target: 'commonjs' })
  const module = { exports: undefined }
  Function('module', 'require', output.code)(module, createRequire(import.meta.url))
  assert.equal(module.exports, 31)
})

test('source trailing line comments cannot consume a grammar envelope', () => {
  const output = compileStatefulModule('module.exports=37;//# sourceMappingURL=source.js.map', { target: 'commonjs' })
  const module = { exports: undefined }
  Function('module', 'require', output.code)(module, createRequire(import.meta.url))
  assert.equal(module.exports, 37)
})
