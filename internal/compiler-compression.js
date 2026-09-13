import { deflateSync, inflateSync } from 'fflate/browser'

/** Callable catalog blocks retain the raw DEFLATE wire format. The private
 * compiler owns the library's JavaScript globals and typed-array operations. */
export const deflateRawSync = input => Buffer.from(deflateSync(input))

export function inflateRawSync(input, { maxOutputLength } = {}) {
  const output = maxOutputLength === undefined ? undefined : new Uint8Array(maxOutputLength + 1)
  const result = inflateSync(input, { out: output })
  if (output !== undefined && result.length > maxOutputLength) throw new RangeError('callable source block exceeds its declared limit')
  return Buffer.from(result)
}
