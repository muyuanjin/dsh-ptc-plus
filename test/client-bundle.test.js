import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { CONFIG_FIELDS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)

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
  runInNewContext(source, { window })
  assert.equal(registrations.length, 1)
  const loaded = registrations[0]
  assert.equal(loaded.id, packageJson.name)
  const React = { createElement() {}, useState() {}, useRef() {}, useCallback(value) { return value }, useSyncExternalStore() {}, useEffect() {} }
  const primitives = {
    IconCheckOutline14() {},
    IconChevronDownOutline14() {},
    IconSettingsOutline16() {},
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
  assert.match(source, /ptcPlusDescription/)
  assert.match(source, /aria-label/)
  assert.match(sourceModule, /PTC 模式的会话级 TypeScript REPL。/)
  assert.match(sourceModule, /收起 PTC Plus 设置/)
  assert.match(sourceModule, /展开 PTC Plus 设置/)
  assert.match(sourceModule, /设置会在修改后立即生效/)
  assert.doesNotMatch(sourceModule, /仅 enabled 即时生效/)
  assert.match(sourceModule, /The session-bound TypeScript REPL for PTC mode\./)
  assert.match(sourceModule, /Expand PTC Plus settings/)
  assert.doesNotMatch(sourceModule, /saveSettings/)
  assert.doesNotMatch(source, /PTC 模式\+/)
  assert.equal(typeof require('esbuild').build, 'function')
})

test('settings card copy follows the DSH locale dictionaries', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const registrations = []
  const window = { __ModuleLoader__: { load(value) { registrations.push(value) } } }
  const document = { getElementById: () => ({ remove() {} }) }
  runInNewContext(source, { window, document })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: value => ({ current: value }),
    useCallback: value => value,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: () => {},
  }
  const primitives = {
    IconCheckOutline14: 'IconCheck',
    IconChevronDownOutline14: 'IconChevron',
    IconSettingsOutline16: 'IconSettings',
  }
  const exported = registrations[0].factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency ${name}`)
  })
  const dictionaries = []
  const slotEntries = []
  const preferenceScope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true } }),
  }
  const sessions = {
    subscribe: () => () => {},
    getSnapshot: () => ({ byId: { 'session-1': { agentPreset: 'code' } } }),
  }
  const ctx = {
    settingsScope: { bind: () => preferenceScope },
    effect: register => register(),
    slots: {
      inject: (_key, factory) => { factory(); return () => {} },
      register: (options, component) => { slotEntries.push({ options, component }); return () => {} },
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
  assert.equal(card.options.locale, ns)
  assert.equal(card.options.key, SETTINGS_NAMESPACE)
  assert.equal(indicator.options.locale, ns)
  const collectTexts = (value) => {
    const texts = []
    const collect = current => {
      if (typeof current === 'string') { texts.push(current); return }
      if (Array.isArray(current)) { current.forEach(collect); return }
      if (current && typeof current === 'object' && 'children' in current) {
        if (typeof current.props?.['aria-label'] === 'string') texts.push(current.props['aria-label'])
        if (typeof current.props?.title === 'string') texts.push(current.props.title)
        current.children.forEach(collect)
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

    const indicatorTexts = collectTexts(indicator.component({ sessionId: 'session-1', t }))
    assert.ok(indicatorTexts.includes(dicts[locale]['indicator.title']))
    assert.equal(indicatorTexts.includes(dicts[opposite]['indicator.title']), false)
  }
})
