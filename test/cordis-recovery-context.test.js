import assert from 'node:assert/strict'
import test from 'node:test'
import { createCordisRecoveryPolicy } from '../internal/direct-surface-owner.js'
import { sessionRuntimeContexts } from '../internal/runtime-contexts.js'
import { projectSessionLog } from '../internal/session-log-view.js'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'

const TIP_CONFIG = Object.freeze({ enabled: false, cooldownMessages: 2, escalationFailures: 2 })

function recoveryContexts(agent, policy) {
  return sessionRuntimeContexts(agent, TIP_CONFIG, {
    cordisRecoveryRequired: view => policy.required(agent, view),
  }).contexts
}

test('projects only normalized Cordis call facts from persisted journals', async (t) => {
  const events = [{ type: 'turn/start', seq: 0 }]
  const session = { id: 'cordis-transcript-facts', events }
  const state = fixture()
  t.after(() => state.dispose())

  const defined = await state.runDurable(
    session.id,
    'return await tools.cordis_define({})',
    { cordis_define: async () => ({ pluginId: 'plugin-1', packageId: 'package-1' }) },
    { session, recordSession: 'deferred-result', callId: 'cordis-defined' },
  )
  appendRunCodeEvents(events, 'cordis-defined', 'return await tools.cordis_define({})', defined)
  const failedInspect = await state.runDurable(
    session.id,
    'return await tools.cordis_inspect_self({})',
    { cordis_inspect_self: async () => { throw new Error('inspect failed') } },
    { session, recordSession: 'deferred-result', callId: 'cordis-inspect-failed' },
  )
  appendRunCodeEvents(events, 'cordis-inspect-failed', 'return await tools.cordis_inspect_self({})', failedInspect)
  const inspected = await state.runDurable(
    session.id,
    'return await tools.cordis_inspect_list({})',
    { cordis_inspect_list: async () => ({ providers: [] }) },
    { session, recordSession: 'deferred-result', callId: 'cordis-inspected' },
  )
  appendRunCodeEvents(events, 'cordis-inspected', 'return await tools.cordis_inspect_list({})', inspected)
  appendRunCodeEvents(events, 'malformed', 'return 1', { meta: { dshPtcPlus: { version: 999 } } })

  assert.deepEqual(projectSessionLog({ session }).cordisTranscript, { calls: 3, inspections: 1 })
  assert.deepEqual(projectSessionLog({ session: { events: undefined } }).cordisTranscript, {
    calls: 0,
    inspections: 0,
  })
})

test('keeps recovered Cordis guidance until a new successful live inspection', async (t) => {
  const events = [{ type: 'turn/start', seq: 0 }]
  const session = { id: 'cordis-recovery-guidance', events }
  const state = fixture()
  t.after(() => state.dispose())
  const historical = await state.runDurable(
    session.id,
    'return await tools.cordis_run({})',
    { cordis_run: async () => ({ status: 'starting' }) },
    { session, recordSession: 'deferred-result', callId: 'historical-cordis-run' },
  )
  appendRunCodeEvents(events, 'historical-cordis-run', 'return await tools.cordis_run({})', historical)

  const agent = { session }
  const policy = createCordisRecoveryPolicy(true)
  const first = recoveryContexts(agent, policy)
  assert.deepEqual(first.map(context => context.name), ['tools:ptc-plus-cordis-recovery'])
  assert.match(first[0].text, /historical data, not proof/)
  assert.match(first[0].text, /live read-only Cordis Inspect bindings through `tools\.\*`/)
  assert.equal(recoveryContexts(agent, policy)[0].text, first[0].text)

  const inspected = await state.runDurable(
    session.id,
    'return await tools.cordis_inspect_self({})',
    { cordis_inspect_self: async () => ({ plugins: [] }) },
    { session, recordSession: 'deferred-result', callId: 'live-cordis-inspect' },
  )
  appendRunCodeEvents(events, 'live-cordis-inspect', 'return await tools.cordis_inspect_self({})', inspected)
  assert.deepEqual(recoveryContexts(agent, policy), [])

  policy.reconfigure(false)
  assert.deepEqual(recoveryContexts(agent, policy), [])
  policy.reconfigure(true)
  assert.deepEqual(recoveryContexts(agent, policy).map(context => context.name), [
    'tools:ptc-plus-cordis-recovery',
  ])
  policy.disposeAgent(agent)
  assert.deepEqual(recoveryContexts(agent, policy).map(context => context.name), [
    'tools:ptc-plus-cordis-recovery',
  ])
})

test('does not add Cordis recovery guidance without history or enablement', () => {
  const agent = { session: { id: 'fresh-cordis-session', events: [] } }
  const disabled = createCordisRecoveryPolicy(false)
  assert.deepEqual(recoveryContexts(agent, disabled), [])
  disabled.reconfigure(true)
  assert.deepEqual(recoveryContexts(agent, disabled), [])
  assert.deepEqual(sessionRuntimeContexts(agent, TIP_CONFIG).contexts, [])
})
