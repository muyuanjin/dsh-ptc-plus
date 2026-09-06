import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { USER_BINDING_DRAFT_META_KEY } from '../internal/user-binding-draft-projection.js'
import { USER_BINDINGS_META_KEY } from '../internal/user-bindings.js'
import { appendRunCodeEvents, fixture, ptcAgent } from './plugin-fixture.js'

const codeOnlyAssembly = state => ({
  sections: [
    { name: 'tools:code-only', text: 'upstream code-only guidance' },
    { name: 'tools:sdk', text: 'declare const tools: unknown' },
  ],
  contexts: [],
  variables: {},
  tools: [state.runCodeDefinition],
})

function document(value) {
  return {
    entries: [{
      id: 'defaults',
      name: 'defaults',
      scope: 'namespace',
      purpose: 'Read the configured default value.',
      enabled: true,
      source: `export const value = ${value}; export function label() { return "private-${value}" }`,
    }],
  }
}

async function writeBindings(home, value) {
  return writeBindingsDocument(home, document(value))
}

async function writeBindingsDocument(home, value) {
  const directory = join(home, 'ptc-plus')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'bindings.json'), `${JSON.stringify(value, null, 2)}\n`)
}

async function rememberRequest(state, session, agent, signal = new AbortController().signal) {
  return state.assembleStep(codeOnlyAssembly(state), {
    agent,
    scope: agent,
    signal,
  })
}

function appendEditCall(events, callId, args) {
  const seq = events.length
  events.push({
    type: 'tool/call',
    seq,
    data: { callId, name: 'edit_run_code', arguments: JSON.stringify(args) },
  })
  return seq
}

function appendEditResult(events, callId, callSeq, result) {
  events.push({
    type: 'tool/result',
    seq: events.length,
    sourceEventSeqs: [callSeq],
    data: { message: { source: { callId } }, meta: result.meta },
  })
}

test('projects only worker-proved declarations and cold-replays the exact recorded binding snapshot', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-recovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  await writeBindings(home, 1)

  const events = []
  const session = { id: 'user-binding-recovery', events }
  const agent = ptcAgent('user-binding-recovery-agent', session)
  const first = fixture({ userBindingsEnabled: true })
  t.after(() => first.dispose())
  const assembly = await rememberRequest(first, session, agent)
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(sdk, /User-global REPL bindings|declare const defaults|private-1/)
  assert.equal(assembly.contexts.some(item => item.name === 'tools:ptc-plus-user-bindings'), false)

  const firstCode = 'const recordedDefault = defaults.value'
  const firstResult = await first.runDurable(session.id, firstCode, {}, { session })
  appendRunCodeEvents(events, 'binding-one', firstCode, firstResult)
  const activatedAssembly = await rememberRequest(first, session, agent)
  const context = activatedAssembly.ptcContexts.find(item => item.name === 'tools:ptc-plus-user-bindings')
  assert.match(context.text, /defaults \(value, label\)/)
  assert.match(context.text, /declare const defaults/)
  assert.doesNotMatch(context.text, /private-1|bindings\.json|validate|persist|remove/)
  assert.equal(firstResult.meta[USER_BINDINGS_META_KEY].entries[0].source, document(1).entries[0].source)
  await first.dispose()

  await writeBindings(home, 2)
  const restored = fixture({ userBindingsEnabled: true })
  t.after(() => restored.dispose())
  await rememberRequest(restored, session, agent)
  const result = await restored.runDurable(
    session.id,
    'return [recordedDefault, defaults.value]',
    {},
    { session },
  )
  assert.deepEqual(result.value, [1, 2])
})

test('does not cold-replay a failed binding initializer that issued a host call', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-failed-binding-call-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const broken = {
    id: 'broken-call',
    name: 'brokenCall',
    scope: 'namespace',
    purpose: '',
    enabled: true,
    source: `
await tools.observe({ value: 1 })
throw new Error('initialization failed')
export const value = 1
`,
  }
  const healthy = {
    id: 'healthy-call-peer',
    name: 'healthyCallPeer',
    scope: 'namespace',
    purpose: '',
    enabled: true,
    source: 'export const value = 2',
  }
  await writeBindingsDocument(home, { entries: [broken, healthy] })

  const events = []
  const session = { id: 'failed-binding-call-recovery', events }
  const agent = ptcAgent('failed-binding-call-agent', session)
  const first = fixture({ userBindingsEnabled: true })
  let dispatches = 0
  await rememberRequest(first, session, agent)
  const source = 'const liveOnly = healthyCallPeer.value + 1; return liveOnly'
  const result = await first.runDurable(session.id, source, {
    observe: async () => { dispatches += 1; return 'observed' },
  }, { session })
  assert.equal(result.value, 3)
  assert.equal(result.meta[JOURNAL_KEY].status, 'volatile')
  appendRunCodeEvents(events, 'failed-binding-call', source, result)
  await first.dispose()

  await writeBindingsDocument(home, { entries: [healthy] })
  const restored = fixture({ userBindingsEnabled: true })
  t.after(() => restored.dispose())
  await rememberRequest(restored, session, ptcAgent('restored-failed-binding-call-agent', session))
  const continued = await restored.runDurable(
    session.id,
    'return [typeof liveOnly, healthyCallPeer.value]',
    { observe: async () => { dispatches += 1; return 'unexpected' } },
    { session },
  )
  assert.deepEqual(continued.value, ['undefined', 2])
  assert.equal(dispatches, 1)
})

test('contracts a malformed recorded binding snapshot instead of guessing from disk', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-malformed-recovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  await writeBindings(home, 1)

  const events = []
  const session = { id: 'user-binding-malformed', events }
  const agent = ptcAgent('user-binding-malformed-agent', session)
  const first = fixture({ userBindingsEnabled: true })
  t.after(() => first.dispose())
  await rememberRequest(first, session, agent)
  const code = 'const shouldNotRecover = defaults.value'
  const result = await first.runDurable(session.id, code, {}, { session })
  const malformed = structuredClone(result)
  malformed.meta[USER_BINDINGS_META_KEY].entries[0].declaration = 'declare const forged: true'
  appendRunCodeEvents(events, 'malformed-binding', code, malformed)
  await first.dispose()

  await writeBindings(home, 2)
  const restored = fixture({ userBindingsEnabled: true })
  t.after(() => restored.dispose())
  await rememberRequest(restored, session, agent)
  const current = await restored.runDurable(
    session.id,
    'return [typeof shouldNotRecover, defaults.value]',
    {},
    { session },
  )
  assert.deepEqual(current.value, ['undefined', 2])
})

test('contracts a durable node when its declared binding snapshot is missing', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-missing-binding-recovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  await writeBindings(home, 1)

  const events = []
  const session = { id: 'user-binding-missing', events }
  const agent = ptcAgent('user-binding-missing-agent', session)
  const first = fixture({ userBindingsEnabled: true })
  await rememberRequest(first, session, agent)
  const code = 'const missingSnapshotValue = defaults.value'
  const result = await first.runDurable(session.id, code, {}, { session })
  assert.match(result.meta[JOURNAL_KEY].userBindingsFingerprint, /^[a-f0-9]{64}$/)
  const missing = structuredClone(result)
  delete missing.meta[USER_BINDINGS_META_KEY]
  appendRunCodeEvents(events, 'missing-binding', code, missing)
  await first.dispose()

  await writeBindings(home, 2)
  const restored = fixture({ userBindingsEnabled: true })
  t.after(() => restored.dispose())
  await rememberRequest(restored, session, ptcAgent('restored-missing-binding-agent', session))
  const current = await restored.runDurable(
    session.id,
    'return [typeof missingSnapshotValue, defaults.value]',
    {},
    { session },
  )
  assert.deepEqual(current.value, ['undefined', 2])
  assert.equal(current.meta.dshPtcPlusRecoveryBoundaries.length, 1)
})

test('cold-replays the binding snapshot used by a derived edit cell', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-edit-binding-recovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  await writeBindings(home, 1)

  const events = []
  const session = { id: 'user-binding-edit-recovery', events }
  const agent = ptcAgent('user-binding-edit-recovery-agent', session)
  const first = fixture({ userBindingsEnabled: true })
  t.after(() => first.dispose())
  const requestSignal = new AbortController().signal
  await rememberRequest(first, session, agent, requestSignal)
  const source = 'let editedBindingValue = 0; return editedBindingValue'
  const setup = await first.runDurable(session.id, source, {}, { session })
  appendRunCodeEvents(events, 'binding-edit-source', source, setup)

  const editArgs = { edits: [{ old_string: '= 0', new_string: '= defaults.value' }] }
  const editCallId = 'binding-edit'
  const editCallSeq = appendEditCall(events, editCallId, editArgs)
  const edited = await first.ctx.tools.execute({
    callId: editCallId,
    name: 'edit_run_code',
    arguments: editArgs,
    agent,
    signal: requestSignal,
  })
  assert.equal(edited.isError, false, JSON.stringify(edited))
  assert.equal(edited.meta[USER_BINDINGS_META_KEY].entries[0].source, document(1).entries[0].source)
  appendEditResult(events, editCallId, editCallSeq, edited)
  await first.dispose()

  await writeBindings(home, 2)
  const restored = fixture({ userBindingsEnabled: true })
  t.after(() => restored.dispose())
  await rememberRequest(restored, session, ptcAgent('restored-binding-edit-agent', session))
  const result = await restored.runDurable(
    session.id,
    'return [editedBindingValue, defaults.value]',
    {},
    { session },
  )
  assert.deepEqual(result.value, [1, 2])
})

test('leaves prompt and runtime context unchanged when the capability is disabled or empty', async (t) => {
  const disabled = fixture({ userBindingsEnabled: false })
  t.after(() => disabled.dispose())
  const session = { id: 'disabled-bindings', events: [] }
  const agent = ptcAgent('disabled-bindings-agent', session)
  const assembly = await rememberRequest(disabled, session, agent)
  assert.doesNotMatch(assembly.sections.find(section => section.name === 'tools:sdk').text, /User-global/)
  assert.equal(assembly.contexts.some(item => item.name === 'tools:ptc-plus-user-bindings'), false)
  const result = await disabled.runDurable(session.id, 'return 1', {}, { session })
  assert.equal(Object.hasOwn(result.meta, USER_BINDING_DRAFT_META_KEY), false)
})
