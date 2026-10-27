import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isPtcMessageSource, PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'

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
 * The decision is recorded as one PTC message in the session log, so it is
 * reconstructed by replaying that log after a restart instead of being kept in
 * process memory.
 */
export const BINDING_ADOPTION_FORM = 'binding-adoption'
export const BINDING_ADOPTION_SCHEMA = 'ptc-binding-adoption/v1'

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
 * The newest adoption this session recorded, or `undefined` while it recorded
 * none. The newest record replaces earlier ones, because stating a decision
 * again is how a session changes its mind.
 */
export function latestBindingAdoption(records) {
  if (!Array.isArray(records)) return undefined
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.form !== BINDING_ADOPTION_FORM) continue
    try {
      return normalizeBindingAdoption({ schema: BINDING_ADOPTION_SCHEMA, declined: record.declined })
    } catch {
      // A record that cannot be read is not evidence for an earlier record
      // either: the newest statement is the current one, and it is unreadable.
      return undefined
    }
  }
  return undefined
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
