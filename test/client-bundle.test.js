import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { CONFIG_FIELDS, CONFIG_GROUPS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)

// Bundle smoke only. Reactive ownership is exercised by client-runtime.spec.js.
function smokeComponent(options, component, defaultProps = () => ({})) {
  const subscribed = new WeakSet()
  return props => {
    const injected = options.inject?.(props.sessionId ?? 'session-1') ?? {}
    const { hooks = {}, ...callbacks } = injected
    const bound = Object.fromEntries(Object.entries(hooks).map(([key, source]) => {
      if (!subscribed.has(source)) {
        subscribed.add(source)
        source.subscribe(() => {})
      }
      return [`use${key[0].toUpperCase()}${key.slice(1)}`, (selector = value => value) => selector(source.getSnapshot())]
    }))
    let result = component({ ...defaultProps(props), ...callbacks, ...bound, ...props })
    while (typeof result?.type === 'function') result = result.type(result.props)
    return result
  }
}

const EMPTY_VALUE_WIRE = Object.freeze({
  codec: 'ptc-value-graph/v1',
  root: Object.freeze({ tag: 'undefined' }),
  nodes: Object.freeze([]),
})

function journal({ version = 3, status = 'durable', calls = [], diagnostics = [], confirms = [] } = {}) {
  return {
    version,
    bindingMode: 'loose',
    ...(version === 1 ? {} : {
      rewritePolicy: {
        autoRewriteImports: true,
        autoStripExports: true,
        autoSplitRedeclarations: true,
      },
    }),
    status,
    calls,
    operations: [],
    confirms,
    diagnostics,
    ...(['durable', 'volatile'].includes(status)
      ? { completion: { kind: 'return', hasValue: false } }
      : {}),
  }
}

function successfulCall(settle) {
  return {
    global: 'tools', member: 'read', args: EMPTY_VALUE_WIRE,
    ok: true, value: EMPTY_VALUE_WIRE, settle,
  }
}

function diagnostic() {
  return {
    code: 'PTC-T001', severity: 'note', phase: 'execute', message: 'Recorded.',
    stateEffect: 'unchanged',
  }
}

test('keeps generated client bundle checkout bytes stable', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const attribute = execFileSync('git', ['check-attr', 'eol', '--', 'client.js'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  assert.equal(attribute, 'client.js: eol: lf')
})

test('checked client bundle is loadable through the DSH module loader contract', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const sourceModule = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const registrations = []
  const window = { __ModuleLoader__: { load(value) { registrations.push(value) } } }
  runInNewContext(source, { window, TextEncoder })
  assert.equal(registrations.length, 1)
  const loaded = registrations[0]
  assert.equal(loaded.id, packageJson.name)
  const React = { createElement() {}, useState() {}, useRef() {}, useCallback(value) { return value }, useSyncExternalStore() {}, useEffect() {} }
  const primitives = {
    CodeBlock() {},
    IconCheckOutline14() {},
    IconChevronDownOutline14() {},
    IconInspectOutline12() {},
    IconSparkle16() {},
    StateDot() {},
    Toast() {},
    Tooltip() {},
  }
  const exported = loaded.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  assert.equal(Array.from(exported.inject).join(','), 'settingsScope,slots,locale,connection')
  assert.doesNotMatch(sourceModule, /useConversation|scope\.sessions|conversationEvents/)
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.equal(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-session'), false)
  assert.equal(typeof exported.apply, 'function')
  assert.match(source, /settings\.plugin\.item/)
  assert.match(source, /conversation\.session\.header\.actions/)
  assert.match(source, /tool\.call\.toolview/)
  assert.match(source, /ptcPlusDescription/)
  assert.match(source, /aria-label/)
  assert.match(sourceModule, /PTC 模式的会话级 TypeScript REPL。/)
  assert.match(sourceModule, /收起 PTC Plus 设置/)
  assert.match(sourceModule, /展开 PTC Plus 设置/)
  assert.match(sourceModule, /设置会在修改后立即生效/)
  assert.doesNotMatch(sourceModule, /仅 enabled 即时生效/)
  assert.match(sourceModule, /The session-bound TypeScript REPL for PTC mode\./)
  assert.match(sourceModule, /bindings\.symbolsPlaceholder/)
  assert.match(sourceModule, /bindings\.draftSaveEnable/)
  assert.match(sourceModule, /hidden: !open/)
  assert.match(sourceModule, /ptcPlusBindingSection/)
  assert.match(sourceModule, /ptcPlusBindingDebug/)
  assert.match(sourceModule, /StateDot/)
  assert.match(sourceModule, /留空则从源码推导/)
  assert.match(sourceModule, /blank derives from source/)
  assert.match(sourceModule, /symbolsText\.split\(','\)/)
  assert.match(sourceModule, /entry: bindingPayload\(editableBinding\(normalized\)\)/)
  assert.match(sourceModule, /Expand PTC Plus settings/)
  assert.doesNotMatch(sourceModule, /ptcPlusActivityPanel/)
  assert.match(sourceModule, /CodeBlock/)
  assert.match(sourceModule, /DisclosureRow/)
  assert.doesNotMatch(sourceModule, /rowClassName|leadingClassName|chevronClassName|titleClassName/)
  assert.match(sourceModule, /align-items:center/)
  assert.match(sourceModule, /\.ptcPlusToolSummary\{[^}]*box-sizing:border-box[^}]*min-height:32px[^}]*align-items:center/)
  assert.match(sourceModule, /\.ptcPlusToolState\{[^}]*height:20px[^}]*align-items:center[^}]*[^}]*line-height:20px/)
  assert.match(sourceModule, /\.ptcPlusToolDescription\{[^}]*min-height:20px[^}]*align-items:center/)
  assert.match(sourceModule, /\.ptcPlusToolPreview\{[^}]*overflow:hidden/)
  assert.match(sourceModule, /\.ptcPlusToolPreview \.ptcPlusFeatures\{[^}]*flex-wrap:nowrap[^}]*overflow:hidden/)
  assert.doesNotMatch(sourceModule, /\.ptcPlusToolDescription\{[^}]*;height:20px/)
  assert.match(sourceModule, /\.ptcPlusIoCard\{[^}]*border-radius:12px[^}]*--dsw-alias-markdown-code-block/)
  assert.match(sourceModule, /\.ptcPlusIoText\[data-error\]\{/)
  assert.match(sourceModule, /\.ptcPlusInspect\{[^}]*border-radius:999px[^}]*opacity:0[^}]*transition:opacity/)
  assert.match(sourceModule, /\.ptcPlusTool:hover \.ptcPlusInspect/)
  assert.match(sourceModule, /\.ptcPlusInspect:focus-visible/)
  assert.doesNotMatch(sourceModule, /\.ptcPlusToolCode\.md-code-block>:first-child:has\(button\)/)
  assert.doesNotMatch(sourceModule, /feature\.volatile|feature\.discarded/)
  assert.doesNotMatch(sourceModule, /activity\.cells|activity\.recoveries/)
  assert.match(sourceModule, /\.ptcPlusActive\{[^}]*--dsw-alias-state-success-primary/)
  assert.match(sourceModule, /\.ptcPlusReplPopover\{[^}]*position:fixed[^}]*z-index:2147483000/)
  assert.match(sourceModule, /\.ptcPlusReplPopover:popover-open/)
  assert.match(sourceModule, /\.ptcPlusReplList\{[^}]*overflow:auto[^}]*overscroll-behavior:contain/)
  assert.match(sourceModule, /\.ptcPlusReplName\[data-kind=variable\]/)
  assert.match(sourceModule, /\.ptcPlusReplName\[data-kind=function\]/)
  assert.match(sourceModule, /\.ptcPlusReplName\[data-kind=class\]/)
  assert.match(sourceModule, /\.ptcPlusReplName\[data-kind=import\]/)
  assert.match(sourceModule, /\.ptcPlusReplBinding\{grid-template-columns:minmax\(0,1fr\) 24px/)
  assert.match(sourceModule, /\.ptcPlusReplDefinitionWrap\{[^}]*grid-template-rows:0fr[^}]*transition:grid-template-rows/)
  assert.match(sourceModule, /content-visibility:auto/)
  assert.match(sourceModule, /popover\.showPopover\(\)/)
  assert.match(sourceModule, /normalizeReplMemorySnapshot/)
  assert.match(sourceModule, /ptcPlusToolState/)
  assert.doesNotMatch(sourceModule, /ptcPlusVisuallyHidden/)
  assert.doesNotMatch(sourceModule, /saveSettings/)
  assert.doesNotMatch(source, /PTC 模式\+/)
  assert.equal(typeof require('esbuild').build, 'function')
})

test('settings, header indicator, and tool rows follow the DSH locale dictionaries', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const registrations = []
  const window = {
    __ModuleLoader__: { load(value) { registrations.push(value) } },
    addEventListener() {},
    removeEventListener() {},
  }
  const document = {
    documentElement: { style: {} },
    getElementById: () => ({ remove() {} }),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    activeElement: null,
  }
  runInNewContext(source, {
    window,
    document,
    AbortController,
    TextEncoder,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: value => ({ current: value }),
    useCallback: value => value,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: effect => effect(),
  }
  const primitives = {
    CodeBlock() {},
    DisclosureRow() {},
    IconCheckOutline14: 'IconCheck',
    IconChevronDownOutline14: 'IconChevron',
    IconInspectOutline12: 'IconInspect',
    IconSparkle16() {},
    StateDot: 'StateDot',
    Toast() {},
    Tooltip() {},
  }
  const exported = registrations[0].factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  const dictionaries = []
  const slotEntries = []
  const conversationDefinitions = []
  const preferenceListeners = new Set()
  const remoteListeners = new Map()
  const clientListeners = new Map()
  let commandDescriptors = [{ name: 'binding', description: 'Author a binding' }]
  let settingsSnapshot = { status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: true } }
  let sessionSnapshot = {
    byId: { 'session-1': { projectionValues: { agentPreset: 'ptc' } } },
  }
  const preferenceScope = {
    subscribe: (listener) => {
      preferenceListeners.add(listener)
      return () => preferenceListeners.delete(listener)
    },
    getSnapshot: () => settingsSnapshot,
  }
  const sessions = {
    subscribe: () => () => {},
    getSnapshot: () => sessionSnapshot,
  }
  const ctx = {
    settingsScope: { bind: () => preferenceScope },
    effect: register => register(),
    slots: {
      inject: (_key, factory) => {
        const value = factory()
        if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
          for (const _entry of value) { /* consume registration disposers */ }
        }
        return () => {}
      },
      register: (options, component) => {
        const entry = { options, component: smokeComponent(options, component, props => ({
          useProjection: key => sessionSnapshot.byId?.[props.sessionId ?? 'session-1']?.projectionValues?.[key],
          useSessions: selector => selector(sessionSnapshot),
          useInput: selector => selector({ draft: '' }),
        })), active: true }
        slotEntries.push(entry)
        return () => { entry.active = false }
      },
    },
    inject: (services, callback) => services.includes('sessions') ? undefined : callback(ctx),
    uiSession: {},
    uiConversation: {
      events: {
        register: definition => {
          conversationDefinitions.push(definition)
          return () => {}
        },
      },
    },
    locale: {
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
      bind: () => key => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
    },
    connection: {
      rpc: {
        call: async () => ({
          ok: true,
          value: { version: 1, revision: 0, fingerprint: '0'.repeat(64), entries: [] },
        }),
      },
    },
    remote: {
      commands: {
        list: async () => ({ ok: true, value: commandDescriptors }),
      },
      $on(name, listener) { remoteListeners.set(name, listener) },
    },
    on(name, listener) { clientListeners.set(name, listener); return () => clientListeners.delete(name) },
  }
  exported.apply(ctx)

  assert.deepEqual(conversationDefinitions, [])
  assert.equal(dictionaries.length, 1)
  const { ns, dicts } = dictionaries[0]
  assert.equal(ns, 'settings.ptcPlus')
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort())
  for (const field of CONFIG_FIELDS) {
    assert.equal(dicts.zh[`${field.key}.label`], field.label)
    assert.equal(dicts.en[`${field.key}.label`], field.labelEn)
    assert.equal(dicts.zh[`${field.key}.description`] ?? '', field.description)
    assert.equal(dicts.en[`${field.key}.description`] ?? '', field.descriptionEn)
  }
  assert.equal(dicts.en['card.description'], 'The session-bound TypeScript REPL for PTC mode.')
  for (const group of CONFIG_GROUPS) {
    assert.equal(dicts.zh[`group.${group.key}`], group.label)
    assert.equal(dicts.en[`group.${group.key}`], group.labelEn)
  }

  const [card] = slotEntries.filter(({ options }) => options.name === 'settings.plugin.item')
  const [indicator] = slotEntries.filter(({ options }) => options.name === 'conversation.session.header.actions')
  const [authorButton] = slotEntries.filter(({ options }) => options.id === 'ptc-plus-binding-author')
  const [bindingCommand] = slotEntries.filter(({ options }) => options.name === 'conversation.chat.commandview')
  assert.equal(indicator.component({ useProjection: undefined }), null)
  assert.equal(slotEntries.some(({ options }) => options.name === 'conversation.chat.turnTail'), false)
  const toolviews = slotEntries.filter(({ options }) => options.name === 'tool.call.toolview')
  assert.equal(card.options.locale, ns)
  assert.equal(card.options.key, SETTINGS_NAMESPACE)
  assert.equal(indicator.options.locale, ns)
  assert.equal(indicator.options.id, 'ptc-plus-active')
  assert.equal(authorButton.options.id, 'ptc-plus-binding-author')
  assert.equal(bindingCommand.options.key, 'binding')
  assert.equal(bindingCommand.options.locale, ns)
  assert.deepEqual(toolviews.map(({ options }) => options.key), ['run_code', 'edit_run_code'])
  assert.equal(toolviews.every(({ options }) => options.locale === ns), true)
  const collectTexts = (value) => {
    const texts = []
    const collect = current => {
      if (typeof current === 'string') { texts.push(current); return }
      if (typeof current === 'number') { texts.push(String(current)); return }
      if (Array.isArray(current)) { current.forEach(collect); return }
      if (current && typeof current === 'object' && 'children' in current) {
        if (typeof current.props?.['aria-label'] === 'string') texts.push(current.props['aria-label'])
        if (typeof current.props?.title === 'string') texts.push(current.props.title)
        if (typeof current.props?.code === 'string') texts.push(current.props.code)
        current.children.forEach(collect)
        if (current.props?.collapsedContent !== undefined) collect(current.props.collapsedContent)
        if (current.props?.children !== undefined && current.props.children !== null) {
          collect(current.props.children)
        }
      }
    }
    collect(value)
    return texts
  }
  const findComponent = (value, name) => {
    if (Array.isArray(value)) {
      return value.map(item => findComponent(item, name)).find(Boolean)
    }
    if (!value || typeof value !== 'object') return undefined
    if (typeof value.type === 'function' && value.type.name === name) return value
    return findComponent(value.children, name)
      ?? findComponent(value.props?.children, name)
  }

  const commandCard = bindingCommand.component({
    node: {
      commandId: 'command-1', args: ' new 写一个只读文件工具',
      outcome: { kind: 'success', text: 'Binding draft requested.' },
    },
    t: key => key,
    useProjection: key => key === 'ptcPlusBindingDraft'
      ? { phase: 'pending', capability: null, commandId: 'command-1' }
      : undefined,
  })
  assert.ok(collectTexts(commandCard).includes('/binding new 写一个只读文件工具'))
  assert.ok(collectTexts(commandCard).includes('bindings.commandPending'))

  const failedCommandCard = bindingCommand.component({
    node: {
      commandId: 'command-error', args: ' new 失败的工具',
      outcome: { kind: 'error', text: 'Authoring failed.' },
    },
    t: key => key,
    useProjection: key => key === 'ptcPlusBindingDraft'
      ? { phase: 'pending', capability: null, commandId: 'command-error' }
      : undefined,
  })
  assert.equal(failedCommandCard.props['data-phase'], 'failed')
  assert.ok(collectTexts(failedCommandCard).includes('bindings.commandFailed'))
  assert.ok(collectTexts(failedCommandCard).includes('Authoring failed.'))
  assert.equal(collectTexts(failedCommandCard).includes('bindings.commandPending'), false)

  settingsSnapshot = {
    status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: true },
  }
  assert.equal(findComponent(card.component({ t: key => key }), 'UserBindingsWorkbench'), undefined)
  const beforeDialogState = React.useState
  const beforeDialogEffect = React.useEffect
  React.useState = initial => [typeof initial === 'boolean' ? true : typeof initial === 'function' ? initial() : initial, () => {}]
  React.useEffect = () => {}
  const dialog = findComponent(card.component({ t: key => key }), 'BindingsDialog')
  const workbench = findComponent(dialog.type(dialog.props), 'UserBindingsWorkbench')
  React.useState = beforeDialogState
  React.useEffect = beforeDialogEffect
  assert.notEqual(workbench, undefined)
  const workbenchState = []
  const workbenchRefs = []
  let workbenchStateCursor = 0
  let workbenchRefCursor = 0
  const workbenchOriginalUseState = React.useState
  const workbenchOriginalUseRef = React.useRef
  const workbenchOriginalUseEffect = React.useEffect
  const originalRpcCallForWorkbench = ctx.connection.rpc.call
  const renderWorkbench = (runEffects) => {
    workbenchStateCursor = 0
    workbenchRefCursor = 0
    const effects = []
    React.useState = initial => {
      const index = workbenchStateCursor++
      if (!(index in workbenchState)) {
        workbenchState[index] = typeof initial === 'function' ? initial() : initial
      }
      return [workbenchState[index], value => {
        workbenchState[index] = typeof value === 'function' ? value(workbenchState[index]) : value
      }]
    }
    React.useRef = initial => {
      const index = workbenchRefCursor++
      if (!(index in workbenchRefs)) workbenchRefs[index] = { current: initial }
      return workbenchRefs[index]
    }
    React.useEffect = effect => { if (runEffects) effects.push(effect) }
    try {
      const rendered = workbench.type(workbench.props)
      effects.forEach(effect => effect())
      return rendered
    } finally {
      React.useState = workbenchOriginalUseState
      React.useRef = workbenchOriginalUseRef
      React.useEffect = workbenchOriginalUseEffect
    }
  }
  ctx.connection.rpc.call = async () => ({
    ok: false, error: { message: 'binding route unavailable' },
  })
  assert.ok(collectTexts(renderWorkbench(true)).includes('bindings.loading'))
  await new Promise(resolve => setImmediate(resolve))
  const failedWorkbench = collectTexts(renderWorkbench(false))
  assert.ok(failedWorkbench.includes('bindings.failed'))
  assert.equal(failedWorkbench.includes('bindings.loading'), false)
  ctx.connection.rpc.call = originalRpcCallForWorkbench

  const toggleState = [
    {
      revision: 4,
      entries: [
        { id: 'enabled', name: 'Enabled entry', scope: 'namespace', symbols: ['enabled'], enabled: true },
        { id: 'disabled', name: 'Disabled entry', scope: 'namespace', symbols: ['disabled'], enabled: false },
      ],
    },
    null, '', '', null, null, false, false, 0, null, false, '', false,
  ]
  let toggleStateCursor = 0
  React.useState = () => [toggleState[toggleStateCursor++], () => {}]
  React.useRef = value => ({ current: value })
  React.useEffect = () => {}
  const toggleWorkbench = workbench.type(workbench.props)
  React.useState = workbenchOriginalUseState
  React.useRef = workbenchOriginalUseRef
  React.useEffect = workbenchOriginalUseEffect
  const toggleTexts = collectTexts(toggleWorkbench)
  assert.ok(toggleTexts.includes('bindings.disableAction'))
  assert.ok(toggleTexts.includes('bindings.enableAction'))
  assert.ok(toggleTexts.includes('Enabled entry: bindings.enabled'))
  assert.ok(toggleTexts.includes('Disabled entry: bindings.enabled'))

  const keys = collectTexts(card.component({ t: key => `[[${key}]]` }))
  assert.ok(keys.includes('[[card.description]]'))
  assert.ok(keys.includes('[[status.enabled]]'))
  assert.ok(keys.includes('[[action.expand]]'))
  assert.ok(keys.includes('[[footer.live]]'))
  for (const field of CONFIG_FIELDS) {
    assert.equal(keys.filter(text => text === `[[${field.key}.label]]`).length, 2)
    if (field.description !== '') assert.ok(keys.includes(`[[${field.key}.description]]`))
    else assert.equal(keys.includes(`[[${field.key}.description]]`), false)
    assert.equal(keys.includes(field.label), false)
  }

  for (const locale of ['zh', 'en']) {
    const t = key => dicts[locale][key] ?? key
    const texts = collectTexts(card.component({ t }))
    const opposite = locale === 'zh' ? 'en' : 'zh'
    assert.ok(texts.includes(dicts[locale]['card.description']))
    assert.ok(texts.includes(dicts[locale]['status.enabled']))
    assert.ok(texts.includes(dicts[locale]['action.expand']))
    assert.ok(texts.includes(dicts[locale]['footer.live']))
    assert.equal(texts.includes(dicts[opposite]['card.description']), false)
    for (const field of CONFIG_FIELDS) {
      assert.equal(texts.filter(text => text === dicts[locale][`${field.key}.label`]).length, 2)
      if (field.description !== '') assert.ok(texts.includes(dicts[locale][`${field.key}.description`]))
    }

    const indicatorTexts = collectTexts(indicator.component({
      sessionId: 'session-1',
      t,
    }))
    assert.ok(indicatorTexts.includes(dicts[locale]['indicator.title']))
    assert.ok(indicatorTexts.includes('PTC Plus'))
    assert.equal(indicatorTexts.includes(dicts[opposite]['indicator.title']), false)
  }

  const renderIndicator = (session, enabled = true) => {
    sessionSnapshot = { byId: { 'session-1': session } }
    settingsSnapshot = { status: 'ready', writable: true, value: { enabled } }
    return indicator.component({
      sessionId: 'session-1',
      t: key => key,
    })
  }
  assert.notEqual(renderIndicator({ projectionValues: { agentPreset: 'ptc' } }), null)
  assert.notEqual(renderIndicator({ agentPreset: 'code' }), null)
  assert.equal(renderIndicator({ agentPreset: 'chat' }), null)
  assert.equal(renderIndicator({ projectionValues: { agentPreset: undefined }, agentPreset: 'code' }), null)
  assert.notEqual(renderIndicator({
    projectionValues: { agentPreset: 'ptc' }, agentPreset: 'unrelated',
  }), null)
  assert.equal(renderIndicator({
    projectionValues: { agentPreset: 'unrelated' }, agentPreset: 'code',
  }), null)
  assert.equal(renderIndicator({ projectionValues: { agentPreset: 'chat' } }), null)
  assert.equal(renderIndicator({ projectionValues: { agentPreset: 'ptc' } }, false), null)

  const standardKitSession = {
    sessionId: 'session-1',
    projectionValues: { agentPreset: 'ptc' },
  }
  settingsSnapshot = { status: 'ready', writable: true, value: { enabled: true } }
  const standardKitIndicator = indicator.component({
    sessionId: 'session-1',
    t: key => key,
    useSession: selector => selector(standardKitSession),
    useProjection: key => key === 'ptcPlusRepl' ? {
      available: true, entries: [], total: 0, omitted: 0,
    } : key === 'agentPreset' ? 'ptc' : undefined,
    useSessions: selector => selector({ byId: {} }),
  })
  assert.notEqual(standardKitIndicator, null)

  const composerDrafts = []
  settingsSnapshot = {
    status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: true },
  }
  const authoringIndicator = indicator.component({
    sessionId: 'session-1',
    t: key => key,
    useInput: selector => selector({ draft: '' }),
    inputActions: { setDraft: value => composerDrafts.push(value) },
  })
  const authoringCard = authoringIndicator.children.find(child => typeof child?.type === 'function')
  authoringCard.props.prefillAuthoring('/binding new ')
  assert.deepEqual(composerDrafts, ['/binding new '])
  const occupiedComposerIndicator = indicator.component({
    sessionId: 'session-1',
    t: key => key,
    useInput: selector => selector({ draft: 'keep this text' }),
    inputActions: { setDraft: value => composerDrafts.push(value) },
  })
  const occupiedComposerCard = occupiedComposerIndicator.children
    .find(child => typeof child?.type === 'function')
  occupiedComposerCard.props.prefillAuthoring('/binding edit alpha ')
  assert.deepEqual(composerDrafts, ['/binding new '])

  sessionSnapshot = { byId: { 'session-1': { projectionValues: {} } } }
  const authorProps = {
    sessionId: 'session-1',
    t: key => key,
    useConversation: selector => selector({ sessionId: 'session-1' }),
    useInput: selector => selector({ draft: '' }),
    inputActions: { setDraft: value => composerDrafts.push(value) },
  }
  assert.equal(authorButton.component(authorProps), null)
  await new Promise(resolve => setImmediate(resolve))
  const authorControl = authorButton.component(authorProps)
  assert.notEqual(authorControl, null)
  assert.equal(authorButton.component({ ...authorProps, useInput: undefined }), null)
  const authorAction = authorControl.children[0].children[0]
  assert.equal(authorAction.type, 'button')
  assert.equal(authorAction.props['aria-label'], 'bindings.authorOpen')
  let focusPreserved = false
  authorAction.props.onMouseDown({ preventDefault() { focusPreserved = true } })
  assert.equal(focusPreserved, true)
  authorAction.props.onClick()
  assert.deepEqual(composerDrafts, ['/binding new ', '/binding new '])
  const occupiedAuthorControl = authorButton.component({
    ...authorProps,
    useInput: selector => selector({ draft: 'keep this text' }),
  })
  occupiedAuthorControl.children[0].children[0].props.onClick()
  assert.deepEqual(composerDrafts, ['/binding new ', '/binding new '])

  commandDescriptors = []
  remoteListeners.get('commands/change')()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(authorButton.component(authorProps), null)
  commandDescriptors = [{ name: 'binding' }]
  remoteListeners.get('agent-preset/selected')('session-1')
  await new Promise(resolve => setImmediate(resolve))
  assert.notEqual(authorButton.component(authorProps), null)
  commandDescriptors = []
  clientListeners.get('connection/reset')()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(authorButton.component(authorProps), null)

  const memoryIndicator = renderIndicator({
    projectionValues: {
      agentPreset: 'ptc',
      ptcPlusRepl: {
        available: true,
        entries: [
          {
            name: 'Widget', kind: 'class',
            definition: { source: 'class Widget {}', line: 2, column: 1 },
          },
          {
            name: 'answer', kind: 'variable',
            definition: { source: 'const answer = 42', line: 1, column: 1 },
          },
        ],
        total: 2,
        omitted: 0,
      },
    },
  })
  const memoryTrigger = memoryIndicator.children.find(child => child?.props?.className === 'ptcPlusActive')
  assert.equal(memoryTrigger.type, 'button')
  assert.equal(memoryTrigger.props.type, 'button')
  assert.equal(memoryTrigger.props['aria-expanded'], false)
  assert.equal(memoryTrigger.props['aria-haspopup'], 'dialog')
  assert.match(memoryTrigger.props['aria-controls'], /^ptc-plus-repl-/)
  const memoryComponent = memoryIndicator.children.find(child => typeof child?.type === 'function')
  const memoryCard = memoryComponent.type(memoryComponent.props)
  assert.equal(memoryCard.props.popover, 'auto')
  assert.equal(memoryCard.props.role, 'dialog')
  const memoryTexts = collectTexts(memoryCard)
  assert.ok(memoryTexts.includes('memory.title'))
  assert.equal(memoryTexts.includes('memory.globalTab'), false)
  assert.ok(memoryTexts.includes('Widget'))
  assert.ok(memoryTexts.includes('answer'))
  assert.equal(memoryTexts.includes('memory.kind.class'), false)
  assert.equal(memoryTexts.includes('memory.kind.variable'), false)
  const findByClass = (value, className) => {
    if (Array.isArray(value)) return value.map(item => findByClass(item, className)).find(Boolean)
    if (!value || typeof value !== 'object') return undefined
    if (value.props?.className === className) return value
    return findByClass(value.children, className)
  }
  const findAllByClass = (value, className, matches = []) => {
    if (Array.isArray(value)) {
      value.forEach(item => findAllByClass(item, className, matches))
      return matches
    }
    if (!value || typeof value !== 'object') return matches
    if (value.props?.className === className) matches.push(value)
    findAllByClass(value.children, className, matches)
    return matches
  }
  const memoryName = findByClass(memoryCard, 'ptcPlusReplName')
  assert.equal(memoryName.props['data-kind'], 'class')
  assert.equal(memoryName.props.title, 'Widget - memory.kind.class')
  const bindingRow = findByClass(memoryCard, 'ptcPlusReplBinding')
  assert.equal(bindingRow.props.role, undefined)
  const bindingTrigger = findByClass(memoryCard, 'ptcPlusReplBindingTrigger')
  assert.equal(bindingTrigger.type, 'button')
  assert.equal(bindingTrigger.props.type, 'button')
  assert.equal(bindingTrigger.props['aria-expanded'], false)
  assert.equal(bindingTrigger.props['aria-controls'], undefined)
  assert.equal(findByClass(memoryCard, 'ptcPlusReplDefinitionWrap'), undefined)
  assert.equal(memoryTexts.includes('memory.inspect'), false)
  assert.ok(memoryTexts.indexOf('Widget') < memoryTexts.indexOf('answer'))


  const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((accept, decline) => {
      resolve = accept
      reject = decline
    })
    return { promise, resolve, reject }
  }
  const firstAlphaLoad = deferred()
  const secondAlphaLoad = deferred()
  const betaLoad = deferred()
  const pendingLoads = new Map([
    ['alpha', [firstAlphaLoad, secondAlphaLoad]],
    ['beta', [betaLoad]],
  ])
  const globalEntries = [
    { id: 'alpha', name: 'Alpha', scope: 'namespace', symbols: ['alpha'] },
    { id: 'beta', name: 'Beta', scope: 'namespace', symbols: ['beta'] },
  ]
  const globalState = []
  let globalStateCursor = 0
  const globalUseState = React.useState
  const renderGlobalCard = (authoringPhase = authoringCard.props.authoringPhase) => {
    globalStateCursor = 0
    React.useState = initial => {
      const index = globalStateCursor++
      if (!(index in globalState)) {
        globalState[index] = typeof initial === 'function' ? initial() : initial
      }
      return [globalState[index], value => {
        globalState[index] = typeof value === 'function' ? value(globalState[index]) : value
      }]
    }
    try {
      return authoringCard.type({
        ...authoringCard.props,
        globalEnabled: true,
        globalBindings: { revision: 1, entries: globalEntries },
        authoringPhase,
        loadGlobalBinding: id => pendingLoads.get(id).shift().promise,
      })
    } finally {
      React.useState = globalUseState
    }
  }
  let globalCard = renderGlobalCard()
  findAllByClass(globalCard, 'ptcPlusReplTab')[1].props.onClick()
  globalCard = renderGlobalCard()
  const pendingGlobalCard = renderGlobalCard('pending')
  const failedGlobalCard = renderGlobalCard('failed')
  assert.equal(collectTexts(pendingGlobalCard).includes('bindings.draftPending'), false)
  assert.equal(collectTexts(failedGlobalCard).includes('bindings.draftFailed'), false)
  let globalSelectors = findAllByClass(globalCard, 'ptcPlusBindingSelect')
  globalSelectors[0].props.onClick()
  globalSelectors[1].props.onClick()
  betaLoad.resolve({ entry: { source: 'export const beta = 2' } })
  await betaLoad.promise
  firstAlphaLoad.reject(new Error('alpha unavailable'))
  await Promise.resolve()
  globalCard = renderGlobalCard()
  assert.deepEqual(
    findAllByClass(globalCard, 'ptcPlusBindingSelect').map(item => item.props['aria-expanded']),
    [false, true],
  )
  assert.ok(collectTexts(findByClass(globalCard, 'ptcPlusGlobalSource')).includes('export const beta = 2'))

  globalSelectors = findAllByClass(globalCard, 'ptcPlusBindingSelect')
  globalSelectors[1].props.onClick()
  globalCard = renderGlobalCard()
  globalSelectors = findAllByClass(globalCard, 'ptcPlusBindingSelect')
  globalSelectors[0].props.onClick()
  globalCard = renderGlobalCard()
  findAllByClass(globalCard, 'ptcPlusBindingSelect')[0].props.onClick()
  secondAlphaLoad.resolve({ entry: { source: 'export const alpha = 1' } })
  await secondAlphaLoad.promise
  globalCard = renderGlobalCard()
  assert.deepEqual(
    findAllByClass(globalCard, 'ptcPlusBindingSelect').map(item => item.props['aria-expanded']),
    [false, false],
  )
  assert.equal(findByClass(globalCard, 'ptcPlusGlobalSource'), undefined)

  const listA = deferred()
  const listB = deferred()
  const staleListB = deferred()
  const listLoads = [listA, listB, staleListB]
  const originalRpcCall = ctx.connection.rpc.call
  ctx.connection.rpc.call = async (_channel, endpoint, payload) => {
    if (endpoint === 'list') return listLoads.shift().promise
    throw new Error(`unexpected binding endpoint ${endpoint}`)
  }
  settingsSnapshot = {
    status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: true },
  }
  const indicatorState = []
  const indicatorRefs = []
  let indicatorStateCursor = 0
  let indicatorRefCursor = 0
  const renderRefreshIndicator = (sessionId, capability) => {
    indicatorStateCursor = 0
    indicatorRefCursor = 0
    const effects = []
    const previousUseState = React.useState
    const previousUseRef = React.useRef
    const previousUseEffect = React.useEffect
    React.useState = initial => {
      const index = indicatorStateCursor++
      if (!(index in indicatorState)) {
        indicatorState[index] = typeof initial === 'function' ? initial() : initial
      }
      return [indicatorState[index], value => {
        indicatorState[index] = typeof value === 'function' ? value(indicatorState[index]) : value
      }]
    }
    React.useRef = initial => {
      const index = indicatorRefCursor++
      if (!(index in indicatorRefs)) indicatorRefs[index] = { current: initial }
      return indicatorRefs[index]
    }
    React.useEffect = effect => { effects.push(effect) }
    try {
      const rendered = indicator.component({
        sessionId,
        t: key => key,
        useSession: selector => selector({ sessionId, projectionValues: { agentPreset: 'ptc' } }),
        useProjection: key => key === 'ptcPlusRepl'
          ? { available: true, entries: [], total: 0, omitted: 0 }
          : key === 'ptcPlusBindingDraft'
            ? { phase: capability === null ? 'idle' : 'ready', capability, commandId: null }
            : key === 'agentPreset' ? 'ptc' : undefined,
        useSessions: selector => selector({ byId: {} }),
      })
      return { rendered, effects }
    } finally {
      React.useState = previousUseState
      React.useRef = previousUseRef
      React.useEffect = previousUseEffect
    }
  }
  const refreshCard = rendered => rendered.children.find(child => typeof child?.type === 'function')
  let refreshRender = renderRefreshIndicator('session-a', 'cap-a')
  refreshRender.effects[0]()
  refreshRender = renderRefreshIndicator('session-b', 'cap-b')
  refreshRender.effects[0]()
  listB.resolve({ ok: true, value: { revision: 2, entries: [] } })
  await new Promise(resolve => setImmediate(resolve))
  listA.resolve({ ok: true, value: { revision: 1, entries: [] } })
  await new Promise(resolve => setImmediate(resolve))
  refreshRender = renderRefreshIndicator('session-b', 'cap-b')
  assert.equal(refreshCard(refreshRender.rendered).props.globalBindings.revision, 2)
  assert.equal(refreshCard(refreshRender.rendered).props.authoringDraft, undefined)
  assert.equal(refreshCard(refreshRender.rendered).props.saveAuthoringDraft, undefined)
  assert.equal(refreshCard(refreshRender.rendered).props.discardAuthoringDraft, undefined)
  ctx.connection.rpc.call = originalRpcCall

  const memoryUseState = React.useState
  React.useState = initial => [initial === null ? 'Widget' : initial, () => {}]
  const expandedMemoryCard = memoryComponent.type(memoryComponent.props)
  React.useState = memoryUseState
  const expandedMemoryTexts = collectTexts(expandedMemoryCard)
  assert.ok(expandedMemoryTexts.includes('memory.location'))
  const expandedDefinition = findByClass(expandedMemoryCard, 'ptcPlusReplDefinitionWrap')
  assert.equal(expandedDefinition.props.role, 'region')
  assert.equal(expandedDefinition.props['aria-hidden'], undefined)
  const expandedTrigger = findByClass(expandedMemoryCard, 'ptcPlusReplBindingTrigger')
  assert.equal(expandedTrigger.props['aria-expanded'], true)
  assert.match(expandedTrigger.props['aria-controls'], /-binding-0$/)

  const originalUseRef = React.useRef
  const originalUseEffect = React.useEffect
  const originalDocumentAddEventListener = document.addEventListener
  const originalDocumentRemoveEventListener = document.removeEventListener
  const originalWindowAddEventListener = window.addEventListener
  const originalWindowRemoveEventListener = window.removeEventListener
  const popover = {
    dataset: {},
    matches: selector => selector === ':popover-open' ? false : undefined,
  }
  const refs = [
    { current: undefined },
    { current: null },
    { current: popover },
    { current: undefined },
  ]
  let indicatorExpanded = true
  let toggleListener
  React.useRef = () => refs.shift()
  React.useState = initial => typeof initial === 'boolean'
    ? [indicatorExpanded, value => {
        indicatorExpanded = typeof value === 'function' ? value(indicatorExpanded) : value
      }]
    : [initial, () => {}]
  React.useEffect = effect => effect()
  document.addEventListener = (type, listener, capture) => {
    if (type === 'toggle' && capture === true) toggleListener = listener
  }
  document.removeEventListener = () => {}
  window.addEventListener = () => {}
  window.removeEventListener = () => {}
  try {
    indicator.component({ sessionId: 'session-1', t: key => key })
    assert.equal(typeof toggleListener, 'function')
    toggleListener({ target: {} })
    assert.equal(indicatorExpanded, true)
    toggleListener({ target: popover })
    assert.equal(indicatorExpanded, false)
  } finally {
    React.useState = memoryUseState
    React.useRef = originalUseRef
    React.useEffect = originalUseEffect
    document.addEventListener = originalDocumentAddEventListener
    document.removeEventListener = originalDocumentRemoveEventListener
    window.addEventListener = originalWindowAddEventListener
    window.removeEventListener = originalWindowRemoveEventListener
  }

  const [runCodeView, editRunCodeView] = toolviews.map(({ component }) => component)
  const toolOwner = () => ({
    sessionId: 'session-1',
    useSessions: selector => selector(sessionSnapshot),
  })
  sessionSnapshot = { byId: { 'session-1': { projectionValues: { agentPreset: 'ptc' } } } }
  settingsSnapshot = { status: 'ready', writable: true, value: { enabled: true } }
  const toolResult = {
    kind: 'tool-result', callId: 'run-1',
    call: {
      name: 'run_code',
      argsRaw: JSON.stringify({ code: 'import path from "node:path"', description: 'Inspect paths' }),
    },
    content: [{ type: 'text', text: '/workspace' }],
    isError: false,
    subCalls: [],
    meta: {
      dshPtcPlus: journal({ calls: [successfulCall(0)], diagnostics: [diagnostic()] }),
      dshPtcPlusRewrites: [{
        kind: 'import', description: 'Adapted import.', source: 'node:path',
      }],
    },
  }
  for (const locale of ['zh', 'en']) {
    const t = key => dicts[locale][key] ?? key
    const texts = collectTexts(runCodeView({
      ...toolOwner(), toolName: 'run_code', block: toolResult, t,
    }))
    assert.ok(texts.includes(dicts[locale]['tool.code']))
    assert.ok(texts.includes(dicts[locale]['autoRewriteImports.label']))
    assert.ok(texts.includes('node:path'))
    assert.equal(texts.some(text => /REPL cells|REPL 单元格|recovery bound|恢复边界/i.test(text)), false)
  }

  const originalUseState = React.useState
  React.useState = () => [true, () => {}]
  const highlighted = runCodeView({
    ...toolOwner(), toolName: 'run_code', block: toolResult, t: key => key,
  })
  const expanded = editRunCodeView({
    ...toolOwner(),
    toolName: 'edit_run_code',
    block: {
      ...toolResult,
      call: {
        name: 'edit_run_code',
        argsRaw: JSON.stringify({ edits: [{ old_text: 'x', new_text: 'y' }], description: 'Apply fix' }),
      },
      meta: {
        dshPtcPlus: journal(),
        dshPtcPlusEdit: { targetCallSeq: 7 },
        dshPtcPlusDerivedRun: { code: 'return fixed', description: 'Apply fix' },
      },
    },
    inspect: () => {},
    t: key => key,
  })
  React.useState = originalUseState
  const expandedTexts = collectTexts(expanded)
  assert.ok(expandedTexts.includes('feature.safeEdit'))
  assert.ok(expandedTexts.includes('tool.source'))
  assert.ok(expandedTexts.includes('tool.result'))
  assert.ok(expandedTexts.includes('tool.inspect'))
  const findElement = (value, type) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findElement(item, type)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (!value || typeof value !== 'object') return undefined
    if (value.type === type) return value
    const fromChildren = findElement(value.children, type)
    if (fromChildren !== undefined) return fromChildren
    const fromCollapsed = findElement(value.props?.collapsedContent, type)
    if (fromCollapsed !== undefined) return fromCollapsed
    return findElement(value.props?.children, type)
  }
  const codeBlock = findElement(highlighted, primitives.CodeBlock)
  assert.equal(codeBlock?.props.lang, 'typescript')
  assert.equal(codeBlock?.props.code, 'import path from "node:path"')
  const disclosure = findElement(highlighted, primitives.DisclosureRow)
  assert.ok(disclosure)
  assert.equal(disclosure.props.collapsedContent.type, 'div')
  assert.equal(disclosure.props.collapsedContent.props.className, 'ptcPlusToolPreview')
  assert.equal(disclosure.props.collapsedContent.children[0].props.className, 'ptcPlusToolSummaryLine')
  assert.equal(disclosure.props.collapsedContent.children[1].props.className, 'ptcPlusFeatures')
  assert.equal(disclosure.props.children.props.className, 'ptcPlusToolBody')
  const expandedDisclosure = findElement(expanded, primitives.DisclosureRow)
  assert.ok(expandedDisclosure)
  assert.equal(expandedDisclosure.props.collapsedContent.props.className, 'ptcPlusToolPreview')
  assert.equal(expandedDisclosure.props.collapsedContent.children[1].props.className, 'ptcPlusFeatures')
  assert.equal(expandedDisclosure.props.children.props.className, 'ptcPlusToolBody')
  const expandedBody = expandedDisclosure.props.children
  const resultSection = expandedBody.children[1]
  assert.equal(resultSection.props.className, 'ptcPlusToolSection')
  const resultCard = resultSection.children[1]
  assert.equal(resultCard.props.className, 'ptcPlusIoCard')
  const resultText = resultCard.children[0]
  assert.equal(resultText.props.className, 'ptcPlusIoText')
  assert.equal(resultText.props['data-error'], undefined)
  const inspectButton = expandedBody.children[2]
  assert.equal(inspectButton.props.className, 'ptcPlusInspect')

  const runningTexts = collectTexts(runCodeView({
    ...toolOwner(),
    toolName: 'run_code',
    block: {
      callId: 'pending', name: 'run_code',
      argsRaw: JSON.stringify({ code: 'await work()', description: 'Working' }),
    },
    t: key => key,
  }))
  assert.ok(runningTexts.includes('tool.running'))

  sessionSnapshot = { byId: { 'session-1': { projectionValues: { agentPreset: 'chat' } } } }
  const neutralTexts = collectTexts(runCodeView({
    ...toolOwner(), toolName: 'run_code', block: { ...toolResult, meta: undefined },
    t: key => key,
  }))
  assert.ok(neutralTexts.includes('tool.code'))
  assert.ok(neutralTexts.includes('tool.code'))

  const activeToolviews = () => slotEntries.filter(({ options, active }) => (
    options.name === 'tool.call.toolview' && active
  ))
  assert.equal(activeToolviews().length, 2)
  settingsSnapshot = { status: 'ready', writable: true, value: { enabled: false } }
  preferenceListeners.forEach(listener => listener())
  assert.equal(activeToolviews().length, 0)
  settingsSnapshot = { status: 'ready', writable: true, value: { enabled: true, enhancedToolView: false } }
  preferenceListeners.forEach(listener => listener())
  assert.equal(activeToolviews().length, 0)
  settingsSnapshot = { status: 'ready', writable: true, value: { enabled: true } }
  preferenceListeners.forEach(listener => listener())
  assert.deepEqual(activeToolviews().map(({ options }) => options.key), ['run_code', 'edit_run_code'])
})

test('renders authoring and memory surfaces when new UI primitives are absent', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const registrations = []
  const window = {
    __ModuleLoader__: { load(value) { registrations.push(value) } },
    addEventListener() {},
    removeEventListener() {},
  }
  const document = {
    documentElement: { style: {} },
    getElementById: () => ({ remove() {} }),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    activeElement: null,
  }
  runInNewContext(source, {
    window,
    document,
    AbortController,
    TextEncoder,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  })
  const states = []
  let stateCursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => {
      const index = stateCursor++
      if (!(index in states)) {
        states[index] = typeof initial === 'function' ? initial() : initial
      }
      return [states[index], value => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
      }]
    },
    useRef: value => ({ current: value }),
    useCallback: value => value,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: effect => effect(),
  }
  const renderAuthor = (props) => {
    stateCursor = 0
    return authorButton.component(props)
  }
  // The older UI kit line provides the stable icons and block components but
  // not the newest Tooltip, Toast, or IconSparkle16 primitives.
  const primitives = {
    CodeBlock() {},
    DisclosureRow() {},
    IconCheckOutline14() {},
    IconChevronDownOutline14() {},
    IconInspectOutline12() {},
    StateDot() {},
  }
  const exported = registrations[0].factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  const slotEntries = []
  const preferenceListeners = new Set()
  const remoteListeners = new Map()
  const clientListeners = new Map()
  let commandDescriptors = [{ name: 'binding', description: 'Author a binding' }]
  let settingsSnapshot = { status: 'ready', writable: true, value: { enabled: true, userBindingsEnabled: true } }
  const sessions = { subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) }
  const ctx = {
    settingsScope: { bind: () => ({
      subscribe: listener => { preferenceListeners.add(listener); return () => preferenceListeners.delete(listener) },
      getSnapshot: () => settingsSnapshot,
    }) },
    effect: register => register(),
    slots: {
      inject: (_key, factory) => {
        factory()
        return () => {}
      },
      register: (options, component) => {
        const entry = { options, component: smokeComponent(options, component, () => ({
          useProjection: key => key === 'agentPreset' ? 'ptc' : undefined,
          useInput: selector => selector({ draft: '' }),
        })) }
        slotEntries.push(entry)
        return () => {}
      },
    },
    inject: (services, callback) => services.includes('sessions') ? undefined : callback(ctx),
    uiSession: {},
    uiConversation: { events: { register: () => () => {} } },
    locale: {
      register: () => () => {},
      bind: () => key => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
    },
    connection: {
      rpc: {
        call: async (_channel, endpoint) => {
          if (endpoint === 'list') return { ok: true, value: { revision: 1, entries: [] } }
          if (endpoint === 'draft') return { ok: true, value: null }
          throw new Error(`unexpected binding endpoint ${endpoint}`)
        },
      },
    },
    remote: {
      commands: {
        list: async () => ({ ok: true, value: commandDescriptors }),
      },
      $on(name, listener) { remoteListeners.set(name, listener) },
    },
    on(name, listener) { clientListeners.set(name, listener); return () => clientListeners.delete(name) },
  }
  exported.apply(ctx)

  const [authorButton] = slotEntries.filter(({ options }) => options.id === 'ptc-plus-binding-author')
  const [bindingCommand] = slotEntries.filter(({ options }) => options.name === 'conversation.chat.commandview')
  const [indicator] = slotEntries.filter(({ options }) => options.name === 'conversation.session.header.actions')
  const authorProps = {
    sessionId: 'session-1',
    t: key => key,
    useConversation: selector => selector({ sessionId: 'session-1' }),
    useInput: selector => selector({ draft: '' }),
    inputActions: { setDraft: () => {} },
  }
  assert.equal(renderAuthor(authorProps), null)
  await new Promise(resolve => setImmediate(resolve))
  const authorControl = renderAuthor(authorProps)
  assert.notEqual(authorControl, null)
  // No Tooltip wrapper, no icon: the star entry degrades to a plain text button.
  assert.equal(authorControl.props['data-text'], true)
  const textButton = authorControl.children[0]
  assert.equal(textButton.type, 'button')
  assert.ok(Array.isArray(textButton.children))
  assert.ok(textButton.children.some(child => child?.type === 'span'
    && child.props?.className === 'ptcPlusAuthorButtonLabel'))
  // The busy fallback is an inline status notice, not a Toast component.
  const busyControl = renderAuthor({
    ...authorProps,
    useInput: selector => selector({ draft: 'keep me' }),
  })
  busyControl.children[0].props.onClick()
  const afterBusy = renderAuthor(authorProps)
  const notice = afterBusy.children.find(child => child?.props?.className === 'ptcPlusComposerNotice')
  assert.notEqual(notice, undefined)
  assert.equal(notice.props.role, 'status')
  assert.ok(Array.isArray(notice.children))

  const commandCard = bindingCommand.component({
    node: { commandId: 'command-1', args: ' new helper', outcome: { kind: 'success', text: 'Authoring started.' } },
    t: key => key,
    useProjection: key => key === 'ptcPlusBindingDraft'
      ? { phase: 'ready', capability: 'cap-1', commandId: 'command-1' }
      : undefined,
  })
  assert.notEqual(commandCard, null)

  const memoryIndicator = indicator.component({
    sessionId: 'session-1',
    t: key => key,
    useSession: selector => selector({ sessionId: 'session-1', projectionValues: { agentPreset: 'ptc' } }),
    useProjection: key => key === 'ptcPlusRepl'
      ? { available: true, entries: [{ name: 'helper', kind: 'variable', definition: { source: 'const helper = 1', line: 1, column: 1 } }], total: 1, omitted: 0 }
      : key === 'agentPreset' ? 'ptc' : undefined,
    useSessions: selector => selector({ byId: {} }),
  })
  assert.notEqual(memoryIndicator, null)
  const memoryComponent = memoryIndicator.children.find(child => typeof child?.type === 'function')
  const memoryCard = memoryComponent.type(memoryComponent.props)
  assert.notEqual(memoryCard, null)
})
