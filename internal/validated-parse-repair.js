import { EXPECTED_TARGET_CALL_SEQ, editRejectedCell } from './rejected-cell-editor.js'

const CLOSING_DELIMITERS = Object.freeze(['}', ')', ']'])
const CLOSING_SUFFIXES = Object.freeze([
  ...CLOSING_DELIMITERS,
  ...CLOSING_DELIMITERS.flatMap(first => CLOSING_DELIMITERS.map(second => first + second)),
])
const LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/gu
export const MAX_PARSE_REPAIR_ANCHOR_CODE_UNITS = 256

function sourceEndPosition(source) {
  let line = 1
  let lineStart = 0
  for (const match of source.matchAll(LINE_TERMINATORS)) {
    line += 1
    lineStart = match.index + match[0].length
  }
  return { line, column: source.length - lineStart + 1 }
}

function isSourceEnd(source, position) {
  if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.column)) return false
  const end = sourceEndPosition(source)
  return position.line === end.line && position.column === end.column
}

function startsInsideSurrogatePair(source, index) {
  if (index <= 0) return false
  const current = source.charCodeAt(index)
  const previous = source.charCodeAt(index - 1)
  return current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
}

function boundedUniqueSuffix(source) {
  const first = Math.max(0, source.length - MAX_PARSE_REPAIR_ANCHOR_CODE_UNITS)
  for (let start = source.length - 1; start >= first; start -= 1) {
    if (startsInsideSurrogatePair(source, start)) continue
    const suffix = source.slice(start)
    if (source.indexOf(suffix) === source.lastIndexOf(suffix)) return suffix
  }
  return undefined
}

function repairArguments(anchor, delimiter, targetCallSeq) {
  const edit = Object.freeze({ old_string: anchor, new_string: anchor + delimiter })
  return Object.freeze({
    edits: Object.freeze([edit]),
    [EXPECTED_TARGET_CALL_SEQ]: targetCallSeq,
  })
}

function renderInvocation(argumentsValue) {
  const json = JSON.stringify(argumentsValue)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
  return `edit_run_code(${json})`
}

/** Requires exactly one valid suffix across all one- and two-token EOF closures. */
export function validatedEofClosureRepair({ source, position, prepare, targetCallSeq }) {
  if (!Number.isSafeInteger(targetCallSeq) || targetCallSeq < 0
    || !isSourceEnd(source, position)) return undefined
  const anchor = boundedUniqueSuffix(source)
  if (anchor === undefined) return undefined
  const candidates = []
  for (const delimiter of CLOSING_SUFFIXES) {
    const code = source + delimiter
    let prepared
    try {
      prepared = prepare(code)
    } catch {
      continue
    }
    if (prepared.collisions.length > 0) continue
    const argumentsValue = repairArguments(anchor, delimiter, targetCallSeq)
    const edited = editRejectedCell(argumentsValue, source)
    if (!edited.edited || edited.code !== code) continue
    candidates.push({ delimiter, arguments: argumentsValue })
  }
  if (candidates.length !== 1) return undefined
  const candidate = candidates[0]
  return Object.freeze({
    ...candidate,
    invocation: renderInvocation(candidate.arguments),
  })
}
