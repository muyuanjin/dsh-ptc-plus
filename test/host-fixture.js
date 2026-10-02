// Shared Cordis host assembly semantics for tests.
//
// Production registers listeners, effects, prompt sections/contexts and tool
// definitions through these surfaces and relies on every registration returning
// its own disposer. A host mock that implements that contract differently makes
// the same plugin behavior pass under one test file and fail under another, so
// the disposal contract lives here once. Each mock composes it with the storage,
// services and failure injection its scenario needs.

import { createExecutionSeam } from '../internal/execution-seam-compat.js'

export function createFixtureExecutionProvider(original, serviceName = 'ptcRuntime') {
  return createExecutionSeam(original, serviceName).provider
}

export function executionInstalled(provider) {
  return createExecutionSeam(provider, 'codeRuntime').active
}

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

// Minimal `ctx.inject` for fixtures that call `apply` themselves. Cordis runs an
// injected callback once every named service is available, and never runs it
// otherwise. A fixture can expose a service through its service map or public
// context, but every requested service must be present before activation.
export function serviceInjector(services, host) {
  const pending = new Set()
  const failures = []
  const inject = (names, callback) => {
    const context = host()
    const owned = []
    const fiber = { state: 2 }
    const dispose = once(async () => {
      fiber.state = 3
      for (const cleanup of owned.reverse()) await cleanup()
    })
    fiber.dispose = dispose
    context.effect?.(() => dispose)
    const required = new Map(names.map(name => {
      const provided = services[name] === undefined ? context.get?.(name) : services[name]
      return [name, provided === undefined ? context[name] : provided]
    }))
    if ([...required.values()].every(service => service !== undefined)) {
      const scope = Object.create(context)
      for (const [name, service] of required) {
        Object.defineProperty(scope, name, { configurable: true, enumerable: true, value: service })
      }
      scope.fiber = fiber
      scope.get = name => required.has(name) ? required.get(name) : context.get?.(name)
      const requireActive = () => {
        if (fiber.state === 3) throw new Error('injected fixture lifetime disposed')
      }
      scope.effect = register => {
        requireActive()
        const cleanup = register()
        const release = once(() => cleanup?.())
        owned.push(release)
        return release
      }
      scope.on = (...args) => {
        requireActive()
        const release = context.on(...args)
        owned.push(release)
        return release
      }
      scope.inject = (...args) => {
        requireActive()
        const release = typeof context.inject === 'function' ? context.inject(...args) : inject(...args)
        owned.push(() => typeof release === 'function' ? release() : release?.dispose?.())
        return release
      }
      const activation = callback(scope)
      if (typeof activation?.then === 'function') {
        let settlement
        settlement = Promise.resolve(activation)
          .catch(error => { failures.push(error) })
          .finally(() => pending.delete(settlement))
        pending.add(settlement)
      }
    }
    return dispose
  }
  inject.settle = async () => {
    while (pending.size > 0) await Promise.all([...pending])
    return Object.freeze([...failures])
  }
  return inject
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
