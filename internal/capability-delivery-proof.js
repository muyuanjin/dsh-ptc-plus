/**
 * One capability, three separate facts.
 *
 * Saving a global choice changes supply: the configuration now records a
 * decision. It does not prove the model ever received that decision, and it does
 * not prove a cell can reach the capability. Those are different questions with
 * different owners:
 *
 * - **saved**: the global configuration records a choice for this capability.
 * - **delivered**: the model-visible capability catalog published it at an
 *   accepted step, rather than waiting for the next one or never listing it.
 * - **usable**: a completed execution in this session actually reached it.
 *
 * Usability is only ever proved by an execution result. Nothing else in the
 * product can claim it: a saved switch, a published catalog entry and an
 * installed tool schema are all statements about intent, not about a value a
 * cell obtained. Reporting "saved, delivered, usability unproven" is therefore
 * the honest answer to "did that save take effect", and it is what a layer that
 * cannot prove more must say instead of claiming effect.
 */
export const CAPABILITY_PROOF_SCHEMA = 'ptc-capability-proof/v1'
export const CAPABILITY_DELIVERY_STATES = new Set(['delivered', 'pending', 'absent'])
export const CAPABILITY_USABILITY_STATES = new Set(['proven', 'unproven'])

const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeCapabilityProof(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 5
    || !Object.hasOwn(value, 'schema') || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'saved')
    || !Object.hasOwn(value, 'delivery') || !Object.hasOwn(value, 'usability')) {
    throw new TypeError('invalid capability proof')
  }
  if (value.schema !== CAPABILITY_PROOF_SCHEMA) throw new TypeError('invalid capability proof schema')
  if (typeof value.id !== 'string' || !CAPABILITY_ID.test(value.id)) throw new TypeError('invalid capability proof id')
  if (typeof value.saved !== 'boolean') throw new TypeError('invalid capability proof saved fact')
  if (!CAPABILITY_DELIVERY_STATES.has(value.delivery)) throw new TypeError('invalid capability proof delivery state')
  if (!CAPABILITY_USABILITY_STATES.has(value.usability)) throw new TypeError('invalid capability proof usability state')
  return Object.freeze({
    schema: CAPABILITY_PROOF_SCHEMA,
    id: value.id,
    saved: value.saved,
    delivery: value.delivery,
    usability: value.usability,
  })
}

/**
 * The model-visible sentence for one proof. Each layer states its own result, so
 * a reader can tell which layer failed instead of reading one blanket "applied".
 */
export function capabilityProofText(proof) {
  const normalized = normalizeCapabilityProof(proof)
  const id = normalized.id
  const saved = normalized.saved
    ? `Saved: yes. The global configuration records a choice for ${id}.`
    : `Saved: no. The global configuration records no choice for ${id}, so this save did not happen; the session choice below is the only change.`
  const delivery = {
    delivered: `Delivered: yes. The model-visible capability catalog published ${id} at an accepted step.`,
    pending: `Delivered: not yet. The saved configuration reaches the model-visible catalog at the next accepted step, so ${id} is not in it now.`,
    absent: `Delivered: no. The published capability catalog does not list ${id}, so the model never received it.`,
  }[normalized.delivery]
  const usability = normalized.usability === 'proven'
    ? `Usable: proven. A completed execution in this session reached ${id}.`
    : `Usable: unproven. No completed execution in this session reached ${id}; only such a result would prove it, and a saved or published entry does not.`
  return `${saved} ${delivery} ${usability}`
}
