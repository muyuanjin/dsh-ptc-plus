import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionCellExecutor } from '../internal/session-cell-executor.js'

test('a disposed kernel settles an admitted cell as a no-op without starting execution', async () => {
  const journal = {}
  const completions = []
  const executor = new SessionCellExecutor({
    disposed: true,
    completeJournal(...args) { completions.push(args) },
  })
  const result = await executor.executeCell({ journal, program: 'throw new Error("must not execute")' })
  assert.equal(result.error.kind, 'abort')
  assert.equal(result.error.message, 'session kernel disposed')
  assert.deepEqual(result.logs, [])
  assert.deepEqual(completions, [[journal, 'noop', result]])
})

test('durable replay rejects a completion after volatility is observed', () => {
  let settlement
  const active = {
    id: 17,
    replay: { calls: [] },
    durability: { status: 'volatile', reason: 'unexpected capability' },
    resolve(result, terminate) { settlement = { result, terminate } },
  }
  const executor = new SessionCellExecutor({ active })
  executor.handleDone({ id: 17, logs: ['before recovery failure'], durability: 'durable' })
  assert.deepEqual(settlement, {
    result: {
      logs: ['before recovery failure'],
      error: {
        kind: 'recovery',
        message: 'durable history requested a volatile capability during replay',
      },
    },
    terminate: true,
  })
})
