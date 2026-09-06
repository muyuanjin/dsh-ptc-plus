import assert from 'node:assert/strict'
import test from 'node:test'
import { renderDiagnostic } from '../internal/diagnostic.js'
import { latestRecoveryTip } from '../internal/recovery-tips.js'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'

const tipConfig = { enabled: true, cooldownMessages: 1, escalationFailures: 2 }
function tipFor(result) {
  return latestRecoveryTip({
    latestRun: { args: { code: 'test' }, journal: result.meta.dshPtcPlus },
    contextStep: 1, systemPromptSnapshots: [],
  }, tipConfig)
}

test('classifies bounded platform facts but leaves generic exits and application errors unknown', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  for (const [detail, expected] of [
    ['The system cannot find the path specified', true],
    ['command not found', true],
    ['exit status 1', false],
    ['search returned no matches', false],
    ['application rejected the record', false],
    ['', false],
  ]) {
    const result = await state.runDurable(`platform-${detail}`, `throw new Error(${JSON.stringify('Command failed: sample\n' + detail)})`)
    assert.equal(tipFor(result)?.name.includes('platform-command-failure') ?? false, expected)
  }
  const stderr = await state.runDurable('stderr-platform', `throw Object.assign(new Error('Command failed: sample'), { stderr: 'The system cannot find the path specified' })`)
  assert.match(tipFor(stderr).text, /current execution world/)
})

test('repeated warnings share the conservative state of lexical, generic and preflight failures', async t => {
  const state = fixture({ looseTopLevelRedeclarations: false })
  t.after(() => state.dispose())
  for (const [id, source, expected, value] of [
    ['missing', 'count++; return missingLocal', 'partially-applied', 3],
    ['tdz', 'count++; return laterLocal; let laterLocal = 1', 'partially-applied', 1],
    ['generic', 'count++; throw new Error("same")', 'partially-applied', 3],
    ['throw', 'throw new Error("same")', 'partially-applied', 0],
    ['collision', 'let count = 4', 'unchanged', 0],
  ]) {
    await state.runDurable(id, 'let count = 0')
    let last
    for (let index = 0; index < 3; index++) last = await state.runDurable(id, source)
    const diagnostics = last.meta.dshPtcPlus.diagnostics
    // Re-declaring a failed TDZ name switches to preflight rejection; it starts
    // a new streak rather than pretending the original exception repeated.
    if (id === 'tdz') {
      assert.equal(diagnostics[0].stateEffect, 'unchanged')
    } else {
      assert.equal(diagnostics[0].stateEffect, expected)
      assert.equal(diagnostics.at(-1).stateEffect, expected)
      assert.match(diagnostics.at(-1).code, /PTC-W00[12]/)
    }
    assert.equal((await state.run(id, 'return count')).value, value)
    if (id === 'missing' || id === 'collision') {
      assert.match(tipFor(last).text, /local name|declaration conflict/)
      assert.doesNotMatch(tipFor(last).text, /capabilities\.(tree|find|inspect)\(/)
    }
  }
})

test('short and long failures preserve owner continuation choices without asserting no effects', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  let changes = 0
  const tools = { applyChange: async () => { changes++; throw new Error('owner: retry with the same idempotency key is permitted') } }
  for (const padding of ['', ' '.repeat(2100)]) {
    const result = await state.runDurable(`effect-${padding.length}`, `${padding}await tools.applyChange({ key: 'same' })`, tools)
    assert.match(result.error.message, /owner: retry with the same idempotency key is permitted/)
    assert.match(result.error.message, /operation owner's retry\/idempotence contract/)
    assert.doesNotMatch(result.error.message, /must query|approval|retry only the failing expression/)
  }
  assert.equal(changes, 2)
  const rejected = await state.runDurable('before-dispatch', 'await tools.applyChange({', tools)
  assert.equal(rejected.meta.dshPtcPlus.status, 'noop')
  assert.equal(changes, 2)
  const unknown = await state.runDurable('unknown-effect', 'await tools.applyChange({})', {
    applyChange: async () => { changes++; throw new Error('unknown outcome') },
  })
  assert.match(unknown.error.message, /available execution facts/)
  assert.doesNotMatch(unknown.error.message, /must query|approval/)
  assert.equal(changes, 3)
})

test('equal output limits distinguish terminated cell state from a live encoding rejection', async t => {
  for (const [id, source, kind, retained] of [
    ['aggregate', 'const limited = Array(100).fill(0); return limited', 'output-limit', false],
    ['encoding', 'const limited = ["x".repeat(600)]; return limited', 'invalid-output', true],
    ['console', 'const limited = 42; console.log("x".repeat(600))', 'output-limit', false],
  ]) {
    const state = fixture({ maxOutputBytes: 512 })
    t.after(() => state.dispose())
    await state.runDurable(id, 'const earlier = 7')
    const { raw, result } = await state.executeRun(id, source, {}, {})
    assert.equal(raw.error.kind, kind)
    assert.equal(result.meta.dshPtcPlus.status, retained ? 'durable' : 'discarded')
    assert.match(result.error.message, retained ? /worker remains live/ : /verified recovery frontier/)
    const next = await state.run(id, 'return [earlier, typeof limited]')
    assert.deepEqual(next.value, [7, retained ? 'object' : 'undefined'])
  }
})

test('recorded diagnostic wording preserves failed-cell bindings and never redispatches effects', async t => {
  for (const [id, ending, legacyHelp] of [
    ['exception', 'throw new Error("same failure")', ['inspect existing bindings and retry only the failing expression']],
    ['encoding', 'return ["x".repeat(600)]', ['return a PTC Value V1 value or keep the live value in a REPL binding', 'reduce the returned graph when it exceeds the configured value budget']],
  ]) {
    for (const mismatch of ['none', 'completion', 'transcript', 'diagnostic']) {
      const session = { id: `${id}-${mismatch}`, events: [] }
      const first = fixture({ maxOutputBytes: 512 })
      let calls = 0
      const tools = { effect: async () => ++calls }
      const source = `const keptValue = await tools.effect({}); ${ending}`
      const result = await first.runDurable(session.id, source, tools, { session })
      const historical = structuredClone(result)
      const journal = historical.meta.dshPtcPlus
      journal.diagnostics[0].help = legacyHelp
      journal.completion.error.message = renderDiagnostic(journal.diagnostics[0], source)
      if (mismatch === 'completion') journal.completion.error.message += '\nchanged completion'
      if (mismatch === 'transcript') journal.calls[0].member = 'other'
      if (mismatch === 'diagnostic') {
        journal.diagnostics[0].message += ' changed failure'
        journal.completion.error.message = renderDiagnostic(journal.diagnostics[0], source)
      }
      appendRunCodeEvents(session.events, 'historical-failure', source, historical)
      await first.dispose()
      const reader = fixture({ maxOutputBytes: 512 })
      t.after(() => reader.dispose())
      const recovered = await reader.run(session.id, 'return typeof keptValue', tools, { session })
      assert.equal(recovered.value, mismatch === 'none' ? 'number' : 'undefined', `${id} ${mismatch}`)
      assert.equal(calls, 1)
    }
  }
})

test('state receipts describe settlement and restore changes the following cell', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const metadata = await state.run('state-contract', 'return capabilities.inspect({symbols:["repl.state"]})')
  assert.match(JSON.stringify(metadata.value), /Awaiting a receipt does not apply the operation mid-cell/)
  await state.runDurable('state-contract', 'let checkpointValue = 1; await repl.state({action:"save", name:"final"}); checkpointValue = 2')
  const restore = await state.runDurable('state-contract', 'checkpointValue = 3; const receipt = await repl.state({action:"restore", name:"final"}); return [receipt.restored, checkpointValue]')
  assert.deepEqual(restore.value, [true, 3])
  assert.equal((await state.run('state-contract', 'return checkpointValue')).value, 2)
  const volatile = await state.runDurable('state-contract', 'await repl.state({action:"save", name:"tentative"}); Date.now()')
  assert.equal(volatile.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(volatile.meta.dshPtcPlus.operations, [])
  assert.deepEqual((await state.run('state-contract', 'return (await repl.state({action:"list"})).names')).value, ['final'])
})

test('synchronous blocking consumes event-loop-active budget while asynchronous waiting does not', async t => {
  const state = fixture({ computeMs: 500, maxWallMs: 5000 })
  t.after(() => state.dispose())
  const session = { id: 'budget', events: [] }
  const tools = {
    wait: () => new Promise(resolve => setTimeout(() => resolve(1), 1100)),
  }
  const source = 'return await tools.wait({})'
  const asyncWait = await state.runDurable(session.id, source, tools, { session })
  appendRunCodeEvents(session.events, 'async-wait', source, asyncWait)
  assert.equal(asyncWait.value, 1)
  const blocking = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)'
  const { raw, result: blocked } = await state.executeRun(session.id, blocking, tools, { session })
  assert.equal(raw.error.kind, 'timeout')
  assert.match(blocked.error.message, /including synchronous blocking/)
  assert.match(blocked.error.message, /does not establish CPU use/)
  assert.equal(blocked.meta.dshPtcPlus.status, 'discarded')
  appendRunCodeEvents(session.events, 'blocking-wait', blocking, blocked)
  assert.equal((await state.run(session.id, 'return 2', tools, { session })).value, 2)
})

test('lease advice requires worker-owned provenance and retained helpers resolve current tools', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('lease', 'const cached = tools.value; const namespace = tools; async function current() { return tools.value({}) }', { value: async () => 1 })
  for (const source of ['await cached({})', 'await namespace.value({})']) {
    const expired = await state.runDurable('lease', source, { value: async () => 2 })
    assert.match(expired.error.message, /reference belongs to an ended cell/)
  }
  assert.equal((await state.run('lease', 'return current()', { value: async () => 3 })).value, 3)
  const forged = await state.runDurable('lease-forged', 'throw Object.assign(new Error("PTC execution lease expired"), {failureOrigin:"lease"})')
  assert.doesNotMatch(forged.error.message, /reference belongs to an ended cell/)
})
