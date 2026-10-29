import { capabilityPolicyForConfig, capabilityRule, changeCapabilityRule, effectiveCapabilitySettings, CAPABILITY_DISCLOSURES, CAPABILITY_INVENTORY_CATEGORIES } from '../internal/capability-policy.js'
import { CONFIG_DEFAULTS, CONFIG_FIELDS } from '../internal/config-spec.js'
import { CAPABILITY_CONFIGURATION_KEYS, capabilityProfileConfiguration, validateCapabilityProfiles } from '../internal/runtime-config.js'
import { readCapabilityCommandReceipt } from '../internal/capability-command-receipt.js'
import { createFallbackModal } from './client-primitives.js'
import { CAPABILITY_SORT_COLUMNS, capabilitySortDirection, cycleCapabilitySort, sortCapabilityEntries } from './client-capability-sort.js'
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
  return `${record.id} · ${record.dimension === undefined ? '' : `${t(`capabilities.policy.${record.dimension}`)} `}`
    + t(`capabilities.word.${record.selection}`)
}

/**
 * One receipt, one sentence, in the reader's language.
 *
 * A receipt states the write this command performed: which entry, which choice,
 * and which session or global configuration now records it. Whether a cell later
 * reached that entry is the panel's evidence column — a marker means an accepted
 * execution obtained it — so no receipt states it. The chat card and the composer
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
      : [...selections, ...CAPABILITY_DISCLOSURES].includes(value) ? `capabilities.${value}` : 'capabilities.quick.unknown')
}

function capabilityRuleLabel(t, rule, empty = 'capabilities.policy.inheritRule') {
  const dimensions = ['availability', 'disclosure'].filter(dimension => rule?.[dimension] !== undefined)
  return dimensions.length ? dimensions.map(dimension => `${t(`capabilities.policy.${dimension}`)}: ${rule[dimension] === 'automatic'
    ? t('capabilities.policy.inheritRule') : capabilityChoiceLabel(t, rule[dimension])}`).join(' · ') : t(empty)
}

function validCatalogRule(rule, temporary = false) {
  return rule !== null && typeof rule === 'object' && !Array.isArray(rule)
    && Object.entries(rule).every(([dimension, choice]) => ['availability', 'disclosure'].includes(dimension)
      && (temporary && choice === 'automatic' || (dimension === 'availability'
        ? ['enabled', 'closed'].includes(choice) : CAPABILITY_DISCLOSURES.includes(choice))))
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
        && ['name', 'description', 'saved', 'temporary']
          .every(key => entry[key] === undefined || typeof entry[key] === 'string')
        && ['savedRule', 'temporaryRule'].every(key => entry[key] === undefined || validCatalogRule(entry[key], key === 'temporaryRule'))) ? json.entries : null
    const outcome = entries ? t('capabilities.card.catalogCount', { count: entries.length })
      : json ? t('capabilities.card.details')
        : node.outcome ? capabilityCommandText(t, text)
          ?? t(node.outcome.kind === 'error' ? 'capabilities.commandFailed' : 'capabilities.refreshAcknowledged')
          : t('capabilities.refreshing')
    const label = (entry, key) => {
      const rule = entry[key === 'saved' ? 'savedRule' : 'temporaryRule']
      return rule === undefined ? capabilityChoiceLabel(t, entry[key])
        : capabilityRuleLabel(t, rule, key === 'temporary' ? 'capabilities.quick.noOverride' : 'capabilities.policy.inheritRule')
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
const kinds = ['all', 'tool', 'skill', 'resource', 'other']
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const configurationId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Catalog facts and saved preferences stay separate from frozen session results.
 *
 * `inCatalog` states one fact about the last complete catalog read: that read
 * declared this identity. It is a fact about a read, not a verdict about the
 * capability, so it never becomes a row state, badge or filter; the only reader is
 * the batch write's changed-target check, which refuses a stale target identity.
 */
export function capabilitySettingsEntries(value, catalog, plans, uncertain = false) {
  const baseline = JSON.parse(value.capabilityBaseline ?? CONFIG_DEFAULTS.capabilityBaseline)
  // A retained catalog after a failed reload is not an observation: nothing in it
  // may confirm that the current catalog still declares these identities.
  const observed = catalog !== null && uncertain !== true
  const entries = new Map((catalog ?? []).map(entry => [entry.id, { ...entry, inCatalog: observed }]))
  for (const plan of plans ?? []) for (const entry of plan.effective.entries) {
    if (!entries.has(entry.id)) entries.set(entry.id, { id: entry.id, category: entry.category, inCatalog: false })
  }
  const policy = capabilityPolicyForConfig(value)
  for (const id of [...baseline, ...Object.keys(policy.items)].filter(id => !id.startsWith('mcpServers.'))) if (!entries.has(id)) entries.set(id, { id, inCatalog: false })
  return [...entries.values()].map(entry => ({ ...entry,
    name: entry.name ?? entry.id,
    kind: ['tool', 'skill'].includes(entry.category) ? entry.category
      : ['resource', 'resource-template'].includes(entry.category) ? 'resource' : 'other',
    inCatalog: entry.inCatalog === true,
    common: baseline.includes(entry.id), rule: policy.items[entry.id] ?? {}, resolvedRule: capabilityRule(policy, entry),
  }))
}

export function capabilityPlanReason(t, entry) {
  const known = ['manual-override', 'baseline-not-selected', 'baseline', 'coverage-below-threshold', 'statistical-coverage',
    'mcp-server-disabled', 'contract-budget', 'management-disabled', 'statistics-disabled', 'statistics-settings-invalid', 'statistics-data-invalid',
    'statistics-unavailable', 'workspace', 'global', 'host-disclosure', 'availability-rule', 'disclosure-rule']
  return [entry.reason, entry.statisticsReason].filter(Boolean)
    .map(reason => known.includes(reason) ? t(`capabilities.reason.${reason}`) : reason).join(' · ')
}

export function createCapabilitySettingsViews(React, { SearchIcon, Select, Modal = createFallbackModal(React) }) {
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

  function PolicyRules({ value, catalog, disabled, onChange, t }) {
    const policy = capabilityPolicyForConfig(value)
    const write = next => onChange(field('capabilityPolicy'), JSON.stringify(next))
    const ruleControls = (rule, update, label, defaults = false) => h('div', { className: 'ptcPlusPolicyRule', key: label },
      h('strong', null, label), ...['availability', 'disclosure'].map(dimension => h('div', { className: 'ptcPlusCapabilityFilter', key: dimension },
        h('span', null, t(`capabilities.policy.${dimension}`)), h(Select, {
          label: `${label} · ${t(`capabilities.policy.${dimension}`)}`, disabled: disabled('capabilityPolicy'),
          value: rule[dimension] ?? 'automatic', onChange: choice => {
            const next = { ...rule }; if (choice === 'automatic') delete next[dimension]; else next[dimension] = choice; update(next)
          }, options: [...(defaults ? [] : ['automatic']), ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)]
            .map(choice => ({ value: choice, label: t(choice === 'automatic' ? 'capabilities.policy.inheritRule' : `capabilities.${choice === 'enabled' ? 'quick.enabled' : choice}`) })) }))))
    return h('section', { className: 'ptcPlusPolicyRules', 'aria-label': t('capabilities.policy.rules') },
      h('h4', null, t('capabilities.inheritedRules')), h('p', { className: 'ptcPlusDetail' }, t('capabilities.inheritedRulesHelp')),
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.policy.precedence')),
      ruleControls(policy.defaults, defaults => write({ ...policy, defaults }), t('capabilities.policy.default'), true),
      h('details', null, h('summary', { tabIndex: 0 }, t('capabilities.policy.categories')),
        ...Object.values(CAPABILITY_INVENTORY_CATEGORIES).map(category => ruleControls(policy.categories[category] ?? {}, rule =>
          write({ ...policy, categories: { ...policy.categories, [category]: rule } }), t(`capabilities.policy.category.${category}`)))),
      h('details', null, h('summary', { tabIndex: 0 }, t('capabilities.sourceRules')),
        ...[...new Set([...Object.keys(policy.mcpServers), ...(catalog ?? []).map(item => item.mcpServer).filter(Boolean)])].sort(compare)
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

  function CapabilityBatchDialog({ operation, value, entries, disabled, onChange, onClose, t }) {
    const [choices, setChoices] = React.useState({ availability: 'keep', disclosure: 'keep' })
    const [pending, setPending] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    const saving = React.useRef(false)
    const mounted = React.useRef(true)
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    // The dialog's targets are exactly the explicit selection. A target the last
    // complete catalog read did not declare is reported as a changed target, so a
    // stale selection cannot be written; nothing is dropped before it is reported.
    const targetIds = new Set(entries.filter(entry => entry.inCatalog === true).map(entry => entry.id))
    const missing = operation.targets.filter(entry => !targetIds.has(entry.id)).length
    const blocked = disabled('capabilityPolicy') || pending
    const changed = Object.values(choices).some(choice => choice !== 'keep')
    const close = () => { if (!saving.current) onClose() }
    const confirm = async () => {
      if (saving.current || blocked || missing || !changed || !operation.targets.length) return
      let next = capabilityPolicyForConfig(value)
      for (const target of operation.targets) for (const dimension of ['availability', 'disclosure']) {
        if (choices[dimension] !== 'keep') next = changeCapabilityRule(next, target.id, dimension, choices[dimension])
      }
      saving.current = true; setPending(true); setFailed(false)
      try {
        const saved = await onChange(field('capabilityPolicy'), JSON.stringify(next))
        if (!mounted.current) return
        if (saved === true) onClose()
        else setFailed(true)
      } catch {
        if (mounted.current) setFailed(true)
      } finally {
        saving.current = false
        if (mounted.current) setPending(false)
      }
    }
    return h(Modal, { open: true, onClose: close, title: t('capabilities.batchSettings'),
      closeLabel: t('capabilities.batch.cancel'), headless: true, className: 'ptcPlusCapabilityBatchModal' },
      h('div', { className: 'ptcPlusCapabilityBatchHead' }, h('h2', null, t('capabilities.batchSettings')),
        h('button', { type: 'button', className: 'ptcPlusDialogClose', disabled: pending,
          'aria-label': t('capabilities.batch.cancel'), onClick: close }, '×')),
      h('div', { className: 'ptcPlusCapabilityBatchBody' },
        h('p', { className: 'ptcPlusDetail', role: 'status' }, t('capabilities.batch.targets', { count: operation.targets.length })),
        operation.targets.length ? h('ul', { className: 'ptcPlusCapabilityBatchTargets', 'aria-label': t('capabilities.batch.targetList') },
          ...operation.targets.map(target => h('li', { key: target.id }, h('span', null, target.name), h('code', null, target.id))))
          : h('p', { className: 'ptcPlusDetail' }, t('capabilities.batch.empty')),
        h('div', { className: 'ptcPlusCapabilityBatchFields' }, ...['availability', 'disclosure'].map(dimension =>
          h('div', { key: dimension, className: 'ptcPlusCapabilityFilter' }, h('span', null, t(`capabilities.policy.${dimension}`)),
            h(Select, { value: choices[dimension], disabled: blocked || !operation.targets.length,
              label: t(`capabilities.batch.${dimension}`), onChange: choice => setChoices(current => ({ ...current, [dimension]: choice })),
              options: ['keep', 'automatic', ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)]
                .map(choice => ({ value: choice, label: t(choice === 'keep' ? 'capabilities.batch.keep'
                  : choice === 'automatic' ? 'capabilities.policy.inheritRule'
                    : choice === 'enabled' ? 'capabilities.action.enable'
                      : choice === 'closed' ? 'capabilities.action.close' : `capabilities.${choice}`) })) })))),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.batch.effect')),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.batch.sourceClosure')),
        missing ? h('p', { className: 'ptcPlusMessage', role: 'alert' }, t('capabilities.batch.changedTargets', { count: missing })) : null,
        failed ? h('p', { className: 'ptcPlusMessage', role: 'alert' }, t('capabilities.batch.failed')) : null),
      h('div', { className: 'ptcPlusCapabilityBatchFooter' },
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: pending, onClick: close }, t('capabilities.batch.cancel')),
        h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary',
          disabled: blocked || Boolean(missing) || !changed || !operation.targets.length, onClick: confirm },
        t(pending ? 'state.syncing' : 'capabilities.batch.confirm', { count: operation.targets.length }))))
  }

  function CapabilityChoices({ value, catalog, catalogError, plans, plansError, disabled, onChange, onReload, t, selectedSessionId, onSessionSelect }) {
    const root = React.useRef(null)
    const [query, setQuery] = React.useState('')
    const [kind, setKind] = React.useState('all')
    const [source, setSource] = React.useState('all')
    const [strategy, setStrategy] = React.useState('all')
    const [availabilityRule, setAvailabilityRule] = React.useState('all')
    const [onlyCommon, setOnlyCommon] = React.useState(false)
    const [sort, setSort] = React.useState(null)
    const [selected, setSelected] = React.useState(null)
    const [picked, setPicked] = React.useState([])
    const [filtersOpen, setFiltersOpen] = React.useState(false)
    const [batchOperation, setBatchOperation] = React.useState(null)
    const [inheritedRulesOpen, setInheritedRulesOpen] = React.useState(false)
    const [localSessionId, setLocalSessionId] = React.useState('')
    const sessionId = onSessionSelect ? selectedSessionId : localSessionId
    const setSessionId = next => { setLocalSessionId(next); onSessionSelect?.(next) }
    const baseline = JSON.parse(value.capabilityBaseline ?? CONFIG_DEFAULTS.capabilityBaseline)
    const policy = capabilityPolicyForConfig(value)
    const entries = capabilitySettingsEntries(value, catalog, plans, Boolean(catalogError))
    const sourceKey = entry => JSON.stringify([entry.source?.kind ?? 'unknown', entry.source?.server ?? null,
      entry.source?.bucket ?? null, entry.source?.provider ?? null])
    const sourceLabel = entry => {
      if (entry.source?.kind === 'skill') {
        const bucket = entry.source.bucket
        const known = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'runtime', 'bundled', 'custom']
        const label = known.includes(bucket) ? t(`capabilities.source.${bucket}`)
          : bucket ? `${t('capabilities.source.other-skill')} · ${bucket}` : t('capabilities.source.unknown')
        return `${label}${entry.source.provider ? ` · ${entry.source.provider}` : ''}`
      }
      if (entry.source?.kind === 'mcp') return `MCP${entry.source.server ? ` · ${entry.source.server}` : ''}`
      return t(`capabilities.source.${entry.source?.kind === 'host' ? 'host' : 'unknown'}`)
    }
    const matchesKind = (entry, type) => type === 'all' || (type === 'resource' ? entry.source?.kind === 'mcp'
      : type === 'tool' ? entry.kind === 'tool' && entry.source?.kind !== 'mcp' : type === entry.kind)
    const sources = new Map(entries.filter(entry => matchesKind(entry, kind)).map(entry => [sourceKey(entry), sourceLabel(entry)]))
    const setType = next => { setKind(next); if (!entries.some(entry => matchesKind(entry, next) && sourceKey(entry) === source)) setSource('all') }
    const setCompatibleSource = next => {
      setSource(next)
      if (next !== 'all' && !entries.some(entry => matchesKind(entry, kind) && sourceKey(entry) === next)) setKind('all')
    }
    const normalizedQuery = query.trim().toLowerCase()
    const filtered = entries.filter(entry => matchesKind(entry, kind)
      && (source === 'all' || sourceKey(entry) === source)
      && (strategy === 'all' || (entry.rule.disclosure ?? 'automatic') === strategy)
      && (availabilityRule === 'all' || (entry.rule?.availability ?? 'automatic') === availabilityRule)
      && (!onlyCommon || entry.common)
      && `${entry.name} ${entry.id} ${entry.description ?? ''} ${sourceLabel(entry)}`.toLowerCase().includes(normalizedQuery))
    const defaultOrder = (a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.id, b.id)
    // The cell states the rule this row resolves to. Whether the last catalog read
    // declared the identity is a different fact and is not a state of this column.
    const state = item => value.capabilityContextEnabled === false || value.capabilityManagementEnabled !== true ? 'unapplied'
      : item.resolvedRule.availabilitySource.startsWith('mcp:') && item.resolvedRule.availability === 'closed' ? 'source-closed' : item.resolvedRule.availability
    const type = item => item.source?.kind === 'mcp' ? 'resource' : item.kind
    const displayedSource = item => item.source?.kind === 'mcp' ? item.source.server ?? sourceLabel(item) : sourceLabel(item)
    const groups = new Map()
    for (const entry of filtered) {
      const group = entry.source?.kind === 'mcp' && entry.source.server ? `mcp:${entry.source.server}` : entry.kind
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(entry)
    }
    const groupOrder = ['tool', ...[...groups.keys()].filter(key => key.startsWith('mcp:')).sort(compare), 'skill', 'resource', 'other']
    const defaultEntries = groupOrder.flatMap(group => (groups.get(group) ?? []).sort(defaultOrder))
    const visible = sortCapabilityEntries(defaultEntries, sort, (item, column) => column === 'name' ? item.name
      : column === 'type' ? t(`capabilities.type.${type(item)}`)
        : column === 'source' ? displayedSource(item)
          : column === 'availability' ? t(`capabilities.rowState.${state(item)}`)
            : t(`capabilities.${item.resolvedRule.disclosure}`))
    const pickedIds = picked.filter(id => entries.some(item => item.id === id))
    const pickedEntries = pickedIds.map(id => entries.find(item => item.id === id)).filter(Boolean)
    const allVisiblePicked = visible.length > 0 && visible.every(item => pickedIds.includes(item.id))
    const someVisiblePicked = visible.some(item => pickedIds.includes(item.id))
    const togglePick = id => setPicked(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
    const toggleAllVisible = () => setPicked(current => allVisiblePicked
      ? current.filter(id => !visible.some(item => item.id === id))
      : [...new Set([...current, ...visible.map(item => item.id)])])
    const entry = visible.find(item => item.id === selected)
    const plan = sessionId ? plans?.find(item => item.sessionId === sessionId) : undefined
    const effective = plan?.effective.entries.find(item => item.id === entry?.id)
    const change = (key, next) => onChange(field(key), JSON.stringify(next))
    const setManual = (id, selection) => change('capabilityPolicy', changeCapabilityRule(policy, id, 'disclosure', selection))
    const clear = () => { setQuery(''); setKind('all'); setSource('all'); setStrategy('all'); setAvailabilityRule('all'); setOnlyCommon(false) }
    const activeFilters = Number(kind !== 'all') + Number(source !== 'all') + Number(strategy !== 'all') + Number(availabilityRule !== 'all') + Number(onlyCommon)
    const select = (label, current, update, options, blocked = false) => h('div', { className: 'ptcPlusCapabilityFilter' },
      h('span', null, label), h(Select, { label, value: current, disabled: blocked, onChange: update,
        options: options.map(([key, text]) => ({ value: key, label: text })) }))
    const editorField = (label, control) => h('div', { className: 'ptcPlusCapabilityField' }, h('span', null, label), control)
    const manualSelect = item => h('div', { className: 'ptcPlusCapabilityEditorFields' },
      editorField(t('capabilities.enabledColumn'), h(Select, { value: item.rule.availability ?? 'automatic', disabled: disabled('capabilityPolicy'),
        label: t('capabilities.policy.availabilityFor', { name: item.id }),
        onChange: next => change('capabilityPolicy', changeCapabilityRule(policy, item.id, 'availability', next)),
        options: ['automatic', 'enabled', 'closed'].map(choice => ({ value: choice, label: t(choice === 'automatic' ? 'capabilities.policy.inheritRule' : choice === 'enabled' ? 'capabilities.quick.enabled' : `capabilities.${choice}`) })) })),
      editorField(t('capabilities.contextColumn'), h(Select, { value: item.rule.disclosure ?? 'automatic', disabled: disabled('capabilityPolicy'),
        label: t('capabilities.disclosureFor', { name: item.id }),
        onChange: next => setManual(item.id, next), options: ['automatic', ...CAPABILITY_DISCLOSURES]
          .map(choice => ({ value: choice, label: t(choice === 'automatic' ? 'capabilities.policy.inheritRule' : `capabilities.${choice}`) })) })))
    const commonSwitch = item => h('div', { className: 'ptcPlusCapabilitySwitchRow' },
      h('div', { className: 'ptcPlusCapabilitySwitchText' },
        h('span', { className: 'ptcPlusCapabilitySwitchLabel' }, t('capabilities.commonBaseline')),
        h('span', { className: 'ptcPlusCapabilitySwitchHint' }, t(item.common ? 'capabilities.inBaseline' : 'capabilities.notInBaseline'))),
      h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: item.common,
        disabled: disabled('capabilityBaseline'), 'aria-label': t('capabilities.baselineFor', { name: item.id }),
        onChange: event => change('capabilityBaseline', event.target.checked
          ? [...baseline.filter(id => id !== item.id), item.id] : baseline.filter(id => id !== item.id)) }))
    const filterLabels = [kind !== 'all' ? t(`capabilities.type.${kind}`) : null,
      source !== 'all' ? sources.get(source) ?? t('capabilities.previousSource') : null,
      strategy !== 'all' ? t(strategy === 'automatic' ? 'capabilities.policy.inheritRule' : `capabilities.${strategy}`) : null,
      availabilityRule !== 'all' ? t(availabilityRule === 'automatic' ? 'capabilities.policy.inheritRule'
        : availabilityRule === 'enabled' ? 'capabilities.quick.enabled' : 'capabilities.closed') : null,
      onlyCommon ? t('capabilities.onlyCommon') : null].filter(Boolean)
    const closeEditor = () => {
      const button = [...(root.current?.querySelectorAll('[data-capability-edit-id]') ?? [])].find(item => item.dataset.capabilityEditId === selected)
      setSelected(null); button?.focus({ preventScroll: true })
    }
    return h('div', { className: 'ptcPlusCapabilityChoices', ref: root },
      h('div', { className: 'ptcPlusCapabilityToolbar' },
        h('label', { className: 'ptcPlusSearch' }, h(SearchIcon),
          h('input', { type: 'search', value: query, 'aria-label': t('capabilities.search'), placeholder: t('capabilities.search'),
            onChange: event => setQuery(event.target.value) })),
        h('div', { className: 'ptcPlusCapabilityTypes', role: 'group', 'aria-label': t('capabilities.types') },
          ...kinds.filter(key => key !== 'other' || entries.some(item => item.kind === 'other')).map(key => h('button', {
            key, type: 'button', 'aria-pressed': kind === key, onClick: () => setType(key),
          }, t(`capabilities.type.${key}`)))),
        h('button', { type: 'button', className: 'ptcPlusButton', 'aria-haspopup': 'dialog',
          onClick: () => setFiltersOpen(true) }, t('capabilities.filterAction')),
        h('button', { type: 'button', className: 'ptcPlusButton', 'aria-haspopup': 'dialog',
          'aria-label': t('capabilities.batchSettings'),
          disabled: disabled('capabilityPolicy') || pickedEntries.length === 0,
          onClick: () => setBatchOperation({
            targets: pickedEntries.map(item => ({ id: item.id, name: item.name })),
          }) }, t('capabilities.batchSettings'),
          pickedIds.length ? h('span', { className: 'ptcPlusCapabilityBatchCount', 'aria-hidden': true,
            title: t('capabilities.selectionCount', { count: pickedIds.length }) },
            String(pickedIds.length)) : null),
        h('button', { type: 'button', className: 'ptcPlusButton', 'aria-haspopup': 'dialog',
          onClick: () => setInheritedRulesOpen(true) }, t('capabilities.inheritedRules'))),
      filtersOpen ? h(CapabilityDialog, { title: t('capabilities.filterAction'), onClose: () => setFiltersOpen(false), t,
        className: 'ptcPlusCapabilityFilterDialog', footer: h('button', { type: 'button', className: 'ptcPlusButton',
          'data-kind': 'primary', onClick: () => setFiltersOpen(false) }, t('capabilities.dialogDone')) },
        h('div', { className: 'ptcPlusCapabilityFilterFields' },
          select(t('capabilities.sourceFilter'), source, setCompatibleSource, [['all', t('capabilities.allSources')], ...sources,
            ...(source !== 'all' && !sources.has(source) ? [[source, t('capabilities.previousSource')]] : [])]),
          select(t('capabilities.policy.disclosureFilter'), strategy, setStrategy, [['all', t('capabilities.allStrategies')],
            ...['automatic', ...CAPABILITY_DISCLOSURES].map(key => [key, t(key === 'automatic' ? 'capabilities.policy.inheritRule' : `capabilities.${key}`)])]),
          select(t('capabilities.policy.availabilityFilter'), availabilityRule, setAvailabilityRule, [['all', t('capabilities.allStrategies')],
            ...['automatic', 'enabled', 'closed'].map(key => [key, t(key === 'automatic' ? 'capabilities.policy.inheritRule' : key === 'enabled' ? 'capabilities.quick.enabled' : 'capabilities.closed')])]),
          h('label', { className: 'ptcPlusCapabilityOnlyCommon' }, h('input', { type: 'checkbox', checked: onlyCommon,
            onChange: event => setOnlyCommon(event.target.checked) }), t('capabilities.onlyCommon')))) : null,
      inheritedRulesOpen ? h(CapabilityDialog, { title: t('capabilities.inheritedRules'), onClose: () => setInheritedRulesOpen(false), t,
        footer: h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary',
          onClick: () => setInheritedRulesOpen(false) }, t('capabilities.dialogDone')) },
        h(PolicyRules, { value, catalog, disabled, onChange, t })) : null,
      batchOperation ? h(CapabilityBatchDialog, { operation: batchOperation, value, entries, disabled, onChange,
        onClose: () => setBatchOperation(null), t }) : null,
      activeFilters ? h('div', { className: 'ptcPlusActiveFilters' }, h('span', null, filterLabels.join(' · ')),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: clear }, t('capabilities.clear'))) : null,
      h('div', { className: 'ptcPlusCapabilityResultLine' }, h('span', { role: 'status' }, t('capabilities.results', { count: visible.length, total: entries.length })),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: onReload }, t('capabilities.reloadCatalog'))),
      catalogError ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.catalogReadFailed', { error: catalogError })) : null,
      entries.length === 0 ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.catalogEmpty'))
        : visible.length === 0 ? h('div', { className: 'ptcPlusCapabilityEmpty' }, h('p', null, t('capabilities.noMatches')),
          h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: clear }, t('capabilities.clear'))) :
          h('div', { className: 'ptcPlusCapabilityTable', role: 'table', 'aria-label': t('capabilities.management') },
            h('div', { className: 'ptcPlusCapabilityColumns', role: 'row' },
              ...CAPABILITY_SORT_COLUMNS.map(column => h('span', { key: column.key, role: 'columnheader',
                'aria-sort': capabilitySortDirection(sort, column.key),
                ...(column.key === 'name' ? { 'aria-label': t('capabilities.member'), className: 'ptcPlusCapabilityPickHead' } : {}) },
                ...(column.key === 'name' ? [h('input', { type: 'checkbox', className: 'ptcPlusPick', checked: allVisiblePicked,
                  ref: node => { if (node) node.indeterminate = someVisiblePicked && !allVisiblePicked },
                  disabled: visible.length === 0, 'aria-label': t('capabilities.selectAllVisible'),
                  onChange: toggleAllVisible })] : []),
                h('button', { type: 'button', className: 'ptcPlusCapabilitySort', title: t('capabilities.sortCycle'),
                  onClick: () => setSort(current => cycleCapabilitySort(current, column.key)) },
                t(`capabilities.${column.label}`), h('span', { 'aria-hidden': true },
                  capabilitySortDirection(sort, column.key) === 'ascending' ? '↑' : capabilitySortDirection(sort, column.key) === 'descending' ? '↓' : '↕'))))),
            h('div', { className: 'ptcPlusCapabilityList', role: 'rowgroup' }, ...visible.map(item => h('div', { key: item.id, className: 'ptcPlusCapabilityItem', role: 'row',
              'data-selected': entry?.id === item.id,
              onClick: () => setSelected(item.id) },
              h('div', { className: 'ptcPlusCapabilityIdentity', role: 'cell' },
                h('input', { type: 'checkbox', className: 'ptcPlusPick', checked: pickedIds.includes(item.id),
                  'aria-label': t('capabilities.selectForBatch', { name: item.name ?? item.id }),
                  onClick: event => event.stopPropagation(), onChange: () => togglePick(item.id) }),
                h('div', { className: 'ptcPlusCapabilityIdentityText' },
                  h('span', { className: 'ptcPlusCapabilityName' }, item.name), h('code', null, item.id))),
              h('span', { className: 'ptcPlusCapabilityBadge', role: 'cell', 'data-kind': type(item) }, t(`capabilities.type.${type(item)}`)),
              h('span', { className: 'ptcPlusCapabilitySource', role: 'cell' }, displayedSource(item)),
              // The cell stays a plain cell so its empty area selects the row; only the switch and
              // its own label swallow the click, keeping a toggle from also opening the row editor.
              h('div', { className: 'ptcPlusCapabilityAvailability', role: 'cell', 'data-state': state(item) },
                h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', id: `ptcPlusCapabilityAvailability-${item.id}`,
                  checked: item.resolvedRule.availability === 'enabled',
                  disabled: disabled('capabilityPolicy') || state(item) === 'source-closed',
                  'aria-label': t('capabilities.policy.availabilityFor', { name: item.id }),
                  onClick: event => event.stopPropagation(),
                  onChange: event => change('capabilityPolicy', changeCapabilityRule(policy, item.id, 'availability', event.target.checked ? 'enabled' : 'closed')) }),
                h('label', { htmlFor: `ptcPlusCapabilityAvailability-${item.id}`,
                  onClick: event => event.stopPropagation() }, t(`capabilities.rowState.${state(item)}`))),
              h('div', { role: 'cell', className: 'ptcPlusCapabilityContextCell' }, h('button', { type: 'button', className: 'ptcPlusCapabilityContext', 'data-capability-edit-id': item.id,
                'aria-label': t('capabilities.editContextFor', { name: item.id }), 'aria-haspopup': 'dialog',
                onClick: event => { event.stopPropagation(); setSelected(item.id) } },
                h('span', null, t(`capabilities.${item.resolvedRule.disclosure}`)),
                h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
                  h('path', { d: 'm15 5 4 4M4 20l4-1L20 7l-4-4L4 15Z' })))))))),
      entry ? h(CapabilityDialog, { title: entry.name, onClose: closeEditor, t, className: 'ptcPlusCapabilityEditorDialog',
        footer: h('button', { type: 'button', className: 'ptcPlusButton', onClick: closeEditor }, t('capabilities.closeDetails')) },
        h('code', null, entry.id), h('p', { className: 'ptcPlusDetail' }, t('capabilities.contextHelp')),
        manualSelect(entry), commonSwitch(entry),
        h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false ? 'capabilities.effect.paused'
          : value.capabilityManagementEnabled !== true ? 'capabilities.effect.rulesOff'
            : entry.resolvedRule.availabilitySource.startsWith('mcp:') && entry.resolvedRule.availability === 'closed' ? 'capabilities.effect.sourceClosed'
              : entry.resolvedRule.availability === 'closed' ? 'capabilities.effect.closed'
                : `capabilities.effect.disclosure.${entry.resolvedRule.disclosure}`)),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.policy.resolved', {
          availability: t(entry.resolvedRule.availability === 'enabled' ? 'capabilities.quick.enabled' : 'capabilities.closed'),
          disclosure: t(`capabilities.${entry.resolvedRule.disclosure}`),
          source: `${entry.resolvedRule.availabilitySource} · ${entry.resolvedRule.disclosureSource}` })),
        entry.rule.disclosure !== undefined ? h('button', { type: 'button', className: 'ptcPlusCapabilityLink', disabled: disabled('capabilityPolicy'),
          onClick: () => setManual(entry.id, 'automatic') }, t('capabilities.restoreAutomatic')) : null,
        entry.source?.kind === 'mcp' && entry.mcpServer ? h('section', { className: 'ptcPlusCapabilityEditorSection' },
          h('h5', null, t('capabilities.sourceRules')),
          h('p', { className: 'ptcPlusDetail' }, t('capabilities.serverHint')),
          h('div', { className: 'ptcPlusCapabilityEditorFields' },
            ...['availability', 'disclosure'].map(dimension => editorField(t(`capabilities.policy.${dimension}`),
              h(Select, { value: policy.mcpServers[entry.mcpServer]?.[dimension] ?? 'automatic', disabled: disabled('capabilityPolicy'),
                label: `${entry.mcpServer} · ${t(`capabilities.policy.${dimension}`)}`,
                onChange: next => change('capabilityPolicy', changeCapabilityRule(policy, `mcpServers.${entry.mcpServer}`, dimension, next)),
                options: ['automatic', ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)].map(key => ({ value: key,
                  label: t(key === 'automatic' ? 'capabilities.policy.inheritRule' : key === 'enabled' ? 'capabilities.quick.enabled' : `capabilities.${key}`) })) }))))) : null,
        entry.kind === 'skill' ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.skillDisclosure')) : null,
        entry.kind === 'skill' && entry.invocation ? h('p', { className: 'ptcPlusDetail' },
          t(entry.invocation.modelInvocable ? entry.invocation.userInvocable ? 'capabilities.invocation.both'
            : 'capabilities.invocation.model' : 'capabilities.invocation.user', { name: entry.name })) : null,
        entry.description ? h('section', { className: 'ptcPlusCapabilityEditorSection' },
          h('h5', null, t('capabilities.catalogDescription')), h('p', { className: 'ptcPlusCapabilityProse' }, entry.description)) : null,
        // Removal is offered whenever this identity has anything saved, because that
        // is exactly what the action removes; catalog membership is not its condition.
        policy.items[entry.id] !== undefined || baseline.includes(entry.id)
          ? h('button', { type: 'button', className: 'ptcPlusCapabilityLink',
            disabled: disabled('capabilityBaseline') || disabled('capabilityPolicy'), onClick: () => {
              const next = { ...policy, items: { ...policy.items } }; delete next.items[entry.id]; change('capabilityPolicy', next)
              if (baseline.includes(entry.id)) change('capabilityBaseline', baseline.filter(id => id !== entry.id))
            } }, t('capabilities.removeSaved')) : null,
        value.capabilityContextEnabled !== false && value.capabilityManagementEnabled === true ? h('section', { className: 'ptcPlusCapabilityEditorSection' },
          h('h5', null, t('capabilities.currentSession')),
          editorField(t('capabilities.sessionSelector'), h(Select, { value: sessionId ?? '', label: t('capabilities.sessionSelector'), onChange: setSessionId,
            options: [{ value: '', label: t('capabilities.chooseSession') }, ...(plans ?? []).map(item => ({ value: item.sessionId, label: item.sessionId }))] })),
          plansError ? h('p', { role: 'status', className: 'ptcPlusDetail' }, t('capabilities.unavailable', { error: plansError }))
            : !plan ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.selectObservation')) : h(React.Fragment, null,
              h('p', null, effective ? t(`capabilities.${effective.selection}`) : t('capabilities.notInSession')),
              effective ? h('p', { className: 'ptcPlusDetail' }, capabilityPlanReason(t, effective)) : null,
              effective?.evidence ? h('p', { className: 'ptcPlusDetail' }, `${effective.evidence.used}/${effective.evidence.eligible} (${effective.evidence.scope})`) : null,
              plan.pendingRefresh ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.pending')) : null)) : null) : null)

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
          ...['full', 'on-demand', 'closed'].map(selection => h('div', { key: selection }, h('strong', null, count(selection)), h('span', null, t(`capabilities.${selection}`)))),
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
            : [h('td', { key: 'selection' }, t(`capabilities.${entry?.selection ?? 'host'}`)), h('td', { key: 'reason' }, entry ? capabilityPlanReason(t, entry) : '—'), h('td', { key: 'size' }, `${item.contractBytes} B`)]))
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
          setting('capabilities.defaultDisclosure', t(`capabilities.${policy.defaults.disclosure}`)),
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
    const policy = capabilityPolicyForConfig(value)
    const write = next => onChange(field('capabilityPolicy'), JSON.stringify(next))
    const adaptive = [policy.defaults, ...Object.values(policy.categories), ...Object.values(policy.mcpServers), ...Object.values(policy.items)]
      .some(rule => rule.disclosure === 'adaptive')
    const summary = key => {
      if (choiceState(retained, applied, key) === 'unknown') return t('capabilities.combination.unknownSettings')
      if (key === 'description') {
        const description = t('capabilities.context.summary.description', { disclosure: t(`capabilities.${policy.defaults.disclosure}`) })
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
              options: CAPABILITY_DISCLOSURES.map(choice => ({ value: choice, label: t(`capabilities.${choice}`) })),
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

  function CapabilityWorkbench({ value, configurationReady, catalog, catalogError, plans, plansError, plansPending, plansStale, disabled, onChange, onReload, t, renderField, renderPlans, renderRefresh, id, selectedSessionId, onSessionSelect,
    allocation, allocationError, allocationPending, onApplyConfiguration, configurationWritable, saving, saveStatus }) {
    const [tab, setTab] = React.useState('manual')
    const [contextSection, setContextSection] = React.useState('description')
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
          h(CapabilityChoices, { value, catalog, catalogError, plans, plansError, disabled, onChange, onReload, t, selectedSessionId, onSessionSelect }))
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
 * Session capability choices write one record through the command channel.
 *
 * Three permanent facts decide what this panel may state: the Host's supply (which
 * rows exist), this session's own log (the "this session" column), and a completed
 * execution report (the evidence column). No runtime, service or global switch
 * produces any of them, so the read is not gated: a failed read is a defect
 * reported beside the rows, never a state the rows are replaced with.
 */
export function createSessionCapabilityControlsView(React, { commands, bindingCommands, Modal, Select, inspectSessionCatalog }) {
  const h = React.createElement
  // The six columns, in the order §3 fixes them. The binding group repeats them so
  // both groups answer the same questions in the same places.
  const COLUMNS = Object.freeze(['capabilities.column.name', 'capabilities.typesColumn', 'capabilities.sourceColumn',
    'capabilities.column.saved', 'capabilities.column.session', 'capabilities.column.evidence'])
  // §4 vocabulary. `inherit` is the session column's own word for a session that
  // recorded nothing, so no cell has to be blank or carry a denial.
  const AVAILABILITY_CHOICES = Object.freeze(['enabled', 'closed', 'automatic', 'inherit'])
  const DISCLOSURE_CHOICES = Object.freeze(['host', 'full', 'on-demand', 'adaptive', 'automatic', 'inherit'])
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

  return function SessionCapabilityControls({ sessionId, open, t, onClose }) {
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
      if (!open) {
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
    }, [open, load])
    const reload = () => {
      const controller = new AbortController()
      request.current?.abort()
      request.current = controller
      void load(controller.signal)
    }
    /**
     * One intention, one record: the row's control runs the same command a human
     * types and the receipt it returns is what the footer shows. A command that is
     * not listed for this session reports its own refusal; it is never pre-empted.
     */
    const record = async (channel, line, id) => {
      const controller = new AbortController()
      writes.current.add(controller)
      setWriting(current => current.includes(id) ? current : [...current, id])
      setReceipt(null)
      try {
        const result = await channel.run(sessionId, line, controller.signal)
        if (!mounted.current || controller.signal.aborted) return
        setReceipt({ text: receiptText(t, result) })
        await load(controller.signal)
      } catch (cause) {
        if (mounted.current && !controller.signal.aborted) setReceipt({ error: String(cause?.message ?? cause) })
      } finally {
        writes.current.delete(controller)
        if (mounted.current) setWriting(current => current.filter(item => item !== id))
      }
    }
    const word = value => t(`capabilities.word.${value}`)
    const choiceOptions = dimension => (dimension === 'availability' ? AVAILABILITY_CHOICES : DISCLOSURE_CHOICES)
      .map(value => ({ value, label: word(value) }))
    const familyOf = row => row.kind === 'binding' ? 'bindings'
      : row.kind === 'server' ? 'mcp'
        : row.category === 'skill' ? 'skills'
          : row.category === 'resource' ? 'mcp'
            : row.source?.kind === 'mcp' ? 'mcp_tools' : 'tools'
    const badgeOf = row => row.kind === 'binding' ? 'binding'
      : row.kind === 'server' ? 'server'
        : row.category === 'skill' ? 'skill'
          : row.category === 'resource' || row.source?.kind === 'mcp' ? 'resource' : 'tool'
    const sourceKeyOf = row => row.kind === 'binding' ? 'bindings'
      : row.source?.kind === 'mcp' ? `mcp:${row.source.server ?? ''}`
        : row.source?.kind === 'skill' ? `skill:${row.source.bucket ?? ''}`
          : row.source?.kind === 'host' ? 'host' : 'unknown'
    const sourceText = row => row.kind === 'binding' ? t('capabilities.source.bindings')
      : row.kind === 'server' ? t('capabilities.source.mcp')
        : row.source?.kind === 'mcp' ? String(row.source.server ?? t('capabilities.source.mcp'))
          : row.source?.kind === 'skill' ? t(`capabilities.source.${row.source.bucket ?? 'unknown'}`)
            : t(`capabilities.source.${row.source?.kind === 'host' ? 'host' : 'unknown'}`)
    const listedSourceLabel = key => key === 'bindings' ? t('capabilities.source.bindings')
      : key.startsWith('mcp:') ? `MCP · ${key.slice('mcp:'.length) || t('capabilities.source.mcp')}`
        : key.startsWith('skill:') ? `Skill · ${t(`capabilities.source.${key.slice('skill:'.length) || 'unknown'}`)}`
          : t(`capabilities.source.${key === 'host' ? 'host' : 'unknown'}`)
    // The saved column is the configuration's own value, read-only: a control here
    // would write the global settings from a session panel.
    const savedText = row => row.kind === 'binding' ? ''
      : row.kind === 'server' ? word(row.saved?.availability ?? 'automatic')
        : `${word(row.saved?.availability ?? 'automatic')} · ${word(row.saved?.disclosure ?? 'automatic')}`
    const recordedAvailability = row => row.session?.availability ?? 'inherit'
    const recordedDisclosure = row => row.session?.disclosure ?? 'inherit'
    const adoptionOf = row => ['use', 'skip', 'damaged'].includes(row.session?.use) ? row.session.use : 'use'
    const writeChoice = (row, dimension, value) => {
      if ((dimension === 'availability' ? recordedAvailability(row) : recordedDisclosure(row)) === value) return
      return void record(commands, `set session ${encodeURIComponent(row.id)} ${dimension} ${value}`, row.id)
    }
    // A damaged record still gets a control: the click writes the record that
    // replaces it, which is the only way the row can leave that state.
    const writeAdoption = row => void record(bindingCommands,
      `${adoptionOf(row) === 'use' ? 'skip' : 'use'} ${row.id}`, row.id)
    const sessionCell = row => {
      if (row.kind === 'binding') {
        const state = adoptionOf(row)
        return h('button', { type: 'button', className: 'ptcPlusBindingToggle', 'data-kind': state,
          'aria-pressed': state === 'use' ? 'true' : 'false', 'aria-busy': writing.includes(row.id) ? 'true' : undefined,
          onClick: () => writeAdoption(row) }, t(ADOPTION_WORDS[state]))
      }
      return DIMENSIONS.map(dimension => dimension === 'disclosure' && row.kind !== 'capability' ? null
        : h(Select, { key: dimension,
          label: dimension === 'availability' ? t('capabilities.policy.availabilityFor', { name: row.id })
            : t('capabilities.disclosureFor', { name: row.id }),
          value: dimension === 'availability' ? recordedAvailability(row) : recordedDisclosure(row),
          options: choiceOptions(dimension),
          onChange: value => writeChoice(row, dimension, value) }))
    }
    const renderRow = row => h('div', { key: row.id, role: 'row', className: 'ptcPlusSessionCapabilityRow ptcPlusCapabilityItem',
      'data-capability-id': row.id, 'data-kind': row.kind,
      ...(row.kind === 'binding' ? { 'data-binding-id': row.id, 'data-binding-state': adoptionOf(row) } : {}) },
      row.kind === 'binding'
        ? h('span', { role: 'cell', className: 'ptcPlusCapabilityIdentity' },
          h('span', { className: 'ptcPlusSessionCapabilityName' }, row.name ?? row.id),
          row.name && row.name !== row.id ? h('code', null, row.id) : null)
        : h('div', { role: 'cell', className: 'ptcPlusCapabilityIdentity' },
          h('input', { type: 'checkbox', className: 'ptcPlusPick', checked: picked.includes(row.id),
            'aria-label': t('capabilities.selectForBatch', { name: row.name ?? row.id }),
            onChange: () => setPicked(current => current.includes(row.id)
              ? current.filter(id => id !== row.id) : [...current, row.id]) }),
          h('div', { className: 'ptcPlusCapabilityIdentityText' },
            h('span', { className: 'ptcPlusSessionCapabilityName' }, row.name ?? row.id),
            row.name && row.name !== row.id ? h('code', null, row.id) : null)),
      h('span', { role: 'cell', className: 'ptcPlusCapabilityBadge', 'data-kind': badgeOf(row) },
        t(`capabilities.type.${badgeOf(row)}`)),
      h('span', { role: 'cell', className: 'ptcPlusCapabilitySource' }, sourceText(row)),
      h('span', { role: 'cell', className: 'ptcPlusSessionCapabilitySaved' }, savedText(row)),
      h('div', { role: 'cell', className: 'ptcPlusSessionCapabilitySession' }, sessionCell(row)),
      h('span', { role: 'cell', className: 'ptcPlusSessionCapabilityEvidence', 'data-proven': row.evidence === true ? 'true' : 'false' },
        row.evidence === true ? t('capabilities.word.proven') : null))
    const columnsRow = () => h('div', { className: 'ptcPlusSessionCapabilityColumns ptcPlusCapabilityColumns', role: 'row' },
      ...COLUMNS.map(key => h('span', { key, role: 'columnheader' }, t(key))))
    const capabilities = rows.filter(row => row.kind !== 'binding')
    const matches = row => {
      const text = [row.name, row.id, sourceText(row)].filter(Boolean).join(' ').toLocaleLowerCase()
      return text.includes(query.trim().toLocaleLowerCase())
    }
    const listed = capabilities.filter(row => (family === 'all' || familyOf(row) === family)
      && (source === 'all' || sourceKeyOf(row) === source) && matches(row))
    const bindings = rows.filter(row => row.kind === 'binding')
    const sources = [...new Set(capabilities
      .filter(row => family === 'all' || familyOf(row) === family).map(sourceKeyOf))].sort()
    const pickedRows = capabilities.filter(row => picked.includes(row.id))
    const batchLines = () => pickedRows.flatMap(row => DIMENSIONS
      .filter(dimension => batchChoices[dimension] !== 'keep' && (dimension === 'availability' || row.kind === 'capability'))
      .map(dimension => ({ row, dimension, choice: batchChoices[dimension] })))
    // A batch is the same decision applied to existing rows: it writes one record
    // per selected row through the same channel and creates no rows of its own.
    const applyBatch = async () => {
      const lines = batchLines()
      setBatchOpen(false)
      for (const { row, dimension, choice } of lines) {
        await record(commands, `set session ${encodeURIComponent(row.id)} ${dimension} ${choice}`, row.id)
      }
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
      onClose()
    }
    return h(Modal, { open, onClose: close, title: t('capabilities.quick.modalTitle'),
      closeLabel: t('settings.close'), headless: true, className: 'ptcPlusSessionCapabilityModal' },
    h('div', { className: 'ptcPlusSessionCapabilityHead' },
      h('div', null, h('h2', null, t('capabilities.quick.modalTitle')),
        h('p', null, t('capabilities.quick.sessionIdentity', { session: sessionId }))),
      h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('settings.close'),
        onClick: close }, '×')),
    h('div', { className: 'ptcPlusSessionCapabilityToolbar' },
      h('label', { className: 'ptcPlusSearch' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true },
          h('circle', { cx: 10, cy: 10, r: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
          h('path', { d: 'm15 15 6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 2 })),
        h('input', { type: 'search', value: query, 'aria-label': t('capabilities.search'),
          placeholder: t('capabilities.search'), onChange: event => setQuery(event.target.value) })),
      filter(t('capabilities.quick.kind'), family, chooseFamily,
        [['all', t('capabilities.quick.all')], ...FAMILIES.map(key => [key, t(`capabilities.quick.${key}`)])]),
      filter(t('capabilities.sourceFilter'), source, chooseSource,
        [['all', t('capabilities.allSources')], ...sources.map(key => [key, listedSourceLabel(key)])]),
      h('button', { type: 'button', className: 'ptcPlusButton', 'aria-haspopup': 'dialog',
        'aria-label': t('capabilities.batchSettings'),
        onClick: () => { setBatchChoices({ availability: 'keep', disclosure: 'keep' }); setBatchOpen(true) } },
        t('capabilities.batchSettings'),
        picked.length ? h('span', { className: 'ptcPlusCapabilityBatchCount', 'aria-hidden': true },
          String(picked.length)) : null)),
    // A read that failed is a defect in the panel's own source, so it names the
    // error and offers the retry beside the rows it could not replace.
    defect === null ? null : h('p', { className: 'ptcPlusSessionCapabilityMessage', role: 'status' },
      t('capabilities.quick.catalogError', { error: defect }), ' ',
      h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: reload }, t('capabilities.reloadCatalog'))),
    h('div', { className: 'ptcPlusSessionCapabilityList' },
      h('div', { className: 'ptcPlusSessionCapabilityTable', role: 'table', 'aria-label': t('capabilities.quick.members') },
        columnsRow(),
        loaded && listed.length === 0 ? h('p', { className: 'ptcPlusSessionCapabilityMessage' },
          t(capabilities.length === 0 ? 'capabilities.quick.supplyEmpty' : 'capabilities.noMatches')) : null,
        ...listed.map(renderRow)),
      // The group is always present: the Host supplies the binding document whether or
      // not this session has used any of it, and a zero-row group is an empty table.
      h('section', { key: 'bindings', className: 'ptcPlusSessionCapabilityGroup ptcPlusBindingGroup' },
        h('h3', null, t('bindings.title')),
        h('div', { className: 'ptcPlusBindingTable', role: 'table', 'aria-label': t('bindings.title') },
          columnsRow(),
          ...bindings.map(renderRow)))),
    batchOpen ? h(Modal, { open: true, onClose: () => setBatchOpen(false), title: t('capabilities.batchSettings'),
      closeLabel: t('capabilities.batch.cancel'), headless: true, className: 'ptcPlusCapabilityBatchModal' },
      h('div', { className: 'ptcPlusCapabilityBatchHead' }, h('h2', null, t('capabilities.batchSettings')),
        h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('capabilities.batch.cancel'),
          onClick: () => setBatchOpen(false) }, '\u00d7')),
      h('div', { className: 'ptcPlusCapabilityBatchBody' },
        h('p', { className: 'ptcPlusDetail', role: 'status' }, t('capabilities.batch.selected', { count: pickedRows.length })),
        h('ul', { className: 'ptcPlusCapabilityBatchTargets', 'aria-label': t('capabilities.batch.targetList') },
          ...pickedRows.map(row => h('li', { key: row.id }, h('span', null, row.name ?? row.id), h('code', null, row.id)))),
        h('div', { className: 'ptcPlusCapabilityBatchFields' }, ...DIMENSIONS.map(dimension =>
          h('div', { key: dimension, className: 'ptcPlusCapabilityFilter' },
            h('span', null, t(`capabilities.policy.${dimension}`)),
            h(Select, { value: batchChoices[dimension], label: t(`capabilities.policy.${dimension}`),
              onChange: choice => setBatchChoices(current => ({ ...current, [dimension]: choice })),
              options: [{ value: 'keep', label: t('capabilities.batch.keep') }, ...choiceOptions(dimension)] }))))),
      h('div', { className: 'ptcPlusCapabilityBatchFooter' },
        h('button', { type: 'button', className: 'ptcPlusButton', onClick: () => setBatchOpen(false) },
          t('capabilities.batch.cancel')),
        h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary', onClick: () => void applyBatch() },
          t('capabilities.batch.record', { count: batchLines().length })))) : null,
    h('div', { className: 'ptcPlusSessionCapabilityFooter' },
      // The footer states the same receipt the chat card does, in the current
      // language: which record this write named, its choice and its session. The
      // raw payload stays in the command's own result, where history keeps it.
      receipt === null ? null : h('span', { role: 'status' }, receipt.error === undefined
        ? capabilityCommandText(t, receipt.text)
        : t('capabilities.quick.writeError', { error: receipt.error }))))
  }
}
