import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import {
  BINDING_ADOPTION_FORM,
  BINDING_ADOPTION_RECORD,
  BINDING_ADOPTION_SCHEMA,
  bindingAdoptionMessage,
  bindingAdoptionOf,
  bindingAdoptionText,
  classifyBindingAdoption,
  clearedBindingAdoption,
  declinedBindingEntries,
  latestBindingAdoption,
  normalizeBindingAdoption,
  readBindingAdoption,
  readBindingAdoptionRecord,
  withBindingAdoption,
} from '../internal/binding-adoption.js'
import { readRuntimeMessage } from '../internal/runtime-messages.js'
import { createSessionLogProjection, projectSessionLog } from '../internal/session-log-view.js'

const adoption = declined => ({ schema: BINDING_ADOPTION_SCHEMA, declined })

test('binding adoption normalizes to one sorted, closed decision record', () => {
  const normalized = normalizeBindingAdoption(adoption(['second', 'first']))
  assert.deepEqual(normalized, adoption(['first', 'second']))
  assert.equal(Object.isFrozen(normalized), true)
  assert.equal(Object.isFrozen(normalized.declined), true)
  assert.deepEqual(normalizeBindingAdoption(adoption([])), adoption([]))
})

test('binding adoption rejects records that could claim more than a withdrawal', () => {
  const invalid = [
    [adoption(['x']).declined, /invalid binding adoption/],
    [{ ...adoption([]), enabled: true }, /invalid binding adoption/],
    [{ schema: 'ptc-binding-adoption/v2', declined: [] }, /invalid binding adoption schema/],
    [{ schema: BINDING_ADOPTION_SCHEMA }, /invalid binding adoption/],
    [{ schema: BINDING_ADOPTION_SCHEMA, declined: 'x' }, /declined entries/],
    [{ schema: BINDING_ADOPTION_SCHEMA, declined: Array.from({ length: 65 }, (_, index) => `id-${index}`) }, /declined entries/],
    [adoption(['not an id']), /entry id/],
    [adoption([7]), /entry id/],
    [adoption(['twice', 'twice']), /duplicate binding adoption entry id/],
  ]
  for (const [value, expected] of invalid) assert.throws(() => normalizeBindingAdoption(value), expected)
})

test('an adoption record is recognized only as its exact recorded wording', () => {
  const message = bindingAdoptionMessage(adoption(['beta', 'alpha']))
  assert.equal(message.source.form, BINDING_ADOPTION_FORM)
  assert.deepEqual(readBindingAdoption(message), adoption(['alpha', 'beta']))
  assert.equal(message.content[0].text, bindingAdoptionText(adoption(['alpha', 'beta'])))
  assert.equal(readBindingAdoption({ ...message, source: { ...message.source, kind: 'plugin', plugin: 'ptc-plus' } })?.declined.length, 2)
  const cases = [
    undefined,
    { source: { kind: 'user' }, content: message.content },
    { source: { kind: message.source.kind, form: 'snapshot' }, content: message.content },
    { source: message.source, content: [] },
    { source: message.source, content: [{ type: 'image' }] },
    { source: message.source, content: [{ type: 'text', text: 4 }] },
    { source: message.source, content: [{ type: 'text', text: 'PTC Plus session binding adoption.\n[]' }] },
    { source: message.source, content: [{ type: 'text', text: `${bindingAdoptionText(adoption([]))} ` }] },
    { source: message.source, content: [{ type: 'text', text: bindingAdoptionText(adoption([])).replace('\n[]', '\n{}') }] },
    { source: message.source, content: [{ type: 'text', text: bindingAdoptionText(adoption([])).replace('\n[]', '\nnot json') }] },
  ]
  for (const value of cases) assert.equal(readBindingAdoption(value), undefined)
})

test('declining and re-adopting one entry leaves the other decisions alone', () => {
  const first = withBindingAdoption(undefined, 'alpha', false)
  assert.deepEqual(first.declined, ['alpha'])
  const both = withBindingAdoption(first, 'beta', false)
  assert.deepEqual(both.declined, ['alpha', 'beta'])
  assert.deepEqual(withBindingAdoption(both, 'alpha', true).declined, ['beta'])
  assert.deepEqual(withBindingAdoption(clearedBindingAdoption(), 'alpha', true).declined, [])
  assert.deepEqual([...declinedBindingEntries(undefined)], [])
  assert.deepEqual([...declinedBindingEntries(both)], ['alpha', 'beta'])
  assert.throws(() => withBindingAdoption(undefined, 'bad id', false), /entry id/)
  assert.throws(() => withBindingAdoption(undefined, 'alpha', 'yes'), /must be a boolean/)
})

test('the newest adoption record is the session decision', () => {
  const records = [
    { form: 'snapshot', sections: [] },
    { form: BINDING_ADOPTION_FORM, declined: ['alpha'] },
    { form: 'catalog', sections: [] },
    { form: BINDING_ADOPTION_FORM, declined: ['beta'] },
  ]
  assert.deepEqual(latestBindingAdoption(records), adoption(['beta']))
  assert.equal(latestBindingAdoption(undefined), undefined)
  assert.equal(latestBindingAdoption([{ form: 'catalog' }]), undefined)
  assert.equal(latestBindingAdoption([{ form: BINDING_ADOPTION_FORM, declined: ['bad id'] }]), undefined)
})

test('a committed adoption record this build cannot read reads as no record', () => {
  // A record states a decision only while its payload is this vocabulary, so a damaged one
  // reads as no record here and no reader can turn it into a withdrawal the session made.
  const readable = { seq: 1, type: BINDING_ADOPTION_RECORD, ignorable: true, data: adoption(['alpha']) }
  assert.deepEqual(readBindingAdoptionRecord(readable), adoption(['alpha']))
  assert.equal(readBindingAdoptionRecord({ ...readable,
    data: { schema: BINDING_ADOPTION_SCHEMA, declined: 'alpha' } }), undefined)
  // The record type alone is no decision either: a node the fold does not carry as ignorable,
  // or a different carrier, states nothing about this session's adoption.
  assert.equal(readBindingAdoptionRecord({ ...readable, ignorable: false }), undefined)
  assert.equal(readBindingAdoptionRecord({ ...readable, type: 'user/message' }), undefined)
})

test('a newest adoption record this build cannot read is a state, not a fallback', () => {
  // The session stated something newer than the readable record below it. Since
  // that statement cannot be resolved, neither it nor the record it superseded can
  // answer: `latestBindingAdoption` reports no decision to apply, and the
  // classification names the reason so a reader never mistakes it for "none".
  const records = [
    { form: BINDING_ADOPTION_FORM, declined: ['beta'] },
    { form: BINDING_ADOPTION_FORM, declined: ['alpha'] },
    { form: BINDING_ADOPTION_FORM, declined: 'damaged' },
  ]
  assert.equal(latestBindingAdoption(records), undefined)
  assert.deepEqual(classifyBindingAdoption(records), { state: 'unreadable' })
  assert.deepEqual(classifyBindingAdoption([{ form: 'catalog', sections: [] }]), { state: 'none' })
  assert.deepEqual(classifyBindingAdoption([{ form: BINDING_ADOPTION_FORM, declined: ['alpha'] }]),
    { state: 'decided', adoption: adoption(['alpha']) })
})

test('a session log records and reconstructs its own binding adoption', () => {
  const session = Session.create('binding-adoption-log')
  const projected = () => projectSessionLog({ session: { events: session.snapshotEvents() } })
  const message = bindingAdoptionMessage(adoption(['alpha']))
  session.append('user/message', message, { surfaceOp: 'append' })
  assert.deepEqual(readRuntimeMessage(message), { form: BINDING_ADOPTION_FORM, declined: ['alpha'] })
  const view = projected()
  assert.deepEqual(view.ptcMessages.filter(record => record.form === BINDING_ADOPTION_FORM)
    .map(record => record.declined), [['alpha']])
  assert.deepEqual(latestBindingAdoption(view.ptcMessages), adoption(['alpha']))
  // A second decision replaces the first one instead of accumulating with it.
  session.append('user/message', bindingAdoptionMessage(adoption(['beta'])), { surfaceOp: 'append' })
  assert.deepEqual(latestBindingAdoption(projected().ptcMessages), adoption(['beta']))
  // An unrelated PTC message is not evidence of a decision.
  session.append('user/message', createUserMessage({ source: { kind: 'plugin:ptc-plus', form: 'instructions' },
    content: [{ type: 'text', text: 'unrelated' }] }), { surfaceOp: 'append' })
  assert.deepEqual(latestBindingAdoption(projected().ptcMessages), adoption(['beta']))
})

test('a session statement this build cannot read stays the newest adoption record', () => {
  // The projection and the `/binding` command answer from `ptcMessages`, and the answer
  // is this session's newest statement. Dropping a statement that cannot be resolved
  // would let the record it superseded answer instead, so the statement is retained
  // without a declined list and every consumer reports no decision to apply.
  const session = Session.create('binding-adoption-unreadable-log')
  session.append('user/message', bindingAdoptionMessage(adoption(['beta'])), { surfaceOp: 'append' })
  const damaged = createUserMessage({ source: { kind: 'plugin:ptc-plus', form: BINDING_ADOPTION_FORM },
    content: [{ type: 'text', text: 'PTC Plus session binding adoption. Declined entry IDs:\ndamaged' }] })
  session.append('user/message', damaged, { surfaceOp: 'append' })
  assert.equal(readRuntimeMessage(damaged), undefined)
  const events = session.snapshotEvents()
  const nodes = events.map(event => event.seq)
  const view = projectSessionLog({ session: { events, surface: { nodes } } })
  // The statement is in the projection, and its absence of a declined list is what
  // marks it unreadable rather than absent.
  assert.deepEqual(view.ptcMessages.filter(record => record.form === BINDING_ADOPTION_FORM)
    .map(record => record.declined), [['beta'], undefined])
  assert.equal(latestBindingAdoption(view.ptcMessages), undefined)
  assert.deepEqual(classifyBindingAdoption(view.ptcMessages), { state: 'unreadable' })
  // The raw log answers the same question through the same owner, so the panel and the
  // command cannot disagree about which record governs this session.
  assert.deepEqual(bindingAdoptionOf(events), { state: 'unreadable' })
  // The ordered model-visible surface carries resolvable messages only.
  assert.deepEqual(view.visibleRuntimeMessages.filter(record => record?.form === BINDING_ADOPTION_FORM)
    .map(record => record.declined), [['beta']])
})

test('the projection admits the checkpoint it writes for an unreadable statement', () => {
  // Admission replays the facts the fold retained and compares the result with the
  // stored state. A record the fold appends from a fact that did not carry its own form
  // could never be reproduced from that fact, so a valid session would refuse to
  // restore and every load would refold the whole log.
  const session = Session.create('binding-adoption-checkpoint')
  session.append('user/message', bindingAdoptionMessage(adoption(['beta'])), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ source: { kind: 'plugin:ptc-plus', form: BINDING_ADOPTION_FORM },
    content: [{ type: 'text', text: 'PTC Plus session binding adoption. Declined entry IDs:\ndamaged' }] }),
  { surfaceOp: 'append' })
  const projection = createSessionLogProjection()
  let state = projection.init()
  for (const event of session.snapshotEvents()) state = projection.apply(state, event)
  // The unreadable statement is in the checkpoint this build writes...
  assert.deepEqual(state.ptcMessages.filter(record => record.form === BINDING_ADOPTION_FORM)
    .map(record => record.declined), [['beta'], undefined])
  // ...and the same build accepts it, which is what proves the fold is a function of
  // the facts it keeps rather than of the log it was handed.
  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(state))), state)
})
