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
