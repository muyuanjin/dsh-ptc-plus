import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { Config, apply } from '../index.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import { JOURNAL_POLICY, appendRunCodeEvents, fixture } from './plugin-fixture.js'

test('disposes a kernel with its owning agent session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.run('session-a', 'const sessionValue = 9')

  await state.emit('agent/disposed', { agent: { id: 'session-a' } })
  assert.deepEqual(await state.run('session-a', 'return typeof sessionValue'), {
    logs: [],
    value: 'undefined',
  })
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
  const defaults = await Config['~standard'].validate({})
  assert.deepEqual(defaults, {
    value: {
      enabled: true,
      enhancedToolView: true,
      canonicalizeToolCalls: true,
      autoDescribeRunCode: true,
      looseTopLevelRedeclarations: true,
      autoRewriteImports: true,
      autoStripExports: true,
      autoSplitRedeclarations: true,
      durableReplay: true,
      tipsEnabled: true,
      cordisToolsEnabled: false,
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
    },
  })
  const invalid = await Config['~standard'].validate({ maxWallMs: 0 })
  assert.equal(invalid.issues.length, 1)
  assert.deepEqual(invalid.issues[0].path, ['maxWallMs'])
  assert.equal((await Config['~standard'].validate({ maxWallMs: 2_147_483_647 })).value.maxWallMs, 2_147_483_647)
  assert.deepEqual(
    (await Config['~standard'].validate({ maxWallMs: 2_147_483_648 })).issues[0].path,
    ['maxWallMs'],
  )
  for (const key of ['enhancedToolView', 'autoDescribeRunCode', 'cordisToolsEnabled', 'canonicalizeToolCalls', 'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations', 'tipsEnabled']) {
    assert.throws(() => fixture({ [key]: 'yes' }), new RegExp(`${key} must be a boolean`))
  }
  for (const key of ['tipCooldownMessages', 'tipEscalationFailures']) {
    assert.throws(() => fixture({ [key]: 0 }), new RegExp(`${key} must be a positive safe integer`))
  }
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

test('rejects unsupported runtimes and invalid limits', () => {
  const base = {
    tools: {},
    systemPrompt: { section() {} },
    on() {},
    effect() {},
  }
  assert.throws(() => apply({ ...base, codeRuntime: { language: 'python' } }), /only "typescript" is supported/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxWallMs: 0 }), /maxWallMs must be a positive safe integer/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxWallMs: 2_147_483_648 }), /maxWallMs must not exceed/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxNestedRunCodeDepth: 0 }), /maxNestedRunCodeDepth must be a positive safe integer/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { maxValueNodes: 0 }), /maxValueNodes must be a positive safe integer/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { looseTopLevelRedeclarations: 'yes' }), /looseTopLevelRedeclarations must be a boolean/)
  assert.throws(() => apply({
    ...base,
    codeRuntime: { language: 'typescript', run() {} },
  }, { durableReplay: 'yes' }), /durableReplay must be a boolean/)
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

test('covers plugin hook early exits and metadata installation failures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const execute = state.listeners.get('tools/execute')[0]
  const result = state.listeners.get('tools/result')[0]
  assert.equal(await execute({ name: 'other' }, async () => 'next'), 'next')
  assert.equal(await execute({ name: 'run_code', parent: {}, agent: { id: 'a' } }, async () => 'nested'), 'nested')
  assert.equal(await execute({ name: 'run_code', agent: {} }, async () => 'anonymous'), 'anonymous')
  result({ name: 'other' }, {})
  result({ name: 'run_code', parent: {}, agent: { id: 'a' } }, {})
  result({ name: 'run_code', agent: {} }, {})
  await state.emit('session/disposed', { id: 'absent' })

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

  const original = fixture()
  original.runCodeDefinition.output.presentationMeta = () => ({ original: true })
  await original.runDurable('original-metadata', 'return 1')
  await original.dispose()
  assert.deepEqual(original.runCodeDefinition.output.presentationMeta(), { original: true })

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

  while (runtime.kernels.get('wall-config-generation')?.active === undefined) {
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
  assert.equal(execution.settlement.journal.bindingMode, 'loose')
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

test('does not replay durable history after durable replay is disabled', async (t) => {
  const runtime = new SessionRuntime({ computeMs: 100, maxWallMs: 1_000 })
  t.after(() => runtime.dispose())
  assert.equal((await runtime.run('replay-disabled', {
    program: 'const replayOnlyBinding = 7', bindings: [],
  })).error, undefined)
  const kernel = runtime.kernels.get('replay-disabled')
  assert.equal(kernel.history.nodes.length, 1)
  runtime.reconfigure({ durableReplay: false })
  assert.equal(kernel.history.nodes.length, 1)
  await kernel.client.reset(kernel.client.worker)
  kernel.rollbackToDurable()
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
  const kernel = runtime.kernels.get(sessionId)
  assert.equal(kernel.history.nodes.length, 1)

  runtime.reconfigure({ durableReplay: true })
  await kernel.client.reset(kernel.client.worker)
  kernel.rollbackToDurable()
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
  const firstKernel = runtime.kernels.get('queued-memory-limit')
  assert.equal(firstKernel.client.workerLimit, 64)
  assert.equal(firstKernel.client.worker.resourceLimits.maxOldGenerationSizeMb, 64)

  await runtime.disposeSession('queued-memory-limit')
  runtime.reconfigure({ maxOldGenerationSizeMb: 128 })
  assert.equal((await runtime.run('new-memory-limit', { program: 'return 2', bindings: [] })).value, 2)
  const secondKernel = runtime.kernels.get('new-memory-limit')
  assert.equal(secondKernel.client.workerLimit, 128)
  assert.equal(secondKernel.client.worker.resourceLimits.maxOldGenerationSizeMb, 128)
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
  const duplicate = {
    type: 'tool/result', sourceEventSeqs: [1], data: { meta: { dshPtcPlus: {
      version: 3, bindingMode: 'loose', rewritePolicy: JOURNAL_POLICY, status: 'noop', calls: [], operations: [], confirms: [], diagnostics: [],
    } } },
  }
  const recovered = await invalidHistory.run({ id: 'invalid-history', session: { events: [duplicate, duplicate] } }, {
    program: 'return 1', bindings: [],
  })
  assert.equal(recovered.error.kind, 'recovery')
  assert.match(recovered.error.message, /duplicate PTC journal/)
  const context = { id: 'invalid-history', session: { events: [duplicate, duplicate] } }
  const resumed = await invalidHistory.run(context, { program: 'return 1', bindings: [] })
  assert.equal(resumed.error.kind, 'recovery')
  assert.match(resumed.error.message, /duplicate PTC journal/)

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
    const session = { id: item.name, events: [] }
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

  const session = { id: 'recorded-call-mismatch', events: [] }
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

test('covers runtime worker setup and state-operation failures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('class-redeclare', 'class ExistingClass {}\nfunction existingFunction() {}')
  assert.equal((await state.run('class-redeclare', 'class ExistingClass {}')).error.kind, 'exception')
  assert.equal((await state.run('class-redeclare', 'function existingFunction() {}')).error.kind, 'exception')
  assert.equal((await state.run('array-parameter', 'function take([first, ...rest] = []) { return [first, rest] }\nreturn take([1, 2])')).error, undefined)

  const volatileSave = await state.run('volatile-save-error', `
void Date.now()
return repl.state({ action: 'save', name: 'not-durable' })
`)
  assert.equal(volatileSave.error.kind, 'exception')

  await state.runDurable('delete-state', `
void await repl.state({ action: 'save', name: 'temporary' })
`)
  const deleted = await state.runDurable('delete-state', `
return repl.state({ action: 'delete', name: 'temporary' })
`)
  assert.deepEqual(deleted.value, { action: 'delete', name: 'temporary', deleted: true })

  const invalidErrorClass = new SessionRuntime()
  t.after(() => invalidErrorClass.dispose())
  const invalidErrorClassResult = await invalidErrorClass.run('invalid-error-class', {
    program: 'return api.call({})',
    bindings: [{
      global: 'api',
      functions: { call: async () => null },
      errorClass: { name: 'ApiError', invalid: () => {} },
    }],
  })
  assert.equal(invalidErrorClassResult.error.kind, 'exception')
  assert.match(invalidErrorClassResult.error.message, /errorClass\.memberNameProperty/)

  const tempKeys = ['TMPDIR', 'TEMP', 'TMP']
  const priorTemp = Object.fromEntries(tempKeys.map(key => [key, process.env[key]]))
  for (const key of tempKeys) process.env[key] = 'relative-temp'
  try {
    const invalidTemp = new SessionRuntime()
    t.after(() => invalidTemp.dispose())
    const result = await invalidTemp.run('invalid-temp', { program: 'return 1', bindings: [] })
    assert.equal(result.error.kind, 'worker-exit')
    assert.match(result.error.message, /temporary directory must be absolute/)
  } finally {
    for (const key of tempKeys) {
      if (priorTemp[key] === undefined) delete process.env[key]
      else process.env[key] = priorTemp[key]
    }
  }

  const exiting = new SessionRuntime({ computeMs: 1_000, maxWallMs: 1_000 })
  t.after(() => exiting.dispose())
  const exited = await exiting.run('worker-exit', { program: 'process.reallyExit(7)', bindings: [] })
  assert.equal(exited.error.kind, 'worker-exit')

  const direct = new SessionRuntime()
  t.after(() => direct.dispose())
  const context = { id: 'inactive-control', callId: 'one' }
  await direct.run(context, { program: 'return 1', bindings: [] })
  const kernel = direct.kernels.get(context.id)
  assert.throws(() => kernel.cellExecutor.controlState({ action: 'list' }), /unavailable outside a cell/)

  assert.deepEqual(kernel.cellExecutor.withControlBinding([], undefined, undefined), [])
  kernel.completeJournal(undefined, 'noop', { logs: [] })
  kernel.cellExecutor.onMessage(null)
  kernel.cellExecutor.onMessage({ type: 'ignored' })
  kernel.client.fail({}, 'stale worker')
  const savedWorker = kernel.client.worker
  kernel.client.worker = {}
  kernel.client.port = undefined
  kernel.active = undefined
  kernel.client.fail(kernel.client.worker, 'detached worker')
  kernel.client.worker = savedWorker

  const cleanupFailure = new SessionRuntime()
  const cleanupContext = { id: 'scratch-cleanup', callId: 'one' }
  await cleanupFailure.run(cleanupContext, { program: 'return 1', bindings: [] })
  const cleanupKernel = cleanupFailure.kernels.get(cleanupContext.id)
  const cleanupDirectory = await cleanupKernel.client.scratchReady
  cleanupKernel.client.scratchReady = Promise.reject(new Error('scratch unavailable'))
  void cleanupKernel.client.scratchReady.catch(() => {})
  await cleanupFailure.dispose()
  await rm(cleanupDirectory, { recursive: true, force: true })

  kernel.execute = async () => { throw new Error('tail rejection') }
  await assert.rejects(() => kernel.run({}), /tail rejection/)
  await kernel.tail
})

test('covers remaining schema defaults, no-value children, and expired leases', async (t) => {
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

  const noValue = fixture({}, { upstreamRun: async () => ({ logs: [] }) })
  t.after(() => noValue.dispose())
  assert.deepEqual((await noValue.run('child-no-value', `
return code.run({ code: 'void 0', description: 'No value' })
`)).value, { logs: [] })

  let expired
  const capture = fixture({}, { upstreamRun: async request => {
    expired = request.bindings.find(binding => binding.global === 'tools').functions.echo
    return { logs: [] }
  } })
  t.after(() => capture.dispose())
  await capture.run('capture-expired', `return code.run({ code: 'void 0', description: 'Capture' })`, {
    echo: async value => value,
  })
  await assert.rejects(expired(null), /lease expired/)

  const execute = state.listeners.get('tools/execute')[0]
  await assert.rejects(execute(
    { name: 'run_code', callId: 'raw', agent: { id: 'raw-bindings' } },
    () => state.runtime.run({ program: 'return 1', bindings: null }),
  ), /bindings must be an array/)

  await assert.rejects(execute(
    { name: 'run_code', callId: 'raw-2', agent: { id: 'raw-functions' } },
    () => state.runtime.run({ program: 'return 1', bindings: [{ global: 'tools' }] }),
  ), /binding tools functions must be an object/)

  state.runCodeDefinition.output.presentationMeta({}, undefined)
  await state.emit('agent/disposed', { agent: {} })
  state.runCodeDefinition.output.presentationMeta = () => ({ replaced: true })
})

test('covers remaining AST scope and loose replacement forms', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('replacement-forms', 'let noInitializer = 1\nvar existingVar = 2')
  assert.equal((await state.run('replacement-forms', 'let noInitializer')).error, undefined)
  assert.equal((await state.run('replacement-forms', 'var existingVar = 3')).error, undefined)
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
  assert.equal(result.error, undefined)
})

test('restores an inherited runtime provider without leaving an own patch', async () => {
  const listeners = new Map()
  const cleanups = []
  const inheritedRun = async () => ({ logs: [] })
  const runtime = Object.assign(Object.create({ run: inheritedRun }), {
    language: 'typescript', isolation: 'worker-thread',
  })
  const definition = { name: 'run_code', output: {} }
  const ctx = {
    codeRuntime: runtime,
    tools: { get: () => definition, schemas: () => [], register: () => () => {} },
    systemPrompt: { section() {} },
    on(name, listener) { listeners.set(name, listener) },
    effect(register) { cleanups.push(register()) },
  }
  apply(ctx)
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(runtime.run, inheritedRun)
})
