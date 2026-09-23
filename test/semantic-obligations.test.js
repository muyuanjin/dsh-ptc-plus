import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readSemanticObligations,
  semanticObligationReport,
  validateSemanticObligations,
} from '../scripts/semantic-obligations.mjs'

test('semantic obligation graph closes the tracked implementation and evidence', async () => {
  const report = await semanticObligationReport()
  assert.deepEqual(report, {
    schema: 'dsh-semantic-obligations/v1',
    sources: 158,
    obligations: 6,
    dispositions: {
      preserved: 2,
      'intentional-difference': 3,
      'bounded-external': 1,
    },
    unknown: 0,
    journalGenerations: '1..10',
  })
})

test('semantic obligation graph fails closed for unowned source, stale evidence and dependencies', async () => {
  const graph = await readSemanticObligations()
  const sources = graph.obligations.flatMap(obligation => obligation.implementation)
  await assert.rejects(
    validateSemanticObligations(graph, { sources: [...sources, 'internal/unregistered-transform.js'] }),
    /semantic source inventory differs/u,
  )

  const stale = structuredClone(graph)
  stale.obligations[0].evidence[0] = 'test/missing-semantic-evidence.test.js'
  await assert.rejects(validateSemanticObligations(stale), /references missing evidence/u)

  const dependency = structuredClone(graph)
  dependency.obligations[0].dependsOn.push('missing-owner')
  await assert.rejects(validateSemanticObligations(dependency), /depends on unknown semantic obligation/u)
})
