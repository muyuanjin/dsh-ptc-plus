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
