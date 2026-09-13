import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

const moduleSource = version => JSON.stringify(`data:text/javascript,export const x={version:${version}}`)
const declarations = [
  ['lexical', 'const x={version:1}'],
  ['var', 'var x={version:1}'],
  ['function', 'function x(){};x.version=1'],
  ['class', 'class x{static version=1}'],
  ['import', `import {x} from ${moduleSource(1)}`],
]
const transitions = [
  { name: 'scalar', code: 'const x=(effects.push("init"),{version:2})', version: 2, effects: ['init'] },
  { name: 'pattern', code: 'let [x,sibling=x.version]=[(effects.push("init"),{version:2})]', version: 2, effects: ['init'] },
  { name: 'abrupt pattern', code: 'const [x,sibling=(()=>{effects.push("fail");throw new Error("pattern-stop")})()]=[{version:2}]',
    version: 1, effects: ['fail'], failure: /pattern-stop/ },
  { name: 'unexecuted var', code: 'if(false)var x={version:2},sibling=effects.push("escaped")', version: 1, effects: [] },
  { name: 'function', code: 'function x(){};x.version=2', version: 2, effects: [] },
  { name: 'class', code: 'class x{static version=2}', version: 2, effects: [] },
  { name: 'import', code: `import {x} from ${moduleSource(2)}`, version: 2, effects: [] },
]

// The oracle is the dialect's identity and declarator-publication contract,
// independent of the compiler's generated storage and commit representation.
for (const [kind, initial] of declarations) for (const transition of transitions) {
  test(`dialect identity: ${kind} -> ${transition.name}`, async t => {
    const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
    t.after(() => runtime.dispose())
    const run = program => runtime.run('dialect', { program, bindings: [] })
    const first = await run(`${initial};const original=x;const read=()=>x;const effects=[]`)
    assert.equal(first.error, undefined, first.error?.message)
    const changed = await run(transition.code)
    if (transition.failure) assert.match(changed.error?.message ?? '', transition.failure)
    else assert.equal(changed.error, undefined, changed.error?.message)
    const after = await run('return [x.version,read()===x,original.version,effects]')
    assert.equal(after.error, undefined, after.error?.message)
    assert.deepEqual(after.value, [transition.version, true, 1, transition.effects])
  })
}

test('protected identities retain readonly storage while ordinary RHS effects remain real', async t => {
  const writes = ['x=(effects.push("rhs"),{version:2})',
    '[x]=[(effects.push("rhs"),{version:2})]',
    'eval("x=(effects.push(\\"rhs\\"),{version:2})")']
  for (const code of writes) {
    const runtime = new SessionRuntime({ bindingUpdates: 'protected', durableReplay: false })
    t.after(() => runtime.dispose())
    const run = program => runtime.run(code, { program, bindings: [] })
    assert.equal((await run('const x={version:1};const original=x;const read=()=>x;const effects=[]')).error, undefined)
    assert.match((await run(code)).error?.message ?? '', /TypeError/)
    const after = await run('return [x===original,read()===x,effects]')
    assert.equal(after.error, undefined, after.error?.message)
    assert.deepEqual(after.value, [true, true, ['rhs']])
  }
})

test('stateful assignment establishes a value before a later bare declaration in the same scope', async t => {
  for (const body of ['x=1;let x;return x',
    '{function initialize(){x=1};initialize();let x;return x}',
    'return (function(){function initialize(){x=1};initialize();let x;return x})()']) {
    const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
    t.after(() => runtime.dispose())
    const result = await runtime.run('early-assignment', { program: body, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.value, 1)
  }
})
