import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { analyzeLogicalScopes, normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { loadManagedSource, managedGraph } from './managed-module-fixture.js'
import { fixture } from './plugin-fixture.js'
import { PROTECTED_MODULE_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/module-transform-contract.js'

function run(source, options) {
  const code = normalizeStatefulScopes(source, undefined, options).code
  return options?.target === 'commonjs' ? Function('require', code)(createRequire(import.meta.url)) : Function(code)()
}

test('named function self and same-spelled body declarations have distinct logical owners', () => {
  const facts = analyzeLogicalScopes('const f=function inner(){const inner=1;const inner=2;return inner}')
  const groups = [...facts.scopes.values()].flatMap(scope => [...scope.values()])
    .filter(group => group.name === 'inner')
  assert.equal(groups.length, 2)
  const self = groups.find(group => group.occurrences.some(item => item.role === 'self'))
  const body = groups.find(group => group !== self)
  assert.notEqual(self.scope, body.scope)
  assert.deepEqual(self.occurrences.map(item => item.role), ['self'])
  assert.deepEqual(body.occurrences.map(item => item.role), ['variable', 'variable'])
})

test('named function body updates are independent of spelling relative to self', () => {
  for (const name of ['inner', 'local']) {
    for (const declarations of [
      `const ${name}=1;const ${name}=2`,
      `const ${name}=1;${name}=2`,
      `let ${name}=1;let ${name}=2`,
      `const [${name},${name}]=[1,2]`,
      `const ${name}=1;const [${name}]=[2]`,
      `const ${name}=1;const ${name}=${name}+1`,
    ]) {
      const source = `const f=function inner(){${declarations};return ${name}};return f()`
      assert.equal(run(source), 2, source)
    }
  }
})

test('self recursion and saved self closures retain the function after outer updates', () => {
  assert.deepEqual(run(`
    let inner=99;
    let f=function inner(n){const x=1;const x=2;return n===0?[inner,()=>inner,x]:inner(n-1)};
    const original=f;const result=f(3);f=0;inner=0;
    return [result[0]===original,result[1]()===original,result[2],original.name];
  `), [true, true, 2, 'inner'])
  assert.deepEqual(run(`
    const f=function inner(){
      const self=()=>inner;
      {const inner=1;const read=()=>inner;const inner=2;inner++;
       return [self(),read(),()=>inner]}
    };
    const result=f();return [result[0]===f,result[1],result[2]()];
  `), [true, 3, 3])
})

test('parameter defaults resolve self outside body declarations and keep parameter shadows', () => {
  assert.deepEqual(run(`
    const f=function inner(saved=inner,read=()=>inner){
      const inner=1;const body=()=>inner;const inner=2;inner++;
      return [saved,read,body];
    };
    const result=f();return [result[0]===f,result[1]()===f,result[2](),f.length];
  `), [true, true, 3, 0])
  assert.deepEqual(run(`
    const f=function inner(inner,read=()=>inner){const inner=2;inner=3;return [read(),inner]};
    const g=function inner(inner=1,read=()=>inner,inner=2){inner=3;return [read(),inner]};
    const mapped=function inner(inner){const inner=2;arguments[0]=3;return [inner,arguments[0]]};
    return [f(1),g(),mapped(1)];
  `), [[3, 3], [3, 3], [3, 3]])
  assert.throws(() => run('const f=function inner(inner=inner){return inner};return f()'), ReferenceError)
})

test('strict self writes stay immutable while strict body updates retain stateful policy', () => {
  assert.deepEqual(run(`
    const sloppy=function inner(){inner=0;return inner};
    const strict=function inner(){'use strict';inner=0;return inner};
    let failed=false;try{strict()}catch(error){failed=error instanceof TypeError}
    const body=function inner(){'use strict';const inner=1;const inner=2;inner++;return [inner,this]};
    return [sloppy()===sloppy,failed,body()];
  `), [true, true, [3, undefined]])
  assert.throws(() => run('const f=function inner(){const inner=1;inner=2;return inner};return f()',
    { mode: 'protected-v1' }), TypeError)
  assert.throws(() => run('const f=function inner(){const inner=1;const inner=2;return inner};return f()',
    { mode: 'protected-v1' }), SyntaxError)
})

test('failed body initialization retains TDZ and does not replace the self default', () => {
  assert.throws(() => run('const f=function inner(){return inner;const inner=1};return f()'), ReferenceError)
  assert.deepEqual(run(`
    let readBody,readSelf,effects=[];
    const f=function inner(saved=()=>inner){
      readSelf=saved;readBody=()=>inner;
      const inner=(effects.push('initializer'),(()=>{throw new Error('failed')})());
      effects.push('unreached');
    };
    let failure;try{f()}catch(error){failure=error.message}
    let uninitialized=false;try{readBody()}catch(error){uninitialized=error instanceof ReferenceError}
    return [failure,uninitialized,readSelf()===f,effects];
  `), ['failed', true, true, ['initializer']])
  assert.deepEqual(run(`
    const f=function inner(){
      const inner=1;const read=()=>inner;let escaped;
      try {var [inner,extra=(escaped=()=>inner,(()=>{throw 1})())]=[2]}catch{}
      const before=[inner,read(),escaped(),extra===undefined];
      const inner=3;return [before,read(),escaped()];
    };
    return f();
  `), [[1, 1, 2, true], 3, 2])
})

test('body var and function declarations shadow self only inside the body', () => {
  assert.deepEqual(run(`
    const f=function inner(self=inner){const before=inner;var inner=1;var inner=2;return [self===f,before,inner]};
    const g=function inner(self=inner){function inner(){return 3}return [self===g,inner()]};
    return [f(),g()];
  `), [[true, undefined, 2], [true, 3]])
})

test('default parameter closures keep their environment when the body redeclares a parameter', () => {
  for (const name of ['inner', 'local']) {
    for (const body of [
      `var ${name}=3;return [read(),${name}]`,
      `var ${name};write(2);return [read(),${name}]`,
      `var ${name}=3;write(2);return [read(),${name}]`,
      `function ${name}(){return 3};return [read(),${name}()]`,
      `const before=${name}();function ${name}(){return 3};var ${name};return [read(),before,${name}()]`,
      `const before=${name}();var ${name}=4;function ${name}(){return 3};return [read(),before,${name}]`,
    ]) {
      const source = `const f=function inner(${name}=1,read=()=>${name},write=value=>${name}=value){${body}};return f()`
      assert.deepEqual(run(source), Function(source)(), source)
    }
  }
  const computed = `let read;
    const f=function inner({[(read=()=>inner,'value')]:inner}){var inner=3;return [read(),inner]};
    return f({value:1});`
  assert.deepEqual(run(computed), Function(computed)())
  const multiple = `const f=function inner(inner=1,other=2,read=()=>[inner,other]){
    var inner=3,other=4;return [read(),inner,other];
  };return f()`
  assert.deepEqual(run(multiple), Function(multiple)())
})

test('body declarations preserve native arguments and legal function hoisting', () => {
  for (const source of [
    'const f=function arguments(x){var arguments;return [arguments[0],arguments.length]};return f(7)',
    'const f=function arguments(x=1){var arguments;return [arguments[0],arguments.length]};return f(7)',
    'const f=function arguments(x=1,read=()=>arguments){var arguments;const before=read();arguments=2;return [before[0],read()===before,arguments]};return f(7)',
    'const f=function inner(){const before=inner();var inner;function inner(){return 3}return before};return f()',
    'const f=function inner(saved=inner){const before=inner();function inner(){return 3}var inner;return [saved===f,before]};return f()',
    'const f=function inner(inner){const before=inner();function inner(){return 3}var inner;return [before,arguments[0]===inner]};return f(1)',
    'const f=function inner(inner){const before=inner();var inner=4;function inner(){return 3}return [before,inner,arguments[0]]};return f(1)',
  ]) assert.deepEqual(run(source), Function(source)(), source)
})

const argumentsInitializations = [
  `function f(a=eval('arguments[0]')){var arguments;return [a===undefined,arguments.length]}
    return [f(),f(7,9),f()]`,
  `function f(a=()=>eval('arguments.length')){var arguments;return [a(),arguments.length]}
    return [f(),f(undefined,9)]`,
  `function f(a=()=>eval('arguments.length')){var arguments=[1,2];return [a(),arguments.length]}
    return [f(),f(undefined,9)]`,
  `function f(a=eval('arguments=[4,5]'),read=()=>arguments){
    var arguments;const initial=arguments;arguments=[8];return [a===initial,read()===initial,initial,arguments]}
    return [f(),f()]`,
  `function f(a=eval('var arguments=[4,5]'),read=()=>arguments){
    var arguments;const initial=arguments;arguments=[8];return [read()===initial,initial,arguments]}
    return [f(),f()]`,
  `const f=function arguments(a=eval('arguments.length')){var arguments;return [a,arguments.length]};
    return [f(),f(undefined,9)]`,
  `function f(a=eval('arguments.length'),...rest){var arguments;return [a,arguments.length,rest]}
    return [f(),f(undefined,9)]`,
  `function f(a=1,read=()=>arguments){var arguments;const initial=arguments;
    arguments=[8];return [read()===initial,initial.length,eval('arguments')===arguments]}
    return [f(),f(7,undefined,9)]`,
  `function f(a){var arguments;const initial=arguments;arguments=[8];
    return [initial.length,eval('arguments')===arguments,arguments[0]]}
    return [f(),f(7,9)]`,
  `const f=function arguments(a){return [arguments.length,eval('arguments')===arguments]};
    return [f(),f(7,9)]`,
  `function f(a=eval('arguments.length')){return [a,arguments.length]}
    return [f(),f(undefined,9)]`,
  `function f(arguments=[1],read=()=>eval('arguments')){var arguments;
    const initial=arguments;arguments=[8];return [read()===initial,initial,arguments]}
    return [f(),f([4,5])]`,
]

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`parameter initial values survive dynamic adaptation and callable reconstruction (${bindingUpdates})`, async () => {
    for (const [index, source] of argumentsInitializations.entries()) {
      const expected = Function(source)()
      const state = fixture({ bindingUpdates })
      try {
        for (const reconstruct of [false, true]) {
          const program = reconstruct ? `function original(){${source}};
            const restored=Function('return ('+original.toString()+')')();return restored()` : source
          const result = await state.run(`arguments-initial-${index}-${reconstruct}`, program)
          assert.equal(result.error, undefined, result.error?.message+'\n'+program)
          assert.deepEqual(result.value, expected, program)
        }
      } finally {
        await state.dispose()
      }
    }
  })

  test(`managed CommonJS consumes parameter initialization ownership (${bindingUpdates})`, async t => {
    const source = `module.exports=[${argumentsInitializations.map(source => `function(){${source}}`).join(',')}];`
    const graph = await managedGraph(t, { 'root.cjs': source, 'native.cjs': source }, 'root.cjs', ['native.cjs'])
    graph.compilation.mark(graph.url('root.cjs'), {
      transform: bindingUpdates === 'stateful' ? USER_BINDING_TRANSFORM : PROTECTED_MODULE_TRANSFORM,
    })
    const actual = (await graph.load()).default
    const expected = graph.opaque['native.cjs'].default
    for (let index = 0; index < actual.length; index++) {
      assert.deepEqual(actual[index](), expected[index](), argumentsInitializations[index])
    }
  })
}

test('named async and generator functions update body shadows', async () => {
  assert.equal(await run('const f=async function inner(){const inner=1;await 0;const inner=2;return inner};return f()'), 2)
  assert.deepEqual(run('const f=function* inner(){const inner=1;yield inner;const inner=2;yield inner};return [...f()]'), [1, 2])
})

test('named function scopes stay distinct in managed modules and CommonJS', async t => {
  const source = 'const f=function inner(saved=inner){const inner=1;const inner=2;return [inner,saved===f]};'
  const namespace = await loadManagedSource(t, source + 'export const result=f()')
  assert.deepEqual(namespace.result, [2, true])
  assert.deepEqual(run(source + 'return f()', { target: 'commonjs' }), [2, true])
  const hoisted = await loadManagedSource(t,
    'export const before=inner();export var inner;export function inner(){return 3}')
  assert.equal(hoisted.before, 3)
  assert.equal(hoisted.inner(), 3)
})

test('worker execution preserves named function body updates and closures across cells', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  const execute = async (session, source) => {
    const result = await state.run(session, source)
    assert.equal(result.error, undefined)
    return result.value
  }
  assert.equal(await execute('self-duplicates',
    'const f=function inner(){const inner=1;const inner=2;return inner};return f()'), 2)
  assert.equal(await execute('self-assignment',
    'const f=function inner(){const inner=1;inner=2;return inner};return f()'), 2)
  assert.deepEqual(await execute('self-closures', `
    const f=function inner(readSelf=()=>inner){const inner=1;const readBody=()=>inner;
      const inner=2;return {readSelf,readBody,write(value){inner=value}}};
    const retained=f();return [retained.readSelf()===f,retained.readBody()];
  `), [true, 2])
  assert.deepEqual(await execute('self-closures',
    'const original=f;f=0;retained.write(7);return [retained.readSelf()===original,retained.readBody()]'),
  [true, 7])
  assert.deepEqual(await execute('parameter-body', `
    const f=function inner(inner=1,read=()=>inner,write=value=>inner=value){
      var inner=3;return {read,write,body:()=>inner};
    };
    const retained=f();retained.write(2);return [retained.read(),retained.body()];
  `), [2, 3])
  assert.deepEqual(await execute('parameter-body',
    'retained.write(4);return [retained.read(),retained.body()]'), [4, 3])
  assert.deepEqual(await execute('parameter-body-eval', `
    const f=function inner(inner=1,read=()=>eval('inner')){
      var inner=3;return [read(),eval('inner')];
    };return f();
  `), [1, 3])
  assert.deepEqual(await execute('self-arguments',
    'const f=function arguments(x=1){var arguments;return [arguments[0],arguments.length]};return f(7)'), [7, 1])
  assert.deepEqual(await execute('self-hoisting',
    'const f=function inner(){const before=inner();var inner;function inner(){return 3}return before};return f()'), 3)
})
