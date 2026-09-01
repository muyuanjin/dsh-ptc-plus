/** Own the scoped edit tool, target claims, derived metadata, and paired disposers. */
import {
  DERIVED_RUN_KEY,
  EDIT_TARGET_KEY,
  JOURNAL_KEY,
  RECOVERY_BOUNDARY_KEY,
  REWRITES_KEY,
  derivedEditResultsEqual,
  liveToolCallSeq,
  normalizeJournal,
  normalizeRecoveryBoundaries,
  normalizeRewrites,
  validatedRewrites,
} from './session-journal.js'
import {
  EXPECTED_TARGET_CALL_SEQ,
  editRejectedCell,
  editRunCodeSchema,
} from './rejected-cell-editor.js'
import { editTargetForCall, projectSessionLog } from './session-log-view.js'
import { RUN_CODE } from './runtime-bridge-owner.js'
import { isRecord } from './record-utils.js'
import {
  REPL_MEMORY_META_KEY,
  normalizeReplMemorySnapshot,
  validatedReplMemorySnapshot,
} from './repl-memory-projection.js'

export const EDIT_RUN_CODE = 'edit_run_code'

function unavailableDerivedResult(inner) {
  if (inner?.isError !== true) {
    throw new Error('ptc-plus: derived run_code result did not contain a valid execution journal')
  }
  return {
    edited: false,
    error: inner.error?.message ?? 'derived run_code did not enter the runtime',
    logs: [],
  }
}

function derivedEditResult(inner) {
  const result = {
    edited: true,
    logs: Array.isArray(inner?.value?.logs) ? inner.value.logs : [],
  }
  if (inner?.isError === true) {
    result.error = inner.error?.message ?? 'derived run_code execution failed'
  } else if (inner?.value !== undefined && !isRecord(inner.value)) {
    result.value = inner.value
  } else if (inner?.value?.result !== undefined) {
    result.value = inner.value.result
  }
  return result
}

export function createEditTransportOwner(ctx, {
  durableReplay,
  executeTentative,
  sessionId,
  toolSchemasForAgent,
}) {
  let currentDurableReplay = durableReplay
  const editExecutionMetadata = new WeakMap()
  const editClaims = new Map()
  const pendingSettlements = new Map()
  const installedScopes = new Map()

  const releaseClaim = (id, targetCallSeq) => {
    const claims = editClaims.get(id)
    claims?.delete(targetCallSeq)
    if (claims?.size === 0) editClaims.delete(id)
  }

  const discardSettlements = (id) => {
    for (const [exec, pending] of pendingSettlements) {
      if (id !== undefined && pending.id !== id) continue
      pendingSettlements.delete(exec)
      pending.finalize(false)
    }
  }

  const definition = editRunCodeSchema()
  const derivedMetadata = (derived) => {
    const meta = {
      [JOURNAL_KEY]: normalizeJournal(derived.journal),
      [EDIT_TARGET_KEY]: { targetCallSeq: derived.targetCallSeq },
      [DERIVED_RUN_KEY]: {
        code: derived.code,
        description: derived.description,
      },
    }
    if (derived.rewrites !== undefined) {
      meta[REWRITES_KEY] = normalizeRewrites(derived.rewrites)
    }
    if (derived.recoveryBoundaries !== undefined) {
      meta[RECOVERY_BOUNDARY_KEY] = normalizeRecoveryBoundaries(derived.recoveryBoundaries)
    }
    if (derived.replMemory !== undefined) {
      meta[REPL_MEMORY_META_KEY] = normalizeReplMemorySnapshot(derived.replMemory)
    }
    return meta
  }
  definition.output = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        edited: { type: 'boolean' },
        reason: { type: 'string' },
        error: { type: 'string' },
        value: {},
        logs: { type: 'array', items: { type: 'string' } },
      },
      required: ['edited'],
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}) }],
    presentationMeta: (args) => {
      const meta = {}
      if (!isRecord(args)) return meta
      const derived = editExecutionMetadata.get(args)
      if (derived === undefined) return meta
      return derivedMetadata(derived)
    },
  }
  definition.execute = async (args, exec) => {
    const agent = exec?.agent
    const callId = typeof exec?.callId === 'string' ? exec.callId : undefined
    const persistedTargetCallSeq = liveToolCallSeq(agent?.session, callId, EDIT_RUN_CODE)
    if (persistedTargetCallSeq === undefined && projectSessionLog(agent).editableRun !== undefined) {
      throw new Error('ptc-plus: edit_run_code requires a unique persisted tool/call event')
    }
    const target = persistedTargetCallSeq === undefined
      ? undefined
      : editTargetForCall(agent, callId, persistedTargetCallSeq)
    if (target?.source === undefined || target.callSeq === undefined) {
      return { edited: false, reason: 'no run_code cell is currently eligible for safe editing' }
    }
    const edited = editRejectedCell(args, target.source)
    if (!edited.edited) return edited
    const expectedTargetCallSeq = args[EXPECTED_TARGET_CALL_SEQ]
    if (expectedTargetCallSeq !== undefined && expectedTargetCallSeq !== target.callSeq) {
      return {
        edited: false,
        reason: `validated repair targets run_code call ${expectedTargetCallSeq}, but this edit captured call ${target.callSeq}`,
      }
    }
    if (typeof ctx.tools.execute !== 'function') {
      throw new Error('ptc-plus: DSH tools.execute is required for derived edit execution')
    }
    const persistedCallSeq = currentDurableReplay ? persistedTargetCallSeq : undefined
    const id = sessionId(agent)
    let claims = editClaims.get(id)
    if (claims === undefined) {
      claims = new Map()
      editClaims.set(id, claims)
    } else {
      for (const [callSeq, phase] of claims) {
        if (phase === 'settled' && callSeq !== target.callSeq) claims.delete(callSeq)
      }
    }
    if (claims.has(target.callSeq)) {
      return { edited: false, reason: 'the current edit target already has a derived execution' }
    }
    claims.set(target.callSeq, 'executing')
    let retainClaim = false
    let finalizeTentative
    try {
      const dispatch = () => ctx.tools.execute({
        callId: `${String(exec.callId)}:derived`,
        name: RUN_CODE,
        arguments: { code: edited.code, description: edited.description },
        agent,
        signal: exec.signal,
      })
      const tentative = await executeTentative(persistedCallSeq, dispatch)
      const inner = tentative.result
      finalizeTentative = tentative.finalize
      const journalValue = isRecord(inner?.meta) && Object.hasOwn(inner.meta, JOURNAL_KEY)
        ? inner.meta[JOURNAL_KEY]
        : undefined
      const journal = journalValue === undefined ? undefined : normalizeJournal(journalValue)
      if (journal === undefined || journal.status === 'noop') return unavailableDerivedResult(inner)
      const rewrites = validatedRewrites(inner.meta)
      const recoveryBoundaries = isRecord(inner?.meta)
        && Object.hasOwn(inner.meta, RECOVERY_BOUNDARY_KEY)
        ? normalizeRecoveryBoundaries(inner.meta[RECOVERY_BOUNDARY_KEY])
        : undefined
      const replMemory = validatedReplMemorySnapshot(inner?.meta)
      const value = derivedEditResult(inner)
      const derived = {
        targetCallSeq: target.callSeq,
        journal,
        rewrites,
        recoveryBoundaries,
        replMemory,
        code: edited.code,
        description: edited.description,
      }
      editExecutionMetadata.set(args, derived)
      claims.set(target.callSeq, 'settled')
      pendingSettlements.set(exec, {
        id,
        targetCallSeq: target.callSeq,
        expectedMeta: derivedMetadata(derived),
        finalize: finalizeTentative,
      })
      finalizeTentative = undefined
      retainClaim = true
      return value
    } finally {
      finalizeTentative?.(false)
      if (!retainClaim) releaseClaim(id, target.callSeq)
    }
  }

  const uninstall = (agent) => {
    const installed = installedScopes.get(agent)
    if (installed === undefined) return
    installedScopes.delete(agent)
    installed.dispose()
  }

  return Object.freeze({
    definition,
    reconfigure(nextConfig) {
      currentDurableReplay = nextConfig.durableReplay
    },
    isInstalled(agent) {
      return installedScopes.has(agent)
    },
    ensureInstalled(agent) {
      const installed = installedScopes.get(agent)
      if (installed !== undefined) return installed.definition
      const liveSchemas = typeof toolSchemasForAgent === 'function'
        ? toolSchemasForAgent(agent)
        : []
      if (Array.isArray(liveSchemas)
        && liveSchemas.some(schema => schema?.name === EDIT_RUN_CODE)) {
        throw new Error('ptc-plus: cannot install edit_run_code; the agent scope already owns that tool name')
      }
      const scopedTools = agent?.ctx?.tools
      if (typeof scopedTools?.register !== 'function' || typeof scopedTools.presentAs !== 'function') {
        throw new Error('ptc-plus: DSH agent-scoped tools.register and tools.presentAs are required to expose edit_run_code')
      }
      const disposeRegistration = scopedTools.register(definition)
      if (typeof disposeRegistration !== 'function') {
        throw new Error('ptc-plus: DSH tools.register did not return a disposer')
      }
      let disposePresentation
      try {
        disposePresentation = scopedTools.presentAs('both')
        if (typeof disposePresentation !== 'function') {
          throw new Error('ptc-plus: DSH tools.presentAs did not return a disposer')
        }
      } catch (error) {
        disposeRegistration()
        throw error
      }
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        disposePresentation()
        disposeRegistration()
      }
      installedScopes.set(agent, { definition, dispose, sessionId: sessionId(agent) })
      return definition
    },
    handleResult(exec, result) {
      const pending = pendingSettlements.get(exec)
      pendingSettlements.delete(exec)
      if (pending === undefined) return
      const persisted = derivedEditResultsEqual(
        result?.meta,
        pending.expectedMeta,
        pending.targetCallSeq,
      )
      pending.finalize(persisted)
      if (persisted) return
      releaseClaim(pending.id, pending.targetCallSeq)
    },
    disposeAgent(agent) {
      uninstall(agent)
      const id = sessionId(agent)
      if (id !== undefined) {
        discardSettlements(id)
        editClaims.delete(id)
      }
    },
    disposeSession(session) {
      const id = String(session.id)
      for (const [agent, installed] of installedScopes) {
        if (installed.sessionId !== id) continue
        installedScopes.delete(agent)
        installed.dispose()
      }
      discardSettlements(id)
      editClaims.delete(id)
    },
    dispose() {
      discardSettlements()
      editClaims.clear()
      for (const installed of installedScopes.values()) installed.dispose()
      installedScopes.clear()
    },
  })
}
