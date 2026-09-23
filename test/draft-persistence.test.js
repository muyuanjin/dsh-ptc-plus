import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendRunCodeEvents, fixture, orderedSurfaceSession } from './plugin-fixture.js'
import { sessionEvents } from '../internal/session-events.js'

const usesHeaderSnapshots = (() => {
  const session = Session.create('request-header-schema-probe')
  try {
    session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial',
    })
    return true
  } catch {
    return false
  }
})()
const requestHeader = () => usesHeaderSnapshots
  ? { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' }
  : {}

const requiresLifecycleSettlements = (() => {
  try {
    Session.create('assistant-settlement-schema-probe', [{
      type: 'assistant/message', seq: 0, time: 0, surfaceOp: 'append', data: {
        message: {
          id: 'assistant-settlement-schema-probe', role: 'assistant',
          source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [],
        },
      },
    }])
    return false
  } catch {
    return true
  }
})()

function appendPersistenceBaseline(session) {
  if (!requiresLifecycleSettlements) {
    session.append('request/header', requestHeader())
    return
  }
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'probe' }],
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', requestHeader())
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

test('DSH rejects the old unknown reset event while current REPL results persist and replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-draft-persistence-'))
  const ctx = new Context()
  const fibers = []
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  fibers.push(ctx.plugin(SessionStore))
  await fibers.at(-1).await()
  fibers.push(ctx.plugin(jsonl.JsonlSessionPersistence ?? jsonl.default, { root, compression: 'none' }))
  await fibers.at(-1).await()
  const persistence = ctx.get('sessionPersistence')
  const handles = []
  const usesHandles = typeof persistence.open === 'function'
  async function persist(session) {
    const handle = await persistence.create(session.header)
    if (usesHandles) {
      handles.push(handle)
      await handle.append(sessionEvents(session))
      await handle.flush()
      await handle.close()
    } else {
      await persistence.append(session.id, sessionEvents(session))
    }
  }
  async function load(id) {
    if (!usesHandles) return persistence.load(id)
    const handle = await persistence.open(id, 'read')
    handles.push(handle)
    try { return await handle.read() } finally { await handle.close() }
  }
  t.after(async () => { for (const handle of handles) await handle.close() })
  const old = Session.create('old-reset')
  appendPersistenceBaseline(old)
  await persist(old)
  const [relativeFile] = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
  const filename = join(root, relativeFile)
  const original = await readFile(filename, 'utf8')
  const damaged = original + JSON.stringify({ type: 'ptc-plus/user-binding-draft-reset', seq: sessionEvents(old).length, time: 0, data: {} }) + '\n'
  await writeFile(filename, damaged)
  await assert.rejects(load(old.id), /unknown (to this harness|event type)/)
  assert.equal(await readFile(filename, 'utf8'), damaged)

  const first = fixture()
  t.after(() => first.dispose())
  const result = await first.runDurable('valid-after-draft', 'const afterDraft = 42; return afterDraft')
  const events = []
  if (requiresLifecycleSettlements) {
    events.push(
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'run the cell' }],
      }) },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 3, time: 3, data: requestHeader() },
    )
  }
  const eventSeqs = appendRunCodeEvents(events, 'valid-call', 'const afterDraft = 42; return afterDraft', result)
  if (requiresLifecycleSettlements) {
    for (const event of events.slice(4)) Object.assign(event.data, { turn: 1, step: 1 })
    events.find(event => event.seq === eventSeqs.assistantSeq).data.stream = []
    events.push(
      { type: 'step/end', seq: events.length, time: events.length, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: events.length + 1, time: events.length + 1,
        data: { turn: 1, reason: { kind: 'completed' } } },
    )
  }
  events.find(event => event.seq === eventSeqs.resultSeq).data.message = createToolResultMessage({
    callId: 'valid-call', content: result.content, isError: false,
  })
  const session = Session.create('valid-after-draft', events)
  await persist(session)
  const stored = await load(session.id)
  assert.equal(stored.events.some(event => event.type === 'ptc-plus/user-binding-draft-reset'), false)
  await first.dispose()
  const next = fixture()
  t.after(() => next.dispose())
  const restored = orderedSurfaceSession(session.id, [...stored.events])
  assert.equal((await next.runDurable(session.id, 'return afterDraft', {}, { session: restored })).value, 42)
})
