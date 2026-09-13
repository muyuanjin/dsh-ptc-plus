import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareProgram } from '../internal/cell-analysis.js'
import { normalizeStatefulScopes, preserveStatementBoundaries } from '../internal/repl-scope-normalizer.js'
import { fixture } from './plugin-fixture.js'

const OPTIONS = { knownBindings: new Set(), reservedBindings: new Set() }

const compiled = source => prepareProgram(source, { ...OPTIONS, languageSemantics: 'stateful-v1' })

async function runCells(bindingUpdates, cells) {
  const state = fixture({ bindingUpdates })
  try {
    let result
    for (const source of cells) {
      result = await state.run('boundary-session', source)
      if (result.error !== undefined) throw result.error
    }
    return result.value
  } finally {
    await state.dispose()
  }
}

test('makes a statement boundary explicit before a rewritten leading reference', () => {
  // Only a statement whose rewrite can lead with `(` is guarded: an expression
  // statement, a declaration, an exported declaration or default value, or a
  // block-level function declaration. Already-separated sources stay byte-equal.
  assert.equal(preserveStatementBoundaries('function f(){}\nfunction g(){}').code,
    'function f(){}\nfunction g(){}')
  assert.equal(preserveStatementBoundaries('a();\nb()').code, 'a();\nb()')
  assert.equal(preserveStatementBoundaries('a()').code, 'a()')
  // Program, block, static block, switch case, and directive boundaries.
  assert.equal(preserveStatementBoundaries('a()\nb()').code, 'a();\nb()')
  assert.equal(preserveStatementBoundaries('{\n a()\n b()\n}').code, '{\n a();\n b()\n}')
  assert.equal(preserveStatementBoundaries('class C { static {\n a()\n b()\n } }').code,
    'class C { static {\n a();\n b()\n } }')
  assert.equal(preserveStatementBoundaries('switch (x) { case 1:\n a()\n b()\n}').code,
    'switch (x) { case 1:\n a();\n b()\n}')
  assert.equal(preserveStatementBoundaries('"use strict"\na()\nb()').code, '"use strict";\na();\nb()')
  // A block-level function declaration can be republished as a `(cell.v)=(...)`
  // candidate assignment, while a program-level declaration cannot.
  assert.equal(preserveStatementBoundaries('{\n a()\n function f(){}\n}').code,
    '{\n a();\n function f(){}\n}')
  assert.equal(preserveStatementBoundaries('a()\nfunction f(){}').code, 'a()\nfunction f(){}')
  // A module statement is deleted as a whole, a trailing semicolon included, so
  // the separator is owned by the last surviving statement instead.
  assert.equal(preserveStatementBoundaries('a()\nexport {}\nb()').code, 'a();\nexport {}\nb()')
  assert.equal(preserveStatementBoundaries('a()\nimport x from "node:path"\nb()').code,
    'a();\nimport x from "node:path"\nb()')
  assert.equal(preserveStatementBoundaries('export {}\na()\nb()').code, 'export {}\na();\nb()')
  assert.equal(preserveStatementBoundaries('a()\nexport * from "node:path"\nb()').code,
    'a();\nexport * from "node:path"\nb()')
  assert.equal(preserveStatementBoundaries('a()\nexport default 1\nb()').code,
    'a();\nexport default 1\nb()')
  // A declaration that survives the export-modifier strip owns its separator.
  assert.equal(preserveStatementBoundaries('a()\nexport const x = 1\nb()').code,
    'a();\nexport const x = 1;\nb()')
  assert.equal(preserveStatementBoundaries('a()\nexport {}\nfunction f(){}').code,
    'a()\nexport {}\nfunction f(){}')
  assert.equal(preserveStatementBoundaries('{\n a()\n export {}\n function f(){}\n}').code,
    '{\n a();\n export {}\n function f(){}\n}')
  // Unproved syntax keeps its diagnostic owner; recovered syntax still guards.
  assert.equal(preserveStatementBoundaries('const = 1;\na()\nb()').code, 'const = 1;\na()\nb()')
  assert.equal(preserveStatementBoundaries('let x; let x; a()\nb()').code, 'let x; let x; a();\nb()')
})

test('executes across a deleted module statement that sat between two statements', async () => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    assert.equal(await runCells(bindingUpdates, [
      'const a = () => 1\nconst b = () => 2',
      'a()\nexport {}\nb()\nreturn 1',
    ]), 1, bindingUpdates)
    assert.equal(await runCells(bindingUpdates, [
      'const a = () => 1\nconst b = () => 2',
      'a()\nimport x from "node:path"\nb()\nreturn 1',
    ]), 1, bindingUpdates)
  }
})

test('keeps a declaration boundary inside protected module and CommonJS compilation', () => {
  // Protected module/CommonJS mode emits a declaration as a bare
  // `(pattern = (init));`, so a declaration is a parenthesized-leading form too.
  assert.equal(preserveStatementBoundaries('a()\nlet y = 1').code, 'a();\nlet y = 1')
  // The scope planner only takes that path when the module has a resource
  // declaration, or when a declaration can shadow a CommonJS compiler global.
  const moduleCode = normalizeStatefulScopes('a()\nlet y = 1\nusing r = { [Symbol.dispose]() {} }',
    undefined, { mode: 'protected-v1', target: 'module' }).code
  assert.match(moduleCode, /a\(\);\s*\(\(\(/)
  assert.doesNotMatch(moduleCode, /a\(\)\s*\(\(\(/)
  const commonjsCode = normalizeStatefulScopes('a()\nlet process = 1', undefined,
    { mode: 'protected-v1', target: 'commonjs' }).code
  assert.match(commonjsCode, /a\(\);\s*\(\(\(/)
  assert.doesNotMatch(commonjsCode, /a\(\)\s*\(\(\(/)
})

test('compiles adjacent expression statements into separate invocation frames', () => {
  const { code } = compiled('const a = () => 1\nconst b = () => 2\na()\nb()\nreturn 1')
  assert.match(code, /callee: "a"/)
  assert.match(code, /callee: "b"/)
  assert.doesNotMatch(code, /callee: "a\(\)/)
})

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`executes adjacent bare-identifier calls under ${bindingUpdates} policy`, async () => {
    assert.equal(await runCells(bindingUpdates, [
      'const a = () => 1\nconst b = () => 2',
      'a()\nb()\nreturn 1',
    ]), 1)
  })

  test(`keeps every statement effect in a loop-local object under ${bindingUpdates} policy`, async () => {
    assert.deepEqual(await runCells(bindingUpdates, [
      "const files = ['a', 'bb']",
      `const rows = []
for (const f of files) {
  const row = {}
  row.name = f
  row.size = f.length
  rows.push(row)
}
return rows`,
    ]), [{ name: 'a', size: 1 }, { name: 'bb', size: 2 }])
  })

  test(`keeps assignment effects and receivers under ${bindingUpdates} policy`, async () => {
    assert.deepEqual(await runCells(bindingUpdates, [
      `const log = []
const target = { set value(next) { log.push(['set', next]) } }
const read = () => (log.push(['read']), 3)
{
  const local = { get value() { log.push(['get']); return 5 } }
  local.value
  target.value = read()
}
return log`,
    ]), [['get'], ['read'], ['set', 3]])
    assert.equal(await runCells(bindingUpdates, [
      'const counter = { value: 41, read() { return this.value + 1 } }',
      'return counter.read()',
    ]), 42)
  })

  test(`keeps declaration-initializer controls unchanged under ${bindingUpdates} policy`, async () => {
    assert.equal(await runCells(bindingUpdates, [
      `const a = () => 1
const b = () => 2
const first = a()
const second = b()
return first + second`,
    ]), 3)
  })

  test(`keeps block-level function publication under ${bindingUpdates} policy`, async () => {
    assert.deepEqual(await runCells(bindingUpdates, [
      `const a = () => 1
{
  a()
  function f(){ return 2 }
}
return [a(), f()]`,
    ]), [1, 2])
  })
}
