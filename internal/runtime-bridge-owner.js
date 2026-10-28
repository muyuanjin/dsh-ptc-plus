/** Own the execution-seam takeover, per-cell lease, journal projection, and session settlement. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { deepEqualJson, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { decodeValue, renderValueWire } from './value-wire.js'
import { valueLimitsFromConfig } from './value-wire-schema.js'
import { executionPolicies } from './binding-update-policy.js'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { normalizeBindingDescriptors } from './binding-descriptors.js'
import { SessionRuntime } from './session-runtime.js'
import {
  JOURNAL_KEY,
  RECOVERY_BOUNDARY_KEY,
  journalsEqual,
  recoveryBoundariesEqual,
  withRecoveryBoundaries,
  withJournal,
  withRewrites,
} from './session-journal.js'
import {
  capabilityFind,
  capabilityInspect,
  capabilityTree,
  createCapabilitySearcher,
  toolCapabilityMetadata,
} from './program-bindings.js'
import { deepFreeze } from './record-utils.js'
import { hostTransportDefinition } from './host-tool-sdk.js'
import { REPL_MEMORY_META_KEY, withReplMemorySnapshot } from './repl-memory-projection.js'
import { withUserBindingDraftCapability } from './user-binding-draft-projection.js'
import { POST_EDIT_KEY } from './session-journal-schema.js'
import { generatedRunCodeDescriptionMeta } from './run-code-description.js'
import { BINDING_SUBMISSION } from './user-binding-authoring.js'
import {
  USER_BINDINGS_META_KEY,
  userBindingsSnapshotsEqual,
  withUserBindingsSnapshot,
} from './user-bindings.js'

export const RUN_CODE = 'run_code'

const EDIT_RUN_CODE = 'edit_run_code'
const PLUGIN_PROGRAM_GLOBALS = new Set(['capabilities', 'code', 'repl'])

function nestedRunCodeArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('code.run expects an object with code and description strings')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('description')
    || keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))
    || typeof value.code !== 'string' || typeof value.description !== 'string') {
    throw new TypeError('code.run expects exactly code and description string properties')
  }
  return { code: value.code, description: value.description }
}

function namespace(global, functions, errorName, memberNameProperty) {
  return {
    global,
    functions,
    errorClass: { name: errorName, memberNameProperty },
  }
}

function schemaAcceptsEmptyObject(schema) {
  const parameters = schema?.parameters
  try {
    assertObjectJsonSchema(parameters)
  } catch {
    return false
  }
  return validateJsonSchemaValue(parameters, {}).length === 0
}

const PROGRAM_CAPABILITY_METADATA = deepFreeze([
  {
    namespace: 'repl',
    members: [{
      name: 'state',
      description: 'Manage named REPL checkpoints. list returns checkpoint names, not variable names. Save requires a durable cell; a volatile save rejection leaves live bindings usable. Save captures the final durable state of this cell, including subsequent mutations; it is lost if the cell becomes volatile or is discarded. Save, restore and delete take effect after cell settlement and journal confirmation, not when the receipt is awaited. Restore discards bindings beyond the selected durable state for subsequent cells; an omitted name selects the prior durable head, or an empty REPL if none exists. Restore does not undo external effects or change enabled binding configuration; subsequent cells may remain volatile.',
      parameters: {
        type: 'object',
        properties: {
          action: { enum: ['list', 'save', 'restore', 'delete'], description: 'list reads the current cell control view, including tentative names; mutations are accepted for settlement.' },
          name: { type: 'string', description: 'Required for save/delete; omit for restore to select the durable head.' },
        },
        oneOf: [
          { required: ['action'], properties: { action: { const: 'list' } } },
          { required: ['action', 'name'], properties: { action: { const: 'save' } } },
          { required: ['action'], properties: { action: { const: 'restore' } } },
          { required: ['action', 'name'], properties: { action: { const: 'delete' } } },
        ],
      },
      returns: {
        type: 'object',
        properties: {
          action: { enum: ['save', 'restore', 'delete'] },
          name: { type: 'string' },
          saved: { const: true, description: 'Save accepted for the final durable cell boundary, subject to settlement and confirmation.' },
          restored: { const: true, description: 'Restore accepted; use a later cell to compute from restored bindings.' },
          deleted: { const: true, description: 'Deletion accepted for settlement; removes the checkpoint name, not external effects.' },
          names: { type: 'array', items: { type: 'string' }, description: 'Sorted checkpoint names in the current cell control view, including tentative operations.' },
          mode: { enum: ['durable', 'volatile'] },
          volatileReason: { type: 'string' },
        },
      },
      effect: 'ptc-state',
      authority: 'ptc-plus-program-binding',
      completeness: 'complete',
      replay: 'recorded-value',
    }],
  },
  {
    namespace: 'code',
    members: [{
      name: 'run',
      description: 'Run isolated source already held as data through the top-level code.run binding; do not use tools.code.run or wrap work that can execute directly in the current cell.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['code', 'description'],
      },
      returns: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Child console output in emission order.',
          },
          result: {
            description: 'Plugin-owned isolated execution preserves supported PTC Value V1 types and reference relationships; omitted for no return, present for explicit undefined. Native delegation and legacy upstream execution retain their original result contracts.',
          },
        },
        required: ['logs'],
      },
      effect: 'unknown',
      authority: 'ptc-plus-program-binding',
      completeness: 'unknown',
      replay: 'recorded-value',
    }],
  },
])

export function createRuntimeBridgeOwner({
  ctx,
  seam,
  sessionConfig,
  userBindingsCwd,
  observeSession,
  readSessionLog = async session => session,
  maxNestedRunCodeDepth,
  presentationGeneration,
  sessionId,
  toolSchemasForAgent,
  userBindingDraftForAgent,
  bindingSubmissionForAgent,
  capabilityEnvironment,
  readPromptText = () => undefined,
}) {
  const scope = new AsyncLocalStorage()
  const childScope = new AsyncLocalStorage()
  const childRuntimes = new Set()
  const childDisposals = new WeakMap()
  const childFinalizers = new WeakSet()
  const disposeChildRuntime = (child) => {
    let disposal = childDisposals.get(child)
    if (disposal === undefined) {
      disposal = child.dispose()
      childDisposals.set(child, disposal)
    }
    return disposal
  }
  // AgentRegistry.withInitiator is AsyncLocalStorage-based. The arrow preserves
  // its receiver when a worker callback re-enters the host tool pipeline.
  const withInitiator = ctx.agents === undefined || typeof ctx.agents.withInitiator !== 'function'
    ? undefined
    : (agent, operation) => ctx.agents.withInitiator(agent, operation)
  const sessions = new SessionRuntime(sessionConfig, {
    withInitiator, userBindingsCwd, observeSession, readSessionLog,
    sessionForId: id => ctx.get('sessions')?.get(id),
  })
  let currentConfig = sessions.config
  const patchedDefinitions = new Map()
  const pending = new WeakMap()
  const nativeRunCodeHandoffs = new Set()
  let active = true
  const runIsolated = async (request, executionToken, depth, cellConfig, inheritedTools, programCompletion = false) => {
    const child = new SessionRuntime({ ...cellConfig, durableReplay: false, userBindingsEnabled: false,
      replViewEnabled: false }, { withInitiator, userBindingsCwd })
    childRuntimes.add(child)
    const projected = projectBindings(request, depth, executionToken, inheritedTools, cellConfig)
    childFinalizers.add(child)
    try {
      const execution = await child.runTentative({ id: 'isolated-cell', session: { header: {
        cwd: request.cwd ?? executionToken?.session?.header?.cwd,
      } } }, { ...projected.request, executionToken }, { programCompletion })
      if (execution.settlement !== undefined) child.finalize(execution.settlement, true)
      return { result: execution.result, completion: execution.settlement?.journal.completion }
    } finally {
      projected.release()
      try {
        await disposeChildRuntime(child)
        childRuntimes.delete(child)
      } finally {
        childDisposals.delete(child)
        childFinalizers.delete(child)
      }
    }
  }
  const withDraftCapability = (meta, current) => currentConfig.userBindingsEnabled !== true
    || typeof userBindingDraftForAgent !== 'function'
    ? meta
    : withUserBindingDraftCapability(
        meta,
        userBindingDraftForAgent(current.agent),
        presentationGeneration,
        current.bindingCandidate ?? null,
      )

  const projectBindings = (
    request,
    depth,
    executionToken,
    inheritedTools = undefined,
    cellConfig = currentConfig,
  ) => {
    const lease = { active: true }
    const release = () => { lease.active = false }
    const bindingDescriptors = normalizeBindingDescriptors(request.bindings)
    const conflict = bindingDescriptors.namespaces
      .map(binding => binding.global)
      .find(global => PLUGIN_PROGRAM_GLOBALS.has(global))
    if (conflict !== undefined) {
      throw new Error(`ptc-plus: request binding conflicts with reserved program namespace ${JSON.stringify(conflict)}`)
    }
    const toolsNamespace = bindingDescriptors.namespaces.find(binding => binding.global === 'tools')
    const functions = inheritedTools ?? (
      toolsNamespace === undefined ? Object.create(null) : toolsNamespace.functions
    )
    const ensureLease = () => {
      if (!active || !lease.active) throw new Error('PTC execution lease expired')
    }
    const runCode = async (value) => {
      ensureLease()
      const args = nestedRunCodeArguments(value)
      if (depth >= cellConfig.maxNestedRunCodeDepth) {
        throw new RangeError(`code.run recursion depth exceeds configured maximum ${cellConfig.maxNestedRunCodeDepth}`)
      }
      const languageSemantics = executionPolicies(cellConfig).languageSemantics
      const nativeRunCode = functions[RUN_CODE]
      if (typeof nativeRunCode === 'function') {
        ensureLease()
        let settleHandoff
        const handoff = {
          active: true,
          executionToken,
          depth: depth + 1,
          cellConfig,
          functions,
          settled: new Promise(resolve => { settleHandoff = resolve }),
        }
        nativeRunCodeHandoffs.add(handoff)
        try {
          return await childScope.run(handoff, () => nativeRunCode.call(functions, args))
        } finally {
          handoff.active = false
          nativeRunCodeHandoffs.delete(handoff)
          settleHandoff()
        }
      }
      if (languageSemantics !== 'legacy-v1') {
        const child = await runIsolated({ ...request, program: args.code }, executionToken,
          depth + 1, cellConfig, functions, true)
        if (child.result.error !== undefined) {
          throw new Error(`nested run_code failed (${child.result.error.kind}): ${child.result.error.message}`)
        }
        return { logs: child.result.logs, ...(child.completion.hasValue
          ? { result: decodeValue(child.completion.value, valueLimitsFromConfig(cellConfig)) } : {}) }
      }
      const childProjected = projectBindings(
        { ...request, program: args.code }, depth + 1, executionToken, functions, cellConfig,
      )
      let child
      try {
        child = await seam.invokeUpstream(childProjected.request)
      } finally {
        childProjected.release()
      }
      if (child.error !== undefined) {
        throw new Error(`nested run_code failed (${child.error.kind}): ${child.error.message}`)
      }
      return { logs: child.logs, ...(child.value === undefined ? {} : { result: child.value }) }
    }

    const nativeSchemas = toolSchemasForAgent(executionToken?.agent)
    const schemas = (capabilityEnvironment?.visibleSchemas(executionToken?.agent, nativeSchemas) ?? nativeSchemas)
      .filter(schema => schema?.name === RUN_CODE
        || (schema?.name !== EDIT_RUN_CODE && typeof functions[schema?.name] === 'function'))
    const emptyObjectTools = new Set(schemas.flatMap(schema => (
      typeof schema?.name === 'string' && schemaAcceptsEmptyObject(schema)
        ? [schema.name]
        : []
    )))
    const projected = bindingDescriptors.namespaces.map((binding) => {
      const wrapped = Object.create(null)
      const members = binding.global === 'tools'
        ? capabilityEnvironment?.projectMembers(executionToken?.agent, binding.members) ?? binding.members
        : binding.members
      for (const key of members) {
        const original = (...args) => binding.functions[key](...args)
        const invoke = binding.global === 'tools'
          ? capabilityEnvironment?.adaptFunction(executionToken?.agent, key, original) ?? original
          : original
        Object.defineProperty(wrapped, key, {
          enumerable: true,
          value: async (...args) => {
            ensureLease()
            return binding.global === 'tools' && key === EDIT_RUN_CODE
              ? scope.run(executionToken, () => invoke(...args))
              : invoke(...args)
          },
        })
      }
      const emptyObjectMembers = binding.global === 'tools'
        ? members.filter(member => emptyObjectTools.has(member))
        : []
      return {
        ...binding,
        members,
        functions: wrapped,
        ...(binding.global === 'tools' ? { emptyObjectMembers } : {}),
      }
    })
    const annotations = Object.fromEntries(schemas.flatMap(schema => (
      typeof schema?.name === 'string' && schema.name !== RUN_CODE
        ? [[schema.name, { replay: 'recorded-value' }]]
        : []
    )))
    const metadata = Object.freeze([
      ...(capabilityEnvironment?.toolMetadata(executionToken?.agent, toolCapabilityMetadata(schemas, annotations), schemas) ?? toolCapabilityMetadata(schemas, annotations)),
      ...(capabilityEnvironment?.metadata(executionToken?.agent) ?? []),
      ...PROGRAM_CAPABILITY_METADATA.map(entry => entry.namespace === 'code'
        && cellConfig.userBindingsEnabled === true
        ? { ...entry, members: [...entry.members, BINDING_SUBMISSION] }
        : entry),
    ])
    let searchCapabilities
    projected.push(namespace('capabilities', {
      tree: async value => {
        if (value !== undefined) throw new TypeError('capabilities.tree does not accept arguments')
        ensureLease()
        return capabilityTree(metadata)
      },
      find: async value => {
        ensureLease()
        if (typeof value !== 'string') throw new TypeError('capabilities.find expects a query string')
        return capabilityFind(metadata, value)
      },
      inspect: async value => {
        ensureLease()
        if (value === undefined) {
          const result = capabilityInspect(metadata)
          capabilityEnvironment?.explored(executionToken?.agent, result)
          return result
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new TypeError('capabilities.inspect expects an object')
        }
        const result = capabilityInspect(metadata, value.symbols, value.budget)
        capabilityEnvironment?.explored(executionToken?.agent, result)
        return result
      },
      search: async value => {
        ensureLease()
        searchCapabilities ??= createCapabilitySearcher(metadata)
        const result = searchCapabilities(value)
        capabilityEnvironment?.explored(executionToken?.agent, result)
        return result
      },
    }, 'CapabilityExplorationError', 'operation'))
    projected.push(namespace('code', {
      run: runCode,
      ...(cellConfig.userBindingsEnabled === true ? {
        submitBindingDraft: bindingSubmissionForAgent(executionToken?.agent, ensureLease, candidate => {
          executionToken.bindingCandidate = candidate
        }),
      } : {}),
    }, 'CodeExecutionError', 'operation'))
    return { request: { ...request, bindings: projected }, release }
  }

  const patchRunCodeDefinition = (agent) => {
    const definition = hostTransportDefinition(ctx.tools, agent, RUN_CODE)
    if (definition === undefined) {
      throw new Error('ptc-plus: run_code definition is unavailable for the owning session')
    }
    if (definition.output === undefined) {
      throw new Error('ptc-plus: run_code definition has no output projection')
    }
    if (patchedDefinitions.has(definition)) return
    // A host that declares its own model-facing tools never hands this plugin a
    // tools array to adapt, so the editable prompt slots reach the model only on
    // the definition the executor projects. A definition of another shape keeps
    // its own text: adapting is an improvement here, never a reason to fail.
    try {
      const promptText = readPromptText()
      if (promptText !== undefined) {
        const adapted = adaptRunCodeSchema(definition, promptText)
        definition.description = adapted.description
        definition.parameters = adapted.parameters
      }
    } catch {}
    const output = definition.output
    const ownPresentationMeta = Object.getOwnPropertyDescriptor(output, 'presentationMeta')
    const patchedPresentationMeta = (args, value) => {
      const projectedCurrent = scope.getStore()
      if (projectedCurrent !== undefined) {
        projectedCurrent.presentationMetaCalls = (projectedCurrent.presentationMetaCalls ?? 0) + 1
      }
      const prototype = Object.getPrototypeOf(output)
      const originalPresentationMeta = ownPresentationMeta === undefined
        ? prototype === null ? undefined : Reflect.get(prototype, 'presentationMeta', output)
        : Object.hasOwn(ownPresentationMeta, 'value')
          ? ownPresentationMeta.value
          : ownPresentationMeta.get?.call(output)
      const base = originalPresentationMeta === undefined
        // Installing a projector replaces an optional Host callback with a
        // required JSON-producing callback, including policy reprojection
        // after the execution scope has ended. An empty object conveys no
        // computation evidence; a stale settlement must never fill that gap.
        ? {}
        : snapshotJsonValue(originalPresentationMeta.call(output, args, value))
      // An invalid upstream projection is still the Host's output failure;
      // adding plugin metadata must not make it appear valid.
      if (base === undefined) return undefined
      if (!active) return base
      const current = scope.getStore()
      const settlement = current?.settlement
      if (settlement === undefined) return generatedRunCodeDescriptionMeta(args, base)
      let meta = withJournal(base, settlement.journal)
      if (settlement.recoveryBoundaries !== undefined) {
        meta = withRecoveryBoundaries(meta, settlement.recoveryBoundaries)
      }
      if (settlement.rewrites !== undefined) meta = withRewrites(meta, settlement.rewrites)
      if (settlement.userBindings !== undefined) {
        meta = withUserBindingsSnapshot(meta, settlement.userBindings)
      }
      if (current.postEdit?.provenance !== undefined) {
        meta = { ...meta, [POST_EDIT_KEY]: current.postEdit.provenance }
      }
      meta = generatedRunCodeDescriptionMeta(args, meta)
      meta = withReplMemorySnapshot(meta, settlement.replMemory, presentationGeneration)
      if (current.postEdit?.provenance?.meta?.[REPL_MEMORY_META_KEY] !== undefined) {
        meta = { ...meta,
          [REPL_MEMORY_META_KEY]: current.postEdit.provenance.meta[REPL_MEMORY_META_KEY] }
      }
      meta = withDraftCapability(meta, current)
      return capabilityEnvironment?.complete(current, { meta }).meta ?? meta
    }
    const ownProjectContent = Object.getOwnPropertyDescriptor(definition, 'projectContent')
    const patchedProjectContent = (exec, result) => {
      const prototype = Object.getPrototypeOf(definition)
      const originalProjectContent = ownProjectContent === undefined
        ? prototype === null ? undefined : Reflect.get(prototype, 'projectContent', definition)
        : Object.hasOwn(ownProjectContent, 'value')
          ? ownProjectContent.value : ownProjectContent.get?.call(definition)
      const original = originalProjectContent?.call(definition, exec, result)
      const current = active ? pending.get(exec) : undefined
      const derived = current?.derivedExecution
      // Some public Host implementations omit the metadata projector for a
      // nested success. Capture its canonical value before policy; the private
      // relation is admitted only if policy retains that same frozen value.
      if (current?.deferredSettlement?.current === current && derived !== undefined
        && current.exec === exec && exec.token !== undefined && exec.parent !== undefined
        && current.id === sessionId(exec.agent) && derived.agent === exec.agent
        && derived.callId === exec.callId && derived.rootCallId === exec.rootCallId
        && derived.parent === exec.parent && deepEqualJson(derived.arguments, exec.arguments)
        && current.presentationMetaCalls === undefined && result.isError === false
        && result.value !== null && typeof result.value === 'object'
        && Object.isFrozen(result.value) && result.meta?.[JOURNAL_KEY] === undefined
        && current.settlement !== undefined) {
        const metadata = scope.run(current, () => patchedPresentationMeta(exec.arguments, result.value))
        if (metadata?.[JOURNAL_KEY] !== undefined) {
          current.deferredSettlement.projection = { exec, token: exec.token,
            value: result.value, meta: snapshotJsonValue(result.meta), metadata,
            presentationMetaCalls: current.presentationMetaCalls }
        }
      }
      const presentation = active ? pending.get(exec)?.postEdit?.presentation : undefined
      if (presentation === undefined) return original
      return [...original ?? result.content, ...presentation.content]
    }
    const ownExecute = Object.getOwnPropertyDescriptor(definition, 'execute')
    const originalExecute = definition.execute
    const patchedExecute = typeof originalExecute !== 'function'
      ? undefined
      : function (args, exec) {
          const executionArguments = scope.getStore()?.executionArguments ?? args
          return originalExecute.call(this, executionArguments, exec)
        }
    let presentationPatched = false
    try {
      Object.defineProperty(output, 'presentationMeta', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patchedPresentationMeta,
      })
      presentationPatched = true
      Object.defineProperty(definition, 'projectContent', {
        configurable: true, enumerable: ownProjectContent?.enumerable ?? true,
        writable: true, value: patchedProjectContent,
      })
      if (patchedExecute !== undefined) {
        Object.defineProperty(definition, 'execute', {
          configurable: true,
          enumerable: ownExecute?.enumerable ?? true,
          writable: true,
          value: patchedExecute,
        })
      }
      patchedDefinitions.set(definition, {
        definition,
        output,
        ownPresentationMeta,
        patchedPresentationMeta,
        ownProjectContent,
        patchedProjectContent,
        ownExecute,
        patchedExecute,
      })
    } catch (error) {
      if (definition.projectContent === patchedProjectContent) {
        if (ownProjectContent === undefined) delete definition.projectContent
        else Object.defineProperty(definition, 'projectContent', ownProjectContent)
      }
      if (patchedExecute !== undefined && definition.execute === patchedExecute) {
        if (ownExecute === undefined) delete definition.execute
        else Object.defineProperty(definition, 'execute', ownExecute)
      }
      if (presentationPatched && output.presentationMeta === patchedPresentationMeta) {
        if (ownPresentationMeta === undefined) delete output.presentationMeta
        else Object.defineProperty(output, 'presentationMeta', ownPresentationMeta)
      }
      throw new Error(`ptc-plus: cannot attach the session journal to run_code results: ${error.message}`)
    }
  }

  const patchedRun = function (request) {
    const child = childScope.getStore()
    if (child !== undefined) {
      if (!active || !child.active) return Promise.reject(new Error('PTC execution lease expired'))
      if (executionPolicies(child.cellConfig).languageSemantics !== 'legacy-v1') {
        return runIsolated(request, child.executionToken, child.depth, child.cellConfig, child.functions)
          .then(execution => execution.result)
      }
    }
    if (!active) return seam.runUpstream(request)
    const current = scope.getStore()
    if (current === undefined) return seam.runUpstream(request)
    const projected = projectBindings(request, 0, current, undefined, current.submission?.config ?? currentConfig)
    return sessions.runTentative(current, {
      ...projected.request,
      executionToken: current,
      ...(current.userBindings === undefined ? {} : { userBindings: current.userBindings }),
    })
      .then(async (execution) => {
        current.settlement = execution.settlement
        const pendingEdit = current.pendingEdit
        if (pendingEdit === undefined) return execution.result
        if (!pendingEdit.confirmed || current.signal.aborted) {
          pendingEdit.finish(false)
          return execution.result
        }
        try {
          const postEdit = await pendingEdit.dispatch(current.signal, current.exec)
          current.postEdit = postEdit
          for (const context of postEdit.presentation?.additionalContexts ?? []) {
            current.exec.deferContext?.(context)
          }
          if (postEdit.presentation?.concludesTurn === true && execution.result.error === undefined) {
            current.exec.concludeTurn?.()
          }
          const outcome = postEdit.outcome
          const value = postEdit.provenance?.meta?.[JOURNAL_KEY]?.completion
          const hasRenderedContent = postEdit.presentation?.content?.length > 0
          let valueText = ''
          if (!hasRenderedContent && value?.kind === 'return' && value.hasValue) {
            try {
              valueText = `; value: ${renderValueWire(value.value, {
                ...valueLimitsFromConfig(current.submission?.config ?? currentConfig),
                maxStringBytes: 2048,
              })}`
            } catch {
              valueText = '; value omitted from preview'
            }
          }
          const targetDescription = pendingEdit.targetDescription ?? `run_code call ${pendingEdit.targetCallSeq}`
          const status = outcome.edited
            ? `edit_run_code settled${outcome.error === undefined ? '' : ' with execution error'} (target ${targetDescription})`
            : `edit_run_code did not execute the accepted revision (target ${targetDescription})`
          const detail = [
            ...(hasRenderedContent || !Array.isArray(outcome.logs) ? [] : outcome.logs),
            ...(!hasRenderedContent && typeof outcome.error === 'string' ? [outcome.error] : []),
            ...(!hasRenderedContent && typeof outcome.reason === 'string' ? [outcome.reason] : []),
          ].filter(item => typeof item === 'string').join('\n')
          return { ...execution.result,
            logs: [...execution.result.logs, `${status}${valueText}${detail ? `: ${detail}` : ''}`] }
        } catch (error) {
          pendingEdit.finish(false)
          return { ...execution.result,
            logs: [...execution.result.logs,
              `edit_run_code failed after acceptance: ${error instanceof Error ? error.message : String(error)}`] }
        }
      })
      .finally(projected.release)
  }

  const releaseSeam = seam.installExecute(patchedRun)

  const ownedDerivedScope = (exec, executionArguments = exec.arguments) => {
    const inherited = scope.getStore()
    const derived = inherited?.derivedExecution
    if (inherited?.deferredSettlement === undefined
      || inherited.id !== sessionId(exec.agent) || derived?.agent !== exec.agent
      || derived.callId !== exec.callId || derived.rootCallId !== exec.rootCallId
      || derived.parent !== exec.parent || exec.name !== RUN_CODE
      || !deepEqualJson(derived.arguments, executionArguments)) return undefined
    return inherited
  }

  const withSubmission = async (exec, operation) => {
    const id = sessionId(exec.agent)
    const inherited = scope.getStore()
    const ownsDerived = ownedDerivedScope(exec) !== undefined
    if ((exec.parent !== undefined && !ownsDerived) || id === undefined
      || (inherited?.exec === exec && inherited.submission?.sessionId === id)) return operation()
    const submission = sessions.beginSubmission({ id }, exec.signal)
    const composite = ownsDerived
      ? {
          persistedCallSeq: inherited.persistedCallSeq,
          sourceCallSeq: inherited.sourceCallSeq,
          sessionLog: inherited.sessionLog,
          deferredSettlement: inherited.deferredSettlement,
          derivedExecution: inherited.derivedExecution,
        }
      : {}
    try {
      // Only reentry for this exact execution shares admission. Background
      // continuations can inherit a settled execution's asynchronous context.
      // Only proved derived edits retain composite source and settlement under
      // a fresh admission; other roots own a fresh log and no child handoff.
      return await scope.run({ ...composite, exec, submission }, () => childScope.run(undefined, operation))
    } finally {
      sessions.releaseSubmission(submission)
    }
  }

  const readSubmissionLog = async (session, signal) => {
    const inherited = scope.getStore()
    const sessionLog = inherited?.sessionLog ?? await readSessionLog(session, signal)
    if (inherited?.submission !== undefined) sessions.assertSubmission(inherited.submission)
    return sessionLog
  }

  const readNestedDispatchLog = async (session, signal) => {
    const inherited = scope.getStore()
    if (inherited === undefined || inherited.session !== session
      || inherited.signal.aborted || signal?.aborted) {
      throw new Error('ptc-plus: nested edit has no active root run_code cell')
    }
    return readSessionLog(session, signal)
  }

  const rootEditScope = exec => {
    const current = scope.getStore()
    if (!active || current === undefined || childScope.getStore() !== undefined
      || current.deferredSettlement !== undefined
      || current.callId !== exec.rootCallId || current.agent !== exec.agent
      || current.session !== exec.agent?.session || current.signal.aborted
      || exec.signal?.aborted) return undefined
    return current
  }

  return Object.freeze({
    config: sessions.config,
    reconfigure(nextConfig) {
      sessions.reconfigure(nextConfig)
      currentConfig = sessions.config
    },
    observeRepl(id, memory, signal) { return sessions.observe(id, memory, signal) },
    withSubmission,
    readSubmissionLog,
    readNestedDispatchLog,
    prepareAgent(agent) { patchRunCodeDefinition(agent) },
    canScheduleEdit(exec) { return rootEditScope(exec) !== undefined },
    scheduleEdit(exec, pendingEdit) {
      const current = rootEditScope(exec)
      if (current === undefined || current.pendingEdit !== undefined) return false
      current.pendingEdit = pendingEdit
      return true
    },
    // A composite tool's outer result owns the final durability decision.
    async executeTentative(callSeq, sourceCallSeq, operation, sessionLog, derivedExecution) {
      const id = scope.getStore()?.id
      const settlement = {
        current: undefined,
        innerConfirmed: false,
        finalized: false,
      }
      const finalize = (outerConfirmed) => {
        if (settlement.finalized) return
        settlement.finalized = true
        if (settlement.current?.settlement !== undefined) {
          sessions.finalize(settlement.current.settlement, outerConfirmed && settlement.innerConfirmed)
        }
      }
      try {
        const result = await scope.run({
          id,
          ...(callSeq === undefined ? {} : { persistedCallSeq: callSeq }),
          ...(sourceCallSeq === undefined ? {} : { sourceCallSeq }),
          ...(sessionLog === undefined ? {} : { sessionLog }),
          deferredSettlement: settlement,
          derivedExecution,
        }, operation)
        return Object.freeze({ result, finalize,
          ...(settlement.metadata === undefined ? {} : { metadata: settlement.metadata }) })
      } catch (error) {
        finalize(false)
        throw error
      }
    },
    async handleExecute(exec, next, executionArguments = exec.arguments, userBindings = undefined) {
      const ownsDerived = ownedDerivedScope(exec, executionArguments) !== undefined
      if (exec.parent !== undefined && !ownsDerived) return scope.run(undefined, next)
      return withSubmission(exec, async () => {
        const id = sessionId(exec.agent)
        if (id === undefined) return next()
        await capabilityEnvironment?.prepare(exec.agent)
        patchRunCodeDefinition(exec.agent)
        const inherited = scope.getStore()
        const persistedCallSeq = inherited?.persistedCallSeq
        const current = {
          id,
          submission: inherited?.submission,
          callId: String(exec.callId),
          ...(persistedCallSeq === undefined ? {} : { persistedCallSeq }),
          ...(inherited?.sourceCallSeq === undefined ? {} : { sourceCallSeq: inherited.sourceCallSeq }),
          ...(inherited?.deferredSettlement === undefined
            ? {}
            : { deferredSettlement: inherited.deferredSettlement,
                derivedExecution: inherited.derivedExecution }),
          session: exec.agent?.session,
          signal: exec.signal,
          sessionLog: await readSubmissionLog(exec.agent?.session, exec.signal),
          agent: exec.agent,
          exec,
          executionArguments,
          ...(userBindings === undefined ? {} : { userBindings }),
        }
        sessions.assertSubmission(current.submission)
        if (current.deferredSettlement !== undefined) {
          current.deferredSettlement.current = current
        }
        pending.set(exec, current)
        return scope.run(current, async () => {
          const result = await next()
          const settlement = current.settlement
          if (result?.isError === true && settlement !== undefined) {
            let meta = withJournal(result.meta, settlement.journal)
            if (settlement.recoveryBoundaries !== undefined) {
              meta = withRecoveryBoundaries(meta, settlement.recoveryBoundaries)
            }
            if (settlement.rewrites !== undefined) meta = withRewrites(meta, settlement.rewrites)
            if (settlement.userBindings !== undefined) {
              meta = withUserBindingsSnapshot(meta, settlement.userBindings)
            }
            if (current.postEdit?.provenance !== undefined) {
              meta = { ...meta, [POST_EDIT_KEY]: current.postEdit.provenance }
            }
            meta = withReplMemorySnapshot(meta, settlement.replMemory, presentationGeneration)
            if (current.postEdit?.provenance?.meta?.[REPL_MEMORY_META_KEY] !== undefined) {
              meta = { ...meta,
                [REPL_MEMORY_META_KEY]: current.postEdit.provenance.meta[REPL_MEMORY_META_KEY] }
            }
            meta = withDraftCapability(meta, current)
            return capabilityEnvironment?.complete(current, { ...result, meta }) ?? { ...result, meta }
          }
          return result
        })
      })
    },
    handleResult(exec, result) {
      if (exec.parent !== undefined && !pending.has(exec)) return
      const id = sessionId(exec.agent)
      if (id === undefined) return
      const current = pending.get(exec)
      pending.delete(exec)
      const settlement = current?.settlement
      if (settlement === undefined) {
        current?.pendingEdit?.finish(false)
        sessions.noteNoop(id, current?.sessionLog, exec.callId)
        return
      }
      const deferred = current.deferredSettlement
      const projection = deferred?.projection
      const derived = current.derivedExecution
      const privateMetadata = projection !== undefined && projection.exec === exec
        && deferred.current === current && current.exec === exec && current.id === id
        && derived?.agent === exec.agent && derived.callId === exec.callId
        && derived.rootCallId === exec.rootCallId && derived.parent === exec.parent
        && deepEqualJson(derived.arguments, exec.arguments)
        && projection.token === exec.token && projection.value === result?.value
        && result.isError === false && deepEqualJson(projection.meta, result.meta)
        && projection.presentationMetaCalls === current.presentationMetaCalls
        ? projection.metadata : undefined
      if (deferred !== undefined) deferred.metadata = privateMetadata
      const meta = privateMetadata ?? result?.meta
      const confirmed = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        && Object.hasOwn(meta, JOURNAL_KEY)
        && journalsEqual(meta[JOURNAL_KEY], settlement.journal)
        && recoveryBoundariesEqual(
          Object.hasOwn(meta, RECOVERY_BOUNDARY_KEY) ? meta[RECOVERY_BOUNDARY_KEY] : undefined,
          settlement.recoveryBoundaries,
        )
        && userBindingsSnapshotsEqual(
          Object.hasOwn(meta, USER_BINDINGS_META_KEY)
            ? meta[USER_BINDINGS_META_KEY]
            : undefined,
          settlement.userBindings,
        )
      if (current.deferredSettlement !== undefined) {
        current.deferredSettlement.innerConfirmed = confirmed
        return
      }
      sessions.finalize(settlement, confirmed)
      current.pendingEdit?.finish(confirmed && current.postEdit?.provenance !== undefined
        && deepEqualJson(meta?.[POST_EDIT_KEY], current.postEdit.provenance))
    },
    disposeAgent(agent) {
      return sessions.disposeAgent(sessionId(agent) ?? String(agent.id))
    },
    disposeSession(session) {
      return sessions.disposeSession(String(session.id))
    },
    async dispose() {
      active = false
      const failures = []
      const children = [...childRuntimes]
      const childResultsPromise = Promise.allSettled(
        children.map(child => disposeChildRuntime(child)),
      )
      await Promise.all([...nativeRunCodeHandoffs].map(handoff => handoff.settled))
      const childResults = await childResultsPromise
      for (const [index, result] of childResults.entries()) {
        const child = children[index]
        if (!childFinalizers.has(child)) childDisposals.delete(child)
        if (result.status === 'rejected') failures.push(result.reason)
        else childRuntimes.delete(child)
      }
      releaseSeam()
      for (const patched of patchedDefinitions.values()) {
        if (patched.output.presentationMeta === patched.patchedPresentationMeta) {
          if (patched.ownPresentationMeta === undefined) delete patched.output.presentationMeta
          else Object.defineProperty(patched.output, 'presentationMeta', patched.ownPresentationMeta)
        }
        if (patched.definition.projectContent === patched.patchedProjectContent) {
          if (patched.ownProjectContent === undefined) delete patched.definition.projectContent
          else Object.defineProperty(patched.definition, 'projectContent', patched.ownProjectContent)
        }
        if (patched.patchedExecute !== undefined
          && patched.definition.execute === patched.patchedExecute) {
          if (patched.ownExecute === undefined) delete patched.definition.execute
          else Object.defineProperty(patched.definition, 'execute', patched.ownExecute)
        }
      }
      patchedDefinitions.clear()
      try {
        await sessions.dispose()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'ptc-plus runtime bridge disposal failed')
      }
    },
  })
}
