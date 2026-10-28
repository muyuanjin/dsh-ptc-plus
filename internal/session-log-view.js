import {
  advanceSessionTimeline, createSessionTimelineState, factDigest, replaySessionTimelineFact, withFullRetention,
  retentionSummaryOf, validateRetentionSummary, validateSessionTimelineState, admissionReplayBudget,
} from './session-journal-recovery.js'
import { isCanonicalSequence } from './session-journal.js'
import { advanceSessionSurface, readSessionLog, sessionEvents } from './session-events.js'
import { readRuntimeMessage } from './runtime-messages.js'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import { deepFreeze, isRecord } from './record-utils.js'
import { advanceRuntimeHistory, createRuntimeHistory } from './recovery-tips.js'

import { isHostRuntimeContextSource } from './message-sources.js'
const SYSTEM_PROMPT_CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** DSH's empty aggregate uses an exact owner marker without a snapshot form. */
export function systemPromptSnapshotSections(message) {
  const source = message?.source
  if (!isHostRuntimeContextSource(source)) return undefined
  if (source.form === undefined && Array.isArray(message.content) && message.content.length === 1
    && message.content[0]?.type === 'text' && message.content[0].text === SYSTEM_PROMPT_CLEARED) {
    return Object.freeze([])
  }
  if (source.form !== 'snapshot' || !Array.isArray(source.sections)) return undefined
  const names = new Set()
  const sections = []
  for (const section of source.sections) {
    if (section === null || typeof section !== 'object' || Array.isArray(section)
      || typeof section.name !== 'string' || section.name.length === 0
      || typeof section.text !== 'string' || names.has(section.name)) return undefined
    names.add(section.name)
    sections.push(Object.freeze({ name: section.name, text: section.text }))
  }
  return Object.freeze(sections)
}

function isContextStep(event) {
  return event?.type === 'request/header'
    || event?.type === 'assistant/message'
    || (event?.type === 'user/message' && event.data?.source?.kind === 'user')
}

const SESSION_LOG_PROJECTION_KEY = 'ptcPlusSessionLog'

function emptyLogState() {
  return { timeline: createSessionTimelineState(), contextStep: 0,
    runtimeHistory: createRuntimeHistory(), visibleRuntimeFacts: {},
    systemPromptSnapshots: [], ptcMessages: [], runtimeMessagesBySeq: {}, visibleRuntimeMessages: [], surfaceNodes: [], logFacts: [] }
}

/**
 * Digest fields are validated per fact against their own bytes, so the replay
 * comparison must ignore them: a v10 checkpoint has no digests and must still be
 * admissible (the host refolds on the version mismatch), while a v11 one has been
 * digest-checked already.
 */
function withoutFactDigests(state) {
  const facts = state.timeline.eventFacts
  if (!facts.some(fact => fact.digest !== undefined)) return state
  return { ...state, timeline: { ...state.timeline,
    eventFacts: facts.map(({ digest, ...rest }) => rest) } }
}

export function runtimeMessageFacts(records, initial = {}) {
  const facts = { ...initial }
  for (const record of records) {
    if (record.producer === 'aggregate') facts.aggregate = record
    else if (record.form === 'snapshot') facts.snapshot = record
    else if (record.form === 'catalog') facts.catalog = record
  }
  return facts
}

function presentationEvent(event) {
  const recognized = event?.type === 'user/message'
    && (systemPromptSnapshotSections(event.data) !== undefined || readRuntimeMessage(event.data) !== undefined)
  const data = recognized ? { source: event.data.source, content: event.data.content }
    : event?.type === 'user/message' && typeof event.data?.source?.kind === 'string'
      ? { source: { kind: event.data.source.kind } } : undefined
  return JSON.parse(JSON.stringify({ seq: event.seq, type: event.type,
    ...(data === undefined ? {} : { data }),
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
  }))
}

function applyLogEvent(state, event, index = event?.seq,
  timeline = advanceSessionTimeline(state.timeline, event, index)) {
  const sections = event?.type === 'user/message' ? systemPromptSnapshotSections(event.data) : undefined
  const ptc = event?.type === 'user/message' ? readRuntimeMessage(event.data) : undefined
  const contextStep = state.contextStep + (isContextStep(event) ? 1 : 0)
  const surfaceNodes = advanceSessionSurface(state.surfaceNodes, event)
  let visibleRuntimeMessages = state.visibleRuntimeMessages
  if (timeline === state.timeline && sections === undefined && ptc === undefined && contextStep === state.contextStep
    && surfaceNodes === state.surfaceNodes) return state
  const next = { ...state, timeline, contextStep,
    logFacts: [...state.logFacts, deepFreeze({ index, event: presentationEvent(event) })],
  }
  next.runtimeHistory = advanceRuntimeHistory(state.runtimeHistory, {
    sections, notice: ptc?.form === 'notice' ? ptc.name : undefined,
    snapshot: ptc?.form === 'snapshot', catalog: ptc?.form === 'catalog',
    index, contextStep: state.contextStep, lastSuccessfulRunIndex: timeline.lastSuccessfulRunIndex,
    resetSuccess: timeline.lastSuccessfulRunIndex !== state.timeline.lastSuccessfulRunIndex,
  })
  if (sections !== undefined) {
    const snapshot = Object.freeze({ index, contextStep: state.contextStep, sections })
    next.systemPromptSnapshots = [...state.systemPromptSnapshots, snapshot]
    next.runtimeMessagesBySeq = { ...state.runtimeMessagesBySeq,
      [`k${event.seq}`]: Object.freeze({ ...snapshot, producer: 'aggregate', form: 'snapshot' }) }
  }
  if (ptc !== undefined) {
    const record = Object.freeze({ ...ptc, index, contextStep: state.contextStep, producer: 'ptc-plus' })
    next.ptcMessages = [...state.ptcMessages, record]
    next.runtimeMessagesBySeq = { ...next.runtimeMessagesBySeq, [`k${event.seq}`]: record }
  }
  if (event?.surfaceOp === 'append') {
    const record = next.runtimeMessagesBySeq[`k${event.seq}`]
    if (record !== undefined) {
      visibleRuntimeMessages = [...visibleRuntimeMessages, record]
      next.visibleRuntimeFacts = runtimeMessageFacts([record], state.visibleRuntimeFacts)
    }
  } else if (surfaceNodes !== state.surfaceNodes) {
    visibleRuntimeMessages = surfaceNodes.flatMap(seq => {
      const record = next.runtimeMessagesBySeq[`k${seq}`]
      return record === undefined ? [] : [record]
    })
    next.visibleRuntimeFacts = runtimeMessageFacts(visibleRuntimeMessages)
  }
  next.surfaceNodes = surfaceNodes
  next.visibleRuntimeMessages = Object.freeze(visibleRuntimeMessages)
  return next
}

export function createSessionLogProjection(options = {}) {
  const replayBudget = admissionReplayBudget(options.replayBudgetBytes)
  return Object.freeze({
    key: SESSION_LOG_PROJECTION_KEY,
    stateVersion: 13,
    stateSchema: Object.freeze({ parse(value) {
      if (!isJsonValue(value) || !isRecord(value) || !isRecord(value.timeline)
        || typeof value.timeline.openTurn !== 'boolean' || typeof value.timeline.found !== 'boolean'
        || !Number.isSafeInteger(value.timeline.scope) || value.timeline.scope < 0
        || !Number.isSafeInteger(value.contextStep) || value.contextStep < 0
        || !Array.isArray(value.systemPromptSnapshots) || !Array.isArray(value.ptcMessages)
        || !Array.isArray(value.visibleRuntimeMessages)
        || !isRecord(value.runtimeHistory) || !isRecord(value.runtimeHistory.tips)
        || !isRecord(value.runtimeHistory.seenNames) || !isRecord(value.visibleRuntimeFacts)
        || !Array.isArray(value.surfaceNodes) || !value.surfaceNodes.every(isCanonicalSequence)
        || new Set(value.surfaceNodes).size !== value.surfaceNodes.length
        || !Array.isArray(value.timeline.calls) || !Array.isArray(value.timeline.boundaries)
        || !isRecord(value.runtimeMessagesBySeq) || !isRecord(value.timeline.cordisTranscript)) {
        throw new TypeError('invalid PTC session-log projection checkpoint')
      }
      if (!Array.isArray(value.logFacts)) throw new TypeError('invalid PTC session-log projection checkpoint facts')
      validateSessionTimelineState(value.timeline, value.logFacts, { replayBudgetBytes: replayBudget })
      // Admission proves digest-bound continuity and frontier agreement, not a
      // byte-for-byte replay equality of argument text. Replaying the whole log
      // here would cost the host a second fold of every event (and the retained
      // payloads make that fold proportional to everything the session wrote), so
      // this validates the identity chain the projection itself maintains:
      // ordered log facts whose indices agree with the timeline facts, each
      // timeline fact carrying a digest that matches the log fact it points at,
      // and a frontier that names the processed cut.
      let lastIndex = -1
      for (const fact of value.logFacts) {
        if (!isRecord(fact) || Object.keys(fact).some(key => !['index', 'event'].includes(key))
          || !isCanonicalSequence(fact.index) || fact.index <= lastIndex
          || !isRecord(fact.event) || !isCanonicalSequence(fact.event.seq) || typeof fact.event.type !== 'string'
          || !deepEqualJson(presentationEvent(fact.event), fact.event)) {
          throw new TypeError('invalid PTC session-log projection checkpoint facts')
        }
        lastIndex = fact.index
      }
      // Strictly increasing indices are what makes this index one-to-one, so a
      // duplicate cannot reach the identity loop below. The per-fact digest is
      // already required by `validateSessionTimelineState` above, which reads the
      // same equality from the same facts.
      const factsByIndex = new Map(value.logFacts.map(fact => [fact.index, fact]))
      for (const timelineFact of value.timeline.eventFacts) {
        const logFact = factsByIndex.get(timelineFact.eventIndex)
        if (logFact === undefined) {
          throw new TypeError('inconsistent PTC session-log projection checkpoint event identity')
        }
        if (logFact.event.seq !== timelineFact.event.seq || logFact.event.type !== timelineFact.event.type) {
          throw new TypeError('inconsistent PTC session-log projection checkpoint event identity')
        }
      }
      // Replay is the strongest admission check, but replaying every fact costs a
      // second fold whose payload is proportional to everything the session wrote.
      // Admission therefore replays while the retained payload stays inside the
      // budget and falls back to the identity chain above (ordered facts, per-fact
      // digests, frontier agreement) beyond it. Small checkpoints keep the full
      // byte-for-byte proof; large ones prove digest-bound continuity instead.
      // Admission proves digest-bound continuity and frontier agreement, not a
      // byte-for-byte replay equality of argument text: replay runs only while the
      // retained payload stays inside a fixed budget, and every retained fact
      // carries a digest over its own bytes, so beyond that budget a payload edit
      // is still rejected without folding the whole session a second time.
      const summaryPresent = retentionSummaryOf(value.timeline) !== undefined
      // A compacted checkpoint dropped whole clusters, so replaying the log can no
      // longer reach the stored state. Admission proves the summary instead (below)
      // and skips the replay entirely: it is both impossible to satisfy and the
      // most expensive thing this file does.
      const timelineFacts = new Map(value.timeline.eventFacts.map(fact => [fact.eventIndex, fact]))
      let replayBytes = 0
      let replayComplete = true
      let reconstructed = emptyLogState()
      for (const fact of summaryPresent ? [] : value.logFacts) {
        const timelineFact = timelineFacts.get(fact.index)
        if (timelineFact === undefined) {
          if (advanceSessionTimeline(reconstructed.timeline, fact.event, fact.index) !== reconstructed.timeline) {
            throw new TypeError('inconsistent PTC session-log projection checkpoint missing timeline facts')
          }
        } else {
          replayBytes += factDigest(timelineFact.event).length * 4
          if (replayBytes > replayBudget) {
            replayComplete = false
            continue
          }
        }
        const timeline = timelineFact === undefined ? reconstructed.timeline
          : replaySessionTimelineFact(reconstructed.timeline, timelineFact, value.timeline.executableCalls)
        reconstructed = applyLogEvent(reconstructed, fact.event, fact.index, timeline)
      }
      // A compacted checkpoint cannot be compared with the fold that produced it:
      // the payload it dropped is gone from its own side. Admission proves the cut
      // instead (below it stubs, at or above it text), which is the weaker, stated
      // claim for compacted states. Non-compacted states keep the full comparison.
      const summary = retentionSummaryOf(value.timeline)
      if (summary === undefined) {
        if (replayComplete && !deepEqualJson(withoutFactDigests(reconstructed), withoutFactDigests(value))) {
          throw new TypeError('inconsistent PTC session-log projection checkpoint facts')
        }
      } else {
        // A compacted checkpoint dropped its old clusters, so replay can never
        // reproduce it. Admission proves the summary instead: the retained window is
        // contiguous with the boundary, nothing below it survives, and the chain is
        // recomputed from the logged dropped range so the summary cannot certify
        // itself.
        // A compacted checkpoint cannot prove its chain from its own state: the fold
        // that dropped the clusters also dropped the observations, and `logFacts`
        // hold presentation facts only. Admission claims the boundary and range here;
        // callers that hold the raw log verify the chain with
        // `verifyRetentionSummaryAgainstEvents`.
        validateRetentionSummary(value.timeline, summary)
      }
      return deepFreeze(value)
    } }),
    init: emptyLogState,
    apply: applyLogEvent,
  })
}

/**
 * The disposer a session projection registration handed back.
 *
 * Two registration contracts are published: an earlier host returns a disposer and a
 * newer one returns a `ProjectionHandle` (`stateOf`/`readerFor`/`dispose`, possibly
 * async). Every projection this plugin registers goes through this reader, because a
 * registration that only understands the earlier shape drops the projection — and
 * with it the fact that the host accepted it — on the newer contract.
 * @param {unknown} registration - what `sessionProjections.register` returned.
 * @returns {(() => unknown)|undefined} the release call, or undefined when the answer
 *   names neither contract.
 */
export function projectionRegistrationDisposer(registration) {
  if (typeof registration === 'function') return () => registration()
  if (typeof registration?.dispose === 'function') return () => registration.dispose()
  return undefined
}

export function createSessionLogOwner(ctx) {
  const projection = createSessionLogProjection()
  let registeredService
  const injection = ctx.inject(['sessionProjections'], scope => {
    try {
      scope.effect(() => {
        const registry = scope.sessionProjections
        const unregister = projectionRegistrationDisposer(registry.register(projection))
        if (unregister === undefined) {
          throw new Error('ptc-plus: sessionProjections.register returned neither a disposer nor a handle')
        }
        registeredService = registry
        return async () => {
          await unregister()
          if (registeredService === registry) registeredService = undefined
        }
      }, 'ptc-plus host-only session-log projection')
    } catch (error) {
      ctx.logger?.warn?.('ptc-plus: session-log projection unavailable', error)
    }
  })
  ctx.effect(() => () => typeof injection === 'function' ? injection() : injection?.dispose?.(),
    'ptc-plus session-log projection injection lifecycle')
  const service = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  return Object.freeze({
    read: (session, signal) => readSessionLog(session, service('sessionQuery'), signal),
    project(agent, requestedEdit) {
      if (Array.isArray(agent?.session?.events)) return projectSessionLog(agent, requestedEdit)
      const registry = registeredService ?? service('sessionProjections')
      const state = agent?.session === undefined ? undefined : registry?.stateOf?.(agent.session, SESSION_LOG_PROJECTION_KEY)
      return projectSessionLog(agent, requestedEdit, state)
    },
  })
}

/** Project session events into immutable facts consumed by prompt presentation. */
export function projectSessionLog(agent, requestedEdit, projectedState, options = {}) {
  const events = projectedState === undefined ? sessionEvents(agent?.session) : undefined
  if (projectedState === undefined && !Array.isArray(events)) {
    return Object.freeze({
      openTurn: false,
      contextStep: 0,
      systemPromptSnapshots: Object.freeze([]),
      ptcMessages: Object.freeze([]),
      visibleRuntimeMessages: undefined,
      runtimeHistory: Object.freeze(createRuntimeHistory()),
      lastSuccessfulRunIndex: undefined,
      latestRun: undefined,
      editableRun: undefined,
      repairSource: undefined,
      cordisTranscript: Object.freeze({ calls: 0, inspections: 0 }),
    })
  }
  let state = projectedState ?? emptyLogState()
  if (projectedState === undefined) {
    const fold = () => {
      for (let index = 0; index < events.length; index += 1) state = applyLogEvent(state, events[index], index)
    }
    // A consumer that needs a dropped cluster refolds the same slice with pruning
    // disabled; the checkpointed state never carries the flag.
    if (options.retainAll === true) withFullRetention(fold)
    else fold()
  }
  const { timeline, contextStep, systemPromptSnapshots, ptcMessages, runtimeMessagesBySeq } = state
  const requestedEntry = requestedEdit === undefined
    ? undefined
    : timeline.executableCalls[`k${requestedEdit.callSeq}`]?.[1]
  const requestedEditTarget = requestedEdit !== undefined
    && requestedEntry?.event.data?.callId === requestedEdit.callId
    && requestedEntry.event.data.name === 'edit_run_code'
    ? timeline.editTargets[`k${requestedEdit.callSeq}`]?.[1] ?? undefined
    : undefined
  const latestRun = timeline.openTurn ? timeline.latestRun : undefined
  const editableRun = timeline.openTurn ? timeline.editableRun : undefined
  const cordisTranscript = Object.freeze(timeline.cordisTranscript)
  let visibleRuntimeMessages = projectedState === undefined ? undefined : state.visibleRuntimeMessages
  if (projectedState === undefined) try {
    const nodes = agent?.session?.surface?.nodes
    // `events` is an array here: the caller either passed a projected state or
    // sessionEvents produced one, so the undefined arm could never run.
    const knownSeqs = new Set(events.map(event => event?.seq))
    if (Array.isArray(nodes) && nodes.every(seq => isCanonicalSequence(seq) && knownSeqs.has(seq))) {
      visibleRuntimeMessages = Object.freeze(nodes.flatMap(seq => {
        const record = runtimeMessagesBySeq[`k${seq}`]
        return record === undefined ? [] : [record]
      }))
    }
  } catch {}
  return Object.freeze({
    openTurn: timeline.openTurn,
    contextStep,
    systemPromptSnapshots: Object.freeze(systemPromptSnapshots),
    ptcMessages: Object.freeze(ptcMessages),
    visibleRuntimeMessages,
    visibleRuntimeFacts: projectedState === undefined && visibleRuntimeMessages !== undefined
      ? runtimeMessageFacts(visibleRuntimeMessages) : state.visibleRuntimeFacts,
    runtimeHistory: state.runtimeHistory,
    lastSuccessfulRunIndex: timeline.lastSuccessfulRunIndex,
    latestRun,
    editableRun,
    repairSource: editableRun?.source,
    cordisTranscript,
    retentionSummary: timeline.retentionSummary ?? undefined,
    // Consumers must be able to tell "the newest cell was dropped for budget" from
    // "there never was a cell"; both would otherwise look like an undefined run.
    hotCellDropped: timeline.hotCellDropped === true,
    ...(requestedEdit === undefined ? {} : { requestedEditTarget }),
  })
}

/** Return the target snapshot captured at one persisted edit call event. */
export function editTargetForCall(agent, callId, callSeq) {
  if (typeof callId !== 'string' || callId.length === 0
    || !isCanonicalSequence(callSeq)) return undefined
  return projectSessionLog(agent, { callId, callSeq }).requestedEditTarget
}
