import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { prepareProgram } from '../internal/cell-analysis.js'
import { LEGACY_LANGUAGE_SEMANTICS, STATEFUL_LANGUAGE_SEMANTICS } from '../internal/language-semantics.js'
import { PREVIOUS_USER_BINDING_TRANSFORM, moduleTransformForLanguage } from '../internal/module-transform-contract.js'
import { JOURNAL_KEY, normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { USER_BINDINGS_META_KEY, createUserBindingsSnapshot } from '../internal/user-bindings.js'
import { decodeValue, encodeValue } from '../internal/value-wire.js'
import { WorkerClient } from '../internal/worker-client.js'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'
import {
  activeTimers,
  interceptWorkerMessages,
  interceptWorkerPosts,
  isCellActive,
  workerOf,
} from './runtime-observation.js'

/** One enabled namespace entry whose module value is the snapshot revision. */
function sharedNamespaceSnapshot(value) {
  return createUserBindingsSnapshot({ entries: [{
    id: 'shared', name: 'shared', scope: 'namespace',
    source: `export const value = ${value}`, enabled: true,
  }] }, value)
}

/**
 * Run one cell with user bindings and append its durable record to the session,
 * so the same session can later replay the record and continue live.
 */
async function recordUserBindingCell(runtime, session, program, userBindings, functions = {}) {
  const callSeq = Math.max(-1, ...session.events.map(event => event.seq)) + 1
  const execution = await runtime.runTentative(
    { id: session.id, session, persistedCallSeq: callSeq },
    { program, userBindings, bindings: [{ global: 'tools', functions }] },
  )
  const { settlement } = execution
  const journal = normalizeJournal(settlement.journal)
  runtime.finalize(settlement, true)
  const recorded = []
  appendRunCodeEvents(recorded, `user-binding-${callSeq}`, program, { meta: {
    [JOURNAL_KEY]: journal,
    ...(settlement.userBindings === undefined ? {} : { [USER_BINDINGS_META_KEY]: settlement.userBindings }),
  } })
  for (const [index, event] of recorded.entries()) event.seq = callSeq + index
  recorded[1].sourceEventSeqs = [callSeq]
  session.events.push(...recorded)
  return { result: execution.result, journal, recoveryBoundaries: settlement.recoveryBoundaries,
    replMemory: settlement.replMemory }
}

test('enabling replay preserves the initialized live worker and its volatile source evidence', async t => {
  const session = { id: 'enable-replay-live', events: [] }
  const runtime = new SessionRuntime({ legacyBindingSettings: true, durableReplay: false })
  t.after(() => runtime.dispose())
  let effects = 0
  const functions = { observe: async () => ++effects }
  const initial = await recordUserBindingCell(runtime, session,
    'const value=41;function read(){return eval("value")};await tools.observe({});return read()', undefined, functions)
  assert.equal(initial.result.error, undefined)
  assert.equal(initial.result.value, 41)
  assert.equal(initial.journal.status, 'volatile')
  const kernel = runtime.kernels.get(session.id)
  const worker = kernel.client.worker
  const namespaces = [...kernel.bindingCatalog.inputs().importNamespaces]
  assert.ok(namespaces.length > 0)

  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: true })
  const current = await recordUserBindingCell(runtime, session, 'return [value,read()]', undefined, functions)
  assert.equal(current.result.error, undefined)
  assert.deepEqual(current.result.value, [41, 41])
  assert.equal(current.journal.status, 'volatile')
  assert.equal(kernel.client.worker, worker)
  for (const name of namespaces) assert.ok(kernel.bindingCatalog.inputs().importNamespaces.has(name))
  runtime.reconfigure({ legacyBindingSettings: true, durableReplay: true })
  const later = await recordUserBindingCell(runtime, session, 'return read()', undefined, functions)
  assert.equal(later.result.error, undefined)
  assert.equal(later.result.value, 41)
  assert.equal(effects, 1)

  await runtime.dispose()
  const cold = new SessionRuntime()
  t.after(() => cold.dispose())
  const recovered = await recordUserBindingCell(cold, session, 'return typeof value', undefined, functions)
  assert.equal(recovered.result.error, undefined)
  assert.equal(recovered.result.value, 'undefined')
  assert.equal(effects, 1)
})

test('success and body failure drain every issued call in settlement order and replay no effects', async t => {
  for (const fails of [false, true]) {
    await t.test(fails ? 'body throws' : 'body returns', async t => {
      const session = { id: `settlement-${fails}`, events: [] }
      const writer = fixture()
      t.after(() => writer.dispose())
      const started = Promise.withResolvers()
      const gates = [Promise.withResolvers(), Promise.withResolvers()]
      const secondFinished = Promise.withResolvers()
      let calls = 0
      let completed = false
      const source = `
let settledLabels = []
void tools.slow({ index: 0 }).then(value => settledLabels.push(value))
void tools.slow({ index: 1 }).catch(error => settledLabels.push(error.message))
${fails ? 'throw new Error("body failed")' : 'return 7'}
`
      const pending = writer.runDurable(session.id, source, {
        slow: async ({ index }) => {
          if (++calls === 2) started.resolve()
          await gates[index].promise
          if (index === 1) {
            secondFinished.resolve()
            throw new Error('second rejected')
          }
          return 'first completed'
        },
      }, { session }).then(result => { completed = true; return result })
      await started.promise
      gates[1].resolve()
      await secondFinished.promise
      await nextTurn()
      assert.equal(completed, false)
      gates[0].resolve()
      const written = await pending
      assert.equal(written.isError, fails)
      if (fails) assert.match(written.error.message, /body failed/)
      else assert.equal(written.value, 7)
      const journal = normalizeJournal(written.meta.dshPtcPlus)
      assert.equal(journal.status, 'durable')
      assert.deepEqual(journal.calls.map(call => [call.ok, call.settle]), [[true, 1], [false, 0]])
      assert.equal(decodeValue(journal.calls[0].value), 'first completed')
      assert.equal(journal.calls[1].error, 'second rejected')
      appendRunCodeEvents(session.events, 'settled-calls', source, written)
      assert.deepEqual((await writer.run(session.id, 'return settledLabels', {}, { session })).value,
        ['second rejected', 'first completed'])
      await writer.dispose()

      const restored = fixture()
      t.after(() => restored.dispose())
      const result = await restored.run(session.id, 'return settledLabels', {
        slow: async () => { calls += 1; return 'unexpected replay dispatch' },
      }, { session })
      assert.equal(result.error, undefined)
      assert.deepEqual(result.value, ['second rejected', 'first completed'])
      assert.equal(calls, 2)
    })
  }
})

test('closing a failed cell prevents settled callbacks from issuing another host call', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  let extraCalls = 0
  const execution = runtime.runTentative('closed-cell', {
    program: `
let lateMessage
void tools.first({}).then(async () => {
  try { await tools.second({}) } catch (error) { lateMessage = error.message }
})
throw new Error('body failed')
`,
    bindings: [{ global: 'tools', functions: {
      first: async () => { started.resolve(); await gate.promise; return 1 },
      second: async () => { extraCalls += 1; return 2 },
    } }],
  })
  await started.promise
  gate.resolve()
  const settled = await execution
  runtime.finalize(settled.settlement, true)
  assert.match(settled.result.error.message, /body failed/)
  assert.equal(normalizeJournal(settled.settlement.journal).calls.length, 1)
  assert.equal(extraCalls, 0)
  assert.equal((await runtime.run('closed-cell', {
    program: 'return lateMessage', bindings: [],
  })).value, 'PTC execution lease expired')
})

test('a prior cell continuation cannot borrow the next cell native namespace', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const seeded = await runtime.run('continuation-owner', {
    program: `
let releaseContinuation
let continuationResult
const continuationGate = new Promise(resolve => { releaseContinuation = resolve })
const continuation = continuationGate.then(async () => {
  try { continuationResult = await tools.secret({}) }
  catch (error) { continuationResult = error.message }
})
return undefined
`, bindings: [],
  })
  assert.equal(seeded.error, undefined)
  let calls = 0
  const resumed = await runtime.run('continuation-owner', {
    program: 'releaseContinuation(); await continuation; return continuationResult',
    bindings: [{ global: 'tools', functions: { secret: async () => { calls += 1; return 9 } } }],
  })
  assert.equal(resumed.error, undefined)
  assert.equal(resumed.value, 'PTC execution lease expired')
  assert.equal(calls, 0)
})

test('draining a failed cell keeps the original wall budget and cancellation boundary', async t => {
  for (const cancel of [false, true]) {
    await t.test(cancel ? 'cancel pending call' : 'wall budget expires', async t => {
      const runtime = new SessionRuntime({ computeMs: 2_000, maxWallMs: 2_000 })
      t.after(() => runtime.dispose())
      const id = `drain-boundary-${cancel}`
      await runtime.run(id, { program: 'let retained = 4', bindings: [] })
      runtime.reconfigure({ computeMs: 2_000, maxWallMs: cancel ? 2_000 : 150 })
      const oldWorker = workerOf(runtime, id)
      const started = Promise.withResolvers()
      const gate = Promise.withResolvers()
      const controller = new AbortController()
      const pending = runtime.runTentative(id, {
        program: 'void tools.wait({}); throw new Error("body failed")',
        signal: controller.signal,
        bindings: [{ global: 'tools', functions: { wait: async () => {
          started.resolve()
          await gate.promise
          return 'old reply'
        } } }],
      })
      await started.promise
      const wallTimer = activeTimers(runtime, id).wall
      await nextTurn()
      assert.equal(activeTimers(runtime, id).wall, wallTimer)
      if (cancel) controller.abort('cancel pending call')
      const settled = await pending
      runtime.finalize(settled.settlement, true)
      assert.equal(settled.result.error.kind, cancel ? 'abort' : 'timeout')
      assert.match(settled.result.error.message, cancel ? /cancel pending call/ : /wall-clock ceiling/)
      const journal = normalizeJournal(settled.settlement.journal)
      assert.equal(journal.status, 'discarded')
      assert.equal(journal.volatileReason, 'tools.wait')
      assert.deepEqual(journal.calls, [])

      runtime.reconfigure({ computeMs: 2_000, maxWallMs: 2_000 })
      const nextStarted = Promise.withResolvers()
      const nextGate = Promise.withResolvers()
      const continued = runtime.run(id, {
        program: 'await tools.wait({}); return retained',
        bindings: [{ global: 'tools', functions: { wait: async () => {
          nextStarted.resolve()
          await nextGate.promise
          return 'new reply'
        } } }],
      })
      await nextStarted.promise
      assert.notEqual(workerOf(runtime, id), oldWorker)
      gate.resolve()
      await nextTurn()
      assert.equal(isCellActive(runtime, id), true)
      nextGate.resolve()
      assert.equal((await continued).value, 4)
    })
  }
})

test('a callback blocking during failed-cell drain remains subject to the compute budget', async t => {
  const runtime = new SessionRuntime({ computeMs: 2_000, maxWallMs: 2_000 })
  t.after(() => runtime.dispose())
  await runtime.run('drain-compute', { program: 'let retained = 4', bindings: [] })
  runtime.reconfigure({ computeMs: 80, maxWallMs: 2_000 })
  const started = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const pending = runtime.runTentative('drain-compute', {
    program: 'void tools.wait({}).then(() => { while (true) {} }); throw new Error("body failed")',
    bindings: [{ global: 'tools', functions: { wait: async () => {
      started.resolve()
      await gate.promise
      return null
    } } }],
  })
  await started.promise
  gate.resolve()
  const settled = await pending
  runtime.finalize(settled.settlement, true)
  assert.equal(settled.result.error.kind, 'timeout')
  assert.match(settled.result.error.message, /compute budget exhausted/)
  assert.equal(normalizeJournal(settled.settlement.journal).status, 'discarded')
})

test('malformed and over-budget replies reject their call without killing the worker', async t => {
  for (const value of [{ codec: 'invalid', root: null, nodes: [] }, encodeValue([{}, {}])]) {
    const runtime = new SessionRuntime({ maxValueNodes: 2 })
    t.after(() => runtime.dispose())
    await runtime.run('decode-reply', { program: 'let retained = 4', bindings: [] })
    const worker = workerOf(runtime, 'decode-reply')
    const link = interceptWorkerPosts(runtime, 'decode-reply', message => (
      message.type === 'reply' && message.ok ? { ...message, value } : message
    ))
    const rejected = await runtime.runTentative('decode-reply', {
      program: 'await tools.read({})',
      bindings: [{ global: 'tools', functions: { read: async () => null } }],
    })
    runtime.finalize(rejected.settlement, true)
    assert.equal(rejected.result.error.kind, 'exception')
    assert.match(rejected.result.error.message, /PTC value/)
    assert.equal(normalizeJournal(rejected.settlement.journal).calls[0].ok, true)
    link.restore()
    assert.equal((await runtime.run('decode-reply', { program: 'return retained + 1', bindings: [] })).value, 5)
    assert.equal(workerOf(runtime, 'decode-reply'), worker)
  }
})

test('a pending reply retains its submitted value budget across configuration changes', async t => {
  const runtime = new SessionRuntime({ maxValueNodes: 3 })
  t.after(() => runtime.dispose())
  const started = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const pending = runtime.run('reply-budget', {
    program: 'const received = await tools.read({}); return received[0].value',
    bindings: [{ global: 'tools', functions: { read: async () => {
      started.resolve()
      await gate.promise
      return [{ value: 7 }]
    } } }],
  })
  await started.promise
  runtime.reconfigure({ maxValueNodes: 1 })
  gate.resolve()
  assert.equal((await pending).value, 7)
  const worker = workerOf(runtime, 'reply-budget')
  const rejected = await runtime.run('reply-budget', {
    program: 'return await tools.read({})',
    bindings: [{ global: 'tools', functions: { read: async () => [{ value: 8 }] } }],
  })
  assert.equal(rejected.error.kind, 'exception')
  assert.match(rejected.error.message, /node budget exceeds 1/)
  assert.equal(workerOf(runtime, 'reply-budget'), worker)
})

test('over-budget recorded replies contract recovery and still execute the current cell', async t => {
  const writer = fixture()
  t.after(() => writer.dispose())
  const session = { id: 'recorded-reply-budget', events: [] }
  let calls = 0
  const source = 'const saved = await tools.read({}); return undefined'
  const written = await writer.runDurable(session.id, source, {
    read: async () => { calls += 1; return [{ value: 7 }] },
  }, { session })
  assert.equal(written.isError, false)
  appendRunCodeEvents(session.events, 'recorded-large-reply', source, written)
  await writer.dispose()
  const restored = fixture({ maxValueNodes: 1 })
  t.after(() => restored.dispose())
  const recovered = await restored.runDurable(session.id, 'return 42', {
    read: async () => { calls += 1; return null },
  }, { session })
  assert.equal(recovered.isError, false)
  assert.equal(recovered.value, 42)
  assert.equal(calls, 1)
  assert.equal(recovered.meta.dshPtcPlusRecoveryBoundaries.length, 1)
  assert.equal(normalizeJournal(recovered.meta.dshPtcPlus).status, 'durable')
})

test('every completion reports its language generation committed declarations, activation and source facts', async t => {
  for (const languageSemantics of [LEGACY_LANGUAGE_SEMANTICS, STATEFUL_LANGUAGE_SEMANTICS]) {
    for (const [phase, end, kind] of [
      ['return', 'return previous()', undefined],
      ['throw', 'throw new Error("body failed")', 'exception'],
      ['encode', 'return () => previous', 'invalid-output'],
    ]) {
      await t.test(`${languageSemantics}, ${phase}`, async t => {
        const legacy = languageSemantics === LEGACY_LANGUAGE_SEMANTICS
        const runtime = new SessionRuntime({ legacyBindingSettings: legacy, computeMs: 2_000, maxWallMs: 2_000 })
        t.after(() => runtime.dispose())
        const userBindings = createUserBindingsSnapshot({ entries: [
          { id: 'ns', name: 'shared', scope: 'namespace', source: 'export const value = 1', enabled: true },
          { id: 'top', name: 'top', scope: 'top-level', source: 'export const item = 1', enabled: true },
          { id: 'failed', name: 'failed', scope: 'namespace', source: 'throw new Error("initializer"); export const value = 1', enabled: true },
        ] }, 1)
        await runtime.run(phase, { program: 'function previous() { return 1 }', bindings: [], userBindings })
        const done = []
        interceptWorkerMessages(runtime, phase, (message, deliver) => {
          if (message.type === 'done') done.push(message)
          deliver(message)
        })
        const settled = await runtime.runTentative(phase, {
          program: `function previous() { return 2 }; shared = 17; item = 19; console.log('body'); ${end}`,
          bindings: [], userBindings,
        })
        runtime.finalize(settled.settlement, true)
        assert.equal(settled.result.error?.kind, kind)
        assert.equal(done.length, 1)
        assert.equal(done[0].committedRedeclarations.length, 1)
        assert.match(done[0].committedRedeclarations[0], legacy ? /^redeclaration:\d+:previous$/ : /^root:\d+:previous$/)
        if (legacy) assert.equal('rootBindingFacts' in done[0], false)
        else {
          assert.deepEqual(new Map(done[0].rootBindingFacts.map(({ name, source }) => [name, source])),
            new Map([['item', 'local'], ['previous', 'local'], ['shared', 'local']]))
          for (const [name, source] of [['shared', 'shared = 17'], ['item', 'item = 19']]) {
            assert.equal(typeof done[0].rootBindingFacts.find(fact => fact.name === name).write, 'string')
            assert.equal(settled.settlement.replMemory.entries.find(entry => entry.name === name).definition.source, source)
          }
        }
        // Activation and failure outcomes partition every requested entry.
        assert.deepEqual(done[0].activatedUserBindings, ['ns', 'top'])
        assert.deepEqual(done[0].userBindingFailures, [{ id: 'failed', error: 'initializer' }])
        // Each completion carries per-name source facts and no whole-entry field.
        assert.deepEqual(done[0].userBindingNames, [
          { name: 'item', state: 'local' },
          { name: 'shared', state: 'local' },
        ])
        assert.equal('shadowedUserBindings' in done[0], false)
        assert.equal(done[0].logs.at(-1), 'body')
        assert.equal(done[0].durability, 'durable')
        assert.equal(normalizeJournal(settled.settlement.journal).status, 'durable')
        assert.equal(normalizeJournal(settled.settlement.journal).languageSemantics, languageSemantics)
        assert.deepEqual((await runtime.run(phase, {
          program: 'return [previous(), shared, item]', bindings: [], userBindings,
        })).value, [2, 17, 19])
      })
    }
  }
})

test('stateful settlement records drained callback writes and their original source through provider updates and replay', async t => {
  for (const [phase, end, kind] of [
    ['return', 'return 7', undefined],
    ['void', 'void 0', undefined],
    ['throw', 'throw new Error("body failed")', 'exception'],
    ['encode', 'return () => 1', 'invalid-output'],
  ]) await t.test(phase, async t => {
    const runtime = new SessionRuntime({ bindingUpdates: 'stateful' })
    t.after(() => runtime.dispose())
    const session = { id: `stateful-drained-write-${phase}`, events: [] }
    const initializations = []
    let calls = 0
    const started = Promise.withResolvers()
    const gate = Promise.withResolvers()
    const functions = {
      observe: async ({ value }) => { initializations.push(value); return 'initialized' },
      wait: async () => { calls += 1; started.resolve(); await gate.promise; return null },
    }
    const initial = assignmentSnapshot('namespace', 1)
    const seeded = await recordUserBindingCell(runtime, session,
      'let committed = 0; function assign() { shared = shared; committed = 2 }', initial, functions)
    assert.equal(seeded.result.error, undefined)
    assert.deepEqual(seeded.journal.userBindingNames, [{ name: 'shared', state: 'provider', entryId: 'shared' }])
    const done = []
    interceptWorkerMessages(runtime, session.id, (message, deliver) => {
      if (message.type === 'done') done.push(message)
      deliver(message)
    })
    let completed = false
    const pending = recordUserBindingCell(runtime, session,
      `void tools.wait({}).then(assign); if (false) shared = 99; ${end}`, initial, functions)
      .then(result => { completed = true; return result })
    await started.promise
    await nextTurn()
    assert.equal(completed, false)
    gate.resolve()
    const settled = await pending
    assert.equal(settled.result.error?.kind, kind)
    if (phase === 'return') assert.equal(settled.result.value, 7)
    if (phase === 'void') assert.equal(settled.result.value, undefined)
    assert.equal(done.length, 1)
    assert.deepEqual(done[0].committedRedeclarations, [])
    for (const [name, source] of [['shared', 'shared = shared'], ['committed', 'committed = 2']]) {
      const fact = done[0].rootBindingFacts.find(fact => fact.name === name)
      assert.equal(fact.source, 'local')
      assert.equal(typeof fact.write, 'string')
      assert.equal(settled.replMemory.entries.find(entry => entry.name === name).definition.source, source)
    }
    assert.deepEqual(settled.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
    assert.equal(settled.journal.languageSemantics, STATEFUL_LANGUAGE_SEMANTICS)
    assert.equal(settled.journal.status, 'durable')
    assert.deepEqual(settled.journal.calls.map(call => [call.member, call.settle]), [['wait', 0]])
    const updated = assignmentSnapshot('namespace', 2)
    const program = 'return [shared.value, committed]'
    const continued = await recordUserBindingCell(runtime, session, program, updated, functions)
    assert.equal(continued.result.error, undefined)
    assert.deepEqual(continued.result.value, [1, 2])
    assert.deepEqual(continued.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
    assert.deepEqual(initializations, [1, 2])
    await runtime.dispose()
    const restored = new SessionRuntime({ bindingUpdates: 'stateful' })
    t.after(() => restored.dispose())
    const cold = await recordUserBindingCell(restored, session, program, updated, functions)
    assert.equal(cold.result.error, undefined)
    assert.deepEqual(cold.result.value, [1, 2])
    assert.equal(cold.recoveryBoundaries, undefined)
    assert.deepEqual(cold.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
    assert.deepEqual(initializations, [1, 2])
    assert.equal(calls, 1)
  })
})

test('a pending rejection keeps the error class installed when the call started', async t => {
  for (const shadow of ['replace', 'delete']) {
    await t.test(shadow, async t => {
      const runtime = new SessionRuntime({ computeMs: 2_000, maxWallMs: 2_000 })
      t.after(() => runtime.dispose())
      const id = `reply-error-class-${shadow}`
      await runtime.run(id, { program: 'let captured', bindings: [] })
      const worker = workerOf(runtime, id)
      const shadowStatement = shadow === 'replace'
        ? 'Object.defineProperty(globalThis, "ToolCallError", { configurable: true, value: replacement })'
        : 'delete globalThis.ToolCallError'
      const errorClass = { name: 'ToolCallError', memberNameProperty: 'toolName' }
      const started = Promise.withResolvers()
      const gate = Promise.withResolvers()
      const pending = runtime.run(id, {
        program: `
const original = ToolCallError
const replacement = ${shadow === 'replace' ? 'class Replaced extends Error {}' : 'undefined'}
void tools.read({}).then(
  () => { captured = 'unexpected resolution' },
  error => { captured = {
    name: error.name,
    toolName: error.toolName,
    message: error.message,
    original: error instanceof original,
    replacement: replacement !== undefined && error instanceof replacement,
  } },
)
${shadowStatement}
return 'cell finished'
`,
        bindings: [{ global: 'tools', functions: { read: async () => {
          started.resolve()
          await gate.promise
          throw new Error('denied')
        } }, errorClass }],
      })
      await started.promise
      gate.resolve()
      const settled = await pending
      assert.equal(settled.error, undefined)
      assert.equal(settled.value, 'cell finished')
      assert.deepEqual((await runtime.run(id, { program: 'return captured', bindings: [] })).value, {
        name: 'ToolCallError',
        toolName: 'read',
        message: 'denied',
        original: true,
        replacement: false,
      })
      const propagated = await runtime.run(id, {
        program: `
const replacement = ${shadow === 'replace' ? 'class Replaced extends Error {}' : 'undefined'}
const call = tools.read({})
${shadowStatement}
await call
return 'unreachable'
`,
        bindings: [{ global: 'tools', functions: { read: async () => { throw new Error('denied') } }, errorClass }],
      })
      assert.match(propagated.error.message, /uncaught ToolCallError: denied/)
      assert.equal(workerOf(runtime, id), worker)
    })
  }
})

// `this` is the cell's global object. Unlike the ambient `globalThis` name it
// does not mark the cell volatile, so the same program can also be recorded.
function restoreInstalledDescriptor(write, completion = 'return shared.value') {
  return `const installed = Object.getOwnPropertyDescriptor(this, 'shared')
${write}
Object.defineProperty(this, 'shared', installed)
${completion}`
}

test('a legacy actual assignment stays local when the installed descriptor is restored', async t => {
  for (const [label, write] of [
    ['value write', 'shared = 17'],
    ['same-value write', 'shared = shared'],
  ]) {
    for (const completion of ['return shared.value', 'void 0']) await t.test(`${label}, ${completion}`, async t => {
      const runtime = new SessionRuntime({ legacyBindingSettings: true })
      t.after(() => runtime.dispose())
      const session = { id: `restored-descriptor-${label.replaceAll(' ', '-')}`, events: [] }
      const initializations = []
      const functions = { observe: async ({ value }) => { initializations.push(value); return 'initialized' } }
      const assigned = await recordUserBindingCell(runtime, session,
        restoreInstalledDescriptor(write, completion), assignmentSnapshot('namespace', 1), functions)
      assert.equal(assigned.result.error, undefined)
      assert.equal(assigned.result.value, completion === 'void 0' ? undefined : 1)
      assert.deepEqual(assigned.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
      // The recorded assignment survives a provider source update: the restored
      // accessor still reads its own module instance instead of the new one.
      const updated = await recordUserBindingCell(runtime, session,
        'return shared.value', assignmentSnapshot('namespace', 2), functions)
      assert.equal(updated.result.error, undefined)
      assert.equal(updated.result.value, 1)
      assert.deepEqual(updated.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
      assert.deepEqual(initializations, [1, 2])
      await runtime.dispose()
      const restored = new SessionRuntime({ legacyBindingSettings: true })
      t.after(() => restored.dispose())
      const cold = await recordUserBindingCell(restored, session,
        'return shared.value', assignmentSnapshot('namespace', 2), functions)
      assert.equal(cold.result.error, undefined)
      assert.equal(cold.result.value, 1)
      assert.equal(cold.recoveryBoundaries, undefined)
      assert.deepEqual(cold.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
      assert.deepEqual(initializations, [1, 2])
    })
  }
})

test('restoring the legacy installed descriptor without an assignment keeps provider ownership', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true })
  t.after(() => runtime.dispose())
  const session = { id: 'restored-descriptor-unwritten', events: [] }
  const restored = await recordUserBindingCell(runtime, session,
    restoreInstalledDescriptor(''), sharedNamespaceSnapshot(1))
  assert.equal(restored.result.value, 1)
  assert.deepEqual(restored.journal.userBindingNames, [
    { name: 'shared', state: 'provider', entryId: 'shared' },
  ])
  const updated = await recordUserBindingCell(runtime, session,
    'return shared.value', sharedNamespaceSnapshot(2))
  assert.equal(updated.result.value, 2)
})

// Owned synthetic program and transcript captured from the version-6 writer.
// These literal snapshot/compiler identities and completions preserve that
// writer's evidence independently of the current serializer and checkout.
function historicalDescriptorSession(hasValue) {
  const declaration = 'declare const shared: {\n  value: number;\n}'
  const userBindings = {
    version: 2, transform: 'amaro@1.1.11', revision: 1,
    fingerprint: 'b8b5fb9737db9330bb0b4a1c54dd5c4b143a6f181ad396b72f8400dcbfd873cb',
    entries: [{
      id: 'shared', name: 'shared', scope: 'namespace', symbols: ['value'], purpose: '', enabled: true,
      source: 'await tools.observe({ value: 1 }); export const value = 1',
      fingerprint: '2a9a19d50c075c555d39237b737fb6b779fc890f9e248153fdd5e4a96896706e',
      declaration, bindings: [{ name: 'shared', kind: 'variable', declaration }], durability: 'durable',
    }],
  }
  const program = `const installed = Object.getOwnPropertyDescriptor(this, 'shared')
shared = 17
Object.defineProperty(this, 'shared', installed)
${hasValue ? 'return shared.value' : 'void 0'}`
  const journal = {
    version: 6,
    bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    moduleSemantics: { defaultExportBinding: 'live-readonly' },
    userBindingsFingerprint: userBindings.fingerprint, userBindingsReusePolicy: 'implementation-v1',
    status: 'durable',
    calls: [{ global: 'tools', member: 'observe',
      args: { codec: 'ptc-value-graph/v1', root: { tag: 'reference', index: 0 },
        nodes: [{ type: 'object', prototype: 'object', entries: [['value', 1]] }] },
      ok: true, settle: 0, value: { codec: 'ptc-value-graph/v1', root: 'initialized', nodes: [] },
    }],
    operations: [], confirms: [], diagnostics: [],
    completion: { kind: 'return', hasValue,
      ...(hasValue ? { value: { codec: 'ptc-value-graph/v1', root: 1, nodes: [] } } : {}),
    },
  }
  const session = { id: `historical-descriptor-${hasValue}`, events: [] }
  appendRunCodeEvents(session.events, 'historical-descriptor', program, { meta: {
    [JOURNAL_KEY]: journal, [USER_BINDINGS_META_KEY]: userBindings,
  } })
  return session
}

test('version-6 assignment evidence retains the restored accessor through recovery and policy transition', async t => {
  for (const hasValue of [true, false]) await t.test(hasValue ? 'return' : 'void', async t => {
    const session = historicalDescriptorSession(hasValue)
    const historical = structuredClone(session.events)
    const userBindings = session.events[1].data.meta[USER_BINDINGS_META_KEY]
    const updated = createUserBindingsSnapshot({ entries: [{
      id: 'shared', name: 'shared', scope: 'namespace', enabled: true,
      source: 'await tools.observe({ value: 2 }); export const value = 2',
    }] }, 2)
    const initializations = []
    const functions = { observe: async ({ value }) => { initializations.push(value); return 'initialized' } }
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    const same = await recordUserBindingCell(runtime, session,
      'return [shared.value, typeof installed.get]', userBindings, functions)
    assert.equal(same.result.error, undefined)
    assert.deepEqual(same.result.value, [1, 'function'])
    assert.equal(same.recoveryBoundaries, undefined)
    assert.deepEqual(same.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
    assert.equal(same.journal.languageSemantics, STATEFUL_LANGUAGE_SEMANTICS)
    assert.deepEqual(initializations, [])
    const changed = await recordUserBindingCell(runtime, session, 'return shared.value', updated, functions)
    assert.equal(changed.result.error, undefined)
    assert.equal(changed.result.value, 1)
    assert.equal(changed.recoveryBoundaries, undefined)
    assert.deepEqual(changed.journal.userBindingNames, [{ name: 'shared', state: 'local' }])
    // New per-name cells still initialize a changed module whose public names
    // are all local. The historical initializer is never dispatched again.
    assert.deepEqual(initializations, [2])
    await runtime.dispose()
    const restored = new SessionRuntime()
    t.after(() => restored.dispose())
    const cold = await recordUserBindingCell(restored, session, 'return shared.value', updated, functions)
    assert.equal(cold.result.error, undefined)
    assert.equal(cold.result.value, 1)
    assert.equal(cold.recoveryBoundaries, undefined)
    assert.deepEqual(initializations, [2])
    assert.deepEqual(session.events.slice(0, historical.length), historical)
  })
})

/** Exercise both worker policies directly without inventing a historical journal. */
async function bindingWorker(t, languageSemantics = LEGACY_LANGUAGE_SEMANTICS) {
  let pending
  let nextId = 0
  let importNamespaces = new Set()
  let replyValue = 'initialized'
  const initializations = []
  const client = new WorkerClient({
    workerUrl: new URL('../internal/kernel-worker.js', import.meta.url), cwd: process.cwd(),
    onFailure: error => pending.reject(new Error(error)),
    onMessage(message) {
      if (message.type === 'done') pending.resolve(message)
      if (message.type === 'call') {
        initializations.push(decodeValue(message.args).value)
        client.post({ type: 'reply', runId: message.runId, id: message.id,
          ok: true, value: encodeValue(replyValue) })
      }
    },
  })
  t.after(() => client.dispose())
  await client.ensure(128)
  const shadowedNames = new Set()
  return {
    client,
    initializations,
    async run(program, userBindings, policy, options = {}) {
      pending = Promise.withResolvers()
      replyValue = options.replyValue ?? 'initialized'
      const prepared = prepareProgram(program, {
        languageSemantics, importNamespaces,
        bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
        rewritesEnabled: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
      })
      client.post({ type: 'run', id: ++nextId, program: prepared.code,
        languageSemantics: prepared.languageSemantics,
        moduleTransform: moduleTransformForLanguage(prepared.languageSemantics),
        rootRuntimeName: prepared.rootRuntimeName, rootBindings: prepared.rootBindings,
        returnSignal: prepared.returnSignal, asyncCompletion: prepared.asyncCompletion, commitSignal: prepared.commitSignal,
        moduleLoads: prepared.moduleLoads,
        namespaces: options.namespaces ?? [{ global: 'tools', members: ['observe'] }],
        maxOutputBytes: 65_536, durability: prepared.durability,
        ...(prepared.volatileReason === undefined ? {} : { volatileReason: prepared.volatileReason }),
        userBindings,
        userBindingsCwd: options.userBindingsCwd ?? process.cwd(),
        userBindingsReusePolicy: options.userBindingsReusePolicy ?? 'implementation-v1',
        userBindingsShadowPolicy: policy, shadowedUserBindingNames: [...shadowedNames],
        userBindingFailures: options.userBindingFailures ?? [],
      })
      const done = await pending.promise
      importNamespaces = prepared.importNamespaces
      for (const name of done.shadowedUserBindings ?? []) shadowedNames.add(name)
      return { ...done, prepared }
    },
  }
}

test('PTC-owned cells, modules, require and user bindings share the worker realm', async t => {
  const worker = await bindingWorker(t, STATEFUL_LANGUAGE_SEMANTICS)
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'realm-errors',
    name: 'realmErrors',
    scope: 'namespace',
    enabled: true,
    source: `export class BindingError extends Error {
      constructor(public readonly code: number) { super('binding error') }
    }`,
  }] }, 1)
  const done = await worker.run(`
import { readFile } from 'node:fs/promises'
const marker = { value: 19 }
globalThis.__ptcRealmMarker = marker
const importedMarker = (await import('data:text/javascript,export default globalThis.__ptcRealmMarker')).default
let importedError
try { await readFile('__ptc_missing_realm_probe__') } catch (error) { importedError = error }
let requiredError
try { require('node:fs').readFileSync('__ptc_missing_realm_probe__') } catch (error) { requiredError = error }
let urlError
try { new URL('relative-only') } catch (error) { urlError = error }
let syntaxError
try { JSON.parse('{') } catch (error) { syntaxError = error }
const bindingError = new realmErrors.BindingError(7)
const externalError = require('node:vm').runInNewContext('new Error("external")')
delete globalThis.__ptcRealmMarker
return [
  importedError instanceof Error,
  requiredError instanceof Error,
  urlError instanceof TypeError,
  syntaxError instanceof SyntaxError && syntaxError instanceof Error,
  bindingError instanceof realmErrors.BindingError,
  bindingError instanceof Error,
  bindingError.code === 7,
  importedMarker === marker,
  externalError instanceof Error,
]
`, userBindings, 'per-name')
  assert.equal(done.error, undefined, done.error)
  assert.deepEqual(decodeValue(done.value), [true, true, true, true, true, true, true, true, false])
})

function assignmentSnapshot(scope, value) {
  return createUserBindingsSnapshot({ entries: [{
    id: 'shared', name: 'shared', scope, enabled: true,
    source: `await tools.observe({ value: ${value} }); export const ${scope === 'namespace' ? 'value' : 'shared'} = ${value}`,
  }] }, value)
}

test('the raw worker receives the stateful preparation plan and reports actual root commits', async t => {
  const worker = await bindingWorker(t, STATEFUL_LANGUAGE_SEMANTICS)
  const done = await worker.run(`const previous = 1; const previous = 2
shared = shared
if (false) untouched = 99
return [previous, shared.value]`, assignmentSnapshot('namespace', 1), 'per-name')
  assert.equal(done.error, undefined)
  assert.deepEqual(decodeValue(done.value), [2, 1])
  assert.equal(done.committedRedeclarations.length, 2)
  assert.deepEqual(new Set(done.committedRedeclarations), new Set(done.prepared.commitTargets))
  assert.deepEqual(done.rootBindingFacts.map(({ name, source }) => ({ name, source })), [
    { name: 'previous', source: 'local' },
    { name: 'shared', source: 'local' },
  ])
  assert.equal(typeof done.rootBindingFacts.find(fact => fact.name === 'shared').write, 'string')
  assert.deepEqual(done.userBindingNames, [{ name: 'shared', state: 'local' }])
  assert.deepEqual(worker.initializations, [1])
})

test('kernel REPL control survives user-visible AsyncLocalStorage prototype mutations', async t => {
  for (const method of ['getStore', 'enterWith', 'run']) {
    const worker = await bindingWorker(t, STATEFUL_LANGUAGE_SEMANTICS)
    const changed = await worker.run(`
const { AsyncLocalStorage } = require('node:async_hooks')
AsyncLocalStorage.prototype.${method} = null
return AsyncLocalStorage.prototype.${method} === null`, undefined, 'per-name')
    assert.equal(changed.error, undefined, changed.error)
    assert.equal(decodeValue(changed.value), true)
    const continued = await worker.run(`
const { AsyncLocalStorage } = require('node:async_hooks')
return [42, AsyncLocalStorage.prototype.${method} === null]`, undefined, 'per-name')
    assert.equal(continued.error, undefined, continued.error)
    assert.deepEqual(decodeValue(continued.value), [42, true])
  }
})

test('both policies combine actual assignments with descriptors across return and void completion', async t => {
  for (const policy of ['whole-entry', 'per-name']) {
    for (const scope of ['namespace', 'top-level']) {
      for (const write of ['shared = 17', 'shared = shared', '']) {
        for (const hasValue of [true, false]) await t.test(`${policy}, ${scope}, ${write || 'unwritten'}, ${hasValue}`, async t => {
          const worker = await bindingWorker(t)
          const read = scope === 'namespace' ? 'shared.value' : 'shared'
          const initial = assignmentSnapshot(scope, 1)
          const done = await worker.run(`const installed = Object.getOwnPropertyDescriptor(this, 'shared')
${write}
Object.defineProperty(this, 'shared', installed)
${hasValue ? `return ${read}` : 'void 0'}`, initial, policy)
          assert.equal(done.error, undefined)
          assert.equal(done.hasValue, hasValue)
          if (hasValue) assert.equal(decodeValue(done.value), 1)
          if (policy === 'whole-entry') assert.deepEqual(done.shadowedUserBindings, write ? ['shared'] : [])
          else assert.deepEqual(done.userBindingNames, [write
            ? { name: 'shared', state: 'local' } : { name: 'shared', state: 'provider', entryId: 'shared' }])
          const same = await worker.run(`return ${read}`, initial, policy)
          assert.equal(same.error, undefined)
          assert.equal(decodeValue(same.value), 1)
          assert.deepEqual(worker.initializations, [1])
          const changed = await worker.run(`return ${read}`, assignmentSnapshot(scope, 2), policy)
          assert.equal(changed.error, undefined)
          assert.equal(decodeValue(changed.value), write ? 1 : 2)
          assert.deepEqual(worker.initializations, policy === 'whole-entry' && write ? [1] : [1, 2])
          assert.deepEqual(changed.activatedUserBindings, policy === 'whole-entry' && write ? [] : ['shared'])
        })
      }
    }
  }
})

test('legacy assignment and descriptor evidence share every completion envelope', async t => {
  for (const scope of ['namespace', 'top-level']) {
    for (const end of ['throw new Error("body failed")', 'return () => 1']) await t.test(`${scope}, ${end}`, async t => {
      const worker = await bindingWorker(t)
      const done = await worker.run(`const installed = Object.getOwnPropertyDescriptor(this, 'shared')
shared = shared
Object.defineProperty(this, 'shared', installed)
${end}`, assignmentSnapshot(scope, 1), 'whole-entry')
      assert.deepEqual(done.shadowedUserBindings, ['shared'])
      assert.deepEqual(done.activatedUserBindings, ['shared'])
      if (end.startsWith('throw')) assert.match(done.error, /body failed/)
      else assert.match(done.invalidOutput, /function/)
      const continued = await worker.run(`return ${scope === 'namespace' ? 'shared.value' : 'shared'}`,
        assignmentSnapshot(scope, 2), 'whole-entry')
      assert.equal(continued.error, undefined)
      assert.equal(decodeValue(continued.value), 1)
      assert.deepEqual(worker.initializations, [1])
    })
  }
})

test('legacy completion unions actual writes with independent descriptor changes', async t => {
  const worker = await bindingWorker(t)
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'shared', name: 'shared', scope: 'top-level', enabled: true,
    source: 'export const shared = 1; export const other = 1; export const sibling = 1',
  }] }, 1)
  const done = await worker.run(`const installed = Object.getOwnPropertyDescriptor(this, 'shared')
shared = shared
Object.defineProperty(this, 'shared', installed)
Object.defineProperty(this, 'other', { configurable: true, writable: true, value: 1 })
void 0`, userBindings, 'whole-entry')
  assert.equal(done.error, undefined)
  assert.deepEqual(done.shadowedUserBindings, ['shared', 'other'])
  const continued = await worker.run('return [shared, other, typeof sibling]', userBindings, 'whole-entry')
  assert.equal(continued.error, undefined)
  assert.deepEqual(decodeValue(continued.value), [1, 1, 'undefined'])
})

test('retained setters keep their original receiver and same-value assignment semantics after transition', async t => {
  for (const policy of ['whole-entry', 'per-name']) {
    for (const scope of ['namespace', 'top-level']) await t.test(`${policy}, ${scope}`, async t => {
      const worker = await bindingWorker(t)
      const initial = assignmentSnapshot(scope, 1)
      const seeded = await worker.run('const installed = Object.getOwnPropertyDescriptor(this, "shared"); void 0', initial, policy)
      assert.equal(seeded.error, undefined)
      const transitioned = await worker.run('return Object.getOwnPropertyDescriptor(this, "shared").set === installed.set', initial, 'per-name')
      assert.equal(decodeValue(transitioned.value), true)
      const assigned = await worker.run(`const receiver = {}
installed.set.call(receiver, shared)
Object.defineProperty(this, 'shared', installed)
return Object.hasOwn(receiver, 'shared')`, initial, 'per-name')
      assert.equal(assigned.error, undefined)
      assert.equal(decodeValue(assigned.value), policy === 'per-name')
      assert.deepEqual(assigned.userBindingNames, [policy === 'whole-entry'
        ? { name: 'shared', state: 'local' } : { name: 'shared', state: 'provider', entryId: 'shared' }])
      const updated = await worker.run(`return ${scope === 'namespace' ? 'shared.value' : 'shared'}`,
        assignmentSnapshot(scope, 2), 'per-name')
      assert.equal(updated.error, undefined)
      assert.equal(decodeValue(updated.value), policy === 'whole-entry' ? 1 : 2)
      assert.deepEqual(worker.initializations, [1, 2])
    })
  }
})

test('whole-entry activation failure is contained and reported', async t => {
  const worker = await bindingWorker(t)
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'broken-whole-entry',
    name: 'brokenWholeEntry',
    scope: 'namespace',
    enabled: true,
    source: 'throw new Error("whole-entry activation failed"); export const value = 1',
  }] })
  const done = await worker.run('return typeof brokenWholeEntry', userBindings, 'whole-entry')
  assert.equal(done.error, undefined)
  assert.equal(decodeValue(done.value), 'undefined')
  assert.deepEqual(done.activatedUserBindings, [])
  assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['broken-whole-entry'])
  assert.match(done.userBindingFailures[0].error, /whole-entry activation failed/)
})

test('whole-entry activation reports a program namespace bridge conflict', async t => {
  const worker = await bindingWorker(t)
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'conflict-helper',
    name: 'conflictHelper',
    scope: 'namespace',
    enabled: true,
    source: 'export const value = 1',
  }] }, 1)
  const done = await worker.run('return conflictHelper.value', userBindings, 'whole-entry', {
    namespaces: [{ global: 'Buffer', members: ['value'] }],
  })
  assert.match(done.error, /namespace "Buffer" cannot be bridged.*already exists/)
  assert.deepEqual(done.activatedUserBindings, [])
  assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['conflict-helper'])
})

test('a failed historical binding activation restores the current request namespace', async t => {
  const worker = await bindingWorker(t, STATEFUL_LANGUAGE_SEMANTICS)
  const current = createUserBindingsSnapshot({ entries: [{
    id: 'failed-historical',
    name: 'failedHistorical',
    scope: 'namespace',
    enabled: true,
    source: 'throw new Error("historical activation failed"); export const value = 1',
  }] })
  const historical = { ...current, transform: PREVIOUS_USER_BINDING_TRANSFORM }
  const done = await worker.run('return await tools.observe({ value: 9 })', historical, 'per-name')
  assert.equal(done.error, undefined, done.error)
  assert.equal(decodeValue(done.value), 'initialized')
  assert.deepEqual(done.activatedUserBindings, [])
  assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['failed-historical'])
  assert.match(done.userBindingFailures[0].error, /historical activation failed/)
  assert.deepEqual(worker.initializations, [9])
})

test('a request overlay releases its stale provider before the updated provider activates', async t => {
  const worker = await bindingWorker(t, STATEFUL_LANGUAGE_SEMANTICS)
  const snapshot = value => createUserBindingsSnapshot({ entries: [{
    id: 'service-provider',
    name: 'serviceProvider',
    scope: 'top-level',
    enabled: true,
    source: `export const service = { value: ${value} }`,
  }] }, value)
  const initial = await worker.run('return service.value', snapshot(1), 'per-name', { namespaces: [] })
  assert.equal(initial.error, undefined)
  assert.equal(decodeValue(initial.value), 1)

  const covered = await worker.run('return 8', snapshot(2), 'per-name', {
    namespaces: [{ global: 'service', members: ['value'] }],
    userBindingFailures: [{
      id: 'service-provider',
      error: 'conflicts with request-owned program binding "service"',
    }],
  })
  assert.equal(covered.error, undefined, JSON.stringify(covered))
  assert.equal(decodeValue(covered.value), 8)
  assert.deepEqual(covered.activatedUserBindings, [])
  assert.deepEqual(covered.userBindingFailures.map(failure => failure.id), ['service-provider'])

  const restored = await worker.run('return service.value', snapshot(2), 'per-name', { namespaces: [] })
  assert.equal(restored.error, undefined)
  assert.equal(decodeValue(restored.value), 2)
})

test('a historical bridge conflict preserves the Node global and leaves the worker usable', async t => {
  const worker = await bindingWorker(t, STATEFUL_LANGUAGE_SEMANTICS)
  const current = createUserBindingsSnapshot({ entries: [{
    id: 'historical-buffer-conflict',
    name: 'historicalBufferConflict',
    scope: 'namespace',
    enabled: true,
    source: 'export const value = 1',
  }] })
  const historical = { ...current, transform: PREVIOUS_USER_BINDING_TRANSFORM }
  const failed = await worker.run('return 1', historical, 'per-name', {
    namespaces: [{ global: 'Buffer', members: ['observe'] }],
  })
  assert.match(failed.error, /program namespace "Buffer" cannot be bridged/)
  const continued = await worker.run('return [typeof Buffer.from, Buffer.from("ok").toString()]')
  assert.equal(continued.error, undefined, JSON.stringify(continued))
  assert.deepEqual(decodeValue(continued.value), ['function', 'ok'])
})

test('whole-entry activation rolls back names installed before a later conflict', async t => {
  const worker = await bindingWorker(t)
  // Seed one configurable followed property and one non-configurable conflict.
  await worker.run('globalThis.existingName = 1; return 1')
  await worker.run('Object.defineProperty(globalThis, "conflictName", { value: 1, configurable: false }); return 1')
  const source = `export const existingName = await tools.observe({ value: 1 })
export const freshName = 2
export const conflictName = 3`
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'rollback-whole-entry',
    name: 'rollbackWholeEntry',
    scope: 'top-level',
    enabled: true,
    source,
  }] })
  const done = await worker.run('return 1', userBindings, 'whole-entry')
  assert.equal(done.error, undefined)
  assert.deepEqual(done.activatedUserBindings, [])
  assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['rollback-whole-entry'])
  assert.match(done.userBindingFailures[0].error, /conflictName|Cannot redefine property/)

  const observed = await worker.run(`return {
    existing: globalThis.existingName,
    fresh: Object.hasOwn(globalThis, 'freshName'),
    conflictValue: globalThis.conflictName,
    conflictWritable: Object.getOwnPropertyDescriptor(globalThis, 'conflictName').writable,
  }`)
  assert.equal(observed.error, undefined)
  assert.deepEqual(decodeValue(observed.value), {
    existing: 1,
    fresh: false,
    conflictValue: 1,
    conflictWritable: false,
  })
})

test('whole-entry activation rejects a selected export missing after evaluation', async t => {
  const worker = await bindingWorker(t)
  const originalPost = worker.client.post.bind(worker.client)
  worker.client.post = message => {
    if (message.type !== 'run') return originalPost(message)
    return originalPost({
      ...message,
      userBindings: {
        ...message.userBindings,
        entries: message.userBindings.entries.map(entry => entry.id === 'legacy-missing-export'
          ? { ...entry, source: 'export const beta = 2' } : entry),
      },
    })
  }
  t.after(() => { worker.client.post = originalPost })

  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'legacy-missing-export',
    name: 'legacyMissingExport',
    scope: 'top-level',
    enabled: true,
    source: 'export const alpha = 1; export const beta = 2',
  }] })
  const done = await worker.run('return 1', userBindings, 'whole-entry')
  assert.equal(done.error, undefined)
  assert.deepEqual(done.activatedUserBindings, [])
  assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['legacy-missing-export'])
  assert.match(done.userBindingFailures[0].error, /named export "alpha" is unavailable after evaluation/)
})

test('process reflection marks a cell volatile without breaking the view', async t => {
  const worker = await bindingWorker(t)
  const done = await worker.run('return Object.keys(process).includes("cwd")')
  assert.equal(done.error, undefined)
  assert.equal(decodeValue(done.value), true)
  assert.equal(done.durability, 'volatile')
})


test('per-name activation rolls back names installed before a later conflict', async t => {
  const worker = await bindingWorker(t)
  await worker.run('globalThis.existingName = 1; return 1')
  await worker.run('Object.defineProperty(globalThis, "conflictName", { value: 1, configurable: false }); return 1')
  const source = `export const existingName = await tools.observe({ value: 1 })
export const freshName = 2
export const conflictName = 3`
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'rollback-per-name',
    name: 'rollbackPerName',
    scope: 'top-level',
    enabled: true,
    source,
  }] })
  const done = await worker.run('return 1', userBindings, 'per-name')
  assert.equal(done.error, undefined)
  assert.deepEqual(done.activatedUserBindings, [])
  assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['rollback-per-name'])
  assert.match(done.userBindingFailures[0].error, /conflictName|Cannot redefine property/)

  const observed = await worker.run(`return {
    existing: globalThis.existingName,
    fresh: Object.hasOwn(globalThis, 'freshName'),
    conflictValue: globalThis.conflictName,
  }`)
  assert.equal(observed.error, undefined)
  assert.deepEqual(decodeValue(observed.value), {
    existing: 1,
    fresh: false,
    conflictValue: 1,
  })
})

test('rejects a relative user binding cwd before evaluating source', async t => {
  const worker = await bindingWorker(t)
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'relative-cwd',
    name: 'relativeCwd',
    scope: 'namespace',
    enabled: true,
    source: 'export const value = 1',
  }] })
  for (const policy of ['whole-entry', 'per-name']) {
    const done = await worker.run('return 1', userBindings, policy, { userBindingsCwd: 'relative' })
    assert.equal(done.error, undefined)
    assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['relative-cwd'])
    assert.match(done.userBindingFailures[0].error, /absolute storage directory/)
  }
})

test('whole-entry activation records a volatile user binding', async t => {
  const worker = await bindingWorker(t)
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'volatile-whole-entry',
    name: 'volatileWholeEntry',
    scope: 'namespace',
    enabled: true,
    source: 'export const value = Math.random()',
  }] })
  const done = await worker.run('return typeof volatileWholeEntry', userBindings, 'whole-entry')
  assert.equal(done.error, undefined)
  assert.equal(decodeValue(done.value), 'object')
  assert.equal(done.durability, 'volatile')
  assert.match(done.volatileReason, /volatile-whole-entry/)
})

test('host-call encoding failure does not dispatch and leaves the worker usable', async t => {
  const worker = await bindingWorker(t)
  const failed = await worker.run('return await tools.observe(() => {})')
  assert.match(String(failed.error), /function|encode|unsupported/i)
  assert.deepEqual(worker.initializations, [])
  const next = await worker.run('return 2')
  assert.equal(next.error, undefined)
  assert.equal(decodeValue(next.value), 2)
})

test('per-name failure restores a previous provider source for a reused name', async t => {
  const worker = await bindingWorker(t)
  const provider = createUserBindingsSnapshot({ entries: [{
    id: 'previous-provider',
    name: 'previousProvider',
    scope: 'top-level',
    enabled: true,
    source: 'export const existingName = 1',
  }] })
  const seeded = await worker.run('return globalThis.existingName', provider, 'per-name')
  assert.equal(seeded.error, undefined)
  assert.equal(decodeValue(seeded.value), 1)

  const assigned = await worker.run('existingName = 99; return globalThis.existingName')
  assert.equal(assigned.error, undefined)
  assert.equal(decodeValue(assigned.value), 99)

  await worker.run('Object.defineProperty(globalThis, "conflictName", { value: 1, configurable: false }); return 1')
  const reused = createUserBindingsSnapshot({ entries: [{
    id: 'reused-name',
    name: 'reusedName',
    scope: 'top-level',
    enabled: true,
    source: `export const existingName = await tools.observe({ value: 2 })
export const conflictName = 3`,
  }] })
  const failed = await worker.run('return 1', reused, 'per-name')
  assert.equal(failed.error, undefined)
  assert.deepEqual(failed.activatedUserBindings, [])
  assert.deepEqual(failed.userBindingFailures.map(failure => failure.id), ['reused-name'])
  assert.match(failed.userBindingFailures[0].error, /conflictName|Cannot redefine property/)

  const next = await worker.run('return globalThis.existingName')
  assert.equal(next.error, undefined)
  assert.equal(decodeValue(next.value), 99)
})

test('console.dir participates in captured cell logs', async t => {
  const worker = await bindingWorker(t)
  const done = await worker.run('console.dir({ value: 1 }); return 1')
  assert.equal(done.error, undefined)
  assert.equal(done.logs.length, 1)
  assert.match(done.logs[0], /value/)
})

test('durability observation preserves native Date and Math.random reflection', async t => {
  const worker = await bindingWorker(t)
  const done = await worker.run(`
const dateDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Date')
const randomDescriptor = Object.getOwnPropertyDescriptor(Math, 'random')
return {
  dateIsData: Object.hasOwn(dateDescriptor, 'value') && dateDescriptor.value === Date,
  dateHasAccessors: Object.hasOwn(dateDescriptor, 'get') || Object.hasOwn(dateDescriptor, 'set'),
  randomIsData: Object.hasOwn(randomDescriptor, 'value') && randomDescriptor.value === Math.random,
  randomName: Math.random.name,
  randomSource: Function.prototype.toString.call(Math.random),
}
`)
  assert.equal(done.error, undefined)
  assert.deepEqual(decodeValue(done.value), {
    dateIsData: true,
    dateHasAccessors: false,
    randomIsData: true,
    randomName: 'random',
    randomSource: 'function random() { [native code] }',
  })
})

test('new require preserves the managed native export identity', async t => {
  const worker = await bindingWorker(t)
  const done = await worker.run('return new require("node:path") === require("node:path")')
  assert.equal(done.error, undefined)
  assert.equal(decodeValue(done.value), true)
})

test('kernel bookkeeping retains captured intrinsic operations across cells', async t => {
  const worker = await bindingWorker(t)
  const poisoned = await worker.run(`
globalThis.staleObserve = tools.observe
Set.prototype.has = null
Set.prototype.add = null
Map.prototype.get = null
Map.prototype.set = null
WeakMap.prototype.get = null
WeakMap.prototype.set = null
Array.prototype.includes = null
Object.entries = null
Object.getPrototypeOf = null
Array.isArray = null
Number.isSafeInteger = null
Reflect.apply = null
Reflect.construct = null
Reflect.deleteProperty = null
Reflect.ownKeys = null
Promise.reject = null
JSON.stringify = null
Buffer.byteLength = null
void 0
`)
  assert.equal(poisoned.error, undefined, poisoned.error)
  assert.equal(poisoned.hasValue, false)

  const continued = await worker.run(`
const reply = await tools.observe({ value: 2 })
return {
  reply,
  mutationsRemain: Object.entries === null && Object.getPrototypeOf === null
    && Array.isArray === null && Number.isSafeInteger === null && Reflect.ownKeys === null
    && Set.prototype.has === null && Set.prototype.add === null
    && Map.prototype.get === null && Map.prototype.set === null
    && WeakMap.prototype.get === null && WeakMap.prototype.set === null
    && Array.prototype.includes === null
    && Reflect.apply === null && Reflect.construct === null
    && Reflect.deleteProperty === null && Promise.reject === null
    && JSON.stringify === null && Buffer.byteLength === null,
}
  `, undefined, undefined, { replyValue: { accepted: [1, { value: 2 }] } })
  assert.equal(continued.error, undefined, JSON.stringify(continued))
  assert.deepEqual(continued.logs, [])
  assert.ok(continued.value, JSON.stringify(continued))
  assert.deepEqual(decodeValue(continued.value), {
    reply: { accepted: [1, { value: 2 }] },
    mutationsRemain: true,
  })

  const failed = await worker.run('throw new Error("failure detail\\nsecond line")')
  assert.equal(failed.error, 'failure detail\nsecond line')
  assert.equal(failed.errorName, 'Error')

  const removed = await worker.run('return [typeof tools, typeof api]',
    undefined, undefined, {
      namespaces: [{ global: 'api', members: ['value'] }],
    })
  assert.equal(removed.error, undefined, removed.error)
  assert.deepEqual(decodeValue(removed.value), ['undefined', 'object'])
})

test('binding module writes through a bridged request namespace are rejected', async t => {
  const worker = await bindingWorker(t)
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'namespace-write',
    name: 'namespaceWrite',
    scope: 'namespace',
    enabled: true,
    source: 'api.value = 1; export const result = 1',
  }] })
  const done = await worker.run('return 1', userBindings, 'per-name', {
    namespaces: [{ global: 'api', members: ['value'] }],
  })
  assert.equal(done.error, undefined)
  assert.deepEqual(done.activatedUserBindings, [])
  assert.deepEqual(done.userBindingFailures.map(failure => failure.id), ['namespace-write'])
  assert.match(done.userBindingFailures[0].error, /trap returned falsish|TypeError|read.only|Cannot assign/)
})
