import assert from 'node:assert/strict'
import test from 'node:test'
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { pathToHead, recoverJournal } from '../internal/session-journal.js'
import { fixture } from './plugin-fixture.js'
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

test('migrates decoded JSONL and reports a no-op for current logs', () => {
  const source = logText([
    sessionHeader,
    { seq: 0, type: 'tool/call', data: { name: 'run_code', callId: 'failed' } },
    legacyEvent,
    { seq: 2, type: 'tool/result', sourceEventSeqs: [0], data: { meta: {} } },
  ])
  const migrated = migrateSessionLogText(source)
  assert.equal(migrated.changed, true)
  assert.equal(migrated.legacyCount, 1)
  assert.equal(migrated.text.includes('ptc-plus/recovery-boundary'), false)
  assert.deepEqual(JSON.parse(migrated.text.split('\n')[0]), sessionHeader)
  assert.equal(JSON.parse(migrated.text.split('\n')[2]).seq, 1)
  assert.deepEqual(JSON.parse(migrated.text.split('\n')[2]).data.meta.dshPtcPlusRecoveryBoundaries, [{
    failedCallSeq: 0,
    frontierCallSeq: null,
  }])

  const current = migrateSessionLogText(migrated.text)
  assert.deepEqual(current, { changed: false, legacyCount: 0, text: migrated.text })
})

test('migrates a file without replacing the source or an existing destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'session.jsonl')
  const output = join(root, 'migrated.jsonl')
  const source = logText([
    sessionHeader,
    { ...legacyEvent, seq: 0 },
    { seq: 1, type: 'tool/result', data: {} },
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

test('encodes the session header and events as independent Zstandard frames', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-log-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'session.jsonl')
  const output = join(root, 'migrated.jsonl.zstd')
  const source = logText([
    { type: 'session', version: 0, id: 'framed', createdAt: 1, cwd: root },
    legacyEvent,
    { seq: 1, type: 'tool/result', data: {} },
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
async function historicalTranscript(t) {
  const runtime = fixture()
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
      message: createToolResultMessage({ callId, content: result.content, isError: false }),
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
  }, { session: { id: 'migration', events } })
  assert.equal(restored.value, 2)
  assert.equal(history.effects(), 2)
  assert.equal(migrateSessionLogText(result.text, { catalog }).changed, false)
  assert.equal(logText([history.header, ...history.events]), source)
}

test('format migration preserves edited bindings, original call arguments and recorded effects', async t => {
  await assertColdMigration(t, renumberingCatalog())
})

test('the installed public DSH format catalog preserves historical edited state', async t => {
  let catalog
  try { catalog = (await import('@deepseek-ai/dsh-session-format-catalog')).sessionFormatCatalog } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('The installed Host predates the public Session format catalog')
    return
  }
  await assertColdMigration(t, catalog)
})

test('format migration preserves confirmed no-ops across every historical journal format', async t => {
  const history = await historicalTranscript(t)
  for (const version of [1, 2, 3, 4, 5, 6]) {
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
