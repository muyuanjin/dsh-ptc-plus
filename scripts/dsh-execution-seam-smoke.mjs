import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function executionServiceName(source) {
  const names = new Set()
  for (const match of source.matchAll(/\bget\(\s*["']([A-Za-z_$][\w$]*Runtime)["']\s*\)/g)) names.add(match[1])
  if (names.size !== 1) {
    throw new Error(`dsh-execution-seam-smoke: the installed tool runtime names ${names.size} execution services (${[...names].join(', ') || 'none'})`)
  }
  return [...names][0]
}

async function main() {
  const consumer = process.cwd()
  const pluginSpecifier = process.argv[2] ?? 'dsh-ptc-plus'
  const require = createRequire(join(consumer, 'noop.cjs'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
  const { loadOverlayPatches, composeEntries, mountRootInclude } = await load('@deepseek-ai/dsh-app-boot')
  const { ToolRuntime, defineTool } = await load('@deepseek-ai/dsh-tools')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { SessionStore } = await load('@deepseek-ai/dsh-session')
  const { SessionQueryEngine } = await load('@deepseek-ai/dsh-session-query')
  const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
  const { createScope } = await load('@deepseek-ai/dsh-scope')
  const { createAssistantMessage, createToolResultMessage } = await load('@deepseek-ai/dsh-llm')
  const seamService = executionServiceName(readFileSync(require.resolve('@deepseek-ai/dsh-tools'), 'utf8'))
  if (seamService !== 'ptcRuntime') throw new Error(`dsh-execution-seam-smoke: unsupported public provider service ${seamService}`)
  const manifestPath = require.resolve('dsh-ptc-plus/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundlePath = join(dirname(manifestPath), manifest.dsh.bundle.patch)
  const bundle = loadOverlayPatches('dsh', bundlePath)
  const stateKey = '__ptcPlusPublicSeamSmoke'
  const state = globalThis[stateKey] = { runs: [], resolutions: [], originals: [] }
  const upstreamUrl = 'data:text/javascript,' + encodeURIComponent(`
    import { PtcRuntime } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-ptc-runtime')).href)}
    const state = globalThis[${JSON.stringify(stateKey)}]
    export const name = 'frozen-upstream'
    export function apply(ctx, config) {
      class FrozenOriginal extends PtcRuntime {
        language = 'typescript'
        isolation = 'process'
        get executionInstructions() { return 'provider program guidance' }
        get sandboxMode() { return 'workspace-write' }
        get timeout() { return { defaultMs: 1000, maxMs: 2000 } }
        constructor(ctx) { super(ctx); Object.freeze(this) }
        resolve(request) {
          state.resolutions.push(request)
          return Object.freeze({ ...request, cwd: request.cwd ?? config.cwd,
            timeoutMs: request.timeoutMs === undefined ? null : request.timeoutMs })
        }
        async run(spec) { state.runs.push(spec); return { logs: [], value: 'upstream' } }
      }
      state.original = new FrozenOriginal(ctx)
      state.descriptors = Object.getOwnPropertyDescriptors(state.original)
      state.originals.push({ original: state.original, descriptors: state.descriptors })
    }
  `)
  const originalRow = { id: 'ptc-runtime', name: upstreamUrl, config: { cwd: consumer } }
  const rows = composeEntries([[{ insert: [originalRow] }], bundle])
  const adapterRow = rows.find(row => row.id === 'ptc-plus-execution')
  const mainRow = rows.find(row => row.id === 'ptc-plus')
  if (adapterRow === undefined || mainRow === undefined) throw new Error('dsh-execution-seam-smoke: bundle lacks public provider composition')
  adapterRow.name = pathToFileURL(require.resolve(adapterRow.name)).href
  mainRow.name = pathToFileURL(require.resolve(pluginSpecifier)).href
  mainRow.config = { userBindingsEnabled: false, cordisToolsEnabled: false }
  const root = new Context()
  const profile = await mkdtemp(join(tmpdir(), 'ptc-execution-profile-'))
  let agentScope
  try {
    root.effect(() => root.provide('agents', { list: () => [] }))
    new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
    new ToolRuntime(root, { mode: 'ptc' })
    for (const plugin of [SessionStore, SessionQueryEngine, SessionProjectionRegistry]) {
      let fiber
      root.effect(() => {
        fiber = root.plugin(plugin)
        return () => fiber.dispose()
      })
      await fiber.await()
    }
    await root.plugin(Loader, { baseUrl: pathToFileURL(consumer + '/').href }).await()
    const filename = join(profile, 'cordis.json')
    await writeFile(filename, JSON.stringify(rows))
    const include = await mountRootInclude(root, filename)
    const profileTree = include.subtree
    await root.loader.await()
    const main = profileTree.resolve('ptc-plus').fiber
    try {
      await main?.await()
    } catch (error) {
      throw new Error('dsh-execution-seam-smoke: did not install the public execution entry', { cause: error })
    }
    const provider = root.get(seamService)
    const seam = provider?.[Symbol.for('dsh-ptc-plus.execution-seam')]?.()
    if (seam?.active !== true) throw new Error('dsh-execution-seam-smoke: did not install the public execution entry')
    assert.equal(provider.sandboxMode, undefined)
    assert.equal(provider.timeout, undefined)
    assert.notEqual(provider.executionInstructions, state.original.executionInstructions)
    assert.equal(Object.isFrozen(state.original), true)
    assert.deepEqual(Object.getOwnPropertyDescriptors(state.original), state.descriptors)
    const spec = Object.freeze({
      program: 'return 1', bindings: Object.freeze([]), cwd: consumer,
      timeoutMs: null, sandboxPolicy: Object.freeze({ mode: 'read-only' }),
    })
    assert.equal((await provider.run(spec)).value, 'upstream')
    assert.equal(state.runs.at(-1), spec)
    assert.deepEqual(state.resolutions, [])
    assert.equal(provider.language, 'typescript')
    assert.equal(provider.isolation, 'worker-thread')
    let nativeCalls = 0
    const native = defineTool({
      name: 'execution_smoke_echo', description: 'Return the supplied number.',
      parameters: { value: { type: 'number', required: true } },
      output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute({ value }) { nativeCalls += 1; return value },
    })
    root.effect(() => root.get('tools').register(native))
    assert.throws(() => root.get('tools').register({ ...native, name: 'run_code' }), /reserved/)
    const session = root.get('sessions').create('public-provider-execution', { meta: { cwd: consumer } })
    const agent = { id: 'public-provider-agent', session }
    root.effect(() => {
      agentScope = createScope(root, agent)
      agent.ctx = agentScope.ctx
      return () => agentScope.dispose()
    })
    const signal = new AbortController().signal
    session.append('turn/start', { turn: 1 })
    await root.get('systemPrompt').assemble({ agent, scope: agent, signal })
    const runParameters = root.get('tools').get('run_code').parameters
    let step = 0
    const invoke = async (name, callId, args) => {
      step += 1
      session.append('step/start', { turn: 1, step })
      await root.get('systemPrompt').assemble({ agent, scope: agent, signal })
      const argumentsValue = JSON.stringify(args)
      session.append('assistant/message', {
        turn: 1, step,
        message: createAssistantMessage({
          source: { provider: 'local-contract', model: 'deterministic' },
          content: [{ type: 'tool-call', id: callId, name, arguments: argumentsValue }],
        }),
        stream: [
          { type: 'chunk', time: 0, chunk: { type: 'tool-call-start', index: 0, id: callId, name } },
          { type: 'chunk', time: 1, chunk: { type: 'tool-call-delta', index: 0, id: callId, arguments: argumentsValue } },
          { type: 'chunk', time: 2, chunk: { type: 'tool-call-end', index: 0, id: callId } },
        ],
      }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step, callId, name, arguments: argumentsValue })
      const result = await root.get('tools').execute({ name, callId, arguments: args, agent, signal })
      session.append('tool/result', {
        turn: 1, step,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        ...(result.meta === undefined ? {} : { meta: result.meta }),
        ...(result.error === undefined ? {} : { error: result.error }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      session.append('step/end', { turn: 1, step })
      return result
    }
    const first = await invoke('run_code', 'first-cell', {
      code: 'let shared = await tools.execution_smoke_echo({ value: 40 }); return shared', description: 'Initialize shared state',
    })
    assert.equal(first.isError, false, JSON.stringify(first))
    assert.deepEqual(first.value, { logs: [], result: 40 })
    const second = await invoke('run_code', 'second-cell', { code: 'shared += 2; return shared', description: 'Continue shared state' })
    assert.equal(second.isError, false, JSON.stringify(second))
    assert.deepEqual(second.value, { logs: [], result: 42 })
    originalRow.config = { cwd: consumer, profileTag: 'reloaded' }
    await profileTree.resolve('ptc-runtime').update({ config: originalRow.config })
    await root.loader.await()
    assert.equal(root.get(seamService), provider)
    assert.equal(seam.active, true)
    assert.equal(state.originals.length, 2)
    const edited = await invoke('edit_run_code', 'derived-cell', { edits: [{ old_string: '+= 2', new_string: '+= 1' }] })
    assert.equal(edited.isError, false, JSON.stringify(edited))
    assert.equal(edited.value.edited, true, JSON.stringify(edited))
    assert.equal(edited.value.value, 43)
    const continued = await invoke('run_code', 'after-edit', { code: 'return shared', description: 'Read edited state' })
    assert.equal(continued.isError, false, JSON.stringify(continued))
    assert.deepEqual(continued.value, { logs: [], result: 43 })
    assert.equal(nativeCalls, 1)
    const rejected = await invoke('run_code', 'schema-rejection', { code: 1, description: 'Invalid code type' })
    assert.equal(rejected.isError, true)
    assert.equal(nativeCalls, 1)
    assert.equal(state.runs.length, 1, 'session execution must not delegate to the frozen original')
    assert.deepEqual(root.get('tools').get('run_code').parameters, runParameters)
    assert.equal(root.get('tools').get(native.name), native)
    assert.deepEqual(Object.getOwnPropertyDescriptors(state.original), state.descriptors)
    for (const record of state.originals) assert.deepEqual(Object.getOwnPropertyDescriptors(record.original), record.descriptors)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await agentScope.dispose()
    await profileTree.resolve('ptc-plus').update({ disabled: true })
    await root.loader.await()
    assert.equal(root.get(seamService).executionInstructions, 'provider program guidance')
    assert.equal(root.get(seamService).isolation, 'process')
    assert.equal(root.get(seamService).sandboxMode, 'workspace-write')
    assert.deepEqual(root.get(seamService).timeout, { defaultMs: 1000, maxMs: 2000 })
    await profileTree.resolve('ptc-plus').update({ disabled: false })
    await root.loader.await()
    assert.equal(root.get(seamService).timeout, undefined)
    await profileTree.root.update([originalRow])
    await root.loader.await()
    assert.ok(root.get(seamService))
    assert.equal(root.get(seamService).executionInstructions, 'provider program guidance')
    assert.equal((await root.get(seamService).run(spec)).value, 'upstream')
    assert.deepEqual(Object.getOwnPropertyDescriptors(state.original), state.descriptors)
    console.log('official profile Include bundle/provider execution installed; frozen original preserved; session run_code/edit_run_code continuous state proved; disable/re-enable/uninstall delegated')
  } finally {
    await agentScope?.dispose()
    await root.fiber.dispose()
    await rm(profile, { recursive: true, force: true })
    delete globalThis[stateKey]
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
