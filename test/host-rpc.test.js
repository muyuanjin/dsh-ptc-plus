import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { createHostRpc } from '../internal/host-rpc.js'
import { RPC_CONTRACTS, rpcDescriptor } from '../internal/rpc-contract.js'

async function fixture(t, late = false) {
  const ctx = new Context()
  const fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  const mount = async plugin => { const fiber = ctx.plugin(plugin); fibers.push(fiber); await fiber; return fiber }
  // One owner Peer: the Host's own invocations answer without a remote-access decision, and
  // the Peer's signal is the lifetime a disposed caller closes.
  const lifetime = new AbortController()
  const peer = { principal: { kind: 'owner', id: 'host-rpc-test' }, signal: lifetime.signal }
  let registry = late ? undefined : await mount(TypertRegistry)
  // The Gateway admits non-owner Peers through the deployment's remote-access policy; this
  // fixture's own Peer is the Host, so the policy never answers for it.
  await mount({ apply(scope) { scope.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) }) } })
  await mount(TypertGatewayService)
  let owner
  await mount({ apply(scope) { owner = createHostRpc(scope); scope.effect(() => () => owner.dispose()) } })
  let port
  const consumer = await mount({ inject: ['ptcPlusRpc'], apply(scope) { port = scope.ptcPlusRpc } })
  const call = (contract, operation, payload = {}, signal = new AbortController().signal) =>
    ctx.typertGateway.invoke({ namespace: contract.service, method: 'invoke',
      args: { operation, payload }, peer, signal })
  return { ctx, mount, owner, consumer, get port() { return port },
    async removeRegistry() { await registry.dispose(); registry = undefined },
    async addRegistry() { registry = await mount(TypertRegistry) },
    call,
    async closePeer() { lifetime.abort() },
  }
}

test('Remote wire uses the shared Gateway and preserves literal payloads, errors and cancellation', async t => {
  const target = await fixture(t)
  let calls = 0
  const release = target.port.register(RPC_CONTRACTS.bindings, async (operation, payload, signal) => {
    calls++
    if (operation === 'wait') return new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ ok: true, value: null }), { once: true })
    })
    if (operation === 'fail') return { ok: false, error: { code: 'binding/conflict', message: 'Reload', details: { revision: 2 } } }
    return { ok: true, value: payload }
  })
  const payload = { text: '{{literal}}', entries: [1, null, { enabled: false }], empty: {} }
  assert.deepEqual(await target.call(RPC_CONTRACTS.bindings, 'list', payload), { ok: true, value: payload })
  assert.deepEqual((await target.call(RPC_CONTRACTS.bindings, 'fail')).error.details, { revision: 2 })
  await assert.rejects(target.call(RPC_CONTRACTS.bindings, 42))
  assert.equal(calls, 2)
  const controller = new AbortController()
  const waiting = target.call(RPC_CONTRACTS.bindings, 'wait', {}, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await waiting
  assert.equal(calls, 3)
  const service = target.ctx.get(RPC_CONTRACTS.bindings.service)
  const pending = service.invoke('wait', {}, new AbortController().signal)
  await release()
  await pending
  assert.equal(target.ctx.get(RPC_CONTRACTS.bindings.service), undefined)
  assert.equal(target.ctx.typert.get(`${RPC_CONTRACTS.bindings.service}/invoke`), undefined)
  assert.throws(() => service.invoke('list', {}, new AbortController().signal), /abort/i)
  await assert.rejects(target.call(RPC_CONTRACTS.bindings, 'list'))
  await release()
})

test('feature registrations share one contribution and withdrawal cannot revive an old service', async t => {
  const target = await fixture(t)
  const handler = async () => ({ ok: true, value: null })
  const bindings = target.port.register(RPC_CONTRACTS.bindings, handler)
  const repl = target.port.register(RPC_CONTRACTS.repl, handler)
  assert.equal(target.ctx.typert.listPackages({ package: 'dsh-ptc-plus' }).length, 1)
  assert.throws(() => target.port.register(RPC_CONTRACTS.bindings, handler), /already registered/)
  await bindings()
  assert.equal((await target.call(RPC_CONTRACTS.repl, 'observe')).ok, true)
  const restored = target.port.register(RPC_CONTRACTS.bindings, handler)
  assert.equal((await target.call(RPC_CONTRACTS.bindings, 'list')).ok, true)
  await restored()
  await repl()
  assert.equal(target.ctx.typert.getPackage('dsh-ptc-plus'), undefined)
  await target.owner.dispose()
  assert.throws(() => target.port.register(RPC_CONTRACTS.repl, handler), /disposed/)
})

test('provider withdrawal aborts pending calls and replacement republishes active features', async t => {
  const target = await fixture(t, true)
  assert.equal(target.port, undefined)
  await target.addRegistry()
  await new Promise(resolve => setImmediate(resolve))
  let observed
  target.port.register(RPC_CONTRACTS.repl, async (_operation, _payload, signal) => {
    observed = signal
    return { ok: true, value: null }
  })
  const service = target.ctx.get(RPC_CONTRACTS.repl.service)
  await target.call(RPC_CONTRACTS.repl, 'watch')
  await target.removeRegistry()
  assert.equal(observed.aborted, true)
  assert.throws(() => service.invoke('watch', {}, new AbortController().signal), /provider is unavailable/)
  await target.addRegistry()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await target.call(RPC_CONTRACTS.repl, 'watch')).ok, true)
  await target.owner.dispose()
  assert.equal(observed.aborted, true)
  assert.equal(target.ctx.get(RPC_CONTRACTS.repl.service), undefined)
})

test('shared codecs reject malformed envelopes and preserve the existing business result shape', () => {
  const descriptor = rpcDescriptor(RPC_CONTRACTS.bindings)
  for (const parse of [descriptor.result.schema.parse, descriptor.result.create().parse]) {
    for (const bad of [null, {}, { ok: 'true' }, { ok: false, error: {} }]) assert.throws(() => parse(bad))
    assert.deepEqual(parse({ ok: true }), { ok: true })
    assert.deepEqual(parse({ ok: true, value: null }), { ok: true, value: null })
  }
})

test('strict codecs carry the executable decoder in both TYPERT generations', () => {
  for (const contract of Object.values(RPC_CONTRACTS)) {
    const descriptor = rpcDescriptor(contract)
    for (const [subject, codec] of [
      ...descriptor.parameters.map(parameter => [`${parameter.name} parameter`, parameter.codec]),
      ['result', descriptor.result],
    ]) {
      assert.equal(codec.mode, 'strict', subject)
      assert.equal(typeof codec.typeSymbol, 'string', subject)
      // The preceding generation evaluates the decoder reached through `schema`.
      assert.equal(typeof codec.schema.parse, 'function', subject)
      // The current generation validates `create` and evaluates `create().parse`.
      assert.equal(typeof codec.create, 'function', subject)
      assert.equal(codec.create(), codec.schema, subject)
    }
  }
})


test('Cordis consumers release and remount their operations when the provider is replaced', async t => {
  const target = await fixture(t)
  let starts = 0
  let priorSignal
  await target.mount({ inject: ['ptcPlusRpc'], apply(scope) {
    starts++
    scope.effect(() => scope.ptcPlusRpc.register(RPC_CONTRACTS.bindings, async (_operation, _payload, signal) => {
      priorSignal = signal
      return { ok: true, value: starts }
    }))
  } })
  assert.equal((await target.call(RPC_CONTRACTS.bindings, 'list')).value, 1)
  await target.removeRegistry()
  assert.equal(priorSignal.aborted, true)
  assert.equal(target.ctx.get(RPC_CONTRACTS.bindings.service), undefined)
  await target.addRegistry()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await target.call(RPC_CONTRACTS.bindings, 'list')).value, 2)
})

test('failed publication rolls back the service and permits a later registration', async t => {
  const target = await fixture(t)
  const release = target.ctx.typert.register({ package: 'dsh-ptc-plus', face: 'host',
    schemas: [], model: { services: [], events: [], objects: [] }, invocations: [] })
  assert.throws(() => target.port.register(RPC_CONTRACTS.bindings, async () => ({ ok: true })), /already registered/)
  assert.equal(target.ctx.get(RPC_CONTRACTS.bindings.service), undefined)
  await release()
  target.port.register(RPC_CONTRACTS.bindings, async () => ({ ok: true, value: 1 }))
  assert.equal((await target.call(RPC_CONTRACTS.bindings, 'list')).value, 1)
})
