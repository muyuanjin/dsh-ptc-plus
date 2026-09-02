import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { CONFIG_FIELDS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)

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
  }
  const exported = loaded.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  assert.equal(Array.from(exported.inject).join(','), 'settingsScope,slots,sessions,locale')
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
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
  assert.match(sourceModule, /Expand PTC Plus settings/)
  assert.doesNotMatch(sourceModule, /ptcPlusActivityPanel/)
  assert.doesNotMatch(sourceModule, /useConversation\b/)
  assert.match(sourceModule, /useSession/)
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
  const window = { __ModuleLoader__: { load(value) { registrations.push(value) } } }
  const document = { getElementById: () => ({ remove() {} }) }
  runInNewContext(source, { window, document, TextEncoder })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: value => ({ current: value }),
    useCallback: value => value,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: () => {},
  }
  const primitives = {
    CodeBlock() {},
    DisclosureRow() {},
    IconCheckOutline14: 'IconCheck',
    IconChevronDownOutline14: 'IconChevron',
    IconInspectOutline12: 'IconInspect',
  }
  const exported = registrations[0].factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  const dictionaries = []
  const slotEntries = []
  const preferenceListeners = new Set()
  let settingsSnapshot = { status: 'ready', writable: true, value: { enabled: true } }
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
        const entry = { options, component, active: true }
        slotEntries.push(entry)
        return () => { entry.active = false }
      },
    },
    inject: (_services, callback) => callback({ slots: ctx.slots, sessions: { list: sessions } }),
    locale: {
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
      bind: () => key => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
    },
  }
  exported.apply(ctx)

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

  const [card] = slotEntries.filter(({ options }) => options.name === 'settings.plugin.item')
  const [indicator] = slotEntries.filter(({ options }) => options.name === 'conversation.session.header.actions')
  const toolviews = slotEntries.filter(({ options }) => options.name === 'tool.call.toolview')
  assert.equal(card.options.locale, ns)
  assert.equal(card.options.key, SETTINGS_NAMESPACE)
  assert.equal(indicator.options.locale, ns)
  assert.equal(indicator.options.id, 'ptc-plus-active')
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
    } : undefined,
    useSessions: selector => selector({ byId: {} }),
  })
  assert.notEqual(standardKitIndicator, null)

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
  const refs = [{ current: null }, { current: popover }, { current: undefined }]
  let indicatorExpanded = true
  let toggleListener
  React.useRef = () => refs.shift()
  React.useState = initial => [initial, value => {
    indicatorExpanded = typeof value === 'function' ? value(indicatorExpanded) : value
  }]
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
