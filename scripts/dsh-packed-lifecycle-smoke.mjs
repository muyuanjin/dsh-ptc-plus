import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// All imports resolve from the extracted npm consumer, never the source checkout.
const require = createRequire(join(process.cwd(), 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const { loadOverlayPatches, composeEntries, mountRootInclude } = await load('@deepseek-ai/dsh-app-boot')
const { ToolRuntime, defineTool } = await load('@deepseek-ai/dsh-tools')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { SessionStore } = await load('@deepseek-ai/dsh-session')
const { SessionQueryEngine } = await load('@deepseek-ai/dsh-session-query')
const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { createScope } = await load('@deepseek-ai/dsh-scope')
const { buildForkSeed } = await load('@deepseek-ai/dsh-session/fork')
const { createAssistantMessage, createToolResultMessage, createUserMessage } = await load('@deepseek-ai/dsh-llm')
const pluginManifest = require.resolve('dsh-ptc-plus/package.json')
const manifest = JSON.parse(readFileSync(pluginManifest, 'utf8'))
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const base = dirname(baseRequire.resolve('@deepseek-ai/dsh-base/package.json'))
const official = composeEntries([loadOverlayPatches('dsh', join(base, 'cordis.patch.yml'))])
const publicOwners = ['subprocess', 'sandbox', 'sandbox-policy', 'working-directory', 'ptc-runtime']
const selected = publicOwners.map(id => {
  const row = official.find(entry => entry.id === id)
  assert.ok(row, `official base composition lacks ${id}`)
  return { ...row, ...(id === 'sandbox-policy' ? { config: { ...row.config, mode: 'danger-full-access' } } : {}) }
})
const patch = loadOverlayPatches('dsh', join(dirname(pluginManifest), manifest.dsh.bundle.patch))
const profile = await mkdtemp(join(tmpdir(), 'ptc-packed-lifecycle-'))
const root = new Context()
const scopes = []
const reports = []
const record = (name, details) => { reports.push({ name, ...details }); console.log(JSON.stringify(reports.at(-1))) }
try {
  root.effect(() => root.provide('agents', { list: () => [] }))
  new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
  new ToolRuntime(root, { mode: 'ptc' })
  for (const service of [SessionStore, SessionQueryEngine, SessionProjectionRegistry]) await root.plugin(service).await()
  await root.plugin(Jsonl, { root: join(profile, 'sessions'), compression: 'none' }).await()
  await root.plugin(Loader, { baseUrl: pathToFileURL(process.cwd() + '/').href }).await()
  const originalRows = [{ id: 'fs-local', name: '@deepseek-ai/dsh-fs-local' }, ...selected]
  const rows = composeEntries([[{ insert: originalRows }], patch])
  for (const row of rows) {
    row.name = pathToFileURL(require.resolve(row.name)).href
    if (row.id === 'ptc-plus') row.config = { userBindingsEnabled: false, cordisToolsEnabled: false }
  }
  const filename = join(profile, 'cordis.json')
  await writeFile(filename, JSON.stringify(rows))
  const include = await mountRootInclude(root, filename)
  await root.loader.await()
  const tree = include.subtree
  await tree.resolve('ptc-plus').fiber.await()
  const provider = root.get('ptcRuntime')
  assert.equal(provider[Symbol.for('dsh-ptc-plus.execution-seam')]().active, true)
  record('packed-bundle-install', { installed: true, host: require('@deepseek-ai/dsh/package.json').version,
    provider: require('@deepseek-ai/dsh-ptc-runtime-node/package.json').version })
  const directories = ['a', 'b', 'c'].map(name => join(profile, name))
  for (const [index, directory] of directories.entries()) {
    await mkdir(directory)
    await writeFile(join(directory, 'value.mjs'), `export const value=${index + 1}`)
    await writeFile(join(directory, 'input.txt'), String(index + 1))
  }
  const sessions = root.get('sessions')
  let session = sessions.prepare('packed-computation', { meta: { cwd: directories[0] } })
  const persistence = root.get('sessionPersistence')
  const storeUnpublished = async (candidate, handle, storedCount = 0) => {
    const suffix = []
    for (let seq = storedCount; seq < candidate.seq; seq++) suffix.push(candidate.eventAt(seq))
    if (suffix.length) await handle.append(suffix)
    await handle.flush()
  }
  let writer = await persistence.create(session.header)
  await storeUnpublished(session, writer)
  let detach = sessions.enter(session); sessions.announce(session)
  const makeAgent = () => {
    const agent = { id: session.id, session, signal: new AbortController().signal,
      inject: message => session.append('user/message', message, { surfaceOp: 'append' }) }
    const scope = createScope(root, agent); agent.ctx = scope.ctx; scopes.push(scope)
    return agent
  }
  let agent = makeAgent()
  let turn = 1
  session.append('turn/start', { turn })
  // This direct deterministic provider probe does not assemble a model prompt.
  // Full plugin prompt assembly still installs the undeclared third mode; this
  // bounded legal PTC path cannot establish deployed two-transport admission.
  let releaseMode = agent.ctx.tools.presentAs('ptc')
  let step = 0
  const invoke = async (name, callId, args) => {
    step++
    session.append('step/start', { turn, step })
    const encoded = JSON.stringify(args)
    session.append('assistant/message', { turn, step,
      message: createAssistantMessage({ source: { provider: 'local-contract', model: 'deterministic' },
        content: [{ type: 'tool-call', id: callId, name, arguments: encoded }] }),
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'tool-call-start', index: 0, id: callId, name } },
        { type: 'chunk', time: 1, chunk: { type: 'tool-call-delta', index: 0, id: callId, arguments: encoded } },
        { type: 'chunk', time: 2, chunk: { type: 'tool-call-end', index: 0, id: callId } }],
    }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn, step, name, callId, arguments: encoded })
    const result = await root.get('tools').execute({ agent, signal: agent.signal, name, callId, arguments: args })
    session.append('tool/result', { turn, step,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...(result.meta === undefined ? {} : { meta: result.meta }), ...(result.error === undefined ? {} : { error: result.error }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn, step })
    return result
  }
  let nativeCalls = 0
  root.effect(() => root.tools.register(defineTool({ name: 'packed_echo', description: 'Return a number.',
    parameters: { value: { type: 'number', required: true } },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: ({ value }) => { nativeCalls++; return value },
  })))
  const first = await invoke('run_code', 'packed-first', { code: "import {value as earlier} from './value.mjs'; const loadEarlier=()=>import('./value.mjs'); let shared=await tools.packed_echo({value:40}); return [earlier,shared,process.cwd()]", description: 'Initialize computation' })
  assert.equal(first.isError, false, JSON.stringify(first))
  assert.deepEqual(first.value, { logs: [], result: [1, 40, directories[0]] })
  await root.get('workingDirectory').set(agent, directories[1], agent.signal)
  const second = await invoke('run_code', 'packed-second', { code: "import {value as current} from './value.mjs'; shared+=2; return [earlier,current,(await loadEarlier()).value,shared,process.cwd(),await (await import('node:fs/promises')).readFile('input.txt','utf8')]", description: 'Continue in changed directory' })
  assert.equal(second.isError, false, JSON.stringify(second))
  assert.deepEqual(second.value, { logs: [], result: [1, 2, 1, 42, directories[1], '2'] })
  assert.equal(session.header.cwd, directories[0]); assert.equal(nativeCalls, 1)
  record('live-directory-and-native-dispatch', { passed: true, immutableHeader: true, oldSource: 1, currentSource: 2 })
  const editor = await invoke('edit_run_code', 'packed-editor', { edits: [{ old_string: 'shared+=2', new_string: 'shared+=1' }] })
  assert.equal(editor.isError, true)
  assert.match(JSON.stringify(editor), /UNKNOWN_TOOL|not available|not declared|unknown tool|PTC/i)
  record('joint-direct-admission', { passed: false, boundary: 'public PTC mode rejects root edit_run_code',
    error: editor.error, deployedPresentation: 'plugin uses undeclared both; lawful mode override is probe-only' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await sessions.flush(session)
  releaseMode(); await scopes.at(-1).dispose()
  // A public fork seed persists exact ancestry before a fresh session identity
  // reconstructs pure computation. No owner withdrawal or external effect is
  // used to establish this cold replay counterexample.
  const parentSession = session
  const parentDetach = detach
  const parentWriter = writer
  session = sessions.prepare('packed-durable', { meta: { cwd: directories[0] } })
  writer = await persistence.create(session.header)
  await storeUnpublished(session, writer)
  detach = sessions.enter(session); sessions.announce(session)
  agent = makeAgent(); releaseMode = agent.ctx.tools.presentAs('ptc'); step = 0
  session.append('turn/start', { turn })
  const durableFirst = await invoke('run_code', 'durable-first', { code: 'let durable=41; const firstBase=import.meta.dirname; return durable', description: 'Initialize durable state' })
  assert.equal(durableFirst.isError, false, JSON.stringify(durableFirst))
  await root.get('workingDirectory').set(agent, directories[1], agent.signal)
  const durableSecond = await invoke('run_code', 'durable-second', { code: 'durable+=1; const secondBase=import.meta.dirname; return durable', description: 'Update durable state' })
  assert.equal(durableSecond.isError, false, JSON.stringify(durableSecond))
  session.append('turn/end', { turn, reason: { kind: 'completed' } }); await sessions.flush(session)
  const seed = buildForkSeed(Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq)), session.seq - 1)
  const fork = sessions.prepare('packed-cold-fork', { seed, inheritedEventCount: session.seq,
    meta: { cwd: directories[0], parentSession: session.id, isSeeded: true } })
  const forkWriter = await persistence.create(fork.header, { inheritedEventCount: fork.inheritedEventCount })
  await storeUnpublished(fork, forkWriter); await forkWriter.close()
  releaseMode(); await scopes.at(-1).dispose(); detach(); await writer.close()
  const forkReader = await persistence.open(fork.id, 'read')
  const forkStored = await forkReader.read(); const forkHeader = forkReader.header
  const forkInherited = forkReader.inheritedEventCount; await forkReader.close()
  session = sessions.prepare(fork.id, { seed: forkStored.events, meta: forkHeader,
    inheritedEventCount: forkInherited, eventState: forkStored.eventState })
  writer = await persistence.open(session.id, 'write')
  await storeUnpublished(session, writer, forkStored.events.length)
  detach = sessions.enter(session); sessions.announce(session)
  agent = makeAgent(); releaseMode = agent.ctx.tools.presentAs('ptc'); turn = 2; step = 0
  session.append('turn/start', { turn })
  await root.get('workingDirectory').set(agent, directories[2], agent.signal)
  const restored = await invoke('run_code', 'fork-cold', { code: 'return [durable,firstBase,secondBase,import.meta.dirname]', description: 'Continue cold fork' })
  assert.equal(restored.isError, false, JSON.stringify(restored))
  assert.deepEqual(restored.value, { logs: [], result: [42, directories[0], directories[1], directories[2]] })
  assert.equal(nativeCalls, 1)
  record('persisted-cold-fork', { passed: true, retainedValue: 42, originalDirectories: true, redispatchedEffects: 0 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } }); await sessions.flush(session)
  releaseMode(); await scopes.at(-1).dispose(); detach(); await writer.close()
  session = parentSession; detach = parentDetach; writer = parentWriter
  // Dispose the runtime before cold restore; do not replay external effects.
  await tree.resolve('ptc-plus').update({ disabled: true }); await root.loader.await()
  detach(); await writer.close()
  const reader = await persistence.open(session.id, 'read')
  const stored = await reader.read(); const header = reader.header; const inherited = reader.inheritedEventCount
  await reader.close()
  session = sessions.prepare(session.id, { seed: stored.events, meta: header, inheritedEventCount: inherited, eventState: stored.eventState })
  writer = await persistence.open(session.id, 'write')
  await storeUnpublished(session, writer, stored.events.length)
  detach = sessions.enter(session); sessions.announce(session)
  await tree.resolve('ptc-plus').update({ disabled: false }); await root.loader.await()
  agent = makeAgent(); turn = 2; step = 0; session.append('turn/start', { turn })
  releaseMode = agent.ctx.tools.presentAs('ptc')
  await root.get('workingDirectory').set(agent, directories[2], agent.signal)
  const cold = await invoke('run_code', 'packed-cold', { code: 'return [earlier,current,(await loadEarlier()).value,shared,process.cwd()]', description: 'Resume recorded computation' })
  // This source used unreconstructable Node inputs. It must contract while
  // the separate pure persisted fork above remains reconstructable.
  record('cold-after-owner-withdrawal', { isError: cold.isError, error: cold.error })
  assert.equal(cold.isError, true, 'unreconstructable source must not be revived by a new owner')
  const reset = await invoke('run_code', 'packed-new', { code: 'let resumed=7; return [resumed,process.cwd()]', description: 'Compute after withdrawal' })
  assert.equal(reset.isError, false, JSON.stringify(reset))
  assert.deepEqual(reset.value, { logs: [], result: [7, directories[2]] })
  releaseMode(); await scopes.at(-1).dispose()
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } }); await sessions.flush(session)
  const original = originalRows.map(row => ({ ...row, name: pathToFileURL(require.resolve(row.name)).href, isolate: null }))
  const retiringFiber = tree.resolve('ptc-plus').fiber
  await tree.root.update(original); await root.loader.await(); await retiringFiber.await()
  const nativeProvider = root.get('ptcRuntime')
  assert.equal(nativeProvider[Symbol.for('dsh-ptc-plus.execution-seam')], undefined)
  const spec = await nativeProvider.resolve({ program: 'return 19', bindings: [], cwd: directories[2], signal: agent.signal })
  assert.equal((await nativeProvider.run(spec)).value, 19)
  const cut = await root.get('sessionQuery').observeSession(session.id, { projectionMode: 'none' })
  try {
    assert.ok(Array.isArray(cut.events))
    const last = cut.events.findLast(event => event.type === 'user/message' && event.data.source?.form === 'runtime-availability')
    assert.equal(last?.data.source.state, 'unloaded')
  } finally { cut[Symbol.dispose]() }
  record('actual-node-provider-handback', { passed: true, nativeResult: 19, durableWithdrawal: true })
  console.log('Packed lifecycle checks passed in the explicit legal PTC probe scope; full joint-root compatibility remains pending.')
} finally {
  for (const scope of scopes) await scope.dispose()
  await root.fiber.dispose()
  await rm(profile, { recursive: true, force: true })
}
