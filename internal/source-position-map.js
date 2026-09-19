import { TraceMap, decodedMappings } from '@jridgewell/trace-mapping'

export const SOURCE_MAP_RUNS = Symbol.for('ptc.compiler.source-map-runs')

export class SourceMapRuns {
  constructor(data) { this.data = data; this.length = data.length / 4; this[SOURCE_MAP_RUNS] = true }
  at(index) {
    if (index < 0) index += this.length
    if (index < 0 || index >= this.length) return undefined
    const offset = index * 4
    return { generatedStart: this.data[offset], generatedEnd: this.data[offset + 1],
      originalStart: this.data[offset + 2], originalEnd: this.data[offset + 3] }
  }
  *[Symbol.iterator]() { for (let index = 0; index < this.length; index++) yield this.at(index) }
}

const isSourceMap = value => Array.isArray(value) || value instanceof SourceMapRuns

const validMappingOffset = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

/** Numeric mapping runs avoid retaining an object for every copied token. */
export function createSourceMapBuilder() {
  const blocks = []
  const blockLength = 4096
  let size = 0
  // Positional writes keep the hot mapping paths from allocating a segment
  // object that is immediately taken apart again.
  const pushValues = (generatedStart, generatedEnd, originalStart, originalEnd) => {
    if (!validMappingOffset(generatedStart) || !validMappingOffset(generatedEnd)
      || !validMappingOffset(originalStart) || !validMappingOffset(originalEnd)) {
      throw new RangeError('source mapping offsets must fit a source buffer')
    }
    if (size % blockLength === 0) blocks.push(new Uint32Array(blockLength))
    const block = blocks.at(-1), offset = size % blockLength
    block[offset] = generatedStart
    block[offset + 1] = generatedEnd
    block[offset + 2] = originalStart
    block[offset + 3] = originalEnd
    size += 4
  }
  return {
    push({ generatedStart, generatedEnd, originalStart, originalEnd }) {
      pushValues(generatedStart, generatedEnd, originalStart, originalEnd)
    },
    pushValues,
    finish(compact = false) {
      const data = new Uint32Array(size)
      for (let index = 0; index < blocks.length; index++) {
        data.set(blocks[index].subarray(0, Math.min(blockLength, size - index * blockLength)), index * blockLength)
      }
      const runs = new SourceMapRuns(data)
      return !compact && runs.length < 4096 ? [...runs] : runs
    },
  }
}

export function identitySourceMap(length) {
  return [{ generatedStart: 0, generatedEnd: length, originalStart: 0, originalEnd: length }]
}

/** Build generated text while making every copied source range explicit. */
export function createMappedTextBuilder(source, sourceOffset = 0) {
  if (typeof source !== 'string' || !Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
    throw new TypeError('mapped text source and offset must be valid')
  }
  let text = ''
  const mappings = []
  const append = (value) => {
    if (typeof value !== 'string') throw new TypeError('mapped text must be a string')
    text += value
  }
  const appendMapped = (value, originalStart, originalEnd) => {
    if (typeof value !== 'string' || !Number.isSafeInteger(originalStart)
      || !Number.isSafeInteger(originalEnd) || originalStart < sourceOffset
      || originalEnd < originalStart || originalEnd > sourceOffset + source.length) {
      throw new RangeError('mapped text range must be bounded by its source')
    }
    const generatedStart = text.length
    text += value
    if (value.length > 0) {
      mappings.push({
        generatedStart,
        generatedEnd: text.length,
        originalStart: originalStart - sourceOffset,
        originalEnd: originalEnd - sourceOffset,
      })
    }
  }
  return {
    append,
    appendMapped,
    appendSource(start, end) {
      appendMapped(source.slice(start - sourceOffset, end - sourceOffset), start, end)
    },
    result() {
      return { text, mappings }
    },
  }
}

function segmentIndexAt(sourceMap, generatedOffset) {
  let low = 0
  let high = sourceMap.length
  const packed = sourceMap instanceof SourceMapRuns ? sourceMap.data : undefined
  while (low < high) {
    const middle = (low + high) >>> 1
    const end = packed === undefined ? sourceMap.at(middle).generatedEnd : packed[middle * 4 + 1]
    if (generatedOffset < end) high = middle
    else low = middle + 1
  }
  return low
}

export function sourceOffsetAt(sourceMap, generatedOffset) {
  const segment = sourceMap.at(segmentIndexAt(sourceMap, generatedOffset)) ?? sourceMap.at(-1)
  if (segment === undefined) return generatedOffset
  return segmentOffsetAt(segment, generatedOffset)
}

/** Whether a complete generated interval still contains its exact original text. */
export function sourceRangeHasOriginalText(sourceMap, generatedSource, originalSource, generatedStart, generatedEnd) {
  if (typeof generatedSource !== 'string' || typeof originalSource !== 'string'
    || generatedEnd <= generatedStart || generatedStart < 0 || generatedEnd > generatedSource.length) return false
  let cursor = generatedStart
  for (let index = segmentIndexAt(sourceMap, generatedStart); index < sourceMap.length && cursor < generatedEnd; index += 1) {
    const segment = sourceMap.at(index)
    if (segment.generatedStart > cursor || segment.generatedEnd <= cursor) break
    const end = Math.min(generatedEnd, segment.generatedEnd)
    const length = end - cursor
    const originalStart = segmentOffsetAt(segment, cursor)
    if (segment.originalEnd <= segment.originalStart
      || originalStart + length > originalSource.length
      || generatedSource.slice(cursor, end) !== originalSource.slice(originalStart, originalStart + length)) return false
    cursor = end
  }
  return cursor === generatedEnd
}

function segmentOffsetAt(segment, generatedOffset) {
  const generatedLength = segment.generatedEnd - segment.generatedStart
  const originalLength = segment.originalEnd - segment.originalStart
  const localOffset = Math.max(0, generatedOffset - segment.generatedStart)
  if (localOffset >= generatedLength) return segment.originalEnd
  if (generatedLength === originalLength) return segment.originalStart + localOffset
  if (generatedLength <= 1 || originalLength <= 1) return segment.originalStart
  return segment.originalStart
    + Math.floor((localOffset * (originalLength - 1)) / (generatedLength - 1))
}

/** A copied interval is already bounded by this segment. Its endpoints need
 * no additional search through the complete source map. */
function copiedSegmentOriginal(segment, start, end) {
  return [segmentOffsetAt(segment, start),
    segmentOffsetAt(segment, end - 1) + (segment.originalEnd > segment.originalStart ? 1 : 0)]
}

function mappedOffsetRange(sourceMap, start, end) {
  const lastOffset = Math.max(start, end - 1)
  const last = sourceMap.at(segmentIndexAt(sourceMap, lastOffset)) ?? sourceMap.at(-1)
  const hasSourceCharacter = last === undefined || lastOffset < last.generatedEnd && last.originalEnd > last.originalStart
  const originalLast = last === undefined ? lastOffset : segmentOffsetAt(last, lastOffset)
  return {
    originalStart: start === lastOffset ? originalLast : sourceOffsetAt(sourceMap, start),
    originalEnd: originalLast + (end > start && hasSourceCharacter ? 1 : 0),
  }
}

/** Replacement runs reach the mapping builder as positional writes. The
 * generator this replaced allocated a segment object for every emitted run. */
function emitReplacementSegments(sourceMap, start, end, replacementLength, mappings, emit) {
  const { originalStart: startOriginal, originalEnd: endOriginal } = mappedOffsetRange(sourceMap, start, end)
  if (!isSourceMap(mappings) || mappings.length === 0) {
    if (replacementLength !== 0) emit(start, start + replacementLength, startOriginal, endOriginal)
    return
  }
  let cursor = 0
  let anchorOffset = start
  for (const mapping of mappings) {
    if (mapping.generatedStart > cursor) {
      const nextAnchor = sourceOffsetAt(sourceMap, mapping.originalStart)
      emit(start + cursor, start + mapping.generatedStart, nextAnchor, nextAnchor)
    }
    if (mapping.generatedEnd - mapping.generatedStart === mapping.originalEnd - mapping.originalStart
      && mapping.originalEnd > mapping.originalStart) {
      // A verbatim copy retains every previous boundary, including inserted
      // compiler text. Collapsing its endpoints would interpolate that text
      // into source positions and corrupt later call/write provenance.
      for (let index = segmentIndexAt(sourceMap, mapping.originalStart); index < sourceMap.length; index++) {
        const segment = sourceMap.at(index)
        if (segment.generatedStart >= mapping.originalEnd) break
        const from = Math.max(mapping.originalStart, segment.generatedStart)
        const to = Math.min(mapping.originalEnd, segment.generatedEnd)
        const [originalStart, originalEnd] = copiedSegmentOriginal(segment, from, to)
        emit(start + mapping.generatedStart + from - mapping.originalStart,
          start + mapping.generatedStart + to - mapping.originalStart, originalStart, originalEnd)
      }
    } else {
      const { originalStart, originalEnd } = mappedOffsetRange(sourceMap, mapping.originalStart, mapping.originalEnd)
      emit(start + mapping.generatedStart, start + mapping.generatedEnd, originalStart, originalEnd)
    }
    cursor = mapping.generatedEnd
    anchorOffset = mapping.originalEnd
  }
  if (cursor < replacementLength) {
    const anchor = sourceOffsetAt(sourceMap, anchorOffset)
    emit(start + cursor, start + replacementLength, anchor, anchor)
  }
}

export function applySourceEdits(code, sourceMap, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return { code, sourceMap }
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end)
  const normalized = []
  let previousEnd = 0
  let previous
  for (const item of ordered) {
    const text = item.text ?? ''
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
      || item.start < 0 || item.end < item.start || item.end > code.length
      || item.start < previousEnd || typeof text !== 'string'
      || (item.mappings !== undefined && !isSourceMap(item.mappings))
      || (item.start === item.end && previous?.start === item.start && previous.end === item.end)) {
      throw new RangeError('source edits must be bounded, ordered, and non-overlapping')
    }
    const itemMappings = item.mappings instanceof SourceMapRuns ? item.mappings
      : [...(item.mappings ?? [])].sort((left, right) => left.generatedStart - right.generatedStart)
    let mappingEnd = 0
    for (const mapping of itemMappings) {
      if (!Number.isSafeInteger(mapping.generatedStart) || !Number.isSafeInteger(mapping.generatedEnd)
        || !Number.isSafeInteger(mapping.originalStart) || !Number.isSafeInteger(mapping.originalEnd)
        || mapping.generatedStart < mappingEnd || mapping.generatedEnd < mapping.generatedStart
        || mapping.generatedEnd > text.length || mapping.originalStart < 0
        || mapping.originalEnd < mapping.originalStart || mapping.originalEnd > code.length) {
        throw new RangeError('source edit mappings must be bounded and non-overlapping')
      }
      mappingEnd = mapping.generatedEnd
    }
    normalized.push({ ...item, text, mappings: itemMappings })
    previousEnd = item.end
    previous = item
  }

  const chunks = []
  const mappings = createSourceMapBuilder()
  let generatedOffset = 0
  let sourceOffset = 0
  let segmentIndex = 0
  const appendUnchanged = end => {
    if (end <= sourceOffset) return
    chunks.push(code.slice(sourceOffset, end))
    while (segmentIndex < sourceMap.length && sourceMap.at(segmentIndex).generatedEnd <= sourceOffset) segmentIndex += 1
    for (let index = segmentIndex; index < sourceMap.length; index += 1) {
      const segment = sourceMap.at(index)
      if (segment.generatedStart >= end) break
      const start = Math.max(sourceOffset, segment.generatedStart)
      const stop = Math.min(end, segment.generatedEnd)
      if (stop <= start) continue
      const [originalStart, originalEnd] = copiedSegmentOriginal(segment, start, stop)
      mappings.pushValues(generatedOffset + start - sourceOffset, generatedOffset + stop - sourceOffset,
        originalStart, originalEnd)
    }
    generatedOffset += end - sourceOffset
    sourceOffset = end
  }

  for (const item of normalized) {
    appendUnchanged(item.start)
    const { text } = item
    chunks.push(text)
    emitReplacementSegments(sourceMap, item.start, item.end, text.length, item.mappings,
      (generatedStart, generatedEnd, originalStart, originalEnd) => mappings.pushValues(
        generatedStart - item.start + generatedOffset, generatedEnd - item.start + generatedOffset,
        originalStart, originalEnd))
    generatedOffset += text.length
    sourceOffset = item.end
  }
  appendUnchanged(code.length)
  return { code: chunks.join(''), sourceMap: mappings.finish() }
}

const LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/gu

/** JavaScript source coordinates count CRLF as one line boundary. */
export function sourceLineStarts(source) {
  const starts = [0]
  for (const match of source.matchAll(LINE_TERMINATORS)) starts.push(match.index + match[0].length)
  return starts
}

/** Visit maintained emitter coordinates without re-encoding available raw maps.
 * All line numbers at this boundary are zero-based; absent origins stay absent. */
export function visitSourceMappings(transformed, visit) {
  const raw = transformed.rawMappings
  if (raw !== undefined) {
    for (const item of raw) visit(item.generated.line - 1, item.generated.column,
      item.original === undefined ? undefined : item.original.line - 1, item.original?.column)
    return
  }
  const nativeMap = new TraceMap(typeof transformed.map === 'string' ? JSON.parse(transformed.map) : transformed.map)
  for (const [line, entries] of decodedMappings(nativeMap).entries()) {
    for (const entry of entries) visit(line, entry[0], entry[2], entry[3])
  }
}

/** Compose a parser's line/column map with the existing source-offset map. */
export function mappedSourceTransform(code, sourceMap, transformed) {
  const starts = sourceLineStarts(code)
  const generatedStarts = sourceLineStarts(transformed.code)
  const mappings = createSourceMapBuilder()
  let previous
  visitSourceMappings(transformed, (line, column, originalLine, originalColumn) => {
    const generatedStart = Math.min(transformed.code.length, generatedStarts[line] + column)
    if (previous !== undefined) {
      previous.generatedEnd = generatedStart
      mappings.push(previous)
    }
    if (starts[originalLine] === undefined) {
      previous = undefined
      return
    }
    const originalStart = Math.min(code.length, starts[originalLine] + originalColumn)
    previous = { generatedStart, generatedEnd: transformed.code.length,
      originalStart, originalEnd: Math.min(code.length, originalStart + 1) }
  })
  if (previous !== undefined) mappings.push(previous)
  return applySourceEdits(code, sourceMap, [{ start: 0, end: code.length, text: transformed.code, mappings: mappings.finish(true) }])
}

function lineStartOffset(source, line, starts) {
  return starts[line - 1] ?? source.length
}

function positionAtOffset(source, offset, starts) {
  let low = 0, high = starts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (starts[middle] <= offset) low = middle + 1
    else high = middle
  }
  const line = low - 1
  return { line: line + 1, column: offset - starts[line] + 1 }
}

const coordinateIndexes = new WeakMap()
function coordinateIndex(sourceMap, generatedSource, originalSource) {
  let index = coordinateIndexes.get(sourceMap)
  if (index?.generatedSource !== generatedSource || index.originalSource !== originalSource) {
    index = { generatedSource, originalSource, generatedStarts: sourceLineStarts(generatedSource),
      originalStarts: sourceLineStarts(originalSource) }
    coordinateIndexes.set(sourceMap, index)
  }
  return index
}

export function sourceTextAtSpan(source, span, starts = sourceLineStarts(source)) {
  return source.slice(lineStartOffset(source, span.line, starts) + span.column - 1,
    lineStartOffset(source, span.end.line, starts) + span.end.column - 1)
}

export function mapSourcePosition(position, generatedSource, originalSource, sourceMap, coordinates) {
  if (position === undefined || sourceMap === undefined) return position
  if (!Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1) return position
  const index = coordinates ?? coordinateIndex(sourceMap, generatedSource, originalSource)
  const lineStart = lineStartOffset(generatedSource, position.line, index.generatedStarts)
  const mappedOffset = sourceOffsetAt(sourceMap, lineStart + position.column - 1)
  return positionAtOffset(originalSource, mappedOffset, index.originalStarts)
}

/** Map a complete generated-source span into original cell coordinates. */
export function mapSourceSpan(span, generatedSource, originalSource, sourceMap, coordinates) {
  if (span === undefined) return undefined
  const start = mapSourcePosition(span, generatedSource, originalSource, sourceMap, coordinates)
  if (span.end === undefined) return start === span ? span : start
  if (!Number.isSafeInteger(span.end.line) || span.end.line < 1
    || !Number.isSafeInteger(span.end.column) || span.end.column < 1) {
    return { ...start, end: span.end }
  }
  const index = coordinates ?? coordinateIndex(sourceMap, generatedSource, originalSource)
  const generatedEnd = lineStartOffset(generatedSource, span.end.line, index.generatedStarts) + span.end.column - 1
  const original = mappedOffsetRange(sourceMap, Math.max(0, generatedEnd - 1), generatedEnd)
  return { ...start, end: positionAtOffset(originalSource, original.originalEnd, index.originalStarts) }
}
