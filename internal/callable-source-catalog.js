import { hashText, inflateText } from './compiler-service.js'
import { moduleCompilerIntrinsics, moduleRuntimeIntrinsics as internal } from './compiler-intrinsics.js'
import { CALLABLE_SOURCE_FORMAT as FORMAT, CALLABLE_SOURCE_BLOCK_UNITS as BLOCK_UNITS } from './callable-source-format.js'

export { createCallableSourceCatalog } from './compiler-service.js'

const CACHED_BLOCKS = 8
const sourceKey = source => `${source.length}:${hashText(source, 'utf16le', 'base64')}`

function catalogKey(catalog) {
  let text = ''
  for (let index = 0; index < catalog.buffers.length; index++) {
    const buffer = catalog.buffers[index]
    text += `${buffer.length}:`
    for (let block = 0; block < buffer.blocks.length; block++) {
      text += `${buffer.blocks[block]};`
    }
  }
  for (let index = 0; index < catalog.entries.length; index++) {
    const entry = catalog.entries[index]
    for (let item = 0; item < entry.length; item++) text += `${entry[item]}:`
    text += ';'
  }
  return hashText(text)
}

function sameCatalog(left, right) {
  if (left.buffers.length !== right.buffers.length || left.entries.length !== right.entries.length) return false
  for (let index = 0; index < left.buffers.length; index++) {
    const a = left.buffers[index], b = right.buffers[index]
    if (a.length !== b.length || a.blocks.length !== b.blocks.length) return false
    for (let block = 0; block < a.blocks.length; block++) if (a.blocks[block] !== b.blocks[block]) return false
  }
  for (let index = 0; index < left.entries.length; index++) {
    const a = left.entries[index], b = right.entries[index]
    if (a.length !== b.length) return false
    for (let item = 0; item < a.length; item++) if (a[item] !== b[item]) return false
  }
  return true
}

/** Digests select candidates; only an exact native-source comparison owns reflection. */
export function createCallableSourceRegistry() {
  const literals = new internal.Map()
  const catalogs = new internal.Map()
  const candidates = new internal.Map()
  const decoded = new internal.Map()
  let ordinal = 0
  const blockText = encoded => {
    let text = internal.mapGet(decoded, encoded)
    if (text === undefined) {
      text = inflateText(encoded, BLOCK_UNITS * 2)
      internal.mapSet(decoded, encoded, text)
      if (internal.mapSize(decoded) > CACHED_BLOCKS) internal.mapDelete(decoded, internal.mapFirstKey(decoded))
    }
    return text
  }
  const visitParts = (catalog, bufferIndex, start, end, visit) => {
    const buffer = catalog.buffers[bufferIndex]
    while (start < end) {
      const index = internal.floor(start / BLOCK_UNITS)
      const offset = start % BLOCK_UNITS
      const length = internal.min(end - start, BLOCK_UNITS - offset)
      if (visit(internal.sliceString(blockText(buffer.blocks[index]), offset, offset + length)) === false) return false
      start += length
    }
  }
  const matches = (catalog, entry, native) => {
    let offset = 0
    const complete = visitParts(catalog, entry[0], entry[1], entry[2], text => {
      if (!internal.startsWith(native, text, offset)) return false
      offset += text.length
    })
    return complete !== false && offset === native.length
  }
  return {
    register(sources) {
      const current = ++ordinal
      if (internal.isArray(sources)) {
        for (let index = 0; index < sources.length; index++) {
          const entry = sources[index]
          internal.mapSet(literals, entry[0], { original: entry[1], ordinal: current })
        }
        return
      }
      if (sources.format !== FORMAT) throw new moduleCompilerIntrinsics.TypeError('unsupported callable source catalog')
      const key = catalogKey(sources)
      let bucket = internal.mapGet(catalogs, key)
      if (bucket === undefined) internal.mapSet(catalogs, key, bucket = [])
      for (let index = 0; index < bucket.length; index++) {
        const registration = bucket[index]
        if (!sameCatalog(registration.catalog, sources)) continue
        registration.ordinal = current
        return
      }
      // Compiler transport values may be reused by their caller. Snapshot the
      // compressed facts without retaining caller-owned mutable containers.
      const catalog = { buffers: [], entries: [] }
      for (let index = 0; index < sources.buffers.length; index++) {
        const buffer = sources.buffers[index]
        internal.appendArray(catalog.buffers, { length: buffer.length, blocks: internal.copyArray(buffer.blocks) })
      }
      for (let index = 0; index < sources.entries.length; index++) internal.appendArray(catalog.entries, internal.copyArray(sources.entries[index]))
      const registration = { catalog, ordinal: current }
      internal.appendArray(bucket, registration)
      for (let index = 0; index < catalog.entries.length; index++) {
        const entry = catalog.entries[index]
        let entries = internal.mapGet(candidates, entry[6])
        if (entries === undefined) internal.mapSet(candidates, entry[6], entries = [])
        internal.appendArray(entries, { registration, entry })
      }
    },
    get(native) {
      let found = internal.mapGet(literals, native)
      const entries = internal.mapGet(candidates, sourceKey(native))
      if (entries !== undefined) for (let index = 0; index < entries.length; index++) {
        const { registration, entry } = entries[index]
        if (found !== undefined && found.ordinal > registration.ordinal) continue
        if (matches(registration.catalog, entry, native)) found = { ...registration, entry }
      }
      if (found === undefined) return undefined
      if (found.original !== undefined) return found.original
      const entry = found.entry
      let original = ''
      visitParts(found.catalog, entry[3], entry[4], entry[5], text => { original += text })
      return original
    },
  }
}
