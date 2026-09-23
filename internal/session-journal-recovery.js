import { isDeepStrictEqual } from 'node:util'
import { isRecord } from './record-utils.js'
import { sessionEvents } from './session-events.js'
import {
  JOURNAL_KEY,
  RECOVERY_BOUNDARY_KEY,
  RECOVERY_BOUNDARY_EVENT,
  LEGACY_JOURNAL_VERSION,
  REPL_TOOL_NAMES,
} from './session-journal-schema.js'
import {
  isCanonicalSequence,
  normalizeDerivedEditResult,
  normalizeJournal,
  normalizeRecoveryBoundaries,
  reduceStateOperations,
  userBindingsForJournal,
  validatedRewrites,
} from './session-journal.js'

const RECOVERY_BOUNDARY_EVIDENCE = Symbol('recoveryBoundaryEvidence')
const MODEL_VISIBLE_SURFACE_EVENTS = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

function sourceForRunCall(call) {
  try {
    const args = JSON.parse(call.data.arguments)
    return isRecord(args) && typeof args.code === 'string' ? args.code : undefined
  } catch {
    return undefined
  }
}

/** Select the boundary of a failed replay node or an unavailable recovered suffix. */
export function recoveryBoundaryForHistory(history, failedNode, { reset = false } = {}) {
  if (reset) failedNode = history.nodes[0]
  const failedCallSeq = failedNode === undefined
    ? history.available === false ? history.volatileSuffix[0]?.seq : undefined
    : failedNode.callSeq
  if (failedCallSeq === undefined) return undefined
  const frontier = reset ? undefined : failedNode === undefined ? history.head : failedNode.parent
  return {
    failedCallSeq,
    frontierCallSeq: frontier === undefined ? null : history.nodes[frontier]?.callSeq ?? null,
  }
}

/** A confirmation only covers an earlier executable call with no persisted result. */
export function isConfirmableNoop(timeline, callSeq, resultEventIndex) {
  const call = timeline.executableCalls.get(callSeq)
  return call !== undefined && call.eventIndex < resultEventIndex && !timeline.results.has(callSeq)
}

function applyOperations(state, operations, nodeIndex) {
  const transition = reduceStateOperations(state, operations, nodeIndex)
  state.head = transition.head
  state.checkpoints = transition.checkpoints
  if (transition.restored) {
    state.trusted = true
    state.volatileSuffix.length = 0
  }
}

function applyRecord(state, record, invalidCallSeqs) {
  const { call, code, result } = record
  if (invalidCallSeqs.has(call.seq)) return
  const journal = result.journal
  if (journal.status === 'noop') return
  if (journal.status === 'discarded') {
    if (journal.volatileReason !== undefined) {
      state.trusted = false
      state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason })
    }
    return
  }
  if (journal.status === 'volatile') {
    state.trusted = false
    state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason ?? 'volatile cell' })
    applyOperations(state, journal.operations, undefined)
    return
  }
  if (!state.trusted && !state.surfaceContracted) {
    state.trusted = true
    state.volatileSuffix.length = 0
  }
  const node = Object.freeze({
    code,
    journal,
    callSeq: call.seq,
    parent: state.head,
    ...(result.userBindings === undefined ? {} : { userBindings: result.userBindings }),
  })
  const index = state.nodes.push(node) - 1
  state.head = index
  try {
    applyOperations(state, journal.operations, index)
  } catch (error) {
    state.nodes.pop()
    state.head = node.parent
    throw error
  }
}

function recordEventSeq(record) {
  // A settlement that the Host re-published as a pruned clone carries the
  // clone's row sequence, but it is still the same settlement: ordering and
  // boundary application use its settlement position so a recorded boundary
  // finds the call it names already folded.
  return record.result?.positionSeq ?? record.result?.eventSeq ?? record.call.seq
}

function foldRecords(records, invalidCallSeqs, options = {}) {
  const state = {
    nodes: [],
    head: undefined,
    checkpoints: new Map(),
    volatileSuffix: [],
    trusted: true,
    surfaceContracted: options.surfaceContracted === true,
  }
  for (const record of records) {
    applyRecord(state, record, invalidCallSeqs)
  }
  return state
}

function dependsOn(nodes, index, ancestor) {
  for (let cursor = index; cursor !== undefined; cursor = nodes[cursor]?.parent) {
    if (cursor === ancestor) return true
  }
  return false
}

/** Return executable call sequences whose provenance remains model-visible. */
export function visibleExecutableCallSeqs(session) {
  let events
  let nodes
  try {
    events = sessionEvents(session)
    nodes = session?.surface?.nodes
  } catch {
    return new Set()
  }
  if (!Array.isArray(events) || !Array.isArray(nodes)) return new Set()
  const eventBySeq = new Map()
  const duplicateEventSeqs = new Set()
  for (const event of events) {
    if (!isCanonicalSequence(event?.seq)) return new Set()
    if (eventBySeq.has(event.seq)) duplicateEventSeqs.add(event.seq)
    else eventBySeq.set(event.seq, event)
  }
  const visible = new Set()
  for (const seq of nodes) {
    const event = eventBySeq.get(seq)
    if (!isCanonicalSequence(seq) || event === undefined
      || duplicateEventSeqs.has(seq) || !MODEL_VISIBLE_SURFACE_EVENTS.has(event.type)
      || visible.has(seq)) return new Set()
    visible.add(seq)
  }
  const visibleAssistantCallSeqs = new Set()
  const pendingAssistantCalls = new Map()
  for (const event of events) {
    if (event?.type === 'turn/start' || event?.type === 'turn/end') {
      pendingAssistantCalls.clear()
      continue
    }
    if (event?.type === 'assistant/message') {
      pendingAssistantCalls.clear()
      const content = event.data?.message?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'tool-call' && typeof part.id === 'string') {
            const isVisible = visible.has(event.seq)
            const candidate = {
              isVisible,
              name: typeof part.name === 'string' ? part.name : undefined,
              arguments: typeof part.arguments === 'string' ? part.arguments : undefined,
            }
            pendingAssistantCalls.set(part.id,
              pendingAssistantCalls.has(part.id) ? null : candidate)
          }
        }
      }
      continue
    }
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      const candidate = pendingAssistantCalls.get(event.data.callId)
      pendingAssistantCalls.delete(event.data.callId)
      if (candidate !== undefined && candidate !== null) {
        if (candidate.isVisible && REPL_TOOL_NAMES.has(event.data.name)
          && candidate.name === event.data.name
          && candidate.arguments === event.data.arguments) {
          visibleAssistantCallSeqs.add(event.seq)
        }
      }
    }
  }
  const calls = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/call' || !REPL_TOOL_NAMES.has(event.data?.name)) continue
    if (visibleAssistantCallSeqs.has(event.seq)) calls.add(event.seq)
  }
  return calls
}

function timelineRun(call, result, eventIndex, journal) {
  let args
  try {
    const parsed = JSON.parse(call.data.arguments)
    if (isRecord(parsed)) args = Object.freeze(parsed)
  } catch {
    // Invalid persisted arguments cannot support derived source facts.
  }
  return Object.freeze({
    index: eventIndex,
    callSeq: isCanonicalSequence(call.seq) ? call.seq : undefined,
    args,
    source: typeof args?.code === 'string' ? args.code : undefined,
    journal,
    rewrites: validatedRewrites(result.data?.meta),
  })
}

function timelineDerivedRun(call, result, eventIndex, derived) {
  return Object.freeze({
    index: eventIndex,
    callSeq: isCanonicalSequence(call.seq) ? call.seq : undefined,
    args: Object.freeze({ description: derived.description }),
    source: derived.code,
    journal: derived.journal,
    rewrites: validatedRewrites(result.data?.meta),
  })
}

function successfulTimelineRun(run) {
  return run.journal?.completion?.kind === 'return' && run.journal.status !== 'noop'
}

function pruneWindowForEvent(event, eventIndex) {
  const shadowedSeqs = event.data.shadowedSeqs
  const seqs = new Set(shadowedSeqs)
  const shadowedRange = event.data.shadowedRange
  const rangeValid = shadowedRange === undefined
    || (isRecord(shadowedRange)
      && shadowedRange.start === shadowedSeqs[0]
      && shadowedRange.end === shadowedSeqs[shadowedSeqs.length - 1])
  const valid = shadowedSeqs.length > 0
    && seqs.size === shadowedSeqs.length
    && shadowedSeqs.every(isCanonicalSequence)
    && shadowedSeqs.every((seq, index) => index === 0 || seq > shadowedSeqs[index - 1])
    && rangeValid
  return { seqs: valid ? seqs : new Set(), lastEventIndex: eventIndex }
}

function continuesPruneWindow(window, event, eventIndex) {
  return event?.type === 'compaction/prune' || eventIndex === window.lastEventIndex + 1
}

function identifiesPrunedResult(window, event, eventIndex) {
  const sourceSeq = event.sourceEventSeqs?.[0]
  return isCanonicalSequence(sourceSeq)
    && window?.seqs.has(sourceSeq)
    && eventIndex === window.lastEventIndex + 1
    && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length === 1
    && typeof event.data?.message?.source?.callId === 'string'
}

function replacesPendingCall(candidate, event, pruneSeq) {
  if (candidate === undefined || candidate === null) return false
  const candidateSeq = candidate.event.seq
  const sourceSeq = event.sourceEventSeqs[0]
  const surfaceOp = event.surfaceOp
  const orderedIdentity = REPL_TOOL_NAMES.has(candidate.event.data.name)
    && isCanonicalSequence(candidateSeq)
    && sourceSeq > candidateSeq
    && isCanonicalSequence(pruneSeq)
    && isCanonicalSequence(event.seq) && event.seq - pruneSeq === 1
    && sourceSeq < pruneSeq
  const legacyReplacement = isRecord(surfaceOp)
    && Reflect.ownKeys(surfaceOp).length === 3
    && surfaceOp.op === 'replace'
    && surfaceOp.start === sourceSeq
    && surfaceOp.end === sourceSeq
  const currentReplacement = isRecord(surfaceOp)
    && Reflect.ownKeys(surfaceOp).length === 3
    && surfaceOp.op === 'replace'
    && surfaceOp.startSeq === sourceSeq
    && surfaceOp.endSeq === sourceSeq
  const exactReplacement = surfaceOp === undefined || legacyReplacement || currentReplacement
  return orderedIdentity && exactReplacement
}

/** The exact single-event surface replacement the Host pruner appends. */
function exactResultReplacement(event, sourceSeq) {
  const surfaceOp = event.surfaceOp
  if (!isRecord(surfaceOp) || Reflect.ownKeys(surfaceOp).length !== 3 || surfaceOp.op !== 'replace') {
    return false
  }
  return (surfaceOp.start === sourceSeq && surfaceOp.end === sourceSeq)
    || (surfaceOp.startSeq === sourceSeq && surfaceOp.endSeq === sourceSeq)
}

/** A replacement representation may differ from its shadowed result only in message content. */
function sameResultExceptContent(previous, next) {
  const withoutContent = data => isRecord(data) && isRecord(data.message)
    ? { ...data, message: { ...data.message, content: undefined } }
    : data
  return isDeepStrictEqual(withoutContent(previous), withoutContent(next))
}

/**
 * Fold persisted tool events once into the call/result and edit-target timeline
 * shared by prompt projection and cold journal recovery.
 */
export function foldSessionTimeline(events) {
  const empty = {
    openTurn: false,
    executableCalls: new Map(),
    calls: [],
    results: new Map(),
    boundaries: [],
    found: false,
    unavailableResultSeq: undefined,
    unavailableResultReason: undefined,
    lastSuccessfulRunIndex: undefined,
    latestRun: undefined,
    editableRun: undefined,
    editTargets: new Map(),
  }
  if (!Array.isArray(events)) return empty

  const state = { ...empty }
  const pendingByCallId = new Map()
  const seenCallIds = new Set()
  const claimedEditTargets = new Set()
  const editClaims = new Map()
  const ordinaryResultSeqs = new Set()
  const settledResultsByEventSeq = new Map()
  let pruneReplacementWindow
  let scope = 0

  const resetTurn = (openTurn) => {
    state.openTurn = openTurn
    scope += 1
    pendingByCallId.clear()
    seenCallIds.clear()
    claimedEditTargets.clear()
    state.latestRun = undefined
    state.editableRun = undefined
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]
    if (pruneReplacementWindow !== undefined
      && !continuesPruneWindow(pruneReplacementWindow, event, eventIndex)) {
      pruneReplacementWindow = undefined
    }
    if (event?.type === 'turn/start') {
      resetTurn(true)
      continue
    }
    if (event?.type === 'turn/end') {
      resetTurn(false)
      continue
    }
    if (event?.type === RECOVERY_BOUNDARY_EVENT) {
      state.unavailableResultSeq ??= isCanonicalSequence(event.seq) ? event.seq : eventIndex
      continue
    }
    if (event?.type === 'compaction/prune' && Array.isArray(event.data?.shadowedSeqs)) {
      pruneReplacementWindow = pruneWindowForEvent(event, eventIndex)
      continue
    }
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      const executable = REPL_TOOL_NAMES.has(event.data.name)
      let entry = { event, eventIndex, scope }
      if (executable) {
        if (isCanonicalSequence(event.seq) && state.executableCalls.has(event.seq)) {
          // A sequence collision disproves both sources, but not the earlier
          // verified frontier. Keep its position for persistent contraction.
          const previous = state.executableCalls.get(event.seq)
          previous.ambiguous = true
          state.unavailableResultSeq = Math.min(state.unavailableResultSeq ?? event.seq, event.seq)
          if (state.unavailableResultReason === undefined
            || event.seq < state.unavailableResultReason.seq) {
            state.unavailableResultReason = {
              seq: event.seq,
              reason: `duplicate executable tool call sequence ${event.seq}`,
            }
          }
          state.found = true
          state.latestRun = undefined
          state.editableRun = undefined
          pendingByCallId.set(previous.event.data.callId, null)
          pendingByCallId.set(event.data.callId, null)
          seenCallIds.add(event.data.callId)
          continue
        }
        if (event.data.name === 'edit_run_code') {
          const targetCallSeq = state.editableRun?.callSeq
          const target = targetCallSeq !== undefined && state.editableRun.source !== undefined
            && !claimedEditTargets.has(targetCallSeq)
            ? Object.freeze({ source: state.editableRun.source, callSeq: targetCallSeq })
            : undefined
          entry = { ...entry, editTarget: target }
          state.editTargets.set(event.seq, target)
          if (target !== undefined) {
            claimedEditTargets.add(target.callSeq)
            editClaims.set(event.seq, target.callSeq)
          }
        }
        state.calls.push(event)
        if (isCanonicalSequence(event.seq)) {
          state.executableCalls.set(event.seq, entry)
        }
      }
      if (seenCallIds.has(event.data.callId)) pendingByCallId.set(event.data.callId, null)
      else {
        seenCallIds.add(event.data.callId)
        pendingByCallId.set(event.data.callId, entry)
      }
      continue
    }
    if (event?.type !== 'tool/result') continue

    const hasSourceRelation = Object.hasOwn(event, 'sourceEventSeqs')
    const sourceRelation = event.sourceEventSeqs
    const sourceSeq = sourceRelation?.[0]
    const canonicalSourceRelation = Array.isArray(sourceRelation)
      && sourceRelation.length === 1
      && isCanonicalSequence(sourceSeq)
    const callId = event.data?.message?.source?.callId
    let entry = canonicalSourceRelation ? state.executableCalls.get(sourceSeq) : undefined
    let prunedReplacement = false
    if (entry === undefined && identifiesPrunedResult(pruneReplacementWindow, event, eventIndex)) {
      const candidate = pendingByCallId.get(callId)
      const pruneSeq = events[pruneReplacementWindow.lastEventIndex]?.seq
      if (replacesPendingCall(candidate, event, pruneSeq)) {
        entry = candidate
        prunedReplacement = true
        pruneReplacementWindow.lastEventIndex = eventIndex
      }
    }
    if (entry === undefined && !hasSourceRelation && typeof callId === 'string') {
      entry = pendingByCallId.get(callId)
    }
    if (entry === undefined && canonicalSourceRelation) {
      // The Host pruner may replace an already-settled result with a
      // content-only clone that cites the shadowed result event. It is the same
      // call's settlement representation, not a new unknown boundary.
      const settled = settledResultsByEventSeq.get(sourceSeq)
      if (settled !== undefined && typeof callId === 'string'
        && settled.call?.data?.callId === callId
        && exactResultReplacement(event, sourceSeq)
        && sameResultExceptContent(settled.data, event.data)) {
        entry = settled.entry
        prunedReplacement = true
      }
    }
    if (hasSourceRelation && !canonicalSourceRelation) {
      const identityEntry = typeof callId === 'string' ? pendingByCallId.get(callId) : undefined
      const callSeqs = new Set(Array.isArray(sourceRelation)
        ? sourceRelation
          .filter(isCanonicalSequence)
          .map(candidateSeq => state.executableCalls.get(candidateSeq)?.event?.seq)
          .filter(isCanonicalSequence)
        : [])
      if (isCanonicalSequence(identityEntry?.event?.seq)) {
        callSeqs.add(identityEntry.event.seq)
      }
      if (callSeqs.size > 0) {
        const callSeq = Math.min(...callSeqs)
        state.unavailableResultSeq = Math.min(state.unavailableResultSeq ?? callSeq, callSeq)
        state.results.set(callSeq, {
          eventSeq: isCanonicalSequence(event.seq) ? event.seq : callSeq,
          eventIndex,
          error: `tool result has an invalid source relation for call seq ${callSeq}`,
        })
        state.found = true
      }
      if (typeof callId === 'string') pendingByCallId.delete(callId)
      state.latestRun = undefined
      state.editableRun = undefined
      continue
    }
    if (typeof callId === 'string') pendingByCallId.delete(callId)
    if (entry === null) {
      state.latestRun = undefined
      state.editableRun = undefined
      continue
    }

    const call = entry?.event
    if (entry?.ambiguous) {
      state.latestRun = undefined
      state.editableRun = undefined
      continue
    }
    const callSeq = call?.seq
    const meta = event.data?.meta
    if (!prunedReplacement && isCanonicalSequence(callSeq)) {
      if (ordinaryResultSeqs.has(callSeq)) {
        state.unavailableResultSeq ??= callSeq
        state.results.set(callSeq, {
          eventSeq: isCanonicalSequence(event.seq) ? event.seq : callSeq,
          eventIndex,
          error: `session log contains duplicate ordinary tool results for call seq ${callSeq}`,
        })
        state.found = true
        state.latestRun = undefined
        state.editableRun = undefined
        continue
      }
      ordinaryResultSeqs.add(callSeq)
    }
    if (call !== undefined && typeof callId === 'string' && call.data.callId !== callId) {
      state.latestRun = undefined
      state.editableRun = undefined
      if (isCanonicalSequence(callSeq)) {
        state.unavailableResultSeq ??= callSeq
        state.results.set(callSeq, {
          eventSeq: isCanonicalSequence(event.seq) ? event.seq : callSeq,
          eventIndex,
          error: `tool result identities disagree for call seq ${callSeq}`,
        })
        state.found = true
      }
      continue
    }
    let normalized
    if (isRecord(meta) && Object.hasOwn(meta, JOURNAL_KEY)) {
      if (entry === undefined) {
        if (isCanonicalSequence(sourceSeq)) {
          state.unavailableResultSeq ??= sourceSeq
        }
        continue
      }
      const resultSeq = prunedReplacement
        ? callSeq
        : isCanonicalSequence(sourceSeq) ? sourceSeq : callSeq
      // A pruned clone re-publishes an existing settlement, so it keeps that
      // settlement's position instead of the clone's later row sequence. A
      // recorded recovery boundary names the call it follows, and ordering the
      // clone by its own row would apply the boundary before that call exists
      // in the verified frontier.
      const settlementPosition = prunedReplacement
        ? state.results.get(resultSeq)?.eventSeq ?? resultSeq
        : undefined
      const raw = {
        meta,
        eventSeq: isCanonicalSequence(event.seq) ? event.seq : resultSeq,
        ...(settlementPosition === undefined ? {} : { positionSeq: settlementPosition }),
        eventIndex,
      }
      if (Object.hasOwn(meta, RECOVERY_BOUNDARY_KEY)) {
        try {
          state.boundaries.push(...normalizeRecoveryBoundaries(
            meta[RECOVERY_BOUNDARY_KEY], raw.eventSeq,
          ).map(boundary => ({ ...boundary, carrierCallSeq: resultSeq })))
        } catch {
          state.unavailableResultSeq ??= callSeq
        }
      }
      try {
        if (call.data.name === 'edit_run_code') {
          const derived = normalizeDerivedEditResult(meta, entry.editTarget?.callSeq)
          normalized = {
            ...raw,
            journal: derived.journal,
            derived,
            ...(derived.userBindings === undefined ? {} : { userBindings: derived.userBindings }),
          }
        } else if (call.data.name === 'run_code') {
          const rawJournal = meta[JOURNAL_KEY]
          const resolveLegacyConfirm = rawJournal?.version === LEGACY_JOURNAL_VERSION
            ? legacyCallId => {
              const candidates = [...state.executableCalls.values()]
                .filter(candidate => candidate.eventIndex < eventIndex
                  && candidate.event.data?.name === 'run_code'
                  && candidate.event.data.callId === legacyCallId
                  && !state.results.has(candidate.event.seq))
              return candidates.length === 1 ? candidates[0].event.seq : undefined
            }
            : undefined
          const journal = normalizeJournal(rawJournal, { resolveLegacyConfirm })
          const userBindings = userBindingsForJournal(meta, journal)
          normalized = {
            ...raw,
            journal,
            ...(userBindings === undefined ? {} : { userBindings }),
          }
        }
      } catch (error) {
        normalized = { ...raw, error: error.message }
      }
      if (normalized === undefined) {
        // PTC metadata on a settlement whose call is not a REPL tool is
        // unproved evidence: it must contract the frontier, not escape the fold.
        normalized = { ...raw, error: 'PTC journal metadata appeared on a non-REPL tool result' }
      }
      if (isCanonicalSequence(resultSeq)) state.results.set(resultSeq, normalized)
      if (!prunedReplacement && isCanonicalSequence(event.seq)) {
        settledResultsByEventSeq.set(event.seq, { call, entry, data: event.data })
      }
      state.found = true
    }

    const claimedTarget = editClaims.get(callSeq)
    if (claimedTarget !== undefined) {
      editClaims.delete(callSeq)
      if (normalized?.derived === undefined) claimedEditTargets.delete(claimedTarget)
    }
    if (entry === undefined || entry.scope !== scope) continue
    if (call.data.name === 'edit_run_code') {
      if (normalized?.derived !== undefined) {
        const run = timelineDerivedRun(call, event, eventIndex, normalized.derived)
        state.latestRun = run
        state.editableRun = run
        if (successfulTimelineRun(run)) state.lastSuccessfulRunIndex = eventIndex
      }
      continue
    }
    if (call.data.name !== 'run_code') {
      // Unrelated native settlements do not change the current editable cell.
      // The edit target is captured at dispatch time and remains valid until a
      // new executable cell or turn boundary supersedes it.
      continue
    }
    const run = timelineRun(call, event, eventIndex, normalized?.journal)
    state.latestRun = run
    state.editableRun = run
    if (successfulTimelineRun(run)) state.lastSuccessfulRunIndex = eventIndex
  }
  return state
}

/** Fold the session log into the last exactly replayable frontier. */
export function recoverJournal(session, currentCallSeq, options = {}) {
  const events = sessionEvents(session)
  if (!Array.isArray(events)) {
    return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
  }
  const timeline = foldSessionTimeline(events)
  const calls = timeline.calls.filter(call => call.seq !== currentCallSeq)
  const { executableCalls, results, found } = timeline
  const visibleCalls = options?.visibleCallSeqs
  const appliedBoundaries = options?.[RECOVERY_BOUNDARY_EVIDENCE]
  const invalidCallSeqs = new Set()
  let unavailableBoundary
  const registerUnavailable = ({ seq, reason, code }, recoveryState) => {
    if (unavailableBoundary === undefined || seq <= unavailableBoundary.seq) {
      unavailableBoundary = { seq, reason }
    }
    if (recoveryState === undefined) return
    invalidCallSeqs.add(seq)
    recoveryState.trusted = false
    if (!recoveryState.volatileSuffix.some(item => item.seq === seq)) {
      const item = { seq, code, reason }
      const index = recoveryState.volatileSuffix.findIndex(existing => existing.seq > seq)
      if (index < 0) recoveryState.volatileSuffix.push(item)
      else recoveryState.volatileSuffix.splice(index, 0, item)
    }
  }
  if (timeline.unavailableResultSeq !== undefined) {
    registerUnavailable({
      seq: timeline.unavailableResultSeq,
      reason: timeline.unavailableResultReason?.seq === timeline.unavailableResultSeq
        ? timeline.unavailableResultReason.reason
        : 'unavailable or malformed dsh-ptc-plus journal result',
    })
  }
  for (const [resultSeq, result] of results.entries()) {
    if (result?.error !== undefined && isCanonicalSequence(resultSeq)) {
      registerUnavailable({ seq: resultSeq, reason: result.error })
    }
  }
  const extraBoundaries = options?.extraBoundaries ?? []
  let normalizedExtraBoundaries = []
  try {
    normalizedExtraBoundaries = normalizeRecoveryBoundaries(extraBoundaries, undefined)
  } catch {
    normalizedExtraBoundaries = []
  }
  const boundaries = [
    ...timeline.boundaries,
    ...normalizedExtraBoundaries.map(boundary => ({
      ...boundary,
      eventSeq: Number.POSITIVE_INFINITY,
    })),
  ].sort((left, right) => left.eventSeq - right.eventSeq)
  // An unavailable historical result contracts the replay frontier. It must
  // not prevent the current request from executing on the verified prefix.

  const confirmedNoops = new Set()
  const invalidResultReasons = new Map()
  for (const [resultSeq, { journal, eventIndex }] of results.entries()) {
    const candidateConfirms = []
    for (const callSeq of journal?.confirms ?? []) {
      if (!isConfirmableNoop(timeline, callSeq, eventIndex)) {
        const reason = `confirmed no-op does not identify an earlier unjournaled run_code call seq ${callSeq}`
        invalidResultReasons.set(resultSeq, reason)
        registerUnavailable({ seq: resultSeq, reason })
        break
      }
      candidateConfirms.push(callSeq)
    }
    if (!invalidResultReasons.has(resultSeq)) {
      for (const callSeq of candidateConfirms) confirmedNoops.add(callSeq)
    }
  }
  const records = []
  const orderedRecords = []
  const contractedCallRanges = []
  let state = foldRecords(records, invalidCallSeqs)
  let boundaryIndex = 0
  const carrierCallSeqForBoundary = boundary => boundary.carrierCallSeq
  const isContractedCallSeq = (callSeq) => contractedCallRanges.some(range => (
    callSeq >= range.start && callSeq < range.end
  ))
  const rejectBoundary = (boundary, reason) => {
    const carrierCallSeq = carrierCallSeqForBoundary(boundary)
    const contractionSeq = carrierCallSeq === undefined
      ? boundary.failedCallSeq
      : Math.min(boundary.failedCallSeq, carrierCallSeq)
    // A rejected boundary still establishes a conservative contraction point:
    // the same window an accepted boundary would contract stays unproved, so
    // settlements folded after this rejection cannot re-enter the frontier.
    if (carrierCallSeq !== undefined) {
      contractedCallRanges.push({ start: contractionSeq, end: carrierCallSeq })
    }
    for (const record of records) {
      if (record.call.seq >= contractionSeq) invalidCallSeqs.add(record.call.seq)
    }
    state = foldRecords(records, invalidCallSeqs, {
      surfaceContracted: state.surfaceContracted,
    })
    registerUnavailable({ seq: carrierCallSeq ?? boundary.failedCallSeq, reason }, state)
  }
  const applyBoundariesBefore = (seq) => {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].eventSeq <= seq) {
      const boundary = boundaries[boundaryIndex++]
      const carrierCallSeq = carrierCallSeqForBoundary(boundary)
      const failedCall = executableCalls.get(boundary.failedCallSeq)
      if (failedCall === undefined || failedCall.event.seq >= boundary.eventSeq) {
        rejectBoundary(boundary, 'recovery boundary does not identify an earlier executable call')
        continue
      }
      const failedIndex = state.nodes.findIndex(node => node.callSeq === boundary.failedCallSeq)
      const expectedFrontier = failedIndex < 0 ? state.head : state.nodes[failedIndex].parent
      const frontierIndex = boundary.frontierCallSeq === null
        ? undefined
        : state.nodes.findIndex(node => node.callSeq === boundary.frontierCallSeq)
      if (frontierIndex !== expectedFrontier) {
        rejectBoundary(boundary, 'recovery boundary frontier does not match the failed call parent')
        continue
      }
      const resolvesUnavailable = unavailableBoundary?.seq === boundary.failedCallSeq
      const resolvesConfirmedNoop = confirmedNoops.has(boundary.failedCallSeq)
      if (failedIndex < 0 && !resolvesUnavailable && !resolvesConfirmedNoop) {
        rejectBoundary(boundary, 'recovery boundary failed call is outside the verified frontier')
        continue
      }
      if (carrierCallSeq !== undefined && carrierCallSeq <= boundary.failedCallSeq) {
        rejectBoundary(boundary, 'recovery boundary carrier does not follow the failed call')
        continue
      }
      if (Array.isArray(appliedBoundaries)) appliedBoundaries.push(boundary)
      if (carrierCallSeq !== undefined) {
        contractedCallRanges.push({ start: boundary.failedCallSeq, end: carrierCallSeq })
      }
      for (let index = 0; index < state.nodes.length; index += 1) {
        if (dependsOn(state.nodes, index, failedIndex)) invalidCallSeqs.add(state.nodes[index].callSeq)
      }
      for (const record of records) {
        if ((failedIndex < 0 && record.call.seq >= boundary.failedCallSeq)
          || isContractedCallSeq(record.call.seq)) {
          invalidCallSeqs.add(record.call.seq)
        }
      }
      state = foldRecords(records, invalidCallSeqs, {
        surfaceContracted: resolvesUnavailable ? false : state.surfaceContracted,
      })
      if (resolvesUnavailable) {
        unavailableBoundary = undefined
      }
    }
  }
  for (const call of calls) {
    const result = results.get(call.seq)
    const code = call.data?.name === 'edit_run_code' ? result?.derived?.code : sourceForRunCall(call)
    const record = {
      call,
      code,
      result,
      hidden: visibleCalls instanceof Set && !visibleCalls.has(call.seq),
    }
    if (call.data?.name === 'edit_run_code' && record.code === undefined && result === undefined) continue
    if (result?.journal === undefined && confirmedNoops.has(call.seq)) continue
    orderedRecords.push(record)
  }
  orderedRecords.sort((left, right) => (
    recordEventSeq(left) - recordEventSeq(right) || left.call.seq - right.call.seq
  ))
  for (const record of orderedRecords) {
    applyBoundariesBefore(recordEventSeq(record))
    records.push(record)
    if (isContractedCallSeq(record.call.seq)) {
      invalidCallSeqs.add(record.call.seq)
      continue
    }
    if (record.hidden) {
      state.surfaceContracted = true
      registerUnavailable({
        seq: record.call.seq,
        reason: 'model-visible provenance was shadowed',
      }, state)
      continue
    }
    if (unavailableBoundary !== undefined && record.call.seq >= unavailableBoundary.seq) {
      registerUnavailable({
        seq: record.call.seq,
        code: record.code,
        reason: unavailableBoundary.reason,
      }, state)
      continue
    }
    const invalidReason = invalidResultReasons.get(record.call.seq)
    if (record.result?.journal === undefined || invalidReason !== undefined) {
      registerUnavailable({
        seq: record.call.seq,
        code: record.code,
        reason: invalidReason ?? record.result?.error ?? 'missing dsh-ptc-plus journal result',
      }, state)
      continue
    }
    try {
      applyRecord(state, record, invalidCallSeqs)
    } catch (error) {
      registerUnavailable({ seq: record.call.seq, code: record.code, reason: error.message }, state)
    }
  }
  applyBoundariesBefore(Number.POSITIVE_INFINITY)
  if (unavailableBoundary !== undefined) registerUnavailable(unavailableBoundary, state)
  return {
    nodes: state.nodes,
    head: state.head,
    checkpoints: state.checkpoints,
    volatileSuffix: state.volatileSuffix,
    available: found && !state.surfaceContracted && unavailableBoundary === undefined,
  }
}

/** Prove that recovery consumes every persisted boundary at its declared frontier. */
export function validateRecoveryBoundaryApplication(events) {
  const applied = []
  const recovered = recoverJournal(
    { events },
    undefined,
    { [RECOVERY_BOUNDARY_EVIDENCE]: applied },
  )
  const declared = foldSessionTimeline(events).boundaries.length
  if (!recovered.available || applied.length !== declared) {
    throw new Error('migrated PTC recovery boundary does not prove its declared frontier')
  }
  return recovered
}

/** Return source nodes from the empty state to a selected durable head. */
export function pathToHead(state) {
  const path = []
  for (let cursor = state.head; cursor !== undefined;) {
    const node = state.nodes[cursor]
    if (node === undefined) throw new Error('invalid dsh-ptc-plus journal head')
    path.push(node)
    cursor = node.parent
  }
  path.reverse()
  return path
}
