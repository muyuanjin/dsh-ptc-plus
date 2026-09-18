import { CONFIG_FIELDS, CONFIG_GROUPS } from '../internal/config-spec.js'
import { resolveConfig } from '../internal/runtime-config.js'
import { featureEnabled } from './client-feature-gates.js'

/**
 * Settings card for the plugin. One field control per config-spec entry, one
 * serialized write tail so rapid edits cannot race, and the manage-bindings
 * action only while global bindings are eligible.
 */
export function createPtcSettingsView(React, deps) {
  const { ActionButton, BindingsDialog, Modal, useWorkbenchController, icons } = deps
  const h = React.createElement
  const focusableSelector = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[href],[tabindex]:not([tabindex="-1"]),[contenteditable=true],summary'

  function fieldInput(field, value, disabled, onChange, label) {
    if (field.type === 'boolean') {
      return h('input', {
        type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value === true,
        disabled, 'aria-label': label,
        onChange: event => onChange(field, event.target.checked),
      })
    }
    if (field.type === 'enum') {
      return h('input', {
        type: 'checkbox', role: 'switch', className: 'ptcPlusCheck', checked: value !== 'protected',
        disabled, 'aria-label': label,
        onChange: event => onChange(field, event.target.checked ? 'stateful' : 'protected'),
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

  function PTCPlusSettingsCard({ t, usePtcSettings, updateSetting, callUserBindings, view, onBindingsOpenChange }) {
    const [open, setOpen] = React.useState(false)
    const [bindingsOpen, setBindingsOpen] = React.useState(false)
    const bindingsAction = React.useRef(null)
    const [status, setStatus] = React.useState(null)
    const [pending, setPending] = React.useState(() => new Set())
    const writeTail = React.useRef(Promise.resolve())
    const snapshot = usePtcSettings(snapshot => snapshot)
    const value = snapshot.status === 'ready' ? resolveConfig(snapshot.value ?? {}) : {}
    const legacyKeys = ['looseTopLevelRedeclarations', 'looseTopLevelFunctionClassRedeclarations',
      'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations']
    const legacyMigration = value.legacyBindingSettings === true
    const enabled = featureEnabled(snapshot, 'plugin')
    const globalEnabled = featureEnabled(snapshot, 'bindings')
    const groupIdPrefix = view === 'dialog' ? 'ptc-plus-settings-dialog-group' : 'ptc-plus-settings-group'
    // The open dialog owns the management session: closing it releases the draft
    // and drops every response the host has not answered yet.
    const workbench = useWorkbenchController({ enabled: globalEnabled && bindingsOpen, callUserBindings })
    const setBindingsDialogOpen = next => {
      setBindingsOpen(next)
      onBindingsOpenChange?.(next)
    }
    React.useEffect(() => {
      if (!globalEnabled) setBindingsDialogOpen(false)
    }, [globalEnabled])
    const unavailable = snapshot.status !== 'ready' || snapshot.writable !== true
    const persist = (field, nextValue) => {
      if (unavailable || pending.has(field.key)) return
      const operation = writeTail.current.then(async () => {
        setPending(current => new Set(current).add(field.key))
        setStatus(null)
        try {
          const key = await updateSetting(field.key, nextValue)
          if (key !== null) setStatus({ key })
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
    const settingsFields = () => CONFIG_GROUPS.map(group => {
      const fields = group.key === 'syntax' && legacyMigration
        ? [...group.fields, ...legacyKeys]
        : group.fields
      return h('section', {
      key: group.key,
      className: 'ptcPlusGroup',
      'aria-labelledby': `${groupIdPrefix}-${group.key}`,
    },
    h('h3', {
      id: `${groupIdPrefix}-${group.key}`,
      className: 'ptcPlusGroupTitle',
    }, t(`group.${group.key}`)),
    ...fields.map(key => {
      const field = CONFIG_FIELDS.find(candidate => candidate.key === key)
      if (field === undefined) return null
      const migratingPolicy = field.key === 'bindingUpdates' && legacyMigration
      return h(React.Fragment, { key: field.key },
        h('div', { className: 'ptcPlusRow' },
          h('div', { className: 'ptcPlusMain' },
            h('div', { className: 'ptcPlusLabel' }, t(`${field.key}.label`)),
            field.description === '' ? null : h('div', { className: 'ptcPlusDetail' },
              t(migratingPolicy ? 'bindingPolicy.migrationDescription' : `${field.key}.description`))),
          migratingPolicy
            ? h('select', {
              className: 'ptcPlusSelect', value: 'legacy', disabled: fieldDisabled(field),
              'aria-label': t(`${field.key}.label`),
              onChange: event => persist(field, event.target.value),
            },
            h('option', { value: 'legacy', disabled: true }, t('bindingPolicy.legacy')),
            ...field.options.map(policy => h('option', { key: policy, value: policy }, t(`bindingPolicy.${policy}`))))
            : fieldInput(field, value[field.key], fieldDisabled(field), persist, t(`${field.key}.label`))),
        field.key === 'userBindingsEnabled' && globalEnabled
          ? h('div', { className: 'ptcPlusSettingAction', ref: bindingsAction },
            h(ActionButton, { type: 'button', className: 'ptcPlusButton', onClick: () => setBindingsDialogOpen(true) }, t('bindings.manage')))
          : null)
    }))
    })
    const settingsBody = (expanded, id) => h('div', {
      id, className: 'ptcPlusBody', 'data-open': expanded, hidden: !expanded,
    },
    h('div', { className: 'ptcPlusBodyInner' }, h('div', { className: 'ptcPlusFields' },
      snapshot.status === 'loading'
        ? h('p', { className: 'ptcPlusMessage' }, t('state.syncing'))
        : snapshot.status === 'unavailable'
          ? h('p', { className: 'ptcPlusMessage' }, t('state.unavailable'))
          : [
            ...settingsFields(),
            h('div', { key: 'footer', className: 'ptcPlusFooter' },
              h('span', { className: 'ptcPlusMessage', role: 'status' }, status === null
                ? t(snapshot.writable ? 'footer.live' : 'footer.readOnly')
                : t(status.key, status.params))),
          ])))
    const openBindings = globalEnabled && bindingsOpen
      ? h(BindingsDialog, {
        controller: workbench, t, onClose: () => setBindingsDialogOpen(false),
        getReturnFocus: () => bindingsAction.current?.querySelector('button'),
      }) : null
    // A seat that asks for views renders one entry twice: `summary` is the
    // one-liner under the title the seat draws, `page` is the form it mounts
    // with its own save control (the form already writes on change). The legacy
    // card seat asks for neither and keeps the whole collapsible card.
    if (view === 'summary') return h('span', { className: 'ptcPlusDescription' }, t('card.description'))
    if (view === 'page') return h('div', { className: 'ptcPlusCard' }, settingsBody(true), openBindings)
    if (view === 'dialog') return h(React.Fragment, null, settingsBody(true), openBindings)
    return h('li', { className: 'ptcPlusCard' },
      h('button', {
        type: 'button', className: 'ptcPlusHeader', 'aria-expanded': open,
        'aria-label': t(open ? 'action.collapse' : 'action.expand'),
        'aria-controls': 'ptc-plus-settings-body', onClick: () => setOpen(current => !current),
      },
      h('span', { className: 'ptcPlusHeadText' },
        h('span', { className: 'ptcPlusName' }, 'PTC Plus'),
        h('span', { className: 'ptcPlusDescription' }, t('card.description'))),
      h('span', { className: 'ptcPlusStatus', 'data-enabled': enabled }, t(enabled ? 'status.enabled' : 'status.disabled')),
      h('span', { className: 'ptcPlusChevron', 'data-open': open, 'aria-hidden': true }, h(icons.chevron, { size: 14 }))),
      settingsBody(open, 'ptc-plus-settings-body'),
      openBindings,
    )
  }

  function PTCPlusSettingsDialog(props) {
    const { t, onClose } = props
    const body = React.useRef(null)
    const [bindingsOpen, setBindingsOpen] = React.useState(false)
    React.useEffect(() => {
      const dialog = body.current?.closest('[role=dialog]')
      const target = body.current?.querySelector(focusableSelector)
        ?? dialog?.querySelector(focusableSelector)
      target?.focus({ preventScroll: true })
    }, [])
    React.useEffect(() => {
      const trapFocus = event => {
        if (event.key !== 'Tab' || bindingsOpen) return
        const dialog = body.current?.closest('[role=dialog]')
        if (dialog === undefined || dialog === null) return
        const controls = [...dialog.querySelectorAll(focusableSelector)]
          .filter(element => !element.closest('[hidden], [inert], [aria-hidden="true"]'))
        const first = controls[0]
        const last = controls.at(-1)
        const active = document.activeElement
        if (!dialog.contains(active)
          || (event.shiftKey && active === first)
          || (!event.shiftKey && active === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus({ preventScroll: true })
        }
      }
      document.addEventListener('keydown', trapFocus)
      return () => document.removeEventListener('keydown', trapFocus)
    }, [bindingsOpen])
    const close = () => {
      if (!bindingsOpen) onClose()
    }
    return h(Modal, {
      open: true,
      onClose: close,
      title: t('settings.dialogTitle'),
      closeLabel: t('settings.close'),
      description: t('card.description'),
      className: 'ptcPlusSettingsModal',
      contentClassName: 'ptcPlusSettingsDialogContent',
    }, h('div', { className: 'ptcPlusSettingsDialog', ref: body },
      h(PTCPlusSettingsCard, { ...props, view: 'dialog', onBindingsOpenChange: setBindingsOpen })))
  }

  return { PTCPlusSettingsCard, PTCPlusSettingsDialog }
}
