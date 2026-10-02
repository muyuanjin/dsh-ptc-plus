import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendRunCodeEvents, fixture, orderedSurfaceSession } from './plugin-fixture.js'
import { recordedSessionEvents as sessionEvents } from './session-observation-fixture.js'
import { createSessionLogProjection, projectSessionLog } from '../internal/session-log-view.js'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { encodeValue } from '../internal/value-wire.js'

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

test('persisted settlement chronology rejects damaged shortcuts and preserves ordinary prune clone ancestry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-checkpoint-chronology-'))
  const ctx = new Context()
  const fibers = []
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  for (const plugin of [SessionStore, SessionProjectionRegistry]) {
    fibers.push(ctx.plugin(plugin))
    await fibers.at(-1).await()
  }
  fibers.push(ctx.plugin(jsonl.JsonlSessionPersistence ?? jsonl.default, { root, compression: 'none' }))
  await fibers.at(-1).await()
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('sessionProjections')
  const projection = createSessionLogProjection()
  const unregister = registry.register(projection)
  t.after(unregister)
  const journal = completion => ({ version: 1, bindingMode: 'loose', status: 'durable',
    calls: [], operations: [], confirms: [], diagnostics: [], completion })
  for (const journaled of [false, true]) {
    const session = Session.create(`persisted-chronology-${journaled}`)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'continue computation' }] }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', requestHeader())
    const appendTool = (callId, name, args, completion) => {
      const argumentsValue = JSON.stringify(args)
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
        id: `assistant-${callId}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'tool-call', id: callId, name, arguments: argumentsValue }],
      } }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: argumentsValue })
      const result = session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: callId }],
          isError: completion?.kind === 'throw' }),
        ...(completion === undefined ? {} : { meta: { [JOURNAL_KEY]: journal(completion) } }),
      }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
      return { call, result }
    }
    const older = appendTool('older', 'run_code', { code: 'let older = 1', description: 'older' },
      journaled ? { kind: 'return', hasValue: true, value: encodeValue(1) } : undefined)
    const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
    const newer = appendTool('newer', 'run_code', { code: 'let newer = 2; throw Error("failed")', description: 'newer' },
      { kind: 'throw', error: { kind: 'Error', message: 'failed' } })
    let source = older.result
    for (let clone = 0; clone < 2; clone += 1) {
      session.append('compaction/prune', {
        shadowedSeqs: [source.seq], shadowedRange: { start: source.seq, end: source.seq },
      })
      source = session.append('tool/result', { ...source.data,
        message: { ...source.data.message, content: [{ type: 'text', text: `pruned-${clone}` }] },
      }, { sourceEventSeqs: [source.seq], surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq } })
    }
    const edit = appendTool('edit', 'edit_run_code', { edits: [{ old_string: 'let', new_string: 'var' }] })
    session.append('step/end', { turn: 1, step: 1 })
    const writer = await persistence.create(session.header)
    if (typeof persistence.open === 'function') {
      try { await writer.append(sessionEvents(session)); await writer.flush() } finally { await writer.close() }
    } else await persistence.append(session.id, sessionEvents(session))
    const reader = typeof persistence.open === 'function' ? await persistence.open(session.id, 'read') : undefined
    let stored
    try { stored = reader === undefined ? await persistence.load(session.id) : await reader.read() }
    finally { await reader?.close() }
    const refolded = registry.restore({}, stored.events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val
    const floor = registry.restoreFloor(checkpoint)
    const intact = registry.restore(checkpoint, stored.events.slice(floor), floor, session.header, 0)
    assert.deepEqual(intact.checkpoint.ptcPlusSessionLog.val, refolded)
    const view = projectSessionLog({ session }, { callId: 'edit', callSeq: edit.call.seq }, refolded)
    assert.deepEqual(view.requestedEditTarget, { callSeq: newer.call.seq, source: 'let newer = 2; throw Error("failed")' })
    assert.equal(view.latestRun.index, newer.result.seq)
    assert.equal(view.lastSuccessfulRunIndex, journaled ? older.result.seq : undefined)
    assert.deepEqual(refolded.timeline.settledResultsByEventSeq[`k${source.seq}`][1],
      refolded.timeline.settledResultsByEventSeq[`k${older.result.seq}`][1])
    const damaged = JSON.parse(JSON.stringify(checkpoint))
    damaged.ptcPlusSessionLog.val.timeline.latestRun.index = 99
    damaged.ptcPlusSessionLog.val.timeline.editableRun.index = 99
    assert.throws(() => registry.restore(damaged, stored.events.slice(floor), floor, session.header, 0), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, older.result.seq)
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const obsolete = JSON.parse(JSON.stringify(damaged))
      obsolete.ptcPlusSessionLog.ver = version
      delete obsolete.ptcPlusSessionLog.val.timeline.runSelectionFrontier
      if (version === 1) for (const [, settlement] of Object.values(obsolete.ptcPlusSessionLog.val.timeline.settledResultsByEventSeq)) {
        delete settlement.publication
      }
      assert.equal(registry.restoreFloor(obsolete), 0)
      assert.throws(() => registry.restore(obsolete, stored.events.slice(floor), floor, session.header, 0),
        /version-mismatched.*re-read from seq 0/)
      assert.deepEqual(registry.restore(obsolete, stored.events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val, refolded)
    }
    for (let cut = 0; cut <= stored.events.length; cut += 1) {
      let value = projection.init()
      for (const event of stored.events.slice(0, cut)) value = projection.apply(value, event)
      value = projection.stateSchema.parse(JSON.parse(JSON.stringify(value)))
      for (const event of stored.events.slice(cut)) value = projection.apply(value, event)
      assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(value))), refolded)
    }
  }
})
