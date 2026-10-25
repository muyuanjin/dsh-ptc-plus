import { createHash } from 'node:crypto'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import { deepFreeze, isRecord } from './record-utils.js'
import { sessionEvents, sessionSourceMessages } from './session-events.js'
import { USER_BINDINGS_META_KEY } from './user-bindings.js'
import {
  JOURNAL_KEY,
  RECOVERY_BOUNDARY_KEY,
  RECOVERY_BOUNDARY_EVENT,
  LEGACY_JOURNAL_VERSION,
  REPL_TOOL_NAMES,
  REWRITES_KEY,
  EDIT_TARGET_KEY,
  DERIVED_RUN_KEY,
  POST_EDIT_KEY,
} from './session-journal-schema.js'
import {
  isCanonicalSequence,
  normalizeDeferredEditSettlement,
  normalizeJournal,
  normalizeRecoveryBoundaries,
  reduceStateOperations,
  userBindingsForJournal,
  validatedRewrites,
} from './session-journal.js'
import { decodeValue } from './value-wire.js'
import { editRejectedCell } from './rejected-cell-editor.js'
import {
  byteLength, chainOfEntries, digestOf, extendSummary, retainedClusterCount, retentionLimits, settlementBytes,
  summaryEntry, summaryRecordOf,
} from './projection-retention.js'

const RECOVERY_BOUNDARY_EVIDENCE = Symbol('recoveryBoundaryEvidence')
const RUN_SELECTION_CLEAR_REASONS = new Set([
  'turn/start', 'turn/end', 'duplicate-call-sequence', 'invalid-source-relation',
  'ambiguous-call-id', 'ambiguous-call-sequence', 'duplicate-result', 'result-identity-mismatch',
])
const MODEL_VISIBLE_SURFACE_EVENTS = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Argument text for a call, resolved through its canonical owner.
 *
 * `executableCalls` retains the text once; a call event that still carries its
 * own copy (the live fold, or an uncompacted checkpoint) is read directly. A
 * compacted event and a pruned entry hold only digests, so derivations see
 * `undefined` and must treat the run as unavailable rather than guess.
 */
function callArguments(call, executableCalls) {
  if (typeof call?.data?.arguments === 'string') return call.data.arguments
  const entry = executableCalls?.get?.(call?.seq)
  const stored = entry?.event?.data?.arguments
  return typeof stored === 'string' ? stored : undefined
}

function sourceForRunCall(call, executableCalls) {
  const text = callArguments(call, executableCalls)
  if (text === undefined) return undefined
  try {
    const args = JSON.parse(text)
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

/** Node indices reachable from a head by following parents. */
function reachableFrom(nodes, head) {
  const reachable = new Set()
  for (let cursor = head; cursor !== undefined && !reachable.has(cursor);) {
    reachable.add(cursor)
    cursor = nodes[cursor]?.parent
  }
  return reachable
}

/**
 * Binding names a node recorded.
 *
 * The recorded values are the only evidence that names a durable binding today;
 * `unrecordedBindings` names the ones the codec could not transfer, and a
 * `kind: "binding"` save names one explicitly. A checkpoint save never counts.
 */
function recordedBindingNames(node) {
  const journal = node?.journal
  if (journal === undefined) return []
  return [...new Set([
    ...(journal.values ?? []).map(value => value.name),
    ...(journal.unrecordedBindings ?? []),
    ...bindingNamesOfOperations(journal.operations),
  ].filter(name => typeof name === 'string'))]
}

function applyOperations(state, operations, nodeIndex) {
  const previousHead = state.head
  const transition = reduceStateOperations(state, operations, nodeIndex)
  if (transition.restored) {
    const reachableBefore = reachableFrom(state.nodes, previousHead)
    const reachableAfter = reachableFrom(state.nodes, transition.head)
    for (const index of reachableBefore) {
      if (reachableAfter.has(index)) continue
      for (const name of recordedBindingNames(state.nodes[index])) state.deletedBindings.add(name)
    }
    // The cutting node is not reachable from the new head either: the rewind it
    // performed ends whatever that same cell created before the cut, so its own
    // names belong to the recorded deletion rather than to an omission.
    if (nodeIndex !== undefined) {
      for (const name of recordedBindingNames(state.nodes[nodeIndex])) state.deletedBindings.add(name)
    }
  }
  state.head = transition.head
  state.checkpoints = transition.checkpoints
  if (transition.restored) {
    state.trusted = true
    state.volatileSuffix.length = 0
  }
}

/**
 * Binding names a recorded journal operation list saves.
 *
 * Only a save with `kind: "binding"` creates a binding. `repl.state({ action:
 * "save" })` records a checkpoint name in the same `save` shape, which is why an
 * untagged save is a checkpoint: every operation recorded before the kind existed
 * came from that control call. Treating those names as bindings made a contraction
 * report a branch name as a dropped variable.
 */
export function bindingNamesOfOperations(operations) {
  const names = new Set()
  for (const operation of operations ?? []) {
    if (operation.action === 'save' && operation.kind === 'binding' && typeof operation.name === 'string') {
      names.add(operation.name)
    }
  }
  return [...names]
}

function applyRecord(state, record, invalidCallSeqs) {
  const { call, code, result } = record
  // Every binding a journal names is a binding the session log proves. Recording
  // the names here lets recovery report a binding it could not install instead of
  // letting an unreplayed node take it silently.
  // Only a volatile record proves a binding today: it cannot be replayed, so its
  // recorded values are the entire evidence. A durable settlement records values too,
  // for the restore path that installs nodes the replay does not reach, but its
  // bindings are still proved by replaying it; counting them here would report a
  // binding as dropped in every contraction whose replay is supposed to be complete.
  const recordNames = [
    ...(result?.journal?.status === 'volatile'
      ? (result.journal.values ?? []).map(value => value.name)
      : []),
    ...bindingNamesOfOperations(result?.journal?.operations),
  ]
  for (const name of recordNames) state.provenBindings.add(name)
  if (invalidCallSeqs.has(call.seq)) return
  const journal = result.journal
  if (journal.status === 'noop') return
  if (journal.status === 'discarded') {
    if (journal.volatileReason !== undefined) {
      state.trusted = false
      const discardedBindings = bindingNamesOfOperations(journal.operations)
      state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason,
        ...(discardedBindings.length === 0 ? {} : { bindings: discardedBindings }) })
    }
    return
  }
  if (journal.status === 'volatile') {
    state.trusted = false
    // A volatile settlement drops its `save` operations, so the names it created
    // survive only as the bindings the record could not transfer.
    const volatileBindings = [...new Set([...bindingNamesOfOperations(journal.operations),
      ...(journal.unrecordedBindings ?? [])])]
    // A volatile cell that recorded its values keeps its place in the durable
    // frontier: recovery installs those values instead of replaying the cell, so
    // the completion is unverified while the bindings survive. A volatile cell
    // whose values the codec could not transfer has nothing to install and is
    // reported as a contraction instead of vanishing silently.
    if (journal.values !== undefined && journal.values.length > 0) {
      const node = Object.freeze({
        code,
        journal,
        callSeq: call.seq,
        parent: state.head,
        restoredFromRecord: true,
        ...(result.userBindings === undefined ? {} : { userBindings: result.userBindings }),
      })
      const index = state.nodes.push(node) - 1
      state.head = index
      applyOperations(state, journal.operations, index)
      return
    }
    state.volatileSuffix.push({ seq: call.seq, code, reason: journal.volatileReason ?? 'volatile cell',
      ...(volatileBindings.length === 0 ? {} : { bindings: volatileBindings }) })
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
    provenBindings: new Set(),
    deletedBindings: new Set(),
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
  let sourceMessages
  try {
    sourceMessages = sessionSourceMessages(session, events, nodes)
  } catch {
    return new Set()
  }
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
      const content = sourceMessages.get(event.seq)?.content
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
  const timeline = foldSessionTimeline(events)
  if (process.env.DEBUG_RECOVER) console.error('DEBUG events', events.length, 'results', timeline.results.size, 'calls', timelineCalls(timeline).length, 'exec', timeline.executableCalls.size)
  for (const seq of timeline.calls) {
    const post = timeline.results.get(seq)?.postEdit
    // A derived execution that never ran was never published as a cell the model
    // can see, so it is not model-visible executable history.
    if (post !== undefined && post.derived?.unexecuted !== true
      && calls.has(seq) && calls.has(post.targetCallSeq)) {
      calls.add(post.executionStartSeq)
    }
  }
  return calls
}

function timelineRun(call, result, eventIndex, journal, executableCalls) {
  let args
  const text = callArguments(call, executableCalls)
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text)
      if (isRecord(parsed)) args = Object.freeze(parsed)
    } catch {
      // Invalid persisted arguments cannot support derived source facts.
    }
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
  // A pruned settlement yields no run, so it cannot certify success either.
  return run?.journal?.completion?.kind === 'return' && run.journal.status !== 'noop'
}

function settlementRun(settlement, executableCalls) {
  const publication = settlement.publication
  if (publication === undefined) return undefined
  const result = { data: { meta: { [REWRITES_KEY]: publication.postEditRewrites ?? publication.rewrites } } }
  // A revision that never ran publishes no source of its own, so the settlement
  // keeps its own call's source: the root cell stays the editable target and the
  // unexecuted revision never becomes one.
  if (publication.postEdit?.derived?.unexecuted === true || publication.derived?.unexecuted === true) {
    return timelineJson(timelineRun(settlement.call, result, publication.index, publication.journal, executableCalls))
  }
  if (publication.postEdit !== undefined) {
    return timelineJson(timelineDerivedRun({ seq: publication.postEdit.executionStartSeq }, result,
      publication.index, publication.postEdit.derived))
  }
  return timelineJson(publication.derived === undefined
    ? timelineRun(settlement.call, result, publication.index, publication.journal, executableCalls)
    : timelineDerivedRun(settlement.call, result, publication.index, publication.derived))
}

function selectSettlementRun(selected, settlement, scope, frontier, executableCalls) {
  const publication = settlement.publication
  if (publication === undefined || settlement.entry.scope !== scope
    || (frontier !== null && publication.index <= frontier.index)) return selected
  return selected === undefined || publication.index >= selected.index
    ? settlementRun(settlement, executableCalls) : selected
}

function editTargetForSelection(run, claimedTargets) {
  const callSeq = run?.callSeq
  return callSeq !== undefined && run.source !== undefined && !claimedTargets.has(callSeq)
    ? Object.freeze({ source: run.source, callSeq })
    : undefined
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
  return { seqs: valid ? [...seqs] : [], lastEventIndex: eventIndex, lastEventSeq: event.seq }
}

function continuesPruneWindow(window, event, eventIndex) {
  return event?.type === 'compaction/prune' || eventIndex === window.lastEventIndex + 1
}

function identifiesPrunedResult(window, event, eventIndex) {
  const sourceSeq = event.sourceEventSeqs?.[0]
  return isCanonicalSequence(sourceSeq)
    && window?.seqs.includes(sourceSeq)
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

function resolveTimelineResult(event, eventIndex, executableCalls, pendingByCallId,
  settledResultsByEventSeq, pruneReplacementWindow, identity) {
  const hasSourceRelation = Object.hasOwn(event, 'sourceEventSeqs')
  const sourceRelation = event.sourceEventSeqs
  const sourceSeq = sourceRelation?.[0]
  const canonicalSourceRelation = Array.isArray(sourceRelation)
    && sourceRelation.length === 1
    && isCanonicalSequence(sourceSeq)
  const callId = event.data?.message?.source?.callId
  let entry = canonicalSourceRelation ? executableCalls.get(sourceSeq) : undefined
  let prunedReplacement = false
  let republishedSettlement
  if (entry === undefined && identifiesPrunedResult(pruneReplacementWindow, event, eventIndex)) {
    const candidate = pendingByCallId.get(callId)
    const pruneSeq = pruneReplacementWindow.lastEventSeq
    if (replacesPendingCall(candidate, event, pruneSeq)) {
      entry = candidate
      prunedReplacement = true
      pruneReplacementWindow = { ...pruneReplacementWindow, lastEventIndex: eventIndex, lastEventSeq: event.seq }
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
      && settled.identity === identity) {
      entry = executableCalls.get(settled.call?.seq) ?? settled.entry
      prunedReplacement = true
      republishedSettlement = settled
    }
  }
  return { entry, prunedReplacement, republishedSettlement, pruneReplacementWindow }
}

function invalidSourceCallSeq(event, executableCalls, pendingByCallId) {
  const callId = event.data?.message?.source?.callId
  const identityEntry = typeof callId === 'string' ? pendingByCallId.get(callId) : undefined
  const callSeqs = new Set(Array.isArray(event.sourceEventSeqs)
    ? event.sourceEventSeqs.filter(isCanonicalSequence)
      .map(seq => executableCalls.get(seq)?.event?.seq).filter(isCanonicalSequence) : [])
  if (isCanonicalSequence(identityEntry?.event?.seq)) callSeqs.add(identityEntry.event.seq)
  return callSeqs.size === 0 ? undefined : Math.min(...callSeqs)
}

function timelineResultError(event, eventIndex, callSeq, error) {
  return { eventSeq: isCanonicalSequence(event.seq) ? event.seq : callSeq, eventIndex, error }
}

function republishedTimelineResult(result, event) {
  return { ...result, eventSeq: event.seq, positionSeq: result.positionSeq ?? result.eventSeq }
}

/**
 * Fact-shaped data for a `tool/call`: the arguments are represented by their
 * digest pair so a stored event fact never carries the text. The text itself is
 * retained once, in `timelineCallEvent` inside `executableCalls`. A fact that is
 * already digested passes through unchanged, which keeps re-deriving a fact from
 * a compacted observation byte-identical.
 */
function callFactData(event) {
  const data = event?.data ?? {}
  const value = data.arguments
  const digested = value === undefined && typeof data.argumentsDigest === 'string'
    ? { argumentsDigest: data.argumentsDigest, argumentsBytes: data.argumentsBytes }
    : typeof value === 'string'
      ? { argumentsDigest: digestOf(value), argumentsBytes: byteLength(value) }
      : {}
  return {
    callId: data.callId,
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    ...digested,
  }
}

function correlationEvent(event) {
  return timelineJson({ seq: event.seq, type: event.type,
    ...(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type) ? { data: {
      rootCallId: event.data?.rootCallId,
      parentCallId: event.data?.parentCallId,
      subCallId: event.data?.subCallId,
      name: event.data?.name,
      // A compacted dispatch keeps its digest pair, so re-deriving this fact from a
      // pruned observation reproduces exactly what was stored.
      ...(event.data?.arguments === undefined
        ? (event.data?.argumentsDigest === undefined ? {}
          : { argumentsDigest: event.data.argumentsDigest, argumentsBytes: event.data.argumentsBytes })
        : { arguments: event.data.arguments }),
      ...(event.type === 'tool/ptc-dispatch' ? {
        isError: event.data?.isError,
        ...(event.data?.name === 'run_code' && event.data.meta?.[JOURNAL_KEY] !== undefined
          ? { meta: { [JOURNAL_KEY]: event.data.meta[JOURNAL_KEY] } } : {}),
      } : {}),
    } } : {}),
    ...(event.type === 'tool/call' && typeof event.data?.callId === 'string'
      ? { data: callFactData(event) } : {}),
    ...(event.type === 'tool/result' ? { data: { message: { source: {
      ...(typeof event.data?.message?.source?.callId === 'string'
        ? { callId: event.data.message.source.callId } : {}),
    } } } } : {}),
    ...(event.type === 'compaction/prune' ? { data: {
      ...(event.data?.shadowedSeqs === undefined ? {} : { shadowedSeqs: event.data.shadowedSeqs }),
      ...(event.data?.shadowedRange === undefined ? {} : { shadowedRange: event.data.shadowedRange }),
    } } : {}),
    ...(Object.hasOwn(event, 'sourceEventSeqs') ? { sourceEventSeqs: event.sourceEventSeqs } : {}),
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
  })
}

function recordPendingCall(pending, seen, entry, duplicateSequence) {
  const id = entry.event.data.callId
  if (duplicateSequence !== undefined) {
    pending.set(duplicateSequence.event.data.callId, null)
    pending.set(id, null)
    seen.add(id)
  } else if (seen.has(id)) pending.set(id, null)
  else {
    seen.add(id)
    pending.set(id, entry)
  }
}

function nextPruneWindow(window, event, eventIndex) {
  if (window !== undefined && !continuesPruneWindow(window, event, eventIndex)) return undefined
  return window
}

/**
 * Fold persisted tool events once into the call/result and edit-target timeline
 * shared by prompt projection and cold journal recovery.
 */
class TimelineTable {
  constructor(table = {}, onSet) {
    this.table = table
    this.copied = false
    this.onSet = onSet
  }

  get(key) { return this.table[`k${key}`]?.[1] }
  has(key) { return Object.hasOwn(this.table, `k${key}`) }
  values() { return Object.values(this.table).map(entry => entry[1]) }
  copy() {
    if (!this.copied) {
      this.table = { ...this.table }
      this.copied = true
    }
  }
  set(key, value) {
    this.onSet?.(this.get(key), value)
    this.copy()
    this.table[`k${key}`] = [key, timelineJson(value ?? null)]
  }
  add(key) { this.set(key, true) }
  delete(key) {
    if (!this.has(key)) return
    this.copy()
    delete this.table[`k${key}`]
  }
  clear() { this.table = {}; this.copied = true }
}

function timelineJson(value) {
  return deepFreeze(JSON.parse(JSON.stringify(value ?? null)))
}

/**
 * Resolve one executable call entry from either the live table or the
 * serialized checkpoint shape.
 */
function executableEntry(timeline, seq) {
  const table = timeline.executableCalls
  return typeof table?.get === 'function' ? table.get(seq) : table?.[`k${seq}`]?.[1]
}

/**
 * The ordered executable call events.
 *
 * `calls` stores only the sequence order; the events themselves live once in
 * `executableCalls`, so a checkpoint no longer serializes every call a second
 * time.
 */
function timelineCalls(timeline) {
  const calls = []
  for (const seq of timeline.calls) {
    const event = executableEntry(timeline, seq)?.event
    if (event !== undefined) calls.push(event)
  }
  return calls
}

/**
 * The canonical call event retained in `executableCalls`.
 *
 * This is the only place the argument text is kept. A replay that only has a
 * digested fact resolves the text from the entry already stored for that seq, so
 * a checkpointed call and a re-derived one stay byte-identical.
 */
function timelineCallEvent(event, executableCalls) {
  const entry = executableCalls?.get?.(event.seq) ?? executableCalls?.[`k${event.seq}`]?.[1]
  const stored = entry?.event?.data?.arguments
  const text = typeof event.data.arguments === 'string'
    ? event.data.arguments
    : typeof stored === 'string' ? stored : undefined
  return timelineJson({ seq: event.seq, type: event.type, data: {
    callId: event.data.callId, name: event.data.name,
    ...(REPL_TOOL_NAMES.has(event.data.name)
      ? (text === undefined
        ? { argumentsDigest: event.data.argumentsDigest, argumentsBytes: event.data.argumentsBytes }
        : { arguments: text })
      : {}),
  } })
}

/** Stable digest of a stored projection fact, used by checkpoint admission. */
export function factDigest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null, (_key, field) => (
    isRecord(field) ? Object.fromEntries(Object.keys(field).sort().map(key => [key, field[key]])) : field
  ))).digest('hex')
}

function withoutFactDigests(state) {
  // Admission compares what the projection describes, not bookkeeping whose exact
  // value depends on when pruning happened: per-fact digests and the retained-byte
  // counter are accounting, not session state.
  const { retainedBytes: _retainedBytes, retentionSummary: _retentionSummary, ...rest } = state
  const facts = rest.eventFacts
  if (!facts.some(fact => fact.digest !== undefined)) return rest
  return { ...rest, eventFacts: facts.map(({ digest, ...fact }) => fact) }
}

/**
 * The retention summary an admitted checkpoint carries.
 *
 * A compacted checkpoint keeps no per-settlement stubs at all: dropping the whole
 * cluster is what makes the file size independent of how many cells the session
 * ran. What survives is one chained summary of what was dropped, so admission can
 * still tell "never existed" from "existed and was dropped".
 */
export function retentionSummaryOf(state) {
  const summary = state?.retentionSummary
  if (summary === undefined || summary === null) return undefined
  return summary
}

/**
 * Prove a compacted checkpoint without replaying it.
 *
 * The retained window must be contiguous with the summary boundary: every
 * settlement above `toSeq` is present and intact, every executable call that a
 * retained settlement names is present, and the summary is a well-formed chain.
 * Below the boundary nothing survives, which is exactly the contract of dropping
 * a cluster. This is the weaker, stated claim admission makes for compacted
 * states; uncompacted states keep the byte-for-byte replay equality.
 */
export function validateRetentionSummary(timeline, summary, logFacts) {
  if (!isRecord(summary)) throw new TypeError('invalid PTC session-log projection retention summary')
  const keys = Object.keys(summary)
  if (keys.some(key => !['fromSeq', 'toSeq', 'count', 'chainDigest', 'entries'].includes(key))) {
    throw new TypeError('invalid PTC session-log projection retention summary')
  }
  if (!isCanonicalSequence(summary.fromSeq) || !isCanonicalSequence(summary.toSeq)
    || summary.fromSeq > summary.toSeq || !Number.isSafeInteger(summary.count) || summary.count < 1
    || typeof summary.chainDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(summary.chainDigest)) {
    throw new TypeError('invalid PTC session-log projection retention summary')
  }
  for (const [key, pair] of Object.entries(timeline.settledResultsByEventSeq ?? {})) {
    const seq = pair?.[0]
    const settlement = pair?.[1]
    if (!isCanonicalSequence(seq) || settlement === undefined) {
      throw new TypeError('invalid PTC session-log projection retention window')
    }
    if (seq <= summary.toSeq) {
      throw new TypeError(`PTC session-log projection retains settlement ${key} below its retention boundary`)
    }
    const callSeq = settlement.call?.seq
    if (!isCanonicalSequence(callSeq) || timeline.executableCalls?.[`k${callSeq}`] === undefined) {
      throw new TypeError('PTC session-log projection lost the call of a retained settlement')
    }
  }
  // Admission receives no session log, so it cannot fold the dropped range. What it
  // can prove is that the summary is internally consistent: one record per dropped
  // cluster, ordered by result sequence, with the range and the chain derived from
  // those records. Trusting a summary without a record per cluster is what made an
  // earlier version forgeable. The stronger claim — that a record describes the same
  // cluster the log still holds — is checked when a dropped cluster is refolded
  // (`verifyRefoldedSettlement`), because that is the only point where the log and
  // the record meet.
  const records = summary.entries
  if (!Array.isArray(records) || records.length !== summary.count) {
    throw new TypeError('inconsistent PTC session-log projection retention summary')
  }
  let previous = -1
  for (const record of records) {
    if (!isRecord(record)
      || !isCanonicalSequence(record.resultSeq) || !isCanonicalSequence(record.callSeq)
      || typeof record.argumentsDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.argumentsDigest)
      || record.resultSeq <= previous) {
      throw new TypeError('inconsistent PTC session-log projection retention summary')
    }
    previous = record.resultSeq
  }
  if (records[0].resultSeq !== summary.fromSeq || records[records.length - 1].resultSeq !== summary.toSeq
    || chainOfEntries(records) !== summary.chainDigest) {
    throw new TypeError('inconsistent PTC session-log projection retention summary')
  }
  return summary
}

/**
 * Prove the recorded chain against the raw session log.
 *
 * Folds the events up to the boundary with retention disabled, derives the summary
 * the fold would have produced for the dropped range, and requires it to equal the
 * recorded one. A caller without the log must say so: this function throws
 * `unverifiable PTC session-log projection retention summary` instead of accepting.
 */
export function verifyRetentionSummaryAgainstEvents(summary, events) {
  if (!Array.isArray(events)) {
    throw new TypeError('unverifiable PTC session-log projection retention summary')
  }
  const expected = retentionSummaryFromEvents(events, summary.toSeq)
  if (expected === undefined
    || expected.count !== summary.count || expected.fromSeq !== summary.fromSeq
    || expected.toSeq !== summary.toSeq || expected.chainDigest !== summary.chainDigest) {
    throw new TypeError('inconsistent PTC session-log projection retention summary')
  }
  return summary
}

/**
 * Refold the editable cell from the log and check it against the summary.
 *
 * The checkpoint cannot prove that its summary describes the clusters the log
 * still holds — admission has no log. This is the one place where both sides meet:
 * the log is folded with pruning disabled, the settlement behind the editable run
 * is turned into a summary record, and the record stored in the summary must equal
 * it. A mismatch means the summary and the log disagree, which is reported to the
 * caller instead of yielding an edit target that was never recorded.
 */
export function refoldEditableSettlement(events, summary) {
  if (!Array.isArray(events)) return { run: undefined, mismatch: false }
  let state
  withFullRetention(() => {
    state = createSessionTimelineState()
    events.forEach((event, index) => {
      if (!isRecord(event)) return
      state = advanceSessionTimeline(state, event, isCanonicalSequence(event.seq) ? event.seq : index)
    })
  })
  const run = state?.editableRun
  if (run === undefined) return { run: undefined, mismatch: false }
  const settled = Object.entries(state?.settledResultsByEventSeq ?? {})
    .map(([, pair]) => pair)
    .find(([, settlement]) => settlement?.call?.seq === run.callSeq)
  if (settled === undefined) return { run, mismatch: false }
  const [resultSeq, settlement] = settled
  const recorded = summaryRecordOf(summary, Number(resultSeq))
  if (recorded === undefined) return { run, mismatch: false }
  const refolded = summaryEntry(settlement, Number(resultSeq))
  const mismatch = recorded.callSeq !== refolded.callSeq || recorded.argumentsDigest !== refolded.argumentsDigest
  return { run, mismatch }
}

/** Recompute the summary a fold of the dropped range would have produced. */
function retentionSummaryFromEvents(events, toSeq) {
  let state
  withFullRetention(() => {
    state = createSessionTimelineState()
    events.forEach((event, index) => {
      if (!isRecord(event)) return
      if (isCanonicalSequence(event.seq) && event.seq > toSeq) return
      state = advanceSessionTimeline(state, event, isCanonicalSequence(event.seq) ? event.seq : index)
    })
  })
  const dropped = Object.entries(state?.settledResultsByEventSeq ?? {})
    .map(([, pair]) => pair)
    .filter(([resultSeq]) => Number(resultSeq) <= toSeq)
    // The prune orders dropped entries by RESULT sequence before folding them into the
    // chain, so summing here must use the same order; observedIndex can disagree when
    // a nested call settles out of order.
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([resultSeq, settlement]) => summaryEntry(settlement, Number(resultSeq)))
  if (dropped.length === 0) return undefined
  return extendSummary(undefined, dropped)
}

/**
 * The identity of a call is what survives the payload window: sequence, type,
 * callId and name. The argument text is deliberately excluded, because retention
 * replaces it with `argumentsDigest` and an identity that hashed the text would make
 * every observation describe a different call before and after pruning. The text is
 * still bound by its own digest in the call entry, so excluding it hides nothing.
 */
function eventDigest(event) {
  if (isRecord(event) && isRecord(event.data) && typeof event.data.callId === 'string') {
    const identity = { seq: event.seq, type: event.type,
      data: { callId: event.data.callId, name: event.data.name ?? null } }
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  }
  return createHash('sha256').update(JSON.stringify(event, (_key, value) => (
    isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value
  ))).digest('hex')
}

function resultIdentity(data) {
  const identity = timelineJson(isRecord(data) && isRecord(data.message)
    ? { ...data, message: { ...data.message, content: undefined } } : data)
  return createHash('sha256').update(JSON.stringify(identity, (_key, value) => (
    isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value
  ))).digest('hex')
}

const ADMISSION_REPLAY_BUDGET_BYTES = 4 * 1024 * 1024

export function createSessionTimelineState() {
  return {
    openTurn: false,
    executableCalls: {},
    calls: [],
    results: {},
    boundaries: [],
    found: false,
    cordisTranscript: { calls: 0, inspections: 0 },
    editTargets: {},
    pendingByCallId: {},
    seenCallIds: {},
    claimedEditTargets: {},
    editClaims: {},
    ordinaryResultSeqs: {},
    settledResultsByEventSeq: {},
    runSelectionFrontier: null,
    runSelectionHistory: [],
    lastEventIndex: null,
    eventFacts: [],
    // Payload bytes the retained settlements still carry: the retention window
    // keeps this bounded so a checkpoint never scales with written content.
    retainedBytes: 0,
    // One chained summary of the clusters the window dropped. Per-settlement stubs
    // would still scale with the number of cells the session ran.
    retentionSummary: null,
    // Set once any cluster is dropped, so admission can tell "nothing was ever
    // dropped" from "a summary was deleted". A compacted state must carry its summary.
    compacted: false,
    // Set when the newest cell alone exceeded the byte budget and had to go. The
    // consumers that would have read it must say so instead of looking empty.
    hotCellDropped: false,
    scope: 0,
  }
}

export function validateSessionTimelineState(value, logFacts) {
  const requireFact = condition => {
    if (!condition) throw new TypeError('invalid PTC session-log projection timeline checkpoint')
  }
  const optional = (field, predicate) => field === undefined || predicate(field)
  const fields = (record, names) => isRecord(record) && Object.keys(record).every(name => names.includes(name))
  const target = field => fields(field, ['callSeq', 'source']) && isCanonicalSequence(field.callSeq) && typeof field.source === 'string'
  const callEvent = event => fields(event, ['seq', 'type', 'data']) && isCanonicalSequence(event.seq) && event.type === 'tool/call'
    && isRecord(event.data) && typeof event.data.callId === 'string'
    && fields(event.data, ['callId', 'name', 'arguments', 'argumentsDigest', 'argumentsBytes'])
    && optional(event.data.name, name => typeof name === 'string')
    && (event.data.arguments === undefined
      ? (event.data.argumentsDigest === undefined
        || (typeof event.data.argumentsDigest === 'string' && /^[a-f0-9]{64}$/u.test(event.data.argumentsDigest)
          && isCanonicalSequence(event.data.argumentsBytes)))
      : (typeof event.data.arguments === 'string' && event.data.argumentsDigest === undefined
        && event.data.argumentsBytes === undefined))
  const callEntry = entry => fields(entry, ['event', 'eventIndex', 'scope', 'ambiguous', 'editTarget']) && callEvent(entry.event)
    && isCanonicalSequence(entry.eventIndex) && isCanonicalSequence(entry.scope) && entry.scope <= value.scope
    && optional(entry.ambiguous, field => field === true) && optional(entry.editTarget, target)
  // A settlement references its call through `call` and keeps only the entry's
  // position and claims. Storing `entry.event` as well would serialize the call
  // event a second time — the duplication the retention work exists to remove.
  const settlementEntry = entry => fields(entry, ['eventIndex', 'scope', 'ambiguous', 'editTarget'])
    && isCanonicalSequence(entry.eventIndex) && isCanonicalSequence(entry.scope) && entry.scope <= value.scope
    && optional(entry.ambiguous, field => field === true) && optional(entry.editTarget, target)
  const table = (name, keyValid, payloadValid) => {
    if (!isRecord(value[name])) {
      throw new TypeError(`invalid PTC session-log projection timeline checkpoint: table ${name} is missing`)
    }
    for (const [key, pair] of Object.entries(value[name])) {
      if (!Array.isArray(pair) || pair.length !== 2 || !keyValid(pair[0]) || key !== `k${pair[0]}`) {
        throw new TypeError(`invalid PTC session-log projection timeline checkpoint: table ${name} entry ${key}`)
      }
      if (!payloadValid(pair[1], pair[0])) {
        const problem = name === 'settledResultsByEventSeq' ? settlementProblem(pair[1]) : undefined
        const shape = isRecord(pair[1]) ? ` keys=${Object.keys(pair[1]).join(',')}` : ` value=${JSON.stringify(pair[1])?.slice(0, 80)}`
        throw new TypeError(`invalid PTC session-log projection timeline checkpoint: table ${name} payload ${key}${shape}${problem === undefined ? '' : ` problem=${problem}`}`)
      }
    }
    return new Map(Object.values(value[name]))
  }
  requireFact(isJsonValue(value) && fields(value, ['openTurn', 'executableCalls', 'calls', 'results', 'boundaries', 'found',
    'cordisTranscript', 'editTargets', 'pendingByCallId', 'seenCallIds', 'claimedEditTargets', 'editClaims',
    'ordinaryResultSeqs', 'settledResultsByEventSeq', 'scope', 'latestRun', 'editableRun', 'lastSuccessfulRunIndex',
    'unavailableResultSeq', 'unavailableResultReason', 'pruneReplacementWindow', 'runSelectionFrontier',
    'runSelectionHistory', 'lastEventIndex', 'eventFacts', 'retainedBytes', 'retentionSummary', 'compacted',
    'hotCellDropped']) && typeof value.openTurn === 'boolean'
    && typeof value.found === 'boolean' && isCanonicalSequence(value.scope)
    && typeof value.retainedBytes === 'number' && value.retainedBytes >= 0
    && (value.retentionSummary === undefined || value.retentionSummary === null || isRecord(value.retentionSummary))
    && typeof value.compacted === 'boolean' && typeof value.hotCellDropped === 'boolean'
    && Array.isArray(value.calls) && value.calls.every(seq => isCanonicalSequence(seq))
    && Array.isArray(value.boundaries))
  requireFact(value.lastEventIndex === null || isCanonicalSequence(value.lastEventIndex))
  requireFact(Array.isArray(value.runSelectionHistory))
  let boundaryScope = 0
  let boundaryIndex = -1
  let openTurn = false
  for (const frontier of value.runSelectionHistory) {
    requireFact(fields(frontier, ['index', 'scope', 'reason']) && isCanonicalSequence(frontier.index)
      && value.lastEventIndex !== null && frontier.index <= value.lastEventIndex && frontier.index > boundaryIndex
      && RUN_SELECTION_CLEAR_REASONS.has(frontier.reason))
    if (frontier.reason === 'turn/start' || frontier.reason === 'turn/end') {
      boundaryScope += 1
      openTurn = frontier.reason === 'turn/start'
    }
    requireFact(frontier.scope === boundaryScope)
    boundaryIndex = frontier.index
  }
  requireFact(boundaryScope === value.scope && openTurn === value.openTurn
    && deepEqualJson(value.runSelectionFrontier, value.runSelectionHistory.at(-1) ?? null))
  const executable = table('executableCalls', isCanonicalSequence, (entry, seq) => callEntry(entry)
    && value.lastEventIndex !== null && entry.eventIndex <= value.lastEventIndex
    && entry.event.seq === seq && REPL_TOOL_NAMES.has(entry.event.data.name))
  requireFact(value.calls.length === executable.size)
  const callSeqs = new Set()
  for (const seq of value.calls) {
    // The order list may only name stored entries, and may not repeat one.
    requireFact(!callSeqs.has(seq) && executable.has(seq))
    callSeqs.add(seq)
  }
  const journalFacts = result => {
    if (!isRecord(result.journal)) return false
    const journal = normalizeJournal(result.journal)
    if (!deepEqualJson(journal, result.journal)) return false
    if (!deepEqualJson(userBindingsForJournal(result.userBindings === undefined ? {} : { [USER_BINDINGS_META_KEY]: result.userBindings }, journal) ?? null,
      result.userBindings ?? null)) return false
    if (result.derived !== undefined) {
      const derived = result.derived
      if (!isRecord(derived)) return false
      const normalized = normalizeDeferredEditSettlement({
        [JOURNAL_KEY]: result.journal,
        [EDIT_TARGET_KEY]: { targetCallSeq: derived.targetCallSeq },
        [DERIVED_RUN_KEY]: { code: derived.code, description: derived.description },
        ...(derived.recoveryBoundaries === undefined ? {} : { [RECOVERY_BOUNDARY_KEY]: derived.recoveryBoundaries }),
        ...(derived.userBindings === undefined ? {} : { [USER_BINDINGS_META_KEY]: derived.userBindings }),
      }, derived.targetCallSeq)
      if (!deepEqualJson(normalized, derived) || !executable.has(derived.targetCallSeq)) return false
    }
    return true
  }
  const normalizedResult = result => {
    // Every stored result keeps its full shape: a dropped cluster takes its result
    // entry with it, so a digest-only result would be a shape nothing produces.
    if (!fields(result, ['eventSeq', 'eventIndex', 'positionSeq', 'error', 'journal', 'derived', 'userBindings',
      'postEdit', 'postEditError'])
      || !isCanonicalSequence(result.eventSeq) || !isCanonicalSequence(result.eventIndex)
      || !optional(result.positionSeq, isCanonicalSequence)) return false
    if (result.error !== undefined) return typeof result.error === 'string' && result.journal === undefined && result.derived === undefined
    return journalFacts(result)
      && optional(result.postEditError, error => typeof error === 'string')
      && optional(result.postEdit, post => fields(post, ['startSeq', 'executionStartSeq', 'targetCallSeq', 'derived', 'rewrites'])
        && isCanonicalSequence(post.startSeq) && isCanonicalSequence(post.executionStartSeq)
        && isCanonicalSequence(post.targetCallSeq)
        && deepEqualJson(normalizeDeferredEditSettlement({
          [JOURNAL_KEY]: post.derived?.journal,
          [EDIT_TARGET_KEY]: { targetCallSeq: post.targetCallSeq },
          [DERIVED_RUN_KEY]: { code: post.derived?.code, description: post.derived?.description },
          ...(post.derived?.recoveryBoundaries === undefined ? {} : {
            [RECOVERY_BOUNDARY_KEY]: post.derived.recoveryBoundaries }),
          ...(post.derived?.userBindings === undefined ? {} : {
            [USER_BINDINGS_META_KEY]: post.derived.userBindings }),
        }, post.targetCallSeq), post.derived)
        && deepEqualJson(validatedRewrites({ [REWRITES_KEY]: post.rewrites }) ?? null, post.rewrites ?? null))
  }
  const results = table('results', isCanonicalSequence, normalizedResult)
  const targets = table('editTargets', isCanonicalSequence, (field, seq) => (
    executable.get(seq)?.event.data.name === 'edit_run_code'
    && (field === null || (target(field) && executable.has(field.callSeq)))
    && deepEqualJson(field, executable.get(seq).editTarget ?? null)
  ))
  for (const [seq, entry] of executable) {
    requireFact(entry.event.data.name !== 'edit_run_code' || targets.has(seq))
  }
  const stringKey = key => typeof key === 'string'
  const trueValue = field => field === true
  const seen = table('seenCallIds', stringKey, trueValue)
  table('pendingByCallId', stringKey, (entry, id) => seen.has(id) && (entry === null
    || (callEntry(entry) && entry.event.data.callId === id && entry.scope === value.scope
      && (!REPL_TOOL_NAMES.has(entry.event.data.name) || deepEqualJson(executable.get(entry.event.seq), entry)))))
  const claimed = table('claimedEditTargets', isCanonicalSequence, (field, seq) => trueValue(field) && executable.has(seq))
  const edits = table('editClaims', isCanonicalSequence, (seq, editSeq) => isCanonicalSequence(seq)
    && claimed.has(seq) && targets.get(editSeq)?.callSeq === seq)
  const ordinaryObservations = table('ordinaryResultSeqs', isCanonicalSequence, (observation, seq) =>
    ((fields(observation, ['call', 'eventSeq', 'eventIndex']) && callEvent(observation.call) && observation.call.seq === seq
      && value.executableCalls[`k${seq}`] === undefined)
      || (fields(observation, ['callDigest', 'eventSeq', 'eventIndex'])
        && typeof observation.callDigest === 'string' && /^[a-f0-9]{64}$/u.test(observation.callDigest)
        && value.executableCalls[`k${seq}`] !== undefined
        && eventDigest(value.executableCalls[`k${seq}`][1].event) === observation.callDigest))
    && isCanonicalSequence(observation.eventSeq) && isCanonicalSequence(observation.eventIndex)
    && value.lastEventIndex !== null && observation.eventIndex <= value.lastEventIndex
    && (observation.callDigest !== undefined || !REPL_TOOL_NAMES.has(observation.call.data.name)
      || (deepEqualJson(executable.get(seq)?.event, observation.call)
        && observation.eventIndex >= executable.get(seq).eventIndex)))
  /**
   * Name the clause a settlement fails, so a rejected checkpoint says which relation
   * broke instead of only which table. The clauses are the same ones the inline
   * predicate used to run; this only reports them.
   */
  const settlementProblem = settlement => {
    if (!fields(settlement, ['call', 'entry', 'identity', 'publication', 'observedIndex', 'ordinary', 'normalized'])) return 'fields'
    if (!callEvent(settlement.call)) return 'callEvent'
    if (!settlementEntry(settlement.entry)) return 'entry'
    if (!optional(settlement.normalized, normalizedResult)) return 'normalized'
    if (typeof settlement.ordinary !== 'boolean') return 'ordinary'
    if (!isCanonicalSequence(settlement.observedIndex) || value.lastEventIndex === null) return 'observedIndex'
    if (settlement.observedIndex < settlement.entry.eventIndex || settlement.observedIndex > value.lastEventIndex) return 'observedIndex range'
    if (typeof settlement.identity !== 'string' || !/^[a-f0-9]{64}$/u.test(settlement.identity)) return 'identity'
    if (REPL_TOOL_NAMES.has(settlement.call.data.name)
      && !deepEqualJson(executable.get(settlement.call.seq)?.event, settlement.call)) {
      const stored = executable.get(settlement.call.seq)?.event
      return `executable call (stored=${JSON.stringify(stored)?.slice(0, 220)} settlement=${JSON.stringify(settlement.call)?.slice(0, 220)})`
    }
    const publicationProblem = publication => {
      if (!fields(publication, ['index', 'journal', 'derived', 'userBindings', 'rewrites', 'postEdit', 'postEditRewrites'])) return 'publication fields'
      if (!deepEqualJson(publication.journal ?? null, settlement.normalized?.journal ?? null)) return 'publication journal'
      if (!deepEqualJson(publication.derived ?? null, settlement.normalized?.derived ?? null)) return 'publication derived'
      if (!deepEqualJson(publication.userBindings ?? null, settlement.normalized?.userBindings ?? null)) return 'publication userBindings'
      if (!deepEqualJson(publication.postEdit ?? null, settlement.normalized?.postEdit ?? null)) return 'publication postEdit'
      if (!deepEqualJson(publication.postEditRewrites ?? null, settlement.normalized?.postEdit?.rewrites ?? null)) return 'publication postEditRewrites'
      if (settlement.entry.ambiguous) return 'publication ambiguity'
      if (!isCanonicalSequence(publication.index)) return 'publication index'
      if (publication.index !== (settlement.ordinary ? settlement.observedIndex : settlement.entry.eventIndex)) return 'publication position'
      if (settlement.call.data.name === 'run_code' && publication.derived !== undefined) return 'publication derived target'
      if (settlement.call.data.name === 'edit_run_code'
        && (publication.derived === undefined
          || publication.derived.targetCallSeq !== settlement.entry.editTarget?.callSeq)) return 'publication edit target'
      if (publication.journal === undefined
        ? publication.derived !== undefined || publication.userBindings !== undefined
        : !journalFacts(publication)) return 'publication journal facts'
      if (!deepEqualJson(validatedRewrites({ [REWRITES_KEY]: publication.rewrites }) ?? null, publication.rewrites ?? null)) return 'publication rewrites'
      return undefined
    }
    if (!optional(settlement.publication, publication => publicationProblem(publication) === undefined)) return 'publication'
    if (isRecord(settlement.publication)) {
      const problem = publicationProblem(settlement.publication)
      if (problem !== undefined) return problem
    }
    return undefined
  }
  const settlements = table('settledResultsByEventSeq', isCanonicalSequence, settlement => settlementProblem(settlement) === undefined)
  // Normalized event facts retain distinctions needed by the transition but
  // omit result content. Admission uses that same transition, not a second
  // partial interpretation of the materialized caches.
  requireFact(Array.isArray(value.eventFacts))
  let reconstructed = createSessionTimelineState()
  let correlationIndex = -1
  let replayBytes = 0
  let replayComplete = true
  for (const observation of value.eventFacts) {
    requireFact(fields(observation, ['eventIndex', 'event', 'digest', 'identity', 'hasJournal', 'normalized',
      'boundaries', 'boundaryFailure', 'rewrites', 'selectedTarget'])
      && isCanonicalSequence(observation.eventIndex) && observation.eventIndex > correlationIndex
      && value.lastEventIndex !== null && observation.eventIndex <= value.lastEventIndex
      && isRecord(observation.event) && isCanonicalSequence(observation.event.seq)
      && ['turn/start', 'turn/end', RECOVERY_BOUNDARY_EVENT, 'compaction/prune', 'tool/call', 'tool/result',
        'tool/ptc-dispatch-start', 'tool/ptc-dispatch']
        .includes(observation.event.type)
      && deepEqualJson(correlationEvent(observation.event), observation.event)
      && (observation.event.type === 'tool/ptc-dispatch-start'
        && observation.event.data?.name === 'edit_run_code'
        ? observation.selectedTarget === null || target(observation.selectedTarget)
        : observation.selectedTarget === undefined)
      && (observation.event.type === 'tool/result'
        ? typeof observation.identity === 'string' && /^[a-f0-9]{64}$/u.test(observation.identity)
          && typeof observation.hasJournal === 'boolean'
        : observation.identity === undefined && observation.hasJournal === undefined)
      && optional(observation.normalized, normalizedResult)
      && optional(observation.boundaryFailure, failed => failed === true)
      && optional(observation.boundaries, boundaries => Array.isArray(boundaries)
        && boundaries.every(boundary => {
          if (!isRecord(boundary)) return false
          const { eventSeq, ...evidence } = boundary
          return eventSeq === observation.event.seq
            && deepEqualJson(normalizeRecoveryBoundaries([evidence], eventSeq), [boundary])
        }))
      && deepEqualJson(validatedRewrites({ [REWRITES_KEY]: observation.rewrites }) ?? null,
        observation.rewrites ?? null))
    correlationIndex = observation.eventIndex
    // Replay proves byte-for-byte equality, but its cost is proportional to the
    // retained payload of the whole session. Admission therefore replays only
    // while that payload stays inside the budget and falls back to the per-fact
    // digests plus the shape/identity checks above beyond it.
    replayBytes += factDigest(observation.event).length * 4
    if (replayBytes > ADMISSION_REPLAY_BUDGET_BYTES) {
      replayComplete = false
      continue
    }
    reconstructed = replaySessionTimelineFact(reconstructed, observation, executable)
  }
  const summary = retentionSummaryOf(value)
  // A compacted state that lost its summary must be rejected: dropping the summary
  // would erase the only trace of the clusters the window removed.
  if (value.compacted === true && summary === undefined) {
    throw new TypeError('inconsistent PTC session-log projection retention summary')
  }
  if (value.compacted !== true && summary !== undefined) {
    throw new TypeError('inconsistent PTC session-log projection retention summary')
  }
  if (summary !== undefined) {
    // A compacted checkpoint dropped whole clusters, so replay can never reproduce
    // it; the summary is proved instead — against the log when the caller has it.
    validateRetentionSummary(value, summary, logFacts)
  } else if (replayComplete) {
    // Non-compacted states keep the full replay equality.
    if (summary === undefined) requireFact(deepEqualJson(withoutFactDigests(reconstructed), withoutFactDigests(value)))
    else validateRetentionSummary(value, summary, logFacts)
  }
  // Semantic checks run first so their diagnostics stay specific; the digest is
  // the last line of defence and rejects a payload edit without replaying it.
  for (const observation of value.eventFacts) {
    if (observation.digest === undefined) continue
    const { digest, ...rest } = observation
    requireFact(digest === factDigest(rest))
  }
  for (const observation of ordinaryObservations.values()) {
    const settlement = settlements.get(observation.eventSeq)
    requireFact(settlement !== undefined
      ? settlement.ordinary && settlement.observedIndex === observation.eventIndex
        && (observation.callDigest === undefined
          ? deepEqualJson(settlement.call, observation.call)
          : eventDigest(settlement.call) === observation.callDigest)
      : value.runSelectionHistory.some(frontier => frontier.index === observation.eventIndex
        && frontier.reason === 'result-identity-mismatch'))
  }
  for (const settlement of settlements.values()) {
    if (!settlement.ordinary) continue
    const observation = ordinaryObservations.get(settlement.call.seq)
    requireFact(observation !== undefined && observation.eventIndex === settlement.observedIndex
      && (observation.callDigest === undefined
        ? deepEqualJson(observation.call, settlement.call)
        : eventDigest(settlement.call) === observation.callDigest))
  }
  const publications = [...settlements.values()].filter(settlement => settlement.publication !== undefined)
  // Dispatch targets are derived from first-observed settlements and retained
  // clears. A late prune reconstruction cannot establish an earlier target.
  const positions = new Map()
  for (const settlement of settlements.values()) {
    const previous = positions.get(settlement.observedIndex)
    requireFact(previous === undefined || deepEqualJson(previous, settlement))
    positions.set(settlement.observedIndex, settlement)
  }
  const chronology = [
    ...value.runSelectionHistory.map(frontier => ({ index: frontier.index, frontier })),
    ...[...executable.values()].map(entry => ({ index: entry.eventIndex, entry })),
    ...[...positions.values()].map(settlement => ({ index: settlement.observedIndex, settlement })),
  ].sort((left, right) => left.index - right.index)
  let dispatchScope = 0
  let dispatchFrontier = null
  let dispatchRun
  const dispatchClaims = new Set()
  const dispatchEdits = new Map()
  for (const item of chronology) {
    if (item.frontier !== undefined) {
      dispatchFrontier = item.frontier
      dispatchRun = undefined
      if (item.frontier.reason === 'turn/start' || item.frontier.reason === 'turn/end') {
        dispatchScope = item.frontier.scope
        dispatchClaims.clear()
        dispatchEdits.clear()
      }
    } else if (item.entry !== undefined) {
      requireFact(item.entry.scope === dispatchScope)
      if (item.entry.event.data.name !== 'edit_run_code') continue
      const expected = editTargetForSelection(dispatchRun, dispatchClaims)
      requireFact(deepEqualJson(targets.get(item.entry.event.seq), expected ?? null))
      if (expected !== undefined) {
        dispatchClaims.add(expected.callSeq)
        dispatchEdits.set(item.entry.event.seq, expected.callSeq)
      }
    } else {
      const settlement = item.settlement
      const claim = dispatchEdits.get(settlement.call.seq)
      if (claim !== undefined) {
        dispatchEdits.delete(settlement.call.seq)
        if (settlement.publication?.derived === undefined) dispatchClaims.delete(claim)
      }
      dispatchRun = selectSettlementRun(dispatchRun, settlement, dispatchScope, dispatchFrontier, executable)
    }
  }
  requireFact(claimed.size === dispatchClaims.size && [...dispatchClaims].every(seq => claimed.has(seq)))
  requireFact(edits.size === dispatchEdits.size && [...dispatchEdits].every(([seq, targetSeq]) => edits.get(seq) === targetSeq))
  let selectedRun
  let lastSuccessfulRunIndex
  for (const settlement of publications) {
    selectedRun = selectSettlementRun(selectedRun, settlement, value.scope, value.runSelectionFrontier, executable)
    if (successfulTimelineRun(settlementRun(settlement, executable))) {
      lastSuccessfulRunIndex = Math.max(lastSuccessfulRunIndex ?? -1, settlement.publication.index)
    }
  }
  requireFact(selectedRun === undefined || publications.some(settlement =>
    settlement.entry.scope === value.scope && !settlement.entry.ambiguous
    && settlementRun(settlement, executable)?.callSeq === selectedRun.callSeq))
  requireFact(selectedRun === undefined ? value.latestRun === undefined && value.editableRun === undefined
    : deepEqualJson(value.latestRun ?? null, selectedRun) && deepEqualJson(value.editableRun ?? null, selectedRun))
  requireFact(value.lastSuccessfulRunIndex === lastSuccessfulRunIndex
    && optional(value.unavailableResultSeq, isCanonicalSequence))
  requireFact(optional(value.unavailableResultReason, reason => isRecord(reason)
    && isCanonicalSequence(reason.seq) && typeof reason.reason === 'string'))
  requireFact(optional(value.pruneReplacementWindow, window => isRecord(window)
    && Array.isArray(window.seqs) && window.seqs.every(isCanonicalSequence)
    && new Set(window.seqs).size === window.seqs.length
    && isCanonicalSequence(window.lastEventIndex) && isCanonicalSequence(window.lastEventSeq)))
  for (const boundary of value.boundaries) {
    requireFact(isRecord(boundary) && isCanonicalSequence(boundary.carrierCallSeq))
    const { carrierCallSeq: _carrier, eventSeq, ...evidence } = boundary
    requireFact(isCanonicalSequence(eventSeq)
      && deepEqualJson(normalizeRecoveryBoundaries([evidence], eventSeq), [{ ...evidence, eventSeq }]))
  }
  const transcript = { calls: 0, inspections: 0 }
  for (const result of results.values()) {
    for (const call of result.journal?.calls ?? []) {
      if (call.global !== 'tools' || typeof call.member !== 'string' || !call.member.startsWith('cordis_')) continue
      transcript.calls += 1
      if (call.ok === true && call.member.startsWith('cordis_inspect')) transcript.inspections += 1
    }
  }
  requireFact(deepEqualJson(transcript, value.cordisTranscript))
  return value
}

export function advanceSessionTimeline(previous, inputEvent, eventIndex = inputEvent?.seq) {
  return advanceTimelineEvent(previous, inputEvent, eventIndex)
}

/** Reconstruct an already validated normalized fact at its recorded cut. */
export function replaySessionTimelineFact(previous, fact, retainedCalls) {
  return advanceTimelineEvent(previous, fact.event, fact.eventIndex, fact, retainedCalls)
}

function dispatchPairWithinRoot(facts, call, resultEvent, startSeq) {
  const selectedStarts = facts.filter(fact => fact.event.type === 'tool/ptc-dispatch-start'
    && fact.event.seq === startSeq)
  if (selectedStarts.length !== 1) return undefined
  const subCallId = selectedStarts[0].event.data?.subCallId
  if (typeof subCallId !== 'string') return undefined
  // A sequence locates a start; the bounded root window must also prove that
  // its dispatch identity names exactly one start and settlement. Settled ID
  // reuse outside this root/result window does not change this execution.
  const identityFacts = facts.filter(fact => fact.event.seq > call.seq
    && fact.event.seq < resultEvent.seq && fact.event.data?.subCallId === subCallId)
  const starts = identityFacts.filter(fact => fact.event.type === 'tool/ptc-dispatch-start')
  const settlements = identityFacts.filter(fact => fact.event.type === 'tool/ptc-dispatch')
  if (starts.length !== 1 || settlements.length !== 1
    || starts[0].event.seq !== startSeq || startSeq >= settlements[0].event.seq) return undefined
  return { start: starts[0], settled: settlements[0] }
}

function normalizePostEditFact(facts, call, resultEvent, result, replayPostEdit, executableCalls) {
  const post = replayPostEdit === undefined ? resultEvent.data?.meta?.[POST_EDIT_KEY] : {
    startSeq: replayPostEdit.startSeq,
    executionStartSeq: replayPostEdit.executionStartSeq,
    rootCallSeq: call.seq,
    subCallId: facts.find(fact => fact.event.seq === replayPostEdit.startSeq)?.event.data?.subCallId,
    meta: {
      [JOURNAL_KEY]: replayPostEdit.derived.journal,
      [EDIT_TARGET_KEY]: { targetCallSeq: replayPostEdit.targetCallSeq },
      [DERIVED_RUN_KEY]: { code: replayPostEdit.derived.code, description: replayPostEdit.derived.description },
      ...(replayPostEdit.derived.recoveryBoundaries === undefined ? {} : {
        [RECOVERY_BOUNDARY_KEY]: replayPostEdit.derived.recoveryBoundaries }),
      ...(replayPostEdit.derived.userBindings === undefined ? {} : {
        [USER_BINDINGS_META_KEY]: replayPostEdit.derived.userBindings }),
      ...(replayPostEdit.rewrites === undefined ? {} : { [REWRITES_KEY]: replayPostEdit.rewrites }),
    },
  }
  const acceptedCalls = result.journal?.calls?.filter(entry => (
    entry.global === 'tools' && entry.member === 'edit_run_code' && entry.ok === true
    && decodeValue(entry.value)?.accepted === true
  )) ?? []
  if (post === undefined && acceptedCalls.length === 0) return undefined
  const fail = reason => ({ error: `unproved deferred edit: ${reason}` })
  if (!isRecord(post) || !isCanonicalSequence(post.startSeq)
    || !isCanonicalSequence(post.executionStartSeq)
    || post.rootCallSeq !== call.seq || typeof post.subCallId !== 'string'
    || !isRecord(post.meta) || acceptedCalls.length !== 1) return fail('root metadata or receipt is missing')
  const editorPair = dispatchPairWithinRoot(facts, call, resultEvent, post.startSeq)
  if (editorPair === undefined || editorPair.start.event.data.subCallId !== post.subCallId) {
    return fail('nested dispatch pair is incomplete or ambiguous')
  }
  const start = editorPair.start.event
  const settled = editorPair.settled.event
  const target = editorPair.start.selectedTarget
  if (start.seq <= call.seq || start.seq >= settled.seq || settled.seq >= resultEvent.seq
    || start.data.rootCallId !== call.data.callId || start.data.parentCallId !== call.data.callId
    || settled.data.rootCallId !== start.data.rootCallId
    || settled.data.parentCallId !== start.data.parentCallId
    || settled.data.name !== 'edit_run_code' || start.data.name !== 'edit_run_code'
    || !deepEqualJson(start.data.arguments, settled.data.arguments)
    || settled.data.isError !== false) return fail('nested dispatch relation changed')
  const receipt = decodeValue(acceptedCalls[0].value)
  if (!deepEqualJson(receipt, { accepted: true, scheduled: true,
    target_call_seq: post.meta?.[EDIT_TARGET_KEY]?.targetCallSeq })
    || !deepEqualJson(decodeValue(acceptedCalls[0].args), start.data.arguments)) {
    return fail('nested receipt does not match root journal')
  }
  let derived
  try {
    derived = normalizeDeferredEditSettlement(post.meta, target?.callSeq)
  } catch (error) {
    return fail(error.message)
  }
  if (target?.source === undefined || sourceForRunCall(call, executableCalls) === undefined) {
    return fail('nested edit has no selected source')
  }
  const edit = editRejectedCell(start.data.arguments, target.source)
  if (!edit.edited || edit.code !== derived.code || edit.description !== derived.description
    || (start.data.arguments.expected_target_call_seq !== undefined
      && start.data.arguments.expected_target_call_seq !== target.callSeq)) {
    return fail('derived source does not match selected edit')
  }
  const executionPair = dispatchPairWithinRoot(facts, call, resultEvent, post.executionStartSeq)
  if (executionPair === undefined) return fail('derived execution dispatch pair is incomplete or ambiguous')
  const executionStart = executionPair.start.event
  const executionSettled = executionPair.settled.event
  const argumentsValue = { code: derived.code, description: derived.description }
  if (executionStart.seq <= settled.seq || executionStart.data.rootCallId !== call.data.callId
    || executionStart.data.parentCallId !== call.data.callId
    || executionStart.data.name !== 'run_code' || executionSettled.data.name !== 'run_code'
    || executionSettled.data.rootCallId !== executionStart.data.rootCallId
    || executionSettled.data.parentCallId !== executionStart.data.parentCallId
    || !deepEqualJson(executionStart.data.arguments, argumentsValue)
    || !deepEqualJson(executionSettled.data.arguments, argumentsValue)
    || !deepEqualJson(executionSettled.data.meta?.[JOURNAL_KEY], derived.journal)
    || typeof executionSettled.data.isError !== 'boolean'
    || executionSettled.data.isError !== (derived.journal.completion?.kind === 'throw'
      || derived.journal.status === 'discarded')) {
    return fail('derived execution relation changed')
  }
  const rewrites = validatedRewrites(post.meta)
  return { startSeq: start.seq, executionStartSeq: executionStart.seq,
    targetCallSeq: target.callSeq, derived,
    ...(rewrites === undefined ? {} : { rewrites }) }
}

function advanceTimelineEvent(previous, inputEvent, eventIndex, replayFact, retainedCalls) {
  const nested = inputEvent?.type === 'tool/ptc-dispatch-start'
    || inputEvent?.type === 'tool/ptc-dispatch'
  if (nested && inputEvent.data?.name !== 'edit_run_code'
    && inputEvent.data?.name !== 'run_code'
    && !previous.eventFacts.some(fact => fact.event.type === 'tool/ptc-dispatch-start'
      && fact.event.data?.subCallId === inputEvent.data?.subCallId)) return previous
  if (!['turn/start', 'turn/end', RECOVERY_BOUNDARY_EVENT, 'compaction/prune', 'tool/call', 'tool/result',
    'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(inputEvent?.type)) {
    return previous
  }
  const observation = { eventIndex, event: correlationEvent(inputEvent),
    ...(inputEvent.type === 'tool/result' ? {
      identity: replayFact === undefined ? resultIdentity(inputEvent.data) : replayFact.identity,
      hasJournal: replayFact === undefined
        ? isRecord(inputEvent.data?.meta) && Object.hasOwn(inputEvent.data.meta, JOURNAL_KEY) : replayFact.hasJournal,
    } : {}),
  }
  const state = { ...previous,
    lastEventIndex: eventIndex,
    eventFacts: [...previous.eventFacts, observation],
    executableCalls: new TimelineTable(previous.executableCalls),
    editTargets: new TimelineTable(previous.editTargets),
  }
  state.results = new TimelineTable(previous.results, (oldResult, newResult) => {
    const count = result => {
      let calls = 0
      let inspections = 0
      for (const call of result?.journal?.calls ?? []) {
        if (call.global !== 'tools' || typeof call.member !== 'string' || !call.member.startsWith('cordis_')) continue
        calls += 1
        if (call.ok === true && call.member.startsWith('cordis_inspect')) inspections += 1
      }
      return { calls, inspections }
    }
    const before = count(oldResult)
    const after = count(newResult)
    state.cordisTranscript = {
      calls: state.cordisTranscript.calls + after.calls - before.calls,
      inspections: state.cordisTranscript.inspections + after.inspections - before.inspections,
    }
  })
  const pendingByCallId = new TimelineTable(previous.pendingByCallId)
  const seenCallIds = new TimelineTable(previous.seenCallIds)
  const claimedEditTargets = new TimelineTable(previous.claimedEditTargets)
  const editClaims = new TimelineTable(previous.editClaims)
  const ordinaryResultSeqs = new TimelineTable(previous.ordinaryResultSeqs)
  const settledResultsByEventSeq = new TimelineTable(previous.settledResultsByEventSeq)
  let pruneReplacementWindow = previous.pruneReplacementWindow
  let scope = previous.scope

  const clearRunSelection = reason => {
    state.runSelectionFrontier = timelineJson({ index: eventIndex, scope, reason })
    state.runSelectionHistory = [...state.runSelectionHistory, state.runSelectionFrontier]
    state.latestRun = undefined
    state.editableRun = undefined
  }

  const resetTurn = (openTurn) => {
    state.openTurn = openTurn
    scope += 1
    pendingByCallId.clear()
    seenCallIds.clear()
    claimedEditTargets.clear()
    editClaims.clear()
    clearRunSelection(openTurn ? 'turn/start' : 'turn/end')
  }

  for (const event of [inputEvent]) {
    pruneReplacementWindow = nextPruneWindow(pruneReplacementWindow, event, eventIndex)
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
    if (event?.type === 'tool/ptc-dispatch-start') {
      if (event.data?.name !== 'edit_run_code') continue
      observation.selectedTarget = state.editableRun?.source === undefined ? null
        : timelineJson({ callSeq: state.editableRun.callSeq, source: state.editableRun.source })
      if (replayFact !== undefined && !deepEqualJson(observation.selectedTarget, replayFact.selectedTarget)) {
        throw new TypeError('invalid PTC session-log projection nested edit target fact')
      }
      continue
    }
    if (event?.type === 'tool/ptc-dispatch') continue
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      const executable = REPL_TOOL_NAMES.has(event.data.name)
      let entry = { event: timelineCallEvent(event, retainedCalls ?? state.executableCalls), eventIndex, scope }
      if (executable) {
        if (isCanonicalSequence(event.seq) && state.executableCalls.has(event.seq)) {
          // A sequence collision disproves both sources, but not the earlier
          // verified frontier. Keep its position for persistent contraction.
          const previous = { ...state.executableCalls.get(event.seq), ambiguous: true }
          state.executableCalls.set(event.seq, previous)
          state.unavailableResultSeq = Math.min(state.unavailableResultSeq ?? event.seq, event.seq)
          if (state.unavailableResultReason === undefined
            || event.seq < state.unavailableResultReason.seq) {
            state.unavailableResultReason = {
              seq: event.seq,
              reason: `duplicate executable tool call sequence ${event.seq}`,
            }
          }
          state.found = true
          clearRunSelection('duplicate-call-sequence')
          recordPendingCall(pendingByCallId, seenCallIds, entry, previous)
          continue
        }
        if (event.data.name === 'edit_run_code') {
          const target = editTargetForSelection(state.editableRun, claimedEditTargets)
          entry = { ...entry, editTarget: target }
          state.editTargets.set(event.seq, target ?? null)
          if (target !== undefined) {
            claimedEditTargets.add(target.callSeq)
            editClaims.set(event.seq, target.callSeq)
          }
        }
        state.calls = [...state.calls, event.seq]
        if (isCanonicalSequence(event.seq)) {
          state.executableCalls.set(event.seq, entry)
        }
      }
      recordPendingCall(pendingByCallId, seenCallIds, entry)
      continue
    }
    if (event?.type !== 'tool/result') continue

    const hasSourceRelation = Object.hasOwn(event, 'sourceEventSeqs')
    const sourceRelation = event.sourceEventSeqs
    const sourceSeq = sourceRelation?.[0]
    const canonicalSourceRelation = Array.isArray(sourceRelation)
      && sourceRelation.length === 1 && isCanonicalSequence(sourceSeq)
    const callId = event.data?.message?.source?.callId
    const resolution = resolveTimelineResult(event, eventIndex, state.executableCalls, pendingByCallId,
      settledResultsByEventSeq, pruneReplacementWindow, observation.identity)
    const { entry, prunedReplacement, republishedSettlement } = resolution
    pruneReplacementWindow = resolution.pruneReplacementWindow
    if (republishedSettlement !== undefined) {
      const resultSeq = republishedSettlement.call.seq
      const settledResult = state.results.get(resultSeq)
      if (settledResult !== undefined) {
        state.results.set(resultSeq, republishedTimelineResult(settledResult, event))
      }
      settledResultsByEventSeq.set(event.seq, republishedSettlement)
      continue
    }
    if (hasSourceRelation && !canonicalSourceRelation) {
      const callSeq = invalidSourceCallSeq(event, state.executableCalls, pendingByCallId)
      if (callSeq !== undefined) {
        state.unavailableResultSeq = Math.min(state.unavailableResultSeq ?? callSeq, callSeq)
        state.results.set(callSeq, timelineResultError(event, eventIndex, callSeq,
          `tool result has an invalid source relation for call seq ${callSeq}`))
        state.found = true
      }
      if (typeof callId === 'string') pendingByCallId.delete(callId)
      clearRunSelection('invalid-source-relation')
      continue
    }
    if (typeof callId === 'string') pendingByCallId.delete(callId)
    if (entry === null) {
      clearRunSelection('ambiguous-call-id')
      continue
    }

    const call = entry?.event
    if (entry?.ambiguous) {
      clearRunSelection('ambiguous-call-sequence')
      continue
    }
    const callSeq = call?.seq
    const meta = event.data?.meta
    if (!prunedReplacement && isCanonicalSequence(callSeq)) {
      if (ordinaryResultSeqs.has(callSeq)) {
        state.unavailableResultSeq ??= callSeq
        state.results.set(callSeq, timelineResultError(event, eventIndex, callSeq,
          `session log contains duplicate ordinary tool results for call seq ${callSeq}`))
        state.found = true
        clearRunSelection('duplicate-result')
        continue
      }
      // Non-REPL tools never enter `executableCalls` (only executable REPL calls
      // are retained there), so their observation keeps the call event itself.
      // REPL calls keep the digest and resolve the event through executableCalls,
      // which is why one table has two legal shapes.
      ordinaryResultSeqs.set(callSeq, timelineJson({
        ...(state.executableCalls.get(callSeq) === undefined ? { call } : { callDigest: eventDigest(call) }),
        eventSeq: isCanonicalSequence(event.seq) ? event.seq : callSeq, eventIndex }))
    }
    if (call !== undefined && typeof callId === 'string' && call.data.callId !== callId) {
      clearRunSelection('result-identity-mismatch')
      if (isCanonicalSequence(callSeq)) {
        state.unavailableResultSeq ??= callSeq
        state.results.set(callSeq, timelineResultError(event, eventIndex, callSeq,
          `tool result identities disagree for call seq ${callSeq}`))
        state.found = true
      }
      continue
    }
    let normalized
    if (observation.hasJournal) {
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
        ? state.results.get(resultSeq)?.positionSeq ?? state.results.get(resultSeq)?.eventSeq ?? sourceSeq
        : undefined
      const raw = {
        eventSeq: isCanonicalSequence(event.seq) ? event.seq : resultSeq,
        ...(settlementPosition === undefined ? {} : { positionSeq: settlementPosition }),
        eventIndex,
      }
      if (replayFact === undefined) {
        if (Object.hasOwn(meta, RECOVERY_BOUNDARY_KEY)) {
          try {
            observation.boundaries = normalizeRecoveryBoundaries(meta[RECOVERY_BOUNDARY_KEY], raw.eventSeq)
          } catch {
            observation.boundaryFailure = true
          }
        }
        try {
          if (call.data.name === 'edit_run_code') {
            const derived = normalizeDeferredEditSettlement(meta, entry.editTarget?.callSeq)
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
            let postEdit
            try {
              postEdit = normalizePostEditFact(state.eventFacts, call, event, normalized, undefined, state.executableCalls)
            } catch (error) {
              postEdit = { error: `unproved deferred edit: ${error.message}` }
            }
            if (postEdit?.error !== undefined) normalized.postEditError = postEdit.error
            else if (postEdit !== undefined) normalized.postEdit = postEdit
          }
        } catch (error) {
          normalized = { ...raw, error: error.message }
        }
        if (normalized === undefined) {
          // PTC metadata on a settlement whose call is not a REPL tool is
          // unproved evidence: it must contract the frontier, not escape the fold.
          normalized = { ...raw, error: 'PTC journal metadata appeared on a non-REPL tool result' }
        }
      } else {
        normalized = replayFact.normalized
        if (normalized === undefined || !deepEqualJson(raw, {
          eventSeq: normalized.eventSeq, eventIndex: normalized.eventIndex,
          ...(normalized.positionSeq === undefined ? {} : { positionSeq: normalized.positionSeq }),
        })) throw new TypeError('invalid PTC session-log projection timeline checkpoint result facts')
        if (replayFact.boundaries !== undefined) observation.boundaries = replayFact.boundaries
        if (replayFact.boundaryFailure !== undefined) observation.boundaryFailure = replayFact.boundaryFailure
        if (normalized.postEdit !== undefined) {
          const checked = normalizePostEditFact(state.eventFacts, call, event, normalized, normalized.postEdit, state.executableCalls)
          if (checked?.error !== undefined || !deepEqualJson(checked, normalized.postEdit)) {
            throw new TypeError(`invalid PTC session-log projection deferred edit fact: ${checked?.error ?? 'derived fact changed'}`)
          }
        }
      }
      observation.normalized = normalized
      if (observation.boundaries !== undefined) {
        state.boundaries = [...state.boundaries, ...observation.boundaries.map(boundary => ({
          ...boundary, carrierCallSeq: resultSeq,
        }))]
      }
      if (observation.boundaryFailure) state.unavailableResultSeq ??= callSeq
      if (isCanonicalSequence(resultSeq)) state.results.set(resultSeq, timelineJson(normalized))
      state.found = true
    }
    const settlement = call === undefined ? undefined : { call, entry: {
      eventIndex: entry?.eventIndex, scope: entry?.scope,
      ...(entry?.ambiguous === true ? { ambiguous: true } : {}),
      ...(entry?.editTarget === undefined ? {} : { editTarget: entry.editTarget }),
    }, identity: observation.identity,
      observedIndex: eventIndex, ordinary: !prunedReplacement,
      ...(normalized === undefined ? {} : { normalized }) }
    if (settlement !== undefined && entry.scope === scope
      && (call.data.name === 'run_code' || normalized?.derived !== undefined)) {
      const rewrites = replayFact === undefined ? validatedRewrites(meta) : replayFact.rewrites
      if (rewrites !== undefined) observation.rewrites = rewrites
      settlement.publication = {
        index: prunedReplacement ? entry.eventIndex : eventIndex,
        journal: normalized?.journal,
        derived: normalized?.derived,
        userBindings: normalized?.userBindings,
        rewrites,
        ...(normalized?.postEdit === undefined ? {} : {
          postEdit: normalized.postEdit,
          postEditRewrites: normalized.postEdit.rewrites,
        }),
      }
    }
    if (settlement !== undefined && isCanonicalSequence(event.seq)) {
      settledResultsByEventSeq.set(event.seq, settlement)
      state.retainedBytes += settlementBytes(settlement)
    }

    const claimedTarget = editClaims.get(callSeq)
    if (claimedTarget !== undefined) {
      editClaims.delete(callSeq)
      if (normalized?.derived === undefined) claimedEditTargets.delete(claimedTarget)
    }
    if (entry === undefined || entry.scope !== scope) continue
    const publishRun = () => {
      const run = settlementRun(settlement, state.executableCalls)
      state.latestRun = selectSettlementRun(state.latestRun, settlement, scope, state.runSelectionFrontier,
        state.executableCalls)
      state.editableRun = state.latestRun
      if (successfulTimelineRun(run)) {
        state.lastSuccessfulRunIndex = Math.max(state.lastSuccessfulRunIndex ?? -1, run.index)
      }
    }
    if (call.data.name === 'edit_run_code') {
      if (normalized?.derived !== undefined) {
        publishRun()
      }
      continue
    }
    if (call.data.name !== 'run_code') {
      // Unrelated native settlements do not change the current editable cell.
      // The edit target is captured at dispatch time and remains valid until a
      // new executable cell or turn boundary supersedes it.
      continue
    }
    publishRun()
  }
  // Digest the serialized fact (undefined fields dropped) so admission can
  // re-digest exactly the bytes it received.
  const plainObservation = JSON.parse(JSON.stringify(observation))
  plainObservation.digest = factDigest(plainObservation)
  state.eventFacts[state.eventFacts.length - 1] = timelineJson(plainObservation)
  pruneRetention(state, { settled: settledResultsByEventSeq, executable: state.executableCalls, results: state.results,
    ordinary: ordinaryResultSeqs })
  return Object.fromEntries(Object.entries({ ...state,
    executableCalls: state.executableCalls.table, results: state.results.table, editTargets: state.editTargets.table,
    pendingByCallId: pendingByCallId.table, seenCallIds: seenCallIds.table,
    claimedEditTargets: claimedEditTargets.table, editClaims: editClaims.table,
    ordinaryResultSeqs: ordinaryResultSeqs.table, settledResultsByEventSeq: settledResultsByEventSeq.table,
    pruneReplacementWindow, scope,
  }).filter(([_key, value]) => value !== undefined))
}

/**
 * Refold a session while keeping every payload.
 *
 * A consumer that needs a cluster the retention window dropped cannot rebuild it
 * from the checkpoint. The session log still has the events, so the caller refolds
 * that slice with pruning disabled and reads the cluster from there. The flag is
 * scoped to one synchronous fold; the checkpointed state never sees it.
 */
let fullRetentionDepth = 0
export function withFullRetention(run) {
  fullRetentionDepth += 1
  try {
    return run()
  } finally {
    fullRetentionDepth -= 1
  }
}

/**
 * Drop the oldest settlements entirely and fold them into one summary.
 *
 * The projection is a fold shortcut, not the log. Keeping a digest stub per settled
 * cell still made a checkpoint proportional to how many cells the session ran (450
 * stubs cost ~1.7 MB before any payload), so the whole cluster is dropped instead:
 * the settlement, its executable call, its ordinary observation and its normalized
 * result. What survives is one chained summary of what was dropped, which is what
 * makes the size a function of the window rather than of the session.
 *
 * Consumers that need a dropped cell must refold it from the session log; when the
 * log cannot supply it they report `retention-pruned` instead of guessing.
 */
/**
 * A call event whose argument text is gone keeps its identity and the digest of
 * exactly the bytes it used to carry, so a refold can prove the text it recovers
 * is the text the checkpoint once held.
 */
function digestArgumentData(data) {
  if (!isRecord(data) || typeof data.arguments !== 'string') return data
  const { arguments: text, ...rest } = data
  return { ...rest, argumentsDigest: digestOf(text), argumentsBytes: byteLength(text) }
}

/**
 * A republication clones a call event into its own settlement, so the same call can
 * appear twice: once in `executableCalls` and once in a settlement that names its
 * sequence. Whichever copy the retention window digests, every copy of that call must
 * end up in the same shape, or a checkpoint would describe one call two ways. The
 * pass is idempotent and runs on every prune, so a clone added after the window moved
 * still lands on the retained shape — the fold and the replay both go through it.
 */
function digestSettlementCallCopies(tables) {
  for (const pair of Object.values(tables.settled.table)) {
    const [, settlement] = pair
    if (!isRecord(settlement) || !isRecord(settlement.call)) continue
    if (typeof settlement.call.data?.arguments !== 'string') continue
    const retained = tables.executable.get(settlement.call.seq)
    if (typeof retained?.event?.data?.argumentsDigest !== 'string') continue
    tables.settled.set(pair[0], { ...settlement, call: { ...settlement.call, data: digestArgumentData(settlement.call.data) } })
  }
}

/**
 * A journal outside the payload window keeps everything recovery reads — status,
 * operations, user binding evidence, confirms, completion and per-call metadata —
 * and replaces each call's argument wire with its digest. Byte-for-byte equality
 * of argument text is what the window gives up; identity is not.
 */
function digestJournalArguments(journal) {
  if (process.env.DIGEST_SKIP_JOURNAL === '1') return journal
  if (!isRecord(journal) || !Array.isArray(journal.calls)) return journal
  return { ...journal, calls: journal.calls.map(call => {
    if (!isRecord(call) || !Object.hasOwn(call, 'args')) return call
    const { args, ...rest } = call
    return { ...rest, argsDigest: digestOf(args), argsBytes: byteLength(args) }
  }) }
}

/**
 * A derived run keeps the shape recovery validates (target, description, rewrites)
 * and replaces the cell source with its digest. The source is the payload the
 * window bounds; the edit path refolds it from the log when the text is needed.
 */
function digestDerivedCode(derived) {
  if (!isRecord(derived) || typeof derived.code !== 'string') return derived
  const { code, ...rest } = derived
  return { ...rest, codeDigest: digestOf(code), codeBytes: byteLength(code) }
}

function pruneRetention(state, tables) {
  if (fullRetentionDepth > 0) return
  const entries = Object.entries(tables.settled.table)
    .map(([, pair]) => ({ settlement: pair[1], resultSeq: pair[0] }))
    .filter(entry => entry.settlement !== undefined)
    .sort((left, right) => left.settlement.observedIndex - right.settlement.observedIndex)
  if (entries.length === 0) return
  const limits = retentionLimits()
  // The count window is order-only so a replayed fold prunes identically. A
  // configured cluster cap of 0 means the count window never folds anything and
  // the payload budget is the only bound.
  const keepClusters = limits.clusters === 0 ? entries.length : Math.min(entries.length, limits.clusters)
  const keepFrom = Math.max(0, entries.length - keepClusters)
  // The runs a consumer reads synchronously — the latest publication and the cell
  // an edit would capture — stay inside the window even when newer settlements
  // pushed them past the count. Dropping them would turn "editable" into "pruned"
  // for the cell the user is actually looking at.
  const pinnedCallSeqs = new Set([state.latestRun?.callSeq, state.editableRun?.callSeq]
    .filter(callSeq => isCanonicalSequence(callSeq)))
  // Only a cluster beyond the configured cluster cap is folded into the interval
  // summary. Every other cluster stays, with its payload text replaced by digests,
  // so recovery evidence never depends on refolding the session log.
  const folded = new Set(entries.slice(0, keepFrom)
    .filter(entry => pinnedCallSeqs.has(entry.settlement.call?.seq) === false)
    .map(entry => entry.resultSeq))
  const mustPrune = new Set(folded)
  // A cumulative byte cap, not only a per-entry one: the window has to be a constant
  // regardless of how large the retained cells are, otherwise 32 cells of 200 KB
  // still put 6.4 MB in every checkpoint. Walk newest-first and stop retaining once
  // the payload budget is spent. A single entry larger than the whole budget is
  // dropped too: the bound wins over keeping the hot cell, and the edit path refolds
  // that cell from the session log when it is needed.
  const retainedPayloadBytes = (entry, executable = tables.executable) => {
    const callSeq = entry.settlement.call?.seq
    const stored = callSeq === undefined ? undefined : executable.get(callSeq)
    const executableArguments = stored?.event?.data?.arguments
    return settlementBytes(entry.settlement)
      + (typeof executableArguments === 'string' ? byteLength(executableArguments) : 0)
  }
  let retainedTotal = 0
  const newestFirst = [...entries].reverse()
  for (const [index, entry] of newestFirst.entries()) {
    const bytes = retainedPayloadBytes(entry)
    const pinned = pinnedCallSeqs.has(entry.settlement.call?.seq)
    // The run a consumer reads synchronously keeps its text even past the count
    // window: the window bounds how much history stays readable, never the cell the
    // user is looking at. Only the byte budget can digest a pinned cell.
    const outsidePayloadWindow = index >= limits.runs && !pinned
    const overBudget = bytes > limits.bytes
    if (overBudget || outsidePayloadWindow || (index > 0 && !pinned && retainedTotal + bytes > limits.bytes)) {
      mustPrune.add(entry.resultSeq)
      continue
    }
    retainedTotal += bytes
  }
  if (mustPrune.size === 0) return
  const droppedCallSeqs = new Set()
  const droppedResultSeqs = new Set()
  const dropped = []
  const digested = new Set([...mustPrune].filter(resultSeq => !folded.has(resultSeq)))
  const digestedResultSeqs = new Set()
  const digestedHotCell = state.latestRun !== undefined && entries.some(entry => (
    digested.has(entry.resultSeq) && entry.settlement.call?.seq === state.latestRun?.callSeq))
  for (const entry of entries) {
    if (!digested.has(entry.resultSeq)) continue
    const callSeq = entry.settlement.call?.seq
    if (callSeq !== undefined && tables.executable.has(callSeq)) {
      const stored = tables.executable.get(callSeq)
      tables.executable.set(callSeq, { ...stored, event: { ...stored.event, data: digestArgumentData(stored.event.data) } })
      digestSettlementCallCopies(tables)
    }
    // The result keeps every field recovery reads — status, operations, user
    // binding evidence, confirms, completion and call metadata — and loses only
    // the argument wire of each call.
    for (const key of [entry.resultSeq, callSeq]) {
      if (key === undefined || !tables.results.has(key)) continue
      const result = tables.results.get(key)
      if (!isRecord(result) || result.journal === undefined) continue
      tables.results.set(key, { ...result, journal: digestJournalArguments(result.journal) })
    }
    // The settlement keeps its normalized and publication entries because recovery
    // and the run derivations read them; only the journal argument wire and the
    // derived source are replaced by digests, which is exactly the payload the
    // window bounds. Identity, observations and result metadata stay.
    const digestJournalEntry = value => value === undefined ? undefined : {
      ...value,
      ...(value.journal === undefined ? {} : { journal: digestJournalArguments(value.journal) }),

    }
    tables.settled.set(entry.resultSeq, {
      ...entry.settlement,
      ...(callSeq === undefined
        ? {}
        : { call: { ...entry.settlement.call, data: digestArgumentData(entry.settlement.call.data) } }),
      ...(entry.settlement.normalized === undefined
        ? {}
        : { normalized: digestJournalEntry(entry.settlement.normalized) }),
      ...(entry.settlement.publication === undefined
        ? {}
        : { publication: digestJournalEntry(entry.settlement.publication) }),
    })
    digestedResultSeqs.add(Number(entry.resultSeq))
    state.retainedBytes = Math.max(0, state.retainedBytes - settlementBytes(entry.settlement))
  }
  for (const entry of entries) {
    if (!mustPrune.has(entry.resultSeq)) continue
    if (!folded.has(entry.resultSeq)) continue
    const callSeq = entry.settlement.call?.seq
    dropped.push(summaryEntry(entry.settlement, Number(entry.resultSeq)))
    tables.settled.delete(entry.resultSeq)
    if (callSeq !== undefined) {
      tables.executable.delete(callSeq)
      if (tables.ordinary?.has(callSeq)) tables.ordinary.delete(callSeq)
      droppedCallSeqs.add(callSeq)
    }
    // `results` is keyed by the RESULT sequence on the ordinary path and by the CALL
    // sequence on the republication path, so drop both keys when either exists.
    for (const key of [entry.resultSeq, callSeq]) {
      if (key === undefined) continue
      if (tables.results.has(key)) tables.results.delete(key)
    }
    droppedResultSeqs.add(entry.resultSeq)
    state.retainedBytes = Math.max(0, state.retainedBytes - settlementBytes(entry.settlement))
  }
  // A digested cluster kept its identity, so the ordered call list keeps its seq;
  // a folded cluster is gone and takes its seq with it.
  state.calls = state.calls.filter(callSeq => !droppedCallSeqs.has(callSeq))
  // The hot run can be lost either way: a folded cluster no longer exists, and a
  // digested one no longer holds the source a run is built from. Consumers that
  // need it refold from the session log, and report the notice until they do.
  if (state.latestRun !== undefined
    && (droppedCallSeqs.has(state.latestRun.callSeq) || digestedHotCell)) {
    state.latestRun = undefined
    state.editableRun = undefined
  }
  // `hotCellDropped` describes the retained set, not the route the fold took to it.
  // It holds exactly when the newest settlement no longer carries its payload:
  // either it was folded away, or its argument text was digested. Recomputing it
  // from the table on every prune keeps a replayed fold — which reaches the same set
  // by a different route — from disagreeing with the stored one.
  const newestEntry = entries[entries.length - 1]
  const newestStored = newestEntry === undefined ? undefined : tables.settled.get(newestEntry.resultSeq)
  state.hotCellDropped = newestEntry !== undefined
    && (newestStored === undefined || newestStored.call?.data?.arguments === undefined)
  // `retainedBytes` is a property of the retained set, not a running total: a fold
  // that digests a cluster after it was counted would otherwise carry a different
  // value than a fold that reaches the same set by another route. Recompute it from
  // the table so both sides agree, and so the number always describes what is there.
  state.retainedBytes = entries.reduce((total, entry) => {
    const stored = tables.settled.get(entry.resultSeq)
    return stored === undefined ? total : total + settlementBytes(stored)
  }, 0)
  if (dropped.length === 0 && digested.size === 0) return
  if (dropped.length !== 0) {
    state.compacted = true
    dropped.sort((left, right) => left.resultSeq - right.resultSeq)
    state.retentionSummary = extendSummary(state.retentionSummary, dropped)
  }
  // The facts of a folded cluster keep their identity and digests but lose the
  // payload text, for the same reason the cluster itself is gone.
  // A fact per event is itself linear in the session length, so a folded cluster
  // takes its tool/call and tool/result facts with it. Admission for a compacted
  // checkpoint proves the summary instead of replaying those facts.
  state.eventFacts = state.eventFacts.filter(fact => {
    if (fact.event?.type === 'tool/call' && droppedCallSeqs.has(fact.event.seq)) return false
    if (fact.normalized !== undefined && droppedResultSeqs.has(Number(fact.normalized.eventSeq))) return false
    return true
  })
  // A digested cluster keeps its facts, but they carry the digest-only journal too:
  // the fact list is a second copy of the same result content. Rewriting the payload
  // invalidates the fact's own digest, so it is recomputed here — admission checks
  // that digest against the bytes it receives.
  state.eventFacts = state.eventFacts.map(fact => {
    if (fact.normalized === undefined || !digestedResultSeqs.has(Number(fact.normalized.eventSeq))) return fact
    const { digest: _digest, ...rest } = fact
    const next = { ...rest, normalized: digestJournalArguments(fact.normalized) }
    next.digest = factDigest(next)
    return next
  })
  // A dispatch fact names the cell an edit would capture, and that target carries
  // the cell's source. Once the payload is digested the fold can no longer derive
  // that source, so the fact must record the same "no target" the fold would
  // produce now; leaving the old text behind would both duplicate the payload and
  // fail the round-trip check that compares the fact with its re-derivation.
  const digestedCallSeqs = new Set(entries
    .filter(entry => digested.has(entry.resultSeq))
    .map(entry => Number(entry.settlement.call?.seq)))
  if (digestedCallSeqs.size !== 0) {
    let rewritten = false
    state.eventFacts = state.eventFacts.map(fact => {
      const target = fact.selectedTarget
      if (!isRecord(target) || !digestedCallSeqs.has(Number(target.callSeq))) return fact
      const { digest: _digest, ...rest } = fact
      const next = { ...rest, selectedTarget: null }
      next.digest = factDigest(next)
      rewritten = true
      return timelineJson(next)
    })
    if (rewritten) state.eventFacts = state.eventFacts.map(fact => timelineJson(fact))
  }
}

function findResultSeq(table, settlement) {
  for (const [key, candidate] of Object.entries(table.table)) {
    if (candidate === settlement) return candidate[0]
  }
  return undefined
}

export function sessionTimelineValue(checkpoint) {
  return { ...checkpoint,
    executableCalls: new Map(Object.values(checkpoint.executableCalls)),
    results: new Map(Object.values(checkpoint.results)),
    editTargets: new Map(Object.values(checkpoint.editTargets).map(([seq, target]) => [seq, target ?? undefined])),
  }
}

export function foldSessionTimeline(events) {
  let checkpoint = createSessionTimelineState()
  if (Array.isArray(events)) {
    for (let index = 0; index < events.length; index += 1) {
      checkpoint = advanceSessionTimeline(checkpoint, events[index], index)
    }
  }
  return sessionTimelineValue(checkpoint)
}

/** Fold the session log into the last exactly replayable frontier. */
export function recoverJournal(session, currentCallSeq, options = {}) {
  const events = sessionEvents(session)
  if (!Array.isArray(events)) {
    return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], provenBindings: [], available: true }
  }
  // Recovery rebuilds bindings from the cell sources and journals. A checkpoint
  // outside the payload window keeps those as digests, so the fold is repeated with
  // retention disabled on the same slice: the log is the authority, and reading it
  // costs one extra fold only when a digested cluster is present.
  const folded = foldSessionTimeline(events)
  const needsPayload = [...folded.executableCalls.values()]
    .some(entry => typeof entry?.event?.data?.arguments !== 'string')
  const timeline = needsPayload ? withFullRetention(() => foldSessionTimeline(events)) : folded
  const calls = timelineCalls(timeline).filter(call => call.seq !== currentCallSeq)
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
      // Derived records exist only after the shared timeline has proved both
      // dispatch pairs and the final root publication. A raw nested start does
      // not establish a program identity or a completed recovery boundary.
      const derivedRecords = failedCall === undefined ? orderedRecords.filter(record => (
        record.call.seq === boundary.failedCallSeq
        && record.call.type === 'tool/ptc-dispatch-start'
        && record.call.data?.name === 'run_code' && record.result?.derived !== undefined
      )) : []
      const failedExecution = failedCall === undefined && derivedRecords.length === 1
        ? derivedRecords[0] : undefined
      const isEarlierExecution = failedCall === undefined
        ? failedExecution !== undefined && recordEventSeq(failedExecution) < boundary.eventSeq
        : failedCall.event.seq < boundary.eventSeq
      if (!isEarlierExecution) {
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
    if (call.data?.name === 'run_code' && result?.journal !== undefined) {
      if (result.postEditError !== undefined) {
        invalidResultReasons.set(call.seq, result.postEditError)
        registerUnavailable({ seq: call.seq, reason: result.postEditError })
      } else if (result.postEdit !== undefined && result.postEdit.derived.unexecuted !== true) {
        // A derived execution that never ran proves no state of its own, so it is
        // not folded as a record; the root cell's own record already carries the
        // proof of the accepted edit.
        const postEdit = result.postEdit
        orderedRecords.push({
          call: timeline.eventFacts.find(fact => fact.event.seq === postEdit.executionStartSeq).event,
          code: postEdit.derived.code,
          result: { eventSeq: result.eventSeq, journal: postEdit.derived.journal,
            derived: postEdit.derived, userBindings: postEdit.derived.userBindings },
          hidden: visibleCalls instanceof Set && (!visibleCalls.has(call.seq)
            || !visibleCalls.has(postEdit.targetCallSeq)),
        })
      }
    }
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
  // The names the session log proves stay off the enumerable history shape so
  // every existing consumer sees the same object it saw before; recovery-only
  // readers (the missing-binding notice) reach them through this property.
  const history = {
    nodes: state.nodes,
    head: state.head,
    checkpoints: state.checkpoints,
    volatileSuffix: state.volatileSuffix,
    available: found && !state.surfaceContracted && unavailableBoundary === undefined,
  }
  history.provenBindings = [...state.provenBindings]
  // Recovery-only, like the proved names: the enumerable history shape is a
  // contract other readers compare against, so the deletion set stays off it.
  Object.defineProperty(history, 'deletedBindings', {
    value: [...state.deletedBindings],
    enumerable: false,
    configurable: true,
  })
  return history
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
