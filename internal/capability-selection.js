import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
import { CAPABILITY_DISCLOSURES } from './capability-policy.js'

/**
 * Session capability choices: the capability decisions this session recorded.
 *
 * The panel states two different facts side by side. The saved column answers
 * "what does the global configuration say", and this record answers "what did
 * this session decide". Keeping them apart is what lets a session state a choice
 * while the global configuration still reads as it did: neither answer is
 * derived from the other, and neither needs a session runtime.
 *
 * Three states, one question: no record (`none`) means the session inherits the
 * saved column; a readable newest record (`decided`) is that session's own
 * answer; a newest record this build cannot parse (`unreadable`) supersedes the
 * readable ones before it, so no consumer may answer from an older record in its
 * place. The third state is a fact about that record, not a state of the panel:
 * every row it touches keeps its control, and recording a new decision replaces
 * it.
 *
 * A choice never claims supply. It names an entry by id and never adds or
 * restores a row, because the row it applies to exists only while the host
 * declares that entry. A record may therefore outlive the declaration it was
 * written for: the session keeps its decision, the catalogue stops offering the
 * row, and nothing reads the record as a supply. `change()` asks this module's
 * vocabulary before it appends, so a decision about an entry this vocabulary
 * cannot name never becomes a record.
 */
export const CAPABILITY_SELECTION_FORM = 'capability-selection'
export const CAPABILITY_SELECTION_SCHEMA = 'ptc-capability-selection/v1'

const MAX_CHOICES = 256
/** The one entry-id vocabulary a choice record may use; its writer validates the same form. */
export const CAPABILITY_ENTRY_ID = /^(tools|skills|mcp|mcpServers)\.[^\s]{1,200}$/
const ENTRY_ID = CAPABILITY_ENTRY_ID
const AVAILABILITY = ['enabled', 'closed', 'automatic']
const DISCLOSURE = ['automatic', ...CAPABILITY_DISCLOSURES]
const PREFIX = 'PTC Plus session capability choices. These are this session\'s own decisions; the global configuration still owns the saved column, and the host still owns which entries exist. Choices:'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortedEntries(choices) {
  return Object.entries(choices).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
}

export function normalizeCapabilitySelection(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 2
    || !Object.hasOwn(value, 'schema') || !Object.hasOwn(value, 'choices')) {
    throw new TypeError('invalid capability selection')
  }
  if (value.schema !== CAPABILITY_SELECTION_SCHEMA) throw new TypeError('invalid capability selection schema')
  if (!isRecord(value.choices) || Reflect.ownKeys(value.choices).length > MAX_CHOICES) {
    throw new TypeError('invalid capability selection choices')
  }
  const choices = {}
  for (const [id, choice] of sortedEntries(value.choices)) {
    if (!ENTRY_ID.test(id) || !isRecord(choice) || Reflect.ownKeys(choice).length === 0) {
      throw new TypeError('invalid capability selection entry')
    }
    const next = {}
    for (const [dimension, selection] of Object.entries(choice)) {
      const allowed = dimension === 'availability' ? AVAILABILITY
        : dimension === 'disclosure' ? DISCLOSURE : undefined
      if (allowed === undefined || !allowed.includes(selection)) throw new TypeError('invalid capability selection dimension')
      next[dimension] = selection
    }
    choices[id] = next
  }
  return Object.freeze({ schema: CAPABILITY_SELECTION_SCHEMA,
    choices: Object.freeze(Object.fromEntries(Object.entries(choices).map(([id, choice]) => [id, Object.freeze(choice)]))) })
}

/** The exact model-visible wording one selection record carries. */
export function capabilitySelectionText(selection) {
  return `${PREFIX}\n${JSON.stringify(normalizeCapabilitySelection(selection).choices)}`
}

export function capabilitySelectionMessage(selection) {
  const text = capabilitySelectionText(selection)
  const message = createUserMessage({
    source: { kind: PTC_MESSAGE_SOURCE_KIND, form: CAPABILITY_SELECTION_FORM },
    content: [{ type: 'text', text }],
  })
  if (readCapabilitySelection(message) === undefined) throw new TypeError('invalid capability selection message')
  return message
}

/** Read one selection record back from a message, message projection or message fact. */
export function readCapabilitySelection(value) {
  const source = value?.source
  if (!isPtcMessageSource(source) || source.form !== CAPABILITY_SELECTION_FORM) return undefined
  if (!Array.isArray(value.content) || value.content.length !== 1 || value.content[0]?.type !== 'text') return undefined
  const text = value.content[0].text
  if (typeof text !== 'string' || !text.startsWith(`${PREFIX}\n`)) return undefined
  try {
    const choices = JSON.parse(text.slice(PREFIX.length + 1))
    const selection = normalizeCapabilitySelection({ schema: CAPABILITY_SELECTION_SCHEMA, choices })
    return capabilitySelectionText(selection) === text ? selection : undefined
  } catch {
    return undefined
  }
}

/**
 * How this session's newest selection record reads.
 *
 * The newest record is the current statement whether or not this build can parse
 * it, so an unreadable one is not evidence for an earlier record either.
 */
export function classifyCapabilitySelection(records) {
  if (!Array.isArray(records)) return Object.freeze({ state: 'none' })
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.form !== CAPABILITY_SELECTION_FORM) continue
    try {
      return Object.freeze({ state: 'decided',
        selection: normalizeCapabilitySelection({ schema: CAPABILITY_SELECTION_SCHEMA, choices: record.choices }) })
    } catch {
      return Object.freeze({ state: 'unreadable' })
    }
  }
  return Object.freeze({ state: 'none' })
}

/** This session's newest selection record, read from its own log events. */
export function capabilitySelectionOf(events) {
  const records = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (!isPtcMessageSource(source) || source.form !== CAPABILITY_SELECTION_FORM) continue
    records.push({ form: CAPABILITY_SELECTION_FORM, choices: readCapabilitySelection(event.data)?.choices })
  }
  return classifyCapabilitySelection(records)
}

/** The choice this session recorded for one entry, or `undefined` when it recorded none. */
export function capabilityChoiceOf(statement, id) {
  return statement?.state === 'decided' ? statement.selection.choices[id] : undefined
}
