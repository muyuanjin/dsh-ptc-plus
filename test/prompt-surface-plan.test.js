import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  capabilityPlanMessage,
  capabilityPlanText,
  capabilityPlanTextFromMessage,
  createCapabilityEnvironment,
} from '../internal/capability-environment.js'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { createCapabilityPlan } from '../internal/capability-plan.js'
import { LANES } from './prompt-surface-lanes.js'
import { PROMPT_SURFACE_COMPOSERS } from './prompt-surface-composers.js'

/**
 * Plan-channel capture.
 *
 * The planner composes the delivered plan from configuration, so the honest
 * observable is the text it hands to the model, not the settings it started from.
 * The lane pins that text as a recorded golden and proves the replay path returns
 * the same bytes, which is what the runtime and the surface gate depend on.
 *
 * Regenerate the golden deliberately: run this file, read the assertion failure, and
 * paste the reported text and hash into test/prompt-surface-lanes.js together with
 * the reason the delivered plan changed. Do not compute the golden from this run.
 */
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')

const agentFor = session => ({ id: session.id, session, signal: new AbortController().signal })

async function acceptPreparation(env, agent, sections = []) {
  const state = await env.prepare(agent, sections)
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  if (!(agent.session.snapshotEvents?.() ?? agent.session.events ?? []).some(event => event.type === 'system/message')) {
    agent.session.append('system/message', { turn: 1, step: 1,
      message: createSystemMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Fixture system prompt.' }] }) },
      { surfaceOp: 'append', protected: true })
  }
  for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return state
}

test('the delivered plan text is captured by hash and replays byte-identically', async t => {
  const session = Session.create('plan-capture-lane')
  const agent = agentFor(session)
  const ctx = { agents: { list: () => [agent] }, systemPrompt: { assemble: async () => ({ sections: [] }) },
    // The environment reads the session through the host query; this stub returns
    // the empty cut the fixture session already has.
    sessionQuery: { observeSession: async () => ({
      events: [], cursor: session.seq - 1, header: session.header, [Symbol.dispose]: () => {},
    }) } }
  const env = createCapabilityEnvironment({ ctx,
    // Two contracts and a contract budget smaller than their catalog: the planner
    // composes a category line for the tools it defers and an overage sentence for
    // the bytes that do not fit, so the lane covers the whole delivered plan rather
    // than its navigation paragraph.
    config: { capabilityManagementEnabled: true, capabilityBaseline: '[]', capabilityOverrides: '{"tools.probe":"full"}',
      capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
      capabilityBudgetBytes: 16, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 },
    toolSchemasForAgent: () => [
      { name: 'probe', description: 'Owner contract for probe.', parameters: { type: 'object' }, output: { type: 'string' } },
      { name: 'probe_two', description: 'Owner contract for probe_two.', parameters: { type: 'object' }, output: { type: 'string' } },
    ] })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agent)
  const snapshot = state.message.source.snapshot
  const delivered = capabilityPlanTextFromMessage(state.message, session.id)
  assert.equal(typeof delivered, 'string')
  assert.equal(delivered, LANES.plan.golden.text,
    'the delivered plan bytes differ from the recorded golden; if the change is intended, '
    + 'record the new text and hash in test/prompt-surface-lanes.js and say why')
  assert.equal(sha256(delivered), LANES.plan.golden.hash)
  // The projection must be the delivered bytes, and the snapshot composition must
  // reproduce them: a lane that only compared two live values would pass on any
  // silent change to both sides.
  assert.equal(delivered, state.message.content[0].text)
  assert.equal(capabilityPlanText(snapshot, session.id), delivered)
  // The gate hashes PROMPT_SURFACE_COMPOSERS.plan, so this lane must exercise the
  // same entry point; otherwise the gate could pin bytes no lane ever delivered.
  assert.equal(await PROMPT_SURFACE_COMPOSERS.plan(), LANES.plan.golden.text,
    'the gate composer and this lane must deliver the same plan bytes')
})

test('replay uses the recorded directory budget, not the current default literal', async t => {
  const session = Session.create('plan-budget-record')
  const agent = agentFor(session)
  const ctx = { agents: { list: () => [agent] }, systemPrompt: { assemble: async () => ({ sections: [] }) },
    sessionQuery: { observeSession: async () => ({
      events: [], cursor: session.seq - 1, header: session.header, [Symbol.dispose]: () => {},
    }) } }
  const navigation = 'Search capabilities before assuming one is missing.'
  const env = createCapabilityEnvironment({ ctx,
    config: { capabilityManagementEnabled: true, capabilityBaseline: '[]', capabilityOverrides: '{}',
      capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
      capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128,
      promptText: JSON.stringify({ schema: 'ptc-prompt-text/v1', overrides: { 'plan.navigationSentence': navigation } }) },
    toolSchemasForAgent: () => [] })
  t.after(() => env.dispose())
  const state = await acceptPreparation(env, agent)
  const snapshot = state.message.source.snapshot
  const recorded = snapshot.promptText
  assert.equal(snapshot.schema, 'ptc-capability-environment/v5')
  assert.equal(typeof recorded.directoryBudgetBytes, 'number',
    'a v5 snapshot must record the budget it was composed with')
  // A budget the current default literal could never reproduce: replaying the
  // snapshot must therefore take the recorded value, or the recomputed plan differs.
  // The snapshot below is forged on purpose — it is consistent with itself but never
  // came from a session log — because consistency is exactly what the replay contract
  // checks; provenance is not part of the claim.
  const bumped = recorded.directoryBudgetBytes + 64
  const plan = createCapabilityPlan({ ...snapshot.settings,
    configurationRevision: snapshot.plan.configurationRevision,
    capabilities: snapshot.capabilities, coverage: snapshot.coverage,
    navigationText: snapshot.navigationText, categories: recorded.categoryLines,
    directoryBudgetBytes: bumped })
  const replayable = { ...snapshot, promptText: { ...recorded, directoryBudgetBytes: bumped }, plan }
  const message = capabilityPlanMessage(replayable, session.id)
  assert.equal(capabilityPlanTextFromMessage(message, session.id), message.content[0].text,
    'a snapshot whose plan matches its recorded budget must replay')
  // The same record with a plan that disagrees with it stays rejected, so the check
  // above cannot pass by ignoring the plan as well.
  const stale = capabilityPlanMessage({ ...snapshot, promptText: { ...recorded, directoryBudgetBytes: bumped } }, session.id)
  assert.throws(() => capabilityPlanTextFromMessage(stale, session.id), /inconsistent session capability plan/u)
  // A record without a usable budget is damaged rather than silently defaulted.
  const missing = capabilityPlanMessage({ ...snapshot, promptText: { ...recorded, directoryBudgetBytes: -1 } }, session.id)
  assert.throws(() => capabilityPlanTextFromMessage(missing, session.id), /damaged|inconsistent session capability plan/u)
  // A record that does not name all five categories is damaged too: the record is the
  // only place the plan words exist, so a partial record would replay a partial plan.
  const partial = capabilityPlanMessage({ ...snapshot,
    promptText: { ...recorded, categoryLines: recorded.categoryLines.slice(0, 4) } }, session.id)
  assert.throws(() => capabilityPlanTextFromMessage(partial, session.id), /damaged capability plan text/u)
  // The plan schema must be the one its recorded settings produce; a v5 snapshot whose
  // plan claims another generation is inconsistent even when its digest is valid.
  const wrongSchema = capabilityPlanMessage({ ...snapshot,
    plan: { ...snapshot.plan, schema: 'ptc-capability-plan/v3' } }, session.id)
  assert.throws(() => capabilityPlanTextFromMessage(wrongSchema, session.id), /inconsistent session capability plan/u)
  // A historical generation records no plan words, so carrying a record is inconsistent
  // rather than harmless: its bytes could not have been composed from that generation.
  const historicalWithRecord = capabilityPlanMessage({ ...snapshot,
    schema: 'ptc-capability-environment/v1' }, session.id)
  assert.throws(() => capabilityPlanTextFromMessage(historicalWithRecord, session.id),
    /damaged|inconsistent capability plan text generation|inconsistent session capability plan/u)
  // The navigation sentence is one of the plan words the record carries. A snapshot
  // that delivers different navigation text than it recorded describes two different
  // plans, so it is damaged evidence instead of a replayable one.
  const otherNavigation = capabilityPlanMessage({ ...snapshot,
    navigationText: `${snapshot.navigationText} Ask again before concluding.` }, session.id)
  assert.throws(() => capabilityPlanTextFromMessage(otherNavigation, session.id), /damaged capability plan text/u)
})
