import test from 'node:test'
import assert from 'node:assert/strict'
import { executionPolicies, guidancePolicies } from '../internal/binding-update-policy.js'

const config = {
  looseTopLevelRedeclarations: true,
  looseTopLevelFunctionClassRedeclarations: false,
  autoRewriteImports: false,
  autoStripExports: true,
  autoSplitRedeclarations: true,
  durableReplay: true,
  cordisToolsEnabled: false,
}

test('derives one live execution policy from compatibility settings', () => {
  const policies = executionPolicies(config)
  assert.deepEqual(policies.bindingPolicy, {
    variableRedeclarations: true,
    functionClassRedeclarations: false,
  })
  assert.deepEqual(policies.rewritesEnabled, {
    autoRewriteImports: false,
    autoStripExports: true,
    autoSplitRedeclarations: true,
  })
  assert.equal(Object.isFrozen(policies), true)
  assert.equal(Object.isFrozen(policies.bindingPolicy), true)
})

test('replay uses the journaled policy without consulting current settings', () => {
  const replay = {
    bindingPolicy: { variableRedeclarations: false, functionClassRedeclarations: true },
    rewritePolicy: { autoRewriteImports: true, autoStripExports: false, autoSplitRedeclarations: false },
    moduleSemantics: { defaultExportBinding: 'legacy-variable', importExpressionBoundary: 'legacy' },
  }
  assert.deepEqual(executionPolicies(config, replay), {
    languageSemantics: 'legacy-v1',
    bindingPolicy: replay.bindingPolicy,
    rewritesEnabled: replay.rewritePolicy,
    moduleSemantics: replay.moduleSemantics,
  })
})

test('guidance receives the same policy facts as execution', () => {
  const guidance = guidancePolicies(config)
  assert.equal(guidance.bindingPolicy.variableRedeclarations, true)
  assert.equal(guidance.rewritesEnabled.autoRewriteImports, false)
  assert.equal(guidance.durableReplay, true)
  assert.equal(guidance.cordisToolsEnabled, false)
})

test('unified policy selects complete language defaults', () => {
  assert.equal(executionPolicies(config).languageSemantics, 'legacy-v1')
  assert.equal(executionPolicies({ bindingUpdates: 'stateful' }).languageSemantics, 'stateful-v1')
  assert.equal(executionPolicies({ bindingUpdates: 'protected' }).languageSemantics, 'protected-v1')
  assert.equal(executionPolicies({ bindingUpdates: 'stateful' }).bindingPolicy.variableRedeclarations, true)
  assert.equal(executionPolicies({ bindingUpdates: 'stateful' }).rewritesEnabled.autoRewriteImports, true)
  assert.equal(executionPolicies({ bindingUpdates: 'protected' }).bindingPolicy.variableRedeclarations, false)
  assert.throws(() => executionPolicies({ bindingUpdates: 'invalid' }), /bindingUpdates/)
})

test('recorded language generation survives live configuration changes', () => {
  for (const languageSemantics of ['legacy-v1', 'stateful-v1', 'protected-v1']) {
    const live = executionPolicies({ bindingUpdates: 'stateful' })
    const recorded = { ...live, languageSemantics, rewritePolicy: live.rewritesEnabled }
    assert.equal(executionPolicies({ bindingUpdates: 'protected' }, recorded).languageSemantics, languageSemantics)
  }
  assert.throws(() => executionPolicies(config, { languageSemantics: 'unknown' }), /language semantics/)
})
