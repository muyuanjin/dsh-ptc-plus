import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROMPT_ANCHORS,
  PROMPT_REASON_CODES,
  PROMPT_SLOTS,
  PROMPT_TEXT_DEFAULT,
  PROMPT_TEXT_MAX_ANCHOR_BYTES,
  PROMPT_TEXT_MAX_DOCUMENT_BYTES,
  PROMPT_TEXT_MAX_SLOT_BYTES,
  PROMPT_TEXT_SCHEMA,
  accountPromptText,
  anchorSlotMap,
  promptAnchor,
  promptAnchorOfSlot,
  promptAssetText,
  promptSlot,
  promptTextDocument,
  resolvePromptText,
  resolvePromptTextConfig,
  validatePromptTextDocument,
} from '../internal/prompt-text.js'
import { resolveConfig } from '../internal/runtime-config.js'

const document = overrides => JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides })
// A registry literal carries its text; an editable slot on a channel that is not
// wired yet is declared with `null` and must not be treated as a literal default.
const literalSlots = PROMPT_SLOTS.filter(slot => slot.source === 'registry-literal' && slot.defaultText !== null)
const shot = (resolved, id) => resolved.text(id)

test('an empty configuration resolves every literal slot to its registered default', () => {
  const resolved = resolvePromptText(PROMPT_TEXT_DEFAULT)
  assert.deepEqual(resolved.reported, [])
  for (const slot of literalSlots) {
    assert.equal(shot(resolved, slot.id), slot.defaultText, slot.id)
    assert.equal(resolved.omitted(slot.id), false, slot.id)
    assert.equal(resolved.overridden(slot.id), false, slot.id)
    assert.ok(slot.defaultText.trim().length > 0, slot.id)
  }
  const generated = PROMPT_SLOTS.filter(slot => slot.source !== 'registry-literal')
  assert.ok(generated.length > 0, 'the registry must show at least one generated slot')
  for (const slot of generated) assert.equal(shot(resolved, slot.id), null, slot.id)
  assert.equal(new Set(PROMPT_SLOTS.map(slot => slot.id)).size, PROMPT_SLOTS.length)
})

test('the empty document is valid and every anchor stays under its byte ceilings', () => {
  assert.doesNotThrow(() => validatePromptTextDocument(PROMPT_TEXT_DEFAULT))
  assert.doesNotThrow(() => resolveConfig({ promptText: PROMPT_TEXT_DEFAULT }))
  const account = accountPromptText(resolvePromptText(PROMPT_TEXT_DEFAULT))
  let document = 0
  for (const entry of account.anchors) {
    document += entry.bytes
    assert.ok(entry.bytes <= PROMPT_TEXT_MAX_ANCHOR_BYTES, `${entry.anchorId}: ${entry.bytes} B exceeds the anchor ceiling`)
  }
  assert.ok(document <= PROMPT_TEXT_MAX_DOCUMENT_BYTES, `default document is ${document} B, above the document ceiling`)
  for (const slot of account.slots) {
    if (!slot.measured) continue
    assert.ok(slot.bytes <= PROMPT_TEXT_MAX_SLOT_BYTES, `${slot.slotId} exceeds its slot ceiling`)
  }
})

test('every slot declares a channel, a kind and an ownership that matches its reason', () => {
  const channels = new Set(PROMPT_ANCHORS.map(anchor => anchor.channel))
  for (const anchor of PROMPT_ANCHORS) {
    assert.ok(channels.has(anchor.channel), anchor.id)
    assert.ok(anchor.presence.trim().length > 0, anchor.id)
    assert.ok(anchor.slots.length > 0, anchor.id)
    assert.deepEqual(anchorSlotMap()[anchor.id], anchor.slots.map(slot => slot.id), anchor.id)
    for (const slot of anchor.slots) {
      assert.ok(['literal', 'aggregate', 'projected'].includes(slot.kind), slot.id)
      assert.equal(promptAnchorOfSlot(slot.id).id, anchor.id, slot.id)
      if (slot.owner === 'A') {
        assert.equal(slot.reason, null, `${slot.id}: an editable slot has no reason code`)
        assert.equal(slot.omittable && slot.defaultText.trim().length === 0, false, slot.id)
      } else {
        assert.ok(PROMPT_REASON_CODES.includes(slot.reason), `${slot.id}: read-only slots name a reason code`)
        assert.equal(slot.omittable, false, `${slot.id}: a read-only slot cannot be omitted`)
      }
    }
  }
})

test('an override replaces exactly one slot and leaves the others untouched', () => {
  const replaced = resolvePromptText(document({ 'guidance.opening': 'Open with the project convention.' }))
  assert.equal(shot(replaced, 'guidance.opening'), 'Open with the project convention.')
  assert.equal(replaced.overridden('guidance.opening'), true)
  for (const slot of PROMPT_SLOTS) {
    if (slot.id === 'guidance.opening') continue
    assert.equal(shot(replaced, slot.id), slot.defaultText, slot.id)
  }
  assert.deepEqual(replaced.reported, [])
})

test('an omittable slot becomes empty and a required slot keeps its default', () => {
  const resolved = resolvePromptText(document({
    'guidance.errorRecovery': '',
    'runCode.description': '',
  }))
  assert.equal(shot(resolved, 'guidance.errorRecovery'), '')
  assert.equal(resolved.omitted('guidance.errorRecovery'), true)
  assert.equal(shot(resolved, 'runCode.description'), promptSlot('runCode.description').defaultText)
  assert.deepEqual(resolved.reported, [{
    slotId: 'runCode.description', anchorId: 'run_code', reason: 'required-slot-empty',
  }])
})

test('saving rejects a required empty value and names the slot', () => {
  assert.throws(() => validatePromptTextDocument(document({ 'runCode.description': '   ' })),
    /runCode\.description must not be empty/u)
  assert.throws(() => validatePromptTextDocument(document({ 'guidance.opening': '   ' })),
    /guidance\.opening must not be empty/u)
  // An omittable slot may be emptied: that is how a paragraph is dropped.
  assert.doesNotThrow(() => validatePromptTextDocument(document({ 'guidance.cellConventions': '   ' })))
})

test('saving rejects a read-only slot and the resolver reports it without throwing', () => {
  const readOnly = document({ 'guidance.derivedPolicy': 'Rewritten policy sentence.' })
  assert.throws(() => validatePromptTextDocument(readOnly), /guidance\.derivedPolicy is read-only \(fact-derived\)/u)
  const resolved = resolvePromptText(readOnly)
  assert.equal(shot(resolved, 'guidance.derivedPolicy'), null)
  assert.deepEqual(resolved.reported, [{
    slotId: 'guidance.derivedPolicy', anchorId: 'tools:ptc-plus-repl', reason: 'not-writable',
  }])
})

test('slot, anchor and document ceilings apply in that order', () => {
  assert.throws(() => validatePromptTextDocument(document({
    'guidance.opening': 'a'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES + 1),
  })), /guidance\.opening would deliver 4097 bytes, over the 4096 byte slot limit/u)

  const perSlot = Math.floor(PROMPT_TEXT_MAX_ANCHOR_BYTES / 5) + 1
  assert.ok(perSlot <= PROMPT_TEXT_MAX_SLOT_BYTES)
  const oversizedAnchor = Object.fromEntries([
    'guidance.opening', 'guidance.errorRecovery', 'guidance.cellConventions',
    'guidance.capabilities', 'guidance.executionWorld',
  ].map(id => [id, 'b'.repeat(perSlot)]))
  assert.throws(() => validatePromptTextDocument(document(oversizedAnchor)),
    /anchor tools:ptc-plus-repl would deliver \d+ bytes, over the 16384 byte anchor limit \(at slot /u)

  const many = {}
  for (let index = 0; index < 20; index += 1) many[`stale.slot.${index}`] = 'c'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES)
  assert.throws(() => validatePromptTextDocument(document(many)),
    new RegExp(String(PROMPT_TEXT_MAX_DOCUMENT_BYTES), 'u'))
})

test('a malformed document throws on save and degrades to the built-in prompt on render', () => {
  for (const invalid of ['not json', '{}', '[]', JSON.stringify({ schema: 'other/v1', overrides: {} }),
    JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides: [] })]) {
    assert.throws(() => validatePromptTextDocument(invalid))
    const resolved = resolvePromptText(invalid)
    assert.equal(shot(resolved, 'guidance.opening'), promptSlot('guidance.opening').defaultText)
    assert.equal(resolved.reported.length, 1)
    assert.equal(typeof resolved.reported[0].reason, 'string')
  }
})

test('an unknown slot id stays readable and inert instead of failing the load', () => {
  const stale = document({ 'guidance.removedInALaterVersion': 'keep this text' })
  assert.equal(validatePromptTextDocument(stale).overrides['guidance.removedInALaterVersion'], 'keep this text')
  const resolved = resolvePromptText(stale)
  assert.deepEqual(resolved.reported, [{
    slotId: 'guidance.removedInALaterVersion', anchorId: undefined, reason: 'unknown-slot',
  }])
  for (const slot of PROMPT_SLOTS) assert.equal(shot(resolved, slot.id), slot.defaultText, slot.id)
})

test('C ownership is reachable: mixed anchors account for user-owned bytes without fabricating them', () => {
  const accounted = accountPromptText(resolvePromptText(PROMPT_TEXT_DEFAULT))
  const byAnchor = new Map(accounted.anchors.map(anchor => [anchor.anchorId, anchor]))
  const mixed = byAnchor.get('tools:ptc-plus-user-binding-defaults')
  assert.equal(mixed.owner, 'mixed')
  assert.deepEqual(mixed.slots.map(slot => slot.owner).sort(), ['A', 'C'])
  // The user's instructions have no registry literal, so their bytes are only
  // knowable at assembly time; the slot is counted and marked unmeasured instead
  // of contributing a fabricated zero to owners.C.
  const instructions = mixed.slots.find(slot => slot.owner === 'C')
  assert.equal(instructions.measured, false)
  assert.equal(instructions.bytes, 0)
  // The anchor is wired, so this is a dynamic slot: its bytes appear when the
  // composer runs, not because a channel is missing.
  assert.equal(instructions.dynamic, true)
  assert.equal(instructions.unwired, false)
  assert.equal(accounted.owners.C, 0)
  assert.equal(accounted.counts.slots.C, 2, 'one C slot on the mixed anchor and one on the catalog')
  assert.equal(accounted.counts.unmeasured.C, 0)
  assert.equal(accounted.counts.dynamic.C, 2)
  assert.equal(accounted.counts.pure.C, 0, 'the catalog anchor now carries its A-owned envelope too')
  assert.equal(byAnchor.get('binding-catalog').owner, 'mixed')
  const catalog = byAnchor.get('binding-catalog')
  assert.deepEqual([...new Set(catalog.slots.map(slot => slot.owner))].sort(), ['A', 'B', 'C'])
  assert.equal(catalog.slots.find(slot => slot.owner === 'C').measured, false,
    'the user-authored instructions stay unmeasured until assembly')
})

test('byte accounting reconciles slots, anchors and owner totals', () => {
  const resolved = resolvePromptText(document({ 'guidance.opening': 'Shorter opening.' }))
  const account = accountPromptText(resolved)
  assert.equal(account.slots.length, PROMPT_SLOTS.length)
  // Thirteen anchors: five wired today plus eight declared for channels this build
  // does not deliver through the resolver yet, so their slots stay unmeasured.
  // The two slot labels answer different questions and are never summed:
  // 未测槽 covers the channels this build has not wired (capability appendix), and
  // 动态槽 the wired anchors whose composer produces the bytes at assembly time
  // (derived policy, user instructions, the tip prefix and the catalog prefix).
  assert.deepEqual(account.counts, {
    pure: { A: 5, B: 3, C: 0 }, mixed: 5, total: PROMPT_ANCHORS.length,
    slots: { A: 25, B: 15, C: 2 },
    unmeasured: { A: 0, B: 2, C: 0 },
    dynamic: { A: 0, B: 3, C: 2 },
    unmeasuredSlots: 2,
    dynamicSlots: 5,
  })
  assert.deepEqual(account.anchors.map(anchor => anchor.anchorId), PROMPT_ANCHORS.map(anchor => anchor.id))

  const slotSum = account.slots.reduce((total, slot) => total + slot.bytes, 0)
  assert.equal(account.owners.A + account.owners.B + account.owners.C, slotSum)
  for (const anchor of account.anchors) {
    const anchorSum = anchor.slots.reduce((total, slot) => total + slot.bytes, 0)
    assert.equal(anchor.bytes, anchorSum, anchor.anchorId)
  }
  const opening = account.slots.find(slot => slot.slotId === 'guidance.opening')
  assert.equal(opening.overridden, true)
  assert.equal(opening.bytes, new TextEncoder().encode('Shorter opening.').length)

  const derived = account.slots.find(slot => slot.slotId === 'guidance.derivedPolicy')
  assert.equal(derived.measured, false, 'a generated slot is unmeasured, not empty')
  assert.equal(derived.bytes, 0)
  assert.equal(derived.owner, 'B')
  assert.equal(derived.reason, 'fact-derived')
  assert.equal(derived.dynamic, true, 'its anchor is wired, so it is dynamic rather than unwired')
})

test('a composer cannot request a generated slot instead of the code that renders it', () => {
  const resolved = resolvePromptText(PROMPT_TEXT_DEFAULT)
  assert.throws(() => promptAssetText(resolved, 'guidance.derivedPolicy'),
    /guidance\.derivedPolicy is generated by internal\/binding-update-policy\.js/u)
  assert.throws(() => promptAssetText(undefined, 'guidance.derivedPolicy'), /may only request registry literals/u)
  // The literal path still returns text, so a composer that forgot the document keeps working.
  assert.equal(promptAssetText(undefined, 'guidance.opening'), promptSlot('guidance.opening').defaultText)
})

test('a document whose effective bytes exceed an anchor cap is rejected even when every override is small', () => {
  // One slot just under the slot cap plus the anchor's other literal defaults can
  // cross the anchor cap; effective bytes, not override payload, decide.
  const overrides = {}
  for (const id of ['guidance.errorRecovery', 'guidance.cellConventions', 'guidance.capabilities', 'guidance.executionWorld']) {
    overrides[id] = 'x'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES)
  }
  overrides['guidance.opening'] = 'y'.repeat(PROMPT_TEXT_MAX_SLOT_BYTES - 1)
  assert.throws(() => validatePromptTextDocument(document(overrides)),
    /anchor tools:ptc-plus-repl would deliver \d+ bytes, over the 16384 byte anchor limit/u)
})

test('the settings field validates through resolveConfig and resolves per request', () => {
  const configured = resolveConfig({ promptText: document({ 'guidance.capabilities': 'Use capabilities.search.' }) })
  assert.equal(configured.promptText, document({ 'guidance.capabilities': 'Use capabilities.search.' }))
  assert.equal(promptAssetText(resolvePromptText(configured.promptText), 'guidance.capabilities'),
    'Use capabilities.search.')
  assert.equal(promptAnchor('run_code').channel, 'prompt')
  assert.throws(() => promptAnchor('missing'), /unknown prompt anchor/u)
  assert.throws(() => promptSlot('missing'), /unknown prompt slot/u)
  assert.throws(() => resolveConfig({ promptText: '{"schema":"wrong","overrides":{}}' }), /promptText/u)
  assert.throws(() => resolveConfig({ promptText: 'not json' }), /valid JSON/u)
})

/**
 * The approved UI contract lists thirteen anchors. The registry must match it row
 * for row — id, channel, owner class and wiring state — so the panel cannot show a
 * different inventory from the contract it implements.
 */
const APPROVED_ANCHORS = Object.freeze([
  ['tools:ptc-plus-repl', 'prompt', 'mixed', true],
  ['tools:ptc-plus-user-binding-defaults', 'prompt', 'mixed', true],
  ['run_code', 'prompt', 'A', true],
  ['edit_run_code', 'install', 'A', true],
  ['binding-catalog', 'runtime', 'mixed', true],
  ['tools:sdk#capability-appendix', 'prompt', 'B', false],
  ['plan.navigation', 'plan', 'A', true],
  // The item set is frozen (owner B, reason aggregate-frozen) while its member
  // lines stay editable (owner A): the row the approved contract renders.
  ['plan.categories', 'plan', 'mixed', true],
  ['plan.overage', 'plan', 'A', true],
  ['runtime.recovery-snapshot', 'runtime', 'B', true],
  ['runtime.tip', 'runtime', 'mixed', true],
  ['result.rewrite-feedback', 'result', 'A', true],
  ['result.diagnostics-and-budget', 'result', 'B', true],
])

const ownerClassOf = anchor => {
  const owners = new Set(anchor.slots.map(slot => slot.owner))
  return owners.size === 1 ? [...owners][0] : 'mixed'
}

test('the registry lists exactly the thirteen anchors of the approved contract', () => {
  assert.equal(PROMPT_ANCHORS.length, APPROVED_ANCHORS.length)
  for (const [id, channel, owner, wired] of APPROVED_ANCHORS) {
    const anchor = PROMPT_ANCHORS.find(candidate => candidate.id === id)
    assert.ok(anchor !== undefined, `missing anchor ${id}`)
    assert.equal(anchor.channel, channel, `${id} channel`)
    assert.equal(ownerClassOf(anchor), owner, `${id} owner class`)
    assert.equal(anchor.wired === true, wired, `${id} wiring state`)
  }
  assert.deepEqual(PROMPT_ANCHORS.map(anchor => anchor.id), APPROVED_ANCHORS.map(([id]) => id))
})

test('an unwired anchor is declared with unmeasured slots, never a measured zero', () => {
  const account = accountPromptText(resolvePromptText(PROMPT_TEXT_DEFAULT))
  for (const anchor of PROMPT_ANCHORS.filter(candidate => candidate.wired !== true)) {
    assert.ok(anchor.presence.trim().length > 0, `${anchor.id} states when it is delivered`)
    for (const slot of anchor.slots) {
      if (slot.owner !== 'A') assert.equal(slot.defaultText, null, `${anchor.id}/${slot.id} must not fake a default`)
      assert.ok(PROMPT_REASON_CODES.includes(slot.reason) || slot.owner === 'A', `${slot.id} names a reason`)
    }
    const row = account.anchors.find(candidate => candidate.anchorId === anchor.id)
    assert.equal(row.wired, false)
    assert.equal(row.bytes, 0)
    assert.equal(row.unmeasuredSlots, anchor.slots.length)
  }
  const plan = account.channels.find(entry => entry.channel === 'plan')
  assert.equal(plan.wired, 3, 'the plan channel is wired end to end')
  assert.equal(plan.unmeasuredSlots, 0)
})

test('unmeasured and dynamic slots stay separate labels, and 未纳管 is gone', () => {
  const account = accountPromptText(resolvePromptText(PROMPT_TEXT_DEFAULT))
  // 未纳管 is intentionally absent: a slot always has an owner, so a counter for
  // "anchor without owner" can only ever print zero and would read as assurance.
  assert.equal(Object.hasOwn(account.counts, 'unowned'), false)
  // 未测槽 is exactly the slots on channels this build has not wired (2: the
  // capability appendix prose and its declarations).
  const unwiredSlots = account.slots.filter(slot => slot.unwired).length
  assert.equal(unwiredSlots, 2)
  assert.equal(account.counts.unmeasuredSlots, 2)
  // 动态槽 is exactly the wired slots without a literal default (5). Splitting the
  // single unmeasured `tip.prefix` into two measured literals removes one dynamic
  // slot and adds no replacement, because both prefixes now carry their bytes.
  const dynamicSlots = account.slots.filter(slot => slot.dynamic).length
  assert.equal(dynamicSlots, 5)
  assert.equal(account.counts.dynamicSlots, 5)
  // An aggregate container owns a set, not text: it is measured:false but is
  // neither an unwired channel nor a dynamic composer, so the partition excludes it.
  const containers = account.slots.filter(slot => slot.kind === 'aggregate')
  assert.equal(containers.length, 1)
  assert.deepEqual(containers.map(slot => [slot.measured, slot.unwired, slot.dynamic]), [[false, false, false]])
  assert.equal(unwiredSlots + dynamicSlots + containers.length,
    account.slots.filter(slot => !slot.measured).length,
    'every unmeasured slot is unwired, dynamic, or an aggregate container')
  assert.deepEqual(
    account.slots.filter(slot => slot.dynamic).map(slot => slot.slotId).sort(),
    ['catalog.entryInstructions', 'guidance.derivedPolicy', 'result.diagnosticsCodes',
      'result.diagnosticsProse', 'userBindings.entryInstructions'].sort(),
  )
  assert.equal(account.anchors.length, 13)
  assert.equal(account.counts.total, 13)
})

test('the pause switch withholds the document from every consumer', () => {
  const document = JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides: { 'guidance.opening': 'Custom opening.' } })

  // On (the default): the override resolves and the first anchor changes.
  const on = resolvePromptTextConfig({ promptText: document, capabilityPromptTextEnabled: true })
  assert.equal(on.text('guidance.opening'), 'Custom opening.')

  // Off: consumers get the built-in text, and the document never reaches them.
  const off = resolvePromptTextConfig({ promptText: document, capabilityPromptTextEnabled: false })
  assert.equal(promptTextDocument({ promptText: document, capabilityPromptTextEnabled: false }), undefined)
  assert.equal(off.text('guidance.opening'), promptSlot('guidance.opening').defaultText)
  assert.deepEqual(off.reported, [])

  // A configuration written before the switch existed behaves as "on".
  assert.equal(resolvePromptTextConfig({ promptText: document }).text('guidance.opening'), 'Custom opening.')
  // The switch is part of the capabilities group, so the resolved defaults carry it.
  assert.equal(resolveConfig({}).capabilityPromptTextEnabled, true)
})
