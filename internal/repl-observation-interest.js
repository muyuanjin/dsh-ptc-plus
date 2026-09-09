import { RPC_CONTRACTS } from './rpc-contract.js'

export const REPL_OBSERVATION_RPC_CONTRACT = RPC_CONTRACTS.repl

/** A visible Client holds a cancellable request; it never requests evaluation. */
export function createReplObservationInterest(ctx, initiallyEnabled, observe = async () => undefined) {
  let enabled = initiallyEnabled
  const watchers = new Set()
  const inspections = new Set()
  const registrations = new Set()
  const clear = () => {
    for (const watcher of [...watchers]) watcher.release()
    for (const controller of inspections) controller.abort()
  }
  const handler = async (endpoint, payload, signal) => {
    if (!enabled || !['watch', 'observe'].includes(endpoint) || typeof payload?.sessionId !== 'string'
      || payload.sessionId.length === 0 || payload.sessionId.length > 256
      || signal === undefined || (endpoint === 'watch' && watchers.size >= 64)) return { ok: false, error: {
      code: 'repl/watch-unavailable', message: 'REPL observation unavailable', details: {},
    } }
    if (endpoint === 'observe') {
      if (inspections.size >= 64) return { ok: true, value: null }
      const controller = new AbortController()
      inspections.add(controller)
      try {
        const value = await observe(payload.sessionId, payload.memory, AbortSignal.any([signal, controller.signal]))
        return { ok: true, value: value ?? null }
      } catch {
        return { ok: false, error: { code: 'repl/observation-unavailable', message: 'REPL observation unavailable', details: {} } }
      } finally {
        inspections.delete(controller)
      }
    }
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
  const injection = ctx.inject?.(['ptcPlusRpc'], scope => {
    if (typeof scope.ptcPlusRpc?.register !== 'function') return
    const owner = typeof scope.effect === 'function' ? scope : ctx
    owner.effect(() => {
      const unregister = scope.ptcPlusRpc.register(REPL_OBSERVATION_RPC_CONTRACT, handler)
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
