import { SETTINGS_NAMESPACE } from '../internal/config-spec.js'

const HOST_ICON_EXPORTS = Object.freeze({
  check: ['IconCheckOutlineRegular', 'IconCheckOutline14'],
  chevron: ['IconChevronDownOutlineRegular', 'IconChevronDownOutline14'],
  inspect: ['IconInspectOutlineRegular', 'IconInspectOutline12'],
  sparkle: ['IconSparkleRegular', 'IconSparkle16'],
  close: ['IconCloseOutlineRegular', 'IconCloseOutline16'],
  search: ['IconSearchOutlineRegular', 'IconSearchOutline16'],
  plus: ['IconPlusOutlineRegular', 'IconPlusOutline16'],
  refresh: ['IconRefreshOutlineRegular', 'IconRefreshOutline16'],
  trash: ['IconTrashOutlineRegular', 'IconTrashOutline16'],
  edit: ['IconEditOutlineRegular', 'IconEditOutline16'],
  play: ['IconPlayOutlineRegular', 'IconPlayOutline16'],
  stop: ['IconStopFillRegular', 'IconStopFill16'],
})

/**
 * The one component that stands in for a glyph the host did not publish.
 *
 * Call sites render `icons.<key>` as a glyph, so an omitted, renamed, or
 * malformed export must still resolve to a renderable element type. The marker
 * stays readable so a control that can show its own text label instead
 * (`IconButton`) keeps that fallback rather than rendering an empty button.
 */
const ABSENT_HOST_ICON = () => null
ABSENT_HOST_ICON.absentHostIcon = true

/** Whether a normalized icon entry is a glyph the host actually published. */
export function isHostIconComponent(icon) {
  return typeof icon === 'function' && icon.absentHostIcon !== true
}

/**
 * Normalize the public icon export shape used by current and preceding Clients.
 *
 * The mapping is total: every key resolves to a render-safe component, so a
 * host generation that renames or omits an icon never turns a missing glyph
 * into a render-time throw of the whole plugin surface.
 */
export function hostIconComponents(primitives) {
  return Object.fromEntries(Object.entries(HOST_ICON_EXPORTS).map(([name, candidates]) => [
    name,
    candidates.map(candidate => primitives?.[candidate])
      .find(value => typeof value === 'function') ?? ABSENT_HOST_ICON,
  ]))
}

/** The preset a session publishes, preferring the projection reader's evidence. */
function sessionPresetValue(projected, summary) {
  if (projected !== undefined) return projected
  const values = summary?.projectionValues
  // A published key is authoritative even when its value is undefined: it says
  // the projection exists, so the legacy summary field must not stand in.
  return values !== undefined && Object.hasOwn(values, 'agentPreset') ? values.agentPreset : summary?.agentPreset
}

/**
 * The session the main view holds.
 *
 * The preceding DSH projects the current selection on the session list snapshot.
 * The current one keeps view selection outside the controller and retains the
 * session its main view shows instead, so `retainedBy.mainView` is that layer's
 * own selection evidence. A switch retains the new session before releasing the
 * old one, so the remembered selection wins while it is still held: that is the
 * same rule the view layer applies to decide which session it shows.
 */
function currentSessionId(snapshot, remembered) {
  if (snapshot?.current !== undefined) return snapshot.current
  const held = id => id !== undefined && (snapshot?.byId?.[id]?.retainedBy?.mainView ?? 0) > 0
  if (held(remembered)) return remembered
  for (const row of Object.values(snapshot?.byId ?? {})) {
    if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id
  }
  return undefined
}

export function sessionUsesPtcPreset(preset) {
  return preset === 'ptc' || preset === 'code'
}

/** Consume the renderer's public hooks; only preset selection has a summary fallback. */
export function useSessionPreset({ sessionId, useProjection, useSessions }) {
  const projected = useProjection('agentPreset')
  return typeof useSessions === 'function'
    ? useSessions(state => sessionPresetValue(projected, state.byId?.[sessionId]))
    : projected
}

/** Publish the current preset immediately and follow its public list/projection sources. */
export function watchCurrentSessionPreset(sessions, listener) {
  let source
  let unsubscribeProjection
  let selected
  const sync = () => {
    const snapshot = sessions.list.getSnapshot()
    const current = currentSessionId(snapshot, selected)
    selected = current
    const summary = current === undefined ? undefined : snapshot.byId?.[current]
    const next = current === undefined
      ? undefined : sessions.binding?.(current)?.session?.projections?.faceOf?.('agentPreset')
    if (source !== next) {
      unsubscribeProjection?.()
      source = next
      unsubscribeProjection = source?.subscribe(sync)
    }
    listener(sessionPresetValue(source?.getSnapshot(), summary))
  }
  const unsubscribeList = sessions.list.subscribe(sync)
  const dispose = () => {
    unsubscribeList()
    unsubscribeProjection?.()
  }
  try {
    sync()
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}

/** Missing legacy interaction evidence never proves that the composer is idle. */
export function isIdleSessionComposer(owner, sessionId) {
  return Object.hasOwn(owner, 'sessionId')
    ? owner.sessionId === sessionId && owner.pendingInteraction === undefined
    : owner.session?.sessionId === sessionId && Array.isArray(owner.interactions) && owner.interactions.length === 0
}

/**
 * The row this bundle's own patch declares for its Cordis entry in
 * `cordis.patch.yml`; it is the row-id half of the row-configuration key below,
 * so renaming one means renaming the other.
 */
const BUNDLE_PATCH_ROW_ID = 'ptc-plus'

/**
 * Plugin-owned configuration seats. Current Hosts use the bundle's row page;
 * preceding Hosts use the settings namespace card. General settings may coexist
 * with either surface and is not a destination for this plugin's configuration.
 * Undeclared slots stay pending until their owning page mounts.
 *
 * @param bundleName - this bundle's package name, as the profile installs it.
 * @returns one `{ slot, identity }` per supported plugin configuration surface.
 */
export function settingsCardSeats(bundleName) {
  return [
    { slot: 'settings.plugin.item', identity: { key: SETTINGS_NAMESPACE } },
    { slot: 'plugins.row.config', identity: { key: `${bundleName}#${BUNDLE_PATCH_ROW_ID}` } },
  ]
}

/**
 * Publish the settings card when a plugin configuration surface is declared.
 * The observed seat supplies the native-location hint for the composer shortcut.
 *
 * @param ctx - browser plugin context carrying `slots`.
 * @param options.bundleName - this bundle's package name, as the profile installs it.
 * @param options.locale - locale namespace owning the card's copy.
 * @param options.injectProps - inject face producing the card's props.
 * @param options.component - the card component; it renders the summary view as
 *   one line and the card's other views as the full settings form.
 * @returns `seat` reports the live seat's slot name, and `releases` holds one
 *   disposer per seat for callers that release them explicitly.
 */
export function publishSettingsCard(ctx, { bundleName, locale, injectProps, component }) {
  let live
  const releases = settingsCardSeats(bundleName).map(({ slot, identity }) => ctx.slots.inject(
    slot,
    () => {
      live = slot
      return ctx.slots.register({ name: slot, ...identity, locale, inject: injectProps }, component)
    },
  ))
  return { seat: () => live, releases }
}
