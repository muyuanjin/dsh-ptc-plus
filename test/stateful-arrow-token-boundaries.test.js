import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { SessionRuntime } from '../internal/session-runtime.js'

const expressions = [
  '(x /* => */) => x + 1',
  '(x // =>\n) => x + 1',
  'x /* => */ => x + 1',
  '(x=(() /* => */ => 2)()) /* => */ => x + 1',
  '(x,...rest /* => */) => x + 1 + rest.length',
  '(x /* => */) => ((y /* => */) => x + y)(1)',
]

test('concise arrow activation follows parser tokens through comments and nested parameters', () => {
  for (const expression of expressions) {
    const source = `const fn=${expression};return fn(2)`
    assert.equal(Function(normalizeStatefulScopes(source).code)(), Function(source)(), expression)
  }
})

test('arrow token boundaries agree across root, module and asynchronous entries', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const source = `const functions=[${expressions.join(',')}];const values=functions.map(fn=>fn(2));
    const asyncFn=async (value /* => */) => await value + 1;
    const result=[values,await asyncFn(2)]`
  for (const [name, program] of [
    ['root', `${source};return result`],
    ['module', `const mod=await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(source + ';export {result}'))});return mod.result`],
  ]) {
    const result = await runtime.run(`arrow-token-${name}`, { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [expressions.map(() => 3),3])
  }
})
