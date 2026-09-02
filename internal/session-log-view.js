import {
  foldSessionTimeline,
} from './session-journal.js'
import { sessionEvents } from './session-events.js'

const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

function systemPromptSnapshot(event, index, contextStep) {
  const source = event?.data?.source
  if (event?.type !== 'user/message' || source?.kind !== 'plugin'
    || source.plugin !== SYSTEM_PROMPT_PLUGIN || source.form !== 'snapshot'
    || !Array.isArray(source.sections)) return undefined
  const names = new Set()
  const sections = []
  for (const section of source.sections) {
    if (section === null || typeof section !== 'object' || Array.isArray(section)
      || typeof section.name !== 'string' || section.name.length === 0
      || typeof section.text !== 'string' || names.has(section.name)) return undefined
    names.add(section.name)
    sections.push(Object.freeze({ name: section.name, text: section.text }))
  }
  return Object.freeze({ index, contextStep, sections: Object.freeze(sections) })
}

function isContextStep(event) {
  return event?.type === 'request/header'
    || event?.type === 'assistant/message'
    || (event?.type === 'user/message' && event.data?.source?.kind === 'user')
}

function cordisTranscriptFacts(timeline) {
  let calls = 0
  let inspections = 0
  for (const result of timeline.results.values()) {
    for (const call of result?.journal?.calls ?? []) {
      if (call.global !== 'tools' || typeof call.member !== 'string'
        || !call.member.startsWith('cordis_')) continue
      calls += 1
      if (call.ok === true && call.member.startsWith('cordis_inspect')) inspections += 1
    }
  }
  return Object.freeze({ calls, inspections })
}

/** Project session events into immutable facts consumed by prompt presentation. */
export function projectSessionLog(agent, requestedEdit) {
  const events = sessionEvents(agent?.session)
  if (!Array.isArray(events)) {
    return Object.freeze({
      openTurn: false,
      contextStep: 0,
      systemPromptSnapshots: Object.freeze([]),
      lastSuccessfulRunIndex: undefined,
      latestRun: undefined,
      editableRun: undefined,
      repairSource: undefined,
      cordisTranscript: Object.freeze({ calls: 0, inspections: 0 }),
    })
  }
  let contextStep = 0
  const systemPromptSnapshots = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const snapshot = systemPromptSnapshot(event, index, contextStep)
    if (snapshot !== undefined) systemPromptSnapshots.push(snapshot)
    if (isContextStep(event)) contextStep += 1
  }
  const timeline = foldSessionTimeline(events)
  const requestedEntry = requestedEdit === undefined
    ? undefined
    : timeline.executableCalls.get(requestedEdit.callSeq)
  const requestedEditTarget = requestedEdit !== undefined
    && requestedEntry?.event.data?.callId === requestedEdit.callId
    && requestedEntry.event.data.name === 'edit_run_code'
    ? timeline.editTargets.get(requestedEdit.callSeq)
    : undefined
  const latestRun = timeline.openTurn ? timeline.latestRun : undefined
  const editableRun = timeline.openTurn ? timeline.editableRun : undefined
  const cordisTranscript = cordisTranscriptFacts(timeline)
  return Object.freeze({
    openTurn: timeline.openTurn,
    contextStep,
    systemPromptSnapshots: Object.freeze(systemPromptSnapshots),
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
    || !Number.isSafeInteger(callSeq) || callSeq < 0) return undefined
  return projectSessionLog(agent, { callId, callSeq }).requestedEditTarget
}
