import assert from 'node:assert/strict'
import test from 'node:test'
import { bindingActionNotice, readBindingAction } from '../internal/user-binding-draft-projection.js'
import {
  USER_BINDING_DRAFT_META_KEY,
  createUserBindingDraftProjection,
  normalizeUserBindingDraftCapability,
  normalizeUserBindingDraftView,
  userBindingDraftCapabilityFromMeta,
  withUserBindingDraftCapability,
} from '../internal/user-binding-draft-projection.js'

const GENERATION = 'draft-generation'

test('historical review evidence requires a valid candidate, matching action and formal source relation', () => {
  const candidate = { requestId: 'request', commandId: 'command', version: 1, mode: 'new', entry: {
    id: 'helper', name: 'helper', scope: 'namespace', symbols: ['value'], purpose: '', enabled: false,
    source: 'export const value = 1',
    modelContext: { includeDeclaration: true, instructions: 'Use helper.value.' },
  } }
  const action = { requestId: 'request', id: 'helper', state: 'saved', enabled: true }
  const notice = bindingActionNotice(action)
  assert.deepEqual(readBindingAction(notice), action)
  for (const malformed of [null, { ...notice, content: [] }, { ...notice, content: [{ type: 'text', text: 1 }] },
    { ...notice, content: [{ type: 'text', text: 'wrong' }] },
    { ...notice, content: [{ type: 'text', text: notice.content[0].text + 'oops' }] }]) {
    assert.equal(readBindingAction(malformed), undefined)
  }
  assert.throws(() => bindingActionNotice({ ...action, enabled: 'true' }), /invalid/)
  const projection = createUserBindingDraftProjection(GENERATION)
  const accepted = { ...result(withUserBindingDraftCapability({}, 'capability', GENERATION, candidate)), seq: 2 }
  const state = projection.apply(projection.init(), accepted)
  assert.equal(projection.apply(state, accepted).history.length, 1)
  const wrongRelation = { type: 'user/message', seq: 3, surfaceOp: 'append', data: notice, sourceEventSeqs: [1] }
  assert.equal(projection.apply(state, wrongRelation).history[0].action, null)
  const settled = projection.apply(state, { ...wrongRelation, sourceEventSeqs: [2] })
  assert.deepEqual(settled.history[0].action, action)
  assert.deepEqual(projection.stateSchema.parse(settled).history, settled.history)
  assert.deepEqual(projection.stateSchema.parse({ ...settled, generation: 'old' }).history, settled.history)
  const view = projection.wire.view(settled)
  assert.deepEqual(view.history[0].candidate.entry.modelContext, candidate.entry.modelContext)
  for (const history of [null, [{ ...view.history[0], candidate: null }],
    [{ ...view.history[0], acceptedSeq: -1 }],
    [{ ...view.history[0], commandId: 'unrelated-command' }],
    [{ ...view.history[0], action: { ...action, id: 'other' } }]]) {
    assert.throws(() => normalizeUserBindingDraftView({ ...view, history }), /invalid|does not identify/)
  }
  assert.throws(() => withUserBindingDraftCapability({}, 'capability', GENERATION, { ...candidate, entry: { ...candidate.entry, source: '' } }), /invalid/)
  const pending = projection.apply(state, { type: 'command/run', data: { name: 'binding', commandId: 'new-command' } })
  assert.equal(projection.apply(pending, accepted).phase, 'pending')
  assert.equal(projection.apply(pending, result(withUserBindingDraftCapability({}, 'capability', GENERATION, null))).phase, 'pending')
})

function result(meta, surfaceOp = 'append') {
  return {
    type: 'tool/result',
    surfaceOp,
    data: { meta },
  }
}

test('projects only a current-generation opaque draft locator', () => {
  const projection = createUserBindingDraftProjection(GENERATION)
  const initial = projection.init()
  assert.deepEqual(projection.wire.view(initial), { phase: 'idle', capability: null, commandId: null })
  const capability = '0f1e2d3c-4b5a-6978-8a9b-c0d1e2f3a4b5'
  const current = projection.apply(initial, result(
    withUserBindingDraftCapability(undefined, capability, GENERATION),
  ))
  assert.deepEqual(projection.wire.view(current), { phase: 'ready', capability, commandId: null })
  assert.deepEqual(Object.keys(current), [
    'generation', 'phase', 'capability', 'commandId', 'fallbackReady', 'fallbackCommandId',
    'turnStarted',
  ])
  assert.equal(userBindingDraftCapabilityFromMeta(
    withUserBindingDraftCapability(undefined, capability, GENERATION),
    GENERATION,
  ), capability)

  const cleared = projection.apply(current, result(
    withUserBindingDraftCapability(undefined, null, GENERATION),
  ))
  assert.deepEqual(projection.wire.view(cleared), { phase: 'idle', capability: null, commandId: null })
})

test('projects authoring admission, acceptance, and turn failure from committed events', () => {
  const projection = createUserBindingDraftProjection(GENERATION)
  const commandId = 'cmd-authoring-1'
  const pending = projection.apply(projection.init(), {
    type: 'command/run',
    data: { commandId, name: 'binding', source: { kind: 'user' } },
  })
  assert.deepEqual(projection.wire.view(pending), { phase: 'pending', capability: null, commandId })
  assert.equal(projection.apply(pending, {
    type: 'command/done', data: { commandId, kind: 'success' },
  }), pending)
  const started = projection.apply(pending, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(started.turnStarted, true)
  const failed = projection.apply(started, {
    type: 'turn/end', data: { turn: 1, reason: 'complete' },
  })
  assert.deepEqual(projection.wire.view(failed), { phase: 'failed', capability: null, commandId })

  const retried = projection.apply(failed, {
    type: 'command/run',
    data: { commandId: 'cmd-authoring-2', name: 'binding', source: { kind: 'user' } },
  })
  const ready = projection.apply(retried, result(
    withUserBindingDraftCapability(undefined, 'draft-capability', GENERATION),
  ))
  assert.deepEqual(projection.wire.view(ready), {
    phase: 'ready', capability: 'draft-capability', commandId: 'cmd-authoring-2',
  })
  assert.equal(projection.apply(ready, { type: 'turn/end', data: { turn: 2 } }), ready)
})

test('keeps an earlier ready draft while a replacement is pending or fails', () => {
  const projection = createUserBindingDraftProjection(GENERATION)
  const firstPending = projection.apply(projection.init(), {
    type: 'command/run', data: { commandId: 'cmd-existing', name: 'binding' },
  })
  const ready = projection.apply(firstPending, result(
    withUserBindingDraftCapability(undefined, 'existing-capability', GENERATION),
  ))
  const pending = projection.apply(ready, {
    type: 'command/run', data: { commandId: 'cmd-replace', name: 'binding' },
  })
  assert.deepEqual(projection.wire.view(pending), {
    phase: 'pending', capability: 'existing-capability', commandId: 'cmd-replace',
  })
  assert.equal(projection.apply(pending, result(
    withUserBindingDraftCapability(undefined, 'existing-capability', GENERATION),
  )), pending)
  const failed = projection.apply(pending, {
    type: 'command/done', data: { commandId: 'cmd-replace', kind: 'error' },
  })
  assert.deepEqual(projection.wire.view(failed), {
    phase: 'ready', capability: 'existing-capability', commandId: 'cmd-existing',
  })
  assert.equal(projection.apply(pending, result(
    withUserBindingDraftCapability(undefined, 'existing-capability', GENERATION),
  )), pending)

  const turnStarted = projection.apply(pending, { type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(projection.wire.view(projection.apply(turnStarted, {
    type: 'turn/end', data: { turn: 2, reason: 'complete' },
  })), {
    phase: 'ready', capability: 'existing-capability', commandId: 'cmd-existing',
  })

  const uncorrelated = projection.apply(projection.init(), result(
    withUserBindingDraftCapability(undefined, 'uncorrelated-capability', GENERATION),
  ))
  const uncorrelatedPending = projection.apply(uncorrelated, {
    type: 'command/run', data: { commandId: 'cmd-failed', name: 'binding' },
  })
  assert.deepEqual(projection.wire.view(projection.apply(uncorrelatedPending, {
    type: 'command/done', data: { commandId: 'cmd-failed', kind: 'error' },
  })), {
    phase: 'ready', capability: 'uncorrelated-capability', commandId: null,
  })

  const replacementPending = projection.apply(failed, {
    type: 'command/run', data: { commandId: 'cmd-success', name: 'binding' },
  })
  assert.deepEqual(projection.wire.view(projection.apply(replacementPending, result(
    withUserBindingDraftCapability(undefined, 'replacement-capability', GENERATION),
  ))), {
    phase: 'ready', capability: 'replacement-capability', commandId: 'cmd-success',
  })
})

test('ignores malformed, foreign, missing, and replacement draft metadata', () => {
  const projection = createUserBindingDraftProjection(GENERATION)
  const capability = 'current-capability'
  const current = projection.apply(projection.init(), result(
    withUserBindingDraftCapability(undefined, capability, GENERATION),
  ))
  assert.equal(projection.apply(current, { type: 'tool/call', data: {} }), current)
  assert.equal(projection.apply(current, result({})), current)
  assert.equal(projection.apply(current, result({
    [USER_BINDING_DRAFT_META_KEY]: { version: 1, generation: GENERATION },
  })), current)
  assert.equal(userBindingDraftCapabilityFromMeta({
    [USER_BINDING_DRAFT_META_KEY]: { version: 1, generation: GENERATION },
  }, GENERATION), undefined)
  assert.equal(userBindingDraftCapabilityFromMeta({}, GENERATION), undefined)
  assert.equal(projection.apply(current, result(
    withUserBindingDraftCapability(undefined, 'foreign', 'other-generation'),
  )), current)
  assert.equal(userBindingDraftCapabilityFromMeta(
    withUserBindingDraftCapability(undefined, 'foreign', 'other-generation'),
    GENERATION,
  ), undefined)
  assert.equal(projection.apply(current, result(
    withUserBindingDraftCapability(undefined, 'replacement', GENERATION),
    'replace',
  )), current)
})

test('invalidates locators at runtime-generation and session-seed boundaries', () => {
  const prior = createUserBindingDraftProjection('prior')
  const state = prior.apply(prior.init(), result(
    withUserBindingDraftCapability(undefined, 'prior-capability', 'prior'),
  ))
  const current = createUserBindingDraftProjection(GENERATION)
  assert.equal(current.stateSchema.parse(state).capability, null)
  assert.equal(current.stateSchema.parse({
    generation: GENERATION,
    phase: 'ready',
    capability: 'current-capability',
    commandId: null,
    fallbackReady: false,
    fallbackCommandId: null,
    turnStarted: false,
  }).capability, 'current-capability')
  assert.equal(current.apply(state, { type: 'session/end-seed' }).capability, null)
  assert.equal(current.apply(state, { type: 'ptc-plus/user-binding-draft-reset', data: {} }), state)
})

test('validates bounded capability values and preserves unrelated metadata', () => {
  assert.equal(normalizeUserBindingDraftCapability(null), null)
  assert.throws(() => createUserBindingDraftProjection(''), /invalid.*generation/)
  assert.throws(() => createUserBindingDraftProjection(GENERATION).stateSchema.parse({}), /projection state/)
  assert.throws(() => normalizeUserBindingDraftCapability(''), /invalid/)
  assert.throws(() => normalizeUserBindingDraftCapability('x'.repeat(129)), /invalid/)
  assert.deepEqual(normalizeUserBindingDraftView({ phase: 'pending', capability: null, commandId: 'cmd' }), {
    phase: 'pending', capability: null, commandId: 'cmd',
  })
  assert.throws(() => normalizeUserBindingDraftView(null), /projection view/)
  assert.throws(() => normalizeUserBindingDraftView({ phase: 'unknown', capability: null, commandId: null }), /phase/)
  const projection = createUserBindingDraftProjection(GENERATION)
  assert.throws(() => projection.stateSchema.parse({
    generation: GENERATION,
    phase: 'pending',
    capability: null,
    commandId: null,
    fallbackReady: false,
    fallbackCommandId: null,
    turnStarted: false,
  }), /command state/)
  assert.throws(() => projection.stateSchema.parse({
    generation: GENERATION,
    phase: 'idle',
    capability: null,
    commandId: 'unexpected-command',
    fallbackReady: false,
    fallbackCommandId: null,
    turnStarted: false,
  }), /command state/)
  assert.throws(() => projection.stateSchema.parse({
    generation: GENERATION,
    phase: 'idle',
    capability: null,
    commandId: null,
    fallbackReady: false,
    fallbackCommandId: 'unexpected-fallback',
    turnStarted: false,
  }), /fallback state/)
  assert.throws(() => projection.stateSchema.parse({
    generation: GENERATION,
    phase: 'idle',
    capability: null,
    commandId: null,
    fallbackReady: false,
    fallbackCommandId: null,
    turnStarted: true,
  }), /turn state/)
  assert.throws(() => projection.stateSchema.parse({
    generation: GENERATION,
    phase: 'pending',
    capability: null,
    commandId: 'x'.repeat(257),
    fallbackReady: false,
    fallbackCommandId: null,
    turnStarted: false,
  }), /command id/)
  assert.throws(() => projection.stateSchema.parse({
    generation: GENERATION,
    phase: 'ready',
    capability: 'draft',
    commandId: 'command',
    fallbackReady: true,
    fallbackCommandId: 'unexpected-fallback',
    turnStarted: false,
  }), /fallback state/)
  assert.throws(() => projection.stateSchema.parse({
    generation: GENERATION,
    phase: 'ready',
    capability: 'draft',
    commandId: null,
    fallbackReady: true,
    fallbackCommandId: null,
    turnStarted: false,
  }), /fallback state/)
  const initial = projection.init()
  assert.equal(projection.apply(initial, {
    type: 'command/run', data: { commandId: null, name: 'binding' },
  }), initial)
  assert.deepEqual(withUserBindingDraftCapability({ retained: true }, 'locator', GENERATION), {
    retained: true,
    [USER_BINDING_DRAFT_META_KEY]: {
      version: 1,
      generation: GENERATION,
      capability: 'locator',
    },
  })
})
