/**
 * Structured command outcome for locale-owned Client receipts; text remains a CLI fallback.
 *
 * A receipt states the one write a command performed: which entry, which choice,
 * and which owner now records it. Whether a cell later reached that entry is a
 * different question with a different owner — the panel's evidence column, where
 * a marker means an accepted execution obtained it — so a receipt that restated
 * a degree of proof would answer a question this command never asked and could
 * not answer.
 */
const PREFIX = '\n\nPTC Plus capability refresh receipt:\n'
const FALLBACKS = Object.freeze({
  'saved-only': 'Global choice saved, but the session update failed; inspect and retry session',
  recorded: 'Capabilities updated for session',
  pending: 'Capabilities prepared; they take effect at the first accepted model step for session',
  unavailable: 'Select an active PTC session; the command did not update session',
  usage: 'Use /capabilities to inspect or /capabilities refresh to apply saved settings for session',
  paused: 'Capabilities and context are off; the session stays with the Host capabilities for session',
  off: 'Capability management is off; the session stays with the Host capabilities for session',
})
const STATES = new Set(['recorded', 'pending', 'unavailable', 'usage', 'saved-only', 'paused', 'off'])
const SCOPES = new Set(['session', 'global'])
const DIMENSIONS = new Set(['availability', 'disclosure'])
// Every choice `/capabilities set` accepts, so a receipt cannot name a write the
// command would have refused.
const SELECTIONS = new Set(['full', 'on-demand', 'closed', 'automatic', 'inherit', 'enabled', 'host', 'adaptive'])
/**
 * What the receipt's one-line sentence needs from an id: no whitespace, bounded length.
 *
 * Which ids a choice may name is the record vocabulary's question
 * (`capability-selection.js`), answered once where the record is written. Asking it
 * again here would be a second owner of the same vocabulary, and a stricter second
 * owner refuses a record the session already holds: the write lands, the receipt cannot
 * be composed, and the command reports a failure it did not have. This predicate is a
 * strict superset of that vocabulary, so every record a writer accepts is reportable.
 */
const ENTRY_ID = /^\S{1,256}$/
/**
 * Releases up to 0.5.4 appended a saved/delivered/usable report to the same
 * receipt. Such a receipt stays readable — the Client renders the outcome it
 * recorded instead of falling back to its raw text — and the report is dropped
 * before any consumer sees it. Its wording is frozen history this build does not
 * reproduce, so its opening segment plus the stored facts are the whole check.
 */
const LEGACY_REPORT = ' Saved: '

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One written choice, closed over the vocabulary the writer accepts. */
function commandRecord(value) {
  if (!isRecord(value) || !SCOPES.has(value.scope) || typeof value.id !== 'string' || !ENTRY_ID.test(value.id)
    || !SELECTIONS.has(value.selection)
    || value.dimension !== undefined && !DIMENSIONS.has(value.dimension)
    || Reflect.ownKeys(value).length !== (value.dimension === undefined ? 3 : 4)) {
    throw new TypeError('invalid capability command record')
  }
  return Object.freeze({
    scope: value.scope,
    id: value.id,
    ...(value.dimension === undefined ? {} : { dimension: value.dimension }),
    selection: value.selection,
  })
}

/** The sentence a non-Client reader gets; the Client states the same facts in its own words. */
function recordFallback(record) {
  const dimension = record.dimension === undefined ? '' : ` ${record.dimension}`
  return `Recorded ${record.id}${dimension} = ${record.selection}`
    + (record.scope === 'global' ? ' in the global configuration.' : ' for this session.')
}

export function capabilityCommandReceipt(state, sessionId, error, proposal, record) {
  if (!STATES.has(state) || typeof sessionId !== 'string' || !sessionId) throw new TypeError('invalid capability command receipt')
  if (error !== undefined && (state !== 'saved-only' || typeof error !== 'string' || !error)) throw new TypeError('invalid capability command error')
  if (proposal !== undefined && (state !== 'pending' || !proposal || typeof proposal.commandId !== 'string'
    || typeof proposal.rawInput !== 'string' || !proposal.message)) throw new TypeError('invalid capability proposal receipt')
  // Only a receipt that says the write happened names one: a command whose session
  // write failed reports that failure instead of naming a record it never appended.
  if (record !== undefined && state !== 'recorded') throw new TypeError('invalid capability command record state')
  const written = record === undefined ? undefined : commandRecord(record)
  return `${FALLBACKS[state]} ${sessionId}.${error ? ` ${error}` : ''}`
    + (written === undefined ? '' : ` ${recordFallback(written)}`)
    + PREFIX
    + JSON.stringify({
      schema: 'ptc-capability-command/v1', state, sessionId,
      ...(error === undefined ? {} : { error }),
      ...(proposal === undefined ? {} : { proposal }),
      ...(written === undefined ? {} : { record: written }),
    })
}

/**
 * The receipt a command text carries, or `undefined` for any other text.
 *
 * A receipt this build writes is read only when the whole text is exactly what
 * the writer produces from the facts it stores. A 0.5.4 receipt carries the
 * report described above instead, and its visible sentence cannot be reproduced
 * without keeping that wording, so its stored facts decide: the outcome sentence,
 * the field order and the record of what was written must all be the writer's.
 */
export function readCapabilityCommandReceipt(text) {
  if (typeof text !== 'string' || !text.includes(PREFIX)) return undefined
  const cut = text.indexOf(PREFIX)
  let stored
  try { stored = JSON.parse(text.slice(cut + PREFIX.length)) } catch { return undefined }
  if (stored?.schema !== 'ptc-capability-command/v1' || !STATES.has(stored.state)) return undefined
  let current
  try {
    current = capabilityCommandReceipt(stored.state, stored.sessionId, stored.error, stored.proposal, stored.record)
  } catch { return undefined }
  if (stored.proof === undefined) return current === text ? stored : undefined
  const head = current.slice(0, current.indexOf(PREFIX))
  if (!text.startsWith(head)) return undefined
  const sentence = text.slice(head.length, cut)
  // One report segment, one line, directly after the outcome sentence: the shape
  // the 0.5.4 writer produced from these stored facts.
  if (stored.record !== undefined || !sentence.startsWith(LEGACY_REPORT)
    || sentence.includes('\n') || sentence.split(LEGACY_REPORT).length !== 2) return undefined
  const fields = Object.keys(JSON.parse(current.slice(current.indexOf(PREFIX) + PREFIX.length)))
  if (Object.keys(stored).join() !== [...fields, 'proof'].join()) return undefined
  return {
    schema: stored.schema, state: stored.state, sessionId: stored.sessionId,
    ...(stored.error === undefined ? {} : { error: stored.error }),
    ...(stored.proposal === undefined ? {} : { proposal: stored.proposal }),
  }
}
