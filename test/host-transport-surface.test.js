import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import {
  dispatchToolCall,
  hostToolExecutor,
  hostTransportUnreadable,
  resolveHostExport,
  sessionExecutionAvailable,
} from '../internal/host-tool-sdk.js'

const RUN_CODE = 'run_code'

function definition(overrides = {}) {
  return {
    name: RUN_CODE,
    description: 'Execute one program.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [] },
    async execute() {},
    ...overrides,
  }
}

/** A registry host: `get` answers and there is no executor surface at all. */
function registryHost(registered) {
  const calls = []
  return {
    calls,
    tools: {
      get(name, scope) {
        calls.push(name)
        return typeof registered === 'function' ? registered(name, scope) : registered
      },
      schemas: () => [],
    },
  }
}

/** An executor host: the registry reserves the name and the executor owns it. */
function executorHost(executor) {
  const probes = []
  return {
    probes,
    tools: {
      get: () => undefined,
      schemas: () => [],
      selectExecutor(scope) {
        probes.push(scope)
        return executor
      },
    },
  }
}

test('a registry that publishes the transport is read without probing an executor', () => {
  const registered = definition()
  const host = registryHost(registered)
  host.tools.selectExecutor = () => {
    throw new Error('the executor must never be consulted when the registry answers')
  }
  assert.equal(sessionExecutionAvailable(host.tools, { id: 'agent' }), true)
  assert.equal(host.calls.includes(RUN_CODE), true)
})

test('a registry answer without an output projection is still the answer', () => {
  // The caller reports the missing projection; the plugin must not go looking
  // for a different surface and silently patch something else.
  const registered = { name: RUN_CODE }
  const host = registryHost(registered)
  assert.equal(sessionExecutionAvailable(host.tools, { id: 'agent' }), true)
})

test('an executor that declares the transport publishes it through a zero-argument reader', () => {
  const transport = definition()
  class Executor {
    describe() { return { schemas: [], knownNames: [RUN_CODE] } }
    execute() { throw new Error('never dispatched in this test') }
    requireTransport() { return transport }
  }
  const host = executorHost(new Executor())
  assert.equal(sessionExecutionAvailable(host.tools, { id: 'agent' }), true)
})

test('an executor that does not declare the transport is never invoked', () => {
  const invoked = []
  class NativeExecutor {
    describe() { return { schemas: [], knownNames: ['read'] } }
    reset() { invoked.push('reset') }
    dispose() { invoked.push('dispose') }
    candidate() { invoked.push('candidate'); return definition() }
  }
  const host = executorHost(new NativeExecutor())
  assert.equal(sessionExecutionAvailable(host.tools, { id: 'agent' }), false)
  assert.deepEqual(invoked, [], 'no accessor may run on an executor that does not own the transport')
})

test('lifecycle accessors are never invoked, even on a transport-owning executor', () => {
  const invoked = []
  const transport = definition()
  class TransportExecutor {
    describe() { return { schemas: [], knownNames: [RUN_CODE] } }
    dispose() { invoked.push('dispose') }
    reset() { invoked.push('reset') }
    stop() { invoked.push('stop') }
    release() { invoked.push('release') }
    transport() { return transport }
  }
  assert.equal(sessionExecutionAvailable(executorHost(new TransportExecutor()).tools, {}), true)
  assert.deepEqual(invoked, [])
})

test('an undescribable executor is treated as owning nothing, not as a failure', () => {
  class BrokenExecutor {
    describe() { throw new Error('definitions are required') }
    transport() { return definition() }
  }
  assert.equal(sessionExecutionAvailable(executorHost(new BrokenExecutor()).tools, {}), false)
  assert.equal(hostToolExecutor(registryHost(undefined).tools, {}), undefined)
})

test('a throwing reader does not stop the search for the published definition', () => {
  const transport = definition()
  class PartialExecutor {
    describe() { return { schemas: [], knownNames: [RUN_CODE] } }
    requireTransport() { throw new Error('runtime generation is gone') }
    transport() { return transport }
  }
  assert.equal(sessionExecutionAvailable(executorHost(new PartialExecutor()).tools, {}), true)
})

test('a transport-owning executor that publishes no definition proves nothing', () => {
  // `describe` declares the reserved name, but both contracted readers answer with
  // a lookalike: half a definition, a non-callable renderer, a non-object. The
  // surface then answers "unknown", so no caller mistakes a lookalike for this
  // host's transport.
  class DeclaredExecutorWithoutDefinition {
    describe() { return { schemas: [], knownNames: [RUN_CODE] } }
    requireTransport() { return { name: RUN_CODE, execute() {} } }
    transport() { return RUN_CODE }
  }
  assert.equal(sessionExecutionAvailable(executorHost(new DeclaredExecutorWithoutDefinition()).tools, {}), false)
})

test('a declared transport this plugin cannot read is reported, not called away', () => {
  // The executor declares the reserved name and publishes the definition through a
  // reader that needs an argument this plugin does not have. Only the contracted
  // reader is asked: no other member is invoked, the miss is cached, and the gate
  // answers "declared but unreadable" instead of "this host has no executor".
  const invoked = []
  class ArgumentReader {
    describe() { return { schemas: [], knownNames: [RUN_CODE] } }
    requireTransport(scope) {
      invoked.push('requireTransport')
      if (scope === undefined) throw new TypeError('the reading scope is required')
      return definition()
    }
    cancel() { invoked.push('cancel') }
    flush() { invoked.push('flush') }
  }
  const host = executorHost(new ArgumentReader())
  assert.equal(sessionExecutionAvailable(host.tools, {}), false)
  assert.equal(hostTransportUnreadable(host.tools, {}), true)
  assert.deepEqual(invoked, ['requireTransport'])
  assert.equal(sessionExecutionAvailable(host.tools, {}), false)
  assert.equal(hostTransportUnreadable(host.tools, {}), true)
  assert.deepEqual(invoked, ['requireTransport', 'requireTransport'],
    'only the contracted reader is asked, and a scope that mounts it later can still answer')
  assert.equal(hostTransportUnreadable(registryHost(undefined).tools, {}), false)
})

test('a host that publishes no tool-schema renderers fails the load with its diagnostic', async () => {
  const resolved = await resolveHostExport(['@example/present', '@example/absent'], 'the tool schema renderers',
    candidate => typeof candidate.jsonSchemaToTs === 'function',
    async specifier => (specifier === '@example/present' ? { jsonSchemaToTs() {} } : undefined))
  assert.equal(resolved.specifier, '@example/present')
  await assert.rejects(() => resolveHostExport(['@example/absent'], 'the tool schema renderers',
    () => true, async () => undefined),
  /no host package provides the tool schema renderers/)
})

test('dispatch submits one accepted call on a registry host and one batch on an executor host', async () => {
  const execution = {
    callId: 'call-1', name: RUN_CODE, arguments: { code: 'return 1' },
    agent: { id: 'agent' }, signal: new AbortController().signal,
  }
  const settledCall = { isError: false, value: { logs: [] }, content: [] }
  const registryCalls = []
  const registry = { execute: async exec => { registryCalls.push(exec); return settledCall } }
  assert.equal(await dispatchToolCall(registry, execution), settledCall)
  assert.deepEqual(registryCalls, [execution])

  const batchCalls = []
  const executor = {
    selectExecutor: () => undefined,
    execute: async input => {
      batchCalls.push(input)
      return { results: [{ callId: 'call-1', result: settledCall }], additionalContexts: [], concluded: false }
    },
  }
  assert.equal(await dispatchToolCall(executor, execution), settledCall)
  assert.equal(batchCalls.length, 1)
  assert.deepEqual(batchCalls[0].calls, [{ id: 'call-1', name: RUN_CODE, arguments: '{"code":"return 1"}' }])
  assert.equal(batchCalls[0].agent, execution.agent)
  assert.equal(batchCalls[0].signal, execution.signal)

  const emptyBatch = { selectExecutor: () => undefined, execute: async () => ({ results: [] }) }
  await assert.rejects(() => dispatchToolCall(emptyBatch, execution), /no result for the requested call/)
})

test('nested executor dispatch preserves the real parent, root and step admission through Host policy', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  const parent = Symbol('active-root')
  const toolSet = {}
  const seen = []
  let executions = 0
  const transport = defineTool({ name: RUN_CODE, description: 'Run a derived cell.', parameters: {},
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute(_args, exec) { executions++; seen.push(exec); return 42 },
  })
  ctx.effect(() => ctx.tools.setExecutor({ describe: () => ({ schemas: [], knownNames: [RUN_CODE] }),
    requirePtcTransport: () => transport,
    execute() { throw new Error('a nested execution must not become a root batch') },
  }))
  ctx.on('tools/pre-execute', (exec, next) => { seen.push(exec); return next() })
  ctx.on('tools/result', exec => { seen.push(exec) })
  const execution = { callId: 'derived', rootCallId: 'original-root', parent, name: RUN_CODE,
    arguments: {}, toolSet, signal: new AbortController().signal }
  const result = await dispatchToolCall(ctx.tools, execution, ctx)
  assert.equal(result.isError, false)
  assert.equal(result.value, 42)
  assert.equal(seen.length, 3)
  for (const exec of seen) {
    assert.equal(exec.callId, execution.callId)
    assert.equal(exec.rootCallId, execution.rootCallId)
    assert.equal(exec.parent, parent)
    assert.equal(exec.toolSet, toolSet)
    assert.equal(typeof exec.token, 'symbol')
    assert.notEqual(exec.token, parent)
  }
  assert.equal(seen[0], seen[1])
  assert.equal(seen[1], seen[2])
  const disposeDenial = ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason: 'derived policy denied' }))
  const denied = await dispatchToolCall(ctx.tools, { ...execution, callId: 'denied' }, ctx)
  assert.equal(denied.isError, true)
  assert.match(JSON.stringify(denied), /derived policy denied/)
  assert.equal(executions, 1)
  disposeDenial()
  const controller = new AbortController()
  controller.abort()
  const cancelled = await dispatchToolCall(ctx.tools, { ...execution, callId: 'cancelled', signal: controller.signal }, ctx)
  assert.equal(cancelled.isError, true)
  assert.equal(executions, 1)
  await assert.rejects(() => dispatchToolCall(ctx.tools, execution), /requires its owning context/)
})
