import assert from 'node:assert/strict'
import test from 'node:test'

import { capabilityCommandReceipt, readCapabilityCommandReceipt } from '../internal/capability-command-receipt.js'
import { normalizeCapabilitySelection, CAPABILITY_SELECTION_SCHEMA } from '../internal/capability-selection.js'

const PREFIX = '\n\nPTC Plus capability refresh receipt:\n'
const record = (extra = {}) => ({ scope: 'session', id: 'tools.probe', dimension: 'availability', selection: 'closed', ...extra })

test('a capability receipt names the record the command wrote', () => {
  const text = capabilityCommandReceipt('recorded', 'session-1', undefined, undefined, record())
  assert.match(text, /Capabilities updated for session session-1\./u)
  assert.match(text, /Recorded tools\.probe availability = closed for this session\./u)
  const receipt = readCapabilityCommandReceipt(text)
  assert.deepEqual(receipt.record, record())
  assert.equal(receipt.state, 'recorded')
  assert.equal(receipt.sessionId, 'session-1')
  // A global save is written into the saved configuration, not into the session.
  const global = capabilityCommandReceipt('recorded', 'session-1', undefined, undefined,
    record({ scope: 'global', selection: 'full' }))
  assert.match(global, /Recorded tools\.probe availability = full in the global configuration\./u)
  assert.equal(readCapabilityCommandReceipt(global).record.scope, 'global')
  // A choice made without a dimension is still one record.
  const whole = capabilityCommandReceipt('recorded', 'session-1', undefined, undefined,
    { scope: 'session', id: 'tools.probe', selection: 'on-demand' })
  assert.match(whole, /Recorded tools\.probe = on-demand for this session\./u)
  assert.deepEqual(readCapabilityCommandReceipt(whole).record, { scope: 'session', id: 'tools.probe', selection: 'on-demand' })
})

test('a capability receipt states no degree of proof', () => {
  for (const choice of ['enabled', 'closed', 'automatic', 'inherit', 'full', 'on-demand', 'host', 'adaptive']) {
    for (const scope of ['session', 'global']) {
      const text = capabilityCommandReceipt('recorded', 'session-1', undefined, undefined,
        { scope, id: 'tools.probe', selection: choice })
      const sentence = text.slice(0, text.indexOf(PREFIX))
      // The receipt answers "what did this command write"; the panel's evidence
      // column answers "did a cell reach it", so no saved/delivered/usable segment
      // may appear here.
      assert.doesNotMatch(sentence, /Saved:|Delivered:|Usable:/u)
      assert.doesNotMatch(sentence, /unproven|unavailable|not yet/iu)
    }
  }
})

test('a record closes over the vocabulary the command accepts', () => {
  const invalid = [
    [record({ scope: 'host' }), /invalid capability command record/u],
    [record({ id: '' }), /invalid capability command record/u],
    [record({ id: 4 }), /invalid capability command record/u],
    [record({ selection: 'applied' }), /invalid capability command record/u],
    [record({ dimension: 'scope' }), /invalid capability command record/u],
    [{ ...record(), extra: 1 }, /invalid capability command record/u],
  ]
  for (const [value, expected] of invalid) assert.throws(() => capabilityCommandReceipt('recorded', 'session-1', undefined, undefined, value), expected)
  assert.throws(() => capabilityCommandReceipt('saved-only', 'session-1', 'Update failed', undefined, record()),
    /invalid capability command record state/u)
  assert.throws(() => capabilityCommandReceipt('paused', 'session-1', undefined, undefined, record()),
    /invalid capability command record state/u)
})

test('a receipt reports every entry id the choice record accepts', () => {
  // The record vocabulary decides which ids a choice may name. A receipt that asked a
  // stricter question refused a record the session already held, so the write landed
  // under a reported failure and a retry appended a second record. These are the ids
  // that diverged: a declared name is not restricted to ASCII or to `[._:/-]`.
  for (const id of ['tools.probe', 'tools.a+b', 'tools.a@b', 'skills.研究', 'mcpServers.docs/docs']) {
    const choices = normalizeCapabilitySelection({ schema: CAPABILITY_SELECTION_SCHEMA,
      choices: { [id]: { availability: 'closed' } } }).choices
    assert.deepEqual(choices[id], { availability: 'closed' }, `the record vocabulary names ${id}`)
    const text = capabilityCommandReceipt('recorded', 'session-1', undefined, undefined, record({ id }))
    assert.equal(readCapabilityCommandReceipt(text).record.id, id, `the receipt reports ${id}`)
  }
  // The receipt's own requirement is one line: an id with whitespace breaks that
  // sentence, so it stays refused, and so does an over-long one.
  assert.throws(() => capabilityCommandReceipt('recorded', 'session-1', undefined, undefined,
    record({ id: 'tools.a b' })), /invalid capability command record/u)
  assert.throws(() => capabilityCommandReceipt('recorded', 'session-1', undefined, undefined,
    record({ id: `tools.${'a'.repeat(256)}` })), /invalid capability command record/u)
})

test('a capability receipt without a record keeps its own text readable', () => {
  // A refresh records no choice, so its receipt names none.
  const refresh = capabilityCommandReceipt('recorded', 'session-1')
  assert.doesNotMatch(refresh, /Recorded/u)
  assert.equal(readCapabilityCommandReceipt(refresh).record, undefined)
  assert.equal(capabilityCommandReceipt('recorded', 'session-1', undefined, undefined, undefined), refresh)
  assert.throws(() => capabilityCommandReceipt('recorded', 'session-1', 'Update failed'), /invalid capability command error/u)
  assert.throws(() => capabilityCommandReceipt('nonsense', 'session-1'), /invalid capability command receipt/u)
  assert.equal(readCapabilityCommandReceipt('Capabilities updated for session session-1.'), undefined)
})

test('a 0.5.4 receipt stays readable and its saved/delivered/usable report is dropped', () => {
  // Releases up to 0.5.4 appended this report. The stored text is history the
  // Client must read instead of echoing, and the report itself never reaches a
  // reader: the panel's evidence column owns that fact now.
  const proof = { schema: 'ptc-capability-proof/v1', id: 'tools.probe', saved: true, delivery: 'absent', usability: 'unproven' }
  const historical = 'Capabilities updated for session session-1.'
    + ' Saved: yes. The global configuration records a choice for tools.probe.'
    + ' Delivered: no. The published capability catalog does not list tools.probe, so the model never received it.'
    + ' Usable: unproven. No completed execution in this session reached tools.probe; only such a result would prove it, and a saved or published entry does not.'
    + PREFIX + JSON.stringify({ schema: 'ptc-capability-command/v1', state: 'recorded', sessionId: 'session-1', proof })
  const receipt = readCapabilityCommandReceipt(historical)
  assert.deepEqual(receipt, { schema: 'ptc-capability-command/v1', state: 'recorded', sessionId: 'session-1' })
  assert.equal(Object.hasOwn(receipt, 'proof'), false)
  // The stored facts and the writer's own outcome sentence are the whole check, so
  // a text that moves the session, repeats the report, adds a field or reorders one
  // is not a receipt this build wrote or recognized.
  assert.equal(readCapabilityCommandReceipt(historical.replace('session-1.', 'session-2.')), undefined)
  assert.equal(readCapabilityCommandReceipt(historical.replace(PREFIX, ' Saved: yes.' + PREFIX)), undefined)
  assert.equal(readCapabilityCommandReceipt(historical.replace('{', '{"record":null,')), undefined)
  assert.equal(readCapabilityCommandReceipt(historical.replace('{', '{"extra":1,')), undefined)
  assert.equal(readCapabilityCommandReceipt(historical.replace('"state":"recorded"', '"state":"pending"')), undefined)
  assert.equal(readCapabilityCommandReceipt(historical.slice(0, historical.indexOf(PREFIX))), undefined)
  // The report's own wording is frozen history this build does not reproduce, so a
  // rewritten report sentence still reads as the facts it stored — and no reader
  // can render it, because the field is never returned.
  assert.deepEqual(readCapabilityCommandReceipt(historical.replace(' Usable: unproven.', ' Usable: proven.')), receipt)
})
