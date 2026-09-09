import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  PTC_DIRECT_TOOLS,
  auditModelRequests,
  auditRequestHeaders,
  auditRuntimeContexts,
  collectModelText,
  collectTrajectoryFacts,
  isRuntimeContextSource,
  machineBudgetFailures,
  pendingBlindApproval,
  positiveInteger,
  validateMachineBudget,
  validateRequestHeaderPolicy,
  validateRuntimeContextConfig,
} from './acceptance-contract.mjs'
import { aggregateTrajectories, duplicateParagraphs, multisetDifference, paragraphs, reportMarkdown, trajectoryDelta } from './ab-trajectory-report.mjs'
import { orderCanaryFirst, runCanaryThenConcurrent } from './acceptance-orchestration.mjs'
import {
  HEADLESS_TOOLS_MODE,
  NEUTRAL_PERSONA,
  changedSessionLogs,
  cleanupOwnedPath,
  createProcessRunner,
  formatHeadlessError,
  headlessConfigPatch,
  parseConfigDump,
  powershellPath,
  dshInvocation,
  preflightHeadlessHost,
  requiredModelRuntime,
  resolveHeadlessProvider,
  redactHeadlessConfig,
  removeTree,
  snapshotSessionLogs,
  validateHeadlessRuntimeConfig,
  validateNeutralConfig,
  withOwnedPath,
  windowsPath,
} from './headless-host.mjs'
import { npmCliCommand } from './npm-cli.mjs'

export { parseConfigDump } from './headless-host.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runProcess = createProcessRunner(repoRoot)
const defaultTasksFile = join(repoRoot, 'scripts', 'ab-trajectory-tasks.json')
const defaultFixtureDir = join(repoRoot, 'fixtures', 'ab-node-project-v1')
const fixtureManifestFile = 'benchmark-manifest.json'
const pluginMarker = '## PTC Plus program capabilities'
const neutralPersona = NEUTRAL_PERSONA
const WORKSPACE_EXECUTION_ROOTS = new Set(['.git', 'node_modules'])
const WORKSPACE_EXCLUDED_ROOTS = new Set(['artifacts'])
const WORKSPACE_EXCLUDED_PATHS = new Set(['REVIEW_FINDINGS.md'])
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function withoutTreatment(rows) {
  return structuredClone(rows).map(row => {
    if (row.id !== 'ptc-plus') return row
    const { disabled: _disabled, ...rest } = row
    return rest
  })
}

export function validateConfigPair(pluginRows, baselineRows, runtime) {
  validateNeutralConfig(pluginRows, 'plugin config', 'enabled')
  validateNeutralConfig(baselineRows, 'baseline config', 'disabled')
  validateHeadlessRuntimeConfig(pluginRows, 'plugin config', runtime)
  validateHeadlessRuntimeConfig(baselineRows, 'baseline config', runtime)
  if (!isDeepStrictEqual(withoutTreatment(pluginRows), withoutTreatment(baselineRows))) {
    throw new Error('resolved A/B configs differ outside ptc-plus.disabled')
  }
  return {
    pluginSha256: sha256(JSON.stringify(pluginRows)),
    baselineSha256: sha256(JSON.stringify(baselineRows)),
    onlyDifference: 'ptc-plus.disabled',
  }
}

function sourceLabel(source) {
  if (source === null || typeof source !== 'object') return 'unknown'
  return [source.kind, source.plugin, source.form].filter(value => typeof value === 'string').join(':') || 'unknown'
}

export function initialInjections(events, cwd) {
  const firstRequestSeq = events.find(event => event.type === 'request/header')?.seq ?? Number.POSITIVE_INFINITY
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.seq >= firstRequestSeq || event.data?.source?.kind === 'user') return []
    const text = collectModelText(event.data?.content).join('\n')
    return [{
      seq: event.seq,
      source: sourceLabel(event.data?.source),
      chars: text.length,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      normalizedSha256: sha256(normalizedForWorkspace(text, cwd)),
      text,
    }]
  })
}

function normalizedForWorkspace(value, cwd) {
  if (typeof value !== 'string') return ''
  const forward = cwd.replaceAll('\\', '/')
  const escaped = JSON.stringify(cwd).slice(1, -1)
  return value
    .replaceAll(escaped, '<WORKSPACE>')
    .replaceAll(cwd, '<WORKSPACE>')
    .replaceAll(forward, '<WORKSPACE>')
}

export function armScratchPaths(scratchRoot, nonce = randomUUID()) {
  if (typeof nonce !== 'string' || !/^[a-zA-Z0-9-]+$/.test(nonce)) {
    throw new TypeError('arm scratch nonce must contain only letters, digits, and hyphens')
  }
  const directory = join(scratchRoot, 'runs', nonce)
  return Object.freeze({ directory, workspace: join(directory, 'workspace') })
}

export function createBlindPacket(label, task, arm) {
  const cwd = arm.session?.cwd
  const redact = value => typeof value === 'string' && typeof cwd === 'string' && cwd !== ''
    ? normalizedForWorkspace(value, cwd)
    : value
  return {
    label,
    task,
    timeline: arm.timeline.map(item => ({
      description: redact(item.description),
      code: redact(item.code),
      resultError: item.resultError,
      outputChars: item.outputChars,
      output: redact(item.output),
    })),
    finalAnswer: redact(arm.finalAnswer),
    observable: {
      toolCalls: arm.toolCallCount,
      sourceChars: arm.sourceChars,
      resultOutputChars: arm.resultOutputChars,
      assistantTextChars: arm.assistantTextChars,
    },
  }
}

async function workspaceSourcePaths(source, run = runProcess) {
  const listed = await run('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], { cwd: source, timeoutMs: 30_000 })
  if (listed.code !== 0) {
    throw new Error(`cannot enumerate A/B workspace source files: ${listed.stderr.trim()}`)
  }
  const paths = new Set([''])
  for (const listedPath of listed.stdout.split('\0').filter(Boolean)) {
    const normalized = listedPath.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`git listed an invalid A/B workspace path: ${JSON.stringify(listedPath)}`)
    }
    let current = normalized
    while (current !== '') {
      paths.add(current)
      const separator = current.lastIndexOf('/')
      current = separator < 0 ? '' : current.slice(0, separator)
    }
  }
  return paths
}

export async function copyWorkspace(source, destination, options = {}) {
  const sourcePaths = await workspaceSourcePaths(source, options.runProcess)
  await cp(source, destination, {
    recursive: true,
    filter: path => {
      const pathFromRoot = relative(source, path).replaceAll('\\', '/')
      if (pathFromRoot === '') return true
      const root = pathFromRoot.split('/', 1)[0]
      if (WORKSPACE_EXCLUDED_ROOTS.has(root) || WORKSPACE_EXCLUDED_PATHS.has(pathFromRoot)) {
        return false
      }
      return WORKSPACE_EXECUTION_ROOTS.has(root) || sourcePaths.has(pathFromRoot)
    },
  })
}

export async function hashFixtureTree(root, options = {}) {
  const excluded = new Set(options.exclude ?? [fixtureManifestFile])
  const entries = []
  async function visit(directory, prefix = '') {
    let directoryEntries
    try {
      directoryEntries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of directoryEntries) {
      const path = join(directory, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (relativePath === '.git' || relativePath === 'node_modules' || excluded.has(relativePath)) continue
        await visit(path, relativePath)
      } else if (entry.isFile() && !excluded.has(relativePath)) {
        entries.push([relativePath, await readFile(path)])
      }
    }
  }
  await visit(root)
  entries.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
  const digest = createHash('sha256')
  for (const [relativePath, content] of entries) {
    digest.update(relativePath)
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
  }
  return digest.digest('hex')
}

function validateFixtureManifestShape(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('A/B fixture manifest must be an object')
  }
  if (typeof manifest.fixtureName !== 'string' || manifest.fixtureName.trim() === ''
    || typeof manifest.fixtureVersion !== 'string' || manifest.fixtureVersion.trim() === '') {
    throw new Error('A/B fixture manifest must declare fixtureName and fixtureVersion')
  }
  if (typeof manifest.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.contentSha256)) {
    throw new Error('A/B fixture manifest contentSha256 must be a SHA-256 hex digest')
  }
  if (manifest.git === null || typeof manifest.git !== 'object' || Array.isArray(manifest.git)
    || typeof manifest.git.authorName !== 'string' || manifest.git.authorName.trim() === ''
    || typeof manifest.git.authorEmail !== 'string' || manifest.git.authorEmail.trim() === ''
    || typeof manifest.git.initialCommitMessage !== 'string' || manifest.git.initialCommitMessage.trim() === '') {
    throw new Error('A/B fixture manifest git section is incomplete')
  }
  if (!Array.isArray(manifest.dirty)) throw new Error('A/B fixture manifest must define a dirty array')
  for (const entry of manifest.dirty) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || entry.path.trim() === ''
      || typeof entry.content !== 'string') {
      throw new Error('A/B fixture manifest dirty entries require a path and content')
    }
  }
}

export async function readFixtureManifest(fixtureDir = defaultFixtureDir, options = {}) {
  const manifestPath = join(fixtureDir, fixtureManifestFile)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read A/B fixture manifest: ${error.message}`)
  }
  validateFixtureManifestShape(manifest)
  const actualSha256 = await hashFixtureTree(fixtureDir, options)
  if (actualSha256 !== manifest.contentSha256) {
    throw new Error(`A/B fixture content SHA-256 mismatch: manifest ${manifest.contentSha256}, actual ${actualSha256}`)
  }
  return manifest
}

async function runFixtureGit(run, cwd, args, env) {
  const result = await run('git', args, { cwd, env: env ?? process.env, timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed for A/B fixture: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

async function writeFixtureFile(root, relativePath, content) {
  const target = join(root, ...relativePath.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

export async function materializeFixture(source, destination, options = {}) {
  const manifest = options.manifest ?? await readFixtureManifest(source, options)
  const run = options.runProcess ?? runProcess
  await removeTree(destination)
  await cp(source, destination, {
    recursive: true,
    filter: path => {
      const pathFromRoot = relative(source, path).replaceAll('\\', '/')
      if (pathFromRoot === '') return true
      return pathFromRoot !== '.git'
        && !pathFromRoot.startsWith('.git/')
        && pathFromRoot !== 'node_modules'
        && !pathFromRoot.startsWith('node_modules/')
    },
  })
  await runFixtureGit(run, destination, ['init', '-b', 'main'])
  await runFixtureGit(run, destination, ['config', 'user.name', manifest.git.authorName])
  await runFixtureGit(run, destination, ['config', 'user.email', manifest.git.authorEmail])
  await runFixtureGit(run, destination, ['add', '-A'])
  const commitDate = manifest.git.commitDate ?? '2026-01-01T00:00:00Z'
  const gitEnv = {
    ...(options.env ?? process.env),
    GIT_AUTHOR_NAME: manifest.git.authorName,
    GIT_AUTHOR_EMAIL: manifest.git.authorEmail,
    GIT_COMMITTER_NAME: manifest.git.authorName,
    GIT_COMMITTER_EMAIL: manifest.git.authorEmail,
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
  }
  await runFixtureGit(run, destination, ['commit', '-m', manifest.git.initialCommitMessage], gitEnv)
  for (const entry of manifest.dirty) {
    await writeFixtureFile(destination, entry.path, entry.content)
  }
  return { manifest, destination }
}

function userPrompts(events) {
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return []
    return [collectModelText(event.data?.content).join('\n')]
  })
}

function uncertaintySignals(text) {
  const patterns = [
    /可能/g, /也许/g, /似乎/g, /不确定/g, /无法确认/g, /需要[^。\n]{0,20}确认/g,
    /\bmaybe\b/gi, /\bperhaps\b/gi, /\bunclear\b/gi, /\bnot sure\b/gi, /\bcannot confirm\b/gi,
  ]
  return patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[0]))
}

export function assertTrajectoryInvariants(events, expected, audits) {
  const { headerAudit, contextAudit, facts, injections } = audits
  const failures = [...headerAudit.failures, ...contextAudit.failures, ...facts.failures]
  const headers = headerAudit.headers.map(item => item.header)
  const header = headers[0]
  const session = events.find(event => event.type === 'session')
  const system = typeof header?.system === 'string' ? header.system : ''
  const hasPlugin = system.includes(pluginMarker)
  const { calls, results, finalAnswer, finalTurn, timeline } = facts
  const expectedPersona = neutralPersona
    .replace('{{model}}', expected.model)
    .replace('{{cwd}}', expected.cwd)
  if (!system.startsWith(expectedPersona)) failures.push('system prompt does not start with the neutral A/B persona')
  if (injections.length === 0 || injections.some(item => !isRuntimeContextSource(item.source))) {
    failures.push('unexpected initial context sources: ' + (injections.map(item => item.source).join(', ') || '(none)'))
  }
  const prompts = userPrompts(events)
  if (prompts.length !== 1 || prompts[0] !== expected.prompt) {
    failures.push('session does not contain exactly the assigned ordinary user prompt')
  }
  for (const [index, current] of headers.entries()) {
    const tools = Array.isArray(current?.tools) ? current.tools : []
    const expectedTools = expected.variant === 'plugin' ? PTC_DIRECT_TOOLS : ['run_code']
    if (JSON.stringify(tools.map(tool => tool?.name)) !== JSON.stringify(expectedTools)) {
      failures.push('request ' + (index + 1) + ' exposes an unexpected tool surface')
    }
    if (current?.config?.provider !== expected.provider || current?.config?.model !== expected.model) {
      failures.push('request ' + (index + 1) + ' uses unexpected model route')
    }
  }
  if (hasPlugin !== (expected.variant === 'plugin')) failures.push('session resolved to ' + (hasPlugin ? 'plugin' : 'baseline') + ' prompt')
  if (session?.cwd !== expected.cwd) failures.push('session cwd is ' + String(session?.cwd) + ' instead of ' + expected.cwd)
  if (finalTurn?.data?.reason?.kind !== 'completed') failures.push('turn ended as ' + (finalTurn?.data?.reason?.kind ?? 'missing'))
  if (finalAnswer.trim() === '') failures.push('final answer is empty')
  const journals = [...results.values()].map(result => result.journal).filter(Boolean)
  const runCodeCallIds = new Set([...calls.values()].filter(call => call.name === 'run_code').map(call => call.callId))
  if (expected.variant === 'plugin' && [...runCodeCallIds].some(callId => results.get(callId)?.journal === undefined)) {
    failures.push('plugin run_code result omitted a PTC journal')
  }
  if (expected.variant === 'baseline' && journals.length > 0) failures.push('baseline unexpectedly emitted a PTC journal')
  const declaredDirectTools = expected.variant === 'plugin' ? PTC_DIRECT_TOOLS : ['run_code']
  const nativeTopLevelCalls = [...calls.values()].filter(call => !declaredDirectTools.includes(call.name))
  if (expected.variant === 'plugin' && nativeTopLevelCalls.length > 0) {
    failures.push('plugin leaked ' + nativeTopLevelCalls.length + ' non-canonical top-level tool call(s)')
  }

  const ptcWarnings = timeline.flatMap(item => item.diagnostics ?? [])
    .filter(diagnostic => diagnostic.severity !== 'error')
  if (ptcWarnings.length > 0) {
    failures.push('ordinary task emitted ' + ptcWarnings.length + ' non-error PTC diagnostic(s)')
  }
  return {
    failures,
    headers,
    header,
    session,
    system,
    ptcWarnings,
    nativeTopLevelCalls,
  }
}

export function computeMetrics(facts, audits) {
  const { modelRequestAudit, contextAudit } = audits
  const { calls, results, assistantTexts, finalAnswer, usage, timeline } = facts
  const source = timeline.map(item => item.code).filter(value => typeof value === 'string')
  const sourceCounts = new Map()
  for (const value of source) sourceCounts.set(value.trim(), (sourceCounts.get(value.trim()) ?? 0) + 1)
  const repeatedSourceCalls = [...sourceCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const allAssistantText = assistantTexts.join('\n')
  const namespaceMentions = Object.fromEntries(['tools', 'repl', 'capabilities', 'code'].map(namespace => [
    namespace,
    source.reduce((sum, value) => sum + [...value.matchAll(new RegExp(`\\b${namespace}\\s*[.[]`, 'g'))].length, 0),
  ]))
  const machineMetrics = {
    modelRequests: modelRequestAudit.modelRequests,
    directCalls: calls.size,
    sourceChars: source.reduce((total, value) => total + value.length, 0),
    repeatedSourceCalls,
    resultChars: [...results.values()].reduce((total, result) => total + result.outputChars, 0),
    assistantChars: allAssistantText.length,
    tokenTraffic: Object.values(usage).reduce((sum, value) => sum + value, 0),
    runtimeContextChars: contextAudit.totalMessageChars,
  }
  return {
    source,
    repeatedSourceCalls,
    allAssistantText,
    finalAnswer,
    namespaceMentions,
    machineMetrics,
    sourceChars: machineMetrics.sourceChars,
    resultOutputChars: machineMetrics.resultChars,
    assistantTextChars: machineMetrics.assistantChars,
    nestedCallCount: timeline.reduce((sum, item) => sum + item.nestedCalls.length, 0),
    nestedErrorCount: timeline.reduce((sum, item) => sum + item.nestedCalls.filter(call => !call.ok).length, 0),
  }
}

export function analyzeSession(events, expected) {
  const headerAudit = auditRequestHeaders(events, expected.headerPolicy)
  const modelRequestAudit = auditModelRequests(events)
  const contextAudit = auditRuntimeContexts(events, expected.runtimeContexts)
  const facts = collectTrajectoryFacts(events, {
    usageKeys: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
  })
  const injections = initialInjections(events, expected.cwd)
  const audits = { headerAudit, modelRequestAudit, contextAudit, facts, injections }
  const invariants = assertTrajectoryInvariants(events, expected, audits)
  const metrics = computeMetrics(facts, audits)
  const { calls, results, usage, turnWallMs, timeline } = facts
  const { headers, header, session, system, ptcWarnings, nativeTopLevelCalls } = invariants
  invariants.failures.push(...machineBudgetFailures(metrics.machineMetrics, expected.machineBudget, expected.id))

  return {
    scenario: { id: expected.id, title: expected.title, task: expected.task },
    session: { id: session?.id, cwd: session?.cwd, createdAt: session?.createdAt },
    variant: expected.variant,
    system,
    model: header?.config,
    prompt: {
      chars: system.length,
      bytes: Buffer.byteLength(system),
      lines: system.split(/\r?\n/).length,
      sha256: sha256(system),
      normalizedSha256: sha256(normalizedForWorkspace(system, expected.cwd)),
      duplicateParagraphs: duplicateParagraphs(system),
      modelTools: (header?.tools ?? []).map(tool => tool?.name),
      runCodeSchemaChars: JSON.stringify((header?.tools ?? [])[0] ?? {}).length,
      toolsSha256: sha256(normalizedForWorkspace(JSON.stringify(header?.tools ?? []), expected.cwd)),
      hasReplSdk: /declare const repl:/.test(system),
      hasToolsSdk: /declare const tools:/.test(system),
      hasCapabilitiesSdk: /declare const capabilities:/.test(system),
      hasCodeSdk: /declare const code:/.test(system),
      injections,
      runtimeSnapshots: contextAudit.snapshots,
    },
    eventCount: events.length,
    requestCount: headers.length,
    modelCallCount: facts.messageUsages.length,
    turnWallMs,
    modelRequests: modelRequestAudit.modelRequests,
    headerEpochs: headerAudit.headerEpochs,
    headerChanges: headerAudit.headerChanges,
    historyReplacements: headerAudit.historyReplacements,
    toolCallCount: calls.size,
    toolResultCount: results.size,
    toolErrorCount: [...results.values()].filter(result => result.isError).length,
    ptcWarningCount: ptcWarnings.length,
    nativeTopLevelCallCount: nativeTopLevelCalls.length,
    canonicalizedCallCount: timeline.filter(item => /^Call .+ inside the session REPL$/.test(item.description ?? '')).length,
    nestedCallCount: metrics.nestedCallCount,
    nestedErrorCount: metrics.nestedErrorCount,
    sourceChars: metrics.sourceChars,
    repeatedSourceCalls: metrics.repeatedSourceCalls,
    resultOutputChars: metrics.resultOutputChars,
    assistantTextChars: metrics.assistantTextChars,
    usage,
    machineMetrics: metrics.machineMetrics,
    timeline,
    finalAnswerChars: metrics.finalAnswer.length,
    reasoningChars: facts.reasoningChars,
    finalAnswer: metrics.finalAnswer,
    questionMarks: (metrics.allAssistantText.match(/[?？]/g) ?? []).length,
    uncertaintySignals: uncertaintySignals(metrics.allAssistantText),
    namespaceMentions: metrics.namespaceMentions,
    diagnostics: [...new Set(ptcWarnings.map(item => item.message ?? String(item)))],
    failures: [...new Set(invariants.failures)],
  }
}


export async function loadTasks(path) {
  const tasks = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(tasks) || tasks.length < 2) throw new Error('A/B trajectory tasks must contain at least two tasks')
  const ids = new Set()
  let canaryCount = 0
  for (const task of tasks) {
    if (task === null || typeof task !== 'object' || Array.isArray(task)
      || typeof task.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id)
      || typeof task.prompt !== 'string' || task.prompt.trim() === ''
      || !['blind', 'test-gate', 'git-status', 'package-engine', 'readme-phrase', 'package-script', 'package-name']
        .includes(task.validator)) {
      throw new Error('invalid A/B trajectory task')
    }
    if (task.canary !== undefined && typeof task.canary !== 'boolean') {
      throw new Error(`${task.id}.canary must be a boolean`)
    }
    if (task.canary === true) canaryCount += 1
    if (ids.has(task.id)) throw new Error(`duplicate A/B task ${task.id}`)
    validateMachineBudget(task.machineBudget, `${task.id}.machineBudget`)
    validateRequestHeaderPolicy(task.headerPolicy)
    if (task.runtimeContexts === null || typeof task.runtimeContexts !== 'object'
      || Array.isArray(task.runtimeContexts)) throw new Error(`${task.id}.runtimeContexts must define plugin and baseline`)
    const contextVariants = Object.keys(task.runtimeContexts).sort()
    if (JSON.stringify(contextVariants) !== JSON.stringify(['baseline', 'plugin'])) {
      throw new Error(`${task.id}.runtimeContexts must define exactly plugin and baseline`)
    }
    validateRuntimeContextConfig(task.runtimeContexts.plugin)
    validateRuntimeContextConfig(task.runtimeContexts.baseline)
    ids.add(task.id)
  }
  if (canaryCount > 1) throw new Error('A/B trajectory tasks must declare at most one canary')
  return tasks
}

export async function taskOracle(task, workspace, options = {}) {
  const run = options.runProcess ?? runProcess
  if (task.validator === 'git-status') {
    const result = await run('git', ['status', '--porcelain=v1'], { cwd: workspace, timeoutMs: 30_000 })
    if (result.code !== 0) throw new Error(`cannot establish git-status oracle for ${task.id}`)
    return result.stdout.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, '')).sort()
  }
  if (task.validator === 'package-engine') {
    const engine = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).engines?.node
    if (typeof engine !== 'string' || engine.trim() === '') {
      throw new Error(`cannot establish package-engine oracle for ${task.id}`)
    }
    return engine
  }
  if (task.validator === 'package-name') {
    const name = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).name
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`cannot establish package-name oracle for ${task.id}`)
    return name
  }
  if (task.validator === 'readme-phrase') {
    return (await readFile(join(workspace, 'README.md'), 'utf8')).includes(task.phrase)
  }
  if (task.validator === 'test-gate') {
    const command = npmCliCommand(['run', 'check'], options.npm)
    const result = await run(command.executable, command.args, {
      cwd: workspace,
      timeoutMs: 10 * 60_000,
    })
    return {
      command: 'npm run check',
      exitCode: result.code,
      stdoutTail: result.stdout.slice(-4_000),
      stderrTail: result.stderr.slice(-2_000),
    }
  }
  if (task.validator === 'package-script') return { name: task.script, value: task.value }
  return undefined
}

function structuredToolResults(analysis) {
  return (analysis.timeline ?? []).flatMap((item) => {
    if (item.resultError === true || typeof item.output !== 'string') return []
    try {
      return [{ name: item.name, value: JSON.parse(item.output) }]
    } catch {
      // CodeRuntime output may contain console lines before its final primitive value.
      const lines = item.output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          return [{ name: item.name, value: JSON.parse(lines[index]) }]
        } catch {}
      }
      const finalLine = lines.at(-1)
      return finalLine === undefined ? [] : [{ name: item.name, value: finalLine }]
    }
  })
}

function pendingAnswerAssessment() {
  return { status: 'blind-pending', reason: 'free-form answer requires blind semantic review' }
}

function taskValidation(machineEvidence) {
  const answerAssessment = pendingAnswerAssessment()
  return { status: answerAssessment.status, machineEvidence, answerAssessment }
}

export async function validateTask(task, oracle, analysis, workspace) {
  if (task.validator === 'blind') {
    return taskValidation({ status: 'not-applicable' })
  }
  if (task.validator === 'package-name') {
    const expected = String(oracle)
    const results = structuredToolResults(analysis).filter(result => result.name === 'run_code')
    const matched = results.some(result => isDeepStrictEqual(result.value, expected))
    return taskValidation({
      status: matched ? 'pass' : 'fail',
      source: 'run_code-result',
      expected,
      observed: results.map(result => result.value),
    })
  }
  if (task.validator === 'git-status') {
    return taskValidation({ status: 'pass', source: 'workspace', paths: oracle })
  }
  if (task.validator === 'package-engine') {
    return taskValidation({ status: 'pass', source: 'workspace', expected: String(oracle) })
  }
  if (task.validator === 'readme-phrase') {
    return taskValidation({ status: 'pass', source: 'workspace', expectedPresent: oracle })
  }
  if (task.validator === 'test-gate') {
    return taskValidation({
      status: 'pass',
      source: 'subprocess',
      command: oracle.command,
      exitCode: oracle.exitCode,
    })
  }
  const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
  const changed = packageJson.scripts?.[oracle.name] === oracle.value
  return taskValidation({ status: changed ? 'pass' : 'fail', source: 'workspace', expected: oracle })
}

async function checkedPhase(result, {
  stdoutPath,
  stderrPath,
  failed = value => value.code !== 0,
  failureMessage,
}) {
  await writeFile(stdoutPath, result.stdout)
  await writeFile(stderrPath, result.stderr)
  if (failed(result)) throw new Error(failureMessage)
  return result
}

async function preflightConfigs({ env, runtime, artifactRoot, tasks, fixture, dshHome, scratchRoot }) {
  const overlays = {
    plugin: join(scratchRoot, 'plugin.patch.yml'),
    baseline: join(scratchRoot, 'baseline.patch.yml'),
  }
  const install = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', windowsPath(join(repoRoot, 'scripts', 'install-dev.ps1')), runtime.profile,
  ], { env: { ...env, DSH_DEV_INSTALL_NO_PAUSE: '1' }, timeoutMs: runtime.wallMs })
  await checkedPhase(install, {
    stdoutPath: join(artifactRoot, 'install.stdout.log'),
    stderrPath: join(artifactRoot, 'install.stderr.log'),
    failureMessage: `plugin installation failed; see ${relative(repoRoot, artifactRoot)}`,
  })

  const baseDump = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `${dshInvocation(runtime)} --profile '${powershellPath(runtime.profile)}' --dump-config`,
  ], { env, timeoutMs: runtime.wallMs })
  await checkedPhase({ ...baseDump, stdout: baseDump.code === 0 ? redactHeadlessConfig(baseDump.stdout) : '' }, {
    stdoutPath: join(artifactRoot, 'base-config.stdout.yml'),
    stderrPath: join(artifactRoot, 'base-config.stderr.log'),
    failed: value => value.code !== 0 || value.stderr.trim() !== '',
    failureMessage: `base DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`,
  })
  const baseRows = parseConfigDump(baseDump.stdout, 'base DSH config')
  await resolveHeadlessProvider(baseRows, runtime, dshHome)
  await writeFile(overlays.plugin, headlessConfigPatch(baseRows, runtime))
  await writeFile(overlays.baseline, headlessConfigPatch(baseRows, runtime, { disablePtcPlus: true }))
  for (const variant of ['plugin', 'baseline']) {
    await writeFile(join(artifactRoot, `${variant}.patch.yml`), redactHeadlessConfig(await readFile(overlays[variant], 'utf8')))
  }

  const resolvedConfigs = {}
  for (const variant of ['plugin', 'baseline']) {
    const dump = await runProcess('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      `${dshInvocation(runtime)} --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlays[variant]))}' --dump-config`,
    ], { env, timeoutMs: runtime.wallMs })
    await checkedPhase({ ...dump, stdout: dump.code === 0 ? redactHeadlessConfig(dump.stdout) : '' }, {
      stdoutPath: join(artifactRoot, `${variant}-config.stdout.yml`),
      stderrPath: join(artifactRoot, `${variant}-config.stderr.log`),
      failed: value => value.code !== 0 || value.stderr.trim() !== '',
      failureMessage: `${variant} DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`,
    })
    resolvedConfigs[variant] = parseConfigDump(dump.stdout, `${variant} DSH config`)
  }
  const configPreflight = validateConfigPair(resolvedConfigs.plugin, resolvedConfigs.baseline, runtime)
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify({
    runtime,
    fixture,
    tasks,
    configPreflight,
  }, null, 2) + '\n')
  return overlays
}

async function preflightKeyless({ env, runtime, artifactRoot }) {
  const command = npmCliCommand(['run', 'verify'])
  const result = await runProcess(command.executable, command.args, {
    cwd: repoRoot,
    env,
    timeoutMs: runtime.wallMs,
  })
  await checkedPhase(result, {
    stdoutPath: join(artifactRoot, 'keyless.stdout.log'),
    stderrPath: join(artifactRoot, 'keyless.stderr.log'),
    failed: value => value.code !== 0 || value.timedOut,
    failureMessage: `keyless request-contract preflight failed; see ${relative(repoRoot, artifactRoot)}/keyless.*.log`,
  })
}

async function runAllPairs({ tasks, runtime, runId, artifactRoot, runArm }) {
  const pairSpecs = tasks.flatMap(task => Array.from(
    { length: runtime.replicates },
    (_unused, index) => ({ task, replicate: index + 1 }),
  ))
  const runPair = async ({ task, replicate }) => {
    const pluginFirst = Number.parseInt(sha256(`${runId}:${task.id}:${replicate}:order`).slice(0, 2), 16) % 2 === 0
    const order = pluginFirst ? ['plugin', 'baseline'] : ['baseline', 'plugin']
    const result = {}
    for (let phase = 0; phase < order.length; phase += 1) {
      const variant = order[phase]
      result[variant] = await runArm(task, replicate, variant, phase + 1)
    }
    return { task, replicate, ...result }
  }
  const ordered = orderCanaryFirst(
    pairSpecs,
    spec => spec.task.canary === true || spec.task.validator !== 'blind',
  )
  const outcomes = await runCanaryThenConcurrent(ordered, runtime.concurrency, async (spec) => {
    try {
      return await runPair(spec)
    } catch (error) {
      return { task: spec.task, replicate: spec.replicate, error }
    }
  }, async (firstPair) => {
    if (firstPair.error !== undefined) throw firstPair.error
    const injectionSignature = variant => JSON.stringify(firstPair[variant].prompt.injections.map(item => ({
      source: item.source,
      chars: item.chars,
      normalizedSha256: item.normalizedSha256,
    })))
    const failures = [
      ...firstPair.plugin.failures,
      ...firstPair.baseline.failures,
      ...(firstPair.plugin.taskValidation?.machineEvidence?.status === 'pass'
        ? [] : [`plugin canary machine evidence is ${firstPair.plugin.taskValidation?.machineEvidence?.status ?? 'missing'}`]),
      ...(firstPair.baseline.taskValidation?.machineEvidence?.status === 'pass'
        ? [] : [`baseline canary machine evidence is ${firstPair.baseline.taskValidation?.machineEvidence?.status ?? 'missing'}`]),
      ...(injectionSignature('plugin') === injectionSignature('baseline')
        ? []
        : ['initial injections differ across the preflight pair']),
    ]
    await writeFile(join(artifactRoot, 'first-pair-preflight.json'), JSON.stringify({
      taskId: firstPair.task.id,
      replicate: firstPair.replicate,
      failures,
      pluginInjections: firstPair.plugin.prompt.injections,
      baselineInjections: firstPair.baseline.prompt.injections,
    }, null, 2) + '\n')
    if (failures.length > 0) {
      throw new Error(`first A/B pair failed model-visible context preflight; see ${relative(repoRoot, artifactRoot)}`)
    }
  })
  const errors = outcomes.flatMap(outcome => outcome.error === undefined ? [] : [outcome.error])
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} A/B pair(s) failed before report generation`)
  }
  return outcomes
}

async function assembleReport({
  tasks,
  runtime,
  fixture,
  fixtureDir,
  sessions,
  processes,
  runId,
  artifactRoot,
}) {
  const pairs = []
  const blindMap = []
  for (const task of tasks) {
    for (let replicate = 1; replicate <= runtime.replicates; replicate += 1) {
      const plugin = sessions.find(item => item.taskId === task.id && item.replicate === replicate && item.variant === 'plugin')
      const baseline = sessions.find(item => item.taskId === task.id && item.replicate === replicate && item.variant === 'baseline')
      const process = Object.fromEntries(['plugin', 'baseline'].map(variant => [
        variant,
        processes.find(item => item.taskId === task.id && item.replicate === replicate && item.variant === variant),
      ]))
      pairs.push({ taskId: task.id, prompt: task.prompt, replicate, plugin, baseline, process, delta: trajectoryDelta(plugin, baseline) })
      const flip = Number.parseInt(sha256(`${runId}:${task.id}:${replicate}`).slice(0, 2), 16) % 2 === 0
      const arms = flip ? [plugin, baseline] : [baseline, plugin]
      for (let index = 0; index < arms.length; index += 1) {
        const label = `${task.id}-r${replicate}-arm-${index + 1}`
        const arm = arms[index]
        const packet = createBlindPacket(label, task.prompt, arm)
        await writeFile(join(artifactRoot, `${label}.json`), JSON.stringify(packet, null, 2) + '\n')
        blindMap.push({ label, taskId: task.id, replicate, variant: arm.variant })
      }
    }
  }

  const contextPairingFailures = []
  for (const variant of ['plugin', 'baseline']) {
    const hashes = new Set(sessions.filter(session => session.variant === variant)
      .map(session => session.prompt.normalizedSha256))
    if (hashes.size !== 1) contextPairingFailures.push(`${variant} system prompt varied across sessions`)
  }
  for (const pair of pairs) {
    const injectionSignature = session => JSON.stringify(session.prompt.injections.map(item => ({
      source: item.source,
      chars: item.chars,
      normalizedSha256: item.normalizedSha256,
    })))
    if (injectionSignature(pair.plugin) !== injectionSignature(pair.baseline)) {
      contextPairingFailures.push(`${pair.taskId}/r${pair.replicate}: initial injections differ across arms`)
    }
  }

  const exemplar = pairs[0]
  const pluginSystem = normalizedForWorkspace(
    exemplar.plugin.system ?? await readFile(join(exemplar.plugin.directory, 'system.txt'), 'utf8'),
    exemplar.plugin.session.cwd,
  )
  const baselineSystem = normalizedForWorkspace(
    exemplar.baseline.system ?? await readFile(join(exemplar.baseline.directory, 'system.txt'), 'utf8'),
    exemplar.baseline.session.cwd,
  )
  const promptComparison = {
    pluginChars: exemplar.plugin.prompt.chars,
    baselineChars: exemplar.baseline.prompt.chars,
    deltaChars: exemplar.plugin.prompt.chars - exemplar.baseline.prompt.chars,
    pluginOnlyParagraphs: multisetDifference(paragraphs(pluginSystem), paragraphs(baselineSystem)),
    baselineOnlyParagraphs: multisetDifference(paragraphs(baselineSystem), paragraphs(pluginSystem)),
    pluginDuplicateParagraphs: exemplar.plugin.prompt.duplicateParagraphs,
    baselineDuplicateParagraphs: exemplar.baseline.prompt.duplicateParagraphs,
    sharedInitialInjections: exemplar.plugin.prompt.injections,
  }
  const report = {
    runtime,
    fixture: {
      name: fixture.fixtureName,
      version: fixture.fixtureVersion,
      contentSha256: fixture.contentSha256,
      path: relative(repoRoot, fixtureDir),
    },
    tasks,
    promptComparison,
    contextPairingFailures,
    aggregate: {
      plugin: aggregateTrajectories(sessions, 'plugin'),
      baseline: aggregateTrajectories(sessions, 'baseline'),
    },
    sessions: sessions.map(({ directory, ...session }) => ({ ...session, directory: relative(artifactRoot, directory) })),
    pairs: pairs.map(pair => ({
      taskId: pair.taskId,
      prompt: pair.prompt,
      replicate: pair.replicate,
      process: pair.process,
      delta: pair.delta,
      plugin: pair.plugin,
      baseline: pair.baseline,
    })),
    infrastructureFailures: sessions.flatMap(session => session.failures.map(failure => `${session.taskId}/r${session.replicate}/${session.variant}: ${failure}`)),
    taskFailures: sessions.filter(session => session.taskValidation?.machineEvidence?.status === 'fail')
      .map(session => `${session.taskId}/r${session.replicate}/${session.variant}`),
  }
  report.infrastructureFailures.push(...contextPairingFailures)
  Object.assign(report, pendingBlindApproval(
    report.infrastructureFailures,
    report.taskFailures,
    blindMap.length,
  ))
  await writeFile(join(artifactRoot, 'blind-map.json'), JSON.stringify(blindMap, null, 2) + '\n')
  await writeFile(join(artifactRoot, 'blind-review-rubric.md'), [
    '# Blind trajectory review',
    '',
    'Review only the `*-arm-*.json` packets. Do not inspect system prompts, raw sessions, analyses, report files, or `blind-map.json` before submitting scores.',
    '',
    'For every packet, score each dimension from 0 to 3 and cite concrete trajectory evidence:',
    '',
    '- correctness/evidence: 0 incorrect, 1 major gaps, 2 substantially correct, 3 correct and well-supported;',
    '- efficiency: 0 severe waste, 1 material avoidable work, 2 minor waste, 3 direct and proportionate;',
    '- clarity/confidence: 0 confused or unjustifiably blocked, 1 materially hesitant, 2 minor unnecessary caution, 3 clear with evidence-calibrated confidence.',
    '',
    'Do not reward or penalize a packet for using one or multiple calls by itself. Flag repeated reads, repeated source, unnecessary retries, unsupported claims, unnecessary user questions, and excessive output separately.',
    '',
  ].join('\n'))
  await writeFile(join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(artifactRoot, 'report.md'), reportMarkdown(report))
  return report
}

export async function main(env = process.env) {
  const modelRuntime = requiredModelRuntime(env, 'DSH_PTC_AB')
  const host = await preflightHeadlessHost(repoRoot, { env })
  const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
  const artifactRoot = join(repoRoot, 'artifacts', 'ab-trajectories', runId)
  await mkdir(artifactRoot, { recursive: true })
  const runtime = {
    ...modelRuntime,
    profile: env.DSH_PTC_AB_PROFILE || 'headless',
    toolsMode: HEADLESS_TOOLS_MODE,
    permissionMode: env.DSH_PTC_AB_PERMISSION_MODE || 'danger-full-access',
    replicates: positiveInteger(env.DSH_PTC_AB_REPLICATES, 'DSH_PTC_AB_REPLICATES', 2),
    concurrency: positiveInteger(env.DSH_PTC_AB_CONCURRENCY, 'DSH_PTC_AB_CONCURRENCY', 4),
    wallMs: positiveInteger(env.DSH_PTC_AB_WALL_MS, 'DSH_PTC_AB_WALL_MS', 10 * 60 * 1000),
    cwd: host.repoRootWindows,
    dshVersion: host.dshVersion,
    nodeVersion: host.nodeVersion,
    nodeExecutable: host.nodeExecutable,
    dshEntry: host.dshEntry,
    dshCommand: host.dshCommand,
  }
  const tasksFile = resolve(repoRoot, env.DSH_PTC_AB_TASKS_FILE || defaultTasksFile)
  const tasks = await loadTasks(tasksFile)
  const fixtureDir = resolve(repoRoot, env.DSH_PTC_AB_FIXTURE || relative(repoRoot, defaultFixtureDir))
  const fixture = await readFixtureManifest(fixtureDir)
  const scratchRoot = join(resolve(repoRoot, '..'), '.dsh-ptc-plus-ab', runId)
  const frozenWorkspace = join(scratchRoot, 'workspace')
  let scratchError
  try {
    await mkdir(scratchRoot, { recursive: true })
    await materializeFixture(fixtureDir, frozenWorkspace)
    const overlays = await preflightConfigs({ env, runtime, artifactRoot, tasks, fixture, dshHome: host.dshHome, scratchRoot })
    if (env.DSH_PTC_AB_CONFIG_ONLY === '1') {
      console.log(`A/B config preflight completed; artifacts: ${relative(repoRoot, artifactRoot)}`)
      return
    }
    await preflightKeyless({ env, runtime, artifactRoot })
    const oracles = new Map()
    for (const task of tasks) oracles.set(task.id, await taskOracle(task, frozenWorkspace))

    const sessionsRoot = host.sessionsRoot
    const sessions = []
    const processes = []
    const runArm = async (task, replicate, variant, phase) => {
      const directory = join(artifactRoot, `${task.id}-r${replicate}-${variant}`)
      const scratch = armScratchPaths(scratchRoot)
      const workspace = scratch.workspace
      await mkdir(directory, { recursive: true })
      await mkdir(scratch.directory, { recursive: true })
      return await withOwnedPath(scratch.directory, async () => {
        await copyWorkspace(frozenWorkspace, workspace)
        const cwd = windowsPath(workspace)
        const before = await snapshotSessionLogs(sessionsRoot)
        const startedAt = Date.now()
        let process
        try {
          process = await runProcess('pwsh.exe', [
            '-NoLogo', '-NoProfile', '-Command',
            `${dshInvocation(runtime)} --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlays[variant]))}' '${powershellPath(task.prompt)}'`,
          ], { cwd: workspace, env, timeoutMs: runtime.wallMs })
        } catch (error) {
          process = { code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, infrastructureError: error.message }
        }
        await writeFile(join(directory, 'dsh.stdout.log'), process.stdout)
        await writeFile(join(directory, 'dsh.stderr.log'), process.stderr)
        const decoded = await changedSessionLogs(sessionsRoot, before, startedAt)
        const matches = decoded.filter(candidate => {
          if (candidate.events === undefined || !userPrompts(candidate.events).includes(task.prompt)) return false
          const system = candidate.events.find(event => event.type === 'request/header')?.data?.header?.system ?? ''
          const sessionCwd = candidate.events.find(event => event.type === 'session')?.data?.cwd
            ?? candidate.events.find(event => event.type === 'session')?.cwd
          return system.includes(pluginMarker) === (variant === 'plugin') && sessionCwd === cwd
        })
        let analysis
        if (matches.length !== 1) {
          analysis = {
            variant,
            failures: [`found ${matches.length} matching session logs`],
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            timeline: [],
            prompt: { injections: [] },
            finalAnswer: '',
          }
        } else {
          const match = matches[0]
          await writeFile(join(directory, 'session.jsonl'), match.text)
          analysis = analyzeSession(match.events, {
            ...runtime,
            cwd,
            variant,
            prompt: task.prompt,
            taskId: task.id,
            machineBudget: task.machineBudget,
            headerPolicy: task.headerPolicy,
            runtimeContexts: task.runtimeContexts[variant],
          })
          await writeFile(join(directory, 'system.txt'), analysis.system)
          delete analysis.system
        }
        if (process.code !== 0) analysis.failures.push(`DSH process exited with ${process.code}`)
        if (process.timedOut) analysis.failures.push(`DSH process exceeded ${runtime.wallMs}ms`)
        if (process.infrastructureError !== undefined) analysis.failures.push(process.infrastructureError)
        analysis.failures = [...new Set(analysis.failures)]
        analysis.taskValidation = await validateTask(task, oracles.get(task.id), analysis, workspace)
        analysis.workspaceStatus = (await runProcess('git', ['status', '--porcelain=v1'], {
          cwd: workspace,
          timeoutMs: 30_000,
        })).stdout
        await writeFile(join(directory, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n')
        const session = { taskId: task.id, prompt: task.prompt, replicate, variant, directory, ...analysis }
        sessions.push(session)
        processes.push({ taskId: task.id, replicate, variant, phase, ...process })
        return session
      })
    }
    await runAllPairs({ tasks, runtime, runId, artifactRoot, runArm })
    const report = await assembleReport({
      tasks, runtime, fixture, fixtureDir, sessions, processes, runId, artifactRoot,
    })
    if (report.infrastructureFailures.length > 0 || report.taskFailures.length > 0) {
      console.error(`A/B trajectories completed with failures; see ${relative(repoRoot, artifactRoot)}/report.md`)
      process.exitCode = 1
    } else {
      console.log(`A/B machine acceptance passed; approval remains pending blind review: ${relative(repoRoot, artifactRoot)}`)
    }
  } catch (error) {
    scratchError = error
    throw error
  } finally {
    await cleanupOwnedPath(scratchRoot, scratchError)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(formatHeadlessError(error))
    process.exitCode = 1
  })
}
