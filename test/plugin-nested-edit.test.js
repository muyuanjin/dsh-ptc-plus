import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { editRejectedCell } from '../internal/rejected-cell-editor.js'
import { appendOnlySession, fixture, orderedSurfaceSession, ptcAgent, runNestedEditCell } from './plugin-fixture.js'
import { POST_EDIT_KEY, RECOVERY_BOUNDARY_KEY } from '../internal/session-journal-schema.js'
import { EDIT_TARGET_KEY, JOURNAL_KEY } from '../internal/session-journal.js'
import { IsolatedWorker, UNANSWERED_SAMPLE_CODE } from '../internal/isolated-worker.js'
import { createEditTransportOwner } from '../internal/edit-transport-owner.js'
import { decodeValue, encodeValue } from '../internal/value-wire.js'
import { REPL_MEMORY_META_KEY } from '../internal/repl-memory-projection.js'
import { validateSessionTimelineState, recoverJournal, recoveryBoundaryForHistory, visibleExecutableCallSeqs } from '../internal/session-journal-recovery.js'
import { createSessionLogProjection, projectSessionLog } from '../internal/session-log-view.js'

function projectedView(session) {
  const projection = createSessionLogProjection()
  let projected = projection.init()
  session.events.forEach((event, index) => { projected = projection.apply(projected, event, index) })
  projection.stateSchema.parse(JSON.parse(JSON.stringify(projected)))
  return projectSessionLog({ session }, undefined, projected)
}

test('an unmeasured derived execution keeps its root provable and leaves the edit target unchanged', async t => {
  const session = appendOnlySession('nested-edit-unmeasured-derived')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', {})
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const setup = await state.runDurable(session.id, 'let unmeasuredEditValue = 1; return unmeasuredEditValue', {},
    { session, callId: 'unmeasured-setup' })
  assert.equal(setup.value, 1)
  const targetCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data.callId === 'unmeasured-setup').seq

  // The derived execution is the first cell after the accepted edit, so its own
  // baseline is the one this stub refuses: the edit is accepted and never measured.
  const original = IsolatedWorker.prototype.sampleUtilization
  IsolatedWorker.prototype.sampleUtilization = function sampleDerived() {
    const derivedDispatched = session.events.some(event => event.type === 'tool/ptc-dispatch-start'
      && event.data?.name === 'run_code')
    if (derivedDispatched) {
      const error = new Error('kernel helper did not answer utilization sampling before its deadline')
      error.code = UNANSWERED_SAMPLE_CODE
      return Promise.reject(error)
    }
    return original.call(this)
  }
  const rootCode = 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })'
  try {
    const root = await runNestedEditCell(state, {
      session, agent, signal, callId: 'unmeasured-root', code: rootCode,
    })
    assert.equal(root.receipt.accepted, true)
    // The model must read that the revision never ran, not that it failed at runtime.
    const status = root.raw.logs.join('\n')
    assert.match(status, /did not execute the accepted revision/u)
    assert.doesNotMatch(status, /settled with execution error/u)
    const post = root.result.meta[POST_EDIT_KEY]
    // The accepted edit's own settlement is published and records that no source
    // ran, so the root cell keeps a provable relation.
    assert.equal(post.meta[EDIT_TARGET_KEY].targetCallSeq, targetCallSeq)
    assert.equal(post.meta[JOURNAL_KEY].status, 'noop')
    assert.equal(post.meta[JOURNAL_KEY].completion.error.kind, 'budget-unavailable')
    // The revised source never executed, so it neither publishes a binding nor
    // becomes the next editable cell.
    const view = projectedView(session)
    assert.equal(view.editableRun?.source, rootCode)
    assert.notEqual(view.editableRun?.source, 'let unmeasuredEditValue = 2; return unmeasuredEditValue')
    const inventory = root.result.meta.dshPtcPlusBindings
    assert.ok(inventory === undefined
      || !JSON.stringify(inventory).includes('unmeasuredEditValue = 2'))
  } finally {
    IsolatedWorker.prototype.sampleUtilization = original
  }

  // Cold recovery keeps the root cell and skips the unexecuted derived run.
  const recovery = recoverJournal(session, undefined,
    { visibleCallSeqs: visibleExecutableCallSeqs(session) })
  assert.equal(recovery.available, true, JSON.stringify(recovery))
  assert.equal(recovery.volatileSuffix.length, 0, JSON.stringify(recovery.volatileSuffix))
  assert.ok(recovery.nodes.some(node => node.callSeq === targetCallSeq),
    JSON.stringify(recovery.nodes.map(node => node.callSeq)))
  assert.ok(recovery.nodes.every(node => node.code !== 'let unmeasuredEditValue = 2; return unmeasuredEditValue'))

  // A fresh runtime on the same session log proves the same two facts: the root
  // binding is usable and the revision never became state.
  session.append('turn/end', {})
  session.append('turn/start', {})
  await state.dispose()
  const restored = fixture()
  t.after(() => restored.dispose())
  const cold = await restored.runDurable(session.id, 'return unmeasuredEditValue', {
    edit_run_code: async () => { throw new Error('cold replay redispatched an unexecuted revision') },
  }, { session, callId: 'unmeasured-cold' })
  assert.equal(cold.value, 1, JSON.stringify(cold))
})

test('nested edit receipt schedules a revised cell after the root worker finishes', async t => {
  const session = appendOnlySession('nested-edit-receipt')
  session.append('turn/start', { turn: 0 })
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  state.listeners.get('tools/result').unshift((exec, result) => {
    if (exec.name === 'edit_run_code' && !result.isError) {
      result.content = [{ type: 'text', text: 'Host-presented edit receipt' }]
    }
  })
  const setup = await state.runDurable(session.id, 'let nestedEditValue = 1; return nestedEditValue', {},
    { session, callId: 'nested-edit-setup' })
  assert.equal(setup.value, 1)

  const derivedBlocks = [
    { type: 'text', text: 'Derived output retained at result locator' },
    { type: 'image', attachment: { id: 'derived-image' } },
  ]
  const derivedContext = { content: [{ type: 'text', text: 'Derived nested context' }],
    source: { kind: 'ptc-mode' } }
  const originalExecute = state.ctx.tools.execute
  state.ctx.tools.execute = async options => {
    const result = await originalExecute(options)
    return options.name === 'run_code'
      ? { ...result, content: derivedBlocks, additionalContexts: [derivedContext], concludesTurn: true }
      : result
  }

  const rootCallId = 'nested-edit-root'
  const subCallId = `${rootCallId}:ptc:1`
  const editArguments = { edits: [{ old_string: '= 1', new_string: '= 2' }] }
  const editTools = { edit_run_code: async args => {
      const data = { rootCallId, parentCallId: rootCallId, subCallId,
        name: 'edit_run_code', arguments: args }
      session.append('tool/ptc-dispatch-start', data)
      const result = await state.ctx.tools.execute({
        callId: subCallId, rootCallId, parent: {}, name: 'edit_run_code',
        arguments: args, agent, signal,
      })
      session.append('tool/ptc-dispatch', { ...data, isError: result.isError,
        content: result.content })
      if (result.isError) throw new Error(result.error.message)
      return result.value
    } }
  const root = await state.executeRun(session.id,
    'const edit = tools.edit_run_code; const receipt = await edit({ edits: [{ old_string: "= 1", new_string: "= 2" }] }); return [receipt.accepted, nestedEditValue]',
    editTools,
    { session, callId: rootCallId })
  assert.equal(root.result.isError, false, JSON.stringify(root.result))
  assert.deepEqual(root.result.value, [true, 1])
  assert.deepEqual(session.events.find(event => event.type === 'tool/ptc-dispatch'
    && event.data?.subCallId === subCallId).data.content,
  [{ type: 'text', text: 'Host-presented edit receipt' }])
  assert.deepEqual(root.result.content, derivedBlocks)
  assert.deepEqual(root.result.additionalContexts, [derivedContext])
  assert.equal(root.result.concludesTurn, true)
  assert.ok(root.result.meta?.[POST_EDIT_KEY])
  assert.match(root.raw.logs?.at(-1) ?? '', /edit_run_code settled/)
  assert.match(root.result.meta[REPL_MEMORY_META_KEY].memory.entries
    .find(entry => entry.name === 'nestedEditValue').definition.source, /= 2/)
  assert.equal(projectedView(session).editableRun.source,
    'let nestedEditValue = 2; return nestedEditValue')

  const beforeContinue = recoverJournal(session, undefined,
    { visibleCallSeqs: visibleExecutableCallSeqs(session) })
  assert.equal(beforeContinue.volatileSuffix.length, 0, JSON.stringify(beforeContinue))
  assert.deepEqual(beforeContinue.nodes.map(node => node.callSeq), [2, 5, 8], JSON.stringify(beforeContinue))
  assert.deepEqual([...visibleExecutableCallSeqs(session)].sort((a, b) => a - b), [2, 5, 8])

  const secondRootCallId = 'nested-edit-second-root'
  const secondSubCallId = `${secondRootCallId}:ptc:1`
  const secondTools = { edit_run_code: async args => {
    const data = { rootCallId: secondRootCallId, parentCallId: secondRootCallId,
      subCallId: secondSubCallId, name: 'edit_run_code', arguments: args }
    session.append('tool/ptc-dispatch-start', data)
    const result = await state.ctx.tools.execute({
      callId: secondSubCallId, rootCallId: secondRootCallId, parent: {},
      name: 'edit_run_code', arguments: args, agent, signal,
    })
    session.append('tool/ptc-dispatch', { ...data, isError: result.isError, content: result.content })
    if (result.isError) throw new Error(result.error.message)
    return result.value
  } }
  const second = await state.executeRun(session.id,
    'return await tools.edit_run_code({ edits: [{ old_string: "= 2", new_string: "= 3" }] })',
    secondTools, { session, callId: secondRootCallId })
  assert.equal(second.result.isError, false, JSON.stringify(second.result))
  assert.equal(second.result.value.target_call_seq, 8)
  assert.equal(second.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code,
    'let nestedEditValue = 3; return nestedEditValue')
  assert.equal(projectedView(session).editableRun.source,
    'let nestedEditValue = 3; return nestedEditValue')

  const continued = await state.runDurable(session.id, 'return nestedEditValue', secondTools,
    { session, callId: 'nested-edit-continued' })
  assert.equal(continued.value, 3)

  await state.dispose()
  const restored = fixture()
  t.after(() => restored.dispose())
  const restoredAgent = ptcAgent(session.id, session)
  await restored.assemble(
    { sections: [], contexts: [], variables: {}, tools: [restored.runCodeDefinition] },
    { agent: restoredAgent, scope: restoredAgent, signal },
  )
  const cold = await restored.runDurable(session.id, 'return nestedEditValue',
    { edit_run_code: async () => { throw new Error('cold replay repeated edit effect') } },
    { session, callId: 'nested-edit-cold' })
  assert.equal(cold.value, 3, JSON.stringify(cold))

  const visibleBefore = session.surface.nodes
  Object.defineProperty(session.surface, 'nodes', {
    get() { return visibleBefore.filter(seq => seq !== 4) },
  })
  const contracted = await restored.runDurable(session.id, 'return nestedEditValue',
    { edit_run_code: async () => { throw new Error('hidden edit repeated effect') } },
    { session, callId: 'nested-edit-hidden' })
  // Hiding the surface node that carried the edit is a view change: the live
  // worker keeps the edited value, and the edit is never redispatched (the stub
  // above throws if it were).
  assert.equal(contracted.value, 3)
})

test('settled root and nested call IDs can be reused with exact source ancestry', async t => {
  const session = appendOnlySession('nested-edit-reused-ids')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', {})
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const starts = []
  for (const value of [2, 3]) {
    const setupCallId = `reused-setup-${value}`
    const setup = await state.runDurable(session.id,
      `let reusedEditValue = ${value - 1}; return reusedEditValue`, {},
      { session, callId: setupCallId })
    assert.equal(setup.value, value - 1)
    assert.ok(setup.meta.dshPtcPlus.diagnostics.every(item => item.code !== 'PTC-R002'))
    const targetCallSeq = session.events.find(event => event.type === 'tool/call'
      && event.data.callId === setupCallId).seq
    const root = await runNestedEditCell(state, {
      session, agent, signal, callId: 'reused-root',
      code: `return await tools.edit_run_code({ edits: [{ old_string: "= ${value - 1}", new_string: "= ${value}" }] })`,
    })
    assert.equal(root.result.isError, false, JSON.stringify(root.result))
    assert.equal(root.result.value.accepted, true)
    const post = root.result.meta[POST_EDIT_KEY]
    assert.equal(root.result.value.target_call_seq, targetCallSeq)
    starts.push(post.executionStartSeq)
    assert.ok(visibleExecutableCallSeqs(session).has(post.executionStartSeq))
    assert.equal(projectedView(session).editableRun.callSeq, post.executionStartSeq)
    assert.equal(projectedView(session).editableRun.source,
      `let reusedEditValue = ${value}; return reusedEditValue`)
    session.append('turn/end', {})
    session.append('turn/start', {})
  }
  const recovery = recoverJournal(session, undefined,
    { visibleCallSeqs: visibleExecutableCallSeqs(session) })
  assert.equal(recovery.available, true, JSON.stringify(recovery))
  assert.equal(recovery.volatileSuffix.length, 0)
  assert.ok(starts.every(seq => recovery.nodes.some(node => node.callSeq === seq)), JSON.stringify(recovery))
  const continued = await state.runDurable(session.id, 'return reusedEditValue', {},
    { session, callId: 'reused-continuation' })
  assert.equal(continued.value, 3)

  await state.dispose()
  const restored = fixture()
  t.after(() => restored.dispose())
  const cold = await restored.runDurable(session.id, 'return reusedEditValue', {
    edit_run_code: async () => { throw new Error('cold replay redispatched a reused editor ID') },
  }, { session, callId: 'reused-cold' })
  assert.equal(cold.value, 3, JSON.stringify(cold))
})

test('actual derived dispatch records its parent and public retained result without changing source evidence', async t => {
  const session = appendOnlySession('nested-edit-real-dispatch')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', {})
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  await state.runDurable(session.id, 'let recordedEditValue = 1; return recordedEditValue', {},
    { session, callId: 'recorded-setup' })
  let rootExec
  let derivedExec
  const aroundExecute = state.listeners.get('tools/execute')[0]
  state.listeners.get('tools/execute')[0] = (exec, next) => {
    if (exec.name === 'run_code' && exec.callId === 'recorded-root') rootExec = exec
    if (exec.name === 'run_code' && exec.parent !== undefined) derivedExec = exec
    return aroundExecute(exec, next)
  }
  const retained = [{ type: 'text', text: 'Host retained derived content' }]
  state.listeners.set('tools/ptc-dispatch-log', [(dispatch, next) => {
    assert.equal(dispatch.exec.token, rootExec.token)
    assert.equal(dispatch.exec.name, 'run_code')
    assert.equal(dispatch.agent, agent)
    return retained
  }])
  const root = await runNestedEditCell(state, { session, agent, signal, callId: 'recorded-root',
    code: 'return await tools.edit_run_code({edits:[{old_string:"= 1",new_string:"= 2"}]})',
  })
  assert.equal(root.receipt.accepted, true)
  assert.equal(derivedExec.parent, rootExec.token)
  const post = root.result.meta[POST_EDIT_KEY]
  const start = session.events.find(event => event.seq === post.executionStartSeq)
  const settled = session.events.find(event => event.type === 'tool/ptc-dispatch'
    && event.data.subCallId === derivedExec.callId)
  assert.equal(start.data.parentCallId, rootExec.callId)
  assert.equal(start.data.rootCallId, rootExec.rootCallId)
  assert.equal(start.data.subCallId, derivedExec.callId)
  assert.deepEqual(start.data.arguments, derivedExec.arguments)
  assert.deepEqual(settled.data.content, retained)
  assert.deepEqual(settled.data.meta.dshPtcPlus, post.meta.dshPtcPlus)
  assert.equal(projectedView(session).editableRun.callSeq, start.seq)

  state.listeners.set('tools/ptc-dispatch-log', [() => {
    throw new Error('Host retained-log projector failed')
  }])
  const fallback = await runNestedEditCell(state, { session, agent, signal,
    callId: 'recorded-fallback',
    code: 'return await tools.edit_run_code({edits:[{old_string:"= 2",new_string:"= 3"}]})',
  })
  assert.equal(fallback.receipt.accepted, true)
  const fallbackStart = fallback.result.meta[POST_EDIT_KEY].executionStartSeq
  const fallbackEvent = session.events.find(event => event.seq === fallbackStart)
  const fallbackSettled = session.events.find(event => event.type === 'tool/ptc-dispatch'
    && event.data.subCallId === fallbackEvent.data.subCallId)
  assert.deepEqual(fallbackSettled.data.content, fallback.result.content)
  assert.equal(projectedView(session).editableRun.source,
    'let recordedEditValue = 3; return recordedEditValue')

  const mutations = [
    events => { events.find(event => event.type === 'tool/call' && event.data.callId === 'recorded-root').data.arguments = '{}' },
    events => { events.find(event => event.seq === settled.seq).data.isError = true },
    events => { events.find(event => event.type === 'tool/result' && event.data.message?.source?.callId === 'recorded-root')
      .data.meta.dshPtcPlus.calls.find(call => call.member === 'edit_run_code').value = encodeValue({ accepted: true, scheduled: true, target_call_seq: 999 }) },
    events => { events.find(event => event.type === 'tool/result' && event.data.message?.source?.callId === 'recorded-root')
      .data.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.description = 'different edit' },
    events => { events.find(event => event.type === 'tool/result' && event.data.message?.source?.callId === 'recorded-root')
      .data.meta.dshPtcPlus.calls.find(call => call.member === 'edit_run_code').value = { type: 'unknown-wire-tag' } },
  ]
  for (const mutate of mutations) {
    const damaged = { events: structuredClone(session.events), surface: session.surface }
    mutate(damaged.events)
    const contracted = recoverJournal(damaged, undefined,
      { visibleCallSeqs: visibleExecutableCallSeqs(damaged) })
    assert.equal(contracted.available, false)
    assert.deepEqual(contracted.nodes.map(node => node.code),
      ['let recordedEditValue = 1; return recordedEditValue'])
  }
  const recoveryUrl = new URL('../internal/session-journal-recovery.js?deferred-edit-fault', import.meta.url).href
  const editorUrl = new URL('../internal/rejected-cell-editor.js', import.meta.url).href
  const fixtureUrl = new URL('./deferred-edit-editor-fixture.js', import.meta.url).href
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    return context.parentURL === recoveryUrl && resolved.url === editorUrl
      ? next(fixtureUrl, context) : resolved
  } })
  t.after(() => hooks.deregister())
  t.mock.module(fixtureUrl, { namedExports: { editRejectedCell: (...args) => {
    if (args[0].edits?.[0]?.new_string === '= 2') throw new Error('deferred editor reconstruction failed')
    return editRejectedCell(...args)
  } } })
  const faultedRecovery = await import(recoveryUrl)
  const contracted = faultedRecovery.recoverJournal(session, undefined,
    { visibleCallSeqs: faultedRecovery.visibleExecutableCallSeqs(session) })
  assert.equal(contracted.available, false)
  assert.deepEqual(contracted.nodes.map(node => node.code), ['let recordedEditValue = 1; return recordedEditValue'])
  hooks.deregister()
  const projection = createSessionLogProjection()
  let checkpoint = projection.init()
  session.events.forEach((event, index) => { checkpoint = projection.apply(checkpoint, event, index) })
  assert.doesNotThrow(() => validateSessionTimelineState(checkpoint.timeline))
  const wrongTarget = structuredClone(checkpoint.timeline)
  wrongTarget.eventFacts.find(fact => fact.event.seq === post.startSeq).selectedTarget.source = 'return 999'
  assert.throws(() => validateSessionTimelineState(wrongTarget), /nested edit target fact/)
  const wrongDerived = structuredClone(checkpoint.timeline)
  wrongDerived.eventFacts.find(fact => fact.normalized?.postEdit).normalized.postEdit.derived.description = 'changed description'
  assert.throws(() => validateSessionTimelineState(wrongDerived), /deferred edit fact/)

})

test('failed actual derived event publication contracts future state without repeating execution', async t => {
  for (const phase of ['start', 'settle']) {
    await t.test(phase, async t => {
      const session = appendOnlySession(`nested-edit-publication-${phase}`)
      const state = fixture()
      t.after(() => state.dispose())
      const agent = ptcAgent(session.id, session)
      const signal = new AbortController().signal
      session.append('turn/start', {})
      await state.assemble(
        { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
        { agent, scope: agent, signal },
      )
      await state.runDurable(session.id, 'let publicationValue = 1; return publicationValue', {},
        { session, callId: 'publication-setup' })
      let executions = 0
      const execute = state.ctx.tools.execute
      state.ctx.tools.execute = options => {
        if (options.name === 'run_code') executions++
        return execute(options)
      }
      const append = session.append.bind(session)
      session.append = (type, data) => {
        if (data?.name === 'run_code'
          && type === (phase === 'start' ? 'tool/ptc-dispatch-start' : 'tool/ptc-dispatch')) {
          throw new Error(`derived ${phase} publication failed`)
        }
        return append(type, data)
      }
      const root = await runNestedEditCell(state, { session, agent, signal,
        callId: 'publication-root',
        code: 'return await tools.edit_run_code({edits:[{old_string:"= 1",new_string:"= 2"}]})',
      })
      assert.equal(root.receipt.accepted, true)
      assert.match(root.raw.logs.at(-1), new RegExp(`derived ${phase} publication failed`))
      assert.equal(root.result.meta[POST_EDIT_KEY], undefined)
      assert.equal(executions, phase === 'start' ? 0 : 1)
      session.append = append
      const continued = await state.runDurable(session.id, 'return publicationValue', {},
        { session, callId: 'publication-continued' })
      // The failed derived publication leaves the live worker in charge, so the
      // continuation reads the value that worker holds instead of replaying a
      // recorded one; the edit is still not re-executed. A start-phase failure
      // never ran the edit, so the value stays at its pre-edit value.
      assert.equal(continued.value, phase === 'start' ? 1 : 2)
      assert.equal(executions, phase === 'start' ? 0 : 1)
    })
  }
})

test('proved derived recovery boundaries retain their parent and later carrier without replaying effects', async t => {
  const session = appendOnlySession('nested-edit-derived-boundary')
  let effects = 0
  const frontierEffect = async ({ value }) => { effects++; return value }
  const state = fixture({}, { schemas: [{ name: 'frontierEffect',
    parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    execute: frontierEffect }] })
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', {})
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const functions = { frontierEffect }
  const execute = state.ctx.tools.execute
  state.ctx.tools.execute = options => execute(options.name === 'run_code'
    ? { ...options, bindings: functions } : options)
  await state.runDurable(session.id,
    'let frontierValue=await tools.frontierEffect({value:1}); return frontierValue', functions,
    { session, callId: 'frontier-setup' })
  const root = await runNestedEditCell(state, { session, agent, signal,
    callId: 'frontier-root', functions,
    code: 'return await tools.edit_run_code({edits:[{old_string:"value:1",new_string:"value:2"}]})',
  })
  assert.equal(root.receipt.accepted, true)
  assert.equal(effects, 2, JSON.stringify(root))
  const visible = visibleExecutableCallSeqs(session)
  const before = recoverJournal(session, undefined, { visibleCallSeqs: visible })
  assert.equal(before.available, true, JSON.stringify(before))
  assert.equal(before.volatileSuffix.length, 0)
  const failed = before.nodes.at(-1)
  const boundary = recoveryBoundaryForHistory(before, failed)
  assert.equal(boundary.failedCallSeq, root.result.meta[POST_EDIT_KEY].executionStartSeq)
  const contracted = recoverJournal(session, undefined,
    { visibleCallSeqs: visible, extraBoundaries: [boundary] })
  assert.equal(contracted.available, true, JSON.stringify(contracted))
  assert.equal(contracted.volatileSuffix.length, 0)
  assert.deepEqual(contracted.nodes.map(node => node.callSeq),
    before.nodes.slice(0, -1).map(node => node.callSeq))
  assert.equal(contracted.nodes[contracted.head].callSeq, boundary.frontierCallSeq)

  for (const damage of ['missing-settle', 'wrong-parent', 'duplicate-start', 'duplicate-settle',
    'duplicate-editor-start', 'duplicate-editor-settle', 'missing-root-proof']) {
    const events = structuredClone(session.events)
    const executionStart = events.find(event => event.seq === boundary.failedCallSeq)
    const settledIndex = events.findIndex(event => event.type === 'tool/ptc-dispatch'
      && event.data.subCallId === executionStart.data.subCallId)
    let damagedBoundary = boundary
    if (damage === 'missing-settle') events.splice(settledIndex, 1)
    if (damage === 'wrong-parent') executionStart.data.parentCallId = 'unproved-parent'
    if (damage.startsWith('duplicate-')) {
      const editor = damage.startsWith('duplicate-editor-')
      const pairStart = editor
        ? events.find(event => event.seq === root.result.meta[POST_EDIT_KEY].startSeq)
        : executionStart
      const pairSettledIndex = events.findIndex(event => event.type === 'tool/ptc-dispatch'
        && event.data.subCallId === pairStart.data.subCallId)
      const duplicateStart = damage.endsWith('-start')
      const insertedIndex = pairSettledIndex + (duplicateStart ? 0 : 1)
      const duplicate = structuredClone(duplicateStart ? pairStart : events[pairSettledIndex])
      const duplicateSeq = events[insertedIndex].seq
      const remap = seq => seq >= duplicateSeq ? seq + 1 : seq
      for (const event of events) {
        event.seq = remap(event.seq)
        if (event.sourceEventSeqs !== undefined) event.sourceEventSeqs = event.sourceEventSeqs.map(remap)
        const post = event.data.meta?.[POST_EDIT_KEY]
        if (post !== undefined) {
          for (const key of ['rootCallSeq', 'startSeq', 'executionStartSeq']) post[key] = remap(post[key])
        }
      }
      events.splice(insertedIndex, 0, { ...duplicate, seq: duplicateSeq })
      damagedBoundary = { ...boundary, failedCallSeq: remap(boundary.failedCallSeq),
        frontierCallSeq: remap(boundary.frontierCallSeq) }
    }
    if (damage === 'missing-root-proof') {
      delete events.find(event => event.type === 'tool/result'
        && event.data.meta?.[POST_EDIT_KEY] !== undefined).data.meta[POST_EDIT_KEY]
    }
    const damaged = orderedSurfaceSession(`derived-boundary-${damage}`, events)
    const damagedVisible = visibleExecutableCallSeqs(damaged)
    assert.deepEqual(damaged.surface.nodes, events.filter(event => (
      ['user/message', 'assistant/message', 'tool/result'].includes(event.type)
    )).map(event => event.seq), damage)
    assert.ok(damagedVisible.has(before.nodes[0].callSeq), damage)
    assert.ok(damagedVisible.has(boundary.frontierCallSeq), damage)
    const unproved = recoverJournal(damaged, undefined, { visibleCallSeqs: damagedVisible })
    assert.equal(unproved.available, false, damage)
    assert.match(unproved.volatileSuffix.map(item => item.reason).join('\n'),
      /unproved deferred edit:/, damage)
    if (damage.startsWith('duplicate-')) {
      assert.match(unproved.volatileSuffix.map(item => item.reason).join('\n'),
        /dispatch pair is incomplete or ambiguous/, damage)
    }
    const rejected = recoverJournal(damaged, undefined,
      { visibleCallSeqs: damagedVisible, extraBoundaries: [damagedBoundary] })
    assert.equal(rejected.available, false, damage)
    assert.ok(rejected.nodes.every(node => node.callSeq !== damagedBoundary.failedCallSeq), damage)
  }
  const wrongFrontier = recoverJournal(session, undefined, { visibleCallSeqs: visible,
    extraBoundaries: [{ ...boundary, frontierCallSeq: before.nodes[0].callSeq }] })
  assert.equal(wrongFrontier.available, false)
  assert.match(wrongFrontier.volatileSuffix[0].reason, /frontier does not match/)

  const carrier = await state.executeRun(session.id,
    'let validAfterBoundary=7; return validAfterBoundary', functions,
    { session, callId: 'frontier-carrier', finalizeResult(result) {
      return { ...result, meta: { ...result.meta, [RECOVERY_BOUNDARY_KEY]: [boundary] } }
    } })
  assert.equal(carrier.result.value, 7)
  const persisted = recoverJournal(session, undefined,
    { visibleCallSeqs: visibleExecutableCallSeqs(session) })
  assert.equal(persisted.available, true, JSON.stringify(persisted))
  assert.equal(persisted.volatileSuffix.length, 0)
  assert.ok(persisted.nodes.some(node => node.code.includes('validAfterBoundary')))
  projectedView(session)
  assert.equal(session.events.filter(event => event.type === 'tool/result'
    && event.data.meta?.[RECOVERY_BOUNDARY_KEY]?.some(item =>
      item.failedCallSeq === boundary.failedCallSeq)).length, 1)

  await state.dispose()
  const restored = fixture()
  t.after(() => restored.dispose())
  const cold = await restored.runDurable(session.id, 'return [frontierValue, validAfterBoundary]', {
    frontierEffect: async () => { throw new Error('contracted recovery repeated an effect') },
    edit_run_code: async () => { throw new Error('contracted recovery repeated an editor') },
  }, { session, callId: 'frontier-cold' })
  assert.deepEqual(cold.value, [1, 7], JSON.stringify(cold))
  assert.ok(cold.meta.dshPtcPlus.diagnostics.every(item => item.code !== 'PTC-R002'))
  assert.equal(effects, 2)
})

test('nested projector omissions use private evidence only while Host retains the canonical value', async t => {
  for (const decision of ['accept', 'content', 'replace-value', 'block', 'no-capture',
    'projected-meta-removal', 'root-meta-removal']) {
    await t.test(decision, async t => {
      const session = appendOnlySession(`nested-projector-${decision}`)
      session.append('turn/start', {})
      const state = fixture({}, { skipNestedPresentationMeta: decision !== 'projected-meta-removal' })
      t.after(() => state.dispose())
      const agent = ptcAgent(session.id, session)
      const signal = new AbortController().signal
      await state.assemble(
        { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
        { agent, scope: agent, signal },
      )
      await state.runDurable(session.id, 'let sidecarValue=1; return {value:sidecarValue}', {},
        { session, callId: 'sidecar-setup' })
      const content = [{ type: 'text', text: 'Host policy retained this presentation' }]
      const contexts = [{ content: [{ type: 'text', text: 'Host policy context' }] }]
      let finalInner
      state.listeners.get('tools/result').push((exec, result) => {
        if (exec.name === 'run_code' && exec.parent !== undefined) finalInner = result
      })
      state.listeners.set('tools/post-execute', [async (exec, result, next) => {
        if (exec.name !== 'run_code') return next()
        if (exec.parent === undefined) {
          if (decision === 'root-meta-removal') delete result.meta
          return next()
        }
        if (decision === 'projected-meta-removal') delete result.meta
        if (decision === 'replace-value') return { kind: 'accept', value: { replaced: true } }
        if (decision === 'block') return { kind: 'block', feedback: content }
        if (decision === 'content') return { kind: 'accept', content, additionalContexts: contexts }
        return next()
      }])
      if (decision === 'no-capture') state.runCodeDefinition.projectContent = () => undefined
      const root = await runNestedEditCell(state, { session, agent, signal,
        callId: 'sidecar-root',
        code: 'return await tools.edit_run_code({edits:[{old_string:"sidecarValue=1",new_string:"sidecarValue=2"}]})',
      })
      assert.equal(root.receipt.accepted, true)
      assert.deepEqual(root.result.value, root.receipt)
      const published = root.result.meta?.[POST_EDIT_KEY]
      const proved = decision === 'accept' || decision === 'content'
      assert.equal(published !== undefined, proved, JSON.stringify(root))
      const derived = session.events.find(event => event.type === 'tool/ptc-dispatch'
        && event.data.name === 'run_code')
      assert.deepEqual(derived.data.content, finalInner.content)
      assert.equal(derived.data.isError, finalInner.isError)
      if (decision !== 'replace-value') assert.equal(finalInner.meta, undefined)
      if (proved) {
        assert.ok(derived.data.meta?.dshPtcPlus)
        assert.deepEqual(derived.data.meta.dshPtcPlus, published.meta.dshPtcPlus)
        if (decision === 'content') {
          assert.deepEqual(root.result.content, content)
          assert.deepEqual(root.result.additionalContexts, contexts)
        }
        await state.dispose()
        const restored = fixture()
        t.after(() => restored.dispose())
        const cold = await restored.runDurable(session.id, 'return sidecarValue', {
          edit_run_code: async () => { throw new Error('sidecar cold replay repeated editor') },
        }, { session, callId: 'sidecar-cold' })
        assert.equal(cold.value, 2)
      } else {
        if (decision === 'root-meta-removal') assert.ok(derived.data.meta?.dshPtcPlus)
        else assert.equal(derived.data.meta?.dshPtcPlus, undefined)
        const start = session.events.find(event => event.type === 'tool/ptc-dispatch-start'
          && event.data.subCallId === derived.data.subCallId)
        assert.ok(recoverJournal(session, undefined,
          { visibleCallSeqs: visibleExecutableCallSeqs(session) }).nodes
          .every(node => node.callSeq !== start.seq))
      }
    })
  }
})

test('session disposal after an accepted nested edit prevents derived dispatch', async t => {
  const session = appendOnlySession('nested-edit-disposed')
  session.append('turn/start', { turn: 0 })
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  await state.runDurable(session.id, 'let disposalValue = 1; return disposalValue', {},
    { session, callId: 'disposed-setup' })
  let releaseHold
  let enteredHold
  const holding = new Promise(resolve => { enteredHold = resolve })
  const hold = new Promise(resolve => { releaseHold = resolve })
  let derivedCalls = 0
  const originalExecute = state.ctx.tools.execute
  state.ctx.tools.execute = options => {
    if (options.name === 'run_code') derivedCalls += 1
    return originalExecute(options)
  }
  const rootCallId = 'disposed-edit-root'
  const subCallId = `${rootCallId}:ptc:1`
  const pending = state.executeRun(session.id,
    'await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] }); await tools.hold(); return 1',
    { edit_run_code: async args => {
      const data = { rootCallId, parentCallId: rootCallId, subCallId,
        name: 'edit_run_code', arguments: args }
      session.append('tool/ptc-dispatch-start', data)
      const result = await state.ctx.tools.execute({ callId: subCallId, rootCallId,
        parent: {}, name: 'edit_run_code', arguments: args, agent, signal })
      session.append('tool/ptc-dispatch', { ...data, isError: result.isError, content: result.content })
      return result.value
    }, hold: async () => { enteredHold(); await hold } },
    { session, callId: rootCallId })
  await holding
  await state.emit('session/disposed', session)
  releaseHold()
  await pending
  assert.equal(derivedCalls, 0)
})

test('nested edit can revise a live volatile cell through the session projection', async t => {
  const session = appendOnlySession('nested-edit-volatile')
  session.append('turn/start', { turn: 0 })
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const source = 'let volatileEditValue = Date.now(); return volatileEditValue'
  const first = await state.runDurable(session.id, source, {}, { session, callId: 'volatile-setup' })
  assert.equal(first.meta.dshPtcPlus.status, 'volatile')
  assert.equal(projectedView(session).editableRun.source, source)

  const rootCallId = 'volatile-edit-root'
  const subCallId = `${rootCallId}:ptc:1`
  const tools = { edit_run_code: async args => {
    const data = { rootCallId, parentCallId: rootCallId, subCallId,
      name: 'edit_run_code', arguments: args }
    session.append('tool/ptc-dispatch-start', data)
    const result = await state.ctx.tools.execute({
      callId: subCallId, rootCallId, parent: {}, name: 'edit_run_code',
      arguments: args, agent, signal,
    })
    session.append('tool/ptc-dispatch', { ...data, isError: result.isError, content: result.content })
    if (result.isError) throw new Error(result.error.message)
    return result.value
  } }
  const edited = await state.executeRun(session.id,
    'return await tools.edit_run_code({ edits: [{ old_string: "Date.now()", new_string: "Date.now() + 1" }] })',
    tools, { session, callId: rootCallId })
  assert.equal(edited.result.value.accepted, true)
  assert.equal(projectedView(session).editableRun.source,
    'let volatileEditValue = Date.now() + 1; return volatileEditValue')
  const derivedJournal = edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlus
  assert.equal(derivedJournal.status, 'volatile')
  const revisedValue = decodeValue(derivedJournal.completion.value)
  const continued = await state.runDurable(session.id, 'return volatileEditValue', {},
    { session, callId: 'volatile-edit-continued' })
  assert.equal(continued.value, revisedValue)
  assert.ok(continued.meta.dshPtcPlus.diagnostics.every(item => item.code !== 'PTC-R002'))
})

test('an edit refolds the hot cell the retention budget dropped from the checkpoint', async t => {
  // The payload budget can remove the newest cell from the checkpoint, which also
  // removes the run an edit would capture. The log still holds it, so the edit path
  // refolds that slice: without the refold the cell would be reported as ineligible
  // even though the user is looking at it.
  const session = appendOnlySession('nested-edit-hot-cell')
  session.append('turn/start', { turn: 0 })
  // One retained cluster means the older cell folds into the interval summary, and a
  // source the payload budget cannot hold makes the newest cell the dropped one. The
  // source stays under the edited-source budget, so the refolded target is editable.
  const state = fixture({ retentionClusters: 1, retentionPayloadRuns: 8, retentionPayloadBytes: 1048576 })
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  await state.runDurable(session.id, 'const retainedNeighbour = 1', {}, { session, callId: 'hot-cell-neighbour' })
  const padding = 'x'.repeat(600 * 1024)
  const targetSource = `/* ${padding} */\nlet hotCellValue = 2`
  await state.runDurable(session.id, targetSource, {}, { session, callId: 'hot-cell-target' })
  const dropped = projectSessionLog({ session })
  assert.equal(dropped.hotCellDropped, true, 'the newest cell no longer carries its payload')
  assert.equal(dropped.editableRun, undefined, 'the checkpoint offers no edit target')
  assert.equal(dropped.retentionSummary?.count, 1, 'the older cell folded into the summary')

  const root = await runNestedEditCell(state, {
    session, agent, signal, callId: 'hot-cell-edit-root',
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "hotCellValue = 2", new_string: "hotCellValue = 3" }] })',
  })
  assert.equal(root.receipt.accepted, true, JSON.stringify(root.raw.logs))
  assert.equal(root.receipt.target_call_seq, session.events.find(event => event.type === 'tool/call'
    && event.data?.callId === 'hot-cell-target').seq)
  const continued = await state.runDurable(session.id, 'return hotCellValue', {}, { session, callId: 'hot-cell-continued' })
  assert.equal(continued.value, 3, 'the revised cell ran and published its value')
})

test('accepted nested edit executes after a root throw while the root result stays failed', async t => {
  const session = appendOnlySession('nested-edit-root-throw')
  session.append('turn/start', { turn: 0 })
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  await state.runDurable(session.id, 'let rootThrowValue = 1; return rootThrowValue', {},
    { session, callId: 'root-throw-setup' })
  const root = await runNestedEditCell(state, { session, agent, signal, callId: 'root-throw-edit',
    code: 'await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] }); throw new Error("root failed")',
  })
  assert.equal(root.result.isError, true)
  assert.match(root.result.error.message, /root failed/)
  assert.equal(root.result.meta.dshPtcPlus.completion.kind, 'throw')
  assert.equal(root.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code,
    'let rootThrowValue = 2; return rootThrowValue')
  assert.equal(projectedView(session).editableRun.source,
    'let rootThrowValue = 2; return rootThrowValue')
  const continued = await state.runDurable(session.id, 'return rootThrowValue', {
    edit_run_code: async () => { throw new Error('live retry redispatched edit') },
  }, { session, callId: 'root-throw-continued' })
  assert.equal(continued.value, 2)

  await state.dispose()
  const restored = fixture()
  t.after(() => restored.dispose())
  const cold = await restored.runDurable(session.id, 'return rootThrowValue', {
    edit_run_code: async () => { throw new Error('cold replay redispatched edit') },
  }, { session, callId: 'root-throw-cold' })
  assert.equal(cold.value, 2)
})

test('a root cell accepts one edit while surrounding code continues with its old bindings', async t => {
  const session = appendOnlySession('nested-edit-once')
  session.append('turn/start', {})
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  await state.runDurable(session.id, 'let onceEditValue = 1; return onceEditValue', {},
    { session, callId: 'once-setup' })
  let nestedCalls = 0
  let derivedCalls = 0
  const originalExecute = state.ctx.tools.execute
  state.ctx.tools.execute = options => {
    if (options.name === 'run_code') derivedCalls += 1
    return originalExecute(options)
  }
  const rootCallId = 'once-edit-root'
  const tools = { edit_run_code: async args => {
    const subCallId = `${rootCallId}:ptc:${++nestedCalls}`
    const data = { rootCallId, parentCallId: rootCallId, subCallId,
      name: 'edit_run_code', arguments: args }
    session.append('tool/ptc-dispatch-start', data)
    const result = await state.ctx.tools.execute({
      callId: subCallId, rootCallId, parent: {}, name: 'edit_run_code',
      arguments: args, agent, signal,
    })
    session.append('tool/ptc-dispatch', { ...data, isError: result.isError, content: result.content })
    if (result.isError) throw new Error(result.error.message)
    return result.value
  } }
  const root = await state.executeRun(session.id, [
    'const firstReceipt = await tools["edit_run_code"]({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
    'const nextReceipt = await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 3" }] })',
    'return [firstReceipt, nextReceipt, onceEditValue]',
  ].join('\n'), tools, { session, callId: rootCallId })
  assert.equal(root.result.isError, false, JSON.stringify(root.result))
  const [accepted, refused, outerValue] = root.result.value
  assert.equal(accepted.accepted, true)
  assert.equal(refused.accepted, false)
  assert.equal(refused.scheduled, false)
  assert.match(refused.reason,
    /^the current edit target already has a derived execution \(edit target: run_code call \d+, first line: /)
  assert.equal(outerValue, 1)
  assert.equal(derivedCalls, 1)
  assert.equal(projectedView(session).editableRun.source,
    'let onceEditValue = 2; return onceEditValue')
  const next = await state.runDurable(session.id, 'return onceEditValue', tools,
    { session, callId: 'once-continued' })
  assert.equal(next.value, 2)
})

test('an edit rejection names the cell it captured', async t => {
  const session = appendOnlySession('nested-edit-target-identity')
  session.append('turn/start', {})
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  await state.runDurable(session.id, 'const doubled = 1; const doubledAgain = 1; return 1', {},
    { session, callId: 'identity-setup' })
  const root = await runNestedEditCell(state, { session, agent, signal, callId: 'identity-edit-root',
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })',
  })
  assert.equal(root.result.isError, false)
  assert.equal(root.receipt.accepted, false)
  assert.equal(root.receipt.scheduled, false)
  // The match failure alone cannot say which cell was edited; the bounded target identity can.
  assert.match(root.receipt.reason,
    /^edits\[0\]\.old_string occurs more than once in the target cell \(edit target: run_code call \d+, first line: const doubled = 1; const doubledAgain = 1; return 1\)$/)
})

test('edit scheduling releases claims after refusal, invalid root and cancellation during log read', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = appendOnlySession('edit-owner-admission')
  session.append('turn/start', {})
  await state.runDurable(session.id, 'let editOwnerValue = 1; return editOwnerValue', {}, { session, callId: 'setup' })
  const agent = ptcAgent(session.id, session)
  const controller = new AbortController()
  const args = { edits: [{ old_string: '= 1', new_string: '= 2' }] }
  session.append('tool/call', { callId: 'root', name: 'run_code', arguments: { code: 'return 0', description: 'edit root' } })
  const exec = { agent, name: 'edit_run_code', callId: 'sub', rootCallId: 'root', arguments: args, signal: controller.signal }
  let pending
  let schedule = false
  let cancelRead = false
  let reads = 0
  const owner = createEditTransportOwner(state.ctx, {
    canScheduleEdit: () => true,
    executeTentative: () => { throw new Error('cancelled edit executed') },
    scheduleEdit: (_exec, item) => { pending = item; return schedule },
    sessionId: agent => agent.session.id,
    readSessionLog: async () => { reads++; if (cancelRead) controller.abort(); return session },
  })
  t.after(() => owner.dispose())
  await assert.rejects(owner.definition.execute(args, exec), /unique persisted PTC sub-call start/)
  session.append('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'edit_run_code', arguments: args })
  assert.equal((await owner.definition.execute(args, exec)).accepted, false)
  assert.equal(pending.finalized, true)
  schedule = true
  const receipt = await owner.definition.execute(args, exec)
  assert.equal(receipt.accepted, true, 'Refused scheduling must release its target claim.')
  owner.handleResult(exec, { isError: false, value: receipt })
  await assert.rejects(pending.dispatch(controller.signal, { name: 'run_code', callId: 'foreign', agent, token: {} }), /actual root transport/)
  pending.finish(false)
  const retried = await owner.definition.execute(args, exec)
  assert.equal(retried.accepted, true)
  owner.handleResult(exec, { isError: false, value: retried })
  const count = session.events.length
  cancelRead = true
  const cancelled = await pending.dispatch(controller.signal, { name: 'run_code', callId: 'root', agent, token: {} })
  assert.equal(cancelled.outcome.edited, false)
  assert.equal(pending.finalized, true)
  assert.equal(session.events.length, count, 'Cancellation while reading must not publish a derived dispatch.')
  assert.ok(reads >= 4)
})


test('a derived edit execution error retains the original root result and allows the next cell', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = appendOnlySession('derived-edit-error')
  session.append('turn/start', {})
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble({ sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }, { agent, scope: agent, signal })
  await state.runDurable(session.id, 'let derivedErrorValue = 1; return derivedErrorValue', {}, { session, callId: 'setup' })
  const root = await runNestedEditCell(state, { session, agent, signal, callId: 'edit-error',
    code: `return await tools.edit_run_code(${JSON.stringify({ edits: [
      { old_string: 'return derivedErrorValue', new_string: 'throw new Error("derived failure")' },
    ] })})` })
  assert.equal(root.receipt.accepted, true)
  assert.equal(root.result.isError, false)
  assert.equal(root.result.meta[POST_EDIT_KEY].meta.dshPtcPlus.completion.kind, 'throw')
  assert.match(root.raw.logs.join('\n'), /derived failure/)
  assert.equal((await state.run(session.id, 'return derivedErrorValue + 1', {}, { session })).value, 2)
})

test('unconfirmed edit receipts cannot dispatch and a large derived value keeps its full canonical result', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = appendOnlySession('edit-confirmation-preview')
  session.append('turn/start', {})
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble({ sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }, { agent, scope: agent, signal })
  await state.runDurable(session.id, 'let editPreviewValue = "short"; return editPreviewValue', {}, { session, callId: 'setup' })
  const rejectReceipt = (exec, result) => {
    if (exec.name === 'edit_run_code' && result.isError === false) result.value = { accepted: false, scheduled: false }
  }
  state.listeners.get('tools/result').unshift(rejectReceipt)
  const refused = await runNestedEditCell(state, { session, agent, signal, callId: 'unconfirmed',
    code: 'return await tools.edit_run_code({edits:[{old_string:"short",new_string:"changed"}]})' })
  assert.equal(refused.receipt.accepted, false)
  assert.equal(refused.result.meta[POST_EDIT_KEY], undefined)
  assert.equal(session.events.some(event => event.data?.subCallId === 'unconfirmed:ptc:1:derived'), false)
  state.listeners.get('tools/result').splice(state.listeners.get('tools/result').indexOf(rejectReceipt), 1)
  const execute = state.ctx.tools.execute
  state.ctx.tools.execute = async exec => {
    const result = await execute(exec)
    return exec.name === 'run_code' ? { ...result, content: [] } : result
  }
  await state.runDurable(session.id, 'let editPreviewValue = "short"; return editPreviewValue', {}, { session, callId: 'preview-setup' })
  const large = 'x'.repeat(4096)
  const edited = await runNestedEditCell(state, { session, agent, signal, callId: 'large-preview',
    code: `return await tools.edit_run_code(${JSON.stringify({ edits: [{ old_string: 'short', new_string: large }] })})` })
  assert.equal(edited.receipt.accepted, true)
  assert.match(edited.raw.logs.join('\n'), /value omitted from preview/)
  assert.equal(decodeValue(edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlus.completion.value), large)
  assert.equal((await state.run(session.id, 'return editPreviewValue.length', {}, { session })).value, 4096)
})
