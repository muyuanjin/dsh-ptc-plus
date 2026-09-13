import assert from 'node:assert/strict'
import test from 'node:test'
import { REPL_MEMORY_META_KEY } from '../internal/repl-memory-projection.js'
import { fixture } from './plugin-fixture.js'

function inventory(result) {
  return result.meta[REPL_MEMORY_META_KEY].memory.entries
}

function names(result) {
  return inventory(result).map(entry => entry.name)
}

test('stateful inventory promotes completed redeclarations across cells', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const first = await state.runDurable('declaration-recency', 'const first = 1\nconst second = 2')
  assert.deepEqual(names(first), ['second', 'first'])

  const second = await state.runDurable('declaration-recency', 'const third = 3\nconst first = 4\nreturn [first, second, third]')
  assert.deepEqual(second.value, [4, 2, 3])
  assert.deepEqual(names(second), ['first', 'third', 'second'])
  assert.deepEqual(inventory(second)[0].definition, { source: 'const first = 4', line: 2, column: 1 })
  assert.deepEqual(names(first), ['second', 'first'])

  const read = await state.runDurable('declaration-recency', 'return [second, first, third]')
  assert.deepEqual(names(read), ['first', 'third', 'second'])
  const assignment = await state.runDurable('declaration-recency', 'second = 20; return second')
  assert.equal(assignment.value, 20)
  assert.deepEqual(names(assignment), ['first', 'third', 'second'])
})

test('stateful inventory uses the last completed declarator for repeated names', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable('repeated-declarator-recency', 'const first = 1, second = 2, first = 3; return [first, second]')
  assert.deepEqual(result.value, [3, 2])
  assert.deepEqual(names(result), ['first', 'second'])
})

test('stateful inventory does not promote failed declarators or declarations after failure', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('failed-declaration-recency', 'const alpha = 1\nconst beta = 2\nconst gamma = 3')
  const failed = await state.runDurable('failed-declaration-recency', `const beta = 20
const [alpha, failed = (() => { throw new Error('stop') })()] = [10]
const gamma = 30`)
  assert.equal(failed.isError, true)
  assert.match(failed.error.message, /uncaught Error: stop/)
  assert.deepEqual(names(failed), ['beta', 'gamma', 'alpha'])
  const continued = await state.runDurable('failed-declaration-recency', 'return [alpha, beta, gamma, typeof failed]')
  assert.deepEqual(continued.value, [1, 20, 3, 'undefined'])
  assert.deepEqual(names(continued), ['beta', 'gamma', 'alpha'])
})

test('stateful inventory promotes only declarations completed before an early return', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('returned-declaration-recency', 'const alpha = 1\nconst beta = 2\nconst gamma = 3')
  const result = await state.runDurable('returned-declaration-recency', 'const alpha = 10; return alpha; const beta = 20; const late = 40')
  assert.equal(result.value, 10)
  assert.deepEqual(names(result), ['alpha', 'gamma', 'beta'])
  const continued = await state.runDurable('returned-declaration-recency', 'return [alpha, beta, gamma, typeof late]')
  assert.deepEqual(continued.value, [10, 2, 3, 'undefined'])
  assert.deepEqual(names(continued), ['alpha', 'gamma', 'beta'])
})

test('stateful inventory preserves recency when a bare declaration preserves the existing value', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('bare-declaration-recency', 'const first = 1\nconst second = 2')
  const result = await state.runDurable('bare-declaration-recency', 'var first; return first')
  assert.equal(result.value, 1)
  assert.deepEqual(names(result), ['second', 'first'])
  assert.equal(inventory(result)[1].definition.source, 'const first = 1')
})

test('stateful inventory promotes accepted function class and import replacements', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  await state.runDurable('kind-declaration-recency', 'const revised = 1; const untouched = 2')
  for (const [source, expectedKind, expectedValue] of [
    ['function revised() { return 3 }; return revised()', 'function', 3],
    ['class revised { static value = 5 }; return revised.value', 'class', 5],
    ['import { format as revised } from "node:util"; return revised("%s", "value")', 'import', 'value'],
  ]) {
    const result = await state.runDurable('kind-declaration-recency', source)
    assert.equal(result.value, expectedValue)
    assert.deepEqual(names(result), ['revised', 'untouched'])
    assert.equal(inventory(result)[0].kind, expectedKind)
    const reset = await state.runDurable('kind-declaration-recency', 'const untouched = 4')
    assert.deepEqual(names(reset), ['untouched', 'revised'])
  }
})

test('inventory source order is independent of import preparation and default export passes', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const imported = await state.runDurable('source-order-import', `const before = 1;
function helper() { return before }
import { format } from "node:util";
const after = 2; return helper()`)
  assert.equal(imported.value, 1)
  assert.deepEqual(names(imported), ['after', 'format', 'helper', 'before'])
  const exported = await state.runDurable('source-order-default', `const before = 1;
export default 42;
const after = 2; return __default`)
  assert.equal(exported.value, 42)
  assert.deepEqual(names(exported), ['after', '__default', 'before'])
})

test('declaration provenance follows actual commits across default and import interleaving', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  for (const [source, expected, definition] of [
    ['const __default = 1; export default 42; return __default', 42, 'export default 42;'],
    ['export default 42; const __default = 1; return __default', 1, 'const __default = 1;'],
  ]) {
    const result = await state.runDurable(`default-source-${expected}`, source)
    assert.equal(result.value, expected)
    assert.equal(inventory(result)[0].definition.source, definition)
  }
  const source = 'const format = () => "local"; import { format } from "node:util"; return format()'
  const imported = await state.runDurable('import-final-source', source)
  assert.equal(imported.value, 'local')
  assert.equal(inventory(imported)[0].kind, 'variable')
  assert.equal(inventory(imported)[0].definition.source, 'const format = () => "local";')
})

test('repeated loop commits retain the last executed declaration and implicit write provenance', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const result = await state.runDurable('loop-commit-source', `for (var i=0;i<2;i++) {
  var value=i;
  if (i===0) { var value=8; }
}
return value`)
  assert.equal(result.value, 1)
  assert.equal(inventory(result).find(entry => entry.name === 'value').definition.source, 'var value=i;')
  const assignment = await state.runDurable('loop-commit-source', 'const value=3; value=4; return value')
  assert.equal(assignment.value, 4)
  assert.equal(inventory(assignment).find(entry => entry.name === 'value').definition.source, 'value=4')
})
