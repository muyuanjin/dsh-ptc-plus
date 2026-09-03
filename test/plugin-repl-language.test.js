import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LONG_CELL_CODE_UNITS } from '../internal/failure-reporting.js'
import { appendRunCodeEvents, fixture, ptcAgent } from './plugin-fixture.js'
import { writeRawFilenameFixture } from './raw-filename-fixture.js'

test('preflights every cross-cell binding collision with one actionable diagnostic', async (t) => {
  const state = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => state.dispose())

  await state.runDurable('collision-diagnostic', 'let executed = 0\nconst fs = 1\nconst base = 2')
  const source = 'executed += 1\nconst fs = 3\nconst base = 4'
  const observed = await state.executeRun('collision-diagnostic', source, {}, {})
  const text = [
    'error[PTC-N001]: top-level bindings already exist: fs, base. This cell was not executed; the REPL state is unchanged.',
    ' --> current:2:7',
    '> 2 | const fs = 3',
    '    |       ^^',
    'phase: preflight',
    'state: unchanged',
    'help: use a fresh name because the existing binding is immutable',
    'help: place one-off declarations inside a block',
  ].join('\n')

  assert.deepEqual(observed.raw, { logs: [], error: { kind: 'exception', message: text } })
  assert.equal(observed.result.meta.dshPtcPlus.status, 'noop')
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics, [{
    code: 'PTC-N001',
    severity: 'error',
    phase: 'preflight',
    message: 'top-level bindings already exist: fs, base. This cell was not executed; the REPL state is unchanged.',
    stateEffect: 'unchanged',
    source: {
      cell: 'current',
      start: { line: 2, column: 7 },
      end: { line: 2, column: 9 },
    },
    help: ['use a fresh name because the existing binding is immutable', 'place one-off declarations inside a block'],
  }])
  assert.deepEqual(await state.run('collision-diagnostic', 'return { executed, fs, base }'), {
    logs: [],
    value: { executed: 0, fs: 1, base: 2 },
  })
})

test('gives declaration-specific recovery for function and class collisions', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('declaration-collision-help', `
function repeatedFunction() {}
class RepeatedClass {}
`)

  const functionCollision = await state.run(
    'declaration-collision-help',
    'function repeatedFunction() {}',
  )
  assert.match(
    functionCollision.error.message,
    /help: assign a function expression to the existing writable binding/,
  )
  assert.doesNotMatch(functionCollision.error.message, /help: reuse the existing bindings/)
  assert.deepEqual(await state.run('declaration-collision-help', `
const repeatedFunction = () => 'replacement'
return repeatedFunction()
`), { logs: [], value: 'replacement' })

  const classCollision = await state.run(
    'declaration-collision-help',
    'class RepeatedClass {}',
  )
  assert.match(
    classCollision.error.message,
    /help: assign a class expression to the existing writable binding/,
  )
  assert.doesNotMatch(classCollision.error.message, /help: reuse the existing bindings/)
  assert.deepEqual(await state.run('declaration-collision-help', `
const RepeatedClass = class { static value = 42 }
return RepeatedClass.value
`), { logs: [], value: 42 })
})

test('does not suggest loose declaration replacement for strict or reserved collisions', async (t) => {
  const strict = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => strict.dispose())
  await strict.run('strict-declaration-collision-help', 'function strictFunction() {}')
  const strictCollision = await strict.run(
    'strict-declaration-collision-help',
    'function strictFunction() {}',
  )
  assert.match(strictCollision.error.message, /help: assign a function expression to the existing writable binding/)

  const loose = fixture()
  t.after(() => loose.dispose())
  await loose.run('mixed-declaration-collision-help', 'function replaceableFunction() {}')
  const reservedCollision = await loose.run('reserved-declaration-collision-help', 'class tools {}')
  assert.match(reservedCollision.error.message, /help: reuse the existing bindings/)
  assert.doesNotMatch(reservedCollision.error.message, /top-level const\/let class expressions/)

  const mixedCollision = await loose.run('mixed-declaration-collision-help', `
function replaceableFunction() {}
class tools {}
`)
  assert.match(mixedCollision.error.message, /help: reuse the existing bindings/)
  assert.doesNotMatch(mixedCollision.error.message, /top-level const\/let function expressions/)
  assert.doesNotMatch(mixedCollision.error.message, /top-level const\/let class expressions/)
})

test('independently replaces top-level functions and classes when enabled', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())

  await state.run('function-class-loose', `
let mutable = 1
function calculate(value) { return value + mutable }
class Box { static value = 1; static self() { return Box } }
`)
  const replaced = await state.run('function-class-loose', `
function calculate(value) { return value + mutable + 1 }
class Box { static value = 2; static self() { return Box } }
async function load(value) { return value * 2 }
function* values() { yield calculate(1) }
return { result: calculate(1), box: Box.value, self: Box.self() === Box, loaded: await load(3), yielded: values().next().value }
`)
  assert.deepEqual(replaced.value, {
    result: 3,
    box: 2,
    self: true,
    loaded: 6,
    yielded: 3,
  })
  assert.deepEqual(replaced.rewrites.map(rewrite => rewrite.description), [
    'reassigned an existing top-level function declaration for REPL continuity',
    'reassigned an existing top-level class declaration for REPL continuity',
  ])
})

test('keeps function/class policy independent and rejects immutable targets before execution', async (t) => {
  const disabled = fixture({ looseTopLevelFunctionClassRedeclarations: false })
  t.after(() => disabled.dispose())
  await disabled.run('function-class-disabled', 'function helper() { return 1 }\nclass Thing {}')
  const rejected = await disabled.run('function-class-disabled', 'function helper() { return 2 }\nclass Thing {}')
  assert.equal(rejected.error.kind, 'exception')
  assert.match(rejected.error.message, /helper, Thing/)
  assert.match(rejected.error.message, /function or class expressions/)
  assert.equal((await disabled.run('function-class-disabled', 'return helper()')).value, 1)

  const immutable = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: true,
  })
  t.after(() => immutable.dispose())
  await immutable.run('function-class-immutable', 'const helper = 1')
  const immutableResult = await immutable.run('function-class-immutable', 'function helper() {}')
  assert.equal(immutableResult.error.kind, 'exception')
  assert.match(immutableResult.error.message, /immutable/)
  assert.equal((await immutable.run('function-class-immutable', 'return helper')).value, 1)

  await immutable.run('function-class-import', "import { inspect as render } from 'node:util'")
  const importedResult = await immutable.run(
    'function-class-import',
    'function render() { return "replaced" }',
  )
  assert.equal(importedResult.error.kind, 'exception')
  assert.match(importedResult.error.message, /immutable/)
  assert.match((await immutable.run('function-class-import', 'return render({ answer: 42 })')).value, /answer: 42/)

  const disabledImmutable = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: false,
  })
  t.after(() => disabledImmutable.dispose())
  await disabledImmutable.run('function-class-disabled-immutable', 'const helper = 1')
  const disabledResult = await disabledImmutable.run('function-class-disabled-immutable', 'function helper() {}')
  assert.equal(disabledResult.error.kind, 'exception')
  assert.match(disabledResult.error.message, /immutable/)
  assert.doesNotMatch(disabledResult.error.message, /assign a function expression/)
})

test('keeps fresh const immutable when only function/class replacement is enabled', async (t) => {
  const state = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: true,
  })
  t.after(() => state.dispose())

  await state.run('strict-const-with-function-class-policy', 'const stable = 1')
  const assignment = await state.run('strict-const-with-function-class-policy', 'stable = 2')
  assert.equal(assignment.error.kind, 'exception')
  assert.match(assignment.error.message, /constant variable|read only|readonly/i)
  assert.equal((await state.run('strict-const-with-function-class-policy', 'return stable')).value, 1)
})

test('bounds guidance for combined variable, function, and class collisions', async (t) => {
  const state = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: false,
  })
  t.after(() => state.dispose())

  await state.run('combined-collision-guidance', `
let existingValue = 1
function existingFunction() {}
class ExistingClass {}
`)
  const observed = await state.executeRun('combined-collision-guidance', `
let existingValue = 2
function existingFunction() {}
class ExistingClass {}
`, {}, {})
  assert.equal(observed.raw.error.kind, 'exception')
  assert.match(observed.raw.error.message, /error\[PTC-N001\]/)
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics[0].help, [
    'assign function or class expressions to the existing writable bindings; reuse the existing bindings',
    'place one-off declarations inside a block',
  ])
})

test('keeps mixed immutable and variable collision guidance within the schema bound', async (t) => {
  const state = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: true,
  })
  t.after(() => state.dispose())

  await state.run('mixed-collision-guidance', 'const immutable = 1\nlet existingValue = 1')
  const observed = await state.executeRun(
    'mixed-collision-guidance',
    'function immutable() {}\nlet existingValue = 2',
    {},
    {},
  )
  assert.equal(observed.raw.error.kind, 'exception')
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics[0].help, [
    'use a fresh name because the existing binding is immutable',
    'reuse the existing bindings',
    'place one-off declarations inside a block',
  ])
})

test('terminates function/class replacement statements before parenthesized expressions', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('function-class-statement-boundary', 'function current() { return 1 }\nclass Current {}')
  const result = await state.run('function-class-statement-boundary', `
function current() { return 2 }
(function () {})()
class Current { static value = 3 }
({ value: Current.value })
return current() + Current.value
`)
  assert.equal(result.value, 5)
})

test('commits function/class replacements at declaration position with stable inner references', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('function-class-position', `
function current(value) { return value }
class Current { static value = 1 }
let replaceable = 'variable'
`)
  const result = await state.run('function-class-position', `
const beforeFunction = current(3)
const beforeClass = Current.value
function current(value) { return value <= 1 ? 1 : value * current(value - 1) }
class Current { static value = 2; static self() { return Current } }
function replaceable() { return 'function' }
return {
  beforeFunction,
  afterFunction: current(4),
  beforeClass,
  afterClass: Current.value,
  self: Current.self() === Current,
  crossKind: replaceable(),
}
`)
  assert.deepEqual(result.value, {
    beforeFunction: 3,
    afterFunction: 24,
    beforeClass: 1,
    afterClass: 2,
    self: true,
    crossKind: 'function',
  })
})

test('preserves the previous class when replacement evaluation throws', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('function-class-atomic-class', `
class Current { static value = 1 }
function fail() { throw new Error('class setup failed') }
`)
  const rejected = await state.run(
    'function-class-atomic-class',
    'class Current extends fail() { static value = 2 }',
  )
  assert.equal(rejected.error.kind, 'exception')
  assert.match(rejected.error.message, /class setup failed/)
  assert.equal((await state.run('function-class-atomic-class', 'return Current.value')).value, 1)
})

test('does not publish an uncommitted class replacement in binding inventory', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('function-class-inventory-failure', 'let Current = 1\nfunction fail() { throw new Error("boom") }')
  const failed = await state.runDurable(
    'function-class-inventory-failure',
    'class Current extends fail() { static value = 2 }',
  )
  assert.equal(failed.isError, true)
  const failedEntry = failed.meta.dshPtcPlusBindings.memory.entries.find(entry => entry.name === 'Current')
  assert.equal(failedEntry.kind, 'variable')
  assert.equal(failedEntry.definition.source, 'let Current = 1')

  const invalidOutput = await state.runDurable(
    'function-class-inventory-failure',
    'return () => {}; class Current { static value = 2 }',
  )
  assert.equal(invalidOutput.isError, true)
  assert.match(invalidOutput.error.message, /PTC-O001/)
  const invalidEntry = invalidOutput.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === 'Current')
  assert.equal(invalidEntry.kind, 'variable')
  assert.equal(invalidEntry.definition.source, 'let Current = 1')

  const earlyReturn = await state.runDurable(
    'function-class-inventory-failure',
    'return 2; class Current { static value = 2 }',
  )
  assert.equal(earlyReturn.value, 2)
  const earlyEntry = earlyReturn.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === 'Current')
  assert.equal(earlyEntry.kind, 'variable')
  assert.equal(earlyEntry.definition.source, 'let Current = 1')

  const committedThenFailed = await state.runDurable(
    'function-class-inventory-failure',
    'class Current { static value = 3 }\nthrow new Error("after commit")',
  )
  assert.equal(committedThenFailed.isError, true)
  const committedEntry = committedThenFailed.meta.dshPtcPlusBindings.memory.entries.find(entry => entry.name === 'Current')
  assert.equal(committedEntry.kind, 'class')
  assert.match(committedEntry.definition.source, /^class Current/)
})

test('publishes only same-name function declarations that reached their commit point', async (t) => {
  const events = []
  const session = { id: 'same-name-function-commits', events }
  const writer = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  const setupSource = 'function current() { return 0 }'
  const setup = await writer.runDurable(session.id, setupSource, {}, { session })
  appendRunCodeEvents(events, 'same-name-function-setup', setupSource, setup)

  const earlySource = [
    'function current() { return 1 }',
    'return current()',
    'function current() { return 2 }',
  ].join('\n')
  const early = await writer.runDurable(session.id, earlySource, {}, { session })
  assert.equal(early.value, 1)
  const earlyEntry = early.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === 'current')
  assert.equal(earlyEntry.definition.source, 'function current() { return 1 }')
  appendRunCodeEvents(events, 'same-name-function-early', earlySource, early)

  const earlyReader = fixture({ looseTopLevelFunctionClassRedeclarations: false })
  const earlyRecovered = await earlyReader.runDurable(
    session.id,
    'return current()',
    {},
    { session },
  )
  assert.equal(earlyRecovered.value, 1)
  const earlyRecoveredEntry = earlyRecovered.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === 'current')
  assert.equal(earlyRecoveredEntry.definition.source, 'function current() { return 1 }')
  await earlyReader.dispose()

  const completeSource = [
    'function current() { return 3 }',
    'function current() { return 4 }',
  ].join('\n')
  const complete = await writer.runDurable(session.id, completeSource, {}, { session })
  const completeEntry = complete.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === 'current')
  assert.equal(completeEntry.definition.source, 'function current() { return 4 }')
  appendRunCodeEvents(events, 'same-name-function-complete', completeSource, complete)
  await writer.dispose()

  const restored = fixture({ looseTopLevelFunctionClassRedeclarations: false })
  t.after(() => restored.dispose())
  const recovered = await restored.runDurable(
    session.id,
    'return current()',
    {},
    { session },
  )
  assert.equal(recovered.value, 4)
  const recoveredEntry = recovered.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === 'current')
  assert.equal(recoveredEntry.definition.source, 'function current() { return 4 }')
})

test('cold-replays function/class redeclarations with their recorded binding policy', async (t) => {
  const events = []
  const session = { id: 'function-class-replay', events }
  const writer = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => writer.dispose())
  const firstSource = 'function current() { return 1 }\nclass Current { static value = 1 }'
  const first = await writer.runDurable(session.id, firstSource, {}, { session })
  appendRunCodeEvents(events, 'function-class-first', firstSource, first)
  const secondSource = 'function current() { return 2 }\nclass Current { static value = 2 }'
  const second = await writer.runDurable(session.id, secondSource, {}, { session })
  appendRunCodeEvents(events, 'function-class-second', secondSource, second)
  assert.deepEqual(second.meta.dshPtcPlus.bindingPolicy, {
    variableRedeclarations: true,
    functionClassRedeclarations: true,
  })
  await writer.dispose()

  const restored = fixture({ looseTopLevelFunctionClassRedeclarations: false })
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return { value: current(), box: Current.value }', {}, { session }), {
    logs: [],
    value: { value: 2, box: 2 },
  })
})

test('replaces repeated top-level variables in default loose mode and cold-replays them', async (t) => {
  const events = []
  const session = { id: 'loose-redeclarations', events }
  const first = fixture()
  t.after(() => first.dispose())

  const setupCode = `
const repeatedValue = 40
const { repeatedLabel } = { repeatedLabel: 'first' }
`
  const setup = await first.runDurable(session.id, setupCode, {}, { session })
  assert.equal(setup.isError, false)
  appendRunCodeEvents(events, 'loose-setup', setupCode, setup)

  const replaceCode = `
const repeatedValue = repeatedValue + 1, addedAfterReplace = repeatedValue
const { repeatedLabel } = { repeatedLabel: repeatedLabel + '-second' }
return { repeatedValue, addedAfterReplace, repeatedLabel }
`
  const replaced = await first.runDurable(session.id, replaceCode, {}, { session })
  assert.deepEqual(replaced.value, {
    repeatedValue: 41,
    addedAfterReplace: 41,
    repeatedLabel: 'first-second',
  })
  appendRunCodeEvents(events, 'loose-replace', replaceCode, replaced)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, `
return { repeatedValue, addedAfterReplace, repeatedLabel }
`, {}, { session }), {
    logs: [],
    value: {
      repeatedValue: 41,
      addedAfterReplace: 41,
      repeatedLabel: 'first-second',
    },
  })
})

test('keeps injected capability namespaces reserved in loose mode', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.run('reserved-capability-binding', 'const { tools } = globalThis')
  assert.equal(observed.error?.kind, 'exception')
  assert.match(observed.error?.message, /error\[PTC-N001\]: top-level bindings already exist: tools/)
  assert.deepEqual(await state.run('reserved-capability-binding', 'return typeof tools.echo', { echo: async () => null }), {
    logs: [],
    value: 'function',
  })
})

test('allows ordinary locals to shadow low-frequency plugin namespaces', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('soft-plugin-names', 'const code = 7\nreturn code'), {
    logs: [],
    value: 7,
  })
  assert.deepEqual(await state.run('soft-plugin-names', 'return typeof globalThis.code.run'), {
    logs: [],
    value: 'function',
  })
})

test('keeps adjacent loose redeclarations quiet across executed cells', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('loose-redeclaration-note', 'const recentValue = 1\nconst recentLabel = "one"')
  const source = 'const recentValue = 2\nconst recentLabel = "two"\nreturn { recentValue, recentLabel }'
  const adjacent = await state.executeRun('loose-redeclaration-note', source, {}, {})
  assert.deepEqual(adjacent.raw.value, { recentValue: 2, recentLabel: 'two' })
  assert.deepEqual(adjacent.raw.logs, [])
  assert.deepEqual(adjacent.result.meta.dshPtcPlus.diagnostics, [])

  await state.run('loose-redeclaration-note', 'const broken =')
  const afterNoop = await state.run('loose-redeclaration-note', 'const recentValue = 3\nreturn recentValue')
  assert.equal(afterNoop.value, 3)
  assert.deepEqual(afterNoop.logs, [])

  await state.run('loose-redeclaration-note', 'return recentValue')
  const afterExecutedGap = await state.run('loose-redeclaration-note', 'const recentValue = 4\nreturn recentValue')
  assert.deepEqual(afterExecutedGap, { logs: [], value: 4 })

  await state.run('loose-note-with-volatility', 'const volatileRecentValue = 1')
  const volatile = await state.executeRun(
    'loose-note-with-volatility',
    'const volatileRecentValue = Date.now()\nreturn volatileRecentValue',
    {},
    {},
  )
  assert.deepEqual(volatile.result.meta.dshPtcPlus.diagnostics, [])
  assert.deepEqual(volatile.raw.logs, [])
})

test('keeps recovered adjacent redeclarations quiet', async (t) => {
  const events = []
  const session = { id: 'loose-note-replay', events }
  const writer = fixture()
  const source = 'const recoveredRecentValue = 1'
  const written = await writer.runDurable(session.id, source, {}, { session })
  appendRunCodeEvents(events, 'loose-note-setup', source, written)
  await writer.dispose()

  const reader = fixture()
  t.after(() => reader.dispose())
  const result = await reader.run(session.id, 'const recoveredRecentValue = 2\nreturn recoveredRecentValue', {}, { session })
  assert.equal(result.value, 2)
  assert.deepEqual(result.logs, [])
})

test('preserves declaration TDZ while loosening new top-level const bindings', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('loose-tdz', `
const first = (() => {
  try { return typeof second }
  catch (error) { return error.name }
})(), second = 1
return { first, second }
`), {
    logs: [],
    value: { first: 'ReferenceError', second: 1 },
  })
})

test('replays each journal node with its recorded binding mode', async (t) => {
  const looseEvents = []
  const looseSession = { id: 'recorded-loose-mode', events: looseEvents }
  const looseWriter = fixture()
  const looseFirstCode = 'const switchedBinding = 1'
  const looseFirst = await looseWriter.runDurable(looseSession.id, looseFirstCode, {}, { session: looseSession })
  appendRunCodeEvents(looseEvents, 'loose-mode-first', looseFirstCode, looseFirst)
  const looseSecondCode = 'const switchedBinding = switchedBinding + 1'
  const looseSecond = await looseWriter.runDurable(looseSession.id, looseSecondCode, {}, { session: looseSession })
  appendRunCodeEvents(looseEvents, 'loose-mode-second', looseSecondCode, looseSecond)
  assert.deepEqual(looseSecond.meta.dshPtcPlus.bindingPolicy, {
    variableRedeclarations: true,
    functionClassRedeclarations: false,
  })
  await looseWriter.dispose()

  const strictReader = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => strictReader.dispose())
  assert.deepEqual(await strictReader.run(looseSession.id, 'return switchedBinding', {}, { session: looseSession }), {
    logs: [],
    value: 2,
  })

  const strictEvents = []
  const strictSession = { id: 'recorded-strict-mode', events: strictEvents }
  const strictWriter = fixture({ looseTopLevelRedeclarations: false })
  const strictCode = 'let strictHistorySide = 0\nconst strictHistoryBinding = 3'
  const strictResult = await strictWriter.runDurable(strictSession.id, strictCode, {}, { session: strictSession })
  assert.deepEqual(strictResult.meta.dshPtcPlus.bindingPolicy, {
    variableRedeclarations: false,
    functionClassRedeclarations: false,
  })
  const strictPredecessor = structuredClone(strictResult)
  strictPredecessor.meta.dshPtcPlus.version = 3
  strictPredecessor.meta.dshPtcPlus.bindingMode = 'strict'
  delete strictPredecessor.meta.dshPtcPlus.bindingPolicy
  delete strictPredecessor.meta.dshPtcPlus.moduleSemantics
  appendRunCodeEvents(strictEvents, 'strict-mode-cell', strictCode, strictPredecessor)
  await strictWriter.dispose()

  const looseReader = fixture()
  t.after(() => looseReader.dispose())
  const strictAssignment = await looseReader.run(
    strictSession.id,
    'strictHistoryBinding = 4',
    {},
    { session: strictSession },
  )
  assert.equal(strictAssignment.error.kind, 'exception')
  assert.match(strictAssignment.error.message, /constant variable|read only|readonly/i)
  const strictRedeclaration = await looseReader.run(
    strictSession.id,
    'strictHistorySide = 9\nconst strictHistoryBinding = 4',
    {},
    { session: strictSession },
  )
  assert.equal(strictRedeclaration.error.kind, 'exception')
  assert.match(strictRedeclaration.error.message, /PTC-N001.*immutable/s)
  assert.deepEqual(await looseReader.run(strictSession.id, 'return [strictHistoryBinding, strictHistorySide]', {}, { session: strictSession }), {
    logs: [],
    value: [3, 0],
  })
})

test('splits a loose destructuring declarator that mixes existing and new bindings', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('loose-mixed-pattern', 'const existingPatternValue = 1')

  const observed = await state.executeRun('loose-mixed-pattern', `
const { existingPatternValue, newPatternValue } = { existingPatternValue: 2, newPatternValue: 3 }
`, {}, {})
  assert.equal(observed.raw.error, undefined)
  assert.deepEqual(await state.run('loose-mixed-pattern', `
return { existingPatternValue, newPatternValue, newPatternType: typeof newPatternValue }
`), {
    logs: [],
    value: { existingPatternValue: 2, newPatternValue: 3, newPatternType: 'number' },
  })
  const rewrites = observed.result.meta.dshPtcPlusRewrites
  assert.equal(rewrites.length, 1)
  assert.equal(rewrites[0].kind, 'redeclaration')
  assert.equal(rewrites[0].source, 'existingPatternValue')
  assert.match(rewrites[0].description, /split a mixed top-level declaration/)
})

test('preserves destructuring semantics across split redeclarations', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('split-semantics', 'const root = { a: 1, nested: { b: 2 }, list: [3, 4] }')
  const result = await state.run('split-semantics', `
const { a, nested: { b }, list: [first, ...rest] } = root
return { a, b, first, rest }
`)
  assert.deepEqual(result, { logs: [], value: { a: 1, b: 2, first: 3, rest: [4] } })
  await state.run('split-semantics', 'const first = 9')
  const mixed = await state.run('split-semantics', `
const { list: [renamed, second] } = root
return { renamed, second, first }
`)
  assert.deepEqual(mixed, { logs: [], value: { renamed: 3, second: 4, first: 9 } })
  const defaults = await state.run('split-semantics', `
const { missing = 5, a: existingA } = root
return { missing, existingA }
`)
  assert.deepEqual(defaults, { logs: [], value: { missing: 5, existingA: 1 } })
})

test('maps mixed destructuring failures to copied source tokens', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('split-position', 'const old = 7')
  const source = 'const {old, fresh = (() => { throw new Error("boom") })()} = {}'
  const failed = await state.runDurable('split-position', source)
  assert.equal(failed.isError, true)
  assert.deepEqual(failed.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 1, column: 36 },
  })
  assert.match(failed.error.message, /--> current:1:36/)

  for (const [session, declaration] of [
    ['split-position-existing', 'const {old, fresh} = {old: 1, fresh: 2}, old2 = (() => { throw new Error("existing") })()'],
    ['split-position-fresh', 'const {old, fresh} = {old: 1, fresh: 2}, later = (() => { throw new Error("fresh") })()'],
  ]) {
    await state.run(session, 'const old = 7\nconst old2 = 8')
    const adjacent = await state.runDurable(session, declaration)
    const column = declaration.indexOf('new Error') + 1
    assert.equal(adjacent.isError, true)
    assert.deepEqual(adjacent.meta.dshPtcPlus.diagnostics[0].source, {
      cell: 'current', start: { line: 1, column },
    })
  }

  const composedSession = 'split-position-module'
  await state.run(composedSession, 'const old = 7')
  const composedSource = 'import { inspect } from "node:util"; const {old, fresh = (() => { throw new Error("composed") })()} = {}'
  const composed = await state.runDurable(composedSession, composedSource)
  assert.equal(composed.isError, true)
  assert.deepEqual(composed.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 1, column: composedSource.indexOf('new Error') + 1 },
  })
})

test('splits mixed declarators within one statement and var declarations', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('split-multi', 'const r1 = 1')
  const result = await state.run('split-multi', `
const { r1, r2 } = { r1: 10, r2: 20 }, { r3 } = { r3: 30 }
return { r1, r2, r3 }
`)
  assert.equal(result.error, undefined)
  assert.deepEqual({ logs: result.logs, value: result.value }, { logs: [], value: { r1: 10, r2: 20, r3: 30 } })
  await state.run('split-var', 'var v1 = 1')
  const varResult = await state.run('split-var', `
var { v1, v2 } = { v1: 11, v2: 22 }
return { v1, v2 }
`)
  assert.equal(varResult.error, undefined)
  assert.deepEqual({ logs: varResult.logs, value: varResult.value }, { logs: [], value: { v1: 11, v2: 22 } })
  const awaitedVarResult = await state.run('split-var', `
  var { v1, v3 = 23 } = await Promise.resolve({ v1: 12 })
return { v1, v3 }
`)
  assert.deepEqual({ logs: awaitedVarResult.logs, value: awaitedVarResult.value }, { logs: [], value: { v1: 12, v3: 23 } })
  await state.run('split-var-shapes', 'var v1 = 1\nvar vRest = {}')
  const varShapes = await state.run('split-var-shapes', `
  var { v1 = 4, list: [v2, v3], ...vRest } = { list: [22, 24], extra: 33 }
return { v1, v2, v3, vRest }
`)
  assert.deepEqual({ logs: varShapes.logs, value: varShapes.value }, {
    logs: [],
    value: { v1: 4, v2: 22, v3: 24, vRest: { extra: 33 } },
  })
})

test('preserves mixed declarator evaluation order and fresh-binding TDZ', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('split-order', 'const existing = 0\nconst order = []')
  const ordered = await state.run('split-order', `
const first = (order.push('first'), 1), { existing, fresh } = (order.push('second'), { existing: 2, fresh: 3 })
return { first, existing, fresh, order }
`)
  assert.equal(ordered.error, undefined)
  assert.deepEqual(ordered.value, { first: 1, existing: 2, fresh: 3, order: ['first', 'second'] })

  await state.run('split-tdz', 'const existing = 0')
  const tdz = await state.run('split-tdz', 'const { existing, fresh } = { fresh }')
  assert.equal(tdz.error.kind, 'exception')
  assert.match(tdz.error.message, /ReferenceError/)

  await state.run('split-default-reference', 'const existing = 7')
  const defaultReference = await state.run('split-default-reference', `
const { existing, fresh, later = fresh } = await Promise.resolve({ existing: 8, fresh: 9 })
return { existing, fresh, later }
`)
  assert.deepEqual({ logs: defaultReference.logs, value: defaultReference.value }, { logs: [], value: { existing: 8, fresh: 9, later: 9 } })

  await state.run('split-default-same-binding', 'const a = 7')
  const sameBindingDefault = await state.run('split-default-same-binding', `
const { a, b = a } = { a: 8 }
return { a, b }
`)
  assert.deepEqual({ logs: sameBindingDefault.logs, value: sameBindingDefault.value }, { logs: [], value: { a: 8, b: 8 } })
  const nestedDefault = await state.run('split-default-same-binding', `
const { a, c = [a][0] } = { a: 9 }
return { a, c }
`)
  assert.deepEqual({ logs: nestedDefault.logs, value: nestedDefault.value }, { logs: [], value: { a: 9, c: 9 } })
  const shadowedDefault = await state.run('split-default-same-binding', `
const { a, d = (function local(a) { return a })(12) } = { a: 10 }
return { a, d }
`)
  assert.deepEqual({ logs: shadowedDefault.logs, value: shadowedDefault.value }, { logs: [], value: { a: 10, d: 12 } })
  const nestedShadow = await state.run('split-default-same-binding', `
const { a, locallyShadowed = (() => { const a = 5; return a })() } = { a: 11 }
return { a, locallyShadowed }
`)
  assert.deepEqual(nestedShadow.value, { a: 11, locallyShadowed: 5 })
  const computed = await state.run('split-default-same-binding', `
const { a, [a]: computedFresh } = { a: 'selected', selected: 13 }
return { a, computedFresh }
`)
  assert.deepEqual(computed.value, { a: 'selected', computedFresh: 13 })
  const protoBinding = await state.run('split-default-same-binding', `
const { a, __proto__ } = { a: 12, ['__proto__']: 14 }
return { a, protoValue: __proto__ }
`)
  assert.deepEqual(protoBinding.value, { a: 12, protoValue: 14 })

  await state.run('split-initializer-scope', 'const existing = 11')
  const initializerScope = await state.run('split-initializer-scope', `
const { existing, fresh } = { fresh: existing }
return [existing, fresh]
`)
  assert.deepEqual({ logs: initializerScope.logs, value: initializerScope.value }, { logs: [], value: '[undefined, 11]' })

  await state.run('split-shapes', 'const shapeExisting = 0')
  const shapes = await state.run('split-shapes', `
const { shapeExisting, nested: { shapeFresh }, list: [, shapeHead, ...shapeTail], ...shapeRest } = { shapeExisting: 4, nested: { shapeFresh: 5 }, list: [0, 6, 7], extra: 8 }
return { shapeExisting, shapeFresh, shapeHead, shapeTail, shapeRest }
`)
  assert.equal(shapes.error, undefined)
  assert.deepEqual(shapes.value, {
    shapeExisting: 4,
    shapeFresh: 5,
    shapeHead: 6,
    shapeTail: [7],
    shapeRest: { extra: 8 },
  })

  await state.run('split-default', 'const defaultExisting = 0')
  const defaults = await state.run('split-default', 'const { defaultExisting, defaultFresh = 5 } = { defaultExisting: 4 }\nreturn { defaultExisting, defaultFresh }')
  assert.equal(defaults.error, undefined)
  assert.deepEqual(defaults.value, { defaultExisting: 4, defaultFresh: 5 })
})

test('replays split redeclarations from the session log', async (t) => {
  const first = fixture()
  const session = { id: 'split-replay', events: [] }
  const code = `
const { existingPatternValue, newPatternValue } = { existingPatternValue: 2, newPatternValue: 3 }
return newPatternValue
`
  const setupCode = 'const existingPatternValue = 1'
  const observed = await first.runDurable('split-replay', setupCode, {}, { session })
  appendRunCodeEvents(session.events, 'split-replay-declare', setupCode, observed)
  const observedSplit = await first.runDurable('split-replay', code, {}, { session })
  assert.equal(observedSplit.value, 3)
  appendRunCodeEvents(session.events, 'split-replay-mixed', code, observedSplit)
  first.dispose()
  const restored = fixture()
  t.after(() => restored.dispose())
  const reused = await restored.run('split-replay', 'return { existingPatternValue, newPatternValue }', {}, { session })
  assert.deepEqual(reused, { logs: [], value: { existingPatternValue: 2, newPatternValue: 3 } })
})

test('keeps mixed redeclarations rejected when autoSplitRedeclarations is disabled', async (t) => {
  const state = fixture({ autoSplitRedeclarations: false })
  t.after(() => state.dispose())
  await state.run('split-disabled', 'const existingPatternValue = 1')
  const result = await state.run('split-disabled', `
const { existingPatternValue, newPatternValue } = { existingPatternValue: 2, newPatternValue: 3 }
`)
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /error\[PTC-N001\]: top-level bindings already exist: existingPatternValue/)
  assert.deepEqual(await state.run('split-disabled', `
return { existingPatternValue, newPatternType: typeof newPatternValue }
`), {
    logs: [],
    value: { existingPatternValue: 1, newPatternType: 'undefined' },
  })
})

test('covers the complete REPL binding-pattern matrix and collision boundaries', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const initial = await state.run('repl-pattern-matrix', `
const existingValue = 1
let existingObject = { old: true }
var existingVar = 3
function existingFunction() { return 'original' }
class ExistingClass {}
`)
  assert.deepEqual(initial.logs, [])

  const destructured = await state.run('repl-pattern-matrix', `
const key = 'renamed'
const {
  existingValue,
  [key]: computedFresh = 5,
  nested: { child: nestedFresh },
  list: [, firstFresh, ...tailFresh],
  ...restFresh
} = {
  existingValue: 7,
  renamed: undefined,
  nested: { child: 8 },
  list: [0, 9, 10],
  extra: 11,
}
const [arrayExisting, , arrayFresh = 12, ...arrayRest] = [13, 14]
return { existingValue, computedFresh, nestedFresh, firstFresh, tailFresh, restFresh, arrayExisting, arrayFresh, arrayRest }
`)
  assert.deepEqual({ logs: destructured.logs, value: destructured.value }, {
    logs: [],
    value: {
      existingValue: 7,
      computedFresh: 5,
      nestedFresh: 8,
      firstFresh: 9,
      tailFresh: [10],
      restFresh: { extra: 11 },
      arrayExisting: 13,
      arrayFresh: 12,
      arrayRest: [],
    },
  })
  assert.equal(destructured.rewrites.length, 1)

  const replaced = await state.run('repl-pattern-matrix', `
var { existingVar, newVar = existingVar + 1 } = { existingVar: 20 }
let { existingObject, newObject } = { existingObject: { next: true }, newObject: 21 }
return { existingVar, newVar, existingObject, newObject }
`)
  assert.deepEqual({ logs: replaced.logs, value: replaced.value }, {
    logs: [],
    value: { existingVar: 20, newVar: 21, existingObject: { next: true }, newObject: 21 },
  })

  assert.equal((await state.run('repl-pattern-matrix', 'function existingFunction() {}')).error.kind, 'exception')
  assert.equal((await state.run('repl-pattern-matrix', 'class ExistingClass {}')).error.kind, 'exception')
  assert.deepEqual(await state.run('repl-pattern-matrix', 'var existingVar = 30\nreturn existingVar'), {
    logs: [],
    value: 30,
  })
  assert.deepEqual(await state.run('repl-pattern-matrix', 'let existingObject = {}\nreturn existingObject'), {
    logs: [],
    value: {},
  })
})

test('keeps loose REPL convenience out of strict cells and preserves session replay', async (t) => {
  const session = { id: 'repl-pattern-replay', events: [] }
  const writer = fixture()
  t.after(() => writer.dispose())
  const setupCode = 'const replayExisting = 1'
  const setup = await writer.runDurable(session.id, setupCode, {}, { session })
  appendRunCodeEvents(session.events, 'replay-setup', setupCode, setup)
  const mixedCode = 'const { replayExisting, replayFresh = 2 } = { replayExisting: 4 }\nreturn replayFresh'
  const mixed = await writer.runDurable(session.id, mixedCode, {}, { session })
  appendRunCodeEvents(session.events, 'replay-mixed', mixedCode, mixed)
  assert.deepEqual(mixed.value, 2)
  await writer.dispose()

  const strict = fixture({ autoSplitRedeclarations: false })
  t.after(() => strict.dispose())
  const rejected = await strict.run('repl-pattern-strict', 'const strictExisting = 1')
  assert.deepEqual(rejected.logs, [])
  const invalid = await strict.run('repl-pattern-strict', 'const { strictExisting, strictFresh } = { strictExisting: 2, strictFresh: 3 }')
  assert.equal(invalid.error.kind, 'exception')
  assert.match(invalid.error.message, /strictExisting/)

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return { replayExisting, replayFresh }', {}, { session }), {
    logs: [],
    value: { replayExisting: 4, replayFresh: 2 },
  })
})

test('keeps same-name function/class declarations ordered across an intervening exception', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('same-name-order-exception', 'function layer() { return 0 }\nclass Layer { static value = 0 }')

  const failed = await state.runDurable('same-name-order-exception', [
    'function layer() { return 1 }',
    'throw new Error("mid"); class Layer { static value = 1 }',
    'function layer() { return 2 }',
  ].join('\n'))
  assert.equal(failed.isError, true)
  assert.match(failed.error.message, /mid/)
  const failedEntry = failed.meta.dshPtcPlusBindings.memory.entries.find(entry => entry.name === 'layer')
  assert.equal(failedEntry.kind, 'function')
  assert.equal(failedEntry.definition.source, 'function layer() { return 1 }')
  const failedClassEntry = failed.meta.dshPtcPlusBindings.memory.entries.find(entry => entry.name === 'Layer')
  assert.equal(failedClassEntry.kind, 'class')
  assert.equal(failedClassEntry.definition.source, 'class Layer { static value = 0 }')

  assert.deepEqual(await state.run('same-name-order-exception', 'return [layer(), Layer.value]'), {
    logs: [],
    value: [1, 0],
  })
  const completed = await state.runDurable('same-name-order-exception', [
    'function layer() { return 3 }',
    'class Layer { static value = 3 }',
    'function layer() { return 4 }',
    'return [layer(), Layer.value]',
  ].join('\n'))
  assert.deepEqual(completed.value, [4, 3])
  const completedEntry = completed.meta.dshPtcPlusBindings.memory.entries.find(entry => entry.name === 'layer')
  assert.equal(completedEntry.kind, 'function')
  assert.equal(completedEntry.definition.source, 'function layer() { return 4 }')
})

test('replaces class bindings by functions and function bindings by classes with live inner references', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('cross-kind-replacement', [
    'function machine(label) { return "fn-" + label }',
    'class gadget { static kind() { return gadget } }',
  ].join('\n'))

  const replaced = await state.run('cross-kind-replacement', [
    'function gadget(label) { return label === "deep" ? gadget("step") : "fn-" + label }',
    'class machine { static kind() { return machine } }',
    'return { fn: gadget("plain"), deep: gadget("deep"), cls: machine.kind() === machine }',
  ].join('\n'))
  assert.deepEqual(replaced.value, { fn: 'fn-plain', deep: 'fn-step', cls: true })
  assert.deepEqual(replaced.rewrites.map(rewrite => rewrite.description), [
    'reassigned an existing top-level function declaration for REPL continuity',
    'reassigned an existing top-level class declaration for REPL continuity',
  ])

  const reads = await state.runDurable('cross-kind-replacement', 'return [gadget("again"), typeof machine.kind, machine.kind() === machine]')
  assert.deepEqual(reads.value, ['fn-again', 'function', true])
  const entries = reads.meta.dshPtcPlusBindings.memory.entries
  assert.equal(entries.find(entry => entry.name === 'gadget').kind, 'function')
  assert.equal(entries.find(entry => entry.name === 'machine').kind, 'class')
})

test('publishes kind and declaration source for every committed function/class replacement', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('function-class-inventory', 'function current() { return 0 }\nclass Current { static value = 0 }')

  const result = await state.runDurable('function-class-inventory', [
    'function current() { return 9 }',
    'class Current { static value = 9 }',
    'return [current(), Current.value]',
  ].join('\n'))
  assert.deepEqual(result.value, [9, 9])
  const current = result.meta.dshPtcPlusBindings.memory.entries.find(entry => entry.name === 'current')
  assert.equal(current.kind, 'function')
  assert.deepEqual(current.definition, { source: 'function current() { return 9 }', line: 1, column: 1 })
  const Current = result.meta.dshPtcPlusBindings.memory.entries.find(entry => entry.name === 'Current')
  assert.equal(Current.kind, 'class')
  assert.deepEqual(Current.definition, { source: 'class Current { static value = 9 }', line: 2, column: 1 })
  assert.deepEqual(result.meta.dshPtcPlus.diagnostics, [])
})

test('keeps the function/class replacement provenance out of quiet adjacent cells and its policy recorded', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())
  await state.run('quiet-function-class', 'function quiet() { return 1 }\nclass Quiet { static value = 1 }')
  const source = 'function quiet() { return 2 }\nclass Quiet { static value = 2 }\nreturn quiet() + Quiet.value'
  const observed = await state.executeRun('quiet-function-class', source, {}, {})
  assert.deepEqual(observed.raw.value, 4)
  assert.deepEqual(observed.raw.logs, [])
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics, [])
  assert.deepEqual(observed.result.meta.dshPtcPlus.bindingPolicy, {
    variableRedeclarations: true,
    functionClassRedeclarations: true,
  })
  assert.deepEqual(observed.result.meta.dshPtcPlusRewrites.map(rewrite => rewrite.source), ['quiet', 'Quiet'])
})

test('rejects a function/class replacement of an immutable target even when only the class policy is enabled', async (t) => {
  const state = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: true,
  })
  t.after(() => state.dispose())
  await state.run('only-class-policy-immutable', "import { format } from 'node:util'\nconst locked = 1")

  const functionTarget = await state.run('only-class-policy-immutable', 'function format() {}')
  assert.equal(functionTarget.error.kind, 'exception')
  assert.match(functionTarget.error.message, /PTC-N001.*immutable/s)
  assert.doesNotMatch(functionTarget.error.message, /assign a function expression/)
  const classTarget = await state.run('only-class-policy-immutable', 'class locked {}')
  assert.equal(classTarget.error.kind, 'exception')
  assert.match(classTarget.error.message, /PTC-N001.*immutable/s)
  assert.doesNotMatch(classTarget.error.message, /assign a class expression/)
  assert.deepEqual(await state.run('only-class-policy-immutable', "return [typeof format, locked]"), {
    logs: [],
    value: ['function', 1],
  })
})

test('rejects function/class declarations only when their policy is disabled despite loose variables', async (t) => {
  const state = fixture({
    looseTopLevelRedeclarations: true,
    looseTopLevelFunctionClassRedeclarations: false,
  })
  t.after(() => state.dispose())
  await state.run('disabled-function-class-loose-variables', 'function helper() { return 1 }\nclass Helper { static value = 1 }')

  const rejected = await state.run('disabled-function-class-loose-variables', 'function helper() { return 2 }\nclass Helper { static value = 2 }')
  assert.equal(rejected.error.kind, 'exception')
  assert.match(rejected.error.message, /helper, Helper/)
  assert.match(rejected.error.message, /assign function or class expressions to the existing writable bindings/)
  assert.deepEqual(await state.run('disabled-function-class-loose-variables', 'return [helper(), Helper.value]'), {
    logs: [],
    value: [1, 1],
  })
})

test('rejects goal-style host calls without an initiator boundary', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  // Mirrors the DSH goal tools' goalToolExecution check: without an agents
  // service the worker callback carries no initiator, so the call fails.
  const goalLike = async () => {
    throw new Error('goal tools require the exact live calling agent inside its active driver')
  }
  const result = await state.run('goal-bare', 'return await tools.create_goal({ objective: "x" })', { create_goal: goalLike })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /exact live calling agent inside its active driver/)
})

test('restores the initiator boundary for host tool calls from a cell', async (t) => {
  const als = new AsyncLocalStorage()
  const agents = {
    withInitiator: (agent, operation) => als.run(agent, operation),
    currentInitiator: () => als.getStore(),
  }
  const state = fixture({}, { agents })
  t.after(() => state.dispose())
  const goalLike = async () => {
    const initiator = agents.currentInitiator()
    if (initiator === undefined || initiator.id !== 'goal-agent-session') {
      throw new Error('goal tools require the exact live calling agent inside its active driver')
    }
    return { initiatorId: initiator.id }
  }
  const result = await state.run(
    'goal-agent-session',
    'return await tools.create_goal({ objective: "x" })',
    { create_goal: goalLike },
  )
  assert.deepEqual(result, { logs: [], value: { initiatorId: 'goal-agent-session' } })
})

test('renders parse failures with a cell-relative code frame and unchanged state', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.executeRun('parse-diagnostic', 'const value =', {}, {})
  const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(observed.result.meta.dshPtcPlus.status, 'noop')
  assert.equal(diagnostic.code, 'PTC-C001')
  assert.equal(diagnostic.phase, 'parse')
  assert.equal(diagnostic.stateEffect, 'unchanged')
  assert.deepEqual(diagnostic.help, [
    'this cell was not executed; correct the reported syntax and retry only this cell with run_code',
  ])
  assert.deepEqual(diagnostic.source, { cell: 'current', start: { line: 1, column: 14 } })
  assert.deepEqual(observed.raw.logs, [])
  assert.match(observed.raw.error.message, /^error\[PTC-C001\]: cell could not be parsed:/)
  assert.match(observed.raw.error.message, /> 1 \| const value =\n    \|              \^/)
  assert.match(observed.raw.error.message, /help: this cell was not executed; correct the reported syntax/)
  assert.match(observed.raw.error.message, /retry only this cell with run_code/)
  assert.doesNotMatch(observed.raw.error.message, /edit_run_code/)
  assert.doesNotMatch(observed.raw.error.message, /reuse (?:it|the existing bindings)/)
  assert.doesNotMatch(observed.raw.error.message, /\x1b\[/)
  assert.deepEqual(await state.run('parse-diagnostic', 'return typeof value'), {
    logs: [],
    value: 'undefined',
  })

  const unterminated = await state.executeRun('parse-diagnostic', 'function open() {', {}, {})
  assert.deepEqual(unterminated.result.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 1, column: 18 },
  })

  const longSource = `/*${'x'.repeat(LONG_CELL_CODE_UNITS)}*/\nconst longValue =`
  const long = await state.executeRun('long-parse-diagnostic', longSource, {}, {})
  assert.deepEqual(long.result.meta.dshPtcPlus.diagnostics[0].help, [
    'this cell was not executed; when edit_run_code is declared for the current request and the correction is small and localized, use it to avoid resending this long source; otherwise retry only this cell with corrected source in run_code',
  ])
  assert.match(long.raw.error.message, /when edit_run_code is declared for the current request/)
  assert.match(long.raw.error.message, /correction is small and localized/)
  assert.match(long.raw.error.message, /otherwise retry only this cell with corrected source in run_code/)
  assert.doesNotMatch(long.raw.error.message, /reuse (?:it|the existing bindings)/)
})

test('keeps rewrite-time diagnostics on exact original cell spans', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const malformed = await state.executeRun(
    'module-diagnostic-malformed',
    "import x from 'node:path'; const broken =",
    {},
    {},
  )
  assert.deepEqual(malformed.result.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 1, column: 42 },
  })
  assert.match(malformed.raw.error.message, /> 1 \| import x from 'node:path'; const broken =/)

  for (const [source, position] of [
    ['export { missing }', { line: 1, column: 10 }],
    ['const ok = 1\nexport { missing }', { line: 2, column: 10 }],
  ]) {
    const missing = await state.executeRun('module-diagnostic-missing', source, {}, {})
    assert.deepEqual(missing.result.meta.dshPtcPlus.diagnostics[0].source, {
      cell: 'current', start: position,
    })
    assert.match(missing.raw.error.message, /export \{ missing \}/)
  }

  const forbidden = await state.executeRun(
    'module-diagnostic-forbidden',
    "import { parentPort } from 'node:worker_threads'",
    {},
    {},
  )
  assert.deepEqual(forbidden.result.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current',
    start: { line: 1, column: 28 },
    end: { line: 1, column: 49 },
  })

  const strict = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => strict.dispose())
  await strict.run('module-diagnostic-collision', 'const existing = 1')
  const collision = await strict.executeRun(
    'module-diagnostic-collision',
    "import { basename as existing } from 'node:path'",
    {},
    {},
  )
  assert.deepEqual(collision.result.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current',
    start: { line: 1, column: 22 },
    end: { line: 1, column: 30 },
  })
})

test('preserves cwd-aware public properties on wrapped filesystem functions', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-fs-properties-'))
  const nativeProject = await realpath(project)
  await writeFile(join(project, 'value.txt'), 'session-value')
  await mkdir(join(project, 'relative-dir'))
  await writeFile(join(project, 'relative-dir', 'entry.txt'), 'session-entry')
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('filesystem-properties-cwd', [
    "const fs = require('node:fs')",
    "const { promisify } = require('node:util')",
    "const asyncPath = await new Promise((resolve, reject) => fs.realpath.native('value.txt', (error, value) => error === null ? resolve(value) : reject(error)))",
    "const syncPath = fs.realpathSync.native('value.txt')",
    "const exists = await promisify(fs.exists)('value.txt')",
    "const directory = await promisify(fs.promises.opendir)('relative-dir')",
    'const directoryEntries = []',
    'for await (const entry of directory) directoryEntries.push(entry.name)',
    'const nativeDescriptor = Object.getOwnPropertyDescriptor(fs.realpath, "native")',
    'const existsDescriptor = Object.getOwnPropertyDescriptor(fs.exists, promisify.custom)',
    'const opendirDescriptor = Object.getOwnPropertyDescriptor(fs.promises.opendir, promisify.custom)',
    'return { asyncPath, syncPath, exists, directoryEntries, opendirSelfReference: fs.promises.opendir[promisify.custom] === fs.promises.opendir, opendirDescriptor: [opendirDescriptor.enumerable, opendirDescriptor.writable, opendirDescriptor.configurable], realpathKeys: Reflect.ownKeys(fs.realpath).map(String), existsKeys: Reflect.ownKeys(fs.exists).map(String), nativeDescriptor: [nativeDescriptor.enumerable, nativeDescriptor.writable, nativeDescriptor.configurable], existsDescriptor: [existsDescriptor.enumerable, existsDescriptor.writable, existsDescriptor.configurable] }',
  ].join('\n'), {}, { session })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.value, {
    asyncPath: join(nativeProject, 'value.txt'),
    syncPath: join(nativeProject, 'value.txt'),
    exists: true,
    directoryEntries: ['entry.txt'],
    opendirSelfReference: true,
    opendirDescriptor: [false, false, true],
    realpathKeys: ['length', 'name', 'prototype', 'native'],
    existsKeys: ['length', 'name', 'prototype', 'Symbol(nodejs.util.promisify.custom)'],
    nativeDescriptor: [true, true, true],
    existsDescriptor: [false, false, false],
  })
})

test('preserves relative symlink target payloads', { skip: process.platform === 'win32' }, async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-symlink-cwd-'))
  await mkdir(join(project, 'dir'))
  await writeFile(join(project, 'dir', 'target.txt'), 'session-value')
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('symlink-cwd', [
    "const fs = require('node:fs')",
    "const { promisify } = require('node:util')",
    "await promisify(fs.symlink)('target.txt', 'dir/async-link.txt')",
    "fs.symlinkSync('target.txt', 'dir/sync-link.txt')",
    "return [fs.readlinkSync('dir/async-link.txt'), fs.readFileSync('dir/async-link.txt', 'utf8'), fs.readlinkSync('dir/sync-link.txt'), fs.readFileSync('dir/sync-link.txt', 'utf8')]",
  ].join('\n'), {}, { session })
  assert.deepEqual(result.value, ['target.txt', 'session-value', 'target.txt', 'session-value'])
})

test('preserves raw bytes in relative Buffer filesystem paths', { skip: process.platform === 'win32' }, async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-buffer-cwd-'))
  t.after(async () => {
    await rm(project, { recursive: true, force: true })
  })
  const filename = Buffer.from([0x72, 0x61, 0x77, 0x2d, 0x80])
  if (await writeRawFilenameFixture(project, filename, 'session-value') === undefined) {
    t.skip('The active filesystem cannot represent arbitrary POSIX filename bytes')
    return
  }
  const state = fixture()
  t.after(() => state.dispose())
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('buffer-path-cwd', [
    "const fs = require('node:fs')",
    `const relative = Buffer.from(${JSON.stringify([...filename])})`,
    "const absolute = Buffer.concat([Buffer.from(process.cwd() + '/'), relative])",
    "return [fs.readFileSync(relative, 'utf8'), fs.readFileSync(absolute, 'utf8')]",
  ].join('\n'), {}, { session })
  assert.deepEqual(result.value, ['session-value', 'session-value'])
})

test('virtualizes static node:process cwd exports with the global process view', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-process-cwd-'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const session = { events: [], header: { cwd: project } }
  const result = await state.run('process-import-cwd', [
    "import { cwd } from 'node:process'",
    "import * as processNamespace from 'node:process'",
    'return { named: cwd(), namespace: processNamespace.cwd(), global: process.cwd() }',
  ].join('\n'), {}, { session })
  assert.deepEqual(result.value, { named: project, namespace: project, global: project })
})

test('shares process lifecycle guards across every module access path', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const identities = await state.run('process-control-identities', [
    "import processDefault, { abort, chdir, kill } from 'node:process'",
    "import * as processNamespace from 'node:process'",
    "const required = require('node:process')",
    "const dynamic = await import('node:process')",
    'processDefault.exit = () => undefined',
    'required.kill = () => undefined',
    'return {',
    '  defaultExit: processDefault.exit === process.exit,',
    '  namespaceAbort: processNamespace.abort === process.abort,',
    '  namedChdir: chdir === process.chdir,',
    '  namedKill: kill === process.kill,',
    '  requiredExit: required.exit === process.exit,',
    '  requiredKill: required.kill === process.kill,',
    '  dynamicExit: dynamic.exit === process.exit,',
    '}',
  ].join('\n'))
  assert.deepEqual(identities.value, {
    defaultExit: true,
    namespaceAbort: true,
    namedChdir: true,
    namedKill: true,
    requiredExit: true,
    requiredKill: true,
    dynamicExit: true,
  })

  const rejected = await state.run('process-control-rejection', [
    "import processModule from 'node:process'",
    'processModule.exit(0)',
  ].join('\n'))
  assert.equal(rejected.error.kind, 'exception')
  assert.match(rejected.error.message, /process\.exit is forbidden inside the REPL kernel/)
  assert.deepEqual(await state.run('process-control-rejection', 'return 1'), { logs: [], value: 1 })
})

test('links required static exports before compiling the cell body', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ptc-plus-linking-'))
  const marker = join(project, 'evaluated.txt')
  await writeFile(join(project, 'effect.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(marker)}, 'evaluated')`,
    'export const present = 1',
  ].join('\n'))
  const state = fixture()
  t.after(async () => {
    await state.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const moduleSource = 'data:text/javascript,' + encodeURIComponent([
    'const quotedValue = 7',
    'export { quotedValue as "quoted-name" }',
    'export const present = undefined',
  ].join('\n'))
  const missingSource = `let bodyBinding = 1; import { missing } from ${JSON.stringify(moduleSource)}`
  const missing = await state.runDurable('static-linking', missingSource)
  assert.equal(missing.isError, true)
  assert.match(missing.error.message, /does not provide an export named.*missing/)
  assert.deepEqual(missing.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current',
    start: { line: 1, column: missingSource.indexOf(JSON.stringify(moduleSource)) + 1 },
  })
  assert.deepEqual(await state.run('static-linking', 'return typeof bodyBinding'), { logs: [], value: 'undefined' })

  const missingDefault = await state.runDurable(
    'static-linking', `import missingDefault from ${JSON.stringify(moduleSource)}`,
  )
  assert.equal(missingDefault.isError, true)
  assert.match(missingDefault.error.message, /does not provide an export named.*default/)

  const unlinked = await state.runDurable(
    'static-linking-effect', "import { missing } from './effect.mjs'", {},
    { session: { events: [], header: { cwd: project } } },
  )
  assert.equal(unlinked.isError, true)
  await assert.rejects(access(marker), error => error.code === 'ENOENT')

  const dynamicScope = await state.runDurable(
    'static-linking-effect',
    "import { present } from './effect.mjs'; with ({ present: 42 }) { return present }",
    {}, { session: { events: [], header: { cwd: project } } },
  )
  assert.equal(dynamicScope.isError, true)
  assert.match(dynamicScope.error.message, /with statement is not supported while imported bindings are active/)
  await assert.rejects(access(marker), error => error.code === 'ENOENT')

  const available = await state.run('static-linking', [
    `import { present, "quoted-name" as quoted } from ${JSON.stringify(moduleSource)}`,
    `import * as namespace from ${JSON.stringify(moduleSource)}`,
    `import ${JSON.stringify(moduleSource)}`,
    'return [Object.hasOwn(namespace, "present"), typeof present, quoted]',
  ].join('\n'))
  assert.deepEqual(available.value, [true, 'undefined', 7])
})

test('rejects unsupported destructuring writes to imported bindings before execution', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('import-write', "import { format } from 'node:util'")
  const rejected = await state.run('import-write', 'let touched = 0; ({ format } = (touched++, { format: 1 })); return touched')
  assert.equal(rejected.error.kind, 'exception')
  assert.match(rejected.error.message, /destructuring assignment to an imported binding is not supported/)
  assert.deepEqual(await state.run('import-write', 'return typeof touched'), { logs: [], value: 'undefined' })

  for (const [source, message] of [
    ['format = (format = 1)', /nested assignment/],
    ['format = format++', /nested assignment/],
    ['for (format of []) {}', /for-of assignment/],
    ['for (format in {}) {}', /for-in assignment/],
    ['delete format', /delete of an imported binding/],
    ['eval("format")', /direct eval is not supported/],
    ['with ({ format: 42 }) { return format }', /with statement is not supported/],
  ]) {
    const unsupported = await state.run('import-write', source)
    assert.equal(unsupported.error.kind, 'exception')
    assert.match(unsupported.error.message, message)
  }

  const throwingSource = 'format = (() => { throw new Error("rhs") })()'
  const throwing = await state.runDurable('import-write', throwingSource)
  assert.equal(throwing.isError, true)
  assert.deepEqual(throwing.meta.dshPtcPlus.diagnostics[0].source, {
    cell: 'current', start: { line: 1, column: throwingSource.indexOf('new Error') + 1 },
  })
})

test('inherits durability classification for rewritten imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const durable = await state.runDurable(
    'import-durable', "import { inspect } from 'node:util'\nreturn typeof inspect", {}, { session: { events: [] } },
  )
  assert.equal(durable.meta.dshPtcPlus.status, 'durable')
  const volatile = await state.runDurable(
    'import-durable', "import { basename } from 'node:path'\nreturn basename('/a/b')", {}, { session: { events: [] } },
  )
  assert.equal(volatile.meta.dshPtcPlus.status, 'volatile')
  assert.match(volatile.meta.dshPtcPlus.volatileReason, /module node:path/)
  assert.deepEqual(
    await state.run('import-durable', 'return basename("/x/y")'),
    { logs: [], value: 'y' },
  )
})

test('replays durable cells with their recorded rewrite policy after config changes', async (t) => {
  const session = { id: 'rewrite-policy-replay', events: [] }
  const writer = fixture()
  t.after(() => writer.dispose())
  const code = "import { inspect } from 'node:util'\nconst persistedInspectType = typeof inspect"
  const written = await writer.runDurable(session.id, code, {}, { session })
  assert.equal(written.error, undefined)
  assert.equal(written.meta.dshPtcPlus.status, 'durable')
  assert.equal(written.meta.dshPtcPlus.rewritePolicy.autoRewriteImports, true)
  appendRunCodeEvents(session.events, 'rewrite-policy-cell', code, written)
  await writer.dispose()

  const changed = fixture({ autoRewriteImports: false, autoStripExports: false, autoSplitRedeclarations: false })
  t.after(() => changed.dispose())
  const restored = await changed.run(session.id, 'return persistedInspectType', {}, { session })
  assert.deepEqual(restored, { logs: [], value: 'function' })
})

test('rebuilds imported aliases for later cells during cold replay', async (t) => {
  const session = { id: 'import-alias-replay', events: [] }
  const writer = fixture()
  const code = "import { inspect as render } from 'node:util'"
  const written = await writer.runDurable(session.id, code, {}, { session })
  assert.equal(written.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(session.events, 'import-alias-cell', code, written)
  await writer.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return render({ answer: 42 })', {}, { session }), {
    logs: [], value: '{ answer: 42 }',
  })
})

test('strips top-level export modifiers with provenance', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const code = [
    'export const exportedValue = 40',
    'export function exportedFn() { return 41 }',
    "export * from 'node:util'",
    "export { basename } from 'node:path'",
    'export type OnlyAType = { x: number }',
    'export { exportedValue as aliased }',
    'return [exportedValue, exportedFn(), __default]',
  ].join('\n')
  const withDefault = 'export default 42\n' + code
  const result = await state.runDurable('export-strip', withDefault, {}, { session: { events: [] } })
  assert.deepEqual(result.value, [40, 41, 42])
  assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  const rewrites = result.meta.dshPtcPlusRewrites
  assert.equal(rewrites.length, 7)
  assert.equal(rewrites[0].kind, 'export')
  assert.match(rewrites[0].description, /default export/)
  assert.match(rewrites[1].description, /stripped the export modifier/)
  assert.match(rewrites[2].description, /stripped the export modifier/)
  assert.equal(rewrites[3].kind, 'export')
  assert.equal(rewrites[3].source, 'node:util')
  assert.match(rewrites[3].description, /re-export/)
  assert.equal(rewrites[4].source, 'node:path')
  assert.equal(rewrites[5].kind, 'export')
  assert.match(rewrites[5].description, /type-only/)
  assert.equal(rewrites[6].kind, 'export')
  assert.match(rewrites[6].description, /removed a local re-export/)
})

test('keeps named default declarations reachable after export stripping', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const fn = await state.runDurable(
    'default-named', 'export default function helper() { return 40 }\nreturn [helper(), __default()]', {}, { session: { events: [] } },
  )
  assert.deepEqual(fn.value, [40, 40])
  const asyncFn = await state.runDurable(
    'default-named', 'export default async function runner() { return 41 }\nreturn [await runner(), await __default()]', {}, { session: { events: [] } },
  )
  assert.deepEqual(asyncFn.value, [41, 41])
  const klass = await state.runDurable(
    'default-named', 'export default class Box { constructor() { this.value = 42 } }\nreturn [new Box().value, new __default().value]', {}, { session: { events: [] } },
  )
  assert.deepEqual(klass.value, [42, 42])
  const direct = await state.runDurable(
    'default-direct', 'export default function __default() { return 43 }\nreturn __default()', {}, { session: { events: [] } },
  )
  assert.equal(direct.value, 43)
  const conflict = await state.runDurable(
    'default-conflict', 'const __default = 1; export default 2', {}, { session: { events: [] } },
  )
  assert.equal(conflict.isError, true)
  assert.match(conflict.error.message, /PTC-C001.*__default/s)
  assert.equal((await state.run('default-conflict', 'return typeof __default')).value, 'undefined')
})

test('updates directly named default declarations through one policy-independent live slot', async (t) => {
  const policies = [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]
  for (const [variableRedeclarations, functionClassRedeclarations] of policies) {
    const state = fixture({
      looseTopLevelRedeclarations: variableRedeclarations,
      looseTopLevelFunctionClassRedeclarations: functionClassRedeclarations,
    })
    t.after(() => state.dispose())
    const sessionId = `direct-default-policy-${variableRedeclarations}-${functionClassRedeclarations}`
    await state.run(
      sessionId,
      'export default function initialDefault() { return 1 }\nconst readDefault = () => __default',
    )

    const functionSource = 'export default function __default(value) { return value > 1 ? value * __default(value - 1) : 1 }'
    const replacedFunction = await state.runDurable(
      sessionId,
      `${functionSource}\nreturn [__default(4), readDefault() === __default]`,
    )
    assert.deepEqual(replacedFunction.value, [24, true])
    assert.equal(
      replacedFunction.meta.dshPtcPlusBindings.memory.entries
        .find(entry => entry.name === '__default').definition.source,
      functionSource,
    )

    const classSource = 'export default class __default { static self() { return __default } }'
    const replacedClass = await state.runDurable(
      sessionId,
      `${classSource}\nreturn [__default.self() === __default, readDefault() === __default]`,
    )
    assert.deepEqual(replacedClass.value, [true, true])
    const alias = replacedClass.meta.dshPtcPlusBindings.memory.entries
      .find(entry => entry.name === '__default')
    assert.equal(alias.kind, 'class')
    assert.equal(alias.definition.source, classSource)
  }
})

test('cold-replays directly named default updates and their older live readers', async (t) => {
  const events = []
  const session = { id: 'direct-default-replay', events }
  const writer = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: false,
  })
  const setupSource = 'export default function initialDefault() { return 1 }\nconst readDefault = () => __default'
  const setup = await writer.runDurable(session.id, setupSource, {}, { session })
  appendRunCodeEvents(events, 'direct-default-setup', setupSource, setup)
  const replacementSource = 'export default function __default(value) { return value > 1 ? value * __default(value - 1) : 1 }'
  const replacement = await writer.runDurable(session.id, replacementSource, {}, { session })
  appendRunCodeEvents(events, 'direct-default-replacement', replacementSource, replacement)
  await writer.dispose()

  const reader = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: false,
  })
  t.after(() => reader.dispose())
  const recovered = await reader.runDurable(
    session.id,
    'return [__default(5), readDefault() === __default]',
    {},
    { session },
  )
  assert.deepEqual(recovered.value, [120, true])
  assert.equal(
    recovered.meta.dshPtcPlusBindings.memory.entries
      .find(entry => entry.name === '__default').definition.source,
    replacementSource,
  )
})

test('does not publish directly named default classes before their slot commits', async (t) => {
  const failedState = fixture()
  t.after(() => failedState.dispose())
  await failedState.run(
    'direct-default-class-failure',
    "function fail() { throw new Error('direct default class failed') }",
  )
  for (const source of [
    'export default class __default extends fail() {}',
    'export default class __default { static value = fail() }',
  ]) {
    const failed = await failedState.runDurable('direct-default-class-failure', source)
    assert.equal(failed.isError, true)
    assert.match(failed.error.message, /direct default class failed/)
    assert.equal(
      failed.meta.dshPtcPlusBindings.memory.entries.some(entry => entry.name === '__default'),
      false,
    )
  }
  assert.equal((await failedState.run('direct-default-class-failure', 'return typeof __default')).value, 'undefined')

  const events = []
  const session = { id: 'direct-default-early-replay', events }
  const writer = fixture()
  const earlySource = "return 'early'\nexport default class __default { static value = 1 }"
  const early = await writer.runDurable(session.id, earlySource, {}, { session })
  assert.equal(early.value, 'early')
  assert.equal(
    early.meta.dshPtcPlusBindings.memory.entries.some(entry => entry.name === '__default'),
    false,
  )
  appendRunCodeEvents(events, 'direct-default-early', earlySource, early)
  await writer.dispose()

  const reader = fixture()
  t.after(() => reader.dispose())
  const recovered = await reader.runDurable(session.id, 'return typeof __default', {}, { session })
  assert.equal(recovered.value, 'undefined')
  assert.equal(
    recovered.meta.dshPtcPlusBindings.memory.entries.some(entry => entry.name === '__default'),
    false,
  )
})

test('refreshes named default aliases and inventory only after their declarations commit', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => state.dispose())

  await state.run('default-function-replacement', 'export default function helper() { return 1 }')
  const functionDeclaration = 'export default function helper() { return 2 }'
  const sync = await state.runDurable(
    'default-function-replacement',
    `${functionDeclaration}\nreturn [helper(), __default()]`,
  )
  assert.deepEqual(sync.value, [2, 2])
  const functionAlias = sync.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === '__default')
  assert.equal(functionAlias.kind, 'function')
  assert.equal(functionAlias.definition.source, functionDeclaration)

  await state.run('default-async-function-replacement', 'export default async function load() { return 3 }')
  const asynchronous = await state.run(
    'default-async-function-replacement',
    'export default async function load() { return 4 }\nreturn [await load(), await __default()]',
  )
  assert.deepEqual(asynchronous.value, [4, 4])

  await state.run('default-class-replacement', 'export default class Box { static value = 1 }')
  const classDeclaration = 'export default class Box { static value = 2 }'
  const replacedClass = await state.runDurable(
    'default-class-replacement',
    `${classDeclaration}\nreturn [Box.value, __default.value]`,
  )
  assert.deepEqual(replacedClass.value, [2, 2])
  const classAlias = replacedClass.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === '__default')
  assert.equal(classAlias.kind, 'class')
  assert.equal(classAlias.definition.source, classDeclaration)

  const originalFailedClass = 'export default class FailedBox { static value = 1 }'
  await state.run(
    'default-class-failure',
    `function fail() { throw new Error('class setup failed') }\n${originalFailedClass}`,
  )
  const failedClass = await state.runDurable(
    'default-class-failure',
    'export default class FailedBox extends fail() { static value = 2 }',
  )
  assert.equal(failedClass.isError, true)
  assert.match(failedClass.error.message, /class setup failed/)
  const failedAlias = failedClass.meta.dshPtcPlusBindings.memory.entries
    .find(entry => entry.name === '__default')
  assert.equal(failedAlias.kind, 'class')
  assert.equal(failedAlias.definition.source, originalFailedClass)
  assert.deepEqual(
    (await state.run('default-class-failure', 'return [FailedBox.value, __default.value]')).value,
    [1, 1],
  )
})

test('keeps named default replacement independent from variable replacement', async (t) => {
  const state = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: true,
  })
  t.after(() => state.dispose())

  await state.run('strict-default-function', 'export default function helper() { return 1 }')
  const replacedFunction = await state.runDurable(
    'strict-default-function',
    'export default function helper() { return 2 }\nreturn [helper(), __default()]',
  )
  assert.deepEqual(replacedFunction.value, [2, 2])

  const readonly = await state.run('strict-default-function', '__default = () => 3')
  assert.equal(readonly.error.kind, 'exception')
  assert.match(readonly.error.message, /constant variable|read only|readonly/i)
  assert.deepEqual((await state.run('strict-default-function', 'return [helper(), __default()]')).value, [2, 2])

  await state.run('strict-default-class', 'export default class Box { static value = 1 }')
  const replacedClass = await state.runDurable(
    'strict-default-class',
    'export default class Box { static value = 2 }\nreturn [Box.value, __default.value]',
  )
  assert.deepEqual(replacedClass.value, [2, 2])
  assert.equal(
    replacedClass.meta.dshPtcPlusBindings.memory.entries
      .find(entry => entry.name === '__default').definition.source,
    'export default class Box { static value = 2 }',
  )
})

test('commits fresh named default aliases at their execution position across replay', async (t) => {
  const events = []
  const session = { id: 'fresh-default-commit-replay', events }
  const writer = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  const original = 'export default function OriginalDefault() { return 1 }'
  const first = await writer.runDurable(session.id, original, {}, { session })
  appendRunCodeEvents(events, 'fresh-default-first', original, first)

  const fresh = 'export default function FreshDefault() { return 2 }'
  const earlySource = `return 'early'\n${fresh}`
  const early = await writer.runDurable(session.id, earlySource, {}, { session })
  appendRunCodeEvents(events, 'fresh-default-early', earlySource, early)
  assert.equal(early.value, 'early')
  const earlyEntries = early.meta.dshPtcPlusBindings.memory.entries
  assert.equal(earlyEntries.find(entry => entry.name === '__default').definition.source, original)
  assert.equal(earlyEntries.find(entry => entry.name === 'FreshDefault').definition.source,
    'function FreshDefault() { return 2 }')
  await writer.dispose()

  const reader = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => reader.dispose())
  const recovered = await reader.runDurable(
    session.id,
    'return [FreshDefault(), __default()]',
    {},
    { session },
  )
  assert.deepEqual(recovered.value, [2, 1])
  assert.equal(
    recovered.meta.dshPtcPlusBindings.memory.entries
      .find(entry => entry.name === '__default').definition.source,
    original,
  )

  const failedState = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => failedState.dispose())
  const originalClass = 'export default class OriginalClass { static value = 1 }'
  await failedState.run(
    'fresh-default-class-failure',
    `function fail() { throw new Error('fresh class failed') }\n${originalClass}`,
  )
  const failed = await failedState.runDurable(
    'fresh-default-class-failure',
    'export default class FreshClass extends fail() { static value = 2 }',
  )
  assert.equal(failed.isError, true)
  assert.match(failed.error.message, /fresh class failed/)
  const failedEntries = failed.meta.dshPtcPlusBindings.memory.entries
  assert.equal(failedEntries.some(entry => entry.name === 'FreshClass'), false)
  assert.equal(failedEntries.find(entry => entry.name === '__default').definition.source, originalClass)
  assert.equal((await failedState.run('fresh-default-class-failure', 'return __default.value')).value, 1)
})
