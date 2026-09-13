import assert from 'node:assert/strict'
import test from 'node:test'
import { createCompilerSourceCache } from '../internal/compiler-source-cache.js'
import { exportedSymbols, sourceDurability } from '../internal/compiler-service.js'
import { USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM } from '../internal/module-transform-contract.js'

test('source metadata reuse requires exact source text and transform generation', () => {
  let calls = 0
  const read = createCompilerSourceCache((source, transform) => ({ source, transform, call: ++calls }))
  assert.equal(read('source', 'current').call, 1)
  assert.equal(read('source', 'current').call, 1)
  assert.equal(read('source', 'legacy').call, 2)
  assert.equal(read('revised', 'current').call, 3)
  assert.equal(read('source').call, 4)
  assert.equal(read('source').call, 4)
})

test('mutating returned metadata cannot change later source validation', () => {
  const read = createCompilerSourceCache(() => new Map([['value', { names: ['original'] }]]))
  const first = read('source')
  first.get('value').names[0] = 'mutated'
  first.set('invented', {})
  assert.deepEqual(read('source'), new Map([['value', { names: ['original'] }]]))
  read('source').clear()
  assert.equal(read('source').size, 1)
})

test('metadata retention is bounded by both entry count and source characters', () => {
  let calls = 0
  const read = createCompilerSourceCache(() => ++calls, { maxEntries: 2, maxCharacters: 40 })
  assert.equal(read('a'), 1)
  assert.equal(read('b'), 2)
  assert.equal(read('a'), 1)
  assert.equal(read('c'), 3)
  assert.equal(read('b'), 4)
  assert.equal(read('longer source text'), 5)
  assert.equal(read('c'), 6)
  assert.equal(read('x'.repeat(41)), 7)
  assert.equal(read('x'.repeat(41)), 8)
})

test('uncacheable inputs and failed analyses keep the original validation behavior', () => {
  let calls = 0
  const failure = new Error('invalid source')
  const read = createCompilerSourceCache((source, transform) => {
    calls++
    if (source === 'invalid') throw failure
    return { source, transform }
  })
  assert.deepEqual(read(null), { source: null, transform: undefined })
  assert.deepEqual(read('source', null), { source: 'source', transform: null })
  assert.throws(() => read('invalid'), error => error === failure)
  assert.throws(() => read('invalid'), error => error === failure)
  assert.equal(calls, 4)
})

test('a zero retention limit disables caching without preventing analysis', () => {
  let calls = 0
  const read = createCompilerSourceCache(() => ++calls, { maxEntries: 0 })
  assert.equal(read('source'), 1)
  assert.equal(read('source'), 2)
})

test('private compiler metadata reuse preserves source changes and historical rejection', () => {
  const source = 'export function metadataProbe(){let value=1;let value=2;return value}'
  const first = exportedSymbols(source, USER_BINDING_TRANSFORM)
  first.get('metadataProbe').name = 'forged'
  assert.equal(exportedSymbols(source, USER_BINDING_TRANSFORM).get('metadataProbe').name, 'metadataProbe')
  const durability = sourceDurability(source, USER_BINDING_TRANSFORM)
  durability.durability = 'forged'
  assert.notEqual(sourceDurability(source, USER_BINDING_TRANSFORM).durability, 'forged')
  assert.throws(() => exportedSymbols(source, LEGACY_USER_BINDING_TRANSFORM), SyntaxError)
  assert.throws(() => sourceDurability(source, LEGACY_USER_BINDING_TRANSFORM))
  const revised = 'export const revisedMetadataProbe = process.env.EXAMPLE'
  assert.equal(exportedSymbols(revised, USER_BINDING_TRANSFORM).has('metadataProbe'), false)
  assert.equal(sourceDurability(revised, USER_BINDING_TRANSFORM).durability, 'volatile')
})
