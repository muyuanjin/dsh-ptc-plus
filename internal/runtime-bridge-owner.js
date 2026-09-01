/** Own the CodeRuntime patch, per-cell lease, journal projection, and session settlement. */
import { AsyncLocalStorage } from 'node:async_hooks'
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
  toolCapabilityMetadata,
} from './program-bindings.js'
import { deepFreeze } from './record-utils.js'
import { withReplMemorySnapshot } from './repl-memory-projection.js'

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
      description: 'List, save, restore, or delete named durable REPL states.',
      parameters: {
        type: 'object',
        properties: {
          action: { enum: ['list', 'save', 'restore', 'delete'] },
          name: { type: 'string' },
        },
        oneOf: [
          { required: ['action'], properties: { action: { const: 'list' } } },
          { required: ['action', 'name'], properties: { action: { const: 'save' } } },
          { required: ['action'], properties: { action: { const: 'restore' } } },
          { required: ['action', 'name'], properties: { action: { const: 'delete' } } },
        ],
      },
      returns: { type: 'object' },
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
            description: 'Child return value; omitted when the child returns undefined.',
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
  sessionConfig,
  maxNestedRunCodeDepth,
  presentationGeneration,
  sessionId,
  toolSchemasForAgent,
}) {
  const scope = new AsyncLocalStorage()
  // AgentRegistry.withInitiator is AsyncLocalStorage-based. The arrow preserves
  // its receiver when a worker callback re-enters the host tool pipeline.
  const withInitiator = ctx.agents === undefined || typeof ctx.agents.withInitiator !== 'function'
    ? undefined
    : (agent, operation) => ctx.agents.withInitiator(agent, operation)
  const sessions = new SessionRuntime(sessionConfig, { withInitiator })
  let currentConfig = sessions.config
  const runtime = ctx.codeRuntime
  const ownRun = Object.getOwnPropertyDescriptor(runtime, 'run')
  const upstreamRun = runtime.run
  const patchedDefinitions = new Map()
  const pending = new WeakMap()
  let active = true

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
      if (!lease.active) throw new Error('PTC execution lease expired')
    }
    const runCode = async (value) => {
      ensureLease()
      const args = nestedRunCodeArguments(value)
      if (depth >= cellConfig.maxNestedRunCodeDepth) {
        throw new RangeError(`code.run recursion depth exceeds configured maximum ${cellConfig.maxNestedRunCodeDepth}`)
      }
      if (typeof functions[RUN_CODE] === 'function') return functions[RUN_CODE](args)
      const childProjected = projectBindings(
        { ...request, program: args.code }, depth + 1, executionToken, functions, cellConfig,
      )
      let child
      try {
        child = await upstreamRun.call(runtime, childProjected.request)
      } finally {
        childProjected.release()
      }
      if (child.error !== undefined) {
        throw new Error(`nested run_code failed (${child.error.kind}): ${child.error.message}`)
      }
      return { logs: child.logs, ...(child.value === undefined ? {} : { result: child.value }) }
    }

    const schemas = toolSchemasForAgent(executionToken?.agent)
      .filter(schema => schema?.name === RUN_CODE
        || (schema?.name !== EDIT_RUN_CODE && typeof functions[schema?.name] === 'function'))
    const emptyObjectTools = new Set(schemas.flatMap(schema => (
      typeof schema?.name === 'string' && schemaAcceptsEmptyObject(schema)
        ? [schema.name]
        : []
    )))
    const projected = bindingDescriptors.namespaces.map((binding) => {
      const wrapped = Object.create(null)
      for (const key of binding.members) {
        Object.defineProperty(wrapped, key, {
          enumerable: true,
          value: async (...args) => {
            ensureLease()
            return binding.functions[key](...args)
          },
        })
      }
      const emptyObjectMembers = binding.global === 'tools'
        ? binding.members.filter(member => emptyObjectTools.has(member))
        : []
      return {
        ...binding,
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
      ...toolCapabilityMetadata(schemas, annotations),
      ...PROGRAM_CAPABILITY_METADATA,
    ])
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
        if (value === undefined) return capabilityInspect(metadata)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new TypeError('capabilities.inspect expects an object')
        }
        return capabilityInspect(metadata, value.symbols, value.budget)
      },
    }, 'CapabilityExplorationError', 'operation'))
    projected.push(namespace('code', { run: runCode }, 'CodeExecutionError', 'operation'))
    return { request: { ...request, bindings: projected }, release }
  }

  const patchResultMetadata = (agent) => {
    const definition = ctx.tools.get(RUN_CODE, agent)
    if (definition === undefined) {
      throw new Error('ptc-plus: run_code definition is unavailable for the owning session')
    }
    if (definition.output === undefined) {
      throw new Error('ptc-plus: run_code definition has no output projection')
    }
    if (patchedDefinitions.has(definition)) return
    const output = definition.output
    const original = output.presentationMeta
    const patched = (args, value) => {
      if (!active) return original === undefined ? undefined : original(args, value)
      const base = original === undefined ? undefined : original(args, value)
      const current = scope.getStore()
      const settlement = current?.settlement
      if (settlement === undefined) return base
      let meta = withJournal(base, settlement.journal)
      if (settlement.recoveryBoundaries !== undefined) {
        meta = withRecoveryBoundaries(meta, settlement.recoveryBoundaries)
      }
      if (settlement.rewrites !== undefined) meta = withRewrites(meta, settlement.rewrites)
      return withReplMemorySnapshot(meta, settlement.replMemory, presentationGeneration)
    }
    try {
      Object.defineProperty(output, 'presentationMeta', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patched,
      })
      patchedDefinitions.set(definition, { output, original, patched })
    } catch (error) {
      throw new Error(`ptc-plus: cannot attach the session journal to run_code results: ${error.message}`)
    }
  }

  const patchedRun = function (request) {
    if (!active) return upstreamRun.call(runtime, request)
    const current = scope.getStore()
    if (current === undefined) return upstreamRun.call(runtime, request)
    const projected = projectBindings(request, 0, current)
    return sessions.runTentative(current, { ...projected.request, executionToken: current })
      .then((execution) => {
        current.settlement = execution.settlement
        return execution.result
      })
      .finally(projected.release)
  }

  Object.defineProperty(runtime, 'run', {
    configurable: true,
    writable: true,
    value: patchedRun,
  })

  return Object.freeze({
    config: sessions.config,
    reconfigure(nextConfig) {
      sessions.reconfigure(nextConfig)
      currentConfig = sessions.config
    },
    // A composite tool's outer result owns the final durability decision.
    async executeTentative(callSeq, operation) {
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
          ...(callSeq === undefined ? {} : { persistedCallSeq: callSeq }),
          deferredSettlement: settlement,
        }, operation)
        return Object.freeze({ result, finalize })
      } catch (error) {
        finalize(false)
        throw error
      }
    },
    handleExecute(exec, next) {
      if (exec.parent !== undefined) return scope.run(undefined, next)
      const id = sessionId(exec.agent)
      if (id === undefined) return next()
      patchResultMetadata(exec.agent)
      const inherited = scope.getStore()
      const persistedCallSeq = inherited?.persistedCallSeq
      const current = {
        id,
        callId: String(exec.callId),
        ...(persistedCallSeq === undefined ? {} : { persistedCallSeq }),
        ...(inherited?.deferredSettlement === undefined
          ? {}
          : { deferredSettlement: inherited.deferredSettlement }),
        session: exec.agent?.session,
        agent: exec.agent,
      }
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
          meta = withReplMemorySnapshot(meta, settlement.replMemory, presentationGeneration)
          return { ...result, meta }
        }
        return result
      })
    },
    handleResult(exec, result) {
      if (exec.parent !== undefined) return
      const id = sessionId(exec.agent)
      if (id === undefined) return
      const current = pending.get(exec)
      pending.delete(exec)
      const settlement = current?.settlement
      if (settlement === undefined) {
        sessions.noteNoop(id, exec.agent?.session, exec.callId)
        return
      }
      const meta = result?.meta
      const confirmed = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        && Object.hasOwn(meta, JOURNAL_KEY)
        && journalsEqual(meta[JOURNAL_KEY], settlement.journal)
        && recoveryBoundariesEqual(
          Object.hasOwn(meta, RECOVERY_BOUNDARY_KEY) ? meta[RECOVERY_BOUNDARY_KEY] : undefined,
          settlement.recoveryBoundaries,
        )
      if (current.deferredSettlement !== undefined) {
        current.deferredSettlement.innerConfirmed = confirmed
        return
      }
      sessions.finalize(settlement, confirmed)
    },
    disposeAgent(agent) {
      return sessions.disposeSession(sessionId(agent) ?? String(agent.id))
    },
    disposeSession(session) {
      return sessions.disposeSession(String(session.id))
    },
    async dispose() {
      active = false
      if (runtime.run === patchedRun) {
        if (ownRun === undefined) delete runtime.run
        else Object.defineProperty(runtime, 'run', ownRun)
      }
      for (const { output, original, patched } of patchedDefinitions.values()) {
        if (output.presentationMeta !== patched) continue
        if (original === undefined) delete output.presentationMeta
        else output.presentationMeta = original
      }
      patchedDefinitions.clear()
      await sessions.dispose()
    },
  })
}
