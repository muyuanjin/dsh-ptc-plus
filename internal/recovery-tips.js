import { PTC_STATE_NAMES, recoveryTipIdentity } from './runtime-messages.js'
import {
  PROMPT_SLOT_IDS, TIP_BODY, TIP_BODY_PLATFORM_DETAILED, TIP_BODY_REPEATED_BINDING,
  TIP_BODY_REPEATED_BINDING_CAPABILITY, TIP_DETAIL_BINDING, TIP_DETAIL_CAPABILITY,
  TIP_PREFIX_PLATFORM_COMMAND, TIP_PREFIX_REPEATED_BINDING,
} from './prompt-text.js'

const PLATFORM_CAUSE_CODES = new Set(['EACCES', 'EINVAL', 'ENOTDIR', 'ENOENT', 'UNKNOWN'])
const TIP_CONTEXT_PREFIX = 'tools:ptc-plus-tip/'
const PLATFORM_FACTS = '`return { platform: process.platform, arch: process.arch, node: process.version, cwd: process.cwd(), execPath: process.execPath }`'
/**
 * The delivered prefixes, one slot per trigger kind.
 *
 * Tip identity comes from the notice name, so a prefix carries no recognizer
 * contract; both are read-only registry literals so their bytes are accounted.
 */
const TIP_PREFIXES = Object.freeze({
  'repeated-binding-failure': TIP_PREFIX_REPEATED_BINDING,
  'platform-command-failure': TIP_PREFIX_PLATFORM_COMMAND,
})

// TODO(dsh-tips-api): replace this local provider with an adapter after dsh-tips publishes a stable facts and decision interface.
export function createRuntimeHistory() {
  return { seenNames: {}, tips: {}, hadState: false, hadCatalog: false }
}

export function advanceRuntimeHistory(previous, { sections = [], notice, snapshot = false, catalog = false,
  index, contextStep, lastSuccessfulRunIndex, resetSuccess = false }) {
  let next = previous
  const revise = () => {
    if (next === previous) next = { ...previous, tips: { ...previous.tips }, seenNames: { ...previous.seenNames } }
  }
  if (resetSuccess) {
    revise()
    for (const [id, tip] of Object.entries(next.tips)) next.tips[id] = { ...tip, unresolved: 0 }
    for (const [name, deliveredIndex] of Object.entries(next.seenNames)) {
      const identity = recoveryTipIdentity(name)
      if (deliveredIndex > (lastSuccessfulRunIndex ?? -1)) next.tips[identity.id].unresolved += 1
    }
  }
  const hadState = snapshot || sections.some(section => PTC_STATE_NAMES.includes(section.name))
  if ((hadState && !next.hadState) || (catalog && !next.hadCatalog)) {
    revise()
    next.hadState ||= hadState
    next.hadCatalog ||= catalog
  }
  for (const name of [...sections.map(section => section.name), ...(notice === undefined ? [] : [notice])]) {
    const identity = recoveryTipIdentity(name)
    if (identity === undefined || Object.hasOwn(next.seenNames, name)) continue
    revise()
    next.seenNames[name] = index
    const earlier = next.tips[identity.id]
    next.tips[identity.id] = {
      highestOrdinal: Math.max(earlier?.highestOrdinal ?? 0, identity.ordinal),
      contextStep,
      unresolved: (earlier?.unresolved ?? 0) + (index > (lastSuccessfulRunIndex ?? -1) ? 1 : 0),
    }
  }
  return next
}

export function runtimeHistoryForView(view) {
  if (view.runtimeHistory !== undefined) return view.runtimeHistory
  let history = createRuntimeHistory()
  history.hadState = view.ptcMessages?.some(record => record.form === 'snapshot') === true
  history.hadCatalog = view.ptcMessages?.some(record => record.form === 'catalog') === true
  const snapshots = [
    ...(view.systemPromptSnapshots ?? []),
    ...(view.ptcMessages ?? []).filter(record => record.form === 'notice').map(record => ({
      ...record, sections: [{ name: record.name, text: record.text }],
    })),
  ].sort((left, right) => left.index - right.index)
  for (const snapshot of snapshots) {
    history = advanceRuntimeHistory(history, { ...snapshot, lastSuccessfulRunIndex: view.lastSuccessfulRunIndex })
  }
  return history
}

function hasPlatformCommandDiagnostic(diagnostics) {
  return diagnostics.some(diagnostic => {
    if (diagnostic.code !== 'PTC-X001') return false
    const parts = [diagnostic.message, diagnostic.cause?.code, diagnostic.cause?.message]
      .filter(value => typeof value === 'string')
    const text = parts.join('\n')
    const causeCode = typeof diagnostic.cause?.code === 'string' ? diagnostic.cause.code.toUpperCase() : undefined
    if (causeCode !== undefined && PLATFORM_CAUSE_CODES.has(causeCode)
      && /\b(?:spawn|exec(?:ute)?|command|executable|shell|path|file)\b/i.test(text)) return true
    return /\b(?:spawn|exec(?:ute)?|child process)\b.*\b(?:ENOENT|ENOTDIR|EACCES|EINVAL)\b/i.test(text)
      || /command not found|no such file|not recognized as (?:an )?internal|cannot find (?:the )?(?:path|file)/i.test(text)
  })
}

function tipCandidate(view) {
  const { args, journal } = view.latestRun ?? {}
  if (args === undefined || journal === undefined) return undefined
  const codes = new Set(journal.diagnostics.map(diagnostic => diagnostic.code))
  if (codes.has('PTC-W001')) return {
    id: 'repeated-binding-failure',
    capability: journal.diagnostics.some(item => item.code === 'PTC-W001' && item.cause?.code === 'PTC-CAPABILITY'),
  }
  if (hasPlatformCommandDiagnostic(journal.diagnostics)) return { id: 'platform-command-failure' }
  return undefined
}

const TIP_BODY_SLOTS = Object.freeze({
  platform: PROMPT_SLOT_IDS.tipBodyPlatform,
  platformDetailed: PROMPT_SLOT_IDS.tipBodyPlatformDetailed,
  repeatedBinding: PROMPT_SLOT_IDS.tipBodyRepeatedBinding,
  repeatedBindingCapability: PROMPT_SLOT_IDS.tipBodyRepeatedBindingCapability,
})

const TIP_DETAIL_SLOTS = Object.freeze({
  binding: PROMPT_SLOT_IDS.tipDetailBinding,
  capability: PROMPT_SLOT_IDS.tipDetailCapability,
})

const TIP_PREFIX_SLOTS = Object.freeze({
  'repeated-binding-failure': PROMPT_SLOT_IDS.tipPrefixRepeatedBinding,
  'platform-command-failure': PROMPT_SLOT_IDS.tipPrefixPlatformCommand,
})

/**
 * Every delivered tip body reads its own registry slot; escalation only decides
 * whether the `{detail}` hole carries its sentence, and which of the two registered
 * detail slots fills it. Prefix and detail slots are read-only, so a customised body
 * cannot move tip identity or escalation.
 */
function renderTip(id, detailed, candidate = {}, prompt) {
  const body = (slotId, fallback) => prompt?.text(slotId) ?? fallback
  const prefix = body(TIP_PREFIX_SLOTS[id], TIP_PREFIXES[id])
  if (id === 'platform-command-failure') {
    const template = detailed
      ? body(TIP_BODY_SLOTS.platformDetailed, TIP_BODY_PLATFORM_DETAILED)
      : body(TIP_BODY_SLOTS.platform, TIP_BODY)
    return `${prefix} ${template.replace('{platformFacts}', PLATFORM_FACTS)}`
  }
  if (!candidate.capability) {
    const template = body(TIP_BODY_SLOTS.repeatedBinding, TIP_BODY_REPEATED_BINDING)
    const detail = detailed ? body(TIP_DETAIL_SLOTS.binding, TIP_DETAIL_BINDING) : ''
    return `${prefix} ${template.replace('{detail}', detail)}`
  }
  const template = body(TIP_BODY_SLOTS.repeatedBindingCapability, TIP_BODY_REPEATED_BINDING_CAPABILITY)
  const detail = detailed ? body(TIP_DETAIL_SLOTS.capability, TIP_DETAIL_CAPABILITY) : ''
  return `${prefix} ${template.replace('{detail}', detail)}`
}

export function latestRecoveryTip(view, config) {
  if (!config.enabled) return undefined
  const candidate = tipCandidate(view)
  if (candidate === undefined) return undefined
  // Cooldown, escalation, and ordinal are per trigger kind: one kind's tip must
  // not suppress a different kind.
  const lastTip = runtimeHistoryForView(view).tips[candidate.id]
  if (lastTip !== undefined && view.contextStep - lastTip.contextStep < config.cooldownMessages) return undefined
  const ordinal = (lastTip?.highestOrdinal ?? 0) + 1
  if (!Number.isSafeInteger(ordinal)) return undefined
  return {
    name: `${TIP_CONTEXT_PREFIX}${candidate.id}/${ordinal}`,
    text: renderTip(candidate.id, (lastTip?.unresolved ?? 0) >= config.escalationFailures, candidate, config.prompt),
  }
}
