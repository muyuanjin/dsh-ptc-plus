import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferredRuntime, defersToOfficialRepl } from '../internal/official-repl-priority.js'

test('official REPL priority requires the selection and a live REPL provider', () => {
  assert.equal(defersToOfficialRepl({}, { programFormat: 'repl' }), false)
  assert.equal(defersToOfficialRepl({ officialReplPriority: false }, { programFormat: 'repl' }), false)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true }, { programFormat: 'function-body' }), false)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true }, { programFormat: 'repl' }), true)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true }, undefined), false)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true }, {
    get programFormat() { throw new Error('generation unavailable') },
  }), false)
})

test('the deferred runtime owns no resources and answers the attachment contract', async () => {
  const runtime = createDeferredRuntime()
  assert.equal(Object.isFrozen(runtime), true)
  assert.deepEqual(runtime.contextsForRequest({}), [])
  runtime.cancelCordisActivation()
  assert.equal(await runtime.reconfigure({}), undefined)
  assert.equal(await runtime.dispose(), undefined)
})
