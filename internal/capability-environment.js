import { capabilityRule, capabilityPolicyForConfig, capabilityPolicyFromRecord, changeCapabilityRule, effectiveCapabilitySettings, CAPABILITY_DISCLOSURES, CAPABILITY_INVENTORY_CATEGORIES } from './capability-policy.js'
/** One session-owned capability view for presentation, discovery and preparation. */
import { createHash } from 'node:crypto'
import { jsonSchemaToTs, renderToolsSdk, ToolNotFoundError } from './host-tool-sdk.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Context } from '@deepseek-ai/cordis'
import * as spillPolicy from '@deepseek-ai/dsh-spill-policy'
import { readSessionLog } from './session-events.js'
import { readCapabilityCommandReceipt } from './capability-command-receipt.js'
import { createCapabilityPlan } from './capability-plan.js'
import { bindingAdoptionOf } from './binding-adoption.js'
import { bindingModelPreferences } from './user-binding-model-context.js'
import { CAPABILITY_ENTRY_ID, capabilityChoiceOf, capabilityRuleOfSelection, capabilitySelectionMessage, capabilitySelectionOf, CAPABILITY_SELECTION_SCHEMA } from './capability-selection.js'
import { CAPABILITY_PLAN_FORM, isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
import { deepFreeze } from './record-utils.js'
import { capabilityProfileConfiguration } from './runtime-config.js'
import { readRuntimeAvailability, readRuntimeMessage } from './runtime-messages.js'
import { PLAN_CATEGORY_LINES, PLAN_NAVIGATION, PLAN_OVERAGE, PLAN_OVERAGE_HOLE,
  PROMPT_SLOT_IDS, planCategorySlotId, resolvePromptText, resolvePromptTextConfig } from './prompt-text.js'

export { CAPABILITY_PLAN_FORM }
export const CAPABILITY_EVIDENCE_KEY = 'dshPtcPlusCapabilities'
const EVIDENCE_KEY = CAPABILITY_EVIDENCE_KEY
const DIRECT_TRANSPORT = 'run_code'
const EDIT_TRANSPORT = 'edit_run_code'
const TRANSPORTS = new Set([DIRECT_TRANSPORT, EDIT_TRANSPORT])
const LEGACY_NAVIGATION = 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. Unlisted capabilities remain discoverable. Skill descriptions are summaries; load the body with tools.skill({name}) before following it.'
const NAVIGATION = 'Use capabilities.search({query}) to retrieve complete tool, Skill and MCP contracts. Unlisted capabilities remain discoverable. Skill descriptions are summaries; follow each Skill\'s declared invocation eligibility to load its body before following it.'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const messageText = message => message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
const byteLength = value => Buffer.byteLength(value, 'utf8')

/**
 * Delivered plan-channel text, resolved from the prompt-text document.
 *
 * The planner must receive the same words the panel shows, so the navigation
 * sentence, the five category lines and the overage template are read once here
 * rather than defaulting inside the planner. `isDefault` decides whether the
 * snapshot can keep a historical generation: only an edited channel needs the v5
 * record, so an untouched configuration stays byte-identical to before.
 */
function planChannelText(config) {
  const prompt = resolvePromptTextConfig(config)
  const navigationSentence = prompt.text(PROMPT_SLOT_IDS.planNavigationSentence)
  const overageSentence = prompt.text(PROMPT_SLOT_IDS.planOverageSentence)
  const categoryLines = Object.keys(PLAN_CATEGORY_LINES)
    .map(category => [category, prompt.text(planCategorySlotId(category))])
  const isDefault = navigationSentence === PLAN_NAVIGATION
    && overageSentence === PLAN_OVERAGE
    && categoryLines.every(([category, line]) => line === PLAN_CATEGORY_LINES[category])
  return { navigationSentence, overageSentence, categoryLines, isDefault }
}

/**
 * Directory budget for the delivered guidance.
 *
 * Editing a navigation sentence changes how many bytes the directory spends before
 * any capability entry, so the budget moves with the text: an unchanged document
 * therefore keeps today's budget exactly, and a longer sentence does not silently
 * shrink the catalog.
 */
const planDirectoryBudget = (configured, navigationSentence) => (
  configured + byteLength(navigationSentence) - byteLength(PLAN_NAVIGATION))

/**
 * Recorded plan text; a v5 snapshot carries the words and the budget it was
 * composed from.
 *
 * The budget belongs in the record because it depends on the navigation sentence:
 * replaying it from the current default literal would let a later edit of that
 * literal silently change what an old snapshot replays to.
 */
const planPromptText = (channel, directoryBudgetBytes) => ({ promptText: {
  navigationSentence: channel.navigationSentence,
  categoryLines: channel.categoryLines.map(([category, line]) => [category, line]),
  overageSentence: channel.overageSentence,
  directoryBudgetBytes,
} })

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
    ...(config.capabilityContextEnabled === undefined ? {} : { contextEnabled: config.capabilityContextEnabled }),
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
  const generation = ['ptc-capability-environment/v1', 'ptc-capability-environment/v2', 'ptc-capability-environment/v3',
    'ptc-capability-environment/v4', 'ptc-capability-environment/v5'].indexOf(snapshot?.schema)
  // A historical generation planned with exactly one planner generation for the settings
  // shape its schema records: a context generation (v4) always plans v3, a policy
  // generation (v3) plans v2, and v1/v2 planned v1. Generation 5 records the plan words
  // instead, and its plan schema follows from the recorded settings: the recomputation
  // below proves the whole plan, which makes a separate schema guess both unnecessary and
  // wrong (a v5 snapshot may carry context settings and therefore a v3 plan, or a closed
  // plan and therefore a v2 one).
  const expectedPlanSchema = generation >= 3 ? 'ptc-capability-plan/v3'
    : generation === 2 ? 'ptc-capability-plan/v2' : 'ptc-capability-plan/v1'
  if (source.digest !== digest(snapshot) || generation < 0
    || !Array.isArray(snapshot.capabilities)
    || (generation < 4 && snapshot.plan?.schema !== expectedPlanSchema)) {
    throw new Error('damaged session capability plan')
  }
  if (generation >= 1) {
    let merged
    try {
      if (snapshot.sessionOverrides === undefined) throw new TypeError('missing session choices')
      merged = sessionCapabilitySettings(snapshot.sourceSettings, snapshot.sessionOverrides)
    } catch (cause) {
      throw new Error('damaged session capability choices', { cause })
    }
    if (JSON.stringify(merged) !== JSON.stringify(snapshot.settings)) throw new Error('inconsistent session capability choices')
  }
  // v4 implies a context generation; v5 only says the plan words were edited, so it
  // may or may not carry context settings.
  const contextGeneration = generation === 3 ? typeof snapshot.settings.contextEnabled === 'boolean'
    : generation === 4 ? true : snapshot.settings.contextEnabled === undefined
  if (!contextGeneration) {
    throw new Error('inconsistent capability context generation')
  }
  if (generation === 2 || generation >= 3 && snapshot.settings.policy !== undefined) {
    if (!snapshot.settings.policy || typeof snapshot.settings.recoveryEnabled !== 'boolean'
      || typeof snapshot.settings.previewEnabled !== 'boolean') throw new Error('damaged capability policy settings')
  } else if (snapshot.settings.policy !== undefined) throw new Error('inconsistent historical capability generation')
  // A v5 snapshot carries the plan words it was composed from; a historical
  // generation may only claim the registry defaults it was delivered with.
  const recorded = generation === 4 ? planRecord(snapshot) : undefined
  if (recorded === undefined) {
    if (snapshot.promptText !== undefined) throw new Error('inconsistent capability plan text generation')
    if (snapshot.navigationText !== undefined && snapshot.navigationText !== NAVIGATION) throw new Error('unknown capability navigation contract')
  } else if (snapshot.navigationText !== recorded.navigationSentence) {
    throw new Error('damaged capability plan text')
  }
  const expected = createCapabilityPlan({ ...snapshot.settings, capabilities: snapshot.capabilities,
    coverage: snapshot.coverage, navigationText: snapshot.navigationText ?? LEGACY_NAVIGATION,
    ...(recorded === undefined ? {} : {
      categories: recorded.categoryLines,
      directoryBudgetBytes: recorded.directoryBudgetBytes,
    }),
    configurationRevision: digest(snapshot.settings) })
  if ((generation >= 4 && snapshot.plan?.schema !== expected.schema)
    || JSON.stringify(expected) !== JSON.stringify(snapshot.plan)
    || messageText(message) !== messageText(planMessage(snapshot, id, source.refresh === true))) {
    throw new Error('inconsistent session capability plan')
  }
  return deepFreeze(structuredClone(snapshot))
}

/**
 * Validated plan words of a v5 snapshot.
 *
 * Returns `undefined` only when the snapshot carries no record at all; a record that
 * exists but cannot be replayed throws, because a half-recorded plan text would let
 * a later replay silently deliver different words than the ones recorded here.
 */
function planRecord(snapshot) {
  const record = snapshot.promptText
  if (record === undefined || record === null) return undefined
  const categories = record.categoryLines
  const known = Object.keys(PLAN_CATEGORY_LINES)
  if (typeof record.navigationSentence !== 'string' || record.navigationSentence.length === 0
    || typeof record.overageSentence !== 'string' || record.overageSentence.split(PLAN_OVERAGE_HOLE).length !== 2
    || !Number.isSafeInteger(record.directoryBudgetBytes) || record.directoryBudgetBytes < 0
    || !Array.isArray(categories) || categories.length !== known.length
    || categories.some(pair => !Array.isArray(pair) || pair.length !== 2
      || !known.includes(pair[0]) || typeof pair[1] !== 'string' || pair[1].length === 0)
    || new Set(categories.map(pair => pair[0])).size !== categories.length) {
    throw new Error('damaged capability plan text')
  }
  return { navigationSentence: record.navigationSentence, overageSentence: record.overageSentence,
    directoryBudgetBytes: record.directoryBudgetBytes,
    categoryLines: categories.map(([category, line]) => [category, line]) }
}

function planMessage(snapshot, id, refresh = false) {
  const plan = snapshot.plan
  const overage = snapshot.promptText?.overageSentence ?? PLAN_OVERAGE
  const text = plan.enabled
    ? ['PTC Plus session capability environment' + (refresh ? ' refreshed; replaces the preceding capability plan.' : ':'),
      plan.directoryText, plan.catalogText,
      ...(plan.budgets.overageBytes ? [overage.replace(PLAN_OVERAGE_HOLE, String(plan.budgets.overageBytes))] : [])]
      .filter(Boolean).join('\n\n')
    : snapshot.settings.contextEnabled === false
      ? 'PTC Plus capability and context settings are paused for this session. Use the host-provided capability contracts and result presentation.'
      : 'PTC Plus capability management is off for this session. Use the host-provided capability contracts.'
  return createUserMessage({ source: { kind: PTC_MESSAGE_SOURCE_KIND, form: CAPABILITY_PLAN_FORM,
    sessionId: id, refresh, digest: digest(snapshot), snapshot }, content: [{ type: 'text', text }] })
}

/**
 * Delivered plan text for a snapshot, without the message envelope.
 *
 * Replay and the surface gate both need the bytes the model reads; keeping the
 * composition private to this module means a caller cannot assemble a different
 * plan and call it the delivered one.
 */
export function capabilityPlanText(snapshot, id, refresh = false) {
  return planMessage(snapshot, id, refresh).content[0].text
}

/**
 * Delivered plan message for a snapshot, envelope included.
 *
 * What this composition can claim is consistency, not provenance: the settings merge
 * is a fixed point of the recorded settings, the recorded plan deep-equals a
 * recomputation from them, the delivered text equals a recomposition of that plan and
 * the snapshots it reads are deeply frozen. It recomputes the digest, so it cannot
 * attest that these bytes are the ones a session log once carried.
 */
export function capabilityPlanMessage(snapshot, id, refresh = false) {
  return planMessage(snapshot, id, refresh)
}

/**
 * Delivered plan text of a plan message, after the replay contract accepted it.
 *
 * The reader above stays a recognizer and hands out no composition state; a caller
 * that needs the bytes the model read asks this projection instead. An unreplayable
 * message throws, so a lane that compares bytes cannot pass by receiving `undefined`.
 */
export function capabilityPlanTextFromMessage(message, sessionId) {
  if (message?.source?.form !== CAPABILITY_PLAN_FORM) return undefined
  sourcePlan(message, sessionId)
  return message.content[0].text
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
  settings = effectiveCapabilitySettings(settings)
  return settings.enabled || settings.policy && (settings.statistics?.enabled === true || settings.recoveryEnabled)
}

/**
 * The one-selection spelling of a recorded choice, or `undefined` when the
 * record states a dimension that spelling cannot carry.
 *
 * A record states dimensions, a saved decision states one selection, and the two
 * vocabularies meet exactly at the shapes `capabilityRuleOfSelection` produces
 * for a whole selection. Anything narrower (a single dimension) stays a dimension
 * rule, because writing it as a selection would also decide the other dimension.
 */
function compactSelection(choice) {
  const dimensions = Object.keys(choice).sort().join(',')
  return dimensions === 'availability' && choice.availability === 'closed' ? 'closed'
    : dimensions === 'availability,disclosure' && choice.availability === 'enabled'
      && ['full', 'on-demand'].includes(choice.disclosure) ? choice.disclosure
      : dimensions === 'availability,disclosure' && choice.availability === 'automatic'
        && choice.disclosure === 'automatic' ? 'automatic' : undefined
}

/**
 * This session's recorded choices, in the vocabulary a composition reads.
 *
 * The record is the owner: a composition that needs this session's choices takes
 * them from here and from nowhere else. `state.sessionOverrides` and a previous
 * composition are not inputs — they are what an earlier composition made of this
 * same record, so reading them back would let a stale composition outvote a
 * decision the log already holds.
 */
function sessionOverridesOf(statement) {
  if (statement?.state !== 'decided') return {}
  const overrides = {}
  for (const [id, choice] of Object.entries(statement.selection.choices)) {
    overrides[id] = compactSelection(choice) ?? { ...choice }
  }
  return overrides
}

/** Two override maps state the same choices when they state the same decisions. */
function sameChoices(left, right) {
  // One decision has two spellings: the whole selection a saved configuration states and
  // the dimensions a record or a policy rule states. A plan delivered by an earlier
  // release may hold either, so the comparison asks what each map decides — through the
  // one mapping that owns that equivalence — rather than how this build spells it.
  const canonical = overrides => JSON.stringify(Object.keys(overrides ?? {}).sort().map(id =>
    [id, Object.entries(capabilityRuleOfSelection(overrides[id]))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)]))
  return canonical(left) === canonical(right)
}

function savedConfiguration(settings) {
  return { capabilityManagementEnabled: settings.enabled,
    ...(settings.contextEnabled === undefined ? {} : { capabilityContextEnabled: settings.contextEnabled }),
    capabilityBaseline: JSON.stringify(settings.manual.baseline), capabilityOverrides: JSON.stringify(settings.manual.overrides),
    capabilityStatistics: JSON.stringify(settings.statistics), capabilityBudgetBytes: settings.budgetBytes,
    capabilityDirectoryBytes: settings.directoryBudgetBytes, capabilityRecoveryBytes: settings.recoveryBytes,
    modelPreviewTokens: settings.previewTokens,
    ...(settings.policy ? { capabilityPolicy: JSON.stringify(settings.policy), capabilityRecoveryEnabled: settings.recoveryEnabled,
      modelPreviewEnabled: settings.previewEnabled } : {}) }
}

/** One SDK snapshot owns a tool's signature, schemas and revision. */
// Mirrors the Host SDK generator's member rule: bare name for a valid
// identifier, quoted index only for an exotic name, so a contract never
// disagrees with the declaration the model programs against.
const SDK_MEMBER_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
function sdkMemberCall(name, callArguments) {
  return SDK_MEMBER_IDENTIFIER.test(name)
    ? `tools.${name}(${callArguments})`
    : `tools[${JSON.stringify(name)}](${callArguments})`
}

function toolCapability(schema, sections) {
  return { id: `tools.${schema.name}`, category: CAPABILITY_INVENTORY_CATEGORIES.tool,
    revision: digest(schema), schema,
    contract: `\`\`\`ts\n${schema.description ? `/** ${schema.description.replaceAll('*/', '* /')} */\n` : ''}${sdkMemberCall(schema.name, `args: ${jsonSchemaToTs(schema.parameters)}`)}: Promise<${jsonSchemaToTs(schema.output)}>\n\`\`\``,
    dependencies: sectionDependencies(sections.filter(section => section.name === `tool:${schema.name}`
      || (section.name?.startsWith('mcp:') && schema.name.startsWith(`mcp__${section.name.slice(4)}__`)))),
    description: schema.description ?? '' }
}

function skillInvocationContract(name, description, invocation) {
  const loading = invocation.modelInvocable
    ? `Load instructions: await tools.skill(${JSON.stringify({ name })})`
    : invocation.userInvocable ? `User-only Skill: the user can invoke /${name}. The model cannot load this Skill with tools.skill.`
      : 'No invocation path is available in this session.'
  return `${description}\nInvocation: modelInvocable=${invocation.modelInvocable}, userInvocable=${invocation.userInvocable}.\n${loading}`
}

function skillCapability(skill, modelLoaderAvailable = true) {
  const nativeInvocation = { modelInvocable: isModelInvocable(skill), userInvocable: isUserInvocable(skill) }
  const invocation = { ...nativeInvocation, modelInvocable: nativeInvocation.modelInvocable && modelLoaderAvailable }
  const summary = { name: skill.name, provider: skill.provider, source: skill.source,
    description: skill.description, invocation }
  return { id: `skills.${skill.name}`, category: CAPABILITY_INVENTORY_CATEGORIES.skill, revision: digest(summary),
    contract: skillInvocationContract(skill.name, skill.description, invocation),
    description: skill.description, selector: { name: skill.name }, invocation,
    ...(!modelLoaderAvailable ? { nativeInvocation, effectiveAvailability: invocation.userInvocable ? 'enabled' : 'closed' } : {}) }
}

/** Retain proved Skill identity while the live loader still owns model invocation. */
function retainedSkillCapability(capability, modelLoaderAvailable) {
  const nativeInvocation = capability.nativeInvocation ?? capability.invocation
  const invocation = { ...nativeInvocation, modelInvocable: nativeInvocation.modelInvocable && modelLoaderAvailable }
  if (JSON.stringify(invocation) === JSON.stringify(capability.invocation)) return capability
  const { nativeInvocation: _nativeInvocation, effectiveAvailability: _availability, ...retained } = capability
  return { ...retained, invocation, revision: digest({ revision: capability.revision, invocation }),
    contract: skillInvocationContract(capability.selector.name, capability.description, invocation),
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

/**
 * Derived metadata only: invocation continues through the request's original host functions.
 *
 * `readUserBindings` is the plugin's own store read (`list()`), supplied because
 * that store belongs to the user-bindings owner: the capability read reports what
 * the global catalog supplies without owning or duplicating it.
 */
export function createCapabilityEnvironment({ ctx, config, toolSchemasForAgent, store, sessionHistoryForAgent, readUserBindings }) {
  let currentConfig = config
  const sessions = new Map()
  const histories = new WeakMap()
  const sessionEvents = session => Array.isArray(session?.events) ? session.events : histories.get(session) ?? []
  const sessionQueryService = () => typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery
  async function observeHistory(agent, signal) {
    const query = sessionQueryService()
    const log = sessionHistoryForAgent ? await sessionHistoryForAgent(agent, signal) : await readSessionLog(agent.session, query, signal)
    const events = log?.events ?? []
    histories.set(agent.session, events)
    return events
  }
  function recordedPlan(history, id) {
    // A routine provider release (`unloaded`) is an infrastructure fact, not a
    // user decision: the session's frozen plan stays its restored baseline.
    // Only an explicit disablement lets a resumed session recompose from the
    // current saved configuration.
    const withdrawn = history.findLastIndex(event => event.type === 'user/message'
      && readRuntimeAvailability(event.data) === 'disabled')
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

  /**
   * The Skill catalogue one supply view answers: a scope selects the viewing
   * agent's layers, a directory selects workspace-sensitive Skills. A view with no
   * scope is the Host's own declaration; a session whose scope the Host no longer
   * holds reads the face its record froze instead, because the layers that scope
   * resolved cannot be recovered without it.
   */
  async function observeSkillsAt(target, signal) {
    if (!readSkills(ctx)?.snapshot) return { skills: [], complete: true }
    // Read the original provider layers through a short-lived child scope. The
    // session projection is exact-scope-only, so catalogue reads cannot toggle
    // a global inventory flag and create a window where closed Skills load.
    const child = {}
    const isolated = target.scope !== undefined && typeof ctx.plugin === 'function'
      ? createScope(ctx, child, { parent: target.scope }) : null
    const view = isolated ? child : target.scope
    let observed
    try {
      const combined = [signal, target.signal].filter(Boolean)
      observed = await readSkills(ctx).snapshot({ cwd: target.cwd, scope: view,
        signal: combined.length > 1 ? AbortSignal.any(combined) : combined[0] })
    } finally { await isolated?.dispose() }
    return { ...observed, skills: observed.skills.filter(skill => isModelInvocable(skill) || isUserInvocable(skill)) }
  }

  function observeSkills(agent, signal) {
    return observeSkillsAt({ scope: agent, cwd: currentDirectory(agent), signal: agent.signal }, signal)
  }

  function recordedSkills(agent, state) {
    const skills = new Map(state.snapshot.capabilities.filter(item => item.category === 'skill').map(item => [item.id, item]))
    const history = sessionEvents(agent.session)
    const planIndex = state.message ? history.findLastIndex(event => event.type === 'user/message' && event.data?.id === state.message.id) : -1
    const planDigest = digest(state.snapshot)
    const sessionId = String(agent.session.id ?? agent.id)
    // Accepted contract updates prove inventory state independently of whether
    // their descriptions remain visible. They do not establish model knowledge.
    for (const event of history.slice(planIndex + 1)) {
      const update = event.type === 'user/message' && readContractUpdate(event.data, planDigest, sessionId)
      for (const change of update?.changes ?? []) {
        if (!change.id.startsWith('skills.')) continue
        if (change.capability === null) skills.delete(change.id)
        else if (change.capability.category === 'skill') skills.set(change.id, change.capability)
      }
    }
    return [...skills.values()]
  }

  async function qualifyCapabilities(agent, state, signal = agent.signal) {
    if (requiresCapabilityInventory(state.snapshot.settings)) {
      const skills = { retained: state.provedSkills ?? recordedSkills(agent, state) }
      const capabilities = await inventory(agent, state.hostSections, state.snapshot.settings, signal, undefined, state.snapshot.plan.enabled
        ? new Set(state.snapshot.plan.entries.filter(entry => entry.selection !== 'closed').map(entry => entry.id)) : undefined, skills)
      signal?.throwIfAborted()
      state.liveCapabilities = new Map(capabilities.map(item => [item.id, item]))
      state.skillInventoryComplete = skills.complete
      state.partialSkillNames = skills.partialNames
      if (skills.complete) state.provedSkills = capabilities.filter(item => item.category === 'skill')
      await installSkillProjection(agent, state)
    }
    return state
  }

  /**
   * Declare the capabilities of one supply view.
   *
   * `access` names the view when it is not the agent's own: `schemas` is the tool
   * registry projection and `skills` an already-observed Skill catalogue. Both are
   * what a view answers, so the caller that observed them decides which view this
   * declaration describes; passing them keeps one declaration path for every view
   * instead of a second inventory that could disagree with this one.
   */
  async function inventory(agent, sections = [], settings, signal, presentation, frozenIds, skillObservation, access) {
    if (settings) settings = effectiveCapabilitySettings(settings)
    const schemas = (access?.schemas ?? toolSchemasForAgent(agent)).filter(schema => !TRANSPORTS.has(schema.name))
    const capabilities = schemas.map(schema => toolCapability(schema, sections))
    const declaredServers = new Set([...resourceServers(sections),
      ...sections.filter(section => section.name?.startsWith('mcp:')).map(section => section.name.slice(4))])
    for (const capability of capabilities) {
      const servers = [...declaredServers].filter(server => capability.schema.name.startsWith(`mcp__${server}__`))
      if (servers.length === 1) capability.mcpServer = servers[0]
      else if (servers.length > 1) capability.mcpServerCandidates = servers
      // The source names every declared server whose namespace begins this tool name.
      // One name can begin with two (`mcp__docs__deep__search` is named by `docs` and
      // by `docs__deep`), and that list is the supply's own fact: the panel states the
      // servers it has, so dropping the list here leaves the row unable to name any.
      presentation?.set(capability.id, { name: capability.schema.name,
        source: servers.length === 1 ? { kind: 'mcp', server: servers[0] } : servers.length > 1
          ? { kind: 'mcp', servers } : { kind: 'host' } })
    }
    if (skillObservation) skillObservation.complete = true
    const hasOperation = name => (!frozenIds || frozenIds.has(`tools.${name}`)) && capabilities.some(item => item.id === `tools.${name}`
      && (!settings?.enabled || !settings.policy || capabilityRule(settings.policy, item).availability !== 'closed'))
    const policyPaths = Boolean(settings?.policy)
    if (readSkills(ctx)?.snapshot !== undefined) {
      const observed = access?.skills ?? await observeSkills(agent, signal)
      if (skillObservation) {
        skillObservation.complete = observed.complete
        skillObservation.partialNames = observed.complete ? [] : observed.skills.map(skill => skill.name)
      }
      if (!observed.complete && !skillObservation) throw new Error('ptc-plus: the Skill catalog is incomplete; cannot select a new capability environment')
      // A partial catalog cannot prove a withdrawal or a new Skill. Preserve only
      // the last complete view; native dispatch still uses the live Host scope.
      if (!observed.complete) capabilities.push(...skillObservation.retained.map(item =>
        retainedSkillCapability(item, !policyPaths || hasOperation('skill'))))
      for (const skill of observed.complete ? observed.skills : []) {
        capabilities.push(skillCapability(skill, !policyPaths || hasOperation('skill')))
        presentation?.set(`skills.${skill.name}`, { name: skill.name,
          source: { kind: 'skill', bucket: skill.source, provider: skill.provider },
          invocation: { modelInvocable: isModelInvocable(skill), userInvocable: isUserInvocable(skill) } })
      }
    }
    const servers = resourceServers(sections)
    const resourceOperations = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
      .filter(name => !policyPaths || hasOperation(name))
    for (const server of servers) capabilities.push({ id: `mcp.${server}`, category: CAPABILITY_INVENTORY_CATEGORIES.resource, mcpServer: server,
      revision: digest({ server, instructions: sections.find(section => section.name === `mcp:${server}`)?.text ?? '' }),
      dependencies: sectionDependencies(sections.filter(section => section.name === `mcp:${server}`)), ...(policyPaths && resourceOperations.length === 0 ? { effectiveAvailability: 'closed' } : {}),
      contract: !policyPaths ? `MCP resource server ${JSON.stringify(server)}. Use tools.list_mcp_resources({server}), tools.list_mcp_resource_templates({server}), and tools.read_mcp_resource({server,uri}); use the listed URI or expand a listed template.`
        : `MCP resource server ${JSON.stringify(server)}. ${resourceOperations.length ? 'Available operations: ' + resourceOperations.map(name => `tools.${name}(${name === 'read_mcp_resource' ? '{server,uri}' : '{server}'})`).join(', ') + '.' : 'No resource operation is available in this session.'}`,
      description: `MCP resource access registered by the Host for server ${server}. This records the registered resource layer and the session's resource operations, not a proved list of exposed resources or templates.`,
      selector: { server } })
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
  /**
   * A session capability choice is a record, not a plan edit.
   *
   * The panel states what this session decided, so the decision itself has to exist in
   * the session's own log. The plan is what a runtime later materializes from it; a
   * change that only rebuilt a plan would leave the row stating the value it replaced.
   *
   * The record is this session's statement about itself, so it is appended to every live
   * session, before the Host's first system head as well as after it. Skipping that
   * append would leave the panel reporting a decision the log never received, and no
   * later read could recover it.
   */
  function recordSelection(agent, overrides, signal) {
    signal?.throwIfAborted()
    if (typeof agent?.session?.append !== 'function') {
      throw new Error('ptc-plus: session capability choices require the public Session.append surface')
    }
    const choices = {}
    for (const [id, value] of Object.entries(overrides ?? {})) {
      const rule = capabilityRuleOfSelection(value)
      if (Object.keys(rule).length > 0) choices[id] = rule
    }
    const message = capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA, choices })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    // This record is now the session's newest statement. The observed cut the
    // readers use is the same log, so it carries the statement the write just made;
    // otherwise a read immediately after a change would answer from the record this
    // one replaced.
    const observed = histories.get(agent.session)
    if (Array.isArray(observed)) histories.set(agent.session, [...observed, { type: 'user/message', data: message }])
  }
  function selection(state, id) { return state?.snapshot.plan.entries.find(entry => entry.id === id)?.selection }
  function liveCapability(state, id) {
    return state?.liveCapabilities?.get(id) ?? state?.snapshot.capabilities.find(item => item.id === id)
  }
  function declaredCapabilities(state) {
    const merged = new Map(state?.snapshot.capabilities.map(item => [item.id, item]) ?? [])
    for (const [id, item] of state?.liveCapabilities ?? []) merged.set(id, item)
    return merged
  }
  /**
   * The plan owns the allocation of every identity it froze. A live Host member
   * that the frozen plan never captured stays declared with the Host's own
   * presentation (or its explicit availability closure) until an explicit
   * refresh folds it into the plan; a refresh boundary must not remove the
   * member's identity from the model-visible surface.
   */
  function declaredSelection(state, id) {
    const planned = selection(state, id)
    if (planned !== undefined || !state?.snapshot.plan.enabled) return planned
    const live = state.liveCapabilities?.get(id)
    if (live === undefined) return undefined
    const settings = state.snapshot.settings
    if (settings.policy) return capabilityRule(settings.policy, live).availability === 'closed' ? 'closed' : 'host'
    const overrides = settings.manual?.overrides ?? {}
    return overrides[id] === 'closed'
      || (live.mcpServer !== undefined && overrides[`mcpServers.${live.mcpServer}`] === 'closed') ? 'closed' : 'host'
  }
  function supplied(state, id) {
    if (state?.liveCapabilities && (!state.liveCapabilities.has(id) || state.liveCapabilities.get(id).effectiveAvailability === 'closed')) return false
    if (!state?.snapshot.plan.enabled) return Boolean(state?.liveCapabilities) || !state?.snapshot.settings.policy || selection(state, id) !== 'closed'
    if (!['full', 'on-demand', 'host'].includes(declaredSelection(state, id))) return false
    const capability = liveCapability(state, id)
    return capability?.category !== 'resource'
      || resourceServers(state.hostSections).includes(capability.selector.server)
  }
  function sharedMembers(state, name) {
    const category = name === 'skill' ? 'skill'
      : ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name) ? 'resource' : undefined
    return category === undefined ? undefined : [...declaredCapabilities(state).values()]
      .filter(item => item.category === category && supplied(state, item.id)
        && (category !== 'skill' || (state.liveCapabilities?.get(item.id) ?? item).invocation?.modelInvocable !== false))
      .map(item => item.selector[category === 'skill' ? 'name' : 'server'])
  }
  function memberSupplied(state, name) {
    return TRANSPORTS.has(name) || (supplied(state, `tools.${name}`) && sharedMembers(state, name)?.length !== 0)
  }
  function statisticsSnapshot(state) {
    if (!state.liveCapabilities) return state.snapshot
    const eligible = item => state.skillInventoryComplete !== false || item.category !== 'skill'
    return { ...state.snapshot, plan: { ...state.snapshot.plan,
      entries: state.snapshot.plan.enabled ? state.snapshot.plan.entries.filter(entry => supplied(state, entry.id) && state.liveCapabilities.has(entry.id) && eligible(entry))
        .map(entry => ({ ...entry, revision: state.liveCapabilities.get(entry.id).revision }))
        : [...state.liveCapabilities.values()].filter(item => supplied(state, item.id) && eligible(item))
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

  function skillProjectionEntries(state) {
    if (!state.snapshot.plan.enabled) return []
    const capabilities = new Map(state.snapshot.capabilities.map(item => [item.id, item]))
    for (const [id, item] of state.liveCapabilities ?? []) capabilities.set(id, item)
    for (const name of state.partialSkillNames ?? []) {
      const id = `skills.${name}`
      if (!capabilities.has(id)) capabilities.set(id, { id, category: 'skill', selector: { name } })
    }
    return [...capabilities.values()].filter(item => item.category === 'skill' && !supplied(state, item.id))
      .map(item => ({ name: item.selector.name, description: 'Unavailable in this session capability environment.',
        invocation: { modelInvocable: false, userInvocable: false }, source: 'ptc-plus-session-capabilities',
        provider: 'ptc-plus-session-capabilities', rank: -Number.MAX_VALUE, locator: item.id }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  }

  async function installSkillProjection(agent, state) {
    let projection = skillProjections.get(agent)
    if (!projection && state.snapshot.plan.enabled && readSkills(ctx)?.registerProvider) {
      const scope = createScope(ctx, agent)
      projection = { scope, entries: skillProjectionEntries(state) }
      try {
        scope.ctx.effect(() => readSkills(scope.ctx).registerProvider(control => {
          projection.control = control
          const name = 'ptc-plus-session-capabilities'
          return { name,
            async list(options) {
              return options.scope === agent ? projection.entries : []
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
    if (projection) {
      const entries = skillProjectionEntries(state)
      if (JSON.stringify(entries) !== JSON.stringify(projection.entries)) {
        projection.entries = entries
        projection.control.invalidate()
      }
    }
  }

  async function acceptState(agent, state, publish, signal) {
    const preceding = skillProjections.get(agent)
    const precedingEntries = preceding?.entries
    try {
      await installSkillProjection(agent, state)
      signal?.throwIfAborted()
      if (publish) publishPlan(agent, state.message, signal)
    } catch (error) {
      const projection = skillProjections.get(agent)
      if (preceding) {
        const changed = JSON.stringify(preceding.entries) !== JSON.stringify(precedingEntries)
        preceding.entries = precedingEntries
        try { if (changed) preceding.control.invalidate() } catch (restoration) {
          throw new AggregateError([error, restoration], 'PTC Plus Skill projection restoration failed')
        }
      } else if (projection) {
        skillProjections.delete(agent)
        await projection.scope.dispose()
      }
      throw error
    }
    state.session = agent.session
    sessions.set(String(agent.session.id ?? agent.id), state)
    return state
  }

  async function previewPolicy(agent) {
    const state = stateFor(agent)
    const settings = state && effectiveCapabilitySettings(state.snapshot.settings)
    if (!(settings?.policy ? settings.previewEnabled : state?.snapshot.plan.enabled)) return undefined
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

  /**
   * Compose this session's capability plan from the record that owns its choices.
   *
   * The session's own log states this session's choices and the saved
   * configuration states what it inherits; both are read on every composition,
   * including the incremental one a step begins with. A composition may not
   * remember them: a choice recorded before the process restarted exists in the
   * log and in no memory, and a plan that trusted its own earlier composition
   * would keep a decision the log has already replaced.
   *
   * A plan whose recorded choices already match the log is kept as it is. One that
   * disagrees is recomposed from the same saved inputs it was composed from, so a
   * session choice never silently adopts a saved configuration the session has not
   * refreshed to. `force` remains the explicit refresh: it recomposes from the
   * saved configuration as it stands now and publishes immediately.
   */
  async function prepare(agent, sections, force = false, signal = agent?.signal) {
    signal?.throwIfAborted()
    if (agent?.session === undefined) {
      if (!effectiveCapabilitySettings(capabilityConfiguration(currentConfig)).enabled) return undefined
      throw new TypeError('ptc-plus: capability management requires an agent Session')
    }
    const history = await observeHistory(agent, signal)
    const id = String(agent.session.id ?? agent.id)
    const statement = capabilitySelectionOf(history, id)
    const sessionOverrides = sessionOverridesOf(statement)
    const current = sessions.get(id)
    if (!force && current !== undefined) {
      if (sections !== undefined) current.hostSections = sections
      if (sameChoices(sessionOverrides, current.snapshot.sessionOverrides)) return qualifyCapabilities(agent, current, signal)
    }
    // A composition that is rebuilt for a record keeps the Host sections it already
    // observed: a caller that has none to offer is not asking the Host to declare
    // less than it did, only to act on what the session recorded.
    const hostSections = sections ?? current?.hostSections ?? []
    const pending = operations.get(agent)
    if (pending !== undefined && !force) return pending
    const task = (async () => {
      // The composition this one replaces, when it replaces one: a live state, or
      // the plan the log last published. Its saved inputs are reused so the
      // replacement states the same inheritance; its plan is not reused.
      let preceding
      if (!force) {
        if (current !== undefined) preceding = current.snapshot
        else {
          const recorded = recordedPlan(history, id)
          if (recorded !== undefined) {
            let snapshot
            try { snapshot = sourcePlan(recorded, id) } catch (error) {
              ctx.logger?.warn?.(`ptc-plus: ${error.message}; continuing with the host environment until /capabilities refresh`)
              const settings = { ...capabilityConfiguration(currentConfig), enabled: false, ...(currentConfig.capabilityPolicy ? { recoveryEnabled: false, previewEnabled: false, statistics: { ...capabilityConfiguration(currentConfig).statistics, enabled: false } } : {}) }
              const plan = createCapabilityPlan({ ...settings, configurationRevision: digest(settings), capabilities: [], navigationText: NAVIGATION })
              snapshot = deepFreeze({ schema: settings.contextEnabled !== undefined ? 'ptc-capability-environment/v4' : settings.policy ? 'ptc-capability-environment/v3' : 'ptc-capability-environment/v1', ...(settings.policy || settings.contextEnabled !== undefined ? { sourceSettings: settings, sessionOverrides: {} } : {}), navigationText: NAVIGATION, settings, capabilities: [], plan })
              const notice = planMessage(snapshot, id, true)
              const state = { snapshot, message: notice, hostSections, expanded: new Set(), used: new Map() }
              return acceptState(agent, state, true, signal)
            }
            if (sameChoices(sessionOverrides, snapshot.sessionOverrides)) {
              const restored = { snapshot, message: snapshot.settings.contextEnabled !== undefined || snapshot.plan.enabled || snapshot.settings.policy && (snapshot.settings.statistics?.enabled || snapshot.settings.recoveryEnabled || snapshot.settings.previewEnabled) || recorded.source.refresh ? recorded : undefined, hostSections, expanded: new Set(), used: new Map() }
              await qualifyCapabilities(agent, restored, signal)
              signal?.throwIfAborted()
              restoreEvidence(agent, restored)
              return acceptState(agent, restored, false, signal)
            }
            preceding = snapshot
          }
        }
      }
      const historical = !force && !sessionEvents(agent.session).some(event => event.type === 'user/message'
        && readRuntimeAvailability(event.data) === 'disabled') && sessionEvents(agent.session).some(event =>
        event.type === 'assistant/message' || event.type === 'tool/result')
      let sourceSettings = preceding === undefined
        ? { ...capabilityConfiguration(currentConfig), ...(historical ? { enabled: false, ...(currentConfig.capabilityPolicy ? { recoveryEnabled: false, previewEnabled: false, statistics: { ...capabilityConfiguration(currentConfig).statistics, enabled: false } } : {}) } : {}) }
        : preceding.sourceSettings ?? preceding.settings
      // A record can state one dimension where a saved decision states a whole
      // selection. The policy vocabulary can hold either, and it is derived from the
      // same saved document, so the composition upgrades to it here rather than
      // dropping a dimension the record decided.
      if (sourceSettings.policy === undefined
        && Object.values(sessionOverrides).some(selection => typeof selection === 'object')) {
        sourceSettings = capabilityConfiguration(capabilityProfileConfiguration(
          savedConfiguration(sourceSettings), { allowInvalidStatistics: true }))
      }
      const settings = sessionCapabilitySettings(sourceSettings, sessionOverrides)
      const capabilities = requiresCapabilityInventory(settings) ? await inventory(agent, hostSections, settings, signal) : []
      const effective = effectiveCapabilitySettings(settings)
      const coverage = (effective.policy ? effective.enabled && effective.policy.allocation.statistics : effective.statistics?.enabled === true) ? await store?.coverage(agent, capabilities, settings.statistics) : undefined
      const planChannel = planChannelText(currentConfig)
      const directoryBudgetBytes = planDirectoryBudget(settings.directoryBudgetBytes, planChannel.navigationSentence)
      const plan = createCapabilityPlan({ ...settings, configurationRevision: digest(settings),
        capabilities, coverage, navigationText: planChannel.navigationSentence,
        categories: planChannel.categoryLines,
        directoryBudgetBytes })
      const hasChoices = settings.contextEnabled !== undefined || settings.policy !== undefined
        || statement.state !== 'none' || preceding?.schema === 'ptc-capability-environment/v2'
      // An edited plan channel needs the v5 record, and that generation requires the
      // saved inputs and session choices it was composed from.
      const recordsText = !planChannel.isDefault
      const snapshot = deepFreeze({ schema: recordsText ? 'ptc-capability-environment/v5'
        : settings.contextEnabled !== undefined ? 'ptc-capability-environment/v4' : settings.policy ? 'ptc-capability-environment/v3'
          : hasChoices ? 'ptc-capability-environment/v2' : 'ptc-capability-environment/v1',
        ...(hasChoices || recordsText ? { sourceSettings, sessionOverrides } : {}),
        ...(recordsText ? planPromptText(planChannel, directoryBudgetBytes) : {}),
        navigationText: planChannel.navigationSentence, settings, capabilities, ...(coverage === undefined ? {} : { coverage }), plan })
      const initialized = sessionEvents(agent.session).some(event => event.type === 'system/message')
      // A composition that replaces one already delivered says so, whether the
      // replacement came from an explicit refresh or from a record the delivered
      // plan no longer matches.
      const message = planMessage(snapshot, id, (force || preceding !== undefined) && initialized)
      agent.signal?.throwIfAborted?.()
      signal?.throwIfAborted()
      // Initialized sessions commit a refresh and its notification atomically.
      // First-step proposals are accepted through the Host's pre-step messages.
      const state = { snapshot, message: settings.contextEnabled === undefined && !effective.enabled && !force && !(effective.policy && (effective.statistics?.enabled || effective.recoveryEnabled || effective.previewEnabled)) ? undefined : message,
        hostSections, expanded: new Set(), used: new Map(),
        ...(requiresCapabilityInventory(settings) ? { liveCapabilities: new Map(capabilities.map(item => [item.id, item])) } : {}) }
      restoreEvidence(agent, state)
      return acceptState(agent, state, force, signal)
    })()
    operations.set(agent, task)
    try { return await task } finally { if (operations.get(agent) === task) operations.delete(agent) }
  }

  function visibleSchemas(agent, schemas) {
    const state = stateFor(agent)
    if (!state?.snapshot.plan.enabled) return schemas
    return schemas.filter(schema => memberSupplied(state, schema.name))
  }

  /**
   * What the Host declares to one supply view.
   *
   * A view is named by the scope the caller supplies, and the same three sources
   * answer it: prompt sections name the MCP servers and resource servers, the tool
   * registry answers that scope's view of the tools, and the Skill catalogue answers
   * the layers that scope resolves for a workspace directory. With an agent those
   * sources answer this session's declaration — a preset registers its tools at agent
   * scope, and only that scope resolves the Skill layers it selects. With no scope
   * they answer the Host's own declaration, which is what a caller that names no
   * session asks for.
   *
   * `agent` is the scope handle and nothing else. It says which declaration to read;
   * it is never asked whether the session is usable, and no runtime branch runs here.
   * The observation flag keeps the public assembly passive even when a scope is named:
   * it contributes that scope's sections without preparing or delivering anything.
   */
  async function hostSupply({ agent, cwd }, signal) {
    const scope = agent === undefined ? {} : { agent, scope: agent }
    // One failure mode: a source that cannot be read fails this read. Partial rows
    // would be a screen that silently misses what exists, which no wording repairs.
    let sections = []
    if (typeof ctx.systemPrompt?.assemble === 'function') {
      const assembly = await ctx.systemPrompt.assemble({ ...scope, signal, ptcPlusCapabilityObservation: true })
      sections = Array.isArray(assembly?.sections) ? assembly.sections : []
      // Reading the sections is the MCP layer's own step. A section this build cannot
      // interpret fails here rather than being reported as a tool-registry failure.
      resourceServers(sections)
    }
    const schemas = toolSchemasForAgent(agent)
    const skills = readSkills(ctx)?.snapshot === undefined ? undefined
      : await observeSkillsAt({ ...scope, cwd, signal }, signal)
    const presentation = new Map()
    const capabilities = await inventory(agent, sections,
      { ...capabilityConfiguration(currentConfig), enabled: false, manual: { baseline: [], overrides: {} } },
      signal, presentation, undefined, undefined, { schemas, skills })
    return { capabilities, presentation }
  }

  /**
   * The supply this session's own record froze.
   *
   * A session whose agent the Host no longer holds has no scope to observe, and the
   * Host's own plane is not that session's face: the preset tools registered at agent
   * scope and the Skill layers that scope resolved existed in that scope alone.
   * The plan this session recorded is the statement of what it was supplied, and
   * `snapshot.capabilities` is that statement. Name and source are taken from what the
   * recorded capability itself carries: a tool names itself through its schema and its
   * MCP owner, a Skill through its selector — the frozen contract records no provider
   * bucket for it — and a resource row through the server it belongs to.
   */
  function frozenSupply(snapshot) {
    const presentation = new Map()
    for (const capability of snapshot.capabilities) {
      const name = capability.schema?.name ?? capability.selector?.name
        ?? capability.selector?.server ?? capability.id
      const source = capability.mcpServer !== undefined ? { kind: 'mcp', server: capability.mcpServer }
        : capability.mcpServerCandidates !== undefined ? { kind: 'mcp', servers: capability.mcpServerCandidates }
          : { kind: capability.category === 'skill' ? 'skill'
            : capability.category === CAPABILITY_INVENTORY_CATEGORIES.resource ? 'mcp' : 'host' }
      presentation.set(capability.id, { name, source,
        ...(capability.invocation === undefined ? {} : { invocation: capability.invocation }) })
    }
    return { capabilities: snapshot.capabilities, presentation }
  }

  /**
   * Which capabilities this session's own log proves it obtained.
   *
   * Evidence is a fact about one execution: a completed result that names the
   * capability in its evidence block. The absence of such a result is not a state
   * the panel states; it is an empty cell.
   */
  function capabilityProofOf(events) {
    const proved = new Set()
    for (const event of Array.isArray(events) ? events : []) {
      const evidence = event?.type === 'tool/result' && event.data?.meta?.[EVIDENCE_KEY]
      if (!evidence || evidence.schema !== 'ptc-capability-evidence/v1' || !Array.isArray(evidence.used)) continue
      for (const id of evidence.used) if (typeof id === 'string') proved.add(id)
    }
    return proved
  }

  const ROW_DIMENSIONS = Object.freeze(['availability', 'disclosure'])

  /**
   * The words this configuration wrote for one object.
   *
   * The saved column follows the same rule as the session column: it states what its own record
   * holds for that object. A rule the document wrote for the object is stated in the record's
   * words; a dimension it wrote nothing for reads `automatic`. A layer that would outrank that
   * entry at runtime — a category or `mcpServers.<server>` rule, or a document's bottom layer — is
   * behaviour rather than a word this (object, address) holds, so it changes neither the cell nor
   * the control. A server has no disclosure of its own, so a server row states availability only.
   */
  function savedChoice(configuration, capability) {
    if (capability.kind === 'server') {
      // A server's saved address is the one `mcpServers.<server>` rule it has.
      const availability = configuration.policy
        ? configuration.policy.mcpServers[capability.id.slice('mcpServers.'.length)]?.availability
        : capabilityOverrideWord(configuration, capability.id, 'availability')
      return { availability: availability ?? 'automatic' }
    }
    const rule = configuration.policy && Object.hasOwn(configuration.policy.items, capability.id)
      ? configuration.policy.items[capability.id] : undefined
    // The override record is this address's write channel only while the document holds no
    // policy. Once it does, that policy is the record — the override field stays as historical
    // input and must not answer a dimension the policy left unwritten (the server branch above
    // has the same guard), otherwise §8.2's removal would be invisible.
    const override = dimension => configuration.policy === undefined
      ? capabilityOverrideWord(configuration, capability.id, dimension) : undefined
    return { availability: rule?.availability ?? override('availability') ?? 'automatic',
      disclosure: rule?.disclosure ?? override('disclosure') ?? 'automatic' }
  }

  /**
   * One dimension the legacy override record wrote for an object, in the record's own
   * words.
   *
   * The legacy record holds a whole selection: `closed` is an availability word and a
   * delivery word is a disclosure word. Neither writes the other dimension, so the
   * other dimension stays unwritten instead of borrowing a value from the resolution.
   */
  function capabilityOverrideWord(configuration, id, dimension) {
    const override = configuration.manual?.overrides?.[id]
    if (override === undefined || override === 'automatic') return undefined
    if (override === 'closed') return dimension === 'availability' ? 'closed' : undefined
    return dimension === 'disclosure' ? override : undefined
  }

  /**
   * The words this session's record wrote for one object, and which layer wrote each.
   *
   * One (object, address) holds one value, so a dimension this object's own entry wrote is
   * never also its server's: the layer map names a server only for a dimension this entry
   * wrote nothing for. The words stay the record's own because both the value column and the
   * receipt state what was written; the receipt names the layer that wrote them.
   */
  function sessionWords(statement, capability) {
    const own = capabilityChoiceOf(statement, capability.id) ?? {}
    const serverId = capability.mcpServer === undefined ? undefined : `mcpServers.${capability.mcpServer}`
    const server = serverId === undefined ? {} : capabilityChoiceOf(statement, serverId) ?? {}
    const words = {}
    const layers = {}
    for (const dimension of ROW_DIMENSIONS) {
      // The session column states this object's own record: an entry of its own, or `inherit`
      // when the record wrote none. A dimension this entry wrote belongs to this address, so the
      // receipt states it as this row's word and names no layer — naming the server there would
      // have the receipt owe a dimension the value column says this row holds (§8.1b), while the
      // runtime precedence of a closed server belongs to behaviour and does not reach the page.
      if (own[dimension] !== undefined) {
        words[dimension] = own[dimension]
        continue
      }
      // A server that wrote this dimension answers the member's at runtime, so the receipt names
      // it; a server that wrote `automatic` deleted that dimension from its rule and decides no
      // member, which is why the receipt names it only for a word the rule actually holds.
      if (capability.kind !== 'server' && server[dimension] !== undefined && server[dimension] !== 'automatic') {
        layers[dimension] = serverId
      }
    }
    return { words, layers }
  }

  /**
   * The session address's value for one object: the record's own words.
   *
   * Both columns state what their own record wrote, so a recorded `automatic` reads
   * `automatic` here — the word the record holds — and `inherit` is this column's word for
   * an address that recorded nothing, so no cell is blank. What those words would resolve
   * to is the runtime's answer and belongs to behaviour, not to this page: no resolved
   * value is put on screen. A dimension a server-level entry decided states that entry's
   * word and the receipt names the layer, which is where a delegation is readable.
   */
  function sessionChoice(capability, statement) {
    const { words } = sessionWords(statement, capability)
    return { availability: words.availability ?? 'inherit', disclosure: words.disclosure ?? 'inherit' }
  }

  /**
   * The identity, name, category, description and proved source of one declared
   * capability.
   *
   * The panel's rows and the settings page's entries state the same supply facts,
   * so they take them from one place instead of two derivations that could drift.
   */
  function capabilityEntry(capability, presentation) {
    const display = presentation.get(capability.id)
    return {
      id: capability.id,
      name: display?.name ?? capability.name ?? capability.id,
      category: capability.category,
      description: capability.description,
      // Without a display entry the identity is stated by the namespace it belongs to:
      // a resource row is MCP's, a Skill row is a Skill's, and a tool row is the Host
      // registry's. A category is not a source, so it cannot stand in for one here.
      source: display?.source
        ?? (capability.mcpServer === undefined
          ? { kind: capability.category === 'skill' ? 'skill' : capability.category === 'resource' ? 'mcp' : 'host' }
          : { kind: 'mcp', server: capability.mcpServer }),
    }
  }

  /**
   * v2 rows: one per declared capability, one per declared MCP server.
   *
   * `description` is the Host's own one-line contract for the capability it declared.
   * The panel states seven columns and none of them is this text; the `/capabilities
   * list` command still names what it found, and taking that line from the same row
   * keeps one supply read behind both surfaces.
   */
  function capabilityRows(capabilities, presentation, configuration, statement, proved) {
    const rows = capabilities.map(capability => {
      const { words, layers } = sessionWords(statement, capability)
      return {
        ...capabilityEntry(capability, presentation),
        kind: 'capability',
        saved: savedChoice(configuration, capability),
        session: sessionChoice(capability, statement),
        // What the record wrote, in its own words, and the layer that wrote it: the session and
        // receipt columns state these words, and the receipt names the layer that wrote them.
        record: { availability: words.availability, disclosure: words.disclosure,
          layers: { availability: layers.availability ?? null, disclosure: layers.disclosure ?? null } },
        evidence: proved.has(capability.id),
      }
    })
    for (const server of new Set(capabilities.map(item => item.mcpServer).filter(Boolean))) {
      const id = `mcpServers.${server}`
      const row = { id, kind: 'server', name: server, category: 'server', source: { kind: 'mcp', server } }
      const { words, layers } = sessionWords(statement, row)
      rows.push({
        ...row,
        saved: savedChoice(configuration, row),
        session: sessionChoice(row, statement),
        record: { availability: words.availability, disclosure: words.disclosure,
          layers: { availability: layers.availability ?? null, disclosure: layers.disclosure ?? null } },
        // A server is not a capability: no execution can obtain it as a whole.
        evidence: false,
      })
    }
    return rows
  }

  /** v2 rows: one per supplied binding entry. A withheld entry has no row. */
  async function bindingRows(events) {
    const supply = typeof readUserBindings === 'function' ? await readUserBindings() : { entries: [] }
    if (supply === null || typeof supply !== 'object' || !Array.isArray(supply.entries) || supply.error !== undefined) {
      // A document this build cannot parse is a failed read, not an empty catalogue:
      // an empty table would tell the user they have no bindings.
      throw new Error('ptc-plus: the binding catalogue could not be read')
    }
    const adoption = bindingAdoptionOf(events)
    const declined = adoption.state === 'decided' ? new Set(adoption.adoption.declined) : new Set()
    return supply.entries.filter(entry => entry.enabled === true).map(entry => ({
      id: entry.id,
      kind: 'binding',
      name: entry.name ?? entry.id,
      category: 'binding',
      source: { kind: 'bindings' },
      // The bindings document is a binding's saved address: an entry is listed only
      // while it is enabled, and its model-context preference decides whether the
      // model reads the declaration from the first request or only the callable
      // contract on demand.
      saved: { availability: 'enabled',
        disclosure: bindingModelPreferences(entry.modelContext).includeDeclaration ? 'full' : 'on-demand' },
      // The adoption record names the entries this session declined, so an entry it
      // does not name has no receipt at that address.
      session: { use: adoption.state === 'unreadable' ? 'damaged' : declined.has(entry.id) ? 'skip' : 'use',
        recorded: adoption.state === 'unreadable' || declined.has(entry.id) },
      evidence: false,
    }))
  }

  /**
   * This session's own log, reached through whichever public handle the Host has.
   *
   * A live session object, the agent that owns it, and the persistence query all
   * name the same log. None of them is a capability source: which handle answered
   * changes no rendered value, only whether the read had to wait for a query.
   */
  async function sessionLogOf(sessionId, signal) {
    const owned = typeof ctx.get === 'function' ? ctx.get('sessions')?.get?.(sessionId) : ctx.sessions?.get?.(sessionId)
    const holder = liveAgentFor(sessionId)
    const session = owned ?? holder?.session
    const query = sessionQueryService()
    // A Host without a projection service still has the session's own events.
    if (session !== undefined && session !== null && query === undefined && typeof session.snapshotEvents === 'function') {
      return { id: session.id, header: session.header, events: session.snapshotEvents() }
    }
    if (session !== undefined && session !== null) return readSessionLog(session, query, signal)
    return readSessionLog({ id: sessionId }, query, signal)
  }

  /**
   * The live agent that holds one session's scope, when the Host still holds it.
   *
   * The agent is a scope handle and nothing else here: it names the declaration the
   * supply read observes. This lookup never asks whether the session is usable, runs
   * no maintenance branch and writes nothing — a session the Host no longer holds
   * simply has no scope left to name.
   */
  function liveAgentFor(sessionId) {
    return (ctx.agents?.list?.() ?? []).find(agent => String(agent.session?.id ?? agent.id) === sessionId)
  }

  /**
   * One session catalogue's two sources: this session's own log and the supply it was
   * declared.
   *
   * The supply is read in the session's own scope while the Host still holds that
   * scope, because the Host's own plane is a different question and answers fewer rows
   * than the session had. Once the scope is gone, the face this session's recorded
   * plan froze is the only statement of what it was supplied. A session that recorded
   * no plan, or one whose plan was composed while no capability feature required an
   * inventory, has no supply this read can state, so the read fails and names the
   * record it needed instead of answering with a face the session never had. A failed
   * source fails the whole read; a partial answer would be a screen that silently
   * misses what exists.
   */
  async function sessionCatalogSupply(sessionId, signal) {
    signal?.throwIfAborted()
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('ptc-plus: a capability read needs a session')
    let log
    try {
      log = await sessionLogOf(sessionId, signal)
    } catch (cause) {
      signal?.throwIfAborted()
      throw new Error('ptc-plus: the session catalogue needs this session\'s log', { cause })
    }
    if (log === null || typeof log !== 'object' || log.header === undefined) {
      throw new Error('ptc-plus: the session catalogue needs this session\'s header')
    }
    const events = Array.isArray(log.events) ? log.events : []
    const cwd = typeof log.header.cwd === 'string' ? log.header.cwd : undefined
    const agent = liveAgentFor(sessionId)
    signal?.throwIfAborted()
    let supply
    if (agent !== undefined) supply = await hostSupply({ agent, cwd }, signal)
    else {
      const recorded = recordedPlan(events, sessionId)
      if (recorded === undefined) {
        throw new Error('ptc-plus: this session recorded no capability plan; a session with no live scope states the face its record froze')
      }
      const snapshot = sourcePlan(recorded, sessionId)
      // A composition answers an empty `capabilities` two ways, and only one of them is a
      // face. When an inventory was required the array is the face, empty or not. When none
      // was — no capability feature was on — nothing was supplied to the model, so the record
      // states no face at all and an empty table would claim the Host declared nothing.
      if (!requiresCapabilityInventory(snapshot.settings)) {
        throw new Error('ptc-plus: this session\'s recorded plan froze no capability inventory; a session with no live scope states the face its record froze, and this record holds none')
      }
      supply = frozenSupply(snapshot)
    }
    signal?.throwIfAborted()
    return { events, supply }
  }

  return Object.freeze({
    reconfigure(next) { currentConfig = next },
    prepare,
    stateFor,
    visibleSchemas,
    validateSupply,
    /**
     * Recompose this session's plan from the saved configuration and the record.
     *
     * `agent` is a parameter of the call, not a property of the session: which
     * live agent's composition to replace is what the caller states by naming it.
     * Nothing else about the session decides whether a refresh may happen.
     */
    async refresh(agent, sections, signal) {
      signal?.throwIfAborted()
      if (agent === undefined) throw new TypeError('ptc-plus: a capability refresh needs an agent')
      if (typeof agent.runMaintenance !== 'function') throw new Error('ptc-plus: capability refresh requires the public agent maintenance boundary')
      return agent.runMaintenance(async maintenanceSignal => {
        // The Host's declaration is observed first: a refresh composes from it, so a
        // composition that had to guess it would compose from less than the Host says.
        const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: maintenanceSignal })
        signal?.throwIfAborted()
        maintenanceSignal.throwIfAborted()
        const preparationSignal = AbortSignal.any([signal, maintenanceSignal, agent.signal].filter(Boolean))
        return prepare(agent, sections ?? stateFor(agent)?.hostSections ?? assembly.sections, true, preparationSignal)
      })
    },
    /**
     * State one capability choice: one intent, one writer, one receipt.
     *
     * A session choice is a record and a global choice is a saved setting; neither
     * is a plan. The plan is the runtime's composition of the record and is
     * rebuilt by the entry that composes one, so no control here asks whether a
     * runtime exists — a decision this session made is the same decision whether
     * or not something is running to act on it.
     */
    async change(agent, intent, signal, globalSettings) {
      const dimension = intent.dimension
      const selections = dimension === 'availability' ? ['enabled', 'closed', 'automatic', 'inherit']
        : dimension === 'disclosure' ? [...CAPABILITY_DISCLOSURES, 'automatic', 'inherit']
          : dimension === undefined ? ['full', 'on-demand', 'closed', 'automatic', 'inherit'] : []
      if (!['session', 'global'].includes(intent.scope) || !selections.includes(intent.selection)
        || intent.scope === 'global' && intent.selection === 'inherit') throw new TypeError('invalid capability change')
      // The record vocabulary is asked once, here, before anything is appended: an id it
      // cannot name would otherwise reach the message writer and fail there as an
      // internal error, after the command had already been answered.
      if (typeof intent.id !== 'string' || !CAPABILITY_ENTRY_ID.test(intent.id)) {
        throw new TypeError('ptc-plus: a capability choice names an entry as tools.<name>, skills.<name>, mcp.<server> or mcpServers.<server>')
      }
      // A server has no disclosure of its own: its members carry one. This states
      // the vocabulary, not what any process happens to supply.
      if (!dimension && intent.id.startsWith('mcpServers.') && !['closed', 'automatic', 'inherit'].includes(intent.selection)) {
        throw new Error('ptc-plus: MCP server choices are closed, automatic or inherit')
      }
      if (intent.scope === 'global') {
        if (!globalSettings?.read || !globalSettings?.update) throw new Error('ptc-plus: global capability changes require the public settings writer')
        const before = globalSettings.read()
        if (!before || !Number.isSafeInteger(before.revision)) throw new Error('ptc-plus: global capability changes require settings revision evidence')
        const overrides = JSON.parse(before.value.capabilityOverrides ?? '{}')
        if (intent.selection === 'automatic') delete overrides[intent.id]
        else overrides[intent.id] = intent.selection
        signal?.throwIfAborted()
        // The settings document this writer reads holds the record: a document carrying a policy
        // is composed into verbatim. Only a document that carries none starts from the record's
        // own layers, so the synthesized bottom layer is never frozen into the record (§8.1c).
        const policy = before.value.capabilityPolicy !== undefined
          ? capabilityPolicyForConfig(before.value) : capabilityPolicyFromRecord(before.value)
        let nextPolicy = dimension ? changeCapabilityRule(policy, intent.id, dimension, intent.selection)
          : changeCapabilityRule(policy, intent.id, 'availability', intent.selection === 'closed' ? 'closed'
            : intent.selection === 'automatic' ? 'automatic' : 'enabled')
        if (!dimension) nextPolicy = intent.selection === 'automatic' ? changeCapabilityRule(nextPolicy, intent.id, 'disclosure', 'automatic')
          : intent.selection === 'closed' ? nextPolicy : changeCapabilityRule(nextPolicy, intent.id, 'disclosure', intent.selection)
        const patch = before.value.capabilityPolicy || dimension
          ? { capabilityPolicy: JSON.stringify(nextPolicy), ...(!dimension ? { capabilityOverrides: JSON.stringify(overrides) } : {}) }
          : { capabilityOverrides: JSON.stringify(overrides) }
        await globalSettings.update(patch, before.revision)
        return { globalSaved: true, sessionApplied: true, publication: 'recorded' }
      }
      // A statement is the whole of what this session decided, so composing the next
      // one starts from the log that holds the current statement — the same log the
      // panel reads. A stale or empty runtime view would silently restate the choice
      // just made and withdraw every decision recorded before it.
      const statement = capabilitySelectionOf(await observeHistory(agent, signal),
        String(agent.session.id ?? agent.id))
      signal?.throwIfAborted()
      const choices = { ...(statement.state === 'decided' ? statement.selection.choices : {}) }
      const patch = { ...(choices[intent.id] ?? {}) }
      if (dimension) {
        if (intent.selection === 'inherit') delete patch[dimension]
        else patch[dimension] = intent.selection
      } else if (intent.selection === 'inherit') {
        delete patch.availability; delete patch.disclosure
      } else if (intent.selection === 'closed') patch.availability = 'closed'
      else Object.assign(patch, capabilityRuleOfSelection(intent.selection))
      if (Object.keys(patch).length > 0) choices[intent.id] = patch
      else delete choices[intent.id]
      recordSelection(agent, choices, signal)
      return { globalSaved: false, sessionApplied: true, publication: 'recorded' }
    },
    /**
     * The composition this session built but has not delivered yet.
     *
     * A command that composed a plan before the Host accepted a step has to carry it
     * in its receipt: the plan is not in the log yet, so a restart would otherwise
     * have no way to know which composition the command made.
     */
    pendingChoiceMessage(agent) {
      const state = stateFor(agent)
      return state?.message !== undefined && !planCommitted(agent, state.message) ? state.message : undefined
    },
    projectSections(agent, sections) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return sections
      const inventory = [...declaredCapabilities(state).values()]
      const retained = inventory.filter(item => declaredSelection(state, item.id) === 'host' && supplied(state, item.id))
      const retainedSections = new Set(retained.flatMap(item => item.dependencies ?? []).map(item => item.id))
      const ownedSections = new Set(inventory.flatMap(item => item.dependencies ?? []).map(item => item.id))
      return sections.flatMap(section => {
        if (section.name === 'mcp-resource-servers') {
          const servers = retained.filter(item => item.category === 'resource').map(item => item.selector.server)
          return servers.length ? [{ ...section, text: `Use the following MCP resource servers as the server argument: ${JSON.stringify(servers)}.` }] : []
        }
        if (ownedSections.has(section.name) && !retainedSections.has(section.name)) return []
        if (section.name?.startsWith('tool:') && !TRANSPORTS.has(section.name.slice(5))
          && declaredSelection(state, `tools.${section.name.slice(5)}`) !== 'host') return []
        return [section]
      })
    },
    sdk(agent, nativeSdk) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return nativeSdk
      const candidates = toolSchemasForAgent(agent)
      const schemas = candidates.filter(schema => !TRANSPORTS.has(schema.name))
      const host = schemas.filter(schema => declaredSelection(state, `tools.${schema.name}`) === 'host'
        && memberSupplied(state, schema.name))
      if (host.length === schemas.length) return nativeSdk
      // The edit transport is callable inside every program and is not part of
      // the managed disclosure, so its Host schema stays declared in every
      // managed render. The direct transport is never an SDK member.
      const editTransport = candidates.find(schema => schema.name === EDIT_TRANSPORT)
      return renderToolsSdk(editTransport === undefined ? host : [...host, editTransport])
    },
    projectMembers(agent, members) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return members
      return members.filter(name => memberSupplied(state, name))
    },
    metadata(agent) {
      const state = stateFor(agent)
      if (!state?.snapshot.plan.enabled) return []
      const capabilities = declaredCapabilities(state)
      return ['skill', 'resource'].map(category => ({ namespace: category === 'skill' ? 'skills' : 'mcp',
        members: [...capabilities.values()].filter(item => item.category === category && supplied(state, item.id))
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
        if (liveCapability(state, id) === undefined || !supplied(state, id)) continue
        state.expanded.add(id)
        state?.pendingExpanded?.add(id)
      }
    },
    async preStep(payload, next) {
      if (payload.signal?.aborted) return next()
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
      if (state.snapshot.plan.enabled || state.snapshot.settings.policy && effectiveCapabilitySettings(state.snapshot.settings).recoveryEnabled) {
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
        for (const id of (state.snapshot.settings.policy && !effectiveCapabilitySettings(state.snapshot.settings).recoveryEnabled ? [] : [...state.used.keys()].reverse())) {
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
      // A PTC-owned record is this plugin's own statement, not task history: a session
      // that recorded a choice before its first step still has no task to follow.
      const initial = !sessionEvents(payload.agent.session).some(event => event.type === 'assistant/message'
        || event.type === 'tool/result'
        || event.type === 'user/message' && !isPtcMessageSource(event.data?.source))
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
      // The session column is the record's answer, not the composition's: a
      // composition reports what it built, and this field reports what the session
      // decided. They agree once the composition has caught up, and until then only
      // this field is the answer.
      const sessionOverrides = sessionOverridesOf(capabilitySelectionOf(sessionEvents(agent?.session),
        agent?.session === undefined ? undefined : String(agent.session.id ?? agent.id)))
      return state === undefined ? { configured: capabilityConfiguration(currentConfig), effective: null, sessionOverrides }
        : { configured: capabilityConfiguration(currentConfig), effective: state.snapshot.plan,
          publication: state.message === undefined ? 'not-required' : planCommitted(agent, state.message) ? 'accepted' : 'pending',
          sourceSettings: state.snapshot.sourceSettings ?? state.snapshot.settings,
          sessionOverrides,
          pendingRefresh: digest(capabilityConfiguration(currentConfig)) !== digest(state.snapshot.sourceSettings ?? state.snapshot.settings) }
    },
    describeSessions() {
      return [...sessions].map(([sessionId, state]) => ({ sessionId, effective: state.snapshot.plan,
        publication: state.message === undefined ? 'not-required' : planCommitted({ session: state.session }, state.message) ? 'accepted' : 'pending',
        configuration: savedConfiguration(state.snapshot.sourceSettings ?? state.snapshot.settings),
        sessionOverrides: sessionOverridesOf(capabilitySelectionOf(sessionEvents(state.session), sessionId)),
        pendingRefresh: digest(capabilityConfiguration(currentConfig)) !== digest(state.snapshot.sourceSettings ?? state.snapshot.settings) }))
    },
    /**
     * The live sessions a refresh could be requested for.
     *
     * A refresh replaces one live agent's composition, so the agent is the only
     * fact a target has to supply. Whether a session's model tool table declares
     * the direct transport answers a different question — what that session can
     * call — and a target list is not the place to answer it.
     */
    describeTargets() {
      return (ctx.agents?.list?.() ?? []).map(agent => ({ sessionId: String(agent.session.id ?? agent.id) }))
    },
    async describeSessionCatalog({ sessionId } = {}, signal) {
      // Three permanent sources, no fourth. The session's own log is the record, the
      // supply of this session's own plane is the declared face, and the saved
      // configuration is the saved column. A request that names no session states the
      // Host's own declaration — the process-scope object set, not a session's full
      // declared face, which also carries a preset's agent-scope entries (capability-surface
      // §8.9) — and no session record exists to state, so those columns read `inherit` and
      // no binding adoption is drawn from a log this read was not given.
      const named = typeof sessionId === 'string' && sessionId.length > 0
      const { events, supply } = named ? await sessionCatalogSupply(sessionId, signal)
        : { events: [], supply: await hostSupply({}, signal) }
      const configuration = capabilityConfiguration(currentConfig)
      const rows = capabilityRows(supply.capabilities, supply.presentation, configuration,
        capabilitySelectionOf(events, sessionId), capabilityProofOf(events))
      const bindingsEnabled = currentConfig.userBindingsEnabled === true
      if (bindingsEnabled && named) rows.push(...await bindingRows(events))
      signal?.throwIfAborted()
      // No `live`, no `scope`, no `plan`, no `management`, no `unreadableSupply`, no
      // nullable row group: a failed source fails this read, it does not become a
      // shape the Client has to interpret.
      return { schema: 'ptc-capability-session-catalog/v2', sessionId, rows,
        config: { bindingsEnabled } }
    },
    async observeAllocation({ sessionId, configuration } = {}, signal) {
      signal?.throwIfAborted()
      // The request names the session it observes; the live agent behind that id is
      // the parameter the observation needs. What that agent's tool table declares
      // is not a property of the target.
      const agent = (ctx.agents?.list?.() ?? []).find(agent => String(agent.session.id ?? agent.id) === sessionId)
      if (agent === undefined) throw new TypeError('ptc-plus: select a live session to observe its capability inventory and workspace statistics')
      const raw = configuration === undefined ? savedConfiguration(capabilityConfiguration(currentConfig)) : configuration
      const validated = capabilityProfileConfiguration(raw, { allowInvalidStatistics: true })
      const settings = capabilityConfiguration(validated)
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal, ptcPlusCapabilityObservation: true })
      const capabilities = await inventory(agent, assembly.sections, settings, signal)
      const coverage = Number.isSafeInteger(settings.statistics?.windowSize) && settings.statistics.windowSize > 0
        ? await store?.coverage(agent, capabilities, settings.statistics) ?? null : null
      signal?.throwIfAborted()
      if (!(ctx.agents?.list?.() ?? []).includes(agent)) throw new Error('ptc-plus: capability observation target is no longer available')
      const plan = createCapabilityPlan({ ...settings, capabilities, coverage, navigationText: NAVIGATION,
        configurationRevision: digest(settings) })
      return { sessionId, workspace: agent.session.header.cwd, configuration: validated, plan, coverage,
        capabilities: capabilities.map(item => ({ id: item.id, revision: item.revision, category: item.category,
          contractBytes: Buffer.byteLength(item.contract, 'utf8') })) }
    },
    /**
     * The settings page's list of what this Host declares.
     *
     * The settings page edits global policy, so its list states supply and nothing
     * else: no composed plan, no installed value. A caller that names a session gets
     * that session's own supply — its scope's declaration while the Host still holds
     * the agent, and the face its recorded plan froze when it does not, both read
     * through the same entry the panel reads. A caller that names none gets the
     * Host's own declaration without a workspace directory: that list is the saved
     * configuration's subject, not any session's face, so it is never substituted for
     * one. Neither branch asks whether a runtime exists.
     *
     * Skill invocation eligibility travels with the entry because it belongs to the
     * declaration the Host just made; this read sees one workspace, so it never has
     * two answers to reconcile.
     */
    async describeCatalog({ sessionId } = {}, signal) {
      signal?.throwIfAborted()
      const supply = typeof sessionId === 'string' && sessionId
        ? (await sessionCatalogSupply(sessionId, signal)).supply
        : await hostSupply({}, signal)
      signal?.throwIfAborted()
      return supply.capabilities.map(capability => {
        const display = supply.presentation.get(capability.id)
        return {
          ...capabilityEntry(capability, supply.presentation),
          ...(display?.invocation === undefined ? {} : { invocation: display.invocation }),
          ...(capability.mcpServer === undefined ? {} : { mcpServer: capability.mcpServer }),
        }
      }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
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
