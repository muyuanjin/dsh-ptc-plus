import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A host release that publishes no plugin-record writer.
 *
 * A session decision is a plugin record because a message would need the host's protected
 * surface head first. The writer is the host's own surface, so the substitute below is a
 * release that does not publish it: both owners must report that the decision cannot be
 * recorded instead of appending a surface node or answering a decision nothing stored.
 * The mock has to exist before the modules that bind the writer are loaded, which is why
 * this file imports them dynamically.
 */
const sessionModule = await import('@deepseek-ai/dsh-session')
const { default: sessionDefault, ...sessionExports } = sessionModule
mock.module('@deepseek-ai/dsh-session', { defaultExport: sessionDefault,
  namedExports: { ...sessionExports, appendPluginRecord: undefined } })
const { createSystemMessage } = await import('@deepseek-ai/dsh-llm')
const { createCapabilityEnvironment } = await import('../internal/capability-environment.js')
const { createUserBindingsOwner } = await import('../internal/user-bindings-owner.js')
const { createUserBindingsSnapshot } = await import('../internal/user-bindings.js')

const CONFIG = { capabilityManagementEnabled: true, capabilityBaseline: '[]', capabilityOverrides: '{}',
  capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
  capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 }
const config = overrides => ({ ...CONFIG, ...overrides })

// The Host exposes a session's committed log through its query surface; a fixture reads the
// session's own events instead of starting a projection service.
const historyOf = agent => async () => ({ events: agent.session.snapshotEvents() })

// A Cordis-shaped agent context: the owner registers one command per presented agent and
// receives it back here, which is how the `/binding` subcommands are invoked below.
function injectedAgentContext(services) {
  return {
    inject(names, callback) {
      const scope = {}
      for (const name of names) scope[name] = services[name]
      scope.effect = factory => factory()
      callback(scope)
      return { async dispose() {} }
    },
  }
}

test('a session capability choice reports a host that publishes no plugin-record writer', async t => {
  const session = sessionModule.Session.create('record-writer-absent-choice')
  const agent = { id: 'record-writer-absent-agent', session, signal: new AbortController().signal }
  const env = createCapabilityEnvironment({ ctx: {}, config: config(), toolSchemasForAgent: () => [],
    sessionHistoryForAgent: historyOf(agent) })
  t.after(() => env.dispose())
  // A choice is durable the moment it is made, so a release with no writer cannot take one.
  await assert.rejects(env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal),
    /ptc-plus: this DSH release publishes no plugin-record writer, so a session capability choice cannot be recorded/u)
  assert.deepEqual(session.snapshotEvents(), [], 'the refused choice leaves no surface node and no record behind')
})

test('a binding adoption decision reports a host that publishes no plugin-record writer', async t => {
  let command
  const session = sessionModule.Session.create('record-writer-absent-adoption')
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Host system') }, { surfaceOp: 'append' })
  const agent = { id: 'record-writer-absent-adoption-agent', session,
    ctx: injectedAgentContext({ commands: { register(definition) { command = definition; return () => {} } },
      skills: { register() { return () => {} } }, tools: { register() { return () => {} } } }) }
  const store = { filename: '/tmp/ptc-plus/bindings.json', snapshot: async () => createUserBindingsSnapshot({ entries: [
    { id: 'alpha', name: 'alphaHelpers', scope: 'namespace', purpose: '', enabled: true, source: 'export const one = 1' },
  ] }, 3) }
  const ctx = { agents: { list: () => [agent] },
    get: name => name === 'commands' ? {} : undefined,
    tools: { get: (name, scope) => name === 'run_code' && scope?.runCodeAvailable !== false ? { name: 'run_code' } : undefined },
    inject(services, callback) {
      // The owner mounts its RPC channel and its tool projection; neither answers adoption.
      if (services.length === 1 && services[0] === 'ptcPlusRpc') callback({ ptcPlusRpc: { register() { return () => {} } } })
      else if (services.length === 1 && services[0] === 'tools') callback({ tools: ctx.tools, on() { return () => {} } })
      return { dispose() {} }
    },
    effect: register => register() }
  const owner = createUserBindingsOwner(ctx, { enabled: true, store, cwd: process.cwd(),
    bindingAdoptionForAgent: () => undefined, maxWallMs: 1000, maxOutputBytes: 1024,
    maxOldGenerationSizeMb: 32, valueLimits: {} })
  t.after(() => owner.dispose())
  await owner.setDraftProjectionAvailable(true)
  await owner.setAgentPresentation(agent)
  const rejected = await command.handler({ agent, rawInput: 'skip alpha', signal: new AbortController().signal })
  // The receipt is the command's error text: a decision the log cannot prove is not claimed.
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text,
    /ptc-plus: this DSH release publishes no plugin-record writer, so a binding adoption decision cannot be recorded/u)
  assert.deepEqual(session.snapshotEvents().map(event => event.type), ['system/message'])
})
