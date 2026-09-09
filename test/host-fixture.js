// Shared Cordis host assembly semantics for tests.
//
// Production registers listeners, effects, prompt sections/contexts and tool
// definitions through these surfaces and relies on every registration returning
// its own disposer. A host mock that implements that contract differently makes
// the same plugin behavior pass under one test file and fail under another, so
// the disposal contract lives here once. Each mock composes it with the storage,
// services and failure injection its scenario needs.

const once = action => {
  let active = true
  return () => {
    if (!active) return
    active = false
    return action()
  }
}

const remove = (values, value) => {
  const index = values.indexOf(value)
  if (index !== -1) values.splice(index, 1)
}

// `onListener` observes each `on` registration together with its options, so a
// scenario can assert host-facing registration details while the shared helper
// keeps only the state every consumer needs.
export function createHostContext({ onListener } = {}) {
  const listeners = new Map()
  const cleanups = []
  const sections = []
  const contexts = []
  const toolDefinitions = new Map()

  const on = (name, listener, options) => {
    const entries = listeners.get(name) ?? []
    entries.push(listener)
    listeners.set(name, entries)
    onListener?.(name, listener, options)
    return once(() => {
      remove(entries, listener)
      if (entries.length === 0) listeners.delete(name)
    })
  }

  const effect = register => {
    const cleanup = register()
    const dispose = once(() => cleanup?.())
    cleanups.push(dispose)
    return dispose
  }

  const section = value => {
    sections.push(value)
    return once(() => remove(sections, value))
  }

  const context = value => {
    contexts.push(value)
    return once(() => remove(contexts, value))
  }

  const register = definition => {
    toolDefinitions.set(definition.name, definition)
    return once(() => {
      if (toolDefinitions.get(definition.name) === definition) toolDefinitions.delete(definition.name)
    })
  }

  return {
    ctx: { on, effect, systemPrompt: { context, section }, tools: { register } },
    listeners,
    cleanups,
    sections,
    contexts,
    toolDefinitions,
  }
}

// Host hooks are chained: each listener may call next() to reach the next one.
export function runHookChain(entries, args, fallback) {
  const dispatch = index => entries[index] === undefined
    ? fallback()
    : entries[index](...args, () => dispatch(index + 1))
  return dispatch(0)
}

// Prompt section text is either static or a function of the assembly context.
export function describeSections(sections, context) {
  return [...sections].map(section => ({
    name: section.name,
    text: typeof section.text === 'function' ? section.text(context) : section.text,
  }))
}
