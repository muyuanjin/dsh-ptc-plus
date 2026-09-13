import { createHash } from 'node:crypto'
import { identifier, exportedSymbols, sourceDurability } from './compiler-service.js'
import { assertOwnFields, isRecord } from './record-utils.js'
import { bindingModelPreferences, normalizeBindingModelContext } from './user-binding-model-context.js'
import { supportedUserBindingTransform, USER_BINDING_TRANSFORM } from './module-transform-contract.js'

export const USER_BINDINGS_META_KEY = 'dshPtcPlusUserBindings'
export const USER_BINDINGS_SNAPSHOT_VERSION = 2

const MAX_ENTRIES = 64
export const USER_BINDING_ID_MAX_LENGTH = 64
const MAX_NAME_LENGTH = 128
const MAX_PURPOSE_LENGTH = 240
const MAX_SOURCE_LENGTH = 64 * 1024
const MAX_SOURCE_TOTAL_LENGTH = 256 * 1024
const MAX_DECLARATION_TOTAL_LENGTH = 16 * 1024
const DOCUMENT_FIELDS = new Set(['entries'])
const ENTRY_FIELDS = new Set(['id', 'name', 'scope', 'symbols', 'purpose', 'enabled', 'source', 'modelContext'])
const LEGACY_SNAPSHOT_FIELDS = new Set(['version', 'revision', 'fingerprint', 'entries'])
const SNAPSHOT_FIELDS = new Set([...LEGACY_SNAPSHOT_FIELDS, 'transform'])
const SNAPSHOT_ENTRY_FIELDS = new Set([...ENTRY_FIELDS, 'fingerprint', 'declaration', 'bindings', 'durability', 'volatileReason'])
const BINDING_FIELDS = new Set(['name', 'kind', 'declaration'])
const SCOPES = new Set(['namespace', 'top-level'])
const KINDS = new Set(['variable', 'function', 'class'])

function displayName(value) {
  if (typeof value !== 'string') throw new TypeError('binding name must be a string')
  const name = value.replace(/\s+/g, ' ').trim()
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`binding name must contain 1-${MAX_NAME_LENGTH} characters`)
  }
  return name
}


function normalizePurpose(value) {
  if (typeof value !== 'string') throw new TypeError('binding purpose must be a string')
  const purpose = value.replace(/\s+/g, ' ').trim()
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new TypeError(`binding purpose must not exceed ${MAX_PURPOSE_LENGTH} characters`)
  }
  return purpose
}

function entryFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function selectedDescriptors(source, symbols, transform) {
  const exported = exportedSymbols(source, transform)
  const selected = symbols === undefined || symbols.length === 0 ? [...exported.keys()] : symbols
  const unique = new Set()
  return selected.map((name) => {
    identifier(name, 'binding symbol')
    if (unique.has(name)) throw new TypeError(`binding symbol ${JSON.stringify(name)} is duplicated`)
    unique.add(name)
    const descriptor = exported.get(name)
    if (descriptor === undefined) throw new TypeError(`binding symbol ${JSON.stringify(name)} is not a named value export`)
    return descriptor
  })
}


function declarationFor(entry, descriptors) {
  const comment = entry.purpose === '' ? '' : `/** ${entry.purpose.replaceAll('*/', '* /')} */\n`
  if (entry.scope === 'namespace') {
    return `${comment}declare const ${entry.name}: {\n${descriptors.map(item => `  ${item.member};`).join('\n')}\n}`
  }
  return descriptors.map((item, index) => `${index === 0 ? comment : ''}declare ${item.declaration}`).join('\n')
}

export function normalizeUserBindingEntry(value, { transform = USER_BINDING_TRANSFORM } = {}) {
  if (!isRecord(value)) throw new TypeError('binding entry must be an object')
  const permitted = new Set([...ENTRY_FIELDS].filter(field => field !== 'symbols'))
  if (Object.hasOwn(value, 'symbols')) permitted.add('symbols')
  assertOwnFields(value, permitted, 'binding entry')
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)) {
    throw new TypeError(`binding id must match [A-Za-z0-9][A-Za-z0-9._-]{0,${USER_BINDING_ID_MAX_LENGTH - 1}}`)
  }
  const scope = value.scope ?? 'namespace'
  if (!SCOPES.has(scope)) throw new TypeError('binding scope must be namespace or top-level')
  const name = scope === 'namespace'
    ? identifier(value.name, 'binding name')
    : displayName(value.name)
  if (typeof value.source !== 'string' || value.source.length === 0 || value.source.length > MAX_SOURCE_LENGTH) {
    throw new TypeError(`binding source must contain 1-${MAX_SOURCE_LENGTH} characters`)
  }
  if (typeof value.enabled !== 'boolean') throw new TypeError('binding enabled must be a boolean')
  const purpose = normalizePurpose(value.purpose ?? '')
  if (value.symbols !== undefined && !Array.isArray(value.symbols)) {
    throw new TypeError('binding symbols must be an array')
  }
  const descriptors = selectedDescriptors(value.source, value.symbols, transform)
  if (scope === 'namespace') identifier(name, 'binding name', true)
  else descriptors.forEach(item => identifier(item.name, 'binding symbol', true))
  const durability = sourceDurability(value.source, transform)
  const symbols = descriptors.map(item => item.name)
  const modelContext = normalizeBindingModelContext(value.modelContext)
  const stored = Object.freeze({
    id: value.id,
    name,
    scope,
    symbols: Object.freeze(symbols),
    purpose,
    enabled: value.enabled,
    source: value.source,
    ...(modelContext === undefined ? {} : { modelContext }),
  })
  const effectivePurpose = purpose || normalizePurpose(
    descriptors.map(item => item.purpose).find(candidate => candidate !== '') ?? '',
  )
  const declarationEntry = effectivePurpose === purpose
    ? stored
    : { ...stored, purpose: effectivePurpose }
  const bindings = scope === 'namespace'
    ? [Object.freeze({ name, kind: 'variable', declaration: declarationFor(declarationEntry, descriptors) })]
    : descriptors.map(item => Object.freeze({
        name: item.name,
        kind: item.kind,
        declaration: declarationFor({
          ...stored,
          purpose: item === descriptors[0] ? effectivePurpose : '',
        }, [item]),
      }))
  return Object.freeze({
    ...stored,
    fingerprint: entryFingerprint(stored),
    declaration: declarationFor(declarationEntry, descriptors),
    bindings: Object.freeze(bindings),
    ...durability,
  })
}

function validateConflicts(entries) {
  const ids = new Set()
  const activeNames = new Map()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new TypeError(`binding id ${JSON.stringify(entry.id)} is duplicated`)
    ids.add(entry.id)
    if (!entry.enabled) continue
    const names = entry.scope === 'namespace' ? [entry.name] : entry.symbols
    for (const name of names) {
      const existing = activeNames.get(name)
      if (existing !== undefined) {
        throw new TypeError(`active binding ${JSON.stringify(name)} conflicts between entries ${JSON.stringify(existing)} and ${JSON.stringify(entry.id)}`)
      }
      activeNames.set(name, entry.id)
    }
  }
}

function validateAggregateBudgets(entries, includeDeclarations) {
  const sourceLength = entries.reduce((total, entry) => total + entry.source.length, 0)
  if (sourceLength > MAX_SOURCE_TOTAL_LENGTH) {
    throw new TypeError(`binding sources exceed the ${MAX_SOURCE_TOTAL_LENGTH} character document limit`)
  }
  if (!includeDeclarations) return
  const declarationLength = entries.reduce((total, entry) => total + entry.declaration.length, 0)
    + Math.max(0, entries.length - 1) * 2
  if (declarationLength > MAX_DECLARATION_TOTAL_LENGTH) {
    throw new TypeError(`binding declarations exceed the ${MAX_DECLARATION_TOTAL_LENGTH} character model-context limit`)
  }
  const modelLength = entries.reduce((total, entry) => {
    const { includeDeclaration, instructions } = bindingModelPreferences(entry.modelContext)
    return total + (includeDeclaration ? entry.declaration.length : 0) + instructions.length
  }, 0)
  if (modelLength > MAX_DECLARATION_TOTAL_LENGTH) {
    throw new TypeError(`binding model context exceeds the ${MAX_DECLARATION_TOTAL_LENGTH} character model-context limit`)
  }
}

export function normalizeUserBindingsDocument(value) {
  if (!isRecord(value)) throw new TypeError('bindings document must be an object')
  assertOwnFields(value, DOCUMENT_FIELDS, 'bindings document')
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new TypeError(`bindings document must contain at most ${MAX_ENTRIES} entries`)
  }
  const entries = value.entries.map(normalizeUserBindingEntry)
  validateAggregateBudgets(entries, false)
  validateConflicts(entries)
  return Object.freeze({ entries: Object.freeze(entries) })
}

function snapshotFingerprint(revision, entries, transform) {
  return entryFingerprint({
    revision,
    entries: entries.map(entry => entry.fingerprint),
    ...(transform === undefined ? {} : { transform }),
  })
}

export function createUserBindingsSnapshot(document, revision = 0) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('binding revision must be a non-negative safe integer')
  const normalized = normalizeUserBindingsDocument(document)
  const entries = normalized.entries.filter(entry => entry.enabled)
  validateAggregateBudgets(entries, true)
  return Object.freeze({
    version: USER_BINDINGS_SNAPSHOT_VERSION,
    transform: USER_BINDING_TRANSFORM,
    revision,
    fingerprint: snapshotFingerprint(revision, entries, USER_BINDING_TRANSFORM),
    entries: Object.freeze(entries),
  })
}

export function normalizeUserBindingsSnapshot(value) {
  if (!isRecord(value)) throw new TypeError('user binding snapshot must be an object')
  const legacy = value.version === 1
  assertOwnFields(value, legacy ? LEGACY_SNAPSHOT_FIELDS : SNAPSHOT_FIELDS, 'user binding snapshot')
  if ((!legacy && value.version !== USER_BINDINGS_SNAPSHOT_VERSION)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new TypeError('invalid user binding snapshot')
  }
  // Unrecorded or unsupported lowering cannot prove historical module values.
  if (legacy ? value.entries.length > 0 : !supportedUserBindingTransform(value.transform)) {
    throw new TypeError('user binding snapshot cannot prove its historical TypeScript transform')
  }
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry)) throw new TypeError('invalid user binding snapshot entry')
    assertOwnFields(entry, SNAPSHOT_ENTRY_FIELDS, 'user binding snapshot entry')
    const normalized = normalizeUserBindingEntry(Object.fromEntries(
      [...ENTRY_FIELDS].filter(field => Object.hasOwn(entry, field)).map(field => [field, entry[field]]),
    ), { transform: value.transform })
    if (entry.fingerprint !== normalized.fingerprint || entry.declaration !== normalized.declaration
      || entry.durability !== normalized.durability
      || entry.volatileReason !== normalized.volatileReason
      || !Array.isArray(entry.bindings) || entry.bindings.length !== normalized.bindings.length) {
      throw new TypeError('user binding snapshot entry does not match its source')
    }
    entry.bindings.forEach((binding, index) => {
      assertOwnFields(binding, BINDING_FIELDS, 'user binding snapshot binding')
      const expected = normalized.bindings[index]
      if (!KINDS.has(binding.kind) || binding.name !== expected.name
        || binding.kind !== expected.kind || binding.declaration !== expected.declaration) {
        throw new TypeError('user binding snapshot binding does not match its source')
      }
    })
    if (!normalized.enabled) throw new TypeError('user binding snapshot cannot contain a disabled entry')
    return normalized
  })
  validateAggregateBudgets(entries, true)
  validateConflicts(entries)
  if (value.fingerprint !== snapshotFingerprint(value.revision, entries, value.transform)) {
    throw new TypeError('user binding snapshot fingerprint does not match its entries')
  }
  return Object.freeze({
    version: value.version,
    ...(legacy ? {} : { transform: value.transform }),
    revision: value.revision,
    fingerprint: value.fingerprint,
    entries: Object.freeze(entries),
  })
}

export function userBindingsDeclaration(snapshot) {
  const normalized = normalizeUserBindingsSnapshot(snapshot)
  return normalized.entries.map(entry => entry.declaration).join('\n\n')
}

export function userBindingsConfiguredContext(snapshot) {
  const entries = normalizeUserBindingsSnapshot(snapshot).entries
    .filter(entry => {
      const { includeDeclaration, instructions } = bindingModelPreferences(entry.modelContext)
      return includeDeclaration || instructions !== ''
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  if (entries.length === 0) return undefined
  const content = entries.map(entry => {
    const { includeDeclaration, instructions } = bindingModelPreferences(entry.modelContext)
    return [
      `Binding: ${entry.name}`,
      instructions,
      includeDeclaration ? `\`\`\`ts\n${entry.declaration}\n\`\`\`` : '',
    ].filter(Boolean).join('\n\n')
  }).join('\n\n')
  return {
    name: 'tools:ptc-plus-user-binding-defaults',
    text: content,
  }
}

export function userBindingCatalogEntries(snapshot) {
  const normalized = normalizeUserBindingsSnapshot(snapshot)
  return normalized.entries.flatMap(entry => entry.bindings.map(binding => ({
    name: binding.name,
    kind: binding.kind,
    entryId: entry.id,
    fingerprint: entry.fingerprint,
    definition: Object.freeze({ source: binding.declaration, line: 1, column: 1 }),
  })))
}

export function selectUserBindingsSnapshot(snapshot, entryIds) {
  const normalized = normalizeUserBindingsSnapshot(snapshot)
  const ids = entryIds instanceof Set ? entryIds : new Set(entryIds)
  const entries = Object.freeze(normalized.entries.filter(entry => ids.has(entry.id)))
  return Object.freeze({
    ...normalized,
    fingerprint: snapshotFingerprint(normalized.revision, entries, normalized.transform),
    entries,
  })
}

export function storedUserBindingsDocument(document) {
  const projected = isRecord(document) && Array.isArray(document.entries)
    ? {
        entries: document.entries.map(entry => isRecord(entry)
          ? Object.fromEntries([...ENTRY_FIELDS]
              .filter(field => Object.hasOwn(entry, field))
              .map(field => [field, entry[field]]))
          : entry),
      }
    : document
  const normalized = normalizeUserBindingsDocument(projected)
  return {
    entries: normalized.entries.map(entry => ({
      id: entry.id,
      name: entry.name,
      scope: entry.scope,
      symbols: [...entry.symbols],
      purpose: entry.purpose,
      enabled: entry.enabled,
      source: entry.source,
      ...(entry.modelContext === undefined ? {} : { modelContext: entry.modelContext }),
    })),
  }
}

/** Merge the exact request snapshot into private tool-result metadata. */
export function withUserBindingsSnapshot(meta, snapshot) {
  const base = isRecord(meta) ? { ...meta } : meta === undefined ? {} : { value: meta }
  base[USER_BINDINGS_META_KEY] = normalizeUserBindingsSnapshot(snapshot)
  return base
}

/** Read one validated snapshot from private result metadata. */
export function userBindingsSnapshotFromMeta(meta) {
  if (!isRecord(meta) || !Object.hasOwn(meta, USER_BINDINGS_META_KEY)) return undefined
  return normalizeUserBindingsSnapshot(meta[USER_BINDINGS_META_KEY])
}

/** Compare snapshots without trusting caller-owned object identity. */
export function userBindingsSnapshotsEqual(left, right) {
  if (left === undefined || right === undefined) return left === right
  try {
    return JSON.stringify(normalizeUserBindingsSnapshot(left))
      === JSON.stringify(normalizeUserBindingsSnapshot(right))
  } catch {
    return false
  }
}
