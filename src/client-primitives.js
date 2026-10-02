import { isHostComponent } from './client-host-compat.js'

/**
 * Resolve the Harness Client components this plugin renders against the
 * installed generation.
 *
 * The plugin may load a generation that renamed, removed, or reshaped a
 * primitive; a missing component would otherwise throw while rendering and take
 * the whole slot entry down with it. Each component therefore resolves to the
 * shipped primitive when that generation provides it and to a plugin-local
 * fallback otherwise, so a primitive change degrades one control instead of
 * blanking the entry that renders it.
 */

/** One menu row: separators and labels paint; every other row selects by id. */
function menuEntry(React, item, onSelect) {
  const h = React.createElement
  const content = item.label ?? item.text ?? null
  if (item.type === 'separator') {
    return h('div', { key: item.id, className: 'ptcPlusFallbackMenuSeparator', role: 'separator' })
  }
  if (item.type === 'label') {
    return h('div', { key: item.id, className: 'ptcPlusFallbackMenuLabel' }, content)
  }
  return h('button', {
    key: item.id, type: 'button', role: 'menuitem', className: 'ptcPlusFallbackMenuItem',
    disabled: item.disabled === true,
    onClick: () => onSelect?.(item.id),
  }, content)
}

function useCompositionGuard(React, open) {
  const composing = React.useRef(false)
  const ended = React.useRef(false)
  React.useEffect(() => {
    composing.current = false
    ended.current = false
    if (!open) return undefined
    const start = () => { composing.current = true }
    const end = () => { composing.current = false; ended.current = true }
    const release = () => { ended.current = false }
    const blur = () => { composing.current = false; ended.current = false }
    document.addEventListener('compositionstart', start, true)
    document.addEventListener('compositionend', end, true)
    document.addEventListener('keyup', release, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
      document.removeEventListener('keyup', release, true)
      window.removeEventListener('blur', blur)
      composing.current = false
      ended.current = false
    }
  }, [open])
  return event => {
    const guarded = composing.current || ended.current || event.isComposing === true || event.keyCode === 229
    ended.current = false
    return guarded
  }
}

/** Menu fallback: the anchor, the item list, the pinned footer and the children region. */
function createFallbackMenu(React, createPortal = content => content) {
  const h = React.createElement
  return function FallbackMenu({ open, items = [], children, footer, className, listClassName, autoFocus, anchor,
    onClose, onSelect, portal = false, side = 'bottom', align = 'start', getAnchorRect, closeOnPointerLeave = false }) {
    const root = React.useRef(null)
    const list = React.useRef(null)
    const closeTimer = React.useRef(null)
    const close = React.useRef(onClose)
    close.current = onClose
    const isComposing = useCompositionGuard(React, open)
    const cancelClose = () => { clearTimeout(closeTimer.current); closeTimer.current = null }
    const scheduleClose = () => {
      if (!closeOnPointerLeave) return
      cancelClose()
      closeTimer.current = setTimeout(() => close.current?.(), 180)
    }
    React.useEffect(() => cancelClose, [open])
    React.useLayoutEffect(() => {
      if (!open) return undefined
      const place = () => {
        const rect = getAnchorRect?.() ?? root.current?.getBoundingClientRect()
        const surface = list.current
        if (!rect || !surface) return
        const viewport = window.visualViewport
        const viewportTop = viewport?.offsetTop ?? 0
        const viewportLeft = viewport?.offsetLeft ?? 0
        const viewportHeight = viewport?.height ?? window.innerHeight
        const viewportWidth = viewport?.width ?? window.innerWidth
        const available = Math.max(0, side === 'top' ? rect.top - viewportTop - 12
          : viewportTop + viewportHeight - rect.bottom - 12)
        surface.style.maxHeight = `${available}px`
        const measured = surface.getBoundingClientRect()
        const left = align === 'end' ? rect.right - measured.width : rect.left
        surface.style.left = `${Math.max(viewportLeft + 8, Math.min(left, viewportLeft + viewportWidth - measured.width - 8))}px`
        surface.style.top = `${side === 'top' ? Math.max(viewportTop + 8, rect.top - measured.height - 4) : rect.bottom + 4}px`
      }
      place()
      window.addEventListener('resize', place)
      window.addEventListener('scroll', place, true)
      window.visualViewport?.addEventListener('resize', place)
      window.visualViewport?.addEventListener('scroll', place)
      return () => {
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', place, true)
        window.visualViewport?.removeEventListener('resize', place)
        window.visualViewport?.removeEventListener('scroll', place)
      }
    }, [open, side, align, getAnchorRect, children, items, footer])
    React.useEffect(() => {
      if (!open) return undefined
      if (autoFocus) list.current?.querySelector('button:not(:disabled)')?.focus()
      const onKeyDown = event => {
        if (event.defaultPrevented || isComposing(event)) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat) close.current?.()
          return
        }
        if (!root.current?.contains(event.target) && !list.current?.contains(event.target)) return
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const controls = [...list.current.querySelectorAll('button:not(:disabled)')]
        if (controls.length === 0) return
        const current = controls.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
        event.preventDefault()
        controls[next].focus()
      }
      const onPointerDown = event => {
        if (root.current?.contains(event.target) || list.current?.contains(event.target)) return
        close.current?.()
      }
      document.addEventListener('keydown', onKeyDown)
      document.addEventListener('pointerdown', onPointerDown, true)
      return () => {
        document.removeEventListener('keydown', onKeyDown)
        document.removeEventListener('pointerdown', onPointerDown, true)
      }
    }, [open, autoFocus])
    const rows = list => list.map(item => menuEntry(React, item, onSelect))
    const surface = open ? h('div', { ref: list, className: ['ptcPlusFallbackMenuList', listClassName].filter(Boolean).join(' '),
      role: 'menu', onPointerEnter: cancelClose, onPointerLeave: scheduleClose }, ...rows(items),
      ...(Array.isArray(footer) ? rows(footer) : []),
      children ?? null) : null
    return h('span', { ref: root, className: ['ptcPlusFallbackMenu', className].filter(Boolean).join(' '),
      onPointerEnter: cancelClose, onPointerLeave: scheduleClose }, anchor ?? null,
      portal && surface !== null ? createPortal(surface, document.body) : surface)
  }
}

/** Modal fallback: headless content or a titled dialog that closes on Escape and backdrop. */
function createFallbackModal(React, createPortal = content => content) {
  const h = React.createElement
  const modalStack = []
  return function FallbackModal({ open, onClose, title, closeLabel, description, className, contentClassName, headless, children }) {
    const root = React.useRef(null)
    const close = React.useRef(onClose)
    close.current = onClose
    const isComposing = useCompositionGuard(React, open)
    const focusable = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[href],[tabindex]:not([tabindex="-1"])'
    React.useLayoutEffect(() => {
      if (!open) return undefined
      const previous = document.activeElement
      const surface = root.current
      const target = surface?.querySelector('[data-modal-autofocus]:not(:disabled)') ?? surface?.querySelector(focusable) ?? surface
      target?.focus({ preventScroll: true })
      modalStack.push(surface)
      const onDocumentKeyDown = event => {
        if (modalStack.at(-1) === surface) onKeyDown(event)
      }
      document.addEventListener('keydown', onDocumentKeyDown)
      return () => {
        document.removeEventListener('keydown', onDocumentKeyDown)
        modalStack.splice(modalStack.indexOf(surface), 1)
        if (document.activeElement === document.body || surface?.contains(document.activeElement)) previous?.focus?.({ preventScroll: true })
      }
    }, [open])
    const onKeyDown = event => {
      if (event.defaultPrevented || isComposing(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) close.current?.()
      } else if (event.key === 'Tab') {
        const controls = [...root.current.querySelectorAll(focusable)]
          .filter(control => control.getClientRects().length > 0)
        const target = event.shiftKey ? controls.at(-1) : controls[0]
        const boundary = event.shiftKey ? controls[0] : controls.at(-1)
        if (controls.length === 0 || document.activeElement === boundary || !root.current.contains(document.activeElement)) {
          event.preventDefault()
          ;(target ?? root.current).focus({ preventScroll: true })
        }
      }
    }
    if (!open) return null
    const body = h('div', { className: contentClassName ?? 'ptcPlusFallbackModalBody' }, children)
    const surface = ['ptcPlusFallbackModal', className].filter(Boolean).join(' ')
    return createPortal(h('div', {
      className: 'ptcPlusFallbackModalBackdrop',
      onPointerDown: event => { if (event.target === event.currentTarget) onClose?.() },
    }, h('div', { ref: root, tabIndex: -1, className: surface, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      headless === true ? null : h('div', { className: 'ptcPlusFallbackModalHead' },
        h('h2', null, title),
        h('button', { type: 'button', className: 'ptcPlusDialogClose', 'aria-label': closeLabel ?? title, onClick: () => onClose?.() },
          closeLabel ?? '\u00d7')),
      headless === true || description === undefined ? null : h('p', { className: 'ptcPlusDetail' }, description),
      headless === true ? children : body)), document.body)
  }
}

/**
 * Resolve every component the plugin renders.
 * @param primitives - the installed generation's Client primitives.
 * @param React - the browser React instance.
 * @returns the component set the views consume.
 */
export function resolvePrimitives(primitives, React, createPortal) {
  return Object.freeze({
    Button: primitives.Button,
    CodeBlock: primitives.CodeBlock,
    DisclosureRow: primitives.DisclosureRow,
    Menu: isHostComponent(primitives.Menu) ? primitives.Menu : createFallbackMenu(React, createPortal),
    MenuFallback: createFallbackMenu(React, createPortal),
    Modal: isHostComponent(primitives.Modal) ? primitives.Modal : createFallbackModal(React, createPortal),
    Toast: primitives.Toast,
    Tooltip: primitives.Tooltip,
  })
}

/** Adapt host action styling, or own it completely when the primitive is absent. */
export function createActionButton(React, Button) {
  const h = React.createElement
  return function ActionButton({ className = '', 'data-kind': kind, ...props }) {
    const classes = className.split(/\s+/).filter(name => name !== '' && name !== 'ptcPlusButton')
    return isHostComponent(Button)
      ? h(Button, {
        type: 'button', ...props, size: 'sm',
        variant: kind === 'primary' ? 'primary' : kind === 'ghost' ? 'ghost' : 'outline',
        className: classes.join(' '),
      })
      : h('button', { type: 'button', ...props, className: ['ptcPlusButton', ...classes].join(' '), 'data-kind': kind })
  }
}

export { createFallbackMenu, createFallbackModal }
