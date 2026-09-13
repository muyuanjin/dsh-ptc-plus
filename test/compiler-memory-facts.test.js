import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { collectCallableSources, markCallableSources } from '../internal/callable-source-facts.js'
import { identitySourceMap, mapSourcePosition, mapSourceSpan, sourceLineStarts, sourceTextAtSpan } from '../internal/source-position-map.js'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { indexSource, visitSource } from '../internal/compiler-source-regions.js'
import { createSourcePieces } from '../internal/compiler-source-pieces.js'

test('source fact traversal retains native ancestry and Babel skip/stop ordering', () => {
  const source = 'function outer(){function inner(){return 1};return inner};outer()'
  const traverse = traverseModule.default ?? traverseModule
  for (const mode of ['complete', 'skip', 'stop']) {
    const events = visit => {
      const result = []
      visit(parse(source), {
        noScope: true,
        enter(path) {
          result.push(['enter', path.type, path.findParent(parent => parent.isFunction())?.node.id.name])
          if (mode === 'skip' && path.node.id?.name === 'inner') path.skip()
        },
        exit(path) {
          result.push(['exit', path.type, path.findParent(parent => parent.isFunction())?.node.id.name])
          if (mode === 'stop' && path.node.id?.name === 'inner') path.stop()
        },
      })
      return result
    }
    assert.deepEqual(events(visitSource), events(traverse))
  }
  const tree = parse(source)
  const index = indexSource(tree)
  for (const scope of index.scopes) assert.equal(scope.path.node, scope.block)
  const outer = tree.program.body[0]
  assert.equal(index.parentFor(outer), tree.program)
  assert.equal(index.scopeFor(outer).parent.block, tree.program)
})

test('piece slicing retains copied, replaced and inserted source boundaries', () => {
  const pieces = createSourcePieces('abcdef')
  for (const [piece, start, end, text, origins] of [
    [pieces.original(1, 5), 1, 3, 'cd', [2, 4]],
    [pieces.text('helper'), 2, 4, 'lp', undefined],
    [pieces.mapped('WXYZ', { start: 1, end: 5 }), 1, 3, 'XY', [2, 4]],
    [pieces.mapped('replacement', { start: 2, end: 3 }), 3, 7, 'lace', [2, 3]],
  ]) {
    const output = pieces.emit(pieces.slice(piece, start, end))
    assert.equal(output.text, text)
    assert.deepEqual([...output.mappings].map(({ originalStart, originalEnd }) => [originalStart, originalEnd]),
      origins ? [origins] : [])
  }
})

test('compact module transport names preserve decoded source bindings and closure updates', () => {
  const source = String.raw`let __ptc$0=3, __ptc\u00241=4;
    const read=()=>[__ptc$0,__ptc$1];
    const __ptc$0=5; __ptc$1=6; return read()`
  const result = normalizeStatefulScopes(source, undefined, { target: 'commonjs' })
  assert.deepEqual(Function('require', result.code)(createRequire(import.meta.url)), [5, 6])
})

test('callable markers distinguish arrow tokens from comments without retaining tokens', () => {
  const source = `const first=(value /* => */) /* => */ => /* => */ value;
const second=()=> // =>
  (() /* => */ => /* => */ 42);
const third=async /* => */ value /* => */ => ({value});`
  const marked = markCallableSources(source)
  const parsed = parse(marked.code)
  assert.equal(parsed.comments.filter(comment => comment.value.startsWith('__dsh_ptc_callable_')).length, 4)
  const collected = collectCallableSources(marked.code, marked.callableSources)
  assert.deepEqual(collected.map(([, original]) => original), marked.callableSources.map(([, original]) => original))
  assert.deepEqual(collectCallableSources(marked.code, [...marked.callableSources]), collected)
  for (const [generated, original] of collected) {
    assert.match(generated, /\/\*__dsh_ptc_callable_/)
    assert.doesNotThrow(() => parse(`(${original})`))
  }
})

test('source coordinate lookups reuse an index without retaining an unrelated source', t => {
  const source = 'first\r\n' + 'middle\u2028'.repeat(10_000) + 'last'
  const mapping = identitySourceMap(source.length)
  const nativeMatchAll = String.prototype.matchAll
  let scans = 0
  t.mock.method(String.prototype, 'matchAll', function (...args) {
    scans++
    return Reflect.apply(nativeMatchAll, this, args)
  })
  for (let line = 1; line <= 1_000; line++) {
    assert.deepEqual(mapSourcePosition({ line, column: 1 }, source, source, mapping), { line, column: 1 })
  }
  assert.ok(scans <= 2, `repeated lookups performed ${scans} source scans`)
  assert.deepEqual(mapSourceSpan({ line: 10_002, column: 1, end: { line: 10_002, column: 5 } }, source, source, mapping),
    { line: 10_002, column: 1, end: { line: 10_002, column: 5 } })
  assert.ok(scans <= 2)
  assert.deepEqual(mapSourcePosition({ line: 1, column: 1 }, 'new source', 'new source', mapping), { line: 1, column: 1 })
  const starts = sourceLineStarts(source)
  const before = scans
  for (let line = 2; line <= 1_000; line++) {
    assert.equal(sourceTextAtSpan(source, { line, column: 1, end: { line, column: 7 } }, starts), 'middle')
  }
  assert.equal(scans, before)
})
