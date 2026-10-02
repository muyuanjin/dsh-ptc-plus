import {
  advanceSessionTimeline, createSessionTimelineState, replaySessionTimelineFact, validateSessionTimelineState,
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

export const SESSION_LOG_PROJECTION_KEY = 'ptcPlusSessionLog'

function emptyLogState() {
  return { timeline: createSessionTimelineState(), contextStep: 0,
    runtimeHistory: createRuntimeHistory(), visibleRuntimeFacts: {},
    systemPromptSnapshots: [], ptcMessages: [], runtimeMessagesBySeq: {}, visibleRuntimeMessages: [], surfaceNodes: [], logFacts: [] }
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

export function createSessionLogProjection() {
  return Object.freeze({
    key: SESSION_LOG_PROJECTION_KEY,
    stateVersion: 8,
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
      validateSessionTimelineState(value.timeline)
      if (!Array.isArray(value.logFacts)) throw new TypeError('invalid PTC session-log projection checkpoint facts')
      const timelineFacts = new Map(value.timeline.eventFacts.map(fact => [fact.eventIndex, fact]))
      let reconstructed = emptyLogState()
      let lastIndex = -1
      let timelineCount = 0
      for (const fact of value.logFacts) {
        if (!isRecord(fact) || Object.keys(fact).some(key => !['index', 'event'].includes(key))
          || !isCanonicalSequence(fact.index) || fact.index <= lastIndex
          || !isRecord(fact.event) || !isCanonicalSequence(fact.event.seq) || typeof fact.event.type !== 'string'
          || !deepEqualJson(presentationEvent(fact.event), fact.event)) {
          throw new TypeError('invalid PTC session-log projection checkpoint facts')
        }
        lastIndex = fact.index
        const timelineFact = timelineFacts.get(fact.index)
        if (timelineFact !== undefined) {
          if (!deepEqualJson(presentationEvent(timelineFact.event), fact.event)) {
            throw new TypeError('inconsistent PTC session-log projection checkpoint event identity')
          }
          timelineCount += 1
        }
        if (timelineFact === undefined
          && advanceSessionTimeline(reconstructed.timeline, fact.event, fact.index) !== reconstructed.timeline) {
          throw new TypeError('inconsistent PTC session-log projection checkpoint missing timeline facts')
        }
        const timeline = timelineFact === undefined ? reconstructed.timeline
          : replaySessionTimelineFact(reconstructed.timeline, timelineFact)
        reconstructed = applyLogEvent(reconstructed, fact.event, fact.index, timeline)
      }
      if (timelineCount !== timelineFacts.size || !deepEqualJson(reconstructed, value)) {
        throw new TypeError('inconsistent PTC session-log projection checkpoint facts')
      }
      return deepFreeze(value)
    } }),
    init: emptyLogState,
    apply: applyLogEvent,
  })
}

export function createSessionLogOwner(ctx) {
  const projection = createSessionLogProjection()
  let registeredService
  const injection = ctx.inject(['sessionProjections'], scope => {
    try {
      scope.effect(() => {
        const registry = scope.sessionProjections
        const unregister = registry.register(projection)
        if (typeof unregister !== 'function') throw new Error('ptc-plus: sessionProjections.register did not return a disposer')
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
export function projectSessionLog(agent, requestedEdit, projectedState) {
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
    for (let index = 0; index < events.length; index += 1) state = applyLogEvent(state, events[index], index)
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
    const knownSeqs = events === undefined ? undefined : new Set(events.map(event => event?.seq))
    if (Array.isArray(nodes) && nodes.every(seq => isCanonicalSequence(seq)
      && (knownSeqs === undefined ? seq < agent.session.seq : knownSeqs.has(seq)))) {
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
    ...(requestedEdit === undefined ? {} : { requestedEditTarget }),
  })
}

/** Return the target snapshot captured at one persisted edit call event. */
export function editTargetForCall(agent, callId, callSeq) {
  if (typeof callId !== 'string' || callId.length === 0
    || !isCanonicalSequence(callSeq)) return undefined
  return projectSessionLog(agent, { callId, callSeq }).requestedEditTarget
}
