import { CONFIG_DEFAULTS, CONFIG_FIELDS, CONFIG_GROUPS, CONFIG_MODULES } from '../internal/config-spec.js'
import { resolveConfig } from '../internal/runtime-config.js'
import { featureEnabled } from './client-feature-gates.js'
import { isHostIconComponent } from './client-host-compat.js'

/**
 * Settings card with structured capability controls and one serialized write
 * tail so rapid edits cannot race, plus the manage-bindings
 * action only while global bindings are eligible.
 */
export function createPtcSettingsView(React, deps) {
  const { ActionButton, BindingsDialog, Modal, useWorkbenchController, icons, inspectCapabilityPlans, inspectCapabilityCatalog } = deps
  const h = React.createElement
  const enabledField = CONFIG_FIELDS.find(field => field.key === 'enabled')

  function SectionIcon({ section }) {
    const paths = {
      syntax: ['m8 5-5 5 5 5', 'm16 5 5 5-5 5', 'm14 3-4 14'],
      recovery: ['M3 10a9 9 0 1 1 2.6 8', 'M3 4v6h6', 'M12 7v5l3 2'],
      extensions: ['M9 3H5v6a3 3 0 1 1 0 6v6h6a3 3 0 1 1 6 0h4v-6a3 3 0 1 1 0-6V5h-6a3 3 0 1 0-6-2Z'],
      calls: ['M12 3 3 7v6c0 5 9 8 9 8s9-3 9-8V7l-9-4Z', 'm8 12 3 3 5-6'],
      interface: ['M3 4h18v13H3Z', 'M8 21h8', 'M12 17v4'],
      limits: ['M3 6h5m4 0h9', 'M3 12h11m4 0h3', 'M3 18h3m4 0h11', 'M8 3v6', 'M14 9v6', 'M6 15v6'],
      capabilities: ['M9 3h6', 'M10 3v6L4 19a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2L14 9V3', 'M7 15h10'],
    }
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      className: 'ptcPlusSettingsNavIcon' }, ...paths[section].map((d, key) => h('path', { key, d })))
  }

  function SearchIcon() {
    return isHostIconComponent(icons.search) ? h(icons.search, { size: 16, 'aria-hidden': true })
      : h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
      h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }), h('path', { d: 'm16 16 5 5' }))
  }

  function NavigationArrow() {
    return isHostIconComponent(icons.chevron) ? h(icons.chevron, { size: 12 })
      : h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: 'm6 9 6 6 6-6' }))
  }

  const validStatistics = settings => typeof settings.enabled === 'boolean'
    && Number.isSafeInteger(settings.windowSize) && settings.windowSize >= 1
    && Number.isSafeInteger(settings.minimumSamples) && settings.minimumSamples >= 1 && settings.minimumSamples <= settings.windowSize
    && Number.isFinite(settings.fullThreshold) && settings.fullThreshold >= 0 && settings.fullThreshold <= 1

  function StatisticsSetting({ value, disabled, onChange, t }) {
    const saved = React.useMemo(() => {
      const defaults = JSON.parse(CONFIG_DEFAULTS.capabilityStatistics)
      try {
        const parsed = JSON.parse(value)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError()
        const settings = { ...defaults, ...parsed }
        if (!validStatistics(settings)) throw new TypeError()
        return { settings, invalid: false }
      } catch { return { settings: defaults, invalid: true } }
    }, [value])
    const [draft, setDraft] = React.useState(saved.settings)
    React.useEffect(() => setDraft(saved.settings), [saved])
    const valid = validStatistics(draft)
    const commit = next => {
      if (!validStatistics(next)) return
      const serialized = JSON.stringify({ enabled: next.enabled, windowSize: next.windowSize,
        minimumSamples: next.minimumSamples, fullThreshold: next.fullThreshold })
      if (serialized !== value) onChange(CONFIG_FIELDS.find(field => field.key === 'capabilityStatistics'), serialized)
    }
    const numeric = (key, min, max, scale = 1) => h('label', { className: 'ptcPlusBindingField', key },
      h('span', { className: 'ptcPlusBindingFieldLabel' }, t(`capabilities.${key}`)),
      h('input', { type: 'number', className: 'ptcPlusInput', disabled, min, max, step: scale === 1 ? 1 : 'any',
        value: draft[key] === '' ? '' : scale === 1 ? draft[key] : Number((draft[key] * scale).toFixed(8)), 'aria-label': t(`capabilities.${key}`),
        onChange: event => setDraft(current => ({ ...current, [key]: event.target.value === '' ? '' : Number(event.target.value) / scale })),
        onBlur: () => commit(draft) }))
    return h('div', { className: 'ptcPlusCapabilityStatistics' },
      h('label', { className: 'ptcPlusRow' }, h('span', { className: 'ptcPlusMain' }, t('capabilities.statisticsEnabled')),
        h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', disabled,
          checked: draft.enabled === true, 'aria-label': t('capabilities.statisticsEnabled'),
          onChange: event => {
            // A malformed numeric draft must never make the independent
            // enable/disable switch appear to save while leaving persisted
            // statistics enabled. Restore the last valid numeric tuple when
            // the switch is changed from an invalid draft.
            const next = validStatistics(draft)
              ? { ...draft, enabled: event.target.checked }
              : { ...saved.settings, enabled: event.target.checked }
            setDraft(next)
            commit(next)
          } })),
      h('div', { className: 'ptcPlusBindingFields' }, numeric('windowSize', 1, Number.MAX_SAFE_INTEGER),
        numeric('minimumSamples', 1, Number.MAX_SAFE_INTEGER), numeric('fullThreshold', 0, 100, 100)),
      !valid ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.invalidStatistics'))
        : saved.invalid && draft === saved.settings ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.savedStatisticsInvalid')) : null)
  }

  function CapabilityChoices({ value, catalog, catalogError, plans, disabled, onChange, t }) {
    const [query, setQuery] = React.useState('')
    const baseline = JSON.parse(value.capabilityBaseline ?? CONFIG_DEFAULTS.capabilityBaseline)
    const overrides = JSON.parse(value.capabilityOverrides ?? CONFIG_DEFAULTS.capabilityOverrides)
    const entries = new Map((catalog ?? []).map(entry => [entry.id, entry]))
    for (const plan of plans ?? []) for (const entry of plan.effective.entries) {
      if (!entries.has(entry.id)) entries.set(entry.id, { id: entry.id, category: entry.category })
    }
    for (const id of [...baseline, ...Object.keys(overrides)]) if (!entries.has(id)) entries.set(id, { id })
    const available = new Set((catalog ?? []).map(entry => entry.id))
    const filtered = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id))
      .filter(entry => `${entry.id} ${entry.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    const change = (key, next) => onChange(CONFIG_FIELDS.find(field => field.key === key), JSON.stringify(next))
    return h('div', { className: 'ptcPlusCapabilityChoices' },
      h('div', { className: 'ptcPlusLabel' }, t('capabilityBaseline.label')),
      h('p', { className: 'ptcPlusDetail' }, t('capabilityBaseline.description')),
      h('div', { className: 'ptcPlusLabel' }, t('capabilityOverrides.label')),
      h('p', { className: 'ptcPlusDetail' }, t('capabilityOverrides.description')),
      h('label', { className: 'ptcPlusSearch' }, h(SearchIcon),
        h('input', { type: 'search', value: query, 'aria-label': t('capabilities.search'),
          placeholder: t('capabilities.search'), onChange: event => setQuery(event.target.value) })),
      catalogError ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.catalogUnavailable', { error: catalogError })) : null,
      entries.size === 0 ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.catalogEmpty'))
        : filtered.length === 0 ? h('p', { className: 'ptcPlusDetail' }, t('capabilities.noMatches'))
          : h('div', { className: 'ptcPlusCapabilityList' }, ...filtered.map(entry => h('div', { key: entry.id, className: 'ptcPlusCapabilityItem' },
            h('div', { className: 'ptcPlusMain' }, h('span', { className: 'ptcPlusLabel', title: entry.description }, entry.id),
              catalog !== null && !available.has(entry.id) ? h('div', { className: 'ptcPlusDetail' }, t('capabilities.notAvailable')) : null),
            h('label', { className: 'ptcPlusCapabilityCommon' },
              h('input', { type: 'checkbox', className: 'ptcPlusCheck', disabled: disabled('capabilityBaseline'),
                checked: baseline.includes(entry.id), 'aria-label': t('capabilities.baselineFor', { name: entry.id }),
                onChange: event => change('capabilityBaseline', event.target.checked
                  ? [...baseline.filter(id => id !== entry.id), entry.id] : baseline.filter(id => id !== entry.id)) }),
              t('capabilities.common')),
            h('select', { className: 'ptcPlusSelect', value: overrides[entry.id] ?? 'automatic', disabled: disabled('capabilityOverrides'),
              'aria-label': t('capabilities.disclosureFor', { name: entry.id }),
              onChange: event => { const next = { ...overrides }; if (event.target.value === 'automatic') delete next[entry.id]
                else next[entry.id] = event.target.value; change('capabilityOverrides', next) } },
            ...['automatic', 'full', 'on-demand', 'closed'].map(selection => h('option', { key: selection, value: selection }, t(`capabilities.${selection}`))))))))
  }

  function fieldInput(field, value, disabled, onChange, label) {
    if (field.type === 'boolean') {
      return h('input', {
        type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value === true,
        disabled, 'aria-label': label,
        'data-modal-autofocus': field.key === 'enabled' && !disabled ? true : undefined,
        onChange: event => onChange(field, event.target.checked),
      })
    }
    if (field.type === 'enum') {
      return h('input', {
        type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value !== 'protected',
        disabled, 'aria-label': label,
        onChange: event => onChange(field, event.target.checked ? 'stateful' : 'protected'),
      })
    }
    return h('input', {
      type: 'number', className: 'ptcPlusInput',
      value: Number.isSafeInteger(value) ? String(value) : '',
      min: field.min, max: field.max, step: 1, disabled, 'aria-label': label,
      onChange: event => {
        const input = event.target.value
        const parsed = input === '' ? '' : Number(input)
        onChange(field, Number.isSafeInteger(parsed) ? parsed : input)
      },
    })
  }

  function PTCPlusSettingsCard({ t, usePtcSettings, updateSetting, callUserBindings, view, onBindingsOpenChange }) {
    const [open, setOpen] = React.useState(false)
    const [bindingsOpen, setBindingsOpen] = React.useState(false)
    const bindingsAction = React.useRef(null)
    const settingsRoot = React.useRef(null)
    const [status, setStatus] = React.useState(null)
    const [pending, setPending] = React.useState(() => new Set())
    const [plans, setPlans] = React.useState(null)
    const [plansError, setPlansError] = React.useState(null)
    const [catalog, setCatalog] = React.useState(null)
    const [catalogError, setCatalogError] = React.useState(null)
    const [planRevision, setPlanRevision] = React.useState(0)
    const [activeSection, setActiveSection] = React.useState('syntax')
    const writeTail = React.useRef(Promise.resolve())
    const snapshot = usePtcSettings(snapshot => snapshot)
    const value = snapshot.status === 'ready' ? resolveConfig(snapshot.value ?? {}) : {}
    const legacyKeys = ['looseTopLevelRedeclarations', 'looseTopLevelFunctionClassRedeclarations',
      'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations']
    const legacyMigration = value.legacyBindingSettings === true
    const enabled = featureEnabled(snapshot, 'plugin')
    const globalEnabled = featureEnabled(snapshot, 'bindings')
    const plansEnabled = enabled && value.capabilityManagementEnabled === true
    const planConfiguration = JSON.stringify(CONFIG_FIELDS.filter(field => field.key.startsWith('capability') || field.key === 'modelPreviewTokens')
      .map(field => value[field.key]))
    React.useEffect(() => {
      if (!enabled) {
        setCatalog(null)
        setCatalogError(null)
        return
      }
      if (!(open || view === 'page' || view === 'dialog') || !inspectCapabilityCatalog) return
      const controller = new AbortController()
      setCatalogError(null)
      Promise.resolve().then(() => inspectCapabilityCatalog(controller.signal)).then(available => {
        if (controller.signal.aborted) return
        setCatalog(available)
      }, error => {
        if (controller.signal.aborted) return
        setCatalog(null)
        setCatalogError(String(error?.message ?? error))
      })
      return () => controller.abort()
    }, [enabled, open, view, planConfiguration, planRevision])
    React.useEffect(() => {
      if (!plansEnabled) {
        setPlans(null)
        setPlansError(null)
        return
      }
      if (!(open || view === 'page' || view === 'dialog') || !inspectCapabilityPlans) return
      const controller = new AbortController()
      setPlansError(null)
      Promise.resolve().then(() => inspectCapabilityPlans(controller.signal)).then(next => {
        if (!controller.signal.aborted) setPlans(next)
      }, error => {
        if (!controller.signal.aborted) setPlansError(String(error?.message ?? error))
      })
      return () => controller.abort()
    }, [plansEnabled, open, view, planConfiguration, planRevision])
    const groupIdPrefix = view === 'dialog' ? 'ptc-plus-settings-dialog-group' : 'ptc-plus-settings-group'
    // The open dialog owns the management session: closing it releases the draft
    // and drops every response the host has not answered yet.
    const workbench = useWorkbenchController({ enabled: globalEnabled && bindingsOpen, callUserBindings })
    const setBindingsDialogOpen = next => {
      setBindingsOpen(next)
      onBindingsOpenChange?.(next)
    }
    React.useEffect(() => {
      if (!globalEnabled) setBindingsDialogOpen(false)
    }, [globalEnabled])
    const unavailable = snapshot.status !== 'ready' || snapshot.writable !== true
    const persist = (field, nextValue) => {
      if (unavailable || pending.has(field.key)) return
      const operation = writeTail.current.then(async () => {
        setPending(current => new Set(current).add(field.key))
        setStatus(null)
        try {
          const key = await updateSetting(field.key, nextValue)
          if (key !== null) setStatus({ key })
        } catch (error) {
          setStatus({
            key: 'status.failed',
            params: { error: error instanceof Error ? error.message : String(error) },
          })
        } finally {
          setPending(current => {
            const next = new Set(current)
            next.delete(field.key)
            return next
          })
        }
      })
      writeTail.current = operation.catch(() => {})
    }
    const fieldDisabled = field => unavailable
      || pending.has(field.key)
      || (field.key !== 'enabled' && !enabled)
    const renderField = key => {
      const field = CONFIG_FIELDS.find(candidate => candidate.key === key)
      if (field === undefined) return null
      if (field.key === 'capabilityOverrides') return null
      if (field.key === 'capabilityBaseline') return h(CapabilityChoices, { key, value, catalog, catalogError, t,
        disabled: key => fieldDisabled({ key }), onChange: persist, plans: plansEnabled ? plans : null })
      if (field.key === 'capabilityStatistics') return h('div', { key },
        h('div', { className: 'ptcPlusLabel' }, t(`${key}.label`)),
        h('p', { className: 'ptcPlusDetail' }, t(`${key}.description`)),
        h(StatisticsSetting, { value: value[key] ?? CONFIG_DEFAULTS[key], disabled: fieldDisabled(field), onChange: persist, t }))
      const migratingPolicy = field.key === 'bindingUpdates' && legacyMigration
      return h(React.Fragment, { key: field.key },
        h('div', { className: 'ptcPlusRow' },
          h('div', { className: 'ptcPlusMain' },
            h('div', { className: 'ptcPlusLabel' }, t(`${field.key}.label`)),
            field.description === '' ? null : h('div', { className: 'ptcPlusDetail' },
              t(migratingPolicy ? 'bindingPolicy.migrationDescription' : `${field.key}.description`))),
          migratingPolicy
            ? h('select', {
              className: 'ptcPlusSelect', value: 'legacy', disabled: fieldDisabled(field),
              'aria-label': t(`${field.key}.label`),
              onChange: event => persist(field, event.target.value),
            },
            h('option', { value: 'legacy', disabled: true }, t('bindingPolicy.legacy')),
            ...field.options.map(policy => h('option', { key: policy, value: policy }, t(`bindingPolicy.${policy}`))))
            : fieldInput(field, value[field.key], fieldDisabled(field), persist, t(`${field.key}.label`))),
        field.key === 'userBindingsEnabled' && globalEnabled
          ? h('div', { className: 'ptcPlusSettingAction', ref: bindingsAction },
            h(ActionButton, { type: 'button', className: 'ptcPlusButton', onClick: () => setBindingsDialogOpen(true) }, t('bindings.manage')))
          : null)
    }
    const renderPlans = () => plansEnabled && inspectCapabilityPlans ? h('section', { className: 'ptcPlusCapabilityPlans',
      'aria-labelledby': `${groupIdPrefix}-plans` },
      h('h4', { id: `${groupIdPrefix}-plans`, className: 'ptcPlusGroupTitle' }, t('capabilities.sessions')),
      h(ActionButton, { type: 'button', disabled: !enabled, onClick: () => setPlanRevision(current => current + 1) }, t('capabilities.reload')),
      h('p', { className: 'ptcPlusDetail' }, t('capabilities.refreshHint')),
      plansError ? h('p', { role: 'status' }, t('capabilities.unavailable', { error: plansError }))
        : plans === null ? h('p', null, t('state.syncing'))
          : plans.length === 0 ? h('p', null, t('capabilities.empty'))
            : plans.map(plan => h('details', { key: plan.sessionId },
              h('summary', null, `${plan.sessionId} · ${t(plan.pendingRefresh ? 'capabilities.pending' : 'capabilities.current')}`),
              h('p', null, t('capabilities.budget', { bytes: plan.effective.budgets.contractBytes, overage: plan.effective.budgets.overageBytes })),
              h('table', null, h('thead', null, h('tr', null,
                ...['member', 'selection', 'reason', 'coverage'].map(key => h('th', { key }, t(`capabilities.${key}`))))),
              h('tbody', null, ...plan.effective.entries.map(entry => h('tr', { key: entry.id },
                h('td', null, entry.id), h('td', null, entry.selection),
                h('td', null, [entry.reason, entry.statisticsReason].filter(Boolean).join(' · ')),
                h('td', null, entry.evidence ? `${entry.evidence.used}/${entry.evidence.eligible} (${entry.evidence.scope})` : '—')))))))) : null

    const renderGroup = group => {
      const fields = group.key === 'syntax' && legacyMigration
        ? [...group.fields, ...legacyKeys]
        : group.fields
      return h('section', {
        key: group.key,
        className: 'ptcPlusGroup',
        'data-experimental': group.key === 'capabilities' ? 'true' : undefined,
        'aria-labelledby': `${groupIdPrefix}-${group.key}`,
      },
      h('h3', {
        id: `${groupIdPrefix}-${group.key}`,
        className: 'ptcPlusGroupTitle',
        'data-experimental-label': group.key === 'capabilities' ? t('settings.experimental') : undefined,
      }, t(`group.${group.key}`)),
      ...fields.map(renderField), group.key === 'capabilities' ? renderPlans() : null)
    }

    const settingsFields = navigable => [
      navigable ? null : renderGroup(CONFIG_GROUPS[0]),
      ...CONFIG_MODULES.map(module => h('section', {
        key: module.key, className: 'ptcPlusSettingsModule',
        'aria-labelledby': `${groupIdPrefix}-module-${module.key}`,
      }, h('h2', { id: `${groupIdPrefix}-module-${module.key}`, className: 'ptcPlusSettingsModuleTitle' }, t(`module.${module.key}`)),
      ...module.groups.map(key => renderGroup(CONFIG_GROUPS.find(group => group.key === key))))),
    ]

    const settingsBody = (expanded, id) => {
      const navigable = view === 'page' || view === 'dialog'
      const revealSection = key => {
        const id = `${groupIdPrefix}-${key}`
        const root = settingsRoot.current
        const heading = root?.querySelector(`[id="${id}"]`)
        const scroller = root?.querySelector('.ptcPlusFields')
        if (!heading || !scroller) return
        const headingBounds = heading.getBoundingClientRect()
        const inset = Math.min(16, Math.max(0, scroller.clientHeight - headingBounds.height))
        scroller.scrollTop += headingBounds.top
          - scroller.getBoundingClientRect().top - scroller.clientTop - inset
        setActiveSection(key)
      }
      const trackSection = event => {
        const scroller = event.currentTarget
        const threshold = scroller.getBoundingClientRect().top + scroller.clientTop + 20
        let next = 'syntax'
        for (const group of CONFIG_GROUPS.slice(1)) {
          const heading = scroller.querySelector(`[id="${groupIdPrefix}-${group.key}"]`)
          if (heading && heading.getBoundingClientRect().top <= threshold) next = group.key
        }
        setActiveSection(next)
      }
      const revealNavigationItem = element => {
        const scroller = element.closest('.ptcPlusSettingsNavList')
        if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return
        const item = element.getBoundingClientRect()
        const clip = scroller.getBoundingClientRect()
        if (item.right > clip.right) scroller.scrollLeft += item.right - clip.right
        else if (item.left < clip.left) scroller.scrollLeft += item.left - clip.left
      }
      const navigation = navigable ? h('nav', {
        className: 'ptcPlusSettingsNav',
        'aria-label': t('settings.navigation'),
      },
      h('div', { className: 'ptcPlusSettingsNavIntro' },
        h('label', { className: 'ptcPlusSettingsTitleSwitch', 'data-disabled': fieldDisabled(enabledField) },
          h('strong', null, t('settings.navigationTitle')),
          fieldInput(enabledField, enabled, fieldDisabled(enabledField), persist, t('enabled.label'))),
        h('p', null, t('settings.navigationHint'))),
      h('div', { className: 'ptcPlusSettingsNavList' }, ...CONFIG_MODULES.map(module => h('div', {
        key: module.key, className: 'ptcPlusSettingsNavModule',
      }, h('span', { className: 'ptcPlusSettingsNavModuleTitle' }, t(`module.${module.key}`)),
      h('div', { className: 'ptcPlusSettingsNavModuleItems' }, ...module.groups.map(key => {
        const group = CONFIG_GROUPS.find(group => group.key === key)
        return h('button', {
          key, type: 'button', className: 'ptcPlusSettingsNavItem', 'data-section': key,
          'data-experimental': key === 'capabilities' ? 'true' : undefined, title: t(`group.${group.key}`),
          'aria-current': activeSection === key ? 'location' : undefined,
          onClick: () => revealSection(key), onFocus: event => revealNavigationItem(event.currentTarget),
        }, h(SectionIcon, { section: key }),
        h('span', { className: 'ptcPlusSettingsNavLabel' }, t(`group.${group.key}`)),
        key === 'capabilities' ? h('span', { className: 'ptcPlusSettingsNavBadge' }, t('settings.experimental')) : null,
        h('span', { className: 'ptcPlusSettingsNavArrow', 'aria-hidden': true }, h(NavigationArrow)))
      })))))) : null
      return h('div', {
      id, ref: settingsRoot, className: 'ptcPlusBody', 'data-open': expanded, hidden: !expanded,
    },
    h('div', { className: 'ptcPlusBodyInner' },
      h('div', { className: navigable ? 'ptcPlusSettingsLayout' : undefined },
        navigation,
        h('div', { className: 'ptcPlusFields', onScroll: navigable ? trackSection : undefined },
      snapshot.status === 'loading'
        ? h('p', { className: 'ptcPlusMessage' }, t('state.syncing'))
        : snapshot.status === 'unavailable'
          ? h('p', { className: 'ptcPlusMessage' }, t('state.unavailable'))
          : [
            ...settingsFields(navigable),
            h('div', { key: 'footer', className: 'ptcPlusFooter' },
              h('span', { className: 'ptcPlusMessage', role: 'status' }, status === null
                ? t(snapshot.writable ? 'footer.live' : 'footer.readOnly')
                : t(status.key, status.params))),
          ]))))
    }
    const openBindings = globalEnabled && bindingsOpen
      ? h(BindingsDialog, {
        controller: workbench, t, onClose: () => setBindingsDialogOpen(false),
        getReturnFocus: () => bindingsAction.current?.querySelector('button'),
      }) : null
    // A seat that asks for views renders one entry twice: `summary` is the
    // one-liner under the title the seat draws, `page` is the form it mounts
    // with its own save control (the form already writes on change). The legacy
    // card seat asks for neither and keeps the whole collapsible card.
    if (view === 'summary') return h('span', { className: 'ptcPlusDescription' }, t('card.description'))
    if (view === 'page') return h('div', { className: 'ptcPlusCard ptcPlusSettingsPage' }, settingsBody(true), openBindings)
    if (view === 'dialog') return h(React.Fragment, null, settingsBody(true), openBindings)
    return h('li', { className: 'ptcPlusCard' },
      h('button', {
        type: 'button', className: 'ptcPlusHeader', 'aria-expanded': open,
        'aria-label': t(open ? 'action.collapse' : 'action.expand'),
        'aria-controls': 'ptc-plus-settings-body', onClick: () => setOpen(current => !current),
      },
      h('span', { className: 'ptcPlusHeadText' },
        h('span', { className: 'ptcPlusName' }, 'PTC Plus'),
        h('span', { className: 'ptcPlusDescription' }, t('card.description'))),
      h('span', { className: 'ptcPlusStatus', 'data-enabled': enabled }, t(enabled ? 'status.enabled' : 'status.disabled')),
      h('span', { className: 'ptcPlusChevron', 'data-open': open, 'aria-hidden': true }, h(icons.chevron, { size: 14 }))),
      settingsBody(open, 'ptc-plus-settings-body'),
      openBindings,
    )
  }

  function PTCPlusSettingsDialog(props) {
    const { t, onClose } = props
    const [bindingsOpen, setBindingsOpen] = React.useState(false)
    const close = () => {
      if (!bindingsOpen) onClose()
    }
    return h(Modal, {
      open: true,
      onClose: close,
      title: t('settings.dialogTitle'),
      closeLabel: t('settings.close'),
      headless: true,
      className: 'ptcPlusSettingsModal',
    }, h('div', { className: 'ptcPlusSettingsDialogHead' },
      h('div', null, h('h2', null, t('settings.dialogTitle')), h('p', null, t('card.description'))),
      h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': t('settings.close'), onClick: close }, '\u00d7')),
    h('div', { className: 'ptcPlusSettingsDialogContent' }, h('div', { className: 'ptcPlusSettingsDialog' },
      h(PTCPlusSettingsCard, { ...props, view: 'dialog', onBindingsOpenChange: setBindingsOpen }))))
  }

  return { PTCPlusSettingsCard, PTCPlusSettingsDialog }
}
