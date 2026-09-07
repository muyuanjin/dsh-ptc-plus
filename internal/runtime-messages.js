import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const PTC_DELIVERY_CONTEXT = 'tools:ptc-plus-message-delivery'
export const PTC_STATE_NAMES = Object.freeze([
  'tools:ptc-plus-rewrite-info',
  'tools:ptc-plus-cordis-recovery',
  'tools:ptc-plus-user-binding-defaults',
  'tools:ptc-plus-user-bindings',
])
const MAX_STATE_CODE_UNITS = 65536
const MAX_NOTICE_CODE_UNITS = 8192
const STATE_PREFIX = 'PTC Plus current state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace tasks, Skill instructions, tool results, or other producers.'

export function recoveryTipIdentity(name) {
  if (typeof name !== 'string') return undefined
  const match = /^tools:ptc-plus-tip\/(repeated-binding-failure|platform-command-failure)\/([1-9][0-9]*)$/.exec(name)
  if (match === null || !Number.isSafeInteger(Number(match[2]))) return undefined
  return { id: match[1], ordinal: Number(match[2]) }
}

function stateSections(value) {
  if (!Array.isArray(value) || value.length > PTC_STATE_NAMES.length) return undefined
  const sections = []
  const names = new Set()
  let size = 0
  for (const section of value) {
    if (!PTC_STATE_NAMES.includes(section?.name) || names.has(section.name)
      || typeof section.text !== 'string' || section.text.length === 0) return undefined
    size += section.text.length
    if (size > MAX_STATE_CODE_UNITS) return undefined
    names.add(section.name)
    sections.push(Object.freeze({ name: section.name, text: section.text }))
  }
  return Object.freeze(sections)
}

function stateText(sections) {
  return `${STATE_PREFIX}\n\n${sections.length === 0
    ? 'No current PTC state declarations remain. Earlier PTC state claims no longer apply.'
    : sections.map(section => section.text).join('\n\n')}`
}

/** Recognize only bounded, formed PTC records, never authoring tasks or Skills. */
export function readRuntimeMessage(message) {
  const source = message?.source
  if (source?.kind !== 'plugin' || source.plugin !== 'ptc-plus'
    || !Array.isArray(message.content) || message.content.length !== 1
    || message.content[0]?.type !== 'text') return undefined
  const text = message.content[0].text
  if (source.form === 'snapshot') {
    const sections = stateSections(source.sections)
    if (sections !== undefined && text === stateText(sections)) return { form: 'snapshot', sections }
  } else if (source.form === 'notice' && recoveryTipIdentity(source.summary) !== undefined
    && typeof text === 'string' && text.length > 0 && text.length <= MAX_NOTICE_CODE_UNITS) {
    return { form: 'notice', name: source.summary, text }
  }
  return undefined
}

export function runtimeStateMessage(value) {
  const sections = stateSections(value)
  if (sections === undefined) throw new Error('invalid PTC runtime state sections')
  return createUserMessage({
    source: { kind: 'plugin', plugin: 'ptc-plus', form: 'snapshot', sections },
    content: [{ type: 'text', text: stateText(sections) }],
  })
}

export function runtimeNoticeMessage(tip) {
  const message = createUserMessage({
    source: { kind: 'plugin', plugin: 'ptc-plus', form: 'notice', summary: tip.name },
    content: [{ type: 'text', text: tip.text }],
  })
  if (readRuntimeMessage(message) === undefined) throw new Error('invalid PTC recovery notice')
  return message
}
