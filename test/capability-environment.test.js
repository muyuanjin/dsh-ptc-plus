import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { McpResourceRuntime } from '@deepseek-ai/dsh-mcp-resources'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as skillTool from '@deepseek-ai/dsh-tool-skill'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createCapabilityEnvironment } from '../internal/capability-environment.js'
import { capabilityInspect, capabilitySearch, toolCapabilityMetadata } from '../internal/program-bindings.js'
import { appendOnlySession } from './plugin-fixture.js'

const config = overrides => ({ capabilityManagementEnabled: true,
  capabilityBaseline: '[]', capabilityOverrides: JSON.stringify(overrides ?? {}),
  capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
  capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 })
const schema = name => ({ name, description: `Owner contract for ${name}.`, parameters: { type: 'object' }, output: { type: 'string' } })
const sections = [{ name: 'tools:sdk', text: 'native sdk' }, { name: 'tool:closed_capability', text: 'closed guidance' }]
const agentFor = (session, id = session.id) => ({ id, session, signal: new AbortController().signal })

test('empty Host instructions preserve tool and MCP contracts, ownership, restoration and refresh', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  t.after(() => ctx.fiber.dispose())
  let instructions = ''
  for (const name of ['probe', 'mcp__docs__search', 'read_mcp_resource']) {
    ctx.effect(() => ctx.tools.register(defineTool({ name, description: `Contract for ${name}.`, parameters: {},
      output: { schema: { type: 'string' }, render: () => [] }, execute: async () => name })))
  }
  for (const name of ['tool:probe', 'mcp:docs']) {
    ctx.effect(() => ctx.systemPrompt.section({ name, order: 10, text: () => instructions }))
  }
  ctx.effect(() => ctx.systemPrompt.section({ name: 'mcp-resource-servers', order: 20,
    text: 'as the server argument: ["docs"].' }))
  const agent = agentFor(Session.create('empty-host-instructions'))
  agent.runMaintenance = operation => operation(agent.signal)
  const options = { ctx, config: config({ 'tools.probe': 'full', 'tools.mcp__docs__search': 'full', 'mcp.docs': 'full' }),
    toolSchemasForAgent: target => ctx.tools.sdkSchemas(target) }
  const env = createCapabilityEnvironment(options)
  t.after(() => env.dispose())
  const assembled = async () => (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
  const original = await acceptPreparation(env, agent, await assembled())
  for (const id of ['tools.probe', 'tools.mcp__docs__search', 'mcp.docs']) {
    assert.deepEqual(original.snapshot.capabilities.find(item => item.id === id).dependencies, [])
    assert.ok(original.snapshot.plan.entries.some(item => item.id === id && item.selection === 'full'))
  }
  assert.equal(original.snapshot.capabilities.find(item => item.id === 'tools.mcp__docs__search').mcpServer, 'docs')
  assert.match(original.snapshot.plan.catalogText, /Promise<string>/)
  assert.doesNotMatch(original.snapshot.plan.catalogText, /### dependency:/)
  const schemas = ctx.tools.sdkSchemas(agent)
  const metadata = env.toolMetadata(agent, toolCapabilityMetadata(schemas), schemas)
  assert.deepEqual(capabilityInspect(metadata, ['tools.mcp__docs__search']).symbols[0].dependencies, [])
  assert.deepEqual(env.metadata(agent).find(item => item.namespace === 'mcp').members[0].dependencies, [])
  const restored = createCapabilityEnvironment(options)
  t.after(() => restored.dispose())
  assert.deepEqual((await restored.prepare(agent, await assembled())).snapshot, original.snapshot)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    await env.prepare(context.agent, assembly.sections)
    return assembly
  })
  instructions = ' \n\t '
  await env.refresh(agent, await assembled(), agent.signal)
  assert.equal(env.stateFor(agent).snapshot.plan.catalogText, original.snapshot.plan.catalogText)
  instructions = 'Exact owner instructions.'
  await env.refresh(agent, await assembled(), agent.signal)
  const updated = env.stateFor(agent).snapshot
  assert.deepEqual(updated.capabilities.find(item => item.id === 'mcp.docs').dependencies,
    [{ id: 'mcp:docs', text: instructions }])
  assert.deepEqual(updated.capabilities.find(item => item.id === 'tools.probe').dependencies,
    [{ id: 'tool:probe', text: instructions }])
  assert.equal(updated.plan.catalogText.match(/### dependency:mcp:docs/g).length, 1)
  assert.match(updated.plan.catalogText, /Exact owner instructions\./)
  instructions = ''
  env.reconfigure(config({ 'mcpServers.docs': 'closed' }))
  await env.refresh(agent, await assembled(), agent.signal)
  assert.deepEqual(env.visibleSchemas(agent, schemas).map(item => item.name), ['probe'])
  assert.deepEqual(env.metadata(agent).find(item => item.namespace === 'mcp').members, [])
  const malformed = createCapabilityEnvironment(options)
  t.after(() => malformed.dispose())
  await assert.rejects(() => malformed.prepare(agentFor(Session.create('malformed-host-instructions')),
    [{ name: 'tool:probe', text: undefined }]), /dependency contract must be a non-empty string/)
})

async function acceptPreparation(env, agent, sections) {
  const state = await env.prepare(agent, sections)
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  if (!(agent.session.snapshotEvents?.() ?? agent.session.events ?? []).some(event => event.type === 'system/message')) {
    agent.session.append('system/message', { turn: 1, step: 1,
      message: createSystemMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Fixture system prompt.' }] }) },
      { surfaceOp: 'append', protected: true })
  }
  for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return state
}

test('real ToolRuntime preserves SDK output contracts and detects output-only changes during description recovery', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  t.after(() => ctx.fiber.dispose())
  const output = { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: {
    type: 'object', additionalProperties: false, properties: { number: { type: 'integer' }, text: { type: 'string' } }, required: ['number', 'text'],
  } } }, required: ['lines'] }
  const definition = resultSchema => defineTool({ name: 'read', description: 'Read numbered file lines.', parameters: { file_path: { type: 'string', required: true } },
    output: { schema: resultSchema, render: () => [] }, execute: async () => ({ lines: [] }) })
  const initialDefinition = definition({ type: 'object', additionalProperties: false, properties: { lines: { type: 'array', required: true, items: {
    type: 'object', additionalProperties: false, properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } },
  } } } })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'readExtra', description: 'Read another file.', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' })))
  const unregister = ctx.tools.register(initialDefinition)
  ctx.effect(() => unregister)
  const agent = agentFor(Session.create('sdk-output-description-recovery'))
  agent.runMaintenance = operation => operation(agent.signal)
  const modelSchemas = JSON.stringify(ctx.tools.schemas(agent))
  assert.equal(Object.hasOwn(ctx.tools.schemas(agent)[0], 'output'), false)
  const env = createCapabilityEnvironment({ ctx, config: config({ 'tools.read': 'full' }),
    toolSchemasForAgent: target => ctx.tools.sdkSchemas(target) })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agent, [])
  const capability = state.snapshot.capabilities.find(item => item.id === 'tools.read')
  assert.deepEqual(capability.schema.output, output)
  assert.match(capability.contract, /file_path: string/)
  assert.match(capability.contract, /lines:/)
  assert.match(capability.contract, /number: number/)
  assert.match(capability.contract, /text: string/)
  assert.doesNotMatch(capability.contract, /Promise<unknown>/)
  const oldSchemas = ctx.tools.sdkSchemas(agent)
  const oldMetadata = env.toolMetadata(agent, toolCapabilityMetadata(oldSchemas), oldSchemas)
  const oldPage = capabilitySearch(oldMetadata, { query: 'read', limit: 1 })
  assert.ok(oldPage.cursor)
  const invocation = { agent, name: 'read', token: {} }
  env.admitted(invocation)
  env.dispatched(invocation, { isError: false })
  const planEvent = agent.session.snapshotEvents().find(event => event.data?.id === state.message.id)
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted plan.' }] }),
    { surfaceOp: { op: 'replace', startSeq: planEvent.seq, endSeq: planEvent.seq }, sourceEventSeqs: [planEvent.seq] })
  const step = () => env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.match((await step()).messages.find(message => message.source?.form === 'capability-descriptions').content[0].text, /lines:/)
  unregister()
  ctx.effect(() => ctx.tools.register(definition({ type: 'string' })))
  assert.equal(JSON.stringify(ctx.tools.schemas(agent)), modelSchemas, 'An output-only change leaves model-facing schemas byte-stable.')
  assert.equal((await step()).messages.some(message => message.source?.form === 'capability-descriptions'), false,
    'The recorded output contract must not be restored as the current API after an output-only change.')
  const currentSchemas = ctx.tools.sdkSchemas(agent)
  const currentMetadata = env.toolMetadata(agent, toolCapabilityMetadata(currentSchemas), currentSchemas)
  const match = capabilitySearch(currentMetadata, { query: 'tools.read' }).matches.find(item => item.symbol === 'tools.read').contract
  assert.deepEqual(match.returns, { type: 'string' })
  assert.match(match.contract, /Promise<string>/)
  assert.notEqual(match.revision, capability.revision)
  const inspected = capabilityInspect(currentMetadata, ['tools.read']).symbols[0]
  assert.deepEqual(inspected.returns, match.returns)
  assert.equal(inspected.contract, match.contract)
  assert.equal(inspected.revision, match.revision)
  assert.throws(() => capabilitySearch(currentMetadata, { query: 'read', limit: 1, cursor: oldPage.cursor }), /catalog\/query changed/)
  assert.deepEqual(env.toolMetadata(agent, toolCapabilityMetadata(oldSchemas), oldSchemas), oldMetadata,
    'Metadata remains derived from the exact caller snapshot even if the live registration has changed.')
  const refreshed = await env.refresh(agent)
  assert.notEqual(refreshed.snapshot.capabilities.find(item => item.id === 'tools.read').revision, capability.revision)
  assert.match(refreshed.snapshot.capabilities.find(item => item.id === 'tools.read').contract, /Promise<string>/)
})

test('first capability plan remains provisional across rejected and aborted steps and enters once', async () => {
  const agent = agentFor(Session.create('provisional-capability-plan'))
  const env = createCapabilityEnvironment({ ctx: {}, config: config(), toolSchemasForAgent: () => [schema('probe')] })
  const state = await env.prepare(agent, sections)
  assert.equal(agent.session.snapshotEvents().length, 0)
  assert.equal(env.describe(agent).publication, 'pending')
  const reject = { kind: 'reject', messages: [] }
  assert.equal(await env.preStep({ agent, signal: agent.signal }, async () => reject), reject)
  const cancellation = new AbortController()
  cancellation.abort()
  const cancelled = await env.preStep({ agent, signal: cancellation.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(cancelled.messages.length, 0)
  assert.equal(agent.session.snapshotEvents().length, 0)
  const restored = createCapabilityEnvironment({ ctx: {}, config: config({ 'tools.probe': 'closed' }), toolSchemasForAgent: () => [schema('probe')] })
  const cold = await restored.prepare(agentFor(Session.create(agent.session.id, [], agent.session.header)), sections)
  assert.equal(cold.snapshot.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'closed')
  const entered = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(entered.messages.map(message => message.id), [state.message.id])
  assert.equal(env.describe(agent).publication, 'pending', 'An enter proposal has not been committed by the Host.')
  await acceptPreparation(env, agent, sections)
  assert.equal(env.describe(agent).publication, 'accepted')
  const next = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(next.messages.some(message => message.id === state.message.id), false)
  assert.equal(agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan').length, 1)
})

test('real AgentLoop protects its first system head before accepting one capability plan and strict restoration', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false,
    personaPrefix: 'Fixture system prompt.', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'mcp__docs__probe', description: 'MCP probe.', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'probe' })))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'mcp:docs', order: 10, text: '' }))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'tool:mcp__docs__probe', order: 11, text: '' }))
  const errors = []
  ctx.on('agent/error', payload => errors.push(payload.error))
  let failPreparation = true
  let requests = 0
  async function* stream() {
    requests++
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.provide('llm', { async prepareCall(requestConfig) {
    if (failPreparation) throw new Error('Fixture request preparation failed.')
    return { config: requestConfig, stream, adapterDefaults: {} }
  }, stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: target => ctx.tools.sdkSchemas(target) })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    await env.prepare(context.agent, assembly.sections)
    return { ...assembly, sections: env.projectSections(context.agent, assembly.sections) }
  })
  ctx.on('agent/pre-step', (payload, next) => env.preStep(payload, next), { prepend: true })
  const owned = await ctx.agents.create({ sessionId: 'first-capability-plan-real-loop',
    meta: { cwd: process.cwd(), delegationDepth: 0 }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(async () => { await owned.dispose(); await env.dispose(); await ctx.fiber.dispose() })
  const agent = owned.agent
  const run = async () => {
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'probe' }] }), 'next-turn', true)
    await agent.whenIdle()
  }
  await run()
  assert.equal(errors.length, 1)
  assert.equal(requests, 0)
  assert.equal(agent.session.snapshotEvents().some(event => event.data?.source?.form === 'capability-plan'), false)
  await env.refresh(agent)
  assert.equal(env.describe(agent).publication, 'pending')
  assert.equal(agent.session.snapshotEvents().some(event => event.data?.source?.form === 'capability-plan'), false)
  failPreparation = false
  await run()
  await run()
  assert.equal(requests, 2)
  const events = agent.session.snapshotEvents()
  const firstSurface = events.find(event => event.surfaceOp)
  assert.equal(firstSurface.type, 'system/message')
  const plans = events.filter(event => event.type === 'user/message' && event.data?.source?.form === 'capability-plan')
  assert.equal(plans.length, 1)
  assert.ok(firstSurface.seq < plans[0].seq)
  assert.equal(env.describe(agent).publication, 'accepted')
  const restore = sessionFormatCatalog.createRestore(
    sessionFormatCatalog.encodeCurrentHeader(agent.session.header, agent.session.inheritedEventCount),
    { validation: 'current', recovery: 'strict' })
  for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  const artifact = restore.finish()
  assert.equal(artifact.events.filter(event => event.data?.source?.form === 'capability-plan').length, 1)
})

test('actual first requests share pre-task plans across sessions and preserve pinned prefixes across statistics', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false,
    personaPrefix: 'Fixture system prompt.', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  const requests = []
  async function* stream(options) {
    requests.push(options.messages)
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.provide('llm', { async prepareCall(requestConfig) {
    return { config: requestConfig, stream, adapterDefaults: {} }
  }, stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  let selected = 'a'
  const schemas = ['a', 'b', 'pinned'].map(schema)
  const store = { available() {}, coverage: async () => Object.fromEntries(schemas.map(item => [`tools.${item.name}`, {
    revision: createHash('sha256').update(JSON.stringify(item)).digest('hex'),
    workspace: { status: 'usable', windowSize: 10, eligible: 3, used: item.name === selected ? 3 : 0 },
  }])) }
  const env = createCapabilityEnvironment({ ctx, config: { ...config({ 'tools.pinned': 'full' }),
    capabilityStatistics: '{"enabled":true,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' },
  toolSchemasForAgent: () => schemas, store })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    await env.prepare(context.agent, assembly.sections)
    return { ...assembly, sections: env.projectSections(context.agent, assembly.sections) }
  })
  ctx.on('agent/pre-step', (payload, next) => env.preStep(payload, next), { prepend: true })
  const owned = []
  t.after(async () => { for (const item of owned) await item.dispose(); await env.dispose(); await ctx.fiber.dispose() })
  const run = async (agent, text) => {
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), 'next-turn', true)
    await agent.whenIdle()
  }
  for (const task of ['different task one', 'different task two', 'different task three']) {
    if (owned.length === 2) selected = 'b'
    const item = await ctx.agents.create({ sessionId: `cache-prefix-${owned.length}`,
      meta: { cwd: process.cwd(), delegationDepth: 0 }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    owned.push(item)
    await run(item.agent, task)
  }
  const content = message => message.content.map(part => part.text ?? '').join('')
  const prefix = messages => messages.slice(0, messages.findIndex(message => message.source?.kind === 'user')).map(content)
  assert.deepEqual(prefix(requests[0]), prefix(requests[1]), 'Different tasks must diverge only after the full initial plan.')
  const plans = requests.slice(0, 3).map(messages => messages.find(message => message.source?.form === 'capability-plan'))
  assert.ok(plans.every(Boolean))
  const stable = content(plans[0]).split('\n\n### tools.a\n')[0]
  assert.match(stable, /### tools.pinned/)
  assert.ok(content(plans[2]).startsWith(stable + '\n\n### tools.b\n'))
  assert.equal(prefix(requests[0])[0], prefix(requests[2])[0], 'Statistics must not change the system head.')
  await run(owned[0].agent, 'continue after statistics changed')
  assert.equal(content(requests[3].find(message => message.source?.form === 'capability-plan')), content(plans[0]))
  await env.refresh(owned[0].agent)
  await run(owned[0].agent, 'continue after explicit refresh')
  const refreshed = requests[4]
  assert.equal(content(refreshed.find(message => message.source?.form === 'capability-plan')), content(plans[0]))
  assert.ok(refreshed.findLastIndex(message => message.source?.form === 'capability-plan')
    > refreshed.findIndex(message => content(message) === 'continue after statistics changed'))
})

test('unknown local prototype format is rejected as recovery evidence without a second renderer', async () => {
  const agent = agentFor(Session.create('unsupported-local-capability-format'))
  const env = createCapabilityEnvironment({ ctx: {}, config: config({ 'tools.pinned': 'full' }),
    toolSchemasForAgent: () => [schema('a'), schema('pinned')] })
  const state = await acceptPreparation(env, agent, [])
  const snapshot = JSON.parse(JSON.stringify(state.snapshot))
  snapshot.schema = 'ptc-capability-environment/v2'
  const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
  const original = events.find(event => event.data?.source?.form === 'capability-plan')
  original.data.source.snapshot = snapshot
  original.data.source.digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  const warnings = []
  const restored = createCapabilityEnvironment({ ctx: { logger: { warn: message => warnings.push(message) } },
    config: config(), toolSchemasForAgent: () => [] })
  const reloaded = Session.create(agent.session.id, events, agent.session.header)
  const result = await restored.prepare(agentFor(reloaded), [])
  assert.equal(result.snapshot.schema, 'ptc-capability-environment/v1')
  assert.equal(result.snapshot.plan.enabled, false)
  assert.match(warnings[0], /damaged session capability plan/)
  assert.notEqual(result.message.id, state.message.id)
})

test('initial plan precedes the task even when the protected system head is already committed', async () => {
  const agent = agentFor(Session.create('system-only-capability-prefix'))
  agent.session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage({ content: [{ type: 'text', text: 'system' }] }) }, { surfaceOp: 'append', protected: true })
  const env = createCapabilityEnvironment({ ctx: {}, config: config(), toolSchemasForAgent: () => [schema('a')] })
  await env.prepare(agent, [])
  assert.equal(agent.session.snapshotEvents().length, 1, 'Preparation must not publish a plan before admission.')
  const task = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] })
  const result = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [task] }))
  assert.equal(result.messages[0].source.form, 'capability-plan')
  assert.equal(result.messages[1], task)
})

test('settings catalog reads current owner inventory while disabled plans and model history remain unchanged', async () => {
  const agent = agentFor(Session.create('capability-settings-inventory'))
  let schemas = [schema('a'), schema('b')]
  const env = createCapabilityEnvironment({ ctx: { agents: { list: () => [agent] } },
    config: { ...config(), capabilityManagementEnabled: false }, toolSchemasForAgent: () => schemas })
  await env.prepare(agent, [])
  const before = JSON.stringify(agent.session.snapshotEvents())
  assert.deepEqual((await env.describeCatalog()).map(entry => entry.id), ['tools.a', 'tools.b'])
  schemas = [schema('new')]
  const entries = await env.describeCatalog()
  assert.deepEqual(entries, [{ id: 'tools.new', name: 'new', category: 'tool', description: 'Owner contract for new.', source: { kind: 'host' } }])
  assert.equal(JSON.stringify(agent.session.snapshotEvents()), before)
  assert.equal(env.describe(agent).effective.enabled, false)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(env.describeCatalog(controller.signal), /abort/i)
})

test('settings can list a code agent before its first model step without freezing or publishing a plan', async () => {
  const agent = agentFor(Session.create('capability-settings-before-first-step'))
  const env = createCapabilityEnvironment({ ctx: { agents: { list: () => [agent] } }, config: config(),
    toolSchemasForAgent: () => [schema('run_code'), schema('read')] })
  assert.deepEqual((await env.describeCatalog()).map(entry => entry.id), ['tools.read'])
  assert.equal(env.describe(agent).effective, null)
  assert.deepEqual(agent.session.snapshotEvents(), [])
})

test('refresh targets expose only live PTC identities without reading or preparing frozen plans when management is off', () => {
  const code = agentFor(Session.create('refresh-code'))
  const native = agentFor(Session.create('refresh-native'))
  let live = [code, native]
  let ptc = true
  const env = createCapabilityEnvironment({ ctx: { agents: { list: () => live } },
    config: { ...config(), capabilityManagementEnabled: false }, toolSchemasForAgent: () => [],
    modelSchemasForAgent: agent => agent === code && ptc ? [schema('run_code')] : [schema('read')] })
  assert.deepEqual(env.describeTargets(), [{ sessionId: 'refresh-code' }])
  assert.equal(env.canRefresh(native), false)
  assert.equal(env.describe(code).effective, null)
  assert.deepEqual(code.session.snapshotEvents(), [])
  ptc = false
  assert.deepEqual(env.describeTargets(), [])
  ptc = true; live = []
  assert.deepEqual(env.describeTargets(), [])
})

test('settings source metadata follows Skill providers and captured MCP ownership without changing frozen model contracts', async t => {
  const owner = new Context()
  new SkillRegistry(owner)
  let bodies = 0
  owner.effect(() => owner.skills.registerProvider(() => ({ name: 'filesystem',
    list: async () => [{ name: 'image-design', description: 'Generate a UI design', source: 'user-agents',
      provider: 'filesystem', rank: 100, locator: 'image-design', invocation: { modelInvocable: true, userInvocable: true } }],
    get: async candidate => { bodies++; return { ...candidate, content: 'Skill body' } },
  })))
  const agent = agentFor(Session.create('settings-source-metadata'))
  const scope = createScope(owner, agent)
  owner.effect(() => owner.provide('agents', { list: () => [agent] }))
  const ctx = owner
  const env = createCapabilityEnvironment({ ctx, config: config(),
    toolSchemasForAgent: () => [schema('run_code'), schema('read'), schema('mcp__docs__search')] })
  t.after(async () => { await env.dispose(); await scope.dispose(); await owner.fiber.dispose() })
  const first = await env.describeCatalog()
  assert.deepEqual(first.find(entry => entry.id === 'skills.image-design').source,
    { kind: 'skill', bucket: 'user-agents', provider: 'filesystem' })
  assert.equal(first.find(entry => entry.id === 'skills.image-design').name, 'image-design')
  assert.deepEqual(first.find(entry => entry.id === 'tools.mcp__docs__search').source, { kind: 'host' },
    'A tool name alone cannot prove its MCP source.')
  assert.equal(env.describe(agent).effective, null)
  const state = await env.prepare(agent, [{ name: 'mcp:docs', text: 'Docs server owner instructions' }])
  const frozen = JSON.stringify(state.snapshot)
  const catalog = await env.describeCatalog()
  assert.deepEqual(catalog.find(entry => entry.id === 'tools.mcp__docs__search').source, { kind: 'mcp', server: 'docs' })
  assert.deepEqual(catalog.find(entry => entry.id === 'tools.read').source, { kind: 'host' })
  assert.equal(JSON.stringify(state.snapshot), frozen)
  assert.equal(Object.hasOwn(state.snapshot.capabilities.find(entry => entry.id === 'skills.image-design'), 'source'), false)
  assert.equal(bodies, 0)
  assert.deepEqual(agent.session.snapshotEvents(), [])
})


test('anonymous preparation preserves disabled management and identifies the enabled Session requirement', async () => {
  const agent = { id: 'anonymous' }
  const disabled = createCapabilityEnvironment({ ctx: {}, config: { capabilityManagementEnabled: false }, toolSchemasForAgent: () => [] })
  assert.equal(await disabled.prepare(agent, sections), undefined)
  assert.deepEqual(disabled.projectMembers(agent, ['kept']), ['kept'])
  const enabled = createCapabilityEnvironment({ ctx: {}, config: config(), toolSchemasForAgent: () => [] })
  await assert.rejects(enabled.prepare(agent, sections), /capability management requires an agent Session/)
})

test('frozen capability plan removes closed scope-owned members from preparation and bindings', async () => {
  const session = appendOnlySession('capability-environment-closed')
  const agent = agentFor(session)
  const env = createCapabilityEnvironment({ ctx: {}, config: config({ 'tools.closed_capability': 'closed' }), toolSchemasForAgent: () => [schema('closed_capability'), schema('kept_capability')] })
  const state = await acceptPreparation(env, agent, sections)
  assert.equal(state.snapshot.plan.entries.find(entry => entry.id === 'tools.closed_capability').selection, 'closed')
  assert.deepEqual(env.projectMembers(agent, ['closed_capability', 'kept_capability']), ['kept_capability'])
  assert.equal(env.visibleSchemas(agent, [schema('closed_capability'), schema('kept_capability')]).map(item => item.name).join(','), 'kept_capability')
  assert.doesNotMatch(env.projectSections(agent, sections).map(section => section.text).join('\n'), /closed guidance/)
})

test('restoration uses the recorded plan after saved configuration changes', async () => {
  const session = Session.create('capability-environment-restore')
  const first = agentFor(session)
  const initial = createCapabilityEnvironment({ ctx: {}, config: config({ 'tools.old': 'closed' }), toolSchemasForAgent: () => [schema('old'), schema('new')] })
  await acceptPreparation(initial, first, sections)
  const changed = createCapabilityEnvironment({ ctx: {}, config: config({ 'tools.new': 'closed' }), toolSchemasForAgent: () => [schema('old'), schema('new')] })
  const reloaded = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header)
  assert.equal(reloaded.deriveMessages().find(message => message.source?.form === 'capability-plan').source.form, 'capability-plan')
  const restored = await changed.prepare(agentFor(reloaded), sections)
  assert.equal(restored.snapshot.plan.entries.find(entry => entry.id === 'tools.old').selection, 'closed')
  assert.equal(restored.snapshot.plan.entries.find(entry => entry.id === 'tools.new').selection, 'on-demand')
  assert.deepEqual(changed.projectMembers(agentFor(session), ['old', 'new']), ['new'])
})

test('description recovery survives Session restoration and follows the ordered surface with complete dependencies', async () => {
  const session = Session.create('capability-descriptions-restore')
  const agent = agentFor(session)
  const guidance = [{ name: 'tool:probe', text: 'The owner requires exact UTF-8 path spelling.' }]
  const make = () => createCapabilityEnvironment({ ctx: {}, config: config(), toolSchemasForAgent: () => [schema('probe')] })
  const first = make()
  await acceptPreparation(first, agent, guidance)
  first.explored(agent, { matches: [{ symbol: 'tools.probe' }] })
  const invocation = { agent, name: 'probe', token: {} }
  first.admitted(invocation)
  first.dispatched(invocation, { isError: false })
  const result = first.complete({ agent }, { isError: false, value: 42 })
  const call = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'explore', arguments: '{}' })
  const message = createToolResultMessage({ callId: 'explore', isError: false, content: [{ type: 'text', text: first.stateFor(agent).snapshot.capabilities[0].contract + '\n' + guidance[0].text }] })
  const completion = session.append('tool/result', { turn: 1, step: 1, message, meta: result.meta }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const reloaded = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header)
  const second = make()
  const target = agentFor(reloaded)
  await second.prepare(target, guidance)
  const step = () => second.preStep({ agent: target, signal: target.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal((await step()).messages.some(item => item.source.form === 'capability-descriptions'), false)
  const compacted = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prior work compacted.' }] })
  reloaded.append('user/message', compacted, { surfaceOp: { op: 'replace', startSeq: completion.seq, endSeq: completion.seq }, sourceEventSeqs: [completion.seq] })
  const recovery = (await step()).messages.find(item => item.source.form === 'capability-descriptions')
  assert.match(recovery.content[0].text, /tools.probe/)
  assert.match(recovery.content[0].text, /exact UTF-8 path spelling/)
  reloaded.append('user/message', recovery, { surfaceOp: 'append' })
  assert.equal((await step()).messages.some(item => item.source.form === 'capability-descriptions'), false)
  assert.equal(result.value, 42)
})

test('shared loaders have no executable member when their selector domains are empty', async () => {
  const agent = agentFor(Session.create('empty-selector-domain'))
  const env = createCapabilityEnvironment({ ctx: { skills: { snapshot: async () => ({ complete: true, skills: [] }) } },
    config: config(), toolSchemasForAgent: () => ['skill', 'read_mcp_resource', 'list_mcp_resources', 'kept'].map(schema) })
  await acceptPreparation(env, agent, [])
  assert.deepEqual(env.projectMembers(agent, ['skill', 'read_mcp_resource', 'list_mcp_resources', 'kept']), ['kept'])
  assert.deepEqual(env.visibleSchemas(agent, ['skill', 'read_mcp_resource', 'kept'].map(schema)).map(item => item.name), ['kept'])
})

test('closed Skills disappear from host invocation without reading bodies and refresh sees original providers', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  new SkillRegistry(ctx)
  skillTool.apply(ctx)
  const agent = agentFor(Session.create('closed-skill-session'))
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  let bodyReads = 0
  scope.ctx.effect(() => scope.ctx.skills.registerProvider(() => ({ name: 'probe-provider',
    list: async () => ['closed-skill', 'open-skill'].map(name => ({ name, description: `${name} owner summary`,
      invocation: { modelInvocable: true, userInvocable: true }, provider: 'probe-provider', source: 'fixture', rank: 250, locator: name })),
    get: async entry => { bodyReads++; return { ...entry, content: `BODY ${entry.name}` } },
  })))
  const env = createCapabilityEnvironment({ ctx, config: config({ 'skills.closed-skill': 'closed' }),
    toolSchemasForAgent: target => ctx.tools.sdkSchemas(target) })
  t.after(async () => { await env.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    await env.prepare(context.agent, assembly.sections)
    return assembly
  })
  ctx.on('agent/pre-step', (payload, next) => env.preStep(payload, next), { prepend: true })
  const invoke = async name => {
    const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `/${name} task` }] })]
    return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: agent.signal },
      async () => ({ kind: 'enter', messages }))
  }
  const closed = await invoke('closed-skill')
  assert.equal(bodyReads, 0)
  assert.equal(closed.messages.some(message => message.source.kind === 'skill-invocation'), false)
  assert.equal(await ctx.skills.get('closed-skill', { scope: agent }), undefined)
  const opened = await invoke('open-skill')
  assert.equal(bodyReads, 1)
  assert.match(opened.messages.find(message => message.source.kind === 'skill-invocation').content[0].text, /BODY open-skill/)
  const child = agentFor(Session.create('child-skill-session'))
  const childScope = createScope(scope.ctx, child, { parent: agent })
  child.ctx = childScope.ctx
  t.after(() => childScope.dispose())
  assert.match((await ctx.skills.get('closed-skill', { scope: child })).content, /BODY closed-skill/)
  agent.runMaintenance = operation => operation(agent.signal)
  env.reconfigure(config({ 'skills.open-skill': 'closed' }))
  assert.equal(env.metadata(agent)[0].members.find(item => item.name === 'open-skill').description, 'open-skill owner summary')
  await env.refresh(agent)
  const entries = env.stateFor(agent).snapshot.capabilities.filter(item => item.category === 'skill')
  assert.equal(entries.length, 2)
  assert.equal(entries.find(item => item.id === 'skills.closed-skill').description, 'closed-skill owner summary')
  assert.match((await ctx.skills.get('closed-skill', { scope: agent })).content, /BODY closed-skill/)
  assert.equal(await ctx.skills.get('open-skill', { scope: agent }), undefined)
})

test('disposing Skill providers contracts discovery and shared loading without reallocating the session plan', async t => {
  const ctx = new Context()
  new SkillRegistry(ctx)
  const register = name => ctx.skills.registerProvider(() => ({ name: `${name}-provider`,
    list: async () => [{ name, description: `${name} summary`, invocation: { modelInvocable: true, userInvocable: true },
      provider: `${name}-provider`, source: 'fixture', rank: 250, locator: name }],
    get: async entry => ({ ...entry, content: `BODY ${name}` }),
  }))
  const removeProbe = register('probe')
  const removeKept = register('kept')
  const session = Session.create('removed-skill-provider')
  const agent = agentFor(session)
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  const make = () => createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('skill')] })
  const env = make()
  t.after(async () => { await env.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  await acceptPreparation(env, agent, [])
  const retained = env.adaptFunction(agent, 'skill', async args => args.name)
  await removeProbe()
  await acceptPreparation(env, agent, [])
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name), ['kept'])
  assert.deepEqual(env.projectMembers(agent, ['skill']), ['skill'])
  assert.throws(() => retained({ name: 'probe' }), /unknown or no longer available/)
  assert.equal(await retained({ name: 'kept' }), 'kept')
  const restored = make()
  const target = agentFor(Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header))
  await restored.prepare(target, [])
  assert.deepEqual(restored.metadata(target)[0].members.map(item => item.name), ['kept'])
  await restored.dispose()
  await removeKept()
  await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(env.metadata(agent)[0].members, [])
  assert.deepEqual(env.projectMembers(agent, ['skill']), [])
  assert.equal(env.stateFor(agent).snapshot.plan.entries.find(item => item.id === 'skills.probe').selection, 'on-demand')
  const removeRestored = register('probe')
  await acceptPreparation(env, agent, [])
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name), ['probe'])
  assert.equal(await retained({ name: 'probe' }), 'probe')
  const removeNew = register('new-skill')
  await acceptPreparation(env, agent, [])
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name), ['probe'])
  agent.runMaintenance = operation => operation(agent.signal)
  ctx.systemPrompt = { assemble: async () => ({ sections: [] }) }
  await env.refresh(agent)
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name).sort(), ['new-skill', 'probe'])
  await removeRestored()
  await removeNew()
})

test('shared selector references use the effective plan after refresh and preserve open arguments', async () => {
  const session = appendOnlySession('capability-selector-refresh')
  const agent = agentFor(session)
  agent.runMaintenance = operation => operation(agent.signal)
  const schemas = ['skill', 'read_mcp_resource'].map(schema)
  const ctx = { systemPrompt: { assemble: async () => ({ sections: [] }) }, skills: {
    snapshot: async () => ({ complete: true, skills: ['probe', 'kept'].map(name => ({ name, description: 'Probe summary', invocation: { modelInvocable: true } })) }),
  } }
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => schemas })
  const hostSections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["probe","kept"].' }]
  await acceptPreparation(env, agent, hostSections)
  const original = args => args
  const skill = env.adaptFunction(agent, 'skill', original)
  const resource = env.adaptFunction(agent, 'read_mcp_resource', original)
  const args = { name: 'probe', extra: 'Host owns validation' }
  assert.equal(skill(args), args)
  env.reconfigure(config({ 'skills.probe': 'closed', 'mcp.probe': 'closed' }))
  assert.equal(skill(args), args)
  await env.refresh(agent)
  assert.throws(() => skill(args), /unknown or no longer available/)
  assert.throws(() => resource({ server: 'probe', uri: 'probe://item' }), /not available/)
  assert.throws(() => env.validateSupply(agent, 'read_mcp_resource', { server: 'probe' }), /not available/)
})

test('cancelled or failed refresh append leaves the previous complete plan effective', async () => {
  const session = appendOnlySession('capability-refresh-atomic')
  const agent = agentFor(session)
  agent.runMaintenance = operation => operation(agent.signal)
  const env = createCapabilityEnvironment({ ctx: { systemPrompt: { assemble: async () => ({ sections }) } },
    config: config(), toolSchemasForAgent: () => [schema('probe')] })
  const original = await acceptPreparation(env, agent, sections)
  env.reconfigure(config({ 'tools.probe': 'closed' }))
  const cancellation = new AbortController()
  cancellation.abort()
  await assert.rejects(env.refresh(agent, undefined, cancellation.signal), /abort/i)
  assert.equal(env.stateFor(agent), original)
  session.append = () => { throw Error('append failed') }
  await assert.rejects(env.refresh(agent), /append failed/)
  assert.equal(env.stateFor(agent), original)
  assert.deepEqual(env.projectMembers(agent, ['probe']), ['probe'])
})


for (const boundary of ['inventory', 'coverage']) for (const cancellationOwner of ['caller', 'maintenance']) {
  test(`refresh preserves its accepted plan when ${cancellationOwner} cancellation occurs during ${boundary}`, async () => {
    const agent = agentFor(Session.create(`late-refresh-${boundary}-${cancellationOwner}`))
    const maintenance = new AbortController()
    agent.runMaintenance = operation => operation(maintenance.signal)
    let delayed = false
    let release
    let entered
    const reached = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const pause = async name => {
      if (delayed && boundary === name) { entered(); await gate }
    }
    const ctx = { systemPrompt: { assemble: async () => ({ sections: [] }) },
      skills: { snapshot: async () => { await pause('inventory'); return { complete: true, skills: [] } } } }
    const store = { coverage: async () => { await pause('coverage'); return undefined } }
    const initialConfig = { ...config(), capabilityStatistics: '{"enabled":true,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }
    const env = createCapabilityEnvironment({ ctx, config: initialConfig, store, toolSchemasForAgent: () => [schema('probe')] })
    const original = await acceptPreparation(env, agent, [])
    const planIds = () => agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan')
      .map(event => event.data.id)
    const before = planIds()
    env.reconfigure({ ...initialConfig, capabilityOverrides: '{"tools.probe":"closed"}' })
    const caller = new AbortController()
    delayed = true
    const refreshing = env.refresh(agent, undefined, caller.signal)
    await reached
    const rejected = assert.rejects(refreshing, /abort/i)
    const cancelling = cancellationOwner === 'caller' ? caller : maintenance
    cancelling.abort()
    release()
    await rejected
    assert.equal(env.stateFor(agent), original)
    assert.deepEqual(planIds(), before)
    assert.equal(env.describe(agent).pendingRefresh, true)
    assert.equal(original.snapshot.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'on-demand')
  })
}

test('compacted full plan does not resurrect unused contracts outside recovery budget', async () => {
  const session = Session.create('compacted-full-plan')
  const agent = agentFor(session)
  const env = createCapabilityEnvironment({ ctx: {}, config: { ...config({ 'tools.unused': 'full' }), capabilityRecoveryBytes: 1 },
    toolSchemasForAgent: () => [{ ...schema('unused'), description: 'UNUSED_LONG_FULL_CONTRACT'.repeat(20) }] })
  await acceptPreparation(env, agent, [])
  const plan = session.snapshotEvents().find(event => event.data?.source?.form === 'capability-plan')
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted.' }] }),
    { surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq }, sourceEventSeqs: [plan.seq] })
  const result = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: session.deriveMessages() }))
  assert.equal(result.messages.some(message => message.source?.form === 'capability-plan'), false)
  assert.equal(result.messages.some(message => message.source?.form === 'capability-descriptions'), false)
  assert.doesNotMatch(result.messages.map(message => message.content[0]?.text).join('\n'), /UNUSED_LONG_FULL_CONTRACT/)
  assert.ok(result.messages.some(message => message.source?.form === 'capability-navigation'))
})

test('discarded computation expansion recovers complete contracts and resource instructions', async () => {
  const session = Session.create('discarded-expansion')
  const agent = agentFor(session)
  const env = createCapabilityEnvironment({ ctx: {}, config: config(), toolSchemasForAgent: () => [schema('read_mcp_resource')] })
  await acceptPreparation(env, agent, [{ name: 'mcp-resource-servers', text: 'as the server argument: ["probe"].' },
    { name: 'mcp:probe', text: 'Exact resource instructions.' }])
  env.explored(agent, { matches: [{ symbol: 'mcp.probe' }] })
  const invocation = { agent, name: 'read_mcp_resource', arguments: { server: 'probe' }, token: {} }
  env.admitted(invocation)
  env.dispatched(invocation, { isError: false })
  const result = env.complete({ agent }, { isError: false, value: null })
  assert.ok(result.meta.dshPtcPlusCapabilities.used.includes('mcp.probe'))
  const call = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'discarded', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'discarded', isError: false,
    content: [{ type: 'text', text: 'null' }] }), meta: result.meta }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const step = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: session.deriveMessages() }))
  const recovered = step.messages.find(message => message.source?.form === 'capability-descriptions')
  assert.match(recovered.content[0].text, /mcp.probe/)
  assert.match(recovered.content[0].text, /Exact resource instructions/)
})


test('Host final outcomes count admitted capability calls while pre-dispatch cancellation does not', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  t.after(() => ctx.fiber.dispose())
  const agent = agentFor(Session.create('host-capability-outcomes'))
  let bodyCalls = 0
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'probe', description: 'Probe', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodyCalls++; return 'ok' } })))
  const uses = []
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('probe')],
    store: { used: (...args) => uses.push(args) } })
  await acceptPreparation(env, agent, [])
  ctx.on('tools/execute', (exec, next) => { env.admitted(exec); return next() })
  ctx.on('tools/result', (exec, result) => env.dispatched(exec, result))
  const execute = callId => ctx.tools.execute({ agent, name: 'probe', arguments: {}, callId,
    signal: agent.signal })
  const canceled = new AbortController()
  canceled.abort()
  const abortWrapper = ctx.on('tools/execute', (exec, next) => { exec.signal = canceled.signal; return next() })
  const aborted = await execute('aborted')
  assert.equal(aborted.error.info.code, 'ABORTED_BEFORE_DISPATCH')
  assert.equal(bodyCalls, 0)
  assert.equal(uses.length, 0)
  abortWrapper()
  const synthetic = ctx.on('tools/execute', async () => ({ isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }))
  assert.equal((await execute('wrapper')).isError, false)
  await Promise.resolve()
  assert.equal(bodyCalls, 0)
  assert.equal(uses.length, 1)
  assert.equal(uses[0][3], 'host-execution-result')
  synthetic()
  assert.equal((await execute('body')).isError, false)
  await Promise.resolve()
  assert.equal(bodyCalls, 1)
  assert.equal(uses.length, 2)
  const denial = ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'Denied' }))
  assert.equal((await execute('denied')).isError, true)
  await Promise.resolve()
  assert.equal(uses.length, 2)
  denial()
})


test('initial full contracts and mixed inspect evidence recover identically after Session restoration', async () => {
  for (const full of [true, false]) {
    const session = Session.create(`full-evidence-${full}`)
    const agent = agentFor(session)
    const make = () => createCapabilityEnvironment({ ctx: {}, config: config(full ? { 'tools.probe': 'full' } : {}),
      toolSchemasForAgent: () => [schema('probe')] })
    const first = make()
    await acceptPreparation(first, agent, [])
    await first.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
    if (!full) first.explored(agent, { symbols: [{ namespace: 'tools', name: 'probe' },
      { namespace: 'code', name: 'run' }, { namespace: 'repl', name: 'state' }] })
    const invocation = { agent, name: 'probe', token: {} }
    first.admitted(invocation)
    first.dispatched(invocation, { isError: false })
    const result = first.complete({ agent }, { isError: false })
    assert.deepEqual(result.meta.dshPtcPlusCapabilities.expanded, ['tools.probe'])
    if (!full) result.meta.dshPtcPlusCapabilities.expanded.push('code.run', 'repl.state')
    const call = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'probe', arguments: '{}' })
    const message = createToolResultMessage({ callId: 'probe', isError: false, content: [{ type: 'text', text: '42' }] })
    session.append('tool/result', { turn: 1, step: 1, message, meta: result.meta }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    const visible = session.snapshotEvents().filter(event => event.type !== 'system/message'
      && (event.surfaceOp === 'append' || event.surfaceOp?.op === 'append'))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted.' }] }),
      { surfaceOp: { op: 'replace', startSeq: visible[0].seq, endSeq: visible.at(-1).seq }, sourceEventSeqs: visible.map(event => event.seq) })
    const restoredSession = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header)
    const restored = make()
    const target = agentFor(restoredSession)
    await restored.prepare(target, [])
    const step = await restored.preStep({ agent: target, signal: target.signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.match(step.messages.find(item => item.source.form === 'capability-descriptions').content[0].text, /Owner contract for probe/)
    assert.deepEqual([...restored.stateFor(target).expanded], ['tools.probe'])
    assert.deepEqual([...restored.stateFor(target).used.keys()], ['tools.probe'])
  }
})

test('disposing an MCP resource provider removes discovery, selectors and recovered descriptions', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  await ctx.plugin(McpResourceRuntime).await()
  t.after(() => ctx.fiber.dispose())
  const provider = { async request() { return { contents: [{ uri: 'probe://item', text: 'value' }] } } }
  const remove = ctx.mcpResources.register('probe', provider)
  ctx.effect(() => ctx.mcpResources.register('kept', provider))
  const session = Session.create('removed-resource-provider')
  const agent = agentFor(session)
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => ctx.tools.sdkSchemas(agent) })
  const assemble = () => ctx.systemPrompt.assemble({ agent, scope: agent, signal: agent.signal })
  await acceptPreparation(env, agent, (await assemble()).sections)
  env.explored(agent, { matches: [{ symbol: 'mcp.probe' }] })
  const invocation = { agent, name: 'read_mcp_resource', arguments: { server: 'probe', uri: 'probe://item' }, token: {} }
  env.admitted(invocation)
  env.dispatched(invocation, { isError: false })
  const result = env.complete({ agent }, { isError: false })
  const call = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'resource', arguments: '{}' })
  const completion = session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: 'resource', isError: false, content: [{ type: 'text', text: 'value' }] }),
    meta: result.meta }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const plan = session.snapshotEvents().find(event => event.data?.source?.form === 'capability-plan')
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted.' }] }),
    { surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: completion.seq }, sourceEventSeqs: [plan.seq, completion.seq] })
  remove()
  ctx.effect(() => ctx.mcpResources.register('new-server', provider))
  await acceptPreparation(env, agent, (await assemble()).sections)
  assert.deepEqual(env.metadata(agent).find(entry => entry.namespace === 'mcp').members.map(member => member.name), ['kept'])
  assert.throws(() => env.adaptFunction(agent, 'read_mcp_resource', () => 'unexpected')({ server: 'probe', uri: 'probe://item' }))
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.some(message => message.source?.form === 'capability-descriptions'
    && message.source.entries.includes('mcp.probe')), false)
  const frozen = env.stateFor(agent).snapshot.plan.entries.find(entry => entry.id === 'mcp.probe')
  assert.equal(frozen.selection, 'on-demand')
})


test('MCP server closure removes its tools and resources while per-tool choices and other servers survive refresh', async () => {
  const agent = agentFor(Session.create('mcp-server-master'))
  agent.runMaintenance = operation => operation(agent.signal)
  const hostSections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs","other"].' }]
  const schemas = ['run_code','mcp__docs__search','mcp__docs__edit','mcp__other__search','read_mcp_resource','list_mcp_resources'].map(schema)
  const ctx = { agents: { list: () => [agent] }, systemPrompt: { assemble: async () => ({sections:hostSections}) } }
  const individual = { 'tools.mcp__docs__search': 'full', 'tools.mcp__docs__edit': 'closed' }
  const env = createCapabilityEnvironment({ ctx, config: config(individual), toolSchemasForAgent: () => schemas })
  const original = await acceptPreparation(env, agent, hostSections)
  const catalog = await env.describeCatalog(agent.signal)
  assert.deepEqual(catalog.find(item => item.id === 'tools.mcp__docs__search').source, { kind: 'mcp', server: 'docs' })
  assert.equal(catalog.find(item => item.id === 'tools.mcp__docs__search').mcpServer, 'docs')
  const open = env.projectMembers(agent, schemas.map(item => item.name))
  assert.ok(open.includes('mcp__docs__search'))
  assert.ok(!open.includes('mcp__docs__edit'))
  env.reconfigure(config({ ...individual, 'mcpServers.docs': 'closed' }))
  assert.deepEqual(env.projectMembers(agent, schemas.map(item => item.name)), open, 'Saved closure is pending until explicit refresh.')
  await env.refresh(agent, hostSections, agent.signal)
  const closed = env.projectMembers(agent, schemas.map(item => item.name))
  assert.ok(!closed.some(name => name.startsWith('mcp__docs__')))
  assert.ok(closed.includes('mcp__other__search'))
  const snapshot = env.describe(agent)
  assert.equal(snapshot.effective.entries.find(item => item.id === 'tools.mcp__docs__search').reason, 'mcp-server-disabled')
  const resource = env.adaptFunction(agent, 'read_mcp_resource', args => args)
  assert.deepEqual(resource({server:'other',uri:'other://resource'}), {server:'other',uri:'other://resource'})
  assert.throws(() => resource({server:'docs',uri:'docs://resource'}), /not available/)
  assert.throws(() => env.validateSupply(agent, 'mcp__docs__search', {}), /not found|unknown|available/i)
  assert.throws(() => env.validateSupply(agent, 'read_mcp_resource', {server:'docs'}), /not available/)
  env.reconfigure(config(individual))
  await env.refresh(agent, hostSections, agent.signal)
  assert.deepEqual(env.projectMembers(agent, schemas.map(item => item.name)), open)
  assert.equal(original.snapshot.settings.manual.overrides['tools.mcp__docs__edit'], 'closed')
  env.reconfigure(config({...individual,'mcpServers.docs':'closed','mcpServers.other':'closed','tools.read_mcp_resource':'full'}))
  await env.refresh(agent,hostSections,agent.signal)
  assert.ok(!env.projectMembers(agent,schemas.map(item=>item.name)).includes('read_mcp_resource'))
  assert.ok(!env.describe(agent).effective.entries.some(item=>item.id==='tools.read_mcp_resource'))
})

test('MCP namespace ambiguity cannot close another server by guessing ownership', async () => {
  const agent = agentFor(Session.create('mcp-ambiguous'))
  const env = createCapabilityEnvironment({ ctx: {}, config: config({'mcpServers.docs':'closed'}),
    toolSchemasForAgent: () => [schema('mcp__docs__nested__search')] })
  await assert.rejects(() => env.prepare(agent, [{name:'mcp-resource-servers',text:'as the server argument: ["docs","docs__nested"].'}]), /cannot determine the MCP server owner/)
})
