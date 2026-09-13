import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { act, fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotTestRuntime, stubSettingsScope, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { Context } from '@deepseek-ai/cordis'
import * as gatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { CONFIG_FIELDS, CONFIG_GROUPS } from '../internal/config-spec.js'
import { createClientRpc } from '../src/client-rpc.js'
import { RPC_CONTRACTS } from '../internal/rpc-contract.js'
import { createBindingReviews } from '../src/client-binding-review.js'
import { LOCALE_NS, SETTINGS_COPY } from '../src/client-copy.js'
import { featureEnabled, registerGated } from '../src/client-feature-gates.js'
import { createCatalogOwner } from '../src/client-catalog.js'
import { createUserBindingsWorkbench } from '../src/client-workbench.js'

// apply() creates one catalog owner per mount; capturing it proves the owner's
// disposer is registered with the plugin scope instead of leaking sources.
const catalogOwners = vi.hoisted(() => [])
vi.mock('../src/client-catalog.js', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual,
    createCatalogOwner: options => {
      const owner = actual.createCatalogOwner(options)
      catalogOwners.push(owner)
      return owner
    } }
})

const cleanups = []
// JSDOM has no text layout. Editor geometry is exercised in the real browser.
beforeAll(() => {
  Range.prototype.getClientRects = () => []
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

let clientDefinition
async function clientPlugin(ui = primitives) {
  if (clientDefinition === undefined) {
    // The plugin factory keeps every mutable registration in its own apply()
    // closure, so one module instance serves every fixture.
    const previous = window.__ModuleLoader__
    window.__ModuleLoader__ = { load(value) { clientDefinition = value } }
    globalThis.__PTC_PLUS_CLIENT_MODULE_ID__ = 'dsh-ptc-plus'
    try { await import('../src/client.js') } finally { window.__ModuleLoader__ = previous }
  }
  return clientDefinition.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return ui
    throw new Error(`Unexpected Client module ${name}`)
  })
}

async function fixture({ enabled = true, bindings = true, conversation = true, repl = false, composer = false, dock = true, uiSession = true, rpc, watchRpc, observeRpc, commands, turn, tool, ui, setupEvents } = {}) {
  const runtime = await SlotTestRuntime.create()
  cleanups.push(() => runtime.dispose())
  const settings = stubSettingsScope()
  const value = { ...Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field.default])), enabled, userBindingsEnabled: bindings }
  settings.publish({ status: 'ready', writable: true, value })
  runtime.ctx.provide('settingsScope', { bind: () => settings.scope })
  const rpcCalls = []
  runtime.ctx.provide('connection', {
    start: () => ({ stop() {} }),
    registerGenerationSource: () => () => {},
    rpc: { open: async function* () {}, call: async (channel, method, wire, signal) => {
    expect(channel).toBe('/api')
    const { operation: endpoint, payload } = wire.args
    const value = await (async () => {
    if (method === 'ptcPlusRepl/invoke') {
      rpcCalls.push({ endpoint, payload, signal })
      if (endpoint === 'observe') return observeRpc ? observeRpc(payload, signal) : { ok: true, value: null }
      if (watchRpc) return watchRpc(payload, signal)
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ ok: true, value: null }), { once: true })
      })
    }
    rpcCalls.push({ endpoint, payload })
    return rpc ? rpc(endpoint, payload, signal) : { ok: true, value: null }
    })()
    return { ok: true, value }
  } } })
  await runtime.mount(TypertRegistry)
  await runtime.mount(gatewayClient)
  const dictionaries = new Map()
  const localeSnapshot = { active: 'en', locales: [], revision: 0 }
  const localeListeners = new Set()
  runtime.ctx.provide('locale', {
    register(namespace, dictionary) { dictionaries.set(namespace, dictionary); return () => dictionaries.delete(namespace) },
    bind: namespace => (key, params = {}) => (dictionaries.get(namespace)?.[localeSnapshot.active]?.[key] ?? key)
      .replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token),
    getSnapshot: () => localeSnapshot,
    subscribe: listener => { localeListeners.add(listener); return () => localeListeners.delete(listener) },
  })
  runtime.slots.installLocale(runtime.ctx.locale)
  const events = new ConversationEventRegistry(runtime.ctx)
  setupEvents?.(events)
  const provideConversation = () => runtime.mount({ apply(ctx) { ctx.provide('uiConversation', { events }) } })
  const conversationProvider = conversation ? await provideConversation() : undefined
  const remote = commands ? new TestRemote(new Context(), { commands }) : undefined
  if (remote) {
    runtime.ctx.provide('remote.commands', commands)
    Object.assign(runtime.ctx.remote, { $on: remote.$on.bind(remote) })
  }
  const input = stubSettingsScope()
  input.publish({ draft: '' })
  runtime.ctx.uiSession.provide({
    hooks: ['input'], props: ['inputActions'],
    resolve: () => ({ hooks: { input: input.scope }, props: { inputActions: {
      setDraft: draft => input.publish({ draft }),
    } } }),
  })
  await runtime.sessions.add({ id: 'client-session' })
  runtime.sessions.behavior('client-session').projections.set('agentPreset', 'ptc')
  await runtime.root.declare({
    'settings.plugin.item': { kind: 'keyed', scope: 'root' },
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
    'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
    ...(dock ? { 'conversation.input.dock': { kind: 'list', scope: 'session' } } : {}),
    'conversation.view': { kind: 'list', scope: 'session' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  }, props => React.createElement(React.Fragment, null,
    props.renderSlot('settings.plugin.item', {}, { entryKey: 'ptc-plus' }),
    React.createElement(props.SessionProvider, null,
      props.renderSlot('conversation.session.header.actions', {}),
      dock ? props.renderSlot('conversation.input.dock', {}) : null,
      props.renderSlot('conversation.input.left', {}),
      repl ? props.renderSlot('conversation.view', {}, { entryId: 'ptc-plus-repl' }) : null,
      composer ? props.renderSlotChain('conversation.composer', { sessionId: 'client-session' }, {
        overlay: true, fallback: React.createElement('textarea', { 'aria-label': 'Message draft', defaultValue: 'keep this draft' }),
      }) : null,
      turn ? props.renderSlot('conversation.chat.commandview', { node: turn.data.get('ptc-binding-authoring') }, {
        entryKey: 'binding', fallback: React.createElement('p', { 'data-generic-command': true }, 'Generic admission'),
      }) : null,
      turn ? props.renderSlotChain('conversation.chat.turnTail', { turn }) : null,
      tool ? props.renderSlot('tool.call.toolview', tool, { entryKey: tool.toolName }) : null)))
  const plugin = await clientPlugin(ui)
  const feature = await runtime.mount(uiSession ? plugin : {
    inject: plugin.inject,
    apply(ctx) { return plugin.apply(ctx.isolate('uiSession')) },
  })
  return { runtime, settings, value, events, feature, provideConversation, conversationProvider, remote, input, rpcCalls,
    setLocale(active) { localeSnapshot.active = active; localeSnapshot.revision++; for (const listener of localeListeners) listener() } }
}

test('REPL tab follows the current PTC projection and releases every registration', async () => {
  const { runtime, settings, value, feature } = await fixture({ bindings: false, repl: true })
  const tabs = () => runtime.slots.entries('conversation.view')
  expect(tabs().map(entry => entry.options.id)).toEqual(['ptc-plus-repl'])
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusConsole')).not.toBeNull()
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('agentPreset', 'chat')
  await runtime.flush()
  expect(tabs()).toHaveLength(0)
  expect(view.container.querySelector('.ptcPlusConsole')).toBeNull()
  projection.set('agentPreset', 'code')
  await runtime.flush()
  expect(tabs()).toHaveLength(1)
  settings.publish({ value: { ...value, replViewEnabled: false } })
  await runtime.flush()
  expect(tabs()).toHaveLength(0)
  settings.publish({ value })
  await runtime.flush()
  expect(tabs()).toHaveLength(1)
  await runtime.sessions.add({ id: 'ordinary-session' })
  await runtime.sessions.setCurrent('ordinary-session')
  await runtime.flush()
  expect(tabs()).toHaveLength(0)
  projection.set('agentPreset', 'ptc')
  await runtime.flush()
  expect(tabs()).toHaveLength(0)
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(tabs()).toHaveLength(1)
  settings.publish({ value: { ...value, enabled: false } })
  await runtime.flush()
  expect(tabs()).toHaveLength(0)
  settings.publish({ value })
  await runtime.flush()
  expect(tabs()).toHaveLength(1)
  await feature.dispose()
  expect(tabs()).toHaveLength(0)
  expect(settings.listenerCount()).toBe(0)
})

test('legacy public preset summaries drive the REPL until a current projection is present', async () => {
  const { runtime } = await fixture({ bindings: false, repl: true })
  await runtime.sessions.add({ id: 'legacy-session', summary: { agentPreset: 'code' } })
  await runtime.sessions.setCurrent('legacy-session')
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.view')).toHaveLength(1)
  await runtime.sessions.updateSummary('legacy-session', { agentPreset: 'standard' })
  await runtime.flush()
  expect(runtime.slots.entries('conversation.view')).toHaveLength(0)
  await runtime.sessions.updateSummary('legacy-session', { agentPreset: 'code' })
  await runtime.flush()
  expect(runtime.slots.entries('conversation.view')).toHaveLength(1)
  runtime.sessions.behavior('legacy-session').projections.set('agentPreset', 'standard')
  await runtime.flush()
  expect(runtime.slots.entries('conversation.view')).toHaveLength(0)
  expect(view.container.querySelector('.ptcPlusConsole')).toBeNull()
})

test('session contributions use public slot inputs without a shared uiSession prerequisite', async () => {
  const { runtime, feature, settings, conversationProvider } = await fixture({
    uiSession: false, repl: true,
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async () => ({ ok: true, value: { revision: 1, entries: [] } }),
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusActive')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusConsole')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusAuthorButton')).not.toBeNull()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  await conversationProvider.dispose()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  expect(view.container.querySelector('.ptcPlusActive')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusConsole')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusCard')).not.toBeNull()
  await feature.dispose()
  for (const name of ['conversation.session.header.actions', 'conversation.view', 'conversation.input.left']) {
    expect(runtime.slots.entries(name)).toHaveLength(0)
  }
  expect(settings.listenerCount()).toBe(0)
})

test('preview interest follows the visible region, connection and tab setting', async () => {
  let visibility
  let disconnected = false
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { visibility = callback }
    observe(element) { expect(element.querySelector('.ptcPlusSessionBindings')).not.toBeNull() }
    disconnect() { disconnected = true }
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const { runtime, rpcCalls, settings, value } = await fixture({ repl: true, bindings: false })
  const view = runtime.renderRoot()
  await runtime.flush()
  const watches = () => rpcCalls.filter(call => call.endpoint === 'watch')
  expect(watches()).toHaveLength(0)
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(watches()).toHaveLength(1)
  expect(watches()[0].signal.aborted).toBe(false)
  visibility([{ isIntersecting: false }])
  expect(watches()[0].signal.aborted).toBe(true)
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(watches()).toHaveLength(2)
  runtime.ctx.emit('connection/reset')
  await runtime.flush()
  expect(watches()[1].signal.aborted).toBe(true)
  expect(watches()).toHaveLength(3)
  settings.publish({ value: { ...value, replViewEnabled: false } })
  await runtime.flush()
  expect(watches()[2].signal.aborted).toBe(true)
  expect(disconnected).toBe(true)
  expect(view.container.querySelector('.ptcPlusConsole')).toBeNull()
})

test('opening the visible REPL obtains missing values and rejects stale or mismatched observations', async () => {
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) { if (element.querySelector('.ptcPlusSessionBindings')) visibility = this.callback }
    unobserve() {}
    disconnect() {}
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const requests = []
  const { runtime, setLocale } = await fixture({ repl: true, bindings: false, observeRpc: (payload, signal) => {
    const deferred = Promise.withResolvers()
    requests.push({ ...deferred, payload, signal })
    return deferred.promise
  } })
  const memory = { available: true, total: 1, omitted: 0, entries: [{ name: 'answer', kind: 'variable',
    definition: { source: 'const answer = await Promise.resolve(42)', line: 1, column: 1 } }] }
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusRepl', memory)
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusObservationValue').textContent).toBe('Not observed yet')
  expect(view.container.querySelector('.ptcPlusBindingInspector').textContent).not.toContain('Unreadable')
  expect(requests).toHaveLength(0)
  const value = number => ({ ...memory, observation: { at: 1788650000000, entries: [
    { name: 'answer', status: 'readable', text: String(number), truncated: false },
  ] } })
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(requests).toHaveLength(1)
  requests[0].resolve({ ok: true, value: value(42) })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusObservationValue').textContent).toBe('42')
  expect(view.container.querySelector('.ptcPlusObservationPreview').textContent).toBe('42')
  await runtime.flush()
  expect(requests).toHaveLength(1)
  visibility([{ isIntersecting: false }])
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(requests).toHaveLength(2)
  projection.set('ptcPlusRepl', { ...memory, entries: [{ ...memory.entries[0], definition: { ...memory.entries[0].definition, source: 'const answer = 43' } }] })
  await runtime.flush()
  expect(requests[1].signal.aborted).toBe(true)
  requests[1].resolve({ ok: true, value: value(999) })
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(requests).toHaveLength(3)
  requests[2].resolve({ ok: true, value: value(888) })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusObservationValue').textContent).toBe('Not observed yet')
  setLocale('zh')
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusObservationValue').textContent).toBe('尚未观察')
  visibility([{ isIntersecting: false }])
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  requests[3].resolve({ ok: true, value: { ...value(43), ...requests[3].payload.memory, observation: value(43).observation } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusObservationValue').textContent).toBe('43')
})

test('failed or unavailable observation remains unobserved and never blocks the REPL', async () => {
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) { if (element.querySelector('.ptcPlusSessionBindings')) visibility = this.callback }
    unobserve() {}
    disconnect() {}
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const outcomes = [{ ok: true, value: null }, { ok: false }, { ok: true, value: {} }, new Error('connection closed')]
  const { runtime, rpcCalls } = await fixture({ repl: true, bindings: false, observeRpc: () => {
    const outcome = outcomes.shift()
    if (outcome instanceof Error) throw outcome
    return outcome
  } })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', {
    available: true, total: 1, omitted: 0, entries: [{ name: 'answer', kind: 'variable',
      definition: { source: 'const answer = 42', line: 1, column: 1 } }],
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  for (let index = 0; index < 4; index++) {
    visibility([{ isIntersecting: true }])
    await runtime.flush()
    expect(view.container.querySelector('.ptcPlusObservationValue').textContent).toBe('Not observed yet')
    visibility([{ isIntersecting: false }])
  }
  expect(rpcCalls.filter(call => call.endpoint === 'observe')).toHaveLength(4)
})

test('observation retries unexpected completion with bounded backoff and cleans up stale requests', async () => {
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { visibility = callback }
    observe() {}
    disconnect() {}
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const requests = []
  const { runtime, settings, value } = await fixture({ repl: true, bindings: false, watchRpc: (_payload, signal) => {
    const deferred = Promise.withResolvers()
    requests.push({ ...deferred, signal })
    return deferred.promise
  } })
  runtime.renderRoot()
  await runtime.flush()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    if (index === 1) requests[index].resolve({ ok: false, error: 'HTTP failure' })
    else requests[index].reject(new Error('network failure'))
    await runtime.flush()
    visibility([{ isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(requests).toHaveLength(index + 1)
    await vi.advanceTimersByTimeAsync(1)
    await runtime.flush()
    expect(requests).toHaveLength(index + 2)
  }
  requests[3].resolve({ ok: true, value: null })
  await runtime.flush()
  await vi.advanceTimersByTimeAsync(60000)
  visibility([{ isIntersecting: true }])
  expect(requests).toHaveLength(4)
  expect(vi.getTimerCount()).toBe(0)
  runtime.ctx.emit('connection/reset')
  await runtime.flush()
  expect(requests).toHaveLength(5)
  visibility([{ isIntersecting: false }])
  expect(requests[4].signal.aborted).toBe(true)
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  requests[4].reject(new Error('stale request'))
  await runtime.flush()
  await vi.advanceTimersByTimeAsync(10000)
  expect(requests).toHaveLength(6)
  expect(requests[5].signal.aborted).toBe(false)
  requests[5].reject(new Error('retry while visible'))
  await runtime.flush()
  const visibilityState = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(10000)
  expect(requests).toHaveLength(6)
  expect(vi.getTimerCount()).toBe(0)
  visibilityState.mockReturnValue('visible')
  fireEvent(document, new Event('visibilitychange'))
  await runtime.flush()
  expect(requests).toHaveLength(7)
  requests[6].reject(new Error('retry before unmount'))
  await runtime.flush()
  settings.publish({ value: { ...value, replViewEnabled: false } })
  await runtime.flush()
  await vi.advanceTimersByTimeAsync(10000)
  expect(requests).toHaveLength(7)
  expect(vi.getTimerCount()).toBe(0)
  visibilityState.mockRestore()
  vi.useRealTimers()
})

test.each([false, true])('catalog reload preserves conflicting edits before explicit save retry (repl=%s)', async repl => {
  const entry = { id: 'edit-conflict', name: 'helper', scope: 'namespace', purpose: '', enabled: false,
    symbols: ['value'], source: 'export const value = 1', declaration: 'declare const helper: { value: number }' }
  let revision = 1
  let reloadFails = true
  const { runtime, rpcCalls } = await fixture({ repl, rpc: async (endpoint, payload) => {
    if (endpoint === 'list') return { ok: true, value: { revision, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision, entry } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: entry.declaration } }
    if (endpoint === 'reload') {
      if (reloadFails) { reloadFails = false; throw new Error('reload failed') }
      return { ok: true, value: { revision, entries: [{ ...entry, name: 'updated elsewhere' }] } }
    }
    if (endpoint === 'save') {
      if (payload.expectedRevision !== revision) return { ok: false,
        error: { code: 'BINDINGS_CONFLICT', message: 'Catalog revision changed' } }
      return { ok: true, value: { revision: ++revision, entries: [payload.entry] } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  if (!repl) {
    await runtime.sessions.setCurrent(undefined)
    fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
    fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
    await runtime.flush()
  }
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')].find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  fireEvent.click(button('Edit'))
  await runtime.flush()
  const editor = EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  const source = 'export const value = 42'
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } })
  const nameInput = [...workbench().querySelectorAll('.ptcPlusEntrySettings input')][1]
  fireEvent.change(nameInput, { target: { value: 'myDraft' } })
  await runtime.flush()
  revision = 2
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(workbench().textContent).toContain('Catalog revision changed')
  expect(button('Reload').disabled).toBe(false)
  for (const expected of ['reload failed', 'Catalog reloaded; unsaved edits retained.']) {
    fireEvent.click(button('Reload'))
    await runtime.flush()
    expect(workbench().textContent).toContain(expected)
    expect(EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))).toBe(editor)
    expect(editor.state.doc.toString()).toBe(source)
    expect(nameInput.value).toBe('myDraft')
    expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(1)
    expect(rpcCalls.filter(call => call.endpoint === 'load')).toHaveLength(expected === 'reload failed' ? 1 : 2)
  }
  fireEvent.click(button('Save'))
  await runtime.flush()
  const saves = rpcCalls.filter(call => call.endpoint === 'save')
  expect(saves.map(call => call.payload.expectedRevision)).toEqual([1, 2])
  expect(saves[1].payload.entry).toMatchObject({ source, name: 'myDraft' })
  expect(workbench().querySelector('.ptcPlusSourceBody .cm-content')).toBeNull()
  expect(workbench().textContent).toContain('Entry saved')
})

test.each([false, true])('read-only reload synchronizes source and its save revision (repl=%s)', async repl => {
  let entry = { id: 'reload', name: 'helper', scope: 'namespace', purpose: '', enabled: false,
    symbols: ['value'], source: 'export const value = 1', declaration: 'declare const helper: { value: number }' }
  let revision = 1
  let deleted = false
  const { runtime, rpcCalls } = await fixture({ repl, rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: {
      revision, entries: deleted ? [] : [{ ...entry, source: undefined }],
    } }
    if (endpoint === 'load') return { ok: true, value: { revision, entry } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: entry.declaration } }
    if (endpoint === 'save') {
      expect(payload.expectedRevision).toBe(revision)
      entry = { ...entry, ...payload.entry }
      return { ok: true, value: { revision: ++revision, entries: [entry] } }
    }
    if (endpoint === 'console-release') return { ok: true, value: null }
    if (endpoint === 'console-run') return { ok: true, value: { environment: 'reload-console', logs: [], output: '1', expiresAt: null } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  if (!repl) {
    await runtime.sessions.setCurrent(undefined)
    fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
    fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
    await runtime.flush()
  }
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')].find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const consoleInput = EditorView.findFromDOM(workbench().querySelector('.ptcPlusExecutionInput .cm-content'))
  consoleInput.dispatch({ changes: { from: 0, to: consoleInput.state.doc.length, insert: 'value' } })
  await runtime.flush()
  fireEvent.click(button('Run'))
  await runtime.flush()
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'console-release')).toHaveLength(0)
  entry = { ...entry, source: 'export const value = "external"', declaration: 'declare const helper: { value: string }' }
  revision++
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(workbench().textContent).toContain('value: string')
  expect(rpcCalls.filter(call => call.endpoint === 'console-release')).toHaveLength(1)
  fireEvent.click(button('Edit'))
  await runtime.flush()
  const editor = EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  expect(editor.state.doc.toString()).toBe(entry.source)
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.find(call => call.endpoint === 'save').payload).toMatchObject({
    entry: { source: 'export const value = "external"' }, expectedRevision: 2,
  })
  fireEvent.click(button('Edit'))
  await runtime.flush()
  const nextEditor = EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  nextEditor.dispatch({ changes: { from: 0, to: nextEditor.state.doc.length, insert: 'export const value = "draft"' } })
  entry = { ...entry, source: 'export const value = "new baseline"' }
  revision++
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(nextEditor.state.doc.toString()).toBe('export const value = "draft"')
  fireEvent.click(button('Cancel'))
  await runtime.flush()
  fireEvent.click(button('Edit'))
  await runtime.flush()
  expect(EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content')).state.doc.toString()).toBe(entry.source)
  fireEvent.click(button('Cancel'))
  await runtime.flush()
  deleted = true
  revision++
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(workbench().querySelector('.ptcPlusBindingEditor')).toBeNull()
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(1)
})

test.each([false, true])('canceling an unexecuted source edit preserves the console environment (repl=%s)', async repl => {
  const entry = { id: 'cancel', name: 'helper', scope: 'namespace', purpose: '', enabled: false,
    symbols: ['value'], source: 'export const value = 42', declaration: 'declare const helper: { value: number }' }
  const { runtime, rpcCalls } = await fixture({ repl, rpc: async (endpoint, payload) => {
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision: 1, entry } }
    if (endpoint === 'console-release') return { ok: true, value: null }
    if (endpoint === 'console-run') return { ok: true, value: {
      environment: 'cancel-console', logs: [], output: payload.code === 'retained + 1' ? '43' : '42', expiresAt: null,
    } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  if (!repl) {
    await runtime.sessions.setCurrent(undefined)
    fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
    fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
    await runtime.flush()
  }
  const workbench = document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench.querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const consoleInput = EditorView.findFromDOM(workbench.querySelector('.ptcPlusExecutionInput .cm-content'))
  consoleInput.dispatch({ changes: { from: 0, insert: 'let retained = value; retained' } })
  await runtime.flush()
  fireEvent.click(button('Run'))
  await runtime.flush()
  consoleInput.dispatch({ changes: { from: 0, insert: 'retained + 1' } })
  fireEvent.click(button('Edit'))
  await runtime.flush()
  const sourceEditor = EditorView.findFromDOM(workbench.querySelector('.ptcPlusSourceBody .cm-content'))
  sourceEditor.dispatch({ changes: { from: 0, to: sourceEditor.state.doc.length, insert: 'export const value = 100' } })
  await runtime.flush()
  fireEvent.click(button('Cancel'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'console-release')).toHaveLength(0)
  expect(rpcCalls.filter(call => call.endpoint === 'console-run')).toHaveLength(1)
  expect(consoleInput.state.doc.toString()).toBe('retained + 1')
  expect(workbench.querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(1)
  expect(workbench.querySelector('.ptcPlusSourceBody .cm-content')).toBeNull()
  fireEvent.click(button('Run'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'console-run').at(-1).payload).toEqual({
    environment: 'cancel-console', source: entry.source, code: 'retained + 1',
  })
  expect(workbench.querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(2)
})

test('ending a new draft keeps the stored document and its console environment through reload and cancel', async () => {
  let entry = { id: 'cancel', name: 'helper', scope: 'namespace', purpose: '', enabled: false,
    symbols: ['value'], source: 'export const value = 42', declaration: 'declare const helper: { value: number }' }
  const other = { id: 'other', name: 'otherTools', scope: 'namespace', purpose: '', enabled: false,
    symbols: ['value'], source: 'export const value = 7', declaration: 'declare const otherTools: { value: number }' }
  let revision = 1
  const { runtime, rpcCalls } = await fixture({ repl: true, rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') {
      return { ok: true, value: { revision, entries: [entry, other] } }
    }
    if (endpoint === 'load') return { ok: true, value: { revision, entry: payload.id === other.id ? other : entry } }
    if (endpoint === 'console-release') return { ok: true, value: null }
    if (endpoint === 'console-run') return { ok: true, value: {
      environment: 'creating-console', logs: [], output: payload.code === 'retained + 1' ? '43' : '42', expiresAt: null,
    } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const releases = () => rpcCalls.filter(call => call.endpoint === 'console-release').length
  const consoleDocument = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusExecutionInput .cm-content'))
  const run = async code => {
    consoleDocument().dispatch({ changes: { from: 0, insert: code } })
    await runtime.flush()
    fireEvent.click(button('Run'))
    await runtime.flush()
  }
  // New -> Cancel -> load the stored entry. Ending the new draft must not leave the
  // next reload or cancel of the unchanged entry on a different document identity.
  fireEvent.click(button('New entry'))
  await runtime.flush()
  fireEvent.click(button('Cancel'))
  await runtime.flush()
  fireEvent.click(workbench().querySelector('.ptcPlusBindingSelect'))
  await runtime.flush()
  expect(workbench().querySelector('.ptcPlusEntrySettings input').value).toBe('cancel')
  const consoleInput = consoleDocument()
  await run('let retained = value; retained')
  expect(workbench().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(1)
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(consoleDocument()).toBe(consoleInput)
  expect(workbench().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(1)
  expect(releases()).toBe(0)
  fireEvent.click(button('Edit'))
  await runtime.flush()
  expect(EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
    .state.doc.toString()).toBe(entry.source)
  fireEvent.click(button('Cancel'))
  await runtime.flush()
  expect(consoleDocument()).toBe(consoleInput)
  expect(workbench().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(1)
  expect(releases()).toBe(0)
  // The temporary environment is still live, so the next run continues it.
  await run('retained + 1')
  expect(rpcCalls.filter(call => call.endpoint === 'console-run').at(-1).payload)
    .toEqual({ environment: 'creating-console', source: entry.source, code: 'retained + 1' })
  expect(workbench().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(2)
  // A genuinely changed stored source still releases the temporary environment while
  // keeping the one document identity and its on-screen execution history.
  entry = { ...entry, source: 'export const value = 100' }
  revision = 2
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(releases()).toBe(1)
  expect(consoleDocument()).toBe(consoleInput)
  expect(workbench().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(2)
  await run('value')
  expect(rpcCalls.filter(call => call.endpoint === 'console-run').at(-1).payload)
    .toEqual({ source: 'export const value = 100', code: 'value' })
  // A genuinely different stored entry is a new document: it releases the environment
  // and rebuilds the console with empty history.
  fireEvent.click(workbench().querySelectorAll('.ptcPlusBindingSelect')[1])
  await runtime.flush()
  expect(releases()).toBe(2)
  expect(consoleDocument()).not.toBe(consoleInput)
  expect(workbench().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(0)
})

test('reload rejects mismatched revisions and ignores responses from a disposed workbench', async () => {
  const entry = { id: 'race', name: 'race', scope: 'namespace', purpose: '', enabled: false,
    symbols: ['value'], source: 'export const value = 1', declaration: 'declare const race: { value: number }' }
  let revision = 1
  let pending
  const { runtime, settings, value, rpcCalls } = await fixture({ repl: true, rpc: async (endpoint, payload) => {
    if (endpoint === 'list') return { ok: true, value: { revision, entries: [entry] } }
    if (endpoint === 'reload') return { ok: true, value: { revision: ++revision, entries: [entry] } }
    if (endpoint === 'load') {
      if (revision === 1) return { ok: true, value: { revision, entry } }
      pending = Promise.withResolvers()
      return pending.promise
    }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: entry.declaration } }
    if (endpoint === 'save') return { ok: false, error: { message: 'Catalog revision changed' } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const button = name => [...view.container.querySelector('.ptcPlusBindings').querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  fireEvent.click(button('Reload'))
  await runtime.flush()
  pending.resolve({ ok: true, value: { revision: 3, entry: { ...entry, source: 'export const value = 3' } } })
  await runtime.flush()
  expect(view.container.textContent).toContain('The catalog changed during reload. Reload again.')
  fireEvent.click(button('Edit'))
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.find(call => call.endpoint === 'save').payload.expectedRevision).toBe(1)
  fireEvent.click(button('Reload'))
  await runtime.flush()
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindings')).toBeNull()
  pending.resolve({ ok: true, value: { revision, entry } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindings')).toBeNull()
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(1)
})

test('the code console uses the unsaved draft, retains history and releases only its temporary environment', async () => {
  const entry = { id: 'console', name: 'sample', scope: 'namespace', purpose: '', enabled: false,
    symbols: ['value'], source: 'export const value = 42', declaration: 'declare const sample: { value: number }' }
  let environment = 0
  let fail = false
  let hold
  const { runtime, rpcCalls, settings, value } = await fixture({ repl: true, rpc: async (endpoint, payload, signal) => {
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision: 1, entry } }
    if (endpoint === 'console-release') return { ok: true, value: null }
    if (endpoint === 'console-run') {
      if (fail) throw new Error('transport unavailable')
      if (payload.code === 'wait') return new Promise(resolve => {
        hold = () => resolve({ ok: true, value: { environment: 'late', logs: [], output: '42', expiresAt: null } })
        signal.addEventListener('abort', hold, { once: true })
      })
      return { ok: true, value: { environment: payload.environment ?? `environment-${++environment}`,
        logs: [], output: payload.code === 'large' ? 'x'.repeat(150000) : '42', expiresAt: Date.now() + 600000,
        durationMs: 1, reset: false } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const consolePane = () => view.container.querySelector('.ptcPlusExecution')
  const button = name => [...consolePane().querySelectorAll('button')].find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const execute = async code => {
    const editor = EditorView.findFromDOM(consolePane().querySelector('.cm-content'))
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: code } })
    await runtime.flush()
    fireEvent.keyDown(editor.contentDOM, { key: 'Enter', code: 'Enter', ctrlKey: true })
    await runtime.flush()
  }
  expect(rpcCalls.some(call => call.endpoint.startsWith('console-'))).toBe(false)
  fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Edit'))
  await runtime.flush()
  const sourceEditor = EditorView.findFromDOM(view.container.querySelector('.ptcPlusSourceBody .cm-content'))
  const draft = 'export const value = 43'
  sourceEditor.dispatch({ changes: { from: 0, to: sourceEditor.state.doc.length, insert: draft } })
  await runtime.flush()
  await execute('let n = value; n')
  await execute('n + 1')
  const runs = () => rpcCalls.filter(call => call.endpoint === 'console-run')
  expect(runs()[0].payload.source).toBe(draft)
  expect(runs()[1].payload.environment).toBe('environment-1')
  expect(consolePane().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(2)
  expect(rpcCalls.some(call => call.endpoint === 'save')).toBe(false)
  fireEvent.click(button('Reset environment'))
  await runtime.flush()
  expect(rpcCalls.at(-1)).toEqual({ endpoint: 'console-release', payload: { environment: 'environment-1' } })
  expect(consolePane().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(2)
  await execute('large')
  expect(consolePane().textContent).toContain('Record truncated')
  expect(consolePane().querySelector('.ptcPlusExecutionHistory').textContent.length).toBeLessThan(70000)
  fail = true
  await execute('failure')
  expect(consolePane().textContent).toContain('transport unavailable')
  expect(consolePane().querySelector('.ptcPlusExecutionState').textContent).toBe('Environment released')
  fail = false
  await execute('wait')
  fireEvent.click(button('Stop'))
  await runtime.flush()
  expect(consolePane().textContent).toContain('Stopped; environment released')
  expect(rpcCalls.some(call => call.endpoint === 'console-release' && call.payload.environment === 'late')).toBe(true)
  fireEvent.click(button('Clear history'))
  await runtime.flush()
  expect(consolePane().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(0)
  await execute('value')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  await execute('value + 1')
  await vi.advanceTimersByTimeAsync(600000)
  await runtime.flush()
  expect(consolePane().querySelector('.ptcPlusExecutionState').textContent).toBe('Environment released')
  expect(consolePane().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(2)
  vi.useRealTimers()
  await execute('value')
  settings.publish({ value: { ...value, replViewEnabled: false } })
  await runtime.flush()
  expect(consolePane()).toBeNull()
  expect(rpcCalls.at(-1).endpoint).toBe('console-release')
})

test('REPL hides the resident composer only while mounted and preserves its draft and host interactions', async () => {
  const { runtime, settings, value, feature } = await fixture({ repl: true, composer: true })
  expect(runtime.slots.entries('conversation.composer')).toHaveLength(0)
  const view = runtime.renderRoot()
  await runtime.flush()
  const draft = view.getByLabelText('Message draft')
  const fallback = () => view.container.querySelector('[data-chain-overlay-fallback]')
  const entries = () => runtime.slots.entries('conversation.composer')
  expect(fallback().style.display).toBe('none')
  expect(view.container.querySelector('.ptcPlusConsole').hasAttribute('data-conversation-composer-overlay')).toBe(true)
  expect(entries()).toHaveLength(1)
  const select = entries()[0].select
  expect(select({ sessionId: 'other-session' })).toBeNull()
  expect(select({ sessionId: 'client-session', pendingInteraction: { kind: 'approval' } })).toBeNull()
  expect(select({ sessionId: 'client-session', pendingInteraction: { kind: 'question' } })).toBeNull()
  expect(select({ session: { sessionId: 'client-session' }, interactions: [] })).toBe(true)
  expect(select({ session: { sessionId: 'other-session' }, interactions: [] })).toBeNull()
  expect(select({ session: { sessionId: 'client-session' } })).toBeNull()
  for (const kind of ['approval', 'question']) {
    expect(select({ session: { sessionId: 'client-session' }, interactions: [{ kind }] })).toBeNull()
  }
  expect(select({ sessionId: 'other-session', session: { sessionId: 'client-session' }, interactions: [] })).toBeNull()
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('agentPreset', 'chat')
  await runtime.flush()
  expect(entries()).toHaveLength(0)
  expect(fallback().style.display).toBe('contents')
  expect(view.getByLabelText('Message draft')).toBe(draft)
  expect(draft.value).toBe('keep this draft')
  fireEvent.change(draft, { target: { value: 'edited draft' } })
  projection.set('agentPreset', 'ptc')
  await runtime.flush()
  expect(fallback().style.display).toBe('none')
  settings.publish({ value: { ...value, enabled: false } })
  await runtime.flush()
  expect(entries()).toHaveLength(0)
  expect(fallback().style.display).toBe('contents')
  expect(draft.value).toBe('edited draft')
  settings.publish({ value })
  await runtime.flush()
  expect(entries()).toHaveLength(1)
  await feature.dispose()
  await runtime.flush()
  expect(entries()).toHaveLength(0)
  expect(fallback().style.display).toBe('contents')
  expect(view.getByLabelText('Message draft')).toBe(draft)
  expect(draft.value).toBe('edited draft')
})

test('REPL observations and shared workbench remain separate from session execution', async () => {
  const entry = { id: 'workspace', name: 'AReallyLongGlobalBindingNameForNarrowLayouts', scope: 'namespace',
    symbols: ['readFileWithLongName', 'write', 'copy', 'remove'], purpose: 'Shared file utilities', enabled: false,
    source: 'export function readFileWithLongName(path: string) {\n  return path\n}', declaration: 'declare function readFileWithLongName(path: string): string;' }
  let revision = 1
  const { runtime, settings, value, rpcCalls, setLocale } = await fixture({ repl: true, rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: { revision, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision, entry } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, symbols: entry.symbols, declaration: entry.declaration } }
    if (endpoint === 'save') { revision++; return { ok: true, value: { revision, entries: [entry] } } }
    throw new Error(endpoint)
  } })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', {
    available: true, total: 58, omitted: 0,
    entries: ['aVeryLongSessionBindingNameForNarrowLayouts', 'object', 'getter',
      ...Array.from({ length: 55 }, (_, index) => `result${index}`)].map(name => ({
      name, kind: name === 'getter' ? 'function' : 'variable', definition: {
        source: name === 'getter' ? 'function getter() { return 42 }' : `const ${name} = { answer: 42, nested: { items: [1, 2, 3] } }`,
        line: 3, column: 1 },
    })),
    observation: { at: 1788650000000, entries: [
      { name: 'aVeryLongSessionBindingNameForNarrowLayouts', status: 'readable', text: '42', truncated: false },
      { name: 'object', status: 'readable', text: 'object { "answer": 42, "nested": [object] }', truncated: true },
      { name: 'getter', status: 'unreadable', text: '', truncated: false },
    ] },
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  const consolePane = () => view.container.querySelector('.ptcPlusConsole')
  expect(consolePane().textContent).toContain('Observed after settlement')
  expect(consolePane().textContent).toContain('Unreadable')
  expect(consolePane().textContent).toContain('Truncated')
  expect(consolePane().querySelector('.ptcPlusSessionBindings').querySelector('textarea,[contenteditable]')).toBeNull()
  expect(consolePane().querySelector('.ptcPlusSessionBindings .ptcPlusReplStatusDot')).toBeNull()
  expect(consolePane().querySelector('.ptcPlusSessionBindings .ptcPlusReplKind')).toBeNull()
  expect(consolePane().querySelector('[role=tab]')).toBeNull()
  expect(consolePane().querySelector('.ptcPlusBindings')).not.toBeNull()
  const beforeInspect = rpcCalls.length
  const sessionRows = () => consolePane().querySelectorAll('.ptcPlusObservationSelect')
  fireEvent.click(sessionRows()[1])
  await runtime.flush()
  expect(consolePane().querySelector('.ptcPlusBindingInspector').getAttribute('aria-label')).toBe('object')
  expect(consolePane().querySelector('.ptcPlusObservationPreview').textContent).toContain('"answer": 42')
  const search = consolePane().querySelector('[aria-label="Search binding names"]')
  fireEvent.change(search, { target: { value: 'missing' } })
  await runtime.flush()
  expect(consolePane().textContent).toContain('No matching bindings')
  expect(consolePane().querySelector('.ptcPlusBindingInspector')).toBeNull()
  fireEvent.change(search, { target: { value: '' } })
  fireEvent.change(consolePane().querySelector('[aria-label="Kind"]'), { target: { value: 'function' } })
  await runtime.flush()
  expect(sessionRows()).toHaveLength(1)
  expect(consolePane().querySelector('.ptcPlusBindingInspector').getAttribute('aria-label')).toBe('getter')
  fireEvent.change(consolePane().querySelector('[aria-label="Kind"]'), { target: { value: 'all' } })
  await runtime.flush()
  fireEvent.click(sessionRows()[0])
  await runtime.flush()
  expect(consolePane().querySelector('.ptcPlusObservationCode').textContent).toContain('const aVeryLongSessionBindingNameForNarrowLayouts')
  expect(consolePane().querySelector('.ptcPlusObservationCode button')).not.toBeNull()
  expect(consolePane().querySelector('.ptcPlusObservationPreview').textContent).toBe('42')
  expect(rpcCalls).toHaveLength(beforeInspect)
  const saveLayout = async (state, element) => {
    if (!process.env.PTC_BINDING_UI_FIXTURE) return
    const classes = new Map()
    for (const node of document.querySelectorAll('[class]')) for (const token of node.classList) {
      const match = /^_([A-Za-z]+)_[a-z0-9]+$/.exec(token)
      if (match) classes.set(match[1], token)
    }
    const css = await Promise.all(['Button.module.css', 'markdown/CodeBlock.module.css', 'Modal.module.css'].map(async name => {
      const raw = await readFile(resolve('node_modules/@deepseek-ai/dsh-client-ui-primitives/lib', name), 'utf8')
      return raw.replace(/\.([A-Za-z]+)\b/g, (token, name) => classes.has(name) ? `.${classes.get(name)}` : token)
    }))
    const editorStyles = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join('\n')
    const snapshot = element.cloneNode(true)
    const controls = element.querySelectorAll('input')
    snapshot.querySelectorAll('input').forEach((input, index) => {
      input.setAttribute('value', controls[index].value)
      input.toggleAttribute('checked', controls[index].checked)
    })
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{font-family:Arial,sans-serif;color:#202124;background:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#666;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#fff;--dsw-alias-border-l2:#e0e1e3;--dsw-alias-border-l3:#bbb;--dsw-alias-border-l4:#ddd;--dsw-alias-button-primary-fill:#242629;--dsw-alias-state-success-primary:#168052;--dsw-alias-markdown-code-block:#f6f7f8;--dsw-alias-interactive-primary:#365bbb;--dsw-alias-bg-mask-1:#0005}
      body{margin:0}button,input,textarea,select{font-family:inherit}*{box-sizing:border-box}
      ${css.join('\n')}\n${editorStyles}\n${document.getElementById('ptc-plus-client-style').textContent}
      </style></head><body>${snapshot.outerHTML}</body></html>`
    await mkdir(process.env.PTC_BINDING_UI_FIXTURE, { recursive: true })
    await writeFile(resolve(process.env.PTC_BINDING_UI_FIXTURE, `${state}.html`), html)
  }
  await saveLayout('console-en', consolePane())
  setLocale('zh')
  await runtime.flush()
  expect(consolePane().textContent).toContain('不可读取')
  await saveLayout('console-zh', consolePane())
  setLocale('en')
  await runtime.flush()
  fireEvent.click(consolePane().querySelector('.ptcPlusBindingSelect'))
  await runtime.flush()
  expect(consolePane().querySelector('.ptcPlusSourceBody .cm-content')).toBeNull()
  fireEvent.click([...consolePane().querySelectorAll('button')].find(button => button.textContent === 'Edit'))
  await runtime.flush()
  const editor = EditorView.findFromDOM(consolePane().querySelector('.ptcPlusSourceBody .cm-content'))
  expect(editor.state.doc.toString()).toBe(entry.source)
  expect(consolePane().querySelector('.ptcPlusEntrySettings').open).toBe(false)
  expect(consolePane().querySelector('.ptcPlusObservationCode')).not.toBeNull()
  await saveLayout('workbench-en', consolePane())
  const edited = entry.source.replace('return path', 'return path.trim()')
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: edited } })
  await runtime.flush()
  fireEvent.click(sessionRows()[1])
  await runtime.flush()
  expect(EditorView.findFromDOM(consolePane().querySelector('.ptcPlusSourceBody .cm-content'))).toBe(editor)
  expect(editor.state.doc.toString()).toBe(edited)
  expect(consolePane().querySelector('.ptcPlusBindingSourcePreview').textContent).not.toContain(entry.declaration)
  fireEvent.keyDown(editor.contentDOM, { key: 'z', code: 'KeyZ', ctrlKey: true })
  await runtime.flush()
  expect(editor.state.doc.toString()).toBe(entry.source)
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: edited } })
  await runtime.flush()
  const save = [...consolePane().querySelectorAll('button')].find(button => button.textContent === 'Save')
  fireEvent.click(save)
  await runtime.flush()
  expect(rpcCalls.find(call => call.endpoint === 'save').payload.expectedRevision).toBe(1)
  expect(rpcCalls.find(call => call.endpoint === 'save').payload.entry.source).toBe(edited)
  setLocale('zh')
  await runtime.flush()
  await saveLayout('workbench-zh', consolePane())
  fireEvent.click(consolePane().querySelector('.ptcPlusModelPrompt input[type=checkbox]'))
  fireEvent.change(consolePane().querySelector('.ptcPlusModelPrompt textarea'), { target: { value: 'Use fileTools.readText(path) to read text files.' } })
  await runtime.flush()
  await saveLayout('prompt-edit-zh', consolePane())
  setLocale('en')
  await runtime.flush()
  await saveLayout('prompt-edit-en', consolePane())
  fireEvent.click([...consolePane().querySelectorAll('button')].find(button => button.textContent === 'Cancel'))
  await runtime.flush()
  const projection = runtime.sessions.behavior('client-session').projections
  for (const available of [false, true]) {
    setLocale(available ? 'zh' : 'en')
    projection.set('ptcPlusRepl', { available, entries: [], total: 0, omitted: 0 })
    await runtime.flush()
    expect(consolePane().querySelector('.ptcPlusSessionEmpty')).not.toBeNull()
    expect(consolePane().querySelector('.ptcPlusObservationGrid')).toBeNull()
    await saveLayout(available ? 'empty-zh' : 'empty-en', consolePane())
  }
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(consolePane().querySelector('.ptcPlusBindings')).toBeNull()
  expect(editor.dom.isConnected).toBe(false)
  expect(consolePane().querySelector('.ptcPlusSessionEmpty')).not.toBeNull()
  settings.publish({ value })
  await runtime.flush()
  expect(consolePane().querySelector('.ptcPlusBindings')).not.toBeNull()
  await runtime.sessions.setCurrent(undefined)
  await runtime.flush()
  expect(runtime.slots.entries('conversation.view')).toHaveLength(0)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  await runtime.flush()
  const settingsCard = view.container.querySelector('.ptcPlusCard')
  const groupTitles = () => [...settingsCard.querySelectorAll('.ptcPlusGroupTitle')].map(title => title.textContent)
  expect(groupTitles()).toEqual(['插件开关', '调用容错', 'REPL 语法', '状态与恢复', '工具扩展', '界面显示', '资源限制'])
  const recoveryGroup = settingsCard.querySelector('[aria-labelledby="ptc-plus-settings-group-recovery"]')
  expect(recoveryGroup.querySelectorAll('input[type=number]')).toHaveLength(2)
  const managementAction = settingsCard.querySelector('.ptcPlusSettingAction')
  expect(managementAction.closest('section').getAttribute('aria-labelledby')).toBe('ptc-plus-settings-group-extensions')
  expect(managementAction.previousElementSibling.querySelector('[role=switch]').getAttribute('aria-label')).toBe('启用全局用户 Binding')
  await saveLayout('settings-zh', view.container.querySelector('.ptcPlusCard'))
  setLocale('en')
  await runtime.flush()
  expect(groupTitles()).toEqual(['Plugin switch', 'Tool call tolerance', 'REPL syntax', 'State and recovery', 'Tool extensions', 'Interface display', 'Resource limits'])
  await saveLayout('settings-en', view.container.querySelector('.ptcPlusCard'))
  setLocale('zh')
  await runtime.flush()
  fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === '管理全局绑定'))
  await runtime.flush()
  const dialog = () => document.querySelector('.ptcPlusBindingsModal')
  expect(dialog()).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusBindings')).toBeNull()
  expect(dialog().querySelector('.ptcPlusSourceBody .cm-content')).toBeNull()
  fireEvent.click(dialog().querySelector('.ptcPlusSourceToggle'))
  await runtime.flush()
  expect(dialog().querySelector('.ptcPlusSourceCode').textContent).toContain(entry.source)
  expect(dialog().querySelector('.ptcPlusBindingEditor .ptcPlusExecution')).not.toBeNull()
  await saveLayout('modal-zh', dialog().parentElement)
  setLocale('en')
  await runtime.flush()
  await saveLayout('modal-en', dialog().parentElement)
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(dialog()).toBeNull()
  fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
  await runtime.flush()
  const calls = rpcCalls.length
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(dialog()).toBeNull()
  expect(view.container.textContent).not.toContain('Manage global bindings')
  expect(rpcCalls).toHaveLength(calls)
  settings.publish({ value: { ...value, enabled: false } })
  await runtime.flush()
  const controls = [...settingsCard.querySelectorAll('[role=switch], input[type=number], select')]
  const visibleFieldCount = CONFIG_GROUPS.flatMap(group => group.fields).length
  expect(controls).toHaveLength(visibleFieldCount)
  expect(controls.filter(control => !control.disabled).map(control => control.getAttribute('aria-label'))).toEqual(['Enable PTC Plus'])
  settings.publish({ writable: false, value })
  await runtime.flush()
  expect(controls.every(control => control.disabled)).toBe(true)
})

test('workbench edits and saves per-entry model prompts while preserving cancel and reload semantics', async () => {
  let entry = { id: 'files', name: 'fileTools', scope: 'namespace', symbols: ['readText'],
    purpose: 'Read text.', enabled: true, source: 'export function readText(path: string): string { return path }',
    declaration: 'declare const fileTools: { readText(path: string): string }' }
  let revision = 1
  const { runtime, rpcCalls, setLocale } = await fixture({ repl: true, rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: { revision, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision, entry } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: entry.declaration } }
    if (endpoint === 'save') {
      entry = { ...payload.entry, declaration: entry.declaration }
      return { ok: true, value: { revision: ++revision, entries: [entry] } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const pane = () => view.container.querySelector('.ptcPlusBindings')
  const button = label => [...pane().querySelectorAll('button')].find(item => item.textContent === label)
  const toggle = () => pane().querySelector('.ptcPlusModelPrompt input[type=checkbox]')
  expect(toggle().checked).toBe(true)
  expect(toggle().disabled).toBe(false)
  fireEvent.click(toggle())
  await runtime.flush()
  expect(toggle().checked).toBe(false)
  expect(pane().querySelector('.ptcPlusBindingSourcePreview').textContent).toContain(entry.declaration)
  expect(pane().querySelector('.ptcPlusSourceBody').hidden).toBe(true)
  expect(pane().querySelector('.ptcPlusModelPrompt .cm-content')).toBeNull()
  fireEvent.change(view.getByLabelText('Prompt for the model'), { target: { value: 'Use fileTools.readText(path).' } })
  await runtime.flush()
  fireEvent.click(button('Validate'))
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.find(call => call.endpoint === 'save').payload.entry.modelContext).toEqual({
    includeDeclaration: false, instructions: 'Use fileTools.readText(path).',
  })
  expect(pane().querySelector('.ptcPlusBindingSourcePreview').textContent).toContain(entry.declaration)
  fireEvent.click(toggle())
  fireEvent.change(view.getByLabelText('Prompt for the model'), { target: { value: 'Unsaved' } })
  fireEvent.click(pane().querySelector('button[aria-label="Reload"]'))
  await runtime.flush()
  expect(toggle().checked).toBe(true)
  expect(view.getByLabelText('Prompt for the model').value).toBe('Unsaved')
  fireEvent.click(button('Cancel'))
  await runtime.flush()
  expect(toggle().checked).toBe(false)
  expect(view.getByLabelText('Prompt for the model').value).toBe('Use fileTools.readText(path).')
  setLocale('zh')
  await runtime.flush()
  expect(view.getByLabelText('将接口声明提供给模型').checked).toBe(false)
  expect(view.getByLabelText('给模型的提示词').value).toBe('Use fileTools.readText(path).')
})

test('saved cards retain exact source across remount and locale changes; catalog conflicts keep drafts actionable', async () => {
  const entry = { id: 'review', name: 'AReallyLongBindingNameForNarrowPanels', scope: 'namespace',
    purpose: '', enabled: false, symbols: ['read', 'write', 'copy', 'remove', 'listDirectoryWithLongName'],
    source: 'export const value = 42' }
  const candidate = { requestId: 'review-request', commandId: 'review-command', version: 1, mode: 'new', entry }
  let draft = { version: 1, mode: 'new', entry }
  let revision = 1
  let action = null
  let conflicts = true
  const rpc = vi.fn(async (endpoint, input) => {
    if (endpoint === 'list') return { ok: true, value: { revision, entries: [entry, { ...entry, id: 'enabled', name: '启用但尚未激活的长名称绑定', enabled: true }] } }
    if (endpoint === 'draft') return { ok: true, value: draft }
    if (endpoint === 'draft-review') return { ok: true, value: { candidate, action } }
    if (endpoint === 'save-draft') {
      if (conflicts) { conflicts = false; revision++; return { ok: false, error: { code: 'BINDINGS_CONFLICT', message: 'Catalog revision changed' } } }
      expect(input.expectedRevision).toBe(2)
      draft = null
      action = { requestId: candidate.requestId, id: entry.id, state: 'saved', enabled: input.activate }
      return { ok: true, value: { revision: ++revision, entries: [{ ...entry, enabled: input.activate }] } }
    }
    throw new Error(endpoint)
  })
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: 'review-command', args: ' new 一个简单文件工具',
    outcome: { kind: 'success', text: 'Host admission text must not appear' } }]]) }
  const { runtime, setLocale } = await fixture({ rpc, turn })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', { phase: 'ready', capability: 'review-capability', commandId: 'review-command' })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.container.querySelector('.ptcPlusActive'))
  await runtime.flush()
  // jsdom does not expose native popover visibility to accessibility queries.
  fireEvent.click(view.container.querySelectorAll('.ptcPlusReplTab')[1])
  await runtime.flush()
  const card = () => view.container.querySelector('.ptcPlusBindingCommand')
  const panel = () => view.container.querySelector('.ptcPlusBindingDock')
  expect(view.container.querySelectorAll('.ptcPlusGlobalItem .ptcPlusBindingState')[0].textContent).toBe('Disabled')
  expect(view.container.querySelectorAll('.ptcPlusGlobalItem .ptcPlusBindingState')[1].textContent).toBe('Enabled')
  expect(card().textContent).not.toContain('Host admission text')
  expect(view.container.querySelector('[data-generic-command]')).toBeNull()
  expect(view.container.querySelectorAll('.ptcPlusBindingCommand')).toHaveLength(1)
  expect(runtime.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  const save = () => [...panel().querySelectorAll('button')].find(button => button.textContent === 'Save and enable')
  expect(save().className).not.toContain('ptcPlusButton')
  fireEvent.click(save())
  await runtime.flush()
  expect(panel().textContent).toContain('Catalog revision changed')
  expect(save()).toBeDefined()
  expect(panel().textContent).toContain(entry.source)
  const snapshot = async (name) => {
    if (!process.env.PTC_BINDING_UI_FIXTURE) return
    const classes = new Map()
    for (const element of view.container.querySelectorAll('[class]')) {
      for (const token of element.classList) {
        const match = /^_([A-Za-z]+)_[a-z0-9]+$/.exec(token)
        if (match) classes.set(match[1], token)
      }
    }
    const css = await Promise.all(['Button.module.css', 'markdown/CodeBlock.module.css'].map(async name => {
      const raw = await readFile(resolve('node_modules/@deepseek-ai/dsh-client-ui-primitives/lib', name), 'utf8')
      return raw.replace(/\.([A-Za-z]+)\b/g, (token, name) => classes.has(name) ? `.${classes.get(name)}` : token)
    }))
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{font-family:Arial,sans-serif;color:#202124;background:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#666;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-layer-3:#fff;--dsw-alias-border-l3:#bbb;--dsw-alias-border-l4:#ddd;--dsw-alias-button-primary-fill:#242629;--dsw-alias-state-success-primary:#168052;--dsw-alias-markdown-code-block:#f6f7f8}
      body{margin:16px}.fixture{width:min(340px,100%);box-sizing:border-box}.fixture .ptcPlusGlobalPane{border:1px solid #ddd}.fixture .ptcPlusAuthoringDraft{min-width:0}
      ${document.getElementById('ptc-plus-client-style').textContent}\n${css.join('\n')}
      </style></head><body><main class="fixture">${view.container.querySelector('.ptcPlusReplCard').outerHTML}${card().outerHTML}</main></body></html>`
    await mkdir(process.env.PTC_BINDING_UI_FIXTURE, { recursive: true })
    await writeFile(resolve(process.env.PTC_BINDING_UI_FIXTURE, `${name}.html`), html)
  }
  const summary = view.container.querySelector('.ptcPlusReplSummary')
  for (const locale of ['en', 'zh']) {
    setLocale(locale)
    projection.set('ptcPlusRepl', { available: false, entries: [], total: 0, omitted: 0 })
    fireEvent.click(view.container.querySelectorAll('.ptcPlusReplTab')[0])
    await runtime.flush()
    expect(view.container.querySelector('.ptcPlusReplSummary')).toBe(summary)
    expect(summary.textContent).toBe('')
    expect(summary.getAttribute('aria-hidden')).toBe('true')
    await snapshot(`popover-unavailable-${locale}`)
    projection.set('ptcPlusRepl', { available: true, total: 1, omitted: 0,
      entries: [{ name: 'value', kind: 'variable', definition: { source: 'const value = 42', line: 1, column: 1 } }] })
    await runtime.flush()
    expect(summary.textContent).toBe(locale === 'en'
      ? '1 reusable bindings · reused 0\u00d7 total' : '1 个可复用绑定 · 共复用 0 次')
    expect(summary.hasAttribute('aria-hidden')).toBe(false)
    await snapshot(`popover-session-${locale}`)
    fireEvent.click(view.container.querySelectorAll('.ptcPlusReplTab')[1])
    await runtime.flush()
    expect(view.container.querySelector('.ptcPlusReplSummary')).toBe(summary)
    expect(summary.textContent).toBe(locale === 'en' ? '2 global entries' : '2 个全局条目')
    await snapshot(`popover-global-${locale}`)
  }
  setLocale('en')
  await runtime.flush()
  await snapshot('ready-en')
  setLocale('zh')
  await runtime.flush()
  await snapshot('ready-zh')
  setLocale('en')
  await runtime.flush()
  fireEvent.click(save())
  await runtime.flush()
  expect(card().textContent).toContain('Draft saved and enabled')
  expect(card().textContent).toContain(entry.source)
  expect(card().querySelector('.ptcPlusBindingCommandActions')).toBeNull()
  await snapshot('saved-en')
  setLocale('zh')
  await runtime.flush()
  expect(card().textContent).toContain('草稿已保存并启用')
  await snapshot('saved-zh')
  projection.set('ptcPlusBindingDraft', { phase: 'idle', capability: null, commandId: null,
    history: [{ commandId: candidate.commandId, acceptedSeq: 4, candidate, action }] })
  await runtime.sessions.setCurrent(undefined)
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(card().textContent).toContain(entry.source)
  expect(card().textContent).toContain('草稿已保存并启用')
  expect(card().querySelector('.ptcPlusBindingCommandActions')).toBeNull()
})

test('Client owns one command renderer and releases it on disable', async () => {
  const { runtime, events, feature, settings, value } = await fixture()
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  const view = runtime.renderRoot()
  expect(view.container.textContent).toContain('PTC Plus')
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(0)
  settings.publish({ value })
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  await feature.dispose()
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(0)
  expect(settings.listenerCount()).toBe(0)
})

test.each([
  ['Save as disabled', 'save-draft', 'saved', 'Draft saved as a disabled entry'],
  ['Discard draft', 'discard-draft', 'discarded', 'Draft discarded'],
])('command action %s keeps source inspection after locator clearance', async (label, operation, state, receipt) => {
  const candidate = { requestId: 'action-request', commandId: 'action-command', version: 1, mode: 'new',
    entry: { id: 'action', name: 'action', scope: 'namespace', purpose: '', enabled: false,
      symbols: ['value'], source: 'export const value = 7' } }
  let action = null
  const rpc = async endpoint => {
    if (endpoint === operation) { action = { requestId: candidate.requestId, id: 'action', state, enabled: false }; return { ok: true, value: null } }
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [] } }
    if (endpoint === 'draft-review') return { ok: true, value: { candidate, action } }
    return { ok: true, value: action === null ? candidate : null }
  }
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: 'action-command', args: ' new action', outcome: null }]]) }
  const { runtime } = await fixture({ rpc, turn })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', { phase: 'ready', commandId: 'action-command', capability: 'action-capability' })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: label }))
  await runtime.flush()
  projection.set('ptcPlusBindingDraft', { phase: 'idle', commandId: null, capability: null })
  await runtime.flush()
  const card = view.container.querySelector('.ptcPlusBindingCommand')
  expect(card.textContent).toContain(receipt)
  expect(card.textContent).toContain(candidate.entry.source)
  expect(card.querySelector('.ptcPlusBindingCommandActions')).toBeNull()
})

test.each([{ enabled: false }, { bindings: false }])('disabled features remain dark: %j', async options => {
  const { runtime, events, rpcCalls } = await fixture(options)
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.textContent).toContain('PTC Plus')
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.input.left')).toHaveLength(0)
  expect(rpcCalls).toEqual([])
})

test.each([
  ['mixed settings', { looseTopLevelRedeclarations: false }, 'stateful'],
  ['mixed settings', { looseTopLevelRedeclarations: false }, 'protected'],
  ['explicit marker', { bindingUpdates: 'stateful', legacyBindingSettings: true }, 'stateful'],
  ['explicit marker', { bindingUpdates: 'protected', legacyBindingSettings: true }, 'protected'],
])('migrating %s (%j) to %s displays the active policy and exits compatibility atomically', async (_label, legacy, policy) => {
  const { runtime, settings, value } = await fixture({ bindings: false })
  settings.publish({ value: { enabled: true, ...legacy } })
  const migration = Promise.withResolvers()
  settings.mutate.mockImplementation(async operations => {
    await migration.promise
    const next = { ...settings.scope.getSnapshot().value }
    for (const operation of operations) next[operation.path[0]] = operation.value
    settings.publish({ value: next })
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  await runtime.flush()
  const selector = view.getByRole('combobox', { name: 'Allow redeclarations and overrides' })
  expect(selector.value).toBe('legacy')
  expect(selector.selectedOptions[0].textContent).toBe('Legacy settings (not migrated)')
  expect(view.queryByRole('switch', { name: 'Allow redeclarations and overrides' })).toBeNull()
  expect(view.getByRole('switch', { name: 'Allow top-level variable redeclarations' }).checked)
    .toBe(legacy.looseTopLevelRedeclarations ?? value.looseTopLevelRedeclarations)
  expect(settings.mutate).not.toHaveBeenCalled()
  expect(settings.set).not.toHaveBeenCalled()
  fireEvent.change(selector, { target: { value: policy } })
  await runtime.flush()
  expect(selector.disabled).toBe(true)
  expect(selector.value).toBe('legacy')
  expect(settings.mutate).toHaveBeenCalledWith([
    { op: 'set', path: ['bindingUpdates'], value: policy },
    { op: 'set', path: ['legacyBindingSettings'], value: false },
  ])
  fireEvent.change(selector, { target: { value: policy } })
  await runtime.flush()
  expect(settings.mutate).toHaveBeenCalledTimes(1)
  migration.resolve()
  await runtime.flush()
  expect(settings.set).not.toHaveBeenCalled()
  expect(view.queryByRole('combobox', { name: 'Allow redeclarations and overrides' })).toBeNull()
  expect(view.container.querySelector('[aria-label="Allow top-level variable redeclarations"]')).toBeNull()
  const toggle = view.getByRole('switch', { name: 'Allow redeclarations and overrides' })
  expect(toggle.checked).toBe(policy === 'stateful')
  expect(toggle.disabled).toBe(false)
  fireEvent.click(toggle)
  await runtime.flush()
  expect(settings.scope.getSnapshot().value.bindingUpdates).toBe(policy === 'stateful' ? 'protected' : 'stateful')
  expect(settings.scope.getSnapshot().value.legacyBindingSettings).toBe(false)
})

test.each([
  { writable: false, enabled: true },
  { writable: true, enabled: false },
])('legacy policy selection respects settings availability: %j', async ({ writable, enabled }) => {
  const { runtime, settings, setLocale } = await fixture({ bindings: false })
  settings.publish({ writable, value: { enabled, looseTopLevelRedeclarations: false } })
  setLocale('zh')
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  await runtime.flush()
  const selector = view.getByRole('combobox', { name: '允许重声明和覆盖' })
  expect(selector.value).toBe('legacy')
  expect(selector.selectedOptions[0].textContent).toBe('沿用旧版设置（尚未迁移）')
  expect(selector.disabled).toBe(true)
  fireEvent.change(selector, { target: { value: 'stateful' } })
  await runtime.flush()
  expect(settings.mutate).not.toHaveBeenCalled()
  expect(settings.set).not.toHaveBeenCalled()
})

test('renderer follows current Session projections and cleans settings subscriptions', async () => {
  const { runtime, settings, value, feature } = await fixture({ bindings: false })
  const view = runtime.renderRoot()
  const subscriptions = settings.listenerCount()
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusRepl', { available: true, total: 1, omitted: 0, entries: [{
    name: 'visibleValue', kind: 'variable', definition: { source: 'let visibleValue = 1', line: 1, column: 1 },
  }] })
  await runtime.flush()
  expect(view.container.textContent).toContain('visibleValue')
  projection.set('agentPreset', 'default')
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusActive')).toBeNull()
  projection.set('agentPreset', 'ptc')
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusActive')).not.toBeNull()
  settings.publish({ value: { ...value, enabled: false } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusActive')).toBeNull()
  settings.publish({ value })
  await runtime.flush()
  expect(settings.listenerCount()).toBe(subscriptions)
  await feature.dispose()
  expect(settings.listenerCount()).toBe(0)
})

test('command availability uses a stable Session source and survives renderer remount and reset', async () => {
  const list = vi.fn(async () => ({ ok: true, value: [{ name: 'binding' }] }))
  const { runtime, remote, input, feature, settings, value } = await fixture({ commands: { list } })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(1)
  expect(list).toHaveBeenLastCalledWith('client-session')
  const entry = runtime.slots.entries('conversation.input.left')[0]
  const source = entry.inject('client-session').hooks.bindingCommand
  expect(entry.inject('client-session').hooks.bindingCommand).toBe(source)
  const release = source.subscribe(() => {})
  expect(list).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByRole('button', { name: 'Global bindings' }))
  await runtime.flush()
  view.container.querySelector('.ptcPlusComposerBindingAnchor').getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  expect(input.scope.getSnapshot().draft).toBe('/binding new ')
  release()
  await runtime.sessions.setCurrent(undefined)
  const before = list.mock.calls.length
  remote.emit('commands/change', [])
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(before)
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(before + 1)
  expect(entry.inject('client-session').hooks.bindingCommand).toBe(source)
  list.mockResolvedValue({ ok: true, value: [] })
  runtime.ctx.emit('connection/reset')
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Global bindings' }))
  await runtime.flush()
  expect(view.queryByRole('menuitem', { name: 'Write a new binding' })).toBeNull()
  expect(view.getByRole('menuitem', { name: 'Manage global bindings' })).not.toBeNull()
  list.mockResolvedValue({ ok: true, value: [{ name: 'binding' }] })
  remote.emit('commands/change', [])
  await runtime.flush()
  expect(view.queryByRole('button', { name: 'Global bindings' })).not.toBeNull()
  settings.publish({ value: { ...value, bindingAuthorButtonVisible: false } })
  await runtime.flush()
  expect(view.queryByRole('button', { name: 'Global bindings' })).toBeNull()
  expect(input.scope.getSnapshot().draft).toBe('/binding new ')
  expect(source.getSnapshot()).toBe(true)
  settings.publish({ value })
  await runtime.flush()
  expect(view.queryByRole('button', { name: 'Global bindings' })).not.toBeNull()
  await feature.dispose()
  const disposedCount = list.mock.calls.length
  remote.emit('commands/change', [])
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(disposedCount)
})

test.each(['pending', 'failed'])('command lifecycle %s uses locale and preserves original errors', async phase => {
  const rawError = 'Original provider error'
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: 'lifecycle', args: ' new helper',
    outcome: phase === 'failed' ? { kind: 'error', text: rawError } : null }]]) }
  const { runtime, setLocale } = await fixture({ turn })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelectorAll('.ptcPlusBindingCommand')).toHaveLength(1)
  expect(view.container.textContent).toContain(phase === 'pending' ? 'Processing authoring request…' : 'No saveable draft was produced')
  setLocale('zh')
  await runtime.flush()
  expect(view.container.textContent).toContain(phase === 'pending' ? '正在处理编写请求…' : '未生成可保存的草稿')
  if (phase === 'failed') expect(view.container.textContent).toContain(rawError)
})

test.each(['empty', 'conflict'])('draft card distinguishes revoked locators from failed reads: %s', async response => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let revoked = false
  const draft = reviewCandidate('draft-command')
  const rpc = vi.fn(async endpoint => {
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [] } }
    if (endpoint === 'draft' && revoked && response === 'conflict') return { ok: false, error: { code: 'BINDINGS_CONFLICT', message: 'Draft expired' } }
    if (endpoint === 'draft-review') return { ok: true, value: { candidate: draft, action: null } }
    return { ok: true, value: revoked ? null : draft }
  })
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: 'draft-command', args: ' new helper', outcome: null }]]) }
  const { runtime, feature } = await fixture({ rpc, turn })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', {
    phase: 'ready', capability: 'opaque-draft', commandId: 'draft-command',
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock .ptcPlusAuthoringDraft')).not.toBeNull()
  revoked = true
  await vi.advanceTimersByTimeAsync(1500)
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock .ptcPlusAuthoringDraft')).not.toBeNull()
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  revoked = false
  await vi.advanceTimersByTimeAsync(1500)
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(response === 'empty')
  await feature.dispose()
  const calls = rpc.mock.calls.length
  await vi.advanceTimersByTimeAsync(4500)
  expect(rpc).toHaveBeenCalledTimes(calls)
})

test('conversation slots remain active independently of a renamed optional service', async () => {
  const { runtime, events, settings, provideConversation } = await fixture({ conversation: false })
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  const view = runtime.renderRoot()
  expect(view.container.textContent).toContain('PTC Plus')
  const provider = await provideConversation()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  await provider.dispose()
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  expect(view.container.textContent).toContain('PTC Plus')
  await provideConversation()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  settings.publish({ value: { enabled: false, userBindingsEnabled: true } })
  await runtime.flush()
  expect(events.entries()).toHaveLength(0)
})

test('legacy conversation registry uses public slots and releases them with their owner', async () => {
  const { runtime, events } = await fixture({ conversation: false })
  runtime.ctx.provide('conversationEvents', events)
  await runtime.flush()
  const view = runtime.renderRoot()
  expect(view.container.querySelector('.ptcPlusCard')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusActive')).not.toBeNull()
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  view.unmount()
  runtime.root.release()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(0)
})

function reviewCandidate(commandId, version = 1) {
  return { requestId: `${commandId}-request`, commandId, version, mode: 'new',
    entry: { id: commandId, name: commandId, scope: 'namespace', purpose: 'Review purpose',
      enabled: false, symbols: ['value'], source: `export const value = ${version}`,
      modelContext: { includeDeclaration: false, instructions: `Use ${commandId}.value` } } }
}

function reviewProjection(candidate, capability = candidate.commandId + '-capability', action = null) {
  return { phase: 'ready', commandId: candidate.commandId, capability,
    history: [{ commandId: candidate.commandId, acceptedSeq: 4, candidate, action }] }
}

function reviewRpc(candidate) {
  return async endpoint => ({ ok: true, value: endpoint === 'list' ? { revision: 1, entries: [] }
    : endpoint === 'draft-review' ? { candidate, action: null } : candidate })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** The composer entry opens on hover intent, so a crossing alone leaves no menu. */
async function hoverOpenMenu(view, trigger) {
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  await vi.waitFor(() => { expect(view.queryByRole('menu')).not.toBeNull() })
}

async function openDraftMenu(view, runtime, mode = 'click') {
  const trigger = view.getByRole('button', { name: /Binding drafts \(1\)/ })
  // JSDOM has no layout; actual visibility and Host takeovers are browser checks.
  trigger.closest('.ptcPlusComposerBindingAnchor').getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  if (mode === 'hover') await hoverOpenMenu(view, trigger)
  else if (mode === 'keyboard') fireEvent.keyDown(trigger, { key: 'ArrowUp' })
  else fireEvent.click(trigger)
  await runtime.flush()
  if (mode === 'keyboard') await new Promise(requestAnimationFrame)
  return trigger
}

async function openGlobalMenu(view, runtime, mode = 'hover') {
  const trigger = view.container.querySelector('.ptcPlusAuthorButton')
  trigger.closest('.ptcPlusComposerBindingAnchor').getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  if (mode === 'hover') await hoverOpenMenu(view, trigger)
  else fireEvent.click(trigger)
  await runtime.flush()
  return trigger
}

test('global binding menu works before authoring is available and preserves the input', async () => {
  const entry = { ...reviewCandidate('fileTools').entry, enabled: false }
  let catalog = { revision: 'r1', entries: [entry] }
  const rpc = vi.fn(async (endpoint, payload) => {
    if (endpoint === 'enable') {
      expect(payload).toEqual({ id: 'fileTools', expectedRevision: 'r1' })
      catalog = { revision: 'r2', entries: [{ ...entry, enabled: true }] }
    }
    return { ok: true, value: endpoint === 'load' ? { revision: catalog.revision, entry: catalog.entries[0] } : catalog }
  })
  const { runtime, input, feature } = await fixture({ rpc })
  input.publish({ draft: 'Keep my message' })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  expect(view.getByText('Global bindings · Applies to all sessions')).not.toBeNull()
  expect(view.queryByRole('menuitem', { name: 'Write a new binding' })).toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: /fileTools/ }))
  await runtime.flush()
  expect(view.getByRole('menuitem', { name: /fileTools/ }).textContent).toContain('Enabled')
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'enable')).toHaveLength(1)
  expect(input.scope.getSnapshot().draft).toBe('Keep my message')
  fireEvent.click(view.getByRole('menuitem', { name: 'Manage global bindings' }))
  await runtime.flush()
  expect(view.getByRole('dialog')).not.toBeNull()
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Close global bindings workbench' }))
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(rpc.mock.calls.every(([endpoint]) => ['list', 'enable', 'load'].includes(endpoint))).toBe(true)
  await feature.dispose()
})

test('global toggles settle while closed, prevent duplicate writes and require reread after conflict', async () => {
  const entry = { ...reviewCandidate('toggle').entry, enabled: false }
  let catalog = { revision: 'r1', entries: [entry] }
  const pending = deferred()
  const rpc = vi.fn(async endpoint => {
    if (endpoint === 'enable') { await pending.promise; catalog = { revision: 'r2', entries: [{ ...entry, enabled: true }] } }
    if (endpoint === 'disable') return { ok: false, error: { code: 'CONFLICT', message: 'Revision conflict', details: null } }
    return { ok: true, value: catalog }
  })
  const { runtime } = await fixture({ rpc })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  const row = view.getByRole('menuitem', { name: /toggle/ })
  fireEvent.click(row)
  fireEvent.click(row)
  await runtime.flush()
  expect(row.disabled).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  expect(view.getByRole('menuitem', { name: /toggle/ }).disabled).toBe(true)
  pending.resolve()
  await runtime.flush()
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'enable')).toHaveLength(1)
  expect(view.getByRole('menuitem', { name: /toggle/ }).textContent).toContain('Enabled')
  fireEvent.click(view.getByRole('menuitem', { name: /toggle/ }))
  await runtime.flush()
  expect(view.getByText(/Revision conflict/)).not.toBeNull()
  expect(view.queryByRole('menuitem', { name: /toggle/ })).toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Reload' }))
  await runtime.flush()
  expect(view.getByRole('menuitem', { name: /toggle/ }).textContent).toContain('Enabled')
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'disable')).toHaveLength(1)
})

test('global menu rejects old reads after connection reset, navigation and feature disposal', async () => {
  const entry = reviewCandidate('obsolete').entry
  let pending
  const rpc = async () => ({ ok: true, value: pending ? await pending.promise : { revision: 'r2', entries: [] } })
  const { runtime, feature } = await fixture({ rpc })
  const view = runtime.renderRoot()
  await runtime.flush()
  pending = deferred()
  await openGlobalMenu(view, runtime)
  runtime.ctx.emit('connection/reset')
  await runtime.flush()
  pending.resolve({ revision: 'r1', entries: [entry] })
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  pending = null
  await openGlobalMenu(view, runtime)
  expect(view.queryByRole('menuitem', { name: /obsolete/ })).toBeNull()
  expect(view.getByText('No global default bindings')).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  pending = deferred()
  await openGlobalMenu(view, runtime)
  // The star entry follows the current PTC preset, so the navigation target must
  // stay a PTC session for this stale-read check to keep its subject mounted.
  await runtime.sessions.add({ id: 'fresh', summary: { agentPreset: 'ptc' } })
  await runtime.sessions.setCurrent('fresh')
  await runtime.flush()
  pending.resolve({ revision: 'r1', entries: [entry] })
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  pending = null
  await openGlobalMenu(view, runtime)
  expect(view.queryByRole('menuitem', { name: /obsolete/ })).toBeNull()
  await feature.dispose()
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
})

test.each(['toggle', 'reload'].flatMap(operation => ['settled', 'closed', 'moved', 'moved-closed', 'failed'].map(outcome => [operation, outcome])))
('global %s preserves menu focus after %s', async (operation, outcome) => {
  const entry = { ...reviewCandidate('keyboard').entry, enabled: false }
  const pending = deferred()
  const rpc = async endpoint => endpoint === (operation === 'reload' ? 'reload' : 'enable') ? pending.promise
    : { ok: true, value: operation === 'reload'
      ? { revision: null, entries: [], error: 'Invalid bindings document' }
      : { revision: 'r1', entries: [entry] } }
  const { runtime } = await fixture({ rpc,
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  const row = view.getByRole('menuitem', { name: operation === 'reload' ? 'Reload' : /keyboard/ })
  row.focus()
  fireEvent.click(row)
  await runtime.flush()
  if (operation === 'reload') expect(row.isConnected).toBe(false)
  else expect(row.disabled).toBe(true)
  // Chromium blurs disabled buttons; JSDOM needs that browser transition explicitly.
  row.blur()
  let expectedFocus = row
  if (outcome === 'closed') {
    fireEvent.keyDown(document, { key: 'Escape' })
    await runtime.flush()
    expectedFocus = view.container.querySelector('.ptcPlusAuthorButton')
    expect(document.activeElement).toBe(expectedFocus)
  } else if (outcome.startsWith('moved')) {
    const otherInput = document.createElement('input')
    view.container.appendChild(otherInput)
    otherInput.focus()
    expectedFocus = otherInput
    if (outcome === 'moved-closed') {
      fireEvent.keyDown(document, { key: 'Escape' })
      await runtime.flush()
      expect(document.activeElement).toBe(otherInput)
    }
  }
  pending.resolve(outcome === 'failed'
    ? { ok: false, error: { code: 'CONFLICT', message: 'Revision conflict', details: null } }
    : { ok: true, value: { revision: 'r2', entries: [{ ...entry, enabled: true }] } })
  await runtime.flush()
  if (outcome === 'failed') expectedFocus = view.getByRole('menuitem', { name: 'Reload' })
  else if (operation === 'reload' && outcome === 'settled') expectedFocus = view.getByRole('menuitem', { name: /keyboard/ })
  expect(document.activeElement).toBe(expectedFocus)
})

test('explicit global menu reload clears a cached storage error', async () => {
  const entry = reviewCandidate('repaired').entry
  let cached = { revision: null, entries: [], error: 'Invalid bindings document' }
  const rpc = vi.fn(async endpoint => {
    if (endpoint === 'reload') cached = { revision: 'r1', entries: [entry] }
    return { ok: true, value: cached }
  })
  const { runtime } = await fixture({ rpc })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  expect(view.getByText(/Invalid bindings document/)).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  expect(view.getByText(/Invalid bindings document/)).not.toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Reload' }))
  await runtime.flush()
  expect(view.getByRole('menuitem', { name: /repaired/ })).not.toBeNull()
  expect(view.queryByText(/Invalid bindings document/)).toBeNull()
  expect(rpc.mock.calls.at(-1)[0]).toBe('reload')
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'reload')).toHaveLength(1)
  expect(rpc.mock.calls.every(([endpoint]) => ['list', 'reload'].includes(endpoint))).toBe(true)
})

test('the composer entry opens on hover intent and leaves with the pointer', async () => {
  const entry = { ...reviewCandidate('pointer').entry, enabled: false }
  const { runtime } = await fixture({ rpc: async () => ({ ok: true, value: { revision: 'r1', entries: [entry] } }) })
  const view = runtime.renderRoot()
  await runtime.flush()
  const trigger = view.container.querySelector('.ptcPlusAuthorButton')
  trigger.closest('.ptcPlusComposerBindingAnchor').getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  await runtime.flush()
  // Crossing the entry leaves nothing behind; dwelling on it opens the menu.
  expect(view.queryByRole('menu')).toBeNull()
  await vi.waitFor(() => { expect(view.queryByRole('menu')).not.toBeNull() })
  // The pointer may cross the composer edge into the portaled list, so the leave
  // only arms a close that re-entering the list cancels.
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  fireEvent.pointerEnter(view.getByRole('menuitem', { name: /pointer/ }), { pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 300))
  await runtime.flush()
  expect(view.queryByRole('menu')).not.toBeNull()
  fireEvent.pointerLeave(view.getByRole('menuitem', { name: /pointer/ }), { pointerType: 'mouse' })
  await vi.waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
})

test('a click pins the open composer menu against the pointer and a second click releases it', async () => {
  const entry = { ...reviewCandidate('pinned').entry, enabled: false }
  const { runtime } = await fixture({ rpc: async () => ({ ok: true, value: { revision: 'r1', entries: [entry] } }) })
  const view = runtime.renderRoot()
  await runtime.flush()
  const trigger = await openGlobalMenu(view, runtime)
  // The same pointer leave takes an unclicked menu away, which is what the click pins.
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  await vi.waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
  await openGlobalMenu(view, runtime)
  fireEvent.click(trigger)
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 300))
  await runtime.flush()
  expect(view.queryByRole('menu')).not.toBeNull()
  fireEvent.click(trigger)
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
})

test('an open composer menu follows its anchor when the composer moves without a scroll', async () => {
  let top = 500
  const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.classList?.contains('ptcPlusComposerBindingAnchor') ? new DOMRect(20, top, 24, 24) : new DOMRect()
  })
  cleanups.push(() => rects.mockRestore())
  const entry = { ...reviewCandidate('moving').entry, enabled: false }
  const { runtime, setLocale } = await fixture({ rpc: async () => ({ ok: true, value: { revision: 'r1', entries: [entry] } }) })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  const menu = view.getByRole('menu')
  expect(menu.style.top).toBe('496px')
  // The list must stay next to the trigger, so the height budget is measured from
  // the trigger's own top edge, not from a taller composer container.
  expect(menu.style.getPropertyValue('--ptc-plus-menu-space')).toBe('484px')
  // A composer that grew (or moved) without emitting a scroll still moves the list,
  // because the placement effect re-reads the anchor on every entry render.
  top = 440
  setLocale('zh')
  await runtime.flush()
  expect(menu.style.top).toBe('436px')
  expect(menu.style.getPropertyValue('--ptc-plus-menu-space')).toBe('424px')
})

test('a global row stays actionable while a later catalog read is pending', async () => {
  const entry = { ...reviewCandidate('reread').entry, enabled: false }
  const pending = deferred()
  let holdRead = false
  const rpc = vi.fn(async endpoint => {
    if (endpoint === 'list') {
      return holdRead ? pending.promise : { ok: true, value: { revision: 'r1', entries: [entry] } }
    }
    if (endpoint === 'enable') return { ok: true, value: { revision: 'r2', entries: [{ ...entry, enabled: true }] } }
    throw new Error(endpoint)
  })
  const { runtime } = await fixture({ rpc })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  holdRead = true
  await openGlobalMenu(view, runtime)
  // The row acts on the catalog already on screen instead of waiting for the read.
  expect(view.queryByText('Loading bindings…')).toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: /reread/ }))
  await runtime.flush()
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'enable')).toHaveLength(1)
  expect(rpc.mock.calls.find(([endpoint]) => endpoint === 'enable')[1]).toEqual({ id: 'reread', expectedRevision: 'r1' })
  pending.resolve({ ok: true, value: { revision: 'r3', entries: [{ ...entry, enabled: true }] } })
  await runtime.flush()
  expect(view.getByRole('menuitem', { name: /reread/ }).textContent).toContain('Enabled')
})

test.each([true, false])('history and dock share read-only model context with declaration included=%s', async includeDeclaration => {
  const candidate = reviewCandidate('context')
  candidate.entry.modelContext = { includeDeclaration, instructions: includeDeclaration ? 'Render {{name}} literally\n<script>sample</script>' : '' }
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: candidate.commandId, args: ' new helper', outcome: null }]]) }
  const { runtime } = await fixture({ rpc: reviewRpc(candidate), turn })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const contexts = view.container.querySelectorAll('.ptcPlusCandidateContext')
  expect(contexts).toHaveLength(2)
  for (const context of contexts) {
    expect(context.querySelector('input,button,script')).toBeNull()
    expect(context.querySelector('.ptcPlusCandidateDeclaration dd').textContent).toBe(
      includeDeclaration ? 'Include in model context' : 'Exclude from model context')
    expect(context.querySelector('.ptcPlusCandidatePrompt dd').textContent).toBe(
      candidate.entry.modelContext.instructions || 'No prompt configured')
    expect(document.getElementById(context.getAttribute('aria-labelledby')).textContent).toBe('Model context')
  }
})

test.each(['expanded', 'collapsed', 'hidden'].flatMap(visibility => [
  ['Save as disabled', 'save-draft', 'saved'], ['Save and enable', 'save-draft', 'saved'], ['Discard draft', 'discard-draft', 'discarded'],
].map(action => [visibility, ...action])))('%s panel closes after %s succeeds', async (visibility, label, endpoint, state) => {
  const candidate = reviewCandidate('auto-close')
  const write = deferred()
  let action = null
  const { runtime } = await fixture({
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async name => name === endpoint ? write.promise
      : name === 'draft-review' ? { ok: true, value: { candidate, action } } : reviewRpc(candidate)(name),
  })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const geometry = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(20, 500, 24, 24)])
  cleanups.push(() => geometry.mockRestore())
  // Blink dispatches focusout while removing a focused subtree; JSDOM omits it.
  const removeChild = Node.prototype.removeChild
  const removal = vi.spyOn(Node.prototype, 'removeChild').mockImplementation(function (child) {
    if (child.contains(document.activeElement)) fireEvent.focusOut(document.activeElement, { relatedTarget: null })
    return removeChild.call(this, child)
  })
  cleanups.push(() => removal.mockRestore())
  const button = view.getByRole('button', { name: label })
  button.focus()
  fireEvent.click(button)
  if (visibility !== 'expanded') {
    const control = view.getByRole('button', { name: visibility === 'collapsed' ? 'Collapse binding draft' : 'Close binding draft panel' })
    control.focus()
    fireEvent.click(control)
  }
  await runtime.flush()
  action = { requestId: candidate.requestId, id: candidate.entry.id, state, enabled: label === 'Save and enable' }
  write.resolve({ ok: true, value: null })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
  if (visibility !== 'hidden') expect(document.activeElement).toBe(view.container.querySelector('.ptcPlusAuthorButton'))
  projection.set('ptcPlusBindingDraft', structuredClone(reviewProjection(candidate)))
  runtime.ctx.emit('connection/reset')
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
})

test('refresh completion hides the exact candidate and cannot be reopened or hide its replacement', async () => {
  const candidate = reviewCandidate('refresh-completion')
  let action = null
  const reviews = createBindingReviews(async endpoint => endpoint === 'list' ? { revision: 1, entries: [] }
    : endpoint === 'draft-review' ? { candidate, action } : candidate)
  cleanups.push(() => reviews.dispose())
  const review = reviews.forSession('session')
  review.sync(reviewProjection(candidate))
  review.attach()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(review.getSnapshot().writable).toBe(true)
  action = { requestId: candidate.requestId, id: candidate.entry.id, state: 'saved', enabled: false }
  await review.refresh()
  expect(review.getSnapshot().visibility).toBe('hidden')
  expect(review.display('expanded', candidate)).toBe(false)
  const next = reviewCandidate('next')
  review.sync({ ...reviewProjection(next), history: [
    ...reviewProjection(candidate, 'old', action).history, ...reviewProjection(next).history,
  ] })
  expect(review.getSnapshot()).toMatchObject({ candidate: next, action: null, visibility: 'expanded' })
})

test('automatic closure preserves focus moved outside the pending review', async () => {
  const candidate = reviewCandidate('focus-outside')
  const write = deferred()
  const { runtime } = await fixture({ rpc: async endpoint => endpoint === 'save-draft' ? write.promise : reviewRpc(candidate)(endpoint) })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const save = view.getByRole('button', { name: 'Save and enable' })
  save.focus()
  fireEvent.click(save)
  await runtime.flush()
  expect(document.activeElement).toBe(view.container.querySelector('.ptcPlusBindingDock'))
  const outside = view.container.querySelector('.ptcPlusHeader')
  outside.focus()
  write.resolve({ ok: true, value: null })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(document.activeElement).toBe(outside)
})

test.each(['expanded', 'collapsed', 'hidden'])('unconfirmed discard retains %s display without claiming success', async visibility => {
  const candidate = reviewCandidate('unconfirmed-discard')
  let discarded = false
  const reviews = createBindingReviews(async endpoint => {
    if (endpoint === 'discard-draft') { discarded = true; return null }
    if (endpoint === 'list') return { revision: 1, entries: [] }
    if (endpoint === 'draft-review') return discarded ? null : { candidate, action: null }
    return discarded ? null : candidate
  })
  cleanups.push(() => reviews.dispose())
  const review = reviews.forSession('session')
  review.sync(reviewProjection(candidate))
  review.attach()
  await new Promise(resolve => setTimeout(resolve, 0))
  review.display(visibility)
  await review.act('discard-draft')
  expect(review.getSnapshot()).toMatchObject({ visibility, action: null, writable: false, message: 'bindings.reviewUnconfirmed' })
})

test('the composer binding entry follows the current session PTC preset', async () => {
  const { runtime, settings, value } = await fixture({
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const entries = () => runtime.slots.entries('conversation.input.left')
  const projection = runtime.sessions.behavior('client-session').projections
  expect(entries().map(entry => entry.options.id)).toEqual(['ptc-plus-binding-author'])
  expect(view.getByRole('button', { name: 'Global bindings' })).not.toBeNull()
  projection.set('agentPreset', 'chat')
  await runtime.flush()
  expect(entries()).toHaveLength(0)
  expect(view.queryByRole('button', { name: 'Global bindings' })).toBeNull()
  projection.set('agentPreset', 'code')
  await runtime.flush()
  expect(entries().map(entry => entry.options.id)).toEqual(['ptc-plus-binding-author'])
  expect(view.getByRole('button', { name: 'Global bindings' })).not.toBeNull()
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(entries()).toHaveLength(0)
  settings.publish({ value })
  await runtime.flush()
  expect(entries()).toHaveLength(1)
})

test('the composer menu revises an existing binding through its second step', async () => {
  const entries = [
    { ...reviewCandidate('revise').entry, enabled: true },
    { ...reviewCandidate('other').entry, enabled: false },
  ]
  const { runtime, input } = await fixture({
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async () => ({ ok: true, value: { revision: 'r1', entries } }),
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  expect(view.getByRole('menuitem', { name: 'Revise a binding' })).not.toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Revise a binding' }))
  await runtime.flush()
  // The same Menu stays open and swaps to the revision step with a way back.
  expect(view.getByRole('menu')).not.toBeNull()
  expect(view.getByRole('menuitem', { name: /revise/ }).textContent).toContain('Enabled')
  fireEvent.click(view.getByRole('menuitem', { name: 'Back' }))
  await runtime.flush()
  expect(view.getByRole('menuitem', { name: 'Revise a binding' })).not.toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Revise a binding' }))
  await runtime.flush()
  fireEvent.click(view.getByRole('menuitem', { name: /revise/ }))
  await runtime.flush()
  expect(input.scope.getSnapshot().draft).toBe('/binding edit revise ')
  expect(view.queryByRole('menu')).toBeNull()
})

test('one authoring icon owns the draft badge and hover, click and keyboard menu', async () => {
  const candidate = reviewCandidate('menu-draft')
  const rpc = vi.fn(reviewRpc(candidate))
  const { runtime, input, settings, value } = await fixture({ rpc,
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) } })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.input.left').map(entry => entry.options.id)).toEqual(['ptc-plus-binding-author'])
  expect(view.container.querySelectorAll('.ptcPlusAuthorButton')).toHaveLength(1)
  expect(view.container.querySelector('.ptcPlusDraftBadge').textContent).toBe('1')
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  const trigger = await openDraftMenu(view, runtime, 'hover')
  const menu = view.getByRole('menu')
  expect(view.container.contains(menu)).toBe(false)
  expect(view.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    'menu-draftDraft ready to save or discard', 'Write a new binding', 'Manage global bindings',
  ])
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  fireEvent.click(view.getAllByRole('menuitem')[0])
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  expect(view.container.querySelector('.ptcPlusBindingDock').textContent).toContain(candidate.entry.source)
  await openDraftMenu(view, runtime, 'keyboard')
  expect(document.activeElement).toBe(view.getAllByRole('menuitem')[0])
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await openDraftMenu(view, runtime)
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  await runtime.flush()
  expect(input.scope.getSnapshot().draft).toBe('/binding new ')
  input.publish({ draft: 'Unsent user text' })
  await openDraftMenu(view, runtime)
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  await runtime.flush()
  expect(input.scope.getSnapshot().draft).toBe('Unsent user text')
  expect(rpc.mock.calls.every(([endpoint]) => ['list', 'draft', 'draft-review'].includes(endpoint))).toBe(true)
  await openDraftMenu(view, runtime)
  await new Promise(requestAnimationFrame)
  trigger.getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  view.getByRole('menuitem', { name: 'Write a new binding' }).focus()
  settings.publish({ value: { ...value, bindingAuthorButtonVisible: false } })
  await runtime.flush()
  expect(view.getAllByRole('menuitem')).toHaveLength(1)
  expect(view.queryByRole('menuitem', { name: 'Write a new binding' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('the composer entry carries a plugin-signed tooltip that follows the draft state', async () => {
  const candidate = reviewCandidate('tooltip-entry')
  const { runtime } = await fixture({ rpc: reviewRpc(candidate),
    commands: { list: async () => ({ ok: true, value: [] }) } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const trigger = view.container.querySelector('.ptcPlusAuthorButton')
  expect(trigger.getAttribute('aria-label')).toBe('Global bindings')
  fireEvent.focus(trigger)
  await runtime.flush()
  expect(view.getByRole('tooltip').textContent)
    .toBe('PTC Plus plugin · Open the Global User Binding menu to author, toggle, or manage')
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  await runtime.flush()
  expect(trigger.getAttribute('aria-label')).toBe('Binding drafts (1)')
  expect(view.getByRole('tooltip').textContent).toBe('PTC Plus plugin · Binding draft pending; click to review')
})

test('a receipt arriving while a draft menu has focus returns focus to its authoring icon', async () => {
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function () {
    return this.matches('.ptcPlusAuthorButton, .ptcPlusComposerBindingAnchor') ? [new DOMRect(20, 500, 24, 24)] : []
  })
  cleanups.push(() => rects.mockRestore())
  const candidate = reviewCandidate('menu-receipt')
  const { runtime } = await fixture({ rpc: reviewRpc(candidate),
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) } })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  await openDraftMenu(view, runtime, 'keyboard')
  expect(document.activeElement.getAttribute('role')).toBe('menuitem')
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate, 'menu-receipt-capability', {
    requestId: candidate.requestId, id: candidate.entry.id, state: 'saved', enabled: true,
  }))
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  expect(view.container.querySelector('.ptcPlusDraftBadge')).toBeNull()
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Global bindings' }))
})

test('draft menu works without commands and revokes late command availability when the provider leaves', async () => {
  const candidate = reviewCandidate('no-command')
  const { runtime } = await fixture({ rpc: reviewRpc(candidate) })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  await openDraftMenu(view, runtime)
  expect(view.getAllByRole('menuitem')).toHaveLength(2)
  const pending = deferred()
  const provider = await runtime.mount({ apply(ctx) {
    const commands = { list: () => pending.promise }
    ctx.provide('remote.commands', commands)
  } })
  await provider.dispose()
  pending.resolve({ ok: true, value: [{ name: 'binding' }] })
  await runtime.flush()
  expect(view.getAllByRole('menuitem')).toHaveLength(2)
  const live = await runtime.mount({ apply(ctx) {
    const commands = { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) }
    ctx.provide('remote.commands', commands)
  } })
  await runtime.flush()
  expect(view.getAllByRole('menuitem')).toHaveLength(3)
  await live.dispose()
  await runtime.flush()
  expect(view.getAllByRole('menuitem')).toHaveLength(2)
})

test('draft menus close on candidate replacement, session navigation, feature disablement and disposal', async () => {
  const first = reviewCandidate('menu-first')
  const second = reviewCandidate('menu-second')
  const { runtime, settings, value, feature } = await fixture({ rpc: reviewRpc(first) })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(first))
  const view = runtime.renderRoot()
  await runtime.flush()
  await openDraftMenu(view, runtime)
  projection.set('ptcPlusBindingDraft', structuredClone(reviewProjection(first)))
  await runtime.flush()
  expect(view.getByRole('menuitem', { name: /menu-first/ }).textContent).toContain('menu-first')
  projection.set('ptcPlusBindingDraft', { ...reviewProjection(second), history: [
    ...reviewProjection(first).history, ...reviewProjection(second).history,
  ] })
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  await openDraftMenu(view, runtime)
  expect(view.getAllByRole('menuitem')).toHaveLength(2)
  expect(view.getByRole('menuitem', { name: /menu-second/ }).textContent).toContain('menu-second')
  await runtime.sessions.add({ id: 'menu-other' })
  await runtime.sessions.setCurrent('menu-other')
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  await openDraftMenu(view, runtime)
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  expect(view.container.querySelector('.ptcPlusDraftBadge')).toBeNull()
  settings.publish({ value })
  await runtime.flush()
  await openDraftMenu(view, runtime)
  await feature.dispose()
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  expect(settings.listenerCount()).toBe(0)
})

test('display actions reject stale candidates including same-version source mismatches', () => {
  const reviews = createBindingReviews(() => { throw new Error('Display must not call Host') })
  const review = reviews.forSession('exact-display')
  const first = reviewCandidate('display-first')
  const second = reviewCandidate('display-second')
  review.sync(reviewProjection(first))
  review.sync(reviewProjection(second))
  review.display('hidden')
  expect(review.display('expanded', first)).toBe(false)
  expect(review.getSnapshot().visibility).toBe('hidden')
  expect(review.display('expanded', { ...second, entry: { ...second.entry, source: 'other code' } })).toBe(false)
  expect(review.getSnapshot().visibility).toBe('hidden')
  expect(review.display('expanded', structuredClone(second))).toBe(true)
  expect(review.getSnapshot().visibility).toBe('expanded')
  reviews.dispose()
})

test('accepted source is immediate and only dock writes; display choices survive refresh, reset and session navigation', async () => {
  const candidate = reviewCandidate('placement')
  const catalog = deferred()
  let slow = true
  const rpc = vi.fn(async (endpoint, payload) => slow && endpoint === 'list'
    ? catalog.promise : reviewRpc(candidate)(endpoint, payload))
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: candidate.commandId,
    args: ' new preserve this requirement', outcome: { kind: 'success' } }]]) }
  const { runtime, settings, value } = await fixture({ rpc, turn })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const panel = () => view.container.querySelector('.ptcPlusBindingDock')
  const request = () => view.container.querySelector('.ptcPlusBindingCommand')
  expect(panel().textContent).toContain(candidate.entry.source)
  expect(panel().textContent).toContain(candidate.entry.modelContext.instructions)
  expect(request().textContent).toContain('/binding new preserve this requirement')
  expect(request().querySelector('details').open).toBe(false)
  expect(request().textContent).not.toContain('Save and enable')
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Collapse binding draft' }))
  await runtime.flush()
  expect(panel().querySelector('.ptcPlusBindingDockBody')).toBeNull()
  const disclosure = view.getByRole('button', { name: 'Expand binding draft' })
  expect(disclosure.contains(panel().querySelector('.ptcPlusBindingDockHeading'))).toBe(true)
  expect(disclosure.querySelector('.ptcPlusBindingDockChevron')).not.toBeNull()
  fireEvent.click(panel().querySelector('.ptcPlusBindingDockHeading strong'))
  await runtime.flush()
  expect(panel().querySelector('.ptcPlusBindingDockBody')).not.toBeNull()
  expect(view.getByRole('button', { name: 'Collapse binding draft' }).getAttribute('aria-expanded')).toBe('true')
  expect(panel().querySelector('.ptcPlusCandidateContext h4').textContent).toBe('Model context')
  fireEvent.click(panel().querySelector('.ptcPlusBindingDockHeading'))
  await runtime.flush()
  expect(panel().querySelector('.ptcPlusBindingDockBody')).toBeNull()
  slow = false
  catalog.resolve({ ok: true, value: { revision: 1, entries: [] } })
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Expand binding draft' }).getAttribute('aria-expanded')).toBe('false')
  await runtime.sessions.add({ id: 'second-session' })
  await runtime.sessions.setCurrent('second-session')
  await runtime.flush()
  expect(panel()).toBeNull()
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(panel().querySelector('.ptcPlusBindingDockBody')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  expect(panel()).toBeNull()
  settings.publish({ value: { ...value, bindingAuthorButtonVisible: false } })
  await runtime.ctx.parallel('connection/reset')
  projection.set('ptcPlusBindingDraft', structuredClone(reviewProjection(candidate)))
  await runtime.flush()
  expect(panel()).toBeNull()
  await openDraftMenu(view, runtime)
  fireEvent.click(view.getAllByRole('menuitem')[0])
  await runtime.flush()
  expect(panel().textContent).toContain(candidate.entry.source)
  expect(view.getAllByRole('button', { name: 'Save and enable' })).toHaveLength(1)
  expect(rpc.mock.calls.every(([endpoint]) => ['list', 'draft', 'draft-review'].includes(endpoint))).toBe(true)
  const body = panel().querySelector('.ptcPlusBindingDockBody')
  body.scrollTop = 500
  panel().scrollTop = 150
  projection.set('ptcPlusBindingDraft', structuredClone(reviewProjection(candidate)))
  await runtime.flush()
  expect(panel().querySelector('.ptcPlusBindingDockBody')).toBe(body)
  expect(body.scrollTop).toBe(500)
  expect(panel().scrollTop).toBe(150)
  const replacement = { ...candidate, version: candidate.version + 1 }
  projection.set('ptcPlusBindingDraft', reviewProjection(replacement))
  await runtime.flush()
  expect(panel().querySelector('.ptcPlusBindingDockBody')).not.toBe(body)
  expect(panel().querySelector('.ptcPlusBindingDockBody').scrollTop).toBe(0)
  expect(panel().scrollTop).toBe(0)
})

test.each(['saved', 'failed', 'unconfirmed'])('hidden pending action retains %s settlement without resubmission', async result => {
  const candidate = reviewCandidate('pending-action')
  const write = deferred()
  let action = null
  let draft = candidate
  const rpc = vi.fn(async endpoint => {
    if (endpoint === 'save-draft') return write.promise
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [] } }
    if (endpoint === 'draft-review') return { ok: true, value: { candidate, action } }
    return { ok: true, value: draft }
  })
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: candidate.commandId, args: ' new pending', outcome: null }]]) }
  const { runtime } = await fixture({ rpc, turn })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  await openDraftMenu(view, runtime)
  fireEvent.click(view.getAllByRole('menuitem')[0])
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  if (result === 'saved') {
    draft = null
    action = { requestId: candidate.requestId, id: candidate.entry.id, state: 'saved', enabled: true }
    write.resolve({ ok: true, value: { revision: 2, entries: [] } })
  } else {
    if (result === 'unconfirmed') draft = null
    write.reject(new Error('Connection lost'))
  }
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'save-draft')).toHaveLength(1)
  if (result === 'saved') {
    expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
    expect(view.queryByRole('button', { name: 'Open draft' })).toBeNull()
    expect(view.container.querySelector('.ptcPlusBindingCommand').textContent).toContain('Draft saved and enabled')
  } else {
    await openDraftMenu(view, runtime)
    fireEvent.click(view.getAllByRole('menuitem')[0])
    await runtime.flush()
    expect(view.container.querySelector('.ptcPlusBindingDock').textContent).toContain('Connection lost')
    expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(result === 'unconfirmed')
  }
})

test.each(['expanded', 'collapsed', 'hidden'].flatMap(visibility => ['empty', 'error'].map(receipt => [visibility, receipt])))
('projected discard survives a late %s/%s RPC settlement', async (visibility, receipt) => {
  const candidate = reviewCandidate('confirmed-discard')
  const write = deferred()
  let settling = false
  const rpc = async endpoint => {
    if (endpoint === 'discard-draft') { settling = true; return write.promise }
    if (settling && endpoint === 'draft-review') {
      if (receipt === 'error') throw new Error('Connection lost')
      return { ok: true, value: null }
    }
    return reviewRpc(candidate)(endpoint)
  }
  const { runtime } = await fixture({ rpc })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Discard draft' }))
  if (visibility !== 'expanded') fireEvent.click(view.getByRole('button', {
    name: visibility === 'collapsed' ? 'Collapse binding draft' : 'Close binding draft panel',
  }))
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate, 'confirmed-discard-capability', {
    requestId: candidate.requestId, id: candidate.entry.id, state: 'discarded', enabled: false,
  }))
  await runtime.flush()
  write.resolve({ ok: true, value: null })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
  expect(view.queryByRole('button', { name: 'Save and enable' })).toBeNull()
})

test('a successful eligibility refresh clears a transient read error while the dock stays hidden', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const candidate = reviewCandidate('read-recovery')
  let failed = false
  const rpc = async endpoint => {
    if (endpoint === 'draft' && failed) throw new Error('Connection lost')
    return reviewRpc(candidate)(endpoint)
  }
  const { runtime } = await fixture({ rpc })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  failed = true
  await vi.advanceTimersByTimeAsync(1500)
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock').textContent).toContain('Connection lost')
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Binding drafts (1) · Action status needs attention' })).not.toBeNull()
  failed = false
  await vi.advanceTimersByTimeAsync(1500)
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  await openDraftMenu(view, runtime)
  fireEvent.click(view.getAllByRole('menuitem')[0])
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock').textContent).not.toContain('Connection lost')
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(false)
})

test('a late draft read or write cannot replace a new candidate or another session', async () => {
  const first = reviewCandidate('first')
  const second = reviewCandidate('second', 2)
  const read = deferred()
  const write = deferred()
  let delayRead = true
  const rpc = async (endpoint, payload) => {
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [] } }
    if (endpoint === 'save-draft') return write.promise
    if (payload.capability === 'first-capability' && delayRead && endpoint === 'draft-review') return read.promise
    return reviewRpc(payload.capability === 'first-capability' ? first : second)(endpoint)
  }
  const { runtime } = await fixture({ rpc })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(first))
  const view = runtime.renderRoot()
  await runtime.flush()
  projection.set('ptcPlusBindingDraft', reviewProjection(second))
  await runtime.flush()
  read.resolve({ ok: true, value: { candidate: first, action: null } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock').textContent).toContain('Use second.value')
  delayRead = false
  projection.set('ptcPlusBindingDraft', reviewProjection(first))
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  await runtime.flush()
  await runtime.sessions.add({ id: 'other' })
  runtime.sessions.behavior('other').projections.set('ptcPlusBindingDraft', reviewProjection(second))
  await runtime.sessions.setCurrent('other')
  await runtime.flush()
  write.resolve({ ok: true, value: { revision: 2, entries: [] } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock').textContent).toContain('Use second.value')
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(false)
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(view.queryByRole('button', { name: 'Save and enable' })).toBeNull()
})

test('pending writes isolate candidates within one session and late settlement cannot unlock another write', async () => {
  const first = reviewCandidate('pending-first')
  const second = reviewCandidate('pending-second')
  const writes = new Map([[first.commandId, deferred()], [second.commandId, deferred()]])
  const rpc = vi.fn(async (endpoint, payload) => {
    const candidate = payload?.capability === first.commandId + '-capability' ? first : second
    if (endpoint === 'save-draft') return writes.get(candidate.commandId).promise
    return reviewRpc(candidate)(endpoint)
  })
  const { runtime } = await fixture({ rpc })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(first))
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  await runtime.flush()
  projection.set('ptcPlusBindingDraft', reviewProjection(second))
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(false)
  projection.set('ptcPlusBindingDraft', reviewProjection(first))
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  expect(view.container.querySelector('.ptcPlusBindingDock').getAttribute('aria-busy')).toBe('true')
  projection.set('ptcPlusBindingDraft', reviewProjection(second))
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  writes.get(first.commandId).resolve({ ok: true, value: { revision: 2, entries: [] } })
  await runtime.flush()
  await openDraftMenu(view, runtime)
  fireEvent.click(view.getAllByRole('menuitem')[0])
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock').textContent).toContain('Use pending-second.value')
  expect(view.container.querySelector('.ptcPlusBindingDock').getAttribute('aria-busy')).toBe('true')
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'save-draft')).toHaveLength(2)
  writes.get(second.commandId).resolve({ ok: true, value: { revision: 3, entries: [] } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(view.queryByRole('button', { name: 'Save and enable' })).toBeNull()
})

test.each(['saved', 'discarded'])('fresh review keeps %s history out of the dock', async state => {
  const candidate = reviewCandidate('completed')
  const action = { requestId: candidate.requestId, id: candidate.entry.id, state, enabled: state === 'saved' }
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: candidate.commandId,
    args: ' new keep completed history', outcome: { kind: 'success' } }]]) }
  const rpc = vi.fn(reviewRpc(candidate))
  const { runtime } = await fixture({ rpc, turn })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate, 'completed-capability', action))
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
  const request = view.container.querySelector('.ptcPlusBindingCommand')
  expect(request.getAttribute('data-phase')).toBe(state)
  expect(request.textContent).toContain(candidate.entry.source)
  expect(request.querySelector('details').open).toBe(false)
  expect(view.queryByRole('button', { name: 'Open draft' })).toBeNull()
  expect(view.queryByRole('button', { name: 'Save and enable' })).toBeNull()
  expect(rpc.mock.calls.some(([endpoint]) => endpoint === 'draft' || endpoint === 'draft-review')).toBe(false)
})

test('fresh review does not open a completed legacy RPC candidate', async () => {
  const candidate = reviewCandidate('completed-legacy')
  const rpc = async endpoint => ({ ok: true, value: endpoint === 'list' ? { revision: 1, entries: [] }
    : endpoint === 'draft-review' ? { candidate, action: { requestId: candidate.requestId,
      id: candidate.entry.id, state: 'saved', enabled: false } } : null })
  const { runtime } = await fixture({ rpc })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', {
    phase: 'ready', commandId: candidate.commandId, capability: 'legacy-capability',
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
})

test('history never borrows another request status or permission, including fallback to an older ready draft', async () => {
  const candidate = reviewCandidate('older')
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: 'failed-newer', args: ' new no result', outcome: { kind: 'success' } }]]) }
  const { runtime } = await fixture({ rpc: reviewRpc(candidate), turn })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const request = () => view.container.querySelector('.ptcPlusBindingCommand')
  expect(request().textContent).toContain('Request admitted; authoring result unknown')
  expect(request().querySelector('button')).toBeNull()
  await runtime.sessions.setCurrent(undefined)
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(request().textContent).toContain('Request admitted; authoring result unknown')
  projection.set('ptcPlusBindingDraft', { ...reviewProjection(candidate), phase: 'failed', commandId: 'failed-newer' })
  await runtime.flush()
  expect(request().textContent).toContain('No saveable draft was produced')
  expect(view.container.querySelector('.ptcPlusBindingDock')).toBeNull()
})

test('mismatched review source cannot authorize buttons under projected source', async () => {
  const candidate = reviewCandidate('exact')
  const impostor = structuredClone(candidate)
  impostor.entry.source = 'export const value = 999'
  const { runtime } = await fixture({ rpc: reviewRpc(impostor) })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingDock').textContent).toContain(candidate.entry.source)
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
})

test('missing dock retains compact requests and read-only history without a phantom reopen action', async () => {
  const candidate = reviewCandidate('missing-dock')
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: candidate.commandId, args: ' new helper', outcome: null }]]) }
  const { runtime, rpcCalls } = await fixture({ dock: false, turn })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingCommand').textContent).toContain('Draft review panel is temporarily unavailable')
  expect(view.queryByRole('button', { name: 'Open draft' })).toBeNull()
  expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
  expect(view.queryByRole('button', { name: 'Save and enable' })).toBeNull()
  expect(rpcCalls.every(call => call.endpoint === 'list')).toBe(true)
})


test('Client Remote owns cancellation, unwraps Gateway failures and revokes calls on disposal', async () => {
  const runtime = await SlotTestRuntime.create()
  cleanups.push(() => runtime.dispose())
  const calls = []
  runtime.ctx.provide('connection', {
    start: () => ({ stop() {} }), registerGenerationSource: () => () => {},
    rpc: { open: async function* () {}, async call(channel, endpoint, wire, signal) {
      calls.push({ channel, endpoint, wire, signal })
      if (wire.args.operation === 'failure') return { ok: false, error: { code: 'gateway/unavailable', message: 'Unavailable', details: {} } }
      if (wire.args.operation === 'wait') return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ ok: true, value: { ok: true, value: null } }), { once: true })
      })
      return { ok: true, value: { ok: true, value: wire.args.payload } }
    } },
  })
  await runtime.mount(TypertRegistry)
  await runtime.mount(gatewayClient)
  let rpc
  const feature = await runtime.mount({ inject: ['remote'], async apply(ctx) { rpc = await createClientRpc(ctx) } })
  expect(await rpc.call(RPC_CONTRACTS.bindings, 'list', { text: '{{literal}}' })).toEqual({ ok: true, value: { text: '{{literal}}' } })
  expect((await rpc.call(RPC_CONTRACTS.bindings, 'failure', {})).error.code).toBe('gateway/unavailable')
  const pending = rpc.call(RPC_CONTRACTS.repl, 'wait', {})
  await feature.dispose()
  expect((await pending).ok).toBe(false)
  expect(calls.at(-1).signal.aborted).toBe(true)
  await expect(rpc.call(RPC_CONTRACTS.bindings, 'list', {})).rejects.toThrow('unavailable')
  expect(calls).toHaveLength(3)
  expect(calls.every(call => call.channel === '/api')).toBe(true)
})

test('locale dictionaries derive every settings string from the shared config spec', () => {
  expect(LOCALE_NS).toBe('settings.ptcPlus')
  expect(Object.keys(SETTINGS_COPY.zh).sort()).toEqual(Object.keys(SETTINGS_COPY.en).sort())
  for (const field of CONFIG_FIELDS) {
    expect(SETTINGS_COPY.zh[`${field.key}.label`]).toBe(field.label)
    expect(SETTINGS_COPY.en[`${field.key}.label`]).toBe(field.labelEn)
    expect(SETTINGS_COPY.zh[`${field.key}.description`] ?? '').toBe(field.description)
    expect(SETTINGS_COPY.en[`${field.key}.description`] ?? '').toBe(field.descriptionEn)
  }
  for (const group of CONFIG_GROUPS) {
    expect(SETTINGS_COPY.zh[`group.${group.key}`]).toBe(group.label)
    expect(SETTINGS_COPY.en[`group.${group.key}`]).toBe(group.labelEn)
  }
})

test('manual saves carry explicit create or update intent and keep a duplicate draft on conflict', async () => {
  let entry = { id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text.',
    enabled: false, symbols: ['readText'], source: 'export const value = 1' }
  let revision = 1
  let createConflicts = true
  const { runtime, rpcCalls } = await fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: { revision, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision, entry } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: 'declare const value: number' } }
    if (endpoint === 'save') {
      if (payload.intent === 'create' && createConflicts) {
        createConflicts = false
        revision++
        return { ok: false, error: { code: 'BINDINGS_CONFLICT', message: 'A binding with this ID already exists' } }
      }
      entry = { ...entry, ...payload.entry }
      return { ok: true, value: { revision: ++revision, entries: [entry] } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const fields = () => [...workbench().querySelectorAll('.ptcPlusEntrySettings input')]
  const source = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  fireEvent.click(button('Edit'))
  await runtime.flush()
  // A stored entry is addressed by its stable ID, so the form keeps it read-only.
  expect(fields()[0].value).toBe('files')
  expect(fields()[0].disabled).toBe(true)
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 2' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.find(call => call.endpoint === 'save').payload).toMatchObject({
    intent: 'update', originalId: 'files', expectedRevision: 1,
    entry: { id: 'files', source: 'export const value = 2' },
  })
  // A new draft may choose its ID; a rejected duplicate keeps the draft intact.
  fireEvent.click(button('New entry'))
  await runtime.flush()
  expect(fields()[0].disabled).toBe(false)
  fireEvent.change(fields()[0], { target: { value: 'files' } })
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 3' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  const creates = rpcCalls.filter(call => call.endpoint === 'save' && call.payload.intent === 'create')
  expect(creates).toHaveLength(1)
  expect(creates[0].payload).toMatchObject({ originalId: null, expectedRevision: 2, entry: { id: 'files' } })
  expect(workbench().textContent).toContain('A binding with this ID already exists')
  expect(fields()[0].value).toBe('files')
  expect(source().state.doc.toString()).toBe('export const value = 3')
  fireEvent.click(button('Reload'))
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'save').at(-1).payload)
    .toMatchObject({ intent: 'create', originalId: null, expectedRevision: 3 })
})

test('the first catalog read gates creation and the new draft saves against the confirmed revision', async () => {
  // The store owns the baseline: a null or stale expectedRevision is a conflict.
  const firstRead = deferred()
  let revision = 0
  const stored = []
  const { runtime, rpcCalls } = await fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list') return firstRead.promise
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry,
      declaration: 'declare const freshTools: { value: number }' } }
    if (endpoint === 'save') {
      if (payload.expectedRevision !== revision) {
        return { ok: false, error: { code: 'BINDINGS_CONFLICT',
          message: `bindings document moved from revision ${payload.expectedRevision} to ${revision}` } }
      }
      // The store normalizes a saved entry, so the catalog always carries symbols.
      stored.push({ ...payload.entry, symbols: payload.entry.symbols ?? [] })
      revision += 1
      return { ok: true, value: { revision, entries: [...stored] } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  fireEvent.click([...view.container.querySelectorAll('button')]
    .find(button => button.textContent === 'Manage global bindings'))
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const fields = () => [...workbench().querySelectorAll('.ptcPlusEntrySettings input')]
  const source = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  // The first catalog read has not answered, so no revision is confirmed and the
  // New entry button must not start a draft that would carry a null baseline.
  expect(workbench().textContent).toContain('Loading Global User Bindings...')
  expect(button('New entry').disabled).toBe(true)
  fireEvent.click(button('New entry'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'validate' || call.endpoint === 'save')).toHaveLength(0)
  // An empty catalog is a valid baseline: revision 0.
  firstRead.resolve({ ok: true, value: { revision: 0, entries: [] } })
  await runtime.flush()
  expect(workbench().textContent).toContain('No global entries yet')
  expect(button('New entry').disabled).toBe(false)
  expect(workbench().querySelector('.ptcPlusBindingEditor')).toBeNull()
  fireEvent.click(button('New entry'))
  await runtime.flush()
  fireEvent.change(fields()[0], { target: { value: 'fresh' } })
  fireEvent.change(fields()[1], { target: { value: 'freshTools' } })
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 7' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  const saves = rpcCalls.filter(call => call.endpoint === 'save')
  expect(saves).toHaveLength(1)
  expect(saves[0].payload).toMatchObject({ intent: 'create', originalId: null, expectedRevision: 0,
    entry: { id: 'fresh', name: 'freshTools', source: 'export const value = 7' } })
  // The confirmed baseline made the first save succeed; no reload was needed.
  expect(rpcCalls.filter(call => call.endpoint === 'reload')).toHaveLength(0)
  expect(workbench().textContent).toContain('Entry saved; it takes effect from the next run_code request.')
  expect(workbench().querySelector('.ptcPlusBindingName').textContent).toBe('freshTools')
})

test('a failed first catalog read keeps creation unavailable until a retry confirms a revision', async () => {
  const stored = []
  const { runtime, rpcCalls } = await fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list') return { ok: false, error: { message: 'bindings transport failed' } }
    if (endpoint === 'reload') return { ok: true, value: { revision: 3, entries: [] } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry,
      declaration: 'declare const freshTools: { value: number }' } }
    if (endpoint === 'save') {
      if (payload.expectedRevision !== 3) {
        return { ok: false, error: { code: 'BINDINGS_CONFLICT',
          message: `bindings document moved from revision ${payload.expectedRevision} to 3` } }
      }
      stored.push({ ...payload.entry, symbols: payload.entry.symbols ?? [] })
      return { ok: true, value: { revision: 4, entries: [...stored] } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  fireEvent.click([...view.container.querySelectorAll('button')]
    .find(button => button.textContent === 'Manage global bindings'))
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const fields = () => [...workbench().querySelectorAll('.ptcPlusEntrySettings input')]
  const source = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  expect(workbench().textContent).toContain('Global User Binding operation failed: bindings transport failed')
  expect(button('New entry').disabled).toBe(true)
  fireEvent.click(button('New entry'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'validate' || call.endpoint === 'save')).toHaveLength(0)
  // The retry confirms a revision; only then may a draft exist.
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(button('New entry').disabled).toBe(false)
  expect(workbench().querySelector('.ptcPlusBindingEditor')).toBeNull()
  fireEvent.click(button('New entry'))
  await runtime.flush()
  fireEvent.change(fields()[0], { target: { value: 'fresh' } })
  fireEvent.change(fields()[1], { target: { value: 'freshTools' } })
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 7' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  const saves = rpcCalls.filter(call => call.endpoint === 'save')
  expect(saves).toHaveLength(1)
  expect(saves[0].payload).toMatchObject({ intent: 'create', originalId: null, expectedRevision: 3 })
  expect(workbench().textContent).toContain('Entry saved; it takes effect from the next run_code request.')
})

test('a background catalog refresh keeps an edited draft baseline and surfaces the real conflict', async () => {
  const entry = { id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text.',
    enabled: false, symbols: ['readText'], source: 'export const value = 1' }
  let revision = 1
  const { runtime, setVisible, rpcCalls } = await focusWorkbenchFixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: { revision, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision, entry } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry,
      declaration: 'declare const fileTools: { value: number }' } }
    if (endpoint === 'save') {
      return payload.expectedRevision === revision
        ? { ok: true, value: { revision: ++revision, entries: [entry] } }
        : { ok: false, error: { code: 'BINDINGS_CONFLICT',
            message: `bindings document moved from revision ${payload.expectedRevision} to ${revision}` } }
    }
    throw new Error(endpoint)
  } })
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const source = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  fireEvent.click(button('Edit'))
  await runtime.flush()
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 2' } })
  await runtime.flush()
  // Another writer advances the document while the draft is being edited. A Host
  // takeover hides the dialog and resuming re-reads the catalog.
  revision = 5
  await setVisible(false)
  await setVisible(true)
  expect(source().state.doc.toString()).toBe('export const value = 2')
  fireEvent.click(button('Save'))
  await runtime.flush()
  const saves = rpcCalls.filter(call => call.endpoint === 'save')
  expect(saves).toHaveLength(1)
  // The refresh published a newer catalog but never rebased the edited draft: the
  // save is still compared against the revision this draft was loaded from.
  expect(saves[0].payload).toMatchObject({ intent: 'update', originalId: 'files', expectedRevision: 1 })
  // The moved document is a real conflict, reported instead of silently accepted.
  expect(workbench().textContent).toContain('bindings document moved from revision 1 to 5')
  expect(source().state.doc.toString()).toBe('export const value = 2')
  expect(button('Save')).toBeDefined()
})

test('the workbench controller refuses a draft without a confirmed catalog revision', async () => {
  const firstRead = deferred()
  const { useWorkbenchController } = createUserBindingsWorkbench(React, {
    catalogOwner: createCatalogOwner({ callUserBindings: async (endpoint) => {
      if (endpoint === 'list') return firstRead.promise
      throw new Error(endpoint)
    } }),
  })
  let controller
  function Probe() {
    controller = useWorkbenchController({ enabled: true, active: true,
      callUserBindings: async () => { throw new Error('unused') } })
    return null
  }
  const rendered = render(React.createElement(Probe))
  cleanups.push(() => rendered.unmount())
  expect(controller.canCreate).toBe(false)
  // The transition itself is guarded, so no caller can create an unsaveable draft.
  act(() => controller.create())
  expect(controller.state.draft).toBeNull()
  expect(controller.state.creating).toBe(false)
  expect(controller.state.revision).toBeNull()
  firstRead.resolve({ revision: 0, entries: [] })
  await act(async () => {})
  expect(controller.canCreate).toBe(true)
  act(() => controller.create())
  expect(controller.state.creating).toBe(true)
  expect(controller.state.revision).toBe(0)
  expect(controller.state.draft).not.toBeNull()
})

test('typing draft fields keeps one source editor and one console environment', async () => {
  const entry = { id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text.',
    enabled: false, symbols: ['readText'], source: 'export const value = 1' }
  const { runtime, rpcCalls } = await fixture({ rpc: async endpoint => {
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision: 1, entry } }
    if (endpoint === 'console-run') return { ok: true, value: { environment: 'workbench-console', logs: [], output: '42', expiresAt: null } }
    if (endpoint === 'console-release') return { ok: true, value: null }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const fields = () => [...workbench().querySelectorAll('.ptcPlusEntrySettings input')]
  fireEvent.click(button('New entry'))
  await runtime.flush()
  const editor = EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  const consoleInput = EditorView.findFromDOM(workbench().querySelector('.ptcPlusExecutionInput .cm-content'))
  consoleInput.dispatch({ changes: { from: 0, to: consoleInput.state.doc.length, insert: 'value' } })
  await runtime.flush()
  fireEvent.click(button('Run'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'console-run')).toHaveLength(1)
  editor.dispatch({ selection: { anchor: 7 } })
  for (const letter of 'files') {
    fireEvent.change(fields()[0], { target: { value: fields()[0].value + letter } })
    await runtime.flush()
  }
  fireEvent.change(fields()[1], { target: { value: 'fileTools' } })
  fireEvent.change(fields()[3], { target: { value: 'Read text.' } })
  await runtime.flush()
  expect(fields()[0].value).toBe('files')
  // Form text is data, not document identity: no keystroke rebuilds the editor,
  // drops its selection or releases the temporary console environment.
  expect(EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))).toBe(editor)
  expect(EditorView.findFromDOM(workbench().querySelector('.ptcPlusExecutionInput .cm-content'))).toBe(consoleInput)
  expect(editor.state.selection.main.anchor).toBe(7)
  expect(rpcCalls.filter(call => call.endpoint === 'console-release')).toHaveLength(0)
  expect(rpcCalls.filter(call => call.endpoint === 'console-run')).toHaveLength(1)
  expect(workbench().querySelectorAll('.ptcPlusExecutionRecord')).toHaveLength(1)
})

async function focusWorkbenchFixture(options = {}) {
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) { if (element.querySelector('.ptcPlusAuthorButton')) visibility = this.callback }
    unobserve() {}
    disconnect() {}
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const fixtureState = await fixture({ rpc: reviewRpc(reviewCandidate('focus')), ...options })
  const { runtime } = fixtureState
  const view = runtime.renderRoot()
  await runtime.flush()
  const trigger = view.container.querySelector('.ptcPlusAuthorButton')
  const anchor = trigger.closest('.ptcPlusComposerBindingAnchor')
  // Visibility and focus ordering are injected; native approval is a browser check.
  let visible = true
  anchor.getClientRects = trigger.getClientRects = () => visible ? [new DOMRect(20, 500, 24, 24)] : []
  const setVisible = async next => {
    visible = next
    visibility([{ isIntersecting: next }])
    await runtime.flush()
  }
  await setVisible(true)
  const open = async () => {
    await openGlobalMenu(view, runtime, 'click')
    fireEvent.click(view.getByRole('menuitem', { name: 'Manage global bindings' }))
    await runtime.flush()
  }
  await open()
  const close = async () => {
    fireEvent.click(view.getByRole('button', { name: 'Close global bindings workbench' }))
    await runtime.flush()
  }
  const controls = document.createElement('div')
  const chat = document.createElement('button')
  chat.setAttribute('role', 'tab')
  chat.textContent = 'Chat'
  const host = document.createElement('button')
  host.textContent = 'Allow'
  for (const button of [chat, host]) button.getClientRects = () => [new DOMRect(0, 0, 40, 24)]
  controls.append(chat, host)
  document.body.append(controls)
  cleanups.push(() => controls.remove())
  return { ...fixtureState, view, trigger, anchor, chat, host, setVisible, open, close }
}

test('explicit workbench close restores the composer entry and keeps management closed', async () => {
  const { runtime, view, trigger, setVisible, close, rpcCalls } = await focusWorkbenchFixture()
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Close global bindings workbench' }))
  await close()
  expect(document.activeElement).toBe(trigger)
  const calls = rpcCalls.length
  await setVisible(false)
  await setVisible(true)
  expect(view.queryByRole('dialog')).toBeNull()
  expect(rpcCalls).toHaveLength(calls)
})

test('a Chat control reopening the workbench becomes its close target', async () => {
  const { view, trigger, chat, host, setVisible, close } = await focusWorkbenchFixture()
  const triggerFocus = vi.spyOn(trigger, 'focus')
  host.focus()
  await setVisible(false)
  expect(document.activeElement).toBe(host)
  expect(triggerFocus).not.toHaveBeenCalled()
  chat.focus()
  await setVisible(true)
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Close global bindings workbench' }))
  await close()
  expect(document.activeElement).toBe(chat)
})

test('approval-style hiding preserves Host focus and a body-focused resume keeps the entry target', async () => {
  const { view, trigger, host, setVisible, close, open, chat } = await focusWorkbenchFixture()
  const triggerFocus = vi.spyOn(trigger, 'focus')
  host.focus()
  await setVisible(false)
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(host)
  expect(triggerFocus).not.toHaveBeenCalled()
  host.blur()
  expect(document.activeElement).toBe(document.body)
  await setVisible(true)
  await close()
  expect(document.activeElement).toBe(trigger)
  await open()
  await setVisible(false)
  chat.focus()
  await setVisible(true)
  await setVisible(false)
  expect(document.activeElement).toBe(document.body)
  await setVisible(true)
  await close()
  expect(document.activeElement).toBe(chat)
})

test.each(['disconnected', 'disabled', 'hidden', 'inert', 'visibility', 'untabbable', 'aria-disabled'])
('workbench close rejects a %s return control and falls back to its live composer entry', async state => {
  const { trigger, chat, setVisible, close } = await focusWorkbenchFixture()
  await setVisible(false)
  chat.focus()
  await setVisible(true)
  if (state === 'disconnected') chat.remove()
  else if (state === 'disabled') chat.disabled = true
  else if (state === 'hidden') chat.parentElement.hidden = true
  else if (state === 'inert') chat.parentElement.setAttribute('inert', '')
  else if (state === 'visibility') chat.style.visibility = 'hidden'
  else if (state === 'untabbable') chat.tabIndex = -1
  else chat.setAttribute('aria-disabled', 'true')
  const focus = vi.spyOn(chat, 'focus')
  await close()
  expect(focus).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
})

test('workbench close leaves a hidden fallback entry unfocused', async () => {
  const { trigger, anchor, setVisible, close } = await focusWorkbenchFixture()
  await setVisible(false)
  await setVisible(true)
  anchor.hidden = true
  const focus = vi.spyOn(trigger, 'focus')
  await close()
  expect(focus).not.toHaveBeenCalled()
})

test('settings workbench Escape restores its own management entry', async () => {
  const { runtime } = await fixture({ rpc: reviewRpc(reviewCandidate('settings-focus')) })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  await runtime.flush()
  const entry = view.getByRole('button', { name: 'Manage global bindings' })
  entry.getClientRects = () => [new DOMRect(20, 100, 100, 24)]
  entry.focus()
  fireEvent.click(entry)
  await runtime.flush()
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Close global bindings workbench' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(entry)
})

test.each(['disabled', 'disposed'])('a %s workbench leaves Host focus and drops pending write authority', async ending => {
  const entry = reviewCandidate('focus-save').entry
  const validation = deferred()
  const { runtime, view, trigger, host, settings, value, feature, setVisible, rpcCalls } = await focusWorkbenchFixture({
    rpc: async endpoint => {
      if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [entry] } }
      if (endpoint === 'load') return { ok: true, value: { revision: 1, entry } }
      if (endpoint === 'validate') return validation.promise
      throw new Error(endpoint)
    },
  })
  fireEvent.click(view.getByRole('button', { name: 'Edit', exact: true }))
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Save', exact: true }))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'validate')).toHaveLength(1)
  const focus = vi.spyOn(trigger, 'focus')
  host.focus()
  if (ending === 'disabled') settings.publish({ value: { ...value, userBindingsEnabled: false } })
  else await feature.dispose()
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(host)
  expect(focus).not.toHaveBeenCalled()
  validation.resolve({ ok: true, value: entry })
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(0)
  settings.publish({ value })
  await runtime.flush()
  await setVisible(true)
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(host)
})

test('a hidden input surface suspends the workbench dialog without losing its draft', async () => {
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) { if (element.querySelector('.ptcPlusAuthorButton')) visibility = this.callback }
    unobserve() {}
    disconnect() {}
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const entry = { ...reviewCandidate('takeover').entry, name: 'takeoverTools' }
  const { runtime } = await fixture({ rpc: async endpoint => ({ ok: true,
    value: endpoint === 'load' ? { revision: 1, entry } : { revision: 1, entries: [entry] } }) })
  const view = runtime.renderRoot()
  await runtime.flush()
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  fireEvent.click(view.getByRole('menuitem', { name: 'Manage global bindings' }))
  await runtime.flush()
  const dialog = () => document.querySelector('.ptcPlusBindings')
  expect(dialog()).not.toBeNull()
  fireEvent.click([...dialog().querySelectorAll('button')].find(button => button.textContent === 'Edit'))
  await runtime.flush()
  const source = () => EditorView.findFromDOM(dialog().querySelector('.ptcPlusSourceBody .cm-content'))
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const unsaved = true' } })
  await runtime.flush()
  // The Host composer takes the input surface: the dialog hides, the draft stays.
  visibility([{ isIntersecting: false }])
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingsModal')).toBeNull()
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingsModal')).not.toBeNull()
  expect(source().state.doc.toString()).toBe('export const unsaved = true')
  // Explicit close still ends the management session.
  fireEvent.click(document.querySelector('.ptcPlusBindingsModal button[aria-label="Close global bindings workbench"]'))
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingsModal')).toBeNull()
  // Reopening starts a new baseline: the stored source, not the released draft.
  await openGlobalMenu(view, runtime)
  fireEvent.click(view.getByRole('menuitem', { name: 'Manage global bindings' }))
  await runtime.flush()
  expect(dialog()).not.toBeNull()
  fireEvent.click(dialog().querySelector('.ptcPlusSourceToggle'))
  await runtime.flush()
  expect(dialog().querySelector('.ptcPlusSourceCode').textContent).toContain('export const value = 1')
  expect(dialog().querySelector('.ptcPlusSourceBody .cm-content')).toBeNull()
})

test('closing the workbench during validation drops the pending save and reopens a fresh baseline', async () => {
  const entry = { id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text.',
    enabled: false, symbols: ['readText'], source: 'export const value = 1',
    declaration: 'declare const fileTools: { value: number }' }
  const validation = deferred()
  const { runtime, rpcCalls } = await fixture({ rpc: async endpoint => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: { revision: 1, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision: 1, entry } }
    if (endpoint === 'validate') return validation.promise
    if (endpoint === 'save') return { ok: true, value: { revision: 2, entries: [entry] } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  const manage = () => [...view.container.querySelectorAll('button')]
    .find(button => button.textContent === 'Manage global bindings')
  fireEvent.click(manage())
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const source = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  fireEvent.click(button('Edit'))
  await runtime.flush()
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 2' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'validate')).toHaveLength(1)
  // The user closes the workbench while the host is still validating the draft.
  fireEvent.click(document.querySelector('.ptcPlusBindingsModal button[aria-label="Close global bindings workbench"]'))
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingsModal')).toBeNull()
  validation.resolve({ ok: true, value: { ...entry, source: 'export const value = 2', declaration: entry.declaration } })
  await runtime.flush()
  // A validation answered after the close never becomes a write.
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(0)
  const reads = rpcCalls.filter(call => call.endpoint === 'list').length
  fireEvent.click(manage())
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'list')).toHaveLength(reads + 1)
  expect(button('Save')).toBeUndefined()
  expect(button('Validate')).toBeUndefined()
  fireEvent.click(workbench().querySelector('.ptcPlusSourceToggle'))
  await runtime.flush()
  expect(workbench().querySelector('.ptcPlusSourceCode').textContent).toContain('export const value = 1')
  expect(workbench().querySelector('.ptcPlusSourceCode').textContent).not.toContain('export const value = 2')
})

test('a workbench closed during an in-flight save ignores the late answer and reads the host state', async () => {
  const stored = { id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text.',
    enabled: false, symbols: ['readText'], source: 'export const value = 1',
    declaration: 'declare const fileTools: { value: number }' }
  const external = { ...stored, name: 'freshTools', source: 'export const value = 9' }
  let catalog = { revision: 1, entries: [stored] }
  const write = deferred()
  const { runtime, rpcCalls } = await fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: catalog }
    if (endpoint === 'load') return { ok: true, value: { revision: catalog.revision, entry: catalog.entries[0] } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: stored.declaration } }
    if (endpoint === 'save') return write.promise
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  const manage = () => [...view.container.querySelectorAll('button')]
    .find(button => button.textContent === 'Manage global bindings')
  fireEvent.click(manage())
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const source = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  fireEvent.click(button('Edit'))
  await runtime.flush()
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 2' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(1)
  // The write already reached the host when the user closes the workbench.
  fireEvent.click(document.querySelector('.ptcPlusBindingsModal button[aria-label="Close global bindings workbench"]'))
  await runtime.flush()
  catalog = { revision: 5, entries: [external] }
  fireEvent.click(manage())
  await runtime.flush()
  // The released session no longer blocks the reopened surface: it reads and
  // selects the host's current entry instead of the draft the user closed with.
  expect(workbench().textContent).toContain('freshTools')
  expect(workbench().querySelector('.ptcPlusEditorFile').textContent).toBe('freshTools')
  fireEvent.click(workbench().querySelector('.ptcPlusSourceToggle'))
  await runtime.flush()
  expect(workbench().querySelector('.ptcPlusSourceCode').textContent).toContain('export const value = 9')
  expect(workbench().querySelector('.ptcPlusSourceCode').textContent).not.toContain('export const value = 2')
  // The late answer belongs to the session the user closed.
  write.resolve({ ok: true, value: { revision: 2, entries: [{ ...stored, name: 'staleTools' }] } })
  await runtime.flush()
  expect(workbench().textContent).toContain('freshTools')
  expect(workbench().textContent).not.toContain('staleTools')
  expect(workbench().querySelector('.ptcPlusSourceCode').textContent).toContain('export const value = 9')
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(1)
})

test('a temporarily hidden workbench still settles a pending save from its draft', async () => {
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) { if (element.querySelector('.ptcPlusAuthorButton')) visibility = this.callback }
    unobserve() {}
    disconnect() {}
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const entry = { ...reviewCandidate('takeover').entry, name: 'takeoverTools', source: 'export const value = 1' }
  const validation = deferred()
  const { runtime, rpcCalls } = await fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: { revision: 1, entries: [entry] } }
    if (endpoint === 'load') return { ok: true, value: { revision: 1, entry } }
    if (endpoint === 'validate') return validation.promise
    if (endpoint === 'save') return { ok: true, value: { revision: 2, entries: [payload.entry] } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  fireEvent.click(view.getByRole('menuitem', { name: 'Manage global bindings' }))
  await runtime.flush()
  const dialog = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...dialog().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const source = () => EditorView.findFromDOM(dialog().querySelector('.ptcPlusSourceBody .cm-content'))
  fireEvent.click(button('Edit'))
  await runtime.flush()
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 2' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'validate')).toHaveLength(1)
  // The Host composer takes the input surface while the host is still validating.
  visibility([{ isIntersecting: false }])
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingsModal')).toBeNull()
  validation.resolve({ ok: true, value: { ...entry, source: 'export const value = 2',
    declaration: 'declare const takeoverTools: { value: number }' } })
  await runtime.flush()
  // Hiding is not closing: the pending save settles against the retained draft.
  const saves = rpcCalls.filter(call => call.endpoint === 'save')
  expect(saves).toHaveLength(1)
  expect(saves[0].payload).toMatchObject({ intent: 'update', originalId: 'takeover', expectedRevision: 1 })
  expect(saves[0].payload.entry.source).toBe('export const value = 2')
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingsModal')).not.toBeNull()
  expect(dialog().textContent).toContain('takeoverTools')
  expect(button('Save')).toBeUndefined()
})

test('menu and workbench catalogs read independently and a late menu read stays on the menu', async () => {
  const entryA = { ...reviewCandidate('alpha').entry, name: 'alphaTools' }
  const entryB = { ...reviewCandidate('beta').entry, name: 'betaTools' }
  const menuRead = deferred()
  let menuPhase = false
  const { runtime } = await fixture({ rpc: async endpoint => {
    if (endpoint === 'list') {
      if (menuPhase) { menuPhase = false; return menuRead.promise }
      return { ok: true, value: { revision: 1, entries: [entryA] } }
    }
    if (endpoint === 'load') return { ok: true, value: { revision: 1, entry: entryA } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  menuPhase = true
  await openGlobalMenu(view, runtime)
  expect(view.getByText('Loading bindings…')).not.toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Manage global bindings' }))
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  expect(workbench().textContent).toContain('alphaTools')
  menuRead.resolve({ ok: true, value: { revision: 1, entries: [entryB] } })
  await runtime.flush()
  // The workbench owns its own read: a menu response never replaces its catalog.
  expect(workbench().textContent).toContain('alphaTools')
  expect(workbench().textContent).not.toContain('betaTools')
})

test('a failed menu catalog read reports only inside the menu', async () => {
  const entry = { ...reviewCandidate('alpha').entry, name: 'alphaTools' }
  let menuPhase = false
  const { runtime } = await fixture({ rpc: async endpoint => {
    if (endpoint === 'list') {
      if (menuPhase) { menuPhase = false; throw new Error('menu catalog failed') }
      return { ok: true, value: { revision: 1, entries: [entry] } }
    }
    if (endpoint === 'load') return { ok: true, value: { revision: 1, entry } }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  menuPhase = true
  await openGlobalMenu(view, runtime)
  expect(view.getByText(/Global User Binding operation failed: .*menu catalog failed/)).not.toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Manage global bindings' }))
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindings').textContent).toContain('alphaTools')
})

test('an entry removed outside the workbench keeps the draft as an update, never a creation', async () => {
  const stored = { id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text.',
    enabled: false, symbols: ['readText'], source: 'export const value = 1' }
  let present = true
  let revision = 1
  const { runtime, rpcCalls } = await fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') {
      return { ok: true, value: { revision, entries: present ? [stored] : [] } }
    }
    if (endpoint === 'load') return { ok: true, value: { revision, entry: stored } }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: 'declare const value: number' } }
    if (endpoint === 'save') {
      // The store owns identity: updating a missing entry is a conflict, not a creation.
      if (payload.intent === 'update') {
        return { ok: false, error: { code: 'BINDINGS_CONFLICT', message: 'binding entry "files" does not exist' } }
      }
      // The store normalizes a saved entry, so the catalog always carries symbols.
      return { ok: true, value: { revision: ++revision, entries: [{ ...payload.entry, symbols: payload.entry.symbols ?? [] }] } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const fields = () => [...workbench().querySelectorAll('.ptcPlusEntrySettings input')]
  const source = () => EditorView.findFromDOM(workbench().querySelector('.ptcPlusSourceBody .cm-content'))
  fireEvent.click(button('Edit'))
  await runtime.flush()
  source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: 'export const value = 2' } })
  await runtime.flush()
  // The stored entry disappears while the draft is still unsaved.
  present = false
  revision = 2
  fireEvent.click(button('Reload'))
  await runtime.flush()
  expect(fields()[0].value).toBe('files')
  expect(fields()[0].disabled).toBe(true)
  expect(source().state.doc.toString()).toBe('export const value = 2')
  // The next save is still an update of that identity; the host owns the missing-entry conflict.
  fireEvent.click(button('Save'))
  await runtime.flush()
  const saves = rpcCalls.filter(call => call.endpoint === 'save')
  expect(saves).toHaveLength(1)
  expect(saves[0].payload).toMatchObject({ intent: 'update', originalId: 'files', expectedRevision: 2,
    entry: { id: 'files', source: 'export const value = 2' } })
  expect(workbench().textContent).toContain('does not exist')
  expect(fields()[0].disabled).toBe(true)
  expect(source().state.doc.toString()).toBe('export const value = 2')
  // Only an explicit new draft may create an entry.
  fireEvent.click(button('Cancel'))
  await runtime.flush()
  fireEvent.click(button('New entry'))
  await runtime.flush()
  expect(fields()[0].disabled).toBe(false)
  fireEvent.change(fields()[0], { target: { value: 'fresh' } })
  fireEvent.change(fields()[1], { target: { value: 'freshTools' } })
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(2)
  expect(rpcCalls.filter(call => call.endpoint === 'save')[1].payload)
    .toMatchObject({ intent: 'create', originalId: null, entry: { id: 'fresh' } })
  expect(workbench().textContent).toContain('Entry saved')
})

test('a confirmed toggle updates the selected draft from the response catalog and keeps unsaved fields', async () => {
  let stored = { id: 'files', name: 'fileTools', scope: 'namespace', purpose: 'Read text.',
    enabled: false, symbols: ['readText'], source: 'export const value = 1' }
  let revision = 1
  const { runtime, rpcCalls } = await fixture({ rpc: async (endpoint, payload) => {
    if (endpoint === 'list' || endpoint === 'reload') return { ok: true, value: { revision, entries: [stored] } }
    if (endpoint === 'load') return { ok: true, value: { revision, entry: stored } }
    if (endpoint === 'enable' || endpoint === 'disable') {
      stored = { ...stored, enabled: endpoint === 'enable' }
      return { ok: true, value: { revision: ++revision, entries: [stored] } }
    }
    if (endpoint === 'validate') return { ok: true, value: { ...payload.entry, declaration: 'declare const value: number' } }
    if (endpoint === 'save') {
      stored = { ...stored, ...payload.entry }
      return { ok: true, value: { revision: ++revision, entries: [stored] } }
    }
    throw new Error(endpoint)
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await runtime.sessions.setCurrent(undefined)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  fireEvent.click([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Manage global bindings'))
  await runtime.flush()
  const workbench = () => document.querySelector('.ptcPlusBindings')
  const button = name => [...workbench().querySelectorAll('button')]
    .find(button => button.textContent === name || button.getAttribute('aria-label') === name)
  const toggle = () => workbench().querySelector('.ptcPlusBindingSwitch')
  fireEvent.click(toggle())
  await runtime.flush()
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle())
  await runtime.flush()
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  // The draft tracks the confirmed stored state, so a later save cannot revert the toggle.
  fireEvent.click(button('Edit'))
  await runtime.flush()
  fireEvent.click(button('Save'))
  await runtime.flush()
  expect(rpcCalls.filter(call => call.endpoint === 'save')).toHaveLength(1)
  expect(rpcCalls.find(call => call.endpoint === 'save').payload.entry).toMatchObject({
    id: 'files', name: 'fileTools', purpose: 'Read text.', enabled: false, source: 'export const value = 1',
  })
})

test('catalog sources stay inside owner disposal across release, revival and late responses', async () => {
  const reads = []
  const owner = createCatalogOwner({ callUserBindings: (endpoint, payload, signal) => {
    const next = deferred()
    reads.push({ next, signal })
    return next.promise
  } })
  const source = owner.claim()
  const statuses = []
  const unsubscribe = source.subscribe(() => statuses.push(source.getSnapshot().status))
  const released = source.read()
  source.release()
  reads[0].next.resolve({ revision: 1, entries: [] })
  expect(await released).toBeUndefined()
  expect(statuses).toEqual(['loading'])
  // A released source refuses further work and keeps its last published state.
  expect(await source.read()).toBeUndefined()
  expect(reads).toHaveLength(1)
  // A replayed subscription (StrictMode cleanup then effect) makes it live again.
  unsubscribe()
  source.subscribe(() => statuses.push(source.getSnapshot().status))
  const revived = source.read()
  expect(reads).toHaveLength(2)
  // Owner disposal still reaches that revived source and drops its late response.
  owner.dispose()
  expect(reads[1].signal.aborted).toBe(true)
  reads[1].next.resolve({ revision: 2, entries: [] })
  expect(await revived).toBeUndefined()
  expect(statuses).toEqual(['loading', 'loading'])
  // A source that was never released is inside disposal from the start.
  const claimed = owner.claim()
  const pending = claimed.read()
  owner.dispose()
  expect(reads[2].signal.aborted).toBe(true)
  reads[2].next.resolve({ revision: 3, entries: [] })
  expect(await pending).toBeUndefined()
})

test('disposing the client plugin disposes its catalog owner and drops in-flight reads', async () => {
  catalogOwners.length = 0
  const aborted = []
  const { runtime, feature } = await fixture({ rpc: (endpoint, payload, signal) => {
    if (endpoint !== 'list') throw new Error(endpoint)
    return new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted.push(endpoint); resolve({ ok: true, value: null }) }, { once: true })
    })
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  expect(catalogOwners).toHaveLength(1)
  const dispose = vi.spyOn(catalogOwners[0], 'dispose')
  expect(aborted).toHaveLength(0)
  await feature.dispose()
  await runtime.flush()
  // The plugin scope, not only the consumer unmount, owns the sources it created.
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(aborted.length).toBeGreaterThan(0)
})

test('missing optional primitives fall back to native controls and text labels', async () => {
  const reducedUi = {
    Menu: primitives.Menu, Modal: primitives.Modal,
    IconCheckOutline14: primitives.IconCheckOutline14,
    IconChevronDownOutline14: primitives.IconChevronDownOutline14,
    IconCloseOutline16: primitives.IconCloseOutline16,
    IconInspectOutline12: primitives.IconInspectOutline12,
  }
  const entry = { ...reviewCandidate('reduced').entry, name: 'reducedTools' }
  const inspect = vi.fn()
  const block = { kind: 'tool-result', callId: 'call-1',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'return 41 + 1', description: 'Compute the answer' }) },
    content: [{ type: 'text', text: '42' }], isError: false, subCalls: [], meta: undefined }
  const { runtime, input } = await fixture({ ui: reducedUi, tool: { toolName: 'run_code', block, inspect },
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async endpoint => ({ ok: true,
      value: endpoint === 'load' ? { revision: 1, entry } : { revision: 1, entries: [entry] } }) })
  const view = runtime.renderRoot()
  await runtime.flush()
  // ActionButton loses the primitive but keeps a native button with its copy.
  const manage = view.container.querySelector('.ptcPlusSettingAction button')
  expect(manage.tagName).toBe('BUTTON')
  expect(manage.textContent).toBe('Manage global bindings')
  // The tool row keeps a keyboard-operable summary instead of DisclosureRow.
  const row = view.container.querySelector('.ptcPlusTool')
  const summary = row.querySelector('.ptcPlusToolSummary')
  expect(summary.getAttribute('role')).toBe('button')
  expect(summary.getAttribute('aria-expanded')).toBe('false')
  fireEvent.keyDown(summary, { key: ' ' })
  await runtime.flush()
  expect(summary.getAttribute('aria-expanded')).toBe('true')
  expect(row.querySelector('.ptcPlusToolCode').textContent).toContain('return 41 + 1')
  expect(row.querySelector('.ptcPlusIoText').textContent).toBe('42')
  fireEvent.click(row.querySelector('.ptcPlusInspect'))
  expect(inspect).toHaveBeenCalledTimes(1)
  // The authoring trigger keeps a text label, a native hint and the busy notice.
  const anchor = view.container.querySelector('.ptcPlusComposerBindingAnchor')
  expect(anchor.getAttribute('data-text')).toBe('true')
  expect(anchor.querySelector('.ptcPlusAuthorButtonLabel').textContent).toBe('Global bindings')
  expect(anchor.querySelector('.ptcPlusAuthorButton').getAttribute('title'))
    .toBe('PTC Plus plugin · Open the Global User Binding menu to author, toggle, or manage')
  input.publish({ draft: 'keep my text' })
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  await runtime.flush()
  const notice = view.container.querySelector('.ptcPlusComposerNotice')
  expect(notice.getAttribute('role')).toBe('status')
  expect(notice.textContent).toBe('The composer already has text, so its draft was not replaced.')
  expect(input.scope.getSnapshot().draft).toBe('keep my text')
})

test('the REPL tab reports per-binding and total reuse counts', async () => {
  const { runtime } = await fixture({ repl: true, bindings: false })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', {
    available: true, total: 2, omitted: 0, reuseTotal: 5, entries: [
      { name: 'answer', kind: 'variable', definition: { source: 'const answer = 42', line: 1, column: 1 }, reuseCount: 4 },
      { name: 'helper', kind: 'function', definition: { source: 'function helper() {}', line: 2, column: 1 }, reuseCount: 1 },
    ],
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  const rows = [...view.container.querySelectorAll('.ptcPlusObservationTable tbody tr')]
  expect(rows.map(row => row.querySelector('.ptcPlusObservationReuse').textContent)).toEqual(['4', '1'])
  expect(view.container.querySelector('.ptcPlusObservationReuseTotal').textContent).toBe('reused 5\u00d7 total')
})

test('memory card expands session definitions and the composer menu revises a global source', async () => {
  const entry = { id: 'alpha', name: 'alphaTools', scope: 'namespace', symbols: ['read'],
    purpose: 'Read files.', enabled: true }
  const { runtime, input } = await fixture({
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async (endpoint, payload) => {
      if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [entry] } }
      if (endpoint === 'load') {
        expect(payload).toEqual({ id: 'alpha' })
        return { ok: true, value: { revision: 1, entry: { ...entry, source: 'export const read = 1' } } }
      }
      throw new Error(endpoint)
    },
  })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', {
    available: true, total: 4, omitted: 2, reuseTotal: 3, entries: [
      { name: 'answer', kind: 'variable', definition: { source: 'const answer = 42', line: 1, column: 1 }, reuseCount: 2 },
      { name: 'helper', kind: 'function', definition: { source: 'function helper() {}', line: 4, column: 1 }, reuseCount: 1 },
    ],
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.container.querySelector('.ptcPlusActive'))
  await runtime.flush()
  const rows = () => view.container.querySelectorAll('.ptcPlusReplBinding')
  expect(rows()).toHaveLength(2)
  expect([...view.container.querySelectorAll('.ptcPlusReplReuse')].map(node => node.textContent))
    .toEqual(['reused 2\u00d7', 'reused 1\u00d7'])
  expect(view.container.querySelector('.ptcPlusReplSummary').textContent)
    .toBe('4 reusable bindings · reused 3\u00d7 total')
  expect(rows()[0].getAttribute('data-expanded')).toBe('false')
  fireEvent.click(rows()[0].querySelector('.ptcPlusReplBindingTrigger'))
  await runtime.flush()
  expect(rows()[0].getAttribute('data-expanded')).toBe('true')
  expect(rows()[0].querySelector('.ptcPlusReplDefinition').textContent).toContain('const answer = 42')
  expect(rows()[0].querySelector('.ptcPlusReplLocation').textContent).toBe('Line 1, column 1')
  expect(view.container.querySelector('.ptcPlusReplMore').textContent).toBe('2 more bindings not shown')
  // The global tab stays a read-only inspection surface: it loads one entry's source
  // on demand but never writes to the composer.
  fireEvent.click(view.container.querySelectorAll('.ptcPlusReplTab')[1])
  await runtime.flush()
  const item = view.container.querySelector('.ptcPlusGlobalItem')
  expect(item.querySelector('.ptcPlusBindingState').textContent).toBe('Enabled')
  fireEvent.click(item.querySelector('.ptcPlusBindingSelect'))
  await runtime.flush()
  expect(item.querySelector('.ptcPlusGlobalSource').textContent).toBe('export const read = 1')
  expect([...item.querySelectorAll('button')].some(button => button.textContent === 'Revise a binding')).toBe(false)
  // The composer star menu owns the revision action and prefills the same command.
  await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Revise a binding' }))
  await runtime.flush()
  fireEvent.click(view.getByRole('menuitem', { name: /alphaTools/ }))
  await runtime.flush()
  expect(input.scope.getSnapshot().draft).toBe('/binding edit alpha ')
})

/** Header card fixture: the trigger, its card and the projection the card reads. */
async function indicatorFixture() {
  const entry = { id: 'alpha', name: 'alphaTools', scope: 'namespace', symbols: ['read'],
    purpose: 'Read files.', enabled: true }
  const { runtime } = await fixture({ rpc: async endpoint => {
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [entry] } }
    throw new Error(endpoint)
  } })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', {
    available: true, total: 1, omitted: 0,
    entries: [{ name: 'answer', kind: 'variable', definition: { source: 'const answer = 42', line: 1, column: 1 } }],
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  const trigger = view.container.querySelector('.ptcPlusActive')
  const card = view.container.querySelector('.ptcPlusReplPopover')
  // JSDOM has no layout; the focus restore that owns the trigger checks visibility.
  trigger.getClientRects = () => [new DOMRect(20, 20, 60, 24)]
  return { runtime, view, trigger, card, expanded: () => trigger.getAttribute('aria-expanded') }
}

test('the header card opens on hover intent and leaves with the pointer', async () => {
  const { runtime, trigger, card, expanded } = await indicatorFixture()
  expect(expanded()).toBe('false')
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  await runtime.flush()
  // Crossing the indicator leaves nothing behind; dwelling on it opens the card.
  expect(expanded()).toBe('false')
  await vi.waitFor(() => { expect(expanded()).toBe('true') })
  expect(card.dataset.open).toBe('true')
  // The pointer crosses the trigger-card gap, so the leave only arms a close.
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  fireEvent.pointerEnter(card, { pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 300))
  await runtime.flush()
  expect(expanded()).toBe('true')
  fireEvent.pointerLeave(card, { pointerType: 'mouse' })
  await vi.waitFor(() => { expect(expanded()).toBe('false') })
})

test('the header card survives the pointer returning from the card to its trigger', async () => {
  const { runtime, trigger, card, expanded } = await indicatorFixture()
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  await vi.waitFor(() => { expect(expanded()).toBe('true') })
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  fireEvent.pointerEnter(card, { pointerType: 'mouse' })
  fireEvent.pointerLeave(card, { pointerType: 'mouse' })
  // Coming back cancels the close the card's leave armed, even though the card is
  // already open and its own dwell has nothing left to schedule.
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 300))
  await runtime.flush()
  expect(expanded()).toBe('true')
})

test('a keyboard-opened card stays while the pointer crosses its trigger', async () => {
  const { runtime, trigger, expanded } = await indicatorFixture()
  fireEvent.keyDown(document, { key: 'Tab' })
  // A real focus, so the trigger owns document.activeElement as it does for a reader.
  trigger.focus()
  await runtime.flush()
  expect(expanded()).toBe('true')
  // A pointer that only crosses the trigger never opened the card, so it must not
  // take the card away from the reader who did.
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 300))
  await runtime.flush()
  expect(expanded()).toBe('true')
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(expanded()).toBe('false')
})

test('a keyboard-opened card leaves with the pointer once a hover reopens it', async () => {
  const { runtime, trigger, expanded } = await indicatorFixture()
  fireEvent.keyDown(document, { key: 'Tab' })
  fireEvent.focus(trigger)
  await runtime.flush()
  expect(expanded()).toBe('true')
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(expanded()).toBe('false')
  // The reintroduced pointer is the driving input, so a later leave closes the card
  // instead of inheriting the keyboard exemption.
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  await vi.waitFor(() => { expect(expanded()).toBe('true') })
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  await vi.waitFor(() => { expect(expanded()).toBe('false') })
})

test('the header card pins on click, closes on an outside press and answers Escape', async () => {
  const { runtime, view, trigger, expanded } = await indicatorFixture()
  fireEvent.click(trigger)
  await runtime.flush()
  expect(expanded()).toBe('true')
  // The click owns the card: a pointer leaving it does not take it away.
  fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 300))
  await runtime.flush()
  expect(expanded()).toBe('true')
  // A second click releases it, and the escaping focus stays on the trigger.
  fireEvent.click(trigger)
  await runtime.flush()
  expect(expanded()).toBe('false')
  fireEvent.click(trigger)
  await runtime.flush()
  // A press inside the card is the reader using it, not dismissing it.
  fireEvent.pointerDown(view.container.querySelector('.ptcPlusReplTab'))
  await runtime.flush()
  expect(expanded()).toBe('true')
  fireEvent.pointerDown(document.body)
  await runtime.flush()
  expect(expanded()).toBe('false')
  fireEvent.click(trigger)
  await runtime.flush()
  view.container.querySelector('.ptcPlusReplTab').focus()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(expanded()).toBe('false')
  expect(document.activeElement).toBe(trigger)
})

test('only a keyboard reader opens the header card by focusing its trigger', async () => {
  const { runtime, trigger, expanded } = await indicatorFixture()
  fireEvent.focus(trigger)
  await runtime.flush()
  expect(expanded()).toBe('false')
  fireEvent.keyDown(document, { key: 'Tab' })
  fireEvent.focus(trigger)
  await runtime.flush()
  expect(expanded()).toBe('true')
})

test('the open header card stops polling and rereads its catalog on the global tab', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const entry = { id: 'alpha', name: 'alphaTools', scope: 'namespace', symbols: ['read'],
    purpose: 'Read files.', enabled: true }
  const list = vi.fn(async () => ({ ok: true, value: { revision: 1, entries: [entry] } }))
  const { runtime } = await fixture({ rpc: async endpoint => {
    if (endpoint === 'list') return list()
    throw new Error(endpoint)
  } })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', { available: false, entries: [], total: 0, omitted: 0 })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.container.querySelector('.ptcPlusActive'))
  await runtime.flush()
  const opened = list.mock.calls.length
  await vi.advanceTimersByTimeAsync(5_000)
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(opened)
  fireEvent.click(view.container.querySelectorAll('.ptcPlusReplTab')[1])
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(opened + 1)
})

test('one settings mapping and one gated registration own every conditional contribution', () => {
  const settings = { status: 'ready', writable: true, value: { enabled: true } }
  expect(featureEnabled(settings, 'plugin')).toBe(true)
  expect(featureEnabled(settings, 'bindings')).toBe(false)
  expect(featureEnabled({ ...settings, value: { ...settings.value, userBindingsEnabled: true } }, 'bindings')).toBe(true)
  // Default-on settings stay on unless explicitly turned off.
  expect(featureEnabled(settings, 'toolView')).toBe(true)
  expect(featureEnabled({ ...settings, value: { ...settings.value, enhancedToolView: false } }, 'toolView')).toBe(false)
  expect(featureEnabled({ status: 'loading', value: { enabled: true } }, 'plugin')).toBe(false)
  expect(featureEnabled({ ...settings, writable: false }, 'plugin')).toBe(true)
  expect(featureEnabled({ status: 'ready', value: { enabled: false } }, 'plugin')).toBe(false)
  expect(() => featureEnabled(settings, 'unknown')).toThrow('Unknown client feature')

  const listeners = new Set()
  const registered = []
  const scope = { effect: callback => { const dispose = callback(); return () => dispose?.() } }
  const gate = {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    isEnabled: () => enabled,
    register: () => { registered.push('entry'); return () => { registered.pop() } },
  }
  let enabled = false
  const release = registerGated(scope, gate)
  expect(registered).toHaveLength(0)
  expect(listeners.size).toBe(1)
  enabled = true
  for (const listener of [...listeners]) listener()
  expect(registered).toHaveLength(1)
  // Eligibility notifications repeat; registration must not.
  for (const listener of [...listeners]) listener()
  expect(registered).toHaveLength(1)
  enabled = false
  for (const listener of [...listeners]) listener()
  expect(registered).toHaveLength(0)
  enabled = true
  for (const listener of [...listeners]) listener()
  expect(registered).toHaveLength(1)
  release()
  expect(registered).toHaveLength(0)
  expect(listeners.size).toBe(0)
})

test('a refused registration leaves nothing registered and keeps its subscription', () => {
  const listeners = new Set()
  const registered = []
  const scope = { effect: callback => { const dispose = callback(); return () => dispose?.() } }
  let refuse = false
  let enabled = false
  const gate = {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    isEnabled: () => enabled,
    register: () => {
      if (refuse) throw new Error('slot refused')
      registered.push('entry')
      return () => { registered.pop() }
    },
  }
  // A refused registration propagates and registers nothing.
  refuse = true
  enabled = true
  expect(() => registerGated(scope, gate)).toThrow('slot refused')
  expect(registered).toHaveLength(0)
  refuse = false
  const release = registerGated(scope, gate)
  expect(registered).toHaveLength(1)
  // A later refusal must not leave a half-registered contribution behind.
  enabled = false
  for (const listener of [...listeners]) listener()
  expect(registered).toHaveLength(0)
  refuse = true
  enabled = true
  expect(() => { for (const listener of [...listeners]) listener() }).toThrow('slot refused')
  expect(registered).toHaveLength(0)
  release()
  expect(listeners.size).toBe(0)
})

test('tool rows project the recorded call and expose expansion and inspection', async () => {
  const inspect = vi.fn()
  const block = { kind: 'tool-result', callId: 'call-1',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'return 41 + 1', description: 'Compute the answer' }) },
    content: [{ type: 'text', text: '42' }], isError: false, subCalls: [], meta: undefined }
  const { runtime } = await fixture({ tool: { toolName: 'run_code', block, inspect } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const row = view.container.querySelector('.ptcPlusTool')
  const header = row.querySelector('[data-disclosure-row]')
  expect(header.textContent).toContain('Code')
  expect(row.querySelector('.ptcPlusToolDescription').textContent).toBe('Compute the answer')
  expect(row.querySelector('.ptcPlusToolState')).toBeNull()
  expect(row.querySelector('.ptcPlusToolBody')).toBeNull()
  expect(header.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(header)
  await runtime.flush()
  expect(header.getAttribute('aria-expanded')).toBe('true')
  expect(row.querySelector('.ptcPlusToolCode').textContent).toContain('return 41 + 1')
  expect(row.querySelector('.ptcPlusIoText').textContent).toBe('42')
  fireEvent.click(row.querySelector('.ptcPlusInspect'))
  expect(inspect).toHaveBeenCalledTimes(1)
})
