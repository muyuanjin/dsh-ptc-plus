import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { hostRequire } from './dsh-host-contract.mjs'
import { RETIRED_SURFACE_RECORD } from '../internal/message-sources.js'

/**
 * Repair a session log whose surface nodes precede the protected head.
 *
 * A session decision (a capability choice, a binding adoption) was delivered as a
 * `user/message`, and the host protects the first surface head: a node that reaches the log
 * before it makes the whole log unreadable to the released format, so every reader that folds
 * the log back — a reload, a resume and the export share one decoder — refuses the session.
 * Releases of dsh-ptc-plus between 0.5.4 and the fix appended such a node whenever a session
 * decided before its first step.
 *
 * The repair keeps every sequence number and every other event untouched: each offending
 * surface node becomes an ignorable plugin record of the same payload, which no reader
 * interprets as a surface node and every reader retains. No statement is lost either, because
 * the payload is what names its owner: the owner whose PTC form it carries reads it back (a
 * capability choice and a binding adoption are each read by their own reader), and a retired
 * node carrying neither form is not read as either of them.
 *
 * The input artifact is never modified unless `--write` is given, and that path copies it
 * to `<input>.bak` first.
 */

function hostFormatModule(dshEntry) {
  return hostRequire(dshEntry)('@deepseek-ai/dsh-session-format-v3-to-v4')
}

/** Split a concatenated-frame Zstandard artifact into its decoded logical log. */
export function decodeArtifact(buffer) {
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
  }
  if (starts.length === 0) throw new Error('the artifact carries no Zstandard frame')
  starts.push(buffer.length)
  const parts = []
  for (let frame = 0; frame < starts.length - 1; frame += 1) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[frame], starts[frame + 1])))
    } catch (error) {
      throw new Error(`the Zstandard frame at byte ${starts[frame]} does not decode (${error.message}); inspect the artifact with the zstd executable before repairing it`)
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Two frames, the way the persistence backend writes a header batch and an event batch. */
export function encodeArtifact(text) {
  const headerEnd = text.indexOf('\n')
  if (headerEnd < 0) throw new Error('the repaired log has no header line')
  return Buffer.concat([
    zstdCompressSync(Buffer.from(text.slice(0, headerEnd + 1), 'utf8')),
    zstdCompressSync(Buffer.from(text.slice(headerEnd + 1), 'utf8')),
  ])
}

function parseLines(text) {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid session JSONL at line ${index + 1}: ${error.message}`)
    }
  })
}

/**
 * Rewrite every surface node that precedes the protected head.
 *
 * "Precedes the head" is read from the log itself: the offending events are the surface
 * nodes recorded before the first `system/message`. A session that has not published a
 * head yet is the most common case of this damage — its statement is the only surface
 * node it has, and the next head the Host writes would make the log unreadable — so a log
 * with no head at all is repaired in full rather than passed over. A log that already
 * satisfies the released format is returned unchanged, so running the repair twice is a
 * no-op.
 */
export function repairRecords(records) {
  const events = records.slice(1)
  const headIndex = events.findIndex(event => event?.type === 'system/message')
  const cutoff = headIndex < 0 ? events.length : headIndex
  const repaired = []
  const next = records.map((record, index) => {
    const eventIndex = index - 1
    if (eventIndex < 0 || eventIndex >= cutoff) return record
    if (record?.surfaceOp === undefined) return record
    // The statement keeps its payload and gives up the carrier it may no longer use: an
    // ignorable record is retained by every reader and interpreted as a surface node by
    // none, so a surface range that pointed at it is gone with the field.
    const { surfaceOp, sourceEventSeqs, ...rest } = record
    repaired.push({ seq: record.seq, type: record.type })
    return { ...rest, type: RETIRED_SURFACE_RECORD, ignorable: true }
  })
  return { records: next, repaired }
}

export function repairLogText(text, { format } = {}) {
  const records = parseLines(text)
  const { records: repaired, repaired: changed } = repairRecords(records)
  if (changed.length === 0) return { changed: [], text }
  // Prove the repair where the reader would refuse the original: the released format
  // admits this log only when every surface node follows the protected head. A seeded log
  // states its inherited cut with the end-seed marker, and the delivery check reads that
  // cut as the boundary between inherited and current-generation rows.
  if (format !== undefined) {
    const [header, ...events] = repaired
    const { type: _type, ...headerRest } = header
    const seedEnd = events.findIndex(event => event?.type === 'session/end-seed')
    format.assertReleasedV4Relationships({
      header: headerRest,
      events: events.map(event => ({ ...event })),
      inheritedEventCount: seedEnd < 0 ? 0 : seedEnd + 1,
    }, format.RELEASED_V3_EVENT_TYPES)
  }
  return { changed, text: `${repaired.map(record => JSON.stringify(record)).join('\n')}\n` }
}

function usage() {
  return 'Usage: node scripts/repair-session-log.mjs --input PATH [--output PATH] [--write] [--dsh-entry PATH]'
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--write') { values.write = true; continue }
    if (arg === '--input' || arg === '--output' || arg === '--dsh-entry') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      values[arg.slice(2)] = value
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }
  if (values.input === undefined) throw new Error(usage())
  if (values.write && values.output !== undefined) throw new Error('--write and --output are mutually exclusive')
  return values
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const input = resolve(args.input)
  const format = hostFormatModule(args['dsh-entry'])
  const text = decodeArtifact(await readFile(input))
  const result = repairLogText(text, { format })
  if (result.changed.length === 0) {
    console.log(JSON.stringify({ input, repaired: 0, written: false }))
    return 0
  }
  const target = args.output !== undefined ? resolve(args.output) : join(dirname(input), 'session.repaired.jsonl.zstd')
  if (target === input && !args.write) throw new Error('the repaired log needs an explicit output path')
  const artifact = encodeArtifact(result.text)
  if (args.write) await copyFile(input, `${input}.bak`)
  await writeFile(args.write ? input : target, artifact)
  console.log(JSON.stringify({ input, output: args.write ? input : target,
    backup: args.write ? `${input}.bak` : undefined,
    repaired: result.changed.length, events: result.changed }))
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exitCode = 1
  }
}
