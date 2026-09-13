import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './plugin-fixture.js'

const cases = [
  ['ordinary and eval reads share an activation', `
    let x=1; function f(){eval('var x=2');return [eval('x'),x]}
    return [f(),x]
  `],
  ['writes preserve the outer binding', `
    let x=1; function f(){eval('var x=2');x=3;return [eval('x'),x]}
    return [f(),x]
  `],
  ['closures created before eval see its later declaration', `
    let x=1; function f(){const read=()=>x;eval('var x=2');return read}
    return [f()(),x]
  `],
  ['strict child closures inherit sloppy parent vars', `
    let x=1; function f(){const read=()=>{'use strict';return x};eval('var x=2');return read}
    return [f()(),x]
  `],
  ['deletion falls back to the enclosing binding', `
    let x=1; function f(){eval('var x=2');const before=x;const removed=delete x;return [before,removed,x]}
    return [f(),x]
  `],
  ['an RHS eval preserves native assignment lookup', `
    let x=1; function f(){x=eval('var x=2;3');return [eval('x'),x]}
    return [f(),x]
  `],
  ['later defaults and the body see parameter eval vars', `
    let x=1; function f(a=eval('var x=2'),b=x){return [b,x]}
    return [f(),x]
  `],
  ['parameter closures see later parameter eval vars', `
    let x=1; function f(read=()=>x,a=eval('var x=2')){return [read(),x]}
    return [f(),x]
  `],
  ['parameter closures remain outside the body eval frame', `
    let x=1; function f(read=()=>x){eval('var x=2');return [read(),x]}
    return [f(),x]
  `],
  ['strict eval retains its own declarations', `
    let x=1; function f(){'use strict';eval('var x=2');return x}
    return [f(),x]
  `],
  ['nearer lexical declarations retain their identity', `
    let x=1; function f(){eval('var x=2');{let x=3;return [x,eval('x')]}}
    return [f(),x]
  `],
  ['body eval can shadow a named function self binding', `
    return (function own(){eval('var own=2');return [eval('own'),own]})()
  `],
  ['native body var shadows a named function self binding', `
    return (function own(){var own=3;return [own,eval('own')]})()
  `],
  ['named function self precedes enclosing same-name vars', `
    var own=7;return (function own(){return eval('own.name')})()
  `],
  ['deleting an eval-created self shadow restores the function', `
    return (function own(){eval('var own=2');return [eval('delete own'),eval('typeof own'),own.name]})()
  `],
  ['same-name parameters retain mapped arguments', `
    return (function own(own){var own=3;return [own,arguments[0],eval('own')] })(1)
  `],
  ['default eval captures self outside a same-named body var', `
    return (function own(read=eval('()=>own')){var own=3;return [read().name,own]})()
  `],
  ['repeated invocations retain separate eval vars', `
    let x=1; function f(value){const read=()=>x;eval('var x=value');return read}
    const first=f(2),second=f(3);return [first(),second(),x]
  `],
]

for (const [mode, config] of [
  ['stateful', {}],
  ['protected', { bindingUpdates: 'protected' }],
  ['legacy', { legacyBindingSettings: true }],
]) {
  test(`${mode} cell dynamic scope follows native environment boundaries`, async t => {
    const state = fixture(config)
    try {
      for (const [name, body] of cases) {
        await t.test(name, async () => {
          const source = `return (function(){${body}})()`
          const expected = Function(source)()
          const result = await state.run('dynamic-scope-contract', source)
          assert.equal(result.error, undefined, result.error?.message)
          assert.deepEqual(result.value, expected)
        })
      }
    } finally {
      await state.dispose()
    }
  })
}
