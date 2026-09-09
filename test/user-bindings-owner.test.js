import assert from 'node:assert/strict'
import { sessionEvents } from '../internal/session-events.js'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { Session } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  USER_BINDINGS_RPC_CONTRACT,
  createUserBindingsOwner,
} from '../internal/user-bindings-owner.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

function injectedAgentContext(services) {
  const context = {
    inject(names, callback) {
      const disposers = []
      const scope = {}
      for (const name of names) {
        const service = services[name]
        assert.notEqual(service, undefined, `missing injected ${name} service`)
        scope[name] = Object.create(service)
        if (typeof service.register === 'function') {
          scope[name].register = (...args) => {
          if (name === 'tools') {
              assertObjectJsonSchema(args[0].parameters)
              assertSupportedJsonSchema(args[0].output.schema)
            }
            return service.register(...args)
          }
        }
      }
      scope.effect = (factory) => {
        const dispose = factory()
        disposers.push(dispose)
        return dispose
      }
      callback(scope)
      let active = true
      return {
        async dispose() {
          if (!active) return
          active = false
          for (const dispose of disposers.reverse()) await dispose?.()
        },
      }
    },
  }
  for (const name of Object.keys(services)) {
    Object.defineProperty(context, name, {
      get() { throw new Error(`cannot get property ${JSON.stringify(name)} without inject`) },
    })
  }
  return context
}

function nestedExecution(agent) {
  return { agent, parent: { name: 'run_code' } }
}

test('submission identity and cell lease cannot be borrowed by a later request', async t => {
  const state = await acceptedDraftFixture()
  t.after(() => state.owner.dispose())
  const entry = { id: 'lease', name: 'lease', scope: 'namespace', purpose: '', source: 'export const value = 1' }
  await state.start('first')
  let live = true
  const submit = state.owner.submissionForAgent(state.agent, () => { if (!live) throw new Error('lease expired') }, () => {})
  await assert.rejects(submit({ requestId: 'wrong', entry }), /request identity/)
  await assert.rejects(submit({}), /invalid binding submission/)
  await state.start('second')
  await assert.rejects(submit({ requestId: 'old', entry }), /no longer active/)
  live = false
  await assert.rejects(submit({ requestId: 'old', entry }), /lease expired/)
  const pending = state.start('disposed while beginning')
  await state.owner.clearAgentPresentation(state.agent)
  assert.equal((await pending).kind, 'error')
})

test('read-only review survives a consumed locator and is revoked on Agent cleanup', async t => {
  const state = await acceptedDraftFixture()
  t.after(() => state.owner.dispose())
  state.target.ctx.logger = { warn() { throw new Error('reporter unavailable') } }
  assert.equal((await call(state.target, 'draft-review', { capability: 'missing' })).value, null)
  const { capability, draft } = await state.submit('review')
  assert.equal((await call(state.target, 'draft-review', { capability })).value.action, null)
  assert.equal((await call(state.target, 'save-draft', { capability, version: draft.version, expectedRevision: 1 })).ok, true)
  const review = (await call(state.target, 'draft-review', { capability })).value
  assert.equal(review.action.state, 'saved')
  assert.equal(review.action.enabled, false)
  assert.equal(review.candidate.entry.source, draft.entry.source)
  await state.owner.clearAgentPresentation(state.agent)
  assert.equal((await call(state.target, 'draft-review', { capability })).value, null)
})

test('Agent and projection cleanup revoke an incomplete authoring transaction', async t => {
  for (const cleanup of ['clearAgentPresentation', 'setDraftProjectionAvailable']) {
    const fixture = await acceptedDraftFixture()
    t.after(() => fixture.owner.dispose())
    await fixture.start('unfinished')
    await fixture.owner[cleanup](cleanup === 'clearAgentPresentation' ? fixture.agent : false)
    await assert.rejects(fixture.submitEntry({ id: 'late', name: 'late', scope: 'namespace',
      purpose: '', source: 'export const value = 1' }), /no longer active/)
  }
})

function captureSubmission(owner, agent, message) {
  const requestId = JSON.parse(/requestId: ("[^"\n]+")/.exec(message.content[0].text)[1])
  const submit = owner.submissionForAgent(agent, () => {}, () => {})
  return {
    requestId,
    execute: (value, exec) => (exec?.agent === agent ? submit
      : owner.submissionForAgent(exec?.agent, () => {}, () => {}))({ requestId, ...value }),
  }
}

function ownerFixture(authoring) {
  let handler
  let handleArgumentCount
  let handleDisposals = 0
  let injectionDisposals = 0
  const effects = []
  const rpc = {
    register(channel, next) {
      assert.equal(channel, USER_BINDINGS_RPC_CONTRACT)
      handleArgumentCount = arguments.length
      handler = next
      return async () => { handleDisposals += 1 }
    },
  }
  const ctx = {
    agents: authoring?.agents ?? { list: () => [] },
    get(name) {
      return name === 'commands' ? authoring?.commands : undefined
    },
    tools: {
      get(name, agent) {
        return name === 'run_code' && agent?.runCodeAvailable !== false
          ? { name: 'run_code' }
          : undefined
      },
    },
    inject(services, callback) {
      if (services.length === 1 && services[0] === 'ptcPlusRpc') {
        callback({ ptcPlusRpc: rpc })
      } else if (services.length === 1 && services[0] === 'tools') {
        callback({ tools: ctx.tools, on: authoring?.on?.bind(authoring) })
      } else {
        assert.fail(`unexpected owner injection: ${services.join(',')}`)
      }
      return { dispose() { injectionDisposals += 1 } }
    },
    effect(register) {
      const dispose = register()
      let active = true
      const release = async () => {
        if (!active) return
        active = false
        await dispose()
      }
      effects.push(release)
      return release
    },
  }
  return {
    ctx,
    effects,
    get handler() { return handler },
    get handleArgumentCount() { return handleArgumentCount },
    get handleDisposals() { return handleDisposals },
    get injectionDisposals() { return injectionDisposals },
  }
}

function fakeStore() {
  const calls = []
  const methods = {
    filename: '/profile/ptc-plus/bindings.json',
    calls,
    snapshot: async () => ({ version: 1, revision: 0, fingerprint: '0'.repeat(64), entries: [] }),
    validationDocument: async () => ({ revision: 1, entries: [] }),
    list: async () => ({ revision: 1, entries: [] }),
    entry: async id => ({ id }),
    reload: async () => 'reload',
    save: async (...args) => (calls.push(['save', ...args]), 'save'),
    create: async (...args) => (calls.push(['create', ...args]), 'created'),
    setEnabled: async (...args) => (calls.push(['setEnabled', ...args]), 'enabled'),
    remove: async (...args) => (calls.push(['remove', ...args]), 'removed'),
    importFile: async (...args) => (calls.push(['importFile', ...args]), 'imported'),
  }
  return methods
}

async function call(target, endpoint, payload = {}, signal = new AbortController().signal) {
  return target.handler(endpoint, payload, signal)
}

async function acceptedDraftFixture(store = fakeStore(), ownerOptions = {}) {
  let command
  let draftTool
  const agent = {
    id: 'draft-agent',
    session: { id: 'draft-session' },
    inject() {},
    steer(message) { draftTool = captureSubmission(owner, agent, message) },
    ctx: injectedAgentContext({
      commands: {
        register(definition) { command = definition; return () => {} },
      },
      skills: { register() { return () => {} } },
      tools: {
        register(definition) { draftTool = definition; return () => {} },
      },
    }),
  }
  const authoring = {
    agents: { list: () => [agent] },
    on() { return () => {} },
  }
  const target = ownerFixture(authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store,
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
    ...ownerOptions,
  })
  await owner.setDraftProjectionAvailable(true)
  await owner.setAgentPresentation(agent, 'ptc')
  const start = id => command.handler({
    agent, rawInput: `new ${id}`, signal: new AbortController().signal,
  })
  const submitEntry = entry => draftTool.execute({ entry }, nestedExecution(agent))
  const submit = async (id) => {
    const commandResult = start(id)
    await new Promise(resolve => setImmediate(resolve))
    await submitEntry({
      id, name: id, scope: 'namespace', purpose: '', source: 'export const value = 1',
    })
    assert.equal((await commandResult).kind, 'success')
    const capability = owner.draftCapabilityForAgent(agent)
    const draft = (await call(target, 'draft', { capability })).value
    return { capability, draft }
  }
  return { agent, owner, start, submit, submitEntry, target }
}

test('rejects drafts that cannot fit the complete stored document', async () => {
  const scenarios = [
    {
      entries: Array.from({ length: 64 }, (_, index) => ({
        id: `entry-${index}`,
        name: `entry${index}`,
        scope: 'namespace',
        purpose: '',
        enabled: false,
        source: `export const value${index} = 1`,
      })),
      candidateSource: 'export const value = 1',
      expected: /at most 64 entries/,
    },
    {
      entries: Array.from({ length: 4 }, (_, index) => ({
        id: `large-${index}`,
        name: `large${index}`,
        scope: 'namespace',
        purpose: '',
        enabled: false,
        source: `export const value${index} = 1/*${'x'.repeat(60 * 1024)}*/`,
      })),
      candidateSource: `export const value = 1/*${'y'.repeat(20 * 1024)}*/`,
      expected: /character document limit/,
    },
  ]
  for (const scenario of scenarios) {
    const store = fakeStore()
    store.validationDocument = async () => ({ revision: 1, entries: scenario.entries })
    const current = await acceptedDraftFixture(store)
    const candidate = {
      id: 'candidate', name: 'candidate', scope: 'namespace', purpose: '',
      source: scenario.candidateSource,
    }
    const commandResult = current.start('candidate')
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(current.submitEntry(candidate), scenario.expected)
    await assert.rejects(current.submitEntry(candidate), scenario.expected)
    assert.equal(current.owner.draftCapabilityForAgent(current.agent), null)
    await current.owner.dispose()
    assert.equal((await commandResult).kind, 'success')
  }
})

test('registers and disposes binding operations through the shared RPC port', async () => {
    const target = ownerFixture()
    const owner = createUserBindingsOwner(target.ctx, {
      enabled: true,
      store: fakeStore(),
      cwd: process.cwd(),
      maxWallMs: 1_000,
      maxOutputBytes: 1024,
      maxOldGenerationSizeMb: 32,
      valueLimits: {},
    })
    assert.equal(target.handleArgumentCount, 2)
    assert.equal(owner.path, '/profile/ptc-plus/bindings.json')
    assert.equal((await call(target, 'list')).ok, true)
    await owner.dispose()
    assert.equal(target.injectionDisposals, 2)
    assert.equal(target.handleDisposals, 1)
    assert.equal((await call(target, 'list')).ok, false)
    await owner.dispose()
    assert.equal(target.handleDisposals, 1)
})

test('routes management operations through one revision-aware store owner', async () => {
  const target = ownerFixture()
  const store = fakeStore()
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store,
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  assert.equal((await owner.snapshot()).version, 1)
  assert.equal((await owner.list()).revision, 1)
  assert.deepEqual((await call(target, 'load', { id: 'x' })).value, { id: 'x' })
  assert.equal((await call(target, 'reload')).value, 'reload')
  assert.equal((await call(target, 'save', { entry: { id: 'x' }, expectedRevision: 1 })).value, 'save')
  assert.equal((await call(target, 'enable', { id: 'x', expectedRevision: 2 })).value, 'enabled')
  assert.equal((await call(target, 'disable', { id: 'x', expectedRevision: 3 })).value, 'enabled')
  assert.equal((await call(target, 'remove', { id: 'x', expectedRevision: 4 })).value, 'removed')
  assert.equal((await call(target, 'import', { path: 'x.ts', expectedRevision: 5, options: {} })).value, 'imported')
  assert.deepEqual(store.calls, [
    ['save', { id: 'x' }, 1],
    ['setEnabled', 'x', true, 2],
    ['setEnabled', 'x', false, 3],
    ['remove', 'x', 4],
    ['importFile', 'x.ts', 5, {}],
  ])
  assert.equal((await call(target, 'unknown')).ok, false)
  assert.equal((await call(target, 'persist', {})).ok, false)
  assert.equal((await call(target, 'revert', {})).ok, false)
  assert.equal((await call(target, 'draft', { capability: 'missing' })).value, null)
  assert.equal((await call(target, 'draft')).ok, false)
  assert.equal((await call(target, 'discard-draft', { capability: 'missing', version: 1 })).value, null)
  await owner.dispose()
})

test('scopes agent authoring to PTC sessions and accepts one validated in-memory draft', async () => {
  let command
  let draftTool
  let skill
  let commandDisposals = 0
  let toolDisposals = 0
  let skillDisposals = 0
  const injected = []
  const steered = []
  const agent = {
    id: 'agent-1',
    session: { id: 'session-1', header: { agentPreset: 'ptc' } },
    inject: message => injected.push(message),
    steer: message => { steered.push(message); draftTool = captureSubmission(owner, agent, message) },
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          command = definition
          return () => { commandDisposals += 1 }
        },
      },
      skills: {
        register(definition) {
          skill = definition
          return () => { skillDisposals += 1 }
        },
      },
      tools: {
        register(definition) {
          draftTool = definition
          return () => { toolDisposals += 1 }
        },
      },
    }),
  }
  const listeners = new Map()
  const authoring = {
    agents: { list: () => [agent] },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const target = ownerFixture(authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store: fakeStore(),
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  await owner.setDraftProjectionAvailable(true)
  await owner.setAgentPresentation(agent, 'ptc')
  assert.equal(command.name, 'binding')
  assert.match(command.input.hint, /new/)
  assert.equal((await command.handler({
    agent, rawInput: '', signal: new AbortController().signal,
  })).kind, 'error')
  const commandResult = command.handler({
    agent, rawInput: 'new format repository data', signal: new AbortController().signal,
  })
  let commandSettled = false
  void commandResult.then(() => { commandSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(commandSettled, true)
  assert.equal(skill, undefined)
  assert.deepEqual(injected, [])
  assert.deepEqual(steered[0].source, { kind: 'plugin', plugin: 'ptc-plus', form: 'instructions' })
  assert.match(steered[0].content[0].text, /format repository data/)

  const entry = {
    id: 'repo-data',
    name: 'repoData',
    scope: 'namespace',
    purpose: 'Format repository data.',
    source: 'export function format(value: string): string { return value.trim() }',
  }
  await assert.rejects(draftTool.execute({ entry }), /requesting Agent/)
  await assert.rejects(
    draftTool.execute({ entry }, nestedExecution({ id: 'foreign-agent' })),
    /requesting Agent/,
  )
  const submitted = await draftTool.execute({ entry }, nestedExecution(agent))
  assert.deepEqual(submitted, { accepted: true, id: 'repo-data', requestId: draftTool.requestId })
  assert.equal((await commandResult).kind, 'success')
  const capability = owner.draftCapabilityForAgent(agent)
  const draft = (await call(target, 'draft', { capability })).value
  assert.equal(draft.entry.enabled, false)
  assert.equal(draft.entry.symbols[0], 'format')
  assert.equal(skillDisposals, 0)
  assert.equal(toolDisposals, 0)
  assert.equal((await call(target, 'discard-draft', {
    capability, version: draft.version + 1,
  })).error.code, 'BINDINGS_CONFLICT')
  assert.equal((await call(target, 'save-draft', {
    capability, version: draft.version + 1, expectedRevision: 1,
  })).error.code, 'BINDINGS_CONFLICT')
  assert.equal((await call(target, 'discard-draft', {
    capability, version: draft.version,
  })).value, null)
  assert.equal((await call(target, 'draft', { capability })).value, null)
  await owner.dispose()
  assert.equal(commandDisposals, 1)
})

test('does not let discard overtake a draft save already in progress', async (t) => {
  const store = fakeStore()
  let releaseCreate
  let createStarted
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const createStart = new Promise(resolve => { createStarted = resolve })
  store.create = async (...args) => {
    store.calls.push(['create', ...args])
    createStarted()
    await createGate
    return 'created'
  }
  const fixture = await acceptedDraftFixture(store)
  t.after(() => fixture.owner.dispose())
  const { capability, draft } = await fixture.submit('serialDraft')
  const saving = call(fixture.target, 'save-draft', {
    capability, version: draft.version, expectedRevision: 1,
  })
  await createStart
  const discarded = await call(fixture.target, 'discard-draft', {
    capability, version: draft.version,
  })
  assert.equal(discarded.error.code, 'BINDINGS_BUSY')
  assert.equal((await call(fixture.target, 'save-draft', {
    capability, version: draft.version, expectedRevision: 1,
  })).error.code, 'BINDINGS_BUSY')
  releaseCreate()
  assert.equal((await saving).value, 'created')
  assert.equal((await call(fixture.target, 'draft', { capability })).value, null)
})

test('a completed write cannot resurrect a locator revoked during storage settlement', async t => {
  const store = fakeStore()
  let finish
  store.create = () => new Promise(resolve => { finish = resolve })
  const fixture = await acceptedDraftFixture(store)
  t.after(() => fixture.owner.dispose())
  const { capability, draft } = await fixture.submit('revoked')
  const saving = call(fixture.target, 'save-draft', { capability, version: draft.version, expectedRevision: 1 })
  await fixture.owner.clearAgentPresentation(fixture.agent)
  finish('created')
  assert.equal((await saving).value, 'created')
  assert.equal((await call(fixture.target, 'draft-review', { capability })).value, null)
  assert.equal((await call(fixture.target, 'draft', { capability })).value, null)
})

test('save-draft can atomically enable only on an explicit user action', async (t) => {
  const store = fakeStore()
  const fixture = await acceptedDraftFixture(store)
  t.after(() => fixture.owner.dispose())
  const { capability, draft } = await fixture.submit('explicitEnable')
  assert.equal((await call(fixture.target, 'save-draft', {
    capability,
    version: draft.version,
    expectedRevision: 1,
    activate: true,
  })).value, 'created')
  assert.equal(store.calls.at(-1)[0], 'create')
  assert.equal(store.calls.at(-1)[1].enabled, true)
  assert.equal((await call(fixture.target, 'draft', { capability })).value, null)
})

test('removes an accepted draft when its session presentation is disposed', async (t) => {
  const fixture = await acceptedDraftFixture()
  t.after(() => fixture.owner.dispose())
  const { capability } = await fixture.submit('sessionDraft')
  assert.equal((await call(fixture.target, 'draft', { sessionId: 'draft-session' })).ok, false)
  await fixture.owner.clearSessionPresentation('draft-session')
  assert.equal((await call(fixture.target, 'draft', { capability })).value, null)
  assert.equal(fixture.owner.draftCapabilityForAgent(fixture.agent), null)
})

test('draft removal never appends presentation notifications to a Session', async t => {
  for (const action of ['save', 'discard', 'agent', 'session', 'disable', 'dispose']) {
    const fixture = await acceptedDraftFixture()
    t.after(() => fixture.owner.dispose())
    const session = Session.create('draft-session')
    fixture.agent.session = session
    const appends = t.mock.method(session, 'append')
    const { capability, draft } = await fixture.submit(`draft_${action}`)
    if (action === 'save' || action === 'discard') {
      const result = await call(fixture.target, `${action}-draft`, {
        capability, version: draft.version, ...(action === 'save' ? { expectedRevision: 1 } : {}),
      })
      assert.equal(result.ok, true)
    } else if (action === 'agent') await fixture.owner.clearAgentPresentation(fixture.agent)
    else if (action === 'session') await fixture.owner.clearSessionPresentation(session.id)
    else if (action === 'disable') await fixture.owner.reconfigure({ userBindingsEnabled: false })
    else await fixture.owner.dispose()
    assert.equal(fixture.owner.draftCapabilityForAgent(fixture.agent), null)
    assert.equal(appends.mock.callCount(), 0, action)
    assert.deepEqual(sessionEvents(session), [])
  }
})


test('session disposal revokes drafts left by an Agent replaced in the same session', async (t) => {
  const fixture = await acceptedDraftFixture()
  t.after(() => fixture.owner.dispose())
  const { capability } = await fixture.submit('replacedDraft')
  let replacementCommand
  const replacement = {
    id: 'replacement-draft-agent',
    session: { id: 'draft-session' },
    inject() {},
    steer() {},
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          replacementCommand = definition
          return () => {}
        },
      },
      skills: { register() { return () => {} } },
      tools: { register() { return () => {} } },
    }),
  }
  await fixture.owner.setAgentPresentation(replacement)
  assert.equal(replacementCommand.name, 'binding')
  await fixture.owner.clearSessionPresentation('draft-session')
  assert.equal((await call(fixture.target, 'draft', { capability })).value, null)
  assert.equal(fixture.owner.draftCapabilityForAgent(replacement), null)
})

test('reports a session cleanup failure after revoking its Agent resources', async () => {
  const agent = {
    id: 'session-cleanup-failure-agent',
    session: { id: 'session-cleanup-failure' },
    inject() {},
    steer() {},
    ctx: injectedAgentContext({
      commands: {
        register() {
          return () => { throw new Error('session command disposal failed') }
        },
      },
      skills: { register() { return () => {} } },
      tools: { register() { return () => {} } },
    }),
  }
  const target = ownerFixture({ agents: { list: () => [agent] }, on() { return () => {} } })
  const owner = createUserBindingsOwner(target.ctx, { enabled: true, store: fakeStore() })
  await owner.setDraftProjectionAvailable(true)
  await owner.setAgentPresentation(agent)
  await assert.rejects(
    owner.clearSessionPresentation(agent.session.id),
    error => error instanceof AggregateError
      && error.message === 'Global User Bindings session cleanup failed',
  )
  await owner.dispose()
})



test('Agent disposal invalidates command reconciliation awaiting replaced command cleanup', async () => {
  let oldCommand
  let newCommandRegistrations = 0
  let releaseOldCommand
  let oldCommandDisposalStarted
  const oldCommandGate = new Promise(resolve => { releaseOldCommand = resolve })
  const disposalStart = new Promise(resolve => { oldCommandDisposalStarted = resolve })
  const session = { id: 'command-reconcile-session' }
  const oldAgent = {
    id: 'old-command-agent', session,
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          oldCommand = definition
          return async () => {
            oldCommandDisposalStarted()
            await oldCommandGate
          }
        },
      },
    }),
  }
  const newAgent = {
    id: 'new-command-agent', session,
    ctx: injectedAgentContext({
      commands: {
        register() {
          newCommandRegistrations += 1
          return () => {}
        },
      },
    }),
  }
  let agents = [oldAgent]
  const target = ownerFixture({ agents: { list: () => agents }, on() { return () => {} } })
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    draftProjectionAvailable: true,
    store: fakeStore(),
  })
  await owner.setAgentPresentation(oldAgent)
  assert.equal(oldCommand.name, 'binding')
  agents = [newAgent]
  const replacement = owner.setAgentPresentation(newAgent)
  await disposalStart
  const cleanup = owner.clearAgentPresentation(newAgent)
  releaseOldCommand()
  await Promise.all([replacement, cleanup])
  assert.equal(newCommandRegistrations, 0)
  await owner.dispose()
})

test('serializes same-agent command reinstallation behind async disposal', async () => {
  let registrations = 0
  let release
  let disposalStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { disposalStarted = resolve })
  const agent = {
    id: 'same-agent-command-race', session: { id: 'same-agent-command-race-session' },
    ctx: injectedAgentContext({
      commands: {
        register() {
          registrations += 1
          return async () => { disposalStarted(); await gate }
        },
      },
    }),
  }
  const target = ownerFixture({ agents: { list: () => [agent] }, on() { return () => {} } })
  const owner = createUserBindingsOwner(target.ctx, { enabled: true, draftProjectionAvailable: true, store: fakeStore() })
  await owner.setAgentPresentation(agent)
  agent.runCodeAvailable = false
  const removing = owner.setAgentPresentation(agent)
  await started
  agent.runCodeAvailable = true
  const reinstalling = owner.setAgentPresentation(agent)
  release()
  await Promise.all([removing, reinstalling])
  assert.equal(registrations, 2)
  await owner.dispose()
})

test('delayed command injection cannot resurrect a disposed Agent', async () => {
  let releaseInjection
  let command
  const injectionGate = new Promise(resolve => { releaseInjection = resolve })
  const agent = {
    id: 'delayed-command-agent', session: { id: 'delayed-command-session' },
    ctx: {
      inject(services, callback) {
        if (services[0] !== 'commands') throw new Error('unexpected injection')
        const fiber = injectionGate.then(() => callback({
          commands: { register(definition) { command = definition; return () => {} } },
        }))
        fiber.dispose = async () => {}
        return fiber
      },
    },
  }
  const target = ownerFixture({ agents: { list: () => [agent] }, on() { return () => {} } })
  const owner = createUserBindingsOwner(target.ctx, { enabled: true, draftProjectionAvailable: true, store: fakeStore() })
  const installing = owner.setAgentPresentation(agent)
  agent.runCodeAvailable = false
  releaseInjection()
  await installing
  assert.equal(command, undefined)
  await owner.clearAgentPresentation(agent)
  await owner.dispose()
})

test('keeps a command registration while its fiber is pending and installs it later', async () => {
  let command
  let callback
  const agent = {
    id: 'agent-pending-command-fiber', session: { id: 'session-pending-command-fiber' },
    ctx: {
      inject(_services, next) {
        callback = next
        // A Cordis fiber may settle while still PENDING on the command service;
        // its callback is invoked only after a later service notify. The
        // registration must survive that settle window and let the later
        // activation install the command.
        return Promise.resolve(undefined)
      },
    },
  }
  const authoring = { agents: { list: () => [agent] }, on() { return () => {} } }
  const target = ownerFixture(authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true, draftProjectionAvailable: true, store: fakeStore(),
  })
  await owner.setAgentPresentation(agent)
  await new Promise(resolve => setImmediate(resolve))
  callback({
    commands: { register(definition) { command = definition; return () => {} } },
    effect: factory => factory(),
  })
  assert.equal(command?.name, 'binding')
  await owner.dispose()
})

test('fails a stale command fiber activation and removes its placeholder registration', async () => {
  const warnings = []
  let command
  let releaseInjection
  const injectionGate = new Promise(resolve => { releaseInjection = resolve })
  const agent = {
    id: 'stale-command-agent', session: { id: 'stale-command-session' },
    ctx: {
      inject(_services, next) {
        const fiber = injectionGate.then(() => next({
          commands: { register(definition) { command = definition; return () => {} } },
          effect: factory => factory(),
        }))
        fiber.dispose = async () => {}
        return fiber
      },
    },
  }
  const authoring = { agents: { list: () => [agent] }, on() { return () => {} } }
  const target = ownerFixture(authoring)
  target.ctx.logger = { warn: (...args) => warnings.push(args) }
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true, draftProjectionAvailable: true, store: fakeStore(),
  })
  await owner.setAgentPresentation(agent)
  agent.runCodeAvailable = false
  releaseInjection()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(command, undefined)
  assert.equal(warnings.at(-1)[0], 'ptc-plus: failed to roll back Global User Bindings command injection')
  assert.match(warnings.at(-1)[1].message, /no longer eligible/)
  agent.runCodeAvailable = true
  await owner.setAgentPresentation(agent)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(command?.name, 'binding')
  await owner.dispose()
})

test('rejects command registration without a Cordis effect owner', async () => {
  let command
  const agent = {
    id: 'missing-effect-command-agent', session: { id: 'missing-effect-command-session' },
    ctx: {
      inject(_services, callback) {
        callback({ commands: { register(definition) { command = definition; return () => {} } } })
        return { dispose() {} }
      },
    },
  }
  const target = ownerFixture({ agents: { list: () => [agent] }, on() { return () => {} } })
  const owner = createUserBindingsOwner(target.ctx, { enabled: true, draftProjectionAvailable: true, store: fakeStore() })
  await assert.rejects(owner.setAgentPresentation(agent), /registration requires an effect owner/)
  assert.equal(command, undefined)
  await owner.dispose()
})

test('restores only the exact failed saving draft and preserves a replacement', async (t) => {
  const store = fakeStore()
  let rejectCreate
  let createStarted
  const createStart = new Promise(resolve => { createStarted = resolve })
  store.create = async () => new Promise((_resolve, reject) => {
    rejectCreate = reject
    createStarted()
  })
  const fixture = await acceptedDraftFixture(store)
  t.after(() => fixture.owner.dispose())
  const first = await fixture.submit('firstDraft')
  const saving = call(fixture.target, 'save-draft', {
    capability: first.capability,
    version: first.draft.version,
    expectedRevision: 1,
  })
  await createStart
  const replacement = await fixture.submit('replacementDraft')
  rejectCreate(new Error('store failed'))
  assert.equal((await saving).ok, false)
  assert.equal((await call(fixture.target, 'draft', { capability: first.capability })).value, null)
  assert.equal(
    (await call(fixture.target, 'draft', { capability: replacement.capability })).value.entry.id,
    'replacementDraft',
  )
  store.create = async () => { throw new Error('retry failed') }
  assert.equal((await call(fixture.target, 'save-draft', {
    capability: replacement.capability,
    version: replacement.draft.version,
    expectedRevision: 1,
  })).ok, false)
  assert.equal(
    (await call(fixture.target, 'draft', { capability: replacement.capability })).value.entry.id,
    'replacementDraft',
  )
})

test('follows the fresh agent run_code view instead of preset labels or prompt assembly', async () => {
  const registrations = []
  const listeners = new Map()
  let disposals = 0
  const agent = {
    id: 'agent-custom',
    session: { id: 'session-custom', header: { agentPreset: 'custom' } },
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          registrations.push(definition)
          return async () => { disposals += 1 }
        },
      },
    }),
  }
  const authoring = {
    agents: { list: () => [agent] },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const target = ownerFixture(authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store: fakeStore(),
    cwd: process.cwd(),
  })
  assert.equal(registrations.length, 0)
  await owner.setDraftProjectionAvailable(true)
  assert.equal(registrations.length, 1)
  await owner.setAgentPresentation(agent, 'native')
  assert.equal(registrations.length, 1)
  agent.runCodeAvailable = false
  listeners.get('tools/change')()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposals, 1)
  agent.runCodeAvailable = true
  listeners.get('tools/change')()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registrations.length, 2)
  const unavailableCommand = registrations.at(-1)
  await owner.setDraftProjectionAvailable(false)
  assert.equal(disposals, 2)
  assert.match((await unavailableCommand.handler({
    agent, rawInput: 'new unavailable', signal: new AbortController().signal,
  })).text, /draft projection/)
  await owner.setDraftProjectionAvailable(true)
  assert.equal(registrations.length, 3)
  await owner.clearSessionPresentation(agent.session.id)
  assert.equal(disposals, 3)
  await owner.dispose()
})


test('rejects command registration when the injected scope lacks an effect owner', async () => {
  const warnings = []
  const agent = {
    id: 'agent-missing-effect-owner',
    session: { id: 'session-missing-effect-owner' },
    ctx: {
      inject(names, callback) {
        assert.deepEqual(names, ['commands'])
        callback({ commands: { register() { return () => {} } } })
        return { dispose() {} }
      },
    },
  }
  const authoring = { agents: { list: () => [agent] }, on() { return () => {} } }
  const target = ownerFixture(authoring)
  target.ctx.logger = { warn: (...args) => warnings.push(args) }
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    draftProjectionAvailable: true,
    store: fakeStore(),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(warnings.at(-1)[1].message, /registration requires an effect owner/)
  await owner.dispose()
})

test('cleans up a command injection that resolves without invoking its callback', async () => {
  const agent = {
    id: 'agent-empty-command-fiber',
    session: { id: 'session-empty-command-fiber' },
    ctx: {
      inject(names) {
        assert.deepEqual(names, ['commands'])
        return Promise.resolve(undefined)
      },
    },
  }
  const authoring = { agents: { list: () => [agent] }, on() { return () => {} } }
  const target = ownerFixture(authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    draftProjectionAvailable: true,
    store: fakeStore(),
  })
  await new Promise(resolve => setImmediate(resolve))
  await owner.dispose()
})


test('contains command-fiber activation and disposal failures', async () => {
  const warnings = []
  const syncFailureAgent = {
    id: 'agent-sync-command-failure',
    session: { id: 'session-sync-command-failure' },
    ctx: {},
  }
  const syncAuthoring = {
    agents: { list: () => [syncFailureAgent] },
    on() { return () => {} },
  }
  const syncTarget = ownerFixture(syncAuthoring)
  syncTarget.ctx.logger = { warn: (...args) => warnings.push(args) }
  const syncOwner = createUserBindingsOwner(syncTarget.ctx, {
    enabled: true,
    draftProjectionAvailable: true,
    store: fakeStore(),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(warnings.at(-1)[1].message, /requires agent-scoped Cordis injection/)
  await syncOwner.dispose()

  let containedDisposals = 0
  const containedFailureAgent = {
    id: 'agent-contained-command-failure',
    session: { id: 'session-contained-command-failure' },
    ctx: {
      inject() {
        return {
          then(_resolve, reject) { reject(new Error('contained command activation failed')) },
          dispose() { containedDisposals += 1 },
        }
      },
    },
  }
  const containedAuthoring = {
    agents: { list: () => [containedFailureAgent] },
    on() { return () => {} },
  }
  const containedTarget = ownerFixture(containedAuthoring)
  containedTarget.ctx.logger = { warn: (...args) => warnings.push(args) }
  const containedOwner = createUserBindingsOwner(containedTarget.ctx, {
    enabled: true,
    store: fakeStore(),
  })
  await containedOwner.setDraftProjectionAvailable(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(containedDisposals, 1)
  assert.equal(warnings.at(-1)[0], 'ptc-plus: failed to roll back Global User Bindings command injection')
  assert.equal(warnings.at(-1)[1].message, 'contained command activation failed')
  await containedOwner.dispose()

  let asyncDisposed = 0
  const asyncFailureAgent = {
    id: 'agent-async-command-failure',
    session: { id: 'session-async-command-failure' },
    ctx: {
      inject() {
        return {
          then(_resolve, reject) { reject(new Error('command activation failed')) },
          dispose() {
            asyncDisposed += 1
            return Promise.reject(new Error('command rollback failed'))
          },
        }
      },
    },
  }
  const asyncAuthoring = {
    agents: { list: () => [asyncFailureAgent] },
    on() { return () => {} },
  }
  const asyncTarget = ownerFixture(asyncAuthoring)
  asyncTarget.ctx.logger = { warn: (...args) => warnings.push(args) }
  const asyncOwner = createUserBindingsOwner(asyncTarget.ctx, {
    enabled: true,
    store: fakeStore(),
  })
  await asyncOwner.setDraftProjectionAvailable(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(asyncDisposed, 1)
  assert.equal(warnings.at(-1)[0], 'ptc-plus: failed to roll back Global User Bindings command injection')
  assert.deepEqual(
    warnings.at(-1)[1].errors.map(error => error.message),
    ['command activation failed', 'command rollback failed'],
  )
  await asyncOwner.dispose()

  let disposedCommand
  const listeners = new Map()
  const disposalAgent = {
    id: 'agent-command-disposal-failure',
    session: { id: 'session-command-disposal-failure' },
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          disposedCommand = definition
          return () => { throw new Error('command disposal failed') }
        },
      },
    }),
  }
  const disposalAuthoring = {
    agents: { list: () => [disposalAgent] },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
  }
  const disposalTarget = ownerFixture(disposalAuthoring)
  disposalTarget.ctx.logger = { warn: (...args) => warnings.push(args) }
  const disposalOwner = createUserBindingsOwner(disposalTarget.ctx, {
    enabled: true,
    store: fakeStore(),
  })
  await disposalOwner.setDraftProjectionAvailable(true)
  assert.equal(disposedCommand.name, 'binding')
  await listeners.get('agent/disposed')({ agent: disposalAgent })
  assert.equal(warnings.at(-1)[0], 'ptc-plus: failed to dispose Global User Bindings authoring')
  await disposalOwner.dispose()
})


test('keeps Agent authoring request-scoped across edits, conflicts, and lifecycle cleanup', async () => {
  let command
  let draftTool
  const listeners = new Map()
  const registrations = []
  const injected = []
  const steered = []
  let injectionFailure = false
  const agent = {
    id: 'agent-edit',
    session: { id: 'session-edit', header: { agentPreset: 'code' } },
    inject: (message) => {
      if (injectionFailure) throw new Error('injection unavailable')
      injected.push(message)
    },
    steer: message => {
      if (injectionFailure) throw new Error('injection unavailable')
      steered.push(message)
      draftTool = captureSubmission(owner, agent, message)
    },
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          command = definition
          registrations.push(['command', definition])
          return () => {}
        },
      },
      skills: {
        register(definition) {
          registrations.push(['skill', definition])
          return () => {}
        },
      },
      tools: {
        register(definition) {
          draftTool = definition
          registrations.push(['tool', definition])
          return () => {}
        },
      },
    }),
  }
  const nativeAgent = {
    ...agent,
    id: 'agent-native',
    session: { id: 'session-native', header: { agentPreset: 'native' } },
    runCodeAvailable: false,
  }
  const authoring = {
    agents: { list: () => [agent, nativeAgent] },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const original = {
    id: 'alpha', name: 'alpha', scope: 'namespace', purpose: 'Original helper.', enabled: true,
    source: 'export function value(): number { return 1 }',
    modelContext: { includeDeclaration: false, instructions: 'Use alpha.value().' },
  }
  const occupied = {
    id: 'occupied', name: 'occupied', scope: 'namespace', purpose: '', enabled: true,
    source: 'export const value = 2',
  }
  const store = fakeStore()
  store.entry = async (id) => {
    if (id !== original.id) throw new Error(`binding entry ${JSON.stringify(id)} does not exist`)
    return { revision: 4, entry: original }
  }
  store.list = async () => ({ revision: 4, entries: [original, occupied] })
  store.snapshot = async () => createUserBindingsSnapshot({ entries: [original, occupied] }, 4)
  store.validationDocument = async () => ({ revision: 4, entries: [original, occupied] })
  const target = ownerFixture(authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store,
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  await owner.setDraftProjectionAvailable(true)
  await owner.setAgentPresentation(agent, 'ptc')
  assert.equal(registrations.filter(([kind]) => kind === 'command').length, 1)
  assert.equal((await command.handler({
    agent, rawInput: 'unsupported operation', signal: new AbortController().signal,
  })).kind, 'error')

  const editCommandResult = command.handler({
    agent, rawInput: 'edit alpha return a configurable value', signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(steered.at(-1).content[0].text, /Original helper/)
  assert.match(steered.at(-1).content[0].text, /modelContext\.instructions/)
  assert.match(steered.at(-1).content[0].text, /preserve the entry ID and existing prompt preferences/)
  await assert.rejects(draftTool.execute({ entry: {
    id: 'renamed', name: original.name, scope: original.scope,
    purpose: original.purpose, source: original.source,
  } }, nestedExecution(agent)), /id must remain/)
  await assert.rejects(draftTool.execute({ entry: {
    id: 'alpha', name: 'occupied', scope: 'namespace', purpose: '', source: 'export const other = 3',
  } }, nestedExecution(agent)), /conflicts between entries/)
  const acceptedTool = draftTool
  const acceptedSubmission = acceptedTool.execute({ entry: {
    id: 'alpha', name: 'alpha', scope: 'namespace', purpose: 'Revised helper.',
    source: 'export function value(): number { return 3 }',
    modelContext: { includeDeclaration: false, instructions: 'Use alpha.value() for the revised value.' },
  } }, nestedExecution(agent))
  await assert.rejects(acceptedTool.execute({ entry: {
    id: 'alpha', name: 'alpha', scope: 'namespace', purpose: '', source: 'export const value = 4',
  } }, nestedExecution(agent)), /already processing/)
  assert.deepEqual(await acceptedSubmission, { accepted: true, id: 'alpha', requestId: acceptedTool.requestId })
  assert.equal((await editCommandResult).kind, 'success')
  await assert.rejects(acceptedTool.execute({ entry: {
    id: 'alpha', name: 'alpha', scope: 'namespace', purpose: '', source: 'export const value = 4',
  } }, nestedExecution(agent)), /no longer active/)
  const editCapability = owner.draftCapabilityForAgent(agent)
  const editDraft = (await call(target, 'draft', { capability: editCapability })).value
  assert.equal(editDraft.entry.modelContext.includeDeclaration, false)
  assert.equal((await call(target, 'save-draft', {
    capability: editCapability, version: editDraft.version, expectedRevision: 4,
  })).value, 'save')
  assert.equal((await call(target, 'draft', { capability: editCapability })).value, null)
  assert.equal(store.calls.at(-1)[0], 'save')
  assert.equal(store.calls.at(-1)[1].enabled, false)
  assert.equal(store.calls.at(-1)[1].modelContext.instructions, 'Use alpha.value() for the revised value.')

  injectionFailure = true
  assert.match((await command.handler({
    agent, rawInput: 'new unavailable injection', signal: new AbortController().signal,
  })).text, /injection unavailable/)
  injectionFailure = false
  const readEntry = store.entry
  store.entry = async () => { throw 'plain entry failure' }
  assert.equal((await command.handler({
    agent, rawInput: 'edit alpha unavailable entry', signal: new AbortController().signal,
  })).text, 'plain entry failure')
  store.entry = readEntry

  const turnCommandResult = command.handler({
    agent, rawInput: 'new another helper', signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(draftTool.execute({ entry: {
    id: 'occupied', name: 'newName', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }, nestedExecution(agent)), /already exists/)
  const turnTool = draftTool
  await listeners.get('agent/turn-stopping')({ agent })
  assert.deepEqual(await turnCommandResult, { kind: 'success' })
  await assert.rejects(turnTool.execute({ entry: {
    id: 'turn', name: 'turn', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }, nestedExecution(agent)), /no longer active/)

  const errorCommandResult = command.handler({
    agent, rawInput: 'new error cleanup', signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  const errorTool = draftTool
  await listeners.get('agent/error')({ agent })
  assert.deepEqual(await errorCommandResult, { kind: 'success' })
  await assert.rejects(errorTool.execute({ entry: {
    id: 'error', name: 'errorBinding', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }, nestedExecution(agent)), /no longer active/)

  const cancelledCommand = new AbortController()
  const cancelledResult = command.handler({
    agent, rawInput: 'new cancelled authoring', signal: cancelledCommand.signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  const cancelledTool = draftTool
  cancelledCommand.abort()
  assert.deepEqual(await cancelledResult, { kind: 'success' })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(cancelledTool.execute({ entry: {
    id: 'cancelled', name: 'cancelledBinding', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }, nestedExecution(agent)), /no longer active/)

  const unavailableResult = command.handler({
    agent, rawInput: 'new unavailable surface', signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  const unavailableTool = draftTool
  agent.runCodeAvailable = false
  await owner.setAgentPresentation(agent)
  assert.deepEqual(await unavailableResult, { kind: 'success' })
  await assert.rejects(unavailableTool.execute({ entry: {
    id: 'unavailable', name: 'unavailable', scope: 'namespace', purpose: '',
    source: 'export const value = 1',
  } }, nestedExecution(agent)), /no longer active/)
  agent.runCodeAvailable = true
  await owner.setAgentPresentation(agent)

  const disposalCommandResult = command.handler({
    agent, rawInput: 'new disposal cleanup', signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await draftTool.execute({ entry: {
    id: 'disposal', name: 'disposal', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }, nestedExecution(agent)), { accepted: true, id: 'disposal', requestId: draftTool.requestId })
  assert.equal((await disposalCommandResult).kind, 'success')
  const disposalCapability = owner.draftCapabilityForAgent(agent)
  assert.notEqual((await call(target, 'draft', { capability: disposalCapability })).value, null)
  await listeners.get('agent/disposed')({ agent })
  assert.equal((await call(target, 'draft', { capability: disposalCapability })).value, null)

  listeners.get('agent/created')({ agent })
  await owner.setAgentPresentation(agent, 'ptc')
  const disabledDraftResult = command.handler({
    agent, rawInput: 'new disabled cleanup', signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  await draftTool.execute({ entry: {
    id: 'disabled-draft', name: 'disabledDraft', scope: 'namespace', purpose: '',
    source: 'export const value = 1',
  } }, nestedExecution(agent))
  assert.equal((await disabledDraftResult).kind, 'success')
  const disabledCapability = owner.draftCapabilityForAgent(agent)
  const disabledCommandResult = command.handler({
    agent, rawInput: 'new pending disablement', signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  const disabledTool = draftTool
  await owner.reconfigure({
    userBindingsEnabled: false,
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    maxValueNodes: 100,
    maxValueEdges: 100,
    maxValueArrayLength: 100,
    maxValueBigIntDigits: 100,
  })
  assert.deepEqual(await disabledCommandResult, { kind: 'success' })
  await assert.rejects(disabledTool.execute({ entry: {
    id: 'disabled', name: 'disabledBinding', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }, nestedExecution(agent)), /no longer active/)
  await owner.reconfigure({
    userBindingsEnabled: true,
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    maxValueNodes: 100,
    maxValueEdges: 100,
    maxValueArrayLength: 100,
    maxValueBigIntDigits: 100,
  })
  assert.equal((await call(target, 'draft', { capability: disabledCapability })).value, null)
  assert.equal(injected.length, 0)
  await owner.dispose()
})

test('revokes authoring continuations that cross capability disablement', async () => {
  let command
  let draftTool
  const listeners = new Map()
  const agent = {
    id: 'agent-race',
    session: { id: 'session-race', header: { agentPreset: 'ptc' } },
    inject() {},
    steer(message) { draftTool = captureSubmission(owner, agent, message) },
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          command = definition
          return () => {}
        },
      },
      skills: { register() { return () => {} } },
      tools: {
        register(definition) {
          draftTool = definition
          return () => {}
        },
      },
    }),
  }
  const authoring = {
    agents: { list: () => [agent] },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const store = fakeStore()
  let releaseEntry
  let entryStarted
  const entryGate = new Promise(resolve => { releaseEntry = resolve })
  const entryStart = new Promise(resolve => { entryStarted = resolve })
  store.entry = async () => {
    entryStarted()
    await entryGate
    return {
      revision: 1,
      entry: {
        id: 'race', name: 'race', scope: 'namespace', purpose: '', enabled: true,
        source: 'export const value = 1',
      },
    }
  }
  const target = ownerFixture(authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store,
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  await owner.setDraftProjectionAvailable(true)
  await owner.setAgentPresentation(agent, 'ptc')
  const runtimeConfig = userBindingsEnabled => ({
    userBindingsEnabled,
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    maxValueNodes: 100,
    maxValueEdges: 100,
    maxValueArrayLength: 100,
    maxValueBigIntDigits: 100,
  })

  const pendingEdit = command.handler({
    agent,
    rawInput: 'edit race change the value',
    signal: new AbortController().signal,
  })
  await entryStart
  await owner.reconfigure(runtimeConfig(false))
  releaseEntry()
  assert.match((await pendingEdit).text, /no longer active/)
  assert.equal(draftTool, undefined)

  await owner.reconfigure(runtimeConfig(true))
  const delayedCommand = command.handler({
    agent,
    rawInput: 'new delayed candidate',
    signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  const staleTool = draftTool
  let releaseDocument
  let documentStarted
  const documentGate = new Promise(resolve => { releaseDocument = resolve })
  const documentStart = new Promise(resolve => { documentStarted = resolve })
  store.validationDocument = async () => {
    documentStarted()
    await documentGate
    return { revision: 1, entries: [] }
  }
  const pendingSubmission = staleTool.execute({ entry: {
    id: 'delayed', name: 'delayed', scope: 'namespace', purpose: '',
    source: 'export const value = 1',
  } }, nestedExecution(agent))
  await documentStart
  await owner.reconfigure(runtimeConfig(false))
  releaseDocument()
  await assert.rejects(pendingSubmission, /no longer active/)
  assert.deepEqual(await delayedCommand, { kind: 'success' })

  await owner.reconfigure(runtimeConfig(true))
  assert.equal((await call(target, 'draft', { capability: 'missing' })).value, null)
  await owner.dispose()
})

test('keeps disabled mode storage-dark and enables it through live reconfiguration', async () => {
  const target = ownerFixture()
  let snapshots = 0
  const store = fakeStore()
  store.snapshot = async () => { snapshots += 1; return 'snapshot' }
  const owner = createUserBindingsOwner(target.ctx, { enabled: false, store })
  assert.equal(await owner.snapshot(), undefined)
  assert.equal(snapshots, 0)
  assert.equal(target.handler, undefined)
  await owner.reconfigure({
    userBindingsEnabled: true,
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    maxValueNodes: 100,
    maxValueEdges: 100,
    maxValueArrayLength: 100,
    maxValueBigIntDigits: 100,
  })
  assert.equal((await call(target, 'list')).ok, true)
  assert.equal(await owner.snapshot(), 'snapshot')
  assert.equal(snapshots, 1)
  await owner.dispose()
})

test('rolls back a failed user-binding enablement before allowing retry', async () => {
  let failMount = true
  let handler
  const store = fakeStore()
  const ctx = {
    inject(services, callback) {
      if (services[0] === 'ptcPlusRpc') {
        if (failMount) throw new Error('connection mount failed')
        callback({ ptcPlusRpc: { register(_channel, next) { handler = next; return () => {} } } })
      }
      return () => {}
    },
    effect(register) { return register() },
  }
  const owner = createUserBindingsOwner(ctx, { enabled: false, store })
  const config = {
    userBindingsEnabled: true,
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    maxValueNodes: 100,
    maxValueEdges: 100,
    maxValueArrayLength: 100,
    maxValueBigIntDigits: 100,
  }
  await assert.rejects(owner.reconfigure(config), /connection mount failed/)
  assert.equal(await owner.snapshot(), undefined)
  failMount = false
  await owner.reconfigure(config)
  assert.equal((await handler('list', {})).ok, true)
  await owner.dispose()
})

test('rejects an RPC registration that provides no disposer', () => {
  const ctx = {
    inject(services, callback) {
      if (services[0] === 'ptcPlusRpc') {
        callback({ ptcPlusRpc: { register() { return () => {} } } })
      }
      return () => {}
    },
    effect(register) {
      register()
      return undefined
    },
  }
  assert.throws(
    () => createUserBindingsOwner(ctx, { enabled: true, store: fakeStore() }),
    /RPC registration did not return a disposer/,
  )
})

test('restores the enabled owner state when user-binding disposal fails', async () => {
  let failDispose = true
  let handler
  const store = fakeStore()
  const ctx = {
    inject(services, callback) {
      if (services[0] === 'ptcPlusRpc') {
        callback({ ptcPlusRpc: { register(_channel, next) { handler = next; return () => {} } } })
        return async () => {
          if (failDispose) {
            failDispose = false
            throw new Error('connection disposal failed')
          }
        }
      }
      return () => {}
    },
    effect(register) { return register() },
  }
  const owner = createUserBindingsOwner(ctx, { enabled: true, store })
  const disabled = {
    userBindingsEnabled: false,
    maxWallMs: 2_000,
    maxOutputBytes: 2_048,
    maxOldGenerationSizeMb: 64,
    maxValueNodes: 200,
    maxValueEdges: 200,
    maxValueArrayLength: 200,
    maxValueBigIntDigits: 200,
  }
  await assert.rejects(owner.reconfigure(disabled), /RPC unmount failed/)
  assert.equal((await handler('list', {})).ok, true)
  assert.equal((await owner.snapshot()).version, 1)
  await owner.reconfigure(disabled)
  assert.equal(await owner.snapshot(), undefined)
  await owner.dispose()
})

test('repairs RPC registrations after injection disposal fails during disablement', async () => {
  let failInjectionDispose = true
  let handleCalls = 0
  const activeHandlers = new Set()
  const ctx = {
    inject(services, callback) {
      if (services[0] !== 'ptcPlusRpc') return () => {}
      callback({ ptcPlusRpc: {
        register(_channel, handler) {
          handleCalls += 1
          activeHandlers.add(handler)
          return async () => { activeHandlers.delete(handler) }
        },
      } })
      return async () => {
        if (failInjectionDispose) {
          failInjectionDispose = false
          throw new Error('connection injection disposal failed')
        }
      }
    },
    effect(register) { return register() },
  }
  const owner = createUserBindingsOwner(ctx, { enabled: true, store: fakeStore() })
  const disabled = {
    userBindingsEnabled: false,
    maxWallMs: 2_000,
    maxOutputBytes: 2_048,
    maxOldGenerationSizeMb: 64,
    maxValueNodes: 200,
    maxValueEdges: 200,
    maxValueArrayLength: 200,
    maxValueBigIntDigits: 200,
  }
  assert.equal(activeHandlers.size, 1)
  await assert.rejects(owner.reconfigure(disabled), /RPC unmount failed/)
  assert.equal(handleCalls, 2)
  assert.equal(activeHandlers.size, 1)
  assert.equal((await [...activeHandlers][0]('list', {})).ok, true)
  await owner.reconfigure(disabled)
  assert.equal(activeHandlers.size, 0)
  await owner.dispose()
})

test('repairs authoring injection after its disposer tears down then rejects', async () => {
  let command
  let commandActive = false
  let draftTool
  let failAuthoringDispose = true
  let authoringMounts = 0
  const activeAuthoringFibers = new Set()
  const agent = {
    id: 'authoring-rollback-agent',
    session: { id: 'authoring-rollback-session' },
    inject() {},
    steer(message) { draftTool = captureSubmission(owner, agent, message) },
    ctx: injectedAgentContext({
      commands: {
        register(definition) {
          command = definition
          commandActive = true
          return () => { commandActive = false }
        },
      },
      skills: { register() { return () => {} } },
      tools: { register(definition) { draftTool = definition; return () => {} } },
    }),
  }
  const ctx = {
    agents: { list: () => [agent] },
    tools: { get: (name, scope) => name === 'run_code' && scope === agent ? { name } : undefined },
    inject(services, callback) {
      if (services[0] === 'ptcPlusRpc') {
        callback({ ptcPlusRpc: { register() { return () => {} } } })
        return () => {}
      }
      assert.deepEqual(services, ['tools'])
      const fiber = ++authoringMounts
      activeAuthoringFibers.add(fiber)
      callback({ tools: ctx.tools, on() { return () => {} } })
      return async () => {
        activeAuthoringFibers.delete(fiber)
        if (failAuthoringDispose) {
          failAuthoringDispose = false
          throw new Error('authoring injection disposal failed')
        }
      }
    },
    effect(register) { return register() },
  }
  const owner = createUserBindingsOwner(ctx, {
    enabled: true,
    draftProjectionAvailable: true,
    store: fakeStore(),
    cwd: process.cwd(),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(authoringMounts, 1)
  assert.equal(commandActive, true)

  const disabled = {
    userBindingsEnabled: false,
    maxWallMs: 2_000,
    maxOutputBytes: 2_048,
    maxOldGenerationSizeMb: 64,
    maxValueNodes: 200,
    maxValueEdges: 200,
    maxValueArrayLength: 200,
    maxValueBigIntDigits: 200,
  }
  await assert.rejects(owner.reconfigure(disabled), /authoring unmount failed/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(authoringMounts, 2)
  assert.deepEqual([...activeAuthoringFibers], [2])
  assert.equal(commandActive, true)
  assert.equal((await command.handler({
    agent,
    rawInput: 'new rollback helper',
    signal: new AbortController().signal,
  })).kind, 'success')
  assert.equal(typeof draftTool.execute, 'function')

  await owner.reconfigure(disabled)
  assert.equal(activeAuthoringFibers.size, 0)
  assert.equal(commandActive, false)
  await owner.dispose()
})

test('reports enablement together with failed partial-mount cleanup', async () => {
  let cleanupFails = true
  const ctx = {
    inject(services, callback) {
      if (services[0] === 'ptcPlusRpc') {
        callback({ ptcPlusRpc: { register() { return () => {} } } })
        return async () => {
          if (cleanupFails) {
            cleanupFails = false
            throw new Error('connection cleanup failed')
          }
        }
      }
      throw new Error('authoring mount failed')
    },
    effect(register) { return register() },
  }
  const owner = createUserBindingsOwner(ctx, { enabled: false, store: fakeStore() })
  await assert.rejects(owner.reconfigure({
    userBindingsEnabled: true,
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    maxValueNodes: 100,
    maxValueEdges: 100,
    maxValueArrayLength: 100,
    maxValueBigIntDigits: 100,
  }), /enablement and rollback failed/)
  assert.equal(await owner.snapshot(), undefined)
  await owner.dispose()
})

test('reports disablement together with failed previous-surface restoration', async () => {
  let connectionDisposeFails = true
  let authoringMounts = 0
  const ctx = {
    inject(services, callback) {
      if (services[0] === 'ptcPlusRpc') {
        callback({ ptcPlusRpc: { register() { return () => {} } } })
        return async () => {
          if (connectionDisposeFails) {
            connectionDisposeFails = false
            throw new Error('connection disposal failed')
          }
        }
      }
      authoringMounts += 1
      if (authoringMounts > 1) throw new Error('authoring remount failed')
      return () => {}
    },
    effect(register) { return register() },
  }
  const owner = createUserBindingsOwner(ctx, { enabled: true, store: fakeStore() })
  await assert.rejects(owner.reconfigure({
    userBindingsEnabled: false,
    maxWallMs: 2_000,
    maxOutputBytes: 2_048,
    maxOldGenerationSizeMb: 64,
    maxValueNodes: 200,
    maxValueEdges: 200,
    maxValueArrayLength: 200,
    maxValueBigIntDigits: 200,
  }), /disablement and rollback failed/)
  assert.equal((await owner.snapshot()).version, 1)
  await owner.dispose()
})

test('validates and runs candidates without mutating the store', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-plus-candidate-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'value.mjs'), 'export const base = 40\n')
  const target = ownerFixture()
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store: fakeStore(),
    cwd,
    maxWallMs: 2_000,
    maxOutputBytes: 8_192,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  const source = `
export async function add(value: number) {
  const { base } = await import('./value.mjs')
  console.log('candidate')
  return base + value
}
`
  const validated = await call(target, 'validate', {
    entry: {
      id: 'candidate', name: 'candidate', scope: 'namespace', purpose: '', enabled: false, source,
      modelContext: { includeDeclaration: true, instructions: 'Use candidate.add(value).' },
    },
  })
  assert.equal(validated.ok, true)
  assert.match(validated.value.declaration, /add\(value: number\)/)
  assert.equal(validated.value.modelContext.instructions, 'Use candidate.add(value).')
  const result = await call(target, 'run', {
    source,
    invocation: { symbol: 'add', args: [2] },
  })
  assert.equal(result.value.value, 42)
  assert.match(result.value.logs.map(item => item.text).join(''), /candidate/)
  const symbols = await call(target, 'run', { source: 'export const one = 1' })
  assert.deepEqual(symbols.value.value, { symbols: ['one'] })
  assert.equal((await call(target, 'run', { source, invocation: { symbol: 'missing', args: [] } })).ok, false)
  assert.equal((await call(target, 'run', { source, invocation: { symbol: 'add', args: 'bad' } })).ok, false)
  const consoleResult = await call(target, 'console-run', { source, code: 'const total = await add(2); total' })
  assert.equal(consoleResult.ok, true)
  assert.equal(consoleResult.value.output, '42')
  const environment = consoleResult.value.environment
  assert.equal((await call(target, 'console-run', { environment, source, code: 'total + 1' })).value.output, '43')
  assert.equal((await call(target, 'console-release', { environment })).value, null)
  const recreated = await call(target, 'console-run', { environment, source, code: 'typeof total' })
  assert.equal(recreated.value.reset, true)
  assert.equal(recreated.value.output, "'undefined'")
  await owner.dispose()
})

test('cancels, times out, and bounds candidate output', async () => {
  const scenarios = [
    {
      options: { maxWallMs: 20, maxOutputBytes: 1024 },
      source: 'while (true) {}',
      expected: /exceeded/,
    },
    {
      options: { maxWallMs: 1_000, maxOutputBytes: 8 },
      source: 'console.log("output too large"); export const value = 1',
      expected: /output exceeded/,
    },
    {
      options: { maxWallMs: 1_000, maxOutputBytes: 512 },
      source: 'export function values() { return Array.from({ length: 100 }, (_, index) => index) }',
      invocation: { symbol: 'values', args: [] },
      expected: /output exceeded/,
    },
  ]
  for (const scenario of scenarios) {
    const target = ownerFixture()
    const owner = createUserBindingsOwner(target.ctx, {
      enabled: true,
      store: fakeStore(),
      cwd: process.cwd(),
      maxOldGenerationSizeMb: 32,
      valueLimits: {},
      ...scenario.options,
    })
    const result = await call(target, 'run', {
      source: scenario.source,
      ...(scenario.invocation === undefined ? {} : { invocation: scenario.invocation }),
    })
    assert.equal(result.ok, false)
    assert.match(result.error.message, scenario.expected)
    await owner.dispose()
  }

  const target = ownerFixture()
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store: fakeStore(),
    cwd: process.cwd(),
    maxWallMs: 1_000,
    maxOutputBytes: 1_024,
    maxOldGenerationSizeMb: 32,
    valueLimits: {},
  })
  const controller = new AbortController()
  controller.abort()
  const cancelled = await call(target, 'run', {
    source: 'await new Promise(() => {}); export const value = 1',
  }, controller.signal)
  assert.equal(cancelled.error.code, 'gateway/cancelled')
  await owner.dispose()
})

test('candidate workers settle non-callable exports and thrown values before natural exit', async t => {
  for (const [source, error] of [
    ['export const value = 1', 'TypeError: candidate export "value" is not callable'],
    ['export function value() { throw "candidate failed" }', 'candidate failed'],
  ]) {
    const worker = new Worker(new URL('../internal/user-binding-runner.js', import.meta.url), {
      workerData: { cwd: process.cwd(), source, invocation: { symbol: 'value', args: [] }, valueLimits: {} },
    })
    t.after(() => worker.terminate())
    const [[message], [exitCode]] = await Promise.all([once(worker, 'message'), once(worker, 'exit')])
    assert.deepEqual(message, { ok: false, error })
    assert.equal(exitCode, 0)
  }
})

test('candidate runner rejects a non-absolute working directory', async t => {
  const worker = new Worker(new URL('../internal/user-binding-runner.js', import.meta.url), {
    workerData: { cwd: 'relative', source: 'export const value = 1' },
  })
  t.after(() => worker.terminate())
  const [[error], exitCode] = await Promise.all([
    once(worker, 'error'), new Promise(resolve => worker.once('exit', resolve)),
  ])
  assert.match(error.message, /absolute cwd/)
  assert.equal(exitCode, 1)
})

test('disabling global bindings stops pending console execution and revokes its environment', async t => {
  const target = ownerFixture()
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true, store: fakeStore(), cwd: process.cwd(), maxWallMs: 2000,
    maxOutputBytes: 8192, maxOldGenerationSizeMb: 64, valueLimits: {},
  })
  t.after(() => owner.dispose())
  const source = 'export const value = 42'
  const first = await call(target, 'console-run', { source, code: 'let retained = value; retained' })
  const environment = first.value.environment
  const pending = call(target, 'console-run', { environment, source, code: 'await new Promise(() => {})' })
  const config = { userBindingsEnabled: false, maxWallMs: 2000, maxOutputBytes: 8192,
    maxOldGenerationSizeMb: 64, maxValueNodes: 100, maxValueEdges: 100,
    maxValueArrayLength: 100, maxValueBigIntDigits: 100 }
  await owner.reconfigure(config)
  assert.equal((await pending).value.environment, null)
  await owner.reconfigure({ ...config, userBindingsEnabled: true })
  const resumed = await call(target, 'console-run', { environment, source, code: 'typeof retained' })
  assert.equal(resumed.value.reset, true)
  assert.equal(resumed.value.output, "'undefined'")
})
