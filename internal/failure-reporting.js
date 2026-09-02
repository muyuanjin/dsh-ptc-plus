import { diagnostic } from './diagnostic.js'

export const MAX_ERROR_LOG_BYTES = 4 * 1024
export const FAILURE_HINT_THRESHOLD = 3
export const LONG_CELL_CODE_UNITS = 2_000
const BINDING_FAILURE = Symbol('binding failure')

export function markBindingFailure(error) {
  Object.defineProperty(error, BINDING_FAILURE, { value: true })
  return error
}

function repeatedFailureDiagnostic(kind, streak) {
  if (kind === 'binding') {
    return diagnostic({
      code: 'PTC-W001',
      severity: 'warning',
      phase: 'execute',
      message: `this cell failed ${streak} times with the same binding error; inspect the live binding names and change the expression before retrying`,
      stateEffect: 'unchanged',
      help: [
        'inspect live bindings with capabilities.tree(), capabilities.find(), or capabilities.inspect()',
        'call available typed members through tools.*',
        'do not repeat the same unresolved binding expression',
      ],
    })
  }
  return diagnostic({
    code: 'PTC-W002',
    severity: 'warning',
    phase: 'execute',
    message: `this cell failed ${streak} times with the same error; inspect the reported cause and change the approach before retrying`,
    stateEffect: 'unchanged',
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

export function errorPosition(error, filename) {
  const stack = safeProperty(error, 'stack')
  if (typeof stack !== 'string') return undefined
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack)
  if (match === null) return undefined
  const line = Number(match[1])
  const column = Number(match[2])
  return line >= 1 && column >= 1 ? { line, column } : undefined
}

export function errorDetails(error, filename) {
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
  const cause = causeMessage === undefined
    ? undefined
    : {
        ...(causeCode === undefined ? {} : { code: causeCode }),
        message: causeMessage,
      }
  const position = errorPosition(error, filename)
  return {
    name,
    message,
    ...(toolName === undefined ? {} : { toolName }),
    ...(position === undefined ? {} : { position }),
    ...(cause === undefined ? {} : { cause }),
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
    hint(error) {
      const nextFingerprint = `${error.kind}\u0000${error.message}`
      if (fingerprint === nextFingerprint) streak += 1
      else {
        fingerprint = nextFingerprint
        kind = error[BINDING_FAILURE] === true ? 'binding' : 'generic'
        streak = 1
      }
      if (streak !== FAILURE_HINT_THRESHOLD) return undefined
      return repeatedFailureDiagnostic(kind, streak)
    },
  })
}
