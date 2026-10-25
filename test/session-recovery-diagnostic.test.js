import assert from 'node:assert/strict'
import test from 'node:test'

import { recoveryDiagnosticMessage } from '../internal/session-runtime.js'
import { bindingNamesOfOperations } from '../internal/session-journal-recovery.js'

// A contraction that reports only "N cells" leaves the model guessing which
// names it must stop referencing. The journal already names every binding it
// wrote, so the notice carries those names and drops the cell count.
test('a contraction names the bindings it dropped', () => {
  assert.equal(
    recoveryDiagnosticMessage(['greeting', 'total'], 2),
    'Restored the durable head and dropped 2 binding(s) (greeting, total) that no recorded value proves; their source remains in the session log.',
  )
  assert.equal(
    recoveryDiagnosticMessage(['greeting', 'greeting', 'total'], 2),
    'Restored the durable head and dropped 2 binding(s) (greeting, total) that no recorded value proves; their source remains in the session log.',
  )
})

// Without journal names — an empty recovery, an unreadable record — the notice
// must not invent binding names.
test('a contraction without journal names keeps the cell-count wording', () => {
  assert.equal(
    recoveryDiagnosticMessage([], 3),
    'Restored the durable head and skipped 3 unreconstructable historical cell(s); their source remains in the session log.',
  )
  assert.match(recoveryDiagnosticMessage(undefined, 1), /skipped 1 unreconstructable historical cell/)
  assert.match(recoveryDiagnosticMessage([null, ''], 2), /skipped 2 unreconstructable historical cell/)
})

// Only `save` creates a binding; `delete` and `restore` must not be reported as
// dropped names, because the model would then stop referencing a name that the
// contraction never took away.
test('binding names come from the saves a journal recorded', () => {
  // A checkpoint save and a binding save share the `save` shape, so the kind is what
  // separates a branch name from a binding name. An untagged save is a checkpoint,
  // which is what every operation recorded before the kind existed came from.
  assert.deepEqual(
    bindingNamesOfOperations([
      { action: 'save', name: 'greeting', kind: 'binding' },
      { action: 'save', name: 'branch', kind: 'checkpoint' },
      { action: 'save', name: 'total', kind: 'binding' },
      { action: 'save', name: 'legacy' },
      { action: 'delete', name: 'greeting' },
      { action: 'restore' },
    ]),
    ['greeting', 'total'],
  )
  assert.deepEqual(bindingNamesOfOperations([]), [])
  assert.deepEqual(bindingNamesOfOperations(undefined), [])
})

test('a recorded rewind reports the bindings it ended, apart from a loss', async () => {
  const { rewindEndedDiagnostic } = await import('../internal/session-runtime.js')
  const diagnostic = rewindEndedDiagnostic(['abandoned', 'stale'])
  assert.equal(diagnostic.code, 'PTC-R005')
  assert.equal(diagnostic.severity, 'warning')
  assert.equal(diagnostic.phase, 'recover')
  assert.match(diagnostic.message, /Dropped 2 binding\(s\) \(abandoned, stale\) because a recorded rewind ended them/u)
  // The notice must not be confused with a genuine loss: it says the record ended
  // them, and it names them instead of only counting.
  assert.doesNotMatch(diagnostic.message, /unreconstructable|no recorded value proves/u)
})
