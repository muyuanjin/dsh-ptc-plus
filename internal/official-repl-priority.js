/**
 * Official persistent-REPL priority.
 *
 * The question is not which source form the official provider evaluates; it is
 * whether that provider keeps a program environment alive per state owner. A
 * host declares that fact as `retainsState`, and the answer decides who owns PTC
 * session execution: while the user selects the official REPL priority and the
 * live provider retains state, the plugin yields execution to the official
 * implementation and installs no session runtime — `run_code`, its descriptors
 * and its guidance stay official. Neither the source form nor a release
 * identifier can answer it: one host line retains state for `script` programs and
 * another runs the same `script` in a fresh process, and an earlier line could
 * only report the REPL form at all. The decision is re-evaluated on every
 * configuration change and host source change, so either side can take over
 * without restarting the host.
 */

/**
 * Whether a live provider retains a program environment per state owner.
 *
 * A provider that reports `retainsState` answers directly, whatever source form
 * it evaluates. A provider that predates that declaration leaks the same fact
 * through its source form: only `repl` was retained, so a `script` or function
 * body from that host is a fresh environment.
 * @param {object} provider - the provider surface registered for the seam.
 * @returns {boolean} true when the provider keeps state across runs per owner.
 */
export function providerRetainsState(provider) {
  const reported = provider?.retainsState
  if (typeof reported === 'boolean') return reported
  // Without the declaration the source form is the only published evidence.
  return provider?.programFormat === 'repl'
}

/**
 * Decide whether this configuration yields PTC session execution to the
 * official provider.
 * @param {object} config - resolved plugin configuration.
 * @param {object} provider - the live provider surface registered for the seam.
 * @returns {boolean} true when the official provider owns execution.
 */
export function defersToOfficialRepl(config, provider) {
  if (config?.officialReplPriority !== true) return false
  try {
    return providerRetainsState(provider)
  } catch {
    // An unreadable capability descriptor cannot prove official ownership;
    // the plugin keeps its execution responsibility instead of guessing.
    return false
  }
}

/**
 * Runtime record for an attachment that yields execution to the official
 * provider. It owns no execution resources: the official provider releases
 * anything it retained through its own lifecycle, and the plugin's settings,
 * storage and UI owners remain available so the user can switch back.
 */
export function createDeferredRuntime() {
  return Object.freeze({
    cancelCordisActivation() {
      // No Cordis companion is installed while execution is deferred.
    },
    contextsForRequest: () => [],
    async reconfigure() {
      // This attachment has no owners to reconfigure.
    },
    async dispose() {
      // Nothing is owned here; disposal returns immediately.
    },
  })
}
