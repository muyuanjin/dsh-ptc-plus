import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { PROMPT_COMPOSER_FILES, PROMPT_SLOTS, PROMPT_SLOT_IDS, planCategorySlotId, promptAnchorOfSlot } from '../internal/prompt-text.js'

/**
 * The registry only keeps its promise while every literal a composer delivers is
 * registered, and the check must not depend on how a composer spelled the id.
 *
 * Composers therefore resolve ids through PROMPT_SLOT_IDS. This test enforces
 * both directions: no bare slot-id string literal may appear in a composer, and
 * every exported constant must be resolved by one.
 *
 * The file list is the registry's `PROMPT_COMPOSER_FILES`, not a copy kept here:
 * a new composer registers itself once and the scan widens with it.
 */
const COMPOSERS = [...PROMPT_COMPOSER_FILES]

// Only wired literals have a composer to resolve them. A declared-but-unwired
// anchor keeps its literal slot (an editor will exist once the channel is wired),
// but demanding a composer reference today would be a lie in the other direction.
const wiredLiteralIds = PROMPT_SLOTS
  .filter(slot => slot.source === 'registry-literal' && slot.owner === 'A'
    && promptAnchorOfSlot(slot.id)?.wired === true)
  .map(slot => slot.id)
const literalIds = PROMPT_SLOTS.filter(slot => slot.source === 'registry-literal').map(slot => slot.id)

const registrySource = readFileSync(new URL('../internal/prompt-text.js', import.meta.url), 'utf8')

const composerSources = () => COMPOSERS.map(file => ({
  file,
  source: readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
}))

test('no composer spells a slot id as a string literal', () => {
  for (const { file, source } of composerSources()) {
    for (const id of literalIds) {
      assert.equal(source.includes(`'${id}'`) || source.includes(`"${id}"`) || source.includes(`\`${id}\``), false,
        `${file} writes the bare slot id ${id}; use PROMPT_SLOT_IDS instead`)
    }
  }
})

test('every exported slot-id constant of a wired anchor is resolved by a composer', () => {
  const combined = composerSources().map(entry => entry.source).join('\n')
  for (const constant of Object.keys(PROMPT_SLOT_IDS)) {
    const slotId = PROMPT_SLOT_IDS[constant]
    if (!wiredLiteralIds.includes(slotId)) continue
    // Category guidance is resolved by one helper instead of five constants, so a
    // composer either names the constant or reaches the slot through that helper.
    const viaHelper = slotId.startsWith('plan.category.') && combined.includes('planCategorySlotId(')
    // A slot delivered by a registry helper (rewrite descriptions, result envelope,
    // category guidance) is resolved there, through the same exported constant.
    const viaRegistryHelper = registrySource.includes(`PROMPT_SLOT_IDS.${constant}`)
    assert.ok(combined.includes(`PROMPT_SLOT_IDS.${constant}`) || viaHelper || viaRegistryHelper,
      `PROMPT_SLOT_IDS.${constant} is never resolved by a composer`)
  }
  const categories = PROMPT_SLOTS.filter(slot => slot.id.startsWith('plan.category.'))
  assert.ok(categories.length === 5, 'the registry keeps one slot per capability category')
  for (const slot of categories) assert.equal(planCategorySlotId(slot.id.slice('plan.category.'.length)), slot.id)
})

test('every literal slot is reachable from an exported constant', () => {
  const values = Object.values(PROMPT_SLOT_IDS)
  assert.deepEqual([...values].sort(), [...literalIds].sort(),
    'a literal slot has no constant, or a constant names a slot that is not a registry literal')
})

test('every generated slot names the owner that produces its bytes', () => {
  const generated = PROMPT_SLOTS.filter(slot => slot.source !== 'registry-literal')
  assert.ok(generated.length > 0, 'the registry must keep at least one generated slot visible')
  for (const slot of generated) {
    assert.equal(slot.defaultText, null, `${slot.id}: a generated slot has no literal default`)
    assert.notEqual(slot.reason, null, `${slot.id}: a generated slot is not editable`)
    assert.match(slot.source, /\S/u, `${slot.id}: name the code that renders this slot`)
    assert.ok(promptAnchorOfSlot(slot.id) !== undefined, slot.id)
  }
})
