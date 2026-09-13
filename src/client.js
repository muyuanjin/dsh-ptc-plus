import { createClientRpc } from './client-rpc.js'
import { RPC_CONTRACTS } from '../internal/rpc-contract.js'
import { SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import { createPtcToolView } from './client-tool-view.js'
import { createPtcSettingsView } from './client-settings-view.js'
import { createReplView } from './client-repl-view.js'
import { createAuthoringView } from './client-authoring-view.js'
import { createIndicatorView } from './client-indicator-view.js'
import { createTypeScriptEditor } from './client-code-editor.js'
import { createBindingConsole } from './client-console.js'
import {
  isIdleSessionComposer,
  sessionUsesPtcPreset,
  useSessionPreset,
  watchCurrentSessionPreset,
} from './client-host-compat.js'
import {
  normalizeReplMemorySnapshot,
  unavailableReplMemorySnapshot,
} from '../internal/repl-memory-projection.js'
import { createBindingReviews } from './client-binding-review.js'
import { LOCALE_NS, SETTINGS_COPY } from './client-copy.js'
import { installStyles } from './client-styles.js'
import { featureEnabled, registerGated } from './client-feature-gates.js'
import { createCatalogOwner } from './client-catalog.js'
import { createUserBindingsWorkbench } from './client-workbench.js'
import { createBindingCommandAvailability, createReplObserver } from './client-transport.js'

window.__ModuleLoader__.load({
  // Replaced by the bundle entry with the package name from package.json.
  id: __PTC_PLUS_CLIENT_MODULE_ID__,
  factory: (require) => {
    const React = require('react')
    const {
      Button,
      CodeBlock,
      DisclosureRow,
      IconCheckOutline14,
      IconChevronDownOutline14,
      IconInspectOutline12,
      IconSparkle16,
      IconCloseOutline16,
      IconSearchOutline16,
      IconPlusOutline16,
      IconRefreshOutline16,
      IconTrashOutline16,
      IconEditOutline16,
      IconPlayOutline16,
      IconStopFill16,
      Menu,
      Modal,
      Toast,
      Tooltip,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const module = { exports: {} }
    const h = React.createElement
    const TypeScriptEditor = createTypeScriptEditor(React)

    function IconButton({ icon: Icon, label, ...props }) {
      const button = h('button', { ...props, type: 'button', className: 'ptcPlusIconButton',
        'aria-label': label, title: label }, typeof Icon === 'function' ? h(Icon, { size: 16 }) : label)
      return typeof Tooltip === 'function' ? h(Tooltip, { label, delayMs: 400 }, button) : button
    }

    function ActionButton({ className = '', 'data-kind': kind, ...props }) {
      return typeof Button === 'function'
        ? h(Button, {
          ...props, size: 'sm', variant: kind === 'primary' ? 'primary' : kind === 'ghost' ? 'ghost' : 'outline',
          className: className.split(' ').filter(name => name !== 'ptcPlusButton').join(' '),
        })
        : h('button', { ...props, className, 'data-kind': kind })
    }

    const BindingConsole = createBindingConsole(React, { TypeScriptEditor, IconButton, ActionButton,
      icons: { play: IconPlayOutline16, stop: IconStopFill16, reset: IconRefreshOutline16, clear: IconTrashOutline16 } })
    const { PTCPlusToolRow } = createPtcToolView(React, {
      CodeBlock, DisclosureRow,
      icons: { chevron: IconChevronDownOutline14, check: IconCheckOutline14, inspect: IconInspectOutline12 },
    })

    async function apply(ctx) {
      const rpc = await createClientRpc(ctx)
      const preferenceScope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
      ctx.effect(() => ctx.locale.register(LOCALE_NS, SETTINGS_COPY), 'ptc-plus: settings dictionaries')
      ctx.effect(installStyles, 'ptc-plus: client styles')

      async function callUserBindings(endpoint, payload = {}, signal = undefined) {
        if (!featureEnabled(preferenceScope.getSnapshot(), 'bindings')) {
          throw new Error('Global User Bindings are disabled')
        }
        const result = await rpc.call(
          RPC_CONTRACTS.bindings,
          endpoint,
          payload,
          signal,
        )
        if (result?.ok === true) return result.value
        const error = new Error(result?.error?.message ?? 'Global User Binding request failed')
        if (typeof result?.error?.code === 'string') error.code = result.error.code
        throw error
      }

      const catalogOwner = createCatalogOwner({ callUserBindings })
      ctx.effect(() => () => catalogOwner.dispose(), 'ptc-plus: binding catalog sources')
      const { useWorkbenchController, UserBindingsWorkbench, BindingsDialog } = createUserBindingsWorkbench(React, {
        TypeScriptEditor, BindingConsole, IconButton, ActionButton, CodeBlock, Modal,
        catalogOwner,
        icons: {
          refresh: IconRefreshOutline16, plus: IconPlusOutline16, check: IconCheckOutline14,
          trash: IconTrashOutline16, edit: IconEditOutline16, search: IconSearchOutline16,
          chevron: IconChevronDownOutline14, close: IconCloseOutline16,
        },
      })
      const { observeRepl } = createReplObserver({ rpc, ctx })
      const { PTCPlusSettingsCard } = createPtcSettingsView(React, {
        ActionButton, BindingsDialog, useWorkbenchController,
        icons: { chevron: IconChevronDownOutline14 },
      })
      const { ReplComposer, ReplConsole, ReplMemoryCard, replPopoverIsOpen, placeReplPopover } = createReplView(React, {
        ActionButton, CodeBlock, featureEnabled, normalizeReplMemorySnapshot, unavailableReplMemorySnapshot,
        useSessionPreset, sessionUsesPtcPreset, useWorkbenchController, UserBindingsWorkbench,
        icons: { search: IconSearchOutline16, chevron: IconChevronDownOutline14, sparkle: IconSparkle16 },
      })

      const settingsProps = () => ({ hooks: { ptcSettings: preferenceScope }, callUserBindings })
      const updateSetting = async (key, value) => {
        const before = preferenceScope.getSnapshot()
        if (before.status !== 'ready' || before.writable !== true
          || (key !== 'enabled' && !featureEnabled(before, 'plugin'))
          || (before.value?.[key] === value
            && !(key === 'bindingUpdates' && before.value.legacyBindingSettings === true))) return null
        if (key === 'bindingUpdates') {
          await preferenceScope.mutate([
            { op: 'set', path: ['bindingUpdates'], value },
            { op: 'set', path: ['legacyBindingSettings'], value: false },
          ])
        } else await preferenceScope.set(key, value)
        const after = preferenceScope.getSnapshot()
        return after.status === 'ready' && after.value?.[key] === value
          && (key !== 'bindingUpdates' || after.value.legacyBindingSettings !== true)
          ? 'status.applied' : 'status.conflict'
      }
      // One gated-registration shape for every settings-driven contribution.
      const settingsGate = (feature, register) => ({
        subscribe: listener => preferenceScope.subscribe(listener),
        isEnabled: () => featureEnabled(preferenceScope.getSnapshot(), feature),
        register,
      })


      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: LOCALE_NS,
        inject: () => ({ ...settingsProps(), updateSetting }),
      }, PTCPlusSettingsCard))


      ctx.slots.inject('tool.call.toolview', () => registerGated(ctx, settingsGate('toolView', () => {
        // Two rows share one eligibility decision; roll both back if either fails.
        const disposers = []
        try {
          disposers.push(ctx.slots.register({
            name: 'tool.call.toolview', key: 'run_code', locale: LOCALE_NS,
          }, PTCPlusToolRow))
          disposers.push(ctx.slots.register({
            name: 'tool.call.toolview', key: 'edit_run_code', locale: LOCALE_NS,
          }, PTCPlusToolRow))
        } catch (error) {
          disposers.reverse().forEach(dispose => dispose())
          throw error
        }
        return () => disposers.reverse().forEach(dispose => dispose())
      })))

      ctx.inject(['sessions'], (viewScope) => {
        const hideComposer = sessionId => viewScope.effect(() => viewScope.slots.inject(
          'conversation.composer', () => viewScope.slots.register({
            name: 'conversation.composer', priority: 100,
            select: owner => isIdleSessionComposer(owner, sessionId) ? true : null,
          }, ReplComposer),
        ))
        viewScope.slots.inject('conversation.view', () => {
          // The REPL tab needs both the settings gate and the session preset.
          let preset
          return registerGated(viewScope, {
            subscribe: listener => {
              const unsubscribePreset = watchCurrentSessionPreset(viewScope.sessions, value => {
                preset = value
                listener()
              })
              const unsubscribeSettings = preferenceScope.subscribe(listener)
              return () => { unsubscribePreset(); unsubscribeSettings() }
            },
            isEnabled: () => featureEnabled(preferenceScope.getSnapshot(), 'replView')
              && sessionUsesPtcPreset(preset),
            register: () => viewScope.slots.register({
              name: 'conversation.view', id: 'ptc-plus-repl', label: 'REPL', order: 20,
              locale: LOCALE_NS, inject: () => ({ ...settingsProps(), hideComposer, observeRepl }),
            }, props => typeof props.useProjection === 'function' ? h(ReplConsole, props) : null),
          })
        })
      })

      const bindingReviews = createBindingReviews(callUserBindings)
      ctx.effect(() => () => bindingReviews.dispose())
      ctx.on('connection/reset', () => bindingReviews.reset())

      function useBindingReview(sessionId) {
        const review = bindingReviews.forSession(sessionId)
        const view = React.useSyncExternalStore(review.subscribe, review.getSnapshot)
        return [review, view]
      }

      const subscribeReset = listener => ctx.on('connection/reset', listener)
      const { BindingAuthorButton, BindingReviewDock, BindingCommandCard } = createAuthoringView(React, {
        ActionButton, IconButton, Menu, Toast, Tooltip, CodeBlock, BindingsDialog,
        useWorkbenchController, useBindingReview, catalogOwner, callUserBindings, subscribeReset,
        icons: {
          sparkle: IconSparkle16, chevron: IconChevronDownOutline14,
          close: IconCloseOutline16, check: IconCheckOutline14,
        },
      })
      const { PTCPlusSessionIndicator } = createIndicatorView(React, {
        featureEnabled, useSessionPreset, sessionUsesPtcPreset,
        normalizeReplMemorySnapshot, unavailableReplMemorySnapshot,
        ReplMemoryCard, replPopoverIsOpen, placeReplPopover,
        catalogOwner, subscribeReset,
      })

      ctx.slots.inject('conversation.session.header.actions', () => registerGated(ctx, settingsGate('plugin', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'ptc-plus-active', order: -9, locale: LOCALE_NS,
        inject: settingsProps,
      }, props => typeof props.useProjection === 'function' ? h(PTCPlusSessionIndicator, props) : null))))
      ctx.slots.inject('conversation.chat.commandview', () => registerGated(ctx, settingsGate('bindings', () => ctx.slots.register({
        name: 'conversation.chat.commandview', key: 'binding', locale: LOCALE_NS,
        inject: settingsProps,
      }, props => h(BindingCommandCard, { ...props, key: props.node.commandId })))))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.inject('conversation.input.left', () =>
        registerGated(ctx, settingsGate('bindings', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'ptc-plus-binding-review', order: 30, locale: LOCALE_NS,
        }, props => typeof props.useProjection === 'function' && props.sessionId !== undefined
          ? h(BindingReviewDock, { ...props, key: props.sessionId }) : null)))))
      const availability = createBindingCommandAvailability(ctx)
      // The composer binding entry belongs to the PTC surface, exactly like the
      // header indicator and the REPL tab. A non-PTC session keeps plugin
      // settings and `/binding` command cards, but shows no binding shortcut and
      // issues no command-directory read for it.
      ctx.inject(['sessions'], (viewScope) => {
        let preset
        viewScope.slots.inject('conversation.input.left', () => registerGated(viewScope, {
          subscribe: listener => {
            const unsubscribePreset = watchCurrentSessionPreset(viewScope.sessions, value => {
              preset = value
              listener()
            })
            const unsubscribeSettings = preferenceScope.subscribe(listener)
            return () => { unsubscribePreset(); unsubscribeSettings() }
          },
          isEnabled: () => sessionUsesPtcPreset(preset)
            && featureEnabled(preferenceScope.getSnapshot(), 'bindings'),
          register: () => ctx.slots.register({
            name: 'conversation.input.left', id: 'ptc-plus-binding-author', order: 20, locale: LOCALE_NS,
            inject: sessionId => ({
              hooks: { ptcSettings: preferenceScope, bindingCommand: availability.source(sessionId) },
            }),
          }, props => props.sessionId === undefined ? null : h(BindingAuthorButton, { ...props, key: props.sessionId })),
        }))
      })
    }

    module.exports = {
      apply,
      inject: ['settingsScope', 'slots', 'locale', 'connection', 'remote'],
    }
    return module.exports
  },
})
