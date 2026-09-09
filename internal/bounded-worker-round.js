/** How a bounded worker round ended without a result. */
export const ROUND_TIMEOUT = 'timeout'
export const ROUND_CANCELLED = 'cancelled'
export const ROUND_OUTPUT_LIMIT = 'output-limit'

/**
 * Own one bounded worker round: captured output bytes, the wall-clock deadline,
 * cancellation and a single settlement. Worker creation, retention and
 * termination stay with the caller, which is told exactly once how the round
 * ended through `settle({ ok: true, result })` or `settle({ ok: false, reason })`.
 */
export function createBoundedWorkerRound({ maxOutputBytes, maxWallMs, signal, settle }) {
  const logs = []
  let capturedBytes = 0
  let ended = false
  const end = (outcome) => {
    if (ended) return false
    ended = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    settle(outcome)
    return true
  }
  const fail = reason => end({ ok: false, reason })
  const abort = () => { fail(ROUND_CANCELLED) }
  const timer = setTimeout(() => fail(ROUND_TIMEOUT), maxWallMs)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted === true) fail(ROUND_CANCELLED)
  return Object.freeze({
    logs,
    /** Record one stream chunk; ends the round when the byte budget is exceeded. */
    capture(channel, text) {
      if (ended) return
      capturedBytes += Buffer.byteLength(text, 'utf8')
      if (capturedBytes > maxOutputBytes) { fail(ROUND_OUTPUT_LIMIT); return }
      logs.push({ channel, text })
    },
    /**
     * True when the byte budget is spent.
     *
     * `envelope` measures the object the caller returns with the captured `logs`
     * included as a member, so log wrappers and JSON escaping count against the
     * same budget; that is the candidate run's returned-envelope budget. Without
     * it the raw captured bytes plus the serialized payload are measured, which is
     * the workbench console's output budget.
     */
    exceeds(payload, { envelope = false } = {}) {
      if (envelope) {
        return Buffer.byteLength(JSON.stringify({ ...payload, logs }), 'utf8') > maxOutputBytes
      }
      return capturedBytes + Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxOutputBytes
    },
    succeed(result) { return end({ ok: true, result }) },
    fail,
  })
}
