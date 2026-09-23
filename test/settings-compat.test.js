import assert from 'node:assert/strict'
import test from 'node:test'
import Schema from '@deepseek-ai/schemastery'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { Config } from '../index.js'
import { CONFIG_FIELDS } from '../internal/config-spec.js'
import {
  configFieldSchema,
  hostOwnsSettingsDocument,
  installSettingsSectionCompat,
} from '../internal/settings-compat.js'

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
  const entryFiber = { state: 2, uid: 7 }
  const provider = {
    describe() {},
    update() {},
    mutate() {},
    configure(presentation, owner) {
      configured.push([presentation, owner])
      return () => {}
    },
  }
  const { ctx } = fixture(provider)
  const hooks = install(ctx, provider, {}, entryFiber)
  assert.equal(typeof hooks.setSource, 'function')
  assert.equal(typeof hooks.onChange, 'function')
  // The host looks the own-page policy up by the profile entry's own fiber, not
  // by the scope that happened to run the installation.
  assert.deepEqual(configured, [[{ auto: false }, entryFiber]])
  assert.notEqual(entryFiber, ctx.fiber)
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

test('keeps provider-installed fields plain and tolerates a builder without volatile', () => {
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

  // A generation that serves the document itself but predates the builder
  // capability keeps the described field instead of failing the import.
  const described = {
    step() { return this },
    min() { return this },
    max() { return this },
    default() { return this },
    description() { return this },
  }
  assert.equal(
    configFieldSchema({ Schema: { number: () => described }, field: numberField, settingsModule: {} }),
    described,
  )
})
