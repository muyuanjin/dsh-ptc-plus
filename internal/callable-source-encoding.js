import { hashText, deflateText } from './compiler-text.js'
import { CALLABLE_SOURCE_FORMAT as FORMAT, CALLABLE_SOURCE_BLOCK_UNITS as BLOCK_UNITS } from './callable-source-format.js'

/** Store shared source buffers once; all ranges use exact UTF-16 offsets. */
export function createCallableSourceCatalog(buffers, ranges) {
  const encoded = []
  for (const source of buffers) {
    const blocks = []
    for (let start = 0; start < source.length; start += BLOCK_UNITS) blocks.push(deflateText(source.slice(start, start + BLOCK_UNITS)))
    encoded.push({ length: source.length, blocks })
  }
  const entries = []
  for (const range of ranges) {
    for (const offset of [0, 3]) {
      const source = buffers[range[offset]]
      const start = range[offset + 1], end = range[offset + 2]
      if (typeof source !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end < start || end > source.length) throw new TypeError('invalid callable source range')
    }
    const source = buffers[range[0]].slice(range[1], range[2])
    entries.push([...range, `${source.length}:${hashText(source, 'utf16le', 'base64')}`])
  }
  return { format: FORMAT, length: entries.length, buffers: encoded, entries }
}
