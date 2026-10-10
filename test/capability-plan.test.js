import { CAPABILITY_POLICY_DEFAULT, capabilityRule, validateCapabilityPolicy, changeCapabilityRule } from '../internal/capability-policy.js'
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

test('policy format retains independent template and task rules while joint MCP entries use resource rules', () => {
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.categories = {
    resource: { availability: 'enabled', disclosure: 'full' },
    'resource-template': { availability: 'enabled', disclosure: 'on-demand' },
    task: { availability: 'closed', disclosure: 'full' },
  }
  const saved = validateCapabilityPolicy(JSON.parse(JSON.stringify(policy)))
  assert.deepEqual(saved.categories, policy.categories)
  const plan = createCapabilityPlan(input({ policy: saved, capabilities: [
    capability('mcp.docs', 'List resources, list templates and read a URI.', { category: 'resource' }),
    capability('standalone-template', 'Independent template contract', { category: 'resource-template' }),
    capability('standalone-task', 'Independent task contract', { category: 'task' }),
  ] }))
  assert.deepEqual(plan.entries.map(({ id, selection }) => [id, selection]), [
    ['mcp.docs', 'full'], ['standalone-task', 'closed'], ['standalone-template', 'on-demand'],
  ])
})

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
  assert.equal(plan.directoryText, 'Find')
  assert.deepEqual(plan.directoryCategories, [])
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

test('statistical membership changes retain navigation and explicit full contracts as a shared prefix', () => {
  const capabilities = [capability('a'), capability('b'), capability('pinned', 'Pinned contract', {
    dependencies: [{ id: 'Shared', text: 'Shared type' }],
  })]
  const options = input({ capabilities, manual: { baseline: [], overrides: { pinned: 'full' } }, statistics: settings })
  const make = (a, b) => createCapabilityPlan({ ...options, coverage: {
    a: { revision: 'r1', workspace: observed(a, 3) }, b: { revision: 'r1', workspace: observed(b, 3) },
  } })
  const one = make(3, 0)
  const two = make(0, 3)
  assert.equal(one.directoryText, two.directoryText)
  assert.deepEqual(one.directoryCategories, ['tool'])
  const pinned = '### dependency:Shared\nShared type\n\n### pinned\nPinned contract'
  assert.equal(one.catalogText, pinned + '\n\n### a\nComplete owner contract')
  assert.equal(two.catalogText, pinned + '\n\n### b\nComplete owner contract')
  const moreEvidence = make(2, 0)
  assert.equal(one.catalogText, moreEvidence.catalogText)
  assert.equal(one.directoryText, moreEvidence.directoryText)
})

test('manual baseline precedes statistical additions with exact shared dependency cost', () => {
  const dependency = { id: 'Shared', text: '共享类型' }
  const capabilities = ['a-statistical', 'z-baseline', 'pinned'].map(id => capability(id, id, { dependencies: [dependency] }))
  const options = input({ capabilities, manual: { baseline: ['z-baseline'], overrides: { pinned: 'full' } },
    statistics: settings, coverage: { 'a-statistical': { revision: 'r1', workspace: observed(3, 3) } } })
  const plan = createCapabilityPlan(options)
  assert.equal(plan.catalogText, '### dependency:Shared\n共享类型\n\n### pinned\npinned\n\n### z-baseline\nz-baseline\n\n### a-statistical\na-statistical')
  const exact = createCapabilityPlan({ ...options, budgetBytes: Buffer.byteLength(plan.catalogText) })
  assert.equal(exact.catalogText, plan.catalogText)
  assert.equal(exact.budgets.overageBytes, 0)
  assert.equal(exact.catalogText.match(/dependency:Shared/g).length, 1)
})

test('changed coverage rankings do not reorder unchanged automatic contracts', () => {
  const options = input({ capabilities: ['a', 'b'].map(id => capability(id)),
    manual: { baseline: [] }, statistics: settings })
  const make = (a, b) => createCapabilityPlan({ ...options, coverage: {
    a: { revision: 'r1', workspace: observed(a, 3) }, b: { revision: 'r1', workspace: observed(b, 3) },
  } })
  assert.equal(make(2, 3).catalogText, make(3, 2).catalogText)
})

test('on-demand directory uses category guidance without copying long imperative descriptions', () => {
  const description = 'MUST USE this complete description for unrelated work. '.repeat(100)
  const plan = createCapabilityPlan(input({ capabilities: [capability('skills.long', description, {
    category: 'skill', navigation: description,
  }), capability('tools.long', description, { navigation: description }),
  capability('closed-resource', description, { category: 'resource' })],
  manual: { baseline: [], overrides: { 'closed-resource': 'closed' } }, directoryBudgetBytes: 512 }))
  assert.equal(plan.schema, 'ptc-capability-plan/v1')
  assert.deepEqual(plan.directoryCategories, ['tool', 'skill'])
  assert.doesNotMatch(plan.directoryText, /MUST USE|skills\.long|closed-resource/)
  assert.match(plan.directoryText, /Tools: search by task/)
  assert.match(plan.directoryText, /Skills: search by task/)
  assert.equal(plan.catalogText, '')
  assert.ok(Buffer.byteLength(plan.directoryText) <= 512)
})

function composed(extra = {}) {
  return input({ capabilities: [capability('tools.probe'), capability('tools.other')],
    manual: { baseline: [] }, policy: JSON.parse(CAPABILITY_POLICY_DEFAULT), ...extra })
}

test('composed availability-only rules retain host explanations and independent disclosure preferences', () => {
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.items['tools.probe'] = { availability: 'closed', disclosure: 'full' }
  const closed = createCapabilityPlan(composed({ policy }))
  assert.equal(closed.schema, 'ptc-capability-plan/v2')
  assert.equal(closed.entries.find(entry => entry.id === 'tools.other').selection, 'host')
  assert.equal(closed.entries.find(entry => entry.id === 'tools.probe').selection, 'closed')
  assert.equal(closed.entries.find(entry => entry.id === 'tools.probe').disclosure, 'full')
  assert.equal(closed.directoryText, '')
  policy.items['tools.probe'].availability = 'enabled'
  const reopened = createCapabilityPlan(composed({ policy, budgetBytes: 1 }))
  assert.equal(reopened.entries.find(entry => entry.id === 'tools.probe').selection, 'full')
  assert.ok(reopened.catalogText.includes('Complete owner contract'))
  assert.ok(reopened.budgets.overageBytes > 0)
})

for (const enabled of [false, true]) test(`composed actual invocation unavailability is preserved with management ${enabled}`, () => {
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.items['tools.probe'] = { availability: 'closed' }
  const capabilities = [capability('tools.probe'), capability('skills.missing', 'No invocation path', { category: 'skill', effectiveAvailability: 'closed' }),
    capability('skills.user', 'User invocation retained', { category: 'skill', effectiveAvailability: 'enabled' })]
  const plan = createCapabilityPlan(composed({ enabled, policy, capabilities }))
  const missing = plan.entries.find(entry => entry.id === 'skills.missing')
  assert.equal(missing.availability, 'closed')
  assert.equal(missing.availabilitySource, 'invocation-path')
  assert.equal(missing.selection, 'closed')
  assert.equal(plan.entries.find(entry => entry.id === 'skills.user').selection, 'host')
  assert.equal(plan.entries.find(entry => entry.id === 'tools.probe').selection, enabled ? 'closed' : 'host')
  assert.equal(createCapabilityPlan(composed({ enabled: false, policy: undefined, capabilities })).entries.find(entry => entry.id === 'skills.missing').selection, 'host', 'Historical planners retain their recorded semantics.')
})

test('composed default category source and item rules resolve each dimension and enclosing closure preserves children', () => {
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.categories.tool = { disclosure: 'on-demand' }
  policy.mcpServers.docs = { disclosure: 'full', availability: 'closed' }
  policy.items['tools.probe'] = { availability: 'enabled', disclosure: 'host' }
  const member = capability('tools.probe', 'contract', { mcpServer: 'docs' })
  assert.deepEqual(capabilityRule(policy, member), { availability: 'closed', disclosure: 'host',
    availabilitySource: 'mcp:docs', disclosureSource: 'item:tools.probe' })
  policy.mcpServers.docs.availability = 'enabled'
  assert.equal(createCapabilityPlan(composed({ capabilities: [member], policy })).entries[0].selection, 'host')
  assert.throws(() => validateCapabilityPolicy({ ...policy, allocation: { ...policy.allocation, unknown: true } }), /invalid capability policy/)
  policy.mcpServers.docs.availability = 'closed'
  assert.throws(() => createCapabilityPlan(composed({ policy, capabilities: [capability('tools.ambiguous', 'contract',
    { mcpServerCandidates: ['docs', 'docs__nested'] })] })), /cannot determine the MCP server owner/)
})

test('composed allocation selects its basis and budget independently without changing explicit contracts or availability', () => {
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.defaults.disclosure = 'adaptive'
  const options = composed({ policy, statistics: settings, manual: { baseline: ['tools.probe'] }, budgetBytes: 1,
    coverage: { 'tools.other': { revision: 'r1', workspace: observed(3, 3) } } })
  const budgeted = createCapabilityPlan(options)
  assert.deepEqual(budgeted.entries.map(entry => entry.selection), ['on-demand', 'on-demand'])
  policy.allocation.budget = false
  assert.deepEqual(createCapabilityPlan(options).entries.map(entry => entry.selection), ['on-demand', 'full'])
  policy.allocation.statistics = true
  policy.allocation.baseline = false
  assert.deepEqual(createCapabilityPlan(options).entries.map(entry => entry.selection), ['full', 'on-demand'])
  policy.items['tools.probe'] = { disclosure: 'full' }
  policy.allocation.budget = true
  const pinned = createCapabilityPlan(options)
  assert.equal(pinned.entries.find(entry => entry.id === 'tools.probe').selection, 'full')
  assert.ok(pinned.entries.every(entry => entry.availability === 'enabled'))
})


test('capability rules retain a proven MCP server literally named __proto__ without changing prototypes', async () => {
  const { changeCapabilityRule, capabilityPolicyForConfig } = await import('../internal/capability-policy.js')
  const policy = changeCapabilityRule(JSON.parse(CAPABILITY_POLICY_DEFAULT), 'mcpServers.__proto__', 'availability', 'closed')
  assert.equal(Object.getPrototypeOf(policy.mcpServers), Object.prototype)
  assert.equal(Object.hasOwn(policy.mcpServers, '__proto__'), true)
  assert.equal(capabilityRule(policy, capability('tools.probe', 'contract', { mcpServer: '__proto__' })).availability, 'closed')
  const migrated = capabilityPolicyForConfig({ capabilityOverrides: '{"mcpServers.__proto__":"closed"}' })
  assert.equal(capabilityRule(migrated, capability('tools.probe', 'contract', { mcpServer: '__proto__' })).availability, 'closed')
})


test('composed unresolved preferences remain diagnostic inputs and cannot manage out-of-domain capabilities', () => {
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.items = { 'removed-tool': { disclosure: 'full' }, 'repl.inspect': { availability: 'closed' } }
  const plan = createCapabilityPlan(composed({ policy, capabilities: [capability('tools.probe'), capability('repl.inspect', 'native REPL', { category: 'repl' })] }))
  assert.equal(plan.entries.length, 1)
  assert.deepEqual(plan.excluded.map(entry => entry.id), ['repl.inspect'])
  assert.deepEqual(plan.unresolvedConfigurationIds, ['removed-tool'])
})
