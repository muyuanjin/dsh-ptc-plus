// Runtime state transitions shared by the session coordinator and cell executor.

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
  #known
  #kinds
  #definitions
  #imports
  #namespaces
  #writable

  constructor(
    known = new Set(),
    imports = new Map(),
    namespaces = new Set(),
    kinds = new Map(),
    definitions = new Map(),
    writable = new Set(),
  ) {
    this.#known = new Set(known)
    this.#kinds = new Map([...this.#known].map(name => [name, kinds.get(name) ?? 'variable']))
    this.#definitions = new Map([...this.#known]
      .filter(name => definitions.has(name))
      .map(name => [name, definitions.get(name)]))
    this.#imports = new Map(imports)
    this.#namespaces = new Set(namespaces)
    this.#writable = new Set([...writable].filter(name => this.#known.has(name)))
    Object.freeze(this)
  }

  inputs() {
    return {
      knownBindings: new Set(this.#known),
      importBindings: new Map(this.#imports),
      importNamespaces: new Set(this.#namespaces),
      writableBindings: new Set(this.#writable),
    }
  }

  advance(prepared, source = undefined, committedRedeclarations = undefined) {
    const known = new Set(this.#known)
    const kinds = new Map(this.#kinds)
    const definitions = new Map(this.#definitions)
    const writable = new Set(this.#writable)
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
      kinds.set(declaration.name, declaration.kind ?? 'variable')
      const definition = extractDefinition(declaration.definitionSpan)
      if (definition !== undefined) definitions.set(declaration.name, definition)
      if (!redeclared.has(declaration.name)) {
        if (declaration.writable === true) writable.add(declaration.name)
        else writable.delete(declaration.name)
      }
    }
    for (const name of prepared.declared) {
      if (!uncommitted.has(name)) touched.add(name)
    }
    for (const name of touched) {
      known.delete(name)
      known.add(name)
    }
    const imports = new Map(prepared.imports)
    for (const [name, binding] of imports) {
      if (typeof binding?.commitDependency !== 'string'
        || !commitGated.has(binding.commitDependency)
        || committed.has(binding.commitDependency)) continue
      if (this.#imports.has(name)) imports.set(name, this.#imports.get(name))
      else imports.delete(name)
    }
    return new BindingCatalog(known, imports, prepared.importNamespaces, kinds, definitions, writable)
  }

  snapshot() {
    return [...this.#known].reverse()
      .filter(name => !this.#namespaces.has(name))
      .map(name => ({
        name,
        kind: this.#kinds.get(name) ?? 'variable',
        ...(this.#definitions.has(name) ? { definition: this.#definitions.get(name) } : {}),
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
