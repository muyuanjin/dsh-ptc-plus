import { createHash } from 'node:crypto'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import { deepFreeze, isRecord } from './record-utils.js'
import { sessionEvents } from './session-events.js'
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

function settlementRun(settlement) {
  const publication = settlement.publication
  if (publication === undefined) return undefined
  const result = { data: { meta: { [REWRITES_KEY]: publication.rewrites } } }
  return timelineJson(publication.derived === undefined
    ? timelineRun(settlement.call, result, publication.index, publication.journal)
    : timelineDerivedRun(settlement.call, result, publication.index, publication.derived))
}

function selectSettlementRun(selected, settlement, scope, frontier) {
  const publication = settlement.publication
  if (publication === undefined || settlement.entry.scope !== scope
    || (frontier !== null && publication.index <= frontier.index)) return selected
  return selected === undefined || publication.index >= selected.index ? settlementRun(settlement) : selected
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

function correlationEvent(event) {
  return timelineJson({ seq: event.seq, type: event.type,
    ...(event.type === 'tool/call' && typeof event.data?.callId === 'string'
      ? { data: timelineCallEvent(event).data } : {}),
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

function timelineCallEvent(event) {
  return timelineJson({ seq: event.seq, type: event.type, data: {
    callId: event.data.callId, name: event.data.name,
    ...(REPL_TOOL_NAMES.has(event.data.name) ? { arguments: event.data.arguments } : {}),
  } })
}

function resultIdentity(data) {
  const identity = timelineJson(isRecord(data) && isRecord(data.message)
    ? { ...data, message: { ...data.message, content: undefined } } : data)
  return createHash('sha256').update(JSON.stringify(identity, (_key, value) => (
    isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value
  ))).digest('hex')
}

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
    scope: 0,
  }
}

export function validateSessionTimelineState(value) {
  const requireFact = condition => {
    if (!condition) throw new TypeError('invalid PTC session-log projection timeline checkpoint')
  }
  const optional = (field, predicate) => field === undefined || predicate(field)
  const fields = (record, names) => isRecord(record) && Object.keys(record).every(name => names.includes(name))
  const target = field => fields(field, ['callSeq', 'source']) && isCanonicalSequence(field.callSeq) && typeof field.source === 'string'
  const callEvent = event => fields(event, ['seq', 'type', 'data']) && isCanonicalSequence(event.seq) && event.type === 'tool/call'
    && isRecord(event.data) && typeof event.data.callId === 'string'
    && fields(event.data, ['callId', 'name', 'arguments'])
    && optional(event.data.name, name => typeof name === 'string')
    && optional(event.data.arguments, args => typeof args === 'string')
  const callEntry = entry => fields(entry, ['event', 'eventIndex', 'scope', 'ambiguous', 'editTarget']) && callEvent(entry.event)
    && isCanonicalSequence(entry.eventIndex) && isCanonicalSequence(entry.scope) && entry.scope <= value.scope
    && optional(entry.ambiguous, field => field === true) && optional(entry.editTarget, target)
  const table = (name, keyValid, payloadValid) => {
    requireFact(isRecord(value[name]))
    for (const [key, pair] of Object.entries(value[name])) {
      requireFact(Array.isArray(pair) && pair.length === 2 && keyValid(pair[0]) && key === `k${pair[0]}`)
      requireFact(payloadValid(pair[1], pair[0]))
    }
    return new Map(Object.values(value[name]))
  }
  requireFact(isJsonValue(value) && fields(value, ['openTurn', 'executableCalls', 'calls', 'results', 'boundaries', 'found',
    'cordisTranscript', 'editTargets', 'pendingByCallId', 'seenCallIds', 'claimedEditTargets', 'editClaims',
    'ordinaryResultSeqs', 'settledResultsByEventSeq', 'scope', 'latestRun', 'editableRun', 'lastSuccessfulRunIndex',
    'unavailableResultSeq', 'unavailableResultReason', 'pruneReplacementWindow', 'runSelectionFrontier',
    'runSelectionHistory', 'lastEventIndex', 'eventFacts']) && typeof value.openTurn === 'boolean'
    && typeof value.found === 'boolean' && isCanonicalSequence(value.scope)
    && Array.isArray(value.calls) && value.calls.every(callEvent) && Array.isArray(value.boundaries))
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
  for (const call of value.calls) {
    requireFact(!callSeqs.has(call.seq) && deepEqualJson(executable.get(call.seq)?.event, call))
    callSeqs.add(call.seq)
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
      const normalized = normalizeDerivedEditResult({
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
    if (!fields(result, ['eventSeq', 'eventIndex', 'positionSeq', 'error', 'journal', 'derived', 'userBindings'])
      || !isCanonicalSequence(result.eventSeq) || !isCanonicalSequence(result.eventIndex)
      || !optional(result.positionSeq, isCanonicalSequence)) return false
    if (result.error !== undefined) return typeof result.error === 'string' && result.journal === undefined && result.derived === undefined
    return journalFacts(result)
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
  const ordinaryObservations = table('ordinaryResultSeqs', isCanonicalSequence, (observation, seq) => fields(observation,
    ['call', 'eventSeq', 'eventIndex']) && callEvent(observation.call) && observation.call.seq === seq
    && isCanonicalSequence(observation.eventSeq) && isCanonicalSequence(observation.eventIndex)
    && value.lastEventIndex !== null && observation.eventIndex <= value.lastEventIndex
    && (!REPL_TOOL_NAMES.has(observation.call.data.name)
      || (deepEqualJson(executable.get(seq)?.event, observation.call)
        && observation.eventIndex >= executable.get(seq).eventIndex)))
  const settlements = table('settledResultsByEventSeq', isCanonicalSequence, settlement => fields(settlement,
    ['call', 'entry', 'identity', 'publication', 'observedIndex', 'ordinary', 'normalized'])
    && callEvent(settlement.call) && callEntry(settlement.entry)
    && optional(settlement.normalized, normalizedResult)
    && typeof settlement.ordinary === 'boolean'
    && isCanonicalSequence(settlement.observedIndex) && value.lastEventIndex !== null
    && settlement.observedIndex >= settlement.entry.eventIndex && settlement.observedIndex <= value.lastEventIndex
    && deepEqualJson(settlement.call, settlement.entry.event)
    && typeof settlement.identity === 'string' && /^[a-f0-9]{64}$/u.test(settlement.identity)
    && (!REPL_TOOL_NAMES.has(settlement.call.data.name)
      || deepEqualJson(executable.get(settlement.call.seq)?.event, settlement.call))
    && optional(settlement.publication, publication => fields(publication,
      ['index', 'journal', 'derived', 'userBindings', 'rewrites'])
      && deepEqualJson(publication.journal ?? null, settlement.normalized?.journal ?? null)
      && deepEqualJson(publication.derived ?? null, settlement.normalized?.derived ?? null)
      && deepEqualJson(publication.userBindings ?? null, settlement.normalized?.userBindings ?? null)
      && !settlement.entry.ambiguous && isCanonicalSequence(publication.index)
      && publication.index === (settlement.ordinary ? settlement.observedIndex : settlement.entry.eventIndex)
      && ((settlement.call.data.name === 'run_code' && publication.derived === undefined)
        || (settlement.call.data.name === 'edit_run_code'
        && publication.derived?.targetCallSeq === settlement.entry.editTarget?.callSeq
        && publication.derived !== undefined))
      && (publication.journal === undefined
        ? publication.derived === undefined && publication.userBindings === undefined
        : journalFacts(publication))
      && deepEqualJson(validatedRewrites({ [REWRITES_KEY]: publication.rewrites }) ?? null, publication.rewrites ?? null)))
  // Normalized event facts retain distinctions needed by the transition but
  // omit result content. Admission uses that same transition, not a second
  // partial interpretation of the materialized caches.
  requireFact(Array.isArray(value.eventFacts))
  let reconstructed = createSessionTimelineState()
  let correlationIndex = -1
  for (const observation of value.eventFacts) {
    requireFact(fields(observation, ['eventIndex', 'event', 'identity', 'hasJournal', 'normalized',
      'boundaries', 'boundaryFailure', 'rewrites'])
      && isCanonicalSequence(observation.eventIndex) && observation.eventIndex > correlationIndex
      && value.lastEventIndex !== null && observation.eventIndex <= value.lastEventIndex
      && isRecord(observation.event) && isCanonicalSequence(observation.event.seq)
      && ['turn/start', 'turn/end', RECOVERY_BOUNDARY_EVENT, 'compaction/prune', 'tool/call', 'tool/result']
        .includes(observation.event.type)
      && deepEqualJson(correlationEvent(observation.event), observation.event)
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
    reconstructed = replaySessionTimelineFact(reconstructed, observation)
  }
  requireFact(deepEqualJson(reconstructed, value))
  for (const observation of ordinaryObservations.values()) {
    const settlement = settlements.get(observation.eventSeq)
    requireFact(settlement !== undefined
      ? settlement.ordinary && settlement.observedIndex === observation.eventIndex
        && deepEqualJson(settlement.call, observation.call)
      : value.runSelectionHistory.some(frontier => frontier.index === observation.eventIndex
        && frontier.reason === 'result-identity-mismatch'))
  }
  for (const settlement of settlements.values()) {
    if (!settlement.ordinary) continue
    const observation = ordinaryObservations.get(settlement.call.seq)
    requireFact(observation !== undefined && observation.eventIndex === settlement.observedIndex
      && deepEqualJson(observation.call, settlement.call))
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
      dispatchRun = selectSettlementRun(dispatchRun, settlement, dispatchScope, dispatchFrontier)
    }
  }
  requireFact(claimed.size === dispatchClaims.size && [...dispatchClaims].every(seq => claimed.has(seq)))
  requireFact(edits.size === dispatchEdits.size && [...dispatchEdits].every(([seq, targetSeq]) => edits.get(seq) === targetSeq))
  let selectedRun
  let lastSuccessfulRunIndex
  for (const settlement of publications) {
    selectedRun = selectSettlementRun(selectedRun, settlement, value.scope, value.runSelectionFrontier)
    if (successfulTimelineRun(settlementRun(settlement))) {
      lastSuccessfulRunIndex = Math.max(lastSuccessfulRunIndex ?? -1, settlement.publication.index)
    }
  }
  requireFact(selectedRun === undefined || (executable.get(selectedRun.callSeq)?.scope === value.scope
    && !executable.get(selectedRun.callSeq).ambiguous))
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
export function replaySessionTimelineFact(previous, fact) {
  return advanceTimelineEvent(previous, fact.event, fact.eventIndex, fact)
}

function advanceTimelineEvent(previous, inputEvent, eventIndex, replayFact) {
  if (!['turn/start', 'turn/end', RECOVERY_BOUNDARY_EVENT, 'compaction/prune', 'tool/call', 'tool/result'].includes(inputEvent?.type)) {
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
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      const executable = REPL_TOOL_NAMES.has(event.data.name)
      let entry = { event: timelineCallEvent(event), eventIndex, scope }
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
        state.calls = [...state.calls, entry.event]
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
      ordinaryResultSeqs.set(callSeq, timelineJson({ call,
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
      } else {
        normalized = replayFact.normalized
        if (normalized === undefined || !deepEqualJson(raw, {
          eventSeq: normalized.eventSeq, eventIndex: normalized.eventIndex,
          ...(normalized.positionSeq === undefined ? {} : { positionSeq: normalized.positionSeq }),
        })) throw new TypeError('invalid PTC session-log projection timeline checkpoint result facts')
        if (replayFact.boundaries !== undefined) observation.boundaries = replayFact.boundaries
        if (replayFact.boundaryFailure !== undefined) observation.boundaryFailure = replayFact.boundaryFailure
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
    const settlement = call === undefined ? undefined : { call, entry, identity: observation.identity,
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
      }
    }
    if (settlement !== undefined && isCanonicalSequence(event.seq)) {
      settledResultsByEventSeq.set(event.seq, settlement)
    }

    const claimedTarget = editClaims.get(callSeq)
    if (claimedTarget !== undefined) {
      editClaims.delete(callSeq)
      if (normalized?.derived === undefined) claimedEditTargets.delete(claimedTarget)
    }
    if (entry === undefined || entry.scope !== scope) continue
    const publishRun = () => {
      const run = settlementRun(settlement)
      state.latestRun = selectSettlementRun(state.latestRun, settlement, scope, state.runSelectionFrontier)
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
  state.eventFacts[state.eventFacts.length - 1] = timelineJson(observation)
  return Object.fromEntries(Object.entries({ ...state,
    executableCalls: state.executableCalls.table, results: state.results.table, editTargets: state.editTargets.table,
    pendingByCallId: pendingByCallId.table, seenCallIds: seenCallIds.table,
    claimedEditTargets: claimedEditTargets.table, editClaims: editClaims.table,
    ordinaryResultSeqs: ordinaryResultSeqs.table, settledResultsByEventSeq: settledResultsByEventSeq.table,
    pruneReplacementWindow, scope,
  }).filter(([_key, value]) => value !== undefined))
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
