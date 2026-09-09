import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIG_DEFAULTS, CONFIG_FIELDS } from '../internal/config-spec.js'
import { MAX_TIMER_DELAY_MS, resolveConfig, validateMaxWallMs } from '../internal/runtime-config.js'
import { SessionRuntime } from '../internal/session-runtime.js'

test('owns the runtime wall-clock ceiling', () => {
  assert.equal(validateMaxWallMs(MAX_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS)
  assert.throws(() => validateMaxWallMs(0), /positive safe integer/)
  assert.throws(() => validateMaxWallMs(MAX_TIMER_DELAY_MS + 1), /must not exceed/)

  const runtime = new SessionRuntime({ maxWallMs: MAX_TIMER_DELAY_MS })
  assert.equal(runtime.config.maxWallMs, MAX_TIMER_DELAY_MS)
  assert.throws(() => new SessionRuntime({ maxWallMs: MAX_TIMER_DELAY_MS + 1 }), /must not exceed/)
  return runtime.dispose()
})

test('validates every declared field from its CONFIG_FIELDS type and bounds', () => {
  for (const field of CONFIG_FIELDS) {
    assert.equal(Object.hasOwn(CONFIG_DEFAULTS, field.key), true)
    if (field.type === 'boolean') {
      assert.equal(typeof field.default, 'boolean')
      assert.equal(resolveConfig({ [field.key]: !field.default })[field.key], !field.default)
      for (const invalid of ['yes', 0, null, undefined]) {
        assert.throws(
          () => resolveConfig({ [field.key]: invalid }),
          new RegExp(`ptc-plus: ${field.key} must be a boolean`),
        )
      }
      continue
    }
    assert.equal(field.type, 'integer')
    assert.equal(Number.isSafeInteger(field.min), true)
    assert.equal(Number.isSafeInteger(field.max), true)
    assert.equal(resolveConfig({ [field.key]: field.max })[field.key], field.max)
    for (const invalid of [0, -1, 1.5, NaN, '8', undefined, field.max + 1]) {
      assert.throws(
        () => resolveConfig({ [field.key]: invalid }),
        new RegExp(`ptc-plus: ${field.key} must `),
      )
    }
  }
})

test('keeps defaults and unknown fields while rejecting every invalid value', () => {
  assert.deepEqual(resolveConfig(), CONFIG_DEFAULTS)
  const resolved = resolveConfig({ futureOption: 'kept', tipCooldownMessages: 5 })
  assert.equal(resolved.tipCooldownMessages, 5)
  assert.equal(resolved.futureOption, 'kept')
  assert.equal(resolved.maxWallMs, CONFIG_DEFAULTS.maxWallMs)

  assert.throws(() => resolveConfig({ maxWallMs: 0 }), /maxWallMs must be a positive safe integer/)
  assert.throws(() => resolveConfig({ maxWallMs: MAX_TIMER_DELAY_MS + 1 }), /maxWallMs must not exceed/)
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/)
})
