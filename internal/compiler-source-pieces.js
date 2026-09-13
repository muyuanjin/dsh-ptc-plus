import { createSourceMapBuilder } from './source-position-map.js'

const WIDTH = 6
const BLOCK_SIZE = 4096
const TEXT = 0, COPY = 1, MAPPED = 2, JOIN = 3, REGION = 4

/** A numeric piece graph owns output without one object per copied token. */
export function createSourcePieces(source) {
  const blocks = []
  const strings = []
  const regionFacts = []
  const stringIds = new Map()
  let count = 0
  const get = (id, field) => blocks[Math.floor(id / BLOCK_SIZE)][id % BLOCK_SIZE * WIDTH + field]
  const put = (size, kind, left, right = 0, start = 0, end = 0) => {
    if (count % BLOCK_SIZE === 0) blocks.push(new Uint32Array(BLOCK_SIZE * WIDTH))
    const id = count++
    blocks.at(-1).set([size, kind, left, right, start, end], id % BLOCK_SIZE * WIDTH)
    return id
  }
  const stringId = value => {
    let id = stringIds.get(value)
    if (id === undefined) { id = strings.length; strings.push(value); stringIds.set(value, id) }
    return id
  }
  const length = id => get(id, 0)
  const text = value => put(value.length, TEXT, stringId(value))
  const original = (start, end) => put(end - start, COPY, start, end)
  const mapped = (value, node) => put(value.length, MAPPED, stringId(value), 0, node.start, node.end)
  const region = (piece, fact) => {
    const index = regionFacts.length
    regionFacts.push(fact)
    return put(length(piece), REGION, piece, index)
  }
  const empty = text('')
  const pair = (left, right) => {
    if (length(left) === 0) return right
    if (length(right) === 0) return left
    if (get(left, 1) === COPY && get(right, 1) === COPY && get(left, 3) === get(right, 2)) {
      return original(get(left, 2), get(right, 3))
    }
    return put(length(left) + length(right), JOIN, left, right)
  }
  const join = parts => {
    const combine = (start, end) => end <= start ? empty : end === start + 1 ? parts[start]
      : pair(combine(start, (start + end) >>> 1), combine((start + end) >>> 1, end))
    return combine(0, parts.length)
  }
  const slice = (id, start, end = length(id)) => {
    const size = length(id)
    if (start === 0 && end === size) return id
    const kind = get(id, 1), left = get(id, 2), right = get(id, 3)
    if (kind === REGION) return slice(left, start, end)
    if (kind === JOIN) {
      const split = length(left)
      if (end <= split) return slice(left, start, end)
      if (start >= split) return slice(right, start - split, end - split)
      return pair(slice(left, start), slice(right, 0, end - split))
    }
    if (kind === COPY) return original(left + start, left + end)
    const value = strings[left].slice(start, end)
    if (kind === TEXT) return text(value)
    const from = get(id, 4), to = get(id, 5), linear = to - from === size
    return mapped(value, { start: from + (linear ? start : 0), end: linear ? from + end : to })
  }
  const emit = id => {
    const chunks = []
    let pending = []
    const mappings = createSourceMapBuilder()
    const regions = []
    let offset = 0
    const visit = id => {
      const size = length(id)
      if (size === 0) return
      const kind = get(id, 1), left = get(id, 2), right = get(id, 3)
      if (kind === JOIN) { visit(left); visit(right); return }
      if (kind === REGION) {
        regions.push({ ...regionFacts[right], start: offset, end: offset + size })
        visit(left)
        return
      }
      pending.push(kind === COPY ? source.slice(left, right) : strings[left])
      if (pending.length === BLOCK_SIZE) { chunks.push(pending.join('')); pending = [] }
      if (kind !== TEXT) mappings.push({ generatedStart: offset, generatedEnd: offset + size,
        originalStart: kind === COPY ? left : get(id, 4), originalEnd: kind === COPY ? right : get(id, 5) })
      offset += size
    }
    visit(id)
    chunks.push(pending.join(''))
    return { text: chunks.join(''), mappings: mappings.finish(), regions }
  }
  return { text, original, mapped, join, slice, emit, length, region }
}
