import assert from 'node:assert/strict'
import test from 'node:test'
import {
  USER_BINDING_DRAFT_META_KEY,
  createUserBindingDraftProjection,
  normalizeUserBindingDraftCapability,
  userBindingDraftCapabilityFromMeta,
  withUserBindingDraftCapability,
} from '../internal/user-binding-draft-projection.js'

const GENERATION = 'draft-generation'

function result(meta, surfaceOp = 'append') {
  return {
    type: 'tool/result',
    surfaceOp,
    data: { meta },
  }
}

test('projects only a current-generation opaque draft locator', () => {
  const projection = createUserBindingDraftProjection(GENERATION)
  const initial = projection.init()
  assert.equal(projection.wire.view(initial), null)
  const capability = '0f1e2d3c-4b5a-6978-8a9b-c0d1e2f3a4b5'
  const current = projection.apply(initial, result(
    withUserBindingDraftCapability(undefined, capability, GENERATION),
  ))
  assert.equal(projection.wire.view(current), capability)
  assert.deepEqual(Object.keys(current), ['generation', 'capability'])
  assert.equal(userBindingDraftCapabilityFromMeta(
    withUserBindingDraftCapability(undefined, capability, GENERATION),
    GENERATION,
  ), capability)

  const cleared = projection.apply(current, result(
    withUserBindingDraftCapability(undefined, null, GENERATION),
  ))
  assert.equal(projection.wire.view(cleared), null)
})

test('ignores malformed, foreign, missing, and replacement draft metadata', () => {
  const projection = createUserBindingDraftProjection(GENERATION)
  const capability = 'current-capability'
  const current = projection.apply(projection.init(), result(
    withUserBindingDraftCapability(undefined, capability, GENERATION),
  ))
  assert.equal(projection.apply(current, { type: 'tool/call', data: {} }), current)
  assert.equal(projection.apply(current, result({})), current)
  assert.equal(projection.apply(current, result({
    [USER_BINDING_DRAFT_META_KEY]: { version: 1, generation: GENERATION },
  })), current)
  assert.equal(userBindingDraftCapabilityFromMeta({
    [USER_BINDING_DRAFT_META_KEY]: { version: 1, generation: GENERATION },
  }, GENERATION), undefined)
  assert.equal(userBindingDraftCapabilityFromMeta({}, GENERATION), undefined)
  assert.equal(projection.apply(current, result(
    withUserBindingDraftCapability(undefined, 'foreign', 'other-generation'),
  )), current)
  assert.equal(userBindingDraftCapabilityFromMeta(
    withUserBindingDraftCapability(undefined, 'foreign', 'other-generation'),
    GENERATION,
  ), undefined)
  assert.equal(projection.apply(current, result(
    withUserBindingDraftCapability(undefined, 'replacement', GENERATION),
    'replace',
  )), current)
})

test('invalidates locators at runtime-generation and session-seed boundaries', () => {
  const prior = createUserBindingDraftProjection('prior')
  const state = prior.apply(prior.init(), result(
    withUserBindingDraftCapability(undefined, 'prior-capability', 'prior'),
  ))
  const current = createUserBindingDraftProjection(GENERATION)
  assert.equal(current.stateSchema.parse(state).capability, null)
  assert.equal(current.stateSchema.parse({
    generation: GENERATION, capability: 'current-capability',
  }).capability, 'current-capability')
  assert.equal(current.apply(state, { type: 'session/end-seed' }).capability, null)
})

test('validates bounded capability values and preserves unrelated metadata', () => {
  assert.equal(normalizeUserBindingDraftCapability(null), null)
  assert.throws(() => createUserBindingDraftProjection(''), /invalid.*generation/)
  assert.throws(() => createUserBindingDraftProjection(GENERATION).stateSchema.parse({}), /projection state/)
  assert.throws(() => normalizeUserBindingDraftCapability(''), /invalid/)
  assert.throws(() => normalizeUserBindingDraftCapability('x'.repeat(129)), /invalid/)
  assert.deepEqual(withUserBindingDraftCapability({ retained: true }, 'locator', GENERATION), {
    retained: true,
    [USER_BINDING_DRAFT_META_KEY]: {
      version: 1,
      generation: GENERATION,
      capability: 'locator',
    },
  })
})
