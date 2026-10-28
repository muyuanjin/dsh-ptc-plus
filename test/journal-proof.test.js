import assert from 'node:assert/strict'
import test from 'node:test'

import { renderDiagnostic } from '../internal/diagnostic.js'
import {
  JOURNAL_KEY,
  SETTLEMENT_PROOF_KEY,
  SETTLEMENT_PROOF_VERSION,
  createJournal,
  settlementProofDigest,
  withSettlementProof,
} from '../internal/session-journal.js'
import { recoverJournal } from '../internal/session-journal-recovery.js'
import { POST_EDIT_KEY } from '../internal/session-journal-schema.js'
import {
  appendOnlySession,
  appendRunCodeEvents,
  fixture,
  orderedSurfaceSession,
  ptcAgent,
  runNestedEditCell,
} from './plugin-fixture.js'

const SOURCE = 'const provedValue = 1; throw new Error("proof failure")'

function failingJournal() {
  return {
    ...createJournal([], { variableRedeclarations: false, functionClassRedeclarations: false },
      { autoRewriteImports: false, autoStripExports: false, autoSplitRedeclarations: false }),
    status: 'durable',
    diagnostics: [{
      code: 'PTC-X001',
      severity: 'error',
      phase: 'execute',
      message: 'uncaught Error: proof failure',
      stateEffect: 'partially-applied',
      help: ['current help'],
    }],
    completion: { kind: 'throw', error: { kind: 'Error', message: 'uncaught Error: proof failure' } },
  }
}

/**
 * The settlement proof states the facts recovery reads as evidence: the status,
 * the completion and the wording of each diagnostic. Presentation is not one of
 * them, because a historical record may be read through a later generation's
 * help wording.
 */
test('the settlement proof states the status, the completion and the diagnostic wording', () => {
  const journal = failingJournal()
  const recorded = withSettlementProof({}, journal)
  assert.deepEqual(Object.keys(recorded), [SETTLEMENT_PROOF_KEY])
  assert.deepEqual(Object.keys(recorded[SETTLEMENT_PROOF_KEY]), ['version', 'recordedMessage'])
  assert.equal(recorded[SETTLEMENT_PROOF_KEY].version, SETTLEMENT_PROOF_VERSION)
  assert.equal(recorded[SETTLEMENT_PROOF_KEY].recordedMessage, settlementProofDigest(journal))

  const digest = settlementProofDigest(journal)
  const stated = [
    ['status', { ...journal, status: 'discarded' }],
    ['completion kind', { ...journal, completion: { kind: 'return', hasValue: false } }],
    ['completion error kind', { ...journal,
      completion: { kind: 'throw', error: { kind: 'TypeError', message: 'uncaught Error: proof failure' } } }],
    ['completion error message', { ...journal,
      completion: { kind: 'throw', error: { kind: 'Error', message: 'uncaught Error: edited' } } }],
    ['diagnostic wording', { ...journal, diagnostics: [{ ...journal.diagnostics[0], message: 'edited' }] }],
  ]
  for (const [label, edited] of stated) {
    assert.notEqual(settlementProofDigest(edited), digest, label)
  }
  const presented = {
    ...journal,
    diagnostics: [{ ...journal.diagnostics[0], help: ['legacy help'],
      source: { cell: 'cell', start: { line: 1, column: 1 } } }],
  }
  assert.equal(settlementProofDigest(presented), digest)
})

/**
 * One published failing cell, edited four ways.
 *
 * A record edited after publication is not evidence for the bindings its cell
 * declared. The reconciliation that 0.5.2 could not see is the second variant:
 * the completion is re-rendered from the edited diagnostic, so the record stays
 * self-consistent and only the published proof disagrees. The Host's `isError` is
 * a copy of the outcome this plugin cannot recompute, so a rewrite that also
 * repairs the proof still has to agree with it.
 */
test('an edited settlement is not evidence for the bindings its cell declared', async t => {
  const published = fixture()
  const session = orderedSurfaceSession('journal-proof')
  const result = await published.runDurable(session.id, SOURCE, {}, {
    session: session.id,
    recordSession: false,
  })
  await published.dispose()
  assert.equal(result.meta[JOURNAL_KEY].status, 'durable')

  const variants = [
    ['published', meta => meta, undefined],
    ['edited completion', meta => {
      meta[JOURNAL_KEY].completion.error.message += '\nedited completion'
      return meta
    }, /does not match its diagnostic/u],
    ['edited diagnostic', meta => {
      meta[JOURNAL_KEY].diagnostics[0].message = 'uncaught Error: edited failure'
      meta[JOURNAL_KEY].completion.error.message = renderDiagnostic(
        meta[JOURNAL_KEY].diagnostics[0], SOURCE)
      return meta
    }, /recorded settlement proof/u],
    // A rewrite that repairs the proof from its own edited journal is
    // indistinguishable from a publication except for the Host's copy of the
    // outcome, which still says the cell failed.
    ['repaired proof', meta => {
      meta[JOURNAL_KEY].completion = { kind: 'return', hasValue: false }
      meta[JOURNAL_KEY].diagnostics = []
      return Object.assign(meta, withSettlementProof({}, meta[JOURNAL_KEY]))
    }, /does not agree with the tool result/u],
    // A settlement published before this proof keeps the older evidence.
    ['pre-0.5.3 record', meta => {
      delete meta[SETTLEMENT_PROOF_KEY]
      return meta
    }, undefined],
    // The proof is a closed record: a field this generation never wrote, or a
    // version whose semantics it does not know, describes a proof it cannot read,
    // so it is refused instead of being read as one it understands.
    ['malformed proof', meta => {
      meta[SETTLEMENT_PROOF_KEY] = { ...meta[SETTLEMENT_PROOF_KEY], extra: true }
      return meta
    }, /invalid recorded settlement proof/u],
    ['unknown proof version', meta => {
      meta[SETTLEMENT_PROOF_KEY] = {
        ...meta[SETTLEMENT_PROOF_KEY],
        version: SETTLEMENT_PROOF_VERSION + 1,
      }
      return meta
    }, /invalid recorded settlement proof/u],
  ]
  for (const [label, edit, reason] of variants) {
    const events = []
    const meta = edit(structuredClone(result.meta))
    const appended = appendRunCodeEvents(events, `proof-${label}`, SOURCE, { meta })
    // The Host states the outcome of the tool result it recorded, on the result
    // message it appends. Every variant keeps that copy untouched, as an editor of
    // the plugin metadata would.
    events[appended.resultSeq].data.message.isError = true
    const history = recoverJournal({ events }, undefined, {})
    const reasons = history.volatileSuffix.map(item => item.reason).join('\n')
    if (reason === undefined) {
      assert.equal(reasons, '', label)
      assert.equal(history.available, true, label)
      continue
    }
    assert.equal(history.available, false, label)
    assert.match(reasons, reason, label)
  }
})

test('an edited revision record is not evidence even when both of its copies agree', async t => {
  const published = fixture()
  const session = appendOnlySession('journal-proof-derived')
  session.append('turn/start', { turn: 0 })
  t.after(() => published.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await published.assemble(
    { sections: [], contexts: [], variables: {}, tools: [published.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const setup = await published.runDurable(session.id, 'let provedValue = 1; return provedValue', {},
    { session, callId: 'proof-setup' })
  assert.equal(setup.value, 1, JSON.stringify(setup.error))
  const root = await runNestedEditCell(published, { session, agent, signal, callId: 'proof-root',
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })' })
  assert.equal(root.receipt.accepted, true, JSON.stringify(root.receipt))

  // The published log is the control: the same fixture folds as the revision it is.
  assert.equal(recoverJournal({ events: session.events }, undefined,
    { editRewritesHistory: true }).available, true)

  // A revision's journal is recorded twice — in its own derived settlement and in
  // the provenance the root result republishes — and the fold compares the two, so
  // an edit that changes both stays self-consistent. The settlement proof is the
  // third copy: it is taken at publication over the facts recovery reads, so a
  // record that now claims a status it never settled no longer reproduces it.
  const events = structuredClone(session.events)
  const derived = events.filter(event => event.type === 'tool/ptc-dispatch'
    && event.data?.name === 'run_code')
  assert.equal(derived.length, 1)
  const provenance = events.find(event => event.type === 'tool/result'
    && event.data.meta?.[POST_EDIT_KEY] !== undefined).data.meta[POST_EDIT_KEY]
  const claimVolatile = journal => Object.assign(journal, {
    status: 'volatile',
    volatileReason: 'an edited record claims this settlement was volatile',
    values: [{ name: 'injected', wire: { codec: 'ptc-value-graph/v1', root: 7, nodes: [] } }],
  })
  claimVolatile(derived[0].data.meta[JOURNAL_KEY])
  claimVolatile(provenance.meta[JOURNAL_KEY])

  const history = recoverJournal({ events }, undefined, { editRewritesHistory: true })
  assert.equal(history.available, false)
  assert.match(history.volatileSuffix.map(item => item.reason).join('\n'),
    /journal facts do not match their recorded settlement proof/u)
  // The claim is a binding no cell declared: recovery must not install it.
  assert.equal(history.nodes.some(node => (node.journal.values ?? [])
    .some(value => value.name === 'injected')), false)
})

test('an edited settlement loses the binding the model could still reach', async t => {
  const published = fixture()
  const session = orderedSurfaceSession('journal-proof-visible')
  const result = await published.runDurable(session.id, SOURCE, {}, {
    session: session.id,
    recordSession: false,
  })
  await published.dispose()
  const edited = structuredClone(result.meta)
  edited[JOURNAL_KEY].diagnostics[0].message = 'uncaught Error: edited failure'
  edited[JOURNAL_KEY].completion.error.message = renderDiagnostic(
    edited[JOURNAL_KEY].diagnostics[0], SOURCE)
  const appended = appendRunCodeEvents(session.events, 'edited-failure', SOURCE, { meta: edited })
  session.events[appended.resultSeq].data.message.isError = true

  const reader = fixture()
  t.after(() => reader.dispose())
  const recovered = await reader.run(session.id, 'return typeof provedValue', {}, { session })
  assert.equal(recovered.value, 'undefined', JSON.stringify(recovered.meta?.[JOURNAL_KEY]?.diagnostics))
})
