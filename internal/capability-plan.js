import { Buffer } from 'node:buffer'

const MANAGED_CATEGORIES = new Set(['tool', 'skill', 'resource', 'resource-template', 'task'])
const EXCLUDED_CATEGORIES = new Set(['language', 'node', 'repl', 'ptc-plus', 'global-binding'])
const SELECTIONS = new Set(['full', 'on-demand', 'closed'])
const CATEGORY_NAVIGATION = new Map([
  ['tool', 'Tools: search by task or tools.<name> for parameters and results.'],
  ['skill', 'Skills: search by task or skills.<name> for when to use and how to load instructions.'],
  ['resource', 'MCP resources: search by server or resource purpose.'],
  ['resource-template', 'MCP templates: search by server or resource purpose.'],
  ['task', 'Tasks: search by the operation you need.'],
])

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function record(value, label) {
  if (!isRecord(value)) throw new TypeError(`ptc-plus: ${label} must be an object`)
  return value
}

function text(value, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new TypeError(`ptc-plus: ${label} must be a non-empty string`)
  return value
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`ptc-plus: ${label} must be a non-negative integer`)
  return value
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member)
    Object.freeze(value)
  }
  return value
}

function compareIds(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }

function catalog(entries, priority = () => 0) {
  const dependencies = new Map()
  const blocks = []
  const groups = Map.groupBy([...entries].sort(compareIds), priority)
  for (const [, group] of [...groups].sort(([a], [b]) => a - b)) {
    const additions = new Map()
    for (const entry of group) {
      for (const dependency of entry.dependencies) {
        const previous = dependencies.get(dependency.id) ?? additions.get(dependency.id)
        if (previous !== undefined && previous !== dependency.text) throw new TypeError(`ptc-plus: conflicting shared contract ${dependency.id}`)
        if (previous === undefined) additions.set(dependency.id, dependency.text)
      }
    }
    for (const [id, body] of [...additions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      dependencies.set(id, body)
      blocks.push(`### dependency:${id}\n${body}`)
    }
    blocks.push(...group.map(entry => `### ${entry.id}\n${entry.contract}`))
  }
  return blocks.join('\n\n')
}

function statisticsSettings(value) {
  if (!value || value.enabled === false) return { usable: false, reason: 'statistics-disabled' }
  if (value.enabled !== true || !Number.isSafeInteger(value.windowSize) || value.windowSize < 1
    || !Number.isSafeInteger(value.minimumSamples) || value.minimumSamples < 1 || value.minimumSamples > value.windowSize
    || !Number.isFinite(value.fullThreshold) || value.fullThreshold < 0 || value.fullThreshold > 1) {
    return { usable: false, reason: 'statistics-settings-invalid' }
  }
  return { ...value, usable: true }
}

function coverage(value, settings) {
  if (!isRecord(value) || value.status !== 'usable' || value.windowSize !== settings.windowSize
    || !Number.isSafeInteger(value.eligible) || value.eligible < settings.minimumSamples || value.eligible > settings.windowSize
    || !Number.isSafeInteger(value.used) || value.used < 0 || value.used > value.eligible) return null
  return { used: value.used, eligible: value.eligible, coverage: value.used / value.eligible }
}

/** A frozen disclosure read model. It neither registers nor removes executable capabilities. */
export function createCapabilityPlan(input) {
  const options = record(input, 'capability plan input')
  const schema = 'ptc-capability-plan/v1'
  if (typeof options.enabled !== 'boolean') throw new TypeError('ptc-plus: capability management enabled must be boolean')
  const configurationRevision = text(options.configurationRevision, 'configuration revision')
  if (!Array.isArray(options.capabilities)) throw new TypeError('ptc-plus: capabilities must be an array')
  const ids = new Set()
  const excluded = []
  const capabilities = options.capabilities.map(raw => {
    const value = record(raw, 'capability')
    const id = text(value.id, 'capability id')
    if (ids.has(id)) throw new TypeError(`ptc-plus: duplicate capability identity ${id}`)
    ids.add(id)
    const revision = text(value.revision, 'capability revision')
    if (EXCLUDED_CATEGORIES.has(value.category)) {
      excluded.push({ id, revision, category: value.category })
      return null
    }
    if (!MANAGED_CATEGORIES.has(value.category)) throw new TypeError(`ptc-plus: unknown capability category ${value.category}`)
    const dependencies = value.dependencies ?? []
    if (!Array.isArray(dependencies)) throw new TypeError('ptc-plus: contract dependencies must be an array')
    return {
      id, revision, category: value.category,
      contract: text(value.contract, 'complete capability contract'),
      dependencies: dependencies.map(rawDependency => {
        const dependency = record(rawDependency, 'contract dependency')
        return { id: text(dependency.id, 'dependency id'), text: text(dependency.text, 'dependency contract') }
      }),
    }
  }).filter(Boolean).sort(compareIds)
  const bytes = value => Buffer.byteLength(value, 'utf8')
  if (!options.enabled) return freeze({
    schema, enabled: false, configurationRevision,
    entries: capabilities.map(({ id, revision, category }) => ({ id, revision, category, selection: 'host', reason: 'management-disabled' })),
    excluded: excluded.sort(compareIds), catalogText: '', directoryText: '',
    budgets: { unit: 'utf8-bytes', contractBytes: 0, directoryBytes: 0, overageBytes: 0 },
  })
  const budgetBytes = integer(options.budgetBytes, 'contract budget bytes')
  const directoryBudgetBytes = integer(options.directoryBudgetBytes, 'directory budget bytes')
  const navigationText = text(options.navigationText, 'bounded discovery guidance')
  if (bytes(navigationText) > directoryBudgetBytes) throw new RangeError('ptc-plus: discovery guidance exceeds directory byte budget')
  const manual = record(options.manual ?? {}, 'manual capability settings')
  const overrides = record(manual.overrides ?? {}, 'capability overrides')
  const baseline = manual.baseline ?? []
  if (!Array.isArray(baseline)) throw new TypeError('ptc-plus: initial common set must be an array')
  baseline.forEach(id => text(id, 'baseline capability identity'))
  const common = new Set(baseline)
  for (const [id, selection] of Object.entries(overrides)) {
    text(id, 'override capability identity')
    if (!SELECTIONS.has(selection)) throw new TypeError(`ptc-plus: invalid capability selection ${selection}`)
  }
  const settings = statisticsSettings(options.statistics)
  // Statistical damage cannot invalidate the independently valid manual configuration.
  const statisticsInput = settings.usable ? options.coverage : undefined
  const statistics = isRecord(statisticsInput) ? statisticsInput : null
  const entries = []
  const selections = new Map()
  const full = []
  const candidates = []
  for (const capability of capabilities) {
    const explicit = Object.hasOwn(overrides, capability.id) ? overrides[capability.id] : undefined
    const entry = { id: capability.id, revision: capability.revision, category: capability.category, selection: explicit ?? 'on-demand', reason: explicit ? 'manual-override' : 'baseline-not-selected' }
    entries.push(entry)
    selections.set(capability.id, entry)
    if (explicit === 'full') full.push(capability)
    if (explicit) continue
    const evidence = statistics && Object.hasOwn(statistics, capability.id) ? statistics[capability.id] : undefined
    let selectedCoverage = null
    let source = settings.reason
    if (settings.usable) {
      if (isRecord(evidence) && evidence.revision === capability.revision) {
        selectedCoverage = coverage(evidence.workspace, settings)
        source = 'workspace'
        if (!selectedCoverage) {
          selectedCoverage = coverage(evidence.global, settings)
          source = 'global'
        }
      }
      if (!selectedCoverage) source = statisticsInput !== undefined && !statistics ? 'statistics-data-invalid' : 'statistics-unavailable'
    }
    entry.statisticsReason = source
    if (selectedCoverage) {
      entry.evidence = { scope: source, ...selectedCoverage }
      entry.reason = 'coverage-below-threshold'
      if (selectedCoverage.coverage >= settings.fullThreshold) candidates.push({ capability, entry, weight: selectedCoverage.coverage })
    } else if (common.has(capability.id)) {
      entry.reason = 'baseline'
      candidates.push({ capability, entry, weight: 1 })
    }
  }
  // Whole blocks and shared type identities reproduce the final renderer's exact byte cost.
  const includedDependencies = new Map()
  let blockCount = 0
  let blockBytes = 0
  function addCost(capability, commit) {
    let count = blockCount + 1
    let size = blockBytes + bytes(`### ${capability.id}\n${capability.contract}`)
    const additions = new Map()
    for (const dependency of capability.dependencies) {
      const previous = additions.get(dependency.id) ?? includedDependencies.get(dependency.id)
      if (previous !== undefined && previous !== dependency.text) throw new TypeError(`ptc-plus: conflicting shared contract ${dependency.id}`)
      if (previous === undefined) {
        additions.set(dependency.id, dependency.text)
        size += bytes(`### dependency:${dependency.id}\n${dependency.text}`)
        count++
      }
    }
    if (commit) {
      for (const [id, body] of additions) includedDependencies.set(id, body)
      blockCount = count
      blockBytes = size
    }
    return size + Math.max(0, count - 1) * 2
  }
  for (const capability of full) addCost(capability, true)
  // Ranking includes actual UTF-8 wrappers and dependencies, not capability counts.
  for (const candidate of candidates) candidate.cost = Math.max(1, bytes(catalog([candidate.capability])))
  candidates.sort((a, b) => {
    return b.weight / b.cost - a.weight / a.cost || compareIds(a.capability, b.capability)
  })
  for (const candidate of candidates) {
    if (addCost(candidate.capability, false) <= budgetBytes) {
      addCost(candidate.capability, true)
      full.push(candidate.capability)
      candidate.entry.selection = 'full'
      candidate.entry.reason = candidate.entry.evidence ? 'statistical-coverage' : 'baseline'
    } else candidate.entry.reason = 'contract-budget'
  }
  // Statistics choose membership, never the order of unchanged contract groups.
  const catalogText = catalog(full,
    capability => overrides[capability.id] === 'full' ? 0 : common.has(capability.id) ? 1 : 2)
  let directoryText = navigationText
  const directoryCategories = []
  const availableCategories = new Set(capabilities.filter(capability => selections.get(capability.id).selection !== 'closed')
    .map(capability => capability.category))
  for (const [category, guidance] of CATEGORY_NAVIGATION) {
    if (!availableCategories.has(category)) continue
    const proposed = `${directoryText}\n${guidance}`
    if (bytes(proposed) <= directoryBudgetBytes) {
      directoryText = proposed
      directoryCategories.push(category)
    }
  }
  return freeze({
    schema, enabled: true, configurationRevision, entries,
    excluded: excluded.sort(compareIds), catalogText, directoryText, directoryCategories,
    budgets: { unit: 'utf8-bytes', budgetBytes, directoryBudgetBytes, contractBytes: bytes(catalogText), directoryBytes: bytes(directoryText), overageBytes: Math.max(0, bytes(catalogText) - budgetBytes) },
    unresolvedConfigurationIds: [...new Set([...baseline, ...Object.keys(overrides)])].filter(id => !capabilities.some(entry => entry.id === id)).sort(),
    statisticsStatus: settings.usable ? 'enabled' : settings.reason,
  })
}
