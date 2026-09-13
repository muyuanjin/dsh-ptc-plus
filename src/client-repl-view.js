/**
 * REPL surface views: the conversation tab (session bindings + global workbench)
 * and the header memory card. Every piece here is a pure projection of props,
 * session projections and settings; the entry owns registration and transport.
 */
export function createReplView(React, deps) {
  const {
    CodeBlock, featureEnabled, normalizeReplMemorySnapshot,
    unavailableReplMemorySnapshot, useSessionPreset, sessionUsesPtcPreset,
    useWorkbenchController, UserBindingsWorkbench,
    icons: { search: IconSearchOutline16, chevron: IconChevronDownOutline14 },
  } = deps
  const h = React.createElement

  function ReplComposer() { return null }

  function ReplBindingInspector({ entry, preview, t }) {
    const readable = preview?.status === 'readable'
    return h('aside', { className: 'ptcPlusBindingInspector', 'aria-label': entry.name },
      h('header', { className: 'ptcPlusInspectorHead' },
        h('strong', null, entry.name),
        h('span', null, t('memory.location', entry.definition))),
      h('div', { className: 'ptcPlusObservationLabel' }, t('console.definition')),
      typeof CodeBlock === 'function'
        ? h(CodeBlock, { code: entry.definition.source, lang: 'typescript', className: 'ptcPlusObservationCode',
            copyLabel: t('tool.copy'), copiedLabel: t('tool.copied') })
        : h('pre', { className: 'ptcPlusObservationCode' }, entry.definition.source),
      h('div', { className: 'ptcPlusObservationLabel' }, t('console.value'),
        preview?.truncated ? h('span', { className: 'ptcPlusObservationState' }, t('console.bounded')) : null),
      readable ? h('pre', { className: 'ptcPlusObservationPreview' }, preview.text)
        : h('p', { className: 'ptcPlusObservationUnavailable' }, t(preview === undefined ? 'console.unobservedValue' : 'console.unreadable')))
  }

  function ReplSessionBindings({ memory, t }) {
    const [query, setQuery] = React.useState('')
    const [kind, setKind] = React.useState('all')
    const [selectedName, setSelectedName] = React.useState(null)
    const entries = memory.entries.filter(entry => (kind === 'all' || entry.kind === kind)
      && entry.name.toLowerCase().includes(query.trim().toLowerCase()))
    const selected = entries.find(entry => entry.name === selectedName) ?? entries[0]
    const observation = memory.observation
    const previews = new Map(observation?.entries.map(entry => [entry.name, entry]) ?? [])
    return h('section', { className: 'ptcPlusConsoleSection ptcPlusSessionBindings', 'aria-label': t('console.session') },
      h('div', { className: 'ptcPlusObservationHead' },
        h('div', { className: 'ptcPlusObservationTitle' },
          h('h2', null, t('console.session')),
          memory.available ? h('span', { className: 'ptcPlusObservationCount', title: t('memory.count', { count: memory.total }) },
            query.trim() || kind !== 'all' ? `${entries.length} / ${memory.total}` : memory.total) : null,
          memory.available ? h('span', { className: 'ptcPlusObservationReuseTotal', title: t('memory.reuseHint') },
            t('memory.reuseTotal', { count: memory.reuseTotal })) : null),
        h('span', { className: 'ptcPlusObservationTime' }, observation === undefined
          ? t('console.unobserved') : t('console.observed', { time: new Date(observation.at).toLocaleString() }))),
      memory.entries.length === 0 ? h('div', { className: 'ptcPlusSessionEmpty' },
        t(memory.available ? 'memory.empty' : 'memory.unavailable'))
        : h('div', { className: 'ptcPlusObservationGrid', 'data-empty': selected === undefined },
        h('div', { className: 'ptcPlusObservationCatalog' },
          h('div', { className: 'ptcPlusObservationFilters' },
            h('label', { className: 'ptcPlusSearch' },
              typeof IconSearchOutline16 === 'function' ? h(IconSearchOutline16, { size: 16 }) : null,
              h('input', { value: query, onChange: event => setQuery(event.target.value),
                placeholder: t('console.search'), 'aria-label': t('console.search') })),
            h('select', { className: 'ptcPlusSelect', value: kind, onChange: event => setKind(event.target.value),
              'aria-label': t('console.kind') },
              ['all', 'variable', 'function', 'class', 'import'].map(value => h('option', { key: value, value },
                t(value === 'all' ? 'console.allKinds' : `memory.kind.${value}`))))),
          h('div', { className: 'ptcPlusObservations' },
            h('table', { className: 'ptcPlusObservationTable', 'aria-label': t('console.session') },
              h('thead', null, h('tr', null,
                h('th', { scope: 'col' }, t('console.name')),
                h('th', { scope: 'col' }, t('console.kind')),
                h('th', { scope: 'col' }, t('console.reuse')),
                h('th', { scope: 'col' }, t('console.value')))),
              h('tbody', null, entries.map(entry => {
                const preview = previews.get(entry.name)
                return h('tr', { key: entry.name, 'data-selected': entry === selected,
                  onClick: () => setSelectedName(entry.name) },
                  h('td', null, h('button', { type: 'button', className: 'ptcPlusObservationSelect',
                    'aria-current': entry === selected ? 'true' : undefined, title: entry.name }, entry.name)),
                  h('td', { className: 'ptcPlusObservationKind' }, t(`memory.kind.${entry.kind}`)),
                  h('td', { className: 'ptcPlusObservationReuse', title: t('memory.reuseHint') }, entry.reuseCount),
                  h('td', null, h('span', { className: 'ptcPlusObservationValue' },
                    preview?.status === 'readable' ? h('code', null, preview.text)
                      : h('span', { className: 'ptcPlusObservationState' }, t(preview === undefined ? 'console.unobservedValue' : 'console.unreadable')),
                    preview?.truncated ? h('span', { className: 'ptcPlusObservationState' }, t('console.bounded')) : null)))
              }))),
            entries.length === 0 ? h('p', { className: 'ptcPlusMessage ptcPlusObservationEmpty' },
              t(!memory.available ? 'memory.unavailable' : memory.entries.length === 0 ? 'memory.empty' : 'console.noMatches')) : null)),
        selected ? h(ReplBindingInspector, { entry: selected, preview: previews.get(selected.name), t }) : null),
      memory.omitted > 0 ? h('p', { className: 'ptcPlusMessage' }, t('memory.more', { count: memory.omitted })) : null)
  }

  function ReplConsole({ t, sessionId, useProjection, useSessions, usePtcSettings, callUserBindings, hideComposer, observeRepl }) {
    const preset = useSessionPreset({ sessionId, useProjection, useSessions })
    const projected = useProjection('ptcPlusRepl')
    const settings = usePtcSettings(snapshot => snapshot)
    const globalEnabled = featureEnabled(settings, 'bindings')
    const workbench = useWorkbenchController({ enabled: globalEnabled, active: true, callUserBindings })
    const eligible = featureEnabled(settings, 'replView') && sessionUsesPtcPreset(preset)
    const memory = React.useMemo(() => {
      try { return normalizeReplMemorySnapshot(projected) } catch { return unavailableReplMemorySnapshot() }
    }, [projected])
    const [observed, setObserved] = React.useState(null)
    const observationRegion = React.useRef(null)
    React.useEffect(() => eligible ? hideComposer(sessionId) : undefined, [eligible, hideComposer, sessionId])
    React.useEffect(() => eligible ? observeRepl(sessionId, observationRegion.current, memory,
      value => setObserved({ sessionId, source: memory, value })) : undefined, [eligible, observeRepl, sessionId, memory])
    if (!eligible) return null
    return h('div', { className: 'ptcPlusConsole', 'data-conversation-composer-overlay': '' },
      h('div', { className: 'ptcPlusConsoleSection', ref: observationRegion }, h(ReplSessionBindings, {
        key: sessionId, memory: observed?.sessionId === sessionId && observed.source === memory ? observed.value : memory, t })),
      globalEnabled ? h('div', { className: 'ptcPlusConsoleSection ptcPlusBindingsSurface' },
        h(UserBindingsWorkbench, { controller: workbench, t, headingLabel: t('console.global') })) : null)
  }

  function replPopoverIsOpen(popover) {
    if (popover?.dataset?.open === 'true') return true
    try {
      return popover?.matches?.(':popover-open') === true
    } catch {
      return false
    }
  }

  function placeReplPopover(trigger, popover) {
    if (trigger === null || popover === null) return
    const margin = 12
    const gap = 8
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight
    const triggerRect = trigger.getBoundingClientRect()
    const width = Math.min(344, Math.max(0, viewportWidth - margin * 2))
    const left = Math.min(
      Math.max(margin, triggerRect.right - width),
      Math.max(margin, viewportWidth - width - margin),
    )
    const below = Math.max(0, viewportHeight - triggerRect.bottom - gap - margin)
    const above = Math.max(0, triggerRect.top - gap - margin)
    const opensAbove = below < 260 && above > below
    const availableHeight = Math.max(80, opensAbove ? above : below)
    popover.style.width = `${width}px`
    popover.style.maxHeight = `${availableHeight}px`
    popover.style.left = `${left}px`
    popover.style.top = opensAbove
      ? `${Math.max(margin, triggerRect.top - gap - Math.min(popover.offsetHeight, availableHeight))}px`
      : `${Math.min(viewportHeight - margin, triggerRect.bottom + gap)}px`
  }

  function ReplMemoryCard({
    memory,
    globalEnabled,
    globalBindings,
    loadGlobalBinding,
    t,
    id,
    titleId,
    popoverRef,
    onEnter,
    onLeave,
    onGlobalTab,
  }) {
    const [expandedBinding, setExpandedBinding] = React.useState(null)
    const [tab, setTab] = React.useState('session')
    const [globalSource, setGlobalSource] = React.useState(null)
    const activeTab = globalEnabled ? tab : 'session'
    const summary = activeTab === 'session'
      ? memory.available ? `${t('memory.count', { count: memory.total })} · ${t('memory.reuseTotal', { count: memory.reuseTotal })}` : ''
      : globalBindings === undefined ? '' : t('memory.globalCount', { count: globalBindings.entries.length })
    const inspectGlobal = entry => {
      if (globalSource?.id === entry.id) {
        setGlobalSource(null)
        return
      }
      setGlobalSource({ id: entry.id, source: '' })
      loadGlobalBinding(entry.id).then(
        loaded => setGlobalSource(current => current?.id === entry.id
          ? { id: entry.id, source: loaded.entry.source }
          : current),
        () => setGlobalSource(current => current?.id === entry.id
          ? { id: entry.id, error: true, source: '' }
          : current),
      )
    }
    return h('div', {
      // A manual popover owns its lifetime: the trigger toggles it, and the entry
      // that opened it closes it on an outside press or Escape.
      className: 'ptcPlusReplPopover', id, ref: popoverRef, popover: 'manual',
      role: 'dialog', 'aria-labelledby': titleId,
      onPointerEnter: onEnter, onPointerLeave: onLeave,
    },
    h('div', { className: 'ptcPlusReplCard' },
      h('div', { className: 'ptcPlusReplHead' },
        h('span', { className: 'ptcPlusReplStatusDot', 'aria-hidden': true }),
        h('span', { className: 'ptcPlusReplTitle', id: titleId }, t('memory.title')),
        h('span', {
          className: 'ptcPlusReplSummary',
          'aria-hidden': summary === '' ? true : undefined,
        }, summary)),
      globalEnabled
        ? h('div', { className: 'ptcPlusReplTabs', role: 'tablist' },
            h('button', {
              type: 'button', role: 'tab', className: 'ptcPlusReplTab',
              'aria-selected': activeTab === 'session', onClick: () => setTab('session'),
            }, t('memory.sessionTab')),
            h('button', {
              type: 'button', role: 'tab', className: 'ptcPlusReplTab',
              'aria-selected': activeTab === 'global',
              onClick: () => { setTab('global'); onGlobalTab?.() },
            }, t('memory.globalTab')))
        : null,
      activeTab === 'global'
        ? h('div', { className: 'ptcPlusGlobalPane' },
            globalBindings === undefined
              ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.globalUnavailable'))
              : globalBindings.entries.length === 0
                ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.globalEmpty'))
                : h('ul', { className: 'ptcPlusGlobalList' }, globalBindings.entries.map(entry => (
                h('li', { key: entry.id, className: 'ptcPlusGlobalItem' },
                  h('button', {
                    type: 'button', className: 'ptcPlusBindingSelect',
                    'aria-expanded': globalSource?.id === entry.id,
                    onClick: () => inspectGlobal(entry),
                  },
                  h('span', { className: 'ptcPlusBindingName', title: entry.name }, entry.name),
                  h('span', { className: 'ptcPlusBindingMeta', title: entry.symbols.join(', ') }, `${entry.scope} - ${entry.symbols.join(', ')}`),
                  h('span', { className: 'ptcPlusBindingState', 'data-enabled': entry.enabled },
                    t(entry.enabled ? 'bindings.enabled' : 'bindings.disabledEntry'))),
                  globalSource?.id !== entry.id
                    ? null
                    : globalSource.error === true
                      ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.globalUnavailable'))
                      : h('pre', { className: 'ptcPlusGlobalSource' }, globalSource.source))
                )))
          )
        : !memory.available
        ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.unavailable'))
        : memory.entries.length === 0
          ? h('span', { className: 'ptcPlusReplEmpty' }, t('memory.empty'))
          : h('ul', { className: 'ptcPlusReplList' }, memory.entries.map((binding, index) => {
            const expanded = expandedBinding === binding.name
            const preview = binding.definition.source.replace(/\s+/g, ' ').trim()
            const definitionId = `${id}-binding-${index}`
            const toggle = () => setExpandedBinding(current => (
              current === binding.name ? null : binding.name
            ))
            return h('li', {
              className: 'ptcPlusReplBinding', key: binding.name,
              'data-expanded': expanded,
            },
              h('button', {
                className: 'ptcPlusReplBindingTrigger', type: 'button',
                'aria-expanded': expanded,
                'aria-controls': expanded ? definitionId : undefined,
                onClick: toggle,
              },
                h('span', { className: 'ptcPlusReplIdentity' },
                  h('span', {
                    className: 'ptcPlusReplName', 'data-kind': binding.kind,
                    title: `${binding.name} - ${t(`memory.kind.${binding.kind}`)}`,
                  }, binding.name),
                  h('span', { className: 'ptcPlusReplReuse', title: t('memory.reuseHint') },
                    t('memory.reuseCount', { count: binding.reuseCount }))),
                h('span', { className: 'ptcPlusReplPreview', title: preview }, preview),
                h('span', {
                  className: 'ptcPlusReplChevron', 'data-open': expanded, 'aria-hidden': true,
                }, h(IconChevronDownOutline14, { size: 14 }))),
              expanded
                ? h('div', {
                  className: 'ptcPlusReplDefinitionWrap', 'data-open': true,
                  id: definitionId, role: 'region', 'aria-label': binding.name,
                }, h('div', { className: 'ptcPlusReplDefinitionInner' },
                  h('div', { className: 'ptcPlusReplDefinition' },
                    h('span', { className: 'ptcPlusReplLocation' }, t('memory.location', {
                      line: binding.definition.line,
                      column: binding.definition.column,
                    })),
                    typeof CodeBlock === 'function'
                      ? h(CodeBlock, {
                        code: binding.definition.source,
                        lang: 'typescript',
                        className: 'ptcPlusReplCode',
                        copyLabel: t('tool.copy'),
                        copiedLabel: t('tool.copied'),
                      })
                      : h('pre', { className: 'ptcPlusReplCode' }, binding.definition.source))))
                : null)
          })),
      tab !== 'session' || memory.omitted === 0 ? null
        : h('span', { className: 'ptcPlusReplMore' }, t('memory.more', { count: memory.omitted }))))
  }

  return { ReplComposer, ReplConsole, ReplMemoryCard, replPopoverIsOpen, placeReplPopover }
}
