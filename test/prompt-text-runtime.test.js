import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_CATALOG, PROMPT_SLOT_IDS, PROMPT_TEXT_DEFAULT, PROMPT_TEXT_SCHEMA, PREVIOUS_EMPTY_CATALOG,
  STATE_PREFIX, TIP_DETAIL_BINDING, TIP_DETAIL_CAPABILITY, accountPromptText, planCategorySlotId,
  promptAnchor, resolvePromptText, validatePromptTextDocument,
} from '../internal/prompt-text.js'
import { readRuntimeMessage, runtimeBindingCatalogMessage, runtimeStateMessage } from '../internal/runtime-messages.js'
import { latestRecoveryTip } from '../internal/recovery-tips.js'

const document = overrides => JSON.stringify({ schema: PROMPT_TEXT_SCHEMA, overrides })

test('a customised empty-catalog sentence is still recognised as a catalog', () => {
  const resolved = resolvePromptText(document({ 'catalog.empty': 'Nothing is configured yet.' }))
  const message = runtimeBindingCatalogMessage(undefined, { prompt: resolved })
  assert.equal(message.content[0].text.endsWith('Nothing is configured yet.'), true)
  // Recognition reads the record, not today's sentence: the live path and a
  // history replay that passes no document must agree, or deduplication would
  // conclude the catalog changed and re-deliver it on every step.
  const live = readRuntimeMessage(message, { prompt: resolved })
  const history = readRuntimeMessage(message)
  assert.deepEqual(live, history)
  assert.equal(live?.form, 'catalog')
  assert.deepEqual(live.sections, [])
})

test('a record written before the emptiness flag stays readable through the historical wording', () => {
  const previousPrefix = 'Global binding API catalog (PTC Plus). Replaces earlier binding catalogs only; remains applicable until the next binding catalog.'
  const legacy = message => ({ ...message, source: { kind: message.source.kind, form: 'catalog' } })
  const record = legacy(runtimeBindingCatalogMessage(undefined))
  assert.equal(record.source.empty, undefined, 'the fixture carries no flag, like a record from another version')
  assert.deepEqual(readRuntimeMessage(record)?.sections, [])
  const previous = { ...record, content: [{ type: 'text', text: `${previousPrefix}\n\n${EMPTY_CATALOG}` }] }
  assert.deepEqual(readRuntimeMessage(previous)?.sections, [])
  // A customised sentence in a flagless record is body text, not an empty catalog:
  // nothing in history claims it was written as one.
  const custom = { ...record, content: [{ type: 'text', text: `${previousPrefix}\n\nNothing is configured yet.` }] }
  assert.equal(readRuntimeMessage(custom)?.sections?.length, 1)
})

test('a customised empty sentence never blocks delivering a real catalog body', () => {
  // The user may write an empty-catalog sentence that happens to equal a real
  // catalog body. The delivery guard compares against the code-owned wording only,
  // so this must deliver instead of throwing and aborting the whole step.
  const body = 'function helpers.clean(value) returns a trimmed string.'
  const resolved = resolvePromptText(document({ 'catalog.empty': body }))
  const message = runtimeBindingCatalogMessage({ name: 'tools:ptc-plus-user-binding-defaults', text: body },
    { prompt: resolved })
  assert.equal(message.content[0].text.endsWith(`\n\n${body}`), true)
  assert.equal(message.source.empty, false)
  assert.deepEqual(readRuntimeMessage(message)?.sections,
    [{ name: 'tools:ptc-plus-user-binding-defaults', text: body }])
  // A body equal to the built-in empty wording is delivered like any other body:
  // emptiness travels in the source record, so the wording no longer decides, and
  // aborting here would drop the whole runtime channel for that step.
  const ambiguous = runtimeBindingCatalogMessage({ name: 'tools:ptc-plus-user-binding-defaults', text: EMPTY_CATALOG })
  assert.equal(ambiguous.source.empty, false)
  assert.deepEqual(readRuntimeMessage(ambiguous)?.sections,
    [{ name: 'tools:ptc-plus-user-binding-defaults', text: EMPTY_CATALOG }])
})

test('delivery and recognition agree, so a customised catalog is not re-delivered', () => {
  const resolved = resolvePromptText(document({ 'catalog.empty': 'Nothing is configured yet.' }))
  const delivered = runtimeBindingCatalogMessage(undefined, { prompt: resolved })
  // Deduplication compares the recognised sections of the last delivered catalog
  // with the live catalog; identical recognition means the live one is unchanged.
  const first = readRuntimeMessage(delivered, { prompt: resolved })
  const second = readRuntimeMessage(delivered, { prompt: resolved })
  assert.deepEqual(first, second)
  assert.deepEqual(first.sections, [])
  assert.equal(runtimeBindingCatalogMessage(undefined, { prompt: resolved }).content[0].text,
    delivered.content[0].text)
})

test('an empty document delivers the notification, snapshot and catalog text of today', () => {
  const resolved = resolvePromptText(PROMPT_TEXT_DEFAULT)
  assert.equal(resolved.text('catalog.empty'), EMPTY_CATALOG)
  assert.equal(runtimeBindingCatalogMessage(undefined, { prompt: resolved }).content[0].text,
    `${resolved.text('catalog.prefix')}\n\n${EMPTY_CATALOG}`)
  assert.equal(runtimeBindingCatalogMessage(undefined).content[0].text,
    runtimeBindingCatalogMessage(undefined, { prompt: resolved }).content[0].text)
  const plain = runtimeStateMessage([{ name: 'tools:ptc-plus-rewrite-info', text: 'body' }])
  assert.equal(plain.content[0].text, STATE_PREFIX + '\n\nbody')
  // The previous-generation empty sentence is historical wording, not a slot: no
  // composer delivers it, so it must not be overridable and stays readable only
  // through the frozen constants a recorded session points at.
  assert.equal(resolvePromptText(document({ 'catalog.previousEmpty': 'x' })).reported.length, 1)
  assert.equal(PREVIOUS_EMPTY_CATALOG.length > 0, true)
})

test('the plan category helper and the tip body resolve through the same document', () => {
  const resolved = resolvePromptText(PROMPT_TEXT_DEFAULT)
  assert.equal(planCategorySlotId('tool'), 'plan.category.tool')
  assert.equal(resolved.text('tip.body.platform').includes('{platformFacts}'), true,
    'the tip body keeps its facts hole so the code can fill it at render time')
})

test('both escalated tip sentences are registered read-only slots, not stray literals', () => {
  // An override of either detail sentence is refused at save time and reported as
  // read-only by the resolver: escalation owns whether the sentence appears, so the
  // text cannot be written, but its bytes are still accounted.
  for (const [slotId, literal] of [
    [PROMPT_SLOT_IDS.tipDetailBinding, TIP_DETAIL_BINDING],
    [PROMPT_SLOT_IDS.tipDetailCapability, TIP_DETAIL_CAPABILITY],
  ]) {
    assert.throws(() => validatePromptTextDocument(document({ [slotId]: 'custom' })), /read-only/iu,
      `${slotId}: saving a read-only detail sentence must be refused`)
    const resolved = resolvePromptText(document({ [slotId]: 'custom' }))
    assert.deepEqual(resolved.reported.map(entry => entry.slotId), [slotId])
    assert.equal(resolved.reported[0].reason, 'not-writable')
    assert.equal(resolved.text(slotId), literal, `${slotId}: the registered literal still delivers`)
  }

  const account = accountPromptText(resolvePromptText(PROMPT_TEXT_DEFAULT))
  const tipAnchor = account.anchors.find(anchor => anchor.anchorId === 'runtime.tip')
  const accounted = tipAnchor.slots.map(slot => slot.slotId)
  assert.ok(accounted.includes(PROMPT_SLOT_IDS.tipDetailBinding))
  assert.ok(accounted.includes(PROMPT_SLOT_IDS.tipDetailCapability))
  const bytes = account.slots
    .filter(slot => slot.slotId === PROMPT_SLOT_IDS.tipDetailBinding || slot.slotId === PROMPT_SLOT_IDS.tipDetailCapability)
    .reduce((total, slot) => total + slot.bytes, 0)
  assert.equal(bytes, new TextEncoder().encode(TIP_DETAIL_BINDING + TIP_DETAIL_CAPABILITY).length,
    'both sentences are measured, so the panel counter can see them')
})

test('an escalated tip delivers the registered detail sentence byte-for-byte', () => {
  const prompt = resolvePromptText(PROMPT_TEXT_DEFAULT)
  const escalated = { enabled: true, cooldownMessages: 0, escalationFailures: 0, prompt }
  const plain = { ...escalated, escalationFailures: 2 }

  const binding = latestRecoveryTip(tipView(BINDING_LOCAL), escalated)
  assert.equal(binding.text.endsWith(TIP_DETAIL_BINDING), true,
    'the escalated binding tip ends with the registered binding sentence, unchanged')
  const capability = latestRecoveryTip(tipView(BINDING_CAPABILITY), escalated)
  assert.equal(capability.text.endsWith(TIP_DETAIL_CAPABILITY), true,
    'the escalated capability tip ends with the registered capability sentence, unchanged')

  // Escalation still decides whether the sentence appears at all.
  assert.equal(latestRecoveryTip(tipView(BINDING_LOCAL), plain).text.includes(TIP_DETAIL_BINDING), false)
  // And the registry is the delivered source: the literal the slot stores is the
  // literal the tip carries, so deleting one of the slots cannot pass unnoticed.
  assert.equal(prompt.text(PROMPT_SLOT_IDS.tipDetailBinding), TIP_DETAIL_BINDING)
  assert.equal(prompt.text(PROMPT_SLOT_IDS.tipDetailCapability), TIP_DETAIL_CAPABILITY)
})

const TIP_BODIES = Object.freeze({
  'tip.body.platform': 'PLATFORM-BODY {platformFacts}',
  'tip.body.platformDetailed': 'PLATFORM-DETAILED {platformFacts}',
  'tip.body.repeatedBinding': 'BINDING-BODY{detail}',
  'tip.body.repeatedBindingCapability': 'CAPABILITY-BODY{detail}',
})

function tipView(diagnostics) {
  return {
    latestRun: {
      args: { code: 'return retainedMember({})' },
      journal: {
        status: 'durable',
        completion: { kind: 'throw', error: { kind: 'exception', message: 'failed' } },
        diagnostics,
      },
    },
    contextStep: 0,
    lastSuccessfulRunIndex: undefined,
    systemPromptSnapshots: [],
  }
}

const PLATFORM_DIAGNOSTICS = [{ code: 'PTC-X001', cause: { code: 'ENOENT', message: 'spawn npm ENOENT' } }]
const BINDING_LOCAL = [{ code: 'PTC-W001', cause: { code: 'PTC-LOCAL' } }]
const BINDING_CAPABILITY = [{ code: 'PTC-W001', cause: { code: 'PTC-CAPABILITY' } }]

test('each tip branch reads its own body slot, so every delivered body is editable', () => {
  const prompt = resolvePromptText(document(TIP_BODIES))
  const plain = { enabled: true, cooldownMessages: 0, escalationFailures: 2, prompt }
  const detailed = { ...plain, escalationFailures: 0 }

  const platform = latestRecoveryTip(tipView(PLATFORM_DIAGNOSTICS), plain)
  assert.match(platform.text, / PLATFORM-BODY `return \{ platform: process\.platform/,
    'the platform branch delivers the platform body, with its facts hole filled')

  const platformDetailed = latestRecoveryTip(tipView(PLATFORM_DIAGNOSTICS), detailed)
  assert.match(platformDetailed.text, / PLATFORM-DETAILED `return \{ platform: process\.platform/,
    'the escalated platform branch delivers the detailed platform body')

  const binding = latestRecoveryTip(tipView(BINDING_LOCAL), plain)
  assert.equal(binding.text.includes('BINDING-BODY'), true, 'the binding branch delivers the binding body')
  assert.equal(binding.text.includes('Earlier statements may have run'), false,
    'the detail hole stays empty while the failure is not escalated')

  const bindingDetailed = latestRecoveryTip(tipView(BINDING_LOCAL), detailed)
  assert.match(bindingDetailed.text, /BINDING-BODY Earlier statements may have run/,
    'the detail hole is filled when the failure escalates')

  const capability = latestRecoveryTip(tipView(BINDING_CAPABILITY), plain)
  assert.match(capability.text, / CAPABILITY-BODY/, 'the capability branch delivers the capability body')

  // Identity, cooldown and escalation are decided before the body renders, so a
  // customised body cannot move them.
  assert.match(platform.name, /^tools:ptc-plus-tip\/platform-command-failure\/1$/u)
  assert.match(binding.name, /^tools:ptc-plus-tip\/repeated-binding-failure\/1$/u)
  assert.match(capability.name, /^tools:ptc-plus-tip\/repeated-binding-failure\/1$/u)

  // The empty document is a no-op for every branch: the resolved defaults deliver
  // exactly the bytes the renderer produced before the bodies moved into the registry.
  const defaults = resolvePromptText(PROMPT_TEXT_DEFAULT)
  for (const [diagnostics, config] of [
    [PLATFORM_DIAGNOSTICS, plain], [PLATFORM_DIAGNOSTICS, detailed],
    [BINDING_LOCAL, plain], [BINDING_LOCAL, detailed], [BINDING_CAPABILITY, plain],
  ]) {
    const { prompt: _ignored, ...withoutPrompt } = config
    assert.equal(
      latestRecoveryTip(tipView(diagnostics), { ...withoutPrompt, prompt: defaults }).text,
      latestRecoveryTip(tipView(diagnostics), withoutPrompt).text,
    )
  }
})

const TIP_PREFIX_BYTES = Object.freeze({
  'tip.prefix.repeatedBinding': 'The same binding failure has recurred.',
  'tip.prefix.platformCommand': 'An executable, shell, or path failed in the current execution world.',
})

test('both tip prefixes are measured read-only slots with their exact bytes', () => {
  const prompt = resolvePromptText(PROMPT_TEXT_DEFAULT)
  const account = accountPromptText(prompt)
  for (const [slotId, literal] of Object.entries(TIP_PREFIX_BYTES)) {
    const slot = account.slots.find(entry => entry.slotId === slotId)
    assert.ok(slot, `${slotId} is registered`)
    assert.equal(slot.measured, true, `${slotId} carries a literal default, so it is measured`)
    assert.equal(slot.bytes, new TextEncoder().encode(literal).length, `${slotId} bytes`)
    assert.equal(slot.owner, 'B')
    assert.equal(slot.reason, 'protocol-structural',
      'the recognizer identifies a tip by its notice name, not by this text')
    assert.equal(slot.kind, 'literal')
    assert.equal(slot.overridden, false)
  }
  const anchor = promptAnchor('runtime.tip')
  const prefixBytes = anchor.slots
    .filter(slot => slot.id.startsWith('tip.prefix.'))
    .reduce((total, slot) => total + new TextEncoder().encode(slot.defaultText).length, 0)
  assert.equal(prefixBytes, 106, 'the two delivered prefixes total 106 UTF-8 bytes')
})

test('a tip prefix override is refused, so the delivered prefix stays registry-owned', () => {
  const written = { schema: PROMPT_TEXT_SCHEMA, overrides: { 'tip.prefix.repeatedBinding': 'Custom prefix.' } }
  const resolved = resolvePromptText(JSON.stringify(written))
  assert.equal(resolved.text(PROMPT_SLOT_IDS.tipPrefixRepeatedBinding), TIP_PREFIX_BYTES['tip.prefix.repeatedBinding'])
  const reported = resolved.reported.find(entry => entry.slotId === 'tip.prefix.repeatedBinding')
  assert.equal(reported?.reason, 'not-writable')
  assert.throws(() => validatePromptTextDocument(JSON.stringify(written)),
    /tip\.prefix\.repeatedBinding is read-only \(protocol-structural\)/u)
})

test('each trigger kind delivers its own registered prefix byte-for-byte', () => {
  const prompt = resolvePromptText(PROMPT_TEXT_DEFAULT)
  const config = { enabled: true, cooldownMessages: 0, escalationFailures: 2, prompt }
  const platform = latestRecoveryTip(tipView(PLATFORM_DIAGNOSTICS), config)
  assert.equal(platform.text.startsWith(`${TIP_PREFIX_BYTES['tip.prefix.platformCommand']} `), true)
  const binding = latestRecoveryTip(tipView(BINDING_LOCAL), config)
  assert.equal(binding.text.startsWith(`${TIP_PREFIX_BYTES['tip.prefix.repeatedBinding']} `), true)
  // The two prefixes are distinct bytes, so one slot cannot have served both.
  assert.notEqual(TIP_PREFIX_BYTES['tip.prefix.platformCommand'], TIP_PREFIX_BYTES['tip.prefix.repeatedBinding'])
})
