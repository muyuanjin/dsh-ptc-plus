import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionRuntime } from '../internal/session-runtime.js'
import {
  appendOnlySession,
  appendRunCodeCall,
  appendRunCodeEvents,
  fixture,
  ptcAgent,
  runRecordedCell,
} from './plugin-fixture.js'
import { RECOVERY_BOUNDARY_KEY } from '../internal/session-journal.js'
import { sessionEvents } from '../internal/session-events.js'

function appendEditCall(events, callId, args) {
  const argumentsValue = JSON.stringify(args)
  const assistantSeq = events.length
  events.push({
    type: 'assistant/message',
    seq: assistantSeq,
    time: assistantSeq,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: callId,
          name: 'edit_run_code',
          arguments: argumentsValue,
        }],
      },
    },
  })
  const seq = events.length
  events.push({
    type: 'tool/call',
    seq,
    time: seq,
    surfaceOp: 'append',
    data: { callId, name: 'edit_run_code', arguments: argumentsValue },
  })
  return seq
}

function appendEditResult(events, callId, callSeq, meta) {
  events.push({
    type: 'tool/result',
    seq: events.length,
    time: events.length,
    sourceEventSeqs: [callSeq],
    surfaceOp: 'append',
    data: { message: { source: { callId } }, meta },
  })
}

test('rejects pending fixture calls whose exact source identity does not match', async (t) => {
  for (const [label, configure, requested] of [
    ['program', () => {}, { program: 'return 2', description: 'test cell' }],
    ['description', () => {}, { program: 'return 1', description: 'different description' }],
    ['assistant', events => {
      events[0].data.message.content[0].arguments = JSON.stringify({
        code: 'return 9',
        description: 'test cell',
      })
    }, { program: 'return 1', description: 'test cell' }],
  ]) await t.test(label, async (t) => {
    const events = []
    const session = appendOnlySession(`pending-source-${label}`, events)
    appendRunCodeCall(events, 'same-call', 'return 1', 'test cell')
    configure(events)
    const state = fixture()
    t.after(() => state.dispose())
    await assert.rejects(
      state.runDurable(session.id, requested.program, {}, {
        session,
        callId: 'same-call',
        description: requested.description,
      }),
      /fixture pending run_code call/u,
    )
    assert.equal(events.some(event => event.type === 'tool/result'), false)
  })
})

test('shared recorded-cell owner appends through the official Session API', async (t) => {
  const session = Session.create('official-recorded-cell-owner')
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runRecordedCell(runtime, session, 'official-recorded-cell', {
    bindings: [],
    program: 'return 42',
  }, { description: 'official recorded cell' })
  assert.equal(result.value, 42)
  assert.equal(result.error, undefined)
  assert.deepEqual(sessionEvents(session).map(event => event.type), [
    'assistant/message',
    'tool/call',
    'tool/result',
  ])
})

test('records direct cells but not edit-derived runs in an official session', async (t) => {
  const session = Session.create('official-session-recording')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const source = 'let officialSessionValue = 1; return officialSessionValue'
  const setup = await state.runDurable(session.id, source, {}, {
    session,
    callId: 'official-session-setup',
  })
  assert.equal(setup.value, 1)
  assert.deepEqual(sessionEvents(session).map(event => event.type), [
    'assistant/message',
    'tool/call',
    'tool/result',
  ])

  const args = { edits: [{ old_string: '= 1', new_string: '= 2' }] }
  const argumentsValue = JSON.stringify(args)
  session.append('assistant/message', {
    turn: 0,
    step: 1,
    message: {
      id: 'message-assistant-official-session-edit',
      role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{
        type: 'tool-call',
        id: 'official-session-edit',
        name: 'edit_run_code',
        arguments: argumentsValue,
      }],
    },
  }, { surfaceOp: 'append' })
  const editCall = session.append('tool/call', {
    turn: 0,
    step: 1,
    callId: 'official-session-edit',
    name: 'edit_run_code',
    arguments: argumentsValue,
  })
  const edit = await state.ctx.tools.execute({
    callId: 'official-session-edit',
    name: 'edit_run_code',
    arguments: args,
    agent,
    signal,
  })
  assert.equal(edit.isError, false, JSON.stringify(edit))
  assert.equal(edit.value.edited, true)
  assert.equal(
    sessionEvents(session).filter(event => event.type === 'tool/call' && event.data.name === 'run_code').length,
    1,
  )
  session.append('tool/result', {
    message: {
      id: 'message-official-session-edit',
      role: 'user',
      source: { kind: 'tool', callId: 'official-session-edit' },
      content: [{ type: 'tool-result', toolCallId: 'official-session-edit', content: [] }],
    },
    meta: edit.meta,
  }, { surfaceOp: 'append', sourceEventSeqs: [editCall.seq] })
})

test('keeps a derived run tentative until exact outer metadata persists', async (t) => {
  const cases = [
    ['removed', false, () => ({})],
    ['changed', true, meta => ({
      ...meta,
      dshPtcPlusDerivedRun: {
        ...meta.dshPtcPlusDerivedRun,
        code: 'unconfirmedEditValue = 999',
      },
    })],
  ]
  for (const [label, expectsRecoveryBoundary, finalizeMeta] of cases) {
    const events = [{ type: 'turn/start', seq: 0, time: 0, data: {} }]
    const session = appendOnlySession(`unconfirmed-derived-${label}`, events)
    const state = fixture()
    t.after(() => state.dispose())
    const agent = ptcAgent(session.id, session)
    const requestSignal = new AbortController().signal
    await state.assemble(
      { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
      { agent, scope: agent, signal: requestSignal },
    )

    const setupCode = 'let unconfirmedEditValue = 1; return unconfirmedEditValue'
    const setup = await state.runDurable(session.id, setupCode, {}, { session, recordSession: 'deferred-result', callId: `${label}-setup` })
    const setupEventSeqs = appendRunCodeEvents(events, `${label}-setup`, setupCode, setup)
    const args = { edits: [{ old_string: '= 1', new_string: '= 2' }] }
    const callId = `${label}-edit`
    const callSeq = appendEditCall(events, callId, args)
    const definition = agent.ctx.tools.get('edit_run_code')
    const presentationMeta = definition.output.presentationMeta
    definition.output.presentationMeta = (editArgs, value) => (
      finalizeMeta(presentationMeta(editArgs, value))
    )
    let edit
    try {
      edit = await state.ctx.tools.execute({
        callId,
        name: 'edit_run_code',
        arguments: args,
        agent,
        signal: requestSignal,
      })
    } finally {
      definition.output.presentationMeta = presentationMeta
    }
    assert.equal(edit.isError, false, JSON.stringify(edit))
    assert.equal(edit.value.edited, true)
    appendEditResult(events, callId, callSeq, edit.meta)

    const dependentCode = [
      'const afterUnconfirmedEdit = unconfirmedEditValue + 1',
      'return [unconfirmedEditValue, afterUnconfirmedEdit]',
    ].join('\n')
    const dependent = await state.executeRun(
      session.id,
      dependentCode,
      {},
      { session, recordSession: 'deferred-result', callId: `${label}-dependent` },
    )
    assert.deepEqual(dependent.raw.value, [2, 3])
    assert.equal(dependent.result.meta.dshPtcPlus.status, 'volatile')
    appendRunCodeEvents(events, `${label}-dependent`, dependentCode, dependent.result)
    await state.dispose()

    const restored = fixture()
    t.after(() => restored.dispose())
    const coldResult = await restored.runDurable(
      session.id,
      'return [unconfirmedEditValue, typeof afterUnconfirmedEdit]',
      {},
      { session, recordSession: 'deferred-result', callId: `${label}-cold` },
    )
    assert.equal(coldResult.isError, false, JSON.stringify(coldResult))
    assert.deepEqual(coldResult.value, [1, 'undefined'])
    appendRunCodeEvents(events, `${label}-cold`, 'return [unconfirmedEditValue, typeof afterUnconfirmedEdit]', coldResult)
    const boundaries = events.flatMap(event => event.data?.meta?.[RECOVERY_BOUNDARY_KEY] ?? [])
    assert.equal(boundaries.length, expectsRecoveryBoundary ? 1 : 0)
    if (expectsRecoveryBoundary) {
      assert.deepEqual(boundaries[0], {
        failedCallSeq: callSeq,
        frontierCallSeq: setupEventSeqs.callSeq,
      })
    }
  }
})

test('carries derived recovery boundaries through the outer edit result', async (t) => {
  const events = []
  const session = appendOnlySession('derived-recovery-boundary', events)
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: requestSignal },
  )
  const setupCode = 'let derivedBoundaryValue = 1; return derivedBoundaryValue'
  const setup = await state.runDurable(session.id, setupCode, {}, { session, recordSession: 'deferred-result', callId: 'derived-boundary-setup' })
  appendRunCodeEvents(events, 'derived-boundary-setup', setupCode, setup)
  appendEditCall(events, 'derived-boundary-edit', { edits: [{ old_string: '= 1', new_string: '= 2' }] })

  const originalExecute = state.ctx.tools.execute
  state.ctx.tools.execute = async options => {
    const result = await originalExecute(options)
    if (options.name !== 'run_code') return result
    return {
      ...result,
      meta: {
        ...result.meta,
        [RECOVERY_BOUNDARY_KEY]: [{ failedCallSeq: 9, frontierCallSeq: 1 }],
      },
    }
  }
  const edit = await state.ctx.tools.execute({
    callId: 'derived-boundary-edit',
    name: 'edit_run_code',
    arguments: { edits: [{ old_string: '= 1', new_string: '= 2' }] },
    agent,
    signal: requestSignal,
  })
  assert.equal(edit.isError, false, JSON.stringify(edit))
  assert.deepEqual(edit.meta[RECOVERY_BOUNDARY_KEY], [{ failedCallSeq: 9, frontierCallSeq: 1 }])
})
