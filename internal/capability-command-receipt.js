/** Structured command outcome for locale-owned Client receipts; text remains a CLI fallback. */
import { capabilityProofText, normalizeCapabilityProof } from './capability-delivery-proof.js'

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

export function capabilityCommandReceipt(state, sessionId, error, proposal, proof) {
  if (!STATES.has(state) || typeof sessionId !== 'string' || !sessionId) throw new TypeError('invalid capability command receipt')
  if (error !== undefined && (state !== 'saved-only' || typeof error !== 'string' || !error)) throw new TypeError('invalid capability command error')
  if (proposal !== undefined && (state !== 'pending' || !proposal || typeof proposal.commandId !== 'string'
    || typeof proposal.rawInput !== 'string' || !proposal.message)) throw new TypeError('invalid capability proposal receipt')
  // A command that names one capability reports that capability's three layers
  // beside the session outcome, so "saved" cannot be read as "delivered" or
  // "usable". The schema stays v1 because the field is additive: receipts
  // recorded before it existed still reproduce their own text.
  const layers = proof === undefined ? undefined : normalizeCapabilityProof(proof)
  return `${FALLBACKS[state]} ${sessionId}.${error ? ` ${error}` : ''}`
    + (layers === undefined ? '' : ` ${capabilityProofText(layers)}`)
    + PREFIX
    + JSON.stringify({
      schema: 'ptc-capability-command/v1', state, sessionId,
      ...(error === undefined ? {} : { error }),
      ...(proposal === undefined ? {} : { proposal }),
      ...(layers === undefined ? {} : { proof: layers }),
    })
}

export function readCapabilityCommandReceipt(text) {
  if (typeof text !== 'string' || !text.includes(PREFIX)) return undefined
  try {
    const receipt = JSON.parse(text.slice(text.indexOf(PREFIX) + PREFIX.length))
    return receipt?.schema === 'ptc-capability-command/v1' && STATES.has(receipt.state)
      && typeof receipt.sessionId === 'string' && receipt.sessionId
      && capabilityCommandReceipt(receipt.state, receipt.sessionId, receipt.error, receipt.proposal, receipt.proof) === text ? receipt : undefined
  } catch { return undefined }
}
