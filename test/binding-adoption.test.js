import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import {
  BINDING_ADOPTION_FORM,
  BINDING_ADOPTION_SCHEMA,
  bindingAdoptionMessage,
  bindingAdoptionText,
  clearedBindingAdoption,
  declinedBindingEntries,
  latestBindingAdoption,
  normalizeBindingAdoption,
  readBindingAdoption,
  withBindingAdoption,
} from '../internal/binding-adoption.js'
import { readRuntimeMessage } from '../internal/runtime-messages.js'
import { projectSessionLog } from '../internal/session-log-view.js'

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
