import assert from 'node:assert/strict'
import test from 'node:test'
import { markCallableSources } from '../internal/callable-source-facts.js'
import { CELL_PARSER_PLUGINS, lowerNativeLanguageSource } from '../internal/repl-scope-normalizer.js'

function reflection(source) {
  let lowerings = 0
  const marked = markCallableSources(source, undefined, { plugins: CELL_PARSER_PLUGINS }, {
    nativeUsing: false,
    lowerNativeSource(source, options) {
      lowerings++
      return lowerNativeLanguageSource(source, options)
    },
  })
  const original = [...marked.callableSources][0][1]
  return { lowerings, callable: Function(`return (${original})`)() }
}

test('nested reflection reuses language lowering while retaining each lexical activation', () => {
  const source = depth => {
    let body = '@((value) => class extends value { static result = seed + 1 }) class Example {}; return Example.result'
    for (let index = 0; index < depth; index++) {
      body = `function layer${index}(seed){${body}};return layer${index}(seed + 1)`
    }
    return `function outer(seed){${body}}`
  }
  const shallow = reflection(source(1))
  const deep = reflection(source(5))
  assert.equal(shallow.callable(40), 42)
  assert.equal(deep.callable(40), 46)
  assert.equal(deep.callable(100), 106)
  assert.ok(deep.lowerings <= shallow.lowerings,
    `enclosing functions repeated language lowering: ${shallow.lowerings} → ${deep.lowerings}`)
})

test('enclosing resources keep their lifetime after child reflection has been lowered', async () => {
  for (const asynchronous of [false, true]) {
    const prefix = asynchronous ? 'async ' : ''
    const resource = asynchronous ? 'await using' : 'using'
    const dispose = asynchronous ? 'asyncDispose' : 'dispose'
    const source = `${prefix}function outer(events){
      ${resource} outerResource = { [Symbol.${dispose}](){events.push('outer disposed')} };
      ${prefix}function inner(){
        ${resource} innerResource = { [Symbol.${dispose}](){events.push('inner disposed')} };
        events.push('inner');
        return 42;
      }
      const value = ${asynchronous ? 'await ' : ''}inner();
      events.push('outer');
      return value;
    }`
    const { callable } = reflection(source)
    const events = []
    assert.equal(await callable(events), 42)
    assert.deepEqual(events, ['inner', 'inner disposed', 'outer', 'outer disposed'])
  }
})

test('reused functions retain parameters, sibling captures and source bindings resembling helpers', () => {
  const { callable } = reflection(`function outer(seed){
    const __dsh_ptc_decorator_intrinsics_0__ = seed;
    function left(value: number = __dsh_ptc_decorator_intrinsics_0__){
      @((Class) => Class) class Example { static value = value };
      return Example.value;
    }
    const right = (value: number = seed + 1) => {
      using resource = null;
      return value;
    };
    return [left(), right()];
  }`)
  assert.deepEqual(callable(40), [40, 41])
  assert.deepEqual(callable(98), [98, 99])
})

test('enclosing type syntax is lowered while native private contexts survive child substitution', () => {
  const typed = reflection(`function outer(seed: number): number {
    enum Offset { value = 2 }
    function child(){ using resource = null; return seed }
    return child() + Offset.value;
  }`).callable
  assert.equal(typed(40), 42)
  const Class = reflection(`class Outer {
    #value = 42;
    read(){ function child(){ using resource = null; return 0 } return this.#value + child() }
  }`).callable
  assert.equal(new Class().read(), 42)
})

test('indexed reflection keeps sibling recipes distinct and recreates nested closures', () => {
  const declarations = Array.from({ length: 80 }, (_, index) =>
    `function child${index}(){return (value: number = seed + ${index}) => value}`)
  const names = declarations.map((_, index) => `child${index}`)
  const { callable } = reflection(`function outer(seed: number){
    ${declarations.join('\n')}
    return [${names}].map(child => [child()(), child() === child()]);
  }`)
  for (const seed of [3, 100]) assert.deepEqual(callable(seed),
    declarations.map((_, index) => [seed + index, false]))
})
