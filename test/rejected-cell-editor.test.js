import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EDIT_LIMITS,
  EXPECTED_TARGET_CALL_SEQ,
  editRejectedCell,
  editRunCodeSchema,
} from '../internal/rejected-cell-editor.js'

function rejected(value, source = 'alpha beta gamma', timeoutMs) {
  const result = editRejectedCell(value, source, timeoutMs)
  assert.equal(result.edited, false)
  assert.equal(Object.isFrozen(result), true)
  return result.reason
}

test('publishes the closed edit tool schema', () => {
  const schema = editRunCodeSchema()
  assert.equal(schema.name, 'edit_run_code')
  assert.equal(schema.parameters.type, 'object')
  assert.deepEqual(Object.keys(schema.parameters).sort(), ['oneOf', 'type'])
  assert.equal(schema.parameters.oneOf.length, 2)
  const [exactBranch, regexBranch] = schema.parameters.oneOf
  for (const [branch, operation] of [
    [exactBranch, 'edits'],
    [regexBranch, 'regex_edits'],
  ]) {
    assert.equal(branch.type, 'object')
    assert.equal(branch.additionalProperties, false)
    assert.deepEqual(Object.keys(branch.properties), [operation, EXPECTED_TARGET_CALL_SEQ])
    assert.deepEqual(branch.required, [operation])
    assert.deepEqual(branch.properties[EXPECTED_TARGET_CALL_SEQ], {
      type: 'integer',
      minimum: 0,
      description: 'Optional target precondition copied from a validated diagnostic. The edit is rejected if the captured cell has another call sequence.',
    })
  }
  assert.equal(exactBranch.properties.edits.maxItems, EDIT_LIMITS.exactEdits)
  assert.equal(regexBranch.properties.regex_edits.maxItems, EDIT_LIMITS.regexEdits)
  assert.match(schema.description, /most recent eligible cell captured when this edit call is dispatched/)
  assert.match(schema.description, /successful edit becomes the next eligible cell/)
  assert.match(schema.description, /run the complete corrected cell/)
  assert.match(schema.description, /does not resume at the error location/)
})

test('validates exact edit sets and applies them atomically', () => {
  for (const [value, source, pattern] of [
    [null, 'x', /expects an object/],
    [[], 'x', /expects an object/],
    [{}, 'x', /expects exactly one/],
    [{ edits: [], extra: true }, 'x', /expects exactly one/],
    [{ edits: 'x' }, 'x', /expects exactly one/],
    [{ edits: [], expected_target_call_seq: '1' }, 'x', /non-negative safe integer/],
    [{ edits: [], expected_target_call_seq: -1 }, 'x', /non-negative safe integer/],
    [{ edits: [] }, 'x', /at least one/],
    [{ edits: Array.from({ length: 17 }, () => ({ old_string: 'x', new_string: 'y' })) }, 'x', /at most 16/],
    [{ edits: [null] }, 'x', /must be an object/],
    [{ edits: [[]] }, 'x', /must be an object/],
    [{ edits: [{ old_string: 'x' }] }, 'x', /expects exactly/],
    [{ edits: [{ old_string: 1, new_string: 'y' }] }, 'x', /expects exactly/],
    [{ edits: [{ old_string: '', new_string: 'y' }] }, 'x', /non-empty/],
    [{ edits: [{ old_string: 'x', new_string: 'x' }] }, 'x', /must differ/],
    [{ edits: [{ old_string: 'z', new_string: 'y' }] }, 'x', /not found/],
    [{ edits: [{ old_string: 'x', new_string: 'y' }] }, 'x x', /more than once/],
  ]) assert.match(rejected(value, source), pattern)
  assert.match(
    editRejectedCell({ edits: [{ old_string: 'x', new_string: 'y' }] }, undefined).reason,
    /no run_code cell/,
  )

  const result = editRejectedCell({ edits: [
    { old_string: 'alpha', new_string: 'A' },
    { old_string: 'gamma', new_string: '' },
  ] }, 'alpha beta gamma')
  assert.deepEqual(result, {
    edited: true,
    code: 'A beta ',
    description: 'Edit and run TypeScript cell',
  })
  assert.equal(Object.isFrozen(result), true)

  assert.deepEqual(editRejectedCell({
    edits: [{ old_string: 'alpha', new_string: 'A' }],
    expected_target_call_seq: 12,
  }, 'alpha'), {
    edited: true,
    code: 'A',
    description: 'Edit and run TypeScript cell',
  })

  const expensive = 'x'.repeat(EDIT_LIMITS.exactSearchCodeUnits / 32 + 1)
  assert.match(rejected({ edits: Array.from({ length: 16 }, (_, index) => ({
    old_string: `missing-${index}`, new_string: 'y',
  })) }, expensive), /search budget/)
})

test('implements JavaScript regex replacement templates', () => {
  const result = editRejectedCell({ regex_edits: [{
    pattern: '(?<letter>a)(b)?', flags: '', expected_matches: 1,
    replacement: '$$|$&|$`|$\'|$1|$2|$3|$12|$0|$<letter>|$<missing>',
  }] }, 'xabz')
  assert.equal(result.edited, true)
  assert.equal(result.description, 'Regex-edit and run TypeScript cell')
  assert.equal(result.code, 'x$|ab|x|z|a|b|$3|a2|$0|a|z')

  const absent = editRejectedCell({ regex_edits: [{
    pattern: '(a)?b', flags: '', expected_matches: 1, replacement: '<$1>',
  }] }, 'b')
  assert.equal(absent.code, '<>')

  const unnamed = editRejectedCell({ regex_edits: [{
    pattern: 'a', flags: '', expected_matches: 1, replacement: '$<name>',
  }] }, 'a')
  assert.equal(unnamed.code, '$<name>')
})

test('validates regex edit shapes, matching, and overlap', () => {
  const valid = { pattern: 'a', flags: '', replacement: 'b', expected_matches: 1 }
  for (const [edits, pattern, timeout] of [
    [[], /at least one/],
    [Array.from({ length: 17 }, () => valid), /at most 16/],
    [[null], /must be an object/],
    [[[]], /must be an object/],
    [[{ ...valid, extra: true }], /expects exactly/],
    [[{ ...valid, pattern: 1 }], /expects exactly/],
    [[{ ...valid, pattern: '' }], /non-empty/],
    [[{ ...valid, flags: 'x' }], /unique JavaScript/],
    [[{ ...valid, flags: 'gg' }], /unique JavaScript/],
    [[{ ...valid, expected_matches: 0 }], /between 1/],
    [[{ ...valid, expected_matches: EDIT_LIMITS.regexMatches + 1 }], /between 1/],
    [[{ ...valid, pattern: '(' }], /pattern is invalid/],
    [[{ ...valid, pattern: '^', replacement: 'x' }], /zero-length/],
    [[{ ...valid, expected_matches: 2 }], /found 1/],
    [[{ ...valid, expected_matches: 1 }], /found more than 1/],
    [[valid], /matching budget/, 0],
  ]) {
    const source = edits[0]?.expected_matches === 1 && edits[0]?.pattern === 'a' && timeout === undefined
      ? 'aa'
      : 'a'
    assert.match(rejected({ regex_edits: edits }, source, timeout), pattern)
  }

  assert.match(rejected({ regex_edits: [valid, { ...valid, replacement: 'c' }] }, 'a'), /overlaps/)
  assert.match(rejected({ regex_edits: [{ ...valid, replacement: '$&' }] }, 'a'), /must change/)
})

test('enforces regex and generated-source budgets before assembly', () => {
  const valid = { pattern: 'a', flags: '', replacement: 'b', expected_matches: 1 }
  assert.match(rejected({ regex_edits: [
    { ...valid, expected_matches: EDIT_LIMITS.regexMatches },
    valid,
  ] }, 'a'), /matches in total/)
  assert.match(rejected({ regex_edits: [{
    ...valid, replacement: 'x'.repeat(EDIT_LIMITS.regexTemplateCodeUnits + 1),
  }] }, 'a'), /replacement templates/)
  assert.match(rejected({ regex_edits: [{
    ...valid,
    expected_matches: EDIT_LIMITS.regexMatches,
    replacement: '$&'.repeat(Math.floor(EDIT_LIMITS.regexExpansionSteps / EDIT_LIMITS.regexMatches) + 1),
  }] }, 'a'), /expansion step budget/)

  const captures = Array.from({ length: 17 }, () => '(a)').join('')
  const source = 'a'.repeat(17 * EDIT_LIMITS.regexMatches)
  assert.match(rejected({ regex_edits: [{
    pattern: captures, flags: '', replacement: 'b', expected_matches: EDIT_LIMITS.regexMatches,
  }] }, source), /capture-slot budget/)

  assert.match(rejected({ edits: [{
    old_string: 'x', new_string: 'y'.repeat(EDIT_LIMITS.generatedCodeUnits + 1),
  }] }, 'x'), /replacement output/)
  assert.match(rejected({ edits: [{ old_string: 'x', new_string: 'yy' }] },
    `${'a'.repeat(EDIT_LIMITS.generatedCodeUnits)}x`), /edited source/)
})
