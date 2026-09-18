import { bindingDraftProjection, bindingReviewStatus } from './client-binding-review.js'
import { bindingModelPreferences } from '../internal/user-binding-model-context.js'
import { featureEnabled } from './client-feature-gates.js'

/**
 * Hover dwell before the composer entry opens its menu. The entry sits inside the
 * composer, so a pointer merely crossing it must not drop a menu over the input;
 * click and keyboard paths stay immediate, and the published Menu owns the close
 * grace for a pointer that leaves the trigger and its list.
 */
const HOVER_DWELL_MS = 150

/**
 * Authoring surfaces: the composer entry menu, the binding review dock and the
 * command card. The review registry, catalog source and workbench controller
 * stay owned by the entry and arrive as dependencies.
 */
export function createAuthoringView(React, deps) {
  const {
    ActionButton, IconButton, Menu, Toast, Tooltip, CodeBlock, BindingsDialog, PTCPlusSettingsDialog,
    useWorkbenchController, useBindingReview, catalogOwner, callUserBindings, subscribeReset,
    settingsCardSeat, updateSetting,
    icons: {
      sparkle: IconSparkle16, chevron: IconChevronDownOutline14,
      close: IconCloseOutline16, check: IconCheckOutline14,
    },
  } = deps
  const h = React.createElement

  /**
   * Where the settings card lives on the installed generation.
   *
   * The compat module reports the seat the host declared rather than the
   * generation, so this copy names the place a user can open now. Before either
   * seat mounts it reports the current one, which is what an up-to-date install
   * offers; the preceding generation's own seat replaces it once it registers.
   */
  const settingsPath = t => t(settingsCardSeat?.() === 'settings.plugin.item'
    ? 'settings.pathSettings' : 'settings.pathPlugins')

  function BindingAuthorButton({
    sessionId, t, useInput, inputActions, usePtcSettings, useBindingCommand,
  }) {
    const input = useInput?.(snapshot => snapshot)
    const available = useBindingCommand(snapshot => snapshot)
    const settings = usePtcSettings(snapshot => snapshot)
    const [review, view] = useBindingReview(sessionId)
    const anchorRef = React.useRef(null)
    const attachAnchor = React.useCallback(element => {
      anchorRef.current = element
      review.access = element
    }, [review])
    const firstItemRef = React.useRef(null)
    const manageItemRef = React.useRef(null)
    const reloadItemRef = React.useRef(null)
    const settingsItemRef = React.useRef(null)
    const focused = React.useRef(false)
    const dialogReturnFocus = React.useRef(null)
    const hoverTimer = React.useRef(undefined)
    const [menu, setMenu] = React.useState(null)
    const [managing, setManaging] = React.useState(false)
    const [settingsOpen, setSettingsOpen] = React.useState(false)
    // The menu catalog and the workbench catalog are independent sources: a
    // read or write in one never invalidates the other's in-flight request.
    const catalogSource = React.useMemo(() => catalogOwner.claim(), [catalogOwner])
    const catalogState = React.useSyncExternalStore(catalogSource.subscribe, catalogSource.getSnapshot)
    const catalog = catalogState.catalog
    const catalogStatus = catalogState.status
    const catalogError = catalogState.error
    // Rows act on the catalog already on screen. A background read keeps them
    // usable; only a write in flight blocks a second toggle on the same menu.
    const catalogReady = catalog !== null && catalogStatus !== 'writing'
    const catalogFocus = React.useRef(null)
    const toastSequence = React.useRef(0)
    const [toast, setToast] = React.useState(null)
    const hasDraft = view.mounted && view.candidate !== null && view.action === null
    const quickAccess = featureEnabled(settings, 'authorButton')
    const canAuthor = quickAccess && available && typeof useInput === 'function' && typeof inputActions?.setDraft === 'function'
    const menuOpen = (hasDraft || quickAccess) && view.reachable && !managing && !settingsOpen
      && menu !== null && menu.key === view.candidateKey
    // The dialog owns the management session; losing the input surface only
    // suspends reads, so a draft survives a temporary Host takeover.
    const workbench = useWorkbenchController({
      enabled: quickAccess && managing, active: view.reachable, callUserBindings,
    })
    const refreshCatalog = React.useCallback(async (reload = false) => {
      if (reload) captureCatalogFocus()
      await catalogSource.read({ reload })
    }, [catalogSource])
    React.useEffect(() => {
      const reset = () => {
        catalogSource.reset()
        setMenu(null)
        setManaging(false)
        setSettingsOpen(false)
      }
      const unsubscribe = subscribeReset(reset)
      return () => {
        unsubscribe()
        catalogSource.release()
      }
    }, [catalogSource])
    const toggleBinding = async entry => {
      if (!catalogReady || !quickAccess) return
      captureCatalogFocus()
      await catalogSource.write(() => callUserBindings(entry.enabled ? 'disable' : 'enable', {
        id: entry.id, expectedRevision: catalog.revision,
      }))
    }
    const cancelHoverOpen = React.useCallback(() => {
      if (hoverTimer.current === undefined) return
      clearTimeout(hoverTimer.current)
      hoverTimer.current = undefined
    }, [])
    React.useEffect(() => cancelHoverOpen, [cancelHoverOpen])
    const showMenu = mode => {
      cancelHoverOpen()
      if (!menuOpen && quickAccess) void refreshCatalog()
      setMenu({ key: view.candidateKey, mode, step: 'root' })
    }
    // Touch has no hover: its tap reaches the same menu through the click path.
    const hoverMenu = event => {
      if (event.pointerType === 'touch' || menuOpen) return
      cancelHoverOpen()
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = undefined
        showMenu('hover')
      }, HOVER_DWELL_MS)
    }
    const menuElement = () => manageItemRef.current?.closest('[role=menu]')
      ?? firstItemRef.current?.closest('[role=menu]')
    const captureCatalogFocus = () => {
      catalogFocus.current = menuElement()?.contains(document.activeElement) ? document.activeElement : null
    }
    // The list must sit next to the entry that opened it. The published Menu reads
    // this rect on open and on every scroll/resize, and re-runs placement whenever
    // the prop identity changes, so measuring the trigger each render also keeps an
    // open list on a composer that grows without emitting a scroll.
    const menuAnchorRect = () => {
      const anchor = anchorRef.current
      if (!anchor) return null
      const rect = anchor.getBoundingClientRect()
      menuElement()?.style.setProperty('--ptc-plus-menu-space', `${Math.max(0, rect.top - 16)}px`)
      return rect
    }
    const hideMenu = () => {
      const itemHasFocus = menuElement()?.contains(document.activeElement)
        || (catalogFocus.current !== null && document.activeElement === document.body)
      setMenu(null)
      if (itemHasFocus && anchorRef.current?.getClientRects().length) {
        anchorRef.current.querySelector('.ptcPlusAuthorButton')?.focus({ preventScroll: true })
      }
    }
    React.useEffect(() => {
      const observer = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => review.reachable(entries.some(entry => entry.isIntersecting))) : undefined
      if (observer) observer.observe(anchorRef.current)
      else review.reachable(true)
      return () => { observer?.disconnect(); review.reachable(false) }
    }, [review])
    React.useEffect(() => {
      // Losing the input surface hides the dialog; it does not end the management
      // session. The draft lives in the controller above, so the same text returns
      // with the composer. Explicit close and feature disablement still end it.
      setMenu(null)
    }, [hasDraft, view.reachable, view.candidateKey])
    React.useLayoutEffect(() => {
      if (focused.current && document.activeElement === document.body) {
        focused.current = false
        const anchor = anchorRef.current
        const button = anchor?.querySelector('.ptcPlusAuthorButton')
        if (button?.getClientRects().length) button.focus({ preventScroll: true })
        else focusComposer(anchor)
      }
    }, [hasDraft, canAuthor, view.candidateKey])
    React.useLayoutEffect(() => {
      if (!menuOpen) { catalogFocus.current = null; return }
      if (catalogStatus === 'writing' || catalogStatus === 'loading') return
      const target = catalogFocus.current
      catalogFocus.current = null
      if (!target || document.activeElement !== document.body) return
      const root = menuElement()
      const next = root?.contains(target) && !target.disabled ? target
        : reloadItemRef.current?.closest('button') ?? root?.querySelector('button:not(:disabled)')
      next?.focus({ preventScroll: true })
    }, [catalogStatus, menuOpen])
    React.useLayoutEffect(() => {
      if (!menuOpen || menu.mode === 'hover') return
      // The public Menu commits its measured position before keyboard focus enters it.
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled && anchorRef.current?.getClientRects().length) menuElement()?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
      })
      return () => { cancelled = true }
    }, [menuOpen, menu?.mode, menu?.step])
    React.useEffect(() => {
      if (toast === null || typeof Toast === 'function') return undefined
      const timer = setTimeout(() => setToast(null), 2_500)
      return () => clearTimeout(timer)
    }, [toast])
    const label = hasDraft ? t('bindings.reviewMenuLabel', { count: 1 })
      + (view.message ? ` · ${t('bindings.reviewAttention')}` : '') : t('bindings.open')
    const hint = t(hasDraft ? 'bindings.draftHint' : 'bindings.openHint')
    // Every authoring action goes through the same busy guard and input owner, so a
    // new or revision request can never overwrite an unsent user draft.
    const prefillAuthoring = value => {
      hideMenu()
      if (!canAuthor) return
      if (typeof input?.draft === 'string' && input.draft.trim() !== '') {
        toastSequence.current += 1
        setToast({ sequence: toastSequence.current, text: t('bindings.composerBusy') })
        return
      }
      inputActions.setDraft(value)
    }
    const openAuthoring = () => prefillAuthoring('/binding new ')
    const openAuthoringEdit = entry => prefillAuthoring(`/binding edit ${entry.id} `)
    const starButton = h('button', {
      type: 'button', className: 'ptcPlusAuthorButton', 'aria-label': label,
      // Older UI-kit lines ship no Tooltip primitive; the native title carries the hint there.
      title: typeof Tooltip === 'function' ? undefined : hint,
      'aria-haspopup': 'menu', 'aria-expanded': menuOpen,
      onPointerEnter: hoverMenu,
      onPointerLeave: cancelHoverOpen,
      onKeyDown: event => {
        if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); showMenu('keyboard') }
      },
      onClick: () => {
        if (menuOpen && menu.mode !== 'hover') hideMenu()
        else showMenu('click')
      },
    }, typeof IconSparkle16 === 'function'
      ? h(IconSparkle16, { size: 16, 'aria-hidden': true })
      : h('span', { className: 'ptcPlusAuthorButtonLabel', 'aria-hidden': true }, t('bindings.open')),
      hasDraft ? h('span', { className: 'ptcPlusDraftBadge', 'aria-hidden': true,
        'data-attention': view.message !== null }, '1') : null)
    const catalogItems = !quickAccess ? [] : [
      { id: 'global-heading', type: 'label', text: t('bindings.quickHeading') },
      ...(catalog?.entries ?? []).map(entry => ({ id: `global:${entry.id}`,
        disabled: !catalogReady,
        label: h('span', { className: 'ptcPlusBindingQuickRow', 'data-enabled': entry.enabled },
          h('span', { className: 'ptcPlusBindingQuickName' }, h('strong', { title: entry.name }, entry.name),
            h('span', { className: 'ptcPlusBindingQuickState' }, t(entry.enabled ? 'bindings.enabled' : 'bindings.disabledEntry'))),
          h('span', { className: 'ptcPlusBindingQuickPurpose', title: entry.purpose }, entry.purpose)),
      })),
      ...(catalog !== null && catalog.entries.length === 0
        ? [{ id: 'empty', type: 'label', text: t('memory.globalEmpty') }] : []),
      ...(catalogStatus === 'writing' || (catalog === null && catalogStatus === 'loading')
        ? [{ id: 'pending', type: 'label', text: t(catalogStatus === 'writing' ? 'bindings.quickSaving' : 'bindings.quickLoading') }] : []),
      ...(catalogError === null ? [] : [{ id: 'error', type: 'label', text: t('bindings.failed', { error: catalogError }) }]),
    ]
    // Revision selection is a second step of the same flat Menu. The published Menu
    // disables its scroll viewport as soon as any top-level row has a submenu, so a
    // submenu here would lose the bounded, scrollable catalog this step needs.
    const editItems = [
      { id: 'edit-heading', type: 'label', text: t('bindings.quickEditHeading') },
      ...(catalog?.entries ?? []).map(entry => ({
        id: `edit:${entry.id}`,
        disabled: !catalogReady,
        label: h('span', { className: 'ptcPlusBindingQuickRow' },
          h('span', { className: 'ptcPlusBindingQuickName' }, h('strong', { title: entry.name }, entry.name),
            h('span', { className: 'ptcPlusBindingQuickState' }, t(entry.enabled ? 'bindings.enabled' : 'bindings.disabledEntry'))),
          h('span', { className: 'ptcPlusBindingQuickPurpose', title: entry.purpose }, entry.purpose)),
      })),
      // The back row also anchors menu lookup, so the step still owns its list
      // when the catalog is momentarily empty.
      { id: 'edit-back', label: h('span', { className: 'ptcPlusBindingMenuAction', ref: firstItemRef }, t('bindings.back')) },
    ]
    return h('span', {
      className: 'ptcPlusComposerBindingAnchor', tabIndex: -1,
      onFocusCapture: () => { focused.current = true }, onBlurCapture: () => { focused.current = false },
      'data-text': typeof IconSparkle16 === 'function' ? undefined : true,
      ref: attachAnchor,
    },
      !hasDraft && !quickAccess ? null : h(Menu, {
        className: 'ptcPlusAuthorButtonShell', open: menuOpen,
        anchor: typeof Tooltip === 'function'
          ? h(Tooltip, { label: hint, delayMs: 400 }, starButton) : starButton,
        portal: true, side: 'top', dense: true,
        // A hovered menu leaves with the pointer once it leaves the trigger and the
        // list for the published grace, which re-entering either cancels; click and
        // keyboard menus stay until dismissed.
        closeOnPointerLeave: menu !== null && menu.mode === 'hover',
        getAnchorRect: menuAnchorRect,
        selectedIds: (catalog?.entries ?? []).filter(entry => entry.enabled).map(entry => `global:${entry.id}`),
        onClose: hideMenu,
        items: menu?.step === 'edit' ? editItems : [...(hasDraft ? [{ id: 'draft-heading', type: 'label', text: t('bindings.quickDrafts') }, { id: view.candidateKey,
          label: h('span', { className: 'ptcPlusDraftMenuItem', ref: firstItemRef },
            h('strong', null, view.candidate.entry.name),
            h('span', null, t(bindingReviewStatus(view)))) },
            ...(quickAccess ? [{ id: 'draft-separator', type: 'separator' }] : [])] : []), ...catalogItems,
          ...(quickAccess ? [{ id: 'actions-separator', type: 'separator' }] : []),
          ...(canAuthor ? [{ id: 'new', label: h('span', { className: 'ptcPlusBindingMenuAction' }, t('bindings.authorNewDraft')) }] : []),
          ...(canAuthor && (catalog?.entries?.length ?? 0) > 0
            ? [{ id: 'edit', label: h('span', { className: 'ptcPlusBindingMenuAction' }, t('bindings.authorEdit')) }] : []),
          ...(quickAccess ? [
            ...(catalogError === null ? [] : [{ id: 'reload', label: h('span', { ref: reloadItemRef }, t('bindings.reload')) }]),
            { id: 'manage', label: h('span', { ref: manageItemRef, className: 'ptcPlusBindingMenuAction' }, t('bindings.manage')) },
          ] : []),
          // The entry is also the shortcut to this plugin's own settings, so the
          // row names the seat the installed generation declared and its hint
          // carries the full path that opens it.
          { id: 'settings', label: h('span', {
            ref: settingsItemRef, className: 'ptcPlusBindingMenuAction', title: settingsPath(t),
          }, t('settings.menuEntry')) },
        ],
        onSelect: id => {
          if (!anchorRef.current?.getClientRects().length) return
          if (id === 'edit') {
            setMenu(current => current === null ? current : { ...current, step: 'edit' })
            return
          }
          if (id === 'edit-back') {
            setMenu(current => current === null ? current : { ...current, step: 'root' })
            return
          }
          if (id.startsWith('edit:')) {
            const entry = catalog?.entries.find(entry => `edit:${entry.id}` === id)
            if (entry) openAuthoringEdit(entry)
            return
          }
          if (id.startsWith('global:')) {
            const entry = catalog?.entries.find(entry => `global:${entry.id}` === id)
            if (entry) void toggleBinding(entry)
            return
          }
          if (id === 'reload') { void refreshCatalog(true); return }
          if (id === 'settings') {
            hideMenu()
            setSettingsOpen(true)
            return
          }
          hideMenu()
          if (id === 'new') openAuthoring()
          else if (id === 'manage') {
            dialogReturnFocus.current = null
            setManaging(true)
          }
          else if (id === view.candidateKey) openBindingReview(review, view.candidate)
        },
      }),
      // Hiding the composer unmounts the dialog, not the controller: the draft survives.
      managing && quickAccess && view.reachable
        ? h(BindingsDialog, {
          controller: workbench, t, onClose: () => setManaging(false), returnFocusRef: dialogReturnFocus,
          getReturnFocus: () => anchorRef.current?.querySelector('.ptcPlusAuthorButton'),
        }) : null,
      settingsOpen && view.reachable
        ? h(PTCPlusSettingsDialog, {
          t, usePtcSettings, updateSetting, callUserBindings,
          onClose: () => {
            setSettingsOpen(false)
            queueMicrotask(() => anchorRef.current?.querySelector('.ptcPlusAuthorButton')
              ?.focus({ preventScroll: true }))
          },
        }) : null,
      toast === null ? null : typeof Toast === 'function'
        ? h(Toast, {
          key: toast.sequence,
          text: toast.text,
          anchor: anchorRef.current,
          onDone: () => setToast(null),
        })
        : h('span', {
          key: toast.sequence, className: 'ptcPlusComposerNotice', role: 'status',
        }, toast.text))
  }

  function BindingCandidateContent({ candidate, t, showName = true }) {
    const preferences = bindingModelPreferences(candidate.entry.modelContext)
    const contextTitle = React.useId()
    return h('div', { className: 'ptcPlusAuthoringDraft' },
      showName ? h('strong', null, candidate.entry.name) : null,
      h('span', { className: 'ptcPlusBindingMeta' }, `${candidate.entry.scope} - ${candidate.entry.symbols.join(', ')}`),
      candidate.entry.purpose ? h('p', { className: 'ptcPlusMessage' }, candidate.entry.purpose) : null,
      typeof CodeBlock === 'function'
        ? h(CodeBlock, { code: candidate.entry.source, lang: 'typescript', className: 'ptcPlusBindingCommandCode',
          copyLabel: t('tool.copy'), copiedLabel: t('tool.copied') })
        : h('pre', { className: 'ptcPlusBindingCommandSource' }, candidate.entry.source),
      h('section', { className: 'ptcPlusCandidateContext', 'aria-labelledby': contextTitle },
        h('h4', { id: contextTitle }, t('bindings.modelContext')),
        h('dl', null,
          h('div', { className: 'ptcPlusCandidateDeclaration' },
            h('dt', null, t('bindings.declaration')),
            h('dd', { 'data-included': preferences.includeDeclaration },
              preferences.includeDeclaration ? h(IconCheckOutline14, { size: 14, 'aria-hidden': true }) : null,
              t(preferences.includeDeclaration ? 'bindings.declarationIncluded' : 'bindings.declarationExcluded'))),
          h('div', { className: 'ptcPlusCandidatePrompt' },
            h('dt', null, t('bindings.instructions')),
            h('dd', { 'data-empty': preferences.instructions === '' },
              preferences.instructions || t('bindings.noInstructions'))))))
  }

  // Native editable semantics are enough to restore focus; no Host class, store or editor internals are used.
  function focusComposer(anchor) {
    if (!anchor || anchor.getClientRects().length === 0) return
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      const editable = [...parent.querySelectorAll('textarea, [contenteditable="true"]')]
        .find(element => element.getClientRects().length > 0 && !element.disabled)
      if (editable) { editable.focus({ preventScroll: true }); return }
    }
    anchor.focus({ preventScroll: true })
  }

  function openBindingReview(review, candidate = review.getSnapshot().candidate) {
    if (!review.display('expanded', candidate)) return
    requestAnimationFrame(() => {
      if (review.getSnapshot().candidate === candidate && review.panel?.getClientRects().length) {
        review.panel.focus({ preventScroll: true })
      }
    })
  }

  function focusBindingReviewAccess(review) {
    const anchor = review.access
    const button = anchor?.querySelector('button')
    if (button?.getClientRects().length) button.focus({ preventScroll: true })
    else focusComposer(anchor)
  }

  function fitBindingReview(panel) {
    const body = panel?.querySelector('.ptcPlusBindingDockBody')
    const anchor = panel?.parentElement
    if (!anchor || typeof ResizeObserver !== 'function') return undefined
    const ancestors = []
    let seat = panel
    let viewport
    for (let parent = panel.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(parent)
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) {
        viewport = parent
        break
      }
      seat = parent
    }
    if (!viewport) return undefined
    let frame
    const update = () => {
      if (!panel.getClientRects().length) return
      const top = Math.max(viewport.getBoundingClientRect().top + viewport.clientTop,
        window.visualViewport?.offsetTop ?? 0)
      // Float above the complete composer stack without changing its height or covering other docks.
      const offset = anchor.getBoundingClientRect().bottom - seat.getBoundingClientRect().top + 8
      panel.style.setProperty('--ptc-plus-review-offset', `${Math.max(8, Math.ceil(offset))}px`)
      const room = Math.max(0, seat.getBoundingClientRect().top - top - 16)
      panel.style.setProperty('--ptc-plus-review-height', `${Math.floor(room)}px`)
      if (body) {
        const chrome = panel.scrollHeight - body.offsetHeight + 2
        const available = Math.max(0, room - chrome)
        // In short viewports one scroller keeps source and actions reachable together.
        panel.dataset.scroll = available < 80 ? 'panel' : 'body'
        body.style.setProperty('--ptc-plus-review-space', `${Math.floor(available)}px`)
      }
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(schedule)
    for (const element of [panel, ...panel.children, ...ancestors]) observer.observe(element)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    update()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      panel.style.removeProperty('--ptc-plus-review-offset')
      panel.style.removeProperty('--ptc-plus-review-height')
      delete panel.dataset.scroll
      body?.style.removeProperty('--ptc-plus-review-space')
    }
  }

  function BindingReviewDock({ sessionId, useProjection, t }) {
    const raw = useProjection('ptcPlusBindingDraft')
    const projection = React.useMemo(() => bindingDraftProjection(raw), [raw])
    const [review, view] = useBindingReview(sessionId)
    const focused = React.useRef(false)
    // The composer entry follows the dock; wait for its refs to attach in the same commit.
    React.useEffect(() => {
      if (view.visibility !== 'hidden') return
      if (view.action !== null && focused.current && document.activeElement === document.body) {
        focusBindingReviewAccess(review)
      }
      focused.current = false
    }, [review, view.visibility, view.action])
    React.useLayoutEffect(() => review.attach(), [review])
    React.useLayoutEffect(() => { review.sync(projection) }, [review, projection])
    const title = React.useId()
    const content = React.useId()
    const expanded = view.visibility === 'expanded'
    const candidateKey = view.candidateKey
    React.useLayoutEffect(() => fitBindingReview(review.panel),
      [review, candidateKey, expanded, view.visibility, view.message])
    const close = () => {
      review.display('hidden')
      requestAnimationFrame(() => focusBindingReviewAccess(review))
    }
    const act = (operation, activate = false) => {
      // Keep focus in the review when pending state disables the clicked action.
      if (review.panel?.contains(document.activeElement)) review.panel.focus({ preventScroll: true })
      void review.act(operation, activate)
    }
    if (view.candidate === null || view.visibility === 'hidden') return null
    return h('div', { className: 'ptcPlusBindingDockAnchor' },
      h('section', { key: candidateKey, className: 'ptcPlusBindingDock', 'aria-labelledby': title, tabIndex: -1,
      ref: element => { review.panel = element },
      onFocusCapture: () => { focused.current = true },
      onBlurCapture: event => {
        // Blink blurs the removed panel before layout effects; completion still owns that lost focus.
        if (event.relatedTarget || review.getSnapshot().action === null) focused.current = false
      },
      'aria-busy': view.busy },
      h('div', { className: 'ptcPlusBindingDockHead' },
        h('button', { type: 'button', className: 'ptcPlusBindingDockToggle',
          'aria-label': t(expanded ? 'bindings.reviewCollapse' : 'bindings.reviewExpand'),
          'aria-expanded': expanded, 'aria-controls': expanded ? content : undefined,
          onClick: () => review.display(expanded ? 'collapsed' : 'expanded') },
          h('span', { className: 'ptcPlusBindingDockSymbol', 'aria-hidden': true }, '</>'),
          h('span', { className: 'ptcPlusBindingDockHeading' },
            h('strong', { id: title, title: view.candidate.entry.name }, view.candidate.entry.name),
            h('span', { role: 'status', title: t(bindingReviewStatus(view)) },
              `${t('bindings.reviewTitle')} · ${t(bindingReviewStatus(view))}`)),
          h('span', { className: 'ptcPlusBindingDockChevron', 'aria-hidden': true },
            h(IconChevronDownOutline14, { size: 16 }))),
        h(IconButton, { icon: IconCloseOutline16, label: t('bindings.reviewClose'), onClick: close })),
      !expanded ? null : h(React.Fragment, null,
        h('div', { className: 'ptcPlusBindingDockBody', id: content, tabIndex: 0,
          role: 'region', 'aria-label': t('bindings.source') },
          h(BindingCandidateContent, { candidate: view.candidate, t, showName: false })),
        view.message === null ? null : h('p', { className: 'ptcPlusMessage ptcPlusDanger', role: 'status' }, t(view.message)),
        h('div', { className: 'ptcPlusBindingDockActions' },
          h(ActionButton, { className: 'ptcPlusBindingDockDiscard', 'data-kind': 'ghost',
            disabled: !view.writable || view.busy,
            onClick: () => act('discard-draft') }, t('bindings.draftDiscard')),
          h(ActionButton, { disabled: !view.writable || view.busy,
            onClick: () => act('save-draft', false) }, t('bindings.draftSave')),
          h(ActionButton, { 'data-kind': 'primary', disabled: !view.writable || view.busy,
            onClick: () => act('save-draft', true) }, t('bindings.draftSaveEnable')),
          view.message === null ? null : h(ActionButton, { disabled: view.busy,
            onClick: () => review.reset() }, t('bindings.reviewRetry'))))))
  }

  function BindingCommandCard({ node, sessionId, t, useProjection }) {
    const projection = bindingDraftProjection(useProjection?.('ptcPlusBindingDraft'))
    const [review, current] = useBindingReview(sessionId)
    const historical = projection?.history?.find(record => record.commandId === node.commandId)
    const matches = projection?.commandId === node.commandId
    const currentMatches = current.candidate?.commandId === node.commandId
    const candidate = historical?.candidate ?? (currentMatches ? current.candidate : null)
    const action = historical?.action ?? (currentMatches ? current.action : null)
    const phase = action?.state ?? (candidate !== null ? 'ready'
      : node.outcome?.kind === 'error' || (matches && projection.phase === 'failed') ? 'failed'
        : matches && projection.phase === 'pending' ? 'pending' : 'idle')
    const status = action != null ? bindingReviewStatus({ action })
      : phase === 'ready' ? 'bindings.commandGenerated'
        : phase === 'pending' ? 'bindings.commandPending'
          : phase === 'failed' ? 'bindings.commandFailed'
            : node.outcome === null ? 'bindings.commandAdmitting' : 'bindings.commandAccepted'
    const canOpen = matches && currentMatches && action == null && current.mounted && current.reachable
    return h('section', { className: 'ptcPlusBindingCommand', 'data-phase': phase,
      'aria-label': t('bindings.commandTitle') },
      h('div', { className: 'ptcPlusBindingCommandHeader' },
        h('strong', { className: 'ptcPlusBindingCommandTitle' }, t('bindings.commandTitle')),
        h('span', { className: 'ptcPlusBindingCommandState' },
          h('span', { className: 'ptcPlusBindingCommandStateDot', 'aria-hidden': true }), t(status))),
      h('pre', { className: 'ptcPlusBindingCommandRequirement' }, `/binding${node.args ?? ''}`),
      node.outcome?.kind !== 'error' ? null : h('p', { className: 'ptcPlusMessage ptcPlusDanger' },
        node.outcome.text ?? t('bindings.commandFailed')),
      canOpen ? h(ActionButton, { onClick: () => openBindingReview(review) }, t('bindings.reviewOpen')) : null,
      !current.mounted && (candidate !== null || matches && projection.phase === 'ready')
        ? h('p', { className: 'ptcPlusMessage' }, t('bindings.reviewUnavailable')) : null,
      candidate === null ? null : h('details', { className: 'ptcPlusBindingSourceDetails' },
        h('summary', null, t('tool.source')), h(BindingCandidateContent, { candidate, t })))
  }

  return { BindingAuthorButton, BindingReviewDock, BindingCommandCard }
}
