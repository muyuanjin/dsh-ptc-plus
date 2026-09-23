import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { Config, apply } from '../index.js'
import {
  GENERATED_RUN_CODE_DESCRIPTION,
  GENERATED_RUN_CODE_DESCRIPTION_KEY,
  markGeneratedRunCodeArguments,
} from '../internal/run-code-description.js'
import { RECOVERY_BOUNDARY_KEY, normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import { resolveConfig } from '../internal/runtime-config.js'
import { JOURNAL_POLICY, appendRunCodeEvents, fixture, orderedSurfaceSession } from './plugin-fixture.js'
import { serviceInjector } from './host-fixture.js'
import {
  activeTimers,
  awaitKernelTail,
  detachWorker,
  durableHistoryNodeCount,
  failKernelExecute,
  failScratchDirectory,
  failWorker,
  interceptWorkerMessages,
  interceptWorkerPosts,
  isCellActive,
  restartWorker,
  runKernelRequest,
  scratchDirectoryOf,
  sessionCellExecutor,
  sessionKernel,
  workerLimitOf,
  workerMemoryLimitMb,
  workerObservationOf,
  workerOf,
} from './runtime-observation.js'

test('disposes a live-only kernel with its owning agent session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('session-a', 'const sessionValue = process.pid')

  await state.emit('agent/disposed', { agent: { id: 'session-a' } })
  const continued = await state.run('session-a', 'return typeof sessionValue')
  assert.equal(continued.value, 'undefined')
  assert.equal(continued.logs.length, 1)
  assert.match(continued.logs[0], /Restored the durable head and skipped 1 unreconstructable historical cell/u)
})

test('missing, stale, and malformed value observations cannot change a settled cell', async t => {
  const runtime = new SessionRuntime({}, { observeSession: () => true })
  t.after(() => runtime.dispose())
  await runtime.run('observation-lifecycle', { program: 'let value = 1', bindings: [] })
  let mode = 'missing'
  const { deliver } = interceptWorkerMessages(runtime, 'observation-lifecycle', (message, forward) => {
    if (message?.type === 'observation') {
      forward({ ...message, id: message.id + 1000 })
      if (mode === 'missing') return
      if (mode === 'malformed') return forward({ ...message, observation: {} })
    }
    forward(message)
  })
  const missing = await runtime.runTentative('observation-lifecycle', { program: 'value += 1; return value', bindings: [] })
  assert.equal(missing.result.value, 2)
  assert.equal(missing.settlement.journal.status, 'durable')
  assert.equal(missing.settlement.replMemory.observation, undefined)
  runtime.finalize(missing.settlement, true)
  mode = 'malformed'
  const malformed = await runtime.runTentative('observation-lifecycle', { program: 'value += 1; return value', bindings: [] })
  assert.equal(malformed.result.value, 3)
  assert.equal(malformed.settlement.journal.status, 'durable')
  assert.equal(malformed.settlement.replMemory.observation, undefined)
  runtime.finalize(malformed.settlement, true)
  mode = 'valid'
  const valid = await runtime.runTentative('observation-lifecycle', { program: 'return value', bindings: [] })
  assert.equal(valid.settlement.replMemory.observation.entries[0].text, '3')
  runtime.finalize(valid.settlement, true)
  deliver({ type: 'observation', id: -1, observation: {} })
})

test('waits for worker readiness outside execution budgets after an observation timeout', async t => {
  const runtime = new SessionRuntime({}, { observeSession: () => true })
  t.after(() => runtime.dispose())
  const session = 'observation-readiness'
  await runtime.run(session, { program: 'let answer = 1', bindings: [] })
  const worker = workerOf(runtime, session)
  const { deliver } = interceptWorkerMessages(runtime, session, (message, forward) => {
    if (message.type !== 'observation') forward(message)
  })
  const timedOut = await runtime.runTentative(session, { program: 'answer += 1; return answer', bindings: [] })
  assert.equal(timedOut.result.value, 2)
  assert.equal(timedOut.settlement.replMemory.observation, undefined)
  runtime.finalize(timedOut.settlement, true)
  runtime.reconfigure({ computeMs: 100, maxWallMs: 100 })
  const posted = Promise.withResolvers()
  const held = interceptWorkerPosts(runtime, session, message => {
    posted.resolve(message)
    return undefined
  })
  let settled = false
  const pending = runtime.run(session, { program: 'return answer + 1', bindings: [] })
    .then(result => { settled = true; return result })
  const prepare = await posted.promise
  assert.deepEqual(activeTimers(runtime, session), { compute: undefined, wall: undefined })
  deliver({ type: 'ready', id: prepare.id - 1 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(settled, false)
  assert.equal(workerOf(runtime, session), worker)
  let runs = 0
  interceptWorkerPosts(runtime, session, message => {
    if (message.type === 'run') runs++
    return message
  })
  interceptWorkerMessages(runtime, session, (message, forward) => {
    forward(message)
    if (message.type === 'ready') forward(message)
  })
  held.post(prepare)
  assert.deepEqual(await pending, { logs: [], value: 3 })
  assert.equal(runs, 1)
  assert.equal(workerOf(runtime, session), worker)
  deliver({ type: 'ready', id: prepare.id })
  deliver({ type: 'ready' })
})

test('background callbacks cannot disable readiness timeout recovery', async t => {
  for (const [observe, computeMs, maxWallMs, message] of [
    [false, 100, 2000, /compute budget exhausted/],
    [true, 2000, 100, /wall-clock ceiling/],
  ]) {
    await t.test(observe ? 'after completed observation' : 'without observation', async t => {
      const runtime = new SessionRuntime({}, { observeSession: () => observe })
      t.after(() => runtime.dispose())
      const session = 'background-block'
      const first = await runtime.run(session, {
        program: 'let value = 1; setTimeout(() => { while (true) {} }, 20); return value', bindings: [],
      })
      assert.equal(first.value, 1)
      const worker = workerOf(runtime, session)
      await new Promise(resolve => setTimeout(resolve, 80))
      runtime.reconfigure({ computeMs, maxWallMs })
      const next = await runtime.runTentative(session, {
        program: 'return 2', bindings: [], signal: AbortSignal.timeout(3000),
      })
      assert.equal(next.result.error.kind, 'timeout')
      assert.match(next.result.error.message, message)
      assert.equal(next.settlement.journal.status, 'discarded')
      assert.equal(workerOf(runtime, session), undefined)
      runtime.finalize(next.settlement, true)
      assert.equal((await runtime.run(session, { program: 'return 3', bindings: [] })).value, 3)
      assert.notEqual(workerOf(runtime, session), worker)
    })
  }
})

test('late observation completion restores budgets even when ready never arrives', async t => {
  const runtime = new SessionRuntime({}, { observeSession: () => true })
  t.after(() => runtime.dispose())
  const session = 'observation-then-blocked'
  await runtime.run(session, { program: 'let value = 1', bindings: [] })
  let observation
  const { deliver } = interceptWorkerMessages(runtime, session, (message, forward) => {
    if (message.type === 'observation') observation = message
    else forward(message)
  })
  await runtime.run(session, { program: 'value += 1', bindings: [] })
  runtime.reconfigure({ computeMs: 2000, maxWallMs: 100 })
  const posted = Promise.withResolvers()
  interceptWorkerPosts(runtime, session, message => {
    posted.resolve(message)
    return undefined
  })
  const pending = runtime.run(session, {
    program: 'return value', bindings: [], signal: AbortSignal.timeout(3000),
  })
  const prepare = await posted.promise
  assert.equal(prepare.type, 'prepare')
  deliver({ ...observation, id: -1 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(activeTimers(runtime, session).wall, undefined)
  deliver(observation)
  assert.notEqual(activeTimers(runtime, session).wall, undefined)
  assert.equal(workerObservationOf(runtime, session), undefined)
  const timer = activeTimers(runtime, session).wall
  deliver(observation)
  assert.equal(activeTimers(runtime, session).wall, timer)
  assert.equal((await pending).error.kind, 'timeout')
})

test('waiting for worker readiness remains cancellable and handles disposal and failure', async t => {
  for (const action of ['abort', 'dispose', 'failure']) {
    await t.test(action, async t => {
      const runtime = new SessionRuntime()
      t.after(() => runtime.dispose())
      await runtime.run(action, { program: 'let answer = 1', bindings: [] })
      const worker = workerOf(runtime, action)
      const executor = sessionCellExecutor(runtime, action)
      const posted = Promise.withResolvers()
      const messages = []
      const heldPosts = interceptWorkerPosts(runtime, action, message => {
        messages.push(message)
        posted.resolve(message)
        return undefined
      })
      const controller = new AbortController()
      const pending = runtime.runTentative(action, {
        program: 'answer += 1; return answer', bindings: [], signal: controller.signal,
      })
      const held = await posted.promise
      assert.equal(held.type, 'prepare')
      assert.notEqual(activeTimers(runtime, action).compute, undefined)
      assert.notEqual(activeTimers(runtime, action).wall, undefined)
      if (action === 'abort') controller.abort('cancel waiting cell')
      else if (action === 'dispose') await runtime.dispose()
      else await worker.terminate()
      const completed = await pending
      assert.equal(completed.result.error.kind, action === 'failure' ? 'worker-exit' : 'abort')
      assert.equal(completed.settlement.journal.status, 'discarded')
      assert.equal(activeTimers(runtime, action), undefined)
      assert.equal(workerOf(runtime, action), undefined)
      executor.onMessage({ type: 'ready', id: held.id })
      assert.deepEqual(messages, [held])
      heldPosts.restore()
      runtime.finalize(completed.settlement, true)
      if (action !== 'dispose') {
        const next = await runtime.run(action, { program: 'return answer', bindings: [] })
        assert.equal(next.error, undefined)
        assert.equal(next.value, 1)
        assert.notEqual(workerOf(runtime, action), worker)
      }
    })
  }
})

test('omitted long binding names do not suppress visible previews across cells', async t => {
  const runtime = new SessionRuntime({}, { observeSession: () => true })
  t.after(() => runtime.dispose())
  const session = 'long-observation-name'
  const longName = 'x'.repeat(129)
  await runtime.run(session, { program: 'let answer = 42', bindings: [] })
  const worker = workerOf(runtime, session)
  for (const [program, result, preview] of [
    [`let ${longName} = 7; return answer`, 42, '42'],
    ['answer += 1; return answer', 43, '43'],
    [`return ${longName}`, 7, '43'],
  ]) {
    const observed = await runtime.runTentative(session, { program, bindings: [] })
    assert.equal(observed.result.error, undefined)
    assert.equal(observed.result.value, result)
    assert.deepEqual(observed.settlement.replMemory.entries.map(entry => entry.name), ['answer'])
    assert.deepEqual(observed.settlement.replMemory.observation?.entries, [
      { name: 'answer', status: 'readable', text: preview, truncated: false },
    ])
    runtime.finalize(observed.settlement, true)
    assert.equal(workerOf(runtime, session), worker)
  }
})

test('observation requests respect inventory entry and definition-source budgets', async t => {
  const runtime = new SessionRuntime({}, { observeSession: () => true })
  t.after(() => runtime.dispose())
  const declarations = Array.from({ length: 160 }, (_, index) => `value${index} = ${index}`)
  for (const [session, program, expectedCount] of [
    ['observation-source-budget', `let ${declarations.join(', ')}`, 16],
    ['observation-entry-budget', declarations.map(declaration => `let ${declaration}`).join('\n'), 128],
  ]) {
    await runtime.run(session, { program: '0', bindings: [] })
    const requests = []
    interceptWorkerPosts(runtime, session, message => {
      if (message.type === 'run') requests.push(message.observeNames)
      return message
    })
    const observed = await runtime.runTentative(session, { program, bindings: [] })
    assert.equal(observed.result.error, undefined)
    const memory = observed.settlement.replMemory
    assert.equal(memory.entries.length, expectedCount)
    assert.equal(memory.total, 160)
    assert.equal(memory.omitted, 160 - expectedCount)
    const names = memory.entries.map(entry => entry.name)
    assert.deepEqual(requests, [names])
    assert.deepEqual(memory.observation?.entries.map(entry => entry.name), names)
    runtime.finalize(observed.settlement, true)
  }
})

test('does not reset the binding draft projection for an Agent with no owned draft', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const events = []
  const session = {
    id: 'session-reset',
    append(type, data) {
      events.push({ type, data })
    },
  }
  await state.emit('agent/disposed', { agent: { id: 'session-reset', session } })
  assert.deepEqual(events, [])
})

test('delegates non-agent runtime calls and restores the provider on teardown', async () => {
  const state = fixture()
  const patched = state.runtime.run
  assert.deepEqual(await state.runtime.run({ program: 'return 1', bindings: [] }), {
    logs: ['upstream'],
    value: 'upstream',
  })
  assert.equal(state.upstreamCalls.length, 1)

  await state.dispose()
  assert.notEqual(state.runtime.run, patched)
  assert.deepEqual(await state.runtime.run({ program: 'return 2', bindings: [] }), {
    logs: ['upstream'],
    value: 'upstream',
  })
})

test('disposes fixture cleanups once in LIFO order across concurrent callers', async () => {
  const state = fixture()
  const observed = []
  state.ctx.effect(() => async () => {
    await Promise.resolve()
    observed.push('first')
  })
  state.ctx.effect(() => () => observed.push('second'))

  await Promise.all([state.dispose(), state.dispose()])
  await state.dispose()
  assert.deepEqual(observed, ['second', 'first'])
})

test('exports a Cordis config schema with validated runtime defaults', async () => {
  const validated = await Config['~standard'].validate({})
  const defaults = Object.fromEntries(Object.entries(validated.value)
    .map(([key, value]) => [key, value !== null && typeof value === 'object'
      && typeof value.get === 'function' ? value.get() : value])
    .filter(([, value]) => value !== undefined))
  assert.deepEqual(defaults, {
      legacyBindingSettings: false,
      enabled: true,
      enhancedToolView: true,
      replViewEnabled: true,
      bindingAuthorButtonVisible: true,
      canonicalizeToolCalls: true,
      autoDescribeRunCode: true,
      looseTopLevelRedeclarations: true,
      looseTopLevelFunctionClassRedeclarations: true,
      autoRewriteImports: true,
      autoStripExports: true,
      autoSplitRedeclarations: true,
      durableReplay: true,
      tipsEnabled: true,
      cordisToolsEnabled: false,
      userBindingsEnabled: false,
      computeMs: 60_000,
      maxWallMs: 600_000,
      maxOldGenerationSizeMb: 512,
      maxNestedRunCodeDepth: 8,
      maxOutputBytes: 64 * 1024 * 1024,
      maxValueNodes: 100_000,
      maxValueEdges: 1_000_000,
      maxValueArrayLength: 1_000_000,
      maxValueBigIntDigits: 100_000,
      tipCooldownMessages: 3,
      tipEscalationFailures: 2,
  })
  const invalid = await Config['~standard'].validate({ maxWallMs: 0 })
  assert.equal(invalid.issues.length, 1)
  assert.deepEqual(invalid.issues[0].path, ['maxWallMs'])
  assert.equal(resolveConfig(
    (await Config['~standard'].validate({ maxWallMs: 2_147_483_647 })).value,
  ).maxWallMs, 2_147_483_647)
  assert.deepEqual(
    (await Config['~standard'].validate({ maxWallMs: 2_147_483_648 })).issues[0].path,
    ['maxWallMs'],
  )
  for (const key of ['enhancedToolView', 'autoDescribeRunCode', 'cordisToolsEnabled', 'canonicalizeToolCalls', 'looseTopLevelFunctionClassRedeclarations', 'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations', 'tipsEnabled']) {
    assert.throws(() => fixture({ [key]: 'yes' }), new RegExp(`${key} must be a boolean`))
  }
  for (const key of ['tipCooldownMessages', 'tipEscalationFailures']) {
    assert.throws(() => fixture({ [key]: 0 }), new RegExp(`${key} must be a positive safe integer`))
  }
})

test('exports apply as a plain function so Cordis observes its activation promise', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(Object.hasOwn(apply, 'prototype'), false)
})

test('retired runtime and metadata wrappers stay transparent across outer wrapper teardown', async () => {
  const state = fixture()
  const originalExecute = async args => args
  state.runCodeDefinition.execute = originalExecute
  await state.run('composition', 'return 1')
  const ptcRun = state.runtime.run
  const ptcPresentation = state.runCodeDefinition.output.presentationMeta
  const ptcExecute = state.runCodeDefinition.execute
  const outerRun = request => ptcRun(request)
  const outerPresentation = (args, value) => ptcPresentation(args, value)
  const outerExecute = (args, exec) => ptcExecute(args, exec)
  state.runtime.run = outerRun
  state.runCodeDefinition.output.presentationMeta = outerPresentation
  state.runCodeDefinition.execute = outerExecute

  await state.dispose()
  assert.equal(state.runtime.run, outerRun)
  assert.equal(state.runCodeDefinition.output.presentationMeta, outerPresentation)
  assert.equal(state.runCodeDefinition.execute, outerExecute)
  assert.deepEqual(await state.runtime.run({ program: 'return 2', bindings: [] }), {
    logs: ['upstream'],
    value: 'upstream',
  })
  assert.equal(state.runCodeDefinition.output.presentationMeta({}, undefined), undefined)

  state.runtime.run = ptcRun
  state.runCodeDefinition.output.presentationMeta = ptcPresentation
  state.runCodeDefinition.execute = ptcExecute
  assert.deepEqual(await state.runtime.run({ program: 'return 3', bindings: [] }), {
    logs: ['upstream'],
    value: 'upstream',
  })
  assert.equal(state.runCodeDefinition.output.presentationMeta({}, undefined), undefined)
})

test('restores providers normally when an outer wrapper unloads first', async () => {
  const state = fixture()
  const originalExecute = async args => args
  state.runCodeDefinition.execute = originalExecute
  await state.run('composition', 'return 1')
  const ptcRun = state.runtime.run
  const ptcPresentation = state.runCodeDefinition.output.presentationMeta
  const ptcExecute = state.runCodeDefinition.execute
  state.runtime.run = request => ptcRun(request)
  state.runCodeDefinition.output.presentationMeta = (args, value) => ptcPresentation(args, value)
  state.runCodeDefinition.execute = (args, exec) => ptcExecute(args, exec)

  state.runtime.run = ptcRun
  state.runCodeDefinition.output.presentationMeta = ptcPresentation
  state.runCodeDefinition.execute = ptcExecute
  await state.dispose()

  assert.notEqual(state.runtime.run, ptcRun)
  assert.equal(state.runCodeDefinition.output.presentationMeta, undefined)
  assert.equal(state.runCodeDefinition.execute, originalExecute)
  assert.deepEqual(await state.runtime.run({ program: 'return 2', bindings: [] }), {
    logs: ['upstream'],
    value: 'upstream',
  })
})

test('rejects unsupported runtimes and invalid limits', async () => {
  // Each case needs its own runtime object: an activation that succeeds takes
  // over the seam it selected, and one seam object carries one takeover.
  const base = (runtime) => {
    const ctx = {
      ptcRuntime: runtime,
      tools: {},
      systemPrompt: { section() {}, context: () => () => {} },
      on() {},
      effect() {},
    }
    ctx.inject = serviceInjector({ ptcRuntime: runtime }, () => ctx)
    return ctx
  }
  const typescript = () => ({ language: 'typescript', isolation: 'process', resolve: request => request, run() {} })
  await assert.rejects(async () => apply(
    base({ language: 'python', isolation: 'process', resolve: request => request, run() {} }),
  ), /only "typescript" is supported/)
  await assert.rejects(async () => apply(
    base(typescript()),
    { maxWallMs: 0 },
  ), /maxWallMs must be a positive safe integer/)
  await assert.rejects(async () => apply(
    base(typescript()),
    { maxWallMs: 2_147_483_648 },
  ), /maxWallMs must not exceed/)
  await assert.rejects(async () => apply(
    base(typescript()),
    { maxNestedRunCodeDepth: 0 },
  ), /maxNestedRunCodeDepth must be a positive safe integer/)
  await assert.rejects(async () => apply(
    base(typescript()),
    { maxValueNodes: 0 },
  ), /maxValueNodes must be a positive safe integer/)
  await assert.rejects(async () => apply(
    base(typescript()),
    { looseTopLevelRedeclarations: 'yes' },
  ), /looseTopLevelRedeclarations must be a boolean/)
  await assert.rejects(async () => apply(
    base(typescript()),
    { durableReplay: 'yes' },
  ), /durableReplay must be a boolean/)
})

test('validates the nested code.run request without policing native tool contracts', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const observed = await state.run('adapter-invalid', 'return code.run(null)')
  assert.equal(observed.error.kind, 'exception')

  const native = { unexpected: true, completeness: 'unknown' }
  assert.deepEqual(await state.run('native-result-contract', 'return tools.read({ file_path: "a" })', {
    read: async () => native,
  }), { logs: [], value: native })
})

test('preflights complex scopes and rewrites returns through catch patterns', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const scoped = await state.run('complex-scopes', `
const [first, , third = 3, ...tail] = [1, 2, undefined, 4]
const { value: renamed, nested: { item }, ...rest } = { value: 5, nested: { item: 6 }, extra: 7 }
function outer({ input = 1 }, ...args) {
  var local = input
  function nested() { return Date.now() }
  return local + args.length
}
class LocalClass {}
{
  const Date = { now: () => 8 }
  function blockFunction() { return Date.now() }
  class BlockClass {}
  blockFunction()
}
for (const loopValue of [1]) { void loopValue }
for (let loopIndex = 0; loopIndex < 1; loopIndex += 1) { void loopIndex }
try { throw { reason: 1 } } catch ({ reason }) { void reason }
try { throw 1 } catch { void 0 }
return { first, third, tail, renamed, item, rest, outer: outer({}), className: LocalClass.name }
`)
  assert.deepEqual(scoped.value, {
    first: 1, third: 3, tail: [4], renamed: 5, item: 6, rest: { extra: 7 }, outer: 1, className: 'LocalClass',
  })

  const values = [
    ['try { return 11 } catch ({ message }) { return message }', 11],
    ['try { return 12 } catch { return 0 }', 12],
    ['try { throw { value: 13 } } catch ({ value }) { return value }', 13],
    ['try { throw 14 } catch { return 14 }', 14],
    ['return', 'undefined'],
  ]
  for (const [index, [program, expected]] of values.entries()) {
    assert.equal((await state.run(`return-rewrite-${index}`, program)).value, expected)
  }
})

test('validates state requests and classifies computed ambient access', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const invalid = [
    'return repl.state(null)',
    'return repl.state([])',
    'return repl.state({ action: "unknown" })',
    'return repl.state({ action: "save" })',
    'return repl.state({ action: "delete", name: "" })',
    'return repl.state({ action: "restore", name: "missing" })',
  ]
  for (const [index, program] of invalid.entries()) {
    assert.equal((await state.run(`state-invalid-${index}`, program)).error.kind, 'exception')
  }

  const volatile = [
    'const moduleName = "node:url"; await import(moduleName); return 1',
    'return globalThis["Date"].now()',
    'return Math["random"]()',
    'return process["platform"]',
  ]
  for (const [index, program] of volatile.entries()) {
    const result = await state.runDurable(`volatile-classification-${index}`, program)
    assert.equal(result.meta.dshPtcPlus.status, 'volatile')
  }
})

test('leaves unrelated, nested, and anonymous tool calls on the native path', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const execute = state.listeners.get('tools/execute')[0]
  assert.equal(await execute({ name: 'other' }, async () => 'next'), 'next')
  assert.equal(await execute({ name: 'run_code', parent: {}, agent: { id: 'a' } }, async () => 'nested'), 'nested')
  assert.equal(await execute({ name: 'run_code', agent: {} }, async () => 'anonymous'), 'anonymous')
})

test('ignores tool results that own no session journal', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = state.listeners.get('tools/result')[0]
  assert.equal(result({ name: 'other' }, {}), undefined)
  assert.equal(result({ name: 'run_code', parent: {}, agent: { id: 'a' } }, {}), undefined)
  assert.equal(result({ name: 'run_code', agent: {} }, {}), undefined)
})

test('disposing an unknown session leaves live bindings untouched', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('dispose-unknown-live', 'const disposeSurvivor = 1')
  await state.emit('session/disposed', { id: 'absent' })
  assert.deepEqual(await state.run('dispose-unknown-live', 'return disposeSurvivor'), {
    logs: [],
    value: 1,
  })
})

test('rejects a run_code definition that is unavailable, unprojected, or frozen', async (t) => {
  const missing = fixture()
  t.after(() => missing.dispose())
  missing.ctx.tools.get = () => undefined
  await assert.rejects(() => missing.executeRun('missing-definition', 'return 1', {}, {}), /definition is unavailable/)

  const noOutput = fixture()
  t.after(() => noOutput.dispose())
  noOutput.runCodeDefinition.output = undefined
  await assert.rejects(() => noOutput.executeRun('missing-output', 'return 1', {}, {}), /has no output projection/)

  const frozen = fixture()
  t.after(() => frozen.dispose())
  Object.freeze(frozen.runCodeDefinition.output)
  await assert.rejects(() => frozen.executeRun('frozen-output', 'return 1', {}, {}), /cannot attach the session journal/)
})

test('keeps an outer presentation projection across plugin teardown', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  state.runCodeDefinition.output.presentationMeta = () => ({ original: true })
  await state.runDurable('original-metadata', 'return 1')
  await state.dispose()
  assert.deepEqual(state.runCodeDefinition.output.presentationMeta(), { original: true })
})

test('failed execute installation restores the original presentation owner', async t => {
  for (const original of [undefined, () => ({ original: true })]) {
    const state = fixture()
    t.after(() => state.dispose())
    if (original === undefined) delete state.runCodeDefinition.output.presentationMeta
    else state.runCodeDefinition.output.presentationMeta = original
    Object.defineProperty(state.runCodeDefinition, 'execute', { configurable: false, writable: false, value() {} })
    await assert.rejects(state.executeRun('frozen-execute', 'return 1', {}, {}), /cannot attach the session journal/)
    assert.equal(state.runCodeDefinition.output.presentationMeta, original)
    assert.equal(Object.hasOwn(state.runCodeDefinition.output, 'presentationMeta'), original !== undefined)
  }
})

test('rejects a tool assembly without a tools array', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await assert.rejects(() => state.assemble({ tools: null }), /expected a tools array/)
})

test('rejects malformed direct runtime requests and hostile tool errors', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())
  const invalid = [
    [{ program: 1, bindings: [] }, /program must be a string/],
    [{ program: 'return 1', bindings: null }, /bindings must be an array/],
    [{ program: 'return 1', bindings: [null] }, /binding namespace must be an object/],
    [{ program: 'return 1', bindings: [{ global: 'bad', functions: null }] }, /binding bad functions must be an object/],
    [{ program: 'return 1', bindings: [{ global: 'bad', functions: { call: 1 } }] }, /binding bad\.call is not an own callable value/],
    [{ program: 'return 1', bindings: [{ global: 'bad', functions: {}, errorClass: { name: 'BadError' } }] }, /memberNameProperty/],
  ]
  for (const [index, [request, expected]] of invalid.entries()) {
    const result = await runtime.run(`direct-invalid-${index}`, request)
    assert.equal(result.error.kind, 'exception')
    assert.match(result.error.message, expected)
  }

  const controller = new AbortController()
  controller.abort('already stopped')
  assert.deepEqual(await runtime.run('direct-aborted', {
    program: 'return 1', bindings: [], signal: controller.signal,
  }), { logs: [], error: { kind: 'abort', message: 'already stopped' } })

  const hostile = Object.create(null)
  Object.defineProperty(hostile, 'message', { get() { throw new Error('hidden') } })
  hostile[Symbol.toPrimitive] = () => { throw new Error('unprintable') }
  const thrown = await runtime.run('hostile-host-error', {
    program: 'return api.fail({})',
    bindings: [{ global: 'api', functions: { fail: async () => { throw hostile } } }],
  })
  assert.equal(thrown.error.kind, 'exception')
  assert.match(thrown.error.message, /Unprintable error/)

  for (const [index, thrownValue] of [7, '', Object.assign(function failure() {}, { message: 'function error' })].entries()) {
    const result = await runtime.run(`host-error-shape-${index}`, {
      program: 'return api.fail({})',
      bindings: [{ global: 'api', functions: { fail: async () => { throw thrownValue } } }],
    })
    assert.equal(result.error.kind, 'exception')
  }
})

test('reconfigures an active session kernel without replacing its runtime', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())
  assert.equal((await runtime.run('reconfigure-session', { program: 'return 1', bindings: [] })).value, 1)
  runtime.reconfigure({ computeMs: 200, maxWallMs: 2_000 })
  assert.equal(runtime.config.computeMs, 200)
  assert.equal(runtime.config.maxWallMs, 2_000)
})

test('binds wall-clock configuration to the submitted cell generation', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 1_000, maxWallMs: 40 })
  t.after(() => runtime.dispose())
  const running = runtime.run('wall-config-generation', {
    program: 'await new Promise(() => {})', bindings: [],
  })

  while (!isCellActive(runtime, 'wall-config-generation')) {
    await new Promise(resolve => setImmediate(resolve))
  }
  runtime.reconfigure({ computeMs: 1_000, maxWallMs: 1_000 })

  const timedOut = await running
  assert.equal(timedOut.error.kind, 'timeout')
  assert.match(timedOut.error.message, /wall-clock ceiling reached \(40ms\)/)
  assert.equal((await runtime.run('wall-config-generation-next', {
    program: 'await new Promise(resolve => setTimeout(resolve, 60)); return 1', bindings: [],
  })).value, 1)
})

test('binds worker and host value budgets to one submitted cell generation', async (t) => {
  const outputRuntime = new SessionRuntime({
    computeMs: 1_000,
    maxWallMs: 1_000,
    maxOutputBytes: 64,
  })
  t.after(() => outputRuntime.dispose())
  let releaseOutput
  let outputStarted
  const outputGate = new Promise(resolve => { releaseOutput = resolve })
  const outputActive = new Promise(resolve => { outputStarted = resolve })
  const output = outputRuntime.run('output-config-generation', {
    program: 'await tools.wait({}); console.log("x".repeat(100)); return 1',
    bindings: [{ global: 'tools', functions: { wait: async () => { outputStarted(); await outputGate } } }],
  })
  await outputActive
  outputRuntime.reconfigure({
    computeMs: 1_000,
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
  })
  releaseOutput()
  const outputLimited = await output
  assert.equal(outputLimited.error.kind, 'output-limit')
  assert.match(outputLimited.error.message, /output exceeded 64 bytes/)
  assert.equal((await outputRuntime.run('output-config-generation-next', {
    program: 'console.log("x".repeat(100)); return 1', bindings: [],
  })).value, 1)

  const valueRuntime = new SessionRuntime({
    computeMs: 1_000,
    maxWallMs: 1_000,
    maxValueNodes: 1,
  })
  t.after(() => valueRuntime.dispose())
  let releaseValue
  let valueStarted
  const valueGate = new Promise(resolve => { releaseValue = resolve })
  const valueActive = new Promise(resolve => { valueStarted = resolve })
  const value = valueRuntime.run('value-config-generation', {
    program: 'await tools.wait({}); return { child: {} }',
    bindings: [{ global: 'tools', functions: { wait: async () => { valueStarted(); await valueGate } } }],
  })
  await valueActive
  valueRuntime.reconfigure({
    computeMs: 1_000,
    maxWallMs: 1_000,
    maxValueNodes: 10,
  })
  releaseValue()
  const valueLimited = await value
  assert.equal(valueLimited.error.kind, 'invalid-output')
  assert.match(valueLimited.error.message, /node budget exceeds 1/)
  assert.deepEqual(await valueRuntime.run('value-config-generation-next', {
    program: 'return { child: {} }', bindings: [],
  }), { logs: [], value: { child: {} } })
})

test('keeps queued journal and language policy on its submission generation', async (t) => {
  const runtime = new SessionRuntime({
    computeMs: 1_000,
    maxWallMs: 1_000,
    durableReplay: true,
    looseTopLevelRedeclarations: true,
    looseTopLevelFunctionClassRedeclarations: false,
    autoRewriteImports: true,
    autoStripExports: true,
    autoSplitRedeclarations: true,
  })
  t.after(() => runtime.dispose())
  await runtime.run('queued-config-generation', {
    program: 'const queuedGenerationBinding = 1', bindings: [],
  })

  let releaseBlocker
  let blockerStarted
  const blockerGate = new Promise(resolve => { releaseBlocker = resolve })
  const blockerActive = new Promise(resolve => { blockerStarted = resolve })
  const blocker = runtime.run('queued-config-generation', {
    program: 'await tools.wait({})',
    bindings: [{ global: 'tools', functions: { wait: async () => { blockerStarted(); await blockerGate } } }],
  })
  await blockerActive
  const queued = runtime.runTentative('queued-config-generation', {
    program: "import { format } from 'node:util'\nconst queuedGenerationBinding = 2\nreturn format('%s', 'value')",
    bindings: [],
  })
  runtime.reconfigure({
    computeMs: 1_000,
    maxWallMs: 1_000,
    durableReplay: false,
    looseTopLevelRedeclarations: false,
    autoRewriteImports: false,
    autoStripExports: false,
    autoSplitRedeclarations: false,
  })
  releaseBlocker()
  assert.equal((await blocker).error, undefined)

  const execution = await queued
  assert.equal(execution.result.value, 'value')
  assert.deepEqual(execution.settlement.journal.bindingPolicy, {
    variableRedeclarations: true,
    functionClassRedeclarations: false,
  })
  assert.deepEqual(execution.settlement.journal.rewritePolicy, JOURNAL_POLICY)
  assert.equal(execution.settlement.journal.status, 'durable')
  runtime.finalize(execution.settlement, true)

  const next = await runtime.run('queued-config-generation', {
    program: "import { format } from 'node:util'\nreturn format('%s', 'next')",
    bindings: [],
  })
  assert.equal(next.error.kind, 'exception')
  assert.match(next.error.message, /may only appear at the top level|Unexpected token|import/)
})

test('live catalogs follow execution before delayed journal confirmation', async t => {
  for (const policy of [{ legacyBindingSettings: true }, { bindingUpdates: 'stateful' }]) {
    const runtime = new SessionRuntime({ ...policy, durableReplay: false })
    t.after(() => runtime.dispose())
    const first = await runtime.runTentative('delayed-confirmation', {
      program: 'let value=1;const read=()=>value;return read()', bindings: [],
    })
    assert.equal(first.result.value, 1)
    const second = await runtime.runTentative('delayed-confirmation', {
      program: 'let value=2;const later=3;return [read(),later]', bindings: [],
    })
    assert.deepEqual(second.result.value, [2, 3], second.result.error?.message)
    runtime.finalize(second.settlement, true)
    runtime.finalize(first.settlement, false)
    const next = await runtime.run('delayed-confirmation', {
      program: 'return [read(),value,later]', bindings: [],
    })
    assert.deepEqual(next.value, [2, 2, 3], next.error?.message)
    assert.equal(durableHistoryNodeCount(runtime, 'delayed-confirmation'), 0)
  }
})

test('late journal confirmation cannot reinstall the catalog of a reset worker', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'protected', durableReplay: false })
  t.after(() => runtime.dispose())
  const pending = await runtime.runTentative('late-confirmation', {
    program: 'const discarded=1;return discarded', bindings: [],
  })
  assert.equal(pending.result.value, 1)
  await restartWorker(runtime, 'late-confirmation')
  assert.equal((await runtime.run('late-confirmation', {
    program: 'const retained=2;return retained', bindings: [],
  })).value, 2)
  runtime.finalize(pending.settlement, true)
  const next = await runtime.run('late-confirmation', {
    program: 'const discarded=3;return [discarded,retained]', bindings: [],
  })
  assert.deepEqual(next.value, [3, 2], next.error?.message)
  assert.equal(durableHistoryNodeCount(runtime, 'late-confirmation'), 0)
})

test('does not replay durable history after durable replay is disabled', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())
  assert.equal((await runtime.run('replay-disabled', {
    program: 'const replayOnlyBinding = 7', bindings: [],
  })).error, undefined)
  assert.equal(durableHistoryNodeCount(runtime, 'replay-disabled'), 1)
  runtime.reconfigure({ durableReplay: false })
  assert.equal(durableHistoryNodeCount(runtime, 'replay-disabled'), 1)
  await restartWorker(runtime, 'replay-disabled')
  const result = await runtime.run('replay-disabled', {
    program: 'return typeof replayOnlyBinding', bindings: [],
  })
  assert.equal(result.value, 'undefined')
})

test('preserves durable ancestors across a temporary replay disable', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())
  const sessionId = 'replay-toggle'
  await runtime.run(sessionId, {
    program: 'const replayAncestor = 7', bindings: [],
  })
  runtime.reconfigure({ durableReplay: false })
  const dependent = await runtime.run(sessionId, {
    program: 'const replayDescendant = replayAncestor + 1', bindings: [],
  })
  assert.equal(dependent.error, undefined)
  assert.equal(durableHistoryNodeCount(runtime, sessionId), 1)

  runtime.reconfigure({ durableReplay: true })
  await restartWorker(runtime, sessionId)
  const restored = await runtime.run(sessionId, {
    program: 'return [replayAncestor, typeof replayDescendant]', bindings: [],
  })
  assert.deepEqual(restored.value, [7, 'undefined'])
})

test('rejects live worker memory-limit changes without changing runtime config', async (t) => {
  const runtime = new SessionRuntime({ maxOldGenerationSizeMb: 64 })
  t.after(() => runtime.dispose())
  await runtime.run('memory-limit-session', { program: 'return 1', bindings: [] })
  assert.throws(
    () => runtime.reconfigure({ maxOldGenerationSizeMb: 128 }),
    /maxOldGenerationSizeMb cannot change while a session worker is active/,
  )
  assert.equal(runtime.config.maxOldGenerationSizeMb, 64)
  await runtime.disposeSession('memory-limit-session')
  runtime.reconfigure({ maxOldGenerationSizeMb: 128 })
  assert.equal(runtime.config.maxOldGenerationSizeMb, 128)
})

test('reserves the submitted cell memory limit before queued worker creation', async (t) => {
  const runtime = new SessionRuntime({ maxOldGenerationSizeMb: 64 })
  t.after(() => runtime.dispose())

  const submitted = runtime.run('queued-memory-limit', { program: 'return 1', bindings: [] })
  assert.throws(
    () => runtime.reconfigure({ maxOldGenerationSizeMb: 128 }),
    /maxOldGenerationSizeMb cannot change while a session worker is active/,
  )
  assert.equal((await submitted).value, 1)
  assert.equal(workerLimitOf(runtime, 'queued-memory-limit'), 64)
  assert.equal(workerMemoryLimitMb(workerOf(runtime, 'queued-memory-limit')), 64)

  await runtime.disposeSession('queued-memory-limit')
  runtime.reconfigure({ maxOldGenerationSizeMb: 128 })
  assert.equal((await runtime.run('new-memory-limit', { program: 'return 2', bindings: [] })).value, 2)
  assert.equal(workerLimitOf(runtime, 'new-memory-limit'), 128)
  assert.equal(workerMemoryLimitMb(workerOf(runtime, 'new-memory-limit')), 128)
})

test('handles direct runtime recovery, timeout, volatility, and lifecycle boundaries', async (t) => {
  const timed = new SessionRuntime({ computeMs: 1_000, maxWallMs: 20 })
  t.after(() => timed.dispose())
  const timeout = await timed.run('wall-timeout', { program: 'await new Promise(() => {})', bindings: [] })
  assert.equal(timeout.error.kind, 'timeout')
  assert.match(timeout.error.message, /wall-clock ceiling/)
  assert.match(timeout.error.message, /split long-running work into smaller cells/)

  assert.throws(() => timed.finalize(undefined, true), /unsettled SessionRuntime settlement/)
  assert.throws(() => timed.finalize({}, false), /unsettled SessionRuntime settlement/)
  await timed.disposeSession('absent')

  const invalidHistory = new SessionRuntime()
  t.after(() => invalidHistory.dispose())
  const session = orderedSurfaceSession('invalid-history')
  const events = session.events
  const historySeqs = appendRunCodeEvents(events, 'duplicate-history', 'const discardedHistory = 1', {
    meta: { dshPtcPlus: {
      version: 3, bindingMode: 'loose', rewritePolicy: JOURNAL_POLICY, status: 'noop', calls: [], operations: [], confirms: [], diagnostics: [],
    } },
  })
  events.push({ ...events.find(event => event.seq === historySeqs.resultSeq), seq: events.length })
  const currentArguments = JSON.stringify({ code: 'const recoveredValue = 1', description: 'recover current' })
  events.push({
    seq: events.length,
    type: 'assistant/message',
    data: { message: { content: [{
      type: 'tool-call', id: 'recover-current', name: 'run_code', arguments: currentArguments,
    }] } },
  })
  const currentCallSeq = events.length
  events.push({
    seq: currentCallSeq,
    type: 'tool/call',
    data: {
      callId: 'recover-current',
      name: 'run_code',
      arguments: currentArguments,
    },
  })
  const recovered = await invalidHistory.runTentative(
    { id: session.id, session, callId: 'recover-current' },
    { program: 'const recoveredValue = 1', bindings: [] },
  )
  assert.equal(recovered.result.error, undefined)
  assert.deepEqual(recovered.settlement.recoveryBoundaries, [
    { failedCallSeq: historySeqs.callSeq, frontierCallSeq: null },
  ])
  invalidHistory.finalize(recovered.settlement, true)
  events.push({
    seq: events.length,
    type: 'tool/result',
    sourceEventSeqs: [currentCallSeq],
    data: { meta: {
      dshPtcPlus: normalizeJournal(recovered.settlement.journal),
      [RECOVERY_BOUNDARY_KEY]: recovered.settlement.recoveryBoundaries,
    } },
  })

  const restarted = new SessionRuntime()
  t.after(() => restarted.dispose())
  const inspectCallSeq = events.length
  events.push({
    seq: inspectCallSeq,
    type: 'tool/call',
    data: {
      callId: 'recover-inspect',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return recoveredValue', description: 'inspect recovered value' }),
    },
  })
  const resumed = await restarted.run(
    { id: session.id, session, callId: 'recover-inspect' },
    { program: 'return recoveredValue', bindings: [] },
  )
  assert.deepEqual(resumed, { logs: [], value: 1 })

  const malformedTimeline = new SessionRuntime()
  t.after(() => malformedTimeline.dispose())
  const recoveredTimeline = await malformedTimeline.run({ id: 'malformed-timeline', session: { events: [
    { seq: 7, type: 'tool/call', data: { name: 'run_code', callId: 'first', arguments: '{}' } },
    { seq: 7, type: 'tool/call', data: { name: 'run_code', callId: 'second', arguments: '{}' } },
  ] } }, { program: 'return 1', bindings: [] })
  assert.equal(recoveredTimeline.error, undefined)
  assert.equal(recoveredTimeline.value, 1)
  assert.match(recoveredTimeline.logs[0], /PTC-R002/)

  const disposed = new SessionRuntime()
  await disposed.dispose()
  assert.deepEqual(await disposed.run('disposed', { program: 'return 1', bindings: [] }), {
    logs: [], error: { kind: 'abort', message: 'PTC runtime disposed' },
  })

  const duringRun = new SessionRuntime({ computeMs: 1_000, maxWallMs: 1_000 })
  const pending = duringRun.run('dispose-active', { program: 'await new Promise(() => {})', bindings: [] })
  await duringRun.dispose()
  assert.equal((await pending).error.kind, 'abort')
})

test('contracts every semantic replay mismatch before continuing', async (t) => {
  const cases = [
    {
      name: 'recorded-success-actual-throw',
      code: 'throw new Error("actual")',
      completion: { kind: 'return', hasValue: false },
    },
    {
      name: 'recorded-throw-actual-success',
      code: 'void 0',
      completion: { kind: 'throw', error: { kind: 'exception', message: 'recorded' } },
    },
    {
      name: 'recorded-durable-actual-volatile',
      code: 'void Date.now()',
      completion: { kind: 'return', hasValue: false },
    },
    {
      name: 'recorded-value-mismatch',
      code: 'return 2',
      completion: { kind: 'return', hasValue: true, value: encodeValue(1) },
    },
    {
      name: 'recorded-extra-call',
      code: 'void 0',
      calls: [{
        global: 'api', member: 'call', args: encodeValue({}), ok: true,
        value: encodeValue(null), settle: 0,
      }],
      completion: { kind: 'return', hasValue: false },
    },
  ]
  for (const item of cases) {
    const session = orderedSurfaceSession(item.name)
    appendRunCodeEvents(session.events, item.name, item.code, { meta: { dshPtcPlus: {
      version: 3,
      bindingMode: 'loose',
      rewritePolicy: JOURNAL_POLICY,
      status: 'durable',
      calls: item.calls ?? [],
      operations: [],
      confirms: [],
      diagnostics: [],
      completion: item.completion,
    } } })
    const state = fixture()
    t.after(() => state.dispose())
    const result = await state.run(item.name, 'return 1', { call: async () => null }, { session })
    assert.equal(result.error, undefined, item.name)
  }

  const session = orderedSurfaceSession('recorded-call-mismatch')
  const code = 'return await tools.call({ value: 1 })'
  appendRunCodeEvents(session.events, 'recorded-call-mismatch', code, { meta: { dshPtcPlus: {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: JOURNAL_POLICY,
    status: 'durable',
    calls: [{
      global: 'tools', member: 'call', args: encodeValue({ value: 2 }),
      ok: true, value: encodeValue(null), settle: 0,
    }],
    operations: [], confirms: [], diagnostics: [],
    completion: { kind: 'return', hasValue: true, value: encodeValue(null) },
  } } })
  const state = fixture()
  t.after(() => state.dispose())
  assert.equal((await state.run(session.id, 'return 1', { call: async () => null }, { session })).error, undefined)
})

test('rejects redeclaring a durable function or class when the policy is disabled', async (t) => {
  const state = fixture({ looseTopLevelFunctionClassRedeclarations: false })
  t.after(() => state.dispose())
  const setup = await state.runDurable('class-redeclare', 'class ExistingClass {}\nfunction existingFunction() {}')
  assert.equal(setup.isError, false)
  assert.equal((await state.run('class-redeclare', 'class ExistingClass {}')).error.kind, 'exception')
  assert.equal((await state.run('class-redeclare', 'function existingFunction() {}')).error.kind, 'exception')
})

test('accepts destructured parameters in a durable function declaration', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.run('array-parameter', `
function take([first, ...rest] = []) { return [first, rest] }
return take([1, 2])
`)
  assert.deepEqual(result, { logs: [], value: [1, [2]] })
})

test('rejects a durable state save from a volatile cell', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.run('volatile-save-error', `
void Date.now()
return repl.state({ action: 'save', name: 'not-durable' })
`)
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /cannot save a durable REPL state from a volatile segment/)
})

test('deletes a durable state entry through repl.state', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('delete-state', `
void await repl.state({ action: 'save', name: 'temporary' })
`)
  const deleted = await state.runDurable('delete-state', `
return repl.state({ action: 'delete', name: 'temporary' })
`)
  assert.deepEqual(deleted.value, { action: 'delete', name: 'temporary', deleted: true })
})

test('rejects a binding errorClass without a member-name property', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const result = await runtime.run('invalid-error-class', {
    program: 'return api.call({})',
    bindings: [{
      global: 'api',
      functions: { call: async () => null },
      errorClass: { name: 'ApiError', invalid: () => {} },
    }],
  })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /errorClass\.memberNameProperty/)
})

test('reports a worker exit when the temporary directory is not absolute', async (t) => {
  const tempKeys = ['TMPDIR', 'TEMP', 'TMP']
  const priorTemp = Object.fromEntries(tempKeys.map(key => [key, process.env[key]]))
  for (const key of tempKeys) process.env[key] = 'relative-temp'
  try {
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    const result = await runtime.run('invalid-temp', { program: 'return 1', bindings: [] })
    assert.equal(result.error.kind, 'worker-exit')
    assert.match(result.error.message, /temporary directory must be absolute/)
  } finally {
    for (const key of tempKeys) {
      if (priorTemp[key] === undefined) delete process.env[key]
      else process.env[key] = priorTemp[key]
    }
  }
})

test('reports a worker exit when a cell calls process.reallyExit', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 1_000, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())
  const result = await runtime.run('worker-exit', { program: 'process.reallyExit(7)', bindings: [] })
  assert.equal(result.error.kind, 'worker-exit')
})

test('rejects cell controls outside a running cell', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const context = { id: 'inactive-control', callId: 'one' }
  assert.deepEqual(await runtime.run(context, { program: 'return 1', bindings: [] }), { logs: [], value: 1 })
  const executor = sessionCellExecutor(runtime, context.id)
  assert.throws(() => executor.controlState({ action: 'list' }), /unavailable outside a cell/)
  assert.deepEqual(executor.withControlBinding([], undefined, undefined), [])
})

test('tolerates journal and frame input for a session without a live cell', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const context = { id: 'inactive-frames', callId: 'one' }
  assert.deepEqual(await runtime.run(context, { program: 'return 1', bindings: [] }), { logs: [], value: 1 })
  const kernel = sessionKernel(runtime, context.id)
  const executor = sessionCellExecutor(runtime, context.id)
  const worker = workerOf(runtime, context.id)
  assert.doesNotThrow(() => kernel.completeJournal(undefined, 'noop', { logs: [] }))
  assert.doesNotThrow(() => executor.onMessage(null))
  assert.doesNotThrow(() => executor.onMessage({ type: 'ignored' }))
  failWorker(runtime, context.id, {}, 'stale worker')
  assert.equal(workerOf(runtime, context.id), worker)
  const restore = detachWorker(runtime, context.id, 'detached worker')
  assert.equal(workerOf(runtime, context.id), undefined)
  restore()
  assert.equal(workerOf(runtime, context.id), worker)
})

test('disposes a kernel whose scratch directory cannot be read', async () => {
  const runtime = new SessionRuntime()
  const context = { id: 'scratch-cleanup', callId: 'one' }
  assert.deepEqual(await runtime.run(context, { program: 'return 1', bindings: [] }), { logs: [], value: 1 })
  const directory = await scratchDirectoryOf(runtime, context.id)
  failScratchDirectory(runtime, context.id, new Error('scratch unavailable'))
  await assert.doesNotReject(() => runtime.dispose())
  await rm(directory, { recursive: true, force: true })
})

test('settles the kernel queue after a rejected raw request', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const context = { id: 'kernel-tail', callId: 'one' }
  assert.deepEqual(await runtime.run(context, { program: 'return 1', bindings: [] }), { logs: [], value: 1 })
  failKernelExecute(runtime, context.id, new Error('tail rejection'))
  await assert.rejects(() => runKernelRequest(runtime, context.id, {}), /tail rejection/)
  await awaitKernelTail(runtime, context.id)
})

test('rejects run_code definitions with an incompatible schema', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const assembly = tool => ({ sections: [], tools: [tool] })
  const malformed = [
    { name: 'run_code' },
    { name: 'run_code', parameters: null },
    { name: 'run_code', parameters: { type: 'object' } },
    { name: 'run_code', parameters: { type: 'object', properties: {} } },
    { name: 'run_code', parameters: { type: 'object', properties: { code: { type: 'string' } } } },
  ]
  for (const tool of malformed) await assert.rejects(() => state.assemble(assembly(tool)), /incompatible run_code schema/)
})

test('passes a child cell without a completion value through the nested result', async (t) => {
  const noValue = fixture({}, { upstreamRun: async () => ({ logs: [] }) })
  t.after(() => noValue.dispose())
  const result = await noValue.run('child-no-value', `
return code.run({ code: 'void 0', description: 'No value' })
`)
  assert.deepEqual(result.value, { logs: [] })
})

test('rejects a captured legacy child tool lease after its cell settles', async (t) => {
  let expired
  const capture = fixture({ legacyBindingSettings: true }, { upstreamRun: async request => {
    expired = request.bindings.find(binding => binding.global === 'tools').functions.echo
    return { logs: [] }
  } })
  t.after(() => capture.dispose())
  const nested = await capture.run('capture-expired', `return code.run({ code: 'void 0', description: 'Capture' })`, {
    echo: async value => value,
  })
  assert.deepEqual(nested, { logs: [], value: { logs: [] } })
  await assert.rejects(expired(null), /lease expired/)
})

test('rejects raw run requests whose bindings are malformed', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const execute = state.listeners.get('tools/execute')[0]
  await assert.rejects(execute(
    { name: 'run_code', callId: 'raw', agent: { id: 'raw-bindings' } },
    () => state.runtime.run({ program: 'return 1', bindings: null }),
  ), /bindings must be an array/)
  await assert.rejects(execute(
    { name: 'run_code', callId: 'raw-2', agent: { id: 'raw-functions' } },
    () => state.runtime.run({ program: 'return 1', bindings: [{ global: 'tools' }] }),
  ), /binding tools functions must be an object/)
})

test('annotates generated run_code calls and leaves other calls untouched', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const execute = state.listeners.get('tools/execute')[0]
  await assert.rejects(execute(
    { name: 'run_code', callId: 'presentation-patch', agent: { id: 'presentation-patch' } },
    () => state.runtime.run({ program: 'return 1', bindings: null }),
  ), /bindings must be an array/)
  const presentationMeta = state.runCodeDefinition.output.presentationMeta
  assert.equal(presentationMeta({}, undefined), undefined)
  assert.equal(presentationMeta({}, { value: 1 }), undefined)
  assert.deepEqual(
    presentationMeta(markGeneratedRunCodeArguments({ code: 'return 1', description: 'Generated' }), undefined),
    { [GENERATED_RUN_CODE_DESCRIPTION_KEY]: GENERATED_RUN_CODE_DESCRIPTION },
  )
})

test('disposes an anonymous agent without disturbing a live session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('anonymous-agent', 'const anonymousSurvivor = 1')
  await state.emit('agent/disposed', { agent: {} })
  assert.deepEqual(await state.run('anonymous-agent', 'return anonymousSurvivor'), {
    logs: [],
    value: 1,
  })
})

test('preserves a bare let redeclaration and replaces an existing var declaration', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('replacement-forms', 'let noInitializer = 1\nvar existingVar = 2')
  assert.deepEqual(await state.run('replacement-forms', 'let noInitializer'), { logs: [] })
  assert.deepEqual(await state.run('replacement-forms', 'return noInitializer'), {
    logs: [],
    value: 1,
  })
  assert.deepEqual(await state.run('replacement-forms', 'var existingVar = 3'), { logs: [] })
  assert.deepEqual(await state.run('replacement-forms', 'return existingVar'), { logs: [], value: 3 })
})

test('accepts labeled loops, computed ambient access, and destructured parameters', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.run('ast-forms', `
function arrayParam([head, ...tail]) { return [head, tail] }
outer: for (const value of [1]) {
  inner: for (;;) {
    if (value) break inner
    continue outer
  }
}
const property = 'platform'
void process[property]
return arrayParam([1, 2])
`)
  assert.deepEqual(result, { logs: [], value: [1, [2]] })
})

test('supplies the session REPL on a host that registers only the current execution seam', async (t) => {
  const state = fixture({}, { seamService: 'ptcRuntime' })
  t.after(() => state.dispose())
  assert.deepEqual(await state.run('current-seam', 'const kept = 41'), { logs: [] })
  assert.deepEqual(await state.run('current-seam', 'return kept + 1'), { logs: [], value: 42 })
  assert.deepEqual(state.upstreamCalls, [])
})

test('reports an unusable execution seam through the plugin logger', async () => {
  const warnings = []
  const service = { language: 'typescript', run() {} }
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    get: name => (name === 'ptcRuntime' ? service : undefined),
    inject(names, callback) {
      if (names.includes('ptcRuntime')) callback({ ptcRuntime: service })
      return () => {}
    },
    effect() { return () => {} },
  }
  await assert.rejects(apply(ctx, {}), /ptcRuntime\.resolve must be a function/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /execution seam ptcRuntime failed to attach/)
  assert.match(warnings[0][1].message, /ptcRuntime\.resolve must be a function/)
})

test('presents the capabilities of the execution the plugin performs', async (t) => {
  const state = fixture({}, { seamService: 'ptcRuntime' })
  t.after(() => state.dispose())
  // While the plugin owns the seam, DSH reads these descriptors to decide
  // whether to offer a per-call deadline or a file sandbox at all.
  assert.equal(state.runtime.executionInstructions, '')
  assert.equal(state.runtime.sandboxMode, undefined)
  assert.equal(state.runtime.timeout, undefined)
})

test('restores an inherited runtime provider without leaving an own patch', async () => {
  const listeners = new Map()
  const cleanups = []
  const inheritedRun = async () => ({ logs: [] })
  const runtime = Object.assign(Object.create({ run: inheritedRun }), {
    language: 'typescript', isolation: 'process',
    resolve(request) { return { ...request, cwd: '/fixture-workspace', timeoutMs: null } },
  })
  const definition = { name: 'run_code', output: {} }
  const ctx = {
    ptcRuntime: runtime,
    tools: { get: () => definition, schemas: () => [], register: () => () => {} },
    systemPrompt: { section() {}, context: () => () => {} },
    on(name, listener) {
      listeners.set(name, listener)
      return () => { if (listeners.get(name) === listener) listeners.delete(name) }
    },
    effect(register) { cleanups.push(register()) },
  }
  ctx.inject = serviceInjector({ ptcRuntime: runtime }, () => ctx)
  await apply(ctx)
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(runtime.run, inheritedRun)
})
