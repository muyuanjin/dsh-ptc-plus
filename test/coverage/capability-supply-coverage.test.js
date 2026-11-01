import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createCapabilityEnvironment } from '../../internal/capability-environment.js'

const config = { capabilityManagementEnabled: true, capabilityBaseline: '[]', capabilityOverrides: '{}',
  capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
  capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 }
const toolSchema = name => ({ name, description: `Owner contract for ${name}.`,
  parameters: { type: 'object' }, output: { type: 'string' } })

/**
 * A supply row the presentation map does not describe.
 *
 * A row states the namespace that owns a capability when the supply's own display entry says
 * nothing about it. No ordinary Skill catalogue leaves a capability out of that map, so this
 * case reaches the fallback through the one public input that can: a descriptor the inventory
 * cannot read twice the same way, because the row identity and the presentation key come from
 * two separate reads of its name.
 */
const undescribedDescriptor = () => {
  let reads = 0
  return { get name() { return `algebra-${reads++}` },
    description: 'Algebra instructions', provider: 'fixture', source: 'fixture',
    invocation: { modelInvocable: true, userInvocable: true } }
}

test('a capability the supply cannot describe still states the namespace that owns it', async t => {
  const session = Session.create('undescribed-capability')
  const agent = { id: 'undescribed-capability', session, signal: new AbortController().signal }
  const env = createCapabilityEnvironment({
    ctx: { agents: { list: () => [agent] },
      get: name => name === 'skills' ? { snapshot: async () => ({ complete: true, skills: [undescribedDescriptor()] }) } : undefined,
      systemPrompt: { assemble: async () => ({ sections: [] }) } },
    config, toolSchemasForAgent: () => [toolSchema('skill')],
    sessionHistoryForAgent: async () => ({ events: [], header: session.header }) })
  t.after(() => env.dispose())
  const catalog = await env.describeSessionCatalog({ sessionId: session.id }, agent.signal)
  const row = catalog.rows.find(item => item.category === 'skill')
  // The Skill namespace is what the row can state without a display entry: a category is not a
  // source, so the fallback names the layer the capability belongs to.
  assert.deepEqual(row.source, { kind: 'skill' })
  assert.match(row.id, /^skills\.algebra-/u)
})
