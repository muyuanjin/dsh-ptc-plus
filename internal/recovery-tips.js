import { PTC_STATE_NAMES, recoveryTipIdentity } from './runtime-messages.js'

const PLATFORM_CAUSE_CODES = new Set(['EACCES', 'EINVAL', 'ENOTDIR', 'ENOENT', 'UNKNOWN'])
const TIP_CONTEXT_PREFIX = 'tools:ptc-plus-tip/'
const TIP_PREFIXES = Object.freeze({
  'repeated-binding-failure': 'The same binding failure has recurred.',
  'platform-command-failure': 'An executable, shell, or path failed in the current execution world.',
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

function renderTip(id, detailed, candidate = {}) {
  if (id === 'platform-command-failure') {
    return detailed
      ? `${TIP_PREFIXES[id]} Re-check the active execution world and the actual executable before retrying. Use direct argv for a normal executable; use a shell only when its syntax or resolution is required. Windows, WSL, POSIX, and package shims have different paths and launch rules.`
      : `${TIP_PREFIXES[id]} Inspect the executable or path in the current execution world and choose direct argv or a shell only when required; do not assume Windows, WSL, POSIX, or one shell.`
  }
  if (!candidate.capability) {
    return `${TIP_PREFIXES[id]} Inspect the visible cell source and results for the local name, scope, initialization, or declaration conflict. Correct that expression before continuing; capability discovery does not list session-local variables.${detailed ? ' Earlier statements may have run; use current expression evidence without assuming a failed declaration initialized its binding.' : ''}`
  }
  return detailed
    ? `${TIP_PREFIXES[id]} Inspect the live request with \`capabilities.tree()\`, \`capabilities.find()\`, or \`capabilities.inspect()\`, then call the typed member through \`tools.*\`. Do not invent hidden bindings or repeat the same failing expression.`
    : `${TIP_PREFIXES[id]} Inspect the live request with \`capabilities.tree()\`, \`capabilities.find()\`, or \`capabilities.inspect()\`, then call the typed member through \`tools.*\`.`
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
    text: renderTip(candidate.id, (lastTip?.unresolved ?? 0) >= config.escalationFailures, candidate),
  }
}
