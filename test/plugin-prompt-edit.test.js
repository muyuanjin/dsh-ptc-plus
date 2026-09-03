import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { Config } from '../index.js'
import { REWRITES_KEY, normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import {
  JOURNAL_POLICY,
  appendRunCodeEvents,
  fixture,
  ptcAgent,
} from './plugin-fixture.js'

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

test('continues TypeScript bindings across cells in one session', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.deepEqual(await state.run('session-a', `
const seed: number = 40
async function add(value: number): Promise<number> { return seed + value }
`), { logs: [] })
  assert.deepEqual(await state.run('session-a', 'return add(2)'), { logs: [], value: 42 })
})

test('evaluates complete block cells with awaited lexical initializers', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const source = `{
  const awaitedConst = await Promise.resolve(19)
  let awaitedLet = await Promise.resolve(20)
  let nestedResult = 0
  {
    const { value: nestedValue } = await Promise.resolve({ value: 3 })
    nestedResult = nestedValue
  }
  if (awaitedConst + awaitedLet + nestedResult !== 42) throw new Error('incorrect block result')
}
// framing remains outside this trailing comment`
  const observed = await state.executeRun('block-await', source, {}, {})
  assert.deepEqual(observed.raw, { logs: [] })
  assert.equal(observed.result.meta.dshPtcPlus.status, 'durable')
  assert.deepEqual(await state.run('block-await', `
"use strict";
{
  const strictThis = (function () { return this })()
  const strictOk = await Promise.resolve(strictThis === undefined)
  if (!strictOk) throw new Error('directive prologue was not preserved')
}
return [typeof __ptc_canary, typeof awaitedConst, typeof awaitedLet, typeof nestedResult, typeof nestedValue]
`), { logs: [], value: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'] })
})

test('cold-replays a block-scoped awaited initializer without source conventions', async (t) => {
  const events = []
  const session = { id: 'block-await-replay', events }
  const first = fixture()
  t.after(() => first.dispose())

  const setupCode = 'let blockAwaitReplayValue = 0'
  const setup = await first.runDurable(session.id, setupCode, {}, { session })
  appendRunCodeEvents(events, 'block-await-setup', setupCode, setup)
  const blockCode = `{
  const nextValue = await Promise.resolve(42)
  blockAwaitReplayValue = nextValue
}
// no model-side semicolon`
  const block = await first.runDurable(session.id, blockCode, {}, { session })
  assert.equal(block.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'block-await-cell', blockCode, block)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return blockAwaitReplayValue', {}, { session }), {
    logs: [],
    value: 42,
  })
})

test('can disable durable replay while preserving live volatile continuation', async (t) => {
  const events = []
  const session = { id: 'durable-replay-disabled', events }
  const writer = fixture()

  const setupCode = 'let historicalBinding = 41'
  const setup = await writer.runDurable(session.id, setupCode, {}, { session })
  appendRunCodeEvents(events, 'durable-replay-setup', setupCode, setup)
  appendRunCodeEvents(events, 'durable-replay-corrupt', 'let corruptHistory = 1', {
    meta: { dshPtcPlus: { version: 999 } },
  })
  await writer.dispose()

  const state = fixture({ durableReplay: false })
  t.after(() => state.dispose())
  const first = await state.executeRun(session.id, 'return typeof historicalBinding', {}, { session })
  assert.equal(first.raw.value, 'undefined')
  assert.equal(first.result.meta.dshPtcPlus.status, 'volatile')
  assert.equal(
    first.result.meta.dshPtcPlus.volatileReason,
    'durable replay disabled by configuration',
  )
  assert.deepEqual(first.raw.logs, [])
  assert.deepEqual(first.result.meta.dshPtcPlus.diagnostics, [])

  const defined = await state.runDurable(session.id, 'let liveOnlyBinding = 42', {}, { session })
  assert.equal(defined.meta.dshPtcPlus.status, 'volatile')
  const reused = await state.runDurable(session.id, 'return liveOnlyBinding', {}, { session })
  assert.equal(reused.value, 42)
  assert.equal(reused.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(reused.meta.dshPtcPlus.diagnostics, [])

  const save = await state.runDurable(
    session.id,
    'return await repl.state({ action: "save", name: "unavailable" })',
    {},
    { session },
  )
  assert.equal(save.isError, true)
  assert.equal(save.meta.dshPtcPlus.status, 'volatile')
  assert.match(save.error.message, /cannot save a durable REPL state from a volatile segment/)
})

test('presents one coherent persistent REPL contract to the model', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  assert.equal(state.sections.length, 1)
  assert.equal(state.sections[0].name, 'tools:ptc-plus-repl')
  assert.equal(state.sections[0].order, 98)
  const guidance = state.sections[0].text({})
  assert.match(guidance.split('\n')[0], /^`run_code` continues one persistent PTC REPL\./)
  assert.match(guidance, /persistent PTC REPL/)
  assert.match(guidance, /Ordinary top-level bindings remain available to later cells, so reuse them instead of resending setup code/)
  assert.match(guidance, /Choose the smallest cell that answers the request/)
  assert.match(guidance, /return only the value the next step needs/)
  assert.match(guidance, /host may append a bounded recovery context/)
  assert.doesNotMatch(guidance, /PTC-C001|state: partially-applied|do not resend the full source/)
  assert.match(guidance, /`tools\.read` is bounded inspection/)
  assert.match(guidance, /reduce them to targeted excerpts/)
  assert.match(guidance, /neither returned nor printed produce no output/)
  assert.match(guidance, /static `import` declarations are adapted with live, read-only bindings and top-level `export` modifiers are stripped automatically/)
  assert.match(guidance, /Mixed new\/existing top-level destructuring is split automatically/)
  assert.match(guidance, /discover the current request's live `tools\.\*` members/)
  assert.match(guidance, /`capabilities\.find\(\)`/)
  assert.match(guidance, /`capabilities\.inspect\(\)`/)
  assert.doesNotMatch(guidance, /capability namespaces|plugin-provided|materialized source|derived execution/)
  assert.doesNotMatch(guidance, /(?:^|[^.])`find\(\)`/)
  assert.doesNotMatch(guidance, /(?:^|[^.])`inspect\(\)`/)
  assert.match(guidance, /reserve `code\.run` for source already held as data/)
  assert.match(guidance, /instead of assuming Windows, WSL, POSIX, or a particular shell/)
  assert.doesNotMatch(guidance, /child_process|ComSpec|\.cmd|\.bat/)
  assert.match(guidance, /Repeated top-level `const`\/`let` declarations replace existing bindings/)
  assert.match(guidance, /Repeated top-level `function`\/`class` declarations remain unsupported/)
  assert.match(guidance, /assign a function or class expression to an existing writable binding/)
  assert.match(guidance, /place one-off declarations inside a block/)
  assert.doesNotMatch(guidance, /orientation|inventory|PTC-N002|PTC-V001/)
  assert.match(guidance, /Direct Node\/OS access remains live but is not replayed after a kernel restart/)
  const functionClassLoose = fixture({ looseTopLevelFunctionClassRedeclarations: true })
  t.after(() => functionClassLoose.dispose())
  assert.match(functionClassLoose.sections[0].text({}), /Repeated top-level named `function`\/`class` declarations replace existing writable bindings at their declaration position\. Do not rely on function hoisting or class TDZ; define a replacement before using that name in the cell\./)
  const strict = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => strict.dispose())
  assert.match(strict.sections[0].text({}), /Repeated top-level variable declarations fail before execution/)
  const strictVariablesLooseFunctions = fixture({
    looseTopLevelRedeclarations: false,
    looseTopLevelFunctionClassRedeclarations: true,
  })
  t.after(() => strictVariablesLooseFunctions.dispose())
  const independentGuidance = strictVariablesLooseFunctions.sections[0].text({})
  assert.match(independentGuidance, /Repeated top-level variable declarations fail before execution/)
  assert.match(independentGuidance, /Repeated top-level named `function`\/`class` declarations replace existing writable bindings/)
  assert.doesNotMatch(independentGuidance, /existing top-level name fails/)
  const volatileOnly = fixture({ durableReplay: false })
  t.after(() => volatileOnly.dispose())
  assert.match(
    volatileOnly.sections[0].text({}),
    /Durable replay is disabled for this profile\. Bindings remain reusable only in the current process; a new kernel starts empty\./,
  )
  const importOnly = fixture({ autoRewriteImports: true, autoStripExports: false })
  t.after(() => importOnly.dispose())
  assert.match(importOnly.sections[0].text({}), /static `import` declarations are adapted with live, read-only bindings; top-level `export` modifiers remain unsupported\./)
  const exportOnly = fixture({ autoRewriteImports: false, autoStripExports: true })
  t.after(() => exportOnly.dispose())
  assert.match(exportOnly.sections[0].text({}), /top-level `export` modifiers are stripped automatically; static `import` declarations remain unsupported\./)
  const noModuleRewrite = fixture({ autoRewriteImports: false, autoStripExports: false })
  t.after(() => noModuleRewrite.dispose())
  assert.match(noModuleRewrite.sections[0].text({}), /static `import` declarations and top-level `export` modifiers remain unsupported\./)
  const noSplit = fixture({ autoSplitRedeclarations: false })
  t.after(() => noSplit.dispose())
  assert.match(noSplit.sections[0].text({}), /Mixed new\/existing top-level destructuring remains unsupported/)
  state.ctx.tools.get = () => undefined
  assert.equal(state.sections[0].text({}), '')
})

test('preserves Cordis source bindings after a failed define call', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const source = 'return { plugin: true }'
  const failed = await state.executeRun(
    'cordis-binding-reuse',
    'const clientCode = ' + JSON.stringify(source) + '\nawait tools.cordis_define({ plugin: { kind: "new", idPrefix: "demo" }, name: "demo", purpose: "test", code: { client: clientCode } })',
    { cordis_define: async () => { throw new Error('dynamic package `code.client` failed to parse') } },
    {},
  )
  assert.equal(failed.raw.error.kind, 'exception')
  assert.match(failed.raw.error.message, /state: partially-applied/)
  assert.match(
    failed.result.meta.dshPtcPlus.diagnostics[0].help.find(item => item.includes('bindings assigned before')),
    /bindings assigned before this Cordis failure remain live/,
  )
  assert.deepEqual(await state.run('cordis-binding-reuse', 'return clientCode'), { logs: [], value: source })
})

test('does not label an unrelated native ToolCallError as Cordis', async (t) => {
  const state = fixture(
    { cordisToolsEnabled: true },
    { agents: { list: () => [] } },
  )
  t.after(() => state.dispose())
  const failed = await state.executeRun(
    'unrelated-tool-failure',
    'await tools.read({ file_path: "missing" })',
    { read: async () => { throw new Error('Cordis dynamic package text in an unrelated error') } },
    {},
  )
  const help = failed.result.meta.dshPtcPlus.diagnostics[0].help.join('\n')
  assert.doesNotMatch(help, /this Cordis failure/)
})

test('renders long-cell recovery advice in the tool error without a runtime context', async (t) => {
  const state = fixture({ computeMs: 10_000, maxWallMs: 10_000 })
  t.after(() => state.dispose())
  const source = `const clientCode = "source"\n${' '.repeat(2_001)}\nawait tools.cordis_define({ code: { client: clientCode } })`
  const failed = await state.executeRun(
    'cordis-long-cell',
    source,
    { cordis_define: async () => { throw new Error('dynamic package code.client failed to parse') } },
    {},
  )
  assert.match(
    failed.raw.error.message,
    /execution may have occurred; inspect live state in a new short `run_code` cell before deciding whether a correction is safe/,
  )
  assert.match(
    failed.result.meta.dshPtcPlus.diagnostics[0].help.join('\n'),
    /execution may have occurred; inspect live state/,
  )
})

test('immutably adapts the model-visible run_code schema', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const runCode = {
    name: 'run_code',
    description: 'Execute one standalone program.',
    annotation: { retained: true },
    parameters: {
      type: 'object',
      additionalProperties: false,
      comment: 'retained',
      properties: {
        code: { type: 'string', description: 'Standalone source.', minLength: 0 },
        description: { type: 'string', description: 'Program summary.', maxLength: 80 },
      },
      required: ['code', 'description'],
    },
  }
  const original = structuredClone(runCode)
  const other = { name: 'other', description: 'Other tool.', parameters: { type: 'object', properties: {} } }
  const initial = { sections: [], contexts: [], tools: [], variables: {} }
  const downstream = { sections: [{ name: 'later', text: 'kept' }], contexts: [], tools: [other, runCode], variables: { kept: 'yes' } }
  const adapted = await state.assemble(initial, {}, async () => downstream)

  assert.notEqual(adapted, downstream)
  assert.deepEqual(runCode, original)
  assert.equal(adapted.sections, downstream.sections)
  assert.equal(adapted.contexts, downstream.contexts)
  assert.equal(adapted.variables, downstream.variables)
  assert.equal(adapted.tools[0], other)
  assert.equal(adapted.tools[1].name, 'run_code')
  assert.match(adapted.tools[1].description, /next TypeScript cell.*persistent REPL/)
  assert.equal(adapted.tools[1].parameters.properties.code.description,
    'Code for the next REPL cell, parsed as the body of an async TypeScript function.')
  assert.equal(adapted.tools[1].parameters.properties.description.description,
    'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).')
  assert.deepEqual(adapted.tools[1].annotation, { retained: true })
  assert.equal(adapted.tools[1].parameters.additionalProperties, false)
  assert.equal(adapted.tools[1].parameters.comment, 'retained')
  assert.deepEqual(adapted.tools[1].parameters.required, ['code', 'description'])
  assert.equal(adapted.tools[1].parameters.properties.code.minLength, 0)
  assert.equal(adapted.tools[1].parameters.properties.description.maxLength, 80)
})

test('registers edit_run_code and preserves its model-authored stream', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  assert.equal(state.ctx.tools.get('edit_run_code'), undefined)
  const agent = ptcAgent('registered-edit', { id: 'registered-edit', events: [] })
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )
  const definition = agent.ctx.tools.get('edit_run_code')
  assert.equal(definition.name, 'edit_run_code')
  assert.equal(typeof definition.execute, 'function')
  assert.match(definition.description, /run the complete corrected cell/)
  assert.match(definition.description, /external effect/)
  assert.deepEqual(agent.registration.calls, ['edit_run_code'])

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'edit-1', name: 'edit_run_code', argumentsDelta: '{"edits":[]}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'edit-1', name: 'edit_run_code', arguments: '{"edits":[]}' } },
    { type: 'finish', finishReason: 'tool-calls' },
  ]
  assert.deepEqual(await state.stream({ tools: [state.runCodeDefinition, definition] }, chunks), chunks)
})

test('keeps edit_run_code out of the program SDK while preserving the direct surface', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent('direct-only-edit-registration', { id: 'direct-only-edit-registration', events: [] })
  let observed
  const input = {
    sections: [{
      name: 'tools:sdk',
      text: `## SDK

\`\`\`ts
interface ToolArgsMap {
  /** Direct edit transport. */
  edit_run_code: { edits: unknown[] };
  read: { file_path: string };
}
interface ToolOutputMap {
  /** Direct edit transport. */
  edit_run_code: unknown;
  read: unknown;
}
\`\`\``,
    }],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  const assembly = await state.assemble(
    input,
    { agent, scope: agent },
    async () => {
      observed = agent.ctx.tools.get('edit_run_code')
      return input
    },
  )
  assert.equal(observed?.name, 'edit_run_code')
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(sdk, /edit_run_code/)
  assert.match(sdk, /read: \{ file_path: string \}/)
})

test('keeps the complete request projection byte-stable across edit registration lifecycles', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = { id: 'stable-edit-registration', events: [] }
  const emptySdk = `## SDK

\`\`\`ts
interface ToolArgsMap {}
interface ToolOutputMap {}
\`\`\``
  const editSdk = `## SDK

\`\`\`ts
interface ToolArgsMap {
  /** Direct edit transport. */
  edit_run_code: { edits: unknown[] };
}
interface ToolOutputMap {
  edit_run_code: unknown;
}
\`\`\``
  const stableView = assembly => JSON.stringify({
    sections: assembly.sections,
    contexts: assembly.contexts,
    tools: assembly.tools,
  })
  const assembleEpoch = async (owner, agent) => {
    const initial = {
      sections: [{ name: 'tools:sdk', text: emptySdk }],
      contexts: [],
      variables: {},
      tools: [owner.runCodeDefinition],
    }
    return owner.assemble(initial, { agent, scope: agent }, async () => ({
      ...initial,
      sections: [{ name: 'tools:sdk', text: editSdk }],
      tools: [owner.runCodeDefinition, agent.ctx.tools.get('edit_run_code')],
    }))
  }

  const agent = ptcAgent('stable-edit-registration-agent', session)
  const [first, concurrent] = await Promise.all([
    assembleEpoch(state, agent),
    assembleEpoch(state, agent),
  ])
  const subsequent = await assembleEpoch(state, agent)
  assert.equal(stableView(concurrent), stableView(first))
  assert.equal(stableView(subsequent), stableView(first))
  assert.equal(first.sections[0].text.includes('interface ToolArgsMap {}'), true)
  assert.equal(first.contexts.some(context => /edit/i.test(context?.name ?? '')), false)

  await state.emit('agent/disposed', { agent })
  const resumedState = fixture()
  t.after(() => resumedState.dispose())
  const resumedAgent = ptcAgent('stable-edit-registration-resumed-agent', session)
  const resumed = await assembleEpoch(resumedState, resumedAgent)
  assert.equal(stableView(resumed), stableView(first))
})

test('defers edit registration until the first code composition is captured', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent('created-edit-registration', { id: 'created-edit-registration', events: [] })
  await state.emit('agent/created', { agent })
  assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
  await state.assemble(
    {
      sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
      contexts: [], variables: {}, tools: [state.runCodeDefinition],
    },
    { agent, scope: agent },
  )
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')
})

test('fails closed when a native edit_run_code name already occupies the agent scope', async (t) => {
  const nativeEdit = {
    name: 'edit_run_code',
    description: 'Host-owned edit tool.',
    parameters: { type: 'object', properties: {} },
  }
  const state = fixture({}, { scopedSchemas: [nativeEdit] })
  t.after(() => state.dispose())
  const agent = ptcAgent('native-edit-collision', { id: 'native-edit-collision', events: [] })

  await assert.rejects(state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  ), /cannot install edit_run_code; the agent scope already owns that tool name/)
  assert.deepEqual(agent.registration.calls, [])
  assert.deepEqual(agent.presentation.calls, [])
  assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
})

test('retains the code composition when edit registration broadens later assemblies', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent('scoped-edit-agent', { id: 'scoped-edit-session', events: [] })
  const first = await state.assemble({
    sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }, { agent, scope: agent })
  assert.deepEqual(first.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.deepEqual(agent.presentation.calls, ['both'])

  const second = await state.assemble({
    sections: [{ name: 'tools:code-only', text: '' }], contexts: [], variables: {},
    tools: [state.runCodeDefinition, agent.ctx.tools.get('edit_run_code'), { name: 'read' }],
  }, { agent, scope: agent })
  assert.deepEqual(second.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.equal(
    second.sections.find(section => section.name === 'tools:code-only').text,
    '`run_code` and `edit_run_code` are the only tools callable directly. Call every native tool declared by the SDK from inside a program.',
  )
  assert.deepEqual(agent.presentation.calls, ['both'])
  assert.equal(agent.presentation.disposals, 0)
  assert.equal(agent.registration.disposals, 0)
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  await state.emit('agent/disposed', { agent })
  assert.equal(agent.presentation.disposals, 1)
  assert.equal(agent.registration.disposals, 1)
  assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
})

test('keeps edit registration inside each owning PTC agent scope', async () => {
  const state = fixture()
  const native = ptcAgent('native-agent', { id: 'native-session', events: [] })
  const nativeAssembly = {
    sections: [], contexts: [], variables: {},
    tools: [{ name: 'read', description: 'Read.', parameters: { type: 'object', properties: {} } }],
  }
  assert.equal(await state.assemble(nativeAssembly, { agent: native, scope: native }), nativeAssembly)
  assert.equal(await state.assemble(nativeAssembly, { agent: native, scope: native }), nativeAssembly)
  await assert.rejects(state.assemble({
    ...nativeAssembly,
    tools: [state.runCodeDefinition, ...nativeAssembly.tools],
  }, { agent: native, scope: native }), /native agent composition assembled with run_code/)
  assert.deepEqual(native.registration.calls, [])
  assert.equal(native.ctx.tools.get('edit_run_code'), undefined)

  const mixedNative = ptcAgent('mixed-native-agent', { id: 'mixed-native-session', events: [] })
  const mixedNativeAssembly = {
    sections: [], contexts: [], variables: {},
    tools: [state.runCodeDefinition, nativeAssembly.tools[0]],
  }
  const mixedNativeResult = await state.assemble(mixedNativeAssembly, {
    agent: mixedNative, scope: mixedNative,
  })
  assert.deepEqual(mixedNativeResult.tools.map(tool => tool.name), ['run_code', 'read'])
  assert.deepEqual(mixedNative.registration.calls, [])
  assert.equal(mixedNative.ctx.tools.get('edit_run_code'), undefined)

  const first = ptcAgent('first-ptc-agent', { id: 'first-ptc-session', events: [] })
  const second = ptcAgent('second-ptc-agent', { id: 'second-ptc-session', events: [] })
  const codeAssembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  await state.assemble(codeAssembly, { agent: first, scope: first })
  await state.assemble(codeAssembly, { agent: second, scope: second })
  assert.deepEqual(first.registration.calls, ['edit_run_code'])
  assert.deepEqual(second.registration.calls, ['edit_run_code'])
  assert.equal(state.ctx.tools.get('edit_run_code'), undefined)

  await state.emit('agent/disposed', { agent: first })
  assert.equal(first.ctx.tools.get('edit_run_code'), undefined)
  assert.equal(second.ctx.tools.get('edit_run_code').name, 'edit_run_code')
  await state.dispose()
  assert.equal(second.ctx.tools.get('edit_run_code'), undefined)
  assert.equal(second.registration.disposals, 1)
  assert.equal(second.presentation.disposals, 1)
})

test('revokes edit registration on session disposal without agent disposal', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = { id: 'session-disposal-revokes-edit', events: [] }
  const agent = ptcAgent('session-disposal-edit-agent', session)
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  await state.emit('session/disposed', session)
  assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
  assert.equal(agent.registration.disposals, 1)
  assert.equal(agent.presentation.disposals, 1)

  await state.emit('agent/disposed', { agent })
  assert.equal(agent.registration.disposals, 1)
  assert.equal(agent.presentation.disposals, 1)
})

test('fails before advertising edit_run_code without the required scoped host surfaces', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const assembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  const session = { id: 'missing-edit-surfaces', events: [] }

  await assert.rejects(state.assemble(assembly, {
    agent: { id: session.id, session }, scope: {},
  }), /agent-scoped tools\.register and tools\.presentAs are required/)

  const invalidDisposer = ptcAgent('invalid-disposer', { id: 'invalid-disposer', events: [] })
  invalidDisposer.ctx.tools.presentAs = () => undefined
  await assert.rejects(state.assemble(assembly, {
    agent: invalidDisposer, scope: invalidDisposer,
  }), /tools\.presentAs did not return a disposer/)
  assert.equal(invalidDisposer.registration.disposals, 1)

  const invalidRegistration = ptcAgent('invalid-registration', { id: 'invalid-registration', events: [] })
  invalidRegistration.ctx.tools.register = () => undefined
  await assert.rejects(state.assemble(assembly, {
    agent: invalidRegistration, scope: invalidRegistration,
  }), /tools\.register did not return a disposer/)
})
