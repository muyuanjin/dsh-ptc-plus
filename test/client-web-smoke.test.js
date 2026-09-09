import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  releaseResources,
  runCommand,
  stopOwnedProcess,
  watchProcessEnd,
} from '../scripts/client-web-smoke.mjs'
import { formatHeadlessError } from '../scripts/headless-host.mjs'
import { apply as applyFixture, probeMarker, probeReason } from './binding-web-adapter.js'

function fakeProcess(overrides = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    return true
  }
  return Object.assign(child, overrides)
}

/** Grace timers are unref'd, so a test without a live child must hold the loop open itself. */
function holdEventLoop(t) {
  const timer = setInterval(() => {}, 25)
  t.after(() => clearInterval(timer))
}

test('delivers a tail chunk that arrives after exit and before close', async () => {
  const child = fakeProcess()
  const pending = runCommand('fake-command', [], { spawn: () => child })
  child.stdout.emit('data', '{"filename":')
  child.emit('exit', 0)
  child.stdout.emit('data', '"packed.tgz"}')
  child.stderr.emit('data', '')
  child.emit('close', 0)
  assert.deepEqual(JSON.parse(await pending), { filename: 'packed.tgz' })
})

test('collects complete stdout from a real child before the caller parses it', async () => {
  const output = await runCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([1,2,3]))'])
  assert.deepEqual(JSON.parse(output), [1, 2, 3])
})

test('rejects a failing command with its exit code and stderr tail', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.stderr.write(process.version); process.exit(3)']),
    /exited 3: v\d/,
  )
})

test('propagates a spawn failure instead of reporting a command exit', async () => {
  await assert.rejects(
    runCommand('missing-command', [], { spawn() { throw new Error('spawn ENOENT') } }),
    /spawn ENOENT/,
  )
})

test('cleans a host that already exited by signal without waiting for another exit', async () => {
  const child = fakeProcess()
  const state = watchProcessEnd(child)
  child.signalCode = 'SIGTERM'
  child.emit('exit', null, 'SIGTERM')
  let terminations = 0
  const pending = stopOwnedProcess(child, {
    state,
    platform: 'linux',
    spawn() { terminations += 1; return new EventEmitter() },
  })
  child.emit('close', null, 'SIGTERM')
  await pending
  assert.equal(terminations, 0)
  assert.deepEqual(child.signals, [])
})

test('requests bounded termination for a still-running owned process', async () => {
  const child = fakeProcess({
    kill(signal) {
      child.signals.push(signal)
      queueMicrotask(() => {
        child.signalCode = signal ?? 'SIGTERM'
        child.emit('close', null, signal)
      })
      return true
    },
  })
  await stopOwnedProcess(child, { state: watchProcessEnd(child), platform: 'linux', graceMs: 50 })
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('reports a bounded cleanup failure when an owned process never exits', async (t) => {
  holdEventLoop(t)
  const child = fakeProcess()
  await assert.rejects(
    stopOwnedProcess(child, { state: watchProcessEnd(child), platform: 'linux', graceMs: 10 }),
    /did not exit within the bounded termination grace/,
  )
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
})

test('releases every owned resource and keeps the primary acceptance failure primary', async () => {
  const released = []
  const primary = new Error('acceptance failed')
  await releaseResources([
    ['browser', async () => { released.push('browser'); throw new Error('browser close failed') }],
    ['web host process', async () => { released.push('web host process') }],
    ['temporary profile', async () => { released.push('temporary profile'); throw new Error('remove failed') }],
  ], primary)
  assert.deepEqual(released, ['browser', 'web host process', 'temporary profile'])
  assert.match(formatHeadlessError(primary), /acceptance failed[\s\S]*Cleanup also failed:[\s\S]*browser: browser close failed[\s\S]*temporary profile: remove failed/)
  await assert.rejects(
    releaseResources([['browser', async () => { throw new Error('only failure') }]]),
    /browser: only failure/,
  )
  await releaseResources([['browser', async () => {}]])
})

/** Load the fixture against a minimal Host context and expose what the acceptance drives. */
function fixtureHost() {
  const provided = new Map()
  const adapters = []
  const preExecute = []
  const ctx = {
    effect: operation => { operation(); return () => {} },
    provide: (name, value) => provided.set(name, value),
    typert: { register: () => () => {} },
    tools: { register: () => () => {} },
    on: (name, handler) => { if (name === 'tools/pre-execute') preExecute.push(handler); return () => {} },
    settings: { update: async () => {} },
    workspaceRegistry: { create: async () => {} },
    llm: { registerAdapter: (names, adapter) => { adapters.push(adapter); return () => {} } },
  }
  applyFixture(ctx)
  return { service: provided.get('ptcWebFixture'), adapter: adapters[0], preExecute }
}

const probeMessage = text => ({ messages: [{ content: [{ type: 'text', text }] }] })

test('the fixture asks for the probe decision and leaves every other tool to the Host', () => {
  const { preExecute } = fixtureHost()
  assert.equal(preExecute.length, 1, 'The fixture did not register one pre-execute ask source')
  let passedThrough = 0
  const next = () => { passedThrough += 1; return Promise.resolve({ kind: 'allow' }) }
  assert.deepEqual(preExecute[0]({ name: 'ptcSmokeApprovalProbe' }, next), { kind: 'ask', reason: probeReason })
  assert.equal(passedThrough, 0, 'The probe ask did not short-circuit the Host waterfall')
  preExecute[0]({ name: 'someOtherTool' }, next)
  assert.equal(passedThrough, 1, 'The fixture answered for a tool it does not own')
})

test('an armed probe holds the turn until the acceptance releases it', async () => {
  const { service, adapter } = fixtureHost()
  assert.ok(service !== undefined && adapter !== undefined, 'The fixture registered no service or adapter')
  await service.invoke('probe/arm', {})
  assert.deepEqual(await service.invoke('probe/status', {}), { ok: true, value: { armed: 1, holding: 0 } })
  const iterator = adapter.stream(probeMessage(`Approval probe ${probeMarker}`))
  const first = iterator.next()
  let answered = false
  void first.then(() => { answered = true })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(answered, false, 'The armed probe answered before the acceptance released it')
  assert.equal((await service.invoke('probe/status', {})).value.holding, 1)
  await service.invoke('probe/release', {})
  const blocks = []
  for (let result = await first; result.done !== true; result = await iterator.next()) blocks.push(result.value)
  const call = blocks.find(block => block.type === 'block-end' && block.block?.name === 'run_code')
  assert.ok(call !== undefined, 'The released probe emitted no run_code call')
  assert.match(call.block.arguments, /tools\.ptcSmokeApprovalProbe/,
    'The probe program does not dispatch the Host tool the approval seam answers for')
  assert.equal((await service.invoke('probe/status', {})).value.holding, 0)
})

test('an unarmed probe marker leaves the deterministic answer untouched', async () => {
  const { adapter } = fixtureHost()
  const blocks = []
  for await (const block of adapter.stream(probeMessage(`Approval probe ${probeMarker}`))) blocks.push(block)
  assert.equal(blocks.some(block => block.type === 'block-end' && block.block?.type === 'tool-call'), false,
    'An unarmed probe marker produced a programmatic tool call')
  assert.equal(blocks.some(block => block.type === 'text-delta'), true,
    'The unarmed probe marker did not fall through to the deterministic answer')
})
