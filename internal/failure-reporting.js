import { diagnostic } from './diagnostic.js'
import { createHash } from 'node:crypto'
import { createPrivateAsyncLocalStorage } from './async-local-storage-intrinsics.js'
import { runtimeIntrinsics as internal } from './runtime-intrinsics.js'

const { Object, RegExp, isArray, numberIsSafeInteger, toNumber, toString,
  splitString, startsWith, endsWith, sliceString, searchString, replaceString,
  trimString, regexpExec, prependArray, join, bufferByteLength, bufferIsBuffer,
  bufferSubarray, bufferToString } = internal
export const MAX_ERROR_LOG_BYTES = 4 * 1024
export const FAILURE_HINT_THRESHOLD = 3
export const LONG_CELL_CODE_UNITS = 2_000
const BINDING_FAILURE = Symbol('binding failure')
const PROGRAM_FAILURES = new internal.WeakMap()
const MAX_CAUSE_CODE_UNITS = 2048
const exceptionOrigins = createPrivateAsyncLocalStorage()
const runExceptionScope = exceptionOrigins.run.bind(exceptionOrigins)
const currentExceptionScope = exceptionOrigins.getStore.bind(exceptionOrigins)

/** Propagation facts belong to one execution, never to a user-thrown value. */
export function createExceptionOriginScope() {
  const state = { origins: new internal.Map(), sourceFailures: new internal.Set(), open: true }
  return {
    run: callback => runExceptionScope(state, callback),
    origins: error => internal.mapGet(state.origins, error),
    sourceFailure: error => internal.setHas(state.sourceFailures, error),
    close() { state.open = false; internal.mapClear(state.origins); internal.setClear(state.sourceFailures) },
  }
}

export function recordExceptionOrigin(error, origin, { reset = false, sourceFailure = false } = {}) {
  const state = currentExceptionScope()
  if (state?.open !== true) return
  if (reset) { internal.mapDelete(state.origins, error); internal.setDelete(state.sourceFailures, error) }
  if (sourceFailure) internal.setAdd(state.sourceFailures, error)
  if (typeof origin !== 'string') return
  const origins = internal.mapGet(state.origins, error) ?? []
  if (!internal.includes(origins, origin)) internal.appendArray(origins, origin)
  internal.mapSet(state.origins, error, origins)
}

const SOURCE_LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/
const sourceLines = source => splitString(source, SOURCE_LINE_BREAK)

/** A cell position is a 1-based line and column inside its source. The column
 * may address the position just after the last character of a line. */
function boundedPosition(position, lines) {
  if (position === null || typeof position !== 'object'
    || !numberIsSafeInteger(position.line) || position.line < 1
    || !numberIsSafeInteger(position.column) || position.column < 1
    || position.line > lines.length || position.column > lines[position.line - 1].length + 1) return undefined
  return { line: position.line, column: position.column }
}

/** Validate a candidate against the source that owns the reported cell. */
export function cellPosition(position, source) {
  return boundedPosition(position, sourceLines(source))
}

/** Only a fact belonging to the current original source can bypass its map. */
export function exceptionOriginPosition(origins, source) {
  if (!isArray(origins)) return undefined
  const prefix = `eval:${createHash('sha256').update(source).digest('hex')}:`
  const lines = sourceLines(source)
  for (let index = 0; index < origins.length; index += 1) {
    const origin = origins[index]
    if (typeof origin !== 'string' || !startsWith(origin, prefix)) continue
    const match = regexpExec(/^(\d+):(\d+)$/, sliceString(origin, prefix.length))
    if (match === null) continue
    const position = boundedPosition({ line: toNumber(match[1]), column: toNumber(match[2]) }, lines)
    if (position !== undefined) return position
  }
  return undefined
}

export function markBindingFailure(error, kind = 'lexical') {
  Object.defineProperty(error, BINDING_FAILURE, { value: kind })
  return error
}

/** Preserve worker-owned failure identity without trusting user exception text. */
export function programBindingError(kind, message) {
  const error = new internal.Error(message)
  internal.weakMapSet(PROGRAM_FAILURES, error, kind)
  return error
}

function repeatedFailureDiagnostic(kind, streak, stateEffect) {
  if (kind === 'lexical' || kind === 'capability') {
    const capability = kind === 'capability'
    return diagnostic({
      code: 'PTC-W001',
      severity: 'warning',
      phase: 'execute',
      message: `this cell failed ${streak} times with the same ${capability ? 'capability' : 'lexical binding'} error; resolve the reported name before continuing`,
      stateEffect,
      cause: { code: capability ? 'PTC-CAPABILITY' : 'PTC-LOCAL', message: capability ? 'current program capability lookup failed' : 'local name or declaration conflict' },
      help: capability ? [
        'inspect live bindings with capabilities.tree(), capabilities.find(), or capabilities.inspect()',
        'call available typed members through tools.*',
        'do not repeat the same unresolved binding expression',
      ] : [
        'inspect the visible cell source and results for the local declaration, scope, or initialization failure',
        'correct the name or initialization; use a fresh name or block for a declaration conflict',
        'capabilities describes program APIs, not session-local variables; discovery cannot prove local state',
      ],
    })
  }
  return diagnostic({
    code: 'PTC-W002',
    severity: 'warning',
    phase: 'execute',
    message: `this cell failed ${streak} times with the same error; inspect the reported cause and change the approach before retrying`,
    stateEffect,
    help: ['inspect the reported cause', 'change the inputs or approach before retrying'],
  })
}

export function safeProperty(value, key) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  try {
    return value[key]
  } catch {
    return undefined
  }
}

export function messageOf(error, fallback = 'Unprintable error') {
  const message = safeProperty(error, 'message')
  if (typeof message === 'string') return message
  try {
    return toString(error)
  } catch {
    return fallback
  }
}

/** Preserve the child-process exit facts in every helper failure diagnostic. */
export function processExitDescription(code, signal) {
  return signal === null || signal === undefined
    ? `code ${code}`
    : `code ${code}, signal ${signal}`
}

export function firstLine(value, fallback = undefined) {
  if (typeof value !== 'string') return fallback
  const line = splitString(value, /[\r\n]/, 1)[0]
  return line.length > 0 ? line : fallback
}

export function oneLineMessage(error) {
  return replaceString(firstLine(messageOf(error), 'Unknown error'), /\s+\(\d+:\d+\)$/, '')
}

/** Return DSH's reported missing-description property path when it is actionable. */
export function missingDescriptionPath(error) {
  const pattern = /missing required property ["']([^"']+)["']/g
  const message = messageOf(error)
  for (let match = regexpExec(pattern, message); match !== null; match = regexpExec(pattern, message)) {
    const path = match[1]
    if (path === 'description' || endsWith(path, '.description')) return path
  }
  return undefined
}

/** Identify DSH's stable missing-description validation fact without parsing arbitrary errors. */
export function hasMissingDescriptionError(error) {
  return missingDescriptionPath(error) !== undefined
}

/** Keep only the newest log entries so an output-limit error cannot flood the model. */
export function limitLogs(logs) {
  let bytes = 0
  const tail = []
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const size = bufferByteLength(logs[index], 'utf8') + 1
    if (bytes + size > MAX_ERROR_LOG_BYTES) break
    bytes += size
    prependArray(tail, logs[index])
  }
  return tail
}

/** A frame is only useful when its 1-based line and column are safe integers. */
function structuralPosition(position) {
  return numberIsSafeInteger(position.line) && position.line >= 1
    && numberIsSafeInteger(position.column) && position.column >= 1 ? position : undefined
}

/** Extract the first frame for the active cell. The frame is reported in the
 * executed text, so it is only a cell position when it lies inside the source
 * that produced that text. */
export function errorPosition(error, filename, source) {
  const stack = safeProperty(error, 'stack')
  if (typeof stack !== 'string') return undefined
  const escaped = replaceString(filename, /[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = regexpExec(new RegExp(`${escaped}:(\\d+):(\\d+)`), stack)
  if (match === null) return undefined
  const position = { line: toNumber(match[1]), column: toNumber(match[2]) }
  return source === undefined ? structuralPosition(position) : cellPosition(position, source)
}

export function errorDetails(error, filename, source) {
  const message = messageOf(error, 'Unprintable thrown value')
  const rawName = safeProperty(error, 'name')
  const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Error'
  const rawToolName = safeProperty(error, 'toolName')
  const toolName = name === 'ToolCallError'
    ? firstLine(rawToolName)
    : undefined
  const candidate = safeProperty(error, 'ptcCause')
  const causeMessage = firstLine(safeProperty(candidate, 'message'))
  const causeCode = firstLine(safeProperty(candidate, 'code'))
  const stderr = safeProperty(error, 'stderr')
  const stderrText = typeof stderr === 'string' ? sliceString(stderr, 0, MAX_CAUSE_CODE_UNITS)
    : bufferIsBuffer(stderr)
      ? bufferToString(bufferSubarray(stderr, 0, MAX_CAUSE_CODE_UNITS), 'utf8') : ''
  const boundedMessage = sliceString(message, 0, MAX_CAUSE_CODE_UNITS)
  const continuation = searchString(boundedMessage, /[\r\n]/)
  const detailParts = [continuation < 0 ? '' : sliceString(boundedMessage, continuation + 1), stderrText]
  const detail = trimString(replaceString(
    sliceString(join(detailParts, ' '), 0, MAX_CAUSE_CODE_UNITS), /\s+/g, ' '))
  const cause = causeMessage === undefined
    ? detail.length === 0 ? undefined : { message: detail }
    : {
        ...(causeCode === undefined ? {} : { code: causeCode }),
        message: causeMessage,
      }
  const position = errorPosition(error, filename, source)
  const failureOrigin = internal.weakMapGet(PROGRAM_FAILURES, error)
  return {
    name,
    message,
    ...(toolName === undefined ? {} : { toolName }),
    ...(position === undefined ? {} : { position }),
    ...(cause === undefined ? {} : { cause }),
    ...(failureOrigin === undefined ? {} : { failureOrigin }),
  }
}

export function createFailureTracker() {
  let fingerprint
  let kind
  let streak = 0
  return Object.freeze({
    reset() {
      fingerprint = undefined
      kind = undefined
      streak = 0
    },
    hint(error, stateEffect = 'unknown') {
      const nextFingerprint = `${error.kind}\u0000${error.message}`
      if (fingerprint === nextFingerprint) streak += 1
      else {
        fingerprint = nextFingerprint
        kind = error[BINDING_FAILURE] ?? 'generic'
        streak = 1
      }
      if (streak !== FAILURE_HINT_THRESHOLD) return undefined
      return repeatedFailureDiagnostic(kind, streak, stateEffect)
    },
  })
}
