import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, appendOnlySession, ptcAgent, runNestedEditCell } from './plugin-fixture.js'

// A rejected `edit_run_code` changes nothing: the kernel keeps its worker, the
// replay head stays where it was, and every binding created earlier is still
// available in the next cell. Real session `session-cc581c44` lost `greet`,
// `r2` and `info` exactly one cell after two rejected edits, so this pins the
// contract that a refusal must not be mistaken for a history change.
test('a rejected edit does not rebuild the kernel or drop earlier bindings', async t => {
  const session = appendOnlySession('rejected-edit-keeps-bindings')
  const state = fixture()
  t.after(() => state.dispose())
  const agent = ptcAgent(session.id, session)
  const signal = new AbortController().signal
  session.append('turn/start', {})
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )

  const setup = await state.runDurable(
    session.id,
    'const greet = "hi"; const r2 = 2; const info = { a: 1 }; return greet',
    {},
    { session, callId: 'greet-setup' },
  )
  assert.equal(setup.value, 'hi')

  // A long-lived session keeps many live calls; the refusal must not make the
  // older ones look unreachable either.
  for (let index = 0; index < 12; index += 1) {
    const filled = await state.runDurable(
      session.id,
      `const pad${index} = ${index}; return pad${index}`,
      {},
      { session, callId: `pad-${index}` },
    )
    assert.equal(filled.value, index)
  }

  // The nested edit targets a string that does not exist, so the tool refuses it.
  const code = 'const refused = await tools.edit_run_code({ edits: [{ old_string: "no-such-text-xyz", new_string: "x" }] }); return refused'
  const root = await runNestedEditCell(state, { session, agent, signal, callId: 'rejected-edit', code })
  assert.equal(root.receipt.accepted, false)

  const after = await state.runDurable(
    session.id,
    'return [typeof greet, r2, typeof info]',
    {},
    { session, callId: 'after-rejected-edit' },
  )
  assert.deepEqual(after.value, ['string', 2, 'object'])

  const logs = [...(setup.logs ?? []), ...(root.logs ?? []), ...(after.logs ?? [])].join('\n')
  assert.doesNotMatch(logs, /PTC-R002/u)
  assert.doesNotMatch(logs, /PTC-R004/u)
  assert.doesNotMatch(logs, /PTC-R006/u)
})
