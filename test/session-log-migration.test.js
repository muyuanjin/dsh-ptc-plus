import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { pathToHead, recoverJournal } from '../internal/session-journal-recovery.js'
import { JOURNAL_VERSION, JOURNAL_VERSIONS, LANGUAGE_SEMANTICS_JOURNAL_VERSION, PER_NAME_USER_BINDINGS_JOURNAL_VERSION } from '../internal/session-journal-schema.js'
import { LEGACY_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { createUserBindingsSnapshot, normalizeUserBindingEntry, normalizeUserBindingsSnapshot, USER_BINDINGS_META_KEY } from '../internal/user-bindings.js'
import { encodeValue } from '../internal/value-wire.js'
import { appendOnlySession, appendRunCodeEvents, fixture } from './plugin-fixture.js'
import {
  main,
  migrateSessionLogFile,
  migrateSessionLogText,
} from '../scripts/migrate-session-log.mjs'

const legacyEvent = {
  seq: 1,
  type: 'ptc-plus/recovery-boundary',
  data: { failedCallSeq: 0, frontierCallSeq: null },
}

const sessionHeader = {
  type: 'session', version: 0, id: 'migration-test', createdAt: 1, cwd: 'G:\\workspace',
}

function logText(events) {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

function legacyJournal(confirms = []) {
  return {
    version: 3,
    bindingMode: 'loose',
    rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
    status: 'durable',
    calls: [],
    operations: [],
    confirms,
    diagnostics: [],
    completion: { kind: 'return', hasValue: false },
  }
}

test('migrates decoded JSONL and reports a no-op for current logs', () => {
  const source = logText([
    sessionHeader,
    { seq: 0, type: 'tool/call', data: {
      name: 'run_code', callId: 'failed', arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    legacyEvent,
    { seq: 2, type: 'tool/call', data: {
      name: 'run_code', callId: 'current', arguments: JSON.stringify({ code: 'return 2' }),
    } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ])
  const migrated = migrateSessionLogText(source)
  assert.equal(migrated.changed, true)
  assert.equal(migrated.legacyCount, 1)
  assert.equal(migrated.text.includes('ptc-plus/recovery-boundary'), false)
  assert.deepEqual(JSON.parse(migrated.text.split('\n')[0]), sessionHeader)
  assert.equal(JSON.parse(migrated.text.split('\n')[2]).seq, 1)
  assert.deepEqual(JSON.parse(migrated.text.split('\n')[3]).data.meta.dshPtcPlusRecoveryBoundaries, [{
    failedCallSeq: 0,
    frontierCallSeq: null,
  }])

  const current = migrateSessionLogText(migrated.text)
  assert.deepEqual(current, { changed: false, legacyCount: 0, text: migrated.text })
  assert.throws(() => migrateSessionLogText(logText([
    { ...sessionHeader, version: 1 },
    ...source.trim().split('\n').slice(1).map(line => JSON.parse(line)),
  ])), /only from Session format 0/)
})

test('retired-boundary migration preserves the seeded inherited-event cut', () => {
  const events = [
    { seq: 0, type: 'tool/call', data: {
      name: 'run_code', callId: 'seed-failed', arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    { seq: 1, type: 'ptc-plus/recovery-boundary',
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    { seq: 2, type: 'tool/call', data: {
      name: 'run_code', callId: 'seed-current', arguments: JSON.stringify({ code: 'return 2' }),
    } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ]
  for (const [seedLength, expected] of [[3, 2], [1, 1], [0, 0]]) {
    const header = { ...sessionHeader, seedLength }
    const source = logText([header, ...events])
    const migrated = migrateSessionLogText(source)
    assert.equal(JSON.parse(migrated.text.split('\n')[0]).seedLength, expected)
    assert.equal(source, logText([header, ...events]))
  }
  assert.throws(() => migrateSessionLogText(logText([
    { ...sessionHeader, seedLength: events.length + 1 }, ...events,
  ])), /invalid seeded event cut/)
})

test('retired-boundary migration expands released packed assistant rows', () => {
  const events = [
    { type: 'text-chunks', seq0: 0, time0: 1, data: {
      turn: 0, step: 0, index: 0, dt: [], texts: ['packed assistant text'],
    } },
    { seq: 1, type: 'tool/call', time: 1, data: {
      turn: 0, step: 0, name: 'run_code', callId: 'packed-failed',
      arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    { seq: 2, type: 'ptc-plus/recovery-boundary', time: 2,
      data: { failedCallSeq: 1, frontierCallSeq: null } },
    { seq: 3, type: 'tool/call', time: 3, data: {
      turn: 0, step: 0, name: 'run_code', callId: 'packed-current',
      arguments: JSON.stringify({ code: 'return 2' }),
    } },
    { seq: 4, type: 'tool/result', time: 4, surfaceOp: 'append', sourceEventSeqs: [3], data: {
      turn: 0, step: 0, callId: 'packed-current', content: [], isError: false,
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ]
  const migrated = migrateSessionLogText(logText([
    { ...sessionHeader, delegationDepth: 0 },
    ...events,
  ]))
  assert.equal(migrated.changed, true)
  assert.equal(migrated.legacyCount, 1)
  assert.equal(migrated.text.includes('ptc-plus/recovery-boundary'), false)
  const rows = migrated.text.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.slice(1).map(row => row.type),
    ['assistant/chunk', 'tool/call', 'tool/call', 'tool/result'])
  assert.deepEqual(rows.at(-1).data.meta.dshPtcPlusRecoveryBoundaries, [{
    failedCallSeq: 1,
    frontierCallSeq: null,
  }])
})

test('retired-boundary migration accepts the released legacy v0 spellings', () => {
  const eventsFor = (type, data) => [
    { seq: 0, type, time: 1, data },
    { seq: 1, type: 'tool/call', time: 2, data: {
      turn: 0, step: 0, name: 'run_code', callId: `${type}-failed`,
      arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    { seq: 2, type: 'ptc-plus/recovery-boundary', time: 3,
      data: { failedCallSeq: 1, frontierCallSeq: null } },
    { seq: 3, type: 'tool/call', time: 4, data: {
      turn: 0, step: 0, name: 'run_code', callId: `${type}-current`,
      arguments: JSON.stringify({ code: 'return 2' }),
    } },
    { seq: 4, type: 'tool/result', time: 5, surfaceOp: 'append', sourceEventSeqs: [3], data: {
      turn: 0, step: 0, callId: `${type}-current`, content: [], isError: false,
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ]
  // The frozen v0-to-v1 stage normalizes these legacy spellings itself, so the
  // retired-boundary converter accepts them with the same relation policy.
  for (const [type, data] of [
    ['steering/message', { turn: 0 }],
    ['compact/start', {}],
    ['compact/summary', { shadowedSeqs: [] }],
    ['compact/end', {}],
    ['compact/prune', { shadowedSeqs: [] }],
  ]) {
    const migrated = migrateSessionLogText(logText([
      { ...sessionHeader, delegationDepth: 0 },
      ...eventsFor(type, data),
    ]))
    assert.equal(migrated.changed, true, type)
    assert.equal(migrated.text.includes('ptc-plus/recovery-boundary'), false, type)
  }
  // `request/header-delta` and `mode/set` stay refused: the frozen v0 stage
  // refuses them as unsupported legacy rows as well.
  for (const type of ['request/header-delta', 'mode/set']) {
    assert.throws(() => migrateSessionLogText(logText([
      { ...sessionHeader, delegationDepth: 0 },
      ...eventsFor(type, {}),
    ])), /unsupported session event type/, type)
  }
})

test('retired-boundary migration validates a packed seeded cut in logical events', () => {
  const events = [
    { type: 'text-chunks', seq0: 0, time0: 1, data: {
      turn: 0, step: 0, index: 0, dt: [1, 1], texts: ['one', 'two', 'three'],
    } },
    { seq: 3, type: 'tool/call', time: 4, data: {
      turn: 0, step: 0, name: 'run_code', callId: 'packed-seed-failed',
      arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    { seq: 4, type: 'ptc-plus/recovery-boundary', time: 5,
      data: { failedCallSeq: 3, frontierCallSeq: null } },
    { seq: 5, type: 'tool/call', time: 6, data: {
      turn: 0, step: 0, name: 'run_code', callId: 'packed-seed-current',
      arguments: JSON.stringify({ code: 'return 2' }),
    } },
    { seq: 6, type: 'tool/result', time: 7, surfaceOp: 'append', sourceEventSeqs: [5], data: {
      turn: 0, step: 0, callId: 'packed-seed-current', content: [], isError: false,
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ]
  const migrated = migrateSessionLogText(logText([
    { ...sessionHeader, delegationDepth: 0, seedLength: 6 },
    ...events,
  ]))
  assert.equal(migrated.changed, true)
  assert.equal(JSON.parse(migrated.text.split('\n')[0]).seedLength, 5)
})

test('retired-boundary migration rejects negative-zero sequence identities before serialization', () => {
  const rows = [
    sessionHeader,
    { seq: 0, type: 'tool/call', data: {
      name: 'run_code', callId: 'negative-zero-failed',
      arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    { seq: 1, type: 'ptc-plus/recovery-boundary',
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    { seq: 2, type: 'tool/call', data: {
      name: 'run_code', callId: 'negative-zero-current',
      arguments: JSON.stringify({ code: 'return 1' }),
    } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ]
  const canonical = logText(rows)
  assert.equal(migrateSessionLogText(canonical).changed, true)
  const candidates = [
    [canonical.replace('"seq":0', '"seq":-0'), /invalid session event sequence/],
    [canonical.replace('"failedCallSeq":0', '"failedCallSeq":-0'), /invalid dsh-ptc-plus recovery boundary/],
    [canonical.replace('"sourceEventSeqs":[2]', '"sourceEventSeqs":[-0]'), /invalid source event reference/],
    [logText([{ ...sessionHeader, seedLength: 0 }, ...rows.slice(1)])
      .replace('"seedLength":0', '"seedLength":-0'), /invalid seeded event cut/],
  ]
  for (const [source, expected] of candidates) {
    assert.match(source, /-0/u)
    assert.throws(() => migrateSessionLogText(source), expected)
  }
})

test('retired-boundary migration preserves later confirmations and durable recovery', () => {
  const call = (seq, callId, code) => ({
    seq,
    type: 'tool/call',
    data: { name: 'run_code', callId, arguments: JSON.stringify({ code }) },
  })
  const source = logText([
    sessionHeader,
    call(0, 'first', 'const first = 1'),
    { seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
    call(2, 'failed', 'throw new Error("failed")'),
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: { meta: {} } },
    { seq: 4, type: 'ptc-plus/recovery-boundary', data: { failedCallSeq: 2, frontierCallSeq: 0 } },
    { seq: 5, type: 'tool/result', data: { meta: { dshPtcPlus: legacyJournal() } } },
    { seq: 6, type: 'tool/call', data: { name: 'read', callId: 'unrelated', arguments: '{}' } },
    { seq: 7, type: 'tool/result', sourceEventSeqs: [6], data: { meta: { unrelated: true } } },
    call(8, 'noop', 'return first'),
    call(9, 'current', 'const current = first + 1'),
    { seq: 10, type: 'tool/result', sourceEventSeqs: [9], data: {
      meta: { dshPtcPlus: legacyJournal([8]) },
    } },
  ])

  const migrated = migrateSessionLogText(source)
  const [, ...events] = migrated.text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(Object.hasOwn(events[4].data.meta, 'dshPtcPlusRecoveryBoundaries'), false)
  assert.equal(Object.hasOwn(events[6].data.meta, 'dshPtcPlusRecoveryBoundaries'), false)
  assert.deepEqual(events.at(-1).data.meta.dshPtcPlus.confirms, [7])
  assert.deepEqual(events.at(-1).data.meta.dshPtcPlusRecoveryBoundaries, [
    { failedCallSeq: 2, frontierCallSeq: 0 },
  ])
  const recovered = recoverJournal({ events })
  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), [
    'const first = 1',
    'const current = first + 1',
  ])
  assert.deepEqual(recovered.volatileSuffix, [])

  const orphanBoundary = logText([
    sessionHeader,
    call(0, 'carrier-validation-failed', 'throw new Error("failed")'),
    legacyEvent,
    call(2, 'carrier-validation-current', 'return 1'),
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
    { seq: 4, type: 'tool/result', data: { meta: {
      dshPtcPlus: legacyJournal(),
      dshPtcPlusRecoveryBoundaries: [{ failedCallSeq: 0, frontierCallSeq: null }],
    } } },
  ])
  assert.throws(() => migrateSessionLogText(orphanBoundary), /proved journal carrier at event 3/)
})

test('retired-boundary migration accepts only the recovery fold\'s exact frontier', () => {
  const call = (seq, callId, code) => ({
    seq,
    type: 'tool/call',
    data: { name: 'run_code', callId, arguments: JSON.stringify({ code }) },
  })
  const settled = (seq, callSeq) => ({
    seq,
    type: 'tool/result',
    sourceEventSeqs: [callSeq],
    data: { meta: { dshPtcPlus: legacyJournal() } },
  })
  const candidate = frontierCallSeq => logText([
    sessionHeader,
    call(0, 'first', 'const first = 1'),
    settled(1, 0),
    call(2, 'parent', 'const parent = 2'),
    settled(3, 2),
    call(4, 'failed', 'throw new Error("failed")'),
    { seq: 5, type: 'tool/result', sourceEventSeqs: [4], data: { meta: {} } },
    { seq: 6, type: 'ptc-plus/recovery-boundary',
      data: { failedCallSeq: 4, frontierCallSeq } },
    call(7, 'current', 'const current = 3'),
    settled(8, 7),
  ])

  assert.throws(() => migrateSessionLogText(candidate(0)), /does not prove its declared frontier/)
  assert.throws(() => migrateSessionLogText(candidate(4)), /frontier must precede its failed call/)

  const migrated = migrateSessionLogText(candidate(2))
  const [, ...events] = migrated.text.trim().split('\n').map(line => JSON.parse(line))
  const recovered = recoverJournal({ events })
  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), [
    'const first = 1',
    'const parent = 2',
    'const current = 3',
  ])

  const reset = migrateSessionLogText(logText([
    sessionHeader,
    call(0, 'failed-reset', 'throw new Error("failed")'),
    { seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { meta: {} } },
    { seq: 2, type: 'ptc-plus/recovery-boundary',
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    call(3, 'after-reset', 'const afterReset = true'),
    settled(4, 3),
  ]))
  const [, ...resetEvents] = reset.text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(recoverJournal({ events: resetEvents }).available, true)
})

test('retired and existing recovery boundaries retain historical order on one carrier', () => {
  const call = (seq, callId, code) => ({
    seq,
    type: 'tool/call',
    data: { name: 'run_code', callId, arguments: JSON.stringify({ code }) },
  })
  const settled = (seq, callSeq, meta = {}) => ({
    seq,
    type: 'tool/result',
    sourceEventSeqs: [callSeq],
    data: { meta: { dshPtcPlus: legacyJournal(), ...meta } },
  })
  const result = migrateSessionLogText(logText([
    sessionHeader,
    call(0, 'first-generation', 'const first = 1'),
    settled(1, 0),
    call(2, 'second-generation', 'const second = 2'),
    settled(3, 2),
    { seq: 4, type: 'ptc-plus/recovery-boundary',
      data: { failedCallSeq: 2, frontierCallSeq: 0 } },
    call(5, 'mixed-boundary-carrier', 'const current = 3'),
    settled(6, 5, {
      dshPtcPlusRecoveryBoundaries: [{ failedCallSeq: 0, frontierCallSeq: null }],
    }),
  ]))
  const [, ...events] = result.text.trim().split('\n').map(line => JSON.parse(line))
  const carrier = events.find(event => event.data?.meta?.dshPtcPlusRecoveryBoundaries)
  assert.deepEqual(carrier.data.meta.dshPtcPlusRecoveryBoundaries, [
    { failedCallSeq: 2, frontierCallSeq: 0 },
    { failedCallSeq: 0, frontierCallSeq: null },
  ])
  const recovered = recoverJournal({ events })
  assert.equal(recovered.available, true)
  assert.deepEqual(pathToHead(recovered).map(node => node.code), ['const current = 3'])
})

test('retired-boundary migration preserves official command, title, and summary relations', () => {
  const source = logText([
    sessionHeader,
    { seq: 0, type: 'tool/call', data: {
      name: 'run_code', callId: 'failed-official-relations',
      arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    { seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { meta: {} } },
    { seq: 2, type: 'ptc-plus/recovery-boundary',
      data: { failedCallSeq: 0, frontierCallSeq: null } },
    { seq: 3, type: 'tool/call', data: {
      name: 'run_code', callId: 'current-official-relations',
      arguments: JSON.stringify({ code: 'return 1' }),
    } },
    { seq: 4, type: 'tool/result', sourceEventSeqs: [3], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
    { seq: 5, type: 'user/message', surfaceOp: 'append',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Title me' }] } },
    { seq: 6, type: 'command/run', data: {
      commandId: 'official-relations', name: 'review', source: { kind: 'user' },
    } },
    { seq: 7, type: 'command/done', data: {
      commandId: 'official-relations', kind: 'success', sourceEventSeq: 5,
    } },
    { seq: 8, type: 'session/title', data: {
      title: 'Official relations', messageSeqs: [5], source: { kind: 'fallback' },
    } },
    { seq: 9, type: 'compaction/summary', data: {
      compactionId: 'official-relations', summary: [], shadowedSeqs: [4, 5],
      shadowedRange: { start: 4, end: 5 }, shadowedTokenCount: 0,
      provider: 'fixture', model: 'fixture',
    } },
  ])

  const migration = migrateSessionLogText(source)
  const [, ...events] = migration.text.trim().split('\n').map(line => JSON.parse(line))
  const done = events.find(event => event.type === 'command/done')
  const title = events.find(event => event.type === 'session/title')
  const summary = events.find(event => event.type === 'compaction/summary')
  assert.equal(done.data.sourceEventSeq, 4)
  assert.equal(events[done.data.sourceEventSeq].type, 'user/message')
  assert.deepEqual(title.data.messageSeqs, [4])
  assert.equal(events[title.data.messageSeqs[0]].data.source.kind, 'user')
  assert.deepEqual(summary.data.shadowedSeqs, [3, 4])
  assert.deepEqual(summary.data.shadowedRange, { start: 3, end: 4 })
  assert.equal(recoverJournal({ events }).available, true)
})

test('migrates a file without replacing the source or an existing destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'session.jsonl')
  const output = join(root, 'migrated.jsonl')
  const source = logText([
    sessionHeader,
    { seq: 0, type: 'tool/call', data: {
      name: 'run_code', callId: 'failed', arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    legacyEvent,
    { seq: 2, type: 'tool/call', data: {
      name: 'run_code', callId: 'current', arguments: JSON.stringify({ code: 'return 2' }),
    } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ])
  await writeFile(input, source)
  const result = await migrateSessionLogFile(input, output)
  assert.equal(result.written, true)
  assert.equal(await readFile(input, 'utf8'), source)
  assert.equal((await readFile(output, 'utf8')).includes('ptc-plus/recovery-boundary'), false)
  await assert.rejects(() => migrateSessionLogFile(input, output), /output already exists/)
  const forced = await migrateSessionLogFile(input, output, { overwrite: true })
  assert.equal(forced.written, true)
})

test('file migration rejects damaged source sequences without creating output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-seq-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [caseIndex, sequences] of [
    [10, 11, 12, 13],
    [0, 1, 3, 4],
    [0, 2, 1, 3],
  ].entries()) {
    const input = join(root, `damaged-${caseIndex}.jsonl`)
    const output = join(root, `migrated-${caseIndex}.jsonl`)
    const source = logText([
      sessionHeader,
      { seq: sequences[0], type: 'tool/call', data: {
        name: 'run_code', callId: `damaged-${caseIndex}`,
        arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
      } },
      { seq: sequences[1], type: 'ptc-plus/recovery-boundary',
        data: { failedCallSeq: sequences[0], frontierCallSeq: null } },
      { seq: sequences[2], type: 'tool/call', data: {
        name: 'run_code', callId: `carrier-${caseIndex}`,
        arguments: JSON.stringify({ code: 'return 1' }),
      } },
      { seq: sequences[3], type: 'tool/result', sourceEventSeqs: [sequences[2]], data: {
        meta: { dshPtcPlus: legacyJournal() },
      } },
    ])
    await writeFile(input, source)
    await assert.rejects(() => migrateSessionLogFile(input, output), /not contiguous from zero/)
    assert.equal(await readFile(input, 'utf8'), source)
    await assert.rejects(() => readFile(output, 'utf8'), { code: 'ENOENT' })
  }
})

test('file migration rejects invalid title and tool-result replacement relations before writing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-relations-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const carrierData = {
    message: { content: [{ type: 'tool-result', toolCallId: 'current', content: 'original' }] },
    meta: { dshPtcPlus: legacyJournal() },
  }
  const prefix = [
    { seq: 0, type: 'tool/call', data: {
      name: 'run_code', callId: 'relation-failed', arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    { seq: 1, type: 'ptc-plus/recovery-boundary', data: { failedCallSeq: 0, frontierCallSeq: null } },
    { seq: 2, type: 'tool/call', data: {
      name: 'run_code', callId: 'current', arguments: JSON.stringify({ code: 'return 1' }),
    } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], surfaceOp: 'append', data: carrierData },
  ]
  const candidates = [
    [...prefix, { seq: 4, type: 'session/title', data: {
      title: 'Invalid automatic title', messageSeqs: [], source: { kind: 'provider', provider: 'fixture' },
    } }],
    [...prefix, { seq: 4, type: 'tool/result', sourceEventSeqs: [3],
      surfaceOp: { op: 'replace', start: 3, end: 3 }, data: {
        ...carrierData,
        message: { content: [{ type: 'tool-result', toolCallId: 'current', content: 'replacement' }] },
        meta: { ...carrierData.meta, changed: true },
      } }],
  ]
  for (const [index, events] of candidates.entries()) {
    const input = join(root, `invalid-${index}.jsonl`)
    const output = join(root, `migrated-${index}.jsonl`)
    const source = logText([sessionHeader, ...events])
    await writeFile(input, source)
    await assert.rejects(() => migrateSessionLogFile(input, output),
      index === 0 ? /cite at least one message seq/ : /may change only content/)
    assert.equal(await readFile(input, 'utf8'), source)
    await assert.rejects(() => readFile(output, 'utf8'), { code: 'ENOENT' })
  }
})

test('encodes the session header and events as independent Zstandard frames', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'session.jsonl')
  const output = join(root, 'migrated.jsonl.zstd')
  const source = logText([
    { type: 'session', version: 0, id: 'framed', createdAt: 1, cwd: root },
    { seq: 0, type: 'tool/call', data: {
      name: 'run_code', callId: 'failed', arguments: JSON.stringify({ code: 'throw new Error("failed")' }),
    } },
    legacyEvent,
    { seq: 2, type: 'tool/call', data: {
      name: 'run_code', callId: 'current', arguments: JSON.stringify({ code: 'return 2' }),
    } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: {
      meta: { dshPtcPlus: legacyJournal() },
    } },
  ])
  const frames = []
  const execFileSync = (command, args, options) => {
    assert.equal(command, 'zstd')
    assert.deepEqual(args, ['-q', '-T0', '--check', '-c'])
    frames.push(options.input)
    return Buffer.from(`<frame>${options.input}</frame>`)
  }
  await writeFile(input, source)

  await migrateSessionLogFile(input, output, { execFileSync })

  assert.equal(frames.length, 2)
  assert.equal(frames[0], `${JSON.stringify(JSON.parse(source.split('\n')[0]))}\n`)
  assert.equal(frames[0].split('\n').length, 2)
  assert.equal(frames[1].includes('ptc-plus/recovery-boundary'), false)
  assert.equal(frames[1].includes('dshPtcPlusRecoveryBoundaries'), true)
  assert.equal(
    await readFile(output, 'utf8'),
    frames.map(frame => `<frame>${frame}</frame>`).join(''),
  )
})

test('CLI main validates required paths and leaves current logs untouched', async () => {
  await assert.rejects(() => main([]), /Usage:/)
})

// The physical v0 vocabulary is historical input, independent of the installed Host.
async function historicalTranscript(t, config = {}) {
  const runtime = fixture(config)
  t.after(() => runtime.dispose())
  let effects = 0
  const events = []
  const append = (type, data, options = {}) => {
    const event = { type, seq: events.length, time: events.length + 1, data, ...options }
    events.push(event)
    return event.seq
  }
  append('turn/start', { turn: 1 })
  let targetCallSeq
  for (const step of [1, 2]) {
    append('step/start', { turn: 1, step })
    const code = `const migratedValue = await tools.echo({ value: ${step} }); return migratedValue`
    const result = await runtime.runDurable('migration', code, { echo: ({ value }) => { effects++; return value } })
    const callId = `migration-${step}`
    const name = step === 1 ? 'run_code' : 'edit_run_code'
    const args = JSON.stringify(step === 1 ? { code, description: 'Record a value' }
      : { edits: [{ old_string: 'value: 1', new_string: 'value: 2' }], expected_target_call_seq: targetCallSeq })
    const block = { type: 'tool-call', id: callId, name, arguments: args }
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args },
      { type: 'block-end', index: 0, block },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ].map(chunk => append('assistant/chunk', { turn: 1, step, chunk }))
    append('assistant/message', { turn: 1, step,
      message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [block] }) },
    { sourceEventSeqs: chunks, surfaceOp: 'append' })
    const callSeq = append('tool/call', { turn: 1, step, callId, name, arguments: args })
    if (step === 1) targetCallSeq = callSeq
    append('tool/result', { turn: 1, step,
      message: {
        id: `migration-tool-result-${step}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: result.content, isError: false }],
        source: { kind: 'tool', callId },
      },
      meta: { ...structuredClone(result.meta), ...(step === 1 ? {} : {
        dshPtcPlusEdit: { targetCallSeq }, dshPtcPlusDerivedRun: { code, description: 'Record an edited value' },
      }) } }, { sourceEventSeqs: [callSeq], surfaceOp: 'append' })
    append('step/end', { turn: 1, step })
  }
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { header: { type: 'session', version: 0, id: 'migration', createdAt: 1, delegationDepth: 0 },
    events, effects: () => effects }
}

function renumberingCatalog(transform = value => value) {
  return {
    createRestore(header) {
      const rows = []
      return { decodeRow(row) { rows.push(row) }, finish() {
        const events = rows.filter(row => row.type !== 'assistant/chunk')
        const map = new Map(events.map((row, index) => [row.seq, index]))
        return { header: { ...header, version: 2 }, inheritedEventCount: 0,
          events: transform(events.map((row, seq) => ({ ...structuredClone(row), seq,
            ...(row.sourceEventSeqs === undefined ? {} : {
              sourceEventSeqs: row.sourceEventSeqs.flatMap(source => map.has(source) ? [map.get(source)] : []),
            }),
          }))) }
      } }
    },
    encodeCurrentHeader: header => header,
    encodeCurrentEvent: event => event,
  }
}

async function assertColdMigration(t, catalog) {
  const history = await historicalTranscript(t)
  const source = logText([history.header, ...history.events])
  const result = migrateSessionLogText(source, { catalog })
  assert.equal(result.changed, true)
  const [, ...events] = result.text.trim().split('\n').map(line => JSON.parse(line))
  const before = history.events.filter(event => event.type === 'tool/call')
  const after = events.filter(event => event.type === 'tool/call')
  assert.deepEqual(after.map(event => event.data), before.map(event => event.data))
  assert.notEqual(after[0].seq, before[0].seq)
  assert.equal(events.find(event => event.data.meta?.dshPtcPlusEdit).data.meta.dshPtcPlusEdit.targetCallSeq, after[0].seq)
  assert.deepEqual(pathToHead(recoverJournal({ events })).map(node => node.code),
    pathToHead(recoverJournal({ events: history.events })).map(node => node.code))
  const cold = fixture()
  t.after(() => cold.dispose())
  const restored = await cold.runDurable('migration', 'return migratedValue', {
    echo() { throw new Error('Cold replay redispatched an external effect') },
  }, { session: appendOnlySession('migration', events) })
  assert.equal(restored.value, 2)
  assert.equal(history.effects(), 2)
  assert.equal(migrateSessionLogText(result.text, { catalog }).changed, false)
  assert.equal(logText([history.header, ...history.events]), source)
}

test('format migration preserves edited bindings, original call arguments and recorded effects', async t => {
  await assertColdMigration(t, renumberingCatalog())
})

test('the installed public DSH format catalog preserves standalone historical edited state', async t => {
  let catalog
  try {
    const module = await import('@deepseek-ai/dsh-session-format-catalog')
    catalog = typeof module.createSessionFormatCatalogWithChildren === 'function'
      ? module.createSessionFormatCatalogWithChildren([])
      : module.sessionFormatCatalog
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('The installed Host predates the public Session format catalog')
    return
  }
  await assertColdMigration(t, catalog)
})

test('accepts the released flat tool-result shape through the public catalog', async t => {
  let catalog
  try {
    const module = await import('@deepseek-ai/dsh-session-format-catalog')
    catalog = typeof module.createSessionFormatCatalogWithChildren === 'function'
      ? module.createSessionFormatCatalogWithChildren([])
      : module.sessionFormatCatalog
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('The installed Host predates the public Session format catalog')
    return
  }
  const history = await historicalTranscript(t)
  const events = history.events.map(event => event.type !== 'tool/result' ? event : {
    ...event,
    data: {
      turn: event.data.turn,
      step: event.data.step,
      callId: event.data.message.source.callId,
      content: event.data.message.content[0].content,
      isError: event.data.message.content[0].isError ?? false,
      ...(event.data.meta === undefined ? {} : { meta: structuredClone(event.data.meta) }),
    },
  })
  const migrated = migrateSessionLogText(logText([history.header, ...events]), { catalog })
  assert.equal(migrated.changed, true)
  assert.equal(migrated.sourceVersion, 0)
  assert.equal(migrated.targetVersion > 0, true)
})

test('file migration requires and consumes explicit standalone child facts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-host-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'session.jsonl')
  const rejectedOutput = join(root, 'rejected.jsonl')
  const output = join(root, 'migrated.jsonl')
  const history = await historicalTranscript(t)
  await writeFile(input, logText([history.header, ...history.events]))
  const dshEntry = import.meta.resolve('@deepseek-ai/dsh-session-format-catalog')

  await assert.rejects(
    migrateSessionLogFile(input, rejectedOutput, { dshEntry }),
    /requires explicit child facts or --no-children/,
  )
  await assert.rejects(() => readFile(rejectedOutput, 'utf8'), { code: 'ENOENT' })

  const result = await migrateSessionLogFile(input, output, { dshEntry, childFacts: [] })
  assert.equal(result.written, true)
  assert.equal(result.sourceVersion, 0)
  assert.equal(result.targetVersion > result.sourceVersion, true)
  assert.equal((await readFile(output, 'utf8')).includes('dshPtcPlusEdit'), true)
})

test('format migration preserves confirmed no-ops across every historical journal format', async t => {
  const currentHistory = await historicalTranscript(t)
  const legacyHistory = await historicalTranscript(t, { legacyBindingSettings: true })
  for (const version of JOURNAL_VERSIONS) {
    const history = version < LANGUAGE_SEMANTICS_JOURNAL_VERSION ? legacyHistory : currentHistory
    const events = structuredClone(history.events)
    const calls = events.filter(event => event.type === 'tool/call')
    delete events.find(event => event.type === 'tool/result').data.meta.dshPtcPlus
    const result = events.find(event => event.data.meta?.dshPtcPlusEdit)
    calls[1].data.name = 'run_code'
    calls[1].data.arguments = JSON.stringify(result.data.meta.dshPtcPlusDerivedRun)
    delete result.data.meta.dshPtcPlusEdit
    delete result.data.meta.dshPtcPlusDerivedRun
    const journal = result.data.meta.dshPtcPlus
    journal.version = version
    journal.confirms = [version === 1 ? calls[0].data.callId : calls[0].seq]
    if (version < JOURNAL_VERSION) delete journal.moduleTransform
    if (version < LANGUAGE_SEMANTICS_JOURNAL_VERSION) {
      assert.equal(journal.languageSemantics, 'legacy-v1')
      delete journal.languageSemantics
    } else assert.equal(journal.languageSemantics, 'stateful-v1')
    if (version < PER_NAME_USER_BINDINGS_JOURNAL_VERSION) {
      delete journal.userBindingsShadowPolicy
      delete journal.userBindingNames
    }
    if (version < 7) delete journal.moduleSemantics.importExpressionBoundary
    if (version < 6) delete journal.userBindingsReusePolicy
    if (version < 5) delete journal.userBindingsFingerprint
    if (version < 4) {
      delete journal.bindingPolicy
      delete journal.moduleSemantics
      journal.bindingMode = 'loose'
    }
    if (version === 1) delete journal.rewritePolicy
    assert.equal(recoverJournal({ events }).available, true, `source journal v${version}`)
    const migrated = migrateSessionLogText(logText([history.header, ...events]), { catalog: renumberingCatalog() })
    const [, ...converted] = migrated.text.trim().split('\n').map(line => JSON.parse(line))
    const nextCalls = converted.filter(event => event.type === 'tool/call')
    assert.notEqual(nextCalls[0].seq, calls[0].seq)
    const nextJournal = converted.find(event => event.data.meta?.dshPtcPlus)?.data.meta.dshPtcPlus
    assert.deepEqual(nextJournal.confirms, [version === 1 ? calls[0].data.callId : nextCalls[0].seq])
    const restored = recoverJournal({ events: converted })
    assert.equal(restored.available, true, `converted journal v${version}`)
    assert.equal(pathToHead(restored).length, 1)
  }
})

test('cold replay preserves import boundary effects across journal and session format generations', async t => {
  // Each boundary cell ends with an explicit empty-completion statement so the
  // recorded `hasValue: false` envelope stays true for both lowering
  // generations. Without it, legacy lowering turns the guarded call into its own
  // statement and the resulting value would contradict the record.
  const sources = [
    'import { format as fmt } from "node:util"; const trace = []',
    'if (false) fmt(trace.push("called"))\nvoid 0',
    'try { []\nfmt = (trace.push("rhs"), 1) } catch { trace.push("caught") }\nvoid 0',
  ]
  for (const version of [6, 7]) {
    const events = [{ seq: 0, type: 'assistant/chunk', data: {} }]
    for (const [index, code] of sources.entries()) {
      appendRunCodeEvents(events, `boundary-${index}`, code, { meta: { dshPtcPlus: {
        version,
        bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
        rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
        moduleSemantics: { defaultExportBinding: 'live-readonly',
          ...(version === 7 ? { importExpressionBoundary: 'statement-safe' } : {}),
        },
        userBindingsFingerprint: null,
        userBindingsReusePolicy: 'implementation-v1',
        status: 'durable',
        calls: [], operations: [], confirms: [], diagnostics: [],
        completion: { kind: 'return', hasValue: false },
      } } })
    }
    const source = logText([sessionHeader, ...events])
    const migration = migrateSessionLogText(source, { catalog: renumberingCatalog() })
    const [, ...migratedEvents] = migration.text.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(migration.changed, true)
    const before = events.filter(event => event.type === 'tool/result').map(event => event.data.meta.dshPtcPlus)
    const after = migratedEvents.filter(event => event.type === 'tool/result').map(event => event.data.meta.dshPtcPlus)
    assert.deepEqual(after, before)
    for (const history of [events, migratedEvents]) {
      const state = fixture()
      t.after(() => state.dispose())
      const session = appendOnlySession(`boundary-v${version}`, history)
      const result = await state.runDurable(session.id, 'return trace', {}, { session })
      assert.equal(result.error, undefined)
      assert.deepEqual(result.value, version === 6 ? ['called', 'caught'] : ['rhs', 'caught'])
      assert.equal(result.meta.dshPtcPlus.diagnostics.length, 0)
      assert.equal(result.meta.dshPtcPlus.version, JOURNAL_VERSION)
      assert.equal(result.meta.dshPtcPlus.moduleSemantics.importExpressionBoundary, 'statement-safe')
      await state.dispose()
    }
  }
})

function predecessorBindingsSnapshot(entries) {
  const revision = 1
  const transform = LEGACY_USER_BINDING_TRANSFORM
  const normalized = entries.map(entry => normalizeUserBindingEntry(entry, { transform }))
  return normalizeUserBindingsSnapshot({
    version: 2, transform, revision, entries: normalized,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ revision, entries: normalized.map(entry => entry.fingerprint), transform }))
      .digest('hex'),
  })
}

test('format migration preserves whole-entry and per-name saved values with empty completions', async t => {
  const entries = [{
    id: 'pair', name: 'pair', scope: 'top-level', enabled: true,
    source: 'await tools.observe({}); export const alpha = 1; export const beta = 2',
  }]
  const full = createUserBindingsSnapshot({ entries }, 1)
  const predecessorFull = predecessorBindingsSnapshot(entries)
  const predecessorEmpty = predecessorBindingsSnapshot([])
  for (const version of [6, 7, PER_NAME_USER_BINDINGS_JOURNAL_VERSION, JOURNAL_VERSION]) await t.test(`journal ${version}`, async t => {
    const perName = version >= PER_NAME_USER_BINDINGS_JOURNAL_VERSION
    const currentLanguage = version >= LANGUAGE_SEMANTICS_JOURNAL_VERSION
    const events = [{ seq: 0, type: 'assistant/chunk', data: {} }]
    for (const [index, code] of [
      'const before = beta; void 0',
      'alpha = 9; const inside = beta; void 0',
      'const after = typeof beta; void 0',
    ].entries()) {
      // Whole-entry removal was applied on the next activation, so its third
      // snapshot is empty while the per-name record retains both exports.
      const userBindings = !perName && index === 2 ? predecessorEmpty : currentLanguage ? full : predecessorFull
      const journal = {
        version,
        ...(currentLanguage ? { languageSemantics: 'stateful-v1' } : {}),
        ...(version === JOURNAL_VERSION ? { moduleTransform: USER_BINDING_TRANSFORM } : {}),
        bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
        rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
        moduleSemantics: { defaultExportBinding: 'live-readonly',
          ...(version >= 7 ? { importExpressionBoundary: 'statement-safe' } : {}),
        },
        userBindingsFingerprint: userBindings.fingerprint,
        userBindingsReusePolicy: 'implementation-v1',
        ...(perName ? {
          userBindingsShadowPolicy: 'per-name',
          userBindingNames: [
            index === 0 ? { name: 'alpha', state: 'provider', entryId: 'pair' } : { name: 'alpha', state: 'local' },
            { name: 'beta', state: 'provider', entryId: 'pair' },
          ],
        } : {}),
        status: 'durable',
        calls: index === 0 ? [{ global: 'tools', member: 'observe', args: encodeValue({}),
          ok: true, value: encodeValue('initialized'), settle: 0 }] : [],
        operations: [], confirms: [], diagnostics: [],
        completion: { kind: 'return', hasValue: false },
      }
      appendRunCodeEvents(events, `shadow-${index}`, code, { meta: {
        dshPtcPlus: journal, [USER_BINDINGS_META_KEY]: userBindings,
      } })
    }
    const original = structuredClone(events)
    const migration = migrateSessionLogText(logText([sessionHeader, ...events]), { catalog: renumberingCatalog() })
    const [, ...migrated] = migration.text.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(migration.changed, true)
    assert.deepEqual(events, original)
    assert.deepEqual(migrated.filter(event => event.type === 'tool/result').map(event => event.data.meta),
      events.filter(event => event.type === 'tool/result').map(event => event.data.meta))
    let dispatches = 0
    for (const history of [events, migrated]) {
      const state = fixture()
      t.after(() => state.dispose())
      const session = appendOnlySession(`shadow-migration-${version}`, history)
      const current = await state.runDurable(session.id, 'return [before, inside, after]', {
        observe: async () => { dispatches++; return 'unexpected' },
      }, { session })
      assert.equal(current.isError, false)
      assert.deepEqual(current.value, [2, 2, perName ? 'number' : 'undefined'])
      assert.deepEqual(current.meta.dshPtcPlus.diagnostics, [])
      assert.equal(current.meta.dshPtcPlusRecoveryBoundaries, undefined)
      assert.equal(dispatches, 0)
      await state.dispose()
    }
  })
})

test('format migration rejects confirmations of already journaled calls', async t => {
  const history = await historicalTranscript(t)
  const calls = history.events.filter(event => event.type === 'tool/call')
  history.events.find(event => event.data.meta?.dshPtcPlusEdit).data.meta.dshPtcPlus.confirms = [calls[0].seq]
  assert.throws(() => migrateSessionLogText(logText([history.header, ...history.events]), {
    catalog: renumberingCatalog(),
  }), /unproved PTC confirmation/)
})

test('format migration remaps confirmations and recovery frontiers and rejects unproved references', async t => {
  const history = await historicalTranscript(t)
  const calls = history.events.filter(event => event.type === 'tool/call')
  const result = history.events.find(event => event.data.meta?.dshPtcPlusEdit)
  result.data.meta.dshPtcPlusRecoveryBoundaries = [{ failedCallSeq: calls[1].seq, frontierCallSeq: calls[0].seq }]
  // An unjournaled rejected call can be confirmed by a later cell.
  delete history.events.find(event => event.type === 'tool/result').data.meta.dshPtcPlus
  calls[1].data.arguments = JSON.stringify(result.data.meta.dshPtcPlusDerivedRun)
  delete result.data.meta.dshPtcPlusEdit
  delete result.data.meta.dshPtcPlusDerivedRun
  calls[1].data.name = 'run_code'
  result.data.meta.dshPtcPlus.confirms = [calls[0].seq]
  const migrate = () => migrateSessionLogText(logText([history.header, ...history.events]), { catalog: renumberingCatalog() })
  const converted = migrate().text.trim().split('\n').map(line => JSON.parse(line))
  const nextCalls = converted.filter(event => event.type === 'tool/call')
  const meta = converted.find(event => event.data?.meta?.dshPtcPlusRecoveryBoundaries).data.meta
  assert.deepEqual(meta.dshPtcPlus.confirms, [nextCalls[0].seq])
  assert.deepEqual(meta.dshPtcPlusRecoveryBoundaries, [{ failedCallSeq: nextCalls[1].seq, frontierCallSeq: nextCalls[0].seq }])
  result.data.meta.dshPtcPlusRecoveryBoundaries[0].frontierCallSeq = 999
  assert.throws(migrate, /unproved PTC call reference/)
})

test('format migration refuses changed tool identities, invalid journals and mixed retired events', async t => {
  const history = await historicalTranscript(t)
  const source = logText([history.header, ...history.events])
  assert.throws(() => migrateSessionLogText(source, { catalog: renumberingCatalog(events => {
    events.find(event => event.type === 'tool/call').data.arguments = '{}'
    return events
  }) }), /tool record identities/)
  assert.throws(() => migrateSessionLogText(source, { catalog: renumberingCatalog(events =>
    events.filter(event => event.type !== 'tool/result')) }), /number of tool records/)
  assert.throws(() => migrateSessionLogText(source, { catalog: renumberingCatalog(events => {
    const message = events.find(event => event.type === 'tool/result').data.message
    message.content[0].content = [{ type: 'text', text: 'changed recorded result' }]
    return events
  }) }), /tool record identities/)
  assert.throws(() => migrateSessionLogText(source, { catalog: renumberingCatalog(events => {
    events.find(event => event.type === 'tool/result').data.meta.dshPtcPlus.status = 'volatile'
    return events
  }) }), /tool record identities/)
  history.events.find(event => event.data.meta?.dshPtcPlusEdit).data.meta.dshPtcPlusEdit.targetCallSeq = 999
  assert.throws(() => migrateSessionLogText(logText([history.header, ...history.events]), { catalog: renumberingCatalog() }), /unproved PTC history/)
  assert.throws(() => migrateSessionLogText(logText([history.header, legacyEvent]), { catalog: renumberingCatalog() }), /retired recovery-boundary/)
})

test('format migration preserves opaque metadata from unrelated tools', () => {
  for (const meta of [null, false, 'foreign metadata', [], { foreign: { seq: 99 } }]) {
    const source = logText([sessionHeader,
      { seq: 0, time: 1, type: 'tool/call', data: { name: 'foreign', callId: 'foreign' } },
      { seq: 1, time: 2, type: 'tool/result', data: { meta } },
    ])
    const migrated = migrateSessionLogText(source, { catalog: renumberingCatalog() })
    assert.deepEqual(JSON.parse(migrated.text.trim().split('\n').at(-1)).data.meta, meta)
  }
})

test('even forced migration cannot replace a hard-linked source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-migration-alias-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'input.jsonl')
  const output = join(root, 'output.jsonl')
  const history = await historicalTranscript(t)
  const source = logText([history.header, ...history.events])
  await writeFile(input, source)
  await link(input, output)
  await assert.rejects(migrateSessionLogFile(input, output, { catalog: renumberingCatalog(), overwrite: true }), /alias input/)
  assert.equal(await readFile(input, 'utf8'), source)
})
