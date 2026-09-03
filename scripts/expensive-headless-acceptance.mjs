import { createHash, randomInt, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PTC_DIRECT_TOOLS,
  auditEditTransports,
  auditModelRequests,
  auditRequestHeaders,
  auditRuntimeContexts,
  collectModelText as collectText,
  collectTrajectoryFacts,
  machineBudgetFailures,
  positiveInteger,
  validateEditTransports,
  validateMachineBudget,
  validateRequestHeaderPolicy,
  validateRuntimeContextConfig,
} from './acceptance-contract.mjs'
import { runCanaryThenConcurrent } from './acceptance-orchestration.mjs'
import {
  scenarioMarkdown,
  summarizeRuntimeSnapshots,
  summaryMarkdown,
} from './expensive-acceptance-report.mjs'
import {
  NEUTRAL_PERSONA,
  changedSessionLogs,
  createProcessRunner,
  formatHeadlessError,
  headlessConfigPatch,
  parseConfigDump,
  parseEvents,
  powershellPath,
  preflightHeadlessHost,
  requiredModelRuntime,
  snapshotSessionLogs,
  validateHeadlessRuntimeConfig,
  validateNeutralConfig,
  windowsPath,
} from './headless-host.mjs'
import { npmCliCommand } from './npm-cli.mjs'

export { summarizeRuntimeSnapshots } from './expensive-acceptance-report.mjs'
export { parseEvents } from './headless-host.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runProcess = createProcessRunner(repoRoot)
const defaultScenarioFile = join(repoRoot, 'scripts', 'expensive-acceptance-scenarios.json')
const neutralPersona = NEUTRAL_PERSONA
const runtimeSnapshotSource = 'plugin:@deepseek-ai/dsh-system-prompt:snapshot'
export const MAX_MODEL_RESULT_CHARS = 8_192

export function parseAcceptanceConfig(text, label = 'DSH config dump') {
  return parseConfigDump(text, label)
}

export function validateAcceptanceConfig(rows, runtime, expectations = {}) {
  validateNeutralConfig(rows, 'acceptance config', 'enabled')
  validateHeadlessRuntimeConfig(rows, 'acceptance config', runtime)
  if (expectations.looseTopLevelFunctionClassRedeclarations === true) {
    const ptcPlus = rows.find(row => row?.id === 'ptc-plus')
    if (ptcPlus?.config?.looseTopLevelFunctionClassRedeclarations !== true) {
      throw new Error('acceptance config does not enable looseTopLevelFunctionClassRedeclarations')
    }
  }
  return true
}

export function valueContains(root, expected) {
  if (typeof expected !== 'string') throw new TypeError('expected value fragment must be a string')
  const pending = [root]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      if (String(current).includes(expected)) return true
      continue
    }
    if (seen.has(current)) continue
    seen.add(current)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) pending.push(descriptor.value)
    }
  }
  return false
}

function sourceUserPrompts(events) {
  return events.flatMap(event => {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') return []
    return [collectText(event.data?.content).join('\n')]
  })
}

function renderTemplate(value, variables) {
  if (typeof value !== 'string') return value
  return value.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`unknown acceptance template variable ${name}`)
    return String(variables[name])
  })
}

function renderTree(value, variables) {
  if (Array.isArray(value)) return value.map(item => renderTree(item, variables))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTree(item, variables)]))
  }
  if (typeof value === 'string') {
    const match = value.match(/^\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}$/)
    if (match !== null) {
      if (!Object.hasOwn(variables, match[1])) throw new Error(`unknown acceptance template variable ${match[1]}`)
      return variables[match[1]]
    }
  }
  return renderTemplate(value, variables)
}

function assertScenarioDescriptor(value, ids) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('acceptance scenario must be an object')
  if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)) {
    throw new Error('acceptance scenario id must be a lowercase kebab-case string')
  }
  if (ids.has(value.id)) throw new Error(`duplicate acceptance scenario id ${value.id}`)
  ids.add(value.id)
  if (typeof value.title !== 'string' || value.title.trim() === '') throw new Error(`${value.id}: title is required`)
  if (typeof value.task !== 'string' || value.task.trim() === '') throw new Error(`${value.id}: task is required`)
  if (typeof value.default !== 'boolean') throw new Error(`${value.id}: default must be a boolean`)
  if (value.expect === null || typeof value.expect !== 'object' || Array.isArray(value.expect)) {
    throw new Error(`${value.id}: expect must be an object`)
  }
  validateMachineBudget(value.expect.machineBudget, `${value.id}.expect.machineBudget`)
  validateRequestHeaderPolicy(value.expect.headerPolicy)
  validateRuntimeContextConfig(value.expect.runtimeContexts)
  if (value.expect.editTransports !== undefined) {
    validateEditTransports(value.expect.editTransports, `${value.id}.expect.editTransports`, {
      allowTemplates: true,
    })
  }
  if (value.expect.requiredSourceCellSequence !== undefined) {
    if (!Array.isArray(value.expect.requiredSourceCellSequence)
      || value.expect.requiredSourceCellSequence.length === 0
      || value.expect.requiredSourceCellSequence.some(group => group === null
        || typeof group !== 'object'
        || Array.isArray(group)
        || Object.keys(group).some(key => !['includes', 'excludes'].includes(key))
        || !Array.isArray(group.includes)
        || group.includes.length === 0
        || group.includes.some(fragment => typeof fragment !== 'string' || fragment === '')
        || (group.excludes !== undefined && (!Array.isArray(group.excludes)
          || group.excludes.some(fragment => typeof fragment !== 'string' || fragment === ''))))) {
      throw new Error(`${value.id}.expect.requiredSourceCellSequence must contain include/exclude groups`)
    }
  }
}

export function selectScenarioDescriptors(descriptors, selectedIds) {
  if (!Array.isArray(descriptors)) throw new Error('acceptance scenario file must contain an array')
  const ids = new Set()
  for (const descriptor of descriptors) assertScenarioDescriptor(descriptor, ids)
  const selected = selectedIds === undefined
    ? descriptors.filter(descriptor => descriptor.default)
    : selectedIds.map((id) => {
        const found = descriptors.find(descriptor => descriptor.id === id)
        if (found === undefined) throw new Error(`unknown acceptance scenario ${id}`)
        return found
      })
  if (selected.length === 0) throw new Error('expensive acceptance requires at least one scenario per run')
  return selected
}

async function prepareScenarios(scenarioFile, artifactRoot, selectedIds) {
  const descriptors = selectScenarioDescriptors(JSON.parse(await readFile(scenarioFile, 'utf8')), selectedIds)

  return await Promise.all(descriptors.map(async (descriptor) => {
    const scenarioRoot = join(artifactRoot, descriptor.id)
    await mkdir(scenarioRoot, { recursive: true })
    const nonce = randomUUID().replaceAll('-', '')
    const left = randomInt(10_000, 100_000)
    const right = randomInt(10_000, 100_000)
    const longLiteral = Array.from(
      { length: 32 }, (_, index) => `record-${String(index).padStart(3, '0')}`,
    ).join('|')
    const variables = {
      nonce,
      secret: `ptc-${nonce}`,
      binding: `probe_${nonce.slice(0, 12)}`,
      left,
      right,
      expectedSum: left + right,
      expectedProduct: left * right,
      longLiteral,
      expectedRepair: `${longLiteral.length}:${longLiteral.slice(-8)}`,
      expectedAdjustment: `adjusted:${longLiteral.length}:${longLiteral.slice(-8)}`,
      functionName: `iterate_${nonce.slice(0, 10)}`,
      className: `Iteration_${nonce.slice(0, 10)}`,
    }
    variables.completedSource = `const adjustmentSource = ${JSON.stringify(longLiteral)}\nreturn adjustmentSource.length`
    variables.adjustmentOld = 'return adjustmentSource.length'
    variables.adjustmentNew = 'return `adjusted:${adjustmentSource.length}:${adjustmentSource.slice(-8)}`'
    variables.adjustedSource = `${variables.completedSource.slice(0, -variables.adjustmentOld.length)}${variables.adjustmentNew}`
    variables.rejectedSource = `const repairSource = ${JSON.stringify(longLiteral)}\nreturn repairSource.length:`
    variables.repairOld = 'return repairSource.length:'
    variables.repairNew = 'return `${repairSource.length}:${repairSource.slice(-8)}`'
    variables.repairedSource = `${variables.rejectedSource.slice(0, -variables.repairOld.length)}${variables.repairNew}`
    variables.expectedChild = `${variables.secret}:${variables.secret.length}`
    if (descriptor.fixture !== undefined) {
      const name = renderTemplate(descriptor.fixture.name, variables)
      if (typeof name !== 'string' || name === '' || name !== name.split(/[\\/]/).at(-1)) {
        throw new Error(`${descriptor.id}: fixture name must be one file name`)
      }
      const fixturePath = join(scenarioRoot, name)
      const content = renderTemplate(descriptor.fixture.content, variables)
      await writeFile(fixturePath, content)
      variables.fixturePath = windowsPath(fixturePath)
      variables.fixtureSha256 = createHash('sha256').update(content).digest('hex')
    }
    const expect = renderTree(descriptor.expect, variables)
    if (expect.editTransports !== undefined) {
      validateEditTransports(expect.editTransports, `${descriptor.id}.expect.editTransports`)
    }
    return {
      ...descriptor,
      root: scenarioRoot,
      task: renderTemplate(descriptor.task, variables),
      expect,
    }
  }))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function inspectLog(events, scenario, expectedRuntime) {
  const failures = []
  const warnings = []
  const expect = scenario.expect
  const allowedDiagnosticCodes = new Set(expect.allowedDiagnosticCodes ?? [])
  const headerAudit = auditRequestHeaders(events, expect.headerPolicy)
  const modelRequestAudit = auditModelRequests(events)
  const contextAudit = auditRuntimeContexts(events, expect.runtimeContexts)
  const facts = collectTrajectoryFacts(events, { compareUsageChunks: false })
  failures.push(...headerAudit.failures, ...contextAudit.failures, ...facts.failures)
  const {
    calls, results, assistantTexts, usage, finalTurn, turnStartedAt, turnEndedAt, timeline,
  } = facts
  const requestHeaders = headerAudit.headers.map(item => item.header)
  const requestHeader = requestHeaders[0]
  const contextSources = contextAudit.sources
  const runtimeSnapshots = contextAudit.snapshots
  const header = events.find(event => event.type === 'session')

  for (const call of calls.values()) {
    if (!PTC_DIRECT_TOOLS.includes(call.name)) {
      failures.push('model-facing call is outside the declared PTC transport: ' + String(call.name))
      continue
    }
    if (call.name === 'run_code' && (typeof call.code !== 'string' || typeof call.description !== 'string')) {
      failures.push('run_code call ' + call.callId + ' lacks code or description')
      continue
    }
    if (call.name === 'edit_run_code') {
      const args = call.arguments
      const keys = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : []
      if (keys.length !== 1 || !['edits', 'regex_edits'].includes(keys[0]) || !Array.isArray(args[keys[0]])) {
        failures.push('edit_run_code call ' + call.callId + ' does not contain exactly one edit delta array')
      }
    }
  }
  for (const result of results.values()) {
    if (result.journalStatus === undefined) failures.push('PTC transport result ' + result.callId + ' has no journal')
    for (const nested of result.nestedCalls) {
      if (!nested.ok) warnings.push('handled nested error in ' + result.callId + ': ' + nested.global + '.' + nested.member + ': ' + nested.error)
    }
    if (result.outputChars > MAX_MODEL_RESULT_CHARS) {
      failures.push('capability result ' + result.callId + ' exceeds the ' + MAX_MODEL_RESULT_CHARS + '-character model-content budget (' + result.outputChars + ' chars)')
    }
    const expectedRejection = result.isError && result.journal?.status === 'noop'
      && result.journal.diagnostics.some(diagnostic => allowedDiagnosticCodes.has(diagnostic.code))
    if (result.isError && !expectedRejection) failures.push('tool result reports error for ' + result.callId)
    for (const diagnostic of result.diagnostics) {
      const rendered = diagnostic.severity + '[' + diagnostic.code + ']: ' + diagnostic.message
      warnings.push(rendered)
      if (diagnostic.severity === 'error' && !allowedDiagnosticCodes.has(diagnostic.code)) {
        failures.push('blocking PTC diagnostic: ' + rendered)
      }
    }
  }

  const modelTools = Array.isArray(requestHeader?.tools) ? requestHeader.tools : []
  for (const [index, current] of requestHeaders.entries()) {
    const tools = Array.isArray(current?.tools) ? current.tools : []
    if (JSON.stringify(tools.map(tool => tool?.name)) !== JSON.stringify(PTC_DIRECT_TOOLS)) {
      failures.push('request ' + (index + 1) + ' model-visible tools are ' + (tools.map(tool => tool?.name).join(', ') || 'missing') + ' instead of ' + PTC_DIRECT_TOOLS.join(', '))
    }
    if (current?.config?.provider !== expectedRuntime.provider || current?.config?.model !== expectedRuntime.model) {
      failures.push('request ' + (index + 1) + ' model route is ' + (current?.config?.provider ?? 'missing') + '/' + (current?.config?.model ?? 'missing'))
    }
  }
  const system = typeof requestHeader?.system === 'string' ? requestHeader.system : ''
  const expectedPersona = neutralPersona
    .replace('{{model}}', expectedRuntime.model)
    .replace('{{cwd}}', expectedRuntime.cwd)
  if (!system.startsWith(expectedPersona)) failures.push('system prompt does not start with the neutral acceptance persona')
  if (contextSources.length === 0 || contextSources.some(source => source !== runtimeSnapshotSource)) {
    failures.push('unexpected initial context sources: ' + (contextSources.join(', ') || '(none)'))
  }
  if (!/declare const tools:/.test(system) || !/declare const capabilities:/.test(system)) {
    failures.push('program SDK omits tools or capabilities')
  }
  if (/declare const repl:/.test(system) || /declare const code:/.test(system)) {
    failures.push('program SDK eagerly expands advanced repl or code capabilities')
  }

  if (Array.isArray(expect.requiredDirectToolSequence)
    && JSON.stringify(timeline.map(call => call.name)) !== JSON.stringify(expect.requiredDirectToolSequence)) {
    failures.push('direct tool sequence is ' + (timeline.map(call => call.name).join(', ') || 'empty') + ' instead of ' + expect.requiredDirectToolSequence.join(', '))
  }
  if (expect.editTransports !== undefined) failures.push(...auditEditTransports(timeline, expect.editTransports))
  if (timeline.length < (expect.minCells ?? 1)) failures.push('only ' + timeline.length + ' cells; expected at least ' + expect.minCells)
  if (expect.maxCells !== undefined && timeline.length > expect.maxCells) {
    failures.push(timeline.length + ' cells exceed scenario maximum ' + expect.maxCells)
  }
  const statuses = timeline.map(cell => cell.journalStatus).filter(status => status !== undefined)
  if (Array.isArray(expect.allowedJournalStatuses)) {
    for (const status of statuses) {
      if (!expect.allowedJournalStatuses.includes(status)) failures.push('journal status ' + status + ' is not allowed by scenario')
    }
  }
  for (const required of expect.requiredJournalStatuses ?? []) {
    if (!statuses.includes(required)) failures.push('scenario did not produce required journal status ' + required)
  }
  for (const description of expect.requiredCellDescriptions ?? []) {
    if (!timeline.some(cell => cell.description === description)) {
      failures.push('scenario did not produce a cell described as ' + JSON.stringify(description))
    }
  }
  let sourceSequenceCursor = 0
  let sourceOffset = 0
  for (const fragment of expect.requiredSourceSequence ?? []) {
    let index = -1
    let fragmentOffset = -1
    for (let candidate = sourceSequenceCursor; candidate < timeline.length; candidate += 1) {
      const code = timeline[candidate]?.code
      if (typeof code !== 'string') continue
      const offset = candidate === sourceSequenceCursor ? sourceOffset : 0
      const found = code.indexOf(fragment, offset)
      if (found >= 0) {
        index = candidate
        fragmentOffset = found
        break
      }
    }
    if (index < 0) {
      failures.push('required source fragment is missing after cell ' + sourceSequenceCursor + ': ' + JSON.stringify(fragment))
      break
    }
    sourceSequenceCursor = index
    sourceOffset = fragmentOffset + fragment.length
  }
  let sourceCellCursor = 0
  for (const group of expect.requiredSourceCellSequence ?? []) {
    const index = timeline.findIndex((cell, candidate) => candidate >= sourceCellCursor
      && typeof cell.code === 'string'
      && group.includes.every(fragment => cell.code.includes(fragment))
      && (group.excludes ?? []).every(fragment => !cell.code.includes(fragment)))
    if (index < 0) {
      failures.push('required source cell group is missing after cell ' + sourceCellCursor + ': ' + JSON.stringify(group))
      break
    }
    sourceCellCursor = index + 1
  }
  const nestedCalls = timeline.flatMap(cell => cell.nestedCalls ?? [])
  for (const required of expect.requiredCalls ?? []) {
    const callsForMember = nestedCalls.filter(call => call.global === required.global && call.member === required.member)
    const matching = callsForMember.filter(call => call.ok)
    if (matching.length < (required.min ?? 1)) {
      failures.push('only ' + matching.length + ' successful ' + required.global + '.' + required.member + ' calls; expected at least ' + (required.min ?? 1))
    }
    if (required.max !== undefined && callsForMember.length > required.max) {
      failures.push(callsForMember.length + ' ' + required.global + '.' + required.member + ' calls exceed scenario maximum ' + required.max)
    }
    for (const expected of required.valueIncludes ?? []) {
      if (!matching.some(call => valueContains(call.value, expected))) {
        failures.push(required.global + '.' + required.member + ' recorded value omits ' + JSON.stringify(expected))
      }
    }
  }
  let sequenceCursor = 0
  for (const required of expect.requiredCallSequence ?? []) {
    const index = nestedCalls.findIndex((call, candidate) => candidate >= sequenceCursor
      && call.ok && call.global === required.global && call.member === required.member)
    if (index < 0) {
      failures.push('required call sequence is missing ' + required.global + '.' + required.member)
      break
    }
    sequenceCursor = index + 1
  }
  if (typeof expect.continuityBinding === 'string') {
    const escaped = escapeRegExp(expect.continuityBinding)
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`)
    const reference = new RegExp(`\\b${escaped}\\b`)
    const declarationIndex = timeline.findIndex(cell => declaration.test(cell.code ?? ''))
    const reuseIndex = timeline.findIndex((cell, index) => index > declarationIndex
      && reference.test(cell.code ?? '') && !declaration.test(cell.code ?? ''))
    if (declarationIndex < 0 || reuseIndex < 0) failures.push('binding ' + expect.continuityBinding + ' was not declared then reused across cells')
    if (declarationIndex >= 0 && expect.declarationCellHasValue !== undefined
      && timeline[declarationIndex]?.completion?.hasValue !== expect.declarationCellHasValue) {
      failures.push('binding declaration cell completion hasValue is ' + String(timeline[declarationIndex]?.completion?.hasValue) + ' instead of ' + expect.declarationCellHasValue)
    }
  }
  const completionValues = timeline
    .filter(cell => cell.completion?.kind === 'return' && cell.completion.hasValue)
    .map(cell => cell.completion.value)
  for (const expected of expect.completionEqualsAny ?? []) {
    if (!completionValues.some(value => Object.is(value, expected))) {
      failures.push('decoded cell completions do not equal ' + JSON.stringify(expected))
    }
  }
  for (const expected of expect.completionIncludes ?? []) {
    if (!completionValues.some(value => valueContains(value, expected))) {
      failures.push('decoded cell completion omits ' + JSON.stringify(expected))
    }
  }
  if (finalTurn?.data?.reason?.kind !== 'completed') {
    failures.push('turn ended as ' + (finalTurn?.data?.reason?.kind ?? 'missing'))
  }
  if (header?.cwd !== expectedRuntime.cwd) failures.push('session cwd is ' + String(header?.cwd) + ' instead of ' + expectedRuntime.cwd)
  const finalAnswer = assistantTexts.at(-1) ?? ''
  if (finalAnswer.trim() === '') failures.push('final answer is empty')
  for (const expected of expect.finalAnswerIncludes ?? []) {
    if (!finalAnswer.includes(expected)) failures.push('final answer omits expected value ' + JSON.stringify(expected))
  }

  const modelSources = timeline.filter(call => call.name === 'run_code' && typeof call.code === 'string')
    .map(call => call.code)
  const sourceCounts = new Map()
  for (const source of modelSources) sourceCounts.set(source.trim(), (sourceCounts.get(source.trim()) ?? 0) + 1)
  const machineMetrics = {
    modelRequests: modelRequestAudit.modelRequests,
    directCalls: calls.size,
    sourceChars: modelSources.reduce((total, source) => total + source.length, 0),
    repeatedSourceCalls: [...sourceCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    resultChars: [...results.values()].reduce((total, result) => total + result.outputChars, 0),
    assistantChars: assistantTexts.join('\n').length,
    tokenTraffic: Object.values(usage).reduce((total, value) => total + value, 0),
    runtimeContextChars: contextAudit.totalMessageChars,
  }
  if (expect.machineBudget !== undefined) {
    failures.push(...machineBudgetFailures(machineMetrics, expect.machineBudget, scenario.id))
  }

  return {
    scenario: { id: scenario.id, title: scenario.title, task: scenario.task },
    session: { id: header?.id, cwd: header?.cwd, createdAt: header?.createdAt },
    model: requestHeader?.config,
    prompt: {
      chars: system.length,
      modelTools: modelTools.map(tool => tool?.name),
      hasReplSdk: /declare const repl:/.test(system),
      hasToolsSdk: /declare const tools:/.test(system),
      hasCapabilitiesSdk: /declare const capabilities:/.test(system),
      hasCodeSdk: /declare const code:/.test(system),
      runtimeSnapshots,
    },
    eventCount: events.length,
    modelRequests: modelRequestAudit.modelRequests,
    headerEpochs: headerAudit.headerEpochs,
    headerChanges: headerAudit.headerChanges,
    historyReplacements: headerAudit.historyReplacements,
    turnWallMs: turnStartedAt === undefined || turnEndedAt === undefined ? undefined : turnEndedAt - turnStartedAt,
    usage,
    machineMetrics,
    toolCallCount: calls.size,
    toolResultCount: results.size,
    timeline,
    finalAnswerChars: finalAnswer.length,
    diagnostics: [...new Set(warnings)],
    failures: [...new Set(failures)],
  }
}


export async function main(env = process.env) {
  const modelRuntime = requiredModelRuntime(env, 'DSH_PTC_ACCEPTANCE')
  const host = await preflightHeadlessHost(repoRoot, { env })
  const runId = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
  const artifactRoot = join(repoRoot, 'artifacts', 'expensive', runId)
  await mkdir(artifactRoot, { recursive: true })
  const runtime = {
    ...modelRuntime,
    profile: env.DSH_PTC_ACCEPTANCE_PROFILE || 'headless',
    toolsMode: 'code',
    permissionMode: env.DSH_PTC_ACCEPTANCE_PERMISSION_MODE || 'danger-full-access',
    concurrency: positiveInteger(env.DSH_PTC_ACCEPTANCE_CONCURRENCY, 'DSH_PTC_ACCEPTANCE_CONCURRENCY', 3),
    wallMs: positiveInteger(env.DSH_PTC_ACCEPTANCE_WALL_MS, 'DSH_PTC_ACCEPTANCE_WALL_MS', 10 * 60 * 1000),
    dshVersion: host.dshVersion,
  }
  const scenarioFile = resolve(repoRoot, env.DSH_PTC_ACCEPTANCE_SCENARIO_FILE || defaultScenarioFile)
  const selectedIds = env.DSH_PTC_ACCEPTANCE_SCENARIOS === undefined
    ? undefined
    : env.DSH_PTC_ACCEPTANCE_SCENARIOS.split(',').map(value => value.trim()).filter(Boolean)
  const scenarios = await prepareScenarios(scenarioFile, artifactRoot, selectedIds)
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify({
    scenarioFile,
    selectedIds: scenarios.map(scenario => scenario.id),
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      title: scenario.title,
      task: scenario.task,
      expect: scenario.expect,
    })),
  }, null, 2) + '\n')
  const overlay = join(artifactRoot, 'acceptance.patch.yml')

  const install = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', windowsPath(join(repoRoot, 'scripts', 'install-dev.ps1')), runtime.profile,
  ], {
    env: { ...env, DSH_DEV_INSTALL_NO_PAUSE: '1' },
    timeoutMs: runtime.wallMs,
  })
  await writeFile(join(artifactRoot, 'install.stdout.log'), install.stdout)
  await writeFile(join(artifactRoot, 'install.stderr.log'), install.stderr)
  if (install.code !== 0) throw new Error(`plugin installation failed; see ${relative(repoRoot, artifactRoot)}/install.*.log`)

  const baseDump = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `& dsh --profile '${powershellPath(runtime.profile)}' --dump-config`,
  ], { env, timeoutMs: runtime.wallMs })
  await writeFile(join(artifactRoot, 'base-config.stdout.yml'), baseDump.stdout)
  await writeFile(join(artifactRoot, 'base-config.stderr.log'), baseDump.stderr)
  if (baseDump.code !== 0 || baseDump.stderr.trim() !== '') {
    throw new Error(`base DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`)
  }
  const baseRows = parseAcceptanceConfig(baseDump.stdout, 'base DSH config')
  const enableFunctionClassRedeclarations = scenarios.some(
    scenario => scenario.id === 'function-class-redeclaration-iteration',
  )
  await writeFile(overlay, headlessConfigPatch(baseRows, runtime, {
    looseTopLevelFunctionClassRedeclarations: enableFunctionClassRedeclarations,
  }))
  const resolvedDump = await runProcess('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `& dsh --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlay))}' --dump-config`,
  ], { env, timeoutMs: runtime.wallMs })
  await writeFile(join(artifactRoot, 'acceptance-config.stdout.yml'), resolvedDump.stdout)
  await writeFile(join(artifactRoot, 'acceptance-config.stderr.log'), resolvedDump.stderr)
  if (resolvedDump.code !== 0 || resolvedDump.stderr.trim() !== '') {
    throw new Error(`acceptance DSH config preflight failed; see ${relative(repoRoot, artifactRoot)}`)
  }
  validateAcceptanceConfig(parseAcceptanceConfig(resolvedDump.stdout, 'acceptance DSH config'), runtime, {
    looseTopLevelFunctionClassRedeclarations: enableFunctionClassRedeclarations,
  })
  if (env.DSH_PTC_ACCEPTANCE_CONFIG_ONLY === '1') {
    console.log(`expensive acceptance config preflight passed; artifacts: ${relative(repoRoot, artifactRoot)}`)
    return
  }

  const keylessCommand = npmCliCommand(['run', 'verify'])
  const keyless = await runProcess(keylessCommand.executable, keylessCommand.args, {
    cwd: repoRoot,
    env,
    timeoutMs: runtime.wallMs,
  })
  await writeFile(join(artifactRoot, 'keyless.stdout.log'), keyless.stdout)
  await writeFile(join(artifactRoot, 'keyless.stderr.log'), keyless.stderr)
  if (keyless.code !== 0 || keyless.timedOut) {
    throw new Error(`keyless request-contract preflight failed; see ${relative(repoRoot, artifactRoot)}/keyless.*.log`)
  }

  const sessionsRoot = host.sessionsRoot
  const executeScenario = async (scenario) => {
    const before = await snapshotSessionLogs(sessionsRoot)
    const startedAt = Date.now()
    let processResult
    try {
      processResult = await runProcess('pwsh.exe', [
        '-NoLogo', '-NoProfile', '-Command',
        `& dsh --profile '${powershellPath(runtime.profile)}' --patch '${powershellPath(windowsPath(overlay))}' '${powershellPath(scenario.task)}'`,
      ], {
        cwd: scenario.root,
        env,
        timeoutMs: runtime.wallMs,
      })
    } catch (error) {
      processResult = { code: 1, stdout: '', stderr: '', timedOut: false, infrastructureError: error.message }
    }
    await writeFile(join(scenario.root, 'dsh.stdout.log'), processResult.stdout)
    await writeFile(join(scenario.root, 'dsh.stderr.log'), processResult.stderr)
    const decoded = await changedSessionLogs(sessionsRoot, before, startedAt)
    const scenarioCwd = windowsPath(scenario.root)
    const matches = decoded.filter(item => item.events !== undefined
      && item.events.some(event => event.type === 'session' && event.cwd === scenarioCwd)
      && sourceUserPrompts(item.events).includes(scenario.task))
    let report
    let logFile
    if (matches.length !== 1) {
      report = {
        scenario: { id: scenario.id, title: scenario.title, task: scenario.task },
        session: {}, model: {},
        prompt: {
          chars: 0,
          modelTools: [],
          hasReplSdk: false,
          hasToolsSdk: false,
          hasCapabilitiesSdk: false,
          hasCodeSdk: false,
          runtimeSnapshots: [],
        },
        eventCount: 0, toolCallCount: 0, toolResultCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, timeline: [], finalAnswerChars: 0,
        diagnostics: [], failures: [`found ${matches.length} matching session logs; expected exactly one`],
      }
    } else {
      const match = matches[0]
      logFile = match.file
      await writeFile(join(scenario.root, 'session.jsonl'), match.text)
      report = inspectLog(match.events, scenario, { ...runtime, cwd: scenarioCwd })
    }
    if (processResult.code !== 0) report.failures.push(`DSH process exited with ${processResult.code}`)
    if (processResult.timedOut) report.failures.push(`DSH process exceeded ${runtime.wallMs}ms wall timeout`)
    if (processResult.infrastructureError !== undefined) report.failures.push(`DSH process failed to start: ${processResult.infrastructureError}`)
    report.failures = [...new Set(report.failures)]
    await writeFile(join(scenario.root, 'analysis.json'), JSON.stringify({ ...report, logFile }, null, 2) + '\n')
    await writeFile(join(scenario.root, 'analysis.md'), scenarioMarkdown(report))
    return { report, processCode: processResult.code }
  }
  const scenarioResults = await runCanaryThenConcurrent(
    scenarios,
    runtime.concurrency,
    executeScenario,
    async (canary) => {
      await writeFile(join(artifactRoot, 'canary.json'), JSON.stringify(canary, null, 2) + '\n')
      if (canary.report.failures.length > 0) {
        throw new Error(`acceptance canary failed; see ${relative(repoRoot, scenarios[0].root)}/analysis.md`)
      }
    },
  )

  const usage = scenarioResults.reduce((total, { report }) => {
    for (const name of Object.keys(total)) total[name] += report.usage[name]
    return total
  }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const summary = {
    runtime: {
      provider: runtime.provider,
      model: runtime.model,
      profile: runtime.profile,
      toolsMode: runtime.toolsMode,
      permissionMode: runtime.permissionMode,
      concurrency: runtime.concurrency,
    },
    usage,
    runtimeSnapshots: summarizeRuntimeSnapshots(
      scenarioResults.flatMap(({ report }) => report.prompt.runtimeSnapshots),
    ),
    scenarios: scenarioResults.map(({ report, processCode }) => ({
      id: report.scenario.id,
      processCode,
      toolCallCount: report.toolCallCount,
      statuses: report.timeline.map(cell => cell.journalStatus ?? 'missing'),
      failures: report.failures,
    })),
  }
  summary.failures = summary.scenarios.flatMap(item => item.failures.map(failure => `${item.id}: ${failure}`))
  await writeFile(join(artifactRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  await writeFile(join(artifactRoot, 'summary.md'), summaryMarkdown(summary))
  if (summary.failures.length > 0) {
    console.error(`expensive acceptance failed; see ${relative(repoRoot, artifactRoot)}/summary.md`)
    process.exitCode = 1
  } else {
    console.log(`expensive acceptance passed; artifacts: ${relative(repoRoot, artifactRoot)}`)
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  await main().catch((error) => {
    console.error(formatHeadlessError(error))
    process.exitCode = 1
  })
}
