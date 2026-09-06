import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'

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
  fibers.push(ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' }))
  await fibers.at(-1).await()
  const persistence = ctx.get('sessionPersistence')
  const old = Session.create('old-reset')
  await persistence.create(old.header)
  await persistence.ensureMaterialized(old)
  const filename = persistence.locate(old.header).path
  const original = await readFile(filename, 'utf8')
  const damaged = original + JSON.stringify({ type: 'ptc-plus/user-binding-draft-reset', seq: 0, time: 0, data: {} }) + '\n'
  await writeFile(filename, damaged)
  await assert.rejects(persistence.load(old.id), /unknown to this harness and not marked ignorable/)
  assert.equal(await readFile(filename, 'utf8'), damaged)

  const first = fixture()
  t.after(() => first.dispose())
  const result = await first.runDurable('valid-after-draft', 'const afterDraft = 42; return afterDraft')
  const events = []
  appendRunCodeEvents(events, 'valid-call', 'const afterDraft = 42; return afterDraft', result)
  events[1].data.message = createToolResultMessage({ callId: 'valid-call', content: result.content, isError: false })
  const session = Session.create('valid-after-draft', events)
  await persistence.create(session.header)
  await persistence.append(session.id, session.snapshotEvents())
  const stored = await persistence.load(session.id)
  assert.equal(stored.events.some(event => event.type === 'ptc-plus/user-binding-draft-reset'), false)
  await first.dispose()
  const next = fixture()
  t.after(() => next.dispose())
  const restored = { id: session.id, events: stored.events }
  assert.equal((await next.runDurable(session.id, 'return afterDraft', {}, { session: restored })).value, 42)
})
