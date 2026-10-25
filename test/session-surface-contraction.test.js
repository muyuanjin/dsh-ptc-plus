import assert from 'node:assert/strict'
import test from 'node:test'

import { comparableVisibleCalls } from '../internal/session-runtime.js'

// The surface is a view, not an authority over a live worker. These cases pin the
// one property the comparison domain still owns: only top-level REPL calls are
// comparable, so a nested dispatch or a result record can never look like a lost
// call. Whether a surface change rebuilds the kernel is decided by worker
// liveness alone and is covered by the plugin-level recovery suites.

const call = (seq, name = 'run_code') => ({ seq, type: 'tool/call', data: { name } })
const dispatch = (seq, name = 'working_directory') => ({ seq, type: 'tool/ptc-dispatch', data: { name } })
const result = seq => ({ seq, type: 'tool/result', data: {} })

test('only top-level REPL calls are comparable', () => {
  const events = [call(2), result(3), dispatch(4), call(5, 'edit_run_code'), call(6, 'read')]
  const comparable = comparableVisibleCalls(events, new Set([2, 3, 4, 5, 6]))
  assert.deepEqual([...comparable.seqs], [2, 5])
})

test('a nested dispatch or a result record never enters the compared domain', () => {
  const events = [call(2), dispatch(3), result(4)]
  const comparable = comparableVisibleCalls(events, new Set([2, 3, 4]))
  assert.equal(comparable.seqs.size, 1)
  assert.ok(comparable.seqs.has(2))
})

test('a visible set without any top-level call compares as empty, not as a loss', () => {
  const comparable = comparableVisibleCalls([dispatch(3), result(4)], new Set([3, 4]))
  assert.equal(comparable.seqs.size, 0)
  assert.equal(comparable.sources.size, 0)
})

test('a call outside the visible set is not comparable', () => {
  const comparable = comparableVisibleCalls([call(2), call(3)], new Set([3]))
  assert.deepEqual([...comparable.seqs], [3])
})

test('each comparable call keeps its own source digest', () => {
  const events = [call(2), call(3)]
  const comparable = comparableVisibleCalls(events, new Set([2, 3]))
  assert.equal(comparable.sources.size, 2)
  const [first, second] = [...comparable.sources.values()]
  assert.ok(typeof first === 'string' && first.length > 0)
  assert.ok(typeof second === 'string' && second.length > 0)
})
