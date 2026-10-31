import * as ptcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import * as sessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { attachNativeExecutor, attachPtcExecutor, runTool } from './tool-executor-fixture.js'
import { provideSandboxPolicyFixture, provideWorkingDirectoryFixture } from './host-service-fixture.js'
import { settleService } from './service-fixture.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import * as subagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as subagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as skillTool from '@deepseek-ai/dsh-tool-skill'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createFixtureExecutionProvider } from './host-fixture.js'
import { appendRunCodeCall, appendRunCodeResult } from './plugin-fixture.js'
import * as ptcPlus from '../index.js'
import { CapabilityStatisticsStore } from '../internal/capability-statistics-store.js'
import { readCapabilityCommandReceipt } from '../internal/capability-command-receipt.js'
import { CAPABILITY_PLAN_FORM, createCapabilityEnvironment } from '../internal/capability-environment.js'
import { CAPABILITY_SELECTION_SCHEMA, capabilitySelectionMessage } from '../internal/capability-selection.js'
import { hostTransportDefinition } from '../internal/host-tool-sdk.js'

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
  // run_code resolves the session's working directory before it executes.
  if (ctx.get('workingDirectory') === undefined) provideWorkingDirectoryFixture(ctx)
  ctx.effect(() => ctx.provide('ptcRuntime', createFixtureExecutionProvider({
    language: 'typescript', isolation: 'worker-thread',
    resolve(request) { return { ...request, cwd: process.cwd(), timeoutMs: null } }, run,
  })))
  // The registry has no mode of its own any more: the fixture mounts the executor it wants
  // and the registry renders whatever that executor describes.
  new ToolRuntime(ctx)
  if (mode === 'ptc') attachPtcExecutor(ctx)
  else attachNativeExecutor(ctx)
  t.after(() => ctx.fiber.dispose())
  const agent = { id: 'context-host-agent', session: session('context-host-agent') }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  return { ctx, agent }
}

/**
 * One capability plan message, composed the way a session records one.
 *
 * A session the Host no longer holds is stated by the plan its log holds, so a test
 * that reads such a session records one first: the environment composes it from the
 * declarations this fixture Host makes, and the log carries the message a step would
 * have accepted.
 */
async function recordedPlanMessage(t, { sessionId, schemas, sections = [] }) {
  const session = Session.create(sessionId)
  const agent = { id: session.id, session, signal: signal() }
  const env = createCapabilityEnvironment({
    ctx: { agents: { list: () => [agent] }, systemPrompt: { assemble: async () => ({ sections }) } },
    sessionHistoryForAgent: async () => ({ events: session.snapshotEvents() }),
    config: { capabilityManagementEnabled: true, capabilityBaseline: '[]', capabilityOverrides: '{}',
      capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
      capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 },
    toolSchemasForAgent: () => schemas.map(name => ({ name, description: `Complete owner description for ${name}.`,
      parameters: {}, output: { type: 'string' } })),
  })
  t.after(() => env.dispose())
  await env.prepare(agent, sections)
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  const plan = decision.messages.find(message => message.source?.form === CAPABILITY_PLAN_FORM)
  assert.ok(plan, 'the fixture session must record a capability plan')
  return plan
}

const planEvent = message => ({ type: 'user/message', seq: 0, data: message })

for (const [statisticsEnabled, incompleteSkills] of [[false, false], [true, false], [true, true]]) {
  test(`PTC delegates through injected Host spawn and fork tools with statistics ${statisticsEnabled ? 'enabled' : 'disabled'}${incompleteSkills ? ' and incomplete Skill discovery after child completion' : ''}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'ptc-subagent-host-'))
    const previousDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    const ctx = new Context()
    t.after(async () => {
      try { await ctx.fiber.dispose() } finally {
        if (previousDshHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousDshHome
        await rm(root, { recursive: true, force: true })
      }
    })
    // Register services in their own plugin fibers: root construction bypasses
    // Cordis injection checks and cannot prove the Host lifecycle contract.
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false,
      personaPrefix: '', personaSuffix: '' }).await()
    // run_code resolves the session's working directory before it executes, and a delegated
    // child asks this service to record the directory it runs in.
    provideWorkingDirectoryFixture(ctx)
    ctx.effect(() => ctx.provide('ptcRuntime', createFixtureExecutionProvider({
      language: 'typescript', isolation: 'worker-thread',
      resolve(request) { return { ...request, cwd: root, timeoutMs: null } },
      async run() { throw new Error('PTC Plus must own execution in this fixture') },
    })))
    await ctx.plugin(ToolRuntime).await()
    // A confined PTC runtime resolves one file policy per call, and a delegated child asks
    // this service for the parent's recorded override.
    provideSandboxPolicyFixture(ctx)
    // A continuable subagent needs durable session ownership, so this fixture mounts the
    // published JSONL persistence backend into its temporary DSH home.
    await ctx.plugin(sessionPersistenceJsonl, { root: join(root, 'sessions'), compression: 'none' }).await()
    // The executor is a Cordis module plugin: mounting the module runs its own apply, which
    // selects it in a fiber that can see the registry service.
    await ctx.plugin(ptcExecutor).await()
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(SessionProjectionRegistry).await()
    await ctx.plugin(AgentRegistry).await()
    await ctx.plugin(SessionQueryEngine).await()
    let skillsComplete = true
    let skillControl
    if (incompleteSkills) {
      await ctx.plugin(SkillRegistry).await()
      await ctx.plugin(skillTool).await()
      ctx.effect(() => ctx.skills.registerProvider(control => {
        skillControl = control
        return { name: 'delegation-skills', list: async () => ({ complete: skillsComplete, candidates: [{ name: 'fixture',
          description: 'Fixture Skill', source: 'fixture', provider: 'delegation-skills', rank: 1, locator: 'fixture',
          invocation: { modelInvocable: true, userInvocable: true } }] }),
        get: async entry => ({ ...entry, content: 'Fixture body' }) }
      }))
    }
    const requests = []
    async function* stream(options) {
      requests.push(options)
      yield { type: 'text-delta', index: 0, text: 'fixture answer' }
      if (incompleteSkills) { skillsComplete = false; skillControl.invalidate() }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    ctx.effect(() => ctx.provide('llm', { async prepareCall(config) { return { config, stream, adapterDefaults: {} } }, stream }))
    await ctx.plugin(AgentLoop, { agents: [] }).await()
    await ctx.plugin(SubagentRuntime).await()
    await ctx.plugin(subagentSpawn).await()
    await ctx.plugin(subagentFork).await()
    await ctx.plugin(subagentTool, { provider: 'spawn' }).await()
    await ctx.plugin(subagentTool, { provider: 'fork', toolName: 'subagent_fork' }).await()
    await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false,
      ...(incompleteSkills ? { capabilityManagementEnabled: true } : {}),
      capabilityStatistics: JSON.stringify({ enabled: statisticsEnabled, windowSize: 10, minimumSamples: 1, fullThreshold: 0.5 }) }).await()
    const created = []
    const disposed = []
    const errors = []
    ctx.on('agent/created', ({ agent }) => created.push(agent))
    ctx.on('agent/disposed', ({ agent }) => disposed.push(agent.id))
    ctx.on('agent/error', payload => errors.push(payload.error))
    const owner = await ctx.agents.create({ sessionId: `delegating-parent-${statisticsEnabled}`, meta: { cwd: root },
      agentOptions: { provider: 'fixture', model: 'fixture' } })
    const invoke = async (callId, code) => {
      const description = 'Delegate through the public Host tool pipeline'
      const calls = []
      appendRunCodeCall(calls, callId, code, description)
      for (const event of calls) owner.agent.session.append(event.type, event.data,
        event.surfaceOp ? { surfaceOp: event.surfaceOp } : {})
      const result = await runTool(ctx, { name: 'run_code', callId, agent: owner.agent,
        signal: signal(), arguments: { code, description } })
      const results = []
      appendRunCodeResult(results, callId, 0, result)
      owner.agent.session.append('tool/result', results[0].data, { surfaceOp: 'append' })
      return result
    }
    const initial = await invoke('parent-initial', 'let retained = 40; return retained')
    assert.equal(initial.isError, false, JSON.stringify(initial.error))
    for (const name of ['subagent', 'subagent_fork']) {
      if (incompleteSkills) { skillsComplete = true; skillControl.invalidate() }
      const result = await invoke(`delegate-${name}`, `return await tools.${name}({ description: 'Fixture delegation', prompt: 'Answer fixture' })`)
      assert.equal(result.isError, false, JSON.stringify(result.error))
      // One delegation is one managed activation: the call answers with the child's id, and
      // the Host delivers that child's closing message to this parent as a settlement notice.
      assert.equal(result.value.result.kind, 'activation')
      const child = created.at(-1)
      assert.equal(result.value.result.subagentId, child.id)
      assert.notEqual(child.id, owner.agent.session.id)
      assert.equal(child.session.header.origin, 'subagent')
      assert.equal(child.session.header.parentSession, owner.agent.session.id)
      await ctx.subagents.waitForChildren(owner.agent)
      if (incompleteSkills) assert.equal(skillsComplete, false)
      // The settlement wakes this parent, so its own turn and the notice it reads belong to
      // the parent's log rather than to the child's result.
      await owner.agent.whenIdle()
      const settled = owner.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source?.kind === 'subagent-settled' && event.data.source?.senderSessionId === child.id)
      assert.equal(settled.length, 1, 'the Host delivers one settlement notice for one delegation')
      assert.match(settled[0].data.content.map(block => block.text).join('\n'), /fixture answer/)
      assert.ok(disposed.includes(child.id), 'The Host releases the child after delivering its settlement.')
      assert.equal(ctx.agents.get(child.id), undefined)
      const store = new CapabilityStatisticsStore({ filename: join(root, 'lineage.json'), ctx })
      assert.equal(store.family(child), owner.agent.session.id)
      const continued = await invoke(`continue-${name}`, 'retained += 1; return retained')
      assert.equal(continued.isError, false, JSON.stringify(continued.error))
      assert.equal(continued.value.result, name === 'subagent' ? 41 : 42)
    }
    assert.equal(created.length, 3)
    // One request per child turn, and one per settlement turn the notice wakes in this parent.
    assert.equal(requests.length, 4)
    assert.deepEqual(errors, [])
    await owner.dispose()
    assert.deepEqual(ctx.agents.list(), [])
    // Disposal drains statistics operations before inspecting the isolated file.
    await ctx.fiber.dispose()
    if (statisticsEnabled) {
      const document = JSON.parse(await readFile(join(root, 'ptc-plus', 'capability-statistics.json'), 'utf8'))
      assert.equal(document.families.length, 1)
      assert.equal(document.families[0].id, owner.agent.session.id)
      // A delegated child is a family member once the family is observed while that child is
      // live: a delegation is one activation, so its child can settle between two statistics
      // boundaries. The store therefore keeps the members it observed and never invents one,
      // and every row it holds must name a session this family really created.
      const memberIds = new Set(document.members.map(member => member.id))
      const createdIds = new Set(created.map(agent => agent.session.id))
      assert.equal(memberIds.has(owner.agent.session.id), true)
      assert.equal([...memberIds].every(id => createdIds.has(id)), true, [...memberIds].join(', '))
    }
  })
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
  const invoke = id => runTool(ctx, { name: 'run_code', callId: id, arguments: {
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
  const outcome = await runTool(ctx, { name: 'scope_owned_capability', callId: 'scope-own',
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
  if (ctx.get('workingDirectory') === undefined) provideWorkingDirectoryFixture(ctx)
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
  const result = await runTool(ctx, { name: 'read_mcp_resource', callId: 'resource-read',
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
  // The registry registers its turn-boundary projection in Service.init, and an agent
  // turn reads it; the projection owner above must exist before that init settles.
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
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
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ['run_code'])
  assert.deepEqual(requests[1].tools.map(tool => tool.name), ['run_code'])
  for (const request of requests) {
    assert.match(JSON.stringify(request.messages), /edit_run_code/)
  }
  const plans = owner.agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan')
  assert.equal(plans.length, 1)
  assert.match(plans[0].data.content[0].text, /tools\.mcp__docs__probe/)
  assert.deepEqual(owner.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    .map(event => event.data.reason.kind), ['completed', 'completed'])
})

test('a real step admits one capability set and every model-visible projection states it', { timeout: 20000 }, async t => {
  // The defect at the level the Host runs it. A step resolves its admission
  // (`tools.resolve`), renders its own `tools:sdk` from those definitions and builds the
  // program's `tools` members from the same admission, so a registered definition this
  // step does not deliver may reach no model-visible projection — and one session record
  // must withdraw a delivered capability from all of them at once.
  const { ctx } = host(t, 'ptc')
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
  // `withheld_capability` is registered and in the registered-definitions view, but the
  // step resolves its activation away, so no step delivers it. That difference between the
  // registry view and the admission is what the declaration must not paper over.
  let activated = false
  ctx.effect(() => ctx.tools.register(echo('kept_capability')))
  ctx.effect(() => ctx.tools.register(echo('withheld_capability'), { when: () => activated }))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'tool:kept_capability', order: 10, text: 'Kept guidance.' }))
  // The program reads the two surfaces a cell really has: the `tools` members it can call
  // and the metadata `capabilities.tree()` really states.
  const PROBE_PROGRAM = [
    'const tree = await capabilities.tree()',
    'return JSON.stringify({ members: Object.keys(tools).sort(), tree: tree.map(entry => [entry.namespace, entry.members]) })',
  ].join('\n')
  const requests = []
  const errors = []
  ctx.on('agent/error', payload => errors.push(payload.error))
  // Two steps per turn: the first asks for a cell, the second stops. The cell runs under
  // the admission the first step resolved, which is the only way to observe the delivered
  // set rather than the registry.
  async function* stream(options) {
    const index = requests.push(options) - 1
    if (index % 2 === 0) {
      const call = { id: `probe-cell-${index}`, type: 'tool-call', name: 'run_code',
        arguments: JSON.stringify({ code: PROBE_PROGRAM, description: 'Probe the delivered set' }) }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.provide('llm', { async prepareCall(config) { return { config, stream, adapterDefaults: {} } }, stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false, capabilityManagementEnabled: true,
    // Both definitions keep the Host's own presentation, which is the disclosure the
    // reported session used: the declaration keeps their Host signatures instead of
    // replacing them with session contracts.
    capabilityPolicy: JSON.stringify({ schema: 'ptc-capability-policy/v1',
      defaults: { availability: 'enabled', disclosure: 'host' }, categories: {}, mcpServers: {},
      items: { 'tools.kept_capability': { disclosure: 'host' }, 'tools.withheld_capability': { disclosure: 'host' } },
      allocation: { baseline: true, statistics: false, budget: true } }),
    capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }).await()
  // The Host's own rendering of the declaration, before this plugin projects it. Only a
  // request that carries an admission states a delivered set; the composition a pre-step
  // asks for carries none.
  const hostDeclarations = []
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const host = await next()
    if (context?.toolSet !== undefined) {
      hostDeclarations.push(named(sdkNames(host.sections.find(section => section.name === 'tools:sdk')?.text ?? '')))
    }
    return host
  })
  const owner = await ctx.agents.create({ sessionId: 'admitted-capability-set', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => owner.dispose())
  const agent = owner.agent
  const turn = async value => {
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }), 'next-turn', true)
    await agent.whenIdle()
  }
  // The two call transports are the channel a program is called through, not
  // capabilities, so they are left out of the set comparison.
  const transports = new Set(['run_code', 'edit_run_code'])
  const named = names => new Set([...names].filter(name => !transports.has(name)))
  /** The members a rendered `tools:sdk` block declares, one entry per top-level member. */
  const sdkNames = value => new Set([...value.matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*):/gmu)].map(match => match[1]))
  // The program's own answer for the turn that just ran: the members it can call and the
  // namespaces the explorer states. A cell is the only place both are real.
  const probes = []
  const readProbe = () => JSON.parse(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .at(-1).data.message.content.map(block => block.text).join(''))
  /** The system text the model reads on one request, section by section. */
  const systemText = index => (requests[index].messages.find(message => message.role === 'system')?.content ?? [])
    .map(block => block.text ?? '').join('\n')
  /** What one step states on each of the three surfaces. */
  const stated = step => ({
    declared: named(sdkNames(systemText(step * 2))),
    members: named(probes[step].members),
    explorable: named(probes[step].tree.find(entry => entry[0] === 'tools')?.[1] ?? []),
  })
  const planEntries = () => agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan')
    .at(-1)?.data.source.snapshot.plan.entries?.map(entry => entry.id) ?? []
  await turn('first')
  probes.push(readProbe())
  assert.deepEqual(errors, [])
  // The registry view still names the withheld definition: the equality below is a claim
  // about the admission, not about a registry that happened to be small.
  assert.equal(ctx.tools.schemas(agent).some(schema => schema.name === 'withheld_capability'), true,
    'the registered-definitions view names the definition no step delivers')
  const first = stated(0)
  assert.deepEqual(hostDeclarations[0], new Set(['kept_capability']),
    'the Host declares the definitions its own admission delivers')
  assert.deepEqual(first.declared, new Set(['kept_capability']), 'the declaration states the delivered member only')
  assert.deepEqual(first.members, new Set(['kept_capability']), 'the program exposes the delivered member only')
  assert.deepEqual(first.explorable, new Set(['kept_capability']), 'the explorer states the delivered member only')
  assert.deepEqual(first.declared, first.members, 'the declared set and the callable set are one set')
  assert.deepEqual(first.explorable, first.members, 'the explorable set and the callable set are one set')
  assert.equal(planEntries().includes('tools.withheld_capability'), false,
    'the composition states the capabilities this step delivers')
  assert.match(systemText(0), /Kept guidance\./u)
  // The user closes the delivered capability for this session. The record is the newest
  // statement, so the next step states it on no surface — and the re-render that the
  // closure forces must not pull back the definition this step withholds.
  agent.session.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.kept_capability': { availability: 'closed', disclosure: 'on-demand' } } }), { surfaceOp: 'append' })
  await turn('second')
  probes.push(readProbe())
  assert.deepEqual(errors, [])
  const second = stated(1)
  assert.deepEqual(second.declared, new Set(), 'the declaration states no capability this session closed')
  assert.deepEqual(second.members, new Set(), 'the program exposes no capability this session closed')
  assert.deepEqual(second.explorable, new Set(), 'the explorer states no capability this session closed')
  assert.equal(second.declared.has('withheld_capability'), false, 'the re-render does not declare a definition this step withholds')
  assert.equal(second.members.has('withheld_capability'), false)
  assert.equal(second.explorable.has('withheld_capability'), false)
  assert.doesNotMatch(systemText(2), /kept_capability/u, 'the closed capability leaves the model-visible text')
  assert.doesNotMatch(systemText(2), /Kept guidance\./u, 'its guidance section leaves with it')
  assert.equal(planEntries().includes('tools.withheld_capability'), false)
  // The delivered plans and their navigation text are a declaration too. What may still
  // name the closed capability is the record that closed it and the messages delivered
  // while it was open; a plan composed after the closure states the set that remains.
  const planTexts = agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan')
    .map(event => event.data.content.map(block => block.text).join(''))
  assert.equal(planTexts.length, 2, 'each composition delivers its own plan')
  assert.equal(planTexts.some(text => /withheld_capability/u.test(text)), false,
    'no delivered plan names a definition its step withholds')
  assert.doesNotMatch(planTexts.at(-1), /kept_capability/u,
    'the plan delivered after the closure states no capability this session closed')
  assert.equal(requests.length, 4, 'two steps per turn: the cell, then the stop')
})

test('the guidance section for a definition follows the step admission, not the registered definitions', { timeout: 20000 }, async t => {
  // A `tool:<name>` section is model-visible text about a capability: it tells the model what
  // to do with that tool. The declaration, the program members and the explorer state the
  // step's admission, and the composition is not rebuilt when the session decides nothing, so
  // a section taken from the composition stays after the capability left every other surface.
  // The same section has to come back on the step that delivers the definition: this is a
  // statement about the step, not a section deleted once.
  const { ctx } = host(t, 'ptc')
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
  let activated = false
  ctx.effect(() => ctx.tools.register(echo('always_capability')))
  ctx.effect(() => ctx.tools.register(echo('withheld_capability'), { when: () => activated }))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'tool:always_capability', order: 10, text: 'Always guidance.' }))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'tool:withheld_capability', order: 11, text: 'Withheld guidance.' }))
  const requests = []
  const errors = []
  ctx.on('agent/error', payload => errors.push(payload.error))
  async function* stream(options) {
    const index = requests.push(options) - 1
    if (index % 2 === 0) {
      const call = { id: `guidance-cell-${index}`, type: 'tool-call', name: 'run_code',
        arguments: JSON.stringify({ code: 'return 1', description: 'Run a cell' }) }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.provide('llm', { async prepareCall(config) { return { config, stream, adapterDefaults: {} } }, stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false, capabilityManagementEnabled: true,
    capabilityPolicy: JSON.stringify({ schema: 'ptc-capability-policy/v1',
      defaults: { availability: 'enabled', disclosure: 'host' }, categories: {}, mcpServers: {},
      items: { 'tools.always_capability': { disclosure: 'host' }, 'tools.withheld_capability': { disclosure: 'host' } },
      allocation: { baseline: true, statistics: false, budget: true } }),
    capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }).await()
  const owner = await ctx.agents.create({ sessionId: 'admitted-capability-guidance', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => owner.dispose())
  const agent = owner.agent
  const turn = async value => {
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }), 'next-turn', true)
    await agent.whenIdle()
  }
  /** The system text the model reads on one request. */
  const systemText = index => (requests[index].messages.find(message => message.role === 'system')?.content ?? [])
    .map(block => block.text ?? '').join('\n')
  /** The members a rendered `tools:sdk` block declares, one entry per top-level member. */
  const sdkNames = value => new Set([...value.matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*):/gmu)].map(match => match[1]))
  const transports = new Set(['run_code', 'edit_run_code'])
  const named = names => new Set([...names].filter(name => !transports.has(name)))
  await turn('first')
  assert.deepEqual(errors, [])
  // The registry still carries the definition; the step does not deliver it.
  assert.equal(ctx.tools.schemas(agent).some(schema => schema.name === 'withheld_capability'), true,
    'the registered-definitions view names the definition this step withholds')
  // Both steps of the turn, because the observation of the registry narrows and widens between
  // them: a later step must not state guidance the earlier step's admission withdrew.
  for (const step of [0, 1]) {
    assert.match(systemText(step), /Always guidance\./u, 'the guidance of a delivered capability stays')
    assert.doesNotMatch(systemText(step), /Withheld guidance\./u,
      `the guidance of a definition this step withholds leaves the model-visible text (step ${step + 1})`)
    assert.deepEqual(named(sdkNames(systemText(step))), new Set(['always_capability']),
      'the declaration states the delivered member only')
  }
  // The next step delivers the definition. The section returns because the step states it,
  // not because a composition or a record changed.
  activated = true
  await turn('second')
  assert.deepEqual(errors, [])
  for (const step of [2, 3]) {
    assert.match(systemText(step), /Withheld guidance\./u,
      'the guidance of a capability the step delivers is stated on that step')
    assert.match(systemText(step), /Always guidance\./u)
    assert.deepEqual(named(sdkNames(systemText(step))), new Set(['always_capability', 'withheld_capability']),
      'the declaration states every member the step delivers')
  }
  assert.equal(requests.length, 4, 'two steps per turn: the cell, then the stop')
})

test('the resource server directory states the operations the step delivers, not the composition', { timeout: 20000 }, async t => {
  // The `mcp-resource-servers` section names the servers a program may pass as the `server`
  // argument, and the three Host resource operations are the only members that take one. A
  // step may deliver less than the registry resolves — the Host admits a definition per step
  // — and the composition recorded while they were admitted is not rebuilt, because the
  // session decided nothing. The declaration, the program members and the explorer state that
  // step, so the directory — the one model-visible text that still lists the servers — states
  // it too, and returns on the step that delivers the operations again.
  const { ctx } = host(t, 'ptc')
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
  const operations = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
  let activated = true
  for (const name of operations) ctx.effect(() => ctx.tools.register(echo(name), { when: () => activated }))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'mcp-resource-servers', order: 20, interpolate: false,
    text: '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource '
      + 'with one of these names as the server argument: ["probe"].' }))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'mcp:probe', order: 21, interpolate: false, text: 'Probe server instructions.' }))
  const requests = []
  const errors = []
  ctx.on('agent/error', payload => errors.push(payload.error))
  async function* stream(options) {
    const index = requests.push(options) - 1
    if (index % 2 === 0) {
      const call = { id: `resource-directory-cell-${index}`, type: 'tool-call', name: 'run_code',
        arguments: JSON.stringify({ code: 'return 1', description: 'Run a cell' }) }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.provide('llm', { async prepareCall(config) { return { config, stream, adapterDefaults: {} } }, stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false, capabilityManagementEnabled: true,
    capabilityPolicy: JSON.stringify({ schema: 'ptc-capability-policy/v1',
      defaults: { availability: 'enabled', disclosure: 'host' }, categories: {}, mcpServers: {}, items: {},
      allocation: { baseline: true, statistics: false, budget: true } }),
    capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }).await()
  const owner = await ctx.agents.create({ sessionId: 'admitted-resource-directory', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => owner.dispose())
  const agent = owner.agent
  const turn = async value => {
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }), 'next-turn', true)
    await agent.whenIdle()
  }
  const systemText = index => (requests[index].messages.find(message => message.role === 'system')?.content ?? [])
    .map(block => block.text ?? '').join('\n')
  const sdkNames = value => new Set([...value.matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*):/gmu)].map(match => match[1]))
  const declares = index => [...sdkNames(systemText(index))].some(name => operations.includes(name))
  const planEntries = () => agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan')
    .at(-1)?.data.source.snapshot.plan.entries?.map(entry => entry.id) ?? []
  await turn('first')
  assert.deepEqual(errors, [])
  for (const step of [0, 1]) {
    assert.match(systemText(step), /as the server argument: \["probe"\]/u,
      `the directory names the server the step may name (step ${step + 1})`)
    assert.equal(declares(step), true, 'the declaration states the resource operations')
  }
  // The step's own answer: the Host admits no definition that takes a server name.
  activated = false
  await turn('second')
  assert.deepEqual(errors, [])
  assert.equal(ctx.tools.schemas(agent).some(schema => operations.includes(schema.name)), true,
    'the registered-definitions view still names the operations this step withholds')
  assert.equal(planEntries().includes('mcp.probe'), true,
    'the composition this session recorded still states the server row')
  // Both steps of the turn, because the registry re-read between them widens what the
  // session observed: a later step must not state a directory the earlier step withdrew.
  for (const step of [2, 3]) {
    assert.doesNotMatch(systemText(step), /as the server argument/u,
      `no operation of this step takes a server name, so the directory lists none (step ${step + 1})`)
    assert.equal(declares(step), false, 'the declaration states no operation this step withholds')
  }
  activated = true
  await turn('third')
  assert.deepEqual(errors, [])
  for (const step of [4, 5]) {
    assert.match(systemText(step), /as the server argument: \["probe"\]/u,
      `the directory returns on the step that delivers the operations (step ${step + 1})`)
    assert.equal(declares(step), true)
  }
  assert.equal(requests.length, 6, 'two steps per turn: the cell, then the stop')
})

test('a recorded server closure withdraws the rows, the guidance and the directory the server owns', { timeout: 20000 }, async t => {
  // One decision, four owners on the model-visible surface: a server's tool members
  // (`mcp__<server>__*`), the derived `mcp.<server>` row, the `mcp:<server>` instructions that
  // row depends on, and the `mcp-resource-servers` directory that names the server as the
  // argument of the three resource operations. None of them is a composition of its own, so
  // the record must reach all four in the same read — and the record names a *server*, not
  // those members, which is what makes the id resolution part of the invariant.
  const { ctx } = host(t, 'ptc')
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
  ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'mcp__probe__read', rawName: 'probe', description: 'Probe upstream MCP description.',
    inputSchema: { type: 'object' },
    async call() { return { content: [{ type: 'text', text: 'mcp reply' }] } },
  })))
  await ctx.plugin(McpResourceRuntime).await()
  ctx.mcpResources.register('probe', { async request(request) {
    return { method: request.method, resources: [{ uri: 'probe://item', name: 'Probe' }] }
  } })
  // The server's own instructions are the section its row depends on; the Host owns that text.
  ctx.effect(() => ctx.systemPrompt.section({ name: 'mcp:probe', order: 21, interpolate: false,
    text: 'Probe server instructions.' }))
  const requests = []
  const errors = []
  ctx.on('agent/error', payload => errors.push(payload.error))
  const PROBE_PROGRAM = [
    'const tree = (await capabilities.tree()).map(entry => [entry.namespace, entry.members])',
    'return JSON.stringify({',
    '  members: Object.keys(tools).sort(),',
    '  tools: tree.find(entry => entry[0] === "tools")?.[1] ?? [],',
    '  mcp: tree.find(entry => entry[0] === "mcp")?.[1] ?? [],',
    '})',
  ].join('\n')
  async function* stream(options) {
    const index = requests.push(options) - 1
    if (index % 2 === 0) {
      const call = { id: `server-closure-cell-${index}`, type: 'tool-call', name: 'run_code',
        arguments: JSON.stringify({ code: PROBE_PROGRAM, description: 'Probe the delivered set' }) }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.provide('llm', { async prepareCall(config) { return { config, stream, adapterDefaults: {} } }, stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false, capabilityManagementEnabled: true,
    capabilityPolicy: JSON.stringify({ schema: 'ptc-capability-policy/v1',
      defaults: { availability: 'enabled', disclosure: 'host' }, categories: {}, mcpServers: {}, items: {},
      allocation: { baseline: true, statistics: false, budget: true } }),
    capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }).await()
  const owner = await ctx.agents.create({ sessionId: 'recorded-server-closure', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => owner.dispose())
  const agent = owner.agent
  const turn = async value => {
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }), 'next-turn', true)
    await agent.whenIdle()
  }
  const systemText = index => (requests[index].messages.find(message => message.role === 'system')?.content ?? [])
    .map(block => block.text ?? '').join('\n')
  const sdkNames = value => new Set([...value.matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*):/gmu)].map(match => match[1]))
  const transports = new Set(['run_code', 'edit_run_code'])
  const named = names => new Set([...names].filter(name => !transports.has(name)))
  const probes = []
  const readProbe = () => JSON.parse(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .at(-1).data.message.content.map(block => block.text).join(''))
  const stated = (step, probe) => ({
    declared: named(sdkNames(systemText(step))),
    members: named(probe.members),
    explorable: named(probe.tools),
  })
  const deliveredPlan = () => agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan')
    .at(-1)?.data
  /** What the delivered plan states for one identity. */
  const planRow = id => deliveredPlan()?.source.snapshot.plan.entries?.find(entry => entry.id === id)
  await turn('first')
  probes.push(readProbe())
  assert.deepEqual(errors, [])
  const before = stated(0, probes[0])
  assert.equal(before.members.has('mcp__probe__read'), true, 'the program can call the server member before the closure')
  assert.deepEqual(before.declared, before.members, 'the declared set and the callable set are one set')
  assert.deepEqual(before.explorable, before.members, 'the explorable set and the callable set are one set')
  assert.deepEqual(probes[0].mcp, ['probe'], 'the explorer states the server row while the session has it')
  assert.match(systemText(0), /as the server argument: \["probe"\]/u, 'the directory names the server')
  assert.match(systemText(0), /Probe server instructions\./u, 'the server guidance is delivered with its row')
  assert.equal(planRow('mcp.probe')?.selection, 'host', 'the composition states the server row while the session has it')
  assert.equal(planRow('tools.mcp__probe__read')?.selection, 'host')
  // The user closes the server, not its members: every surface has to resolve the same name.
  agent.session.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'mcpServers.probe': { availability: 'closed' } } }), { surfaceOp: 'append' })
  await turn('second')
  probes.push(readProbe())
  assert.deepEqual(errors, [])
  assert.equal(ctx.tools.schemas(agent).some(schema => schema.name === 'mcp__probe__read'), true,
    'the registered-definitions view still names the member this session closed')
  const after = stated(2, probes[1])
  assert.equal(after.declared.has('mcp__probe__read'), false,
    'the declaration states no member of a server this session closed')
  assert.equal(after.members.has('mcp__probe__read'), false,
    'the program exposes no member of a server this session closed')
  assert.equal(after.explorable.has('mcp__probe__read'), false,
    'the explorer states no member of a server this session closed')
  assert.deepEqual(after.declared, after.members, 'the declared set and the callable set are one set after the closure')
  assert.deepEqual(after.explorable, after.members, 'the explorable set and the callable set are one set after the closure')
  assert.deepEqual(probes[1].mcp, [], 'no server row survives the closure of its only server')
  assert.doesNotMatch(systemText(2), /mcp__probe__read/u, 'the closed server member leaves the model-visible text')
  assert.doesNotMatch(systemText(2), /as the server argument/u, 'the directory names no server this session closed')
  assert.doesNotMatch(systemText(2), /Probe server instructions\./u, 'the server guidance leaves with the row that owned it')
  assert.doesNotMatch(systemText(3), /as the server argument|Probe server instructions\./u,
    'the following step of the same turn states the same closure')
  // The plan keeps the row the record decided about — that is what a refresh and the panel
  // read — and states the decision there instead of forgetting the row.
  assert.equal(planRow('mcp.probe')?.selection, 'closed',
    'the plan composed after the closure states the decision instead of forgetting the row')
  assert.equal(planRow('tools.mcp__probe__read')?.selection, 'closed')
  assert.equal(requests.length, 4, 'two steps per turn: the cell, then the stop')
})

test('capability commands advertise refresh input and apply through the public human-command runtime without model requests', async t => {
  const { ctx } = host(t, 'ptc')
  new CommandRuntime(ctx)
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  // A registry publishes its service when constructed, but registers the turn-boundary
  // projection every agent turn reads in its own init. Constructing it here keeps it
  // visible to the plugins mounted below; settling the init makes it usable.
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
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

for (const [config, state] of [
  [{ capabilityContextEnabled: false, capabilityManagementEnabled: true }, 'paused'],
  [{ capabilityContextEnabled: true, capabilityManagementEnabled: false }, 'off'],
]) test(`a refresh under a saved-off capability group reports the ${state} state instead of an update`, async t => {
  const { ctx } = host(t, 'ptc')
  new CommandRuntime(ctx)
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  // A registry publishes its service when constructed, but registers the turn-boundary
  // projection every agent turn reads in its own init. Constructing it here keeps it
  // visible to the plugins mounted below; settling the init makes it usable.
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
  let requests = 0
  ctx.provide('llm', { stream() { requests++; throw new Error('Human commands must not request a model') } })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false, ...config,
    capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }).await()
  const owner = await ctx.agents.create({ sessionId: `human-refresh-off-${state}`, meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => owner.dispose())
  const result = await ctx.commands.execute(owner.agent, '/capabilities refresh', [], signal())
  assert.equal(result.result.kind, 'success')
  const receipt = readCapabilityCommandReceipt(result.result.text)
  assert.equal(receipt.state, state)
  assert.equal(requests, 0)
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
  // The registry registers its turn-boundary projection in Service.init, and an agent
  // turn reads it; the projection owner above must exist before that init settles.
  await settleService(ctx.agents)
  await ctx.plugin(SessionQueryEngine).await()
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


test('session catalog reports a globally enabled binding entry as a v2 row through the entry point reader', async t => {
  // The entry point wires `readUserBindings: () => userBindings.list()`, so the
  // catalogue is built from the store's own entries. A v2 row exists only for an
  // entry this session can use: a withheld entry has no row at all, and what the
  // session inherits is the global switch `config.bindingsEnabled`.
  const root = await mkdtemp(join(tmpdir(), 'ptc-plus-entry-bindings-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'ptc-plus'), { recursive: true })
  await writeFile(join(root, 'ptc-plus', 'bindings.json'), JSON.stringify({ entries: [
    { id: 'alpha', name: 'alphaHelpers', scope: 'namespace', purpose: 'Alpha helpers.', enabled: true,
      source: 'export const alpha = 1' },
    { id: 'beta', name: 'betaHelpers', scope: 'namespace', purpose: 'Beta helpers.', enabled: false,
      source: 'export const beta = 2' },
  ] }))
  const { ctx } = host(t, 'ptc')
  new CommandRuntime(ctx)
  new AgentRegistry(ctx)
  new SessionProjectionRegistry(ctx)
  ctx.agents.list = () => []
  // The session is cold, so its supply is the plan its log holds; this test states the
  // binding rows, so the recorded plan declares no capability.
  const plan = await recordedPlanMessage(t, { sessionId: 'entry-binding-session', schemas: [] })
  ctx.provide('sessionQuery', { observeSession: async () => ({ header: { cwd: process.cwd() }, cursor: 1,
    events: [planEvent(plan)], [Symbol.dispose]() {} }) })
  const operations = new Map()
  ctx.provide('ptcPlusRpc', { register(contract, handler) {
    operations.set(contract.service, handler); return () => operations.delete(contract.service)
  } })
  await ctx.plugin(ptcPlus, { userBindingsEnabled: true, cordisToolsEnabled: false,
    capabilityManagementEnabled: true }).await()
  const result = await operations.get('ptcPlusCapabilities')('session-catalog', { sessionId: 'entry-binding-session' }, signal())
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.value).sort(), ['config', 'rows', 'schema', 'sessionId'],
    'the v2 catalogue is the whole shape: no live state or bindings group survives beside it')
  assert.equal(result.value.schema, 'ptc-capability-session-catalog/v2')
  assert.equal(result.value.sessionId, 'entry-binding-session')
  assert.deepEqual(result.value.config, { bindingsEnabled: true })
  assert.deepEqual(result.value.rows.filter(row => row.kind === 'binding').map(row => ({ id: row.id, name: row.name })), [
    { id: 'alpha', name: 'alphaHelpers' },
  ], 'only the enabled entry has a row; a withheld entry is absent rather than reported as off')
})

test('the session catalogue and /capabilities list state the same ids for a session with no live runtime', async t => {
  // Both surfaces answer one read: the session's log, the supply it was declared and the
  // saved configuration. This Host holds no agent at all, so the supply is the face the
  // session's recorded plan froze — and the two surfaces still agree id for id, in the
  // same order, because both project one row set.
  const sessionId = 'cold-capability-list'
  const session = Session.create(sessionId)
  // The recorded plan names a tool this Host's own tool registry does not declare, so a
  // cold read that answered with the Host plane instead of the record would state a
  // smaller face and fail the id comparison below.
  const plan = await recordedPlanMessage(t, { sessionId, schemas: ['probe', 'preset_only'] })
  const { ctx } = host(t, 'ptc')
  new AgentRegistry(ctx)
  new SessionProjectionRegistry(ctx)
  ctx.agents.list = () => []
  ctx.provide('sessionQuery', { observeSession: async () => ({ header: session.header, cursor: 0,
    events: [planEvent(plan)], [Symbol.dispose]() {} }) })
  const operations = new Map()
  ctx.provide('ptcPlusRpc', { register(contract, handler) {
    operations.set(contract.service, handler); return () => operations.delete(contract.service)
  } })
  let command
  ctx.provide('commands', { register(definition) { command = definition; return () => {} } })
  ctx.effect(() => ctx.tools.register(echo('probe')))
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false,
    capabilityManagementEnabled: true }).await()
  const panel = await operations.get('ptcPlusCapabilities')('session-catalog', { sessionId }, signal())
  assert.equal(panel.ok, true)
  assert.deepEqual(panel.value.rows.map(row => row.id), ['tools.probe', 'tools.preset_only'])
  // The command receives an agent handle because the Host calls commands that way; it
  // names a session and asks the catalogue for nothing else.
  const listing = await command.handler({ commandId: 'cold-capability-list', rawInput: 'list all',
    agent: { session: { id: sessionId } }, signal: signal() })
  assert.equal(listing.kind, 'success')
  const entries = JSON.parse(listing.text).entries
  assert.deepEqual(entries.map(entry => entry.id), panel.value.rows.filter(row => row.kind !== 'binding').map(row => row.id),
    'one read, one row set: the listing and the panel state the same ids in the same order')
  assert.equal(entries.every(entry => entry.saved !== undefined && entry.effective === undefined), true,
    'the listing states the saved column and no composition')
})

test('the session catalogue and /capabilities list state the same dimensions for one recorded choice', async t => {
  // One read, two surfaces, one statement. The panel states availability and disclosure
  // side by side, so a listing that compressed a row into one word would answer for the
  // dimension it dropped: a session that recorded disclosure alone would read as having
  // recorded nothing at all.
  const sessionId = 'two-dimension-listing'
  const session = Session.create(sessionId)
  // The record carries a tool the Host's registry does not declare: the row set below
  // can only come from the frozen plan.
  const plan = await recordedPlanMessage(t, { sessionId, schemas: ['probe', 'preset_only'] })
  const events = [planEvent(plan), { type: 'user/message', seq: 1, data: capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.probe': { disclosure: 'full' } } }) }]
  const { ctx } = host(t, 'ptc')
  new AgentRegistry(ctx)
  new SessionProjectionRegistry(ctx)
  ctx.agents.list = () => []
  ctx.provide('sessionQuery', { observeSession: async () => ({ header: session.header, cursor: events.length, events,
    [Symbol.dispose]() {} }) })
  const operations = new Map()
  ctx.provide('ptcPlusRpc', { register(contract, handler) {
    operations.set(contract.service, handler); return () => operations.delete(contract.service)
  } })
  let command
  ctx.provide('commands', { register(definition) { command = definition; return () => {} } })
  ctx.effect(() => ctx.tools.register(echo('probe')))
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false,
    capabilityManagementEnabled: true,
    capabilityPolicy: JSON.stringify({ schema: 'ptc-capability-policy/v1',
      defaults: { availability: 'enabled', disclosure: 'host' }, categories: {}, mcpServers: {},
      items: { 'tools.probe': { disclosure: 'full' } },
      allocation: { baseline: true, statistics: false, budget: true } }) }).await()
  const panel = await operations.get('ptcPlusCapabilities')('session-catalog', { sessionId }, signal())
  assert.equal(panel.ok, true)
  const row = panel.value.rows.find(item => item.id === 'tools.probe')
  // The saved column states the words the document wrote for this object: its one rule is the
  // disclosure, so availability reads `automatic` even though the document's bottom layer would
  // answer it at runtime. The session column states the disclosure this session recorded and
  // `inherit` for the availability it never decided.
  assert.deepEqual(row.saved, { availability: 'automatic', disclosure: 'full' })
  assert.deepEqual(row.session, { availability: 'inherit', disclosure: 'full' })
  const listing = await command.handler({ commandId: 'two-dimension-list', rawInput: 'list tools probe',
    agent: { session: { id: sessionId } }, signal: signal() })
  assert.equal(listing.kind, 'success')
  const [entry] = JSON.parse(listing.text).entries
  assert.equal(entry.temporary.disclosure, 'full',
    'the recorded disclosure is stated instead of the availability this session never recorded')
  assert.deepEqual(entry.temporary, row.session, 'the listing answers the panel\'s recorded column')
  assert.deepEqual(entry.saved, row.saved, 'the listing answers the panel\'s saved column')
})

test('a capability observation assembles the session scope without preparing the transport', async t => {
  // A live session's declaration is read through the public assembly, so that read must
  // stay passive: it contributes the scope's sections and leaves the model-facing
  // transport exactly as the Host published it. Opening a read may not install or
  // re-apply the runtime bridge.
  const { ctx, agent } = host(t, 'ptc')
  new AgentRegistry(ctx)
  ctx.agents.list = () => []
  const operations = new Map()
  ctx.provide('ptcPlusRpc', { register(contract, handler) {
    operations.set(contract.service, handler); return () => operations.delete(contract.service)
  } })
  await ctx.plugin(ptcPlus, { userBindingsEnabled: false, cordisToolsEnabled: false,
    capabilityManagementEnabled: true }).await()
  // The session becomes live only after the plugin installed, so the read below is the
  // first assembly that could prepare this transport.
  ctx.agents.list = () => [agent]
  // A PTC-mode Host keeps its reserved transport in the executor it dispatches through
  // rather than registering it as a visible tool, so the read states that surface.
  const definition = hostTransportDefinition(ctx.tools, agent, 'run_code')
  assert.ok(definition, 'the ptc-mode Host publishes the reserved transport')
  const projection = definition.output.presentationMeta
  const panel = await operations.get('ptcPlusCapabilities')('session-catalog', { sessionId: agent.session.id }, signal())
  assert.equal(panel.ok, true)
  assert.equal(hostTransportDefinition(ctx.tools, agent, 'run_code').output.presentationMeta, projection,
    'the observation must not re-apply the model-facing transport projection')
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
