import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIG_DEFAULTS, CONFIG_FIELDS } from '../internal/config-spec.js'
import {
  MAX_TIMER_DELAY_MS,
  CAPABILITY_CONFIGURATION_KEYS,
  capabilityProfileConfiguration,
  validateCapabilityProfiles,
  hasVolatileFields,
  resolveConfig,
  validateMaxWallMs,
  watchVolatileConfig,
} from '../internal/runtime-config.js'
import { SessionRuntime } from '../internal/session-runtime.js'

test('named capability configurations validate portable settings independently of frozen session state', () => {
  const configuration = capabilityProfileConfiguration({ capabilityBaseline: '["tools.probe"]', capabilityOverrides: '{"mcpServers.docs":"closed"}' })
  const document = { schema: 'ptc-capability-profiles/v1', profiles: [{ id: 'profile-a', name: ' Daily ', configuration }] }
  const valid = validateCapabilityProfiles(document)
  assert.equal(valid.profiles[0].name, 'Daily')
  assert.equal(resolveConfig({ capabilityProfiles: JSON.stringify(valid) }).capabilityProfiles, JSON.stringify(valid))
  assert.equal(configuration.capabilityBudgetBytes, CONFIG_DEFAULTS.capabilityBudgetBytes)
  assert.throws(() => capabilityProfileConfiguration({ sessionId: 'old-session' }), /configuration fields/)
  assert.throws(() => capabilityProfileConfiguration({ capabilityStatistics: '{"enabled":true,"windowSize":1,"minimumSamples":2,"fullThreshold":0.5}' }), /statistics settings/)
  assert.throws(() => validateCapabilityProfiles({ ...document, profiles: [...document.profiles, ...document.profiles] }), /duplicate/)
  assert.throws(() => validateCapabilityProfiles({ ...document, profiles: Array(101).fill(document.profiles[0]) }), /profiles document/)
  assert.throws(() => validateCapabilityProfiles({ ...document, profiles: [{ ...document.profiles[0], configuration: { apiKey: 'not-a-secret' } }] }), /configuration fields/)
})

test('owns the runtime wall-clock ceiling', () => {
  assert.equal(validateMaxWallMs(MAX_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS)
  assert.throws(() => validateMaxWallMs(0), /positive safe integer/)
  assert.throws(() => validateMaxWallMs(MAX_TIMER_DELAY_MS + 1), /must not exceed/)

  const runtime = new SessionRuntime({ maxWallMs: MAX_TIMER_DELAY_MS })
  assert.equal(runtime.config.maxWallMs, MAX_TIMER_DELAY_MS)
  assert.throws(() => new SessionRuntime({ maxWallMs: MAX_TIMER_DELAY_MS + 1 }), /must not exceed/)
  return runtime.dispose()
})

test('resolves the configured runtime bounds with the values the environment shipped', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.sampleBoundMs, 1_000)
  assert.equal(defaults.unmeasuredCellLimit, 2)
  assert.equal(defaults.workerReclaimMs, 5_000)
  assert.equal(defaults.startupProbeMs, 5_000)
  assert.equal(defaults.executionSeamTimeoutMs, 30_000)

  const raised = resolveConfig({
    sampleBoundMs: 2_000,
    unmeasuredCellLimit: 3,
    workerReclaimMs: 15_000,
    startupProbeMs: 20_000,
    executionSeamTimeoutMs: 60_000,
  })
  assert.equal(raised.sampleBoundMs, 2_000)
  assert.equal(raised.unmeasuredCellLimit, 3)
  assert.equal(raised.workerReclaimMs, 15_000)
  assert.equal(raised.startupProbeMs, 20_000)
  assert.equal(raised.executionSeamTimeoutMs, 60_000)

  assert.throws(() => resolveConfig({ sampleBoundMs: 0 }), /positive safe integer/)
  assert.throws(() => resolveConfig({ unmeasuredCellLimit: 0 }), /positive safe integer/)
  assert.throws(() => resolveConfig({ workerReclaimMs: 999 }), /positive safe integer/)
  assert.equal(resolveConfig({ workerReclaimMs: 1_000 }).workerReclaimMs, 1_000)
  assert.throws(() => resolveConfig({ workerReclaimMs: MAX_TIMER_DELAY_MS + 1 }), /must not exceed/)
  assert.throws(() => resolveConfig({ startupProbeMs: 1.5 }), /positive safe integer/)
  assert.throws(() => resolveConfig({ executionSeamTimeoutMs: Infinity }), /positive safe integer/)
})

test('follows volatile config handles without restarting the fiber', () => {
  let enabled = true
  const config = { enabled: { get: () => enabled } }
  assert.equal(hasVolatileFields(config), true)
  assert.equal(hasVolatileFields({ enabled: true }), false)
  assert.equal(hasVolatileFields(undefined), false)

  const listeners = []
  const host = {
    on(event, listener) {
      listeners.push([event, listener])
      return () => listeners.splice(listeners.indexOf([event, listener]), 1)
    },
  }
  const observed = []
  assert.equal(watchVolatileConfig(host, {}, config, next => observed.push(next.enabled)), true)
  assert.equal(listeners[0][0], 'loader/volatile-update')
  enabled = false
  listeners[0][1]()
  assert.deepEqual(observed, [false])

  assert.equal(watchVolatileConfig(undefined, {}, config, () => {}), false)
  assert.equal(watchVolatileConfig(host, {}, { enabled: true }, () => {}), false)

  let registered
  const scope = {
    effect(register) {
      registered = register()
      return registered
    },
  }
  assert.equal(watchVolatileConfig(host, scope, config, () => {}), true)
  assert.equal(typeof registered, 'function')
})

test('validates every declared field from its CONFIG_FIELDS type and bounds', () => {
  for (const field of CONFIG_FIELDS) {
    assert.equal(Object.hasOwn(CONFIG_DEFAULTS, field.key), true)
    if (field.type === 'string') {
      assert.equal(typeof field.default, 'string')
      const value = {
        capabilityPolicy: CONFIG_DEFAULTS.capabilityPolicy,
        capabilityProfiles: CONFIG_DEFAULTS.capabilityProfiles,
        capabilityBaseline: '["tools.probe"]',
        capabilityOverrides: '{"tools.probe":"on-demand"}',
        capabilityStatistics: '{"enabled":false}',
        promptText: CONFIG_DEFAULTS.promptText,
      }[field.key]
      assert.equal(typeof value, 'string')
      assert.equal(resolveConfig({ [field.key]: value })[field.key], value)
      for (const invalid of [true, 0, null, undefined, {}]) {
        assert.throws(() => resolveConfig({ [field.key]: invalid }),
          new RegExp(`ptc-plus: ${field.key} must be a string`))
      }
      continue
    }
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
    if (field.type === 'enum') {
      assert.ok(Array.isArray(field.options) && field.options.length > 0)
      assert.equal(resolveConfig({ [field.key]: field.options.at(-1) })[field.key], field.options.at(-1))
      assert.throws(() => resolveConfig({ [field.key]: 'invalid' }), new RegExp(`ptc-plus: ${field.key} must be one of`))
      continue
    }
    assert.equal(field.type, 'integer')
    assert.equal(Number.isSafeInteger(field.min), true)
    assert.equal(Number.isSafeInteger(field.max), true)
    assert.equal(resolveConfig({ [field.key]: field.min })[field.key], field.min)
    assert.equal(resolveConfig({ [field.key]: field.max })[field.key], field.max)
    // Zero is a value, not an omission, for a field whose minimum is zero:
    // `retentionClusters` uses it to mean "no count-based folding".
    const invalidValues = [0, -1, 1.5, NaN, '8', undefined, field.max + 1]
      .filter(invalid => !(invalid === 0 && field.min === 0))
    for (const invalid of invalidValues) {
      assert.throws(
        () => resolveConfig({ [field.key]: invalid }),
        new RegExp(`ptc-plus: ${field.key} must `),
      )
    }
  }
})

test('keeps defaults and unknown fields while rejecting every invalid value', () => {
  assert.deepEqual(resolveConfig(), CONFIG_DEFAULTS)
  assert.equal(resolveConfig().userBindingsEnabled, true)
  assert.equal(resolveConfig({ userBindingsEnabled: false }).userBindingsEnabled, false)
  assert.equal(resolveConfig({ userBindingsEnabled: { get: () => undefined } }).userBindingsEnabled, true)
  assert.equal(resolveConfig({ userBindingsEnabled: { get: () => false } }).userBindingsEnabled, false)
  const resolved = resolveConfig({ futureOption: 'kept', tipCooldownMessages: 5 })
  assert.equal(resolved.tipCooldownMessages, 5)
  assert.equal(resolved.futureOption, 'kept')
  assert.equal(resolved.maxWallMs, CONFIG_DEFAULTS.maxWallMs)

  assert.throws(() => resolveConfig({ maxWallMs: 0 }), /maxWallMs must be a positive safe integer/)
  assert.throws(() => resolveConfig({ maxWallMs: MAX_TIMER_DELAY_MS + 1 }), /maxWallMs must not exceed/)
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ bindingUpdates: 'invalid' }), /bindingUpdates/)
  const legacy = resolveConfig({ looseTopLevelRedeclarations: false })
  assert.equal(legacy.bindingUpdates, 'stateful')
  assert.equal(legacy.legacyBindingSettings, true)
})

test('migrates only complete old policy choices and preserves mixed compatibility', () => {
  const enabled = { looseTopLevelRedeclarations: true, looseTopLevelFunctionClassRedeclarations: true,
    autoSplitRedeclarations: true, autoRewriteImports: true, autoStripExports: true }
  assert.equal(resolveConfig(enabled).legacyBindingSettings, false)
  assert.equal(resolveConfig(enabled).bindingUpdates, 'stateful')
  const protectedConfig = resolveConfig({ ...enabled, looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: false, autoSplitRedeclarations: false })
  assert.equal(protectedConfig.bindingUpdates, 'protected')
  assert.equal(protectedConfig.legacyBindingSettings, false)
  assert.equal(resolveConfig({ ...enabled, autoRewriteImports: false }).legacyBindingSettings, true)
  const selected = resolveConfig({ ...enabled, autoRewriteImports: false, bindingUpdates: 'stateful' })
  assert.equal(selected.legacyBindingSettings, false)
  assert.deepEqual(resolveConfig(selected), selected)
})


test('MCP server controls validate at configuration resolution without changing individual tool strategies', () => {
  const overrides = {'mcpServers.docs':'closed','tools.mcp__docs__search':'full'}
  assert.equal(resolveConfig({capabilityOverrides:JSON.stringify(overrides)}).capabilityOverrides, JSON.stringify(overrides))
  for (const choice of ['full','on-demand']) assert.throws(()=>resolveConfig({capabilityOverrides:JSON.stringify({'mcpServers.docs':choice})}), /invalid capabilityOverrides/)
  assert.throws(()=>resolveConfig({capabilityOverrides:'{"mcpServers.":"closed"}'}), /invalid capabilityOverrides/)
})


test('composed configuration defaults and legacy migration preserve distinct reusable choices', () => {
  const fresh = resolveConfig()
  assert.equal(JSON.parse(fresh.capabilityPolicy).defaults.disclosure, 'host')
  assert.equal(fresh.capabilityRecoveryEnabled, false)
  assert.equal(fresh.modelPreviewEnabled, false)
  const legacy = resolveConfig({ capabilityManagementEnabled: true, capabilityOverrides: '{"tools.probe":"full","mcpServers.docs":"closed"}',
    capabilityStatistics: '{"enabled":true,"windowSize":20,"minimumSamples":2,"fullThreshold":0.5}' })
  const policy = JSON.parse(legacy.capabilityPolicy)
  assert.equal(policy.defaults.disclosure, 'adaptive')
  assert.deepEqual(policy.items['tools.probe'], { disclosure: 'full' })
  assert.deepEqual(policy.mcpServers.docs, { availability: 'closed' })
  assert.equal(policy.allocation.statistics, true)
  assert.equal(legacy.capabilityRecoveryEnabled, true)
  assert.equal(legacy.modelPreviewEnabled, true)
  const selected = resolveConfig({ ...legacy, capabilityPolicy: fresh.capabilityPolicy, capabilityRecoveryEnabled: false, modelPreviewEnabled: false })
  assert.equal(JSON.parse(selected.capabilityPolicy).defaults.disclosure, 'host')
  assert.equal(selected.capabilityRecoveryEnabled, false)
  assert.equal(selected.modelPreviewEnabled, false)
  const profile = capabilityProfileConfiguration(Object.fromEntries(CAPABILITY_CONFIGURATION_KEYS.map(key => [key, selected[key]])))
  assert.deepEqual(capabilityProfileConfiguration(profile), profile)
  assert.equal(profile.modelPreviewEnabled, false)
})


test('composition migration retains legacy unresolved preferences without expanding the managed domain', () => {
  const legacy = { capabilityManagementEnabled: false, capabilityOverrides: '{"removed-tool":"full","repl.inspect":"full"}' }
  const resolved = resolveConfig(legacy)
  assert.deepEqual(JSON.parse(resolved.capabilityPolicy).items, {
    'removed-tool': { disclosure: 'full' }, 'repl.inspect': { disclosure: 'full' },
  })
  const doc = validateCapabilityProfiles({ schema: 'ptc-capability-profiles/v1', profiles: [
    { id: 'old', name: 'Old', configuration: legacy },
  ] })
  assert.deepEqual(validateCapabilityProfiles(JSON.parse(JSON.stringify(doc))), doc)
})


test('capability context choice survives portable profile round trips and preserves latent child settings', () => {
  assert.equal(resolveConfig({}).capabilityContextEnabled, true)
  const saved = capabilityProfileConfiguration({ capabilityContextEnabled: false, capabilityManagementEnabled: true,
    capabilityRecoveryEnabled: true, modelPreviewEnabled: true })
  const document = validateCapabilityProfiles(JSON.parse(JSON.stringify({ schema: 'ptc-capability-profiles/v1',
    profiles: [{ id: 'paused', name: 'Paused', configuration: saved }] })))
  assert.equal(document.profiles[0].configuration.capabilityContextEnabled, false)
  assert.equal(saved.capabilityManagementEnabled, true)
  assert.equal(saved.capabilityRecoveryEnabled, true)
  assert.equal(saved.modelPreviewEnabled, true)
  assert.equal(capabilityProfileConfiguration({}).capabilityContextEnabled, true)
  assert.throws(() => resolveConfig({ capabilityContextEnabled: 'false' }), /capabilityContextEnabled/)
})
