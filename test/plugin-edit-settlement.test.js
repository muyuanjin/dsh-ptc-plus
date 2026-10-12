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
  runNestedEditCell,
} from './plugin-fixture.js'
import { RECOVERY_BOUNDARY_KEY } from '../internal/session-journal.js'
import { recordedSessionEvents as sessionEvents } from './session-observation-fixture.js'

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

test('records a nested editor and its derived result under the original official run_code call', async (t) => {
  const session = Session.create('official-session-recording')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', { turn: 1 })
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
    'turn/start',
    'assistant/message',
    'tool/call',
    'tool/result',
  ])

  const edit = await runNestedEditCell(state, {
    session, agent, callId: 'official-session-edit', signal,
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
  })
  assert.equal(edit.result.isError, false, JSON.stringify(edit.result))
  assert.equal(edit.receipt.accepted, true, JSON.stringify(edit))
  assert.equal(edit.receipt.scheduled, true)
  assert.ok(edit.result.meta.dshPtcPlusPostEdit)
  assert.equal(
    sessionEvents(session).filter(event => event.type === 'tool/call' && event.data.name === 'run_code').length,
    2,
  )
  const events = sessionEvents(session)
  assert.equal(events.filter(event => event.type === 'tool/call' && event.data.name === 'edit_run_code').length, 0)
  const start = events.find(event => event.type === 'tool/ptc-dispatch-start'
    && event.data.rootCallId === 'official-session-edit')
  const settled = events.find(event => event.type === 'tool/ptc-dispatch'
    && event.data.subCallId === start?.data.subCallId)
  assert.equal(start?.data.name, 'edit_run_code')
  assert.equal(settled?.data.isError, false)
  assert.equal(events.findLast(event => event.type === 'tool/result')?.data.message.source.callId,
    'official-session-edit')
})

test('production edit observation cannot execute after its submission is disposed', async t => {
  for (const lifecycle of ['session', 'runtime']) await t.test(lifecycle, async t => {
    const session = Session.create(`edit-observation-${lifecycle}`)
    const state = fixture({ durableReplay: false })
    t.after(() => state.dispose())
    const agent = ptcAgent(session.id, session)
    const signal = new AbortController().signal
    await state.assemble(
      { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
      { agent, scope: agent, signal },
    )
    session.append('turn/start', { turn: 1 })
    await state.runDurable(session.id, 'let editOrphan = 1; return editOrphan', {}, { session })
    const original = state.ctx.sessionQuery.observeSession
    const reading = Promise.withResolvers()
    const suspended = Promise.withResolvers()
    state.ctx.sessionQuery.observeSession = async function (...parameters) {
      const cut = await original.call(this, ...parameters)
      reading.resolve()
      await suspended.promise
      return cut
    }
    const pending = runNestedEditCell(state, {
      session, agent, callId: 'pending-edit', signal,
      code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
    })
    await reading.promise
    if (lifecycle === 'session') await state.emit('session/disposed', session)
    else await state.dispose()
    suspended.resolve()
    await assert.rejects(pending, new RegExp(`PTC ${lifecycle} disposed`))
    assert.equal(sessionEvents(session).some(event => event.type === 'tool/result'
      && event.data?.message?.source?.callId === 'pending-edit'), false)
    if (lifecycle === 'session') {
      state.ctx.sessionQuery.observeSession = original
      assert.equal((await state.run(session.id, 'return typeof editOrphan', {}, { session })).value, 'undefined')
    }
  })
})

test('contracts to the verified setup when outer nested-edit metadata is not preserved', async (t) => {
  const cases = [
    ['removed', () => ({})],
    ['changed', meta => ({
      ...meta,
      dshPtcPlusPostEdit: {
        ...meta.dshPtcPlusPostEdit,
        subCallId: 'another-sub-call',
      },
    })],
  ]
  for (const [label, finalizeMeta] of cases) {
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
    let derivedDispatches = 0
    const execute = state.ctx.tools.execute
    state.ctx.tools.execute = async options => {
      if (options.name === 'run_code' && options.callId.endsWith(':derived')) derivedDispatches++
      return execute(options)
    }
    const callId = `${label}-edit`
    const edit = await runNestedEditCell(state, {
      session, agent, callId, signal: requestSignal,
      code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
      finalizeResult: result => ({ ...result, meta: finalizeMeta(result.meta) }),
    })
    assert.equal(edit.result.isError, false, JSON.stringify(edit.result))
    assert.equal(edit.receipt.accepted, true)
    assert.match(edit.raw.logs.at(-1), /edit_run_code settled \(target run_code call \d+/)
    assert.match(edit.raw.logs.at(-1), /; value: 2/)
    assert.equal(derivedDispatches, 1, 'derived source executed once before outer evidence was rejected')
    const callSeq = events.find(event => event.type === 'tool/call'
      && event.data.callId === callId).seq

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
    assert.deepEqual(dependent.raw.value, [1, 2])
    assert.equal(dependent.result.meta.dshPtcPlus.status, 'durable')
    appendRunCodeEvents(events, `${label}-dependent`, dependentCode, dependent.result)
    await state.dispose()

    const restored = fixture()
    t.after(() => restored.dispose())
    const coldResult = await restored.runDurable(
      session.id,
      'return [unconfirmedEditValue, afterUnconfirmedEdit]',
      {},
      { session, recordSession: 'deferred-result', callId: `${label}-cold` },
    )
    assert.equal(coldResult.isError, false, JSON.stringify(coldResult))
    assert.deepEqual(coldResult.value, [1, 2])
    appendRunCodeEvents(events, `${label}-cold`, 'return [unconfirmedEditValue, afterUnconfirmedEdit]', coldResult)
    const boundaries = events.flatMap(event => event.data?.meta?.[RECOVERY_BOUNDARY_KEY] ?? [])
    assert.equal(boundaries.length, 1)
    assert.deepEqual(boundaries[0], {
      failedCallSeq: callSeq,
      frontierCallSeq: setupEventSeqs.callSeq,
    })
  }
})

test('carries derived recovery boundaries through the outer edit result', async (t) => {
  const events = []
  const session = appendOnlySession('derived-recovery-boundary', events)
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  session.append('turn/start', { turn: 1 })
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: requestSignal },
  )
  const setupCode = 'let derivedBoundaryValue = 1; return derivedBoundaryValue'
  const setup = await state.runDurable(session.id, setupCode, {}, { session, recordSession: 'deferred-result', callId: 'derived-boundary-setup' })
  appendRunCodeEvents(events, 'derived-boundary-setup', setupCode, setup)

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
  const edit = await runNestedEditCell(state, {
    session, agent, callId: 'derived-boundary-edit', signal: requestSignal,
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
  })
  assert.equal(edit.result.isError, false, JSON.stringify(edit.result))
  assert.equal(edit.receipt.accepted, true)
  assert.deepEqual(edit.result.meta.dshPtcPlusPostEdit.meta[RECOVERY_BOUNDARY_KEY],
    [{ failedCallSeq: 9, frontierCallSeq: 1 }])
})
