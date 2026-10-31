import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { assertReleasedV4Relationships, RELEASED_V3_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { bindingAdoptionMessage, bindingAdoptionOf, BINDING_ADOPTION_SCHEMA } from '../internal/binding-adoption.js'
import { capabilitySelectionMessage, capabilitySelectionOf, CAPABILITY_SELECTION_SCHEMA, readCapabilitySelection } from '../internal/capability-selection.js'
import { RETIRED_SURFACE_RECORD } from '../internal/message-sources.js'
import { decodeArtifact, repairLogText, repairRecords } from '../scripts/repair-session-log.mjs'

const header = { type: 'session', version: 4, id: 'session-repair-fixture', createdAt: 1,
  cwd: 'G:\\TSWorkSpace\\dsh-ptc-plus', isSeeded: false, delegationDepth: 0 }
const selection = capabilitySelectionMessage({ schema: CAPABILITY_SELECTION_SCHEMA,
  choices: { 'tools.probe': { availability: 'closed' } } })

const jsonl = records => `${records.map(record => JSON.stringify(record)).join('\n')}\n`
const format = { assertReleasedV4Relationships, RELEASED_V3_EVENT_TYPES }

// The shape a 0.5.4 session wrote when it decided before its first step: a surface node,
// then the head the host publishes at the first accepted step.
const brokenRecords = () => [
  { ...header },
  { type: 'user/message', seq: 0, time: 1, data: { ...selection }, surfaceOp: 'append' },
  { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
  { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
  { type: 'system/message', seq: 3, time: 4, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createSystemMessage({ content: [{ type: 'text', text: 'head' }] }) } },
  { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: 'complete' } },
]

test('a statement written ahead of the protected head becomes an ignorable record and keeps its payload', () => {
  const records = brokenRecords()
  const { records: repaired, repaired: changed } = repairRecords(records)
  assert.deepEqual(changed, [{ seq: 0, type: 'user/message' }])
  assert.equal(repaired.length, records.length, 'the repair never moves a sequence number')
  const [statement] = repaired.slice(1)
  assert.equal(statement.type, RETIRED_SURFACE_RECORD)
  assert.equal(statement.ignorable, true)
  assert.equal(statement.surfaceOp, undefined, 'a record claims no surface range')
  assert.equal(statement.sourceEventSeqs, undefined)
  // The choice itself is still readable: the carrier changed, the statement did not.
  assert.deepEqual(readCapabilitySelection(selection).choices, { 'tools.probe': { availability: 'closed' } })
  assert.deepEqual(JSON.parse(JSON.stringify(repaired.slice(2))), JSON.parse(JSON.stringify(records.slice(2))),
    'every event behind the head is untouched')
})

test('the repaired log is the one the released format accepts', () => {
  const records = brokenRecords()
  // The unrepaired log is exactly what a reader refuses: its head has no protected
  // first surface node because a statement already occupies the surface.
  assert.throws(() => assertReleasedV4Relationships({
    header: { ...records[0], type: undefined },
    events: records.slice(1).map(record => ({ ...record })),
    inheritedEventCount: 0,
  }, RELEASED_V3_EVENT_TYPES), /protected first surface head/u)
  const { changed, text } = repairLogText(jsonl(records), { format })
  assert.equal(changed.length, 1)
  const repaired = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const [repairedHeader, ...events] = repaired
  const { type: _type, ...headerFields } = repairedHeader
  // The proof the repair offers: the log now passes the check every reader runs before it
  // interprets a session.
  assertReleasedV4Relationships({ header: headerFields, events: events.map(event => ({ ...event })), inheritedEventCount: 0 },
    RELEASED_V3_EVENT_TYPES)
})

test('a log that already satisfies the format is returned unchanged, so a second run writes nothing', () => {
  const records = brokenRecords().slice(0, 1).concat([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: createSystemMessage({ content: [{ type: 'text', text: 'head' }] }) } },
    { type: 'user/message', seq: 3, time: 4, data: { ...selection }, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: 'complete' } },
  ])
  const written = jsonl(records)
  const first = repairLogText(written, { format })
  assert.deepEqual(first.changed, [])
  assert.equal(first.text, written)
  assert.deepEqual(repairLogText(first.text, { format }).changed, [])
})

test('a session that never published a head is repaired in full, because its next head would be unreadable', () => {
  const records = [{ ...header },
    { type: 'user/message', seq: 0, time: 1, data: { ...selection }, surfaceOp: 'append' },
    { type: 'command/run', seq: 1, time: 2, data: { commandId: 'c1', name: 'capabilities', source: { kind: 'user' } } }]
  // With no head yet the statement is the only surface node the session has, and the
  // first head the Host writes would leave it without a protected head. The repair has to
  // cover that log, which is the most common shape of this damage.
  const { records: repaired, repaired: changed } = repairRecords(records)
  assert.deepEqual(changed, [{ seq: 0, type: 'user/message' }])
  assert.equal(repaired[1].type, RETIRED_SURFACE_RECORD)
  assert.equal(repaired[2].type, 'command/run', 'an event that never claimed the surface is untouched')
})

test('a repaired statement still answers as this session\'s own decision', () => {
  // The log holds no delivered plan, so the retired record is the only statement left: a
  // reader that ignored it would recompose the session and withdraw the choice.
  const { records: repaired } = repairRecords(brokenRecords())
  const statement = capabilitySelectionOf(repaired.slice(1), header.id)
  assert.equal(statement.state, 'decided')
  assert.deepEqual(statement.selection.choices, { 'tools.probe': { availability: 'closed' } })
})

const adoption = bindingAdoptionMessage({ schema: BINDING_ADOPTION_SCHEMA, declined: ['beta'] })
// The other statement 0.5.4 wrote through the same surface carrier: a session that declined a
// global binding before its first step.
const adoptionRecords = () => [
  { ...header },
  { type: 'user/message', seq: 0, time: 1, data: { ...adoption }, surfaceOp: 'append' },
  { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
  { type: 'system/message', seq: 2, time: 3, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createSystemMessage({ content: [{ type: 'text', text: 'head' }] }) } },
]

test('a repaired adoption statement still answers as this session\'s own adoption', () => {
  // The adoption owner reads records and messages; a repaired statement of its own form is the
  // same decision, so the entry the session declined stays declined after the repair.
  const { records: repaired } = repairRecords(adoptionRecords())
  assert.equal(repaired[1].type, RETIRED_SURFACE_RECORD)
  const statement = bindingAdoptionOf(repaired.slice(1))
  assert.equal(statement.state, 'decided')
  assert.deepEqual(statement.adoption.declined, ['beta'])
})

test('a repaired adoption statement is not read as this session\'s capability selection', () => {
  // The repair retires every owner's surface node, so the carrier says nothing about the owner:
  // a capability reader that took it would answer `unreadable` for a decision this session
  // never made, and would then outvote the selection the session did record.
  const { records: repaired } = repairRecords(adoptionRecords())
  assert.equal(capabilitySelectionOf(repaired.slice(1), header.id).state, 'none')
})

test('a log that retired one statement of each owner keeps both decisions', () => {
  // The shape a session produces when it decided twice before its first step: one statement of
  // each owner, both ahead of the head.
  const mixed = [
    { ...header },
    { type: 'user/message', seq: 0, time: 1, data: { ...selection }, surfaceOp: 'append' },
    { type: 'user/message', seq: 1, time: 2, data: { ...adoption }, surfaceOp: 'append' },
    { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
    { type: 'system/message', seq: 3, time: 4, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: createSystemMessage({ content: [{ type: 'text', text: 'head' }] }) } },
  ]
  const { records: repaired, repaired: changed } = repairRecords(mixed)
  assert.deepEqual(changed.map(entry => entry.seq), [0, 1])
  // The newest statement of each owner is the one that answers, and each answers only its own.
  assert.deepEqual(capabilitySelectionOf(repaired.slice(1), header.id).selection.choices,
    { 'tools.probe': { availability: 'closed' } })
  assert.deepEqual(bindingAdoptionOf(repaired.slice(1)).adoption.declined, ['beta'])
})

test('a retired statement of this owner that cannot be read still supersedes older ones', () => {
  // The newest statement is the current one even when this build cannot parse it; a repair does
  // not make an unreadable adoption readable, and no earlier adoption answers in its place.
  const unreadable = { ...adoption,
    content: [{ type: 'text', text: `PTC Plus session binding adoption. This session uses every entry the global catalog supplies except the declined ones. Adoption can only withdraw an entry from this session: it cannot supply, enable or revive one, and the global configuration decides which entries exist at all. Declined entry IDs:\n{"not":"a list"}` }] }
  const records = [
    { ...header },
    { type: 'user/message', seq: 0, time: 1, data: { ...adoption }, surfaceOp: 'append' },
    { type: 'user/message', seq: 1, time: 2, data: unreadable, surfaceOp: 'append' },
    { type: 'system/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: createSystemMessage({ content: [{ type: 'text', text: 'head' }] }) } },
  ]
  const { records: repaired } = repairRecords(records)
  assert.equal(bindingAdoptionOf(repaired.slice(1)).state, 'unreadable')
})

test('the decoder reads a concatenated-frame artifact and the encoder writes one a reader can fold', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-repair-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { text } = repairLogText(jsonl(brokenRecords()), { format })
  const file = join(directory, 'session.v4.jsonl.zstd')
  // The backend appends one frame per batch; the repair writes the same container.
  await writeFile(file, Buffer.concat([
    (await import('node:zlib')).zstdCompressSync(Buffer.from(text.slice(0, text.indexOf('\n') + 1))),
    (await import('node:zlib')).zstdCompressSync(Buffer.from(text.slice(text.indexOf('\n') + 1))),
  ]))
  const { readFile } = await import('node:fs/promises')
  const decoded = decodeArtifact(await readFile(file))
  assert.equal(decoded, text)
  assert.deepEqual(JSON.parse(decoded.split('\n')[1]).type, RETIRED_SURFACE_RECORD)
  assert.equal(JSON.parse(decoded.split('\n')[0]).id, header.id)
})


