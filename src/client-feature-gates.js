/**
 * Settings snapshot to feature eligibility. Each feature names the settings that
 * gate exactly one contribution, so a new gated surface reads one table instead
 * of copying a predicate. Session facts (preset, projections) and public
 * capabilities stay with their own owners and are combined at the call site.
 */
const FEATURE_SETTINGS = Object.freeze({
  // The plugin master switch plus every contribution that only needs it.
  plugin: [],
  // Global User Bindings: the workbench, its command renderer and the author menu.
  bindings: ['userBindingsEnabled'],
  // Enhanced run_code tool rows.
  toolView: ['enhancedToolView'],
  // The REPL view tab; the session preset condition is added by its registration.
  replView: ['replViewEnabled'],
  // The composer authoring menu.
  authorButton: ['userBindingsEnabled', 'bindingAuthorButtonVisible'],
})

/**
 * Pure settings projection: a feature is eligible only from a ready snapshot
 * with the master switch on. These features default to on unless the user
 * turned them off. Writability gates setting writes, not contribution presence.
 */
export function featureEnabled(snapshot, feature) {
  const rule = FEATURE_SETTINGS[feature]
  if (rule === undefined) throw new Error(`Unknown client feature: ${feature}`)
  if (snapshot?.status !== 'ready' || snapshot.value?.enabled !== true) return false
  const value = snapshot.value
  return rule.every(key => value[key] !== false)
}

/**
 * Keep one slot registration in sync with an eligibility predicate: subscribe
 * once, register on the first eligible evaluation, unregister on the next
 * ineligible one, and dispose the registration when the owning effect is
 * released. `register` returns its own disposer and must roll back internally
 * when it fails part way; a throw leaves nothing registered.
 */
export function registerGated(scope, { subscribe, isEnabled, register }) {
  return scope.effect(() => {
    let dispose
    const sync = () => {
      const enabled = isEnabled()
      if (enabled === (dispose !== undefined)) return
      if (!enabled) {
        dispose?.()
        dispose = undefined
        return
      }
      dispose = register()
    }
    sync()
    const unsubscribe = subscribe(sync)
    return () => {
      unsubscribe?.()
      dispose?.()
    }
  })
}
