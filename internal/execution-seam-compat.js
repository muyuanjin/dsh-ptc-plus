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
      const define = (name, descriptor) => {
        const previous = Object.getOwnPropertyDescriptor(service, name)
        if (!saved.has(name)) saved.set(name, previous)
        // Preserve the shadowed property's visibility so a consumer that
        // enumerates the provider sees the same member set.
        Object.defineProperty(service, name, { enumerable: previous?.enumerable ?? false, ...descriptor })
        written.set(name, Object.getOwnPropertyDescriptor(service, name))
      }
      define('run', {
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
        define(name, { configurable: true, value: name === 'executionInstructions' ? '' : undefined })
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
 * A deployment registers one generation, so the current service is preferred
 * whenever both are live; the preceding generation attaches only when the
 * current one is absent. The injected scope requires the plugin's own core
 * services as well, so the callback receives a context the plugin can work in,
 * and everything the plugin registers there belongs to the seam the host
 * registered: unloading that service unloads the plugin, and registering it
 * again attaches once more, which is how a host that reloads its runtime
 * provider reloads this dependent.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - `services` are the plugin's own required services,
 *   and `attach` is invoked with the injected scope and the seam handle.
 * @returns {Promise<unknown>} settles with the attach result.
 */
export function installExecutionSeam(ctx, { services = [], attach }) {
  let live
  const select = (name, scope) => {
    if (live !== undefined) return live.attached
    if (name === LEGACY_EXECUTION_SEAM_SERVICE && readService(ctx, EXECUTION_SEAM_SERVICE) !== undefined) {
      return undefined
    }
    const entry = { name }
    live = entry
    try {
      entry.attached = attach(scope, createExecutionSeam(scope?.[name] ?? readService(ctx, name), name))
    } catch (error) {
      live = undefined
      throw error
    }
    scope.effect?.(() => () => {
      if (live === entry) live = undefined
    }, 'ptc-plus execution seam lifecycle')
    return entry.attached
  }
  const pending = SEAM_SERVICES.map(name => new Promise((resolve, reject) => {
    ctx.inject([...services, name], scope => {
      try {
        resolve(select(name, scope))
      } catch (error) {
        reject(error)
        throw error
      }
    })
  }))
  return Promise.race(pending)
}
