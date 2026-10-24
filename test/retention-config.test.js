// The retention window is user configuration: defaults, bounds, precedence over
// the environment levers, and the effect of a non-default value on a real fold.
const { test } = await import('node:test')
const assert = (await import('node:assert/strict')).default
const {
  RETENTION_BOUNDS, DEFAULT_RETENTION_LIMITS, configureRetention, resolveRetentionLimits,
  retainedClusterCount, retentionLimits,
} = await import('../internal/projection-retention.js')
const { CONFIG_FIELDS } = await import('../internal/config-spec.js')

const ENVIRONMENT = ['DSH_PTC_RETENTION_RUNS', 'DSH_PTC_RETENTION_BYTES', 'DSH_PTC_RETENTION_CLUSTERS']

function withEnvironment(values, body) {
  const previous = Object.fromEntries(ENVIRONMENT.map(key => [key, process.env[key]]))
  for (const key of ENVIRONMENT) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[`DSH_PTC_RETENTION_${key}`] = value
  try {
    return body()
  } finally {
    for (const key of ENVIRONMENT) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test('the settings fields carry the documented defaults and bounds', () => {
  const fields = Object.fromEntries(CONFIG_FIELDS.filter(field => field.key.startsWith('retention'))
    .map(field => [field.key, field]))
  assert.deepEqual(Object.keys(fields).sort(),
    ['retentionClusters', 'retentionPayloadBytes', 'retentionPayloadRuns'])
  assert.equal(fields.retentionPayloadRuns.default, DEFAULT_RETENTION_LIMITS.runs)
  assert.equal(fields.retentionPayloadRuns.min, RETENTION_BOUNDS.runs.min)
  assert.equal(fields.retentionPayloadRuns.max, RETENTION_BOUNDS.runs.max)
  assert.equal(fields.retentionPayloadBytes.default, DEFAULT_RETENTION_LIMITS.bytes)
  assert.equal(fields.retentionPayloadBytes.min, RETENTION_BOUNDS.bytes.min)
  assert.equal(fields.retentionPayloadBytes.max, RETENTION_BOUNDS.bytes.max)
  assert.equal(fields.retentionClusters.default, DEFAULT_RETENTION_LIMITS.clusters)
  assert.equal(fields.retentionClusters.min, 0)
  assert.equal(fields.retentionClusters.max, RETENTION_BOUNDS.clusters.max)
  for (const field of Object.values(fields)) {
    assert.equal(field.type, 'integer')
    assert.ok(field.label && field.labelEn && field.description && field.descriptionEn, field.key)
    assert.match(field.descriptionEn, /checkpoint|log/i)
  }
})

test('an absent configuration resolves to the defaults', () => withEnvironment({}, () => {
  assert.deepEqual(resolveRetentionLimits({}), DEFAULT_RETENTION_LIMITS)
}))

test('out-of-range and non-integer values fall back to the default, never to unlimited', () => withEnvironment({}, () => {
  const limits = resolveRetentionLimits({
    retentionPayloadRuns: 0,
    retentionPayloadBytes: -1,
    // 0 is the only unlimited spelling for clusters; a negative or fractional cap
    // must not be read as "no bound".
    retentionClusters: -5,
  })
  assert.deepEqual(limits, DEFAULT_RETENTION_LIMITS)
  assert.deepEqual(resolveRetentionLimits({ retentionPayloadRuns: 10 ** 6, retentionPayloadBytes: 10 ** 12 }),
    DEFAULT_RETENTION_LIMITS)
  assert.deepEqual(resolveRetentionLimits({ retentionPayloadRuns: 8.5 }), DEFAULT_RETENTION_LIMITS)
}))

test('configuration wins over the environment, which may only tighten it', () => withEnvironment(
  { RUNS: '8', BYTES: '1048576', CLUSTERS: '7' },
  () => {
    // The environment cannot widen a configured value.
    assert.deepEqual(resolveRetentionLimits({ retentionPayloadRuns: 12, retentionPayloadBytes: 262144, retentionClusters: 9 }),
      { runs: 8, bytes: 1048576, clusters: 7 })
    // An absent field is filled by the environment.
    assert.deepEqual(resolveRetentionLimits({}), { runs: 8, bytes: 1048576, clusters: 7 })
  },
))

test('a cluster cap of 0 means unlimited while a positive cap bounds the count window', () => withEnvironment({}, () => {
  assert.equal(retainedClusterCount({ runs: 32, bytes: 1, clusters: 0 }), Number.POSITIVE_INFINITY)
  assert.equal(retainedClusterCount({ runs: 32, bytes: 1, clusters: 10 }), 10)
  assert.equal(retainedClusterCount({ runs: 32, bytes: 1, clusters: 5000 }), 32)
}))

test('configuring retention takes effect immediately for later folds', () => {
  const previous = configureRetention({ retentionPayloadRuns: 9, retentionPayloadBytes: 1048576, retentionClusters: 3 })
  try {
    assert.deepEqual(retentionLimits(), { runs: 9, bytes: 1048576, clusters: 3 })
    assert.equal(retainedClusterCount(), 3)
  } finally {
    configureRetention(previous)
  }
})
