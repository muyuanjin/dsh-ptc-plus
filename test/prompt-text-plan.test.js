import assert from 'node:assert/strict'
import test from 'node:test'
import { createCapabilityPlan } from '../internal/capability-plan.js'
import { PLAN_CATEGORY_LINES, PLAN_NAVIGATION, PLAN_OVERAGE, PLAN_OVERAGE_HOLE, PROMPT_TEXT_DEFAULT, resolvePromptText } from '../internal/prompt-text.js'

/** Same shape the plan suite uses, local so this file owns its fixture. */
const capability = (id, contract = 'Complete owner contract', category = 'tool') => ({ id, revision: 'r1', category, contract })
const input = (extra = {}) => ({
  enabled: true, configurationRevision: 'config1', capabilities: [capability('files/read')],
  budgetBytes: 1000, directoryBudgetBytes: 4096,
  navigationText: 'Search the owner catalog for complete contracts.',
  manual: { baseline: ['files/read'], overrides: {} }, ...extra,
})

test('category guidance defaults come from the registry, byte for byte', () => {
  const planned = createCapabilityPlan(input({ capabilities: [capability('a', 'x', 'tool'), capability('b', 'y', 'skill')],
    navigationText: PLAN_NAVIGATION }))
  assert.equal(planned.directoryText.split('\n')[0], PLAN_NAVIGATION)
  assert.deepEqual(planned.directoryCategories, ['tool', 'skill'])
  assert.equal(planned.directoryText, [PLAN_NAVIGATION, PLAN_CATEGORY_LINES.tool, PLAN_CATEGORY_LINES.skill].join('\n'))
})

test('a caller may deliver category guidance from the resolver instead of the defaults', () => {
  const planned = createCapabilityPlan(input({ capabilities: [capability('a', 'x', 'tool')],
    navigationText: 'Find', categories: [['tool', 'Tools: ask the index.']] }))
  assert.equal(planned.directoryText, 'Find\nTools: ask the index.')
  assert.throws(() => createCapabilityPlan(input({ categories: [['tool']] })), /category, guidance/u)
  assert.throws(() => createCapabilityPlan(input({ categories: [['tool', 42]] })))
})

test('the overage template keeps exactly one hole and resolves from the recorded sentence', () => {
  const resolved = resolvePromptText(PROMPT_TEXT_DEFAULT)
  const sentence = resolved.text('plan.overageSentence')
  assert.equal(sentence, PLAN_OVERAGE)
  assert.equal((sentence.match(/\{overageBytes\}/gu) ?? []).length, 1)
  assert.equal(sentence.replace(PLAN_OVERAGE_HOLE, '42'),
    'Explicit full contracts exceed the configured budget by 42 UTF-8 bytes.')
})
