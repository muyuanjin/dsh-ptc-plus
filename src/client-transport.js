import { RPC_CONTRACTS } from '../internal/rpc-contract.js'
import { normalizeReplMemorySnapshot } from '../internal/repl-memory-projection.js'

/**
 * Client-side transport state machines that own their own invalidation:
 *
 * - observeRepl watches one visible REPL region, retries the watch with bounded
 *   backoff and only reports an observation that still matches the requested
 *   inventory. Everything it starts is aborted by its disposer.
 * - createBindingCommandAvailability publishes one boolean per session for the
 *   `binding` command, keyed by epoch so a late `commands.list` answer can never
 *   revive a subscription that already ended.
 */
export function createReplObserver({ rpc, ctx }) {
  function observeRepl(sessionId, element, memory, onObservation) {
    let controller
    let retryTimer
    let retries = 0
    let disposed = false
    const retryDelays = [1000, 2000, 4000]
    let visible = typeof IntersectionObserver !== 'function'
    const stop = () => {
      const previous = controller
      controller = undefined
      clearTimeout(retryTimer)
      retryTimer = undefined
      retries = 0
      previous?.abort()
    }
    const watch = async current => {
      try {
        await rpc.call(RPC_CONTRACTS.repl, 'watch', { sessionId }, current.signal)
      } catch {}
      if (disposed || controller !== current) return
      controller = undefined
      current.abort()
      if (!visible || document.visibilityState === 'hidden') { stop(); return }
      const delay = retryDelays[retries++]
      if (delay === undefined) return
      retryTimer = setTimeout(() => { retryTimer = undefined; sync() }, delay)
    }
    const read = async current => {
      if (!memory.available || memory.entries.length === 0 || memory.observation !== undefined) return
      try {
        const result = await rpc.call(RPC_CONTRACTS.repl, 'observe', { sessionId, memory }, current.signal)
        if (disposed || controller !== current || current.signal.aborted || result?.ok !== true || result.value === null) return
        const observed = normalizeReplMemorySnapshot(result.value)
        const { observation, ...inventory } = observed
        if (observation !== undefined && JSON.stringify(inventory) === JSON.stringify(memory)) onObservation(observed)
      } catch {}
    }
    const sync = () => {
      if (disposed) return
      const active = visible && document.visibilityState !== 'hidden'
      if (!active) { stop(); return }
      if (controller !== undefined || retryTimer !== undefined || retries > retryDelays.length) return
      controller = new AbortController()
      void watch(controller)
      void read(controller)
    }
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      sync()
    }) : undefined
    observer?.observe(element)
    const reset = ctx.on('connection/reset', () => { stop(); sync() })
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      disposed = true
      stop()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', sync)
      reset()
    }
  }

  return { observeRepl }
}

export function createBindingCommandAvailability(scope) {
  const entries = new Map()
  let commandRemote
  const entryFor = (sessionId) => {
    const id = String(sessionId)
    let entry = entries.get(id)
    if (entry === undefined) {
      entry = { available: false, epoch: 0, listeners: new Set() }
      entry.source = {
        getSnapshot: () => entry.available,
        subscribe(listener) {
          entry.listeners.add(listener)
          if (entry.listeners.size === 1) void refresh(id)
          return () => {
            entry.listeners.delete(listener)
            if (entry.listeners.size === 0) {
              entry.epoch++
              entry.available = false
            }
          }
        },
      }
      entries.set(id, entry)
    }
    return entry
  }
  const publish = (entry, available) => {
    if (entry.available === available) return
    entry.available = available
    for (const listener of entry.listeners) listener()
  }
  const refresh = async (sessionId) => {
    if (sessionId === undefined || sessionId === null) return
    const entry = entries.get(String(sessionId))
    if (entry === undefined || entry.listeners.size === 0) return
    const epoch = ++entry.epoch
    let available = false
    try {
      const result = await commandRemote?.commands.list(String(sessionId))
      available = result?.ok === true
        && Array.isArray(result.value)
        && result.value.some(command => command?.name === 'binding')
    } catch {}
    if (entry.epoch === epoch) publish(entry, available)
  }
  const reset = (sessionId) => {
    if (sessionId === undefined || sessionId === null) return
    const entry = entries.get(String(sessionId))
    if (entry === undefined || entry.listeners.size === 0) return
    entry.epoch += 1
    publish(entry, false)
    void refresh(sessionId)
  }
  scope.inject(['remote', 'remote.commands'], commandScope => {
    commandRemote = commandScope.remote
    commandScope.effect(() => commandScope.remote.$on('commands/change', () => {
      for (const sessionId of entries.keys()) void refresh(sessionId)
    }))
    commandScope.effect(() => commandScope.remote.$on('agent-preset/selected', reset))
    for (const sessionId of entries.keys()) void refresh(sessionId)
    commandScope.effect(() => () => {
      commandRemote = undefined
      for (const entry of entries.values()) {
        entry.epoch++
        publish(entry, false)
      }
    })
  })
  scope.on('connection/reset', () => {
    for (const sessionId of entries.keys()) reset(sessionId)
  })
  scope.effect(() => () => {
    for (const entry of entries.values()) entry.epoch++
    entries.clear()
  })
  return Object.freeze({
    source: sessionId => entryFor(sessionId).source,
  })
}
