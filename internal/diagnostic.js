import { codeFrameColumns } from '@babel/code-frame'
import { assertOwnFields, isRecord } from './record-utils.js'

const DIAGNOSTIC_FIELDS = new Set([
  'code', 'severity', 'phase', 'message', 'stateEffect', 'dispatchState',
  'source', 'cause', 'help', 'collisions',
])
const SOURCE_FIELDS = new Set(['cell', 'start', 'end'])
const COLLISION_FIELDS = new Set(['name', 'kind', 'reason', 'start', 'end'])
const POSITION_FIELDS = new Set(['line', 'column'])
const CAUSE_FIELDS = new Set(['code', 'message'])
const SEVERITIES = new Set(['error', 'warning', 'note'])
const PHASES = new Set(['parse', 'preflight', 'execute', 'tool-dispatch', 'replay', 'recover'])
const STATE_EFFECTS = new Set(['unchanged', 'partially-applied', 'rolled-back', 'unknown'])
const DISPATCH_STATES = new Set(['not-dispatched', 'dispatched', 'completed', 'unknown'])

function isLine(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value)
}

function normalizePosition(value, label) {
  if (!isRecord(value) || !Number.isSafeInteger(value.line) || value.line < 1
    || !Number.isSafeInteger(value.column) || value.column < 1) {
    throw new Error(`invalid diagnostic ${label}`)
  }
  assertOwnFields(value, POSITION_FIELDS, `diagnostic ${label}`)
  return Object.freeze({ line: value.line, column: value.column })
}

/** One collision record as its compiler owner determined it: the colliding name, its
 * declaration kind, the reason the producer rejected it, and the original source span. */
function normalizeCollision(value) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus diagnostic collision')
  assertOwnFields(value, COLLISION_FIELDS, 'diagnostic collision')
  if (!isLine(value.name) || !isLine(value.kind) || !isLine(value.reason)) {
    throw new Error('invalid dsh-ptc-plus diagnostic collision')
  }
  return Object.freeze({
    name: value.name,
    kind: value.kind,
    reason: value.reason,
    start: normalizePosition(value.start, 'collision start'),
    ...(value.end === undefined ? {} : { end: normalizePosition(value.end, 'collision end') }),
  })
}

function normalizeCause(value, depth) {
  if (depth > 16) throw new Error('diagnostic cause chain is too deep')
  if (!isRecord(value)) throw new Error('invalid diagnostic cause')
  if (!Object.hasOwn(value, 'severity')) {
    assertOwnFields(value, CAUSE_FIELDS, 'diagnostic cause')
    if (value.code !== undefined && !isLine(value.code)) {
      throw new Error('invalid diagnostic cause code')
    }
    if (!isLine(value.message)) {
      throw new Error('invalid diagnostic cause message')
    }
    return Object.freeze({
      ...(value.code === undefined ? {} : { code: value.code }),
      message: value.message,
    })
  }
  return normalizeDiagnostic(value, depth + 1)
}

export function normalizeDiagnostic(value, depth = 0) {
  if (!isRecord(value)) throw new Error('invalid dsh-ptc-plus diagnostic')
  assertOwnFields(value, DIAGNOSTIC_FIELDS, 'dsh-ptc-plus diagnostic')
  if (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9-]{2,31}$/.test(value.code)) {
    throw new Error('invalid dsh-ptc-plus diagnostic code')
  }
  if (!SEVERITIES.has(value.severity) || !PHASES.has(value.phase)
    || !STATE_EFFECTS.has(value.stateEffect) || !isLine(value.message)) {
    throw new Error('invalid dsh-ptc-plus diagnostic')
  }
  if (value.dispatchState !== undefined && !DISPATCH_STATES.has(value.dispatchState)) {
    throw new Error('invalid dsh-ptc-plus diagnostic dispatch state')
  }
  let source
  if (value.source !== undefined) {
    if (!isRecord(value.source) || !isLine(value.source.cell)) {
      throw new Error('invalid dsh-ptc-plus diagnostic source')
    }
    assertOwnFields(value.source, SOURCE_FIELDS, 'diagnostic source')
    source = {
      cell: value.source.cell,
      start: normalizePosition(value.source.start, 'source start'),
      ...(value.source.end === undefined ? {} : { end: normalizePosition(value.source.end, 'source end') }),
    }
    if (source.end !== undefined && (source.end.line < source.start.line
      || (source.end.line === source.start.line && source.end.column < source.start.column))) {
      throw new Error('diagnostic source end precedes its start')
    }
    Object.freeze(source)
  }
  let cause
  if (value.cause !== undefined) cause = normalizeCause(value.cause, depth)
  let collisions
  if (value.collisions !== undefined) {
    if (!Array.isArray(value.collisions) || value.collisions.length === 0) {
      throw new Error('invalid dsh-ptc-plus diagnostic collisions')
    }
    collisions = Object.freeze(value.collisions.map(collision => normalizeCollision(collision)))
  }
  let help
  if (value.help !== undefined) {
    if (!Array.isArray(value.help) || value.help.length > 3
      || value.help.some(item => !isLine(item))) {
      throw new Error('invalid dsh-ptc-plus diagnostic help')
    }
    help = Object.freeze([...value.help])
  }
  return Object.freeze({
    code: value.code,
    severity: value.severity,
    phase: value.phase,
    message: value.message,
    stateEffect: value.stateEffect,
    ...(value.dispatchState === undefined ? {} : { dispatchState: value.dispatchState }),
    ...(source === undefined ? {} : { source }),
    ...(cause === undefined ? {} : { cause }),
    ...(collisions === undefined ? {} : { collisions }),
    ...(help === undefined ? {} : { help }),
  })
}

export function diagnostic(value) {
  return normalizeDiagnostic(value)
}

function causeText(cause) {
  if (cause === undefined) return undefined
  if (cause.code === undefined) return `cause: ${cause.message}`
  return `cause: ${cause.code}: ${cause.message}`
}

/** Render a diagnostic without ANSI escapes or model-side parsing conventions. */
export function renderDiagnostic(value, sourceText = undefined) {
  const normalized = normalizeDiagnostic(value)
  const lines = [`${normalized.severity}[${normalized.code}]: ${normalized.message}`]
  if (normalized.source !== undefined) {
    const { source } = normalized
    lines.push(` --> ${source.cell}:${source.start.line}:${source.start.column}`)
    if (typeof sourceText === 'string') {
      const frame = codeFrameColumns(sourceText, {
        start: source.start,
        ...(source.end === undefined ? {} : { end: source.end }),
      }, { highlightCode: false, linesAbove: 0, linesBelow: 0 })
      if (frame.length > 0) lines.push(frame)
    }
  }
  lines.push(`phase: ${normalized.phase}`)
  if (normalized.dispatchState !== undefined) lines.push(`dispatch: ${normalized.dispatchState}`)
  lines.push(`state: ${normalized.stateEffect}`)
  const cause = causeText(normalized.cause)
  if (cause !== undefined) lines.push(cause)
  for (const help of normalized.help ?? []) lines.push(`help: ${help}`)
  return lines.join('\n')
}
