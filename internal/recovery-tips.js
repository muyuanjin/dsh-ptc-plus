import { recoveryTipIdentity } from './runtime-messages.js'

const PLATFORM_CAUSE_CODES = new Set(['EACCES', 'EINVAL', 'ENOTDIR', 'ENOENT', 'UNKNOWN'])
const TIP_CONTEXT_PREFIX = 'tools:ptc-plus-tip/'
const TIP_PREFIXES = Object.freeze({
  'repeated-binding-failure': 'The same binding failure has recurred.',
  'platform-command-failure': 'An executable, shell, or path failed in the current execution world.',
})

// TODO(dsh-tips-api): replace this local provider with an adapter after dsh-tips publishes a stable facts and decision interface.
function tipHistory(view) {
  const active = new Map()
  const seen = new Set()
  const history = []
  const snapshots = [
    ...view.systemPromptSnapshots,
    ...(view.ptcMessages ?? []).filter(record => record.form === 'notice').map(record => ({
      ...record, sections: [{ name: record.name, text: record.text }],
    })),
  ].sort((left, right) => left.index - right.index)
  for (const snapshot of snapshots) {
    const next = new Map(snapshot.sections.map(section => [section.name, section.text]))
    for (const [name] of next) {
      if (active.has(name) || seen.has(name)) continue
      const identity = recoveryTipIdentity(name)
      if (identity === undefined) continue
      seen.add(name)
      history.push({ ...identity, index: snapshot.index, contextStep: snapshot.contextStep })
    }
    active.clear()
    for (const entry of next) active.set(...entry)
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
  const history = tipHistory(view)
  const lastTip = history.at(-1)
  if (lastTip !== undefined && view.contextStep - lastTip.contextStep < config.cooldownMessages) return undefined
  const unresolved = history.filter(item => item.id === candidate.id && item.index > (view.lastSuccessfulRunIndex ?? -1))
  const ordinal = history.reduce(
    (highest, item) => item.id === candidate.id ? Math.max(highest, item.ordinal) : highest,
    0,
  ) + 1
  if (!Number.isSafeInteger(ordinal)) return undefined
  return {
    name: `${TIP_CONTEXT_PREFIX}${candidate.id}/${ordinal}`,
    text: renderTip(candidate.id, unresolved.length >= config.escalationFailures, candidate),
  }
}
