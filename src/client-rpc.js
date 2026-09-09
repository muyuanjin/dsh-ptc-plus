import { RPC_CONTRACTS, RPC_REMOTE } from '../internal/rpc-contract.js'

/** Mount and consume the shared contract through the Host's public Remote caller. */
export async function createClientRpc(ctx) {
  await ctx.remote.$mount(RPC_REMOTE)
  const services = Object.values(RPC_CONTRACTS).map(({ service }) => `remote.${service}`)
  let scope
  await ctx.inject(services, current => {
    scope = current
    current.effect(() => () => { if (scope === current) scope = undefined })
  })
  return {
    async call(contract, operation, payload, signal) {
      if (scope === undefined) throw new Error('PTC Plus Remote service is unavailable')
      const args = signal === undefined ? [operation, payload] : [operation, payload, signal]
      const result = await scope.remote[contract.service].invoke(...args)
      return result.ok ? result.value : result
    },
  }
}
