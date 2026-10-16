/**
 * Official persistent-REPL priority.
 *
 * The official `persistent-in-memory` execution mode is a live provider
 * capability, not a release fact: a provider reports `programFormat` `'repl'`
 * exactly when it retains a REPL per state owner. While the user selects the
 * official REPL priority and that provider is live, the plugin yields PTC
 * session execution to the official implementation and installs no session
 * runtime: `run_code`, its descriptors and its guidance stay official. The
 * decision is re-evaluated on every configuration change and host source
 * change, so either side can take over without restarting the host.
 */

/**
 * Decide whether this configuration yields PTC session execution to the
 * official provider.
 * @param {object} config - resolved plugin configuration.
 * @param {object} provider - the live provider surface registered for the seam.
 * @returns {boolean} true when the official persistent REPL owns execution.
 */
export function defersToOfficialRepl(config, provider) {
  if (config?.officialReplPriority !== true) return false
  try {
    return provider?.programFormat === 'repl'
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
