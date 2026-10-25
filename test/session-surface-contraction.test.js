import assert from 'node:assert/strict'
import test from 'node:test'

import { contractsLiveBindings, surfaceRewroteHistory } from '../internal/session-runtime.js'

// A republish that appends a call or re-renders the same history is not a
// history change: the call set only grows and every call keeps its source, so
// the worker and its bindings stay. Treating any generation bump as a rewrite is
// what made an ordinary capability observation reset the kernel mid-session.
test('a superset or identical surface never rewrites history', () => {
  const before = { seqs: new Set([2, 5]), sources: new Map([[2, 'a'], [5, 'b']]) }
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([2, 5, 8]),
    sources: new Map([[2, 'a'], [5, 'b'], [8, 'c']]),
  }), false)
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([2, 5]),
    sources: new Map([[2, 'a'], [5, 'b']]),
  }), false)
})

test('a removed call or a rewritten source is a history change', () => {
  const before = { seqs: new Set([2, 5]), sources: new Map([[2, 'a'], [5, 'b']]) }
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([5]),
    sources: new Map([[5, 'b']]),
  }), true)
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([2, 5]),
    sources: new Map([[2, 'a'], [5, 'rewritten']]),
  }), true)
})

test('without a comparable snapshot the discriminator decides nothing', () => {
  const before = { seqs: new Set([2]), sources: new Map([[2, 'a']]) }
  assert.equal(surfaceRewroteHistory(undefined, before), undefined)
  assert.equal(surfaceRewroteHistory(before, undefined), undefined)
})

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
