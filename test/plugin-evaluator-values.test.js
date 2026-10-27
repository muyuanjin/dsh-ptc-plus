import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { Config } from '../index.js'
import { RECOVERY_BOUNDARY_KEY, DIAGNOSTIC_WORDING_KEY, SETTLEMENT_PROOF_KEY, normalizeJournal,
  withSettlementProof } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { renderDiagnostic } from '../internal/diagnostic.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import {
  JOURNAL_POLICY,
  appendOnlySession,
  appendRunCodeEvents,
  fixture,
  orderedSurfaceSession,
} from './plugin-fixture.js'

test('captures console output and returns only explicit cell output', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('session-a', `
const internal = 21 * 2
console.log("answer", internal)
process.stdout.write("raw output\\n")
return { answer: internal }
`), { logs: ['answer 42', 'raw output\n'], value: { answer: 42 } })
})

test('captures direct descriptors and inherited child stdio exactly once', async t => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('descriptor-output', `
const fs = require('node:fs')
const childProcess = require('node:child_process')
console.log('console-once')
fs.writeSync(1, 'fd-one')
fs.writevSync(2, [Buffer.from('fd-two')])
await new Promise((resolve, reject) => fs.writev(1, [Buffer.from('vector-three')], error => error ? reject(error) : resolve()))
process._rawDebug('raw-debug')
Object.getPrototypeOf(process.stdout).write.call(process.stdout, 'prototype-out')
childProcess.execFileSync(process.execPath, ['-e', ${JSON.stringify("process.stdout.write('child-four')")}], { stdio: 'inherit' })
await new Promise((resolve, reject) => {
  const child = childProcess.spawn(process.execPath, ['-e', ${JSON.stringify("process.stderr.write('child-five')")}], { stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('child exit ' + code)))
})
return 42
`)
  assert.equal(result.error, undefined)
  assert.equal(result.value, 42)
  const output = result.logs.join('')
  for (const marker of [
    'console-once', 'fd-one', 'fd-two', 'vector-three', 'raw-debug',
    'prototype-out', 'child-four', 'child-five',
  ]) {
    assert.equal(output.split(marker).length - 1, 1, marker)
  }
})

test('enforces the output budget before a cell can flood the host', async (t) => {
  const state = fixture({ maxOutputBytes: 64 })
  t.after(() => state.dispose())
  const result = await state.run('session-a', `
for (let index = 0; index < 1000; index += 1) console.log("xxxxxxxxxxxxxxxx")
`)
  assert.equal(result.error.kind, 'output-limit')
  assert.match(result.error.message, /cell was discarded and the worker reset/)
  assert.ok(result.logs.length < 10)
})

test('preserves function-body return semantics across control flow', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('session-a', `
function nested(value) {
  if (value) return 10
  return 20
}
let finalized = false
`)

  assert.deepEqual(await state.run('session-a', `
try {
  if (true) return nested(true)
} catch (error) {
  return 99
} finally {
  finalized = true
}
`), { logs: [], value: 10 })
  assert.deepEqual(await state.run('session-a', 'return finalized'), { logs: [], value: true })

  assert.deepEqual(await state.run('session-a', `
try { throw new Error("ordinary") } catch { return 4 }
`), { logs: [], value: 4 })
})

test('reports runtime exceptions and invalid output without hanging the kernel', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const thrown = await state.run('session-a', 'throw new Error("boom")')
  assert.equal(thrown.error.kind, 'exception')
  assert.match(thrown.error.message, /boom/)

  const invalid = await state.executeRun('session-a', 'return { temp: undefined }', {}, {})
  assert.equal(invalid.raw.error, undefined)
  assert.equal(invalid.raw.value, '{temp: undefined}')
  assert.equal(invalid.result.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(invalid.result.meta.dshPtcPlus.diagnostics, [])
  assert.deepEqual(await state.run('session-a', 'return 6'), { logs: [], value: 6 })
})

test('settles falsy thrown values and awaited rejection without losing continuous bindings', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('settlement-values', 'let retainedAfterError = 41')
  for (const value of ['null', 'undefined', 'false', '0']) {
    for (const code of [`throw ${value}`, `await Promise.reject(${value})`]) {
      assert.equal((await state.run('settlement-values', code)).error?.kind, 'exception', code)
    }
  }
  assert.deepEqual(await state.run('settlement-values', 'return Promise.resolve(retainedAfterError + 1)'), { logs: [], value: 42 })
})

test('a late REPL exception cannot settle a subsequent cell', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  assert.deepEqual(await state.run('late-evaluation', 'setTimeout(() => { throw new Error("late") }, 30); return 1'), { logs: [], value: 1 })
  assert.deepEqual(await state.run('late-evaluation', 'return await new Promise(resolve => setTimeout(() => resolve(42), 80))'), { logs: [], value: 42 })
})

test('a drained program-call continuation keeps its cell result, logs and durability', async t => {
  const state = fixture()
  t.after(() => state.dispose())

  const drained = await state.executeRun('drained-output', `
void tools.settle({}).then(value => console.log('drained:' + value))
const retainedAfterDrainedOutput = 41
return 7
`, { settle: async () => 'continuation' }, {})
  assert.equal(drained.raw.error, undefined)
  assert.equal(drained.raw.value, 7)
  assert.deepEqual(drained.raw.logs, ['drained:continuation'])
  assert.equal(drained.result.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(await state.run('drained-output', 'return retainedAfterDrainedOutput'), {
    logs: [], value: 41,
  })
})

test('late structured output diagnoses attribution failure and resets the worker', async t => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('late-output', `
let releaseLateStructuredOutput
const lateStructuredOutput = new Promise(resolve => { releaseLateStructuredOutput = resolve })
setTimeout(() => lateStructuredOutput.then(() => console.log('late-from-settled-cell')), 0)
const retainedBeforeLateOutput = 41
return 1
`), { logs: [], value: 1 })
  const affected = await state.run('late-output', `
releaseLateStructuredOutput()
await new Promise(resolve => setTimeout(resolve, 0))
return 2
`)
  assert.equal(affected.error.kind, 'worker-exit')
  assert.match(affected.error.message, /output attribution failed/u)
  assert.deepEqual(affected.logs, [])
  assert.deepEqual(await state.run('late-output', 'return typeof retainedBeforeLateOutput'), {
    logs: [], value: 'undefined',
  })
})

test('late bare descriptor output follows the acknowledged physical round', async t => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('late-fd-output', `
const fs = require('node:fs')
let releaseLateDescriptorOutput
const lateDescriptorOutput = new Promise(resolve => { releaseLateDescriptorOutput = resolve })
setTimeout(() => lateDescriptorOutput.then(() => fs.writeSync(1, 'physical-window-output')), 0)
return 1
`), { logs: [], value: 1 })
  const current = await state.run('late-fd-output', `
releaseLateDescriptorOutput()
await new Promise(resolve => setTimeout(resolve, 0))
return 2
`)
  assert.equal(current.error, undefined)
  assert.equal(current.value, 2)
  assert.equal(current.logs.join('').split('physical-window-output').length - 1, 1)
})

test('output settlement uses captured string and regexp intrinsics', async t => {
  for (const [id, source, marker] of [
    ['regexp-test', 'RegExp.prototype.test = null', undefined],
    ['string-ends-with', 'String.prototype.endsWith = null', 'ends-with-marker'],
    ['string-slice', 'String.prototype.slice = null', 'slice-marker'],
  ]) {
    const state = fixture()
    t.after(() => state.dispose())
    const result = await state.run(`output-intrinsic-${id}`, `${source};${marker === undefined ? '' : `console.log(${JSON.stringify(marker)});`}return 1`)
    assert.equal(result.error, undefined, id)
    assert.equal(result.value, 1, id)
    if (marker !== undefined) assert.deepEqual(result.logs, [marker], id)
    const continued = await state.run(`output-intrinsic-${id}`, `return [${source.split(' = ')[0]} === null, 2]`)
    assert.deepEqual(continued, { logs: [], value: [true, 2] }, id)
  }
})

test('log capture converts descriptor chunks without the user realm prototypes', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.run('output-buffer-prototype', `
const { Buffer: NativeBuffer } = require('node:buffer')
let traps = 0
NativeBuffer.prototype.toString = function () { traps += 1; return 'REWRITTEN' }
console.log('console-marker')
process.stdout.write(NativeBuffer.from('buffer-marker'))
process.stdout.write('string-marker')
process.stdout.write(new Uint8Array([118, 105, 101, 119, 45, 109, 97, 114, 107, 101, 114]))
return traps
`)
  assert.equal(result.error, undefined)
  assert.equal(result.value, 0)
  assert.deepEqual(result.logs, ['console-marker', 'buffer-marker', 'string-marker', 'view-marker'])
})

test('reports runtime exceptions as partially applied and preserves earlier mutations', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.runDurable('runtime-diagnostic', 'let value = 0')
  const observed = await state.executeRun(
    'runtime-diagnostic',
    'value = 1\nthrow new TypeError("value.trim is not a function")',
    {},
    {},
  )
  const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(diagnostic.code, 'PTC-X001')
  assert.equal(diagnostic.severity, 'error')
  assert.equal(diagnostic.phase, 'execute')
  assert.equal(diagnostic.stateEffect, 'partially-applied')
  assert.match(diagnostic.help[0], /operation owner's retry\/idempotence contract and available execution facts/)
  assert.match(diagnostic.message, /^uncaught TypeError: value\.trim is not a function/)
  assert.deepEqual(diagnostic.source, { cell: 'current', start: { line: 2, column: 7 } })
  assert.deepEqual(observed.raw.logs, [])
  assert.match(observed.raw.error.message, /^error\[PTC-X001\]: uncaught TypeError:/)
  assert.match(observed.raw.error.message, /--> current:2:7/)
  assert.match(observed.raw.error.message, /throw new TypeError/)
  assert.match(observed.raw.error.message, /state: partially-applied/)
  assert.deepEqual(await state.run('runtime-diagnostic', 'return value'), { logs: [], value: 1 })
})

test('keeps rendered runtime diagnostics out of captured logs', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('single-diagnostic', 'const repairFailed = 42')
  const observed = await state.executeRun(
    'single-diagnostic',
    'return { before: repairFailed.toUpperCase() }',
    {},
    {},
  )
  assert.equal(observed.raw.error.kind, 'exception')
  assert.match(observed.raw.error.message, /^error\[PTC-X001\]:/)
  assert.deepEqual(observed.raw.logs, [])
  assert.equal(observed.raw.error.message.includes('Captured output'), false)
})

test('guides same-name continuation after a declaration initializer fails', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.executeRun(
    'partial-declaration-guidance',
    'const initialized = 1\nconst continuedValue = (() => { throw new Error("stop") })()',
    {},
    {},
  )
  assert.equal(observed.raw.error.kind, 'exception')
  const help = observed.result.meta.dshPtcPlus.diagnostics[0].help
  assert.match(help[0], /failing operation may have caused effects/)
  assert.match(help[1], /completed declarations and actual assignments remain available/)
  assert.match(help[1], /continue with the same binding names/)
  assert.deepEqual(await state.run('partial-declaration-guidance', 'const continuedValue = initialized + 1\nreturn [initialized, continuedValue]'), {
    logs: [],
    value: [1, 2],
  })
})

test('points cross-cell stack failures at the current call site', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('cross-cell-frame', 'function explode() { throw new Error("boom") }')
  const observed = await state.executeRun(
    'cross-cell-frame',
    'const marker = 1\nexplode()',
    {},
    {},
  )
  const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(diagnostic.code, 'PTC-X001')
  // The old cell's frame (the function definition) must not win: the position
  // belongs to the active cell's call site.
  assert.deepEqual(diagnostic.source, { cell: 'current', start: { line: 2, column: 1 } })
  assert.match(diagnostic.message, /uncaught Error: boom/)
})

test('exception origins retain frozen values and select each current caller across sync and async rethrows', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const id = `exception-origins-${bindingUpdates}`
    const setup = await state.run(id, `
      const frozen = Object.freeze({message:'frozen failure',name:'FrozenFailure'});
      const saved = new Error('saved failure');
      const savedStack = saved.stack;
      const stackLimit = Error.stackTraceLimit;
      function fail(value) { throw value }
      async function later(value) { await Promise.resolve(); throw value }
    `)
    assert.equal(setup.error, undefined)
    for (const [source, column] of [
      ['\n  fail(frozen)', 3],
      ['\n    fail(saved)', 5],
      ['\n      fail(saved)', 7],
      ['\nawait later(saved)', 7],
      ['\n  await later(frozen)', 9],
    ]) {
      const result = await state.runDurable(id, source)
      assert.equal(result.isError, true)
      assert.deepEqual(result.meta.dshPtcPlus.diagnostics[0].source,
        { cell: 'current', start: { line: 2, column } }, `${bindingUpdates}: ${source}`)
    }
    const identity = await state.run(id, `
      let exact=0;
      try { fail(frozen) } catch(error) { exact += error === frozen }
      try { await later(saved) } catch(error) { exact += error === saved }
      try { await Promise.reject(saved) } catch(error) { exact += error === saved }
      return [exact, Object.isFrozen(frozen), saved.stack === savedStack, Error.stackTraceLimit === stackLimit]
    `)
    assert.deepEqual(identity.value, [3, true, true, true], identity.error?.message)
  }
})

test('non-callable failures identify the native current-cell operation after argument effects', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const id = `non-callable-position-${bindingUpdates}`
    await state.run(id, 'const service={value:undefined};let effects=0')
    const result = await state.runDurable(id, '\n  service.value(++effects)')
    assert.match(result.error.message, /service\.value is not a function/)
    assert.deepEqual(result.meta.dshPtcPlus.diagnostics[0].source,
      { cell: 'current', start: { line: 2, column: 3 } })
    assert.equal((await state.run(id, 'return effects')).value, 1)
  }
})

test('leaves unexecuted lexical declarations available for same-name continuation', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const thrown = await state.executeRun(
    'occupied-declaration',
    'throw new Error("stop")\nconst later = 1',
    {},
    {},
  )
  assert.equal(thrown.raw.error.kind, 'exception')
  assert.deepEqual(await state.run('occupied-declaration', 'return typeof later'), {
    logs: [],
    value: 'undefined',
  })
  const redeclared = await state.run('occupied-declaration', 'const later = 2\nreturn later')
  assert.deepEqual(redeclared, { logs: [], value: 2 })
})

test('adds a classified one-shot hint after consecutive identical cell failures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const first = await state.run('repeat-failure', 'throw new TypeError("same problem")')
  assert.equal(first.error.kind, 'exception')
  assert.equal(first.logs.some(log => log.includes('PTC-W002')), false)

  const second = await state.run('repeat-failure', 'throw new TypeError("same problem")')
  assert.equal(second.logs.some(log => log.includes('PTC-W002')), false)

  const third = await state.run('repeat-failure', 'throw new TypeError("same problem")')
  assert.equal(third.logs.some(log => log.includes('PTC-W002')), true)
  assert.doesNotMatch(third.logs.find(log => log.includes('PTC-W002')), /capabilities\.tree\(\)/)

  // A different failure fingerprint resets the streak.
  const different = await state.run('repeat-failure', 'throw new TypeError("other problem")')
  assert.equal(different.logs.some(log => log.includes('PTC-W002')), false)

  // A successful cell resets the streak.
  await state.run('repeat-failure', 'const recovered = 1')
  const fourth = await state.run('repeat-failure', 'throw new TypeError("same problem")')
  assert.equal(fourth.logs.some(log => log.includes('PTC-W002')), false)

  // The hint is recorded in the journal alongside the failure diagnostic.
  const durable = await state.runDurable('repeat-failure', 'throw new Error("journaled")')
  await state.runDurable('repeat-failure', 'throw new Error("journaled")')
  const hinted = await state.runDurable('repeat-failure', 'throw new Error("journaled")')
  assert.equal(hinted.meta.dshPtcPlus.diagnostics.some(d => d.code === 'PTC-W002'), true)
})

test('normalizes multiline error names and throwing cause or stack getters while keeping the runtime usable', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const multilineName = await state.runDurable('multiline-thrown-name', `
const namedError = new Error('named failure')
  namedError.name = 'Bad\\rName'
throw namedError
`)
  assert.equal(multilineName.meta.dshPtcPlus.diagnostics[0].message, 'uncaught Bad: named failure')

  const throwingCause = await state.runDurable('throwing-cause-getter', `
const throwingValue = { name: 'CustomError', message: 'semantic failure' }
Object.defineProperty(throwingValue, 'ptcCause', { get() { throw new Error('cause getter escaped') } })
throw throwingValue
`)
  assert.equal(throwingCause.meta.dshPtcPlus.diagnostics[0].message, 'uncaught CustomError: semantic failure')
  assert.equal(Object.hasOwn(throwingCause.meta.dshPtcPlus.diagnostics[0], 'cause'), false)
  assert.deepEqual(await state.run('throwing-cause-getter', 'return 42'), { logs: [], value: 42 })
  const throwingStack = await state.run('throwing-stack-getter', `
const originalError = new Error('original failure')
Object.defineProperty(originalError, 'stack', { get() { throw new Error('stack getter replaced original') } })
throw originalError
`)
  assert.match(throwingStack.error.message, /original failure/)
  assert.doesNotMatch(throwingStack.error.message, /uncaught Error: stack getter/)
})

test('generic exceptions preserve live execution facts without guessing an initializer failure', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const id = `exception-facts-${bindingUpdates}`
    await state.run(id, 'let retained = 40')
    for (const source of [
      'throw new Error("ordinary failure")',
      'const completed = 1; retained += 1; throw new Error("later failure")',
      'const retryable = (() => { throw new Error("initializer failure") })()',
    ]) {
      const failed = await state.runDurable(id, source)
      const diagnostic = failed.meta.dshPtcPlus.diagnostics.find(item => item.code === 'PTC-X001')
      assert.equal(diagnostic.stateEffect, 'partially-applied')
      assert.equal(diagnostic.cause, undefined)
      assert.match(failed.error.message, /completed declarations and actual assignments remain available/)
      assert.doesNotMatch(diagnostic.help.join('\n'), /failed initializer|fresh names|rerun/)
      assert.match(diagnostic.message, new RegExp(source.includes('ordinary') ? 'ordinary failure' : source.includes('later') ? 'later failure' : 'initializer failure'))
    }
    assert.deepEqual(await state.run(id, 'const retryable = 1; return [retained, completed, retryable]'), { logs: [], value: [41, 1, 1] })
  }
})

test('replays a durable runtime exception with historical help from its persisted diagnostic', async (t) => {
  const events = []
  const session = orderedSurfaceSession('replay-diagnostic', events)
  const first = fixture()
  t.after(() => first.dispose())

  const setupCode = 'let replayedAfterThrow = 0'
  const setup = await first.runDurable(session.id, setupCode, {}, { session, recordSession: 'deferred-result', callId: 'replay-setup' })
  appendRunCodeEvents(events, 'replay-setup', setupCode, setup)
  const throwCode = 'replayedAfterThrow = 1\nthrow new TypeError("replay failure")'
  const thrown = await first.runDurable(session.id, throwCode, {}, { session, recordSession: 'deferred-result', callId: 'replay-throw' })
  assert.equal(thrown.meta.dshPtcPlus.status, 'durable')
  assert.equal(thrown.meta.dshPtcPlus.diagnostics[0].code, 'PTC-X001')
  const historical = structuredClone(thrown)
  historical.meta.dshPtcPlus.diagnostics[0].help[1] = 'completed declarations and actual assignments remain available; correct the failed initializer and continue with the same binding names'
  historical.meta.dshPtcPlus.completion.error.message = renderDiagnostic(historical.meta.dshPtcPlus.diagnostics[0], throwCode)
  // The record states the settlement it was published with: the older help wording
  // is part of what it published, so its proof is taken over that settlement.
  Object.assign(historical.meta, withSettlementProof({}, historical.meta.dshPtcPlus))
  appendRunCodeEvents(events, 'replay-throw', throwCode, historical)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return replayedAfterThrow', {}, { session }), {
    logs: [],
    value: 1,
  })
})

test('persists and skips a replay node whose semantic exception changed', async (t) => {
  const events = []
  const session = appendOnlySession('replay-forged-diagnostic', events)
  const first = fixture()
  t.after(() => first.dispose())

  const code = 'throw new TypeError("actual failure")'
  const actual = await first.runDurable(session.id, code, {}, {
    session: session.id,
    recordSession: false,
  })
  const forged = structuredClone(actual)
  const journal = forged.meta.dshPtcPlus
  // A record published before the wording digest existed carries no digest, so its
  // wording is all the recovery has: the replay is what decides whether it still
  // describes the cell.
  delete forged.meta[DIAGNOSTIC_WORDING_KEY]
  journal.diagnostics[0].message = 'uncaught TypeError: forged failure'
  journal.completion.error.message = journal.completion.error.message.replaceAll('actual failure', 'forged failure')
  const { callSeq: failedCallSeq } = appendRunCodeEvents(events, 'replay-forged-throw', code, forged)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.runDurable(session.id, 'return 1', {}, { session, recordSession: 'deferred-result', callId: 'replay-forged-recovery' })
  assert.equal(result.isError, false)
  assert.equal(result.value, 1)
  // The recorded completion no longer renders from the diagnostic it carries, so the
  // forged cell is not evidence for its own bindings: the frontier contracts at that
  // cell instead of replaying it, and the following cell still computes. The forged
  // cell declared no binding, so the contraction drops nothing and owes no notice.
  assert.deepEqual(result.meta[RECOVERY_BOUNDARY_KEY],
    [{ failedCallSeq, frontierCallSeq: null }])
  const logs = result.logs ?? []
  assert.equal(logs.some(log => log.includes('PTC-R002')), false)
  appendRunCodeEvents(events, 'replay-forged-recovery', 'return 1', result)
})

test('round-trips the canonical PTC value graph without losing JavaScript graph semantics', () => {
  const shared = { value: 1 }
  const sparse = new Array(3)
  sparse[1] = undefined
  const input = Object.create(null)
  Object.defineProperty(input, '__proto__', {
    value: shared, enumerable: true, writable: true, configurable: true,
  })
  Object.defineProperties(input, {
    alias: { value: shared, enumerable: true, writable: true, configurable: true },
    sparse: { value: sparse, enumerable: true, writable: true, configurable: true },
    values: {
      value: [NaN, Infinity, -Infinity, -0, 12345678901234567890n],
      enumerable: true, writable: true, configurable: true,
    },
    self: { value: input, enumerable: true, writable: true, configurable: true },
  })

  const wire = encodeValue(input)
  assert.equal(JSON.parse(JSON.stringify(wire)).codec, 'ptc-value-graph/v1')
  const output = decodeValue(wire)
  assert.equal(Object.getPrototypeOf(output), null)
  assert.equal(Object.hasOwn(output, '__proto__'), true)
  assert.equal(output.__proto__, output.alias)
  assert.equal(output.self, output)
  assert.equal(0 in output.sparse, false)
  assert.equal(1 in output.sparse, true)
  assert.equal(output.sparse[1], undefined)
  assert.equal(2 in output.sparse, false)
  assert.equal(Number.isNaN(output.values[0]), true)
  assert.equal(output.values[1], Infinity)
  assert.equal(output.values[2], -Infinity)
  assert.equal(Object.is(output.values[3], -0), true)
  assert.equal(output.values[4], 12345678901234567890n)
  assert.deepEqual(encodeValue(output), wire)
})

test('rejects executable, accessor, malformed, and over-budget PTC values', () => {
  let getterCalls = 0
  const accessor = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterCalls += 1; return 1 },
  })
  assert.throws(() => encodeValue(accessor), /property must be an enumerable data property/)
  assert.equal(getterCalls, 0)

  for (const value of [() => 1, new Date(0), Promise.resolve(1), new Map()]) {
    assert.throws(() => encodeValue(value), /not PTC Value V1/)
  }
  assert.throws(() => decodeValue({
    codec: 'ptc-value-graph/v1',
    root: { tag: 'reference', index: 1 },
    nodes: [],
  }), /dangling PTC value reference/)
  assert.throws(() => decodeValue({
    codec: 'ptc-value-graph/v1',
    root: { tag: 'mystery' },
    nodes: [],
  }), /unknown PTC value atom tag/)
  assert.throws(() => decodeValue({
    codec: 'ptc-value-graph/v1', extra: true,
    root: null,
    nodes: [],
  }), /invalid PTC value envelope field extra/)
  assert.throws(() => encodeValue([1, 2], { maxEdges: 1 }), /edge budget exceeds 1/)
})

test('encodes and decodes deeply nested PTC values without recursive stack growth', () => {
  let input = null
  for (let depth = 0; depth < 5_000; depth += 1) input = [input]
  const wire = encodeValue(input)
  let output = decodeValue(wire)
  for (let depth = 0; depth < 5_000; depth += 1) output = output[0]
  assert.equal(output, null)
})

test('renders array holes distinctly from explicit undefined values', () => {
  assert.equal(renderValueWire(encodeValue(new Array(1))), '[,]')
  assert.equal(renderValueWire(encodeValue(new Array(2))), '[, ,]')
  assert.equal(renderValueWire(encodeValue([, undefined, null])), '[, undefined, null]')
  assert.equal(renderValueWire(encodeValue([undefined])), '[undefined]')
})

test('projects supported rich values and rejects values outside PTC Value V1', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const shared = await state.run('session-a', `
const sharedItem = { value: 1 }
return [sharedItem, sharedItem]
`)
  assert.deepEqual(shared, { logs: [], value: '[<ref *1> {value: 1}, [Reference *1]]' })

  for (const source of [
    'return new Date(0)',
    'const value = {}; value[Symbol("x")] = 1; return value',
    'const value = []; value.extra = 1; return value',
  ]) {
    const result = await state.run(`invalid-${source.length}`, source)
    assert.ok(['invalid-output', 'exception'].includes(result.error.kind))
  }
  assert.deepEqual(await state.run('special-number', 'return -0'), { logs: [], value: '-0' })
})

test('distinguishes an explicit undefined completion from no completion value', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const explicit = await state.executeRun('explicit-undefined', 'return undefined', {}, {})
  assert.deepEqual(explicit.raw, { logs: [], value: 'undefined' })
  assert.equal(explicit.result.meta.dshPtcPlus.completion.hasValue, true)
  assert.deepEqual(decodeValue(explicit.result.meta.dshPtcPlus.completion.value), undefined)

  const absent = await state.executeRun('absent-value', 'const noCompletionValue = 1', {}, {})
  assert.deepEqual(absent.raw, { logs: [] })
  assert.equal(absent.result.meta.dshPtcPlus.completion.hasValue, false)
  assert.equal(Object.hasOwn(absent.result.meta.dshPtcPlus.completion, 'value'), false)
})

test('persists and cold-replays a rich completion through session-log JSON alone', async (t) => {
  const events = []
  const session = orderedSurfaceSession('rich-value-replay', events)
  const first = fixture()
  t.after(() => first.dispose())
  const code = `
const richReplayShared = { value: undefined }
const richReplaySparse = [, undefined, null]
const richReplayState = {
  shared: richReplayShared,
  alias: richReplayShared,
  sparse: richReplaySparse,
  negativeZero: -0,
  big: 42n,
}
richReplayState.self = richReplayState
return richReplayState
`
  const recorded = await first.runDurable(session.id, code, {}, { session })
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  assert.equal(recorded.meta.dshPtcPlus.completion.hasValue, true)
  assert.equal(recorded.meta.dshPtcPlus.completion.value.codec, 'ptc-value-graph/v1')
  appendRunCodeEvents(events, 'rich-value-cell', code, JSON.parse(JSON.stringify(recorded)))
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, `return {
    alias: richReplayState.shared === richReplayState.alias,
    cycle: richReplayState.self === richReplayState,
    hole: !(0 in richReplayState.sparse),
    explicitUndefined: 1 in richReplayState.sparse && richReplayState.sparse[1] === undefined,
    negativeZero: Object.is(richReplayState.negativeZero, -0),
    bigint: richReplayState.big === 42n,
  }`, {}, { session }), {
    logs: [],
    value: {
      alias: true,
      cycle: true,
      hole: true,
      explicitUndefined: true,
      negativeZero: true,
      bigint: true,
    },
  })
})

test('preserves Math intrinsics and harmless local ambient names as durable', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const math = await state.runDurable('math-intrinsics', 'return [Math.max(1, 2), Math.PI]')
  assert.deepEqual(math.value, [2, Math.PI])
  assert.equal(math.meta.dshPtcPlus.status, 'durable')

  const local = await state.runDurable('local-ambient-name', `
function readLocal(Date) { return { Date, value: Date + 1 } }
return readLocal(4)
`)
  assert.deepEqual(local.value, { Date: 4, value: 5 })
  assert.equal(local.meta.dshPtcPlus.status, 'durable')
})

test('does not cold-replay ambient values reached through globalThis', async (t) => {
  const events = []
  const session = orderedSurfaceSession('global-this-ambient', events)
  const writer = fixture()
  t.after(() => writer.dispose())
  const source = 'const ambientReplayValue = globalThis.crypto.randomUUID(); return 1'
  const observed = await writer.runDurable(session.id, source, {}, { session, recordSession: 'deferred-result', callId: 'global-this-ambient-cell' })
  assert.equal(observed.meta.dshPtcPlus.status, 'volatile')
  appendRunCodeEvents(events, 'global-this-ambient-cell', source, observed)
  await writer.dispose()

  const reader = fixture()
  t.after(() => reader.dispose())
  const restored = await reader.run(session.id, 'return typeof ambientReplayValue', {}, { session })
  // The settlement recorded the value it produced, so recovery installs that
  // value instead of re-running the cell — the ambient call is not dispatched
  // again, and the binding is present.
  assert.equal(restored.value, 'string')
  const recorded = observed.meta.dshPtcPlus.values.find(entry => entry.name === 'ambientReplayValue')
  assert.notEqual(recorded, undefined)
  assert.equal(typeof decodeValue(recorded.wire), 'string')
})


test('unsupported completion help preserves retained values and differs from budget help', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const failed = await state.run('retained-map', 'const keptMap = new Map([["x", 2n]]); return keptMap')
  assert.equal(failed.error.kind, 'invalid-output')
  assert.match(failed.error.message, /PTC-O001[^]*Map[^]*worker remains live[^]*select needed data/)
  assert.doesNotMatch(failed.error.message, /reduce the transferred graph/)
  assert.deepEqual(await state.run('retained-map', 'return keptMap.get("x") + 1n'), { logs: [], value: '3n' })
  const bounded = fixture({maxValueEdges: 1})
  t.after(() => bounded.dispose())
  const budget = await bounded.run('budget-help', 'const keptArray=[1,2]; return keptArray')
  assert.equal(budget.error.kind, 'invalid-output')
  assert.match(budget.error.message, /edge budget[^]*reduce the transferred graph/)
  assert.doesNotMatch(budget.error.message, /select needed data/)
  assert.deepEqual(await bounded.run('budget-help', 'return keptArray.length'), { logs: [], value: 2 })
})


test('codec-proved historical refusal messages preserve cold replay without retrying effects', async t => {
  for (const parameter of [false, true]) {
    const session = orderedSurfaceSession(`old-refusal-${parameter}`)
    const first = fixture()
    t.after(()=>first.dispose())
    let calls = 0
    const bindings = { read: async()=>{calls++;return 42} }
    const source = parameter
      ? 'const prior=7; class Data {}; await tools.read(new Data())'
      : 'const prior=7; class Data {}; return new Data()'
    const recorded = JSON.parse(JSON.stringify(await first.runDurable(session.id,source,bindings,{session,recordSession:'deferred-result',callId:'old-refusal'})))
    const journal = recorded.meta.dshPtcPlus
    assert.equal(journal.status,'durable')
    // The wording below belongs to an earlier version's rendering, which is what a
    // record published before these adjuncts existed carries: neither the settlement
    // proof nor the diagnostic wording digest is part of it.
    delete recorded.meta[DIAGNOSTIC_WORDING_KEY]
    delete recorded.meta[SETTLEMENT_PROOF_KEY]
    const diagnostic = journal.diagnostics.find(item=>item.code === (parameter ? 'PTC-X001' : 'PTC-O001'))
    diagnostic.message = parameter
      ? 'uncaught TypeError: value at $ is not PTC Value V1: non-plain object'
      : 'cell result could not cross the PTC Value V1 boundary: value at $ is not PTC Value V1: non-plain object'
    diagnostic.help = ['historical output help']
    journal.completion.error.message = renderDiagnostic(diagnostic, source)
    appendRunCodeEvents(session.events,'old-refusal',source,JSON.parse(JSON.stringify(recorded)))
    await first.dispose()
    const restored = fixture()
    t.after(()=>restored.dispose())
    const result = await restored.run(session.id,'return prior',bindings,{session})
    assert.deepEqual(result,{logs:[],value:7})
    assert.equal(calls,0)
  }
})


test('historical renderer budget failures restore retained state only for the codec-proved message', async t => {
  for (const matching of [true, false]) {
    const session = orderedSurfaceSession(`old-render-budget-${matching}`)
    const first = fixture({maxOutputBytes:1000})
    t.after(()=>first.dispose())
    const source = 'const retainedBudget = 42; return new Array(3000)'
    const recorded = JSON.parse(JSON.stringify(await first.runDurable(session.id,source,{},
      {session,recordSession:'deferred-result',callId:'old-budget'})))
    const journal = recorded.meta.dshPtcPlus
    assert.equal(journal.status,'durable')
    // A record published before these adjuncts existed: both wordings below are
    // historical renditions the retained settlement, not the text, has to survive.
    delete recorded.meta[DIAGNOSTIC_WORDING_KEY]
    delete recorded.meta[SETTLEMENT_PROOF_KEY]
    const diagnostic = journal.diagnostics.find(item=>item.code === 'PTC-O001')
    diagnostic.message = 'cell result could not cross the PTC Value V1 boundary: '
      + (matching ? 'rendered PTC value exceeds 1000 bytes' : 'unrelated old encoding failure')
    diagnostic.help = ['the worker remains live; inspect a retained binding in a later cell without rerunning the failed cell',
      'reduce the returned graph when it exceeds the configured value budget']
    journal.completion.error.message = renderDiagnostic(diagnostic,source)
    appendRunCodeEvents(session.events,'old-budget',source,recorded)
    await first.dispose()
    const restored = fixture({maxOutputBytes:1000})
    t.after(()=>restored.dispose())
    const result = await restored.run(session.id,'return typeof retainedBudget',{}, {session})
    // The settlement recorded `retainedBudget`, so both histories restore it:
    // the old rule restored it only when the rendered diagnostic matched the
    // codec wording, which made restoration depend on a message rather than on
    // what the record carries.
    assert.equal(result.value,'number')
    assert.equal((result.logs ?? []).some(log=>log.includes('PTC-R002')), false)
  }
})
