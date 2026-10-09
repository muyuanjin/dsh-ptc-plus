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
const { agentEvents } = await load('@deepseek-ai/dsh-agent')
const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { createScope } = await load('@deepseek-ai/dsh-scope')
const { buildForkSeed } = await load('@deepseek-ai/dsh-session/fork')
const { createAssistantMessage, createToolResultMessage, createUserMessage } = await load('@deepseek-ai/dsh-llm')
const pluginManifest = require.resolve('dsh-ptc-plus/package.json')
const manifest = JSON.parse(readFileSync(pluginManifest, 'utf8'))
const { recoverJournal, visibleExecutableCallSeqs } = await import(pathToFileURL(
  join(dirname(pluginManifest), 'internal/session-journal-recovery.js')).href)
const { projectSessionLog } = await import(pathToFileURL(
  join(dirname(pluginManifest), 'internal/session-log-view.js')).href)
const { readSessionLog } = await import(pathToFileURL(
  join(dirname(pluginManifest), 'internal/session-events.js')).href)
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
  let turn = 1
  const makeAgent = async () => {
    const controller = new AbortController()
    const agent = { id: session.id, session, signal: controller.signal, controller,
      inject: message => session.append('user/message', message, { surfaceOp: 'append' }) }
    const scope = createScope(root, agent); agent.ctx = scope.ctx; scopes.push(scope)
    await agentEvents(root, agent).serial('agent/created', {
      source: turn === 1 ? 'startup' : 'resume', signal: agent.signal,
    })
    return agent
  }
  let agent = await makeAgent()
  session.append('turn/start', { turn })
  let step = 0
  let firstPrompt
  const invoke = async (name, callId, args) => {
    step++
    session.append('step/start', { turn, step })
    const assembly = await root.get('systemPrompt').assemble({ agent, scope: agent, signal: agent.signal })
    await agentEvents(root, agent).waterfall('agent/pre-step', {
      agent, messages: [], turn, step, signal: agent.signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code'])
    const prompt = JSON.stringify({ sections: assembly.sections, tools: assembly.tools })
    const editorSdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    assert.match(editorSdk, /edit_run_code: \{/)
    for (const [field, type] of [['old_string', 'string'], ['new_string', 'string'],
      ['pattern', 'string'], ['flags', 'string'], ['replacement', 'string'],
      ['expected_matches', 'number'], ['accepted', 'boolean'], ['scheduled', 'boolean']]) {
      assert.match(editorSdk, new RegExp(`\\b${field}\\??: ${type}`))
    }
    assert.match(editorSdk, /regex_edits\??:/)
    assert.doesNotMatch(editorSdk, /edit_run_code: unknown/)
    if (session.id === firstSessionId && step === 1) firstPrompt = prompt
    if (session.id === firstSessionId && step === 2) assert.equal(prompt, firstPrompt)
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
  const derivedContext = createUserMessage({ content: [{ type: 'text', text: 'Packed derived context for result policy.' }],
    source: { kind: 'ptc-mode' } })
  let contextDispatches = 0
  root.effect(() => root.tools.register(defineTool({ name: 'packed_context', description: 'Provide a result context.',
    parameters: {}, output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: (_args, exec) => { contextDispatches++; exec.deferContext(derivedContext); return 0 },
  })))
  const firstSessionId = session.id
  const withoutTarget = await invoke('run_code', 'packed-no-target', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "missing", new_string: "present" }] })',
    description: 'Check missing edit target',
  })
  assert.equal(withoutTarget.isError, false, JSON.stringify(withoutTarget))
  assert.equal(withoutTarget.value.result.accepted, false)
  assert.equal(withoutTarget.value.result.scheduled, false)
  assert.equal(withoutTarget.meta?.dshPtcPlusPostEdit, undefined)
  const derivedCalls = []
  const recursionResults = []
  const disposeDerivedObserver = root.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'run_code' && exec.rootCallId === 'packed-editor-recursion'
      && exec.callId !== exec.rootCallId) derivedCalls.push(exec.callId)
    return next()
  })
  const disposeRecursionResults = root.on('tools/result', (exec, result) => {
    if (exec.name === 'run_code' && exec.rootCallId === 'packed-editor-recursion') {
      recursionResults.push({ callId: exec.callId, rootCallId: exec.rootCallId, ...result })
    }
  })
  const recursiveEdit = await invoke('run_code', 'packed-editor-recursion', {
    code: 'const firstReceipt=await tools.edit_run_code({ edits: [{ old_string: "missing", new_string: "stillMissing" }] }); const secondReceipt=await tools.edit_run_code({ edits: [{ old_string: "present", new_string: "stillPresent" }] }); return {firstReceipt,secondReceipt}',
    description: 'Keep one edit authority across derived execution',
  })
  disposeDerivedObserver()
  disposeRecursionResults()
  const recursionEvents = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
  const recursionStarts = recursionEvents.filter(event => event.type === 'tool/ptc-dispatch-start'
    && event.data.name === 'edit_run_code' && event.data.rootCallId === 'packed-editor-recursion')
  record('derived-editor-dispatch-identities', {
    starts: recursionStarts.map(event => ({ seq: event.seq, ...event.data })),
    derivedCalls,
  })
  assert.equal(recursiveEdit.isError, false, JSON.stringify(recursiveEdit))
  assert.equal(recursiveEdit.value.result.firstReceipt.accepted, true, JSON.stringify(recursiveEdit))
  assert.equal(recursiveEdit.value.result.firstReceipt.scheduled, true)
  assert.equal(recursiveEdit.value.result.secondReceipt.accepted, false)
  assert.equal(recursiveEdit.value.result.secondReceipt.scheduled, false)
  assert.equal(derivedCalls.length, 1, 'one model root must dispatch exactly one derived run')
  assert.equal(recursionStarts.length, 3, 'both root editors and the derived editor must use the Host SDK')
  const actualDerivedStart = recursionEvents.find(event => event.type === 'tool/ptc-dispatch-start'
    && event.data.name === 'run_code' && event.data.subCallId === derivedCalls[0])
  assert.equal(actualDerivedStart?.data.rootCallId, 'packed-editor-recursion')
  assert.equal(actualDerivedStart?.data.parentCallId, 'packed-editor-recursion')
  const actualDerivedResult = recursionEvents.find(event => event.type === 'tool/ptc-dispatch'
    && event.data.subCallId === actualDerivedStart?.data.subCallId)
  assert.equal(actualDerivedResult?.data.isError, false, JSON.stringify(actualDerivedResult))
  assert.equal(recursiveEdit.meta.dshPtcPlusPostEdit.executionStartSeq, actualDerivedStart.seq)
  const derivedEditorStart = recursionStarts.find(event => event.data.parentCallId === derivedCalls[0])
  assert.ok(derivedEditorStart, 'derived editor must preserve its real derived parent and original root')
  const derivedEditorResult = recursionEvents.find(event => event.type === 'tool/ptc-dispatch'
    && event.data.subCallId === derivedEditorStart.data.subCallId)
  assert.equal(derivedEditorResult?.data.isError, false, JSON.stringify(derivedEditorResult))
  const derivedReceipt = JSON.parse(derivedEditorResult.data.content[0].text)
  assert.equal(derivedReceipt.accepted, false)
  assert.equal(derivedReceipt.scheduled, false)
  assert.match(derivedReceipt.reason, /derived|root|unavailable|eligible/i)
  assert.ok(recursiveEdit.meta?.dshPtcPlusPostEdit, JSON.stringify({ recursiveEdit, recursionResults }))
  const persistedRecursionResult = recursionEvents.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === 'packed-editor-recursion')
  assert.deepEqual(persistedRecursionResult?.data.meta, recursiveEdit.meta)
  assert.equal(recursionResults.find(result => result.callId === derivedCalls[0])?.isError, false)
  record('single-root-editor-authority', { passed: true, acceptedRootEdits: 1, derivedCalls: 1,
    derivedEditorAccepted: false, derivedEditorScheduled: false })
  const first = await invoke('run_code', 'packed-first', { code: "import {value as earlier} from './value.mjs'; const loadEarlier=()=>import('./value.mjs'); let shared=await tools.packed_echo({value:40}); return [earlier,shared,process.cwd()]", description: 'Initialize computation' })
  assert.equal(root.tools.get('edit_run_code'), undefined, 'editor must remain scoped to the agent')
  assert.ok(root.tools.get('edit_run_code', agent))
  assert.equal(first.isError, false, JSON.stringify(first))
  assert.deepEqual(first.value, { logs: [], result: [1, 40, directories[0]] })
  await root.get('workingDirectory').set(agent, directories[1], agent.signal)
  const second = await invoke('run_code', 'packed-second', { code: "import {value as current} from './value.mjs'; shared+=2; return [earlier,current,(await loadEarlier()).value,shared,process.cwd(),await (await import('node:fs/promises')).readFile('input.txt','utf8')]", description: 'Continue in changed directory' })
  assert.equal(second.isError, false, JSON.stringify(second))
  assert.deepEqual(second.value, { logs: [], result: [1, 2, 1, 42, directories[1], '2'] })
  assert.equal(session.header.cwd, directories[0]); assert.equal(nativeCalls, 1)
  record('live-directory-and-native-dispatch', { passed: true, immutableHeader: true, oldSource: 1, currentSource: 2 })
  let editorPolicyInput
  const disposeEditorResultPolicy = root.on('tools/post-execute', (exec, result, next) => {
    if (exec.name === 'run_code' && exec.callId === 'packed-editor') {
      editorPolicyInput = result
      assert.ok(result.meta?.dshPtcPlusPostEdit, 'post-execute policy must receive the edit provenance')
      assert.ok(result.content.some(block => block.type === 'text'
        && block.text === JSON.stringify([1, 2, 1, 43, directories[1], '2'], null, 2)),
      'post-execute policy must receive the Host-rendered derived values')
    }
    return next()
  }, { prepend: true })
  const editor = await invoke('run_code', 'packed-editor', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "shared+=2", new_string: "shared+=1" }] })',
    description: 'Revise the previous cell',
  })
  disposeEditorResultPolicy()
  assert.equal(editor.isError, false, JSON.stringify(editor))
  assert.equal(editor.value.result.accepted, true, JSON.stringify(editor))
  assert.equal(editor.value.result.scheduled, true, JSON.stringify(editor))
  assert.ok(editor.meta?.dshPtcPlusPostEdit)
  assert.ok(editorPolicyInput)
  assert.deepEqual(editor.value, editorPolicyInput.value)
  assert.match(editor.value.logs.at(-1), /edit_run_code settled/)
  assert.ok(editor.content.some(block => block.type === 'text'
    && block.text === JSON.stringify([1, 2, 1, 43, directories[1], '2'], null, 2)),
    'root presentation must include the Host-rendered derived values')
  const nestedStart = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
    .find(event => event.type === 'tool/ptc-dispatch-start'
      && event.data.name === 'edit_run_code' && event.data.rootCallId === 'packed-editor')
  const nestedResult = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
    .find(event => event.type === 'tool/ptc-dispatch' && event.data.subCallId === nestedStart?.data.subCallId)
  assert.equal(nestedStart?.data.rootCallId, 'packed-editor')
  assert.equal(nestedResult?.data.isError, false)
  assert.equal(JSON.parse(nestedResult.data.content[0].text).scheduled, true)
  const executionStart = session.eventAt(editor.meta.dshPtcPlusPostEdit.executionStartSeq)
  assert.equal(executionStart.type, 'tool/ptc-dispatch-start')
  assert.equal(executionStart.data.name, 'run_code')
  assert.equal(executionStart.data.rootCallId, 'packed-editor')
  assert.equal(executionStart.data.parentCallId, 'packed-editor')
  assert.equal(editor.meta.dshPtcPlusPostEdit.startSeq, nestedStart.seq)
  assert.notEqual(executionStart.seq, nestedStart.seq)
  const executionResult = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
    .find(event => event.type === 'tool/ptc-dispatch'
      && event.data.subCallId === executionStart.data.subCallId)
  assert.equal(executionResult?.data.isError, false)
  const beforeContinuation = await readSessionLog(session, root.get('sessionQuery'), agent.signal)
  const visibleCallSeqs = visibleExecutableCallSeqs(beforeContinuation)
  const recoveryBeforeContinuation = recoverJournal(beforeContinuation, undefined, { visibleCallSeqs })
  const afterEdit = await invoke('run_code', 'packed-after-edit', { code: 'return shared', description: 'Read revised state' })
  if (afterEdit.isError) {
    record('edited-state-continuation-failure', {
      immutableHeaderCwd: session.header.cwd,
      currentExecutionCwd: directories[1],
      surfaceNodes: beforeContinuation.surface.nodes,
      sourceMessages: beforeContinuation.surface.sourceMessages,
      visibleCallSeqs: [...visibleCallSeqs],
      toolCalls: beforeContinuation.events.filter(event => event.type === 'tool/call'),
      toolResults: beforeContinuation.events.filter(event => event.type === 'tool/result'),
      nestedStart,
      nestedResult,
      rootJournal: editor.meta.dshPtcPlus,
      postEdit: editor.meta.dshPtcPlusPostEdit,
      projection: projectSessionLog({ session: beforeContinuation }),
      recovery: { ...recoveryBeforeContinuation, checkpoints: [...recoveryBeforeContinuation.checkpoints] },
      currentResult: afterEdit,
    })
  }
  assert.equal(afterEdit.isError, false, JSON.stringify(afterEdit))
  assert.equal(afterEdit.value.result, 43)
  record('live-nested-edit-settlement', { passed: true, scheduled: true, retainedValue: 43 })
  const invalidEdit = await invoke('run_code', 'packed-invalid-edit', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: 12, new_string: "changed" }] })',
    description: 'Reject invalid edit arguments',
  })
  assert.equal(invalidEdit.isError, false, JSON.stringify(invalidEdit))
  assert.equal(invalidEdit.value.result.accepted, false)
  assert.equal(invalidEdit.value.result.scheduled, false)
  assert.match(invalidEdit.value.result.reason, /old_string and new_string strings/)
  assert.equal(invalidEdit.meta?.dshPtcPlusPostEdit, undefined)
  const invalidRoot = await invoke('run_code', 'packed-invalid-root', {
    code: 12, description: 'Reject an invalid root schema before execution',
  })
  assert.equal(invalidRoot.isError, true, JSON.stringify(invalidRoot))
  assert.equal(invalidRoot.meta?.dshPtcPlusPostEdit, undefined)
  const disposeEditorDenial = root.on('tools/pre-execute', (exec, next) => (
    exec.name === 'edit_run_code' && exec.rootCallId === 'packed-denied-edit'
      ? Promise.resolve({ kind: 'deny', reason: 'packed editor policy denial' })
      : next()
  ))
  const deniedEdit = await invoke('run_code', 'packed-denied-edit', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "shared", new_string: "revised" }] })',
    description: 'Check scoped editor policy',
  })
  assert.equal(deniedEdit.isError, true, JSON.stringify(deniedEdit))
  assert.equal(deniedEdit.meta?.dshPtcPlusPostEdit, undefined)
  assert.match(JSON.stringify(deniedEdit), /packed editor policy denial/)
  disposeEditorDenial()
  const enteredEditorPolicy = Promise.withResolvers()
  const releaseEditorPolicy = Promise.withResolvers()
  let cancelledDerivedDispatches = 0
  const disposeEditorPolicy = root.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'run_code' && exec.rootCallId === 'packed-cancelled-edit'
      && exec.callId !== exec.rootCallId) cancelledDerivedDispatches++
    if (exec.name !== 'edit_run_code' || exec.rootCallId !== 'packed-cancelled-edit') return next()
    enteredEditorPolicy.resolve()
    await releaseEditorPolicy.promise
    return next()
  })
  const cancelledPromise = invoke('run_code', 'packed-cancelled-edit', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "shared", new_string: "cancelledShared" }] })',
    description: 'Cancel an in-flight editor dispatch',
  })
  await enteredEditorPolicy.promise
  agent.controller.abort(new Error('packed editor cancellation'))
  releaseEditorPolicy.resolve()
  const cancelledEdit = await cancelledPromise
  disposeEditorPolicy()
  assert.equal(cancelledEdit.isError, true, JSON.stringify(cancelledEdit))
  assert.equal(cancelledEdit.meta?.dshPtcPlusPostEdit, undefined)
  const cancelledDispatch = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
    .find(event => event.type === 'tool/ptc-dispatch' && event.data.rootCallId === 'packed-cancelled-edit')
  assert.equal(cancelledDispatch?.data.isError, true)
  assert.equal(cancelledDerivedDispatches, 0)
  assert.equal(nativeCalls, 1)
  await agentEvents(root, agent).serial('agent/disposed', { agent })
  await scopes.at(-1).dispose()
  agent = await makeAgent()
  const afterCancellation = await invoke('run_code', 'packed-after-cancel', {
    code: 'return [typeof shared,typeof cancelledShared]', description: 'Observe contracted state after cancellation and agent recreation',
  })
  assert.equal(afterCancellation.isError, false, JSON.stringify(afterCancellation))
  assert.deepEqual(afterCancellation.value.result, ['undefined', 'undefined'])
  assert.equal(afterCancellation.meta.dshPtcPlus.diagnostics.filter(item => item.code === 'PTC-R002').length, 1)
  const newAfterCancellation = await invoke('run_code', 'packed-new-after-cancel', {
    code: 'let cancellationContinuation=7; return cancellationContinuation', description: 'Continue computation after cancellation recovery',
  })
  assert.equal(newAfterCancellation.isError, false, JSON.stringify(newAfterCancellation))
  assert.equal(newAfterCancellation.value.result, 7)
  assert.equal(newAfterCancellation.meta.dshPtcPlus.diagnostics.filter(item => item.code === 'PTC-R002').length, 0)
  assert.equal(nativeCalls, 1, 'cancellation recovery cannot redispatch earlier effects')
  record('cancelled-editor-agent-recreation', { passed: true, derivedDispatches: 0,
    unreconstructableBindingsDiscarded: true, recoveryNotices: 1, continuationValue: 7, redispatchedEffects: 0 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await sessions.flush(session)
  await scopes.at(-1).dispose()
  assert.equal(root.tools.get('edit_run_code', agent), undefined, 'disposed agent must release its editor')
  // A public fork seed persists exact ancestry before a fresh session identity
  // reconstructs pure computation. No owner withdrawal or external effect is
  // used to establish this cold replay counterexample.
  const parentSession = session
  const parentDetach = detach
  const parentWriter = writer
  session = sessions.prepare('packed-edit-policy', { meta: { cwd: directories[0] } })
  writer = await persistence.create(session.header)
  await storeUnpublished(session, writer)
  detach = sessions.enter(session); sessions.announce(session)
  agent = await makeAgent(); step = 0
  session.append('turn/start', { turn })
  const policySetup = await invoke('run_code', 'policy-setup', {
    code: 'let policyValue=1; return policyValue', description: 'Initialize result-policy computation',
  })
  assert.equal(policySetup.isError, false, JSON.stringify(policySetup))
  const replacementContent = [{ type: 'text', text: 'Official result-policy replacement retained.' }]
  const blockedContent = [{ type: 'text', text: 'Official result-policy block retained.' }]
  const policyObservations = []
  const disposeResultPolicy = root.on('tools/post-execute', (exec, result, next) => {
    if (exec.name !== 'run_code' || !['policy-replaced', 'policy-blocked'].includes(exec.callId)) return next()
    const expectedValue = exec.callId === 'policy-replaced' ? '2' : '3'
    assert.ok(result.content.some(block => block.type === 'text' && block.text === expectedValue),
      'result policy must observe the derived presentation before selecting its decision')
    assert.deepEqual(result.additionalContexts, [derivedContext])
    assert.ok(result.meta?.dshPtcPlusPostEdit)
    policyObservations.push(exec.callId)
    return Promise.resolve(exec.callId === 'policy-replaced'
      ? { kind: 'accept', content: replacementContent }
      : { kind: 'block', feedback: blockedContent })
  }, { prepend: true })
  const replaced = await invoke('run_code', 'policy-replaced', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "return policyValue", new_string: "await tools.packed_context({}); return policyValue+1" }] })',
    description: 'Retain the official result-policy replacement',
  })
  assert.equal(replaced.isError, false, JSON.stringify(replaced))
  assert.equal(replaced.value.result.accepted, true)
  assert.deepEqual(replaced.content, replacementContent)
  assert.deepEqual(replaced.additionalContexts, [derivedContext])
  assert.ok(replaced.meta?.dshPtcPlusPostEdit)
  const blocked = await invoke('run_code', 'policy-blocked', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "policyValue+1", new_string: "policyValue+2" }] })',
    description: 'Retain the official result-policy block',
  })
  disposeResultPolicy()
  assert.equal(blocked.isError, true, JSON.stringify(blocked))
  assert.deepEqual(blocked.content, blockedContent)
  assert.equal(blocked.additionalContexts, undefined, 'blocked derived contexts must remain discarded')
  assert.equal(blocked.meta?.dshPtcPlusPostEdit, undefined, 'a blocked root cannot establish edited recovery evidence')
  assert.deepEqual(policyObservations, ['policy-replaced', 'policy-blocked'])
  assert.equal(contextDispatches, 2, 'result policy cannot undo derived effects already performed')
  const afterBlock = await invoke('run_code', 'policy-after-block', {
    code: 'return 7', description: 'Continue after a result-policy block',
  })
  assert.equal(afterBlock.isError, false, JSON.stringify(afterBlock))
  assert.equal(afterBlock.value.result, 7)
  record('derived-presentation-before-result-policy', { passed: true, policyObservedContentAndContext: true,
    replacementRetained: true, blockRetained: true, blockedContextsDiscarded: true })
  session.append('turn/end', { turn, reason: { kind: 'completed' } }); await sessions.flush(session)
  await scopes.at(-1).dispose(); detach(); await writer.close()
  session = sessions.prepare('packed-durable', { meta: { cwd: directories[0] } })
  writer = await persistence.create(session.header)
  await storeUnpublished(session, writer)
  detach = sessions.enter(session); sessions.announce(session)
  agent = await makeAgent(); step = 0
  session.append('turn/start', { turn })
  const durableFirst = await invoke('run_code', 'durable-first', { code: 'let durable=await tools.packed_echo({value:41}); const firstBase=import.meta.dirname; return durable', description: 'Initialize durable state' })
  assert.equal(durableFirst.isError, false, JSON.stringify(durableFirst))
  await root.get('workingDirectory').set(agent, directories[1], agent.signal)
  const durableSecond = await invoke('run_code', 'durable-second', { code: 'durable+=1; const secondBase=import.meta.dirname; return durable', description: 'Update durable state' })
  assert.equal(durableSecond.isError, false, JSON.stringify(durableSecond))
  let durableEditorDispatches = 0
  const disposeDurableEditorObserver = root.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'edit_run_code') durableEditorDispatches++
    return next()
  })
  const durableEdit = await invoke('run_code', 'durable-editor', {
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "durable+=1", new_string: "durable+=0" }] })',
    description: 'Retain an edited durable cell for cold replay',
  })
  assert.equal(durableEdit.isError, false, JSON.stringify(durableEdit))
  assert.equal(durableEdit.value.result.accepted, true)
  assert.ok(durableEdit.meta?.dshPtcPlusPostEdit, JSON.stringify(durableEdit))
  assert.equal(durableEditorDispatches, 1)
  assert.equal(nativeCalls, 2)
  session.append('turn/end', { turn, reason: { kind: 'completed' } }); await sessions.flush(session)
  const seed = buildForkSeed(Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq)), session.seq - 1)
  const fork = sessions.prepare('packed-cold-fork', { seed, inheritedEventCount: session.seq,
    meta: { cwd: directories[0], parentSession: session.id, isSeeded: true } })
  const forkWriter = await persistence.create(fork.header, { inheritedEventCount: fork.inheritedEventCount })
  await storeUnpublished(fork, forkWriter); await forkWriter.close()
  await scopes.at(-1).dispose(); detach(); await writer.close()
  const forkReader = await persistence.open(fork.id, 'read')
  const forkStored = await forkReader.read(); const forkHeader = forkReader.header
  const forkInherited = forkReader.inheritedEventCount; await forkReader.close()
  session = sessions.prepare(fork.id, { seed: forkStored.events, meta: forkHeader,
    inheritedEventCount: forkInherited, eventState: forkStored.eventState })
  writer = await persistence.open(session.id, 'write')
  await storeUnpublished(session, writer, forkStored.events.length)
  detach = sessions.enter(session); sessions.announce(session)
  turn = 2; agent = await makeAgent(); step = 0
  session.append('turn/start', { turn })
  await root.get('workingDirectory').set(agent, directories[2], agent.signal)
  const restored = await invoke('run_code', 'fork-cold', { code: 'return [durable,firstBase,secondBase,import.meta.dirname]', description: 'Continue cold fork' })
  assert.equal(restored.isError, false, JSON.stringify(restored))
  assert.deepEqual(restored.value, { logs: [], result: [42, directories[0], directories[1], directories[2]] })
  assert.equal(nativeCalls, 2, 'cold replay must return the recorded native value without redispatch')
  assert.equal(durableEditorDispatches, 1, 'cold replay must not dispatch the recorded editor again')
  disposeDurableEditorObserver()
  record('persisted-cold-fork', { passed: true, retainedValue: 42, originalDirectories: true,
    redispatchedEffects: 0, redispatchedEditors: 0, retainedEditedJournal: true })
  session.append('turn/end', { turn, reason: { kind: 'completed' } }); await sessions.flush(session)
  await scopes.at(-1).dispose(); detach(); await writer.close()
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
  turn = 2; agent = await makeAgent(); step = 0; session.append('turn/start', { turn })
  await root.get('workingDirectory').set(agent, directories[2], agent.signal)
  const cold = await invoke('run_code', 'packed-cold', { code: 'return [earlier,current,(await loadEarlier()).value,shared,process.cwd()]', description: 'Resume recorded computation' })
  // This source used unreconstructable Node inputs. It must contract while
  // the separate pure persisted fork above remains reconstructable.
  record('cold-after-owner-withdrawal', { isError: cold.isError, error: cold.error })
  assert.equal(cold.isError, true, 'unreconstructable source must not be revived by a new owner')
  const reset = await invoke('run_code', 'packed-new', { code: 'let resumed=7; return [resumed,process.cwd()]', description: 'Compute after withdrawal' })
  assert.equal(reset.isError, false, JSON.stringify(reset))
  assert.deepEqual(reset.value, { logs: [], result: [7, directories[2]] })
  await scopes.at(-1).dispose()
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
  console.log('Packed lifecycle checks passed through the official PTC root and nested editor SDK.')
} finally {
  for (const scope of scopes) await scope.dispose()
  await root.fiber.dispose()
  await rm(profile, { recursive: true, force: true })
}
