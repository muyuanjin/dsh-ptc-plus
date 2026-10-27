import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  CATALOG_PREFIX, EMPTY_CATALOG, LEGACY_STATE_PREFIX, PREVIOUS_EMPTY_CATALOG, PREVIOUS_STATE_PREFIX,
  PROMPT_SLOT_IDS, PROMPT_TEXT_DEFAULT, STATE_PREFIX, resolvePromptText,
} from './prompt-text.js'

import { isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
import { BINDING_ADOPTION_FORM, readBindingAdoption } from './binding-adoption.js'

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

const PREVIOUS_CATALOG_PREFIXES = [
  'Global binding API catalog (PTC Plus). Only a later global binding API catalog replaces this catalog. Host runtime-context snapshots and PTC recovery snapshots do not withdraw it. This describes configured APIs, not successful initialization or current runtime values.',
  'Global binding API catalog (PTC Plus). Replaces earlier binding catalogs only; remains applicable until the next binding catalog.',
]

const AVAILABILITY_TEXT = Object.freeze({
  active: 'PTC Plus is the current continuous-computation provider. Follow its current tool schemas and capability plan; earlier withdrawals do not restore old computation state.',
  disabled: 'PTC Plus is disabled. Earlier PTC Plus continuous-computation instructions, capability plans, discovery instructions, calling-contract disclosures and global binding references no longer describe the current runtime. Use the current Host tools and contracts. Historical computations and effects remain historical; no old PTC Plus heap has been restored. Tasks, Skill instructions, other producers and tool results are unchanged.',
  unloaded: 'PTC Plus has released its computation provider. Earlier PTC Plus continuous-computation instructions, capability plans, discovery instructions, calling-contract disclosures and global binding references no longer describe the current runtime. Use the current Host tools and contracts. Historical computations and effects remain historical; no old PTC Plus heap has been restored. Tasks, Skill instructions, other producers and tool results are unchanged.',
})

// Historical wording stays readable so recorded sessions keep their provenance;
// new messages use the current text above.
const PREVIOUS_AVAILABILITY_TEXT = Object.freeze({
  active: ['PTC Plus is the current continuous-computation provider. Follow its current tool schemas and newly supplied capability plan; earlier withdrawals do not restore old computation state.'],
})

export function runtimeAvailabilityMessage(state) {
  if (!Object.hasOwn(AVAILABILITY_TEXT, state)) throw new TypeError('invalid PTC provider availability')
  return createUserMessage({ source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'runtime-availability', state },
    content: [{ type: 'text', text: AVAILABILITY_TEXT[state] }] })
}

export function readRuntimeAvailability(message) {
  const state = message?.source?.state
  if (!isPtcMessageSource(message?.source) || message.source.form !== 'runtime-availability'
    || !Object.hasOwn(AVAILABILITY_TEXT, state) || message.content?.length !== 1
    || message.content[0]?.type !== 'text') return undefined
  const text = message.content[0].text
  return text === AVAILABILITY_TEXT[state]
    || (PREVIOUS_AVAILABILITY_TEXT[state] ?? []).includes(text) ? state : undefined
}

/** Availability reconciles plugin declarations only, never tasks or other producers. */
export function projectRuntimeAvailability(messages, active, computationDeclared = false) {
  const last = messages.map(readRuntimeAvailability).filter(Boolean).at(-1)
  if (active) return last && last !== 'active' ? runtimeAvailabilityMessage('active') : undefined
  if (last === 'disabled' || last === 'unloaded') return undefined
  const declared = computationDeclared || last === 'active' || messages.some(message => {
    const recognized = isPtcMessageSource(message?.source) ? readRuntimeMessage(message) : undefined
    return isPtcMessageSource(message?.source)
      && (['capability-navigation', 'capability-descriptions', 'capability-contracts'].includes(message.source.form)
        || message.source.form === 'capability-plan' && message.source.snapshot?.plan?.enabled === true
        || recognized?.form === 'catalog' && recognized.sections.length > 0)
  })
  return declared ? runtimeAvailabilityMessage('disabled') : undefined
}

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

/**
 * Historical emptiness wording a recorded catalog may carry.
 *
 * These are code-owned constants, not the resolved document: a session record
 * written by an older build must stay readable after today's sentence changes,
 * and recognizing it must never depend on the user's current override.
 */
const HISTORICAL_EMPTY_CATALOGS = Object.freeze([EMPTY_CATALOG, PREVIOUS_EMPTY_CATALOG])

/** The resolved document a producer used. Recognition never depends on its text. */
const promptOf = prompt => prompt ?? resolvePromptText(PROMPT_TEXT_DEFAULT)

/** Recognize only bounded, formed PTC records, never authoring tasks or Skills. */
export function readRuntimeMessage(message) {
  const source = message?.source
  if (!isPtcMessageSource(source)
    || !Array.isArray(message.content) || message.content.length !== 1
    || message.content[0]?.type !== 'text') return undefined
  const text = message.content[0].text
  const availability = readRuntimeAvailability(message)
  if (availability !== undefined) return { form: 'runtime-availability', state: availability }
  // A session's binding adoption is recorded as one of its own messages, so the
  // log is its only owner and replay reconstructs it without process memory.
  const adoption = readBindingAdoption(message)
  if (adoption !== undefined) return { form: BINDING_ADOPTION_FORM, declined: [...adoption.declined] }
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
      // Emptiness is a property of the record (`source.empty`), so live delivery
      // and log replay agree even when the empty sentence is customized. Records
      // written before that flag existed are matched against the code-owned
      // historical wording, never against the current resolved text.
      const empty = source.empty === true
        || (source.empty === undefined && HISTORICAL_EMPTY_CATALOGS.includes(body))
      return { form: 'catalog', sections: stateSections(empty ? [] : [{ name: PTC_BINDING_CATALOG, text: body }]) }
    }
  } else if (source.form === 'notice' && recoveryTipIdentity(source.summary) !== undefined
    && typeof text === 'string' && text.length > 0 && text.length <= MAX_NOTICE_CODE_UNITS) {
    return { form: 'notice', name: source.summary, text }
  }
  return undefined
}

/** One literal configuration document, independent of runtime recovery state. */
export function runtimeBindingCatalogMessage(context, options) {
  const resolved = promptOf(options?.prompt)
  const catalogPrefix = resolved.text(PROMPT_SLOT_IDS.catalogPrefix)
  const emptyCatalog = resolved.text(PROMPT_SLOT_IDS.catalogEmpty)
  // Emptiness travels in `source.empty`, so a catalog body may legitimately equal
  // the code-owned empty wording; comparing the text would abort the whole step for
  // a deliverable catalog. Only the shape is rejected here.
  if (context !== undefined && (context?.name !== PTC_BINDING_CATALOG
    || typeof context.text !== 'string' || context.text.length === 0
    || context.text.length > MAX_STATE_CODE_UNITS)) {
    throw new Error('invalid PTC binding catalog')
  }
  return createUserMessage({
    // `empty` records the fact itself, so replay recognizes an empty catalog from
    // the record instead of comparing it against today's sentence.
    source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'catalog', empty: context === undefined },
    content: [{ type: 'text', text: `${catalogPrefix}\n\n${context?.text ?? emptyCatalog}` }],
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
