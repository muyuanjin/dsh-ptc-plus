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

export function capabilityCommandText(t, text) {
  if (text?.key) return t(text.key, text.params)
  const receipt = readCapabilityCommandReceipt(text)
  return receipt ? t(`capabilities.receipt.${receipt.state}`, { session: receipt.sessionId, error: receipt.error ?? '' }) : text
}

// Host-owned context the model sees in PTC mode. The plugin never receives the host's
// own instruction text and cannot edit these bytes; it can only name the section it
// appends into or replaces. Listing them keeps the pane answering "what does the model
// actually see" instead of silently showing plugin-owned anchors only.
const HOST_CONTEXT_SECTIONS = Object.freeze([
  Object.freeze({ id: 'host:system-prompt', presence: 'capabilities.prompt.hostPresenceEvery' }),
  Object.freeze({ id: 'host:tools:sdk', presence: 'capabilities.prompt.hostPresenceCapabilities' }),
])

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

export function createCapabilityCommandCard(React) {
  const h = React.createElement
  return function CapabilityCommandCard({ node, t }) {
    const [showSource, setShowSource] = React.useState(false)
    const command = `/${node.name ?? 'capabilities'}${node.args ? ` ${String(node.args).trim()}` : ''}`
    const text = node.outcome?.text
    const receipt = readCapabilityCommandReceipt(text)
    const legacyRefresh = text === 'Session capability environment refreshed; the model-visible notification is recorded.'
    if (receipt || String(node.args ?? '').trim() === 'refresh' || legacyRefresh) {
      const outcome = receipt ? t(`capabilities.card.${receipt.state}`, { error: receipt.error ?? '' })
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
    const entries = json?.schema === 'ptc-capability-catalog/v1' && Array.isArray(json.entries)
      && json.entries.every(entry => entry && typeof entry.id === 'string'
        && ['name', 'description', 'effective', 'saved', 'temporary']
          .every(key => entry[key] === undefined || typeof entry[key] === 'string')
        && ['savedRule', 'temporaryRule'].every(key => entry[key] === undefined || validCatalogRule(entry[key], key === 'temporaryRule'))) ? json.entries : null
    const outcome = entries ? t('capabilities.card.catalogCount', { count: entries.length })
      : json ? t('capabilities.card.details')
        : node.outcome ? capabilityCommandText(t, text)
          ?? t(node.outcome.kind === 'error' ? 'capabilities.commandFailed' : 'capabilities.refreshAcknowledged')
          : t('capabilities.refreshing')
    const label = (entry, key) => {
      const ruleKey = key === 'saved' ? 'savedRule' : key === 'temporary' ? 'temporaryRule' : 'effectiveDimensions'
      const rule = entry[ruleKey]
      if (rule !== undefined && (key !== 'effective' || validCatalogRule({ availability: rule?.availability, disclosure: rule?.disclosure }))) {
        const dimensions = capabilityRuleLabel(t, rule, key === 'temporary' ? 'capabilities.quick.noOverride' : 'capabilities.policy.inheritRule')
        return key === 'effective' ? `${capabilityChoiceLabel(t, entry.effective)} (${dimensions})` : dimensions
      }
      return capabilityChoiceLabel(t, entry[key])
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
          h('thead', null, h('tr', null, ...['member', 'quick.effective', 'quick.globalSaved', 'quick.temporary']
            .map(key => h('th', { key, scope: 'col' }, t(`capabilities.${key}`))))),
          h('tbody', null, ...entries.map((entry, index) => h('tr', { key: `${entry.id}-${index}` },
            h('td', null, h('strong', null, entry.name ?? entry.id),
              entry.description ? h('small', null, entry.description) : null),
            ...['effective', 'saved', 'temporary'].map(key => h('td', { key }, label(entry, key))))))))) : null,
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

/** Catalog facts and saved preferences stay separate from frozen session results. */
export function capabilitySettingsEntries(value, catalog, plans, uncertain = false) {
  const baseline = JSON.parse(value.capabilityBaseline ?? CONFIG_DEFAULTS.capabilityBaseline)
  const entries = new Map((catalog ?? []).map(entry => [entry.id, { ...entry, available: true }]))
  for (const plan of plans ?? []) for (const entry of plan.effective.entries) {
    if (!entries.has(entry.id)) entries.set(entry.id, { id: entry.id, category: entry.category })
  }
  const policy = capabilityPolicyForConfig(value)
  for (const id of [...baseline, ...Object.keys(policy.items)].filter(id => !id.startsWith('mcpServers.'))) if (!entries.has(id)) entries.set(id, { id })
  return [...entries.values()].map(entry => ({ ...entry,
    name: entry.name ?? entry.id,
    kind: ['tool', 'skill'].includes(entry.category) ? entry.category
      : ['resource', 'resource-template'].includes(entry.category) ? 'resource' : 'other',
    availability: catalog === null || uncertain ? 'unknown' : entry.available ? 'available' : 'unavailable',
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
    const targetIds = new Set(entries.filter(entry => entry.availability === 'available').map(entry => entry.id))
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
        operation.excluded ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.batch.excluded', { count: operation.excluded })) : null,
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
    const [availability, setAvailability] = React.useState('all')
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
      && (availability === 'all' || entry.availability === availability)
      && `${entry.name} ${entry.id} ${entry.description ?? ''} ${sourceLabel(entry)}`.toLowerCase().includes(normalizedQuery))
    const defaultOrder = (a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.id, b.id)
    const state = item => item.availability === 'unknown' ? 'unknown' : item.availability === 'unavailable' ? 'unavailable'
      : value.capabilityContextEnabled === false || value.capabilityManagementEnabled !== true ? 'unapplied'
        : item.resolvedRule.availabilitySource.startsWith('mcp:') && item.resolvedRule.availability === 'closed' ? 'source-closed' : item.resolvedRule.availability
    const type = item => item.source?.kind === 'mcp' ? 'resource' : item.kind
    const displayedSource = item => item.source?.kind === 'mcp' ? item.source.server ?? sourceLabel(item) : sourceLabel(item)
    const groups = new Map()
    for (const entry of filtered) {
      const group = entry.source?.kind === 'mcp' && entry.source.server ? `mcp:${entry.source.server}`
        : entry.availability === 'unavailable' ? 'unavailable' : entry.kind
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(entry)
    }
    const groupOrder = ['tool', ...[...groups.keys()].filter(key => key.startsWith('mcp:')).sort(compare), 'skill', 'resource', 'other', 'unavailable']
    const defaultEntries = groupOrder.flatMap(group => (groups.get(group) ?? []).sort(defaultOrder))
    const visible = sortCapabilityEntries(defaultEntries, sort, (item, column) => column === 'name' ? item.name
      : column === 'type' ? t(`capabilities.type.${type(item)}`)
        : column === 'source' ? displayedSource(item)
          : column === 'availability' ? t(`capabilities.rowState.${state(item)}`)
            : t(`capabilities.${item.resolvedRule.disclosure}`))
    const pickedIds = picked.filter(id => entries.some(item => item.id === id))
    const pickedEntries = pickedIds.map(id => entries.find(item => item.id === id)).filter(Boolean)
    const pickedTargets = pickedEntries.filter(item => item.availability === 'available')
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
    const clear = () => { setQuery(''); setKind('all'); setSource('all'); setStrategy('all'); setAvailabilityRule('all'); setOnlyCommon(false); setAvailability('all') }
    const activeFilters = Number(kind !== 'all') + Number(source !== 'all') + Number(strategy !== 'all') + Number(availabilityRule !== 'all') + Number(onlyCommon) + Number(availability !== 'all')
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
      onlyCommon ? t('capabilities.onlyCommon') : null,
      availability !== 'all' ? t(`capabilities.availability.${availability}`) : null].filter(Boolean)
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
          disabled: disabled('capabilityPolicy') || pickedTargets.length === 0,
          onClick: () => setBatchOperation({
            targets: pickedTargets.map(item => ({ id: item.id, name: item.name })),
            excluded: pickedIds.length - pickedTargets.length,
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
            onChange: event => setOnlyCommon(event.target.checked) }), t('capabilities.onlyCommon')),
          select(t('capabilities.availabilityFilter'), availability, setAvailability,
            ['all', 'available', 'unavailable', 'unknown'].map(key => [key, t(`capabilities.availability.${key}`)])))) : null,
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
      catalogError ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.catalogUnavailable', { error: catalogError })) : null,
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
              'data-selected': entry?.id === item.id, 'data-availability': item.availability,
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
        entry.kind === 'skill' && entry.invocationConflict ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.invocation.varies')) : null,
        entry.kind === 'skill' && entry.invocation ? h('p', { className: 'ptcPlusDetail' },
          t(entry.invocation.modelInvocable ? entry.invocation.userInvocable ? 'capabilities.invocation.both'
            : 'capabilities.invocation.model' : 'capabilities.invocation.user', { name: entry.name })) : null,
        entry.description ? h('section', { className: 'ptcPlusCapabilityEditorSection' },
          h('h5', null, t('capabilities.catalogDescription')), h('p', { className: 'ptcPlusCapabilityProse' }, entry.description)) : null,
        entry.availability === 'unavailable' ? h('button', { type: 'button', className: 'ptcPlusCapabilityLink',
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
    if (!allocation) return selectedSessionId ? h('p', { className: 'ptcPlusCapabilityNotice' }, t('capabilities.observationUnavailable')) : null
    const { plan, coverage, configuration } = allocation
    const count = selection => plan.entries.filter(entry => entry.selection === selection).length
    const evidenceFor = item => coverage?.[item.id]?.[statisticsScope]
    const usable = evidence => evidence?.status === 'usable' && Number.isFinite(evidence.used) && Number.isFinite(evidence.eligible)
    const coverageText = evidence => usable(evidence) && Number.isFinite(evidence.coverage) ? `${Math.round(evidence.coverage * 100)}%`
      : usable(evidence) ? t('capabilities.statStatus.no-samples')
      : t(`capabilities.statStatus.${evidence?.status ?? 'unavailable'}`)
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
        : coverage === null ? h('p', { role: 'status' }, t('capabilities.statStatus.unavailable')) : null,
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
    // The pane accounts for the saved document, which is what a save would write;
    // when the feature is paused the notice and the per-anchor label say the bytes
    // are not applied, so a number here can never read as a delivered byte.
    const resolved = resolvePromptText(value.promptText)
    const [openSlots, setOpenSlots] = React.useState({})
    // The panel is the accounting view: cards, totals and per-anchor rows all come
    // from accountPromptText, so a number on screen can be traced to a slot.
    const account = accountPromptText(resolved)
    const write = overrides => {
      onChange(CONFIG_FIELDS.find(field => field.key === 'promptText'),
        JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides }))
    }
    const update = (slotId, next) => {
      const overrides = { ...document.overrides }
      if (next === undefined) delete overrides[slotId]
      else overrides[slotId] = next
      write(overrides)
    }
    // Two slot labels, never derived from each other:
    // - 未测槽: slots on a channel this build has not wired to the resolver yet,
    // - 动态槽: slots on a wired anchor whose composer produces the bytes at
    //   assembly time (policy prose, user-supplied instructions).
    // 投递未证 stays out of this panel: only a boundary capture lane can report it.
    const unmeasuredSlots = account.counts.unmeasuredSlots
    const dynamicSlots = account.counts.dynamicSlots
    const unwiredAnchors = account.anchors.filter(anchor => anchor.wired !== true)
    const measuredBytes = account.owners.A + account.owners.B + account.owners.C
    // A card prints the bytes this build can actually measure, and names how many
    // of that owner's slots are still unconnected. An owner with nothing measured
    // prints only the suffix: a bare 0 B would read as "this owner costs nothing".
    // A card that carries projected slots also says those numbers are template
    // bytes, because the holes are filled from runtime facts when the slot renders.
    const card = (key, labelKey) => {
      const unmeasured = account.counts.unmeasured[key]
      const dynamic = account.counts.dynamic[key]
      const bytes = account.owners[key]
      const projected = account.slots.some(slot => slot.owner === key && slot.measured && slot.kind === 'projected')
      const measured = bytes > 0
        ? h('span', { className: 'ptcPlusDetail' }, t('capabilities.prompt.cardBytes', { bytes }))
        : null
      return h('div', { key, className: 'ptcPlusCapabilityField', 'data-owner': key },
        h('span', null, t(labelKey)),
        measured,
        projected
          ? h('span', { className: 'ptcPlusDetail', 'data-prompt-template-bytes': 'true' },
            t('capabilities.prompt.templateBytes'))
          : null,
        unmeasured === 0
          ? null
          : h('span', { className: 'ptcPlusDetail' }, t('capabilities.prompt.cardUnwired', { count: unmeasured })),
        // A dynamic slot is measured at assembly, so it carries no bytes here; the
        // card must still account for it or the owner reads as if it had nothing.
        dynamic === 0
          ? null
          : h('span', { className: 'ptcPlusDetail' }, t('capabilities.prompt.cardDynamic', { count: dynamic })))
    }
    const cards = h('div', { className: 'ptcPlusPromptCards' },
      card('A', 'capabilities.prompt.ownerEditable'),
      card('B', 'capabilities.prompt.ownerReadOnly'),
      card('C', 'capabilities.prompt.ownerOther'),
      h('div', { key: 'mixed', className: 'ptcPlusCapabilityField' },
        h('span', null, t('capabilities.prompt.ownerMixed')),
        h('span', { className: 'ptcPlusDetail' }, t('capabilities.prompt.cardMixed', { count: account.counts.mixed }))))
    const totals = h('p', { className: 'ptcPlusDetail' }, t('capabilities.prompt.totals', {
      bytes: measuredBytes,
      anchors: account.counts.total,
      unmeasured: unmeasuredSlots,
      dynamic: dynamicSlots,
    }))
    const slotLabel = slot => {
      if (slot.measured) return t('capabilities.prompt.slotBytes', { bytes: slot.bytes, owner: slot.owner })
      if (slot.kind === 'aggregate') return t('capabilities.prompt.aggregateSlot')
      return t(slot.unwired === true ? 'capabilities.prompt.unmeasuredSlot' : 'capabilities.prompt.dynamicSlot')
    }
    const slotControl = (anchor, slot) => {
      const override = Object.hasOwn(document.overrides, slot.slotId) ? document.overrides[slot.slotId] : undefined
      const asset = PROMPT_ASSETS.find(candidate => candidate.id === slot.slotId)
      if (asset === undefined || slot.owner !== 'A' || asset.defaultText === null) return null
      const current = override ?? asset.defaultText
      // The built-in sentence is the field's value, not a placeholder: the user must be
      // able to tweak the shipped wording without retyping it. Only a read-only slot is
      // muted, and it never renders a textarea at all.
      return h('div', { key: `${slot.slotId}-control`, className: 'ptcPlusPromptEditor',
        'data-editor-slot': slot.slotId },
        h('textarea', {
          id: `${id}-prompt-${slot.slotId}`, rows: 3, disabled: blocked, spellCheck: false,
          className: 'ptcPlusPromptTextarea', 'aria-label': slot.slotId, value: current,
          onChange: event => update(slot.slotId, event.target.value === '' ? undefined : event.target.value),
        }),
        h('div', { className: 'ptcPlusPromptEditorFoot' },
          h('span', { className: 'ptcPlusDetail' }, t('capabilities.prompt.bytes', {
            used: slot.bytes, max: PROMPT_TEXT_MAX_SLOT_BYTES,
          })),
          override === '' ? h('span', { className: 'ptcPlusDetail' }, t('capabilities.prompt.omitted')) : null,
          h('button', { type: 'button', disabled: blocked || override === undefined,
            onClick: () => update(slot.slotId, undefined) }, t('capabilities.prompt.reset')),
          asset.omittable ? h('button', { type: 'button', disabled: blocked,
            onClick: () => update(slot.slotId, '') }, t('capabilities.prompt.omit')) : null))
    }
    // A slot chip is the only place a slot id appears. Editable slots are buttons
    // that open the anchor's single editor; read-only slots are inert chips that
    // carry their reason code and slot kind instead of a full-width field.
    const chip = (anchor, slot) => {
      const markers = [
        slot.measured && slot.kind === 'projected'
          ? h('span', { key: 'template', className: 'ptcPlusPromptChipNote', 'data-prompt-template-bytes': 'true' },
            t('capabilities.prompt.templateBytes'))
          : null,
        slot.kind === 'aggregate'
          ? h('span', { key: 'aggregate', className: 'ptcPlusPromptChipNote', 'data-prompt-aggregate-set': 'true' },
            t('capabilities.prompt.aggregateFrozen'))
          : null,
      ].filter(Boolean)
      const shared = {
        className: 'ptcPlusPromptChip',
        'data-slot-id': slot.slotId,
        'data-slot-kind': slot.kind,
        title: slot.slotId,
      }
      if (slot.owner !== 'A') {
        return h('span', { key: slot.slotId, ...shared, 'data-readonly': 'true' },
          h('span', { className: 'ptcPlusPromptChipLabel' }, slot.slotId),
          h('span', { className: 'ptcPlusPromptChipNote' },
            t('capabilities.prompt.readonlyReason', { reason: slot.reason, kind: slot.kind })),
          ...markers)
      }
      const selected = openSlots[anchor.anchorId] === slot.slotId
      return h('button', {
        key: slot.slotId,
        ...shared,
        type: 'button',
        disabled: blocked,
        'aria-pressed': selected,
        onClick: () => setOpenSlots(previous => ({ ...previous, [anchor.anchorId]: slot.slotId })),
      },
        h('span', { className: 'ptcPlusPromptChipLabel' }, slot.slotId),
        h('span', { className: 'ptcPlusPromptChipNote' }, t('capabilities.prompt.chipMeta', { owner: slot.owner })),
        ...markers)
    }
    const rows = account.anchors.map(anchor => {
      // One editor per anchor: the chips choose which editable slot is open, and the
      // run_code anchor keeps its three descriptions behind one textarea.
      const editableSlots = anchor.slots.filter(slot => slot.owner === 'A'
        && PROMPT_ASSETS.find(candidate => candidate.id === slot.slotId)?.defaultText !== null)
      const selectedId = openSlots[anchor.anchorId] ?? editableSlots[0]?.slotId
      const selected = editableSlots.find(slot => slot.slotId === selectedId)
      // An unwired anchor renders no control at all: its bytes are not delivered yet,
      // so an editor here would promise an effect the build cannot produce.
      const editor = anchor.wired !== true || editableSlots.length === 0 ? null : slotControl(anchor, selected)
      const bytes = anchor.wired !== true
        ? h('span', { className: 'ptcPlusPromptAnchorBytes', 'data-anchor-bytes': 'unwired' },
          t('capabilities.prompt.unwiredRow', { slots: anchor.unmeasuredSlots }))
        : h('span', { className: 'ptcPlusPromptAnchorBytes', 'data-anchor-bytes': String(anchor.bytes) },
          paused
            ? t('capabilities.prompt.pausedBytes', { bytes: anchor.bytes })
            : t('capabilities.prompt.cardBytes', { bytes: anchor.bytes }))
      // The row carries its identity and wiring so a test can assert "one row per
      // anchor", "no control on an unwired row" and "one textarea per wired anchor"
      // without trusting the renderer. Cells follow the header columns, so the table
      // stays aligned instead of turning into a pile of chips.
      const status = anchor.owner === 'mixed'
        ? t('capabilities.prompt.ownerMixed')
        : anchor.owner === 'A' ? t('capabilities.prompt.ownerEditable')
          : anchor.owner === 'B' ? t('capabilities.prompt.ownerReadOnly') : t('capabilities.prompt.ownerOther')
      return h('div', {
        key: anchor.anchorId,
        className: 'ptcPlusPromptRow',
        role: 'row',
        'data-anchor-id': anchor.anchorId,
        'data-wired': anchor.wired === true ? 'true' : 'false',
        'data-paused': paused ? 'true' : 'false',
      },
        h('span', { className: 'ptcPlusPromptCell', role: 'cell', 'data-cell': 'channel' }, anchor.channel),
        h('code', { className: 'ptcPlusPromptCell ptcPlusPromptAnchorId', role: 'cell', 'data-cell': 'anchor',
          title: anchor.anchorId }, anchor.anchorId),
        h('span', { className: 'ptcPlusPromptCell', role: 'cell', 'data-cell': 'presence',
          title: anchor.presence }, anchor.presence),
        h('span', { className: 'ptcPlusPromptCell ptcPlusPromptAnchorBytes', role: 'cell', 'data-cell': 'bytes' },
          bytes),
        h('span', { className: 'ptcPlusPromptCell ptcPlusPromptStatus', role: 'cell', 'data-cell': 'status' },
          h('span', { className: 'ptcPlusPromptChip', 'data-owner-status': anchor.owner },
            h('span', { className: 'ptcPlusPromptChipLabel' }, status)),
          anchor.slots.filter(slot => slot.owner !== 'A').length === 0 ? null
            : h('small', { className: 'ptcPlusDetail' }, t('capabilities.prompt.readonlySummary', {
              count: anchor.slots.filter(slot => slot.owner !== 'A').length,
            }))),
        h('div', { className: 'ptcPlusPromptChips', role: 'cell', 'data-cell': 'slots' },
          ...anchor.slots.map(slot => chip(anchor, slot))),
        editor)
    })
    const header = h('div', { className: 'ptcPlusPromptRow ptcPlusPromptHeader', role: 'row' },
      h('span', { role: 'columnheader' }, t('capabilities.prompt.columnChannel')),
      h('span', { role: 'columnheader' }, t('capabilities.prompt.columnAnchor')),
      h('span', { role: 'columnheader' }, t('capabilities.prompt.columnPresence')),
      h('span', { role: 'columnheader' }, t('capabilities.prompt.columnBytes')),
      h('span', { role: 'columnheader' }, t('capabilities.prompt.columnStatus')))
    // Host-owned context: read-only rows so the pane also answers what the host puts in
    // the request. The plugin cannot edit these bytes and does not pretend otherwise.
    const hostRows = HOST_CONTEXT_SECTIONS.map(section => h('div', {
      key: section.id, className: 'ptcPlusPromptRow ptcPlusPromptHostRow', role: 'row',
      'data-host-row': section.id,
    },
      h('span', { className: 'ptcPlusPromptCell', role: 'cell', 'data-cell': 'channel' }, 'prompt'),
      h('code', { className: 'ptcPlusPromptCell ptcPlusPromptAnchorId', role: 'cell', 'data-cell': 'anchor',
        title: section.id }, section.id),
      h('span', { className: 'ptcPlusPromptCell', role: 'cell', 'data-cell': 'presence' }, t(section.presence)),
      h('span', { className: 'ptcPlusPromptCell', role: 'cell', 'data-cell': 'bytes' },
        t('capabilities.prompt.hostUnavailable')),
      h('span', { className: 'ptcPlusPromptCell ptcPlusPromptStatus', role: 'cell', 'data-cell': 'status' },
        h('span', { className: 'ptcPlusPromptChip', 'data-readonly': 'true' },
          h('span', { className: 'ptcPlusPromptChipLabel' }, t('capabilities.prompt.ownerHost')),
          h('span', { className: 'ptcPlusPromptChipNote' }, t('capabilities.prompt.hostSection'))))))
    return h('section', {
      className: 'ptcPlusPromptText', 'data-prompt-paused': paused ? 'true' : 'false',
    },
      h('p', null, t('capabilities.prompt.intro')),
      paused
        ? h('p', { className: 'ptcPlusPromptPaused', role: 'status', 'data-prompt-paused-notice': 'true' },
          t('capabilities.prompt.paused'))
        : null,
      readError === undefined ? null : h('p', { className: 'ptcPlusDetail' }, t('capabilities.prompt.unreadable', { error: readError })),
      ...resolved.reported.map((entry, index) => h('p', { key: `report-${index}`, className: 'ptcPlusDetail' },
        t('capabilities.prompt.reported', {
          asset: entry.slotId ?? entry.anchorId ?? 'document', reason: entry.reason,
        }))),
      cards,
      totals,
      unwiredAnchors.length === 0 ? null : h('p', { className: 'ptcPlusDetail' },
        t('capabilities.prompt.unwiredSummary', { anchors: unwiredAnchors.length, slots: unmeasuredSlots })),
      h('div', { className: 'ptcPlusPromptTable', role: 'table' }, header, ...rows, ...hostRows))
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
        h('div', { className: 'ptcPlusTaskHead' }, h('h4', null, t(`capabilities.title.${key}`)),
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

/** Execute a human command through DSH; a receipt never stands in for model publication. */
export function createCapabilityRefreshView(React, commands) {
  const h = React.createElement
  const absent = Object.freeze({ getSnapshot: () => false, subscribe: () => () => {} })
  return function CapabilityRefreshButton({ sessionId, enabled, t, onApplied, onInvalidated }) {
    const source = React.useMemo(() => sessionId ? commands.source(sessionId) : absent, [sessionId])
    const available = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    const [pending, setPending] = React.useState(false)
    const [status, setStatus] = React.useState(null)
    const request = React.useRef(null)
    React.useEffect(() => {
      setStatus(null)
      setPending(false)
      return () => { request.current?.abort(); request.current = null }
    }, [sessionId, enabled, available])
    const cancel = event => {
      event.stopPropagation()
      request.current?.abort(); request.current = null; setPending(false)
      setStatus({ key: 'capabilities.refreshCancelled' })
      onApplied?.()
    }
    const execute = async event => {
      event.stopPropagation()
      if (!enabled || !available || request.current) return
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
      h('button', { type: 'button', className: 'ptcPlusButton', disabled: !enabled || !available || pending,
        title: !available ? t(sessionId ? 'capabilities.refreshUnavailable' : 'capabilities.chooseSession') : undefined,
        onClick: execute }, t(pending ? 'capabilities.refreshing' : 'capabilities.applySession')),
      pending ? h('button', { type: 'button', className: 'ptcPlusButton', onClick: cancel }, t('capabilities.cancelRefresh')) : null,
      status ? h('p', { className: 'ptcPlusDetail', role: 'status' }, capabilityCommandText(t, status))
        : !available ? h('p', { className: 'ptcPlusDetail' }, t(sessionId ? 'capabilities.refreshUnavailable' : 'capabilities.chooseSession')) : null)
  }
}

/** Session capability choices use the real command transaction and a read-only catalog observation. */
export function createSessionCapabilityControlsView(React, { commands, Modal, Select, inspectSessionCatalog }) {
  const h = React.createElement
  const emptyDrafts = () => ({})
  return function SessionCapabilityControls({ sessionId, open, enabled, t, onClose }) {
    const source = React.useMemo(() => commands.source(sessionId), [sessionId])
    const available = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    const [catalog, setCatalog] = React.useState([])
    const [management, setManagement] = React.useState('unknown')
    const [savedSettings, setSavedSettings] = React.useState(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState(null)
    const [drafts, setDrafts] = React.useState(emptyDrafts)
    const [picked, setPicked] = React.useState([])
    const [batchOpen, setBatchOpen] = React.useState(false)
    const [batchChoices, setBatchChoices] = React.useState({ availability: 'keep', disclosure: 'keep' })
    const [selectedId, setSelectedId] = React.useState(null)
    const [pane, setPane] = React.useState('list')
    const [query, setQuery] = React.useState('')
    const [kind, setKind] = React.useState('all')
    const [sourceFilter, setSourceFilter] = React.useState('all')
    const [stateFilter, setStateFilter] = React.useState('all')
    const [sort, setSort] = React.useState(null)
    const [focusDimension, setFocusDimension] = React.useState(null)
    const [status, setStatus] = React.useState(null)
    const [pending, setPending] = React.useState(false)
    const request = React.useRef(null)
    const applying = React.useRef(false)
    const mounted = React.useRef(true)
    const detail = React.useRef(null)
    const list = React.useRef(null)
    React.useEffect(() => {
      if (!focusDimension) return
      const field = focusDimension === 'list' ? list.current?.querySelector('[data-selected="true"] .ptcPlusSessionCapabilityName')
        : detail.current?.querySelector(`[data-capability-dimension="${focusDimension}"] [role="combobox"]`)
        ?? detail.current?.querySelector('[role="combobox"]')
      field?.focus({ preventScroll: true })
      setFocusDimension(null)
    }, [focusDimension, selectedId, pane])
    React.useEffect(() => {
      mounted.current = true
      return () => { mounted.current = false; request.current?.abort(); request.current = null }
    }, [])
    React.useEffect(() => {
      request.current?.abort()
      request.current = null
      applying.current = false
      setCatalog([])
      setManagement('unknown')
      setSavedSettings(null)
      setDrafts(emptyDrafts())
      setPicked([])
      setBatchOpen(false)
      setSelectedId(null)
      setPane('list')
      setFocusDimension(null)
      setStatus(null)
      setPending(false)
      setError(null)
    }, [sessionId])
    const load = React.useCallback(async signal => {
      setLoading(true)
      try {
        const payload = await inspectSessionCatalog(sessionId, signal)
        if (signal.aborted || !mounted.current || request.current?.signal !== signal) return
        if (payload?.schema !== 'ptc-capability-session-catalog/v1' || !Array.isArray(payload.entries)) {
          throw new Error('Invalid capability catalog')
        }
        setCatalog(payload.entries)
        setPicked(current => current.filter(id => payload.entries.some(entry => entry.id === id)))
        setManagement(['managed', 'paused', 'off', 'unknown'].includes(payload.management)
          ? payload.management : 'unknown')
        setSavedSettings(payload.savedSettings !== null && typeof payload.savedSettings === 'object'
          && !Array.isArray(payload.savedSettings) ? payload.savedSettings : null)
        setError(null)
        return payload.entries
      } catch (failure) {
        if (!signal.aborted && mounted.current && request.current?.signal === signal) setError(String(failure?.message ?? failure))
      } finally {
        if (!signal.aborted && mounted.current && request.current?.signal === signal) setLoading(false)
      }
    }, [sessionId])
    React.useEffect(() => {
      if (!open || !enabled || !available) {
        if (!applying.current) { request.current?.abort(); request.current = null }
        setLoading(false)
        return
      }
      // An in-flight apply owns the shared catalog request and reloads it on completion.
      if (applying.current) return
      const controller = new AbortController()
      request.current = controller
      void load(controller.signal)
      return () => { controller.abort(); if (request.current === controller) request.current = null }
    }, [open, enabled, available, load])
    const choices = drafts
    const choiceFor = entry => choices[entry.id] ?? entry.temporary ?? 'inherit'
    // Session writes also require the saved configuration to keep capability
    // management and context on; a frozen managed session cannot be edited
    // while the current settings have them off.
    const savedBlocks = savedSettings !== null && (savedSettings.enabled === false || savedSettings.contextEnabled === false)
    const writesBlocked = management === 'paused' || management === 'off' || savedBlocks
    const sourceKey = entry => entry.source?.kind === 'mcp' ? 'mcp:' + (entry.source.server ?? '')
      : entry.source?.kind === 'skill' ? 'skill:' + (entry.source.bucket ?? '')
        : entry.source?.kind ?? 'unknown'
    const sourceLabel = entry => entry.source?.kind === 'mcp' ? `MCP · ${entry.source.server ?? ''}`
      : entry.source?.kind === 'skill' ? `Skill · ${entry.source.bucket
        ? t(`capabilities.source.${entry.source.bucket}`) : t('capabilities.source.unknown')}`
        : t(`capabilities.source.${entry.source?.kind === 'host' ? 'host' : 'unknown'}`)
    const category = entry => entry.category === 'skill' ? 'skills'
      : ['server', 'resource'].includes(entry.category) ? 'mcp'
        : entry.source?.kind === 'mcp' ? 'mcp_tools' : 'tools'
    const type = entry => entry.category === 'server' ? 'server'
      : entry.source?.kind === 'mcp' ? 'resource'
        : entry.category === 'skill' ? 'skill'
          : entry.category === 'resource' ? 'resource'
            : entry.category === 'tool' ? 'tool' : 'other'
    const displayedSource = entry => entry.source?.kind === 'mcp' ? entry.source.server ?? sourceLabel(entry) : sourceLabel(entry)
    const effectiveAvailability = entry => entry.effective === 'pending' ? 'pending'
      : entry.enclosingClosure || entry.effective === 'closed' ? 'closed'
        : entry.effectiveDimensions?.availability
          ?? (['full', 'on-demand', 'host', 'enabled'].includes(entry.effective) ? 'enabled' : 'unknown')
    const effectiveContext = entry => entry.effective === 'pending' ? 'pending'
      : effectiveAvailability(entry) === 'closed' ? 'closed'
        : entry.effectiveDimensions?.disclosure
          ?? (['full', 'on-demand', 'host'].includes(entry.effective) ? entry.effective : 'unknown')
    const sources = [...new Set(catalog.filter(entry => kind === 'all' || category(entry) === kind).map(sourceKey))].sort()
    const setCompatibleKind = next => {
      setKind(next)
      if (sourceFilter !== 'all' && !catalog.some(entry => (next === 'all' || category(entry) === next)
        && sourceKey(entry) === sourceFilter)) setSourceFilter('all')
    }
    const setCompatibleSource = next => {
      setSourceFilter(next)
      if (next !== 'all' && !catalog.some(entry => (kind === 'all' || category(entry) === kind)
        && sourceKey(entry) === next)) setKind('all')
    }
    const filtered = catalog.filter(entry => {
      const text = [entry.name, entry.id, entry.description, entry.source?.server, entry.source?.bucket].filter(Boolean).join(' ').toLocaleLowerCase()
      return (kind === 'all' || category(entry) === kind)
        && (sourceFilter === 'all' || sourceKey(entry) === sourceFilter)
        && (stateFilter === 'all' || (stateFilter === 'changed' ? Object.hasOwn(choices, entry.id) : entry.effective === stateFilter))
        && text.includes(query.trim().toLocaleLowerCase())
    }).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id))
    const groups = ['tools', 'skills', 'mcp', 'mcp_tools']
    const defaultOrder = groups.flatMap(group => filtered.filter(entry => category(entry) === group))
    const matches = sortCapabilityEntries(defaultOrder, sort, (entry, column) => column === 'name' ? entry.name ?? entry.id
      : column === 'type' ? t(`capabilities.type.${type(entry)}`)
        : column === 'source' ? displayedSource(entry)
          : column === 'availability' ? capabilityChoiceLabel(t, effectiveAvailability(entry))
            : capabilityChoiceLabel(t, effectiveContext(entry)))
    const selected = matches.find(entry => entry.id === selectedId)
      ?? ['tools', 'skills', 'mcp', 'mcp_tools'].map(group => matches.find(entry => category(entry) === group)).find(Boolean)
    const staged = Object.entries(choices).flatMap(([id, choice]) => typeof choice === 'object'
      ? Object.entries(choice).map(([dimension, selection]) => [id, selection, dimension]) : [[id, choice]])
    const pickedRows = picked.map(id => catalog.find(entry => entry.id === id)).filter(Boolean)
    const allMatchesPicked = matches.length > 0 && matches.every(entry => picked.includes(entry.id))
    const someMatchesPicked = matches.some(entry => picked.includes(entry.id))
    const togglePick = id => setPicked(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
    const toggleAllMatches = () => setPicked(current => allMatchesPicked
      ? current.filter(id => !matches.some(entry => entry.id === id))
      : [...new Set([...current, ...matches.map(entry => entry.id)])])
    // One staging rule for single and batch edits: an item keeps one temporary
    // patch, "inherit" removes the dimension and reselecting the stored choice
    // never dirties the draft.
    const stageDimension = (current, entry, dimension, choice) => {
      const next = { ...current }
      const patch = typeof next[entry.id] === 'object' && next[entry.id] !== null ? { ...next[entry.id] } : {}
      const original = storedDimension(entry, dimension) ?? 'inherit'
      const selectedChoice = patch[dimension] ?? original
      if (choice !== selectedChoice) {
        if (choice === original) delete patch[dimension]
        else patch[dimension] = choice
      }
      if (Object.keys(patch).length) next[entry.id] = patch; else delete next[entry.id]
      return next
    }
    const chooseDimension = (id, dimension, choice) => {
      const entry = catalog.find(item => item.id === id)
      if (entry) setDrafts(current => stageDimension(current, entry, dimension, choice))
    }
    const choose = (id, next) => {
      const entry = catalog.find(item => item.id === id)
      if (!entry) return
      const original = entry.temporary ?? 'inherit'
      if (next === (choices[id] ?? original)) return
      setDrafts(current => {
        const nextChoices = { ...current }
        if (next === original) delete nextChoices[id]
        else nextChoices[id] = next
        return nextChoices
      })
    }
    const stageBatch = (ids, selections) => setDrafts(current => ids.reduce((draft, id) => {
      const entry = catalog.find(item => item.id === id)
      if (!entry) return draft
      return ['availability', 'disclosure'].reduce((next, dimension) =>
        selections[dimension] === undefined || selections[dimension] === 'keep'
          ? next : stageDimension(next, entry, dimension, selections[dimension]), draft)
    }, current))
    const hasInheritanceReset = staged.some(([, selection]) => selection === 'inherit')
    const apply = async targetScope => {
      if (applying.current || !enabled || !available || writesBlocked || staged.length === 0) return
      if (targetScope === 'global' && hasInheritanceReset) return
      const submitted = structuredClone(choices)
      applying.current = true
      setPending(true)
      setStatus(null)
      const controller = new AbortController()
      request.current?.abort()
      request.current = controller
      // One owner releases the shared request slot and the pending state on every exit path, so a
      // closed, superseded or failed apply cannot strand the workbench in "applying".
      const finish = () => {
        if (request.current === controller) request.current = null
        applying.current = false
        if (mounted.current) setPending(false)
      }
      try {
        let completed = 0
        let pendingCount = 0
        let failure = null
        let savedOnly = null
        for (const [id, selection, dimension] of staged) {
          if (controller.signal.aborted) break
          try {
            const result = await commands.run(sessionId, `set ${targetScope} ${encodeURIComponent(id)} ${dimension ? dimension + ' ' : ''}${selection}`, controller.signal)
            const receipt = readCapabilityCommandReceipt(result.text)
            if (!receipt || receipt.sessionId !== sessionId || !['recorded', 'pending'].includes(receipt.state)) {
              throw new Error(receipt ? capabilityCommandText(t, result.text) : t('capabilities.quick.unknownReceipt'))
            }
            if (receipt?.state === 'pending') pendingCount += 1
            completed += 1
          } catch (cause) {
            failure = String(cause?.message ?? cause)
            savedOnly = readCapabilityCommandReceipt(failure)?.state === 'saved-only'
              ? readCapabilityCommandReceipt(failure) : null
            break
          }
        }
        if (request.current !== controller || controller.signal.aborted || !mounted.current) return
        const refreshed = await load(controller.signal)
        if (request.current !== controller || controller.signal.aborted || !mounted.current) return
        const confirmed = refreshed ? staged.slice(0, completed).filter(([id, selection, dimension]) => {
          const entry = refreshed.find(item => item.id === id)
          if (dimension) return entry && (targetScope === 'session'
            ? (entry.temporaryRule?.[dimension] ?? 'inherit') === selection
            : (entry.savedRule?.[dimension] ?? 'automatic') === selection && entry.temporaryRule?.[dimension] === undefined)
          return entry && (targetScope === 'session' ? entry.temporary === selection
            : entry.saved === selection && entry.temporary === 'inherit')
        }) : []
        setDrafts(current => {
          const nextChoices = { ...current }
          for (const [id, selection, dimension] of confirmed) {
            if (savedOnly && id === staged[completed]?.[0] && dimension === staged[completed]?.[2]) continue
            if (dimension) {
              if (nextChoices[id]?.[dimension] !== submitted[id]?.[dimension]) continue
              const patch = { ...nextChoices[id] }; delete patch[dimension]
              if (Object.keys(patch).length) nextChoices[id] = patch; else delete nextChoices[id]
            } else if (nextChoices[id] === submitted[id]) delete nextChoices[id]
          }
          return nextChoices
        })
        if (savedOnly) setStatus({ key: 'capabilities.quick.savedOnly', params: { count: completed, error: savedOnly.error ?? '' } })
        else if (failure || !refreshed || confirmed.length < completed) setStatus({ key: 'capabilities.quick.partial',
          params: { count: confirmed.length, error: failure ?? t('capabilities.quick.confirmationUnavailable') } })
        else setStatus({ key: pendingCount ? 'capabilities.quick.pendingApplied' : 'capabilities.quick.applied', params: { count: completed } })
      } finally {
        finish()
      }
    }
    const discard = () => { setDrafts(emptyDrafts()); setStatus(null) }
    const close = () => {
      // A confirmed apply keeps its own lifecycle: refusing the close keeps an accidental
      // Escape or backdrop click from aborting host commands the user already submitted.
      if (applying.current) return
      request.current?.abort()
      request.current = null
      applying.current = false
      setPending(false)
      setDrafts(emptyDrafts())
      setStatus(null)
      onClose()
    }
    const filter = (label, value, onChange, options, disabled = false) => h('div', { className: 'ptcPlusCapabilityFilter' },
      h('span', null, label), h(Select, { label, value, onChange, disabled,
        options: options.map(([key, text]) => ({ value: key, label: text })) }))
    const ruleLabel = (rule, empty) => capabilityRuleLabel(t, rule, empty)
    const statusLabel = value => value && typeof value === 'object' ? ruleLabel(value) : capabilityChoiceLabel(t, value)
    // The stored temporary value for one dimension, including the legacy scalar
    // form where a single selection covered both dimensions.
    const storedDimension = (entry, dimension) => {
      const rule = entry.temporaryRule !== null && typeof entry.temporaryRule === 'object' && !Array.isArray(entry.temporaryRule)
        ? entry.temporaryRule : undefined
      const override = rule?.[dimension]
      if (override !== undefined) return override
      if (entry.temporary === 'automatic') return 'automatic'
      if (typeof entry.temporary === 'string' && !['inherit', 'automatic', 'unknown', 'pending'].includes(entry.temporary)) {
        return dimension === 'availability' ? (entry.temporary === 'closed' ? 'closed' : 'enabled')
          : (CAPABILITY_DISCLOSURES.includes(entry.temporary) ? entry.temporary : undefined)
      }
      return undefined
    }
    // The value a dimension falls back to when this session keeps no temporary
    // change; the frozen plan already resolved the saved layers.
    const frozenDimension = (entry, dimension) => {
      const source = entry.sourceDimensions?.[dimension]
      if (typeof source === 'string') return source
      const effective = entry.effectiveDimensions?.[dimension]
      if (typeof effective === 'string' && storedDimension(entry, dimension) === undefined) return effective
      if (dimension === 'availability') return entry.effective === 'closed' ? 'closed'
        : ['full', 'on-demand', 'host', 'enabled'].includes(entry.effective) ? 'enabled' : undefined
      return ['full', 'on-demand', 'host'].includes(entry.effective) ? entry.effective : undefined
    }
    const stateText = value => value === undefined ? t('capabilities.quick.unknown') : statusLabel(value)
    const dimensionCurrent = (entry, dimension) => choices[entry.id]?.[dimension] ?? storedDimension(entry, dimension) ?? 'inherit'
    const dimensionImpact = (entry, dimension) => {
      const draft = choices[entry.id]?.[dimension]
      const choice = draft ?? storedDimension(entry, dimension) ?? 'inherit'
      const stagedChange = draft !== undefined
      if (choice === 'inherit') return { state: frozenDimension(entry, dimension), origin: 'capabilities.quick.originPlan', staged: stagedChange }
      if (choice === 'automatic') return { upper: true, staged: stagedChange }
      return { state: choice, origin: 'capabilities.quick.originSession', staged: stagedChange }
    }
    const impactLine = impact => impact.upper
      ? t(impact.staged ? 'capabilities.quick.impactUpperPending' : 'capabilities.quick.impactUpper')
      : t(impact.staged ? 'capabilities.quick.impactPending' : 'capabilities.quick.impact',
        { state: stateText(impact.state), source: t(impact.origin) })
    const dimensionOptions = (entry, dimension) => {
      const restore = stateText(frozenDimension(entry, dimension))
      const inherit = storedDimension(entry, dimension) === undefined
        ? t('capabilities.quick.noChange', { state: restore })
        : t('capabilities.quick.undoTemp', { state: restore })
      // "Let the level above decide" only differs from "no change" while the
      // session's frozen source still carries an explicit rule for the dimension.
      const sourceDimension = entry.sourceRule?.[dimension]
      const distinctRule = sourceDimension !== undefined && sourceDimension !== 'automatic'
      return ['inherit', ...(distinctRule || dimensionCurrent(entry, dimension) === 'automatic' ? ['automatic'] : []),
        ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)]
        .map(choice => ({ value: choice, label: choice === 'inherit' ? inherit
          : choice === 'automatic' ? t('capabilities.quick.upperRule')
            : t(choice === 'enabled' ? 'capabilities.action.enable' : choice === 'closed' ? 'capabilities.action.close' : `capabilities.${choice}`) }))
    }
    const legacyFrozenState = entry => {
      const stored = typeof entry.temporary === 'string' && !['inherit', 'automatic', 'unknown', 'pending'].includes(entry.temporary)
      if (stored) return ['full', 'on-demand', 'closed'].includes(entry.sessionSourceSelection) ? entry.sessionSourceSelection : undefined
      return ['full', 'on-demand', 'closed', 'host'].includes(entry.effective) ? entry.effective : undefined
    }
    const choiceCurrent = entry => choices[entry.id] ?? entry.temporary ?? 'inherit'
    const choiceImpact = entry => {
      const draft = choices[entry.id]
      const choice = draft ?? entry.temporary ?? 'inherit'
      const stagedChange = draft !== undefined
      if (choice === 'inherit') return { state: legacyFrozenState(entry), origin: 'capabilities.quick.originPlan', staged: stagedChange }
      if (choice === 'automatic') return { upper: true, staged: stagedChange }
      return { state: choice, origin: 'capabilities.quick.originSession', staged: stagedChange }
    }
    const choiceOptions = selected ? [
      'inherit', 'automatic',
      ...(selected.category === 'server' ? [] : ['full', 'on-demand']), 'closed',
    ].map(choice => ({ value: choice, label: choice === 'inherit'
      ? t(selected.temporary !== undefined && selected.temporary !== 'inherit' ? 'capabilities.quick.undoChange' : 'capabilities.quick.keepUnchanged')
      : choice === 'automatic' ? t('capabilities.quick.upperRule')
        : t(`capabilities.${choice}`) })) : []
    const dimensionFacts = dimensions => ['availability', 'disclosure'].map(dimension =>
      `${t(`capabilities.policy.${dimension}`)}: ${statusLabel(dimensions[dimension])} (${dimensions[`${dimension}Source`] ?? t('capabilities.quick.unknown')})`).join(' · ')
    // A dimension whose effective value comes from the session-only temporary
    // choice is marked beside the frozen inheritance it replaces.
    const temporaryDimension = (entry, dimension) => {
      const rule = entry.temporaryRule !== null && typeof entry.temporaryRule === 'object' && !Array.isArray(entry.temporaryRule)
        ? entry.temporaryRule : undefined
      const override = rule?.[dimension]
      if (override !== undefined && override !== 'automatic') return override
      if (typeof entry.temporary === 'string' && !['inherit', 'automatic'].includes(entry.temporary)) {
        return dimension === 'availability' ? (entry.temporary === 'closed' ? 'closed' : 'enabled') : entry.temporary
      }
      return undefined
    }
    const dimensionCell = (entry, dimension, value) => temporaryDimension(entry, dimension) === value
      ? t('capabilities.quick.temporaryState', { state: statusLabel(value) }) : statusLabel(value)
    const openEditor = (entry, dimension = 'availability') => { setSelectedId(entry.id); setPane('detail'); setFocusDimension(dimension) }
    const renderRow = entry => h('div', { key: entry.id, role: 'row',
      className: 'ptcPlusSessionCapabilityRow ptcPlusCapabilityItem', 'data-capability-id': entry.id, 'data-selected': selected?.id === entry.id,
      onClick: () => openEditor(entry) },
      h('div', { role: 'cell', className: 'ptcPlusCapabilityIdentity' },
        h('input', { type: 'checkbox', className: 'ptcPlusPick', checked: picked.includes(entry.id), disabled: writesBlocked,
          'aria-label': t('capabilities.selectForBatch', { name: entry.name ?? entry.id }),
          onClick: event => event.stopPropagation(), onChange: () => togglePick(entry.id) }),
        h('div', { className: 'ptcPlusCapabilityIdentityText' },
          h('button', { type: 'button', className: 'ptcPlusSessionCapabilityName ptcPlusCapabilityName',
            'aria-current': selected?.id === entry.id ? 'true' : undefined,
            onClick: event => { event.stopPropagation(); openEditor(entry) } }, entry.name ?? entry.id),
          entry.name && entry.name !== entry.id ? h('code', null, entry.id) : null)),
      h('span', { role: 'cell', className: 'ptcPlusCapabilityBadge', 'data-kind': type(entry) }, t(`capabilities.type.${type(entry)}`)),
      h('span', { role: 'cell', className: 'ptcPlusCapabilitySource' }, displayedSource(entry)),
      h('div', { role: 'cell', className: 'ptcPlusCapabilityAvailability', 'data-state': effectiveAvailability(entry) },
        h('button', { type: 'button', className: 'ptcPlusCapabilityContext',
          'aria-label': t('capabilities.policy.availabilityFor', { name: entry.id }),
          title: t('capabilities.quick.effective'),
          onClick: event => { event.stopPropagation(); openEditor(entry, 'availability') } }, dimensionCell(entry, 'availability', effectiveAvailability(entry)))),
      h('div', { role: 'cell', className: 'ptcPlusCapabilityContextCell' },
        h('button', { type: 'button', className: 'ptcPlusCapabilityContext',
          'aria-label': t('capabilities.editContextFor', { name: entry.id }),
          title: t('capabilities.quick.effective'),
          onClick: event => { event.stopPropagation(); openEditor(entry, 'disclosure') } }, dimensionCell(entry, 'disclosure', effectiveContext(entry)))),
      h('span', { role: 'cell', className: 'ptcPlusSessionCapabilityPending', 'data-changed': Object.hasOwn(choices, entry.id),
        'data-label': t('capabilities.quick.changed') },
        Object.hasOwn(choices, entry.id) ? statusLabel(choices[entry.id]) : '—'))
    return h(Modal, { open, onClose: close, title: t('capabilities.quick.modalTitle'),
      closeLabel: t('settings.close'), headless: true, className: 'ptcPlusSessionCapabilityModal' },
    h('div', { className: 'ptcPlusSessionCapabilityHead' },
      h('div', null, h('h2', null, t('capabilities.quick.modalTitle')),
        h('p', null, t('capabilities.quick.sessionIdentity', { session: sessionId }))),
      h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('settings.close'), disabled: pending, onClick: close }, '×')),
    h('div', { className: 'ptcPlusSessionCapabilityToolbar' },
      h('label', { className: 'ptcPlusSearch' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true },
          h('circle', { cx: 10, cy: 10, r: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
          h('path', { d: 'm15 15 6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 2 })),
        h('input', { type: 'search', value: query, 'aria-label': t('capabilities.search'),
          placeholder: t('capabilities.search'), onChange: event => setQuery(event.target.value) })),
      filter(t('capabilities.quick.kind'), kind, setCompatibleKind,
        ['all', 'tools', 'skills', 'mcp', 'mcp_tools'].map(key => [key, t(`capabilities.quick.${key}`)])),
      filter(t('capabilities.sourceFilter'), sourceFilter, setCompatibleSource,
        [['all', t('capabilities.allSources')], ...sources.map(key => [key,
          sourceLabel(catalog.find(entry => sourceKey(entry) === key))])]),
      filter(t('capabilities.quick.state'), stateFilter, setStateFilter,
        [['all', t('capabilities.quick.allStates')], ['changed', t('capabilities.quick.changed')],
          ...['full', 'on-demand', 'closed', 'pending'].map(key => [key, statusLabel(key)])])),
    // A blocked workbench states why writes are off and how to restore them; the banner styling
    // keeps that condition from reading as an incidental list message.
    writesBlocked ? h('p', { className: 'ptcPlusCapabilityNotice ptcPlusCapabilityBlocked', role: 'status' },
      h('svg', { className: 'ptcPlusCapabilityBlockedIcon', viewBox: '0 0 16 16', width: 14, height: 14,
        'aria-hidden': true, fill: 'none' },
        h('path', { d: 'M8 2.3 14.7 13.5H1.3L8 2.3Z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
        h('path', { d: 'M8 6.4v3M8 11.2v.7', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })),
      t(management === 'paused' ? 'capabilities.quick.sessionPaused'
        : management === 'off' ? 'capabilities.quick.sessionManagementOff'
          : savedSettings?.contextEnabled === false ? 'capabilities.quick.savedPaused'
            : 'capabilities.quick.savedManagementOff')) : null,
    h('div', { className: 'ptcPlusSessionCapabilityWorkspace', 'data-pane': pane },
      h('div', { className: 'ptcPlusSessionCapabilityList', role: 'table', 'aria-label': t('capabilities.quick.members'), ref: list },
        h('div', { className: 'ptcPlusSessionCapabilityColumns ptcPlusCapabilityColumns', role: 'row' },
          ...CAPABILITY_SORT_COLUMNS.map(column => h('span', { key: column.key, role: 'columnheader',
            'aria-sort': capabilitySortDirection(sort, column.key),
            ...(column.key === 'name' ? { 'aria-label': t('capabilities.member'), className: 'ptcPlusCapabilityPickHead' } : {}) },
            ...(column.key === 'name' ? [h('input', { type: 'checkbox', className: 'ptcPlusPick', checked: allMatchesPicked,
              ref: node => { if (node) node.indeterminate = someMatchesPicked && !allMatchesPicked },
              disabled: writesBlocked || matches.length === 0, 'aria-label': t('capabilities.selectAllVisible'),
              onChange: toggleAllMatches })] : []),
            h('button', { type: 'button', className: 'ptcPlusCapabilitySort', title: t('capabilities.sortCycle'),
              onClick: () => setSort(current => cycleCapabilitySort(current, column.key)) },
            t(`capabilities.${column.label}`), h('span', { 'aria-hidden': true },
              capabilitySortDirection(sort, column.key) === 'ascending' ? '↑' : capabilitySortDirection(sort, column.key) === 'descending' ? '↓' : '↕')))),
          h('span', { role: 'columnheader' }, t('capabilities.quick.changed'))),
        loading ? h('p', { role: 'status' }, t('state.syncing')) : null,
        error ? h('p', { role: 'alert' }, t('capabilities.quick.catalogError', { error })) : null,
        !loading && !error && matches.length === 0 ? h('p', null, t('capabilities.noMatches')) : null,
        ...(sort ? [h('div', { key: 'sorted', role: 'rowgroup' }, ...matches.map(renderRow))]
          : groups.filter(group => matches.some(entry => category(entry) === group))
          .map(group => h('section', { key: group, className: 'ptcPlusSessionCapabilityGroup' },
            h('h3', null, t(`capabilities.quick.${group}`)),
            h('div', { role: 'rowgroup' }, ...matches.filter(entry => category(entry) === group).map(renderRow)))))),
      h('aside', { className: 'ptcPlusSessionCapabilityDetail', 'aria-label': t('capabilities.details'), ref: detail },
        h('button', { type: 'button', className: 'ptcPlusSessionCapabilityBack', onClick: () => { setPane('list'); setFocusDimension('list') } },
          t('capabilities.quick.backToList')),
        selected ? h(React.Fragment, null,
          h('h3', null, selected.name ?? selected.id), h('code', null, selected.id),
          selected.description ? h('p', null, selected.description) : null,
          h('dl', null,
            h('dt', null, t('capabilities.sourceFilter')), h('dd', null, sourceLabel(selected)),
            h('dt', null, t('capabilities.quick.globalSaved')), h('dd', null, selected.savedRule ? ruleLabel(selected.savedRule) : statusLabel(selected.saved)),
            h('dt', null, t('capabilities.quick.sessionSource')), h('dd', null, selected.sourceRule ? ruleLabel(selected.sourceRule) : statusLabel(selected.sessionSourceSelection ?? 'unknown')),
            h('dt', null, t('capabilities.quick.temporary')), h('dd', null, selected.temporaryRule ? ruleLabel(selected.temporaryRule, 'capabilities.quick.noOverride') : statusLabel(selected.temporary)),
            h('dt', null, t('capabilities.quick.effective')), h('dd', null, statusLabel(selected.effective)),
            selected.sourceDimensions ? h(React.Fragment, null, h('dt', null, t('capabilities.policy.frozenSource')), h('dd', null, dimensionFacts(selected.sourceDimensions))) : null,
            selected.effectiveDimensions ? h(React.Fragment, null, h('dt', null, t('capabilities.policy.effectiveDimensions')), h('dd', null, dimensionFacts(selected.effectiveDimensions))) : null),
          selected.source?.kind === 'mcp' && selected.category !== 'server'
            ? (() => {
              const server = catalog.find(entry => entry.category === 'server' && entry.source?.server === selected.source.server)
              if (!server) return null
              const proposed = choiceFor(server)
              const availability = server.savedRule ? choices[server.id]?.availability ?? server.temporaryRule?.availability ?? 'inherit' : proposed
              const sourceAvailability = server.sourceRule !== undefined ? server.sourceRule.availability : server.sessionSourceSelection
              const pendingClose = server.managementEnabled !== false && (availability === 'inherit' ? sourceAvailability : availability) === 'closed'
              const currentlyClosed = server.enclosingClosure ?? server.effective === 'closed'
              const key = currentlyClosed ? 'capabilities.quick.disabledByServer'
                : pendingClose ? 'capabilities.quick.pendingServerClose' : null
              return key ? h('p', { className: 'ptcPlusCapabilityNotice' }, t(key, { server: selected.source.server })) : null
            })() : null,
          selected.category === 'server' ? h('div', { className: 'ptcPlusSessionCapabilityChildren' },
            h('h4', null, t('capabilities.quick.serverTools')),
            h('ul', null, ...catalog.filter(entry => entry.id !== selected.id
              && entry.source?.kind === 'mcp' && entry.source.server === selected.source?.server)
              .map(entry => h('li', { key: entry.id }, entry.name ?? entry.id)))) : null,
          selected.savedRule ? h(React.Fragment, null, ...['availability', 'disclosure'].map(dimension => h(React.Fragment, { key: dimension },
            h('div', { className: 'ptcPlusCapabilityFilter', 'data-capability-dimension': dimension },
              h('span', null, t(`capabilities.policy.${dimension}`)),
              h(Select, { label: t(`capabilities.policy.${dimension}`), disabled: !enabled || !available || pending || writesBlocked,
                value: dimensionCurrent(selected, dimension),
                onChange: next => chooseDimension(selected.id, dimension, next),
                options: dimensionOptions(selected, dimension) })),
            h('p', { className: 'ptcPlusDetail ptcPlusCapabilityImpact', 'data-impact-dimension': dimension },
              impactLine(dimensionImpact(selected, dimension))))))
            : h(React.Fragment, null,
              h('div', { className: 'ptcPlusCapabilityFilter' },
                h('span', null, t('capabilities.quick.choice')),
                h(Select, { label: t('capabilities.quick.choice'), value: choiceCurrent(selected),
                  disabled: !enabled || !available || pending || writesBlocked, options: choiceOptions,
                  onChange: next => choose(selected.id, next) })),
              h('p', { className: 'ptcPlusDetail ptcPlusCapabilityImpact', 'data-impact-dimension': 'selection' },
                impactLine(choiceImpact(selected)))),
          (typeof choices[selected.id] === 'string' ? choices[selected.id] === 'inherit'
            : Object.values(choices[selected.id] ?? {}).includes('inherit')) ? h('p', { className: 'ptcPlusDetail' },
            t('capabilities.quick.inheritSessionOnly')) : null) : h('p', null, t('capabilities.noMatches')))),
    batchOpen ? h(Modal, { open: true, onClose: () => setBatchOpen(false), title: t('capabilities.batchSettings'),
      closeLabel: t('capabilities.batch.cancel'), headless: true, className: 'ptcPlusCapabilityBatchModal' },
      h('div', { className: 'ptcPlusCapabilityBatchHead' }, h('h2', null, t('capabilities.batchSettings')),
        h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('capabilities.batch.cancel'),
          onClick: () => setBatchOpen(false) }, '\u00d7')),
      h('div', { className: 'ptcPlusCapabilityBatchBody' },
        h('p', { className: 'ptcPlusDetail', role: 'status' }, t('capabilities.batch.selected', { count: pickedRows.length })),
        h('ul', { className: 'ptcPlusCapabilityBatchTargets', 'aria-label': t('capabilities.batch.targetList') },
          ...pickedRows.map(entry => h('li', { key: entry.id }, h('span', null, entry.name ?? entry.id), h('code', null, entry.id)))),
        h('div', { className: 'ptcPlusCapabilityBatchFields' }, ...['availability', 'disclosure'].map(dimension =>
          h('div', { key: dimension, className: 'ptcPlusCapabilityFilter' }, h('span', null, t(`capabilities.policy.${dimension}`)),
            h(Select, { value: batchChoices[dimension], label: t(`capabilities.batch.${dimension}`),
              onChange: choice => setBatchChoices(current => ({ ...current, [dimension]: choice })),
              options: ['keep', 'inherit', ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)]
                .map(choice => ({ value: choice, label: choice === 'keep' ? t('capabilities.batch.keep')
                  : choice === 'inherit' ? t('capabilities.batch.sessionInherit')
                    : choice === 'enabled' ? t('capabilities.action.enable')
                      : choice === 'closed' ? t('capabilities.action.close') : t(`capabilities.${choice}`) })) })))),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.batch.sessionStage'))),
      h('div', { className: 'ptcPlusCapabilityBatchFooter' },
        h('button', { type: 'button', className: 'ptcPlusButton', onClick: () => setBatchOpen(false) }, t('capabilities.batch.cancel')),
        h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary',
          disabled: pickedRows.length === 0 || !['availability', 'disclosure'].some(dimension => batchChoices[dimension] !== 'keep'),
          onClick: () => { stageBatch(pickedRows.map(entry => entry.id), batchChoices); setBatchOpen(false) } },
          t('capabilities.batch.stage', { count: pickedRows.length })))) : null,
    h('div', { className: 'ptcPlusSessionCapabilityFooter' },
      h('span', { role: 'status' }, pending ? t('capabilities.quick.applying') : status ? t(status.key, status.params)
        : t('capabilities.quick.changes', { count: staged.length })),
      h('button', { type: 'button', className: 'ptcPlusButton', disabled: pending || staged.length === 0, onClick: discard },
        t('capabilities.quick.discard')),
      // Session-scoped temporary application stays the footer's primary action; saving global
      // defaults is an explicit secondary choice, so no default-looking control changes global state.
      h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary', title: t('capabilities.quick.sessionHint'),
        disabled: pending || !enabled || !available || writesBlocked || staged.length === 0, onClick: () => void apply('session') },
        t('capabilities.quick.applySession')),
      h('button', { type: 'button', className: 'ptcPlusButton',
        title: t(hasInheritanceReset ? 'capabilities.quick.inheritSessionOnly' : 'capabilities.quick.globalHint'),
        disabled: pending || !enabled || !available || writesBlocked || staged.length === 0 || hasInheritanceReset,
        onClick: () => void apply('global') },
        t('capabilities.quick.applyGlobal')),
      h('button', { type: 'button', className: 'ptcPlusButton', 'aria-haspopup': 'dialog',
        'aria-label': t('capabilities.batchSettings'),
        disabled: pending || writesBlocked || picked.length === 0,
        onClick: () => { setBatchChoices({ availability: 'keep', disclosure: 'keep' }); setBatchOpen(true) } },
        t('capabilities.batchSettings'),
        picked.length ? h('span', { className: 'ptcPlusCapabilityBatchCount', 'aria-hidden': true,
          title: t('capabilities.selectionCount', { count: picked.length }) },
          String(picked.length)) : null)))
  }
}
