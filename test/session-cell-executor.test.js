import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionCellExecutor } from '../internal/session-cell-executor.js'

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
