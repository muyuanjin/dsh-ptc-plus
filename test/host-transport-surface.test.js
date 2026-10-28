import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dispatchToolCall,
  hostToolExecutor,
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

test('a throwing accessor does not stop the search for the published definition', () => {
  const transport = definition()
  class PartialExecutor {
    describe() { return { schemas: [], knownNames: [RUN_CODE] } }
    unavailable() { throw new Error('runtime generation is gone') }
    transport() { return transport }
  }
  assert.equal(sessionExecutionAvailable(executorHost(new PartialExecutor()).tools, {}), true)
})

test('a transport-owning executor that publishes no definition proves nothing', () => {
  // `describe` declares the reserved name, but every zero-argument reader returns
  // a lookalike: half a definition, a non-callable renderer, a non-object, or
  // nothing at all. The surface then answers "unknown", so no caller mistakes a
  // lookalike for this host's transport.
  class DeclaredExecutorWithoutDefinition {
    describe() { return { schemas: [], knownNames: [RUN_CODE] } }
    halfDefinition() { return { name: RUN_CODE, execute() {} } }
    rendererWithoutCall() { return { name: RUN_CODE, execute() {}, output: { schema: {}, render: [] } } }
    outputWithoutRenderer() { return { name: RUN_CODE, execute() {}, output: { schema: {} } } }
    scalar() { return RUN_CODE }
    empty() { return undefined }
  }
  assert.equal(sessionExecutionAvailable(executorHost(new DeclaredExecutorWithoutDefinition()).tools, {}), false)
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
