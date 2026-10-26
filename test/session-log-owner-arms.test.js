import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionLogOwner } from '../internal/session-log-view.js'

/**
 * The projection owner resolves its registry lazily and tolerates both an agent
 * without a session and a registry that does not expose `stateOf`. Both arms of
 * that lookup must stay total: the prompt surface asks for a projection before
 * any session exists.
 */
function ownerWith(registry) {
  const ctx = {
    logger: {},
    inject(names, run) {
      run({ effect: body => body(), sessionProjections: registry })
      return () => {}
    },
    effect: run => run(),
    get: name => name === 'sessionProjections' ? registry : undefined,
  }
  return createSessionLogOwner(ctx)
}

test('an agent without a session projects a frozen surface instead of throwing', async () => {
  const registered = []
  const owner = ownerWith({ register: projection => { registered.push(projection); return () => {} } })
  assert.deepEqual(registered.length, 1)
  const facts = owner.project({ session: undefined })
  assert.equal(Object.isFrozen(facts), true)
})

test('a registry without stateOf leaves the projection state undefined', async () => {
  const owner = ownerWith({ register: () => () => {} })
  const facts = owner.project({ session: { id: 'no-state-of', events: [] } })
  assert.equal(Object.isFrozen(facts), true)
})
