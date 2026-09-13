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
  normalizeDerivedEditResult,
  normalizeJournal,
  normalizeRecoveryBoundaries,
  reduceStateOperations,
  userBindingsForJournal,
  validatedRewrites,
} from './session-journal.js'

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
  return record.result?.eventSeq ?? record.call.seq
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
  const events = sessionEvents(session)
  let nodes
  try {
    nodes = session?.surface?.nodes
  } catch {
    return undefined
  }
  if (!Array.isArray(events) || !Array.isArray(nodes)) return undefined
  const eventBySeq = new Map()
  for (const event of events) eventBySeq.set(event?.seq, event)
  for (const seq of nodes) {
    if (!Number.isSafeInteger(seq) || seq < 0 || eventBySeq.get(seq) === undefined) return undefined
  }
  const visible = new Set(nodes)
  const resultSources = new Set()
  const visibleAssistantCallSeqs = new Set()
  const pendingAssistantCalls = new Map()
  let assistantCallEvidence = false
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
            if (isVisible) assistantCallEvidence = true
            let occurrences = pendingAssistantCalls.get(part.id)
            if (occurrences === undefined) {
              occurrences = []
              pendingAssistantCalls.set(part.id, occurrences)
            }
            occurrences.push(isVisible)
          }
        }
      }
      continue
    }
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      const occurrences = pendingAssistantCalls.get(event.data.callId)
      if (occurrences !== undefined && occurrences.length > 0) {
        const isVisible = occurrences.shift()
        if (occurrences.length === 0) pendingAssistantCalls.delete(event.data.callId)
        if (isVisible && REPL_TOOL_NAMES.has(event.data.name)) {
          visibleAssistantCallSeqs.add(event.seq)
        }
      }
    }
    if (visible.has(event?.seq)
      && event?.type === 'tool/result' && Array.isArray(event.sourceEventSeqs)) {
      for (const sourceSeq of event.sourceEventSeqs) {
        if (Number.isSafeInteger(sourceSeq) && sourceSeq >= 0) resultSources.add(sourceSeq)
      }
    }
  }
  const calls = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/call' || !REPL_TOOL_NAMES.has(event.data?.name)) continue
    if (assistantCallEvidence
      ? visibleAssistantCallSeqs.has(event.seq)
      : (visible.has(event.seq) || resultSources.has(event.seq))) calls.add(event.seq)
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
    callSeq: Number.isSafeInteger(call.seq) ? call.seq : undefined,
    args,
    source: typeof args?.code === 'string' ? args.code : undefined,
    journal,
    rewrites: validatedRewrites(result.data?.meta),
  })
}

function timelineDerivedRun(call, result, eventIndex, derived) {
  return Object.freeze({
    index: eventIndex,
    callSeq: Number.isSafeInteger(call.seq) ? call.seq : undefined,
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
    && shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
    && shadowedSeqs.every((seq, index) => index === 0 || seq > shadowedSeqs[index - 1])
    && rangeValid
  return { seqs: valid ? seqs : new Set(), lastEventIndex: eventIndex }
}

function continuesPruneWindow(window, event, eventIndex) {
  return event?.type === 'compaction/prune' || eventIndex === window.lastEventIndex + 1
}

function identifiesPrunedResult(window, event, eventIndex) {
  const sourceSeq = event.sourceEventSeqs?.[0]
  return Number.isSafeInteger(sourceSeq)
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
    && Number.isSafeInteger(candidateSeq) && candidateSeq >= 0
    && sourceSeq > candidateSeq
    && Number.isSafeInteger(pruneSeq) && pruneSeq >= 0
    && Number.isSafeInteger(event.seq) && event.seq - pruneSeq === 1
    && sourceSeq < pruneSeq
  const exactReplacement = surfaceOp === undefined
    || (surfaceOp?.op === 'replace' && surfaceOp.start === sourceSeq && surfaceOp.end === sourceSeq)
  return orderedIdentity && exactReplacement
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
  const journalResultSeqs = new Set()
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
      state.unavailableResultSeq ??= Number.isSafeInteger(event.seq) ? event.seq : eventIndex
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
        if (Number.isSafeInteger(event.seq) && event.seq >= 0 && state.executableCalls.has(event.seq)) {
          // A sequence collision disproves both sources, but not the earlier
          // verified frontier. Keep its position for persistent contraction.
          const previous = state.executableCalls.get(event.seq)
          previous.ambiguous = true
          state.unavailableResultSeq = Math.min(state.unavailableResultSeq ?? event.seq, event.seq)
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
        if (Number.isSafeInteger(event.seq) && event.seq >= 0) {
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

    const sourceSeq = event.sourceEventSeqs?.[0]
    const callId = event.data?.message?.source?.callId
    let entry = Number.isSafeInteger(sourceSeq) ? state.executableCalls.get(sourceSeq) : undefined
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
    if (entry === undefined && !Number.isSafeInteger(sourceSeq) && typeof callId === 'string') {
      entry = pendingByCallId.get(callId)
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
    let normalized
    if (isRecord(meta) && Object.hasOwn(meta, JOURNAL_KEY)) {
      if (Number.isSafeInteger(sourceSeq) && journalResultSeqs.has(sourceSeq)) {
        state.unavailableResultSeq ??= sourceSeq
        state.results.set(sourceSeq, {
          eventSeq: Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : sourceSeq,
          eventIndex,
          error: `session log contains duplicate PTC journal results for call seq ${sourceSeq}`,
        })
        state.found = true
        continue
      }
      if (Number.isSafeInteger(sourceSeq)) journalResultSeqs.add(sourceSeq)
      if (entry === undefined) {
        if (Number.isSafeInteger(sourceSeq)) {
          state.unavailableResultSeq ??= sourceSeq
        }
        continue
      }
      const resultSeq = prunedReplacement
        ? callSeq
        : Number.isSafeInteger(sourceSeq) ? sourceSeq : callSeq
      const raw = {
        meta,
        eventSeq: Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : resultSeq,
        eventIndex,
      }
      if (Object.hasOwn(meta, RECOVERY_BOUNDARY_KEY)) {
        try {
          state.boundaries.push(...normalizeRecoveryBoundaries(
            meta[RECOVERY_BOUNDARY_KEY], raw.eventSeq,
          ))
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
      if (Number.isSafeInteger(resultSeq)) state.results.set(resultSeq, normalized)
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
      recoveryState.volatileSuffix.push({ seq, code, reason })
    }
  }
  if (timeline.unavailableResultSeq !== undefined) {
    registerUnavailable({
      seq: timeline.unavailableResultSeq,
      reason: 'unavailable or malformed dsh-ptc-plus journal result',
    })
  }
  for (const [resultSeq, result] of results.entries()) {
    if (result?.error !== undefined && Number.isSafeInteger(resultSeq)) {
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
  let state = foldRecords(records, invalidCallSeqs)
  let boundaryIndex = 0
  const applyBoundariesBefore = (seq) => {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].eventSeq <= seq) {
      const boundary = boundaries[boundaryIndex++]
      const failedCall = executableCalls.get(boundary.failedCallSeq)
      if (failedCall === undefined || failedCall.event.seq >= boundary.eventSeq) continue
      const failedIndex = state.nodes.findIndex(node => node.callSeq === boundary.failedCallSeq)
      const expectedFrontier = failedIndex < 0 ? state.head : state.nodes[failedIndex].parent
      const frontierIndex = boundary.frontierCallSeq === null
        ? undefined
        : state.nodes.findIndex(node => node.callSeq === boundary.frontierCallSeq)
      if (frontierIndex !== expectedFrontier) continue
      const resolvesUnavailable = unavailableBoundary?.seq === boundary.failedCallSeq
      if (failedIndex < 0 && !resolvesUnavailable) continue
      for (let index = 0; index < state.nodes.length; index += 1) {
        if (dependsOn(state.nodes, index, failedIndex)) invalidCallSeqs.add(state.nodes[index].callSeq)
      }
      if (failedIndex < 0) {
        for (const record of records) {
          if (record.call.seq >= boundary.failedCallSeq) invalidCallSeqs.add(record.call.seq)
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
