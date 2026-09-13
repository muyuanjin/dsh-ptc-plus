import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { createDynamicScopeAnalysis, varInitializerTarget } from '../internal/dynamic-scope-analysis.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { fixture } from './plugin-fixture.js'

const traverse = traverseModule.default ?? traverseModule

function session(t) {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  let sequence = 0
  return async (program, id = `declaration-target-${sequence++}`) => {
    const result = await runtime.run(id, { program, bindings: [] })
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    return result.value
  }
}

test('var scalar and pattern initializers select the simple catch identity', async t => {
  const run = session(t)
  const sources = [
    'var e=7;let seen;try{throw 1}catch(e){var e=2;seen=e}return [seen,e]',
    'var e=7,x=8;let seen;try{throw 1}catch(e){var [e,x=e+1]=[2];seen=[e,x]}return [seen,e,x]',
    'var e=7,x=8;let seen;try{throw 1}catch(e){var {e,x=e+1}={e:2};seen=[e,x]}return [seen,e,x]',
    'let seen;try{throw 1}catch(e){var e=2;seen=e}return [seen,typeof e]',
    'var e=7;let seen;try{throw 1}catch(other){var e=2;seen=other}return [seen,e]',
    'var e=7;let seen;try{throw 1}catch(e){var e;seen=e}return [seen,e]',
    'var e=7;let seen;try{throw 1}catch(e){for(var e=2;e<3;e++)seen=e}return [seen,e]',
    'var e=7;let seen;try{throw 1}catch(e){try{var e=(()=>{throw 3})()}catch{}seen=e}return [seen,e]',
  ]
  for (const source of sources) {
    const expected = Function(source)()
    assert.deepEqual(await run(source), expected, source)
    assert.deepEqual(await run(`return (function(){${source}})()`), expected, source)
  }
})

test('catch loop targets preserve defaults, iteration order and iterator closing', async t => {
  const run = session(t)
  for (const head of ['var e of [2,3]', 'var e in {a:1,b:2}',
    'var [e,x=e] of [[2],[3]]', 'var {0:e,missing:x=e} in {a:1,b:2}']) {
    const source = `var e=7,x=8;const seen=[];try{throw 1}catch(e){for(${head})seen.push([e,x])}return [seen,e,x]`
    const expected = Function(source)()
    assert.deepEqual(await run(source), expected, source)
    assert.deepEqual(await run(`return (function(){${source}})()`), expected, source)
  }
  const source = `var e=7,x=8;let seen;const effects=[];
    try{throw 1}catch(e){
      function* rows(){try{yield [2]}finally{effects.push('close')}}
      try{for(var [e,x=(()=>{throw Error('stop')})()] of rows())effects.push('body')}
      catch(error){effects.push(error.message)}seen=e
    }return [seen,e,x,effects]`
  assert.deepEqual(await run(source), [2,7,8,['close','stop']])
  assert.deepEqual(await run(`return (function(){${source}})()`), [2,7,8,['close','stop']])
})

test('stateful ordinary block lexicals keep a separate identity from var targets', async t => {
  const run = session(t)
  assert.deepEqual(await run(`return (function(){var value=1;let seen;
    {let value=10;var value=2;seen=value}return [seen,value]})()`), [10,2])
  assert.deepEqual(await run(`return (function(){var value=1;let seen;
    try{throw 5}catch(value){{let value=10;var value=2;seen=value}}return [seen,value]})()`), [10,1])
})

test('Annex B publication selects the outer var owner under with and catch', async t => {
  const run = session(t)
  for (const source of [
    'let obj={a:1};with(obj){function f(){var a=2;return a}}return [f(),obj.a]',
    'let obj={f:1};with(obj){function f(){return 2}}return [f(),obj.f]',
    'var f=1;let seen;try{throw 3}catch(f){{function f(){return 2}}seen=f}return [f(),seen]',
  ]) {
    const expected = Function(source)()
    assert.deepEqual(await run(source), expected, source)
    assert.deepEqual(await run(`return (function(){${source}})()`), expected, source)
  }
})

test('with var initializers retain root storage and select the actual object or catch', async t => {
  const run = session(t)
  const sources = [
    'var x=7;const obj={x:1};with(obj){var x=2}return [x,obj.x]',
    'var x=7;const obj={};with(obj){var x=2}return [x,obj.x===undefined]',
    'var x=7;const obj={x:1,[Symbol.unscopables]:{x:true}};with(obj){var x=2}return [x,obj.x]',
    'var x=7;let seen;const obj={x:1};try{throw 4}catch(x){with(obj){var x=2;seen=x}}return [seen,x,obj.x]',
    'var x=7;let seen;const obj={};try{throw 4}catch(x){with(obj){var x=2;seen=x}}return [seen,x,obj.x===undefined]',
    'var x=7;let seen;const obj={x:1};with(obj){try{throw 4}catch(x){var x=2;seen=x}}return [seen,x,obj.x]',
    'var x=7;let seen;const obj={x:1};with(obj){with({}){var x=2;seen=x}}return [seen,x,obj.x]',
    'var x=7;const obj={x:1};with(obj){if(false)var x=2;var x}return [x,obj.x]',
    'var x=7;const obj={x:1};with(obj){for(var x=2;x<3;x++)break}return [x,obj.x]',
  ]
  for (const source of sources) {
    const expected = Function(source)()
    assert.deepEqual(await run(source), expected, source)
    assert.deepEqual(await run(`return (function(){${source}})()`), expected, source)
  }
})

test('with patterns and loop heads preserve source targets and candidate default operations', async t => {
  const run = session(t)
  for (const declaration of ['var [x,y=x+1]=[2]', 'var {x,y=x+1}={x:2}',
    'for(var [x,y=x+1] of [[2],[3]]){}', 'for(var {0:x,missing:y=x} in {a:1,b:2}){}',
    'var [x,y=[typeof x,delete x,typeof x]]=[2]']) {
    const source = `var x=7,y=8;const obj={x:1};with(obj){${declaration}}return [x,y,obj.x===undefined,obj.x??null]`
    const expected = Function(source)()
    assert.deepEqual(await run(source), expected, source)
    assert.deepEqual(await run(`return (function(){${source}})()`), expected, source)
  }
  const caught = `var x=7,y=8;let seen;const obj={};try{throw 4}catch(x){
    with(obj){var [x,y=x+1]=[2];seen=[x,y]}}return [seen,x,y]`
  assert.deepEqual(await run(caught), Function(caught)())
  assert.deepEqual(await run(`return (function(){${caught}})()`), Function(caught)())
  const callable = `var fn=()=>0,y;const obj={fn:1};with(obj){
    var [fn,y=[fn(),fn?.(),fn\`tag\`,eval('fn()'),(0,fn)()]]=[function(){return this===obj}]
    }return [fn(),y]`
  assert.deepEqual(await run(callable), [0,[true,true,true,true,false]])
  assert.deepEqual(await run(`return (function(){${callable}})()`), [0,[true,true,true,true,false]])
})

test('with target selection follows RHS, getters and iterator steps exactly once per operation', async t => {
  const run = session(t)
  const setup = `var x=7,y=8;const effects=[];const obj=new Proxy({x:1},{
    has(target,key){if(key==='x')effects.push('has');return Reflect.has(target,key)},
    get(target,key,receiver){if(key===Symbol.unscopables)effects.push('unscopables');return Reflect.get(target,key,receiver)},
    set(target,key,value,receiver){if(key==='x')effects.push('set');return Reflect.set(target,key,value,receiver)}
    });const rhs={ [Symbol.iterator](){effects.push('iterator');let next=0;return {
      next(){effects.push('next');return {value:next++===0?2:undefined,done:false}},
      return(){effects.push('close');return {}}
    }}};`
  for (const declaration of [
    `var x=(effects.push('rhs'),2)`,
    `var [x,y=(effects.push('default'),x+=1,x)]=(effects.push('rhs'),rhs)`,
    `var {x}=(effects.push('rhs'),{get x(){effects.push('get');return 2}})`,
    `for(var [x,y=(effects.push('default'),x)] of [rhs])break`,
  ]) {
    const source = `${setup}with(obj){${declaration}}return [x,y,obj.x,effects]`
    const expected = Function(source)()
    assert.deepEqual(await run(source), expected, declaration)
    assert.deepEqual(await run(`return (function(){${source}})()`), expected, declaration)
  }
})

test('with candidate publication keeps effects and escaped references across success and failure', async t => {
  const run = session(t)
  for (const nested of [false,true]) {
    const success = `var x=7,y=8;const obj={x:1};let read;
      with(obj){var [x,y=(read=()=>x,x+1)]=[2]}
      const before=[read(),x,y,obj.x];delete obj.x;x=9;return [before,read()]`
    assert.deepEqual(await run(nested ? `return (function(){${success}})()` : success), [[2,7,3,2],9])
    const failed = `var x=7,y=8,z=9;const obj={y:1};let read;
      with(obj){try{var [x,y,z=(read=()=>x,(()=>{throw Error('stop')})())]=[2,3]}catch{}}
      const before=[x,y,z,obj.y,read()];obj.x=10;const shadow=read();delete obj.x;x=11;
      return [before,shadow,read()]`
    assert.deepEqual(await run(nested ? `return (function(){${failed}})()` : failed), [[7,8,9,3,2],10,2])
  }
  await run('var existing=7;const obj={existing:1,fresh:2};with(obj){var [existing,fresh]=[3,4]}', 'with-continuity')
  assert.deepEqual(await run('return [existing,typeof fresh,delete fresh,obj.existing,obj.fresh]', 'with-continuity'), [7,'undefined',false,3,4])
  assert.deepEqual(await run('var fresh=5;return [existing,fresh]', 'with-continuity'), [7,5])
})

test('outer lexical references follow intervening eval vars through every operation', async t => {
  const run = session(t)
  const source = `return (function(){let outer=1;
    function f(){const before=()=>outer;const strict=()=>{'use strict';return outer};
      eval('var outer=2');const read=[eval('outer'),outer,before(),strict(),typeof outer];
      outer+=3;const write=[outer,before()];const removed=delete outer;
      return [read,write,removed,outer,before(),strict()]}
    return [f(),outer]})()`
  assert.deepEqual(await run(source), Function(source)())
  const calls = `return (function(){let outer=function(){return 'outer'};
    function f(){const before=()=>outer();eval('var outer=function(){return [this===globalThis,arguments.length]}');
      return [outer(),outer?.(),outer\`tag\`,before(),(0,outer)()]}
    return [f(),outer()]})()`
  assert.deepEqual(await run(calls), Function(calls)())
})

test('eval analysis respects lexical owners, strict isolation and creation environments', async t => {
  const run = session(t)
  const sources = [
    `return (function(){let outer=1;function f(){'use strict';eval('var outer=2');return outer}return [f(),outer]})()`,
    `return (function(){let outer=1;function f(){eval('var outer=2');{let outer=3;return ()=>outer}}return [f()(),outer]})()`,
    `return (function(){let outer=1;function f(){const read=()=>outer;return [read,()=>eval('var outer=2')]}const [read,change]=f();change();return [read(),outer]})()`,
    `return (function(){let outer=1;function f(read=()=>outer){eval('var outer=2');return [read(),outer]}return [f(),outer]})()`,
    `return (function(){let outer=1;function f(a=eval('var outer=2'),b=outer){return [outer,b]}return [f(),outer]})()`,
    `return (function(){let outer=1;function f(read=()=>outer,a=eval('var outer=2')){return [read(),outer]}return [f(),outer]})()`,
    `return (function(){let outer=1;function f(){if(false)eval('var outer=2');return outer}return [f(),outer]})()`,
  ]
  for (const source of sources) assert.deepEqual(await run(source), Function(source)(), source)
})

test('shared dynamic scope facts distinguish self, owner and intervening environments', () => {
  const tree = parse(`let outer=1;eval('');
    const f=function self(a=eval('')){eval('');return ()=>[outer,self,a]};
    const read=()=>outer;function quiet(){return missing}`)
  const facts = createDynamicScopeAnalysis(tree)
  const observed = []
  traverse(tree, { Identifier(path) {
    if (!path.isReferencedIdentifier() || !['outer','self','a','missing'].includes(path.node.name)) return
    const binding = path.scope.getBinding(path.node.name)
    observed.push([path.node.name, facts.mayEvalShadow(path, binding?.scope.block),
      facts.mayEvalShadow(path, binding?.scope.block, path.node.name === 'self')])
  } })
  assert.deepEqual(observed, [['outer',true,true],['self',false,true],['a',false,false],
    ['outer',false,false],['missing',true,true]])
  const parameterTree = parse('function f(a=eval("")){return missing};function quiet(){return absent}')
  const parameterFacts = createDynamicScopeAnalysis(parameterTree)
  traverse(parameterTree, { Identifier(path) {
    if (path.node.name === 'missing') assert.equal(parameterFacts.mayEvalShadow(path), true)
    if (path.node.name === 'absent') assert.equal(parameterFacts.mayEvalShadow(path), false)
  } })
  const quietTree = parse('function quiet(){return missing};const obj={ [eval("")](){} }')
  const quietFacts = createDynamicScopeAnalysis(quietTree)
  traverse(quietTree, { Identifier(path) {
    if (path.node.name === 'missing') assert.equal(quietFacts.mayEvalShadow(path, quietTree.program), false)
  } })
  const declarationTree = parse('try{}catch(e){with({}){var e=2}}')
  traverse(declarationTree, { VariableDeclarator(path) {
    const target = varInitializerTarget(path.get('id'), declarationTree.program, 'e')
    assert.equal(target.catchNode.type, 'CatchClause')
    assert.deepEqual(target.withNodes.map(node => node.type), ['WithStatement'])
  } })
})

test('protected and reserved collisions report original TypeScript locations without changing state', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const id = `collision-position-${bindingUpdates}`
    assert.equal((await state.run(id, 'const kept=7')).error, undefined)
    for (const name of bindingUpdates === 'protected' ? ['kept', 'tools'] : ['tools']) {
      const program = `interface Shape {value:number}\nconst ${name}=2 as number;\nglobalThis.reached=true`
      const observed = await state.executeRun(id, program, {}, {})
      assert.equal(observed.result.isError, true)
      const diagnostic = observed.result.meta.dshPtcPlus.diagnostics[0]
      assert.equal(diagnostic.code, 'PTC-N001')
      assert.equal(diagnostic.phase, 'preflight')
      assert.equal(diagnostic.stateEffect, 'unchanged')
      // Reserved names must say so; protected-only collisions keep the generic wording.
      assert.equal(diagnostic.message, name === 'tools'
        ? 'top-level bindings already exist: tools. tools cannot be redeclared or overwritten because reserved program bindings are not shadowable. This cell was not executed; the REPL state is unchanged.'
        : `top-level bindings already exist: ${name}. This cell was not executed; the REPL state is unchanged.`)
      assert.deepEqual(diagnostic.source, { cell: 'current',
        start: { line: 2, column: 7 }, end: { line: 2, column: 7 + name.length } })
      assert.deepEqual(diagnostic.collisions, [{ name, kind: 'variable',
        reason: name === 'tools' ? 'reserved-program-binding-not-shadowable' : 'protected-root-redeclaration',
        start: { line: 2, column: 7 }, end: { line: 2, column: 7 + name.length } }])
      assert.deepEqual((await state.run(id, 'return [kept,globalThis.reached===undefined]')).value, [7,true])
    }
  }
})

test('names only the reserved binding in a mixed collision set', async t => {
  const state = fixture({ bindingUpdates: 'protected' })
  t.after(() => state.dispose())
  await state.run('collision-mixed-reserved', 'const kept=7')
  const observed = await state.executeRun(
    'collision-mixed-reserved', 'const kept=2\nclass tools {}', {}, {},
  )
  assert.equal(observed.result.isError, true)
  const { message } = observed.result.meta.dshPtcPlus.diagnostics[0]
  assert.match(message, /tools cannot be redeclared or overwritten because reserved program bindings are not shadowable\./u)
  assert.doesNotMatch(message, /kept cannot be redeclared/u)
  assert.deepEqual(observed.result.meta.dshPtcPlus.diagnostics[0].collisions
    .map(item => [item.name, item.reason]),
  [['kept', 'protected-root-redeclaration'], ['tools', 'reserved-program-binding-not-shadowable']])
})
test('reserved program bindings refuse an executed write in every policy', async t => {
  const cases = [
    ['assignment', 'try { tools = 5 } catch (error) { return error.message } return "no error"', 'tools cannot be overwritten because reserved program bindings are not shadowable'],
    ['strict assignment', '"use strict";try { tools = 5 } catch (error) { return error.message } return "no error"', 'tools cannot be overwritten because reserved program bindings are not shadowable'],
    ['destructuring target', 'try { [tools] = [5] } catch (error) { return error.message } return "no error"', 'tools cannot be overwritten because reserved program bindings are not shadowable'],
    ['for of target', 'try { for (tools of [1]) {} } catch (error) { return error.message } return "no error"', 'tools cannot be overwritten because reserved program bindings are not shadowable'],
    ['executed logical assignment', 'try { tools &&= 1 } catch (error) { return error.message } return "no error"', 'tools cannot be overwritten because reserved program bindings are not shadowable'],
    ['direct eval', 'try { eval("tools = 5") } catch (error) { return error.message } return "no error"', 'tools cannot be overwritten because reserved program bindings are not shadowable'],
    ['injected error class', 'try { ToolCallError = 1 } catch (error) { return error.message } return "no error"', 'ToolCallError cannot be overwritten because reserved program bindings are not shadowable'],
    ['right-hand side effects', 'let writeCount = 0; try { tools = (writeCount = 1, 9) } catch (error) { return [writeCount, error.message] } return "no error"',
      [1, 'tools cannot be overwritten because reserved program bindings are not shadowable']],
    ['skipped logical assignment', 'let skipCount = 0; tools ||= (skipCount = 1); return [skipCount, typeof tools]', [0, 'object']],
  ]
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const id = 'reserved-write-' + bindingUpdates
    for (const [label, program, expected] of cases) {
      const result = await state.run(id + '-' + label, program)
      assert.equal(result.error, undefined, bindingUpdates + '/' + label + ': ' + result.error?.message)
      if (Array.isArray(expected)) assert.deepEqual(result.value, expected, bindingUpdates + '/' + label)
      else assert.equal(result.value, expected, bindingUpdates + '/' + label + ': ' + result.value)
    }
    await state.run(id, 'const writeReserved = () => { tools = 5 }; return 1')
    const later = await state.run(id, 'writeReserved()')
    assert.match(later.error.message, /tools cannot be overwritten because reserved program bindings are not shadowable/u)
    assert.equal((await state.run(id, 'return typeof tools')).value, 'object')
  }
})
