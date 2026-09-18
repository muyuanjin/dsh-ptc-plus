import { SETTINGS_NAMESPACE } from '../internal/config-spec.js'

function sessionPresetValue(projected, summary) {
  return projected !== undefined || Object.hasOwn(summary?.projectionValues ?? {}, 'agentPreset')
    ? projected : summary?.agentPreset
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
  const sync = () => {
    const snapshot = sessions.list.getSnapshot()
    const current = snapshot.current
    const next = current === undefined ? undefined
      : sessions.binding(current)?.session.projections?.faceOf?.('agentPreset')
    if (source !== next) {
      unsubscribeProjection?.()
      source = next
      unsubscribeProjection = source?.subscribe(sync)
    }
    listener(sessionPresetValue(source?.getSnapshot(), snapshot.byId?.[current]))
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
 * - DSH 0.1.5 and earlier: the Settings panel's Plugins section declares
 *   `settings.plugin.item` (keyed, root) as the child slot of its configurable
 *   tab and renders one card per settings namespace the Host serves, so this
 *   plugin's key is its namespace.
 * - DSH 0.1.6-alpha.2 and later: that section is a read-only inventory, and a
 *   bundle's own configuration belongs to the side bar Plugins page, which
 *   declares `plugins.row.config` (keyed, root) and renders the entry's summary
 *   on the row's page with the entry's form below it. The key is
 *   `<bundle package name>#<row id>`. The same page's `plugins.item` list is its
 *   Official group, occupied by the host-plane configuration pages DSH itself
 *   ships, so it is not a seat for a third-party bundle.
 *
 * No generation declares both keys, and `ctx.slots.inject` waits rather than
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
  ]
}

/**
 * Publish one settings card to every seat above.
 *
 * @param ctx - browser plugin context carrying `slots`.
 * @param options.bundleName - this bundle's package name, as the profile installs it.
 * @param options.locale - locale namespace owning the card's copy.
 * @param options.injectProps - inject face producing the card's props.
 * @param options.component - the card component; it renders the summary view as
 *   one line and the card's other views as the full settings form.
 * @returns one disposer per seat, for callers that release them explicitly.
 */
export function publishSettingsCard(ctx, { bundleName, locale, injectProps, component }) {
  return settingsCardSeats(bundleName).map(({ slot, identity }) => ctx.slots.inject(
    slot,
    () => ctx.slots.register({ name: slot, ...identity, locale, inject: injectProps }, component),
  ))
}
