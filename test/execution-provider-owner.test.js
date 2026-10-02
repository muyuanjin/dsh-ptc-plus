import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { parse } from 'yaml'
import { apply as applyMain } from '../index.js'
import { installExecutionSeam } from '../internal/execution-seam-compat.js'
import * as composition from '../internal/execution-provider-owner.js'

const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source)
const runtimeUrl = import.meta.resolve('@deepseek-ai/dsh-ptc-runtime')
const compositionUrl = new URL('../internal/execution-provider-owner.js', import.meta.url).href
let sequence = 0

async function loaderFixture(t, { originalEntryId = 'ptc-runtime', isolation = 'ptc-plus-original', originalConfig = {}, adapterFirst = false, adapterUrl = compositionUrl, included = false } = {}) {
  const key = `__ptcComposition${sequence++}`
  const state = globalThis[key] = { originals: [], resolutions: [], runs: [], effects: [] }
  const originalUrl = moduleUrl(`
    import { PtcRuntime } from ${JSON.stringify(runtimeUrl)}
    const state = globalThis[${JSON.stringify(key)}]
    export const name = 'frozen-original'
    export function apply(ctx, config) {
      class Original extends PtcRuntime {
        language = config.language ?? 'typescript'
        isolation = 'process'
        get executionInstructions() { return config.guidance ?? 'original guidance' }
        get sandboxMode() { return config.mode ?? 'workspace-write' }
        get timeout() { return config.timeout ?? { defaultMs: 1000, maxMs: 2000 } }
        constructor(ctx) { super(ctx); Object.freeze(this) }
        resolve(request) {
          state.resolutions.push(request)
          return Object.freeze({ ...request, cwd: request.cwd ?? config.cwd ?? process.cwd(),
            timeoutMs: request.timeoutMs === undefined ? null : request.timeoutMs,
            sandboxPolicy: request.sandboxPolicy ?? Object.freeze({ mode: this.sandboxMode }) })
        }
        async run(spec) { state.runs.push(spec); return { logs: [], value: config.tag ?? 'original' } }
      }
      const original = new Original(ctx)
      state.originals.push({ original, config, descriptors: Object.getOwnPropertyDescriptors(original) })
      ctx.effect(() => () => { state.effects.push(config.tag ?? 'original') }, 'original cleanup')
    }
  `)
  const root = new Context()
  t.after(async () => { await root.fiber.dispose(); delete globalThis[key] })
  await root.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href }).await()
  const originalRow = {
    id: originalEntryId, name: originalUrl,
    isolate: { ptcRuntime: isolation }, config: originalConfig,
  }
  const adapterRow = {
    id: 'ptc-plus-execution', name: adapterUrl,
    intercept: { loader: { await: false } }, config: { originalEntryId, isolation },
  }
  const rows = adapterFirst ? [adapterRow, originalRow] : [originalRow, adapterRow]
  let tree = root.loader
  if (included) {
    const directory = await mkdtemp(join(tmpdir(), 'ptc-provider-include-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const filename = join(directory, 'cordis.json')
    await writeFile(filename, JSON.stringify(rows))
    const include = await mountRootInclude(root, filename)
    tree = include.subtree
  } else {
    await tree.root.update(rows)
  }
  await root.loader.await()
  assert.ok(root.get('ptcRuntime'))
  return { root, tree, state, originalUrl, originalRow, adapterRow, originalEntry: tree.resolve(originalEntryId) }
}

for (const adapterFirst of [false, true]) test(`official profile include resolves its own original row with adapter ${adapterFirst ? 'first' : 'last'}`, async t => {
  const { root, tree, originalEntry, originalUrl } = await loaderFixture(t, {
    included: true, adapterFirst, originalConfig: { tag: 'included' },
  })
  assert.throws(() => root.loader.resolve('ptc-runtime'), /cannot resolve/)
  const provider = root.get('ptcRuntime')
  assert.equal((await provider.run(provider.resolve({ program: 'return 1', bindings: [] }))).value, 'included')
  await originalEntry.update({ config: { tag: 'reloaded' } })
  await root.loader.await()
  assert.equal(root.get('ptcRuntime'), provider)
  assert.equal((await provider.run(provider.resolve({ program: 'return 2', bindings: [] }))).value, 'reloaded')
  await tree.root.update([{ id: 'ptc-runtime', name: originalUrl, config: { tag: 'reloaded' } }])
  await root.loader.await()
  assert.equal(Object.isFrozen(root.get('ptcRuntime')), true)
  assert.equal((await root.get('ptcRuntime').run({})).value, 'reloaded')
})

test('default bundle composition keeps the original module and full profile config', async () => {
  const base = parse(await readFile(new URL('../node_modules/@deepseek-ai/dsh-base/cordis.patch.yml', import.meta.url), 'utf8'))
  const bundle = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const config = { timeoutMs: 777, maxTimeoutMs: 999, maxOutputBytes: 123456, launch: { opaque: true } }
  const rows = composeEntries([base, bundle, [{ id: 'ptc-runtime', config }]])
  const original = rows.find(row => row.id === 'ptc-runtime')
  assert.equal(original.name, '@deepseek-ai/dsh-ptc-runtime-node')
  assert.deepEqual(original.config, config)
  assert.deepEqual(original.isolate, { ptcRuntime: 'ptc-plus-original' })
  assert.equal(rows.find(row => row.id === 'ptc-plus-execution').name, 'dsh-ptc-plus/execution-provider')
  assert.equal(rows.find(row => row.id === 'ptc-plus').name, 'dsh-ptc-plus')
})

test('public Loader startup delegates exact specs and preserves custom original row configuration', async t => {
  const config = { cwd: process.cwd(), tag: 'custom', guidance: 'custom guidance', timeout: { defaultMs: 50, maxMs: 60 } }
  const { root, state, originalEntry } = await loaderFixture(t, {
    originalEntryId: 'custom-provider', isolation: 'custom-ptc-original', originalConfig: config,
  })
  const provider = root.get('ptcRuntime')
  const spec = Object.freeze({
    program: 'return 1', bindings: Object.freeze([]), cwd: 'G:/chosen-workspace',
    timeoutMs: null, sandboxPolicy: Object.freeze({ mode: 'read-only' }), opaque: true,
  })
  assert.equal((await provider.run(spec)).value, 'custom')
  assert.equal(state.runs[0], spec)
  assert.deepEqual(state.resolutions, [])
  const request = Object.freeze({ program: 'return 2', bindings: [] })
  const resolved = provider.resolve(request)
  assert.equal(state.resolutions[0], request)
  await provider.run(resolved)
  assert.equal(state.runs[1], resolved)
  assert.equal(provider.executionInstructions, 'custom guidance')
  assert.equal(provider.language, 'typescript')
  assert.equal(provider.isolation, 'process')
  assert.equal(provider.sandboxMode, 'workspace-write')
  assert.deepEqual(provider.timeout, config.timeout)
  assert.equal(originalEntry.options.config, config)
  const record = state.originals[0]
  assert.equal(Object.isFrozen(record.original), true)
  assert.deepEqual(Object.getOwnPropertyDescriptors(record.original), record.descriptors)
})

test('actual main plugin disable/re-enable leaves delegation and frozen source intact', async t => {
  const { root, state } = await loaderFixture(t)
  root.provide('agents', { list: () => [] })
  new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
  new ToolRuntime(root, { mode: 'ptc' })
  const config = { enabled: false, userBindingsEnabled: false, cordisToolsEnabled: false }
  const main = root.plugin({ apply: applyMain }, config)
  await main.await()
  assert.equal(root.get('ptcRuntime').executionInstructions, 'original guidance')
  main.update({ ...config, enabled: true })
  await main.await()
  assert.equal(root.get('ptcRuntime').executionInstructions, '')
  assert.equal(root.get('ptcRuntime').sandboxMode, undefined)
  main.update(config)
  await main.await()
  assert.equal(root.get('ptcRuntime').executionInstructions, 'original guidance')
  main.update({ ...config, enabled: true })
  await main.await()
  assert.equal(root.get('ptcRuntime').timeout, undefined)
  await main.dispose()
  const spec = root.get('ptcRuntime').resolve({ program: 'return 3', bindings: [] })
  assert.equal((await root.get('ptcRuntime').run(spec)).value, 'original')
  assert.equal(state.runs.at(-1), spec)
  for (const record of state.originals) assert.deepEqual(Object.getOwnPropertyDescriptors(record.original), record.descriptors)
})

test('activation validates the current original language after reload in both directions', async t => {
  for (const initialLanguage of ['typescript', 'python']) await t.test(initialLanguage, async t => {
    const { root, originalEntry } = await loaderFixture(t, { originalConfig: { language: initialLanguage } })
    root.provide('agents', { list: () => [] })
    new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
    new ToolRuntime(root, { mode: 'ptc' })
    const config = { enabled: false, userBindingsEnabled: false, cordisToolsEnabled: false }
    let main = root.plugin({ apply: applyMain }, config)
    await main.await()
    const provider = root.get('ptcRuntime')
    const seam = provider[Symbol.for('dsh-ptc-plus.execution-seam')]()
    await main.dispose()
    await originalEntry.update({ config: { language: 'python' } })
    await root.loader.await()
    assert.equal(root.get('ptcRuntime'), provider)
    assert.equal(provider.language, 'python')
    main = root.plugin({ apply: applyMain }, { ...config, enabled: true })
    await assert.rejects(main.await(), /unsupported code runtime language "python"/)
    assert.equal(seam.active, false)
    await main.dispose()
    await originalEntry.update({ disabled: true })
    await root.loader.await()
    main = root.plugin({ apply: applyMain }, { ...config, enabled: true })
    await assert.rejects(main.await(), /generation is unavailable/)
    assert.equal(seam.active, false)
    await main.dispose()
    await originalEntry.update({ disabled: false, config: { language: 'typescript' } })
    await root.loader.await()
    main = root.plugin({ apply: applyMain }, { ...config, enabled: true })
    await main.await()
    assert.equal(provider.language, 'typescript')
    assert.equal(seam.active, true)
  })
})

test('enabled main follows original language changes without executing a different language in its worker', async t => {
  const { root, originalEntry } = await loaderFixture(t)
  root.provide('agents', { list: () => [] })
  new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
  new ToolRuntime(root, { mode: 'ptc' })
  const main = root.plugin({ apply: applyMain }, { enabled: true, userBindingsEnabled: false, cordisToolsEnabled: false })
  await main.await()
  const provider = root.get('ptcRuntime')
  const seam = provider[Symbol.for('dsh-ptc-plus.execution-seam')]()
  assert.equal(seam.active, true)
  await originalEntry.update({ config: { language: 'python' } })
  await root.loader.await()
  await Promise.all([...root.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => fiber.await())))
  assert.equal(root.get('ptcRuntime'), provider)
  assert.equal(seam.active, false)
  assert.equal(provider.language, 'python')
  assert.equal(provider.executionInstructions, 'original guidance')
  assert.equal((await provider.run(provider.resolve({ program: 'print(42)', bindings: [] }))).value, 'original')
  await originalEntry.update({ config: { language: 'typescript' } })
  await root.loader.await()
  await Promise.all([...root.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => fiber.await())))
  assert.equal(root.get('ptcRuntime'), provider)
  assert.equal(seam.active, true)
  assert.equal(provider.language, 'typescript')
  assert.equal(provider.executionInstructions, '')
  main.update({ enabled: false, userBindingsEnabled: false, cordisToolsEnabled: false })
  await main.await()
  await originalEntry.update({ config: { language: 'python' } })
  await root.loader.await()
  await Promise.all([...root.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => fiber.await())))
  assert.equal(seam.active, false)
  assert.equal(provider.language, 'python')
  await main.dispose()
})

test('original provider reload, disable and re-enable retire the old public generation', async t => {
  const { root, state, originalEntry } = await loaderFixture(t, { originalConfig: { tag: 'first' } })
  const oldProvider = root.get('ptcRuntime')
  const firstSpec = oldProvider.resolve({ program: 'return 0', bindings: [] })
  await originalEntry.update({ config: { tag: 'second', cwd: process.cwd() } })
  await root.loader.await()
  assert.equal(oldProvider, root.get('ptcRuntime'))
  assert.throws(() => oldProvider.run(firstSpec), /unavailable original generation/)
  const spec = root.get('ptcRuntime').resolve({ program: 'return 1', bindings: [] })
  assert.equal((await root.get('ptcRuntime').run(spec)).value, 'second')
  await originalEntry.update({ disabled: true })
  await root.loader.await()
  assert.throws(() => root.get('ptcRuntime').resolve({}), /generation is unavailable/)
  await originalEntry.update({ disabled: false })
  await root.loader.await()
  assert.throws(() => oldProvider.run(spec), /unavailable original generation/)
  const freshSpec = oldProvider.resolve({ program: 'return 2', bindings: [] })
  assert.equal((await oldProvider.run(freshSpec)).value, 'second')
  assert.equal(state.runs.at(-1), freshSpec)
  assert.equal(state.runs.includes(firstSpec), false)
  assert.ok(state.effects.includes('first'))
})

for (const adapterFirst of [false, true]) test(`concurrent bundle removal restores the original global slot with adapter ${adapterFirst ? 'first' : 'last'}`, async t => {
  const { root, state, originalUrl } = await loaderFixture(t, { originalConfig: { tag: 'preserved' }, adapterFirst })
  const adapter = root.get('ptcRuntime')
  await root.loader.root.update([{ id: 'ptc-runtime', name: originalUrl, config: { tag: 'preserved' } }])
  await root.loader.await()
  const original = root.get('ptcRuntime')
  assert.ok(original)
  assert.equal(Object.isFrozen(original), true)
  const spec = original.resolve({ program: 'return 1', bindings: [] })
  assert.equal((await original.run(spec)).value, 'preserved')
  assert.equal(state.originals.length, 1)
  assert.throws(() => adapter.run(spec), /generation is unavailable/)
  assert.throws(() => adapter.language, /generation is unavailable/)
  assert.deepEqual(Object.getOwnPropertyDescriptors(state.originals[0].original), state.originals[0].descriptors)
})

test('removing only the owned row does not disable the isolated original or remove a later provider', async t => {
  const { root, state, originalEntry, originalRow } = await loaderFixture(t)
  const oldAdapter = root.get('ptcRuntime')
  await root.loader.root.update([originalRow])
  await root.loader.await()
  assert.equal(root.get('ptcRuntime'), undefined)
  assert.equal(originalEntry.disabled, false)
  const isolatedOriginal = originalEntry.context.get('ptcRuntime')
  assert.equal(Object.isFrozen(isolatedOriginal), true)
  assert.deepEqual(Object.getOwnPropertyDescriptors(isolatedOriginal), state.originals[0].descriptors)
  const replacement = Object.freeze({ marker: 'another owner' })
  root.effect(() => root.provide('ptcRuntime', replacement))
  await root.loader.await()
  assert.equal(root.get('ptcRuntime'), replacement)
  assert.throws(() => oldAdapter.run({}), /generation is unavailable/)
  assert.deepEqual(Object.getOwnPropertyDescriptors(state.originals[0].original), state.originals[0].descriptors)
})

test('isolation changes suspend the adapter, and restoring its named realm reattaches once', async t => {
  const { root, originalEntry } = await loaderFixture(t)
  await originalEntry.update({ isolate: null })
  await root.loader.await()
  assert.equal(Object.isFrozen(root.get('ptcRuntime')), true)
  assert.equal(root.get('ptcRuntime').executionInstructions, 'original guidance')
  await originalEntry.update({ isolate: { ptcRuntime: 'ptc-plus-original' } })
  await root.loader.await()
  const active = root.plugin({ apply(ctx) {
    return installExecutionSeam(ctx, { attach(scope, seam) {
      scope.effect(() => seam.installExecute(() => Promise.resolve({ logs: [], value: 'plugin' })))
    } })
  } })
  await active.await()
  assert.equal((await root.get('ptcRuntime').run({})).value, 'plugin')
  await active.dispose()
  assert.equal((await root.get('ptcRuntime').run({})).value, 'original')
})

test('isolation removal during original startup settles composition without a late global registration', { timeout: 5_000 }, async t => {
  const key = `__ptcComposition${sequence++}`
  let resume
  let started
  const applying = new Promise(resolve => { started = resolve })
  globalThis[key] = { ready: new Promise(resolve => { resume = resolve }), started }
  const originalUrl = moduleUrl(`
    import { PtcRuntime } from ${JSON.stringify(runtimeUrl)}
    export async function apply(ctx) {
      await globalThis[${JSON.stringify(key)}].ready
      class Original extends PtcRuntime {
        language = 'typescript'
        resolve(request) { return request }
        async run() { return { logs: [], value: 'original' } }
      }
      Object.freeze(new Original(ctx))
    }
  `)
  const root = new Context()
  t.after(async () => { resume(); await root.fiber.dispose(); delete globalThis[key] })
  await root.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href }).await()
  const observedComposition = moduleUrl(`
    import * as composition from ${JSON.stringify(compositionUrl)}
    export const inject = composition.inject
    export function apply(ctx, config) {
      const attachment = composition.apply(ctx, config)
      globalThis[${JSON.stringify(key)}].started()
      return attachment
    }
  `)
  await root.loader.root.update([
    { id: 'ptc-runtime', name: originalUrl, isolate: { ptcRuntime: 'ptc-plus-original' } },
    { id: 'ptc-plus-execution', name: observedComposition, intercept: { loader: { await: false } } },
  ])
  const owner = root.loader.resolve('ptc-plus-execution').fiber
  await applying
  await root.loader.resolve('ptc-runtime').update({ isolate: null })
  resume()
  let timer
  try {
    await Promise.race([owner.await(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('composition did not settle after isolation removal')), 500)
    })])
  } finally { clearTimeout(timer) }
  await root.loader.await()
  assert.equal(owner.state, 2)
  const original = root.get('ptcRuntime')
  assert.equal(Object.isFrozen(original), true)
  assert.equal(original[Symbol.for('dsh-ptc-plus.execution-seam')], undefined)
})

test('invalid entry mapping and isolation are explicit startup errors', async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(Loader).await()
  assert.throws(() => composition.apply(root, { originalEntryId: '' }), /requires an original entry id/)
  assert.throws(() => composition.apply(root, { isolation: '' }), /requires an original entry id/)
  assert.throws(() => composition.apply(root, { isolation: 1 }), /requires an original entry id/)
  assert.throws(() => composition.apply(root, { originalEntryId: 'missing' }), /does not exist|cannot resolve/)
  await root.loader.root.update([{ id: 'ptc-runtime', name: moduleUrl('export function apply() {}') }])
  assert.throws(() => composition.apply(root), /must isolate/)
})

test('an occupied global slot rejects child activation without modifying either original or incumbent', async t => {
  const { root, state, originalEntry, originalRow } = await loaderFixture(t)
  await root.loader.root.update([originalRow])
  await root.loader.await()
  const incumbent = Object.freeze({ owner: 'another provider' })
  root.effect(() => root.provide('ptcRuntime', incumbent))
  const activation = composition.apply(root)
  await assert.rejects(activation, /service "ptcRuntime" has been registered/)
  assert.equal(root.get('ptcRuntime'), incumbent)
  assert.equal(originalEntry.disabled, false)
  assert.deepEqual(Object.getOwnPropertyDescriptors(state.originals[0].original), state.originals[0].descriptors)
})

test('a rejecting owned child cleanup reports its failure after restoring the original global slot', async t => {
  const key = `__ptcCompositionFault${sequence++}`
  const fault = globalThis[key] = { warnings: [] }
  t.after(() => { delete globalThis[key] })
  const adapterUrl = moduleUrl(`
    import * as composition from ${JSON.stringify(compositionUrl)}
    const fault = globalThis[${JSON.stringify(key)}]
    export const inject = composition.inject
    export function apply(ctx, config) {
      const owned = ctx.extend({
        logger: { warn(error) { fault.warnings.push(error) } },
        effect(register, label) {
          return ctx.effect(() => {
            const cleanup = register()
            return async () => {
              await cleanup()
              if (label === 'ptc-plus owned execution child') throw new Error('owned child cleanup failed')
            }
          }, label)
        },
      })
      return composition.apply(owned, config)
    }
  `)
  const { root, state, originalUrl } = await loaderFixture(t, { adapterUrl })
  const adapter = root.get('ptcRuntime')
  await root.loader.root.update([{ id: 'ptc-runtime', name: originalUrl, config: {} }])
  await root.loader.await()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.isFrozen(root.get('ptcRuntime')), true)
  const aggregate = fault.warnings.find(error => error instanceof AggregateError)
  assert.ok(aggregate, 'owned cleanup failure must be reported')
  assert.match(aggregate.message, /execution provider disposal failed/)
  assert.equal(aggregate.errors.length, 1)
  assert.match(aggregate.errors[0].message, /owned child cleanup failed/)
  assert.throws(() => adapter.run({}), /generation is unavailable/)
  assert.deepEqual(Object.getOwnPropertyDescriptors(state.originals[0].original), state.originals[0].descriptors)
})

test('an original entry that never publishes its provider rejects the bounded startup wait', async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(Loader).await()
  await root.loader.root.update([{ id: 'ptc-runtime', name: moduleUrl('export function apply() {}'),
    isolate: { ptcRuntime: 'ptc-plus-original' } }])
  await root.loader.await()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const activation = composition.apply(root)
  const rejection = assert.rejects(activation, /original execution entry ptc-runtime did not publish ptcRuntime/)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(30_000)
  await rejection
  assert.equal(root.get('ptcRuntime'), undefined)
  assert.equal(root.loader.resolve('ptc-runtime').disabled, false)
})

test('disabled original startup settles without a provider and attaches after public re-enable', async t => {
  const { root, originalEntry, originalRow } = await loaderFixture(t)
  await originalEntry.update({ disabled: true })
  await root.loader.await()
  await root.loader.root.update([originalRow])
  await root.loader.await()
  await composition.apply(root)
  assert.equal(root.get('ptcRuntime'), undefined)
  await originalEntry.update({ disabled: false })
  await root.loader.await()
  await new Promise(resolve => setImmediate(resolve))
  const provider = root.get('ptcRuntime')
  assert.equal(provider.language, 'typescript')
  assert.equal(provider.isolation, 'process')
  assert.equal((await provider.run(provider.resolve({ program: 'return 1', bindings: [] }))).value, 'original')
  assert.equal(originalEntry.disabled, false)
})
