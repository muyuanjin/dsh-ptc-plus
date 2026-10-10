import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityCoverage, createCapabilityStatistics, reduceCapabilityStatistics, validateCapabilityStatistics } from '../internal/capability-statistics.js'
import { createCapabilityPlan } from '../internal/capability-plan.js'

function state(extra = {}) {
  return createCapabilityStatistics({ windowSize: 3, maxFamilies: 20, maxScopes: 100, maxCapabilitiesPerFamily: 20, ...extra })
}
function available(extra = {}) {
  return { workspaceId: 'workspace', id: 'owner/read', revision: 'r1', category: 'tool', disclosure: 'on-demand', planRevision: 'plan1', ...extra }
}
function event(familyId, eligibleOrder, observations = [available()], extra = {}) {
  return { type: 'family-observation', userId: 'user', familyId, observationRevision: 1, settlement: 'settled', eligibleOrder, observations, ...extra }
}
function coverage(statistics, extra = {}) {
  return capabilityCoverage(statistics, { userId: 'user', workspaceId: 'workspace', id: 'owner/read', revision: 'r1', ...extra })
}

test('a real family and all descendants contribute once despite repeated owner dispatch evidence', () => {
  let statistics = reduceCapabilityStatistics(state(), event('family', 1, [available({ useEvidence: 'host-execution-result' })]))
  for (let revision = 2; revision <= 100; revision++) statistics = reduceCapabilityStatistics(statistics,
    event('family', 1, [available({ useEvidence: 'host-execution-result' })], { observationRevision: revision }))
  assert.deepEqual(coverage(statistics), { status: 'usable', windowSize: 3, eligible: 1, used: 1, coverage: 1 })
  assert.equal(statistics.families.length, 1)
  assert.equal(statistics.families[0].observations[0].exposures.length, 1)
})

test('availability denominator excludes families without the capability and preserves no-sample meaning', () => {
  let statistics = state()
  assert.equal(coverage(statistics).coverage, null)
  statistics = reduceCapabilityStatistics(statistics, event('used', 1, [available({ useEvidence: 'host-execution-result' })]))
  statistics = reduceCapabilityStatistics(statistics, event('unused', 2))
  statistics = reduceCapabilityStatistics(statistics, event('absent', 3, [available({ id: 'other/capability' })]))
  assert.equal(coverage(statistics).eligible, 2)
  assert.equal(coverage(statistics).coverage, 0.5)
  assert.throws(() => reduceCapabilityStatistics(statistics, event('closed', 4, [available({ disclosure: 'closed' })])), /availability disclosure/)
})

test('each capability uses its own recent eligible window with no clock decay or write-time reordering', () => {
  let statistics = state({ windowSize: 2 })
  statistics = reduceCapabilityStatistics(statistics, event('one', 1, [available({ useEvidence: 'host-execution-result' }), available({ id: 'rare' })]))
  statistics = reduceCapabilityStatistics(statistics, event('two', 2))
  statistics = reduceCapabilityStatistics(statistics, event('three', 3))
  assert.equal(coverage(statistics).eligible, 2)
  assert.equal(coverage(statistics).used, 0)
  assert.equal(coverage(statistics, { id: 'rare' }).eligible, 1)
  statistics = reduceCapabilityStatistics(statistics, event('one', 1, [available({ useEvidence: 'host-execution-result' })], { observationRevision: 2 }))
  assert.equal(coverage(statistics).used, 0)
  assert.equal(coverage(statistics, { id: 'rare' }).eligible, 1)
  assert.equal(statistics.windows.find(item => item.id === 'owner/read' && item.workspaceId === 'workspace').floor, 1)
})

test('active unknown and resumed families cannot manufacture negative samples', () => {
  let statistics = reduceCapabilityStatistics(state(), event('family', null, [available()], { settlement: 'active' }))
  assert.equal(coverage(statistics).eligible, 0)
  statistics = reduceCapabilityStatistics(statistics, event('family', null, [], { settlement: 'unknown', observationRevision: 2 }))
  assert.equal(coverage(statistics).coverage, null)
  statistics = reduceCapabilityStatistics(statistics, event('family', 1, [], { observationRevision: 3 }))
  assert.equal(coverage(statistics).eligible, 1)
  statistics = reduceCapabilityStatistics(statistics, event('family', 1, [], { settlement: 'active', observationRevision: 4 }))
  assert.equal(coverage(statistics).eligible, 0)
  statistics = reduceCapabilityStatistics(statistics, event('family', 1, [available({ useEvidence: 'host-execution-result' })], { observationRevision: 5 }))
  assert.equal(coverage(statistics).eligible, 1)
  assert.equal(coverage(statistics).used, 1)
})

test('workspace identity follows supplied exposure evidence while user-global family use stays deduplicated', () => {
  const statistics = reduceCapabilityStatistics(state(), event('family', 1, [available(), available({ workspaceId: 'other-workspace', useEvidence: 'host-execution-result' })]))
  assert.equal(coverage(statistics).used, 0)
  assert.equal(coverage(statistics, { workspaceId: 'other-workspace' }).used, 1)
  assert.equal(coverage(statistics, { workspaceId: null }).eligible, 1)
  assert.equal(coverage(statistics, { workspaceId: null }).used, 1)
  assert.equal(coverage(statistics, { userId: 'other-user', workspaceId: null }).eligible, 0)
})

test('resuming after window eviction withdraws incomplete coverage until settlement restores the window', () => {
  let statistics = state({ windowSize: 2 })
  statistics = reduceCapabilityStatistics(statistics, event('one', 1, [available({ useEvidence: 'host-execution-result' })]))
  statistics = reduceCapabilityStatistics(statistics, event('two', 2))
  statistics = reduceCapabilityStatistics(statistics, event('three', 3))
  assert.equal(coverage(statistics).coverage, 0)
  statistics = reduceCapabilityStatistics(statistics, event('three', 3, [], { settlement: 'active', observationRevision: 2 }))
  const missing = { status: 'incomplete-window', windowSize: 2, eligible: null, used: null, coverage: null }
  assert.deepEqual(coverage(statistics), missing)
  assert.deepEqual(coverage(statistics, { workspaceId: null }), missing)
  const plan = () => createCapabilityPlan({
    enabled: true, configurationRevision: 'config1',
    capabilities: [{ id: 'owner/read', revision: 'r1', category: 'tool', contract: 'Read file.' }],
    manual: { baseline: ['owner/read'], overrides: {} },
    statistics: { enabled: true, windowSize: 2, minimumSamples: 1, fullThreshold: 0.5 },
    coverage: { 'owner/read': { revision: 'r1', workspace: coverage(statistics), global: coverage(statistics, { workspaceId: null }) } },
    budgetBytes: 1000, directoryBudgetBytes: 1000, navigationText: 'Search contracts.',
  })
  assert.equal(plan().entries[0].selection, 'full')
  assert.equal(plan().entries[0].reason, 'baseline')
  assert.equal(reduceCapabilityStatistics(statistics, event('three', 3)), statistics)
  statistics = reduceCapabilityStatistics(statistics, event('one', 1, [available({ useEvidence: 'host-execution-result' })], { observationRevision: 2 }))
  assert.deepEqual(coverage(statistics), missing)
  statistics = reduceCapabilityStatistics(statistics, event('three', 3, [], { observationRevision: 3 }))
  assert.deepEqual(coverage(statistics), { status: 'usable', windowSize: 2, eligible: 2, used: 0, coverage: 0 })
  assert.equal(plan().entries[0].selection, 'on-demand')
  assert.equal(reduceCapabilityStatistics(statistics, event('three', 3, [], { settlement: 'active', observationRevision: 2 })), statistics)
})

test('Skill and resource use requires category-specific accepted owner evidence', () => {
  let statistics = state()
  statistics = reduceCapabilityStatistics(statistics, event('family', 1, [available({ id: 'skill', category: 'skill', useEvidence: 'skill-body-accepted' }),
    available({ id: 'resource', category: 'resource', useEvidence: 'resource-access' })]))
  assert.equal(coverage(statistics, { id: 'skill' }).used, 1)
  assert.equal(coverage(statistics, { id: 'resource' }).used, 1)
  for (const useEvidence of ['description-inspection', 'cold-replay', 'validation-rejected', 'host-execution-result']) {
    assert.throws(() => reduceCapabilityStatistics(statistics, event('other', 2, [available({ category: 'skill', useEvidence })])), /owner use evidence/)
  }
})

test('incompatible revisions and same-named different owners never share denominators', () => {
  const statistics = reduceCapabilityStatistics(state(), event('family', 1, [available({ useEvidence: 'host-execution-result' }), available({ revision: 'r2' }), available({ id: 'other-owner/read' })]))
  assert.equal(coverage(statistics).coverage, 1)
  assert.equal(coverage(statistics, { revision: 'r2' }).coverage, 0)
  assert.equal(coverage(statistics, { id: 'other-owner/read' }).coverage, 0)
})

test('duplicate and stale observations are idempotent while qualification order cannot change on resume', () => {
  const original = event('family', 1)
  const statistics = reduceCapabilityStatistics(state(), original)
  assert.equal(reduceCapabilityStatistics(statistics, original), statistics)
  assert.equal(reduceCapabilityStatistics(statistics, { ...original, observationRevision: 0 }), statistics)
  assert.throws(() => reduceCapabilityStatistics(statistics, { ...original, eligibleOrder: 2, observationRevision: 2 }), /changed qualification order/)
  assert.throws(() => reduceCapabilityStatistics(statistics, event('another', 1)), /qualification order collision/)
  assert.throws(() => { statistics.families[0].eligibleOrder = 2 }, TypeError)
})

test('retained windows stay bounded and an evicted family cannot return to the window front', () => {
  let statistics = state({ maxFamilies: 3 })
  for (let index = 1; index <= 30; index++) statistics = reduceCapabilityStatistics(statistics, event(`family${index}`, index))
  assert.equal(statistics.status, 'usable')
  assert.equal(statistics.families.length, 3)
  statistics = reduceCapabilityStatistics(statistics, event('family1', 1, [available({ useEvidence: 'host-execution-result' })], { observationRevision: 2 }))
  assert.equal(coverage(statistics).used, 0)
  assert.equal(statistics.families.length, 3)
})

test('capacity collapse and corrupt retained state never become zero-usage allocation evidence', () => {
  const original = reduceCapabilityStatistics(state({ maxFamilies: 1 }), event('active1', null, [available()], { settlement: 'active' }))
  const collapsed = reduceCapabilityStatistics(original, event('active2', null, [available()], { settlement: 'active' }))
  assert.equal(collapsed.status, 'capacity-exceeded')
  assert.equal(coverage(collapsed).eligible, null)
  assert.equal(coverage(collapsed).used, null)
  assert.equal(collapsed.families.length, 1)
  assert.equal(original.status, 'usable')
  const corrupted = structuredClone(original)
  corrupted.families[0].observations[0].used = 'false'
  assert.throws(() => validateCapabilityStatistics(corrupted), /retained evidence/)
  assert.throws(() => createCapabilityStatistics({ windowSize: 0 }), /windowSize/)
})

test('failed and cancelled owner calls count use while retaining separate outcome evidence', () => {
  let statistics = reduceCapabilityStatistics(state(), event('family', 1, [available({ useEvidence: 'host-execution-result', outcome: 'failed' })]))
  statistics = reduceCapabilityStatistics(statistics, event('family', 1, [available({ useEvidence: 'host-execution-result', outcome: 'cancelled' })], { observationRevision: 2 }))
  assert.equal(coverage(statistics).used, 1)
  assert.deepEqual(statistics.families[0].observations[0].outcomes, ['failed', 'cancelled'])
  assert.equal(Object.hasOwn(statistics.families[0].observations[0], 'arguments'), false)
})

test('out-of-order qualification does not outrank later eligible families and scope overflow collapses', () => {
  let statistics = state({ windowSize: 2 })
  statistics = reduceCapabilityStatistics(statistics, event('latest', 10))
  statistics = reduceCapabilityStatistics(statistics, event('middle', 9))
  statistics = reduceCapabilityStatistics(statistics, event('old', 1, [available({ useEvidence: 'host-execution-result' })]))
  assert.equal(coverage(statistics).eligible, 2)
  assert.equal(coverage(statistics).used, 0)
  const collapsed = reduceCapabilityStatistics(state({ maxScopes: 1 }), event('family', 1))
  assert.equal(collapsed.status, 'capacity-exceeded')
  assert.equal(collapsed.windows.length, 0)
})


test('locked statistics storage merges concurrent family observations and preserves recovery identity', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Session, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
  const { CapabilityStatisticsStore } = await import('../internal/capability-statistics-store.js')
  const root = await mkdtemp(join(tmpdir(), 'ptc-statistics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const makeAgent = id => {
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
      createdAt: 0, cwd: root, isSeeded: false })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return { session, status: 'idle' }
  }
  const agents = [makeAgent('family-one'), makeAgent('family-two')]
  const ctx = { agents: { list: () => agents }, sessions: { list: () => agents.map(item => item.session) } }
  const filename = join(root, 'statistics.json')
  const a = new CapabilityStatisticsStore({ filename, ctx })
  const b = new CapabilityStatisticsStore({ filename, ctx })
  const settings = { enabled: true, windowSize: 10 }
  const snapshot = { settings: { statistics: settings }, plan: { enabled: true,
    configurationRevision: 'manual-one', entries: [{ id: 'tools.probe', revision: 'one', category: 'tool', selection: 'on-demand' }] } }
  await Promise.all([a.available(agents[0], snapshot), b.available(agents[1], snapshot)])
  await Promise.all([a.used(agents[0], snapshot, 'tools.probe', 'host-execution-result', 'complete'),
    b.used(agents[1], snapshot, 'tools.probe', 'host-execution-result', 'failed')])
  await Promise.all(agents.map((agent, index) => (index ? b : a).status(agent, snapshot, 'idle')))
  const capabilities = [{ id: 'tools.probe', revision: 'one' }]
  let coverage = await a.coverage(agents[0], capabilities, settings)
  assert.equal(coverage['tools.probe'].workspace.eligible, 2)
  assert.equal(coverage['tools.probe'].workspace.used, 2)
  const restored = new CapabilityStatisticsStore({ filename, ctx })
  await restored.used(agents[0], snapshot, 'tools.probe', 'host-execution-result', 'complete')
  await restored.status(agents[0], snapshot, 'idle')
  coverage = await restored.coverage(agents[0], capabilities, settings)
  assert.equal(coverage['tools.probe'].workspace.eligible, 2)
  assert.equal(coverage['tools.probe'].workspace.used, 2)
  await writeFile(filename, '{')
  assert.equal(await restored.coverage(agents[0], capabilities, settings), null)
})

test('restored statistics stores retain family qualification and revisions after every sample window evicts it', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Session, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
  const { CapabilityStatisticsStore } = await import('../internal/capability-statistics-store.js')
  const root = await mkdtemp(join(tmpdir(), 'ptc-statistics-eviction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agents = [1, 2, 3].map(index => {
    const id = `family-${index}`
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: root, isSeeded: false })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return { session, status: 'idle' }
  })
  const ctx = { agents: { list: () => agents }, sessions: { list: () => agents.map(agent => agent.session) } }
  const filename = join(root, 'statistics.json')
  const store = new CapabilityStatisticsStore({ filename, ctx })
  const settings = { enabled: true, windowSize: 2 }
  const snapshot = { settings: { statistics: settings }, plan: { enabled: true, configurationRevision: 'plan',
    entries: [{ id: 'tools.probe', revision: 'one', category: 'tool', selection: 'on-demand' }] } }
  for (const agent of agents) {
    await store.available(agent, snapshot)
    await store.status(agent, snapshot, 'idle')
  }
  const before = JSON.parse(await readFile(filename, 'utf8'))
  assert.equal(before.state.families.some(family => family.familyId === 'family-1'), false)
  const first = before.families.find(family => family.id === 'family-1')
  const session = agents[0].session
  agents[0].session = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header)
  const restored = new CapabilityStatisticsStore({ filename, ctx })
  await Promise.all([store.used(agents[0], snapshot, 'tools.probe', 'host-execution-result', 'complete'),
    restored.used(agents[0], snapshot, 'tools.probe', 'host-execution-result', 'failed')])
  await restored.status(agents[0], snapshot, 'idle')
  const after = JSON.parse(await readFile(filename, 'utf8'))
  const resumed = after.families.find(family => family.id === 'family-1')
  assert.equal(resumed.eligibleOrder, first.eligibleOrder)
  assert.equal(resumed.observationRevision, first.observationRevision + 3)
  assert.equal(after.nextOrder, before.nextOrder)
  const coverage = (await restored.coverage(agents[0], [{ id: 'tools.probe', revision: 'one' }], settings))['tools.probe']
  for (const scope of ['workspace', 'global']) {
    assert.equal(coverage[scope].eligible, 2)
    assert.equal(coverage[scope].used, 0)
  }
  for (const corrupt of [
    value => { value.state.families[0].userId = 'another-user' },
    value => { value.families.find(item => item.id === value.state.families[0].familyId).observationRevision++ },
    value => { value.state.windows[0].userId = 'another-user' },
    value => { value.state.windows[0].floor = value.nextOrder },
  ]) {
    const damaged = structuredClone(after); corrupt(damaged)
    await writeFile(filename, JSON.stringify(damaged))
    assert.equal(await restored.coverage(agents[0], [{ id: 'tools.probe', revision: 'one' }], settings), null)
  }
  after.nextOrder = 1
  await writeFile(filename, JSON.stringify(after))
  assert.equal(await restored.coverage(agents[0], [{ id: 'tools.probe', revision: 'one' }], settings), null)
})


test('storage capacity exhaustion persists manual fallback for reconstructed and concurrent adapters', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Session, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
  const { CapabilityStatisticsStore } = await import('../internal/capability-statistics-store.js')
  const root = await mkdtemp(join(tmpdir(), 'ptc-statistics-capacity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const makeAgent = id => {
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: root, isSeeded: false })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return { session, status: 'idle' }
  }
  const original = makeAgent('original')
  const incoming = makeAgent('incoming')
  const agents = [original, incoming]
  const ctx = { agents: { list: () => agents }, sessions: { list: () => agents.map(agent => agent.session) } }
  const filename = join(root, 'statistics.json')
  const store = new CapabilityStatisticsStore({ filename, ctx })
  const settings = { enabled: true, windowSize: 2, minimumSamples: 1, fullThreshold: 0.5 }
  const snapshot = { settings: { statistics: settings }, plan: { enabled: true, configurationRevision: 'plan',
    entries: [{ id: 'tools.probe', revision: 'one', category: 'tool', selection: 'on-demand' }] } }
  await store.available(original, snapshot)
  await store.status(original, snapshot, 'idle')
  const initial = JSON.parse(await readFile(filename, 'utf8'))
  const capabilities = [{ id: 'tools.probe', revision: 'one', category: 'tool', contract: 'probe', navigation: 'probe' }]
  for (const boundary of ['families', 'members', 'revision', 'order', 'observations']) {
    const document = structuredClone(initial)
    if (boundary === 'families') for (let i = 1; i < 10000; i++) document.families.push({ id: `prior-${i}`, observationRevision: 0, eligibleOrder: null })
    if (boundary === 'members') for (let i = 1; i < 10000; i++) document.members.push({ id: `child-${i}`, familyId: 'original', status: 'settled' })
    if (boundary === 'revision') {
      document.families[0].observationRevision = Number.MAX_SAFE_INTEGER
      document.state.families[0].observationRevision = Number.MAX_SAFE_INTEGER
    }
    if (boundary === 'order') document.nextOrder = Number.MAX_SAFE_INTEGER
    await writeFile(filename, JSON.stringify(document))
    const second = new CapabilityStatisticsStore({ filename, ctx })
    const target = boundary === 'revision' ? original : incoming
    const observed = boundary === 'observations' ? { ...snapshot, plan: { ...snapshot.plan,
      entries: Array.from({ length: 2001 }, (_, i) => ({ id: `tools.probe${i}`, revision: 'one',
        category: 'tool', selection: 'on-demand' })) } } : snapshot
    await Promise.all([store.available(target, observed), second.available(target, observed)])
    const persisted = JSON.parse(await readFile(filename, 'utf8'))
    assert.equal(persisted.state.status, 'capacity-exceeded', boundary)
    assert.equal(persisted.families.length, document.families.length)
    const fresh = new CapabilityStatisticsStore({ filename, ctx })
    const coverage = await fresh.coverage(incoming, capabilities, settings)
    assert.equal(coverage['tools.probe'].workspace.status, 'capacity-exceeded')
    const plan = createCapabilityPlan({ enabled: true, configurationRevision: 'manual', capabilities,
      manual: { baseline: ['tools.probe'] }, statistics: settings, coverage, budgetBytes: 10000,
      directoryBudgetBytes: 1000, navigationText: 'Use capabilities.search({query}) to discover tools.' })
    assert.equal(plan.entries[0].selection, 'full')
    assert.equal(plan.entries[0].reason, 'baseline')
  }
})


test('composed collection records host availability without management and stopping collection preserves observations', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Session, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
  const { CapabilityStatisticsStore } = await import('../internal/capability-statistics-store.js')
  const root = await mkdtemp(join(tmpdir(), 'ptc-host-statistics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = Session.create('host-family', [], { version: SESSION_FORMAT_VERSION, id: 'host-family', createdAt: 0, cwd: root, isSeeded: false })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const agent = { session, status: 'idle' }
  const ctx = { agents: { list: () => [agent] }, sessions: { list: () => [session] } }
  const filename = join(root, 'statistics.json')
  const store = new CapabilityStatisticsStore({ filename, ctx })
  const settings = { enabled: true, windowSize: 10 }
  const snapshot = { settings: { policy: {}, statistics: settings }, plan: { enabled: false, configurationRevision: 'host-config',
    entries: [{ id: 'tools.probe', revision: 'one', category: 'tool', selection: 'host' }] } }
  await store.available(agent, snapshot)
  await store.used(agent, snapshot, 'tools.probe', 'host-execution-result', 'failed')
  await store.status(agent, snapshot, 'idle')
  const capabilities = [{ id: 'tools.probe', revision: 'one' }]
  const observed = await store.coverage(agent, capabilities, settings)
  assert.equal(observed['tools.probe'].workspace.eligible, 1)
  assert.equal(observed['tools.probe'].workspace.used, 1)
  const before = await readFile(filename, 'utf8')
  assert.equal(JSON.parse(before).state.families[0].observations[0].exposures[0].disclosure, 'host')
  const stopped = { ...snapshot, settings: { ...snapshot.settings, statistics: { ...settings, enabled: false } } }
  await store.available(agent, stopped); await store.used(agent, stopped, 'tools.probe', 'host-execution-result', 'complete')
  await store.status(agent, stopped, 'idle')
  assert.equal(await readFile(filename, 'utf8'), before)
  const paused = { ...snapshot, settings: { ...snapshot.settings, contextEnabled: false } }
  await store.available(agent, paused); await store.used(agent, paused, 'tools.probe', 'host-execution-result', 'complete')
  await store.status(agent, paused, 'idle')
  assert.equal(await readFile(filename, 'utf8'), before, 'Paused collection preserves retained observations and enabled child choice.')
  assert.equal(paused.settings.statistics.enabled, true)
  assert.deepEqual(await store.coverage(agent, capabilities, settings), observed)
  const { CAPABILITY_POLICY_DEFAULT } = await import('../internal/capability-policy.js')
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.defaults.disclosure = 'adaptive'; policy.allocation.baseline = false; policy.allocation.statistics = true
  const allocationInput = { enabled: true, configurationRevision: 'retained-statistics', policy, capabilities: [{ ...capabilities[0], category: 'tool', contract: 'probe()' }],
    statistics: { ...settings, enabled: false, minimumSamples: 1, fullThreshold: .5 }, manual: { baseline: [] },
    budgetBytes: 1000, directoryBudgetBytes: 1000, navigationText: 'Search capabilities.',
    coverage: await store.coverage(agent, capabilities, { ...settings, enabled: false }) }
  assert.equal(createCapabilityPlan(allocationInput).entries[0].selection, 'full')
  assert.equal(createCapabilityPlan(allocationInput).entries[0].reason, 'statistical-coverage')
  assert.equal(createCapabilityPlan({ ...allocationInput, policy: { ...policy, allocation: { ...policy.allocation, statistics: false } } }).entries[0].selection, 'on-demand')
  assert.equal(await readFile(filename, 'utf8'), before, 'allocation consumes retained observations without collecting')
})


test('statistics family follows Host parent lineage and rejects missing or cyclic ancestry', async () => {
  const { CapabilityStatisticsStore } = await import('../internal/capability-statistics-store.js')
  const parent = { id: 'parent', header: {} }
  const child = { id: 'child', header: { origin: 'subagent', parentSession: 'parent' } }
  const grandchild = { id: 'grandchild', header: { origin: 'subagent', parentSession: 'child' } }
  const sessions = new Map([[parent.id, parent], [child.id, child]])
  const store = new CapabilityStatisticsStore({ filename: 'unused', ctx: { sessions: { get: id => sessions.get(id) } } })
  assert.equal(store.family({ session: grandchild }), 'parent')
  sessions.delete('parent')
  assert.equal(store.family({ session: grandchild }), null)
  const fallback = new CapabilityStatisticsStore({ filename: 'unused', ctx: { agents: { get: id => id === 'parent' ? { session: parent } : undefined } } })
  assert.equal(fallback.family({ session: child }), 'parent')
  sessions.set('parent', { ...parent, header: { origin: 'subagent', parentSession: 'child' } })
  assert.equal(store.family({ session: grandchild }), null)
})
