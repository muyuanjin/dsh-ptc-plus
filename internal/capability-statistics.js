const CATEGORIES = new Set(['tool', 'skill', 'resource', 'resource-template', 'task'])
const OUTCOMES = new Set(['complete', 'failed', 'cancelled', 'unknown'])
const USE_EVIDENCE = new Map([
  ['tool', 'host-execution-result'], ['task', 'host-execution-result'], ['skill', 'skill-body-accepted'],
  ['resource', 'resource-access'], ['resource-template', 'resource-access'],
])

function fail(label) { throw new TypeError(`ptc-plus: invalid capability statistics ${label}`) }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label)
  return value
}
function identity(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) fail(label)
  return value
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(label)
  return value
}
function key(value) { return JSON.stringify(value) }
function orderSamples(a, b) { return b.eligibleOrder - a.eligibleOrder }
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

/** Bounds are explicit calibration inputs; no observation, clock or process directory is inferred. */
export function createCapabilityStatistics(configuration) {
  const options = record(configuration, 'configuration')
  const limits = {}
  for (const name of ['windowSize', 'maxFamilies', 'maxScopes', 'maxCapabilitiesPerFamily']) limits[name] = integer(options[name], name, 1)
  return freeze({ schema: 'ptc-capability-statistics/v1', status: 'usable', limits, families: [], windows: [] })
}

function observation(raw) {
  const value = record(raw, 'availability observation')
  const category = value.category
  if (!CATEGORIES.has(category)) fail('category')
  if (!['full', 'on-demand'].includes(value.disclosure)) fail('availability disclosure')
  const useEvidence = value.useEvidence ?? null
  if (useEvidence !== null && useEvidence !== USE_EVIDENCE.get(category)) fail('owner use evidence')
  const outcome = useEvidence === null ? null : value.outcome ?? 'unknown'
  if (outcome !== null && !OUTCOMES.has(outcome)) fail('owner outcome evidence')
  return {
    workspaceId: identity(value.workspaceId, 'workspace identity'),
    id: identity(value.id, 'capability identity'), revision: identity(value.revision, 'capability revision'), category,
    disclosure: value.disclosure, planRevision: identity(value.planRevision, 'plan revision'),
    used: useEvidence !== null, outcome,
  }
}

function sampleObservation(value) {
  const item = record(value, 'retained observation')
  identity(item.workspaceId, 'retained workspace identity')
  identity(item.id, 'retained capability identity')
  identity(item.revision, 'retained capability revision')
  if (!CATEGORIES.has(item.category) || typeof item.used !== 'boolean' || !Array.isArray(item.exposures) || item.exposures.length < 1) fail('retained evidence')
  if (!Array.isArray(item.outcomes) || item.outcomes.some(outcome => !OUTCOMES.has(outcome))
    || new Set(item.outcomes).size !== item.outcomes.length || item.used !== (item.outcomes.length > 0)) fail('retained outcomes')
  for (const exposure of item.exposures) {
    record(exposure, 'retained exposure')
    if (!['full', 'on-demand'].includes(exposure.disclosure)) fail('retained disclosure')
    identity(exposure.planRevision, 'retained plan revision')
  }
}

/** Validate retained state before it can supply an automatic-allocation denominator. */
export function validateCapabilityStatistics(state) {
  const value = record(state, 'state')
  if (value.schema !== 'ptc-capability-statistics/v1' || !['usable', 'capacity-exceeded'].includes(value.status)) fail('state schema or status')
  const template = createCapabilityStatistics(value.limits)
  if (!Array.isArray(value.families) || !Array.isArray(value.windows)
    || value.families.length > template.limits.maxFamilies || value.windows.length > template.limits.maxScopes) fail('state bounds')
  const familyKeys = new Set()
  const orders = new Set()
  for (const family of value.families) {
    record(family, 'retained family')
    const familyKey = key([identity(family.userId, 'user identity'), identity(family.familyId, 'family identity')])
    if (familyKeys.has(familyKey)) fail('duplicate family')
    familyKeys.add(familyKey)
    integer(family.observationRevision, 'observation revision')
    if (!['active', 'settled', 'unknown'].includes(family.settlement)) fail('family settlement')
    if (family.eligibleOrder !== null) {
      integer(family.eligibleOrder, 'qualification order', 1)
      const orderKey = key([family.userId, family.eligibleOrder])
      if (orders.has(orderKey)) fail('duplicate qualification order')
      orders.add(orderKey)
    } else if (family.settlement === 'settled') fail('settled family without qualification order')
    if (!Array.isArray(family.observations) || family.observations.length > value.limits.maxCapabilitiesPerFamily) fail('family observation bounds')
    const observationKeys = new Set()
    for (const item of family.observations) {
      sampleObservation(item)
      const observationKey = key([item.workspaceId, item.id, item.revision])
      if (observationKeys.has(observationKey)) fail('duplicate observation')
      observationKeys.add(observationKey)
      if (item.exposures.length > value.limits.maxCapabilitiesPerFamily) fail('exposure bounds')
    }
  }
  const windowKeys = new Set()
  for (const window of value.windows) {
    record(window, 'window')
    identity(window.userId, 'window user identity')
    if (window.workspaceId !== null) identity(window.workspaceId, 'window workspace identity')
    identity(window.id, 'window capability identity')
    identity(window.revision, 'window capability revision')
    integer(window.floor, 'evicted qualification frontier')
    const windowKey = key([window.userId, window.workspaceId, window.id, window.revision])
    if (windowKeys.has(windowKey)) fail('duplicate window')
    windowKeys.add(windowKey)
  }
  return value
}

function windowKey(userId, workspaceId, item) { return key([userId, workspaceId, item.id, item.revision]) }
function qualifies(family, window) {
  return family.userId === window.userId && family.settlement === 'settled' && family.eligibleOrder > window.floor
    && family.observations.some(item => item.id === window.id && item.revision === window.revision
      && (window.workspaceId === null || item.workspaceId === window.workspaceId))
}

/**
 * Public adapters supply actual family/workspace identities, monotone observation revisions,
 * and an immutable qualification order. Observations are cumulative additions, never log guesses.
 * A resumed or unknown family contributes no negative sample until owner-proven settlement.
 */
export function reduceCapabilityStatistics(previous, event) {
  validateCapabilityStatistics(previous)
  if (previous.status !== 'usable') return previous
  const value = record(event, 'event')
  if (value.type !== 'family-observation') fail('event type')
  const userId = identity(value.userId, 'user identity')
  const familyId = identity(value.familyId, 'family identity')
  const observationRevision = integer(value.observationRevision, 'observation revision')
  const settlement = value.settlement
  if (!['active', 'settled', 'unknown'].includes(settlement)) fail('family settlement')
  const eligibleOrder = value.eligibleOrder == null ? null : integer(value.eligibleOrder, 'qualification order', 1)
  if (settlement === 'settled' && eligibleOrder === null) fail('settlement qualification order')
  if (!Array.isArray(value.observations) || value.observations.length > previous.limits.maxCapabilitiesPerFamily) fail('observation bounds')
  const additions = value.observations.map(observation)
  const state = structuredClone(previous)
  let family = state.families.find(item => item.userId === userId && item.familyId === familyId)
  if (family) {
    if (family.eligibleOrder !== null && eligibleOrder !== family.eligibleOrder) fail('changed qualification order')
    if (observationRevision <= family.observationRevision) return previous
    family.observationRevision = observationRevision
    family.settlement = settlement
    family.eligibleOrder ??= eligibleOrder
  } else {
    if (eligibleOrder !== null && state.families.some(item => item.userId === userId && item.eligibleOrder === eligibleOrder)) fail('qualification order collision')
    family = { userId, familyId, observationRevision, settlement, eligibleOrder, observations: [] }
    state.families.push(family)
  }
  for (const addition of additions) {
    let retained = family.observations.find(item => item.workspaceId === addition.workspaceId && item.id === addition.id && item.revision === addition.revision)
    if (!retained) {
      retained = { workspaceId: addition.workspaceId, id: addition.id, revision: addition.revision, category: addition.category, used: false, exposures: [], outcomes: [] }
      family.observations.push(retained)
    } else if (retained.category !== addition.category) fail('changed capability category')
    retained.used ||= addition.used
    if (addition.outcome !== null && !retained.outcomes.includes(addition.outcome)) retained.outcomes.push(addition.outcome)
    const exposure = { disclosure: addition.disclosure, planRevision: addition.planRevision }
    if (!retained.exposures.some(item => item.disclosure === exposure.disclosure && item.planRevision === exposure.planRevision)) retained.exposures.push(exposure)
    for (const workspaceId of [addition.workspaceId, null]) {
      const targetKey = windowKey(userId, workspaceId, addition)
      if (!state.windows.some(item => windowKey(item.userId, item.workspaceId, item) === targetKey)) {
        state.windows.push({ userId, workspaceId, id: addition.id, revision: addition.revision, floor: 0 })
      }
    }
  }
  const retainedFamilies = new Set()
  for (const window of state.windows) {
    const eligible = state.families.filter(item => qualifies(item, window)).sort(orderSamples)
    const selected = eligible.slice(0, state.limits.windowSize)
    for (const item of selected) retainedFamilies.add(key([item.userId, item.familyId]))
    for (const item of eligible.slice(state.limits.windowSize)) window.floor = Math.max(window.floor, item.eligibleOrder)
  }
  state.families = state.families.filter(item => item.settlement !== 'settled' || retainedFamilies.has(key([item.userId, item.familyId])))
  if (state.families.length > state.limits.maxFamilies || state.windows.length > state.limits.maxScopes
    || state.families.some(item => item.observations.length > state.limits.maxCapabilitiesPerFamily
      || item.observations.some(entry => entry.exposures.length > state.limits.maxCapabilitiesPerFamily))) {
    return freeze({ ...structuredClone(previous), status: 'capacity-exceeded' })
  }
  validateCapabilityStatistics(state)
  return freeze(state)
}

/** Per-capability eligible windows; workspace and global evidence are never added together. */
export function capabilityCoverage(state, query) {
  validateCapabilityStatistics(state)
  const options = record(query, 'coverage query')
  const userId = identity(options.userId, 'coverage user identity')
  const id = identity(options.id, 'coverage capability identity')
  const revision = identity(options.revision, 'coverage capability revision')
  const workspaceId = options.workspaceId === null ? null : identity(options.workspaceId, 'coverage workspace identity')
  if (state.status !== 'usable') return { status: state.status, windowSize: state.limits.windowSize, eligible: null, used: null, coverage: null }
  const window = state.windows.find(item => item.userId === userId && item.workspaceId === workspaceId && item.id === id && item.revision === revision)
  const families = window ? state.families.filter(item => qualifies(item, window)).sort(orderSamples).slice(0, state.limits.windowSize) : []
  // A resumed family can expose a gap behind the irreversible eviction frontier.
  // Surviving samples do not prove the recent settled window until it is full again.
  if (window?.floor > 0 && families.length < state.limits.windowSize) {
    return { status: 'incomplete-window', windowSize: state.limits.windowSize, eligible: null, used: null, coverage: null }
  }
  const used = families.filter(family => family.observations.some(item => item.id === id && item.revision === revision && item.used
    && (workspaceId === null || item.workspaceId === workspaceId))).length
  return { status: 'usable', windowSize: state.limits.windowSize, eligible: families.length, used, coverage: families.length ? used / families.length : null }
}
