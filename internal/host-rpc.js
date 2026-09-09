import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { rpcDescriptor } from './rpc-contract.js'

/** Own Remote services and the package's Host invocation contribution. */
export function createHostRpc(ctx) {
  const handlers = new Map()
  let provider
  let definition
  let epoch
  let disposed = false
  const publish = () => {
    // Registry withdrawal is synchronous, so replacement has no overlapping endpoints.
    definition?.()
    definition = undefined
    if (provider === undefined || disposed || handlers.size === 0) return
    definition = provider.effect(() => provider.typert.register({
      package: 'dsh-ptc-plus', face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [...handlers.keys()].map(rpcDescriptor),
    }), 'ptc-plus: Remote definitions')
  }
  const port = {
    register(contract, handler) {
      if (disposed) throw new Error('PTC Plus RPC owner is disposed')
      if (handlers.has(contract)) throw new Error(`PTC Plus RPC service ${contract.service} is already registered`)
      const lifetime = new AbortController()
      const service = {
        invoke(operation, payload, signal) {
          lifetime.signal.throwIfAborted()
          if (epoch === undefined) throw new Error('PTC Plus RPC provider is unavailable')
          return handler(operation, payload, AbortSignal.any([signal, lifetime.signal, epoch.signal]))
        },
      }
      service.typertRemote = bindTypertRemote(service, contract.service)
      const release = ctx.effect(function* () {
        yield ctx.provide(contract.service, service)
        handlers.set(contract, { release: () => release() })
        yield () => {
          lifetime.abort()
          handlers.delete(contract)
          publish()
        }
        publish()
      }, 'ptc-plus: Remote service')
      return release
    },
  }
  const injection = ctx.inject?.(['typert'], scope => {
    provider = scope
    epoch = new AbortController()
    publish()
    scope.effect(() => scope.provide('ptcPlusRpc', port), 'ptc-plus: RPC registration port')
    scope.effect(() => () => {
      epoch.abort()
      epoch = undefined
      provider = undefined
      definition = undefined
    }, 'ptc-plus: RPC provider lifetime')
  })
  return { async dispose() {
    disposed = true
    for (const entry of [...handlers.values()]) await entry.release()
    if (typeof injection === 'function') await injection()
    else await injection?.dispose()
  } }
}
