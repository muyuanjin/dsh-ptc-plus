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
 * The slot seats one generation of DSH offers for a plugin's own settings card,
 * oldest generation first:
 *
 * - The settings-card generation declares
 *   `settings.plugin.item` (keyed, root) as the child slot of its configurable
 *   tab and renders one card per settings namespace the Host serves, so this
 *   plugin's key is its namespace.
 * - The bundle-row generation exposes that section as a read-only inventory,
 *   and a bundle's own configuration belongs to the side bar Plugins page,
 *   which declares `plugins.row.config` (keyed, root) and renders the entry's
 *   summary on the row's page with the entry's form below it. The key is
 *   `<bundle package name>#<row id>`. The same page's `plugins.item` list is its
 *   Official group, occupied by the host-plane configuration pages DSH itself
 *   ships, so it is not a seat for a third-party bundle.
 *
 * - The General settings generation declares `settings.general.item` (list,
 *   root), with `id` identifying the contributed row inside Settings / General.
 *
 * Each generation declares its own seat, and `ctx.slots.inject` waits rather than
 * failing while a key is undeclared: the callback runs only after the declaring
 * entry mounts, and nothing is registered until then. One publication therefore
 * serves every generation without probing a version, and no card renders twice
 * on a generation that exists.
 *
 * @param bundleName - this bundle's package name, as the profile installs it.
 * @returns one `{ slot, identity }` per generation.
 */
export function settingsCardSeats(bundleName) {
  return [
    { slot: 'settings.plugin.item', identity: { key: SETTINGS_NAMESPACE } },
    { slot: 'plugins.row.config', identity: { key: `${bundleName}#${BUNDLE_PATCH_ROW_ID}` } },
    { slot: 'settings.general.item', identity: { id: SETTINGS_NAMESPACE } },
  ]
}

/**
 * Publish one settings card to every seat above and report which seat the
 * installed generation declared.
 *
 * Only the declaring generation runs a seat's callback, so the card's location
 * is observed rather than inferred: the seat that registered is where a user
 * finds the card now, and that is what any copy pointing at it must say.
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
