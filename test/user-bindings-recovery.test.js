import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
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

function configuredBindingPrompt(assembly) {
  return renderPrompt({
    ...assembly,
    sections: assembly.sections.filter(item => item.name === 'tools:ptc-plus-user-binding-defaults'),
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

test('advertises configured APIs before activation, keeps the prefix stable and cold-replays recorded bindings', async (t) => {
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
  const defaults = configuredBindingPrompt(assembly)
  assert.match(defaults, /declare const defaults/)
  assert.match(defaults, /does not prove successful activation/)
  assert.doesNotMatch(defaults, /private-1/)

  const firstCode = 'const recordedDefault = defaults.value'
  const firstResult = await first.runDurable(session.id, firstCode, {}, { session })
  appendRunCodeEvents(events, 'binding-one', firstCode, firstResult)
  const activatedAssembly = await rememberRequest(first, session, agent)
  assert.deepEqual(activatedAssembly.sections, assembly.sections)
  assert.equal(renderPrompt(activatedAssembly), renderPrompt(assembly))
  assert.deepEqual(activatedAssembly.tools, assembly.tools)
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

test('new sessions discover opted-in API documentation without evaluating modules during assembly', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-prompt-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const entry = {
    id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text files.', enabled: true,
    source: 'await tools.observe({}); export async function readText(path: string): Promise<string> { return path }',
    modelContext: { includeDeclaration: true, instructions: 'Use fileTools.readText(path) for text.' },
  }
  const hidden = { ...entry, id: 'hidden', name: 'quietTools', source: 'export const value = 2',
    modelContext: { includeDeclaration: false, instructions: '' } }
  const broken = { ...entry, id: 'broken', name: 'brokenTools', source: 'throw new Error("initializer failed"); export const value = 3',
    modelContext: { includeDeclaration: true, instructions: '' } }
  await writeBindingsDocument(home, { entries: [entry, hidden, broken, { ...entry, id: 'disabled', name: 'disabledTools',
    enabled: false, modelContext: {} }] })
  const state = fixture({ userBindingsEnabled: true })
  t.after(() => state.dispose())
  const session = { id: 'new-session-docs', events: [] }
  const agent = ptcAgent(session.id, session)
  let initializations = 0
  const assembly = await rememberRequest(state, session, agent)
  const prompt = configuredBindingPrompt(assembly)
  assert.match(prompt, /Use fileTools.readText\(path\)/)
  assert.match(prompt, /readText\(path: string\): Promise<string>/)
  assert.match(prompt, /brokenTools/)
  assert.doesNotMatch(prompt, /quietTools|Hidden instructions|disabledTools|tools.observe|initializer failed/)
  assert.equal(initializations, 0)
  const code = 'return [await fileTools.readText("example.txt"), quietTools.value]'
  const result = await state.runDurable(session.id, code, { observe: async () => { initializations++; return null } }, { session })
  assert.deepEqual(result.value, ['example.txt', 2])
  assert.equal(initializations, 1)
  appendRunCodeEvents(session.events, 'first-use', code, result)
  const after = await rememberRequest(state, session, agent)
  assert.deepEqual(after.sections, assembly.sections)
  assert.equal(renderPrompt(after), renderPrompt(assembly))
  const active = after.ptcContexts.find(item => item.name === 'tools:ptc-plus-user-bindings').text
  assert.match(active, /Read text/)
  assert.doesNotMatch(active, /brokenTools|quietTools/)
  await state.dispose()

  await writeBindingsDocument(home, { entries: [{ ...entry, modelContext: { includeDeclaration: false, instructions: '' } }] })
  const next = fixture({ userBindingsEnabled: true })
  t.after(() => next.dispose())
  const nextSession = { id: 'no-injection', events: [] }
  const nextAgent = ptcAgent(nextSession.id, nextSession)
  const withoutInjection = await rememberRequest(next, nextSession, nextAgent)
  assert.equal(withoutInjection.sections.some(item => item.name === 'tools:ptc-plus-user-binding-defaults'), false)
  assert.doesNotMatch(JSON.stringify(withoutInjection.sections), /fileTools/)
})

test('binding prompts and declarations remain literal through the host prompt renderer', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-literal-prompt-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const instructions = 'Render {{name}} literally; keep {{known}}, {{not valid}}, {{{nested}}}, and {{ptc_plus_user_binding_defaults}}.'
  const purpose = 'Accept {{path}} and {{known}} literally.'
  await writeBindingsDocument(home, { entries: [{
    ...document(1).entries[0], purpose, modelContext: { instructions },
    source: 'export function render(value: "{{input}}" | "{{known}}") { return value }',
  }] })
  const state = fixture({ userBindingsEnabled: true })
  t.after(() => state.dispose())
  const session = { id: 'literal-binding-prompt', events: [] }
  const input = codeOnlyAssembly(state)
  input.sections.push({ name: 'host-template', text: 'Host {{known}}.' })
  input.variables.known = 'expanded'
  const assembly = await state.assembleStep(input, { agent: ptcAgent(session.id, session) })
  const rendered = renderPrompt(assembly)
  assert.ok(rendered.includes(instructions))
  assert.ok(rendered.includes(purpose))
  assert.ok(rendered.includes('value: "{{input}}" | "{{known}}"'))
  assert.ok(rendered.includes('Host expanded.'))
  assert.equal(input.variables.known, 'expanded')
  assert.deepEqual(Object.keys(input.variables), ['known'])
})

test('model-context updates preserve live module state and recorded-value cold recovery', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-binding-context-recovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const entry = {
    id: 'counter', name: 'counter', enabled: true, scope: 'namespace',
    source: 'await tools.observe({}); let count = 0; export function next() { return ++count }',
  }
  const session = { id: 'binding-context-recovery', events: [] }
  const agent = ptcAgent(session.id, session)
  let initializations = 0
  const functions = { observe: async () => { initializations++; return 'initialized' } }
  let rpc
  const first = fixture({ userBindingsEnabled: true }, { bindingRpc: handler => { rpc = handler } })
  t.after(() => first.dispose())
  await writeBindingsDocument(home, { entries: [entry] })
  const code = 'return counter.next()'
  const fingerprints = new Set()
  for (const [index, modelContext] of [undefined, undefined,
    { includeDeclaration: true, instructions: 'Use counter.next() for the next count.' },
    { includeDeclaration: false, instructions: 'Keep the current count.' }].entries()) {
    const catalog = await rpc('list', {}, new AbortController().signal)
    assert.equal(catalog.ok, true)
    const saved = await rpc('save', {
      entry: { ...entry, ...(modelContext === undefined ? {} : { modelContext }) },
      expectedRevision: catalog.value.revision,
    }, new AbortController().signal)
    assert.equal(saved.ok, true)
    const assembly = await rememberRequest(first, session, agent)
    if (modelContext !== undefined) assert.ok(renderPrompt(assembly).includes(modelContext.instructions))
    const result = await first.runDurable(session.id, code, functions, { session })
    assert.equal(result.value, index + 1)
    assert.equal(initializations, 1)
    assert.equal(result.meta[JOURNAL_KEY].status, 'durable')
    assert.equal(result.meta[JOURNAL_KEY].calls.length, index === 0 ? 1 : 0)
    assert.deepEqual(result.meta[USER_BINDINGS_META_KEY].entries[0].modelContext, modelContext)
    fingerprints.add(result.meta[USER_BINDINGS_META_KEY].entries[0].fingerprint)
    appendRunCodeEvents(session.events, `counter-${index}`, code, result)
  }
  assert.equal(fingerprints.size, 3)
  await first.dispose()
  const restored = fixture({ userBindingsEnabled: true })
  t.after(() => restored.dispose())
  await rememberRequest(restored, session, agent)
  const result = await restored.runDurable(session.id, code, functions, { session })
  assert.equal(result.value, 5)
  assert.equal(initializations, 1)
  assert.equal(result.meta[JOURNAL_KEY].status, 'durable')
})

test('replays captured version 5 module resets before continuing with current reuse semantics', async t => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/user-binding-reuse-v5.json', import.meta.url), 'utf8'))
  for (const scenario of captured.cases) await t.test(scenario.name, async t => {
    const home = await mkdtemp(join(tmpdir(), 'ptc-plus-legacy-binding-reuse-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    t.after(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    const session = { id: scenario.name, events: [] }
    const agent = ptcAgent(session.id, session)
    for (const [index, record] of scenario.records.entries()) {
      assert.equal(record.journal.version, 5)
      assert.deepEqual(record.journal.completion, { kind: 'return', hasValue: false })
      appendRunCodeEvents(session.events, `legacy-${index}`, record.code, { meta: {
        [JOURNAL_KEY]: record.journal,
        [USER_BINDINGS_META_KEY]: record.userBindings,
      } })
    }
    assert.equal(scenario.records.reduce((total, record) => total + record.journal.calls.length, 0), scenario.initializations)
    const { id, name, scope, symbols, purpose, enabled, source } = scenario.records.at(-1).userBindings.entries[0]
    const entry = { id, name, scope, symbols, purpose, enabled, source }
    let dispatches = 0
    for (let generation = 0; generation < 3; generation++) {
      await writeBindingsDocument(home, { entries: [{
        ...entry, purpose: `Current documentation ${generation}.`,
        modelContext: { includeDeclaration: generation % 2 === 0, instructions: `Current prompt ${generation}.` },
      }] })
      const state = fixture({ userBindingsEnabled: true })
      t.after(() => state.dispose())
      await rememberRequest(state, session, agent)
      const current = await state.runDurable(session.id, scenario.probe, {
        observe: async () => { dispatches++; return null },
      }, { session })
      assert.equal(current.error, undefined)
      assert.deepEqual(current.value, scenario.expected.map((value, index) => value + (index === 2 ? generation : 0)))
      assert.deepEqual(current.meta[JOURNAL_KEY].diagnostics, [])
      assert.equal(dispatches, 0)
      assert.equal(current.meta[JOURNAL_KEY].version, 6)
      assert.equal(current.meta[JOURNAL_KEY].userBindingsReusePolicy, 'implementation-v1')
      appendRunCodeEvents(session.events, `current-${generation}`, scenario.probe, current)
      await state.dispose()
    }
  })
})

test('contracts missing or unknown reuse policies once and executes the current cell', async t => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/user-binding-reuse-v5.json', import.meta.url), 'utf8'))
  for (const policy of [undefined, 'implementation-v2']) await t.test(String(policy), async t => {
    const home = await mkdtemp(join(tmpdir(), 'ptc-plus-invalid-reuse-policy-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    t.after(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    const records = structuredClone(captured.cases[0].records)
    records[1].journal.version = 6
    if (policy !== undefined) records[1].journal.userBindingsReusePolicy = policy
    const session = { id: `invalid-policy-${policy}`, events: [] }
    const agent = ptcAgent(session.id, session)
    for (const [index, record] of records.entries()) {
      appendRunCodeEvents(session.events, `legacy-${index}`, record.code, { meta: {
        [JOURNAL_KEY]: record.journal, [USER_BINDINGS_META_KEY]: record.userBindings,
      } })
    }
    const { id, name, scope, symbols, purpose, enabled, source } = records[1].userBindings.entries[0]
    await writeBindingsDocument(home, { entries: [{ id, name, scope, symbols, purpose, enabled, source }] })
    for (let generation = 0; generation < 2; generation++) {
      const state = fixture({ userBindingsEnabled: true })
      t.after(() => state.dispose())
      await rememberRequest(state, session, agent)
      const code = 'return [earlier, typeof later, counter.next()]'
      const current = await state.runDurable(session.id, code, {}, { session })
      assert.equal(current.error, undefined)
      assert.deepEqual(current.value, [1, 'undefined', generation + 2])
      assert.equal(current.meta[JOURNAL_KEY].status, 'durable')
      assert.equal(current.meta[JOURNAL_KEY].diagnostics.filter(item => item.code === 'PTC-R002').length, generation === 0 ? 1 : 0)
      appendRunCodeEvents(session.events, `current-${generation}`, code, current)
      await state.dispose()
    }
  })
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

test('contracts a self-consistent historical snapshot with an invalid identifier and continues once', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-identifier-recovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  await writeBindings(home, 1)
  const events = []
  const session = { id: 'identifier-recovery', events }
  const agent = ptcAgent('identifier-recovery-agent', session)
  const first = fixture({ userBindingsEnabled: true })
  t.after(() => first.dispose())
  await rememberRequest(first, session, agent)
  const source = 'const historical = defaults.value; return historical'
  const result = structuredClone(await first.runDurable(session.id, source, {}, { session }))
  const snapshot = result.meta[USER_BINDINGS_META_KEY]
  const entry = snapshot.entries[0]
  entry.name = 'defaults '
  entry.declaration = entry.declaration.replace('declare const defaults:', 'declare const defaults :')
  entry.bindings[0] = { ...entry.bindings[0], name: entry.name, declaration: entry.declaration }
  // Recreate the exact wire accepted by a parser that only validates its enclosing declaration.
  const stored = Object.fromEntries(['id', 'name', 'scope', 'symbols', 'purpose', 'enabled', 'source']
    .map(key => [key, entry[key]]))
  entry.fingerprint = createHash('sha256').update(JSON.stringify(stored)).digest('hex')
  snapshot.fingerprint = createHash('sha256')
    .update(JSON.stringify({ revision: snapshot.revision, entries: [entry.fingerprint] })).digest('hex')
  result.meta[JOURNAL_KEY].userBindingsFingerprint = snapshot.fingerprint
  appendRunCodeEvents(events, 'invalid-identifier', source, result)
  await first.dispose()

  await writeBindings(home, 2)
  const restored = fixture({ userBindingsEnabled: true })
  t.after(() => restored.dispose())
  await rememberRequest(restored, session, agent)
  const currentSource = 'let current = defaults.value; return [typeof historical, current]'
  const current = await restored.runDurable(session.id, currentSource, {}, { session })
  assert.deepEqual(current.value, ['undefined', 2])
  assert.equal(current.meta.dshPtcPlusRecoveryBoundaries.length, 1)
  appendRunCodeEvents(events, 'continued-identifier', currentSource, current)
  const next = await restored.runDurable(session.id, 'return current + 1', {}, { session })
  assert.equal(next.value, 3)
  assert.equal(next.meta.dshPtcPlusRecoveryBoundaries, undefined)
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
  assert.equal(assembly.sections.some(item => item.name === 'tools:ptc-plus-user-binding-defaults'), false)
  assert.doesNotMatch(assembly.sections.find(section => section.name === 'tools:sdk').text, /User-global/)
  assert.equal(assembly.contexts.some(item => item.name === 'tools:ptc-plus-user-bindings'), false)
  const result = await disabled.runDurable(session.id, 'return 1', {}, { session })
  assert.equal(Object.hasOwn(result.meta, USER_BINDING_DRAFT_META_KEY), false)
})
