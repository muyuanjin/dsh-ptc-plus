import { diagnostic } from './diagnostic.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { moduleRuntimeIntrinsics as internal } from './compiler-intrinsics.js'

export const MAX_ERROR_LOG_BYTES = 4 * 1024
export const FAILURE_HINT_THRESHOLD = 3
export const LONG_CELL_CODE_UNITS = 2_000
const BINDING_FAILURE = Symbol('binding failure')
const PROGRAM_FAILURES = new internal.WeakMap()
const MAX_CAUSE_CODE_UNITS = 2048
const exceptionOrigins = new AsyncLocalStorage()
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
const sourceLines = source => source.split(SOURCE_LINE_BREAK)

/** A cell position is a 1-based line and column inside its source. The column
 * may address the position just after the last character of a line. */
function boundedPosition(position, lines) {
  if (position === null || typeof position !== 'object'
    || !Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1
    || position.line > lines.length || position.column > lines[position.line - 1].length + 1) return undefined
  return { line: position.line, column: position.column }
}

/** Validate a candidate against the source that owns the reported cell. */
export function cellPosition(position, source) {
  return boundedPosition(position, sourceLines(source))
}

/** Only a fact belonging to the current original source can bypass its map. */
export function exceptionOriginPosition(origins, source) {
  if (!Array.isArray(origins)) return undefined
  const prefix = `eval:${createHash('sha256').update(source).digest('hex')}:`
  const lines = sourceLines(source)
  for (const origin of origins) {
    if (typeof origin !== 'string' || !origin.startsWith(prefix)) continue
    const match = /^(\d+):(\d+)$/.exec(origin.slice(prefix.length))
    if (match === null) continue
    const position = boundedPosition({ line: Number(match[1]), column: Number(match[2]) }, lines)
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
    return String(error)
  } catch {
    return fallback
  }
}

export function firstLine(value, fallback = undefined) {
  if (typeof value !== 'string') return fallback
  const line = value.split(/[\r\n]/, 1)[0]
  return line.length > 0 ? line : fallback
}

export function oneLineMessage(error) {
  return firstLine(messageOf(error), 'Unknown error').replace(/\s+\(\d+:\d+\)$/, '')
}

/** Return DSH's reported missing-description property path when it is actionable. */
export function missingDescriptionPath(error) {
  const violations = messageOf(error).matchAll(/missing required property ["']([^"']+)["']/g)
  for (const match of violations) {
    const path = match[1]
    if (path === 'description' || path.endsWith('.description')) return path
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
    const size = Buffer.byteLength(logs[index], 'utf8') + 1
    if (bytes + size > MAX_ERROR_LOG_BYTES) break
    bytes += size
    tail.unshift(logs[index])
  }
  return tail
}

/** A frame is only useful when its 1-based line and column are safe integers. */
function structuralPosition(position) {
  return Number.isSafeInteger(position.line) && position.line >= 1
    && Number.isSafeInteger(position.column) && position.column >= 1 ? position : undefined
}

/** Extract the first frame for the active cell. The frame is reported in the
 * executed text, so it is only a cell position when it lies inside the source
 * that produced that text. */
export function errorPosition(error, filename, source) {
  const stack = safeProperty(error, 'stack')
  if (typeof stack !== 'string') return undefined
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack)
  if (match === null) return undefined
  const position = { line: Number(match[1]), column: Number(match[2]) }
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
  const stderrText = typeof stderr === 'string' ? stderr.slice(0, MAX_CAUSE_CODE_UNITS)
    : Buffer.isBuffer(stderr) ? stderr.subarray(0, MAX_CAUSE_CODE_UNITS).toString('utf8') : ''
  const boundedMessage = message.slice(0, MAX_CAUSE_CODE_UNITS)
  const continuation = boundedMessage.search(/[\r\n]/)
  const detail = [continuation < 0 ? '' : boundedMessage.slice(continuation + 1), stderrText]
    .join(' ').slice(0, MAX_CAUSE_CODE_UNITS).replace(/\s+/g, ' ').trim()
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
