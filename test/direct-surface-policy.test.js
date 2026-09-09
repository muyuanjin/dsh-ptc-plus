import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIG_DEFAULTS } from '../internal/config-spec.js'
import { createDirectSurfaceOwner } from '../internal/direct-surface-owner.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

function assembly() {
  return {
    sections: [{ name: 'tools:code-only', text: 'code-only' }],
    contexts: [],
    variables: {},
    tools: [{
      name: 'run_code',
      description: 'Execute one standalone program.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' }, description: { type: 'string' } },
        required: ['code'],
      },
    }],
  }
}

function createOwner(overrides = {}) {
  return createDirectSurfaceOwner({
    editTransport: { isInstalled: () => true, ensureInstalled() {} },
    runtimeConfig: { ...CONFIG_DEFAULTS },
    canonicalizeToolCalls: false,
    sessionId: agent => agent.id,
    toolSchemasForAgent: () => [],
    ...overrides,
  })
}

async function collect(stream) {
  const output = []
  for await (const chunk of stream) output.push(chunk)
  return output
}

test('a captured call policy outranks the request policy resolved from the signal', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'pinned-call-session' }
  const signalA = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal: signalA }, async () => assembly())
  assert.deepEqual(projected.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])

  const chunks = [
    { type: 'tool-call-delta', index: 0, id: 'pinned-call' },
    { type: 'block-end', block: { type: 'tool-call', id: 'pinned-call' } },
  ]
  const streamed = await collect(owner.stream(
    { sessionId: agent.id, signal: signalA, tools: projected.tools },
    async function* () { yield* chunks },
  ))
  assert.equal(streamed.length, chunks.length)

  owner.reconfigure({ ...CONFIG_DEFAULTS, autoDescribeRunCode: false })
  const signalB = new AbortController().signal
  await owner.assemble(assembly(), { agent, signal: signalB }, async () => assembly())

  const pinned = {
    name: 'run_code', callId: 'pinned-call', arguments: { code: 'return 1' }, agent, signal: signalB,
  }
  assert.equal(Object.hasOwn(owner.executionArguments(pinned), 'description'), true)

  const fresh = {
    name: 'run_code', callId: 'fresh-call', arguments: { code: 'return 2' }, agent, signal: signalB,
  }
  assert.equal(owner.executionArguments(fresh), fresh.arguments)
})

test('concurrent requests keep their own captured policy', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'concurrent-session' }
  const signalA = new AbortController().signal
  await owner.assemble(assembly(), { agent, signal: signalA }, async () => assembly())
  owner.reconfigure({ ...CONFIG_DEFAULTS, autoDescribeRunCode: false })
  const signalB = new AbortController().signal
  await owner.assemble(assembly(), { agent, signal: signalB }, async () => assembly())

  const withA = {
    name: 'run_code', callId: 'concurrent-a', arguments: { code: 'return 1' }, agent, signal: signalA,
  }
  const withB = {
    name: 'run_code', callId: 'concurrent-b', arguments: { code: 'return 2' }, agent, signal: signalB,
  }
  assert.equal(Object.hasOwn(owner.executionArguments(withA), 'description'), true)
  assert.equal(owner.executionArguments(withB), withB.arguments)
})

test('a missing signal falls back to the session request policy', async (t) => {
  const snapshot = createUserBindingsSnapshot({ entries: [] }, 1)
  const owner = createOwner({ userBindingsForAgent: async () => snapshot })
  t.after(() => owner.dispose())
  const agent = { id: 'no-signal-session' }
  await owner.assemble(assembly(), { agent }, async () => assembly())

  assert.equal(owner.executionUserBindings({ name: 'run_code', agent }), snapshot)
  assert.match(
    owner.executionRejection({ name: 'read', callId: 'no-signal-read', agent }).error.message,
    /not a direct PTC tool/,
  )
  assert.equal(owner.executionRejection({ name: 'run_code', callId: 'no-signal-run', agent }), undefined)
  assert.equal(
    owner.executionRejection({ name: 'read', callId: 'unknown-session-read', agent: { id: 'other' } }),
    undefined,
  )
})

test('each session resolves its own request policy', async (t) => {
  const bindings = new Map([
    ['session-one', createUserBindingsSnapshot({ entries: [] }, 1)],
    ['session-two', createUserBindingsSnapshot({ entries: [] }, 2)],
  ])
  const owner = createOwner({ userBindingsForAgent: async agent => bindings.get(agent.id) })
  t.after(() => owner.dispose())
  const first = { id: 'session-one' }
  const second = { id: 'session-two' }
  await owner.assemble(assembly(), { agent: first }, async () => assembly())
  await owner.assemble(assembly(), { agent: second }, async () => assembly())

  assert.equal(owner.executionUserBindings({ name: 'run_code', agent: first }), bindings.get('session-one'))
  assert.equal(owner.executionUserBindings({ name: 'run_code', agent: second }), bindings.get('session-two'))
  assert.equal(
    owner.executionUserBindings({ name: 'run_code', agent: { id: 'session-unknown' } }),
    undefined,
  )
})

test('argumentDiagnostic resolves the same policy for its context choice', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const tolerant = { id: 'diagnostic-tolerant' }
  await owner.assemble(assembly(), { agent: tolerant }, async () => assembly())
  owner.reconfigure({ ...CONFIG_DEFAULTS, autoDescribeRunCode: false })
  const strict = { id: 'diagnostic-strict' }
  await owner.assemble(assembly(), { agent: strict }, async () => assembly())

  const result = { isError: true, error: { message: 'missing required property "description"' } }
  const tolerantResult = owner.argumentDiagnostic({
    name: 'run_code', callId: 'diagnostic-tolerant-call', arguments: { code: 'return 1', description: 5 }, agent: tolerant,
  }, result)
  assert.match(tolerantResult.additionalContexts[0].text, /nested native-tool argument/)

  const strictResult = owner.argumentDiagnostic({
    name: 'run_code', callId: 'diagnostic-strict-call', arguments: { code: 'return 1' }, agent: strict,
  }, result)
  assert.match(strictResult.additionalContexts[0].text, /outer transport arguments/)
})
