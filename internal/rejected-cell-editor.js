import { runInNewContext } from 'node:vm'

const DEFAULT_REGEX_TIMEOUT_MS = 100
export const EDIT_LIMITS = Object.freeze({
  exactEdits: 16,
  exactSearchCodeUnits: 16 * 1024 * 1024,
  regexEdits: 16,
  regexMatches: 4_096,
  regexTemplateCodeUnits: 16 * 1024,
  regexExpansionSteps: 64 * 1024,
  regexCaptureSlots: 64 * 1024,
  generatedCodeUnits: 1024 * 1024,
})

const EDIT_RUN_CODE_EXECUTION_DESCRIPTION = 'Edit and run TypeScript cell'
const REGEX_EDIT_RUN_CODE_EXECUTION_DESCRIPTION = 'Regex-edit and run TypeScript cell'
export const EXPECTED_TARGET_CALL_SEQ = 'expected_target_call_seq'

const REGEX_MATCH_SCRIPT = `(() => {
  const replacements = []
  let captureSlots = 0
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex]
    let expression
    try {
      expression = new RegExp(rule.pattern, (rule.flags.includes('g') ? rule.flags : rule.flags + 'g') + 'd')
    } catch (error) {
      return { error: 'regex_edits[' + ruleIndex + '].pattern is invalid: ' + error.message }
    }
    let count = 0
    for (const match of source.matchAll(expression)) {
      if (match[0].length === 0) {
        return { error: 'regex_edits[' + ruleIndex + '] must not produce zero-length matches' }
      }
      count += 1
      if (count > rule.expected_matches) break
      captureSlots += match.indices.length - 1
      if (captureSlots > maxCaptureSlots) {
        return { error: 'regex_edits exceed the ' + maxCaptureSlots + ' capture-slot budget' }
      }
      const named = match.indices.groups
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        captures: Array.from(match.indices).slice(1),
        groups: named === undefined
          ? undefined
          : Object.fromEntries(Object.entries(named)),
        ruleIndex,
      })
    }
    if (count !== rule.expected_matches) {
      return {
        error: 'regex_edits[' + ruleIndex + '] expected ' + rule.expected_matches
          + (count > rule.expected_matches
              ? ' matches but found more than ' + rule.expected_matches
              : ' matches but found ' + count),
      }
    }
  }
  return { replacements }
})()`

function rejection(reason) {
  return Object.freeze({ edited: false, reason })
}

function exactReplacements(edits, source) {
  if (edits.length === 0) return { error: 'edits must contain at least one replacement' }
  if (edits.length > EDIT_LIMITS.exactEdits) {
    return { error: `edits must contain at most ${EDIT_LIMITS.exactEdits} replacements` }
  }
  for (const [index, edit] of edits.entries()) {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      return { error: `edits[${index}] must be an object` }
    }
    const keys = Object.keys(edit)
    if (keys.length !== 2 || !keys.includes('old_string') || !keys.includes('new_string')
      || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
      return { error: `edits[${index}] expects exactly old_string and new_string strings` }
    }
    if (edit.old_string.length === 0) return { error: `edits[${index}].old_string must be non-empty` }
    if (edit.old_string === edit.new_string) {
      return { error: `edits[${index}].old_string and new_string must differ` }
    }
  }
  const searchWork = source.length * edits.length * 2
  if (!Number.isSafeInteger(searchWork) || searchWork > EDIT_LIMITS.exactSearchCodeUnits) {
    return { error: `edits exceed the ${EDIT_LIMITS.exactSearchCodeUnits} source-code-unit search budget` }
  }
  const replacements = []
  for (const [index, edit] of edits.entries()) {
    const start = source.indexOf(edit.old_string)
    if (start < 0) return { error: `edits[${index}].old_string was not found in the target cell` }
    if (source.indexOf(edit.old_string, start + 1) >= 0) {
      return { error: `edits[${index}].old_string occurs more than once in the target cell` }
    }
    replacements.push({ start, end: start + edit.old_string.length, text: edit.new_string, index })
  }
  return { replacements }
}

function replacementParts(template) {
  const parts = []
  let cursor = 0
  for (const token of template.matchAll(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g)) {
    if (token.index > cursor) parts.push(template.slice(cursor, token.index))
    parts.push({ token: token[0], marker: token[1], groupName: token[2] })
    cursor = token.index + token[0].length
  }
  if (cursor < template.length) parts.push(template.slice(cursor))
  return parts
}

function sourcePart(range, suffix = '') {
  return range === undefined
    ? { text: suffix }
    : { start: range[0], end: range[1], suffix }
}

function resolvePart(part, match, sourceLength) {
  if (typeof part === 'string') return { text: part }
  const { token, marker, groupName } = part
  if (marker === '$') return { text: '$' }
  if (marker === '&') return sourcePart([match.start, match.end])
  if (marker === '`') return sourcePart([0, match.start])
  if (marker === "'") return sourcePart([match.end, sourceLength])
  if (marker.startsWith('<')) {
    if (match.groups === undefined) return { text: token }
    return sourcePart(match.groups[groupName])
  }
  let captureIndex = Number(marker)
  let suffix = ''
  if (captureIndex > match.captures.length && marker.length === 2) {
    captureIndex = Number(marker[0])
    suffix = marker[1]
  }
  if (captureIndex === 0 || captureIndex > match.captures.length) return { text: token }
  return sourcePart(match.captures[captureIndex - 1], suffix)
}

function regexReplacements(edits, source, timeoutMs) {
  if (edits.length === 0) return { error: 'regex_edits must contain at least one replacement' }
  if (edits.length > EDIT_LIMITS.regexEdits) {
    return { error: `regex_edits must contain at most ${EDIT_LIMITS.regexEdits} replacements` }
  }
  let matches = 0
  let templateLength = 0
  let expansionSteps = 0
  const parsed = []
  for (const [index, edit] of edits.entries()) {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      return { error: `regex_edits[${index}] must be an object` }
    }
    const keys = Object.keys(edit)
    if (keys.length !== 4 || !keys.includes('pattern') || !keys.includes('flags')
      || !keys.includes('replacement') || !keys.includes('expected_matches')
      || typeof edit.pattern !== 'string' || typeof edit.flags !== 'string'
      || typeof edit.replacement !== 'string' || !Number.isSafeInteger(edit.expected_matches)) {
      return { error: `regex_edits[${index}] expects exactly pattern, flags, replacement, and integer expected_matches` }
    }
    if (edit.pattern.length === 0) return { error: `regex_edits[${index}].pattern must be non-empty` }
    if (!/^[gimsu]*$/.test(edit.flags) || new Set(edit.flags).size !== edit.flags.length) {
      return { error: `regex_edits[${index}].flags must contain unique JavaScript g, i, m, s, or u flags` }
    }
    if (edit.expected_matches < 1 || edit.expected_matches > EDIT_LIMITS.regexMatches) {
      return { error: `regex_edits[${index}].expected_matches must be between 1 and ${EDIT_LIMITS.regexMatches}` }
    }
    const parts = replacementParts(edit.replacement)
    matches += edit.expected_matches
    templateLength += edit.replacement.length
    expansionSteps += edit.expected_matches * parts.length
    if (matches > EDIT_LIMITS.regexMatches) {
      return { error: `regex_edits must produce at most ${EDIT_LIMITS.regexMatches} matches in total` }
    }
    if (templateLength > EDIT_LIMITS.regexTemplateCodeUnits) {
      return { error: `regex_edits replacement templates exceed the ${EDIT_LIMITS.regexTemplateCodeUnits} UTF-16 code-unit budget` }
    }
    if (expansionSteps > EDIT_LIMITS.regexExpansionSteps) {
      return { error: `regex_edits exceed the ${EDIT_LIMITS.regexExpansionSteps} replacement-expansion step budget` }
    }
    parsed.push({
      ...edit,
      parts,
    })
  }
  let result
  try {
    result = runInNewContext(REGEX_MATCH_SCRIPT, {
      source,
      rules: parsed.map(({ parts: _parts, ...rule }) => rule),
      maxCaptureSlots: EDIT_LIMITS.regexCaptureSlots,
    }, { timeout: timeoutMs })
  } catch (error) {
    return { error: `regex editing failed or exceeded its ${timeoutMs}ms matching budget: ${error.message}` }
  }
  if (result.error !== undefined) return result
  return { replacements: result.replacements.map(match => ({
    start: match.start,
    end: match.end,
    parts: parsed[match.ruleIndex].parts,
    match,
    index: match.ruleIndex,
  })) }
}

function resolvedPartLength(part) {
  return part.text === undefined ? part.end - part.start + part.suffix.length : part.text.length
}

function materializePart(part, source) {
  return part.text === undefined ? source.slice(part.start, part.end) + part.suffix : part.text
}

function preflightAssembly(source, replacements) {
  let generatedLength = source.length
  let replacementLength = 0
  const prepared = []
  for (const replacement of replacements) {
    const parts = replacement.text === undefined
      ? replacement.parts.map(part => resolvePart(part, replacement.match, source.length))
      : [{ text: replacement.text }]
    let textLength = 0
    for (const part of parts) {
      textLength += resolvedPartLength(part)
    }
    replacementLength += textLength
    generatedLength += textLength - (replacement.end - replacement.start)
    prepared.push({ ...replacement, parts })
  }
  if (replacementLength > EDIT_LIMITS.generatedCodeUnits) {
    return { error: `replacement output exceeds the ${EDIT_LIMITS.generatedCodeUnits} UTF-16 code-unit budget` }
  }
  if (generatedLength > EDIT_LIMITS.generatedCodeUnits) {
    return { error: `edited source exceeds the ${EDIT_LIMITS.generatedCodeUnits} UTF-16 code-unit budget` }
  }
  return { replacements: prepared }
}

function assemble(source, replacements) {
  const chunks = []
  let cursor = 0
  let changed = false
  for (const replacement of replacements) {
    const text = replacement.parts.map(part => materializePart(part, source)).join('')
    chunks.push(source.slice(cursor, replacement.start), text)
    cursor = replacement.end
    if (text.length !== replacement.end - replacement.start
      || !source.startsWith(text, replacement.start)) changed = true
  }
  chunks.push(source.slice(cursor))
  return changed ? { code: chunks.join('') } : { error: 'edits must change at least one matched fragment' }
}

function editRunCodeParameterBranch(operation, operationSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      [operation]: operationSchema,
      [EXPECTED_TARGET_CALL_SEQ]: {
        type: 'integer', minimum: 0,
        description: 'Optional target precondition copied from a validated diagnostic. The edit is rejected if the captured cell has another call sequence.',
      },
    },
    required: [operation],
  }
}

export function editRunCodeSchema() {
  return {
    name: 'edit_run_code',
    description: 'Make a small exact or regular-expression change to the most recent eligible cell captured when this edit call is dispatched, then run the complete corrected cell. A successful edit becomes the next eligible cell. Use this only when replaying the whole cell is safe. If earlier code may already have caused an external effect, use a new run_code cell and its existing variables instead; this tool does not resume at the error location. Send exactly one atomic edits or regex_edits array, plus expected_target_call_seq only when a diagnostic supplies it to bind a validated repair to its rejected cell. Choose edits for a few unique literal fragments; choose regex_edits when one counted pattern covers repeated fragments. Every resolved range must be non-overlapping in the original cell.',
    parameters: {
      type: 'object',
      oneOf: [
        editRunCodeParameterBranch('edits', {
          type: 'array', minItems: 1, maxItems: EDIT_LIMITS.exactEdits,
          description: 'Atomic exact replacements, all resolved against the original target cell.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              old_string: { type: 'string', minLength: 1, description: 'Exact text in the target cell. It must occur exactly once.' },
              new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
            },
            required: ['old_string', 'new_string'],
          },
        }),
        editRunCodeParameterBranch('regex_edits', {
          type: 'array', minItems: 1, maxItems: EDIT_LIMITS.regexEdits,
          description: 'Atomic regular-expression replacements, all matched against the original target cell.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              pattern: { type: 'string', minLength: 1, description: 'JavaScript regular-expression source. Zero-length matches are rejected.' },
              flags: { type: 'string', pattern: '^(?!.*(.).*\\1)[gimsu]*$', description: 'Unique JavaScript g, i, m, s, or u flags. Global matching is always applied.' },
              replacement: { type: 'string', description: 'JavaScript replacement template, including capture references such as $1 or $<name>.' },
              expected_matches: { type: 'integer', minimum: 1, maximum: EDIT_LIMITS.regexMatches, description: 'Exact match count required before any replacement is applied.' },
            },
            required: ['pattern', 'flags', 'replacement', 'expected_matches'],
          },
        }),
      ],
    },
  }
}

export function editRejectedCell(value, source, timeoutMs = DEFAULT_REGEX_TIMEOUT_MS) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return rejection('edit_run_code expects an object with exactly one edits or regex_edits array')
  }
  const keys = Object.keys(value)
  const operationKeys = keys.filter(key => key === 'edits' || key === 'regex_edits')
  if (operationKeys.length !== 1 || keys.length > 2
    || keys.some(key => !['edits', 'regex_edits', EXPECTED_TARGET_CALL_SEQ].includes(key))
    || !Array.isArray(value[operationKeys[0]])) {
    return rejection('edit_run_code expects exactly one edits or regex_edits array')
  }
  if (Object.hasOwn(value, EXPECTED_TARGET_CALL_SEQ)
    && (!Number.isSafeInteger(value[EXPECTED_TARGET_CALL_SEQ])
      || value[EXPECTED_TARGET_CALL_SEQ] < 0)) {
    return rejection('edit_run_code expected_target_call_seq must be a non-negative safe integer')
  }
  if (source === undefined) return rejection('no run_code cell is currently eligible for safe editing')
  const operation = operationKeys[0]
  const resolved = operation === 'edits'
    ? exactReplacements(value.edits, source)
    : regexReplacements(value.regex_edits, source, timeoutMs)
  if (resolved.error !== undefined) return rejection(resolved.error)
  const replacements = resolved.replacements.sort((left, right) => left.start - right.start)
  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index].start < replacements[index - 1].end) {
      return rejection(`${operation}[${replacements[index].index}] overlaps ${operation}[${replacements[index - 1].index}] in the target cell`)
    }
  }
  const preflight = preflightAssembly(source, replacements)
  if (preflight.error !== undefined) {
    return rejection(operation === 'regex_edits' ? preflight.error.replace(/^edits/, 'regex_edits') : preflight.error)
  }
  const assembled = assemble(source, preflight.replacements)
  if (assembled.error !== undefined) {
    return rejection(operation === 'regex_edits' ? assembled.error.replace(/^edits/, 'regex_edits') : assembled.error)
  }
  return Object.freeze({
    edited: true,
    code: assembled.code,
    description: operation === 'edits'
      ? EDIT_RUN_CODE_EXECUTION_DESCRIPTION
      : REGEX_EDIT_RUN_CODE_EXECUTION_DESCRIPTION,
  })
}
