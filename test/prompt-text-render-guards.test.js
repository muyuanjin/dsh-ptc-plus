import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROMPT_ANCHORS, PROMPT_TEXT_DEFAULT, PROMPT_TEXT_SCHEMA, PROMPT_SLOTS, accountPromptText, resolvePromptText,
  validatePromptTextDocument,
  PROMPT_TEXT_MAX_ANCHOR_BYTES, PROMPT_TEXT_MAX_DOCUMENT_BYTES, PROMPT_TEXT_MAX_SLOT_BYTES,
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

/**
 * Every writable literal slot of one shipped anchor.
 *
 * The ceilings are per anchor and per document, so a case that reaches one of
 * them has to be built from the anchor membership the resolver actually reads
 * instead of a hand-written list that can drift from it.
 */
function writableLiteralSlots(anchorId) {
  const byId = new Map(PROMPT_SLOTS.map(slot => [slot.id, slot]))
  const anchor = PROMPT_ANCHORS.find(entry => entry.id === anchorId)
  assert.ok(anchor !== undefined, `the fixture anchor ${anchorId} must exist`)
  return anchor.slots
    .map(slot => byId.get(slot.id))
    .filter(slot => slot !== undefined && slot.owner === 'A' && slot.kind !== 'projected'
      && typeof slot.defaultText === 'string')
}

const utf8 = text => Buffer.byteLength(text ?? '', 'utf8')

/**
 * Slot-ceiling overrides that every anchor ceiling accepts.
 *
 * The most a document can carry: each anchor takes another 4096-byte override
 * while its own delivered bytes stay inside the anchor ceiling, which is the
 * rule the effective-bytes pass applies.
 */
function slotCeilingOverrides(filler) {
  const byId = new Map(PROMPT_SLOTS.map(slot => [slot.id, slot]))
  const overrides = {}
  for (const anchor of PROMPT_ANCHORS) {
    let anchorBytes = anchor.slots.reduce((sum, slot) => sum + utf8(slot.defaultText), 0)
    for (const entry of anchor.slots) {
      const slot = byId.get(entry.id)
      if (slot === undefined || slot.owner !== 'A' || slot.kind !== 'literal'
        || typeof slot.defaultText !== 'string') continue
      const delta = PROMPT_TEXT_MAX_SLOT_BYTES - utf8(slot.defaultText)
      if (anchorBytes + delta > PROMPT_TEXT_MAX_ANCHOR_BYTES) continue
      anchorBytes += delta
      overrides[slot.id] = filler.repeat(PROMPT_TEXT_MAX_SLOT_BYTES)
    }
  }
  return overrides
}

test('an anchor whose own overrides exceed its ceiling is refused at resolve time', () => {
  // Five 4096-byte overrides fit the slot ceiling and share one anchor, so the
  // fifth crosses the 16384-byte anchor ceiling before any literal default is
  // counted. This is the resolve-time refusal, distinct from the effective-bytes
  // pass that later drops the four accepted siblings once the anchor's remaining
  // literals are added.
  const slots = writableLiteralSlots('tools:ptc-plus-repl')
  assert.equal(slots.length, 5, 'the fixture needs more than four slots in one anchor')
  const overrides = {}
  for (const slot of slots) overrides[slot.id] = 'a'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES)
  const resolved = resolvePromptText(document(overrides))
  assert.equal(resolved.reported.filter(entry => entry.reason === 'anchor-exceeds-limit').length,
    slots.length, 'every override of the over-budget anchor falls back')
  assert.equal(slots.some(slot => resolved.overridden(slot.id)), false)
  assert.equal(resolved.text(slots[0].id), slots[0].defaultText)
})

/** Bytes the document delivers: an override where it exists, else the literal. */
function deliveredBytes(overrides) {
  return PROMPT_SLOTS.reduce((sum, slot) => sum + (Object.hasOwn(overrides, slot.id)
    ? utf8(overrides[slot.id]) : utf8(slot.defaultText)), 0)
}

test('an unreadable override id spends the document budget even though it is never delivered', () => {
  // One override short of filling the document budget, so every anchor ceiling
  // holds and the defaults still fit. An unreadable id has no anchor to be
  // measured against and no slot ceiling, so its bytes alone are what makes the
  // document too large: the whole document falls back at resolve time.
  const overrides = slotCeilingOverrides('b')
  const [dropped] = Object.keys(overrides).sort().slice(-1)
  delete overrides[dropped]
  assert.ok(deliveredBytes(overrides) <= PROMPT_TEXT_MAX_DOCUMENT_BYTES,
    'the fixture must fit the document ceiling before the unreadable id')
  const accepted = resolvePromptText(document(overrides))
  assert.equal(accepted.reported.some(entry => entry.reason === 'document-exceeds-limit'), false)
  const unknown = 'no.such.slot'
  const withUnknown = resolvePromptText(document({ ...overrides, [unknown]: 'x'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES + 1) }))
  assert.deepEqual(withUnknown.reported.filter(entry => entry.reason === 'document-exceeds-limit'),
    [{ slotId: undefined, anchorId: undefined, reason: 'document-exceeds-limit' }],
    'the resolve-time pass refuses the document as a whole')
  assert.equal(withUnknown.reported.some(entry => entry.reason === 'unknown-slot' && entry.slotId === unknown), true)
  assert.equal(Object.keys(overrides).some(id => withUnknown.overridden(id)), false,
    'an unreadable id costs the document its other overrides rather than delivering past the ceiling')
})

test('defaults plus accepted overrides past the document ceiling fall back together', () => {
  // Every anchor accepts these overrides, so no anchor ceiling refuses one and
  // the overrides alone fill the document ceiling exactly. The literal defaults
  // the same document also delivers are what crosses it, and only the
  // effective-bytes pass can see them.
  const overrides = slotCeilingOverrides('c')
  const overrideBytes = Object.keys(overrides).reduce((sum, id) => sum + utf8(overrides[id]), 0)
  assert.equal(overrideBytes, PROMPT_TEXT_MAX_DOCUMENT_BYTES,
    'the fixture must exactly fill the document budget with overrides')
  assert.ok(deliveredBytes(overrides) > PROMPT_TEXT_MAX_DOCUMENT_BYTES,
    'the fixture must deliver more than the document ceiling in total')
  const resolved = resolvePromptText(document(overrides))
  assert.equal(resolved.reported.filter(entry => entry.reason === 'anchor-exceeds-limit').length, 0,
    'no anchor is over its own ceiling, so only the document ceiling can refuse these')
  assert.deepEqual(resolved.reported.filter(entry => entry.reason === 'document-exceeds-limit')
    .map(entry => entry.slotId).sort(), Object.keys(overrides).sort(),
  'the pass names every override it withdraws')
  assert.equal(Object.keys(overrides).some(id => resolved.overridden(id)), false)
})
