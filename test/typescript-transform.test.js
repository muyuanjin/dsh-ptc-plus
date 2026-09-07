import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformTypeScriptModule, USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'

test('records the exact installed compiler generation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(USER_BINDING_TRANSFORM, `amaro@${manifest.dependencies.amaro}`)
  assert.match(manifest.dependencies.amaro, /^\d+\.\d+\.\d+$/)
})

test('uses the current enum scope semantics rather than claiming native-transform equivalence', async () => {
  const source = 'enum E { A, B, C, D = ((C) => C)(10) }; export const out = E.D'
  const namespace = await import(`data:text/javascript,${encodeURIComponent(transformTypeScriptModule(source))}`)
  assert.equal(namespace.out, 10)
})

test('matches recorded native output for simple parameter properties and enums', () => {
  // Recorded from the previously supported native transform implementation.
  const fixtures = [
    ['export class Counter { constructor(public value: number) {} }',
      'export class Counter {\n    value;\n    constructor(value){\n        this.value = value;\n    }\n}\n'],
    ['export enum Value { One = 1, Two };export const answer: number = Value.Two',
      'export var Value = /*#__PURE__*/ function(Value) {\n    Value[Value["One"] = 1] = "One";\n    Value[Value["Two"] = 2] = "Two";\n    return Value;\n}({});\nexport const answer = 2;\n'],
  ]
  for (const [source, javascript] of fixtures) assert.equal(transformTypeScriptModule(source), javascript)
})

test('reports parser diagnostics as syntax errors and preserves programming errors', () => {
  assert.throws(() => transformTypeScriptModule('let = ;'), error => {
    assert.ok(error instanceof SyntaxError)
    assert.match(error.message, /Expression expected/)
    assert.equal(error.cause.code, 'InvalidSyntax')
    return true
  })
  assert.throws(() => transformTypeScriptModule(Symbol('source')), TypeError)
})
