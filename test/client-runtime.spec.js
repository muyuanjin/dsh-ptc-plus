import { CAPABILITY_POLICY_DEFAULT } from '../internal/capability-policy.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, within } from '@testing-library/react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { Context } from '@deepseek-ai/cordis'
import * as gatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { CONFIG_FIELDS, CONFIG_GROUPS, CONFIG_MODULES } from '../internal/config-spec.js'
import { createClientRpc } from '../src/client-rpc.js'
import { RPC_CONTRACTS } from '../internal/rpc-contract.js'
import { createBindingReviews } from '../src/client-binding-review.js'
import { LOCALE_NS, SETTINGS_COPY } from '../src/client-copy.js'
import { featureEnabled, registerGated } from '../src/client-feature-gates.js'
import { createCatalogOwner } from '../src/client-catalog.js'
import { createUserBindingsWorkbench } from '../src/client-workbench.js'
import { createPtcSettingsView } from '../src/client-settings-view.js'
import { capabilityCommandReceipt } from '../internal/capability-command-receipt.js'
import { bindingToggleMessage } from '../internal/binding-toggle-receipt.js'
import { bindingToggleConversationDefinition } from '../src/client-binding-toggle.js'
import { isHostComponent } from '../src/client-host-compat.js'
import { createFallbackModal, createSelect } from '../src/client-primitives.js'
import { createSessionCapabilityControlsView } from '../src/client-capabilities-view.js'

function wrappedPrimitives() {
  return Object.fromEntries(Object.entries(primitives).map(([name, component]) => [name,
    isHostComponent(component) ? React.memo(component) : component]))
}

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
function stubSettingsScope() {
  let snapshot = {
    status: 'loading', value: undefined, base: undefined, user: undefined,
    revision: undefined, writable: false, mode: 'host',
  }
  const listeners = new Set()
  const set = vi.fn(() => Promise.resolve())
  const mutate = vi.fn(() => Promise.resolve())
  const unset = vi.fn(() => Promise.resolve())
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      mutate,
      set,
      unset,
    },
    set,
    mutate,
    unset,
    listenerCount: () => listeners.size,
    publish(next) {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

function installSessionSelectionCompat(runtime) {
  if (typeof runtime.sessions.setCurrent === 'function') return
  const originalBehavior = runtime.sessions.behavior.bind(runtime.sessions)
  const persisted = new Map()
  const wrapped = new WeakSet()
  const setters = new WeakMap()
  runtime.sessions.behavior = id => {
    const session = originalBehavior(id)
    if (!wrapped.has(session)) {
      const set = session.projections.set.bind(session.projections)
      setters.set(session, set)
      session.projections.set = (key, value) => {
        const values = persisted.get(id) ?? new Map()
        values.set(key, value)
        persisted.set(id, values)
        const result = set(key, value)
        const current = originalBehavior(id)
        if (current !== session) {
          const publish = setters.get(current) ?? current.projections.set.bind(current.projections)
          publish(key, value)
        }
        return result
      }
      wrapped.add(session)
    }
    return session
  }
  let selected
  runtime.sessions.setCurrent = async id => {
    for (const [key, value] of persisted.get(id) ?? []) {
      await runtime.sessions.setProjection(id, key, value)
    }
    const next = id === undefined ? undefined : runtime.sessions.retain(id, { source: 'mainView' })
    if (next !== undefined) await next.ready
    if (id !== undefined) runtime.sessions.behavior(id)
    selected?.release()
    selected = next
    await runtime.flush()
  }
}

// The bundle-row settings contract declares this keyed slot and dispatches
// `<package name>#<row id>`, with the row id cordis.patch.yml inserts for this
// package.
const ROW_CONFIG_SLOT = 'plugins.row.config'
const ROW_CONFIG_KEY = 'dsh-ptc-plus#ptc-plus'
// The Plugins page asks one entry for both of its views; the wrappers keep the
// two renders addressable without standing in for page chrome.
function rowConfigViews(props) {
  return React.createElement(React.Fragment, null,
    React.createElement('div', { 'data-view': 'summary' },
      props.renderSlot(ROW_CONFIG_SLOT, { view: 'summary' }, { entryKey: ROW_CONFIG_KEY })),
    React.createElement('div', { 'data-view': 'page' },
      props.renderSlot(ROW_CONFIG_SLOT, { view: 'page' }, { entryKey: ROW_CONFIG_KEY })))
}
// JSDOM has no text layout. Editor geometry is exercised in the real browser.
beforeAll(() => {
  Range.prototype.getClientRects = () => []
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe(target) {
      this.callback([{ target, borderBoxSize: [{ inlineSize: 160, blockSize: 24 }] }])
    }
    unobserve() {}
    disconnect() {}
  }
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

let clientDefinition
async function clientPlugin(ui = primitives) {
  if (clientDefinition === undefined) {
    globalThis.__PTC_PLUS_CLIENT_MODULE_ID__ = 'dsh-ptc-plus'
    const { createClientPlugin } = await import('../src/client.js')
    clientDefinition = { factory: createClientPlugin }
  }
  return clientDefinition.factory(name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (ui === null) throw new Error('Host primitive package is unavailable')
      return ui
    }
    throw new Error(`Unexpected Client module ${name}`)
  })
}

async function fixture({ enabled = true, bindings, conversation = true, repl = false, composer = false, dock = true, uiSession = true, settingsCardSeat = 'legacy', settingsTransport = 'configForms', rpc, capabilityRpc, watchRpc, observeRpc, commands, turn, tool, ui, setupEvents, commandNode, chatNode } = {}) {
  const runtime = await SlotTestRuntime.create()
  cleanups.push(() => runtime.dispose())
  installSessionSelectionCompat(runtime)
  const settings = stubSettingsScope()
  const value = { ...Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field.default])), enabled,
    ...(bindings === undefined ? {} : { userBindingsEnabled: bindings }) }
  settings.publish({ status: 'ready', writable: true, value })
  if (settingsTransport === 'configForms') {
    runtime.ctx.provide('configForms', { get: () => settings.scope })
  } else if (settingsTransport === 'settingsScope') {
    runtime.ctx.provide('settingsScope', { bind: () => settings.scope })
  }
  const rpcCalls = []
  const capabilityRpcCalls = []
  runtime.ctx.provide('connection', {
    start: () => ({ stop() {} }),
    registerGenerationSource: () => () => {},
    rpc: { open: async function* () {}, call: async (channel, method, wire, signal) => {
    expect(channel).toBe('/api')
    const { operation: endpoint, payload } = wire.args
    const value = await (async () => {
    if (method === 'ptcPlusCapabilities/invoke') {
      capabilityRpcCalls.push({ endpoint, payload, signal })
      return capabilityRpc ? capabilityRpc(endpoint, payload, signal) : { ok: true, value: [] }
    }
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
  if (runtime.ctx.get('remote') === undefined) {
    await runtime.mount(gatewayClient)
  } else {
    const invoke = service => (operation, payload, signal) => runtime.ctx.connection.rpc.call(
      '/api', `${service}/invoke`, { args: { operation, payload } }, signal,
    )
    runtime.remote.provideNamespaces(Object.fromEntries(Object.values(RPC_CONTRACTS)
      .map(({ service }) => [service, { invoke: invoke(service) }])))
    runtime.remote.$mount = async () => {}
  }
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
  let remote
  if (commands) {
    if (typeof runtime.remote?.provideNamespaces === 'function') {
      runtime.remote.provideNamespaces({ commands })
      remote = runtime.remote
    } else {
      remote = new TestRemote(new Context(), { commands })
    }
  }
  if (remote) {
    if (runtime.ctx.get('remote.commands') === undefined) runtime.ctx.provide('remote.commands', commands)
    if (runtime.ctx.get('remote') !== remote) Object.assign(runtime.ctx.remote, { $on: remote.$on.bind(remote) })
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
  if (typeof runtime.sessions.setProjection === 'function') {
    await runtime.sessions.setProjection('client-session', 'agentPreset', 'ptc')
  } else runtime.sessions.behavior('client-session').projections.set('agentPreset', 'ptc')
  await runtime.sessions.setCurrent('client-session')
  await runtime.root.declare({
    ...(settingsCardSeat === 'legacy' ? { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } } : {}),
    ...(settingsCardSeat === 'row' ? { [ROW_CONFIG_SLOT]: { kind: 'keyed', scope: 'root' } } : {}),
    'settings.general.item': { kind: 'list', scope: 'root' },
    ...(settingsCardSeat === 'page' ? { 'test.pluginPage': { kind: 'list', scope: 'root' } } : {}),
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
    'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
    ...(dock ? { 'conversation.input.dock': { kind: 'list', scope: 'session' } } : {}),
    'conversation.view': { kind: 'list', scope: 'session' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  }, props => React.createElement(React.Fragment, null,
    settingsCardSeat === 'legacy'
      ? props.renderSlot('settings.plugin.item', {}, { entryKey: 'ptc-plus' })
      : null,
    settingsCardSeat === 'row' ? rowConfigViews(props) : null,
    React.createElement('section', { 'data-general-settings': true }, props.renderSlot('settings.general.item', {})),
    settingsCardSeat === 'page' ? props.renderSlot('test.pluginPage', {}) : null,
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
      commandNode ? props.renderSlot('conversation.chat.commandview', { node: commandNode }, { entryKey: 'capabilities' }) : null,
      chatNode ? props.renderSlot('conversation.chat.node', { node: chatNode }, { entryKey: chatNode.kind }) : null,
      turn ? props.renderSlotChain('conversation.chat.turnTail', { turn }) : null,
      tool ? props.renderSlot('tool.call.toolview', tool, { entryKey: tool.toolName }) : null)))
  const plugin = await clientPlugin(ui)
  const feature = await runtime.mount(uiSession ? plugin : {
    inject: plugin.inject,
    apply(ctx) { return plugin.apply(ctx.isolate('uiSession')) },
  })
  return { runtime, settings, value, events, feature, provideConversation, conversationProvider, remote, input, rpcCalls, capabilityRpcCalls,
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
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
  await conversationProvider.dispose()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
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
  const observedRegions = []
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) {
      if (element.querySelector('.ptcPlusSessionBindings')) {
        this.bindings = true
        visibility = this.callback
        observedRegions.push('bindings')
      } else {
        observedRegions.push(element.querySelector('.ptcPlusAuthorButton') ? 'authoring' : 'unknown')
      }
    }
    disconnect() { if (this.bindings) disconnected = true }
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const { runtime, rpcCalls, settings, value } = await fixture({ repl: true, bindings: false })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(new Set(observedRegions)).toEqual(new Set(['bindings', 'authoring']))
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
  expect(observedRegions).not.toContain('unknown')
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

test('a public source change withdraws previously observed inventory from the console and memory card', async () => {
  const watches = []
  let hidden = false
  const unknown = { available: false, total: 0, omitted: 0, reuseTotal: 0, entries: [] }
  const { runtime } = await fixture({ repl: true, bindings: false,
    watchRpc: (_payload, signal) => {
      const request = Promise.withResolvers()
      watches.push({ ...request, signal })
      return request.promise
    },
    observeRpc: () => ({ ok: true, value: hidden ? unknown : null }),
  })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', {
    available: true, total: 1, omitted: 0, entries: [{ name: 'retained', kind: 'variable',
      definition: { source: 'const retained = 41', line: 1, column: 1 } }],
    observation: { at: 1788650000000, entries: [{ name: 'retained', status: 'readable', text: '41', truncated: false }] },
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusSessionBindings').textContent).toContain('retained')
  fireEvent.click(view.container.querySelector('.ptcPlusActive'))
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusReplPopover').textContent).toContain('retained')
  hidden = true
  for (const request of [...watches]) if (!request.signal.aborted) request.resolve({ ok: true, value: { changed: true } })
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusSessionBindings').textContent).not.toContain('retained')
  expect(view.container.querySelector('.ptcPlusReplPopover').textContent).not.toContain('retained')
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

test('the Plugins page claims the row-configuration seat only while it is mounted', async () => {
  const { runtime } = await fixture({ settingsCardSeat: 'page' })
  const view = runtime.renderRoot()
  await runtime.flush()
  // General is already mounted; the plugin configuration waits for its page.
  expect(runtime.slots.entries('settings.plugin.item')).toHaveLength(0)
  expect(runtime.slots.entries('settings.general.item')).toHaveLength(0)
  expect(runtime.slots.entries(ROW_CONFIG_SLOT)).toHaveLength(0)
  expect(view.container.querySelector('.ptcPlusFields')).toBeNull()
  const page = await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.inject('test.pluginPage', () => ctx.slots.register({
      name: 'test.pluginPage', id: 'plugin-manager-page',
      children: { [ROW_CONFIG_SLOT]: { kind: 'keyed', scope: 'root' } },
    }, props => rowConfigViews(props)))
  } })
  await runtime.flush()
  expect(runtime.slots.entries(ROW_CONFIG_SLOT).map(entry => entry.options.key)).toEqual([ROW_CONFIG_KEY])
  expect(view.container.querySelector('[data-view=summary] .ptcPlusDescription').textContent)
    .toBe('The session-bound TypeScript REPL for PTC mode.')
  const form = view.container.querySelector('[data-view=page]')
  expect([...form.querySelectorAll('.ptcPlusSettingsModuleTitle')].map(title => title.textContent))
    .toEqual(['Core workspace', 'Extensions and tolerance', 'Interface and resources', 'Experimental'])
  expect(form.querySelectorAll('[aria-label="Enable PTC Plus"]')).toHaveLength(1)
  expect(form.querySelector('[aria-label="Enable PTC Plus"]').closest('.ptcPlusSettingsNav')).not.toBeNull()
  expect(form.querySelector('.ptcPlusFields')).not.toBeNull()
  expect(form.querySelector('.ptcPlusSettingsPage')).not.toBeNull()
  expect(form.querySelector('.ptcPlusBody').hasAttribute('hidden')).toBe(false)
  // The page draws the title, the icon and the crumb; the entry draws only the form.
  expect(form.querySelector('.ptcPlusHeader')).toBeNull()
  expect(form.querySelectorAll('.ptcPlusCard')).toHaveLength(1)
  await page.dispose()
  await runtime.flush()
  expect(runtime.slots.entries(ROW_CONFIG_SLOT)).toHaveLength(0)
  expect(view.container.querySelector('.ptcPlusFields')).toBeNull()
})

test('the plugin row seat renders both views when the page declares it first', async () => {
  const { runtime, settings, value } = await fixture({ settingsCardSeat: 'row' })
  expect(runtime.slots.entries('settings.plugin.item')).toHaveLength(0)
  expect(runtime.slots.entries('settings.general.item')).toHaveLength(0)
  expect(runtime.slots.entries(ROW_CONFIG_SLOT).map(entry => entry.options.key)).toEqual([ROW_CONFIG_KEY])
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('[data-general-settings]').textContent).toBe('')
  const summary = view.container.querySelector('[data-view=summary]')
  expect(summary.querySelector('.ptcPlusFields')).toBeNull()
  expect(summary.textContent).toBe('The session-bound TypeScript REPL for PTC mode.')
  const form = view.container.querySelector('[data-view=page]')
  expect([...form.querySelectorAll('.ptcPlusGroupTitle')].map(title => title.textContent))
    .toEqual([ 'REPL syntax', 'State and recovery', 'Tool extensions', 'Tool call tolerance', 'Interface display', 'Resource limits', 'Capabilities and context'])
  expect(form.querySelector('.ptcPlusFooter [role=status]').textContent).toBe('Settings are saved; capability plans adopt changes in new sessions or after an explicit refresh.')
  for (const key of CONFIG_GROUPS.flatMap(group => group.fields).filter(key => !['capabilityBaseline', 'capabilityOverrides', 'capabilityPolicy', 'capabilityStatistics', 'capabilityProfiles', 'capabilityManagementEnabled', 'capabilityRecoveryEnabled', 'modelPreviewEnabled'].includes(key))) {
    expect(form.querySelector(`[aria-label="${SETTINGS_COPY.en[`${key}.label`]}"]`)).not.toBeNull()
  }
  fireEvent.click(within(form).getByRole('button', { name: 'Batch settings' }))
  expect(within(form).getByRole('region', { name: SETTINGS_COPY.en['capabilities.policy.rules'] })).not.toBeNull()
  for (const dimension of ['availability', 'disclosure']) {
    expect(within(form).getByLabelText(`${SETTINGS_COPY.en['capabilities.policy.default']} · ${SETTINGS_COPY.en[`capabilities.policy.${dimension}`]}`)).not.toBeNull()
  }
  fireEvent.click(within(form).getByRole('tab', { name: 'Context', exact: true }))
  for (const basis of ['baseline', 'statistics', 'budget']) {
    expect(within(form).getByRole('switch', { name: SETTINGS_COPY.en[`capabilities.policy.allocate.${basis}`] })).not.toBeNull()
  }
  expect(form.querySelector('[aria-label="Import"]')).not.toBeNull()
  expect(form.querySelectorAll('textarea')).toHaveLength(0)
  expect(form.querySelector('[aria-label="Collect usage statistics"]')).not.toBeNull()
  const fields = form.querySelector('.ptcPlusFields')
  Object.defineProperty(fields, 'clientHeight', { configurable: true, value: 500 })
  fields.style.height = '500px'
  fields.style.padding = '0'
  fields.style.border = '0'
  fields.getBoundingClientRect = () => new DOMRect(0, 100, 600, 500)
  fields.scrollTop = 40
  form.querySelector('#ptc-plus-settings-group-capabilities').getBoundingClientRect = () => new DOMRect(0, 500, 200, 20)
  fireEvent.click(form.querySelector('.ptcPlusSettingsNav [data-experimental=true]'))
  expect(fields.scrollTop).toBe(424)
  const titleSwitch = form.querySelector('.ptcPlusSettingsTitleSwitch')
  expect(titleSwitch.textContent).toBe('PTC Plus')
  expect(form.querySelector('.ptcPlusSettingsNavSwitch')).toBeNull()
  expect(form.querySelector('.ptcPlusSettingsHero')).toBeNull()
  expect(form.querySelector('.ptcPlusSettingsNavModuleTitle').closest('button')).toBeNull()
  expect(form.querySelectorAll('.ptcPlusSettingsNavIcon')).toHaveLength(7)
  fireEvent.click(titleSwitch)
  await runtime.flush()
  // The page view is the settings form itself: its controls write through the
  // same scope the legacy card uses, and the registration survives the write.
  expect(settings.set).toHaveBeenCalledWith('enabled', false)
  expect(runtime.slots.entries(ROW_CONFIG_SLOT)).toHaveLength(1)
  settings.publish({ value: { ...value, enabled: false } })
  await runtime.flush()
  expect(titleSwitch.querySelector('input').disabled).toBe(false)
  expect(form.querySelector(`[aria-label="${SETTINGS_COPY.en['bindingUpdates.label']}"]`).disabled).toBe(true)
  fireEvent.click(titleSwitch)
  await runtime.flush()
  expect(settings.set).toHaveBeenCalledWith('enabled', true)
  settings.publish({ writable: false })
  await runtime.flush()
  const writes = settings.set.mock.calls.length
  fireEvent.click(titleSwitch)
  await runtime.flush()
  expect(settings.set).toHaveBeenCalledTimes(writes)
})

test('the settings-section seat stays the only claim where the generation declares it', async () => {
  const { runtime } = await fixture({})
  expect(runtime.slots.entries('settings.plugin.item').map(entry => entry.options.key)).toEqual(['ptc-plus'])
  expect(runtime.slots.entries(ROW_CONFIG_SLOT)).toHaveLength(0)
  const view = runtime.renderRoot()
  await runtime.flush()
  const card = view.container.querySelector('.ptcPlusCard')
  expect(card.querySelector('.ptcPlusHeader')).not.toBeNull()
  expect(card.querySelector('.ptcPlusBody').hasAttribute('hidden')).toBe(true)
  expect(card.querySelector('.ptcPlusDescription').textContent).toBe('The session-bound TypeScript REPL for PTC mode.')
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
  const { runtime, settings, value, rpcCalls, setLocale } = await fixture({ repl: true, capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'catalog'
    ? Array.from({ length: 48 }, (_, index) => ({ id: `tools.longCapabilityNameForNarrowLayouts${index}`, category: 'tool', description: 'Read and transform project files' })) : [] }), rpc: async (endpoint, payload) => {
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
  await chooseCapabilityOption(view, 'Kind', 'Function')
  await runtime.flush()
  expect(sessionRows()).toHaveLength(1)
  expect(consolePane().querySelector('.ptcPlusBindingInspector').getAttribute('aria-label')).toBe('getter')
  await chooseCapabilityOption(view, 'Kind', 'All kinds')
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
  expect(groupTitles()).toEqual(['插件开关', 'REPL 语法', '状态与恢复', '工具扩展', '调用容错', '界面显示', '资源限制', '能力与上下文'])
  expect(settingsCard.querySelector('.ptcPlusSettingsLayout')).toBeNull()
  expect(settingsCard.querySelector('[data-experimental=true] .ptcPlusGroupTitle').getAttribute('data-experimental-label')).toBe('实验性')
  const recoveryGroup = settingsCard.querySelector('[aria-labelledby="ptc-plus-settings-group-recovery"]')
  expect(recoveryGroup.querySelectorAll('input[type=number]')).toHaveLength(2)
  const managementAction = settingsCard.querySelector('.ptcPlusSettingAction')
  expect(managementAction.closest('section').getAttribute('aria-labelledby')).toBe('ptc-plus-settings-group-extensions')
  expect(managementAction.previousElementSibling.querySelector('[role=switch]').getAttribute('aria-label')).toBe('启用全局用户 Binding')
  await saveLayout('settings-zh', view.container.querySelector('.ptcPlusCard'))
  setLocale('en')
  await runtime.flush()
  expect(groupTitles()).toEqual(['Plugin switch', 'REPL syntax', 'State and recovery', 'Tool extensions', 'Tool call tolerance', 'Interface display', 'Resource limits', 'Capabilities and context'])
  await saveLayout('settings-en', view.container.querySelector('.ptcPlusCard'))
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  fireEvent.click(view.getByRole('menuitem', { name: 'PTC Plus settings' }))
  await runtime.flush()
  const settingsDialog = () => document.querySelector('.ptcPlusSettingsModal')
  expect(settingsDialog()).not.toBeNull()
  expect(settingsDialog().querySelector('.ptcPlusSettingsLayout')).not.toBeNull()
  expect(settingsDialog().querySelectorAll('.ptcPlusSettingsNavItem')).toHaveLength(CONFIG_GROUPS.length - 1)
  expect(settingsDialog().querySelector('.ptcPlusSettingsNavItem[data-experimental=true]').textContent).toContain('Experimental')
  await saveLayout('settings-dialog-en', settingsDialog().parentElement)
  setLocale('zh')
  await runtime.flush()
  await saveLayout('settings-dialog-zh', settingsDialog().parentElement)
  fireEvent.click(view.getByRole('button', { name: '关闭 PTC Plus 设置' }))
  await runtime.flush()
  const rowFixture = await fixture({ settingsCardSeat: 'row', capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'catalog'
    ? Array.from({ length: 48 }, (_, index) => ({ id: `tools.longCapabilityNameForNarrowLayouts${index}`, category: 'tool', description: 'Read and transform project files' })) : [] }) })
  const rowView = rowFixture.runtime.renderRoot()
  await rowFixture.runtime.flush()
  await saveLayout('settings-page-en', rowView.container.querySelector('.ptcPlusSettingsPage'))
  rowFixture.setLocale('zh')
  await rowFixture.runtime.flush()
  await saveLayout('settings-page-zh', rowView.container.querySelector('.ptcPlusSettingsPage'))
  rowView.unmount()
  await runtime.sessions.setCurrent(undefined)
  await runtime.flush()
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
  const controls = [...settingsCard.querySelectorAll('[role=switch], [role=combobox], input[type=number], select, textarea')]
  expect(controls.some(control => control.getAttribute('aria-label') === 'Collect usage statistics')).toBe(true)
  expect(settingsCard.querySelectorAll('textarea')).toHaveLength(0)
  expect(controls.filter(control => !control.disabled && !control.closest('.ptcPlusCapabilityToolbar,.ptcPlusCapabilityFilterFields'))
    .map(control => control.getAttribute('aria-label'))).toEqual(['Enable PTC Plus'])
  settings.publish({ writable: false, value })
  await runtime.flush()
  const readonlyControls = [...settingsCard.querySelectorAll('[role=switch], [role=combobox], input[type=number], select, textarea')]
  expect(readonlyControls.filter(control => !control.closest('.ptcPlusCapabilityToolbar,.ptcPlusCapabilityFilterFields'))
    .every(control => control.disabled)).toBe(true)
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
  const panel = () => document.querySelector('.ptcPlusBindingDock')
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
    if (process.env.PTC_BINDING_UI_FIXTURE) {
      projection.set('ptcPlusRepl', { available: true, total: 4, omitted: 0,
        entries: ['variable', 'function', 'class', 'import'].map(kind => ({ name: `${kind}Value`, kind,
          definition: { source: 'const value = 42', line: 1, column: 1 } })) })
      fireEvent.click(view.container.querySelectorAll('.ptcPlusReplTab')[0])
      await runtime.flush()
      await snapshot(`kinds-${locale}`)
      fireEvent.click(view.container.querySelectorAll('.ptcPlusReplTab')[1])
      await runtime.flush()
    }
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

test('Client separates binding and capability command renderers and releases them with their owners', async () => {
  const { runtime, events, feature, settings, value } = await fixture()
  expect(events.entries().map(entry => entry.kind)).toEqual(['ptc-plus-binding-toggle'])
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
  const view = runtime.renderRoot()
  expect(view.container.textContent).toContain('PTC Plus')
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(events.entries().map(entry => entry.kind)).toEqual(['ptc-plus-binding-toggle'])
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key)).toEqual(['capabilities'])
  settings.publish({ value })
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
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

test.each([{ enabled: false }, { bindings: false }])('disabled computation features retain only eligible PTC utilities: %j', async options => {
  const { runtime, events, rpcCalls } = await fixture(options)
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.textContent).toContain('PTC Plus')
  expect(events.entries().map(entry => entry.kind)).toEqual(['ptc-plus-binding-toggle'])
  expect(runtime.slots.entries('conversation.input.left')).toHaveLength(options.enabled === false ? 0 : 1)
  expect(rpcCalls).toEqual([])
})

test.each(['recorded', 'pending', 'unavailable', 'usage', 'saved-only'])('capability command %s receipt is a single notice following locale without changing history', async state => {
  const commandNode = { commandId: 'capability-history', args: 'refresh', outcome: {
    kind: ['unavailable', 'usage', 'saved-only'].includes(state) ? 'error' : 'success',
    text: capabilityCommandReceipt(state, 'historic-session', state === 'saved-only' ? 'Update failed' : undefined) } }
  const historicalText = commandNode.outcome.text
  const { runtime, setLocale } = await fixture({ bindings: false, commandNode })
  const view = runtime.renderRoot()
  await runtime.flush()
  const expected = locale => SETTINGS_COPY[locale][`capabilities.card.${state}`].replace('{error}', 'Update failed')
  const notice = view.container.querySelector('.ptcPlusCapabilityCommandNotice')
  expect(notice.textContent).toBe(expected('en'))
  expect(notice.getAttribute('role')).toBe(commandNode.outcome.kind === 'error' ? 'alert' : 'status')
  expect(view.container.querySelector('.ptcPlusCapabilityReceipt')).toBeNull()
  expect(notice.querySelector('code, details')).toBeNull()
  setLocale('zh'); await runtime.flush()
  expect(notice.textContent).toBe(expected('zh'))
  expect(commandNode.outcome.text).toBe(historicalText)
})

test.each(['catalog', 'malformed', 'invalid-name'])('capability command %s result stays compact and retains the exact historical source', async kind => {
  const entries = Array.from({ length: 80 }, (_, index) => ({ id: `tools.probe${index}`, name: `probe${index}`,
    description: 'A recorded capability', saved: 'automatic', temporary: 'inherit', effective: 'on-demand' }))
  const text = kind === 'catalog' ? JSON.stringify({ schema: 'ptc-capability-catalog/v1', entries })
    : kind === 'malformed' ? '{"schema":"ptc-capability-catalog/v1","entries":[null]}'
      : '{"schema":"ptc-capability-catalog/v1","entries":[{"id":"tools.probe","name":{}}]}'
  const commandNode = { commandId: 'capability-source', args: 'list all',
    outcome: { kind: 'success', text } }
  const { runtime, setLocale } = await fixture({ bindings: false, commandNode })
  const view = runtime.renderRoot(); await runtime.flush()
  const card = view.getByRole('region', { name: 'Session capabilities' })
  expect(card.querySelector('pre')).toBeNull()
  expect(card.querySelector('.ptcPlusCapabilityReceiptSummary').textContent).toBe(kind === 'catalog'
    ? '80 capabilities' : 'Session capability details')
  if (kind === 'catalog') expect(within(card).getAllByRole('row', { hidden: true })).toHaveLength(81)
  const disclosure = card.querySelector('.ptcPlusCapabilityReceiptSource')
  disclosure.open = true; fireEvent(disclosure, new Event('toggle')); await runtime.flush()
  expect(card.querySelector('pre').textContent).toBe(text)
  setLocale('zh'); await runtime.flush()
  expect(card.querySelector('pre').textContent).toBe(text)
  expect(commandNode.outcome.text).toBe(text)
})

test('capability command catalog renders independent rules and Host facts beside historical scalar results in both locales', async () => {
  const entries = [
    { id: 'tools.probe', effective: 'host', saved: 'automatic', temporary: 'inherit',
      savedRule: { disclosure: 'full' }, temporaryRule: {},
      effectiveDimensions: { availability: 'enabled', disclosure: 'host', availabilitySource: 'default', disclosureSource: 'default' } },
    { id: 'tools.next', effective: 'on-demand', saved: 'automatic', temporary: 'inherit',
      savedRule: {}, temporaryRule: { availability: 'closed', disclosure: 'adaptive' } },
    { id: 'tools.legacy', effective: 'full', saved: 'closed', temporary: 'on-demand' },
    { id: 'tools.allocated', effective: 'full', saved: 'automatic', temporary: 'inherit',
      savedRule: { disclosure: 'adaptive' }, temporaryRule: {},
      effectiveDimensions: { availability: 'enabled', disclosure: 'adaptive', availabilitySource: 'default', disclosureSource: 'item:tools.allocated', selection: 'full' } },
    { id: 'tools.parent-availability', effective: 'host', savedRule: {}, temporaryRule: { availability: 'automatic' } },
    { id: 'tools.parent-disclosure', effective: 'host', savedRule: {}, temporaryRule: { disclosure: 'automatic' } },
    { id: 'tools.parent-both', effective: 'host', savedRule: {}, temporaryRule: { availability: 'automatic', disclosure: 'automatic' } },
  ]
  const text = JSON.stringify({ schema: 'ptc-capability-catalog/v1', entries })
  const commandNode = { commandId: 'independent-catalog', args: 'list all', outcome: { kind: 'success', text } }
  const { runtime, setLocale } = await fixture({ bindings: false, commandNode })
  const view = runtime.renderRoot(); await runtime.flush()
  const card = view.getByRole('region', { name: 'Session capabilities' })
  const expected = [
    ['Host defaults (Availability: Enabled · Disclosure: Host defaults)', 'Disclosure: Full contract', 'None'],
    ['On demand', 'Use parent rules', 'Availability: Closed · Disclosure: Allocate from evidence'],
    ['Full contract', 'Closed', 'On demand'],
    ['Full contract (Availability: Enabled · Disclosure: Allocate from evidence)', 'Disclosure: Allocate from evidence', 'None'],
    ['Host defaults', 'Use parent rules', 'Availability: Use parent rules'],
    ['Host defaults', 'Use parent rules', 'Disclosure: Use parent rules'],
    ['Host defaults', 'Use parent rules', 'Availability: Use parent rules · Disclosure: Use parent rules'],
  ]
  const rows = () => within(card).getAllByRole('row', { hidden: true }).slice(1)
    .map(row => within(row).getAllByRole('cell', { hidden: true }).slice(1).map(cell => cell.textContent))
  expect(rows()).toEqual(expected)
  const disclosure = card.querySelector('.ptcPlusCapabilityReceiptSource')
  disclosure.open = true; fireEvent(disclosure, new Event('toggle')); await runtime.flush()
  expect(card.querySelector('pre').textContent).toBe(text)
  setLocale('zh'); await runtime.flush()
  expect(rows()).toEqual([
    ['沿用 DSH (可用性: 已启用 · 说明方式: 沿用 DSH)', '说明方式: 完整提供', '无覆盖'],
    ['按需提供', '沿用上层规则', '可用性: 关闭能力 · 说明方式: 按依据分配'],
    ['完整提供', '关闭能力', '按需提供'],
    ['完整提供 (可用性: 已启用 · 说明方式: 按依据分配)', '说明方式: 按依据分配', '无覆盖'],
    ['沿用 DSH', '沿用上层规则', '可用性: 沿用上层规则'],
    ['沿用 DSH', '沿用上层规则', '说明方式: 沿用上层规则'],
    ['沿用 DSH', '沿用上层规则', '可用性: 沿用上层规则 · 说明方式: 沿用上层规则'],
  ])
  expect(card.querySelector('pre').textContent).toBe(text)
  expect(commandNode.outcome.text).toBe(text)
})

test.each([null, [], { availability: 'full' }, { disclosure: 'inherit' }, { source: 'item' }, { availability: 'automatic' }, { disclosure: 'automatic' }])
('capability command catalog retains malformed independent rule %j as exact source', async savedRule => {
  const text = JSON.stringify({ schema: 'ptc-capability-catalog/v1', entries: [{ id: 'tools.probe', savedRule }] })
  const { runtime } = await fixture({ bindings: false, commandNode: { args: 'list all', outcome: { kind: 'success', text } } })
  const view = runtime.renderRoot(); await runtime.flush()
  const card = view.getByRole('region', { name: 'Session capabilities' })
  expect(card.querySelector('table')).toBeNull()
  const disclosure = card.querySelector('.ptcPlusCapabilityReceiptSource')
  disclosure.open = true; fireEvent(disclosure, new Event('toggle')); await runtime.flush()
  expect(card.querySelector('pre').textContent).toBe(text)
})

test.each(['legacy', 'running', 'error', 'json-error', 'empty-error', 'whitespace-error', 'empty-success', 'whitespace-success'])
('capability refresh %s displays only its outcome line', async kind => {
  const text = kind === 'legacy' ? 'Session capability environment refreshed; the model-visible notification is recorded.'
    : kind.startsWith('empty') ? '' : kind.startsWith('whitespace') ? ' \n\t '
      : kind === 'json-error' ? '{"message":"Publication refused","code":"WRITE_FAILED"}' : 'Refresh failed: connection closed'
  const isError = kind.endsWith('error')
  const commandNode = { commandId: 'refresh-notice', args: 'refresh',
    outcome: kind === 'running' ? null : { kind: isError ? 'error' : 'success', text } }
  const { runtime, setLocale } = await fixture({ bindings: false, commandNode })
  const view = runtime.renderRoot(); await runtime.flush()
  const notice = view.container.querySelector('.ptcPlusCapabilityCommandNotice')
  const expected = locale => !text.trim() ? SETTINGS_COPY[locale][isError ? 'capabilities.commandFailed' : 'capabilities.refreshAcknowledged']
    : isError ? text : SETTINGS_COPY[locale][kind === 'running' ? 'capabilities.refreshing' : 'capabilities.card.recorded']
  expect(notice.textContent).toBe(expected('en'))
  expect(notice.textContent.trim()).not.toBe('')
  expect(notice.getAttribute('role')).toBe(isError ? 'alert' : 'status')
  expect(view.container.querySelector('.ptcPlusCapabilityReceipt')).toBeNull()
  setLocale('zh'); await runtime.flush()
  expect(notice.textContent).toBe(expected('zh'))
  expect(commandNode.outcome?.text).toBe(kind === 'running' ? undefined : text)
})

test('binding toggle receipt is a separate visible historical fact with current locale', async () => {
  const data = { ...bindingToggleMessage({ id: 'saved', name: 'helper', enabled: true }, 4), id: 'receipt-id' }
  const event = { seq: 7, type: 'user/message', surfaceOp: 'append', data }
  expect(bindingToggleConversationDefinition.match(event)).toEqual({ id: 'receipt-id', role: 'start' })
  expect(bindingToggleConversationDefinition.match({ ...event, data: { ...data, source: { kind: 'user' } } })).toBeNull()
  expect(bindingToggleConversationDefinition.match({ ...event, surfaceOp: undefined })).toBeNull()
  const match = { event, role: 'start', location: { kind: 'session' } }
  const context = { key: 'receipt-key', id: 'receipt-id', start: match,
    state: bindingToggleConversationDefinition.start({}, match) }
  const chatNode = bindingToggleConversationDefinition.buildViewNode(context)
  expect(chatNode.anchorSeq).toBe(7)
  expect(chatNode.visibility).toBe('visible')
  const { runtime, setLocale, settings, value } = await fixture({ chatNode })
  const view = runtime.renderRoot(); await runtime.flush()
  expect(view.getByText(SETTINGS_COPY.en['bindings.toggleEnabled'].replace('{name}', 'helper'))).not.toBeNull()
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  setLocale('zh'); await runtime.flush()
  expect(view.getByText(SETTINGS_COPY.zh['bindings.toggleEnabled'].replace('{name}', 'helper'))).not.toBeNull()
})

test.each([true, false].flatMap(bindings => ['', 'Unsent request'].map(draft => [bindings, draft])))
('sparkle capability refresh prefills without sending or replacing a draft (bindings %s, draft %j)', async (bindings, draft) => {
  const execute = vi.fn(async () => ({ ok: true, value: { commandId: 'refresh-current', result: {
    kind: 'success', text: 'Prepared; notification awaits first accepted step.' } } }))
  const { runtime, input, rpcCalls } = await fixture({ bindings, commands: {
    list: async () => ({ ok: true, value: [{ name: 'capabilities', input: { hint: 'refresh' } }] }), execute,
  } })
  const view = runtime.renderRoot()
  await runtime.flush()
  input.publish({ draft })
  await openGlobalMenu(view, runtime, 'click')
  if (!bindings) expect(view.queryByRole('menuitem', { name: 'Manage global bindings' })).toBeNull()
  expect(view.getByRole('menuitem', { name: 'PTC Plus settings' })).not.toBeNull()
  const before = input.scope.getSnapshot()
  fireEvent.click(view.getByRole('menuitem', { name: 'Refresh session capabilities' }))
  await runtime.flush()
  expect(execute).not.toHaveBeenCalled()
  expect(view.queryByText('Prepared; notification awaits first accepted step.')).toBeNull()
  expect(input.scope.getSnapshot()).toEqual(draft ? before : { ...before, draft: '/capabilities refresh' })
  expect(view.queryByRole('menu')).toBeNull()
  if (draft) expect(view.getByText(SETTINGS_COPY.en['bindings.composerBusy'])).not.toBeNull()
  expect(rpcCalls.every(({ endpoint }) => endpoint === 'list')).toBe(true)
})

test('sparkle capability refresh requires its own live command and leaves binding authoring available', async () => {
  const execute = vi.fn()
  const { runtime, input } = await fixture({ commands: {
    list: async () => ({ ok: true, value: [{ name: 'binding' }] }), execute,
  } })
  const view = runtime.renderRoot(); await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  const refresh = view.getByRole('menuitem', { name: 'Refresh session capabilities' })
  expect(refresh.disabled).toBe(true)
  fireEvent.click(refresh)
  expect(input.scope.getSnapshot().draft).toBe('')
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  await runtime.flush()
  expect(input.scope.getSnapshot().draft).toBe('/binding new ')
  expect(execute).not.toHaveBeenCalled()
})

async function chooseCapabilityOption(view, label, option) {
  if (label === 'Capability types') { fireEvent.click(within(view.container.querySelector('.ptcPlusCapabilityTypes')).getByRole('button', { name: option, exact: true })); return }
  if (label === 'Saved configurations') { fireEvent.click(view.getByRole('button', { name: option, exact: true })); return }
  if (/^(Disclosure|Availability) for (tools\.|skills\.|mcp\.)/.test(label) && !view.queryByRole('combobox', { name: label })) {
    const id = label.replace(/^(Disclosure|Availability) for /, '')
    fireEvent.click(view.getByRole('button', { name: `Edit context settings: ${id}` }))
  }
  if (['Capability source', 'Saved disclosure', 'Saved availability', 'Availability', 'Sort by'].includes(label)
      && view.container.querySelector('.ptcPlusCapabilityToolbar') && !view.container.querySelector('.ptcPlusCapabilityFilterFields')) {
    fireEvent.click(view.getByRole('button', { name: 'Filter', exact: true }))
  }
  const trigger = view.getByRole('combobox', { name: label })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.click(await view.findByRole('option', { name: option }))
  await act(async () => {})
}

test('shared Select preserves empty and arbitrary string values, skips disabled choices and closes when disabled', async () => {
  const Select = createSelect(React)
  const onChange = vi.fn()
  function Probe({ disabled = false }) {
    const [value, setValue] = React.useState('')
    return React.createElement(Select, { value, disabled, label: 'Shared choice',
      options: [{ value: '', label: 'No selection' }, { value: 'closed', label: 'Unavailable', disabled: true },
        { value: '__ptc_plus_empty_choice__', label: 'Explicit identifier' }],
      onChange: next => { onChange(next); setValue(next) } })
  }
  const view = render(React.createElement(Probe))
  cleanups.push(() => view.unmount())
  const trigger = view.getByRole('combobox', { name: 'Shared choice' })
  expect(trigger.textContent).toContain('No selection')
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const disabled = await view.findByRole('option', { name: 'Unavailable' })
  expect(disabled.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(disabled)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('option', { name: 'Explicit identifier' }))
  await act(async () => {})
  expect(onChange).toHaveBeenLastCalledWith('__ptc_plus_empty_choice__')
  await chooseCapabilityOption(view, 'Shared choice', 'No selection')
  expect(onChange).toHaveBeenLastCalledWith('')
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  await view.findByRole('listbox')
  view.rerender(React.createElement(Probe, { disabled: true }))
  await act(async () => {})
  expect(view.queryByRole('listbox')).toBeNull()
  expect(trigger.disabled).toBe(true)
})

test('sparkle session capability workbench reads a catalog, groups sources and preserves the composer draft', async () => {
  const entries = [
    { id: 'tools.probe', category: 'tool', source: { kind: 'host' }, saved: 'full', temporary: 'inherit', effective: 'full' },
    { id: 'skills.design', category: 'skill', source: { kind: 'skill' }, saved: 'automatic', temporary: 'inherit', effective: 'on-demand' },
    { id: 'mcpServers.docs', category: 'server', source: { kind: 'mcp' }, saved: 'automatic', temporary: 'inherit', effective: 'enabled' },
    { id: 'mcp.docs', category: 'resource', source: { kind: 'mcp' }, saved: 'automatic', temporary: 'inherit', effective: 'on-demand' },
    { id: 'tools.mcp__docs__search', category: 'tool', source: { kind: 'mcp' }, saved: 'automatic', temporary: 'inherit', effective: 'on-demand' },
  ]
  const execute = vi.fn(async (sessionId, line) => {
    const [, , scope, id, choice] = line.split(' ')
    const entry = entries.find(item => item.id === id)
    entry[scope === 'session' ? 'temporary' : 'saved'] = choice
    return { ok: true, value: { commandId: 'control', result: { kind: 'success', text: capabilityCommandReceipt('recorded', sessionId) } } }
  })
  const { runtime, input, rpcCalls, capabilityRpcCalls } = await fixture({ bindings: false,
    capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'session-catalog' ? structuredClone(entries) : [] }),
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute } })
  const view = runtime.renderRoot(); await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Session capability controls' })); await runtime.flush()
  const panel = view.getByRole('dialog', { name: 'Manage session capabilities' })
  expect(capabilityRpcCalls.some(call => call.endpoint === 'session-catalog')).toBe(true)
  for (const name of ['Ordinary tools', 'Skills', 'MCP tools', 'MCP servers and resources']) {
    expect(within(panel).getByRole('heading', { name })).not.toBeNull()
  }
  const resourceGroup = within(panel).getByRole('heading', { name: 'MCP servers and resources' }).closest('section')
  const toolsGroup = within(panel).getByRole('heading', { name: 'MCP tools' }).closest('section')
  expect(within(resourceGroup).getByRole('button', { name: /mcp.docs/ })).not.toBeNull()
  expect(within(toolsGroup).queryByRole('button', { name: /mcp.docs/ })).toBeNull()
  await chooseCapabilityOption(view, 'Capability category', 'MCP servers and resources')
  expect(within(panel).getAllByRole('button').filter(button => button.classList.contains('ptcPlusSessionCapabilityRow'))).toHaveLength(2)
  expect(within(panel).getByRole('button', { name: /mcp.docs/ })).not.toBeNull()
  expect(within(panel).queryByRole('button', { name: /tools.mcp__docs__search/ })).toBeNull()
  await chooseCapabilityOption(view, 'Capability category', 'MCP tools')
  expect(within(panel).getByRole('button', { name: /tools.mcp__docs__search/ })).not.toBeNull()
  expect(within(panel).queryByRole('button', { name: /mcp.docs/ })).toBeNull()
  await chooseCapabilityOption(view, 'Capability category', 'All capabilities')
  fireEvent.click(within(panel).getByRole('button', { name: /mcpServers.docs/ }))
  expect(panel.querySelector('.ptcPlusSessionCapabilityChildren').textContent).toContain('tools.mcp__docs__search')
  fireEvent.click(within(panel).getByRole('button', { name: /tools.probe/ }))
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  input.publish({ draft: 'Keep my unsent message' }); await runtime.flush()
  expect(input.scope.getSnapshot().draft).toBe('Keep my unsent message')
  fireEvent.click(view.getByRole('button', { name: 'Apply to session' })); await runtime.flush()
  expect(execute.mock.calls[0].slice(0, 3)).toEqual(['client-session', '/capabilities set session tools.probe closed', []])
  expect(input.scope.getSnapshot().draft).toBe('Keep my unsent message')
  expect(rpcCalls).toEqual([])
})

test('sparkle session capability controls reload saved-only facts and cancel or discard late requests', async () => {
  const pending = deferred()
  let entries = [{ id: 'tools.probe', category: 'tool', source: { kind: 'host' }, saved: 'automatic', temporary: 'inherit', effective: 'on-demand' }]
  const execute = vi.fn(async (sessionId, line) => {
    if (execute.mock.calls.filter(call => call[1].includes(' set ')).length === 1) {
      entries = [{ ...entries[0], saved: 'closed' }]
      return { ok: true, value: { commandId: 'partial', result: { kind: 'error', text: capabilityCommandReceipt('saved-only', sessionId, 'Publication refused') } } }
    }
    return pending.promise
  })
  const { runtime, setLocale } = await fixture({ bindings: false,
    capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'session-catalog' ? structuredClone(entries) : [] }),
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute } })
  const view = runtime.renderRoot(); await runtime.flush(); await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Session capability controls' })); await runtime.flush()
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  fireEvent.click(view.getByRole('button', { name: 'Save and apply' })); await runtime.flush()
  expect(document.body.textContent).toContain('Publication refused')
  expect(document.body.textContent).toContain('Closed')
  fireEvent.click(view.getByRole('button', { name: 'Save and apply' })); await runtime.flush()
  const signal = execute.mock.calls.at(-1)[3]
  fireEvent.click(view.getByRole('button', { name: 'Close PTC Plus settings' })); await runtime.flush()
  expect(signal.aborted).toBe(true)
  setLocale('zh'); await runtime.flush()
  pending.resolve({ ok: true, value: { commandId: 'late', result: { kind: 'success', text: 'LATE_CONTROL_RECEIPT' } } }); await runtime.flush()
  expect(view.queryByText('LATE_CONTROL_RECEIPT')).toBeNull()
})

test.each(['pending', 'usage'])('sparkle session capability %s receipt reports only confirmed application', async state => {
  let entries = [{ id: 'tools.probe', category: 'tool', source: { kind: 'host' },
    saved: 'automatic', temporary: 'inherit', effective: 'on-demand' }]
  const execute = vi.fn(async sessionId => {
    if (state === 'pending') entries = [{ ...entries[0], temporary: 'closed', effective: 'pending' }]
    return { ok: true, value: { commandId: 'choice', result: { kind: 'success',
      text: capabilityCommandReceipt(state, sessionId) } } }
  })
  const { runtime } = await fixture({ bindings: false,
    capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'session-catalog' ? structuredClone(entries) : [] }),
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute } })
  const view = runtime.renderRoot(); await runtime.flush(); await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Session capability controls' })); await runtime.flush()
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  fireEvent.click(view.getByRole('button', { name: 'Apply to session' })); await runtime.flush()
  expect(execute).toHaveBeenCalledTimes(1)
  if (state === 'pending') {
    expect(view.getByText('1 submitted; some take effect at the first accepted model step.')).not.toBeNull()
    expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(true)
  } else {
    expect(document.body.textContent).toContain('remaining changes were not applied')
    expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(false)
  }
})

test('session capability filters keep type and source compatible', async () => {
  const entries = [
    { id: 'tools.read', category: 'tool', source: { kind: 'host' }, effective: 'on-demand' },
    { id: 'skills.design', category: 'skill', source: { kind: 'skill', bucket: 'user-agents' }, effective: 'on-demand' },
    { id: 'tools.mcp__docs__search', category: 'tool', source: { kind: 'mcp', server: 'docs' }, effective: 'on-demand' },
  ]
  const { runtime } = await fixture({ bindings: false,
    capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'session-catalog' ? entries : [] }),
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }) } })
  const view = runtime.renderRoot(); await runtime.flush(); await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Session capability controls' })); await runtime.flush()
  await chooseCapabilityOption(view, 'Capability category', 'Skills')
  const source = view.getByRole('combobox', { name: 'Capability source' })
  fireEvent.keyDown(source, { key: 'ArrowDown' })
  expect(view.getByRole('option', { name: 'Skill · User skill (.agents)' })).not.toBeNull()
  expect(view.queryByRole('option', { name: 'Host tools' })).toBeNull()
  fireEvent.click(view.getByRole('option', { name: 'Skill · User skill (.agents)' })); await runtime.flush()
  await chooseCapabilityOption(view, 'Capability category', 'Ordinary tools')
  expect(source.textContent).toContain('All sources')
  expect(view.getByRole('button', { name: /tools.read/ })).not.toBeNull()
  expect(view.queryByRole('button', { name: /skills.design/ })).toBeNull()
})

test.each([
  ['effective', 'automatic', 'inherit', 'closed', 'is closed'],
  ['saved', 'closed', 'inherit', 'enabled', 'awaiting effect'],
  ['draft', 'automatic', 'inherit', 'enabled', 'awaiting effect'],
])('session MCP child reports %s server closure accurately', async (mode, saved, temporary, effective, expected) => {
  const entries = [
    { id: 'mcpServers.docs', category: 'server', source: { kind: 'mcp', server: 'docs' }, saved, sessionSourceSelection: saved, temporary, effective },
    { id: 'tools.mcp__docs__search', category: 'tool', source: { kind: 'mcp', server: 'docs' },
      saved: 'automatic', temporary: 'inherit', effective: 'on-demand' },
  ]
  const { runtime } = await fixture({ bindings: false,
    capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'session-catalog' ? entries : [] }),
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }) } })
  const view = runtime.renderRoot(); await runtime.flush(); await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Session capability controls' })); await runtime.flush()
  if (mode === 'draft') {
    fireEvent.click(view.getByRole('button', { name: /mcpServers.docs/ }))
    await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  }
  fireEvent.click(view.getByRole('button', { name: /tools.mcp__docs__search/ }))
  expect(view.getByText(new RegExp(`MCP server docs .*${expected}`))).not.toBeNull()
  if (mode === 'draft') expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(false)
})

test.each([
  ['session automatic cancels frozen closure', 'session', 'closed', 'closed', 'inherit', 'enabled', 'Follow automatic', null],
  ['session inherit restores frozen closure', 'session', 'closed', 'closed', 'automatic', 'enabled', 'Inherit session settings', 'awaiting effect'],
  ['session inherit restores frozen closure after global automatic save', 'session', 'automatic', 'closed', 'automatic', 'enabled', 'Inherit session settings', 'awaiting effect'],
  ['session inherit keeps frozen automatic after global closure save', 'session', 'closed', 'automatic', 'automatic', 'enabled', 'Inherit session settings', null],
  ['session inherit does not guess missing frozen source from global closure', 'session', 'closed', undefined, 'automatic', 'enabled', 'Inherit session settings', null],
  ['session inherit does not guess unknown frozen source from global closure', 'session', 'closed', 'unknown', 'automatic', 'enabled', 'Inherit session settings', null],
  ['global automatic clears saved closure', 'global', 'closed', 'closed', 'inherit', 'enabled', 'Follow automatic', null],
  ['global closed stages source closure', 'global', 'automatic', 'automatic', 'automatic', 'enabled', 'Closed', 'awaiting effect'],
  ['effective closure survives session automatic draft', 'session', 'closed', 'closed', 'inherit', 'closed', 'Follow automatic', 'is closed'],
  ['effective closure survives global automatic draft', 'global', 'closed', 'closed', 'automatic', 'closed', 'Follow automatic', 'is closed'],
])('session MCP child uses proposed parent choice: %s', async (_case, scope, saved, sessionSourceSelection, temporary, effective, selection, expected) => {
  const entries = [
    { id: 'mcpServers.docs', category: 'server', source: { kind: 'mcp', server: 'docs' }, saved, sessionSourceSelection, temporary, effective },
    { id: 'tools.mcp__docs__search', category: 'tool', source: { kind: 'mcp', server: 'docs' },
      saved: 'on-demand', sessionSourceSelection: 'full', temporary: 'full', effective: 'full' },
  ]
  const before = structuredClone(entries)
  const execute = vi.fn()
  const { runtime } = await fixture({ bindings: false,
    capabilityRpc: async endpoint => ({ ok: true, value: endpoint === 'session-catalog' ? structuredClone(entries) : [] }),
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute } })
  const view = runtime.renderRoot(); await runtime.flush(); await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Session capability controls' })); await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: /mcpServers.docs/ }))
  const detail = view.getByRole('dialog', { name: 'Manage session capabilities' })
  const fact = label => Array.from(detail.querySelectorAll('dt')).find(node => node.textContent === label)?.nextElementSibling?.textContent
  expect(fact('Global settings')).toBe(saved === 'closed' ? 'Closed' : 'Follow automatic')
  expect(fact('Session inheritance')).toBe(sessionSourceSelection === 'closed' ? 'Closed' : sessionSourceSelection === 'automatic' ? 'Follow automatic' : 'Unknown')
  await chooseCapabilityOption(view, 'Selection strategy', selection)
  fireEvent.click(view.getByRole('button', { name: /tools.mcp__docs__search/ }))
  const notice = view.getByRole('dialog', { name: 'Manage session capabilities' }).querySelector('.ptcPlusCapabilityNotice')
  if (expected === null) expect(notice).toBeNull()
  else expect(notice.textContent).toContain(expected)
  expect(view.getByRole('combobox', { name: 'Selection strategy' }).textContent).toContain('Full contract')
  expect(entries).toEqual(before)
  expect(execute).not.toHaveBeenCalled()
})

test.each(['session', 'global'])('session capability footer applies the same draft to %s and confirms the whole transaction', async scope => {
  let entries = [{ id: 'tools.probe', category: 'tool', source: { kind: 'host' },
    saved: 'automatic', temporary: 'inherit', effective: 'on-demand' }]
  const run = vi.fn(async (sessionId, input) => {
    expect(input).toBe(`set ${scope} tools.probe closed`)
    entries = [{ ...entries[0], ...(scope === 'session' ? { temporary: 'closed' }
      : { saved: 'closed', temporary: 'inherit' }) }]
    return { kind: 'success', text: capabilityCommandReceipt('recorded', sessionId) }
  })
  const { view, commands } = await sessionControlsFixture({ read: async () => structuredClone(entries), run })
  expect(view.queryByRole('combobox', { name: 'Apply to' })).toBeNull()
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(false)
  expect(view.getByRole('button', { name: 'Save and apply' }).disabled).toBe(false)
  fireEvent.click(view.getByRole('button', { name: 'Discard changes' }))
  expect(commands.run).not.toHaveBeenCalled()
  expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(true)
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  fireEvent.click(view.getByRole('button', { name: scope === 'session' ? 'Apply to session' : 'Save and apply' }))
  await act(async () => {})
  expect(commands.run).toHaveBeenCalledTimes(1)
  expect(view.getByRole('button', { name: 'Discard changes' }).disabled).toBe(true)
  view.unmount()
})

test('global capability application retains a draft until the same temporary override is cleared', async () => {
  let entries = [{ id: 'tools.probe', category: 'tool', source: { kind: 'host' },
    saved: 'automatic', temporary: 'full', effective: 'full' }]
  const { view } = await sessionControlsFixture({ read: async () => structuredClone(entries),
    run: async sessionId => {
      entries = [{ ...entries[0], saved: 'closed' }]
      return { kind: 'success', text: capabilityCommandReceipt('recorded', sessionId) }
    } })
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  fireEvent.click(view.getByRole('button', { name: 'Save and apply' }))
  await act(async () => {})
  expect(view.getByText(/remaining changes were not applied/)).not.toBeNull()
  expect(view.getByRole('button', { name: 'Save and apply' }).disabled).toBe(false)
  await chooseCapabilityOption(view, 'Selection strategy', 'Inherit session settings')
  expect(view.getByRole('button', { name: 'Save and apply' }).disabled).toBe(true)
  expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(false)
  view.unmount()
})

async function sessionControlsFixture({ read, run, sessionId = 'client-session' }) {
  let available = true
  const subscribers = new Set()
  const source = { getSnapshot: () => available, subscribe: listener => {
    subscribers.add(listener); return () => subscribers.delete(listener)
  } }
  const commands = { source: () => source, run: vi.fn(run) }
  const inspectSessionCatalog = vi.fn(read)
  const SessionCapabilityControls = createSessionCapabilityControlsView(React, {
    commands, Modal: createFallbackModal(React, createPortal), Select: createSelect(React), inspectSessionCatalog,
  })
  const t = (key, params = {}) => (SETTINGS_COPY.en[key] ?? key)
    .replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token)
  const props = { sessionId, open: true, enabled: true, onClose: vi.fn(), t }
  const element = () => React.createElement(SessionCapabilityControls, props)
  const view = render(element())
  await act(async () => {})
  return { view, props, commands, inspectSessionCatalog, rerender: () => view.rerender(element()),
    setAvailable: async next => act(async () => { available = next; for (const listener of subscribers) listener() }) }
}

test.each(['feature', 'service', 'session'])('session controls discard an obsolete catalog read after %s changes', async change => {
  const stale = deferred()
  const entry = id => [{ id, category: 'tool', source: { kind: 'host' }, saved: 'automatic',
    temporary: 'inherit', effective: 'on-demand' }]
  let reads = 0
  const fixture = await sessionControlsFixture({ read: () => ++reads === 1
    ? stale.promise : Promise.resolve(entry('tools.current')) })
  const { view, props, inspectSessionCatalog, rerender, setAvailable } = fixture
  const firstSignal = inspectSessionCatalog.mock.calls[0][1]
  if (change === 'feature') { props.enabled = false; rerender() }
  if (change === 'service') await setAvailable(false)
  if (change === 'session') { props.sessionId = 'next-session'; rerender() }
  await act(async () => {})
  expect(firstSignal.aborted).toBe(true)
  await act(async () => stale.resolve(entry('tools.obsolete')))
  expect(view.queryByRole('button', { name: /tools.obsolete/ })).toBeNull()
  if (change !== 'session') {
    if (change === 'feature') { props.enabled = true; rerender() }
    else await setAvailable(true)
    await act(async () => {})
  }
  expect(view.getByRole('button', { name: /tools.current/ })).not.toBeNull()
  view.unmount()
})

test.each(['feature', 'service', 'session'])('session controls abort an in-flight apply after %s changes', async change => {
  const pending = deferred()
  const entry = [{ id: 'tools.probe', category: 'tool', source: { kind: 'host' }, saved: 'automatic',
    temporary: 'inherit', effective: 'on-demand' }]
  const fixture = await sessionControlsFixture({ read: async () => entry, run: () => pending.promise })
  const { view, props, commands, rerender, setAvailable } = fixture
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  fireEvent.click(view.getByRole('button', { name: 'Apply to session' })); await act(async () => {})
  expect(view.queryByRole('combobox', { name: 'Apply to' })).toBeNull()
  expect(view.getByRole('button', { name: 'Save and apply' }).disabled).toBe(true)
  expect(view.getByRole('button', { name: 'Discard changes' }).disabled).toBe(true)
  const signal = commands.run.mock.calls[0][2]
  if (change === 'feature') { props.enabled = false; rerender() }
  if (change === 'service') await setAvailable(false)
  if (change === 'session') { props.sessionId = 'next-session'; rerender() }
  await act(async () => {})
  expect(signal.aborted).toBe(true)
  await act(async () => pending.resolve({ kind: 'success', text: capabilityCommandReceipt('recorded', 'client-session') }))
  expect(view.queryByText('1 capability changes submitted.')).toBeNull()
  view.unmount()
})

test.each(['usage', 'mismatched'])('session controls retain the unconfirmed tail after a %s receipt', async state => {
  let entries = ['tools.first', 'tools.second'].map(id => ({ id, category: 'tool', source: { kind: 'host' },
    saved: 'automatic', temporary: 'inherit', effective: 'on-demand' }))
  const run = vi.fn(async (sessionId, input) => {
    if (input.includes('tools.first')) {
      entries = entries.map(entry => entry.id === 'tools.first' ? { ...entry, temporary: 'closed' } : entry)
      return { kind: 'success', text: capabilityCommandReceipt('recorded', sessionId) }
    }
    return { kind: 'success', text: state === 'usage' ? capabilityCommandReceipt('usage', sessionId)
      : capabilityCommandReceipt('recorded', 'other-session') }
  })
  const { view, commands } = await sessionControlsFixture({ read: async () => structuredClone(entries), run })
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  fireEvent.click(view.getByRole('button', { name: /tools.second/ }))
  await chooseCapabilityOption(view, 'Selection strategy', 'Closed')
  fireEvent.click(view.getByRole('button', { name: 'Apply to session' })); await act(async () => {})
  expect(commands.run.mock.calls.map(([, input]) => input)).toEqual([
    'set session tools.first closed', 'set session tools.second closed',
  ])
  expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(false)
  expect(view.getByRole('button', { name: /tools.second/ }).textContent).toContain('Closed')
  expect(view.getByRole('button', { name: /tools.first/ }).textContent).not.toContain('Closed')
  view.unmount()
})

test('settings refresh selects an exact session with management off and rejects duplicate clicks and late readonly receipts', async () => {
  const pending = deferred()
  const execute = vi.fn(() => pending.promise)
  const { runtime, settings, value, capabilityRpcCalls } = await fixture({ settingsCardSeat: 'row', bindings: false,
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute },
    capabilityRpc: async operation => operation === 'allocation' ? { ok: false, error: { message: 'Allocation preview unavailable' } }
      : { ok: true, value: operation === 'targets' ? [{ sessionId: 'first' }, { sessionId: 'second' }] : [] },
  })
  settings.publish({ value: { ...value, capabilityManagementEnabled: false } })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  const button = view.getByRole('button', { name: 'Refresh session capabilities' })
  expect(button.disabled).toBe(true)
  await chooseCapabilityOption(view, SETTINGS_COPY.en['capabilities.targetSession'], 'second')
  await runtime.flush()
  expect(button.disabled).toBe(false)
  fireEvent.click(button); fireEvent.click(button)
  await runtime.flush()
  expect(execute).toHaveBeenCalledTimes(1)
  expect(execute.mock.calls[0].slice(0, 3)).toEqual(['second', '/capabilities refresh', []])
  const signal = execute.mock.calls[0][3]
  settings.publish({ writable: false })
  await runtime.flush()
  expect(signal.aborted).toBe(true)
  pending.resolve({ ok: true, value: { commandId: 'stale', result: { kind: 'success', text: 'STALE_REFRESH_RECEIPT' } } })
  await runtime.flush()
  expect(view.queryByText('STALE_REFRESH_RECEIPT')).toBeNull()
  expect(capabilityRpcCalls.filter(call => call.endpoint === 'inspect')).toEqual([])
  expect(settings.set).not.toHaveBeenCalled()
})

test('settings refresh distinguishes cancellation, failure and pending publication without applying a replacement target', async () => {
  let targets = [{ sessionId: 'first' }, { sessionId: 'second' }]
  const pending = deferred()
  const execute = vi.fn().mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce({ ok: true, value: { commandId: 'failed', result: { kind: 'error', text: 'Publication failed' } } })
    .mockResolvedValueOnce({ ok: true, value: { commandId: 'pending', result: { kind: 'success', text: 'Notification awaits first accepted step.' } } })
  const { runtime, settings, value } = await fixture({ settingsCardSeat: 'row', bindings: false,
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute },
    capabilityRpc: async operation => operation === 'allocation' ? { ok: false, error: { message: 'Allocation preview unavailable' } }
      : { ok: true, value: operation === 'targets' ? targets : [] },
  })
  settings.publish({ value: { ...value, capabilityManagementEnabled: false } })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  await chooseCapabilityOption(view, SETTINGS_COPY.en['capabilities.targetSession'], 'second')
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Refresh session capabilities' }))
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Cancel refresh' }))
  await runtime.flush()
  expect(execute.mock.calls[0][3].aborted).toBe(true)
  pending.resolve({ ok: true, value: { commandId: 'late', result: { kind: 'success', text: 'LATE_CANCELLED_RECEIPT' } } })
  await runtime.flush()
  expect(view.queryByText('LATE_CANCELLED_RECEIPT')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Refresh session capabilities' }))
  await runtime.flush()
  expect(view.getByText('Refresh failed: Publication failed')).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Refresh session capabilities' }))
  await runtime.flush()
  expect(view.getByText('Notification awaits first accepted step.')).not.toBeNull()
  targets = [{ sessionId: 'first' }]
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.manual'] }))
  fireEvent.click(view.getByRole('button', { name: 'Reload catalog' }))
  await runtime.flush()
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  expect(view.getByLabelText(SETTINGS_COPY.en['capabilities.targetSession']).value).toBe('')
  expect(view.getByRole('button', { name: 'Refresh session capabilities' }).disabled).toBe(true)
  expect(execute.mock.calls.every(([id]) => id === 'second')).toBe(true)
})

test.each(['connection reset', 'provider removal', 'session switch', 'plugin disable', 'preset change'])('settings refresh rejects late receipts after %s', async lifecycle => {
  const pending = deferred()
  const execute = vi.fn(() => pending.promise)
  const commands = { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute }
  const { runtime, remote, settings, value } = await fixture({ bindings: false,
    capabilityRpc: async endpoint => endpoint === 'allocation'
      ? { ok: false, error: { message: 'Allocation preview unavailable' } }
      : { ok: true, value: endpoint === 'targets' ? [{ sessionId: 'client-session' }] : [] },
    ...(lifecycle === 'provider removal' ? {} : { commands }),
  })
  const provider = lifecycle === 'provider removal' ? await runtime.mount({ apply(ctx) { ctx.provide('remote.commands', commands) } }) : null
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'PTC Plus settings' }))
  await runtime.flush()
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  await chooseCapabilityOption(view, SETTINGS_COPY.en['capabilities.targetSession'], 'client-session')
  fireEvent.click(view.getByRole('button', { name: 'Refresh session capabilities' }))
  await runtime.flush()
  if (lifecycle === 'connection reset') runtime.ctx.emit('connection/reset')
  if (lifecycle === 'provider removal') await provider.dispose()
  if (lifecycle === 'session switch') {
    await runtime.sessions.add({ id: 'other-refresh-session' })
    await runtime.sessions.setCurrent('other-refresh-session')
  }
  if (lifecycle === 'plugin disable') settings.publish({ value: { ...value, enabled: false } })
  if (lifecycle === 'preset change') remote.emit('agent-preset/selected', ['client-session'])
  await runtime.flush()
  pending.resolve({ ok: true, value: { commandId: 'late', result: { kind: 'success', text: 'INVALID_LATE_SUCCESS' } } })
  await runtime.flush()
  expect(view.queryByText('INVALID_LATE_SUCCESS')).toBeNull()
  expect(execute).toHaveBeenCalledTimes(1)
})

test('target read failures block refresh while frozen-plan read failures preserve the explicit command target', async () => {
  let failTargets = false
  const execute = vi.fn(async () => ({ ok: true, value: { result: { kind: 'success', text: 'Exact target refreshed' } } }))
  const { runtime, settings, value } = await fixture({ settingsCardSeat: 'row', bindings: false,
    commands: { list: async () => ({ ok: true, value: [{ name: 'capabilities' }] }), execute },
    capabilityRpc: async operation => {
      if (operation === 'allocation') return { ok: false, error: { message: 'Allocation preview unavailable' } }
      if (operation === 'inspect') throw new Error('Frozen plan read failed')
      if (operation === 'targets' && failTargets) throw new Error('Target read failed')
      return { ok: true, value: operation === 'targets' ? [{ sessionId: 'explicit-target' }] : [] }
    },
  })
  settings.publish({ value: { ...value, capabilityManagementEnabled: true } })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  await runtime.flush()
  await chooseCapabilityOption(view, SETTINGS_COPY.en['capabilities.targetSession'], 'explicit-target')
  await runtime.flush()
  const button = view.getByRole('button', { name: 'Refresh session capabilities' })
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await runtime.flush()
  expect(execute.mock.calls[0][0]).toBe('explicit-target')
  failTargets = true
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.manual'] }))
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Reload catalog' }))
  await runtime.flush()
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  await runtime.flush()
  const failedTargetButton = view.getByRole('button', { name: 'Refresh session capabilities' })
  expect(failedTargetButton.disabled).toBe(true)
  expect(within(view.getByRole('region', { name: SETTINGS_COPY.en['capabilities.applyGroup'] }))
    .getByText(/Target read failed/)).not.toBeNull()
  fireEvent.click(failedTargetButton)
  await runtime.flush()
  expect(execute).toHaveBeenCalledTimes(1)
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
  expect(selector.textContent).toContain('Legacy settings (not migrated)')
  expect(view.queryByRole('switch', { name: 'Allow redeclarations and overrides' })).toBeNull()
  expect(view.getByRole('switch', { name: 'Allow top-level variable redeclarations' }).checked)
    .toBe(legacy.looseTopLevelRedeclarations ?? value.looseTopLevelRedeclarations)
  expect(settings.mutate).not.toHaveBeenCalled()
  expect(settings.set).not.toHaveBeenCalled()
  await chooseCapabilityOption(view, 'Allow redeclarations and overrides', SETTINGS_COPY.en[`bindingPolicy.${policy}`])
  await runtime.flush()
  expect(selector.disabled).toBe(true)
  expect(selector.textContent).toContain('Legacy settings (not migrated)')
  expect(settings.mutate).toHaveBeenCalledWith([
    { op: 'set', path: ['bindingUpdates'], value: policy },
    { op: 'set', path: ['legacyBindingSettings'], value: false },
  ])
  fireEvent.click(selector)
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
  expect(selector.textContent).toContain('沿用旧版设置（尚未迁移）')
  expect(selector.disabled).toBe(true)
  fireEvent.click(selector)
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
  const list = vi.fn(async () => ({ ok: true, value: [{ name: 'binding' }, { name: 'capabilities' }] }))
  const { runtime, remote, input, feature, settings, value } = await fixture({ commands: { list } })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(2)
  expect(list).toHaveBeenLastCalledWith('client-session')
  const entry = runtime.slots.entries('conversation.input.left')[0]
  const source = entry.inject('client-session').hooks.bindingCommand
  const capabilitySource = entry.inject('client-session').hooks.capabilityCommand
  expect(entry.inject('client-session').hooks.bindingCommand).toBe(source)
  expect(entry.inject('client-session').hooks.capabilityCommand).toBe(capabilitySource)
  expect(capabilitySource).not.toBe(source)
  expect(capabilitySource.getSnapshot()).toBe(true)
  const release = source.subscribe(() => {})
  const releaseCapability = capabilitySource.subscribe(() => {})
  expect(list).toHaveBeenCalledTimes(2)
  fireEvent.click(view.getByRole('button', { name: 'Global bindings' }))
  await runtime.flush()
  view.container.querySelector('.ptcPlusComposerBindingAnchor').getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  expect(input.scope.getSnapshot().draft).toBe('/binding new ')
  release()
  releaseCapability()
  await runtime.sessions.setCurrent(undefined)
  const before = list.mock.calls.length
  remote.emit('commands/change', [])
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(before)
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(list).toHaveBeenCalledTimes(before + 2)
  expect(entry.inject('client-session').hooks.bindingCommand).toBe(source)
  expect(entry.inject('client-session').hooks.capabilityCommand).toBe(capabilitySource)
  list.mockResolvedValue({ ok: true, value: [] })
  runtime.ctx.emit('connection/reset')
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Global bindings' }))
  await runtime.flush()
  expect(view.queryByRole('menuitem', { name: 'Write a new binding' })).toBeNull()
  expect(view.getByRole('menuitem', { name: 'Refresh session capabilities' }).disabled).toBe(true)
  expect(capabilitySource.getSnapshot()).toBe(false)
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
  expect(document.querySelector('.ptcPlusBindingDock .ptcPlusAuthoringDraft')).not.toBeNull()
  revoked = true
  await vi.advanceTimersByTimeAsync(1500)
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock .ptcPlusAuthoringDraft')).not.toBeNull()
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

test('conversation slots stay independent while binding events follow public uiConversation lifetime', async () => {
  const { runtime, events, settings, provideConversation } = await fixture({ conversation: false })
  expect(events.entries().map(entry => entry.kind)).toEqual([])
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
  const view = runtime.renderRoot()
  expect(view.container.textContent).toContain('PTC Plus')
  const provider = await provideConversation()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
  expect(events.entries().map(entry => entry.kind)).toEqual(['ptc-plus-binding-toggle'])
  await provider.dispose()
  expect(events.entries().map(entry => entry.kind)).toEqual([])
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
  expect(view.container.textContent).toContain('PTC Plus')
  await provideConversation()
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
  settings.publish({ value: { enabled: false, userBindingsEnabled: true } })
  await runtime.flush()
  expect(events.entries().map(entry => entry.kind)).toEqual(['ptc-plus-binding-toggle'])
})

test('legacy conversation registry cannot substitute for uiConversation event ownership', async () => {
  const { runtime, events } = await fixture({ conversation: false })
  runtime.ctx.provide('conversationEvents', events)
  await runtime.flush()
  const view = runtime.renderRoot()
  expect(view.container.querySelector('.ptcPlusCard')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusActive')).not.toBeNull()
  expect(events.entries().map(entry => entry.kind)).toEqual([])
  expect(runtime.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.commandview').map(entry => entry.options.key).sort()).toEqual(['binding', 'capabilities'])
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

async function openGlobalMenu(view, runtime, mode = 'hover', expandDisabled = true) {
  const trigger = view.container.querySelector('.ptcPlusAuthorButton')
  trigger.closest('.ptcPlusComposerBindingAnchor').getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  if (mode === 'hover') await hoverOpenMenu(view, trigger)
  else fireEvent.click(trigger)
  await runtime.flush()
  // Existing catalog-operation scenarios choose a disabled row after opening
  // its group. Group-default scenarios pass false and assert the closed state.
  const group = view.queryByRole('menuitem', { name: /^(?:›|⌄)?\s*Disabled \(/ })
  if (expandDisabled && group?.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(group)
    await runtime.flush()
  }
  return trigger
}

/**
 * The Menu line that predates the `children` region: it renders the caller's
 * rows and the pinned footer rows and mounts nothing for a `children` prop.
 */
function menuWithoutChildren(ui) {
  const row = (entry, onSelect) => entry.type === 'label'
    ? React.createElement('div', { key: entry.id, role: 'presentation' }, entry.text)
    : entry.type === 'separator'
      ? React.createElement('div', { key: entry.id, role: 'separator' })
      : React.createElement('button', {
        key: entry.id, type: 'button', role: 'menuitem', disabled: entry.disabled,
        onClick: () => onSelect(entry.id),
      }, entry.label)
  return {
    ...ui,
    Menu: ({ open, anchor, items = [], footer = [], onSelect }) => React.createElement('span', null,
      anchor,
      open ? React.createElement('div', { role: 'menu' },
        [...items, ...footer].map(entry => row(entry, onSelect))) : null),
  }
}

test('a Menu line without a children region keeps binding, refresh and settings actions reachable', async () => {
  const { runtime, input } = await fixture({
    ui: menuWithoutChildren(primitives),
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async endpoint => ({ ok: true, value: endpoint === 'list'
      ? { revision: 1, entries: [reviewCandidate('menuRow').entry] }
      : null }),
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  // The probe reads mounted output, so the answered Client keeps the hidden
  // probe out of its own surface.
  expect(view.container.querySelector('.ptcPlusMenuProbe')).toBeNull()
  await openGlobalMenu(view, runtime)
  const rows = ['Write a new binding', 'Revise a binding', 'Manage global bindings', 'Refresh session capabilities', 'PTC Plus settings']
  for (const name of rows) expect(view.getByRole('menuitem', { name })).not.toBeNull()
  // The fallback carries the plugin's own grouped grid, not host-styled rows.
  const actions = document.querySelector('.ptcPlusFallbackMenuList .ptcPlusMenuActions')
  expect(actions).not.toBeNull()
  expect([...actions.querySelectorAll('.ptcPlusMenuAuthoring [role=menuitem]')].map(node => node.textContent))
    .toEqual(['Write a new binding', 'Revise a binding'])
  expect([...actions.querySelectorAll('.ptcPlusMenuUtilities [role=menuitem]')].map(node => node.textContent))
    .toEqual(['Refresh session capabilities', 'Manage global bindings', 'Session capability controls', 'PTC Plus settings'])
  expect(view.getByRole('menuitem', { name: 'PTC Plus settings' })
    .querySelector('.ptcPlusBindingMenuAction').getAttribute('title'))
    .toBe('Settings → Plugin configuration → PTC Plus')
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  expect(input.scope.getSnapshot().draft).toBe('/binding new ')
})

test('the hosted Menu carries each composer action once', async () => {
  const { runtime } = await fixture({
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async endpoint => ({ ok: true, value: endpoint === 'list' ? { revision: 1, entries: [] } : null }),
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime)
  // The region is the only carrier while the Client renders it: the pinned rows
  // must not duplicate actions.
  expect(view.getAllByRole('menuitem', { name: 'Write a new binding' })).toHaveLength(1)
  expect(view.getAllByRole('menuitem', { name: 'Manage global bindings' })).toHaveLength(1)
  expect(view.getAllByRole('menuitem', { name: 'PTC Plus settings' })).toHaveLength(1)
})

test('the authoring entry opens the complete settings dialog from every host seat', async () => {
  for (const [seat, path] of [
    ['legacy', 'Settings → Plugin configuration → PTC Plus'],
    ['row', 'Side bar Plugins → dsh-ptc-plus → row ptc-plus → Configure'],
    ['page', 'PTC Plus settings'],
  ]) {
    const { runtime } = await fixture({
      settingsCardSeat: seat,
      rpc: async endpoint => ({ ok: true, value: endpoint === 'list' ? { revision: 1, entries: [] } : null }),
    })
    const view = runtime.renderRoot()
    await runtime.flush()
    const trigger = await openGlobalMenu(view, runtime)
    const item = view.getByRole('menuitem', { name: 'PTC Plus settings' })
    expect(item.querySelector('.ptcPlusBindingMenuAction').getAttribute('title')).toBe(path)
    fireEvent.click(item)
    await runtime.flush()
    expect(view.queryByRole('menu')).toBeNull()
    const dialog = view.getByRole('dialog', { name: 'PTC Plus settings' })
    expect(dialog.querySelector('[aria-label="Allow redeclarations and overrides"]')).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.budgets'] }))
    await runtime.flush()
    expect(dialog.querySelector(`[aria-label="${SETTINGS_COPY.en['capabilities.observationSession']}"]`)).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
    await runtime.flush()
    expect(dialog.querySelector(`[aria-label="${SETTINGS_COPY.en['capabilities.targetSession']}"]`)).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.manual'] }))
    await runtime.flush()
    expect(dialog.querySelector('[aria-label="Saved disclosure"]')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Filter', exact: true }))
    expect(dialog.querySelector('[aria-label="Saved disclosure"]')).not.toBeNull()
    expect(dialog.querySelector('textarea')).toBeNull()
    expect(dialog.querySelector('.ptcPlusHeader')).toBeNull()
    expect(dialog.querySelector('.ptcPlusSettingsDialog')).not.toBeNull()
    const capabilityHeading = dialog.querySelector('#ptc-plus-settings-dialog-group-capabilities')
    const scroller = dialog.querySelector('.ptcPlusFields')
    capabilityHeading.getBoundingClientRect = () => new DOMRect(0, 500, 200, 20)
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
    scroller.style.height = '500px'
    scroller.style.padding = '0'
    scroller.style.border = '0'
    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 600, 500)
    scroller.scrollTop = 40
    fireEvent.click(dialog.querySelector('.ptcPlusSettingsNav [data-experimental=true]'))
    expect(scroller.scrollTop).toBe(424)
    expect(dialog.querySelector('.ptcPlusSettingsDialogContent').scrollTop).toBe(0)
    expect(dialog.querySelector('.ptcPlusSettingsHero')).toBeNull()
    expect(dialog.querySelector('.ptcPlusSettingsNav [aria-current=location]').dataset.section).toBe('capabilities')
    expect(dialog.querySelector('.ptcPlusSettingsDialogHead h2').textContent).toBe('PTC Plus settings')
    const ids = [...view.container.querySelectorAll('[id]'), ...dialog.querySelectorAll('[id]')]
      .map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(document.body.textContent).not.toContain(`PTC Plus settings: ${path}`)
    expect(document.activeElement).toBe(dialog.querySelector('[role=switch][aria-label="Enable PTC Plus"]'))
    const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[href],[tabindex]:not([tabindex="-1"]),[contenteditable=true],summary')].filter(element => !element.closest('[hidden],[aria-hidden=true]'))
    controls[0].focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(controls.at(-1))
    controls.at(-1).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(controls[0])
    const manage = [...dialog.querySelectorAll('button')]
      .find(button => button.textContent === 'Manage global bindings')
    manage.getClientRects = () => [new DOMRect(20, 20, 120, 28)]
    fireEvent.click(manage)
    await runtime.flush()
    expect(view.getByRole('dialog', { name: 'Global User Bindings' })).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await runtime.flush()
    expect(view.queryByRole('dialog', { name: 'Global User Bindings' })).toBeNull()
    expect(view.getByRole('dialog', { name: 'PTC Plus settings' })).toBe(dialog)
    expect(document.activeElement).toBe(manage)
    fireEvent.click(view.getByRole('button', { name: 'Close PTC Plus settings' }))
    await runtime.flush()
    expect(view.queryByRole('dialog', { name: 'PTC Plus settings' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  }
})

test('the settings dialog falls back to its close button when the form has no enabled control', async () => {
  const snapshot = { status: 'ready', writable: false, value: { enabled: true, userBindingsEnabled: false } }
  const { PTCPlusSettingsDialog } = createPtcSettingsView(React, {
    ActionButton: props => React.createElement('button', props),
    BindingsDialog: () => null,
    Modal: primitives.Modal, Select: createSelect(React),
    useWorkbenchController: () => null,
    icons: { chevron: primitives.IconChevronDownOutline14 },
  })
  const view = render(React.createElement(PTCPlusSettingsDialog, {
    t: key => key,
    usePtcSettings: select => select(snapshot),
    updateSetting: async () => null,
    callUserBindings: async () => null,
    onClose: () => {},
  }))
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'settings.close' }))
  view.unmount()
})

test('capability settings use searchable choices and validated statistics while preserving frozen and unavailable selections', async () => {
  const snapshot = { status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: false, capabilityManagementEnabled: true,
    capabilityBaseline: '["tools.missing"]', capabilityOverrides: '{"tools.missing":"full"}',
    capabilityStatistics: '{"enabled":true,"windowSize":10,"minimumSamples":10,"fullThreshold":0.5}' } }
  const updateSetting = vi.fn(async (key, value) => { snapshot.value[key] = value; return 'status.applied' })
  const inspectCapabilityPlans = vi.fn(async () => [{ sessionId: 'frozen-session', pendingRefresh: true,
    effective: { budgets: { contractBytes: 234, overageBytes: 12 }, entries: [{ id: 'tools.probe',
      selection: 'on-demand', reason: 'manual', statisticsReason: 'statistics-disabled',
      evidence: { used: 2, eligible: 3, scope: 'workspace' } }] } }])
  const inspectCapabilityCatalog = vi.fn(async () => [{ id: 'tools.probe', category: 'tool', description: 'Read project files' },
    { id: 'skills.research', category: 'skill', description: 'Look up online references' }])
  const { PTCPlusSettingsCard } = createPtcSettingsView(React, {
    ActionButton: props => React.createElement('button', props), BindingsDialog: () => null,
    Select: createSelect(React),
    useWorkbenchController: () => null, inspectCapabilityPlans, inspectCapabilityCatalog, icons: {},
  })
  const t = (key, params = {}) => (SETTINGS_COPY.en[key] ?? key)
    .replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token)
  const view = render(React.createElement(PTCPlusSettingsCard, { t, view: 'page',
    usePtcSettings: select => select(snapshot), updateSetting }))
  await act(async () => {})
  expect(view.container.textContent).toContain('Saved settings await refresh')
  expect(view.container.textContent).toContain('234')
  expect(view.container.querySelectorAll('textarea')).toHaveLength(0)
  const search = view.getByRole('searchbox', { name: t('capabilities.search') })
  expect(search.getAttribute('placeholder')).toBe(t('capabilities.search'))
  expect(search.closest('.ptcPlusSearch').querySelector('svg[aria-hidden=true]')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusCapabilityPlans').closest('[data-experimental=true]')).not.toBeNull()
  fireEvent.change(search, { target: { value: 'project files' } })
  expect(view.queryByLabelText('Disclosure for skills.research')).toBeNull()
  await chooseCapabilityOption(view, 'Availability for tools.probe', 'Closed')
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).items).toEqual({ 'tools.missing': { disclosure: 'full' }, 'tools.probe': { availability: 'closed' } })
  fireEvent.click(view.getByLabelText('Include tools.probe in common baseline'))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityBaseline)).toEqual(['tools.missing', 'tools.probe'])
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }))
  const window = view.getByLabelText('Sample window (session families)')
  const minimum = view.getByLabelText('Minimum samples')
  const threshold = view.getByLabelText('Full disclosure threshold (%)')
  fireEvent.change(window, { target: { value: '5' } })
  fireEvent.blur(window)
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityStatistics)).toEqual({ enabled: true, windowSize: 10, minimumSamples: 10, fullThreshold: 0.5 })
  expect(view.container.textContent).toContain('minimum cannot exceed window')
  fireEvent.click(view.getAllByRole('switch', { name: 'Collect usage statistics' })[0])
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityStatistics)).toEqual({ enabled: false, windowSize: 10, minimumSamples: 10, fullThreshold: 0.5 })
  fireEvent.change(minimum, { target: { value: '3' } })
  fireEvent.blur(minimum)
  await act(async () => {})
  fireEvent.change(threshold, { target: { value: '65' } })
  fireEvent.blur(threshold)
  await act(async () => {})
  fireEvent.click(view.container.querySelector('input[aria-label="Collect usage statistics"]'))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityStatistics)).toEqual({ enabled: true, windowSize: 10, minimumSamples: 3, fullThreshold: 0.65 })
  fireEvent.click(view.getByRole('tab', { name: 'Capabilities' }))
  fireEvent.change(search, { target: { value: '' } })
  expect(view.container.querySelector('[data-availability=unavailable]').textContent).toContain('Unavailable')
  await chooseCapabilityOption(view, 'Disclosure for tools.missing', 'Use parent rules')
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).items).toEqual({ 'tools.probe': { availability: 'closed' } })
  const reads = inspectCapabilityPlans.mock.calls.length
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  fireEvent.click(view.getByRole('button', { name: 'Reload plans' }))
  await act(async () => {})
  expect(inspectCapabilityPlans).toHaveBeenCalledTimes(reads + 1)
  expect(inspectCapabilityCatalog).toHaveBeenCalledTimes(reads + 1)
  view.unmount()
})

test('session plans follow capability management and plugin switches while manual choices retain their catalog', async () => {
  const delayed = deferred()
  const plan = sessionId => ({ sessionId, pendingRefresh: false,
    effective: { budgets: { contractBytes: 234, overageBytes: 0 }, entries: [{ id: 'tools.probe',
      selection: 'on-demand', reason: 'manual', statisticsReason: 'statistics-disabled' }] } })
  let requests = 0
  const { runtime, settings, value, capabilityRpcCalls } = await fixture({
    enabled: false, settingsCardSeat: 'row',
    capabilityRpc: async endpoint => {
      if (endpoint === 'catalog') return { ok: true, value: [{ id: 'tools.probe', category: 'tool', description: 'Probe owner' }] }
      if (endpoint === 'targets') return { ok: true, value: [] }
      expect(endpoint).toBe('inspect')
      requests += 1
      return requests === 2 ? delayed.promise : { ok: true, value: [plan(`frozen-${requests}`)] }
    },
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  const reload = () => view.queryByRole('button', { name: 'Reload plans' })
  const plans = () => view.container.querySelector('.ptcPlusCapabilityPlans')
  expect(reload()).toBeNull()
  expect(capabilityRpcCalls).toHaveLength(0)

  settings.publish({ value: { ...value, enabled: true, capabilityManagementEnabled: false } })
  await runtime.flush()
  expect(reload()).toBeNull()
  expect(requests).toBe(0)
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: tools.probe' }))
  expect(view.getByLabelText('Disclosure for tools.probe').disabled).toBe(false)
  expect(capabilityRpcCalls.map(call => call.endpoint)).toEqual(['targets', 'catalog'])

  settings.publish({ value: { ...value, enabled: true, capabilityManagementEnabled: true } })
  await runtime.flush()
  expect(plans().closest('[data-experimental=true]')).not.toBeNull()
  expect(plans().textContent).toContain('frozen-1')
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  fireEvent.click(reload())
  await runtime.flush()
  expect(requests).toBe(2)
  const pendingRead = capabilityRpcCalls.filter(call => call.endpoint === 'inspect').at(-1)
  settings.publish({ value: { ...value, enabled: true, capabilityManagementEnabled: false } })
  await runtime.flush()
  expect(plans()).toBeNull()
  expect(pendingRead.signal.aborted).toBe(true)
  await act(async () => delayed.resolve({ ok: true, value: [plan('late-plan')] }))
  await runtime.flush()
  expect(view.container.textContent).not.toContain('late-plan')
  expect(view.getByLabelText('Disclosure for tools.probe').disabled).toBe(false)

  settings.publish({ value: { ...value, enabled: true, capabilityManagementEnabled: true } })
  await runtime.flush()
  expect(plans().textContent).toContain('frozen-3')
  settings.publish({ value: { ...value, enabled: false, capabilityManagementEnabled: true } })
  await runtime.flush()
  expect(plans()).toBeNull()
  const reads = capabilityRpcCalls.length
  await runtime.flush()
  expect(capabilityRpcCalls).toHaveLength(reads)
  settings.publish({ value: { ...value, enabled: true, capabilityManagementEnabled: true } })
  await runtime.flush()
  expect(plans().textContent).toContain('frozen-4')
  view.unmount()
})

test('capability controls preserve manual selections on catalog failure and repair unusable statistics without JSON entry', async () => {
  const snapshot = { status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: false,
    capabilityBaseline: '["tools.saved"]', capabilityOverrides: '{"tools.saved":"full"}', capabilityStatistics: 'invalid' } }
  const updateSetting = vi.fn(async (key, value) => { snapshot.value[key] = value; return 'status.applied' })
  const { PTCPlusSettingsCard } = createPtcSettingsView(React, {
    ActionButton: props => React.createElement('button', props), BindingsDialog: () => null, Select: createSelect(React), useWorkbenchController: () => null, icons: {},
    inspectCapabilityPlans: async () => [], inspectCapabilityCatalog: async () => { throw new Error('Owner unavailable') },
  })
  const t = (key, params = {}) => (SETTINGS_COPY.en[key] ?? key)
    .replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token)
  const view = render(React.createElement(PTCPlusSettingsCard, { t, view: 'page',
    usePtcSettings: select => select(snapshot), updateSetting }))
  await act(async () => {})
  expect(view.container.textContent).toContain('Owner unavailable')
  expect(view.container.textContent).toContain('Saved statistics are unusable')
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: tools.saved' }))
  expect(view.getByRole('combobox', { name: 'Disclosure for tools.saved' }).textContent).toContain('Full contract')
  expect(updateSetting).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }))
  fireEvent.click(view.container.querySelector('input[aria-label="Collect usage statistics"]'))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityStatistics).enabled).toBe(true)
  expect(snapshot.value.capabilityOverrides).toBe('{"tools.saved":"full"}')
  expect(view.container.textContent).not.toContain('Saved statistics are unusable')
  view.unmount()
})

async function capabilityWorkbenchFixture({ catalog, plans = [], baseline = [], overrides = {}, catalogReader, configuration = {}, allocationReader, locale = 'en' } = {}) {
  const snapshot = { status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: false,
    capabilityManagementEnabled: true, capabilityBaseline: JSON.stringify(baseline), capabilityOverrides: JSON.stringify(overrides), ...configuration } }
  const updateSetting = vi.fn(async (key, value) => { snapshot.value[key] = value; return 'status.applied' })
  const updateCapabilityConfiguration = vi.fn(async next => { Object.assign(snapshot.value, next); return 'status.applied' })
  const inspectCapabilityCatalog = vi.fn(catalogReader ?? (async () => catalog))
  const { PTCPlusSettingsCard } = createPtcSettingsView(React, {
    ActionButton: props => React.createElement('button', props), BindingsDialog: () => null,
    Select: createSelect(React),
    useWorkbenchController: () => null, icons: {}, inspectCapabilityCatalog, inspectCapabilityPlans: async () => plans,
    inspectCapabilityAllocation: allocationReader, inspectCapabilityTargets: allocationReader ? async () => plans.map(plan => ({ sessionId: plan.sessionId })) : undefined,
    CapabilityRefreshButton: allocationReader ? () => React.createElement('button', null, 'Refresh observation target') : undefined,
  })
  const t = (key, params = {}) => (SETTINGS_COPY[locale][key] ?? key)
    .replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token)
  const element = () => React.createElement(PTCPlusSettingsCard, { t, view: 'page',
    usePtcSettings: select => select(snapshot), updateSetting, updateCapabilityConfiguration })
  const view = render(element())
  await act(async () => {})
  const ids = () => [...view.container.querySelectorAll('.ptcPlusCapabilityIdentity code')].map(item => item.textContent)
  return { view, ids, snapshot, updateSetting, updateCapabilityConfiguration, inspectCapabilityCatalog, rerender: () => view.rerender(element()) }
}

test('capability filters reconcile source and type while advanced filters open only on request', async () => {
  const { view, ids } = await capabilityWorkbenchFixture({ catalog: [
    { id: 'tools.read', name: 'Read', category: 'tool', source: { kind: 'host' } },
    { id: 'skills.research', name: 'Research', category: 'skill', source: { kind: 'skill', bucket: 'user-agents', provider: 'filesystem' } },
    { id: 'tools.mcp__docs__search', name: 'Search', category: 'tool', source: { kind: 'mcp', server: 'docs' } },
  ] })
  expect(view.container.querySelector('.ptcPlusCapabilityTypes')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusCapabilityFilterFields')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Filter', exact: true }))
  expect(view.container.querySelector('details.ptcPlusCapabilityFilters')).toBeNull()
  const source = view.getByLabelText('Capability source')
  await chooseCapabilityOption(view, 'Capability source', 'User skill (.agents) · filesystem')
  expect(ids()).toEqual(['skills.research'])
  await chooseCapabilityOption(view, 'Capability types', 'Tools')
  expect(source.textContent).toContain('All sources')
  expect(ids()).toEqual(['tools.read'])
  await chooseCapabilityOption(view, 'Capability types', 'MCP')
  expect(ids()).toEqual(['tools.mcp__docs__search'])
  view.unmount()
})

test('capability usage and budget panes observe selected workspace evidence and discard obsolete projections', async () => {
  const stale = deferred()
  const base = { sessionId: 'session-a', pendingRefresh: false, effective: { budgets: { contractBytes: 10, overageBytes: 0 }, entries: [] } }
  const reader = vi.fn((payload, signal) => reader.mock.calls.length === 1 ? stale.promise : Promise.resolve({
    sessionId: payload.sessionId, workspace: '/current-workspace', configuration: payload.configuration,
    plan: { enabled: true, budgets: { contractBytes: 160, directoryBytes: 20, overageBytes: 0 },
      entries: [{ id: 'tools.read', selection: 'full', reason: 'statistical-coverage' }] },
    coverage: { 'tools.read': { workspace: { status: 'usable', eligible: 12, used: 9, coverage: .75 }, global: { status: 'incomplete-window', eligible: null, used: null, coverage: null } } },
    capabilities: [{ id: 'tools.read', contractBytes: 100 }],
  }))
  const { view, snapshot, rerender } = await capabilityWorkbenchFixture({ catalog: [], plans: [base, { ...base, sessionId: 'session-b' }], allocationReader: reader })
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }))
  await chooseCapabilityOption(view, 'Observation session', 'session-a')
  await act(async () => {})
  await chooseCapabilityOption(view, 'Observation session', 'session-b')
  await act(async () => {})
  expect(reader.mock.calls[0][1].aborted).toBe(true)
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }))
  const usage = view.getByRole('region', { name: 'Observed usage' })
  expect([...usage.querySelectorAll('tbody td')].map(cell => cell.textContent)).toEqual(['tools.read', '9', '12', '75%'])
  await chooseCapabilityOption(view, 'Statistics scope', 'All workspaces')
  expect(usage.textContent).toContain('Incomplete window evidence')
  expect([...usage.querySelectorAll('tbody td')].slice(1, 3).map(cell => cell.textContent)).toEqual(['—', '—'])
  fireEvent.click(view.getByRole('tab', { name: 'Context' }))
  fireEvent.click(view.getByText(SETTINGS_COPY.en['capabilities.budgetPreview'], { selector: 'summary' }))
  expect(view.getByRole('region', { name: 'Current allocation preview' }).textContent).toContain('/current-workspace')
  expect(view.getByRole('progressbar').value).toBe(160)
  await act(async () => stale.resolve({ sessionId: 'obsolete' }))
  expect(view.container.textContent).not.toContain('obsolete')
  snapshot.value.enabled = false; rerender()
  await act(async () => {})
  expect(view.container.querySelector('.ptcPlusAllocationEvidence')).toBeNull()
  view.unmount()
})

test.each(['zh', 'en'])('capability statistics preserve proven zero counts and show no samples in %s', async locale => {
  const copy = SETTINGS_COPY[locale]
  const allocationReader = async payload => ({
    sessionId: payload.sessionId, workspace: '/empty-workspace', configuration: payload.configuration,
    plan: { enabled: true, budgets: {}, entries: [] },
    coverage: { 'tools.empty': { workspace: { status: 'usable', eligible: 0, used: 0, coverage: null } } },
    capabilities: [{ id: 'tools.empty', contractBytes: 10 }],
  })
  const { view } = await capabilityWorkbenchFixture({ catalog: [], locale,
    plans: [{ sessionId: 'empty-session', effective: { budgets: { contractBytes: 0, overageBytes: 0 }, entries: [] } }], allocationReader })
  fireEvent.click(view.getByRole('tab', { name: copy['capabilities.tab.statistics'] }))
  await chooseCapabilityOption(view, copy['capabilities.observationSession'], 'empty-session')
  await act(async () => {})
  const evidence = view.getByRole('region', { name: copy['capabilities.observedUsage'] })
  expect([...evidence.querySelectorAll('tbody td')].map(cell => cell.textContent))
    .toEqual(['tools.empty', '0', '0', copy['capabilities.statStatus.no-samples']])
  expect(evidence.querySelector('progress')).toBeNull()
  view.unmount()
})

test.each(['zh', 'en'])('saved capability configuration displays compatible categories and preview units in %s', async locale => {
  const { capabilityProfileConfiguration } = await import('../internal/runtime-config.js')
  const copy = SETTINGS_COPY[locale]
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.categories = { task: { availability: 'closed' }, 'resource-template': { disclosure: 'full' } }
  const configuration = capabilityProfileConfiguration({ capabilityPolicy: JSON.stringify(policy),
    modelPreviewEnabled: true, modelPreviewTokens: 4321 })
  const library = { schema: 'ptc-capability-profiles/v1', profiles: [{ id: 'legacy', name: 'Legacy', configuration }] }
  const { view, snapshot } = await capabilityWorkbenchFixture({ catalog: [], locale,
    configuration: { capabilityProfiles: JSON.stringify(library) } })
  fireEvent.click(view.getByRole('tab', { name: copy['capabilities.tab.plans'] }))
  fireEvent.click(view.getByRole('button', { name: 'Legacy' }))
  const details = view.getByText(copy['capabilities.profileDetails'], { selector: 'summary' }).parentElement
  fireEvent.click(details.querySelector('summary'))
  expect(details.textContent).toContain(copy['capabilities.policy.category.task'])
  expect(details.textContent).toContain(copy['capabilities.policy.category.resource-template'])
  expect(details.textContent).not.toContain('capabilities.policy.category.')
  const previewSummary = view.getByText(copy['capabilities.previewEnabled'], { selector: '.ptcPlusConfigurationSummaryRow > span' }).nextElementSibling
  expect(previewSummary.textContent).toContain(locale === 'zh' ? '约 4321 token' : '4321 estimated tokens')
  fireEvent.click(view.getByRole('button', { name: copy['capabilities.applyConfiguration'] }))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).categories).toEqual(policy.categories)
  expect(JSON.parse(snapshot.value.capabilityProfiles)).toEqual(library)
  view.unmount()
})

test('named capability configurations save rename switch and copy frozen settings without changing a session', async () => {
  const { capabilityProfileConfiguration } = await import('../internal/runtime-config.js')
  const frozen = capabilityProfileConfiguration({ capabilityBaseline: '["tools.old"]', capabilityBudgetBytes: 512, capabilityManagementEnabled: true })
  const plan = { sessionId: 'old-session', configuration: frozen, effective: { budgets: { contractBytes: 10, overageBytes: 0 }, entries: [] } }
  const { view, snapshot, updateCapabilityConfiguration } = await capabilityWorkbenchFixture({ catalog: [], plans: [plan] })
  const before = JSON.stringify(plan)
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  expect(view.getAllByRole('button', { name: 'Save current settings' })).toHaveLength(1)
  fireEvent.click(view.getByRole('button', { name: 'Save current settings' }))
  const name = view.getByLabelText('Configuration name')
  fireEvent.change(name, { target: { value: 'Daily' } })
  fireEvent.click(view.getByRole('button', { name: 'Save', exact: true }))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityProfiles).profiles[0].name).toBe('Daily')
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Save current settings' }))
  fireEvent.click(view.getByLabelText('More configuration actions'))
  fireEvent.click(view.getByRole('button', { name: 'Rename', exact: true }))
  fireEvent.change(view.getByLabelText('New configuration name'), { target: { value: 'Research' } })
  fireEvent.click(view.getByRole('button', { name: 'Confirm rename' }))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityProfiles).profiles[0].name).toBe('Research')
  fireEvent.click(view.getByLabelText('More library actions'))
  fireEvent.click(view.getByRole('button', { name: 'Copy configuration from a session' }))
  fireEvent.change(view.getByLabelText('Copied configuration name'), { target: { value: 'From session' } })
  await chooseCapabilityOption(view, 'Copy configuration from a session', 'old-session')
  fireEvent.click(view.getByRole('button', { name: 'Save this session’s configuration' }))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityProfiles).profiles).toHaveLength(2)
  fireEvent.click(view.getByRole('button', { name: 'Apply to saved settings' }))
  await act(async () => {})
  expect(updateCapabilityConfiguration).toHaveBeenCalledTimes(1)
  expect(updateCapabilityConfiguration.mock.calls[0][0]).toEqual(frozen)
  expect(snapshot.value.capabilityBudgetBytes).toBe(512)
  expect(JSON.stringify(plan)).toBe(before)
  if (!view.getByLabelText('More configuration actions').parentElement.open) fireEvent.click(view.getByLabelText('More configuration actions'))
  fireEvent.click(view.getByRole('button', { name: 'Delete configuration' }))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityProfiles).profiles).toHaveLength(1)
  view.unmount()
})

test('switching a saved capability configuration uses one public settings mutation and rejects readback conflicts', async () => {
  const { capabilityProfileConfiguration, CAPABILITY_CONFIGURATION_KEYS } = await import('../internal/runtime-config.js')
  const configuration = capabilityProfileConfiguration({ capabilityBudgetBytes: 512, capabilityManagementEnabled: true,
    capabilityBaseline: '["tools.saved"]' })
  const { runtime, settings, value } = await fixture({ bindings: false })
  const initial = { ...value, capabilityProfiles: JSON.stringify({ schema: 'ptc-capability-profiles/v1',
    profiles: [{ id: 'saved', name: 'Saved', configuration }] }) }
  settings.publish({ value: initial })
  const pending = deferred()
  settings.mutate.mockImplementation(async operations => {
    await pending.promise
    const next = { ...settings.scope.getSnapshot().value }
    for (const operation of operations) next[operation.path[0]] = operation.value
    settings.publish({ value: next })
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  await runtime.flush()
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  await chooseCapabilityOption(view, 'Saved configurations', 'Saved')
  const apply = view.getByRole('button', { name: 'Apply to saved settings' })
  fireEvent.click(apply)
  await runtime.flush()
  expect(settings.mutate).toHaveBeenCalledExactlyOnceWith(CAPABILITY_CONFIGURATION_KEYS.map(key => ({ op: 'set', path: [key], value: configuration[key] })))
  expect(settings.set).not.toHaveBeenCalled()
  expect(apply.disabled).toBe(true)
  expect(settings.scope.getSnapshot().value.capabilityBudgetBytes).toBe(initial.capabilityBudgetBytes)
  pending.resolve()
  await runtime.flush()
  expect(settings.scope.getSnapshot().value.capabilityBudgetBytes).toBe(512)
  expect(settings.scope.getSnapshot().value.capabilityProfiles).toBe(initial.capabilityProfiles)
  settings.mutate.mockImplementation(async () => {})
  settings.publish({ value: initial })
  await runtime.flush()
  fireEvent.click(apply)
  await runtime.flush()
  expect(view.getByText('Capability configuration was not applied')).not.toBeNull()
  const feedback = () => view.container.querySelector('.ptcPlusCapabilityPane:not([hidden]) .ptcPlusCapabilitySaveState').textContent
  expect(feedback()).toBe('Could not save: Capability configuration was not applied')
  fireEvent.click(view.getByRole('switch', { name: 'Allow redeclarations and overrides' }))
  await runtime.flush()
  expect(feedback()).toBe('Could not save: Capability configuration was not applied')
  expect(settings.scope.getSnapshot().value.capabilityBudgetBytes).toBe(initial.capabilityBudgetBytes)
})

test('capability configuration file import merges named settings and refuses malformed or stale reads', async () => {
  const { capabilityProfileConfiguration } = await import('../internal/runtime-config.js')
  const configuration = capabilityProfileConfiguration({ capabilityBudgetBytes: 256 })
  const { view, snapshot, rerender, updateSetting, updateCapabilityConfiguration } = await capabilityWorkbenchFixture({ catalog: [] })
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  const input = view.container.querySelector('input[type=file]')
  const document = { schema: 'ptc-capability-profiles/v1', profiles: [{ id: 'imported', name: 'Imported', configuration }] }
  fireEvent.change(input, { target: { files: [{ size: 300, text: async () => JSON.stringify(document) }] } })
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityProfiles).profiles[0].configuration).toEqual(configuration)
  expect(updateCapabilityConfiguration).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { files: [{ size: 300, text: async () => JSON.stringify(document) }] } })
  await act(async () => {})
  const profiles = JSON.parse(snapshot.value.capabilityProfiles).profiles
  expect(profiles.map(profile => profile.name)).toEqual(['Imported', 'Imported (2)'])
  expect(new Set(profiles.map(profile => profile.id)).size).toBe(2)
  expect(profiles.every(profile => profile.id !== 'imported')).toBe(true)
  const malformedWrites = updateSetting.mock.calls.length
  fireEvent.change(input, { target: { files: [{ size: 10, text: async () => '{broken' }] } })
  await act(async () => {})
  expect(updateSetting).toHaveBeenCalledTimes(malformedWrites)
  const exported = []
  const createUrl = vi.fn(blob => { exported.push(blob); return 'blob:test' })
  const revoke = vi.fn()
  const previousCreate = URL.createObjectURL; const previousRevoke = URL.revokeObjectURL
  URL.createObjectURL = createUrl; URL.revokeObjectURL = revoke
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    fireEvent.click(view.getByLabelText('More library actions'))
    fireEvent.click(view.getByRole('button', { name: 'Export all configurations' }))
    expect(exported[0].type).toBe('application/json')
    const reader = new FileReader()
    const text = new Promise(resolve => { reader.onload = () => resolve(reader.result) })
    reader.readAsText(exported[0])
    expect(JSON.parse(await text)).toEqual(JSON.parse(snapshot.value.capabilityProfiles))
    expect(click).toHaveBeenCalledOnce()
  } finally { URL.createObjectURL = previousCreate; URL.revokeObjectURL = previousRevoke; click.mockRestore() }
  const pending = deferred()
  const writes = updateSetting.mock.calls.length
  fireEvent.change(input, { target: { files: [{ size: 300, text: () => pending.promise }] } })
  snapshot.writable = false; rerender()
  await act(async () => pending.resolve(JSON.stringify(document)))
  expect(updateSetting).toHaveBeenCalledTimes(writes)
  snapshot.writable = true; rerender()
  const unmounted = deferred()
  fireEvent.change(input, { target: { files: [{ size: 300, text: () => unmounted.promise }] } })
  view.unmount()
  await act(async () => unmounted.resolve(JSON.stringify(document)))
  expect(updateSetting).toHaveBeenCalledTimes(writes)
})

test.each(['readonly', 'plugin'])('capability configuration import remains retired after %s eligibility returns', async mode => {
  const { capabilityProfileConfiguration } = await import('../internal/runtime-config.js')
  const { view, snapshot, rerender, updateSetting } = await capabilityWorkbenchFixture({ catalog: [] })
  fireEvent.click(view.getByRole('tab', { name: SETTINGS_COPY.en['capabilities.tab.plans'] }))
  const pending = deferred()
  const document = { schema: 'ptc-capability-profiles/v1', profiles: [{ id: 'stale', name: 'Stale', configuration: capabilityProfileConfiguration({}) }] }
  fireEvent.change(view.container.querySelector('input[type=file]'), { target: { files: [{ size: 300, text: () => pending.promise }] } })
  if (mode === 'readonly') snapshot.writable = false
  else snapshot.value.enabled = false
  rerender(); await act(async () => {})
  snapshot.writable = true; snapshot.value.enabled = true
  rerender(); await act(async () => {})
  await act(async () => pending.resolve(JSON.stringify(document)))
  expect(updateSetting).not.toHaveBeenCalled()
  expect(JSON.parse(snapshot.value.capabilityProfiles ?? '{"profiles":[]}').profiles).toHaveLength(0)
  expect(view.getByRole('button', { name: 'Import' }).disabled).toBe(false)
  view.unmount()
})

test('capability workbench combines type, source, manual strategy, common and availability filters with stable sorting', async () => {
  const { view, ids, updateSetting } = await capabilityWorkbenchFixture({ baseline: ['skills.zebra'], overrides: { 'skills.zebra': 'full', 'tools.absent': 'closed' },
    catalog: [
      { id: 'tools.beta', name: 'Beta', category: 'tool', source: { kind: 'host' } },
      { id: 'skills.zebra', name: 'Zebra', category: 'skill', description: 'Generate images', source: { kind: 'skill', bucket: 'user-dsh', provider: 'filesystem' } },
      { id: 'skills.alpha', name: 'Alpha', category: 'skill', source: { kind: 'skill', bucket: 'project-dsh', provider: 'filesystem' } },
      { id: 'mcp.docs', name: 'Docs', category: 'resource', source: { kind: 'mcp', server: 'docs' } },
      { id: 'tools.extension', name: 'Extension', category: 'tool', source: { kind: 'mcp', server: 'github' } },
    ] })
  expect(ids()).toEqual(['tools.beta', 'mcp.docs', 'tools.extension', 'skills.alpha', 'skills.zebra', 'tools.absent'])
  expect(view.queryByText('Core execution environment')).toBeNull()
  expect(view.queryByLabelText('Disclosure for run_code')).toBeNull()
  await chooseCapabilityOption(view, 'Capability types', 'Skills')
  expect(ids()).toEqual(['skills.alpha', 'skills.zebra'])
  await chooseCapabilityOption(view, 'Capability source', 'User skill (.dsh) · filesystem')
  await chooseCapabilityOption(view, 'Saved disclosure', 'Full contract')
  fireEvent.click(view.getByLabelText('Common only'))
  expect(ids()).toEqual(['skills.zebra'])
  await chooseCapabilityOption(view, 'Availability', 'Currently unavailable')
  expect(ids()).toEqual([])
  fireEvent.click(view.getAllByRole('button', { name: 'Clear filters' })[0])
  await chooseCapabilityOption(view, 'Capability types', 'Skills')
  fireEvent.click(view.getByRole('button', { name: 'Sort ascending' }))
  expect(ids()).toEqual(['skills.zebra', 'skills.alpha'])
  await chooseCapabilityOption(view, 'Sort by', 'Exact ID')
  expect(ids()).toEqual(['skills.zebra', 'skills.alpha'])
  fireEvent.change(view.getByRole('searchbox'), { target: { value: 'generate images' } })
  expect(ids()).toEqual(['skills.zebra'])
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: skills.zebra' }))
  expect(view.getByRole('complementary').textContent).toContain('body loads only when used')
  expect(updateSetting).not.toHaveBeenCalled()
  view.unmount()
})

test('capability workbench separates saved preferences from each selected frozen session and restores only the override', async () => {
  const plan = (sessionId, selection, pendingRefresh) => ({ sessionId, pendingRefresh,
    effective: { budgets: { contractBytes: 100, overageBytes: 0 }, entries: [{ id: 'skills.images', category: 'skill', selection, reason: 'manual-override' }] } })
  const { view, snapshot, updateSetting } = await capabilityWorkbenchFixture({
    catalog: [{ id: 'skills.images', name: 'Images', category: 'skill', description: 'A complete routing description', source: { kind: 'skill', bucket: 'bundled', provider: 'shipped' } }],
    baseline: ['skills.images'], overrides: { 'skills.images': 'full' },
    plans: [plan('older', 'on-demand', true), plan('newer', 'closed', false)],
  })
  expect(view.queryByRole('complementary')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: skills.images' }))
  const details = view.getByRole('complementary')
  expect(details.textContent).toContain('Full contract')
  expect(view.getByLabelText('Inspect session').textContent).toContain('Choose a target session')
  await chooseCapabilityOption(view, 'Inspect session', 'older')
  expect(details.textContent).toContain('On demand')
  expect(details.textContent).toContain('Saved settings await refresh')
  await chooseCapabilityOption(view, 'Inspect session', 'newer')
  expect(details.textContent).toContain('Closed')
  expect(details.textContent).not.toContain('Saved settings await refresh')
  expect(view.getByLabelText('Disclosure for skills.images').textContent).toContain('Full contract')
  fireEvent.click(view.getByRole('button', { name: 'Restore automatic' }))
  await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).items).toEqual({})
  expect(JSON.parse(snapshot.value.capabilityBaseline)).toEqual(['skills.images'])
  expect(updateSetting).toHaveBeenCalledTimes(1)
  expect(view.getByLabelText('Inspect session').textContent).toContain('newer')
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }))
  expect(view.getByRole('switch', { name: 'Collect usage statistics' })).not.toBeNull()
  fireEvent.keyDown(view.getByRole('tab', { name: 'Statistics' }), { key: 'ArrowLeft' })
  expect(view.getByRole('tab', { name: 'Context', exact: true }).getAttribute('aria-selected')).toBe('true')
  expect(view.getByRole('tab', { name: 'Context' })).toBe(document.activeElement)
  view.unmount()
})

test('Skill preferences explain user-only loading without hiding the configurable entry', async () => {
  const { view, updateSetting } = await capabilityWorkbenchFixture({
    catalog: [{ id: 'skills.images', name: 'images', category: 'skill', description: 'Image design',
      invocation: { modelInvocable: false, userInvocable: true }, source: { kind: 'skill', bucket: 'bundled', provider: 'shipped' } }],
    overrides: { 'skills.images': 'full' },
  })
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: skills.images' }))
  expect(view.getByRole('complementary').textContent).toContain('Only users can invoke /images')
  expect(view.getByRole('complementary').textContent).toContain('model cannot load it with tools.skill')
  expect(view.getByLabelText('Disclosure for skills.images').textContent).toContain('Full contract')
  expect(updateSetting).not.toHaveBeenCalled()
  view.unmount()
})

test('Skill preferences explain eligibility conflicts without claiming model or user access', async () => {
  const { view } = await capabilityWorkbenchFixture({ catalog: [{ id: 'skills.images', name: 'images', category: 'skill',
    description: 'Image design', invocationConflict: true, source: { kind: 'skill', bucket: 'bundled', provider: 'shipped' } }] })
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: skills.images' }))
  const details = view.getByRole('complementary').textContent
  expect(details).toContain('Invocation eligibility varies by session')
  expect(details).not.toContain('Only users can invoke')
  expect(details).not.toContain('Only the model can load')
  view.unmount()
})

test('capability workbench retains last observed descriptions on catalog failure and permits saved unavailable preferences to be removed', async () => {
  let fails = false
  const { view, ids, snapshot, updateSetting } = await capabilityWorkbenchFixture({ baseline: ['tools.absent'], overrides: { 'tools.absent': 'full' },
    catalogReader: async () => { if (fails) throw new Error('Disconnected catalog'); return [{ id: 'tools.live', name: 'Live', category: 'tool', description: 'Retained owner description' }] },
  })
  await chooseCapabilityOption(view, 'Availability', 'Currently unavailable')
  expect(ids()).toEqual(['tools.absent'])
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: tools.absent' }))
  fireEvent.click(view.getByRole('button', { name: 'Remove saved preferences' }))
  await act(async () => {})
  expect(snapshot.value.capabilityBaseline).toBe('[]')
  expect(JSON.parse(snapshot.value.capabilityPolicy).items).toEqual({})
  expect(updateSetting.mock.calls.map(([key]) => key)).toEqual(['capabilityPolicy', 'capabilityBaseline'])
  fireEvent.click(view.getAllByRole('button', { name: 'Clear filters' })[0])
  fails = true
  fireEvent.click(view.getByRole('button', { name: 'Reload catalog' }))
  await act(async () => {})
  expect(view.container.textContent).toContain('Disconnected catalog')
  expect(ids()).toEqual(['tools.live'])
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: tools.live' }))
  fireEvent.click(view.getByText('View complete catalog description'))
  expect(view.getByText('Retained owner description')).not.toBeNull()
  await chooseCapabilityOption(view, 'Availability', 'Unconfirmed')
  expect(ids()).toEqual(['tools.live'])
  await chooseCapabilityOption(view, 'Availability', 'Currently unavailable')
  expect(ids()).toEqual([])
  view.unmount()
})

test('capability workbench keeps browsing available while write controls follow read-only and plugin disable', async () => {
  const { view, snapshot, updateSetting, rerender } = await capabilityWorkbenchFixture({ catalog: [{ id: 'tools.one', category: 'tool' }] })
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: tools.one' }))
  snapshot.writable = false
  rerender()
  expect(view.getByLabelText('Disclosure for tools.one').disabled).toBe(true)
  expect(view.getByLabelText('Include tools.one in common baseline').disabled).toBe(true)
  expect(view.container.querySelector('.ptcPlusCapabilityChoices [type=search]').disabled).toBe(false)
  snapshot.writable = true
  snapshot.value.enabled = false
  rerender()
  await act(async () => {})
  expect(view.queryByLabelText('Inspect session')).toBeNull()
  expect(view.getByRole('switch', { name: 'Enable PTC Plus' }).disabled).toBe(false)
  expect(updateSetting).not.toHaveBeenCalled()
  view.unmount()
})

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
  expect(view.queryByText('Global bindings · Applies to all sessions')).toBeNull()
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
  // A write in flight must not dim the list or insert a row: both read as the
  // popover flickering on every toggle. The source still drops the duplicate.
  expect(row.disabled).toBe(false)
  expect(view.getAllByRole('menuitem', { name: /toggle/ })).toHaveLength(1)
  expect(view.queryByText('Saving…')).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click')
  expect(view.getByRole('menuitem', { name: /toggle/ }).disabled).toBe(false)
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
  else {
    // A write in flight leaves the toggled row enabled, so the browser has no
    // reason to blur it; only the removed reload row needs that transition.
    expect(row.disabled).toBe(false)
    expect(document.activeElement).toBe(row)
  }
  // Chromium blurs a row it removes; JSDOM needs that browser transition explicitly.
  if (operation === 'reload') row.blur()
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
  fireEvent.click(view.getByRole('menuitem', { name: /Disabled \(1\)/ }))
  await runtime.flush()
  expect(view.getByRole('menuitem', { name: /repaired/ })).not.toBeNull()
  expect(view.queryByText(/Invalid bindings document/)).toBeNull()
  expect(rpc.mock.calls.at(-1)[0]).toBe('reload')
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'reload')).toHaveLength(1)
  expect(rpc.mock.calls.every(([endpoint]) => ['list', 'reload'].includes(endpoint))).toBe(true)
})

test.each(['native', 'fallback'])('%s sparkle menu groups a large catalog and defaults disabled entries to collapsed', async mode => {
  const entries = Array.from({ length: 48 }, (_, index) => ({
    ...reviewCandidate(`group-${index}`).entry, enabled: index % 3 === 0,
  }))
  const rpc = vi.fn(async () => ({ ok: true, value: { revision: 'r1', entries } }))
  const { runtime, setLocale } = await fixture({ rpc,
    ui: mode === 'native' ? primitives : { ...primitives, Menu: undefined },
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click', false)
  const menu = view.getByRole('menu')
  expect(view.queryByText('Global bindings · Applies to all sessions')).toBeNull()
  expect(view.getByText('Enabled (16)')).not.toBeNull()
  const group = view.getByRole('menuitem', { name: 'Disabled (32)' })
  expect(group.getAttribute('aria-expanded')).toBe('false')
  expect(menu.querySelectorAll('[data-binding-id]')).toHaveLength(16)
  expect(view.queryByRole('menuitem', { name: /group-1 Disabled/ })).toBeNull()
  group.focus()
  fireEvent.click(group)
  await runtime.flush()
  expect(group.getAttribute('aria-expanded')).toBe('true')
  expect(menu.querySelectorAll('[data-binding-id]')).toHaveLength(48)
  expect(document.activeElement).toBe(group)
  expect(rpc.mock.calls.every(([endpoint]) => endpoint === 'list')).toBe(true)
  setLocale('zh')
  await runtime.flush()
  expect(view.getByText('已启用（16）')).not.toBeNull()
  expect(view.getByRole('menuitem', { name: '停用（32）' }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(view.getByRole('menuitem', { name: '停用（32）' }))
  await runtime.flush()
  expect(menu.querySelectorAll('[data-binding-id]')).toHaveLength(16)
  fireEvent.click(view.getByRole('menuitem', { name: '修改绑定' }))
  await runtime.flush()
  expect(menu.querySelectorAll('.ptcPlusBindingMenuScroll .ptcPlusOwnedMenuRow')).toHaveLength(48)
  for (const entry of entries) {
    const row = within(menu).getByText(entry.name, { exact: true }).closest('button')
    expect(row.querySelector('.ptcPlusBindingQuickRow').getAttribute('data-enabled')).toBe(String(entry.enabled))
    expect(row.querySelector('.ptcPlusBindingQuickState').textContent).toBe(entry.enabled ? '启用' : '停用')
  }
  expect(menu.querySelector('.ptcPlusMenuActions').textContent).toBe('返回')
  fireEvent.click(view.getByRole('menuitem', { name: '返回' }))
  await runtime.flush()
  expect(menu.querySelectorAll('[data-binding-id]')).toHaveLength(16)
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click', false)
  expect(view.getByRole('menuitem', { name: '停用（32）' }).getAttribute('aria-expanded')).toBe('false')
})

test.each(['native', 'fallback'].flatMap(mode => [
  'menu', 'outside', 'closed', 'reopened', 'reopened-outside', 'reopened-closed', 'reopened-surviving',
].map(focus => [mode, focus])))
('%s regrouping preserves %s focus after a removed enabled row', async (mode, focus) => {
  const entry = { ...reviewCandidate('regroup').entry, enabled: true }
  const pending = deferred()
  let catalog = { revision: 'r1', entries: [entry] }
  const rpc = vi.fn(async (endpoint, payload) => {
    if (endpoint === 'disable') {
      expect(payload).toEqual({ id: entry.id, expectedRevision: 'r1' })
      await pending.promise
      catalog = { revision: 'r2', entries: [{ ...entry, enabled: false }] }
    }
    return { ok: true, value: catalog }
  })
  const { runtime } = await fixture({ rpc, ui: mode === 'native' ? primitives : { ...primitives, Menu: undefined } })
  const view = runtime.renderRoot()
  await runtime.flush()
  await openGlobalMenu(view, runtime, 'click', false)
  const row = view.getByRole('menuitem', { name: /regroup/ })
  row.focus()
  fireEvent.click(row)
  await runtime.flush()
  expect(document.activeElement).toBe(row)
  let expectedFocus
  if (focus.startsWith('reopened')) {
    fireEvent.keyDown(document, { key: 'Escape' })
    await runtime.flush()
    await openGlobalMenu(view, runtime, 'click', false)
    expect(document.activeElement).toBe(view.getByRole('menuitem', { name: /regroup/ }))
  }
  if (focus.endsWith('outside')) {
    expectedFocus = document.createElement('input')
    view.container.appendChild(expectedFocus)
    expectedFocus.focus()
  } else if (focus.endsWith('closed')) {
    fireEvent.keyDown(document, { key: 'Escape' })
    await runtime.flush()
    expectedFocus = view.container.querySelector('.ptcPlusAuthorButton')
  } else if (focus === 'reopened-surviving') {
    expectedFocus = view.getByRole('menuitem', { name: 'PTC Plus settings', exact: true })
    expectedFocus.focus()
  }
  pending.resolve()
  await runtime.flush()
  expect(view.queryByRole('menuitem', { name: /regroup/ })).toBeNull()
  if (!focus.endsWith('closed')) expect(view.getByText('No enabled bindings')).not.toBeNull()
  expect(document.activeElement).toBe(expectedFocus ?? view.getByRole('menuitem', { name: 'Disabled (1)' }))
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'disable')).toHaveLength(1)
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
  fireEvent.click(view.getByRole('menuitem', { name: /Disabled \(/ }))
  await runtime.flush()
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
  expect(menu.style.getPropertyValue('--ptc-plus-menu-space')).toBe('')
  expect(menu.querySelector('.ptcPlusBindingMenuContent').style.getPropertyValue('--ptc-plus-menu-space')).toBe('484px')
  // A composer that grew (or moved) without emitting a scroll still moves the list,
  // because the placement effect re-reads the anchor on every entry render.
  top = 440
  setLocale('zh')
  await runtime.flush()
  expect(menu.style.top).toBe('436px')
  expect(menu.style.getPropertyValue('--ptc-plus-menu-space')).toBe('')
  expect(menu.querySelector('.ptcPlusBindingMenuContent').style.getPropertyValue('--ptc-plus-menu-space')).toBe('424px')
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
  const contexts = document.querySelectorAll('.ptcPlusCandidateContext')
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
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
  if (visibility !== 'hidden') expect(document.activeElement).toBe(view.container.querySelector('.ptcPlusAuthorButton'))
  projection.set('ptcPlusBindingDraft', structuredClone(reviewProjection(candidate)))
  runtime.ctx.emit('connection/reset')
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
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
  expect(document.activeElement).toBe(document.querySelector('.ptcPlusBindingDock'))
  const outside = view.container.querySelector('.ptcPlusHeader')
  outside.focus()
  write.resolve({ ok: true, value: null })
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(document.activeElement).toBe(outside)
})

test.each(['expanded', 'enlarged', 'collapsed', 'hidden'])('unconfirmed discard retains %s display without claiming success', async visibility => {
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

test('the composer PTC menu follows the preset and retains settings when global bindings are disabled', async () => {
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
  expect(entries()).toHaveLength(1)
  expect(view.queryByRole('button', { name: 'Global bindings' })).toBeNull()
  expect(view.getByRole('button', { name: 'PTC Plus tools' })).not.toBeNull()
  await openGlobalMenu(view, runtime, 'click')
  expect(view.queryByRole('menuitem', { name: 'Manage global bindings' })).toBeNull()
  expect(view.getByRole('menuitem', { name: 'Refresh session capabilities' })).not.toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'PTC Plus settings' }))
  await runtime.flush()
  expect(view.getByRole('dialog', { name: 'PTC Plus settings' })).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Close PTC Plus settings' }))
  await runtime.flush()
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
    'menu-draftDraft ready to save or discard', 'Write a new binding', 'Refresh session capabilities', 'Manage global bindings', 'Session capability controls', 'PTC Plus settings',
  ])
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
  fireEvent.click(view.getAllByRole('menuitem')[0])
  await runtime.flush()
  expect(view.queryByRole('menu')).toBeNull()
  expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain(candidate.entry.source)
  expect(view.getByRole('dialog')).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
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
  // Draft access retains the refresh and settings utilities when authoring is hidden.
  expect(view.getAllByRole('menuitem')).toHaveLength(4)
  expect(view.queryByRole('menuitem', { name: 'Write a new binding' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test.each(['native', 'wrapped'])('the composer entry carries a %s plugin-signed tooltip that follows the draft state', async mode => {
  const candidate = reviewCandidate('tooltip-entry')
  const { runtime } = await fixture({ ui: mode === 'wrapped' ? wrappedPrimitives() : primitives, rpc: reviewRpc(candidate),
    commands: { list: async () => ({ ok: true, value: [] }) } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const trigger = view.container.querySelector('.ptcPlusAuthorButton')
  expect(trigger.getAttribute('aria-label')).toBe('Global bindings')
  fireEvent.keyDown(document, { key: 'Tab' })
  fireEvent.focus(trigger)
  await runtime.flush()
  expect(view.getByRole('tooltip').textContent)
    .toBe('PTC Plus · Global bindings and settings')
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  await runtime.flush()
  expect(trigger.getAttribute('aria-label')).toBe('Binding drafts (1)')
  expect(view.getByRole('tooltip').textContent).toBe('PTC Plus plugin · Binding draft pending; click to review')
  trigger.closest('.ptcPlusComposerBindingAnchor').getClientRects = () => [new DOMRect(20, 500, 24, 24)]
  fireEvent.click(trigger)
  await runtime.flush()
  expect(view.getByRole('menu')).not.toBeNull()
  expect(view.queryByRole('tooltip')).toBeNull()
  expect(view.container.querySelector('.ptcPlusAuthorButton')).toBe(trigger)

})

test('wrapped Toast renders the host notice for a busy composer', async () => {
  const Toast = React.memo(React.forwardRef(({ text }, ref) => React.createElement('span', {
    ref, role: 'status', 'data-host-toast': true,
  }, text)))
  const { runtime, input } = await fixture({ ui: { ...wrappedPrimitives(), Toast },
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) } })
  const view = runtime.renderRoot()
  await runtime.flush()
  input.publish({ draft: 'keep my text' })
  await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'Write a new binding' }))
  await runtime.flush()
  expect(view.container.querySelector('[data-host-toast]').textContent)
    .toBe('The composer already has text, so its draft was not replaced.')
  expect(view.container.querySelector('.ptcPlusComposerNotice')).toBeNull()
  expect(input.scope.getSnapshot().draft).toBe('keep my text')
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
  expect(view.getAllByRole('menuitem')).toHaveLength(5)
  const pending = deferred()
  const provider = await runtime.mount({ apply(ctx) {
    const commands = { list: () => pending.promise }
    ctx.provide('remote.commands', commands)
  } })
  await provider.dispose()
  pending.resolve({ ok: true, value: [{ name: 'binding' }] })
  await runtime.flush()
  expect(view.getAllByRole('menuitem')).toHaveLength(5)
  const live = await runtime.mount({ apply(ctx) {
    const commands = { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) }
    ctx.provide('remote.commands', commands)
  } })
  await runtime.flush()
  expect(view.getAllByRole('menuitem')).toHaveLength(6)
  await live.dispose()
  await runtime.flush()
  expect(view.getAllByRole('menuitem')).toHaveLength(5)
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
  expect(view.getAllByRole('menuitem')).toHaveLength(5)
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
  const panel = () => document.querySelector('.ptcPlusBindingDock')
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

test('portaled preview and enlarged review yield when the composer is hidden and restore their display choice', async () => {
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) { if (element.matches('.ptcPlusComposerBindingAnchor')) visibility = this.callback }
    unobserve() {}
    disconnect() {}
  })
  cleanups.push(() => vi.unstubAllGlobals())
  const candidate = reviewCandidate('takeover-review')
  const rpc = vi.fn(reviewRpc(candidate))
  const { runtime } = await fixture({ rpc })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingPreviewLayer')).not.toBeNull()
  visibility([{ isIntersecting: false }])
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingPreviewLayer')).toBeNull()
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Enlarge binding draft' }))
  await runtime.flush()
  expect(view.getByRole('dialog')).not.toBeNull()
  visibility([{ isIntersecting: false }])
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.ptcPlusBindingPreviewLayer')).toBeNull()
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  expect(view.getByRole('dialog').textContent).toContain(candidate.entry.source)
  expect(rpc.mock.calls.every(([endpoint]) => ['list', 'draft', 'draft-review'].includes(endpoint))).toBe(true)
})

test.each(['native', 'fallback'])('enlarged %s draft shares exact candidate, eligibility and settlement across display lifecycle', async kind => {
  const candidate = reviewCandidate('enlarged-review')
  const write = deferred()
  let action = null
  const rpc = vi.fn(async endpoint => endpoint === 'save-draft' ? write.promise
    : endpoint === 'list' ? { ok: true, value: { revision: 1, entries: [] } }
      : endpoint === 'draft-review' ? { ok: true, value: { candidate, action } }
        : { ok: true, value: candidate })
  const { runtime, settings, value } = await fixture({ rpc, ui: kind === 'fallback' ? null : primitives })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const enlarge = () => fireEvent.click(view.getByRole('button', { name: 'Enlarge binding draft' }))
  enlarge()
  await runtime.flush()
  const dialog = view.getByRole('dialog', { name: `${candidate.entry.name} · Binding draft` })
  expect(view.container.contains(dialog)).toBe(false)
  expect(document.querySelectorAll('.ptcPlusBindingDock')).toHaveLength(1)
  expect(dialog.textContent).toContain(candidate.entry.source)
  expect(dialog.textContent).toContain(candidate.entry.modelContext.instructions)
  expect(dialog.querySelector('[aria-expanded]')).toBeNull()
  projection.set('ptcPlusBindingDraft', structuredClone(reviewProjection(candidate)))
  await runtime.flush()
  expect(view.getByRole('dialog')).toBe(dialog)
  expect(rpc.mock.calls.every(([endpoint]) => ['list', 'draft', 'draft-review'].includes(endpoint))).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.ptcPlusBindingDockBody')).not.toBeNull()
  enlarge()
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Close binding draft panel' })).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Shrink binding draft' }))
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.ptcPlusBindingDockBody')).not.toBeNull()
  enlarge()
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
  await openGlobalMenu(view, runtime)
  fireEvent.click(view.getByRole('menuitem', { name: new RegExp(candidate.entry.name) }))
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Shrink binding draft' }))
  await runtime.flush()
  enlarge()
  await runtime.flush()
  const replacement = { ...candidate, version: candidate.version + 1,
    entry: { ...candidate.entry, source: 'export const changed = 7' } }
  projection.set('ptcPlusBindingDraft', reviewProjection(replacement))
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain(replacement.entry.source)
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  enlarge()
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  settings.publish({ value: { ...value, userBindingsEnabled: false } })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  settings.publish({ value })
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  await runtime.flush()
  expect(view.getByRole('dialog')).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  action = { requestId: candidate.requestId, id: candidate.entry.id, state: 'saved', enabled: true }
  write.resolve({ ok: true, value: { revision: 2, entries: [] } })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'save-draft')).toHaveLength(1)
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
  expect(view.getByRole('dialog')).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
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
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'save-draft')).toHaveLength(1)
  if (result === 'saved') {
    expect(view.queryByRole('button', { name: /Binding drafts \(1\)/ })).toBeNull()
    expect(view.queryByRole('button', { name: 'Open draft' })).toBeNull()
    expect(view.container.querySelector('.ptcPlusBindingCommand').textContent).toContain('Draft saved and enabled')
  } else {
    await openDraftMenu(view, runtime)
    fireEvent.click(view.getAllByRole('menuitem')[0])
    await runtime.flush()
    expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain('Connection lost')
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
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
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
  expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain('Connection lost')
  fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  expect(view.getByRole('button', { name: 'Binding drafts (1) · Action status needs attention' })).not.toBeNull()
  failed = false
  await vi.advanceTimersByTimeAsync(1500)
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
  await openDraftMenu(view, runtime)
  fireEvent.click(view.getAllByRole('menuitem')[0])
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock').textContent).not.toContain('Connection lost')
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
  expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain('Use second.value')
  delayRead = false
  projection.set('ptcPlusBindingDraft', reviewProjection(first))
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  await runtime.flush()
  await runtime.sessions.add({ id: 'other' })
  runtime.sessions.behavior('other').projections.set('agentPreset', 'ptc')
  runtime.sessions.behavior('other').projections.set('ptcPlusBindingDraft', reviewProjection(second))
  await runtime.sessions.setCurrent('other')
  await runtime.flush()
  write.resolve({ ok: true, value: { revision: 2, entries: [] } })
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain('Use second.value')
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(false)
  await runtime.sessions.setCurrent('client-session')
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
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
  expect(document.querySelector('.ptcPlusBindingDock').getAttribute('aria-busy')).toBe('true')
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
  expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain('Use pending-second.value')
  expect(document.querySelector('.ptcPlusBindingDock').getAttribute('aria-busy')).toBe('true')
  expect(view.getByRole('button', { name: 'Save and enable' }).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Save and enable' }))
  expect(rpc.mock.calls.filter(([endpoint]) => endpoint === 'save-draft')).toHaveLength(2)
  writes.get(second.commandId).resolve({ ok: true, value: { revision: 3, entries: [] } })
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
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
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
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
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
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
  expect(document.querySelector('.ptcPlusBindingDock')).toBeNull()
})

test('mismatched review source cannot authorize buttons under projected source', async () => {
  const candidate = reviewCandidate('exact')
  const impostor = structuredClone(candidate)
  impostor.entry.source = 'export const value = 999'
  const { runtime } = await fixture({ rpc: reviewRpc(impostor) })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingDock').textContent).toContain(candidate.entry.source)
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
  const ctx = new Context()
  const calls = []
  ctx.provide('connection', {
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
  const registry = ctx.plugin(TypertRegistry)
  await registry.await()
  const gateway = ctx.plugin(gatewayClient)
  await gateway.await()
  cleanups.push(() => gateway.dispose(), () => registry.dispose())
  let rpc
  const feature = ctx.plugin({ inject: ['remote'], async apply(featureCtx) { rpc = await createClientRpc(featureCtx) } })
  await feature.await()
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
  for (const module of CONFIG_MODULES) {
    expect(SETTINGS_COPY.zh[`module.${module.key}`]).toBe(module.label)
    expect(SETTINGS_COPY.en[`module.${module.key}`]).toBe(module.labelEn)
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
    IconCheckOutlineRegular: primitives.IconCheckOutlineRegular,
    IconCloseOutlineRegular: primitives.IconCloseOutlineRegular,
  }
  const entry = { ...reviewCandidate('reduced').entry, name: 'reducedTools' }
  const inspect = vi.fn()
  const block = { kind: 'tool-result', callId: 'call-1',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'return 41 + 1', description: 'Compute the answer' }) },
    content: [{ type: 'text', text: '42' }], isError: false, subCalls: [], meta: undefined }
  const { runtime, input } = await fixture({ ui: reducedUi, repl: true, tool: { toolName: 'run_code', block, inspect },
    commands: { list: async () => ({ ok: true, value: [{ name: 'binding' }] }) },
    rpc: async endpoint => ({ ok: true,
      value: endpoint === 'load' ? { revision: 1, entry } : { revision: 1, entries: [entry] } }) })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusRepl', {
    available: true, total: 1, omitted: 0, reuseTotal: 1, entries: [
      { name: 'answer', kind: 'variable',
        definition: { source: 'const answer = 42', line: 1, column: 1 }, reuseCount: 1 },
    ],
  })
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
  // The settings card and the tool row keep their chevron slots when the host
  // publishes no chevron glyph, and the REPL card still expands its definition.
  expect(view.container.querySelector('.ptcPlusChevron')).not.toBeNull()
  const replTrigger = view.container.querySelector('.ptcPlusReplBindingTrigger')
  expect(replTrigger).not.toBeNull()
  fireEvent.click(replTrigger)
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusReplDefinitionWrap')).not.toBeNull()
  // The authoring trigger keeps a text label, a native hint and the busy notice.
  const anchor = view.container.querySelector('.ptcPlusComposerBindingAnchor')
  expect(anchor.getAttribute('data-text')).toBe('true')
  expect(anchor.querySelector('.ptcPlusAuthorButtonLabel').textContent).toBe('Global bindings')
  expect(anchor.querySelector('.ptcPlusAuthorButton').getAttribute('title'))
    .toBe('PTC Plus · Global bindings and settings')
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
  expect(featureEnabled(settings, 'bindings')).toBe(true)
  expect(featureEnabled(settings, 'authorButton')).toBe(true)
  const bindingsOff = { ...settings, value: { ...settings.value, userBindingsEnabled: false } }
  expect(featureEnabled(bindingsOff, 'bindings')).toBe(false)
  expect(featureEnabled(bindingsOff, 'authorButton')).toBe(false)
  expect(featureEnabled({ ...settings, value: { ...settings.value, bindingAuthorButtonVisible: false } }, 'authorButton')).toBe(false)
  // Default-on settings stay on unless explicitly turned off.
  expect(featureEnabled(settings, 'toolView')).toBe(true)
  expect(featureEnabled(settings, 'toolHover')).toBe(true)
  expect(featureEnabled({ ...settings, value: { toolHoverPreviewEnabled: false } }, 'toolHover')).toBe(false)
  expect(featureEnabled({ ...settings, value: { ...settings.value, enhancedToolView: false } }, 'toolView')).toBe(false)
  // An unreadable or not-yet-arrived settings transport falls back to the
  // plugin's shipped defaults instead of removing every contribution.
  expect(featureEnabled({ status: 'loading' }, 'plugin')).toBe(true)
  expect(featureEnabled({ status: 'unavailable' }, 'bindings')).toBe(true)
  // An unavailable transport carries no committed value, so the shipped
  // defaults decide even when a stale value is attached to the snapshot.
  expect(featureEnabled({ status: 'unavailable', value: { enabled: false } }, 'plugin')).toBe(true)
  expect(featureEnabled({ status: 'ready', value: { userBindingsEnabled: false } }, 'bindings')).toBe(false)
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

test.each(['native', 'wrapped', 'malformed'])('tool rows project the recorded call with %s components and expose expansion and inspection', async mode => {
  const inspect = vi.fn()
  const block = { kind: 'tool-result', callId: 'call-1',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'return 41 + 1', description: 'Compute the answer' }) },
    content: [{ type: 'text', text: '42' }], isError: false, subCalls: [], meta: undefined }
  const ui = mode === 'native' ? primitives : mode === 'wrapped' ? wrappedPrimitives()
    : { ...primitives, DisclosureRow: {}, CodeBlock: {} }
  const { runtime } = await fixture({ ui, tool: { toolName: 'run_code', block, inspect } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const row = view.container.querySelector('.ptcPlusTool')
  const header = row.querySelector(mode === 'malformed' ? '.ptcPlusToolSummary' : '[data-disclosure-row]')
  expect(header.textContent).toContain('Code')
  expect(row.querySelector('.ptcPlusToolDescription').textContent).toBe('Compute the answer')
  expect(row.querySelector('.ptcPlusToolState')).toBeNull()
  expect(row.querySelector('.ptcPlusToolBody')).toBeNull()
  expect(header.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(header)
  await runtime.flush()
  expect(header.getAttribute('aria-expanded')).toBe('true')
  expect(row.querySelector('.ptcPlusToolCode').textContent).toContain('return 41 + 1')
  expect(row.querySelector('.ptcPlusToolCode').tagName === 'PRE').toBe(mode === 'malformed')
  expect(row.querySelector('.ptcPlusIoText').textContent).toBe('42')
  fireEvent.click(row.querySelector('.ptcPlusInspect'))
  expect(inspect).toHaveBeenCalledTimes(1)
})

test('activates through the preceding settingsScope transport', async () => {
  const { runtime } = await fixture({ settingsTransport: 'settingsScope' })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusSettingAction')).not.toBeNull()
})

test.each([false, true].flatMap(sharedFace => ['configForms', 'settingsScope'].flatMap(firstArrival =>
  ['configForms', 'settingsScope'].map(firstRemoval => ({ sharedFace, firstArrival, firstRemoval })),
)))('settings transport handoff preserves registration ownership: shared=$sharedFace, arrives=$firstArrival, removes=$firstRemoval', async ({ sharedFace, firstArrival, firstRemoval }) => {
  const { runtime, value, feature } = await fixture({ settingsTransport: 'none' })
  const preference = runtime.slots.entries('settings.plugin.item')[0].inject().hooks.ptcSettings
  const current = stubSettingsScope()
  const legacy = sharedFace ? current : stubSettingsScope()
  const stores = { configForms: current, settingsScope: legacy }
  for (const store of new Set(Object.values(stores))) {
    store.publish({ status: 'ready', writable: true, value: { ...value, enabled: false } })
  }
  const providers = {}
  const provide = async name => {
    providers[name] = await runtime.mount({ apply(ctx) {
      ctx.provide(name, name === 'configForms'
        ? { get: () => stores[name].scope }
        : { bind: () => stores[name].scope })
    } })
    await runtime.flush()
  }
  const remove = async name => {
    await providers[name].dispose()
    delete providers[name]
    await runtime.flush()
  }
  const expectSelected = async name => {
    const selected = stores[name]
    expect(preference.getSnapshot()).toBe(selected.scope.getSnapshot())
    expect(featureEnabled(preference.getSnapshot(), 'plugin')).toBe(false)
    expect(runtime.slots.entries('tool.call.toolview')).toHaveLength(0)
    for (const store of new Set(Object.values(stores))) {
      store.set.mockClear()
      store.mutate.mockClear()
    }
    await preference.set('enabled', true)
    const patch = [{ op: 'set', path: ['bindingUpdates'], value: 'protected' }]
    await preference.mutate(patch)
    expect(selected.set).toHaveBeenCalledExactlyOnceWith('enabled', true)
    expect(selected.mutate).toHaveBeenCalledExactlyOnceWith(patch)
    for (const store of new Set(Object.values(stores))) {
      if (store === selected) continue
      expect(store.set).not.toHaveBeenCalled()
      expect(store.mutate).not.toHaveBeenCalled()
    }
  }
  const secondArrival = firstArrival === 'configForms' ? 'settingsScope' : 'configForms'
  const secondRemoval = firstRemoval === 'configForms' ? 'settingsScope' : 'configForms'
  await provide(firstArrival)
  await expectSelected(firstArrival)
  await provide(secondArrival)
  await expectSelected('configForms')
  expect(current.listenerCount()).toBe(sharedFace ? 2 : 1)
  expect(legacy.listenerCount()).toBe(sharedFace ? 2 : 1)
  if (!sharedFace) {
    legacy.publish({ value: { ...value, enabled: false, bindingUpdates: 'protected' } })
    await runtime.flush()
    await expectSelected('configForms')
  }
  await remove(firstRemoval)
  await expectSelected(secondRemoval)
  expect(stores[secondRemoval].listenerCount()).toBe(1)
  if (!sharedFace) expect(stores[firstRemoval].listenerCount()).toBe(0)
  await provide(firstRemoval)
  await expectSelected('configForms')
  await remove(secondRemoval)
  await expectSelected(firstRemoval)
  await remove(firstRemoval)
  expect(preference.getSnapshot().status).toBe('unavailable')
  expect(featureEnabled(preference.getSnapshot(), 'plugin')).toBe(true)
  expect(runtime.slots.entries('tool.call.toolview')).toHaveLength(2)
  expect(current.listenerCount()).toBe(0)
  expect(legacy.listenerCount()).toBe(0)
  current.set.mockClear()
  current.mutate.mockClear()
  legacy.set.mockClear()
  legacy.mutate.mockClear()
  expect(await preference.set('enabled', false)).toBeUndefined()
  expect(await preference.mutate([])).toBeUndefined()
  expect(current.set).not.toHaveBeenCalled()
  expect(current.mutate).not.toHaveBeenCalled()
  expect(legacy.set).not.toHaveBeenCalled()
  expect(legacy.mutate).not.toHaveBeenCalled()
  await provide(secondArrival)
  await provide(firstArrival)
  await expectSelected('configForms')
  await feature.dispose()
  expect(current.listenerCount()).toBe(0)
  expect(legacy.listenerCount()).toBe(0)
  expect(runtime.slots.entries('tool.call.toolview')).toHaveLength(0)
})

test('activates without any settings transport and reads the shipped defaults', async () => {
  const { runtime } = await fixture({ settingsTransport: 'none' })
  const view = runtime.renderRoot()
  await runtime.flush()
  // apply() completes and registers its contributions instead of waiting for a
  // transport name the installed generation may never publish; the gated
  // surfaces then follow the shipped defaults, asserted by the settings
  // mapping unit test above.
  expect(runtime.ctx.get('configForms')).toBeUndefined()
  expect(runtime.ctx.get('settingsScope')).toBeUndefined()
  expect(view.container.querySelector('.ptcPlusCard')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusAuthorButton')).not.toBeNull()
  expect(runtime.slots.entries('tool.call.toolview')).toHaveLength(2)
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  await runtime.flush()
  expect(view.getByText('This DSH instance does not provide a settings service')).not.toBeNull()
  expect(view.queryByRole('switch', { name: 'Enable PTC Plus', exact: true })).toBeNull()
})

test('activates usable menu and settings controls when the Host primitive package cannot load', async () => {
  const { runtime } = await fixture({ ui: null })
  const view = runtime.renderRoot()
  await runtime.flush()
  const trigger = view.container.querySelector('.ptcPlusAuthorButton')
  expect(trigger).not.toBeNull()
  await openGlobalMenu(view, runtime, 'click')
  fireEvent.click(view.getByRole('menuitem', { name: 'PTC Plus settings' }))
  await runtime.flush()
  expect(view.getByRole('dialog', { name: 'PTC Plus settings' })).not.toBeNull()
  expect(view.getByRole('switch', { name: 'Enable PTC Plus', exact: false })).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
})

test('attributes the plugin stylesheet to the plugin that owns it', async () => {
  await fixture({})
  const sheet = document.getElementById('ptc-plus-client-style')
  expect(sheet).not.toBeNull()
  expect(sheet.dataset.plugin).toBe('dsh-ptc-plus')
  expect(sheet.dataset.pluginCss).toBe('dsh-ptc-plus/client.css')
  // DSH attributes every untagged sheet it meets to whichever plugin is
  // materializing then, so the plugin's own sheet must never be untagged.
  const untagged = [...document.querySelectorAll('style:not([data-plugin])')]
  expect(untagged.some(element => element.id === 'ptc-plus-client-style')).toBe(false)
})

test('claims the global stylesheet the code editor mounts', async () => {
  const { createTypeScriptEditor } = await import('../src/client-code-editor.js')
  const { adoptUnownedStyles, captureUnownedStyles } = await import('../src/client-styles.js')
  const Editor = createTypeScriptEditor(React)
  const view = render(React.createElement(Editor, { value: 'return 1', onChange: () => {}, label: 'probe', documentId: 'probe' }))
  const owned = [...document.querySelectorAll('style[data-plugin="dsh-ptc-plus"]')].map(element => element.dataset.pluginCss)
  expect(owned).toContain('dsh-ptc-plus/codemirror.css')
  expect([...document.querySelectorAll('style:not([data-plugin])')].some(element => element.textContent.includes('.cm-gutters'))).toBe(false)
  view.unmount()
  // Adoption names only sheets that appeared while the plugin mounted them.
  const foreign = document.createElement('style')
  foreign.textContent = '.ptcPlusProbe{}'
  document.head.append(foreign)
  adoptUnownedStyles(captureUnownedStyles())
  expect(foreign.dataset.plugin).toBeUndefined()
  foreign.remove()
})

test.each(['native', 'wrapped', 'missing', 'malformed', 'module-reference', 'broken-memo', 'broken-forward-ref', 'broken-lazy'])('review dock action buttons retain %s styling and save behavior', async mode => {
  const candidate = reviewCandidate('button-styles')
  const wrapped = wrappedPrimitives()
  const malformed = {
    malformed: {},
    'module-reference': { getModuleId: 'wrong export' },
    'broken-memo': { $$typeof: Symbol.for('react.memo') },
    'broken-forward-ref': { $$typeof: Symbol.for('react.forward_ref'), render: 1 },
    'broken-lazy': { $$typeof: Symbol.for('react.lazy'), _init: 1, _payload: {} },
  }
  const ui = mode === 'native' ? primitives : mode === 'wrapped' ? wrapped : mode === 'missing' ? null
    : Object.fromEntries(['Button', 'Tooltip', 'Toast', 'Menu', 'Modal', 'CodeBlock', 'DisclosureRow']
      .map(name => [name, malformed[mode]]))
  const rpc = vi.fn(reviewRpc(candidate))
  const { runtime } = await fixture({ ui, rpc })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const fallback = mode !== 'native' && mode !== 'wrapped'
  for (const [name, variant] of [['Discard draft', 'ghost'], ['Save as disabled', 'outline'], ['Save and enable', 'primary']]) {
    const button = view.getByRole('button', { name, exact: true })
    expect(button.type).toBe('button')
    expect(button.disabled).toBe(false)
    expect(button.classList.contains('ptcPlusButton')).toBe(fallback)
    if (!fallback) {
      const control = render(React.createElement(primitives.Button, { size: 'sm', variant }, 'Native style reference'))
      for (const name of control.getByRole('button', { name: 'Native style reference' }).classList) {
        expect(button.classList.contains(name)).toBe(true)
      }
      control.unmount()
    }
  }
  const enable = view.getByRole('button', { name: 'Save and enable', exact: true })
  if (fallback) expect(enable.dataset.kind).toBe('primary')
  fireEvent.click(enable)
  await runtime.flush()
  const writes = rpc.mock.calls.filter(([endpoint]) => endpoint === 'save-draft')
  expect(writes).toHaveLength(1)
  expect(writes[0][1]).toMatchObject({ activate: true })
})

test('action adapter preserves classes, variants, disabled state and explicit button type', async () => {
  const { createActionButton } = await import('../src/client-primitives.js')
  for (const Button of [undefined, {}, primitives.Button, React.memo(primitives.Button)]) {
    const ActionButton = createActionButton(React, Button)
    const click = vi.fn()
    const view = render(React.createElement(ActionButton, {
      className: 'ptcPlusButton  extra\tptcPlusButton', 'data-kind': 'ghost', disabled: true, onClick: click,
    }, 'Action'))
    const button = view.getByRole('button', { name: 'Action', exact: true })
    expect(button.classList.contains('extra')).toBe(true)
    expect(button.type).toBe('button')
    fireEvent.click(button)
    expect(click).not.toHaveBeenCalled()
    view.rerender(React.createElement(ActionButton, { type: 'submit', onClick: click }, 'Action'))
    expect(button.type).toBe('submit')
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(1)
    view.unmount()
  }
})

test('wrapped menu and modal exports retain host components', async () => {
  const { resolvePrimitives } = await import('../src/client-primitives.js')
  const Menu = React.memo(primitives.Menu)
  const Modal = React.forwardRef((props, _ref) => React.createElement(primitives.Modal, props))
  const resolved = resolvePrimitives({ Menu, Modal }, React)
  expect(resolved.Menu).toBe(Menu)
  expect(resolved.Modal).toBe(Modal)
})

test('resolves every rendered primitive, with a usable fallback for each missing one', async () => {
  const { resolvePrimitives } = await import('../src/client-primitives.js')
  const resolved = resolvePrimitives({}, React)
  for (const name of ['Button', 'CodeBlock', 'DisclosureRow', 'Menu', 'Modal', 'Toast', 'Tooltip']) {
    expect(resolved).toHaveProperty(name)
  }
  expect(typeof resolved.Menu).toBe('function')
  expect(typeof resolved.Modal).toBe('function')
  const onSelect = vi.fn()
  const onClose = vi.fn()
  const menu = render(React.createElement(resolved.Menu, {
    open: true, onClose, onSelect,
    items: [{ id: 'alpha', label: 'Alpha' }, { id: 'sep', type: 'separator' }, { id: 'group', type: 'label', text: 'Group' }],
  }))
  fireEvent.click(menu.getByRole('menuitem', { name: 'Alpha' }))
  expect(onSelect).toHaveBeenCalledWith('alpha')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()
  menu.unmount()
  const modal = render(React.createElement(resolved.Modal, {
    open: true, title: 'Title', closeLabel: 'Close', onClose,
  }, React.createElement('p', null, 'Body')))
  expect(modal.getByRole('dialog')).not.toBeNull()
  expect(modal.getByText('Body')).not.toBeNull()
  modal.unmount()
  // A generation that ships the components keeps rendering them unchanged.
  const passthrough = resolvePrimitives(primitives, React)
  expect(passthrough.Menu).toBe(primitives.Menu)
  expect(passthrough.Modal).toBe(primitives.Modal)
  expect(passthrough.Button).toBe(primitives.Button)
})

test('fallback modal uses current close authority and isolates nested focus layers', async () => {
  const { resolvePrimitives } = await import('../src/client-primitives.js')
  const { Modal } = resolvePrimitives({}, React)
  const outerClose = vi.fn()
  const staleClose = vi.fn()
  const currentClose = vi.fn()
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const outer = render(React.createElement(Modal, { open: true, title: 'Outer', onClose: outerClose },
    React.createElement('button', { 'data-modal-autofocus': true }, 'Outer control')))
  expect(document.activeElement).toBe(outer.getByRole('button', { name: 'Outer control' }))
  const inner = render(React.createElement(Modal, { open: true, title: 'Inner', onClose: staleClose },
    React.createElement('input', { 'data-modal-autofocus': true, disabled: true })))
  expect(document.activeElement).toBe(inner.getByRole('button', { name: 'Inner' }))
  inner.rerender(React.createElement(Modal, { open: true, title: 'Inner', onClose: currentClose }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(currentClose).toHaveBeenCalledTimes(1)
  expect(staleClose).not.toHaveBeenCalled()
  expect(outerClose).not.toHaveBeenCalled()
  inner.unmount()
  expect(document.activeElement).toBe(outer.getByRole('button', { name: 'Outer control' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(outerClose).toHaveBeenCalledTimes(1)
  outer.unmount()
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})

test('fallback overlays preserve composition cancellation and menu dismissal across callback replacement', async () => {
  const { resolvePrimitives } = await import('../src/client-primitives.js')
  const { Modal, Menu } = resolvePrimitives({}, React, createPortal)
  const onClose = vi.fn()
  const modal = render(React.createElement(Modal, { open: true, title: 'Compose', onClose },
    React.createElement('input', { 'aria-label': 'Draft' })))
  const draft = modal.getByRole('textbox', { name: 'Draft' })
  fireEvent.compositionStart(draft)
  fireEvent.keyDown(draft, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.compositionEnd(draft)
  fireEvent.keyDown(draft, { key: 'Escape', keyCode: 27 })
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyUp(draft, { key: 'Escape' })
  fireEvent.keyDown(draft, { key: 'Escape', isComposing: true })
  fireEvent.keyDown(draft, { key: 'Escape', keyCode: 229 })
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyDown(draft, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(draft, { key: 'Escape', repeat: true })
  expect(onClose).toHaveBeenCalledTimes(1)
  fireEvent.compositionStart(draft)
  fireEvent(window, new Event('blur'))
  fireEvent.keyDown(draft, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(2)
  modal.unmount()
  vi.useFakeTimers()
  try {
    const staleClose = vi.fn()
    const currentClose = vi.fn()
    const props = { open: true, portal: true, closeOnPointerLeave: true,
      items: [{ id: 'entry', label: 'Entry' }], anchor: React.createElement('button', null, 'Anchor') }
    const menu = render(React.createElement(Menu, { ...props, onClose: staleClose }))
    fireEvent.keyDown(document, { key: 'Escape', repeat: true })
    expect(staleClose).not.toHaveBeenCalled()
    fireEvent.pointerLeave(document.querySelector('.ptcPlusFallbackMenuList'))
    menu.rerender(React.createElement(Menu, { ...props, onClose: currentClose }))
    await act(() => vi.advanceTimersByTimeAsync(180))
    expect(staleClose).not.toHaveBeenCalled()
    expect(currentClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerLeave(document.querySelector('.ptcPlusFallbackMenuList'))
    menu.unmount()
    await act(() => vi.advanceTimersByTimeAsync(180))
    expect(currentClose).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

test('fallback menu portals only its list and retains its public placement and pointer boundary', async () => {
  const { resolvePrimitives } = await import('../src/client-primitives.js')
  const { Menu } = resolvePrimitives({}, React, createPortal)
  const onClose = vi.fn()
  let rect = new DOMRect(20, 400, 24, 24)
  const getAnchorRect = vi.fn(() => rect)
  const view = render(React.createElement(Menu, { open: true, portal: true, side: 'top', onClose, getAnchorRect,
    anchor: React.createElement('button', null, 'Anchor'),
    items: [{ id: 'first', label: 'First' }, { id: 'last', label: 'Last' }], onSelect: vi.fn() }))
  const list = document.querySelector('.ptcPlusFallbackMenuList')
  expect(list.parentElement).toBe(document.body)
  expect(view.container.contains(view.getByRole('button', { name: 'Anchor' }))).toBe(true)
  expect(view.container.contains(list)).toBe(false)
  expect(list.style.maxHeight).toBe('388px')
  expect(getAnchorRect).toHaveBeenCalled()
  fireEvent.pointerDown(view.getByRole('menuitem', { name: 'First' }))
  expect(onClose).not.toHaveBeenCalled()
  view.getByRole('button', { name: 'Anchor' }).focus()
  fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(view.getByRole('menuitem', { name: 'First' }))
  rect = new DOMRect(20, 300, 24, 24)
  fireEvent(window, new Event('resize'))
  expect(list.style.maxHeight).toBe('288px')
  fireEvent.pointerDown(document.body)
  expect(onClose).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(document.querySelector('.ptcPlusFallbackMenuList')).toBeNull()
})

test('headless fallback modal keeps the viewport mask and portal without default chrome', async () => {
  const { resolvePrimitives } = await import('../src/client-primitives.js')
  const { Modal } = resolvePrimitives({}, React, createPortal)
  const onClose = vi.fn()
  const view = render(React.createElement(Modal, { open: true, headless: true, title: 'Workbench', onClose },
    React.createElement('button', { 'data-modal-autofocus': true }, 'Owned close')))
  const dialog = view.getByRole('dialog', { name: 'Workbench' })
  const mask = dialog.parentElement
  expect(mask.className).toBe('ptcPlusFallbackModalBackdrop')
  expect(mask.parentElement).toBe(document.body)
  expect(view.container.contains(dialog)).toBe(false)
  expect(dialog.querySelector('.ptcPlusFallbackModalHead')).toBeNull()
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Owned close' }))
  fireEvent.pointerDown(dialog)
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.pointerDown(mask)
  expect(onClose).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(document.querySelector('.ptcPlusFallbackModalBackdrop')).toBeNull()
})

test('draft preview tracks only its owned anchor and releases placement frames on hiding and disposal', async () => {
  let nextFrame
  const cancelFrame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', callback => { nextFrame = callback; return 37 })
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  cleanups.push(() => vi.unstubAllGlobals())
  const candidate = reviewCandidate('viewport-owner')
  const { runtime, feature } = await fixture({ rpc: reviewRpc(candidate) })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const anchor = view.container.querySelector('.ptcPlusBindingDockAnchor')
  const host = document.createElement('div')
  host.setAttribute('style', 'max-block-size: 400px')
  view.container.appendChild(host)
  let top = 500
  anchor.getBoundingClientRect = () => ({ top, left: 20, width: 400 })
  const preview = document.querySelector('.ptcPlusBindingPreviewLayer')
  preview.getBoundingClientRect = () => ({ height: Math.min(440, window.innerHeight * .45, top - 16) })
  preview.querySelector('.ptcPlusBindingDockHead').getBoundingClientRect = () => ({ height: 54 })
  preview.querySelector('.ptcPlusBindingDockActions').getBoundingClientRect = () => ({ height: 60 })
  await act(async () => { nextFrame() })
  const layer = document.querySelector('.ptcPlusBindingPreviewLayer')
  expect(layer.parentElement).toBe(document.body)
  expect(layer.style.left).toBe('20px')
  expect(layer.style.getPropertyValue('--ptc-plus-review-space')).toBe('484px')
  top = 550
  await act(async () => { nextFrame() })
  expect(layer.style.getPropertyValue('--ptc-plus-review-space')).toBe('534px')
  top = 100
  await act(async () => { nextFrame() })
  expect(document.querySelector('.ptcPlusBindingDockBody').hasAttribute('inert')).toBe(true)
  expect(view.getByRole('button', { name: 'Enlarge binding draft' })).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Enlarge binding draft' }))
  await runtime.flush()
  expect(view.getByRole('dialog')).not.toBeNull()
  expect(document.querySelector('.ptcPlusBindingDockBody')).not.toBeNull()
  expect(document.querySelector('.ptcPlusBindingPreviewLayer')).toBeNull()
  expect(cancelFrame).toHaveBeenCalledWith(37)
  expect(host.style.getPropertyValue('max-block-size')).toBe('400px')
  await feature.dispose()
  await runtime.flush()
  expect(document.querySelector('.ptcPlusBindingPreviewLayer')).toBeNull()
  expect(view.queryByRole('dialog')).toBeNull()
})

test.each(['native', 'fallback'].flatMap(kind => ['unchanged', 'clone', 'collapsed', 'hidden', 'replaced', 'completed', 'unreachable', 'disposed'].map(change => [kind, change])))('enlarged close %s focus follows exact candidate and lifecycle after %s', async (kind, change) => {
  let nextFrameId = 0
  const frames = new Map()
  vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++nextFrameId, callback); return nextFrameId })
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id))
  cleanups.push(() => vi.unstubAllGlobals())
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(20, 500, 24, 24)])
  cleanups.push(() => rects.mockRestore())
  let visibility
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback }
    observe(element) { if (element.matches('.ptcPlusComposerBindingAnchor')) visibility = this.callback }
    unobserve() {}
    disconnect() {}
  })
  const candidate = reviewCandidate('focus-refresh')
  const { runtime, feature } = await fixture({ rpc: reviewRpc(candidate), ui: kind === 'fallback' ? null : primitives })
  const projection = runtime.sessions.behavior('client-session').projections
  projection.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  visibility([{ isIntersecting: true }])
  await runtime.flush()
  const enlarge = view.getByRole('button', { name: 'Enlarge binding draft' })
  enlarge.focus()
  fireEvent.click(enlarge)
  await runtime.flush()
  expect(view.getByRole('dialog')).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  if (change === 'clone') projection.set('ptcPlusBindingDraft', structuredClone(reviewProjection(candidate)))
  if (change === 'replaced') projection.set('ptcPlusBindingDraft', reviewProjection(reviewCandidate('replacement')))
  if (change === 'completed') {
    const completed = reviewProjection(candidate)
    completed.history[0].action = { requestId: candidate.requestId, id: candidate.entry.id, state: 'saved', enabled: false }
    projection.set('ptcPlusBindingDraft', completed)
  }
  if (change === 'unreachable') {
    visibility([{ isIntersecting: false }])
  }
  if (change === 'disposed') await feature.dispose()
  if (change === 'collapsed') fireEvent.click(view.getByRole('button', { name: 'Collapse binding draft' }))
  if (change === 'hidden') fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
  await runtime.flush()
  const callbacks = [...frames.values()]
  frames.clear()
  await act(async () => { for (const callback of callbacks) callback(20) })
  const panel = document.querySelector('.ptcPlusBindingDock')
  if (change === 'unchanged' || change === 'clone') {
    expect(panel).not.toBeNull()
    expect(document.activeElement).toBe(panel)
  } else expect(document.activeElement === panel && panel !== null).toBe(false)
})


test.each(['native', 'fallback'].flatMap(kind => [false, true].map(resizeHidden => [kind, resizeHidden])))('unfittable %s preview preserves manual enlarged access and return focus after hidden resize=%s', async (kind, resizeHidden) => {
  let top = resizeHidden ? 500 : 40
  let nextFrameId = 0
  const frames = new Map()
  vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++nextFrameId, callback); return nextFrameId })
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id))
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('ptcPlusBindingDockAnchor')) return new DOMRect(20, top, 400, 0)
    if (this.classList.contains('ptcPlusBindingPreviewLayer')) return new DOMRect(20, 8, 400, Math.max(0, top - 8))
    if (this.classList.contains('ptcPlusBindingDockHead')) return new DOMRect(20, 8, 400, 58)
    if (this.classList.contains('ptcPlusBindingDockActions')) return new DOMRect(20, 8, 400, 60)
    return new DOMRect()
  })
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(20, 500, 24, 24)])
  cleanups.push(() => { bounds.mockRestore(); rects.mockRestore(); vi.unstubAllGlobals() })
  const candidate = reviewCandidate('unfittable')
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: candidate.commandId, args: ' new helper', outcome: null }]]) }
  const { runtime } = await fixture({ rpc: reviewRpc(candidate), turn, ui: kind === 'fallback' ? null : primitives })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', reviewProjection(candidate))
  const view = runtime.renderRoot()
  await runtime.flush()
  const layer = () => document.querySelector('.ptcPlusBindingPreviewLayer')
  if (resizeHidden) {
    expect(layer().dataset.available).toBe('true')
    fireEvent.click(view.getByRole('button', { name: 'Close binding draft panel' }))
    await runtime.flush()
    top = 40
    expect(layer()).toBeNull()
  } else {
    expect(layer().dataset.available).toBe('false')
    expect(layer().hasAttribute('inert')).toBe(true)
  }
  fireEvent.click(view.getByRole('button', { name: 'Open draft' }))
  await runtime.flush()
  expect(view.getByRole('dialog')).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  await runtime.flush()
  expect(view.queryByRole('dialog')).toBeNull()
  const callbacks = [...frames.values()]
  frames.clear()
  await act(async () => { for (const callback of callbacks) callback(20) })
  expect(document.activeElement).toBe(view.container.querySelector('.ptcPlusAuthorButton'))
  expect(layer().dataset.available).toBe('false')
  top = 500
  const later = [...frames.values()]
  frames.clear()
  await act(async () => { for (const callback of later) callback(40) })
  expect(layer().dataset.available).toBe('true')
  expect(layer().hasAttribute('inert')).toBe(false)
  expect(view.queryByRole('dialog')).toBeNull()
})


test.each(['configForms', 'settingsScope'])('tool hover setting applies live through %s without losing expansion', async settingsTransport => {
  vi.useFakeTimers()
  const block = { kind: 'tool-result', callId: 'hover-setting',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'return 42' }) },
    content: [{ type: 'text', text: '42' }] }
  const { runtime, settings, value } = await fixture({ settingsTransport, tool: { toolName: 'run_code', block } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const row = view.container.querySelector('.ptcPlusTool')
  const header = row.querySelector('[aria-expanded]')
  fireEvent.click(view.container.querySelector('.ptcPlusHeader'))
  const switchInput = view.getByRole('switch', { name: SETTINGS_COPY.en['toolHoverPreviewEnabled.label'] })
  expect(switchInput.checked).toBe(true)
  fireEvent.click(switchInput)
  await runtime.flush()
  expect(settings.set).toHaveBeenCalledWith('toolHoverPreviewEnabled', false)
  // Simulate the committed Host snapshot, rather than an optimistic local write.
  fireEvent.pointerEnter(row, { clientX: 1 })
  await act(() => vi.advanceTimersByTimeAsync(200))
  settings.publish({ value: { ...value, toolHoverPreviewEnabled: false } })
  await runtime.flush()
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.keyDown(document, { key: 'Tab' })
  await act(() => header.focus())
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  settings.publish({ value })
  await runtime.flush()
  fireEvent.pointerMove(row, { clientX: 2 })
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(document.querySelector('.ptcPlusToolHover')).not.toBeNull()
  settings.publish({ value: { ...value, toolHoverPreviewEnabled: false } })
  await runtime.flush()
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.click(header)
  await runtime.flush()
  expect(header.getAttribute('aria-expanded')).toBe('true')
  expect(row.querySelector('.ptcPlusIoText').textContent).toBe('42')
})

test.each(['native', 'wrapped', 'fallback-row'])('tool hover shows a passive excerpt after dwell with %s components', async mode => {
  vi.useFakeTimers()
  const inspect = vi.fn()
  const block = { kind: 'tool-result', callId: 'hover-call',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'throw new Error("recorded only")', description: 'Recorded computation' }) },
    content: [{ type: 'text', text: 'Recorded result' }], isError: false, subCalls: [] }
  const ui = mode === 'wrapped' ? wrappedPrimitives() : mode === 'fallback-row'
    ? { ...primitives, DisclosureRow: undefined, CodeBlock: undefined } : primitives
  const { runtime, rpcCalls } = await fixture({ ui, tool: { toolName: 'run_code', block, inspect } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const row = view.container.querySelector('.ptcPlusTool')
  const header = row.querySelector('[aria-expanded]')
  const beforeHover = [...rpcCalls]
  fireEvent.pointerEnter(row)
  await act(() => vi.advanceTimersByTimeAsync(399))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.pointerLeave(row)
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.pointerEnter(row)
  await act(() => vi.advanceTimersByTimeAsync(400))
  const preview = document.querySelector('.ptcPlusToolHover')
  expect(preview).not.toBeNull()
  expect(row.contains(preview)).toBe(false)
  expect(preview.querySelector('.ptcPlusToolCode').textContent).toContain('throw new Error("recorded only")')
  expect(preview.querySelector('.ptcPlusIoText').textContent).toBe('Recorded result')
  expect(preview.querySelector('button')).toBeNull()
  expect(preview.querySelector('.ptcPlusInspect')).toBeNull()
  expect(header.getAttribute('aria-expanded')).toBe('false')
  expect(inspect).not.toHaveBeenCalled()
  expect(rpcCalls).toEqual(beforeHover)
  fireEvent.pointerLeave(row)
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.keyDown(document, { key: 'Tab' })
  await act(() => header.focus())
  expect(document.querySelector('.ptcPlusToolHover')).not.toBeNull()
  fireEvent.click(header)
  await runtime.flush()
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  expect(header.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(header, { key: ' ' })
  await runtime.flush()
  expect(header.getAttribute('aria-expanded')).toBe('false')
  fireEvent.keyDown(header, { key: 'Enter' })
  await runtime.flush()
  fireEvent.click(row.querySelector('.ptcPlusInspect'))
  expect(inspect).toHaveBeenCalledTimes(1)
})

test.each(['wheel', 'scroll'])('tool hover cancels pending and visible previews on %s without taking the gesture', async eventName => {
  vi.useFakeTimers()
  const block = { kind: 'tool-result', callId: 'hover-scroll',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'return 42', description: 'Compute' }) },
    content: [{ type: 'text', text: '42' }] }
  const { runtime } = await fixture({ tool: { toolName: 'run_code', block } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const row = view.container.querySelector('.ptcPlusTool')
  fireEvent.pointerEnter(row, { clientX: 1, clientY: 1 })
  await act(() => vi.advanceTimersByTimeAsync(300))
  const event = eventName === 'wheel' ? new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    : new Event('scroll')
  fireEvent(window, event)
  expect(event.defaultPrevented).toBe(false)
  await act(() => vi.advanceTimersByTimeAsync(349))
  fireEvent.pointerMove(row, { clientX: 10, clientY: 1 })
  await act(() => vi.advanceTimersByTimeAsync(1))
  fireEvent.pointerMove(row, { clientX: 11, clientY: 1 })
  await act(() => vi.advanceTimersByTimeAsync(399))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(document.querySelector('.ptcPlusToolHover')).not.toBeNull()
  fireEvent(window, eventName === 'wheel' ? new WheelEvent('wheel', { deltaY: 100 }) : new Event('scroll'))
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  // Stationary pointer after scrolling must not silently reopen the card.
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.pointerMove(row, { clientX: 2, clientY: 1 })
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(document.querySelector('.ptcPlusToolHover')).not.toBeNull()
  fireEvent(window, eventName === 'wheel' ? new WheelEvent('wheel', { deltaY: 100 }) : new Event('scroll'))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  // Entries and moves while the scroll is still recent do not schedule work.
  fireEvent.pointerEnter(row, { clientX: 3, clientY: 1 })
  fireEvent.pointerMove(row, { clientX: 4, clientY: 1 })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.pointerMove(row, { clientX: 5, clientY: 1 })
  await act(() => vi.advanceTimersByTimeAsync(399))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(document.querySelector('.ptcPlusToolHover')).not.toBeNull()
})

test.each(['running', 'error', 'stopped'])('tool hover follows recorded %s lifecycle and locale', async state => {
  vi.useFakeTimers()
  const block = { kind: state === 'running' ? 'tool-call' : 'tool-result', callId: 'hover-state',
    call: { name: 'run_code', arguments: JSON.stringify({ code: 'return 42', description: 'Compute' }) },
    content: [{ type: 'text', text: 'Recorded output' }], isError: state === 'error',
    error: state === 'stopped' ? { code: 'interrupted' } : undefined }
  if (state === 'running') Object.assign(block, block.call)
  const { runtime, setLocale } = await fixture({ tool: { toolName: 'run_code', block } })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.pointerEnter(view.container.querySelector('.ptcPlusTool'))
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(document.querySelector('.ptcPlusToolHoverHeader').dataset.state).toBe(state)
  expect(document.querySelector('.ptcPlusToolHoverState').textContent).toBe(
    SETTINGS_COPY.en[{ running: 'tool.running', error: 'tool.failed', stopped: 'tool.stopped' }[state]])
  setLocale('zh')
  await runtime.flush()
  expect(document.querySelector('.ptcPlusToolHoverHeading').textContent).toBe(SETTINGS_COPY.zh['tool.preview'])
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.pointerMove(view.container.querySelector('.ptcPlusTool'), { clientX: 7 })
  await act(() => vi.advanceTimersByTimeAsync(400))
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
})

test('tool hover bounds excerpts while expansion retains the complete record and Copy', async () => {
  vi.useFakeTimers()
  const source = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i}`).join('\n')
  const output = Array.from({ length: 30 }, (_, i) => `output ${i}`).join('\n')
  const block = { kind: 'tool-result', callId: 'hover-bounded',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: source, description: 'Long record' }) },
    content: [{ type: 'text', text: output }] }
  const { runtime } = await fixture({ tool: { toolName: 'run_code', block } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const row = view.container.querySelector('.ptcPlusTool')
  fireEvent.pointerEnter(row)
  await act(() => vi.advanceTimersByTimeAsync(400))
  const preview = document.querySelector('.ptcPlusToolHover')
  expect(preview.querySelector('.ptcPlusToolCode').textContent).not.toContain('value6')
  expect(preview.querySelector('.ptcPlusIoText').textContent).not.toContain('output 3')
  expect(preview.querySelector('.ptcPlusToolHoverBounded').textContent).toBe(SETTINGS_COPY.en['tool.previewBounded'])
  fireEvent.click(row.querySelector('[aria-expanded]'))
  await runtime.flush()
  expect(row.querySelector('.ptcPlusToolCode pre').textContent).toBe(source)
  expect(row.querySelector('.ptcPlusIoText').textContent).toBe(output)
  expect([...row.querySelectorAll('button')].some(button => button.textContent === SETTINGS_COPY.en['tool.copy'])).toBe(true)
})

test('inspect-only tool rows do not open an empty hover preview', async () => {
  vi.useFakeTimers()
  const { runtime } = await fixture({ tool: { toolName: 'run_code', block: { kind: 'tool-call', name: 'run_code' }, inspect: vi.fn() } })
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.pointerEnter(view.container.querySelector('.ptcPlusTool'))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
})

test('tool hover cancels pending dwell on Escape and releases scroll observers on unmount', async () => {
  vi.useFakeTimers()
  const remove = vi.spyOn(window, 'removeEventListener')
  const block = { kind: 'tool-call', name: 'run_code', arguments: JSON.stringify({ code: 'return 42' }) }
  const { runtime } = await fixture({ tool: { toolName: 'run_code', block } })
  const view = runtime.renderRoot()
  await runtime.flush()
  const row = view.container.querySelector('.ptcPlusTool')
  fireEvent.pointerEnter(row)
  await act(() => vi.advanceTimersByTimeAsync(300))
  fireEvent.keyDown(window, { key: 'Escape' })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  fireEvent.pointerMove(row, { clientX: 10 })
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(document.querySelector('.ptcPlusToolHover')).toBeNull()
  expect(remove.mock.calls.some(([name, , capture]) => name === 'wheel' && capture === true)).toBe(true)
  expect(remove.mock.calls.some(([name, , capture]) => name === 'scroll' && capture === true)).toBe(true)
})


test('MCP source rules preserve independent child preferences and direct source-disabled switches', async () => {
  const { view, ids, snapshot, updateSetting, rerender } = await capabilityWorkbenchFixture({
    overrides: { 'tools.mcp__docs__search': 'full', 'tools.mcp__docs__edit': 'closed' },
    catalog: [
      { id: 'tools.read', category: 'tool', source: { kind: 'host' } },
      { id: 'tools.mcp__docs__search', category: 'tool', mcpServer: 'docs', source: { kind: 'mcp', server: 'docs' } },
      { id: 'tools.mcp__docs__edit', category: 'tool', mcpServer: 'docs', source: { kind: 'mcp', server: 'docs' } },
      { id: 'mcp.docs', category: 'resource', mcpServer: 'docs', source: { kind: 'mcp', server: 'docs' } },
    ],
  })
  await chooseCapabilityOption(view, 'Capability types', 'MCP')
  expect(ids()).not.toContain('tools.read')
  expect(ids()).toContain('tools.mcp__docs__search')
  fireEvent.click(view.getByRole('button', { name: 'Batch settings' }))
  fireEvent.click(view.getByText('Source rules', { selector: 'summary' }))
  await chooseCapabilityOption(view, 'docs · Availability', 'Closed')
  rerender(); await act(async () => {})
  const policy = JSON.parse(snapshot.value.capabilityPolicy)
  expect(policy.mcpServers.docs).toEqual({ availability: 'closed' })
  expect(policy.items['tools.mcp__docs__search']).toEqual({ disclosure: 'full' })
  expect(policy.items['tools.mcp__docs__edit']).toEqual({ availability: 'closed' })
  expect(view.getByRole('switch', { name: 'Availability for tools.mcp__docs__search' }).disabled).toBe(true)
  expect(view.container.querySelector('[data-state=source-closed]').textContent).toContain('Source disabled')
  await chooseCapabilityOption(view, 'docs · Availability', 'Use parent rules')
  rerender(); await act(async () => {})
  expect(view.getByRole('switch', { name: 'Availability for tools.mcp__docs__search' }).disabled).toBe(false)
  fireEvent.click(view.getByRole('switch', { name: 'Availability for tools.mcp__docs__search' }))
  rerender(); await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).items['tools.mcp__docs__search']).toEqual({ availability: 'closed', disclosure: 'full' })
  fireEvent.click(view.getByRole('switch', { name: 'Availability for tools.mcp__docs__search' }))
  rerender(); await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).items['tools.mcp__docs__search']).toEqual({ availability: 'enabled', disclosure: 'full' })
  expect(updateSetting.mock.calls.every(([key]) => key === 'capabilityPolicy')).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: tools.mcp__docs__search' }))
  snapshot.writable = false; rerender()
  const sourceControls = view.getByRole('complementary').querySelector('details')
  expect([...sourceControls.querySelectorAll('[role=combobox]')].every(control => control.disabled)).toBe(true)
  view.unmount()
})

test.each([false, true])('MCP saved source rules remain editable without claiming catalog facts when failure is %s', async failed => {
  const { view, snapshot, ids } = await capabilityWorkbenchFixture({
    overrides: { 'mcpServers.docs': 'closed', 'mcpServers.missing': 'closed', 'tools.saved': 'full' },
    catalogReader: async () => {
      if (failed) throw new Error('Catalog unavailable')
      return [{ id: 'tools.saved', category: 'tool', mcpServer: 'docs', source: { kind: 'mcp', server: 'docs' } }]
    },
  })
  fireEvent.click(view.getByRole('button', { name: 'Batch settings' }))
  fireEvent.click(view.getByText('Source rules', { selector: 'summary' }))
  expect(view.getByRole('combobox', { name: 'missing · Availability' }).textContent).toContain('Closed')
  await chooseCapabilityOption(view, 'missing · Availability', 'Use parent rules')
  expect(JSON.parse(snapshot.value.capabilityPolicy).mcpServers).toEqual({ docs: { availability: 'closed' } })
  expect(JSON.parse(snapshot.value.capabilityPolicy).items['tools.saved']).toEqual({ disclosure: 'full' })
  await chooseCapabilityOption(view, 'Availability', failed ? 'Unconfirmed' : 'Currently available')
  expect(ids()).toEqual(['tools.saved'])
  await chooseCapabilityOption(view, 'Availability', 'Currently unavailable')
  expect(ids()).toEqual([])
  view.unmount()
})

test('MCP catalog failure marks retained source members unknown without inventing source identity', async () => {
  let fails = false
  const { view, ids } = await capabilityWorkbenchFixture({ overrides: { 'mcpServers.missing': 'closed' },
    catalogReader: async () => {
      if (fails) throw new Error('Disconnected MCP catalog')
      return [{ id: 'tools.mcp__docs__search', category: 'tool', source: { kind: 'host' } }]
    },
  })
  await chooseCapabilityOption(view, 'Capability types', 'MCP')
  expect(ids()).toEqual([])
  await chooseCapabilityOption(view, 'Capability types', 'Tools')
  fails = true
  fireEvent.click(view.getByRole('button', { name: 'Reload catalog' }))
  await act(async () => {})
  await chooseCapabilityOption(view, 'Availability', 'Unconfirmed')
  expect(ids()).toEqual(['tools.mcp__docs__search'])
  expect(view.container.querySelector('.ptcPlusCapabilityBadge').textContent).toBe('Tools')
  for (const availability of ['Currently available', 'Currently unavailable']) {
    await chooseCapabilityOption(view, 'Availability', availability)
    expect(ids()).toEqual([])
  }
  view.unmount()
})

test('composed category controls match integrated inventory and retain legacy category rules in both locales', async () => {
  for (const locale of ['zh', 'en']) {
    const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
    policy.categories = {
      'resource-template': { availability: 'closed', disclosure: 'on-demand' },
      task: { availability: 'enabled', disclosure: 'full' },
      skill: { disclosure: 'full' },
    }
    const { view, snapshot, rerender } = await capabilityWorkbenchFixture({ catalog: [], locale,
      configuration: { capabilityPolicy: JSON.stringify(policy) } })
    const copy = SETTINGS_COPY[locale]
    fireEvent.click(view.getByRole('button', { name: copy['capabilities.batchSettings'] }))
    const categories = view.getByText(copy['capabilities.policy.categories'], { selector: 'summary' }).parentElement
    fireEvent.click(categories.querySelector('summary'))
    expect([...categories.querySelectorAll('strong')].map(item => item.textContent)).toEqual(
      locale === 'zh' ? ['Tools', 'Skills', 'MCP 资源与模板'] : ['Tools', 'Skills', 'MCP resources and templates'])
    expect(categories.querySelectorAll('[role="combobox"]').length).toBe(6)
    await chooseCapabilityOption(view, `${copy['capabilities.policy.category.resource']} · ${copy['capabilities.policy.availability']}`,
      copy['capabilities.closed'])
    rerender(); await act(async () => {})
    fireEvent.click(view.getByRole('tab', { name: copy['capabilities.tab.budgets'] }))
    fireEvent.click(view.getByText(copy['capabilities.allocationTitle'], { selector: 'summary' }))
    fireEvent.click(view.getByRole('switch', { name: copy['capabilities.policy.allocate.statistics'] }))
    await act(async () => {})
    const saved = JSON.parse(snapshot.value.capabilityPolicy)
    expect(saved.categories).toEqual({ ...policy.categories, resource: { availability: 'closed' } })
    expect(saved.defaults).toEqual(policy.defaults)
    expect(saved.allocation.statistics).toBe(true)
    view.unmount()
  }
})

test('composed capability settings independently edit availability disclosure allocation recovery and preview', async () => {
  const { view, snapshot, rerender, updateSetting } = await capabilityWorkbenchFixture({
    catalog: [{ id: 'tools.probe', name: 'Probe', category: 'tool', source: { kind: 'host' } }],
    configuration: { capabilityPolicy: CAPABILITY_POLICY_DEFAULT, capabilityRecoveryEnabled: false, modelPreviewEnabled: false },
  })
  fireEvent.click(view.getByRole('button', { name: 'Edit context settings: tools.probe' }))
  expect(view.getByLabelText('Disclosure for tools.probe').textContent).toContain('Use parent rules')
  await chooseCapabilityOption(view, 'Disclosure for tools.probe', 'Full contract')
  rerender(); await act(async () => {})
  await chooseCapabilityOption(view, 'Availability for tools.probe', 'Closed')
  rerender(); await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).items['tools.probe']).toEqual({ availability: 'closed', disclosure: 'full' })
  await chooseCapabilityOption(view, 'Availability for tools.probe', 'Enabled')
  rerender(); await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).items['tools.probe']).toEqual({ availability: 'enabled', disclosure: 'full' })
  fireEvent.click(view.getByRole('tab', { name: 'Context', exact: true }))
  fireEvent.click(view.getByText('Allocation criteria', { selector: 'summary' }))
  fireEvent.click(view.getByRole('switch', { name: 'Allocate descriptions from usage evidence' }))
  rerender(); await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).allocation.statistics).toBe(true)
  expect(snapshot.value.capabilityStatistics).toBeUndefined()
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }))
  fireEvent.click(view.getByRole('switch', { name: 'Collect usage statistics' }))
  rerender(); await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityStatistics).enabled).toBe(true)
  expect(JSON.parse(snapshot.value.capabilityPolicy).allocation.statistics).toBe(true)
  fireEvent.click(view.getByRole('tab', { name: 'Context' }))
  fireEvent.click(view.getByRole('tab', { name: 'Description recovery' }))
  fireEvent.click(view.getByRole('switch', { name: 'Restore used descriptions' }))
  fireEvent.click(view.getByRole('tab', { name: 'Results and logs' }))
  fireEvent.click(view.getByRole('switch', { name: 'Limit results and logs' }))
  await act(async () => {})
  expect(snapshot.value.capabilityRecoveryEnabled).toBe(true)
  expect(snapshot.value.modelPreviewEnabled).toBe(true)
  expect(updateSetting.mock.calls.map(([key]) => key)).not.toContain('capabilityManagementEnabled')
  view.unmount()
})

test('capability task navigation keeps fixed context features and their independent saved limits', async () => {
  const { view, snapshot, updateSetting, rerender } = await capabilityWorkbenchFixture({
    configuration: { capabilityManagementEnabled: false, capabilityRecoveryEnabled: true, modelPreviewEnabled: true,
      capabilityRecoveryBytes: 7654, modelPreviewTokens: 4321 },
    catalog: [{ id: 'tools.ask_user_question', name: 'ask_user_question', category: 'tool', description: 'A provider description', source: { kind: 'host' } }],
  })
  const row = view.container.querySelector('.ptcPlusCapabilityItem')
  expect(row.querySelector('code').textContent).toBe('tools.ask_user_question')
  expect(row.textContent).not.toContain('A provider description')
  expect(row.querySelector('[data-state=unapplied]').textContent).toBe('Not applied')
  expect(view.queryByRole('complementary')).toBeNull()
  fireEvent.click(view.getByRole('tab', { name: 'Context', exact: true }))
  const navigation = view.container.querySelector('.ptcPlusContextNavigation')
  expect([...navigation.querySelectorAll('button')].map(item => item.getAttribute('aria-label'))).toEqual(['Capability descriptions', 'Description recovery', 'Results and logs'])
  fireEvent.click(view.getByRole('tab', { name: 'Description recovery' }))
  expect(view.getByRole('switch', { name: 'Restore used descriptions' }).checked).toBe(true)
  fireEvent.click(view.getByRole('tab', { name: 'Results and logs' }))
  expect(view.getByRole('switch', { name: 'Limit results and logs' }).checked).toBe(true)
  expect(updateSetting).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('switch', { name: 'Limit results and logs' }))
  rerender(); await act(async () => {})
  expect(snapshot.value.modelPreviewEnabled).toBe(false)
  expect(snapshot.value.modelPreviewTokens).toBe(4321)
  expect(snapshot.value.capabilityRecoveryEnabled).toBe(true)
  expect(snapshot.value.capabilityRecoveryBytes).toBe(7654)
  expect(snapshot.value.capabilityManagementEnabled).toBe(false)
  view.unmount()
})

test.each(['zh', 'en'])('context feature status follows independent saved settings in %s', async locale => {
  const copy = SETTINGS_COPY[locale]
  const { view, snapshot, updateSetting, rerender } = await capabilityWorkbenchFixture({ locale, catalog: [],
    configuration: { capabilityManagementEnabled: false, capabilityRecoveryEnabled: true, modelPreviewEnabled: false } })
  fireEvent.click(view.getByRole('tab', { name: copy['capabilities.tab.budgets'], exact: true }))
  const states = () => ['description', 'recovery', 'preview'].map(key => {
    const tab = view.getByRole('tab', { name: copy[`capabilities.context.${key}`], exact: true })
    const status = tab.ownerDocument.getElementById(tab.getAttribute('aria-describedby'))
    expect(tab.contains(status)).toBe(true)
    return status.textContent
  })
  expect(states()).toEqual([copy['capabilities.host'], copy['capabilities.serverOn'], copy['capabilities.serverOff']])
  fireEvent.click(view.getByRole('tab', { name: copy['capabilities.context.preview'], exact: true }))
  expect(updateSetting).not.toHaveBeenCalled()
  expect(states()).toEqual([copy['capabilities.host'], copy['capabilities.serverOn'], copy['capabilities.serverOff']])
  fireEvent.click(view.getByRole('switch', { name: copy['capabilities.previewEnabled'], exact: true }))
  rerender(); await act(async () => {})
  expect(states()).toEqual([copy['capabilities.host'], copy['capabilities.serverOn'], copy['capabilities.serverOn']])
  fireEvent.click(view.getByRole('tab', { name: copy['capabilities.tab.manual'], exact: true }))
  fireEvent.click(view.getByRole('switch', { name: copy['capabilities.management'], exact: true }))
  rerender(); await act(async () => {})
  fireEvent.click(view.getByRole('tab', { name: copy['capabilities.tab.budgets'], exact: true }))
  expect(states()).toEqual([copy['capabilities.context.custom'], copy['capabilities.serverOn'], copy['capabilities.serverOn']])
  fireEvent.click(view.getByRole('tab', { name: copy['capabilities.context.recovery'], exact: true }))
  fireEvent.click(view.getByRole('switch', { name: copy['capabilities.recoveryEnabled'], exact: true }))
  rerender(); await act(async () => {})
  expect(states()).toEqual([copy['capabilities.context.custom'], copy['capabilities.serverOff'], copy['capabilities.serverOn']])
  snapshot.writable = false; rerender(); await act(async () => {})
  expect(states()).toEqual([copy['capabilities.context.custom'], copy['capabilities.serverOff'], copy['capabilities.serverOn']])
  view.unmount()
})

test('capability save feedback reflects its own pending or conflicting writes', async () => {
  const { view, updateSetting } = await capabilityWorkbenchFixture({ catalog: [{ id: 'tools.probe', category: 'tool' }] })
  updateSetting.mockResolvedValue('status.conflict')
  fireEvent.click(view.getByRole('switch', { name: 'Allow redeclarations and overrides' }))
  await act(async () => {})
  const feedback = () => view.container.querySelector('.ptcPlusCapabilityPane:not([hidden]) .ptcPlusCapabilitySaveState').textContent
  expect(feedback()).toBe('Saved · used by new sessions')
  const pending = deferred()
  updateSetting.mockImplementationOnce(() => pending.promise)
  fireEvent.click(view.getByRole('switch', { name: 'Availability for tools.probe' }))
  await act(async () => {})
  expect(feedback()).toBe(SETTINGS_COPY.en['state.syncing'])
  await act(async () => pending.resolve('status.conflict'))
  expect(feedback()).toBe(SETTINGS_COPY.en['status.conflict'])
  updateSetting.mockResolvedValue('status.applied')
  fireEvent.click(view.getByRole('switch', { name: 'Allow redeclarations and overrides' }))
  await act(async () => {})
  expect(feedback()).toBe(SETTINGS_COPY.en['status.conflict'])
  view.unmount()
})

test('composed session dimensions confirm only the applied changes and retain independent failed drafts', async () => {
  let entries = [{ id: 'tools.probe', category: 'tool', source: { kind: 'host' }, saved: 'automatic', temporary: 'inherit', effective: 'host',
    savedRule: {}, sourceRule: {}, temporaryRule: {} }]
  const { view, commands } = await sessionControlsFixture({ read: async () => structuredClone(entries), run: async (sessionId, input) => {
    if (input.endsWith('availability closed')) {
      entries = [{ ...entries[0], temporaryRule: { availability: 'closed' }, effective: 'closed' }]
      return { kind: 'success', text: capabilityCommandReceipt('recorded', sessionId) }
    }
    throw new Error('Disclosure publication refused')
  } })
  await chooseCapabilityOption(view, 'Availability', 'Closed')
  await chooseCapabilityOption(view, 'Disclosure', 'Full contract')
  fireEvent.click(view.getByRole('button', { name: 'Apply to session' }))
  await act(async () => {})
  expect(commands.run.mock.calls.map(([, input]) => input)).toEqual([
    'set session tools.probe availability closed', 'set session tools.probe disclosure full',
  ])
  expect(view.getByRole('combobox', { name: 'Availability' }).textContent).toContain('Closed')
  expect(view.getByRole('combobox', { name: 'Disclosure' }).textContent).toContain('Full contract')
  expect(view.getByRole('button', { name: 'Apply to session' }).disabled).toBe(false)
  expect(view.getByText(/Disclosure publication refused/)).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Apply to session' }))
  await act(async () => {})
  expect(commands.run.mock.calls.at(-1)[1]).toBe('set session tools.probe disclosure full')
  view.unmount()
})


test('composed session rules show inherited facts and frozen provenance and predict object server closure', async () => {
  const dimensions = { availability: 'enabled', disclosure: 'full', availabilitySource: 'default', disclosureSource: 'category:tool' }
  const ruleFacts = { savedRule: {}, sourceRule: {}, temporaryRule: {}, sourceDimensions: dimensions, effectiveDimensions: dimensions }
  const { view } = await sessionControlsFixture({ read: async () => [
    { id: 'mcpServers.docs', name: 'docs', category: 'server', source: { kind: 'mcp', server: 'docs' }, ...ruleFacts, effective: 'enabled', enclosingClosure: false },
    { id: 'tools.search', name: 'Search', category: 'tool', mcpServer: 'docs', source: { kind: 'mcp', server: 'docs' }, ...ruleFacts, effective: 'full' },
  ] })
  const fact = name => view.getByText(name, { selector: 'dt' }).nextElementSibling.textContent
  expect(fact('Global settings')).toBe('Use parent rules')
  expect(fact('Session inheritance')).toBe('Use parent rules')
  expect(fact('Temporary override')).toBe('None')
  expect(fact('Frozen source rule result')).toContain('category:tool')
  expect(fact('Effective dimensions and sources')).toContain('Availability: Enabled (default)')
  fireEvent.click(view.getByRole('button', { name: /^docs/ }))
  await chooseCapabilityOption(view, 'Availability', 'Closed')
  expect(view.getByRole('button', { name: /^docs/ }).textContent).toContain('Availability: Closed')
  fireEvent.click(view.getByRole('button', { name: /^Search/ }))
  const notice = () => view.getByRole('dialog').querySelector('.ptcPlusCapabilityNotice')
  expect(notice().textContent).toBe('MCP server docs has a close choice awaiting effect; child choices are retained.')
  fireEvent.click(view.getByRole('button', { name: /^docs/ }))
  await chooseCapabilityOption(view, 'Availability', 'Use parent rules')
  fireEvent.click(view.getByRole('button', { name: /^Search/ }))
  expect(notice()).toBeNull()
  view.unmount()
})

test.each(['closed', 'restore', 'unknown', 'off'])('composed session displays historical source facts and enclosing closure with new saved rules: %s', async mode => {
  const entries = [
    { id: 'mcpServers.docs', name: 'docs', category: 'server', source: { kind: 'mcp', server: 'docs' },
      savedRule: { availability: 'enabled', disclosure: 'full' },
      sessionSourceSelection: mode === 'unknown' ? 'unknown' : 'closed',
      temporaryRule: mode === 'restore' ? { availability: 'automatic', disclosure: 'automatic' } : {},
      temporary: mode === 'restore' ? 'automatic' : 'inherit',
      effective: mode === 'closed' ? 'closed' : 'enabled', enclosingClosure: mode === 'closed', managementEnabled: mode !== 'off' },
    { id: 'tools.search', name: 'Search', category: 'tool', source: { kind: 'mcp', server: 'docs' },
      savedRule: { disclosure: 'on-demand' }, sessionSourceSelection: 'full', temporaryRule: {}, temporary: 'inherit',
      effective: mode === 'closed' ? 'closed' : 'full' },
  ]
  const { view } = await sessionControlsFixture({ read: async () => structuredClone(entries) })
  const dialog = view.getByRole('dialog')
  const fact = label => within(dialog).getByText(label, { selector: 'dt' }).nextElementSibling.textContent
  expect(fact('Global settings')).toBe('Availability: Enabled · Disclosure: Full contract')
  expect(fact('Session inheritance')).toBe(mode === 'unknown' ? 'Unknown' : 'Closed')
  expect(within(dialog).queryByText('Frozen source rule result', { selector: 'dt' })).toBeNull()
  expect(within(dialog).queryByText('Effective dimensions and sources', { selector: 'dt' })).toBeNull()
  if (mode !== 'closed') await chooseCapabilityOption(view, 'Availability', 'Inherit session settings')
  fireEvent.click(view.getByRole('button', { name: /^Search/ }))
  expect(fact('Global settings')).toBe('Disclosure: On demand')
  expect(fact('Session inheritance')).toBe('Full contract')
  const notice = dialog.querySelector('.ptcPlusCapabilityNotice')
  if (['unknown', 'off'].includes(mode)) expect(notice).toBeNull()
  else expect(notice.textContent).toBe(mode === 'closed'
    ? 'MCP server docs is closed; child choices are retained.'
    : 'MCP server docs has a close choice awaiting effect; child choices are retained.')
  view.unmount()
})

test('composed rules retain source disclosure on availability inheritance and filter saved dimensions independently', async () => {
  const policy = JSON.parse(CAPABILITY_POLICY_DEFAULT)
  policy.defaults.availability = 'closed'
  policy.mcpServers.docs = { availability: 'enabled', disclosure: 'full' }
  policy.items = { 'tools.host': { availability: 'closed', disclosure: 'host' }, 'tools.adaptive': { disclosure: 'adaptive' } }
  const { view, ids, snapshot, rerender } = await capabilityWorkbenchFixture({ configuration: { capabilityPolicy: JSON.stringify(policy) }, catalog: [
    { id: 'tools.host', category: 'tool', source: { kind: 'host' } },
    { id: 'tools.adaptive', category: 'tool', source: { kind: 'host' } },
    { id: 'tools.docs', category: 'tool', mcpServer: 'docs', source: { kind: 'mcp', server: 'docs' } },
  ] })
  fireEvent.click(view.getByRole('button', { name: 'Batch settings' }))
  fireEvent.click(view.getByText('Source rules', { selector: 'summary' }))
  await chooseCapabilityOption(view, 'docs · Availability', 'Use parent rules')
  rerender(); await act(async () => {})
  expect(JSON.parse(snapshot.value.capabilityPolicy).mcpServers.docs).toEqual({ disclosure: 'full' })
  await chooseCapabilityOption(view, 'Saved disclosure', 'Host defaults')
  expect(ids()).toEqual(['tools.host'])
  await chooseCapabilityOption(view, 'Saved availability', 'Closed')
  expect(ids()).toEqual(['tools.host'])
  await chooseCapabilityOption(view, 'Saved disclosure', 'Allocate from evidence')
  expect(ids()).toEqual([])
  await chooseCapabilityOption(view, 'Saved availability', 'All strategies')
  expect(ids()).toEqual(['tools.adaptive'])
  view.unmount()
})
