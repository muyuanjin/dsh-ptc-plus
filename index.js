/**
 * Session-bound REPL for DeepSeek Harness PTC mode.
 *
 * DSH's run_code bridge does not pass session identity to the execution seam it
 * calls. The tools/execute around-hook carries that identity into the runtime
 * bridge, which redirects only those runs to a persistent per-session kernel.
 */

import Schema from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { createDirectSurfaceOwner } from './internal/direct-surface-owner.js'
import { CapabilityStatisticsStore } from './internal/capability-statistics-store.js'
import { createCapabilityEnvironment } from './internal/capability-environment.js'
import { capabilityCommandReceipt } from './internal/capability-command-receipt.js'
import { toolSdkSchemas } from './internal/program-bindings.js'
import { createRuntimeMessageOwner, handBackRuntimeSessions } from './internal/runtime-contexts.js'
import { createSessionLogOwner } from './internal/session-log-view.js'
import { PTC_DELIVERY_CONTEXT } from './internal/runtime-messages.js'
import { createCordisToolsOwner } from './internal/cordis-tools-owner.js'
import { createEditTransportOwner, EDIT_RUN_CODE } from './internal/edit-transport-owner.js'
import { createRuntimeBridgeOwner, RUN_CODE } from './internal/runtime-bridge-owner.js'
import { resolveConfig, watchVolatileConfig } from './internal/runtime-config.js'
import { configureRetention } from './internal/projection-retention.js'
import {
  CONFIG_FIELDS,
  SETTINGS_NAMESPACE,
} from './internal/config-spec.js'
import { configFieldSchema, installSettingsSectionCompat } from './internal/settings-compat.js'
import { installExecutionSeam } from './internal/execution-seam-compat.js'
import { createDeferredRuntime, defersToOfficialRepl } from './internal/official-repl-priority.js'
import { valueLimitsFromConfig } from './internal/value-wire-schema.js'
import { createReplMemoryProjection } from './internal/repl-memory-projection.js'
import { createUserBindingDraftProjection } from './internal/user-binding-draft-projection.js'
import { createUserBindingsOwner } from './internal/user-bindings-owner.js'
import { latestBindingAdoption } from './internal/binding-adoption.js'
import { createHostRpc } from './internal/host-rpc.js'
import { RPC_CONTRACTS } from './internal/rpc-contract.js'
import { createReplObservationInterest } from './internal/repl-observation-interest.js'
import { guidancePolicies } from './internal/binding-update-policy.js'
import { PROMPT_SLOT_IDS, resolvePromptTextConfig } from './internal/prompt-text.js'
import * as dshSettings from '@deepseek-ai/dsh-settings'

const INSTALL_CLEANUP = Symbol('ptc-plus install cleanup')

/** Plugin name used by loader diagnostics. */
export const name = 'ptc-plus'

export const Config = Schema.object(Object.fromEntries(
  CONFIG_FIELDS.map(field => [
    field.key,
    // Runtime limits and behavior exposed to Cordis configuration. The shape
    // each field takes is owned by the installed settings generation.
    configFieldSchema({ Schema, field, settingsModule: dshSettings }),
  ]),
))

/**
 * Core services required by the plugin. Optional authoring services are
 * injected on demand. The execution seam is not listed here: the host registers
 * it under the service name of one generation, so `installExecutionSeam`
 * selects the live one.
 */
export const inject = ['tools', 'systemPrompt', 'agents']

function replGuidance({ bindingPolicy, rewritesEnabled, languageSemantics, durableReplay, cordisToolsEnabled }, promptText) {
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
      ? 'Declarations and assignments update the same logical binding within its scope, including const, functions, classes and imports. A bare declaration preserves an existing value. A declaration publishes its bindings after its whole pattern initializes; assignments preserve partial writes. Imports follow their module until locally overwritten; importing again changes that same binding source. Existing closures observe later updates, while saved values retain their identity.'
      : 'Redeclaration protection is enabled: existing session names cannot be redeclared, and newly created const and import bindings reject assignment. Other declarations follow native scope rules. Previously writable bindings stay writable.'}`
  const recovery = durableReplay
    ? 'Direct Node/OS access remains live but is not replayed after a kernel restart.'
    : 'Durable replay is disabled for this profile. Bindings remain reusable only in the current process; a new kernel starts empty.'
  const cordisRecovery = cordisToolsEnabled
    ? 'Keep large Cordis plugin source in a binding before the tool call so it can be reused after an error. A Cordis parse or validation failure can follow external effects; repeat the call only when its retry rules and current results establish that it is safe.'
    : ''
  // Each paragraph is an editable asset; a derived policy sentence is appended to
  // the paragraph that owns it, so rewriting prose can never contradict the
  // configuration that produced it. Omitting a paragraph keeps its derived clause.
  const prose = id => (promptText.omitted(id) ? '' : promptText.text(id))
  const withDerived = (id, derived) => {
    const base = prose(id)
    return base === '' ? derived : `${base} ${derived}`
  }
  const paragraphs = [
    prose(PROMPT_SLOT_IDS.guidanceOpening),
    prose(PROMPT_SLOT_IDS.guidanceErrorRecovery),
    withDerived(PROMPT_SLOT_IDS.guidanceCellConventions, cellConventions),
    prose(PROMPT_SLOT_IDS.guidanceCapabilities),
    withDerived(PROMPT_SLOT_IDS.guidanceExecutionWorld, `${recovery}${cordisToolsEnabled ? ` ${cordisRecovery}` : ''}`),
  ]
  return paragraphs.filter(paragraph => paragraph.trim().length > 0).join('\n\n')
}

/** Register the session-bound REPL runtime. */
function installPtCRuntime(ctx, resolvedConfig, seam, toolSchemasForAgent, toolSdkSchemasForAgent, sessionId, sessionLog, settingsForCommand) {
  const presentationGeneration = randomUUID()
  const replMemoryProjection = createReplMemoryProjection(presentationGeneration)
  const userBindingDraftProjection = createUserBindingDraftProjection(presentationGeneration)
  let activeConfig = resolvedConfig
  let cordisTools
  let cordisToolsReady = false
  const cordisOwners = new Set()
  let runtimeBridge
  let editTransport
  let directSurface
  let capabilityEnvironment
  let userBindings
  let observationInterest
  let ready
  let pendingCordisActivation
  let draftProjectionRegistration
  let draftProjectionAvailable = false
  let projectionService
  const disposers = []
  const disposedOwners = new Set()
  let disposed = false
  let disposal
  function dispose() {
    disposed = true
    pendingCordisActivation?.cancel()
    if (disposal !== undefined) return disposal
    const tasks = []
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      const cleanup = disposers[index]
      if (typeof cleanup !== 'function') continue
      tasks.push({
        run: cleanup,
        complete: () => { if (disposers[index] === cleanup) disposers[index] = undefined },
      })
    }
    for (const owner of [directSurface, editTransport, runtimeBridge, userBindings]) {
      if (typeof owner?.dispose !== 'function' || disposedOwners.has(owner)) continue
      tasks.push({ run: () => owner.dispose(), complete: () => disposedOwners.add(owner) })
    }
    for (const owner of cordisOwners) {
      tasks.push({
        run: () => owner.dispose(),
        complete: () => {
          cordisOwners.delete(owner)
          if (cordisTools === owner) {
            cordisTools = undefined
            cordisToolsReady = false
          }
        },
      })
    }
    const attempts = tasks.map(task => {
      try {
        return Promise.resolve(task.run())
      } catch (error) {
        return Promise.reject(error)
      }
    })
    const operation = Promise.allSettled(attempts)
      .then(results => {
        const failures = []
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]
          if (result.status === 'fulfilled') tasks[index].complete()
          else failures.push(result.reason)
        }
        if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus runtime disposal failed')
      })
    disposal = operation
    operation.then(
      () => { if (disposal === operation) disposal = undefined },
      () => { if (disposal === operation) disposal = undefined },
    )
    return operation
  }
  const disposeCordisToolsOwner = async (owner) => {
    await owner.dispose()
    cordisOwners.delete(owner)
    if (cordisTools === owner) {
      cordisTools = undefined
      cordisToolsReady = false
    }
  }
  const disposeRetainedCordisTools = async () => {
    const owners = [...cordisOwners]
    const results = await Promise.allSettled(owners.map(owner => disposeCordisToolsOwner(owner)))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus: retained Cordis disposal failed')
  }
  const awaitCordisToolsOwner = async (owner, cancelled) => {
    try {
      await Promise.race([owner.ready, cancelled])
      if (cordisTools === owner) cordisToolsReady = true
      return owner
    } catch (error) {
      let rollbackError
      try {
        await disposeCordisToolsOwner(owner)
      } catch (caught) {
        rollbackError = caught
      }
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
    await disposeRetainedCordisTools()
    if (disposed) throw new Error('ptc-plus: Cordis activation cancelled')
    const owner = createCordisToolsOwner(ctx)
    cordisOwners.add(owner)
    let cancel
    const cancelled = new Promise((_resolve, reject) => {
      cancel = () => reject(new Error('ptc-plus: Cordis activation cancelled'))
    })
    const activation = { owner, cancel }
    cordisTools = owner
    cordisToolsReady = false
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
    if (draftProjectionRegistration !== undefined) {
      if (draftProjectionAvailable) return
      await draftProjectionRegistration()
    }
    if (projectionService === undefined) return
    const unregister = registerProjection(userBindingDraftProjection, 'binding draft')
    if (unregister === undefined) return
    let active = true
    let releasing
    const release = () => {
      if (!active) return Promise.resolve()
      if (releasing !== undefined) return releasing
      const operation = Promise.resolve().then(unregister)
      releasing = operation
      operation.then(
        () => {
          active = false
          if (draftProjectionRegistration === release) draftProjectionRegistration = undefined
          if (releasing === operation) releasing = undefined
        },
        () => { if (releasing === operation) releasing = undefined },
      )
      return operation
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
    cordisTools = activeConfig.cordisToolsEnabled ? createCordisToolsOwner(ctx) : undefined
    if (cordisTools !== undefined) {
      const initialCordisTools = cordisTools
      cordisOwners.add(initialCordisTools)
      ready = awaitCordisToolsOwner(initialCordisTools, new Promise(() => {}))
    }
    userBindings = createUserBindingsOwner(ctx, {
      readSessionLog: sessionLog.read,
      enabled: activeConfig.userBindingsEnabled,
      draftProjectionAvailable,
      // A session's adoption is its own recorded decision, so it is read from
      // that session's log instead of a process-local map.
      bindingAdoptionForAgent: agent => latestBindingAdoption(sessionLog.project(agent)?.ptcMessages ?? []),
      maxWallMs: activeConfig.maxWallMs,
      maxOutputBytes: activeConfig.maxOutputBytes,
      maxOldGenerationSizeMb: activeConfig.maxOldGenerationSizeMb,
      workerReclaimMs: activeConfig.workerReclaimMs,
      valueLimits: valueLimitsFromConfig(activeConfig),
    })
    capabilityEnvironment = createCapabilityEnvironment({ ctx, config: activeConfig,
      toolSchemasForAgent: toolSdkSchemasForAgent, modelSchemasForAgent: toolSchemasForAgent,
      store: new CapabilityStatisticsStore({ ctx }) })
    runtimeBridge = createRuntimeBridgeOwner({
      ctx,
      seam,
      observeSession: id => observationInterest.has(id),
      readSessionLog: sessionLog.read,
      sessionConfig: activeConfig,
      userBindingsCwd: userBindings.cwd,
      maxNestedRunCodeDepth: activeConfig.maxNestedRunCodeDepth,
      presentationGeneration,
      sessionId,
      toolSchemasForAgent: toolSdkSchemasForAgent,
      capabilityEnvironment,
      userBindingDraftForAgent: agent => userBindings.draftCapabilityForAgent(agent),
      bindingSubmissionForAgent: (agent, ensureLease, onAccepted) => userBindings.submissionForAgent(agent, ensureLease, onAccepted),
    })
    editTransport = createEditTransportOwner(ctx, {
      readSessionLog: runtimeBridge.readNestedDispatchLog,
      sessionLogView: sessionLog.project,
      durableReplay: activeConfig.durableReplay,
      executeTentative: runtimeBridge.executeTentative,
      canScheduleEdit: runtimeBridge.canScheduleEdit,
      scheduleEdit: runtimeBridge.scheduleEdit,
      presentationGeneration,
      sessionId,
      toolSchemasForAgent,
      promptText: resolvePromptTextConfig(activeConfig),
    })
    directSurface = createDirectSurfaceOwner({
      sessionLogView: sessionLog.project,
      editTransport,
      runtimeConfig: activeConfig,
      canonicalizeToolCalls: activeConfig.canonicalizeToolCalls,
      sessionId,
      toolSchemasForAgent,
      capabilityEnvironment,
      userBindingsForAgent: agent => userBindings.snapshotForAgent(agent),
      setAgentPresentation: (agent, presentation) => (
        userBindings.setAgentPresentation(agent, presentation)
      ),
    })
    disposers.push(ctx.systemPrompt.section({
      name: 'tools:ptc-plus-repl',
      order: 98,
      text: context => {
        if (ctx.tools.get(RUN_CODE, context?.scope) === undefined) return ''
        return replGuidance(guidancePolicies(activeConfig), resolvePromptTextConfig(activeConfig))
      },
    }))
    disposers.push(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const projected = await directSurface.assemble(assembly, context, next)
      if (ctx.tools.get(RUN_CODE, context?.agent) !== undefined) runtimeBridge.prepareAgent(context?.agent)
      return projected
    }))
    disposers.push(() => capabilityEnvironment.dispose())
    disposers.push(ctx.on('agent/pre-step', (payload, next) => capabilityEnvironment.preStep(payload, next), { prepend: true }))
    disposers.push(ctx.on('agent/created', ({ agent }) => {
      if (ctx.tools.get(RUN_CODE, agent) !== undefined) {
        runtimeBridge.prepareAgent(agent)
        editTransport.ensureInstalled(agent)
      }
    }))
    for (const agent of ctx.agents?.list?.() ?? []) {
      if (ctx.tools.get(RUN_CODE, agent) !== undefined) {
        runtimeBridge.prepareAgent(agent)
        editTransport.ensureInstalled(agent)
      }
    }
    disposers.push(ctx.on('tools/post-execute', (exec, result, next) => capabilityEnvironment.postExecute(exec, result, next), { prepend: true }))
    disposers.push(ctx.on('tools/ptc-dispatch-log', (dispatch, next) => capabilityEnvironment.dispatchLog(dispatch, next), { prepend: true }))
    disposers.push(ctx.on('agent/status', payload => { if (payload?.agent) capabilityEnvironment.status(payload.agent, payload.status) }))
    disposers.push(ctx.on('agent/created', ({ agent }) => capabilityEnvironment.status(agent, agent.status)))
    if (typeof ctx.inject === 'function') {
      const capabilitiesRpc = ctx.inject(['ptcPlusRpc'], scope => {
        scope.effect(() => scope.ptcPlusRpc.register(RPC_CONTRACTS.capabilities, async (operation, payload, signal) => {
          signal.throwIfAborted()
          if (operation === 'catalog') return { ok: true, value: await capabilityEnvironment.describeCatalog(signal) }
          if (operation === 'targets') return { ok: true, value: capabilityEnvironment.describeTargets() }
          if (operation === 'session-catalog') return { ok: true, value: await capabilityEnvironment.describeSessionCatalog(payload, signal) }
          if (operation === 'allocation') return { ok: true, value: await capabilityEnvironment.observeAllocation(payload, signal) }
          if (operation !== 'inspect') return { ok: false, error: { code: 'UNKNOWN_OPERATION', message: 'Unknown capability plan operation', details: null } }
          return { ok: true, value: capabilityEnvironment.describeSessions() }
        }), 'ptc-plus: capability plan observation')
      })
      if (typeof capabilitiesRpc === 'function') disposers.push(capabilitiesRpc)
      else if (typeof capabilitiesRpc?.dispose === 'function') disposers.push(() => capabilitiesRpc.dispose())
      const commands = ctx.inject(['commands'], scope => {
        scope.effect(() => scope.commands.register({ name: 'capabilities',
          description: 'Inspect, search or change session capabilities; global choices also save settings.',
          input: { hint: 'refresh | list [all|skills|tools|mcp|mcp_tools] [query] | set session|global <id> [availability|disclosure] <choice>' },
          handler: async ({ commandId, agent, rawInput, signal }) => {
            const input = rawInput.trim()
            const receipt = (state, error) => capabilityCommandReceipt(state, String(agent.session.id), error,
              state === 'pending' && capabilityEnvironment.pendingChoiceMessage(agent)
                ? { commandId, rawInput, message: capabilityEnvironment.pendingChoiceMessage(agent) } : undefined)
            const selection = /^set (session|global) (\S+) (?:(availability|disclosure) )?(full|on-demand|closed|automatic|inherit|enabled|host|adaptive)$/.exec(input)
            if (selection) {
              if (!capabilityEnvironment.canRefresh(agent)) return { kind: 'error', text: receipt('unavailable') }
              const changed = await capabilityEnvironment.change(agent, {
                scope: selection[1], id: decodeURIComponent(selection[2]), dimension: selection[3], selection: selection[4], commandId,
              }, signal, settingsForCommand?.())
              return { kind: changed.sessionApplied ? 'success' : 'error',
                text: receipt(changed.sessionApplied ? changed.publication === 'pending' ? 'pending' : 'recorded' : 'saved-only', changed.error) }
            }
            const listing = /^list(?: (all|skills|tools|mcp|mcp_tools))?(?: (.*))?$/.exec(input)
            if (listing) {
              const entries = await capabilityEnvironment.catalogFor(agent, signal)
              const query = (listing[2] ?? '').toLocaleLowerCase()
              const kind = listing[1] ?? 'all'
              return { kind: 'success', text: JSON.stringify({ schema: 'ptc-capability-catalog/v1', entries: entries.filter(entry => (
                kind === 'all' || kind === 'skills' && entry.category === 'skill'
                || kind === 'tools' && entry.category === 'tool' && entry.source?.kind !== 'mcp'
                || kind === 'mcp' && ['server', 'resource'].includes(entry.category)
                || kind === 'mcp_tools' && entry.category === 'tool' && entry.source?.kind === 'mcp'
              ) && (!query || `${entry.id} ${entry.description}`.toLocaleLowerCase().includes(query))) }) }
            }
            if (input !== '' && input !== 'refresh') return { kind: 'error', text: receipt('usage') }
            if (input === 'refresh') {
              if (!capabilityEnvironment.canRefresh(agent)) {
                return { kind: 'error', text: receipt('unavailable') }
              }
              await capabilityEnvironment.refresh(agent, undefined, signal, commandId)
              // A refresh always republishes the saved configuration; when that
              // configuration has capability management or context off, report
              // the off state instead of claiming an updated environment.
              const described = capabilityEnvironment.describe(agent)
              const state = described.effective?.enabled !== true
                ? described.sourceSettings?.contextEnabled === false ? 'paused' : 'off'
                : described.publication === 'pending' ? 'pending' : 'recorded'
              return { kind: 'success', text: receipt(state) }
            }
            return { kind: 'success', text: JSON.stringify(capabilityEnvironment.describe(agent), null, 2) }
          } }), 'ptc-plus capability command')
      })
      if (typeof commands === 'function') disposers.push(commands)
      else if (typeof commands?.dispose === 'function') disposers.push(() => commands.dispose())
    }
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
      if (exec.name === EDIT_RUN_CODE) return runtimeBridge.withSubmission(exec, next)
      capabilityEnvironment.validateSupply(exec.agent, exec.name, exec.arguments)
      capabilityEnvironment.admitted(exec)
      return next()
    }))
    disposers.push(ctx.on('tools/result', (exec, result) => {
      capabilityEnvironment.dispatched(exec, result)
      directSurface.handleResult(exec)
      if (exec.name === EDIT_RUN_CODE) return editTransport.handleResult(exec, result)
      if (exec.name === RUN_CODE) return runtimeBridge.handleResult(exec, result)
    }))
    const disposeLifecycleOwners = async (operations, message) => {
      const results = await Promise.allSettled(operations.map(operation => (
        Promise.resolve().then(operation)
      )))
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, message)
    }
    disposers.push(ctx.on('agent/disposed', ({ agent }) => disposeLifecycleOwners([
      () => directSurface.disposeAgent(agent),
      () => editTransport.disposeAgent(agent),
      () => runtimeBridge.disposeAgent(agent),
      () => userBindings.clearAgentPresentation(agent),
      () => capabilityEnvironment.disposeAgent(agent),
    ], 'ptc-plus: agent disposal failed')))
    disposers.push(ctx.on('session/disposed', session => disposeLifecycleOwners([
      () => directSurface.disposeSession(session),
      () => editTransport.disposeSession(session),
      () => runtimeBridge.disposeSession(session),
      () => userBindings.clearSessionPresentation(session?.id ?? session),
    ], 'ptc-plus: session disposal failed')))
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
    const failedRuntime = Object.freeze({ dispose })
    let failure = error
    if (failure === null || (typeof failure !== 'object' && typeof failure !== 'function')) {
      failure = new Error(String(error), { cause: error })
    }
    try {
      Object.defineProperty(failure, INSTALL_CLEANUP, { value: failedRuntime })
    } catch {
      failure = new Error(failure.message ?? String(failure), { cause: failure })
      Object.defineProperty(failure, INSTALL_CLEANUP, { value: failedRuntime })
    }
    throw failure
  }
  async function reconfigure(nextConfig) {
    if (disposed) return
    const previousConfig = activeConfig
    const rollbacks = []
    try {
      runtimeBridge.reconfigure(nextConfig)
      rollbacks.push(() => runtimeBridge.reconfigure(previousConfig))
      directSurface.reconfigure(nextConfig)
      rollbacks.push(() => directSurface.reconfigure(previousConfig))
      await userBindings.reconfigure(nextConfig)
      rollbacks.push(() => userBindings.reconfigure(previousConfig))
      await setDraftProjectionEnabled(nextConfig.userBindingsEnabled)
      rollbacks.push(() => setDraftProjectionEnabled(previousConfig.userBindingsEnabled))

      if (nextConfig.cordisToolsEnabled && cordisTools !== undefined && !cordisToolsReady) {
        await disposeRetainedCordisTools()
      }
      if (nextConfig.cordisToolsEnabled && cordisTools === undefined) {
        await activateCordisToolsOwner()
      } else if (!nextConfig.cordisToolsEnabled && cordisTools !== undefined) {
        const currentCordis = cordisTools
        cordisToolsReady = false
        try {
          await disposeCordisToolsOwner(currentCordis)
        } catch (error) {
          try {
            await disposeCordisToolsOwner(currentCordis)
            await activateCordisToolsOwner()
          /* c8 ignore next */
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'ptc-plus: Cordis reconfiguration and rollback failed', { cause: error })
          }
          throw error
        }
      }
      activeConfig = nextConfig
      capabilityEnvironment.reconfigure(nextConfig)
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
export const apply = (ctx, config = {}) => {
  // Configuration is validated before the plugin waits for the host's seam, so
  // an unusable configuration fails at the load call rather than later.
  const resolvedConfig = resolveConfig(config)
  // The retention window is user configuration; install it before any fold can run.
  configureRetention(resolvedConfig)
  return installExecutionSeam(ctx, {
    services: inject,
    attachmentTimeoutMs: resolvedConfig.executionSeamTimeoutMs,
    attach: (scope, seam) => applyWithExecutionSeam(scope, resolvedConfig, seam, ctx, config),
    reportFailure: (error, seamName) => ctx.logger?.warn?.(
      `ptc-plus: execution seam ${seamName} failed to attach`,
      error,
    ),
  })
}

/** Install the plugin into the scope of the seam the host registered. */
function applyWithExecutionSeam(ctx, resolvedConfig, seam, volatileHost, volatileConfig) {
  let settingsWriter
  const sessionLog = createSessionLogOwner(ctx)
  const toolSchemasForAgent = agent => typeof ctx.tools.schemas === 'function'
    ? ctx.tools.schemas(agent)
    : []
  // SDK contracts include output schemas; model-facing schemas remain unchanged.
  const toolSdkSchemasForAgent = agent => toolSdkSchemas(ctx.tools, agent)
  const sessionId = agent => {
    const id = agent?.session?.id ?? agent?.id
    return id === undefined ? undefined : String(id)
  }
  let committed
  let activating
  const retained = new Set()
  let disposed = false
  let controllerDisposal
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
    if (record?.disposed === true) return Promise.resolve()
    if (record?.disposal !== undefined) return record.disposal
    retained.add(record)
    const operation = Promise.resolve().then(() => record.runtime.dispose())
    record.disposal = operation
    operation.then(
      () => {
        record.disposed = true
        retained.delete(record)
        if (record.disposal === operation) record.disposal = undefined
      },
      () => { if (record.disposal === operation) record.disposal = undefined },
    )
    return operation
  }
  const disposeRetainedRuntimes = async () => {
    const records = [...retained].filter(record => record.runtime !== undefined)
    const results = await Promise.allSettled(records.map(record => disposeRuntime(record)))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus retained runtime disposal failed')
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
  // Execution ownership is a per-attachment property: `owned` installs the
  // session runtime, `deferred` leaves run_code to the official provider.
  const executionShape = nextConfig => (
    defersToOfficialRepl(nextConfig, seam.provider) ? 'deferred' : 'owned'
  )
  const startActivation = record => {
    if (record.cancelled || disposed || activating !== record) {
      record.completion.resolve({ status: 'superseded' })
      return
    }
    if (seam.language !== 'typescript') {
      throw new Error('ptc-plus: unsupported code runtime language ' + JSON.stringify(seam.language) + '; only "typescript" is supported')
    }
    let candidate
    try {
      candidate = record.shape === 'deferred'
        ? createDeferredRuntime()
        : installPtCRuntime(ctx, record.config, seam, toolSchemasForAgent, toolSdkSchemasForAgent, sessionId, sessionLog, () => settingsWriter)
      record.runtime = candidate
    } catch (error) {
      const failedRuntime = error?.[INSTALL_CLEANUP]
      if (failedRuntime === undefined) throw error
      record.runtime = failedRuntime
      const trackedCleanup = trackTransition(disposeRuntime(record))
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
      shape: executionShape(nextConfig),
      runtime: undefined,
      disposal: undefined,
      disposed: false,
      retiring: false,
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
        cancelActivation(activating)
        const cleanup = disposeRetainedRuntimes()
        return beginActivation(nextConfig, generation, cleanup)
      }
      if (committed === undefined) {
        const cleanup = retained.size === 0 ? undefined : disposeRetainedRuntimes()
        return beginActivation(nextConfig, generation, cleanup)
      }
      if (committed.retiring) {
        const current = committed
        void disposeRuntime(current)
        const cleanup = disposeRetainedRuntimes().then(() => {
          if (committed === current) committed = undefined
        })
        return beginActivation(nextConfig, generation, cleanup)
      }
      const current = committed
      if (current.shape !== executionShape(nextConfig)) {
        // Ownership changes are installation changes: dispose the live kernels
        // and install the other shape, so no committed cell can mix the two
        // execution contracts or extend state the new owner cannot see.
        current.retiring = true
        void disposeRuntime(current)
        const cleanup = disposeRetainedRuntimes()
        return beginActivation(nextConfig, generation, cleanup)
      }
      if (!nextConfig.cordisToolsEnabled) current.runtime.cancelCordisActivation()
      return enqueueTransition(async () => {
        if (disposed || committed !== current) return { status: 'superseded' }
        await current.runtime.reconfigure(nextConfig)
        current.config = nextConfig
        current.generation = generation
        return { status: 'applied' }
      })
    },
    async uninstall() {
      const active = activating
      const activationCleanup = active === undefined
        ? Promise.resolve()
        : cancelActivation(active)
      const current = committed
      if (current !== undefined) current.retiring = true
      const committedCleanup = current === undefined
        ? Promise.resolve()
        : trackTransition(disposeRuntime(current))
      const records = [...retained].filter(record => (
        record !== current && record !== active && record.runtime !== undefined
      ))
      const results = await Promise.allSettled([
        activationCleanup,
        committedCleanup,
        ...records.map(record => disposeRuntime(record)),
      ])
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (current?.disposed === true && committed === current) committed = undefined
      if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus runtime uninstall failed')
    },
    committedConfig() {
      return committed?.retiring ? undefined : committed?.config
    },
    dispose() {
      disposed = true
      if (controllerDisposal !== undefined) return controllerDisposal
      const operation = controller.uninstall()
      controllerDisposal = operation
      operation.then(
        () => { if (controllerDisposal === operation) controllerDisposal = undefined },
        () => { if (controllerDisposal === operation) controllerDisposal = undefined },
      )
      return operation
    },
  }
  ctx.effect(() => async () => controller.dispose(), 'ptc-plus runtime lifecycle')

  const handbackOwners = Object.fromEntries(['sessions', 'sessionPersistence', 'sessionQuery'].map(name => [name, ctx.get(name)]))
  // One spelling of "the current document": the same resolved configuration the
  // reconciliation loop applies, so a delivered message and the assembled prompt can
  // never read two different prompt-text documents. Read lazily: the settings section
  // replaces `configSource` after activation.
  const currentPromptText = () => resolvePromptTextConfig(configSource())
  const messageOwner = createRuntimeMessageOwner(context => (
    committed?.retiring ? [] : committed?.runtime.contextsForRequest(context) ?? []
  ), sessionLog.project, () => committed !== undefined && committed.retiring !== true, handbackOwners.sessionQuery,
  currentPromptText)
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
  ctx.effect(() => async () => {
    await controller.dispose()
    await handBackRuntimeSessions(ctx, handbackOwners)
  }, 'ptc-plus provider handback')

  // The settings section replaces this source after activation; the prompt-text
  // accessor above reads it lazily for exactly that reason.
  let configSource = () => resolveConfig(volatileConfig ?? resolvedConfig)
  let configurationGeneration = 0
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
        await settingsWriter.update(patch)
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
    configureRetention(current)
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
      ownerFiber: volatileHost.fiber,
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
      onProvider(_provider, writer) {
        settingsWriter = writer
        return () => { if (settingsWriter === writer) settingsWriter = undefined }
      },
    })
  }
  ctx.effect(() => seam.onSourceChange(() => {
    const current = resolveConfig(configSource())
    configureRetention(current)
    if (!current.enabled) return undefined
    if (seam.language !== 'typescript') {
      const language = seam.language
      const cleanup = controller.uninstall()
      reportActivationFailure(new Error('ptc-plus: unsupported code runtime language '
        + JSON.stringify(language) + '; only "typescript" is supported'))
      return cleanup
    }
    return reconcile(true)
  }), 'ptc-plus original language lifecycle')
  watchVolatileConfig(volatileHost, ctx, volatileConfig, () => reconcile())
  if (configurationGeneration === 0) return reconcile(settingsWriter === undefined)
}
