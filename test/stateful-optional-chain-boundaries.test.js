import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'

const body = `
  const events=[];
  const child={get method(){events.push('get-method');return method}};
  function method(value){events.push('invoke');return [this===child,value]}
  Object.defineProperties(method,{
    call:{get(){throw Error('unexpected call property')}},
    bind:{get(){throw Error('unexpected bind property')}}
  });
  const parent={get child(){events.push('get-child');return child}};
  const absent=null;
  const results=[];
  results.push(absent?.child.method(events.push('skipped-argument')));
  results.push(absent?.child[(events.push('skipped-key'),'method')](events.push('skipped-argument')));
  results.push(absent?.child.method?.(events.push('skipped-argument')));
  results.push(parent?.child.method(events.push('argument')));
  results.push(parent.child.method?.(events.push('optional-argument')));
  results.push((parent?.child.method)(events.push('grouped-argument')));
  for(const run of [()=>method?.call(null),()=>method.bind(null)]){
    try{run()}catch(error){results.push(error.message)}
  }
  results.push((()=>null)?.()?.child.method(events.push('skipped-argument')));
  const getter=()=>parent;
  results.push(getter()?.child.method?.(events.push('nested-argument')));
  const tags={tag(parts,value){return [this===tags,parts[0],value]}};
  results.push((tags?.tag)\`tag:\${4}\`);
  const tagSource={next(){events.push('tag-source');return tags}};
  results.push((tagSource?.next().tag)\`tag:\${5}\`);
  try{(absent?.next().tag)\`tag:\${events.push('absent-tag-argument')}\`}catch(error){results.push(error.name)}
  for(const run of [()=>({child:undefined})?.child.method(),()=> (absent?.child).method(),()=> (absent?.method)()]){
    try{run()}catch(error){results.push(error.name)}
  }
  const removable={key:1};results.push(delete removable?.key,delete absent?.key,Object.hasOwn(removable,'key'));
  return [results.map(value=>value===undefined?'undefined':value),events]
`

test('complete optional chains retain receivers, skipped effects and parenthesized boundaries at every entry', async t => {
  const expected = Function(body)()
  for (const options of [
    { bindingUpdates: 'stateful' },
    { bindingUpdates: 'protected' },
    { legacyBindingSettings: true },
  ]) {
    const runtime = new SessionRuntime({ ...options, durableReplay: false })
    t.after(() => runtime.dispose())
    for (const [entry, program] of [
      ['root', body],
      ['local', `function run(){${body}};return run()`],
      ['eval', `return eval(${JSON.stringify(`(function(){${body}})()`)})`],
      ['Function', `return Function(${JSON.stringify(body)})()`],
      ['module', `const mod=await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(`export const result=(function(){${body}})()`))});return mod.result`],
    ]) {
      const result = await runtime.run(`optional-chain-${entry}`, { program, bindings: [] })
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, expected, entry)
    }
  }
})

test('optional eval calls remain indirect and parameter defaults preserve receiver evaluation once', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runtime.run('optional-eval', { bindings: [], program: `
    const value=41;
    function read(){const value=99;return eval?.('value')}
    const effects=[];
    function input(){effects.push('input');return {value:2,method(){return this.value}}}
    function parameter(value=input()?.method()){return value}
    return [read(),parameter(),effects]
  ` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [41,2,['input']])
})
