import { assertOwnFields, isRecord } from './record-utils.js'

const FIELDS = new Set(['includeDeclaration', 'instructions', 'enabled', 'declaration'])

/** Validate presentation metadata without loading the source parser in the Client. */
export function normalizeBindingModelContext(value) {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError('binding modelContext must be an object')
  assertOwnFields(value, FIELDS, 'binding modelContext')
  const { includeDeclaration = true, instructions = '', enabled = true, declaration = '' } = value
  if (typeof includeDeclaration !== 'boolean') throw new TypeError('binding modelContext.includeDeclaration must be a boolean')
  if (typeof enabled !== 'boolean') throw new TypeError('binding modelContext.enabled must be a boolean')
  for (const [name, text, limit] of [['instructions', instructions, 4096], ['declaration', declaration, 8192]]) {
    if (typeof text !== 'string' || text.length > limit) {
      throw new TypeError(`binding modelContext.${name} must be a string of at most ${limit} characters`)
    }
  }
  // Preserve fingerprints of previously saved prompt metadata; new edits use only the current fields.
  if (Object.hasOwn(value, 'enabled') || Object.hasOwn(value, 'declaration')) {
    return Object.freeze({ enabled, instructions: instructions.trim(), declaration: declaration.trim(),
      ...(Object.hasOwn(value, 'includeDeclaration') ? { includeDeclaration } : {}) })
  }
  return Object.freeze({ includeDeclaration, instructions: instructions.trim() })
}

export function bindingModelPreferences(value) {
  return {
    includeDeclaration: value?.includeDeclaration ?? value?.enabled ?? true,
    instructions: value?.enabled === false && value.includeDeclaration === undefined ? '' : value?.instructions ?? '',
  }
}
