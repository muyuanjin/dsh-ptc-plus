import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from '@babel/parser'
import {
  RECORDED_LITERAL_MAX_DEPTH,
  RECORDED_LITERAL_MAX_ELEMENTS,
  RECORDED_LITERAL_MAX_PROPERTIES,
  boundedLiteralEvidence,
} from '../internal/bounded-literal.js'
import { prepareLegacyProgram } from '../internal/legacy-cell-analysis.js'

function initializer(source) {
  const file = parse(source, { sourceType: 'script', plugins: ['typescript'] })
  const statement = file.program.body.find(node => node.type === 'VariableDeclaration')
  return statement.declarations[0].init
}

test('a bounded object literal proves its own shape', () => {
  assert.deepEqual(boundedLiteralEvidence(initializer('const x = { a: 1 }')), { properties: 1, depth: 1 })
  assert.deepEqual(boundedLiteralEvidence(initializer('const y = { nested: { a: 1 }, list: [1, 2] }')),
    { properties: 2, depth: 1 })
  assert.deepEqual(boundedLiteralEvidence(initializer("const z = { name: 'a', ok: true, nothing: null }")),
    { properties: 3, depth: 1 })
})

test('shapes whose size the source does not fix produce no evidence', () => {
  for (const source of [
    'const a = new C()',
    'const b = make()',
    'const c = other',
    'const d = { ...spread }',
    'const e = { [key]: 1 }',
    'const f = { method() { return 1 } }',
    'const g = { fn: () => 1 }',
  ]) {
    assert.equal(boundedLiteralEvidence(initializer(source)), undefined, source)
  }
})

test('the property and element caps bound what may be recorded', () => {
  const keys = Array.from({ length: RECORDED_LITERAL_MAX_PROPERTIES + 1 }, (_, index) => `k${index}: ${index}`)
  assert.equal(boundedLiteralEvidence(initializer(`const big = { ${keys.join(', ')} }`)), undefined)
  const elements = Array.from({ length: RECORDED_LITERAL_MAX_ELEMENTS + 1 }, (_, index) => index)
  assert.equal(boundedLiteralEvidence(initializer(`const wide = { list: [${elements.join(', ')}] }`)), undefined)
})

test('nesting deeper than the cap produces no evidence', () => {
  let literal = '{ leaf: 1 }'
  for (let depth = 1; depth < RECORDED_LITERAL_MAX_DEPTH; depth += 1) literal = `{ inner: ${literal} }`
  assert.notEqual(boundedLiteralEvidence(initializer(`const deep = ${literal}`)), undefined)
  assert.equal(boundedLiteralEvidence(initializer(`const deeper = { inner: ${literal} }`)), undefined)
})

const PREPARATION = {
  bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
  rewritesEnabled: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
}

test('the legacy preparation carries the evidence on the declaration', () => {
  const prepared = prepareLegacyProgram("const receipt = { accepted: true, target: 141 }\nreturn receipt",
    PREPARATION)
  const declaration = prepared.declarations.find(entry => entry.name === 'receipt')
  assert.deepEqual(declaration.boundedLiteral, { properties: 2, depth: 1 })
})

test('a call initializer leaves the declaration without evidence', () => {
  const prepared = prepareLegacyProgram('const value = make()\nreturn value', PREPARATION)
  const declaration = prepared.declarations.find(entry => entry.name === 'value')
  assert.equal(declaration.boundedLiteral, undefined)
})
