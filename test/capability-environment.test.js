import { CONFIG_DEFAULTS } from '../internal/config-spec.js'
import { PLAN_NAVIGATION, PLAN_OVERAGE, PLAN_OVERAGE_HOLE } from '../internal/prompt-text.js'
import { createCapabilityPlan } from '../internal/capability-plan.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { McpResourceRuntime } from '@deepseek-ai/dsh-mcp-resources'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { capabilityCommandReceipt } from '../internal/capability-command-receipt.js'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as skillTool from '@deepseek-ai/dsh-tool-skill'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool, renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { createCapabilityEnvironment as createEnvironment, capabilityPlanText, capabilityPlanTextFromMessage, CAPABILITY_PLAN_FORM, readCapabilityContextMessage, sessionCapabilitySettings } from '../internal/capability-environment.js'
import { capabilityInspect, capabilitySearch, toolCapabilityMetadata, toolSdkSchemas } from '../internal/program-bindings.js'
import { appendOnlySession } from './plugin-fixture.js'
import { BINDING_ADOPTION_SCHEMA, bindingAdoptionMessage } from '../internal/binding-adoption.js'
import { CAPABILITY_SELECTION_FORM, CAPABILITY_SELECTION_SCHEMA, capabilitySelectionMessage, capabilitySelectionOf } from '../internal/capability-selection.js'
import { UserBindingsStore } from '../internal/user-bindings-store.js'
import { runtimeAvailabilityMessage } from '../internal/runtime-messages.js'
import { capabilityProfileConfiguration } from '../internal/runtime-config.js'
import { CapabilityStatisticsStore } from '../internal/capability-statistics-store.js'

// Repository test readers supply the immutable public-query cut; production
// observes it through sessionQuery rather than deprecated synchronous readers.
const createCapabilityEnvironment = options => createEnvironment({ ...options,
  sessionHistoryForAgent: async agent => ({ events: agent.session.snapshotEvents?.() ?? agent.session.events ?? [] }),
})

const config = overrides => ({ capabilityManagementEnabled: true,
  capabilityBaseline: '[]', capabilityOverrides: JSON.stringify(overrides ?? {}),
  capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
  capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 })
const schema = name => ({ name, description: `Owner contract for ${name}.`, parameters: { type: 'object' }, output: { type: 'string' } })
const sections = [{ name: 'tools:sdk', text: 'native sdk' }, { name: 'tool:closed_capability', text: 'closed guidance' }]
const agentFor = (session, id = session.id) => ({ id, session, signal: new AbortController().signal })

test('session catalog lists every supplied row with its saved and recorded columns and writes nothing', async t => {
  const session = Session.create('observed-session')
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: config({ 'tools.probe': 'full' }),
    toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('other')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agents[0], [])
  // The saved column is the configuration's answer and the session column is this
  // session's own record, so the record is written as one: a session that recorded a
  // choice is answered from the record, and the plan it delivered is not read in the
  // record's place.
  session.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.probe': { availability: 'closed', disclosure: 'on-demand' } } }), { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'proved', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'proved', isError: false,
    content: [{ type: 'text', text: 'ok' }] }), meta: { dshPtcPlusCapabilities: { schema: 'ptc-capability-evidence/v1',
    planDigest: 'fixture', expanded: [], used: ['tools.probe'] } } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const before = session.snapshotEvents().length
  const catalog = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  assert.equal(catalog.schema, 'ptc-capability-session-catalog/v2')
  assert.equal(catalog.sessionId, session.id)
  // The row set is the Host's declaration alone: two tools, one of them carrying
  // the evidence of a completed execution in this session.
  assert.deepEqual(catalog.rows.map(row => row.id), ['tools.probe', 'tools.other'])
  assert.deepEqual(catalog.rows.map(row => ({ id: row.id, kind: row.kind, saved: row.saved, session: row.session,
    evidence: row.evidence })), [
    { id: 'tools.probe', kind: 'capability', saved: { availability: 'enabled', disclosure: 'full' },
      session: { availability: 'closed', disclosure: 'on-demand' }, evidence: true },
    { id: 'tools.other', kind: 'capability', saved: { availability: 'automatic', disclosure: 'automatic' },
      session: { availability: 'inherit', disclosure: 'inherit' }, evidence: false },
  ])
  assert.deepEqual(catalog.config, { bindingsEnabled: false })
  assert.equal(session.snapshotEvents().length, before, 'The read must not append a command or a model message.')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(env.describeSessionCatalog({ sessionId: session.id }, controller.signal), /abort/i)
  // A session whose log cannot be reached is a failed read with its own error, never
  // an empty table that reads as "the Host declares nothing".
  await assert.rejects(env.describeSessionCatalog({ sessionId: 'missing' }),
    /session catalogue needs this session's log/)
})

const bindingSupply = entries => async () => ({ revision: 3, path: '/tmp/ptc-plus/bindings.json',
  entries: entries.map(entry => ({ scope: 'namespace', purpose: '', declaration: '',
    symbols: [entry.id], origin: 'global', ...entry })) })

test('session catalog lists a supplied binding entry and leaves a withheld one out', async t => {
  const agents = [agentFor(Session.create('binding-rows-session'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: true },
    toolSchemasForAgent: () => [schema('run_code')],
    readUserBindings: bindingSupply([
      { id: 'alpha', name: 'alphaHelpers', enabled: true },
      { id: 'beta', name: 'betaHelpers', enabled: false },
    ]) })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: agents[0].session.id }, agents[0].signal)
  assert.equal(catalog.schema, 'ptc-capability-session-catalog/v2')
  // A withheld entry is not supplied to this session, so it is not a row: a row whose
  // only possible control is one that cannot work is what the contract removes.
  assert.deepEqual(catalog.rows.filter(row => row.kind === 'binding')
    .map(row => ({ id: row.id, use: row.session.use })), [{ id: 'alpha', use: 'use' }])
  assert.deepEqual(catalog.config, { bindingsEnabled: true })
})

test('session catalog marks the binding entry this session declined, and leaves the others in use', async t => {
  const session = Session.create('binding-declined-session')
  session.append('user/message', bindingAdoptionMessage({ schema: BINDING_ADOPTION_SCHEMA, declined: ['alpha'] }),
    { surfaceOp: 'append' })
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: true },
    toolSchemasForAgent: () => [schema('run_code')],
    readUserBindings: bindingSupply([
      { id: 'alpha', name: 'alphaHelpers', enabled: true },
      { id: 'beta', name: 'betaHelpers', enabled: true },
    ]) })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  // One bit, one row: the entry this session declined reads `skip`, the other `use`.
  assert.deepEqual(catalog.rows.map(row => ({ id: row.id, kind: row.kind, use: row.session.use })),
    [{ id: 'alpha', kind: 'binding', use: 'skip' }, { id: 'beta', kind: 'binding', use: 'use' }])
})

test('session catalog lists no binding row while global bindings are off and keeps the capability rows', async t => {
  const agents = [agentFor(Session.create('binding-supply-off-session'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  let reads = 0
  const reader = bindingSupply([{ id: 'alpha', name: 'alphaHelpers', enabled: true }])
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: false },
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')],
    readUserBindings: async () => { reads++; return reader() } })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: agents[0].session.id }, agents[0].signal)
  // The switch decides whether the binding supply exists at all, never what a row
  // says: no binding row is listed and the store is not even read. The capability
  // rows are the Host's declaration and do not follow a binding switch.
  assert.deepEqual(catalog.rows.filter(row => row.kind === 'binding'), [])
  assert.equal(catalog.config.bindingsEnabled, false)
  assert.equal(reads, 0)
  assert.deepEqual(catalog.rows.map(row => ({ id: row.id, kind: row.kind })), [{ id: 'tools.probe', kind: 'capability' }])
})

test('session catalog fails as a whole when the binding supply cannot be read', async t => {
  const agents = [agentFor(Session.create('binding-supply-unreadable-session'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: true },
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')],
    readUserBindings: async () => { throw new Error('bindings document unreadable') } })
  t.after(() => env.dispose())
  // No partial success: a source that cannot be read fails the read with that error,
  // because rows that silently went missing are a screen that lies.
  await assert.rejects(env.describeSessionCatalog({ sessionId: agents[0].session.id }, agents[0].signal),
    /bindings document unreadable/)
})

test('session catalog lists the same rows for a session with no live runtime', async t => {
  // A session the Host no longer holds states the face its recorded plan froze: the
  // same rows the live read states, taken from the record instead of from the scope.
  const session = Session.create('unobserved-session')
  session.append('user/message', bindingAdoptionMessage({ schema: BINDING_ADOPTION_SCHEMA, declined: ['beta'] }),
    { surfaceOp: 'append' })
  const live = [agentFor(session)]
  const ctx = { agents: { list: () => live }, systemPrompt: { assemble: async () => ({ sections: [] }) },
    sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
      events: session.snapshotEvents(), [Symbol.dispose]() {} }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: true },
    // The registry answers a wider view inside the session's scope, so a cold read that
    // fell back to the Host plane would state fewer tools than the session had.
    toolSchemasForAgent: agent => agent === undefined
      ? [schema('run_code'), schema('probe')] : [schema('run_code'), schema('probe'), schema('preset_only')],
    readUserBindings: bindingSupply([
      { id: 'alpha', name: 'alphaHelpers', enabled: true },
      { id: 'beta', name: 'betaHelpers', enabled: true },
    ]) })
  t.after(() => env.dispose())
  await acceptPreparation(env, live[0], [])
  const observed = await env.describeSessionCatalog({ sessionId: 'unobserved-session' }, live[0].signal)
  live.length = 0
  const cold = await env.describeSessionCatalog({ sessionId: 'unobserved-session' }, new AbortController().signal)
  assert.ok(cold.rows.length > 0)
  // The core falsification: the scope is gone and the rows are the ones the record
  // holds, not a narrower Host declaration that would silently drop the session layer.
  assert.deepEqual(cold.rows, observed.rows)
  assert.deepEqual(cold.rows.map(row => ({ id: row.id, kind: row.kind })),
    [{ id: 'tools.probe', kind: 'capability' }, { id: 'tools.preset_only', kind: 'capability' },
      { id: 'alpha', kind: 'binding' }, { id: 'beta', kind: 'binding' }])
  assert.deepEqual(cold.rows.filter(row => row.kind === 'binding').map(row => ({ id: row.id, use: row.session.use })),
    [{ id: 'alpha', use: 'use' }, { id: 'beta', use: 'skip' }])
})

test('session capability controls still list the capability catalogue when the session has no live runtime', async t => {
  // A session the Host no longer holds has no scope to observe; the plan it recorded
  // is the only statement of what it was supplied. Reading that record answers the
  // same catalogue, and reading it touches no declaration source at all.
  const skill = { name: 'review', provider: 'workspace', source: 'fixture', description: 'Review Skill',
    rank: 100, locator: '/tmp/workspace', invocation: { modelInvocable: true, userInvocable: false } }
  const sections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' },
    { name: 'mcp:docs', text: 'Docs server' }]
  let reads = 0
  const agents = []
  const session = Session.create('cold-plan-session')
  agents.push(agentFor(session))
  const ctx = { agents: { list: () => agents },
    skills: { snapshot: async () => { reads++; return { skills: [skill], complete: true } } },
    systemPrompt: { assemble: async () => { reads++; return { sections } } },
    sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
      events: session.snapshotEvents(), [Symbol.dispose]() {} }) } }
  const env = createCapabilityEnvironment({ ctx, config: config(),
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agents[0], sections)
  agents.length = 0
  const observedSources = reads
  const catalog = await env.describeSessionCatalog({ sessionId: session.id })
  // The Host plane answers fewer rows than this session had, so it is not a fallback
  // here: a cold session reads no declaration source, only the record it froze.
  assert.equal(reads, observedSources, 'a cold session must not read a declaration source in place of its record')
  // Real ids, not merely "not empty": the tool, the Skill, the resource server and
  // the MCP server row the record holds. A catalogue that lists nothing is the
  // state this test forbids, and the server row is not a capability.
  assert.ok(catalog.rows.length > 0)
  assert.ok(catalog.rows.some(row => row.kind === 'capability'))
  assert.deepEqual(catalog.rows.map(row => row.id).sort(),
    ['mcp.docs', 'mcpServers.docs', 'skills.review', 'tools.probe'])
  assert.deepEqual(catalog.rows.map(row => row.kind).sort(), ['capability', 'capability', 'capability', 'server'])
  // Name and source are the ones the recorded capability states: the tool names its
  // schema, the Skill its selector, and the resource row the server it belongs to.
  assert.deepEqual(catalog.rows.filter(row => row.kind === 'capability').map(row => ({ id: row.id, name: row.name, source: row.source })),
    [{ id: 'tools.probe', name: 'probe', source: { kind: 'host' } },
      { id: 'skills.review', name: 'review', source: { kind: 'skill' } },
      { id: 'mcp.docs', name: 'docs', source: { kind: 'mcp', server: 'docs' } }])
  // A session that recorded no decision inherits the saved column in every row
  // rather than reporting the catalogue as never observed.
  assert.ok(catalog.rows.every(row => row.session.availability === 'inherit' && row.session.disclosure === 'inherit'))
  // The same read for a session that recorded a decision before its runtime went
  // away: the per-session column states what that record says.
  const recordedSession = Session.create('recorded-cold-session')
  recordedSession.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.probe': { availability: 'closed' } } }), { surfaceOp: 'append' })
  const recordedAgents = [agentFor(recordedSession)]
  const recorded = createCapabilityEnvironment({ config: config({ 'tools.probe': 'full' }),
    ctx: { agents: { list: () => recordedAgents }, systemPrompt: { assemble: async () => ({ sections: [] }) },
      sessionQuery: { observeSession: async () => ({ header: recordedSession.header, cursor: recordedSession.seq - 1,
        events: recordedSession.snapshotEvents(), [Symbol.dispose]() {} }) } },
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => recorded.dispose())
  await acceptPreparation(recorded, recordedAgents[0], [])
  recordedAgents.length = 0
  const observed = await recorded.describeSessionCatalog({ sessionId: recordedSession.id })
  // Two sources, one row: the saved column is the configuration's answer and the
  // session column is the record's, and neither is read from the other.
  assert.deepEqual(observed.rows.find(row => row.id === 'tools.probe').saved,
    { availability: 'enabled', disclosure: 'full' })
  assert.deepEqual(observed.rows.find(row => row.id === 'tools.probe').session,
    { availability: 'closed', disclosure: 'inherit' })
})

test('session catalog states a damaged adoption record on the binding rows it still lists', async t => {
  // The newest statement is the session's current decision. A record this build
  // cannot read therefore supersedes the earlier one instead of silently falling
  // back to it: no row may claim `use` on the strength of a superseded record.
  const session = Session.create('binding-adoption-unreadable-session')
  const older = bindingAdoptionMessage({ schema: BINDING_ADOPTION_SCHEMA, declined: ['beta'] })
  // The declaration is an adoption statement, and the decision it states says to
  // decline `alpha`; the damage is that its text can no longer be resolved.
  const newest = createUserMessage({
    source: { kind: 'plugin:ptc-plus', form: 'binding-adoption' },
    content: [{ type: 'text', text: 'PTC Plus session binding adoption. Declined entry IDs: damaged' }],
  })
  session.append('user/message', older, { surfaceOp: 'append' })
  session.append('user/message', newest, { surfaceOp: 'append' })
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: true },
    toolSchemasForAgent: () => [schema('run_code')],
    readUserBindings: bindingSupply([
      { id: 'alpha', name: 'alphaHelpers', enabled: true },
      { id: 'beta', name: 'betaHelpers', enabled: true },
    ]) })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  // Both rows are still listed and still carry a control: the record is what is
  // damaged, not the row. Reading them from the older record would answer `use`
  // for `alpha` on evidence the session replaced.
  assert.deepEqual(catalog.rows.filter(row => row.kind === 'binding').map(row => ({ id: row.id, use: row.session.use })),
    [{ id: 'alpha', use: 'damaged' }, { id: 'beta', use: 'damaged' }])
})

test('session catalog leaves a disabled binding entry out of the rows read through the user bindings store list()', async t => {
  // The entry point supplies `() => userBindings.list()`, so the panel read is bound
  // to that owner contract rather than to `describe()` (which answers before the
  // first load) or `snapshot()` (which drops what `list()` reports).
  const directory = await mkdtemp(join(tmpdir(), 'ptc-plus-binding-supply-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'bindings.json')
  await writeFile(filename, JSON.stringify({ entries: [
    { id: 'alpha', name: 'alphaHelpers', scope: 'namespace', purpose: 'Alpha helpers.', enabled: true,
      source: 'export const alpha = 1' },
    { id: 'beta', name: 'betaHelpers', scope: 'namespace', purpose: 'Beta helpers.', enabled: false,
      source: 'export const beta = 2' },
  ] }))
  const store = new UserBindingsStore({ filename })
  const agents = [agentFor(Session.create('binding-store-session'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: true },
    toolSchemasForAgent: () => [schema('run_code')], readUserBindings: () => store.list() })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: agents[0].session.id }, agents[0].signal)
  // A disabled entry is not supplied to the session, so it is not a row: a row whose
  // only possible control cannot work is exactly what the contract removes.
  assert.deepEqual(catalog.rows.map(row => ({ id: row.id, kind: row.kind, name: row.name, use: row.session.use })),
    [{ id: 'alpha', kind: 'binding', name: 'alphaHelpers', use: 'use' }])
})

test('session catalog reports a readable but empty binding supply as no binding row', async t => {
  // The most common store state -- bindings enabled, no document yet -- supplies
  // nothing. It stays an empty row set with no failure, so "the Host supplied no
  // binding" never collapses into "the binding supply cannot be read".
  const agents = [agentFor(Session.create('binding-empty-session'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), userBindingsEnabled: true },
    toolSchemasForAgent: () => [schema('run_code')],
    readUserBindings: async () => ({ revision: 1, path: '/tmp/ptc-plus/bindings.json', entries: [] }) })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: agents[0].session.id }, agents[0].signal)
  assert.deepEqual(catalog.rows.filter(row => row.kind === 'binding'), [])
  assert.equal(catalog.config.bindingsEnabled, true)
})

test('session catalog moves only the saved column when the saved configuration or a group switch changes', async t => {
  const session = Session.create('saved-off-catalog')
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const schemas = [schema('run_code'), schema('probe'), schema('other')]
  const make = settings => { const env = createCapabilityEnvironment({ ctx, config: settings, toolSchemasForAgent: () => schemas })
    t.after(() => env.dispose()); return env }
  const enabled = make(config({ 'tools.probe': 'full' }))
  await acceptPreparation(enabled, agents[0], [])
  session.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.probe': { disclosure: 'on-demand' } } }), { surfaceOp: 'append' })
  const baseline = await enabled.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  const shape = rows => ({ ids: rows.map(row => row.id), kinds: rows.map(row => row.kind) })
  // A group switch is not a row fact: neither of them adds, removes or re-states a
  // row, whatever it decides about the stored default it governs.
  for (const setting of [{ capabilityContextEnabled: false }, { capabilityManagementEnabled: false }]) {
    const env = make({ ...config({ 'tools.probe': 'full' }), ...setting })
    assert.equal(env.describe(agents[0]).configured.enabled, setting.capabilityManagementEnabled !== false,
      'the flipped switch must really differ from the baseline')
    const catalog = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
    assert.deepEqual(catalog.rows, baseline.rows)
  }
  // A saved value that really changed moves the saved column only.
  const savedOff = make(config())
  const catalog = await savedOff.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  assert.deepEqual(shape(catalog.rows), shape(baseline.rows))
  assert.deepEqual(catalog.rows.find(row => row.id === 'tools.probe').saved,
    { availability: 'automatic', disclosure: 'automatic' })
  assert.deepEqual(catalog.rows.find(row => row.id === 'tools.probe').session,
    baseline.rows.find(row => row.id === 'tools.probe').session)
})

// The panel states supply, records and evidence, never materialization: the two
// groups that pinned a frozen plan's source and closure (opposite global save
// without refresh) and the historical v1/v2 scalar policy readings have no `rows`
// to assert, because a plan is built by the runtime before execution and this
// response does not carry one. The panel does not state materialization; see the
// contract's §0 non-goal.

test('a session whose frozen policy predates the saved one still lists the declared server row and states today\'s saved column', async t => {
  const hostSections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' }, { name: 'mcp:docs', text: 'Docs server' }]
  const schemas = ['run_code', 'mcp__docs__search', 'read_mcp_resource'].map(schema)
  const agent = agentFor(Session.create('mixed-disabled-management'))
  const ctx = { agents: { list: () => [agent] }, systemPrompt: { assemble: async () => ({ sections: hostSections }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config({ 'mcpServers.docs': 'closed' }), capabilityManagementEnabled: false },
    toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, hostSections)
  assert.equal(env.stateFor(agent).snapshot.schema, 'ptc-capability-environment/v1')
  // The saved configuration moves under a session that composed from an older one.
  // The row states both facts separately: the saved column is the configuration as it
  // stands now, and the session column is this session's own record, which is empty.
  env.reconfigure(composedConfig())
  const before = agent.session.snapshotEvents()
  const server = (await env.describeSessionCatalog({ sessionId: agent.session.id }, agent.signal))
    .rows.find(row => row.id === 'mcpServers.docs')
  assert.equal(server.kind, 'server')
  assert.deepEqual(server.saved, { availability: 'automatic', disclosure: 'automatic' })
  assert.deepEqual(server.session, { availability: 'inherit', disclosure: 'inherit' })
  assert.equal(Object.hasOwn(server, 'effective'), false, 'the listing states no composition')
  // The frozen composition is untouched by the read: it still supplies both members.
  assert.deepEqual(env.projectMembers(agent, ['mcp__docs__search', 'read_mcp_resource']), ['mcp__docs__search', 'read_mcp_resource'])
  assert.deepEqual(agent.session.snapshotEvents(), before)
})

test('a paused session catalog states each configured and recorded value without a negative word', async t => {
  const hostSections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' }, { name: 'mcp:docs', text: 'Docs server' }]
  const schemas = ['run_code', 'probe', 'mcp__docs__search', 'read_mcp_resource'].map(schema)
  const agent = agentFor(Session.create('paused-catalog'))
  const ctx = { agents: { list: () => [agent] }, systemPrompt: { assemble: async () => ({ sections: hostSections }) } }
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.probe'] = { availability: 'closed', disclosure: 'full' }
  policy.mcpServers.docs = { availability: 'enabled', disclosure: 'on-demand' }
  const env = createCapabilityEnvironment({ ctx, config: composedConfig(policy, { capabilityContextEnabled: false }),
    toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, hostSections)
  agent.session.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.probe': { availability: 'enabled' }, 'mcpServers.docs': { availability: 'closed' } } }),
    { surfaceOp: 'append' })
  const catalog = await env.describeSessionCatalog({ sessionId: agent.session.id }, agent.signal)
  assert.ok(catalog.rows.length > 0)
  // Every column states a fact from its own source: the saved value is the policy's
  // and the session value is the record's (or `inherit` where nothing was recorded).
  const availability = new Set(['enabled', 'closed', 'automatic', 'inherit'])
  const disclosure = new Set(['host', 'full', 'on-demand', 'adaptive', 'automatic', 'inherit'])
  for (const row of catalog.rows) {
    assert.ok(availability.has(row.saved.availability), `${row.id} saved.availability`)
    assert.ok(availability.has(row.session.availability), `${row.id} session.availability`)
    assert.ok(disclosure.has(row.saved.disclosure), `${row.id} saved.disclosure`)
    assert.ok(disclosure.has(row.session.disclosure), `${row.id} session.disclosure`)
  }
  const row = id => catalog.rows.find(candidate => candidate.id === id)
  assert.deepEqual(row('tools.probe').saved, { availability: 'closed', disclosure: 'full' })
  assert.deepEqual(row('tools.probe').session, { availability: 'enabled', disclosure: 'inherit' })
  assert.deepEqual(row('mcpServers.docs').saved, { availability: 'enabled', disclosure: 'on-demand' })
  assert.deepEqual(row('mcpServers.docs').session, { availability: 'closed', disclosure: 'inherit' })
  assert.deepEqual(row('tools.mcp__docs__search').session, { availability: 'inherit', disclosure: 'inherit' })
  // No value is a translation of "the panel cannot say": the whole response is free
  // of the negative word family, so nothing here reports a missing outside source.
  const response = JSON.stringify(catalog)
  for (const word of ['unavailable', 'unobserved', 'notObserved', 'unrecorded']) {
    assert.equal(response.includes(word), false, `the catalog must not contain ${word}`)
  }
})

test('live and cold session catalog reads state one face and the same recorded values', async t => {
  // Two reads of one session: the live one observes the session's own scope, the cold
  // one replays the face the session recorded, and neither may state a capability the
  // other does not have. The one admitted difference is a registration made after the
  // plan froze, and that difference is exactly the set of later registrations.
  const session = Session.create('live-and-cold-catalog')
  session.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.probe': { availability: 'closed' }, 'tools.other': { disclosure: 'full' } } }), { surfaceOp: 'append' })
  const live = [agentFor(session)]
  let schemas = [schema('run_code'), schema('probe'), schema('other')]
  const ctx = { agents: { list: () => live }, systemPrompt: { assemble: async () => ({ sections: [] }) },
    sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
      events: session.snapshotEvents(), [Symbol.dispose]() {} }) } }
  const env = createCapabilityEnvironment({ ctx, config: config({ 'tools.probe': 'full', 'tools.other': 'closed' }),
    toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  await acceptPreparation(env, live[0], [])
  const observed = await env.describeSessionCatalog({ sessionId: session.id }, live[0].signal)
  // Registered after the plan froze: the live scope states it, and the record that was
  // written before it exists cannot. Nothing else may differ.
  schemas = [...schemas, schema('registered_later')]
  const afterRegistration = await env.describeSessionCatalog({ sessionId: session.id }, live[0].signal)
  live.length = 0
  const cold = await env.describeSessionCatalog({ sessionId: session.id })
  const observedIds = observed.rows.map(row => row.id)
  const coldIds = cold.rows.map(row => row.id)
  const liveIds = afterRegistration.rows.map(row => row.id)
  assert.deepEqual(coldIds, observedIds, 'the cold read states the face the plan froze, registration order included')
  assert.deepEqual(liveIds.filter(id => !coldIds.includes(id)), ['tools.registered_later'],
    'only a later registration may be missing from the frozen face')
  assert.deepEqual(coldIds.filter(id => !liveIds.includes(id)), [], 'the frozen face states no capability the live scope lacks')
  // The record the plan froze is exactly the row set: not a subset the read chose.
  const frozen = session.snapshotEvents().filter(event => event.data?.source?.form === CAPABILITY_PLAN_FORM)
    .at(-1).data.source.snapshot.capabilities
  assert.deepEqual(cold.rows.filter(row => row.kind === 'capability').map(row => row.id), frozen.map(capability => capability.id))
  const recorded = rows => rows.filter(row => row.kind === 'capability').map(row => ({ id: row.id, session: row.session }))
  assert.deepEqual(recorded(cold.rows), recorded(observed.rows))
  assert.ok(recorded(cold.rows).length > 0)
  // Both columns, not just the ids: the session's record and the saved configuration
  // are read from their own sources whether or not an agent is present.
  assert.deepEqual(recorded(cold.rows), [
    { id: 'tools.probe', session: { availability: 'closed', disclosure: 'inherit' } },
    { id: 'tools.other', session: { availability: 'inherit', disclosure: 'full' } },
  ])
  assert.deepEqual(cold.rows, observed.rows)
})

test('a session that recorded no capability plan fails the read instead of answering with the Host plane', async t => {
  // The read this replaced answered every session with the Host's own plane, which is a
  // different and smaller question. A session with no live scope and no record states no
  // face at all, so the read fails and names the record it needed: substituting the plane
  // is the defect, and an empty table would claim the Host declared nothing.
  const session = Session.create('cold-without-plan')
  let declarations = 0
  const ctx = { agents: { list: () => [] },
    systemPrompt: { assemble: async () => { declarations += 1; return { sections: [] } } },
    skills: { snapshot: async () => { declarations += 1; return { skills: [], complete: true } } },
    sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
      events: session.snapshotEvents(), [Symbol.dispose]() {} }) } }
  const env = createCapabilityEnvironment({ ctx, config: config(),
    toolSchemasForAgent: () => { declarations += 1; return [schema('probe')] } })
  t.after(() => env.dispose())
  await assert.rejects(env.describeSessionCatalog({ sessionId: session.id }), /recorded no capability plan/)
  assert.equal(declarations, 0, 'a session with no record reads no declaration source to answer for it')
  // The settings list names a session through the same read, so it inherits the refusal.
  await assert.rejects(env.describeCatalog({ sessionId: session.id }), /recorded no capability plan/)
  assert.equal(declarations, 0, 'neither surface reads a declaration source to answer for a session with no record')
  // A caller that names no session asks the Host's own declaration, which still answers.
  assert.deepEqual((await env.describeCatalog()).map(entry => entry.id), ['tools.probe'])
})

test('the cold read refuses only a record that froze no inventory', async t => {
  // The guard asks whether the record's composition required an inventory, not whether the
  // array is empty and not whether management was on: a managed composition whose Host
  // declared nothing states an empty face, and a composition with management off still froze
  // one when the saved policy enabled statistics. A guard keyed on `capabilities.length`
  // refuses the first, and one keyed on the plan's own `enabled` word refuses the duty-driven
  // record below, whose plan states `enabled: false` while still holding the face.
  const readCold = async (session, config, schemas) => {
    const agents = [agentFor(session)]
    const env = createCapabilityEnvironment({ ctx: { agents: { list: () => agents },
      systemPrompt: { assemble: async () => ({ sections: [] }) },
      sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
        events: session.snapshotEvents(), [Symbol.dispose]() {} }) } },
      config, toolSchemasForAgent: () => schemas })
    t.after(() => env.dispose())
    await acceptPreparation(env, agents[0], [])
    const live = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
    const frozen = session.snapshotEvents().filter(event => event.data?.source?.form === CAPABILITY_PLAN_FORM)
      .at(-1).data.source.snapshot
    agents.length = 0
    try {
      return { live, frozen, cold: await env.describeSessionCatalog({ sessionId: session.id }) }
    } catch (error) {
      return { live, frozen, refusal: error.message }
    }
  }
  // An inventoried composition that found nothing states an empty face: the record holds a
  // face, it is just empty, so there is nothing to refuse.
  const managed = await readCold(Session.create('managed-empty-face'), config(), [])
  assert.deepEqual(managed.frozen.capabilities, [])
  assert.deepEqual(managed.cold.rows, [], 'an inventoried composition that found nothing states an empty face')
  // The context generation is the one the plan-schema expectation used to call damaged: a
  // v4 record with an inventory replays its face.
  const context = await readCold(Session.create('context-with-inventory'),
    { ...config(), capabilityContextEnabled: true }, [schema('probe')])
  assert.equal(context.frozen.schema, 'ptc-capability-environment/v4')
  assert.equal(context.frozen.plan.schema, 'ptc-capability-plan/v3')
  assert.deepEqual(context.cold.rows.map(row => row.id), ['tools.probe'])
  // Management off is not the same fact: the saved policy enabled statistics, so the
  // composition still required an inventory and the record still holds the face.
  const policy = { schema: 'ptc-capability-policy/v1', defaults: { availability: 'enabled', disclosure: 'host' },
    categories: {}, mcpServers: {}, items: {}, allocation: { baseline: true, statistics: true, budget: true } }
  const duty = await readCold(Session.create('duty-driven-inventory'),
    { capabilityManagementEnabled: false, capabilityPolicy: JSON.stringify(policy),
      capabilityBaseline: '[]', capabilityOverrides: '{}',
      capabilityStatistics: '{"enabled":true,"windowSize":100,"minimumSamples":10,"fullThreshold":0.5}',
      capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 },
    [schema('probe')])
  assert.ok(duty.frozen.capabilities.length > 0, 'the composition must have frozen an inventory')
  assert.deepEqual(duty.cold.rows.map(row => row.id), duty.live.rows.map(row => row.id))
  // The paused group is the same fact in the other direction, and the one a reader of the
  // saved switches is most likely to meet: `effectiveCapabilitySettings` presses the saved
  // management, statistics and recovery down to false while the group is off, so the paused
  // composition records no inventory even with management on. A call site that copied the
  // rule without that precedence would answer the paused session with an empty table.
  const paused = await readCold(Session.create('paused-group'),
    { ...config(), capabilityContextEnabled: false }, [schema('probe')])
  assert.deepEqual(paused.frozen.capabilities, [], 'a paused composition records no inventory')
  assert.deepEqual(paused.live.rows.map(row => row.id), ['tools.probe'], 'the live scope still declares what exists')
  assert.match(paused.refusal, /froze no capability inventory/)
})

test('a recorded plan that froze no inventory states no face and fails the read', async t => {
  // A composition records an empty `capabilities` array when no capability feature
  // required an inventory, and that array is not a face: nothing was supplied to the
  // model. Answering with it would draw an empty table that says the Host declared
  // nothing, so the read fails instead. The live read is what proves the difference is
  // the whole face and not an empty declaration.
  const session = Session.create('cold-without-inventory')
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) },
    sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
      events: session.snapshotEvents(), [Symbol.dispose]() {} }) } }
  const env = createCapabilityEnvironment({ ctx, toolSchemasForAgent: () => [schema('probe')],
    // The shipped defaults: capability context on, management off, so a plan is delivered
    // and no inventory is composed for it.
    config: { capabilityManagementEnabled: false, capabilityContextEnabled: true,
      capabilityBaseline: '[]', capabilityOverrides: '{}',
      capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
      capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 } })
  t.after(() => env.dispose())
  await acceptPreparation(env, agents[0], [])
  const frozen = session.snapshotEvents().filter(event => event.data?.source?.form === CAPABILITY_PLAN_FORM)
    .at(-1).data.source.snapshot
  assert.deepEqual(frozen.capabilities, [], 'the fixture must reach the composition that froze no inventory')
  const live = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  assert.deepEqual(live.rows.map(row => row.id), ['tools.probe'], 'the live scope still declares what was supplied')
  agents.length = 0
  await assert.rejects(env.describeSessionCatalog({ sessionId: session.id }), /froze no capability inventory/)
})

test('a damaged recorded plan fails the read rather than stating a face it does not hold', async t => {
  // Damage invalidates the record as evidence, and the composition already refuses such a
  // plan. The catalogue read must refuse it too: a record this build cannot prove is not a
  // smaller face and is not an empty one.
  const session = Session.create('damaged-record')
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) },
    sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
      events: session.snapshotEvents(), [Symbol.dispose]() {} }) } }
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agents[0], [])
  const recorded = session.snapshotEvents().find(event => event.data?.source?.form === CAPABILITY_PLAN_FORM).data
  // The same message with a digest that no longer proves its snapshot.
  session.append('user/message', { ...recorded, id: 'damaged-plan-copy',
    source: { ...recorded.source, digest: 'no-longer-the-recorded-digest' } }, { surfaceOp: 'append' })
  agents.length = 0
  await assert.rejects(env.describeSessionCatalog({ sessionId: session.id }), /damaged session capability plan/)
  await assert.rejects(env.describeCatalog({ sessionId: session.id }), /damaged session capability plan/)
})

test('the replayed Skill row states every column the live row states except the provider bucket', async t => {
  // The frozen capability contract carries a Skill's selector, description and invocation
  // eligibility but no provider/source bucket, so the replayed row names the kind alone.
  // That is the one column where the two faces differ by design (docs/panel-concept.md
  // section 9); stating it here keeps the boundary from growing unnoticed.
  const skill = { name: 'review', provider: 'workspace', source: 'fixture', description: 'Review Skill',
    rank: 100, locator: '/tmp/workspace', invocation: { modelInvocable: true, userInvocable: false } }
  const session = Session.create('skill-source-boundary')
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, skills: { snapshot: async () => ({ skills: [skill], complete: true }) },
    systemPrompt: { assemble: async () => ({ sections: [] }) },
    sessionQuery: { observeSession: async () => ({ header: session.header, cursor: session.seq - 1,
      events: session.snapshotEvents(), [Symbol.dispose]() {} }) } }
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agents[0], [])
  const live = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  agents.length = 0
  const cold = await env.describeSessionCatalog({ sessionId: session.id })
  const liveSkill = live.rows.find(row => row.id === 'skills.review')
  const coldSkill = cold.rows.find(row => row.id === 'skills.review')
  assert.deepEqual(liveSkill.source, { kind: 'skill', bucket: 'fixture', provider: 'workspace' })
  assert.deepEqual(coldSkill.source, { kind: 'skill' }, 'the record holds no bucket, so the row names none')
  assert.deepEqual({ ...coldSkill, source: null }, { ...liveSkill, source: null },
    'every other column of the replayed Skill row is the live row\'s own statement')
  assert.deepEqual(cold.rows.filter(row => row.id !== 'skills.review'),
    live.rows.filter(row => row.id !== 'skills.review'))
})

test('session catalog reads the session scope and touches no PTC runtime or write branch', async t => {
  // The read is required to observe the session's own scope — that is where a preset
  // registers its tools and where the Skill layers are resolved — and forbidden to
  // touch anything that belongs to the PTC runtime or to writing the session. Every
  // forbidden surface throws if this read reaches it, and the read still answers the
  // whole declaration.
  const session = Session.create('read-without-runtime')
  const agent = agentFor(session)
  const agents = [agent]
  const reached = []
  const forbid = (name, message) => () => { reached.push(name); throw new Error(message) }
  // A session's usability is a runtime fact, not a supply fact: the two properties a
  // read could ask are poisoned, and so is the maintenance boundary a refresh runs on.
  Object.defineProperty(agent, 'canRefresh', { get: forbid('canRefresh', 'the read judged whether the session can refresh') })
  Object.defineProperty(agent, 'worker', { get: forbid('worker', 'the read touched the PTC worker') })
  agent.runMaintenance = forbid('runMaintenance', 'the read ran a refresh or preparation branch')
  session.append = forbid('session.append', 'the read wrote to the session')
  // `run_code` is the transport the PTC runtime installs, not a capability: reading its
  // contract would be declaring it as a row. Its name stays readable because the
  // transport filter has to recognise it.
  const transport = { name: 'run_code' }
  for (const field of ['description', 'parameters', 'output']) {
    Object.defineProperty(transport, field, { get: forbid(`run_code.${field}`, 'the read declared the PTC transport as a capability') })
  }
  const env = createEnvironment({
    // `prepare` reads this session's history through the runtime's own entry; the panel
    // read takes the log itself, so reaching this entry fails too.
    sessionHistoryForAgent: async () => { reached.push('sessionHistoryForAgent')
      throw new Error('the read prepared the session') },
    ctx: { agents: { list: () => agents },
      skills: { snapshot: async options => {
        if (options.scope !== agent) { reached.push('skills.snapshot/global'); throw new Error('the read left the session scope') }
        return { skills: [], complete: true }
      } },
      systemPrompt: { assemble: async context => {
        if (context.ptcPlusCapabilityObservation !== true || context.agent !== agent || context.scope !== agent) {
          reached.push('assemble/without-scope')
          throw new Error('the read assembled without the passive session scope')
        }
        return { sections: [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' },
          { name: 'mcp:docs', text: 'Docs server' }] }
      } } },
    config: config(),
    toolSchemasForAgent: target => {
      if (target !== agent) { reached.push('toolSchemasForAgent/global')
        throw new Error('the read asked for the Host plane instead of the session scope') }
      return [transport, schema('probe')]
    },
  })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: session.id }, agent.signal)
  // The read still answers the whole declaration of the session scope: the tool, the
  // resource server and the server row. A silent gap would be the failure this test
  // is looking for.
  assert.deepEqual(catalog.rows.map(row => ({ id: row.id, kind: row.kind })),
    [{ id: 'tools.probe', kind: 'capability' }, { id: 'mcp.docs', kind: 'capability' }, { id: 'mcpServers.docs', kind: 'server' }])
  assert.deepEqual(reached, [],
    'the read must not prepare, refresh, judge usability, touch the worker, read the transport or append')
  assert.deepEqual(session.snapshotEvents(), [])
})

test('the Host plane states fewer capabilities than the session scope declares', async t => {
  // One real session declared 81 entries where a Host-plane read could state 30: 59
  // tools and 21 Skills were declared to it, while the Host's own plane answers 27
  // tools and one Skill. The 32 tools and 20 Skills between them are registered in the
  // session's scope — a preset registers its tools at agent scope — and are resolved
  // only through that scope. Dropping the scope loses exactly that layer, which is the
  // defect this ratio pins.
  const hostTools = Array.from({ length: 27 }, (_, index) => schema(`host_tool_${index}`))
  const presetTools = Array.from({ length: 32 }, (_, index) => schema(`preset_tool_${index}`))
  const skill = name => ({ name, provider: 'workspace', source: 'fixture', description: `Skill ${name}`,
    rank: 100, locator: `/tmp/${name}`, invocation: { modelInvocable: true, userInvocable: false } })
  const hostSkills = [skill('host-skill')]
  const presetSkills = Array.from({ length: 20 }, (_, index) => skill(`preset-skill-${index}`))
  const session = Session.create('scope-ratio')
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents },
    // A scope selects the layers the catalogue resolves; the global view has the Host's
    // own layer alone.
    skills: { snapshot: async ({ scope }) => ({ complete: true,
      skills: scope === undefined ? hostSkills : [...hostSkills, ...presetSkills] }) },
    systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: config(),
    // The same shape at the registry: the session's projection when a scope is named,
    // the Host's global view when it is not.
    toolSchemasForAgent: agent => agent === undefined ? hostTools : [...hostTools, ...presetTools] })
  t.after(() => env.dispose())
  const declared = await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal)
  const ids = rows => category => rows.filter(row => row.category === category).map(row => row.id)
  const declaredIds = ids(declared.rows)
  assert.equal(declaredIds('tool').length, 59)
  assert.equal(declaredIds('skill').length, 21)
  // The Host's own declaration, which is what a caller that names no session asks for.
  // It answers a different and smaller face, so substituting it for the session's
  // supply is what silently dropped the preset layer.
  const host = await env.describeCatalog()
  const hostIds = ids(host)
  assert.equal(hostIds('tool').length, 27)
  assert.equal(hostIds('skill').length, 1)
  assert.equal(declaredIds('tool').filter(id => !hostIds('tool').includes(id)).length, 32)
  assert.equal(declaredIds('skill').filter(id => !hostIds('skill').includes(id)).length, 20)
  assert.ok(hostIds('tool').length < declaredIds('tool').length)
  assert.ok(hostIds('skill').length < declaredIds('skill').length)
})

test('the global binding and management switches move no capability row', async t => {
  // A global switch may decide which supply exists and which default is stored; it
  // may not decide what the capability rows are. Each switch is flipped on its own
  // against one baseline, and the capability id set must be the same set.
  const session = Session.create('switch-catalog')
  session.append('user/message', capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: { 'tools.probe': { availability: 'closed' } } }), { surfaceOp: 'append' })
  const agents = [agentFor(session)]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const make = settings => { const env = createCapabilityEnvironment({ ctx, config: settings,
    toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('other')],
    readUserBindings: bindingSupply([{ id: 'alpha', name: 'alphaHelpers', enabled: true }]) })
    t.after(() => env.dispose()); return env }
  const capabilityIds = rows => rows.filter(row => row.kind === 'capability').map(row => row.id)
  const read = async (settings) => {
    const env = make(settings)
    return { env, catalog: await env.describeSessionCatalog({ sessionId: session.id }, agents[0].signal) }
  }
  const baseline = await read({ ...config({ 'tools.probe': 'full' }), userBindingsEnabled: true, capabilityManagementEnabled: true })
  assert.deepEqual(capabilityIds(baseline.catalog.rows), ['tools.probe', 'tools.other'])
  // The binding switch really differs: the baseline lists the supplied entry as a row.
  assert.deepEqual(baseline.catalog.rows.filter(row => row.kind === 'binding').map(row => row.id), ['alpha'])
  const bindingsOff = await read({ ...config({ 'tools.probe': 'full' }), userBindingsEnabled: false, capabilityManagementEnabled: true })
  assert.equal(bindingsOff.catalog.config.bindingsEnabled, false)
  assert.deepEqual(bindingsOff.catalog.rows.filter(row => row.kind === 'binding'), [])
  assert.deepEqual(capabilityIds(bindingsOff.catalog.rows), capabilityIds(baseline.catalog.rows))
  const managementOff = await read({ ...config({ 'tools.probe': 'full' }), userBindingsEnabled: true, capabilityManagementEnabled: false })
  // The switch really was flipped in the configuration the read used, even though no
  // row value follows from it.
  assert.equal(managementOff.env.describe(agents[0]).configured.enabled, false)
  assert.deepEqual(capabilityIds(managementOff.catalog.rows), capabilityIds(baseline.catalog.rows))
  assert.deepEqual(managementOff.catalog.rows, baseline.catalog.rows)
})

test('session capability choices preserve their sources across refresh, global changes and cold restore', async t => {
  let saved = { ...config({ 'tools.probe': 'closed' }), capabilityBaseline: '["tools.probe"]' }
  let revision = 1
  const agents = ['choices-a', 'choices-b'].map(id => agentFor(Session.create(id)))
  for (const agent of agents) agent.runMaintenance = operation => operation(agent.signal)
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: saved, toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('other')] })
  t.after(() => env.dispose())
  for (const agent of agents) await acceptPreparation(env, agent, [])
  const selection = (agent, id = 'tools.probe') => env.describe(agent).effective.entries.find(entry => entry.id === id).selection
  const writer = { read: () => ({ value: saved, revision }), update: async (patch, expected) => {
    assert.equal(expected, revision); saved = { ...saved, ...patch }; revision++; env.reconfigure(saved) } }
  // One write, then the materialization a step performs: the record states the
  // choice and the composition that acts on it is rebuilt from that record.
  const change = async (agent, id, choice, scope = 'session') => {
    const outcome = await env.change(agent, { id, selection: choice, scope }, agent.signal, writer)
    await settle(env, agent)
    return outcome
  }
  await change(agents[0], 'tools.probe', 'automatic')
  assert.equal(selection(agents[0]), 'full')
  assert.equal(selection(agents[1]), 'closed')
  assert.equal(JSON.parse(saved.capabilityOverrides)['tools.probe'], 'closed')
  await change(agents[0], 'tools.probe', 'inherit')
  assert.equal(selection(agents[0]), 'closed')
  await change(agents[0], 'tools.other', 'closed')
  await change(agents[0], 'tools.probe', 'closed')
  saved = { ...saved, capabilityOverrides: '{"tools.probe":"full"}' }; env.reconfigure(saved)
  await env.refresh(agents[0], [], agents[0].signal)
  // The saved column moved and this session did not: the session's own record wins
  // over the inheritance it replaced.
  assert.equal(selection(agents[0]), 'closed')
  assert.equal(env.describe(agents[0]).pendingRefresh, false)
  await change(agents[1], 'tools.probe', 'on-demand', 'global')
  // A global choice states the saved column, not this session's decision: the
  // composition that acts on a session stays pending until the session refreshes.
  assert.equal(env.describe(agents[1]).pendingRefresh, true)
  assert.equal(selection(agents[1], 'tools.probe'), 'closed')
  await env.refresh(agents[1], [], agents[1].signal)
  assert.equal(selection(agents[1], 'tools.probe'), 'on-demand')
  assert.equal(selection(agents[0]), 'closed', 'another session\'s global choice is not this session\'s decision')
  assert.equal(selection(agents[0], 'tools.other'), 'closed')
  assert.deepEqual(env.describe(agents[0]).sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'closed' })
  assert.equal(JSON.parse(env.describeSessions().find(item => item.sessionId === agents[0].session.id)
    .configuration.capabilityOverrides)['tools.probe'], 'full', 'a session reports the saved column it composed from')
  const restored = createCapabilityEnvironment({ ctx, config: saved, toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('other')] })
  t.after(() => restored.dispose())
  await restored.prepare(agents[0], [])
  assert.deepEqual(restored.describe(agents[0]).sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'closed' })
  assert.equal(restored.describe(agents[0]).effective.entries.find(entry => entry.id === 'tools.other').selection, 'closed')
  // The same session read states the record and the saved configuration as two
  // columns: the choice this session wrote is in the record, and the saved default it
  // never touched stays `automatic`, whatever the composition froze.
  const rows = (await env.describeSessionCatalog({ sessionId: agents[0].session.id }, agents[0].signal)).rows
  assert.deepEqual(rows.find(row => row.id === 'tools.other').session, { availability: 'closed', disclosure: 'inherit' })
  assert.deepEqual(rows.find(row => row.id === 'tools.other').saved, { availability: 'automatic', disclosure: 'automatic' })
})

test('a capability write reports the one thing it did and a refused write leaves no partial state', async t => {
  let saved = config()
  const agent = agentFor(Session.create('choice-failures'))
  const ctx = { systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: saved, toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  const before = env.stateFor(agent)
  const length = agent.session.snapshotEvents().length
  const intent = { scope: 'global', id: 'tools.probe', selection: 'closed' }
  // A writer that refuses writes nothing: the revision it was given is the whole
  // precondition, and no session state moves.
  await assert.rejects(env.change(agent, intent, agent.signal, { read: () => ({ value: saved, revision: 1 }),
    update: async () => { throw new Error('revision conflict') } }), /revision conflict/)
  assert.equal(env.stateFor(agent), before)
  assert.equal(agent.session.snapshotEvents().length, length)
  // A record that cannot be appended is a failed write, not a saved one.
  const append = agent.session.append.bind(agent.session)
  agent.session.append = () => { throw new Error('record refused') }
  await assert.rejects(env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal),
    /record refused/)
  agent.session.append = append
  assert.equal(env.stateFor(agent), before)
  assert.equal(agent.session.snapshotEvents().length, length)
  // The write path needs this session's log and the settings writer, not a
  // maintenance boundary: a session whose runtime is busy still states its choice.
  agent.runMaintenance = () => { throw new Error('maintenance busy') }
  const recorded = await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  assert.deepEqual(recorded, { globalSaved: false, sessionApplied: true, publication: 'recorded' })
})

test('a session choice is a record the next composition materializes, and a global save is the writer\'s', async t => {
  const ctx = new Context()
  const skills = { snapshot: async () => ({ complete: true, skills: [] }) }
  ctx.effect(() => ctx.provide('skills', skills))
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const agent = agentFor(Session.create('choice-projection-failure')); agent.runMaintenance = operation => operation(agent.signal)
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(async () => { await env.dispose(); await ctx.fiber.dispose() })
  await acceptPreparation(env, agent, [])
  const previous = env.stateFor(agent); const count = agent.session.seq
  skills.registerProvider = () => { throw new Error('Skill provider registration failed') }
  await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  // The record is the write. The composition that cannot be built leaves the last
  // one in place and states the same decision the record does.
  assert.equal(agent.session.snapshotEvents().length, count + 1, 'the record is the whole write')
  await assert.rejects(env.prepare(agent), /Skill provider registration failed/)
  assert.equal(env.stateFor(agent), previous)
  assert.deepEqual(env.describe(agent).sessionOverrides, { 'tools.probe': 'closed' },
    'the record states the choice the composition could not build')
  delete skills.registerProvider
  let writes = 0
  const saved = await env.change(agent, { scope: 'global', id: 'tools.probe', selection: 'closed' }, agent.signal, {
    read: () => ({ value: config(), revision: 1 }),
    update: async () => { writes++ },
  })
  assert.equal(writes, 1)
  assert.deepEqual(saved, { globalSaved: true, sessionApplied: true, publication: 'recorded' })
  await settle(env, agent)
  assert.equal(env.stateFor(agent).snapshot.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'closed')
})

test('cold session controls restore prior temporary choices before change or refresh and keep MCP parent choices separate', async t => {
  const hostSections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs","other"].' }]
  const schemas = ['run_code', 'probe', 'other', 'mcp__docs__search', 'mcp__docs__edit', 'mcp__other__search', 'read_mcp_resource'].map(schema)
  const saved = config({ 'tools.mcp__docs__search': 'full', 'tools.mcp__docs__edit': 'closed' })
  const ctx = { systemPrompt: { assemble: async () => ({ sections: hostSections }) } }
  const make = () => { const env = createCapabilityEnvironment({ ctx, config: saved, toolSchemasForAgent: () => schemas }); t.after(() => env.dispose()); return env }
  const agent = agentFor(Session.create('cold-controls'))
  agent.runMaintenance = operation => operation(agent.signal)
  const original = make()
  await acceptPreparation(original, agent, hostSections)
  await original.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  const restored = agentFor(Session.create(agent.session.id, agent.session.snapshotEvents(), agent.session.header))
  restored.runMaintenance = operation => operation(restored.signal)
  // A cold read reaches the session's log through the Host's own query, never through
  // a live agent: this environment has none.
  ctx.sessionQuery = { observeSession: async () => ({ header: restored.session.header, cursor: restored.session.seq - 1,
    events: restored.session.snapshotEvents(), [Symbol.dispose]() {} }) }
  const cold = make()
  const observed = (await cold.describeSessionCatalog({ sessionId: restored.session.id }, restored.signal)).rows
  assert.deepEqual(observed.find(item => item.id === 'tools.probe').session, { availability: 'closed', disclosure: 'inherit' })
  assert.equal(cold.stateFor(restored), undefined, 'Read-only listing must not prepare an effective environment.')
  await cold.change(restored, { scope: 'session', id: 'tools.other', selection: 'closed' }, restored.signal)
  assert.deepEqual(cold.describe(restored).sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'closed' })
  const fresh = make()
  await fresh.refresh(restored)
  assert.deepEqual(fresh.describe(restored).sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'closed' })
  await fresh.change(restored, { scope: 'session', id: 'mcpServers.docs', selection: 'closed' }, restored.signal)
  await settle(fresh, restored)
  assert.ok(!fresh.projectMembers(restored, schemas.map(item => item.name)).includes('mcp__docs__search'))
  assert.ok(fresh.projectMembers(restored, schemas.map(item => item.name)).includes('mcp__other__search'))
  await fresh.change(restored, { scope: 'session', id: 'mcpServers.docs', selection: 'inherit' }, restored.signal)
  await settle(fresh, restored)
  const reopened = fresh.projectMembers(restored, schemas.map(item => item.name))
  assert.ok(reopened.includes('mcp__docs__search'))
  assert.ok(!reopened.includes('mcp__docs__edit'))
  await assert.rejects(fresh.change(restored, { scope: 'session', id: 'mcpServers.docs', selection: 'full' }, restored.signal), /MCP server choices/)
})

test('a recorded session choice materializes before the first system head whatever its command receipt says', async t => {
  const ctx = new Context()
  new CommandRuntime(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const saved = config()
  const make = () => { const env = createCapabilityEnvironment({ ctx, config: saved, toolSchemasForAgent: () => [schema('run_code'), schema('probe')] }); t.after(() => env.dispose()); return env }
  const env = make()
  const session = Session.create('pending-choice-command')
  const agent = agentFor(session); agent.runMaintenance = operation => operation(agent.signal)
  ctx.effect(() => ctx.commands.register({ name: 'capabilities', description: 'Change the session choice',
    handler: async ({ commandId, rawInput, agent, signal }) => {
      await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed', commandId }, signal)
      const message = env.pendingChoiceMessage(agent)
      return { kind: 'success', text: message === undefined
        ? capabilityCommandReceipt('recorded', session.id)
        : capabilityCommandReceipt('pending', session.id, undefined, { commandId, rawInput, message }) }
    } }))
  t.after(() => ctx.fiber.dispose())
  await ctx.commands.execute(agent, '/capabilities set session tools.probe closed', [], agent.signal)
  // The choice is this session's own record, so it reaches the log before any Host
  // system head; the plan is what stays uncommitted until the first accepted step.
  assert.deepEqual(session.deriveMessages().map(message => message.source?.form), [CAPABILITY_SELECTION_FORM],
    'a choice before the first system head records itself and publishes no plan')
  assert.ok(!session.snapshotEvents().some(event => event.type.startsWith('plugin:')))
  await env.prepare(agent, [])
  assert.equal(env.describe(agent).effective.entries.find(item => item.id === 'tools.probe').selection, 'closed')
  const events = session.snapshotEvents()
  for (const variant of ['success', 'failed', 'unpaired']) {
    const seed = events.map(event => event.type === 'command/done' && variant === 'failed'
      ? { ...event, data: { ...event.data, kind: 'error' } } : event).filter(event => variant !== 'unpaired' || event.type !== 'command/run')
      .map((event, seq) => ({ ...event, seq }))
    const restored = agentFor(Session.create(session.id, seed, session.header))
    const cold = make()
    await cold.prepare(restored, [])
    // The record states the choice, so the command's own outcome cannot decide what
    // the session acts on: only the record can.
    assert.equal(cold.describe(restored).effective.entries.find(item => item.id === 'tools.probe').selection, 'closed')
  }
})

for (const action of ['choice', 'refresh']) test(`a cancelled first-session ${action} command appends no unconfirmed plan`, async t => {
  const ctx = new Context(); new CommandRuntime(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  const agent = agentFor(Session.create('cancel-pending-choice')); agent.runMaintenance = operation => operation(agent.signal)
  let ready; const prepared = new Promise(resolve => { ready = resolve })
  let release; const afterCancellation = new Promise(resolve => { release = resolve })
  ctx.effect(() => ctx.commands.register({ name: 'capabilities', description: 'Cancel pending choice',
    handler: async ({ commandId, rawInput, agent, signal }) => {
      if (action === 'choice') await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, signal)
      else {
        await env.prepare(agent, [])
        env.reconfigure(config({ 'tools.probe': 'full' }))
        await env.refresh(agent, undefined, signal)
      }
      const message = env.pendingChoiceMessage(agent)
      const text = message === undefined ? capabilityCommandReceipt('recorded', agent.session.id)
        : capabilityCommandReceipt('pending', agent.session.id, undefined, { commandId, rawInput, message })
      ready(); await afterCancellation
      return { kind: 'success', text }
    } }))
  t.after(async () => { release(); await env.dispose(); await ctx.fiber.dispose() })
  const caller = new AbortController()
  const command = ctx.commands.execute(agent, action === 'choice' ? '/capabilities set session tools.probe closed' : '/capabilities refresh', [], caller.signal)
  await prepared; caller.abort(new Error('User cancelled'))
  await assert.rejects(command, /User cancelled/)
  assert.equal(agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan').length, 0,
    'a cancelled first-session command appends no plan')
  if (action === 'choice') {
    // The record was written before the cancellation reached the command, so the
    // next composition materializes the decision the session made.
    await env.prepare(agent, [])
    assert.equal(env.describe(agent).effective.entries.find(item => item.id === 'tools.probe').selection, 'closed')
  } else {
    assert.equal(env.stateFor(agent).snapshot.plan.entries.find(item => item.id === 'tools.probe').selection, 'full',
      'the refresh composed from the saved configuration it was asked to publish')
    const entered = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(entered.messages.filter(message => message.source?.form === 'capability-plan').length, 1)
    assert.equal(env.describe(agent).sessionOverrides['tools.probe'], undefined,
      'no cancelled command may state a session choice')
  }
  release(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'command/done').length, 1)
})

test('pre-session capability changes replace the initial plan without refresh notifications', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  const agent = agentFor(Session.create('initial-capability-choices'))
  agent.runMaintenance = operation => operation(agent.signal)
  t.after(async () => { await env.dispose(); await ctx.fiber.dispose() })
  await env.prepare(agent, [])
  const recorded = () => agent.session.deriveMessages().filter(message => message.source?.form === CAPABILITY_SELECTION_FORM)
  for (const selection of ['closed', 'full', 'on-demand']) {
    await env.change(agent, { scope: 'session', id: 'tools.probe', selection }, agent.signal)
    // Each change is one record of this session's own decision; the plan stays
    // unwritten until admission, so every model-visible message here is a record.
    assert.equal(agent.session.deriveMessages().length, recorded().length,
      'a pre-session change records the choice and publishes no plan')
  }
  assert.equal(recorded().length, 3)
  await env.refresh(agent, undefined, agent.signal)
  const task = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] })
  const entered = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [task] }))
  const plans = entered.messages.filter(message => message.source?.form === 'capability-plan')
  assert.equal(plans.length, 1)
  // A recorded choice is not task history: the initial plan still precedes the task,
  // even though the session log already carries the session's own statements.
  assert.equal(entered.messages[0].source.form, 'capability-plan', 'the initial plan precedes the task')
  assert.equal(entered.messages[1], task)
  assert.equal(plans[0].source.refresh, false)
  assert.match(plans[0].content[0].text, /^PTC Plus session capability environment:/)
  assert.doesNotMatch(plans[0].content[0].text, /refreshed|replaces the preceding/)
  assert.equal(plans[0].source.snapshot.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'on-demand')
})

test('a later session choice restates every decision this session recorded', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [] })
  const agent = agentFor(Session.create('choice-accumulation'))
  t.after(async () => { await env.dispose(); await ctx.fiber.dispose() })
  // The tool table supplies no run_code: a choice is a record of this session's
  // own log, so it materializes without any session-supplied execution surface.
  await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  await env.change(agent, { scope: 'session', id: 'tools.other', selection: 'full' }, agent.signal)
  // A statement is the whole of what the session decided. The second decision must
  // restate the first; otherwise the panel reports a decision nobody withdrew.
  const statement = capabilitySelectionOf(agent.session.snapshotEvents())
  assert.equal(statement.state, 'decided')
  assert.deepEqual(statement.selection.choices, {
    'tools.probe': { availability: 'closed' },
    'tools.other': { availability: 'enabled', disclosure: 'full' },
  })
})

test('a choice recorded by a second process restates every decision the session already made', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const make = () => { const env = createCapabilityEnvironment({ ctx, config: config(),
    toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('other')] }); t.after(() => env.dispose()); return env }
  t.after(() => ctx.fiber.dispose())
  const agent = agentFor(Session.create('accumulated-choices'))
  // No plan is published here: the log carries only this session's own records, so
  // nothing but the record can carry the first decision into the second process.
  const first = make()
  await first.prepare(agent, [])
  await first.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  const second = make()
  await second.change(agent, { scope: 'session', id: 'tools.other', selection: 'full' }, agent.signal)
  // A statement is the whole of what the session decided. The second decision, made
  // by a process that never saw the first, must restate it.
  const statement = capabilitySelectionOf(agent.session.snapshotEvents())
  assert.equal(statement.state, 'decided')
  assert.deepEqual(statement.selection.choices, {
    'tools.probe': { availability: 'closed' },
    'tools.other': { availability: 'enabled', disclosure: 'full' },
  })
  // The composition states both decisions, not the last one only.
  const state = await second.prepare(agent)
  assert.deepEqual(Object.fromEntries(state.snapshot.plan.entries.map(entry => [entry.id, entry.selection])),
    { 'tools.probe': 'closed', 'tools.other': 'full' })
  assert.deepEqual(state.snapshot.sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'full' })
})

test('a cold composition builds the plan from the record when the log holds no plan', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const make = () => { const env = createCapabilityEnvironment({ ctx, config: config(),
    toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('other')] }); t.after(() => env.dispose()); return env }
  t.after(() => ctx.fiber.dispose())
  const agent = agentFor(Session.create('cold-record-composition'))
  const recording = make()
  await recording.prepare(agent, [])
  await recording.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  await recording.change(agent, { scope: 'session', id: 'tools.other', selection: 'full' }, agent.signal)
  assert.equal(agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan').length, 0,
    'the log this cold start reads carries records and no plan')
  // A new environment has no memory state to compose from: the record is its only
  // statement of what this session decided.
  const cold = make()
  const state = await cold.prepare(agent)
  assert.deepEqual(Object.fromEntries(state.snapshot.plan.entries.map(entry => [entry.id, entry.selection])),
    { 'tools.probe': 'closed', 'tools.other': 'full' })
  assert.deepEqual(state.snapshot.sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'full' })
})

test('a session whose choices live only in its delivered plan keeps them after the upgrade', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const schemas = [schema('run_code'), schema('probe'), schema('other')]
  const writing = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => schemas })
  t.after(() => writing.dispose())
  const agent = agentFor(Session.create('delivered-plan-choices')); agent.runMaintenance = operation => operation(agent.signal)
  await acceptPreparation(writing, agent, [])
  await writing.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  await writing.change(agent, { scope: 'session', id: 'tools.other', selection: 'full' }, agent.signal)
  await settle(writing, agent)
  const events = structuredClone(agent.session.snapshotEvents())
  const plan = events.findLast(event => event.data?.source?.form === CAPABILITY_PLAN_FORM)
  assert.deepEqual(plan.data.source.snapshot.sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'full' })
  // 0.5.4 and earlier never appended a record: their log states the same decisions
  // only in the snapshot it delivered. Both logs below are that one session, one per
  // record form, and a cold composition must answer them the same way.
  const delivered = events.filter(event => event.data?.source?.form !== CAPABILITY_SELECTION_FORM)
    .map((event, seq) => ({ ...event, seq }))
  const recorded = events.filter(event => event.data?.source?.form !== CAPABILITY_PLAN_FORM)
    .map((event, seq) => ({ ...event, seq }))
  assert.ok(delivered.some(event => event.data?.source?.form === CAPABILITY_PLAN_FORM))
  assert.ok(!delivered.some(event => event.data?.source?.form === CAPABILITY_SELECTION_FORM))
  assert.ok(recorded.some(event => event.data?.source?.form === CAPABILITY_SELECTION_FORM))
  assert.ok(!recorded.some(event => event.data?.source?.form === CAPABILITY_PLAN_FORM))
  // Both forms answer as one statement; the marker is the only thing that says which
  // form answered, and it is what proves the plan branch is the one read here.
  assert.equal(capabilitySelectionOf(delivered).legacy, true)
  assert.equal(capabilitySelectionOf(recorded).legacy, undefined)
  for (const [form, log] of [['delivered plan', delivered], ['selection record', recorded]]) {
    const restored = agentFor(Session.create(agent.session.id, log, agent.session.header))
    const cold = createCapabilityEnvironment({ ctx: { agents: { list: () => [restored] },
      systemPrompt: { assemble: async () => ({ sections: [] }) } },
      config: config(), toolSchemasForAgent: () => schemas })
    t.after(() => cold.dispose())
    const state = await cold.prepare(restored, [])
    // The upgrade's first composition keeps every choice the session already had:
    // reading the plan form is not a reason to recompose from an empty set.
    assert.deepEqual(Object.fromEntries(state.snapshot.plan.entries.map(entry => [entry.id, entry.selection])),
      { 'tools.probe': 'closed', 'tools.other': 'full' }, form)
    // The composition is the recorded one, restored in place: the identity of the message
    // it restores is the delivered message's identity, while a rebuild composes a new
    // message with a new identity and prepare publishes neither before an accepted step.
    const recordedPlanEvent = log.findLast(event => event.data?.source?.form === CAPABILITY_PLAN_FORM)
    if (recordedPlanEvent === undefined) {
      assert.equal(state.message?.source?.refresh, false, `a log with no delivered plan composes one: ${form}`)
    } else {
      assert.equal(state.message?.id, recordedPlanEvent.data.id, `the delivered plan is restored in place: ${form}`)
    }
    assert.deepEqual(cold.describe(restored).sessionOverrides, { 'tools.probe': 'closed', 'tools.other': 'full' }, form)
    // The panel's session column is that same statement, never `inherit`.
    const rows = (await cold.describeSessionCatalog({ sessionId: restored.session.id }, restored.signal)).rows
    assert.deepEqual(rows.find(row => row.id === 'tools.probe').session,
      { availability: 'closed', disclosure: 'inherit' }, form)
    assert.deepEqual(rows.find(row => row.id === 'tools.other').session,
      { availability: 'enabled', disclosure: 'full' }, form)
    // A write that follows a plan-form read restates every choice it answered with:
    // the record it appends may not withdraw a decision it did not touch.
    await cold.change(restored, { scope: 'session', id: 'mcpServers.docs', selection: 'closed' }, restored.signal)
    const migrated = capabilitySelectionOf(restored.session.snapshotEvents())
    assert.deepEqual(migrated.selection.choices, {
      'tools.probe': { availability: 'closed' },
      'tools.other': { availability: 'enabled', disclosure: 'full' },
      'mcpServers.docs': { availability: 'closed' },
    }, form)
    // The record this write appended now outvotes the older plan: an upgrade must not
    // turn the delivered snapshot into a statement a later decision cannot replace.
    assert.equal(migrated.legacy, undefined, `a newer record outvotes the plan: ${form}`)
  }
  // A plan that states the map unreadably is `unreadable`, not `none`: it supersedes what
  // came before it, and reporting that nothing was decided would let the composition
  // withdraw a decision the log still holds. A snapshot that states no map at all (the v1
  // generation) stays `none`, because it recorded nothing to migrate.
  for (const overrides of [null, ['tools.probe'], 'tools.probe', JSON.parse('{"__proto__": "closed"}')]) {
    const damaged = delivered.map(event => event.data?.source?.form === CAPABILITY_PLAN_FORM
      ? { ...event, data: { ...event.data, source: { ...event.data.source,
        snapshot: { ...event.data.source.snapshot, sessionOverrides: overrides } } } } : event)
    assert.equal(capabilitySelectionOf(damaged).state, 'unreadable', JSON.stringify(overrides))
  }
  // A plan that states no choice map at all and one that states an empty map are the same
  // absence of a decision: the session inherited everything, so the read is none rather than
  // a decided statement with no choices.
  for (const overrides of [undefined, {}]) {
    const empty = delivered.map(event => {
      if (event.data?.source?.form !== CAPABILITY_PLAN_FORM) return event
      const snapshot = { ...event.data.source.snapshot }
      if (overrides === undefined) delete snapshot.sessionOverrides
      else snapshot.sessionOverrides = overrides
      return { ...event, data: { ...event.data, source: { ...event.data.source, snapshot } } }
    })
    assert.equal(capabilitySelectionOf(empty).state, 'none', JSON.stringify(overrides))
  }
  // A plan message names the session it was composed for, and the readers that restore one
  // require that identity. The statement read applies the same rule, so a message re-tagged
  // for another session is not this session's decision; the record form carries no
  // identity, which is why the log it was appended to is its only one.
  const foreign = delivered.map(event => event.data?.source?.form === CAPABILITY_PLAN_FORM
    ? { ...event, data: { ...event.data, source: { ...event.data.source, sessionId: 'other-session' } } } : event)
  assert.equal(capabilitySelectionOf(foreign, agent.session.id).state, 'none')
  assert.equal(capabilitySelectionOf(foreign).legacy, true)
  // 0.5.4 recorded a dimension command as the rule it decided, so the same decision can
  // reach the replay in the other spelling. The delivered plan is still the composition
  // this session keeps: the comparison asks what each map decides, so the recorded
  // message is restored instead of a replacement being composed for the spelling alone.
  const policyConfig = { ...config(), capabilityPolicy: JSON.stringify({ schema: 'ptc-capability-policy/v1',
    defaults: { availability: 'enabled', disclosure: 'host' }, categories: {}, mcpServers: {}, items: {},
    allocation: { baseline: true, statistics: false, budget: true } }) }
  const dimensionWriting = createCapabilityEnvironment({ ctx, config: policyConfig, toolSchemasForAgent: () => schemas })
  t.after(() => dimensionWriting.dispose())
  const dimensionAgent = agentFor(Session.create('delivered-plan-dimensions'))
  dimensionAgent.runMaintenance = operation => operation(dimensionAgent.signal)
  await acceptPreparation(dimensionWriting, dimensionAgent, [])
  await dimensionWriting.change(dimensionAgent,
    { scope: 'session', id: 'tools.probe', dimension: 'availability', selection: 'closed' }, dimensionAgent.signal)
  await settle(dimensionWriting, dimensionAgent)
  const dimensionEvents = structuredClone(dimensionAgent.session.snapshotEvents())
  const dimensionPlan = dimensionEvents.findLast(event => event.data?.source?.form === CAPABILITY_PLAN_FORM)
  // This build wrote that decision in the compact spelling the saved configuration uses.
  assert.deepEqual(dimensionPlan.data.source.snapshot.sessionOverrides, { 'tools.probe': 'closed' })
  // The other spelling of the same decision, composed from the plan's own saved inputs so
  // it is a plan this build can validate: 0.5.4 stored the dimension rule, not the word.
  const dimensionSnapshot = dimensionPlan.data.source.snapshot
  const objectOverrides = { 'tools.probe': { availability: 'closed' } }
  const objectSettings = sessionCapabilitySettings(dimensionSnapshot.sourceSettings, objectOverrides)
  const objectPlan = createCapabilityPlan({ ...objectSettings, capabilities: dimensionSnapshot.capabilities,
    coverage: dimensionSnapshot.coverage, navigationText: dimensionSnapshot.navigationText,
    configurationRevision: createHash('sha256').update(JSON.stringify(objectSettings)).digest('hex') })
  const overage = dimensionSnapshot.promptText?.overageSentence ?? PLAN_OVERAGE
  const objectText = (objectPlan.enabled
    ? ['PTC Plus session capability environment:', objectPlan.directoryText, objectPlan.catalogText,
      ...(objectPlan.budgets.overageBytes ? [overage.replace(PLAN_OVERAGE_HOLE, String(objectPlan.budgets.overageBytes))] : [])]
      .filter(Boolean).join('\n\n')
    : 'PTC Plus capability management is off for this session. Use the host-provided capability contracts.')
  const objectSnapshot = { ...dimensionSnapshot, sessionOverrides: objectOverrides, settings: objectSettings, plan: objectPlan }
  const dimensionSpelling = { ...structuredClone(dimensionPlan.data),
    source: { ...dimensionPlan.data.source, refresh: false, snapshot: objectSnapshot,
      digest: createHash('sha256').update(JSON.stringify(objectSnapshot)).digest('hex') },
    content: [{ type: 'text', text: objectText }] }
  const dimensionLog = dimensionEvents.filter(event => event.data?.source?.form !== CAPABILITY_SELECTION_FORM)
    .map(event => ({ ...event, data: event === dimensionPlan ? dimensionSpelling : event.data }))
    .map((event, seq) => ({ ...event, seq }))
  const dimensionRestored = agentFor(Session.create(dimensionAgent.session.id, dimensionLog, dimensionAgent.session.header))
  const dimensionCold = createCapabilityEnvironment({ ctx: { agents: { list: () => [dimensionRestored] },
    systemPrompt: { assemble: async () => ({ sections: [] }) } }, config: policyConfig, toolSchemasForAgent: () => schemas })
  t.after(() => dimensionCold.dispose())
  const dimensionState = await dimensionCold.prepare(dimensionRestored, [])
  assert.deepEqual(Object.fromEntries(dimensionState.snapshot.plan.entries.map(entry => [entry.id, entry.selection])),
    { 'tools.probe': 'closed', 'tools.other': 'host' })
  // Restored in place and keeping the spelling it was delivered with: a rebuild composes
  // the compact spelling, so the snapshot states which path answered the upgrade.
  assert.equal(dimensionState.message?.id, dimensionPlan.data.id, 'the delivered plan is restored in place')
  assert.deepEqual(dimensionState.snapshot.sessionOverrides, objectOverrides)
})

test('successful first-session refresh receipts retain the refreshed source after cold restore', async t => {
  const ctx = new Context(); new CommandRuntime(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const make = settings => createCapabilityEnvironment({ ctx, config: settings, toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  const env = make(config()); t.after(() => env.dispose())
  const agent = agentFor(Session.create('refresh-pending-success')); agent.runMaintenance = operation => operation(agent.signal)
  await env.prepare(agent, [])
  env.reconfigure(config({ 'tools.probe': 'full' }))
  ctx.effect(() => ctx.commands.register({ name: 'capabilities', description: 'Refresh capabilities', handler: async ({ commandId, rawInput, agent, signal }) => {
    await env.refresh(agent, undefined, signal, commandId)
    return { kind: 'success', text: capabilityCommandReceipt('pending', agent.session.id, undefined,
      { commandId, rawInput, message: env.pendingChoiceMessage(agent) }) }
  } }))
  t.after(() => ctx.fiber.dispose())
  await ctx.commands.execute(agent, '/capabilities refresh', [], agent.signal)
  const cold = make(config()); t.after(() => cold.dispose())
  const restored = agentFor(Session.create(agent.session.id, agent.session.snapshotEvents(), agent.session.header))
  await cold.prepare(restored, [])
  assert.equal(cold.describe(restored).effective.entries.find(item => item.id === 'tools.probe').selection, 'full')
  const entered = await cold.preStep({ agent: restored, signal: restored.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(entered.messages[0].source.snapshot.settings.manual.overrides['tools.probe'], 'full',
    'the cold start restores the composition the refresh made, not the configuration it now sees')
  assert.equal(entered.messages[0].source.refresh, false)
})

test('SDK output contracts use only public scoped schemas and definitions with detached JSON', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' })
  const agent = agentFor(Session.create('public-sdk-contract'))
  const scope = createScope(ctx, agent)
  t.after(async () => { await scope.dispose(); await ctx.fiber.dispose() })
  const register = (target, type) => target.effect(() => target.tools.register(defineTool({
    name: 'probe', description: 'Scoped output', parameters: {},
    output: { schema: { type }, render: () => [] }, execute: async () => undefined,
  })))
  register(ctx, 'string')
  register(scope.ctx, 'number')
  const publicTools = { schemas: target => ctx.tools.schemas(target), get: (name, target) => ctx.tools.get(name, target) }
  assert.equal(toolSdkSchemas(publicTools)[0].output.type, 'string')
  const observed = toolSdkSchemas(publicTools, agent)
  assert.equal(observed[0].output.type, 'number')
  observed[0].output.type = 'boolean'
  assert.equal(toolSdkSchemas(publicTools, agent)[0].output.type, 'number')
  assert.equal(Object.hasOwn(ctx.tools.schemas(agent)[0], 'output'), false)
  assert.throws(() => toolSdkSchemas({ schemas: () => [schema('missing')], get: () => undefined }), /output schema must be lossless JSON/)
})

test('settings catalog states the named session\'s Skill eligibility from its scope and from its record', async t => {
  // The settings list is one supply read, so it states one workspace's answer. A
  // caller names the session whose directory it wants; which sessions happen to be
  // live changes no entry, and no cross-workspace vote has to be derived.
  const ctx = new Context()
  new SkillRegistry(ctx)
  const agents = ['user', 'model'].map(name => {
    const initial = Session.create(`invocation-${name}`)
    return agentFor(Session.create(initial.id, [], { ...initial.header, cwd: `/tmp/${name}` }))
  })
  const scopes = agents.map(agent => createScope(ctx, agent))
  ctx.effect(() => ctx.provide('agents', { list: () => agents }))
  const logs = new Map(agents.map(agent => [agent.session.id, agent.session]))
  ctx.effect(() => ctx.provide('sessionQuery', { observeSession: async id => {
    const source = logs.get(id)
    if (source === undefined) throw new Error(`no session ${id}`)
    return { header: source.header, cursor: source.seq - 1, events: source.snapshotEvents(), [Symbol.dispose]() {} }
  } }))
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name: 'workspace',
    list: async ({ cwd }) => [{ name: 'shared', provider: 'workspace', source: 'same-source',
      description: 'Shared Skill', rank: 100, locator: cwd,
      invocation: { modelInvocable: cwd.endsWith('/model'), userInvocable: !cwd.endsWith('/model') } }],
    get: async () => assert.fail('Catalog must not load Skill bodies'),
  })))
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('run_code')] })
  t.after(async () => { await env.dispose(); for (const scope of scopes) await scope.dispose(); await ctx.fiber.dispose() })
  const entriesOf = sessionId => env.describeCatalog({ sessionId })
  assert.deepEqual((await entriesOf(agents[1].session.id)).find(entry => entry.id === 'skills.shared').invocation,
    { modelInvocable: true, userInvocable: false })
  assert.deepEqual((await entriesOf(agents[0].session.id)).find(entry => entry.id === 'skills.shared').invocation,
    { modelInvocable: false, userInvocable: true })
  // Its record states the same Skill once the scope is gone: the plan the session froze
  // carries the declaration and its eligibility, not the provider bucket the live Skill
  // catalogue also names, so the comparison is over what the record owns.
  const live = await entriesOf(agents[1].session.id)
  await acceptPreparation(env, agents[1], [])
  agents.length = 0
  const cold = await entriesOf('invocation-model')
  assert.deepEqual(cold.map(entry => ({ id: entry.id, name: entry.name, category: entry.category, invocation: entry.invocation })),
    live.map(entry => ({ id: entry.id, name: entry.name, category: entry.category, invocation: entry.invocation })))
})

test('allocation observation reads workspace coverage and budget choices without publishing or freezing a session', async t => {
  const initial = Session.create('allocation-observation')
  const agent = agentFor(Session.create(initial.id, [], { ...initial.header, cwd: process.cwd() }))
  const schemas = [schema('run_code'), schema('probe'), schema('other')]
  const ctx = { agents: { list: () => [agent] }, systemPrompt: { assemble: async context => {
    assert.equal(context.ptcPlusCapabilityObservation, true)
    return { sections: [{ name: 'tool:probe', text: 'Shared owner guidance.' }] }
  } } }
  const revisions = Object.fromEntries(schemas.map(item => [item.name, createHash('sha256').update(JSON.stringify(item)).digest('hex')]))
  let reads = 0
  const coverage = Object.fromEntries(['probe', 'other'].map(name => [`tools.${name}`, { revision: revisions[name],
    workspace: { status: 'usable', windowSize: 100, eligible: 20, used: name === 'probe' ? 18 : 1, coverage: name === 'probe' ? .9 : .05 },
    global: { status: 'usable', windowSize: 100, eligible: 50, used: 3, coverage: .06 } }]))
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => schemas,
    store: { coverage: async target => { assert.equal(target, agent); reads++; return coverage },
      available: () => assert.fail('Observation must not register eligibility'), used: () => assert.fail('Observation must not register use') } })
  t.after(() => env.dispose())
  const configuration = capabilityProfileConfiguration({ capabilityManagementEnabled: true,
    capabilityStatistics: '{"enabled":true,"windowSize":100,"minimumSamples":10,"fullThreshold":0.5}' })
  const events = agent.session.snapshotEvents()
  const observed = await env.observeAllocation({ sessionId: agent.id, configuration }, agent.signal)
  assert.deepEqual(observed.coverage, coverage)
  assert.equal(observed.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'full')
  assert.equal(observed.plan.entries.find(entry => entry.id === 'tools.other').selection, 'on-demand')
  assert.match(observed.plan.catalogText, /Shared owner guidance/)
  assert.equal(observed.plan.budgets.contractBytes, Buffer.byteLength(observed.plan.catalogText))
  const small = await env.observeAllocation({ sessionId: agent.id, configuration: { ...configuration, capabilityBudgetBytes: 1 } }, agent.signal)
  assert.equal(small.plan.entries.find(entry => entry.id === 'tools.probe').reason, 'contract-budget')
  const pinned = await env.observeAllocation({ sessionId: agent.id, configuration: { ...configuration, capabilityBudgetBytes: 1, capabilityPolicy: JSON.stringify({ ...JSON.parse(configuration.capabilityPolicy), items: { 'tools.probe': { disclosure: 'full' } } }) } }, agent.signal)
  assert.equal(pinned.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'full')
  assert.ok(pinned.plan.budgets.overageBytes > 0)
  assert.equal(reads, 3)
  const damaged = await env.observeAllocation({ sessionId: agent.id, configuration: { ...configuration,
    capabilityStatistics: 'damaged', capabilityBaseline: '["tools.other"]' } }, agent.signal)
  assert.equal(damaged.coverage, null)
  assert.equal(damaged.plan.entries.find(entry => entry.id === 'tools.other').selection, 'full')
  assert.deepEqual(agent.session.snapshotEvents(), events)
  assert.equal(env.stateFor(agent), undefined)
  assert.deepEqual(env.describeSessions(), [])
  await assert.rejects(() => env.observeAllocation({ sessionId: 'missing', configuration }, agent.signal), /select a live session/)
  await assert.rejects(() => env.observeAllocation({ sessionId: agent.id, configuration: { ...configuration, apiKey: 'not-a-secret' } }, agent.signal), /configuration fields/)
  await assert.rejects(() => env.observeAllocation({ sessionId: agent.id, configuration }, AbortSignal.abort()), /abort/i)
  const gate = Promise.withResolvers()
  ctx.systemPrompt.assemble = async () => { await gate.promise; return { sections: [] } }
  const closing = env.observeAllocation({ sessionId: agent.id, configuration }, agent.signal)
  ctx.agents.list = () => []
  gate.resolve()
  await assert.rejects(closing, /no longer available/)
  ctx.agents.list = () => [agent]
  const cancelGate = Promise.withResolvers()
  ctx.systemPrompt.assemble = async () => { await cancelGate.promise; return { sections: [] } }
  const controller = new AbortController()
  const cancelled = env.observeAllocation({ sessionId: agent.id, configuration }, controller.signal)
  controller.abort()
  cancelGate.resolve()
  await assert.rejects(cancelled, /abort/i)
  assert.deepEqual(agent.session.snapshotEvents(), events)
  assert.equal(env.stateFor(agent), undefined)
})

test('Skill inventory follows the public current directory while saved plans and project statistics stay distinct', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new SkillRegistry(ctx)
  const initial = Session.create('current-skill-directory')
  const agent = agentFor(Session.create(initial.id, [], { ...initial.header, cwd: '/original-project' }))
  agent.runMaintenance = operation => operation(agent.signal)
  const scope = createScope(ctx, agent)
  let cwd = '/first-directory'
  ctx.effect(() => ctx.provide('workingDirectory', { get: session => { assert.equal(session, agent.session); return cwd } }))
  ctx.effect(() => ctx.provide('agents', { list: () => [agent] }))
  let observedDirectory
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name: 'directory-skills',
    list: async options => { observedDirectory = options.cwd; return [{ name: options.cwd.slice(1), provider: 'directory-skills',
      source: 'project', description: 'Current project Skill', rank: 100, locator: options.cwd,
      invocation: { modelInvocable: true, userInvocable: true } }] },
    get: async () => assert.fail('Inventory must not load Skill bodies'),
  })))
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('run_code')] })
  t.after(async () => { await env.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  const original = await acceptPreparation(env, agent, [])
  assert.equal(observedDirectory, cwd)
  const frozen = JSON.stringify(original.snapshot)
  cwd = '/second-directory'
  // The settings list states the directory this session's header names, not the live
  // working directory: a read that followed the runtime would change the list while
  // nothing was decided, and would read a directory the session never named.
  assert.deepEqual((await env.describeCatalog({ sessionId: agent.session.id }, agent.signal))
    .filter(item => item.category === 'skill').map(item => item.id), ['skills.original-project'])
  const observation = await env.observeAllocation({ sessionId: agent.id }, agent.signal)
  assert.ok(observation.plan.entries.some(item => item.id === 'skills.second-directory'))
  assert.equal(observation.workspace, '/original-project')
  assert.equal(JSON.stringify(env.stateFor(agent).snapshot), frozen)
  await env.refresh(agent, [], agent.signal)
  assert.ok(env.stateFor(agent).snapshot.capabilities.some(item => item.id === 'skills.second-directory'))
  assert.equal(agent.session.header.cwd, '/original-project')
})

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
    toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) }
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
  const schemas = toolSdkSchemas(ctx.tools, agent)
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

test('reenabling after provider withdrawal cannot restore an earlier frozen capability plan', async t => {
  const session = Session.create('withdrawn-plan')
  const agent = agentFor(session)
  const ctx = { systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const original = createCapabilityEnvironment({ ctx, config: config({ 'tools.probe': 'closed' }), toolSchemasForAgent: () => [schema('probe')] })
  await acceptPreparation(original, agent, [])
  session.append('user/message', runtimeAvailabilityMessage('disabled'), { surfaceOp: 'append' })
  await original.dispose()
  const resumed = createCapabilityEnvironment({ ctx, config: config({ 'tools.probe': 'full' }), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => resumed.dispose())
  const state = await acceptPreparation(resumed, agent, [])
  assert.equal(state.snapshot.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'full')
})

test('a routine provider release keeps the frozen plan when the session resumes', async t => {
  const session = Session.create('unloaded-plan-restore')
  const agent = agentFor(session)
  const ctx = { systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const original = createCapabilityEnvironment({ ctx, config: config({ 'tools.probe': 'closed' }), toolSchemasForAgent: () => [schema('probe')] })
  const prepared = await acceptPreparation(original, agent, [])
  const frozenPlan = JSON.stringify(prepared.snapshot.plan)
  session.append('user/message', runtimeAvailabilityMessage('unloaded'), { surfaceOp: 'append' })
  await original.dispose()
  const resumed = createCapabilityEnvironment({ ctx, config: config({ 'tools.probe': 'full' }), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => resumed.dispose())
  const state = await acceptPreparation(resumed, agent, [])
  assert.equal(JSON.stringify(state.snapshot.plan), frozenPlan,
    'saved configuration must not redistribute a session that resumed after a routine release')
  assert.equal(state.snapshot.plan.entries.find(entry => entry.id === 'tools.probe').selection, 'closed')
  assert.equal(session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-plan').length, 1,
    'resuming after a routine release must not publish a second plan')
})

test('new Skills outside a frozen plan stay declared and usable until refresh folds them into the plan', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' })
  new SkillRegistry(ctx)
  skillTool.apply(ctx)
  const agent = agentFor(Session.create('new-skill'))
  agent.runMaintenance = operation => operation(agent.signal)
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  let names = ['original']
  let bodyReads = 0
  let control
  ctx.effect(() => ctx.skills.registerProvider(owner => {
    control = owner
    return { name: 'changing',
      list: async () => names.map(name => ({ name, provider: 'changing', source: 'fixture',
        description: name, rank: 100, locator: name, invocation: { modelInvocable: true, userInvocable: true } })),
      get: async entry => { bodyReads++; return { ...entry, content: `BODY ${entry.name}` } },
    }
  }))
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) })
  t.after(async () => { await env.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  await acceptPreparation(env, agent, [])
  names = ['original', 'new-skill']
  control.invalidate()
  const invoke = async () => {
    const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/new-skill task' }] })]
    return env.preStep({ agent, signal: agent.signal }, () => agentEvents(ctx, agent).waterfall('agent/pre-step',
      { messages, turn: 2, step: 1, signal: agent.signal }, async () => ({ kind: 'enter', messages })))
  }
  const closed = await invoke()
  assert.equal(bodyReads, 1)
  assert.match(closed.messages.find(message => message.source.kind === 'skill-invocation').content[0].text, /BODY new-skill/)
  assert.equal(env.stateFor(agent).snapshot.capabilities.some(item => item.id === 'skills.new-skill'), false)
  await env.refresh(agent, [], agent.signal)
  assert.equal(env.stateFor(agent).snapshot.capabilities.some(item => item.id === 'skills.new-skill'), true)
  const opened = await invoke()
  assert.equal(bodyReads, 2)
  assert.match(opened.messages.find(message => message.source.kind === 'skill-invocation').content[0].text, /BODY new-skill/)
})

test('Host tools added after the plan froze stay declared and callable until refresh', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' })
  const tool = name => defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => name })
  ctx.effect(() => ctx.tools.register(tool('probe')))
  const agent = agentFor(Session.create('live-tool-addition'))
  const env = createCapabilityEnvironment({ ctx, config: config(),
    toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  ctx.effect(() => ctx.tools.register(tool('added')))
  await env.prepare(agent, [])
  const state = env.stateFor(agent)
  assert.equal(state.snapshot.capabilities.some(item => item.id === 'tools.added'), false,
    'the live addition stays outside the frozen plan until an explicit refresh')
  assert.deepEqual(env.projectMembers(agent, ['probe', 'added']), ['probe', 'added'])
  assert.deepEqual(env.visibleSchemas(agent, [schema('probe'), schema('added')]).map(item => item.name), ['probe', 'added'])
  assert.match(env.sdk(agent, 'NATIVE SDK'), /added/)
  assert.equal(env.adaptFunction(agent, 'added', () => 'ok')(), 'ok')
})

test('an explicit availability rule keeps a late Host tool closed across declarations and dispatch', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' })
  const tool = name => defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => name })
  ctx.effect(() => ctx.tools.register(tool('kept')))
  const agent = agentFor(Session.create('late-closed-tool'))
  const env = createCapabilityEnvironment({ ctx, config: config({ 'tools.closed-later': 'closed' }),
    toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  ctx.effect(() => ctx.tools.register(tool('closed-later')))
  await env.prepare(agent, [])
  assert.deepEqual(env.projectMembers(agent, ['kept', 'closed-later']), ['kept'])
  assert.deepEqual(env.visibleSchemas(agent, [schema('kept'), schema('closed-later')]).map(item => item.name), ['kept'])
  assert.throws(() => env.adaptFunction(agent, 'closed-later', () => 'ok')(), /closed-later/)
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

/**
 * The runtime's materialization of a recorded choice.
 *
 * A change writes one record. The composition that acts on it is rebuilt by the
 * entry that composes one, at the next accepted step; a test that asserts the plan
 * a session acts on therefore settles the record the way a step does. A test that
 * asserts what the session decided reads the record itself and needs no settling.
 */
async function settle(env, agent) {
  const state = await env.prepare(agent)
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
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
    toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agent, [])
  const capability = state.snapshot.capabilities.find(item => item.id === 'tools.read')
  assert.deepEqual(capability.schema.output, output)
  assert.match(capability.contract, /file_path: string/)
  assert.match(capability.contract, /lines:/)
  assert.match(capability.contract, /number: number/)
  assert.match(capability.contract, /text: string/)
  assert.doesNotMatch(capability.contract, /Promise<unknown>/)
  const oldSchemas = toolSdkSchemas(ctx.tools, agent)
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
  const currentSchemas = toolSdkSchemas(ctx.tools, agent)
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

test('Host calling contract changes append accepted updates while saved choices and historical plans stay frozen', async t => {
  const agent = agentFor(Session.create('live-calling-contracts'))
  let schemas = [schema('probe'), schema('other')]
  const available = []
  const env = createCapabilityEnvironment({ ctx: {}, config: config({ 'tools.probe': 'full' }),
    toolSchemasForAgent: () => schemas, store: { available: (_agent, snapshot) => available.push(snapshot) } })
  t.after(() => env.dispose())
  const original = await acceptPreparation(env, agent, [])
  const frozen = JSON.stringify(original.snapshot)
  const step = (signal = agent.signal, kind = 'enter') => env.preStep({ agent, signal }, async () => ({ kind, messages: [] }))
  const accept = async () => {
    const proposal = await step()
    for (const message of proposal.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    return proposal.messages.find(message => message.source.form === 'capability-contracts')
  }
  env.reconfigure({ ...config({ 'tools.probe': 'closed', 'tools.other': 'full' }),
    capabilityStatistics: '{"enabled":true,"windowSize":10,"minimumSamples":1,"fullThreshold":0}' })
  assert.equal(await accept(), undefined, 'Saving settings or statistics must not revise an existing plan.')
  schemas = [{ ...schema('probe'), parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, output: { type: 'number' } }, schema('other')]
  assert.equal((await step(agent.signal, 'reject')).messages.length, 0)
  assert.equal((await step(AbortSignal.abort())).messages.length, 0)
  assert.equal(agent.session.snapshotEvents().filter(event => event.data?.source?.form === 'capability-contracts').length, 0)
  const notice = await accept()
  assert.match(notice.content[0].text, /path: string/)
  assert.match(notice.content[0].text, /Promise<number>/)
  assert.equal(notice.source.snapshot.changes[0].disclosure, 'full')
  assert.equal(JSON.stringify(env.stateFor(agent).snapshot), frozen)
  assert.deepEqual(env.projectMembers(agent, ['probe', 'other']), ['probe', 'other'])
  assert.equal(await accept(), undefined)
  assert.equal(available.at(-1).plan.entries.find(entry => entry.id === 'tools.probe').revision,
    createHash('sha256').update(JSON.stringify(schemas[0])).digest('hex'))
  const restored = createCapabilityEnvironment({ ctx: {}, config: config({ 'tools.probe': 'closed' }), toolSchemasForAgent: () => schemas })
  t.after(() => restored.dispose())
  await restored.prepare(agent, [])
  assert.equal((await restored.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] })))
    .messages.some(message => message.source.form === 'capability-contracts'), false)
  schemas = [schema('other')]
  const removal = await accept()
  assert.match(removal.content[0].text, /Host no longer supplies/)
  assert.equal(removal.source.snapshot.changes[0].capability, null)
  assert.deepEqual(env.projectMembers(agent, ['probe', 'other']), ['other'])
  assert.equal(await accept(), undefined)
  schemas = [schema('probe'), schema('other')]
  const reinstated = await accept()
  assert.match(reinstated.content[0].text, /Promise<string>/)
  assert.deepEqual(env.projectMembers(agent, ['probe', 'other']), ['probe', 'other'])
  assert.equal(JSON.stringify(env.stateFor(agent).snapshot), frozen)
})

test('live Skill eligibility and owner guidance revisions update contracts without loading bodies or reallocating choices', async t => {
  const agent = agentFor(Session.create('live-skill-contracts'))
  let skills = [{ name: 'design', provider: 'fixture', source: 'fixture', description: 'Design a page.',
    invocation: { modelInvocable: true, userInvocable: true } }]
  const ctx = { skills: { snapshot: async () => ({ complete: true, skills }) } }
  const env = createCapabilityEnvironment({ ctx, config: { ...config({ 'skills.design': 'full', 'tools.probe': 'full' }), capabilityBudgetBytes: 1 },
    toolSchemasForAgent: () => [schema('probe'), schema('skill')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [{ name: 'tool:probe', text: 'Original owner guidance.' }])
  const frozen = JSON.stringify(env.stateFor(agent).snapshot)
  skills = [{ ...skills[0], invocation: { modelInvocable: false, userInvocable: true } }]
  await env.prepare(agent, [{ name: 'tool:probe', text: 'Updated owner guidance.' }])
  const changed = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  const notice = changed.messages.find(message => message.source.form === 'capability-contracts')
  assert.match(notice.content[0].text, /Updated owner guidance/)
  assert.match(notice.content[0].text, /User-only Skill/)
  assert.doesNotMatch(notice.content[0].text, /await tools\.skill/)
  assert.match(notice.content[0].text, /exceed the configured budget/)
  assert.equal(env.metadata(agent)[0].members[0].invocation.modelInvocable, false)
  assert.deepEqual(env.projectMembers(agent, ['probe', 'skill']), ['probe'])
  assert.equal(JSON.stringify(env.stateFor(agent).snapshot), frozen)
  for (const message of changed.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  skills = []
  const removed = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.match(removed.messages.find(message => message.source.form === 'capability-contracts').content[0].text, /Host no longer supplies/)
  assert.deepEqual(env.metadata(agent)[0].members, [])
  assert.equal(JSON.stringify(env.stateFor(agent).snapshot), frozen)
})

test('first capability plan remains provisional across rejected and aborted steps and enters once', async () => {
  const agent = agentFor(Session.create('provisional-capability-plan'))
  const env = createCapabilityEnvironment({ ctx: {}, config: config(), toolSchemasForAgent: () => [schema('probe')] })
  const state = await env.prepare(agent, sections)
  assert.equal(agent.session.snapshotEvents().length, 0)
  assert.equal(env.describe(agent).publication, 'pending')
  assert.equal(env.describeSessions()[0].publication, 'pending')
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
  assert.equal(env.describeSessions()[0].publication, 'accepted')
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
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) })
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
  snapshot.schema = 'ptc-capability-environment/v3'
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

for (const missing of ['sourceSettings', 'sessionOverrides', 'manual']) test(`damaged v2 ${missing} produces an owned recovery diagnostic and host fallback`, async t => {
  const agent = agentFor(Session.create(`damaged-v2-${missing}`)); agent.runMaintenance = operation => operation(agent.signal)
  const ctx = { systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  // The record is materialized by the next composition, which is what publishes the
  // plan this test damages.
  await settle(env, agent)
  const events = structuredClone(agent.session.snapshotEvents())
  const original = events.findLast(event => event.data?.source?.form === 'capability-plan')
  assert.equal(original.data.source.snapshot.schema, 'ptc-capability-environment/v2')
  if (missing === 'manual') original.data.source.snapshot.sourceSettings.manual = null
  else delete original.data.source.snapshot[missing]
  original.data.source.digest = createHash('sha256').update(JSON.stringify(original.data.source.snapshot)).digest('hex')
  const warnings = []
  const fresh = createCapabilityEnvironment({ ctx: { logger: { warn: message => warnings.push(message) } }, config: config(), toolSchemasForAgent: () => [] })
  t.after(() => fresh.dispose())
  const state = await fresh.prepare(agentFor(Session.create(agent.session.id, events, agent.session.header)), [])
  assert.equal(state.snapshot.plan.enabled, false)
  assert.match(warnings[0], /damaged session capability choices/)
  assert.doesNotMatch(warnings[0], /Cannot read properties|TypeError/)
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

test('settings catalog reads the current Host declaration while disabled plans and model history remain unchanged', async () => {
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
  await assert.rejects(env.describeCatalog({}, controller.signal), /abort/i)
})

test('settings catalog lists declared tools before any session composes a plan and publishes nothing', async () => {
  const agent = agentFor(Session.create('capability-settings-before-first-step'))
  const env = createCapabilityEnvironment({ ctx: { agents: { list: () => [agent] } }, config: config(),
    toolSchemasForAgent: () => [schema('run_code'), schema('read')] })
  assert.deepEqual((await env.describeCatalog()).map(entry => entry.id), ['tools.read'])
  assert.equal(env.describe(agent).effective, null)
  assert.deepEqual(agent.session.snapshotEvents(), [])
})

test('refresh targets list every live session without reading or preparing frozen plans when management is off', async () => {
  const code = agentFor(Session.create('refresh-code'))
  const native = agentFor(Session.create('refresh-native'))
  let live = [code, native]
  let ptc = true
  const env = createCapabilityEnvironment({ ctx: { agents: { list: () => live } },
    config: { ...config(), capabilityManagementEnabled: false },
    // The model's own tool table is a live input this read never consults.
    toolSchemasForAgent: () => ptc ? [schema('run_code'), schema('read')] : [schema('read')] })
  // Which live agent's composition a refresh replaces is the only fact a target
  // supplies. Whether a session's model tool table declares the direct transport
  // answers a different question, and no target row answers it.
  assert.deepEqual(env.describeTargets(), [{ sessionId: 'refresh-code' }, { sessionId: 'refresh-native' }])
  ptc = false
  assert.deepEqual(env.describeTargets(), [{ sessionId: 'refresh-code' }, { sessionId: 'refresh-native' }])
  ptc = true
  assert.equal(env.describe(code).effective, null)
  assert.deepEqual(code.session.snapshotEvents(), [])
  // A catalogue read names the session, not an agent: this session lists its rows
  // whether or not anything is running for it, and the read prepares nothing.
  assert.deepEqual((await env.describeSessionCatalog({ sessionId: native.session.id }, native.signal))
    .rows.map(row => row.id), ['tools.read'])
  assert.equal(env.stateFor(native), undefined)
  // A refresh replaces one live agent's composition, so that entry states the agent it
  // acts on as a usage requirement; no session fact decides it.
  await assert.rejects(() => env.refresh(undefined, [], undefined), /needs an agent/)
  live = []
  assert.deepEqual(env.describeTargets(), [])
})

test('settings inventory integrates tools Skills and joint MCP resources and templates without changing frozen model contracts', async t => {
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
    toolSchemasForAgent: () => ['run_code', 'read', 'mcp__docs__search', 'list_mcp_resources',
      'list_mcp_resource_templates', 'read_mcp_resource'].map(name => schema(name)) })
  t.after(async () => { await env.dispose(); await scope.dispose(); await owner.fiber.dispose() })
  const first = await env.describeCatalog()
  assert.deepEqual(first.find(entry => entry.id === 'skills.image-design').source,
    { kind: 'skill', bucket: 'user-agents', provider: 'filesystem' })
  assert.equal(first.find(entry => entry.id === 'skills.image-design').name, 'image-design')
  assert.deepEqual(first.find(entry => entry.id === 'tools.mcp__docs__search').source, { kind: 'host' },
    'A tool name alone cannot prove its MCP source.')
  assert.equal(env.describe(agent).effective, null)
  const hostSections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' },
    { name: 'mcp:docs', text: 'Docs server owner instructions' }]
  const state = await env.prepare(agent, hostSections)
  const frozen = JSON.stringify(state.snapshot)
  // The Host's declaration, not the frozen plan, is what proves an MCP server owns a
  // tool: the settings list reads the same global sections the panel reads, so the
  // declaration is registered the way the Host registers it.
  owner.effect(() => owner.provide('systemPrompt', { assemble: async () => ({ sections: hostSections }) }))
  const catalog = await env.describeCatalog({ sessionId: agent.session.id })
  assert.deepEqual([...new Set(catalog.map(entry => entry.category))].sort(), ['resource', 'skill', 'tool'])
  const resources = state.snapshot.capabilities.filter(entry => entry.category === 'resource')
  assert.deepEqual(resources.map(entry => entry.id), ['mcp.docs'])
  assert.match(resources[0].contract, /tools\.list_mcp_resources/)
  assert.match(resources[0].contract, /tools\.list_mcp_resource_templates/)
  assert.match(resources[0].contract, /tools\.read_mcp_resource/)
  assert.match(resources[0].description, /registered resource layer/)
  assert.doesNotMatch(resources[0].description, /resources and templates from/)
  assert.equal(env.metadata(agent).find(entry => entry.namespace === 'mcp').members
    .find(member => member.name === 'docs').description, resources[0].description)
  assert.deepEqual(catalog.find(entry => entry.id === 'tools.mcp__docs__search').source, { kind: 'mcp', server: 'docs' })
  assert.deepEqual(catalog.find(entry => entry.id === 'tools.read').source, { kind: 'host' })
  assert.equal(JSON.stringify(state.snapshot), frozen)
  assert.equal(Object.hasOwn(state.snapshot.capabilities.find(entry => entry.id === 'skills.image-design'), 'source'), false)
  assert.equal(bodies, 0)
  assert.deepEqual(agent.session.snapshotEvents(), [])
})

test('a tool name declared by two server namespaces states both servers as its source', async t => {
  const owner = new Context()
  const env = createCapabilityEnvironment({ ctx: owner, config: config(),
    toolSchemasForAgent: () => ['run_code', 'probe', 'mcp__docs__search', 'mcp__docs__deep__search'].map(name => schema(name)) })
  t.after(async () => { await env.dispose(); await owner.fiber.dispose() })
  owner.effect(() => owner.provide('systemPrompt', { assemble: async () => ({ sections: [
    { name: 'mcp:docs', text: 'Docs server owner instructions' },
    { name: 'mcp:docs__deep', text: 'Deep docs server owner instructions' }] }) }))
  const catalog = await env.describeCatalog()
  const source = id => catalog.find(entry => entry.id === id).source
  // `mcp__docs__deep__search` begins with both `mcp__docs__` and `mcp__docs__deep__`,
  // so both declared servers name it. The catalogue states the whole list: dropping it
  // would leave the panel's source column with no server to name.
  assert.deepEqual(source('tools.mcp__docs__deep__search'), { kind: 'mcp', servers: ['docs', 'docs__deep'] })
  assert.deepEqual(source('tools.mcp__docs__search'), { kind: 'mcp', server: 'docs' })
  assert.deepEqual(source('tools.probe'), { kind: 'host' })
})

test('capability contracts keep the Host SDK member shape for valid and exotic names', async t => {
  const agent = agentFor(Session.create('sdk-member-shape'))
  const schemas = [schema('mcp__docker__firecrawl_scrape'), { ...schema('exotic-name'), description: 'Exotic owner contract.' }]
  const env = createCapabilityEnvironment({ ctx: { systemPrompt: { assemble: async () => ({ sections: [] }) } },
    config: config({ 'tools.mcp__docker__firecrawl_scrape': 'full', 'tools.exotic-name': 'full' }),
    toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  const state = await env.prepare(agent, [])
  const contract = id => state.snapshot.capabilities.find(item => item.id === id).contract
  assert.match(contract('tools.mcp__docker__firecrawl_scrape'), /tools\.mcp__docker__firecrawl_scrape\(args: /)
  assert.doesNotMatch(contract('tools.mcp__docker__firecrawl_scrape'), /tools\[/)
  assert.match(contract('tools.exotic-name'), /tools\["exotic-name"\]\(args: /)
  const hostSdk = renderToolsSdk(schemas)
  assert.match(hostSdk, /\n  mcp__docker__firecrawl_scrape: /)
  assert.match(hostSdk, /\n  "exotic-name": /)
})


test('Skill contracts preserve model and user invocation eligibility across disclosure, discovery and Host loading', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  new SkillRegistry(ctx)
  skillTool.apply(ctx)
  const agent = agentFor(Session.create('skill-invocation-contracts'))
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  ctx.effect(() => ctx.provide('agents', { list: () => [agent] }))
  const invocations = {
    'model-only': { modelInvocable: true, userInvocable: false },
    'user-only': { modelInvocable: false, userInvocable: true },
    both: { modelInvocable: true, userInvocable: true },
    neither: { modelInvocable: false, userInvocable: false },
    closed: { modelInvocable: false, userInvocable: true },
    'user-demand': { modelInvocable: false, userInvocable: true },
  }
  let bodyReads = 0
  // The provider is the Host's declaration of the Skills it supplies, so it lives at
  // the global layer the settings list reads; the session read still states each
  // entry's own eligibility.
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name: 'invocation-provider',
    list: async () => Object.entries(invocations).map(([name, invocation]) => ({ name, invocation,
      description: `${name} owner summary`, provider: 'invocation-provider', source: 'fixture', rank: 100, locator: name })),
    get: async entry => { bodyReads++; return { ...entry, content: `BODY ${entry.name}` } },
  })))
  const used = []
  const env = createCapabilityEnvironment({ ctx,
    config: config({ 'skills.model-only': 'full', 'skills.user-only': 'full', 'skills.both': 'full', 'skills.closed': 'closed' }),
    toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target), store: { used: (...args) => used.push(args) } })
  t.after(async () => { await env.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  const state = await acceptPreparation(env, agent, [])
  assert.equal(bodyReads, 0)
  assert.match(state.snapshot.plan.catalogText, /User-only Skill: the user can invoke \/user-only/)
  assert.doesNotMatch(state.snapshot.capabilities.find(item => item.id === 'skills.user-only').contract, /await tools\.skill/)
  assert.doesNotMatch(state.snapshot.plan.directoryText, /load the body with tools\.skill/)
  const metadata = env.metadata(agent)
  for (const name of ['model-only', 'user-only', 'both', 'user-demand']) {
    const item = capabilityInspect(metadata, [`skills.${name}`]).symbols[0]
    assert.deepEqual(item.invocation, invocations[name])
    const match = capabilitySearch(metadata, { query: `skills.${name}` }).matches[0].contract
    assert.deepEqual(match.invocation, invocations[name])
    if (invocations[name].modelInvocable) assert.match(match.contract, /await tools\.skill/)
    else assert.match(match.contract, /The model cannot load this Skill with tools\.skill/)
  }
  assert.deepEqual(capabilityInspect(metadata, ['skills.neither', 'skills.closed']).unknown, ['skills.neither', 'skills.closed'])
  const catalog = await env.describeCatalog({ sessionId: agent.session.id })
  assert.deepEqual(catalog.find(item => item.id === 'skills.user-only').invocation, invocations['user-only'])
  assert.ok(catalog.some(item => item.id === 'skills.closed'), 'The user can still configure a closed entry.')
  assert.equal(bodyReads, 0)
  const rejected = await ctx.tools.execute({ agent, name: 'skill', arguments: { name: 'user-only' }, callId: 'user-only-model', signal: agent.signal })
  assert.equal(rejected.isError, true)
  assert.match(rejected.error.message, /not available for model invocation/)
  assert.equal(bodyReads, 0)
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/user-only task' }] })]
  const loaded = await env.preStep({ agent, signal: agent.signal }, () => agentEvents(ctx, agent)
    .waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: agent.signal }, async () => ({ kind: 'enter', messages })))
  assert.match(loaded.messages.find(message => message.source?.kind === 'skill-invocation').content[0].text, /BODY user-only/)
  assert.equal(bodyReads, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(used.some(args => args[2] === 'skills.user-only' && args[3] === 'skill-body-accepted'))
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
  const completion = session.append('tool/result', { turn: 1, step: 1, message, ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
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
    toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) })
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
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name), ['probe', 'new-skill'])
  assert.equal(env.stateFor(agent).snapshot.capabilities.some(item => item.id === 'skills.new-skill'), false,
    'the live addition stays outside the frozen plan until an explicit refresh')
  agent.runMaintenance = operation => operation(agent.signal)
  ctx.systemPrompt = { assemble: async () => ({ sections: [] }) }
  await env.refresh(agent)
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name).sort(), ['new-skill', 'probe'])
  assert.equal(env.stateFor(agent).snapshot.capabilities.some(item => item.id === 'skills.new-skill'), true)
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
    session.append('tool/result', { turn: 1, step: 1, message, ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
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
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => toolSdkSchemas(ctx.tools, agent) })
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
  assert.deepEqual(env.metadata(agent).find(entry => entry.namespace === 'mcp').members.map(member => member.name),
    ['kept', 'new-server'])
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
  const catalog = await env.describeCatalog({ sessionId: agent.session.id }, agent.signal)
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


const composedConfig = (policy, extra = {}) => ({ ...config(), capabilityPolicy: JSON.stringify(policy ?? JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)),
  capabilityRecoveryEnabled: false, modelPreviewEnabled: false, ...extra })

test('composed availability controls retain host SDK and shared instructions while freezing independent choices across restore', async t => {
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.probe'] = { availability: 'closed', disclosure: 'full' }
  const hostSections = [{ name: 'tools:sdk', text: 'native sdk' }, { name: 'tool:probe', text: 'Probe instruction' },
    { name: 'mcp:docs', text: 'Shared docs instruction' }]
  const schemas = ['run_code', 'probe', 'other', 'mcp__docs__read', 'mcp__docs__write'].map(schema)
  policy.items['tools.mcp__docs__write'] = { disclosure: 'on-demand' }
  const agent = agentFor(Session.create('composed-controls'))
  agent.runMaintenance = operation => operation(agent.signal)
  const ctx = { systemPrompt: { assemble: async () => ({ sections: hostSections }) } }
  const env = createCapabilityEnvironment({ ctx, config: composedConfig(policy), toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, hostSections)
  assert.equal(env.stateFor(agent).snapshot.schema, 'ptc-capability-environment/v3')
  assert.ok(env.sdk(agent, 'native sdk').includes('other'))
  assert.ok(!env.sdk(agent, 'native sdk').includes('probe'))
  assert.ok(env.projectSections(agent, hostSections).some(section => section.name === 'mcp:docs'))
  assert.ok(!env.projectSections(agent, hostSections).some(section => section.name === 'tool:probe'))
  assert.ok(!env.projectMembers(agent, ['probe', 'other']).includes('probe'))
  assert.throws(() => env.validateSupply(agent, 'probe', {}), /unknown|not found|registered/i)
  await env.change(agent, { scope: 'session', id: 'tools.probe', dimension: 'availability', selection: 'enabled' }, agent.signal)
  await settle(env, agent)
  assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'tools.probe').selection, 'full')
  await env.change(agent, { scope: 'session', id: 'tools.probe', dimension: 'availability', selection: 'closed' }, agent.signal)
  await settle(env, agent)
  assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'tools.probe').disclosure, 'full')
  const recorded = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
  const coldAgent = agentFor(Session.create(agent.session.id, recorded, agent.session.header))
  const cold = createCapabilityEnvironment({ ctx, config: composedConfig(null, { modelPreviewEnabled: true }), toolSchemasForAgent: () => schemas })
  t.after(() => cold.dispose())
  await cold.prepare(coldAgent, hostSections)
  assert.deepEqual(cold.stateFor(coldAgent).snapshot, env.stateFor(agent).snapshot)
  assert.equal(cold.stateFor(coldAgent).snapshot.settings.previewEnabled, false)
  assert.equal(cold.describe(coldAgent).pendingRefresh, true)
})

test('a managed SDK render declares the edit transport and never the direct transport', async t => {
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.probe'] = { availability: 'closed' }
  const hostSections = [{ name: 'tools:sdk', text: 'native sdk' }]
  const schemas = ['run_code', 'edit_run_code', 'probe', 'other'].map(schema)
  const agent = agentFor(Session.create('managed-sdk-transport'))
  agent.runMaintenance = operation => operation(agent.signal)
  const ctx = { systemPrompt: { assemble: async () => ({ sections: hostSections }) } }
  const env = createCapabilityEnvironment({ ctx, config: composedConfig(policy), toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, hostSections)
  const rendered = env.sdk(agent, 'native sdk')
  assert.notEqual(rendered, 'native sdk')
  assert.match(rendered, /\n  edit_run_code: /)
  assert.match(rendered, /\n  other: /)
  assert.doesNotMatch(rendered, /\n  probe: /)
  assert.doesNotMatch(rendered, /\n  run_code: /)
  // A fully Host-declared surface keeps the native render, which already
  // declares the same transport member.
  const open = createCapabilityEnvironment({ ctx, config: composedConfig(null), toolSchemasForAgent: () => schemas })
  t.after(() => open.dispose())
  const openAgent = agentFor(Session.create('managed-sdk-transport-open'))
  openAgent.runMaintenance = operation => operation(openAgent.signal)
  await acceptPreparation(open, openAgent, hostSections)
  assert.equal(open.sdk(openAgent, 'native sdk'), 'native sdk')
})

for (const contextEnabled of [undefined, true, false]) for (const recoveryEnabled of [false, true]) test(`composed description group=${contextEnabled} recovery=${recoveryEnabled} changes only optional restoration`, async t => {
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.defaults.disclosure = 'on-demand'
  const session = Session.create(`composed-recovery-${recoveryEnabled}`)
  const agent = agentFor(session)
  let schemas = [schema('probe')]
  const env = createCapabilityEnvironment({ ctx: {}, config: composedConfig(policy, { capabilityContextEnabled: contextEnabled, capabilityRecoveryEnabled: recoveryEnabled }),
    toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  env.explored(agent, { matches: [{ symbol: 'tools.probe' }] })
  const invocation = { agent, name: 'probe', token: {} }; env.admitted(invocation); env.dispatched(invocation, { isError: false })
  const result = env.complete({ agent }, { isError: false, value: 42 })
  const call = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'expanded', arguments: '{}' })
  const message = createToolResultMessage({ callId: 'expanded', isError: false,
    content: [{ type: 'text', text: contextEnabled === false ? 'Host-provided probe contract.' : env.stateFor(agent).snapshot.capabilities[0].contract }] })
  const completion = session.append('tool/result', { turn: 1, step: 1, message, ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const step = () => env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal((await step()).messages.some(item => item.source.form === 'capability-descriptions'), false)
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted.' }] }),
    { surfaceOp: { op: 'replace', startSeq: completion.seq, endSeq: completion.seq }, sourceEventSeqs: [completion.seq] })
  const recovery = (await step()).messages.find(item => item.source.form === 'capability-descriptions')
  assert.equal(Boolean(recovery), contextEnabled !== false && recoveryEnabled)
  if (recovery) {
    session.append('user/message', recovery, { surfaceOp: 'append' })
    assert.equal((await step()).messages.some(item => item.source.form === 'capability-descriptions'), false)
  }
  schemas = [{ ...schema('probe'), description: 'Updated calling contract' }]
  const updates = (await step()).messages.filter(item => item.source.form === 'capability-contracts')
  assert.equal(updates.length, contextEnabled === false ? 0 : 1, 'Necessary contract revisions survive recovery opt-out while group selection delegates the Host.')
  assert.equal(result.value, 42)
})

test('composed collection without management observes actual public availability and preserves its frozen policy on cold restore', async t => {
  const observed = []
  const store = { available: (_agent, snapshot) => observed.push(snapshot), used: (_agent, snapshot, id) => observed.push({ snapshot, id }) }
  const agent = agentFor(Session.create('composed-collection'))
  const selected = composedConfig(null, { capabilityManagementEnabled: false,
    capabilityStatistics: '{"enabled":true,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' })
  const env = createCapabilityEnvironment({ ctx: {}, config: selected, store, toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(observed[0].plan.enabled, false)
  assert.deepEqual(observed[0].plan.entries.map(entry => [entry.id, entry.selection]), [['tools.probe', 'host']])
  const invocation = { agent, name: 'probe', token: {} }; env.admitted(invocation); env.dispatched(invocation, { isError: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(observed.at(-1).id, 'tools.probe')
  const coldAgent = agentFor(Session.create(agent.session.id, JSON.parse(JSON.stringify(agent.session.snapshotEvents())), agent.session.header))
  const cold = createCapabilityEnvironment({ ctx: {}, config: composedConfig(), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => cold.dispose())
  await cold.prepare(coldAgent, [])
  assert.equal(cold.stateFor(coldAgent).snapshot.settings.statistics.enabled, true)
  assert.equal(cold.stateFor(coldAgent).snapshot.settings.policy.allocation.statistics, false)
})


for (const collection of [false, true]) test(`management off keeps Host tool withdrawal and additions usable with collection ${collection}`, async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' })
  const tool = name => defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => name })
  const remove = ctx.tools.register(tool('withdrawn'))
  ctx.effect(() => ctx.tools.register(tool('kept')))
  const agent = agentFor(Session.create(`off-withdrawal-${collection}`))
  const observations = []
  const env = createCapabilityEnvironment({ ctx, config: { ...CONFIG_DEFAULTS,
    capabilityStatistics: JSON.stringify({ enabled: collection, windowSize: 10, minimumSamples: 1, fullThreshold: .5 }) },
    toolSchemasForAgent: agent => ctx.tools.schemas(agent),
    store: { available(_agent, snapshot) { if(collection)observations.push(snapshot.plan.entries.map(entry => entry.id)) } } })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  remove(); ctx.effect(() => ctx.tools.register(tool('added')))
  await env.prepare(agent, [])
  assert.doesNotThrow(() => env.admitted({ agent, name: 'kept', token: {} }))
  await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(env.projectMembers(agent, ['kept', 'added']), ['kept', 'added'])
  if(collection)assert.deepEqual(observations.at(-1).sort(), ['tools.added', 'tools.kept'])
})


test('stable parent and child Skill projections do not invalidate an overlapping public catalog read', async t => {
  const ctx = new Context(); new SkillRegistry(ctx)
  const parent = agentFor(Session.create('stable-parent-skills'))
  const parentScope = createScope(ctx, parent); parent.ctx = parentScope.ctx
  const child = agentFor(Session.create('stable-child-skills'))
  const childScope = createScope(parentScope.ctx, child, { parent }); child.ctx = childScope.ctx
  let overlap = false
  let invalidations = 0
  ctx.on('skills/change', () => { invalidations++ })
  const env = createCapabilityEnvironment({ ctx, config: config({ 'skills.closed': 'closed' }),
    toolSchemasForAgent: () => [schema('skill')] })
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name: 'shared-skills',
    list: async options => {
      if (overlap && options.scope === parent) await env.prepare(child, [])
      return ['closed', 'open'].map(name => ({ name, description: name, source: 'fixture', provider: 'shared-skills', rank: 1,
        locator: name, invocation: { modelInvocable: true, userInvocable: true } }))
    }, get: async entry => ({ ...entry, content: entry.name }),
  })))
  t.after(async () => { await env.dispose(); await childScope.dispose(); await parentScope.dispose(); await ctx.fiber.dispose() })
  await acceptPreparation(env, parent, []); await acceptPreparation(env, child, [])
  const before = invalidations
  overlap = true
  const observed = await ctx.skills.snapshot({ scope: parent, cwd: 'uncached-parent-view', signal: parent.signal })
  assert.equal(observed.complete, true)
  assert.equal(invalidations, before, 'An unchanged child projection must leave the shared registry revision stable.')
  assert.equal(observed.skills.find(item => item.name === 'closed').invocation.modelInvocable, false)
  assert.equal((await ctx.skills.get('open', { scope: child })).content, 'open')
})

test('an incomplete Skill observation keeps only the proved frozen Skills and does not record their availability', async t => {
  const ctx = new Context(); new SkillRegistry(ctx)
  const agent = agentFor(Session.create('retained-incomplete-skills'))
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx
  let complete = true
  let names = ['closed', 'kept', 'removed']
  let providerControl
  ctx.effect(() => ctx.skills.registerProvider(control => {
    providerControl = control
    return { name: 'changing-skills', list: async () => ({ complete, candidates: names.map(name => ({ name, description: name,
      source: 'fixture', provider: 'changing-skills', rank: 1, locator: name, invocation: { modelInvocable: true, userInvocable: true } })) }),
    get: async entry => ({ ...entry, content: entry.name }) }
  }))
  let tools = ['skill', 'old']
  const availability = []
  const env = createCapabilityEnvironment({ ctx, config: config({ 'skills.closed': 'closed' }),
    toolSchemasForAgent: () => tools.map(schema), store: { available: (_agent, snapshot) => availability.push(snapshot) } })
  t.after(async () => { await env.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  const state = await acceptPreparation(env, agent, [])
  const frozen = JSON.stringify(state.snapshot)
  complete = false; names = ['closed', 'unproved']; tools = ['skill']; providerControl.invalidate()
  await env.prepare(agent, [])
  const step = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(step.kind, 'enter')
  assert.equal(JSON.stringify(state.snapshot), frozen)
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name), ['kept', 'removed'])
  assert.deepEqual(env.projectMembers(agent, ['skill', 'old']), ['skill'])
  assert.throws(() => env.validateSupply(agent, 'skill', { name: 'closed' }), /unknown or no longer available/)
  assert.throws(() => env.validateSupply(agent, 'skill', { name: 'unproved' }), /unknown or no longer available/)
  assert.equal(await ctx.skills.get('closed', { scope: agent }), undefined)
  assert.equal(await ctx.skills.get('unproved', { scope: agent }), undefined, 'Partial candidates cannot bypass frozen invocation through the Host loader.')
  assert.equal(availability.at(-1).plan.entries.some(item => item.category === 'skill'), false)
  assert.equal(step.messages.some(item => item.source?.form === 'capability-contracts'
    && item.source.snapshot.changes.some(change => change.id.startsWith('skills.'))), false)
  complete = true; names = ['closed', 'kept', 'unproved']; providerControl.invalidate()
  await env.prepare(agent, [])
  assert.deepEqual(env.metadata(agent)[0].members.map(item => item.name), ['kept', 'unproved'])
  assert.equal(env.stateFor(agent).snapshot.capabilities.some(item => item.id === 'skills.unproved'), false,
    'a complete addition stays declared while the frozen plan does not allocate it')
  assert.throws(() => env.validateSupply(agent, 'skill', { name: 'removed' }), /unknown or no longer available/)
})


test('public AgentLoop completes parent and child turns and resumes them after an incomplete Skill observation', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' }); new SkillRegistry(ctx); skillTool.apply(ctx)
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  let complete = true
  let control
  ctx.effect(() => ctx.skills.registerProvider(owner => {
    control = owner
    return { name: 'lifecycle-skills', list: async () => ({ complete, candidates: [{ name: 'fixture', description: 'Fixture Skill',
      source: 'fixture', provider: 'lifecycle-skills', rank: 1, locator: 'fixture', invocation: { modelInvocable: true, userInvocable: true } }] }),
    get: async entry => ({ ...entry, content: 'Fixture body' }) }
  }))
  let parent
  let sendCalls = 0
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'send_message', description: 'Deliver the child report.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => {
      sendCalls++
      parent.agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Child report.' }] }), 'next-turn', false)
      complete = false; control.invalidate()
      return 'delivered'
    } })))
  const errors = []
  const requests = new Map()
  ctx.on('agent/error', payload => errors.push(payload.error))
  async function* stream(options) {
    const sessionId = options.messages.find(message => message.source?.form === 'capability-plan').source.sessionId
    const count = (requests.get(sessionId) ?? 0) + 1; requests.set(sessionId, count)
    if (sessionId === 'lifecycle-child' && count === 1) {
      const block = { type: 'tool-call', id: 'child-report', name: 'send_message', arguments: '{}' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.provide('llm', { prepareCall: async requestConfig => ({ config: requestConfig, stream, adapterDefaults: {} }), stream }))
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target) })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next(); await env.prepare(context.agent, assembly.sections)
    return { ...assembly, sections: env.projectSections(context.agent, assembly.sections) }
  })
  ctx.on('agent/pre-step', (payload, next) => env.preStep(payload, next), { prepend: true })
  parent = await ctx.agents.create({ sessionId: 'lifecycle-parent', meta: { cwd: process.cwd(), delegationDepth: 0 },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  let child
  t.after(async () => { await child?.dispose(); await parent.dispose(); await env.dispose(); await ctx.fiber.dispose() })
  const run = async agent => {
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }), 'next-turn', true)
    await agent.whenIdle()
  }
  await run(parent.agent)
  child = await ctx.agents.create({ sessionId: 'lifecycle-child', parentAgent: parent.agent,
    meta: { cwd: process.cwd(), parentSession: parent.agent.session.id, origin: 'subagent', delegationDepth: 1 },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  await run(child.agent); await run(parent.agent); await run(child.agent)
  assert.equal(sendCalls, 1)
  assert.deepEqual(errors, [])
  assert.equal(requests.get('lifecycle-parent'), 3)
  assert.equal(requests.get('lifecycle-child'), 3)
  for (const agent of [parent.agent, child.agent]) {
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(event => event.data?.source?.form === 'capability-plan').length, 1)
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    assert.equal(env.stateFor(agent).skillInventoryComplete, false)
  }
})


for (const userInvocable of [false, true]) test(`incomplete Skill discovery retains native eligibility while a proved loader withdrawal takes effect with user entry ${userInvocable}`, async t => {
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  let complete = true
  let loader = true
  const agent = agentFor(Session.create(`partial-loader-withdrawal-${userInvocable}`))
  const env = createCapabilityEnvironment({ ctx: { skills: { snapshot: async () => ({ complete, skills: complete ? [{ name: 'fixture',
    description: 'Fixture Skill', invocation: { modelInvocable: true, userInvocable } }] : [] }) } },
    config: { ...CONFIG_DEFAULTS, capabilityManagementEnabled: true, capabilityPolicy: JSON.stringify(policy) },
    toolSchemasForAgent: () => (loader ? ['run_code', 'skill'] : ['run_code']).map(schema) })
  t.after(() => env.dispose()); await acceptPreparation(env, agent, [])
  complete = false; loader = false
  await env.prepare(agent, [])
  assert.deepEqual(env.projectMembers(agent, ['run_code', 'skill']), ['run_code'])
  const retained = env.stateFor(agent).liveCapabilities.get('skills.fixture')
  assert.deepEqual(retained.invocation, { modelInvocable: false, userInvocable })
  assert.doesNotMatch(retained.contract, /Load instructions: await tools\.skill/)
  assert.equal(env.metadata(agent)[0].members.length, userInvocable ? 1 : 0)
  loader = true
  await env.prepare(agent, [])
  assert.deepEqual(env.stateFor(agent).liveCapabilities.get('skills.fixture').invocation, { modelInvocable: true, userInvocable })
})


test('cold capability restoration keeps accepted Skill withdrawals during incomplete discovery and ignores unproved updates', async t => {
  let complete = true
  let names = ['kept', 'removed']
  const ctx = { skills: { snapshot: async () => ({ complete, skills: names.map(name => ({ name, description: name,
    invocation: { modelInvocable: true, userInvocable: true } })) }) } }
  const agent = agentFor(Session.create('cold-partial-skills'))
  const make = () => createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('skill')] })
  const env = make(); t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  names = ['kept']
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  const update = decision.messages.find(message => message.source?.form === 'capability-contracts')
  assert.equal(update.source.snapshot.changes.find(change => change.id === 'skills.removed').capability, null)
  agent.session.append('user/message', update, { surfaceOp: 'append' })
  const foreign = structuredClone(update)
  foreign.id += '-foreign'; foreign.source.sessionId = 'other-session'
  foreign.source.snapshot.changes = [{ id: 'skills.kept', disclosure: 'on-demand', capability: null }]
  foreign.source.snapshot.views = foreign.source.snapshot.views.map(([id, revision]) => [id, id === 'skills.kept' ? null : revision])
  foreign.source.digest = createHash('sha256').update(JSON.stringify(foreign.source.snapshot)).digest('hex')
  foreign.content[0].text = foreign.content[0].text.replace('skills.removed', 'skills.kept')
  agent.session.append('user/message', foreign, { surfaceOp: 'append' })
  const damaged = structuredClone(foreign)
  damaged.id += '-damaged'; damaged.source.sessionId = agent.session.id; damaged.source.digest = 'damaged'
  agent.session.append('user/message', damaged, { surfaceOp: 'append' })
  const wrongPlan = structuredClone(foreign)
  wrongPlan.id += '-wrong-plan'; wrongPlan.source.sessionId = agent.session.id; wrongPlan.source.snapshot.planDigest = 'other-plan'
  wrongPlan.source.digest = createHash('sha256').update(JSON.stringify(wrongPlan.source.snapshot)).digest('hex')
  agent.session.append('user/message', wrongPlan, { surfaceOp: 'append' })
  const coldAgent = agentFor(Session.create(agent.session.id, JSON.parse(JSON.stringify(agent.session.snapshotEvents())), agent.session.header))
  const cold = make(); t.after(() => cold.dispose())
  complete = false; names = ['removed', 'unproved']
  await cold.prepare(coldAgent, [])
  assert.deepEqual(cold.metadata(coldAgent)[0].members.map(item => item.name), ['kept'])
  assert.throws(() => cold.validateSupply(coldAgent, 'skill', { name: 'removed' }), /unknown or no longer available/)
  assert.throws(() => cold.validateSupply(coldAgent, 'skill', { name: 'unproved' }), /unknown or no longer available/)
  const resumed = await cold.preStep({ agent: coldAgent, signal: coldAgent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(resumed.kind, 'enter')
})

test('cold capability restoration retains an accepted Skill contract update in the recorded inventory', async t => {
  let description = 'Algebra v1'
  let complete = true
  const ctx = { skills: { snapshot: async () => ({ complete, skills: complete ? [{ name: 'algebra', description,
    invocation: { modelInvocable: true, userInvocable: true } }] : [] }) } }
  const agent = agentFor(Session.create('cold-skill-contract-update'))
  const make = () => createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('skill')] })
  const env = make(); t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  description = 'Algebra v2'
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  const update = decision.messages.find(message => message.source?.form === 'capability-contracts')
  const change = update.source.snapshot.changes.find(item => item.id === 'skills.algebra')
  assert.equal(change.capability.category, 'skill')
  assert.equal(change.capability.description, 'Algebra v2')
  agent.session.append('user/message', update, { surfaceOp: 'append' })
  complete = false
  const coldAgent = agentFor(Session.create(agent.session.id, JSON.parse(JSON.stringify(agent.session.snapshotEvents())), agent.session.header))
  const cold = make(); t.after(() => cold.dispose())
  await cold.prepare(coldAgent, [])
  assert.equal(cold.stateFor(coldAgent).liveCapabilities.get('skills.algebra').description, 'Algebra v2')
})

test('initial and refreshed capability plans require a complete Skill observation without replacing a proved plan', async t => {
  let complete = false
  const agent = agentFor(Session.create('incomplete-initial-and-refresh'))
  agent.runMaintenance = operation => operation(agent.signal)
  const ctx = { skills: { snapshot: async () => ({ complete, skills: [] }) },
    systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => env.dispose())
  await assert.rejects(env.prepare(agent, []), /Skill catalog is incomplete/)
  assert.equal(env.stateFor(agent), undefined)
  complete = true
  const original = await acceptPreparation(env, agent, [])
  const before = agent.session.snapshotEvents()
  complete = false
  await assert.rejects(env.refresh(agent), /Skill catalog is incomplete/)
  assert.equal(env.stateFor(agent), original)
  assert.deepEqual(agent.session.snapshotEvents(), before)
  assert.equal((await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
})

test('all unselected features and preview-only delegate the public incomplete Skill catalog lifecycle', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' }); new SkillRegistry(ctx); skillTool.apply(ctx)
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name: 'unavailable',
    list: async () => { throw new Error('provider temporarily unavailable') }, get: async () => undefined })))
  const agent = agentFor(Session.create('off-incomplete-skills'))
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx; t.after(() => scope.dispose())
  assert.equal((await ctx.skills.snapshot({ scope: agent, signal: agent.signal })).complete, false)
  assert.equal((await agentEvents(ctx, agent).waterfall('agent/pre-step', { agent, signal: agent.signal, messages: [], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
  for (const modelPreviewEnabled of [false, true]) {
    const env = createCapabilityEnvironment({ ctx, config: { ...CONFIG_DEFAULTS, modelPreviewEnabled }, toolSchemasForAgent: () => [schema('run_code')] })
    t.after(() => env.dispose())
    await env.prepare(agent, []); await env.prepare(agent, [])
    assert.equal((await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
  }
})

for (const userInvocable of [true, false]) test(`closing the model Skill loader retains honest native and effective invocation with user entry ${userInvocable}`, async t => {
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.skill'] = { availability: 'closed' }
  policy.items['skills.algebra'] = { disclosure: 'full' }
  const agent = agentFor(Session.create(`closed-skill-loader-${userInvocable}`))
  const env = createCapabilityEnvironment({ ctx: { skills: { snapshot: async () => ({ complete: true, skills: [
    { name: 'algebra', description: 'Algebra instructions', provider: 'test', source: 'test', invocation: { modelInvocable: true, userInvocable } },
  ] }) } }, config: { ...CONFIG_DEFAULTS, capabilityManagementEnabled: true, capabilityPolicy: JSON.stringify(policy) },
    toolSchemasForAgent: () => [schema('run_code'), schema('skill')] })
  t.after(() => env.dispose()); await env.prepare(agent, [])
  assert.deepEqual(env.projectMembers(agent, ['run_code', 'skill']), ['run_code'])
  const native = env.stateFor(agent).snapshot.capabilities.find(item => item.id === 'skills.algebra')
  assert.deepEqual(native.nativeInvocation, { modelInvocable: true, userInvocable })
  assert.deepEqual(native.invocation, { modelInvocable: false, userInvocable })
  assert.doesNotMatch(env.describe(agent).effective.catalogText, /Load instructions: await tools\.skill/)
  if(userInvocable)assert.match(env.metadata(agent)[0].members[0].contract, /user can invoke \/algebra/)
  else assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'skills.algebra').selection, 'closed')
})

test('MCP resource contracts expose only selected available operations without restoring closed tools', async t => {
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.read_mcp_resource'] = { availability: 'closed' }
  policy.items['mcp.docs'] = { disclosure: 'full' }
  const agent = agentFor(Session.create('partial-mcp-operations'))
  const env = createCapabilityEnvironment({ ctx: {}, config: { ...CONFIG_DEFAULTS, capabilityManagementEnabled: true, capabilityPolicy: JSON.stringify(policy) },
    toolSchemasForAgent: () => ['run_code', 'list_mcp_resources', 'read_mcp_resource'].map(schema) })
  t.after(() => env.dispose()); await env.prepare(agent, [{ name: 'mcp-resource-servers', text: 'Use the following MCP resource servers as the server argument: ["docs"].' }])
  assert.deepEqual(env.projectMembers(agent, ['run_code', 'list_mcp_resources', 'read_mcp_resource']), ['run_code', 'list_mcp_resources'])
  const contract = env.metadata(agent).find(entry => entry.namespace === 'mcp').members[0].contract
  assert.match(contract, /tools\.list_mcp_resources/)
  assert.doesNotMatch(contract, /read_mcp_resource|list_mcp_resource_templates/)
})

test('composed combined commands keep the session decision a dimension change did not touch', async t => {
  let saved = { ...CONFIG_DEFAULTS, capabilityManagementEnabled: true }; let revision = 1
  const agent = agentFor(Session.create('combined-composition')); agent.runMaintenance = operation => operation(agent.signal)
  const env = createCapabilityEnvironment({ ctx: { systemPrompt: { assemble: async () => ({ sections: [] }) } }, config: saved,
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose()); await acceptPreparation(env, agent, [])
  await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'full' }, agent.signal)
  await env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal)
  await settle(env, agent)
  // Closing availability leaves the disclosure this session already decided, and the
  // composition that acts on it states both dimensions.
  assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'tools.probe').disclosure, 'full')
  await env.change(agent, { scope: 'session', id: 'tools.probe', dimension: 'availability', selection: 'enabled' }, agent.signal)
  await settle(env, agent)
  assert.equal(env.describe(agent).sessionOverrides['tools.probe'], 'full',
    'enabled with the disclosure this session kept is one selection, not two independent ones')
  await env.change(agent, { scope: 'global', id: 'tools.probe', dimension: 'availability', selection: 'closed' }, agent.signal, {
    read: () => ({ value: saved, revision }), update: async patch => { saved = { ...saved, ...patch }; revision++; env.reconfigure(saved) },
  })
  // The saved write states the saved column. The session's own record still states its
  // whole selection, so the composition keeps the disclosure it decided.
  assert.equal(env.describe(agent).sessionOverrides['tools.probe'], 'full')
  await settle(env, agent)
  assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'tools.probe').disclosure, 'full')
})


test('composed recovery without management publishes only actual Host Skill and MCP invocation paths', async t => {
  let description = 'Algebra v1'
  let schemas = [schema('run_code'), schema('list_mcp_resources')]
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.list_mcp_resources'] = { availability: 'closed' }
  const ctx = { skills: { snapshot: async () => ({ complete: true, skills: [{ name: 'algebra', provider: 'test', source: 'runtime',
    description, invocation: { modelInvocable: true, userInvocable: true } }] }) } }
  const env = createCapabilityEnvironment({ ctx,
    config: composedConfig(policy, { capabilityManagementEnabled: false, capabilityRecoveryEnabled: true }),
    toolSchemasForAgent: () => schemas })
  t.after(() => env.dispose())
  const agent = agentFor(Session.create('composed-off-recovery-paths'))
  const sections = text => [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' }, { name: 'mcp:docs', text }]
  await acceptPreparation(env, agent, sections('Docs v1'))
  description = 'Algebra v2'
  await env.prepare(agent, sections('Docs v2'))
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  const contracts = decision.messages.filter(message => message.source?.form === 'capability-contracts')
    .map(message => message.content[0].text).join('\n')
  assert.match(contracts, /user can invoke \/algebra/)
  assert.match(contracts, /tools\.list_mcp_resources/)
  assert.doesNotMatch(contracts, /Load instructions: await tools\.skill|tools\.(list_mcp_resource_templates|read_mcp_resource)/)
  assert.ok(env.projectMembers(agent, schemas.map(item => item.name)).includes('list_mcp_resources'), 'Unselected management cannot apply saved closure.')
  const live = env.stateFor(agent).liveCapabilities
  assert.equal(live.get('skills.algebra').nativeInvocation.modelInvocable, true)
  assert.equal(live.get('skills.algebra').invocation.modelInvocable, false)
  assert.equal(live.get('skills.algebra').invocation.userInvocable, true)
  schemas = [...schemas, schema('skill'), schema('read_mcp_resource')]
  description = 'Algebra v3'
  await env.prepare(agent, sections('Docs v3'))
  const restored = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  const restoredContracts = restored.messages.filter(message => message.source?.form === 'capability-contracts')
    .map(message => message.content[0].text).join('\n')
  assert.match(restoredContracts, /tools\.skill/)
  assert.match(restoredContracts, /tools\.read_mcp_resource/)
  assert.doesNotMatch(restoredContracts, /tools\.list_mcp_resource_templates/)
})

test('composed collection without management excludes absent invocation paths and follows real Host restoration', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' }); new SkillRegistry(ctx); skillTool.apply(ctx)
  await ctx.plugin(McpResourceRuntime).await()
  ctx.effect(() => ctx.skills.register({ name: 'unloadable', description: 'Model only', source: 'runtime', content: 'MODEL_ONLY',
    invocation: { modelInvocable: true, userInvocable: false } }))
  ctx.effect(() => ctx.skills.register({ name: 'user', description: 'User path', source: 'runtime', content: 'USER_PATH' }))
  ctx.effect(() => ctx.mcpResources.register('docs', { request: async () => ({ resources: [] }) }))
  const initialSession = Session.create('composed-off-actual-eligibility')
  const agent = agentFor(Session.create(initialSession.id, [], { ...initialSession.header, cwd: process.cwd() }))
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx; t.after(() => scope.dispose())
  const removeRestriction = scope.ctx.effect(() => scope.ctx.tools.restrict({ deny: ['skill', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] }))
  t.after(removeRestriction)
  const observed = []
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.skill'] = { availability: 'closed' }
  const env = createCapabilityEnvironment({ ctx, config: composedConfig(policy, { capabilityManagementEnabled: false,
    capabilityStatistics: '{"enabled":true,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' }),
    toolSchemasForAgent: target => ctx.tools.schemas(target), store: { available(_agent, snapshot) { observed.push(snapshot) } } })
  t.after(() => env.dispose())
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: agent.signal })
  await acceptPreparation(env, agent, assembly.sections)
  await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  const adapter = Object.create(CapabilityStatisticsStore.prototype)
  const ids = () => adapter.observations(agent, observed.at(-1)).map(item => item.id).sort()
  assert.deepEqual(ids(), ['skills.user'])
  assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'skills.unloadable').selection, 'closed')
  assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'mcp.docs').availabilitySource, 'invocation-path')
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/user Use the user entry.' }] })]
  const payload = { agent, messages, signal: agent.signal, turn: 1, step: 1 }
  const injected = await env.preStep(payload, () => agentEvents(ctx, agent).waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages })))
  assert.match(injected.messages.find(message => message.source.kind === 'skill-invocation').content[0].text, /USER_PATH/)
  removeRestriction()
  const restored = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: agent.signal })
  await env.prepare(agent, restored.sections)
  await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(ids().includes('skills.unloadable'))
  assert.ok(ids().includes('mcp.docs'))
  assert.ok(ids().includes('tools.skill'), 'Unselected saved closure cannot remove a restored real Host path.')
})

test('composed closed Skill loader preserves public user injection and replaces misleading Host summaries', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx, { mode: 'native' }); new SkillRegistry(ctx); skillTool.apply(ctx)
  ctx.effect(() => ctx.skills.register({ name: 'algebra', description: 'Algebra instructions', content: 'USER_ALGEBRA_BODY', source: 'runtime' }))
  const agent = agentFor(Session.create('composed-user-skill'))
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx; t.after(() => scope.dispose())
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy); policy.items['tools.skill'] = { availability: 'closed' }
  const env = createCapabilityEnvironment({ ctx, config: { ...CONFIG_DEFAULTS, capabilityManagementEnabled: true, capabilityPolicy: JSON.stringify(policy) },
    toolSchemasForAgent: candidate => ctx.tools.schemas(candidate) })
  t.after(() => env.dispose()); await env.prepare(agent, [])
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/algebra Please use this skill.' }] })]
  const payload = { agent, messages, signal: agent.signal, turn: 1, step: 1 }
  const decision = await env.preStep(payload, () => agentEvents(ctx, agent).waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages })))
  assert.equal(decision.kind, 'enter')
  assert.match(decision.messages.find(message => message.source.kind === 'skill-invocation').content[0].text, /USER_ALGEBRA_BODY/)
  assert.equal(decision.messages.some(message => message.source.kind === 'skill-catalog'), false)
  assert.match(env.describe(agent).effective.catalogText, /user can invoke \/algebra/)
  assert.doesNotMatch(env.describe(agent).effective.catalogText, /Load instructions: await tools\.skill/)
})


test('capability context switch freezes a paused group, retains choices, and restores them only on refresh', async t => {
  const policy = JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)
  policy.items['tools.probe'] = { availability: 'closed', disclosure: 'full' }
  const selected = composedConfig(policy, { capabilityContextEnabled: false, capabilityRecoveryEnabled: true, modelPreviewEnabled: true,
    capabilityStatistics: '{"enabled":true,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}' })
  const host = [schema('run_code'), schema('probe')]
  const agent = agentFor(Session.create('paused-capability-context'))
  agent.runMaintenance = operation => operation(agent.signal)
  const ctx = { agents: { list: () => [agent] }, systemPrompt: { assemble: async () => ({ sections }) } }
  const env = createCapabilityEnvironment({ ctx, config: selected, toolSchemasForAgent: () => host })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, sections)
  const paused = env.stateFor(agent).snapshot
  assert.equal(paused.schema, 'ptc-capability-environment/v4')
  assert.equal(paused.settings.enabled, true)
  assert.equal(paused.settings.recoveryEnabled, true)
  assert.equal(paused.settings.previewEnabled, true)
  assert.equal(paused.settings.statistics.enabled, true)
  assert.equal(paused.plan.enabled, false)
  assert.equal(env.sdk(agent, 'native sdk'), 'native sdk')
  assert.deepEqual(env.projectSections(agent, sections), sections)
  assert.deepEqual(env.projectMembers(agent, ['probe']), ['probe'])
  assert.doesNotThrow(() => env.validateSupply(agent, 'probe', {}))
  // A paused context keeps the row: the supply is the Host's, and the paused plan is a
  // fact about the composition rather than about which capabilities exist.
  assert.deepEqual((await env.describeSessionCatalog({ sessionId: agent.session.id }, agent.signal))
    .rows.map(row => row.id), ['tools.probe'])
  assert.equal(env.describeSessions()[0].configuration.capabilityContextEnabled, false)
  assert.equal(env.describeSessions()[0].configuration.capabilityRecoveryEnabled, true)
  env.reconfigure({ ...selected, capabilityContextEnabled: true })
  await env.prepare(agent, sections)
  assert.equal(env.stateFor(agent).snapshot, paused)
  assert.equal(env.describe(agent).pendingRefresh, true)
  const coldAgent = agentFor(Session.create(agent.session.id, JSON.parse(JSON.stringify(agent.session.snapshotEvents())), agent.session.header))
  const cold = createCapabilityEnvironment({ ctx, config: { ...selected, capabilityContextEnabled: true }, toolSchemasForAgent: () => host })
  t.after(() => cold.dispose())
  await cold.prepare(coldAgent, sections)
  assert.deepEqual(cold.stateFor(coldAgent).snapshot, paused)
  assert.equal(cold.sdk(coldAgent, 'native sdk'), 'native sdk')
  await env.refresh(agent, sections, agent.signal)
  assert.equal(env.stateFor(agent).snapshot.settings.contextEnabled, true)
  assert.equal(env.describe(agent).effective.entries.find(item => item.id === 'tools.probe').selection, 'closed')
  assert.deepEqual(env.projectMembers(agent, ['probe']), [])
  assert.equal(env.describe(agent).sourceSettings.recoveryEnabled, true)
})


test('session choices migrate combined preferences independently and reject unknown dimension evidence', () => {
  const source = { enabled: true, policy: JSON.parse(CONFIG_DEFAULTS.capabilityPolicy), manual: { baseline: [], overrides: { 'tools.probe': 'closed' } } }
  source.policy.items['tools.probe'] = { availability: 'closed', disclosure: 'full' }
  const automatic = sessionCapabilitySettings(source, { 'tools.probe': 'automatic' })
  assert.equal(automatic.manual.overrides['tools.probe'], undefined)
  assert.equal(automatic.policy.items['tools.probe'], undefined)
  const opened = sessionCapabilitySettings(source, { 'tools.probe': 'on-demand' })
  assert.deepEqual(opened.policy.items['tools.probe'], { availability: 'enabled', disclosure: 'on-demand' })
  const closed = sessionCapabilitySettings(source, { 'tools.probe': 'closed' })
  assert.deepEqual(closed.policy.items['tools.probe'], { availability: 'closed', disclosure: 'full' })
  assert.deepEqual(source.policy.items['tools.probe'], { availability: 'closed', disclosure: 'full' })
  for (const patch of [{ bogus: 'enabled' }, {}, { availability: 'invalid' }]) {
    assert.throws(() => sessionCapabilitySettings(source, { 'tools.probe': patch }), /invalid session capability choice/)
  }
})

for (const damage of ['missing', 'wrong-type', 'historical', 'plan-mismatch']) test(`capability context generation rejects ${damage} evidence and delegates the Host`, async t => {
  const agent = agentFor(Session.create(`damaged-group-${damage}`))
  const env = createCapabilityEnvironment({ ctx: {}, config: composedConfig(null, { capabilityContextEnabled: false }), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => env.dispose()); await acceptPreparation(env, agent, [])
  const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
  const source = events.find(event => event.data?.source?.form === 'capability-plan').data.source
  const snapshot = source.snapshot
  if (damage === 'plan-mismatch') snapshot.plan.catalogText = 'unproved catalog'
  else if (damage === 'historical') { snapshot.schema = 'ptc-capability-environment/v3'; snapshot.plan.schema = 'ptc-capability-plan/v2' }
  else {
    if (damage === 'missing') { delete snapshot.settings.contextEnabled; delete snapshot.sourceSettings.contextEnabled }
    else { snapshot.settings.contextEnabled = 'false'; snapshot.sourceSettings.contextEnabled = 'false' }
  }
  source.digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  const warnings = []
  const restored = createCapabilityEnvironment({ ctx: { logger: { warn: message => warnings.push(message) } }, config: composedConfig(), toolSchemasForAgent: () => [schema('probe')] })
  t.after(() => restored.dispose())
  const coldAgent = agentFor(Session.create(agent.session.id, events, agent.session.header))
  await restored.prepare(coldAgent, [])
  assert.equal(restored.describe(coldAgent).effective.enabled, false)
  assert.equal(restored.sdk(coldAgent, 'native sdk'), 'native sdk')
  assert.match(warnings[0], damage === 'plan-mismatch' ? /inconsistent session capability plan/ : /capability context generation/)
})


test('global capability choices require writer revision and write nothing when the writer refuses', async t => {
  const agent = agentFor(Session.create('global-choice-evidence'))
  agent.runMaintenance = operation => operation(agent.signal)
  const env = createCapabilityEnvironment({ ctx: { systemPrompt: { assemble: async () => ({ sections: [] }) } },
    config: config(), toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('other')] })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [])
  const previous = env.stateFor(agent)
  const intent = { scope: 'global', id: 'tools.probe', selection: 'closed' }
  let writes = 0
  for (const [writer, error] of [
    [{}, /public settings writer/],
    [{ read: () => undefined, update: () => writes++ }, /revision evidence/],
    [{ read: () => ({ value: config(), revision: '1' }), update: () => writes++ }, /revision evidence/],
    [{ read: () => ({ value: config(), revision: 1 }), update: () => { writes++; throw new Error('revision conflict') } }, /revision conflict/],
  ]) {
    await assert.rejects(env.change(agent, intent, agent.signal, writer), error)
    assert.equal(env.stateFor(agent), previous)
  }
  assert.equal(writes, 1, 'only the writer that was handed the intent was asked to write')
  const saved = await env.change(agent, intent, agent.signal, { read: () => ({ value: config(), revision: 1 }), update: () => { writes++ } })
  assert.deepEqual(saved, { globalSaved: true, sessionApplied: true, publication: 'recorded' })
  await env.change(agent, { scope: 'session', id: 'tools.probe', dimension: 'availability', selection: 'closed' }, agent.signal)
  assert.equal(env.describe(agent).sessionOverrides['tools.probe'], 'closed',
    'a closed availability is one selection in this session'
  )
  await settle(env, agent)
  assert.equal(env.describe(agent).effective.entries.find(entry => entry.id === 'tools.probe').selection, 'closed')
  // A decision that states only the disclosure cannot be spelled as a selection: it
  // inherits the availability, so the composition migrates the saved document into
  // the policy vocabulary that can hold one dimension.
  await env.change(agent, { scope: 'session', id: 'tools.other', dimension: 'disclosure', selection: 'on-demand' }, agent.signal)
  await settle(env, agent)
  const migrated = env.stateFor(agent).snapshot
  assert.deepEqual(env.describe(agent).sessionOverrides['tools.other'], { disclosure: 'on-demand' })
  assert.equal(migrated.settings.policy.items['tools.other'].disclosure, 'on-demand')
  assert.equal(migrated.plan.entries.find(entry => entry.id === 'tools.other').disclosure, 'on-demand')
})

test('Skill projection restores its prior state after publication failure and reports failed restoration', async t => {
  const ctx = new Context()
  let failInvalidation = false
  let invalidations = 0
  let failAfter = Infinity
  let disposals = 0
  const skills = {
    snapshot: async () => ({ complete: true, skills: [{ name: 'fixture', description: 'Fixture', invocation: { modelInvocable: true, userInvocable: true } }] }),
    registerProvider: factory => {
      factory({ invalidate: () => { invalidations++; if (failInvalidation && invalidations >= failAfter) throw new Error('projection invalidate failed') } })
      return () => { disposals++ }
    },
  }
  ctx.effect(() => ctx.provide('skills', skills))
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const agent = agentFor(Session.create('skill-projection-rollback'))
  agent.runMaintenance = operation => operation(agent.signal)
  const env = createCapabilityEnvironment({ ctx, config: config(), toolSchemasForAgent: () => [schema('run_code'), schema('skill'), schema('probe')] })
  t.after(async () => { failInvalidation = false; await env.dispose(); await ctx.fiber.dispose() })
  await acceptPreparation(env, agent, [])
  const previous = env.stateFor(agent)
  const append = agent.session.append.bind(agent.session)
  agent.session.append = () => { throw new Error('publication failed') }
  await assert.rejects(env.change(agent, { scope: 'session', id: 'tools.probe', selection: 'closed' }, agent.signal), /publication failed/)
  assert.equal(env.stateFor(agent), previous)
  assert.equal(invalidations, 0, 'A tool-only failed publication leaves the unchanged Skill projection alone.')
  env.reconfigure(config({ 'skills.fixture': 'closed' }))
  failInvalidation = true
  failAfter = invalidations + 1
  await assert.rejects(env.refresh(agent, []), error => error instanceof AggregateError
    && error.message === 'PTC Plus Skill projection restoration failed'
    && error.errors.every(item => /projection invalidate failed/.test(item.message)))
  assert.equal(env.stateFor(agent), previous)
  failInvalidation = false
  agent.session.append = append
  await env.refresh(agent, [])
  assert.notEqual(env.stateFor(agent), previous)
  await env.dispose()
  assert.equal(disposals, 1)
})



test('a first Skill projection is disposed when its new plan cannot be published', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  let disposals = 0
  ctx.effect(() => ctx.provide('skills', {
    snapshot: async () => ({ complete: true, skills: [] }),
    registerProvider: factory => { factory({ invalidate() {} }); return () => { disposals++ } },
  }))
  const agent = agentFor(Session.create('first-skill-rollback'))
  agent.runMaintenance = operation => operation(agent.signal)
  const env = createCapabilityEnvironment({ ctx, config: { ...config(), capabilityContextEnabled: false },
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(async () => { await env.dispose(); await ctx.fiber.dispose() })
  await acceptPreparation(env, agent, [])
  const previous = env.stateFor(agent)
  env.reconfigure(config())
  const append = agent.session.append.bind(agent.session)
  agent.session.append = () => { throw new Error('first projection publication failed') }
  await assert.rejects(env.refresh(agent, []), /first projection publication failed/)
  assert.equal(env.stateFor(agent), previous)
  assert.equal(disposals, 1)
  agent.session.append = append
  await env.refresh(agent, [])
  assert.equal(env.stateFor(agent).snapshot.plan.enabled, true)
  await env.dispose()
  assert.equal(disposals, 2)
})

test('resource dispatch records actual access without relying on description exploration', async t => {
  const uses = []
  const agent = agentFor(Session.create('resource-use-evidence'))
  const env = createCapabilityEnvironment({ ctx: { skills: { snapshot: async () => ({ complete: true, skills: [{ name: 'research', description: 'Research', provider: 'test', source: 'test', invocation: { modelInvocable: true, userInvocable: true } }] }) } }, config: config(),
    toolSchemasForAgent: () => [schema('read_mcp_resource'), schema('skill')], store: { used: (...args) => uses.push(args) } })
  t.after(() => env.dispose())
  await acceptPreparation(env, agent, [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' }])
  for (let index = 0; index < 2; index++) {
    const exec = { agent, token: {}, name: 'read_mcp_resource', arguments: { server: 'docs', uri: 'docs://item' } }
    env.admitted(exec)
    env.dispatched(exec, { isError: false })
    await Promise.resolve()
  }
  const skill = { agent, token: {}, name: 'skill', arguments: { name: 'research' } }
  env.admitted(skill)
  env.dispatched(skill, { isError: false })
  await Promise.resolve()
  assert.equal(uses.filter(args => args[2] === 'skills.research' && args[3] === 'skill-body-accepted').length, 1)
  assert.equal(uses.filter(args => args[2] === 'mcp.docs' && args[3] === 'resource-access').length, 2)
  assert.ok(env.complete({ agent }, { isError: false }).meta.dshPtcPlusCapabilities.used.includes('mcp.docs'))
})

test('composed temporary and global changes state only the column each one owns and retain Host resource guidance', async t => {
  let saved = composedConfig()
  const agent = agentFor(Session.create('dimension-removal'))
  agent.runMaintenance = operation => operation(agent.signal)
  const sections = [{ name: 'mcp-resource-servers', text: 'as the server argument: ["docs"].' }]
  const env = createCapabilityEnvironment({ ctx: { systemPrompt: { assemble: async () => ({ sections }) } }, config: saved,
    toolSchemasForAgent: () => [schema('run_code'), schema('probe'), schema('read_mcp_resource')] })
  t.after(() => env.dispose()); await acceptPreparation(env, agent, sections)
  assert.deepEqual(env.projectSections(agent, sections), [
    { name: 'mcp-resource-servers', text: 'Use the following MCP resource servers as the server argument: ["docs"].' },
  ])
  const sessionChange = (selection, dimension) => env.change(agent, { scope: 'session', id: 'tools.probe', selection, dimension }, agent.signal)
  await sessionChange('full')
  await sessionChange('inherit')
  assert.equal(env.describe(agent).sessionOverrides['tools.probe'], undefined, 'inherit withdraws the session decision')
  await sessionChange('closed', 'availability')
  // A dimension decision states that dimension and inherits the other one, so a
  // saved write to the other dimension is still the one this session follows.
  assert.equal(env.describe(agent).sessionOverrides['tools.probe'], 'closed')
  const writer = { read: () => ({ value: saved, revision: 1 }), update: async patch => { saved = { ...saved, ...patch }; env.reconfigure(saved) } }
  await env.change(agent, { scope: 'global', id: 'tools.probe', selection: 'enabled', dimension: 'availability' }, agent.signal, writer)
  assert.equal(env.describe(agent).sessionOverrides['tools.probe'], 'closed',
    'a saved write states the saved column; it does not rewrite what this session decided')
})


test('a custom navigation sentence and category line produce a v5 snapshot that replays byte-identically', async t => {
  const navigation = 'Use capabilities.search({query}) before assuming a capability is missing.'
  const categoryLine = 'Tools: index first, then tools.<name>.'
  const agents = [agentFor(Session.create('plan-text-v5'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx,
    config: { ...config({ 'tools.probe': 'full' }),
      promptText: JSON.stringify({ schema: 'ptc-prompt-text/v1',
        overrides: { 'plan.navigationSentence': navigation, 'plan.category.tool': categoryLine } }) },
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agents[0], [])
  const message = state.message
  assert.equal(message.source.snapshot.schema, 'ptc-capability-environment/v5')
  assert.equal(message.source.snapshot.promptText.navigationSentence, navigation)
  assert.equal(message.source.snapshot.promptText.categoryLines.find(pair => pair[0] === 'tool')[1], categoryLine)
  assert.equal(message.source.snapshot.plan.directoryText.split('\n')[0], navigation)
  const replayed = capabilityPlanTextFromMessage(message, agents[0].id)
  assert.equal(replayed, message.content[0].text,
    'the environment must replay its own v5 plan message byte-identically')
  assert.equal(replayed, capabilityPlanText(message.source.snapshot, agents[0].id),
    'the replay must reproduce the snapshot composition, not only the delivered text')
})

test('a historical generation carrying foreign navigation text is still rejected', async t => {
  const agents = [agentFor(Session.create('plan-text-historical'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx, config: config({ 'tools.probe': 'full' }),
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agents[0], [])
  assert.notEqual(state.message.source.snapshot.schema, 'ptc-capability-environment/v5')
  const damaged = structuredClone(state.message)
  damaged.source.snapshot.navigationText = 'Foreign guidance.'
  assert.equal(readCapabilityContextMessage(damaged, agents[0].id), undefined,
    'a historical generation with foreign navigation text is not replayable')
})

test('a v5 snapshot whose recorded text disagrees with navigationText is rejected', async t => {
  const agents = [agentFor(Session.create('plan-text-damaged-v5'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const navigation = config().capabilityManagementEnabled ? 'Use capabilities.search before assuming a capability is missing.' : ''
  const env = createCapabilityEnvironment({ ctx,
    config: { ...config({ 'tools.probe': 'full' }),
      promptText: JSON.stringify({ schema: 'ptc-prompt-text/v1', overrides: { 'plan.navigationSentence': navigation } }) },
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agents[0], [])
  assert.equal(state.message.source.snapshot.schema, 'ptc-capability-environment/v5')
  const mismatch = structuredClone(state.message)
  mismatch.source.snapshot.navigationText = 'Different guidance.'
  assert.equal(readCapabilityContextMessage(mismatch, agents[0].id), undefined,
    'recorded text that disagrees with navigationText is not replayable')
  const hole = structuredClone(state.message)
  hole.source.snapshot.promptText.overageSentence = 'No hole here.'
  assert.equal(readCapabilityContextMessage(hole, agents[0].id), undefined,
    'an overage sentence without exactly one hole is not replayable')
  const noRecord = structuredClone(state.message)
  delete noRecord.source.snapshot.promptText
  assert.equal(readCapabilityContextMessage(noRecord, agents[0].id), undefined,
    'a v5 snapshot without a plan record is not replayable')
  const wrongBudget = structuredClone(state.message)
  wrongBudget.source.snapshot.promptText.directoryBudgetBytes = 1
  assert.equal(readCapabilityContextMessage(wrongBudget, agents[0].id), undefined,
    'a recorded budget its plan disagrees with is not replayable')
  const retold = structuredClone(state.message)
  retold.content[0].text = 'Different plan text.'
  assert.equal(readCapabilityContextMessage(retold, agents[0].id), undefined,
    'a message whose text differs from the recomposed plan is not replayable')
})

test('a v5 snapshot carrying capability context settings replays its own plan', async t => {
  const navigation = 'Use capabilities.search({query}) before assuming a capability is missing.'
  const agents = [agentFor(Session.create('plan-text-v5-context'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx,
    config: { ...config({ 'tools.probe': 'full' }), capabilityContextEnabled: true,
      promptText: JSON.stringify({ schema: 'ptc-prompt-text/v1', overrides: { 'plan.navigationSentence': navigation } }) },
    toolSchemasForAgent: () => [schema('run_code'), schema('probe')] })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agents[0], [])
  const snapshot = state.message.source.snapshot
  assert.equal(snapshot.schema, 'ptc-capability-environment/v5')
  assert.equal(snapshot.settings.contextEnabled, true)
  assert.equal(snapshot.plan.schema, 'ptc-capability-plan/v3',
    'a v5 snapshot may carry context settings, so its plan generation is the context one')
  // The budget moves with the navigation sentence: an untouched document keeps the
  // configured budget exactly, and a longer sentence must not silently shrink it.
  assert.equal(snapshot.promptText.directoryBudgetBytes,
    snapshot.settings.directoryBudgetBytes + Buffer.byteLength(navigation) - Buffer.byteLength(PLAN_NAVIGATION),
    'the recorded budget is the configured budget plus the guidance delta')
  assert.equal(snapshot.plan.budgets.directoryBudgetBytes, snapshot.promptText.directoryBudgetBytes,
    'the plan must be composed with the recorded budget')
  assert.equal(capabilityPlanTextFromMessage(state.message, agents[0].id), state.message.content[0].text,
    'a v5 snapshot with context settings must still replay')
  // A new session changes nothing, so its plan may only describe the environment
  // as it already is; announcing a prepared change would claim an effect that no
  // user command requested.
  const initialText = state.message.content[0].text
  for (const claim of ['能力已准备', '将在下一次获准', 'Capabilities prepared', 'take effect at the next accepted'])
    assert.equal(initialText.includes(claim), false, `the initial plan must not claim ${claim}`)
})

test('a v5 snapshot of a policy-managed plan replays its own plan', async t => {
  const navigation = 'Use capabilities.search({query}) before assuming a capability is missing.'
  const agents = [agentFor(Session.create('plan-text-v5-policy'))]
  const ctx = { agents: { list: () => agents }, systemPrompt: { assemble: async () => ({ sections: [] }) } }
  const env = createCapabilityEnvironment({ ctx,
    config: { ...config({ 'tools.probe': 'closed' }),
      capabilityPolicy: JSON.stringify(JSON.parse(CONFIG_DEFAULTS.capabilityPolicy)),
      promptText: JSON.stringify({ schema: 'ptc-prompt-text/v1', overrides: { 'plan.navigationSentence': navigation } }) },
    toolSchemasForAgent: () => [] })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agents[0], [])
  const snapshot = state.message.source.snapshot
  assert.equal(snapshot.schema, 'ptc-capability-environment/v5')
  assert.equal(snapshot.plan.schema, 'ptc-capability-plan/v2',
    'a policy-managed v5 plan keeps the policy generation even when nothing is delivered')
  assert.deepEqual(snapshot.plan.entries, [],
    'a plan with no deliverable capability is the closed-plan case')
  assert.equal(capabilityPlanTextFromMessage(state.message, agents[0].id), state.message.content[0].text)
})
