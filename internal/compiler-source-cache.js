import { copyCompilerData } from './compiler-data.js'

/** Cache source-derived metadata within one compiler generation. Input and
 * output data stay private; callers receive fresh collections on every read. */
export function createCompilerSourceCache(compute, { maxEntries = 64, maxCharacters = 512 * 1024 } = {}) {
  const entries = new Map()
  let characters = 0
  return (source, transform) => {
    // Unsupported inputs retain the owner's original validation and errors.
    if (typeof source !== 'string' || transform !== undefined && typeof transform !== 'string') {
      return compute(source, transform)
    }
    const key = JSON.stringify([source, transform])
    const cached = entries.get(key)
    if (cached !== undefined) {
      entries.delete(key)
      entries.set(key, cached)
      return copyCompilerData(cached.value)
    }
    const value = compute(source, transform)
    if (maxEntries > 0 && key.length <= maxCharacters) {
      while (entries.size >= maxEntries || characters + key.length > maxCharacters) {
        const oldest = entries.keys().next().value
        entries.delete(oldest)
        characters -= oldest.length
      }
      entries.set(key, { value })
      characters += key.length
    }
    return copyCompilerData(value)
  }
}
