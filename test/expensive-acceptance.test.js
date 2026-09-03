import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
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
  auditModelRequests,
  auditRequestHeaders,
  auditRuntimeContexts,
  machineBudgetFailures,
  validateEditTransports,
  validateRuntimeContextConfig,
  validateRequestHeaderPolicy,
} from '../scripts/acceptance-contract.mjs'
import { encodeValue } from '../internal/value-wire.js'

const headlessRuntime = { toolsMode: 'code', permissionMode: 'danger-full-access' }

function journal({ calls = [], completion, diagnostics = [], status = 'durable' } = {}) {
  return {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    status,
    calls: calls.map((call, settle) => ({
      global: call.global,
      member: call.member,
      args: encodeValue(call.args ?? {}),
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
    'You are a coding agent powered by the model model. Your working directory is X:\\fixture\\workspace.',
    'declare const tools: {}',
    'declare const capabilities: {}',
  ].join('\n')
  return [
    { type: 'session', cwd: 'X:\\fixture\\workspace', id: 'session-test' },
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
          tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
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
    persona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
- id: ptc-plus
  name: dsh-ptc-plus
- id: tools
  config:
    mode: code
- id: sandbox-policy
  config:
    mode: danger-full-access
- id: approval
  config:
    policy: never
`)
  assert.equal(validateAcceptanceConfig(rows, headlessRuntime), true)
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
  changed.tools[1].parameters = { type: 'object', properties: { extra: { type: 'boolean' } } }
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
  assert.match(report.failures.join('\n'), /changed tools\[1\]/)
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

test('rejects continuity that returns the established binding from its declaration cell', () => {
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

  const missingSource = inspectLog(events, {
    id: 'missing-source-sequence', title: 'Missing source sequence', task: 'task',
    expect: { requiredSourceSequence: ['not present'] },
  }, { provider: 'provider', model: 'model', cwd: 'X:\\fixture\\workspace' })
  assert.match(missingSource.failures.join('\n'), /required source fragment is missing/)
})

test('requires truthful edits for completed and rejected cells while keeping materialized source private', () => {
  const completedSource = 'const adjustmentSource = "long-source"\nreturn adjustmentSource.length'
  const adjustedSource = 'const adjustmentSource = "long-source"\nreturn `adjusted:${adjustmentSource.length}:${adjustmentSource.slice(-8)}`'
  const rejectedSource = 'const repairSource = "long-source"\nreturn repairSource.length:'
  const repairedSource = 'const repairSource = "long-source"\nreturn `${repairSource.length}:${repairSource.slice(-8)}`'
  const events = acceptanceEvents().slice(0, 3)
  events.push(
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
  const scenario = {
    id: 'edit-transport', title: 'Edit transport', task: 'task',
    expect: {
      minCells: 4,
      maxCells: 4,
      allowedJournalStatuses: ['noop', 'durable'],
      allowedDiagnosticCodes: ['PTC-C001'],
      requiredDirectToolSequence: ['run_code', 'edit_run_code', 'run_code', 'edit_run_code'],
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
  assert.match(failures, /direct tool sequence/)
  assert.match(failures, /was not followed by edit_run_code/)
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
  assert.throws(() => selectScenarioDescriptors(descriptors, ['missing']), /unknown acceptance scenario/)
  assert.throws(() => validateEditTransports([{
    originalSource: 'return 1',
    oldString: '1',
    newString: '2',
    repairedSource: 'not the declared edit',
  }]), /repairedSource does not equal the declared edit/)
})
