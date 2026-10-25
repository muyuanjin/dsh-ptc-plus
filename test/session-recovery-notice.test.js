import assert from 'node:assert/strict'
import test from 'node:test'
import {
  restoredFromRecordDiagnostic,
  vanishedBindingDiagnostic,
} from '../internal/session-runtime.js'

// The notice is the model's only evidence about which restored bindings exist.
// A failed install named as live is worse than no notice: the next cell trusts a
// name that was never installed, and the failure looks like the model's mistake.

test('a restored notice keeps the cell count apart from the binding names', () => {
  const notice = restoredFromRecordDiagnostic(7, ['a', 'b', 'c'], [])
  assert.equal(notice.code, 'PTC-R004')
  assert.match(notice.message, /^Restored 7 cell\(s\) from recorded values; 3 binding\(s\) live: a, b, c\./)
  assert.match(notice.message, /recorded completions were not replayed/)
})

test('a failed install is reported as not live instead of being listed as live', () => {
  const notice = restoredFromRecordDiagnostic(4, ['a', 'b'], ['t8_value'])
  assert.match(notice.message, /2 binding\(s\) live: a, b/)
  assert.match(notice.message, /1 could not be installed and are NOT live: t8_value/)
  assert.doesNotMatch(notice.message, /live: a, b, t8_value/)
})

test('a later recovery only reports what it added', () => {
  const first = restoredFromRecordDiagnostic(4, ['a', 'b'], [])
  const second = restoredFromRecordDiagnostic(3, ['c'], [], true)
  assert.match(first.message, /^Restored 4 cell\(s\)/)
  assert.match(second.message, /^Restored another 3 cell\(s\)/)
  assert.match(second.message, /1 binding\(s\) live: c/)
  assert.doesNotMatch(second.message, /a, b/)
})

test('a binding that stops existing is named as lost outside the cell', () => {
  const notice = vanishedBindingDiagnostic(['t10_text'])
  assert.equal(notice.code, 'PTC-R006')
  assert.match(notice.message, /t10_text/)
  assert.match(notice.message, /no longer available/)
  assert.deepEqual(notice.help, ['redeclare t10_text before using them again'])
})
