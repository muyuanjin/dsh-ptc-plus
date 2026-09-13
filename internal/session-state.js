// Runtime state transitions shared by the session coordinator and cell executor.

import { userBindingCatalogEntries } from './user-bindings.js'
import { LEGACY_USER_BINDINGS_SHADOW_POLICY } from './session-journal-schema.js'
import { advanceLegacyBindings } from './legacy-binding-catalog.js'
import { dynamicBindingOrigin } from './dynamic-binding-evidence.js'
import { LEGACY_LANGUAGE_SEMANTICS, normalizeLanguageSemantics } from './language-semantics.js'

/**
 * Reuse counts belong to a logical binding identity, not to one declaration
 * occurrence. Every catalog transition carries the previous count forward by
 * name, so a redeclaration can change the definition without resetting how many
 * later cells reused the binding.
 */
function carryReuseCounts(entries, previousEntries) {
  for (const [name, entry] of entries) {
    const previous = previousEntries.get(name)
    if (previous?.reuseCount === undefined || entry.reuseCount === previous.reuseCount) continue
    entries.set(name, { ...entry, reuseCount: previous.reuseCount })
  }
}

/** One settled cell contributes at most one reuse event per identity its
 * rewritten source statically references; the count is a source fact, not a
 * runtime trace of which references executed. */
function applyReuseEvents(entries, previousEntries, reusedNames) {
  for (const name of new Set(reusedNames ?? [])) {
    const entry = entries.get(name)
    if (entry === undefined || previousEntries.get(name) === undefined) continue
    entries.set(name, { ...entry, reuseCount: (entry.reuseCount ?? 0) + 1 })
  }
}

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
  #rootCandidates
  #dynamicOrigins

  constructor({ entries = new Map(), namespaces = new Set(), userBindingAncestry = new Set(), rootCandidates = new Map(), dynamicOrigins = new Map() } = {}) {
    this.#entries = new Map([...entries].map(([name, entry]) => [name, Object.freeze({ ...entry })]))
    this.#namespaces = new Set(namespaces)
    // A closure can perform its first implicit assignment in a later cell.
    // Its source plan is ancestry, not an initialized binding or provider shadow.
    this.#rootCandidates = new Map(rootCandidates)
    this.#dynamicOrigins = new Map(dynamicOrigins)
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
      knownBindings: new Set([...this.#entries]
        .filter(([, entry]) => entry.unavailable !== true)
        .map(([name]) => name)),
      importBindings: new Map([...this.#entries]
        .filter(([, entry]) => entry.import !== undefined)
        .map(([name, entry]) => [name, entry.import])),
      importNamespaces: new Set(this.#namespaces),
      writableBindings: new Set([...this.#entries]
        .filter(([, entry]) => entry.writable === true)
        .map(([name]) => name)),
      nativeBindings: new Set([...this.#entries].filter(([, entry]) => entry.native === true).map(([name]) => name)),
      nativeLexicalBindings: new Set([...this.#entries].filter(([, entry]) => entry.nativeLexical === true).map(([name]) => name)),
      rootCandidates: new Map([...this.#rootCandidates].map(([target, declaration]) => [target, declaration.name])),
      dynamicOrigins: [...this.#dynamicOrigins.keys()],
      establishedRoots: new Map([...this.#entries].filter(([, entry]) => entry.rootSource !== undefined)
        .map(([name, entry]) => [name, entry.rootSource])),
    }
  }

  advance(prepared, source = undefined, committedRedeclarations = undefined, rootBindingFacts = undefined) {
    const semantics = normalizeLanguageSemantics(prepared.languageSemantics ?? LEGACY_LANGUAGE_SEMANTICS)
    if (semantics === LEGACY_LANGUAGE_SEMANTICS) {
      const legacy = advanceLegacyBindings(this.#entries, prepared, sourceDefinitionExtractor(source), committedRedeclarations)
      const nativePublications = new Set(prepared.moduleLoads.flatMap(load => (load.nativePublications ?? []).map(binding => binding.name)))
      for (const [name, entry] of legacy.entries) {
        if (entry.rootSource === undefined && entry.origin === undefined && entry.userBindingState === undefined) {
          legacy.entries.set(name, { ...entry, native: true,
            nativeLexical: this.#entries.get(name)?.nativeLexical === true || prepared.nativeLexicals?.has(name) === true })
        }
      }
      for (const fact of rootBindingFacts ?? []) {
        const previous = legacy.entries.get(fact.name)
        if (previous !== undefined) legacy.entries.set(fact.name, { ...previous,
          native: this.#entries.get(fact.name)?.native || nativePublications.has(fact.name) && fact.source !== 'absent',
          import: this.#entries.get(fact.name)?.import,
        })
      }
      applyRootBindingFacts(legacy.entries, rootBindingFacts, this.#rootCandidates, this.#dynamicOrigins,
        prepared.imports, this.#entries)
      // The frozen legacy-v1 preparation reports no reference facts, so a
      // legacy cell contributes no reuse event; accumulated counts still carry
      // across the transition.
      carryReuseCounts(legacy.entries, this.#entries)
      return new BindingCatalog({
        ...legacy,
        userBindingAncestry: this.#userBindingAncestry,
        rootCandidates: this.#rootCandidates,
        dynamicOrigins: this.#dynamicOrigins,
      })
    }
    const entries = new Map(this.#entries)
    const committed = committedRedeclarations ?? prepared.commitTargets
    const extractDefinition = sourceDefinitionExtractor(source)
    const rootCandidates = new Map(this.#rootCandidates)
    const dynamicOrigins = new Map(this.#dynamicOrigins)
    for (const origin of prepared.dynamicOrigins ?? []) {
      dynamicOrigins.set(origin.target, extractDefinition(origin.definitionSpan))
    }
    for (const declaration of prepared.implicitDeclarations ?? []) {
      rootCandidates.set(declaration.target, { name: declaration.name, kind: 'variable', writable: true,
        definition: extractDefinition(declaration.definitionSpan) })
    }
    const commitOrder = new Map([...committed].map((target, index) => [target, index]))
    const declarations = prepared.declarations.filter(declaration => committed.has(declaration.commitDependency))
      .sort((left, right) => commitOrder.get(left.commitDependency) - commitOrder.get(right.commitDependency))
    for (const declaration of declarations) {
      const previous = entries.get(declaration.name)
      entries.set(declaration.name, { kind: declaration.kind,
        writable: declaration.writable,
        ...(previous?.nativeLexical === true ? { nativeLexical: true } : {}),
        definition: extractDefinition(declaration.definitionSpan) ?? previous?.definition,
        import: declaration.kind === 'import' ? prepared.imports.get(declaration.name) : undefined,
      })
    }
    // Value provenance follows actual commits, including repeated loop targets.
    // The inventory separately presents accepted declarations in source order.
    for (const { name } of declarations.sort((left, right) => left.span.line - right.span.line
      || left.span.column - right.span.column)) {
      const entry = entries.get(name)
      entries.delete(name)
      entries.set(name, entry)
    }
    applyRootBindingFacts(entries, rootBindingFacts, rootCandidates, dynamicOrigins, prepared.imports, this.#entries)
    carryReuseCounts(entries, this.#entries)
    applyReuseEvents(entries, this.#entries, prepared.reusedNames)
    return new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry, rootCandidates, dynamicOrigins })
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
    carryReuseCounts(entries, this.#entries)
    return Object.freeze({
      catalog: new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry, rootCandidates: this.#rootCandidates, dynamicOrigins: this.#dynamicOrigins }),
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
          rootSource: previous?.rootSource,
          native: previous?.native,
          nativeLexical: previous?.nativeLexical,
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
    carryReuseCounts(entries, this.#entries)
    return new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry, rootCandidates: this.#rootCandidates, dynamicOrigins: this.#dynamicOrigins })
  }

  withoutUserBindings() {
    const entries = new Map([...this.#entries].filter(([, entry]) => entry.origin?.kind !== 'user-global'))
    return new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry, rootCandidates: this.#rootCandidates, dynamicOrigins: this.#dynamicOrigins })
  }

  shadowUserBindings(names) {
    const entries = new Map(this.#entries)
    for (const name of names) {
      const entry = entries.get(name)
      if (entry?.origin?.kind !== 'user-global') continue
      entries.set(name, { ...entry, origin: undefined, definition: undefined })
    }
    return new BindingCatalog({ entries, namespaces: this.#namespaces, userBindingAncestry: this.#userBindingAncestry, rootCandidates: this.#rootCandidates, dynamicOrigins: this.#dynamicOrigins })
  }

  snapshot() {
    return [...this.#entries].reverse()
      .filter(([name, entry]) => !this.#namespaces.has(name) && entry.unavailable !== true)
      .map(([name, entry]) => ({
        name,
        kind: entry.kind,
        reuseCount: entry.reuseCount ?? 0,
        ...(entry.definition === undefined ? {} : { definition: entry.definition }),
      }))
  }
}

function applyRootBindingFacts(entries, facts, rootCandidates, dynamicOrigins, imports, previousEntries) {
  for (const fact of facts ?? []) {
    const origin = dynamicBindingOrigin(fact.write, fact.name, dynamicOrigins)
    const write = rootCandidates.get(fact.write) ?? (origin === undefined ? undefined
      : { name: fact.name, kind: 'variable', writable: true, definition: dynamicOrigins.get(origin) })
    const previous = entries.get(fact.name) ?? write
    if (previous === undefined) continue
    const root = { ...previous, rootSource: fact.source,
      ...(write === undefined ? {} : { definition: write.definition }) }
    if (fact.source === 'local') entries.set(fact.name, { ...root, unavailable: false, import: undefined, origin: undefined,
      ...(previous.import === undefined && write === undefined ? {} : { kind: 'variable', writable: true }) })
    else if (fact.source === 'absent') entries.set(fact.name, { ...root, unavailable: true, import: undefined })
    else entries.set(fact.name, { ...root, unavailable: false, import: imports.get(fact.name) ?? previousEntries.get(fact.name)?.import })
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
