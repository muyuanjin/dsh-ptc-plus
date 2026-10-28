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

test('the session-log projection is registered through the handle contract too', async () => {
  // A newer host returns a ProjectionHandle instead of a disposer. Reading only the
  // earlier shape threw after the registry had already accepted the projection: the
  // operator saw a false "unavailable" warning and the registration was never
  // released.
  const warnings = []
  const registered = []
  const disposals = []
  const cleanups = []
  const registry = {
    register(projection) {
      registered.push(projection)
      return { stateOf: (session, key) => ({ session: session.id, key }), dispose: () => disposals.push(true) }
    },
  }
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    inject(names, run) {
      run({ effect: body => { cleanups.push(body()); return () => {} }, sessionProjections: registry })
      return () => {}
    },
    effect: run => { cleanups.push(run()); return () => {} },
    get: name => (name === 'sessionProjections' ? registry : undefined),
  }
  const owner = createSessionLogOwner(ctx)
  assert.equal(registered.length, 1)
  assert.deepEqual(warnings, [], 'a handle registration is not a degraded projection')
  assert.equal(typeof owner.project, 'function')
  for (const cleanup of cleanups.reverse()) await cleanup?.()
  assert.deepEqual(disposals, [true], 'disposal releases the handle the host returned')
})
