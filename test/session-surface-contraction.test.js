import assert from 'node:assert/strict'
import test from 'node:test'

import { comparableVisibleCalls, contractsLiveBindings, replacementAppliedSince, surfaceRewroteHistory, windowedOldest } from '../internal/session-runtime.js'

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

// A windowed surface drops the oldest calls and keeps the newest: the kernel
// still holds them, so rebuilding would lose bindings the host never rewrote.
// Losing the newest call, or a call inside the visible range, is a real rewrite.
test('a windowed suffix is a trim while an inner or newest removal is a rewrite', () => {
  const before = { seqs: new Set([2, 5, 9]), sources: new Map([[2, 'a'], [5, 'b'], [9, 'c']]) }
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([5, 9]),
    sources: new Map([[5, 'b'], [9, 'c']]),
  }), false)
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([2, 9]),
    sources: new Map([[2, 'a'], [9, 'c']]),
  }), true)
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([2, 5]),
    sources: new Map([[2, 'a'], [5, 'b']]),
  }), true)
  assert.equal(surfaceRewroteHistory(before, {
    seqs: new Set([2, 5, 9]),
    sources: new Map([[2, 'a'], [5, 'rewritten'], [9, 'c']]),
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
  // A surface that stopped listing the newest held call is not a window: it
  // proves that call is gone, so the older contract still decides.
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5, 9]),
    visibleCallSeqs: new Set([5]),
    surfaceIsReadable: true,
  }), true)
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set(),
    visibleCallSeqs: new Set(),
    surfaceIsReadable: true,
  }), false)
})

// The window is bounded by the oldest call the surface still lists, which need not
// be one the kernel holds. Real session session-2ec22082 held call 110 while the
// surface listed 120 and 130: requiring the bound itself to be held read that as
// "not a window" and rebuilt the kernel, dropping bindings the surface never
// disproved.
test('a window whose oldest entry the kernel does not hold still bounds the window', () => {
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([110, 130]),
    visibleCallSeqs: new Set([120, 130]),
    surfaceIsReadable: true,
  }), false)
  // A held call at or above the bound that the surface stopped listing is still
  // proof it is gone.
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([110, 130]),
    visibleCallSeqs: new Set([120]),
    surfaceIsReadable: true,
  }), true)
  // A surface that does not list the newest held call is not a window.
  assert.equal(windowedOldest({
    liveCallSeqs: new Set([110, 130]),
    visibleCallSeqs: new Set([120]),
  }), undefined)
})

// A readable surface that yields no set at all cannot prove anything either.
test('a readable surface without a visible set does not contract', () => {
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([3]),
    visibleCallSeqs: undefined,
    surfaceIsReadable: true,
  }), false)
})

// Both sides of the comparison must name the same kind of thing: top-level REPL
// calls. A derived execution starts from a record that can be a result or a nested
// dispatch, and the kernel never tracks those as live calls; keeping them in the
// visible domain made a vanished non-call look like a rewritten history and reset
// the worker, dropping bindings the edit never touched.
test('a derived start record that is not a call never enters the compared domain', () => {
  const events = [
    { seq: 2, type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"a"}' } },
    { seq: 103, type: 'tool/result', data: { callId: 'c1' } },
    { seq: 132, type: 'tool/ptc-dispatch', data: { name: 'working_directory' } },
    { seq: 140, type: 'tool/call', data: { name: 'edit_run_code', arguments: '{"edits":[]}' } },
  ]
  const comparable = comparableVisibleCalls(events, new Set([2, 103, 132, 140]))
  assert.deepEqual([...comparable.seqs].sort((a, b) => a - b), [2, 140])
  assert.equal(comparable.sources.size, 2)

  const before = comparable
  const after = comparableVisibleCalls(events, new Set([2, 140]))
  assert.equal(surfaceRewroteHistory(before, after), false)
})

// A windowed surface keeps the newest calls and stops listing the oldest ones.
// The kernel still holds those older calls, so their absence is unknown rather
// than proof of loss: rebuilding there drops bindings the host never rewrote,
// which is what a working-directory republish used to do.
test('a windowed surface leaves the calls below its oldest entry unknown', () => {
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5, 9, 14, 20]),
    visibleCallSeqs: new Set([14, 20]),
    surfaceIsReadable: true,
  }), false)
})

// An interior gap, an empty set or a missing newest call is not a window: the
// surface covers the range it lists, so a held call it omits is lost.
test('an interior gap, an empty set or a missing newest call still contracts', () => {
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([5, 9, 14, 20]),
    visibleCallSeqs: new Set([5, 14, 20]),
    surfaceIsReadable: true,
  }), true)
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([5, 9]),
    visibleCallSeqs: new Set([5]),
    surfaceIsReadable: true,
  }), true)
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([5, 9]),
    visibleCallSeqs: new Set(),
    surfaceIsReadable: true,
  }), true)
})

// The gate has to describe the cell that just settled, not the whole session.
// An edit recorded many cells ago is history: the surface may have dropped its
// record for an unrelated reason (a windowed re-render), and treating that as a
// replacement this runtime just applied would disable the window rule forever.
test('an edit from an earlier cell does not count as a replacement', () => {
  const events = [
    { seq: 54, type: 'tool/call', data: { name: 'run_code' } },
    { seq: 56, type: 'tool/ptc-dispatch', data: { name: 'edit_run_code' } },
    { seq: 70, type: 'tool/call', data: { name: 'run_code' } },
  ]
  const dropped = new Set([56])
  assert.equal(replacementAppliedSince(events, dropped, new Set([70])), false)
  // The window rule therefore still applies to the shape it was written for.
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5, 9, 70]),
    visibleCallSeqs: new Set([9, 70]),
    surfaceIsReadable: true,
    surfaceReplacementApplied: replacementAppliedSince(events, dropped, new Set([70])),
  }), false)
})

// An edit dispatched by the cell that just settled is a replacement the runtime
// applied: the strict contract stays in charge and the surface's silence about
// the replaced call is proof, not a window.
test('an edit dispatched by the settled cell counts as a replacement', () => {
  const events = [
    { seq: 54, type: 'tool/call', data: { name: 'run_code' } },
    { seq: 56, type: 'tool/ptc-dispatch', data: { name: 'edit_run_code' } },
  ]
  const dropped = new Set([56])
  assert.equal(replacementAppliedSince(events, dropped, new Set([54, 56])), true)
  assert.equal(contractsLiveBindings({
    liveCallSeqs: new Set([2, 5, 9]),
    visibleCallSeqs: new Set([5, 9]),
    surfaceIsReadable: true,
    surfaceReplacementApplied: true,
  }), true)
})
