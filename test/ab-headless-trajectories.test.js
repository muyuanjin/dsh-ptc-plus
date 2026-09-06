import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  analyzeSession,
  armScratchPaths,
  copyWorkspace,
  createBlindPacket,
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
import { collectTrajectoryFacts, pendingBlindApproval } from '../scripts/acceptance-contract.mjs'
import { aggregateTrajectories } from '../scripts/ab-trajectory-report.mjs'

const persona = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
const runtime = { toolsMode: 'ptc', permissionMode: 'danger-full-access' }

test('separates opaque arm scratch trees from evaluator artifacts', () => {
  const scratchRoot = join(tmpdir(), 'ptc-ab-scratch')
  const scratch = armScratchPaths(scratchRoot, 'opaque-123')
  assert.equal(scratch.directory, join(scratchRoot, 'runs', 'opaque-123'))
  assert.equal(scratch.workspace, join(scratchRoot, 'runs', 'opaque-123', 'workspace'))
  assert.equal(JSON.stringify(scratch).includes('plugin'), false)
  assert.equal(JSON.stringify(scratch).includes('baseline'), false)
  assert.throws(() => armScratchPaths(scratchRoot, '../plugin'), /arm scratch nonce/)
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
    { id: 'tools', config: { mode: 'ptc' } },
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
  plugin.find(row => row.id === 'tools').config.mode = 'code'
  baseline.find(row => row.id === 'tools').config.mode = 'code'
  assert.throws(() => validateConfigPair(plugin, baseline, { ...runtime, toolsMode: 'code' }), /public DSH tools config/)
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
  nativeTools.find(row => row.id === 'tools').config.mode = 'native'
  assert.throws(() => validateConfigPair(nativeTools, baseline, runtime), /does not use tools mode ptc/)
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
  const system = persona.replace('{{model}}', model).replace('{{cwd}}', cwd)
  const header = {
    config: { provider, model },
    system,
    tools: [{ name: 'run_code', description: 'Run.', parameters: { type: 'object' } }],
  }
  const events = [
    { type: 'session', id: 'ab-header', cwd, createdAt: 1234 },
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

  assert.equal(facts.results.get('call-1').isError, true)
  assert.equal(facts.results.get('call-1').resultError, true)
  assert.equal(facts.results.get('call-1').outputChars, output.length)
  assert.equal(facts.results.get('call-1').output.length < output.length, true)
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
  const system = persona.replace('{{model}}', model).replace('{{cwd}}', cwd)
  const events = [
    { type: 'session', id: 'ab-namespaces', cwd },
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

test('validates the package-name canary oracle through run_code', async () => {
  const task = { id: 'package-name', validator: 'package-name' }
  const oracle = await taskOracle(task, 'fixtures/ab-node-project-v1')
  assert.equal(oracle, 'ab-node-project-v1')
  const pass = await validateTask(task, oracle, {
    finalAnswer: 'The project is not ab-node-project-v1.',
    timeline: [{ name: 'run_code', resultError: false, output: '"ab-node-project-v1"' }],
  }, '')
  assert.equal(pass.machineEvidence.status, 'pass')
  assert.equal(pass.answerAssessment.status, 'blind-pending')
  const loggedPrimitive = await validateTask(task, oracle, {
    finalAnswer: 'ab-node-project-v1',
    timeline: [{
      name: 'run_code', resultError: false,
      output: 'package.json name field: ab-node-project-v1\nab-node-project-v1',
    }],
  }, '')
  assert.equal(loggedPrimitive.machineEvidence.status, 'pass')
  const wrapped = await validateTask(task, oracle, {
    finalAnswer: 'ab-node-project-v1',
    timeline: [{
      name: 'run_code', resultError: false,
      output: '{\n  "name": "ab-node-project-v1"\n}',
    }],
  }, '')
  assert.equal(wrapped.machineEvidence.status, 'fail')
  const fail = await validateTask(task, oracle, {
    finalAnswer: '项目名是 ab-node-project-v1',
    timeline: [{ name: 'run_code', resultError: false, output: '"another-project"' }],
  }, '')
  assert.equal(fail.machineEvidence.status, 'fail')
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
