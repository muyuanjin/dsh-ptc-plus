import assert from 'node:assert/strict'
import test from 'node:test'
import { appendOnlySession, fixture, orderedSurfaceSession, ptcAgent, runNestedEditCell } from './plugin-fixture.js'
import { POST_EDIT_KEY, RECOVERY_BOUNDARY_KEY } from '../internal/session-journal-schema.js'
import { decodeValue } from '../internal/value-wire.js'
import { REPL_MEMORY_META_KEY } from '../internal/repl-memory-projection.js'
import { recoverJournal, recoveryBoundaryForHistory, visibleExecutableCallSeqs } from '../internal/session-journal-recovery.js'
import { createSessionLogProjection, projectSessionLog } from '../internal/session-log-view.js'

function projectedView(session) {
  const projection = createSessionLogProjection()
  let projected = projection.init()
  session.events.forEach((event, index) => { projected = projection.apply(projected, event, index) })
  projection.stateSchema.parse(JSON.parse(JSON.stringify(projected)))
  return projectSessionLog({ session }, undefined, projected)
}

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
  assert.equal(contracted.value, 1)
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

  const damaged = { events: structuredClone(session.events), surface: session.surface }
  damaged.events.find(event => event.seq === settled.seq).data.isError = true
  const contracted = recoverJournal(damaged, undefined,
    { visibleCallSeqs: visibleExecutableCallSeqs(damaged) })
  assert.equal(contracted.available, false)
  assert.deepEqual(contracted.nodes.map(node => node.code),
    ['let recordedEditValue = 1; return recordedEditValue'])
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
      assert.equal(continued.value, 1)
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
  assert.deepEqual(refused, { accepted: false, scheduled: false,
    reason: 'the current edit target already has a derived execution' })
  assert.equal(outerValue, 1)
  assert.equal(derivedCalls, 1)
  assert.equal(projectedView(session).editableRun.source,
    'let onceEditValue = 2; return onceEditValue')
  const next = await state.runDurable(session.id, 'return onceEditValue', tools,
    { session, callId: 'once-continued' })
  assert.equal(next.value, 2)
})
