import assert from 'node:assert/strict'
import test from 'node:test'
import { appendRunCodeEvents, fixture } from './plugin-fixture.js'

test('code.run uses the selected language with independent state and recorded child results', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const child = 'const x = 1; const x = x + 1; function f() { const y = 2; y++; return y }; return [x, f(), typeof parentOnly]'
  const result = await state.runDurable('stateful-child', `
const parentOnly = 42
const child = await code.run({ code: ${JSON.stringify(child)}, description: 'Compute in a child' })
return [parentOnly, child.result, typeof x]
`)
  assert.equal(result.isError, false)
  assert.equal(result.meta.dshPtcPlus.calls.length, 1)
  assert.deepEqual(result.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [['code', 'run']])
  assert.equal(state.upstreamCalls.length, 0)
  const observed = await state.run('stateful-child', 'return [parentOnly, child.result, typeof x]')
  assert.deepEqual(observed.value, [42, [2, 3, 'undefined'], 'undefined'])
})

test('isolated children preserve native tool calls and fail at the configured recursion boundary', async t => {
  const state = fixture({ bindingUpdates: 'stateful', maxNestedRunCodeDepth: 1 })
  t.after(() => state.dispose())
  const calls = []
  const child = 'const value = await tools.read({ path: "item" }); return value'
  const result = await state.run('child-tools', `return code.run({ code: ${JSON.stringify(child)}, description: 'Read in child' })`, {
    read: async args => { calls.push(args); return 7 },
  })
  assert.deepEqual(result.value, { logs: [], result: 7 })
  assert.deepEqual(calls, [{ path: 'item' }])
  const recursive = 'return code.run({ code: "return 1", description: "Nested" })'
  const failure = await state.run('child-tools', `return code.run({ code: ${JSON.stringify(recursive)}, description: 'Exceed depth' })`)
  assert.match(failure.error.message, /recursion depth exceeds configured maximum 1/)
  assert.deepEqual(await state.run('child-tools', 'return 42'), { logs: [], value: 42 })
})

test('isolated child imports retain namespace identity and record results without repeating effects on recovery', async t => {
  const session = { id: 'child-import-recovery', events: [] }
  const writer = fixture({ bindingUpdates: 'stateful' })
  t.after(() => writer.dispose())
  const calls = []
  const functions = { record: async args => { calls.push(args); return calls.length } }
  const childSource = `
import * as utilities from 'node:util'
import { format } from 'node:util'
const sameNamespace = utilities === await import('node:util')
const receipt = await tools.record({ value: format('%s', 'child') })
return [sameNamespace, format === utilities.format, receipt, typeof parentOnly]
`
  const source = `const parentOnly = 42; const importedChild = await code.run({ code: ${JSON.stringify(childSource)}, description: 'Import in an isolated child' }); return [importedChild.result, parentOnly, typeof utilities]`
  const written = await writer.runDurable(session.id, source, functions, { session })
  assert.equal(written.isError, false, written.error?.message)
  assert.deepEqual(written.value, [[true, true, 1, 'undefined'], 42, 'undefined'])
  assert.deepEqual(calls, [{ value: 'child' }])
  assert.deepEqual(written.meta.dshPtcPlus.calls.map(call => [call.global, call.member]), [['code', 'run']])
  assert.equal(writer.upstreamCalls.length, 0)
  appendRunCodeEvents(session.events, 'child-import-source', source, written)
  await writer.dispose()

  const reader = fixture({ bindingUpdates: 'stateful' })
  t.after(() => reader.dispose())
  const restored = await reader.run(session.id, 'return [importedChild.result, parentOnly, typeof utilities]', functions, { session })
  assert.deepEqual(restored.value, written.value)
  assert.deepEqual(calls, [{ value: 'child' }])
  assert.equal(reader.upstreamCalls.length, 0)
})

test('legacy child failures retain the host result and leave the parent usable', async t => {
  let childEcho
  const state = fixture({ legacyBindingSettings: true }, { upstreamRun: async request => {
    childEcho = request.bindings.find(binding => binding.global === 'tools').functions.echo
    return { logs: [], error: { kind: 'exception', message: 'child failed' } }
  } })
  t.after(() => state.dispose())
  const result = await state.run('legacy-child-failure', `
const parentValue = 42
try {
  await code.run({ code: 'throw new Error("child failed")', description: 'Run a failing child' })
} catch (error) {
  return [error.name, error.operation, error.message, parentValue]
}
`, { echo: async value => value })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.value.slice(0, 2), ['CodeExecutionError', 'run'])
  assert.match(result.value[2], /nested run_code failed \(exception\): child failed/)
  assert.equal(result.value[3], 42)
  assert.equal(state.upstreamCalls.length, 1)
  assert.equal(state.upstreamCalls[0].program, 'throw new Error("child failed")')
  await assert.rejects(childEcho(1), /lease expired/)
  assert.deepEqual(await state.run('legacy-child-failure', 'return parentValue + await tools.echo(1)', {
    echo: async value => value,
  }), { logs: [], value: 43 })
})

test('disposing the runtime aborts an active isolated child without repeating completed tool effects', async t => {
  const state = fixture({ bindingUpdates: 'stateful', computeMs: 5_000, maxWallMs: 10_000 })
  t.after(() => state.dispose())
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  let calls = 0
  const child = 'await tools.started({}); await new Promise(() => {}); return 42'
  const pending = state.executeRun('dispose-active-child', `return code.run({ code: ${JSON.stringify(child)}, description: 'Wait in an active child' })`, {
    started: async () => { calls++; markStarted(); return null },
  }, {})
  await started
  await state.dispose()
  const { raw, result } = await pending
  // Disposing the whole runtime ends parent and child computation together; the
  // child's own error is not required to reach the outer cell first. Nested error
  // propagation is asserted where only the child is cancelled and the parent stays
  // active (see the timeout and exception cases).
  // Disposing the whole runtime ends parent and child computation together, and the
  // real settlement order decides whether the child's own error reached the parent
  // first. Both observable forms are legitimate cancellation results; each keeps the
  // abort kind, and neither may repeat the completed tool effect.
  assert.equal(result.isError, true)
  if (String(raw.error.message).includes('nested run_code failed')) {
    // The child's abort reached the parent first, so the bridge surfaced it as the
    // parent's own exception carrying the nested wording.
    assert.equal(raw.error.kind, 'exception')
    assert.match(raw.error.message, /nested run_code failed \(abort\): session kernel disposed/)
  } else {
    // The whole runtime was cancelled first, so the parent cell settled as a direct
    // abort of its own.
    assert.equal(raw.error.kind, 'abort')
    assert.match(raw.error.message, /session kernel disposed/)
  }
  assert.equal(calls, 1)
  assert.equal(state.upstreamCalls.length, 0)
})
