import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { McpResourceRuntime } from '@deepseek-ai/dsh-mcp-resources'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as skillTool from '@deepseek-ai/dsh-tool-skill'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createFixtureExecutionProvider } from './host-fixture.js'
import * as ptcPlus from '../index.js'

const signal = () => new AbortController().signal
const session = (id, parentSession) => Session.create(id, [], {
  version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: process.cwd(), isSeeded: false,
  ...(parentSession === undefined ? {} : { parentSession, origin: 'subagent', delegationDepth: 1 }),
})
const text = assembly => assembly.sections.map(section => section.text).join('\n')
const echo = name => defineTool({
  name, description: `Complete owner description for ${name}.`, parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() { return name },
})

function host(t, mode = 'native', run = async () => ({ logs: [], value: null })) {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false,
    personaPrefix: '', personaSuffix: '' })
  ctx.effect(() => ctx.provide('ptcRuntime', createFixtureExecutionProvider({
    language: 'typescript', isolation: 'worker-thread',
    resolve(request) { return { ...request, cwd: process.cwd(), timeoutMs: null } }, run,
  })))
  new ToolRuntime(ctx, { mode })
  t.after(() => ctx.fiber.dispose())
  const agent = { id: 'context-host-agent', session: session('context-host-agent') }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  return { ctx, agent }
}

test('public restrictions remove inherited tools from schemas and the next PTC bindings', async t => {
  const requests = []
  const { ctx, agent } = host(t, 'ptc', async request => {
    requests.push(request)
    return { logs: [], value: null }
  })
  ctx.effect(() => ctx.tools.register(echo('inherited_capability')))
  const before = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: signal() })
  assert.match(text(before), /inherited_capability/)
  const invoke = id => ctx.tools.execute({ name: 'run_code', callId: id, arguments: {
    code: 'return null', description: 'Probe published bindings',
  }, agent, signal: signal() })
  assert.equal((await invoke('before-restriction')).isError, false)
  ctx.effect(() => agent.ctx.tools.restrict({ deny: ['inherited_capability'] }))
  assert.equal(ctx.tools.get('inherited_capability', agent), undefined)
  assert.equal(ctx.tools.schemas(agent).some(schema => schema.name === 'inherited_capability'), false)
  assert.doesNotMatch(text(await ctx.systemPrompt.assemble({ agent, scope: agent })), /inherited_capability/)
  assert.equal((await invoke('after-restriction')).isError, false)
  assert.equal(Object.hasOwn(requests[0].bindings[0].functions, 'inherited_capability'), true)
  assert.equal(Object.hasOwn(requests[1].bindings[0].functions, 'inherited_capability'), false)
  assert.equal(Object.hasOwn(requests[0].bindings[0].functions, 'inherited_capability'), true,
    'The previously supplied functions object is not rewritten by a registry restriction.')
})

test('public restrictions cannot remove a tool registered in the viewing scope', async t => {
  const { ctx, agent } = host(t)
  ctx.effect(() => ctx.tools.register(echo('inherited_capability')))
  agent.ctx.effect(() => agent.ctx.tools.register(echo('scope_owned_capability')))
  assert.throws(() => agent.ctx.tools.restrict({ deny: ['scope_owned_capability'] }), /unknown global tool/)
  agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: [] }))
  assert.equal(ctx.tools.get('inherited_capability', agent), undefined)
  assert.equal(ctx.tools.get('scope_owned_capability', agent)?.name, 'scope_owned_capability')
  const outcome = await ctx.tools.execute({ name: 'scope_owned_capability', callId: 'scope-own',
    arguments: {}, agent, signal: signal() })
  assert.equal(outcome.isError, false)
  assert.equal(outcome.value, 'scope_owned_capability')
})

test('the public prompt waterfall replaces the full SDK while preserving host dispatch', async t => {
  const { ctx, agent } = host(t, 'ptc')
  ctx.effect(() => ctx.tools.register(echo('on_demand_capability')))
  const original = await ctx.systemPrompt.assemble({ agent, scope: agent })
  assert.match(text(original), /on_demand_capability/)
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, sections: assembled.sections.map(section => section.name === 'tools:sdk'
      ? { ...section, text: 'Fixed bootstrap. Consult the source-backed session catalog.' } : section) }
  })
  const projected = await ctx.systemPrompt.assemble({ agent, scope: agent })
  assert.doesNotMatch(text(projected), /on_demand_capability/)
  assert.deepEqual(projected.tools, original.tools)
  assert.equal(ctx.tools.get('on_demand_capability', agent)?.name, 'on_demand_capability')
  assert.equal(text(await ctx.systemPrompt.assemble({ agent, scope: agent })), text(projected))
})

test('hiding the shared skill loader leaves explicit user skill injection available', async t => {
  const { ctx, agent } = host(t)
  new SkillRegistry(ctx)
  ctx.skills.register({ name: 'probe-skill', description: 'Probe complete skill description.',
    source: 'runtime', content: 'PROBE_SKILL_BODY' })
  skillTool.apply(ctx)
  agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: ['skill'] }))
  assert.equal(ctx.tools.get('skill', agent), undefined)
  assert.equal((await ctx.skills.list({ scope: agent })).some(item => item.name === 'probe-skill'), true)
  const messages = [createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '/probe-skill Please execute this skill.' }] })]
  const result = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages, turn: 1, step: 1, signal: signal(),
  }, async () => ({ kind: 'enter', messages }))
  assert.equal(result.kind, 'enter')
  const injected = result.messages.find(message => message.source.kind === 'skill-invocation')
  assert.equal(injected?.source.name, 'probe-skill')
  assert.match(injected.content[0].text, /PROBE_SKILL_BODY/)
})

test('MCP tools use registry restrictions but resource providers retain separate server access', async t => {
  const { ctx, agent } = host(t)
  let calls = 0
  const mcpTool = createMcpToolDefinition(ctx, {
    name: 'mcp__probe__read', rawName: 'probe', description: 'Probe upstream MCP description.',
    inputSchema: { type: 'object' },
    async call() { calls += 1; return { content: [{ type: 'text', text: 'mcp reply' }] } },
  })
  ctx.effect(() => ctx.tools.register(mcpTool))
  await ctx.plugin(McpResourceRuntime).await()
  ctx.mcpResources.register('probe', { async request(request) { calls += 1; return {
    method: request.method, resources: [{ uri: 'probe://item', name: 'Probe' }],
  } } })
  agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: ['mcp__probe__read', 'list_mcp_resources'] }))
  assert.equal(ctx.tools.get('mcp__probe__read', agent), undefined)
  assert.equal(ctx.tools.get('list_mcp_resources', agent), undefined)
  assert.match(text(await ctx.systemPrompt.assemble({ scope: agent, agent })), /probe/)
  const result = await ctx.tools.execute({ name: 'read_mcp_resource', callId: 'resource-read',
    arguments: { server: 'probe', uri: 'probe://item' }, agent, signal: signal() })
  assert.equal(result.isError, false)
  assert.equal(result.value.method, 'resources/read')
  assert.equal(calls, 1)
  agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: ['read_mcp_resource', 'list_mcp_resource_templates'] }))
  assert.equal(ctx.tools.schemas(agent).some(schema => /mcp_resource/.test(schema.name)), false)
  assert.match(text(await ctx.systemPrompt.assemble({ scope: agent, agent })), /"probe"/,
    'The resource server prompt is owned by the provider registry, not tool visibility.')
})

test('command receipts remain outside model history until a surface message is appended', async t => {
  const { ctx, agent } = host(t)
  new CommandRuntime(ctx)
  ctx.commands.register({ name: 'probe-refresh', description: 'Probe receipt semantics.',
    handler: () => ({ kind: 'success', text: 'Refreshed' }) })
  const result = await ctx.commands.execute(agent, '/probe-refresh', [], signal())
  assert.equal(result.result.kind, 'success')
  assert.equal(agent.session.deriveMessages().length, 0)
  const notice = createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Capability plan refresh committed.' }] })
  agent.session.append('user/message', notice, { surfaceOp: 'append' })
  assert.equal(agent.session.deriveMessages().at(-1).content[0].text, notice.content[0].text)
  const restored = Session.create(agent.id, agent.session.snapshotEvents(), agent.session.header)
  assert.equal(restored.deriveMessages().at(-1).id, notice.id)
})

test('PTC Plus starts a model turn with empty tool and MCP instructions', async t => {
  const { ctx } = host(t, 'ptc')
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  ctx.effect(() => ctx.tools.register(echo('mcp__docs__probe')))
  for (const name of ['tool:mcp__docs__probe', 'mcp:docs']) {
    ctx.effect(() => ctx.systemPrompt.section({ name, order: 10, text: '' }))
  }
  const requests = []
  const errors = []
  ctx.on('agent/error', payload => errors.push(payload.error))
  async function* stream(options) {
    requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.provide('llm', { async prepareCall(config) { return { config, stream, adapterDefaults: {} } }, stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false, capabilityManagementEnabled: true,
    capabilityOverrides: '{"tools.mcp__docs__probe":"full"}',
    capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }).await()
  const owner = await ctx.agents.create({ sessionId: 'empty-instructions-ptc-turn', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => owner.dispose())
  for (const text of ['probe', 'continue']) {
    owner.agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), 'next-turn', true)
    await owner.agent.whenIdle()
  }
  assert.deepEqual(errors, [])
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  const plans = owner.agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan')
  assert.equal(plans.length, 1)
  assert.match(plans[0].data.content[0].text, /tools\.mcp__docs__probe/)
  assert.deepEqual(owner.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    .map(event => event.data.reason.kind), ['completed', 'completed'])
})

test('capability commands advertise refresh input and apply through the public human-command runtime without model requests', async t => {
  const { ctx } = host(t, 'ptc')
  new CommandRuntime(ctx)
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  let requests = 0
  ctx.provide('llm', { stream() { requests++; throw new Error('Human commands must not request a model') } })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false, capabilityManagementEnabled: true,
    capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }).await()
  const owner = await ctx.agents.create({ sessionId: 'human-capability-refresh', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => owner.dispose())
  const agent = owner.agent
  const command = ctx.commands.list(agent).find(command => command.name === 'capabilities')
  assert.match(command.input.hint, /refresh/)
  let definition
  const require = createRequire(import.meta.url)
  runInNewContext(await readFile(require.resolve('@deepseek-ai/dsh-client-ui-commands/client'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value } } }, AbortController, console,
  })
  const modules = new Map(await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react', 'react/jsx-runtime']
    .map(async name => [name, await import(name)])))
  const { CommandUiRuntime } = definition.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : modules.get(name))
  const ui = new Context()
  t.after(() => ui.fiber.dispose())
  ui.provide('locale', { bind: () => key => key })
  let inputSource
  ui.provide('inputTriggers', { registerSource(source) { inputSource = source; return () => {} } })
  ui.provide('sessions', {
    subagentAddress: () => undefined, binding: () => ({}),
    using: async (_id, _lease, callback) => callback({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }),
  })
  const remoteCommands = {
    list: async id => { assert.equal(id, agent.id); return { ok: true, value: ctx.commands.list(agent) } },
    execute: async (id, line, attachments) => {
      assert.equal(id, agent.id)
      return { ok: true, value: await ctx.commands.execute(agent, line, attachments, signal()) }
    },
  }
  ui.provide('remote', { commands: remoteCommands, $on: () => () => {} })
  ui.provide('remote.commands', remoteCommands)
  new CommandUiRuntime(ui)
  const bare = await ctx.commands.execute(agent, '/capabilities', [], signal())
  assert.equal(bare.result.kind, 'success')
  const matched = await inputSource.matchEnter({ sessionId: agent.id }, '/capabilities refresh', signal(), { attachments: 0 })
  assert.equal(matched.claim.name, 'capabilities')
  assert.equal((await matched.claim.submit('refresh', ui, [])).kind, 'success')
  const completed = agent.session.snapshotEvents().filter(event => event.type === 'command/done').at(-1)
  assert.match(completed.data.text, /first accepted model step/)
  const inspect = await ctx.commands.execute(agent, '/capabilities', [], signal())
  assert.equal(JSON.parse(inspect.result.text).publication, 'pending')
  const invalid = await ctx.commands.execute(agent, '/capabilities surprise', [], signal())
  assert.equal(invalid.result.kind, 'error')
  assert.match(invalid.result.text, /Use \/capabilities/)
  assert.equal(requests, 0)
  assert.equal(agent.session.deriveMessages().some(message => message.content?.some(block => block.text === '/capabilities refresh')), false)
})

test('durable session lineage survives restoration without asserting that a family has ended', () => {
  const root = session('family-root')
  const child = session('family-child', root.id)
  const restored = Session.create(child.id, child.snapshotEvents(), child.header)
  assert.equal(restored.header.parentSession, root.id)
  assert.equal(restored.header.origin, 'subagent')
  assert.equal(restored.header.cwd, process.cwd())
  assert.equal(restored.deriveMessages().length, 0)
})

test('the public agent factory provides real ownership and durable non-waking maintenance context', async t => {
  const { ctx } = host(t)
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  let requests = 0
  ctx.provide('llm', { stream() { requests += 1; throw new Error('This probe must never request a model.') } })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const parent = await ctx.agents.create({ sessionId: 'actual-root', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => parent.dispose())
  const child = await ctx.agents.create({ sessionId: 'actual-child', parentAgent: parent.agent,
    meta: { parentSession: parent.agent.id, origin: 'subagent', delegationDepth: 1, cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => child.dispose())
  assert.equal(ctx.agents.isOwnedBy(child.agent.id, parent.agent), true)
  assert.equal(child.agent.session.header.parentSession, parent.agent.id)
  assert.equal(parent.agent.status, 'idle')
  const notice = createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Capability plan changed at the maintenance boundary.' }] })
  await parent.agent.runMaintenance(async () => {
    parent.agent.send(notice, 'next-step', false)
  })
  await parent.agent.whenIdle()
  assert.equal(requests, 0)
  assert.equal(parent.agent.inbox.nextStep[0].id, notice.id)
  assert.equal(parent.agent.session.deriveMessages().length, 0,
    'Pending durable inbox context has not yet entered the accepted model surface.')
  const restored = Session.create(parent.agent.id, parent.agent.session.snapshotEvents(), parent.agent.session.header)
  assert.equal(ctx.sessionProjections.stateOf(restored, 'inbox')['next-step'][0].id, notice.id)
})

test('public retention and spill preserve complete presentation without rerunning computation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'context-host-spill-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  new LocalSpillStore(ctx, { root, cleanupPeriodDays: 0 })
  const canonical = { value: '完整结果 '.repeat(200) }
  const presentation = JSON.stringify(canonical)
  const retained = new TextRetainer({ kind: 'headTail', headBytes: 32, tailBytes: 32 })
  retained.push(presentation)
  const preview = retained.finish()
  assert.equal(preview.truncated, true)
  const saved = await ctx.spillStore.saveText({ owner: { sessionId: 'spill-owner' },
    source: { kind: 'tool', toolName: 'run_code', callId: 'spill-call', label: 'result' },
    suggestedName: 'result.json', content: presentation })
  assert.equal(await readFile(saved.locator, 'utf8'), presentation)
  assert.equal(saved.bytes, Buffer.byteLength(presentation))
  assert.match(saved.retrievalHint, /read|grep/)
  assert.deepEqual(JSON.parse(await readFile(saved.locator, 'utf8')), canonical)
})


test('settings catalog captures public MCP ownership before the first request without preparing plans or bindings', async t => {
  const {ctx,agent} = host(t,'ptc')
  new AgentRegistry(ctx)
  ctx.agents.list = () => [agent]
  const operations = new Map()
  ctx.provide('ptcPlusRpc',{register(contract,handler){ operations.set(contract.service,handler); return ()=>operations.delete(contract.service) }})
  new McpResourceRuntime(ctx)
  ctx.effect(()=>ctx.mcpResources.register('docs',{request:async()=>({resources:[]})}))
  ctx.effect(()=>ctx.tools.register(echo('mcp__docs__search')))
  await ctx.plugin(ptcPlus,{userBindingsEnabled:false,cordisToolsEnabled:false,capabilityManagementEnabled:true}).await()
  const before = agent.session.snapshotEvents()
  const catalog = await operations.get('ptcPlusCapabilities')('catalog',{},signal())
  assert.equal(catalog.ok,true)
  assert.equal(catalog.value.find(entry=>entry.id==='tools.mcp__docs__search').mcpServer,'docs')
  assert.deepEqual(agent.session.snapshotEvents(),before)
  const inspection = await operations.get('ptcPlusCapabilities')('inspect',{},signal())
  assert.deepEqual(inspection.value,[])
})
