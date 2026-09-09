import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareProgram } from '../internal/cell-analysis.js'
import { EDIT_LIMITS, editRejectedCell } from '../internal/rejected-cell-editor.js'
import {
  MAX_PARSE_REPAIR_ANCHOR_CODE_UNITS,
  validatedEofClosureRepair,
} from '../internal/validated-parse-repair.js'

const REWRITES = {
  autoRewriteImports: true,
  autoStripExports: true,
  autoSplitRedeclarations: true,
}

function endPosition(source) {
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/u)
  return { line: lines.length, column: lines.at(-1).length + 1 }
}

function prepare(source, knownBindings = new Set()) {
  return prepareProgram(source, { knownBindings: knownBindings, bindingPolicy: true, reservedBindings: new Set(), rewritesEnabled: REWRITES })
}

function repair(source, prepareCandidate = candidate => prepare(candidate), targetCallSeq = 7) {
  return validatedEofClosureRepair({
    source,
    position: endPosition(source),
    prepare: prepareCandidate,
    targetCallSeq,
  })
}

test('proves each single-token EOF closure through the editor and preparation pipeline', () => {
  for (const [source, delimiter] of [
    ['{\n  return 1;', '}'],
    ['return (1 + 2', ')'],
    ['return [1, 2', ']'],
  ]) {
    const result = repair(source)
    assert.equal(result.delimiter, delimiter)
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.arguments), true)
    assert.equal(Object.isFrozen(result.arguments.edits), true)
    assert.equal(Object.isFrozen(result.arguments.edits[0]), true)
    assert.equal(result.arguments.expected_target_call_seq, 7)
    assert.match(result.invocation, /^edit_run_code\(\{"edits":/)
    const encoded = result.invocation.slice('edit_run_code('.length, -1)
    assert.deepEqual(JSON.parse(encoded), result.arguments)
    const edited = editRejectedCell(result.arguments, source)
    assert.equal(edited.edited, true)
    assert.equal(edited.code, source + delimiter)
    assert.doesNotThrow(() => prepare(edited.code))
  }
})

test('requires the exact source EOF and emits single-line escaped arguments', () => {
  const source = '{\r\n  return "line";\u2028'
  assert.equal(validatedEofClosureRepair({
    source,
    position: { line: 1, column: 1 },
    prepare,
    targetCallSeq: 7,
  }), undefined)
  assert.equal(validatedEofClosureRepair({
    source, position: undefined, prepare, targetCallSeq: 7,
  }), undefined)
  assert.equal(validatedEofClosureRepair({
    source, position: endPosition(source), prepare,
  }), undefined)
  assert.equal(repair(source, prepare, -1), undefined)

  const result = repair(source)
  assert.equal(result.delimiter, '}')
  assert.equal(result.invocation.includes('\u2028'), false)
  assert.match(result.invocation, /\\u2028/)
  assert.equal(/[\r\n]/.test(result.invocation), false)

  const surrogate = repair('prefix😀', code => ({
    collisions: code.endsWith('}') ? [] : [{ name: 'not-the-candidate' }],
  }))
  assert.equal(surrogate.arguments.edits[0].old_string, '😀')
})

test('declines ambiguous, non-local, preflight-rejected, or unexpressible repairs', () => {
  for (const source of [
    'const value =',
    "const text = 'unterminated",
    '/* unterminated comment',
    'return ({ value: 1',
  ]) assert.equal(repair(source), undefined)

  assert.equal(repair('unique;', () => ({ collisions: [] })), undefined)
  assert.equal(repair('throwing;', () => { throw new Error('candidate rejected') }), undefined)
  assert.equal(repair('const existing = (1', candidate => prepareProgram(candidate, { knownBindings: new Set(), bindingPolicy: true, reservedBindings: new Set(['existing']), rewritesEnabled: REWRITES })), undefined)
  assert.equal(repair('', code => ({ collisions: code.endsWith('}') ? [] : [{}] })), undefined)

  const repeated = 'a'.repeat(MAX_PARSE_REPAIR_ANCHOR_CODE_UNITS + 1)
  assert.equal(repair(repeated, code => ({
    collisions: code.endsWith('}') ? [] : [{}],
  })), undefined)

  const overEditorBudget = `${'a'.repeat(EDIT_LIMITS.generatedCodeUnits)};`
  assert.equal(repair(overEditorBudget, code => ({
    collisions: code.endsWith('}') ? [] : [{}],
  })), undefined)
})
