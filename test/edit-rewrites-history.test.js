import assert from 'node:assert/strict'
import test from 'node:test'

import { readSessionLog } from '../internal/session-events.js'
import {
  pathToHead, recoverJournal, visibleExecutableCallSeqs,
} from '../internal/session-journal-recovery.js'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { POST_EDIT_KEY } from '../internal/session-journal-schema.js'
import { appendOnlySession, fixture, ptcAgent, runNestedEditCell } from './plugin-fixture.js'

/**
 * A session whose second cell edits the first one.
 *
 * The first cell declares `rewriteValue`; the accepted edit revises its source so
 * the revision supplies the same name with a new value. That is the smallest log
 * in which appending and rewriting disagree: both cells stay recorded either way,
 * and only the fold decides which of them builds the environment.
 *
 * `code` and `edits` select what the target declares and how the revision changes
 * it, so a case can make one of them settle volatile while keeping the relation.
 */
async function editedSession(t, {
  code = 'let rewriteValue = 1; return rewriteValue',
  edits = [{ old_string: '= 1', new_string: '= 2' }],
  expected = 1,
} = {}) {
  const session = appendOnlySession('edit-rewrites-history')
  session.append('turn/start', { turn: 0 })
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  const setup = await state.runDurable(session.id, code, {}, { session, callId: 'rewrite-setup' })
  assert.equal(setup.value, expected, JSON.stringify(setup.error))
  const targetCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data.callId === 'rewrite-setup').seq
  const root = await runNestedEditCell(state, { session, agent, signal, callId: 'rewrite-root',
    code: `return await tools.edit_run_code(${JSON.stringify({ edits })})` })
  assert.equal(root.receipt.accepted, true, JSON.stringify(root.receipt))
  assert.equal(root.receipt.target_call_seq, targetCallSeq)
  const rootCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data.callId === 'rewrite-root').seq
  const observation = await readSessionLog(session, state.ctx.sessionQuery)
  return { session, state, agent, signal, observation, targetCallSeq, rootCallSeq }
}

test('the default fold keeps the edited cell and its revision on the path', async t => {
  const { observation, targetCallSeq } = await editedSession(t)
  const appended = recoverJournal(observation, undefined,
    { visibleCallSeqs: visibleExecutableCallSeqs(observation) })
  assert.equal(appended.available, true, JSON.stringify(appended))
  // Appending is the 0.5.2 semantics: the edited cell keeps building the
  // environment and the revision is one more cell after it.
  assert.equal(pathToHead(appended).some(node => node.callSeq === targetCallSeq), true)
  assert.equal(pathToHead(appended).length, 3)
  assert.deepEqual([...appended.supersessions], [])
  assert.deepEqual([...appended.supersededBindings], [])
})

test('editRewritesHistory replaces the edited cell with its revision and records the relation', async t => {
  const { observation, targetCallSeq, rootCallSeq } = await editedSession(t)
  const rewritten = recoverJournal(observation, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(observation),
    editRewritesHistory: true,
  })
  assert.equal(rewritten.available, true, JSON.stringify(rewritten))
  const path = pathToHead(rewritten)
  // The revision takes the edited cell's place in the recorded order: the target
  // keeps its place in the record and leaves the path, and the cells that followed
  // it continue from the revision, so they replay the environment the accepted edit
  // claims instead of the one it replaced.
  assert.equal(path.some(node => node.callSeq === targetCallSeq), false)
  assert.equal(path.length, 2)
  assert.equal(rewritten.nodes.some(node => node.callSeq === targetCallSeq), true)
  assert.match(path[0].code, /= 2/u)
  assert.equal(path[0].parent, undefined)
  assert.equal(path[1].callSeq, rootCallSeq)
  assert.deepEqual([...rewritten.supersessions], [{
    supersededCallSeq: targetCallSeq,
    supersedingCallSeq: path[0].callSeq,
  }])
})

test('a cell recorded after the edited cell replays the revised value', async t => {
  // The cell that performs the edit also reads the binding it edits. The accepted
  // edit claims the revision replaces that cell from the start, so this cell has to
  // replay after the revision: replaying it first reads a binding the rewrite
  // already removed, recovery then contracts, and the reinstated target hands the
  // model the value it replaced.
  const { session, state, observation, targetCallSeq } = await editedSession(t, {
    code: 'let dep = 1; return dep',
  })
  const rewritten = recoverJournal(observation, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(observation),
    editRewritesHistory: true,
  })
  assert.equal(rewritten.available, true, JSON.stringify(rewritten.volatileSuffix))

  session.append('turn/end', {})
  session.append('turn/start', {})
  await state.dispose()
  const restored = fixture({ editRewritesHistory: true })
  t.after(() => restored.dispose())
  const cold = await restored.runDurable(session.id, 'return dep', {
    edit_run_code() { assert.fail('cold recovery redispatched the editor') },
  }, { session, callId: 'dependent-cold' })
  assert.equal(cold.value, 2, JSON.stringify(cold.error))
  const notices = (cold.logs ?? []).concat((cold.meta?.[JOURNAL_KEY]?.diagnostics ?? []).map(item => item.message))
  // Nothing was contracted: the plugin reproduces the environment the edit claims.
  assert.equal(notices.some(text => /unreconstructable|PTC-R002/u.test(text)), false, JSON.stringify(notices))
  const superseded = notices.find(text => /recorded revision replaced/u.test(text))
  assert.equal(typeof superseded, 'string', JSON.stringify(notices))
  assert.match(superseded, new RegExp(`cell ${targetCallSeq} by cell \\d+`, 'u'))
})

test('a rewritten cell serves the revision value to later cells and after recovery', async t => {
  const { session, state, targetCallSeq } = await editedSession(t)
  const later = await state.runDurable(session.id, 'return rewriteValue', {},
    { session, callId: 'rewrite-later' })
  assert.equal(later.value, 2, JSON.stringify(later))

  // A fresh runtime folds the same log with the switch on and states the relation
  // once: the model must not read the replaced cell as a lost binding.
  session.append('turn/end', {})
  session.append('turn/start', {})
  await state.dispose()
  const restored = fixture({ editRewritesHistory: true })
  t.after(() => restored.dispose())
  const cold = await restored.runDurable(session.id, 'return rewriteValue', {
    edit_run_code() { assert.fail('cold recovery redispatched the editor') },
  }, { session, callId: 'rewrite-cold' })
  assert.equal(cold.value, 2, JSON.stringify(cold))
  const notices = (cold.logs ?? []).concat((cold.meta?.[JOURNAL_KEY]?.diagnostics ?? []).map(item => item.message))
  const superseded = notices.find(text => /recorded revision replaced/u.test(text))
  assert.equal(typeof superseded, 'string', JSON.stringify(notices))
  assert.match(superseded, new RegExp(`cell ${targetCallSeq} by cell \\d+`, 'u'))
  assert.doesNotMatch(superseded, /unreconstructable|no recorded value proves/u)
})

/**
 * The edited cell read the clock, so it has no replay: the fold installs the values
 * it recorded. Its revision read the clock too, so both settlements are volatile
 * and neither can be replayed.
 */
const VOLATILE_EDIT = {
  code: 'const stamp = Date.now(); const kept = 5; return kept',
  edits: [{ old_string: 'const kept = 5; return kept', new_string: 'return stamp' }],
  expected: 5,
}

test('a revision that settled volatile still supersedes the cell it edited', async t => {
  const { observation, targetCallSeq } = await editedSession(t, VOLATILE_EDIT)
  const rewritten = recoverJournal(observation, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(observation),
    editRewritesHistory: true,
  })
  assert.equal(rewritten.available, true, JSON.stringify(rewritten.volatileSuffix))
  const path = pathToHead(rewritten)
  // A volatile settlement is installed from its recorded values instead of being
  // replayed, but that is how the cell arrives, not whether it is the cell: an
  // accepted revision still replaces its target, so the target leaves the path even
  // though its recorded values are all the evidence the log has for its names.
  assert.equal(path.some(node => node.callSeq === targetCallSeq), false)
  assert.equal(rewritten.nodes.some(node => node.callSeq === targetCallSeq), true)
  assert.deepEqual([...rewritten.supersessions], [{
    supersededCallSeq: targetCallSeq,
    supersedingCallSeq: path.at(-1).callSeq,
  }])
  // The revision cannot be replayed either, so it is the restored node on the path.
  assert.equal(path.at(-1).restoredFromRecord, true)
  // `kept` is the name the revision no longer declares and the target's recorded
  // value is the only proof of it, so the relation can name what it withdrew.
  assert.deepEqual([...rewritten.supersededBindings], ['kept'])
})

test('a contracted revision still withdraws the names of the cell it replaced', async t => {
  // The revision declares nothing, so its volatile settlement records no value and the
  // fold contracts it. The relation is still the log's fact: the target must leave the
  // path even though the settlement that replaced it is not in the environment, and the
  // names the target recorded are withdrawn rather than lost.
  const { observation, targetCallSeq } = await editedSession(t, {
    code: 'const kept = 5; const stamp = Date.now(); return kept',
    edits: [{ old_string: 'const kept = 5; const stamp = Date.now(); return kept', new_string: 'Date.now()' }],
    expected: 5,
  })
  const rewritten = recoverJournal(observation, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(observation),
    editRewritesHistory: true,
  })
  assert.equal(rewritten.available, true, JSON.stringify(rewritten.volatileSuffix))
  // The target was the head, so the path ends at the target's parent: nothing is left
  // to build the environment with.
  assert.deepEqual(pathToHead(rewritten).map(node => node.callSeq), [])
  assert.equal(rewritten.supersessions.length, 1)
  assert.equal(rewritten.supersessions[0].supersededCallSeq, targetCallSeq)
  assert.deepEqual([...rewritten.supersededBindings].sort(), ['kept', 'stamp'])
})

test('a recovery reports the relation beside the cell it restored', async t => {
  const { session, state, targetCallSeq } = await editedSession(t, VOLATILE_EDIT)
  session.append('turn/end', {})
  session.append('turn/start', {})
  await state.dispose()
  const restored = fixture({ editRewritesHistory: true })
  t.after(() => restored.dispose())
  const cold = await restored.runDurable(session.id, 'return stamp', {
    edit_run_code() { assert.fail('cold recovery redispatched the editor') },
  }, { session, callId: 'volatile-cold' })
  assert.equal(typeof cold.value, 'number', JSON.stringify(cold.error))
  const notices = (cold.logs ?? []).concat((cold.meta?.[JOURNAL_KEY]?.diagnostics ?? []).map(item => item.message))
  // This recovery installs the revision's recorded values, so it owes the restore
  // notice. It also replaced a cell, so it owes the relation. Both facts describe
  // the same event and neither is a substitute for the other: reporting only the
  // restore left `kept` withdrawn with no notice saying so.
  assert.equal(notices.some(text => /Restored 1 cell\(s\) from recorded values/u.test(text)), true,
    JSON.stringify(notices))
  const superseded = notices.find(text => /recorded revision replaced/u.test(text))
  assert.equal(typeof superseded, 'string', JSON.stringify(notices))
  assert.match(superseded, /\(kept\)/u)
  assert.match(superseded, new RegExp(`cell ${targetCallSeq} by cell \\d+`, 'u'))
})

test('a revision the fold cannot apply leaves the path exactly as it found it', async t => {
  const { session, observation, targetCallSeq, rootCallSeq } = await editedSession(t)
  // A record can be internally consistent and still name state the fold no longer
  // holds: a recorded rewind into a checkpoint the fold contracted. The settlement
  // proof states the status, the completion and the diagnostic wording, so editing
  // the operations alone keeps it reproducible and the record is folded normally.
  const events = structuredClone(session.events)
  const derived = events.filter(event => event.type === 'tool/ptc-dispatch'
    && event.data?.name === 'run_code')
  assert.equal(derived.length, 1)
  const ghost = { action: 'restore', name: 'ghost' }
  for (const event of derived) {
    event.data.meta[JOURNAL_KEY].operations = [...(event.data.meta[JOURNAL_KEY].operations ?? []), ghost]
  }
  const rootResult = events.find(event => event.type === 'tool/result'
    && event.data.meta?.[POST_EDIT_KEY] !== undefined)
  assert.notEqual(rootResult, undefined)
  const provenance = rootResult.data.meta[POST_EDIT_KEY]
  provenance.meta[JOURNAL_KEY].operations = [...(provenance.meta[JOURNAL_KEY].operations ?? []), ghost]

  const history = recoverJournal({ events }, undefined, { editRewritesHistory: true })
  // The revision never replaced anything, so the target still builds the
  // environment: the fold denies the relation it could not apply.
  assert.deepEqual(pathToHead(history).map(node => node.callSeq), [targetCallSeq, rootCallSeq])
  assert.deepEqual([...history.supersessions], [])
  assert.deepEqual([...history.supersededBindings], [])
  assert.match(history.volatileSuffix.map(item => item.reason).join('\n'),
    /restores unknown REPL state "ghost"/u)
  assert.deepEqual(
    recoverJournal(observation, undefined, {
      visibleCallSeqs: visibleExecutableCallSeqs(observation),
      editRewritesHistory: true,
    }).supersessions.length,
    1,
    'the same log states the relation once its revision is applicable',
  )
})
