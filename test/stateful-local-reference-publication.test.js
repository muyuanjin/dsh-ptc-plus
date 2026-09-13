import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { SessionRuntime } from '../internal/session-runtime.js'

function session(t) {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  return async (program, id = 'local-reference-publication') => {
    const result = await runtime.run(id, { program, bindings: [] })
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    return result.value
  }
}

test('local identifier deletion retains the same binding as root deletion', async t => {
  const run = session(t)
  assert.deepEqual(await run('function f(){let x=1;return [delete x,x]};return f()'), [false, 1])
  assert.deepEqual(await run('let x=1;return [delete x,x]', 'root-delete'), [false, 1])
  assert.deepEqual(await run(`function f(){
    let x=1;const read=()=>x;const remove=()=>delete x;
    const first=[remove(),read()];x=2;return [first,remove(),read()];
  }return f()`), [[false, 1], false, 2])
})

test('delete never reads lexical, parameter, catch or iteration storage', async t => {
  const run = session(t)
  assert.deepEqual(await run(`function f(value=delete later,later=2){
    const result=[value,delete later,later,delete uninitialized];
    let uninitialized=3;result.push(uninitialized);
    {result.push(delete block);let block=4;result.push(delete block,block)}
    try{throw 5}catch(caught){result.push(delete caught,caught)}
    for(let index=0;index<1;index++)result.push(delete index,index);
    for(const item of [6])result.push(delete item,item);
    for(const key in {a:1})result.push(delete key,key);
    function parameter(x,x,other=delete x){return [other,delete x,x]}
    result.push(parameter(7,8));return result;
  }return f()`), [false, false, 2, false, 3, false, false, 4, false, 5,
    false, 0, false, 6, false, 'a', [false, false, 8]])
})

test('transparent deletion wrappers preserve references while value expressions still evaluate', async t => {
  const run = session(t)
  assert.deepEqual(await run(`function f(){
    let x=1;const effects=[];
    const wrapped=[delete (x),delete (x as number),delete x!,
      delete (x satisfies number),delete (<number>x),delete ((x as number)!)];
    const value=delete (effects.push('value'),x);
    const object={get item(){throw Error('GetValue')},kept:2};
    const property=delete (object[effects.push('key')&&'item'] as unknown);
    const optional=delete object?.kept;
    return [wrapped,x,value,property,optional,Object.keys(object),effects];
  }return f()`), [[false, false, false, false, false, false], 1, true, true, true, [], ['value', 'key']])
})

test('strict identifier deletion remains an early syntax error through transparent wrappers', async t => {
  for (const operand of ['x', '(x)', '(x as number)', 'x!', '(x satisfies number)', '(<number>x)']) {
    assert.throws(() => normalizeStatefulScopes(`function f(){'use strict';let x=1;delete ${operand}}`), SyntaxError, operand)
  }
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  for (const body of ["'use strict';let x=1;delete x", "class C{method(){let x=1;delete (x as number)}}"]) {
    const result = await runtime.run('strict-delete', { program: `globalThis.reached=true;function f(){${body}}`, bindings: [] })
    assert.ok(result.error)
    assert.equal((await runtime.run('strict-delete', { program: 'return globalThis.reached===true', bindings: [] })).value, false)
  }
})

test('local dynamic deletion distinguishes static bindings, eval vars and with properties', async t => {
  const run = session(t)
  assert.deepEqual(await run(`function f(){
    let x=1;var y=2;
    eval('var temporary=3');const read=()=>temporary;
    const result=[eval('delete x'),delete x,eval('delete y'),delete y,delete (temporary as number),typeof temporary];
    eval('var temporary=4');result.push(read(),eval('delete temporary'),typeof temporary);
    const object={x:5};with(object){result.push(delete (x as number))}
    with({}){result.push(delete (x as number))}
    result.push(x,y,Object.keys(object).length);return result;
  }return f()`), [false, false, false, false, true, 'undefined', 4, true, 'undefined', true, false, 1, 2, 0])
})

test('failed local var loop patterns publish no partial declarator while assignments do', async t => {
  const run = session(t)
  for (const loop of ['of [[1]]', 'in {1:0}']) {
    const body = `var x=10,y=20;
      try{for(var [x,y=(()=>{throw Error('stop')})()] ${loop}){}}catch{}
      return [x,y]`
    assert.deepEqual(await run(`function f(){${body}};return f()`), [10, 20], loop)
    assert.deepEqual(await run(body, `root-${loop}`), [10, 20], loop)
    assert.deepEqual(await run(`function f(){var x=10,y=20;
      try{for([x,y=(()=>{throw Error('stop')})()] ${loop}){}}catch{}
      return [x,y]};return f()`), [loop.startsWith('of') ? 1 : '1', 20], loop)
  }
})

test('var loop candidate defaults and escaped closures retain failed values or follow publication', async t => {
  const run = session(t)
  assert.deepEqual(await run(`function f(){
    var x=10,y=20;let failed,successful;const old=()=>x;
    try{for(var [x,y=(failed=()=>x,(()=>{throw Error('stop')})())] of [[1]]){}}catch{}
    const before=[x,y,old(),failed()];
    for(var [x,y=(successful=()=>x,x+1)] of [[2]]){}
    x=9;return [before,x,y,old(),failed(),successful()];
  }return f()`), [[10, 20, 10, 1], 9, 3, 9, 1, 9])
  assert.deepEqual(await run(`function f(){
    var x='old',y='kept';let failed,successful;
    try{for(var {0:x,missing:y=(failed=()=>x,(()=>{throw Error('stop')})())} in {a:1}){}}catch{}
    const before=[x,y,failed()];
    for(var {0:x,missing:y=(successful=()=>x,x+'!')} in {b:1,c:2}){}
    x='next';return [before,x,y,failed(),successful()];
  }return f()`), [['old', 'kept', 'a'], 'next', 'c!', 'a', 'next'])
})

test('loop candidate dynamic defaults and closures use the declaration owner', async t => {
  const run = session(t)
  assert.deepEqual(await run(`function f(){
    var x=10,y=20;let failed,successful;
    try{for(var [x,y=(failed=()=>eval('x'),eval('throw Error("stop")'))] of [[1]]){}}catch{}
    const before=[x,y,failed()];
    for(var [x,y=(successful=()=>eval('x'),eval('x+1'))] of [[2]]){}
    eval('x=9');return [before,x,y,failed(),successful()];
  }return f()`), [[10, 20, 1], 9, 3, 1, 9])
})

test('loop publication preserves getter effects, iterator closing and control flow', async t => {
  const run = session(t)
  assert.deepEqual(await run(`function f(){
    var x=10,y=20;const effects=[];
    const inner={ [Symbol.iterator](){effects.push('inner-open');let n=0;return {
      next(){effects.push('inner-next');return {value:n++===0?1:undefined,done:false}},
      return(){effects.push('inner-close');return {}}
    }}};
    function* outer(){try{effects.push('outer-open');yield inner}finally{effects.push('outer-close')}}
    try{for(var [x,y=(effects.push('default'),(()=>{throw Error('stop')})())] of outer())effects.push('body')}
    catch(error){effects.push(error.message)}
    const before=[x,y];
    function* rows(){try{yield {get a(){effects.push('get-a');return 3},get b(){effects.push('get-b');return 4}}}
      finally{effects.push('success-close')}}
    outer:for(var {a:x,b:y} of rows()){effects.push('body');break outer}
    const readers=[];for(var [x,y=x+1] of [[5],[6]]){readers.push(()=>[x,y]);continue}
    const lexical=[];for(let [item,read=()=>item] of [[7],[8]])lexical.push(read);
    return [before,x,y,readers.map(read=>read()),lexical.map(read=>read()),effects];
  }return f()`), [[10, 20], 6, 7, [[6, 7], [6, 7]], [7, 8],
    ['outer-open', 'inner-open', 'inner-next', 'inner-next', 'default', 'inner-close', 'outer-close', 'stop',
      'get-a', 'get-b', 'body', 'success-close']])
})

test('root loop candidates retain previous-cell bindings on failure', async t => {
  const run = session(t)
  await run('var x=10,y=20;const read=()=>[x,y]', 'root-continuity')
  assert.deepEqual(await run(`try{for(var [x,y=(()=>{throw Error('stop')})()] of [[1]]){}}catch{}
    return read()`, 'root-continuity'), [10, 20])
})

test('loop declarations keep parameter aliases and function var ownership across blocks', async t => {
  const run = session(t)
  assert.deepEqual(await run(`function f(x){
    var y=20;const read=()=>x;
    {let x=30;for(var [x,y=x+1] of [[2]]){}if(x!==30)throw Error('shadow')}
    const success=[x,y,arguments[0],read()];
    try{for(var [x,y=(()=>{throw Error('stop')})()] of [[3]]){}}catch{}
    return [success,x,y,arguments[0],read()];
  }return f(10)`), [[2, 31, 2, 2], 2, 31, 2, 2])
})

test('successful root and local loop declarators share defaults', async t => {
  const run = session(t)
  for (const loop of ['of [[1],[2]]', 'in {a:0,b:0}']) {
    const body = `var x=10,y=20;const values=[];
      for(var [x,y=x] ${loop}){values.push([x,y])}
      return [x,y,values]`
    const values = loop.startsWith('of') ? [1, 2] : ['a', 'b']
    const expected = [values[1], values[1], values.map(value => [value, value])]
    assert.deepEqual(await run(`function f(){${body}};return f()`), expected)
    assert.deepEqual(await run(body, `root-success-${loop}`), expected)
  }
  assert.deepEqual(await run(`function f(){var x=10,y=20;
    for(var [x,y=delete x] of [[1]]){}return [x,y]
  }return f()`), [1, false])
})

test('async iteration closes on candidate failure without publishing acquired elements', async t => {
  const run = session(t)
  assert.deepEqual(await run(`async function f(){
    var x=10,y=20;const effects=[];
    async function* rows(){try{effects.push('open');yield [1]}finally{effects.push('close')}}
    try{for await(var [x,y=(()=>{throw Error('stop')})()] of rows())effects.push('body')}
    catch(error){effects.push(error.message)}
    return [x,y,effects];
  }return await f()`), [10, 20, ['open', 'close', 'stop']])
})
