import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@babel/parser'
import { compileStatefulModule, detectModuleSourceFormat, attachModuleNamespace,
  commonJsExportEvidence, linkCommonJsEvidenceSource } from '../internal/module-compilation.js'
import { compilerModuleReference } from '../internal/compiler-module-links.js'
import { resolveStatefulModuleLink } from '../internal/stateful-module-runtime.js'
import { createCommonJsEvidence } from '../internal/commonjs-export-evidence.js'
import { createCallableSourceRegistry } from '../internal/callable-source-catalog.js'
import { USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'

test('protected module normalization retains native default function identity and hoisting', async () => {
  for (const name of ['', 'named']) for (const resources of ['', 'using resource=null;']) {
    const source = `${resources}export const before=typeof ${name || 'later'};export function observe(){return before};export default function ${name}(){return 42};var later=1`
    const normalized = normalizeStatefulScopes(source, undefined, { target: 'module', mode: 'protected-v1' })
    // A null resource adds no effects; the baseline also runs on Node 22.
    const native = await import(`data:text/javascript,${encodeURIComponent(source.slice(resources.length))}`)
    const actual = await import(`data:text/javascript,${encodeURIComponent(normalized.code)}`)
    assert.equal(actual.observe(), native.observe())
    assert.equal(actual.default.name, native.default.name)
    assert.equal(actual.default(), native.default())
  }
})

test('pure module normalization preserves quoted export names and the final source mapping', () => {
  const prepared = compileStatefulModule('let value=1;export {value as "quoted name"};value=2;export {value as "quoted name"}')
  assert.equal(prepared.moduleInterface.exports.filter(entry => entry.name === 'quoted name').length, 1)
  assert.doesNotThrow(() => parse(prepared.code, { sourceType: 'module' }))
  const forwarded = compileStatefulModule('export {"quoted name" as "forwarded name"} from "./source.mjs"')
  assert.ok(forwarded.staticLinks.includes('./source.mjs'))
  assert.ok(forwarded.moduleInterface.exports.some(entry => entry.name === 'forwarded name'))
})

test('pure module compilation returns linker and source-registration facts without installing runtime links', () => {
  const source = 'data:text/javascript,export const pureOnly=42#pure-module-compiler'
  const prepared = compileStatefulModule(`import {pureOnly} from ${JSON.stringify(source)};
    export function read(){return eval('pureOnly')}`)
  assert.ok(prepared.staticLinks.includes(source))
  assert.equal(resolveStatefulModuleLink(compilerModuleReference('static', source), {}), undefined)
  assert.ok(prepared.code.includes(compilerModuleReference('static', source)))
  assert.ok(prepared.callableSources.length > 0)
  assert.equal(prepared.sourceRegions?.allocate, undefined)
  assert.equal(structuredClone(prepared).code, prepared.code)
  const registry = createCallableSourceRegistry()
  registry.register(prepared.callableSources)
  const tree = parse(prepared.code, { sourceType: 'module' })
  const read = tree.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'read')
  assert.equal(registry.get(prepared.code.slice(read.start, read.end)), "function read(){return eval('pureOnly')}")
})

test('pure syntax classification leaves filesystem policy to the loader', () => {
  assert.equal(detectModuleSourceFormat('module.exports=1'), 'commonjs')
  assert.equal(detectModuleSourceFormat('export const value=1'), 'module')
  assert.equal(detectModuleSourceFormat('const require=1'), 'module')
  assert.equal(detectModuleSourceFormat('class module{}'), 'module')
  assert.equal(detectModuleSourceFormat('export interface Value{}; module.exports=1', { extension: '.ts' }), 'commonjs')
})

test('module compiler output crosses a data-only boundary for every persisted transform', () => {
  for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
    for (const target of ['module', 'commonjs']) {
      const source = target === 'module' ? 'export const value:number=1' : 'const value:number=1;module.exports=value'
      const prepared = compileStatefulModule(source, { transform, target })
      const copied = structuredClone(prepared)
      assert.equal(copied.code, prepared.code)
      assert.deepEqual(copied.staticLinks, prepared.staticLinks)
      assert.deepEqual(copied.callableSources, prepared.callableSources)
      assert.equal(copied.sourceRegions?.allocate, undefined)
    }
  }
})

test('pure namespace attachment consumes an allocated link without reading exports', () => {
  const reference = compilerModuleReference('self', 'pure-test')
  const attached = attachModuleNamespace('export let value=1', { type: 'json' }, reference)
  const tree = parse(attached, { sourceType: 'module' })
  assert.equal(tree.program.body[0].type, 'ExportNamedDeclaration')
  assert.equal(tree.program.body[1].source.value, reference)
  assert.equal(tree.program.body[1].attributes[0].value.value, 'json')
  assert.ok(attached.includes('recordStatefulModuleNamespace'))
})

test('CommonJS evidence source generation remains pure and can be injected into its runtime owner', () => {
  const source = 'exports.value=(1 as number);module.exports=require("provider");'
  const evidence = commonJsExportEvidence(source)
  const linked = linkCommonJsEvidenceSource(evidence, 'private:')
  assert.ok(linked.includes('require("private:provider")'))
  assert.ok(!linked.includes('as number'))
  let received
  const owner = createCommonJsEvidence({ linkSource(source, prefix) {
    received = { source, prefix }
    return linkCommonJsEvidenceSource(source, prefix)
  } })
  const attached = owner.attach('file:///pure-commonjs.cjs', 'module.exports=1', evidence)
  assert.equal(received.source, evidence)
  assert.ok(received.prefix.startsWith('ptc-module:evidence-link/'))
  assert.ok(attached.includes('if(false)module.exports=require('))
})
