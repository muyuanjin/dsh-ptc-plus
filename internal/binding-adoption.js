import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND, RETIRED_SURFACE_RECORD } from './message-sources.js'

/**
 * Session binding adoption: which Global User Binding catalog entries this
 * session uses.
 *
 * The question is answered per session and per entry, and the answer is a
 * decision of exactly two states: this session uses the entry, or it does not.
 * An entry the session never named is used, because the global catalog already
 * answered the supply question. That default is the absence of a decision, not
 * a third state: "use" and "never mentioned" lead to the same environment, so
 * they are one state rather than two.
 *
 * Adoption can only take an entry away from this session. It cannot supply one,
 * enable one, or name a source: an entry the global configuration disabled is
 * absent from the catalog, so "adoption revives a deleted entry" has no
 * encoding here and needs no rule forbidding it. Naming an entry the catalog
 * does not offer is rejected at the surface that states the decision, because
 * the record would otherwise claim authority over supply.
 *
 * The neighbour this must not be confused with is the capability pane's
 * `automatic`, which means "the host derives this value". A binding has no host
 * derivation to defer to, so borrowing that word would misdescribe both.
 *
 * The decision is recorded as a plugin record in the session log, so it is
 * reconstructed by replaying that log after a restart instead of being kept in
 * process memory. The message form is the historical carrier that 0.5.4 and
 * earlier wrote; it is still read (those sessions keep their decision, and a
 * repaired statement answers through it), and no writer produces it.
 */
export const BINDING_ADOPTION_FORM = 'binding-adoption'
export const BINDING_ADOPTION_SCHEMA = 'ptc-binding-adoption/v1'

/**
 * The log record this session's adoption is written as.
 *
 * Adoption is a decision about this session's own environment: the catalog the
 * model reads already reflects it, so the decision needs no message of its own.
 * Writing it as a record makes it durable and immediate — it is taken the moment
 * the control is used, before any step, without entering the model-visible surface
 * (a surface node ahead of the host's protected head would make the log
 * unreadable to every reader). A host that publishes no plugin-record writer
 * refuses the write instead of falling back to that surface node.
 */
export const BINDING_ADOPTION_RECORD = 'plugin:ptc-plus/binding-adoption'

const MAX_DECLINED = 64
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PREFIX = 'PTC Plus session binding adoption. This session uses every entry the global catalog supplies except the declined ones. Adoption can only withdraw an entry from this session: it cannot supply, enable or revive one, and the global configuration decides which entries exist at all. Declined entry IDs:'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortIds(ids) {
  return [...ids].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

export function normalizeBindingAdoption(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 2
    || !Object.hasOwn(value, 'schema') || !Object.hasOwn(value, 'declined')) {
    throw new TypeError('invalid binding adoption')
  }
  if (value.schema !== BINDING_ADOPTION_SCHEMA) throw new TypeError('invalid binding adoption schema')
  if (!Array.isArray(value.declined) || value.declined.length > MAX_DECLINED) {
    throw new TypeError('invalid binding adoption declined entries')
  }
  const declined = []
  for (const id of value.declined) {
    if (typeof id !== 'string' || !ENTRY_ID.test(id)) throw new TypeError('invalid binding adoption entry id')
    if (declined.includes(id)) throw new TypeError('duplicate binding adoption entry id')
    declined.push(id)
  }
  return Object.freeze({ schema: BINDING_ADOPTION_SCHEMA, declined: Object.freeze(sortIds(declined)) })
}

/** The exact model-visible wording one adoption record carries. */
export function bindingAdoptionText(adoption) {
  return `${PREFIX}\n${JSON.stringify(normalizeBindingAdoption(adoption).declined)}`
}

/** The historical message this adoption was written as before the record carrier. */
export function bindingAdoptionMessage(adoption) {
  const text = bindingAdoptionText(adoption)
  const message = createUserMessage({
    source: { kind: PTC_MESSAGE_SOURCE_KIND, form: BINDING_ADOPTION_FORM },
    content: [{ type: 'text', text }],
  })
  if (readBindingAdoption(message) === undefined) throw new TypeError('invalid binding adoption message')
  return message
}

/** Read one adoption record back from a message, message projection or message fact. */
export function readBindingAdoption(value) {
  const source = value?.source
  if (!isPtcMessageSource(source) || source.form !== BINDING_ADOPTION_FORM) return undefined
  if (!Array.isArray(value.content) || value.content.length !== 1 || value.content[0]?.type !== 'text') return undefined
  const text = value.content[0].text
  if (typeof text !== 'string' || !text.startsWith(`${PREFIX}\n`)) return undefined
  try {
    const declined = JSON.parse(text.slice(PREFIX.length + 1))
    const adoption = normalizeBindingAdoption({ schema: BINDING_ADOPTION_SCHEMA, declined })
    return bindingAdoptionText(adoption) === text ? adoption : undefined
  } catch {
    return undefined
  }
}

/**
 * How this session's newest adoption statement reads.
 *
 * `none` is the absence of a decision, `decided` is a statement this build can
 * read, and `unreadable` is a statement it cannot. The third state is not the
 * first: an unreadable newest statement still supersedes every earlier record,
 * so no consumer may answer from the older one in its place. `latestBindingAdoption`
 * collapses the last two into `undefined`, which is why the panel asks this
 * function instead: `undefined` there means "no decision to apply", not "the
 * session declined nothing".
 */
export function classifyBindingAdoption(records) {
  if (!Array.isArray(records)) return Object.freeze({ state: 'none' })
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.form !== BINDING_ADOPTION_FORM) continue
    try {
      return Object.freeze({ state: 'decided',
        adoption: normalizeBindingAdoption({ schema: BINDING_ADOPTION_SCHEMA, declined: record.declined }) })
    } catch {
      // A record that cannot be read is not evidence for an earlier record
      // either: the newest statement is the current one, and it is unreadable.
      return Object.freeze({ state: 'unreadable' })
    }
  }
  return Object.freeze({ state: 'none' })
}

/** Read one committed plugin record back as this session's adoption, or nothing. */
export function readBindingAdoptionRecord(event) {
  if (event?.type !== BINDING_ADOPTION_RECORD || event.ignorable !== true) return undefined
  try {
    return normalizeBindingAdoption(event.data)
  } catch {
    return undefined
  }
}

/**
 * Whether one event states this session's adoption at all.
 *
 * The record type states it, and so does the historical message form. A repaired statement
 * (`RETIRED_SURFACE_RECORD`) states it only when the payload it kept is this owner's own form:
 * the repair retires every surface node ahead of the protected head, whichever owner wrote it,
 * so the carrier alone says nothing about who the statement belongs to.
 */
function statesBindingAdoption(event) {
  if (event?.type === BINDING_ADOPTION_RECORD) return true
  const source = event?.data?.source
  return isPtcMessageSource(source) && source.form === BINDING_ADOPTION_FORM
}

/**
 * Read one adoption out of either carrier, so a reader never has to know which release wrote it —
 * and a repaired statement answers for the owner whose form it carries.
 */
export function readBindingAdoptionStatement(event) {
  if (event?.type === BINDING_ADOPTION_RECORD) return readBindingAdoptionRecord(event)
  if (event?.type === RETIRED_SURFACE_RECORD) {
    return event.ignorable === true && statesBindingAdoption(event) ? readBindingAdoption(event.data) : undefined
  }
  return event?.type === 'user/message' ? readBindingAdoption(event.data) : undefined
}

/**
 * This session's newest adoption statement, read from its own log events.
 *
 * The log is the owner of the decision, so every adoption statement it carries — a record, the
 * message form an older release wrote, or a repaired statement of the same form — is classified,
 * including one this build cannot read. Extracting the statements and classifying them here keeps
 * every reader on the same cut: a reader that filtered to the readable statements first would hand
 * a superseded record the answer, and the panel and the `/binding` command would then disagree
 * about which record governs this session.
 */
export function bindingAdoptionOf(events) {
  const records = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== BINDING_ADOPTION_RECORD
      && event?.type !== RETIRED_SURFACE_RECORD) continue
    // A repair retires every owner's surface node, so only a statement that kept this owner's
    // form joins the ordering; another owner's retired node is not an adoption at all.
    if (!statesBindingAdoption(event)) continue
    records.push({ form: BINDING_ADOPTION_FORM, declined: readBindingAdoptionStatement(event)?.declined })
  }
  return classifyBindingAdoption(records)
}

/**
 * The newest adoption this session recorded, or `undefined` while it recorded
 * none this build can read. The newest record replaces earlier ones, because
 * stating a decision again is how a session changes its mind.
 */
export function latestBindingAdoption(records) {
  const statement = classifyBindingAdoption(records)
  return statement.state === 'decided' ? statement.adoption : undefined
}

/**
 * The declined entry IDs of one adoption, as a set the environment uses.
 * An adoption that was never stated declines nothing.
 */
export function declinedBindingEntries(adoption) {
  return new Set(adoption === undefined ? [] : normalizeBindingAdoption(adoption).declined)
}

/** State one entry as used (`adopt` true) or not used, leaving the rest alone. */
export function withBindingAdoption(adoption, entryId, adopt) {
  if (typeof entryId !== 'string' || !ENTRY_ID.test(entryId)) throw new TypeError('invalid binding adoption entry id')
  if (typeof adopt !== 'boolean') throw new TypeError('binding adoption decision must be a boolean')
  const declined = declinedBindingEntries(adoption)
  if (adopt) declined.delete(entryId)
  else declined.add(entryId)
  return normalizeBindingAdoption({ schema: BINDING_ADOPTION_SCHEMA, declined: [...declined] })
}

/** Drop every declined entry: this session again uses the whole catalog. */
export function clearedBindingAdoption() {
  return normalizeBindingAdoption({ schema: BINDING_ADOPTION_SCHEMA, declined: [] })
}
