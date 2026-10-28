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
 *    version. Which *member* of an executor is asked is a separate contract: only
 *    the readers named here are ever invoked, because every other member is host
 *    code this plugin does not own. An executor that declares the name and
 *    publishes no definition through those readers is reported as such rather than
 *    treated as a host without an executor.
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
  } catch (error) {
    // Absence lets the caller try the next candidate. A package that exists but
    // fails to initialise is a different fact: treating it as absent silently
    // substitutes another implementation, and reporting "no package provides this"
    // hides the real error from the operator.
    // "Cannot find package 'x'" means x is not installed. A module-not-found
    // raised from inside x means x resolved and then failed, which must stay loud.
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND'
    const absent = missing && String(error?.message ?? '').includes("Cannot find package '" + specifier + "'")
    if (absent) {
      module = undefined
    } else {
      throw new Error(`ptc-plus: host package ${specifier} failed to load: ${error?.message ?? String(error)}`, { cause: error })
    }
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

/**
 * The members a transport-owning executor publishes its reserved transport through,
 * in the order they are asked. Which surface publishes the definition is a shape
 * question, but *which member may be invoked* is not: an executor is host code, so
 * only members the plugin's published reader contract names are ever called. A
 * member that is not one of these readers is never a definition reader, however
 * many arguments it takes and whatever it returns.
 *
 * `requirePtcTransport` is the name the tool registry's own transport owner uses, so
 * an executor that keeps the definition for its dispatch pipeline publishes it under
 * the same name; the other two are the shorter spellings a host may publish instead.
 */
const TRANSPORT_READERS = Object.freeze(['requirePtcTransport', 'requireTransport', 'transport'])

/** Executors whose declared transport could not be read; a fact about the executor,
 * recorded so the caller can report the contract gap instead of "no executor". The
 * readers are still asked again on a later assembly, because a scope can mount the
 * service a reader depends on after the first one. */
const unreadableExecutors = new WeakSet()

/**
 * The reader an executor publishes under one of the contract's names, looking
 * through its prototype chain the way a class member is inherited.
 */
function transportReader(executor, name) {
  for (let owner = executor; owner !== null && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    if (descriptor === undefined) continue
    // A getter is a zero-argument reader of the same shape as a method.
    const accessor = typeof descriptor.value === 'function' ? descriptor.value : descriptor.get
    return typeof accessor === 'function' ? accessor : undefined
  }
  return undefined
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
  for (const reader of TRANSPORT_READERS) {
    const accessor = transportReader(executor, reader)
    if (accessor === undefined) continue
    let candidate
    try {
      candidate = accessor.call(executor)
    } catch {
      // A reader may require a service this scope has not mounted yet; that is no
      // evidence about the surface, so the next contracted reader still answers.
      continue
    }
    if (!isPublishedTransport(candidate, name)) continue
    unreadableExecutors.delete(executor)
    let byName = executorTransports.get(executor)
    if (byName === undefined) executorTransports.set(executor, byName = new Map())
    byName.set(name, candidate)
    return candidate
  }
  // The executor declares the transport and no contracted reader published it. That
  // is a contract gap between host and plugin, not an absent surface; it is recorded
  // so the gate can report which of the two facts holds.
  unreadableExecutors.add(executor)
  return undefined
}

/**
 * Whether this scope's executor declares the reserved transport but publishes no
 * definition this plugin can read.
 *
 * The gate treats that as "no session execution" — a transport must never be
 * invented — but it is not the same fact as a host without an executor, so callers
 * can report the gap instead of dropping every feature that needs execution
 * silently.
 * @param {object} tools - the host tool registry (`ctx.tools`).
 * @param {object} scope - the owning agent or scope key.
 * @param {string} [name] - the reserved transport name.
 * @returns {boolean} true when the host declares it and the definition is unreadable.
 */
export function hostTransportUnreadable(tools, scope, name = 'run_code') {
  const executor = hostToolExecutor(tools, scope)
  if (executor === undefined) return false
  const registered = typeof tools?.get === 'function' ? tools.get(name, scope) : undefined
  if (registered !== null && typeof registered === 'object') return false
  return executorOwnsTransport(executor, name)
    && executorTransports.get(executor)?.get(name) === undefined
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
 * Executions this plugin submitted under the host's batch dispatch contract.
 *
 * That contract assigns the execution identity itself, so the execution object a
 * host runs is not the one the caller built and carries no parent token the caller
 * could compare. The submission record is what remains: the call id this plugin
 * chose, which the host matched its result back to.
 */
const batchSubmissions = new WeakSet()

/**
 * Whether this execution was submitted as a host batch call.
 * @param {object} execution - an execution object this plugin built.
 * @returns {boolean} true when the batch contract dispatched it.
 */
export function isBatchSubmission(execution) {
  return execution !== null && typeof execution === 'object' && batchSubmissions.has(execution)
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
  // Recorded before the host runs the batch: it calls back into this plugin during
  // the dispatch, and the relation has to be provable then.
  batchSubmissions.add(execution)
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
