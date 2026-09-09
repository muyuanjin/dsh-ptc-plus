import assert from 'node:assert/strict'
import test from 'node:test'
import { LONG_CELL_CODE_UNITS } from '../internal/failure-reporting.js'
import { latestRecoveryTip } from '../internal/recovery-tips.js'

function view(code, status, contextStep = 0) {
  return {
    latestRun: {
      args: { code },
      journal: {
        status,
        completion: { kind: 'throw', error: { kind: 'exception', message: 'failed' } },
        diagnostics: [],
      },
    },
    contextStep,
    lastSuccessfulRunIndex: undefined,
    systemPromptSnapshots: [],
  }
}

test('long failed cells do not create a runtime context', () => {
  const code = 'x'.repeat(LONG_CELL_CODE_UNITS)
  assert.equal(latestRecoveryTip(view(code, 'noop'), { enabled: true, cooldownMessages: 1, escalationFailures: 2 }), undefined)
  assert.equal(latestRecoveryTip(view(code, 'volatile'), { enabled: true, cooldownMessages: 1, escalationFailures: 2 }), undefined)
})

test('short failures and disabled tips remain silent', () => {
  const short = view('return 1', 'noop')
  assert.equal(latestRecoveryTip(short, { enabled: true, cooldownMessages: 1, escalationFailures: 2 }), undefined)
  assert.equal(latestRecoveryTip(view('x'.repeat(LONG_CELL_CODE_UNITS), 'noop'), {
    enabled: false, cooldownMessages: 1, escalationFailures: 2,
  }), undefined)
})

test('only owner-classified capability failures recommend discovery at either detail level', () => {
  for (const causeCode of ['PTC-LOCAL', 'PTC-CAPABILITY', undefined]) {
    const failure = view('return retainedMember({})', 'durable')
    failure.latestRun.journal.diagnostics = [{ code: 'PTC-W001', cause: { code: causeCode } }]
    for (const escalationFailures of [0, 2]) {
      const tip = latestRecoveryTip(failure, { enabled: true, cooldownMessages: 1, escalationFailures })
      assert.match(tip.name, /repeated-binding-failure\/1$/)
      if (causeCode === 'PTC-CAPABILITY') {
        assert.match(tip.text, /capabilities\.inspect\(\)/)
      } else {
        assert.match(tip.text, /local name, scope, initialization/)
        assert.doesNotMatch(tip.text, /capabilities\.inspect\(\)/)
      }
    }
  }
})

const BINDING_TIP = 'tools:ptc-plus-tip/repeated-binding-failure'
const PLATFORM_TIP = 'tools:ptc-plus-tip/platform-command-failure'
const TIP_CONFIG = { enabled: true, cooldownMessages: 3, escalationFailures: 2 }

function bindingFailure(contextStep = 0) {
  const failure = view('return retainedMember({})', 'durable', contextStep)
  failure.latestRun.journal.diagnostics = [{ code: 'PTC-W001', cause: { code: 'PTC-CAPABILITY' } }]
  return failure
}

function platformFailure(contextStep = 0) {
  const failure = view('return 1', 'noop', contextStep)
  failure.latestRun.journal.diagnostics = [
    { code: 'PTC-X001', cause: { code: 'ENOENT', message: 'spawn npm ENOENT' } },
  ]
  return failure
}

function withDelivered(failure, ...delivered) {
  failure.systemPromptSnapshots = delivered.map(entry => ({
    index: entry.index,
    contextStep: entry.contextStep,
    sections: [{ name: entry.name, text: 'delivered tip' }],
  }))
  return failure
}

test('a tip of one kind does not delay a different kind', () => {
  const binding = withDelivered(bindingFailure(1), { name: `${PLATFORM_TIP}/1`, index: 0, contextStep: 0 })
  assert.match(latestRecoveryTip(binding, TIP_CONFIG).name, /repeated-binding-failure\/1$/)

  const platform = withDelivered(platformFailure(1), { name: `${BINDING_TIP}/1`, index: 0, contextStep: 0 })
  assert.match(latestRecoveryTip(platform, TIP_CONFIG).name, /platform-command-failure\/1$/)
})

test('same-kind tips keep the cooldown and the next per-kind ordinal', () => {
  const history = [{ name: `${BINDING_TIP}/1`, index: 0, contextStep: 0 }]
  assert.equal(latestRecoveryTip(withDelivered(bindingFailure(2), ...history), TIP_CONFIG), undefined)
  assert.match(
    latestRecoveryTip(withDelivered(bindingFailure(3), ...history), TIP_CONFIG).name,
    /repeated-binding-failure\/2$/,
  )
})

test('a successful cell resets the unresolved escalation count per kind', () => {
  const failure = withDelivered(
    bindingFailure(4),
    { name: `${BINDING_TIP}/1`, index: 0, contextStep: 0 },
    { name: `${BINDING_TIP}/2`, index: 1, contextStep: 1 },
  )
  failure.lastSuccessfulRunIndex = 1
  const reset = latestRecoveryTip(failure, TIP_CONFIG)
  assert.match(reset.name, /repeated-binding-failure\/3$/)
  assert.doesNotMatch(reset.text, /Do not invent hidden bindings/)

  failure.lastSuccessfulRunIndex = undefined
  assert.match(latestRecoveryTip(failure, TIP_CONFIG).text, /Do not invent hidden bindings/)
})

test('cooldown merges canonical snapshot sections with delivered notices per kind', () => {
  const failure = platformFailure(3)
  failure.systemPromptSnapshots = [{
    index: 0,
    contextStep: 0,
    sections: [{ name: `${PLATFORM_TIP}/1`, text: 'delivered tip' }],
  }]
  failure.ptcMessages = [{ form: 'notice', name: `${BINDING_TIP}/1`, text: 'delivered tip', index: 1, contextStep: 2 }]
  assert.match(latestRecoveryTip(failure, TIP_CONFIG).name, /platform-command-failure\/2$/)
})
