/**
 * Shutdown protocol shared by the plugin's worker entries.
 *
 * Each worker entry releases the machinery it owns when it receives the request
 * and reports that release with the acknowledgement. The release, the real exit
 * and the kill bound belong to the helper process boundary in
 * isolated-worker.js; these two constants are the only part the worker entries
 * themselves need.
 */

/** Request that asks one worker to release everything it owns and stop. */
export const WORKER_SHUTDOWN_REQUEST = 'shutdown'
/** Reply a worker posts after releasing its own machinery, before it exits. */
export const WORKER_SHUTDOWN_ACKNOWLEDGEMENT = 'shutdown-released'
