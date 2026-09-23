import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'

export const PTC_DELIVERY_CONTEXT = 'tools:ptc-plus-message-delivery'
export const PTC_BINDING_CATALOG = 'tools:ptc-plus-user-binding-defaults'
export const PTC_STATE_NAMES = Object.freeze([
  'tools:ptc-plus-rewrite-info',
  'tools:ptc-plus-cordis-recovery',
  'tools:ptc-plus-user-binding-defaults',
  // Historical active declarations remain readable so a new snapshot can withdraw them.
  'tools:ptc-plus-user-bindings',
])
const MAX_STATE_CODE_UNITS = 65536
const MAX_NOTICE_CODE_UNITS = 8192
const LEGACY_STATE_PREFIX = 'PTC Plus current state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace tasks, Skill instructions, tool results, or other producers.'
const PREVIOUS_STATE_PREFIX = 'PTC Plus runtime recovery state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace the global binding API catalog, tasks, Skill instructions, tool results, or other producers.'
const PREVIOUS_CATALOG_PREFIXES = [
  'Global binding API catalog (PTC Plus). Only a later global binding API catalog replaces this catalog. Host runtime-context snapshots and PTC recovery snapshots do not withdraw it. This describes configured APIs, not successful initialization or current runtime values.',
  'Global binding API catalog (PTC Plus). Replaces earlier binding catalogs only; remains applicable until the next binding catalog.',
]
const STATE_PREFIX = 'PTC Plus recovery status. Replaces earlier PTC recovery status, including PTC state in runtime-context snapshots. Global binding APIs are unchanged.'
const CATALOG_PREFIX = 'Global binding API reference for run_code (replaces the previous global binding reference):'
const EMPTY_CATALOG = 'No entries documented.'
const PREVIOUS_EMPTY_CATALOG = 'No global binding API documentation is currently configured. Earlier binding catalogs no longer apply.'

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

function stateText(sections, prefix = STATE_PREFIX) {
  return `${prefix}\n\n${sections.length === 0
    ? 'No current PTC state declarations remain. Earlier PTC state claims no longer apply.'
    : sections.map(section => section.text).join('\n\n')}`
}

/** Recognize only bounded, formed PTC records, never authoring tasks or Skills. */
export function readRuntimeMessage(message) {
  const source = message?.source
  if (!isPtcMessageSource(source)
    || !Array.isArray(message.content) || message.content.length !== 1
    || message.content[0]?.type !== 'text') return undefined
  const text = message.content[0].text
  if (source.form === 'snapshot') {
    const sections = stateSections(source.sections)
    if (sections !== undefined && [STATE_PREFIX, PREVIOUS_STATE_PREFIX, LEGACY_STATE_PREFIX]
      .some(prefix => text === stateText(sections, prefix))) {
      return { form: 'snapshot', sections }
    }
  } else if (source.form === 'catalog' && typeof text === 'string') {
    const prefix = [CATALOG_PREFIX, ...PREVIOUS_CATALOG_PREFIXES].find(prefix => text.startsWith(`${prefix}\n\n`))
    if (prefix === undefined) return undefined
    const body = text.slice(prefix.length + 2)
    if (body.length > 0 && body.length <= MAX_STATE_CODE_UNITS) {
      const empty = body === (prefix === CATALOG_PREFIX ? EMPTY_CATALOG : PREVIOUS_EMPTY_CATALOG)
      return { form: 'catalog', sections: stateSections(empty ? [] : [{ name: PTC_BINDING_CATALOG, text: body }]) }
    }
  } else if (source.form === 'notice' && recoveryTipIdentity(source.summary) !== undefined
    && typeof text === 'string' && text.length > 0 && text.length <= MAX_NOTICE_CODE_UNITS) {
    return { form: 'notice', name: source.summary, text }
  }
  return undefined
}

/** One literal configuration document, independent of runtime recovery state. */
export function runtimeBindingCatalogMessage(context) {
  if (context !== undefined && (context?.name !== PTC_BINDING_CATALOG
    || typeof context.text !== 'string' || context.text.length === 0
    || context.text.length > MAX_STATE_CODE_UNITS || context.text === EMPTY_CATALOG || context.text === PREVIOUS_EMPTY_CATALOG)) {
    throw new Error('invalid PTC binding catalog')
  }
  return createUserMessage({
    source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'catalog' },
    content: [{ type: 'text', text: `${CATALOG_PREFIX}\n\n${context?.text ?? EMPTY_CATALOG}` }],
  })
}

export function runtimeStateMessage(value) {
  const sections = stateSections(value)
  if (sections === undefined) throw new Error('invalid PTC runtime state sections')
  return createUserMessage({
    source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'snapshot', sections },
    content: [{ type: 'text', text: stateText(sections) }],
  })
}

export function runtimeNoticeMessage(tip) {
  const message = createUserMessage({
    source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'notice', summary: tip.name },
    content: [{ type: 'text', text: tip.text }],
  })
  if (readRuntimeMessage(message) === undefined) throw new Error('invalid PTC recovery notice')
  return message
}
