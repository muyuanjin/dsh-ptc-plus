import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  createExceptionOriginScope,
  recordExceptionOrigin,
  exceptionOriginPosition,
  createFailureTracker,
  errorDetails,
  errorPosition,
  firstLine,
  hasMissingDescriptionError,
  missingDescriptionPath,
  limitLogs,
  markBindingFailure,
  programBindingError,
  messageOf,
  oneLineMessage,
  safeProperty,
} from '../internal/failure-reporting.js'

test('exception source facts validate current coordinates and expire with their execution', async () => {
  const source = 'const old = 1\r\n  fail()'
  const prefix = `eval:${createHash('sha256').update(source).digest('hex')}:`
  const origin = `${prefix}2:3`
  const error = Object.freeze(Object.create(null))
  const first = createExceptionOriginScope()
  let late
  first.run(() => {
    recordExceptionOrigin(error, origin)
    recordExceptionOrigin(error, origin)
    late = Promise.withResolvers()
    late.done = late.promise.then(() => recordExceptionOrigin(error, origin))
  })
  assert.deepEqual(first.origins(error), [origin])
  assert.deepEqual(exceptionOriginPosition(first.origins(error), source), { line: 2, column: 3 })
  assert.equal(exceptionOriginPosition(first.origins(error), 'fail()'), undefined)
  assert.equal(exceptionOriginPosition(undefined, source), undefined)
  for (const invalid of [undefined, 'eval:old:2:3', `${prefix}0:1`, `${prefix}2:0`, `${prefix}3:1`,
    `${prefix}2:9`, `${prefix}2:3:extra`, `${prefix}9007199254740992:1`]) {
    assert.equal(exceptionOriginPosition([invalid], source), undefined)
  }
  first.run(() => {
    recordExceptionOrigin(error, undefined, { reset: true })
    assert.equal(first.origins(error), undefined)
    recordExceptionOrigin(null, origin, { sourceFailure: true })
    assert.deepEqual(first.origins(null), [origin])
    assert.equal(first.sourceFailure(null), true)
    recordExceptionOrigin(null, origin, { reset: true })
    assert.equal(first.sourceFailure(null), false)
  })
  first.close()
  const next = createExceptionOriginScope()
  await next.run(async () => {
    late.resolve()
    await late.done
    assert.equal(next.origins(error), undefined)
    recordExceptionOrigin(error, `${prefix}1:1`)
  })
  assert.equal(first.origins(error), undefined)
  assert.deepEqual(next.origins(error), [`${prefix}1:1`])
  next.close()
  recordExceptionOrigin(error, origin)
  assert.deepEqual(Reflect.ownKeys(error), [])
})

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
  assert.match(bindingHint.help[0], /local declaration/)
  assert.equal(bindingHint.stateEffect, 'unknown')
  for (let index = 0; index < 3; index++) {
    const hint = tracker.hint(markBindingFailure({ kind: 'exception', message: 'missing API' }, 'capability'), 'partially-applied')
    if (index === 2) {
      assert.equal(hint.stateEffect, 'partially-applied')
      assert.match(hint.help[0], /capabilities\.find\(\)/)
    }
  }
})

test('bounds multiline and captured causes without altering the original error or trusting a forged origin', () => {
  const error = Object.assign(new Error('Command failed: sample\nThe system cannot find the path specified'), {
    stderr: Buffer.from('path detail'),
  })
  const detail = errorDetails(error, 'cell')
  assert.equal(detail.message, error.message)
  assert.match(detail.cause.message, /cannot find the path specified/)
  assert.equal(error.cause, undefined)
  assert.equal(errorDetails(new Error('exit 1'), 'cell').cause, undefined)
  assert.equal(errorDetails({ message: 'one', stderr: 'x'.repeat(10000) }, 'cell').cause.message.length, 2047)
  assert.equal(errorDetails({ message: 'x'.repeat(3000) + '\nlate cause' }, 'cell').cause, undefined)
  assert.equal(errorDetails({ message: 'PTC execution lease expired', failureOrigin: 'lease' }, 'cell').failureOrigin, undefined)
  assert.equal(errorDetails(programBindingError('lease', 'PTC execution lease expired'), 'cell').failureOrigin, 'lease')
})
