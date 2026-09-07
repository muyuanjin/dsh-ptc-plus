export const REPL_OBSERVATION_RPC_CHANNEL = '/ptc-plus-repl'

/** A visible Client holds a cancellable request; it never requests evaluation. */
export function createReplObservationInterest(ctx, initiallyEnabled) {
  let enabled = initiallyEnabled
  const watchers = new Set()
  const registrations = new Set()
  const clear = () => { for (const watcher of [...watchers]) watcher.release() }
  const handler = async (endpoint, payload, signal) => {
    if (!enabled || endpoint !== 'watch' || typeof payload?.sessionId !== 'string'
      || payload.sessionId.length === 0 || payload.sessionId.length > 256
      || signal === undefined || watchers.size >= 64) return { ok: false, error: {
      code: 'repl/watch-unavailable', message: 'REPL observation unavailable', details: {},
    } }
    return new Promise(resolve => {
      const watcher = { sessionId: payload.sessionId, release() {
        signal.removeEventListener('abort', watcher.release)
        watchers.delete(watcher)
        resolve({ ok: true, value: null })
      } }
      watchers.add(watcher)
      signal.addEventListener('abort', watcher.release, { once: true })
      if (signal.aborted) watcher.release()
    })
  }
  const injection = ctx.inject?.(['connection'], scope => {
    if (typeof scope.connection?.rpc?.handle !== 'function') return
    const owner = typeof scope.effect === 'function' ? scope : ctx
    owner.effect(() => {
      const unregister = scope.connection.rpc.handle(REPL_OBSERVATION_RPC_CHANNEL, handler, { authority: 'trusted-host' })
      const release = async () => {
        if (!registrations.delete(release)) return
        clear()
        await unregister()
      }
      registrations.add(release)
      return release
    }, 'ptc-plus: visible REPL observation')
  })
  return {
    has(sessionId) { return enabled && [...watchers].some(watcher => watcher.sessionId === sessionId) },
    reconfigure(value) { enabled = value; if (!enabled) clear() },
    async dispose() {
      enabled = false
      clear()
      for (const release of [...registrations]) await release()
      if (typeof injection === 'function') await injection()
      else await injection?.dispose?.()
    },
  }
}
