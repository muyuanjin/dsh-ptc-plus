import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { Config } from '../index.js'
import {
  USER_BINDING_DRAFT_META_KEY,
  withUserBindingDraftCapability,
} from '../internal/user-binding-draft-projection.js'
import { REPL_MEMORY_META_KEY } from '../internal/repl-memory-projection.js'
import { POST_EDIT_KEY } from '../internal/session-journal-schema.js'
import { recoverJournal, visibleExecutableCallSeqs } from '../internal/session-journal-recovery.js'
import { projectSessionLog } from '../internal/session-log-view.js'
import { latestRecoveryTip } from '../internal/recovery-tips.js'
import { REWRITES_KEY, normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import {
  USER_BINDINGS_META_KEY,
  createUserBindingsSnapshot,
} from '../internal/user-bindings.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import {
  JOURNAL_POLICY,
  appendOnlySession,
  appendRunCodeEvents,
  fixture,
  orderedSurfaceSession,
  ptcAgent,
  runNestedEditCell,
} from './plugin-fixture.js'
import { auditEditCalls, auditEditTransports, collectTrajectoryFacts } from '../scripts/acceptance-contract.mjs'

test('continues from bindings after a partial failure without redispatching a native call', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  let dispatches = 0
  const session = orderedSurfaceSession('partial-reuse')
  const failed = await state.runDurable(
    session.id,
    'const observed = await tools.observe({}); return observed.missing.trim()',
    {
      observe: async () => {
        dispatches += 1
        return { value: 'live result' }
      },
    },
    { session },
  )
  assert.equal(failed.isError, true)
  assert.match(failed.error.message, /state: partially-applied/)

  const continued = await state.run(
    session.id,
    'return observed.value',
    {
      observe: async () => {
        dispatches += 1
        return { value: 'unexpected replay' }
      },
    },
    { session },
  )
  assert.deepEqual(continued, { logs: [], value: 'live result' })
  assert.equal(dispatches, 1)
})

test('keeps edit selection model-owned when a partial cell may have caused an effect', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = appendOnlySession('edit-effect-boundary')
  session.append('turn/start', {})
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const definition = agent.ctx.tools.get('edit_run_code')

  const safeCode = 'let safeValue = 1; return safeValue'
  await state.runDurable(session.id, safeCode, {}, { session, callId: 'safe' })
  const safeArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const safeEdit = await runNestedEditCell(state, {
    session, agent, signal, callId: 'safe-edit',
    code: `return await tools.edit_run_code(${JSON.stringify(safeArgs)})`,
  })
  assert.equal(safeEdit.receipt.accepted, true)
  assert.equal(safeEdit.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code,
    'let safeValue = 2; return safeValue')

  let dispatches = 0
  const effectCode = 'const observed = await tools.observe({}); return observed.missing.trim()'
  const failed = await state.runDurable(session.id, effectCode, {
    observe: async () => {
      dispatches += 1
      return { value: 'live result' }
    },
  }, { session, callId: 'effect' })
  assert.equal(failed.isError, true)
  const effectArgs = {
    edits: [{ old_string: 'observed.missing.trim()', new_string: 'observed.value' }],
  }
  const originalExecute = state.ctx.tools.execute
  state.ctx.tools.execute = async (options) => {
    if (options.name !== 'run_code') return originalExecute(options)
    const observed = await state.executeRun(
      session.id,
      options.arguments.code,
      {
        observe: async () => {
          dispatches += 1
          return { value: 'replayed result' }
        },
      },
      { session, callId: options.callId, recordSession: false },
    )
    return observed.result
  }
  const replayed = await runNestedEditCell(state, {
    session, agent, signal, callId: 'effect-edit',
    code: `return await tools.edit_run_code(${JSON.stringify(effectArgs)})`,
  })
  assert.equal(replayed.receipt.accepted, true)
  assert.equal(dispatches, 2)
  assert.match(definition.description, /entire target cell/)
  assert.match(definition.description, /repeating those effects is safe under the called API's retry rules/)
})

test('repairs a long parse-rejected cell without resending its source', async (t) => {
  const session = appendOnlySession('long-parse-edit')
  session.append('turn/start', {})
  const state = fixture({ computeMs: 10_000, maxWallMs: 10_000 })
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const longText = 'x'.repeat(2_100)
  const rejectedCode = `const longOutput = \`${longText}
model output \`program IR\` continues
\`
return longOutput.length`
  const rejected = await state.runDurable(
    session.id,
    rejectedCode,
    {},
    { session, callId: 'long-parse' },
  )
  assert.equal(rejected.isError, true)
  assert.equal(rejected.meta.dshPtcPlus.status, 'noop')
  assert.equal(rejected.meta.dshPtcPlus.diagnostics[0].stateEffect, 'unchanged')
  assert.match(rejected.error.message, /tools\.edit_run_code is available in the program SDK/)
  assert.match(rejected.error.message, /avoid resending this long source/)
  assert.match(rejected.error.message, /otherwise retry only this cell with corrected source in run_code/)
  const editArgs = {
    edits: [{ old_string: '`program IR`', new_string: '\\`program IR\\`' }],
  }
  const edited = await runNestedEditCell(state, {
    session, agent, callId: 'long-parse-edit', signal,
    code: `return await tools.edit_run_code(${JSON.stringify(editArgs)})`,
  })
  const expected = `${longText}\nmodel output \`program IR\` continues\n`
  assert.equal(edited.result.isError, false)
  assert.equal(edited.receipt.accepted, true)
  assert.equal(edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code.length, rejectedCode.length + 2)
  assert.equal(JSON.stringify(edited.receipt).includes(longText), false)
  assert.equal(JSON.stringify(editArgs).includes(longText), false)
  assert.equal(session.events.filter(event => event.type === 'tool/call' && event.data?.name === 'run_code').length, 2)
  const trajectory = collectTrajectoryFacts(session.events).timeline
  const transport = [{ originalSource: rejectedCode,
    repairedSource: edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code,
    oldString: editArgs.edits[0].old_string, newString: editArgs.edits[0].new_string,
    targetStatus: 'noop' }]
  assert.deepEqual(auditEditCalls(session.events, trajectory).failures, [])
  assert.deepEqual(auditEditTransports(trajectory, transport), [])
  const receiptOnly = trajectory.map(call => ({ ...call, postEdit: undefined }))
  assert.match(auditEditTransports(receiptOnly, transport).join('\n'), /not followed by edit_run_code/)
  const receiptOnlyEvents = structuredClone(session.events)
  delete receiptOnlyEvents.at(-1).data.meta[POST_EDIT_KEY]
  assert.match(auditEditCalls(receiptOnlyEvents,
    collectTrajectoryFacts(receiptOnlyEvents).timeline).failures.join('\n'), /root post-edit evidence/)
  const recoveredLongEdit = recoverJournal(session, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(session),
  })
  assert.equal(recoveredLongEdit.nodes.at(-1)?.callSeq, edited.result.meta[POST_EDIT_KEY].executionStartSeq,
    JSON.stringify({ recoveredLongEdit, visible: [...visibleExecutableCallSeqs(session)] }))

  assert.deepEqual(await state.run(session.id, 'return longOutput', {
    edit_run_code: async () => { throw new Error('replay redispatched edit') },
  }, { session }), {
    logs: [], value: expected,
  })
})

test('does not promote an undeclared top-level editor from archived malformed stream input', async (t) => {
  const session = appendOnlySession('malformed-stream-edit')
  session.append('turn/start', {})
  const state = fixture({ tipsEnabled: false })
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  const projected = await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const rejectedCode = 'const recoveredArray = [1, 2, 3'
  const rejected = await state.runDurable(
    session.id,
    rejectedCode,
    {},
    { session, callId: 'malformed-stream-target' },
  )
  assert.equal(rejected.isError, true)
  const rejectedCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data?.callId === 'malformed-stream-target').seq

  const raw = `{"edits":[{"old_string":"3","new_string":"3]"}],"expected_target_call_seq":${rejectedCallSeq}}}`
  const callId = 'malformed-stream-edit'
  const source = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 0, id: callId, name: 'edit_run_code',
      argumentsDelta: '',
    },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: raw },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: callId, name: 'edit_run_code', arguments: raw },
    },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'DeepSeek Messages stream: tool input is invalid JSON',
          code: 'MALFORMED_RESPONSE',
        },
      },
    },
  ]
  const streamed = await state.stream({
    sessionId: session.id,
    signal,
    tools: projected.tools,
  }, source)
  const retainedBlock = streamed.find(chunk => chunk.type === 'block-end').block
  assert.equal(retainedBlock.id, callId)
  assert.equal(retainedBlock.name, 'edit_run_code')
  assert.equal(retainedBlock.arguments, raw)
  assert.deepEqual(streamed.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

  const editArgs = JSON.parse(raw.slice(0, -1))
  const edited = await runNestedEditCell(state, {
    session, agent, signal, callId: 'nested-stream-repair',
    code: `return await tools.edit_run_code(${JSON.stringify(editArgs)})`,
  })
  assert.equal(edited.result.isError, false)
  assert.equal(edited.receipt.accepted, true)
  assert.equal(projectSessionLog({ session }).latestRun.source, `${rejectedCode}]`)
  assert.deepEqual(await state.run(session.id, 'return recoveredArray', {
    edit_run_code: async () => { throw new Error('replay redispatched edit') },
  }, { session }), {
    logs: [], value: [1, 2, 3],
  })

  const invalidCallId = 'unrepairable-stream-edit'
  const invalidRaw = '{"edits":[}'
  const invalidSource = source.map(chunk => {
    if (chunk.type === 'tool-call-delta') {
      return {
        ...chunk,
        id: invalidCallId,
        argumentsDelta: chunk.name === 'edit_run_code' ? '' : invalidRaw,
      }
    }
    if (chunk.type === 'block-end') {
      return {
        ...chunk,
        block: { ...chunk.block, id: invalidCallId, arguments: invalidRaw },
      }
    }
    return chunk
  })
  const settled = await state.stream({
    sessionId: session.id,
    signal,
    tools: projected.tools,
  }, invalidSource)
  assert.equal(settled.find(chunk => chunk.type === 'block-end').block.arguments, invalidRaw)
  assert.deepEqual(settled.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const ordinaryToolResult = await state.ctx.tools.execute({
    callId: invalidCallId,
    name: 'edit_run_code',
    arguments: invalidRaw,
    agent,
    signal,
  })
  assert.equal(ordinaryToolResult.isError, true)
  assert.match(ordinaryToolResult.error.message, /must be called through tools.edit_run_code inside run_code/)
  assert.deepEqual(await state.run(session.id, 'return recoveredArray.length', {
    edit_run_code: async () => { throw new Error('replay redispatched edit') },
  }, { session }), {
    logs: [], value: 3,
  })
})

for (const { label, rejectedCode, suffix, expected } of [
  { label: 'one closing token', rejectedCode: '{\n  const closureValue = 42\n  return closureValue;', suffix: '}', expected: 42 },
  { label: 'two closing tokens', rejectedCode: "const words = ['one', 'two'];\nreturn words.map(w => { return w.toUpperCase()", suffix: '})', expected: ['ONE', 'TWO'] },
]) test(`executes the validated EOF repair for ${label} with recovery tips disabled`, async (t) => {
  const session = appendOnlySession('validated-parse-edit')
  session.append('turn/start', {})
  const state = fixture({ tipsEnabled: false })
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const rejected = await state.runDurable(
    session.id,
    rejectedCode,
    {},
    { session, callId: 'validated-parse' },
  )
  const rejectedCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data?.callId === 'validated-parse').seq
  assert.equal(rejected.isError, true)
  assert.equal(rejected.meta.dshPtcPlus.status, 'noop')
  const diagnostic = rejected.meta.dshPtcPlus.diagnostics[0]
  assert.deepEqual(diagnostic.help.slice(0, 1), [
    `this cell was not executed; validated syntax repair: append ${JSON.stringify(suffix)} at the end of this cell`,
  ])
  const invocation = /tools\.edit_run_code\((\{.*\})\)/.exec(diagnostic.help[1])
  assert.notEqual(invocation, null)
  const editArgs = JSON.parse(invocation[1])
  assert.equal(JSON.stringify(editArgs).includes(rejectedCode), false)
  assert.equal(editArgs.expected_target_call_seq, rejectedCallSeq)
  const edited = await runNestedEditCell(state, {
    session, agent, signal, callId: 'validated-parse-edit',
    code: `return await tools.edit_run_code(${JSON.stringify(editArgs)})`,
  })
  assert.equal(edited.result.isError, false)
  assert.equal(edited.receipt.accepted, true)
  assert.equal(edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code, rejectedCode + suffix)
  assert.deepEqual(decodeValue(edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlus.completion.value), expected)
  assert.equal(recoverJournal(session, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(session),
  }).volatileSuffix.length, 0)
})

test('rejects a validated EOF repair after a newer matching cell becomes editable', async (t) => {
  const session = appendOnlySession('stale-validated-parse-edit')
  session.append('turn/start', {})
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )

  const rejectedCode = 'if (true) {'
  const rejected = await state.runDurable(
    session.id,
    rejectedCode,
    {},
    { session, callId: 'stale-parse' },
  )
  const rejectedCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data?.callId === 'stale-parse').seq
  const diagnostic = rejected.meta.dshPtcPlus.diagnostics[0]
  const invocation = /tools\.edit_run_code\((\{.*\})\)/.exec(diagnostic.help[1])
  assert.notEqual(invocation, null)
  const editArgs = JSON.parse(invocation[1])
  assert.equal(editArgs.expected_target_call_seq, rejectedCallSeq)
  const laterCode = 'const marker = "{"; return 7'
  await state.runDurable(
    session.id,
    laterCode,
    {},
    { session, callId: 'later-matching-cell' },
  )
  const laterCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data?.callId === 'later-matching-cell').seq

  const execute = state.ctx.tools.execute
  let derivedDispatches = 0
  state.ctx.tools.execute = async (request) => {
    if (request.name === 'run_code') derivedDispatches += 1
    return execute(request)
  }
  const edited = await runNestedEditCell(state, {
    session, agent, callId: 'stale-parse-edit',
    code: `return await tools.edit_run_code(${JSON.stringify(editArgs)})`,
  })
  assert.equal(edited.result.isError, false)
  assert.deepEqual(edited.receipt, {
    accepted: false,
    scheduled: false,
    reason: `validated repair targets run_code call ${rejectedCallSeq}, but this edit captured call ${laterCallSeq}`,
  })
  assert.equal(derivedDispatches, 0)
  assert.equal(Object.hasOwn(edited.result.meta, POST_EDIT_KEY), false)
})

test('suppresses a target-bound EOF repair for derived edit parse rejection', async (t) => {
  const session = appendOnlySession('derived-parse-rejection')
  session.append('turn/start', {})
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const source = 'if (true) {}'
  await state.runDurable(
    session.id,
    source,
    {},
    { session, callId: 'derived-parse-setup' },
  )

  const editArgs = { edits: [{ old_string: '{}', new_string: '{' }] }
  const edited = await runNestedEditCell(state, {
    session, agent, signal, callId: 'derived-parse-edit',
    code: `return await tools.edit_run_code(${JSON.stringify(editArgs)})`,
  })

  assert.equal(edited.result.isError, false)
  assert.equal(edited.receipt.accepted, true)
  assert.match(edited.raw.logs.at(-1), /correct the reported syntax and retry only this cell with run_code/)
  assert.doesNotMatch(edited.raw.logs.at(-1), /validated syntax repair|expected_target_call_seq/)
  assert.equal(Object.hasOwn(edited.result.meta, POST_EDIT_KEY), false)
  const editable = projectSessionLog({ session }).editableRun
  assert.equal(editable.source, `return await tools.edit_run_code(${JSON.stringify(editArgs)})`)
  assert.notEqual(editable.source, 'if (true) {')
})

function appendRunCall(events, callId, code) {
  const argumentsValue = JSON.stringify({ code, description: 'test cell' })
  events.push({
    type: 'assistant/message',
    seq: events.length,
    data: { message: { content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: argumentsValue }] } },
  })
  const seq = events.length
  events.push({
    type: 'tool/call',
    seq,
    data: {
      callId,
      name: 'run_code',
      arguments: argumentsValue,
    },
  })
  return seq
}

function appendRunResult(events, callId, callSeq, result) {
  events.push({
    type: 'tool/result',
    seq: events.length,
    sourceEventSeqs: [callSeq],
    data: {
      message: { source: { callId } },
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    },
  })
}

test('executes successive real edits and replays derived sources without model duplication', async (t) => {
  const session = appendOnlySession('real-edit')
  session.append('turn/start', {})
  const first = fixture()
  const firstAgent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  await first.assemble(
    { sections: [], contexts: [], variables: {}, tools: [first.runCodeDefinition] },
    { agent: firstAgent, scope: firstAgent, signal: requestSignal },
  )

  const setupCode = 'let editableValue = 40; return editableValue'
  await first.runDurable(session.id, setupCode, {}, { session, callId: 'setup' })
  const firstEditArgs = { edits: [{ old_string: '40', new_string: '42' }] }
  const edit = await runNestedEditCell(first, {
    session, agent: firstAgent, callId: 'edit-1', signal: requestSignal,
    code: `return await tools.edit_run_code(${JSON.stringify(firstEditArgs)})`,
  })
  assert.equal(edit.result.isError, false)
  assert.equal(edit.receipt.accepted, true)
  assert.equal(JSON.stringify(edit.receipt).includes(setupCode), false)
  const setupCall = session.events.find(event => event.type === 'tool/call' && event.data?.callId === 'setup')
  assert.deepEqual(edit.result.meta[POST_EDIT_KEY].meta.dshPtcPlusEdit,
    { targetCallSeq: setupCall.seq })

  const secondEditArgs = { edits: [{ old_string: '42', new_string: '43' }] }
  const nextEdit = await runNestedEditCell(first, {
    session, agent: firstAgent, callId: 'edit-2', signal: requestSignal,
    code: `return await tools.edit_run_code(${JSON.stringify(secondEditArgs)})`,
  })
  assert.equal(nextEdit.result.isError, false)
  assert.equal(nextEdit.receipt.accepted, true)
  assert.deepEqual(nextEdit.result.meta[POST_EDIT_KEY].meta.dshPtcPlusEdit,
    { targetCallSeq: edit.result.meta[POST_EDIT_KEY].executionStartSeq })
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return editableValue', {
    edit_run_code: async () => { throw new Error('replay redispatched edit') },
  }, { session }), {
    logs: [], value: 43,
  })
  const restoredAgent = ptcAgent(session.id, session)
  const assembly = await restored.assemble({
    sections: [], contexts: [], variables: {}, tools: [restored.runCodeDefinition],
  }, { agent: restoredAgent, scope: restoredAgent, signal: new AbortController().signal })
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code'])
  assert.equal(assembly.contexts.some(context => /edit/i.test(context?.name ?? '')), false)
})

test('binds delayed edit execution to the target captured by its call event', async (t) => {
  const session = appendOnlySession('delayed-edit-target')
  session.append('turn/start', {})
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )

  await state.runDurable(session.id, 'return 1', {}, { session, callId: 'first-target' })
  const firstCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data?.callId === 'first-target').seq

  assert.deepEqual(await agent.ctx.tools.get('edit_run_code').execute(
    { edits: [{ old_string: '9', new_string: '10' }] },
    { callId: 'missing-call-event', agent },
  ), { accepted: false, scheduled: false, reason: 'edit requires an active root run_code cell' })

  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const edited = await runNestedEditCell(state, { session, agent, callId: 'delayed-edit',
    code: `const receipt = await tools.edit_run_code(${JSON.stringify(args)}); const later = await tools.observe({}); return receipt.target_call_seq + later`,
    functions: { observe: async () => 7 },
  })
  assert.equal(edited.result.value, firstCallSeq + 7)
  assert.equal(edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code, 'return 2')
  assert.deepEqual(edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlusEdit,
    { targetCallSeq: firstCallSeq })
})

test('cold-replays a delayed edit in its live execution order', async (t) => {
  const session = appendOnlySession('delayed-edit-replay-order')
  session.append('turn/start', {})
  const first = fixture()
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await first.assemble(
    { sections: [], contexts: [], variables: {}, tools: [first.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const setupCode = 'let delayedOrder = [1]; return delayedOrder'
  await first.runDurable(session.id, setupCode, {}, { session, callId: 'setup' })
  const editArgs = {
    edits: [{ old_string: '[1]', new_string: '[...delayedOrder, 3]' }],
  }
  const edit = await runNestedEditCell(first, {
    session, agent, signal, callId: 'delayed-order-edit',
    code: `await tools.edit_run_code(${JSON.stringify(editArgs)}); delayedOrder.push(4); return delayedOrder`,
  })
  assert.equal(edit.result.isError, false)
  assert.deepEqual(edit.result.value, [1, 4])
  assert.deepEqual(decodeValue(edit.result.meta[POST_EDIT_KEY].meta.dshPtcPlus.completion.value), [1, 4, 3])
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return delayedOrder', {
    edit_run_code: async () => { throw new Error('cold replay redispatched delayed edit') },
  }, { session }), {
    logs: [], value: [1, 4, 3],
  })
})

test('keeps optional rewrite metadata out of derived edit settlement', async (t) => {
  const session = appendOnlySession('edit-optional-rewrites')
  session.append('turn/start', {})
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )
  const code = 'let optionalRewriteValue = 1; return optionalRewriteValue'
  await state.runDurable(session.id, code, {}, { session, callId: 'optional-rewrite-source' })

  const originalExecute = state.ctx.tools.execute
  let derivedDispatches = 0
  state.ctx.tools.execute = async (request) => {
    if (request.name !== 'run_code') return originalExecute(request)
    derivedDispatches += 1
    const result = await originalExecute(request)
    return { ...result, meta: { ...result.meta, [REWRITES_KEY]: {} } }
  }
  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const edited = await runNestedEditCell(state, { session, agent, callId: 'optional-rewrite-edit',
    code: `return await tools.edit_run_code(${JSON.stringify(args)})`,
  })
  assert.equal(edited.receipt.accepted, true)
  assert.equal(Object.hasOwn(edited.result.meta[POST_EDIT_KEY].meta, REWRITES_KEY), false)

  const retryArgs = { edits: [{ old_string: '1', new_string: '3' }] }
  const retry = await runNestedEditCell(state, { session, agent, callId: 'optional-rewrite-retry',
    code: `return await tools.edit_run_code(${JSON.stringify(retryArgs)})`,
  })
  assert.equal(retry.receipt.accepted, false)
  assert.match(retry.receipt.reason, /old_string was not found/)
  assert.equal(derivedDispatches, 1)
  state.ctx.tools.execute = originalExecute
  await state.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return optionalRewriteValue', {
    edit_run_code: async () => { throw new Error('cold replay redispatched edit') },
  }, { session }), {
    logs: [], value: 2,
  })
})

test('keeps malformed REPL memory metadata out of derived edit settlement', async (t) => {
  const session = appendOnlySession('edit-malformed-repl-memory')
  session.append('turn/start', {})
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: requestSignal },
  )
  const code = 'let memorySafeEdit = 1; return memorySafeEdit'
  await state.runDurable(session.id, code, {}, { session, callId: 'memory-setup' })
  const setupCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data?.callId === 'memory-setup').seq

  const execute = state.ctx.tools.execute
  state.ctx.tools.execute = async (options) => {
    const result = await execute(options)
    if (options.name !== 'run_code' || !String(options.callId).endsWith(':derived')) return result
    return {
      ...result,
      meta: {
        ...result.meta,
        [REPL_MEMORY_META_KEY]: { status: 'corrupt' },
        [USER_BINDING_DRAFT_META_KEY]: { status: 'corrupt' },
      },
    }
  }
  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const edited = await runNestedEditCell(state, {
    session, agent, signal: requestSignal, callId: 'memory-edit',
    code: `return await tools.edit_run_code(${JSON.stringify(args)})`,
  })
  assert.equal(edited.result.isError, false)
  assert.equal(edited.receipt.accepted, true)
  assert.equal(Object.hasOwn(edited.result.meta[POST_EDIT_KEY].meta, REPL_MEMORY_META_KEY), false)
  assert.equal(Object.hasOwn(edited.result.meta[POST_EDIT_KEY].meta, USER_BINDING_DRAFT_META_KEY), false)
  assert.deepEqual(edited.result.meta[POST_EDIT_KEY].meta.dshPtcPlusEdit,
    { targetCallSeq: setupCallSeq })
  state.ctx.tools.execute = execute
  await state.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return memorySafeEdit', {
    edit_run_code: async () => { throw new Error('cold replay redispatched edit') },
  }, { session }), {
    logs: [], value: 2,
  })
})

test('fails nested edit execution at each owned boundary without claiming revised state', async (t) => {
  const session = appendOnlySession('edit-boundaries', [{ type: 'turn/start', seq: 0, data: {} }])
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )
  const definition = agent.ctx.tools.get('edit_run_code')
  const editArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const executeEdit = (callId, args = editArgs) => runNestedEditCell(state, {
    session, agent, callId, code: `return await tools.edit_run_code(${JSON.stringify(args)})`,
  })
  const noTarget = await executeEdit('none')
  assert.deepEqual(noTarget.receipt, {
    accepted: false, scheduled: false, reason: 'no run_code cell is currently eligible for safe editing',
  })
  assert.equal(noTarget.result.meta[POST_EDIT_KEY], undefined)
  assert.equal(definition.output.presentationMeta, undefined)
  assert.deepEqual(definition.output.render({}, noTarget.receipt), [{
    type: 'text', text: JSON.stringify(noTarget.receipt),
  }])
  assert.deepEqual(await definition.execute(editArgs, {
    callId: 'no-start', rootCallId: 'none', agent, signal: new AbortController().signal,
  }), { accepted: false, scheduled: false, reason: 'edit requires an active root run_code cell' })

  const originalExecute = state.ctx.tools.execute
  const seed = callId => state.runDurable(session.id, 'return 1', {}, { session, callId })
  await seed('editable-invalid')
  const invalid = await executeEdit('invalid', { edits: [] })
  assert.equal(invalid.receipt.accepted, false)
  assert.match(invalid.receipt.reason, /at least one/)
  assert.equal(invalid.result.meta[POST_EDIT_KEY], undefined)

  await seed('editable-missing-execute')
  state.ctx.tools.execute = async options => {
    state.ctx.tools.execute = undefined
    try { return await originalExecute(options) } finally { state.ctx.tools.execute = originalExecute }
  }
  const missing = await executeEdit('missing-execute')
  assert.equal(missing.nestedResult.isError, true)
  assert.match(missing.result.error.message, /tools.execute is required/)
  assert.equal(missing.result.meta[POST_EDIT_KEY], undefined)

  const run = await seed('editable-journal')
  const noopJournal = normalizeJournal({
    ...run.meta.dshPtcPlus, status: 'noop', calls: [], operations: [], userBindingNames: null,
    completion: { kind: 'return', hasValue: false },
  })
  const cases = [
    ['missing-journal', { isError: false, value: 7, meta: null }, /valid execution journal/],
    ['noop-rejected', { isError: true, error: { message: 'rejected by runtime' },
      meta: { dshPtcPlus: noopJournal } }, /rejected by runtime/],
    ['noop-unexpected', { isError: false, value: 7,
      meta: { dshPtcPlus: noopJournal } }, /valid execution journal/],
    ['pre-runtime', { isError: true, error: { message: 'blocked before runtime' }, meta: {} },
      /blocked before runtime/],
  ]
  for (const [callId, derived, diagnostic] of cases) {
    state.ctx.tools.execute = originalExecute
    await seed(`editable-${callId}`)
    state.ctx.tools.execute = options => options.name === 'run_code'
      ? Promise.resolve({ content: [], ...derived }) : originalExecute(options)
    const edited = await executeEdit(callId)
    assert.equal(edited.receipt.accepted, true)
    assert.equal(edited.receipt.scheduled, true)
    assert.equal(edited.result.isError, false)
    assert.equal(edited.result.meta[POST_EDIT_KEY], undefined)
    assert.match(edited.raw.logs.at(-1), diagnostic)
  }

  state.ctx.tools.execute = originalExecute
  const metadataRun = await seed('editable-provenance')
  const rewriteFacts = [{ kind: 'import', description: 'Adapt import declaration.' }]
  const userBindings = createUserBindingsSnapshot({ entries: [{
    id: 'edit-helper', name: 'editHelper', scope: 'namespace', purpose: '', enabled: true,
    source: 'export const value = 1',
  }] }, 4)
  const draftCapability = 'derived-edit-draft-capability'
  const presentationGeneration = metadataRun.meta[REPL_MEMORY_META_KEY].generation
  const derivedMeta = withUserBindingDraftCapability({
    ...metadataRun.meta,
    dshPtcPlus: { ...metadataRun.meta.dshPtcPlus,
      userBindingsFingerprint: userBindings.fingerprint,
      userBindingNames: [{ name: 'editHelper', state: 'provider', entryId: 'edit-helper' }],
    },
    [REWRITES_KEY]: rewriteFacts,
    [USER_BINDINGS_META_KEY]: userBindings,
    foreignOwnerFact: { secret: true },
  }, draftCapability, presentationGeneration)
  state.ctx.tools.execute = options => options.name === 'run_code'
    ? Promise.resolve({ isError: false, value: 7, content: [], meta: derivedMeta })
    : originalExecute(options)
  const primitive = await executeEdit('primitive')
  const primitiveMeta = primitive.result.meta[POST_EDIT_KEY].meta
  assert.deepEqual(primitiveMeta.dshPtcPlusEdit, {
    targetCallSeq: session.events.find(event => event.type === 'tool/call'
      && event.data.callId === 'editable-provenance').seq,
  })
  assert.deepEqual(primitiveMeta.dshPtcPlusDerivedRun, {
    code: 'return 2', description: 'Edit and run TypeScript cell',
  })
  assert.deepEqual(primitiveMeta[REWRITES_KEY], rewriteFacts)
  assert.deepEqual(primitiveMeta[REPL_MEMORY_META_KEY], metadataRun.meta[REPL_MEMORY_META_KEY])
  assert.deepEqual(primitiveMeta[USER_BINDINGS_META_KEY], userBindings)
  assert.equal(primitiveMeta[USER_BINDING_DRAFT_META_KEY].capability, draftCapability)
  assert.equal(Object.hasOwn(primitiveMeta, 'foreignOwnerFact'), false)
  assert.deepEqual(Object.keys(primitiveMeta).sort(), [
    'dshPtcPlus', 'dshPtcPlusDerivedRun', 'dshPtcPlusEdit',
    REPL_MEMORY_META_KEY, REWRITES_KEY, USER_BINDINGS_META_KEY, USER_BINDING_DRAFT_META_KEY,
  ].sort())
  state.ctx.tools.execute = originalExecute
})

test('releases nested edit claims after failed derived dispatch and lost root metadata', async (t) => {
  const session = appendOnlySession('edit-in-flight', [{ type: 'turn/start', seq: 0, data: {} }])
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )
  const originalExecute = state.ctx.tools.execute
  const editArgs = { edits: [{ old_string: '= 1', new_string: '= 2' }] }
  const code = `return await tools.edit_run_code(${JSON.stringify(editArgs)})`
  const seed = callId => state.runDurable(session.id, 'let claimValue = 1; return claimValue', {}, {
    session, callId,
  })
  const executeEdit = (callId, options = {}) => runNestedEditCell(state, {
    session, agent, callId, code, ...options,
  })

  await seed('editable-rejected-dispatch')
  let derivedCalls = 0
  state.ctx.tools.execute = options => {
    if (options.name !== 'run_code') return originalExecute(options)
    derivedCalls += 1
    throw new Error('derived dispatch rejected')
  }
  const failed = await executeEdit('rejected-dispatch')
  assert.equal(failed.receipt.accepted, true)
  assert.equal(failed.result.meta[POST_EDIT_KEY], undefined)
  assert.match(failed.raw.logs.at(-1), /derived dispatch rejected/)
  assert.equal(derivedCalls, 1)

  state.ctx.tools.execute = originalExecute
  await seed('editable-lost-metadata')
  let completedDerivedEffects = 0
  state.ctx.tools.execute = async options => {
    const result = await originalExecute(options)
    if (options.name === 'run_code') completedDerivedEffects += 1
    return result
  }
  const lost = await executeEdit('lost-metadata', {
    finalizeResult: result => ({ ...result, meta: {} }),
  })
  assert.equal(lost.receipt.accepted, true)
  assert.deepEqual(lost.result.meta, {})
  assert.equal(completedDerivedEffects, 1)
  // Missing provenance contracts computation state; already completed effects stay completed.
  const live = await state.runDurable(session.id, 'return claimValue', {
    edit_run_code: async () => { throw new Error('live read redispatched edit') },
  }, { session, callId: 'read-after-loss' })
  assert.equal(live.value, 1)
  assert.equal(completedDerivedEffects, 1)

  await seed('editable-after-loss')
  const retry = await executeEdit('retry-after-loss')
  assert.equal(retry.receipt.accepted, true)
  assert.equal(retry.result.meta[POST_EDIT_KEY].meta.dshPtcPlusDerivedRun.code,
    'let claimValue = 2; return claimValue')
  await state.emit('session/disposed', session)
})

test('keeps truthful run and edit transports with a stable prompt prefix', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const { output, execute, projectContent, ...runCodeSchema } = state.runCodeDefinition
  const codeOnlyAssembly = {
    sections: [
      { name: 'tools:code-only', text: 'upstream code-only guidance' },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [], variables: {}, tools: [runCodeSchema],
  }
  const session = orderedSurfaceSession('prefix-stability-session', [{ type: 'turn/start' }])
  const agent = ptcAgent('prefix-stability-agent', session)
  const assemble = () => state.assembleStep(codeOnlyAssembly, {
    agent, scope: agent, signal: new AbortController().signal,
  })
  const surface = assembly => JSON.stringify({
    sections: assembly.sections,
    tools: assembly.tools,
  })

  const baselineAssembly = await assemble()
  const baseline = surface(baselineAssembly)
  assert.deepEqual(baselineAssembly.tools.map(tool => tool.name), ['run_code'])
  assert.deepEqual(JSON.parse(JSON.stringify(baselineAssembly.tools)), baselineAssembly.tools)
  assert.equal(
    baselineAssembly.sections.find(section => section.name === 'tools:code-only').text,
    '`run_code` is the only tool callable directly. Call `tools.edit_run_code` and other SDK tools from inside a program. An accepted edit runs after the current cell finishes.',
  )
  const sdk = baselineAssembly.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(sdk, /edit_run_code/)
  assert.equal(baselineAssembly.contexts.some(context => /edit/i.test(context?.name ?? '')), false)
  assert.equal(surface(await assemble()), baseline)

  const rejectedCode = 'return )'
  const rejected = await state.runDurable(session.id, rejectedCode, {}, { session, recordSession: 'deferred-result', callId: 'prefix-rejected' })
  appendRunCodeEvents(session.events, 'prefix-rejected', rejectedCode, rejected)
  const afterRejection = await assemble()
  assert.equal(surface(afterRejection), baseline)
  assert.equal(afterRejection.contexts.some(context => /edit/i.test(context?.name ?? '')), false)

  await state.emit('agent/disposed', { agent })
  assert.equal(agent.registration.disposals, 1)
  assert.equal(agent.presentation.disposals, 0)
  await state.emit('session/disposed', session)
})
test('uses environment-neutral tips for command failures and escalates repeated binding failures', async (t) => {
  const state = fixture({ tipCooldownMessages: 1, tipEscalationFailures: 2 })
  t.after(() => state.dispose())
  const session = { id: 'platform-tip-session', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent('platform-tip-agent', session)
  const codeOnlyAssembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  const assemble = () => state.assembleStep(codeOnlyAssembly, {
    agent, scope: agent, signal: new AbortController().signal,
  })
  const stableSurface = assembly => JSON.stringify({ sections: assembly.sections, tools: assembly.tools })
  const baselineSurface = stableSurface(await assemble())
  const tipOf = async () => {
    const assembly = await assemble()
    assert.equal(stableSurface(assembly), baselineSurface)
    return assembly.ptcContexts.find(item => item.name.startsWith('tools:ptc-plus-tip/'))
  }
  let persistedSignature
  const snapshot = (tip, extraSections = []) => {
    const sections = [...extraSections, tip]
    const signature = JSON.stringify(sections)
    if (signature === persistedSignature) return
    persistedSignature = signature
    session.events.push({
      type: 'user/message',
      data: {
        source: {
          kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections,
        },
      },
    })
  }
  const nextRequest = () => session.events.push({ type: 'request/header' })
  const commandFailure = 'throw new Error("ENOENT: command not found")'
  const commandResult = await state.runDurable(session.id, commandFailure, {}, { session, recordSession: 'deferred-result', callId: 'platform-failure' })
  appendRunCodeEvents(session.events, 'platform-failure', commandFailure, commandResult)
  const projectedFailure = projectSessionLog(agent)
  assert.notEqual(projectedFailure.latestRun, undefined, 'the persisted failure must remain the latest open-turn run')
  assert.equal(projectedFailure.latestRun.journal?.diagnostics.some(item => item.code === 'PTC-X001'), true)
  assert.notEqual(latestRecoveryTip(projectedFailure, {
    enabled: true, cooldownMessages: 1, escalationFailures: 2,
  }), undefined, 'the persisted platform diagnostic must classify for a recovery tip')
  const compactPlatform = await tipOf()
  assert.match(compactPlatform.text, /current execution world/)
  assert.match(compactPlatform.text, /do not assume Windows, WSL, POSIX, or one shell/)
  snapshot(compactPlatform)
  nextRequest()
  const secondPlatform = await tipOf()
  assert.match(secondPlatform.text, /current execution world/)
  assert.match(secondPlatform.name, /platform-command-failure\/2$/)
  snapshot(secondPlatform, [{ name: 'other-owner', text: 'changed' }])
  snapshot(secondPlatform, [{ name: 'other-owner', text: 'changed again' }])
  nextRequest()
  const detailedPlatform = await tipOf()
  assert.match(detailedPlatform.text, /Re-check the active execution world/)

  const unrelated = 'throw new Error("binding missing")'
  for (let index = 0; index < 3; index += 1) {
    const result = await state.runDurable(session.id, unrelated, {}, { session, recordSession: 'deferred-result', callId: `generic-failure-${index}` })
    appendRunCodeEvents(session.events, `generic-failure-${index}`, unrelated, result)
  }
  nextRequest()
  assert.equal(await tipOf(), undefined)

  const repeated = 'return missingTipBinding'
  for (let index = 0; index < 3; index += 1) {
    const result = await state.runDurable(session.id, repeated, {}, { session, recordSession: 'deferred-result', callId: `binding-failure-${index}` })
    appendRunCodeEvents(session.events, `binding-failure-${index}`, repeated, result)
  }
  nextRequest()
  const compactBinding = await tipOf()
  assert.match(compactBinding.text, /same binding failure/)
  assert.doesNotMatch(compactBinding.text, /Do not invent hidden bindings/)
  snapshot(compactBinding)
  nextRequest()
  const secondBinding = await tipOf()
  assert.match(secondBinding.text, /same binding failure/)
  snapshot(secondBinding)
  nextRequest()
  const detailedBinding = await tipOf()
  assert.match(detailedBinding.text, /Earlier statements may have run/)
  assert.match(detailedBinding.text, /local name, scope, initialization, or declaration conflict/)
  assert.doesNotMatch(detailedBinding.text, /capabilities\.(find|inspect)\(\)/)
  assert.doesNotMatch(detailedBinding.text, /(?:^|[^.])\bfind\(\)/)
  assert.doesNotMatch(detailedBinding.text, /(?:^|[^.])\binspect\(\)/)
})

test('recognizes platform diagnostics from structured causes and Windows wording', async (t) => {
  const state = fixture({ tipCooldownMessages: 1 })
  t.after(() => state.dispose())
  const session = orderedSurfaceSession('structured-platform-tip', [{ type: 'turn/start' }])
  const agent = ptcAgent('structured-platform-agent', session)
  const codeOnlyAssembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  const assemble = () => state.assembleStep(codeOnlyAssembly, {
    agent, scope: agent, signal: new AbortController().signal,
  })
  const result = await state.executeRun(session.id, 'return await tools.run({})', {
    run: async () => {
      const error = new Error('The system cannot find the file specified')
      error.code = 'ENOENT'
      throw error
    },
  }, { session, recordSession: 'deferred-result', callId: 'structured-platform-failure' })
  appendRunCodeEvents(session.events, 'structured-platform-failure', 'return await tools.run({})', result.result)
  const tip = assemble()
  assert.match((await tip).ptcContexts.find(item => item.name.startsWith('tools:ptc-plus-tip/')).text, /executable, shell, or path/)
})

test('does not turn an unrelated path error into an environment tip', async (t) => {
  const state = fixture({ tipCooldownMessages: 1 })
  t.after(() => state.dispose())
  const session = orderedSurfaceSession('unrelated-path-tip', [{ type: 'turn/start' }])
  const agent = ptcAgent('unrelated-path-agent', session)
  const result = await state.runDurable(session.id, 'throw new Error("path validation failed")', {}, { session, recordSession: 'deferred-result', callId: 'unrelated-path-failure' })
  appendRunCodeEvents(session.events, 'unrelated-path-failure', 'throw new Error("path validation failed")', result)
  const assembly = await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )
  assert.equal(assembly.contexts.some(item => item.name.startsWith('tools:ptc-plus-tip/')), false)
})
