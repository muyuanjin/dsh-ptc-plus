import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

const assignments = `
  let value,logical,pattern,__proto__,wrapped;
  const effects=[];
  value=()=>1;logical||=class{static observed=this.name};
  [pattern=()=>2]=[];__proto__=()=>3;
  wrapped=((()=>4) as Function);
  const before=logical;logical||=(effects.push('unreachable'),()=>0);
  let explicit;explicit=function named(){};
  const object={};object.member=()=>5;
  const result=[value.name,logical.name,logical.observed,pattern.name,__proto__.name,
    wrapped.name,logical===before,effects.length,explicit.name,object.member.name];
`

test('source identifiers own assignment name inference across root, local and module entries', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const expected = ['value','logical','logical','pattern','__proto__','wrapped',true,0,'named','']
  for (const [name, program] of [
    ['root', `${assignments}return result`],
    ['local', `function run(){${assignments}return result};return run()`],
    ['module', `const mod=await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(`${assignments.replace(' as Function','')}export {result}`))});return mod.result`],
  ]) {
    const result = await runtime.run(name, { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, expected, name)
  }
})

test('dynamic logical assignments and pattern defaults retain source names and short circuit effects', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const source = `var x,y,__proto__;x||=()=>1;y??=class{static observed=this.name};
    __proto__=()=>2;var pattern;[pattern=()=>3]=[];[x.name,y.name,y.observed,__proto__.name,pattern.name]`
  const result = await runtime.run('dynamic-assignment-names', { program: `return eval(${JSON.stringify(source)})`, bindings: [] })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, ['x','y','y','__proto__','pattern'])
})

const properties = `
  const __proto__={marker:1};
  const object={__proto__};
  const explicit={__proto__:__proto__};
  const {__proto__:saved}=object;
  const result=[Object.hasOwn(object,'__proto__'),Object.getPrototypeOf(object)===Object.prototype,
    saved===__proto__,Object.getOwnPropertyDescriptor(object,'__proto__').enumerable,
    Object.getPrototypeOf(explicit)===__proto__,Object.hasOwn(explicit,'__proto__')];
`

test('shorthand expansion preserves __proto__ as data while explicit prototype syntax remains native', async t => {
  for (const bindingUpdates of ['stateful','protected']) {
    const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
    t.after(() => runtime.dispose())
    for (const [name, program] of [
      ['root',`${properties}return result`],
      ['local',`function run(){${properties}return result};return run()`],
      ['dynamic',`return eval(${JSON.stringify(properties+'result')})`],
      ['module',`const mod=await import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(properties+'export {result}'))});return mod.result`],
    ]) {
      const result = await runtime.run(`${bindingUpdates}-${name}`, { program, bindings: [] })
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, [true,true,true,true,true,false], `${bindingUpdates}-${name}`)
    }
  }
})
