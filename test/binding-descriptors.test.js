import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBindingDescriptors } from '../internal/binding-descriptors.js'

test('normalizes live binding callables and derives both consumer views', () => {
  const functions = Object.create(null)
  Object.defineProperty(functions, 'read', { value: () => 1 })
  const normalized = normalizeBindingDescriptors([
    {
      global: 'tools',
      functions,
      emptyObjectMembers: ['read'],
      errorClass: { name: 'ToolError', memberNameProperty: 'toolName' },
    },
    { global: 'capabilities', functions: { find: () => 2 } },
  ])

  assert.equal(normalized.namespaces[0].functions, functions)
  assert.deepEqual(normalized.workerDescriptors, [
    {
      global: 'tools',
      members: ['read'],
      emptyObjectMembers: ['read'],
      errorClass: { name: 'ToolError', memberNameProperty: 'toolName' },
    },
    { global: 'capabilities', members: ['find'], shadowable: true },
  ])
  assert.deepEqual([...normalized.reservedNames].sort(), ['ToolError', 'tools'])
})

test('rejects malformed binding descriptors before projection', () => {
  const invalid = [
    [null, /bindings must be an array/],
    [[null], /binding namespace must be an object/],
    [[{ global: '', functions: {} }], /global must be a non-empty string/],
    [[{ global: 'api', functions: null }], /functions must be an object/],
    [[{ global: 'api', functions: { call: 1 } }], /not an own callable value/],
    [[{ global: 'api', functions: Object.defineProperty({}, 'call', { get() { return () => 1 } }) }], /not an own callable value/],
    [[{ global: 'api', functions: {}, errorClass: { name: 'ApiError' } }], /memberNameProperty/],
    [[{ global: 'api', functions: {}, emptyObjectMembers: [] }], /must be an array for tools/],
    [[{ global: 'tools', functions: {}, emptyObjectMembers: null }], /must be an array for tools/],
    [[{ global: 'tools', functions: { call() {} }, emptyObjectMembers: ['missing'] }], /unknown member/],
    [[{ global: 'tools', functions: { call() {} }, emptyObjectMembers: ['call', 'call'] }], /duplicate member/],
    [[{ global: 'tools', functions: { call() {} }, emptyObjectMembers: [''] }], /must be a non-empty string/],
    [[{ global: 'api', functions: {} }, { global: 'api', functions: {} }], /duplicate binding namespace global/],
  ]
  for (const [value, expected] of invalid) {
    assert.throws(() => normalizeBindingDescriptors(value), expected)
  }

  const symbols = Object.create(null)
  symbols[Symbol('call')] = () => 1
  assert.throws(
    () => normalizeBindingDescriptors([{ global: 'api', functions: symbols }]),
    /member names must be non-empty strings/,
  )
})
