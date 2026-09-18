import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'
import {
  isIdleSessionComposer,
  publishSettingsCard,
  sessionUsesPtcPreset,
  settingsCardSeats,
  useSessionPreset,
  watchCurrentSessionPreset,
} from '../src/client-host-compat.js'

function source(value) {
  const listeners = new Set()
  return {
    listeners,
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(next) { value = next; for (const listener of [...listeners]) listener() },
  }
}

test('preset hooks retain current evidence and only fall back when the projection is absent', () => {
  const read = (projected, summary) => useSessionPreset({
    sessionId: 'selected',
    useProjection(key) { assert.equal(key, 'agentPreset'); return projected },
    useSessions: selector => selector({ byId: { selected: summary, other: { agentPreset: 'ptc' } } }),
  })
  assert.equal(read(undefined, { agentPreset: 'code' }), 'code')
  assert.equal(read('chat', { agentPreset: 'code' }), 'chat')
  assert.equal(read(null, { agentPreset: 'code' }), null)
  assert.equal(read(undefined, { agentPreset: 'code', projectionValues: { agentPreset: undefined } }), undefined)
  assert.equal(read(undefined, undefined), undefined)
  assert.equal(useSessionPreset({ useProjection: () => 'ptc' }), 'ptc')
  for (const preset of ['ptc', 'code']) assert.equal(sessionUsesPtcPreset(preset), true)
  for (const preset of ['chat', '', null, undefined]) assert.equal(sessionUsesPtcPreset(preset), false)
})

test('preset observation follows session and projection replacement and releases old sources', () => {
  const list = source({ current: 'legacy', byId: { legacy: { agentPreset: 'code' } } })
  const current = source('chat')
  const replacement = source('ptc')
  let projected = current
  const sessions = { list, binding: id => id === 'modern' ? {
    session: { projections: { faceOf(key) { assert.equal(key, 'agentPreset'); return projected } } },
  } : undefined }
  const observed = []
  const stop = watchCurrentSessionPreset(sessions, value => observed.push(value))
  assert.deepEqual(observed, ['code'])
  list.publish({ current: 'modern', byId: { modern: { agentPreset: 'code' } } })
  assert.equal(observed.at(-1), 'chat')
  assert.equal(current.listeners.size, 1)
  current.publish('ptc')
  assert.equal(observed.at(-1), 'ptc')
  projected = replacement
  list.publish(list.getSnapshot())
  assert.equal(current.listeners.size, 0)
  assert.equal(replacement.listeners.size, 1)
  const count = observed.length
  current.publish('chat')
  assert.equal(observed.length, count)
  list.publish({ current: 'legacy', byId: { legacy: { agentPreset: 'chat' } } })
  assert.equal(observed.at(-1), 'chat')
  assert.equal(replacement.listeners.size, 0)
  list.publish({})
  assert.equal(observed.at(-1), undefined)
  stop()
  assert.equal(list.listeners.size, 0)
  const stoppedCount = observed.length
  list.publish({ current: 'modern' })
  replacement.publish('code')
  assert.equal(observed.length, stoppedCount)
})

test('preset observation preserves explicit unknown projection evidence and cleans up failed setup', () => {
  const projected = source(undefined)
  const list = source({ current: 'selected', byId: {
    selected: { agentPreset: 'code', projectionValues: { agentPreset: undefined } },
  } })
  const sessions = { list, binding: () => ({ session: { projections: { faceOf: () => projected } } }) }
  const observed = []
  const stop = watchCurrentSessionPreset(sessions, value => observed.push(value))
  assert.deepEqual(observed, [undefined])
  stop()
  assert.equal(list.listeners.size, 0)
  assert.equal(projected.listeners.size, 0)
  assert.throws(() => watchCurrentSessionPreset(sessions, () => { throw new Error('registration failed') }), /registration failed/)
  assert.equal(list.listeners.size, 0)
  assert.equal(projected.listeners.size, 0)
})

test('composer compatibility requires a matching idle session with authoritative current fields', () => {
  assert.equal(isIdleSessionComposer({ sessionId: 'selected' }, 'selected'), true)
  assert.equal(isIdleSessionComposer({ session: { sessionId: 'selected' }, interactions: [] }, 'selected'), true)
  for (const kind of ['approval', 'question']) {
    assert.equal(isIdleSessionComposer({ sessionId: 'selected', pendingInteraction: { kind } }, 'selected'), false)
    assert.equal(isIdleSessionComposer({ session: { sessionId: 'selected' }, interactions: [{ kind }] }, 'selected'), false)
  }
  for (const owner of [
    {}, { session: { sessionId: 'selected' } },
    { session: { sessionId: 'selected' }, interactions: null },
    { sessionId: 'other', session: { sessionId: 'selected' }, interactions: [] },
    { sessionId: undefined, session: { sessionId: 'selected' }, interactions: [] },
  ]) assert.equal(isIdleSessionComposer(owner, 'selected'), false)
})

test('settings-card seats follow the slot each DSH generation declares', () => {
  assert.deepEqual(settingsCardSeats('dsh-ptc-plus'), [
    { slot: 'settings.plugin.item', identity: { key: 'ptc-plus' } },
    { slot: 'plugins.row.config', identity: { key: 'dsh-ptc-plus#ptc-plus' } },
  ])
})

test('the alpha.2 row-configuration key names the row this bundle patch inserts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const rows = patch.flatMap(item => item.insert ?? []).filter(row => row.name === manifest.name)
  assert.equal(rows.length, 1, 'the bundle patch inserts exactly one row for this package')
  const seat = settingsCardSeats(manifest.name).find(candidate => candidate.slot === 'plugins.row.config')
  assert.equal(seat.identity.key, `${manifest.name}#${rows[0].id}`)
})

test('one publication path waits on every seat and reports the one the host declared', () => {
  const callbacks = new Map()
  const registrations = []
  const ctx = { slots: {
    inject(slot, callback) { callbacks.set(slot, callback); return () => callbacks.delete(slot) },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  } }
  const component = () => null
  const card = publishSettingsCard(ctx, {
    bundleName: 'dsh-ptc-plus', locale: 'settings.ptcPlus',
    injectProps: () => ({ hooks: {} }), component,
  })
  assert.deepEqual([...callbacks.keys()], ['settings.plugin.item', 'plugins.row.config'])
  assert.deepEqual(registrations, [], 'an undeclared seat registers nothing')
  assert.equal(card.seat(), undefined, 'no seat is live until the host declares one')
  callbacks.get('plugins.row.config')()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].component, component)
  assert.equal(registrations[0].options.name, 'plugins.row.config')
  assert.equal(registrations[0].options.key, 'dsh-ptc-plus#ptc-plus')
  assert.equal(registrations[0].options.locale, 'settings.ptcPlus')
  assert.deepEqual(registrations[0].options.inject(), { hooks: {} })
  assert.equal(card.seat(), 'plugins.row.config')
  callbacks.get('settings.plugin.item')()
  assert.equal(registrations.length, 2)
  assert.equal(registrations[1].options.name, 'settings.plugin.item')
  assert.equal(registrations[1].options.key, 'ptc-plus')
  assert.equal(card.seat(), 'settings.plugin.item')
  assert.deepEqual(card.releases.map(disposer => typeof disposer), ['function', 'function'])
  for (const release of card.releases) release()
  assert.equal(callbacks.size, 0)
})

/** One session list with the selection evidence the named generation publishes. */
function sessionSource({ snapshot, binding }) {
  const listeners = []
  return {
    listeners,
    sessions: {
      list: {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1) },
      },
      binding,
    },
  }
}

test('the current-session preset follows whichever selection evidence the host publishes', () => {
  // The current DSH leaves view selection outside the controller and retains the
  // session its main view shows; the preceding one projects `current` directly.
  const current = sessionSource({
    snapshot: { ids: ['a2-session'], byId: { 'a2-session': {
      id: 'a2-session', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'ptc' },
    } } },
    binding: () => undefined,
  })
  const seen = []
  watchCurrentSessionPreset(current.sessions, preset => seen.push(preset))
  assert.deepEqual(seen, ['ptc'], 'published projection values carry the preset without a retained scope')

  const face = { getSnapshot: () => 'code', subscribe: () => () => {} }
  const preceding = sessionSource({
    snapshot: { current: 'rc2-session', byId: { 'rc2-session': { id: 'rc2-session' } } },
    binding: id => (id === 'rc2-session'
      ? { session: { projections: { faceOf: key => (key === 'agentPreset' ? face : undefined) } } } : undefined),
  })
  const preceded = []
  watchCurrentSessionPreset(preceding.sessions, preset => preceded.push(preset))
  assert.deepEqual(preceded, ['code'], 'a retained scope face stays the primary source')

  const unselected = sessionSource({ snapshot: { ids: [], byId: {} }, binding: () => undefined })
  const empty = []
  watchCurrentSessionPreset(unselected.sessions, preset => empty.push(preset))
  assert.deepEqual(empty, [undefined])

  // A switch retains the new session before releasing the old one, so the held
  // selection stays the one the view shows until its retention really ends.
  const rows = {
    old: { id: 'old', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'chat' } },
    replacement: { id: 'replacement', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'ptc' } },
  }
  const switching = sessionSource({ snapshot: { ids: ['old', 'replacement'], byId: rows }, binding: () => undefined })
  const switched = []
  watchCurrentSessionPreset(switching.sessions, preset => switched.push(preset))
  assert.deepEqual(switched, ['chat'], 'the previously held session stays selected through the overlap')
  rows.old.retainedBy.mainView = 0
  for (const listener of [...switching.listeners]) listener()
  assert.deepEqual(switched, ['chat', 'ptc'], 'the released session gives way to the newly retained one')
})
