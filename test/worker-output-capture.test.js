import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerOutputCapture } from '../internal/worker-output-capture.js'
import {
  OUTPUT_FENCE_ALLOWANCE_BYTES,
  outputFenceMarker,
  stripOutputFenceMarkers,
} from '../internal/worker-output-fence.js'

const TOKEN_A = 'a'.repeat(48)
const TOKEN_B = 'b'.repeat(48)

function start(capture, id, token = TOKEN_A, maxOutputBytes = 1024) {
  assert.equal(capture.begin(id, maxOutputBytes, token), undefined)
  assert.equal(capture.start({ type: 'output-start', id, outputFence: token }), undefined)
  assert.equal(capture.push('stdout', outputFenceMarker(token, 'stdout', 'start')), undefined)
  assert.deepEqual(
    capture.push('stderr', outputFenceMarker(token, 'stderr', 'start')),
    { type: 'worker-output-started', id, outputFence: token },
  )
}

test('output capture waits for split start and end fences on both streams', () => {
  const capture = new WorkerOutputCapture()
  assert.equal(capture.begin(1, 1024, TOKEN_A), undefined)
  assert.equal(capture.start({ type: 'output-start', id: 1, outputFence: TOKEN_A }), undefined)
  const stdoutStart = outputFenceMarker(TOKEN_A, 'stdout', 'start')
  assert.equal(capture.push('stdout', stdoutStart.slice(0, 19)), undefined)
  assert.equal(capture.push('stdout', stdoutStart.slice(19)), undefined)
  assert.deepEqual(
    capture.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'start')),
    { type: 'worker-output-started', id: 1, outputFence: TOKEN_A },
  )

  capture.push('stdout', 'raw-out')
  capture.push('stderr', 'raw-err')
  assert.equal(capture.complete({ type: 'done', id: 1, outputFence: TOKEN_A, logs: ['console'] }), undefined)
  const stdoutEnd = outputFenceMarker(TOKEN_A, 'stdout', 'end')
  assert.equal(capture.push('stdout', stdoutEnd.slice(0, 23)), undefined)
  assert.equal(capture.push('stdout', stdoutEnd.slice(23)), undefined)
  assert.deepEqual(capture.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'end')), {
    type: 'done', id: 1, outputFence: TOKEN_A, logs: ['console', 'raw-out', 'raw-err'],
  })
})

test('descriptor output before the next start fence is rejected', () => {
  const capture = new WorkerOutputCapture()
  assert.equal(capture.begin(1, 1024, TOKEN_A), undefined)
  capture.push('stdout', 'late-from-prior-cell')
  capture.push('stdout', outputFenceMarker(TOKEN_A, 'stdout', 'start'))
  capture.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'start'))
  assert.match(
    capture.start({ type: 'output-start', id: 1, outputFence: TOKEN_A }).message,
    /before the next cell started/u,
  )
})

test('descriptor output after a start fence but before its acknowledgement is rejected', () => {
  const capture = new WorkerOutputCapture()
  assert.equal(capture.begin(1, 1024, TOKEN_A), undefined)
  assert.equal(capture.start({ type: 'output-start', id: 1, outputFence: TOKEN_A }), undefined)
  capture.push('stdout', `${outputFenceMarker(TOKEN_A, 'stdout', 'start')}late-before-ack`)
  assert.match(
    capture.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'start')).message,
    /before the next cell started/u,
  )
})

test('descriptor output in the end-fence chunk fails the current round', () => {
  const capture = new WorkerOutputCapture()
  start(capture, 1)
  capture.complete({ type: 'done', id: 1, outputFence: TOKEN_A, logs: [] })
  capture.push('stdout', `${outputFenceMarker(TOKEN_A, 'stdout', 'end')}late`)
  assert.match(
    capture.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'end')).message,
    /after its output fence/u,
  )
})

test('the first out-of-round chunk reports once without buffering a flood', () => {
  const capture = new WorkerOutputCapture()
  start(capture, 1)
  capture.complete({ type: 'done', id: 1, outputFence: TOKEN_A, logs: [] })
  capture.push('stdout', outputFenceMarker(TOKEN_A, 'stdout', 'end'))
  assert.equal(capture.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'end')).type, 'done')
  assert.deepEqual(capture.push('stdout', Buffer.alloc(64 * 1024)), {
    type: 'worker-output-error',
    id: 1,
    message: 'a settled cell produced descriptor output after its output fence; the worker was reset to stop unattributed output',
  })
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(capture.push('stdout', Buffer.alloc(64 * 1024)), undefined)
  }
})

test('capture rejects mismatched protocol tokens and repeated completion', () => {
  assert.throws(() => outputFenceMarker(TOKEN_A, 'stdin', 'start'), /invalid worker output fence/u)
  assert.throws(() => outputFenceMarker(TOKEN_A, 'stdout', 'middle'), /invalid worker output fence/u)
  assert.equal(stripOutputFenceMarkers(undefined), '')
  assert.equal(
    stripOutputFenceMarkers(`before${outputFenceMarker(TOKEN_A, 'stderr', 'end')}after`),
    'beforeafter',
  )
  const capture = new WorkerOutputCapture()
  assert.match(capture.begin(1, 1024, 'invalid').message, /invalid/u)
  assert.equal(capture.begin(2, 1024, TOKEN_A), undefined)
  assert.match(capture.start({ type: 'output-start', id: 2, outputFence: TOKEN_B }).message, /mismatched/u)

  assert.equal(capture.begin(20, 1024, TOKEN_A), undefined)
  assert.deepEqual(capture.start({ type: 'output-start', id: 21, outputFence: TOKEN_A }), {
    type: 'worker-output-error', id: 20, message: 'kernel output start has no matching output round',
  })

  assert.equal(capture.begin(30, 1024, TOKEN_A), undefined)
  assert.match(capture.begin(31, 1024, TOKEN_B).message, /overlapped/u)

  const repeatedStart = new WorkerOutputCapture()
  assert.equal(repeatedStart.begin(40, 1024, TOKEN_A), undefined)
  assert.equal(repeatedStart.start({ type: 'output-start', id: 40, outputFence: TOKEN_A }), undefined)
  assert.match(repeatedStart.start({ type: 'output-start', id: 40, outputFence: TOKEN_A }).message, /repeated/u)

  const wrongCompletion = new WorkerOutputCapture()
  assert.equal(wrongCompletion.begin(50, 1024, TOKEN_A), undefined)
  assert.deepEqual(wrongCompletion.complete({ type: 'done', id: 51, outputFence: TOKEN_A }), {
    type: 'worker-output-error', id: 50, message: 'kernel completion has no matching output round',
  })

  const earlyCompletion = new WorkerOutputCapture()
  assert.equal(earlyCompletion.begin(60, 1024, TOKEN_A), undefined)
  assert.match(earlyCompletion.complete({ type: 'done', id: 60, outputFence: TOKEN_A }).message, /mismatched/u)

  const repeatedCompletion = new WorkerOutputCapture()
  start(repeatedCompletion, 3)
  assert.equal(repeatedCompletion.complete({ type: 'done', id: 3, outputFence: TOKEN_A, logs: [] }), undefined)
  assert.match(repeatedCompletion.complete({ type: 'done', id: 3, outputFence: TOKEN_A, logs: [] }).message, /repeated/u)
})

test('capture bounds protocol bytes and diagnoses structured late output in every phase', () => {
  const oversized = new WorkerOutputCapture()
  assert.equal(oversized.begin(1, 0, TOKEN_A), undefined)
  assert.deepEqual(oversized.push('stdout', Buffer.alloc(OUTPUT_FENCE_ALLOWANCE_BYTES + 1)), {
    type: 'output-limit', id: 1, logs: [],
  })

  const active = new WorkerOutputCapture()
  assert.equal(active.begin(2, 1024, TOKEN_A), undefined)
  assert.match(active.lateOutput().message, /during this cell/u)

  const idle = new WorkerOutputCapture()
  assert.equal(idle.lateOutput(), undefined)
  start(idle, 3)
  idle.complete({ type: 'done', id: 3, outputFence: TOKEN_A })
  idle.push('stdout', outputFenceMarker(TOKEN_A, 'stdout', 'end'))
  assert.equal(idle.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'end')).type, 'done')
  assert.match(idle.lateOutput().message, /after its output fence/u)
  assert.equal(idle.lateOutput(), undefined)
})

test('raw descriptor output participates in the cell output budget', () => {
  const capture = new WorkerOutputCapture()
  start(capture, 1, TOKEN_A, 3)
  capture.push('stdout', 'four')
  capture.complete({ type: 'done', id: 1, outputFence: TOKEN_A, logs: [] })
  capture.push('stdout', outputFenceMarker(TOKEN_A, 'stdout', 'end'))
  assert.deepEqual(capture.push('stderr', outputFenceMarker(TOKEN_A, 'stderr', 'end')), {
    type: 'output-limit', id: 1, logs: [],
  })
})
