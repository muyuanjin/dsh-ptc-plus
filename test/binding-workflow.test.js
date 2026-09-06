import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { bindingWorkflowHost } from './binding-workflow-fixture.js'
import { createUserBindingDraftProjection, readBindingAction } from '../internal/user-binding-draft-projection.js'
import { auditBindingWorkflow } from '../scripts/acceptance-contract.mjs'

const scenario = JSON.parse(await readFile(new URL('../scripts/binding-workflow-scenario.json', import.meta.url), 'utf8'))
const { entry } = scenario

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

test('public binding lifecycle preserves the prompt, records exact source and separates saving from activation', { timeout: 20000 }, async t => {
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
  const observed = await host.run('return typeof workflow !== "undefined" && typeof workflow.value === "function"', scenario.statusQuestion)
  assert.equal(observed.data.message.content[0].isError, false)
  assert.ok(host.requests.some(request => JSON.stringify(request.messages).includes('"state":"saved"')
    || JSON.stringify(request.messages).includes('\\"state\\":\\"saved\\"')))
  assert.ok(host.requests.some(request => JSON.stringify(request.messages).includes('successfully activated')))
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
  assert.deepEqual(projection.wire.view(fold(restored.snapshotEvents())).history, history)
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
  for (const request of host.requests) {
    assert.equal(JSON.stringify({ system: request.system, tools: request.tools }), prefix)
    assert.deepEqual(request.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  }
  await host.restart()
  const replayed = await host.run('return acceptedReceipt')
  assert.equal(replayed.data.message.content[0].isError, false)
  assert.equal((await host.rpc('draft', { capability })).value, null)
  const afterReplay = await host.run(`return code.submitBindingDraft(${JSON.stringify({ requestId, entry })})`)
  assert.equal(afterReplay.data.message.content[0].isError, true)
})
