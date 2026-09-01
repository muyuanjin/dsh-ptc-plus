import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { Config } from '../index.js'
import { REPL_MEMORY_META_KEY } from '../internal/repl-memory-projection.js'
import { REWRITES_KEY, normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import { JOURNAL_POLICY, appendRunCodeEvents, fixture, ptcAgent } from './plugin-fixture.js'

test('continues from bindings after a partial failure without redispatching a native call', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  let dispatches = 0
  const session = { id: 'partial-reuse', events: [] }
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
  const session = { id: 'edit-effect-boundary', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )
  const definition = agent.ctx.tools.get('edit_run_code')

  const safeCode = 'let safeValue = 1; return safeValue'
  const safe = await state.runDurable(session.id, safeCode, {}, { session, callId: 'safe' })
  appendRunCodeEvents(session.events, 'safe', safeCode, safe)
  const safeArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const safeCallSeq = appendEditCall(session.events, 'safe-edit', safeArgs)
  const safeEdit = await definition.execute(safeArgs, {
    callId: 'safe-edit', name: 'edit_run_code', agent,
  })
  assert.equal(safeEdit.edited, true)
  assert.equal(safeEdit.value, 2)
  appendEditResult(session.events, 'safe-edit', safeCallSeq, definition.output.presentationMeta(safeArgs, safeEdit))

  let dispatches = 0
  const effectCode = 'const observed = await tools.observe({}); return observed.missing.trim()'
  const failed = await state.runDurable(session.id, effectCode, {
    observe: async () => {
      dispatches += 1
      return { value: 'live result' }
    },
  }, { session, callId: 'effect' })
  assert.equal(failed.isError, true)
  appendRunCodeEvents(session.events, 'effect', effectCode, failed)
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
      { session, callId: options.callId },
    )
    return observed.result
  }
  const effectCallSeq = appendEditCall(session.events, 'effect-edit', effectArgs)
  const replayed = await definition.execute(effectArgs, {
    callId: 'effect-edit', name: 'edit_run_code', agent,
  })
  assert.equal(replayed.edited, true)
  assert.equal(dispatches, 2)
  assert.match(definition.description, /complete corrected cell/)
  assert.match(definition.description, /external effect/)
  appendEditResult(session.events, 'effect-edit', effectCallSeq, definition.output.presentationMeta(effectArgs, replayed))
})

test('repairs a long parse-rejected cell without resending its source', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'long-parse-edit', events }
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
  assert.match(rejected.error.message, /when edit_run_code is declared/)
  assert.match(rejected.error.message, /avoid resending this long source/)
  assert.match(rejected.error.message, /otherwise retry only this cell with corrected source in run_code/)
  appendRunCodeEvents(events, 'long-parse', rejectedCode, rejected)

  const editArgs = {
    edits: [{ old_string: '`program IR`', new_string: '\\`program IR\\`' }],
  }
  const editCallSeq = appendEditCall(events, 'long-parse-edit', editArgs)
  const edited = await state.ctx.tools.execute({
    callId: 'long-parse-edit',
    name: 'edit_run_code',
    arguments: editArgs,
    agent,
    signal,
  })
  const expected = `${longText}\nmodel output \`program IR\` continues\n`
  assert.equal(edited.isError, false)
  assert.deepEqual(edited.value, { edited: true, logs: [], value: expected.length })
  assert.equal(JSON.stringify(edited.value).includes(longText), false)
  assert.equal(JSON.stringify(editArgs).includes(longText), false)
  assert.equal(events.filter(event => event.type === 'tool/call' && event.data?.name === 'run_code').length, 1)
  assert.equal(edited.meta.dshPtcPlusDerivedRun.code.length, rejectedCode.length + 2)
  appendEditResult(events, 'long-parse-edit', editCallSeq, edited.meta)

  assert.deepEqual(await state.run(session.id, 'return longOutput', {}, { session }), {
    logs: [], value: expected,
  })
})

test('executes the validated EOF repair invocation projected by the diagnostic', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'validated-parse-edit', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const rejectedCode = '{\n  const closureValue = 42\n  return closureValue;'
  const rejectedCallSeq = appendRunCall(events, 'validated-parse', rejectedCode)
  const rejected = await state.runDurable(
    session.id,
    rejectedCode,
    {},
    { session, callId: 'validated-parse' },
  )
  assert.equal(rejected.isError, true)
  assert.equal(rejected.meta.dshPtcPlus.status, 'noop')
  const diagnostic = rejected.meta.dshPtcPlus.diagnostics[0]
  assert.deepEqual(diagnostic.help.slice(0, 1), [
    'this cell was not executed; validated syntax repair: append "}" at the end of this cell',
  ])
  const invocation = /call edit_run_code\((\{.*\})\) to apply this correction/.exec(diagnostic.help[1])
  assert.notEqual(invocation, null)
  const editArgs = JSON.parse(invocation[1])
  assert.equal(JSON.stringify(editArgs).includes(rejectedCode), false)
  assert.equal(editArgs.expected_target_call_seq, rejectedCallSeq)
  appendRunResult(events, 'validated-parse', rejectedCallSeq, rejected)

  const editCallSeq = appendEditCall(events, 'validated-parse-edit', editArgs)
  const edited = await state.ctx.tools.execute({
    callId: 'validated-parse-edit',
    name: 'edit_run_code',
    arguments: editArgs,
    agent,
    signal,
  })
  assert.equal(edited.isError, false)
  assert.deepEqual(edited.value, { edited: true, logs: [], value: 42 })
  assert.equal(edited.meta.dshPtcPlusDerivedRun.code, `${rejectedCode}}`)
  appendEditResult(events, 'validated-parse-edit', editCallSeq, edited.meta)
})

test('rejects a validated EOF repair after a newer matching cell becomes editable', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'stale-validated-parse-edit', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )

  const rejectedCode = 'if (true) {'
  const rejectedCallSeq = appendRunCall(events, 'stale-parse', rejectedCode)
  const rejected = await state.runDurable(
    session.id,
    rejectedCode,
    {},
    { session, callId: 'stale-parse' },
  )
  const diagnostic = rejected.meta.dshPtcPlus.diagnostics[0]
  const invocation = /call edit_run_code\((\{.*\})\) to apply this correction/.exec(diagnostic.help[1])
  assert.notEqual(invocation, null)
  const editArgs = JSON.parse(invocation[1])
  assert.equal(editArgs.expected_target_call_seq, rejectedCallSeq)
  appendRunResult(events, 'stale-parse', rejectedCallSeq, rejected)

  const laterCode = 'const marker = "{"; return 7'
  const laterCallSeq = appendRunCall(events, 'later-matching-cell', laterCode)
  const later = await state.runDurable(
    session.id,
    laterCode,
    {},
    { session, callId: 'later-matching-cell' },
  )
  appendRunResult(events, 'later-matching-cell', laterCallSeq, later)
  const editCallSeq = appendEditCall(events, 'stale-parse-edit', editArgs)

  const execute = state.ctx.tools.execute
  let derivedDispatches = 0
  state.ctx.tools.execute = async (request) => {
    if (request.name === 'run_code') derivedDispatches += 1
    return execute(request)
  }
  const edited = await execute({
    callId: 'stale-parse-edit',
    name: 'edit_run_code',
    arguments: editArgs,
    agent,
  })
  assert.equal(edited.isError, false)
  assert.deepEqual(edited.value, {
    edited: false,
    reason: `validated repair targets run_code call ${rejectedCallSeq}, but this edit captured call ${laterCallSeq}`,
  })
  assert.equal(derivedDispatches, 0)
  assert.deepEqual(edited.meta, {})
  appendEditResult(events, 'stale-parse-edit', editCallSeq)
})

test('suppresses a target-bound EOF repair for derived edit parse rejection', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'derived-parse-rejection', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const source = 'if (true) {}'
  const setup = await state.runDurable(
    session.id,
    source,
    {},
    { session, callId: 'derived-parse-setup' },
  )
  appendRunCodeEvents(events, 'derived-parse-setup', source, setup)

  const editArgs = { edits: [{ old_string: '{}', new_string: '{' }] }
  appendEditCall(events, 'derived-parse-edit', editArgs)
  const edited = await state.ctx.tools.execute({
    callId: 'derived-parse-edit',
    name: 'edit_run_code',
    arguments: editArgs,
    agent,
    signal,
  })

  assert.equal(edited.isError, false)
  assert.equal(edited.value.edited, false)
  assert.match(edited.value.error, /correct the reported syntax and retry only this cell with run_code/)
  assert.doesNotMatch(edited.value.error, /validated syntax repair|expected_target_call_seq/)
  assert.deepEqual(edited.meta, {})
})

function appendRunCall(events, callId, code) {
  const seq = events.length
  events.push({
    type: 'tool/call',
    seq,
    data: {
      callId,
      name: 'run_code',
      arguments: JSON.stringify({ code, description: 'test cell' }),
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

function appendEditCall(events, callId, args) {
  const seq = events.length
  events.push({
    type: 'tool/call',
    seq,
    data: { callId, name: 'edit_run_code', arguments: JSON.stringify(args) },
  })
  return seq
}

function appendEditResult(events, callId, callSeq, meta = {}) {
  events.push({
    type: 'tool/result',
    seq: events.length,
    sourceEventSeqs: [callSeq],
    data: { message: { source: { callId } }, meta },
  })
}

test('executes successive real edits and replays derived sources without model duplication', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'real-edit', events }
  const first = fixture()
  const firstAgent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  await first.assemble(
    { sections: [], contexts: [], variables: {}, tools: [first.runCodeDefinition] },
    { agent: firstAgent, scope: firstAgent, signal: requestSignal },
  )

  const setupCode = 'let editableValue = 40; return editableValue'
  const setup = await first.runDurable(session.id, setupCode, {}, { session, callId: 'setup' })
  appendRunCodeEvents(events, 'setup', setupCode, setup)
  const editCallSeq = events.length
  events.push({
    type: 'tool/call', seq: editCallSeq, data: {
      callId: 'edit-1', name: 'edit_run_code',
      arguments: JSON.stringify({ edits: [{ old_string: '40', new_string: '42' }] }),
    },
  })
  const edit = await first.ctx.tools.execute({
    callId: 'edit-1', name: 'edit_run_code',
    arguments: { edits: [{ old_string: '40', new_string: '42' }] },
    agent: firstAgent, signal: requestSignal,
  })
  assert.equal(edit.isError, false)
  assert.deepEqual(edit.value, { edited: true, logs: [], value: 42 })
  assert.equal(JSON.stringify(edit.value).includes(setupCode), false)
  assert.deepEqual(edit.meta.dshPtcPlusEdit, { targetCallSeq: 1 })
  events.push({
    type: 'tool/result', seq: editCallSeq + 1, sourceEventSeqs: [editCallSeq],
    data: { message: { source: { callId: 'edit-1' } }, meta: edit.meta },
  })

  const nextEditCallSeq = events.length
  events.push({
    type: 'tool/call', seq: nextEditCallSeq, data: {
      callId: 'edit-2', name: 'edit_run_code',
      arguments: JSON.stringify({ edits: [{ old_string: '42', new_string: '43' }] }),
    },
  })
  const nextEdit = await first.ctx.tools.execute({
    callId: 'edit-2', name: 'edit_run_code',
    arguments: { edits: [{ old_string: '42', new_string: '43' }] },
    agent: firstAgent, signal: requestSignal,
  })
  assert.equal(nextEdit.isError, false)
  assert.deepEqual(nextEdit.value, { edited: true, logs: [], value: 43 })
  assert.deepEqual(nextEdit.meta.dshPtcPlusEdit, { targetCallSeq: editCallSeq })
  events.push({
    type: 'tool/result', seq: nextEditCallSeq + 1, sourceEventSeqs: [nextEditCallSeq],
    data: { message: { source: { callId: 'edit-2' } }, meta: nextEdit.meta },
  })
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return editableValue', {}, { session }), {
    logs: [], value: 43,
  })
  const restoredAgent = ptcAgent(session.id, session)
  const assembly = await restored.assemble({
    sections: [], contexts: [], variables: {}, tools: [restored.runCodeDefinition],
  }, { agent: restoredAgent, scope: restoredAgent, signal: new AbortController().signal })
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.equal(assembly.contexts.some(context => /edit/i.test(context?.name ?? '')), false)
})

test('binds delayed edit execution to the target captured by its call event', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'delayed-edit-target', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )

  const first = await state.runDurable(session.id, 'return 1', {}, { session })
  appendRunCodeEvents(events, 'first-target', 'return 1', first)
  const editCallSeq = events.length
  events.push({
    type: 'tool/call',
    seq: editCallSeq,
    data: {
      callId: 'delayed-edit',
      name: 'edit_run_code',
      arguments: JSON.stringify({ edits: [{ old_string: '1', new_string: '2' }] }),
    },
  })
  const later = await state.runDurable(session.id, 'return 9', {}, { session })
  appendRunCodeEvents(events, 'later-target', 'return 9', later)

  await assert.rejects(
    () => agent.ctx.tools.get('edit_run_code').execute(
      { edits: [{ old_string: '9', new_string: '10' }] },
      { callId: 'missing-call-event', agent },
    ),
    /requires a unique persisted tool\/call event/,
  )

  let derivedCode
  state.ctx.tools.execute = async (request) => {
    derivedCode = request.arguments.code
    return { isError: false, value: { logs: [], result: 2 }, meta: first.meta }
  }
  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const definition = agent.ctx.tools.get('edit_run_code')
  const edited = await definition.execute(args, { callId: 'delayed-edit', agent })
  assert.equal(derivedCode, 'return 2')
  assert.equal(edited.edited, true)
  assert.deepEqual(definition.output.presentationMeta(args, edited).dshPtcPlusEdit, {
    targetCallSeq: 1,
  })
})

test('cold-replays a delayed edit in its live execution order', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'delayed-edit-replay-order', events }
  const first = fixture()
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await first.assemble(
    { sections: [], contexts: [], variables: {}, tools: [first.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const setupCode = 'let delayedOrder = [1]; return delayedOrder'
  const setup = await first.runDurable(session.id, setupCode, {}, { session, callId: 'setup' })
  appendRunCodeEvents(events, 'setup', setupCode, setup)
  const editArgs = {
    edits: [{ old_string: '[1]', new_string: '[...delayedOrder, 3]' }],
  }
  const editCallSeq = appendEditCall(events, 'delayed-order-edit', editArgs)
  const laterCode = 'delayedOrder.push(4); return delayedOrder'
  const later = await first.runDurable(session.id, laterCode, {}, { session, callId: 'later' })
  appendRunCodeEvents(events, 'later', laterCode, later)

  const edit = await first.ctx.tools.execute({
    callId: 'delayed-order-edit',
    name: 'edit_run_code',
    arguments: editArgs,
    agent,
    signal,
  })
  assert.equal(edit.isError, false)
  assert.deepEqual(edit.value, { edited: true, logs: [], value: [1, 4, 3] })
  appendEditResult(events, 'delayed-order-edit', editCallSeq, edit.meta)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return delayedOrder', {}, { session }), {
    logs: [], value: [1, 4, 3],
  })
})

test('keeps optional rewrite metadata out of derived edit settlement', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'edit-optional-rewrites', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )
  const definition = agent.ctx.tools.get('edit_run_code')
  const code = 'let optionalRewriteValue = 1; return optionalRewriteValue'
  const run = await state.runDurable(session.id, code, {}, { session })
  appendRunCodeEvents(events, 'optional-rewrite-source', code, run)

  const originalExecute = state.ctx.tools.execute
  let derivedDispatches = 0
  state.ctx.tools.execute = async (request) => {
    derivedDispatches += 1
    const result = await originalExecute(request)
    return { ...result, meta: { ...result.meta, [REWRITES_KEY]: {} } }
  }
  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const callSeq = appendEditCall(events, 'optional-rewrite-edit', args)
  const exec = {
    callId: 'optional-rewrite-edit', name: 'edit_run_code', agent,
    signal: new AbortController().signal,
  }
  const edited = await definition.execute(args, exec)
  assert.equal(edited.value, 2)
  const expectedMeta = definition.output.presentationMeta(args, edited)
  assert.equal(Object.hasOwn(expectedMeta, REWRITES_KEY), false)
  const persistedMeta = { ...expectedMeta, [REWRITES_KEY]: {} }
  for (const listener of state.listeners.get('tools/result') ?? []) {
    await listener(exec, { meta: persistedMeta })
  }
  appendEditResult(events, exec.callId, callSeq, persistedMeta)

  const retryArgs = { edits: [{ old_string: '1', new_string: '3' }] }
  const retryCallSeq = appendEditCall(events, 'optional-rewrite-retry', retryArgs)
  const retry = await definition.execute(retryArgs, {
    callId: 'optional-rewrite-retry', name: 'edit_run_code', agent,
    signal: new AbortController().signal,
  })
  assert.equal(retry.edited, false)
  assert.match(retry.reason, /old_string was not found/)
  assert.equal(derivedDispatches, 1)
  appendEditResult(events, 'optional-rewrite-retry', retryCallSeq)
  state.ctx.tools.execute = originalExecute
  await state.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return optionalRewriteValue', {}, { session }), {
    logs: [], value: 2,
  })
})

test('keeps malformed REPL memory metadata out of derived edit settlement', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'edit-malformed-repl-memory', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: requestSignal },
  )
  const code = 'let memorySafeEdit = 1; return memorySafeEdit'
  const setup = await state.runDurable(session.id, code, {}, { session, callId: 'memory-setup' })
  appendRunCodeEvents(events, 'memory-setup', code, setup)

  const execute = state.ctx.tools.execute
  state.ctx.tools.execute = async (options) => {
    const result = await execute(options)
    if (options.name !== 'run_code' || !String(options.callId).endsWith(':derived')) return result
    return {
      ...result,
      meta: { ...result.meta, [REPL_MEMORY_META_KEY]: { status: 'corrupt' } },
    }
  }
  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const callSeq = appendEditCall(events, 'memory-edit', args)
  const edited = await state.ctx.tools.execute({
    callId: 'memory-edit',
    name: 'edit_run_code',
    arguments: args,
    agent,
    signal: requestSignal,
  })
  assert.equal(edited.isError, false)
  assert.deepEqual(edited.value, { edited: true, logs: [], value: 2 })
  assert.equal(Object.hasOwn(edited.meta, REPL_MEMORY_META_KEY), false)
  assert.deepEqual(edited.meta.dshPtcPlusEdit, { targetCallSeq: 1 })
  appendEditResult(events, 'memory-edit', callSeq, edited.meta)
  state.ctx.tools.execute = execute
  await state.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return memorySafeEdit', {}, { session }), {
    logs: [], value: 2,
  })
})

test('fails edit execution at each owned boundary without changing the target', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'edit-boundaries', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )
  const definition = agent.ctx.tools.get('edit_run_code')

  const noTargetArgs = { edits: [{ old_string: 'x', new_string: 'y' }] }
  const noTarget = await state.ctx.tools.execute({
    callId: 'none-registry', name: 'edit_run_code', arguments: noTargetArgs, agent,
  })
  assert.deepEqual(noTarget.value, {
    edited: false, reason: 'no run_code cell is currently eligible for safe editing',
  })
  assert.deepEqual(noTarget.meta, {})

  assert.deepEqual(await definition.execute({ edits: [{ old_string: 'x', new_string: 'y' }] }, {
    callId: 'none', agent,
  }), { edited: false, reason: 'no run_code cell is currently eligible for safe editing' })
  const emptyMeta = definition.output.presentationMeta({}, false)
  assert.deepEqual(emptyMeta, {})
  assert.deepEqual(definition.output.presentationMeta({}, { edited: true }), {})
  assert.notEqual(definition.output.presentationMeta({}, false), emptyMeta)
  assert.deepEqual(definition.output.render({}, { edited: false, reason: 'no target' }), [{
    type: 'text', text: '{"edited":false,"reason":"no target"}',
  }])

  const code = 'return 1'
  const run = await state.runDurable(session.id, code, {}, { session })
  appendRunCodeEvents(events, 'editable', code, run)
  const invalidCallSeq = appendEditCall(events, 'invalid', { edits: [] })
  const invalid = await state.ctx.tools.execute({
    callId: 'invalid', name: 'edit_run_code', arguments: { edits: [] }, agent,
  })
  assert.match(invalid.value.reason, /at least one/)
  assert.deepEqual(invalid.meta, {})
  appendEditResult(events, 'invalid', invalidCallSeq)

  const originalExecute = state.ctx.tools.execute
  state.ctx.tools.execute = undefined
  const missingArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const missingCallSeq = appendEditCall(events, 'missing', missingArgs)
  await assert.rejects(() => definition.execute({ edits: [{ old_string: '1', new_string: '2' }] }, {
    callId: 'missing', agent,
  }), /tools.execute is required/)
  appendEditResult(events, 'missing', missingCallSeq)
  state.ctx.tools.execute = async () => ({ isError: false, value: 7, meta: null })
  const missingJournalCallSeq = appendEditCall(events, 'missing-journal', missingArgs)
  await assert.rejects(() => definition.execute({ edits: [{ old_string: '1', new_string: '2' }] }, {
    callId: 'missing-journal', agent,
  }), /did not contain a valid execution journal/)
  appendEditResult(events, 'missing-journal', missingJournalCallSeq)
  const noopJournal = { ...run.meta.dshPtcPlus, status: 'noop' }
  state.ctx.tools.execute = async () => ({
    isError: true, error: { message: 'rejected by runtime' }, meta: { dshPtcPlus: noopJournal },
  })
  const noopRejectedCallSeq = appendEditCall(events, 'noop-rejected', missingArgs)
  assert.deepEqual(await definition.execute(missingArgs, { callId: 'noop-rejected', agent }), {
    edited: false, error: 'rejected by runtime', logs: [],
  })
  appendEditResult(events, 'noop-rejected', noopRejectedCallSeq, { dshPtcPlus: noopJournal })
  state.ctx.tools.execute = async () => ({
    isError: false, value: 7, meta: { dshPtcPlus: noopJournal },
  })
  const noopUnexpectedCallSeq = appendEditCall(events, 'noop-unexpected', missingArgs)
  await assert.rejects(
    () => definition.execute(missingArgs, { callId: 'noop-unexpected', agent }),
    /did not contain a valid execution journal/,
  )
  appendEditResult(events, 'noop-unexpected', noopUnexpectedCallSeq, { dshPtcPlus: noopJournal })
  state.ctx.tools.execute = async () => ({
    isError: true, error: { message: 'blocked before runtime' }, meta: {},
  })
  const preRuntimeCallSeq = appendEditCall(events, 'pre-runtime-rejection', missingArgs)
  assert.deepEqual(await definition.execute({ edits: [{ old_string: '1', new_string: '2' }] }, {
    callId: 'pre-runtime-rejection', agent,
  }), { edited: false, error: 'blocked before runtime', logs: [] })
  appendEditResult(events, 'pre-runtime-rejection', preRuntimeCallSeq)

  const rewriteFacts = [{ kind: 'import', description: 'Adapt import declaration.' }]
  state.ctx.tools.execute = async () => ({
    isError: false,
    value: 7,
    meta: { ...run.meta, [REWRITES_KEY]: rewriteFacts, foreignOwnerFact: { secret: true } },
  })
  const primitiveArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const primitiveCallSeq = appendEditCall(events, 'primitive', primitiveArgs)
  const primitive = await definition.execute(primitiveArgs, {
    callId: 'primitive', agent,
  })
  assert.equal(primitive.value, 7)
  const primitiveMeta = definition.output.presentationMeta(primitiveArgs, primitive)
  assert.deepEqual(primitiveMeta.dshPtcPlusEdit, { targetCallSeq: 1 })
  assert.deepEqual(primitiveMeta.dshPtcPlusDerivedRun, {
    code: 'return 2', description: 'Edit and run TypeScript cell',
  })
  assert.deepEqual(primitiveMeta[REWRITES_KEY], rewriteFacts)
  assert.deepEqual(primitiveMeta[REPL_MEMORY_META_KEY], run.meta[REPL_MEMORY_META_KEY])
  assert.equal(primitiveMeta[REPL_MEMORY_META_KEY].entries.every(entry => (
    Object.keys(entry).sort().join(',') === 'kind,name'
  )), true)
  assert.equal(Object.hasOwn(primitiveMeta, 'foreignOwnerFact'), false)
  assert.deepEqual(Object.keys(primitiveMeta).sort(), [
    'dshPtcPlus', 'dshPtcPlusDerivedRun', 'dshPtcPlusEdit', REPL_MEMORY_META_KEY, REWRITES_KEY,
  ].sort())
  const blockedArgs = { edits: [{ old_string: '1', new_string: '3' }] }
  const blockedCallSeq = appendEditCall(events, 'pre-persistence-window', blockedArgs)
  assert.match((await definition.execute({ edits: [{ old_string: '1', new_string: '3' }] }, {
    callId: 'pre-persistence-window', agent,
  })).reason, /no run_code cell/)
  appendEditResult(events, 'pre-persistence-window', blockedCallSeq)
  appendEditResult(events, 'primitive', primitiveCallSeq, primitiveMeta)
  const afterArgs = { edits: [{ old_string: '2', new_string: '3' }] }
  const afterCallSeq = appendEditCall(events, 'after-persistence', afterArgs)
  assert.equal((await definition.execute({ edits: [{ old_string: '2', new_string: '3' }] }, {
    callId: 'after-persistence', agent,
  })).value, 7)
  appendEditResult(
    events,
    'after-persistence',
    afterCallSeq,
    definition.output.presentationMeta(afterArgs, { edited: true }),
  )

  const nextRun = await state.runDurable(session.id, code, {}, { session })
  appendRunCodeEvents(events, 'editable-again', code, nextRun)
  state.ctx.tools.execute = async () => ({ isError: true, error: {}, meta: nextRun.meta })
  const failedArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const failedExec = {
    callId: 'failed', name: 'edit_run_code', agent,
  }
  appendEditCall(events, 'failed', failedArgs)
  const failed = await definition.execute(failedArgs, failedExec)
  assert.equal(failed.error, 'derived run_code execution failed')
  assert.deepEqual(
    definition.output.presentationMeta(failedArgs, failed).dshPtcPlus,
    normalizeJournal(nextRun.meta.dshPtcPlus),
  )
  await state.emit('session/disposed', session)
  state.listeners.get('tools/result')[0](failedExec, { meta: {} })
  state.ctx.tools.execute = originalExecute
})

test('releases edit claims when derived execution has no owner-proven settlement', async (t) => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const session = { id: 'edit-in-flight', events }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const requestSignal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: requestSignal },
  )
  const definition = agent.ctx.tools.get('edit_run_code')
  const code = 'return 1'
  const run = await state.runDurable(session.id, code, {}, { session })
  appendRunCodeEvents(events, 'editable-in-flight', code, run)

  const presentationMeta = definition.output.presentationMeta
  definition.output.presentationMeta = () => ({})
  const removedArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const removedCallSeq = appendEditCall(events, 'removed-edit-metadata', removedArgs)
  const removedMetadata = await state.ctx.tools.execute({
    callId: 'removed-edit-metadata',
    name: 'edit_run_code',
    arguments: removedArgs,
    agent,
    signal: requestSignal,
  })
  definition.output.presentationMeta = presentationMeta
  assert.equal(removedMetadata.value.edited, true)
  assert.deepEqual(removedMetadata.meta, {})
  appendEditResult(events, 'removed-edit-metadata', removedCallSeq)

  let rejectDerived
  state.ctx.tools.execute = () => new Promise((_resolve, reject) => { rejectDerived = reject })
  const pendingArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const pendingCallSeq = appendEditCall(events, 'pending-edit', pendingArgs)
  const pending = definition.execute(pendingArgs, {
    callId: 'pending-edit', agent, signal: new AbortController().signal,
  })
  await Promise.resolve()
  assert.match((await definition.execute(pendingArgs, {
    callId: 'pending-edit', agent, signal: new AbortController().signal,
  })).reason, /already has a derived execution/)
  rejectDerived(new Error('derived dispatch rejected'))
  await assert.rejects(pending, /derived dispatch rejected/)
  appendEditResult(events, 'pending-edit', pendingCallSeq)

  state.ctx.tools.execute = async ({ signal }) => {
    if (signal.aborted) throw signal.reason
    return { isError: true, error: { message: 'blocked before runtime' }, meta: {} }
  }
  const controller = new AbortController()
  controller.abort(new Error('cancelled derived dispatch'))
  const cancelledArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const cancelledCallSeq = appendEditCall(events, 'cancelled-edit', cancelledArgs)
  await assert.rejects(definition.execute(cancelledArgs, {
    callId: 'cancelled-edit', agent, signal: controller.signal,
  }), /cancelled derived dispatch/)
  appendEditResult(events, 'cancelled-edit', cancelledCallSeq)
  const retryArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const retryCallSeq = appendEditCall(events, 'retry-after-cancel', retryArgs)
  assert.deepEqual(await definition.execute(retryArgs, {
    callId: 'retry-after-cancel', agent, signal: new AbortController().signal,
  }), { edited: false, error: 'blocked before runtime', logs: [] })
  appendEditResult(events, 'retry-after-cancel', retryCallSeq)
  const preRuntimeArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const preRuntimeCallSeq = appendEditCall(events, 'retry-after-pre-runtime-result', preRuntimeArgs)
  assert.deepEqual(await definition.execute(preRuntimeArgs, {
    callId: 'retry-after-pre-runtime-result', agent, signal: new AbortController().signal,
  }), { edited: false, error: 'blocked before runtime', logs: [] })
  appendEditResult(events, 'retry-after-pre-runtime-result', preRuntimeCallSeq)

  const restored = fixture()
  t.after(() => restored.dispose())
  const restoredAgent = ptcAgent(session.id, session)
  await restored.assemble(
    { sections: [], contexts: [], variables: {}, tools: [restored.runCodeDefinition] },
    { agent: restoredAgent, scope: restoredAgent },
  )
  const restoredDefinition = restoredAgent.ctx.tools.get('edit_run_code')
  restored.ctx.tools.execute = async () => ({
    isError: true, error: { message: 'blocked before runtime' }, meta: {},
  })
  const recoveredArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const recoveredCallSeq = appendEditCall(events, 'recovered-retry', recoveredArgs)
  assert.deepEqual(await restoredDefinition.execute(recoveredArgs, {
    callId: 'recovered-retry', agent: restoredAgent, signal: new AbortController().signal,
  }), { edited: false, error: 'blocked before runtime', logs: [] })
  appendEditResult(events, 'recovered-retry', recoveredCallSeq)

  state.ctx.tools.execute = async () => ({ isError: false, value: 2, meta: run.meta })
  const orphanArgs = { edits: [{ old_string: '1', new_string: '2' }] }
  const orphanExec = {
    callId: 'missing-settlement-metadata', name: 'edit_run_code', agent,
    signal: new AbortController().signal,
  }
  const orphanCallSeq = appendEditCall(events, orphanExec.callId, orphanArgs)
  assert.equal((await definition.execute(orphanArgs, orphanExec)).edited, true)
  await state.listeners.get('tools/result')[0](orphanExec, { meta: {} })
  appendEditResult(events, orphanExec.callId, orphanCallSeq)

  const disposedExec = {
    callId: 'disposed-before-result', name: 'edit_run_code', agent,
    signal: new AbortController().signal,
  }
  appendEditCall(events, disposedExec.callId, orphanArgs)
  assert.equal((await definition.execute(orphanArgs, disposedExec)).edited, true)
  await state.emit('session/disposed', session)
  await state.listeners.get('tools/result')[0](disposedExec, { meta: {} })
})

test('keeps truthful run and edit transports with a stable prompt prefix', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const codeOnlyAssembly = {
    sections: [
      { name: 'tools:code-only', text: 'upstream code-only guidance' },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  const session = { id: 'prefix-stability-session', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent('prefix-stability-agent', session)
  const assemble = () => state.assemble(codeOnlyAssembly, {
    agent, scope: agent, signal: new AbortController().signal,
  })
  const surface = assembly => JSON.stringify({
    sections: assembly.sections,
    tools: assembly.tools,
  })

  const baselineAssembly = await assemble()
  const baseline = surface(baselineAssembly)
  assert.deepEqual(baselineAssembly.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.deepEqual(JSON.parse(JSON.stringify(baselineAssembly.tools)), baselineAssembly.tools)
  assert.equal(
    baselineAssembly.sections.find(section => section.name === 'tools:code-only').text,
    '`run_code` and `edit_run_code` are the only tools callable directly. Call every native tool declared by the SDK from inside a program.',
  )
  const sdk = baselineAssembly.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(sdk, /edit_run_code/)
  assert.equal(baselineAssembly.contexts.some(context => /edit/i.test(context?.name ?? '')), false)
  assert.equal(surface(await assemble()), baseline)

  const rejectedCode = 'return )'
  const rejected = await state.runDurable(session.id, rejectedCode, {}, { session })
  appendRunCodeEvents(session.events, 'prefix-rejected', rejectedCode, rejected)
  const afterRejection = await assemble()
  assert.equal(surface(afterRejection), baseline)
  assert.equal(afterRejection.contexts.some(context => /edit/i.test(context?.name ?? '')), false)

  await state.emit('agent/disposed', { agent })
  assert.equal(agent.presentation.disposals, 1)
  await state.emit('session/disposed', session)
})
test('uses environment-neutral tips for command failures and escalates repeated binding failures', async (t) => {
  const state = fixture({ tipCooldownMessages: 1, tipEscalationFailures: 2 })
  t.after(() => state.dispose())
  const session = { id: 'platform-tip-session', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent('platform-tip-agent', session)
  const codeOnlyAssembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  const assemble = () => state.assemble(codeOnlyAssembly, {
    agent, scope: agent, signal: new AbortController().signal,
  })
  const stableSurface = assembly => JSON.stringify({ sections: assembly.sections, tools: assembly.tools })
  const baselineSurface = stableSurface(await assemble())
  const tipOf = async () => {
    const assembly = await assemble()
    assert.equal(stableSurface(assembly), baselineSurface)
    return assembly.contexts.find(item => item.name.startsWith('tools:ptc-plus-tip/'))
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
  const commandResult = await state.runDurable(session.id, commandFailure, {}, { session })
  appendRunCodeEvents(session.events, 'platform-failure', commandFailure, commandResult)
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
    const result = await state.runDurable(session.id, unrelated, {}, { session })
    appendRunCodeEvents(session.events, `generic-failure-${index}`, unrelated, result)
  }
  nextRequest()
  assert.equal(await tipOf(), undefined)

  const repeated = 'return missingTipBinding'
  for (let index = 0; index < 3; index += 1) {
    const result = await state.runDurable(session.id, repeated, {}, { session })
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
  assert.match(detailedBinding.text, /Do not invent hidden bindings/)
  assert.match(detailedBinding.text, /capabilities\.find\(\)/)
  assert.match(detailedBinding.text, /capabilities\.inspect\(\)/)
  assert.doesNotMatch(detailedBinding.text, /(?:^|[^.])\bfind\(\)/)
  assert.doesNotMatch(detailedBinding.text, /(?:^|[^.])\binspect\(\)/)
})

test('recognizes platform diagnostics from structured causes and Windows wording', async (t) => {
  const state = fixture({ tipCooldownMessages: 1 })
  t.after(() => state.dispose())
  const session = { id: 'structured-platform-tip', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent('structured-platform-agent', session)
  const codeOnlyAssembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  const assemble = () => state.assemble(codeOnlyAssembly, {
    agent, scope: agent, signal: new AbortController().signal,
  })
  const result = await state.executeRun(session.id, 'return await tools.run({})', {
    run: async () => {
      const error = new Error('The system cannot find the file specified')
      error.code = 'ENOENT'
      throw error
    },
  }, { session })
  appendRunCodeEvents(session.events, 'structured-platform-failure', 'return await tools.run({})', result.result)
  const tip = assemble()
  assert.match((await tip).contexts.find(item => item.name.startsWith('tools:ptc-plus-tip/')).text, /executable, shell, or path/)
})

test('does not turn an unrelated path error into an environment tip', async (t) => {
  const state = fixture({ tipCooldownMessages: 1 })
  t.after(() => state.dispose())
  const session = { id: 'unrelated-path-tip', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent('unrelated-path-agent', session)
  const result = await state.runDurable(session.id, 'throw new Error("path validation failed")', {}, { session })
  appendRunCodeEvents(session.events, 'unrelated-path-failure', 'throw new Error("path validation failed")', result)
  const assembly = await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )
  assert.equal(assembly.contexts.some(item => item.name.startsWith('tools:ptc-plus-tip/')), false)
})
