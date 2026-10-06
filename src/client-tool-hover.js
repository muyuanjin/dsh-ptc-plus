const HOVER_DWELL_MS = 400
const SCROLL_IDLE_MS = 350

/** Presentation excerpt only; the expanded row retains the complete record. */
export function toolHoverExcerpt(text, maxLines) {
  const prefix = text.slice(0, 1800).replace(/[\uD800-\uDBFF]$/, '')
  const lines = prefix.split(/\r\n|\r|\n/)
  const selected = lines.slice(0, maxLines)
  let truncated = prefix.length < text.length || lines.length > maxLines
  const bounded = selected.map(line => {
    if (line.length <= 100) return line
    truncated = true
    // Do not leave a dangling UTF-16 high surrogate at the cut.
    return line.slice(0, 99).replace(/[\uD800-\uDBFF]$/, '') + '…'
  })
  return { text: bounded.join('\n'), truncated }
}

/** Only the owned anchor and preview participate in placement. */
function placeToolHover(anchor, preview, pointer) {
  const margin = 12
  const gap = 10
  const viewport = window.visualViewport
  const leftEdge = viewport?.offsetLeft ?? 0
  const topEdge = viewport?.offsetTop ?? 0
  const width = viewport?.width ?? window.innerWidth
  const height = viewport?.height ?? window.innerHeight
  const rect = anchor.getBoundingClientRect()
  const previewWidth = Math.min(420, width - margin * 2)
  const right = pointer === null ? rect.right + gap : pointer[0] + 16
  const onRight = right + previewWidth <= leftEdge + width - margin
  const below = Math.max(0, topEdge + height - rect.bottom - gap - margin)
  const above = Math.max(0, rect.top - topEdge - gap - margin)
  const onTop = below < 340 && above > below
  const available = Math.min(360, onRight ? height - margin * 2 : onTop ? above : below)
  if (available < 100 || width < 100) return false
  preview.style.width = `${previewWidth}px`
  preview.style.maxHeight = `${available}px`
  preview.style.left = onRight ? `${right}px` : `${Math.max(leftEdge + margin,
    Math.min(rect.left + 16, leftEdge + width - previewWidth - margin))}px`
  preview.style.top = onRight
    ? `${Math.max(topEdge + margin, Math.min(pointer?.[1] ?? rect.top,
      topEdge + height - margin - Math.min(preview.offsetHeight, available)))}px`
    : onTop ? `${rect.top - gap - Math.min(preview.offsetHeight, available)}px`
      : `${rect.bottom + gap}px`
  preview.dataset.placement = onRight ? 'right' : onTop ? 'top' : 'bottom'
  preview.style.visibility = 'visible'
  preview.dataset.clipped = String([...preview.querySelectorAll(
    '.ptcPlusToolHoverContent,.ptcPlusToolHoverSection,.ptcPlusToolHoverDescription,.ptcPlusFeatures,pre',
  )].some(element => element.scrollHeight > element.clientHeight + 1
    || element.scrollWidth > element.clientWidth + 1))
  return true
}

/**
 * Passive quick peeks never enter hit testing. Shared capture observers cancel
 * every pending/visible tool preview on wheel or scroll without cancelling or
 * redispatching the event. A fresh pointer gesture after idle owns reopening.
 */
export function createToolHover(React, createPortal) {
  const h = React.createElement
  const subscribers = new Set()
  let lastScroll = -Infinity
  const scrolling = () => {
    lastScroll = Date.now()
    for (const cancel of subscribers) cancel()
  }
  const escaping = event => {
    if (event.key === 'Escape') for (const cancel of subscribers) cancel()
  }
  const subscribe = cancel => {
    if (subscribers.size === 0) {
      window.addEventListener('wheel', scrolling, { capture: true, passive: true })
      window.addEventListener('scroll', scrolling, { capture: true, passive: true })
      window.addEventListener('keydown', escaping)
    }
    subscribers.add(cancel)
    return () => {
      subscribers.delete(cancel)
      if (subscribers.size === 0) {
        window.removeEventListener('wheel', scrolling, true)
        window.removeEventListener('scroll', scrolling, true)
        window.removeEventListener('keydown', escaping)
        lastScroll = -Infinity
      }
    }
  }

  function ToolHoverAnchor({ disabled, content, children }) {
    const [visible, setVisible] = React.useState(false)
    const anchorRef = React.useRef(null)
    const previewRef = React.useRef(null)
    const pending = React.useRef(null)
    const visibleRef = React.useRef(false)
    const lastPointer = React.useRef(null)
    const cancelled = React.useRef(false)
    const clearPending = React.useCallback(() => {
      if (pending.current !== null) clearTimeout(pending.current)
      pending.current = null
    }, [])
    const dismiss = React.useCallback(() => {
      clearPending()
      visibleRef.current = false
      // Hide the owned surface immediately, even before React's next render.
      if (previewRef.current !== null) previewRef.current.hidden = true
      setVisible(false)
    }, [clearPending])
    const cancel = React.useCallback(() => {
      cancelled.current = true
      dismiss()
    }, [dismiss])
    React.useEffect(() => disabled ? undefined : subscribe(cancel), [disabled, cancel])
    React.useEffect(() => () => clearPending(), [clearPending])
    React.useLayoutEffect(() => {
      if (disabled) cancel()
    }, [disabled, cancel])
    const show = () => {
      if (disabled) return
      cancelled.current = false
      visibleRef.current = true
      setVisible(true)
    }
    const arm = event => {
      if (disabled || event.pointerType === 'touch' || visibleRef.current
        || pending.current !== null || Date.now() - lastScroll < SCROLL_IDLE_MS) return
      cancelled.current = false
      pending.current = setTimeout(() => {
        pending.current = null
        if (Date.now() - lastScroll >= SCROLL_IDLE_MS && !cancelled.current) show()
      }, HOVER_DWELL_MS)
    }
    React.useLayoutEffect(() => {
      if (!visible || disabled) return
      const preview = previewRef.current
      const anchor = anchorRef.current
      if (preview === null || anchor === null) return
      preview.hidden = false
      if (typeof preview.showPopover === 'function') preview.showPopover()
      const place = () => {
        if (!placeToolHover(anchor, preview, lastPointer.current)) dismiss()
      }
      place()
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
      observer?.observe(anchor)
      observer?.observe(preview)
      window.addEventListener('resize', place)
      window.visualViewport?.addEventListener('resize', place)
      return () => {
        observer?.disconnect()
        window.removeEventListener('resize', place)
        window.visualViewport?.removeEventListener('resize', place)
      }
    }, [visible, disabled, dismiss, cancel])
    const preview = !visible || disabled ? null : h('div', {
      ref: previewRef, className: 'ptcPlusToolHover',
      popover: typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined,
      style: { visibility: 'hidden' },
      role: 'tooltip',
    }, content)
    return h('div', {
      className: 'ptcPlusTool', ref: anchorRef,
      onPointerEnter: event => {
        lastPointer.current = [event.clientX, event.clientY]
        arm(event)
      },
      onPointerMove: event => {
        const point = lastPointer.current
        lastPointer.current = [event.clientX, event.clientY]
        if (point === null || point[0] !== event.clientX || point[1] !== event.clientY) arm(event)
      },
      onPointerLeave: () => { lastPointer.current = null; dismiss() },
      onPointerDownCapture: cancel,
      onKeyDownCapture: event => { if (event.key === 'Escape') cancel() },
      onFocusCapture: event => {
        if (event.target.matches(':focus-visible')) { lastPointer.current = null; clearPending(); show() }
      },
      onBlurCapture: event => {
        if (!event.currentTarget.contains(event.relatedTarget)) dismiss()
      },
    }, children, preview === null ? null : typeof createPortal === 'function'
      ? createPortal(preview, document.body) : preview)
  }

  return { ToolHoverAnchor }
}
