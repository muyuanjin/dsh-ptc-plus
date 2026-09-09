import Schema from '@deepseek-ai/schemastery'

const resultSchema = Schema.union([
  Schema.object({ ok: Schema.const(true).required(), value: Schema.any() }),
  Schema.object({
    ok: Schema.const(false).required(),
    error: Schema.object({
      code: Schema.string().required(),
      message: Schema.string().required(),
      details: Schema.any().required(),
    }).required(),
  }),
]).required()

/** Shared executable wire definitions; business payload validation stays with each owner. */
export const RPC_CONTRACTS = Object.freeze({
  bindings: Object.freeze({ service: 'ptcPlusBindings' }),
  repl: Object.freeze({ service: 'ptcPlusRepl' }),
})

export function rpcDescriptor({ service }) {
  return {
    id: `dsh-ptc-plus#${service}/invoke`,
    service,
    namespace: service,
    method: 'invoke',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'operation', wire: 'operation', source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-ptc-plus#RpcOperation', schema: { parse: Schema.string().required() } } },
      { name: 'payload', wire: 'payload', source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-ptc-plus#RpcPayload', schema: { parse: Schema.any() } } },
    ],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-ptc-plus#RpcResult', schema: { parse: resultSchema } },
  }
}

export const RPC_REMOTE = Object.freeze({
  package: 'dsh-ptc-plus',
  descriptors: Object.values(RPC_CONTRACTS).map(rpcDescriptor),
})
