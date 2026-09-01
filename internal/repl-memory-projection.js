import { isRecord } from './record-utils.js'

export const REPL_MEMORY_KEY = 'ptcPlusRepl'
export const REPL_MEMORY_META_KEY = 'dshPtcPlusBindings'

const BINDING_KINDS = new Set(['variable', 'function', 'class', 'import'])
const MAX_BINDINGS = 128
const MAX_BINDING_NAME_LENGTH = 128
const MAX_PENDING_REPL_CALLS = 256
const SNAPSHOT_FIELDS = new Set(['available', 'entries', 'total', 'omitted'])
const ENTRY_FIELDS = new Set(['name', 'kind'])
const PROJECTION_STATE_FIELDS = new Set(['memory', 'pendingReplCallSeqs'])
const REPL_TOOL_NAMES = new Set(['run_code', 'edit_run_code'])

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

const EMPTY_PROJECTION_STATE = Object.freeze({
  memory: EMPTY_REPL_MEMORY,
  pendingReplCallSeqs: Object.freeze([]),
})

export function unavailableReplMemorySnapshot() {
  return EMPTY_REPL_MEMORY
}

/** Produce bounded, value-free presentation metadata from the live binding catalog. */
export function createReplMemorySnapshot(bindings) {
  const all = Array.isArray(bindings) ? bindings : []
  const entries = []
  for (const binding of all) {
    if (entries.length >= MAX_BINDINGS) break
    if (!isRecord(binding) || typeof binding.name !== 'string'
      || binding.name.length === 0 || binding.name.length > MAX_BINDING_NAME_LENGTH
      || !BINDING_KINDS.has(binding.kind)) continue
    entries.push(Object.freeze({ name: binding.name, kind: binding.kind }))
  }
  return Object.freeze({
    available: true,
    entries: Object.freeze(entries),
    total: all.length,
    omitted: all.length - entries.length,
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
  let previous
  const entries = value.entries.map((entry) => {
    if (!exactFields(entry, ENTRY_FIELDS) || typeof entry.name !== 'string'
      || entry.name.length === 0 || entry.name.length > MAX_BINDING_NAME_LENGTH
      || !BINDING_KINDS.has(entry.kind) || names.has(entry.name)
      || (previous !== undefined && previous >= entry.name)) {
      throw new Error('invalid dsh-ptc-plus REPL memory binding')
    }
    names.add(entry.name)
    previous = entry.name
    return Object.freeze({ name: entry.name, kind: entry.kind })
  })
  return Object.freeze({
    available: value.available,
    entries: Object.freeze(entries),
    total: value.total,
    omitted: value.omitted,
  })
}

/** Read optional presentation metadata without letting malformed UI data affect settlement. */
export function validatedReplMemorySnapshot(meta) {
  if (!isRecord(meta) || !Object.hasOwn(meta, REPL_MEMORY_META_KEY)) return undefined
  try {
    return normalizeReplMemorySnapshot(meta[REPL_MEMORY_META_KEY])
  } catch {
    return undefined
  }
}

function projectionState(memory, pendingReplCallSeqs) {
  return Object.freeze({
    memory,
    pendingReplCallSeqs: pendingReplCallSeqs === null
      ? null
      : Object.freeze(pendingReplCallSeqs),
  })
}

function normalizeProjectionState(value) {
  if (!exactFields(value, PROJECTION_STATE_FIELDS)) {
    throw new Error('invalid dsh-ptc-plus REPL memory projection state')
  }
  const memory = normalizeReplMemorySnapshot(value.memory)
  if (value.pendingReplCallSeqs === null) {
    if (memory.available) {
      throw new Error('untracked dsh-ptc-plus REPL calls require unavailable memory')
    }
    return projectionState(memory, null)
  }
  if (!Array.isArray(value.pendingReplCallSeqs)
    || value.pendingReplCallSeqs.length > MAX_PENDING_REPL_CALLS) {
    throw new Error('invalid dsh-ptc-plus pending REPL calls')
  }
  let previous
  const pendingReplCallSeqs = value.pendingReplCallSeqs.map((seq) => {
    if (!Number.isSafeInteger(seq) || seq < 0 || (previous !== undefined && previous >= seq)) {
      throw new Error('invalid dsh-ptc-plus pending REPL call sequence')
    }
    previous = seq
    return seq
  })
  return projectionState(memory, pendingReplCallSeqs)
}

function trackReplCall(state, event) {
  if (!REPL_TOOL_NAMES.has(event.data?.name)) return state
  const seq = event.seq
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return projectionState(EMPTY_REPL_MEMORY, null)
  }
  const pending = state.pendingReplCallSeqs
  if (pending === null || pending.includes(seq)) return state
  if (pending.length >= MAX_PENDING_REPL_CALLS) {
    return projectionState(EMPTY_REPL_MEMORY, null)
  }
  return projectionState(state.memory, [...pending, seq].sort((left, right) => left - right))
}

function settleReplCall(state, event) {
  const pending = state.pendingReplCallSeqs
  if (pending === null || !Array.isArray(event.sourceEventSeqs)) return state
  const sources = new Set(event.sourceEventSeqs)
  const remaining = pending.filter(seq => !sources.has(seq))
  if (remaining.length === pending.length) return state
  const memory = validatedReplMemorySnapshot(event.data?.meta) ?? EMPTY_REPL_MEMORY
  return projectionState(memory, remaining)
}

/** Merge the binding snapshot into private, model-invisible result presentation metadata. */
export function withReplMemorySnapshot(meta, snapshot) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: meta }
  base[REPL_MEMORY_META_KEY] = normalizeReplMemorySnapshot(snapshot)
  return base
}

/** Session-log projection serving the latest complete REPL binding inventory to the Client. */
export const replMemoryProjection = Object.freeze({
  key: REPL_MEMORY_KEY,
  stateVersion: 2,
  stateSchema: Object.freeze({ parse: normalizeProjectionState }),
  init: () => EMPTY_PROJECTION_STATE,
  apply(state, event) {
    if (event?.type === 'tool/call') return trackReplCall(state, event)
    if (event?.type === 'tool/result') return settleReplCall(state, event)
    return state
  },
  wire: Object.freeze({
    viewSchema: Object.freeze({ parse: normalizeReplMemorySnapshot }),
    view: state => state.memory,
  }),
})
