import { createExecutionSeam, EXECUTION_SEAM_SERVICE, LEGACY_EXECUTION_SEAM_SERVICE } from './execution-seam-compat.js'
import { providerRetainsState } from './official-repl-priority.js'

export const name = 'ptc-plus-execution-provider'
export const inject = ['loader']

export function apply(ctx, config = {}) {
  const ownerFiber = ctx.fiber
  const { originalEntryId = 'ptc-runtime', isolation = 'ptc-plus-original', serviceName = EXECUTION_SEAM_SERVICE } = config
  if (typeof originalEntryId !== 'string' || originalEntryId.length === 0
    || typeof isolation !== 'string' || isolation.length === 0) {
    throw new TypeError('ptc-plus: execution provider requires an original entry id and named isolation')
  }
  if (![EXECUTION_SEAM_SERVICE, LEGACY_EXECUTION_SEAM_SERVICE].includes(serviceName)) {
    throw new TypeError('ptc-plus: execution provider serviceName must be codeRuntime or ptcRuntime')
  }
  // Profile rows belong to the Include's tree; the global Loader resolves root IDs.
  const entryTree = ownerFiber.entry?.parent.tree ?? ctx.loader
  const originalEntry = entryTree.resolve(originalEntryId)
  const isolated = () => originalEntry.options.isolate?.[serviceName] === isolation
  if (!isolated()) throw new Error(`ptc-plus: original entry ${originalEntryId} must isolate ${serviceName} as ${isolation}`)
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
    const original = isolated() ? originalContext.get(serviceName) : undefined
    if (stopped || original === undefined) {
      throw new Error(`ptc-plus: original ${serviceName} generation is unavailable`)
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
    const ownerOriginals = new WeakMap()
    const isOwner = owner => owner !== null && (typeof owner === 'object' || typeof owner === 'function')
    const delegate = {
      get language() { return readOriginal().language },
      get isolation() { return readOriginal().isolation },
      get programFormat() { return readOriginal().programFormat ?? 'function-body' },
      // This composition isolates state owners and forwards every run to the
      // original provider, so the original's retention declaration is the
      // truthful answer. A host plugin that reads it must not see a stateful
      // environment reported as stateless.
      get retainsState() { return providerRetainsState(readOriginal()) },
      get executionInstructions() { return readOriginal().executionInstructions },
      get sandboxMode() { return readOriginal().sandboxMode },
      get timeout() { return readOriginal().timeout },
      release(owner) {
        const originals = isOwner(owner) ? ownerOriginals.get(owner) : undefined
        if (originals !== undefined) {
          return Promise.all([...originals].map(original => Promise.resolve()
            .then(() => original.release(owner))
            .then(() => originals.delete(original)))).then(() => undefined)
        }
        let original
        try {
          original = readOriginal()
        } catch {
          // No retained dispatch belongs to this owner and execution is unavailable.
          return Promise.resolve()
        }
        if (typeof original.release !== 'function') return Promise.resolve()
        return Promise.resolve(original.release.call(original, owner))
      },
      resolve(request) {
        const original = readOriginal()
        const spec = serviceName === EXECUTION_SEAM_SERVICE ? original.resolve(request) : request
        if (spec !== null && typeof spec === 'object') {
          resolutions.set(spec, { original, generation })
        }
        return spec
      },
      run(spec) {
        const resolved = resolutions.get(spec)
        if (resolved?.generation?.active === false) throw new Error('ptc-plus: resolved spec belongs to an unavailable original generation')
        const original = resolved?.original ?? readOriginal()
        if (isOwner(spec?.stateOwner) && typeof original.release === 'function') {
          let originals = ownerOriginals.get(spec.stateOwner)
          if (originals === undefined) ownerOriginals.set(spec.stateOwner, originals = new Set())
          originals.add(original)
        }
        return original.run(spec)
      },
    }
    const seam = createExecutionSeam(delegate, serviceName)
    const entry = { seam }
    live = entry
    entry.disposeChild = ctx.effect(() => {
      const child = ctx.plugin({
        name: 'ptc-plus-composed-runtime',
        apply(childContext) {
          childContext.effect(() => {
            if (stopped || live !== entry || !isolated()) return () => {}
            entry.unregister = childContext.provide(serviceName, seam.provider)
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
      const observer = originalContext.inject([serviceName], scope => {
        if (stopped || !isolated()) return
        createExecutionSeam(scope.get(serviceName), serviceName)
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
    `ptc-plus: original execution entry ${originalEntryId} did not publish ${serviceName}`,
  )), 30_000)
  ctx.effect(() => () => clearTimeout(timer), 'ptc-plus original execution provider wait')
  const originalReady = originalEntry.fiber?.await() ?? Promise.resolve()
  return originalReady.then(() => {
    watch()
    return attachment
  }).finally(() => clearTimeout(timer))
}
