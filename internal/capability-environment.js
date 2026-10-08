/** One session-owned capability view for presentation, discovery and preparation. */
import { createHash } from 'node:crypto'
import { jsonSchemaToTs, renderToolsSdk, ToolNotFoundError } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Context } from '@deepseek-ai/cordis'
import * as spillPolicy from '@deepseek-ai/dsh-spill-policy'
import { createCapabilityPlan } from './capability-plan.js'
import { PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
import { deepFreeze } from './record-utils.js'

export const CAPABILITY_PLAN_FORM = 'capability-plan'
export const CAPABILITY_EVIDENCE_KEY = 'dshPtcPlusCapabilities'
const EVIDENCE_KEY = CAPABILITY_EVIDENCE_KEY
const TRANSPORTS = new Set(['run_code', 'edit_run_code'])
const NAVIGATION = 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. Unlisted capabilities remain discoverable. Skill descriptions are summaries; load the body with tools.skill({name}) before following it.'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const messageText = message => message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
const sessionEvents = session => session?.snapshotEvents?.() ?? session?.events ?? []

export function capabilityConfiguration(config) {
  let statistics
  try { statistics = JSON.parse(config.capabilityStatistics) } catch { statistics = null }
  return {
    enabled: config.capabilityManagementEnabled === true,
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
  if (source.digest !== digest(snapshot) || snapshot?.schema !== 'ptc-capability-environment/v1'
    || !Array.isArray(snapshot.capabilities) || snapshot.plan?.schema !== 'ptc-capability-plan/v1') {
    throw new Error('damaged session capability plan')
  }
  const expected = createCapabilityPlan({ ...snapshot.settings, capabilities: snapshot.capabilities,
    coverage: snapshot.coverage, navigationText: NAVIGATION,
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
      plan.catalogText, plan.directoryText,
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
    || !['capability-plan', 'capability-navigation', 'capability-descriptions'].includes(source.form)
    || message.content?.length !== 1 || message.content[0]?.type !== 'text'
    || typeof message.content[0].text !== 'string' || !message.content[0].text) return undefined
  if (source.form === CAPABILITY_PLAN_FORM) {
    try { if (!sourcePlan(message, sessionId)) return undefined } catch { return undefined }
  }
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

/** One SDK snapshot owns a tool's signature, schemas and revision. */
function toolCapability(schema, sections) {
  return { id: `tools.${schema.name}`, category: 'tool',
    revision: digest(schema), schema,
    contract: `\`\`\`ts\n${schema.description ? `/** ${schema.description.replaceAll('*/', '* /')} */\n` : ''}tools[${JSON.stringify(schema.name)}](args: ${jsonSchemaToTs(schema.parameters)}): Promise<${jsonSchemaToTs(schema.output)}>\n\`\`\``,
    dependencies: sections.filter(section => section.name === `tool:${schema.name}`
      || (section.name?.startsWith('mcp:') && schema.name.startsWith(`mcp__${section.name.slice(4)}__`)))
      .map(section => ({ id: section.name, text: section.text })),
    navigation: schema.description ?? schema.name }
}

/** Derived metadata only: invocation continues through the request's original host functions. */
export function createCapabilityEnvironment({ ctx, config, toolSchemasForAgent, store }) {
  let currentConfig = config
  const sessions = new Map()
  const operations = new WeakMap()
  const completions = new WeakMap()
  const admitted = new WeakSet()
  const skillProjections = new Map()
  const previewPolicies = new Map()
  const report = error => ctx.logger?.warn?.('ptc-plus: capability statistics unavailable', error)
  const statisticsOperation = operation => Promise.resolve().then(operation).catch(report)

  function readSkills(context) {
    return typeof context.get === 'function' ? context.get('skills') : context.skills
  }

  async function observeSkills(agent) {
    if (!readSkills(ctx)?.snapshot) return []
    const projection = skillProjections.get(agent)
    // The original providers own availability; absence markers only project selections.
    if (projection) { projection.inventory = true; projection.control.invalidate() }
    let observed
    try { observed = await readSkills(ctx).snapshot({ cwd: agent.session.header.cwd, scope: agent, signal: agent.signal }) }
    finally { if (projection) { projection.inventory = false; projection.control.invalidate() } }
    if (!observed.complete) throw new Error('ptc-plus: the Skill catalog is incomplete; cannot select a new capability environment')
    return observed.skills.filter(skill => isModelInvocable(skill) || isUserInvocable(skill))
  }

  async function qualifySkills(agent, state) {
    if (state.snapshot.plan.enabled) state.liveSkills = new Set((await observeSkills(agent)).map(skill => `skills.${skill.name}`))
    return state
  }

  async function inventory(agent, sections = [], settings) {
    const schemas = toolSchemasForAgent(agent).filter(schema => !TRANSPORTS.has(schema.name))
    const capabilities = schemas.map(schema => toolCapability(schema, sections))
    if (readSkills(ctx)?.snapshot !== undefined) {
      for (const skill of await observeSkills(agent)) {
        const summary = { name: skill.name, provider: skill.provider, source: skill.source,
          description: skill.description, invocation: skill.invocation }
        capabilities.push({ id: `skills.${skill.name}`, category: 'skill', revision: digest(summary),
          contract: `${skill.description}\nLoad instructions: await tools.skill(${JSON.stringify({ name: skill.name })})`,
          navigation: skill.description, selector: { name: skill.name }, invocation: skill.invocation })
      }
    }
    const servers = resourceServers(sections)
    for (const server of servers) capabilities.push({ id: `mcp.${server}`, category: 'resource',
      revision: digest({ server, instructions: sections.find(section => section.name === `mcp:${server}`)?.text ?? '' }),
      dependencies: sections.filter(section => section.name === `mcp:${server}`).map(section => ({ id: section.name, text: section.text })), contract: `MCP resource server ${JSON.stringify(server)}. Use tools.list_mcp_resources({server}), tools.list_mcp_resource_templates({server}), and tools.read_mcp_resource({server,uri}); use the listed URI or expand a listed template.`,
      navigation: `MCP resources and templates from ${server}`, selector: { server } })
    return capabilities.filter(item => {
      if (item.category !== 'tool') return true
      const category = item.schema.name === 'skill' ? 'skill'
        : ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(item.schema.name) ? 'resource' : undefined
      return category === undefined || capabilities.some(member => member.category === category
        && settings?.manual.overrides[member.id] !== 'closed')
    })
  }

  function stateFor(agent) { return sessions.get(String(agent?.session?.id ?? agent?.id)) }
  function planCommitted(agent, message) {
    return message !== undefined && sessionEvents(agent.session).some(event =>
      event.type === 'user/message' && event.data?.id === message.id)
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
    if (!state?.snapshot.plan.enabled) return true
    if (!['full', 'on-demand'].includes(selection(state, id))) return false
    const capability = state.snapshot.capabilities.find(item => item.id === id)
    if (capability?.category === 'skill') return state.liveSkills.has(id)
    return capability?.category !== 'resource'
      || resourceServers(state.hostSections).includes(capability.selector.server)
  }
  function sharedMembers(state, name) {
    const category = name === 'skill' ? 'skill'
      : ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name) ? 'resource' : undefined
    return category === undefined ? undefined : state.snapshot.capabilities
      .filter(item => item.category === category && supplied(state, item.id))
      .map(item => item.selector[category === 'skill' ? 'name' : 'server'])
  }
  function memberSupplied(state, name) {
    return TRANSPORTS.has(name) || (supplied(state, `tools.${name}`) && sharedMembers(state, name)?.length !== 0)
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

  function installSkillProjection(agent, state) {
    let projection = skillProjections.get(agent)
    if (!projection && state.snapshot.plan.enabled && readSkills(ctx)?.registerProvider) {
      const scope = createScope(ctx, agent)
      projection = { scope, state, inventory: false }
      skillProjections.set(agent, projection)
      scope.ctx.effect(() => readSkills(scope.ctx).registerProvider(control => {
        projection.control = control
        const name = 'ptc-plus-session-capabilities'
        return { name,
          async list(options) {
            if (options.scope !== agent || projection.inventory || !projection.state.snapshot.plan.enabled) return []
            return projection.state.snapshot.capabilities.filter(item => item.category === 'skill'
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
    }
    if (projection) { projection.state = state; projection.control.invalidate() }
  }

  async function previewPolicy(agent) {
    const state = stateFor(agent)
    if (!state?.snapshot.plan.enabled) return undefined
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

  async function prepare(agent, sections, force = false, signal = agent?.signal) {
    signal?.throwIfAborted()
    if (agent?.session === undefined) {
      if (!capabilityConfiguration(currentConfig).enabled) return undefined
      throw new TypeError('ptc-plus: capability management requires an agent Session')
    }
    const id = String(agent.session.id ?? agent.id)
    if (!force && sessions.has(id)) {
      const state = sessions.get(id)
      if (sections !== undefined) state.hostSections = sections
      return qualifySkills(agent, state)
    }
    const pending = operations.get(agent)
    if (pending !== undefined && !force) return pending
    const task = (async () => {
      if (!force) {
        const recorded = sessionEvents(agent.session).filter(event => event.type === 'user/message'
          && event.data?.source?.kind === PTC_MESSAGE_SOURCE_KIND
          && event.data.source.form === CAPABILITY_PLAN_FORM && event.data.source.sessionId === id).at(-1)?.data
        if (recorded !== undefined) {
          let snapshot
          try { snapshot = sourcePlan(recorded, id) } catch (error) {
            ctx.logger?.warn?.(`ptc-plus: ${error.message}; continuing with the host environment until /capabilities refresh`)
            const settings = { ...capabilityConfiguration(currentConfig), enabled: false }
            const plan = createCapabilityPlan({ ...settings, configurationRevision: digest(settings), capabilities: [], navigationText: NAVIGATION })
            snapshot = deepFreeze({ schema: 'ptc-capability-environment/v1', settings, capabilities: [], plan })
            const notice = planMessage(snapshot, id, true)
            publishPlan(agent, notice, signal)
            const state = { snapshot, message: notice, hostSections: sections ?? [], expanded: new Set(), used: new Map() }
            sessions.set(id, state)
            installSkillProjection(agent, state)
            return state
          }
          const restored = { snapshot, message: snapshot.plan.enabled || recorded.source.refresh ? recorded : undefined, hostSections: sections ?? [], expanded: new Set(), used: new Map() }
          await qualifySkills(agent, restored)
          signal?.throwIfAborted()
          restoreEvidence(agent, restored)
          sessions.set(id, restored)
          installSkillProjection(agent, restored)
          return restored
        }
      }
      const historical = !force && sessionEvents(agent.session).some(event =>
        event.type === 'assistant/message' || event.type === 'tool/result')
      const settings = { ...capabilityConfiguration(currentConfig), ...(historical ? { enabled: false } : {}) }
      const capabilities = settings.enabled ? await inventory(agent, sections ?? [], settings) : []
      const coverage = settings.statistics?.enabled === true ? await store?.coverage(agent, capabilities, settings.statistics) : undefined
      const plan = createCapabilityPlan({ ...settings, configurationRevision: digest(settings),
        capabilities, coverage, navigationText: NAVIGATION })
      const snapshot = deepFreeze({ schema: 'ptc-capability-environment/v1', settings, capabilities, ...(coverage === undefined ? {} : { coverage }), plan })
      const message = planMessage(snapshot, id, force)
      agent.signal?.throwIfAborted?.()
      signal?.throwIfAborted()
      // Initialized sessions commit a refresh and its notification atomically.
      // First-step proposals are accepted through the Host's pre-step messages.
      if (settings.enabled || force) {
        publishPlan(agent, message, signal)
      }
      const state = { snapshot, message: !settings.enabled && !force ? undefined : message,
        hostSections: sections ?? [], expanded: new Set(), used: new Map(),
        liveSkills: new Set(capabilities.filter(item => item.category === 'skill').map(item => item.id)) }
      restoreEvidence(agent, state)
      sessions.set(id, state)
      installSkillProjection(agent, state)
      return state
    })()
    operations.set(agent, task)
    try { return await task } finally { if (operations.get(agent) === task) operations.delete(agent) }
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
    async refresh(agent, sections, signal) {
      signal?.throwIfAborted()
      if (typeof agent.runMaintenance !== 'function') throw new Error('ptc-plus: capability refresh requires the public agent maintenance boundary')
      return agent.runMaintenance(async maintenanceSignal => {
        const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: maintenanceSignal })
        signal?.throwIfAborted()
        maintenanceSignal.throwIfAborted()
        const preparationSignal = AbortSignal.any([signal, maintenanceSignal, agent.signal].filter(Boolean))
        return prepare(agent, stateFor(agent)?.hostSections ?? assembly.sections, true, preparationSignal)
      })
    },
    projectSections(agent, sections) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return sections
      const ownedSections = new Set(state.snapshot.capabilities.flatMap(item => item.dependencies ?? []).map(item => item.id))
      return sections.filter(section => section.name !== 'mcp-resource-servers' && !ownedSections.has(section.name)
        && !(section.name?.startsWith('tool:') && !TRANSPORTS.has(section.name.slice(5))
          && !memberSupplied(state, section.name.slice(5))))
    },
    sdk(agent, nativeSdk) { return stateFor(agent)?.snapshot.plan.enabled ? renderToolsSdk([]) : nativeSdk },
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
          .map(item => ({ name: item.id.slice(item.id.indexOf('.') + 1), description: item.navigation,
            contract: item.contract, dependencies: item.dependencies ?? [], revision: item.revision, parameters: {}, returns: {},
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
      if (!stateFor(payload.agent) && ctx.systemPrompt?.assemble) {
        await ctx.systemPrompt.assemble({ agent: payload.agent, scope: payload.agent, signal: payload.signal })
      }
      const prepared = stateFor(payload.agent)
      if (prepared) await qualifySkills(payload.agent, prepared)
      const decision = await next()
      const state = stateFor(payload.agent)
      if (decision.kind !== 'enter' || !state || payload.signal?.aborted) return decision
      await statisticsOperation(() => store?.available(payload.agent, state.snapshot))
      restoreEvidence(payload.agent, state)
      const visible = payload.agent.session.deriveMessages?.() ?? []
      const messages = state.snapshot.plan.enabled ? decision.messages.filter(message =>
        message.source?.kind !== 'skill-catalog'
        && !(message.source?.kind === 'skill-invocation' && !supplied(state, `skills.${message.source.name}`))) : decision.messages
      // An uncommitted proposal enters once through Host acceptance. A committed
      // plan is already in history; its ancestry cannot resurrect compacted text.
      const planVisible = state.message && visible.some(message => message.id === state.message.id)
      const additions = state.message && !planCommitted(payload.agent, state.message)
        && !messages.some(message => message.id === state.message.id) ? [state.message] : []
      const planSupplied = planVisible || [...messages, ...additions].some(message => message.id === state.message?.id)
      if (state.snapshot.plan.enabled) {
        for (const message of messages) {
          if (message.source?.kind === 'skill-invocation' && supplied(state, `skills.${message.source.name}`)) {
            void statisticsOperation(() => store?.used(payload.agent, state.snapshot,
              `skills.${message.source.name}`, 'skill-body-accepted', 'complete'))
          }
        }
        const expandedVisible = new Set([...visible, ...messages].flatMap(message => message.source?.form === 'capability-descriptions'
          ? message.source.entries ?? [] : state.visibleExpansions?.get(message.id) ?? []))
        if ([...visible, ...messages, ...additions].some(message => message.id === state.message?.id)) {
          for (const entry of state.snapshot.plan.entries.filter(entry => entry.selection === 'full')) {
            expandedVisible.add(entry.id)
            if (!state.expanded.has(entry.id)) state.pendingExpanded.add(entry.id)
            state.expanded.add(entry.id)
          }
        }
        if (!planSupplied && ![...visible, ...messages].some(message => message.source?.form === 'capability-navigation')) {
          additions.push(createUserMessage({ source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'capability-navigation' },
            content: [{ type: 'text', text: state.snapshot.plan.directoryText || NAVIGATION }] }))
        }
        let body = ''
        const restored = []
        const dependencies = new Set()
        const currentSchemas = new Map(toolSchemasForAgent(payload.agent).map(schema => [`tools.${schema.name}`, digest(schema)]))
        for (const id of [...state.used.keys()].reverse()) {
          const capability = state.snapshot.capabilities.find(item => item.id === id)
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
      return { ...decision, messages: [...messages, ...additions] }
    },
    admitted(exec) {
      // Host tokens correlate immutable call identity through mutable wrappers.
      if (exec.token && stateFor(exec.agent)?.snapshot.plan.enabled) admitted.add(exec.token)
    },
    dispatched(exec, result) {
      const state = stateFor(exec.agent)
      if (!exec.token || !admitted.has(exec.token) || !state?.snapshot.plan.enabled || !supplied(state, `tools.${exec.name}`)
        || result?.error?.info?.code === 'ABORTED_BEFORE_DISPATCH' || result?.error?.info?.code === 'UNKNOWN_TOOL') return
      admitted.delete(exec.token)
      state.used.delete(`tools.${exec.name}`)
      state.used.set(`tools.${exec.name}`, true)
      void statisticsOperation(() => store?.used(exec.agent, state.snapshot, `tools.${exec.name}`, 'host-execution-result', result?.error?.info?.code === 'ABORTED' ? 'cancelled' : result?.isError ? 'failed' : 'complete'))
      if (exec.name === 'skill' && !result?.isError && typeof exec.arguments?.name === 'string') {
        void statisticsOperation(() => store?.used(exec.agent, state.snapshot, `skills.${exec.arguments.name}`, 'skill-body-accepted', 'complete'))
      }
      if (exec.name === 'read_mcp_resource' && !result?.isError && typeof exec.arguments?.server === 'string') {
        const id = `mcp.${exec.arguments.server}`
        state.used.delete(id)
        state.used.set(id, true)
        void statisticsOperation(() => store?.used(exec.agent, state.snapshot, `mcp.${exec.arguments.server}`, 'resource-access', 'complete'))
      }
    },
    toolMetadata(agent, metadata, schemas = toolSchemasForAgent(agent)) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return metadata
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
      if (!state?.snapshot.plan.enabled) return result
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
        if (state?.snapshot.plan.enabled) void statisticsOperation(() => store?.status(member, state.snapshot,
          member === agent ? status : member.status))
      }
    },
    describe(agent) {
      const state = stateFor(agent)
      return state === undefined ? { configured: capabilityConfiguration(currentConfig), effective: null }
        : { configured: capabilityConfiguration(currentConfig), effective: state.snapshot.plan,
          publication: state.message === undefined ? 'not-required' : planCommitted(agent, state.message) ? 'accepted' : 'pending',
          pendingRefresh: digest(capabilityConfiguration(currentConfig)) !== digest(state.snapshot.settings) }
    },
    describeSessions() {
      return [...sessions].map(([sessionId, state]) => ({ sessionId, effective: state.snapshot.plan,
        pendingRefresh: digest(capabilityConfiguration(currentConfig)) !== digest(state.snapshot.settings) }))
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
