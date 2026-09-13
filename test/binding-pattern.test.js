import assert from 'node:assert/strict'
import test from 'node:test'
import { parse as parseAcorn } from 'acorn'
import { parse as parseBabel } from '@babel/parser'
import { createGeneratedNameAllocator } from '../internal/binding-pattern.js'

test('generated identifiers reserve decoded names in Babel and Acorn statement arrays', () => {
  const source = String.raw`const {value: __dsh_ptc_helper_0__} = {
    [__dsh_ptc_helper_1__]: () => __dsh_ptc_helper_2__,
    optional: root?.[__dsh_ptc_helper_\u0033__]
  }`
  const roots = [parseBabel(source).program, parseAcorn(source, { ecmaVersion: 'latest' })]
  for (const root of roots) for (const input of [root, root.body]) {
    const allocate = createGeneratedNameAllocator(input, ['__dsh_ptc_helper_4__'])
    assert.equal(allocate('helper'), '__dsh_ptc_helper_5__')
    assert.equal(allocate('helper'), '__dsh_ptc_helper_6__')
  }
})

test('compact generated identifiers share source and caller reservations across purposes', () => {
  const allocate = createGeneratedNameAllocator(parseAcorn('({value: __ptc$0, chain: root?.[__ptc$1]})', {
    ecmaVersion: 'latest',
  }).body, ['__ptc$2'], { compact: true })
  assert.equal(allocate('environment'), '__ptc$3')
  assert.equal(allocate('reference'), '__ptc$4')
})
