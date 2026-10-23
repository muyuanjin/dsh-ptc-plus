import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import {
  capabilityPlanText, capabilityPlanTextFromMessage, createCapabilityEnvironment,
} from '../internal/capability-environment.js'

/**
 * One delivery of the plan channel, shared by the lane test and the surface gate.
 *
 * The gate must hash the bytes a composer actually delivers, not a value the lane
 * asserts about itself, so both callers build the same fixture through this
 * function. The fixture defers one contract (so a category line is composed) and
 * selects another as a full contract over a 16-byte budget (so the overage sentence
 * is delivered), which is what lets the lane cover the whole plan.
 */
export const PLAN_LANE_CONFIG = Object.freeze({
  capabilityManagementEnabled: true,
  capabilityBaseline: '[]',
  capabilityOverrides: '{"tools.probe":"full"}',
  capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
  capabilityBudgetBytes: 16,
  capabilityDirectoryBytes: 4096,
  capabilityRecoveryBytes: 4096,
  modelPreviewTokens: 128,
})

const agentFor = session => ({ id: session.id, session, signal: new AbortController().signal })

async function acceptPreparation(env, agent, sections = []) {
  const state = await env.prepare(agent, sections)
  const decision = await env.preStep({ agent, signal: agent.signal }, async () => ({ kind: 'enter', messages: [] }))
  if (!(agent.session.snapshotEvents?.() ?? agent.session.events ?? []).some(event => event.type === 'system/message')) {
    agent.session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage({
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: 'Fixture system prompt.' }],
      }),
    }, { surfaceOp: 'append', protected: true })
  }
  for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return state
}

/**
 * Delivers one plan message and returns it with the text the model receives.
 *
 * The caller owns disposal of `env`, so a test can keep the environment alive for
 * later assertions; `deliverPlan` returns it rather than closing it.
 */
export async function deliverPlan({ name = 'plan-capture-lane', config = {}, toolSchemasForAgent } = {}) {
  const session = Session.create(name)
  const agent = agentFor(session)
  const ctx = {
    agents: { list: () => [agent] },
    systemPrompt: { assemble: async () => ({ sections: [] }) },
    // The environment reads the session through the host query; this stub returns
    // the empty cut the fixture session already has.
    sessionQuery: {
      observeSession: async () => ({
        events: [], cursor: session.seq - 1, header: session.header, [Symbol.dispose]: () => {},
      }),
    },
  }
  const env = createCapabilityEnvironment({
    ctx,
    config: { ...PLAN_LANE_CONFIG, ...config },
    toolSchemasForAgent: toolSchemasForAgent ?? (() => [
      { name: 'probe', description: 'Owner contract for probe.', parameters: { type: 'object' }, output: { type: 'string' } },
      { name: 'probe_two', description: 'Owner contract for probe_two.', parameters: { type: 'object' }, output: { type: 'string' } },
    ]),
  })
  try {
    const state = await acceptPreparation(env, agent)
    return {
      env,
      session,
      message: state.message,
      snapshot: state.message.source.snapshot,
      text: capabilityPlanTextFromMessage(state.message, session.id),
      projection: capabilityPlanText(state.message.source.snapshot, session.id),
    }
  } catch (error) {
    env.dispose()
    throw error
  }
}
