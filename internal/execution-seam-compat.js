/**
 * Own how PTC Plus attaches to the host's program-execution seam.
 *
 * DSH registers one execution seam per generation. The current release
 * registers `ctx.ptcRuntime` (`@deepseek-ai/dsh-ptc-runtime`); the preceding one
 * registered `ctx.codeRuntime` (`@deepseek-ai/dsh-code-runtime`). Both run one
 * model-written program against host async bindings. They differ in the service
 * name, in the call shape (`resolve(request)` then `run(spec)` against a single
 * `run(request)`), and in the capability descriptors a provider publishes.
 * Which seam is live is decided by the registered service, never by a version
 * string, so a deployment on either generation obtains the same behavior.
 *
 * PTC Plus replaces the execution of session cells with its own persistent
 * REPL. The object DSH describes to the model is therefore the plugin's
 * execution, not the wrapped provider's, so `takeOver()` answers the
 * descriptors the plugin can honor and withholds the ones it cannot. The REPL
 * runs every cell in one long-lived worker rather than a fresh process per
 * call, applies the session's configured budgets rather than a per-call host
 * deadline, and performs no file confinement. DSH gates `timeoutMs` on
 * `timeout` and resolves or escalates file policy on `sandboxMode`, so
 * withholding those descriptors keeps DSH's authority decisions with DSH
 * instead of having this plugin accept an input it would then ignore.
 *
 * A seam-neutral request carries exactly `program`, `bindings`, and `signal`:
 * the fields PTC Plus consumes. A resolved spec's directory, deadline, and
 * authority describe the provider whose execution was replaced, and are neither
 * forwarded to the session kernel nor re-derived here.
 */

/** Cordis service name registered by the current DSH generation. */
export const EXECUTION_SEAM_SERVICE = 'ptcRuntime'

/** Cordis service name registered by the preceding DSH generation. */
export const LEGACY_EXECUTION_SEAM_SERVICE = 'codeRuntime'

const SEAM_SERVICES = Object.freeze([EXECUTION_SEAM_SERVICE, LEGACY_EXECUTION_SEAM_SERVICE])

/**
 * How long the plugin waits for the host's execution seam before it reports the
 * deployment as unsupported.
 *
 * Both seam names belong to the host's code-runtime row, so a composed host
 * publishes one while the loader settles its entries. A profile that never
 * registers either one cannot be served, and its activation promise must settle
 * with a diagnostic: the host awaits loader settlement before it becomes
 * usable, so an unbounded wait would park the whole host instead of failing
 * this entry.
 */
const SEAM_ATTACHMENT_TIMEOUT_MS = 30_000

/**
 * Descriptors the plugin replaces with the capabilities of its own execution.
 * `executionInstructions` describes the wrapped provider's program model, which
 * no longer applies; `timeout` and `sandboxMode` gate host inputs the plugin
 * cannot honor. Withdrawal is unconditional because the rule is a property of
 * the plugin's execution, not of a generation: the preceding generation's
 * contract defines none of these members and nothing in its install closure
 * reads them, so withdrawing there is inert, while a provider that published
 * them stays unable to outlive the takeover.
 */
const WITHHELD_DESCRIPTORS = Object.freeze(['executionInstructions', 'sandboxMode', 'timeout'])

/** Read a registered service without declaring an injection requirement. */
function readService(ctx, name) {
  if (typeof ctx?.get === 'function') return ctx.get(name)
  return ctx?.[name]
}

function descriptorsMatch(left, right) {
  if (left === undefined || right === undefined) return left === right
  return left.value === right.value
    && left.get === right.get
    && left.set === right.set
    && left.writable === right.writable
    && left.enumerable === right.enumerable
    && left.configurable === right.configurable
}

/**
 * Build the seam handle for one live execution service.
 * @param {object} service - the registered `ctx.ptcRuntime` or `ctx.codeRuntime`.
 * @param {string} serviceName - the service name it was registered under.
 */
export function createExecutionSeam(service, serviceName) {
  if (service === null || typeof service !== 'object') {
    throw new TypeError(`ptc-plus: ${serviceName} must be an execution service object`)
  }
  const current = serviceName === EXECUTION_SEAM_SERVICE
  const upstreamRun = service.run
  if (typeof upstreamRun !== 'function') {
    throw new TypeError(`ptc-plus: ${serviceName}.run must be a function`)
  }
  const upstreamResolve = service.resolve
  if (current && typeof upstreamResolve !== 'function') {
    throw new TypeError('ptc-plus: ptcRuntime.resolve must be a function')
  }
  let installed
  return Object.freeze({
    serviceName,
    language: service.language,
    /**
     * Run one program through the provider this plugin wraps. The current
     * generation resolves the request before running it, exactly as its own
     * consumer does; the preceding generation accepts the request directly.
     */
    invokeUpstream(request) {
      return current
        ? upstreamRun.call(service, upstreamResolve.call(service, request))
        : upstreamRun.call(service, request)
    },
    /**
     * Install the plugin's execution entry, and its capability descriptors, on
     * the live service. Only one takeover is live at a time.
     * @param {(request: object) => Promise<object>} execute - the plugin's entry.
     * @returns {() => void} restores every descriptor this call replaced.
     */
    takeOver(execute) {
      if (installed !== undefined) throw new Error('ptc-plus: execution seam already taken over')
      const saved = new Map()
      const written = new Map()
      const requested = new Map()
      requested.set('run', {
        configurable: true,
        writable: true,
        value: current
          ? spec => execute({
              program: spec.program,
              bindings: spec.bindings,
              signal: spec.signal,
            })
          : request => execute(request),
      })
      for (const name of WITHHELD_DESCRIPTORS) {
        requested.set(name, { configurable: true, value: name === 'executionInstructions' ? '' : undefined })
      }
      const extensible = Object.isExtensible(service)
      for (const [name, descriptor] of requested) {
        const previous = Object.getOwnPropertyDescriptor(service, name)
        saved.set(name, previous)
        const next = { enumerable: previous?.enumerable ?? false, ...descriptor }
        requested.set(name, next)
        const probe = {}
        if (previous !== undefined) Object.defineProperty(probe, name, previous)
        if (!extensible) Object.preventExtensions(probe)
        Object.defineProperty(probe, name, next)
      }
      try {
        for (const [name, descriptor] of requested) {
          Object.defineProperty(service, name, descriptor)
          written.set(name, Object.getOwnPropertyDescriptor(service, name))
        }
      } catch (error) {
        for (const name of [...written.keys()].reverse()) {
          if (!descriptorsMatch(Object.getOwnPropertyDescriptor(service, name), written.get(name))) continue
          const descriptor = saved.get(name)
          if (descriptor === undefined) delete service[name]
          else Object.defineProperty(service, name, descriptor)
        }
        throw error
      }
      const restore = () => {
        if (installed !== restore) return
        installed = undefined
        for (const [name, descriptor] of saved) {
          if (!descriptorsMatch(Object.getOwnPropertyDescriptor(service, name), written.get(name))) continue
          if (descriptor === undefined) delete service[name]
          else Object.defineProperty(service, name, descriptor)
        }
      }
      installed = restore
      return restore
    },
  })
}

/**
 * Wait for the host's execution seam and attach the plugin to the live one.
 *
 * The current service is preferred whenever both are live; the preceding
 * generation attaches only when the current one is absent, and a current
 * service registered later retires the live legacy injection before attaching.
 * The injected scope requires the plugin's own core
 * services as well, so the callback receives a context the plugin can work in,
 * and everything the plugin registers there belongs to the seam the host
 * registered: unloading that service unloads the plugin, and registering it
 * again attaches once more, which is how a host that reloads its runtime
 * provider reloads this dependent.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - `services` are the plugin's own required services,
 *   and `attach` is invoked with the injected scope and the seam handle.
 *   `attachmentTimeoutMs` bounds the wait for a seam that never appears.
 * @returns {Promise<void>} settles after attachment with a valid Cordis effect value.
 */
export function installExecutionSeam(ctx, {
  services = [],
  attach,
  reportFailure,
  attachmentTimeoutMs = SEAM_ATTACHMENT_TIMEOUT_MS,
}) {
  let live
  let stopping = false
  let startWatcher
  let unusableCurrent
  const report = (error, name) => {
    try {
      reportFailure?.(error, name)
    } catch {
      // A reporting failure cannot replace the seam failure it describes.
    }
  }
  const registerLifecycle = (entry, name, scope) => scope.effect?.(() => () => {
    if (live !== entry) return
    if (entry.retiring !== undefined) return
    live = undefined
    if (!stopping && name === EXECUTION_SEAM_SERVICE
      && readService(ctx, EXECUTION_SEAM_SERVICE) === undefined
      && readService(ctx, LEGACY_EXECUTION_SEAM_SERVICE) !== undefined) {
      startWatcher(LEGACY_EXECUTION_SEAM_SERVICE)
    }
  }, 'ptc-plus execution seam lifecycle')
  const select = (name, scope) => {
    const currentService = readService(ctx, EXECUTION_SEAM_SERVICE)
    if (unusableCurrent !== undefined && currentService !== unusableCurrent) {
      unusableCurrent = undefined
    }
    if (name === EXECUTION_SEAM_SERVICE && currentService === unusableCurrent) {
      // A current service whose attach already failed cannot supersede the live
      // legacy attachment. A replacement service object clears the marker above.
      return live?.attached
    }
    if (live !== undefined) {
      if (name !== EXECUTION_SEAM_SERVICE || live.name === EXECUTION_SEAM_SERVICE) return live.attached
      const previous = live
      if (previous.retiring !== undefined) return previous.retiring
      const disposeLegacy = previous.scope?.fiber?.dispose
      if (typeof disposeLegacy !== 'function') {
        throw new Error('ptc-plus: live codeRuntime attachment cannot be superseded without a disposable injected scope')
      }
      let resolveActivation
      let rejectActivation
      const activation = new Promise((resolve, reject) => {
        resolveActivation = resolve
        rejectActivation = reject
      })
      previous.retiring = activation
      let retirement
      try {
        retirement = disposeLegacy.call(previous.scope.fiber)
      } catch (error) {
        previous.retiring = undefined
        rejectActivation(error)
        return activation
      }
      let entry
      const operation = Promise.resolve(retirement).then(() => {
        if (live !== previous) return undefined
        previous.retiring = undefined
        entry = { name, scope }
        live = entry
        registerLifecycle(entry, name, scope)
        const attached = attach(scope, createExecutionSeam(scope?.[name] ?? readService(ctx, name), name))
        entry.attached = attached
        return attached
      })
      operation.then(resolveActivation, error => {
        if (live === previous) previous.retiring = undefined
        else if (live === entry) {
          // The current attach failed after the legacy fiber was retired. Keep
          // the plugin attached by re-arming the preceding generation instead
          // of silently returning run_code to the host provider.
          live = undefined
          unusableCurrent = readService(ctx, EXECUTION_SEAM_SERVICE)
          if (readService(ctx, LEGACY_EXECUTION_SEAM_SERVICE) !== undefined) {
            try {
              startWatcher(LEGACY_EXECUTION_SEAM_SERVICE)
            } catch (fallbackError) {
              report(fallbackError, LEGACY_EXECUTION_SEAM_SERVICE)
            }
          }
        }
        report(error, name)
        rejectActivation(error)
      })
      return activation
    }
    if (name === LEGACY_EXECUTION_SEAM_SERVICE
      && currentService !== undefined
      && currentService !== unusableCurrent) {
      return undefined
    }
    const entry = { name, scope }
    live = entry
    try {
      entry.attached = attach(scope, createExecutionSeam(scope?.[name] ?? readService(ctx, name), name))
    } catch (error) {
      live = undefined
      throw error
    }
    registerLifecycle(entry, name, scope)
    return entry.attached
  }
  startWatcher = (name, settlement) => ctx.inject([...services, name], scope => {
    let selected
    try {
      selected = select(name, scope)
    } catch (error) {
      settlement?.reject(error)
      report(error, name)
      throw error
    }
    if (selected !== null && typeof selected === 'object' && typeof selected.then === 'function') {
      const operation = Promise.resolve(selected)
      operation.then(
        value => settlement?.resolve(value),
        error => settlement?.reject(error),
      )
      return operation.then(() => undefined)
    }
    settlement?.resolve(selected)
    return undefined
  })
  const pending = SEAM_SERVICES.map(name => new Promise((resolve, reject) => {
    startWatcher(name, { resolve, reject })
  }))
  ctx.effect?.(() => () => { stopping = true }, 'ptc-plus execution seam watcher lifecycle')
  const bound = seamWaitBound(ctx, attachmentTimeoutMs)
  return Promise.race([Promise.race(pending), bound.promise])
    .then(() => undefined)
    .finally(bound.cancel)
}

/**
 * Bound the wait for a seam the deployment never registers.
 *
 * @param {object} ctx - the plugin context owning the timer.
 * @param {number} timeoutMs - positive bound, or a non-positive value for none.
 * @returns the rejection promise and the disposer that clears its timer.
 */
function seamWaitBound(ctx, timeoutMs) {
  if (!(timeoutMs > 0)) return { promise: new Promise(() => {}), cancel: () => {} }
  let timer
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `ptc-plus: no host execution seam (${SEAM_SERVICES.join(' or ')}) is registered; this deployment does not publish a code runtime`,
    )), timeoutMs)
  })
  // The timer is not unref'd: this rejection is the only thing that settles the
  // activation promise on a deployment that never registers a seam, and an
  // unref'd timer would let the process drain before it fires. It is cleared as
  // soon as the race settles so an attached seam never holds the loop open.
  const cancel = () => clearTimeout(timer)
  ctx.effect?.(() => () => cancel(), 'ptc-plus execution seam wait bound')
  return { promise, cancel }
}
