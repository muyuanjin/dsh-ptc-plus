import assert from 'node:assert/strict'
import test from 'node:test'

import { readSessionLog } from '../internal/session-events.js'
import {
  pathToHead, recoverJournal, visibleExecutableCallSeqs,
} from '../internal/session-journal-recovery.js'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { appendOnlySession, fixture, ptcAgent, runNestedEditCell } from './plugin-fixture.js'

/**
 * A session whose second cell edits the first one.
 *
 * The first cell declares `rewriteValue`; the accepted edit revises its source so
 * the revision supplies the same name with a new value. That is the smallest log
 * in which appending and rewriting disagree: both cells stay recorded either way,
 * and only the fold decides which of them builds the environment.
 */
async function editedSession(t) {
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
  const setup = await state.runDurable(session.id, 'let rewriteValue = 1; return rewriteValue', {},
    { session, callId: 'rewrite-setup' })
  assert.equal(setup.value, 1)
  const targetCallSeq = session.events.find(event => event.type === 'tool/call'
    && event.data.callId === 'rewrite-setup').seq
  const root = await runNestedEditCell(state, { session, agent, signal, callId: 'rewrite-root',
    code: 'return await tools.edit_run_code({ edits: [{ old_string: "= 1", new_string: "= 2" }] })' })
  assert.equal(root.receipt.accepted, true, JSON.stringify(root.receipt))
  assert.equal(root.receipt.target_call_seq, targetCallSeq)
  const observation = await readSessionLog(session, state.ctx.sessionQuery)
  return { session, state, observation, targetCallSeq }
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
  const { observation, targetCallSeq } = await editedSession(t)
  const rewritten = recoverJournal(observation, undefined, {
    visibleCallSeqs: visibleExecutableCallSeqs(observation),
    editRewritesHistory: true,
  })
  assert.equal(rewritten.available, true, JSON.stringify(rewritten))
  const path = pathToHead(rewritten)
  // The superseded cell keeps its place in the record and leaves the path; the
  // cells that followed it continue from its parent, so the environment holds
  // everything the log recorded except that one cell.
  assert.equal(path.some(node => node.callSeq === targetCallSeq), false)
  assert.equal(path.length, 2)
  assert.equal(rewritten.nodes.some(node => node.callSeq === targetCallSeq), true)
  assert.match(path.at(-1).code, /= 2/u)
  assert.equal(path[0].parent, undefined)
  assert.deepEqual([...rewritten.supersessions], [{
    supersededCallSeq: targetCallSeq,
    supersedingCallSeq: path.at(-1).callSeq,
  }])
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
