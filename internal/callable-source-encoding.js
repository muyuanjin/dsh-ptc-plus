import { hashText, deflateText } from './compiler-text.js'
import { CALLABLE_SOURCE_FORMAT as FORMAT, CALLABLE_SOURCE_BLOCK_UNITS as BLOCK_UNITS } from './callable-source-format.js'

/** Keep windows around referenced callables. Neighbors share compression
 * blocks; unrelated large data regions stay outside the reflection catalog. */
export function createCallableSourceCatalog(buffers, ranges) {
  const selected = buffers.map(() => [])
  const entries = ranges.map(range => [...range])
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    for (const offset of [0, 3]) {
      const source = buffers[range[offset]]
      const start = range[offset + 1], end = range[offset + 2]
      if (typeof source !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end < start || end > source.length) throw new TypeError('invalid callable source range')
      selected[range[offset]].push({ start, end, index, offset })
    }
    const source = buffers[range[0]].slice(range[1], range[2])
    entries[index].push(`${source.length}:${hashText(source, 'utf16le', 'base64')}`)
  }
  const encoded = []
  for (let index = 0; index < selected.length; index++) {
    const intervals = []
    for (const item of selected[index].sort((left, right) => left.start - right.start || right.end - left.end)) {
      let interval = intervals.at(-1)
      if (interval === undefined || item.start - interval.end > BLOCK_UNITS) {
        interval = { start: item.start, end: item.end, items: [] }
        intervals.push(interval)
      }
      interval.end = Math.max(interval.end, item.end)
      interval.items.push(item)
    }
    for (const interval of intervals) {
      const source = buffers[index].slice(interval.start, interval.end)
      const blocks = []
      for (let start = 0; start < source.length; start += BLOCK_UNITS) blocks.push(deflateText(source.slice(start, start + BLOCK_UNITS)))
      for (const item of interval.items) {
        const entry = entries[item.index]
        entry[item.offset] = encoded.length
        entry[item.offset + 1] -= interval.start
        entry[item.offset + 2] -= interval.start
      }
      encoded.push({ length: source.length, blocks })
    }
  }
  return { format: FORMAT, length: entries.length, buffers: encoded, entries }
}
