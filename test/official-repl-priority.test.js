import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferredRuntime, defersToOfficialRepl, providerRetainsState } from '../internal/official-repl-priority.js'

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

// Retention, not the source form, decides who owns execution: the same `script`
// form is a retained environment on one deployment and a fresh process on
// another, and a provider that predates the declaration still answers through
// the only form that retained state.
test('state retention decides official priority for every reported source form', () => {
  assert.equal(providerRetainsState({ retainsState: true, programFormat: 'script' }), true)
  assert.equal(providerRetainsState({ retainsState: false, programFormat: 'repl' }), false)
  assert.equal(providerRetainsState({ programFormat: 'script' }), false)
  assert.equal(providerRetainsState({ programFormat: 'repl' }), true)
  assert.equal(providerRetainsState({ programFormat: 'function-body' }), false)
  assert.equal(providerRetainsState(undefined), false)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true },
    { retainsState: true, programFormat: 'script' }), true)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true },
    { retainsState: false, programFormat: 'repl' }), false)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true },
    { retainsState: false, programFormat: 'script' }), false)
  assert.equal(defersToOfficialRepl({ officialReplPriority: true }, {
    get retainsState() { throw new Error('generation unavailable') },
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
