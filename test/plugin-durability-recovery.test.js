import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Config } from '../index.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import { JOURNAL_POLICY, appendOnlySession, appendRunCodeEvents, fixture } from './plugin-fixture.js'
import { assertSameFilesystemEntry } from './filesystem-identity.js'

test('cold-replays predecessor journals with bindings and named states intact', async (t) => {
  const events = []
  const session = { id: 'predecessor-journal', events }
  const writer = fixture()
  const source = `
let predecessorBinding = 41
void await repl.state({ action: 'save', name: 'predecessor-point' })
return predecessorBinding
`
  const written = await writer.runDurable(session.id, source, {}, { session })
  const predecessor = structuredClone(written)
  predecessor.meta.dshPtcPlus.version = 1
  predecessor.meta.dshPtcPlus.bindingMode = 'loose'
  delete predecessor.meta.dshPtcPlus.bindingPolicy
  delete predecessor.meta.dshPtcPlus.rewritePolicy
  delete predecessor.meta.dshPtcPlus.moduleSemantics
  appendRunCodeEvents(events, 'predecessor-cell', source, predecessor)
  await writer.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, `
const states = await repl.state({ action: 'list' })
return { value: predecessorBinding, names: states.names }
`, {}, { session }), {
    logs: [],
    value: { value: 41, names: ['predecessor-point'] },
  })
})

test('cold-replays predecessor default exports with their recorded writable binding semantics', async (t) => {
  for (const version of [2, 3]) {
    const events = []
    const session = { id: `predecessor-default-export-v${version}`, events }
    const writer = fixture()
    const setupSource = 'export default 1'
    const setup = await writer.runDurable(session.id, 'let __default = 1', {}, { session })
    const assignmentSource = 'try { __default = 2 } catch {}\nreturn __default'
    const assignment = await writer.runDurable(
      session.id,
      '__default = 2\nreturn __default',
      {},
      { session },
    )
    const predecessorSetup = structuredClone(setup)
    const predecessorAssignment = structuredClone(assignment)
    for (const result of [predecessorSetup, predecessorAssignment]) {
      result.meta.dshPtcPlus.version = version
      result.meta.dshPtcPlus.bindingMode = 'loose'
      delete result.meta.dshPtcPlus.bindingPolicy
      delete result.meta.dshPtcPlus.moduleSemantics
    }
    appendRunCodeEvents(
      events,
      `predecessor-default-v${version}-setup`,
      setupSource,
      predecessorSetup,
    )
    appendRunCodeEvents(
      events,
      `predecessor-default-v${version}-assignment`,
      assignmentSource,
      predecessorAssignment,
    )
    await writer.dispose()

    const restored = fixture()
    t.after(() => restored.dispose())
    const recovered = await restored.run(session.id, 'return __default', {}, { session })
    assert.deepEqual(recovered, { logs: [], value: 2 })
  }
})

test('keeps non-journalable Node capabilities live in a volatile suffix', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const observed = await state.executeRun('volatile-node', `
const fsModule = await import("node:fs")
return typeof fsModule.readFileSync
`, {}, {})
  const imported = observed.result
  assert.equal(imported.value, 'function')
  assert.equal(imported.meta.dshPtcPlus.status, 'volatile')
  assert.deepEqual(observed.raw.logs, [])
  assert.deepEqual(imported.meta.dshPtcPlus.diagnostics, [])
  const continued = await state.executeRun('volatile-node', 'return typeof fsModule.readFileSync', {}, {})
  assert.deepEqual(continued.raw, {
    logs: [],
    value: 'function',
  })
  assert.deepEqual(continued.result.meta.dshPtcPlus.diagnostics, [])
})

test('keeps volatile transitions quiet after metadata removal', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const first = await state.executeRun('volatile-notice-once', `
console.log('ordinary')
void Date.now()
`, {}, {
    finalizeResult(result) {
      const { meta: _removed, ...withoutMeta } = result
      return withoutMeta
    },
  })
  assert.deepEqual(first.raw.logs, ['ordinary'])
  assert.equal(first.result.meta, undefined)

  const next = await state.executeRun('volatile-notice-once', 'return 42', {}, {})
  assert.deepEqual(next.raw, { logs: [], value: 42 })
  assert.deepEqual(next.result.meta.dshPtcPlus.diagnostics, [])
})

test('uses the session header cwd without inheriting the host process cwd', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-plus-session-cwd-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const state = fixture()
  t.after(() => state.dispose())
  const session = { id: 'session-cwd', header: { cwd }, events: [] }

  const recordedRun = await state.executeRun(session.id, 'return process.cwd()', {}, { session })
  const recorded = recordedRun.result
  assert.equal(recorded.value, cwd)
  assert.deepEqual(recordedRun.raw.logs, [])
  assert.equal(recorded.meta.dshPtcPlus.status, 'durable')

  const unrecordedRun = await state.executeRun('missing-session-cwd', 'return process.cwd()', {}, {})
  const unrecorded = unrecordedRun.result
  assert.equal(typeof unrecorded.value, 'string')
  assert.equal(unrecorded.meta.dshPtcPlus.status, 'volatile')
  assert.equal(unrecorded.meta.dshPtcPlus.volatileReason, 'process.cwd')
  assert.deepEqual(unrecordedRun.raw.logs, [])
})

test('preserves recorded cwd while native paths retain filesystem identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-plus-cwd-'))
  const physicalCwd = join(root, 'physical')
  await mkdir(physicalCwd)
  const cwd = process.platform === 'win32' ? physicalCwd : join(root, 'alias')
  if (cwd !== physicalCwd) await symlink(physicalCwd, cwd, 'dir')
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = fixture({ maxWallMs: 500 })
  t.after(() => state.dispose())
  const session = { id: 'native-session-cwd', header: { cwd }, events: [] }
  const source = `
const fs = await import('node:fs')
const path = await import('node:path')
let chdirMessage
try { process.chdir('/') } catch (error) { chdirMessage = error.message }
return { exposed: process.cwd(), native: fs.realpathSync('.'), resolved: path.resolve('.'), chdirMessage }
`
  const observed = await state.executeRun(session.id, source, {}, { session })
  const { native, ...recordedSurfaces } = observed.raw.value
  assert.deepEqual(recordedSurfaces, {
    exposed: cwd,
    resolved: cwd,
    chdirMessage: 'process.chdir is forbidden inside the REPL kernel',
  })
  await assertSameFilesystemEntry(native, physicalCwd)

  const timedOut = await state.run(session.id, 'await new Promise(() => {})', {}, { session })
  assert.equal(timedOut.error.kind, 'timeout')
  const afterReset = await state.run(session.id, 'return process.cwd()', {}, { session })
  assert.deepEqual(afterReset, { logs: [], value: cwd })
})

test('provides an isolated scratch directory while preserving the host environment', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-scratch', `
const osForScratch = await import('node:os')
const { execFileSync: resolveExecutable } = await import('node:child_process')
const executable = process.platform === 'win32' ? 'node.exe' : 'node'
return {
  directory: osForScratch.tmpdir(),
  temp: process.env.TEMP,
  tmp: process.env.TMP,
  tmpdir: process.env.TMPDIR,
  path: process.env.PATH ?? null,
  home: process.env.HOME ?? null,
  comSpec: process.env.ComSpec ?? null,
  hasSystemRoot: process.env.SystemRoot !== undefined,
  resolvedExecutable: resolveExecutable(executable, ['-e', 'process.stdout.write("resolved")'], { encoding: 'utf8' }),
}
`)
  assert.equal(isAbsolute(result.value.directory), true)
  assert.equal(result.value.directory.includes('undefined'), false)
  assert.equal(result.value.temp, result.value.directory)
  assert.equal(result.value.tmp, result.value.directory)
  assert.equal(result.value.tmpdir, result.value.directory)
  assert.equal(result.value.path, process.env.PATH ?? null)
  assert.equal(result.value.home, process.env.HOME ?? null)
  assert.equal(result.value.comSpec, process.env.ComSpec ?? null)
  assert.equal(result.value.hasSystemRoot, process.env.SystemRoot !== undefined)
  assert.equal(result.value.resolvedExecutable, 'resolved')
  await access(result.value.directory)

  const other = await state.run('session-scratch-other', `
const otherScratchOs = await import('node:os')
return otherScratchOs.tmpdir()
`)
  assert.equal(isAbsolute(other.value), true)
  assert.notEqual(other.value, result.value.directory)
  await access(other.value)

  await state.dispose()
  await assert.rejects(access(result.value.directory))
  await assert.rejects(access(other.value))
})

test('rejects kernel-control modules through the global require view', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-a', 'return globalThis.require("node:worker_threads")')
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /forbidden because it exposes kernel control/)
})

test('rejects non-replayable worker control imports', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const result = await state.run('session-a', `
const { parentPort } = await import("node:worker_threads")
parentPort.postMessage({ type: "done", id: 1, logs: [], value: [999] })
parentPort.postMessage({ type: "call", runId: 1, id: 1, global: "tools", member: "forged", args: [null] })
return 42
`, { forged: async () => { throw new Error('public parentPort reached host protocol') } })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /^error\[PTC-C002\]: cell import of node:worker_threads is forbidden/)
  assert.match(result.error.message, /phase: preflight\nstate: unchanged/)
  assert.match(result.error.message, /forbidden because it exposes kernel control/)

  const alias = await state.run('session-b', 'return import("worker_threads")')
  assert.equal(alias.error.kind, 'exception')
  assert.match(alias.error.message, /forbidden because it exposes kernel control/)
})

test('does not replay a volatile cell after a cold restore', async (t) => {
  const events = []
  const session = { id: 'session-rejected', events }
  const first = fixture()
  t.after(() => first.dispose())
  const code = 'const shouldNeverExist = Date.now()'
  const rejected = await first.runDurable('session-rejected', code, {}, { session })
  assert.equal(rejected.isError, false)
  assert.equal(rejected.meta.dshPtcPlus.status, 'volatile')
  appendRunCodeEvents(events, 'call-rejected', code, rejected)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const observed = await restored.executeRun('session-rejected', 'return typeof shouldNeverExist', {}, { session })
  const text = [
    'warning[PTC-R002]: Restored the durable head and skipped 1 unreconstructable historical cell(s); their source remains in the session log.',
    'phase: recover',
    'state: rolled-back',
    'help: continue from the restored bindings',
    'help: do not reference values created only in the skipped suffix',
  ].join('\n')
  assert.deepEqual(observed.raw, { logs: [text], value: 'undefined' })
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics, [{
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    message: 'Restored the durable head and skipped 1 unreconstructable historical cell(s); their source remains in the session log.',
    stateEffect: 'rolled-back',
    help: [
      'continue from the restored bindings',
      'do not reference values created only in the skipped suffix',
    ],
  }])
})

test('recovers the last durable frontier when a run_code journal is missing', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const session = {
    id: 'session-incomplete',
    events: [{
      type: 'tool/call',
      seq: 0,
      time: 0,
      data: {
        turn: 0,
        step: 0,
        callId: 'old-call',
        name: 'run_code',
        arguments: JSON.stringify({ code: 'const lost = 1', description: 'old cell' }),
      },
    }],
  }
  const result = await state.run('session-incomplete', 'return 1', {}, { session })
  assert.equal(result.value, 1)
  assert.match(result.logs[0], /unreconstructable historical cell/)
})

test('excludes the current in-flight run_code call from history recovery', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const callId = 'current-call'
  const session = {
    id: 'session-current-call',
    events: [{
      type: 'tool/call',
      seq: 63,
      time: 63,
      data: {
        turn: 0,
        step: 0,
        callId,
        name: 'run_code',
        arguments: JSON.stringify({ code: 'return 1', description: 'current cell' }),
      },
    }],
  }
  assert.deepEqual(await state.run(session.id, 'return 1', {}, { session, callId }), {
    logs: [],
    value: 1,
  })
})

test('recovers prior durable history while excluding the current call', async (t) => {
  const events = []
  const session = { id: 'session-prior-and-current', events }
  const first = fixture()
  t.after(() => first.dispose())
  const priorCode = 'const priorDurableValue = 41'
  const prior = await first.runDurable(session.id, priorCode, {}, { session })
  appendRunCodeEvents(events, 'prior-call', priorCode, prior)
  await first.dispose()

  const callId = 'current-after-prior'
  events.push({
    type: 'tool/call',
    seq: events.length,
    time: events.length,
    data: {
      turn: 1,
      step: 0,
      callId,
      name: 'run_code',
      arguments: JSON.stringify({ code: 'return priorDurableValue + 1', description: 'current cell' }),
    },
  })
  const restored = fixture()
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.run(session.id, 'return priorDurableValue + 1', {}, { session, callId }), {
    logs: [],
    value: 42,
  })
})

test('advances durability again after recovering an unknown suffix', async (t) => {
  const events = [{
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: {
      turn: 0,
      step: 0,
      callId: 'unknown-call',
      name: 'run_code',
      arguments: JSON.stringify({ code: 'const unknownBinding = 1', description: 'unknown cell' }),
    },
  }]
  const session = { id: 'session-rebased', events }
  const first = fixture()
  t.after(() => first.dispose())
  const rebasedCode = `
const rebasedBinding = 2
void await repl.state({ action: 'save', name: 'rebased' })
`
  const rebased = await first.runDurable(session.id, rebasedCode, {}, { session })
  assert.equal(rebased.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'rebased-call', rebasedCode, rebased)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, `
const states = await repl.state({ action: 'list' })
return { unknown: typeof unknownBinding, rebasedBinding, names: states.names }
`, {}, { session })
  assert.deepEqual(result, {
    logs: [],
    value: { unknown: 'undefined', rebasedBinding: 2, names: ['rebased'] },
  })
})

test('preserves deeply nested JSON and own __proto__ keys', async (t) => {
  const state = fixture({ maxOutputBytes: 4 * 1024 * 1024 })
  t.after(() => state.dispose())

  const proto = await state.run('session-a', 'return JSON.parse(\'{"__proto__":{"safe":true}}\')')
  assert.equal(Object.hasOwn(proto.value, '__proto__'), true)
  assert.deepEqual(proto.value.__proto__, { safe: true })
  assert.equal(Object.getPrototypeOf(proto.value), Object.prototype)

  await state.run('session-a', `
let deep = "leaf"
for (let index = 0; index < 5000; index += 1) deep = [deep]
`)
  const result = await state.run('session-a', 'return deep')
  let cursor = result.value
  let depth = 0
  while (Array.isArray(cursor)) { cursor = cursor[0]; depth += 1 }
  assert.equal(depth, 5_000)
  assert.equal(cursor, 'leaf')
})

test('compares persisted journals with deeply nested tool arguments iteratively', async (t) => {
  const state = fixture({ maxOutputBytes: 4 * 1024 * 1024 })
  t.after(() => state.dispose())
  const result = await state.runDurable('deep-journal', `
let nestedArgument = "leaf"
for (let index = 0; index < 5000; index += 1) nestedArgument = [nestedArgument]
return await tools.measureDepth({ value: nestedArgument })
`, {
    measureDepth: async ({ value }) => {
      let cursor = value
      let depth = 0
      while (Array.isArray(cursor)) { cursor = cursor[0]; depth += 1 }
      return { depth, leaf: cursor }
    },
  })
  assert.deepEqual(result.value, { depth: 5_000, leaf: 'leaf' })
  assert.equal(result.meta.dshPtcPlus.status, 'durable')
})

test('hard cancellation restores the previous durable frontier', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 })
  t.after(() => state.dispose())
  await state.run('session-a', 'const beforeAbort = 1')

  const controller = new AbortController()
  const pending = state.run('session-a', 'for (;;) {}', {}, { controller })
  setTimeout(() => controller.abort('stop requested'), 30)
  assert.deepEqual(await pending, {
    logs: [],
    error: { kind: 'abort', message: 'stop requested' },
  })
  assert.deepEqual(await state.run('session-a', 'return typeof beforeAbort'), {
    logs: [],
    value: 'number',
  })
})

test('attributes inherited async callbacks to the currently active cell', async (t) => {
  const events = []
  const session = { id: 'async-volatility', events }
  const first = fixture()
  t.after(() => first.dispose())
  const setupCode = `
let asyncValue = 0
let releaseAsyncValue
const deferredAsyncValue = new Promise(resolve => { releaseAsyncValue = resolve })
void deferredAsyncValue.then(() => { asyncValue = Math['ran' + 'dom']() })
`
  const setup = await first.runDurable(session.id, setupCode, {}, { session })
  assert.equal(setup.meta.dshPtcPlus.status, 'durable')
  appendRunCodeEvents(events, 'async-setup', setupCode, setup)

  const triggerCode = `
releaseAsyncValue()
await Promise.resolve()
return asyncValue
`
  const triggered = await first.runDurable(session.id, triggerCode, {}, { session })
  assert.equal(typeof triggered.value, 'number')
  assert.equal(triggered.meta.dshPtcPlus.status, 'volatile')
  appendRunCodeEvents(events, 'async-trigger', triggerCode, triggered)
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, 'return asyncValue', {}, { session })
  assert.equal(result.value, 0)
  assert.match(result.logs[0], /unreconstructable historical cell/)
})

test('keeps result and error conversion inside the active execution', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())

  const returned = await state.runDurable('result-conversion-volatility', `
let resultConversionState = 0
return {
  get value() {
    resultConversionState = Math['ran' + 'dom']()
    return resultConversionState
  }
}
`)
  assert.match(returned.error.message, /^error\[PTC-O001\]: cell result could not cross the PTC Value V1 boundary:/)
  assert.equal(returned.meta.dshPtcPlus.status, 'durable')

  const thrown = await state.runDurable('error-conversion-volatility', `
throw {
  toString() {
    void Math['ran' + 'dom']()
    return 'converted failure'
  }
}
`)
  assert.equal(thrown.isError, true)
  assert.match(thrown.error.message, /^error\[PTC-X001\]: uncaught Error: converted failure/)
  assert.equal(thrown.meta.dshPtcPlus.status, 'volatile')
  assert.equal(thrown.meta.dshPtcPlus.volatileReason, 'Math.random')
  assert.deepEqual(thrown.meta.dshPtcPlus.diagnostics.map(item => item.code), ['PTC-X001'])
})

test('does not lose cancellation during cold worker startup', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 })
  t.after(() => state.dispose())
  const controller = new AbortController()
  const pending = state.run('cold-abort', 'const coldBinding = 1', {}, { controller })
  controller.abort('cancelled during startup')
  assert.deepEqual(await pending, {
    logs: [],
    error: { kind: 'abort', message: 'cancelled during startup' },
  })
  assert.deepEqual(await state.run('cold-abort', 'return typeof coldBinding'), {
    logs: [],
    value: 'undefined',
  })
})

test('does not contract durable history when cold replay is already cancelled', async (t) => {
  const events = []
  const session = { id: 'cold-replay-abort', events }
  const writer = fixture()
  const source = 'const durableBeforeReplayAbort = 41'
  const written = await writer.runDurable(session.id, source, {}, { session })
  appendRunCodeEvents(events, 'cold-replay-abort-call', source, written)
  await writer.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const controller = new AbortController()
  controller.abort('cancelled before replay')
  assert.deepEqual(await restored.run(session.id, 'return durableBeforeReplayAbort', {}, {
    session,
    controller,
  }), {
    logs: [],
    error: { kind: 'abort', message: 'cancelled before replay' },
  })
  assert.deepEqual(await restored.run(session.id, 'return durableBeforeReplayAbort', {}, { session }), {
    logs: [],
    value: 41,
  })
})

test('preserves an observed direct volatile boundary when the cell times out', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 100 })
  t.after(() => state.dispose())
  const result = await state.runDurable('direct-volatile-timeout', `
Reflect.get(globalThis, String.fromCharCode(68, 97, 116, 101)).now()
await new Promise(() => {})
`)
  assert.equal(result.isError, true)
  assert.equal(result.meta.dshPtcPlus.status, 'discarded')
  assert.equal(result.meta.dshPtcPlus.volatileReason, 'ambient Date')

  const continued = await state.run('direct-volatile-timeout', 'return repl.state({ action: "list" })')
  assert.equal(continued.value.mode, 'volatile')
  assert.equal(continued.value.volatileReason, 'ambient Date')
  assert.deepEqual(continued.logs, [])
})

test('preserves a generic possible-effect boundary for an unsettled native tool call', async (t) => {
  const state = fixture({ computeMs: 1_000, maxWallMs: 2_000 })
  t.after(() => state.dispose())
  await state.run('pending-call-abort', 'const durableBeforePendingCall = 1')

  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const controller = new AbortController()
  const pending = state.runDurable('pending-call-abort', 'await tools.neverSettles({})', {
    neverSettles: async () => {
      signalStarted()
      return new Promise(() => {})
    },
  }, { controller })
  await started
  controller.abort('stop pending host call')
  const result = await pending
  assert.equal(result.isError, true)
  assert.equal(result.meta.dshPtcPlus.status, 'discarded')
  assert.deepEqual(result.meta.dshPtcPlus.calls, [])
  assert.equal(result.meta.dshPtcPlus.volatileReason, 'tools.neverSettles')
  const continued = await state.run('pending-call-abort', `
return { durableBeforePendingCall, state: await repl.state({ action: 'list' }) }
`)
  assert.equal(continued.value.durableBeforePendingCall, 1)
  assert.equal(continued.value.state.mode, 'volatile')
  assert.equal(continued.value.state.volatileReason, 'tools.neverSettles')
  assert.deepEqual(continued.logs, [])
})

test('treats post-execute metadata removal as a volatile boundary', async (t) => {
  const events = []
  const session = { id: 'session-post-strip', events }
  const first = fixture()
  t.after(() => first.dispose())

  const durableCode = 'const durableValue = 40'
  const durable = await first.runDurable(session.id, durableCode, {}, { session })
  appendRunCodeEvents(events, 'durable-call', durableCode, durable)

  const strippedCode = 'const strippedValue = 2'
  const stripped = await first.runDurable(session.id, strippedCode, {}, {
    session,
    finalizeResult(result) {
      const { meta: _removed, ...withoutMeta } = result
      return withoutMeta
    },
  })
  assert.equal(stripped.meta, undefined)
  appendRunCodeEvents(events, 'stripped-call', strippedCode, stripped)
  const live = await first.run(session.id, 'return durableValue + strippedValue')
  assert.equal(live.value, 42)
  assert.deepEqual(live.logs, [])
  await first.dispose()

  const restored = fixture()
  t.after(() => restored.dispose())
  const result = await restored.run(session.id, `
return { durableValue, strippedType: typeof strippedValue }
`, {}, { session })
  assert.deepEqual(result.value, { durableValue: 40, strippedType: 'undefined' })
  assert.match(result.logs[0], /unreconstructable historical cell/)
})
