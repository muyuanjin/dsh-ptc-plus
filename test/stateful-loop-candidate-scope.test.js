import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'

async function execute(runtime, id, program) {
  try { return await runtime.run(id, { program, bindings: [] }) }
  finally { await runtime.disposeSession(id) }
}

const cases = [
  ['body reads', "const values=[];for(let i=0;i<3;i++)values.push(eval('i'));return values"],
  ['body writes', "const values=[];for(let i=0;i<4;i++){values.push([eval('i++'),i])}return values"],
  ['test and update', "const values=[];for(let i=0;eval('i<3');eval('i++')){values.push(i);if(values.length>4)break}return values"],
  ['body closures', "const reads=[];for(let i=0;i<3;i++)reads.push(()=>eval('i'));return reads.map(read=>read())"],
  ['eval-created closures', "const reads=[];for(let i=0;i<3;i++)reads.push(eval('()=>i'));return reads.map(read=>read())"],
  ['test and update closures', `const tests=[],updates=[];for(let i=0;(tests.push(()=>eval('i')),i<3);(updates.push(()=>eval('i')),i++)){}
    return [tests.map(read=>read()),updates.map(read=>read())]`],
  ['initializer closure', `let initial;const values=[];for(let i=(initial=()=>eval('i'),0);i<3;i++)values.push(eval('i'));
    return [values,initial()]`],
  ['pattern closure', `let initial;const values=[];for(let [i,read=()=>eval('i')]=[0];i<3;i++){initial=read;values.push(eval('i'))}
    return [values,initial()]`],
  ['multiple declarators', `const values=[];for(let i=0,j=eval('i+10');i<3;i++,j++)values.push(eval('[i,j]'));return values`],
  ['later declarator closure', `const values=[];for(let i=0,j=()=>eval('i');i<3;i++)values.push([eval('i'),j()]);return values`],
  ['nested loop scopes', `const values=[];for(let i=0;i<2;i++){for(let i=5;i<7;i++)values.push(eval('i'));values.push(eval('i'))}return values`],
  ['default parameters', `const reads=[];for(let i=0;i<3;i++)reads.push((value=eval('i'))=>value);return reads.map(read=>read())`],
  ['method closures', `const reads=[];for(let i=0;i<3;i++)reads.push({read(){return eval('i')}});return reads.map(owner=>owner.read())`],
  ['computed destructuring defaults', `const values=[];for(let {[eval('"x"')]:i=0,...rest}={extra:2};i<3;i++)values.push(eval('[i,rest.extra]'));return values`],
  ['array rest and shorthand', `const values=[];for(let [i,,...rest]=[0,1,2];i<3;i++)values.push(eval('({i,rest:[...rest]})'));return values`],
  ['switch source scope', `const values=[];for(let i=0;i<3;i++){switch(eval('i')){
    case 0:let i=7;values.push(eval('i'));break;default:values.push('later')
  }}return values`],
]

for (const [mode, options] of [
  ['stateful', { bindingUpdates: 'stateful' }],
  ['protected', { bindingUpdates: 'protected' }],
  ['legacy', { legacyBindingSettings: true }],
]) {
  test(`${mode} loop eval resolves initializer candidates and current iteration bindings separately`, async t => {
    const runtime = new SessionRuntime({ ...options, durableReplay: false })
    t.after(() => runtime.dispose())
    for (const [name, source] of cases) {
      const result = await execute(runtime, `loop-candidate-${mode}-${name}`, source)
      assert.equal(result.error, undefined, `${name}: ${result.error?.message}`)
      assert.deepEqual(result.value, Function(source)(), name)
    }
  })
}

test('local, module and runtime-created loop source preserve candidate scope boundaries', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  for (const [name, source] of cases) {
    for (const [entry, program, strict] of [
      ['function', `return (function(){${source}})()`, false],
      ['eval', `return eval(${JSON.stringify(`(function(){${source}})()`)})`, false],
      ['Function', `return Function(${JSON.stringify(source)})()`, false],
      ['module', `return (await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(`export const value=(function(){${source}})()`)}`)})).value`, true],
    ]) {
      const result = await execute(runtime, `loop-candidate-${entry}-${name}`, program)
      assert.equal(result.error, undefined, `${entry}/${name}: ${result.error?.message}`)
      assert.deepEqual(result.value, Function(`${strict ? '"use strict";' : ''}${source}`)(), `${entry}/${name}`)
    }
  }
})

test('candidate closures retain failed values and follow successful declaration publication', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  for (const [name, body, expected] of [
    ['failed pattern', `let value=1,escaped;try{const [value,other=(escaped=()=>eval('value'),(()=>{throw 1})())]=[2]}catch{}
      return [eval('value'),escaped()]`, [1,2]],
    ['successful pattern', `let value=1,escaped;const [value,other=(escaped=()=>eval('value'),3)]=[2];
      value=4;return [eval('value'),escaped()]`, [4,4]],
    ['nested candidate', `let value=1,escaped;const [value,other=(()=>{const read=()=>eval('value');escaped=read;return read()})()]=[2];
      value=4;return [other,escaped()]`, [2,4]],
    ['parameter update', `function read(value){const [value,next=()=>eval('value')]=[2];value=3;return next()};return read(1)`, 3],
    ['multiple declarations', `const values=[];for(let i=1,i=eval('i+1');i<4;i++)values.push(eval('i'));return values`, [2,3]],
  ]) {
    for (const [entry, program] of [
      ['local', `return (function(){${body}})()`],
      ['module', `return (await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(`export const value=(function(){${body}})()`)}`)})).value`],
    ]) {
      const result = await execute(runtime, `candidate-publication-${entry}-${name}`, program)
      assert.equal(result.error, undefined, `${entry}/${name}: ${result.error?.message}`)
      assert.deepEqual(result.value, expected, `${entry}/${name}`)
    }
  }
})

test('candidate descriptors preserve delegated with targets during pattern defaults', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  for (const object of ['{value:9}', '{}']) {
    const source = `function run(){var value=1;with(${object}){
      var [value,other=eval('({value})')]=[3];return [value,other]
    }}return run()`
    const result = await execute(runtime, `candidate-with-${object}`, source)
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, Function(source)())
  }
})

test('runtime-created loop closures resolve shorthand fields from their captured iteration', () => {
  const runtime = createDynamicEnvironmentRuntime()
  const environment = runtime.environment()
  const source = `const reads=[];for(let value=0;value<3;value++)reads.push(()=>eval('({value})'));
    reads.map(read=>read())`
  assert.deepEqual(runtime.evaluate(eval, undefined, [source], environment), [{ value: 0 },{ value: 1 },{ value: 2 }])
})
