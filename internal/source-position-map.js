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

function originalOffsetAt(sourceMap, generatedOffset) {
  let low = 0
  let high = sourceMap.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (generatedOffset < sourceMap[middle].generatedEnd) high = middle
    else low = middle + 1
  }
  const segment = sourceMap[low] ?? sourceMap.at(-1)
  if (segment === undefined) return generatedOffset
  const generatedLength = segment.generatedEnd - segment.generatedStart
  const originalLength = segment.originalEnd - segment.originalStart
  const localOffset = Math.max(0, generatedOffset - segment.generatedStart)
  if (localOffset >= generatedLength) return segment.originalEnd
  if (generatedLength === originalLength) return segment.originalStart + localOffset
  if (generatedLength <= 1 || originalLength <= 1) return segment.originalStart
  return segment.originalStart
    + Math.floor((localOffset * (originalLength - 1)) / (generatedLength - 1))
}

function mappedOffsetRange(sourceMap, start, end) {
  return {
    originalStart: originalOffsetAt(sourceMap, start),
    originalEnd: originalOffsetAt(sourceMap, Math.max(start, end - 1)) + (end > start ? 1 : 0),
  }
}

function replacementSegments(sourceMap, start, end, replacementLength, mappings) {
  const { originalStart: startOriginal, originalEnd: endOriginal } = mappedOffsetRange(sourceMap, start, end)
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return replacementLength === 0 ? [] : [{
      generatedStart: start,
      generatedEnd: start + replacementLength,
      originalStart: startOriginal,
      originalEnd: endOriginal,
    }]
  }
  const segments = []
  let cursor = 0
  for (const mapping of mappings) {
    if (mapping.generatedStart > cursor) {
      segments.push({
        generatedStart: start + cursor,
        generatedEnd: start + mapping.generatedStart,
        originalStart: startOriginal,
        originalEnd: endOriginal,
      })
    }
    const original = mappedOffsetRange(sourceMap, mapping.originalStart, mapping.originalEnd)
    segments.push({
      generatedStart: start + mapping.generatedStart,
      generatedEnd: start + mapping.generatedEnd,
      ...original,
    })
    cursor = mapping.generatedEnd
  }
  if (cursor < replacementLength) {
    segments.push({
      generatedStart: start + cursor,
      generatedEnd: start + replacementLength,
      originalStart: startOriginal,
      originalEnd: endOriginal,
    })
  }
  return segments
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
      || (item.mappings !== undefined && !Array.isArray(item.mappings))
      || (item.start === item.end && previous?.start === item.start && previous.end === item.end)) {
      throw new RangeError('source edits must be bounded, ordered, and non-overlapping')
    }
    const itemMappings = [...(item.mappings ?? [])]
      .sort((left, right) => left.generatedStart - right.generatedStart)
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
  const mappings = []
  let generatedOffset = 0
  let sourceOffset = 0
  let segmentIndex = 0
  const appendUnchanged = end => {
    if (end <= sourceOffset) return
    chunks.push(code.slice(sourceOffset, end))
    while (segmentIndex < sourceMap.length && sourceMap[segmentIndex].generatedEnd <= sourceOffset) segmentIndex += 1
    for (let index = segmentIndex; index < sourceMap.length; index += 1) {
      const segment = sourceMap[index]
      if (segment.generatedStart >= end) break
      const start = Math.max(sourceOffset, segment.generatedStart)
      const stop = Math.min(end, segment.generatedEnd)
      if (stop <= start) continue
      const { originalStart, originalEnd } = mappedOffsetRange(sourceMap, start, stop)
      mappings.push({
        generatedStart: generatedOffset + start - sourceOffset,
        generatedEnd: generatedOffset + stop - sourceOffset,
        originalStart,
        originalEnd,
      })
    }
    generatedOffset += end - sourceOffset
    sourceOffset = end
  }

  for (const item of normalized) {
    appendUnchanged(item.start)
    const { text } = item
    chunks.push(text)
    mappings.push(...replacementSegments(sourceMap, item.start, item.end, text.length, item.mappings)
      .map(segment => ({ ...segment, generatedStart: segment.generatedStart - item.start + generatedOffset,
        generatedEnd: segment.generatedEnd - item.start + generatedOffset })))
    generatedOffset += text.length
    sourceOffset = item.end
  }
  appendUnchanged(code.length)
  return { code: chunks.join(''), sourceMap: mappings }
}

const LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/gu

function lineStartOffset(source, line) {
  if (line === 1) return 0
  let current = 1
  for (const match of source.matchAll(LINE_TERMINATORS)) {
    current += 1
    if (current === line) return match.index + match[0].length
  }
  return source.length
}

function positionAtOffset(source, offset) {
  let line = 1
  let start = 0
  for (const match of source.slice(0, offset).matchAll(LINE_TERMINATORS)) {
    line += 1
    start = match.index + match[0].length
  }
  return { line, column: offset - start + 1 }
}

export function mapSourcePosition(position, generatedSource, originalSource, sourceMap) {
  if (position === undefined || sourceMap === undefined) return position
  if (!Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1) return position
  const lineStart = lineStartOffset(generatedSource, position.line)
  const mappedOffset = originalOffsetAt(sourceMap, lineStart + position.column - 1)
  return positionAtOffset(originalSource, mappedOffset)
}

/** Map a complete generated-source span into original cell coordinates. */
export function mapSourceSpan(span, generatedSource, originalSource, sourceMap) {
  if (span === undefined) return undefined
  const start = mapSourcePosition(span, generatedSource, originalSource, sourceMap)
  if (span.end === undefined) return start === span ? span : start
  if (!Number.isSafeInteger(span.end.line) || span.end.line < 1
    || !Number.isSafeInteger(span.end.column) || span.end.column < 1) {
    return { ...start, end: span.end }
  }
  const generatedEnd = lineStartOffset(generatedSource, span.end.line) + span.end.column - 1
  const original = mappedOffsetRange(sourceMap, Math.max(0, generatedEnd - 1), generatedEnd)
  return { ...start, end: positionAtOffset(originalSource, original.originalEnd) }
}
