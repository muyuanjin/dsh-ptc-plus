import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import * as recovery from '../internal/session-journal-recovery.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { sessionKernel, restartWorker } from './runtime-observation.js'

test('historical recovery faults contract the frontier and preserve current computation', async t => {
  let fault, retained
  const recoveryUrl = new URL('../internal/session-journal-recovery.js', import.meta.url).href
  const runtimeUrl = new URL('../internal/session-runtime.js', import.meta.url).href
  const fixtureUrl = new URL('./session-recovery-reader-fixture.js', import.meta.url).href
  // A generated test double has its own source identity; coverage for the real
  // recovery module must describe its executed code, never the mock's guard.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    return context.parentURL === runtimeUrl && resolved.url === recoveryUrl
      ? next(fixtureUrl, context) : resolved
  } })
  t.after(() => hooks.deregister())
  t.mock.module(fixtureUrl, { namedExports: {
    ...recovery,
    recoverJournal(session, callSeq, options) {
      if (fault === 'boundary' && options?.extraBoundaries || fault === 'refresh' || fault === 'initial') throw Error('historical reader failed')
      if (fault === 'stalled' && options?.extraBoundaries) return retained
      return recovery.recoverJournal(session, callSeq, options)
    },
  } })
  const { SessionRuntime } = await import('../internal/session-runtime.js')
  fault = 'initial'
  const initial = new SessionRuntime()
  t.after(() => initial.dispose())
  const initialized = await initial.run('initial', { program: 'return 42', bindings: [] })
  assert.equal(initialized.error.kind, 'recovery')
  assert.match(initialized.error.message, /historical reader failed/)
  fault = undefined
  assert.equal((await initial.run('initial', { program: 'return 42', bindings: [] })).value, 42)
  await initial.dispose()
  for (const mode of ['planning', 'boundary', 'stalled', 'refresh']) {
    fault = undefined
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    assert.equal((await runtime.run(mode, { program: 'return 0', bindings: [] })).value, 0)
    const kernel = sessionKernel(runtime, mode)
    await restartWorker(runtime, mode)
    const journal = normalizeJournal({ version: 3, bindingMode: 'loose',
      rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
      status: 'durable', calls: [], operations: [], confirms: [], diagnostics: [],
      completion: { kind: 'return', hasValue: false } })
    const node = { callSeq: 0, code: 'throw Error("historical replay failed")', journal }
    retained = { nodes: [node], head: 0, checkpoints: new Map(), volatileSuffix: [], available: true }
    kernel.history = retained
    if (mode === 'planning') {
      const original = kernel.replayHistory
      kernel.replayHistory = async function (...args) {
        this.replayHistory = original
        throw Error('historical planning failed')
      }
    }
    if (mode === 'refresh') kernel.session = { surface: { replaceGeneration: 1, nodes: [] } }
    fault = mode
    const execution = await runtime.runTentative(mode, { program: 'let current=42;return current', bindings: [] })
    const result = execution.result
    assert.deepEqual(execution.settlement.recoveryBoundaries, [{ failedCallSeq: 0, frontierCallSeq: null }])
    runtime.finalize(execution.settlement, true)
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.value, 42)
    assert.equal(result.logs.filter(log => log.includes('PTC-R002')).length, 1)
    fault = undefined
    const next = await runtime.run(mode, { program: 'return ++current', bindings: [] })
    assert.equal(next.value, 43)
    assert.deepEqual(next.logs, [])
    await runtime.dispose()
  }
  const disabled = new SessionRuntime({ durableReplay: false })
  t.after(() => disabled.dispose())
  const result = await disabled.run({ id: 'no-journal', callId: 'current',
    session: { events: [{ seq: -1, type: 'tool/call', data: { name: 'run_code', callId: 'current' } }] } },
  { program: 'return 42', bindings: [] })
  assert.equal(result.value, 42)
})
