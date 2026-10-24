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
// Default is unbounded: enabling the window changes what a checkpoint can prove
// (pruned runs are identity-only), and the projection-level admission comparison
// for a pruned checkpoint is not yet reproducible. Tests set
// DSH_PTC_RETENTION_RUNS to exercise the mechanism until that is resolved.
export const MAX_RETAINED_RUNS = Number(process.env.DSH_PTC_RETENTION_RUNS ?? Number.POSITIVE_INFINITY)
export const MAX_RETAINED_BYTES = Number(process.env.DSH_PTC_RETENTION_BYTES ?? Number.POSITIVE_INFINITY)

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
    // `entry.event` certifies the same call; prune it identically or admission
    // would see the settlement disagree with its own entry.
    ...(entry === undefined ? {} : { entry: { ...entry, event: prunedCallEvent(entry.event) } }),
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
