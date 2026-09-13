import { copyCompilerData } from './compiler-data.js'

/** Reuse syntax preparation, never an eval activation or its values. Callable
 * source facts are live inputs and must still match before a result is reused. */
export function createCachedDynamicCompiler(compute, { maxEntries = 64, maxCharacters = 2 * 1024 * 1024 } = {}) {
  const entries = new Map()
  let characters = 0
  return (source, options = {}) => {
    const { resolveOriginalSource, ...syntax } = options
    // Cell plans carry operation owners and generation-specific callbacks.
    if (syntax.cell !== undefined || typeof source !== 'string') return compute(source, options)
    const key = JSON.stringify([source, syntax])
    if (maxEntries <= 0 || key.length > maxCharacters) return compute(source, options)
    const resolved = new Map()
    const resolve = text => {
      if (!resolved.has(text)) resolved.set(text, resolveOriginalSource?.(text))
      return resolved.get(text)
    }
    const cached = entries.get(key)
    if (cached !== undefined) {
      entries.delete(key)
      characters -= cached.characters
      if (cached.sources.every(([text, original]) => resolve(text) === original)) {
        entries.set(key, cached)
        characters += cached.characters
        return copyCompilerData(cached.value)
      }
    }
    const sources = new Map()
    const value = compute(source, { ...syntax, resolveOriginalSource(text) {
      const original = resolve(text)
      sources.set(text, original)
      return original
    } })
    const record = { value, sources: [...sources] }
    record.characters = key.length + JSON.stringify(record).length
    if (record.characters <= maxCharacters) {
      while (entries.size >= maxEntries || characters + record.characters > maxCharacters) {
        const oldest = entries.keys().next().value
        characters -= entries.get(oldest).characters
        entries.delete(oldest)
      }
      entries.set(key, record)
      characters += record.characters
    }
    return copyCompilerData(value)
  }
}
