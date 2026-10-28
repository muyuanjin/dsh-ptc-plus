import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
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
import { JOURNAL_KEY, RECOVERY_BOUNDARY_KEY } from '../internal/session-journal.js'
import { recoverJournal, visibleExecutableCallSeqs } from '../internal/session-journal-recovery.js'
import { readSessionLog } from '../internal/session-events.js'
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

test('submits a derived edit as one model batch on a host that keeps its transport in an executor', async t => {
  // This host's registry answers a complete model batch and assigns the
  // execution identity itself, so the derived edit must arrive as one accepted
  // batch call and settle from the result the host matched back to it.
  const session = Session.create('derived-edit-batch-dispatch')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', { turn: 1 })
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const singleCall = state.ctx.tools.execute
  const batches = []
  state.ctx.tools.selectExecutor = () => ({ describe: () => ({ knownNames: ['run_code'] }) })
  state.ctx.tools.execute = async options => {
    if (!Array.isArray(options?.calls)) return singleCall(options)
    batches.push(options.calls.map(call => call.name))
    const results = []
    for (const call of options.calls) {
      results.push({ callId: call.id, result: await singleCall({ ...options, callId: call.id,
        name: call.name, arguments: JSON.parse(call.arguments) }) })
    }
    return { results }
  }

  const setup = await state.runDurable(session.id, 'let batchDispatched = 1; return batchDispatched', {},
    { session, callId: 'batch-dispatch-setup' })
  assert.equal(setup.value, 1)
  assert.deepEqual(batches, [], 'a root cell is not a plugin-submitted batch')

  const edit = await runNestedEditCell(state, {
    session, agent, callId: 'batch-dispatch-edit', signal,
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
  })
  assert.equal(edit.result.isError, false, JSON.stringify(edit.result))
  assert.equal(edit.receipt.accepted, true, JSON.stringify(edit.receipt))
  assert.deepEqual(batches, [['run_code']])
  assert.match(edit.raw.logs.at(-1), /edit_run_code settled \(target run_code call \d+/)
  const events = sessionEvents(session)
  assert.equal(events.findLast(event => event.type === 'tool/ptc-dispatch')?.data.isError, false)
  assert.equal((await state.runDurable(session.id, 'return ++batchDispatched', {}, { session })).value, 3)
})

test('a host that mints its own batch identity still runs the accepted edit', async t => {
  // The executor contract assigns the execution identity of a submitted call, so
  // the parent token and root call the registry path compares belong to the host.
  // The relation the plugin owns is the call id it chose; losing it makes the
  // nested result arrive without an execution journal, the accepted edit fail
  // after acceptance, and the revision never apply.
  const session = Session.create('derived-edit-batch-identity')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', { turn: 1 })
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const singleCall = state.ctx.tools.execute
  state.ctx.tools.selectExecutor = () => ({ describe: () => ({ knownNames: ['run_code'] }) })
  state.ctx.tools.execute = async options => {
    if (!Array.isArray(options?.calls)) return singleCall(options)
    const results = []
    for (const call of options.calls) {
      results.push({ callId: call.id, result: await singleCall({ ...options, callId: call.id,
        name: call.name, arguments: JSON.parse(call.arguments),
        parent: Symbol('executor.execution'), rootCallId: call.id }) })
    }
    return { results }
  }

  const setup = await state.runDurable(session.id, 'let batchIdentified = 1; return batchIdentified', {},
    { session, callId: 'batch-identity-setup' })
  assert.equal(setup.value, 1)

  const edit = await runNestedEditCell(state, {
    session, agent, callId: 'batch-identity-edit', signal,
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
  })
  assert.equal(edit.result.isError, false, JSON.stringify(edit.result))
  assert.equal(edit.receipt.accepted, true, JSON.stringify(edit.receipt))
  assert.ok(edit.result.meta.dshPtcPlusPostEdit)
  assert.match(edit.raw.logs.at(-1), /edit_run_code settled \(target run_code call \d+/)
  assert.equal((await state.runDurable(session.id, 'return batchIdentified * 10',
    {}, { session })).value, 20)
})

test('background roots after a derived edit read their own official Session observation', async t => {
  const session = Session.create('derived-background-observation')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  session.append('turn/start', { turn: 0 })
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )
  await state.runDurable(session.id, 'let value = 1; return value', {},
    { session, callId: 'derived-background-setup' })
  let background
  const aroundExecute = state.listeners.get('tools/execute')[0]
  state.listeners.get('tools/execute')[0] = (exec, next) => aroundExecute(exec, async () => {
    if (exec.name === 'run_code' && exec.parent !== undefined) background = AsyncLocalStorage.snapshot()
    return next()
  })
  const edited = await runNestedEditCell(state, { session, agent, callId: 'derived-background-edit',
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })' })
  assert.equal(edited.result.isError, false, JSON.stringify(edited.result))
  const source = 'return ++value'
  const continued = await background(() => state.runDurable(session.id, source, {},
    { session, callId: 'derived-background-continued' }))
  assert.equal(continued.isError, false, JSON.stringify(continued))
  assert.equal(continued.value, 3)
  assert.equal(continued.meta[JOURNAL_KEY].diagnostics.some(item => item.code === 'PTC-R002'), false)
  const observation = await readSessionLog(session, state.ctx.sessionQuery)
  const history = recoverJournal(observation, undefined,
    { visibleCallSeqs: visibleExecutableCallSeqs(observation) })
  assert.equal(history.volatileSuffix.length, 0, JSON.stringify(history))
  assert.equal(history.nodes.at(-1).code, source)
  assert.equal(history.nodes.at(-1).callSeq, sessionEvents(session).find(event => (
    event.type === 'tool/call' && event.data.callId === 'derived-background-continued'
  )).seq)
  await state.emit('session/disposed', session)
  // A disposed identity starts empty by contract: the next cell sees no earlier
  // binding, reports how many cells the disposed environment held, and never
  // redispatches the editor.
  const recovered = await state.runDurable(session.id, 'return typeof value', {
    edit_run_code() { assert.fail('cold recovery redispatched the editor') },
  }, { session, callId: 'derived-background-recovered' })
  assert.equal(recovered.isError, false, JSON.stringify(recovered))
  assert.equal(recovered.value, 'undefined')
  const notices = (recovered.logs ?? []).concat(
    (recovered.meta?.[JOURNAL_KEY]?.diagnostics ?? []).map(item => item.message),
  )
  assert.equal(notices.some(text => /Restored the durable head and skipped \d+ unreconstructable historical cell/u.test(text)), true)
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
    // The live worker keeps the value the deferred edit produced; the surface no
    // longer proves the outer edit, but that is a view problem, not a reason to
    // replay the cell and lose what the worker holds.
    assert.deepEqual(dependent.raw.value, [2, 3])
    // Without a contraction the dependent cell keeps the live value and is marked
    // volatile, because the outer evidence for the derived edit was not preserved.
    assert.equal(dependent.result.meta.dshPtcPlus.status, 'volatile')
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
    // Across a restart the deferred edit's evidence is gone, so the cell cannot
    // be proved and the model is told which binding is missing instead of being
    // handed a silently replayed value.
    assert.equal(coldResult.isError, true, JSON.stringify(coldResult))
    assert.match(coldResult.error.message, /(unconfirmedEditValue|afterUnconfirmedEdit) is not defined/)
    assert.deepEqual(coldResult.value, undefined)
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
