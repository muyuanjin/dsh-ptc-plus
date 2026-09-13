/**
 * Hover dwell before the card opens: the indicator shares the session header with
 * native actions, so a pointer merely crossing it must not open a card over the
 * conversation. Click and keyboard focus stay immediate.
 */
const HOVER_DWELL_MS = 150

/**
 * Grace before a pointer-dismissed card closes. It carries the pointer across the
 * 8px trigger-card gap without leaving the card behind a pointer that moved on.
 */
const CLOSE_GRACE_MS = 200

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
    sessionId, t, useProjection, useSessions, usePtcSettings, callUserBindings,
  }) {
    const preset = useSessionPreset({ sessionId, useProjection, useSessions })
    const projectionMemory = useProjection('ptcPlusRepl')
    const settings = usePtcSettings(snapshot => snapshot)
    const resolvedSessionId = sessionId
    const globalEnabled = featureEnabled(settings, 'bindings')
    const identity = JSON.stringify([sessionId, globalEnabled])
    // The catalog is read through its owner: this surface keeps no epoch of its
    // own, so a read here cannot invalidate another surface's request.
    const catalogSource = React.useMemo(() => catalogOwner.claim(), [catalogOwner])
    const catalogState = React.useSyncExternalStore(catalogSource.subscribe, catalogSource.getSnapshot)
    const globalBindings = catalogState.catalog ?? undefined
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
    const shellRef = React.useRef(null)
    const popoverRef = React.useRef(null)
    const openTimer = React.useRef(undefined)
    const closeTimer = React.useRef(undefined)
    const placementFrame = React.useRef(undefined)
    // The card leaves with the pointer unless a click pinned it. Keyboard modality
    // separates a reader focusing the trigger from the focus a pointer press leaves
    // behind, which must not turn a hovering card into a resident one.
    const pinned = React.useRef(false)
    const keyboard = React.useRef(false)
    // Restoring focus to the trigger is bookkeeping, not a reader asking for the
    // card back, so it must not read as a keyboard request to open it again.
    const restoringFocus = React.useRef(false)
    const [expanded, setExpanded] = React.useState(false)
    React.useEffect(() => {
      const markKeyboard = () => { keyboard.current = true }
      const markPointer = () => { keyboard.current = false }
      document.addEventListener('keydown', markKeyboard, true)
      document.addEventListener('pointerdown', markPointer, true)
      return () => {
        document.removeEventListener('keydown', markKeyboard, true)
        document.removeEventListener('pointerdown', markPointer, true)
      }
    }, [])
    const cancelOpen = React.useCallback(() => {
      if (openTimer.current === undefined) return
      clearTimeout(openTimer.current)
      openTimer.current = undefined
    }, [])
    const cancelClose = React.useCallback(() => {
      if (closeTimer.current === undefined) return
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }, [])
    const positionPopover = React.useCallback(() => {
      if (!replPopoverIsOpen(popoverRef.current)) return
      placeReplPopover(triggerRef.current, popoverRef.current)
    }, [])
    // A captured scroll fires per event and every placement forces layout, so
    // several can collapse into one frame.
    const schedulePlacement = React.useCallback(() => {
      if (placementFrame.current !== undefined) return
      placementFrame.current = requestAnimationFrame(() => {
        placementFrame.current = undefined
        positionPopover()
      })
    }, [positionPopover])
    const showPopover = React.useCallback(() => {
      cancelOpen()
      cancelClose()
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
    }, [cancelClose, cancelOpen, refreshGlobalBindings])
    const hidePopover = React.useCallback(() => {
      cancelOpen()
      cancelClose()
      pinned.current = false
      const popover = popoverRef.current
      if (popover === null) return
      if (popover.dataset.open === 'true') delete popover.dataset.open
      if (typeof popover.hidePopover === 'function' && replPopoverIsOpen(popover)) {
        try { popover.hidePopover() } catch {}
      }
      setExpanded(false)
    }, [cancelClose, cancelOpen])
    // Touch has no hover, so its tap reaches the same card through the click path.
    const scheduleOpen = React.useCallback(() => {
      // The pointer came back to the trigger: the card may still be open from before,
      // with the close its own leave armed waiting to return it.
      cancelClose()
      if (replPopoverIsOpen(popoverRef.current)) return
      cancelOpen()
      openTimer.current = setTimeout(() => {
        openTimer.current = undefined
        // A hover that reaches this point is the pointer driving the card again, so a
        // later leave closes it instead of inheriting the keyboard exemption.
        keyboard.current = false
        showPopover()
      }, HOVER_DWELL_MS)
    }, [cancelClose, cancelOpen, showPopover])
    const scheduleHide = React.useCallback(() => {
      cancelOpen()
      cancelClose()
      if (pinned.current) return
      closeTimer.current = setTimeout(() => {
        closeTimer.current = undefined
        // A keyboard reader keeps the card: focus inside it, or on its own trigger.
        if (popoverRef.current?.contains(document.activeElement)) return
        if (keyboard.current && document.activeElement === triggerRef.current) return
        hidePopover()
      }, CLOSE_GRACE_MS)
    }, [cancelClose, cancelOpen, hidePopover])
    const togglePopover = React.useCallback(() => {
      cancelOpen()
      if (!replPopoverIsOpen(popoverRef.current)) {
        // The click owns the card until the reader closes it explicitly.
        pinned.current = true
        showPopover()
        return
      }
      if (!pinned.current) { pinned.current = true; return }
      hidePopover()
    }, [cancelOpen, hidePopover, showPopover])
    const dismissOutside = React.useCallback(event => {
      if (event.target instanceof Node && shellRef.current?.contains(event.target) !== true) hidePopover()
    }, [hidePopover])
    const closeOnEscape = React.useCallback(event => {
      if (event.key !== 'Escape') return
      hidePopover()
      const trigger = triggerRef.current
      if (!trigger?.getClientRects().length) return
      restoringFocus.current = true
      trigger.focus({ preventScroll: true })
      restoringFocus.current = false
    }, [hidePopover])
    React.useEffect(() => {
      if (!expanded) return undefined
      // A manual popover keeps the browser out of dismissal, so both close paths
      // stay owned here instead of racing the click that toggles it.
      document.addEventListener('pointerdown', dismissOutside)
      document.addEventListener('keydown', closeOnEscape)
      return () => {
        document.removeEventListener('pointerdown', dismissOutside)
        document.removeEventListener('keydown', closeOnEscape)
      }
    }, [closeOnEscape, dismissOutside, expanded])
    React.useEffect(() => {
      const syncPopoverState = (event) => {
        if (event.target !== popoverRef.current) return
        const open = replPopoverIsOpen(popoverRef.current)
        if (!open) pinned.current = false
        setExpanded(open)
      }
      const onScroll = (event) => {
        // Scrolling the card's own list cannot move it; only the page behind can.
        if (popoverRef.current?.contains(event.target)) return
        schedulePlacement()
      }
      window.addEventListener('resize', schedulePlacement)
      document.addEventListener('scroll', onScroll, true)
      document.addEventListener('toggle', syncPopoverState, true)
      return () => {
        cancelOpen()
        cancelClose()
        if (placementFrame.current !== undefined) {
          cancelAnimationFrame(placementFrame.current)
          placementFrame.current = undefined
        }
        window.removeEventListener('resize', schedulePlacement)
        document.removeEventListener('scroll', onScroll, true)
        document.removeEventListener('toggle', syncPopoverState, true)
        const popover = popoverRef.current
        if (popover?.dataset?.open === 'true') delete popover.dataset.open
        if (typeof popover?.hidePopover === 'function' && replPopoverIsOpen(popover)) {
          try { popover.hidePopover() } catch {}
        }
      }
    }, [cancelClose, cancelOpen, schedulePlacement])
    if (!sessionUsesPtcPreset(preset) || !featureEnabled(settings, 'plugin')) return null
    let memory
    try {
      memory = normalizeReplMemorySnapshot(projectionMemory)
    } catch {
      memory = unavailableReplMemorySnapshot()
    }
    const popoverId = `ptc-plus-repl-${String(resolvedSessionId).replace(/[^A-Za-z0-9_-]/g, '-')}`
    const titleId = `${popoverId}-title`
    return h('span', { className: 'ptcPlusActiveShell', ref: shellRef },
      h('button', {
        type: 'button', className: 'ptcPlusActive', ref: triggerRef,
        title: t('indicator.title'),
        'aria-label': t('indicator.title'), 'aria-controls': popoverId,
        'aria-expanded': expanded, 'aria-haspopup': 'dialog',
        onPointerEnter: event => {
          if (event.pointerType === 'touch') return
          scheduleOpen()
        },
        onPointerLeave: scheduleHide,
        // Only a keyboard reader opens the card by focusing the trigger; the focus
        // a click leaves behind must not reopen what the click just toggled.
        onFocus: () => { if (keyboard.current && !restoringFocus.current) showPopover() },
        onBlur: scheduleHide, onClick: togglePopover,
        onKeyDown: event => { if (event.key === 'Escape') hidePopover() },
      }, h('span', { className: 'ptcPlusActiveLabel' }, 'PTC Plus')),
      h(ReplMemoryCard, {
        memory,
        globalEnabled,
        globalBindings,
        loadGlobalBinding: id => callUserBindings('load', { id }),
        t, id: popoverId, titleId, popoverRef,
        onEnter: () => { cancelOpen(); cancelClose() },
        onLeave: scheduleHide,
        onGlobalTab: refreshGlobalBindings,
      }))
  }

  return { PTCPlusSessionIndicator }
}
