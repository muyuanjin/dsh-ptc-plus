import { IsolatedOwner } from '../internal/isolated-worker.js'

// Test-only coverage seam. The production environment projection deliberately
// strips NODE_V8_COVERAGE before it reaches the inner user Worker. Coverage runs
// select explicit instrumentation here so real kernel/console/candidate worker
// behavior can be measured without changing the production environment chain.
const originalStart = IsolatedOwner.prototype.start
IsolatedOwner.prototype.start = function (options) {
  if (process.env.DSH_PTC_TEST_WORKER_COVERAGE !== '1'
    || typeof process.env.NODE_V8_COVERAGE !== 'string'
    || process.env.NODE_V8_COVERAGE.length === 0
    || options.env === undefined) {
    return originalStart.call(this, options)
  }
  return originalStart.call(this, {
    ...options,
    env: { ...options.env, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE },
  })
}
