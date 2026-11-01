import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPABILITY_SELECTION_FORM,
  CAPABILITY_SELECTION_RECORD,
  CAPABILITY_SELECTION_SCHEMA,
  capabilitySelectionMessage,
  capabilitySelectionOf,
  classifyCapabilitySelection,
  normalizeCapabilitySelection,
  readCapabilitySelection,
  readCapabilitySelectionRecord,
} from '../internal/capability-selection.js'

const choices = { 'tools.probe': { availability: 'closed' } }
const selection = { schema: CAPABILITY_SELECTION_SCHEMA, choices }

test('a selection vocabulary refuses every record shape it cannot state', () => {
  // The record states exactly one schema and one choice map, so any other shape is refused
  // with the part that is wrong rather than read as a decision about something else.
  const tooManyChoices = Object.fromEntries(Array.from({ length: 257 }, (_, index) =>
    [`tools.probe${index}`, { availability: 'closed' }]))
  const refused = [
    [undefined, /^TypeError: invalid capability selection$/u],
    [null, /^TypeError: invalid capability selection$/u],
    [[], /^TypeError: invalid capability selection$/u],
    ['closed', /^TypeError: invalid capability selection$/u],
    [{ ...selection, recordedAt: 1 }, /^TypeError: invalid capability selection$/u],
    [{ schema: CAPABILITY_SELECTION_SCHEMA }, /^TypeError: invalid capability selection$/u],
    [{ schema: 'ptc-capability-selection/v2', choices }, /^TypeError: invalid capability selection schema$/u],
    [{ ...selection, choices: [] }, /^TypeError: invalid capability selection choices$/u],
    [{ ...selection, choices: null }, /^TypeError: invalid capability selection choices$/u],
    [{ ...selection, choices: 'closed' }, /^TypeError: invalid capability selection choices$/u],
    [{ ...selection, choices: tooManyChoices }, /^TypeError: invalid capability selection choices$/u],
  ]
  for (const [value, expected] of refused) assert.throws(() => normalizeCapabilitySelection(value), expected)
  assert.deepEqual(normalizeCapabilitySelection(selection), { schema: CAPABILITY_SELECTION_SCHEMA, choices })
})

test('a committed record this build cannot read states nothing while a readable one states the decision', () => {
  // A damaged record is not evidence for an earlier record either, so it reads as no
  // statement at all here and the log reader answers `unreadable` in its place.
  const damaged = { seq: 2, type: CAPABILITY_SELECTION_RECORD, ignorable: true,
    data: { schema: CAPABILITY_SELECTION_SCHEMA, choices: { 'tools.probe': { availability: 'suspended' } } } }
  assert.equal(readCapabilitySelectionRecord(damaged), undefined)
  assert.equal(capabilitySelectionOf([{ seq: 1, ...damaged, data: selection }], 'session-1').state, 'decided')
  assert.equal(capabilitySelectionOf([{ seq: 1, ...damaged }], 'session-1').state, 'unreadable')
  // The classifier owns the same answer for a record whose choices were never readable.
  assert.deepEqual(classifyCapabilitySelection([{ form: CAPABILITY_SELECTION_FORM, choices: undefined }]), { state: 'unreadable' })
  assert.deepEqual(classifyCapabilitySelection([{ form: CAPABILITY_SELECTION_FORM, choices }]),
    { state: 'decided', selection: { schema: CAPABILITY_SELECTION_SCHEMA, choices } })
})

test('a historical selection message whose payload is not this vocabulary states no selection', () => {
  // The wording is the record: a message that does not parse back into the same sentence is
  // no statement of a session choice, and no earlier record may answer in its place.
  const message = capabilitySelectionMessage(selection)
  assert.deepEqual(readCapabilitySelection(message), { schema: CAPABILITY_SELECTION_SCHEMA, choices })
  const damaged = { ...message, content: [{ type: 'text', text: message.content[0].text.replace('{"availability":"closed"}', 'closed') }] }
  assert.equal(readCapabilitySelection(damaged), undefined)
  assert.equal(capabilitySelectionOf([{ seq: 1, type: 'user/message', data: damaged }], 'session-1').state, 'unreadable')
})
