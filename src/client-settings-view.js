import { CONFIG_DEFAULTS, CONFIG_FIELDS, CONFIG_GROUPS, CONFIG_MODULES } from '../internal/config-spec.js'
import { CAPABILITY_CONFIGURATION_KEYS, capabilityProfileConfiguration, resolveConfig } from '../internal/runtime-config.js'
import { featureEnabled } from './client-feature-gates.js'
import { isHostIconComponent } from './client-host-compat.js'
import { capabilityPlanReason, createCapabilitySettingsViews } from './client-capabilities-view.js'

// DOM integer dimensions lose fractional pixels under zoom. Convert viewport
// positions using the resolved CSS border box, shared by tracking and reveal.
function settingsScrollGeometry(element) {
  const bounds = element.getBoundingClientRect()
  const style = element.ownerDocument.defaultView.getComputedStyle(element)
  const number = value => Number.parseFloat(value) || 0
  const borderTop = number(style.borderTopWidth), borderBottom = number(style.borderBottomWidth)
  const cssHeight = number(style.height) + (style.boxSizing === 'border-box' ? 0
    : number(style.paddingTop) + number(style.paddingBottom) + borderTop + borderBottom)
  const scale = cssHeight > 0 ? bounds.height / cssHeight : 1
  return { bounds, scale, top: bounds.top + borderTop * scale,
    bottom: bounds.bottom - borderBottom * scale, borderTop }
}

/**
 * Settings card with structured capability controls and one serialized write
 * tail so rapid edits cannot race, plus the manage-bindings
 * action only while global bindings are eligible.
 */
export function createPtcSettingsView(React, deps) {
  const { ActionButton, BindingsDialog, Modal, Select, useWorkbenchController, icons, inspectCapabilityPlans, inspectCapabilityCatalog,
    inspectCapabilityTargets, inspectCapabilityAllocation, CapabilityRefreshButton } = deps
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
      h('section', { className: 'ptcPlusStatisticsParameters', 'aria-label': t('capabilities.statisticsSettings') },
        h('h5', null, t('capabilities.statisticsSettings')),
        h('div', { className: 'ptcPlusBindingFields' }, numeric('windowSize', 1, Number.MAX_SAFE_INTEGER),
          numeric('minimumSamples', 1, Number.MAX_SAFE_INTEGER), numeric('fullThreshold', 0, 100, 100))),
      !valid ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.invalidStatistics'))
        : saved.invalid && draft === saved.settings ? h('p', { role: 'status', className: 'ptcPlusMessage' }, t('capabilities.savedStatisticsInvalid')) : null)
  }

  const { CapabilityWorkbench } = createCapabilitySettingsViews(React, { SearchIcon, Select, Modal })

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

  function PTCPlusSettingsCard({ t, usePtcSettings, updateSetting, updateCapabilityConfiguration, callUserBindings, view, onBindingsOpenChange }) {
    const [open, setOpen] = React.useState(false)
    const [bindingsOpen, setBindingsOpen] = React.useState(false)
    const bindingsAction = React.useRef(null)
    const settingsRoot = React.useRef(null)
    const [status, setStatus] = React.useState(null)
    const [capabilityStatus, setCapabilityStatus] = React.useState(null)
    const [pending, setPending] = React.useState(() => new Set())
    const [plans, setPlans] = React.useState(null)
    const [plansError, setPlansError] = React.useState(null)
    const [plansPending, setPlansPending] = React.useState(false)
    const [plansObservedConfiguration, setPlansObservedConfiguration] = React.useState(null)
    const [catalog, setCatalog] = React.useState(null)
    const [catalogError, setCatalogError] = React.useState(null)
    const [planRevision, setPlanRevision] = React.useState(0)
    const [targets, setTargets] = React.useState(null)
    const [targetsError, setTargetsError] = React.useState(null)
    const [refreshSessionId, setRefreshSessionId] = React.useState('')
    const [allocation, setAllocation] = React.useState(null)
    const [allocationError, setAllocationError] = React.useState(null)
    const [allocationPending, setAllocationPending] = React.useState(false)
    const [activeSection, setActiveSection] = React.useState('syntax')
    const writeTail = React.useRef(Promise.resolve())
    const snapshot = usePtcSettings(snapshot => snapshot)
    const value = snapshot.status === 'ready' ? resolveConfig(snapshot.value ?? {}) : {}
    const legacyKeys = ['looseTopLevelRedeclarations', 'looseTopLevelFunctionClassRedeclarations',
      'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations']
    const legacyMigration = value.legacyBindingSettings === true
    const enabled = featureEnabled(snapshot, 'plugin')
    const globalEnabled = featureEnabled(snapshot, 'bindings')
    const plansEnabled = enabled
    const planConfiguration = JSON.stringify(CONFIG_FIELDS.filter(field => CAPABILITY_CONFIGURATION_KEYS.includes(field.key))
      .map(field => value[field.key]))
    const allocationConfiguration = JSON.stringify(Object.fromEntries(CAPABILITY_CONFIGURATION_KEYS.map(key => [key, value[key]])))
    React.useEffect(() => {
      setAllocation(null); setAllocationError(null); setAllocationPending(false)
      if (!enabled || !refreshSessionId || !inspectCapabilityAllocation || !(open || view === 'page' || view === 'dialog')) return
      const controller = new AbortController()
      setAllocationPending(true)
      Promise.resolve().then(() => inspectCapabilityAllocation({ sessionId: refreshSessionId,
        configuration: JSON.parse(allocationConfiguration) }, controller.signal)).then(result => {
        if (!controller.signal.aborted) { setAllocation(result); setAllocationPending(false) }
      }, error => {
        if (!controller.signal.aborted) { setAllocationError(String(error?.message ?? error)); setAllocationPending(false) }
      })
      return () => controller.abort()
    }, [enabled, open, view, refreshSessionId, allocationConfiguration, planRevision])
    React.useEffect(() => {
      if (!enabled) { setTargets(null); setTargetsError(null); setRefreshSessionId(''); return }
      if (!(open || view === 'page' || view === 'dialog') || !inspectCapabilityTargets) return
      const controller = new AbortController()
      setTargetsError(null)
      Promise.resolve().then(() => inspectCapabilityTargets(controller.signal)).then(next => {
        if (controller.signal.aborted) return
        setTargets(next)
        setRefreshSessionId(current => next.some(target => target.sessionId === current)
          || plans?.some(plan => plan.sessionId === current) ? current : '')
      }, error => {
        if (!controller.signal.aborted) setTargetsError(String(error?.message ?? error))
      })
      return () => controller.abort()
    }, [enabled, open, view, planRevision])
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
        setCatalogError(String(error?.message ?? error))
      })
      return () => controller.abort()
    }, [enabled, open, view, planConfiguration, planRevision])
    React.useEffect(() => {
      if (!plansEnabled) {
        setPlans(null)
        setPlansError(null)
        setPlansPending(false)
        setPlansObservedConfiguration(null)
        return
      }
      if (!(open || view === 'page' || view === 'dialog') || !inspectCapabilityPlans) return
      const controller = new AbortController()
      setPlansError(null)
      setPlansPending(true)
      Promise.resolve().then(() => inspectCapabilityPlans(controller.signal)).then(next => {
        if (!controller.signal.aborted) {
          setPlans(next); setPlansPending(false); setPlansObservedConfiguration(planConfiguration)
        }
      }, error => {
        if (!controller.signal.aborted) { setPlansError(String(error?.message ?? error)); setPlansPending(false) }
      })
      return () => controller.abort()
    }, [plansEnabled, open, view, planConfiguration, planRevision])
    const groupIdPrefix = view === 'dialog' ? 'ptc-plus-settings-dialog-group' : 'ptc-plus-settings-group'
    const trackSection = React.useCallback((preserveFocus = false) => {
      const scroller = settingsRoot.current?.querySelector('.ptcPlusFields')
      if (!scroller || scroller.clientHeight === 0) return
      const { scale, top, bottom } = settingsScrollGeometry(scroller)
      const sections = CONFIG_GROUPS.slice(1).map(group => ({ key: group.key,
        bounds: scroller.querySelector(`[aria-labelledby="${groupIdPrefix}-${group.key}"]`)?.getBoundingClientRect() }))
        .filter(section => section.bounds)
      const visible = sections.filter(section => section.bounds.bottom > top && section.bounds.top < bottom)
      const atEnd = scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
      const focusedControl = preserveFocus === true ? scroller.ownerDocument.activeElement : null
      const focusedBounds = focusedControl?.getBoundingClientRect()
      const focusedGroup = focusedBounds && focusedBounds.bottom > top && focusedBounds.top < bottom
        ? focusedControl.closest('.ptcPlusGroup')?.getAttribute('aria-labelledby') : null
      const focused = visible.find(section => focusedGroup === `${groupIdPrefix}-${section.key}`)
      const next = focused ?? (atEnd ? visible.at(-1) : visible.find(section => section.bounds.bottom > top + 20 * scale))
      if (next) setActiveSection(next.key)
    }, [groupIdPrefix])
    React.useLayoutEffect(() => {
      if (!(view === 'page' || view === 'dialog') || !settingsRoot.current) return
      const scroller = settingsRoot.current.querySelector('.ptcPlusFields')
      if (!scroller) return
      trackSection()
      const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => trackSection(true)) : null
      resize?.observe(scroller)
      for (const section of scroller.querySelectorAll('.ptcPlusSettingsModule,.ptcPlusGroup')) resize?.observe(section)
      const changes = typeof MutationObserver === 'function' ? new MutationObserver(() => trackSection(true)) : null
      changes?.observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open'] })
      globalThis.addEventListener?.('resize', trackSection)
      return () => { resize?.disconnect(); changes?.disconnect(); globalThis.removeEventListener?.('resize', trackSection) }
    }, [view, open, snapshot.status, trackSection])
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
    const isCapabilityField = key => CAPABILITY_CONFIGURATION_KEYS.includes(key)
      || ['capabilityProfiles', 'capabilityConfiguration'].includes(key)
    const recordStatus = next => {
      setStatus(next)
      if (isCapabilityField(next.fieldKey)) setCapabilityStatus(next)
    }
    const persist = (field, nextValue) => {
      if (unavailable || pending.has(field.key)) return
      const operation = writeTail.current.then(async () => {
        setPending(current => new Set(current).add(field.key))
        setStatus(null)
        if (isCapabilityField(field.key)) setCapabilityStatus(null)
        try {
          const key = await updateSetting(field.key, nextValue)
          if (key !== null) recordStatus({ key, fieldKey: field.key })
          return key === 'status.applied' || (key === null && value[field.key] === nextValue)
        } catch (error) {
          recordStatus({
            key: 'status.failed',
            fieldKey: field.key,
            params: { error: error instanceof Error ? error.message : String(error) },
          })
          return false
        } finally {
          setPending(current => {
            const next = new Set(current)
            next.delete(field.key)
            return next
          })
        }
      })
      writeTail.current = operation.catch(() => {})
      return operation
    }
    const persistConfiguration = configuration => {
      if (unavailable || !enabled || !updateCapabilityConfiguration) return Promise.reject(new Error(t('capabilities.configurationUnavailable')))
      const validated = capabilityProfileConfiguration(configuration)
      const operation = writeTail.current.then(async () => {
        setPending(current => new Set([...current, ...CAPABILITY_CONFIGURATION_KEYS]))
        setCapabilityStatus(null)
        try {
          const key = await updateCapabilityConfiguration(validated)
          recordStatus({ key: key ?? 'status.applied', fieldKey: 'capabilityConfiguration' })
          setPlanRevision(current => current + 1)
        } catch (error) {
          recordStatus({ key: 'status.failed', fieldKey: 'capabilityConfiguration',
            params: { error: error instanceof Error ? error.message : String(error) } })
          throw error
        } finally { setPending(current => new Set([...current].filter(key => !CAPABILITY_CONFIGURATION_KEYS.includes(key)))) }
      })
      writeTail.current = operation.catch(() => {})
      return operation
    }
    const fieldDisabled = field => unavailable
      || pending.has(field.key)
      || (field.key !== 'enabled' && !enabled)
    const renderField = key => {
      const field = CONFIG_FIELDS.find(candidate => candidate.key === key)
      if (field === undefined) return null
      if (['capabilityOverrides', 'capabilityPolicy'].includes(field.key)) return null
      if (field.key === 'capabilityBaseline') return null
      if (field.key === 'capabilityProfiles') return null
      if (field.key === 'capabilityStatistics') return h('div', { key },
        h(StatisticsSetting, { value: value[key] ?? CONFIG_DEFAULTS[key], disabled: fieldDisabled(field), onChange: persist, t }))
      const migratingPolicy = field.key === 'bindingUpdates' && legacyMigration
      return h(React.Fragment, { key: field.key },
        h('div', { className: 'ptcPlusRow' },
          h('div', { className: 'ptcPlusMain' },
            h('div', { className: 'ptcPlusLabel' }, t(`${field.key}.label`)),
            field.description === '' ? null : h('div', { className: 'ptcPlusDetail' },
              t(migratingPolicy ? 'bindingPolicy.migrationDescription' : `${field.key}.description`))),
          migratingPolicy
            ? h(Select, { value: 'legacy', disabled: fieldDisabled(field), label: t(`${field.key}.label`),
              options: [{ value: 'legacy', label: t('bindingPolicy.legacy'), disabled: true },
                ...field.options.map(policy => ({ value: policy, label: t(`bindingPolicy.${policy}`) }))],
              onChange: next => persist(field, next) })
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
            : plans.filter(plan => plan.sessionId === refreshSessionId).map(plan => h('details', { key: plan.sessionId },
              h('summary', { tabIndex: 0 }, `${plan.sessionId} · ${t('capabilities.combination.lastRead')}`),
              h('p', { className: 'ptcPlusDetail' }, t('capabilities.frozenHint')),
              h('p', null, t('capabilities.budget', { bytes: plan.effective.budgets.contractBytes, overage: plan.effective.budgets.overageBytes })),
              h('table', null, h('thead', null, h('tr', null,
                ...['member', 'selection', 'reason', 'coverage'].map(key => h('th', { key }, t(`capabilities.${key}`))))),
              h('tbody', null, ...plan.effective.entries.map(entry => h('tr', { key: entry.id },
                h('td', null, entry.id), h('td', null, t(`capabilities.${entry.selection}`)),
                h('td', null, capabilityPlanReason(t, entry)),
                h('td', null, entry.evidence ? `${entry.evidence.used}/${entry.evidence.eligible} (${entry.evidence.scope})` : '—')))))))) : null

    const comparisonTargets = targets === null && inspectCapabilityTargets ? null
      : [...new Set([...(targets ?? []).map(target => target.sessionId), ...(plans ?? []).map(plan => plan.sessionId)])]
    const renderRefresh = ({ observation = false } = {}) => CapabilityRefreshButton || inspectCapabilityPlans ? h('section', { className: 'ptcPlusCapabilityApply',
      'aria-label': t(observation ? 'capabilities.observationGroup' : 'capabilities.applyGroup') },
      h('label', { className: `ptcPlusCapabilityFilter${observation ? ' ptcPlusStatisticsObservation' : ''}` },
        observation ? h('span', { className: 'ptcPlusStatisticsObservationHeading' },
          h('span', null, t('capabilities.observationSession')),
          h('span', { className: 'ptcPlusStatisticsObservationHint' }, t('capabilities.selectObservation')))
          : h('span', null, t('capabilities.targetSession')),
        h(Select, { value: refreshSessionId, label: t(observation ? 'capabilities.observationSession' : 'capabilities.targetSession'),
          disabled: !enabled || comparisonTargets === null || Boolean(targetsError), onChange: setRefreshSessionId,
          options: [{ value: '', label: t('capabilities.chooseSession') },
            ...(comparisonTargets ?? []).map(sessionId => ({ value: sessionId, label: sessionId }))] })),
      observation || !CapabilityRefreshButton ? null : h(CapabilityRefreshButton, { sessionId: refreshSessionId, t,
        enabled: enabled && !unavailable && pending.size === 0 && !targetsError
          && (targets ?? []).some(target => target.sessionId === refreshSessionId),
        onInvalidated: () => setPlansObservedConfiguration(null),
        onApplied: () => setPlanRevision(current => current + 1) }),
      targetsError ? h('p', { role: 'status', className: 'ptcPlusDetail' }, t('capabilities.unavailable', { error: targetsError })) : null) : null

    const renderGroup = group => {
      const fields = group.key === 'syntax' && legacyMigration
        ? [...group.fields, ...legacyKeys]
        : group.fields
      const heading = h('h3', {
        id: `${groupIdPrefix}-${group.key}`,
        className: 'ptcPlusGroupTitle',
        'data-experimental-label': group.key === 'capabilities' ? t('settings.experimental') : undefined,
      }, t(`group.${group.key}`))
      return h('section', {
        key: group.key,
        className: 'ptcPlusGroup',
        'data-experimental': group.key === 'capabilities' ? 'true' : undefined,
        'aria-labelledby': `${groupIdPrefix}-${group.key}`,
      },
      group.key === 'capabilities' ? h('div', { className: 'ptcPlusCapabilityHead' }, heading,
        h('label', { className: 'ptcPlusCapabilityManagement' },
          h('span', { role: 'status' }, t(value.capabilityContextEnabled === false ? 'capabilities.groupPaused' : 'capabilities.serverOn')),
          h('input', { type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value.capabilityContextEnabled !== false,
            disabled: fieldDisabled({ key: 'capabilityContextEnabled' }), 'aria-label': t('group.capabilities'),
            onChange: event => persist(CONFIG_FIELDS.find(field => field.key === 'capabilityContextEnabled'), event.target.checked) }))) : heading,
      ...(group.key === 'capabilities' ? [
        h(CapabilityWorkbench, { key: 'capability-workbench', id: `${groupIdPrefix}-capability-workbench`,
          value, configurationReady: snapshot.status === 'ready', catalog, catalogError, plans: plansEnabled ? plans : null, plansError, plansPending,
          plansStale: plansObservedConfiguration !== planConfiguration,
          disabled: key => fieldDisabled({ key }), onChange: persist,
          onReload: () => setPlanRevision(current => current + 1), t, renderField, renderPlans, renderRefresh,
          selectedSessionId: refreshSessionId, onSessionSelect: setRefreshSessionId,
          allocation, allocationError, allocationPending, saving: [...pending].some(key => CAPABILITY_CONFIGURATION_KEYS.includes(key) || key === 'capabilityProfiles'), saveStatus: capabilityStatus, configurationWritable: !unavailable && enabled, onApplyConfiguration: updateCapabilityConfiguration ? persistConfiguration : undefined })]
        : fields.map(renderField)))
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
        const { bounds: scrollerBounds, scale, borderTop } = settingsScrollGeometry(scroller)
        const inset = Math.min(16, Math.max(0, scroller.clientHeight - headingBounds.height / scale))
        scroller.scrollTop += (headingBounds.top - scrollerBounds.top) / scale - borderTop - inset
        setActiveSection(key)
        trackSection()
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
        h('div', { className: 'ptcPlusFields', onScroll: navigable ? () => trackSection(true) : undefined },
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
