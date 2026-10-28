/**
 * Host tool-surface shapes.
 *
 * Three host facts differ between lines and none is a release number:
 *
 * 1. Which package renders model-facing tool schemas. One line publishes
 *    `jsonSchemaToTs`, `renderToolsSdk`, `jsonSchemaToPy` and `CodeRunFailedError`
 *    from the PTC tool executor and stops exporting them from the tool registry;
 *    earlier lines publish them only from the registry. A static import from
 *    either path makes the plugin fail to load on the other, so the binding is
 *    resolved once, at load time, from whichever package actually provides it.
 *
 * 2. Which package publishes the registry error classes. The renderer and the
 *    error class moved independently, so each is resolved from the package that
 *    exports it rather than from the bundle that provided its neighbour.
 *
 * 3. Which surface publishes the reserved `run_code` transport definition. A
 *    registry host registers the definition and answers `tools.get(name)`. An
 *    executor host reserves the name instead and keeps the definition inside the
 *    executor that dispatches through it. Both surfaces expose the same
 *    definition shape, so the binding is resolved by that shape rather than by a
 *    version or by an accessor's name.
 */
const RENDERER_CANDIDATES = [
  '@deepseek-ai/dsh-tool-executor-ptc',
  '@deepseek-ai/dsh-tools',
]
const REGISTRY_CANDIDATES = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tool-executor-ptc',
]

const loaded = new Map()
async function loadCandidate(specifier) {
  if (loaded.has(specifier)) return loaded.get(specifier)
  let module
  try {
    module = await import(specifier)
  } catch {
    // The package is absent on this host; the caller tries the next candidate.
    module = undefined
  }
  loaded.set(specifier, module)
  return module
}

/**
 * Resolve one capability from the first package that publishes it.
 *
 * A capability that no installed package publishes is a load failure of this
 * plugin, not a degraded mode: the renderers and the registry error classes have
 * no fallback that preserves their contract. The loader is injectable so the
 * diagnostic can be proven without uninstalling a package from the checkout.
 * @param {string[]} specifiers - candidate package specifiers, most specific first.
 * @param {string} kind - what is being resolved, for the diagnostic.
 * @param {(candidate: object) => boolean} accepts - whether a module publishes it.
 * @param {(specifier: string) => Promise<object|undefined>} [load] - module loader.
 * @returns {Promise<{api: object, specifier: string}>} the publishing package.
 */
async function resolveExport(specifiers, kind, accepts, load = loadCandidate) {
  for (const specifier of specifiers) {
    const candidate = await load(specifier)
    if (candidate !== undefined && accepts(candidate)) return { api: candidate, specifier }
  }
  throw new Error(`ptc-plus: no host package provides ${kind}`)
}

const renderers = await resolveExport(RENDERER_CANDIDATES, 'the tool schema renderers',
  candidate => typeof candidate.jsonSchemaToTs === 'function' && typeof candidate.renderToolsSdk === 'function')
const errors = await resolveExport(REGISTRY_CANDIDATES, 'the tool registry error classes',
  candidate => typeof candidate.ToolNotFoundError === 'function')

/** The resolver above, for the load-failure diagnostic a host without either package reports. */
export { resolveExport as resolveHostExport }

export const hostToolSdkPackage = renderers.specifier
export const jsonSchemaToTs = renderers.api.jsonSchemaToTs
export const renderToolsSdk = renderers.api.renderToolsSdk
export const ToolNotFoundError = errors.api.ToolNotFoundError

/** Executor-published transports, resolved once per executor and transport name. */
const executorTransports = new WeakMap()

/**
 * A transport an executor hands to its dispatch pipeline. The executor's own
 * accessors are untyped, so identification needs the complete published
 * definition: the reserved name, a dispatch function, and a rendering output.
 */
function isPublishedTransport(candidate, name) {
  return candidate !== null && typeof candidate === 'object'
    && candidate.name === name
    && typeof candidate.execute === 'function'
    && candidate.output !== null && typeof candidate.output === 'object'
    && typeof candidate.output.render === 'function'
}

/**
 * Read the executor a scope currently dispatches to.
 * @param {object} tools - the host tool registry (`ctx.tools`).
 * @param {object} scope - the viewing agent, preset or scope key.
 * @returns {object|undefined} the selected executor, or undefined when the host
 *   has no executor surface or none is selected for this scope.
 */
export function hostToolExecutor(tools, scope) {
  if (typeof tools?.selectExecutor !== 'function') return undefined
  try {
    return tools.selectExecutor(scope) ?? undefined
  } catch {
    // No executor is selected for this scope, or its selection was withdrawn.
    return undefined
  }
}

/** Accessors that change executor lifecycle are never definition readers. */
const LIFECYCLE_ACCESSORS = new Set([
  'dispose', 'destroy', 'reset', 'close', 'start', 'stop', 'release', 'execute', 'describe',
])

/**
 * The zero-argument accessors an executor publishes. A definition the executor
 * dispatches through is not registered, so the executor must expose it for its
 * own pipeline; every such accessor returns without arguments and without
 * changing execution state, which is what distinguishes it from `describe` and
 * `execute`. Lifecycle members are skipped even when they take no arguments, so
 * a probe can never dispose, stop or reset a host executor.
 */
function* transportAccessors(executor) {
  const seen = new Set()
  for (let owner = executor; owner !== null && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    for (const key of Object.getOwnPropertyNames(owner)) {
      if (key === 'constructor' || seen.has(key)) continue
      seen.add(key)
      if (LIFECYCLE_ACCESSORS.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      // A getter is a zero-argument reader of the same shape as a method.
      const accessor = typeof descriptor?.value === 'function' ? descriptor.value : descriptor?.get
      if (typeof accessor !== 'function' || accessor.length !== 0) continue
      yield accessor
    }
  }
}

/**
 * Whether this executor declares the reserved transport among the tools it
 * presents. Only a transport-owning executor is asked for its definition, so an
 * unrelated executor is never invoked at all.
 */
function executorOwnsTransport(executor, name) {
  if (typeof executor?.describe !== 'function') return false
  try {
    const described = executor.describe([])
    return Array.isArray(described?.knownNames) && described.knownNames.includes(name)
  } catch {
    // Describing with no visible definitions is how an executor that requires
    // them reports the limit; that is no evidence that it owns the transport.
    return false
  }
}

/**
 * Resolve the transport definition from the surface that publishes it.
 * @param {object} tools - the host tool registry (`ctx.tools`).
 * @param {object} scope - the owning agent or scope key.
 * @param {string} name - the reserved transport name.
 * @returns {object|undefined} the live definition, or undefined when this host
 *   publishes it on neither surface.
 */
export function hostTransportDefinition(tools, scope, name) {
  // The registry answers a lookup by the reserved name, so any definition it
  // returns is this host's transport. Whether it carries the projection the
  // plugin needs is the caller's diagnostic, not a reason to search elsewhere.
  const registered = typeof tools?.get === 'function' ? tools.get(name, scope) : undefined
  if (registered !== null && typeof registered === 'object') return registered
  const executor = hostToolExecutor(tools, scope)
  if (executor === undefined) return undefined
  const cached = executorTransports.get(executor)?.get(name)
  if (cached !== undefined) return cached
  if (!executorOwnsTransport(executor, name)) return undefined
  for (const accessor of transportAccessors(executor)) {
    let candidate
    try {
      candidate = accessor.call(executor)
    } catch {
      // An accessor may depend on a service this scope has not mounted yet;
      // that is no evidence about the surface, so keep probing.
      continue
    }
    if (!isPublishedTransport(candidate, name)) continue
    let byName = executorTransports.get(executor)
    if (byName === undefined) executorTransports.set(executor, byName = new Map())
    byName.set(name, candidate)
    return candidate
  }
  return undefined
}

/**
 * Whether this scope has session execution at all: the host publishes the
 * reserved transport on one of its surfaces. Every feature that can only work by
 * running a program asks this, so a host that keeps the transport inside its
 * tool executor enables them exactly like a host that registers it.
 * @param {object} tools - the host tool registry (`ctx.tools`).
 * @param {object} scope - the owning agent or scope key.
 * @param {string} [name] - the reserved transport name.
 * @returns {boolean} true when a program can be run for this scope.
 */
export function sessionExecutionAvailable(tools, scope, name = 'run_code') {
  return hostTransportDefinition(tools, scope, name) !== undefined
}

/**
 * Dispatch one tool call through the host registry.
 *
 * Two dispatch contracts are published. A registry host accepts one call and
 * resolves to that call's settled result. An executor host accepts a complete
 * model batch, assigns the execution identity itself, and resolves to the
 * ordered outcomes — so the caller supplies only the call it wants run, and the
 * executor's own token is the one its observers see.
 * @param {object} tools - the host tool registry (`ctx.tools`).
 * @param {object} execution - call identity, arguments, agent and signal.
 * @returns {Promise<object>} this call's settled result.
 */
export async function dispatchToolCall(tools, execution) {
  if (typeof tools?.selectExecutor !== 'function') return tools.execute(execution)
  const settled = await tools.execute({
    calls: [{ id: execution.callId, name: execution.name, arguments: JSON.stringify(execution.arguments) }],
    signal: execution.signal,
    ...(execution.agent === undefined ? {} : { agent: execution.agent }),
  })
  const matched = settled?.results?.find(entry => entry.callId === execution.callId)
  if (matched === undefined) {
    throw new Error('ptc-plus: the host batch dispatch returned no result for the requested call')
  }
  return matched.result
}
