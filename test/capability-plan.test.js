import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { createCapabilityPlan } from '../internal/capability-plan.js'

function capability(id, contract = 'Complete owner contract', extra = {}) {
  return { id, revision: 'r1', category: 'tool', contract, ...extra }
}
function input(extra = {}) {
  return {
    enabled: true, configurationRevision: 'config1', capabilities: [capability('files/read')],
    budgetBytes: 1000, directoryBudgetBytes: 1000, navigationText: 'Search the owner catalog for complete contracts.',
    manual: { baseline: ['files/read'], overrides: {} }, ...extra,
  }
}
const settings = { enabled: true, windowSize: 20, minimumSamples: 3, fullThreshold: 0.5 }
function observed(used, eligible) { return { status: 'usable', windowSize: 20, used, eligible } }

test('explicit disclosure and closure override coverage independently of statistics', () => {
  const plan = createCapabilityPlan(input({
    capabilities: ['full', 'demand', 'closed', 'automatic'].map(id => capability(id)),
    manual: { baseline: [], overrides: { full: 'full', demand: 'on-demand', closed: 'closed' } },
    statistics: settings,
    coverage: Object.fromEntries(['full', 'demand', 'closed', 'automatic'].map(id => [id, { revision: 'r1', workspace: observed(3, 3) }])),
  }))
  assert.deepEqual(plan.entries.map(({ id, selection }) => [id, selection]), [
    ['automatic', 'full'], ['closed', 'closed'], ['demand', 'on-demand'], ['full', 'full'],
  ])
  assert.doesNotMatch(plan.catalogText, /### closed/)
  assert.doesNotMatch(plan.directoryText, /closed/)
  assert.equal(plan.entries[0].evidence.scope, 'workspace')
})

test('disabled invalid missing and collapsed statistics preserve editable baseline and manual choices', () => {
  for (const statistics of [undefined, { enabled: false }, { ...settings, windowSize: 0 }, settings]) {
    const plan = createCapabilityPlan(input({
      statistics, coverage: { 'files/read': { revision: 'r1', workspace: { status: 'capacity-exceeded', eligible: null, used: null } } },
    }))
    assert.equal(plan.entries[0].selection, 'full')
    assert.equal(plan.entries[0].reason, 'baseline')
  }
  const plan = createCapabilityPlan(input({ manual: { baseline: [], overrides: {} }, statistics: { enabled: false } }))
  assert.equal(plan.entries[0].selection, 'on-demand')
})

test('workspace evidence is primary and sufficient global evidence provides only cold-start reference', () => {
  const local = createCapabilityPlan(input({ statistics: settings, coverage: {
    'files/read': { revision: 'r1', workspace: observed(0, 3), global: observed(20, 20) },
  } }))
  assert.equal(local.entries[0].selection, 'on-demand')
  assert.equal(local.entries[0].evidence.scope, 'workspace')
  const cold = createCapabilityPlan(input({ statistics: settings, coverage: {
    'files/read': { revision: 'r1', workspace: observed(0, 2), global: observed(10, 20) },
  } }))
  assert.equal(cold.entries[0].selection, 'full')
  assert.deepEqual(cold.entries[0].evidence, { scope: 'global', used: 10, eligible: 20, coverage: 0.5 })
  const incompatible = createCapabilityPlan(input({ statistics: settings, coverage: {
    'files/read': { revision: 'incompatible', workspace: observed(0, 20) },
  } }))
  assert.equal(incompatible.entries[0].reason, 'baseline')
})

test('complete UTF-8 contracts and shared types are counted after actual de-duplication', () => {
  const capabilities = ['b', 'a'].map(id => capability(id, '读取完整值', { dependencies: [{ id: 'Shared', text: '共享完整类型' }] }))
  const unlimited = createCapabilityPlan(input({ capabilities, manual: { baseline: ['a', 'b'] } }))
  const exact = createCapabilityPlan(input({ capabilities, manual: { baseline: ['a', 'b'] }, budgetBytes: Buffer.byteLength(unlimited.catalogText, 'utf8') }))
  assert.deepEqual(exact.entries.map(item => item.selection), ['full', 'full'])
  assert.equal(exact.budgets.contractBytes, Buffer.byteLength(exact.catalogText, 'utf8'))
  assert.equal(exact.catalogText.match(/dependency:Shared/g).length, 1)
  assert.equal(exact.budgets.unit, 'utf8-bytes')
})

test('explicit full overage remains complete while automatic long contracts remain on demand', () => {
  const plan = createCapabilityPlan(input({ capabilities: [capability('fixed', 'x'.repeat(100)), capability('long', 'z'.repeat(100))],
    budgetBytes: 10, manual: { baseline: ['long'], overrides: { fixed: 'full' } } }))
  assert.equal(plan.entries[0].selection, 'full')
  assert.equal(plan.entries[1].selection, 'on-demand')
  assert.equal(plan.entries[1].reason, 'contract-budget')
  assert.ok(plan.catalogText.endsWith('x'.repeat(100)))
  assert.equal(plan.budgets.overageBytes, plan.budgets.contractBytes - 10)
})

test('bounded directory retains the search entrance without requiring every long-tail name', () => {
  const plan = createCapabilityPlan(input({ capabilities: ['a', 'b', 'c'].map(id => capability(id)), manual: { baseline: [] },
    navigationText: 'Find', directoryBudgetBytes: 6 }))
  assert.equal(plan.directoryText, 'Find\na')
  assert.deepEqual(plan.directoryIncluded, ['a'])
  assert.deepEqual(plan.entries.map(item => item.selection), ['on-demand', 'on-demand', 'on-demand'])
  assert.throws(() => createCapabilityPlan(input({ directoryBudgetBytes: 1 })), /discovery guidance exceeds/)
})

test('management off preserves host provision and ignores saved manual closure', () => {
  const plan = createCapabilityPlan(input({ enabled: false, budgetBytes: undefined,
    manual: { overrides: { 'files/read': 'closed' } }, statistics: { enabled: true } }))
  assert.equal(plan.entries[0].selection, 'host')
  assert.equal(plan.catalogText, '')
  assert.equal(plan.directoryText, '')
})

test('language Node REPL public plugin APIs and global bindings are excluded from management', () => {
  const excluded = ['language', 'node', 'repl', 'ptc-plus', 'global-binding'].map(category => ({ id: category, revision: 'r1', category }))
  const plan = createCapabilityPlan(input({ capabilities: [...excluded, capability('task-tool')],
    manual: { baseline: [], overrides: Object.fromEntries(excluded.map(item => [item.id, 'closed'])) } }))
  assert.deepEqual(plan.entries.map(item => item.id), ['task-tool'])
  assert.equal(plan.excluded.length, 5)
})

test('identical inputs produce a frozen byte-stable read model regardless of input ordering', () => {
  const capabilities = [capability('b'), capability('a')]
  const options = input({ capabilities, manual: { baseline: ['a', 'b'] } })
  const one = createCapabilityPlan(options)
  const two = createCapabilityPlan({ ...options, capabilities: [...capabilities].reverse() })
  assert.deepEqual(one, two)
  options.capabilities[0].contract = 'changed owner contract'
  assert.equal(one.catalogText, two.catalogText)
  assert.throws(() => { one.entries[0].selection = 'closed' }, TypeError)
})

test('malformed manual configuration and ambiguous owner identities fail before allocation', () => {
  assert.throws(() => createCapabilityPlan(input({ manual: { overrides: { a: 'automatic' } } })), /invalid capability selection/)
  assert.throws(() => createCapabilityPlan(input({ capabilities: [capability('a'), capability('a')] })), /duplicate capability identity/)
  assert.throws(() => createCapabilityPlan(input({ capabilities: [capability('a', 'a', { category: 'unknown' })] })), /unknown capability category/)
  assert.throws(() => createCapabilityPlan(input({ capabilities: [capability('a', 'a', { dependencies: [{ id: 'shared', text: 'A' }, { id: 'shared', text: 'B' }] })], manual: { baseline: ['a'] } })), /conflicting shared contract/)
})

test('coverage and complete rendered length rank candidates with stable identity tie breaks', () => {
  const plan = createCapabilityPlan(input({
    capabilities: [capability('long', 'x'.repeat(1000)), capability('b', 'short'), capability('a', 'short')],
    manual: { baseline: [] }, budgetBytes: 15,
    statistics: settings,
    coverage: Object.fromEntries(['long', 'a', 'b'].map(id => [id, { revision: 'r1', workspace: observed(3, 3) }])),
  }))
  assert.deepEqual(plan.entries.map(({ id, selection }) => [id, selection]), [['a', 'full'], ['b', 'on-demand'], ['long', 'on-demand']])
  assert.equal(plan.catalogText, '### a\nshort')
})

test('unknown configured capabilities remain visible configuration issues without fabricated availability', () => {
  const plan = createCapabilityPlan(input({ manual: { baseline: ['not-installed'], overrides: { missing: 'full' } } }))
  assert.deepEqual(plan.unresolvedConfigurationIds, ['missing', 'not-installed'])
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].selection, 'on-demand')
})

test('corrupt statistics container and member samples preserve manual choices and baseline without zero evidence', () => {
  const malformedSamples = [null, [], 'damaged', 7, { status: 'usable', windowSize: 20, eligible: 4, used: 9 }]
  const malformedCoverage = [null, [], 'damaged', 7,
    ...malformedSamples.map(sample => ({ baseline: { revision: 'r1', workspace: sample, global: sample } })),
    { baseline: [] }, { baseline: 'damaged' },
  ]
  for (const coverage of malformedCoverage) {
    const plan = createCapabilityPlan(input({
      capabilities: ['baseline', 'fixed', 'demand', 'closed', 'unselected'].map(id => capability(id)),
      manual: { baseline: ['baseline'], overrides: { fixed: 'full', demand: 'on-demand', closed: 'closed' } },
      statistics: settings, coverage,
    }))
    assert.deepEqual(plan.entries.map(({ id, selection }) => [id, selection]), [
      ['baseline', 'full'], ['closed', 'closed'], ['demand', 'on-demand'], ['fixed', 'full'], ['unselected', 'on-demand'],
    ])
    assert.equal(plan.entries.find(item => item.id === 'baseline').reason, 'baseline')
    assert.ok(plan.entries.every(item => !Object.hasOwn(item, 'evidence')))
  }
})

test('disabled statistics and disabled management never read unusable statistical data', () => {
  for (const statistics of [{ enabled: false }, { ...settings, windowSize: 0 }]) {
    const options = input({ statistics })
    Object.defineProperty(options, 'coverage', { get() { throw new Error('disabled statistics were read') } })
    const plan = createCapabilityPlan(options)
    assert.equal(plan.entries[0].selection, 'full')
    assert.equal(plan.entries[0].reason, 'baseline')
  }
  const options = input({ enabled: false, manual: { overrides: { 'files/read': 'closed' } } })
  Object.defineProperty(options, 'statistics', { get() { throw new Error('disabled management read statistics') } })
  Object.defineProperty(options, 'coverage', { get() { throw new Error('disabled management read coverage') } })
  assert.equal(createCapabilityPlan(options).entries[0].selection, 'host')
})
