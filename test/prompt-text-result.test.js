import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLASS_REDECLARATION_REWRITE,
  FUNCTION_REDECLARATION_REWRITE,
  MIXED_REDECLARATION_REWRITE,
} from '../internal/repl-rewrite-contract.js'
import { prepareLegacyProgram } from '../internal/legacy-cell-analysis.js'
import {
  PROMPT_TEXT_DEFAULT,
  RESULT_ENVELOPE,
  resolvePromptText,
  resultEnvelopeText,
  rewriteDescriptions,
  validatePromptTextDocument,
} from '../internal/prompt-text.js'

const policy = { variableRedeclarations: true, functionClassRedeclarations: true }
const rewrites = { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }
const options = { bindingPolicy: policy, rewritesEnabled: rewrites }
const document = overrides => JSON.stringify({ schema: 'ptc-prompt-text/v1', overrides })

test('an empty document reproduces the historical rewrite descriptions and envelope', () => {
  const defaults = rewriteDescriptions(resolvePromptText(PROMPT_TEXT_DEFAULT))
  assert.deepEqual(defaults, {
    mixed: MIXED_REDECLARATION_REWRITE,
    function: FUNCTION_REDECLARATION_REWRITE,
    class: CLASS_REDECLARATION_REWRITE,
  })
  const envelope = resultEnvelopeText(resolvePromptText(PROMPT_TEXT_DEFAULT), 64)
  assert.equal(envelope, RESULT_ENVELOPE.replace('{maxOutputBytes}', '64'))
  assert.match(envelope, /^output exceeded 64 bytes; this cell was discarded/u)
})

test('a customized rewrite description reaches the delivered rewrite without changing the code', () => {
  const source = 'function report() { return 1 }\nreport()'
  const known = new Set(['report'])
  const commitSignal = 'commit'
  const writable = new Set(['report'])
  const plain = prepareLegacyProgram(source, { ...options, knownBindings: known, writableBindings: writable, commitSignal })
  const custom = prepareLegacyProgram(source, {
    ...options,
    knownBindings: known,
    writableBindings: writable,
    commitSignal,
    rewriteDescriptions: rewriteDescriptions(resolvePromptText(document({ 'rewrite.function': 'reused the earlier function' }))),
  })
  assert.ok(plain.rewrites.length > 0, 'the fixture must actually rewrite a declaration')
  assert.equal(plain.rewrites[0].description, FUNCTION_REDECLARATION_REWRITE)
  assert.equal(custom.rewrites[0].description, 'reused the earlier function')
  // Presentation only: the rewrite kind, its source name, the executable code and
  // the collision evidence are the recognizer's input and must not move.
  assert.equal(custom.rewrites[0].kind, plain.rewrites[0].kind)
  assert.equal(custom.rewrites[0].source, plain.rewrites[0].source)
  assert.equal(custom.code, plain.code)
  assert.deepEqual(custom.collisions, plain.collisions)
  assert.deepEqual(custom.redeclared, plain.redeclared)
})

test('a projected placeholder is validated on save and never invents a number', () => {
  assert.throws(() => validatePromptTextDocument(document({ 'plan.overageSentence': 'over budget' })),
    /must keep exactly one \{overageBytes\} placeholder/u)
  assert.throws(() => validatePromptTextDocument(document({ 'plan.overageSentence': 'x {overageBytes} y {overageBytes}' })),
    /must keep exactly one \{overageBytes\} placeholder/u)
  assert.doesNotThrow(() => validatePromptTextDocument(document({ 'plan.overageSentence': 'over by {overageBytes} bytes.' })))
  // The envelope is read-only: an override is refused outright, and its rendered
  // form always reports the byte count it was given.
  assert.throws(() => validatePromptTextDocument(document({ 'result.envelope': 'output exceeded 64 bytes' })),
    /read-only \(fact-derived\)/u)
  assert.match(resultEnvelopeText(resolvePromptText(document({})), 128), /^output exceeded 128 bytes/u)
})
