import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { auditBindingWorkflow } from '../scripts/acceptance-contract.mjs'
import { constantExportProof, proveStatusSource } from '../scripts/binding-status-proof.mjs'
import { bindingWorkflowHost } from './binding-workflow-fixture.js'
import { readBindingAction } from '../internal/user-binding-draft-projection.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

const scenario = JSON.parse(await readFile(new URL('../scripts/binding-workflow-scenario.json', import.meta.url), 'utf8'))
const statusSource = 'let result: string; try { result = `workflow.value() = ${workflow.value()}` } catch (e) { result = String(e) }; return result'

async function workflow(t) {
  const host = await bindingWorkflowHost(t)
  await host.begin(scenario.command, () => `return code.submitBindingDraft(${JSON.stringify({ requestId: host.requestId(), entry: scenario.entry })})`)
  const accepted = host.events().filter(event => event.type === 'tool/result').at(-1)
  const capability = accepted.data.meta.dshPtcPlusBindingDraft.capability
  const draft = (await host.rpc('draft', { capability })).value
  const catalog = (await host.rpc('list')).value
  assert.equal((await host.rpc('save-draft', { capability, version: draft.version, expectedRevision: catalog.revision, activate: true })).ok, true)
  await host.run(statusSource, scenario.statusQuestion)
  return host.events()
}

test('workflow audit owns completeness and proves the actual source without treating catch as executed', async t => {
  const events = await workflow(t)
  const audit = auditBindingWorkflow(events, scenario)
  assert.deepEqual(audit.failures, [])
  assert.equal(audit.status, 'machine-passed')
  assert.equal(audit.finalAnswer.review, 'semantic-review-required')
  assert.ok(audit.observations.some(item => item.target === 'String' && item.evidence === 'unreachable-source'))
  const statusCall = events.filter(event => event.type === 'tool/call').at(-1)
  const statusResult = events.filter(event => event.type === 'tool/result').at(-1)
  const accepted = events.find(event => event.data?.meta?.dshPtcPlusBindingDraft?.candidate != null)
  const save = events.find(event => readBindingAction(event.data) !== undefined)
  for (const [label, remove] of [
    ['command', event => event.type === 'command/run'],
    ['admission', event => event.type === 'command/done'],
    ['accepted', event => event === accepted],
    ['save', event => event === save],
    ['question', event => event.type === 'user/message' && event.data.source.kind === 'user'],
    ['answer', event => event.type === 'assistant/message' && event.seq > statusCall.seq],
    ['completion', event => event.type === 'turn/end' && event.seq > statusCall.seq],
    ['result', event => event === statusResult],
  ]) {
    const missing = auditBindingWorkflow(events.filter(event => !remove(event)), scenario)
    assert.equal(missing.status, 'incomplete', label)
    assert.ok(missing.failures.length > 0, label)
  }
  const unrelatedSave = structuredClone(events)
  unrelatedSave.find(event => event.seq === save.seq).sourceEventSeqs = [statusResult.seq]
  assert.equal(auditBindingWorkflow(unrelatedSave, scenario).status, 'incomplete')
  const unrelatedAcceptance = structuredClone(events)
  unrelatedAcceptance.find(event => event.seq === accepted.seq).sourceEventSeqs = [statusCall.seq]
  assert.equal(auditBindingWorkflow(unrelatedAcceptance, scenario).status, 'incomplete')
  assert.equal(auditBindingWorkflow([], scenario).status, 'incomplete')
  assert.equal(auditBindingWorkflow(events).status, 'incomplete')
  const after = [...events, { seq: events.at(-1).seq + 1, type: 'user/message', data: { source: { kind: 'user' } } },
    { seq: events.at(-1).seq + 2, type: 'tool/call', data: { callId: 'later', name: 'run_code',
      arguments: JSON.stringify({ code: 'await files.write("requested-later", "data")' }) } }]
  assert.equal(auditBindingWorkflow(after, scenario).status, 'machine-passed')
})

test('workflow audit rejects missing, replaced, damaged and shadowed source identities', async t => {
  const events = await workflow(t)
  const statusResult = events.filter(event => event.type === 'tool/result').at(-1)
  for (const change of [
    meta => { delete meta.dshPtcPlusUserBindings },
    meta => { meta.dshPtcPlusUserBindings.entries[0].source = 'export function value() { return 7 }' },
    meta => {
      const snapshot = createUserBindingsSnapshot({ entries: [{ ...scenario.entry, enabled: true, source: 'export function value() { return 7 }' }] })
      meta.dshPtcPlusUserBindings = snapshot
      meta.dshPtcPlus.userBindingsFingerprint = snapshot.fingerprint
    },
    meta => { meta.dshPtcPlus.userBindingsFingerprint = null },
  ]) {
    const altered = structuredClone(events)
    change(altered.find(event => event.seq === statusResult.seq).data.meta)
    assert.equal(auditBindingWorkflow(altered, scenario).status, 'unproved')
  }
  for (const source of [
    'const workflow = { value() { return 42 } }; return workflow.value()',
    'workflow.value = replacement; return workflow.value()',
    'return String({ toString() { throw new Error("effect") } })',
    'await files.mkdir("_miniFilesSmoke"); await files.write("_miniFilesSmoke/value", "x"); await files.remove("_miniFilesSmoke", { recursive: true })',
    'return Reflect.ownKeys(repl.state)',
    'new UnknownClient()',
    'await (getMethod())()',
    'return broken(',
  ]) {
    const altered = structuredClone(events)
    altered.filter(event => event.type === 'tool/call').at(-1).data.arguments = JSON.stringify({ code: source })
    assert.equal(auditBindingWorkflow(altered, scenario).status, 'unproved', source)
  }
  const inspection = structuredClone(events)
  const acceptedCall = inspection.find(event => event.type === 'tool/call')
  const args = JSON.parse(acceptedCall.data.arguments)
  args.code = 'await tools.read({ path: "bindings.json" });\n' + args.code
  acceptedCall.data.arguments = JSON.stringify(args)
  assert.match(auditBindingWorkflow(inspection, scenario).failures.join('\n'), /routine authoring/)
})

test('constant proofs are syntax-bounded and do not infer safety from a matching function name', () => {
  const entry = { ...scenario.entry, symbols: ['value'] }
  const proof = constantExportProof(entry, scenario.constantExports)
  assert.equal(proof.get('value'), 42)
  for (const source of [
    'export function value(arg = sideEffect()) { return 42 }',
    'sideEffect(); export function value() { return 42 }',
    'export function value() { sideEffect(); return 42 }',
    'export function value() { return otherValue }',
    'export async function value() { return 42 }',
  ]) assert.equal(constantExportProof({ ...entry, source }, scenario.constantExports).size, 0)
  assert.deepEqual(proveStatusSource(statusSource, entry, proof).problems, [])
  assert.deepEqual(proveStatusSource('return typeof workflow !== "undefined" && typeof workflow.value === "function"', entry).problems, [])
  assert.ok(proveStatusSource('return workflow.value()', entry).problems.length > 0)
  assert.ok(proveStatusSource('{ let x = 1 }; try { x = 2 } catch { sideEffect() }', entry).problems.length > 0)
  const conditionalMutation = proveStatusSource('let x = 0; typeof workflow.value === "function" && (x = 1); if (x === 0) sideEffect()', entry)
  assert.ok(conditionalMutation.problems.length > 0)
  assert.equal(conditionalMutation.observations[0].evidence, 'potential-source')
  const skipped = proveStatusSource('if (false) { sideEffect() }; return 42', entry)
  assert.deepEqual(skipped.problems, [])
  assert.equal(skipped.observations[0].evidence, 'unreachable-source')
  const unknown = proveStatusSource('try { unproved() } catch { sideEffect() }', entry)
  assert.ok(unknown.problems.length > 0)
  assert.ok(unknown.observations.every(item => item.evidence === 'potential-source'))
})
