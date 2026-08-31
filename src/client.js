import { CONFIG_FIELDS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'

const CLIENT_STYLE_ID = 'ptc-plus-client-style'
const CLIENT_CSS = `
.ptcPlusCard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;list-style:none;overflow:hidden}
.ptcPlusHeader{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .16s ease}
.ptcPlusHeader:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusHeader:focus-visible,.ptcPlusButton:focus-visible,.ptcPlusInput:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
.ptcPlusHeadText{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}.ptcPlusName{font-size:14px;font-weight:600;line-height:20px}.ptcPlusDescription{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusStatus{display:inline-flex;align-items:center;flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px}.ptcPlusStatus[data-enabled=true]{color:var(--dsw-alias-state-success-primary,#16794f);background:var(--dsw-alias-state-success-tertiary,#e7f7ef)}.ptcPlusStatus[data-enabled=false]{color:var(--dsw-alias-label-tertiary,#74777d);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ptcPlusChevron{display:flex;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .18s ease}.ptcPlusChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusBody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ptcPlusBody[data-open=true]{grid-template-rows:1fr}.ptcPlusBodyInner{min-height:0;overflow:hidden}.ptcPlusFields{margin:0 16px;padding:8px 0 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.ptcPlusRow{display:flex;align-items:center;gap:12px;min-height:48px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusRow:first-child{border-top:0}.ptcPlusMain{flex:1;min-width:0}.ptcPlusLabel{font-size:14px;font-weight:500;line-height:20px}.ptcPlusDetail,.ptcPlusMessage{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusInput{box-sizing:border-box;min-width:72px;width:140px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusCheck{width:18px;height:18px;accent-color:var(--dsw-alias-interactive-primary,#4d6bfe)}
.ptcPlusFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.ptcPlusButton{min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:500 13px/20px inherit;transition:background-color .16s ease,border-color .16s ease}.ptcPlusButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusButton:disabled,.ptcPlusInput:disabled,.ptcPlusCheck:disabled{cursor:not-allowed;opacity:.55}.ptcPlusActive{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-state-success-primary,#16794f);font-size:12px;line-height:18px;white-space:nowrap}
@media(max-width:560px){.ptcPlusHeader{padding:12px}.ptcPlusFields{margin:0 12px}.ptcPlusRow{align-items:flex-start;flex-direction:column;gap:6px;padding:10px 0}.ptcPlusInput{width:100%}.ptcPlusFooter{align-items:stretch;flex-direction:column}.ptcPlusButton{width:100%}}
@media(prefers-reduced-motion:reduce){.ptcPlusHeader,.ptcPlusChevron,.ptcPlusBody,.ptcPlusButton{transition:none}}
`

/** Locale namespace owning every settings-card string (field copy plus chrome). */
const LOCALE_NS = 'settings.ptcPlus'

/** Card chrome copy; field labels and hints ride the shared config spec. */
const CHROME_COPY = Object.freeze({
  zh: Object.freeze({
    'card.description': 'PTC 模式的会话级 TypeScript REPL。',
    'status.enabled': '已启用',
    'status.disabled': '已停用',
    'action.expand': '展开 PTC Plus 设置',
    'action.collapse': '收起 PTC Plus 设置',
    'state.syncing': '正在同步设置...',
    'state.unavailable': '当前 DSH 实例未提供设置服务',
    'footer.live': '设置会在修改后立即生效',
    'footer.readOnly': '当前设置为只读',
    'status.applied': '设置已立即生效',
    'status.conflict': '设置未生效，请检查设置冲突',
    'status.failed': '设置失败：{error}',
    'indicator.title': 'PTC Plus 已启用',
  }),
  en: Object.freeze({
    'card.description': 'The session-bound TypeScript REPL for PTC mode.',
    'status.enabled': 'Enabled',
    'status.disabled': 'Disabled',
    'action.expand': 'Expand PTC Plus settings',
    'action.collapse': 'Collapse PTC Plus settings',
    'state.syncing': 'Syncing settings...',
    'state.unavailable': 'This DSH instance does not provide a settings service',
    'footer.live': 'Changes take effect immediately.',
    'footer.readOnly': 'These settings are read-only.',
    'status.applied': 'Setting applied immediately.',
    'status.conflict': 'The setting did not take effect; check for conflicting settings.',
    'status.failed': 'Could not save: {error}',
    'indicator.title': 'PTC Plus is active',
  }),
})

/** Project one field's copy into locale dictionary keys; an empty hint has no key. */
function fieldCopy(field, locale) {
  const copy = { [`${field.key}.label`]: locale === 'en' ? field.labelEn : field.label }
  const description = locale === 'en' ? field.descriptionEn : field.description
  if (description !== '') copy[`${field.key}.description`] = description
  return copy
}

/** Complete dictionaries for both shipped locales, derived once from the spec. */
const SETTINGS_COPY = Object.freeze(Object.fromEntries(
  ['zh', 'en'].map(locale => [locale, Object.freeze({
    ...CHROME_COPY[locale],
    ...Object.assign({}, ...CONFIG_FIELDS.map(field => fieldCopy(field, locale))),
  })]),
))

window.__ModuleLoader__.load({
  // Replaced by the bundle entry with the package name from package.json.
  id: __PTC_PLUS_CLIENT_MODULE_ID__,
  factory: (require) => {
    const React = require('react')
    const {
      IconCheckOutline14,
      IconChevronDownOutline14,
      IconSettingsOutline16,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const module = { exports: {} }
    const h = React.createElement

    function installStyles() {
      if (document.getElementById(CLIENT_STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = CLIENT_STYLE_ID
      style.textContent = CLIENT_CSS
      document.head.append(style)
      return () => style.remove()
    }

    function fieldInput(field, value, disabled, onChange, label) {
      if (field.type === 'boolean') {
        return h('input', {
          type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value === true,
          disabled, 'aria-label': label,
          onChange: event => onChange(field, event.target.checked),
        })
      }
      return h('input', {
        type: 'number', className: 'ptcPlusInput',
        value: Number.isSafeInteger(value) ? String(value) : '',
        min: field.min, max: field.max, step: 1, disabled, 'aria-label': label,
        onChange: event => {
          const input = event.target.value
          const parsed = input === '' ? '' : Number(input)
          onChange(field, Number.isSafeInteger(parsed) ? parsed : input)
        },
      })
    }

    function apply(ctx) {
      const preferenceScope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
      ctx.effect(() => ctx.locale.register(LOCALE_NS, SETTINGS_COPY), 'ptc-plus: settings dictionaries')
      ctx.effect(installStyles, 'ptc-plus: client styles')

      function PTCPlusSettingsCard({ t }) {
        const [open, setOpen] = React.useState(false)
        const [status, setStatus] = React.useState(null)
        const [pending, setPending] = React.useState(() => new Set())
        const writeTail = React.useRef(Promise.resolve())
        const subscribe = React.useCallback(listener => preferenceScope.subscribe(listener), [])
        const getSnapshot = React.useCallback(() => preferenceScope.getSnapshot(), [])
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        const value = snapshot.status === 'ready' ? (snapshot.value ?? {}) : {}
        const enabled = value.enabled === true
        const unavailable = snapshot.status !== 'ready' || snapshot.writable !== true
        const persist = (field, nextValue) => {
          if (unavailable || pending.has(field.key)) return
          const operation = writeTail.current.then(async () => {
            const before = preferenceScope.getSnapshot()
            if (before.status !== 'ready' || before.writable !== true) return
            if (field.key !== 'enabled' && before.value?.enabled !== true) return
            if (before.value?.[field.key] === nextValue) return
            setPending(current => new Set(current).add(field.key))
            setStatus(null)
            try {
              await preferenceScope.set(field.key, nextValue)
              const after = preferenceScope.getSnapshot()
              if (after.status !== 'ready' || after.value?.[field.key] !== nextValue) {
                setStatus({ key: 'status.conflict' })
              } else {
                setStatus({ key: 'status.applied' })
              }
            } catch (error) {
              setStatus({
                key: 'status.failed',
                params: { error: error instanceof Error ? error.message : String(error) },
              })
            } finally {
              setPending(current => {
                const next = new Set(current)
                next.delete(field.key)
                return next
              })
            }
          })
          writeTail.current = operation.catch(() => {})
        }
        const fieldDisabled = field => unavailable
          || pending.has(field.key)
          || (field.key !== 'enabled' && !enabled)
        return h('li', { className: 'ptcPlusCard' },
          h('button', {
            type: 'button', className: 'ptcPlusHeader', 'aria-expanded': open,
            'aria-label': t(open ? 'action.collapse' : 'action.expand'),
            'aria-controls': 'ptc-plus-settings-body', onClick: () => setOpen(current => !current),
          },
          h(IconSettingsOutline16, { size: 16 }),
          h('span', { className: 'ptcPlusHeadText' },
            h('span', { className: 'ptcPlusName' }, 'PTC Plus'),
            h('span', { className: 'ptcPlusDescription' }, t('card.description'))),
          h('span', { className: 'ptcPlusStatus', 'data-enabled': enabled }, t(enabled ? 'status.enabled' : 'status.disabled')),
          h('span', { className: 'ptcPlusChevron', 'data-open': open, 'aria-hidden': true }, h(IconChevronDownOutline14, { size: 14 }))),
          h('div', { id: 'ptc-plus-settings-body', className: 'ptcPlusBody', 'data-open': open, 'aria-hidden': !open },
            h('div', { className: 'ptcPlusBodyInner' }, h('div', { className: 'ptcPlusFields' },
              snapshot.status === 'loading'
                ? h('p', { className: 'ptcPlusMessage' }, t('state.syncing'))
                : snapshot.status === 'unavailable'
                  ? h('p', { className: 'ptcPlusMessage' }, t('state.unavailable'))
                  : [
                    ...CONFIG_FIELDS.map(field => h('div', { key: field.key, className: 'ptcPlusRow' },
                      h('div', { className: 'ptcPlusMain' },
                        h('div', { className: 'ptcPlusLabel' }, t(`${field.key}.label`)),
                        field.description === '' ? null : h('div', { className: 'ptcPlusDetail' }, t(`${field.key}.description`))),
                      fieldInput(field, value[field.key], fieldDisabled(field), persist, t(`${field.key}.label`)))),
                    h('div', { key: 'footer', className: 'ptcPlusFooter' },
                      h('span', { className: 'ptcPlusMessage', role: 'status' }, status === null
                        ? t(snapshot.writable ? 'footer.live' : 'footer.readOnly')
                        : t(status.key, status.params))),
                  ]))),
        )
      }

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: LOCALE_NS,
      }, PTCPlusSettingsCard))

      ctx.inject(['slots', 'sessions'], (scope) => {
        function PTCPlusSessionIndicator({ sessionId, t }) {
          const sessions = React.useSyncExternalStore(
            listener => scope.sessions.list.subscribe(listener),
            () => scope.sessions.list.getSnapshot(),
            () => scope.sessions.list.getSnapshot(),
          )
          const settings = React.useSyncExternalStore(
            listener => preferenceScope.subscribe(listener),
            () => preferenceScope.getSnapshot(),
            () => preferenceScope.getSnapshot(),
          )
          if (sessions.byId?.[sessionId]?.agentPreset !== 'code'
            || settings.status !== 'ready' || settings.value?.enabled !== true) return null
          return h('span', { className: 'ptcPlusActive', title: t('indicator.title') },
            h(IconCheckOutline14, { size: 14 }), 'PTC Plus')
        }
        scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
          name: 'conversation.session.header.actions', id: 'ptc-plus-active', order: -9, locale: LOCALE_NS,
        }, PTCPlusSessionIndicator))
      })
    }

    module.exports = { apply, inject: ['settingsScope', 'slots', 'sessions', 'locale'] }
    return module.exports
  },
})
