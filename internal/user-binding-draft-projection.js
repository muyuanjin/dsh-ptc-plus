import { isRecord } from './record-utils.js'

export const USER_BINDING_DRAFT_KEY = 'ptcPlusBindingDraft'
export const USER_BINDING_DRAFT_META_KEY = 'dshPtcPlusBindingDraft'

const META_VERSION = 1
const MAX_GENERATION_LENGTH = 128
const MAX_CAPABILITY_LENGTH = 128
const MAX_COMMAND_ID_LENGTH = 256
const META_FIELDS = new Set(['version', 'generation', 'capability'])
const STATE_FIELDS = new Set([
  'generation', 'phase', 'capability', 'commandId', 'fallbackReady', 'fallbackCommandId',
  'turnStarted',
])
const VIEW_FIELDS = new Set(['phase', 'capability', 'commandId'])
const PHASES = new Set(['idle', 'pending', 'ready', 'failed'])
const ACTION_PREFIX = 'Global User Binding action (persistence does not imply session activation):\n'

function normalizeCandidate(value) {
  if (!isRecord(value) || typeof value.requestId !== 'string' || value.requestId.length === 0
    || value.requestId.length > 128 || !Number.isSafeInteger(value.version) || value.version < 1
    || !['new', 'edit'].includes(value.mode) || !isRecord(value.entry)
    || !['namespace', 'top-level'].includes(value.entry.scope)
    || value.entry.enabled !== false || !Array.isArray(value.entry.symbols)
    || value.entry.symbols.some(symbol => typeof symbol !== 'string')
    || ['id', 'name', 'purpose', 'source'].some(key => typeof value.entry[key] !== 'string')
    || value.entry.source.length === 0 || value.entry.source.length > 65536) {
    throw new Error('invalid dsh-ptc-plus accepted binding candidate')
  }
  return Object.freeze({
    requestId: value.requestId, commandId: normalizeCommandId(value.commandId), version: value.version, mode: value.mode,
    entry: Object.freeze({
      id: value.entry.id, name: value.entry.name, scope: value.entry.scope,
      symbols: Object.freeze([...value.entry.symbols]), purpose: value.entry.purpose,
      source: value.entry.source, enabled: false,
    }),
  })
}

function normalizeAction(value) {
  if (!exactFields(value, new Set(['requestId', 'id', 'state', 'enabled']))
    || typeof value.requestId !== 'string' || value.requestId.length === 0 || value.requestId.length > 128
    || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64
    || !['saved', 'discarded'].includes(value.state) || typeof value.enabled !== 'boolean'
    || (value.state === 'discarded' && value.enabled)) throw new Error('invalid binding action receipt')
  return Object.freeze({ requestId: value.requestId, id: value.id, state: value.state, enabled: value.enabled })
}

export function bindingActionNotice(action) {
  return {
    source: { kind: 'plugin', plugin: 'ptc-plus', form: 'notice', summary: 'Global User Binding action' },
    content: [{ type: 'text', text: ACTION_PREFIX + JSON.stringify(normalizeAction(action)) }],
  }
}

export function readBindingAction(message) {
  if (message?.source?.kind !== 'plugin' || message.source.plugin !== 'ptc-plus'
    || message.source.form !== 'notice' || message.source.summary !== 'Global User Binding action'
    || message.content?.length !== 1 || message.content[0]?.type !== 'text') return undefined
  try {
    const text = message.content[0].text
    if (typeof text !== 'string' || !text.startsWith(ACTION_PREFIX)) return undefined
    const action = normalizeAction(JSON.parse(text.slice(ACTION_PREFIX.length)))
    return text === ACTION_PREFIX + JSON.stringify(action) ? action : undefined
  } catch {
    return undefined
  }
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) throw new Error('invalid binding review history')
  return Object.freeze(value.map(record => {
    const candidate = normalizeCandidate(record.candidate)
    const action = record.action === null ? null : normalizeAction(record.action)
    if (action !== null && (action.requestId !== candidate.requestId || action.id !== candidate.entry.id)) {
      throw new Error('binding action does not identify its candidate')
    }
    if (!Number.isSafeInteger(record.acceptedSeq) || record.acceptedSeq < 0) {
      throw new Error('invalid binding acceptance sequence')
    }
    if (record.commandId !== candidate.commandId) throw new Error('binding review does not identify its command')
    return Object.freeze({
      commandId: normalizeCommandId(record.commandId), acceptedSeq: record.acceptedSeq, candidate, action,
    })
  }))
}

function historyFields(value) {
  return value.history === undefined ? {} : { history: normalizeHistory(value.history) }
}

function exactFields(value, fields) {
  if (!isRecord(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === fields.size && keys.every(key => (
    typeof key === 'string' && fields.has(key)
    && Object.prototype.propertyIsEnumerable.call(value, key)
  ))
}

function normalizeGeneration(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GENERATION_LENGTH) {
    throw new Error('invalid dsh-ptc-plus binding draft generation')
  }
  return value
}

export function normalizeUserBindingDraftCapability(value) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CAPABILITY_LENGTH) {
    throw new Error('invalid dsh-ptc-plus binding draft capability')
  }
  return value
}

function normalizePhase(value) {
  if (typeof value !== 'string' || !PHASES.has(value)) {
    throw new Error('invalid dsh-ptc-plus binding draft phase')
  }
  return value
}

function normalizeCommandId(value) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_COMMAND_ID_LENGTH) {
    throw new Error('invalid dsh-ptc-plus binding draft command id')
  }
  return value
}

/** Read a current-generation draft locator from private result metadata. */
export function userBindingDraftCapabilityFromMeta(meta, generation) {
  if (!isRecord(meta) || !Object.hasOwn(meta, USER_BINDING_DRAFT_META_KEY)) return undefined
  try {
    const normalized = normalizeMetadata(meta[USER_BINDING_DRAFT_META_KEY])
    return normalized.generation === normalizeGeneration(generation)
      ? normalized.capability
      : undefined
  } catch {
    return undefined
  }
}

function normalizeMetadata(value) {
  const modern = value?.version === 2
  if (!exactFields(value, modern ? new Set([...META_FIELDS, 'candidate']) : META_FIELDS)
    || (!modern && value.version !== META_VERSION)) {
    throw new Error('invalid dsh-ptc-plus binding draft metadata')
  }
  return Object.freeze({
    version: value.version,
    generation: normalizeGeneration(value.generation),
    capability: normalizeUserBindingDraftCapability(value.capability),
    ...(modern ? { candidate: value.candidate === null ? null : normalizeCandidate(value.candidate) } : {}),
  })
}

function projectionState(generation, options = {}) {
  const state = {
    generation: normalizeGeneration(generation),
    phase: normalizePhase(options.phase ?? 'idle'),
    capability: normalizeUserBindingDraftCapability(options.capability ?? null),
    commandId: normalizeCommandId(options.commandId ?? null),
    fallbackReady: options.fallbackReady === true,
    fallbackCommandId: normalizeCommandId(options.fallbackCommandId ?? null),
    turnStarted: options.turnStarted === true,
  }
  if (state.phase === 'pending' ? state.commandId === null : state.phase === 'idle' && state.commandId !== null) {
    throw new Error('invalid dsh-ptc-plus binding draft command state')
  }
  if (state.phase !== 'pending' && state.turnStarted) {
    throw new Error('invalid dsh-ptc-plus binding draft turn state')
  }
  if (state.fallbackReady && (state.phase !== 'pending' || state.capability === null)) {
    throw new Error('invalid dsh-ptc-plus binding draft fallback state')
  }
  if (!state.fallbackReady && state.fallbackCommandId !== null) {
    throw new Error('invalid dsh-ptc-plus binding draft fallback state')
  }
  return Object.freeze(state)
}

function failedAuthoringState(generation, state) {
  return !state.fallbackReady
    ? projectionState(generation, {
      phase: 'failed', capability: state.capability, commandId: state.commandId,
    })
    : projectionState(generation, {
      phase: 'ready', capability: state.capability, commandId: state.fallbackCommandId,
    })
}

function normalizeProjectionState(value, generation) {
  if (!exactFields(value, value?.history === undefined ? STATE_FIELDS : new Set([...STATE_FIELDS, 'history']))) {
    throw new Error('invalid dsh-ptc-plus binding draft projection state')
  }
  const currentGeneration = normalizeGeneration(generation)
  if (normalizeGeneration(value.generation) !== currentGeneration) {
    return Object.freeze({ ...projectionState(currentGeneration), ...historyFields(value) })
  }
  return Object.freeze({ ...projectionState(currentGeneration, value), ...historyFields(value) })
}

/** Validate authoring state and source-owned review history for a session Client. */
export function normalizeUserBindingDraftView(value) {
  if (!exactFields(value, value?.history === undefined ? VIEW_FIELDS : new Set([...VIEW_FIELDS, 'history']))) {
    throw new Error('invalid dsh-ptc-plus binding draft projection view')
  }
  return Object.freeze({
    phase: normalizePhase(value.phase),
    capability: normalizeUserBindingDraftCapability(value.capability),
    commandId: normalizeCommandId(value.commandId ?? null),
    ...historyFields(value),
  })
}

/** Attach the revocable locator and optional accepted source to private result metadata. */
export function withUserBindingDraftCapability(meta, capability, generation, candidate) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: meta }
  base[USER_BINDING_DRAFT_META_KEY] = normalizeMetadata({
    version: candidate === undefined ? META_VERSION : 2,
    generation,
    capability,
    ...(candidate === undefined ? {} : { candidate }),
  })
  return base
}

/** Project the latest current-generation draft locator for one session. */
export function createUserBindingDraftProjection(generation) {
  const currentGeneration = normalizeGeneration(generation)
  const projection = {
    key: USER_BINDING_DRAFT_KEY,
    stateVersion: 4,
    stateSchema: Object.freeze({
      parse: value => normalizeProjectionState(value, currentGeneration),
    }),
    init: () => projectionState(currentGeneration),
    apply(state, event) {
      if (event?.type === 'session/end-seed') return projectionState(currentGeneration)
      if (event?.type === 'command/run' && event.data?.name === 'binding') {
        try {
          return projectionState(currentGeneration, {
            phase: 'pending',
            capability: state.capability,
            commandId: event.data.commandId,
            fallbackReady: state.phase === 'ready'
              ? state.capability !== null
              : state.phase === 'pending' && state.fallbackReady,
            fallbackCommandId: state.phase === 'ready'
              ? state.capability === null ? null : state.commandId
              : state.phase === 'pending' ? state.fallbackCommandId : null,
          })
        } catch {
          return state
        }
      }
      if (event?.type === 'command/done' && state.phase === 'pending'
        && event.data?.commandId === state.commandId) {
        return event.data.kind === 'error' ? failedAuthoringState(currentGeneration, state) : state
      }
      if (event?.type === 'turn/start' && state.phase === 'pending' && !state.turnStarted) {
        return projectionState(currentGeneration, { ...state, turnStarted: true })
      }
      if (event?.type === 'turn/end' && state.phase === 'pending' && state.turnStarted) {
        return failedAuthoringState(currentGeneration, state)
      }
      if (event?.type !== 'tool/result'
        || (event.surfaceOp !== undefined && event.surfaceOp !== 'append')) {
        return state
      }
      const raw = event.data?.meta?.[USER_BINDING_DRAFT_META_KEY]
      if (raw === undefined) return state
      try {
        const metadata = normalizeMetadata(raw)
        if (metadata.generation !== currentGeneration) return state
        if (metadata.version === 2 && (state.phase === 'pending' || state.phase === 'failed')
          && metadata.candidate?.commandId !== state.commandId) return state
        if ((state.phase === 'pending' || state.phase === 'failed')
          && metadata.capability === state.capability) return state
        if (metadata.capability !== null) {
          return projectionState(currentGeneration, {
            phase: 'ready',
            capability: metadata.capability,
            commandId: state.commandId,
          })
        }
        return projectionState(currentGeneration)
      } catch {
        return state
      }
    },
    wire: Object.freeze({
      viewSchema: Object.freeze({ parse: normalizeUserBindingDraftView }),
      view: state => normalizeUserBindingDraftView({
        phase: state.phase,
        capability: state.capability,
        commandId: state.commandId,
        ...historyFields(state),
      }),
    }),
  }
  const reduce = projection.apply
  projection.apply = (state, event) => {
    const next = reduce(state, event)
    let history = state.history
    if (event?.type === 'tool/result' && event.surfaceOp === 'append') {
      try {
        const metadata = normalizeMetadata(event.data?.meta?.[USER_BINDING_DRAFT_META_KEY])
        if (metadata.candidate != null && !history?.some(record => (
          record.candidate.requestId === metadata.candidate.requestId
        ))) {
          history = normalizeHistory([...(history ?? []), {
            commandId: metadata.candidate.commandId, acceptedSeq: event.seq, candidate: metadata.candidate, action: null,
          }])
        }
      } catch {
        // Invalid historical presentation cannot invalidate current authoring.
      }
    }
    const action = event?.type === 'user/message' && event.surfaceOp === 'append'
      ? readBindingAction(event.data) : undefined
    if (action !== undefined && history !== undefined) {
      history = normalizeHistory(history.map(record => record.action === null
        && record.candidate.requestId === action.requestId && record.candidate.entry.id === action.id
        && event.sourceEventSeqs?.includes(record.acceptedSeq)
        ? { ...record, action } : record))
    }
    return history === undefined ? next : Object.freeze({ ...next, history })
  }
  return Object.freeze(projection)
}
