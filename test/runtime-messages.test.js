import { isPtcMessageSource } from '../internal/message-sources.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { bindingActionNotice, readBindingAction } from '../internal/user-binding-draft-projection.js'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { encodeValue } from '../internal/value-wire.js'
import { auditRuntimeContexts, isRuntimeContextSource } from '../scripts/acceptance-contract.mjs'
import { createRuntimeMessageOwner, projectRuntimeMessages, sessionRuntimeContexts } from '../internal/runtime-contexts.js'
import { latestRecoveryTip } from '../internal/recovery-tips.js'
import { createUserBindingsSnapshot, userBindingsConfiguredContext } from '../internal/user-bindings.js'
import { createSessionLogOwner, createSessionLogProjection, projectSessionLog, runtimeMessageFacts, systemPromptSnapshotSections } from '../internal/session-log-view.js'
import {
  PTC_BINDING_CATALOG, PTC_DELIVERY_CONTEXT, PTC_STATE_NAMES, readRuntimeMessage, recoveryTipIdentity,
  runtimeBindingCatalogMessage, runtimeNoticeMessage, runtimeStateMessage,
} from '../internal/runtime-messages.js'

const state = text => [{ name: PTC_STATE_NAMES[0], text }]
const tip = ordinal => ({ name: `tools:ptc-plus-tip/platform-command-failure/${ordinal}`, text: 'Inspect the current executable.' })
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const logRegistry = new SessionProjectionRegistry(new Context())
logRegistry.register(createSessionLogProjection())
const sessionEvents = session => session.snapshotEvents()
const viewOf = session => Array.isArray(session?.events) ? projectSessionLog({ session })
  : projectSessionLog({ session }, undefined, logRegistry.stateOf(session, 'ptcPlusSessionLog'))
const viewForAgent = agent => viewOf(agent.session)
const append = (session, message) => session.append('user/message', message, { surfaceOp: 'append' })

const usesSequenceReplacement = (() => {
  const session = Session.create('surface-replacement-schema-probe')
  const first = append(session, user('probe'))
  try {
    session.append('user/message', user('replacement'), {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
      sourceEventSeqs: [first.seq],
    })
    return true
  } catch {
    return false
  }
})()
const replaceSurface = (start, end) => ({
  op: 'replace',
  ...(usesSequenceReplacement ? { startSeq: start, endSeq: end } : { start, end }),
})

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

test('host-only log facts survive public checkpoint restore and session forks', async t => {
  const ctx = new Context()
  const fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  for (const plugin of [SessionStore, SessionProjectionRegistry, SessionQueryEngine]) {
    const fiber = ctx.plugin(plugin)
    fibers.push(fiber)
    await fiber.await()
  }
  let owner
  const feature = ctx.plugin({ apply(scope) { owner = createSessionLogOwner(scope) } })
  fibers.push(feature)
  await feature.await()
  const parent = ctx.sessions.create('log-projection-parent')
  const first = append(parent, runtimeStateMessage(state('first')))
  append(parent, runtimeNoticeMessage(tip(1)))
  const checkpoint = JSON.parse(JSON.stringify(ctx.sessionProjections.checkpoint(parent)))
  assert.deepEqual(ctx.sessionProjections.snapshot(parent).values, {})
  append(parent, runtimeStateMessage(state('second')))
  parent.append('user/message', user('replace only the first snapshot'), {
    surfaceOp: replaceSurface(first.seq, first.seq), sourceEventSeqs: [first.seq],
  })
  const observation = await owner.read(parent)
  assert.deepEqual(observation.surface.nodes, parent.surface.nodes)
  const floor = ctx.sessionProjections.restoreFloor(checkpoint)
  const restored = ctx.sessionProjections.restore(checkpoint, observation.events.slice(floor), floor, parent.header, 0)
  const restoredView = projectSessionLog({ session: parent }, undefined, restored.checkpoint.ptcPlusSessionLog.val)
  assert.deepEqual(restoredView, owner.project({ session: parent }))
  assert.equal(restoredView.visibleRuntimeFacts.snapshot.sections[0].text, 'second')
  const child = ctx.sessions.fork(parent, undefined, 'log-projection-child')
  assert.deepEqual(owner.project({ session: child }), owner.project({ session: parent }))
  append(child, runtimeStateMessage(state('child only')))
  assert.equal(owner.project({ session: parent }).visibleRuntimeFacts.snapshot.sections[0].text, 'second')
  assert.equal(owner.project({ session: child }).visibleRuntimeFacts.snapshot.sections[0].text, 'child only')
})

test('long unrelated histories leave projection state unchanged and presentation never reads the raw log', () => {
  const projection = createSessionLogProjection()
  let checkpoint = projection.init()
  checkpoint = projection.apply(checkpoint, { seq: 0, type: 'user/message',
    data: runtimeNoticeMessage(tip(1)), surfaceOp: 'append' })
  for (let seq = 1; seq <= 10_000; seq += 1) {
    assert.equal(projection.apply(checkpoint, { seq, type: 'tool/ptc-dispatch', data: {} }), checkpoint)
  }
  const session = { get events() { throw new Error('raw log read during presentation') },
    get surface() { throw new Error('live surface read during presentation') } }
  const view = projectSessionLog({ session }, undefined, checkpoint)
  assert.equal(view.runtimeHistory.tips['platform-command-failure'].highestOrdinal, 1)
  assert.deepEqual(projectRuntimeMessages(view, [tip(1)]), [])
  const legacy = projectSessionLog({ session: { events: [
    { seq: 0, type: 'user/message', data: runtimeStateMessage(state('legacy')) },
    { seq: 1, type: 'user/message', data: user('ordinary') },
  ], surface: { nodes: [0, 1] } } })
  assert.equal(legacy.visibleRuntimeMessages.length, 1)
  assert.deepEqual(projectRuntimeMessages(legacy, state('legacy')), [])
})

test('projection checkpoints reject malformed tables and inconsistent derived facts', () => {
  const projection = createSessionLogProjection()
  let checkpoint = projection.init()
  checkpoint = projection.apply(checkpoint, { seq: 0, type: 'user/message',
    data: runtimeStateMessage(state('retained')), surfaceOp: 'append' })
  checkpoint = projection.apply(checkpoint, { seq: 1, type: 'user/message',
    data: runtimeNoticeMessage(tip(1)), surfaceOp: 'append' })
  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(checkpoint))), checkpoint)
  for (const mutate of [
    value => { value.timeline.results = [] },
    value => { value.timeline.results.k0 = [1, null] },
    value => { value.timeline.results.k0 = {} },
    value => { value.visibleRuntimeMessages = [] },
    value => { value.visibleRuntimeFacts = {} },
    value => { value.runtimeHistory.tips['platform-command-failure'].highestOrdinal = 99 },
    value => { value.runtimeHistory.seenNames = {} },
    value => { value.surfaceNodes = [0, 0] },
    value => { value.contextStep = -1 },
  ]) {
    const damaged = JSON.parse(JSON.stringify(checkpoint))
    mutate(damaged)
    assert.throws(() => projection.stateSchema.parse(damaged), /PTC session-log projection/)
  }
  const invisible = projection.apply(checkpoint, { seq: 2, type: 'user/message', data: user('summary'),
    surfaceOp: replaceSurface(0, 1) })
  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(invisible))), invisible)
})

test('public restore rejects malformed nested timeline evidence before advancing a valid suffix', () => {
  const registry = new SessionProjectionRegistry(new Context())
  registry.register(createSessionLogProjection())
  const session = Session.create('typed-checkpoint-admission')
  append(session, runtimeStateMessage(state('checkpoint')))
  const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  checkpoint.ptcPlusSessionLog.val.timeline.executableCalls.k1 = [1, {}]
  session.append('tool/call', { callId: 'current', name: 'run_code', arguments: '{"code":"return 42"}' })
  const floor = registry.restoreFloor(checkpoint)
  assert.throws(() => registry.restore(checkpoint, sessionEvents(session).slice(floor), floor, session.header, 0),
    /PTC session-log projection timeline checkpoint/)
  assert.equal(checkpoint.ptcPlusSessionLog.seq, 0)
  const refolded = registry.restore({}, sessionEvents(session), 0, session.header, 0)
  assert.equal(refolded.checkpoint.ptcPlusSessionLog.seq, 1)
  assert.equal(refolded.checkpoint.ptcPlusSessionLog.val.timeline.calls[0].data.callId, 'current')
  assert.deepEqual(refolded.checkpoint.ptcPlusSessionLog.val, registry.stateOf(session, 'ptcPlusSessionLog'))
})

test('public restore rejects self-certified run chronology and refolds the newer failed edit target', () => {
  const registry = new SessionProjectionRegistry(new Context())
  const projection = createSessionLogProjection()
  registry.register(projection)
  const session = Session.create('checkpoint-chronology-admission')
  const journal = completion => ({ version: 1, bindingMode: 'loose', status: 'durable',
    calls: [], operations: [], confirms: [], diagnostics: [], completion })
  const call = (callId, code) => session.append('tool/call', {
    turn: 1, step: 1, name: 'run_code', callId, arguments: JSON.stringify({ code, description: 'probe' }),
  })
  const result = (source, completion) => session.append('tool/result', {
    turn: 1, step: 1, message: { source: { kind: 'tool', callId: source.data.callId }, content: [] },
    meta: { [JOURNAL_KEY]: journal(completion) },
  }, { sourceEventSeqs: [source.seq], surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  result(call('older', 'let older = 1'), { kind: 'return', hasValue: true, value: encodeValue(1) })
  const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  result(call('newer', 'let newer = 2; throw Error("failed")'), {
    kind: 'throw', error: { kind: 'Error', message: 'failed' },
  })
  const newerCheckpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const edit = session.append('tool/call', { turn: 1, step: 1, name: 'edit_run_code', callId: 'edit',
    arguments: JSON.stringify({ edits: [{ old_string: 'let', new_string: 'var' }] }),
  })
  const floor = registry.restoreFloor(checkpoint)
  const events = sessionEvents(session)
  const intact = registry.restore(checkpoint, events.slice(floor), floor, session.header, 0)
  assert.equal(projectSessionLog({ session }, { callId: 'edit', callSeq: edit.seq },
    intact.checkpoint.ptcPlusSessionLog.val).requestedEditTarget.callSeq, 3)
  for (const mutate of [
    value => { value.timeline.latestRun.index = 99; value.timeline.editableRun.index = 99 },
    value => { value.timeline.lastSuccessfulRunIndex = 99 },
    value => {
      value.timeline.runSelectionFrontier.index = 99
      delete value.timeline.latestRun
      delete value.timeline.editableRun
    },
  ]) {
    const damaged = JSON.parse(JSON.stringify(checkpoint))
    mutate(damaged.ptcPlusSessionLog.val)
    assert.throws(() => registry.restore(damaged, events.slice(floor), floor, session.header, 0), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, 2)
    const refolded = registry.restore({}, events, 0, session.header, 0)
    assert.equal(refolded.checkpoint.ptcPlusSessionLog.seq, edit.seq)
    assert.deepEqual(refolded.checkpoint.ptcPlusSessionLog.val, registry.stateOf(session, 'ptcPlusSessionLog'))
    assert.deepEqual(projectSessionLog({ session }, { callId: 'edit', callSeq: edit.seq },
      refolded.checkpoint.ptcPlusSessionLog.val).requestedEditTarget,
    { callSeq: 3, source: 'let newer = 2; throw Error("failed")' })
  }
  for (const mutate of [
    value => {
      value.timeline.latestRun = checkpoint.ptcPlusSessionLog.val.timeline.latestRun
      value.timeline.editableRun = checkpoint.ptcPlusSessionLog.val.timeline.editableRun
    },
    value => { delete value.timeline.latestRun; delete value.timeline.editableRun },
  ]) {
    const damaged = JSON.parse(JSON.stringify(newerCheckpoint))
    mutate(damaged.ptcPlusSessionLog.val)
    const newerFloor = registry.restoreFloor(damaged)
    assert.throws(() => registry.restore(damaged, events.slice(newerFloor), newerFloor, session.header, 0), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, 4)
    const refolded = registry.restore({}, events, 0, session.header, 0)
    assert.deepEqual(projectSessionLog({ session }, { callId: 'edit', callSeq: edit.seq },
      refolded.checkpoint.ptcPlusSessionLog.val).requestedEditTarget,
    { callSeq: 3, source: 'let newer = 2; throw Error("failed")' })
  }
})

test('checkpoint edit target source and dispatch eligibility derive from retained publications', () => {
  const registry = new SessionProjectionRegistry(new Context())
  const projection = createSessionLogProjection()
  registry.register(projection)
  const session = Session.create('checkpoint-edit-source-admission')
  session.append('turn/start', { turn: 1 })
  const run = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'run',
    arguments: JSON.stringify({ code: 'let value = 1', description: 'probe' }) })
  session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'run' }, content: [] } },
  { sourceEventSeqs: [run.seq], surfaceOp: 'append' })
  const edit = session.append('tool/call', { turn: 1, step: 1, name: 'edit_run_code', callId: 'edit',
    arguments: JSON.stringify({ edits: [{ old_string: '1', new_string: '2' }] }) })
  const events = sessionEvents(session)
  const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const floor = registry.restoreFloor(checkpoint)
  const restore = value => registry.restore(value, events.slice(floor), floor, session.header, 0)
  assert.deepEqual(projectSessionLog({ session }, { callId: 'edit', callSeq: edit.seq },
    restore(checkpoint).checkpoint.ptcPlusSessionLog.val).requestedEditTarget,
  { callSeq: run.seq, source: 'let value = 1' })
  for (const replacement of [{ callSeq: run.seq, source: 'let unrelated = 9000' }, null]) {
    const damaged = JSON.parse(JSON.stringify(checkpoint))
    const timeline = damaged.ptcPlusSessionLog.val.timeline
    timeline.editTargets[`k${edit.seq}`][1] = replacement
    if (replacement === null) {
      delete timeline.executableCalls[`k${edit.seq}`][1].editTarget
      delete timeline.pendingByCallId.kedit[1].editTarget
    } else {
      timeline.executableCalls[`k${edit.seq}`][1].editTarget = { ...replacement }
      timeline.pendingByCallId.kedit[1].editTarget = { ...replacement }
    }
    assert.throws(() => restore(damaged), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, edit.seq)
    assert.deepEqual(registry.restore({}, events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val,
      registry.stateOf(session, 'ptcPlusSessionLog'))
  }
})

test('public checkpoint restore derives persistent edit claims from dispatch and settlement facts', () => {
  const registry = new SessionProjectionRegistry(new Context())
  registry.register(createSessionLogProjection())
  const session = Session.create('checkpoint-claim-admission')
  session.append('turn/start', { turn: 1 })
  const run = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'run',
    arguments: JSON.stringify({ code: 'let value = 1', description: 'probe' }) })
  session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'run' }, content: [] } },
  { sourceEventSeqs: [run.seq], surfaceOp: 'append' })
  const unclaimed = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const edit = session.append('tool/call', { turn: 1, step: 1, name: 'edit_run_code', callId: 'edit',
    arguments: JSON.stringify({ edits: [{ old_string: '1', new_string: '2' }] }) })
  const claimed = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const concurrent = session.append('tool/call', { turn: 1, step: 1, name: 'edit_run_code', callId: 'concurrent',
    arguments: JSON.stringify({ edits: [{ old_string: '1', new_string: '3' }] }) })
  const events = sessionEvents(session)
  const target = value => projectSessionLog({ session }, { callId: 'edit', callSeq: edit.seq }, value).requestedEditTarget
  for (const [checkpoint, mutate] of [
    [unclaimed, timeline => { timeline.claimedEditTargets[`k${run.seq}`] = [run.seq, true] }],
    [claimed, timeline => { delete timeline.editClaims[`k${edit.seq}`] }],
    [claimed, timeline => { delete timeline.editClaims[`k${edit.seq}`]; delete timeline.claimedEditTargets[`k${run.seq}`] }],
    [claimed, timeline => {
      delete timeline.editClaims[`k${edit.seq}`]
      delete timeline.claimedEditTargets[`k${run.seq}`]
      timeline.claimedEditTargets[`k${edit.seq}`] = [edit.seq, true]
    }],
  ]) {
    const floor = registry.restoreFloor(checkpoint)
    const honest = registry.restore(checkpoint, events.slice(floor), floor, session.header, 0)
    assert.deepEqual(target(honest.checkpoint.ptcPlusSessionLog.val), { callSeq: run.seq, source: 'let value = 1' })
    assert.equal(projectSessionLog({ session }, { callId: 'concurrent', callSeq: concurrent.seq },
      honest.checkpoint.ptcPlusSessionLog.val).requestedEditTarget, undefined)
    const damaged = JSON.parse(JSON.stringify(checkpoint))
    mutate(damaged.ptcPlusSessionLog.val.timeline)
    assert.throws(() => registry.restore(damaged, events.slice(floor), floor, session.header, 0), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, checkpoint.ptcPlusSessionLog.seq)
    const refolded = registry.restore({}, events, 0, session.header, 0)
    assert.deepEqual(refolded.checkpoint.ptcPlusSessionLog.val, registry.stateOf(session, 'ptcPlusSessionLog'))
    assert.deepEqual(target(refolded.checkpoint.ptcPlusSessionLog.val), { callSeq: run.seq, source: 'let value = 1' })
  }
})

test('public checkpoint restore proves ordinary result deduplication before admitting a suffix', () => {
  const registry = new SessionProjectionRegistry(new Context())
  registry.register(createSessionLogProjection())
  const session = Session.create('checkpoint-result-observation-admission')
  const run = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'run',
    arguments: JSON.stringify({ code: 'let value = 1', description: 'probe' }) })
  const pending = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const result = () => session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'run' }, content: [] },
    meta: { [JOURNAL_KEY]: { version: 1, bindingMode: 'loose', status: 'durable',
      calls: [], operations: [], confirms: [], diagnostics: [], completion: { kind: 'return', hasValue: false } } } },
  { sourceEventSeqs: [run.seq], surfaceOp: 'append' })
  result()
  const settled = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const events = sessionEvents(session)
  const floor = registry.restoreFloor(pending)
  assert.equal(registry.restore(pending, events.slice(floor), floor, session.header, 0)
    .checkpoint.ptcPlusSessionLog.val.timeline.latestRun.callSeq, run.seq)
  const retainedCall = pending.ptcPlusSessionLog.val.timeline.executableCalls[`k${run.seq}`][1].event
  for (const replacement of [true, { eventSeq: run.seq, eventIndex: run.seq, call: retainedCall }]) {
    const damaged = JSON.parse(JSON.stringify(pending))
    damaged.ptcPlusSessionLog.val.timeline.ordinaryResultSeqs[`k${run.seq}`] = [run.seq, replacement]
    assert.throws(() => registry.restore(damaged, events.slice(floor), floor, session.header, 0), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, pending.ptcPlusSessionLog.seq)
    assert.deepEqual(registry.restore({}, events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val,
      registry.stateOf(session, 'ptcPlusSessionLog'))
  }
  result()
  const duplicateEvents = sessionEvents(session)
  const duplicateFloor = registry.restoreFloor(settled)
  const honest = registry.restore(settled, duplicateEvents.slice(duplicateFloor), duplicateFloor, session.header, 0)
  assert.equal(honest.checkpoint.ptcPlusSessionLog.val.timeline.latestRun, undefined)
  assert.equal(honest.checkpoint.ptcPlusSessionLog.val.timeline.runSelectionFrontier.reason, 'duplicate-result')
  const damaged = JSON.parse(JSON.stringify(settled))
  delete damaged.ptcPlusSessionLog.val.timeline.ordinaryResultSeqs[`k${run.seq}`]
  assert.throws(() => registry.restore(damaged, duplicateEvents.slice(duplicateFloor), duplicateFloor, session.header, 0), /timeline checkpoint/)
  assert.equal(damaged.ptcPlusSessionLog.seq, settled.ptcPlusSessionLog.seq)
  assert.deepEqual(registry.restore({}, duplicateEvents, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val,
    registry.stateOf(session, 'ptcPlusSessionLog'))
})

test('public checkpoint restore proves pending identities and genuine ambiguity from correlation inputs', () => {
  const registry = new SessionProjectionRegistry(new Context())
  registry.register(createSessionLogProjection())
  const session = Session.create('checkpoint-pending-correlation')
  const empty = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const run = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'run',
    arguments: JSON.stringify({ code: 'let value = 1', description: 'probe' }) })
  const pending = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'run' }, content: [] } }, { surfaceOp: 'append' })
  const events = sessionEvents(session)
  const floor = registry.restoreFloor(pending)
  assert.equal(registry.restore(pending, events.slice(floor), floor, session.header, 0)
    .checkpoint.ptcPlusSessionLog.val.timeline.latestRun.callSeq, run.seq)
  for (const mutate of [
    timeline => { delete timeline.pendingByCallId.krun },
    timeline => { timeline.pendingByCallId.krun = ['run', null] },
    timeline => { timeline.seenCallIds.kfuture = ['future', true] },
  ]) {
    const damaged = JSON.parse(JSON.stringify(pending))
    mutate(damaged.ptcPlusSessionLog.val.timeline)
    assert.throws(() => registry.restore(damaged, events.slice(floor), floor, session.header, 0), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, pending.ptcPlusSessionLog.seq)
  }
  const invented = JSON.parse(JSON.stringify(empty))
  invented.ptcPlusSessionLog.val.timeline.seenCallIds.krun = ['run', true]
  const emptyFloor = registry.restoreFloor(empty)
  assert.throws(() => registry.restore(invented, events.slice(emptyFloor), emptyFloor, session.header, 0), /timeline checkpoint/)
  assert.deepEqual(registry.restore({}, events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val,
    registry.stateOf(session, 'ptcPlusSessionLog'))

  // Native and REPL calls share the same identity lifecycle; a real duplicate
  // remains ambiguous even when the first call has already settled.
  session.append('tool/call', { turn: 1, step: 1, name: 'native', callId: 'native', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'native' }, content: [] } }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'native',
    arguments: JSON.stringify({ code: 'return 42' }) })
  const duplicate = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'native' }, content: [] } }, { surfaceOp: 'append' })
  const duplicateEvents = sessionEvents(session)
  const duplicateFloor = registry.restoreFloor(duplicate)
  const restored = registry.restore(duplicate, duplicateEvents.slice(duplicateFloor), duplicateFloor, session.header, 0)
  assert.equal(restored.checkpoint.ptcPlusSessionLog.val.timeline.runSelectionFrontier.reason, 'ambiguous-call-id')
  assert.deepEqual(restored.checkpoint.ptcPlusSessionLog.val, registry.stateOf(session, 'ptcPlusSessionLog'))
})

test('public checkpoint restore requires public prune evidence for an active replacement window', () => {
  const registry = new SessionProjectionRegistry(new Context())
  registry.register(createSessionLogProjection())
  const session = Session.create('checkpoint-prune-window-correlation')
  session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'run',
    arguments: JSON.stringify({ code: 'let value = 1' }) })
  const native = session.append('tool/call', { turn: 1, step: 1, name: 'native', callId: 'native', arguments: '{}' })
  const last = session.append('tool/call', { turn: 1, step: 1, name: 'native', callId: 'other', arguments: '{}' })
  const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'run' }, content: [] },
    meta: { [JOURNAL_KEY]: { version: 1, bindingMode: 'loose', status: 'durable',
      calls: [], operations: [], confirms: [], diagnostics: [], completion: { kind: 'return', hasValue: false } } } },
  { sourceEventSeqs: [native.seq], surfaceOp: 'append' })
  const events = sessionEvents(session)
  const floor = registry.restoreFloor(checkpoint)
  const honest = registry.restore(checkpoint, events.slice(floor), floor, session.header, 0)
  assert.equal(honest.checkpoint.ptcPlusSessionLog.val.timeline.latestRun, undefined)
  assert.equal(honest.checkpoint.ptcPlusSessionLog.val.timeline.unavailableResultSeq, native.seq)
  const damaged = JSON.parse(JSON.stringify(checkpoint))
  damaged.ptcPlusSessionLog.val.timeline.pruneReplacementWindow = {
    seqs: [native.seq], lastEventIndex: last.seq, lastEventSeq: last.seq,
  }
  assert.throws(() => registry.restore(damaged, events.slice(floor), floor, session.header, 0), /timeline checkpoint/)
  assert.equal(damaged.ptcPlusSessionLog.seq, checkpoint.ptcPlusSessionLog.seq)
  assert.deepEqual(registry.restore({}, events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val,
    registry.stateOf(session, 'ptcPlusSessionLog'))
})

test('public checkpoint restore reconstructs settlement and journal caches from normalized event facts', () => {
  const registry = new SessionProjectionRegistry(new Context())
  registry.register(createSessionLogProjection())
  const session = Session.create('checkpoint-result-lifecycle-evidence')
  const run = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'run',
    arguments: JSON.stringify({ code: 'let value = 1', description: 'probe' }) })
  const result = session.append('tool/result', { turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'run' }, content: [] },
    meta: { [JOURNAL_KEY]: { version: 1, bindingMode: 'loose', status: 'durable',
      calls: [], operations: [], confirms: [], diagnostics: [], completion: { kind: 'return', hasValue: false } } } },
  { sourceEventSeqs: [run.seq], surfaceOp: 'append' })
  const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const edit = session.append('tool/call', { turn: 1, step: 1, name: 'edit_run_code', callId: 'edit',
    arguments: JSON.stringify({ edits: [] }) })
  const events = sessionEvents(session)
  const floor = registry.restoreFloor(checkpoint)
  const honest = registry.restore(checkpoint, events.slice(floor), floor, session.header, 0)
  const target = state => projectSessionLog({ session }, { callId: edit.data.callId, callSeq: edit.seq }, state).requestedEditTarget
  assert.deepEqual(target(honest.checkpoint.ptcPlusSessionLog.val), { source: 'let value = 1', callSeq: run.seq })
  const resultFact = timeline => timeline.eventFacts.find(fact => fact.event.seq === result.seq)
  for (const mutate of [
    timeline => {
      delete timeline.settledResultsByEventSeq[`k${result.seq}`]
      delete timeline.ordinaryResultSeqs[`k${run.seq}`]
      delete timeline.latestRun
      delete timeline.editableRun
      delete timeline.lastSuccessfulRunIndex
    },
    timeline => { timeline.results[`k${run.seq}`][1].journal.completion = {
      kind: 'throw', error: { kind: 'Error', message: 'fabricated failure' },
    } },
    timeline => {
      timeline.results[`k${run.seq}`][1].journal.calls.push({ global: 'tools', member: 'cordis_inspect',
        args: encodeValue({}), ok: true, value: encodeValue({}), settle: 0 })
      timeline.cordisTranscript = { calls: 1, inspections: 1 }
    },
    timeline => { delete timeline.results[`k${run.seq}`] },
    timeline => { timeline.unavailableResultSeq = run.seq },
    timeline => { delete resultFact(timeline).normalized },
    timeline => { resultFact(timeline).normalized.eventIndex += 1 },
    timeline => { resultFact(timeline).normalized.positionSeq = result.seq },
    timeline => { delete resultFact(timeline).hasJournal },
    timeline => { resultFact(timeline).hasJournal = false },
    timeline => { resultFact(timeline).boundaryFailure = true },
  ]) {
    const damaged = JSON.parse(JSON.stringify(checkpoint))
    mutate(damaged.ptcPlusSessionLog.val.timeline)
    assert.throws(() => registry.restore(damaged, events.slice(floor), floor, session.header, 0), /timeline checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, checkpoint.ptcPlusSessionLog.seq)
  }
  assert.deepEqual(registry.restore({}, events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val,
    registry.stateOf(session, 'ptcPlusSessionLog'))
})

test('public checkpoint restore proves exact ordered visibility from presentation input facts', () => {
  const registry = new SessionProjectionRegistry(new Context())
  registry.register(createSessionLogProjection())
  const session = Session.create('checkpoint-public-surface-evidence')
  const catalog = { name: PTC_BINDING_CATALOG, text: 'declare function availableApi(): number' }
  const first = session.append('user/message', runtimeBindingCatalogMessage(catalog), { surfaceOp: 'append' })
  const visible = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const replacement = session.append('user/message', user('summary without the binding API catalog'), {
    surfaceOp: replaceSurface(first.seq, first.seq), sourceEventSeqs: [first.seq],
  })
  const run = session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: 'run',
    arguments: JSON.stringify({ code: 'return 42', description: 'probe' }) })
  const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
  const events = sessionEvents(session)
  const floor = registry.restoreFloor(checkpoint)
  const restore = candidate => registry.restore(candidate, events.slice(floor), floor, session.header, 0)
  const honest = restore(checkpoint).checkpoint.ptcPlusSessionLog.val
  assert.deepEqual(honest.surfaceNodes, session.surface.nodes)
  assert.deepEqual(honest.surfaceNodes, [replacement.seq])
  assert.equal(projectRuntimeMessages(projectSessionLog({ session }, undefined, honest), [catalog]).length, 1)
  assert.equal(JSON.stringify(honest.logFacts).includes('summary without the binding API catalog'), false)
  for (const mutate of [
    value => {
      value.surfaceNodes = [first.seq]
      value.visibleRuntimeMessages = [value.runtimeMessagesBySeq[`k${first.seq}`]]
      value.visibleRuntimeFacts = runtimeMessageFacts(value.visibleRuntimeMessages)
    },
    value => { value.logFacts = [] },
    value => { delete value.logFacts },
    value => { value.logFacts[0].index = -1 },
    value => { value.logFacts[0].extra = true },
    value => { value.logFacts.find(fact => fact.index === run.seq).event.seq += 1 },
    value => { value.logFacts = value.logFacts.filter(fact => fact.index !== run.seq) },
    value => { value.timeline = JSON.parse(JSON.stringify(visible.ptcPlusSessionLog.val.timeline)) },
    value => { value.ptcMessages = [] },
    value => { value.contextStep += 1 },
    value => { value.runtimeMessagesBySeq = {} },
  ]) {
    const damaged = JSON.parse(JSON.stringify(checkpoint))
    mutate(damaged.ptcPlusSessionLog.val)
    assert.throws(() => restore(damaged), /checkpoint/)
    assert.equal(damaged.ptcPlusSessionLog.seq, checkpoint.ptcPlusSessionLog.seq)
  }
  const visibleEvents = events.slice(0, visible.ptcPlusSessionLog.seq + 1)
  const damagedVisible = JSON.parse(JSON.stringify(visible))
  damagedVisible.ptcPlusSessionLog.val.surfaceNodes = []
  damagedVisible.ptcPlusSessionLog.val.visibleRuntimeMessages = []
  damagedVisible.ptcPlusSessionLog.val.visibleRuntimeFacts = {}
  const visibleFloor = registry.restoreFloor(visible)
  assert.throws(() => registry.restore(damagedVisible, visibleEvents.slice(visibleFloor), visibleFloor, session.header, 0), /checkpoint/)
  assert.equal(projectRuntimeMessages(projectSessionLog({ session }, undefined,
    registry.restore(visible, events.slice(visibleFloor), visibleFloor, session.header, 0)
      .checkpoint.ptcPlusSessionLog.val), [catalog]).length, 1)
  assert.deepEqual(registry.restore({}, events, 0, session.header, 0).checkpoint.ptcPlusSessionLog.val,
    registry.stateOf(session, 'ptcPlusSessionLog'))
})

test('log projection registration failures are diagnosed without silently empty current facts', async () => {
  const diagnostics = []
  const effects = []
  const scope = { sessionProjections: { register() {} },
    effect(create) { effects.push(create()) } }
  const owner = createSessionLogOwner({
    inject(_names, callback) { callback(scope); return { dispose() { diagnostics.push('disposed') } } },
    effect: scope.effect,
    logger: { warn(...parts) { diagnostics.push(parts) } },
  })
  assert.match(diagnostics[0][1].message, /did not return a disposer/)
  assert.throws(() => owner.project({ session: { id: 'no-current-projection' } }), /public sessionQuery observation/)
  for (const dispose of effects) await dispose?.()
  assert.equal(diagnostics.at(-1), 'disposed')
})


test('bounded message forms separate current state, notices, tasks, and malformed evidence', () => {
  const snapshot = runtimeStateMessage(state('current'))
  const notice = runtimeNoticeMessage(tip(1))
  assert.deepEqual(readRuntimeMessage(snapshot), { form: 'snapshot', sections: state('current') })
  assert.deepEqual(readRuntimeMessage(notice), { form: 'notice', ...tip(1) })
  assert.equal(readRuntimeMessage(user('ptc-plus')), undefined)
  for (const altered of [
    { ...snapshot, source: { kind: 'plugin', plugin: 'ptc-plus' } },
    { ...snapshot, source: { kind: 'skill-invocation', name: 'ptc-plus', form: 'instructions' } },
    { ...snapshot, content: [] },
    { ...snapshot, content: [{ type: 'image' }] },
    { ...snapshot, content: [{ type: 'text', text: 'forged current state' }] },
    { ...notice, source: { ...notice.source, summary: 'unrelated' } },
    { ...notice, content: [{ type: 'text', text: '' }] },
    { ...notice, content: [{ type: 'text', text: 'x'.repeat(8193) }] },
    { ...snapshot, source: { ...snapshot.source, sections: [null] } },
  ]) assert.equal(readRuntimeMessage(altered), undefined)
  for (const sections of [undefined, Array(PTC_STATE_NAMES.length + 1).fill(state('x')[0]), [{ name: 'other', text: 'x' }],
    [...state('x'), ...state('x')], state(''), state('x'.repeat(65537))]) {
    assert.throws(() => runtimeStateMessage(sections), /invalid PTC/)
  }
  assert.throws(() => runtimeNoticeMessage({ ...tip(1), text: '' }), /invalid PTC/)
  for (const value of [undefined, 'other', 'tools:ptc-plus-tip/platform-command-failure/9007199254740992']) {
    assert.equal(recoveryTipIdentity(value), undefined)
  }
})

test('binding catalogs use bounded literal text and preserve historical snapshot recognition', () => {
  const context = { name: PTC_BINDING_CATALOG, text: 'Use helper. Render {{name}} literally.' }
  const message = runtimeBindingCatalogMessage(context)
  assert.deepEqual(readRuntimeMessage(message), { form: 'catalog', sections: [context] })
  assert.deepEqual(readRuntimeMessage(runtimeBindingCatalogMessage()), { form: 'catalog', sections: [] })
  for (const invalid of [null, { name: 'other', text: 'x' }, { name: PTC_BINDING_CATALOG },
    { name: PTC_BINDING_CATALOG, text: '' }, { name: PTC_BINDING_CATALOG, text: 'x'.repeat(65537) },
    { name: PTC_BINDING_CATALOG, text: 'No entries documented.' },
    { name: PTC_BINDING_CATALOG, text: 'No global binding API documentation is currently configured. Earlier binding catalogs no longer apply.' }]) {
    assert.throws(() => runtimeBindingCatalogMessage(invalid), /invalid PTC binding catalog/)
  }
  const prefix = message.content[0].text.slice(0, -context.text.length)
  for (const text of ['unrelated catalog', prefix, prefix + 'x'.repeat(65537)]) {
    assert.equal(readRuntimeMessage({ ...message, content: [{ type: 'text', text }] }), undefined)
  }
  const legacy = structuredClone(runtimeStateMessage(state('legacy')))
  legacy.content[0].text = 'PTC Plus current state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace tasks, Skill instructions, tool results, or other producers.\n\nlegacy'
  assert.deepEqual(readRuntimeMessage(legacy), { form: 'snapshot', sections: state('legacy') })
})

test('historical catalog and recovery wrappers retain their exact bounded recognition and delivery state', () => {
  const catalogPrefixes = [
    'Global binding API catalog (PTC Plus). Only a later global binding API catalog replaces this catalog. Host runtime-context snapshots and PTC recovery snapshots do not withdraw it. This describes configured APIs, not successful initialization or current runtime values.',
    'Global binding API catalog (PTC Plus). Replaces earlier binding catalogs only; remains applicable until the next binding catalog.',
  ]
  const statePrefix = 'PTC Plus runtime recovery state. This replaces only earlier PTC state snapshots and PTC sections in historical aggregate snapshots; it does not replace the global binding API catalog, tasks, Skill instructions, tool results, or other producers.'
  const context = { name: PTC_BINDING_CATALOG, text: 'Use helper. {{name}}\n```ts\ndeclare const helper: number;\n```' }
  const session = Session.create('historical-wrapper-delivery')
  const recovery = structuredClone(runtimeStateMessage(state('Inspect the uncertain state.')))
  recovery.content[0].text = statePrefix + '\n\nInspect the uncertain state.'
  append(session, recovery)
  assert.deepEqual(readRuntimeMessage(recovery), { form: 'snapshot', sections: state('Inspect the uncertain state.') })
  for (const catalogPrefix of catalogPrefixes) for (const current of [context, undefined]) {
    const message = structuredClone(runtimeBindingCatalogMessage(current))
    const body = current?.text ?? 'No global binding API documentation is currently configured. Earlier binding catalogs no longer apply.'
    message.content[0].text = catalogPrefix + '\n\n' + body
    assert.deepEqual(readRuntimeMessage(message), { form: 'catalog', sections: current === undefined ? [] : [context] })
    append(session, message)
    assert.deepEqual(projectRuntimeMessages(viewOf(session), [...state('Inspect the uncertain state.'), ...(current === undefined ? [] : [context])]), [])
    for (const invalid of ['', 'x'.repeat(65537)]) {
      assert.equal(readRuntimeMessage({ ...message, content: [{ type: 'text', text: catalogPrefix + '\n\n' + invalid }] }), undefined)
    }
  }
  const malformed = structuredClone(runtimeBindingCatalogMessage(context))
  for (const catalogPrefix of catalogPrefixes) {
    const literal = { ...malformed, content: [{ type: 'text', text: catalogPrefix + '\n\nNone.' }] }
    assert.deepEqual(readRuntimeMessage(literal), { form: 'catalog', sections: [{ name: PTC_BINDING_CATALOG, text: 'None.' }] })
  }
  malformed.content[0].text = null
  assert.equal(readRuntimeMessage(malformed), undefined)
})

test('binding documentation contains only its invocation location and selected entry text', () => {
  const snapshot = createUserBindingsSnapshot({ entries: [{
    id: 'text-tools', name: 'textTools', scope: 'namespace', enabled: true,
    source: 'export function trim(value: string): string { return value.trim() }',
    modelContext: { includeDeclaration: true, instructions: 'Preserve {{name}} literally.' },
  }] })
  const context = userBindingsConfiguredContext(snapshot)
  assert.equal(runtimeBindingCatalogMessage(context).content[0].text, [
    'Global binding API reference for run_code (replaces the previous global binding reference):',
    'Binding: textTools',
    'Preserve {{name}} literally.',
    '```ts\ndeclare const textTools: {\n  trim(value: string): string;\n}\n```',
  ].join('\n\n'))
  assert.equal(runtimeBindingCatalogMessage().content[0].text,
    'Global binding API reference for run_code (replaces the previous global binding reference):\n\nNo entries documented.')
  const oldContext = { ...context, text: 'Call these helpers by name inside run_code. Enabled modules initialize before cell execution; initialization can fail, and session-local assignments or redeclarations can override a listed name.\n\n' + context.text }
  const session = Session.create('updated-binding-documentation')
  const historical = structuredClone(runtimeBindingCatalogMessage(oldContext))
  historical.content[0].text = historical.content[0].text.replace(
    /^.*?\n\n/,
    'Global binding API catalog (PTC Plus). Replaces earlier binding catalogs only; remains applicable until the next binding catalog.\n\n',
  )
  append(session, historical)
  const proposed = projectRuntimeMessages(viewOf(session), [context])
  assert.equal(proposed.length, 1)
  assert.equal(proposed[0].content[0].text, runtimeBindingCatalogMessage(context).content[0].text)
  assert.deepEqual(projectRuntimeMessages(viewOf(session), [context], proposed), [])
  proposed.forEach(message => append(session, message))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), [context]), [])
  assert.equal(sessionEvents(session)[0].data.content[0].text, historical.content[0].text)
})

test('withdrawing documentation does not report that an enabled binding is unavailable', () => {
  const snapshot = createUserBindingsSnapshot({ entries: [{
    id: 'numbers', name: 'numbers', scope: 'namespace', enabled: true,
    source: 'export const value = 42',
    modelContext: { includeDeclaration: false, instructions: '' },
  }] })
  const before = structuredClone(snapshot)
  const session = Session.create('binding-reference-withdrawal')
  append(session, runtimeBindingCatalogMessage({ name: PTC_BINDING_CATALOG, text: 'Binding: numbers' }))
  const context = userBindingsConfiguredContext(snapshot)
  assert.equal(context, undefined)
  assert.equal(snapshot.entries.length, 1)
  assert.deepEqual(snapshot, before)
  const messages = projectRuntimeMessages(viewOf(session), [])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content[0].text,
    'Global binding API reference for run_code (replaces the previous global binding reference):\n\nNo entries documented.')
  assert.deepEqual(readRuntimeMessage(messages[0]).sections, [])
  messages.forEach(message => append(session, message))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), []), [])
})

test('recovery snapshots never resend or withdraw a retained API catalog', () => {
  const catalog = { name: PTC_BINDING_CATALOG, text: 'declare const helper: { next(): number };' }
  const session = Session.create('catalog-recovery-lifecycle')
  const deliver = contexts => {
    const messages = projectRuntimeMessages(viewOf(session), contexts)
    assert.deepEqual(projectRuntimeMessages(viewOf(session), contexts, messages), [])
    messages.forEach(message => append(session, message))
    return messages.map(readRuntimeMessage)
  }
  assert.deepEqual(deliver([catalog]).map(message => message.form), ['catalog'])
  for (const name of ['tools:ptc-plus-cordis-recovery', 'tools:ptc-plus-rewrite-info']) {
    assert.deepEqual(deliver([catalog, { name, text: 'Inspect the uncertain state.' }]), [
      { form: 'snapshot', sections: [{ name, text: 'Inspect the uncertain state.' }] },
    ])
    assert.deepEqual(deliver([catalog]), [{ form: 'snapshot', sections: [] }])
  }
  const config = { allowed: [catalog, ...PTC_STATE_NAMES.slice(0, 2).map(name => ({ name }))]
    .map(({ name }) => ({ name, maxChars: 1000 })) }
  assert.deepEqual(auditRuntimeContexts(sessionEvents(session), config).failures, [])
  assert.deepEqual(deliver([]), [{ form: 'catalog', sections: [] }])
  assert.deepEqual(deliver([]), [])
  const nodes = session.surface.nodes
  session.append('user/message', user('Summary'), {
    surfaceOp: replaceSurface(nodes[0], nodes.at(-1)), sourceEventSeqs: nodes,
  })
  assert.deepEqual(deliver([]).map(message => message.form), ['snapshot', 'catalog'])
  assert.deepEqual(deliver([]), [])
})

test('audit detects unchanged binding sections inside otherwise changed snapshots', () => {
  const session = Session.create('legacy-section-repetition')
  const catalog = { name: PTC_BINDING_CATALOG, text: 'declare const helper: unknown;' }
  append(session, runtimeStateMessage([catalog]))
  append(session, runtimeStateMessage([catalog, ...state('unknown completion')]))
  const audit = auditRuntimeContexts(sessionEvents(session), {
    allowed: [catalog, ...state('unknown completion')].map(({ name }) => ({ name, maxChars: 1000 })),
  })
  assert.match(audit.failures.join('\n'), /repeats unchanged binding documentation/)
})

test('committed history deduplicates notices while public surface controls retained state', () => {
  const session = Session.create('message-projection')
  assert.deepEqual(projectRuntimeMessages(viewOf(session), []), [])
  const contexts = [...state('current'), tip(1)]
  const first = projectRuntimeMessages(viewOf(session), contexts)
  assert.equal(first.length, 2)
  assert.equal(projectRuntimeMessages(viewOf(session), contexts).length, 2)
  assert.deepEqual(projectRuntimeMessages(viewOf(session), contexts, first), [])
  const saved = first.map(message => append(session, message))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), contexts), [])
  const task = createUserMessage({ source: { kind: 'plugin', plugin: 'ptc-plus' }, content: [{ type: 'text', text: 'Author this binding.' }] })
  append(session, task)
  const changed = projectRuntimeMessages(viewOf(session), state('changed'))
  assert.equal(changed.length, 1)
  append(session, changed[0])
  assert.equal(session.deriveMessages().some(message => message.id === task.id), true)
  const cleared = projectRuntimeMessages(viewOf(session), [])
  assert.equal(cleared.length, 1)
  append(session, cleared[0])
  assert.deepEqual(projectRuntimeMessages(viewOf(session), []), [])
  const nodes = session.surface.nodes
  session.append('user/message', user('Compacted summary mentions old state.'), {
    surfaceOp: replaceSurface(nodes[0], nodes.at(-1)), sourceEventSeqs: [...nodes],
  })
  assert.equal(viewOf(session).ptcMessages.length, 4)
  assert.equal(viewOf(session).visibleRuntimeMessages.length, 0)
  assert.equal(projectRuntimeMessages(viewOf(session), contexts).length, 1)
  assert.equal(projectRuntimeMessages(viewOf(session), [tip(2)]).length, 2)
  assert.equal(saved[0].data.source.form, 'snapshot')
  assert.deepEqual(projectRuntimeMessages(viewOf({ events: [] }), contexts), [])
})

test('canonical historical aggregate sections coexist with independent PTC messages', () => {
  const session = Session.create('mixed-runtime-history')
  const aggregate = sections => createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections },
    content: [{ type: 'text', text: sections.map(section => section.text).join('\n') }],
  })
  append(session, aggregate([...state('legacy'), tip(1), { name: 'other', text: 'policy' }]))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), [...state('legacy'), tip(1)]), [])
  append(session, runtimeStateMessage(state('independent')))
  append(session, aggregate([{ name: 'other', text: 'changed policy' }]))
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('independent')), [])
  assert.equal(projectRuntimeMessages(viewOf(session), []).length, 1)
  const damaged = { events: [], get surface() { throw new Error('unavailable') } }
  assert.equal(viewOf(damaged).visibleRuntimeMessages, undefined)
  assert.equal(viewOf({ events: [], surface: { nodes: [99] } }).visibleRuntimeMessages, undefined)
})

test('configured binding prompts reconstruct, reappear after compaction, and withdraw through persisted snapshots', () => {
  const context = instructions => userBindingsConfiguredContext(createUserBindingsSnapshot({ entries: [{
    id: 'helper', name: 'helper', scope: 'namespace', enabled: true, source: 'export const value = 1',
    modelContext: { includeDeclaration: false, instructions },
  }] }))
  const first = [context('Use helper.value for the first task.')]
  const revised = [context('Use helper.value for the revised task. Render {{name}} literally.')]
  const session = Session.create('configured-binding-context')
  append(session, projectRuntimeMessages(viewOf(session), first)[0])
  const restored = Session.create('restored-configured-context', sessionEvents(session))
  assert.deepEqual(projectRuntimeMessages(viewOf(restored), first), [])
  const update = projectRuntimeMessages(viewOf(restored), revised)
  assert.equal(update.length, 1)
  append(restored, update[0])
  assert.deepEqual(projectRuntimeMessages(viewOf(restored), revised), [])
  assert.ok(restored.deriveMessages()[0].content[0].text.includes('first task'))
  const nodes = restored.surface.nodes
  restored.append('user/message', user('Compacted task summary.'), {
    surfaceOp: replaceSurface(nodes[0], nodes.at(-1)), sourceEventSeqs: [...nodes],
  })
  const reaffirmed = projectRuntimeMessages(viewOf(restored), revised)
  assert.equal(reaffirmed.length, 1)
  append(restored, reaffirmed[0])
  const clear = projectRuntimeMessages(viewOf(restored), [])
  assert.equal(clear.length, 1)
  assert.deepEqual(readRuntimeMessage(clear[0]).sections, [])
  append(restored, clear[0])
  const cleared = Session.create('restored-cleared-context', sessionEvents(restored))
  assert.deepEqual(projectRuntimeMessages(viewOf(cleared), []), [])
})

test('historical activation claims are withdrawn once without retaining duplicate interfaces', () => {
  const configured = userBindingsConfiguredContext(createUserBindingsSnapshot({ entries: [{
    id: 'files', name: 'fileTools', scope: 'namespace', enabled: true,
    source: 'export function next(): number { return 1 }',
  }] }))
  const active = { name: 'tools:ptc-plus-user-bindings',
    text: 'Previously activated bindings.\n\n```ts\ndeclare const fileTools: { next(): number; };\n```' }
  for (const producer of ['ptc-plus', '@deepseek-ai/dsh-system-prompt']) {
    for (const current of [[configured], []]) {
      const session = Session.create(`historical-activation-${producer}-${current.length}`)
      const sections = [configured, active]
      const historical = producer === 'ptc-plus' ? runtimeStateMessage(sections) : createUserMessage({
        source: { kind: 'plugin', plugin: producer, form: 'snapshot', sections },
        content: [{ type: 'text', text: sections.map(section => section.text).join('\n\n') }],
      })
      append(session, historical)
      const restored = Session.create('restored-activation-claims', sessionEvents(session))
      const proposed = projectRuntimeMessages(viewOf(restored), current)
      assert.equal(proposed.length, current.length + 1)
      assert.deepEqual(readRuntimeMessage(proposed[0]).sections, [])
      assert.equal(proposed.map(message => message.content[0].text).join('\n').split('declare const fileTools: {').length - 1, current.length)
      assert.match(proposed[0].content[0].text, /Replaces earlier PTC recovery status/)
      assert.deepEqual(projectRuntimeMessages(viewOf(restored), current, proposed), [])
      proposed.forEach(message => append(restored, message))
      assert.deepEqual(projectRuntimeMessages(viewOf(restored), current), [])
      assert.deepEqual(projectRuntimeMessages(viewOf(Session.create('after-clearance', sessionEvents(restored))), current), [])
      assert.equal(restored.deriveMessages()[0].id, historical.id)
    }
  }
})

test('historical aggregate clearance and pending replacement require current PTC declarations', () => {
  const session = Session.create('aggregate-clearance')
  const legacy = createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: state('active') },
    content: [{ type: 'text', text: 'active' }],
  })
  const clear = createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    content: [{ type: 'text', text: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' }],
  })
  assert.deepEqual(systemPromptSnapshotSections(clear), [])
  for (const content of [undefined, [], [{ type: 'image' }], [{ type: 'text', text: 'summary of old state' }]]) {
    assert.equal(systemPromptSnapshotSections({ ...clear, content }), undefined)
  }
  append(session, legacy)
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('active')), [])
  const migration = projectRuntimeMessages(viewOf(session), state('active'), [clear])
  assert.equal(migration.length, 1)
  const unrelated = { ...legacy, source: { ...legacy.source, sections: [{ name: 'other', text: 'policy' }] } }
  assert.equal(projectRuntimeMessages(viewOf(session), state('active'), [unrelated]).length, 1)
  append(session, clear)
  assert.equal(projectRuntimeMessages(viewOf(session), state('active')).length, 1)
  append(session, migration[0])
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('active'), [clear]), [])
  assert.equal(Object.isFrozen(viewOf(session).visibleRuntimeMessages[0]), true)
})

test('bounded rewrite feedback and exhausted notice ordinals cannot block a later request', () => {
  const contexts = sessionRuntimeContexts({ session: { events: [
    { type: 'turn/start' },
    { type: 'tool/call', data: { callId: 'long-rewrite', name: 'run_code', arguments: JSON.stringify({ code: 'return 1' }) } },
    { type: 'tool/result', data: { message: { source: { callId: 'long-rewrite' } }, meta: {
      dshPtcPlusRewrites: [{ kind: 'import', description: 'x'.repeat(70000) }],
    } } },
  ] } }, { enabled: false }).contexts
  assert.equal(contexts.length, 1)
  assert.match(contexts[0].text, /list truncated/)
  assert.ok(contexts[0].text.length < 3000)
  assert.doesNotThrow(() => runtimeStateMessage(contexts))
  const view = { systemPromptSnapshots: [], contextStep: 100, ptcMessages: [{
    form: 'notice', ...tip(Number.MAX_SAFE_INTEGER), index: 1, contextStep: 1,
  }], latestRun: { args: { code: 'failure' }, journal: { diagnostics: [{ code: 'PTC-X001', message: 'command not found' }] } } }
  assert.equal(latestRecoveryTip(view, { enabled: true, cooldownMessages: 1, escalationFailures: 2 }), undefined)
})

test('mixed tip sources count each committed ordinal once and reset escalation after success', () => {
  const current = { systemPromptSnapshots: [{ index: 1, contextStep: 1, sections: [tip(1)] }],
    contextStep: 10, ptcMessages: [
      { form: 'notice', ...tip(1), index: 2, contextStep: 2 },
      { form: 'notice', ...tip(2), index: 3, contextStep: 3 },
    ], latestRun: { args: { code: 'failure' }, journal: { diagnostics: [{ code: 'PTC-X001', message: 'command not found' }] } } }
  const config = { enabled: true, cooldownMessages: 3, escalationFailures: 2 }
  const result = latestRecoveryTip(current, config)
  assert.equal(result.name, tip(3).name)
  assert.match(result.text, /Re-check/)
  assert.equal(latestRecoveryTip({ ...current, contextStep: 4 }, config), undefined)
  assert.doesNotMatch(latestRecoveryTip({ ...current, lastSuccessfulRunIndex: 4 }, config).text, /Re-check/)
})

test('acceptance audits preserve independent ownership, notice identity, and surface replacement', () => {
  const session = Session.create('runtime-audit')
  const snapshot = runtimeStateMessage(state('current'))
  append(session, snapshot)
  append(session, runtimeNoticeMessage(tip(1)))
  const nodes = session.surface.nodes
  session.append('user/message', user('summary'), {
    surfaceOp: replaceSurface(nodes[0], nodes.at(-1)), sourceEventSeqs: [...nodes],
  })
  append(session, runtimeStateMessage(state('current')))
  append(session, runtimeStateMessage([]))
  const config = { allowed: [...state('current'), tip(1)].map(item => ({ name: item.name, maxChars: 100 })) }
  const audited = auditRuntimeContexts(sessionEvents(session), config)
  assert.deepEqual(audited.failures, [])
  assert.deepEqual(audited.snapshots.map(item => item.producer), Array(4).fill('ptc-plus'))
  assert.ok(audited.snapshots.at(-1).transitions.some(item => item.type === 'clear'))
  append(session, runtimeNoticeMessage(tip(1)))
  assert.match(auditRuntimeContexts(sessionEvents(session), config).failures.join('\n'), /delivered identity/)
  assert.equal(isRuntimeContextSource('plugin:ptc-plus:snapshot'), true)
  assert.equal(isRuntimeContextSource('plugin:ptc-plus:notice'), true)
  assert.equal(isRuntimeContextSource('plugin:ptc-plus'), false)
})

test('replacement audits use public order and notice audits retain historical identities', () => {
  const session = Session.create('ordered-audit')
  const first = append(session, runtimeStateMessage(state('first')))
  append(session, runtimeStateMessage(state('current')))
  session.append('user/message', runtimeStateMessage(state('replacement of first')), {
    surfaceOp: replaceSurface(first.seq, first.seq), sourceEventSeqs: [first.seq],
  })
  session.append('request/header', requestHeader())
  const config = { allowed: [...state('current'), tip(1)].map(item => ({ name: item.name, maxChars: 100 })) }
  const audited = auditRuntimeContexts(sessionEvents(session), config)
  assert.deepEqual(audited.failures, [])
  assert.equal(audited.requests[0].sections[0].text, 'current')
  assert.deepEqual(projectRuntimeMessages(viewOf(session), state('current')), [])
  append(session, createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [tip(1)] },
    content: [{ type: 'text', text: tip(1).text }],
  }))
  append(session, runtimeNoticeMessage(tip(1)))
  assert.match(auditRuntimeContexts(sessionEvents(session), config).failures.join('\n'), /delivered identity/)
})

test('pending assembly and pre-step cannot reacquire delivery after disposal', async () => {
  const assembly = { contexts: [{ name: PTC_DELIVERY_CONTEXT, text: '' }] }
  const decision = { kind: 'enter', messages: [] }
  for (const disposal of ['agent', 'owner']) {
    const owner = createRuntimeMessageOwner(() => state('late state'), viewForAgent)
    const agent = { session: Session.create(`disposed-${disposal}`) }
    const signal = new AbortController().signal
    const context = { agent, signal }
    const gate = Promise.withResolvers()
    const pending = owner.assemble(assembly, context, () => gate.promise)
    if (disposal === 'agent') owner.disposeAgent(agent)
    else owner.dispose()
    gate.resolve(assembly)
    assert.deepEqual((await pending).contexts, [])
    assert.equal(await owner.preStep(context, async () => decision), decision)
    await owner.assemble(assembly, context, async () => assembly)
    assert.equal(await owner.preStep(context, async () => decision), decision)
  }
  const agent = { session: Session.create('disposed-pre-step') }
  const signal = new AbortController().signal
  const context = { agent, signal }
  const owner = createRuntimeMessageOwner(() => state('late state'), viewForAgent)
  await owner.assemble(assembly, context, async () => assembly)
  const gate = Promise.withResolvers()
  const pending = owner.preStep(context, () => gate.promise)
  owner.disposeAgent(agent)
  gate.resolve(decision)
  assert.equal(await pending, decision)
})

test('delivery requires a matching permitted assembly and a live request signal', async () => {
  const owner = createRuntimeMessageOwner(() => state('eligible'), viewForAgent)
  const agent = { session: Session.create('assembly-permission') }
  const controller = new AbortController()
  const context = { agent, signal: controller.signal }
  const witness = { contexts: [{ name: PTC_DELIVERY_CONTEXT, text: '' }] }
  const decision = { kind: 'enter', messages: [] }
  assert.equal(await owner.preStep(context, async () => decision), decision)
  await owner.assemble(witness, undefined, async () => witness)
  await owner.assemble(witness, { agent: null }, async () => witness)
  await owner.assemble({}, context, async () => witness)
  assert.equal(await owner.preStep(context, async () => decision), decision)
  await owner.assemble(witness, context, async () => ({}))
  assert.equal(await owner.preStep(context, async () => decision), decision)
  await owner.assemble(witness, context, async () => witness)
  assert.equal(await owner.preStep({ ...context, signal: new AbortController().signal }, async () => decision), decision)
  const accepted = await owner.preStep(context, async () => decision)
  assert.equal(accepted.messages.length, 1)
  controller.abort()
  assert.equal(await owner.preStep(context, async () => decision), decision)
  owner.dispose()
})

async function hostFixture(t, includeRuntimeContext = true) {
  const ctx = new Context()
  const fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  for (const [plugin, config] of [
    [SystemPrompt, { includeRuntimeContext }], [SessionStore], [AgentRegistry],
    [LlmRuntime], [SessionProjectionRegistry], [ToolRuntime], [AgentLoop],
  ]) {
    const fiber = ctx.plugin(plugin, config)
    fibers.push(fiber)
    await fiber.await()
  }
  const calls = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  let current = []
  let unrelated = 'unrelated policy'
  let reject = false
  let cancel = false
  const feature = ctx.plugin({ inject: ['llm', 'systemPrompt'], apply(scope) {
    scope.effect(() => scope.llm.registerAdapter(['fixture'], new Adapter()))
    scope.effect(() => scope.systemPrompt.context({ name: PTC_DELIVERY_CONTEXT, order: 98, text: '' }))
    scope.effect(() => scope.systemPrompt.context({ name: 'other', order: 1, text: () => unrelated }))
    const log = createSessionLogOwner(scope)
    const owner = createRuntimeMessageOwner(() => current, log.project)
    scope.on('system-prompt/assemble', (assembly, context, next) => owner.assemble(assembly, context, next))
    scope.on('agent/pre-step', (payload, next) => owner.preStep(payload, next))
    scope.on('agent/pre-step', async ({ agent }, next) => {
      if (cancel) { agent.cancel(); return { kind: 'reject' } }
      return reject ? { kind: 'reject' } : next()
    })
    scope.on('agent/disposed', ({ agent }) => owner.disposeAgent(agent))
    scope.effect(() => () => owner.dispose())
  } })
  fibers.push(feature)
  await feature.await()
  const handle = await ctx.agents.create({ sessionId: 'runtime-messages', agentOptions: { provider: 'fixture', model: 'fixture' } })
  t.after(() => handle.dispose())
  const agent = handle.agent
  async function wake(text = 'continue') {
    const idle = new Promise(resolve => {
      const dispose = ctx.on('agent/status', payload => {
        if (payload.agent === agent && payload.status === 'idle') { dispose(); resolve() }
      })
    })
    agent.followup(user(text))
    await idle
  }
  return { ctx, agent, calls, wake, feature,
    setState: value => { current = value }, setOther: value => { unrelated = value },
    reject: value => { reject = value }, cancel: value => { cancel = value },
  }
}

test('real AgentLoop keeps PTC transitions independent and honors runtime suppression', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  const messages = () => sessionEvents(host.agent.session).filter(event => event.type === 'user/message')
  const count = () => messages().filter(event => isPtcMessageSource(event.data.source)).length
  const hostContextCount = () => messages().filter(event => (
    systemPromptSnapshotSections(event.data) !== undefined
  )).length
  host.setState(state('first'))
  await host.wake()
  assert.equal(host.calls.length, 1)
  assert.equal(count(), 1)
  assert.equal(hostContextCount(), 1)
  const prefix = JSON.stringify({ system: host.calls[0].system, tools: host.calls[0].tools })
  host.setState(state('second'))
  await host.wake()
  assert.equal(count(), 2)
  assert.equal(hostContextCount(), 1)
  host.setOther('different unrelated policy')
  await host.wake()
  assert.equal(count(), 2)
  assert.equal(hostContextCount(), 2)
  await host.wake()
  assert.equal(count(), 2)
  assert.equal(hostContextCount(), 2)
  const release = host.agent.ctx.systemPrompt.suppressRuntimeContext()
  host.setState(state('suppressed'))
  await host.wake()
  assert.equal(count(), 2)
  release()
  await host.wake()
  assert.equal(count(), 3)
  host.setState([])
  await host.wake()
  assert.equal(count(), 4)
  assert.deepEqual(readRuntimeMessage(messages().filter(event => isPtcMessageSource(event.data.source)).at(-1).data).sections, [])
  for (const call of host.calls) assert.equal(JSON.stringify({ system: call.system, tools: call.tools }), prefix)
})

test('real AgentLoop rejection and cancellation do not mark a proposed notice delivered', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  host.setState([tip(1)])
  host.reject(true)
  await host.wake()
  assert.equal(host.calls.length, 0)
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 0)
  host.reject(false)
  host.cancel(true)
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 0)
  host.cancel(false)
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  assert.equal(host.calls.length, 1)
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
})

test('real Host clearance leaves an explicitly scoped catalog valid across unchanged suppression', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  const catalog = { name: PTC_BINDING_CATALOG, text: 'COUNTER_BETA. declare const counter: { next(): number };' }
  host.setState([catalog])
  await host.wake()
  const first = viewOf(host.agent.session).ptcMessages[0]
  assert.equal(first.form, 'catalog')
  const release = host.agent.ctx.systemPrompt.suppressRuntimeContext()
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  const suppressed = host.calls.at(-1).messages
  assert.ok(suppressed.some(message => message.content.some(block => block.text ===
    'Current runtime context: none. Earlier runtime-context snapshots no longer apply.')))
  const retained = suppressed.find(message => readRuntimeMessage(message)?.form === 'catalog')
  assert.match(retained.content[0].text, /replaces the previous global binding reference/)
  assert.match(retained.content[0].text, /COUNTER_BETA/)
  release()
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  const pause = host.agent.ctx.systemPrompt.suppressRuntimeContext()
  host.setState([{ ...catalog, text: 'COUNTER_GAMMA' }])
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  pause()
  await host.wake()
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 2)
  for (const call of host.calls) {
    assert.equal(call.system, host.calls[0].system)
    assert.deepEqual(call.tools, host.calls[0].tools)
  }
})

test('real AgentLoop migrates historical aggregate state before a current Host replacement', { timeout: 15000 }, async t => {
  const host = await hostFixture(t)
  append(host.agent.session, createUserMessage({
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: state('active') },
    content: [{ type: 'text', text: 'active' }],
  }))
  host.setState(state('active'))
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  assert.deepEqual(viewOf(host.agent.session).ptcMessages[0].sections, state('active'))
  host.setOther('')
  await host.wake()
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 1)
  assert.deepEqual(viewOf(host.agent.session).visibleRuntimeMessages
    .filter(record => record.producer === 'ptc-plus').at(-1).sections, state('active'))
})

test('includeRuntimeContext false suppresses independent PTC messages through the public witness', { timeout: 15000 }, async t => {
  const host = await hostFixture(t, false)
  host.setState([...state('hidden'), tip(1)])
  await host.wake()
  assert.equal(host.calls.length, 1)
  assert.equal(viewOf(host.agent.session).ptcMessages.length, 0)
})

test('current PTC message forms pass the official persistence codec and retain historical readers', () => {
  const messages = [runtimeStateMessage(state('active')), runtimeNoticeMessage(tip(1)),
    runtimeBindingCatalogMessage({ name: PTC_BINDING_CATALOG, text: 'declare const helper: number' }),
    createUserMessage(bindingActionNotice({ requestId: 'request', id: 'helper', state: 'saved', enabled: true }))]
  const session = Session.create('ptc-message-persistence')
  for (const message of messages) {
    const event = append(session, message)
    assert.doesNotThrow(() => sessionFormatCatalog.encodeCurrentEvent(event))
    const historical = { ...message, source: { ...message.source, kind: 'plugin', plugin: 'ptc-plus' } }
    assert.throws(() => sessionFormatCatalog.encodeCurrentEvent({ ...event, data: historical }),
      /producer-owned source kind/)
    assert.deepEqual(readRuntimeMessage(historical), readRuntimeMessage(message))
    assert.deepEqual(readBindingAction(historical), readBindingAction(message))
  }
  const header = sessionFormatCatalog.encodeCurrentHeader({ ...session.header, delegationDepth: 0 }, 0)
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'none', validation: 'current' })
  for (const event of sessionEvents(session)) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  assert.deepEqual(restore.finish().events.map(event => event.data), messages)
})
