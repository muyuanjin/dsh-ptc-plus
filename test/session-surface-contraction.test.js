import assert from 'node:assert/strict'
import test from 'node:test'

import { contractsLiveBindings } from '../internal/session-runtime.js'

// A live binding loses its provenance only when the surface was read and proves
// the call is gone. An unreadable surface — a queued message, a mid-flight
// replacement, any transient host state — is undecidable, and treating it as
// contraction reset the worker and replayed the session, which is how a queued
// message used to cost the user the whole REPL.
test('an unreadable surface never contracts live bindings', () => {
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5, 8]),
    visibleCallSeqs: new Set(),
    surfaceIsReadable: false,
  }), false)
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5, 8]),
    visibleCallSeqs: undefined,
    surfaceIsReadable: false,
  }), false)
})

test('a readable surface contracts only the calls it proves missing', () => {
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5]),
    visibleCallSeqs: new Set([2, 5, 8]),
    surfaceIsReadable: true,
  }), false)
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5]),
    visibleCallSeqs: new Set([5]),
    surfaceIsReadable: true,
  }), true)
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set(),
    visibleCallSeqs: new Set(),
    surfaceIsReadable: true,
  }), false)
})

// A readable surface that yields no set at all cannot prove anything either.
test('a readable surface without a visible set does not contract', () => {
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([3]),
    visibleCallSeqs: undefined,
    surfaceIsReadable: true,
  }), false)
})
