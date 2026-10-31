import { capabilityPolicyForConfig, capabilityPolicyFromRecord, changeCapabilityRule, effectiveCapabilitySettings, CAPABILITY_DISCLOSURES, CAPABILITY_INVENTORY_CATEGORIES } from '../internal/capability-policy.js'
import { CONFIG_DEFAULTS, CONFIG_FIELDS } from '../internal/config-spec.js'
import { CAPABILITY_CONFIGURATION_KEYS, capabilityProfileConfiguration, validateCapabilityProfiles } from '../internal/runtime-config.js'
import { readCapabilityCommandReceipt } from '../internal/capability-command-receipt.js'
import { capabilitySortDirection, cycleCapabilitySort, sortCapabilityEntries } from './client-capability-sort.js'
import { createFallbackModal } from './client-primitives.js'
import {
  PROMPT_ASSETS, PROMPT_TEXT_MAX_SLOT_BYTES, PROMPT_TEXT_SCHEMA,
  accountPromptText, parsePromptTextDocument, resolvePromptText,
} from '../internal/prompt-text.js'

/**
 * The command's own outcome, in the reader's language.
 *
 * A receipt may report that it found no active PTC session to update. That is a
 * lookup result and a statement about what the command did not do, so the notice
 * says so; it is not a usability verdict about the session and no state is named
 * after one. Releases up to 0.5.4 recorded that lookup as the wire state
 * `unavailable`, so the mapping below keeps those recorded notices readable; the
 * chat notice is the only reader that can still meet one.
 */
const RECEIPT_STATE = Object.freeze({
  recorded: 'recorded', pending: 'pending', 'saved-only': 'saved-only',
  paused: 'paused', off: 'off', usage: 'usage', unavailable: 'no-session',
})
const receiptCopyKey = (surface, state) => `capabilities.${surface}.${RECEIPT_STATE[state] ?? 'usage'}`

/** The record one write named, in the §4 vocabulary the panel's columns use. */
function capabilityRecordText(t, record) {
  if (record === null || typeof record !== 'object' || typeof record.id !== 'string') return undefined
  return `${record.id} · ${record.dimension === undefined ? '' : `${t(`capabilities.dimension.${record.dimension}`)} `}`
    + t(`capabilities.word.${record.selection}`)
}

/**
 * One receipt, one sentence, in the reader's language.
 *
 * A receipt states the write this command performed: which entry, which choice,
 * and which session or global configuration now records it. Whether a cell later
 * reached that entry is a catalogue row's `evidence` field — a marker means an
 * accepted execution obtained it, and this page states no such column — so no
 * receipt states it. The chat card and the composer
 * toast read this one function; the `surface` argument picks which outcome
 * sentence describes the command, and a write that named a record reads the same
 * on both.
 */
export function capabilityReceiptNotice(t, receipt, surface = 'receipt') {
  const record = capabilityRecordText(t, receipt?.record)
  if (record !== undefined && receipt.state === 'recorded') {
    return t(`capabilities.receipt.record${receipt.record.scope === 'global' ? '.global' : ''}`,
      { session: receipt.sessionId, record })
  }
  return t(receiptCopyKey(surface, receipt?.state), { session: receipt?.sessionId, error: receipt?.error ?? '' })
}

export function capabilityCommandText(t, text) {
  if (text?.key) return t(text.key, text.params)
  const receipt = readCapabilityCommandReceipt(text)
  return receipt === undefined ? text : capabilityReceiptNotice(t, receipt, 'receipt')
}

// Host-owned context the model sees in PTC mode. The plugin never receives the host's
// own instruction text and cannot edit these bytes; it can only name the section it
// appends into or replaces. Listing them keeps the pane answering "what does the model
// actually see" instead of silently showing plugin-owned anchors only.
const HOST_CONTEXT_SECTIONS = Object.freeze([
  Object.freeze({ id: 'host:system-prompt', presence: 'capabilities.prompt.hostPresenceEvery' }),
  Object.freeze({ id: 'host:tools:sdk', presence: 'capabilities.prompt.hostPresenceCapabilities' }),
])
// The prompt table is one column model shared by the colgroup, the header and every
// data row. Slot chips do not get a column: they render in their own full-width
// sub-row, because a narrow chip column stacked a five-slot anchor into a tall stack.
const PROMPT_TABLE_COLUMN_KEYS = Object.freeze(['channel', 'anchor', 'presence', 'bytes', 'reason', 'kind'])
const PROMPT_TABLE_COLUMNS = PROMPT_TABLE_COLUMN_KEYS.length

function capabilityChoiceLabel(t, value) {
  return t(value === 'inherit' ? 'capabilities.quick.noOverride'
    : ['enabled', 'pending', 'unknown'].includes(value) ? `capabilities.quick.${value}`
      : [...selections, ...CAPABILITY_DISCLOSURES].includes(value) ? `capabilities.word.${value}` : 'capabilities.quick.unknown')
}

function capabilityRuleLabel(t, rule, empty = 'capabilities.policy.layerAbove') {
  const dimensions = ['availability', 'disclosure'].filter(dimension => rule?.[dimension] !== undefined)
  return dimensions.length ? dimensions.map(dimension => `${t(`capabilities.policy.${dimension}`)}: ${rule[dimension] === 'automatic'
    ? t('capabilities.policy.layerAbove') : capabilityChoiceLabel(t, rule[dimension])}`).join(' · ') : t(empty)
}

function validCatalogRule(rule, temporary = false) {
  return rule !== null && typeof rule === 'object' && !Array.isArray(rule)
    && Object.entries(rule).every(([dimension, choice]) => ['availability', 'disclosure'].includes(dimension)
      && (temporary && choice === 'automatic' || (dimension === 'availability'
        ? ['enabled', 'closed'].includes(choice) : CAPABILITY_DISCLOSURES.includes(choice))))
}

const CATALOG_DIMENSIONS = ['availability', 'disclosure']
// The panel's own word table, column by column: a dimension keeps the word naming
// where its value comes from, so the saved column can say `automatic` and the
// session column can also say `inherit`, and neither stands in for a decision.
const CATALOG_STATEMENT_WORDS = Object.freeze({
  saved: Object.freeze({ availability: ['enabled', 'closed', 'automatic'],
    disclosure: [...CAPABILITY_DISCLOSURES, 'automatic'] }),
  temporary: Object.freeze({ availability: ['enabled', 'closed', 'automatic', 'inherit'],
    disclosure: [...CAPABILITY_DISCLOSURES, 'automatic', 'inherit'] }),
})

/**
 * One column statement as the listing publishes it: the panel's value for the
 * dimensions that row decides.
 *
 * A capability row decides both dimensions and an MCP server row only
 * availability, so a statement is a dimension object with one or two entries.
 * Releases up to 0.5.4 stated one whole-selection word per column; a string stays
 * readable as that word, and the earlier independent-rule form stays readable as
 * the rule it was.
 */
function validCatalogStatement(column, value) {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const dimensions = Object.entries(value)
  // A dimension name resolves to this column's own word list or to nothing at all: an own
  // key such as `constructor` would otherwise reach an inherited function and throw while
  // the card is rendering, where every other out-of-table shape falls back to the source.
  return dimensions.length > 0 && dimensions.every(([dimension, choice]) =>
    Object.hasOwn(CATALOG_STATEMENT_WORDS[column], dimension)
      && CATALOG_STATEMENT_WORDS[column][dimension].includes(choice))
}

/** The panel's words for one statement, in the panel's column order. */
function catalogStatementLabel(t, statement) {
  return CATALOG_DIMENSIONS.filter(dimension => statement[dimension] !== undefined)
    .map(dimension => t(`capabilities.word.${statement[dimension]}`)).join(' · ')
}

// A Skill's declaring bucket is one of the public provider sources. A bucket this
// build does not name is stated beside the generic Skill source rather than denied.
const SKILL_SOURCE_BUCKETS = Object.freeze(['project-dsh', 'project-agents', 'user-dsh', 'user-agents',
  'runtime', 'bundled', 'custom'])

/** The declared MCP servers whose `mcp__<server>__` namespace begins one tool name. */
const mcpServersOf = source => Array.isArray(source?.servers)
  ? source.servers.filter(server => typeof server === 'string')
  : typeof source?.server === 'string' ? [source.server] : []

/**
 * The source a row states when its payload names none.
 *
 * A settings row can name an identity that only the saved configuration or a frozen
 * plan mentions. The identity still names its namespace — `tools.*` is the Host tool
 * registry's, `skills.*` is a Skill's, `mcp.*`/`mcpServers.*` is MCP's — and stating
 * the namespace is the same fact `inventory` states when no declared server names a
 * tool.
 */
const namespaceSource = entry => {
  const namespace = typeof entry.id === 'string' ? entry.id.slice(0, entry.id.indexOf('.')) : ''
  return { kind: namespace === 'skills' ? 'skill'
    : namespace === 'mcp' || namespace === 'mcpServers' ? 'mcp' : 'host' }
}

/**
 * The source column's statement for one declared row.
 *
 * `servers` is every declared MCP server whose namespace names the row. One name can
 * begin with two (`mcp__docs__deep__search` is named by `docs` and by `docs__deep`),
 * and then the column states both of them: a source column that cannot name its
 * source has nothing left to say but a denial, which §4 forbids. Payloads written
 * before that list travelled said `kind: 'unknown'`; they still state that several
 * servers match. Every other row states the source its payload names, or the
 * namespace its identity belongs to.
 */
function capabilitySourceText(t, entry) {
  // A server row is the declared server layer itself, so its source is MCP: naming
  // the server there would state the row's own name as its source.
  if (entry.kind === 'server') return t('capabilities.source.mcp')
  const source = entry.source ?? namespaceSource(entry)
  const servers = mcpServersOf(source)
  if (servers.length > 0) return servers.join(t('capabilities.source.separator'))
  if (source.kind === 'skill') {
    return SKILL_SOURCE_BUCKETS.includes(source.bucket) ? t(`capabilities.source.${source.bucket}`)
      : source.bucket ? `${t('capabilities.source.other-skill')} · ${source.bucket}` : t('capabilities.source.skill')
  }
  if (source.kind === 'unknown') return t('capabilities.source.multiple-servers')
  // A source kind this build does not name falls back to the namespace the identity
  // states, so each row keeps naming its own layer instead of another one's.
  const namespace = namespaceSource(entry).kind
  if (source.kind === 'mcp' || namespace === 'mcp') return t('capabilities.source.mcp')
  return t(`capabilities.source.${namespace === 'skill' ? 'skill' : 'host'}`)
}

/** A Chat snapshot without a node store cannot order a receipt against the conversation. */
const noSnapshot = () => undefined

/**
 * The first human message is the conversation's opening position. DSH may reuse
 * a blank Session, so capability commands recorded before that message are
 * history from an earlier attempt, not part of this conversation; they must not
 * appear above the user's first sentence.
 */
export function firstHumanMessageSeq(nodes) {
  if (nodes === null || nodes === undefined || typeof nodes.values !== 'function') return null
  let first = null
  for (const node of nodes.values()) {
    if (node?.kind !== 'user' || node.data?.source?.kind !== 'user') continue
    const seq = node.anchorSeq ?? node.data?.seq
    if (!Number.isSafeInteger(seq)) continue
    if (first === null || seq < first) first = seq
  }
  return first
}

/**
 * A capability receipt belongs to chat only after the conversation has opened.
 * A blank Session has nothing to announce, and a receipt recorded before the
 * first human message describes a previous attempt's publication. A truncated
 * Chat window cannot prove where the conversation opened, so its earliest
 * loaded message must not hide a receipt the session may still own.
 */
export function capabilityReceiptVisible(node, { blank = false, firstUserSeq = null, windowComplete = true } = {}) {
  if (blank === true) return false
  if (windowComplete !== true) return true
  return !(Number.isSafeInteger(node?.seq) && Number.isSafeInteger(firstUserSeq) && node.seq < firstUserSeq)
}

export function createCapabilityCommandCard(React) {
  const h = React.createElement
  return function CapabilityCommandCard({ node, t, useChat, useSession }) {
    const [showSource, setShowSource] = React.useState(false)
    // Both hooks are always called so the seat keeps one hook order whether or
    // not the surrounding Chat or Session supplies its store.
    const readSession = typeof useSession === 'function' ? useSession : noSnapshot
    const blank = readSession(snapshot => snapshot?.blank === true) === true
    // `hasMore` marks a window that does not reach the session start; only a
    // complete window may claim its earliest human message is the first one.
    const windowComplete = readSession(snapshot => snapshot?.hasMore !== true)
    const readChat = typeof useChat === 'function' ? useChat : noSnapshot
    const firstUserSeq = readChat(snapshot => firstHumanMessageSeq(snapshot?.nodes))
    // A capability notice is the outcome of a `/capabilities` command the user
    // submitted. What a new session publishes is a model-visible runtime context,
    // not chat, so a node without that submitted input is not a user command and
    // renders no notice: a fresh session has no change to announce.
    if (typeof node.args !== 'string') return null
    if (!capabilityReceiptVisible(node, { blank, firstUserSeq, windowComplete })) return null
    const command = `/${node.name ?? 'capabilities'}${node.args ? ` ${String(node.args).trim()}` : ''}`
    const text = node.outcome?.text
    const receipt = readCapabilityCommandReceipt(text)
    // Pending is the plan's publication state, not an outcome: it becomes true
    // only at the next accepted model step, so a durable notice would state a
    // future that a historical row can no longer verify.
    if (receipt?.state === 'pending') return null
    const legacyRefresh = text === 'Session capability environment refreshed; the model-visible notification is recorded.'
    if (receipt || String(node.args ?? '').trim() === 'refresh' || legacyRefresh) {
      // The notice a command leaves in chat is the same receipt the composer toast
      // and the panel's footer state, so no surface keeps its own account of a write.
      const outcome = receipt ? capabilityReceiptNotice(t, receipt, 'card')
        : legacyRefresh ? t('capabilities.card.recorded')
          : node.outcome ? (typeof text === 'string' && !text.trim() ? undefined : capabilityCommandText(t, text))
            ?? t(node.outcome.kind === 'error' ? 'capabilities.commandFailed' : 'capabilities.refreshAcknowledged')
            : t('capabilities.refreshing')
      return h('p', { className: 'ptcPlusCapabilityCommandNotice',
        role: node.outcome?.kind === 'error' ? 'alert' : 'status',
        'data-state': node.outcome?.kind ?? 'pending' }, outcome)
    }
    let json
    if (typeof text === 'string') {
      try { json = JSON.parse(text) } catch { /* Plain command outcomes remain readable text. */ }
    }
    // The listing states the saved column and this session's record; the composition
    // a runtime would build is not one of its entries, so the card states these two
    // columns and no third answer it could only guess.
    const entries = json?.schema === 'ptc-capability-catalog/v1' && Array.isArray(json.entries)
      && json.entries.every(entry => entry && typeof entry.id === 'string'
        && ['name', 'description'].every(key => entry[key] === undefined || typeof entry[key] === 'string')
        && ['saved', 'temporary'].every(key => entry[key] === undefined || validCatalogStatement(key, entry[key]))
        && ['savedRule', 'temporaryRule'].every(key => entry[key] === undefined || validCatalogRule(entry[key], key === 'temporaryRule'))) ? json.entries : null
    const outcome = entries ? t('capabilities.card.catalogCount', { count: entries.length })
      : json ? t('capabilities.card.details')
        : node.outcome ? capabilityCommandText(t, text)
          ?? t(node.outcome.kind === 'error' ? 'capabilities.commandFailed' : 'capabilities.refreshAcknowledged')
          : t('capabilities.refreshing')
    const label = (entry, key) => {
      if (typeof entry[key] === 'object') return catalogStatementLabel(t, entry[key])
      const rule = entry[key === 'saved' ? 'savedRule' : 'temporaryRule']
      return rule === undefined ? capabilityChoiceLabel(t, entry[key])
        : capabilityRuleLabel(t, rule, key === 'temporary' ? 'capabilities.quick.noOverride' : 'capabilities.policy.layerAbove')
    }
    return h('section', { className: 'ptcPlusCapabilityReceipt', 'aria-label': t('capabilities.receipt.title') },
      h('div', { className: 'ptcPlusCapabilityReceiptHead' },
        h('code', null, command),
        h('span', { className: 'ptcPlusCapabilityReceiptState', 'data-state': node.outcome?.kind ?? 'pending' },
          t(!node.outcome ? 'capabilities.card.running' : node.outcome.kind === 'error'
            ? 'capabilities.card.failed' : 'capabilities.card.completed'))),
      h('p', { className: 'ptcPlusCapabilityReceiptSummary', role: 'status' }, outcome),
      entries?.length ? h('details', { className: 'ptcPlusCapabilityReceiptCatalog' },
        h('summary', null, t('capabilities.card.browse')),
        h('div', { className: 'ptcPlusCapabilityReceiptTable' }, h('table', null,
          h('thead', null, h('tr', null, ...['member', 'quick.globalSaved', 'quick.temporary']
            .map(key => h('th', { key, scope: 'col' }, t(`capabilities.${key}`))))),
          h('tbody', null, ...entries.map((entry, index) => h('tr', { key: `${entry.id}-${index}` },
            h('td', null, h('strong', null, entry.name ?? entry.id),
              entry.description ? h('small', null, entry.description) : null),
            ...['saved', 'temporary'].map(key => h('td', { key }, label(entry, key))))))))) : null,
      text ? h('details', { className: 'ptcPlusCapabilityReceiptSource',
        onToggle: event => setShowSource(event.currentTarget.open) },
        h('summary', null, t('capabilities.card.source')),
        showSource ? h('pre', null, text) : null) : null)
  }
}

const selections = ['automatic', 'full', 'on-demand', 'closed']
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const configurationId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
export function capabilityPlanReason(t, entry) {
  const known = ['manual-override', 'baseline-not-selected', 'baseline', 'coverage-below-threshold', 'statistical-coverage',
    'mcp-server-disabled', 'contract-budget', 'management-disabled', 'statistics-disabled', 'statistics-settings-invalid', 'statistics-data-invalid',
    'statistics-unavailable', 'workspace', 'global', 'host-disclosure', 'availability-rule', 'disclosure-rule']
  return [entry.reason, entry.statisticsReason].filter(Boolean)
    .map(reason => known.includes(reason) ? t(`capabilities.reason.${reason}`) : reason).join(' · ')
}

export function createCapabilitySettingsViews(React, { Select, Modal = createFallbackModal(React) }) {
  const h = React.createElement
  const field = key => CONFIG_FIELDS.find(item => item.key === key)
  // Each group owns one settings tab; the prompt text switch lives in the same
  // capabilities section, so 新会话设置 must list it or a saved choice would be
  // invisible there.
  // 新会话设置 is one row of equally sized choices. Groups only existed to give each
  // tab a caption; that produced a second row as soon as 提示文本 was added, so the
  // choices stay flat and the navigation target is decided by `onNavigate` instead.
  const responsibilities = ['rules', 'description', 'recovery', 'preview', 'statistics', 'promptText']
  const choicesFor = (configuration, plan) => {
    const historical = plan && ['ptc-capability-plan/v1', 'ptc-capability-plan/v3'].includes(plan.schema)
      && configuration && configuration.capabilityPolicy === undefined
    let statistics
    try { statistics = JSON.parse(configuration?.capabilityStatistics ?? 'null') } catch { statistics = null }
    return { historical, contextEnabled: plan ? plan.contextEnabled : configuration?.capabilityContextEnabled,
      enabled: configuration?.capabilityManagementEnabled ?? plan?.enabled,
      statistics,
      recoveryEnabled: configuration?.capabilityRecoveryEnabled ?? (historical ? plan.enabled : undefined),
      previewEnabled: configuration?.modelPreviewEnabled ?? (historical ? plan.enabled : undefined),
      // The switch is new: a stored configuration without it means "on", the
      // documented default, while an unreadable configuration stays unknown.
      promptTextEnabled: configuration === undefined ? undefined : configuration.capabilityPromptTextEnabled !== false }
  }
  const flagsFor = settings => ({ rules: settings.enabled, description: settings.enabled, statistics: settings.statistics?.enabled,
    recovery: settings.recoveryEnabled, preview: settings.previewEnabled, promptText: settings.promptTextEnabled })
  const choiceState = (retained, applied, key) => typeof retained[key] !== 'boolean' ? 'unknown'
    : retained[key] ? typeof applied[key] !== 'boolean' ? 'unknown' : applied[key] === false ? 'paused' : 'selected'
      : key === 'rules' || key === 'description' ? 'host' : 'unselected'

  function CombinationSummary({ value, configurationReady, plans, plansError, plansPending, plansStale, selectedSessionId,
    feedback, onNavigate, onReload, renderRefresh, renderPlans, t, id }) {
    const saved = choicesFor(configurationReady ? value : undefined)
    const retained = flagsFor(saved)
    const applied = flagsFor(effectiveCapabilitySettings(saved))
    const selected = responsibilities.filter(key => retained[key] === true)
    const effect = !configurationReady ? t('capabilities.combination.unknownSettings')
      : saved.contextEnabled === false ? t('capabilities.combination.pausedEffect')
        : selected.length === 0 ? t('capabilities.combination.hostEffect')
          : selected.length === 2 && selected.includes('rules') && selected.includes('description') ? t('capabilities.combination.rulesOnly')
            : t('capabilities.combination.selectedEffect', { features: selected.map(key => t(`capabilities.combination.${key}`)).join(t('capabilities.combination.separator')) })
    const plan = selectedSessionId ? plans?.find(item => item.sessionId === selectedSessionId) : undefined
    const frozen = plan && choicesFor(plan.configuration, plan.effective)
    const frozenRetained = frozen && flagsFor(frozen)
    const frozenApplied = frozen && flagsFor(effectiveCapabilitySettings(frozen))
    if (frozenApplied) {
      frozenApplied.rules = plan.effective.enabled
      frozenApplied.description = plan.effective.enabled
      if (frozen.historical && plan.effective.enabled === false) frozenApplied.statistics = false
    }
    const publication = ['accepted', 'pending', 'not-required'].includes(plan?.publication) ? plan.publication : 'unknown'
    const stale = !configurationReady || plansStale || Boolean(plansError) || plansPending
    return h('section', { className: 'ptcPlusCombination', 'aria-label': t('capabilities.combination.saved') },
      h('div', { className: 'ptcPlusTaskHead' }, h('h4', null, t('capabilities.combination.saved')),
        h('span', { className: 'ptcPlusCapabilitySaveState', role: 'status' }, feedback)),
      h('div', { className: 'ptcPlusCombinationChoices' }, ...responsibilities.map(key => {
        const state = choiceState(retained, applied, key)
        return h('button', { key, type: 'button', className: 'ptcPlusCombinationChoice', 'data-state': state,
          'data-choice': key,
          'aria-controls': key === 'promptText' ? `${id}-pane-prompt`
            : key === 'rules' || key === 'statistics' ? `${id}-pane-${key === 'rules' ? 'manual' : 'statistics'}`
              : `${id}-context-pane-${key}`,
          onClick: () => onNavigate(key) }, h('span', null, t(`capabilities.combination.${key}`)),
          h('small', null, t(`capabilities.combination.state.${state}`)))
      })),
      h('p', { className: 'ptcPlusDetail', role: 'status' }, effect),
      h('details', { className: 'ptcPlusCapabilitySessionTools' }, h('summary', { tabIndex: 0 }, t('capabilities.existingSessions')),
        renderRefresh?.(),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: onReload }, t('capabilities.reloadObservation')),
        h('div', { className: 'ptcPlusCombinationSession', 'aria-label': t('capabilities.combination.observed'), 'data-stale': stale },
          !selectedSessionId ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.combination.chooseTarget'))
            : h(React.Fragment, null,
              h('p', { className: 'ptcPlusDetail' }, t('capabilities.combination.target', { session: selectedSessionId })),
              plansPending ? h('p', { role: 'status' }, t('state.syncing')) : null,
              plansError ? h('p', { role: 'status' }, t('capabilities.combination.readFailed', { error: plansError })) : null,
              plan ? h(React.Fragment, null,
                h('p', { role: 'status', className: 'ptcPlusDetail' }, t('capabilities.combination.lastRead'), ' · ', t(`capabilities.combination.publication.${publication}`)),
                frozen.contextEnabled === undefined ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.combination.historical')) : null,
                h('div', { className: 'ptcPlusCombinationFacts' }, ...responsibilities.map(key => h('span', { key },
                  t(`capabilities.combination.${key}`), ' · ', t(`capabilities.combination.state.${choiceState(frozenRetained, frozenApplied, key)}`)))),
                h('p', { role: 'status', className: 'ptcPlusDetail' }, t(stale ? 'capabilities.combination.stale'
                  : typeof plan.pendingRefresh !== 'boolean' ? 'capabilities.combination.differenceUnknown'
                    : plan.pendingRefresh ? 'capabilities.combination.different' : 'capabilities.combination.same')),
                Object.keys(plan.sessionOverrides ?? {}).length ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.combination.overrides')) : null,
                h('details', null, h('summary', { tabIndex: 0 }, t('capabilities.combination.inspectPlan')), renderPlans?.()))
                : !plansPending ? h('p', { role: 'status', className: 'ptcPlusDetail' }, t('capabilities.combination.noPlan')) : null)))
    )
  }

  function PolicyRules({ value, disabled, onChange, t }) {
    // This window edits the record's own document. A configuration that saved no policy has only
    // a synthesized document, whose bottom layer the capability-management switch shaped, so the
    // editor starts from the record's written layers instead of freezing that layer into the
    // record on the first edit (capability-surface §8.1c).
    const policy = value.capabilityPolicySaved === true
      ? capabilityPolicyForConfig(value) : capabilityPolicyFromRecord(value)
    const write = next => onChange(field('capabilityPolicy'), JSON.stringify(next))
    const ruleControls = (rule, update, label, defaults = false) => h('div', { className: 'ptcPlusPolicyRule', key: label },
      h('strong', null, label), ...['availability', 'disclosure'].map(dimension => h('div', { className: 'ptcPlusCapabilityFilter', key: dimension },
        h('span', null, t(`capabilities.policy.${dimension}`)), h(Select, {
          label: `${label} · ${t(`capabilities.policy.${dimension}`)}`, disabled: disabled('capabilityPolicy'),
          value: rule[dimension] ?? 'automatic', onChange: choice => {
            const next = { ...rule }; if (choice === 'automatic') delete next[dimension]; else next[dimension] = choice; update(next)
          }, options: [...(defaults ? [] : ['automatic']), ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)]
            .map(choice => ({ value: choice, label: t(choice === 'automatic' ? 'capabilities.policy.layerAbove' : `capabilities.word.${choice}`) })) }))))
    return h('section', { className: 'ptcPlusPolicyRules', 'aria-label': t('capabilities.policy.rules') },
      h('h4', null, t('capabilities.inheritedRules')), h('p', { className: 'ptcPlusDetail' }, t('capabilities.inheritedRulesHelp')),
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.policy.precedence')),
      ruleControls(policy.defaults, defaults => write({ ...policy, defaults }), t('capabilities.policy.default'), true),
      h('details', null, h('summary', { tabIndex: 0 }, t('capabilities.policy.categories')),
        ...Object.values(CAPABILITY_INVENTORY_CATEGORIES).map(category => ruleControls(policy.categories[category] ?? {}, rule =>
          write({ ...policy, categories: { ...policy.categories, [category]: rule } }), t(`capabilities.policy.category.${category}`)))),
      h('details', null, h('summary', { tabIndex: 0 }, t('capabilities.sourceRules')),
        ...[...new Set(Object.keys(policy.mcpServers))].sort(compare)
          .map(server => ruleControls(policy.mcpServers[server] ?? {}, rule =>
            write(changeCapabilityRule(changeCapabilityRule(policy, `mcpServers.${server}`, 'availability', rule.availability ?? 'automatic'),
              `mcpServers.${server}`, 'disclosure', rule.disclosure ?? 'automatic')), server))))

  }

  /** Capability-group edits open their own window; the group never expands controls into the settings page. */
  function CapabilityDialog({ title, onClose, t, className, children, footer }) {
    return h(Modal, { open: true, onClose, title, closeLabel: t('capabilities.closeDialog'), headless: true,
      className: `ptcPlusCapabilityDialog ${className ?? ''}`.trim() },
      h('div', { className: 'ptcPlusCapabilityDialogHead' }, h('h2', null, title),
        h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('capabilities.closeDialog'),
          onClick: onClose }, '\u00d7')),
      h('div', { className: 'ptcPlusCapabilityDialogBody' }, children),
      footer ? h('div', { className: 'ptcPlusCapabilityDialogFooter' }, footer) : null)
  }

  function AllocationEvidence({ allocation, allocationError, allocationPending, selectedSessionId, statistics = false, onReload, t }) {
    const [statisticsScope, setStatisticsScope] = React.useState('workspace')
    if (allocationPending) return h('p', { role: 'status' }, t('state.syncing'))
    if (allocationError) return h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.unavailable', { error: allocationError }))
    if (!allocation) return selectedSessionId ? h('p', { className: 'ptcPlusCapabilityNotice' }, t('capabilities.observationNotRead')) : null
    const { plan, coverage, configuration } = allocation
    const count = selection => plan.entries.filter(entry => entry.selection === selection).length
    const evidenceFor = item => coverage?.[item.id]?.[statisticsScope]
    const usable = evidence => evidence?.status === 'usable' && Number.isFinite(evidence.used) && Number.isFinite(evidence.eligible)
    // Only the sample states the evidence itself reports have a name here. Any other
    // value describes the samples the read did not deliver, never a capability state.
    const SAMPLE_STATES = ['no-samples', 'pending-settlement', 'incomplete-window', 'capacity-exceeded']
    const sampleText = evidence => SAMPLE_STATES.includes(evidence?.status)
      ? t(`capabilities.statStatus.${evidence.status}`) : t('capabilities.statStatus.not-reported')
    const coverageText = evidence => usable(evidence) && Number.isFinite(evidence.coverage) ? `${Math.round(evidence.coverage * 100)}%`
      : usable(evidence) ? t('capabilities.statStatus.no-samples')
        : sampleText(evidence)
    return h('section', { className: 'ptcPlusAllocationEvidence', 'aria-label': t(statistics ? 'capabilities.observedUsage' : 'capabilities.budgetPreview') },
      h('div', { className: 'ptcPlusCapabilityResultLine' }, h('h4', null, t(statistics ? 'capabilities.observedUsage' : 'capabilities.budgetPreview')),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: onReload }, t('capabilities.reloadObservation'))),
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.observationScope', { workspace: allocation.workspace, session: allocation.sessionId })),
      h('p', { className: 'ptcPlusDetail' }, t(statistics ? 'capabilities.familyHint' : 'capabilities.previewHint')),
      statistics ? h(Select, { value: statisticsScope, label: t('capabilities.coverageScope'), onChange: setStatisticsScope,
        options: ['workspace', 'global'].map(key => ({ value: key, label: t(`capabilities.scope.${key}`) })) }) : null,
      !statistics ? h('p', { className: 'ptcPlusCapabilityNotice' }, t('capabilities.coldStartHint')) : null,
      !statistics ? h(React.Fragment, null,
        h('div', { className: 'ptcPlusAllocationMetrics' },
          ...['full', 'on-demand', 'closed'].map(selection => h('div', { key: selection }, h('strong', null, count(selection)), h('span', null, t(`capabilities.word.${selection}`)))),
          h('div', null, h('strong', null, `${plan.budgets.contractBytes} / ${configuration.capabilityBudgetBytes}`), h('span', null, 'UTF-8 bytes'))),
        h('progress', { max: configuration.capabilityBudgetBytes, value: Math.min(configuration.capabilityBudgetBytes, plan.budgets.contractBytes),
          'aria-label': t('capabilities.budgetPreview') }),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.budget', { bytes: plan.budgets.contractBytes, overage: plan.budgets.overageBytes })),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.directoryUsage', { bytes: plan.budgets.directoryBytes, budget: configuration.capabilityDirectoryBytes })),
        !plan.enabled ? h('p', { className: 'ptcPlusCapabilityNotice' }, t('capabilities.managementOff')) : null)
        : coverage === null ? h('p', { role: 'status' }, t('capabilities.statStatus.not-reported')) : null,
      h('div', { className: 'ptcPlusCapabilityEvidenceTable' }, h('table', null,
        h('thead', null, h('tr', null, ...[t('capabilities.member'), ...(statistics
          ? [t('capabilities.usedFamilies'), t('capabilities.eligibleFamilies'), t('capabilities.coverageColumn')]
          : [t('capabilities.selection'), t('capabilities.reason'), t('capabilities.contractSize')])].map((label, key) => h('th', { key }, label)))),
        h('tbody', null, ...allocation.capabilities.map(item => {
          const entry = plan.entries.find(entry => entry.id === item.id)
          return h('tr', { key: item.id }, h('td', null, item.id), ...(statistics
            ? [h('td', { key: 'used' }, usable(evidenceFor(item)) ? evidenceFor(item).used : '—'),
              h('td', { key: 'eligible' }, usable(evidenceFor(item)) ? evidenceFor(item).eligible : '—'),
              h('td', { key: 'coverage' }, coverageText(evidenceFor(item)), usable(evidenceFor(item)) && Number.isFinite(evidenceFor(item).coverage)
                ? h('progress', { max: 1, value: evidenceFor(item).coverage, 'aria-label': t('capabilities.coverageFor', { name: item.id }) }) : null)]
            : [h('td', { key: 'selection' }, t(`capabilities.word.${entry?.selection ?? 'host'}`)), h('td', { key: 'reason' }, entry ? capabilityPlanReason(t, entry) : '—'), h('td', { key: 'size' }, `${item.contractBytes} B`)]))
        })))))
  }

  function ConfigurationProfiles({ value, plans, disabled, writable, onChange, onApplyConfiguration, t }) {
    const library = validateCapabilityProfiles(JSON.parse(value.capabilityProfiles ?? CONFIG_DEFAULTS.capabilityProfiles))
    const [selectedId, setSelectedId] = React.useState('')
    const [action, setAction] = React.useState(null)
    const [name, setName] = React.useState('')
    const [rename, setRename] = React.useState('')
    const [copyName, setCopyName] = React.useState('')
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [sessionId, setSessionId] = React.useState('')
    const fileInput = React.useRef(null)
    const saveAction = React.useRef(null)
    const returnToLibrary = React.useRef(false)
    const live = React.useRef(null)
    const lifecycle = React.useRef(0)
    const mounted = React.useRef(true)
    const running = React.useRef(null)
    const unavailable = disabled('capabilityProfiles') || busy
    live.current = { library, writable }
    React.useEffect(() => { mounted.current = true; return () => { lifecycle.current++; mounted.current = false } }, [])
    React.useEffect(() => {
      if (!writable) { lifecycle.current++; running.current = null; setBusy(false) }
    }, [writable])
    React.useLayoutEffect(() => {
      if (!busy && returnToLibrary.current) {
        returnToLibrary.current = false
        saveAction.current?.focus({ preventScroll: true })
      }
    }, [busy])
    const finishAction = () => { returnToLibrary.current = true; setAction(null) }
    const selected = library.profiles.find(profile => profile.id === selectedId) ?? library.profiles[0]
    const current = () => capabilityProfileConfiguration(Object.fromEntries(CAPABILITY_CONFIGURATION_KEYS.map(key => [key, value[key]])))
    const perform = async (area, operation) => {
      if (!mounted.current || !live.current?.writable || running.current) return
      const token = { area }
      running.current = token
      const generation = lifecycle.current
      setBusy(true); setStatus(null)
      const assertCurrent = () => {
        if (!mounted.current || !live.current?.writable || generation !== lifecycle.current) throw new Error(t('capabilities.configurationUnavailable'))
      }
      try { await operation(assertCurrent); if (generation === lifecycle.current) setStatus({ area, key: 'capabilities.configurationSaved' }) }
      catch (error) { if (generation === lifecycle.current) setStatus({ area, error: String(error?.message ?? error) }) }
      finally { if (running.current === token) running.current = null; if (generation === lifecycle.current) setBusy(false) }
    }
    const saveLibrary = async profiles => {
      if (!mounted.current || !live.current?.writable) throw new Error(t('capabilities.configurationUnavailable'))
      const next = validateCapabilityProfiles({ schema: library.schema, profiles })
      if (!await onChange(field('capabilityProfiles'), JSON.stringify(next))) throw new Error(t('capabilities.configurationUnavailable'))
    }
    const save = async (configuration, requestedName = name) => {
      const existing = library.profiles.find(profile => profile.name === requestedName.trim())
      const profile = { id: existing?.id ?? configurationId(), name: requestedName.trim(), configuration }
      await saveLibrary([...library.profiles.filter(item => item.id !== profile.id), profile])
      setSelectedId(profile.id)
      setRename(profile.name)
      finishAction()
    }
    const exportProfiles = (scope = 'all') => {
      const document = { schema: library.schema, profiles: scope === 'selected' && selected ? [selected] : library.profiles }
      const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2) + '\n'], { type: 'application/json' }))
      const link = globalThis.document.createElement('a')
      link.href = url; link.download = 'ptc-plus-capability-configurations.json'; link.click()
      const revoke = URL.revokeObjectURL.bind(URL)
      setTimeout(() => revoke(url), 0)
    }
    const importProfiles = event => {
      const file = event.target.files?.[0]; event.target.value = ''
      if (!file) return
      void perform('transfer', async assertCurrent => {
        if (file.size > 2_000_000) throw new Error(t('capabilities.configurationTooLarge'))
        const imported = validateCapabilityProfiles(JSON.parse(await file.text()))
        assertCurrent()
        const currentLibrary = live.current.library
        const names = new Set(currentLibrary.profiles.map(profile => profile.name))
        const merged = [...currentLibrary.profiles]
        for (const profile of imported.profiles) {
          let name = profile.name; let suffix = 2
          while (names.has(name)) name = `${profile.name.slice(0, 68)} (${suffix++})`
          names.add(name); merged.push({ ...profile, id: configurationId(), name })
        }
        await saveLibrary(merged)
      })
    }
    const feedback = status || busy ? h('p', { className: 'ptcPlusTaskFeedback', role: status?.error ? 'alert' : 'status' },
      status?.error ?? (busy ? t('state.syncing') : t(status.key))) : null
    const frozen = plans?.find(plan => plan.sessionId === sessionId)
    let matches = false
    try { matches = selected && JSON.stringify(selected.configuration) === JSON.stringify(current()) } catch {}
    const input = (label, text, update) => h('label', { className: 'ptcPlusCapabilityFilter' }, h('span', null, t(label)),
      h('input', { className: 'ptcPlusInput', value: text, maxLength: 80, disabled: unavailable,
        onChange: event => update(event.target.value), 'aria-label': t(label) }))
    const button = (label, click, blocked = false, extra = {}) => h('button', { type: 'button', className: 'ptcPlusButton',
      disabled: blocked, onClick: click, ...extra }, t(label))
    const closeAction = () => setAction(null)
    const setting = (label, text) => h('div', { className: 'ptcPlusConfigurationSummaryRow', key: label }, h('span', null, t(label)), h('span', null, text))
    const configuration = selected?.configuration
    const policy = configuration ? capabilityPolicyForConfig(configuration) : null
    const enabled = key => t(configuration[key] ? 'capabilities.serverOn' : 'capabilities.serverOff')
    return h('section', { className: 'ptcPlusConfigurationProfiles', 'aria-label': t('capabilities.savedConfigurations') },
      h('div', { className: 'ptcPlusConfigurationLibrary' }, h('h4', null, t('capabilities.savedConfigurations')),
        h('div', { className: 'ptcPlusConfigurationList', role: 'group', 'aria-label': t('capabilities.chooseConfiguration') },
          ...library.profiles.map(profile => h('button', { type: 'button', key: profile.id,
            className: 'ptcPlusConfigurationChoice', 'aria-pressed': selected?.id === profile.id,
            onClick: () => { setSelectedId(profile.id); setRename(profile.name); setAction(null) } }, profile.name)),
          !library.profiles.length ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.noConfigurations')) : null),
        button('capabilities.saveConfiguration', () => { setAction('save'); setStatus(null) }, unavailable,
          { ref: saveAction, className: 'ptcPlusButton ptcPlusConfigurationSave', 'aria-label': t('capabilities.saveConfiguration'), 'aria-haspopup': 'dialog' }),
        h('div', { className: 'ptcPlusConfigurationLibraryActions' },
          button('capabilities.importConfigurations', () => fileInput.current.click(), unavailable),
          h('button', { type: 'button', className: 'ptcPlusButton ptcPlusConfigurationMore', 'aria-label': t('capabilities.libraryMore'),
            'aria-haspopup': 'dialog', onClick: () => { setAction('library'); setStatus(null) } }, '···')),
        h('input', { ref: fileInput, type: 'file', accept: '.json,application/json', hidden: true, disabled: unavailable,
          onChange: importProfiles, 'aria-label': t('capabilities.importConfigurations') }),
        action === 'library' ? h(CapabilityDialog, { title: t('capabilities.libraryActions'), onClose: closeAction, t,
          className: 'ptcPlusCapabilityConfigurationDialog' },
          h('div', { className: 'ptcPlusCapabilityDialogActions' },
            button('capabilities.exportConfigurations', () => { exportProfiles('all'); closeAction() }, !library.profiles.length),
            button('capabilities.copyFromSession', () => { setAction('copy'); setStatus(null) }, unavailable))) : null,
        action === 'save' ? h(CapabilityDialog, { title: t('capabilities.saveConfiguration'), onClose: closeAction, t,
          className: 'ptcPlusCapabilityConfigurationDialog' },
          h('form', { className: 'ptcPlusConfigurationAction', onSubmit: event => {
            event.preventDefault(); if (!unavailable && name.trim()) void perform('save', () => save(current()))
          } }, input('capabilities.configurationName', name, setName),
            h('p', { className: 'ptcPlusDetail' }, t('capabilities.sameNameHint')),
            h('div', { className: 'ptcPlusCapabilityDialogActions' },
              h('button', { type: 'button', className: 'ptcPlusButton', onClick: closeAction }, t('capabilities.batch.cancel')),
              button('capabilities.confirmSave', undefined, unavailable || !name.trim(), { type: 'submit' })))) : null,
        action === 'copy' ? h(CapabilityDialog, { title: t('capabilities.copyFromSession'), onClose: closeAction, t,
          className: 'ptcPlusCapabilityConfigurationDialog' },
          h('div', { className: 'ptcPlusConfigurationAction' }, h('p', { className: 'ptcPlusDetail' }, t('capabilities.copySessionHint')),
            h(Select, { value: sessionId, disabled: unavailable, label: t('capabilities.copyFromSession'), onChange: setSessionId,
              options: [{ value: '', label: t('capabilities.chooseSession') }, ...(plans ?? []).map(plan => ({ value: plan.sessionId, label: plan.sessionId }))] }),
            input('capabilities.copyName', copyName, setCopyName),
            h('div', { className: 'ptcPlusCapabilityDialogActions' },
              h('button', { type: 'button', className: 'ptcPlusButton', onClick: closeAction }, t('capabilities.batch.cancel')),
              button('capabilities.saveSessionConfiguration', () => perform('copy', () => save(capabilityProfileConfiguration(frozen.configuration), copyName)),
                unavailable || !copyName.trim() || !frozen?.configuration)))) : null),
      h('div', { className: 'ptcPlusConfigurationDetail' }, selected ? h(React.Fragment, null,
        h('div', { className: 'ptcPlusTaskHead' }, h('h4', null, selected.name),
          button('capabilities.applyConfiguration', () => perform('library', () => onApplyConfiguration(selected.configuration)), unavailable || !onApplyConfiguration,
            { 'data-kind': 'primary' }),
          h('button', { type: 'button', className: 'ptcPlusButton ptcPlusConfigurationMore', 'aria-label': t('capabilities.profileMore'),
            'aria-haspopup': 'dialog', onClick: () => { setRename(selected.name); setAction('profile') } }, '···')),
        action === 'profile' ? h(CapabilityDialog, { title: t('capabilities.profileActions'), onClose: closeAction, t,
          className: 'ptcPlusCapabilityConfigurationDialog' },
          h('div', { className: 'ptcPlusCapabilityDialogActions' },
            button('capabilities.renameConfiguration', () => { setRename(selected.name); setAction('rename') }, unavailable),
            button('capabilities.exportConfiguration', () => { exportProfiles('selected'); closeAction() }),
            button('capabilities.deleteConfiguration', () => perform('library', async () => {
              await saveLibrary(library.profiles.filter(profile => profile.id !== selected.id)); setSelectedId(''); finishAction()
            }), unavailable, { 'data-kind': 'danger' }))) : null,
        h('div', { className: 'ptcPlusConfigurationSummary' },
          setting('group.capabilities', enabled('capabilityContextEnabled')),
          setting('capabilities.management', enabled('capabilityManagementEnabled')),
          setting('capabilities.statisticsEnabled', t(JSON.parse(configuration.capabilityStatistics).enabled ? 'capabilities.serverOn' : 'capabilities.serverOff')),
          setting('capabilities.defaultDisclosure', t(`capabilities.word.${policy.defaults.disclosure}`)),
          setting('capabilities.allocationTitle', ['baseline', 'statistics', 'budget'].filter(key => policy.allocation[key]).map(key => t(`capabilities.allocation.${key}`)).join(' · ') || '—'),
          setting('capabilities.recoveryEnabled', enabled('capabilityRecoveryEnabled')),
          setting('capabilities.previewEnabled', `${enabled('modelPreviewEnabled')}${configuration.modelPreviewEnabled ? ` · ${t('capabilities.estimatedTokens', { count: configuration.modelPreviewTokens })}` : ''}`),
          setting('capabilities.savedRules', t('capabilities.ruleCount', { count: Object.keys(policy.items).length + Object.keys(policy.categories).length + Object.keys(policy.mcpServers).length }))),
        h('details', { className: 'ptcPlusConfigurationRules' }, h('summary', null, t('capabilities.profileDetails')),
          h('div', { className: 'ptcPlusConfigurationSummary' },
            setting('capabilities.commonBaseline', JSON.parse(configuration.capabilityBaseline).join(' · ') || '—'),
            ...['categories', 'mcpServers', 'items'].flatMap(scope => Object.entries(policy[scope]).map(([name, rule]) =>
              setting(scope === 'categories' ? `capabilities.policy.category.${name}` : name, capabilityRuleLabel(t, rule)))),
            ...['capabilityBudgetBytes', 'capabilityDirectoryBytes', 'capabilityRecoveryBytes', 'modelPreviewTokens'].map(key => setting(`${key}.label`, configuration[key])),
            ...['windowSize', 'minimumSamples', 'fullThreshold'].map(key => setting(`capabilities.${key}`,
              key === 'fullThreshold' ? `${Math.round(JSON.parse(configuration.capabilityStatistics)[key] * 100)}%` : JSON.parse(configuration.capabilityStatistics)[key])))),
        h('p', { className: 'ptcPlusDetail' }, t(matches ? 'capabilities.configurationMatches' : 'capabilities.configurationDifferent')),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.configurationsHint')),
        action === 'rename' ? h(CapabilityDialog, { title: t('capabilities.renameConfiguration'), onClose: closeAction, t,
          className: 'ptcPlusCapabilityConfigurationDialog' },
          h('form', { className: 'ptcPlusConfigurationAction', onSubmit: event => {
            event.preventDefault(); if (!unavailable && rename.trim()) void perform('library', async () => {
              await saveLibrary(library.profiles.map(profile => profile.id === selected.id ? { ...profile, name: rename.trim() } : profile)); finishAction()
            })
          } }, input('capabilities.renameTo', rename, setRename),
            h('div', { className: 'ptcPlusCapabilityDialogActions' },
              h('button', { type: 'button', className: 'ptcPlusButton', onClick: closeAction }, t('capabilities.batch.cancel')),
              button('capabilities.confirmRename', undefined, unavailable || !rename.trim(), { type: 'submit' })))) : null)
        : h('p', { className: 'ptcPlusDetail' }, t('capabilities.chooseConfiguration'))), feedback)
  }

  function ContextSettings({ value, configurationReady, disabled, onChange, t, renderField, allocation, allocationError, allocationPending, selectedSessionId, onReload, renderRefresh, id, section, setSection }) {
    const sections = ['description', 'recovery', 'preview']
    const saved = choicesFor(configurationReady ? value : undefined)
    const retained = flagsFor(saved)
    const applied = flagsFor(effectiveCapabilitySettings(saved))
    // This pane states and writes the record's own rules: a configuration that saved no policy
    // starts from the declared defaults plus the override record, so the synthesized bottom layer
    // is neither shown as a saved default nor frozen into the record (§8.1c).
    const policy = value.capabilityPolicySaved === true
      ? capabilityPolicyForConfig(value) : capabilityPolicyFromRecord(value)
    const write = next => onChange(field('capabilityPolicy'), JSON.stringify(next))
    const adaptive = [policy.defaults, ...Object.values(policy.categories), ...Object.values(policy.mcpServers), ...Object.values(policy.items)]
      .some(rule => rule.disclosure === 'adaptive')
    const summary = key => {
      if (choiceState(retained, applied, key) === 'unknown') return t('capabilities.combination.unknownSettings')
      if (key === 'description') {
        const description = t('capabilities.context.summary.description', { disclosure: t(`capabilities.word.${policy.defaults.disclosure}`) })
        if (policy.defaults.disclosure !== 'adaptive') return description
        const criteria = ['baseline', 'statistics', 'budget'].filter(key => policy.allocation[key])
          .map(key => t(`capabilities.allocation.${key}`)).join(t('capabilities.combination.separator'))
        return `${description} · ${criteria || t('capabilities.context.summary.noCriteria')}`
      }
      return t(`capabilities.context.summary.${key}`, key === 'recovery'
        ? { bytes: value.capabilityRecoveryBytes } : { tokens: value.modelPreviewTokens })
    }
    const effect = key => t(!configurationReady ? 'capabilities.combination.unknownSettings'
      : value.capabilityContextEnabled === false ? 'capabilities.effect.paused' : key)
    const criteria = h('section', { className: 'ptcPlusPolicyAllocation', 'aria-label': t('capabilities.allocationTitle') },
      h('h5', null, t('capabilities.allocationTitle')),
      h('div', { className: 'ptcPlusAllocationChoices' }, ...['baseline', 'statistics', 'budget'].map(key => h('label', { key },
        h('input', { type: 'checkbox', role: 'switch', disabled: disabled('capabilityPolicy'), checked: policy.allocation[key],
          'aria-label': t(`capabilities.policy.allocate.${key}`),
          onChange: event => write({ ...policy, allocation: { ...policy.allocation, [key]: event.target.checked } }) }),
        h('span', null, t(`capabilities.allocation.${key}`))))),
      h('p', { className: 'ptcPlusDetail' }, effect(value.capabilityManagementEnabled !== true ? 'capabilities.effect.rulesOff'
        : adaptive ? 'capabilities.effect.allocationActive' : 'capabilities.effect.allocationRetained')),
      policy.allocation.statistics ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.effect.historicalStatistics')) : null,
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.effect.allocationLimits')))
    const feature = (key, label) => h('label', { className: 'ptcPlusRow' }, h('span', { className: 'ptcPlusMain' }, t(label)),
      h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value[key] === true,
        disabled: disabled(key), 'aria-label': t(label), onChange: event => onChange(field(key), event.target.checked) }))
    return h('div', { className: 'ptcPlusContextLayout' },
      h('div', { className: 'ptcPlusContextNavigation', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('capabilities.contextNavigation') },
        ...sections.map((key, index) => {
          const state = choiceState(retained, applied, key)
          const paused = state === 'paused'
          return h('button', { key, type: 'button', role: 'tab', id: `${id}-context-tab-${key}`,
            'aria-label': t(`capabilities.context.${key}`), 'aria-describedby': `${id}-context-state-${key} ${id}-context-summary-${key}`,
            'aria-controls': `${id}-context-pane-${key}`, 'aria-selected': section === key, tabIndex: section === key ? 0 : -1,
            onClick: () => setSection(key), onKeyDown: event => navigateTabs(event, sections, index, setSection),
          }, h('span', null, t(`capabilities.context.${key}`)),
          h('span', { className: 'ptcPlusContextState', id: `${id}-context-state-${key}`, 'data-enabled': state === 'selected',
            'data-paused': paused }, t(`capabilities.combination.state.${state}`)),
          h('span', { className: 'ptcPlusContextSummary', id: `${id}-context-summary-${key}` }, summary(key)))
        })),
      h('div', { className: 'ptcPlusContextContent' }, ...sections.map(key => h('section', { key, role: 'tabpanel',
        id: `${id}-context-pane-${key}`, 'aria-labelledby': `${id}-context-tab-${key}`, hidden: section !== key },
        h('h4', null, t(`capabilities.context.${key}`)),
        key === 'description' ? h(React.Fragment, null,
          h('p', { className: 'ptcPlusDetail' }, t('capabilities.descriptionHelp')),
          h('p', { className: 'ptcPlusDetail' }, t('capabilities.descriptionDependency')),
          h('div', { className: 'ptcPlusCapabilityFilter' }, h('span', null, t('capabilities.defaultDisclosure')),
            h(Select, { value: policy.defaults.disclosure, disabled: disabled('capabilityPolicy'), label: t('capabilities.defaultDisclosure'),
              options: CAPABILITY_DISCLOSURES.map(choice => ({ value: choice, label: t(`capabilities.word.${choice}`) })),
              onChange: disclosure => write({ ...policy, defaults: { ...policy.defaults, disclosure } }) })),
          h('p', { className: 'ptcPlusDetail' }, effect(value.capabilityManagementEnabled !== true ? 'capabilities.effect.rulesOff' : `capabilities.effect.disclosure.${policy.defaults.disclosure}`)),
          criteria,
          h('section', { className: 'ptcPlusContextQuota', 'aria-label': t('capabilities.quotaSettings') }, h('h5', null, t('capabilities.quotaSettings')),
            ...['capabilityBudgetBytes', 'capabilityDirectoryBytes'].map(renderField)),
          value.capabilityManagementEnabled !== true ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.descriptionInactive')) : null,
          h('section', { className: 'ptcPlusAllocationPreview' },
            !allocation || allocationPending || allocationError ? h('h5', null, t('capabilities.budgetPreview')) : null,
            renderRefresh?.({ observation: true }), h(AllocationEvidence, { allocation, allocationError, allocationPending, selectedSessionId, onReload, t })))
          : key === 'recovery' ? h(React.Fragment, null,
            h('p', { className: 'ptcPlusDetail' }, t('capabilities.recoveryHelp')),
            feature('capabilityRecoveryEnabled', 'capabilities.recoveryEnabled'),
            h('p', { className: 'ptcPlusDetail' }, !configurationReady ? t('capabilities.combination.unknownSettings')
              : value.capabilityRecoveryEnabled === true ? effect('capabilities.effect.recoveryOn') : t('capabilities.effect.recoveryOff')),
            h('section', { className: 'ptcPlusContextQuota', 'aria-label': t('capabilities.quotaSettings') }, h('h5', null, t('capabilities.quotaSettings')), renderField('capabilityRecoveryBytes')))
            : h(React.Fragment, null, h('p', { className: 'ptcPlusDetail' }, t('capabilities.previewHelp')),
              feature('modelPreviewEnabled', 'capabilities.previewEnabled'),
              h('p', { className: 'ptcPlusDetail' }, !configurationReady ? t('capabilities.combination.unknownSettings')
                : value.modelPreviewEnabled === true ? effect('capabilities.effect.previewOn') : t('capabilities.effect.previewOff')),
              h('section', { className: 'ptcPlusContextQuota', 'aria-label': t('capabilities.quotaSettings') }, h('h5', null, t('capabilities.quotaSettings')), renderField('modelPreviewTokens')))))))
  }

  function navigateTabs(event, tabs, index, update) {
    const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
    const next = offset ? (index + offset + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (next === null) return
    event.preventDefault(); update(tabs[next])
    event.currentTarget.parentElement.querySelectorAll('[role=tab]')[next].focus({ preventScroll: true })
  }

  /**
   * Per-asset editor for the fixed prompt text the plugin writes.
   *
   * One row per registered asset: the built-in sentence stays visible as the
   * placeholder, so a user compares against it instead of a blank box. The
   * document is written through the normal settings path, which validates it;
   * a document the panel cannot read is reported here instead of blanking the
   * whole workbench.
   */
  // Registry codes are protocol identifiers. The pane shows a localized label and
  // keeps the raw code in the element title, so a Chinese UI never reads like a
  // dump of `fact-derived` / `protocol-exact-text` constants.
  const PROMPT_REASON_KEYS = Object.freeze({
    'fact-derived': 'factDerived',
    'aggregate-frozen': 'aggregateFrozen',
    'protocol-exact-text': 'protocolExactText',
    'protocol-structural': 'protocolStructural',
    'shadows-host': 'shadowsHost',
    'other-owner': 'otherOwner',
  })

  function promptReasonLabel(t, reason) {
    const key = PROMPT_REASON_KEYS[reason]
    return key === undefined ? reason : t(`capabilities.prompt.reason.${key}`)
  }

  function promptKindLabel(t, kind) {
    return kind === undefined ? '' : t(`capabilities.prompt.kind.${kind}`)
  }

  function PromptTextSettings({ value, disabled, onChange, t, id }) {
    let document
    let readError
    try {
      document = parsePromptTextDocument(value.promptText)
    } catch (error) {
      readError = error.message
      document = { schema: PROMPT_TEXT_SCHEMA, overrides: {} }
    }
    // The workbench receives `disabled` as a per-field predicate, not a boolean.
    // The feature's own pause switch is separate from the settings lock: off means
    // every channel falls back to the built-in text while the saved document stays.
    const paused = value.capabilityPromptTextEnabled === false
    const blocked = paused || disabled === true
      || (typeof disabled === 'function' && disabled('promptText') === true)
    const resolved = resolvePromptText(value.promptText)
    const account = accountPromptText(resolved)
    // The pane stages edits in a draft and writes the document once, so the fields
    // and the preview always describe the same pending bytes. 保存 writes the draft;
    // 取消 drops it; a saved document still differs from the built-ins, so reopening
    // the pane shows that difference without a draft.
    const [draft, setDraft] = React.useState(null)
    const [selectedAnchorId, setSelectedAnchorId] = React.useState(null)
    const anchorPanelRef = React.useRef(null)
    const [openSlots, setOpenSlots] = React.useState({})
    const overrides = draft ?? document.overrides
    const byteCount = text => new TextEncoder().encode(text).length
    const group = number => String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ')
    const bytePair = bytes => t('capabilities.prompt.bytesPair', {
      bytes: group(bytes), kb: (bytes / 1024).toFixed(1),
    })
    const write = next => onChange(CONFIG_FIELDS.find(field => field.key === 'promptText'),
      JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides: next }))
    const update = (slotId, next) => {
      const base = { ...overrides }
      if (next === undefined) delete base[slotId]
      else base[slotId] = next
      setDraft(base)
    }
    const save = () => {
      if (draft === null) return
      write(draft)
      setDraft(null)
    }
    const cancel = () => setDraft(null)
    const pending = draft !== null
    const unmeasuredSlots = account.counts.unmeasuredSlots
    const dynamicSlots = account.counts.dynamicSlots
    const unwiredAnchors = account.anchors.filter(anchor => anchor.wired !== true)
    const measuredBytes = account.owners.A + account.owners.B + account.owners.C
    const ownerOf = anchor => (anchor.owner === 'mixed' ? 'mixed' : anchor.owner)
    const ownerAnchors = key => account.anchors.filter(anchor => ownerOf(anchor) === key).length
    // Icons are monochrome inline SVG: the mockup's cards carry a glyph, and an
    // icon font or an emoji would bring its own colour into the settings surface.
    const icon = path => h('svg', {
      viewBox: '0 0 20 20', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    }, ...path.map((d, index) => h('path', { key: index, d })))
    const card = (key, labelKey, glyph) => {
      const mixed = key === 'mixed'
      const bytes = account.owners[key] ?? 0
      const value_ = mixed
        ? t('capabilities.prompt.cardMixed', { count: ownerAnchors('mixed') })
        : bytes > 0
          ? `${bytePair(bytes)} · ${t('capabilities.prompt.cardMetaAnchors', { count: ownerAnchors(key) })}`
          : t('capabilities.prompt.cardMetaAnchors', { count: ownerAnchors(key) })
      return h('div', { key, className: 'ptcPlusPromptCard', 'data-owner': key },
        h('span', { className: 'ptcPlusPromptCardIcon' }, glyph),
        h('span', { className: 'ptcPlusPromptCardBody' },
          h('span', { className: 'ptcPlusPromptCardLabel' }, t(labelKey)),
          mixed
            ? h('span', { className: 'ptcPlusPromptCardMeta' }, value_)
            : h('span', { className: 'ptcPlusPromptCardValue', 'data-owner-bytes': String(account.owners[key] ?? 0) }, value_)))
    }
    const cards = h('div', { className: 'ptcPlusPromptCards' },
      card('A', 'capabilities.prompt.ownerEditable', icon(['M4 16h3l9-9-3-3-9 9v3Z', 'M12.5 4.5 15.5 7.5'])),
      card('B', 'capabilities.prompt.ownerReadOnly', icon(['M5.5 9V6.5a4.5 4.5 0 0 1 9 0V9', 'M4.5 9h11v7h-11Z'])),
      card('C', 'capabilities.prompt.ownerOther', icon(['M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M4 17c0-3 2.7-5 6-5s6 2 6 5'])),
      card('mixed', 'capabilities.prompt.ownerMixed', icon(['M4 6h12', 'M4 10h12', 'M4 14h12', 'M13 4v4', 'M7 8v4'])))
    const strip = h('p', { className: 'ptcPlusPromptStrip', 'data-prompt-strip': String(unwiredAnchors.length) },
      t('capabilities.prompt.strip', {
        anchors: unwiredAnchors.length, bytes: group(measuredBytes),
        kb: (measuredBytes / 1024).toFixed(1), total: account.counts.total,
      }))
    const reasonsOf = anchor => {
      const reasons = [...new Set(anchor.slots.map(slot => slot.reason).filter(Boolean))]
      return reasons.length === 0 ? '—' : reasons.map(reason => promptReasonLabel(t, reason)).join(' + ')
    }
    const kindsOf = anchor => [...new Set(anchor.slots.map(slot => slot.kind))]
      .map(kind => promptKindLabel(t, kind)).join(' + ')
    const splitOf = anchor => {
      const measured = anchor.slots.filter(slot => slot.measured === true && slot.bytes > 0)
      return measured.length > 1
        ? t('capabilities.prompt.anchorBytesSplit', {
          parts: measured.map(slot => `${slot.slotId.split('.').pop()} ${slot.bytes}`).join(' / '),
        })
        : null
    }
    const select = anchorId => setSelectedAnchorId(anchorId)
    // The expanded panel sits below the table, so on a short viewport selecting a
    // lower row would otherwise leave the editor it opened off-screen.
    React.useEffect(() => {
      if (selectedAnchorId === null) return
      const node = anchorPanelRef.current
      if (node === null || typeof node.scrollIntoView !== 'function') return
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, [selectedAnchorId])
    const rowKey = (event, anchorId) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      select(anchorId)
    }
    const anchorRow = (anchor, index) => {
      const split = splitOf(anchor)
      return h('tr', {
        key: anchor.anchorId,
        className: 'ptcPlusPromptRow',
        'data-anchor-id': anchor.anchorId,
        'data-wired': anchor.wired === true ? 'true' : 'false',
        // A plain <table> row cannot carry aria-selected (that needs role="grid"),
        // so the expanded row is announced with aria-current instead.
        'data-selected': selectedAnchorId === anchor.anchorId ? 'true' : 'false',
        'aria-current': selectedAnchorId === anchor.anchorId ? 'true' : undefined,
        tabIndex: 0,
        onClick: () => select(anchor.anchorId),
        onKeyDown: event => rowKey(event, anchor.anchorId),
      },
        h('td', { className: 'ptcPlusPromptIndex' }, String(index)),
        h('td', null, h('span', { className: 'ptcPlusPromptChannel', 'data-channel': anchor.channel }, anchor.channel)),
        h('td', null, h('code', { className: 'ptcPlusPromptAnchorId', title: anchor.anchorId }, anchor.anchorId)),
        h('td', null, h('span', { className: 'ptcPlusPromptPresence', title: t(anchor.presence) }, t(anchor.presence))),
        h('td', { className: 'ptcPlusPromptBytesCell' },
          anchor.wired !== true
            ? h('span', { 'data-anchor-bytes': 'unwired' }, t('capabilities.prompt.unwiredRow', { slots: anchor.unmeasuredSlots }))
            : h('span', { 'data-anchor-bytes': String(anchor.bytes) },
              paused ? t('capabilities.prompt.pausedBytes', { bytes: anchor.bytes }) : t('capabilities.prompt.cardBytes', { bytes: anchor.bytes }),
              split === null ? null : h('small', { className: 'ptcPlusPromptSplit', 'data-anchor-split': 'true' }, split))),
        h('td', { className: 'ptcPlusPromptReasonCell' }, reasonsOf(anchor)),
        h('td', { className: 'ptcPlusPromptKindCell' }, kindsOf(anchor),
          anchor.wired !== true ? h('span', { className: 'ptcPlusPromptTag', 'data-prompt-unwired-tag': 'true' },
            t('capabilities.prompt.unwiredTag')) : null))
    }
    const hostRow = (section, index) => h('tr', {
      key: section.id, className: 'ptcPlusPromptRow ptcPlusPromptHostRow', 'data-host-row': section.id,
    },
      h('td', { className: 'ptcPlusPromptIndex' }, String(index)),
      h('td', null, h('span', { className: 'ptcPlusPromptChannel' }, 'prompt')),
      h('td', null, h('code', { className: 'ptcPlusPromptAnchorId', title: section.id }, section.id)),
      h('td', null, h('span', { className: 'ptcPlusPromptPresence' }, t(section.presence))),
      h('td', { className: 'ptcPlusPromptBytesCell' }, t('capabilities.prompt.hostUnavailable')),
      h('td', { className: 'ptcPlusPromptReasonCell' }, '—'),
      h('td', { className: 'ptcPlusPromptKindCell' }, t('capabilities.prompt.ownerHost')))
    const table = h('table', { className: 'ptcPlusPromptTable' },
      h('colgroup', null,
        h('col', { className: 'ptcPlusPromptColIndex' }),
        h('col', { className: 'ptcPlusPromptColChannel' }),
        h('col', { className: 'ptcPlusPromptColAnchor' }),
        h('col', { className: 'ptcPlusPromptColPresence' }),
        h('col', { className: 'ptcPlusPromptColBytes' }),
        h('col', { className: 'ptcPlusPromptColReason' }),
        h('col', { className: 'ptcPlusPromptColKind' })),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', className: 'ptcPlusPromptIndex' }, ''),
        h('th', { scope: 'col' }, t('capabilities.prompt.columnChannel')),
        h('th', { scope: 'col' }, t('capabilities.prompt.columnAnchor')),
        h('th', { scope: 'col' }, t('capabilities.prompt.columnPresence')),
        h('th', { scope: 'col' }, t('capabilities.prompt.columnBytesSplit')),
        h('th', { scope: 'col' }, t('capabilities.prompt.columnReason')),
        h('th', { scope: 'col' }, t('capabilities.prompt.columnKind')))),
      h('tbody', null,
        ...account.anchors.map((anchor, index) => anchorRow(anchor, index + 1)),
        ...HOST_CONTEXT_SECTIONS.map((section, index) => hostRow(section, account.anchors.length + index + 1))))
    const chip = (anchor, slot) => {
      const templateBytes = slot.measured === true && slot.kind === 'projected'
      const aggregateSet = slot.kind === 'aggregate'
      const shared = {
        className: 'ptcPlusPromptChip',
        'data-slot-id': slot.slotId,
        'data-slot-kind': slot.kind,
        ...(templateBytes ? { 'data-prompt-template-bytes': 'true' } : {}),
        ...(aggregateSet ? { 'data-prompt-aggregate-set': 'true' } : {}),
        title: templateBytes
          ? `${slot.slotId} · ${t('capabilities.prompt.templateBytes')}`
          : aggregateSet ? `${slot.slotId} · ${t('capabilities.prompt.aggregateFrozen')}` : slot.slotId,
      }
      if (slot.owner !== 'A') {
        return h('span', { key: slot.slotId, ...shared, 'data-readonly': 'true' },
          h('span', { className: 'ptcPlusPromptChipLabel' }, slot.slotId),
          h('span', { className: 'ptcPlusPromptChipNote' },
            t('capabilities.prompt.readonlyReason', { reason: promptReasonLabel(t, slot.reason), kind: promptKindLabel(t, slot.kind) })))
      }
      const selected = (openSlots[anchor.anchorId] ?? editableSlots(anchor)[0]?.slotId) === slot.slotId
      return h('button', {
        key: slot.slotId,
        ...shared,
        type: 'button',
        disabled: blocked,
        'aria-pressed': selected,
        onClick: () => setOpenSlots(previous => ({ ...previous, [anchor.anchorId]: slot.slotId })),
      }, h('span', { className: 'ptcPlusPromptChipLabel' }, slot.slotId))
    }
    // One editor per anchor: the chips choose which editable slot is open, so the
    // run_code anchor keeps its three descriptions behind one field.
    const editableSlots = anchor => anchor.slots.filter(slot => slot.owner === 'A'
      && PROMPT_ASSETS.find(candidate => candidate.id === slot.slotId)?.defaultText !== null)
    const editorFor = anchor => {
      const slots = editableSlots(anchor)
      if (anchor.wired !== true || slots.length === 0) return null
      const selectedId = openSlots[anchor.anchorId] ?? slots[0].slotId
      const slot = slots.find(candidate => candidate.slotId === selectedId) ?? slots[0]
      const asset = PROMPT_ASSETS.find(candidate => candidate.id === slot.slotId)
      const override = Object.hasOwn(overrides, slot.slotId) ? overrides[slot.slotId] : undefined
      const current = override ?? asset.defaultText
      // The built-in sentence is the field's value, not a placeholder: the user must be
      // able to tweak the shipped wording without retyping it.
      return h('div', { key: slot.slotId, className: 'ptcPlusPromptEditor', 'data-editor-slot': slot.slotId },
        h('textarea', {
          id: `${id}-prompt-${slot.slotId}`, rows: 3, disabled: blocked, spellCheck: false,
          className: 'ptcPlusPromptTextarea', 'aria-label': slot.slotId, value: current,
          onChange: event => update(slot.slotId, event.target.value === '' ? undefined : event.target.value),
        }),
        h('div', { className: 'ptcPlusPromptEditorFoot' },
          h('span', { className: 'ptcPlusPromptHint' },
            t('capabilities.prompt.bytesOfLimit', { used: byteCount(current), max: PROMPT_TEXT_MAX_SLOT_BYTES })),
          h('span', { className: 'ptcPlusPromptEditorActions' },
            asset.omittable ? h('button', {
              type: 'button', className: 'ptcPlusButton', disabled: blocked,
              onClick: () => update(slot.slotId, ''),
            }, t('capabilities.prompt.omit')) : null,
            h('button', {
              type: 'button', className: 'ptcPlusButton', disabled: blocked || override === undefined,
              onClick: () => update(slot.slotId, undefined),
            }, t('capabilities.prompt.reset')))))
    }
    const defaultAnchor = account.anchors.find(anchor => anchor.wired === true && editableSlots(anchor).length > 0)
    const selectedAnchor = account.anchors.find(anchor => anchor.anchorId === selectedAnchorId) ?? defaultAnchor
    const selectedIndex = selectedAnchor === undefined ? 0 : account.anchors.indexOf(selectedAnchor) + 1
    const anchorPanel = h('section', { className: 'ptcPlusPromptPanel', 'data-prompt-panel': 'anchor', ref: anchorPanelRef },
      h('h5', { className: 'ptcPlusPromptPanelTitle' },
        t('capabilities.prompt.rowExpand', { index: selectedIndex })),
      selectedAnchor === undefined
        ? h('p', { className: 'ptcPlusPromptHint' }, t('capabilities.prompt.rowExpandHint'))
        : h('div', { className: 'ptcPlusPromptPanelBody' },
          h('div', { className: 'ptcPlusPromptChips', 'data-anchor-chips': selectedAnchor.anchorId },
            ...selectedAnchor.slots.map(slot => chip(selectedAnchor, slot))),
          selectedAnchor.wired !== true
            ? h('p', { className: 'ptcPlusPromptHint' }, t('capabilities.prompt.unwiredRow', { slots: selectedAnchor.unmeasuredSlots }))
            : editorFor(selectedAnchor)))
    // Saving shows what will change. The preview is derived from the same draft the
    // editors write, so it cannot disagree with them; a saved document that already
    // differs from the built-ins shows here too, because saving would rewrite it.
    const changes = account.anchors.flatMap(anchor => anchor.slots
      .map(slot => ({ slot, builtin: PROMPT_ASSETS.find(asset => asset.id === slot.slotId)?.defaultText }))
      .filter(entry => typeof entry.builtin === 'string'
        && Object.hasOwn(overrides, entry.slot.slotId)
        && overrides[entry.slot.slotId] !== entry.builtin)
      .map(entry => {
        const effective = overrides[entry.slot.slotId]
        const effect = anchor.channel === 'plan' ? t('capabilities.prompt.effectPlan')
          : anchor.channel === 'install' ? t('capabilities.prompt.effectInstall')
            : anchor.channel === 'prompt' ? t('capabilities.prompt.effectPrompt')
              : t('capabilities.prompt.effectTrigger')
        return {
          anchor, slot: entry.slot, effect,
          before: byteCount(entry.builtin), after: byteCount(effective), delta: byteCount(effective) - byteCount(entry.builtin),
        }
      }))
    const restoreSlot = slotId => update(slotId, undefined)
    const diffPanel = h('section', {
      className: 'ptcPlusPromptPanel',
      ...(changes.length === 0 ? {} : { 'data-prompt-diff': 'true' }),
      'data-prompt-diff-panel': 'true',
    },
      h('h5', { className: 'ptcPlusPromptPanelTitle' }, t('capabilities.prompt.diffTitle')),
      changes.length === 0
        ? h('p', { className: 'ptcPlusPromptHint' }, t('capabilities.prompt.diffEmpty'))
        : h('ul', { className: 'ptcPlusPromptDiffList' },
          ...changes.map((entry, index) => h('li', {
            key: entry.slot.slotId, className: 'ptcPlusPromptDiffRow',
            'data-diff-anchor': entry.anchor.anchorId, 'data-diff-slot': entry.slot.slotId,
          },
            h('span', { className: 'ptcPlusPromptDot', 'data-tone': String(index % 3) }),
            h('span', { className: 'ptcPlusPromptDiffBody' },
              h('span', { className: 'ptcPlusPromptDiffHead' },
                h('code', { className: 'ptcPlusPromptDiffSlot' }, entry.slot.slotId),
                h('span', { className: 'ptcPlusPromptHint' }, entry.effect)),
              h('span', { className: 'ptcPlusPromptDiffDelta' },
                t('capabilities.prompt.diffBytes', {
                  before: group(entry.before), after: group(entry.after),
                  delta: entry.delta > 0 ? `+${group(entry.delta)}` : group(entry.delta),
                }),
                h('button', {
                  type: 'button', className: 'ptcPlusButton', disabled: blocked,
                  onClick: () => restoreSlot(entry.slot.slotId),
                }, t('capabilities.prompt.reset'))))))),
      h('div', { className: 'ptcPlusPromptActions' },
        h('button', {
          type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary', disabled: blocked || !pending,
          onClick: save,
        }, t('capabilities.prompt.save')),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: blocked || !pending, onClick: cancel },
          t('capabilities.prompt.cancel'))))
    return h('section', {
      className: 'ptcPlusPromptText', 'data-prompt-paused': paused ? 'true' : 'false',
    },
      h('header', { className: 'ptcPlusPromptHeader' },
        h('span', { className: 'ptcPlusPromptHeaderIcon' }, icon(['M10 2.5 12 8l5.5 2-5.5 2-2 5.5-2-5.5L2.5 10 8 8Z'])),
        h('span', { className: 'ptcPlusPromptHeaderBody' },
          h('h4', { className: 'ptcPlusPromptTitle' }, t('capabilities.prompt.title')),
          h('p', { className: 'ptcPlusPromptSubtitle' }, t('capabilities.prompt.subtitle')))),
      paused
        ? h('p', { className: 'ptcPlusPromptPaused', role: 'status', 'data-prompt-paused-notice': 'true' },
          t('capabilities.prompt.paused'))
        : null,
      readError === undefined ? null : h('p', { className: 'ptcPlusPromptHint' }, t('capabilities.prompt.unreadable', { error: readError })),
      ...resolved.reported.map((entry, index) => h('p', { key: `report-${index}`, className: 'ptcPlusPromptHint' },
        t('capabilities.prompt.reported', {
          asset: entry.slotId ?? entry.anchorId ?? 'document', reason: entry.reason,
        }))),
      cards,
      strip,
      h('p', { className: 'ptcPlusPromptHint', 'data-prompt-slot-counts': 'true' },
        t('capabilities.prompt.slotCounts', { bytes: group(measuredBytes), unmeasured: unmeasuredSlots, dynamic: dynamicSlots })),
      table,
      h('div', { className: 'ptcPlusPromptPanels' }, anchorPanel, diffPanel),
      h('p', { className: 'ptcPlusPromptIntro' }, t('capabilities.prompt.intro')))
  }

  function CapabilityWorkbench({ value, configurationReady, plans, plansError, plansPending, plansStale, disabled, onChange, onReload, t, renderField, renderPlans, renderRefresh, id, selectedSessionId, onSessionSelect,
    allocation, allocationError, allocationPending, onApplyConfiguration, configurationWritable, saving, saveStatus, surface }) {
    const [tab, setTab] = React.useState('manual')
    const [contextSection, setContextSection] = React.useState('description')
    const [rulesOpen, setRulesOpen] = React.useState(false)
    const tabs = ['manual', 'budgets', 'statistics', 'prompt', 'plans']
    const feedback = saving ? t('state.syncing') : saveStatus && saveStatus.key !== 'status.applied' ? t(saveStatus.key, saveStatus.params)
      : t(configurationWritable ? 'capabilities.savedForNew' : 'footer.readOnly')
    return h('div', { className: 'ptcPlusCapabilityWorkbench' },
      h(CombinationSummary, { value, configurationReady, plans, plansError, plansPending, plansStale, selectedSessionId,
        feedback, onReload, renderRefresh, renderPlans, t, id, onNavigate: key => {
          setTab(key === 'rules' ? 'manual' : key === 'statistics' ? 'statistics' : key === 'promptText' ? 'prompt' : 'budgets')
          if (['description', 'recovery', 'preview'].includes(key)) setContextSection(key)
        } }),
      h('div', { className: 'ptcPlusCapabilityTabs', role: 'tablist', 'aria-label': t('capabilities.settingsTabs') },
        ...tabs.map((key, index) => h('button', { key, type: 'button', role: 'tab', id: `${id}-tab-${key}`,
          'aria-controls': `${id}-pane-${key}`, 'aria-selected': tab === key, tabIndex: tab === key ? 0 : -1,
          onClick: () => setTab(key), onKeyDown: event => navigateTabs(event, tabs, index, setTab),
        }, t(`capabilities.tab.${key}`)))),
      ...tabs.map(key => h('div', { key, className: 'ptcPlusCapabilityPane', role: 'tabpanel', id: `${id}-pane-${key}`,
        'aria-labelledby': `${id}-tab-${key}`, hidden: tab !== key },
        key === 'prompt' ? null : h('div', { className: 'ptcPlusTaskHead' }, h('h4', null, t(`capabilities.title.${key}`)),
          key === 'manual' ? h('label', { className: 'ptcPlusCapabilityManagement' }, h('span', null, t('capabilities.management')),
            h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value.capabilityManagementEnabled === true,
              disabled: disabled('capabilityManagementEnabled'), 'aria-label': t('capabilities.management'),
              onChange: event => onChange(field('capabilityManagementEnabled'), event.target.checked) })) : null),
        key === 'manual' ? h(React.Fragment, null, h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false ? 'capabilities.effect.paused'
          : value.capabilityManagementEnabled === true ? 'capabilities.managementHelp' : 'capabilities.effect.rulesOff')),
          // The capability page is one renderer mounted here with the address this
          // entrance fixes. This entrance brings no columns, words, controls or
          // receipts of its own; the rule chain that answers for objects the saved
          // address has not decided one by one stays a rule editor beside it.
          h('div', { className: 'ptcPlusCapabilityRulesEntry' },
            h('button', { type: 'button', className: 'ptcPlusButton', 'aria-haspopup': 'dialog',
              onClick: () => setRulesOpen(true) }, t('capabilities.inheritedRules'))),
          rulesOpen ? h(CapabilityDialog, { title: t('capabilities.inheritedRules'), onClose: () => setRulesOpen(false), t,
            footer: h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary',
              onClick: () => setRulesOpen(false) }, t('capabilities.dialogDone')) },
            h(PolicyRules, { value, disabled, onChange, t })) : null,
          surface ?? null)
          : key === 'statistics' ? h(React.Fragment, null, renderField('capabilityStatistics'),
            h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false ? 'capabilities.effect.paused'
              : choicesFor(value).statistics?.enabled === true ? 'capabilities.effect.collectionOn'
                : choicesFor(value).statistics?.enabled === false ? 'capabilities.effect.collectionOff' : 'capabilities.combination.unknownSettings')),
            h('p', { className: 'ptcPlusDetail' }, t('capabilities.effect.statisticsIndependent')),
            renderRefresh?.({ observation: true }),
            h(AllocationEvidence, { allocation, allocationError, allocationPending, selectedSessionId, statistics: true, onReload, t }))
            : key === 'budgets' ? h(ContextSettings, { value, configurationReady, disabled, onChange, t, renderField, allocation, allocationError, allocationPending,
              selectedSessionId, onReload, renderRefresh, id, section: contextSection, setSection: setContextSection })
              // Rendered only while its tab is active: eight idle textareas in a hidden
              // pane would change every generic textbox query in the settings card.
              : key === 'prompt' ? (tab === 'prompt' ? h(PromptTextSettings, { value, disabled, onChange, t, id }) : null)
                : h(ConfigurationProfiles, { value, plans, disabled, writable: configurationWritable, onChange, onApplyConfiguration, t }))))
  }

  return { CapabilityWorkbench }
}

/**
 * Execute a human command through DSH; a receipt never stands in for model publication.
 *
 * The button asks the command channel to run the same `refresh` line a human types.
 * The channel publishes nothing until a session observes it, so the button keeps its
 * own observation open; that observation decides no branch here. Whether the session
 * lists the command is the command's own answer: a refusal arrives as its concrete
 * error in the receipt, which is more accurate than a pre-emptive verdict.
 */
export function createCapabilityRefreshView(React, commands) {
  const h = React.createElement
  return function CapabilityRefreshButton({ sessionId, enabled, t, onApplied, onInvalidated }) {
    const [pending, setPending] = React.useState(false)
    const [status, setStatus] = React.useState(null)
    const request = React.useRef(null)
    const source = React.useMemo(() => sessionId ? commands.source(sessionId) : null, [sessionId])
    React.useEffect(() => source === null ? undefined : source.subscribe(() => {}), [source])
    React.useEffect(() => {
      setStatus(null)
      setPending(false)
      return () => { request.current?.abort(); request.current = null }
    }, [sessionId, enabled])
    const cancel = event => {
      event.stopPropagation()
      request.current?.abort(); request.current = null; setPending(false)
      setStatus({ key: 'capabilities.refreshCancelled' })
      onApplied?.()
    }
    const execute = async event => {
      event.stopPropagation()
      if (!enabled || request.current) return
      const controller = new AbortController()
      request.current = controller
      setPending(true)
      setStatus(null)
      onInvalidated?.()
      try {
        const result = await commands.run(sessionId, 'refresh', controller.signal)
        if (controller.signal.aborted || request.current !== controller) return
        setStatus(result.text ?? { key: 'capabilities.refreshAcknowledged' })
        onApplied?.()
      } catch (error) {
        if (!controller.signal.aborted && request.current === controller) {
          const text = String(error?.message ?? error)
          if (!readCapabilityCommandReceipt(text)) {
            setStatus({ key: 'capabilities.refreshFailed', params: { error: text } })
          }
          onApplied?.()
        }
      } finally {
        if (request.current === controller) { request.current = null; setPending(false) }
      }
    }
    return h('div', { className: 'ptcPlusCapabilityRefresh' },
      h('button', { type: 'button', className: 'ptcPlusButton', disabled: !enabled || pending,
        title: sessionId ? undefined : t('capabilities.chooseSession'),
        onClick: execute }, t(pending ? 'capabilities.refreshing' : 'capabilities.applySession')),
      pending ? h('button', { type: 'button', className: 'ptcPlusButton', onClick: cancel }, t('capabilities.cancelRefresh')) : null,
      status ? h('p', { className: 'ptcPlusDetail', role: 'status' }, capabilityCommandText(t, status))
        : sessionId ? null : h('p', { className: 'ptcPlusDetail' }, t('capabilities.chooseSession')))
  }
}

/**
 * The one capability surface, mounted by every entrance.
 *
 * A page states, for one supplied object, which value each of its two dimensions has
 * at each address. Three permanent facts decide what it may state: the Host's supply
 * (which rows exist), the record at each address (the saved configuration and this
 * session's own log), and the receipt a write leaves. No runtime, service or global
 * switch produces any of them, so the read is not gated: a failed read is a defect
 * reported beside the rows, never a state the rows are replaced with.
 *
 * An entrance fixes which address this page may write. §4: a control exists exactly
 * when its cell's address is fixed by the entrance that opened the page — so the
 * session entrance controls this session's record and the settings entrance controls
 * the new-session default. The other address is still stated, because it is what the
 * reader compares against, and the session entrance adds the receipt column, which
 * names the record each decision leaves. The settings entrance has no session address
 * at all: its two session columns are absent, not disabled and not read-only.
 */
export function createCapabilitySurfaceView(React, { commands, bindingCommands, Modal, Select, inspectSessionCatalog }) {
  const h = React.createElement
  // §4's seven columns plus the receipt column, in that order. One column, one
  // decision: a dimension's control owns a labelled cell instead of sharing an
  // unlabelled one with another dimension's control.
  const COLUMNS = Object.freeze({
    session: Object.freeze(['object', 'type', 'source', 'savedEnabled', 'savedDisclosure',
      'sessionEnabled', 'sessionDisclosure', 'receipt']),
    settings: Object.freeze(['object', 'type', 'source', 'savedEnabled', 'savedDisclosure']),
  })
  // One word per column, declared by this page and by no other surface (§6).
  const COLUMN_COPY = Object.freeze({
    object: 'capabilities.column.object',
    type: 'capabilities.typesColumn',
    source: 'capabilities.sourceColumn',
    savedEnabled: 'capabilities.column.savedEnabled',
    savedDisclosure: 'capabilities.column.savedDisclosure',
    sessionEnabled: 'capabilities.column.sessionEnabled',
    sessionDisclosure: 'capabilities.column.sessionDisclosure',
    receipt: 'capabilities.column.receipt',
  })
  // The page's one value table. `inherit` is the session columns' own word for an
  // address that recorded nothing, so no cell is blank and none carries a denial;
  // every other word answers "who reads it, from which moment", which is the question
  // both disclosure columns ask.
  // `automatic` is the saved address's own word for a dimension its configuration wrote
  // no rule for; the bottom layer a chain would fall back to is synthesized from
  // configuration this page does not own, so it states no value here.
  const SAVED_AVAILABILITY = Object.freeze(['enabled', 'closed', 'automatic'])
  const SAVED_DISCLOSURE = Object.freeze([...CAPABILITY_DISCLOSURES, 'automatic'])
  // A session column states the record's own words, so the record's own `automatic` is one
  // of them; `inherit` stays this column's word for an address that recorded nothing.
  const SESSION_AVAILABILITY = Object.freeze(['enabled', 'closed', 'automatic', 'inherit'])
  const SESSION_DISCLOSURE = Object.freeze([...CAPABILITY_DISCLOSURES, 'automatic', 'inherit'])
  const DIMENSIONS = Object.freeze(['availability', 'disclosure'])
  const ADOPTION_WORDS = Object.freeze({ use: 'capabilities.word.use', skip: 'capabilities.word.skip',
    damaged: 'capabilities.word.damaged' })
  const FAMILIES = Object.freeze(['tools', 'skills', 'mcp', 'mcp_tools'])

  /** A receipt is the command's own text; a keyed receipt is translated, never rewritten. */
  const receiptText = (t, result) => {
    const text = result?.text
    if (typeof text === 'string') return text
    if (text !== null && typeof text === 'object' && typeof text.key === 'string') return t(text.key, text.params)
    return text === undefined || text === null ? '' : String(text)
  }

  return function CapabilitySurface({ entrance = 'session', sessionId, open, inline, writable = true, revision, savedCommands, onReload, t, onClose }) {
    const settingsEntrance = entrance === 'settings'
    const active = inline === true ? true : open
    const [rows, setRows] = React.useState([])
    // `loaded` is the read's own answer: an empty table means the Host declared
    // nothing only after a complete read said so.
    const [loaded, setLoaded] = React.useState(false)
    const [defect, setDefect] = React.useState(null)
    // The receipt of the most recent write, verbatim, or the error a refused write
    // returned. The panel owns no wording of its own here.
    const [receipt, setReceipt] = React.useState(null)
    const [writing, setWriting] = React.useState([])
    const [picked, setPicked] = React.useState([])
    const [batchOpen, setBatchOpen] = React.useState(false)
    const [batchChoices, setBatchChoices] = React.useState({ availability: 'keep', disclosure: 'keep' })
    const [query, setQuery] = React.useState('')
    const [family, setFamily] = React.useState('all')
    const [source, setSource] = React.useState('all')
    // The table's ordering, owned by this page: a display decision that writes nothing
    // and is dropped with the session it was made in.
    const [sort, setSort] = React.useState(null)
    const request = React.useRef(null)
    // Every write owns its own signal: a submitted command is not cancelled because
    // another row was used, and each row reports only its own progress.
    const writes = React.useRef(new Set())
    const epoch = React.useRef(0)
    const mounted = React.useRef(true)
    React.useEffect(() => {
      mounted.current = true
      return () => {
        mounted.current = false
        epoch.current += 1
        request.current?.abort()
        request.current = null
        for (const controller of writes.current) controller.abort()
        writes.current.clear()
      }
    }, [])
    React.useEffect(() => {
      // A session switch abandons the previous session's read and writes: neither may
      // land on the new session's rows.
      request.current?.abort()
      request.current = null
      for (const controller of writes.current) controller.abort()
      writes.current.clear()
      epoch.current += 1
      setRows([])
      setLoaded(false)
      setDefect(null)
      setReceipt(null)
      setWriting([])
      setPicked([])
      setBatchOpen(false)
      setQuery('')
      setFamily('all')
      setSource('all')
      setSort(null)
    }, [sessionId])
    const load = React.useCallback(async signal => {
      const mine = ++epoch.current
      try {
        const payload = await inspectSessionCatalog(sessionId, signal)
        if (!mounted.current || signal.aborted || mine !== epoch.current) return
        // The only accepted response shape. `config` states a global switch, so it is
        // read to confirm the shape and never drawn: a switch cannot decide a cell.
        if (payload?.schema !== 'ptc-capability-session-catalog/v2' || !Array.isArray(payload.rows)
          || payload.config === null || typeof payload.config !== 'object') {
          throw new Error('Invalid capability catalogue')
        }
        setRows(payload.rows)
        setLoaded(true)
        setDefect(null)
        setPicked(current => current.filter(id => payload.rows.some(row => row.id === id)))
      } catch (cause) {
        if (mounted.current && !signal.aborted && mine === epoch.current) setDefect(String(cause?.message ?? cause))
      }
    }, [sessionId])
    React.useEffect(() => {
      if (!active) {
        request.current?.abort()
        request.current = null
        return
      }
      const controller = new AbortController()
      request.current = controller
      void load(controller.signal)
      return () => {
        controller.abort()
        if (request.current === controller) request.current = null
      }
      // The saved address is read again when the configuration under this page changes,
      // so a rule edit elsewhere cannot leave the previous value on screen.
    }, [active, load, revision])
    const reload = () => {
      const controller = new AbortController()
      request.current?.abort()
      request.current = controller
      void load(controller.signal)
      onReload?.()
    }
    /**
     * One intention, one record. The write itself is the caller's: a cell runs the
     * write its own address owns, the receipt that write returns is what the footer
     * shows, and the rows are re-read from the record rather than patched from the
     * answer. A command that is not listed for this session reports its own refusal;
     * it is never pre-empted.
     */
    const perform = async (id, run) => {
      const controller = new AbortController()
      writes.current.add(controller)
      setWriting(current => current.includes(id) ? current : [...current, id])
      setReceipt(null)
      try {
        const answer = await run(controller.signal)
        if (!mounted.current || controller.signal.aborted) return
        setReceipt({ text: receiptText(t, answer) })
        await load(controller.signal)
        // The caller distinguishes a write that ran from a row it skipped as already matching.
        return { ok: true }
      } catch (cause) {
        const error = String(cause?.message ?? cause)
        if (mounted.current && !controller.signal.aborted) setReceipt({ error })
        // A batch runs one write at a time, so the next row's receipt would replace this
        // refusal; the caller gets it back to state the batch's failure after the loop.
        return { error }
      } finally {
        writes.current.delete(controller)
        if (mounted.current) setWriting(current => current.filter(item => item !== id))
      }
    }
    const record = (channel, line, id) => perform(id, signal => channel.run(sessionId, line, signal))
    const word = value => t(`capabilities.word.${value}`)
    // A batch writes one column of one entrance, so it names that column's dimension with
    // the page's own word instead of the layer editor's rule name.
    const dimensionWord = dimension => t(`capabilities.dimension.${dimension}`)
    const choiceOptions = values => values.map(value => ({ value, label: word(value) }))
    const familyOf = row => row.kind === 'binding' ? 'bindings'
      : row.kind === 'server' ? 'mcp'
        : row.category === 'skill' ? 'skills'
          : row.category === 'resource' ? 'mcp'
            : row.source?.kind === 'mcp' ? 'mcp_tools' : 'tools'
    const badgeOf = row => row.kind === 'binding' ? 'binding'
      : row.kind === 'server' ? 'server'
        : row.category === 'skill' ? 'skill'
          : row.category === 'resource' || row.source?.kind === 'mcp' ? 'resource' : 'tool'
    // Two rows share one source filter entry exactly when they state the same source,
    // and the entry is named by the row that states it.
    const sourceKeyOf = row => row.kind === 'binding' ? 'bindings'
      : JSON.stringify(row.source ?? namespaceSource(row))
    const sourceText = row => row.kind === 'binding' ? t('capabilities.source.bindings')
      : capabilitySourceText(t, row)
    const sourceFilterLabel = row => {
      const servers = mcpServersOf(row.source)
      if (row.source?.kind === 'mcp' && servers.length > 0) return `MCP · ${servers.join(t('capabilities.source.separator'))}`
      // The option names the whole source its key identifies. A skill's bucket does not:
      // two providers can declare into one bucket, and two options reading one word would
      // offer a distinction this filter cannot state.
      return row.source?.kind === 'skill'
        ? `Skill · ${sourceText(row)}${row.source.provider ? ` · ${row.source.provider}` : ''}`
        : sourceText(row)
    }
    // Both addresses, stated from the read: the saved column is the configuration's
    // own value for this object and the session column is the record's answer, with
    // `inherit` when this session recorded nothing. A server has no disclosure of its
    // own, so both disclosure cells state where that decision lives instead of a
    // denial or another row's answer.
    // The saved cell states its own record's word: a dimension this record wrote nothing for reads
    // `automatic`, never a resolved value another layer would answer (capability-surface §8.1c).
    const savedOf = (row, dimension) => row.saved?.[dimension] ?? 'automatic'
    const savedEnabled = row => word(savedOf(row, 'availability'))
    const savedDisclosure = row => row.kind === 'server' ? t('capabilities.word.perMember')
      : word(savedOf(row, 'disclosure'))
    const recordedOf = (row, dimension) => row.session?.[dimension] ?? 'inherit'
    const recordWord = (row, dimension) => row.record?.[dimension]
    /** The layer whose record decided this dimension, or null when this object's own entry did. */
    const recordLayer = (row, dimension) => row.record?.layers?.[dimension] ?? null
    /** A recorded decision above this object: the row states the layer's word in its receipt. */
    const adoptionOf = row => ['use', 'skip', 'damaged'].includes(row.session?.use) ? row.session.use : 'use'
    /**
     * The receipt column: which record this row's decision leaves, and what it states
     * there — or that nothing has been written at that address yet. A missing record is
     * that address's own "unwritten" receipt, not a blank: deleting this column would
     * make "where does this decision get reconciled" unanswerable, which is why §4 asks
     * for it and why the evidence column left the page.
     */
    const receiptOf = row => {
      if (row.kind === 'binding') {
        const record = t('capabilities.word.bindingRecord')
        if (adoptionOf(row) === 'damaged') return `${record} · ${word('damaged')}`
        return row.session?.recorded === true ? `${record} · ${t(ADOPTION_WORDS[adoptionOf(row)])}`
          : `${record} · ${t('capabilities.word.unwritten')}`
      }
      const record = t('capabilities.word.sessionRecord')
      // The receipt states the record's own text, not the resolution the value column
      // shows, and names the layer when a record above this object decided it. That layer's row is
      // part of this same read and states the word it wrote, so the receipt states that word:
      // `inherit` is this row's word for its own entry having written nothing (§4), never a word a
      // deciding record wrote.
      // A server row states every word its own rule holds, including a disclosure word its rule
      // can carry (§8.3): that word answers the members that wrote none at runtime, and a receipt
      // that said `未写下` while the record held it would deny what this same read carries. Its
      // disclosure cell still states the delegation, because the decision is made for the members.
      const statedDimensions = DIMENSIONS
      const layerWord = (layer, dimension) => rows
        .find(candidate => candidate.id === layer)?.record?.[dimension]
      const own = statedDimensions.filter(dimension => recordWord(row, dimension) !== undefined
        && recordLayer(row, dimension) === null)
      const byLayer = new Map()
      for (const dimension of statedDimensions) {
        const layer = recordLayer(row, dimension)
        // A dimension this object did not write is still answered by that layer at runtime, so the
        // receipt names it. A layer is named only for a dimension that layer's record wrote; a read
        // that does not carry the layer's row states the layer alone instead of inventing a word.
        if (layer === null) continue
        const stated = layerWord(layer, dimension)
        byLayer.set(layer, [...(byLayer.get(layer) ?? []), ...(stated === undefined ? [] : [`${dimension} ${stated}`])])
      }
      const parts = [
        ...(own.length === 0 ? [] : [own.map(dimension => `${dimension} ${recordWord(row, dimension)}`).join(' · ')]),
        ...[...byLayer].map(([layer, stated]) => stated.length === 0
          ? t('capabilities.receipt.layer', { layer })
          : `${t('capabilities.receipt.layer', { layer })} · ${stated.join(' · ')}`),
      ]
      return parts.length === 0 ? `${record} · ${t('capabilities.word.unwritten')}`
        : `${record} · ${parts.join(' · ')}`
    }
    // A control's own label names the address it writes, so a cell needs no neighbour
    // to be read (§3.2). The address is the object's identity, not its display name:
    // two rows can read alike, and only one of them is the record's key.
    const controlLabel = (column, row) => t(`capabilities.control.${column}`, { name: row.id })
    // The no-op test compares the record's own word, not the resolved value: a record
    // that wrote `automatic` and one that wrote the value it resolves to are different
    // records, and the second can only replace the first if the write is allowed.
    const writeSession = (row, dimension, value) => {
      if ((recordWord(row, dimension) ?? 'inherit') === value) return
      // The promise is the write: a batch awaits it so each command composes from the record
      // the previous one left, and nothing is fired in parallel.
      return record(commands, `set session ${encodeURIComponent(row.id)} ${dimension} ${value}`, row.id)
    }
    const writeSaved = (row, dimension, value) => {
      if (savedOf(row, dimension) === value) return
      if (typeof savedCommands?.run !== 'function') return
      return perform(row.id, async signal => {
        const written = await savedCommands.run({ id: row.id, dimension, selection: value }, signal)
        return { text: capabilityReceiptNotice(t, { state: 'recorded', record: { ...written, scope: 'global' } }, 'receipt') }
      })
    }
    // A damaged record still gets a control: the click writes the record that replaces
    // it, which is the only way the row can leave that state.
    const writeAdoption = row => void record(bindingCommands,
      `${adoptionOf(row) === 'use' ? 'skip' : 'use'} ${row.id}`, row.id)
    // The session column's own word, as one stable token per state. The row and the cell
    // both state it, so availability is read from a stripe and a mark before the word is
    // read: `enabled` and `closed` are the two answers no reader should have to decode from
    // identical text, and `inherit` must not read as a decision this session made.
    const sessionStateOf = row => row.kind === 'binding'
      ? adoptionOf(row)
      : (recordedOf(row, 'availability') ?? 'inherit')
    const sessionAvailabilityCell = row => row.kind === 'binding'
      ? h('div', { className: 'ptcPlusSessionCapabilityAvailability', 'data-state': sessionStateOf(row) },
        h('span', { className: 'ptcPlusSessionStateMark', 'data-state': sessionStateOf(row), 'aria-hidden': true }),
        h('button', { type: 'button', className: 'ptcPlusBindingToggle', 'data-kind': adoptionOf(row),
          'aria-pressed': adoptionOf(row) === 'use' ? 'true' : 'false',
          'aria-label': controlLabel('sessionEnabled', row),
          'aria-busy': writing.includes(row.id) ? 'true' : undefined,
          onClick: () => writeAdoption(row) }, t(ADOPTION_WORDS[adoptionOf(row)])))
      : h('div', { className: 'ptcPlusSessionCapabilityAvailability', 'data-state': sessionStateOf(row) },
        h('span', { className: 'ptcPlusSessionStateMark', 'data-state': sessionStateOf(row), 'aria-hidden': true }),
        h(Select, { label: controlLabel('sessionEnabled', row), value: recordedOf(row, 'availability'),
          options: choiceOptions(SESSION_AVAILABILITY),
          onChange: value => writeSession(row, 'availability', value) }))
    const sessionDisclosureCell = row => row.kind === 'binding'
      // A binding's adoption record holds no disclosure decision at all, so the cell
      // states that address's own word instead of borrowing the one a service row owns.
      ? h('span', { className: 'ptcPlusSessionCapabilityDisclosure', 'data-state': 'inherit' },
        t('capabilities.word.inherit'))
      : row.kind === 'server'
        // A server carries no disclosure of its own: its members do.
        ? h('span', { className: 'ptcPlusSessionCapabilityDisclosure', 'data-state': 'per-member' },
          t('capabilities.word.perMember'))
      : h('div', { className: 'ptcPlusSessionCapabilityDisclosure',
        'data-state': recordedOf(row, 'disclosure') ?? 'inherit' },
        h(Select, { label: controlLabel('sessionDisclosure', row), value: recordedOf(row, 'disclosure'),
          options: choiceOptions(SESSION_DISCLOSURE),
          onChange: value => writeSession(row, 'disclosure', value) }))
    // A control exists exactly when this entrance fixes the address the cell writes: the settings
    // entrance writes the saved document, so every row it states gets the controls its own address
    // holds — both dimensions for a capability, availability alone for a server, whose saved cell
    // edits `mcpServers.<server>` in that same document. Read-only disables, never withdraws.
    const savedControl = row => settingsEntrance
    const savedDisabled = () => writable === false
    const savedEnabledCell = row => savedControl(row)
      ? h('div', { className: 'ptcPlusSessionCapabilitySaved' },
        h(Select, { label: controlLabel('savedEnabled', row), value: savedOf(row, 'availability'),
          disabled: savedDisabled(), options: choiceOptions(SAVED_AVAILABILITY),
          onChange: value => writeSaved(row, 'availability', value) }))
      : h('span', { className: 'ptcPlusSessionCapabilitySaved' }, savedEnabled(row))
    const savedDisclosureCell = row => savedControl(row) && row.kind !== 'server'
      // A server carries no disclosure of its own, so its saved disclosure cell is the statement
      // that the members decide it; its availability cell is the rule edit below.
      ? h('div', { className: 'ptcPlusSessionCapabilitySavedDisclosure' },
        h(Select, { label: controlLabel('savedDisclosure', row), value: savedOf(row, 'disclosure'),
          disabled: savedDisabled(), options: choiceOptions(SAVED_DISCLOSURE),
          onChange: value => writeSaved(row, 'disclosure', value) }))
      : h('span', { className: 'ptcPlusSessionCapabilitySavedDisclosure' }, savedDisclosure(row))
    const identityCell = row => row.kind === 'binding'
      ? h('span', { className: 'ptcPlusCapabilityIdentity' },
        h('span', { className: 'ptcPlusSessionCapabilityName' }, row.name ?? row.id),
        row.name && row.name !== row.id ? h('code', null, row.id) : null)
      : h('div', { className: 'ptcPlusCapabilityIdentity' },
        // Only a capability row takes part in a batch: a server row's saved cell edits the scope's
        // `mcpServers.<server>` rule on its own, and a binding row writes the bindings document.
        row.kind !== 'capability' ? null : h('input', { type: 'checkbox', className: 'ptcPlusPick', checked: picked.includes(row.id),
          'aria-label': t('capabilities.selectForBatch', { name: row.name ?? row.id }),
          disabled: writable === false,
          onChange: () => setPicked(current => current.includes(row.id)
            ? current.filter(id => id !== row.id) : [...current, row.id]) }),
        h('div', { className: 'ptcPlusCapabilityIdentityText' },
          h('span', { className: 'ptcPlusSessionCapabilityName' }, row.name ?? row.id),
          row.name && row.name !== row.id ? h('code', null, row.id) : null))
    const cellsOf = row => {
      const cells = {
        object: identityCell(row),
        type: h('span', { className: 'ptcPlusCapabilityBadge', 'data-kind': badgeOf(row) }, t(`capabilities.type.${badgeOf(row)}`)),
        source: h('span', { className: 'ptcPlusCapabilitySource' }, sourceText(row)),
        savedEnabled: savedEnabledCell(row),
        savedDisclosure: savedDisclosureCell(row),
        sessionEnabled: sessionAvailabilityCell(row),
        sessionDisclosure: sessionDisclosureCell(row),
        receipt: h('span', { className: 'ptcPlusSessionCapabilityReceipt', title: receiptOf(row) }, receiptOf(row)),
      }
      return cells
    }
    const columns = COLUMNS[settingsEntrance ? 'settings' : 'session']
    // What the reader compares in a column is the word that column shows: a translated
    // badge, a source label, a record's own word. Sorting therefore reads this page's
    // display values instead of the fields they were derived from.
    const sortValue = (row, column) => column === 'object' ? (row.name ?? row.id)
      : column === 'type' ? t(`capabilities.type.${badgeOf(row)}`)
        : column === 'source' ? sourceText(row)
          : column === 'savedEnabled' ? savedEnabled(row)
            : column === 'savedDisclosure' ? savedDisclosure(row)
              : column === 'sessionEnabled' ? (row.kind === 'binding' ? t(ADOPTION_WORDS[adoptionOf(row)])
                : word(recordedOf(row, 'availability')))
                : column === 'sessionDisclosure' ? (row.kind === 'binding' ? t('capabilities.word.inherit')
                  // A server states where the decision lives, not a disclosure of its own,
                  // so that is the word this column shows and therefore the word it sorts by.
                  : row.kind === 'server' ? t('capabilities.word.perMember')
                    : word(recordedOf(row, 'disclosure')))
                  : ''
    // The receipt column states a whole sentence per row, so it offers no ordering: a
    // reader sorting by the wording of a receipt would be sorting by prose.
    const sortable = column => column !== 'receipt'
    const renderRow = row => {
      const cells = cellsOf(row)
      return h('div', { key: row.id, role: 'row',
        className: `ptcPlusSessionCapabilityRow ptcPlusCapabilityItem ptcPlusSessionCapabilityRow-${columns.length}`,
        'data-capability-id': row.id, 'data-kind': row.kind,
        'data-session-state': sessionStateOf(row),
        ...(row.kind === 'binding' ? { 'data-binding-id': row.id, 'data-binding-state': adoptionOf(row) } : {}) },
        ...columns.map(column => h(React.Fragment, { key: column }, React.cloneElement(cells[column], { role: 'cell' }))))
    }
    const columnsRow = () => h('div', {
      className: `ptcPlusSessionCapabilityColumns ptcPlusCapabilityColumns ptcPlusSessionCapabilityColumns-${columns.length}`,
      role: 'row' }, ...columns.map(column => h('span', { key: column, role: 'columnheader',
        'aria-sort': sortable(column) ? capabilitySortDirection(sort, column) : undefined },
      sortable(column)
        ? h('button', { type: 'button', className: 'ptcPlusCapabilitySort', title: t('capabilities.sortCycle'),
          'aria-label': t('capabilities.sortColumn', { column: t(COLUMN_COPY[column]) }),
          onClick: () => setSort(current => cycleCapabilitySort(current, column)) },
        t(COLUMN_COPY[column]),
        h('span', { className: 'ptcPlusCapabilitySortMark', 'aria-hidden': true },
          capabilitySortDirection(sort, column) === 'ascending' ? '↑'
            : capabilitySortDirection(sort, column) === 'descending' ? '↓' : '↕'))
        : t(COLUMN_COPY[column]))))
    const capabilities = rows.filter(row => row.kind !== 'binding')
    const matches = row => {
      const text = [row.name, row.id, sourceText(row)].filter(Boolean).join(' ').toLocaleLowerCase()
      return text.includes(query.trim().toLocaleLowerCase())
    }
    const listed = sortCapabilityEntries(capabilities.filter(row => (family === 'all' || familyOf(row) === family)
      && (source === 'all' || sourceKeyOf(row) === source) && matches(row)), sort, sortValue)
    const bindings = sortCapabilityEntries(rows.filter(row => row.kind === 'binding'), sort, sortValue)
    const sources = new Map()
    for (const row of capabilities) {
      if (family !== 'all' && familyOf(row) !== family) continue
      const key = sourceKeyOf(row)
      if (!sources.has(key)) sources.set(key, sourceFilterLabel(row))
    }
    // A batch writes only a dimension this entrance shows a control for. The settings entrance
    // fixes saved addresses and reads no session record, so what a session recorded decides
    // nothing there; the session entrance writes the session address, and every capability row
    // now carries both of its controls — a member's cell states its own record, so writing it
    // always changes what the cell says.
    const batchWritable = row => DIMENSIONS.filter(dimension => settingsEntrance
      ? savedControl(row) && (dimension === 'availability' || row.kind === 'capability')
      : dimension === 'availability' || row.kind === 'capability')
    const pickedRows = capabilities.filter(row => picked.includes(row.id) && batchWritable(row).length > 0)
    const batchLines = () => pickedRows.flatMap(row => batchWritable(row)
      .filter(dimension => batchChoices[dimension] !== 'keep')
      .map(dimension => ({ row, dimension, choice: batchChoices[dimension] })))
    // A batch is the same decision applied to existing rows: it writes one record per
    // selected row through the same channel and creates no rows of its own.
    const applyBatch = async () => {
      const lines = batchLines()
      setBatchOpen(false)
      // Every dimension kept its current setting, so this batch writes nothing. The
      // click still owes the reader one sentence, and it is the footer's own receipt
      // expression that states it: a zero-write batch names no record, so it states the
      // batch's outcome instead of widening the command receipt vocabulary.
      if (lines.length === 0) {
        setReceipt({ text: { key: 'capabilities.batch.kept', params: {} } })
        return
      }
      // One write at a time: each command composes the whole record from the log it reads, so
      // overlapping commands would drop each other's decision. A refusal does not stop the
      // remaining rows, and the batch states the first refusal after them instead of letting the
      // next row's success sentence replace it.
      let refusal, wrote = 0
      for (const { row, dimension, choice } of lines) {
        try {
          const outcome = settingsEntrance
            ? await writeSaved(row, dimension, choice)
            : await writeSession(row, dimension, choice)
          if (outcome?.error !== undefined) refusal ??= outcome.error
          else if (outcome?.ok === true) wrote += 1
        } catch (error) { refusal ??= String(error?.message ?? error) }
      }
      if (refusal !== undefined) setReceipt({ error: refusal })
      // Every picked word already matched its record, so no command ran; the click still owes the
      // reader one sentence rather than leaving the previous row's receipt standing.
      else if (wrote === 0) setReceipt({ text: { key: 'capabilities.batch.kept', params: {} } })
    }
    const filter = (label, value, onChange, options) => h('div', { className: 'ptcPlusCapabilityFilter' },
      h('span', null, label), h(Select, { label, value, onChange,
        options: options.map(([key, text]) => ({ value: key, label: text })) }))
    // The two filters narrow the same list, so a value that no longer matches the
    // other dimension is withdrawn instead of silently emptying the table.
    const chooseFamily = next => {
      setFamily(next)
      if (source !== 'all'
        && !capabilities.some(row => (next === 'all' || familyOf(row) === next) && sourceKeyOf(row) === source)) setSource('all')
    }
    const chooseSource = next => {
      setSource(next)
      if (next !== 'all'
        && !capabilities.some(row => (family === 'all' || familyOf(row) === family) && sourceKeyOf(row) === next)) setFamily('all')
    }
    const close = () => {
      request.current?.abort()
      request.current = null
      onClose?.()
    }
    // §3.3: a page reports its own address set, so a missing receipt is read against the
    // record it belongs to instead of against an unnamed blank.
    const addressSet = settingsEntrance ? t('capabilities.surface.addresses.settings')
      : t('capabilities.surface.addresses.session', { session: sessionId })
    const table = h('div', { role: 'table',
      'aria-label': t(settingsEntrance ? 'capabilities.surface.settingsTitle' : 'capabilities.quick.members') },
      columnsRow(),
      loaded && listed.length === 0 ? h('p', { className: 'ptcPlusSessionCapabilityMessage' },
        t(capabilities.length === 0 ? 'capabilities.quick.supplyEmpty' : 'capabilities.noMatches')) : null,
      ...listed.map(renderRow))
    const body = [
      h('div', { key: 'head', className: 'ptcPlusSessionCapabilityHead' },
        h('div', null,
          h('h2', null, t(settingsEntrance ? 'capabilities.surface.settingsTitle' : 'capabilities.quick.modalTitle')),
          h('p', { className: 'ptcPlusSessionCapabilityAddresses' }, addressSet)),
        inline === true ? null : h('button', { type: 'button', className: 'ptcPlusDialogClose',
          'aria-label': t('settings.close'), onClick: close }, '\u00d7')),
      h('div', { key: 'toolbar', className: 'ptcPlusSessionCapabilityToolbar' },
        h('label', { className: 'ptcPlusSearch' },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true },
            h('circle', { cx: 10, cy: 10, r: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
            h('path', { d: 'm15 15 6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 2 })),
          h('input', { type: 'search', value: query, 'aria-label': t('capabilities.search'),
            placeholder: t('capabilities.search'), onChange: event => setQuery(event.target.value) })),
        filter(t('capabilities.quick.kind'), family, chooseFamily,
          [['all', t('capabilities.quick.all')], ...FAMILIES.map(key => [key, t(`capabilities.quick.${key}`)])]),
        filter(t('capabilities.sourceFilter'), source, chooseSource,
          [['all', t('capabilities.allSources')], ...[...sources].sort(([a], [b]) => compare(a, b))]),
        h('button', { type: 'button', className: 'ptcPlusButton', 'aria-haspopup': 'dialog',
          'aria-label': t('capabilities.batchSettings'), disabled: writable === false,
          onClick: () => { setBatchChoices({ availability: 'keep', disclosure: 'keep' }); setBatchOpen(true) } },
          t('capabilities.batchSettings'),
          picked.length ? h('span', { className: 'ptcPlusCapabilityBatchCount', 'aria-hidden': true },
            String(picked.length)) : null)),
      // A read that failed is a defect in the panel's own source, so it names the error
      // and offers the retry beside the rows it could not replace.
      defect === null ? null : h('p', { key: 'defect', className: 'ptcPlusSessionCapabilityMessage', role: 'status' },
        t('capabilities.quick.catalogError', { error: defect }), ' ',
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: reload }, t('capabilities.reloadCatalog'))),
      h('div', { key: 'list', className: 'ptcPlusSessionCapabilityList' },
        h('div', { className: 'ptcPlusSessionCapabilityTable' }, table),
        // The group is present whenever this entrance states the binding document: the
        // Host supplies it whether or not this session has used any of it, and a
        // zero-row group is an empty table.
        settingsEntrance ? null
          : h('section', { key: 'bindings', className: 'ptcPlusSessionCapabilityGroup ptcPlusBindingGroup' },
            h('h3', null, t('bindings.title')),
            h('div', { className: 'ptcPlusBindingTable', role: 'table', 'aria-label': t('bindings.title') },
              columnsRow(),
              ...bindings.map(renderRow)))),
      batchOpen ? h(Modal, { key: 'batch', open: true, onClose: () => setBatchOpen(false),
        title: t('capabilities.batchSettings'), closeLabel: t('capabilities.batch.cancel'), headless: true,
        className: 'ptcPlusCapabilityBatchModal' },
        h('div', { className: 'ptcPlusCapabilityBatchHead' }, h('h2', null, t('capabilities.batchSettings')),
          h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('capabilities.batch.cancel'),
            onClick: () => setBatchOpen(false) }, '\u00d7')),
        h('div', { className: 'ptcPlusCapabilityBatchBody' },
          h('p', { className: 'ptcPlusDetail', role: 'status' }, t('capabilities.batch.selected', { count: pickedRows.length })),
          h('ul', { className: 'ptcPlusCapabilityBatchTargets', 'aria-label': t('capabilities.batch.targetList') },
            ...pickedRows.map(row => h('li', { key: row.id }, h('span', null, row.name ?? row.id), h('code', null, row.id)))),
          h('div', { className: 'ptcPlusCapabilityBatchFields' }, ...DIMENSIONS.map(dimension => {
            const address = t(settingsEntrance ? 'capabilities.batch.address.saved' : 'capabilities.batch.address.session')
            const label = `${address} · ${dimensionWord(dimension)}`
            return h('div', { key: dimension, className: 'ptcPlusCapabilityFilter' }, h('span', null, label),
              h(Select, { value: batchChoices[dimension], label,
                onChange: choice => setBatchChoices(current => ({ ...current, [dimension]: choice })),
                // Each entrance offers the words its own address can hold: the session batch offers
                // the record's words plus `inherit`, the saved batch offers `automatic`.
                options: [{ value: 'keep', label: t('capabilities.batch.keep') },
                  ...choiceOptions(dimension === 'availability'
                    ? (settingsEntrance ? SAVED_AVAILABILITY : SESSION_AVAILABILITY)
                    : (settingsEntrance ? SAVED_DISCLOSURE : SESSION_DISCLOSURE))] }))
          })),
          h('p', { className: 'ptcPlusDetail' },
            t(settingsEntrance ? 'capabilities.batch.effect' : 'capabilities.batch.effectSession'))),
        h('div', { className: 'ptcPlusCapabilityBatchFooter' },
          h('button', { type: 'button', className: 'ptcPlusButton', onClick: () => setBatchOpen(false) },
            t('capabilities.batch.cancel')),
          h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary',
            disabled: writable === false, onClick: () => void applyBatch() },
            t('capabilities.batch.record', { count: batchLines().length })))) : null,
      h('div', { key: 'footer', className: 'ptcPlusSessionCapabilityFooter' },
        // The footer states the same receipt the chat card does, in the current
        // language: which record this write named, its choice and its session. The raw
        // payload stays in the command's own result, where history keeps it.
        receipt === null ? null : h('span', { role: 'status' }, receipt.error === undefined
          ? capabilityCommandText(t, receipt.text)
          : t('capabilities.quick.writeError', { error: receipt.error }))),
    ]
    return inline === true
      ? h('div', { className: 'ptcPlusCapabilitySurface ptcPlusCapabilitySurface-inline' }, ...body)
      : h(Modal, { open, onClose: close, title: t('capabilities.quick.modalTitle'),
        closeLabel: t('settings.close'), headless: true, className: 'ptcPlusSessionCapabilityModal' }, ...body)
  }
}
