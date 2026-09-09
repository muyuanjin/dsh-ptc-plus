import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRecord } from '../internal/record-utils.js'
import {
  migrateRecoveryBoundaryEvents,
  normalizeRecoveryBoundaries,
  RECOVERY_BOUNDARY_EVENT,
} from '../internal/session-journal.js'
import { foldSessionTimeline, isConfirmableNoop } from '../internal/session-journal-recovery.js'
import { REPL_TOOL_NAMES, usesCallSequenceConfirms } from '../internal/session-journal-schema.js'
import { hostRequire } from './dsh-host-contract.mjs'

function parseJsonLines(text) {
  if (typeof text !== 'string') throw new TypeError('session log text must be a string')
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid session JSONL at line ${index + 1}: ${error.message}`)
    }
  })
}

function serializeJsonLines(events) {
  if (!Array.isArray(events)) throw new TypeError('session log events must be an array')
  return events.length === 0 ? '' : `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

function restoreArtifact(catalog, header, events) {
  const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(event)
  return restore.finish()
}

function validatePtcTimeline(events) {
  const timeline = foldSessionTimeline(events)
  if (timeline.unavailableResultSeq !== undefined) {
    throw new Error(`unproved PTC history at event ${timeline.unavailableResultSeq}`)
  }
  for (const result of timeline.results.values()) {
    if (result.error !== undefined) throw new Error(`unproved PTC history: ${result.error}`)
    for (const callSeq of result.journal?.confirms ?? []) {
      if (!isConfirmableNoop(timeline, callSeq, result.eventIndex)) {
        throw new Error(`unproved PTC confirmation of call ${callSeq}`)
      }
    }
  }
}

/** Tool records remain ordered and unchanged in DSH's public format migration. */
function remapPtcReferences(source, target) {
  const toolRecords = events => events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
  const before = toolRecords(source)
  const after = toolRecords(target)
  if (before.length !== after.length) throw new Error('DSH migration changed the number of tool records')
  const calls = new Map()
  const seen = new Set()
  for (let index = 0; index < before.length; index++) {
    const old = before[index]
    const next = after[index]
    if (!Number.isSafeInteger(old.seq) || old.seq < 0 || seen.has(old.seq)
      || old.type !== next.type || old.time !== next.time || !isDeepStrictEqual(old.data, next.data)) {
      throw new Error('DSH migration did not preserve ordered tool record identities')
    }
    seen.add(old.seq)
    if (old.type === 'tool/call') calls.set(old.seq, { old, next })
  }
  validatePtcTimeline(source)
  for (let index = 0; index < before.length; index++) {
    const old = before[index]
    const next = after[index]
    if (old.type !== 'tool/result' || !isRecord(next.data.meta)) continue
    const mapCall = seq => {
      const call = calls.get(seq)
      if (call === undefined || !REPL_TOOL_NAMES.has(call.old.data.name)
        || call.old.seq >= old.seq || call.next.seq >= next.seq) {
        throw new Error(`unproved PTC call reference ${JSON.stringify(seq)} at result ${old.seq}`)
      }
      return call.next.seq
    }
    const meta = next.data.meta
    const journal = meta.dshPtcPlus
    if (usesCallSequenceConfirms(journal) && journal.confirms !== undefined) {
      journal.confirms = journal.confirms.map(mapCall)
    }
    if (meta.dshPtcPlusEdit !== undefined) {
      meta.dshPtcPlusEdit.targetCallSeq = mapCall(meta.dshPtcPlusEdit.targetCallSeq)
    }
    if (meta.dshPtcPlusRecoveryBoundaries !== undefined) {
      meta.dshPtcPlusRecoveryBoundaries = normalizeRecoveryBoundaries(meta.dshPtcPlusRecoveryBoundaries)
        .map(boundary => ({
          failedCallSeq: mapCall(boundary.failedCallSeq),
          frontierCallSeq: boundary.frontierCallSeq === null ? null : mapCall(boundary.frontierCallSeq),
        }))
    }
  }
  validatePtcTimeline(target)
}

/** Migrate one decoded session artifact without mutating its parsed events. */
export function migrateSessionLogText(text, { catalog } = {}) {
  const [header, ...events] = parseJsonLines(text)
  if (header?.type !== 'session') throw new Error('session JSONL does not start with a session header')
  const legacyCount = events.filter(event => event?.type === RECOVERY_BOUNDARY_EVENT).length
  if (catalog !== undefined) {
    if (legacyCount > 0) {
      throw new Error('Host format migration requires a DSH-valid source log; retired recovery-boundary events need separate migration and validation first')
    }
    const artifact = restoreArtifact(catalog, header, events)
    const migrated = structuredClone(artifact.events)
    remapPtcReferences(events, migrated)
    const rows = [catalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount),
      ...migrated.map(event => catalog.encodeCurrentEvent(event))]
    restoreArtifact(catalog, rows[0], rows.slice(1))
    const changed = header.version !== artifact.header.version
    return Object.freeze({ changed, legacyCount, text: changed ? serializeJsonLines(rows) : text,
      sourceVersion: header.version, targetVersion: artifact.header.version })
  }
  if (legacyCount === 0) {
    return Object.freeze({ changed: false, legacyCount: 0, text })
  }
  const migrated = migrateRecoveryBoundaryEvents(events)
  return Object.freeze({
    changed: true,
    legacyCount,
    text: serializeJsonLines([header, ...migrated]),
  })
}

function isCompressed(file) {
  return file.endsWith('.zstd')
}

function decodeArtifact(file, options = {}) {
  if (!isCompressed(file)) return readFile(file, 'utf8')
  const run = options.execFileSync ?? execFileSync
  return Promise.resolve(run('zstd', ['-q', '-d', '-c', file], {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 512 * 1024 * 1024,
  }))
}

function encodeArtifact(file, text, options = {}) {
  const writeOptions = { flag: options.overwrite ? 'w' : 'wx' }
  if (!isCompressed(file)) return writeFile(file, text, { ...writeOptions, encoding: 'utf8' })
  const run = options.execFileSync ?? execFileSync
  const headerEnd = text.indexOf('\n')
  if (headerEnd < 0) throw new Error('session log does not contain a header line')
  const encodeFrame = input => run('zstd', ['-q', '-T0', '--check', '-c'], {
    input,
    maxBuffer: options.maxBuffer ?? 512 * 1024 * 1024,
  })
  const headerFrame = encodeFrame(text.slice(0, headerEnd + 1))
  const eventFrame = encodeFrame(text.slice(headerEnd + 1))
  return writeFile(file, Buffer.concat([headerFrame, eventFrame]), writeOptions)
}

/**
 * Migrate a file into a separate output path. Existing files are never replaced
 * unless `overwrite` is explicitly true; the input artifact is never changed.
 */
export async function migrateSessionLogFile(input, output, options = {}) {
  const inputPath = resolve(input)
  const outputPath = resolve(output)
  if (inputPath === outputPath) throw new Error('migration output must differ from input')
  const source = await decodeArtifact(inputPath, options)
  const catalog = options.catalog ?? (options.dshEntry === undefined ? undefined
    : hostRequire(options.dshEntry)('@deepseek-ai/dsh-session-format-catalog').sessionFormatCatalog)
  const result = migrateSessionLogText(source, { catalog })
  if (!result.changed) return Object.freeze({ ...result, input: inputPath, output: outputPath, written: false })
  try {
    const destination = await stat(outputPath, { bigint: true })
    const origin = await stat(inputPath, { bigint: true })
    if (destination.dev === origin.dev && destination.ino === origin.ino) {
      throw new Error('migration output must not alias input')
    }
    if (!options.overwrite) throw new Error(`migration output already exists: ${outputPath}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await encodeArtifact(outputPath, result.text, options)
  return Object.freeze({ ...result, input: inputPath, output: outputPath, written: true })
}

function usage() {
  return 'Usage: node scripts/migrate-session-log.mjs --input PATH --output PATH [--dsh-entry PATH] [--force]'
}

function parseArgs(argv) {
  const values = { force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') {
      values.force = true
      continue
    }
    if (arg === '--input' || arg === '--output' || arg === '--dsh-entry') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      values[arg.slice(2)] = value
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }
  if (values.input === undefined || values.output === undefined) throw new Error(usage())
  return values
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const result = await migrateSessionLogFile(args.input, args.output, { overwrite: args.force, dshEntry: args['dsh-entry'] })
  if (!result.changed) {
    console.log('session log needs no migration; no output written')
    return result
  }
  console.log(result.targetVersion === undefined
    ? `migrated ${result.legacyCount} legacy recovery boundary event(s) to ${result.output}`
    : `migrated Session format ${result.sourceVersion} to ${result.targetVersion}, preserving PTC references: ${result.output}`)
  return result
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error.message ?? String(error))
    process.exitCode = 1
  })
}
