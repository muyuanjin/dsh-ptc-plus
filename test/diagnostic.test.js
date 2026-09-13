import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnostic, normalizeDiagnostic, renderDiagnostic } from '../internal/diagnostic.js'

function valid(overrides = {}) {
  return {
    code: 'PTC-T001',
    severity: 'error',
    phase: 'execute',
    message: 'test failure',
    stateEffect: 'unchanged',
    ...overrides,
  }
}

test('normalizes, freezes, and renders every diagnostic component', () => {
  const input = valid({
    dispatchState: 'completed',
    source: {
      cell: 'current',
      start: { line: 2, column: 3 },
      end: { line: 2, column: 6 },
    },
    cause: { code: 'ENOENT', message: 'missing input' },
    help: ['check the path', 'retry the operation'],
  })
  const normalized = diagnostic(input)
  assert.notEqual(normalized, input)
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.source))
  assert.ok(Object.isFrozen(normalized.source.start))
  assert.ok(Object.isFrozen(normalized.source.end))
  assert.ok(Object.isFrozen(normalized.cause))
  assert.ok(Object.isFrozen(normalized.help))
  assert.equal(renderDiagnostic(normalized, 'first\n  abcdef\nthird'), [
    'error[PTC-T001]: test failure',
    ' --> current:2:3',
    '> 2 |   abcdef',
    '    |   ^^^',
    'phase: execute',
    'dispatch: completed',
    'state: unchanged',
    'cause: ENOENT: missing input',
    'help: check the path',
    'help: retry the operation',
  ].join('\n'))

  assert.equal(renderDiagnostic(valid({ cause: { message: 'plain cause' } })), [
    'error[PTC-T001]: test failure',
    'phase: execute',
    'state: unchanged',
    'cause: plain cause',
  ].join('\n'))
})

test('accepts nested diagnostics and all diagnostic enum values', () => {
  const severities = ['error', 'warning', 'note']
  const phases = ['parse', 'preflight', 'execute', 'tool-dispatch', 'replay', 'recover']
  const effects = ['unchanged', 'partially-applied', 'rolled-back', 'unknown']
  const dispatches = ['not-dispatched', 'dispatched', 'completed', 'unknown']
  for (let index = 0; index < phases.length; index += 1) {
    assert.doesNotThrow(() => normalizeDiagnostic(valid({
      severity: severities[index % severities.length],
      phase: phases[index],
      stateEffect: effects[index % effects.length],
      dispatchState: dispatches[index % dispatches.length],
    })))
  }
  const child = valid({ code: 'PTC-C002', message: 'child' })
  const parent = normalizeDiagnostic(valid({ cause: child }))
  assert.equal(parent.cause.code, 'PTC-C002')
  assert.equal(parent.cause.message, 'child')
})

test('rejects malformed diagnostic fields, positions, causes, and help', () => {
  const symbol = Symbol('extra')
  const cases = [
    [null, /invalid dsh-ptc-plus diagnostic/],
    [[valid()], /invalid dsh-ptc-plus diagnostic/],
    [{ ...valid(), extra: true }, /invalid dsh-ptc-plus diagnostic field extra/],
    [Object.defineProperty(valid(), 'message', { enumerable: false, value: 'hidden' }), /field message/],
    [Object.assign(valid(), { [symbol]: true }), /field Symbol\(extra\)/],
    [valid({ code: 'bad' }), /diagnostic code/],
    [valid({ severity: 'fatal' }), /invalid dsh-ptc-plus diagnostic$/],
    [valid({ phase: 'compile' }), /invalid dsh-ptc-plus diagnostic$/],
    [valid({ stateEffect: 'saved' }), /invalid dsh-ptc-plus diagnostic$/],
    [valid({ message: 'two\nlines' }), /invalid dsh-ptc-plus diagnostic$/],
    [valid({ dispatchState: 'pending' }), /dispatch state/],
    [valid({ source: null }), /diagnostic source/],
    [valid({ source: { cell: '', start: { line: 1, column: 1 } } }), /diagnostic source/],
    [valid({ source: { cell: 'x', start: null } }), /source start/],
    [valid({ source: { cell: 'x', start: { line: 0, column: 1 } } }), /source start/],
    [valid({ source: { cell: 'x', start: { line: 1, column: 0 } } }), /source start/],
    [valid({ source: { cell: 'x', start: { line: 1, column: 1, extra: true } } }), /field extra/],
    [valid({ source: { cell: 'x', start: { line: 2, column: 1 }, end: { line: 1, column: 1 } } }), /precedes/],
    [valid({ source: { cell: 'x', start: { line: 1, column: 2 }, end: { line: 1, column: 1 } } }), /precedes/],
    [valid({ cause: null }), /invalid diagnostic cause/],
    [valid({ cause: { code: 'bad\ncode', message: 'cause' } }), /cause code/],
    [valid({ cause: { message: '' } }), /cause message/],
    [valid({ cause: { message: 'cause', extra: true } }), /cause field extra/],
    [valid({ help: 'help' }), /diagnostic help/],
    [valid({ help: ['one', 'two', 'three', 'four'] }), /diagnostic help/],
    [valid({ help: ['bad\nhelp'] }), /diagnostic help/],
    [valid({ collisions: [] }), /diagnostic collisions/],
    [valid({ collisions: 'collisions' }), /diagnostic collisions/],
    [valid({ collisions: [null] }), /diagnostic collision/],
    [valid({ collisions: [{ name: '', kind: 'variable', reason: 'r', start: { line: 1, column: 1 } }] }), /diagnostic collision/],
    [valid({ collisions: [{ name: 'a', kind: 'variable', reason: '', start: { line: 1, column: 1 } }] }), /diagnostic collision/],
    [valid({ collisions: [{ name: 'a', kind: 'variable', reason: 'r', start: { line: 0, column: 1 } }] }), /collision start/],
    [valid({ collisions: [{ name: 'a', kind: 'variable', reason: 'r', start: { line: 1, column: 1 }, extra: 1 }] }), /collision field extra/],
  ]
  for (const [value, expected] of cases) assert.throws(() => normalizeDiagnostic(value), expected)

  let nested = valid()
  for (let index = 0; index < 18; index += 1) nested = valid({ cause: nested })
  assert.throws(() => normalizeDiagnostic(nested), /cause chain is too deep/)
})

test('keeps every collision reason in the structured diagnostic', () => {
  const normalized = normalizeDiagnostic(valid({ collisions: [
    { name: 'tools', kind: 'variable', reason: 'reserved-program-binding-not-shadowable', start: { line: 1, column: 1 } },
    { name: 'kept', kind: 'class', reason: 'protected-root-redeclaration',
      start: { line: 2, column: 1 }, end: { line: 2, column: 10 } },
  ] }))
  assert.ok(Object.isFrozen(normalized.collisions))
  assert.ok(Object.isFrozen(normalized.collisions[0]))
  assert.ok(Object.isFrozen(normalized.collisions[0].start))
  assert.deepEqual(normalized.collisions, [
    { name: 'tools', kind: 'variable', reason: 'reserved-program-binding-not-shadowable', start: { line: 1, column: 1 } },
    { name: 'kept', kind: 'class', reason: 'protected-root-redeclaration',
      start: { line: 2, column: 1 }, end: { line: 2, column: 10 } },
  ])
  assert.equal(Object.hasOwn(normalized.collisions[0], 'end'), false)
})
