import assert from 'node:assert/strict'
import test from 'node:test'
import { uncoveredEnvironment } from './subprocess-environment.js'

test('native fixture environments preserve unrelated fields and remove coverage case variants', () => {
  assert.deepEqual(uncoveredEnvironment({ Path: 'kept', NODE_V8_COVERAGE: 'first', Node_V8_Coverage: 'second' }),
    { Path: 'kept', NODE_V8_COVERAGE: '' })
})
