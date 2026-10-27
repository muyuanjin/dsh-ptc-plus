import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPABILITY_PROOF_SCHEMA,
  capabilityProofText,
  normalizeCapabilityProof,
} from '../internal/capability-delivery-proof.js'
import { capabilityCommandReceipt, readCapabilityCommandReceipt } from '../internal/capability-command-receipt.js'

const proof = (delivery, usability, saved = true) => ({
  schema: CAPABILITY_PROOF_SCHEMA, id: 'tools.probe', saved, delivery, usability,
})

test('a capability proof closes its five facts and names no other outcome', () => {
  assert.deepEqual(normalizeCapabilityProof(proof('delivered', 'proven')),
    { schema: CAPABILITY_PROOF_SCHEMA, id: 'tools.probe', saved: true, delivery: 'delivered', usability: 'proven' })
  assert.equal(Object.isFrozen(normalizeCapabilityProof(proof('pending', 'unproven'))), true)
  const invalid = [
    [undefined, /invalid capability proof/],
    [{ ...proof('delivered', 'proven'), extra: 1 }, /invalid capability proof/],
    [{ ...proof('delivered', 'proven'), schema: 'ptc-capability-proof/v2' }, /invalid capability proof schema/],
    [{ ...proof('delivered', 'proven'), id: '' }, /invalid capability proof id/],
    [{ ...proof('delivered', 'proven'), id: 4 }, /invalid capability proof id/],
    [{ ...proof('delivered', 'proven'), saved: 'yes' }, /saved fact/],
    [{ ...proof('applied', 'proven') }, /delivery state/],
    [{ ...proof('delivered', 'usable') }, /usability state/],
  ]
  for (const [value, expected] of invalid) assert.throws(() => normalizeCapabilityProof(value), expected)
})

test('each layer states its own result instead of one blanket claim', () => {
  assert.equal(capabilityProofText(proof('delivered', 'proven')),
    'Saved: yes. The global configuration records a choice for tools.probe. '
    + 'Delivered: yes. The model-visible capability catalog published tools.probe at an accepted step. '
    + 'Usable: proven. A completed execution in this session reached tools.probe.')
  assert.match(capabilityProofText(proof('pending', 'unproven')), /Delivered: not yet[\s\S]*next accepted step/)
  assert.match(capabilityProofText(proof('absent', 'unproven', false)),
    /Saved: no[\s\S]*Delivered: no[\s\S]*Usable: unproven/)
  assert.match(capabilityProofText(proof('absent', 'unproven')), /Usable: unproven[\s\S]*a saved or published entry does not/)
  for (const value of [proof('delivered', 'proven'), proof('pending', 'unproven'), proof('absent', 'unproven', false)]) {
    // The receipt must never claim the whole change "took effect": that sentence
    // would be a fourth state nothing can prove.
    assert.doesNotMatch(capabilityProofText(value), /took effect|applied/u)
  }
})

test('a capability receipt carries the proof beside the session outcome and stays readable', () => {
  const layers = proof('delivered', 'unproven')
  const text = capabilityCommandReceipt('recorded', 'session-1', undefined, undefined, layers)
  const receipt = readCapabilityCommandReceipt(text)
  assert.equal(receipt.state, 'recorded')
  assert.deepEqual(receipt.proof, layers)
  assert.match(text, /Usable: unproven/)
  // A receipt recorded before this field existed still reproduces its own text.
  const historical = capabilityCommandReceipt('recorded', 'session-1')
  assert.equal(readCapabilityCommandReceipt(historical).proof, undefined)
  assert.equal(capabilityCommandReceipt('recorded', 'session-1', undefined, undefined, undefined), historical)
  assert.throws(() => capabilityCommandReceipt('recorded', 'session-1', undefined, undefined, { ...layers, delivery: 'applied' }),
    /delivery state/)
  // Appending a proof sentence to a historical receipt is not that receipt.
  const forged = text.replace(' Usable: unproven.', ' Usable: proven.')
  assert.equal(readCapabilityCommandReceipt(forged), undefined)
})
