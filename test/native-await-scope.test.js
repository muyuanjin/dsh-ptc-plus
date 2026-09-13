import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { create as createDomain } from 'node:domain'
import repl from 'node:repl'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { runInContext } from 'node:vm'
import { compileDynamicEnvironmentSource } from '../internal/dynamic-environment-compiler.js'
import { createNativeRootDynamic } from '../internal/native-root-dynamic.js'

function nativeRepl(t) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const pending = new AsyncLocalStorage()
  const server = repl.start({ input, output, prompt: '', terminal: false, useGlobal: false,
    writer: error => { pending.getStore()?.({ error }); return '' } })
  const domain = server.eval.domain ?? createDomain()
  domain.removeAllListeners('error')
  domain.on('error', error => pending.getStore()?.({ error }))
  t.after(() => { server.close(); input.destroy(); output.destroy(); domain.removeAllListeners() })
  const evaluate = source => new Promise(resolve => pending.run(resolve, () => domain.run(() => {
    server.eval(`${source}\n;`, server.context, 'native-await-control', (error, value) => {
      resolve(error == null ? { value } : { error })
    })
  })))
  return Object.assign(evaluate, { context: server.context })
}

test('direct compiler await output preserves the native REPL declaration and activation contract', async t => {
  const source = `await 0;eval('var value=9');let [value,...rest]=[3,4];
    for(var key of ['a','b']){};class Shape{};function read(){return value};
    JSON.stringify([value,rest,key,Shape.name,read()])`
  const expected = await nativeRepl(t)(source)
  assert.equal(expected.error, undefined)
  const execute = nativeRepl(t), context = execute.context
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const owner = createNativeRootDynamic({ intrinsics,
    read: name => runInContext(name, context),
    typeOf: name => runInContext(`typeof ${name}`, context),
    remove: name => runInContext(`delete ${name}`, context),
    write(name, value, strict) { runInContext(`${strict ? '"use strict";' : ''}value=>${name}=value`, context)(value) },
  })
  const compiled = compileDynamicEnvironmentSource(source, { cell: {
    environmentName: 'compilerEnvironment', nativeRoot: true, nativeAwait: true,
  } })
  context.compilerEnvironment = owner.environment([], true)
  const actual = await execute(compiled.code)
  assert.equal(actual.error, undefined, actual.error?.message)
  assert.equal(actual.value, expected.value)
  assert.equal((await execute('JSON.stringify([value,key,rest,Shape.name])')).value,
    '[null,"b",[4],"Shape"]')
})

const cases = [
  ['function hoisting', [['await 0;eval("");var result=typeof f;function f(){return 7}', 'result'], ['', '[f(),typeof f]']]],
  ['forward lexical read', [['await 0;eval("");var result=[typeof forward,forward];let forward=3', 'result'], ['', '[forward,typeof forward]']]],
  ['eval var activation lifetime', [['await 0;eval("var created=9");const readCreated=()=>created', '[created,typeof created]'], ['', '[readCreated(),typeof created,(()=>{try{return created}catch(error){return error.name}})()]']]],
  ['lexical before eval', [['let lex=3;await 0;eval("var lex=4")', 'lex'], ['', '[lex,typeof lex]']]],
  ['lexical after eval', [['await 0;eval("var x=4");let x=3', 'x'], ['', '[x,typeof x]']]],
  ['native root remains separate from an eval initializer', [['await 0;x=2;eval("var x=4");let x=3', '[x,Function("return x")()]'], ['', 'x']]],
  ['simple initializer follows an eval binding introduced by its RHS', [['await 0;let x=eval("var x=4;3")', '[x,Function("return x")()]'], ['', 'x']]],
  ['pattern initializer selects its targets after evaluating the RHS', [['await 0;let [x]=eval("var x=4;[3]")', '[x,Function("return x")()]'], ['', '[x,typeof x]']]],
  ['failed pattern retains the first assignment', [['await 0;eval("var q=1");let [a,b=(()=>{throw Error("pattern")})()]=[3]', '0'], ['', '[a,typeof b]']]],
  ['pattern defaults retain native property ownership', [['await 0;eval("");let [a=1,b=a]=[]', '[a,b,Object.hasOwn(this,"a"),Object.hasOwn(this,"b")]'], ['', '[a,b]']]],
  ['pattern assignment to activation', [['await 0;eval("var x=4");let [x]=[3]', 'x'], ['', '[x,typeof x]']]],
  ['class assignment to activation', [['await 0;eval("var C=4");class C{}', '[typeof C,C.name]'], ['', '[C,typeof C]']]],
  ['block eval conflict', [['await 0;let result;{let x=7;try{eval("var x=8");result=x}catch(e){result=e.name}}', 'result']]],
  ['block capture precedes eval activation', [['await 0;eval("var x=4");let result;{let x=7;result=eval("x")}', 'result']]],
  ['skipped root var remains declared', [['await 0;eval("");if(false){var skipped=1}', 'typeof skipped'], ['', '[skipped,typeof skipped]']]],
  ['ordinary root var can be shadowed by eval', [['await 0;var x=1;eval("var x=4");var x=3', 'x'], ['', '[x,this.x]']]],
  ['function-local hoisted identity receives eval writes', [['await 0;var before=f();eval("var f=4");function f(){return 7}', '[before,f,this.f]'], ['', '[f,this.f]']]],
  ['var loop assignment follows activation', [['await 0;eval("var x=10");for(var x of [1,2]){}', 'x'], ['', '[x,typeof x]']]],
  ['for-await owns one root activation', [['eval("var x=10");for await(var x of [1,2]){}', 'x'], ['', '[x,typeof x]']]],
  ['loop lexical remains ahead of root activation', [['await 0;eval("var x=10");const result=[];for(let x of [1,2])result.push(eval("x"))', '[result,x]']]],
  ['computed object method key await is root evaluation', [['const object={ [await Promise.resolve("read")](){return eval("created")} };eval("var created=9")', '[object.read(),created]'], ['', 'typeof created']]],
  ['computed class method key await with an active root await', [['await 0;class Shape{[await Promise.resolve("read")](){return eval("created")}};eval("var created=9")', '[new Shape().read(),created]'], ['', 'typeof created']]],
  ['await in an ordinary function does not create a root activation', [['async function deferred(){await 0};eval("var created=9")', 'created'], ['', 'created']]],
  ['globalThis is an ordinary root lexical name', [['await 0;eval("var value=4");let globalThis={value:7};let value=3', '[globalThis.value,value]'], ['', '[globalThis.value,value]']]],
  ['existing global initializer-looking property is untouched', [['this.__ptc_lexical_initializer__=17;await 0;eval("var x=4");let x=3', '[this.__ptc_lexical_initializer__,x]'], ['', '[this.__ptc_lexical_initializer__,x]']]],
  ['global accessor effects are preserved for var declarations', [['Object.defineProperty(this,"x",{configurable:true,get(){effects.push("get");return 9},set(v){effects.push(v)}});var effects=[];await 0;eval("");var x=3', 'effects']]],
  ['lexical masks an existing global property', [['this.x=10;await 0;eval("var x=4");let x=3', '[x,this.x]'], ['', '[x,this.x]']]],
  ['strict eval vars remain private', [['"use strict";await 0;eval("var hidden=9");let x=3', '[typeof hidden,x]'], ['', '[typeof hidden,x]']]],
  ['escaped closures retain their await activation', [['await 0;eval("var x=4");const read=()=>eval("x");let x=3', 'read()'], ['', '[read(),x]']]],
  ['nested function owns its eval variables', [['await 0;eval("var x=4");function local(){eval("var x=7");return x}', '[local(),x]']]],
  ['mixed declarators publish sequentially', [['await 0;eval("");let {}={},a=3,[]=[],b=4', '[a,b]'], ['', '[a,b]']]],
  ['object rest preserves the native root binding', [['await 0;eval("var rest=1");let {x,...rest}={x:2,y:3}', '[x,rest]'], ['', '[x,rest,Object.hasOwn(this,"rest")]']]],
  ['array rest preserves native global ownership', [['await 0;eval("");let [x,...rest]=[1,2,3]', '[x,rest,Object.hasOwn(this,"rest")]'], ['', '[x,rest]']]],
  ['computed pattern keys preserve effects and defaults', [['await 0;eval("var x=7");const effects=[];let {[effects.push("key")]:x=effects.push("default")}={}', '[x,effects]'], ['', '[x,effects]']]],
  ['function values retain inferred declaration names', [['await 0;eval("");const f=()=>1;const [g=()=>2]=[];class Shape{}', '[f.name,g.name,Shape.name]']]],
  ['for-in root patterns use activation references', [['await 0;eval("var x=7");for(var [x] in {ab:1,cd:2}){}', 'x'], ['', '[x,typeof x]']]],
  ['ordinary for initializer keeps existing global value until its source position', [['this.x=7;await 0;eval("");const before=x;for(var x=0;x<2;x++){}', '[before,x]'], ['', 'x']]],
  ['an uninitialized root var resets only at its source position', [['this.x=7;await 0;eval("");const before=x;var x', '[before,x]'], ['', '[x,typeof x]']]],
  ['strict unresolved default targets retain native failure', [['"use strict";await 0;eval("");let [x=1]=[]', 'x'], ['', 'typeof x']]],
  ['arrow inheritance retains the outer await activation', [['await 0;eval("var x=4");const read=()=>()=>eval("x")', 'read()()'], ['', 'read()()']]],
]

for (const [name, cells] of cases) test(`native await: ${name}`, async t => {
  const native = nativeRepl(t)
  const runtime = new SessionRuntime({ legacyBindingSettings: true, durableReplay: false, maxWallMs: 10_000 })
  t.after(() => runtime.dispose())
  for (const [setup, expression] of cells) {
    const stringify = `JSON.stringify((${expression}),(_,value)=>value===undefined?{undefined:true}:value)`
    const expected = await native(`${setup};\n${stringify}`)
    const actual = await runtime.run(name, { program: `${setup};\nreturn ${stringify}`, bindings: [] })
    if (expected.error !== undefined) {
      assert.ok(actual.error, `native ${expected.error.name}: ${expected.error.message}; actual ${actual.value}`)
      assert.ok(actual.error.message.includes(expected.error.name), actual.error.message)
    } else {
      assert.equal(actual.error, undefined, actual.error?.message)
      assert.equal(actual.value, expected.value, `${setup}; ${expression}`)
    }
  }
})

test('native await adapts initialized for-in without inheriting the REPL parser limitation', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true, durableReplay: false })
  t.after(() => runtime.dispose())
  const AsyncFunction = (async function(){}).constructor
  const sources = [
    'await 0;eval("");var effects=[];for(var key=(effects.push("init"),"before") in (effects.push(key),{})){};return [key,effects]',
    'await 0;eval("var key=1");var effects=[];try{for(var key=(effects.push("init"),7) in (()=>{effects.push(key);throw 2})()){} }catch(error){effects.push(error)};return [key,effects]',
    'await 0;eval("");var count=0;outer:for(var key=(count++,"before") in {a:1,b:2}){count++;continue outer};return [key,count]',
  ]
  for (const [index, program] of sources.entries()) {
    const result = await runtime.run(`native-await-initialized-${index}`, { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, await AsyncFunction(program)())
  }
})
