import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The host TypeScript stripper is experimental, and Node releases disagree
 * about the TypeScript early-error forms they accept. A refused input must fall
 * back to the pinned compiler eraser, which keeps erasure and its source
 * positions identical across supported hosts; a genuine syntax error must
 * still reach the caller with the original cell position.
 */
test('the pinned eraser removes types the host stripper refuses', async t => {
  const hostModule = await import('node:module')
  // Node 26 refuses a named export set that also carries the module's default.
  const { default: _defaultExport, ...hostExports } = hostModule
  t.mock.module('node:module', { namedExports: { ...hostExports,
    stripTypeScriptTypes() { throw new SyntaxError('host stripper refused this input') } } })
  const { parseExecutableCell } = await import('../internal/cell-parser.js')
  const source = 'const answer: number = 42;\nreturn answer'
  const erased = parseExecutableCell(source, { eraseTypes: true })
  assert.equal(erased.code.length, source.length)
  assert.throws(() => parseExecutableCell('return (', { eraseTypes: true }), error => {
    assert.deepEqual(error.cellPosition, { line: 1, column: 9 })
    return true
  })
})
