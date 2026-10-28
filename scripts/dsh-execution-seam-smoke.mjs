import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ptcPresentation } from './dsh-host-contract.mjs'

/**
 * The program-runtime service name is a host declaration: the package that
 * consumes a runtime names it through `ctx.get('<name>Runtime')`. Which package
 * that is moved between lines — a registry host resolves the runtime itself, an
 * executor host resolves it in its tool executor — so every package that can
 * play that role contributes a source to inspect.
 * @param {...string} sources - source text of the candidate consuming packages.
 * @returns {string} the single declared program-runtime service name.
 */
export function executionServiceName(...sources) {
  const names = new Set()
  for (const source of sources) {
    for (const match of source.matchAll(/\bget\(\s*["']([A-Za-z_$][\w$]*Runtime)["']\s*\)/g)) names.add(match[1])
  }
  if (names.size !== 1) {
    throw new Error(`dsh-execution-seam-smoke: the installed tool consumers name ${names.size} execution services (${[...names].join(', ') || 'none'})`)
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
  const { agentEvents } = await load('@deepseek-ai/dsh-agent')
  const { createScope } = await load('@deepseek-ai/dsh-scope')
  const { createAssistantMessage, createToolResultMessage } = await load('@deepseek-ai/dsh-llm')
  // Presentation is either a registry field or a mounted executor; only the
  // installed schema says which, and the consumers of a program runtime are the
  // registry on one shape and the tool executor on the other.
  const presentation = ptcPresentation(ToolRuntime)
  const runtimeConsumers = [readFileSync(require.resolve('@deepseek-ai/dsh-tools'), 'utf8')]
  if (presentation.kind === 'executor') {
    runtimeConsumers.push(readFileSync(require.resolve('@deepseek-ai/dsh-tool-executor-ptc'), 'utf8'))
  }
  const seamService = executionServiceName(...runtimeConsumers)
  if (!['ptcRuntime', 'codeRuntime'].includes(seamService)) throw new Error(`dsh-execution-seam-smoke: unsupported public provider service ${seamService}`)
  const manifestPath = require.resolve('dsh-ptc-plus/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundlePath = join(dirname(manifestPath), manifest.dsh.bundle.patch)
  const bundle = loadOverlayPatches('dsh', bundlePath)
  const stateKey = '__ptcPlusPublicSeamSmoke'
  const state = globalThis[stateKey] = { runs: [], resolutions: [], originals: [] }
  const runtimeBase = seamService === 'ptcRuntime'
    ? `import { PtcRuntime as Runtime } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-ptc-runtime')).href)}`
    : `import { Service as Runtime } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)}`
  const originalEntryId = seamService === 'ptcRuntime' ? 'ptc-runtime' : 'code-runtime'
  const upstreamUrl = 'data:text/javascript,' + encodeURIComponent(`
    ${runtimeBase}
    const state = globalThis[${JSON.stringify(stateKey)}]
    export const name = 'frozen-upstream'
    export function apply(ctx, config) {
      class FrozenOriginal extends Runtime {
        language = 'typescript'
        isolation = 'process'
        get executionInstructions() { return 'provider program guidance' }
        get sandboxMode() { return 'workspace-write' }
        get timeout() { return { defaultMs: 1000, maxMs: 2000 } }
        constructor(ctx) { super(ctx${seamService === 'codeRuntime' ? ", 'codeRuntime'" : ''}); Object.freeze(this) }
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
  const originalRow = { id: originalEntryId, name: upstreamUrl, config: { cwd: consumer } }
  const rows = composeEntries([[{ insert: [originalRow] }], bundle])
  if (presentation.kind === 'executor') {
    rows.push({ id: 'tool-executor-ptc', name: pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-executor-ptc')).href })
  }
  const adapterRow = rows.find(row => row.id === 'ptc-plus-execution')
  const mainRow = rows.find(row => row.id === 'ptc-plus')
  if (adapterRow === undefined || mainRow === undefined) throw new Error('dsh-execution-seam-smoke: bundle lacks public provider composition')
  assert.equal(adapterRow.config.originalEntryId, originalEntryId)
  assert.equal(adapterRow.config.serviceName, seamService)
  adapterRow.name = pathToFileURL(require.resolve(adapterRow.name)).href
  mainRow.name = pathToFileURL(require.resolve(pluginSpecifier)).href
  mainRow.config = { userBindingsEnabled: false, cordisToolsEnabled: false }
  const root = new Context()
  const profile = await mkdtemp(join(tmpdir(), 'ptc-execution-profile-'))
  let agentScope
  try {
    root.effect(() => root.provide('agents', { list: () => [] }))
    new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
    new ToolRuntime(root, presentation.kind === 'registry' ? { mode: presentation.mode } : {})
    for (const plugin of [SessionStore, SessionQueryEngine, SessionProjectionRegistry]) {
      let fiber
      root.effect(() => {
        fiber = root.plugin(plugin)
        return () => fiber.dispose()
      })
      await fiber.await()
    }
    // Current public tool execution resolves cwd through the official service.
    // Older frozen cohorts have no such package and retain their earlier seam.
    let workingDirectory
    try { workingDirectory = require.resolve('@deepseek-ai/dsh-working-directory') } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
    if (workingDirectory) {
      await root.plugin((await load('@deepseek-ai/dsh-fs-local')).default).await()
      await root.plugin((await import(pathToFileURL(workingDirectory).href)).default,
        { defaultDirectory: consumer }).await()
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
    await agentEvents(root, agent).serial('agent/created', { source: 'startup', signal })
    const enterStep = step => agentEvents(root, agent).waterfall('agent/pre-step', {
      agent, messages: [], turn: 1, step, signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    const initialAssembly = await root.get('systemPrompt').assemble({ agent, scope: agent, signal })
    await enterStep(1)
    const stablePrompt = assembly => JSON.stringify({ sections: assembly.sections, tools: assembly.tools })
    const systemText = initialAssembly.sections.map(section => section.text).join('\n\n')
    assert.match(systemText, /Cells support TypeScript, top-level await, return, static import and top-level export/)
    assert.doesNotMatch(systemText, /erasable syntax only|no `enum` or namespaces/)
    assert.deepEqual(initialAssembly.tools.map(tool => tool.name), ['run_code'])
    const editorSdk = initialAssembly.sections.find(section => section.name === 'tools:sdk')?.text
    assert.match(editorSdk, /edit_run_code: \{/)
    for (const [field, type] of [['old_string', 'string'], ['new_string', 'string'],
      ['pattern', 'string'], ['flags', 'string'], ['replacement', 'string'],
      ['expected_matches', 'number'], ['accepted', 'boolean'], ['scheduled', 'boolean']]) {
      assert.match(editorSdk, new RegExp(`\\b${field}\\??: ${type}`))
    }
    assert.match(editorSdk, /regex_edits\??:/)
    assert.doesNotMatch(editorSdk, /edit_run_code: unknown/)
    assert.equal(root.get('tools').get('edit_run_code'), undefined, 'editor must remain agent scoped')
    // The transport schema is whatever the assembled request publishes, not a
    // registry registration: a host may keep it inside its tool executor.
    const runParameters = initialAssembly.tools.find(tool => tool.name === 'run_code').parameters
    let step = 0
    const invoke = async (name, callId, args) => {
      step += 1
      session.append('step/start', { turn: 1, step })
      const assembly = await root.get('systemPrompt').assemble({ agent, scope: agent, signal })
      await enterStep(step)
      assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code'])
      assert.match(assembly.sections.find(section => section.name === 'tools:sdk')?.text, /edit_run_code: \{/)
      if (step === 2) assert.equal(stablePrompt(assembly), stablePrompt(initialAssembly))
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
      // The registry accepts one call on a registry host; a host that publishes
      // `selectExecutor` accepts a complete model batch and assigns the
      // execution identity itself.
      const registry = root.get('tools')
      const result = typeof registry.selectExecutor !== 'function'
        ? await registry.execute({ name, callId, arguments: args, agent, signal })
        : (await registry.execute({
          calls: [{ id: callId, name, arguments: argumentsValue }], signal, agent,
        })).results.find(entry => entry.callId === callId).result
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
    await profileTree.resolve(originalEntryId).update({ config: originalRow.config })
    await root.loader.await()
    assert.equal(root.get(seamService), provider)
    assert.equal(seam.active, true)
    assert.equal(state.originals.length, 2)
    const edited = await invoke('run_code', 'derived-cell', {
      code: 'return await tools.edit_run_code({ edits: [{ old_string: "+= 2", new_string: "+= 1" }] })',
      description: 'Revise the preceding cell',
    })
    assert.equal(edited.isError, false, JSON.stringify(edited))
    assert.equal(edited.value.result.accepted, true, JSON.stringify(edited))
    assert.equal(edited.value.result.scheduled, true, JSON.stringify(edited))
    assert.match(edited.value.logs.at(-1), /edit_run_code settled/)
    assert.ok(edited.content.some(block => block.type === 'text' && block.text === '43'),
      'root presentation must include the Host-rendered derived value')
    assert.ok(edited.meta?.dshPtcPlusPostEdit)
    const continued = await invoke('run_code', 'after-edit', { code: 'return shared', description: 'Read edited state' })
    assert.equal(continued.isError, false, JSON.stringify(continued))
    assert.deepEqual(continued.value, { logs: [], result: 43 })
    assert.equal(nativeCalls, 1)
    const syntax = await invoke('run_code', 'runtime-ts', {
      code: 'enum Kind { Answer=42 }; namespace Answer { export const value=Kind.Answer }; return Answer.value',
      description: 'Compute with TypeScript runtime forms',
    })
    assert.equal(syntax.isError, false, JSON.stringify(syntax))
    assert.deepEqual(syntax.value, { logs: [], result: 42 })
    for (const [id, code, expected] of [
      ['direct-bigint', 'return {big:9007199254740993n,count:1}', '{big: 9007199254740993n, count: 1}'],
      ['child-bigint', 'const child=await code.run({code:"return 2n",description:"Compute integer"}); return {type:typeof child.result,next:child.result+1n===3n}', {type:'bigint',next:true}],
      ['child-cycle', 'const child=await code.run({code:"const x={count:1};x.self=x;return x",description:"Compute graph"}); return {type:typeof child.result,self:child.result.self===child.result}', {type:'object',self:true}],
    ]) {
      const result = await invoke('run_code', id, {code,description:'Check value boundary'})
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.deepEqual(result.value, {logs:[],result:expected})
    }
    for (const [id, code, message] of [
      ['explicit-json', 'return JSON.stringify({big:2n})', /Do not know how to serialize a BigInt/],
      ['mixed-arithmetic', 'return 2n+1', /Cannot mix BigInt and other types/],
      ['native-bigint', 'return tools.execution_smoke_echo({value:2n})', /lossless JSON/],
      ['native-date', 'return tools.execution_smoke_echo({value:new Date(0)})', /parameter was not dispatched[^]*Date/],
    ]) {
      const result = await invoke('run_code', id, {code,description:'Check rejected value boundary'})
      assert.equal(result.isError, true, JSON.stringify(result))
      assert.match(JSON.stringify(result), message)
    }
    assert.equal(nativeCalls, 1, 'invalid native arguments must not dispatch')
    const finalAssembly = await root.get('systemPrompt').assemble({ agent, scope: agent, signal })
    assert.equal(stablePrompt(finalAssembly), stablePrompt(initialAssembly))
    const rejected = await invoke('run_code', 'schema-rejection', { code: 1, description: 'Invalid code type' })
    assert.equal(rejected.isError, true)
    assert.equal(nativeCalls, 1)
    assert.equal(state.runs.length, 1, 'session execution must not delegate to the frozen original')
    assert.deepEqual(finalAssembly.tools.find(tool => tool.name === 'run_code').parameters, runParameters)
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
    await profileTree.root.update([{ ...originalRow, isolate: null }])
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
  // A wrapped host failure keeps its cause; report it, or the smoke names a
  // symptom the reader cannot act on.
  console.error(error.cause === undefined ? error.message
    : `${error.message}\n${error.cause?.stack ?? String(error.cause)}`)
  process.exitCode = 1
})
