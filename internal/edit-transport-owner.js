/** Own the scoped edit tool, target claims, derived metadata, and paired disposers. */
import {
  DERIVED_RUN_KEY,
  EDIT_TARGET_KEY,
  JOURNAL_KEY,
  RECOVERY_BOUNDARY_KEY,
  REWRITES_KEY,
  isCanonicalSequence,
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
import { projectSessionLog } from './session-log-view.js'
import { sessionEvents } from './session-events.js'
import { deepEqualJson, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { RUN_CODE } from './runtime-bridge-owner.js'
import { CAPABILITY_EVIDENCE_KEY } from './capability-environment.js'
import { isRecord } from './record-utils.js'
import {
  userBindingDraftCapabilityFromMeta,
  withUserBindingDraftCapability,
} from './user-binding-draft-projection.js'
import {
  userBindingsSnapshotFromMeta,
  withUserBindingsSnapshot,
} from './user-bindings.js'
import {
  validatedReplMemorySnapshot,
  withReplMemorySnapshot,
} from './repl-memory-projection.js'

export const EDIT_RUN_CODE = 'edit_run_code'

function nestedEditStart(sessionLog, exec) {
  const events = sessionEvents(sessionLog)
  if (!Array.isArray(events) || typeof exec?.callId !== 'string'
    || typeof exec?.rootCallId !== 'string') return undefined
  const rootCallSeq = liveToolCallSeq(sessionLog, exec.rootCallId, RUN_CODE)
  if (rootCallSeq === undefined) return undefined
  const roots = events.flatMap((event, index) => event?.seq === rootCallSeq
    ? [{ event, index }] : [])
  if (roots.length !== 1 || roots[0].event?.type !== 'tool/call'
    || roots[0].event.data?.callId !== exec.rootCallId
    || roots[0].event.data?.name !== RUN_CODE) return undefined
  const matches = events.flatMap((event, index) => (
    index > roots[0].index && event?.type === 'tool/ptc-dispatch-start'
      && event.data?.subCallId === exec.callId
      && event.data?.name === EDIT_RUN_CODE
      ? [{ event, index }] : []
  ))
  if (matches.length !== 1) return undefined
  const { event, index } = matches[0]
  if (!isCanonicalSequence(event.seq) || event.seq <= rootCallSeq
    || events.filter(candidate => candidate?.seq === event.seq).length !== 1
    || event.data.rootCallId !== exec.rootCallId
    || event.data.parentCallId !== exec.rootCallId
    || !deepEqualJson(event.data.arguments, exec.arguments)) return undefined
  const target = projectSessionLog({ session: { events: events.slice(0, index + 1) } }).editableRun
  return { startSeq: event.seq, rootCallSeq, target }
}

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

function derivedPresentation(inner) {
  return {
    content: inner.content,
    ...(inner.additionalContexts === undefined ? {} : { additionalContexts: inner.additionalContexts }),
    ...(inner.concludesTurn === true ? { concludesTurn: true } : {}),
  }
}

export function createEditTransportOwner(ctx, {
  canScheduleEdit,
  executeTentative,
  presentationGeneration,
  scheduleEdit,
  sessionId,
  toolSchemasForAgent,
  readSessionLog,
}) {
  const editClaims = new Map()
  const pendingAcceptances = new Map()
  const installedScopes = new Map()

  const releaseClaim = (id, targetCallSeq) => {
    const claims = editClaims.get(id)
    claims?.delete(targetCallSeq)
    if (claims?.size === 0) editClaims.delete(id)
  }

  const discardSettlements = (id) => {
    for (const [exec, pending] of pendingAcceptances) {
      if (id !== undefined && pending.id !== id) continue
      pendingAcceptances.delete(exec)
      pending.finish(false)
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
    if (derived.capabilityEvidence !== undefined) meta[CAPABILITY_EVIDENCE_KEY] = derived.capabilityEvidence
    if (derived.rewrites !== undefined) {
      meta[REWRITES_KEY] = normalizeRewrites(derived.rewrites)
    }
    if (derived.recoveryBoundaries !== undefined) {
      meta[RECOVERY_BOUNDARY_KEY] = normalizeRecoveryBoundaries(derived.recoveryBoundaries)
    }
    const withBindings = derived.userBindings === undefined
      ? meta
      : withUserBindingsSnapshot(meta, derived.userBindings)
    const withDraft = derived.draftCapability === undefined
      ? withBindings
      : withUserBindingDraftCapability(
          withBindings,
          derived.draftCapability,
          presentationGeneration,
        )
    return derived.replMemory === undefined
      ? withDraft
      : withReplMemorySnapshot(withDraft, derived.replMemory, presentationGeneration)
  }
  definition.output = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accepted: { type: 'boolean' },
        scheduled: { type: 'boolean' },
        target_call_seq: { type: 'integer' },
        reason: { type: 'string' },
      },
      required: ['accepted', 'scheduled'],
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}) }],
  }
  definition.execute = async (args, exec) => {
    if (canScheduleEdit?.(exec) !== true) {
      return { accepted: false, scheduled: false, reason: 'edit requires an active root run_code cell' }
    }
    const agent = exec?.agent
    const sessionLog = await readSessionLog(agent?.session, exec.signal)
    const start = nestedEditStart(sessionLog, exec)
    if (start === undefined) {
      throw new Error('ptc-plus: edit_run_code requires a unique persisted PTC sub-call start')
    }
    const target = start.target
    if (target?.source === undefined || target.callSeq === undefined) {
      return { accepted: false, scheduled: false, reason: 'no run_code cell is currently eligible for safe editing' }
    }
    const edited = editRejectedCell(args, target.source)
    if (!edited.edited) return { accepted: false, scheduled: false, reason: edited.reason }
    const expectedTargetCallSeq = args[EXPECTED_TARGET_CALL_SEQ]
    if (expectedTargetCallSeq !== undefined && expectedTargetCallSeq !== target.callSeq) {
      return {
        accepted: false,
        scheduled: false,
        reason: `validated repair targets run_code call ${expectedTargetCallSeq}, but this edit captured call ${target.callSeq}`,
      }
    }
    if (typeof ctx.tools.execute !== 'function') {
      throw new Error('ptc-plus: DSH tools.execute is required for derived edit execution')
    }
    const id = sessionId(agent)
    let claims = editClaims.get(id)
    if (claims === undefined) {
      claims = new Map()
      editClaims.set(id, claims)
    }
    if (claims.has(target.callSeq)) {
      return { accepted: false, scheduled: false, reason: 'the current edit target already has a derived execution' }
    }
    claims.set(target.callSeq, 'scheduled')
    const receipt = { accepted: true, scheduled: true, target_call_seq: target.callSeq }
    const pending = {
      id,
      receipt,
      confirmed: false,
      startSeq: start.startSeq,
      rootCallSeq: start.rootCallSeq,
      subCallId: exec.callId,
      targetCallSeq: target.callSeq,
      finalized: false,
      finalizeTentative: undefined,
      finish(confirmed) {
        if (this.finalized) return
        this.finalized = true
        pendingAcceptances.delete(exec)
        this.finalizeTentative?.(confirmed)
        releaseClaim(id, target.callSeq)
      },
      async dispatch(rootSignal, rootExec) {
        if (!this.confirmed || this.finalized || rootSignal.aborted) {
          this.finish(false)
          return { outcome: { edited: false, reason: 'accepted edit was cancelled before derived execution' } }
        }
        if (rootExec?.name !== RUN_CODE || rootExec.callId !== exec.rootCallId
          || rootExec.agent !== agent || rootExec.token === undefined) {
          throw new Error('ptc-plus: derived edit requires its actual root transport execution')
        }
        const argumentsValue = snapshotJsonValue({ code: edited.code, description: edited.description })
        if (argumentsValue === undefined) throw new Error('ptc-plus: derived source is not losslessly JSON-serializable')
        const executionLog = await readSessionLog(agent.session, rootSignal)
        if (rootSignal.aborted || this.finalized) {
          this.finish(false)
          return { outcome: { edited: false, reason: 'accepted edit was cancelled before derived execution' } }
        }
        const data = { rootCallId: exec.rootCallId, parentCallId: rootExec.callId,
          subCallId: `${String(exec.callId)}:derived`, name: RUN_CODE, arguments: argumentsValue }
        const executionStart = agent.session.append('tool/ptc-dispatch-start', data)
        const derivedExec = { callId: data.subCallId, rootCallId: data.rootCallId,
          parent: rootExec.token, name: RUN_CODE, arguments: argumentsValue, agent, signal: rootSignal }
        const dispatch = () => ctx.tools.execute(derivedExec)
        const tentative = await executeTentative(executionStart.seq, start.rootCallSeq,
          dispatch, executionLog, derivedExec)
        const inner = tentative.result
        const metadata = tentative.metadata ?? inner.meta
        this.finalizeTentative = tentative.finalize
        let content = inner.content
        try {
          content = await ctx.waterfall(scopeTarget(ctx.tools, agent), 'tools/ptc-dispatch-log', {
            exec: rootExec, agent, subCallId: data.subCallId, name: RUN_CODE,
            isError: inner.isError, content: inner.content,
          }, () => Promise.resolve(inner.content))
        } catch {
          // A log projector cannot change the settled execution or omit its fact.
          content = inner.content
        }
        try {
          agent.session.append('tool/ptc-dispatch', { ...data, isError: inner.isError,
            ...(inner.error?.info === undefined ? {} : { error: inner.error.info }),
            content,
            ...(metadata === undefined ? {} : { meta: metadata }),
          })
        } catch (error) {
          this.finish(false)
          throw error
        }
        const journalValue = isRecord(metadata) && Object.hasOwn(metadata, JOURNAL_KEY)
          ? metadata[JOURNAL_KEY] : undefined
        const journal = journalValue === undefined ? undefined : normalizeJournal(journalValue)
        if (journal === undefined || journal.status === 'noop'
          || inner.isError !== (journal.completion?.kind === 'throw' || journal.status === 'discarded')) {
          this.finish(false)
          return { outcome: unavailableDerivedResult(inner), presentation: derivedPresentation(inner) }
        }
        const derived = {
          targetCallSeq: target.callSeq,
          journal,
          rewrites: validatedRewrites(metadata),
          recoveryBoundaries: isRecord(metadata) && Object.hasOwn(metadata, RECOVERY_BOUNDARY_KEY)
            ? normalizeRecoveryBoundaries(metadata[RECOVERY_BOUNDARY_KEY]) : undefined,
          replMemory: validatedReplMemorySnapshot(metadata, presentationGeneration),
          userBindings: userBindingsSnapshotFromMeta(metadata),
          draftCapability: userBindingDraftCapabilityFromMeta(metadata, presentationGeneration),
          capabilityEvidence: metadata?.[CAPABILITY_EVIDENCE_KEY],
          code: edited.code,
          description: edited.description,
        }
        return {
          outcome: derivedEditResult(inner),
          presentation: derivedPresentation(inner),
          provenance: {
            startSeq: start.startSeq,
            executionStartSeq: executionStart.seq,
            rootCallSeq: start.rootCallSeq,
            subCallId: exec.callId,
            meta: derivedMetadata(derived),
          },
        }
      },
    }
    if (scheduleEdit?.(exec, pending) !== true) {
      pending.finish(false)
      return { accepted: false, scheduled: false, reason: 'edit requires an active root run_code cell' }
    }
    pendingAcceptances.set(exec, pending)
    return receipt
  }

  const disposeInstalled = (installed) => {
    const failures = []
    for (const key of ['disposeRegistration']) {
      const dispose = installed[key]
      if (dispose === undefined) continue
      try {
        dispose()
        installed[key] = undefined
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'ptc-plus: edit_run_code scope disposal failed')
    }
  }

  const uninstall = (agent) => {
    const installed = installedScopes.get(agent)
    if (installed === undefined) return
    try {
      disposeInstalled(installed)
    } finally {
      if (installed.disposeRegistration === undefined) {
        installedScopes.delete(agent)
      }
    }
  }

  return Object.freeze({
    definition,
    isInstalled(agent) {
      const installed = installedScopes.get(agent)
      return installed?.disposeRegistration !== undefined
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
      if (typeof scopedTools?.register !== 'function') {
        throw new Error('ptc-plus: DSH agent-scoped tools.register is required to expose edit_run_code')
      }
      const disposeRegistration = scopedTools.register(definition)
      if (typeof disposeRegistration !== 'function') {
        throw new Error('ptc-plus: DSH tools.register did not return a disposer')
      }
      const nextInstalled = {
        definition,
        disposeRegistration,
        sessionId: sessionId(agent),
      }
      installedScopes.set(agent, nextInstalled)
      return definition
    },
    handleResult(exec, result) {
      const pending = pendingAcceptances.get(exec)
      if (pending === undefined) return
      const accepted = result?.isError === false
        && deepEqualJson(result.value, pending.receipt)
      pending.confirmed = accepted
      if (!accepted) pending.finish(false)
    },
    disposeAgent(agent) {
      let failure
      try {
        uninstall(agent)
      } catch (error) {
        failure = error
      }
      const id = sessionId(agent)
      if (id !== undefined) {
        discardSettlements(id)
        editClaims.delete(id)
      }
      if (failure !== undefined) throw failure
    },
    disposeSession(session) {
      const id = String(session.id)
      const failures = []
      for (const [agent, installed] of installedScopes) {
        if (installed.sessionId !== id) continue
        try {
          uninstall(agent)
        } catch (error) {
          failures.push(error)
        }
      }
      discardSettlements(id)
      editClaims.delete(id)
      if (failures.length > 0) {
        throw new AggregateError(failures, 'ptc-plus: edit_run_code session disposal failed')
      }
    },
    dispose() {
      discardSettlements()
      editClaims.clear()
      const failures = []
      for (const agent of [...installedScopes.keys()]) {
        try {
          uninstall(agent)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'ptc-plus: edit_run_code owner disposal failed')
      }
    },
  })
}
