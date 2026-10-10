import { capabilityPolicyForConfig, capabilityRule, changeCapabilityRule, effectiveCapabilitySettings, CAPABILITY_DISCLOSURES, CAPABILITY_INVENTORY_CATEGORIES } from '../internal/capability-policy.js'
import { CONFIG_DEFAULTS, CONFIG_FIELDS } from '../internal/config-spec.js'
import { CAPABILITY_CONFIGURATION_KEYS, capabilityProfileConfiguration, validateCapabilityProfiles } from '../internal/runtime-config.js'
import { readCapabilityCommandReceipt } from '../internal/capability-command-receipt.js'

export function capabilityCommandText(t, text) {
  if (text?.key) return t(text.key, text.params)
  const receipt = readCapabilityCommandReceipt(text)
  return receipt ? t(`capabilities.receipt.${receipt.state}`, { session: receipt.sessionId, error: receipt.error ?? '' }) : text
}

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

export function createCapabilitySettingsViews(React, { SearchIcon, Select }) {
  const h = React.createElement
  const field = key => CONFIG_FIELDS.find(item => item.key === key)
  const responsibilities = ['rules', 'statistics', 'recovery', 'preview']
  const choicesFor = (configuration, plan) => {
    const historical = plan && ['ptc-capability-plan/v1', 'ptc-capability-plan/v3'].includes(plan.schema)
      && configuration && configuration.capabilityPolicy === undefined
    let statistics
    try { statistics = JSON.parse(configuration?.capabilityStatistics ?? 'null') } catch { statistics = null }
    return { historical, contextEnabled: plan ? plan.contextEnabled : configuration?.capabilityContextEnabled,
      enabled: configuration?.capabilityManagementEnabled ?? plan?.enabled,
      statistics,
      recoveryEnabled: configuration?.capabilityRecoveryEnabled ?? (historical ? plan.enabled : undefined),
      previewEnabled: configuration?.modelPreviewEnabled ?? (historical ? plan.enabled : undefined) }
  }
  const flagsFor = settings => ({ rules: settings.enabled, statistics: settings.statistics?.enabled,
    recovery: settings.recoveryEnabled, preview: settings.previewEnabled })
  const choiceState = (retained, applied, key) => typeof retained[key] !== 'boolean' ? 'unknown'
    : retained[key] ? typeof applied[key] !== 'boolean' ? 'unknown' : applied[key] === false ? 'paused' : 'selected'
      : key === 'rules' ? 'host' : 'unselected'

  function CombinationSummary({ value, configurationReady, plans, plansError, plansPending, plansStale, selectedSessionId,
    feedback, onNavigate, onReload, renderRefresh, renderPlans, t, id }) {
    const saved = choicesFor(configurationReady ? value : undefined)
    const retained = flagsFor(saved)
    const applied = flagsFor(effectiveCapabilitySettings(saved))
    const selected = responsibilities.filter(key => retained[key] === true)
    const effect = !configurationReady ? t('capabilities.combination.unknownSettings')
      : saved.contextEnabled === false ? t('capabilities.combination.pausedEffect')
        : selected.length === 0 ? t('capabilities.combination.hostEffect')
          : selected.length === 1 && selected[0] === 'rules' ? t('capabilities.combination.rulesOnly')
            : t('capabilities.combination.selectedEffect', { features: selected.map(key => t(`capabilities.combination.${key}`)).join(t('capabilities.combination.separator')) })
    const plan = selectedSessionId ? plans?.find(item => item.sessionId === selectedSessionId) : undefined
    const frozen = plan && choicesFor(plan.configuration, plan.effective)
    const frozenRetained = frozen && flagsFor(frozen)
    const frozenApplied = frozen && flagsFor(effectiveCapabilitySettings(frozen))
    if (frozenApplied) {
      frozenApplied.rules = plan.effective.enabled
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
          'aria-controls': `${id}-pane-${key === 'rules' ? 'manual' : key === 'statistics' ? 'statistics' : 'budgets'}`,
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
      h('h4', null, t('capabilities.policy.rules')), h('p', { className: 'ptcPlusDetail' }, t('capabilities.policy.precedence')),
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

  function CapabilityChoices({ value, catalog, catalogError, plans, plansError, disabled, onChange, onReload, t, selectedSessionId, onSessionSelect }) {
    const root = React.useRef(null)
    const [query, setQuery] = React.useState('')
    const [kind, setKind] = React.useState('all')
    const [source, setSource] = React.useState('all')
    const [strategy, setStrategy] = React.useState('all')
    const [availabilityRule, setAvailabilityRule] = React.useState('all')
    const [onlyCommon, setOnlyCommon] = React.useState(false)
    const [availability, setAvailability] = React.useState('all')
    const [sort, setSort] = React.useState('name')
    const [descending, setDescending] = React.useState(false)
    const [selected, setSelected] = React.useState(null)
    const [filtersOpen, setFiltersOpen] = React.useState(false)
    const [batchOpen, setBatchOpen] = React.useState(false)
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
    const order = (a, b) => {
      const primary = sort === 'common' ? Number(b.common) - Number(a.common)
        : sort === 'availabilityRule' ? compare(a.rule?.availability ?? 'automatic', b.rule?.availability ?? 'automatic')
        : sort === 'disclosureRule' ? compare(a.rule?.disclosure ?? 'automatic', b.rule?.disclosure ?? 'automatic')
        : compare((sort === 'id' ? a.id : a.name).toLowerCase(), (sort === 'id' ? b.id : b.name).toLowerCase())
      return (descending ? -1 : 1) * (primary || compare(a.id, b.id))
    }
    const groups = new Map()
    for (const entry of filtered) {
      const group = entry.source?.kind === 'mcp' && entry.source.server ? `mcp:${entry.source.server}`
        : entry.availability === 'unavailable' ? 'unavailable' : entry.kind
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(entry)
    }
    const groupOrder = ['tool', ...[...groups.keys()].filter(key => key.startsWith('mcp:')).sort(compare), 'skill', 'resource', 'other', 'unavailable']
    const visible = groupOrder.flatMap(group => (groups.get(group) ?? []).sort(order))
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
    const manualSelect = item => h('div', { className: 'ptcPlusCapabilityRuleFields' },
      h(Select, { value: item.rule.availability ?? 'automatic', disabled: disabled('capabilityPolicy'),
        label: t('capabilities.policy.availabilityFor', { name: item.id }),
        onChange: next => change('capabilityPolicy', changeCapabilityRule(policy, item.id, 'availability', next)),
        options: ['automatic', 'enabled', 'closed'].map(choice => ({ value: choice, label: t(choice === 'automatic' ? 'capabilities.policy.inheritRule' : choice === 'enabled' ? 'capabilities.quick.enabled' : `capabilities.${choice}`) })) }),
      h(Select, { value: item.rule.disclosure ?? 'automatic', disabled: disabled('capabilityPolicy'),
        label: t('capabilities.disclosureFor', { name: item.id }),
        onChange: next => setManual(item.id, next), options: ['automatic', ...CAPABILITY_DISCLOSURES]
          .map(choice => ({ value: choice, label: t(choice === 'automatic' ? 'capabilities.policy.inheritRule' : `capabilities.${choice}`) })) }))
    const common = item => h('label', { className: 'ptcPlusCapabilityCommon', title: t('capabilities.baselineFor', { name: item.id }) },
      h('input', { type: 'checkbox', disabled: disabled('capabilityBaseline'), checked: item.common,
        'aria-label': t('capabilities.baselineFor', { name: item.id }),
        onChange: event => change('capabilityBaseline', event.target.checked
          ? [...baseline.filter(id => id !== item.id), item.id] : baseline.filter(id => id !== item.id)) }),
      h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { d: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z' })))
    const state = item => item.availability === 'unknown' ? 'unknown' : item.availability === 'unavailable' ? 'unavailable'
      : value.capabilityContextEnabled === false || value.capabilityManagementEnabled !== true ? 'unapplied'
        : item.resolvedRule.availabilitySource.startsWith('mcp:') && item.resolvedRule.availability === 'closed' ? 'source-closed' : item.resolvedRule.availability
    const type = item => item.source?.kind === 'mcp' ? 'resource' : item.kind
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
        h('button', { type: 'button', className: 'ptcPlusButton', 'aria-expanded': filtersOpen,
          onClick: () => setFiltersOpen(current => !current) }, t('capabilities.filterAction')),
        h('button', { type: 'button', className: 'ptcPlusButton', 'aria-expanded': batchOpen,
          onClick: () => setBatchOpen(current => !current) }, t('capabilities.batchSettings'))),
      filtersOpen ? h('div', { className: 'ptcPlusCapabilityFilters' },
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
            ['all', 'available', 'unavailable', 'unknown'].map(key => [key, t(`capabilities.availability.${key}`)])),
          select(t('capabilities.sort'), sort, setSort, ['name', 'id', 'availabilityRule', 'disclosureRule', 'common'].map(key => [key, t(`capabilities.sort.${key}`)])),
          h('button', { type: 'button', className: 'ptcPlusCapabilityDirection', 'aria-label': t(descending ? 'capabilities.descending' : 'capabilities.ascending'),
            onClick: () => setDescending(current => !current) }, descending ? '↓' : '↑'))) : null,
      batchOpen ? h(PolicyRules, { value, catalog, disabled, onChange, t }) : null,
      activeFilters ? h('div', { className: 'ptcPlusActiveFilters' }, h('span', null, filterLabels.join(' · ')),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: clear }, t('capabilities.clear'))) : null,
      h('div', { className: 'ptcPlusCapabilityResultLine' }, h('span', { role: 'status' }, t('capabilities.results', { count: visible.length, total: entries.length })),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: onReload }, t('capabilities.reloadCatalog'))),
      catalogError ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.catalogUnavailable', { error: catalogError })) : null,
      entries.length === 0 ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.catalogEmpty'))
        : visible.length === 0 ? h('div', { className: 'ptcPlusCapabilityEmpty' }, h('p', null, t('capabilities.noMatches')),
          h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: clear }, t('capabilities.clear'))) :
          h('div', { className: 'ptcPlusCapabilityTable' },
            h('div', { className: 'ptcPlusCapabilityColumns', 'aria-hidden': true },
              ...['member', 'typesColumn', 'sourceColumn', 'enabledColumn', 'contextColumn', 'actionsColumn'].map(key => h('span', { key }, t(`capabilities.${key}`)))),
            h('div', { className: 'ptcPlusCapabilityList' }, ...visible.map(item => h('div', { key: item.id, className: 'ptcPlusCapabilityItem',
              'data-selected': entry?.id === item.id, 'data-availability': item.availability },
              h('div', { className: 'ptcPlusCapabilityIdentity' }, h('span', { className: 'ptcPlusCapabilityName' }, item.name), h('code', null, item.id)),
              h('span', { className: 'ptcPlusCapabilityBadge', 'data-kind': type(item) }, t(`capabilities.type.${type(item)}`)),
              h('span', { className: 'ptcPlusCapabilitySource' }, item.source?.kind === 'mcp' ? item.source.server ?? sourceLabel(item) : sourceLabel(item)),
              h('label', { className: 'ptcPlusCapabilityAvailability', 'data-state': state(item) },
                h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck',
                  checked: item.resolvedRule.availability === 'enabled',
                  disabled: disabled('capabilityPolicy') || state(item) === 'source-closed',
                  'aria-label': t('capabilities.policy.availabilityFor', { name: item.id }),
                  onChange: event => change('capabilityPolicy', changeCapabilityRule(policy, item.id, 'availability', event.target.checked ? 'enabled' : 'closed')) }),
                h('span', null, t(`capabilities.rowState.${state(item)}`))),
              h('button', { type: 'button', className: 'ptcPlusCapabilityContext', 'data-capability-edit-id': item.id,
                'aria-label': t('capabilities.editContextFor', { name: item.id }), 'aria-expanded': selected === item.id,
                onClick: () => setSelected(selected === item.id ? null : item.id) },
                h('span', null, t(`capabilities.${item.resolvedRule.disclosure}`)),
                h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
                  h('path', { d: 'm15 5 4 4M4 20l4-1L20 7l-4-4L4 15Z' }))),
              h('button', { type: 'button', className: 'ptcPlusCapabilityMore', 'aria-label': t('capabilities.moreFor', { name: item.id }),
                'aria-expanded': selected === item.id, onClick: () => setSelected(selected === item.id ? null : item.id) }, '…'))))),
      entry ? h('aside', { className: 'ptcPlusCapabilityDetail', 'aria-label': t('capabilities.details') },
        h('div', { className: 'ptcPlusTaskHead' }, h('h4', null, entry.name),
          h('button', { type: 'button', className: 'ptcPlusButton', onClick: closeEditor }, t('capabilities.closeDetails'))),
        h('code', null, entry.id), h('p', { className: 'ptcPlusDetail' }, t('capabilities.contextHelp')),
        manualSelect(entry), h('div', { className: 'ptcPlusCapabilityCommonChoice' }, common(entry), h('span', null, t('capabilities.commonBaseline'))),
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
        entry.source?.kind === 'mcp' && entry.mcpServer ? h('details', null,
          h('summary', { tabIndex: 0 }, t('capabilities.sourceRules')),
          h('p', { className: 'ptcPlusDetail' }, t('capabilities.serverHint')),
          ...['availability', 'disclosure'].map(dimension => select(t(`capabilities.policy.${dimension}`), policy.mcpServers[entry.mcpServer]?.[dimension] ?? 'automatic',
            next => change('capabilityPolicy', changeCapabilityRule(policy, `mcpServers.${entry.mcpServer}`, dimension, next)),
            ['automatic', ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)].map(key => [key,
              t(key === 'automatic' ? 'capabilities.policy.inheritRule' : key === 'enabled' ? 'capabilities.quick.enabled' : `capabilities.${key}`)]), disabled('capabilityPolicy')))) : null,
        entry.kind === 'skill' ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.skillDisclosure')) : null,
        entry.kind === 'skill' && entry.invocationConflict ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.invocation.varies')) : null,
        entry.kind === 'skill' && entry.invocation ? h('p', { className: 'ptcPlusDetail' },
          t(entry.invocation.modelInvocable ? entry.invocation.userInvocable ? 'capabilities.invocation.both'
            : 'capabilities.invocation.model' : 'capabilities.invocation.user', { name: entry.name })) : null,
        entry.description ? h('details', { className: 'ptcPlusCapabilityDescription', key: entry.id },
          h('summary', { tabIndex: 0 }, t('capabilities.viewDescription')), h('p', null, entry.description)) : null,
        entry.availability === 'unavailable' ? h('button', { type: 'button', className: 'ptcPlusCapabilityLink',
          disabled: disabled('capabilityBaseline') || disabled('capabilityPolicy'), onClick: () => {
            const next = { ...policy, items: { ...policy.items } }; delete next.items[entry.id]; change('capabilityPolicy', next)
            if (baseline.includes(entry.id)) change('capabilityBaseline', baseline.filter(id => id !== entry.id))
          } }, t('capabilities.removeSaved')) : null,
        value.capabilityContextEnabled !== false && value.capabilityManagementEnabled === true ? h('details', { className: 'ptcPlusCapabilitySessionDetail' },
          h('summary', { tabIndex: 0 }, t('capabilities.currentSession')),
          select(t('capabilities.sessionSelector'), sessionId ?? '', setSessionId, [['', t('capabilities.chooseSession')], ...(plans ?? []).map(item => [item.sessionId, item.sessionId])]),
          plansError ? h('p', { role: 'status' }, t('capabilities.unavailable', { error: plansError }))
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
    if (!allocation) return h('p', { className: 'ptcPlusCapabilityNotice' }, t(selectedSessionId ? 'capabilities.observationUnavailable' : 'capabilities.selectObservation'))
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
        button('capabilities.saveConfiguration', () => { setAction(action === 'save' ? null : 'save'); setStatus(null) }, unavailable,
          { ref: saveAction, className: 'ptcPlusButton ptcPlusConfigurationSave', 'aria-label': t('capabilities.saveConfiguration'), 'aria-expanded': action === 'save' }),
        h('div', { className: 'ptcPlusConfigurationLibraryActions' },
          button('capabilities.importConfigurations', () => fileInput.current.click(), unavailable),
          h('details', { className: 'ptcPlusConfigurationMenu' }, h('summary', { 'aria-label': t('capabilities.libraryMore') }, '···'),
            button('capabilities.exportConfigurations', () => exportProfiles('all'), !library.profiles.length),
            button('capabilities.copyFromSession', () => { setAction('copy'); setStatus(null) }, unavailable))),
        h('input', { ref: fileInput, type: 'file', accept: '.json,application/json', hidden: true, disabled: unavailable,
          onChange: importProfiles, 'aria-label': t('capabilities.importConfigurations') }),
        action === 'save' ? h('form', { className: 'ptcPlusConfigurationAction', onSubmit: event => {
          event.preventDefault(); if (!unavailable && name.trim()) void perform('save', () => save(current()))
        } }, input('capabilities.configurationName', name, setName),
          h('p', { className: 'ptcPlusDetail' }, t('capabilities.sameNameHint')),
          button('capabilities.confirmSave', undefined, unavailable || !name.trim(), { type: 'submit' })) : null,
        action === 'copy' ? h('div', { className: 'ptcPlusConfigurationAction' }, h('p', { className: 'ptcPlusDetail' }, t('capabilities.copySessionHint')),
          h(Select, { value: sessionId, disabled: unavailable, label: t('capabilities.copyFromSession'), onChange: setSessionId,
            options: [{ value: '', label: t('capabilities.chooseSession') }, ...(plans ?? []).map(plan => ({ value: plan.sessionId, label: plan.sessionId }))] }),
          input('capabilities.copyName', copyName, setCopyName),
          button('capabilities.saveSessionConfiguration', () => perform('copy', () => save(capabilityProfileConfiguration(frozen.configuration), copyName)),
            unavailable || !copyName.trim() || !frozen?.configuration)) : null),
      h('div', { className: 'ptcPlusConfigurationDetail' }, selected ? h(React.Fragment, null,
        h('div', { className: 'ptcPlusTaskHead' }, h('h4', null, selected.name),
          button('capabilities.applyConfiguration', () => perform('library', () => onApplyConfiguration(selected.configuration)), unavailable || !onApplyConfiguration,
            { 'data-kind': 'primary' }),
          h('details', { className: 'ptcPlusConfigurationMenu' }, h('summary', { 'aria-label': t('capabilities.profileMore') }, '···'),
            button('capabilities.renameConfiguration', () => { setRename(selected.name); setAction('rename') }, unavailable),
            button('capabilities.exportConfiguration', () => exportProfiles('selected')),
            button('capabilities.deleteConfiguration', () => perform('library', async () => {
              await saveLibrary(library.profiles.filter(profile => profile.id !== selected.id)); setSelectedId(''); finishAction()
            }), unavailable, { 'data-kind': 'danger' }))),
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
        action === 'rename' ? h('form', { className: 'ptcPlusConfigurationAction', onSubmit: event => {
          event.preventDefault(); if (!unavailable && rename.trim()) void perform('library', async () => {
            await saveLibrary(library.profiles.map(profile => profile.id === selected.id ? { ...profile, name: rename.trim() } : profile)); finishAction()
          })
        } }, input('capabilities.renameTo', rename, setRename), button('capabilities.confirmRename', undefined, unavailable || !rename.trim(), { type: 'submit' })) : null)
        : h('p', { className: 'ptcPlusDetail' }, t('capabilities.chooseConfiguration'))), feedback)
  }

  function ContextSettings({ value, disabled, onChange, t, renderField, allocation, allocationError, allocationPending, selectedSessionId, onReload, renderRefresh, id, section, setSection }) {
    const sections = ['description', 'recovery', 'preview']
    const featureKeys = { description: 'capabilityManagementEnabled', recovery: 'capabilityRecoveryEnabled', preview: 'modelPreviewEnabled' }
    const policy = capabilityPolicyForConfig(value)
    const write = next => onChange(field('capabilityPolicy'), JSON.stringify(next))
    const adaptive = [policy.defaults, ...Object.values(policy.categories), ...Object.values(policy.mcpServers), ...Object.values(policy.items)]
      .some(rule => rule.disclosure === 'adaptive')
    const criteria = h('div', { className: 'ptcPlusPolicyAllocation' },
      h('h5', null, t('capabilities.allocationTitle')),
      h('div', { className: 'ptcPlusAllocationChoices' }, ...['baseline', 'statistics', 'budget'].map(key => h('label', { key },
        h('input', { type: 'checkbox', role: 'switch', disabled: disabled('capabilityPolicy'), checked: policy.allocation[key],
          'aria-label': t(`capabilities.policy.allocate.${key}`),
          onChange: event => write({ ...policy, allocation: { ...policy.allocation, [key]: event.target.checked } }) }),
        h('span', null, t(`capabilities.allocation.${key}`))))),
      h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false ? 'capabilities.effect.paused'
        : value.capabilityManagementEnabled !== true ? 'capabilities.effect.rulesOff'
          : adaptive ? 'capabilities.effect.allocationActive' : 'capabilities.effect.allocationRetained')),
      policy.allocation.statistics ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.effect.historicalStatistics')) : null,
      h('details', null, h('summary', { tabIndex: 0 }, t('capabilities.effect.conditions')),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.effect.allocationLimits'))))
    const feature = (key, label) => h('label', { className: 'ptcPlusRow' }, h('span', { className: 'ptcPlusMain' }, t(label)),
      h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value[key] === true,
        disabled: disabled(key), 'aria-label': t(label), onChange: event => onChange(field(key), event.target.checked) }))
    return h('div', { className: 'ptcPlusContextLayout' },
      h('div', { className: 'ptcPlusContextNavigation', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('capabilities.contextNavigation') },
        ...sections.map((key, index) => {
          const active = value[featureKeys[key]] === true
          const paused = value.capabilityContextEnabled === false && active
          const state = paused ? 'capabilities.paused' : key === 'description' ? (active ? 'capabilities.context.custom' : value.capabilityContextEnabled === false ? 'capabilities.serverOff' : 'capabilities.host')
            : active ? 'capabilities.serverOn' : 'capabilities.serverOff'
          return h('button', { key, type: 'button', role: 'tab', id: `${id}-context-tab-${key}`,
            'aria-label': t(`capabilities.context.${key}`), 'aria-describedby': `${id}-context-state-${key}`,
            'aria-controls': `${id}-context-pane-${key}`, 'aria-selected': section === key, tabIndex: section === key ? 0 : -1,
            onClick: () => setSection(key), onKeyDown: event => navigateTabs(event, sections, index, setSection),
          }, h('span', null, t(`capabilities.context.${key}`)),
          h('span', { className: 'ptcPlusContextState', id: `${id}-context-state-${key}`, 'data-enabled': active && !paused,
            'data-paused': paused }, t(state)))
        })),
      h('div', { className: 'ptcPlusContextContent' }, ...sections.map(key => h('section', { key, role: 'tabpanel',
        id: `${id}-context-pane-${key}`, 'aria-labelledby': `${id}-context-tab-${key}`, hidden: section !== key },
        h('h4', null, t(`capabilities.context.${key}`)),
        key === 'description' ? h(React.Fragment, null,
          h('p', { className: 'ptcPlusDetail' }, t('capabilities.descriptionHelp')),
          h('div', { className: 'ptcPlusCapabilityFilter' }, h('span', null, t('capabilities.defaultDisclosure')),
            h(Select, { value: policy.defaults.disclosure, disabled: disabled('capabilityPolicy'), label: t('capabilities.defaultDisclosure'),
              options: CAPABILITY_DISCLOSURES.map(choice => ({ value: choice, label: t(`capabilities.${choice}`) })),
              onChange: disclosure => write({ ...policy, defaults: { ...policy.defaults, disclosure } }) })),
          h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false ? 'capabilities.effect.paused'
            : value.capabilityManagementEnabled !== true ? 'capabilities.effect.rulesOff' : `capabilities.effect.disclosure.${policy.defaults.disclosure}`)),
          adaptive ? criteria : h('details', null, h('summary', { tabIndex: 0 }, t('capabilities.allocationTitle')), criteria),
          h('details', { className: 'ptcPlusContextQuota' }, h('summary', { tabIndex: 0 }, t('capabilities.quotaSettings')),
            ...['capabilityBudgetBytes', 'capabilityDirectoryBytes'].map(renderField)),
          value.capabilityManagementEnabled !== true ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.descriptionInactive')) : null,
          h('details', { className: 'ptcPlusAllocationPreview' }, h('summary', { tabIndex: 0 }, t('capabilities.budgetPreview')),
            renderRefresh?.({ observation: true }), h(AllocationEvidence, { allocation, allocationError, allocationPending, selectedSessionId, onReload, t })))
          : key === 'recovery' ? h(React.Fragment, null,
            h('p', { className: 'ptcPlusDetail' }, t('capabilities.recoveryHelp')),
            feature('capabilityRecoveryEnabled', 'capabilities.recoveryEnabled'),
            h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false && value.capabilityRecoveryEnabled === true
              ? 'capabilities.effect.paused' : value.capabilityRecoveryEnabled === true ? 'capabilities.effect.recoveryOn' : 'capabilities.effect.recoveryOff')),
            h('details', { className: 'ptcPlusContextQuota' }, h('summary', { tabIndex: 0 }, t('capabilities.quotaSettings')), renderField('capabilityRecoveryBytes')))
            : h(React.Fragment, null, h('p', { className: 'ptcPlusDetail' }, t('capabilities.previewHelp')),
              feature('modelPreviewEnabled', 'capabilities.previewEnabled'),
              h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false && value.modelPreviewEnabled === true
                ? 'capabilities.effect.paused' : value.modelPreviewEnabled === true ? 'capabilities.effect.previewOn' : 'capabilities.effect.previewOff')),
              value.modelPreviewEnabled === true ? renderField('modelPreviewTokens')
                : h('details', { className: 'ptcPlusContextQuota' }, h('summary', { tabIndex: 0 }, t('capabilities.quotaSettings')), renderField('modelPreviewTokens')))))))
  }

  function navigateTabs(event, tabs, index, update) {
    const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
    const next = offset ? (index + offset + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (next === null) return
    event.preventDefault(); update(tabs[next])
    event.currentTarget.parentElement.querySelectorAll('[role=tab]')[next].focus({ preventScroll: true })
  }

  function CapabilityWorkbench({ value, configurationReady, catalog, catalogError, plans, plansError, plansPending, plansStale, disabled, onChange, onReload, t, renderField, renderPlans, renderRefresh, id, selectedSessionId, onSessionSelect,
    allocation, allocationError, allocationPending, onApplyConfiguration, configurationWritable, saving, saveStatus }) {
    const [tab, setTab] = React.useState('manual')
    const [contextSection, setContextSection] = React.useState('description')
    const tabs = ['manual', 'budgets', 'statistics', 'plans']
    const feedback = saving ? t('state.syncing') : saveStatus && saveStatus.key !== 'status.applied' ? t(saveStatus.key, saveStatus.params)
      : t(configurationWritable ? 'capabilities.savedForNew' : 'footer.readOnly')
    return h('div', { className: 'ptcPlusCapabilityWorkbench' },
      h(CombinationSummary, { value, configurationReady, plans, plansError, plansPending, plansStale, selectedSessionId,
        feedback, onReload, renderRefresh, renderPlans, t, id, onNavigate: key => {
          setTab(key === 'rules' ? 'manual' : key === 'statistics' ? 'statistics' : 'budgets')
          if (key === 'recovery' || key === 'preview') setContextSection(key)
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
          : key === 'statistics' ? h(React.Fragment, null, renderRefresh?.({ observation: true }), renderField('capabilityStatistics'),
            h('p', { className: 'ptcPlusDetail' }, t(value.capabilityContextEnabled === false ? 'capabilities.effect.paused'
              : choicesFor(value).statistics?.enabled === true ? 'capabilities.effect.collectionOn'
                : choicesFor(value).statistics?.enabled === false ? 'capabilities.effect.collectionOff' : 'capabilities.combination.unknownSettings')),
            h('p', { className: 'ptcPlusDetail' }, t('capabilities.effect.statisticsIndependent')),
            h(AllocationEvidence, { allocation, allocationError, allocationPending, selectedSessionId, statistics: true, onReload, t }))
            : key === 'budgets' ? h(ContextSettings, { value, disabled, onChange, t, renderField, allocation, allocationError, allocationPending,
              selectedSessionId, onReload, renderRefresh, id, section: contextSection, setSection: setContextSection })
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
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState(null)
    const [drafts, setDrafts] = React.useState(emptyDrafts)
    const [selectedId, setSelectedId] = React.useState(null)
    const [pane, setPane] = React.useState('list')
    const [query, setQuery] = React.useState('')
    const [kind, setKind] = React.useState('all')
    const [sourceFilter, setSourceFilter] = React.useState('all')
    const [stateFilter, setStateFilter] = React.useState('all')
    const [sort, setSort] = React.useState('name')
    const [status, setStatus] = React.useState(null)
    const [pending, setPending] = React.useState(false)
    const request = React.useRef(null)
    const applying = React.useRef(false)
    const mounted = React.useRef(true)
    React.useEffect(() => {
      mounted.current = true
      return () => { mounted.current = false; request.current?.abort(); request.current = null }
    }, [])
    React.useEffect(() => {
      request.current?.abort()
      request.current = null
      applying.current = false
      setCatalog([])
      setDrafts(emptyDrafts())
      setSelectedId(null)
      setPane('list')
      setStatus(null)
      setPending(false)
      setError(null)
    }, [sessionId])
    const load = React.useCallback(async signal => {
      setLoading(true)
      try {
        const entries = await inspectSessionCatalog(sessionId, signal)
        if (signal.aborted || !mounted.current || request.current?.signal !== signal) return
        if (!Array.isArray(entries)) throw new Error('Invalid capability catalog')
        setCatalog(entries)
        setError(null)
        return entries
      } catch (failure) {
        if (!signal.aborted && mounted.current && request.current?.signal === signal) setError(String(failure?.message ?? failure))
      } finally {
        if (!signal.aborted && mounted.current && request.current?.signal === signal) setLoading(false)
      }
    }, [sessionId])
    React.useEffect(() => {
      if (!open || !enabled || !available) {
        request.current?.abort(); request.current = null; setLoading(false); return
      }
      const controller = new AbortController()
      request.current = controller
      void load(controller.signal)
      return () => { controller.abort(); if (request.current === controller) request.current = null }
    }, [open, enabled, available, load])
    React.useEffect(() => {
      if (!enabled || !available) {
        request.current?.abort()
        request.current = null
        applying.current = false
        setPending(false)
      }
    }, [enabled, available])
    const choices = drafts
    const choiceFor = entry => choices[entry.id] ?? entry.temporary ?? 'inherit'
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
    const matches = catalog.filter(entry => {
      const text = [entry.name, entry.id, entry.description, entry.source?.server, entry.source?.bucket].filter(Boolean).join(' ').toLocaleLowerCase()
      return (kind === 'all' || category(entry) === kind)
        && (sourceFilter === 'all' || sourceKey(entry) === sourceFilter)
        && (stateFilter === 'all' || (stateFilter === 'changed' ? Object.hasOwn(choices, entry.id) : entry.effective === stateFilter))
        && text.includes(query.trim().toLocaleLowerCase())
    }).sort((a, b) => sort === 'effective'
      ? String(a.effective).localeCompare(String(b.effective)) || a.id.localeCompare(b.id)
      : (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id))
    const selected = matches.find(entry => entry.id === selectedId)
      ?? ['tools', 'skills', 'mcp', 'mcp_tools'].map(group => matches.find(entry => category(entry) === group)).find(Boolean)
    const staged = Object.entries(choices).flatMap(([id, choice]) => typeof choice === 'object'
      ? Object.entries(choice).map(([dimension, selection]) => [id, selection, dimension]) : [[id, choice]])
    const chooseDimension = (id, dimension, choice) => {
      setDrafts(current => {
        const patch = typeof current[id] === 'object' ? { ...current[id] } : {}
        const original = catalog.find(entry => entry.id === id)?.temporaryRule?.[dimension] ?? 'inherit'
        if (choice === original && choice === 'inherit') delete patch[dimension]
        else patch[dimension] = choice
        const next = { ...current }; if (Object.keys(patch).length) next[id] = patch; else delete next[id]; return next
      })
    }
    const choose = (id, next) => {
      const entry = catalog.find(item => item.id === id)
      if (!entry) return
      const original = entry.temporary ?? 'inherit'
      setDrafts(current => {
        const nextChoices = { ...current }
        if (next === original && next === 'inherit') delete nextChoices[id]
        else nextChoices[id] = next
        return nextChoices
      })
    }
    const hasInheritanceReset = staged.some(([, selection]) => selection === 'inherit')
    const apply = async targetScope => {
      if (applying.current || !enabled || !available || staged.length === 0) return
      if (targetScope === 'global' && hasInheritanceReset) return
      const submitted = structuredClone(choices)
      applying.current = true
      setPending(true)
      setStatus(null)
      const controller = new AbortController()
      request.current?.abort()
      request.current = controller
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
      if (request.current === controller) { request.current = null; applying.current = false; setPending(false) }
    }
    const discard = () => { setDrafts(emptyDrafts()); setStatus(null) }
    const close = () => {
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
    const choiceOptions = selected ? [
      'inherit', 'automatic',
      ...(selected.category === 'server' ? [] : ['full', 'on-demand']), 'closed',
    ].map(choice => ({ value: choice, label: t(choice === 'inherit' ? 'capabilities.quick.inherit' : `capabilities.${choice}`) })) : []
    const ruleLabel = (rule, empty) => capabilityRuleLabel(t, rule, empty)
    const dimensionFacts = dimensions => ['availability', 'disclosure'].map(dimension =>
      `${t(`capabilities.policy.${dimension}`)}: ${statusLabel(dimensions[dimension])} (${dimensions[`${dimension}Source`] ?? t('capabilities.quick.unknown')})`).join(' · ')
    const statusLabel = value => value && typeof value === 'object' ? ruleLabel(value) : capabilityChoiceLabel(t, value)
    return h(Modal, { open, onClose: close, title: t('capabilities.quick.modalTitle'),
      closeLabel: t('settings.close'), headless: true, className: 'ptcPlusSessionCapabilityModal' },
    h('div', { className: 'ptcPlusSessionCapabilityHead' },
      h('div', null, h('h2', null, t('capabilities.quick.modalTitle')),
        h('p', null, t('capabilities.quick.sessionIdentity', { session: sessionId }))),
      h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('settings.close'), onClick: close }, '×')),
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
          ...['full', 'on-demand', 'closed', 'pending'].map(key => [key, statusLabel(key)])]),
      filter(t('capabilities.sort'), sort, setSort,
        [['name', t('capabilities.sort.name')], ['effective', t('capabilities.quick.effective')]])),
    h('div', { className: 'ptcPlusSessionCapabilityWorkspace', 'data-pane': pane },
      h('div', { className: 'ptcPlusSessionCapabilityList', 'aria-label': t('capabilities.quick.members') },
        h('div', { className: 'ptcPlusSessionCapabilityColumns', 'aria-hidden': true },
          h('span', null, t('capabilities.member')),
          h('span', null, t('capabilities.quick.effective')),
          h('span', null, t('capabilities.quick.changed'))),
        loading ? h('p', { role: 'status' }, t('state.syncing')) : null,
        error ? h('p', { role: 'alert' }, t('capabilities.quick.catalogError', { error })) : null,
        !loading && !error && matches.length === 0 ? h('p', null, t('capabilities.noMatches')) : null,
        ...['tools', 'skills', 'mcp', 'mcp_tools'].filter(group => matches.some(entry => category(entry) === group))
          .map(group => h('section', { key: group, className: 'ptcPlusSessionCapabilityGroup' },
            h('h3', null, t(`capabilities.quick.${group}`)),
            h('ul', null, ...matches.filter(entry => category(entry) === group).map(entry => h('li', { key: entry.id },
              h('button', { type: 'button',
          className: 'ptcPlusSessionCapabilityRow', 'data-selected': selected?.id === entry.id,
          'aria-current': selected?.id === entry.id ? 'true' : undefined, onClick: () => { setSelectedId(entry.id); setPane('detail') } },
          h('span', { className: 'ptcPlusSessionCapabilityName' }, entry.name ?? entry.id,
            entry.source?.kind === 'mcp' && entry.category !== 'server'
              ? h('small', null, entry.source.server ?? '') : null),
          h('span', { className: 'ptcPlusSessionCapabilityEffective' }, statusLabel(entry.effective)),
          h('span', { className: 'ptcPlusSessionCapabilityPending' },
            Object.hasOwn(choices, entry.id) ? statusLabel(choices[entry.id]) : '—')))))))),
      h('aside', { className: 'ptcPlusSessionCapabilityDetail', 'aria-label': t('capabilities.details') },
        h('button', { type: 'button', className: 'ptcPlusSessionCapabilityBack', onClick: () => setPane('list') },
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
          selected.savedRule ? h(React.Fragment, null, ...['availability', 'disclosure'].map(dimension =>
            h('div', { className: 'ptcPlusCapabilityFilter', key: dimension },
              h('span', null, t(`capabilities.policy.${dimension}`)),
              h(Select, { label: t(`capabilities.policy.${dimension}`), disabled: !enabled || !available || pending,
                value: choices[selected.id]?.[dimension] ?? selected.temporaryRule?.[dimension] ?? 'inherit',
                onChange: next => chooseDimension(selected.id, dimension, next),
                options: ['inherit', 'automatic', ...(dimension === 'availability' ? ['enabled', 'closed'] : CAPABILITY_DISCLOSURES)]
                  .map(choice => ({ value: choice, label: t(choice === 'inherit' ? 'capabilities.quick.inherit'
                    : choice === 'automatic' ? 'capabilities.policy.inheritRule' : choice === 'enabled' ? 'capabilities.quick.enabled' : `capabilities.${choice}`) })) }))))
            : h('div', { className: 'ptcPlusCapabilityFilter' },
              h('span', null, t('capabilities.quick.choice')),
              h(Select, { label: t('capabilities.quick.choice'), value: choiceFor(selected),
                disabled: !enabled || !available || pending, options: choiceOptions,
                onChange: next => choose(selected.id, next) })),
          choices[selected.id] === 'inherit' ? h('p', { className: 'ptcPlusDetail' },
            t('capabilities.quick.inheritSessionOnly')) : null) : h('p', null, t('capabilities.noMatches')))),
    h('div', { className: 'ptcPlusSessionCapabilityFooter' },
      h('span', { role: 'status' }, pending ? t('capabilities.quick.applying') : status ? t(status.key, status.params)
        : t('capabilities.quick.changes', { count: staged.length })),
      h('button', { type: 'button', className: 'ptcPlusButton', disabled: pending || staged.length === 0, onClick: discard },
        t('capabilities.quick.discard')),
      h('button', { type: 'button', className: 'ptcPlusButton', title: t('capabilities.quick.sessionHint'),
        disabled: pending || !enabled || !available || staged.length === 0, onClick: () => void apply('session') },
        t('capabilities.quick.applySession')),
      h('button', { type: 'button', className: 'ptcPlusButton', 'data-kind': 'primary',
        title: t(hasInheritanceReset ? 'capabilities.quick.inheritSessionOnly' : 'capabilities.quick.globalHint'),
        disabled: pending || !enabled || !available || staged.length === 0 || hasInheritanceReset, onClick: () => void apply('global') },
        t('capabilities.quick.applyGlobal'))))
  }
}
