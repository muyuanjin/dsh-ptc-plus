import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { Config } from '../index.js'
import { CONFIG_FIELDS } from '../internal/config-spec.js'
import { createFixtureExecutionProvider } from './host-fixture.js'
import {
  configFieldSchema,
  hostOwnsSettingsDocument,
  installSettingsSectionCompat,
} from '../internal/settings-compat.js'

function fixture(provider) {
  const settingsContext = { settings: provider, effect: register => register() }
  const ctx = {
    fiber: { state: 2 },
    inject(services, callback) {
      assert.deepEqual(services, ['settings'])
      callback(settingsContext)
    },
  }
  return { ctx, settingsContext }
}

function install(ctx, provider, settingsModule, ownerFiber) {
  const observed = []
  const hooks = { setSource() {}, onChange() {} }
  installSettingsSectionCompat({
    ctx,
    settingsModule,
    namespace: 'ptc-plus',
    schema: 'schema',
    entry: { enabled: true },
    hooks,
    ownerFiber,
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

test('treats a host-owned settings surface without an installer as supported', () => {
  const configured = []
  let released = 0
  const entryFiber = { state: 2, uid: 7 }
  const provider = {
    describe() {},
    update() {},
    mutate() {},
    configure(presentation, owner) {
      configured.push([presentation, owner])
      return () => { released += 1 }
    },
  }
  const { ctx, settingsContext } = fixture(provider)
  const hooks = install(ctx, provider, {}, entryFiber)
  assert.equal(typeof hooks.setSource, 'function')
  assert.equal(typeof hooks.onChange, 'function')
  // The host looks the own-page policy up by the profile entry's own fiber, not
  // by the scope that happened to run the installation.
  assert.deepEqual(configured, [[{ auto: false }, entryFiber]])
  assert.notEqual(entryFiber, ctx.fiber)
  // The policy belongs to the settings surface that accepted it: its disposer
  // is released with that surface rather than accumulating on the plugin scope.
  const foreign = []
  ctx.effect = register => foreign.push(register())
  const effects = []
  settingsContext.effect = register => effects.push(register())
  install(ctx, provider, {})
  assert.deepEqual(configured[1], [{ auto: false }, ctx.fiber])
  assert.deepEqual(foreign, [])
  effects.forEach(dispose => dispose())
  assert.equal(released, 1)
})

test('serves the current settings generation from the exported volatile Config', async () => {
  const defaults = (await Config['~standard'].validate({})).value
  const edits = []
  const entry = {
    id: 'ptc-plus',
    options: { id: 'ptc-plus', config: {} },
    fiber: { uid: 1, state: 2, runtime: { Config }, config: defaults, ctx: {} },
  }
  const service = Object.create(SettingsForms.prototype)
  Object.assign(service, { revisions: new Map(), presentations: new Map(), closed: false })
  service.ownerContext = {
    configEditor: {
      configuration: () => [{ entry, inherited: defaults, override: {} }],
      entries: () => [entry],
      async edit(_entry, change) { edits.push(await change({}, defaults, Config)) },
      documentPath: '/tmp/ptc-plus-settings.json',
    },
    emit() {},
  }
  const descriptors = await service.describe()
  assert.deepEqual(descriptors.map(item => item.ns), ['ptc-plus'])
  assert.equal(descriptors[0].applies, 'live')
  await service.update('ptc-plus', { enabled: false })
  assert.equal(edits.length, 1)
  assert.equal(edits[0].enabled, false)
})

test('binds compensating writes to the owning entry or historical section, never another entry', async () => {
  for (const shape of ['host-owned', 'provider-section', 'package-section']) {
    const writes = []
    const provider = { update: async (namespace, patch) => writes.push({ namespace, patch }) }
    if (shape === 'provider-section') provider.installSection = () => {}
    const settingsModule = shape === 'package-section' ? { installSettingsSection() {} } : {}
    const { ctx, settingsContext } = fixture(provider)
    const disposers = []
    settingsContext.effect = register => disposers.push(register())
    let writer
    installSettingsSectionCompat({ ctx, settingsModule, namespace: 'ptc-plus', schema: Config,
      entry: {}, hooks: {}, ownerFiber: { entry: { options: { id: 'custom-ptc' } } },
      onProvider(_provider, bound) {
        writer = bound
        return () => { if (writer === bound) writer = undefined }
      } })
    await writer.update({ enabled: false })
    assert.deepEqual(writes, [{ namespace: shape === 'host-owned' ? 'custom-ptc' : 'ptc-plus',
      patch: { enabled: false } }])
    disposers.forEach(dispose => dispose())
    assert.equal(writer, undefined)
  }
  const { ctx } = fixture({ update() { throw new Error('unaddressed update') } })
  installSettingsSectionCompat({ ctx, settingsModule: {}, namespace: 'ptc-plus',
    schema: Config, entry: {}, hooks: {}, onProvider(_provider, writer) { assert.equal(writer, undefined) } })
})

test('a volatile-only settings commit reaches the running plugin through the loader event', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const indexUrl = new URL('../index.js', import.meta.url).href
  const configUrl = new URL('../internal/runtime-config.js', import.meta.url).href
  const moduleSource = `
    export const name = 'ptc-volatile-probe'
    export const Config = (await import(${JSON.stringify(indexUrl)})).Config
    const { resolveConfig, watchVolatileConfig } = await import(${JSON.stringify(configUrl)})
    export function apply(ctx, config) {
      globalThis.__ptcVolatileApplies = (globalThis.__ptcVolatileApplies ?? 0) + 1
      globalThis.__ptcVolatileSnapshots = globalThis.__ptcVolatileSnapshots ?? []
      watchVolatileConfig(ctx, ctx, config, next => {
        globalThis.__ptcVolatileSnapshots.push(next.enabled)
      })
    }`
  const name = 'data:text/javascript,' + encodeURIComponent(moduleSource)
  const root = new Context()
  t.after(() => {
    delete globalThis.__ptcVolatileApplies
    delete globalThis.__ptcVolatileSnapshots
    return root.fiber.dispose()
  })
  await root.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href }).await()
  await root.loader.create({ id: 'ptc-plus', name, config: { enabled: true, replViewEnabled: true } })
  await root.loader.await()
  await root.loader.create({ id: 'ptc-plus', name, config: { enabled: false, replViewEnabled: true } })
  await root.loader.await()
  assert.equal(globalThis.__ptcVolatileApplies, 1)
  assert.deepEqual(globalThis.__ptcVolatileSnapshots, [false])
})

test('failed activation compensates the custom Loader entry through real SettingsForms', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const home = await mkdtemp(join(tmpdir(), 'ptc-settings-owner-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  root.provide('profileContext', { home, name: 'isolated-settings-owner' })
  await root.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href }).await()
  root.provide('agents', { list: () => [] })
  root.provide('ptcRuntime', createFixtureExecutionProvider({ language: 'python', isolation: 'worker-thread',
    resolve: request => ({ ...request, cwd: process.cwd(), timeoutMs: null }),
    run: async () => ({ logs: [], value: 42 }) }))
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false,
    persona: '', toolOrder: undefined }).await()
  await root.plugin(ToolRuntime, { mode: 'ptc' }).await()
  const defaults = (await Config['~standard'].validate({})).value
  const writes = []
  let compensated
  const compensation = new Promise(resolve => { compensated = resolve })
  root.provide('configEditor', {
    entries: () => [...root.loader.entries()],
    configuration: () => [...root.loader.entries()].map(entry => ({ entry, inherited: defaults, override: {} })),
    documentPath: '/isolated/in-memory-profile.json',
    async edit(entry, change) {
      const config = await change(entry.options.config ?? {}, defaults, entry.fiber.runtime.Config)
      writes.push({ id: entry.options.id, enabled: config.enabled })
      await root.loader.create({ ...entry.options, config })
      await root.loader.await()
      if (entry.options.id === 'custom-ptc' && config.enabled === false) compensated()
    },
  })
  await root.plugin(SettingsForms).await()
  await root.loader.create({ id: 'custom-ptc', name: new URL('../index.js', import.meta.url).href,
    config: { enabled: false, userBindingsEnabled: false, cordisToolsEnabled: false } })
  await root.loader.await()
  await root.settings.update('custom-ptc', { enabled: true })
  let timeout
  try {
    await Promise.race([compensation, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('activation was not compensated')), 5_000)
    })])
  } finally { clearTimeout(timeout) }
  assert.deepEqual(writes, [{ id: 'custom-ptc', enabled: true }, { id: 'custom-ptc', enabled: false }])
  const descriptor = root.settings.describe().find(item => item.ns === 'custom-ptc')
  assert.equal(descriptor.value.enabled, false)
})

test('selects the exported Config shape from the installed settings generation', async () => {
  const settingsModule = await import('@deepseek-ai/dsh-settings')
  // The installed generation serves the exported Config itself, so every field
  // carries the volatile marker its form contract requires.
  assert.equal(hostOwnsSettingsDocument(settingsModule), true)
  for (const field of CONFIG_FIELDS) {
    assert.equal(Config.dict[field.key].meta.volatile, true, field.key)
    assert.equal(Config.dict[field.key].meta.description, field.description, field.key)
  }
  // Generations that still publish a section installer validate the same fields
  // themselves, and their validated defaults must stay plain values.
  assert.equal(hostOwnsSettingsDocument({ installSettingsSection() {} }), false)
  assert.equal(hostOwnsSettingsDocument({ SettingsProvider: class { installSection() {} } }), false)
  assert.equal(hostOwnsSettingsDocument({ SettingsProvider: class {} }), true)
  assert.equal(hostOwnsSettingsDocument({ SettingsForms: class {} }), true)
  // An absent settings package leaves the exported Config usable; the runtime
  // activation path reports the missing service instead.
  assert.equal(hostOwnsSettingsDocument(undefined), true)
})

test('keeps provider-installed fields plain and rejects missing required volatile support', () => {
  const providerOwned = { SettingsProvider: class { installSection() {} } }
  const booleanField = CONFIG_FIELDS.find(field => field.type === 'boolean')
  const numberField = CONFIG_FIELDS.find(field => field.type === 'integer')
  const enumField = CONFIG_FIELDS.find(field => field.type === 'enum')

  const installed = configFieldSchema({ Schema, field: booleanField, settingsModule: providerOwned })
  assert.equal(installed.meta.volatile, undefined)
  assert.equal(installed.meta.default, booleanField.default)
  assert.equal(installed.meta.description, booleanField.description)

  const served = configFieldSchema({ Schema, field: numberField, settingsModule: {} })
  assert.equal(served.meta.volatile, true)
  assert.equal(served.meta.default, numberField.default)
  assert.equal(served.meta.step, 1)

  const enumSchema = configFieldSchema({ Schema, field: enumField, settingsModule: providerOwned })
  for (const option of enumField.options) assert.equal(enumSchema(option), option)
  assert.equal(enumSchema.meta.volatile, undefined)

  // An older builder remains valid for the section installer, but cannot
  // publish an editable document on a Host that requires volatile fields.
  const described = {
    step() { return this },
    min() { return this },
    max() { return this },
    default() { return this },
    description() { return this },
  }
  assert.equal(
    configFieldSchema({ Schema: { number: () => described }, field: numberField, settingsModule: providerOwned }),
    described,
  )
  assert.throws(
    () => configFieldSchema({ Schema: { number: () => described }, field: numberField, settingsModule: {} }),
    /host settings contract requires @deepseek-ai\/schemastery with volatile\(\); reinstall the plugin/,
  )
})
