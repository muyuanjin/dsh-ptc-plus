import { capabilityRule, capabilityPolicyForConfig, changeCapabilityRule, CAPABILITY_DISCLOSURES } from './capability-policy.js'
/** One session-owned capability view for presentation, discovery and preparation. */
import { createHash } from 'node:crypto'
import { jsonSchemaToTs, renderToolsSdk, ToolNotFoundError } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Context } from '@deepseek-ai/cordis'
import * as spillPolicy from '@deepseek-ai/dsh-spill-policy'
import { readSessionLog } from './session-events.js'
import { readCapabilityCommandReceipt } from './capability-command-receipt.js'
import { createCapabilityPlan } from './capability-plan.js'
import { PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
import { deepFreeze } from './record-utils.js'
import { capabilityProfileConfiguration } from './runtime-config.js'
import { readRuntimeAvailability } from './runtime-messages.js'

export const CAPABILITY_PLAN_FORM = 'capability-plan'
export const CAPABILITY_EVIDENCE_KEY = 'dshPtcPlusCapabilities'
const EVIDENCE_KEY = CAPABILITY_EVIDENCE_KEY
const TRANSPORTS = new Set(['run_code', 'edit_run_code'])
const LEGACY_NAVIGATION = 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. Unlisted capabilities remain discoverable. Skill descriptions are summaries; load the body with tools.skill({name}) before following it.'
const NAVIGATION = 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. Unlisted capabilities remain discoverable. Skill descriptions are summaries; follow each Skill\'s declared invocation eligibility to load its body before following it.'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const messageText = message => message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''

/** Saved inputs and explicit session choices are distinct; automatic cancels a saved override. */
export function sessionCapabilitySettings(sourceSettings, sessionOverrides = {}) {
  if (!sourceSettings || typeof sourceSettings !== 'object' || Array.isArray(sourceSettings)
    || !sourceSettings.manual || typeof sourceSettings.manual !== 'object' || Array.isArray(sourceSettings.manual)
    || !Array.isArray(sourceSettings.manual.baseline) || !sourceSettings.manual.overrides
    || typeof sourceSettings.manual.overrides !== 'object' || Array.isArray(sourceSettings.manual.overrides)) {
    throw new TypeError('invalid capability source settings')
  }
  if (!sessionOverrides || typeof sessionOverrides !== 'object' || Array.isArray(sessionOverrides)) throw new TypeError('invalid session capability choices')
  let policy = sourceSettings.policy
  const overrides = { ...sourceSettings.manual.overrides }
  for (const [id, selection] of Object.entries(sessionOverrides)) {
    if (policy && selection && typeof selection === 'object' && !Array.isArray(selection)) {
      if (!/^(tools|skills|mcp|mcpServers)\..+$/.test(id) || !Object.keys(selection).length
        || Object.entries(selection).some(([dimension, choice]) => !['availability', 'disclosure'].includes(dimension)
          || !['automatic', ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)].includes(choice))) {
        throw new TypeError('invalid session capability choice')
      }
      for (const [dimension, choice] of Object.entries(selection)) policy = changeCapabilityRule(policy, id, dimension, choice)
      continue
    }
    if (!/^(tools|skills|mcp|mcpServers)\..+$/.test(id)
      || !['full', 'on-demand', 'closed', 'automatic'].includes(selection)
      || id.startsWith('mcpServers.') && !['closed', 'automatic'].includes(selection)) throw new TypeError('invalid session capability choice')
    if (selection === 'automatic') delete overrides[id]
    else overrides[id] = selection
    if (policy) {
      if (selection === 'automatic') {
        policy = changeCapabilityRule(changeCapabilityRule(policy, id, 'availability', 'automatic'), id, 'disclosure', 'automatic')
      } else {
        policy = changeCapabilityRule(policy, id, 'availability', selection === 'closed' ? 'closed' : 'enabled')
        if (selection !== 'closed') policy = changeCapabilityRule(policy, id, 'disclosure', selection)
      }
    }
  }
  return { ...sourceSettings, ...(policy ? { policy } : {}), manual: { ...sourceSettings.manual, overrides } }
}

export function capabilityConfiguration(config) {
  let statistics
  try { statistics = JSON.parse(config.capabilityStatistics) } catch { statistics = null }
  return {
    enabled: config.capabilityManagementEnabled === true,
    ...(config.capabilityPolicy ? { policy: capabilityPolicyForConfig(config),
      recoveryEnabled: config.capabilityRecoveryEnabled === true, previewEnabled: config.modelPreviewEnabled === true } : {}),
    manual: { baseline: JSON.parse(config.capabilityBaseline ?? '[]'), overrides: JSON.parse(config.capabilityOverrides ?? '{}') },
    statistics,
    budgetBytes: config.capabilityBudgetBytes ?? 16384,
    directoryBudgetBytes: config.capabilityDirectoryBytes ?? 2048,
    recoveryBytes: config.capabilityRecoveryBytes ?? 8192,
    previewTokens: config.modelPreviewTokens ?? 4096,
  }
}

function sourcePlan(message, id) {
  const source = message?.source
  if (source?.kind !== PTC_MESSAGE_SOURCE_KIND || source.form !== CAPABILITY_PLAN_FORM || source.sessionId !== id) return undefined
  const snapshot = source.snapshot
  if (source.digest !== digest(snapshot) || !['ptc-capability-environment/v1', 'ptc-capability-environment/v2', 'ptc-capability-environment/v3'].includes(snapshot?.schema)
    || !Array.isArray(snapshot.capabilities) || snapshot.plan?.schema !== (snapshot?.schema === 'ptc-capability-environment/v3' ? 'ptc-capability-plan/v2' : 'ptc-capability-plan/v1')) {
    throw new Error('damaged session capability plan')
  }
  if (['ptc-capability-environment/v2', 'ptc-capability-environment/v3'].includes(snapshot.schema)) {
    let merged
    try {
      if (snapshot.sessionOverrides === undefined) throw new TypeError('missing session choices')
      merged = sessionCapabilitySettings(snapshot.sourceSettings, snapshot.sessionOverrides)
    } catch (cause) {
      throw new Error('damaged session capability choices', { cause })
    }
    if (JSON.stringify(merged) !== JSON.stringify(snapshot.settings)) throw new Error('inconsistent session capability choices')
  }
  if (snapshot.schema === 'ptc-capability-environment/v3') {
    if (!snapshot.settings.policy || typeof snapshot.settings.recoveryEnabled !== 'boolean'
      || typeof snapshot.settings.previewEnabled !== 'boolean') throw new Error('damaged capability policy settings')
  } else if (snapshot.settings.policy !== undefined) throw new Error('inconsistent historical capability generation')
  if (snapshot.navigationText !== undefined && snapshot.navigationText !== NAVIGATION) throw new Error('unknown capability navigation contract')
  const expected = createCapabilityPlan({ ...snapshot.settings, capabilities: snapshot.capabilities,
    coverage: snapshot.coverage, navigationText: snapshot.navigationText ?? LEGACY_NAVIGATION,
    configurationRevision: digest(snapshot.settings) })
  if (JSON.stringify(expected) !== JSON.stringify(snapshot.plan)
    || messageText(message) !== messageText(planMessage(snapshot, id, source.refresh === true))) {
    throw new Error('inconsistent session capability plan')
  }
  return deepFreeze(structuredClone(snapshot))
}

function planMessage(snapshot, id, refresh = false) {
  const plan = snapshot.plan
  const text = plan.enabled
    ? ['PTC Plus session capability environment' + (refresh ? ' refreshed; replaces the preceding capability plan.' : ':'),
      plan.directoryText, plan.catalogText,
      ...(plan.budgets.overageBytes ? [`Explicit full contracts exceed the configured budget by ${plan.budgets.overageBytes} UTF-8 bytes.`] : [])]
      .filter(Boolean).join('\n\n')
    : 'PTC Plus capability management is off for this session. Use the host-provided capability contracts.'
  return createUserMessage({ source: { kind: PTC_MESSAGE_SOURCE_KIND, form: CAPABILITY_PLAN_FORM,
    sessionId: id, refresh, digest: digest(snapshot), snapshot }, content: [{ type: 'text', text }] })
}

/** Recognize capability-owned presentation for bounded offline context accounting. */
export function readCapabilityContextMessage(message, sessionId) {
  const source = message?.source
  if (source?.kind !== PTC_MESSAGE_SOURCE_KIND
    || !['capability-plan', 'capability-navigation', 'capability-descriptions', 'capability-contracts'].includes(source.form)
    || message.content?.length !== 1 || message.content[0]?.type !== 'text'
    || typeof message.content[0].text !== 'string' || !message.content[0].text) return undefined
  if (source.form === CAPABILITY_PLAN_FORM) {
    try { if (!sourcePlan(message, sessionId)) return undefined } catch { return undefined }
  }
  if (source.form === 'capability-contracts'
    && !readContractUpdate(message, source.snapshot?.planDigest, sessionId)) return undefined
  if (source.form === 'capability-descriptions' && (!Array.isArray(source.entries)
    || source.entries.length === 0 || source.entries.some(id => typeof id !== 'string' || !id)
    || new Set(source.entries).size !== source.entries.length)) return undefined
  return { form: source.form, ...(source.form === CAPABILITY_PLAN_FORM
    ? { enabled: source.snapshot.plan.enabled, settings: source.snapshot.settings } : {}),
    sections: [{ name: `tools:ptc-plus-${source.form}`, text: message.content[0].text }] }
}

function resourceServers(sections) {
  const text = sections?.find(section => section.name === 'mcp-resource-servers')?.text
  if (typeof text !== 'string' || !text.trim()) return []
  // The published owner emits a JSON server-name array after this literal attribution.
  const marker = 'as the server argument: '
  const offset = text.indexOf(marker)
  if (offset < 0) throw new Error('ptc-plus: MCP resource server attribution is missing')
  const encoded = text.slice(offset + marker.length).trim().replace(/\.$/, '')
  const names = JSON.parse(encoded)
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('ptc-plus: invalid MCP server directory')
  return names
}

/** Host sections may carry no instructions while still proving owner identity. */
function sectionDependencies(sections) {
  return sections.filter(section => typeof section.text !== 'string' || section.text.trim().length > 0)
    .map(section => ({ id: section.name, text: section.text }))
}

function requiresCapabilityInventory(settings) {
  return settings.enabled || settings.policy && (settings.statistics?.enabled === true || settings.recoveryEnabled)
}

function temporaryCapabilityRule(selection) {
  if (selection && typeof selection === 'object') return { ...selection }
  return selection === undefined || selection === 'inherit' ? {}
    : selection === 'automatic' ? { availability: 'automatic', disclosure: 'automatic' }
      : selection === 'closed' ? { availability: 'closed' } : { availability: 'enabled', disclosure: selection }
}

function savedConfiguration(settings) {
  return { capabilityManagementEnabled: settings.enabled,
    capabilityBaseline: JSON.stringify(settings.manual.baseline), capabilityOverrides: JSON.stringify(settings.manual.overrides),
    capabilityStatistics: JSON.stringify(settings.statistics), capabilityBudgetBytes: settings.budgetBytes,
    capabilityDirectoryBytes: settings.directoryBudgetBytes, capabilityRecoveryBytes: settings.recoveryBytes,
    modelPreviewTokens: settings.previewTokens,
    ...(settings.policy ? { capabilityPolicy: JSON.stringify(settings.policy), capabilityRecoveryEnabled: settings.recoveryEnabled,
      modelPreviewEnabled: settings.previewEnabled } : {}) }
}

/** One SDK snapshot owns a tool's signature, schemas and revision. */
function toolCapability(schema, sections) {
  return { id: `tools.${schema.name}`, category: 'tool',
    revision: digest(schema), schema,
    contract: `\`\`\`ts\n${schema.description ? `/** ${schema.description.replaceAll('*/', '* /')} */\n` : ''}tools[${JSON.stringify(schema.name)}](args: ${jsonSchemaToTs(schema.parameters)}): Promise<${jsonSchemaToTs(schema.output)}>\n\`\`\``,
    dependencies: sectionDependencies(sections.filter(section => section.name === `tool:${schema.name}`
      || (section.name?.startsWith('mcp:') && schema.name.startsWith(`mcp__${section.name.slice(4)}__`)))),
    description: schema.description ?? '' }
}

function skillCapability(skill, modelLoaderAvailable = true) {
  const nativeInvocation = { modelInvocable: isModelInvocable(skill), userInvocable: isUserInvocable(skill) }
  const invocation = { ...nativeInvocation, modelInvocable: nativeInvocation.modelInvocable && modelLoaderAvailable }
  const summary = { name: skill.name, provider: skill.provider, source: skill.source,
    description: skill.description, invocation }
  const loading = invocation.modelInvocable
    ? `Load instructions: await tools.skill(${JSON.stringify({ name: skill.name })})`
    : invocation.userInvocable ? `User-only Skill: the user can invoke /${skill.name}. The model cannot load this Skill with tools.skill.`
      : 'No invocation path is available in this session.'
  return { id: `skills.${skill.name}`, category: 'skill', revision: digest(summary),
    contract: `${skill.description}\nInvocation: modelInvocable=${invocation.modelInvocable}, userInvocable=${invocation.userInvocable}.\n${loading}`,
    description: skill.description, selector: { name: skill.name }, invocation,
    ...(!modelLoaderAvailable ? { nativeInvocation, effectiveAvailability: invocation.userInvocable ? 'enabled' : 'closed' } : {}) }
}

const callingRevision = capability => capability === undefined || capability.effectiveAvailability === 'closed' ? null : digest({
  revision: capability.revision, contract: capability.contract, dependencies: capability.dependencies ?? [],
  ...(capability.invocation === undefined ? {} : { invocation: capability.invocation }),
})

function contractUpdateMessage(snapshot, sessionId) {
  const dependencies = new Map()
  const text = ['PTC Plus current calling contracts. These updates replace the earlier contracts for the listed capabilities only; session enablement and disclosure choices are unchanged.',
    ...snapshot.changes.map(change => change.capability === null
      ? `### ${change.id}\nThe Host no longer supplies this capability. Its earlier calling contract no longer applies.`
      : change.disclosure === 'full'
        ? [...(change.capability.dependencies ?? []).flatMap(item => {
          const previous = dependencies.get(item.id)
          if (previous !== undefined && previous !== item.text) throw new Error(`conflicting current contract dependency ${item.id}`)
          if (previous !== undefined) return []
          dependencies.set(item.id, item.text)
          return [`### dependency:${item.id}\n${item.text}`]
        }), `### ${change.id}\n${change.capability.contract}`].join('\n\n')
        : `### ${change.id}\nThe Host calling contract has changed. Retrieve the current complete contract with capabilities.search(${JSON.stringify({ query: change.id })}) before invoking it.`),
    ...(snapshot.overageBytes > 0 ? [`The currently selected full contracts exceed the configured budget by ${snapshot.overageBytes} UTF-8 bytes.`] : [])].join('\n\n')
  return createUserMessage({ source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'capability-contracts', sessionId,
    digest: digest(snapshot), snapshot }, content: [{ type: 'text', text }] })
}

function readContractUpdate(message, planDigest, sessionId) {
  const source = message?.source
  const snapshot = source?.snapshot
  if (source?.kind !== PTC_MESSAGE_SOURCE_KIND || source.form !== 'capability-contracts'
    || source.sessionId !== sessionId || snapshot?.schema !== 'ptc-capability-contracts/v1'
    || snapshot.planDigest !== planDigest || source.digest !== digest(snapshot)
    || !Array.isArray(snapshot.views) || !Array.isArray(snapshot.changes)
    || !Number.isSafeInteger(snapshot.overageBytes) || snapshot.overageBytes < 0) return undefined
  try {
    if (snapshot.views.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0]
      || (pair[1] !== null && (typeof pair[1] !== 'string' || !pair[1])))
      || new Set(snapshot.views.map(pair => pair[0])).size !== snapshot.views.length) return undefined
    const views = new Map(snapshot.views)
    if (snapshot.changes.length === 0 || new Set(snapshot.changes.map(change => change?.id)).size !== snapshot.changes.length
      || snapshot.changes.some(change => !views.has(change?.id) || !['full', 'on-demand'].includes(change.disclosure)
        || callingRevision(change.capability ?? undefined) !== views.get(change.id)
        || (change.capability !== null && (change.capability?.id !== change.id
          || typeof change.capability?.contract !== 'string' || !change.capability.contract)))) return undefined
    if (messageText(message) !== messageText(contractUpdateMessage(snapshot, sessionId))) return undefined
  } catch { return undefined }
  return snapshot
}

/** Derived metadata only: invocation continues through the request's original host functions. */
export function createCapabilityEnvironment({ ctx, config, toolSchemasForAgent, modelSchemasForAgent = toolSchemasForAgent, store, sessionHistoryForAgent }) {
  let currentConfig = config
  const sessions = new Map()
  const histories = new WeakMap()
  const sessionEvents = session => Array.isArray(session?.events) ? session.events : histories.get(session) ?? []
  async function observeHistory(agent, signal) {
    const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery
    const log = sessionHistoryForAgent ? await sessionHistoryForAgent(agent, signal) : await readSessionLog(agent.session, query, signal)
    const events = log?.events ?? []
    histories.set(agent.session, events)
    return events
  }
  function recordedPlan(history, id) {
    const withdrawn = history.findLastIndex(event => event.type === 'user/message'
      && ['disabled', 'unloaded'].includes(readRuntimeAvailability(event.data)))
    const runs = new Map()
    let latest
    for (const event of history.slice(withdrawn + 1)) {
      if (event.type === 'command/run' && event.data?.name === 'capabilities') runs.set(event.data.commandId, event.data)
      let message = event.type === 'user/message' ? event.data : undefined
      if (event.type === 'command/done' && event.data?.kind === 'success') {
        const receipt = readCapabilityCommandReceipt(event.data.text)
        const proposal = receipt?.proposal
        const run = runs.get(event.data.commandId)
        if (receipt?.sessionId === id && proposal?.commandId === event.data.commandId && proposal.rawInput === run?.args) message = proposal.message
      }
      if (message?.source?.kind === PTC_MESSAGE_SOURCE_KIND && message.source.form === CAPABILITY_PLAN_FORM && message.source.sessionId === id) latest = message
    }
    return latest
  }
  const operations = new WeakMap()
  const completions = new WeakMap()
  const admitted = new WeakMap()
  const skillProjections = new Map()
  const previewPolicies = new Map()
  const report = error => ctx.logger?.warn?.('ptc-plus: capability statistics unavailable', error)
  const statisticsOperation = operation => Promise.resolve().then(operation).catch(report)

  function readSkills(context) {
    return typeof context.get === 'function' ? context.get('skills') : context.skills
  }

  function currentDirectory(agent) {
    const directories = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
    return directories?.get(agent.session) ?? agent.session.header.cwd
  }

  async function observeSkills(agent, signal) {
    if (!readSkills(ctx)?.snapshot) return []
    // Read the original provider layers through a short-lived child scope. The
    // session projection is exact-scope-only, so catalogue reads cannot toggle
    // a global inventory flag and create a window where closed Skills load.
    const child = {}
    const isolated = typeof ctx.plugin === 'function' ? createScope(ctx, child, { parent: agent }) : null
    const view = isolated ? child : agent
    let observed
    try {
      const combined = [signal, agent.signal].filter(Boolean)
      observed = await readSkills(ctx).snapshot({ cwd: currentDirectory(agent), scope: view,
        signal: combined.length > 1 ? AbortSignal.any(combined) : combined[0] })
    } finally { await isolated?.dispose() }
    if (!observed.complete) throw new Error('ptc-plus: the Skill catalog is incomplete; cannot select a new capability environment')
    return observed.skills.filter(skill => isModelInvocable(skill) || isUserInvocable(skill))
  }

  async function qualifyCapabilities(agent, state, signal = agent.signal) {
    if (requiresCapabilityInventory(state.snapshot.settings)) {
      state.liveCapabilities = new Map((await inventory(agent, state.hostSections, state.snapshot.settings, signal, undefined, state.snapshot.plan.enabled
        ? new Set(state.snapshot.plan.entries.filter(entry => entry.selection !== 'closed').map(entry => entry.id)) : undefined))
        .map(item => [item.id, item]))
      await installSkillProjection(agent, state)
    }
    return state
  }

  async function inventory(agent, sections = [], settings, signal, presentation, frozenIds) {
    const schemas = toolSchemasForAgent(agent).filter(schema => !TRANSPORTS.has(schema.name))
    const capabilities = schemas.map(schema => toolCapability(schema, sections))
    const declaredServers = new Set([...resourceServers(sections),
      ...sections.filter(section => section.name?.startsWith('mcp:')).map(section => section.name.slice(4))])
    for (const capability of capabilities) {
      const servers = [...declaredServers].filter(server => capability.schema.name.startsWith(`mcp__${server}__`))
      if (servers.length === 1) capability.mcpServer = servers[0]
      else if (servers.length > 1) capability.mcpServerCandidates = servers
      presentation?.set(capability.id, { name: capability.schema.name,
        source: servers.length === 1 ? { kind: 'mcp', server: servers[0] } : servers.length > 1
          ? { kind: 'unknown' } : { kind: 'host' } })
    }
    const hasOperation = name => (!frozenIds || frozenIds.has(`tools.${name}`)) && capabilities.some(item => item.id === `tools.${name}`
      && (!settings?.enabled || !settings.policy || capabilityRule(settings.policy, item).availability !== 'closed'))
    const policyPaths = Boolean(settings?.policy)
    if (readSkills(ctx)?.snapshot !== undefined) {
      for (const skill of await observeSkills(agent, signal)) {
        capabilities.push(skillCapability(skill, !policyPaths || hasOperation('skill')))
        presentation?.set(`skills.${skill.name}`, { name: skill.name,
          source: { kind: 'skill', bucket: skill.source, provider: skill.provider },
          invocation: { modelInvocable: isModelInvocable(skill), userInvocable: isUserInvocable(skill) } })
      }
    }
    const servers = resourceServers(sections)
    const resourceOperations = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
      .filter(name => !policyPaths || hasOperation(name))
    for (const server of servers) capabilities.push({ id: `mcp.${server}`, category: 'resource', mcpServer: server,
      revision: digest({ server, instructions: sections.find(section => section.name === `mcp:${server}`)?.text ?? '' }),
      dependencies: sectionDependencies(sections.filter(section => section.name === `mcp:${server}`)), ...(policyPaths && resourceOperations.length === 0 ? { effectiveAvailability: 'closed' } : {}),
      contract: !policyPaths ? `MCP resource server ${JSON.stringify(server)}. Use tools.list_mcp_resources({server}), tools.list_mcp_resource_templates({server}), and tools.read_mcp_resource({server,uri}); use the listed URI or expand a listed template.`
        : `MCP resource server ${JSON.stringify(server)}. ${resourceOperations.length ? 'Available operations: ' + resourceOperations.map(name => `tools.${name}(${name === 'read_mcp_resource' ? '{server,uri}' : '{server}'})`).join(', ') + '.' : 'No resource operation is available in this session.'}`,
      description: `MCP resources and templates from ${server}`, selector: { server } })
    for (const server of servers) presentation?.set(`mcp.${server}`, { name: server, source: { kind: 'mcp', server } })
    return capabilities.filter(item => {
      if (item.category !== 'tool') return true
      const category = item.schema.name === 'skill' ? 'skill'
        : ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(item.schema.name) ? 'resource' : undefined
      return category === undefined || capabilities.some(member => member.category === category
        && (category !== 'skill' || member.invocation.modelInvocable)
        && (!settings?.enabled || (settings.policy ? capabilityRule(settings.policy, member).availability !== 'closed' : settings.manual.overrides[member.id] !== 'closed'))
        && (!settings?.enabled || settings.policy || member.mcpServer === undefined || settings?.manual.overrides[`mcpServers.${member.mcpServer}`] !== 'closed'))
    })
  }

  function stateFor(agent) { return sessions.get(String(agent?.session?.id ?? agent?.id)) }
  const canRefresh = agent => modelSchemasForAgent(agent).some(schema => schema.name === 'run_code')
  function planCommitted(agent, message) {
    return message !== undefined && (sessionEvents(agent.session).some(event =>
      event.type === 'user/message' && event.data?.id === message.id)
      || (agent.session.deriveMessages?.() ?? []).some(item => item.id === message.id))
  }
  function publishPlan(agent, message, signal) {
    signal?.throwIfAborted()
    if (typeof agent.session.append !== 'function') throw new Error('ptc-plus: capability plans require the public Session.append surface')
    // The Host establishes its protected system head before accepting first-step
    // messages. Preparation must not create that head or precede it on the surface.
    if (!sessionEvents(agent.session).some(event => event.type === 'system/message')) return
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
  function selection(state, id) { return state?.snapshot.plan.entries.find(entry => entry.id === id)?.selection }
  function supplied(state, id) {
    if (state?.liveCapabilities && (!state.liveCapabilities.has(id) || state.liveCapabilities.get(id).effectiveAvailability === 'closed')) return false
    if (!state?.snapshot.plan.enabled) return Boolean(state?.liveCapabilities) || !state?.snapshot.settings.policy || selection(state, id) !== 'closed'
    if (!['full', 'on-demand', 'host'].includes(selection(state, id))) return false
    const capability = state.snapshot.capabilities.find(item => item.id === id)
    return capability?.category !== 'resource'
      || resourceServers(state.hostSections).includes(capability.selector.server)
  }
  function sharedMembers(state, name) {
    const category = name === 'skill' ? 'skill'
      : ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name) ? 'resource' : undefined
    return category === undefined ? undefined : state.snapshot.capabilities
      .filter(item => item.category === category && supplied(state, item.id)
        && (category !== 'skill' || (state.liveCapabilities?.get(item.id) ?? item).invocation?.modelInvocable !== false))
      .map(item => item.selector[category === 'skill' ? 'name' : 'server'])
  }
  function memberSupplied(state, name) {
    return TRANSPORTS.has(name) || (supplied(state, `tools.${name}`) && sharedMembers(state, name)?.length !== 0)
  }
  function statisticsSnapshot(state) {
    if (!state.liveCapabilities) return state.snapshot
    return { ...state.snapshot, plan: { ...state.snapshot.plan,
      entries: state.snapshot.plan.enabled ? state.snapshot.plan.entries.filter(entry => supplied(state, entry.id) && state.liveCapabilities.has(entry.id))
        .map(entry => ({ ...entry, revision: state.liveCapabilities.get(entry.id).revision }))
        : [...state.liveCapabilities.values()].filter(item => supplied(state, item.id))
          .map(item => ({ id: item.id, revision: item.revision, category: item.category, selection: 'host' })) } }
  }
  function restoreEvidence(agent, state) {
    state.pendingExpanded ??= new Set()
    state.visibleExpansions ??= new Map()
    for (const event of sessionEvents(agent.session)) {
      const evidence = event.type === 'tool/result' && event.data?.meta?.[EVIDENCE_KEY]
      if (!evidence || evidence.schema !== 'ptc-capability-evidence/v1'
        || evidence.planDigest !== digest(state.snapshot)
        || !Array.isArray(evidence.expanded) || !Array.isArray(evidence.used)
        || [...evidence.expanded, ...evidence.used].some(id => typeof id !== 'string')) continue
      const managed = id => state.snapshot.capabilities.some(item => item.id === id) && supplied(state, id)
      for (const id of evidence.expanded.filter(managed)) state.expanded.add(id)
      for (const id of evidence.used.filter(managed)) { state.used.delete(id); state.used.set(id, true) }
      if (event.data.message?.id) {
        const text = messageText(event.data.message)
        const presented = evidence.expanded.filter(managed).filter(id => {
          const capability = state.snapshot.capabilities.find(item => item.id === id)
          return capability && [capability.contract, ...(capability.dependencies ?? []).map(item => item.text)]
            .every(contract => text.includes(contract) || text.includes(JSON.stringify(contract).slice(1, -1)))
        })
        state.visibleExpansions.set(event.data.message.id, presented)
      }
    }
    return state
  }

  function validateSupply(agent, name, args) {
    const state = stateFor(agent)
    if (!state?.snapshot.plan.enabled || TRANSPORTS.has(name)) return
    if (!memberSupplied(state, name)) throw new ToolNotFoundError(name)
    if (name === 'skill' && typeof args?.name === 'string' && !supplied(state, `skills.${args.name}`)) {
      throw new Error(`skill "${args.name}" is unknown or no longer available`)
    }
    if (['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)
      && typeof args?.server === 'string' && !supplied(state, `mcp.${args.server}`)) {
      throw new Error(`MCP resource server "${args.server}" is not available`)
    }
  }

  async function installSkillProjection(agent, state) {
    let projection = skillProjections.get(agent)
    if (!projection && state.snapshot.plan.enabled && readSkills(ctx)?.registerProvider) {
      const scope = createScope(ctx, agent)
      projection = { scope, state, inventory: false }
      try {
      scope.ctx.effect(() => readSkills(scope.ctx).registerProvider(control => {
        projection.control = control
        const name = 'ptc-plus-session-capabilities'
        return { name,
          async list(options) {
            if (options.scope !== agent || projection.inventory || !projection.state.snapshot.plan.enabled) return []
            const capabilities = new Map(projection.state.snapshot.capabilities.map(item => [item.id, item]))
            for (const [id, item] of projection.state.liveCapabilities ?? []) capabilities.set(id, item)
            return [...capabilities.values()].filter(item => item.category === 'skill'
              && !supplied(projection.state, item.id)).map(item => ({
              name: item.selector.name, description: 'Unavailable in this session capability environment.',
              invocation: { modelInvocable: false, userInvocable: false },
              source: 'ptc-plus-session-capabilities', provider: name, rank: -Number.MAX_VALUE,
              locator: item.id,
            }))
          },
          // A closed winning entry has no body. Neither model loading nor an
          // explicit user gesture can invoke the original provider.
          async get() { return undefined },
        }
      }), 'ptc-plus: session Skill projection')
      skillProjections.set(agent, projection)
      } catch (error) {
        await scope.dispose()
        throw error
      }
    }
    if (projection) { projection.state = state; projection.control.invalidate() }
  }

  async function acceptState(agent, state, publish, signal) {
    const preceding = skillProjections.get(agent)
    const precedingState = preceding?.state
    try {
      await installSkillProjection(agent, state)
      signal?.throwIfAborted()
      if (publish) publishPlan(agent, state.message, signal)
    } catch (error) {
      const projection = skillProjections.get(agent)
      if (preceding) {
        preceding.state = precedingState
        try { preceding.control.invalidate() } catch (restoration) {
          throw new AggregateError([error, restoration], 'PTC Plus Skill projection restoration failed')
        }
      } else if (projection) {
        skillProjections.delete(agent)
        await projection.scope.dispose()
      }
      throw error
    }
    sessions.set(String(agent.session.id ?? agent.id), state)
    return state
  }

  async function previewPolicy(agent) {
    const state = stateFor(agent)
    if (!(state?.snapshot.settings.policy ? state.snapshot.settings.previewEnabled : state?.snapshot.plan.enabled)) return undefined
    const cap = state.snapshot.settings.previewTokens
    if (!previewPolicies.has(cap)) {
      // Cordis core events are context infrastructure, not an isolatable service.
      // A separate context owns only the policy listeners; optional services
      // continue to resolve from the live host at the moment of presentation.
      const isolated = new Context()
      spillPolicy.apply({
        on: (...args) => isolated.on(...args),
        get: name => ctx.get(name),
        logger: ctx.logger,
      }, { maxInlineTokens: cap })
      previewPolicies.set(cap, isolated)
    }
    return previewPolicies.get(cap)
  }

  async function prepare(agent, sections, force = false, signal = agent?.signal, choice) {
    signal?.throwIfAborted()
    if (agent?.session === undefined) {
      if (!capabilityConfiguration(currentConfig).enabled) return undefined
      throw new TypeError('ptc-plus: capability management requires an agent Session')
    }
    await observeHistory(agent, signal)
    await reconcilePendingChoice(agent, signal)
    const id = String(agent.session.id ?? agent.id)
    if (!force && sessions.has(id)) {
      const state = sessions.get(id)
      if (sections !== undefined) state.hostSections = sections
      return qualifyCapabilities(agent, state, signal)
    }
    const pending = operations.get(agent)
    if (pending !== undefined && !force) return pending
    const task = (async () => {
      if (!force) {
        const history = sessionEvents(agent.session)
        const recorded = recordedPlan(history, id)
        if (recorded !== undefined) {
          let snapshot
          try { snapshot = sourcePlan(recorded, id) } catch (error) {
            ctx.logger?.warn?.(`ptc-plus: ${error.message}; continuing with the host environment until /capabilities refresh`)
            const settings = { ...capabilityConfiguration(currentConfig), enabled: false, ...(currentConfig.capabilityPolicy ? { recoveryEnabled: false, previewEnabled: false, statistics: { ...capabilityConfiguration(currentConfig).statistics, enabled: false } } : {}) }
            const plan = createCapabilityPlan({ ...settings, configurationRevision: digest(settings), capabilities: [], navigationText: NAVIGATION })
            snapshot = deepFreeze({ schema: settings.policy ? 'ptc-capability-environment/v3' : 'ptc-capability-environment/v1', ...(settings.policy ? { sourceSettings: settings, sessionOverrides: {} } : {}), navigationText: NAVIGATION, settings, capabilities: [], plan })
            const notice = planMessage(snapshot, id, true)
            const state = { snapshot, message: notice, hostSections: sections ?? [], expanded: new Set(), used: new Map() }
            return acceptState(agent, state, true, signal)
          }
          const restored = { snapshot, message: snapshot.plan.enabled || snapshot.settings.policy && (snapshot.settings.statistics?.enabled || snapshot.settings.recoveryEnabled || snapshot.settings.previewEnabled) || recorded.source.refresh ? recorded : undefined, hostSections: sections ?? [], expanded: new Set(), used: new Map() }
          await qualifyCapabilities(agent, restored, signal)
          signal?.throwIfAborted()
          restoreEvidence(agent, restored)
          return acceptState(agent, restored, false, signal)
        }
      }
      const historical = !force && !sessionEvents(agent.session).some(event => event.type === 'user/message'
        && ['disabled', 'unloaded'].includes(readRuntimeAvailability(event.data))) && sessionEvents(agent.session).some(event =>
        event.type === 'assistant/message' || event.type === 'tool/result')
      const previous = stateFor(agent)?.snapshot
      const sourceSettings = choice?.sourceSettings ?? { ...capabilityConfiguration(currentConfig), ...(historical ? { enabled: false, ...(currentConfig.capabilityPolicy ? { recoveryEnabled: false, previewEnabled: false, statistics: { ...capabilityConfiguration(currentConfig).statistics, enabled: false } } : {}) } : {}) }
      const sessionOverrides = choice?.sessionOverrides ?? previous?.sessionOverrides ?? {}
      const settings = sessionCapabilitySettings(sourceSettings, sessionOverrides)
      const capabilities = requiresCapabilityInventory(settings) ? await inventory(agent, sections ?? [], settings, signal) : []
      const coverage = (settings.policy ? settings.policy.allocation.statistics : settings.statistics?.enabled === true) ? await store?.coverage(agent, capabilities, settings.statistics) : undefined
      const plan = createCapabilityPlan({ ...settings, configurationRevision: digest(settings),
        capabilities, coverage, navigationText: NAVIGATION })
      const hasChoices = settings.policy !== undefined || choice !== undefined || previous?.schema === 'ptc-capability-environment/v2'
      const snapshot = deepFreeze({ schema: settings.policy ? 'ptc-capability-environment/v3' : hasChoices ? 'ptc-capability-environment/v2' : 'ptc-capability-environment/v1',
        ...(hasChoices ? { sourceSettings, sessionOverrides } : {}), navigationText: NAVIGATION, settings, capabilities, ...(coverage === undefined ? {} : { coverage }), plan })
      const message = planMessage(snapshot, id, force)
      agent.signal?.throwIfAborted?.()
      signal?.throwIfAborted()
      // Initialized sessions commit a refresh and its notification atomically.
      // First-step proposals are accepted through the Host's pre-step messages.
      const state = { snapshot, message: !settings.enabled && !force && !(settings.policy && (settings.statistics?.enabled || settings.recoveryEnabled || settings.previewEnabled)) ? undefined : message,
        hostSections: sections ?? [], expanded: new Set(), used: new Map(),
        ...(requiresCapabilityInventory(settings) ? { liveCapabilities: new Map(capabilities.map(item => [item.id, item])) } : {}) }
      restoreEvidence(agent, state)
      if (choice?.commandId && !sessionEvents(agent.session).some(event => event.type === 'system/message')) {
        state.pendingCommand = choice.commandId
        state.pendingPrevious = stateFor(agent)
      }
      return acceptState(agent, state, force, signal)
    })()
    operations.set(agent, task)
    try { return await task } finally { if (operations.get(agent) === task) operations.delete(agent) }
  }

  async function reconcilePendingChoice(agent, signal, requireReceipt = false) {
    const state = stateFor(agent)
    if (!state?.pendingCommand || planCommitted(agent, state.message)) return
    const history = sessionEvents(agent.session)
    const done = history.findLast(event => event.type === 'command/done' && event.data?.commandId === state.pendingCommand)
    if (!done && !requireReceipt) return
    const proved = recordedPlan(history, String(agent.session.id ?? agent.id))
    if (proved?.id === state.message.id) {
      delete state.pendingCommand; delete state.pendingPrevious
      return
    }
    await acceptState(agent, state.pendingPrevious, false, signal)
  }

  function visibleSchemas(agent, schemas) {
    const state = stateFor(agent)
    if (!state?.snapshot.plan.enabled) return schemas
    return schemas.filter(schema => memberSupplied(state, schema.name))
  }

  return Object.freeze({
    reconfigure(next) { currentConfig = next },
    prepare,
    stateFor,
    visibleSchemas,
    validateSupply,
    async refresh(agent, sections, signal, commandId) {
      signal?.throwIfAborted()
      if (typeof agent.runMaintenance !== 'function') throw new Error('ptc-plus: capability refresh requires the public agent maintenance boundary')
      return agent.runMaintenance(async maintenanceSignal => {
        await prepare(agent, sections, false, maintenanceSignal)
        const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: maintenanceSignal })
        signal?.throwIfAborted()
        maintenanceSignal.throwIfAborted()
        const preparationSignal = AbortSignal.any([signal, maintenanceSignal, agent.signal].filter(Boolean))
        const previous = stateFor(agent)?.snapshot
        return prepare(agent, stateFor(agent)?.hostSections ?? assembly.sections, true, preparationSignal,
          commandId === undefined ? undefined : {
            sourceSettings: capabilityConfiguration(currentConfig), sessionOverrides: previous?.sessionOverrides ?? {}, commandId,
          })
      })
    },
    async catalogFor(agent, signal) {
      if (!canRefresh(agent)) throw new Error('ptc-plus: select an active PTC session')
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal, ptcPlusCapabilityObservation: true })
      const presentation = new Map()
      const capabilities = await inventory(agent, assembly.sections,
        { ...capabilityConfiguration(currentConfig), enabled: false, manual: { baseline: [], overrides: {} } }, signal, presentation)
      signal?.throwIfAborted()
      const history = await observeHistory(agent, signal)
      await reconcilePendingChoice(agent, signal)
      const recorded = recordedPlan(history, String(agent.session.id ?? agent.id))
      const snapshot = stateFor(agent)?.snapshot ?? (recorded && sourcePlan(recorded, String(agent.session.id ?? agent.id)))
      const state = snapshot ? { snapshot } : undefined
      const sourceSettings = snapshot?.sourceSettings ?? snapshot?.settings
      const sourceOverrides = sourceSettings?.manual?.overrides
      const sessionSourceSelection = id => sourceOverrides?.[id] ?? (sourceOverrides ? 'automatic' : 'unknown')
      const dimensions = capability => {
        const saved = capabilityConfiguration(currentConfig)
        if (!saved.policy && !snapshot?.settings.policy) return { managementEnabled: snapshot?.settings.enabled }
        const source = sourceSettings?.policy ? capabilityRule(sourceSettings.policy, capability) : undefined
        const temporary = snapshot?.sessionOverrides?.[capability.id]
        const rule = rules => capability.id.startsWith('mcpServers.') ? rules.mcpServers[capability.id.slice(11)] ?? {} : rules.items[capability.id] ?? {}
        return { managementEnabled: snapshot?.settings.enabled, ...(saved.policy ? { savedRule: rule(saved.policy) } : {}),
          ...(sourceSettings?.policy ? { sourceRule: rule(sourceSettings.policy), sourceDimensions: source } : {}),
          temporaryRule: temporaryCapabilityRule(temporary),
          ...(snapshot?.settings.policy ? { effectiveDimensions: snapshot.plan.entries.find(entry => entry.id === capability.id)
            ?? (capability.category === 'server' ? snapshot.settings.enabled
              ? capabilityRule(snapshot.settings.policy, capability) : { availability: 'enabled', disclosure: 'host', availabilitySource: 'host', disclosureSource: 'host' } : undefined) } : {}) }
      }
      const entries = capabilities.map(capability => ({ id: capability.id, category: capability.category,
        description: capability.description, ...presentation.get(capability.id), ...dimensions(capability),
        ...(capability.mcpServer === undefined ? {} : { mcpServer: capability.mcpServer }),
        saved: capabilityConfiguration(currentConfig).manual.overrides[capability.id] ?? 'automatic',
        sessionSourceSelection: sessionSourceSelection(capability.id),
        temporary: typeof state?.snapshot.sessionOverrides?.[capability.id] === 'object' ? 'inherit' : state?.snapshot.sessionOverrides?.[capability.id] ?? 'inherit',
        effective: state?.snapshot.plan.entries.find(entry => entry.id === capability.id)?.selection ?? 'pending' }))
      for (const server of new Set(capabilities.map(item => item.mcpServer).filter(Boolean))) {
        const id = `mcpServers.${server}`
        const enclosingClosure = state ? state.snapshot.settings.enabled && (state.snapshot.settings.policy
          ? state.snapshot.settings.policy.mcpServers[server]?.availability === 'closed'
          : state.snapshot.settings.manual.overrides[id] === 'closed') : undefined
        const effective = state ? state.snapshot.settings.policy && state.snapshot.settings.enabled
          ? capabilityRule(state.snapshot.settings.policy, { id, category: 'server', mcpServer: server }).availability
          : enclosingClosure ? 'closed' : 'enabled' : 'pending'
        entries.push({ id, category: 'server', name: server, description: `MCP server ${server}`,
          source: { kind: 'mcp', server }, ...dimensions({ id, category: 'server', mcpServer: server }), saved: capabilityConfiguration(currentConfig).manual.overrides[id] ?? 'automatic',
          sessionSourceSelection: sessionSourceSelection(id),
          temporary: typeof state?.snapshot.sessionOverrides?.[id] === 'object' ? 'inherit' : state?.snapshot.sessionOverrides?.[id] ?? 'inherit',
          enclosingClosure, effective })
      }
      return entries
    },
    async change(agent, intent, signal, globalSettings) {
      if (!canRefresh(agent)) throw new Error('ptc-plus: select an active PTC session')
      const dimension = intent.dimension
      const choices = dimension === 'availability' ? ['enabled', 'closed', 'automatic', 'inherit']
        : dimension === 'disclosure' ? [...CAPABILITY_DISCLOSURES, 'automatic', 'inherit']
          : dimension === undefined ? ['full', 'on-demand', 'closed', 'automatic', 'inherit'] : []
      if (!['session', 'global'].includes(intent.scope) || !choices.includes(intent.selection)
        || intent.scope === 'global' && intent.selection === 'inherit') throw new TypeError('invalid capability change')
      if (typeof agent.runMaintenance !== 'function') throw new Error('ptc-plus: capability changes require public agent maintenance')
      return agent.runMaintenance(async maintenanceSignal => {
        const combined = AbortSignal.any([signal, maintenanceSignal, agent.signal].filter(Boolean))
        combined.throwIfAborted()
        await prepare(agent, undefined, false, combined)
        const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: combined, ptcPlusCapabilityObservation: true })
        const completeSettings = { ...capabilityConfiguration(currentConfig), enabled: false, manual: { baseline: [], overrides: {} } }
        const available = await inventory(agent, assembly.sections, completeSettings, combined)
        if (intent.id.startsWith('mcpServers.')) {
          const server = intent.id.slice('mcpServers.'.length)
          if (!available.some(item => item.mcpServer === server)) throw new Error('unknown MCP server in this session')
          if (!dimension && !['closed', 'automatic', 'inherit'].includes(intent.selection)) throw new Error('MCP server choices are closed, automatic or inherit')
        } else if (!available.some(item => item.id === intent.id)) throw new Error('unknown managed capability in this session')
        const previous = stateFor(agent)?.snapshot
        let sourceSettings = previous?.sourceSettings ?? previous?.settings ?? capabilityConfiguration(currentConfig)
        if (dimension && !sourceSettings.policy) {
          sourceSettings = capabilityConfiguration(capabilityProfileConfiguration(savedConfiguration(sourceSettings)))
        }
        if (!sourceSettings.enabled || !capabilityConfiguration(currentConfig).enabled) throw new Error('ptc-plus: enable capability management before changing a session choice')
        const sessionOverrides = { ...previous?.sessionOverrides }
        let globalSaved = false
        if (intent.scope === 'session') {
          if (dimension || sourceSettings.policy) {
            const patch = temporaryCapabilityRule(sessionOverrides[intent.id])
            if (dimension) {
              if (intent.selection === 'inherit') delete patch[dimension]
              else patch[dimension] = intent.selection
            } else if (intent.selection === 'inherit') {
              delete patch.availability; delete patch.disclosure
            } else if (intent.selection === 'closed') patch.availability = 'closed'
            else Object.assign(patch, temporaryCapabilityRule(intent.selection))
            if (Object.keys(patch).length) sessionOverrides[intent.id] = patch
            else delete sessionOverrides[intent.id]
          } else if (intent.selection === 'inherit') delete sessionOverrides[intent.id]
          else sessionOverrides[intent.id] = intent.selection
        } else {
          if (!globalSettings?.read || !globalSettings?.update) throw new Error('ptc-plus: global capability changes require the public settings writer')
          const before = globalSettings.read()
          if (!before || !Number.isSafeInteger(before.revision)) throw new Error('ptc-plus: global capability changes require settings revision evidence')
          if (before.value.capabilityManagementEnabled === false) throw new Error('ptc-plus: enable capability management before changing a global choice')
          const overrides = JSON.parse(before.value.capabilityOverrides ?? '{}')
          if (intent.selection === 'automatic') delete overrides[intent.id]
          else overrides[intent.id] = intent.selection
          combined.throwIfAborted()
          const policy = capabilityPolicyForConfig(before.value)
          let nextPolicy = dimension ? changeCapabilityRule(policy, intent.id, dimension, intent.selection)
            : changeCapabilityRule(policy, intent.id, 'availability', intent.selection === 'closed' ? 'closed'
              : intent.selection === 'automatic' ? 'automatic' : 'enabled')
          if (!dimension) nextPolicy = intent.selection === 'automatic' ? changeCapabilityRule(nextPolicy, intent.id, 'disclosure', 'automatic')
            : intent.selection === 'closed' ? nextPolicy : changeCapabilityRule(nextPolicy, intent.id, 'disclosure', intent.selection)
          const patch = before.value.capabilityPolicy || dimension
            ? { capabilityPolicy: JSON.stringify(nextPolicy), ...(!dimension ? { capabilityOverrides: JSON.stringify(overrides) } : {}) }
            : { capabilityOverrides: JSON.stringify(overrides) }
          await globalSettings.update(patch, before.revision)
          globalSaved = true
        }
        try {
          if (globalSaved) {
            const saved = globalSettings.read()
            if (!saved?.value || !Number.isSafeInteger(saved.revision)) throw new Error('ptc-plus: saved settings could not be confirmed for this session')
            sourceSettings = capabilityConfiguration({ ...currentConfig, ...saved.value })
            if (dimension) {
              const retained = temporaryCapabilityRule(sessionOverrides[intent.id]); delete retained[dimension]
              if (Object.keys(retained).length) sessionOverrides[intent.id] = retained
              else delete sessionOverrides[intent.id]
            } else delete sessionOverrides[intent.id]
          }
          combined.throwIfAborted()
          if (!sourceSettings.enabled) throw new Error('ptc-plus: enable capability management before changing a session choice')
          await prepare(agent, assembly.sections, true, combined, { sourceSettings, sessionOverrides, commandId: intent.commandId })
          return { globalSaved, sessionApplied: true, publication: planCommitted(agent, stateFor(agent).message) ? 'accepted' : 'pending' }
        } catch (error) {
          if (globalSaved) return { globalSaved: true, sessionApplied: false, error: String(error?.message ?? error) }
          throw error
        }
      })
    },
    pendingChoiceMessage(agent) {
      const state = stateFor(agent)
      return ['ptc-capability-environment/v2', 'ptc-capability-environment/v3'].includes(state?.snapshot.schema) && !planCommitted(agent, state.message) ? state.message : undefined
    },
    projectSections(agent, sections) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return sections
      const retained = state.snapshot.capabilities.filter(item => selection(state, item.id) === 'host' && supplied(state, item.id))
      const retainedSections = new Set(retained.flatMap(item => item.dependencies ?? []).map(item => item.id))
      const ownedSections = new Set(state.snapshot.capabilities.flatMap(item => item.dependencies ?? []).map(item => item.id))
      return sections.flatMap(section => {
        if (section.name === 'mcp-resource-servers') {
          const servers = retained.filter(item => item.category === 'resource').map(item => item.selector.server)
          return servers.length ? [{ ...section, text: `Use the following MCP resource servers as the server argument: ${JSON.stringify(servers)}.` }] : []
        }
        if (ownedSections.has(section.name) && !retainedSections.has(section.name)) return []
        if (section.name?.startsWith('tool:') && !TRANSPORTS.has(section.name.slice(5))
          && selection(state, `tools.${section.name.slice(5)}`) !== 'host') return []
        return [section]
      })
    },
    sdk(agent, nativeSdk) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return nativeSdk
      const schemas = toolSchemasForAgent(agent).filter(schema => !TRANSPORTS.has(schema.name))
      const host = schemas.filter(schema => selection(state, `tools.${schema.name}`) === 'host' && memberSupplied(state, schema.name))
      return host.length === schemas.length ? nativeSdk : renderToolsSdk(host)
    },
    projectMembers(agent, members) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return members
      return members.filter(name => memberSupplied(state, name))
    },
    metadata(agent) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return []
      return ['skill', 'resource'].map(category => ({ namespace: category === 'skill' ? 'skills' : 'mcp',
        members: state.snapshot.capabilities.filter(item => item.category === category && supplied(state, item.id))
          .map(item => state.liveCapabilities?.get(item.id) ?? item)
          .map(item => ({ name: item.id.slice(item.id.indexOf('.') + 1), description: item.description,
            contract: item.contract, dependencies: item.dependencies ?? [], revision: item.revision, parameters: {}, returns: {},
            ...(item.invocation === undefined ? {} : { invocation: item.invocation }),
            ...(item.nativeInvocation === undefined ? {} : { nativeInvocation: item.nativeInvocation }),
            completeness: 'complete', effect: 'unknown', replay: 'recorded-value' })) }))
    },
    adaptFunction(agent, name, original) {
      return (...args) => {
        validateSupply(agent, name, args[0])
        return original(...args)
      }
    },
    explored(agent, result) {
      const state = stateFor(agent)
      for (const item of result?.matches ?? result?.symbols ?? []) {
        const id = item.symbol ?? `${item.namespace}.${item.name}`
        if (!state?.snapshot.capabilities.some(item => item.id === id) || !supplied(state, id)) continue
        state.expanded.add(id)
        state?.pendingExpanded?.add(id)
      }
    },
    async preStep(payload, next) {
      // Preparation precedes the host's explicit Skill loading, using the same
      // public composition entry that owns PTC/native selection and MCP sections.
      if (ctx.systemPrompt?.assemble) {
        await ctx.systemPrompt.assemble({ agent: payload.agent, scope: payload.agent, signal: payload.signal })
      }
      const prepared = stateFor(payload.agent)
      if (prepared) await qualifyCapabilities(payload.agent, prepared, payload.signal)
      const decision = await next()
      if (decision.kind !== 'enter' || payload.signal?.aborted) return decision
      await observeHistory(payload.agent, payload.signal)
      await reconcilePendingChoice(payload.agent, payload.signal, true)
      const state = stateFor(payload.agent)
      if (decision.kind !== 'enter' || !state || payload.signal?.aborted) return decision
      await statisticsOperation(() => store?.available(payload.agent, statisticsSnapshot(state)))
      restoreEvidence(payload.agent, state)
      const visible = payload.agent.session.deriveMessages?.() ?? []
      const hostSkills = state.snapshot.settings.policy && state.snapshot.capabilities.filter(item => item.category === 'skill' && supplied(state, item.id))
        .every(item => selection(state, item.id) === 'host' && item.nativeInvocation === undefined)
      const messages = state.snapshot.plan.enabled ? decision.messages.filter(message =>
        (message.source?.kind !== 'skill-catalog' || hostSkills)
        && !(message.source?.kind === 'skill-invocation' && !supplied(state, `skills.${message.source.name}`))) : decision.messages
      // An uncommitted proposal enters once through Host acceptance. A committed
      // plan is already in history; its ancestry cannot resurrect compacted text.
      const planVisible = state.message && visible.some(message => message.id === state.message.id
        && readCapabilityContextMessage(message, String(payload.agent.session.id ?? payload.agent.id))?.form === CAPABILITY_PLAN_FORM)
      const additions = state.message && !planCommitted(payload.agent, state.message)
        && !messages.some(message => message.id === state.message.id) ? [state.message] : []
      const planSupplied = planVisible || [...messages, ...additions].some(message => message.id === state.message?.id)
      if (state.snapshot.plan.enabled || state.snapshot.settings.policy && state.snapshot.settings.recoveryEnabled) {
        const planDigest = digest(state.snapshot)
        const sessionId = String(payload.agent.session.id ?? payload.agent.id)
        const recordedUpdate = [...visible, ...messages].map(message => readContractUpdate(message, planDigest, sessionId))
          .filter(Boolean).at(-1)
        const selected = state.snapshot.plan.entries.filter(entry => ['full', 'on-demand', 'host'].includes(entry.selection))
        const preceding = new Map(recordedUpdate?.views ?? selected.map(entry => [entry.id,
          callingRevision(state.snapshot.capabilities.find(item => item.id === entry.id))]))
        const views = selected.map(entry => [entry.id, callingRevision(state.liveCapabilities.get(entry.id))])
        const changes = selected.filter(entry => preceding.get(entry.id) !== callingRevision(state.liveCapabilities.get(entry.id)))
          .map(entry => ({ id: entry.id, disclosure: entry.selection === 'host' ? 'full' : entry.selection, capability: callingRevision(state.liveCapabilities.get(entry.id)) === null ? null : state.liveCapabilities.get(entry.id) }))
        if (changes.length) {
          const livePlan = createCapabilityPlan({ ...state.snapshot.settings, policy: undefined, capabilities: [...state.liveCapabilities.values()]
            .filter(item => state.snapshot.capabilities.some(original => original.id === item.id)),
          manual: { baseline: [], overrides: Object.fromEntries(state.snapshot.plan.entries.map(entry => [entry.id, entry.selection === 'host' ? 'full' : entry.selection])) },
          navigationText: NAVIGATION, configurationRevision: state.snapshot.plan.configurationRevision })
          additions.push(contractUpdateMessage({ schema: 'ptc-capability-contracts/v1', planDigest, views, changes,
            overageBytes: livePlan.budgets.overageBytes }, sessionId))
        }
        const expandedVisible = new Set([...visible, ...messages].flatMap(message => message.source?.form === 'capability-descriptions'
          ? message.source.entries ?? [] : state.visibleExpansions?.get(message.id) ?? []))
        for (const entry of selected.filter(entry => entry.selection === 'host')) {
          if (state.liveCapabilities.has(entry.id)) expandedVisible.add(entry.id)
        }
        for (const message of [...visible, ...messages, ...additions]) {
          const update = readContractUpdate(message, planDigest, sessionId)
          for (const change of update?.changes ?? []) {
            if (change.disclosure === 'full' && change.capability !== null
              && callingRevision(change.capability) === callingRevision(state.liveCapabilities.get(change.id))) expandedVisible.add(change.id)
          }
        }
        if (planSupplied) {
          for (const entry of state.snapshot.plan.entries.filter(entry => entry.selection === 'full')) {
            if (callingRevision(state.snapshot.capabilities.find(item => item.id === entry.id))
              === callingRevision(state.liveCapabilities.get(entry.id))) expandedVisible.add(entry.id)
            if (!state.expanded.has(entry.id)) state.pendingExpanded.add(entry.id)
            state.expanded.add(entry.id)
          }
        }
        if (state.snapshot.plan.directoryText && !planSupplied && ![...visible, ...messages].some(message => message.source?.form === 'capability-navigation')) {
          additions.push(createUserMessage({ source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'capability-navigation' },
            content: [{ type: 'text', text: state.snapshot.plan.directoryText || NAVIGATION }] }))
        }
        let body = ''
        const restored = []
        const dependencies = new Set()
        const currentSchemas = new Map(toolSchemasForAgent(payload.agent).map(schema => [`tools.${schema.name}`, digest(schema)]))
        for (const id of (state.snapshot.settings.policy && !state.snapshot.settings.recoveryEnabled ? [] : [...state.used.keys()].reverse())) {
          const capability = state.liveCapabilities.get(id)
          if (!capability || capability.category === 'skill' || !state.expanded.has(id) || expandedVisible.has(id) || !supplied(state, id)) continue
          if (capability.category === 'tool' && currentSchemas.get(id) !== capability.revision) continue
          const missing = (capability.dependencies ?? []).filter(item => !dependencies.has(item.id))
          const contract = [...missing.map(item => `### dependency:${item.id}\n${item.text}`), `### ${id}\n${capability.contract}`].join('\n\n')
          if (Buffer.byteLength(body + '\n\n' + contract) > state.snapshot.settings.recoveryBytes) continue
          body += `${body ? '\n\n' : ''}${contract}`
          restored.push(id)
          for (const item of missing) dependencies.add(item.id)
        }
        if (body) additions.push(createUserMessage({ source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'capability-descriptions', entries: restored },
          content: [{ type: 'text', text: body }] }))
      }
      for (const message of messages) {
          if (message.source?.kind === 'skill-invocation' && supplied(state, `skills.${message.source.name}`)) {
            const observedSnapshot = statisticsSnapshot(state)
            void statisticsOperation(() => store?.used(payload.agent, observedSnapshot,
              `skills.${message.source.name}`, 'skill-body-accepted', 'complete'))
          }
        }
      // Before task history exists, the initial plan precedes admitted task messages.
      // Refresh and recovery append after committed history; they never reorder it.
      const initial = !sessionEvents(payload.agent.session).some(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type))
      return { ...decision, messages: initial ? [...additions, ...messages] : [...messages, ...additions] }
    },
    admitted(exec) {
      // Host tokens correlate immutable call identity through mutable wrappers.
      const state = stateFor(exec.agent)
      if (exec.token && (state && requiresCapabilityInventory(state.snapshot.settings))) admitted.set(exec.token, statisticsSnapshot(state))
    },
    dispatched(exec, result) {
      const state = stateFor(exec.agent)
      const observation = exec.token && admitted.get(exec.token)
      if (!observation || !state || !observation.plan.entries.some(entry => entry.id === `tools.${exec.name}`)
        || result?.error?.info?.code === 'ABORTED_BEFORE_DISPATCH' || result?.error?.info?.code === 'UNKNOWN_TOOL') return
      admitted.delete(exec.token)
      state.used.delete(`tools.${exec.name}`)
      state.used.set(`tools.${exec.name}`, true)
      void statisticsOperation(() => store?.used(exec.agent, observation, `tools.${exec.name}`, 'host-execution-result', result?.error?.info?.code === 'ABORTED' ? 'cancelled' : result?.isError ? 'failed' : 'complete'))
      if (exec.name === 'skill' && !result?.isError && typeof exec.arguments?.name === 'string') {
        void statisticsOperation(() => store?.used(exec.agent, observation, `skills.${exec.arguments.name}`, 'skill-body-accepted', 'complete'))
      }
      if (exec.name === 'read_mcp_resource' && !result?.isError && typeof exec.arguments?.server === 'string') {
        const id = `mcp.${exec.arguments.server}`
        state.used.delete(id)
        state.used.set(id, true)
        void statisticsOperation(() => store?.used(exec.agent, observation, `mcp.${exec.arguments.server}`, 'resource-access', 'complete'))
      }
    },
    toolMetadata(agent, metadata, schemas = toolSchemasForAgent(agent)) {
      const state = stateFor(agent)
      if (!state || !requiresCapabilityInventory(state.snapshot.settings)) return metadata
      const capabilities = new Map(schemas.map(schema => {
        const item = toolCapability(schema, state.hostSections)
        return [item.id, item]
      }))
      return metadata.map(entry => ({ ...entry, members: entry.members.map(member => {
        const item = capabilities.get(`${entry.namespace}.${member.name}`)
        return item ? { ...member, contract: item.contract, dependencies: item.dependencies ?? [], revision: item.revision } : member
      }) }))
    },
    complete(exec, result) {
      const state = stateFor(exec.agent)
      if (!state || !requiresCapabilityInventory(state.snapshot.settings)) return result
      if (!completions.has(exec)) {
        completions.set(exec, { schema: 'ptc-capability-evidence/v1', planDigest: digest(state.snapshot),
          expanded: [...state.pendingExpanded ?? []], used: [...state.used.keys()] })
        state.pendingExpanded?.clear()
      }
      return { ...result, meta: { ...result.meta, [EVIDENCE_KEY]: completions.get(exec) } }
    },
    async postExecute(exec, result, next) {
      const policy = await previewPolicy(exec.agent)
      return policy ? policy.waterfall('tools/post-execute', exec, result, next) : next()
    },
    async dispatchLog(dispatch, next) {
      const policy = await previewPolicy(dispatch.exec.agent)
      return policy ? policy.waterfall('tools/ptc-dispatch-log', dispatch, next) : next()
    },
    status(agent, status) {
      const familyId = store?.family(agent)
      for (const member of ctx.agents?.list?.() ?? [agent]) {
        if (member !== agent && store?.family(member) !== familyId) continue
        const state = stateFor(member)
        if (state) void statisticsOperation(() => store?.status(member, state.snapshot,
          member === agent ? status : member.status))
      }
    },
    describe(agent) {
      const state = stateFor(agent)
      return state === undefined ? { configured: capabilityConfiguration(currentConfig), effective: null }
        : { configured: capabilityConfiguration(currentConfig), effective: state.snapshot.plan,
          publication: state.message === undefined ? 'not-required' : planCommitted(agent, state.message) ? 'accepted' : 'pending',
          sourceSettings: state.snapshot.sourceSettings ?? state.snapshot.settings,
          sessionOverrides: state.snapshot.sessionOverrides ?? {},
          pendingRefresh: digest(capabilityConfiguration(currentConfig)) !== digest(state.snapshot.sourceSettings ?? state.snapshot.settings) }
    },
    describeSessions() {
      return [...sessions].map(([sessionId, state]) => ({ sessionId, effective: state.snapshot.plan,
        configuration: savedConfiguration(state.snapshot.sourceSettings ?? state.snapshot.settings),
        sessionOverrides: state.snapshot.sessionOverrides ?? {},
        pendingRefresh: digest(capabilityConfiguration(currentConfig)) !== digest(state.snapshot.sourceSettings ?? state.snapshot.settings) }))
    },
    canRefresh,
    describeTargets() {
      return (ctx.agents?.list?.() ?? []).filter(canRefresh)
        .map(agent => ({ sessionId: String(agent.session.id ?? agent.id) }))
    },
    async describeSessionCatalog({ sessionId } = {}, signal) {
      signal?.throwIfAborted()
      if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('ptc-plus: select an active PTC session')
      const agent = (ctx.agents?.list?.() ?? []).find(candidate =>
        String(candidate.session.id ?? candidate.id) === sessionId && canRefresh(candidate))
      if (!agent) throw new TypeError('ptc-plus: select an active PTC session')
      const entries = await this.catalogFor(agent, signal)
      signal?.throwIfAborted()
      if (!(ctx.agents?.list?.() ?? []).includes(agent) || !canRefresh(agent)
        || String(agent.session.id ?? agent.id) !== sessionId) {
        throw new Error('ptc-plus: capability observation target is no longer available')
      }
      return entries
    },
    async observeAllocation({ sessionId, configuration } = {}, signal) {
      signal?.throwIfAborted()
      const agent = (ctx.agents?.list?.() ?? []).find(agent => String(agent.session.id ?? agent.id) === sessionId && canRefresh(agent))
      if (!agent) throw new TypeError('ptc-plus: select an active PTC session to observe its capability inventory and workspace statistics')
      const raw = configuration === undefined ? savedConfiguration(capabilityConfiguration(currentConfig)) : configuration
      const validated = capabilityProfileConfiguration(raw, { allowInvalidStatistics: true })
      const settings = capabilityConfiguration(validated)
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal, ptcPlusCapabilityObservation: true })
      const capabilities = await inventory(agent, assembly.sections, settings, signal)
      const coverage = Number.isSafeInteger(settings.statistics?.windowSize) && settings.statistics.windowSize > 0
        ? await store?.coverage(agent, capabilities, settings.statistics) ?? null : null
      signal?.throwIfAborted()
      if (!(ctx.agents?.list?.() ?? []).includes(agent) || !canRefresh(agent)) throw new Error('ptc-plus: capability observation target is no longer available')
      const plan = createCapabilityPlan({ ...settings, capabilities, coverage, navigationText: NAVIGATION,
        configurationRevision: digest(settings) })
      return { sessionId, workspace: agent.session.header.cwd, configuration: validated, plan, coverage,
        capabilities: capabilities.map(item => ({ id: item.id, revision: item.revision, category: item.category,
          contractBytes: Buffer.byteLength(item.contract, 'utf8') })) }
    },
    async describeCatalog(signal) {
      const available = new Map()
      for (const agent of ctx.agents?.list?.() ?? []) {
        signal?.throwIfAborted()
        const state = stateFor(agent)
        if (!state && !modelSchemasForAgent(agent).some(schema => schema.name === 'run_code')) continue
        const hostSections = ctx.systemPrompt?.assemble
          ? (await ctx.systemPrompt.assemble({ agent, scope: agent, signal, ptcPlusCapabilityObservation: true })).sections
          : state?.hostSections ?? []
        const presentation = new Map()
        for (const capability of await inventory(agent, hostSections, capabilityConfiguration(currentConfig), signal, presentation)) {
          const display = presentation.get(capability.id)
          const previous = available.get(capability.id)
          available.set(capability.id, { id: capability.id, category: capability.category, description: capability.description,
            ...display, ...(capability.mcpServer === undefined ? {} : { mcpServer: capability.mcpServer }), ...(previous && JSON.stringify(previous.source) !== JSON.stringify(display?.source)
              ? { source: { kind: 'unknown' }, mcpServer: undefined } : {}),
            ...(previous && (previous.invocationConflict || JSON.stringify(previous.invocation) !== JSON.stringify(display?.invocation))
              ? { invocation: undefined, invocationConflict: true } : {}) })
        }
      }
      signal?.throwIfAborted()
      return [...available.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    },
    async disposeAgent(agent) {
      const projection = skillProjections.get(agent)
      skillProjections.delete(agent)
      await projection?.scope.dispose()
      sessions.delete(String(agent?.session?.id ?? agent?.id))
    },
    async dispose() {
      for (const projection of skillProjections.values()) await projection.scope.dispose()
      skillProjections.clear()
      for (const policy of previewPolicies.values()) await policy.fiber.dispose()
      previewPolicies.clear()
      sessions.clear()
    },
  })
}
