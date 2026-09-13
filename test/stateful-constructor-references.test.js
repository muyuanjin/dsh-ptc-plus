import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

const constructors = `
const effects=[];
class Base {
  constructor(value=4){effects.push(['construct',value]);this.value=value;this.target=new.target}
  read(){return this.value}
}
const Alias=Base;
const Holder={get Ctor(){effects.push('get');return Alias}};
const a=new Alias, b=new Alias(7), c=new Holder.Ctor(8), d=new Holder['Ctor'], e=new (Alias)(9);
const values=[a,b,c,d,e];
const result=[values.map(value=>value.read()),values.every(value=>value.target===Alias),effects];
`

for (const bindingUpdates of ['stateful','protected']) {
  test(`${bindingUpdates} constructor references retain new grouping, member effects and new.target`, async t => {
    const expected = Function(constructors + 'return result')()
    const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
    t.after(() => runtime.dispose())
    const moduleUrl = 'data:text/javascript,' + encodeURIComponent(constructors + 'export {result}')
    for (const [entry, program] of [
      ['root', constructors + 'return result'],
      ['module', `return (await import(${JSON.stringify(moduleUrl)})).result`],
    ]) {
      const result = await runtime.run(`constructor-${bindingUpdates}-${entry}`, { bindings: [], program })
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, expected, entry)
    }
  })
}

test('imported constructor references keep argument evaluation and original constructor identity', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const provider = 'data:text/javascript,' + encodeURIComponent('export class Base{constructor(value=4){this.value=value;this.target=new.target}}')
  const consumer = `import {Base as Alias} from ${JSON.stringify(provider)};
    let hits=0;const direct=new Alias(++hits);const implicit=new Alias;
    const holder={Ctor:Alias};const member=new holder.Ctor(++hits);
    export const result=[direct.value,implicit.value,member.value,hits,
      [direct,implicit,member].every(value=>value.target===Alias)];`
  const url = 'data:text/javascript,' + encodeURIComponent(consumer)
  const result = await runtime.run('imported-constructor', { bindings: [], program: `return (await import(${JSON.stringify(url)})).result` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [1,4,2,2,true])
})

test('logical private constructor references preserve new and continued optional chains', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const body = `
    class Base{constructor(value){this.value=value;this.target=new.target}}
    Base.Nested=class extends Base{};
    class Owner{
      #Ctor=class Old{};#Ctor=Base;static #Ctor=Base;
      build(){return new this.#Ctor(5)}
      static build(receiver){return new receiver.#Ctor(6)}
      static member(receiver){return new receiver.#Ctor.Nested(7)}
      static absent(){let hits=0;let receiver=null;const value=receiver?.#Ctor[(hits++,'Nested')];return [value===undefined,hits]}
    }
    const owner=new Owner(),direct=owner.build(),instance=Owner.build(owner),statik=Owner.build(Owner),nested=Owner.member(owner);
    const result=[[direct.value,instance.value,statik.value,nested.value],
      [direct,instance,statik].every(value=>value.target===Base),nested.target===Base.Nested,Owner.absent()];
  `
  for (const [entry, program] of [
    ['root', body + 'return result'],
    ['module', `return (await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(body + 'export {result}'))})).result`],
  ]) {
    const result = await runtime.run(`private-constructor-${entry}`, { bindings: [], program })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [[5,6,6,7],true,true,[true,0]], entry)
  }
})
