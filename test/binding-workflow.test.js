import assert from 'node:assert/strict'
import { sessionEvents } from '../internal/session-events.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { bindingWorkflowHost } from './binding-workflow-fixture.js'
import { createUserBindingDraftProjection, readBindingAction } from '../internal/user-binding-draft-projection.js'
import { auditBindingWorkflow, auditRuntimeContexts } from '../scripts/acceptance-contract.mjs'
import { readRuntimeMessage } from '../internal/runtime-messages.js'
import { decodeValue } from '../internal/value-wire.js'

const scenario = JSON.parse(await readFile(new URL('../scripts/binding-workflow-scenario.json', import.meta.url), 'utf8'))
const { entry } = scenario

function configuredBindingPrompt(request) {
  const snapshot = request.messages.map(readRuntimeMessage).filter(record => record?.form === 'catalog').at(-1)
  return snapshot?.sections.find(section => section.name === 'tools:ptc-plus-user-binding-defaults')?.text ?? ''
}

function assertStablePrefix(host) {
  for (const request of host.requests) {
    assert.equal(request.system, host.requests[0].system)
    assert.deepEqual(request.tools, host.requests[0].tools)
  }
  assert.equal(host.events().some(event => event.type === 'request/header' && event.data.reason === 'change'), false)
}

test('binding authoring develops, compares and checks exact candidate source in memory before submission', { timeout: 20000 }, async t => {
  const host = await bindingWorkflowHost(t)
  await host.run('const existingValue = 42; return existingValue')
  const before = (await host.rpc('list')).value
  const source = 'export function clean(value: string): string { return value.trim() }'
  const lastValue = () => decodeValue(host.events().filter(event => event.type === 'tool/result')
    .at(-1).data.meta.dshPtcPlus.completion.value)
  await host.begin('new Trim outer whitespace while preserving interior spaces. Test empty and whitespace-only input.', [
    options => {
      const task = options.messages.findLast(message => message.source?.form === 'instructions').content[0].text
      assert.match(task, /small run_code cells before submission/)
      assert.match(task, /in-memory inputs and assertions/)
      assert.match(task, /must not write or delete files/)
      assert.match(task, /review unknown effects without running/)
      assert.match(task, /node:assert\/strict/)
      assert.match(task, /print totals and a few representative failures/)
      assert.match(task, /substitute verifies only the behavior its assertions cover/)
      assert.match(task, /final source, selected exports, types and usage prompt/)
      assert.match(task, /leave instructions empty when the interface is sufficient/)
      assert.doesNotMatch(task, /Do not persist, enable, execute|Only the user can save, enable or run|chain.of.thought|think step by step|repl\.state|recovery snapshot/)
      return 'const samples = ["  a  b  ", "", "   "]; const trial = (s: string) => s.replace(/\\s+/g, " ").trim(); return samples.map(trial)'
    },
    () => {
      assert.deepEqual(lastValue(), ['a b', '', ''])
      return `const draftSource = ${JSON.stringify(source)}; ${source}; return samples.map(clean)`
    },
    () => {
      assert.deepEqual(lastValue(), ['a  b', '', ''])
      return 'const expected = ["a  b", "", ""]; if (!samples.every((value, i) => clean(value) === expected[i])) throw new Error("trim contract failed"); return { passed: samples.length, preserved: existingValue }'
    },
    () => {
      assert.deepEqual(lastValue(), { passed: 3, preserved: 42 })
      return `return code.submitBindingDraft({ requestId: ${JSON.stringify(host.requestId())}, entry: { id: "cleaner", name: "cleaner", scope: "namespace", purpose: "Trim outer whitespace.", source: draftSource, modelContext: { includeDeclaration: true, instructions: "" } } })`
    },
  ])
  const accepted = host.events().filter(event => event.type === 'tool/result').at(-1)
  const capability = accepted.data.meta.dshPtcPlusBindingDraft.capability
  const draft = (await host.rpc('draft', { capability })).value
  assert.equal(draft.entry.source, source)
  assert.equal(draft.entry.enabled, false)
  assert.deepEqual(draft.entry.modelContext, { includeDeclaration: true, instructions: '' })
  assert.deepEqual((await host.rpc('list')).value, before)
  assert.equal(host.events().filter(event => event.type === 'command/run').length, 1)
  assert.equal(host.events().filter(event => event.type === 'tool/call').length, 5)
  assert.equal(host.requests.flatMap(request => request.messages).some(message => readRuntimeMessage(message)?.form === 'catalog'), false)
  assertStablePrefix(host)
})

test('successful activation does not repeat configured prompts or interfaces in model requests', { timeout: 20000 }, async t => {
  const host = await bindingWorkflowHost(t)
  const configured = {
    id: 'files', name: 'fileTools', scope: 'namespace', enabled: true,
    source: 'let count = 0; export function next(): number { return ++count }',
    modelContext: { includeDeclaration: true, instructions: 'Use fileTools.next() for the next count.' },
  }
  const catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { entry: configured, expectedRevision: catalog.revision })).ok, true)
  const snapshots = () => host.events().filter(event => event.type === 'user/message'
    && readRuntimeMessage(event.data)?.form === 'catalog')
  const declarations = request => request.messages.flatMap(message => message.content)
    .filter(part => part.type === 'text')
    .reduce((count, part) => count + part.text.split('declare const fileTools: {').length - 1, 0)
  await host.run('return fileTools.next()')
  assert.equal(snapshots().length, 1)
  assert.equal(host.requests.length, 2)
  for (const request of host.requests) {
    assert.equal(declarations(request), 1)
    assert.equal(configuredBindingPrompt(request).split(configured.modelContext.instructions).length - 1, 1)
    const message = request.messages.find(message => readRuntimeMessage(message)?.form === 'catalog')
    assert.match(message.content[0].text, /^Global binding API reference for run_code \(replaces the previous global binding reference\):\n\nBinding: fileTools\n\n/)
    assert.doesNotMatch(message.content[0].text, /runtime.context|recovery|initializ|shadow|repl\.state|DSH authority|Configured Global User Bindings/)
  }
  await host.run('return fileTools.next()')
  assert.equal(snapshots().length, 1)
  await host.run('const fileTools = { next: () => 99 }; return fileTools.next()')
  assert.equal(snapshots().length, 1)
  await host.restart()
  await host.run('return 0')
  assert.equal(snapshots().length, 1)
  for (const request of host.requests) assert.equal(declarations(request), 1)
  assertStablePrefix(host)
})

test('initializer failure stays in the tool result without an activation announcement', { timeout: 20000 }, async t => {
  const host = await bindingWorkflowHost(t)
  const configured = {
    id: 'broken', name: 'brokenTools', scope: 'namespace', enabled: true,
    source: 'throw new Error("initializer failed"); export const value = 1',
    modelContext: { includeDeclaration: true, instructions: 'Use brokenTools.value when available.' },
  }
  const catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { entry: configured, expectedRevision: catalog.revision })).ok, true)
  const result = await host.run('return 0')
  assert.match(JSON.stringify(result.data.message.content), /initializer failed/)
  assert.deepEqual(result.data.meta.dshPtcPlusUserBindings.entries, [])
  const snapshots = host.events().filter(event => event.type === 'user/message'
    && readRuntimeMessage(event.data)?.form === 'catalog')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].data.content[0].text.split('declare const brokenTools: {').length - 1, 1)
  for (const request of host.requests) {
    assert.match(configuredBindingPrompt(request), /^Binding: brokenTools\n\nUse brokenTools.value when available\./)
    assert.doesNotMatch(configuredBindingPrompt(request), /successfully activated/)
  }
  assertStablePrefix(host)
})

test('export failure and continuation retain values without repeating the binding catalog', { timeout: 20000 }, async t => {
  const host = await bindingWorkflowHost(t)
  const configured = {
    id: 'counter', name: 'auditCounter', scope: 'namespace', enabled: true,
    source: 'let value = 0; export function next(): number { return ++value }',
  }
  const catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { entry: configured, expectedRevision: catalog.revision })).ok, true)
  await host.run('return auditCounter.next()')
  const failed = await host.run('export const exportProbe = 42; throw new Error("audit-export-failure")')
  assert.match(JSON.stringify(failed.data.message.content), /partially-applied/)
  const resumed = await host.run('return [exportProbe, auditCounter.next()]')
  assert.deepEqual(decodeValue(resumed.data.meta.dshPtcPlus.completion.value), [42, 2])
  await host.restart()
  const recovered = await host.run('return [exportProbe, auditCounter.next()]')
  assert.deepEqual(decodeValue(recovered.data.meta.dshPtcPlus.completion.value), [42, 3])
  const messages = host.events().filter(event => event.type === 'user/message').map(event => readRuntimeMessage(event.data))
    .filter(Boolean)
  assert.deepEqual(messages.map(message => message.form), ['catalog'])
  for (const request of host.requests) {
    const text = request.messages.flatMap(message => message.content).filter(block => block.type === 'text')
      .map(block => block.text).join('\n')
    assert.equal(text.split('declare const auditCounter: {').length - 1, 1)
  }
  assert.deepEqual(auditRuntimeContexts(host.events(), { allowed: [
    { name: 'tools:ptc-plus-user-binding-defaults', maxChars: 16384 },
  ] }).failures, [])
  assertStablePrefix(host)
})

test('binding authoring and mid-session changes publish the prompt independently of the interface', { timeout: 20000 }, async t => {
  const host = await bindingWorkflowHost(t)
  const authored = { ...entry, modelContext: { includeDeclaration: true, instructions: 'Use workflow.value() for the configured value. Render {{name}} literally.' } }
  await host.run('return 0')
  await host.begin(scenario.command, () => `return code.submitBindingDraft(${JSON.stringify({ requestId: host.requestId(), entry: authored })})`)
  const accepted = host.events().filter(event => event.type === 'tool/result').at(-1)
  const { capability } = accepted.data.meta.dshPtcPlusBindingDraft
  const draft = (await host.rpc('draft', { capability })).value
  assert.deepEqual(draft.entry.modelContext, authored.modelContext)
  let catalog = (await host.rpc('list')).value
  const saved = await host.rpc('save-draft', { capability, version: draft.version, expectedRevision: catalog.revision, activate: false })
  assert.equal(saved.ok, true)
  await host.run('return 1')
  assert.equal(configuredBindingPrompt(host.requests.at(-1)), '')
  const enabled = await host.rpc('enable', { id: entry.id, expectedRevision: saved.value.revision })
  assert.equal(enabled.ok, true)
  const firstEnabledRequest = host.requests.length
  await host.run('return workflow.value()')
  const firstPrompt = configuredBindingPrompt(host.requests[firstEnabledRequest])
  assert.ok(firstPrompt.includes(authored.modelContext.instructions))
  assert.match(firstPrompt, /declare const workflow/)
  assert.doesNotMatch(firstPrompt, /successfully activated/)
  const changedPrompt = { ...authored, enabled: true, modelContext: { ...authored.modelContext,
    instructions: 'Use workflow.value() only when the task needs the saved value.' } }
  catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { entry: changedPrompt, expectedRevision: catalog.revision })).ok, true)
  const firstChangedRequest = host.requests.length
  await host.run('return workflow.value()')
  assert.ok(configuredBindingPrompt(host.requests[firstChangedRequest]).includes(changedPrompt.modelContext.instructions))
  assert.match(configuredBindingPrompt(host.requests[firstChangedRequest]), /declare const workflow/)
  assert.doesNotMatch(configuredBindingPrompt(host.requests[firstChangedRequest]), /Render/)
  const promptOnly = { ...authored, enabled: true, modelContext: { includeDeclaration: false, instructions: 'Prefer workflow.value() over guessing defaults. Keep {{not valid}} and {{{nested}}} literal.' } }
  catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { entry: promptOnly, expectedRevision: catalog.revision })).ok, true)
  await host.run('return workflow.value()')
  assert.ok(configuredBindingPrompt(host.requests.at(-1)).includes(promptOnly.modelContext.instructions))
  assert.doesNotMatch(configuredBindingPrompt(host.requests.at(-1)), /declare const workflow|Use workflow.value/)
  const snapshotCount = () => host.events().filter(event => event.type === 'user/message'
    && readRuntimeMessage(event.data)?.form === 'catalog').length
  const beforeRepeat = snapshotCount()
  await host.run('return workflow.value()')
  assert.equal(snapshotCount(), beforeRepeat)
  catalog = (await host.rpc('list')).value
  const disabled = await host.rpc('disable', { id: entry.id, expectedRevision: catalog.revision })
  assert.equal(disabled.ok, true)
  await host.run('return 2')
  assert.equal(configuredBindingPrompt(host.requests.at(-1)), '')
  assert.equal((await host.rpc('enable', { id: entry.id, expectedRevision: disabled.value.revision })).ok, true)
  await host.run('return workflow.value()')
  assert.match(configuredBindingPrompt(host.requests.at(-1)), /Prefer workflow.value/)
  assert.doesNotMatch(configuredBindingPrompt(host.requests.at(-1)), /declare const workflow/)
  await host.restart()
  const beforeRestartRequest = snapshotCount()
  await host.run('return workflow.value()')
  assert.equal(snapshotCount(), beforeRestartRequest)
  assert.match(configuredBindingPrompt(host.requests.at(-1)), /Prefer workflow.value/)
  catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('remove', { id: entry.id, expectedRevision: catalog.revision })).ok, true)
  await host.run('return 3')
  assert.equal(configuredBindingPrompt(host.requests.at(-1)), '')
  const snapshots = host.requests.at(-1).messages.map(readRuntimeMessage).filter(record => record?.form === 'catalog')
  assert.deepEqual(snapshots.at(-1).sections, [])
  assert.ok(snapshots.some(record => record.sections.some(section => section.text.includes(authored.modelContext.instructions))))
  assertStablePrefix(host)
  for (let index = 1; index < host.requests.length; index++) {
    const previous = host.requests[index - 1].messages
    assert.deepEqual(host.requests[index].messages.slice(0, previous.length), previous)
  }
})

test('initial binding prompts and changed interfaces honor host runtime-context suppression', { timeout: 20000 }, async t => {
  const host = await bindingWorkflowHost(t)
  const savedEntry = { ...entry, enabled: true, modelContext: { includeDeclaration: true, instructions: 'First request instructions.' } }
  let catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { entry: savedEntry, expectedRevision: catalog.revision })).ok, true)
  await host.run('return 0')
  assert.match(configuredBindingPrompt(host.requests[0]), /First request instructions/)
  assert.match(configuredBindingPrompt(host.requests[0]), /declare const workflow/)
  assert.doesNotMatch(host.requests[0].system, /First request instructions|declare const workflow/)
  const release = host.agent.ctx.systemPrompt.suppressRuntimeContext()
  t.after(release)
  catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { expectedRevision: catalog.revision, entry: {
    ...savedEntry, source: 'export function revised(): string { return "revised" }',
    modelContext: { includeDeclaration: true, instructions: 'Updated {{name}} instructions.' },
  } })).ok, true)
  const beforeSuppression = host.events().filter(event => event.type === 'user/message' && readRuntimeMessage(event.data)).length
  await host.run('return 1')
  assert.equal(host.events().filter(event => event.type === 'user/message' && readRuntimeMessage(event.data)).length, beforeSuppression)
  assert.doesNotMatch(configuredBindingPrompt(host.requests.at(-1)), /Updated|revised/)
  release()
  const nextRequest = host.requests.length
  await host.run('return workflow.revised()')
  assert.match(configuredBindingPrompt(host.requests[nextRequest]), /Updated \{\{name\}\} instructions/)
  assert.match(configuredBindingPrompt(host.requests[nextRequest]), /revised\(\): string/)
  assert.doesNotMatch(configuredBindingPrompt(host.requests[nextRequest]), /value\(\)|First request/)
  assertStablePrefix(host)
})

test('file-helper availability observes the active export without write/delete probes', { timeout: 20000 }, async t => {
  const files = JSON.parse(await readFile(new URL('../scripts/binding-files-workflow-scenario.json', import.meta.url), 'utf8'))
  const host = await bindingWorkflowHost(t)
  const existing = join(host.home, files.expected.preserveExistingDirectory)
  await mkdir(existing)
  const sentinel = join(existing, files.expected.preserveSentinel)
  await writeFile(sentinel, 'pre-existing user content')
  await host.begin(files.command, () => `return code.submitBindingDraft(${JSON.stringify({ requestId: host.requestId(), entry: files.entry })})`)
  const accepted = host.events().filter(event => event.type === 'tool/result').at(-1)
  const capability = accepted.data.meta.dshPtcPlusBindingDraft.capability
  const draft = (await host.rpc('draft', { capability })).value
  const catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save-draft', { capability, version: draft.version, expectedRevision: catalog.revision, activate: true })).ok, true)
  const observed = await host.run('return typeof miniFiles !== "undefined" && typeof miniFiles.write === "function" && typeof miniFiles.remove === "function"', files.statusQuestion)
  assert.equal(observed.data.message.content[0].isError, false)
  assert.deepEqual(auditBindingWorkflow(host.events(), files).failures, [])
  assert.equal(await readFile(sentinel, 'utf8'), 'pre-existing user content')
  const probing = structuredClone(host.events())
  probing.filter(event => event.type === 'tool/call').at(-1).data.arguments = JSON.stringify({
    code: 'await miniFiles.mkdir("_miniFilesSmoke"); await miniFiles.write("_miniFilesSmoke/probe", "x"); await miniFiles.remove("_miniFilesSmoke")',
  })
  const rejected = auditBindingWorkflow(probing, files)
  assert.equal(rejected.status, 'unproved')
  assert.ok(rejected.observations.some(item => item.target === 'miniFiles.remove'))
})

test('public binding lifecycle preserves each configured prompt and separates saving from activation', { timeout: 20000 }, async t => {
  const host = await bindingWorkflowHost(t)
  const existingDirectory = join(host.home, '_miniFilesSmoke')
  await mkdir(existingDirectory)
  const sentinel = join(existingDirectory, 'unrelated.txt')
  await writeFile(sentinel, 'pre-existing user content')
  await host.run('return 1')
  const prefix = JSON.stringify({ system: host.requests[0].system, tools: host.requests[0].tools })
  const noRequest = await host.run(`return code.submitBindingDraft(${JSON.stringify({ requestId: 'missing', entry })})`)
  assert.equal(noRequest.data.message.content[0].isError, true)
  const command = await host.begin(scenario.command, () => (
    `const acceptedReceipt = await code.submitBindingDraft(${JSON.stringify({ requestId: host.requestId(), entry })}); return acceptedReceipt`
  ))
  assert.equal(command.result.kind, 'success')
  const requestId = host.requestId()
  const result = host.events().filter(event => event.type === 'tool/result').at(-1)
  const metadata = result.data.meta.dshPtcPlusBindingDraft
  assert.equal(metadata.version, 2)
  assert.equal(metadata.candidate.entry.source, entry.source)
  assert.equal(metadata.candidate.commandId, command.commandId)
  assert.equal(result.data.meta.dshPtcPlus.calls[0].global, 'code')
  assert.equal(result.data.meta.dshPtcPlus.calls[0].member, 'submitBindingDraft')
  const { capability } = metadata
  const draft = (await host.rpc('draft', { capability })).value
  const catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save-draft', { capability, version: draft.version,
    expectedRevision: catalog.revision, activate: true })).ok, true)
  assert.equal((await host.rpc('draft', { capability })).value, null)
  assert.equal((await host.rpc('save-draft', { capability, version: draft.version,
    expectedRevision: catalog.revision, activate: true })).ok, false)
  const actionEvent = host.events().find(event => readBindingAction(event.data)?.state === 'saved')
  assert.ok(actionEvent.sourceEventSeqs.includes(result.seq))
  assert.equal(JSON.parse(await readFile(join(host.home, 'ptc-plus', 'bindings.json'), 'utf8')).entries[0].enabled, true)
  const configuredStart = host.requests.length
  const observed = await host.run('return typeof workflow !== "undefined" && typeof workflow.value === "function"', scenario.statusQuestion)
  const configuredPrefix = JSON.stringify({ system: host.requests[configuredStart].system, tools: host.requests[configuredStart].tools })
  assert.equal(configuredPrefix, prefix)
  assert.match(configuredBindingPrompt(host.requests[configuredStart]), /declare const workflow/)
  assert.doesNotMatch(configuredBindingPrompt(host.requests[configuredStart]), /successfully activated/)
  assert.equal(observed.data.message.content[0].isError, false)
  assert.ok(host.requests.some(request => JSON.stringify(request.messages).includes('"state":"saved"')
    || JSON.stringify(request.messages).includes('\\"state\\":\\"saved\\"')))
  assert.ok(host.requests.every(request => !JSON.stringify(request.messages).includes('successfully activated')))
  assert.equal(observed.data.meta.dshPtcPlusUserBindings.entries[0].id, entry.id)
  const question = host.events().find(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && event.data.content[0].text === scenario.statusQuestion)
  assert.deepEqual(auditBindingWorkflow(host.events(), {
    ...scenario,
    statusQuestionSeq: question.seq,
  }).failures, [])
  assert.equal(await readFile(sentinel, 'utf8'), 'pre-existing user content')
  const projection = createUserBindingDraftProjection(metadata.generation)
  const fold = events => events.reduce((state, event) => projection.apply(state, event), projection.init())
  const history = projection.wire.view(fold(host.events())).history
  assert.equal(history[0].candidate.entry.source, entry.source)
  assert.equal(history[0].action.state, 'saved')
  const restored = Session.create('restored-binding-workflow', host.events())
  assert.deepEqual(projection.wire.view(fold(sessionEvents(restored))).history, history)
  const savedCatalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { expectedRevision: savedCatalog.revision,
    entry: { ...entry, enabled: true, source: 'export function value(): number { return 99 }' } })).ok, true)
  assert.equal((await host.rpc('draft-review', { capability })).value.candidate.entry.source, entry.source)
  assert.equal(projection.wire.view(fold(host.events())).history[0].candidate.entry.source, entry.source)
  await host.begin('new cancelled helper')
  const endedRequest = host.requestId()
  const late = await host.run(`return code.submitBindingDraft(${JSON.stringify({ requestId: endedRequest, entry })})`)
  assert.equal(late.data.message.content[0].isError, true)
  host.agent.cancel()
  await host.run('return 2')
  await host.begin('new replacement helper')
  const oldRequest = host.requestId()
  await host.begin('new newer helper', `return code.submitBindingDraft(${JSON.stringify({ requestId: oldRequest, entry: { ...entry, id: 'another', name: 'another' } })})`)
  const rejected = host.events().filter(event => event.type === 'tool/result').at(-1)
  assert.equal(rejected.data.message.content[0].isError, true)
  for (const [index, request] of host.requests.entries()) {
    assert.equal(JSON.stringify({ system: request.system, tools: request.tools }), index < configuredStart ? prefix : configuredPrefix)
    assert.deepEqual(request.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  }
  await host.restart()
  const replayed = await host.run('return acceptedReceipt')
  assert.equal(replayed.data.message.content[0].isError, false)
  assert.equal((await host.rpc('draft', { capability })).value, null)
  const currentCatalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save', { expectedRevision: currentCatalog.revision,
    entry: { ...entry, enabled: true, modelContext: { includeDeclaration: false } } })).ok, true)
  await host.run('return 1')
  assert.doesNotMatch(host.requests.at(-1).system, /declare const workflow/)
  assert.deepEqual(host.requests.at(-1).tools, host.requests[0].tools)
  const afterReplay = await host.run(`return code.submitBindingDraft(${JSON.stringify({ requestId, entry })})`)
  assert.equal(afterReplay.data.message.content[0].isError, true)
})
