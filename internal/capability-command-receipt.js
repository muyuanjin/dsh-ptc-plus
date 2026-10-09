/** Structured command outcome for locale-owned Client receipts; text remains a CLI fallback. */
const PREFIX = '\n\nPTC Plus capability refresh receipt:\n'
const FALLBACKS = Object.freeze({
  'saved-only': 'Global choice saved, but the session update failed; inspect and retry session',
  recorded: 'Capabilities updated for session',
  pending: 'Capabilities prepared; they take effect at the first accepted model step for session',
  unavailable: 'Select an active PTC session; the command did not update session',
  usage: 'Use /capabilities to inspect or /capabilities refresh to apply saved settings for session',
})
const STATES = new Set(['recorded', 'pending', 'unavailable', 'usage', 'saved-only'])

export function capabilityCommandReceipt(state, sessionId, error, proposal) {
  if (!STATES.has(state) || typeof sessionId !== 'string' || !sessionId) throw new TypeError('invalid capability command receipt')
  if (error !== undefined && (state !== 'saved-only' || typeof error !== 'string' || !error)) throw new TypeError('invalid capability command error')
  if (proposal !== undefined && (state !== 'pending' || !proposal || typeof proposal.commandId !== 'string'
    || typeof proposal.rawInput !== 'string' || !proposal.message)) throw new TypeError('invalid capability proposal receipt')
  return `${FALLBACKS[state]} ${sessionId}.${error ? ` ${error}` : ''}` + PREFIX
    + JSON.stringify({ schema: 'ptc-capability-command/v1', state, sessionId, ...(error === undefined ? {} : { error }), ...(proposal === undefined ? {} : { proposal }) })
}

export function readCapabilityCommandReceipt(text) {
  if (typeof text !== 'string' || !text.includes(PREFIX)) return undefined
  try {
    const receipt = JSON.parse(text.slice(text.indexOf(PREFIX) + PREFIX.length))
    return receipt?.schema === 'ptc-capability-command/v1' && STATES.has(receipt.state)
      && typeof receipt.sessionId === 'string' && receipt.sessionId
      && capabilityCommandReceipt(receipt.state, receipt.sessionId, receipt.error, receipt.proposal) === text ? receipt : undefined
  } catch { return undefined }
}
