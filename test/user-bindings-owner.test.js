import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import {
  USER_BINDINGS_RPC_CHANNEL,
  createUserBindingsOwner,
} from '../internal/user-bindings-owner.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

function ownerFixture(handleArity = 2, authoring) {
  let handler
  let handleOptions
  let handleArgumentCount
  let handleDisposals = 0
  let injectionDisposals = 0
  const effects = []
  const rpc = {
    handle: handleArity === 3
      ? function handle(channel, next, options) {
          assert.equal(channel, USER_BINDINGS_RPC_CHANNEL)
          handleArgumentCount = arguments.length
          handler = next
          handleOptions = options
          return async () => { handleDisposals += 1 }
        }
      : function handle(channel, next) {
          assert.equal(channel, USER_BINDINGS_RPC_CHANNEL)
          handleArgumentCount = arguments.length
          handler = next
          handleOptions = arguments[2]
          return async () => { handleDisposals += 1 }
        },
  }
  const ctx = {
    inject(services, callback) {
      if (services.length === 1 && services[0] === 'connection') {
        callback({ connection: { rpc } })
      } else {
        assert.deepEqual(services, ['commands', 'skills'])
        if (authoring !== undefined) callback(authoring)
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
    get handleOptions() { return handleOptions },
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

async function acceptedDraftFixture(store = fakeStore()) {
  let command
  let draftTool
  const agent = {
    id: 'draft-agent',
    session: { id: 'draft-session' },
    inject() {},
    steer() {},
    ctx: {
      effect(register) { return register() },
      commands: {
        register(definition) { command = definition; return () => {} },
      },
      skills: { register() { return () => {} } },
      tools: {
        register(definition) { draftTool = definition; return () => {} },
      },
    },
  }
  const authoring = {
    agents: { list: () => [agent] },
    on() { return () => {} },
  }
  const target = ownerFixture(2, authoring)
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
  const start = async (id) => {
    assert.equal((await command.handler({
      agent, rawInput: `new ${id}`, signal: new AbortController().signal,
    })).kind, 'success')
  }
  const submitEntry = entry => draftTool.execute({ entry })
  const submit = async (id) => {
    await start(id)
    await submitEntry({
      id, name: id, scope: 'namespace', purpose: '', source: 'export const value = 1',
    })
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
    await current.start('candidate')
    await assert.rejects(current.submitEntry(candidate), scenario.expected)
    await assert.rejects(current.submitEntry(candidate), scenario.expected)
    assert.equal(current.owner.draftCapabilityForAgent(current.agent), null)
    await current.owner.dispose()
  }
})

for (const arity of [2, 3]) {
  test(`registers and disposes the authenticated Connection RPC on handle arity ${arity}`, async () => {
    const target = ownerFixture(arity)
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
    assert.equal(target.handleOptions, undefined)
    assert.equal(owner.path, '/profile/ptc-plus/bindings.json')
    assert.equal((await call(target, 'list')).ok, true)
    await owner.dispose()
    assert.equal(target.injectionDisposals, 2)
    assert.equal(target.handleDisposals, 1)
    assert.equal((await call(target, 'list')).ok, false)
    await owner.dispose()
    assert.equal(target.handleDisposals, 1)
  })
}

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
    steer: message => steered.push(message),
    ctx: {
      effect(register) { return register() },
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
    },
  }
  const listeners = new Map()
  const authoring = {
    agents: { list: () => [agent] },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const target = ownerFixture(2, authoring)
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
  assert.equal((await command.handler({
    agent, rawInput: 'new format repository data', signal: new AbortController().signal,
  })).kind, 'success')
  assert.match(skill.name, /^ptc-plus-binding-authoring-/)
  assert.equal(skill.invocation.modelInvocable, false)
  assert.equal(draftTool.name, 'submitBindingDraft')
  assert.match(draftTool.output.render({}, { id: 'repo-data' })[0].text, /repo-data/)
  assert.equal(injected[0].source.kind, 'skill-invocation')
  assert.equal(injected[0].role, 'user')
  assert.notEqual(injected[0].id, steered[0].id)
  assert.deepEqual(steered[0].source, { kind: 'plugin', plugin: 'ptc-plus' })
  assert.match(steered[0].content[0].text, /format repository data/)

  const submitted = await draftTool.execute({ entry: {
    id: 'repo-data',
    name: 'repoData',
    scope: 'namespace',
    purpose: 'Format repository data.',
    source: 'export function format(value: string): string { return value.trim() }',
  } })
  assert.deepEqual(submitted, { accepted: true, id: 'repo-data' })
  const capability = owner.draftCapabilityForAgent(agent)
  const draft = (await call(target, 'draft', { capability })).value
  assert.equal(draft.entry.enabled, false)
  assert.equal(draft.entry.symbols[0], 'format')
  assert.equal(skillDisposals, 1)
  assert.equal(toolDisposals, 1)
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

test('removes an accepted draft when its session presentation is disposed', async (t) => {
  const fixture = await acceptedDraftFixture()
  t.after(() => fixture.owner.dispose())
  const { capability } = await fixture.submit('sessionDraft')
  assert.equal((await call(fixture.target, 'draft', { sessionId: 'draft-session' })).ok, false)
  await fixture.owner.clearSessionPresentation('draft-session')
  assert.equal((await call(fixture.target, 'draft', { capability })).value, null)
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

test('follows live PTC presentation instead of preset labels', async () => {
  const registrations = []
  let disposals = 0
  const agent = {
    id: 'agent-custom',
    session: { id: 'session-custom', header: { agentPreset: 'custom' } },
    ctx: {
      effect(register) { return register() },
      commands: {
        register(definition) {
          registrations.push(definition)
          return async () => { disposals += 1 }
        },
      },
    },
  }
  const authoring = {
    agents: { list: () => [agent] },
    on() { return () => {} },
  }
  const target = ownerFixture(2, authoring)
  const owner = createUserBindingsOwner(target.ctx, {
    enabled: true,
    store: fakeStore(),
    cwd: process.cwd(),
  })
  assert.equal(registrations.length, 0)
  await owner.setAgentPresentation(agent, 'ptc')
  assert.equal(registrations.length, 0)
  await owner.setDraftProjectionAvailable(true)
  assert.equal(registrations.length, 1)
  await owner.setAgentPresentation(agent, 'ptc')
  assert.equal(registrations.length, 1)
  await owner.setAgentPresentation(agent, 'both')
  assert.equal(disposals, 1)
  await owner.setAgentPresentation(agent, 'native')
  assert.equal(disposals, 1)
  await owner.setAgentPresentation(agent, 'ptc')
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
    steer: message => steered.push(message),
    ctx: {
      effect(register) { return register() },
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
    },
  }
  const nativeAgent = {
    ...agent,
    id: 'agent-native',
    session: { id: 'session-native', header: { agentPreset: 'native' } },
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
  const target = ownerFixture(2, authoring)
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

  assert.equal((await command.handler({
    agent, rawInput: 'edit alpha return a configurable value', signal: new AbortController().signal,
  })).kind, 'success')
  assert.match(steered.at(-1).content[0].text, /Original helper/)
  await assert.rejects(draftTool.execute({ entry: {
    ...original, id: 'renamed', enabled: undefined,
  } }), /id must remain/)
  await assert.rejects(draftTool.execute({ entry: {
    id: 'alpha', name: 'occupied', scope: 'namespace', purpose: '', source: 'export const other = 3',
  } }), /conflicts between entries/)
  const acceptedTool = draftTool
  const acceptedSubmission = acceptedTool.execute({ entry: {
    id: 'alpha', name: 'alpha', scope: 'namespace', purpose: 'Revised helper.',
    source: 'export function value(): number { return 3 }',
  } })
  await assert.rejects(acceptedTool.execute({ entry: {
    id: 'alpha', name: 'alpha', scope: 'namespace', purpose: '', source: 'export const value = 4',
  } }), /already processing/)
  assert.deepEqual(await acceptedSubmission, { accepted: true, id: 'alpha' })
  await assert.rejects(acceptedTool.execute({ entry: {
    id: 'alpha', name: 'alpha', scope: 'namespace', purpose: '', source: 'export const value = 4',
  } }), /no longer active/)
  const editCapability = owner.draftCapabilityForAgent(agent)
  const editDraft = (await call(target, 'draft', { capability: editCapability })).value
  assert.equal((await call(target, 'save-draft', {
    capability: editCapability, version: editDraft.version, expectedRevision: 4,
  })).value, 'save')
  assert.equal((await call(target, 'draft', { capability: editCapability })).value, null)
  assert.equal(store.calls.at(-1)[0], 'save')
  assert.equal(store.calls.at(-1)[1].enabled, false)

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

  await command.handler({
    agent, rawInput: 'new another helper', signal: new AbortController().signal,
  })
  await assert.rejects(draftTool.execute({ entry: {
    id: 'occupied', name: 'newName', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }), /already exists/)
  const turnTool = draftTool
  listeners.get('agent/turn-stopping')({ agent })
  await assert.rejects(turnTool.execute({ entry: {
    id: 'turn', name: 'turn', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }), /no longer active/)

  await command.handler({
    agent, rawInput: 'new error cleanup', signal: new AbortController().signal,
  })
  const errorTool = draftTool
  listeners.get('agent/error')({ agent })
  await assert.rejects(errorTool.execute({ entry: {
    id: 'error', name: 'errorBinding', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }), /no longer active/)

  const cancelledCommand = new AbortController()
  await command.handler({
    agent, rawInput: 'new cancelled authoring', signal: cancelledCommand.signal,
  })
  const cancelledTool = draftTool
  cancelledCommand.abort()
  await assert.rejects(cancelledTool.execute({ entry: {
    id: 'cancelled', name: 'cancelledBinding', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }), /no longer active/)

  await command.handler({
    agent, rawInput: 'new disposal cleanup', signal: new AbortController().signal,
  })
  assert.deepEqual(await draftTool.execute({ entry: {
    id: 'disposal', name: 'disposal', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }), { accepted: true, id: 'disposal' })
  const disposalCapability = owner.draftCapabilityForAgent(agent)
  assert.notEqual((await call(target, 'draft', { capability: disposalCapability })).value, null)
  listeners.get('agent/disposed')({ agent })
  assert.equal((await call(target, 'draft', { capability: disposalCapability })).value, null)

  listeners.get('agent/created')({ agent })
  await owner.setAgentPresentation(agent, 'ptc')
  await command.handler({
    agent, rawInput: 'new disabled cleanup', signal: new AbortController().signal,
  })
  await draftTool.execute({ entry: {
    id: 'disabled-draft', name: 'disabledDraft', scope: 'namespace', purpose: '',
    source: 'export const value = 1',
  } })
  const disabledCapability = owner.draftCapabilityForAgent(agent)
  await command.handler({
    agent, rawInput: 'new pending disablement', signal: new AbortController().signal,
  })
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
  await assert.rejects(disabledTool.execute({ entry: {
    id: 'disabled', name: 'disabledBinding', scope: 'namespace', purpose: '', source: 'export const value = 1',
  } }), /no longer active/)
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
  assert.equal(injected.length, 7)
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
    steer() {},
    ctx: {
      effect(register) { return register() },
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
    },
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
  const target = ownerFixture(2, authoring)
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
  assert.equal((await command.handler({
    agent,
    rawInput: 'new delayed candidate',
    signal: new AbortController().signal,
  })).kind, 'success')
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
  } })
  await documentStart
  await owner.reconfigure(runtimeConfig(false))
  releaseDocument()
  await assert.rejects(pendingSubmission, /no longer active/)

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
      if (services[0] === 'connection') {
        if (failMount) throw new Error('connection mount failed')
        callback({ connection: { rpc: { handle(_channel, next) { handler = next; return () => {} } } } })
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
      if (services[0] === 'connection') {
        callback({ connection: { rpc: { handle() { return () => {} } } } })
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
      if (services[0] === 'connection') {
        callback({ connection: { rpc: { handle(_channel, next) { handler = next; return () => {} } } } })
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
      if (services[0] !== 'connection') return () => {}
      callback({ connection: { rpc: {
        handle(_channel, handler) {
          handleCalls += 1
          activeHandlers.add(handler)
          return async () => { activeHandlers.delete(handler) }
        },
      } } })
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

test('reports enablement together with failed partial-mount cleanup', async () => {
  let cleanupFails = true
  const ctx = {
    inject(services, callback) {
      if (services[0] === 'connection') {
        callback({ connection: { rpc: { handle() { return () => {} } } } })
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
      if (services[0] === 'connection') {
        callback({ connection: { rpc: { handle() { return () => {} } } } })
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
    },
  })
  assert.equal(validated.ok, true)
  assert.match(validated.value.declaration, /add\(value: number\)/)
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

test('candidate runner rejects a non-absolute working directory', async () => {
  const worker = new Worker(new URL('../internal/user-binding-runner.js', import.meta.url), {
    workerData: { cwd: 'relative', source: 'export const value = 1' },
  })
  const error = await new Promise(resolve => worker.once('error', resolve))
  assert.match(error.message, /absolute cwd/)
  await worker.terminate()
})
