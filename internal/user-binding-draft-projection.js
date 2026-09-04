import { isRecord } from './record-utils.js'

export const USER_BINDING_DRAFT_KEY = 'ptcPlusBindingDraft'
export const USER_BINDING_DRAFT_META_KEY = 'dshPtcPlusBindingDraft'

const META_VERSION = 1
const MAX_GENERATION_LENGTH = 128
const MAX_CAPABILITY_LENGTH = 128
const META_FIELDS = new Set(['version', 'generation', 'capability'])
const STATE_FIELDS = new Set(['generation', 'capability'])

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
  if (!exactFields(value, META_FIELDS) || value.version !== META_VERSION) {
    throw new Error('invalid dsh-ptc-plus binding draft metadata')
  }
  return Object.freeze({
    version: META_VERSION,
    generation: normalizeGeneration(value.generation),
    capability: normalizeUserBindingDraftCapability(value.capability),
  })
}

function projectionState(generation, capability = null) {
  return Object.freeze({
    generation: normalizeGeneration(generation),
    capability: normalizeUserBindingDraftCapability(capability),
  })
}

function normalizeProjectionState(value, generation) {
  if (!exactFields(value, STATE_FIELDS)) {
    throw new Error('invalid dsh-ptc-plus binding draft projection state')
  }
  const currentGeneration = normalizeGeneration(generation)
  if (normalizeGeneration(value.generation) !== currentGeneration) {
    return projectionState(currentGeneration)
  }
  return projectionState(currentGeneration, value.capability)
}

/** Attach only the opaque in-memory draft locator to private result metadata. */
export function withUserBindingDraftCapability(meta, capability, generation) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: meta }
  base[USER_BINDING_DRAFT_META_KEY] = normalizeMetadata({
    version: META_VERSION,
    generation,
    capability,
  })
  return base
}

/** Project the latest current-generation draft locator for one session. */
export function createUserBindingDraftProjection(generation) {
  const currentGeneration = normalizeGeneration(generation)
  return Object.freeze({
    key: USER_BINDING_DRAFT_KEY,
    stateVersion: 1,
    stateSchema: Object.freeze({
      parse: value => normalizeProjectionState(value, currentGeneration),
    }),
    init: () => projectionState(currentGeneration),
    apply(state, event) {
      if (event?.type === 'session/end-seed') return projectionState(currentGeneration)
      if (event?.type !== 'tool/result' || (event.surfaceOp !== undefined && event.surfaceOp !== 'append')) {
        return state
      }
      const raw = event.data?.meta?.[USER_BINDING_DRAFT_META_KEY]
      if (raw === undefined) return state
      try {
        const metadata = normalizeMetadata(raw)
        return metadata.generation === currentGeneration
          ? projectionState(currentGeneration, metadata.capability)
          : state
      } catch {
        return state
      }
    },
    wire: Object.freeze({
      viewSchema: Object.freeze({ parse: normalizeUserBindingDraftCapability }),
      view: state => state.capability,
    }),
  })
}
