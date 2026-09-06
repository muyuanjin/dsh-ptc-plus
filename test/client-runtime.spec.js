import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import * as React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotTestRuntime, stubSettingsScope, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { CONFIG_FIELDS } from '../internal/config-spec.js'

const cleanups = []
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

async function fixture({ enabled = true, bindings = true, conversation = true, rpc, commands, turn, setupEvents } = {}) {
  const runtime = await SlotTestRuntime.create()
  cleanups.push(() => runtime.dispose())
  const settings = stubSettingsScope()
  const value = { ...Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field.default])), enabled, userBindingsEnabled: bindings }
  settings.publish({ status: 'ready', writable: true, value })
  runtime.ctx.provide('settingsScope', { bind: () => settings.scope })
  const rpcCalls = []
  runtime.ctx.provide('connection', { rpc: { call: async (_channel, endpoint, payload) => {
    rpcCalls.push({ endpoint, payload })
    return rpc ? rpc(endpoint, payload) : { ok: true, value: null }
  } } })
  const dictionaries = new Map()
  const localeSnapshot = { active: 'en', locales: [], revision: 0 }
  const localeListeners = new Set()
  runtime.ctx.provide('locale', {
    register(namespace, dictionary) { dictionaries.set(namespace, dictionary); return () => dictionaries.delete(namespace) },
    bind: namespace => key => dictionaries.get(namespace)?.[localeSnapshot.active]?.[key] ?? key,
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
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  }, props => React.createElement(React.Fragment, null,
    props.renderSlot('settings.plugin.item', {}, { entryKey: 'ptc-plus' }),
    React.createElement(props.SessionProvider, null,
      props.renderSlot('conversation.session.header.actions', {}),
      props.renderSlot('conversation.input.left', {}),
      turn ? props.renderSlot('conversation.chat.commandview', { node: turn.data.get('ptc-binding-authoring') }, {
        entryKey: 'binding', fallback: React.createElement('p', { 'data-generic-command': true }, 'Generic admission'),
      }) : null,
      turn ? props.renderSlotChain('conversation.chat.turnTail', { turn }) : null)))
  const plugin = await clientPlugin()
  const feature = await runtime.mount(plugin)
  return { runtime, settings, value, events, feature, provideConversation, conversationProvider, remote, input, rpcCalls,
    setLocale(active) { localeSnapshot.active = active; localeSnapshot.revision++; for (const listener of localeListeners) listener() } }
}

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
  const { runtime, remote, input, feature } = await fixture({ commands: { list } })
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
