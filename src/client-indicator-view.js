/**
 * Header indicator for PTC Plus sessions: a popover trigger whose card is
 * supplied by the REPL view. Popover open/placement logic is shared with the
 * card rather than re-implemented here.
 */
export function createIndicatorView(React, deps) {
  const {
    featureEnabled, useSessionPreset, sessionUsesPtcPreset,
    normalizeReplMemorySnapshot, unavailableReplMemorySnapshot,
    ReplMemoryCard, replPopoverIsOpen, placeReplPopover,
    catalogOwner, subscribeReset,
  } = deps
  const h = React.createElement

  function PTCPlusSessionIndicator({
    sessionId, t, useProjection, useSessions, useInput, inputActions, usePtcSettings, callUserBindings,
  }) {
    const preset = useSessionPreset({ sessionId, useProjection, useSessions })
    const projectionMemory = useProjection('ptcPlusRepl')
    const settings = usePtcSettings(snapshot => snapshot)
    const input = typeof useInput === 'function' ? useInput(snapshot => snapshot) : undefined
    const resolvedSessionId = sessionId
    const globalEnabled = featureEnabled(settings, 'bindings')
    const identity = JSON.stringify([sessionId, globalEnabled])
    // The catalog is read through its owner: this surface keeps no epoch of its
    // own, and a poll here cannot invalidate another surface's request.
    const catalogSource = React.useMemo(() => catalogOwner.claim(), [catalogOwner])
    const catalogState = React.useSyncExternalStore(catalogSource.subscribe, catalogSource.getSnapshot)
    const globalBindings = catalogState.catalog ?? undefined
    const [authoringMessage, setAuthoringMessage] = React.useState(null)
    const refreshGlobalBindings = React.useCallback(() => {
      if (!globalEnabled) return
      void catalogSource.read()
    }, [globalEnabled, catalogSource])
    React.useEffect(() => () => catalogSource.release(), [catalogSource])
    React.useEffect(() => {
      // Session and feature identity own this surface's catalog lifetime.
      if (!globalEnabled) { catalogSource.reset(); return }
      void catalogSource.read()
    }, [identity, globalEnabled, catalogSource])
    React.useEffect(() => subscribeReset(() => catalogSource.reset()), [catalogSource])
    const triggerRef = React.useRef(null)
    const popoverRef = React.useRef(null)
    const closeTimer = React.useRef(undefined)
    const [expanded, setExpanded] = React.useState(false)
    React.useEffect(() => {
      if (!expanded || !globalEnabled) return undefined
      const timer = setInterval(() => { void refreshGlobalBindings() }, 1_500)
      return () => clearInterval(timer)
    }, [expanded, globalEnabled, refreshGlobalBindings])
    const positionPopover = React.useCallback(() => {
      if (!replPopoverIsOpen(popoverRef.current)) return
      placeReplPopover(triggerRef.current, popoverRef.current)
    }, [])
    const showPopover = React.useCallback(() => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
      const popover = popoverRef.current
      if (popover === null) return
      popover.style.visibility = 'hidden'
      if (!replPopoverIsOpen(popover)) {
        if (typeof popover.showPopover === 'function') {
          try {
            popover.showPopover()
          } catch {
            popover.dataset.open = 'true'
          }
        } else {
          popover.dataset.open = 'true'
        }
      }
      placeReplPopover(triggerRef.current, popover)
      popover.style.visibility = 'visible'
      setExpanded(true)
      void refreshGlobalBindings()
    }, [refreshGlobalBindings])
    const hidePopover = React.useCallback(() => {
      const popover = popoverRef.current
      if (popover === null) return
      if (popover.dataset.open === 'true') delete popover.dataset.open
      if (typeof popover.hidePopover === 'function' && replPopoverIsOpen(popover)) {
        try { popover.hidePopover() } catch {}
      }
      setExpanded(false)
    }, [])
    const scheduleHide = React.useCallback(() => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
      closeTimer.current = setTimeout(() => {
        closeTimer.current = undefined
        if (document.activeElement === triggerRef.current
          || popoverRef.current?.contains(document.activeElement)) return
        hidePopover()
      }, 120)
    }, [hidePopover])
    const prefillAuthoring = React.useCallback((value) => {
      if (typeof inputActions?.setDraft !== 'function') return
      if (typeof input?.draft === 'string' && input.draft.trim() !== '') {
        setAuthoringMessage('bindings.composerBusy')
        return
      }
      inputActions.setDraft(value)
      setAuthoringMessage(null)
      hidePopover()
    }, [hidePopover, input?.draft, inputActions])
    React.useEffect(() => {
      const syncPopoverState = (event) => {
        if (event.target !== popoverRef.current) return
        setExpanded(replPopoverIsOpen(popoverRef.current))
      }
      window.addEventListener('resize', positionPopover)
      document.addEventListener('scroll', positionPopover, true)
      document.addEventListener('toggle', syncPopoverState, true)
      return () => {
        if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
        window.removeEventListener('resize', positionPopover)
        document.removeEventListener('scroll', positionPopover, true)
        document.removeEventListener('toggle', syncPopoverState, true)
        const popover = popoverRef.current
        if (popover?.dataset?.open === 'true') delete popover.dataset.open
        if (typeof popover?.hidePopover === 'function' && replPopoverIsOpen(popover)) {
          try { popover.hidePopover() } catch {}
        }
      }
    }, [hidePopover, positionPopover])
    if (!sessionUsesPtcPreset(preset) || !featureEnabled(settings, 'plugin')) return null
    let memory
    try {
      memory = normalizeReplMemorySnapshot(projectionMemory)
    } catch {
      memory = unavailableReplMemorySnapshot()
    }
    const popoverId = `ptc-plus-repl-${String(resolvedSessionId).replace(/[^A-Za-z0-9_-]/g, '-')}`
    const titleId = `${popoverId}-title`
    return h('span', { className: 'ptcPlusActiveShell' },
      h('button', {
        type: 'button', className: 'ptcPlusActive', ref: triggerRef,
        title: t('indicator.title'),
        'aria-label': t('indicator.title'), 'aria-controls': popoverId,
        'aria-expanded': expanded, 'aria-haspopup': 'dialog',
        onPointerEnter: showPopover, onPointerLeave: scheduleHide,
        onFocus: showPopover, onBlur: scheduleHide, onClick: showPopover,
        onKeyDown: event => { if (event.key === 'Escape') hidePopover() },
      }, h('span', { className: 'ptcPlusActiveLabel' }, 'PTC Plus')),
      h(ReplMemoryCard, {
        memory,
        globalEnabled,
        globalBindings,
        loadGlobalBinding: id => callUserBindings('load', { id }),
        prefillAuthoring,
        authoringMessage,
        t, id: popoverId, titleId, popoverRef,
        onEnter: showPopover, onLeave: scheduleHide,
      }))
  }

  return { PTCPlusSessionIndicator }
}
