import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@babel/parser'
import generateModule from '@babel/generator'
import {
  applySourceEdits,
  createMappedTextBuilder,
  createSourceMapBuilder,
  identitySourceMap,
  mapSourcePosition,
  mapSourceSpan,
  mappedSourceTransform,
  sourceOffsetAt,
  sourceOffsetAtPosition,
  sourceRangeHasOriginalText,
  sourceTextAtSpan,
} from '../internal/source-position-map.js'

test('raw emitter maps and encoded maps preserve identical source anchors', () => {
  const generate = generateModule.default ?? generateModule
  const source = 'const answer=()=>{\r\nreturn 42\n};answer()'
  const emitted = generate(parse(source), { sourceMaps: true, sourceFileName: 'input.js' }, source)
  const encoded = mappedSourceTransform(source, identitySourceMap(source.length), { code: emitted.code, map: emitted.map })
  const raw = mappedSourceTransform(source, identitySourceMap(source.length), {
    code: emitted.code, rawMappings: emitted.rawMappings,
    get map() { assert.fail('available raw mappings must not be encoded again') },
  })
  assert.deepEqual(raw, encoded)
  const sparse = mappedSourceTransform('x', identitySourceMap(1), {
    code: 'a x?', rawMappings: [
      { generated: { line: 1, column: 0 } },
      { generated: { line: 1, column: 2 }, original: { line: 1, column: 0 } },
      { generated: { line: 1, column: 3 } },
      { generated: { line: 1, column: 4 }, original: { line: 1, column: 1 } },
    ],
  })
  assert.deepEqual(Array.from({ length: 5 }, (_, offset) => sourceOffsetAt(sparse.sourceMap, offset)), [0, 0, 0, 1, 1])
})

test('numeric source maps reject offsets that cannot represent source buffers', () => {
  const builder = createSourceMapBuilder()
  for (const originalEnd of [-1, 1.5, 2 ** 32, NaN]) {
    assert.throws(() => builder.push({ generatedStart: 0, generatedEnd: 1, originalStart: 0, originalEnd }),
      /source mapping offsets must fit a source buffer/)
  }
  builder.push({ generatedStart: 0, generatedEnd: 1, originalStart: 0, originalEnd: 1 })
  assert.deepEqual(builder.finish(), identitySourceMap(1))
})

test('distinguishes source text from generated anchors across compressed mappings', () => {
  const generated = 'skipthis'
  const original = 'xxthis'
  const sourceMap = [
    { generatedStart: 0, generatedEnd: 4, originalStart: 0, originalEnd: 0 },
    { generatedStart: 4, generatedEnd: 8, originalStart: 2, originalEnd: 3 },
  ]
  assert.equal(sourceRangeHasOriginalText(sourceMap, generated, original, 0, 4), false)
  assert.equal(sourceRangeHasOriginalText(sourceMap, generated, original, 3, 5), false)
  assert.equal(sourceRangeHasOriginalText(sourceMap, generated, original, 4, 8), true)
  assert.equal(sourceRangeHasOriginalText(sourceMap, generated, original, 8, 8), false)
  assert.equal(sourceRangeHasOriginalText(sourceMap, 'this', 'that', 0, 4), false)
  assert.equal(sourceRangeHasOriginalText(identitySourceMap(4), 'this', 'this', 0, 4), true)
  assert.equal(sourceRangeHasOriginalText(identitySourceMap(4), 'this', undefined, 0, 4), false)
})

test('composing inserted source anchors never invents a character past EOF', () => {
  const source = 'x'
  const inserted = applySourceEdits(source, identitySourceMap(source.length), [{ start: 1, end: 1, text: ';helper()' }])
  const copied = applySourceEdits(inserted.code, inserted.sourceMap, [{ start: 0, end: inserted.code.length,
    text: inserted.code, mappings: identitySourceMap(inserted.code.length) }])
  assert.deepEqual(copied.sourceMap, inserted.sourceMap)
  assert.ok([...copied.sourceMap].every(segment => segment.originalEnd <= source.length))
  assert.doesNotThrow(() => applySourceEdits(source, identitySourceMap(source.length), [{
    start: 0, end: source.length, text: copied.code, mappings: copied.sourceMap,
  }]))
})

test('original reference spans retain exact text across native line terminators', () => {
  const source = 'prefix\r\nservice\r[\u2028 key()\u2029]'
  assert.equal(sourceTextAtSpan(source, { line: 2, column: 1, end: { line: 5, column: 2 } }),
    'service\r[\u2028 key()\u2029]')
})

test('source coordinates stop before every complete line terminator', () => {
  const content = 'const value = 1'
  for (const ending of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const source = `${content}${ending}next`
    assert.equal(sourceOffsetAtPosition(source, {
      line: 1, column: content.length + 1,
    }), content.length, JSON.stringify(ending))
    assert.equal(sourceOffsetAtPosition(source, {
      line: 1, column: content.length + 2,
    }), undefined, JSON.stringify(ending))
    assert.equal(sourceOffsetAtPosition(source, { line: 2, column: 1 }), content.length + ending.length)
  }
  assert.equal(sourceOffsetAtPosition('value', { line: 1, column: 6 }), 5)
  assert.equal(sourceOffsetAtPosition('value', { line: 0, column: 1 }), undefined)
})

test('builds mapped text from explicit copied ranges', () => {
  const source = 'prefix value suffix'
  const builder = createMappedTextBuilder(source)
  builder.append('generated(')
  builder.appendSource(7, 12)
  builder.append(')')
  assert.deepEqual(builder.result(), {
    text: 'generated(value)',
    mappings: [{ generatedStart: 10, generatedEnd: 15, originalStart: 7, originalEnd: 12 }],
  })
  assert.throws(() => builder.appendSource(-1, 2), /bounded/)
  assert.throws(() => createMappedTextBuilder(source, -1), /valid/)
})

test('keeps unchanged positions exact and anchors generated replacement text', () => {
  const original = 'alpha beta omega'
  const rewritten = applySourceEdits(original, identitySourceMap(original.length), [{
    start: 6,
    end: 10,
    text: 'generated replacement',
  }])
  assert.equal(rewritten.code, 'alpha generated replacement omega')
  assert.deepEqual(
    mapSourcePosition({ line: 1, column: 7 }, rewritten.code, original, rewritten.sourceMap),
    { line: 1, column: 7 },
  )
  assert.deepEqual(
    mapSourcePosition({ line: 1, column: 29 }, rewritten.code, original, rewritten.sourceMap),
    { line: 1, column: 12 },
  )
})

test('composes insertions and deletions across CRLF source lines', () => {
  const original = 'first\r\nsecond\r\nthird'
  assert.deepEqual(
    mapSourcePosition({ line: 2, column: 1 }, original, original, identitySourceMap(original.length)),
    { line: 2, column: 1 },
  )
  const first = applySourceEdits(original, identitySourceMap(original.length), [
    { start: 0, end: 5, text: '' },
    { start: 7, end: 7, text: 'prefix ' },
  ])
  const secondStart = first.code.indexOf('second')
  const rewritten = applySourceEdits(first.code, first.sourceMap, [{
    start: secondStart,
    end: secondStart + 6,
    text: 'expanded-second',
  }])
  const thirdColumn = rewritten.code.split('\n')[2].indexOf('third') + 1
  assert.deepEqual(
    mapSourcePosition({ line: 3, column: thirdColumn }, rewritten.code, original, rewritten.sourceMap),
    { line: 3, column: 1 },
  )
})

test('copied function source preserves provenance across an earlier inserted marker', () => {
  const original = '()=>eval("late=7")'
  const marked = applySourceEdits(original, identitySourceMap(original.length), [
    { start: 2, end: 2, text: '/*compiler source fact*/' },
  ])
  const copied = applySourceEdits(marked.code, marked.sourceMap, [{
    start: 0, end: marked.code.length, text: `({name:${marked.code}}).name`,
    mappings: [{ generatedStart: 7, generatedEnd: 7 + marked.code.length, originalStart: 0, originalEnd: marked.code.length }],
  }])
  const offset = copied.code.indexOf('eval')
  assert.deepEqual(mapSourceSpan({ line: 1, column: offset + 1, end: { line: 1, column: offset + 15 } },
    copied.code, original, copied.sourceMap), { line: 1, column: 5, end: { line: 1, column: 19 } })
})

test('leaves absent or invalid worker positions unchanged', () => {
  const sourceMap = identitySourceMap(1)
  assert.equal(mapSourcePosition(undefined, 'x', 'x', sourceMap), undefined)
  assert.deepEqual(
    mapSourcePosition({ line: 0, column: 1 }, 'x', 'x', sourceMap),
    { line: 0, column: 1 },
  )
  assert.deepEqual(
    mapSourcePosition({ line: 2, column: 1 }, 'x', 'x', []),
    { line: 1, column: 2 },
  )
})

test('maps anchored generated spans to exact original tokens', () => {
  const original = 'import { original as local }'
  const generated = 'const { original: local } = value'
  const localStart = generated.indexOf('local')
  const originalStart = original.indexOf('local')
  const rewritten = applySourceEdits(original, identitySourceMap(original.length), [{
    start: 0,
    end: original.length,
    text: generated,
    mappings: [{
      generatedStart: localStart,
      generatedEnd: localStart + 'local'.length,
      originalStart,
      originalEnd: originalStart + 'local'.length,
    }],
  }])
  assert.deepEqual(mapSourceSpan({
    line: 1,
    column: localStart + 1,
    end: { line: 1, column: localStart + 1 + 'local'.length },
  }, generated, original, rewritten.sourceMap), {
    line: 1,
    column: originalStart + 1,
    end: { line: 1, column: originalStart + 1 + 'local'.length },
  })
})

test('preserves an invalid span end for its diagnostic owner to reject', () => {
  const source = 'value'
  assert.deepEqual(mapSourceSpan({
    line: 1,
    column: 1,
    end: { line: 0, column: 1 },
  }, source, source, identitySourceMap(source.length)), {
    line: 1,
    column: 1,
    end: { line: 0, column: 1 },
  })
})

test('validates a batch once and handles thousands of edits without iterative map rebuilds', () => {
  const original = 'x'.repeat(100_000)
  const edits = Array.from({ length: 2_000 }, (_, index) => ({
    start: index * 40,
    end: index * 40 + 1,
    text: 'replacement',
  }))
  let iterations = 0
  const sourceMap = new Proxy(identitySourceMap(original.length), {
    get(target, property, receiver) {
      if (property === Symbol.iterator) iterations += 1
      return Reflect.get(target, property, receiver)
    },
  })
  const rewritten = applySourceEdits(original, sourceMap, edits)
  assert.equal(rewritten.code.length, 120_000)
  assert.equal(iterations, 0)
  assert.throws(() => applySourceEdits('abc', identitySourceMap(3), [
    { start: 0, end: 2, text: 'x' },
    { start: 1, end: 3, text: 'y' },
  ]), /non-overlapping/)
  assert.throws(() => applySourceEdits('abc', identitySourceMap(3), [
    { start: 0, end: 1, text: 'x', mappings: [{ generatedStart: 0, generatedEnd: 2, originalStart: 0, originalEnd: 1 }] },
  ]), /mappings/)
})

test('normalizes edit and mapping order without mutating caller arrays', () => {
  const source = 'alpha beta gamma'
  const mappings = [
    { generatedStart: 2, generatedEnd: 4, originalStart: 8, originalEnd: 10 },
    { generatedStart: 0, generatedEnd: 2, originalStart: 6, originalEnd: 8 },
  ]
  const edits = [
    { start: 11, end: 16, text: 'G' },
    { start: 6, end: 10, text: 'BETA', mappings },
  ]
  const originalEdits = structuredClone(edits)

  const rewritten = applySourceEdits(source, identitySourceMap(source.length), edits)
  assert.equal(rewritten.code, 'alpha BETA G')
  assert.deepEqual(edits, originalEdits)
  assert.deepEqual(mappings, originalEdits[1].mappings)
  assert.deepEqual(mapSourceSpan({
    line: 1,
    column: 7,
    end: { line: 1, column: 11 },
  }, rewritten.code, source, rewritten.sourceMap), {
    line: 1,
    column: 7,
    end: { line: 1, column: 11 },
  })
})
