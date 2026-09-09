// Runtime state transitions shared by the session coordinator and cell executor.

import { userBindingCatalogEntries } from './user-bindings.js'
import { LEGACY_USER_BINDINGS_SHADOW_POLICY } from './session-journal-schema.js'

export function durabilityState(overrides = {}) {
  return Object.freeze({
    status: 'durable',
    reason: undefined,
    ...overrides,
  })
}

export function transitionDurability(state, transition) {
  if (transition.type !== 'volatile') return state
  return durabilityState({
    ...state,
    status: 'volatile',
    reason: state.reason ?? transition.reason,
  })
}

export class BindingCatalog {
  #entries
  #namespaces
  #userBindingAncestry

  constructor({ entries = new Map(), namespaces = new Set(), userBindingAncestry = new Set() } = {}) {
    this.#entries = new Map([...entries].map(([name, entry]) => [name, Object.freeze({ ...entry })]))
    this.#namespaces = new Set(namespaces)
    // Escaped provider setters may create local values after their entries are
    // removed. Eligibility follows the catalog ancestry, not the visible inventory.
    this.#userBindingAncestry = new Set([
      ...userBindingAncestry,
      ...[...entries].filter(([, entry]) => entry.origin?.kind === 'user-global').map(([name]) => name),
    ])
    Object.freeze(this)
  }

  inputs() {
    return {
      knownBindings: new Set([...this.#entries].filter(([, entry]) => entry.unavailable !== true).map(([name]) => name)),
      importBindings: new Map([...this.#entries]
        .filter(([, entry]) => entry.import !== undefined)
        .map(([name, entry]) => [name, entry.import])),
      importNamespaces: new Set(this.#namespaces),
      writableBindings: new Set([...this.#entries]
        .filter(([, entry]) => entry.writable === true)
        .map(([name]) => name)),
    }
  }

  advance(prepared, source = undefined, committedRedeclarations = undefined) {
    const entries = new Map(this.#entries)
    const touched = new Set()
    const redeclared = new Set((prepared.redeclared ?? []).map(declaration => declaration.name))
    const commitGated = prepared.commitTargets
    const committed = committedRedeclarations instanceof Set
      ? committedRedeclarations
      : new Set([...redeclared, ...commitGated])
    const uncommitted = new Set()
    const extractDefinition = sourceDefinitionExtractor(source)
    for (const declaration of prepared.declarations ?? []) {
      if (typeof declaration?.name !== 'string') continue
      const dependency = typeof declaration.commitDependency === 'string'
        && commitGated.has(declaration.commitDependency)
        ? declaration.commitDependency
        : commitGated.has(declaration.name) ? declaration.name : undefined
      if (dependency !== undefined && !committed.has(dependency)) {
        uncommitted.add(declaration.name)
        continue
      }
      touched.add(declaration.name)
      const previous = entries.get(declaration.name)
      const definition = extractDefinition(declaration.definitionSpan)
      entries.set(declaration.name, {
        kind: declaration.kind ?? 'variable',
        definition: definition ?? previous?.definition,
        writable: redeclared.has(declaration.name) ? previous?.writable === true : declaration.writable === true,
      })
    }
    for (const name of prepared.declared) {
      if (!uncommitted.has(name)) touched.add(name)
    }
    for (const name of touched) {
      const entry = entries.get(name) ?? { kind: 'variable', writable: false }
      entries.delete(name)
      entries.set(name, entry)
    }
    const imports = new Map(prepared.imports)
    for (const [name, binding] of imports) {
      if (typeof binding?.commitDependency !== 'string'
        || !commitGated.has(binding.commitDependency)
        || committed.has(binding.commitDependency)) continue
      if (this.#entries.get(name)?.import !== undefined) imports.set(name, this.#entries.get(name).import)
      else imports.delete(name)
    }
    for (const [name, entry] of entries) entries.set(name, { ...entry, import: imports.get(name) })
    return new BindingCatalog({ entries, namespaces: prepared.importNamespaces, userBindingAncestry: this.#userBindingAncestry })
  }

  userBindings(snapshot, activeEntryIds = undefined, shadowPolicy = LEGACY_USER_BINDINGS_SHADOW_POLICY) {
    const candidates = (snapshot === undefined ? [] : userBindingCatalogEntries(snapshot))
      .filter(entry => activeEntryIds === undefined || activeEntryIds.has(entry.entryId))
    const shadowedNames = new Set([...this.#entries]
      .filter(([, entry]) => entry.origin?.kind !== 'user-global')
      .map(([name]) => name))
    const shadowedEntryIds = new Set(candidates
      .filter(entry => shadowedNames.has(entry.name))
      .map(entry => entry.entryId))
    const desired = new Map(candidates.filter(entry => shadowPolicy === LEGACY_USER_BINDINGS_SHADOW_POLICY
      ? !shadowedEntryIds.has(entry.entryId) : !shadowedNames.has(entry.name))
      .map(entry => [entry.name, entry]))
    const entries = new Map(this.#entries)
    for (const [name, { origin }] of entries) {
      if (origin?.kind !== 'user-global') continue
      const next = desired.get(name)
      if (next !== undefined && next.entryId === origin.entryId
        && next.fingerprint === origin.fingerprint) continue
      entries.delete(name)
    }

    for (const entry of desired.values()) {
      entries.delete(entry.name)
      entries.set(entry.name, {
        kind: entry.kind,
        definition: entry.definition,
        writable: true,
        origin: Object.freeze({ kind: 'user-global', entryId: entry.entryId, fingerprint: entry.fingerprint }),
      })
    }
    return Object.freeze({
      catalog: new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry }),
      shadowedNames,
    })
  }

  userBindingNameSet(snapshot, includeProviderAncestry = false) {
    return new Set([
      ...(includeProviderAncestry ? this.#userBindingAncestry : []),
      ...[...this.#entries].filter(([, entry]) => (entry.userBindingState !== undefined
        && (includeProviderAncestry || entry.userBindingState !== 'provider'))
        || (includeProviderAncestry && entry.origin?.kind === 'user-global')).map(([name]) => name),
      ...(snapshot === undefined ? [] : userBindingCatalogEntries(snapshot).map(entry => entry.name)),
    ])
  }

  /** Actual worker sources override static declaration plans at this one boundary. */
  reconcileUserBindingNames(snapshot, facts, source = undefined) {
    const entries = new Map(this.#entries)
    const candidates = new Map((snapshot === undefined ? [] : userBindingCatalogEntries(snapshot)).map(entry => [entry.name, entry]))
    for (const [name, entry] of entries) {
      if (entry.origin?.kind === 'user-global') entries.delete(name)
    }
    for (const fact of facts) {
      const previous = this.#entries.get(fact.name)
      if (fact.state === 'provider') {
        const candidate = candidates.get(fact.name)
        entries.set(fact.name, {
          kind: candidate.kind, definition: candidate.definition, writable: true, userBindingState: 'provider',
          origin: Object.freeze({ kind: 'user-global', entryId: candidate.entryId, fingerprint: candidate.fingerprint }),
        })
      } else {
        entries.set(fact.name, {
          kind: previous?.kind ?? 'variable',
          // Preserve compiler-owned import accessors while replacing only the
          // per-name user-binding proof. Imports are the canonical storage for
          // aliases and must remain available to the next preparation pass.
          import: previous?.import,
          definition: previous?.origin === undefined && previous?.definition !== undefined
            ? previous.definition
            : fact.state === 'local' && typeof source === 'string' && source.length > 0
              ? Object.freeze({ source: source.slice(0, MAX_DEFINITION_SOURCE_LENGTH), line: 1, column: 1 }) : undefined,
          writable: previous?.writable ?? true,
          userBindingState: fact.state,
          unavailable: fact.state !== 'local',
        })
      }
    }
    return new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry })
  }

  withoutUserBindings() {
    const entries = new Map([...this.#entries].filter(([, entry]) => entry.origin?.kind !== 'user-global'))
    return new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry })
  }

  shadowUserBindings(names) {
    const entries = new Map(this.#entries)
    for (const name of names) {
      const entry = entries.get(name)
      if (entry?.origin?.kind !== 'user-global') continue
      entries.set(name, { ...entry, origin: undefined, definition: undefined })
    }
    return new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry })
  }

  snapshot() {
    return [...this.#entries].reverse()
      .filter(([name, entry]) => !this.#namespaces.has(name) && entry.unavailable !== true)
      .map(([name, entry]) => ({
        name,
        kind: entry.kind,
        ...(entry.definition === undefined ? {} : { definition: entry.definition }),
      }))
  }
}

const MAX_DEFINITION_SOURCE_LENGTH = 1024

function lineOffsets(source) {
  const offsets = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1)
  }
  return offsets
}

function offsetAt(offsets, sourceLength, position) {
  if (position === null || typeof position !== 'object'
    || !Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1
    || position.line > offsets.length) return undefined
  const lineStart = offsets[position.line - 1]
  const lineEnd = position.line < offsets.length ? offsets[position.line] - 1 : sourceLength
  const offset = lineStart + position.column - 1
  return offset <= lineEnd ? offset : undefined
}

function sourceDefinitionExtractor(source) {
  const offsets = typeof source === 'string' ? lineOffsets(source) : undefined
  const extracted = new Map()
  return span => {
    if (offsets === undefined || span === null || typeof span !== 'object') return undefined
    const start = offsetAt(offsets, source.length, span)
    const end = offsetAt(offsets, source.length, span.end)
    if (start === undefined || end === undefined || end <= start) return undefined
    const key = `${start}:${end}`
    if (extracted.has(key)) return extracted.get(key)
    const length = end - start
    const bounded = length <= MAX_DEFINITION_SOURCE_LENGTH
      ? source.slice(start, end)
      : `${source.slice(start, start + MAX_DEFINITION_SOURCE_LENGTH - 3)}...`
    if (bounded.length === 0) return undefined
    const definition = Object.freeze({ source: bounded, line: span.line, column: span.column })
    extracted.set(key, definition)
    return definition
  }
}
