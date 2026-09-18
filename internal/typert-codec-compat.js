/**
 * Own the strict codec shape PTC Plus publishes into DSH's TYPERT registry.
 *
 * A strict codec decodes one wire member. DSH changed where the host reads that
 * decoder: the preceding generation keeps it on `codec.schema` and evaluates
 * `codec.schema.parse(value)`, while the current generation keeps a `create()`
 * factory and evaluates `codec.create().parse(value)`. Each generation validates
 * the member it owns and ignores the other, so every codec here publishes both
 * and serves whichever shape the installed host implements — no version gate, no
 * second registration path, and one decoder for both.
 *
 * The decoder is the maintained schema runtime, presented as the `parse` member
 * both generations evaluate. Business payload validation stays with the owner of
 * each RPC contract.
 *
 * @param {object} options - `typeSymbol` names the wire type; `schema` is the
 *   maintained schema the decoder evaluates.
 * @returns {object} a strict codec accepted by either generation.
 */
export function strictCodec({ typeSymbol, schema }) {
  const decoder = { parse: schema }
  return {
    mode: 'strict',
    typeSymbol,
    schema: decoder,
    create: () => decoder,
  }
}
