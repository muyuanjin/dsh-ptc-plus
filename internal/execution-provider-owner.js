import { createExecutionSeam, EXECUTION_SEAM_SERVICE } from './execution-seam-compat.js'

export const name = 'ptc-plus-execution-provider'
export const inject = ['loader']

export function apply(ctx, config = {}) {
  const ownerFiber = ctx.fiber
  const { originalEntryId = 'ptc-runtime', isolation = 'ptc-plus-original' } = config
  if (typeof originalEntryId !== 'string' || originalEntryId.length === 0
    || typeof isolation !== 'string' || isolation.length === 0) {
    throw new TypeError('ptc-plus: execution provider requires an original entry id and named isolation')
  }
  // Profile rows belong to the Include's tree; the global Loader resolves root IDs.
  const entryTree = ownerFiber.entry?.parent.tree ?? ctx.loader
  const originalEntry = entryTree.resolve(originalEntryId)
  const isolated = () => originalEntry.options.isolate?.[EXECUTION_SEAM_SERVICE] === isolation
  if (!isolated()) throw new Error(`ptc-plus: original entry ${originalEntryId} must isolate ${EXECUTION_SEAM_SERVICE} as ${isolation}`)
  const originalContext = originalEntry.context.extend({ [originalEntry.constructor.key]: undefined })
  let watcher
  let live
  let stopped = false
  let suspended = false
  let generation
  const pending = new Set()
  let resolveAttachment
  let rejectAttachment
  const attachment = new Promise((resolve, reject) => {
    resolveAttachment = resolve
    rejectAttachment = reject
  })
  const readOriginal = () => {
    const original = isolated() ? originalContext.get(EXECUTION_SEAM_SERVICE) : undefined
    if (stopped || original === undefined) {
      throw new Error(`ptc-plus: original ${EXECUTION_SEAM_SERVICE} generation is unavailable`)
    }
    return original
  }
  const release = () => {
    const entry = live
    if (entry === undefined) return
    live = undefined
    entry.seam.retire()
    const unregistration = entry.unregister?.()
    const disposal = Promise.allSettled([unregistration, entry.disposeChild?.()]).then(results => {
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus: execution provider disposal failed')
    })
    pending.add(disposal)
    disposal.then(() => pending.delete(disposal), error => {
      pending.delete(disposal)
      ctx.logger.warn(error)
    })
    return disposal
  }
  const suspend = () => {
    suspended = true
    const disposal = release()
    const previous = watcher
    watcher = undefined
    return Promise.all([disposal, previous?.dispose()])
  }
  const publish = () => {
    const resolutions = new WeakMap()
    const delegate = {
      get language() { return readOriginal().language },
      get isolation() { return readOriginal().isolation },
      get executionInstructions() { return readOriginal().executionInstructions },
      get sandboxMode() { return readOriginal().sandboxMode },
      get timeout() { return readOriginal().timeout },
      resolve(request) {
        const original = readOriginal()
        const spec = original.resolve(request)
        if (spec !== null && typeof spec === 'object') {
          resolutions.set(spec, { original, generation })
        }
        return spec
      },
      run(spec) {
        const resolved = resolutions.get(spec)
        if (resolved?.generation?.active === false) throw new Error('ptc-plus: resolved spec belongs to an unavailable original generation')
        const original = resolved?.original ?? readOriginal()
        return original.run(spec)
      },
    }
    const seam = createExecutionSeam(delegate, EXECUTION_SEAM_SERVICE)
    const entry = { seam }
    live = entry
    entry.disposeChild = ctx.effect(() => {
      const child = ctx.plugin({
        name: 'ptc-plus-composed-runtime',
        apply(childContext) {
          childContext.effect(() => {
            if (stopped || live !== entry || !isolated()) return () => {}
            entry.unregister = childContext.provide(EXECUTION_SEAM_SERVICE, seam.provider)
            return () => entry.unregister()
          }, 'ptc-plus owned execution registration')
        },
      })
      entry.child = child
      return () => child.dispose()
    }, 'ptc-plus owned execution child')
    return entry.child.await().then(() => {
      if (!stopped && live === entry && entry.unregister !== undefined && entry.child.state === 2) resolveAttachment()
    }, error => {
      rejectAttachment(error)
      throw error
    })
  }
  const watch = () => {
    if (stopped || watcher !== undefined || !isolated()) return
    ctx.effect(() => {
      const observer = originalContext.inject([EXECUTION_SEAM_SERVICE], scope => {
        if (stopped || !isolated()) return
        createExecutionSeam(scope.get(EXECUTION_SEAM_SERVICE), EXECUTION_SEAM_SERVICE)
        const currentGeneration = { active: true }
        generation = currentGeneration
        scope.effect(() => () => {
          currentGeneration.active = false
          if (generation === currentGeneration) generation = undefined
        }, 'ptc-plus original generation scope')
        if (live === undefined) return publish()
        return live.seam.sourceChanged()
      })
      watcher = observer
      return () => observer.dispose()
    }, 'ptc-plus original execution observer')
  }
  ctx.on('loader/partial-dispose', (entry, _legacy, active) => {
    if (entry === originalEntry && (!active || !isolated())) void suspend().catch(error => ctx.logger.warn(error))
  }, { prepend: true, global: true })
  ctx.on('loader/patch-context', (entry, next) => {
    if (entry === originalEntry && !isolated()) void suspend().catch(error => ctx.logger.warn(error))
    next()
    if (entry === originalEntry && isolated() && suspended && !stopped && ownerFiber.state === 2) {
      stopped = true
      resolveAttachment()
      void suspend().catch(error => ctx.logger.warn(error))
      void ownerFiber.restart().catch(error => ctx.logger.warn(error))
    }
  }, { prepend: true, global: true })
  ctx.effect(() => () => {
    stopped = true
    resolveAttachment()
    const suspension = suspend()
    return Promise.all([suspension, ...pending])
  }, 'ptc-plus execution provider composition')
  if (originalEntry.disabled) resolveAttachment()
  const timer = setTimeout(() => rejectAttachment(new Error(
    `ptc-plus: original execution entry ${originalEntryId} did not publish ${EXECUTION_SEAM_SERVICE}`,
  )), 30_000)
  ctx.effect(() => () => clearTimeout(timer), 'ptc-plus original execution provider wait')
  const originalReady = originalEntry.fiber?.await() ?? Promise.resolve()
  return originalReady.then(() => {
    watch()
    return attachment
  }).finally(() => clearTimeout(timer))
}
