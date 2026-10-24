import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROMPT_TEXT_DEFAULT, PROMPT_TEXT_SCHEMA, PROMPT_SLOTS, accountPromptText, resolvePromptText,
  validatePromptTextDocument,
  PROMPT_TEXT_MAX_ANCHOR_BYTES, PROMPT_TEXT_MAX_SLOT_BYTES,
} from '../internal/prompt-text.js'
import { projectRuntimeMessages } from '../internal/runtime-contexts.js'
import { readRuntimeMessage, runtimeBindingCatalogMessage } from '../internal/runtime-messages.js'

const document = overrides => JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides })

test('render refuses an override over the slot ceiling even when it skipped validation', () => {
  const resolved = resolvePromptText(document({ 'guidance.opening': 'x'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES + 1) }))
  assert.equal(resolved.overridden('guidance.opening'), false)
  assert.equal(resolved.text('guidance.opening').startsWith('`run_code` continues'), true)
  assert.deepEqual(resolved.reported.filter(entry => entry.slotId === 'guidance.opening').map(entry => entry.reason),
    ['slot-exceeds-limit'])
})

test('render refuses an anchor whose effective bytes exceed the anchor ceiling', () => {
  // Four 4096-byte overrides fit the slot ceiling but deliver 16384 bytes with the
  // anchor's remaining literals; the draft path never ran validatePromptTextDocument.
  const overrides = {}
  for (const id of ['guidance.opening', 'guidance.errorRecovery', 'guidance.cellConventions', 'guidance.capabilities']) {
    overrides[id] = 'y'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES)
  }
  const resolved = resolvePromptText(document(overrides))
  const account = accountPromptText(resolved)
  const anchor = account.anchors.find(entry => entry.anchorId === 'tools:ptc-plus-repl')
  assert.ok(anchor.bytes <= PROMPT_TEXT_MAX_ANCHOR_BYTES,
    `delivered ${anchor.bytes} bytes, over the ${PROMPT_TEXT_MAX_ANCHOR_BYTES} byte anchor ceiling`)
  assert.equal(resolved.reported.some(entry => entry.reason === 'anchor-exceeds-limit'), true)
  assert.equal(Object.keys(overrides).some(id => resolved.overridden(id)), false,
    'every override of the over-budget anchor falls back together')
})

test('render refuses a projected override that drops its hole', () => {
  const resolved = resolvePromptText(document({ 'plan.overageSentence': 'Contracts exceed the budget.' }))
  assert.equal(resolved.overridden('plan.overageSentence'), false)
  assert.equal(resolved.text('plan.overageSentence').includes('{overageBytes}'), true)
  assert.deepEqual(resolved.reported.map(entry => entry.reason), ['missing-hole'])
  const duplicated = resolvePromptText(document({ 'plan.overageSentence': 'a {overageBytes} b {overageBytes}' }))
  assert.equal(duplicated.overridden('plan.overageSentence'), false, 'exactly one hole is required')
})

test('the save rule for placeholders matches what the resolver substitutes', () => {
  // `plan.navigationSentence` is a literal slot whose default shows
  // `capabilities.search({query})`. Nothing substitutes that token, so rewording
  // the sentence with or without it must both be savable; requiring the token
  // would reject legitimate rewording of an API example.
  const literalWith = document({ 'plan.navigationSentence': 'Call capabilities.search({query}) when unsure.' })
  const literalWithout = document({ 'plan.navigationSentence': 'Call capabilities.search when unsure.' })
  for (const candidate of [literalWith, literalWithout]) {
    assert.doesNotThrow(() => validatePromptTextDocument(candidate))
    assert.equal(resolvePromptText(candidate).overridden('plan.navigationSentence'), true)
  }
  // A projected slot is the opposite: its hole is the fact it reports.
  for (const value of ['No hole here.', 'two {overageBytes} holes {overageBytes}']) {
    assert.throws(() => validatePromptTextDocument(document({ 'plan.overageSentence': value })),
      /must keep exactly one \{overageBytes\} placeholder/u)
  }
  assert.doesNotThrow(() => validatePromptTextDocument(
    document({ 'plan.overageSentence': 'Contracts exceed the budget by {overageBytes}.' })))
})

test('a non-string promptText is reported instead of silently resolving to the default', () => {
  for (const value of [null, 42, {}, []]) {
    const resolved = resolvePromptText(value)
    assert.deepEqual(resolved.reported.map(entry => entry.reason), ['invalid-document-type'])
    assert.equal(resolved.text('guidance.opening'), resolvePromptText(PROMPT_TEXT_DEFAULT).text('guidance.opening'))
  }
  assert.deepEqual(resolvePromptText(undefined).reported, [], 'an absent document is not a defect')
})

test('a valid override survives oversize siblings, and the report names the real limit', () => {
  // The document counter must follow accepted overrides: summing raw payload first
  // would let oversize siblings clear a document that fits every ceiling. Enough
  // siblings are used that their raw payload alone passes the document ceiling.
  const editable = PROMPT_SLOTS.filter(slot => slot.owner === 'A' && typeof slot.defaultText === 'string')
  assert.ok(editable.length >= 20, 'the fixture needs enough editable slots to exceed the document ceiling')
  const overrides = { 'rewrite.class': 'kept because it fits' }
  for (const slot of editable.slice(0, 20)) overrides[slot.id] = 'z'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES + 8)
  assert.ok(20 * (PROMPT_TEXT_MAX_SLOT_BYTES + 8) > 65536, 'the raw payload alone exceeds the document ceiling')
  const resolved = resolvePromptText(document(overrides))
  assert.equal(resolved.overridden('rewrite.class'), true, 'the valid override survives')
  assert.equal(resolved.text('rewrite.class'), 'kept because it fits')
  assert.equal(resolved.reported.some(entry => entry.reason === 'document-exceeds-limit'), false,
    'the document limit is measured on accepted overrides only')
  assert.equal(resolved.reported.filter(entry => entry.reason === 'slot-exceeds-limit').length, 20)
})

test('an empty document still validates against every ceiling', () => {
  assert.doesNotThrow(() => validatePromptTextDocument(PROMPT_TEXT_DEFAULT))
})

test('a customised empty-catalog sentence is delivered once, because history and live delivery agree', () => {
  const resolved = resolvePromptText(document({ 'catalog.empty': 'Nichts dokumentiert.' }))
  const delivered = runtimeBindingCatalogMessage(undefined, { prompt: resolved })
  // The log view recognizes recorded messages without a document; the live path
  // recognizes with one. Both must see the same empty catalog, otherwise the
  // catalog looks changed and is re-delivered on every accepted step.
  const historyRecord = readRuntimeMessage(delivered)
  const view = { visibleRuntimeMessages: [], visibleRuntimeFacts: { catalog: historyRecord } }
  const first = projectRuntimeMessages(view, [], [delivered], { prompt: resolved })
  assert.deepEqual(first, [], 'no second delivery when the catalog is unchanged')
  const afterDelivery = { ...view, visibleRuntimeFacts: { catalog: readRuntimeMessage(first.at(-1) ?? delivered) } }
  assert.deepEqual(projectRuntimeMessages(afterDelivery, [], [delivered], { prompt: resolved }), [])
})
