import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { Config } from '../index.js'
import { REWRITES_KEY, normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import {
  JOURNAL_POLICY,
  appendRunCodeEvents,
  fixture,
  orderedSurfaceSession,
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

function errorTreeHasMessage(error, message) {
  return error?.message === message
    || (Array.isArray(error?.errors)
      && error.errors.some(cause => errorTreeHasMessage(cause, message)))
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
  const session = orderedSurfaceSession('block-await-replay')
  const { events } = session
  const first = fixture()
  t.after(() => first.dispose())

  const setupCode = 'let blockAwaitReplayValue = 0'
  const setup = await first.runDurable(session.id, setupCode, {}, { session, recordSession: 'deferred-result', callId: 'block-await-setup' })
  appendRunCodeEvents(events, 'block-await-setup', setupCode, setup)
  const blockCode = `{
  const nextValue = await Promise.resolve(42)
  blockAwaitReplayValue = nextValue
}
// no model-side semicolon`
  const block = await first.runDurable(session.id, blockCode, {}, { session, recordSession: 'deferred-result', callId: 'block-await-cell' })
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
  const session = orderedSurfaceSession('durable-replay-disabled')
  const { events } = session
  const writer = fixture()

  const setupCode = 'let historicalBinding = 41'
  const setup = await writer.runDurable(session.id, setupCode, {}, { session, recordSession: 'deferred-result', callId: 'durable-replay-setup' })
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
  assert.match(save.error.message, /durable replay disabled by configuration/)
  assert.doesNotMatch(save.error.message, /restore a durable state first|correct the failed initializer/)
  assert.deepEqual(await state.run(session.id, 'return liveOnlyBinding', {}, { session }), { logs: [], value: 42 })
})

test('assembles a coherent byte-stable cell grammar for each selected language', async t => {
  for (const [config, current] of [[{}, true], [{ bindingUpdates: 'protected' }, true], [{ legacyBindingSettings: true }, false]]) {
    const state = fixture(config)
    t.after(() => state.dispose())
    const agent = ptcAgent(`grammar-${current}-${config.bindingUpdates}`, orderedSurfaceSession(`grammar-${current}-${config.bindingUpdates}`))
    const assemble = () => state.assemble({
      sections: [
        { name: 'tools:sdk', text: renderToolsSdk([]) },
        { name: state.sections[0].name, text: state.sections[0].text({}) },
      ], contexts: [], variables: {}, tools: [state.runCodeDefinition],
    }, { agent, scope: agent })
    const first = await assemble()
    const fullSystem = first.sections.map(section => section.text).join('\n\n')
    assert.match(fullSystem, /Return supported values directly, including undefined, NaN, infinities, -0 and BigInt/)
    assert.match(fullSystem, /Keep functions, Date, Map and other unsupported values in bindings/)
    assert.match(fullSystem, /Native `tools\.\*` arguments must satisfy their own JSON schemas/ )
    assert.equal(first.tools[0].parameters.properties.code.description,
      'Code for the next PTC TypeScript cell, following the selected language conventions.')
    assert.doesNotMatch(JSON.stringify(first.tools), /async-function body|body of an async TypeScript function/)
    if (current) {
      assert.match(fullSystem, /runtime `enum` and namespaces are supported/)
      assert.doesNotMatch(fullSystem, /erasable syntax only|no `enum` or namespaces/)
      const result = await state.executeRun(agent.session.id, 'enum Kind { Answer=42 }; namespace Answer { export const value=Kind.Answer }; return Answer.value', {}, { session: agent.session })
      assert.deepEqual(result.raw, { logs: [], value: 42 })
      assert.equal(result.result.meta.dshPtcPlus.status, 'durable')
      const imported = await state.run(agent.session.id,
        'import { basename } from "node:path"; const pathInput="C:/logs/session.jsonl"; return basename(pathInput)',
        {}, { session: agent.session })
      assert.equal(imported.error, undefined)
      assert.equal(imported.value, 'session.jsonl')
      assert.deepEqual(await state.run(agent.session.id, 'return basename(pathInput)',
        {}, { session: agent.session }), { logs: [], value: 'session.jsonl' })
      const native = await state.run(agent.session.id, 'return [eval("typeof Kind"), new Function("return typeof Kind")()]', {}, { session: agent.session })
      assert.equal(native.error, undefined)
      const nativeSyntax = await state.run(agent.session.id, 'return new Function("enum NativeKind { A=1 }")', {}, { session: agent.session })
      assert.match(nativeSyntax.error.message, /SyntaxError/)
    } else {
      assert.match(fullSystem, /erasable syntax only — no `enum` or namespaces/)
      const rejected = await state.run(agent.session.id, 'enum Kind { Answer=42 }; return Kind.Answer', {}, { session: agent.session })
      assert.match(rejected.error.message, /enum|TypeScript|SyntaxError/)
    }
    const next = await assemble()
    assert.equal(JSON.stringify(next.sections), JSON.stringify(first.sections))
    assert.equal(JSON.stringify(next.tools), JSON.stringify(first.tools))
    assert.deepEqual(first.tools.map(tool => tool.name), ['run_code'])
  }
})

test('observes retained callable data without losing special values or repeating computation', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = orderedSurfaceSession('output-observations')
  const rejected = await state.executeRun(session.id, `
let computations = 1
const out = { func: { value: () => ++computations }, missing: undefined,
  nan: NaN, pos: Infinity, neg: -Infinity, minusZero: -0, exact: 9007199254740993n }
return out
`, {}, { session })
  assert.equal(rejected.raw.error.kind, 'invalid-output')
  assert.match(rejected.raw.error.message, /\$\.func\.value.*function/)
  const selected = await state.executeRun(session.id, `
return { callable: typeof out.func.value, computations,
  missing: out.missing, nan: out.nan, pos: out.pos, neg: out.neg,
  minusZero: out.minusZero, exact: out.exact }
`, {}, { session })
  assert.equal(selected.raw.error, undefined)
  const value = decodeValue(selected.result.meta.dshPtcPlus.completion.value)
  assert.deepEqual(value, { callable: 'function', computations: 1, missing: undefined,
    nan: NaN, pos: Infinity, neg: -Infinity, minusZero: -0, exact: 9007199254740993n })
  assert.equal((await state.run(session.id, 'return out.func.value()', {}, { session })).value, 2)
  assert.equal((await state.run(session.id, 'return JSON.stringify({ exact: out.exact })',
    {}, { session })).error.kind, 'exception')
  assert.match((await state.run(session.id, 'return out.exact + 1',
    {}, { session })).error.message, /BigInt/)
  assert.equal((await state.run(session.id, 'return computations', {}, { session })).value, 2)
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
  assert.match(guidance, /Use Node\.js modules in the cell; use external processes when their environment is needed/)
  assert.match(guidance, /JSON\.stringify loses distinctions or rejects BigInt/)
  assert.match(guidance, /Do not mix BigInt with Number arithmetic/)
  assert.match(guidance, /return needed data or type observations/)
  assert.match(guidance, /earlier statements may have taken effect/)
  assert.match(guidance, /`edit_run_code` edits and reruns a complete cell/)
  assert.match(guidance, /Program API references expire when their cell ends/)
  assert.match(guidance, /async function readNow\(args\) \{ return tools\.read\(args\) \}/)
  assert.doesNotMatch(guidance, /invocation-context bridge|recovery context is required/)
  assert.doesNotMatch(guidance, /PTC-C001|state: partially-applied|do not resend the full source/)
  assert.match(guidance, /`tools\.read` is bounded inspection/)
  assert.match(guidance, /reduce them to targeted excerpts/)
  assert.match(guidance, /Use `return` for an explicit result and `console` for logs/)
  assert.match(guidance, /static import and top-level export/)
  assert.match(guidance, /A declaration publishes its bindings after its whole pattern initializes/)
  assert.match(guidance, /for unfamiliar program APIs/)
  assert.match(guidance, /`capabilities\.find\(\)`/)
  assert.match(guidance, /`capabilities\.inspect\(\)`/)
  assert.doesNotMatch(guidance, /capability namespaces|plugin-provided|materialized source|derived execution/)
  assert.doesNotMatch(guidance, /(?:^|[^.])`find\(\)`/)
  assert.doesNotMatch(guidance, /(?:^|[^.])`inspect\(\)`/)
  assert.match(guidance, /Reserve `code\.run` for isolated execution of source held as data/)
  assert.match(guidance, /instead of assuming Windows, WSL, POSIX, or a particular shell/)
  assert.doesNotMatch(guidance, /child_process|ComSpec|\.cmd|\.bat/)
  assert.match(guidance, /Declarations and assignments update the same logical binding within its scope/)
  assert.match(guidance, /Existing closures observe later updates, while saved values retain their identity/)
  assert.equal(state.sections[0].text({}), guidance)
  const protectedState = fixture({ bindingUpdates: 'protected' })
  t.after(() => protectedState.dispose())
  assert.match(protectedState.sections[0].text({}), /Redeclaration protection is enabled/)
  assert.doesNotMatch(protectedState.sections[0].text({}), /import.*unsupported/)
  assert.doesNotMatch(guidance, /orientation|inventory|PTC-N002|PTC-V001/)
  assert.match(guidance, /Direct Node\/OS access remains live but is not replayed after a kernel restart/)
  const functionClassStrict = fixture({ looseTopLevelFunctionClassRedeclarations: false })
  t.after(() => functionClassStrict.dispose())
  const strictFunctionClassGuidance = functionClassStrict.sections[0].text({})
  assert.match(strictFunctionClassGuidance, /Repeated top-level `function`\/`class` declarations remain unsupported/)
  assert.match(strictFunctionClassGuidance, /assign a function or class expression to an existing writable binding/)
  assert.match(strictFunctionClassGuidance, /place one-off declarations inside a block/)
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
    /failing operation may have caused effects/,
  )
  assert.match(
    failed.result.meta.dshPtcPlus.diagnostics[0].help.join('\n'),
    /owner's retry\/idempotence contract/,
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
    'Code for the next PTC TypeScript cell, following the selected language conventions.')
  assert.equal(adapted.tools[1].parameters.properties.description.description,
    'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).')
  assert.deepEqual(adapted.tools[1].annotation, { retained: true })
  assert.equal(adapted.tools[1].parameters.additionalProperties, false)
  assert.equal(adapted.tools[1].parameters.comment, 'retained')
  assert.deepEqual(adapted.tools[1].parameters.required, ['code', 'description'])
  assert.equal(adapted.tools[1].parameters.properties.code.minLength, 0)
  assert.equal(adapted.tools[1].parameters.properties.description.maxLength, 80)
})

test('registers the nested editor while keeping model-authored root calls visible', async (t) => {
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
  assert.match(definition.description, /captured at nested dispatch/)
  assert.match(definition.description, /returns \{ accepted, scheduled, target_call_seq \}/)
  assert.match(definition.description, /after the current run_code cell releases its worker/)
  assert.match(definition.description, /reruns the entire target cell, including prior effects/)
  assert.match(definition.description, /safe under the called API's retry rules/)
  assert.deepEqual(agent.registration.calls, ['edit_run_code'])

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'edit-1', name: 'edit_run_code', argumentsDelta: '{"edits":[]}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'edit-1', name: 'edit_run_code', arguments: '{"edits":[]}' } },
    { type: 'finish', finishReason: 'tool-calls' },
  ]
  assert.deepEqual(await state.stream({ tools: [state.runCodeDefinition, definition] }, chunks), chunks)
})

test('retains edit_run_code in the program SDK with only run_code directly callable', async (t) => {
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
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code'])
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk').text
  assert.match(sdk, /edit_run_code: \{ edits: unknown\[\] \}/)
  assert.match(sdk, /read: \{ file_path: string \}/)
  assert.match(sdk, /case-insensitive symbols or contiguous words/)
  assert.match(sdk, /`tree\(\)` lists namespaces and members/)
  assert.match(sdk, /`namespace\.member` symbols/)
  assert.doesNotMatch(sdk, /declare const (repl|code):/)
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
  assert.match(first.sections[0].text, /edit_run_code: \{ edits: unknown\[\] \}/)
  assert.equal(first.contexts.some(context => /edit/i.test(context?.name ?? '')), false)

  await state.emit('agent/disposed', { agent })
  const resumedState = fixture()
  t.after(() => resumedState.dispose())
  const resumedAgent = ptcAgent('stable-edit-registration-resumed-agent', session)
  const resumed = await assembleEpoch(resumedState, resumedAgent)
  assert.equal(stableView(resumed), stableView(first))
})

test('registers the editor when the owning agent is created before its first SDK assembly', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent('created-edit-registration', { id: 'created-edit-registration', events: [] })
  await state.emit('agent/created', { agent })
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')
  await state.assemble(
    {
      sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
      contexts: [], variables: {}, tools: [state.runCodeDefinition],
    },
    { agent, scope: agent },
  )
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')
})

test('registers the editor for an existing PTC agent before its first plugin SDK assembly', async t => {
  const agent = ptcAgent('existing-ptc-agent', { id: 'existing-ptc-agent', events: [] })
  agent.ctx.tools.bindFixtureRegistry(
    name => name === 'run_code' ? { name: 'run_code', output: { schema: {}, render: () => [] } } : undefined,
    () => [{ name: 'run_code' }],
  )
  const state = fixture({}, { agents: { list: () => [agent] } })
  t.after(() => state.dispose())
  const editor = agent.ctx.tools.get('edit_run_code')
  assert.equal(editor?.name, 'edit_run_code')
  const sdk = renderToolsSdk([{ name: editor.name, description: editor.description,
    parameters: editor.parameters, output: editor.output.schema }])
  const first = await state.assemble({
    sections: [{ name: 'tools:sdk', text: sdk }],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }, { agent, scope: agent })
  assert.deepEqual(first.tools.map(tool => tool.name), ['run_code'])
  const firstSdk = first.sections.find(section => section.name === 'tools:sdk').text
  assert.match(firstSdk, /edit_run_code: \{/)
  for (const field of ['old_string', 'new_string', 'accepted', 'scheduled']) {
    assert.match(firstSdk, new RegExp(field))
  }
  assert.equal(state.ctx.tools.get('edit_run_code'), undefined)
})

test('captures a code composition first supplied by downstream prompt assembly', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent('late-composition', { id: 'late-composition', events: [] })
  const initial = { sections: [], contexts: [], variables: {}, tools: [] }
  assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
  const assembled = await state.assemble(initial, { agent, scope: agent }, async () => ({
    ...initial, sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
    tools: [state.runCodeDefinition],
  }))
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['run_code'])
})

test('reclassifies an empty session after preset recomposition', async (t) => {
  let agent
  const state = fixture({}, {
    agents: { get: id => id === agent?.session.id ? agent : undefined },
  })
  t.after(() => state.dispose())
  agent = ptcAgent('recomposed-agent', { id: 'recomposed-session', events: [] })
  const ptcAssembly = {
    sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  await state.assemble(ptcAssembly, { agent, scope: agent })
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  await state.emit('agent-preset/selected', agent.session.id)
  assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
  const nativeAssembly = {
    sections: [], contexts: [], variables: {},
    tools: [{ name: 'read', description: 'Read.', parameters: { type: 'object', properties: {} } }],
  }
  assert.deepEqual(
    await state.assemble(nativeAssembly, { agent, scope: agent }),
    nativeAssembly,
  )

  await state.emit('agent-preset/selected', agent.session.id)
  const recomposed = await state.assemble(ptcAssembly, { agent, scope: agent })
  assert.deepEqual(recomposed.tools.map(tool => tool.name), ['run_code'])
})

test('fails closed when a native edit_run_code name already occupies the agent scope', async (t) => {
  const nativeEdit = {
    name: 'edit_run_code',
    description: 'Host-owned edit tool.',
    parameters: { type: 'object', properties: {} },
  }
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent('native-edit-collision', { id: 'native-edit-collision', events: [] })
  const releaseNative = agent.ctx.tools.register(nativeEdit)
  t.after(releaseNative)
  const nativeRegistrations = [...agent.registration.calls]

  await assert.rejects(state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  ), /cannot install edit_run_code; the agent scope already owns that tool name/)
  assert.deepEqual(agent.registration.calls, nativeRegistrations)
  assert.deepEqual(agent.presentation.calls, [])
  assert.equal(agent.ctx.tools.get('edit_run_code'), nativeEdit)
  assert.equal(agent.registration.disposals, 0)
})

test('retains the run_code direct surface when later assemblies include the scoped editor', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent('scoped-edit-agent', { id: 'scoped-edit-session', events: [] })
  const first = await state.assemble({
    sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }, { agent, scope: agent })
  assert.deepEqual(first.tools.map(tool => tool.name), ['run_code'])
  assert.deepEqual(agent.presentation.calls, [])

  const second = await state.assemble({
    sections: [{ name: 'tools:code-only', text: '' }], contexts: [], variables: {},
    tools: [state.runCodeDefinition, agent.ctx.tools.get('edit_run_code'), { name: 'read' }],
  }, { agent, scope: agent })
  assert.deepEqual(second.tools.map(tool => tool.name), ['run_code'])
  assert.equal(
    second.sections.find(section => section.name === 'tools:code-only').text,
    '`run_code` is the only tool callable directly. Call `tools.edit_run_code` and other SDK tools from inside a program. An accepted edit runs after the current cell finishes.',
  )
  assert.deepEqual(agent.presentation.calls, [])
  assert.equal(agent.presentation.disposals, 0)
  assert.equal(agent.registration.disposals, 0)
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  await state.emit('agent/disposed', { agent })
  assert.equal(agent.presentation.disposals, 0)
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
  assert.deepEqual(await state.assemble(nativeAssembly, { agent: native, scope: native }), nativeAssembly)
  assert.deepEqual(await state.assemble(nativeAssembly, { agent: native, scope: native }), nativeAssembly)
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
  assert.deepEqual(mixedNativeResult.tools.map(tool => tool.name), ['run_code'])
  assert.deepEqual(mixedNative.registration.calls, ['edit_run_code'])
  assert.equal(mixedNative.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

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
  assert.equal(second.presentation.disposals, 0)
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
  assert.equal(agent.presentation.disposals, 0)

  await state.emit('agent/disposed', { agent })
  assert.equal(agent.registration.disposals, 1)
  assert.equal(agent.presentation.disposals, 0)
})

test('retries a failed scoped editor registration cleanup', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = { id: 'edit-registration-cleanup-fault', events: [] }
  const agent = ptcAgent('edit-registration-cleanup-agent', session)
  const register = agent.ctx.tools.register
  let failRegistration = true
  agent.ctx.tools.register = definition => {
    const dispose = register(definition)
    return () => {
      if (failRegistration) throw new Error('registration cleanup fault')
      return dispose()
    }
  }
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )

  await assert.rejects(
    state.emit('session/disposed', session),
    error => error instanceof AggregateError
      && error.message === 'ptc-plus: session disposal failed'
      && errorTreeHasMessage(error, 'registration cleanup fault'),
  )
  assert.equal(agent.presentation.disposals, 0)
  assert.equal(agent.registration.disposals, 0)
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  await assert.rejects(state.emit('agent/disposed', { agent }), /agent disposal failed/)
  assert.equal(agent.registration.disposals, 0)

  failRegistration = false
  await state.emit('session/disposed', session)
  assert.equal(agent.presentation.disposals, 0)
  assert.equal(agent.registration.disposals, 1)
  assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
})

test('fails before advertising edit_run_code without the required scoped host surfaces', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const assembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  const session = { id: 'missing-edit-surfaces', events: [] }

  await assert.rejects(state.assemble(assembly, {
    agent: { id: session.id, session }, scope: {},
  }), /agent-scoped tools\.register is required/)

  const invalidRegistration = ptcAgent('invalid-registration', { id: 'invalid-registration', events: [] })
  invalidRegistration.ctx.tools.register = () => undefined
  await assert.rejects(state.assemble(assembly, {
    agent: invalidRegistration, scope: invalidRegistration,
  }), /tools\.register did not return a disposer/)
})

test('reports scoped editor cleanup failure on plugin disposal', async () => {
  const state = fixture()
  const agent = ptcAgent('plugin-edit-cleanup-fault', {
    id: 'plugin-edit-cleanup-fault', events: [],
  })
  const register = agent.ctx.tools.register
  agent.ctx.tools.register = definition => {
    const dispose = register(definition)
    return () => {
      dispose()
      throw new Error('plugin registration cleanup fault')
    }
  }
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent },
  )

  await assert.rejects(
    state.dispose(),
    error => errorTreeHasMessage(error, 'plugin registration cleanup fault'),
  )
  assert.equal(agent.registration.disposals, 1)
  assert.equal(agent.presentation.disposals, 0)
})
