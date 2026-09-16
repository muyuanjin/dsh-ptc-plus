import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../internal/runtime-config.js'
import { createExecutionSeam } from '../internal/execution-seam-compat.js'

let createRuntimeBridgeOwner
const active = {
  scenario: 'session-dispose',
  sessionDisposeFailure: undefined,
  firstFailure: undefined,
  secondFailure: undefined,
  instances: [],
  releaseRuns: [],
  startedChildren: 0,
  bothStarted: Promise.resolve(),
  resolveStarted: () => {},
  secondDisposeGate: Promise.resolve(),
  releaseSecondDispose: () => {},
  parentRunReady: Promise.resolve(),
  resolveParentRunReady: () => {},
  parentRunGate: Promise.resolve(),
  releaseParentRun: () => {},
  childStarted: Promise.resolve(),
  resolveChildStarted: () => {},
  lateChildDisposeGate: Promise.resolve(),
  releaseLateChildDispose: () => {},
  nestedRun: undefined,
  firstDisposeCalls: 0,
  secondDisposeCalls: 0,
}

function resetActiveChildren() {
  active.instances.length = 0
  active.releaseRuns.length = 0
  active.startedChildren = 0
  active.bothStarted = new Promise(resolve => { active.resolveStarted = resolve })
  active.secondDisposeGate = new Promise(resolve => { active.releaseSecondDispose = resolve })
  active.firstDisposeCalls = 0
  active.secondDisposeCalls = 0
}

function resetLateChild() {
  resetActiveChildren()
  active.parentRunReady = new Promise(resolve => { active.resolveParentRunReady = resolve })
  active.parentRunGate = new Promise(resolve => { active.releaseParentRun = resolve })
  active.childStarted = new Promise(resolve => { active.resolveChildStarted = resolve })
  active.lateChildDisposeGate = new Promise(resolve => { active.releaseLateChildDispose = resolve })
  active.nestedRun = undefined
}

class FakeSessionRuntime {
  constructor(config) {
    this.config = resolveConfig(config ?? {})
    this.index = active.instances.length
    active.instances.push(this)
  }

  async runTentative(_session, request) {
    const code = request.bindings.find(binding => binding.global === 'code')
    if (['late-child', 'native-handoff', 'child-retry'].includes(active.scenario)) {
      active.nestedRun = code.functions.run
      active.resolveParentRunReady()
      await active.parentRunGate
      return { result: { logs: [], value: 1 }, settlement: undefined }
    }
    const first = code.functions.run({ code: 'return 1', description: 'first child' })
    const second = code.functions.run({ code: 'return 2', description: 'second child' })
    await Promise.all([first, second])
    return { result: { logs: [], value: 1 }, settlement: undefined }
  }

  async run() {
    active.startedChildren += 1
    if ((active.scenario === 'late-child' || active.scenario === 'child-retry')
      && active.startedChildren === 1) active.resolveChildStarted()
    if (active.startedChildren === 2) active.resolveStarted()
    await new Promise(resolve => { active.releaseRuns.push(resolve) })
    return { logs: [], value: this.index }
  }

  async dispose() {
    if (active.scenario === 'session-dispose') throw active.sessionDisposeFailure
    if (active.scenario === 'late-child') {
      if (this.index === 1) {
        active.firstDisposeCalls += 1
        await active.lateChildDisposeGate
      }
      return
    }
    if (active.scenario === 'child-retry') {
      if (this.index === 1) {
        active.firstDisposeCalls += 1
        if (active.firstDisposeCalls === 1) throw active.firstFailure
      }
      return
    }
    if (this.index === 1) {
      active.firstDisposeCalls += 1
      throw active.firstFailure
    }
    if (this.index === 2) {
      active.secondDisposeCalls += 1
      await active.secondDisposeGate
      throw active.secondFailure
    }
  }
}

test('runtime bridge disposal waits for session disposal and aggregates its failure', async t => {
  active.scenario = 'session-dispose'
  active.sessionDisposeFailure = new Error('session runtime disposal failed')
  t.mock.module('../internal/session-runtime.js', {
    namedExports: { SessionRuntime: FakeSessionRuntime },
  })
  ;({ createRuntimeBridgeOwner } = await import('../internal/runtime-bridge-owner.js'))
  const runtime = { run() {} }
  const owner = createRuntimeBridgeOwner({
    seam: createExecutionSeam(runtime, 'codeRuntime'),
    ctx: { tools: { get: () => undefined } },
    sessionConfig: {},
    presentationGeneration: 'runtime-bridge-dispose-test',
    sessionId: agent => agent.id,
    toolSchemasForAgent: () => [],
  })

  const error = await owner.dispose().then(() => undefined, caught => caught)
  assert.ok(error instanceof AggregateError)
  assert.deepEqual(error.errors, [active.sessionDisposeFailure])
  assert.equal(active.instances.length, 1)
})

test('waiting for active child runtimes preserves every child disposal failure', { timeout: 20_000 }, async () => {
  active.scenario = 'active-children'
  active.firstFailure = new Error('first child disposal failed')
  active.secondFailure = new Error('second child disposal failed')
  resetActiveChildren()
  assert.equal(typeof createRuntimeBridgeOwner, 'function')

  const definition = { name: 'run_code', output: {} }
  const runtime = { run() {} }
  const owner = createRuntimeBridgeOwner({
    seam: createExecutionSeam(runtime, 'codeRuntime'),
    ctx: { tools: { get: () => definition } },
    sessionConfig: { maxNestedRunCodeDepth: 4 },
    presentationGeneration: 'runtime-bridge-active-children-test',
    sessionId: agent => agent.id,
    toolSchemasForAgent: () => [],
  })
  const agent = { id: 'runtime-bridge-active-children', session: { events: [] } }
  const execution = owner.handleExecute(
    { name: 'run_code', callId: 'child-disposal', agent },
    () => runtime.run({ program: 'return 1', bindings: [] }),
  )
  let executionError
  execution.catch(error => { executionError = error })
  const started = await Promise.race([
    active.bothStarted.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 2_000)),
  ])
  if (!started) {
    assert.fail(`child runtimes did not start; execution error: ${executionError?.stack ?? 'none'}`)
  }
  assert.equal(active.instances.length, 3)

  let settled = false
  const disposal = owner.dispose().then(
    () => { settled = true },
    error => { settled = true; return error },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(active.firstDisposeCalls, 1)
  assert.equal(active.secondDisposeCalls, 1)

  active.releaseSecondDispose()
  const error = await disposal
  assert.ok(error instanceof AggregateError)
  assert.deepEqual(error.errors, [active.firstFailure, active.secondFailure])

  for (const release of active.releaseRuns) release()
  await execution.catch(() => {})
  assert.equal(active.firstDisposeCalls, 1)
  assert.equal(active.secondDisposeCalls, 1)
})

test('terminal disposal rejects a child submitted after the drain snapshot', { timeout: 20_000 }, async t => {
  active.scenario = 'late-child'
  resetLateChild()
  t.after(() => {
    active.releaseLateChildDispose()
    active.releaseParentRun()
    for (const release of active.releaseRuns) release()
  })

  const definition = { name: 'run_code', output: {} }
  const runtime = { run() {} }
  const owner = createRuntimeBridgeOwner({
    seam: createExecutionSeam(runtime, 'codeRuntime'),
    ctx: { tools: { get: () => definition } },
    sessionConfig: { maxNestedRunCodeDepth: 4 },
    presentationGeneration: 'runtime-bridge-late-child-test',
    sessionId: agent => agent.id,
    toolSchemasForAgent: () => [],
  })
  const agent = { id: 'runtime-bridge-late-child', session: { events: [] } }
  const execution = owner.handleExecute(
    { name: 'run_code', callId: 'late-child', agent },
    () => runtime.run({ program: 'return 1', bindings: [] }),
  )
  await active.parentRunReady

  const firstChild = active.nestedRun({ code: 'return 1', description: 'first child' })
  await active.childStarted
  let disposalSettled = false
  const disposal = owner.dispose().then(() => { disposalSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposalSettled, false)
  assert.equal(active.firstDisposeCalls, 1)

  await assert.rejects(
    active.nestedRun({ code: 'return 2', description: 'late child' }),
    /PTC execution lease expired/,
  )
  assert.equal(active.instances.length, 2)
  assert.equal(active.startedChildren, 1)

  active.releaseLateChildDispose()
  await disposal
  active.releaseRuns[0]()
  await firstChild
  active.releaseParentRun()
  await execution
  assert.equal(active.firstDisposeCalls, 1)
})

test('runtime bridge retains a child whose first disposal fails and retries it',
  { timeout: 20_000 }, async t => {
    active.scenario = 'child-retry'
    active.firstFailure = new Error('nested child disposal failed')
    resetLateChild()
    t.after(() => {
      active.releaseParentRun()
      for (const release of active.releaseRuns) release()
    })

    const definition = { name: 'run_code', output: {} }
    const runtime = { run() {} }
    const owner = createRuntimeBridgeOwner({
      seam: createExecutionSeam(runtime, 'codeRuntime'),
      ctx: { tools: { get: () => definition } },
      sessionConfig: { maxNestedRunCodeDepth: 4 },
      presentationGeneration: 'runtime-bridge-child-retry-test',
      sessionId: agent => agent.id,
      toolSchemasForAgent: () => [],
    })
    const agent = { id: 'runtime-bridge-child-retry', session: { events: [] } }
    const execution = owner.handleExecute(
      { name: 'run_code', callId: 'child-retry', agent },
      () => runtime.run({ program: 'return 1', bindings: [] }),
    )
    await active.parentRunReady

    const nestedRun = active.nestedRun({ code: 'return 1', description: 'retry child' })
    await active.childStarted
    active.releaseRuns[0]()
    await assert.rejects(nestedRun, active.firstFailure)
    assert.equal(active.firstDisposeCalls, 1)

    await owner.dispose()
    assert.equal(active.firstDisposeCalls, 2)
    await owner.dispose()
    assert.equal(active.firstDisposeCalls, 2)
    active.releaseParentRun()
    await execution
  })

for (const [language, languageConfig] of [
  ['stateful', { bindingUpdates: 'stateful', legacyBindingSettings: false }],
  ['legacy', { legacyBindingSettings: true }],
]) {
  test(`terminal disposal drains an authorized ${language} native run_code handoff before restoring runtime.run`,
    { timeout: 20_000 }, async t => {
      active.scenario = 'native-handoff'
      resetLateChild()
      let releaseNativeRun
      const nativeRunGate = new Promise(resolve => { releaseNativeRun = resolve })
      let resolveNativeRunStarted
      const nativeRunStarted = new Promise(resolve => { resolveNativeRunStarted = resolve })
      t.after(() => {
        releaseNativeRun()
        active.releaseParentRun()
        for (const release of active.releaseRuns) release()
      })

      let upstreamCalls = 0
      const upstreamRun = () => {
        upstreamCalls += 1
        return { logs: [], value: 'upstream' }
      }
      const runtime = { run: upstreamRun }
      const nativeRunCode = async (args) => {
        resolveNativeRunStarted()
        await nativeRunGate
        return runtime.run({ program: args.code, bindings: [] })
      }
      const definition = { name: 'run_code', output: {} }
      const owner = createRuntimeBridgeOwner({
        seam: createExecutionSeam(runtime, 'codeRuntime'),
        ctx: { tools: { get: () => definition } },
        sessionConfig: { ...languageConfig, maxNestedRunCodeDepth: 4 },
        presentationGeneration: 'runtime-bridge-native-handoff-test',
        sessionId: agent => agent.id,
        toolSchemasForAgent: () => [],
      })
      const agent = { id: 'runtime-bridge-native-handoff', session: { events: [] } }
      const execution = owner.handleExecute(
        { name: 'run_code', callId: 'native-handoff', agent },
        () => runtime.run({
          program: 'return 1',
          bindings: [{ global: 'tools', functions: { run_code: nativeRunCode } }],
        }),
      )
      await active.parentRunReady

      const nestedRun = active.nestedRun({ code: 'return 1', description: 'delayed native child' })
      await nativeRunStarted
      const patchedRun = runtime.run
      let disposalSettled = false
      const disposal = owner.dispose().then(() => { disposalSettled = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(disposalSettled, false)
      assert.equal(runtime.run, patchedRun)

      releaseNativeRun()
      await assert.rejects(nestedRun, /PTC execution lease expired/)
      await disposal
      assert.equal(runtime.run, upstreamRun)
      assert.equal(upstreamCalls, 0)
      assert.equal(active.instances.length, 1)
      assert.equal(active.startedChildren, 0)

      active.releaseParentRun()
      await execution
    })
}
