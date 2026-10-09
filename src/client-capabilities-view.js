import { CONFIG_DEFAULTS, CONFIG_FIELDS } from '../internal/config-spec.js'
import { CAPABILITY_CONFIGURATION_KEYS, capabilityProfileConfiguration, validateCapabilityProfiles } from '../internal/runtime-config.js'

const selections = ['automatic', 'full', 'on-demand', 'closed']
const kinds = ['all', 'tool', 'skill', 'resource', 'other']
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const configurationId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')

/** Catalog facts and saved preferences stay separate from frozen session results. */
export function capabilitySettingsEntries(value, catalog, plans, uncertain = false) {
  const baseline = JSON.parse(value.capabilityBaseline ?? CONFIG_DEFAULTS.capabilityBaseline)
  const overrides = JSON.parse(value.capabilityOverrides ?? CONFIG_DEFAULTS.capabilityOverrides)
  const entries = new Map((catalog ?? []).map(entry => [entry.id, { ...entry, available: true }]))
  for (const plan of plans ?? []) for (const entry of plan.effective.entries) {
    if (!entries.has(entry.id)) entries.set(entry.id, { id: entry.id, category: entry.category })
  }
  for (const id of [...baseline, ...Object.keys(overrides)].filter(id => !id.startsWith('mcpServers.'))) if (!entries.has(id)) entries.set(id, { id })
  return [...entries.values()].map(entry => ({ ...entry,
    name: entry.name ?? entry.id,
    kind: ['tool', 'skill'].includes(entry.category) ? entry.category
      : ['resource', 'resource-template'].includes(entry.category) ? 'resource' : 'other',
    availability: catalog === null || uncertain ? 'unknown' : entry.available ? 'available' : 'unavailable',
    common: baseline.includes(entry.id), manual: overrides[entry.id] ?? 'automatic',
  }))
}

export function capabilityPlanReason(t, entry) {
  const known = ['manual-override', 'baseline-not-selected', 'baseline', 'coverage-below-threshold', 'statistical-coverage',
    'mcp-server-disabled', 'contract-budget', 'management-disabled', 'statistics-disabled', 'statistics-settings-invalid', 'statistics-data-invalid',
    'statistics-unavailable', 'workspace', 'global']
  return [entry.reason, entry.statisticsReason].filter(Boolean)
    .map(reason => known.includes(reason) ? t(`capabilities.reason.${reason}`) : reason).join(' · ')
}

export function createCapabilitySettingsViews(React, { SearchIcon }) {
  const h = React.createElement
  const field = key => CONFIG_FIELDS.find(item => item.key === key)

  function CapabilityChoices({ value, catalog, catalogError, plans, plansError, disabled, onChange, onReload, t, selectedSessionId, onSessionSelect }) {
    const [query, setQuery] = React.useState('')
    const [kind, setKind] = React.useState('all')
    const [source, setSource] = React.useState('all')
    const [strategy, setStrategy] = React.useState('all')
    const [onlyCommon, setOnlyCommon] = React.useState(false)
    const [availability, setAvailability] = React.useState('all')
    const [sort, setSort] = React.useState('name')
    const [descending, setDescending] = React.useState(false)
    const [selected, setSelected] = React.useState(null)
    const [localSessionId, setLocalSessionId] = React.useState('')
    const sessionId = onSessionSelect ? selectedSessionId : localSessionId
    const setSessionId = next => { setLocalSessionId(next); onSessionSelect?.(next) }
    const baseline = JSON.parse(value.capabilityBaseline ?? CONFIG_DEFAULTS.capabilityBaseline)
    const overrides = JSON.parse(value.capabilityOverrides ?? CONFIG_DEFAULTS.capabilityOverrides)
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
      && (strategy === 'all' || entry.manual === strategy)
      && (!onlyCommon || entry.common)
      && (availability === 'all' || entry.availability === availability)
      && `${entry.name} ${entry.id} ${entry.description ?? ''} ${sourceLabel(entry)}`.toLowerCase().includes(normalizedQuery))
    const order = (a, b) => {
      const primary = sort === 'common' ? Number(b.common) - Number(a.common)
        : sort === 'strategy' ? selections.indexOf(a.manual) - selections.indexOf(b.manual)
          : compare((sort === 'id' ? a.id : a.name).toLowerCase(), (sort === 'id' ? b.id : b.name).toLowerCase())
      return (descending ? -1 : 1) * (primary || compare(a.id, b.id))
    }
    const groups = new Map()
    const observedServers = new Set(entries.filter(entry => entry.source?.kind === 'mcp').map(entry => entry.source.server))
    for (const entry of filtered) {
      const group = entry.source?.kind === 'mcp' && entry.source.server ? `mcp:${entry.source.server}`
        : entry.availability === 'unavailable' ? 'unavailable' : entry.kind
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(entry)
    }
    for (const id of Object.keys(overrides).filter(id => id.startsWith('mcpServers.'))) {
      const server = id.slice('mcpServers.'.length)
      const serverAvailability = catalog === null || catalogError ? 'unknown' : 'unavailable'
      if (!observedServers.has(server) && (kind === 'all' || kind === 'resource') && source === 'all'
        && !normalizedQuery && strategy === 'all' && !onlyCommon
        && (availability === 'all' || availability === serverAvailability)) groups.set(`mcp:${server}`, [])
    }
    const groupOrder = ['tool', ...[...groups.keys()].filter(key => key.startsWith('mcp:')).sort(compare), 'skill', 'resource', 'other', 'unavailable']
    const visible = groupOrder.flatMap(group => (groups.get(group) ?? []).sort(order))
    const entry = visible.find(item => item.id === selected) ?? visible[0]
    const plan = sessionId ? plans?.find(item => item.sessionId === sessionId) : plans?.[0]
    const effective = plan?.effective.entries.find(item => item.id === entry?.id)
    const change = (key, next) => onChange(field(key), JSON.stringify(next))
    const setServer = (server, enabled) => {
      const next = { ...overrides }
      if (enabled) delete next[`mcpServers.${server}`]
      else next[`mcpServers.${server}`] = 'closed'
      change('capabilityOverrides', next)
    }
    const setManual = (id, selection) => {
      const next = { ...overrides }
      if (selection === 'automatic') delete next[id]
      else next[id] = selection
      change('capabilityOverrides', next)
    }
    const clear = () => { setQuery(''); setKind('all'); setSource('all'); setStrategy('all'); setOnlyCommon(false); setAvailability('all') }
    const activeFilters = Number(kind !== 'all') + Number(source !== 'all') + Number(strategy !== 'all') + Number(onlyCommon) + Number(availability !== 'all')
    const select = (label, current, update, options) => h('label', { className: 'ptcPlusCapabilityFilter' },
      h('span', null, label), h('select', { className: 'ptcPlusSelect', 'aria-label': label, value: current,
        onChange: event => update(event.target.value) }, ...options.map(([key, text]) => h('option', { key, value: key }, text))))
    const manualSelect = item => h('select', { className: 'ptcPlusSelect', value: item.manual, 'data-strategy': item.manual,
      disabled: disabled('capabilityOverrides'), 'aria-label': t('capabilities.disclosureFor', { name: item.id }),
      onChange: event => setManual(item.id, event.target.value) },
    ...selections.map(selection => h('option', { key: selection, value: selection }, t(`capabilities.${selection}`))))
    const common = item => h('label', { className: 'ptcPlusCapabilityCommon', title: t('capabilities.baselineFor', { name: item.id }) },
      h('input', { type: 'checkbox', disabled: disabled('capabilityBaseline'), checked: item.common,
        'aria-label': t('capabilities.baselineFor', { name: item.id }),
        onChange: event => change('capabilityBaseline', event.target.checked
          ? [...baseline.filter(id => id !== item.id), item.id] : baseline.filter(id => id !== item.id)) }),
      h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { d: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z' })))
    return h('div', { className: 'ptcPlusCapabilityChoices' },
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.serverHint')),
      h('div', { className: 'ptcPlusCapabilityFoundation' },
        h('strong', null, t('capabilities.foundation')), h('code', null, 'run_code · edit_run_code · capabilities.*'),
        h('span', null, t('capabilities.foundationHint'))),
      h('div', { className: 'ptcPlusCapabilityToolbar' },
        h('label', { className: 'ptcPlusSearch' }, h(SearchIcon),
          h('input', { type: 'search', value: query, 'aria-label': t('capabilities.search'), placeholder: t('capabilities.search'),
            onChange: event => setQuery(event.target.value) })),
        select(t('capabilities.sort'), sort, setSort, ['name', 'id', 'strategy', 'common'].map(key => [key, t(`capabilities.sort.${key}`)])),
        h('button', { type: 'button', className: 'ptcPlusCapabilityDirection', 'aria-label': t(descending ? 'capabilities.descending' : 'capabilities.ascending'),
          onClick: () => setDescending(current => !current) }, descending ? '↓' : '↑')),
      h('div', { className: 'ptcPlusCapabilityFilters' },
        h('span', { className: 'ptcPlusDetail' }, t('capabilities.filters', { count: activeFilters })),
        h('div', { className: 'ptcPlusCapabilityFilterFields' },
          select(t('capabilities.types'), kind, setType, kinds.filter(key => key !== 'other' || entries.some(item => item.kind === 'other')).map(key => [key, t(`capabilities.type.${key}`)])),
          select(t('capabilities.sourceFilter'), source, setCompatibleSource, [['all', t('capabilities.allSources')], ...sources,
            ...(source !== 'all' && !sources.has(source) ? [[source, t('capabilities.previousSource')]] : [])]),
          select(t('capabilities.strategyFilter'), strategy, setStrategy, [['all', t('capabilities.allStrategies')],
            ...selections.map(key => [key, t(`capabilities.${key}`)])]),
          h('label', { className: 'ptcPlusCapabilityOnlyCommon' }, h('input', { type: 'checkbox', checked: onlyCommon,
            onChange: event => setOnlyCommon(event.target.checked) }), t('capabilities.onlyCommon')),
          select(t('capabilities.availabilityFilter'), availability, setAvailability,
            ['all', 'available', 'unavailable', 'unknown'].map(key => [key, t(`capabilities.availability.${key}`)])),
          h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: clear }, t('capabilities.clear')))),
      h('div', { className: 'ptcPlusCapabilityResultLine' }, h('span', { role: 'status' }, t('capabilities.results', { count: visible.length, total: entries.length })),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: onReload, disabled: disabled('capabilityBaseline') }, t('capabilities.reloadCatalog'))),
      catalogError ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.catalogUnavailable', { error: catalogError })) : null,
      entries.length === 0 && groups.size === 0 ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.catalogEmpty'))
        : visible.length === 0 && !groupOrder.some(group => group.startsWith('mcp:')) ? h('div', { className: 'ptcPlusCapabilityEmpty' }, h('p', null, t('capabilities.noMatches')),
          h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: clear }, t('capabilities.clear'))) :
          h('div', { className: 'ptcPlusCapabilityWorkspace' },
            h('div', { className: 'ptcPlusCapabilityTable' },
              h('div', { className: 'ptcPlusCapabilityColumns', 'aria-hidden': true },
                h('span', null, t('capabilities.member')), h('span', null, t('capabilities.commonBaseline')), h('span', null, t('capabilities.strategyFilter'))),
              h('div', { className: 'ptcPlusCapabilityList' }, ...groupOrder.filter(key => groups.has(key)).map(group => h('section', { key: group },
                h('div', { className: 'ptcPlusCapabilityGroup', 'data-mcp-server': group.startsWith('mcp:') ? group.slice(4) : undefined },
                  h('h4', null, group.startsWith('mcp:') ? `MCP · ${group.slice(4)}` : t(`capabilities.group.${group}`)),
                  h('span', null, groups.get(group).length),
                  group.startsWith('mcp:') ? h('label', { className: 'ptcPlusCapabilityServerSwitch' },
                    h('span', null, t(overrides[`mcpServers.${group.slice(4)}`] === 'closed' ? 'capabilities.serverOff' : 'capabilities.serverOn')),
                    h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck',
                      'aria-label': t('capabilities.serverToggle', { name: group.slice(4) }),
                      disabled: disabled('capabilityOverrides'), checked: overrides[`mcpServers.${group.slice(4)}`] !== 'closed',
                      onChange: event => setServer(group.slice(4), event.target.checked) })) : null),
                group.startsWith('mcp:') && overrides[`mcpServers.${group.slice(4)}`] === 'closed'
                  ? h('p', { className: 'ptcPlusDetail ptcPlusCapabilityServerHint' }, t('capabilities.serverDisabledHint')) : null,
                ...groups.get(group).sort(order).map(item => h('div', { key: item.id, className: 'ptcPlusCapabilityItem',
                  'data-selected': entry?.id === item.id, 'data-availability': item.availability },
                h('button', { type: 'button', className: 'ptcPlusCapabilityIdentity', 'aria-pressed': entry?.id === item.id,
                  onClick: () => setSelected(item.id) },
                h('span', { className: 'ptcPlusCapabilityName' }, item.name,
                  h('span', { className: 'ptcPlusCapabilityBadge', 'data-kind': item.kind }, t(`capabilities.type.${item.kind}`))),
                h('code', null, item.id), h('small', null, sourceLabel(item)),
                item.availability === 'unavailable' ? h('small', null, t('capabilities.notAvailable')) : null), common(item), manualSelect(item))))))),
            entry ? h('aside', { className: 'ptcPlusCapabilityDetail', 'aria-label': t('capabilities.details') },
              h('h4', null, entry.name), h('span', { className: 'ptcPlusCapabilityBadge', 'data-kind': entry.kind }, t(`capabilities.type.${entry.kind}`)),
              h('code', null, entry.id), h('p', { className: 'ptcPlusDetail' }, sourceLabel(entry)),
              h('dl', null, h('dt', null, t('capabilities.commonBaseline')), h('dd', null, t(entry.common ? 'capabilities.inBaseline' : 'capabilities.notInBaseline')),
                h('dt', null, t('capabilities.savedStrategy')), h('dd', null, t(`capabilities.${entry.manual}`))),
              entry.manual !== 'automatic' ? h('button', { type: 'button', className: 'ptcPlusCapabilityLink', disabled: disabled('capabilityOverrides'),
                onClick: () => setManual(entry.id, 'automatic') }, t('capabilities.restoreAutomatic')) : null,
              entry.common && entry.manual === 'closed' ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.closedBaseline')) : null,
              entry.kind === 'skill' ? h('p', { className: 'ptcPlusCapabilityNotice' }, t('capabilities.skillDisclosure')) : null,
              entry.description ? h('details', { className: 'ptcPlusCapabilityDescription', key: entry.id },
                h('summary', { tabIndex: 0 }, t('capabilities.viewDescription')), h('p', null, entry.description)) : null,
              entry.availability === 'unavailable' ? h('button', { type: 'button', className: 'ptcPlusCapabilityLink',
                disabled: disabled('capabilityBaseline') || disabled('capabilityOverrides'), onClick: () => {
                  const next = { ...overrides }; delete next[entry.id]
                  if (Object.hasOwn(overrides, entry.id)) change('capabilityOverrides', next)
                  if (baseline.includes(entry.id)) change('capabilityBaseline', baseline.filter(id => id !== entry.id))
                } }, t('capabilities.removeSaved')) : null,
              value.capabilityManagementEnabled === true ? h('section', { className: 'ptcPlusCapabilitySessionDetail' },
                h('h5', null, t('capabilities.currentSession')),
                plansError ? h('p', { role: 'status' }, t('capabilities.unavailable', { error: plansError }))
                  : !plan ? h('p', null, t('capabilities.empty')) : h(React.Fragment, null,
                  select(t('capabilities.sessionSelector'), plan.sessionId, setSessionId, plans.map(item => [item.sessionId, item.sessionId])),
                  h('p', null, effective ? t(`capabilities.${effective.selection}`) : t('capabilities.notInSession')),
                  effective ? h('p', { className: 'ptcPlusDetail' }, capabilityPlanReason(t, effective)) : null,
                  effective?.evidence ? h('p', { className: 'ptcPlusDetail' }, `${effective.evidence.used}/${effective.evidence.eligible} (${effective.evidence.scope})`) : null,
                  plan.pendingRefresh ? h('p', { className: 'ptcPlusCapabilityNotice' }, t('capabilities.pending')) : null,
                  h('p', { className: 'ptcPlusDetail' }, t('capabilities.refreshHint')), h('code', null, '/capabilities refresh'))) : null) : null),
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.baselineHint')))
  }

  function AllocationEvidence({ allocation, allocationError, allocationPending, selectedSessionId, statistics = false, onReload, t }) {
    if (allocationPending) return h('p', { role: 'status' }, t('state.syncing'))
    if (allocationError) return h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.unavailable', { error: allocationError }))
    if (!allocation) return h('p', { className: 'ptcPlusCapabilityNotice' }, t(selectedSessionId ? 'capabilities.observationUnavailable' : 'capabilities.selectObservation'))
    const { plan, coverage, configuration } = allocation
    const count = selection => plan.entries.filter(entry => entry.selection === selection).length
    const numeric = evidence => evidence?.status === 'usable' && evidence.eligible !== null
      ? `${evidence.used}/${evidence.eligible} · ${evidence.coverage === null ? '—' : `${Math.round(evidence.coverage * 100)}%`}`
      : t(`capabilities.statStatus.${evidence?.status ?? 'unavailable'}`)
    return h('section', { className: 'ptcPlusAllocationEvidence', 'aria-label': t(statistics ? 'capabilities.observedUsage' : 'capabilities.budgetPreview') },
      h('div', { className: 'ptcPlusCapabilityResultLine' }, h('h4', null, t(statistics ? 'capabilities.observedUsage' : 'capabilities.budgetPreview')),
        h('button', { type: 'button', className: 'ptcPlusCapabilityLink', onClick: onReload }, t('capabilities.reloadObservation'))),
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.observationScope', { workspace: allocation.workspace, session: allocation.sessionId })),
      h('p', { className: 'ptcPlusDetail' }, t(statistics ? 'capabilities.usageEvidenceHint' : 'capabilities.previewHint')),
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
          ? [t('capabilities.workspaceCoverage'), t('capabilities.globalCoverage')]
          : [t('capabilities.selection'), t('capabilities.reason'), t('capabilities.contractSize')])].map((label, key) => h('th', { key }, label)))),
        h('tbody', null, ...allocation.capabilities.map(item => {
          const entry = plan.entries.find(entry => entry.id === item.id)
          return h('tr', { key: item.id }, h('td', null, item.id), ...(statistics
            ? [h('td', { key: 'workspace' }, numeric(coverage?.[item.id]?.workspace)), h('td', { key: 'global' }, numeric(coverage?.[item.id]?.global))]
            : [h('td', { key: 'selection' }, t(`capabilities.${entry?.selection ?? 'host'}`)), h('td', { key: 'reason' }, entry ? capabilityPlanReason(t, entry) : '—'), h('td', { key: 'size' }, `${item.contractBytes} B`)]))
        })))))
  }

  function ConfigurationProfiles({ value, plans, disabled, writable, onChange, onApplyConfiguration, t }) {
    const library = validateCapabilityProfiles(JSON.parse(value.capabilityProfiles ?? CONFIG_DEFAULTS.capabilityProfiles))
    const [selectedId, setSelectedId] = React.useState('')
    const [name, setName] = React.useState('')
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [sessionId, setSessionId] = React.useState('')
    const fileInput = React.useRef(null)
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
    const selected = library.profiles.find(profile => profile.id === selectedId)
    const current = () => capabilityProfileConfiguration(Object.fromEntries(CAPABILITY_CONFIGURATION_KEYS.map(key => [key, value[key]])))
    const perform = async operation => {
      if (!mounted.current || !live.current?.writable || running.current) return
      const token = {}
      running.current = token
      const generation = lifecycle.current
      setBusy(true); setStatus(null)
      const assertCurrent = () => {
        if (!mounted.current || !live.current?.writable || generation !== lifecycle.current) throw new Error(t('capabilities.configurationUnavailable'))
      }
      try { await operation(assertCurrent); if (generation === lifecycle.current) setStatus(t('capabilities.configurationSaved')) }
      catch (error) { if (generation === lifecycle.current) setStatus(String(error?.message ?? error)) }
      finally { if (running.current === token) running.current = null; if (generation === lifecycle.current) setBusy(false) }
    }
    const saveLibrary = async profiles => {
      if (!mounted.current || !live.current?.writable) throw new Error(t('capabilities.configurationUnavailable'))
      const next = validateCapabilityProfiles({ schema: library.schema, profiles })
      if (!await onChange(field('capabilityProfiles'), JSON.stringify(next))) throw new Error(t('capabilities.configurationUnavailable'))
    }
    const save = async configuration => {
      const existing = library.profiles.find(profile => profile.name === name.trim())
      const profile = { id: existing?.id ?? configurationId(), name: name.trim(), configuration }
      await saveLibrary([...library.profiles.filter(item => item.id !== profile.id), profile])
      setSelectedId(profile.id)
    }
    const exportProfiles = () => {
      const document = { schema: library.schema, profiles: selected ? [selected] : library.profiles }
      const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2) + '\n'], { type: 'application/json' }))
      const link = globalThis.document.createElement('a')
      link.href = url; link.download = 'ptc-plus-capability-configurations.json'; link.click()
      const revoke = URL.revokeObjectURL.bind(URL)
      setTimeout(() => revoke(url), 0)
    }
    const importProfiles = event => {
      const file = event.target.files?.[0]; event.target.value = ''
      if (!file) return
      void perform(async assertCurrent => {
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
    const frozen = plans?.find(plan => plan.sessionId === sessionId)
    let matches = false
    try { matches = selected && JSON.stringify(selected.configuration) === JSON.stringify(current()) } catch {}
    return h('section', { className: 'ptcPlusConfigurationProfiles', 'aria-label': t('capabilities.savedConfigurations') },
      h('h4', null, t('capabilities.savedConfigurations')),
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.configurationsHint')),
      h('div', { className: 'ptcPlusProfileControls' },
        h('label', { className: 'ptcPlusCapabilityFilter' }, h('span', null, t('capabilities.configurationName')),
          h('input', { className: 'ptcPlusInput', value: name, maxLength: 80, disabled: unavailable,
            onChange: event => setName(event.target.value), 'aria-label': t('capabilities.configurationName') })),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: unavailable || !name.trim(), onClick: () => perform(() => save(current())) }, t('capabilities.saveConfiguration')),
        h('label', { className: 'ptcPlusCapabilityFilter' }, h('span', null, t('capabilities.savedConfigurations')),
          h('select', { className: 'ptcPlusSelect', value: selectedId, disabled: unavailable, 'aria-label': t('capabilities.savedConfigurations'),
            onChange: event => { setSelectedId(event.target.value); setName(library.profiles.find(item => item.id === event.target.value)?.name ?? '') } },
          h('option', { value: '' }, t('capabilities.chooseConfiguration')), ...library.profiles.map(profile => h('option', { key: profile.id, value: profile.id }, profile.name)))),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: unavailable || !selected || !onApplyConfiguration,
          onClick: () => perform(() => onApplyConfiguration(selected.configuration)) }, t('capabilities.applyConfiguration')),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: unavailable || !selected || !name.trim(),
          onClick: () => perform(() => saveLibrary(library.profiles.map(profile => profile.id === selected.id ? { ...profile, name: name.trim() } : profile))) }, t('capabilities.renameConfiguration')),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: unavailable || !selected,
          onClick: () => perform(async () => { await saveLibrary(library.profiles.filter(profile => profile.id !== selected.id)); setSelectedId(''); setName('') }) }, t('capabilities.deleteConfiguration')),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: library.profiles.length === 0, onClick: exportProfiles }, t(selected ? 'capabilities.exportConfiguration' : 'capabilities.exportConfigurations')),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: unavailable, onClick: () => fileInput.current.click() }, t('capabilities.importConfigurations')),
        h('input', { ref: fileInput, type: 'file', accept: '.json,application/json', hidden: true, disabled: unavailable, onChange: importProfiles,
          'aria-label': t('capabilities.importConfigurations') })),
      selected ? h('p', { className: 'ptcPlusDetail' }, t(matches ? 'capabilities.configurationMatches' : 'capabilities.configurationDifferent')) : null,
      h('div', { className: 'ptcPlusProfileSessionCopy' }, h('h5', null, t('capabilities.copyFromSession')),
        h('p', { className: 'ptcPlusDetail' }, t('capabilities.copySessionHint')),
        h('select', { className: 'ptcPlusSelect', value: sessionId, disabled: unavailable, 'aria-label': t('capabilities.copyFromSession'), onChange: event => setSessionId(event.target.value) },
          h('option', { value: '' }, t('capabilities.chooseSession')), ...(plans ?? []).map(plan => h('option', { key: plan.sessionId, value: plan.sessionId }, plan.sessionId))),
        h('button', { type: 'button', className: 'ptcPlusButton', disabled: unavailable || !name.trim() || !frozen?.configuration,
          onClick: () => perform(() => save(capabilityProfileConfiguration(frozen.configuration))) }, t('capabilities.saveSessionConfiguration'))),
      status ? h('p', { role: 'status', className: 'ptcPlusMessage' }, status) : null)
  }

  function CapabilityWorkbench({ value, catalog, catalogError, plans, plansError, disabled, onChange, onReload, t, renderField, renderPlans, renderRefresh, id, selectedSessionId, onSessionSelect,
    allocation, allocationError, allocationPending, onApplyConfiguration, configurationWritable }) {
    const [tab, setTab] = React.useState('manual')
    const tabs = ['manual', 'statistics', 'budgets', 'plans']
    return h('div', { className: 'ptcPlusCapabilityWorkbench' },
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.refreshHint')),
      value.capabilityManagementEnabled !== true ? h('p', { className: 'ptcPlusCapabilityNotice' }, t('capabilities.managementOff')) : null,
      renderRefresh?.(),
      h('div', { className: 'ptcPlusCapabilityTabs', role: 'tablist', 'aria-label': t('capabilities.settingsTabs') },
        ...tabs.map((key, index) => h('button', { key, type: 'button', role: 'tab', id: `${id}-tab-${key}`,
          'aria-controls': `${id}-pane-${key}`, 'aria-selected': tab === key, tabIndex: tab === key ? 0 : -1,
          onClick: () => setTab(key), onKeyDown: event => {
            const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
            const next = offset ? (index + offset + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
            if (next === null) return
            event.preventDefault(); setTab(tabs[next])
            event.currentTarget.parentElement.querySelectorAll('[role=tab]')[next].focus({ preventScroll: true })
          } }, t(`capabilities.tab.${key}`)))),
      ...tabs.map(key => h('div', { key, className: 'ptcPlusCapabilityPane', role: 'tabpanel', id: `${id}-pane-${key}`,
        'aria-labelledby': `${id}-tab-${key}`, hidden: tab !== key },
      key === 'manual' ? h(CapabilityChoices, { value, catalog, catalogError, plans, plansError, disabled, onChange, onReload, t, selectedSessionId, onSessionSelect })
        : key === 'statistics' ? h(React.Fragment, null, renderField('capabilityStatistics'), h(AllocationEvidence, { allocation, allocationError, allocationPending, selectedSessionId, statistics: true, onReload, t }))
          : key === 'budgets' ? h(React.Fragment, null, ...['capabilityBudgetBytes', 'capabilityDirectoryBytes', 'capabilityRecoveryBytes', 'modelPreviewTokens'].map(renderField),
            h(AllocationEvidence, { allocation, allocationError, allocationPending, selectedSessionId, onReload, t }))
            : h(React.Fragment, null, h(ConfigurationProfiles, { value, plans, disabled, writable: configurationWritable, onChange, onApplyConfiguration, t }),
              value.capabilityManagementEnabled === true ? renderPlans() : h('p', { className: 'ptcPlusDetail' }, t('capabilities.managementOff'))))))
  }
  return { CapabilityWorkbench }
}

/** Execute a human command through DSH; a receipt never stands in for model publication. */
export function createCapabilityRefreshView(React, commands) {
  const h = React.createElement
  const absent = Object.freeze({ getSnapshot: () => false, subscribe: () => () => {} })
  return function CapabilityRefreshButton({ sessionId, enabled, t, onApplied, onStatus, menu = false }) {
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
    const statusCallback = React.useRef(onStatus)
    statusCallback.current = onStatus
    React.useEffect(() => { if (menu && status) statusCallback.current?.(status) }, [menu, status])
    const cancel = event => {
      event.stopPropagation()
      request.current?.abort(); request.current = null; setPending(false)
      setStatus(t('capabilities.refreshCancelled'))
      onApplied?.()
    }
    const execute = async event => {
      event.stopPropagation()
      if (!enabled || !available || request.current) return
      const controller = new AbortController()
      request.current = controller
      setPending(true)
      setStatus(null)
      try {
        const result = await commands.run(sessionId, 'refresh', controller.signal)
        if (controller.signal.aborted || request.current !== controller) return
        setStatus(result.text ?? t('capabilities.refreshAcknowledged'))
        onApplied?.()
      } catch (error) {
        if (!controller.signal.aborted && request.current === controller) {
          setStatus(t('capabilities.refreshFailed', { error: String(error?.message ?? error) }))
        }
      } finally {
        if (request.current === controller) { request.current = null; setPending(false) }
      }
    }
    return h('div', { className: 'ptcPlusCapabilityRefresh' },
      h('button', { type: 'button', role: menu ? 'menuitem' : undefined,
        className: menu ? 'ptcPlusMenuButton' : 'ptcPlusButton', disabled: !enabled || !available || (!menu && pending),
        title: !available ? t(sessionId ? 'capabilities.refreshUnavailable' : 'capabilities.chooseSession') : undefined,
        onClick: menu && pending ? cancel : execute }, h('span', { className: menu ? 'ptcPlusBindingMenuAction' : undefined },
          t(pending ? menu ? 'capabilities.cancelRefresh' : 'capabilities.refreshing' : 'capabilities.applySession'))),
      pending && !menu ? h('button', { type: 'button', className: 'ptcPlusButton', onClick: cancel }, t('capabilities.cancelRefresh')) : null,
      status && !menu ? h('p', { className: 'ptcPlusDetail', role: 'status' }, status)
        : !available && !menu ? h('p', { className: 'ptcPlusDetail' }, t(sessionId ? 'capabilities.refreshUnavailable' : 'capabilities.chooseSession')) : null)
  }
}
