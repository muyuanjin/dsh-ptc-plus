import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CAPABILITY_PLAN_FORM, isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
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
 *
 * A record is not the only shape this session's decision has ever had. Before
 * this record existed, the plugin wrote a session's choices into a plan snapshot —
 * the one it delivered, or the one a pending command receipt carried when no step
 * had accepted it yet — and those sessions have no record at all. Reading such
 * a session as `none` would recompose it from an empty set and withdraw choices
 * its own log still holds, so this module reads the newest delivered plan's
 * `sessionOverrides` as the same statement (`decided`, marked `legacy`) when the
 * session recorded none. The delivered plan is the equivalent form of one
 * statement, never a second owner: a record outvotes it, and the next write
 * restates every choice this read answered with. Only a plan that delivered a
 * choice is such a statement — an empty override map says the session inherited
 * everything, which is the state a session without a record already reads as — and
 * a plan that states the map unreadably reports `unreadable` for the same reason a
 * record does.
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

/**
 * The dimension rule one selection states, or `{}` when it states no decision.
 *
 * One selection is the vocabulary a saved decision, a command intent and a
 * delivered plan's override all use; a record states dimensions. This function
 * is the only place the two spellings meet, so a writer that copies a selection
 * into a record and a reader that turns a delivered override back into one
 * cannot disagree about what that selection meant. Anything narrower — a rule
 * naming only one dimension — is already in this shape and is copied as it is.
 */
export function capabilityRuleOfSelection(selection) {
  if (isRecord(selection)) return { ...selection }
  return selection === undefined || selection === 'inherit' ? {}
    : selection === 'automatic' ? { availability: 'automatic', disclosure: 'automatic' }
      : selection === 'closed' ? { availability: 'closed' } : { availability: 'enabled', disclosure: selection }
}

/**
 * The dimension form of one recorded-by-plan override.
 *
 * A delivered plan recorded this session's choices in the compact vocabulary a
 * saved configuration uses — one whole selection per entry, or the dimensions a
 * policy rule states — while a record states dimensions only. The two meet in
 * `capabilityRuleOfSelection`, which is why the plan is an equivalent form of one
 * statement rather than a second vocabulary: every value it reads maps back to
 * the same compact selection, so a choice read from a plan and restated into a
 * record says what the plan said.
 */
function planChoice(override) {
  const choice = capabilityRuleOfSelection(override)
  return Object.keys(choice).length === 0 ? undefined : choice
}

/**
 * This session's statement as its newest delivered plan recorded it.
 *
 * Only a plan that delivered at least one choice is a statement: an empty
 * override map says the session inherited everything, which is the state a
 * session without a record already reads as, not a decision to migrate. A plan
 * whose overrides cannot be read as this vocabulary is `unreadable` for the same
 * reason a record is: it supersedes what came before it and this build cannot
 * say what it decided.
 */
function planSelection(message) {
  const snapshot = message?.source?.snapshot
  const overrides = snapshot?.sessionOverrides
  // A snapshot that states no choices at all (the v1 generation) recorded nothing to
  // migrate. One that states them in a shape this vocabulary cannot read is
  // `unreadable`: it supersedes what came before it, and reporting `none` would let
  // the composition withdraw a decision the log still holds.
  if (overrides === undefined) return Object.freeze({ state: 'none' })
  if (!isRecord(overrides)) return Object.freeze({ state: 'unreadable' })
  try {
    // The entries are collected as pairs and materialized with own data properties: an
    // override key the record vocabulary cannot name (for example `__proto__`) must reach
    // the vocabulary check as a name it refuses, not silently become the map's prototype
    // and leave the statement reading `none` where the record branch reads `unreadable`.
    const entries = []
    for (const [id, override] of sortedEntries(overrides)) {
      const choice = planChoice(override)
      if (choice !== undefined) entries.push([id, choice])
    }
    if (entries.length === 0) return Object.freeze({ state: 'none' })
    return Object.freeze({ state: 'decided', legacy: true,
      selection: normalizeCapabilitySelection({ schema: CAPABILITY_SELECTION_SCHEMA, choices: Object.fromEntries(entries) }) })
  } catch {
    return Object.freeze({ state: 'unreadable' })
  }
}

/**
 * How this session's newest statement reads, from its own log events.
 *
 * One entry answers for every consumer: a record when the session wrote one,
 * otherwise the newest delivered plan as the equivalent form. Reading the plan
 * only when no record exists keeps the record the newest word, so a session that
 * upgraded and then decided again is not answered from an older plan.
 *
 * A caller that knows which session the log belongs to passes that identity, and a
 * delivered plan that names a different session is then not read as this session's
 * statement. A plan message carries the session it was composed for, and the writers
 * that restore one require that identity; a record carries none, so the log it was
 * appended to is its only identity.
 */
export function capabilitySelectionOf(events, sessionId) {
  const records = []
  let delivered
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (!isPtcMessageSource(source)) continue
    if (source.form === CAPABILITY_SELECTION_FORM) {
      records.push({ form: CAPABILITY_SELECTION_FORM, choices: readCapabilitySelection(event.data)?.choices })
    } else if (source.form === CAPABILITY_PLAN_FORM
      && (sessionId === undefined || source.sessionId === sessionId)) delivered = event.data
  }
  const recorded = classifyCapabilitySelection(records)
  return recorded.state === 'none' ? planSelection(delivered) : recorded
}

/** The choice this session recorded for one entry, or `undefined` when it recorded none. */
export function capabilityChoiceOf(statement, id) {
  return statement?.state === 'decided' ? statement.selection.choices[id] : undefined
}
