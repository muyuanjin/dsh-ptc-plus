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
    'help: reuse the existing bindings',
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
    help: ['reuse the existing bindings', 'place one-off declarations inside a block'],
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
    /help: replace repeated function declarations with top-level const\/let function expressions/,
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
    /help: replace repeated class declarations with top-level const\/let class expressions/,
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
  assert.match(strictCollision.error.message, /help: reuse the existing bindings/)
  assert.doesNotMatch(strictCollision.error.message, /top-level const\/let function expressions/)

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
  assert.equal(looseSecond.meta.dshPtcPlus.bindingMode, 'loose')
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
  const strictCode = 'const strictHistoryBinding = 3'
  const strictResult = await strictWriter.runDurable(strictSession.id, strictCode, {}, { session: strictSession })
  appendRunCodeEvents(strictEvents, 'strict-mode-cell', strictCode, strictResult)
  assert.equal(strictResult.meta.dshPtcPlus.bindingMode, 'strict')
  await strictWriter.dispose()

  const looseReader = fixture()
  t.after(() => looseReader.dispose())
  assert.deepEqual(await looseReader.run(strictSession.id, 'return strictHistoryBinding', {}, { session: strictSession }), {
    logs: [],
    value: 3,
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
