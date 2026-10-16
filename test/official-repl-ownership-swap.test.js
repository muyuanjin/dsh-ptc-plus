import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

// A host-owned settings document commits volatile fields in place: the plugin
// fiber is not restarted, the loader updates the retained handles and emits
// `loader/volatile-update`, and `watchVolatileConfig` reconciles the running
// attachment. This suite proves that an ownership flip through that channel
// swaps the attachment (deferred <-> owned) instead of reconfiguring the
// deferred runtime in place, so the seam-gated descriptors below can only
// change when the plugin attachment actually installs or retires.

const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source)
const runtimeUrl = import.meta.resolve('@deepseek-ai/dsh-ptc-runtime')
const compositionUrl = new URL('../internal/execution-provider-owner.js', import.meta.url).href
const pluginUrl = new URL('../index.js', import.meta.url).href
let sequence = 0

async function waitFor(condition, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function swapFixture(t) {
  const key = `__ptcOfficialReplSwap${sequence++}`
  const state = globalThis[key] = { releases: [] }
  const originalUrl = moduleUrl(`
    import { PtcRuntime } from ${JSON.stringify(runtimeUrl)}
    const state = globalThis[${JSON.stringify(key)}]
    export const name = 'official-repl-original'
    export function apply(ctx) {
      class Original extends PtcRuntime {
        language = 'typescript'
        isolation = 'process'
        get programFormat() { return 'repl' }
        get executionInstructions() { return 'official REPL guidance' }
        get sandboxMode() { return 'workspace-write' }
        get timeout() { return { defaultMs: 1000, maxMs: 2000 } }
        constructor(ctx) { super(ctx); Object.freeze(this) }
        resolve(request) {
          return Object.freeze({ ...request, cwd: process.cwd(),
            timeoutMs: request.timeoutMs === undefined ? null : request.timeoutMs,
            sandboxPolicy: request.sandboxPolicy ?? Object.freeze({ mode: 'workspace-write' }) })
        }
        async run() { return { logs: [], value: 'official' } }
        release(owner) { state.releases.push(owner); return Promise.resolve() }
      }
      new Original(ctx)
    }
  `)
  const root = new Context()
  t.after(async () => {
    await root.fiber.dispose()
    delete globalThis[key]
  })
  await root.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href }).await()
  await root.loader.root.update([
    { id: 'ptc-runtime', name: originalUrl, isolate: { ptcRuntime: 'ptc-plus-original' }, config: {} },
    { id: 'ptc-plus-execution', name: compositionUrl, intercept: { loader: { await: false } },
      config: { originalEntryId: 'ptc-runtime', isolation: 'ptc-plus-original', serviceName: 'ptcRuntime' } },
  ])
  await root.loader.await()
  root.provide('agents', { list: () => [] })
  new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
  new ToolRuntime(root, { mode: 'ptc' })
  return { root, state }
}

test('a volatile settings commit swaps execution ownership in both directions', async t => {
  const { root, state } = await swapFixture(t)
  const config = { enabled: true, officialReplPriority: true, userBindingsEnabled: false, cordisToolsEnabled: false }
  await root.loader.create({ id: 'ptc-plus', name: pluginUrl, config })
  await root.loader.await()
  assert.equal(root.get('ptcRuntime').executionInstructions, 'official REPL guidance')
  assert.equal(root.get('ptcRuntime').sandboxMode, 'workspace-write')

  // Deferred -> owned: the deferred runtime cannot produce these descriptors.
  await root.loader.create({ id: 'ptc-plus', name: pluginUrl, config: { ...config, officialReplPriority: false } })
  await root.loader.await()
  await waitFor(() => root.get('ptcRuntime').executionInstructions === '', 'plugin ownership')
  assert.equal(root.get('ptcRuntime').sandboxMode, undefined)
  assert.equal(root.get('ptcRuntime').timeout, undefined)
  await root.get('ptcRuntime').release({})

  // Owned -> deferred: the plugin attachment retires and the original
  // provider serves run_code again with its own descriptors.
  await root.loader.create({ id: 'ptc-plus', name: pluginUrl, config })
  await root.loader.await()
  await waitFor(() => root.get('ptcRuntime').executionInstructions === 'official REPL guidance',
    'official ownership')
  assert.equal(root.get('ptcRuntime').programFormat, 'repl')
  assert.equal(state.releases.length, 1)
})
