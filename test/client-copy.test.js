import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTINGS_COPY } from '../src/client-copy.js'

/**
 * Both shipped locales must expose exactly the same key set. A missing string
 * renders its raw key in the UI (`capabilities.prompt.reset`), which is how the
 * prompt-text pane ended up mixing languages: the key existed, but only in one
 * block, and the visual fixture happened to render the other locale.
 */
test('zh and en expose the same settings keys', () => {
  const zh = Object.keys(SETTINGS_COPY.zh).sort()
  const en = Object.keys(SETTINGS_COPY.en).sort()
  const missingInZh = en.filter(key => !zh.includes(key))
  const missingInEn = zh.filter(key => !en.includes(key))
  assert.deepEqual(missingInZh, [], `missing Chinese copy for: ${missingInZh.join(', ')}`)
  assert.deepEqual(missingInEn, [], `missing English copy for: ${missingInEn.join(', ')}`)
})

test('every prompt-text key resolves to a non-empty string in both locales', () => {
  const keys = Object.keys(SETTINGS_COPY.zh).filter(key => key.startsWith('capabilities.prompt.'))
  assert.ok(keys.length > 40, `expected the prompt-text namespace, found ${keys.length} keys`)
  for (const key of keys) {
    for (const locale of ['zh', 'en']) {
      const value = SETTINGS_COPY[locale][key]
      assert.equal(typeof value, 'string', `${locale}: ${key} is not a string`)
      assert.ok(value.trim().length > 0, `${locale}: ${key} is empty`)
    }
  }
})

test('the reason codes and slot kinds the registry emits have localized labels', () => {
  const reasons = ['fact-derived', 'aggregate-frozen', 'protocol-exact-text', 'protocol-structural', 'shadows-host', 'other-owner']
  const camel = { 'fact-derived': 'factDerived', 'aggregate-frozen': 'aggregateFrozen', 'protocol-exact-text': 'protocolExactText', 'protocol-structural': 'protocolStructural', 'shadows-host': 'shadowsHost', 'other-owner': 'otherOwner' }
  for (const reason of reasons) {
    for (const locale of ['zh', 'en']) {
      const value = SETTINGS_COPY[locale][`capabilities.prompt.reason.${camel[reason]}`]
      assert.equal(typeof value, 'string', `${locale}: missing label for ${reason}`)
      assert.ok(value.length > 0, `${locale}: empty label for ${reason}`)
    }
  }
  for (const kind of ['literal', 'aggregate', 'projected']) {
    for (const locale of ['zh', 'en']) {
      const value = SETTINGS_COPY[locale][`capabilities.prompt.kind.${kind}`]
      assert.equal(typeof value, 'string', `${locale}: missing label for ${kind}`)
    }
  }
})

test('the Chinese pane copy contains no leftover English words', () => {
  // Only prose keys are checked: registry identifiers (reason codes, kinds) are
  // localized through their own labels and may legitimately appear in `title`.
  const prose = Object.keys(SETTINGS_COPY.zh).filter(key => key.startsWith('capabilities.prompt.')
    && !key.startsWith('capabilities.prompt.reason.') && !key.startsWith('capabilities.prompt.kind.'))
  const offenders = prose.filter(key => /[A-Za-z]{4,} [A-Za-z]{4,}/u.test(SETTINGS_COPY.zh[key]))
  assert.deepEqual(offenders, [], `Chinese copy still containing English prose: ${offenders.join(', ')}`)
})

/**
 * A word whose producer is gone cannot be reached by any input, so its copy is
 * dead: `capabilities.invocation.varies` described a Skill conflict no catalog
 * reports, and `capabilities.receipt.no-session` named the text of a notice the
 * receipt surface can no longer meet. `capabilities.card.no-session` stays:
 * releases up to 0.5.4 recorded that outcome and the chat notice still renders it.
 *
 * The `capabilities.proof.*` family stated one capability's saved, delivered and
 * usable facts in the command receipt. A receipt states the record it wrote, and
 * proof belongs to the panel's evidence column, so that family has no producer and
 * no reader may meet one of its words again.
 */
test('retired words stay out of both locales', () => {
  for (const locale of ['zh', 'en']) {
    for (const key of ['capabilities.invocation.varies', 'capabilities.receipt.no-session',
      'capabilities.proof.title', 'capabilities.proof.line', 'capabilities.proof.saved.yes', 'capabilities.proof.saved.no',
      'capabilities.proof.delivery.delivered', 'capabilities.proof.delivery.pending', 'capabilities.proof.delivery.absent',
      'capabilities.proof.usability.proven', 'capabilities.proof.usability.unproven',
      'capabilities.proof.observed', 'capabilities.proof.unobserved']) {
      assert.equal(SETTINGS_COPY[locale][key], undefined, `${locale}: ${key} has no producer`)
    }
    assert.equal(typeof SETTINGS_COPY[locale]['capabilities.card.no-session'], 'string',
      `${locale}: the recorded no-session notice still has copy`)
    // The receipt that replaces them names the write in both locales.
    for (const key of ['capabilities.receipt.record', 'capabilities.receipt.record.global']) {
      assert.equal(typeof SETTINGS_COPY[locale][key], 'string', `${locale}: ${key} states what the command wrote`)
    }
  }
})
