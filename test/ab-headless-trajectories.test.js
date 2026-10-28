import assert from 'node:assert/strict'
import { createFixtureSessionServices } from './host-fixture.js'
import { ptcPresentation, ptcPresentationRows } from '../scripts/dsh-host-contract.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSystemMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { decodeValue, encodeValue } from '../internal/value-wire.js'
import { fileURLToPath } from 'node:url'
import {
  analyzeSession,
  assertTrajectoryInvariants,
  abRunPaths,
  armScratchPaths,
  copyWorkspace,
  createBlindPacket,
  computeMetrics,
  hashFixtureTree,
  initialInjections,
  materializeFixture,
  parseConfigDump,
  readFixtureManifest,
  taskOracle,
  validateTask,
  validateConfigPair,
} from '../scripts/ab-headless-trajectories.mjs'
import { orderCanaryFirst, runCanaryThenConcurrent } from '../scripts/acceptance-orchestration.mjs'
import { collectTrajectoryFacts, machineBudgetFailures, MACHINE_BUDGET_KEYS, pendingBlindApproval } from '../scripts/acceptance-contract.mjs'
import { aggregateTrajectories, trajectoryDelta } from '../scripts/ab-trajectory-report.mjs'
import { cleanupOwnedPath } from '../scripts/headless-host.mjs'
import { apply as observeToolResults, readEvaluationToolResults } from '../scripts/evaluation-tool-results.mjs'
import { Session } from '@deepseek-ai/dsh-session'
import { capabilityConfiguration, createCapabilityEnvironment } from '../internal/capability-environment.js'

const persona = 'You are a coding agent powered by the {{model}} model.'
const runtime = { toolsMode: 'ptc', permissionMode: 'danger-full-access' }

test('permits only validated enabled capability plans matching the resolved A/B treatment', async () => {
  const session = Session.create('capability-ab-treatment')
  const services = createFixtureSessionServices()
  services.remember(session)
  const env = createCapabilityEnvironment({ ctx: { sessionQuery: services.sessionQuery }, config: { capabilityManagementEnabled: true,
    capabilityBaseline: '[]', capabilityOverrides: '{}', capabilityStatistics: '{"enabled":false}' },
    toolSchemasForAgent: () => [] })
  const agent = { id: session.id, session }
  await env.prepare(agent, [])
  assert.deepEqual(initialInjections([{ type: 'session', id: session.id }, ...session.snapshotEvents()], 'workspace'), [])
  const accepted = await env.preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Fixture system prompt.' }] }) },
    { surfaceOp: 'append' })
  for (const message of accepted.messages) session.append('user/message', message, { surfaceOp: 'append' })
  const plan = session.snapshotEvents().find(event => event.data?.source?.form === 'capability-plan')
  const events = [{ type: 'session', id: session.id }, plan, { type: 'request/header', seq: 2 }]
  const injections = initialInjections(events, 'workspace')
  assert.equal(injections[0].treatment, 'capability-environment')
  assert.equal(injections[0].bytes, Buffer.byteLength(injections[0].text))
  const audits = { headerAudit: { failures: [], headers: [] }, systemAudit: { failures: [], system: '' },
    contextAudit: { failures: [] }, injections,
    facts: { failures: [], calls: new Map(), results: new Map(), finalAnswer: 'done', timeline: [], finalTurn: { data: { reason: { kind: 'completed' } } } } }
  const settings = events[1].data.source.snapshot.settings
  const expected = { variant: 'plugin', capabilityManagementEnabled: true, capabilitySettings: settings, model: 'model', cwd: 'workspace' }
  const relevant = options => assertTrajectoryInvariants(events, options, audits).failures.filter(failure => /initial context|initial capability/.test(failure))
  assert.deepEqual(relevant(expected), [])
  for (const patch of [{ manual: { baseline: ['tools.probe'], overrides: {} } },
    { manual: { baseline: [], overrides: { 'tools.probe': 'closed' } } },
    { statistics: { enabled: false, windowSize: 20 } }, { budgetBytes: 100 },
    { directoryBudgetBytes: 512 }, { recoveryBytes: 100 }, { previewTokens: 100 }]) {
    assert.match(relevant({ ...expected, capabilitySettings: { ...settings, ...patch } }).join('\n'), /settings do not match/)
  }
  assert.match(relevant({ ...expected, capabilityManagementEnabled: false }).join('\n'), /resolved capability management/)
  assert.match(relevant({ ...expected, variant: 'baseline' }).join('\n'), /resolved capability management/)
  const forged = structuredClone(events)
  forged[1].data.content[0].text += 'unapproved context'
  assert.equal(initialInjections(forged, 'workspace')[0].treatment, undefined)
  const plugin = rows(false)
  const baseline = rows(true)
  plugin.find(row => row.id === 'ptc-plus').config = { capabilityManagementEnabled: true }
  baseline.find(row => row.id === 'ptc-plus').config = { capabilityManagementEnabled: true }
  const pair = validateConfigPair(plugin, baseline, runtime)
  assert.equal(pair.capabilityManagementEnabled, true)
  assert.deepEqual(pair.capabilitySettings.manual, { baseline: [], overrides: {} })
  assert.equal(pair.capabilitySettings.statistics.windowSize, 100)
  assert.equal(validateConfigPair(rows(false), rows(true), runtime).capabilityManagementEnabled, false)
})

test('separates opaque arm scratch trees from evaluator artifacts', () => {
  const scratchRoot = join(tmpdir(), 'ptc-ab-scratch')
  const scratch = armScratchPaths(scratchRoot, 'opaque-123')
  assert.equal(scratch.directory, join(scratchRoot, 'runs', 'opaque-123'))
  assert.equal(scratch.workspace, join(scratchRoot, 'runs', 'opaque-123', 'workspace'))
  assert.equal(JSON.stringify(scratch).includes('plugin'), false)
  assert.equal(JSON.stringify(scratch).includes('baseline'), false)
  assert.throws(() => armScratchPaths(scratchRoot, '../plugin'), /arm scratch nonce/)
})

test('retains child canonical observations after execution scratch cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-ab-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const paths = abRunPaths(join(directory, 'repository'), 'run')
  await mkdir(paths.scratchRoot, { recursive: true })
  await writeFile(join(paths.scratchRoot, 'execution.tmp'), 'temporary workspace')
  let listener
  observeToolResults({ on(_event, callback) { listener = callback; return () => {} } },
    { directory: paths.canonicalResultDirectory })
  listener({ name: 'run_code', callId: 'child-call', rootCallId: 'child-call',
    agent: { session: { id: 'child-session' } }, arguments: { code: 'return "child-value"' } },
  { isError: false, value: { logs: [], result: 'child-value' } })
  await cleanupOwnedPath(paths.scratchRoot)
  await assert.rejects(readFile(join(paths.scratchRoot, 'execution.tmp')), { code: 'ENOENT' })
  const evidence = await readEvaluationToolResults(paths.canonicalResultDirectory, 'child-session')
  assert.equal(evidence.status, 'complete')
  assert.equal(evidence.records[0].value, 'child-value')
})

test('redacts workspace identity from every blind packet text field', () => {
  const cwd = 'X:\\scratch-root\\runs\\opaque-123\\workspace'
  const packet = createBlindPacket('task-r1-arm-1', 'task', {
    session: { cwd },
    timeline: [{
      description: `Inspect ${cwd}`,
      code: `return ${JSON.stringify(cwd)}`,
      resultError: false,
      outputChars: 1,
      output: JSON.stringify({ cwd }),
    }],
    finalAnswer: `Used ${cwd.replaceAll('\\', '/')}`,
    toolCallCount: 1,
    sourceChars: 1,
    resultOutputChars: 1,
    assistantTextChars: 1,
  })
  const serialized = JSON.stringify(packet)
  assert.equal(serialized.includes('scratch-root'), false)
  assert.equal(serialized.includes('opaque-123'), false)
  assert.equal(serialized.match(/<WORKSPACE>/g)?.length, 4)
})

test('keeps reasoning outside answer metrics and blind packets', () => {
  const facts = collectTrajectoryFacts([
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Earlier prose' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'Synthetic private text.' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ])
  const metrics = computeMetrics(facts, { modelRequestAudit: { modelRequests: 2 }, contextAudit: { totalMessageChars: 0 } })
  assert.equal(metrics.finalAnswer, '')
  assert.equal(metrics.machineMetrics.assistantChars, 'Earlier prose\n'.length)
  const packet = createBlindPacket('answer', 'task', {
    session: { cwd: 'X:\\workspace' }, timeline: [], finalAnswer: metrics.finalAnswer,
  })
  assert.equal(packet.finalAnswer, '')
  assert.equal(JSON.stringify(packet).includes('Synthetic private text'), false)
})

test('freezes only repository source and explicit execution prerequisites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-ab-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  for (const directory of [
    source, join(source, '.git'), join(source, 'node_modules', 'dependency'),
    join(source, 'src'), join(source, 'coverage'), join(source, 'artifacts'),
  ]) await mkdir(directory, { recursive: true })
  const files = {
    'tracked.txt': 'tracked change',
    'src/new.js': 'untracked source',
    '.git/HEAD': 'ref: refs/heads/main',
    'node_modules/dependency/index.js': 'export default 1',
    'coverage/index.html': 'generated coverage',
    'artifacts/result.json': '{}',
    'history.log': 'stale run',
    'REVIEW_FINDINGS.md': 'local ledger',
  }
  for (const [path, value] of Object.entries(files)) {
    await writeFile(join(source, path), value)
  }
  const calls = []
  await copyWorkspace(source, destination, {
    async runProcess(...args) {
      calls.push(args)
      return { code: 0, stdout: 'tracked.txt\0src/new.js\0', stderr: '' }
    },
  })
  assert.deepEqual(calls, [[
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: source, timeoutMs: 30_000 },
  ]])
  for (const path of [
    'tracked.txt', 'src/new.js', '.git/HEAD', 'node_modules/dependency/index.js',
  ]) assert.equal(await readFile(join(destination, path), 'utf8'), files[path])
  for (const path of [
    'coverage/index.html', 'artifacts/result.json', 'history.log', 'REVIEW_FINDINGS.md',
  ]) await assert.rejects(readFile(join(destination, path), 'utf8'), { code: 'ENOENT' })

  await assert.rejects(copyWorkspace(source, join(root, 'failed'), {
    async runProcess() { return { code: 1, stdout: '', stderr: 'not a repository' } },
  }), /cannot enumerate A\/B workspace source files: not a repository/)
})

test('incomplete token accounting cannot establish a passing budget or usage delta', () => {
  const zero = { inputTokens: 0, outputTokens: 0 }
  const message = usage => ({ type: 'assistant/message', data: { usage, message: { content: [] } } })
  const audits = { modelRequestAudit: { modelRequests: 1 }, contextAudit: { totalMessageChars: 0 } }
  const budget = Object.fromEntries(MACHINE_BUDGET_KEYS.map(key => [key, 1000]))
  for (const events of [
    [message(undefined)],
    [message({ inputTokens: 3 })],
    [message({ inputTokens: -1, outputTokens: 0 })],
    [message(zero), message(undefined)],
    [{ type: 'assistant/attempt', data: { stream: [] } }, message(zero)],
  ]) {
    const facts = collectTrajectoryFacts(events, { compareUsageChunks: false })
    assert.equal(facts.usageComplete, false)
    const { machineMetrics } = computeMetrics(facts, audits)
    assert.equal(machineMetrics.tokenTraffic, null)
    assert.match(machineBudgetFailures(machineMetrics, budget).join('\n'), /accounting is incomplete/)
    const session = { variant: 'plugin', usage: facts.usage, usageComplete: false,
      failures: [], uncertaintySignals: [], prompt: {} }
    assert.equal(aggregateTrajectories([session], 'plugin').totalTraffic, null)
    assert.equal(trajectoryDelta(session, { ...session, usageComplete: true }).inputTokens, null)
  }
  const facts = collectTrajectoryFacts([message(zero)], { compareUsageChunks: false })
  assert.equal(facts.usageComplete, true)
  assert.equal(computeMetrics(facts, audits).machineMetrics.tokenTraffic, 0)
  assert.deepEqual(machineBudgetFailures(computeMetrics(facts, audits).machineMetrics, budget), [])
})

test('incomplete subprocesses cannot establish task oracles', async () => {
  for (const result of [
    { code: 0, timedOut: true }, { code: 1, termination: 'unconfirmed' },
    { code: 1, signal: 'SIGTERM' }, { code: null },
  ]) {
    for (const validator of ['test-gate', 'git-status']) {
      await assert.rejects(taskOracle({ id: 'incomplete', validator }, '.', {
        runProcess: async () => ({ stdout: '', stderr: '', ...result }),
      }), /subprocess did not complete/)
    }
    await assert.rejects(validateTask({ id: 'incomplete', validator: 'test-gate' },
      { ...result, exitCode: result.code }, { timeline: [] }), /subprocess did not complete/)
  }
})

test('runs the test-gate oracle through the invoking npm CLI', async () => {
  const calls = []
  const oracle = await taskOracle(
    { id: 'test-check', validator: 'test-gate' },
    'X:\\fixture\\workspace',
    {
      npm: {
        platform: 'win32',
        execPath: 'X:\\fixture\\runtime\\node.exe',
        npmExecPath: 'X:\\fixture\\runtime\\npm-cli.js',
      },
      async runProcess(...args) {
        calls.push(args)
        return { code: 0, stdout: 'passed', stderr: '' }
      },
    },
  )
  assert.deepEqual(calls, [[
    'X:\\fixture\\runtime\\node.exe',
    ['X:\\fixture\\runtime\\npm-cli.js', 'run', 'check'],
    { cwd: 'X:\\fixture\\workspace', timeoutMs: 10 * 60_000 },
  ]])
  assert.deepEqual(oracle, {
    command: 'npm run check',
    exitCode: 0,
    stdoutTail: 'passed',
    stderrTail: '',
  })

  await assert.rejects(
    taskOracle(
      { id: 'test-check', validator: 'test-gate' },
      'X:\\fixture\\workspace',
      { async runProcess() { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }) } },
    ),
    /spawn EINVAL/,
  )
})

function rows(ptcDisabled, customIdentity = true) {
  return [
    { id: 'agent-instructions', disabled: true },
    { id: 'skill', disabled: true },
    { id: 'skill-filesystem', disabled: true },
    { id: 'tool-skill', disabled: true },
    { id: 'session-title-llm', disabled: true },
    {
      id: 'system-prompt',
      config: {
        includeHarnessIdentity: false,
        includeRuntimeContext: true,
        persona,
      },
    },
    { id: 'ptc-plus', name: 'dsh-ptc-plus', ...(ptcDisabled ? { disabled: true } : {}) },
    ...(customIdentity ? [{ id: 'custom-harness-identity', disabled: true }] : []),
    ...ptcPresentationRows(ptcPresentation()),
    { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
    { id: 'approval', config: { policy: 'never' } },
  ]
}

test('parses commented DSH dumps and preserves unevaluated JavaScript expressions', () => {
  const parsed = parseConfigDump(`
# source layer
- id: sandbox
  disabled: !!js process.platform === 'win32'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE
`)
  assert.deepEqual(parsed, [{
    id: 'sandbox',
    disabled: { expression: "process.platform === 'win32'" },
    config: { mode: { expression: 'process.env.DSH_PERMISSION_MODE' } },
  }])
  assert.throws(() => parseConfigDump('- id: duplicate\n- id: duplicate\n'), /duplicate plugin ids/)
  assert.throws(() => parseConfigDump('not: an array\n'), /array of plugin rows/)
  assert.throws(() => parseConfigDump('- id: [\n'), /invalid YAML/)
})

test('accepts an A/B config pair whose only treatment is ptc-plus.disabled', () => {
  const plugin = rows(false)
  const baseline = rows(true)
  const result = validateConfigPair(plugin, baseline, runtime)
  assert.equal(result.onlyDifference, 'ptc-plus.disabled')
  assert.equal(result.pluginSha256.length, 64)
  assert.equal(result.baselineSha256.length, 64)
  assert.doesNotThrow(() => validateConfigPair(rows(false, false), rows(true, false), runtime))
  for (const profile of [plugin, baseline]) {
    const toolsRow = profile.find(row => row.id === 'tools') ?? { id: 'tools' }
    if (!profile.includes(toolsRow)) profile.push(toolsRow)
    toolsRow.config = { ...toolsRow.config, mode: 'unsupported-test-mode' }
  }
  assert.throws(() => validateConfigPair(plugin, baseline, { ...runtime, toolsMode: 'unsupported-test-mode' }), /public DSH tools config/)
})

test('rejects missing isolation, fake headless rows, and any second treatment', () => {
  const baseline = rows(true)
  const enabledInstructions = rows(false)
  enabledInstructions.find(row => row.id === 'agent-instructions').disabled = false
  assert.throws(() => validateConfigPair(enabledInstructions, baseline, runtime), /does not disable agent-instructions/)

  const fakeSpine = rows(false)
  fakeSpine.push({ id: 'agent-spine', config: { workspaceContext: false } })
  assert.throws(() => validateConfigPair(fakeSpine, baseline, runtime), /unexpectedly contains agent-spine/)

  const customIdentity = rows(false)
  customIdentity.find(row => row.id === 'custom-harness-identity').disabled = false
  assert.throws(() => validateConfigPair(customIdentity, baseline, runtime), /does not disable custom-harness-identity/)

  const wrongPersona = rows(false)
  wrongPersona.find(row => row.id === 'system-prompt').config.persona = 'task-specific prior'
  assert.throws(() => validateConfigPair(wrongPersona, baseline, runtime), /neutral system-prompt contract/)

  const secondTreatment = rows(true)
  secondTreatment.find(row => row.id === 'sandbox-policy').config.extra = true
  assert.throws(() => validateConfigPair(rows(false), secondTreatment, runtime), /differ outside ptc-plus.disabled/)

  assert.throws(() => validateConfigPair(rows(true), baseline, runtime), /plugin config disables ptc-plus/)
  assert.throws(() => validateConfigPair(rows(false), rows(false), runtime), /baseline config does not disable ptc-plus/)

  const nativeTools = rows(false)
  const presentation = ptcPresentation()
  if (presentation.kind === 'registry') {
    nativeTools.find(row => row.id === 'tools').config.mode = 'native'
  } else {
    // An executor host selects presentation by composition row, so the same
    // mistake is selecting the native executor instead of the PTC one.
    nativeTools.find(row => row.id === 'tool-executor-native').disabled = false
  }
  assert.throws(() => validateConfigPair(nativeTools, baseline, runtime),
    new RegExp(presentation.kind === 'registry' ? 'does not use tools mode' : 'does not disable tool-executor-native'))
})

test('compares only injections visible before the first model request', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'runtime', form: 'snapshot' }, content: [{ type: 'text', text: 'initial' }] } },
    { seq: 3, type: 'request/header', data: { header: {} } },
    { seq: 4, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'jobs', form: 'notice' }, content: [{ type: 'text', text: 'later' }] } },
  ]
  assert.deepEqual(initialInjections(events, 'X:\\fixture\\workspace').map(item => ({ seq: item.seq, source: item.source, text: item.text })), [{
    seq: 2,
    source: 'plugin:runtime:snapshot',
    text: 'initial',
  }])
})

test('rejects complete header drift and reports logical requests separately', () => {
  const cwd = 'X:\\fixture\\workspace'
  const model = 'model'
  const provider = 'provider'
  const system = persona.replace('{{model}}', model)
  const header = {
    config: { provider, model },
    system,
    tools: [{ name: 'run_code', description: 'Run.', parameters: { type: 'object' } }],
  }
  const events = [
    { type: 'session', version: 2, id: 'ab-header', cwd, createdAt: 1234 },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    {
      type: 'user/message', seq: 2,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] },
    },
    {
      type: 'user/message', seq: 3,
      data: {
        source: {
          kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [],
        },
        content: [{ type: 'text', text: 'runtime snapshot' }],
      },
    },
    { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 5, data: { reason: 'initial', header } },
    {
      type: 'request/header', seq: 6,
      data: {
        reason: 'change',
        header: { ...structuredClone(header), tools: [{ ...header.tools[0], description: 'Run!' }] },
      },
    },
    {
      type: 'assistant/message', seq: 7,
      data: { message: { content: [{ type: 'text', text: 'done' }] } },
    },
    { type: 'turn/end', seq: 8, time: 2, data: { reason: { kind: 'completed' } } },
  ]
  const analysis = analyzeSession(events, {
    cwd, model, provider, variant: 'baseline', prompt: 'task', taskId: 'header-drift',
    machineBudget: {
      maxModelRequests: 2, maxDirectCalls: 0, maxSourceChars: 0,
      maxRepeatedSourceCalls: 0, maxResultChars: 0, maxAssistantChars: 100,
      maxTokenTraffic: 0, maxRuntimeContextChars: 100,
    },
    runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 100 },
  })

  assert.equal(analysis.modelRequests, 1)
  assert.equal(analysis.turnWallMs, 1)
  assert.deepEqual(analysis.session, { id: 'ab-header', cwd, createdAt: 1234 })
  assert.equal(analysis.headerEpochs, 2)
  assert.equal(analysis.headerChanges, 1)
  assert.match(analysis.failures.join('\n'), /changed tools\[0\]\.description/)
  assert.equal(typeof analysis.system, 'string')
  assert.equal(analysis.prompt.injections.length, 1)
  assert.equal(analysis.finalAnswer, 'done')
  assert.equal(analysis.toolErrorCount, 0)
  assert.equal(analysis.resultOutputChars, 0)
  assert.equal(aggregateTrajectories([{ ...analysis, taskValidation: { status: 'pass' }, uncertaintySignals: [] }], 'baseline').modelRequests, 1)
})

test('keeps failed result markers and bounded output previews in shared facts', async () => {
  const output = `${'head'.repeat(5_000)}${'tail'.repeat(2_000)}`
  const facts = collectTrajectoryFacts([
    { type: 'tool/call', seq: 1, data: { callId: 'call-1', name: 'run_code', arguments: '{"code":"return 1"}' } },
    {
      type: 'tool/result', seq: 2, data: {
        callId: 'call-1', isError: true,
        message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: output }] },
      },
    },
  ])

  assert.equal(facts.results.get(1).callId, 'call-1')
  assert.equal(facts.results.get(1).isError, true)
  assert.equal(facts.results.get(1).resultError, true)
  assert.equal(facts.results.get(1).outputChars, output.length)
  assert.equal(facts.results.get(1).output.length < output.length, true)
  assert.equal(facts.timeline[0].resultError, true)
  assert.equal(facts.timeline[0].output.length < output.length, true)
  assert.match(facts.timeline[0].output, /\.\.\.<truncated>\.\.\./)

  const validation = await validateTask(
    { id: 'package-name', validator: 'package-name' },
    'expected',
    { timeline: facts.timeline, finalAnswer: 'answer' },
    '',
  )
  assert.equal(validation.machineEvidence.status, 'fail')
})

test('counts namespace dot, whitespace, and bracket access in source cells', () => {
  const cwd = 'X:\\fixture\\workspace'
  const model = 'model'
  const provider = 'provider'
  const system = persona.replace('{{model}}', model)
  const events = [
    { type: 'session', version: 2, id: 'ab-namespaces', cwd },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] } },
    {
      type: 'user/message', seq: 3,
      data: {
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
        content: [{ type: 'text', text: 'runtime snapshot' }],
      },
    },
    { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } },
    {
      type: 'request/header', seq: 5,
      data: { reason: 'initial', header: { config: { provider, model }, system, tools: [{ name: 'run_code' }] } },
    },
    {
      type: 'tool/call', seq: 6,
      data: {
        callId: 'call-1', name: 'run_code',
        arguments: JSON.stringify({ code: 'tools.foo(); repl .bar(); capabilities["baz"]; code[0]' }),
      },
    },
    {
      type: 'tool/result', seq: 7,
      data: { callId: 'call-1', message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }] } },
    },
    { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 9, time: 2, data: { reason: { kind: 'completed' } } },
  ]
  const analysis = analyzeSession(events, {
    id: 'namespace-metrics', cwd, model, provider, variant: 'baseline', prompt: 'task',
    machineBudget: {
      maxModelRequests: 1, maxDirectCalls: 1, maxSourceChars: 100,
      maxRepeatedSourceCalls: 0, maxResultChars: 10, maxAssistantChars: 100,
      maxTokenTraffic: 0, maxRuntimeContextChars: 100,
    },
    runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 100 },
  })
  assert.deepEqual(analysis.namespaceMentions, { tools: 1, repl: 1, capabilities: 1, code: 1 })
})

test('identifies both current treatments from formal system-message evidence', () => {
  const cwd = 'X:\\fixture\\workspace'
  const model = 'model'
  const provider = 'provider'
  const machineBudget = Object.fromEntries(MACHINE_BUDGET_KEYS.map(key => [key, 1000]))
  for (const variant of ['baseline', 'plugin']) {
    const system = persona.replace('{{model}}', model)
      + (variant === 'plugin' ? '\n## PTC Plus program capabilities' : '')
    const events = [{ type: 'session', version: 4, id: 'current-prompt', cwd }]
    const append = (type, data, surfaceOp) => {
      events.push({ seq: events.length - 1, time: events.length, type, data,
        ...(surfaceOp === undefined ? {} : { surfaceOp }) })
    }
    append('turn/start', { turn: 1 })
    append('step/start', { turn: 1, step: 1 })
    append('system/message', { message: { role: 'system', content: [{ type: 'text', text: system }] } }, 'append')
    append('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] }, 'append')
    append('user/message', { role: 'user', source: {
      kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [],
    }, content: [{ type: 'text', text: 'runtime snapshot' }] }, 'append')
    append('request/header', { reason: 'initial', header: { config: { provider, model },
      tools: [{ name: 'run_code' }] } })
    append('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 },
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } }],
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, 'append')
    append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const analysis = analyzeSession(events, { id: 'current-prompt', cwd, model, provider, variant, prompt: 'task', machineBudget,
      runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 100 } })
    assert.deepEqual(analysis.failures, [])
    assert.equal(analysis.system, system)
    assert.equal(analysis.prompt.systemEvidence.source, 'ordered-surface')
    const projected = structuredClone(events)
    const user = projected.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    user.data.content.push({ type: 'image', attachment: {
      attachmentId: 'projection-proof', mediaType: 'image/png', bytes: 4, width: 1, height: 1,
    } })
    projected.splice(projected.findIndex(event => event.type === 'request/header'), 0, {
      type: 'image/offload', time: 1, data: { targets: [{ seq: user.seq, imageIndexes: [0] }] },
    })
    projected.slice(1).forEach((event, seq) => { event.seq = seq })
    assert.deepEqual(analyzeSession(projected, {
      id: 'current-prompt', cwd, model, provider, variant, prompt: 'task', machineBudget,
      runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 100 },
    }).failures, [])
    const replaced = structuredClone(events)
    const head = replaced.find(event => event.type === 'system/message')
    head.data.message = createSystemMessage(system)
    replaced.splice(-2, 0, { type: 'system/message', time: 1, data: {
      message: createSystemMessage(system),
    }, surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] })
    replaced.slice(1).forEach((event, seq) => { event.seq = seq })
    assert.deepEqual(analyzeSession(replaced, {
      id: 'current-prompt', cwd, model, provider, variant, prompt: 'task', machineBudget,
      headerPolicy: { historyReplacements: 1 },
      runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 100 },
    }).failures, [])
    for (const isError of [true, false]) {
      const outcomes = structuredClone(events)
      outcomes.splice(-2, 0,
        { type: 'tool/call', time: 1, data: { name: 'run_code', callId: 'outcome', arguments: '{}' } },
        { type: 'tool/result', time: 1, data: { message: createToolResultMessage({
          callId: 'outcome', isError, content: [{ type: 'text', text: 'outcome' }],
        }) }, surfaceOp: 'append' })
      outcomes.slice(1).forEach((event, seq) => { event.seq = seq })
      const result = analyzeSession(outcomes, {
        id: 'current-prompt', cwd, model, provider, variant, prompt: 'task', machineBudget,
        runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 100 },
      })
      assert.equal(result.toolErrorCount, isError ? 1 : 0)
      assert.equal(createBlindPacket('opaque', { id: 'outcome' }, result).timeline[0].resultError, isError)
    }
    for (const version of [3, 4]) {
      for (const retired of [system, '', null, {}]) {
        const invalid = structuredClone(events)
        invalid[0].version = version
        invalid.find(event => event.type === 'request/header').data.header.system = retired
        assert.match(analyzeSession(invalid, {
          id: 'current-prompt', cwd, model, provider, variant, prompt: 'task', machineBudget,
          runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 100 },
        }).failures.join('\n'), /must omit header.system/)
      }
      const corrupt = structuredClone(events).filter(event => event.type !== 'system/message')
      corrupt[0].version = version
      corrupt.find(event => event.type === 'request/header').data.header.system = system
      corrupt.splice(-2, 0, { type: 'image/offload', time: 1, data: {} })
      corrupt.slice(1).forEach((event, seq) => { event.seq = seq })
      const rejected = analyzeSession(corrupt, { id: 'current-prompt', cwd, model, provider, variant, prompt: 'task', machineBudget })
      assert.equal(rejected.prompt.systemEvidence.source, 'ordered-surface')
      assert.match(rejected.failures.join('\n'), /no leading system message|must omit header.system/)
      assert.equal(rejected.system, '')
    }
    const changed = structuredClone(events)
    changed.splice(-2, 0, { seq: 0, time: 1, type: 'system/message', data: { message: {
      role: 'system', content: [{ type: 'text', text: 'changed prompt' }],
    } }, surfaceOp: 'append' })
    changed.slice(1).forEach((event, seq) => { event.seq = seq })
    assert.match(analyzeSession(changed, { id: 'current-prompt', cwd, model, provider, variant, prompt: 'task', machineBudget })
      .failures.join('\n'), /system prompt changed/)
  }
})

test('records test-gate subprocess outcomes without judging answer prose', async () => {
  const result = await validateTask(
    { id: 'test-check', validator: 'test-gate' },
    { command: 'npm run check', exitCode: 0 },
    {
      timeline: [{
        code: "const child = spawn('npm', ['run', 'check'], { shell: true })",
        resultError: false,
      }],
      finalAnswer: 'The checks failed even though a setup command had exit code 0.',
    },
  )
  assert.deepEqual(result.machineEvidence, {
    status: 'pass',
    source: 'subprocess',
    command: 'npm run check',
    exitCode: 0,
  })
  assert.equal(result.answerAssessment.status, 'blind-pending')

  const observedFailure = await validateTask(
    { id: 'test-check', validator: 'test-gate' },
    { command: 'npm run check', exitCode: 1 },
    { timeline: [], finalAnswer: 'Everything passes.' },
  )
  assert.deepEqual(observedFailure.machineEvidence, {
    status: 'pass',
    source: 'subprocess',
    command: 'npm run check',
    exitCode: 1,
  })
  assert.equal(observedFailure.answerAssessment.status, 'blind-pending')
})

test('keeps negated factual answers pending instead of matching prose', async () => {
  for (const [task, oracle, finalAnswer] of [
    [{ id: 'runtime', validator: 'package-engine' }, '>=22', 'The requirement is not >=22.'],
    [{ id: 'readme', validator: 'readme-phrase' }, false, 'The phrase is absent from the README.'],
  ]) {
    const result = await validateTask(task, oracle, { timeline: [], finalAnswer })
    assert.equal(result.machineEvidence.status, 'pass')
    assert.equal(result.answerAssessment.status, 'blind-pending')
  }
})

test('hashes fixture trees deterministically and excludes the manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-ab-hash-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.js'), 'const a = 1\n')
  await writeFile(join(root, 'README.md'), 'readme\n')
  const first = await hashFixtureTree(root)
  assert.equal(first, await hashFixtureTree(root))
  await writeFile(join(root, 'benchmark-manifest.json'), '{}')
  assert.equal(await hashFixtureTree(root), first)
})

test('materializes stable fixture copies with identical bytes and dirty git state', async (t) => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
  const fixtureAttribute = execFileSync(
    'git',
    ['check-attr', 'eol', '--', 'fixtures/ab-node-project-v1/src/greeting.js'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim()
  assert.equal(fixtureAttribute, 'fixtures/ab-node-project-v1/src/greeting.js: eol: lf')
  const root = await mkdtemp(join(tmpdir(), 'ptc-ab-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const left = join(root, 'left')
  const right = join(root, 'right')
  await materializeFixture('fixtures/ab-node-project-v1', left)
  await materializeFixture('fixtures/ab-node-project-v1', right)
  const status = execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: left,
    encoding: 'utf8',
  }).trim().split(/\r?\n/)
  assert.deepEqual(status, ['M src/greeting.js', '?? internal/draft.txt'])
  assert.equal(await hashFixtureTree(left), await hashFixtureTree(right))
  assert.equal(JSON.parse(await readFile(join(left, 'package.json'), 'utf8')).name, 'ab-node-project-v1')
  await assert.rejects(readFile(join(left, 'node_modules', 'anything'), 'utf8'), { code: 'ENOENT' })
})

test('reads the benchmark manifest and rejects content drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-ab-manifest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = join(root, 'fixture')
  await mkdir(fixture)
  await writeFile(join(fixture, 'a.txt'), 'hello')
  const digest = await hashFixtureTree(fixture)
  await writeFile(join(fixture, 'benchmark-manifest.json'), JSON.stringify({
    fixtureName: 'example',
    fixtureVersion: '1.0.0',
    contentSha256: digest,
    git: {
      authorName: 'A',
      authorEmail: 'a@example.invalid',
      initialCommitMessage: 'init',
    },
    dirty: [],
  }))
  const manifest = await readFixtureManifest(fixture)
  assert.equal(manifest.fixtureVersion, '1.0.0')
  await writeFile(join(fixture, 'a.txt'), 'changed')
  await assert.rejects(readFixtureManifest(fixture), /content SHA-256 mismatch/)
})

test('validates the package-name canary only from canonical return evidence', async () => {
  const task = { id: 'package-name', validator: 'package-name' }
  const oracle = await taskOracle(task, 'fixtures/ab-node-project-v1')
  assert.equal(oracle, 'ab-node-project-v1')
  const validate = (completion, output = oracle) => validateTask(task, oracle, {
    finalAnswer: oracle,
    timeline: [{ name: 'run_code', resultError: false, output, completion }],
  }, '')
  const returned = value => ({ kind: 'return', hasValue: true, valueWire: encodeValue(value) })
  const pass = await validate(returned(oracle), `"${oracle}"`)
  assert.equal(pass.machineEvidence.status, 'pass')
  assert.equal(pass.answerAssessment.status, 'blind-pending')
  assert.equal((await validate(returned(JSON.stringify(oracle)), oracle)).machineEvidence.status, 'fail')
  assert.equal((await validate(returned({ name: oracle }), oracle)).machineEvidence.status, 'fail')
  assert.equal((await validate({ kind: 'return', hasValue: false }, oracle)).machineEvidence.status, 'fail')
  assert.equal((await validate({ kind: 'throw' }, oracle)).machineEvidence.status, 'fail')
  assert.equal((await validate(returned('another-project'), oracle)).machineEvidence.status, 'fail')
  for (const output of [oracle, `"${oracle}"`, `console log\n${oracle}`, `{ "name": "${oracle}" }`]) {
    assert.equal((await validate(undefined, output)).machineEvidence.status, 'incomplete')
  }
  assert.equal((await validate({ kind: 'return', hasValue: true })).machineEvidence.status, 'incomplete')
  assert.equal((await validate({ kind: 'return', hasValue: true, valueWire: {} })).machineEvidence.status, 'incomplete')
  const cyclic = {}; cyclic.self = cyclic
  for (const value of [2n, cyclic]) {
    const mismatch = await validate(returned(value))
    assert.equal(mismatch.machineEvidence.status, 'fail')
    const persisted = JSON.parse(JSON.stringify({ taskValidation: mismatch }))
    const decoded = decodeValue(persisted.taskValidation.machineEvidence.observed[0].valueWire)
    if (typeof value === 'bigint') assert.equal(decoded, value)
    else assert.equal(decoded.self, decoded)
    assert.equal(Object.keys(mismatch.machineEvidence.observed[0]).includes('value'), false)
  }
  const jsonLooking = '"123"'
  assert.equal((await validateTask(task, jsonLooking, {
    timeline: [{ name: 'run_code', resultError: false, completion: returned(jsonLooking) }],
  }, '')).machineEvidence.status, 'pass')
})

test('marks semantic validation as pending blind review instead of an outcome', async () => {
  const result = await validateTask(
    { id: 'semantic', validator: 'blind' },
    undefined,
    { timeline: [], finalAnswer: 'answer' },
  )
  assert.deepEqual(result, {
    status: 'blind-pending',
    machineEvidence: { status: 'not-applicable' },
    answerAssessment: {
      status: 'blind-pending',
      reason: 'free-form answer requires blind semantic review',
    },
  })
  assert.deepEqual(pendingBlindApproval([], [], 4), {
    machineAcceptance: { status: 'pass' },
    blindReview: { status: 'pending', packets: 4 },
    approval: {
      status: 'pending',
      reason: 'machine acceptance passed; blind trajectory review is incomplete',
    },
  })
  assert.equal(pendingBlindApproval(['transport failed'], [], 4).approval.status, 'blocked')
})

test('does not schedule remaining paid work when the canary fails', async () => {
  assert.deepEqual(orderCanaryFirst([
    { id: 'blind', machineOracle: false },
    { id: 'checked', machineOracle: true },
    { id: 'later', machineOracle: true },
  ], item => item.machineOracle).map(item => item.id), ['checked', 'blind', 'later'])
  assert.throws(() => orderCanaryFirst([{ machineOracle: false }], item => item.machineOracle), /no item eligible/)

  const started = []
  await assert.rejects(runCanaryThenConcurrent(
    ['canary', 'later-a', 'later-b'],
    2,
    async item => {
      started.push(item)
      return { item, failures: item === 'canary' ? ['protocol failure'] : [] }
    },
    async result => {
      if (result.failures.length > 0) throw new Error('canary rejected')
    },
  ), /canary rejected/)
  assert.deepEqual(started, ['canary'])

  const ambiguous = await validateTask({ validator: 'package-name' }, 'pkg', {
    timeline: [{ name: 'run_code', resultError: false, output: '"pkg"' }],
  }, '')
  started.length = 0
  await assert.rejects(runCanaryThenConcurrent(['canary', 'paid'], 2, async item => {
    started.push(item)
    return ambiguous
  }, async result => {
    if (result.machineEvidence.status !== 'pass') throw new Error('canonical canary incomplete')
  }), /canonical canary incomplete/)
  assert.deepEqual(started, ['canary'])

  started.length = 0
  const accepted = await runCanaryThenConcurrent(
    ['canary', 'later-a', 'later-b'],
    2,
    async item => {
      started.push(item)
      return item
    },
    async () => {},
  )
  assert.deepEqual(accepted, ['canary', 'later-a', 'later-b'])
  assert.deepEqual(started, ['canary', 'later-a', 'later-b'])
})
