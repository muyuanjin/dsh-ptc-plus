import assert from 'node:assert/strict'
import test from 'node:test'
import { createCapabilityEnvironment } from '../../internal/capability-environment.js'

/**
 * A session log this build cannot read.
 *
 * The capability record is read on every projection, and a projection is assembled for the
 * model-visible request surface. A log whose record cannot be read states no decision, so the
 * read must not fail the assembly: a torn record may not take a step down with it.
 */
const config = { capabilityManagementEnabled: true, capabilityBaseline: '[]', capabilityOverrides: '{}',
  capabilityStatistics: '{"enabled":false,"windowSize":10,"minimumSamples":1,"fullThreshold":0.5}',
  capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096, capabilityRecoveryBytes: 4096, modelPreviewTokens: 128 }

// An event whose own read throws models a committed record the reader can no longer observe;
// no fixture session can hold one, which is why this path lives in the coverage-only suite.
const tornRecord = () => ({ seq: 1, get type() { throw new TypeError('the committed record is unreadable') } })

test('a projection survives a session log whose record cannot be read', async t => {
  const env = createCapabilityEnvironment({ ctx: {}, config, toolSchemasForAgent: () => [] })
  t.after(() => env.dispose())
  const agent = { id: 'torn-record-agent', session: { id: 'torn-record-session', events: [tornRecord()] } }
  const sections = [{ name: 'tools:sdk', text: 'native sdk' }, { name: 'tool:probe', text: 'Probe guidance.' }]
  // The record states no decision this build can read, so nothing is withdrawn: the Host's
  // own sections and members come back exactly as they were declared.
  assert.deepEqual(env.projectSections(agent, sections), sections)
  assert.deepEqual(env.projectMembers(agent, ['probe', 'other']), ['probe', 'other'])
})
