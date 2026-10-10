/** Reusable user intent; no inventory, observations, authority or session state. */
export const CAPABILITY_POLICY_DEFAULT = JSON.stringify({
  schema: 'ptc-capability-policy/v1',
  defaults: { availability: 'enabled', disclosure: 'host' },
  categories: {}, mcpServers: {}, items: {},
  allocation: { baseline: true, statistics: false, budget: true },
})

/** Categories produced by the current Host integration; resources and templates share a server entry. */
export const CAPABILITY_INVENTORY_CATEGORIES = Object.freeze({ tool: 'tool', skill: 'skill', resource: 'resource' })
// The configuration format also accepts independent template/task entries supplied to the pure planner.
export const CAPABILITY_CATEGORIES = [...Object.values(CAPABILITY_INVENTORY_CATEGORIES), 'resource-template', 'task']
export const CAPABILITY_DISCLOSURES = ['host', 'full', 'on-demand', 'adaptive']
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined

/** The group pauses application, never the retained independent choices. Missing denotes historical behavior. */
export function effectiveCapabilitySettings(settings) {
  if (settings.contextEnabled !== false) return settings
  return { ...settings, enabled: false, recoveryEnabled: false, previewEnabled: false,
    statistics: { ...settings.statistics, enabled: false } }
}

export function validateCapabilityPolicy(value) {
  const fail = () => { throw new TypeError('ptc-plus: invalid capability policy') }
  if (!isRecord(value) || value.schema !== 'ptc-capability-policy/v1'
    || Object.keys(value).some(key => !['schema', 'defaults', 'categories', 'mcpServers', 'items', 'allocation'].includes(key))) fail()
  function rule(value, defaults = false) {
    if (!isRecord(value) || Object.keys(value).some(key => !['availability', 'disclosure'].includes(key))
      || (own(value, 'availability') !== undefined && !['enabled', 'closed'].includes(value.availability))
      || (own(value, 'disclosure') !== undefined && !CAPABILITY_DISCLOSURES.includes(value.disclosure))
      || defaults && (value.availability === undefined || value.disclosure === undefined)) fail()
    return { ...(value.availability === undefined ? {} : { availability: value.availability }),
      ...(value.disclosure === undefined ? {} : { disclosure: value.disclosure }) }
  }
  const rules = (values, valid) => {
    if (!isRecord(values)) fail()
    return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, value]) => { if (!valid(id)) fail(); return [id, rule(value)] }))
  }
  if (!isRecord(value.allocation) || Object.keys(value.allocation).length !== 3
    || ['baseline', 'statistics', 'budget'].some(key => typeof value.allocation[key] !== 'boolean')) fail()
  return { schema: value.schema, defaults: rule(value.defaults, true),
    categories: rules(value.categories, id => CAPABILITY_CATEGORIES.includes(id)),
    mcpServers: rules(value.mcpServers, id => Boolean(id.trim())),
    items: rules(value.items, id => Boolean(id.trim()) && !id.startsWith('mcpServers.')),
    allocation: { baseline: value.allocation.baseline, statistics: value.allocation.statistics, budget: value.allocation.budget } }
}

/** Missing policy denotes the previous configuration format, not a new default. */
export function capabilityPolicyForConfig(config) {
  if (config.capabilityPolicy !== undefined) return validateCapabilityPolicy(JSON.parse(config.capabilityPolicy))
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  if (config.capabilityManagementEnabled === true) policy.defaults.disclosure = 'adaptive'
  try { policy.allocation.statistics = JSON.parse(config.capabilityStatistics ?? '{}')?.enabled === true } catch {}
  const overrides = JSON.parse(config.capabilityOverrides ?? '{}')
  for (const [id, choice] of Object.entries(overrides)) {
    const rule = choice === 'closed' ? { availability: 'closed' } : { disclosure: choice }
    const rules = id.startsWith('mcpServers.') ? policy.mcpServers : policy.items
    const key = id.startsWith('mcpServers.') ? id.slice(11) : id
    Object.defineProperty(rules, key, { value: rule, enumerable: true, writable: true, configurable: true })
  }
  return validateCapabilityPolicy(policy)
}

/** Independent dimensions preserve the rule that supplied each decision. */
export function capabilityRule(policy, capability) {
  let availability = policy.defaults.availability, disclosure = policy.defaults.disclosure
  let availabilitySource = 'default', disclosureSource = 'default'
  const server = capability.mcpServer === undefined ? undefined : own(policy.mcpServers, capability.mcpServer)
  const apply = (rule, source) => {
    if (rule?.availability !== undefined) { availability = rule.availability; availabilitySource = source }
    if (rule?.disclosure !== undefined) { disclosure = rule.disclosure; disclosureSource = source }
  }
  apply(own(policy.categories, capability.category), `category:${capability.category}`)
  apply(server, `mcp:${capability.mcpServer}`)
  apply(own(policy.items, capability.id), `item:${capability.id}`)
  if (server?.availability === 'closed') { availability = 'closed'; availabilitySource = `mcp:${capability.mcpServer}` }
  if (capability.mcpServerCandidates?.some(id => own(policy.mcpServers, id)?.availability === 'closed')) {
    throw new TypeError(`ptc-plus: cannot determine the MCP server owner of ${capability.id}; conflicting namespaces: ${capability.mcpServerCandidates.join(', ')}`)
  }
  return { availability, disclosure, availabilitySource, disclosureSource }
}

/** Change one reusable dimension, removing only that dimension for automatic. */
export function changeCapabilityRule(policy, id, dimension, choice) {
  const next = structuredClone(policy)
  const rules = id.startsWith('mcpServers.') ? next.mcpServers : next.items
  const key = id.startsWith('mcpServers.') ? id.slice(11) : id
  const rule = { ...own(rules, key) }
  if (choice === 'automatic') delete rule[dimension]
  else rule[dimension] = choice
  if (Object.keys(rule).length) Object.defineProperty(rules, key, { value: rule, enumerable: true, writable: true, configurable: true })
  else delete rules[key]
  return validateCapabilityPolicy(next)
}
