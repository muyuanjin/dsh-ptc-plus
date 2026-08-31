import assert from 'node:assert/strict'
import test from 'node:test'
import { installSettingsSectionCompat } from '../internal/settings-compat.js'

function fixture(provider) {
  const settingsContext = { settings: provider }
  const ctx = {
    fiber: { state: 2 },
    inject(services, callback) {
      assert.deepEqual(services, ['settings'])
      callback(settingsContext)
    },
  }
  return { ctx, settingsContext }
}

function install(ctx, provider, settingsModule) {
  const observed = []
  const hooks = { setSource() {}, onChange() {} }
  installSettingsSectionCompat({
    ctx,
    settingsModule,
    namespace: 'ptc-plus',
    schema: 'schema',
    entry: { enabled: true },
    hooks,
    onProvider: value => observed.push(value),
  })
  assert.deepEqual(observed, [provider])
  return hooks
}

test('prefers the current provider-owned settings installer', () => {
  const calls = []
  const provider = {
    installSection(...args) { calls.push(args) },
  }
  const { ctx } = fixture(provider)
  const hooks = install(ctx, provider, {
    installSettingsSection() { throw new Error('legacy path must not run') },
  })

  assert.deepEqual(calls, [[ctx, 'ptc-plus', 'schema', { enabled: true }, hooks]])
})

test('adapts the legacy package helper to the mounted provider', () => {
  const provider = {}
  const { ctx, settingsContext } = fixture(provider)
  const calls = []
  const hooks = install(ctx, provider, {
    installSettingsSection(owner, ...args) {
      assert.equal(owner.fiber, ctx.fiber)
      owner.inject(['settings'], mounted => {
        calls.push([mounted, ...args])
      })
    },
  })

  assert.deepEqual(calls, [[settingsContext, 'ptc-plus', 'schema', { enabled: true }, hooks]])
})

test('rejects a settings service without a supported installer', () => {
  const provider = {}
  const { ctx } = fixture(provider)
  assert.throws(
    () => install(ctx, provider, {}),
    /expected installSection or installSettingsSection/,
  )
})
