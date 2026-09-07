import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { fireEvent } from '@testing-library/react'
import * as React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotTestRuntime, stubSettingsScope, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { CONFIG_FIELDS } from '../internal/config-spec.js'

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

async function clientPlugin() {
  let definition
  const source = await readFile(resolve('client.js'), 'utf8')
  const previous = window.__ModuleLoader__
  window.__ModuleLoader__ = { load(value) { definition = value } }
  try { new Function('window', source)(window) } finally { window.__ModuleLoader__ = previous }
  return definition.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`Unexpected Client module ${name}`)
  })
}

async function fixture({ enabled = true, bindings = true, conversation = true, repl = false, composer = false, rpc, watchRpc, commands, turn, setupEvents } = {}) {
  const runtime = await SlotTestRuntime.create()
  cleanups.push(() => runtime.dispose())
  const settings = stubSettingsScope()
  const value = { ...Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field.default])), enabled, userBindingsEnabled: bindings }
  settings.publish({ status: 'ready', writable: true, value })
  runtime.ctx.provide('settingsScope', { bind: () => settings.scope })
  const rpcCalls = []
  runtime.ctx.provide('connection', { rpc: { call: async (channel, endpoint, payload, signal) => {
    if (channel === '/ptc-plus-repl') {
      rpcCalls.push({ endpoint, payload, signal })
      if (watchRpc) return watchRpc(payload, signal)
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ ok: true, value: null }), { once: true })
      })
    }
    rpcCalls.push({ endpoint, payload })
    return rpc ? rpc(endpoint, payload, signal) : { ok: true, value: null }
  } } })
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
  const remote = commands ? new TestRemote(runtime.ctx, { commands }) : undefined
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
    'conversation.view': { kind: 'list', scope: 'session' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  }, props => React.createElement(React.Fragment, null,
    props.renderSlot('settings.plugin.item', {}, { entryKey: 'ptc-plus' }),
    React.createElement(props.SessionProvider, null,
      props.renderSlot('conversation.session.header.actions', {}),
      props.renderSlot('conversation.input.left', {}),
      repl ? props.renderSlot('conversation.view', {}, { entryId: 'ptc-plus-repl' }) : null,
      composer ? props.renderSlotChain('conversation.composer', { sessionId: 'client-session' }, {
        overlay: true, fallback: React.createElement('textarea', { 'aria-label': 'Message draft', defaultValue: 'keep this draft' }),
      }) : null,
      turn ? props.renderSlot('conversation.chat.commandview', { node: turn.data.get('ptc-binding-authoring') }, {
        entryKey: 'binding', fallback: React.createElement('p', { 'data-generic-command': true }, 'Generic admission'),
      }) : null,
      turn ? props.renderSlotChain('conversation.chat.turnTail', { turn }) : null)))
  const plugin = await clientPlugin()
  const feature = await runtime.mount(plugin)
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
    expect(rpcCalls.filter(call => call.endpoint === 'load')).toHaveLength(1)
  }
  fireEvent.click(button('Save'))
  await runtime.flush()
  const saves = rpcCalls.filter(call => call.endpoint === 'save')
  expect(saves.map(call => call.payload.expectedRevision)).toEqual([1, 2])
  expect(saves[1].payload.entry).toMatchObject({ source, name: 'myDraft' })
  expect(workbench().querySelector('.ptcPlusSourceBody .cm-content')).toBeNull()
  expect(workbench().textContent).toContain('Entry saved')
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
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{font-family:Arial,sans-serif;color:#202124;background:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#666;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#fff;--dsw-alias-border-l2:#e0e1e3;--dsw-alias-border-l3:#bbb;--dsw-alias-border-l4:#ddd;--dsw-alias-button-primary-fill:#242629;--dsw-alias-state-success-primary:#168052;--dsw-alias-markdown-code-block:#f6f7f8;--dsw-alias-interactive-primary:#365bbb;--dsw-alias-bg-mask-1:#0005}
      body{margin:0}button,input,textarea,select{font-family:inherit}*{box-sizing:border-box}
      ${css.join('\n')}\n${editorStyles}\n${document.getElementById('ptc-plus-client-style').textContent}
      </style></head><body>${element.outerHTML}</body></html>`
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
  expect(view.container.querySelectorAll('.ptcPlusGlobalItem .ptcPlusBindingState')[0].textContent).toBe('Disabled')
  expect(view.container.querySelectorAll('.ptcPlusGlobalItem .ptcPlusBindingState')[1].textContent).toBe('Enabled')
  expect(card().textContent).not.toContain('Host admission text')
  expect(view.container.querySelector('[data-generic-command]')).toBeNull()
  expect(view.container.querySelectorAll('.ptcPlusBindingCommand')).toHaveLength(1)
  expect(runtime.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  const save = () => [...card().querySelectorAll('button')].find(button => button.textContent === 'Save and enable')
  expect(save().className).not.toContain('ptcPlusButton')
  fireEvent.click(save())
  await runtime.flush()
  expect(card().textContent).toContain('Catalog revision changed')
  expect(save()).toBeDefined()
  expect(card().textContent).toContain(entry.source)
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
  fireEvent.click(view.getByRole('button', { name: 'Ask Agent to write a Global User Binding' }))
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
  expect(view.queryByRole('button', { name: 'Ask Agent to write a Global User Binding' })).toBeNull()
  list.mockResolvedValue({ ok: true, value: [{ name: 'binding' }] })
  remote.emit('commands/change', [])
  await runtime.flush()
  expect(view.queryByRole('button', { name: 'Ask Agent to write a Global User Binding' })).not.toBeNull()
  settings.publish({ value: { ...value, bindingAuthorButtonVisible: false } })
  await runtime.flush()
  expect(view.queryByRole('button', { name: 'Ask Agent to write a Global User Binding' })).toBeNull()
  expect(input.scope.getSnapshot().draft).toBe('/binding new ')
  expect(source.getSnapshot()).toBe(true)
  settings.publish({ value })
  await runtime.flush()
  expect(view.queryByRole('button', { name: 'Ask Agent to write a Global User Binding' })).not.toBeNull()
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
  expect(view.container.textContent).toContain(phase === 'pending' ? 'Agent is writing a draft...' : 'No saveable draft was produced')
  setLocale('zh')
  await runtime.flush()
  expect(view.container.textContent).toContain(phase === 'pending' ? 'Agent 正在编写草稿...' : '未生成可保存的草稿')
  if (phase === 'failed') expect(view.container.textContent).toContain(rawError)
})

test.each(['empty', 'conflict'])('draft card distinguishes revoked locators from failed reads: %s', async response => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let revoked = false
  const draft = { version: 1, entry: { name: 'test-helper', scope: 'namespace', symbols: ['value'], source: 'export const value = 1' } }
  const rpc = vi.fn(async endpoint => {
    if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [] } }
    if (endpoint === 'draft' && revoked && response === 'conflict') return { ok: false, error: { code: 'BINDINGS_CONFLICT', message: 'Draft expired' } }
    return { ok: true, value: revoked ? null : draft }
  })
  const turn = { data: new Map([['ptc-binding-authoring', { commandId: 'draft-command', args: ' new helper', outcome: null }]]) }
  const { runtime, feature } = await fixture({ rpc, turn })
  runtime.sessions.behavior('client-session').projections.set('ptcPlusBindingDraft', {
    phase: 'ready', capability: 'opaque-draft', commandId: 'draft-command',
  })
  const view = runtime.renderRoot()
  await runtime.flush()
  expect(view.container.querySelector('.ptcPlusBindingCommand .ptcPlusAuthoringDraft')).not.toBeNull()
  revoked = true
  await vi.advanceTimersByTimeAsync(1500)
  await runtime.flush()
  if (response === 'empty') {
    expect(view.container.querySelector('.ptcPlusBindingCommand .ptcPlusAuthoringDraft')).toBeNull()
    expect(view.container.querySelector('.ptcPlusBindingCommand').dataset.phase).toBe('idle')
  } else {
    expect(view.container.querySelector('.ptcPlusBindingCommand .ptcPlusAuthoringDraft')).not.toBeNull()
  }
  await feature.dispose()
  const calls = rpc.mock.calls.length
  await vi.advanceTimersByTimeAsync(4500)
  expect(rpc).toHaveBeenCalledTimes(calls)
})

test('missing optional conversation provider leaves settings active and can arrive later', async () => {
  const { runtime, events, settings, provideConversation } = await fixture({ conversation: false })
  expect(events.entries()).toHaveLength(0)
  const view = runtime.renderRoot()
  expect(view.container.textContent).toContain('PTC Plus')
  const provider = await provideConversation()
  await runtime.flush()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  await provider.dispose()
  expect(events.entries()).toHaveLength(0)
  expect(view.container.textContent).toContain('PTC Plus')
  await provideConversation()
  expect(runtime.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  settings.publish({ value: { enabled: false, userBindingsEnabled: true } })
  await runtime.flush()
  expect(events.entries()).toHaveLength(0)
})

test('legacy-only providers do not select an incomplete Client path', async () => {
  const { runtime, events } = await fixture({ conversation: false })
  runtime.ctx.provide('conversationEvents', events)
  await runtime.flush()
  const view = runtime.renderRoot()
  expect(view.container.querySelector('.ptcPlusCard')).not.toBeNull()
  expect(view.container.querySelector('.ptcPlusActive')).not.toBeNull()
  expect(events.entries()).toHaveLength(0)
  expect(runtime.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
})
