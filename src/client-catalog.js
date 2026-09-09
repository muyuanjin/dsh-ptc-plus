/**
 * Global User Bindings catalog owner. One source per consumer: reads are
 * latest-wins inside that source (a newer read, write or reset aborts the
 * previous one and its response is dropped), writes are serialized per source,
 * and every state change publishes an immutable snapshot to its subscribers.
 * Consumers therefore keep no epoch of their own, and a slow request in one
 * surface can never invalidate another surface's request.
 */
export function createCatalogOwner({ callUserBindings }) {
  const sources = new Set()

  const createSource = () => {
    let state = Object.freeze({ status: 'loading', catalog: null, error: null })
    let epoch = 0
    let controller
    let writing = false
    let inactive = false
    const listeners = new Set()

    const publish = next => {
      state = Object.freeze({ ...state, ...next })
      for (const listener of [...listeners]) listener()
    }
    // Any new read/write/reset invalidates every older response in this source.
    const invalidate = () => {
      epoch += 1
      const previous = controller
      controller = undefined
      previous?.abort()
      return epoch
    }
    const message = error => (error instanceof Error ? error.message : String(error))

    const source = {
      getSnapshot: () => state,
      subscribe(listener) {
        // A mounted consumer makes the source live again after a release, and
        // keeps it inside owner disposal.
        if (inactive) {
          inactive = false
          sources.add(source)
        }
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) invalidate()
        }
      },
      /** Latest-wins catalog read; resolves to the catalog only when it still owns the source. */
      async read({ reload = false } = {}) {
        if (inactive || writing) return undefined
        const current = invalidate()
        const read = new AbortController()
        controller = read
        publish({ status: 'loading', error: null })
        try {
          const catalog = await callUserBindings(reload ? 'reload' : 'list', {}, read.signal)
          if (epoch !== current || controller !== read) return undefined
          controller = undefined
          if (catalog?.error !== undefined) {
            publish({ status: 'error', catalog: null, error: String(catalog.error) })
            return undefined
          }
          publish({ status: 'ready', catalog, error: null })
          return catalog
        } catch (error) {
          if (epoch !== current || controller !== read) return undefined
          controller = undefined
          publish({ status: 'error', catalog: null, error: message(error) })
          return undefined
        }
      },
      /** Serialized compare-and-swap write; a failed write becomes the source error state. */
      async write(operation) {
        if (inactive || writing) return undefined
        writing = true
        const current = invalidate()
        publish({ status: 'writing', error: null })
        try {
          const catalog = await operation()
          if (epoch !== current) return undefined
          publish({ status: 'ready', catalog, error: null })
          return catalog
        } catch (error) {
          if (epoch !== current) return undefined
          publish({ status: 'error', catalog: null, error: message(error) })
          return undefined
        } finally {
          writing = false
          // A reset landed while writing: the state it dropped has to be read again.
          if (!inactive && epoch !== current) void source.read()
        }
      },
      /** Publish a catalog produced outside this source (the workbench owns its own writes). */
      accept(catalog) {
        if (inactive) return
        invalidate()
        publish({ status: 'ready', catalog, error: null })
      },
      /** Drop in-flight work and require a fresh read before the next render trusts the catalog. */
      reset() {
        if (inactive) return
        invalidate()
        publish({ status: 'loading', catalog: null, error: null })
      },
      release() {
        if (inactive) return
        inactive = true
        invalidate()
        listeners.clear()
        sources.delete(source)
      },
    }
    sources.add(source)
    return source
  }

  return {
    /** Claim an independent catalog source; the consumer releases it when it unmounts. */
    claim() {
      return createSource()
    },
    dispose() {
      for (const source of [...sources]) source.release()
    },
  }
}
