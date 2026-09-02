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
import { createCordisToolsOwner } from './internal/cordis-tools-owner.js'
import { createEditTransportOwner, EDIT_RUN_CODE } from './internal/edit-transport-owner.js'
import { createRuntimeBridgeOwner, RUN_CODE } from './internal/runtime-bridge-owner.js'
import { resolveConfig } from './internal/runtime-config.js'
import {
  CONFIG_FIELDS,
  SETTINGS_NAMESPACE,
} from './internal/config-spec.js'
import { installSettingsSectionCompat } from './internal/settings-compat.js'
import { createReplMemoryProjection } from './internal/repl-memory-projection.js'
import * as dshSettings from '@deepseek-ai/dsh-settings'

const INSTALL_CLEANUP = Symbol('ptc-plus install cleanup')

/** Plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

/** Runtime limits and behavior exposed to Cordis configuration. */
function configSchemaField(field) {
  const base = field.type === 'boolean'
    ? Schema.boolean().default(field.default)
    : Schema.number().step(1).min(field.min).max(field.max).default(field.default)
  return base.description(field.description)
}

export const Config = Schema.object(Object.fromEntries(
  CONFIG_FIELDS.map(field => [field.key, configSchemaField(field)]),
))

/** Services required by the plugin. */
export const inject = ['tools', 'codeRuntime', 'systemPrompt', 'agents', 'llm']

function replGuidance(
  looseTopLevelRedeclarations,
  durableReplay,
  autoRewriteImports,
  autoStripExports,
  autoSplitRedeclarations,
  cordisToolsEnabled,
) {
  const redeclaration = looseTopLevelRedeclarations
    ? 'Repeated top-level `const`/`let` declarations replace existing bindings.'
    : 'Redeclaring an existing top-level name fails before execution, so reuse it or place one-off declarations inside a block.'
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
  const recovery = durableReplay
    ? 'Direct Node/OS access remains live but is not replayed after a kernel restart.'
    : 'Durable replay is disabled for this profile. Bindings remain reusable only in the current process; a new kernel starts empty.'
  const cordisRecovery = cordisToolsEnabled
    ? 'When using Cordis tools, keep large host or client source in a top-level binding before the Cordis call. A Cordis parse or validation error is a runtime failure: bindings assigned before that failure remain live, so retry only the Cordis call with the existing binding instead of resending the source. Treat that binding as the read-only input for the retry.'
    : ''
  return `\`run_code\` continues one persistent PTC REPL. Ordinary top-level bindings remain available to later cells, so reuse them instead of resending setup code. Choose the smallest cell that answers the request and return only the value the next step needs.

The host may append a bounded recovery context after a qualifying failure. Treat that context as a session-log-derived diagnostic: use \`edit_run_code\` only when it explicitly proves a complete-cell rerun is safe; otherwise inspect live state in a new short \`run_code\` cell.

## Cell conventions
Expressions that are neither returned nor printed produce no output. Keep large inspection results in bindings or reduce them to targeted excerpts: \`tools.read\` is bounded inspection, not a lossless whole-file reader. Cells are async function bodies; ${moduleSyntax} Use dynamic import or require explicitly when static module syntax is unsupported. ${redeclaration} ${splitSyntax}

## Available capabilities
Use \`capabilities.tree()\`, \`capabilities.find()\`, and \`capabilities.inspect()\` to discover the current request's live \`tools.*\` members before calling an unfamiliar binding. Prefer direct current-cell work; reserve \`code.run\` for source already held as data.

Native tool availability, executable names, shells, and path syntax depend on the current DSH profile and execution world; inspect them instead of assuming Windows, WSL, POSIX, or a particular shell. ${recovery}${cordisToolsEnabled ? ` ${cordisRecovery}` : ''}`
}

/** Register the session-bound REPL runtime. */
function installPtCRuntime(ctx, resolvedConfig, toolSchemasForAgent, sessionId) {
  const presentationGeneration = randomUUID()
  const replMemoryProjection = createReplMemoryProjection(presentationGeneration)
  let activeConfig = resolvedConfig
  let cordisTools
  let runtimeBridge
  let editTransport
  let directSurface
  let ready
  let pendingCordisActivation
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
    for (const owner of [directSurface, editTransport, runtimeBridge, cordisTools]) {
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
  try {
    if (typeof ctx.inject === 'function') {
      const projectionInjection = ctx.inject(['sessionProjections'], (scope) => {
        if (disposed) return
        try {
          const unregister = scope.sessionProjections?.register?.(replMemoryProjection)
          if (typeof unregister !== 'function') {
            throw new Error('ptc-plus: sessionProjections.register did not return a disposer')
          }
          disposers.push(unregister)
        } catch (error) {
          ctx.logger?.warn?.('ptc-plus: REPL memory projection unavailable', error)
        }
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
    runtimeBridge = createRuntimeBridgeOwner({
      ctx,
      sessionConfig: activeConfig,
      maxNestedRunCodeDepth: activeConfig.maxNestedRunCodeDepth,
      presentationGeneration,
      sessionId,
      toolSchemasForAgent,
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
    })
    disposers.push(ctx.systemPrompt.section({
      name: 'tools:ptc-plus-repl',
      order: 98,
      text: context => {
        if (ctx.tools.get(RUN_CODE, context?.scope) === undefined) return ''
        return replGuidance(
          activeConfig.looseTopLevelRedeclarations,
          activeConfig.durableReplay,
          activeConfig.autoRewriteImports,
          activeConfig.autoStripExports,
          activeConfig.autoSplitRedeclarations,
          activeConfig.cordisToolsEnabled,
        )
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
        return Promise.resolve(runtimeBridge.handleExecute(exec, next, executionArguments))
          .then(result => directSurface.argumentDiagnostic(exec, result))
      }
      return next()
    }))
    disposers.push(ctx.on('tools/result', (exec, result) => {
      directSurface.handleResult(exec)
      if (exec.name === EDIT_RUN_CODE) return editTransport.handleResult(exec, result)
      if (exec.name === RUN_CODE) return runtimeBridge.handleResult(exec, result)
    }))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      directSurface.disposeAgent(agent)
      editTransport.disposeAgent(agent)
      return runtimeBridge.disposeAgent(agent)
    }))
    disposers.push(ctx.on('session/disposed', (session) => {
      directSurface.disposeSession(session)
      editTransport.disposeSession(session)
      return runtimeBridge.disposeSession(session)
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

  return Object.freeze({ cancelCordisActivation, dispose, reconfigure, ready })
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
