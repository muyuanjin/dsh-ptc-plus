import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'
import { sessionEvents } from '../internal/session-events.js'

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
  old.append('request/header', {})
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
  appendRunCodeEvents(events, 'valid-call', 'const afterDraft = 42; return afterDraft', result)
  events[1].data.message = createToolResultMessage({ callId: 'valid-call', content: result.content, isError: false })
  const session = Session.create('valid-after-draft', events)
  await persist(session)
  const stored = await load(session.id)
  assert.equal(stored.events.some(event => event.type === 'ptc-plus/user-binding-draft-reset'), false)
  await first.dispose()
  const next = fixture()
  t.after(() => next.dispose())
  const restored = { id: session.id, events: stored.events }
  assert.equal((await next.runDurable(session.id, 'return afterDraft', {}, { session: restored })).value, 42)
})
