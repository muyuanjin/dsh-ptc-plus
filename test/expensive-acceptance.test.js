import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  inspectLog,
  MAX_MODEL_RESULT_CHARS,
  parseAcceptanceConfig,
  parseEvents,
  summarizeRuntimeSnapshots,
  selectScenarioDescriptors,
  validateAcceptanceConfig,
  valueContains,
} from '../scripts/expensive-headless-acceptance.mjs'
import {
  auditEditCalls,
  auditModelRequests,
  auditProgramWork,
  collectTrajectoryFacts,
  auditRequestHeaders,
  auditSystemPrompts,
  auditRuntimeContexts,
  isRuntimeContextSource,
  machineBudgetFailures,
  MACHINE_BUDGET_KEYS,
  validateEditTransports,
  validateRuntimeContextConfig,
  validateRequestHeaderPolicy,
} from '../scripts/acceptance-contract.mjs'
import { decodeValue, encodeValue } from '../internal/value-wire.js'
import { editRejectedCell } from '../internal/rejected-cell-editor.js'
import { runtimeAvailabilityMessage } from '../internal/runtime-messages.js'
import { ptcPresentation, ptcPresentationPatchLines } from '../scripts/dsh-host-contract.mjs'
import { analyzeSession } from '../scripts/ab-headless-trajectories.mjs'
import { Session } from '@deepseek-ai/dsh-session'
import { createCapabilityEnvironment as createEnvironment } from '../internal/capability-environment.js'

const createCapabilityEnvironment = options => createEnvironment({ ...options,
  sessionHistoryForAgent: async agent => ({ events: agent.session.snapshotEvents() }),
})

const headlessRuntime = { toolsMode: 'ptc', permissionMode: 'danger-full-access' }

test('accounts for capability plans, navigation and recovered descriptions with bounds and replacement evidence', async () => {
  const session = Session.create('capability-context-audit')
  const env = createCapabilityEnvironment({ ctx: {}, config: { capabilityManagementEnabled: true,
    capabilityBaseline: '[]', capabilityOverrides: '{}', capabilityStatistics: '{"enabled":false}',
    capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096 }, toolSchemasForAgent: () => [] })
  const agent = { id: session.id, session }
  await env.prepare(agent, [])
  assert.equal(session.snapshotEvents().some(event => event.data?.source?.form === 'capability-plan'), false)
  const accepted = await env.preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Fixture system prompt.' }] }) },
    { surfaceOp: 'append' })
  for (const message of accepted.messages) session.append('user/message', message, { surfaceOp: 'append' })
  const committed = session.snapshotEvents().find(event => event.data?.source?.form === 'capability-plan')
  const plan = { ...committed, seq: 0 }
  const message = (form, text, extra = {}) => createUserMessage({ source: { kind: 'plugin:ptc-plus', form, ...extra },
    content: [{ type: 'text', text }] })
  const navigation = { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: message('capability-navigation', 'Discover with capabilities.search.') }
  const descriptions = { type: 'user/message', seq: 2, time: 2, surfaceOp: 'append',
    data: message('capability-descriptions', 'Complete probe contract.', { entries: ['tools.probe'] }) }
  const header = { type: 'session', id: session.id }
  const events = [header, plan, navigation, descriptions, { type: 'request/header', seq: 3 }]
  const forms = ['capability-plan', 'capability-navigation', 'capability-descriptions']
  const config = { allowed: forms.map(form => ({ name: `tools:ptc-plus-${form}`, maxChars: 4096 })), maxSnapshotChars: 4096 }
  const audit = auditRuntimeContexts(events, config)
  assert.deepEqual(audit.failures, [])
  assert.equal(audit.totalMessageChars, [plan, navigation, descriptions].reduce((sum, event) => sum + event.data.content[0].text.length, 0))
  assert.equal(audit.requests[0].sections.length, 3)
  assert.match(auditRuntimeContexts(events).failures.join('\n'), /disallowed PTC Plus section/)
  const bounded = structuredClone(config)
  bounded.allowed[2].maxChars = 1
  assert.match(auditRuntimeContexts(events, bounded).failures.join('\n'), /budget is 1/)
  const corrupt = structuredClone(events)
  corrupt[1].data.source.digest = 'damaged'
  assert.match(auditRuntimeContexts(corrupt, config).failures.join('\n'), /malformed PTC runtime message/)
  assert.match(auditRuntimeContexts([...events, { ...navigation, seq: 4 }], config).failures.join('\n'), /repeats an unchanged/)
  const replacement = { type: 'user/message', seq: 4, time: 4,
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted.' }] }),
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] }
  const recovered = auditRuntimeContexts([...events, replacement, { ...navigation, seq: 5 },
    { ...descriptions, seq: 6 }, { type: 'request/header', seq: 7 }], config)
  assert.deepEqual(recovered.failures, [])
  assert.equal(recovered.requests.at(-1).sections.length, 3)
})

test('accounts for released provider availability as a bounded runtime-context state', () => {
  const header = { type: 'session', id: 'availability-context-audit' }
  const config = { allowed: [{ name: 'tools:ptc-plus-runtime-availability', maxChars: 4096 }], maxSnapshotChars: 4096 }
  const availability = (seq, state) => ({ type: 'user/message', seq, time: seq, surfaceOp: 'append',
    data: runtimeAvailabilityMessage(state) })
  const audit = auditRuntimeContexts([header, availability(1, 'unloaded')], config)
  assert.deepEqual(audit.failures, [])
  assert.deepEqual(audit.sources, ['plugin:ptc-plus:runtime-availability'])
  assert.equal(isRuntimeContextSource('plugin:ptc-plus:runtime-availability'), true)
  assert.equal(isRuntimeContextSource('agent-message:relay'), true)
  assert.equal(isRuntimeContextSource('subagent-settled:notice'), true)
  assert.equal(isRuntimeContextSource('repeat-tool-reminder:notice'), true)
  assert.equal(audit.snapshots.at(-1).sections[0].name, 'tools:ptc-plus-runtime-availability')
  assert.equal(audit.snapshots.at(-1).sections[0].chars, availability(1, 'unloaded').data.content[0].text.length)
  assert.match(auditRuntimeContexts([header, availability(1, 'unloaded')]).failures.join('\n'),
    /disallowed PTC Plus section tools:ptc-plus-runtime-availability/)
  assert.match(auditRuntimeContexts([header, availability(1, 'unloaded')],
    { ...config, allowed: [{ name: config.allowed[0].name, maxChars: 1 }] }).failures.join('\n'), /budget is 1/)
  assert.match(auditRuntimeContexts([header, availability(1, 'unloaded'), availability(2, 'unloaded')], config)
    .failures.join('\n'), /repeats an unchanged/)
})

test('additive recovered descriptions retain visible subsets, enforce their total and reassert only removed entries', () => {
  const description = (seq, id, text) => ({ type: 'user/message', seq, time: seq, surfaceOp: 'append',
    data: createUserMessage({ source: { kind: 'plugin:ptc-plus', form: 'capability-descriptions', entries: [id] },
      content: [{ type: 'text', text }] }) })
  const a = description(0, 'tools.a', 'A'.repeat(20))
  const b = description(1, 'tools.b', 'B'.repeat(20))
  const header = seq => ({ type: 'request/header', seq })
  const config = { allowed: [{ name: 'tools:ptc-plus-capability-descriptions', maxChars: 100 }], maxSnapshotChars: 100 }
  const audit = auditRuntimeContexts([a, b, header(2)], config)
  assert.deepEqual(audit.failures, [])
  assert.equal(audit.requests[0].sections[0].text, a.data.content[0].text + b.data.content[0].text)
  assert.equal(audit.requests[0].sections[0].chars, 40)
  assert.match(auditRuntimeContexts([a, b, { ...a, seq: 3 }], config).failures.join('\n'), /repeat a visible capability entry/)
  assert.match(auditRuntimeContexts([a, b], { ...config, maxSnapshotChars: 30 }).failures.join('\n'), /40 visible section chars/)
  assert.match(auditRuntimeContexts([a, b], { ...config, allowed: [{ name: config.allowed[0].name, maxChars: 30 }] }).failures.join('\n'), /40 visible chars/)
  const replacement = { type: 'user/message', seq: 3, time: 3,
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted A.' }] }),
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] }
  const restored = auditRuntimeContexts([a, b, header(2), replacement, { ...a, seq: 4 }, header(5)], config)
  assert.deepEqual(restored.failures, [])
  assert.equal(restored.requests.at(-1).sections[0].chars, 40)
  assert.match(auditRuntimeContexts([a, b, header(2), replacement, { ...b, seq: 4 }], config).failures.join('\n'), /repeat a visible capability entry/)
})

test('calling-contract updates account for every retained notification and reject damaged provenance', async () => {
  const session = Session.create('calling-contract-context-audit')
  const agent = { id: session.id, session }
  let schemas = [{ name: 'probe', parameters: { type: 'object' }, output: { type: 'string' } }]
  const env = createCapabilityEnvironment({ ctx: {}, config: { capabilityManagementEnabled: true,
    capabilityBaseline: '[]', capabilityOverrides: '{"tools.probe":"full"}', capabilityStatistics: '{"enabled":false}',
    capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096 }, toolSchemasForAgent: () => schemas })
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Fixture system prompt.' }] }) },
    { surfaceOp: 'append' })
  await env.prepare(agent, [])
  const accept = async () => {
    const decision = await env.preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
  }
  await accept()
  schemas = [{ ...schemas[0], output: { type: 'number' } }]
  await accept()
  schemas = [{ ...schemas[0], output: { type: 'boolean' } }]
  await accept()
  const events = [{ type: 'session', id: session.id }, ...session.snapshotEvents(), { type: 'request/header', seq: session.seq }]
  const config = { allowed: ['capability-plan', 'capability-contracts'].map(form => ({ name: `tools:ptc-plus-${form}`, maxChars: 16384 })), maxSnapshotChars: 32768 }
  const audit = auditRuntimeContexts(events, config)
  assert.deepEqual(audit.failures, [])
  const updates = events.filter(event => event.data?.source?.form === 'capability-contracts')
  assert.equal(updates.length, 2)
  assert.equal(audit.requests[0].sections.find(item => item.name === 'tools:ptc-plus-capability-contracts').chars,
    updates.reduce((sum, event) => sum + event.data.content[0].text.length, 0))
  const damaged = structuredClone(events)
  damaged.find(event => event.data?.source?.form === 'capability-contracts').data.source.digest = 'damaged'
  assert.match(auditRuntimeContexts(damaged, config).failures.join('\n'), /malformed PTC runtime message/)
  await env.dispose()
})

test('public series headers keep exact prefix checks while bundled streams retain accounting', () => {
  const header = { system: 'stable', config: { provider: 'fixture', model: 'fixture' }, tools: [] }
  const headers = [
    { type: 'request/header', seq: 0, data: { reason: 'initial', header } },
    { type: 'request/header', seq: 1, data: { reason: 'series', header: structuredClone(header) } },
  ]
  assert.deepEqual(auditRequestHeaders(headers).failures, [])
  const changed = structuredClone(headers)
  changed[1].data.header.system += '!'
  assert.match(auditRequestHeaders(changed).failures.join('\n'), /reason series.*changed/)
  assert.match(auditRequestHeaders([headers[1]]).failures.join('\n'), /epoch 1 cannot have reason series/)
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 40 }
  const other = { inputTokens: 3, outputTokens: 1, cacheReadTokens: 20 }
  const chunk = (seq, value) => ({ type: 'assistant/chunk', seq, data: { chunk: { type: 'usage', usage: value } } })
  const message = (seq, value, stream) => ({ type: 'assistant/message', seq, data: {
    turn: 1, step: seq, message: { content: [{ type: 'text', text: 'done' }] }, usage: value,
    ...(stream === undefined ? {} : { stream }),
  } })
  const packed = value => [
    { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['done'] },
    { type: 'chunk', time: 2, chunk: { type: 'usage', usage: value } },
  ]
  for (const events of [
    [chunk(0, usage), message(1, usage)],
    [message(0, usage, packed(usage))],
    [chunk(0, usage), { ...message(1, usage, packed(usage)), sourceEventSeqs: [0] }],
  ]) {
    const facts = collectTrajectoryFacts(events)
    assert.deepEqual(facts.failures, [])
    assert.equal(facts.usage.inputTokens, 10)
    assert.deepEqual(facts.chunkUsages, [usage])
  }
  const mixed = collectTrajectoryFacts([chunk(0, usage), message(1, usage), message(2, other, packed(other))])
  assert.deepEqual(mixed.failures, [])
  assert.equal(mixed.usage.inputTokens, 13)
  const attempts = collectTrajectoryFacts([
    { type: 'assistant/attempt', seq: 0, data: { turn: 1, step: 1, stream: packed(other) } },
    message(1, usage, packed(usage)),
  ])
  assert.deepEqual(attempts.failures, [])
  assert.equal(attempts.usage.inputTokens, 13)
  assert.deepEqual(collectTrajectoryFacts([message(1, undefined, [])]).failures, [])
  assert.equal(collectTrajectoryFacts([message(1, undefined, [])]).usageComplete, false)
  for (const events of [
    [message(1, usage, packed(other))],
    [message(1, usage, [])],
    [message(1, usage, {})],
    [message(1, usage, [null])],
    [message(1, usage, [{ type: 'chunk', time: NaN, chunk: { type: 'usage', usage } }])],
    [message(1, usage, packed({ inputTokens: -1 }))],
    [chunk(0, usage), { ...message(1, other, packed(other)), sourceEventSeqs: [0] }],
  ]) assert.ok(collectTrajectoryFacts(events).failures.length > 0)
})

function journal({ calls = [], completion, diagnostics = [], status = 'durable' } = {}) {
  return {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    status,
    calls: calls.map((call, settle) => ({
      global: call.global,
      member: call.member,
      args: encodeValue(Object.hasOwn(call, 'args') ? call.args : {}),
      ok: call.ok ?? true,
      ...((call.ok ?? true) ? { value: encodeValue(call.value) } : { error: call.error }),
      settle,
    })),
    operations: [],
    confirms: [],
    diagnostics,
    completion: completion === undefined
      ? { kind: 'return', hasValue: false }
      : { kind: 'return', hasValue: true, value: encodeValue(completion) },
  }
}

function acceptanceEvents() {
  const system = [
    'You are a coding agent powered by the model model.',
    'declare const tools: {}',
    'declare const capabilities: {}',
  ].join('\n')
  return [
    { type: 'session', version: 2, cwd: 'X:\\fixture\\workspace', id: 'session-test' },
    {
      type: 'user/message',
      data: {
        source: {
          kind: 'plugin',
          plugin: '@deepseek-ai/dsh-system-prompt',
          form: 'snapshot',
          sections: [
            { name: 'sandbox:policy', text: 'runtime policy' },
          ],
        },
        content: [{ type: 'text', text: 'snapshot wrapper\n\nruntime policy' }],
      },
    },
    {
      type: 'request/header',
      data: {
        reason: 'initial',
        header: {
          config: { provider: 'provider', model: 'model' },
          tools: [{ name: 'run_code' }],
          system,
        },
      },
    },
    { type: 'step/start', seq: 9, data: { turn: 1, step: 1 } },
    {
      type: 'tool/call', seq: 10,
      data: { callId: 'one', name: 'run_code', arguments: JSON.stringify({ code: 'const probe_random = 20', description: 'Establish random binding' }) },
    },
    {
      type: 'tool/result', seq: 11,
      data: {
        message: { source: { callId: 'one' }, content: [{ type: 'text', text: 'ok' }] },
        meta: { dshPtcPlus: journal({ calls: [{ global: 'capabilities', member: 'find', value: [] }] }) },
      },
    },
    { type: 'step/start', seq: 12, data: { turn: 1, step: 2 } },
    {
      type: 'tool/call', seq: 13,
      data: { callId: 'two', name: 'run_code', arguments: JSON.stringify({ code: 'return probe_random + 22', description: 'Reuse random binding' }) },
    },
    {
      type: 'tool/result', seq: 14,
      data: {
        message: { source: { callId: 'two' }, content: [{ type: 'text', text: '42' }] },
        meta: {
          dshPtcPlus: journal({
            calls: [
              { global: 'capabilities', member: 'inspect', value: { symbols: [{ symbol: 'code.run', replay: 'recorded-value' }] } },
              { global: 'tools', member: 'read', value: { lines: [{ text: 'sentinel' }] } },
              { global: 'code', member: 'run', value: 'child-result' },
            ],
            completion: 42,
          }),
        },
      },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'The result is 42.' }] }, usage: { inputTokens: 3, outputTokens: 2 } },
    },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
}

function resultFor(events, callId) {
  return events.find(event => event.type === 'tool/result'
    && event.data?.message?.source?.callId === callId)
}

test('preserves official message-only tool failures through shared and acceptance outcomes', () => {
  for (const isError of [false, true]) {
    const events = acceptanceEvents()
    resultFor(events, 'one').data.message = createToolResultMessage({
      callId: 'one', isError, content: [{ type: 'text', text: 'outcome' }],
    })
    const facts = collectTrajectoryFacts(events)
    assert.equal(facts.timeline[0].isError, isError)
    assert.equal(facts.timeline[0].resultError, isError)
    const report = inspectLog(events, { id: 'official-outcome', expect: {} }, {
      provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace',
    })
    assert.equal(report.failures.some(failure => failure.includes('tool result reports error for one')), isError)
  }
  for (const marker of [{ isError: true }, { error: 'historical error' }]) {
    const events = acceptanceEvents()
    Object.assign(resultFor(events, 'one').data, marker)
    assert.equal(collectTrajectoryFacts(events).timeline[0].isError, true)
  }
})

test('validates a clean expensive-acceptance profile', () => {
  const rows = parseAcceptanceConfig(`
- id: agent-instructions
  disabled: true
- id: skill
  disabled: true
- id: skill-filesystem
  disabled: true
- id: tool-skill
  disabled: true
- id: session-title-llm
  disabled: true
- id: custom-harness-identity
  disabled: true
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: true
    persona: 'You are a coding agent powered by the {{model}} model.'
- id: ptc-plus
  name: dsh-ptc-plus
${ptcPresentationPatchLines(ptcPresentation()).join('\n')}
- id: sandbox-policy
  config:
    mode: danger-full-access
- id: approval
  config:
    policy: never
`)
  assert.equal(validateAcceptanceConfig(rows, headlessRuntime), true)
  const unsupported = structuredClone(rows)
  // The composed profile may omit the row when the host retired its field.
  const unsupportedTools = unsupported.find(row => row.id === 'tools') ?? { id: 'tools' }
  if (!unsupported.includes(unsupportedTools)) unsupported.push(unsupportedTools)
  unsupportedTools.config = { mode: 'unsupported-test-mode' }
  assert.throws(() => validateAcceptanceConfig(unsupported, { ...headlessRuntime, toolsMode: 'unsupported-test-mode' }), /public DSH tools config/)
  const functionClassLoose = structuredClone(rows)
  functionClassLoose.find(row => row.id === 'ptc-plus').config = {
    looseTopLevelFunctionClassRedeclarations: true,
  }
  assert.equal(validateAcceptanceConfig(functionClassLoose, headlessRuntime, {
    looseTopLevelFunctionClassRedeclarations: true,
  }), true)
  assert.throws(() => validateAcceptanceConfig(rows, headlessRuntime, {
    looseTopLevelFunctionClassRedeclarations: true,
  }), /does not enable looseTopLevelFunctionClassRedeclarations/)
  const managed = structuredClone(rows)
  managed.find(row => row.id === 'ptc-plus').config = {
    capabilityManagementEnabled: true,
    capabilityContextEnabled: true,
    capabilityPolicy: JSON.stringify({ schema: 'ptc-capability-policy/v1',
      defaults: { availability: 'enabled', disclosure: 'adaptive' },
      categories: {}, mcpServers: {},
      items: { 'tools.write': { availability: 'closed' }, 'tools.pwsh': { disclosure: 'host' } },
      allocation: { baseline: true, statistics: false, budget: true } }),
  }
  assert.equal(validateAcceptanceConfig(managed, headlessRuntime, { managed: true }), true)
  assert.throws(() => validateAcceptanceConfig(rows, headlessRuntime, { managed: true }),
    /does not carry the managed capability fixture/)
  const shrunk = structuredClone(managed)
  shrunk.push({ id: 'tool-fs', disabled: true })
  assert.equal(validateAcceptanceConfig(shrunk, headlessRuntime, { managed: true, disabledModules: ['tool-fs'] }), true)
  assert.throws(() => validateAcceptanceConfig(managed, headlessRuntime, { managed: true, disabledModules: ['tool-fs'] }),
    /does not disable module tool-fs/)

  const contaminated = structuredClone(rows)
  contaminated.find(row => row.id === 'agent-instructions').disabled = false
  assert.throws(() => validateAcceptanceConfig(contaminated, headlessRuntime), /does not disable agent-instructions/)
  const wrongPermission = structuredClone(rows)
  wrongPermission.find(row => row.id === 'sandbox-policy').config.mode = 'workspace-write'
  assert.throws(() => validateAcceptanceConfig(wrongPermission, headlessRuntime), /does not use permission mode danger-full-access/)
  assert.throws(() => parseAcceptanceConfig('- id: [\n'), /invalid YAML/)
})

test('parses JSONL and rejects malformed lines', () => {
  assert.deepEqual(parseEvents('{"type":"session"}\n'), [{ type: 'session' }])
  assert.throws(() => parseEvents('{nope}\n'), /invalid JSONL at line 1/)
})

test('matches unescaped primitive values inside nested and cyclic graphs', () => {
  const expected = '{[(|)]}|`|"|\\|ptc-sentinel'
  const cyclic = { nested: [0, { result: `prefix:${expected}:suffix` }] }
  cyclic.self = cyclic

  assert.equal(valueContains(cyclic, expected), true)
  assert.equal(valueContains(cyclic, '0'), true)
  assert.equal(valueContains({ [expected]: 'different' }, expected), false)
  assert.equal(valueContains(cyclic, 'missing'), false)
  assert.throws(() => valueContains(cyclic, 0), /fragment must be a string/)
})

test('requires a visible completed answer and accounts for reasoning separately', () => {
  const response = content => ({ type: 'assistant/message', data: { turn: 1, message: { content } } })
  const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  const thought = { type: 'reasoning', text: 'Synthetic private text.' }
  const visible = { type: 'text', text: 'Answer' }
  for (const events of [
    [response([thought]), end],
    [response([visible]), response([thought]), end],
    [response([visible, { type: 'tool-call', name: 'run_code' }]), end],
    [response([visible])],
    [response([visible]), { ...end, data: { ...end.data, reason: { kind: 'error' } } }],
    [response([visible]), { type: 'turn/start', data: { turn: 2 } }, { ...end, data: { ...end.data, turn: 2 } }],
  ]) assert.equal(collectTrajectoryFacts(events).finalAnswer, '')
  const mixed = collectTrajectoryFacts([response([thought, visible, { type: 'text', text: 'continued' }]), end])
  assert.equal(mixed.finalAnswer, 'Answer\ncontinued')
  assert.deepEqual(mixed.assistantTexts, ['Answer\ncontinued'])
  assert.equal(mixed.reasoningChars, thought.text.length)
  assert.equal(JSON.stringify(mixed).includes(thought.text), false)
  const events = acceptanceEvents()
  const last = events.findLast(event => event.type === 'assistant/message')
  last.data.message.content = [thought]
  const report = inspectLog(events, { id: 'visible-answer', expect: {} }, { provider: 'provider', model: 'model' })
  assert.match(report.failures.join('\n'), /final answer is empty/)
  assert.equal(report.finalAnswerChars, 0)
})

test('audits protocol values and randomized cross-cell reuse', () => {
  const report = inspectLog(acceptanceEvents(), {
    id: 'continuity',
    title: 'Continuity',
    task: 'task',
    expect: {
      minCells: 2,
      maxCells: 3,
      allowedJournalStatuses: ['durable'],
      continuityBinding: 'probe_random',
      declarationCellHasValue: false,
      requiredSourceSequence: ['const probe_random', 'return probe_random'],
      requiredCalls: [{ global: 'tools', member: 'read', valueIncludes: ['sentinel'] }],
      completionEqualsAny: [42],
      finalAnswerIncludes: ['42'],
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })

  assert.deepEqual(report.failures, [])
  assert.equal(report.modelRequests, 2)
  assert.equal(report.headerEpochs, 1)
  assert.equal(report.headerChanges, 0)
  assert.equal(report.timeline[1].completion.value, 42)
  assert.deepEqual(report.timeline[1].nestedCalls[1].value, { lines: [{ text: 'sentinel' }] })
  assert.deepEqual(report.prompt.runtimeSnapshots.map(({
    seq, messageChars, ptcPlusSectionChars, otherSectionChars,
  }) => ({ seq, messageChars, ptcPlusSectionChars, otherSectionChars })), [{
    seq: undefined,
    messageChars: 32,
    ptcPlusSectionChars: 0,
    otherSectionChars: 14,
  }])
  assert.deepEqual(summarizeRuntimeSnapshots(report.prompt.runtimeSnapshots), {
    count: 1,
    ptcPlusCount: 0,
    ptcPlusMessageChars: undefined,
    ptcPlusSectionChars: undefined,
    otherSectionChars: undefined,
  })
  assert.deepEqual(summarizeRuntimeSnapshots([
    ...report.prompt.runtimeSnapshots,
    { messageChars: 63, ptcPlusSectionChars: 10, otherSectionChars: 20 },
    { messageChars: 40, ptcPlusSectionChars: 0, otherSectionChars: 30 },
  ]), {
    count: 3,
    ptcPlusCount: 1,
    ptcPlusMessageChars: { min: 63, max: 63 },
    ptcPlusSectionChars: { min: 10, max: 10 },
    otherSectionChars: { min: 20, max: 20 },
  })
  assert.deepEqual(summarizeRuntimeSnapshots([]), {
    count: 0,
    ptcPlusCount: 0,
    ptcPlusMessageChars: undefined,
    ptcPlusSectionChars: undefined,
    otherSectionChars: undefined,
  })
})

test('accepts ordered source fragments within one cell', () => {
  const events = acceptanceEvents()
  const initialCall = events.find(event => event.type === 'tool/call' && event.data.callId === 'one')
  initialCall.data.arguments = JSON.stringify({
    code: 'const probe_random = 20\nclass ProbeRandom {}',
    description: 'Establish random binding',
  })
  const report = inspectLog(events, {
    id: 'same-cell-source-order', title: 'Same-cell source order', task: 'task',
    expect: { requiredSourceSequence: ['const probe_random', 'class ProbeRandom'] },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.deepEqual(report.failures, [])
})

test('requires acceptance source groups to land in distinct cells', () => {
  const events = acceptanceEvents()
  const initialCall = events.find(event => event.type === 'tool/call' && event.data.callId === 'one')
  initialCall.data.arguments = JSON.stringify({
    code: 'const probe_random = 20\nclass ProbeRandom {}',
    description: 'Establish random binding',
  })
  const report = inspectLog(events, {
    id: 'cross-cell-source-order', title: 'Cross-cell source order', task: 'task',
    expect: {
      requiredSourceCellSequence: [
        { includes: ['const probe_random'] },
        { includes: ['class ProbeRandom'] },
      ],
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.match(report.failures.join('\n'), /required source cell group is missing/)
})

test('enforces declared system literals and rejects forbidden model-visible text', () => {
  const accepted = inspectLog(acceptanceEvents(), {
    id: 'system-literals', title: 'System literals', task: 'task',
    expect: {
      systemIncludes: ['declare const tools: {}', 'declare const capabilities: {}'],
      systemExcludes: ['interface ToolArgsMap {}'],
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.deepEqual(accepted.failures, [])
  const rejected = inspectLog(acceptanceEvents(), {
    id: 'system-literals', title: 'System literals', task: 'task',
    expect: {
      systemIncludes: ['interface ToolArgsMap {}'],
      systemExcludes: ['declare const tools: {}'],
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.match(rejected.failures.join('\n'), /system prompt omits required literal/)
  assert.match(rejected.failures.join('\n'), /system prompt contains forbidden literal/)
})

test('rejects explicitly forbidden diagnostics from a settled result', () => {
  const events = acceptanceEvents()
  const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'two')
  result.data.meta.dshPtcPlus = journal({
    calls: [{ global: 'tools', member: 'read', value: { lines: [{ text: 'sentinel' }] } }],
    completion: 42,
    diagnostics: [{ severity: 'warning', code: 'PTC-R002', phase: 'replay', stateEffect: 'unchanged',
      message: 'skipped 1 unreconstructable historical cell(s)' }],
  })
  const report = inspectLog(events, {
    id: 'forbidden-diagnostic', title: 'Forbidden diagnostic', task: 'task',
    expect: { forbiddenDiagnosticCodes: ['PTC-R002'] },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.match(report.failures.join('\n'), /forbidden PTC diagnostic: warning\[PTC-R002\]/)
})

test('validates phased managed scenario descriptors and their child expectations', () => {
  const budget = { maxModelRequests: 4, maxDirectCalls: 2, maxSourceChars: 2000, maxRepeatedSourceCalls: 0,
    maxResultChars: 4000, maxAssistantChars: 4000, maxTokenTraffic: 20000, maxRuntimeContextChars: 8000 }
  const descriptor = {
    id: 'managed-fixture', title: 'Managed fixture', default: false, task: 'task', variant: 'managed',
    phases: [{ task: 'next', variant: 'managed-no-fs' }],
    expect: { machineBudget: budget, runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 4096 } },
  }
  assert.equal(selectScenarioDescriptors([descriptor], ['managed-fixture']).length, 1)
  assert.throws(() => selectScenarioDescriptors([{ ...descriptor, variant: 'Managed' }], ['managed-fixture']),
    /variant must be a kebab-case name/)
  assert.throws(() => selectScenarioDescriptors([{ ...descriptor, phases: [] }], ['managed-fixture']),
    /phases must be a non-empty array/)
  assert.throws(() => selectScenarioDescriptors([{ ...descriptor, phases: [{ task: '' }] }], ['managed-fixture']),
    /requires a task and an optional variant name/)
  assert.throws(() => selectScenarioDescriptors([{ ...descriptor, phases: [{ task: 'next', extra: true }] }], ['managed-fixture']),
    /requires a task and an optional variant name/)
  assert.throws(() => selectScenarioDescriptors([{ ...descriptor, expect: { ...descriptor.expect, systemIncludes: [] } }], ['managed-fixture']),
    /systemIncludes must be a non-empty array of literals/)
  assert.throws(() => selectScenarioDescriptors([{ ...descriptor, expect: { ...descriptor.expect, systemChanges: -1 } }], ['managed-fixture']),
    /systemChanges must be a non-negative safe integer/)
  assert.throws(() => selectScenarioDescriptors([{ ...descriptor,
    expect: { ...descriptor.expect, childSession: { runtimeContexts: { allowed: [], maxSnapshotChars: 0 } } } }], ['managed-fixture']),
    /maxSnapshotChars must be a positive safe integer/)
})

test('counts cache-write tokens in expensive acceptance traffic budgets', () => {
  const events = acceptanceEvents()
  const assistant = events.find(event => event.type === 'assistant/message')
  assistant.data.usage = {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: 6,
  }
  const report = inspectLog(events, {
    id: 'cache-write-budget',
    title: 'Cache write budget',
    task: 'task',
    expect: {
      minCells: 2,
      finalAnswerIncludes: ['42'],
      machineBudget: {
        maxModelRequests: 10,
        maxDirectCalls: 10,
        maxSourceChars: 10_000,
        maxRepeatedSourceCalls: 10,
        maxResultChars: 10_000,
        maxAssistantChars: 10_000,
        maxTokenTraffic: 14,
        maxRuntimeContextChars: 10_000,
      },
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })

  assert.deepEqual(report.usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: 6,
  })
  assert.equal(report.machineMetrics.tokenTraffic, 15)
  assert.deepEqual(report.failures, [
    'cache-write-budget tokenTraffic is 15; budget is 14',
  ])
})

test('makes complete header drift a runner-level acceptance failure', () => {
  const events = acceptanceEvents()
  const initial = events.find(event => event.type === 'request/header').data.header
  const changed = structuredClone(initial)
  changed.tools[0].parameters = { type: 'object', properties: { extra: { type: 'boolean' } } }
  events.push({
    type: 'request/header',
    data: { reason: 'change', header: changed },
  })
  const report = inspectLog(events, {
    id: 'header-drift', title: 'Header drift', task: 'task', expect: {},
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })

  assert.equal(report.modelRequests, 2)
  assert.equal(report.headerEpochs, 2)
  assert.equal(report.headerChanges, 1)
  assert.match(report.failures.join('\n'), /changed tools\[0\]/)
})

test('audits discovery before native and isolated binding use', () => {
  const report = inspectLog(acceptanceEvents(), {
    id: 'discovery', title: 'Discovery', task: 'task',
    expect: {
      minCells: 2,
      requiredCallSequence: [
        { global: 'capabilities', member: 'find' },
        { global: 'capabilities', member: 'inspect' },
        { global: 'tools', member: 'read' },
        { global: 'code', member: 'run' },
      ],
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.deepEqual(report.failures, [])
})

test('rejects repeated program binding calls above a scenario maximum', () => {
  const events = acceptanceEvents()
  resultFor(events, 'two').data.meta.dshPtcPlus = journal({
    calls: [
      { global: 'code', member: 'run', value: { logs: [], result: 'first' } },
      { global: 'code', member: 'run', ok: false, error: 'second call failed' },
    ],
  })
  const report = inspectLog(events, {
    id: 'single-child', title: 'Single child execution', task: 'task',
    expect: {
      requiredCalls: [{ global: 'code', member: 'run', min: 1, max: 1 }],
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.deepEqual(report.failures, [
    '2 code.run calls exceed scenario maximum 1',
  ])
})

test('preserves exact nested arguments in memory and lossless report graphs', () => {
  const cyclic = { count: 2n }
  cyclic.self = cyclic
  const argumentsList = [undefined, {}, { value: undefined }, null, cyclic]
  const events = acceptanceEvents()
  resultFor(events, 'one').data.meta.dshPtcPlus = journal({
    calls: argumentsList.map(args => ({ global: 'tools', member: 'observe', args, value: 1 })),
  })
  const facts = collectTrajectoryFacts(events, { compareUsageChunks: false })
  assert.deepEqual(facts.failures, [])
  const calls = facts.timeline[0].nestedCalls
  assert.deepEqual(calls.map(call => call.args), argumentsList)
  const reported = JSON.parse(JSON.stringify(calls))
  assert.deepEqual(reported.map(call => decodeValue(call.argsWire)), argumentsList)
  assert.deepEqual(auditProgramWork([{ nestedCalls: reported }]).failures, [])
  delete events.find(event => event.type === 'tool/result').data.meta.dshPtcPlus.calls[0].args
  assert.match(collectTrajectoryFacts(events, { compareUsageChunks: false }).failures.join('\n'), /invalid PTC journal/)
  delete reported[0].argsWire
  assert.match(auditProgramWork([{ nestedCalls: reported }]).failures.join('\n'), /invalid argument evidence/)
})

test('both paid reports preserve canonical result and completion types through JSON persistence', () => {
  const shared = { count: 2n }
  const graph = { left: shared, right: shared, numbers: [NaN, Infinity, -Infinity, -0] }
  graph.self = graph
  for (const value of [2n, graph, undefined]) {
    const events = acceptanceEvents()
    const metadata = journal({ calls: [{ global: 'code', member: 'run', value }] })
    metadata.completion = { kind: 'return', hasValue: true, value: encodeValue(value) }
    resultFor(events, 'one').data.meta.dshPtcPlus = metadata
    const selectedRuntime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }
    const reports = [
      inspectLog(events, { id: 'canonical-values', expect: {} }, selectedRuntime),
      analyzeSession(events, {
        ...selectedRuntime, variant: 'plugin',
        machineBudget: Object.fromEntries(MACHINE_BUDGET_KEYS.map(key => [key, 1_000_000])),
      }),
    ]
    for (const report of reports) {
      const cell = report.timeline[0]
      assert.deepEqual(cell.nestedCalls[0].value, value)
      assert.deepEqual(cell.nestedCalls[0].args, {})
      assert.deepEqual(cell.completion.value, value)
      const persisted = JSON.parse(JSON.stringify(report)).timeline[0]
      for (const evidence of [persisted.nestedCalls[0], persisted.completion]) {
        assert.equal(Object.hasOwn(evidence, 'value'), false)
        const decoded = decodeValue(evidence.valueWire)
        assert.deepEqual(decoded, value)
        if (value === graph) {
          assert.equal(decoded.self, decoded)
          assert.equal(decoded.left, decoded.right)
          assert.equal(typeof decoded.left.count, 'bigint')
          assert.equal(Object.is(decoded.numbers[3], -0), true)
        }
      }
    }
  }
})

test('enforces the typed fixture workload while allowing focused equivalent trajectories and explicit fresh reads', async () => {
  const descriptors = JSON.parse(await readFile(new URL('../scripts/expensive-acceptance-scenarios.json', import.meta.url)))
  const policy = descriptors.find(item => item.id === 'durable-program-surface').expect.programWork
  const events = acceptanceEvents()
  const inspect = { global: 'capabilities', member: 'inspect', args: { symbols: ['tools.read', 'code.run'] }, value: {} }
  const read = { global: 'tools', member: 'read', args: { file_path: 'fixture.txt', limit: 10 }, value: 'sentinel' }
  const run = { global: 'code', member: 'run', args: { source: 'return "sentinel:8"' }, value: {} }
  resultFor(events, 'one').data.meta.dshPtcPlus = journal({ calls: [inspect, read] })
  resultFor(events, 'two').data.meta.dshPtcPlus = journal({ calls: [run] })
  const inspectScenario = { id: 'focused-work', title: 'Focused work', task: 'task', expect: { programWork: policy } }
  const runtime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }
  assert.deepEqual(inspectLog(events, inspectScenario, runtime).failures, [])

  const split = structuredClone(events)
  resultFor(split, 'one').data.meta.dshPtcPlus = journal({ calls: [
    { ...inspect, args: { symbols: ['tools.read'] } }, read,
  ] })
  resultFor(split, 'two').data.meta.dshPtcPlus = journal({ calls: [
    { ...inspect, args: { symbols: ['code.run'] } }, run,
  ] })
  assert.deepEqual(inspectLog(split, inspectScenario, runtime).failures, [])

  resultFor(events, 'two').data.meta.dshPtcPlus = journal({ calls: [
    { ...read, args: { limit: 10, file_path: 'fixture.txt' } }, run,
  ] })
  const repeated = inspectLog(events, inspectScenario, runtime)
  assert.equal(repeated.machineMetrics.repeatedSourceCalls, 0)
  assert.match(repeated.failures.join('\n'), /tools.read repeats identical arguments 2 times/)
  const freshPolicy = structuredClone(policy)
  Object.assign(freshPolicy.callLimits.find(limit => limit.global === 'tools'), { maxCalls: 2, maxCallsPerArguments: 2 })
  assert.deepEqual(inspectLog(events, { ...inspectScenario, expect: { programWork: freshPolicy } }, runtime).failures, [])

  for (const args of [{ symbols: ['tools.read', 'repl.state'] }, undefined, {}]) {
    resultFor(events, 'one').data.meta.dshPtcPlus = journal({ calls: [{ ...inspect, args }, read] })
    assert.match(inspectLog(events, inspectScenario, runtime).failures.join('\n'), /unrelated capability inspection|focused inspection requires/)
  }
  resultFor(events, 'one').data.meta.dshPtcPlus = journal({ calls: [
    { global: 'capabilities', member: 'tree', args: undefined, value: [] },
    { global: 'capabilities', member: 'tree', args: undefined, value: [] },
  ] })
  assert.match(inspectLog(events, inspectScenario, runtime).failures.join('\n'), /capabilities.tree has 2 calls/)
  resultFor(events, 'two').data.meta.dshPtcPlus.calls[0].args = { corrupt: true }
  assert.match(inspectLog(events, inspectScenario, runtime).failures.join('\n'), /invalid PTC journal/)
})

function historicalEditEvents(args) {
  const source = 'const value = 1; return value'
  const correction = editRejectedCell(args, source)
  const events = acceptanceEvents().slice(0, 3)
  events.push(
    { type: 'turn/start', seq: 9, data: {} },
    { type: 'tool/call', seq: 10, data: {
      callId: 'source', name: 'run_code', arguments: JSON.stringify({ code: source, description: 'Return a value' }),
    } },
    { type: 'tool/result', seq: 11, data: {
      message: { source: { callId: 'source' }, content: [{ type: 'text', text: '1' }] },
      meta: { dshPtcPlus: journal({ completion: 1 }) },
    } },
    { type: 'tool/call', seq: 12, data: { callId: 'edit', name: 'edit_run_code', arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: 13, data: {
      message: { source: { callId: 'edit' }, content: [{ type: 'text', text: '{"edited":true,"logs":[],"value":2}' }] },
      meta: {
        dshPtcPlus: journal({ completion: 2 }),
        dshPtcPlusEdit: { targetCallSeq: 10 },
        dshPtcPlusDerivedRun: { code: correction.code, description: correction.description },
      },
    } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '2' }] } } },
    { type: 'turn/end', seq: 14, data: { reason: { kind: 'completed' } } },
  )
  return events
}

// Convert archived direct-editor audit fixtures into the current nested protocol.
function nestedEditorEvents(archived, { includeReads = false } = {}) {
  const events = []
  const mappedSeqs = new Map()
  let nextSequence = 9
  for (const event of archived) {
    if (event.type !== 'tool/call' || event.data.name !== 'edit_run_code') {
      if (event.type === 'tool/result'
        && archived.some(call => call.type === 'tool/call' && call.data.name === 'edit_run_code'
          && call.data.callId === event.data.message.source.callId)) continue
      const copy = structuredClone(event)
      if (events.length >= 3) copy.seq = nextSequence++
      if (Number.isSafeInteger(event.seq)) mappedSeqs.set(event.seq, copy.seq)
      events.push(copy)
      continue
    }
    const args = JSON.parse(event.data.arguments)
    const original = resultFor(archived, event.data.callId)
    const targetCallSeq = mappedSeqs.get(original.data.meta.dshPtcPlusEdit.targetCallSeq)
    const targetEvent = archived.find(candidate =>
      candidate?.seq === original.data.meta.dshPtcPlusEdit.targetCallSeq)
    let targetFirstLine = ''
    try {
      const targetCode = JSON.parse(targetEvent?.data?.arguments ?? '{}').code
      if (typeof targetCode === 'string') targetFirstLine = targetCode.split(/\r?\n/, 1)[0].trim()
    } catch {}
    const targetLabel = `run_code call ${targetCallSeq}${targetFirstLine === '' ? '' : `, first line: ${targetFirstLine}`}`
    const mismatch = args.expected_target_call_seq !== undefined
      && args.expected_target_call_seq !== targetCallSeq
    const receipt = mismatch
      ? { accepted: false, scheduled: false,
          reason: `validated repair targets run_code call ${args.expected_target_call_seq}, but this edit captured ${targetLabel}.`
            + ' Only the most recent settled cell stays editable; if the intended cell is no longer editable, re-submit its corrected source with run_code instead.' }
      : { accepted: true, scheduled: true, target_call_seq: targetCallSeq }
    const rootCallSeq = nextSequence
    nextSequence += mismatch ? 4 : includeReads ? 8 : 6
    const rootCallId = event.data.callId
    const subCallId = `${rootCallId}:ptc:1`
    const data = { rootCallId, parentCallId: rootCallId, subCallId,
      name: 'edit_run_code', arguments: args }
    const code = `return await tools.edit_run_code(${JSON.stringify(args)})`
    const meta = { dshPtcPlus: journal({ calls: [{ global: 'tools', member: 'edit_run_code',
      args, value: receipt }], completion: receipt }) }
    if (!mismatch) meta.dshPtcPlusPostEdit = {
      rootCallSeq, startSeq: rootCallSeq + 1, executionStartSeq: rootCallSeq + 3, subCallId,
      meta: { ...original.data.meta, dshPtcPlusEdit: { targetCallSeq } },
    }
    events.push(
      { type: 'tool/call', seq: rootCallSeq, data: { callId: rootCallId, name: 'run_code',
        arguments: JSON.stringify({ code, description: 'Schedule a localized correction' }) } },
      { type: 'tool/ptc-dispatch-start', seq: rootCallSeq + 1, data },
      { type: 'tool/ptc-dispatch', seq: rootCallSeq + 2, data: { ...data, isError: false,
        content: [{ type: 'text', text: JSON.stringify(receipt) }] } },
      ...(!mismatch ? [
        { type: 'tool/ptc-dispatch-start', seq: rootCallSeq + 3, data: {
          rootCallId, parentCallId: rootCallId, subCallId: `${subCallId}:derived`, name: 'run_code',
          arguments: original.data.meta.dshPtcPlusDerivedRun,
        } },
        { type: 'tool/ptc-dispatch', seq: rootCallSeq + 4, data: {
          rootCallId, parentCallId: rootCallId, subCallId: `${subCallId}:derived`, name: 'run_code',
          arguments: original.data.meta.dshPtcPlusDerivedRun, isError: false,
          content: original.data.message.content, meta: { dshPtcPlus: original.data.meta.dshPtcPlus },
        } },
      ] : []),
      { type: 'tool/result', seq: rootCallSeq + (mismatch ? 3 : 5), data: { message: { source: { callId: rootCallId },
        content: [{ type: 'text', text: JSON.stringify(receipt) }, ...original.data.message.content] }, meta } },
    )
    if (includeReads && !mismatch) {
      const readId = `${rootCallId}:read`
      const code = original.data.meta.dshPtcPlusDerivedRun.code.split('\n').at(-1)
      events.push(
        { type: 'tool/call', seq: rootCallSeq + 6, data: { callId: readId, name: 'run_code',
          arguments: JSON.stringify({ code, description: 'Read the revised binding' }) } },
        { type: 'tool/result', seq: rootCallSeq + 7, data: { message: { source: { callId: readId },
          content: original.data.message.content }, meta: { dshPtcPlus: original.data.meta.dshPtcPlus } } },
      )
    }
  }
  return events
}

function editEvents(args) { return nestedEditorEvents(historicalEditEvents(args)) }

test('retains canonical archived direct editor audit without treating it as a current root tool', () => {
  const events = historicalEditEvents({ edits: [{ old_string: '1', new_string: '2' }] })
  assert.deepEqual(auditEditCalls(events, collectTrajectoryFacts(events).timeline).failures, [])
})

test('audits reused settled root and nested call IDs by their source sequences', () => {
  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const events = editEvents(args)
  const repeated = editEvents(args).slice(3)
  for (const event of repeated) {
    event.seq += 40
    const post = event.data?.meta?.dshPtcPlusPostEdit
    if (post === undefined) continue
    post.rootCallSeq += 40
    post.startSeq += 40
    post.executionStartSeq += 40
    post.meta.dshPtcPlusEdit.targetCallSeq += 40
    const receipt = { accepted: true, scheduled: true,
      target_call_seq: post.meta.dshPtcPlusEdit.targetCallSeq }
    event.data.meta.dshPtcPlus = journal({ calls: [{ global: 'tools',
      member: 'edit_run_code', args, value: receipt }], completion: receipt })
    const settledReceipt = repeated.find(candidate => candidate.type === 'tool/ptc-dispatch'
      && candidate.seq === post.startSeq + 1 && candidate.data.name === 'edit_run_code')
    settledReceipt.data.content = [{ type: 'text', text: JSON.stringify(receipt) }]
  }
  events.push(...repeated)
  const facts = collectTrajectoryFacts(events, { compareUsageChunks: false })
  assert.deepEqual(facts.failures, [])
  assert.equal(facts.calls.size, 4)
  assert.equal(facts.results.size, 4)
  assert.deepEqual(auditEditCalls(events, facts.timeline).failures, [])

  const forged = structuredClone(events)
  const rootResults = forged.filter(event => event.type === 'tool/result'
    && event.data?.meta?.dshPtcPlusPostEdit !== undefined)
  rootResults[1].sourceEventSeqs = [rootResults[0].data.meta.dshPtcPlusPostEdit.rootCallSeq]
  assert.match(collectTrajectoryFacts(forged, { compareUsageChunks: false }).failures.join('\n'),
    /no unique matching call|no matching result/)
})

function insertAuditDispatch(events, source, beforeSeq) {
  const index = events.findIndex(event => event.seq === beforeSeq)
  const inserted = { ...structuredClone(source), seq: beforeSeq }
  for (const event of events) {
    if (event.seq >= beforeSeq) event.seq++
    if (event.sourceEventSeqs !== undefined) {
      event.sourceEventSeqs = event.sourceEventSeqs.map(seq => seq >= beforeSeq ? seq + 1 : seq)
    }
    const post = event.data?.meta?.dshPtcPlusPostEdit
    if (post !== undefined) {
      for (const key of ['rootCallSeq', 'startSeq', 'executionStartSeq']) {
        if (post[key] >= beforeSeq) post[key]++
      }
    }
  }
  events.splice(index, 0, inserted)
}

for (const name of ['edit_run_code', 'run_code']) {
  for (const type of ['tool/ptc-dispatch-start', 'tool/ptc-dispatch']) {
    test(`rejects duplicate ${name} ${type} inside its root result window`, () => {
      const events = editEvents({ edits: [{ old_string: '1', new_string: '2' }] })
      const selected = events.find(event => event.type === type && event.data.name === name)
      const settled = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === name)
      const root = resultFor(events, 'edit')
      root.sourceEventSeqs = [root.data.meta.dshPtcPlusPostEdit.rootCallSeq]
      insertAuditDispatch(events, selected, settled.seq)
      const facts = collectTrajectoryFacts(events, { compareUsageChunks: false })
      assert.deepEqual(facts.failures, [])
      assert.match(auditEditCalls(events, facts.timeline).failures.join('\n'),
        /no matching nested dispatch and root result|no proved actual derived execution pair/)
    })
  }
  test(`rejects a selected ${name} start sequence that names its settlement`, () => {
    const events = editEvents({ edits: [{ old_string: '1', new_string: '2' }] })
    const settled = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === name)
    const post = resultFor(events, 'edit').data.meta.dshPtcPlusPostEdit
    post[name === 'edit_run_code' ? 'startSeq' : 'executionStartSeq'] = settled.seq
    const facts = collectTrajectoryFacts(events, { compareUsageChunks: false })
    assert.deepEqual(facts.failures, [])
    assert.match(auditEditCalls(events, facts.timeline).failures.join('\n'),
      /no proved accepted receipt|no proved actual derived execution pair/)
  })
}

test('audits both canonical delta forms with absent or correct guards and rejects invalid arguments', () => {
  const scenario = { id: 'edit', title: 'Edit', task: 'task', expect: {} }
  const runtime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }
  for (const delta of [
    { edits: [{ old_string: '1', new_string: '2' }] },
    { regex_edits: [{ pattern: '1', flags: '', replacement: '2', expected_matches: 1 }] },
  ]) {
    for (const guard of [{}, { expected_target_call_seq: 10 }]) {
      assert.deepEqual(inspectLog(editEvents({ ...delta, ...guard }), scenario, runtime).failures, [])
    }
    for (const invalid of [
      { extra: true }, { expected_target_call_seq: -1 }, { expected_target_call_seq: 1.5 },
      { expected_target_call_seq: '10' }, { expected_target_call_seq: null },
      { expected_target_call_seq: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const report = inspectLog(editEvents({ ...delta, ...invalid }), scenario, runtime)
      assert.match(report.failures.join('\n'), /canonical edit validation/)
    }
    const events = editEvents({ ...delta, expected_target_call_seq: 10 })
    resultFor(events, 'edit').data.meta.dshPtcPlusPostEdit.meta.dshPtcPlusEdit.targetCallSeq = 11
    assert.match(inspectLog(events, scenario, runtime).failures.join('\n'), /does not identify its captured target/)
  }
})

test('rejects contradictory derived outcomes and nested editor receipt content', () => {
  const args = { edits: [{ old_string: '1', new_string: '2' }] }
  const events = editEvents(args)
  const audit = () => auditEditCalls(events, collectTrajectoryFacts(events).timeline)
  assert.deepEqual(audit().failures, [])
  const derived = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'run_code')
  derived.data.isError = true
  assert.match(audit().failures.join('\n'), /actual derived outcome contradicts its execution journal/)
  derived.data.isError = false
  const receipt = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'edit_run_code')
  receipt.data.content = [{ type: 'text', text: '{"accepted":false,"scheduled":false,"reason":"rejected"}' }]
  assert.match(audit().failures.join('\n'), /nested receipt content contradicts its recorded canonical value/)
})

test('inspects derived journal diagnostics and status without changing direct cell counts', () => {
  const events = editEvents({ edits: [{ old_string: '1', new_string: '2' }] })
  const runtime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }
  const scenario = { id: 'derived-failure', expect: { allowedJournalStatuses: ['durable'] } }
  const derived = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'run_code')
  const root = resultFor(events, 'edit')
  const failed = journal({ status: 'volatile', diagnostics: [{ code: 'PTC-X001', severity: 'error',
    phase: 'execute', message: 'expected derived failure', stateEffect: 'partially-applied', dispatchState: 'completed' }] })
  failed.volatileReason = 'expected execution failure'
  failed.completion = { kind: 'throw', error: { kind: 'exception', message: 'expected derived failure' } }
  derived.data.isError = true
  derived.data.meta.dshPtcPlus = structuredClone(failed)
  root.data.meta.dshPtcPlusPostEdit.meta.dshPtcPlus = structuredClone(failed)
  assert.deepEqual(auditEditCalls(events, collectTrajectoryFacts(events).timeline).failures, [])
  const denied = inspectLog(events, scenario, runtime)
  assert.match(denied.failures.join('\n'), /tool result reports error for edit:ptc:1:derived/)
  assert.match(denied.failures.join('\n'), /blocking PTC diagnostic: error\[PTC-X001\]/)
  assert.match(denied.failures.join('\n'), /journal status volatile is not allowed/)
  const allowed = inspectLog(events, { ...scenario, expect: {
    allowedDiagnosticCodes: ['PTC-X001'], allowedJournalStatuses: ['durable', 'volatile'],
    requiredJournalStatuses: ['volatile'], requiredDirectToolSequence: ['run_code', 'run_code'], maxCells: 2,
  } }, runtime)
  assert.deepEqual(allowed.failures, [])
  assert.equal(allowed.timeline.length, 2)
  assert.equal(allowed.derivedExecutions.length, 1)
  assert.equal(allowed.derivedExecutions[0].rootCallId, 'edit')
  assert.equal(allowed.derivedExecutions[0].isError, true)
  assert.match(allowed.diagnostics.join('\n'), /expected derived failure/)
})

test('the current edit canary uses four roots and canonical derived completions', async () => {
  const descriptors = JSON.parse(await readFile(new URL('../scripts/expensive-acceptance-scenarios.json', import.meta.url), 'utf8'))
  const canary = descriptors.find(descriptor => descriptor.id === 'rejected-cell-editing')
  assert.deepEqual(canary.expect.requiredDirectToolSequence, ['run_code', 'run_code', 'run_code', 'run_code'])
  assert.match(canary.task, /tools\.edit_run_code/)
  assert.match(canary.task, /accepted\/scheduled.*接收回执/)
  const events = editEvents({ edits: [{ old_string: '1', new_string: '2' }] })
  const runtime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }
  const scenario = { id: 'derived-completion', expect: { completionEqualsAny: [2], completionIncludes: ['2'] } }
  assert.deepEqual(inspectLog(events, scenario, runtime).failures, [])
  const derived = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'run_code')
  derived.data.meta.dshPtcPlus = journal({ completion: 3 })
  resultFor(events, 'edit').data.meta.dshPtcPlusPostEdit.meta.dshPtcPlus = journal({ completion: 3 })
  // The original rendered text still says 2; only canonical completions satisfy the oracle.
  assert.match(inspectLog(events, scenario, runtime).failures.join('\n'), /decoded cell completions do not equal 2/)
})

test('recognizes only explicitly expected guard rejection without derived execution', () => {
  const args = { edits: [{ old_string: '1', new_string: '2' }], expected_target_call_seq: 8 }
  const events = editEvents(args)
  const result = resultFor(events, 'edit')
  const runtime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }
  const scenario = { id: 'guard-rejection', title: 'Guard rejection', task: 'task', expect: { guardMismatchEdits: [1] } }
  assert.deepEqual(inspectLog(events, scenario, runtime).failures, [])
  assert.match(inspectLog(events, { ...scenario, expect: {} }, runtime).failures.join('\n'), /guard does not match/)
  result.data.meta.dshPtcPlusPostEdit = { meta: {} }
  assert.match(inspectLog(events, scenario, runtime).failures.join('\n'), /did not prove guard rejection/)
  delete result.data.meta.dshPtcPlusPostEdit
  for (const value of [undefined, { accepted: true, scheduled: true, target_call_seq: 10 }]) {
    result.data.meta.dshPtcPlus = journal({ calls: [{ global: 'tools', member: 'edit_run_code', args, value }] })
    assert.match(inspectLog(events, scenario, runtime).failures.join('\n'), /did not prove guard rejection/)
  }
})

test('records a handled nested error as a diagnostic instead of a product failure', () => {
  const events = acceptanceEvents()
  resultFor(events, 'one').data.meta.dshPtcPlus = journal({
    calls: [{ global: 'tools', member: 'read', ok: false, error: 'not found' }],
  })
  const report = inspectLog(events, {
    id: 'handled-error', title: 'Handled error', task: 'task',
    expect: { minCells: 2, allowedJournalStatuses: ['durable'] },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })

  assert.deepEqual(report.failures, [])
  assert.match(report.diagnostics.join('\n'), /handled nested error.*not found/)
})

test('rejects one model-visible result above the spill presentation budget', () => {
  const events = acceptanceEvents()
  resultFor(events, 'one').data.message.content = [{
    type: 'text', text: 'x'.repeat(MAX_MODEL_RESULT_CHARS + 1),
  }]
  const report = inspectLog(events, {
    id: 'oversized-result', title: 'Oversized result', task: 'task',
    expect: { minCells: 2, allowedJournalStatuses: ['durable'] },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })

  assert.match(
    report.failures.join('\n'),
    new RegExp(`exceeds the ${MAX_MODEL_RESULT_CHARS}-character model-content budget`),
  )
})

test('allows only explicitly expected pre-execution diagnostics', () => {
  const events = acceptanceEvents()
  const rejected = resultFor(events, 'one')
  rejected.data.message.content = [{ type: 'text', text: 'syntax rejected', isError: true }]
  rejected.data.meta.dshPtcPlus = journal({
    status: 'noop',
    diagnostics: [{
      code: 'PTC-C001', severity: 'error', phase: 'parse',
      message: 'cell syntax could not be parsed', stateEffect: 'unchanged',
      dispatchState: 'not-dispatched', help: ['repair this cell'],
    }],
  })
  const scenario = {
    id: 'expected-rejection', title: 'Expected rejection', task: 'task',
    expect: {
      minCells: 2,
      allowedJournalStatuses: ['noop', 'durable'],
      allowedDiagnosticCodes: ['PTC-C001'],
    },
  }
  const runtime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }

  const allowed = inspectLog(events, scenario, runtime)
  assert.deepEqual(allowed.failures, [])
  assert.match(allowed.diagnostics.join('\n'), /error\[PTC-C001\]/)

  const denied = inspectLog(events, {
    ...scenario,
    expect: { ...scenario.expect, allowedDiagnosticCodes: [] },
  }, runtime)
  assert.match(denied.failures.join('\n'), /tool result reports error/)
  assert.match(denied.failures.join('\n'), /blocking PTC diagnostic: error\[PTC-C001\]/)
})

test('void-required continuity rejects binding values and unrelated acknowledgements', () => {
  const events = acceptanceEvents()
  resultFor(events, 'one').data.meta.dshPtcPlus = journal({ completion: 20 })
  const report = inspectLog(events, {
    id: 'transported-binding', title: 'Transported binding', task: 'task',
    expect: {
      minCells: 2,
      continuityBinding: 'probe_random',
      declarationCellHasValue: false,
      completionEqualsAny: [42],
    },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })

  assert.match(report.failures.join('\n'), /binding declaration cell completion hasValue is true instead of false/)

  resultFor(events, 'one').data.meta.dshPtcPlus = journal({ completion: 'declared' })
  const acknowledgement = inspectLog(events, {
    id: 'void-setup', title: 'Void setup', task: '不要返回任何值',
    expect: { continuityBinding: 'probe_random', declarationCellHasValue: false },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.match(acknowledgement.failures.join('\n'), /binding declaration cell completion hasValue is true instead of false/)

  const missingSource = inspectLog(events, {
    id: 'missing-source-sequence', title: 'Missing source sequence', task: 'task',
    expect: { requiredSourceSequence: ['not present'] },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.match(missingSource.failures.join('\n'), /required source fragment is missing/)
})

test('continuity descriptors explicitly prohibit any setup return required by their oracle', async () => {
  const descriptors = JSON.parse(await readFile(new URL('../scripts/expensive-acceptance-scenarios.json', import.meta.url)))
  const voidScenarios = descriptors.filter(item => item.expect.declarationCellHasValue === false)
  assert.equal(voidScenarios.length, 3)
  for (const scenario of voidScenarios) assert.match(scenario.task, /不要 return，也不要返回任何值（包括确认字符串）/)
})

test('requires truthful edits for completed and rejected cells while keeping materialized source private', () => {
  const completedSource = 'const adjustmentSource = "long-source"\nreturn adjustmentSource.length'
  const adjustedSource = 'const adjustmentSource = "long-source"\nreturn `adjusted:${adjustmentSource.length}:${adjustmentSource.slice(-8)}`'
  const rejectedSource = 'const repairSource = "long-source"\nreturn repairSource.length:'
  const repairedSource = 'const repairSource = "long-source"\nreturn `${repairSource.length}:${repairSource.slice(-8)}`'
  let events = acceptanceEvents().slice(0, 3)
  events.push(
    { type: 'turn/start', seq: 9, data: {} },
    {
      type: 'tool/call', seq: 10,
      data: { callId: 'completed', name: 'run_code', arguments: JSON.stringify({ code: completedSource, description: 'Run adjustable source' }) },
    },
    {
      type: 'tool/result', seq: 11,
      data: {
        message: { source: { callId: 'completed' }, content: [{ type: 'text', text: '11' }] },
        meta: { dshPtcPlus: journal({ completion: 11 }) },
      },
    },
    {
      type: 'tool/call', seq: 12,
      data: {
        callId: 'adjust', name: 'edit_run_code',
        arguments: JSON.stringify({ edits: [{
          old_string: 'return adjustmentSource.length',
          new_string: 'return `adjusted:${adjustmentSource.length}:${adjustmentSource.slice(-8)}`',
        }] }),
      },
    },
    {
      type: 'tool/result', seq: 13,
      data: {
        message: { source: { callId: 'adjust' }, content: [{ type: 'text', text: '{"edited":true,"value":"adjusted:11:ng-source"}' }] },
        meta: {
          dshPtcPlus: journal({ completion: 'adjusted:11:ng-source' }),
          dshPtcPlusEdit: { targetCallSeq: 10 },
          dshPtcPlusDerivedRun: { code: adjustedSource, description: 'Edit and run TypeScript cell' },
        },
      },
    },
    {
      type: 'tool/call', seq: 14,
      data: { callId: 'rejected', name: 'run_code', arguments: JSON.stringify({ code: rejectedSource, description: 'Run rejected source' }) },
    },
    {
      type: 'tool/result', seq: 15,
      data: {
        message: { source: { callId: 'rejected' }, content: [{ type: 'text', text: 'syntax rejected', isError: true }] },
        meta: { dshPtcPlus: journal({
          status: 'noop',
          diagnostics: [{
            code: 'PTC-C001', severity: 'error', phase: 'parse', message: 'invalid syntax',
            stateEffect: 'unchanged', dispatchState: 'not-dispatched', help: ['edit the cell'],
          }],
        }) },
      },
    },
    {
      type: 'tool/call', seq: 16,
      data: {
        callId: 'repair', name: 'edit_run_code',
        arguments: JSON.stringify({ edits: [{
          old_string: 'return repairSource.length:',
          new_string: 'return `${repairSource.length}:${repairSource.slice(-8)}`',
        }] }),
      },
    },
    {
      type: 'tool/result', seq: 17,
      data: {
        message: { source: { callId: 'repair' }, content: [{ type: 'text', text: '{"edited":true,"value":"11:ng-source"}' }] },
        meta: {
          dshPtcPlus: journal({ completion: '11:ng-source' }),
          dshPtcPlusEdit: { targetCallSeq: 14 },
          dshPtcPlusDerivedRun: { code: repairedSource, description: 'Edit and run TypeScript cell' },
        },
      },
    },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'adjusted:11:ng-source; 11:ng-source' }] }, usage: { inputTokens: 10, outputTokens: 2 } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  )
  events = nestedEditorEvents(events, { includeReads: true })
  const scenario = {
    id: 'edit-transport', title: 'Edit transport', task: 'task',
    expect: {
      minCells: 6,
      maxCells: 6,
      allowedJournalStatuses: ['noop', 'durable'],
      allowedDiagnosticCodes: ['PTC-C001'],
      requiredDirectToolSequence: Array(6).fill('run_code'),
      editTransports: [
        {
          originalSource: completedSource,
          oldString: 'return adjustmentSource.length',
          newString: 'return `adjusted:${adjustmentSource.length}:${adjustmentSource.slice(-8)}`',
          repairedSource: adjustedSource,
          targetStatus: 'durable',
        },
        {
          originalSource: rejectedSource,
          oldString: 'return repairSource.length:',
          newString: 'return `${repairSource.length}:${repairSource.slice(-8)}`',
          repairedSource,
          targetStatus: 'noop',
        },
      ],
      completionIncludes: ['adjusted:11:ng-source', '11:ng-source'],
      finalAnswerIncludes: ['adjusted:11:ng-source', '11:ng-source'],
    },
  }
  const runtime = { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }
  assert.deepEqual(inspectLog(events, scenario, runtime).failures, [])

  const falsified = structuredClone(events)
  const secondEdit = falsified.find(event => event.type === 'tool/call' && event.data?.callId === 'repair')
  secondEdit.data.name = 'run_code'
  secondEdit.data.arguments = JSON.stringify({ code: repairedSource, description: 'Pretend model resend' })
  const failures = inspectLog(falsified, scenario, runtime).failures.join('\n')
  delete resultFor(falsified, 'repair').data.meta.dshPtcPlusPostEdit
  const missingEvidence = inspectLog(falsified, scenario, runtime).failures.join('\n')
  assert.match(missingEvidence, /root post-edit evidence/)
  assert.match(missingEvidence, /was not followed by edit_run_code/)
  assert.match(failures, /resent as a model-authored run_code/)

  const exposed = structuredClone(events)
  exposed.find(event => event.type === 'tool/result' && event.data?.message?.source?.callId === 'repair')
    .data.message.content = [{ type: 'text', text: JSON.stringify({ source: repairedSource }) }]
  assert.match(inspectLog(exposed, scenario, runtime).failures.join('\n'), /exposed materialized source/)
})

test('audits named runtime-context append, update, clearance, narration, and bounds', () => {
  const snapshot = (seq, sections) => ({
    type: 'user/message', seq,
    data: {
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections },
      content: [{ type: 'text', text: sections.map(section => section.text).join('\n') }],
    },
  })
  const rewrite = 'tools:ptc-plus-rewrite-info'
  const events = [
    snapshot(1, [{ name: 'sandbox:policy', text: 'policy' }]),
    { type: 'request/header', seq: 2 },
    snapshot(3, [{ name: 'sandbox:policy', text: 'policy' }, { name: rewrite, text: 'first rewrite' }]),
    { type: 'request/header', seq: 4 },
    snapshot(5, [{ name: 'sandbox:policy', text: 'policy' }, { name: rewrite, text: 'second rewrite' }]),
    { type: 'request/header', seq: 6 },
    snapshot(7, [{ name: 'sandbox:policy', text: 'policy' }]),
    { type: 'request/header', seq: 8 },
  ]
  const config = {
    allowed: [{ name: rewrite, maxChars: 32 }],
    requiredTransitions: [
      { name: rewrite, type: 'append' },
      { name: rewrite, type: 'update' },
      { name: rewrite, type: 'clear' },
    ],
    maxSnapshotChars: 64,
  }
  const audited = auditRuntimeContexts(events, config)
  assert.deepEqual(audited.failures, [])
  assert.deepEqual(audited.requests.map(request => request.sections.map(section => section.name)), [
    ['sandbox:policy'],
    ['sandbox:policy', rewrite],
    ['sandbox:policy', rewrite],
    ['sandbox:policy'],
  ])

  const invalid = auditRuntimeContexts([
    snapshot(1, [{ name: 'tools:ptc-plus-edit-feedback', text: 'The preceding edit_run_code changed the target.' }]),
    snapshot(2, [{ name: rewrite, text: 'x'.repeat(40) }]),
    snapshot(3, [{ name: rewrite, text: 'x'.repeat(40) }]),
  ], config).failures.join('\n')
  assert.match(invalid, /disallowed PTC Plus section/)
  assert.match(invalid, /narrates edit execution/)
  assert.match(invalid, /budget is 32/)
  assert.match(invalid, /repeats an unchanged aggregate/)
  assert.match(invalid, /never performed required clear/)

  assert.throws(() => validateRuntimeContextConfig({
    allowed: [],
    requiredTransitions: [{ name: rewrite, type: 'append' }],
    maxSnapshotChars: 64,
  }), /names unallowed context/)
  assert.throws(() => validateRuntimeContextConfig({
    allowed: [{ name: rewrite, maxChars: 32 }],
    requiredTransitions: [
      { name: rewrite, type: 'append' },
      { name: rewrite, type: 'append' },
    ],
    maxSnapshotChars: 64,
  }), /duplicate required runtime context transition/)
  assert.throws(() => validateRuntimeContextConfig({
    allowed: [], requiredTransitions: [], maxSnapshotChars: 64, typo: true,
  }), /unknown field typo/)
  assert.throws(() => validateRuntimeContextConfig(null), /must be an object/)
  assert.throws(() => validateRuntimeContextConfig({
    allowed: [{ name: rewrite, maxChars: 32, typo: true }],
    requiredTransitions: [], maxSnapshotChars: 64,
  }), /allowed entry contains unknown field typo/)
  assert.throws(() => validateRuntimeContextConfig({
    allowed: [{ name: rewrite, maxChars: 32 }],
    requiredTransitions: [{ name: rewrite, type: 'append', typo: true }],
    maxSnapshotChars: 64,
  }), /requiredTransitions entry contains unknown field typo/)
  assert.throws(() => validateRuntimeContextConfig({
    allowed: [], requiredTransitions: [], maxSnapshotChars: 0,
  }), /maxSnapshotChars must be a positive safe integer/)
})

test('rejects a replanned capability plan when the scenario forbids plan updates', async () => {
  const session = Session.create('managed-plan-update')
  const agent = { id: session.id, session }
  const planFrom = async (overrides, schemas) => {
    const env = createCapabilityEnvironment({ ctx: {}, config: { capabilityManagementEnabled: true,
      capabilityBaseline: '[]', capabilityOverrides: JSON.stringify(overrides), capabilityStatistics: '{"enabled":false}',
      capabilityBudgetBytes: 4096, capabilityDirectoryBytes: 4096 }, toolSchemasForAgent: () => schemas })
    await env.prepare(agent, [])
    const accepted = await env.preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
    return accepted.messages.find(message => message.source?.form === 'capability-plan')
  }
  const schema = name => ({ name, description: `Owner contract for ${name}.`, parameters: { type: 'object' }, output: { type: 'string' } })
  const frozen = await planFrom({}, [])
  const replanned = await planFrom({ 'tools.probe': 'full' }, [schema('probe')])
  assert.ok(frozen !== undefined && replanned !== undefined && frozen.content[0].text !== replanned.content[0].text)
  const events = [
    { type: 'session', id: session.id },
    { type: 'user/message', seq: 1, data: frozen },
    { type: 'request/header', seq: 2 },
    { type: 'user/message', seq: 3, data: replanned },
  ]
  const config = {
    allowed: [{ name: 'tools:ptc-plus-capability-plan', maxChars: 4096 }],
    requiredTransitions: [],
    forbiddenTransitions: [{ name: 'tools:ptc-plus-capability-plan', type: 'update' }],
    maxSnapshotChars: 4096,
  }
  assert.match(auditRuntimeContexts(events, config).failures.join('\n'),
    /tools:ptc-plus-capability-plan performed forbidden update/)
  assert.deepEqual(auditRuntimeContexts(events, { ...config, forbiddenTransitions: [] }).failures, [])
  assert.throws(() => validateRuntimeContextConfig({
    allowed: [], forbiddenTransitions: [{ name: 'tools:ptc-plus-capability-plan', type: 'update' }], maxSnapshotChars: 64,
  }), /forbiddenTransitions names unallowed context/)
  assert.throws(() => validateRuntimeContextConfig({
    allowed: [{ name: 'tools:ptc-plus-capability-plan', maxChars: 4096 }], requiredTransitions: [],
    forbiddenTransitions: [
      { name: 'tools:ptc-plus-capability-plan', type: 'update' },
      { name: 'tools:ptc-plus-capability-plan', type: 'update' },
    ],
    maxSnapshotChars: 64,
  }), /duplicate forbidden runtime context transition/)
})

test('compares canonical request headers without schema or system approximations', () => {
  const tool = (name, description = 'schema') => ({
    name,
    description,
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
  })
  const header = {
    config: { provider: 'provider', model: 'model' },
    adapterDefaults: {},
    system: 'stable system',
    tools: [tool('run_code'), tool('edit_run_code')],
  }
  const event = (seq, reason, value) => ({
    type: 'request/header', seq, data: { reason, header: value },
  })
  const stable = auditRequestHeaders([
    event(1, 'initial', header),
    event(3, 'resume', structuredClone(header)),
  ])
  assert.equal(stable.headerEpochs, 2)
  assert.equal(stable.headerChanges, 0)
  assert.deepEqual(stable.failures, [])
  assert.equal(Object.hasOwn(stable.headers[0].header, 'adapterDefaults'), false)

  const orderedFields = {
    ...structuredClone(header),
    config: { provider: 'provider', model: 'model', temperature: 0 },
    adapterDefaults: { reasoningEffort: true, maxTokens: true },
  }
  const reorderedFields = {
    tools: structuredClone(header.tools),
    system: header.system,
    adapterDefaults: { maxTokens: true, reasoningEffort: true },
    config: { temperature: 0, model: 'model', provider: 'provider' },
  }
  assert.deepEqual(auditRequestHeaders([
    event(1, 'initial', orderedFields), event(2, 'resume', reorderedFields),
  ]).failures, [])

  const systemDrift = structuredClone(header)
  systemDrift.system += '!'
  assert.match(auditRequestHeaders([
    event(1, 'initial', header), event(2, 'resume', systemDrift),
  ]).failures.join('\n'), /changed system/)

  const schemaDrift = structuredClone(header)
  schemaDrift.tools[0].parameters.properties.value.description = 'one byte!'
  assert.match(auditRequestHeaders([
    event(1, 'initial', header), event(2, 'change', schemaDrift),
  ]).failures.join('\n'), /tools\[0\]\.parameters\.properties\.value/)

  const schemaKeyReorder = structuredClone(header)
  schemaKeyReorder.tools[0].parameters = {
    properties: schemaKeyReorder.tools[0].parameters.properties,
    type: schemaKeyReorder.tools[0].parameters.type,
  }
  assert.match(auditRequestHeaders([
    event(1, 'initial', header), event(2, 'change', schemaKeyReorder),
  ]).failures.join('\n'), /tools\[0\]\.parameters keys\[0\].*capability/)

  const reordered = { ...structuredClone(header), tools: [...header.tools].reverse() }
  assert.match(auditRequestHeaders([
    event(1, 'initial', header), event(2, 'change', reordered),
  ]).failures.join('\n'), /tools\[0\]\.name/)
  assert.match(auditRequestHeaders([
    event(1, 'initial', header), event(2, 'change', structuredClone(header)),
  ]).failures.join('\n'), /reason change but its canonical header is unchanged/)
})

test('audits actual ordered system messages even when the request header stays unchanged', () => {
  const audit = events => auditSystemPrompts([{ type: 'session', version: 4 }, ...events])
  const events = []
  const append = (type, data, surfaceOp) => {
    events.push({ seq: events.length, time: events.length, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })
  }
  const message = text => createSystemMessage(text)
  append('step/start', { turn: 1, step: 1 })
  append('system/message', { message: message('stable') }, 'append')
  append('request/header', { reason: 'initial', header: { config: { provider: 'provider', model: 'model' } } })
  append('assistant/attempt', { turn: 1, step: 1 })
  const stable = audit(events)
  assert.deepEqual(stable.failures, [])
  assert.equal(stable.source, 'ordered-surface')
  assert.equal(stable.system, 'stable')
  assert.equal(stable.samples.length, 2)
  assert.deepEqual(auditRequestHeaders(events).failures, [])
  for (const version of [3, 4]) {
    for (const system of ['retired', '', null, { text: 'retired' }]) {
      const retired = structuredClone(events)
      retired[2].data.header.system = system
      const before = structuredClone(retired)
      assert.match(auditSystemPrompts([{ type: 'session', version }, ...retired])
        .failures.join('\n'), /must omit header.system/)
      assert.deepEqual(retired, before)
      const later = structuredClone(events)
      later.push({ seq: 4, time: 4, type: 'request/header', data: {
        reason: 'resume', header: { config: { provider: 'provider', model: 'model' }, system },
      } })
      assert.match(auditSystemPrompts([{ type: 'session', version }, ...later])
        .failures.join('\n'), /must omit header.system/)
    }
  }
  const blocks = structuredClone(events)
  blocks[1].data.message.content = [{ type: 'text', text: 'sta' }, { type: 'text', text: 'ble' }]
  assert.equal(audit(blocks).system, 'stable')
  for (const text of ['changed', 'stable']) {
    const next = structuredClone(events)
    next.push({ seq: 4, time: 4, type: 'system/message', data: { message: message(text) }, surfaceOp: 'append' })
    next.push({ seq: 5, time: 5, type: 'assistant/attempt', data: { turn: 1, step: 2 } })
    assert.match(audit(next).failures.join('\n'), /system prompt changed systemMessages.length/)
    assert.deepEqual(auditRequestHeaders(next).failures, [])
  }
  const declared = structuredClone(events)
  declared.push({ seq: 4, time: 4, type: 'system/message', data: { message: message('changed') }, surfaceOp: 'append' })
  declared.push({ seq: 5, time: 5, type: 'assistant/attempt', data: { turn: 1, step: 2 } })
  const permitted = auditSystemPrompts([{ type: 'session', version: 4 }, ...declared], { allowedChanges: 1 })
  assert.deepEqual(permitted.failures, [])
  assert.deepEqual(permitted.changes.map(change => change.seq), [5])
  assert.match(auditSystemPrompts([{ type: 'session', version: 4 }, ...declared], { allowedChanges: 2 })
    .failures.join('\n'), /system prompt changes are 1; scenario policy requires 2/)
  assert.throws(() => auditSystemPrompts([{ type: 'session', version: 4 }, ...declared], { allowedChanges: -1 }),
    /allowedChanges must be a non-negative safe integer/)
  for (const text of ['stable', 'changed']) {
    const next = structuredClone(events)
    next.push({ seq: 4, time: 4, type: 'system/message', data: { message: message(text) },
      sourceEventSeqs: [1], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } })
    next.push({ seq: 5, time: 5, type: 'assistant/attempt', data: { turn: 1, step: 2 } })
    const result = audit(next)
    if (text === 'stable') assert.deepEqual(result.failures, [])
    else assert.match(result.failures.join('\n'), /system prompt changed systemMessages\[0\]/)
  }
  const resegmented = structuredClone(events)
  const fresh = message('stable')
  assert.notEqual(fresh.id, events[1].data.message.id)
  resegmented.push({ seq: 4, time: 4, type: 'system/message', data: { message: {
    ...fresh, source: { kind: 'system-prompt' },
    content: [{ type: 'text', text: 'sta' }, { type: 'text', text: 'ble' }],
  } }, sourceEventSeqs: [1], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } })
  resegmented.push({ seq: 5, time: 5, type: 'assistant/attempt', data: { turn: 1, step: 2 } })
  assert.deepEqual(audit(resegmented).failures, [])
  const hidden = structuredClone(events)
  delete hidden[1].surfaceOp
  assert.match(audit(hidden).failures.join('\n'), /requires a surfaceOp marker/)
  const late = structuredClone(events)
  late[1].type = 'user/message'
  late[1].data = { role: 'user', content: [{ type: 'text', text: 'first user' }], source: { kind: 'user' } }
  late.splice(2, 0, { seq: 0, time: 0, type: 'system/message', data: { message: message('late system') }, surfaceOp: 'append' })
  late.forEach((event, seq) => { event.seq = seq })
  assert.match(audit(late).failures.join('\n'), /no leading system message/)
  const projection = structuredClone(events)
  projection.splice(3, 0, { seq: 0, time: 0, type: 'image/offload', data: {} })
  projection.forEach((event, seq) => { event.seq = seq })
  assert.match(audit(projection).failures.join('\n'), /image\/offload: data/)
  const malformed = structuredClone(events)
  malformed[1].data.message.content[0] = { type: 'image', url: 'not-system-text' }
  assert.match(audit(malformed).failures.join('\n'), /invalid|complete text evidence/)
  assert.match(audit([]).failures.join('\n'), /no model-visible system prompt evidence/)
  assert.throws(() => auditSystemPrompts(null), /must be an array/)
  assert.equal(auditSystemPrompts([{ type: 'session', version: 2 },
    { type: 'request/header', data: { header: { system: 'old' } } }]).system, 'old')
  for (const version of [undefined, null, 0, -1, 1.5, '4', 1000]) {
    assert.match(auditSystemPrompts([{ type: 'session', version }, ...events]).failures.join('\n'), /supported session format/)
  }
  assert.match(auditSystemPrompts([{ type: 'session', version: 2 }, ...events]).failures.join('\n'), /historical session format/)
  assert.match(auditSystemPrompts(events).failures.join('\n'), /supported session format/)
  assert.match(auditSystemPrompts([{ type: 'session', version: 4 }, { type: 'session', version: 4 }, ...events])
    .failures.join('\n'), /supported session format/)
  for (const version of [3, 4]) {
    assert.match(auditSystemPrompts([{ type: 'session', version },
      { seq: 0, type: 'request/header', data: { header: { config: {}, system: 'retired' } } },
      { seq: 1, type: 'assistant/attempt', data: {} },
    ]).failures.join('\n'), /no leading system message|must omit header.system/)
  }
})

test('acceptance consumes current system-message evidence instead of historical header fields', () => {
  const events = acceptanceEvents()
  events[0].version = 4
  const header = events.find(event => event.type === 'request/header').data.header
  const system = header.system
  delete header.system
  events.splice(1, 0, { type: 'system/message', data: { message: {
    role: 'system', content: [{ type: 'text', text: system }],
  } }, surfaceOp: 'append' })
  let seq = 0
  for (const event of events) if (event.type !== 'session') {
    event.seq = seq
    event.time = seq++
    if (['user/message', 'tool/result', 'assistant/message'].includes(event.type)) {
      event.surfaceOp = 'append'
      const message = event.type === 'user/message' ? event.data : event.data.message
      message.role = event.type === 'user/message' ? 'user' : event.type === 'tool/result' ? 'tool' : 'assistant'
    }
  }
  const result = inspectLog(events, { id: 'current-system-message', expect: {} }, {
    provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace',
  })
  assert.deepEqual(result.failures, [])
  assert.equal(result.prompt.systemEvidence.source, 'ordered-surface')
  assert.equal(result.prompt.systemEvidence.system, system)
  const projected = structuredClone(events)
  const headerIndex = projected.findIndex(event => event.type === 'request/header')
  projected.splice(headerIndex, 0, { type: 'user/message', data: createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }, { type: 'image',
      attachment: { attachmentId: 'projection-proof', mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
    }],
  }), surfaceOp: 'append' }, { type: 'image/offload', data: { targets: [{ seq: headerIndex - 1, imageIndexes: [0] }] } })
  projected.slice(1).forEach((event, seq) => { event.seq = seq; event.time = seq })
  assert.deepEqual(inspectLog(projected, { id: 'owned-image-projection', expect: {} }, {
    provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace',
  }).failures, [])
  const systemSeq = projected.find(event => event.type === 'system/message').seq
  projected.splice(projected.findIndex(event => event.type === 'request/header'), 0, {
    type: 'system/message', data: { message: createSystemMessage(system) },
    surfaceOp: { op: 'replace', startSeq: systemSeq, endSeq: systemSeq },
    sourceEventSeqs: [systemSeq],
  })
  projected.slice(1).forEach((event, seq) => { event.seq = seq; event.time = seq })
  assert.deepEqual(auditRuntimeContexts(projected).failures, [])
  assert.deepEqual(inspectLog(projected, {
    id: 'owned-image-projection-replacement', expect: { headerPolicy: { historyReplacements: 1 } },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' }).failures, [])
  const damagedProjection = structuredClone(projected)
  damagedProjection.find(event => event.type === 'image/offload').data.targets[0].imageIndexes = [99]
  assert.match(auditRuntimeContexts(damagedProjection).failures.join('\n'), /cannot verify runtime context surface/)
  for (const version of [3, 4]) {
    for (const retired of ['retired', '', null, {}]) {
      const invalid = structuredClone(events)
      invalid[0].version = version
      invalid.find(event => event.type === 'request/header').data.header.system = retired
      assert.match(inspectLog(invalid, { id: 'retired-header', expect: {} }, {
        provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace',
      }).failures.join('\n'), /must omit header.system/)
    }
  }
})

test('requires exact scenario policy for route, configuration, and capability transitions', () => {
  const base = {
    config: { provider: 'provider', model: 'model', maxTokens: 100 },
    system: 'system',
    tools: [{ name: 'run_code', parameters: { type: 'object' } }],
  }
  const changed = {
    config: { provider: 'next', model: 'next-model', maxTokens: 200 },
    system: 'changed system',
    tools: [...base.tools, { name: 'edit_run_code', parameters: { type: 'object' } }],
  }
  const events = [
    { type: 'request/header', data: { reason: 'initial', header: base } },
    { type: 'request/header', data: { reason: 'resume', header: changed } },
  ]
  const policy = { allowedTransitions: [
    { epoch: 2, condition: 'route' },
    { epoch: 2, condition: 'configuration' },
    { epoch: 2, condition: 'capability' },
  ] }
  assert.deepEqual(auditRequestHeaders(events, policy).failures, [])
  assert.match(auditRequestHeaders(events, {
    allowedTransitions: [{ epoch: 2, condition: 'route' }],
  }).failures.join('\n'), /without an exact scenario policy/)
  assert.throws(() => validateRequestHeaderPolicy({ allowedTransitions: [
    { epoch: 1, condition: 'route' },
  ] }), /epoch >= 2/)
  assert.throws(() => validateRequestHeaderPolicy({ allowedTransitions: [
    { epoch: 2, condition: 'replacement' },
  ] }), /known condition/)
  const replaced = [...events, { type: 'user/message', surfaceOp: { op: 'replace', start: 1, end: 2 } }]
  assert.match(auditRequestHeaders(replaced, policy).failures.join('\n'), /history replacements are 1/)
  assert.deepEqual(auditRequestHeaders(replaced, { ...policy, historyReplacements: 1 }).failures, [])
})

test('separates logical model requests from header epochs and retry evidence', () => {
  const header = { config: { provider: 'provider', model: 'model' } }
  const events = [
    { type: 'request/header', data: { reason: 'initial', header } },
    { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: {} },
    { type: 'assistant/message', data: { usage: { inputTokens: 10 } } },
    { type: 'step/start', seq: 5, data: { turn: 1, step: 2 } },
  ]
  assert.equal(auditModelRequests(events).modelRequests, 2)
  assert.equal(auditRequestHeaders(events).headerEpochs, 1)

  const resumed = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'request/header', data: { reason: 'initial', header } },
    { type: 'request/header', data: { reason: 'resume', header: { ...header, system: '' } } },
  ]
  assert.equal(auditModelRequests(resumed).modelRequests, 1)
  assert.equal(auditRequestHeaders(resumed).headerEpochs, 2)
  assert.deepEqual(auditRequestHeaders(resumed).failures, [])

  const invalid = auditRequestHeaders([
    { type: 'request/header', data: { reason: 'initial', header: null } },
    { type: 'request/header', data: { reason: 'change', header } },
  ])
  assert.equal(invalid.headerEpochs, 2)
  assert.equal(invalid.headerChanges, 1)
  assert.match(invalid.failures.join('\n'), /epoch 1 is invalid/)
})

test('expensive acceptance retains unknown usage instead of a zero-cost budget pass', () => {
  const events = acceptanceEvents()
  delete events.find(event => event.type === 'assistant/message').data.usage
  const report = inspectLog(events, { id: 'missing-usage', expect: { machineBudget: {
    maxModelRequests: 10, maxDirectCalls: 10, maxSourceChars: 10000,
    maxRepeatedSourceCalls: 10, maxResultChars: 10000, maxAssistantChars: 10000,
    maxTokenTraffic: 1, maxRuntimeContextChars: 10000,
  } } }, { provider: 'provider', model: 'model' })
  assert.equal(report.usageComplete, false)
  assert.equal(report.machineMetrics.tokenTraffic, null)
  assert.match(report.failures.join('\n'), /usage accounting is incomplete/)
})

test('turns every machine budget dimension into a failure boundary', () => {
  const budget = {
    maxModelRequests: 1,
    maxDirectCalls: 1,
    maxSourceChars: 1,
    maxRepeatedSourceCalls: 0,
    maxResultChars: 1,
    maxAssistantChars: 1,
    maxTokenTraffic: 1,
    maxRuntimeContextChars: 1,
  }
  const metrics = {
    modelRequests: 2,
    directCalls: 2,
    sourceChars: 2,
    repeatedSourceCalls: 1,
    resultChars: 2,
    assistantChars: 2,
    tokenTraffic: 2,
    runtimeContextChars: 2,
  }
  assert.equal(machineBudgetFailures(metrics, budget).length, 8)
})

test('derives the five ADR-owned default workflows from scenario descriptors', async () => {
  const descriptors = JSON.parse(await readFile(new URL('../scripts/expensive-acceptance-scenarios.json', import.meta.url)))
  assert.deepEqual(selectScenarioDescriptors(descriptors).map(item => item.id), [
    'rejected-cell-editing',
    'durable-repl-continuity',
    'durable-program-surface',
    'volatile-node-continuity',
    'static-import-conversion',
  ])
  assert.deepEqual(selectScenarioDescriptors(descriptors, ['partial-redefinition-split']).map(item => item.id), [
    'partial-redefinition-split',
  ])
  assert.deepEqual(selectScenarioDescriptors(descriptors, ['function-class-redeclaration-iteration']).map(item => item.id), [
    'function-class-redeclaration-iteration',
  ])
  assert.deepEqual(selectScenarioDescriptors(descriptors, [
    'managed-adaptive-surface', 'managed-session-resume', 'managed-surface-change', 'subagent-continuity',
  ]).map(item => item.id), [
    'managed-adaptive-surface', 'managed-session-resume', 'managed-surface-change', 'subagent-continuity',
  ])
  assert.throws(() => selectScenarioDescriptors(descriptors, ['missing']), /unknown acceptance scenario/)
  for (const programWork of [
    { unknown: true }, { inspectionSymbols: [] }, { inspectionSymbols: ['tools.read', 'tools.read'] },
    { callLimits: [{ global: 'tools', member: 'read', maxCalls: -1 }] },
    { callLimits: [{ global: 'tools', member: 'read', maxCalls: 2, maxCallsPerArguments: 0 }] },
  ]) {
    assert.throws(() => selectScenarioDescriptors([{
      ...descriptors[0], expect: { ...descriptors[0].expect, programWork },
    }], [descriptors[0].id]), /programWork/)
  }
  for (const guardMismatchEdits of [[0], [1, 1], ['1']]) {
    assert.throws(() => selectScenarioDescriptors([{
      ...descriptors[0], expect: { ...descriptors[0].expect, guardMismatchEdits },
    }], [descriptors[0].id]), /guardMismatchEdits/)
  }
  assert.throws(() => validateEditTransports([{
    originalSource: 'return 1',
    oldString: '1',
    newString: '2',
    repairedSource: 'not the declared edit',
  }]), /repairedSource does not equal the declared edit/)
})
