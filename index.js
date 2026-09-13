/**
 * Session-bound REPL for DeepSeek Harness PTC mode.
 *
 * DSH's run_code bridge does not pass session identity to CodeRuntime.run().
 * The tools/execute around-hook carries that identity into the runtime bridge,
 * which redirects only those runs to a persistent per-session kernel.
 */

import Schema from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { createDirectSurfaceOwner } from './internal/direct-surface-owner.js'
import { createRuntimeMessageOwner } from './internal/runtime-contexts.js'
import { PTC_DELIVERY_CONTEXT } from './internal/runtime-messages.js'
import { createCordisToolsOwner } from './internal/cordis-tools-owner.js'
import { createEditTransportOwner, EDIT_RUN_CODE } from './internal/edit-transport-owner.js'
import { createRuntimeBridgeOwner, RUN_CODE } from './internal/runtime-bridge-owner.js'
import { resolveConfig } from './internal/runtime-config.js'
import {
  CONFIG_FIELDS,
  SETTINGS_NAMESPACE,
} from './internal/config-spec.js'
import { installSettingsSectionCompat } from './internal/settings-compat.js'
import { valueLimitsFromConfig } from './internal/value-wire-schema.js'
import { createReplMemoryProjection } from './internal/repl-memory-projection.js'
import { createUserBindingDraftProjection } from './internal/user-binding-draft-projection.js'
import { createUserBindingsOwner } from './internal/user-bindings-owner.js'
import { createHostRpc } from './internal/host-rpc.js'
import { createReplObservationInterest } from './internal/repl-observation-interest.js'
import { guidancePolicies } from './internal/binding-update-policy.js'
import * as dshSettings from '@deepseek-ai/dsh-settings'

const INSTALL_CLEANUP = Symbol('ptc-plus install cleanup')

/** Plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Runtime limits and behavior exposed to Cordis configuration. */
function configSchemaField(field) {
  const base = field.type === 'boolean'
    ? Schema.boolean().default(field.default)
    : field.type === 'enum'
      // Keep omission visible until resolveConfig migrates legacy policies.
      ? Schema.union(field.options.map(option => Schema.const(option)))
      : Schema.number().step(1).min(field.min).max(field.max).default(field.default)
  return base.description(field.description)
}

export const Config = Schema.object(Object.fromEntries(
  CONFIG_FIELDS.map(field => [field.key, configSchemaField(field)]),
))

/** Core services required by the plugin. Optional authoring services are injected on demand. */
export const inject = ['tools', 'codeRuntime', 'systemPrompt', 'agents', 'llm']

function replGuidance({ bindingPolicy, rewritesEnabled, languageSemantics, durableReplay, cordisToolsEnabled }) {
  const looseTopLevelRedeclarations = bindingPolicy.variableRedeclarations
  const looseTopLevelFunctionClassRedeclarations = bindingPolicy.functionClassRedeclarations
  const autoRewriteImports = rewritesEnabled.autoRewriteImports
  const autoStripExports = rewritesEnabled.autoStripExports
  const autoSplitRedeclarations = rewritesEnabled.autoSplitRedeclarations
  const variableRedeclaration = looseTopLevelRedeclarations
    ? 'Repeated top-level `const`/`let` declarations replace existing bindings.'
    : 'Repeated top-level variable declarations fail before execution, so reuse existing bindings or place one-off declarations inside a block.'
  const functionClassRedeclaration = looseTopLevelFunctionClassRedeclarations
    ? 'Repeated top-level named `function`/`class` declarations replace existing writable bindings at their declaration position. Do not rely on function hoisting or class TDZ; define a replacement before using that name in the cell.'
    : 'Repeated top-level `function`/`class` declarations remain unsupported; assign a function or class expression to an existing writable binding, or place one-off declarations inside a block.'
  const moduleSyntax = autoRewriteImports && autoStripExports
    ? 'static `import` declarations are adapted with live, read-only bindings and top-level `export` modifiers are stripped automatically.'
    : autoRewriteImports
      ? 'static `import` declarations are adapted with live, read-only bindings; top-level `export` modifiers remain unsupported.'
      : autoStripExports
        ? 'top-level `export` modifiers are stripped automatically; static `import` declarations remain unsupported.'
        : 'static `import` declarations and top-level `export` modifiers remain unsupported.'
  const splitSyntax = autoSplitRedeclarations
    ? 'Mixed new/existing top-level destructuring is split automatically while preserving assignment semantics.'
    : 'Mixed new/existing top-level destructuring remains unsupported; separate the declaration from the assignment.'
  const cellConventions = languageSemantics === 'legacy-v1'
    ? `Cells are async function bodies; ${moduleSyntax} Use dynamic import or require explicitly when static module syntax is unsupported. ${variableRedeclaration} ${functionClassRedeclaration} ${splitSyntax}`
    : `Cells support TypeScript, top-level await, return, static import and top-level export. ${languageSemantics === 'stateful-v1'
      ? 'Declarations and assignments update the same logical binding within its scope, including const, functions, classes and imports. A bare declaration preserves an existing value. A declaration publishes its bindings after its whole pattern initializes; explicit assignments preserve actual partial writes. Imports follow their module until locally overwritten; importing again changes that same binding source. Existing closures observe later updates, while saved values retain their identity.'
      : 'Redeclaration protection is enabled: existing session names cannot be redeclared, and newly created const and import bindings reject assignment. Other declarations follow native scope rules. Previously writable bindings stay writable.'}`
  const recovery = durableReplay
    ? 'Direct Node/OS access remains live but is not replayed after a kernel restart.'
    : 'Durable replay is disabled for this profile. Bindings remain reusable only in the current process; a new kernel starts empty.'
  const cordisRecovery = cordisToolsEnabled
    ? 'Keep large Cordis plugin source in a binding before the tool call so it can be reused after an error. A Cordis parse or validation failure can follow external effects; repeat the call only when its retry rules and current results establish that it is safe.'
    : ''
  return `\`run_code\` continues one persistent PTC REPL. Ordinary top-level bindings remain available to later cells, so reuse them instead of resending setup code. Choose the smallest cell that answers the request and return only the value the next step needs.

After an execution error, earlier statements may have taken effect. Inspect relevant values in a short cell and continue from them; repeat external operations only when their retry rules and current results establish that it is safe. \`edit_run_code\` edits and reruns a complete cell.

## Cell conventions
Use \`return\` for an explicit result and \`console\` for logs. Keep large inspection results in bindings or reduce them to targeted excerpts: \`tools.read\` is bounded inspection, not a lossless whole-file reader. ${cellConventions}

## Available capabilities
Use \`capabilities.tree()\`, \`capabilities.find()\`, and \`capabilities.inspect()\` for unfamiliar program APIs. Prefer direct current-cell work; reserve \`code.run\` for isolated execution of source held as data.
Program API references expire when their cell ends. Reusable helpers must read the current namespace when called, for example \`async function readNow(args) { return tools.read(args) }\`, rather than retaining an earlier \`tools\` object or method. Background callbacks from completed cells cannot call program APIs.

Native tool availability, executable names, shells, and path syntax depend on the current DSH profile and execution world; inspect them instead of assuming Windows, WSL, POSIX, or a particular shell. ${recovery}${cordisToolsEnabled ? ` ${cordisRecovery}` : ''}`
}

/** Register the session-bound REPL runtime. */
function installPtCRuntime(ctx, resolvedConfig, toolSchemasForAgent, sessionId) {
  const presentationGeneration = randomUUID()
  const replMemoryProjection = createReplMemoryProjection(presentationGeneration)
  const userBindingDraftProjection = createUserBindingDraftProjection(presentationGeneration)
  let activeConfig = resolvedConfig
  let cordisTools
  let runtimeBridge
  let editTransport
  let directSurface
  let userBindings
  let observationInterest
  let ready
  let pendingCordisActivation
  let draftProjectionRegistration
  let draftProjectionAvailable = false
  let projectionService
  const disposers = []
  let disposed = false
  async function dispose() {
    if (disposed) return
    disposed = true
    pendingCordisActivation?.cancel()
    const failures = []
    for (const dispose of [...disposers].reverse()) {
      if (typeof dispose !== 'function') continue
      try {
        await dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const owner of [directSurface, editTransport, runtimeBridge, userBindings, cordisTools]) {
      try {
        await owner?.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus runtime disposal failed')
  }
  const awaitCordisToolsOwner = async (owner, cancelled) => {
    try {
      await Promise.race([owner.ready, cancelled])
      return owner
    } catch (error) {
      let rollbackError
      try {
        await owner.dispose()
      } catch (caught) {
        rollbackError = caught
      }
      if (cordisTools === owner) cordisTools = undefined
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [error, rollbackError],
          'ptc-plus: Cordis activation and rollback failed',
          { cause: error },
        )
      }
      throw error
    }
  }
  const activateCordisToolsOwner = async () => {
    const owner = createCordisToolsOwner(ctx)
    let cancel
    const cancelled = new Promise((_resolve, reject) => {
      cancel = () => reject(new Error('ptc-plus: Cordis activation cancelled'))
    })
    const activation = { owner, cancel }
    cordisTools = owner
    pendingCordisActivation = activation
    try {
      return await awaitCordisToolsOwner(owner, cancelled)
    } finally {
      if (pendingCordisActivation === activation) pendingCordisActivation = undefined
    }
  }
  const cancelCordisActivation = () => pendingCordisActivation?.cancel()
  const registerProjection = (projection, label) => {
    try {
      const unregister = projectionService?.register?.(projection)
      if (typeof unregister !== 'function') {
        throw new Error('ptc-plus: sessionProjections.register did not return a disposer')
      }
      return unregister
    } catch (error) {
      ctx.logger?.warn?.(`ptc-plus: ${label} projection unavailable`, error)
      return undefined
    }
  }
  const setDraftProjectionEnabled = async (enabled) => {
    if (!enabled) {
      const unregister = draftProjectionRegistration
      draftProjectionRegistration = undefined
      draftProjectionAvailable = false
      const results = await Promise.allSettled([
        Promise.resolve().then(() => userBindings?.setDraftProjectionAvailable(false)),
        Promise.resolve().then(() => unregister?.()),
      ])
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length > 0) {
        throw new AggregateError(failures, 'ptc-plus: binding draft projection cleanup failed')
      }
      return
    }
    if (draftProjectionRegistration !== undefined || projectionService === undefined) return
    const unregister = registerProjection(userBindingDraftProjection, 'binding draft')
    if (unregister === undefined) return
    let active = true
    const release = async () => {
      if (!active) return
      active = false
      if (draftProjectionRegistration === release) draftProjectionRegistration = undefined
      await unregister()
    }
    draftProjectionRegistration = release
    disposers.push(release)
    draftProjectionAvailable = true
    try {
      await userBindings?.setDraftProjectionAvailable(true)
    } catch (error) {
      draftProjectionAvailable = false
      await Promise.allSettled([
        Promise.resolve().then(() => userBindings?.setDraftProjectionAvailable(false)),
        release(),
      ])
      throw error
    }
  }
  try {
    const hostRpc = createHostRpc(ctx)
    disposers.push(() => hostRpc.dispose())
    observationInterest = createReplObservationInterest(ctx, activeConfig.replViewEnabled,
      (id, memory, signal) => runtimeBridge?.observeRepl(id, memory, signal))
    disposers.push(() => observationInterest.dispose())
    if (typeof ctx.inject === 'function') {
      const projectionInjection = ctx.inject(['sessionProjections'], (scope) => {
        if (disposed) return
        const service = scope.sessionProjections
        projectionService = service
        draftProjectionRegistration = undefined
        draftProjectionAvailable = false
        const unregisterMemory = registerProjection(replMemoryProjection, 'REPL memory')
        if (unregisterMemory !== undefined) disposers.push(unregisterMemory)
        void setDraftProjectionEnabled(activeConfig.userBindingsEnabled).catch(error => {
          ctx.logger?.warn?.('ptc-plus: binding draft projection unavailable', error)
        })
        scope.effect?.(() => async () => {
          if (projectionService !== service) return
          projectionService = undefined
          await setDraftProjectionEnabled(false)
        }, 'ptc-plus: binding draft projection availability')
      })
      if (typeof projectionInjection === 'function') {
        disposers.push(projectionInjection)
      } else if (typeof projectionInjection?.dispose === 'function') {
        disposers.push(() => projectionInjection.dispose())
      }
    }
    cordisTools = activeConfig.cordisToolsEnabled
      ? createCordisToolsOwner(ctx)
      : undefined
    if (cordisTools !== undefined) {
      const initialCordisTools = cordisTools
      ready = awaitCordisToolsOwner(initialCordisTools, new Promise(() => {})).catch(error => {
        if (cordisTools === initialCordisTools) cordisTools = undefined
        throw error
      })
    }
    userBindings = createUserBindingsOwner(ctx, {
      enabled: activeConfig.userBindingsEnabled,
      draftProjectionAvailable,
      maxWallMs: activeConfig.maxWallMs,
      maxOutputBytes: activeConfig.maxOutputBytes,
      maxOldGenerationSizeMb: activeConfig.maxOldGenerationSizeMb,
      valueLimits: valueLimitsFromConfig(activeConfig),
    })
    runtimeBridge = createRuntimeBridgeOwner({
      ctx,
      observeSession: id => observationInterest.has(id),
      sessionConfig: activeConfig,
      userBindingsCwd: userBindings.cwd,
      maxNestedRunCodeDepth: activeConfig.maxNestedRunCodeDepth,
      presentationGeneration,
      sessionId,
      toolSchemasForAgent,
      userBindingDraftForAgent: agent => userBindings.draftCapabilityForAgent(agent),
      bindingSubmissionForAgent: (agent, ensureLease, onAccepted) => userBindings.submissionForAgent(agent, ensureLease, onAccepted),
    })
    editTransport = createEditTransportOwner(ctx, {
      durableReplay: activeConfig.durableReplay,
      executeTentative: runtimeBridge.executeTentative,
      presentationGeneration,
      sessionId,
      toolSchemasForAgent,
    })
    directSurface = createDirectSurfaceOwner({
      editTransport,
      runtimeConfig: activeConfig,
      canonicalizeToolCalls: activeConfig.canonicalizeToolCalls,
      sessionId,
      toolSchemasForAgent,
      userBindingsForAgent: () => userBindings.snapshot(),
      setAgentPresentation: (agent, presentation) => (
        userBindings.setAgentPresentation(agent, presentation)
      ),
    })
    disposers.push(ctx.systemPrompt.section({
      name: 'tools:ptc-plus-repl',
      order: 98,
      text: context => {
        if (ctx.tools.get(RUN_CODE, context?.scope) === undefined) return ''
        return replGuidance(guidancePolicies(activeConfig))
      },
    }))
    disposers.push(ctx.on('system-prompt/assemble', (assembly, context, next) => (
      directSurface.assemble(assembly, context, next)
    )))
    disposers.push(ctx.on('llm/stream', (options, next) => directSurface.stream(options, next), { global: true }))
    disposers.push(ctx.on('tools/execute', (exec, next) => {
      const rejected = directSurface.executionRejection(exec)
      if (rejected !== undefined) return rejected
      if (exec.name === RUN_CODE) {
        const executionArguments = directSurface.executionArguments(exec)
        const requestUserBindings = directSurface.executionUserBindings(exec)
        return Promise.resolve(runtimeBridge.handleExecute(
          exec,
          next,
          executionArguments,
          requestUserBindings,
        ))
          .then(result => directSurface.argumentDiagnostic(exec, result))
      }
      return next()
    }))
    disposers.push(ctx.on('tools/result', (exec, result) => {
      directSurface.handleResult(exec)
      if (exec.name === EDIT_RUN_CODE) return editTransport.handleResult(exec, result)
      if (exec.name === RUN_CODE) return runtimeBridge.handleResult(exec, result)
    }))
    disposers.push(ctx.on('agent/disposed', async ({ agent }) => {
      directSurface.disposeAgent(agent)
      editTransport.disposeAgent(agent)
      await Promise.all([
        runtimeBridge.disposeAgent(agent),
        userBindings.clearAgentPresentation(agent),
      ])
    }))
    disposers.push(ctx.on('session/disposed', async (session) => {
      directSurface.disposeSession(session)
      editTransport.disposeSession(session)
      await Promise.all([
        runtimeBridge.disposeSession(session),
        userBindings.clearSessionPresentation(session?.id ?? session),
      ])
    }))
    disposers.push(ctx.on('agent-preset/selected', (sessionId) => {
      directSurface.resetSessionComposition(sessionId)
      const agent = ctx.agents?.get?.(String(sessionId))
      if (agent !== undefined) editTransport.disposeAgent(agent)
      const cleanup = agent === undefined
        ? userBindings.clearSessionPresentation(sessionId)
        : userBindings.setAgentPresentation(agent)
      const report = ctx.logger?.warn?.bind(
        ctx.logger,
        'ptc-plus: failed to reconcile Global User Bindings authoring after preset selection',
      ) ?? console.warn
      void cleanup.catch(report)
    }))
  } catch (error) {
    const cleanup = dispose()
    if (error !== null && typeof error === 'object') {
      Object.defineProperty(error, INSTALL_CLEANUP, { value: cleanup })
    }
    throw error
  }
  async function reconfigure(nextConfig) {
    if (disposed) return
    const previousConfig = activeConfig
    const rollbacks = []
    try {
      runtimeBridge.reconfigure(nextConfig)
      rollbacks.push(() => runtimeBridge.reconfigure(previousConfig))
      editTransport.reconfigure(nextConfig)
      rollbacks.push(() => editTransport.reconfigure(previousConfig))
      directSurface.reconfigure(nextConfig)
      rollbacks.push(() => directSurface.reconfigure(previousConfig))
      await userBindings.reconfigure(nextConfig)
      rollbacks.push(() => userBindings.reconfigure(previousConfig))
      await setDraftProjectionEnabled(nextConfig.userBindingsEnabled)
      rollbacks.push(() => setDraftProjectionEnabled(previousConfig.userBindingsEnabled))

      if (nextConfig.cordisToolsEnabled && cordisTools === undefined) {
        await activateCordisToolsOwner()
      } else if (!nextConfig.cordisToolsEnabled && cordisTools !== undefined) {
        const currentCordis = cordisTools
        try {
          await currentCordis.dispose()
          cordisTools = undefined
        } catch (error) {
          try {
            await activateCordisToolsOwner()
          /* c8 ignore next */
          } catch (rollbackError) {
            cordisTools = currentCordis
            throw new AggregateError([error, rollbackError], 'ptc-plus: Cordis reconfiguration and rollback failed', { cause: error })
          }
          throw error
        }
      }
      activeConfig = nextConfig
      observationInterest.reconfigure(nextConfig.replViewEnabled)
    } catch (error) {
      const rollbackFailures = []
      /* c8 ignore next -- the rollback loop's rejection branch is host-specific. */
      for (const rollback of rollbacks.reverse()) {
        try {
          await rollback()
        /* c8 ignore next */
        } catch (rollbackError) { rollbackFailures.push(rollbackError) }
      }
      /* c8 ignore next */
      if (rollbackFailures.length > 0) { throw new AggregateError([error, ...rollbackFailures], 'ptc-plus: live runtime reconfiguration rollback failed', { cause: error }) }
      throw error
    }
  }

  return Object.freeze({
    cancelCordisActivation, dispose, reconfigure, ready,
    contextsForRequest: context => directSurface.contextsForRequest(context),
  })
}

/** Register the session-bound REPL runtime. */
export function apply(ctx, config = {}) {
  const resolvedConfig = resolveConfig(config)
  const toolSchemasForAgent = agent => typeof ctx.tools.schemas === 'function'
    ? ctx.tools.schemas(agent)
    : []
  const sessionId = agent => {
    const id = agent?.session?.id ?? agent?.id
    return id === undefined ? undefined : String(id)
  }
  let committed
  let activating
  let disposed = false
  let transitionTail = Promise.resolve()
  let pendingTransitions = 0
  const trackTransition = operation => {
    pendingTransitions += 1
    const tracked = Promise.resolve(operation)
    transitionTail = Promise.allSettled([tracked])
    const settle = () => { pendingTransitions -= 1 }
    tracked.then(settle, settle)
    return tracked
  }
  const enqueueTransition = task => {
    const operation = transitionTail.then(task, task)
    return trackTransition(operation)
  }
  const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    return { promise, resolve, reject }
  }
  const disposeRuntime = record => {
    if (record?.disposal !== undefined) return record.disposal
    record.disposal = record.runtime.dispose()
    return record.disposal
  }
  const activationError = (error, cleanupError) => new AggregateError(
    [error, cleanupError],
    'ptc-plus: runtime activation and cleanup failed',
    { cause: error },
  )
  const cancelActivation = record => {
    if (record === undefined) return Promise.resolve()
    record.cancelled = true
    if (activating === record) activating = undefined
    const cleanup = record.runtime === undefined ? Promise.resolve() : disposeRuntime(record)
    if (record.runtime !== undefined && record.trackedDisposal === undefined) {
      record.trackedDisposal = trackTransition(cleanup)
    }
    cleanup.then(
      () => record.completion.resolve({ status: 'superseded' }),
      error => record.completion.reject(error),
    )
    return cleanup
  }
  const startActivation = record => {
    if (record.cancelled || disposed || activating !== record) {
      record.completion.resolve({ status: 'superseded' })
      return
    }
    if (ctx.codeRuntime.language !== 'typescript') {
      throw new Error('ptc-plus: unsupported code runtime language ' + JSON.stringify(ctx.codeRuntime.language) + '; only "typescript" is supported')
    }
    let candidate
    try {
      candidate = installPtCRuntime(ctx, record.config, toolSchemasForAgent, sessionId)
      record.runtime = candidate
    } catch (error) {
      const cleanup = error?.[INSTALL_CLEANUP]
      if (cleanup === undefined) throw error
      const trackedCleanup = trackTransition(cleanup)
      void trackedCleanup.then(
        () => record.completion.reject(error),
        cleanupError => record.completion.reject(activationError(error, cleanupError)),
      )
      if (activating === record) activating = undefined
      return
    }
    const promote = () => {
      if (record.cancelled || disposed || activating !== record) return
      activating = undefined
      committed = record
      record.completion.resolve({ status: 'applied' })
    }
    if (candidate.ready === undefined) {
      promote()
      return
    }
    void Promise.resolve(candidate.ready).then(promote, async error => {
      if (record.cancelled) return
      const cleanup = disposeRuntime(record)
      const trackedCleanup = record.trackedDisposal === undefined
        ? (record.trackedDisposal = trackTransition(cleanup))
        : record.trackedDisposal
      if (activating === record) activating = undefined
      try {
        await trackedCleanup
      } catch (cleanupError) {
        record.completion.reject(activationError(error, cleanupError))
        return
      }
      record.completion.reject(error)
    })
  }
  const beginActivation = (nextConfig, generation, prerequisite) => {
    const completion = deferred()
    const record = {
      config: nextConfig,
      generation,
      runtime: undefined,
      disposal: undefined,
      trackedDisposal: undefined,
      cancelled: false,
      completion,
    }
    activating = record
    const start = () => startActivation(record)
    if (prerequisite !== undefined || pendingTransitions > 0) {
      void enqueueTransition(async () => {
        if (prerequisite !== undefined) await prerequisite
        start()
      }).catch(error => {
        if (activating === record) activating = undefined
        completion.reject(error)
      })
    } else {
      try {
        start()
      } catch (error) {
        if (activating === record) activating = undefined
        throw error
      }
    }
    return completion.promise
  }
  const controller = {
    apply(nextConfig, generation) {
      if (disposed) return Promise.resolve({ status: 'superseded' })
      if (activating !== undefined) {
        const cleanup = cancelActivation(activating)
        return beginActivation(nextConfig, generation, cleanup)
      }
      if (committed === undefined) return beginActivation(nextConfig, generation)
      const current = committed
      if (!nextConfig.cordisToolsEnabled) current.runtime.cancelCordisActivation()
      return enqueueTransition(async () => {
        if (disposed || committed !== current) return { status: 'superseded' }
        await current.runtime.reconfigure(nextConfig)
        current.config = nextConfig
        current.generation = generation
        return { status: 'applied' }
      })
    },
    uninstall() {
      const activationCleanup = activating === undefined
        ? Promise.resolve()
        : cancelActivation(activating)
      const current = committed
      committed = undefined
      const committedCleanup = current === undefined
        ? Promise.resolve()
        : trackTransition(disposeRuntime(current))
      return Promise.all([activationCleanup, committedCleanup]).then(() => undefined)
    },
    committedConfig() {
      return committed?.config
    },
    async dispose() {
      disposed = true
      await controller.uninstall()
    },
  }
  ctx.effect(() => async () => controller.dispose(), 'ptc-plus runtime lifecycle')

  const messageOwner = createRuntimeMessageOwner(context => (
    committed?.runtime.contextsForRequest(context) ?? []
  ))
  ctx.effect(() => ctx.systemPrompt.context({
    name: PTC_DELIVERY_CONTEXT, order: 98, text: '',
  }), 'ptc-plus dynamic message delivery witness')
  ctx.effect(() => ctx.on('system-prompt/assemble', (assembly, context, next) => (
    messageOwner.assemble(assembly, context, next)
  )), 'ptc-plus message assembly')
  ctx.effect(() => ctx.on('agent/pre-step', (payload, next) => (
    messageOwner.preStep(payload, next)
  )), 'ptc-plus accepted messages')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => messageOwner.disposeAgent(agent)), 'ptc-plus message agent disposal')
  ctx.effect(() => () => messageOwner.dispose(), 'ptc-plus dynamic message lifecycle')

  let configSource = () => resolvedConfig
  let configurationGeneration = 0
  let settingsWriter
  let configurationRollback = false
  const reportActivationFailure = (error) => {
    ctx.logger?.warn?.('ptc-plus: runtime activation failed', error)
  }
  const handleConfigurationFailure = async (error, generation) => {
    reportActivationFailure(error)
    if (generation !== configurationGeneration || configurationRollback) return
    configurationRollback = true
    try {
      if (settingsWriter?.update === undefined) return
      const previousConfig = controller.committedConfig()
      const patch = previousConfig === undefined
        ? { enabled: false }
        : Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, previousConfig[field.key]]))
      try {
        await settingsWriter.update(SETTINGS_NAMESPACE, patch)
      } catch (rollbackError) {
        reportActivationFailure(new Error(
          `ptc-plus: failed to roll back runtime configuration: ${rollbackError.message}`,
          { cause: error },
        ))
      }
    } finally {
      configurationRollback = false
    }
  }
  const reconcile = (propagateFailure = false) => {
    const current = resolveConfig(configSource())
    const generation = ++configurationGeneration
    if (!current.enabled) {
      const operation = controller.uninstall()
      if (propagateFailure) return operation
      void operation.catch(error => reportActivationFailure(new Error(
          `ptc-plus: runtime disable failed: ${error.message}`,
          { cause: error },
      )))
      return
    }
    if (configurationRollback) return
    try {
      const operation = Promise.resolve(controller.apply(current, generation))
      if (propagateFailure) {
        return operation.catch(error => {
          reportActivationFailure(error)
          throw error
        })
      }
      void operation.catch(error => handleConfigurationFailure(error, generation))
    } catch (error) {
      if (settingsWriter === undefined) throw error
      void handleConfigurationFailure(error, generation)
    }
  }
  if (typeof ctx.inject === 'function') {
    installSettingsSectionCompat({
      ctx,
      settingsModule: dshSettings,
      namespace: SETTINGS_NAMESPACE,
      schema: Config,
      entry: resolvedConfig,
      hooks: {
        setSource(source) {
          configSource = source
        },
        onChange: reconcile,
      },
      onProvider(provider) {
        settingsWriter = provider
      },
    })
  }
  if (configurationGeneration === 0) return reconcile(settingsWriter === undefined)
}
