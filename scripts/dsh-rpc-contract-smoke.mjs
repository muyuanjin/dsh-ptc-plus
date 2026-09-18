/**
 * Register PTC Plus's RPC contract with the installed host's own TYPERT registry.
 *
 * The plugin's Remote services are only reachable through descriptors the host
 * accepts: `ctx.typert.register()` validates every strict codec it is handed and
 * rejects the whole batch when a codec does not carry the member that host's
 * generation reads — the preceding generation reads the decoder on `codec.schema`
 * and the current one through `codec.create()`. A registration helper that
 * imports cleanly still fails at run time in the Host and in the browser, so a
 * load check cannot stand in for this one.
 *
 * This runner resolves the contract from the packed package's own module, so it
 * fails when the published descriptors and the installed host disagree, and it
 * evaluates the decoder through the path the installed generation uses.
 *
 * Usage: `node scripts/dsh-rpc-contract-smoke.mjs [plugin-specifier]`, with the
 * working directory set to the consumer installation.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Malformed and well-formed envelopes for the shared business result wire. */
const RESULT_WIRE = Object.freeze({
  accepted: Object.freeze({ ok: true, value: null }),
  rejected: Object.freeze({ ok: 'true' }),
})

async function main() {
  const consumer = process.cwd()
  const pluginSpecifier = process.argv[2] ?? 'dsh-ptc-plus'
  const require = createRequire(join(consumer, 'noop.cjs'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)

  const { Context } = await load('@deepseek-ai/cordis')
  const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry')
  const registryVersion = require('@deepseek-ai/dsh-typert-registry/package.json').version

  // The published contract is part of the packed package; importing it here
  // keeps this check bound to the artifact under test instead of a copy.
  const contractPath = join(dirname(require.resolve(`${pluginSpecifier}/package.json`)), 'internal', 'rpc-contract.js')
  const { RPC_CONTRACTS, rpcDescriptor } = await import(pathToFileURL(contractPath).href)

  const ctx = new Context()
  const registry = new TypertRegistry(ctx)
  const invocations = Object.values(RPC_CONTRACTS).map(rpcDescriptor)
  registry.register({
    package: 'dsh-ptc-plus',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations,
  })

  for (const descriptor of invocations) {
    const codecs = [...descriptor.parameters.map(parameter => parameter.codec), descriptor.result]
    for (const codec of codecs) {
      if (codec.mode !== 'strict' || typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) {
        throw new Error(`dsh-rpc-contract-smoke: ${descriptor.id} published a codec without a strict type symbol`)
      }
      if (typeof codec.create !== 'function' || typeof codec.schema?.parse !== 'function') {
        throw new Error(`dsh-rpc-contract-smoke: ${descriptor.id} published a codec one host generation cannot read`)
      }
      if (codec.create() !== codec.schema) {
        throw new Error(`dsh-rpc-contract-smoke: ${descriptor.id} published two decoders for one wire member`)
      }
    }
    const parse = descriptor.result.create().parse
    if (parse(RESULT_WIRE.accepted).ok !== true) {
      throw new Error(`dsh-rpc-contract-smoke: ${descriptor.id} decoded a valid result envelope into another value`)
    }
    try {
      parse(RESULT_WIRE.rejected)
      throw new Error(`dsh-rpc-contract-smoke: ${descriptor.id} accepted a malformed result envelope`)
    } catch (error) {
      if (/dsh-rpc-contract-smoke/.test(error?.message ?? '')) throw error
    }
  }

  await ctx.fiber.dispose()
  console.log(`registered ${String(invocations.length)} invocation(s) with the installed TYPERT registry ${registryVersion}`)
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
