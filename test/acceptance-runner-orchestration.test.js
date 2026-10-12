import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as host from '../scripts/headless-host.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Windows evaluation accepts drive paths and WSL drive mounts, not native WSL storage.
const forwardsWindowsPaths = /^[a-zA-Z]:[\\/]|^\/mnt\/[a-zA-Z]\//.test(repoRoot)

function journal() {
  return {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    status: 'durable',
    calls: [],
    operations: [],
    confirms: [],
    diagnostics: [],
    completion: { kind: 'return', hasValue: false },
  }
}

function fixtureLog({ cwd, id, tasks, parentSession }) {
  const system = [
    'You are a coding agent powered by the model model.',
    'declare const tools: {}',
    'declare const capabilities: {}',
  ].join('\n')
  const events = [
    { type: 'session', version: 2, cwd, id,
      ...(parentSession === undefined ? {} : { parentSession, origin: 'subagent' }) },
    { type: 'user/message', data: { source: { kind: 'runtime-context', form: 'snapshot',
      sections: [{ name: 'sandbox:policy', text: 'runtime policy' }] },
      content: [{ type: 'text', text: 'snapshot wrapper\n\nruntime policy' }] } },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'fixture', model: 'model' },
      tools: [{ name: 'run_code' }], system } } },
  ]
  tasks.forEach((task, index) => {
    const base = 100 + index * 10
    events.push(
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: task }] } },
      { type: 'step/start', seq: base, data: { turn: index + 1, step: 1 } },
      { type: 'tool/call', seq: base + 1, data: { callId: `call-${index}`, name: 'run_code',
        arguments: JSON.stringify({ code: `return ${index}`, description: `Step ${index}` }) } },
      { type: 'tool/result', seq: base + 2, data: { message: { source: { callId: `call-${index}` },
        content: [{ type: 'text', text: 'ok' }] }, meta: { dshPtcPlus: journal() } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer ${index}` }] },
        usage: { inputTokens: 1, outputTokens: 1 } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    )
  })
  return events
}

test('acceptance runs phased sessions and audits delegated sessions end to end',
  { skip: forwardsWindowsPaths ? false : 'requires a checkout with a Windows drive path' }, async t => {
  const roots = new Set()
  t.after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  })
  t.mock.module('node:fs/promises', { namedExports: { ...fs, async writeFile(path, ...args) {
    if (path.endsWith('manifest.json')) roots.add(dirname(path))
    return fs.writeFile(path, ...args)
  } } })
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const scenarioFile = join(await mkdtemp(join(repoRoot, 'artifacts', 'orchestration-')), 'scenarios.json')
  roots.add(dirname(scenarioFile))
  const expectBase = {
    machineBudget: { maxModelRequests: 6, maxDirectCalls: 3, maxSourceChars: 4000, maxRepeatedSourceCalls: 0,
      maxResultChars: 8000, maxAssistantChars: 8000, maxTokenTraffic: 40000, maxRuntimeContextChars: 8000 },
    runtimeContexts: { allowed: [], requiredTransitions: [], maxSnapshotChars: 8192 },
  }
  await writeFile(scenarioFile, JSON.stringify([
    { id: 'phased-fixture', title: 'Phased fixture', default: true, variant: 'managed',
      task: 'phase one task', phases: [{ task: 'phase two task', variant: 'managed-no-fs' }],
      expect: { ...expectBase, minCells: 2, maxCells: 3 } },
    { id: 'child-fixture', title: 'Child fixture', default: true, variant: 'acceptance',
      task: 'child root task',
      expect: { ...expectBase, minCells: 1, maxCells: 2,
        childSession: { ...expectBase, minCells: 1, maxCells: 2 } } },
  ], null, 2) + '\n')

  const runs = []
  const sessionId = 'session-orchestration-fixture'
  const childId = 'child-orchestration-fixture'
  t.mock.module('../scripts/headless-host.mjs', { namedExports: {
    ...host,
    async preflightHeadlessHost() {
      return { dshHome: repoRoot, sessionsRoot: join(repoRoot, 'artifacts', 'orchestration-sessions') }
    },
    async prepareHeadlessConfigs() {
      return { overlays: { acceptance: 'acceptance.yml', managed: 'managed.yml', 'managed-no-fs': 'managed-no-fs.yml' } }
    },
    async preflightKeylessVerify() {},
    async runHeadlessTask({ task, cwd, sessionId: resumeSessionId }) {
      runs.push({ task, resumeSessionId })
      const cwdWindows = host.windowsPath(cwd)
      if (task === 'child root task') {
        return { process: { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }, decoded: [
          { file: 'root.jsonl', text: '{}', storedVersion: 2, inheritedEventCount: 0,
            events: fixtureLog({ cwd: cwdWindows, id: sessionId, tasks: [task] }) },
          { file: 'child.jsonl', text: '{}', storedVersion: 2, inheritedEventCount: 0,
            events: fixtureLog({ cwd: cwdWindows, id: childId, tasks: ['delegated task'], parentSession: sessionId }) },
        ] }
      }
      const tasks = resumeSessionId === undefined ? [task] : ['phase one task', task]
      return { process: { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 },
        decoded: [{ file: 'phased.jsonl', text: '{}', storedVersion: 2, inheritedEventCount: 0,
          events: fixtureLog({ cwd: cwdWindows, id: sessionId, tasks }) }] }
    },
  } })
  const { main } = await import('../scripts/expensive-headless-acceptance.mjs?orchestration')
  await main({
    DSH_PTC_ACCEPTANCE_PROVIDER: 'fixture',
    DSH_PTC_ACCEPTANCE_MODEL: 'model',
    DSH_PTC_ACCEPTANCE_API_KEY_ENV: 'FIXTURE_KEY',
    FIXTURE_KEY: 'synthetic-credential',
    DSH_PTC_ACCEPTANCE_SCENARIO_FILE: scenarioFile,
  })
  assert.deepEqual(runs.map(run => [run.task, run.resumeSessionId]).sort((left, right) => left[0].localeCompare(right[0])), [
    ['phase one task', undefined],
    ['phase two task', sessionId],
    ['child root task', undefined],
  ].sort((left, right) => left[0].localeCompare(right[0])))
  const artifactRoot = [...roots].find(root => root.startsWith(join(repoRoot, 'artifacts', 'expensive')))
  assert.ok(artifactRoot !== undefined)
  const summary = JSON.parse(await readFile(join(artifactRoot, 'summary.json'), 'utf8'))
  assert.deepEqual(summary.failures, [])
  assert.deepEqual(summary.scenarios.map(scenario => scenario.id).sort(), ['child-fixture', 'phased-fixture'])
  assert.equal(await readFile(join(artifactRoot, 'child-fixture', 'child-session.jsonl'), 'utf8'), '{}')
  assert.equal(process.exitCode ?? 0, 0)
})
