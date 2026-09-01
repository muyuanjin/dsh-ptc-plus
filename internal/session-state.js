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
  #imports
  #namespaces

  constructor(known = new Set(), imports = new Map(), namespaces = new Set(), kinds = new Map()) {
    this.#known = new Set(known)
    this.#kinds = new Map([...this.#known].map(name => [name, kinds.get(name) ?? 'variable']))
    this.#imports = new Map(imports)
    this.#namespaces = new Set(namespaces)
    Object.freeze(this)
  }

  inputs() {
    return {
      knownBindings: new Set(this.#known),
      importBindings: new Map(this.#imports),
      importNamespaces: new Set(this.#namespaces),
    }
  }

  advance(prepared) {
    const known = new Set(this.#known)
    const kinds = new Map(this.#kinds)
    for (const declaration of prepared.declarations ?? []) {
      if (typeof declaration?.name !== 'string') continue
      kinds.set(declaration.name, declaration.kind ?? 'variable')
    }
    for (const name of prepared.declared) known.add(name)
    return new BindingCatalog(known, prepared.imports, prepared.importNamespaces, kinds)
  }

  snapshot() {
    return [...this.#known]
      .filter(name => !this.#namespaces.has(name))
      .map(name => ({ name, kind: this.#kinds.get(name) ?? 'variable' }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  }
}
