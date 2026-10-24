import { createHash } from 'node:crypto'

/**
 * Retention window for the host-only session-log projection.
 *
 * The projection is a fold shortcut, not the session log. Keeping the payload of
 * every call would make a checkpoint proportional to how many bytes the session
 * wrote (issue #10: a 77 MB state that the host cloned and pretty-printed until
 * it aborted). The window is therefore bounded by default: the newest runs keep
 * their payload so tips and the current edit target stay synchronous, and every
 * older cluster is dropped into one chained summary. An entry that alone exceeds
 * the byte budget is dropped as well — the bound wins over the convenience of
 * the hot cell, and the edit path refolds that cell from the session log.
 *
 * The environment overrides may only *lower* the window for tests; a value that
 * would disable the bound is ignored so a deployment cannot silently return to
 * an unbounded checkpoint.
 */
const DEFAULT_MAX_RETAINED_RUNS = 32
const DEFAULT_MAX_RETAINED_BYTES = 8 * 1024 * 1024

function boundedOverride(raw, fallback) {
  const value = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value) || value < 1) return fallback
  return Math.min(value, fallback)
}

export const MAX_RETAINED_RUNS = Math.floor(boundedOverride(process.env.DSH_PTC_RETENTION_RUNS, DEFAULT_MAX_RETAINED_RUNS))
export const MAX_RETAINED_BYTES = boundedOverride(process.env.DSH_PTC_RETENTION_BYTES, DEFAULT_MAX_RETAINED_BYTES)

/** Shout when the retention window cannot hold the payload a consumer needs. */
export const PRUNED_EDIT = '该单元格超出保留窗口，已不可编辑'
export const PRUNED_EDIT_EN = 'This cell is outside the retention window and can no longer be edited'

export function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null, (_key, field) => (
    isPlainRecord(field) ? Object.fromEntries(Object.keys(field).sort().map(key => [key, field[key]])) : field
  ))).digest('hex')
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function byteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (value === undefined || value === null) return 0
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Identity of one settlement for the retention summary.
 *
 * A dropped settlement keeps three facts: its result position, its call position
 * and the digest of the argument text the log still holds. Those three are exactly
 * what a fold of the session log can reproduce, so the chain over them can be
 * recomputed from the log; the normalized digest is recorded for diagnostics but
 * stays out of the chain, because a settlement that was compacted earlier recorded
 * only its payload digest rather than the normalized object itself.
 */
export function summaryEntry(settlement, resultSeq) {
  return {
    resultSeq,
    callSeq: settlement?.call?.seq,
    argumentsDigest: settlement?.call?.data?.argumentsDigest ?? digestOf(settlement?.call?.data?.arguments ?? null),
    normalizedDigest: settlement?.normalized?.payloadDigest ?? digestOf(settlement?.normalized ?? null),
  }
}

/** The part of an entry the chain commits to: reproducible from the log alone. */
function chainEntry(entry) {
  return { callSeq: entry.callSeq, resultSeq: entry.resultSeq, argumentsDigest: entry.argumentsDigest }
}

const EMPTY_CHAIN = digestOf(null)

/** Extend a chained retention summary with the settlements it just dropped. */
export function extendSummary(previous, entries) {
  if (entries.length === 0) return previous
  let chain = previous?.chainDigest ?? EMPTY_CHAIN
  let count = previous?.count ?? 0
  let fromSeq = previous?.fromSeq
  let toSeq = previous?.toSeq
  for (const entry of entries) {
    chain = digestOf({ chain, entry: chainEntry(entry) })
    count += 1
    fromSeq = fromSeq === undefined ? entry.resultSeq : Math.min(fromSeq, entry.resultSeq)
    toSeq = toSeq === undefined ? entry.resultSeq : Math.max(toSeq, entry.resultSeq)
  }
  return { fromSeq, toSeq, count, chainDigest: chain }
}

/** Payload bytes a settlement still retains, used to decide pruning. */
export function settlementBytes(settlement) {
  let bytes = 0
  const args = settlement?.call?.data?.arguments
  if (typeof args === 'string') bytes += byteLength(args)
  const normalized = settlement?.normalized
  if (normalized !== undefined) bytes += byteLength(normalized)
  if (settlement?.publication !== undefined) bytes += byteLength(settlement.publication)
  return bytes
}
