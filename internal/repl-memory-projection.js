import { isRecord } from './record-utils.js'

export const REPL_MEMORY_KEY = 'ptcPlusRepl'
export const REPL_MEMORY_META_KEY = 'dshPtcPlusBindings'

const BINDING_KINDS = new Set(['variable', 'function', 'class', 'import'])
const MAX_BINDINGS = 128
const MAX_BINDING_NAME_LENGTH = 128
const MAX_DEFINITION_SOURCE_LENGTH = 1024
const MAX_DEFINITION_SOURCE_TOTAL_LENGTH = 16 * 1024
const MAX_PENDING_REPL_CALLS = 256
const MAX_CALL_ID_LENGTH = 512
const MAX_GENERATION_LENGTH = 128
const SNAPSHOT_FIELDS = new Set(['available', 'entries', 'total', 'omitted'])
const ENTRY_FIELDS = new Set(['name', 'kind', 'definition'])
const DEFINITION_FIELDS = new Set(['source', 'line', 'column'])
const MEMORY_META_FIELDS = new Set(['version', 'generation', 'memory'])
const PROJECTION_STATE_FIELDS = new Set(['generation', 'memory', 'pendingReplCalls'])
const PENDING_CALL_FIELDS = new Set(['callId', 'seq'])
const REPL_TOOL_NAMES = new Set(['run_code', 'edit_run_code'])
const REPL_MEMORY_META_VERSION = 3

function exactFields(value, fields) {
  if (!isRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === fields.size && keys.every(key => (
    typeof key === 'string' && fields.has(key)
    && Object.prototype.propertyIsEnumerable.call(value, key)
  ))
}

const EMPTY_REPL_MEMORY = Object.freeze({
  available: false,
  entries: Object.freeze([]),
  total: 0,
  omitted: 0,
})

export function unavailableReplMemorySnapshot() {
  return EMPTY_REPL_MEMORY
}

function normalizeGeneration(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GENERATION_LENGTH) {
    throw new Error('invalid dsh-ptc-plus REPL memory generation')
  }
  return value
}

function normalizeDefinition(value) {
  if (!exactFields(value, DEFINITION_FIELDS)
    || typeof value.source !== 'string' || value.source.length === 0
    || value.source.length > MAX_DEFINITION_SOURCE_LENGTH
    || !Number.isSafeInteger(value.line) || value.line < 1
    || !Number.isSafeInteger(value.column) || value.column < 1) {
    throw new Error('invalid dsh-ptc-plus REPL binding definition')
  }
  return Object.freeze({ source: value.source, line: value.line, column: value.column })
}

function normalizeBinding(value) {
  if (!exactFields(value, ENTRY_FIELDS) || typeof value.name !== 'string'
    || value.name.length === 0 || value.name.length > MAX_BINDING_NAME_LENGTH
    || !BINDING_KINDS.has(value.kind)) {
    throw new Error('invalid dsh-ptc-plus REPL memory binding')
  }
  return Object.freeze({
    name: value.name,
    kind: value.kind,
    definition: normalizeDefinition(value.definition),
  })
}

/** Produce bounded, value-independent presentation metadata from the live binding catalog. */
export function createReplMemorySnapshot(bindings) {
  const all = Array.isArray(bindings) ? bindings : []
  const candidates = []
  const names = new Set()
  for (const binding of all) {
    try {
      const normalized = normalizeBinding(binding)
      if (names.has(normalized.name)) continue
      names.add(normalized.name)
      candidates.push(normalized)
    } catch {}
  }
  const entries = []
  let sourceLength = 0
  for (const binding of candidates) {
    if (entries.length >= MAX_BINDINGS) break
    if (sourceLength + binding.definition.source.length > MAX_DEFINITION_SOURCE_TOTAL_LENGTH) continue
    entries.push(binding)
    sourceLength += binding.definition.source.length
  }
  return Object.freeze({
    available: true,
    entries: Object.freeze(entries),
    total: candidates.length,
    omitted: candidates.length - entries.length,
  })
}

/** Validate one complete session-projection value without accepting unknown fields. */
export function normalizeReplMemorySnapshot(value) {
  if (!exactFields(value, SNAPSHOT_FIELDS) || typeof value.available !== 'boolean'
    || !Array.isArray(value.entries) || value.entries.length > MAX_BINDINGS
    || !Number.isSafeInteger(value.total) || value.total < 0
    || !Number.isSafeInteger(value.omitted) || value.omitted < 0
    || value.total !== value.entries.length + value.omitted) {
    throw new Error('invalid dsh-ptc-plus REPL memory snapshot')
  }
  if (!value.available && (value.total !== 0 || value.entries.length !== 0)) {
    throw new Error('unavailable dsh-ptc-plus REPL memory snapshot must be empty')
  }
  const names = new Set()
  let sourceLength = 0
  const entries = value.entries.map((entry) => {
    const normalized = normalizeBinding(entry)
    if (names.has(normalized.name)) {
      throw new Error('invalid dsh-ptc-plus REPL memory binding')
    }
    sourceLength += normalized.definition.source.length
    if (sourceLength > MAX_DEFINITION_SOURCE_TOTAL_LENGTH) {
      throw new Error('dsh-ptc-plus REPL binding definitions exceed the presentation budget')
    }
    names.add(normalized.name)
    return normalized
  })
  return Object.freeze({
    available: value.available,
    entries: Object.freeze(entries),
    total: value.total,
    omitted: value.omitted,
  })
}

function normalizeReplMemoryMetadata(value) {
  if (!exactFields(value, MEMORY_META_FIELDS) || value.version !== REPL_MEMORY_META_VERSION) {
    throw new Error('invalid dsh-ptc-plus REPL memory metadata')
  }
  return Object.freeze({
    version: REPL_MEMORY_META_VERSION,
    generation: normalizeGeneration(value.generation),
    memory: normalizeReplMemorySnapshot(value.memory),
  })
}

/** Read current-owner presentation metadata without affecting tool settlement. */
export function validatedReplMemorySnapshot(meta, generation) {
  if (!isRecord(meta) || !Object.hasOwn(meta, REPL_MEMORY_META_KEY)) return undefined
  try {
    const normalized = normalizeReplMemoryMetadata(meta[REPL_MEMORY_META_KEY])
    return normalized.generation === normalizeGeneration(generation)
      ? normalized.memory
      : undefined
  } catch {
    return undefined
  }
}

function projectionState(generation, memory, pendingReplCalls) {
  return Object.freeze({
    generation,
    memory,
    pendingReplCalls: pendingReplCalls === null
      ? null
      : Object.freeze(pendingReplCalls),
  })
}

function emptyProjectionState(generation) {
  return projectionState(normalizeGeneration(generation), EMPTY_REPL_MEMORY, [])
}

function normalizeProjectionState(value, generation) {
  if (!exactFields(value, PROJECTION_STATE_FIELDS)) {
    throw new Error('invalid dsh-ptc-plus REPL memory projection state')
  }
  const storedGeneration = normalizeGeneration(value.generation)
  const currentGeneration = normalizeGeneration(generation)
  if (storedGeneration !== currentGeneration) return emptyProjectionState(currentGeneration)
  const memory = normalizeReplMemorySnapshot(value.memory)
  if (value.pendingReplCalls === null) {
    if (memory.available) {
      throw new Error('untracked dsh-ptc-plus REPL calls require unavailable memory')
    }
    return projectionState(currentGeneration, memory, null)
  }
  if (!Array.isArray(value.pendingReplCalls)
    || value.pendingReplCalls.length > MAX_PENDING_REPL_CALLS) {
    throw new Error('invalid dsh-ptc-plus pending REPL calls')
  }
  let previousSeq
  const callIds = new Set()
  const pendingReplCalls = value.pendingReplCalls.map((pending) => {
    if (!exactFields(pending, PENDING_CALL_FIELDS)
      || typeof pending.callId !== 'string' || pending.callId.length === 0
      || pending.callId.length > MAX_CALL_ID_LENGTH || callIds.has(pending.callId)
      || !Number.isSafeInteger(pending.seq) || pending.seq < 0
      || (previousSeq !== undefined && previousSeq >= pending.seq)) {
      throw new Error('invalid dsh-ptc-plus pending REPL call')
    }
    callIds.add(pending.callId)
    previousSeq = pending.seq
    return Object.freeze({ callId: pending.callId, seq: pending.seq })
  })
  return projectionState(currentGeneration, memory, pendingReplCalls)
}

function eventCallId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CALL_ID_LENGTH
    ? value
    : undefined
}

function trackReplCall(state, event) {
  if (!REPL_TOOL_NAMES.has(event.data?.name)) return state
  const seq = event.seq
  const callId = eventCallId(event.data?.callId)
  if (!Number.isSafeInteger(seq) || seq < 0 || callId === undefined) return state
  const pending = state.pendingReplCalls
  if (pending === null || pending.some(call => call.callId === callId || call.seq === seq)) return state
  if (pending.length >= MAX_PENDING_REPL_CALLS) {
    return projectionState(state.generation, EMPTY_REPL_MEMORY, null)
  }
  return projectionState(state.generation, state.memory, [
    ...pending,
    Object.freeze({ callId, seq }),
  ].sort((left, right) => left.seq - right.seq))
}

function settleReplCall(state, event, generation) {
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return state
  const pending = state.pendingReplCalls
  if (pending === null) return state
  const callId = eventCallId(event.data?.message?.source?.callId)
  if (callId === undefined) return state
  const index = pending.findIndex(call => call.callId === callId)
  if (index < 0) return state
  const remaining = pending.filter((_call, pendingIndex) => pendingIndex !== index)
  const memory = validatedReplMemorySnapshot(event.data?.meta, generation) ?? state.memory
  return projectionState(state.generation, memory, remaining)
}

/** Merge the binding snapshot into private, model-invisible result presentation metadata. */
export function withReplMemorySnapshot(meta, snapshot, generation) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: meta }
  base[REPL_MEMORY_META_KEY] = normalizeReplMemoryMetadata({
    version: REPL_MEMORY_META_VERSION,
    generation: normalizeGeneration(generation),
    memory: snapshot,
  })
  return base
}

/** Build the current runtime owner's value-independent session projection. */
export function createReplMemoryProjection(generation) {
  const currentGeneration = normalizeGeneration(generation)
  return Object.freeze({
    key: REPL_MEMORY_KEY,
    stateVersion: 3,
    stateSchema: Object.freeze({
      parse: value => normalizeProjectionState(value, currentGeneration),
    }),
    init: () => emptyProjectionState(currentGeneration),
    apply(state, event) {
      if (event?.type === 'session/end-seed') return emptyProjectionState(currentGeneration)
      if (event?.type === 'tool/call') return trackReplCall(state, event)
      if (event?.type === 'tool/result') return settleReplCall(state, event, currentGeneration)
      return state
    },
    wire: Object.freeze({
      viewSchema: Object.freeze({ parse: normalizeReplMemorySnapshot }),
      view: state => state.memory,
    }),
  })
}
