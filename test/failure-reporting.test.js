import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFailureTracker,
  errorDetails,
  errorPosition,
  firstLine,
  hasMissingDescriptionError,
  missingDescriptionPath,
  limitLogs,
  markBindingFailure,
  messageOf,
  oneLineMessage,
  safeProperty,
} from '../internal/failure-reporting.js'

test('normalizes hostile errors and extracts active-cell details', () => {
  const hostile = Object.create(null, {
    message: { get() { throw new Error('blocked') } },
    name: { get() { throw new Error('blocked') } },
    stack: { get() { throw new Error('blocked') } },
  })
  hostile.toString = () => { throw new Error('blocked') }
  assert.equal(safeProperty(hostile, 'message'), undefined)
  assert.equal(messageOf(hostile), 'Unprintable error')
  assert.equal(firstLine('first\nsecond'), 'first')
  assert.equal(firstLine('', 'fallback'), 'fallback')
  assert.equal(oneLineMessage(new Error('bad syntax (2:3)')), 'bad syntax')
  assert.equal(errorPosition(hostile, 'ptc-plus-repl-1'), undefined)

  const error = new TypeError('broken')
  error.stack = 'TypeError: broken\n    at run (ptc-plus-repl-7:12:9)'
  error.ptcCause = { code: 'REMOTE\nignored', message: 'remote failure\nignored' }
  assert.deepEqual(errorDetails(error, 'ptc-plus-repl-7'), {
    name: 'TypeError',
    message: 'broken',
    position: { line: 12, column: 9 },
    cause: { code: 'REMOTE', message: 'remote failure' },
  })
  assert.deepEqual(errorDetails(hostile, 'ptc-plus-repl-1'), {
    name: 'Error', message: 'Unprintable thrown value',
  })

  const toolError = Object.assign(new Error('denied'), {
    name: 'ToolCallError',
    toolName: 'read',
  })
  assert.deepEqual(errorDetails(toolError, 'ptc-plus-repl-1'), {
    name: 'ToolCallError', message: 'denied', toolName: 'read',
  })
  assert.equal(hasMissingDescriptionError({ message: 'invalid arguments: missing required property "description"' }), true)
  assert.equal(missingDescriptionPath({ message: 'invalid arguments: missing required property "description"' }), 'description')
  assert.equal(hasMissingDescriptionError({ message: 'invalid arguments: missing required property "options.description"' }), true)
  assert.equal(missingDescriptionPath({ message: 'invalid arguments: missing required property "options.description"' }), 'options.description')
  assert.equal(missingDescriptionPath({
    message: 'invalid arguments: missing required property "command"; missing required property "description"',
  }), 'description')
  assert.equal(missingDescriptionPath({
    message: 'invalid arguments: missing required property "command"\nmissing required property "options.description"',
  }), 'options.description')
  assert.equal(hasMissingDescriptionError({ message: 'invalid arguments: missing required property "command"' }), false)
  assert.equal(hasMissingDescriptionError({
    message: 'missing required property "command"; missing required property "options.cwd"',
  }), false)
  assert.equal(missingDescriptionPath({ message: 'invalid arguments: missing required property "options.command"' }), undefined)
})

test('bounds diagnostic logs and emits one repeat-failure hint', () => {
  assert.deepEqual(limitLogs(['x'.repeat(5000), 'newest']), ['newest'])
  const tracker = createFailureTracker()
  const repeated = { kind: 'exception', message: 'same' }
  assert.equal(tracker.hint(repeated), undefined)
  assert.equal(tracker.hint(repeated), undefined)
  assert.equal(tracker.hint(repeated).code, 'PTC-W002')
  assert.equal(tracker.hint(repeated), undefined)
  assert.equal(tracker.hint({ kind: 'exception', message: 'different' }), undefined)
  tracker.reset()
  assert.equal(tracker.hint(repeated), undefined)

  const missing = markBindingFailure({
    kind: 'exception',
    message: 'ReferenceError: missingBinding is not defined',
  })
  assert.equal(tracker.hint(missing), undefined)
  assert.equal(tracker.hint(missing), undefined)
  const bindingHint = tracker.hint(missing)
  assert.equal(bindingHint.code, 'PTC-W001')
  assert.match(bindingHint.help[0], /capabilities\.find\(\)/)
})
