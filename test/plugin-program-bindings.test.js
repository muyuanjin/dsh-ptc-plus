import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { Config } from '../index.js'
import { createRuntimeBridgeOwner } from '../internal/runtime-bridge-owner.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import { JOURNAL_POLICY, appendRunCodeEvents, fixture, ptcAgent } from './plugin-fixture.js'

test('keeps successful rewrites out of the prompt projection', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const stableContexts = [
    { name: 'sandbox:policy', text: 'stable sandbox policy' },
    { name: 'approval:policy', text: 'stable approval policy' },
  ]
  const codeOnlyAssembly = {
    sections: [
      { name: 'tools:code-only', text: '`run_code` is the only tool you can call directly.' },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: stableContexts, variables: {}, tools: [state.runCodeDefinition],
  }
  const session = { id: 'rewrite-feedback-session', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent(`${session.id}-agent`, session)
  const requestContext = { agent, scope: agent, signal: new AbortController().signal }
  const renderHeader = async (target, assembly, context) => {
    const adapted = await target.assemble(assembly, context)
    const plugin = target.sections.find(section => section.name === 'tools:ptc-plus-repl')
    const scope = context.scope ?? context.agent
    const sections = [
      ...adapted.sections.map(section => ({
        name: section.name,
        order: section.order,
        text: typeof section.text === 'function' ? section.text({ scope }) : section.text,
      })),
      { name: plugin.name, order: plugin.order, text: plugin.text({ scope }) },
    ]
    return JSON.stringify({ sections, tools: adapted.tools })
  }
  const headerOf = (assembly = codeOnlyAssembly, contextOverride = {}) =>
    renderHeader(state, assembly, { ...requestContext, ...contextOverride })
  const runtimeContexts = async () => {
    const assembly = await state.assemble(codeOnlyAssembly, { ...requestContext, signal: new AbortController().signal })
    return assembly.contexts
  }

  const baseline = await headerOf()
  const firstCode = "import { basename } from 'node:path'\nreturn basename('/a/b')"
  const first = await state.runDurable(session.id, firstCode, {}, { session })
  assert.match(first.meta.dshPtcPlusRewrites[0].description, /adapted the static import of "node:path"/)
  appendRunCodeEvents(session.events, 'rewrite-first', firstCode, first)
  assert.equal(await runtimeContexts(), stableContexts)
  assert.equal(await headerOf(), baseline)

  const secondCode = "import { fileURLToPath } from 'node:url'\nreturn typeof fileURLToPath"
  const second = await state.runDurable(session.id, secondCode, {}, { session })
  assert.match(second.meta.dshPtcPlusRewrites[0].description, /adapted the static import of "node:url"/)
  appendRunCodeEvents(session.events, 'rewrite-second', secondCode, second)
  assert.equal(await runtimeContexts(), stableContexts)
  assert.equal(await headerOf(), baseline)

  const later = await state.runDurable(session.id, 'return 1', {}, { session })
  appendRunCodeEvents(session.events, 'rewrite-later', 'return 1', later)
  assert.equal(await runtimeContexts(), stableContexts)
  assert.equal(await headerOf(), baseline)
  session.events.push({ type: 'turn/end' })
  assert.equal(await runtimeContexts(), stableContexts)
  assert.equal(await headerOf(), baseline)
})

test('fails closed when rewrite metadata is malformed', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const valid = await state.runDurable('malformed-rewrite-source', 'return 1')
  const events = [
    { type: 'turn/start' },
    {
      type: 'tool/call', data: {
        callId: 'bad-rewrite', name: 'run_code',
        arguments: JSON.stringify({ code: 'return 1', description: 'bad' }),
      },
    },
    {
      type: 'tool/result', data: {
        message: { source: { callId: 'bad-rewrite' } },
        meta: { ...valid.meta, dshPtcPlusRewrites: [{ bad: true }] },
      },
    },
  ]
  const assembly = await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    {
      agent: ptcAgent('malformed-rewrite-agent', { id: 'malformed-rewrite-session', events }),
      scope: {},
      signal: new AbortController().signal,
    },
  )
  assert.equal(assembly.contexts.some(item => item?.name === 'tools:ptc-plus-rewrite-info'), false)
})

test('keeps rewritten completion unknown without a valid journal', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable(
    'unknown-rewrite-source', 'export const unknownValue = 1\nreturn unknownValue',
  )
  assert.ok(result.meta.dshPtcPlusRewrites?.length > 0)

  for (const [label, journal] of [['missing', undefined], ['malformed', {}]]) {
    const meta = structuredClone(result.meta)
    if (journal === undefined) delete meta.dshPtcPlus
    else meta.dshPtcPlus = journal
    const callId = `${label}-rewrite-journal`
    const events = [
      { type: 'turn/start' },
      {
        type: 'tool/call', data: {
          callId, name: 'run_code',
          arguments: JSON.stringify({ code: 'export const unknownValue = 1', description: label }),
        },
      },
      {
        type: 'tool/result', data: {
          message: { source: { callId } }, meta,
        },
      },
    ]
    const agent = ptcAgent(`${label}-rewrite-agent`, { id: `${label}-rewrite-session`, events })
    const assembly = await state.assemble(
      { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
      { agent, scope: agent, signal: new AbortController().signal },
    )
    const context = assembly.contexts.find(item => item?.name === 'tools:ptc-plus-rewrite-info')
    assert.ok(context)
    assert.match(context.text, /source adjustments: stripped the export modifier/)
    assert.match(context.text, /completion is unknown because no valid execution journal is available/)
    assert.match(context.text, /do not assume it completed or failed/)
    assert.doesNotMatch(context.text, /completed after|failed after/)
  }
})

test('keeps rewrite continuation truthful after a throwing cell', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = { id: 'rewrite-failure-context', events: [{ type: 'turn/start' }] }
  const agent = ptcAgent('rewrite-failure-context-agent', session)
  const code = 'export const failedValue = 1\nthrow new Error("boom")'
  const result = await state.runDurable(session.id, code, {}, { session })
  assert.equal(result.isError, true)
  assert.ok(result.meta.dshPtcPlusRewrites?.length > 0)
  appendRunCodeEvents(session.events, 'rewrite-failure', code, result)

  const assembly = await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: new AbortController().signal },
  )
  const context = assembly.contexts.find(item => item?.name === 'tools:ptc-plus-rewrite-info')
  assert.ok(context)
  assert.match(context.text, /failed after a source adjustment/)
  assert.match(context.text, /stripped the export modifier/)
  assert.doesNotMatch(context.text, /completed in this session/)
})

test('rebinds native tools for old functions and expires captured closures', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  await state.run('session-a', `
async function currentValue() { return tools.value({}) }
const staleValue = tools.value
`, { value: async () => 1 })

  assert.deepEqual(
    await state.run('session-a', 'return currentValue()', { value: async () => 2 }),
    { logs: [], value: 2 },
  )
  assert.deepEqual(
    await state.run('session-a', 'return currentValue()', { value: async () => 3 }),
    { logs: [], value: 3 },
  )

  const expired = await state.run('session-a', `
let expiredMessage
try { await staleValue({}) } catch (error) { expiredMessage = error.message }
return expiredMessage
`, { value: async () => 4 })
  assert.deepEqual(expired, { logs: [], value: 'PTC execution lease expired' })
})

test('exposes native tools without adapting arguments or canonical results', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const calls = []
  const functions = {
    async read(args) {
      calls.push(['read', args])
      return { path: args.file_path, offset: args.offset ?? 1, lines: [{ number: 2, text: 'line' }], totalLines: 3 }
    },
    async echo(args) {
      calls.push(['echo', args])
      return args
    },
  }
  const observed = await state.executeRun('native-tools', `
const page = await tools.read({ file_path: 'src/raw.ts', limit: 1 })
const echoed = await tools.echo({ value: 7 })
return { page, echoed, toolsType: typeof tools, workspaceType: typeof workspace, hostType: typeof host }
`, functions, {})
  assert.deepEqual(observed.raw, {
    logs: [],
    value: {
      page: { path: 'src/raw.ts', offset: 1, lines: [{ number: 2, text: 'line' }], totalLines: 3 },
      echoed: { value: 7 },
      toolsType: 'object',
      workspaceType: 'undefined',
      hostType: 'undefined',
    },
  })
  assert.deepEqual(calls, [
    ['read', { file_path: 'src/raw.ts', limit: 1 }],
    ['echo', { value: 7 }],
  ])
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['tools', 'read'],
    ['tools', 'echo'],
  ])
})

test('canonicalizes omitted native arguments only when the live schema accepts an empty object', async (t) => {
  const schemas = [
    {
      name: 'zero',
      parameters: {
        type: 'object',
        properties: { detail: { type: 'boolean' } },
        additionalProperties: false,
      },
    },
    {
      name: 'required',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'unsupported',
      parameters: { type: 'object', minProperties: 1 },
    },
  ]
  const events = []
  const session = { id: 'empty-native-arguments', events }
  const first = fixture({}, { schemas })
  t.after(() => first.dispose())
  const calls = []
  const source = `
const implicitEmptyResult = await tools.zero()
const explicitEmptyResult = await tools.zero({})
`
  const recorded = await first.runDurable(session.id, source, {
    zero: async args => { calls.push(args); return Object.keys(args).length },
  }, { session })

  assert.equal(recorded.isError, false)
  assert.deepEqual(calls, [{}, {}])
  assert.deepEqual(recorded.meta.dshPtcPlus.calls.map(call => decodeValue(call.args)), [{}, {}])
  appendRunCodeEvents(events, 'empty-native-arguments-call', source, recorded)

  const rejectUndefined = async args => {
    assert.equal(args, undefined)
    throw new TypeError('tool arguments must be lossless JSON')
  }
  for (const [label, program, functions, bindings = []] of [
    ['explicit undefined', 'return tools.zero(undefined)', { zero: rejectUndefined }],
    ['required input', 'return tools.required()', { required: rejectUndefined }],
    ['unsupported schema', 'return tools.unsupported()', { unsupported: rejectUndefined }],
    ['owner namespace', 'return domain.zero()', {}, [{ global: 'domain', functions: { zero: rejectUndefined } }]],
  ]) {
    const result = await first.run(`empty-native-arguments-${label}`, program, functions, { bindings })
    assert.equal(result.error?.kind, 'exception')
    assert.match(result.error.message, /tool arguments must be lossless JSON/)
  }
  const untrustedMetadata = await first.run(
    'empty-native-arguments-untrusted-metadata',
    'return tools.required()',
    { required: rejectUndefined },
    { toolEmptyObjectMembers: ['required'] },
  )
  assert.match(untrustedMetadata.error.message, /tool arguments must be lossless JSON/)
  await first.dispose()

  const restored = fixture({}, { schemas })
  t.after(() => restored.dispose())
  let replayDispatches = 0
  const replay = await restored.run(session.id, 'return { implicitEmptyResult, explicitEmptyResult }', {
    zero: async () => { replayDispatches += 1; return -1 },
  }, { session })
  assert.deepEqual(replay, {
    logs: [],
    value: { implicitEmptyResult: 0, explicitEmptyResult: 0 },
  })
  assert.equal(replayDispatches, 0)
})

test('preserves the native canonical tool result without projection validation', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const extended = await state.executeRun('read-result-contract', `return tools.read({ file_path: 'src/a.ts' })`, {
    read: async args => ({
      path: args.file_path,
      offset: 1,
      lines: [{ number: 1, text: 'line' }],
      totalLines: 1,
      nativePresentationHint: 'ts',
    }),
  }, {})
  assert.deepEqual(extended.raw.value, {
    path: 'src/a.ts',
    offset: 1,
    lines: [{ number: 1, text: 'line' }],
    totalLines: 1,
    nativePresentationHint: 'ts',
  })
})

test('preserves owner-provided program namespaces without domain translation', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const binding = {
    global: 'domain',
    functions: {
      inspect: async value => ({ received: value }),
    },
    errorClass: { name: 'DomainError', memberNameProperty: 'operation' },
  }
  const observed = await state.executeRun(
    'owner-binding',
    'const staleDomainInspect = domain.inspect; return domain.inspect({ exact: true })',
    {},
    { bindings: [binding] },
  )
  assert.deepEqual(observed.raw.value, { received: { exact: true } })
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['domain', 'inspect'],
  ])
  const expired = await state.executeRun(
    'owner-binding',
    'try { return await staleDomainInspect({ expired: true }) } catch (error) { return error.message }',
    {},
    { bindings: [binding] },
  )
  assert.equal(expired.raw.value, 'PTC execution lease expired')
})

test('rejects owner bindings that collide with plugin program namespaces', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  for (const global of ['capabilities', 'code', 'repl']) {
    await assert.rejects(
      () => state.executeRun('reserved-owner-binding', 'return 1', {}, {
        bindings: [{ global, functions: { owner: async () => 1 } }],
      }),
      new RegExp(`reserved program namespace "${global}"`),
    )
  }
})

test('cold-replays an owner-provided program binding from its recorded value', async (t) => {
  const events = []
  const session = { id: 'owner-binding-replay', events }
  const first = fixture()
  t.after(() => first.dispose())
  let liveCalls = 0
  const source = 'const ownerReplayValue = await domain.read({ key: "answer" })'
  const recorded = await first.runDurable(session.id, source, {}, {
    session,
    bindings: [{
      global: 'domain',
      functions: { read: async () => { liveCalls += 1; return 42 } },
    }],
  })
  assert.equal(liveCalls, 1)
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'owner-binding-call', source, recorded)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let replayDispatches = 0
  const result = await restored.run(session.id, 'return ownerReplayValue', {}, {
    session,
    bindings: [{
      global: 'domain',
      functions: { read: async () => { replayDispatches += 1; return -1 } },
    }],
  })
  assert.deepEqual(result, { logs: [], value: 42 })
  assert.equal(replayDispatches, 0)
})

test('preserves rich owner binding values through journal JSON and cold replay', async (t) => {
  const events = []
  const session = { id: 'owner-rich-binding-replay', events }
  const first = fixture()
  t.after(() => first.dispose())
  let liveCalls = 0
  const source = `
const ownerRichShared = { marker: undefined }
const ownerRichSparse = [, ownerRichShared]
const ownerRichInput = {
  shared: ownerRichShared,
  alias: ownerRichShared,
  sparse: ownerRichSparse,
  big: 42n,
  negativeZero: -0,
}
Object.defineProperty(ownerRichInput, '__proto__', {
  enumerable: true,
  configurable: true,
  writable: true,
  value: { safe: true },
})
ownerRichInput.self = ownerRichInput
const ownerRichValue = await domain.transform(ownerRichInput)
`
  const transform = async (value) => {
    liveCalls += 1
    assert.equal(value.shared, value.alias)
    assert.equal(value.self, value)
    assert.equal(0 in value.sparse, false)
    assert.equal(value.sparse[1], value.shared)
    assert.equal(value.shared.marker, undefined)
    assert.equal(value.big, 42n)
    assert.equal(Object.is(value.negativeZero, -0), true)
    assert.deepEqual(Object.getOwnPropertyDescriptor(value, '__proto__')?.value, { safe: true })
    const result = { echoed: value, alias: value.shared, missing: undefined, sparse: [, value] }
    result.self = result
    return result
  }
  const recorded = await first.runDurable(session.id, source, {}, {
    session,
    bindings: [{ global: 'domain', functions: { transform } }],
  })
  assert.equal(liveCalls, 1)
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')
  assert.equal(recorded.meta.dshPtcPlus.calls[0].args.codec, 'ptc-value-graph/v1')
  assert.equal(recorded.meta.dshPtcPlus.calls[0].value.codec, 'ptc-value-graph/v1')
  appendRunCodeEvents(events, 'owner-rich-binding-call', source, JSON.parse(JSON.stringify(recorded)))
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let replayDispatches = 0
  const result = await restored.run(session.id, `return {
    inputAlias: ownerRichValue.echoed.shared === ownerRichValue.echoed.alias,
    inputCycle: ownerRichValue.echoed.self === ownerRichValue.echoed,
    resultAlias: ownerRichValue.echoed.shared === ownerRichValue.alias,
    resultCycle: ownerRichValue.self === ownerRichValue,
    inputHole: !(0 in ownerRichValue.echoed.sparse),
    resultHole: !(0 in ownerRichValue.sparse),
    sparseAlias: ownerRichValue.sparse[1] === ownerRichValue.echoed,
    explicitUndefined: ownerRichValue.missing === undefined,
    bigint: ownerRichValue.echoed.big === 42n,
    negativeZero: Object.is(ownerRichValue.echoed.negativeZero, -0),
    ownProto: Object.hasOwn(ownerRichValue.echoed, '__proto__')
      && ownerRichValue.echoed.__proto__.safe === true,
  }`, {}, {
    session,
    bindings: [{
      global: 'domain',
      functions: { transform: async () => { replayDispatches += 1; return null } },
    }],
  })
  assert.deepEqual(result, {
    logs: [],
    value: {
      inputAlias: true,
      inputCycle: true,
      resultAlias: true,
      resultCycle: true,
      inputHole: true,
      resultHole: true,
      sparseAlias: true,
      explicitUndefined: true,
      bigint: true,
      negativeZero: true,
      ownProto: true,
    },
  })
  assert.equal(replayDispatches, 0)
})

test('injects code.run and routes it to the isolated upstream runtime', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const discovery = await state.run('capability-discovery-contract', `
const tree = await capabilities.tree()
const found = await capabilities.find('code')
return { tree, found }
`)
  assert.equal(discovery.error, undefined)
  assert.equal(discovery.value.tree.some(entry => entry.namespace === 'code'), true)
  assert.equal(discovery.value.found.some(entry => entry.symbol === 'code.run'), true)
  for (const [program, message] of [
    ['return capabilities.tree(1)', /does not accept arguments/],
    ['return capabilities.find(null)', /expects a query string/],
    ['return capabilities.inspect(null)', /expects an object/],
  ]) {
    const invalid = await state.run(`capability-invalid-${program.length}`, program)
    assert.equal(invalid.error.kind, 'exception')
    assert.match(invalid.error.message, message)
  }
  const description = await state.run('code-run-description', `
const inspected = await capabilities.inspect({ symbols: ['code.run'] })
return inspected.symbols[0].description
`)
  assert.match(description.value, /top-level code\.run binding/)
  assert.match(description.value, /do not use tools\.code\.run/)
  const childCode = 'const childOnly = 1; return childOnly'
  const functions = { read: async () => 'visible' }

  const observed = await state.executeRun('recursive-isolation', `
const parentOnly = 41
const nestedOutcome = await code.run({
  code: ${JSON.stringify(childCode)},
  description: 'Execute isolated child code',
})
return { parentOnly, nestedOutcome }
`, functions, {})

  assert.deepEqual(observed.raw.value, {
    parentOnly: 41,
    nestedOutcome: { logs: ['upstream'], result: 'upstream' },
  })
  assert.deepEqual(observed.raw.logs, [])
  assert.equal(state.upstreamCalls.length, 1)
  assert.equal(state.upstreamCalls[0].program, childCode)
  assert.equal(state.upstreamCalls[0].signal instanceof AbortSignal, true)
  const childTools = state.upstreamCalls[0].bindings.find(binding => binding.global === 'tools')
  assert.equal(typeof childTools.functions.read, 'function')
  const childCodeBinding = state.upstreamCalls[0].bindings.find(binding => binding.global === 'code')
  assert.equal(typeof childCodeBinding.functions.run, 'function')
  assert.equal(Object.hasOwn(functions, 'run_code'), false)
  assert.equal(observed.result.meta.dshPtcPlus.status, 'durable')
  assert.equal(observed.result.meta.dshPtcPlus.volatileReason, undefined)
  assert.deepEqual(observed.result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [
    ['code', 'run'],
  ])
  assert.deepEqual(await state.run('recursive-isolation', `
return { parentOnly, childOnly: typeof childOnly }
`), { logs: [], value: { parentOnly: 41, childOnly: 'undefined' } })
})

test('preserves an existing native run_code binding', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const hostRunCode = async args => {
    const result = await state.dispatchNestedRun('host-recursion', args)
    if (result.isError) throw new Error(result.error.message)
    return result.value
  }

  const result = await state.run('host-recursion', `
return code.run({ code: 'return 1', description: 'Use host recursion' })
  `, { run_code: hostRunCode })
  assert.deepEqual(result.value, { logs: ['upstream'], result: 'upstream' })
  assert.deepEqual(result.logs, [])
  assert.equal(state.upstreamCalls.length, 1)
})

test('supports bounded recursive run_code and leaves the parent usable after overflow', async (t) => {
  const state = fixture({ maxNestedRunCodeDepth: 2 }, {
    async upstreamRun(request) {
      const remaining = Number(request.program)
      if (remaining === 0) return { logs: ['leaf'], value: 0 }
      const runCode = request.bindings.find(binding => binding.global === 'code').functions.run
      try {
        const result = await runCode({
          code: String(remaining - 1),
          description: 'Continue recursive evaluation',
        })
        return { logs: [], value: result }
      } catch (error) {
        return { logs: [], error: { kind: 'exception', message: error.message } }
      }
    },
  })
  t.after(() => state.dispose())

  const bounded = await state.run('recursive-depth-ok', `
return code.run({ code: '1', description: 'Evaluate two child levels' })
  `)
  assert.deepEqual(bounded.value, { logs: [], result: { logs: ['leaf'], result: 0 } })
  assert.deepEqual(bounded.logs, [])

  const overflow = await state.run('recursive-depth-overflow', `
return code.run({ code: '2', description: 'Exceed child depth limit' })
`)
  assert.equal(overflow.error.kind, 'exception')
  assert.match(overflow.error.message, /recursion depth exceeds configured maximum 2/)
  assert.deepEqual(await state.run('recursive-depth-overflow', 'return 42'), { logs: [], value: 42 })
})

test('binds nested code.run depth to the submitted cell generation', async (t) => {
  let releaseGate
  let gateStarted
  const gate = new Promise(resolve => { releaseGate = resolve })
  const started = new Promise(resolve => { gateStarted = resolve })
  const definition = { name: 'run_code', output: {} }
  const runtime = {
    language: 'typescript',
    isolation: 'worker-thread',
    async run(request) {
      const remaining = Number(request.program)
      if (remaining === 0) return { logs: ['leaf'], value: 0 }
      const runCode = request.bindings.find(binding => binding.global === 'code').functions.run
      try {
        return {
          logs: [],
          value: await runCode({
            code: String(remaining - 1),
            description: 'Continue recursive evaluation',
          }),
        }
      } catch (error) {
        return { logs: [], error: { kind: 'exception', message: error.message } }
      }
    },
  }
  const owner = createRuntimeBridgeOwner({
    ctx: {
      codeRuntime: runtime,
      tools: { get: () => definition },
    },
    sessionConfig: {
      computeMs: 1_000,
      maxWallMs: 1_000,
      maxNestedRunCodeDepth: 2,
    },
    maxNestedRunCodeDepth: 2,
    presentationGeneration: 'nested-config-test-generation',
    sessionId: agent => agent.id,
    toolSchemasForAgent: () => [],
  })
  t.after(() => owner.dispose())
  const agent = { id: 'nested-config-generation', session: { id: 'nested-config-generation', events: [] } }

  const execute = async (callId, program, bindings = []) => {
    const exec = { name: 'run_code', callId, agent }
    let raw
    const result = await owner.handleExecute(exec, async () => {
      raw = await runtime.run({ program, bindings })
      const meta = definition.output.presentationMeta?.({}, raw.value)
      return raw.error === undefined
        ? { isError: false, value: raw.value, content: [], meta }
        : { isError: true, content: [], error: { message: raw.error.message }, meta }
    })
    owner.handleResult(exec, result)
    return raw
  }

  const active = execute('nested-generation-active', `
await tools.wait({})
return code.run({ code: '1', description: 'Use submitted depth limit' })
`, [{ global: 'tools', functions: { wait: async () => { gateStarted(); await gate } } }])
  await started
  owner.reconfigure({
    computeMs: 1_000,
    maxWallMs: 1_000,
    maxNestedRunCodeDepth: 1,
  })
  releaseGate()

  assert.deepEqual((await active).value, {
    logs: [],
    result: { logs: ['leaf'], result: 0 },
  })
  const next = await execute('nested-generation-next', `
return code.run({ code: '1', description: 'Use next depth limit' })
`)
  assert.equal(next.error.kind, 'exception')
  assert.match(next.error.message, /recursion depth exceeds configured maximum 1/)
})

test('validates nested run_code arguments as a closed object', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('recursive-arguments', `
let message
try {
  await code.run({ code: 'return 1', description: 'Reject extra input', extra: true })
} catch (error) {
  message = error.message
}
return message
`)
  assert.match(result.value, /expects exactly code and description string properties/)
  assert.equal(state.upstreamCalls.length, 0)
})

test('turns child runtime failure into a normal binding error and keeps the parent usable', async (t) => {
  const controller = new AbortController()
  const state = fixture({}, {
    async upstreamRun(request) {
      assert.equal(request.signal, controller.signal)
      return { logs: ['child log'], error: { kind: 'timeout', message: 'child budget exhausted' } }
    },
  })
  t.after(() => state.dispose())

  const result = await state.run('recursive-child-failure', `
let childFailure
try {
  await code.run({ code: 'for (;;) {}', description: 'Reach child timeout' })
} catch (error) {
  childFailure = { name: error.name, operation: error.operation, message: error.message }
}
return childFailure
`, {}, { controller })
  assert.deepEqual(result.value, {
    name: 'CodeExecutionError',
    operation: 'run',
    message: 'nested run_code failed (timeout): child budget exhausted',
  })
  assert.deepEqual(result.logs, [])
  assert.deepEqual(await state.run('recursive-child-failure', 'return 42'), { logs: [], value: 42 })
})

test('preserves the external-effect boundary when code.run is cancelled', async (t) => {
  let childStarted
  const started = new Promise(resolve => { childStarted = resolve })
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 }, {
    async upstreamRun() {
      childStarted()
      return new Promise(() => {})
    },
  })
  t.after(() => state.dispose())
  const controller = new AbortController()
  const pending = state.runDurable('recursive-cancel', `
return code.run({ code: 'await new Promise(() => {})', description: 'Wait in child' })
`, {}, { controller })
  await started
  controller.abort('cancel child')
  const cancelled = await pending
  assert.equal(cancelled.meta.dshPtcPlus.status, 'discarded')
  assert.equal(cancelled.meta.dshPtcPlus.volatileReason, 'code.run')

  const continued = await state.run('recursive-cancel', 'return repl.state({ action: "list" })')
  assert.equal(continued.value.mode, 'volatile')
  assert.equal(continued.value.volatileReason, 'code.run')
  assert.deepEqual(continued.logs, [])
})

test('cold-replays a settled code.run result without dispatching the child again', async (t) => {
  const events = []
  const session = { id: 'recursive-replay', events }
  const first = fixture()
  t.after(() => first.dispose())
  const code = `const recursiveReplayResult = await code.run({
  code: 'return 42',
  description: 'Compute isolated child value',
})`
  const recorded = await first.runDurable(session.id, code, {}, { session })
  assert.equal(first.upstreamCalls.length, 1)
  assert.equal(recorded.meta.dshPtcPlus.calls[0].member, 'run')
  appendRunCodeEvents(events, 'recursive-parent', code, recorded)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, 'return recursiveReplayResult', {}, { session })
  assert.deepEqual(result, { logs: [], value: { logs: ['upstream'], result: 'upstream' } })
  assert.equal(restored.upstreamCalls.length, 0)
})

test('materializes binding failures as the declared tool error class', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-a', `
let caught
try { await tools.fail({}) } catch (error) {
  caught = { name: error.name, toolName: error.toolName, message: error.message }
}
return caught
`, { fail: async () => { throw new Error('denied') } })
  assert.deepEqual(result, {
    logs: [],
    value: { name: 'ToolCallError', toolName: 'fail', message: 'denied' },
  })
})

test('preserves available native tool error codes as a structured diagnostic cause', async (t) => {
  const events = []
  const session = { id: 'host-cause', events }
  const state = fixture()
  t.after(() => state.dispose())

  const code = 'return await tools.read({ file_path: "missing" })'
  const observed = await state.executeRun(session.id, code, {
    read: async () => {
      const error = new Error('file not found')
      error.code = 'ENOENT'
      throw error
    },
  }, { session })
  const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(diagnostic.code, 'PTC-X001')
  assert.deepEqual(diagnostic.cause, { code: 'ENOENT', message: 'file not found' })
  assert.match(observed.raw.error.message, /cause: ENOENT: file not found/)
  assert.equal(Object.hasOwn(diagnostic, 'dispatchState'), false)
  appendRunCodeEvents(events, 'host-cause-call', code, observed.result)
  await state.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  let replayedCalls = 0
  const recovered = await restored.run(session.id, 'return 42', {
    read: async () => {
      replayedCalls += 1
      throw new Error('host call was repeated')
    },
  }, { session })
  assert.deepEqual(recovered, { logs: [], value: 42 })
  assert.equal(replayedCalls, 0)
})

test('ignores throwing diagnostic accessors on native tool errors', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.executeRun('host-hostile-error', 'return await tools.fail({})', {
    fail: async () => {
      const error = new Error('original host failure')
      Object.defineProperties(error, {
        diagnostic: { get() { throw new Error('diagnostic getter escaped') } },
        cause: { get() { throw new Error('cause getter escaped') } },
      })
      throw error
    },
  }, {})
  assert.equal(observed.result.meta.dshPtcPlus.diagnostics[0].code, 'PTC-X001')
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics[0].cause, {
    message: 'original host failure',
  })
  assert.match(observed.raw.error.message, /cause: original host failure/)
  assert.deepEqual(await state.run('host-hostile-error', 'return 42'), { logs: [], value: 42 })
})

test('distinguishes nested native missing descriptions from the outer run_code transport', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const observed = await state.executeRun(
    'nested-description-diagnostic',
    'return await tools.read({ command: "pwd" })',
    {
      read: async () => {
        throw new Error('invalid arguments: missing required property "options.description"')
      },
    },
    {},
  )
  const failure = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.equal(failure.code, 'PTC-X001')
  assert.match(failure.message, /nested native tool arguments.*JSON path \$\.options\.description/)
  assert.match(failure.message, /outer run_code transport/)
  assert.ok(failure.help.some(item => /nested native-tool argument object/.test(item)))
})
