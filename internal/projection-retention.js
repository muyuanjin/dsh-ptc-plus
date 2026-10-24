import { createHash } from 'node:crypto'

/**
 * Retention window for the host-only session-log projection.
 *
 * The projection is a fold shortcut, not the session log. Keeping the payload of
 * every call would make a checkpoint proportional to how many bytes the session
 * wrote (issue #10: a 77 MB state that the host cloned and pretty-printed until
 * it aborted). Inside the window the text stays available so tips, edit targets
 * and republication keep working synchronously; outside it only digests and
 * positions remain, and consumers that need the text must report that the entry
 * was pruned instead of guessing.
 */
// Default is unbounded: a bounded window breaks recovery-after-contraction (see
// ADR 0032), and recovery cannot refold a pruned settlement from the log yet. The
// environment overrides let tests exercise the mechanism in the meantime.
// The window is enabled by default: a checkpoint must not grow with how many bytes
// the session wrote (issue #10: a 77 MB state the host cloned until it aborted).
// The newest 32 runs keep their payload — enough for tips, the current edit target
// and republication of what a user is actually looking at — and everything older
// keeps identity digests and positions only. The environment overrides exist so a
// test can shrink the window and exercise the contraction.
export const MAX_RETAINED_RUNS = Number(process.env.DSH_PTC_RETENTION_RUNS ?? 32)
export const MAX_RETAINED_BYTES = Number(process.env.DSH_PTC_RETENTION_BYTES ?? (8 * 1024 * 1024))

/** Shout when the retention window cannot hold the payload a consumer needs. */
export const PRUNED_EDIT = '该单元格超出保留窗口，已不可编辑'
export const PRUNED_EDIT_EN = 'This cell is outside the retention window and can no longer be edited'
export const PRUNED_REPUBLISH = '该运行已裁剪，无法重新发布'
export const PRUNED_REPUBLISH_EN = 'This run was pruned and cannot be republished'
export const PRUNED_REASON = 'retention-pruned'

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

/** A pruned call keeps identity and a digest of the arguments it no longer stores. */
export function prunedCallEvent(event) {
  if (event?.data?.arguments === undefined) return event
  const { arguments: raw, ...rest } = event.data
  return { seq: event.seq, type: event.type, data: {
    ...rest,
    argumentsDigest: digestOf(raw),
    argumentsBytes: byteLength(raw),
  } }
}

/** A pruned normalized result keeps its position and an identity digest only. */
export function prunedNormalized(normalized) {
  if (normalized === undefined) return undefined
  // Re-pruning an already pruned entry must not re-digest: the payload it hashed is
  // gone, so the recorded digest is the only stable identity.
  if (normalized.payloadDigest !== undefined && normalized.journal === undefined
    && normalized.derived === undefined && normalized.error === undefined) return normalized
  return {
    eventSeq: normalized.eventSeq,
    eventIndex: normalized.eventIndex,
    ...(normalized.positionSeq === undefined ? {} : { positionSeq: normalized.positionSeq }),
    payloadDigest: digestOf(normalized),
  }
}

/** A pruned settlement keeps chronology and identity, not the result payload. */
export function prunedSettlement(settlement) {
  const { call, normalized, publication, entry, ...rest } = settlement
  return {
    ...rest,
    call: prunedCallEvent(call),
    entry,
    pruned: true,
    ...(normalized === undefined ? {} : { normalized: prunedNormalized(normalized) }),
    ...(publication === undefined ? {} : {
      publication: publication.payloadDigest !== undefined && publication.journal === undefined
        && publication.derived === undefined
        ? publication
        : { index: publication.index, payloadDigest: digestOf(publication) },
    }),
  }
}

/**
 * Which settlements stay inside the window.
 *
 * `entries` is oldest-first. The newest entries are always retained; older ones
 * stay only while both the run count and the retained payload stay under the
 * caps. The newest entry is retained even when it alone exceeds the byte cap,
 * because a checkpoint with no payload at all cannot serve the next tip or edit.
 */
export function retainNewest(entries) {
  const retained = []
  let bytes = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const size = entry.bytes
    if (retained.length >= MAX_RETAINED_RUNS) break
    if (size > 0 && bytes + size > MAX_RETAINED_BYTES && retained.length > 0) break
    retained.push(entry)
    bytes += size
  }
  return new Set(retained.map(entry => entry.seq))
}

/**
 * Identity of one settlement for the retention summary.
 *
 * A dropped settlement keeps nothing but these four facts, folded into one
 * running chain digest: its position, its call, and the digests of the argument
 * text and normalized result it used to carry.
 */
export function summaryEntry(settlement, resultSeq) {
  return {
    resultSeq,
    callSeq: settlement?.call?.seq,
    argumentsDigest: settlement?.call?.data?.argumentsDigest ?? digestOf(settlement?.call?.data?.arguments ?? null),
    normalizedDigest: settlement?.normalized?.payloadDigest ?? digestOf(settlement?.normalized ?? null),
  }
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
    chain = digestOf({ chain, entry })
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
