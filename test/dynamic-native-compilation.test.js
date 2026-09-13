import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './plugin-fixture.js'
import { loadManagedSource } from './managed-module-fixture.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { UserBindingConsole } from '../internal/user-binding-console.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

test('owned eval entries preserve global declaration failures and established bindings', async t => {
  const body = `globalThis.side=0;Object.defineProperty(globalThis,'blocked',{value:1});
    let failure;try{(0,eval)('side=1;function created(){return 7};function blocked(){};var skipped')}
    catch(error){failure=error.name}`
  const observation = `[failure,side,typeof created,created(),Object.hasOwn(globalThis,'skipped')]`
  const expected = JSON.parse(JSON.stringify(runInNewContext(`(function(){${body};return ${observation}})()`)))
  for (const options of [{}, { bindingUpdates: 'protected' }, { legacyBindingSettings: true }]) {
    const runtime = new SessionRuntime(options)
    try {
      const first = await runtime.run('eval-declarations', { bindings: [], program: `${body};return ${observation}` })
      assert.equal(first.error, undefined, first.error?.message)
      assert.deepEqual(first.value, expected)
      const next = await runtime.run('eval-declarations', { bindings: [], program: 'return [created(),side,typeof skipped]' })
      assert.equal(next.error, undefined, next.error?.message)
      assert.deepEqual(next.value, [7,0,'undefined'])
      const source = `${body};export const result=${observation};export function read(){return created()}`
      const module = await runtime.run('eval-module-declarations', { bindings: [],
        program: `const ns=await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(source)}`)});return [ns.result,ns.read()]` })
      assert.equal(module.error, undefined, module.error?.message)
      assert.deepEqual(module.value, [expected,7])
    } finally { await runtime.dispose() }
  }
})

test('actual worker preserves legacy intrinsic identities and source across both mode changes', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true })
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('legacy-identity', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message ?? program)
    return result.value
  }
  assert.deepEqual(await run('const saved=Function;const source=Function.prototype.toString;function identities(){return [saved===Function,source===Function.prototype.toString]};return identities()'), [true,true])
  await run(`const original=x=>x+1;const before=source.call(original);const controls={};
    async function inspect(signal){await signal;return [saved===Function,source===Function.prototype.toString,source.call(original)===before]}
    const signal=new Promise(resolve=>controls.resolve=resolve);const pending=inspect(signal);void 0`)
  runtime.reconfigure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run('return identities()'), [true,true])
  assert.deepEqual(await run(`const fn=a=>a+2;const same=fn;const intrinsic=Function.prototype.toString;
    const vm=await import('node:vm');const opaque=vm.runInNewContext('(observe,fn)=>Reflect.apply(observe,fn,[])');
    controls.observe=intrinsic;controls.fn=fn;controls.resolve();
    return [identities(),await pending,fn===same,source.call(original)===before,
      opaque(intrinsic,fn),[0].map(intrinsic.bind(fn))[0],
      Function('return ('+opaque(intrinsic,fn)+')')()(3)]`),
  [[true,true],[true,true,true],true,true,'a=>a+2','a=>a+2',5])
  runtime.reconfigure({ legacyBindingSettings: true })
  assert.deepEqual(await run('return identities()'), [true,true])
  assert.deepEqual(await run(`const laterSource=Function.prototype.toString;const laterConstructor=Function;
    function later(){return [laterSource===source,laterSource===Function.prototype.toString,laterConstructor===saved]}
    return [later(),await inspect(Promise.resolve()),source.call(original)===before,controls.observe.call(controls.fn)]`),
  [[true,true,true],[true,true,true],true,'a=>a+2'])
})

test('actual worker retains direct eval through legacy to stateful to legacy continuation', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true })
  t.after(() => runtime.dispose())
  const run = async program => {
    const result = await runtime.run('legacy-eval', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message ?? program)
    return result.value
  }
  assert.equal(await run('function previous(){const local=41;return eval("local")};return previous()'), 41)
  await run(`const oldIdentity=previous;
    const oldConstructor=Function;
    function nativeGeneration(){return [Function===oldConstructor,(function(){}).constructor===oldConstructor,Function('return typeof value')()]}
    async function escaped(signal){const local=43;await signal;return eval('local')}
    function oldFactory(){const local=44;return ()=>eval('local')}
    const closure=oldFactory();const controls={};
    const signal=new Promise(resolve=>controls.resolve=resolve);const pending=escaped(signal);void 0`)
  runtime.reconfigure({ bindingUpdates: 'stateful' })
  assert.equal(await run('return previous()'), 41)
  assert.deepEqual(await run(`const value=45;
    const vm=await import('node:vm');
    const opaque=vm.runInNewContext('callback=>Promise.resolve().then(callback)');
    controls.resolve();
    return [previous===oldIdentity,await pending,await opaque(closure),nativeGeneration(),
      ['typeof value','value'].map(eval),await Promise.resolve('value').then(eval),
      Function('return value')(),typeof globalThis.value]`), [true,43,44,[true,true,'undefined'],['number',45],45,45,'undefined'])
  runtime.reconfigure({ legacyBindingSettings: true })
  assert.equal(await run('function later(){const local=42;return eval("local")};return later()'), 42)
  assert.deepEqual(await run('return [previous(),closure(),await escaped(Promise.resolve())]'), [41,44,43])
  assert.deepEqual(await run('return nativeGeneration()'), [true,true,'undefined'])
})

test('module generations preserve escaped and later legacy eval alongside new native callbacks', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true })
  t.after(() => runtime.dispose())
  const directory = await mkdtemp(join(tmpdir(), 'ptc-eval-generations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const oldFile = join(directory, 'old.mjs')
  const newFile = join(directory, 'current.mjs')
  const laterFile = join(directory, 'later.mjs')
  await writeFile(oldFile, `const saved=Function;const source=Function.prototype.toString;
    export function identities(){return [saved===Function,source===Function.prototype.toString]}
    export function previous(){const local=61;return eval('local')}
    export async function escaped(signal){const local=62;await signal;return eval('local')}`)
  await writeFile(newFile, `export const captured=eval;export const constructor=Function;
    export function current(){const local=63;return [eval('local'),['typeof local'].map(eval)[0]]}`)
  await writeFile(laterFile, `const source=Function.prototype.toString;
    export function identities(){return source===Function.prototype.toString}
    export function later(){const local=64;return eval('local')}`)
  const run = async program => {
    const result = await runtime.run('module-eval-generations', { program, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message ?? program)
    return result.value
  }
  assert.equal(await run(`const oldModule=await import(${JSON.stringify(pathToFileURL(oldFile).href)});
    const saved=oldModule.previous;const controls={};
    const signal=new Promise(resolve=>controls.resolve=resolve);const pending=oldModule.escaped(signal);
    return saved()`), 61)
  runtime.reconfigure({ bindingUpdates: 'stateful' })
  assert.deepEqual(await run(`const value=41;const current=await import(${JSON.stringify(pathToFileURL(newFile).href)});
    const vm=await import('node:vm');const opaque=vm.runInNewContext('(callback,value)=>[value].map(callback)[0]');
    controls.current=current;controls.resolve();return [saved===oldModule.previous,saved(),await pending,current.current(),oldModule.identities(),
      opaque(current.captured,'typeof value'),opaque(eval,'value'),
      current.constructor('return eval')()===current.captured]`), [true,61,62,[63,'undefined'],[true,true],'undefined',41,true])
  runtime.reconfigure({ legacyBindingSettings: true })
  assert.deepEqual(await run(`const laterModule=await import(${JSON.stringify(pathToFileURL(laterFile).href)});
    return [oldModule.previous(),laterModule.later(),await oldModule.escaped(Promise.resolve()),controls.current.current(),oldModule.identities(),laterModule.identities()]`),
  [61,64,62,[63,'undefined'],[true,true],true])
})

test('native indirect eval and constructor families use the continuous realm root', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const run = async source => {
    const result = await state.run('native-compilation', source)
    assert.equal(result.error, undefined, source)
    return result.value
  }
  await run('const value=41')
  assert.deepEqual(await run('return [(0,eval)("typeof value"),Function("return typeof value")(),typeof globalThis.value]'), ['number','number','undefined'])
  assert.deepEqual(await run(`const indirect=eval;
    const constructor=Function;
    const bound=constructor.bind(null,'return ++value');
    const reflected=Reflect.apply(constructor,null,['return ++value']);
    return [indirect('value'),bound()(),reflected(),constructor.call(null,'return value')(),constructor.apply(null,['return value'])()];`), [41,42,43,43,43])
  assert.deepEqual(await run(`const AsyncFunction=(async function(){}).constructor;
    const GeneratorFunction=(function*(){}).constructor;
    const AsyncGeneratorFunction=(async function*(){}).constructor;
    return [await AsyncFunction('return ++value')(),GeneratorFunction('yield ++value')().next().value,
      (await AsyncGeneratorFunction('yield ++value')().next()).value];`), [44,45,46])
  assert.deepEqual(await run(`function local(){const value=99;return [(0,eval)('value'),Function('return value')(),eval('value')]};
    return [local(),Function('value','return value')(7),value,typeof globalThis.value];`), [[46,46,99],7,46,'undefined'])
  assert.equal(await run('return Reflect.construct(Function,["return ++value"])()'), 47)
  assert.equal(await run('return Function.prototype.call.call(Function,null,"return ++value")()'), 48)
  assert.equal(await run('return eval.bind(null)("++value")'), 49)
  assert.equal(await run('return eval?.("++value")'), 50)
  assert.equal(await run('return globalThis.eval("++value")'), 51)
  assert.equal(await run('return value'), 51)
  assert.deepEqual(await run('return [Function("return typeof anonymous")(),Function("return this===globalThis")()]'), ['undefined',true])
  assert.deepEqual(await run('(0,eval)("var indirectVar=7; function indirectFn(){return indirectVar}");return [indirectVar,globalThis.indirectVar,indirectFn(),globalThis.indirectFn===indirectFn]'), [7,7,7,true])
  assert.deepEqual(await run('return [(0,eval)("delete indirectVar"),typeof indirectVar,typeof globalThis.indirectVar]'), [true,'undefined','undefined'])
})

test('ordinary native invocation preserves optional lookup and real argument effects', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('native-call-order', `const events=[];
    const receiver={get run(){events.push('get');return function(value){events.push(this===receiver);return value}}};
    const a=receiver.run(events.push('argument'));
    const b=null?.[events.push('key')](events.push('skipped'));
    const c=({run:null}).run?.(events.push('skipped'));
    const d=({get run(){events.push('optional');return x=>x}})?.run(3);
    return [a,typeof b,typeof c,d,events];`)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.value, [2,'undefined','undefined',3,['get','argument',true,'optional']])
})

test('callable source observations recompile original standard functions without compiler closure dependencies', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const run = async source => {
    const result = await state.run('native-callable-source', source)
    assert.equal(result.error, undefined, source)
    return result.value
  }
  await run('const f=a=>a+1; const original=f;')
  assert.deepEqual(await run('const copy=Function("return ("+f.toString()+")")();return [copy(2),original===f,f.toString()]'), [3,true,'a=>a+1'])
  assert.deepEqual(await run(`function ordinary(a){return a+2}
    const method={read(a){return a+3}};
    const viaPrototype=Function.prototype.toString.call(ordinary);
    const viaReflect=Reflect.apply(Function.prototype.toString,method.read,[]);
    return [Function('return ('+viaPrototype+')')()(2),Function('return ({'+viaReflect+'})')().read(2)];`), [4,5])
  assert.deepEqual(await run(`const asyncFn=async a=>a+4;
    function* generator(a){yield a+5}
    async function* asyncGenerator(a){yield a+6}
    const construct=fn=>Function('return ('+fn.toString()+')')();
    return [await construct(asyncFn)(2),construct(generator)(2).next().value,(await construct(asyncGenerator)(2).next()).value];`), [6,7,8])
  assert.equal(await run(`function outer(){const secret=3;return a=>a+secret}
    const closed=outer();
    try{Function('return ('+closed.toString()+')')()(2)}catch(error){return error instanceof ReferenceError}`), true)
  assert.deepEqual(await run(`const nested=Function('return a=>a+2')();
    const source=Function.prototype.toString.bind(nested)();
    return [Function('return ('+source+')')()(2),source];`), [4,'a=>a+2'])
  assert.deepEqual(await run(`class Source {static read(a){return a+7}}
    const source=Source.read.toString();return [Function('return ({'+source+'})')().read(2),source];`), [9,'read(a){return a+7}'])
})

test('ESM and CommonJS callable source facts remain available outside module lexical helpers', async t => {
  const source = 'export const f=a=>a+1;export function copy(){return Function("return ("+f.toString()+")")()(2)}'
  const module = await loadManagedSource(t, source)
  assert.equal(module.copy(), 3)
  const directory = await mkdtemp(join(tmpdir(), 'ptc-native-source-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'source.cjs')
  const commonjs = compileStatefulModule('const f=a=>a+1;module.exports=()=>Function("return ("+f.toString()+")")()(2)', { target: 'commonjs' })
  await writeFile(filename, commonjs.code)
  assert.equal(createRequire(import.meta.url)(filename)(), 3)
})

test('workbench native dynamic compilation shares only its own root state', async t => {
  const owner = new UserBindingConsole({ cwd: process.cwd(), maxWallMs: 10_000,
    maxOutputBytes: 64 * 1024, maxOldGenerationSizeMb: 128 })
  t.after(() => owner.dispose())
  const source = 'export const answer=2'
  const first = await owner.run({ source, code: 'const value=1;const f=a=>a+1' })
  assert.equal(first.error, undefined)
  const realm = await owner.run({ source, environment: first.environment,
    code: `const pending=import('node:buffer');const promise=pending instanceof Promise;await pending;
      let symbol=false,options=false;
      try{await import(Symbol())}catch(error){symbol=error instanceof TypeError}
      try{await import('node:buffer',null)}catch(error){options=error instanceof TypeError}
      return [promise,symbol,options]` })
  assert.equal(realm.error, undefined)
  assert.equal(realm.output, '[ true, true, true ]')
  const next = await owner.run({ source, environment: first.environment,
    code: '[Function("return ++value")(),["value"].map(eval)[0],Function("return ("+[0].map(Function.prototype.toString.bind(f))[0]+")")()(2)]' })
  assert.equal(next.error, undefined)
  assert.equal(next.output, '[ 2, 2, 3 ]')
})

test('CommonJS wrapper arguments keep strict reads and member writes alongside sloppy reassignment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-wrapper-arguments-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const require = createRequire(import.meta.url)
  for (const strict of [true, false]) {
    const source = `${strict ? '"use strict";' : ''}
      const original=exports;
      const before=eval('[arguments.length,arguments[0]===exports]');
      eval('arguments[0]=9');
      ${strict ? '' : "eval('arguments=[7]');"}
      module.exports=[before,exports===original,eval('arguments[0]')];`
    const filename = join(directory, `${strict ? 'strict' : 'sloppy'}.cjs`)
    await writeFile(filename, compileStatefulModule(source, { target: 'commonjs' }).code)
    assert.deepEqual(require(filename), [[5,true],strict,strict ? 9 : 7])
  }
})

test('native and opaque callbacks preserve realm compilation and canonical source values', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const run = async source => {
    const result = await state.run('native-callbacks', source)
    assert.equal(result.error, undefined, source)
    return result.value
  }
  // Capture before any call expression appears in user source.
  await run('const value=41;const indirect=eval;const Constructor=Function')
  assert.deepEqual(await run('return ["typeof value","value"].map(indirect)'), ['number',41])
  await run(`const vm=await import('node:vm');
    const opaque=vm.runInNewContext('(callback,args)=>Reflect.apply(callback,undefined,args)');
    const opaqueNew=vm.runInNewContext('(callback,args,NewTarget=callback)=>Reflect.construct(callback,args,NewTarget)');`)
  assert.deepEqual(await run(`const AsyncFunction=(async function(){}).constructor;
    const GeneratorFunction=(function*(){}).constructor;
    const AsyncGeneratorFunction=(async function*(){}).constructor;
    return [opaque(Constructor,['return ++value'])(),await opaque(AsyncFunction,['return ++value'])(),
      opaque(GeneratorFunction,['yield ++value'])().next().value,
      (await opaque(AsyncGeneratorFunction,['yield ++value'])().next()).value,
      opaqueNew(Constructor,['return ++value'])(),opaque(Constructor.bind(null,'return ++value'),[])()];`), [42,43,44,45,46,47])
  assert.deepEqual(await run(`function local(){const value=99;return [eval('value'),['value'].map(eval)[0]]}
    const ordinary=a=>a+1;const same=ordinary;
    const source=opaque(Function.prototype.toString.bind(ordinary),[]);
    return [local(),ordinary===same,source,Function('return ('+source+')')()(2),typeof globalThis.value];`), [[99,47],true,'a=>a+1',3,'undefined'])
  assert.deepEqual(await run(`const moduleObserver=vm.runInThisContext('(fn,observe)=>observe.call(fn)');
    const nativeObserver=vm.runInThisContext('fn=>Function.prototype.toString.call(fn)');
    const foreignObserver=vm.runInNewContext('fn=>Function.prototype.toString.call(fn)');
    return [moduleObserver(ordinary,Function.prototype.toString),nativeObserver(ordinary)===foreignObserver(ordinary)]`), ['a=>a+1',true])
  assert.deepEqual(await run(`return [Function===(function(){}).constructor,Function===Constructor,
    Object.getPrototypeOf(AsyncFunction)===Function,Object.getPrototypeOf(GeneratorFunction)===Function,
    Object.getPrototypeOf(AsyncGeneratorFunction)===Function,eval===indirect,
    eval.name,eval.length,Function.name,Function.length,Function.prototype.toString.name,Function.prototype.toString.length];`), [true,true,true,true,true,true,'eval',1,'Function',1,'toString',0])
  assert.deepEqual(await run(`const foreign=vm.runInNewContext('({eval,Function,globalThis})');foreign.globalThis.value=9;
    return [opaque(foreign.eval,['value']),opaque(foreign.Function,['return value'])(),value];`), [9,9,47])
  assert.deepEqual(await run(`const intrinsicSource=Function.prototype.toString;
    globalThis.eval=(...args)=>args;globalThis.Function=(...args)=>args;
    Constructor.prototype.toString=()=> 'override';
    return [opaque(globalThis.eval,['ordinary',2]),opaque(globalThis.Function,['ordinary',3]),
      opaque(Constructor.prototype.toString.bind(ordinary),[]),opaque(intrinsicSource.bind(ordinary),[])];`), [['ordinary',2],['ordinary',3],'override','a=>a+1'])
  assert.deepEqual(await run('return [globalThis.eval("kept"),globalThis.Function("kept")]'), [['kept'],['kept']])
})

test('module realm observes incoming compiled functions and opaque consumers receive canonical namespace values', async t => {
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const directory = await mkdtemp(join(tmpdir(), 'ptc-callback-module-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'observe.mjs')
  await writeFile(filename, `export const captured=eval;
    export const constructor=Function;
    export const f=a=>a+1;
    export function observe(fn){return [0].map(Function.prototype.toString.bind(fn))[0]}`)
  const result = await state.run('callback-module-source', `const vm=await import('node:vm');
    const module=await import(${JSON.stringify(pathToFileURL(filename).href)});
    const f=a=>a+2;
    const opaque=vm.runInNewContext('(namespace)=>[namespace.f,namespace.observe(namespace.f)]');
    const received=opaque(module);
    const source=module.observe(f);
    return [source,Function('return ('+source+')')()(2),received[0]===module.f,received[1],
      module.captured===module.constructor('return eval')(),module.constructor===module.f.constructor];`)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.value, ['a=>a+2',4,true,'a=>a+1',true,true])
})

test('new source exposes intrinsic values from properties, reflection and suspended opaque results', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  const result = await runtime.run('intrinsic-source-values', { bindings: [], program: `const value=41;
    const vm=await import('node:vm');
    const use=vm.runInNewContext('(callback)=>["value"].map(callback)[0]');
    const read=vm.runInNewContext('(root)=>root.eval');
    const readAsync=vm.runInNewContext('(root)=>Promise.resolve(root.eval)');
    const resume=vm.runInNewContext('(iterator,root)=>{iterator.next();return iterator.next(root.eval).value}');
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'eval');
    const reflected=descriptor.get?descriptor.get():descriptor.value;
    function* suspended(){return ['value'].map(yield 0)[0]}
    const object={nested:{eval}};const absent=null;
    const key='eval';const captured=object?.nested[key];
    return [[globalThis.eval,globalThis[key],Reflect.get(globalThis,key),reflected,captured,read(globalThis)].map(use),
      use(await readAsync(globalThis)),resume(suspended(),globalThis),
      [eval===globalThis.eval,eval===reflected,Function===(function(){}).constructor,
        Object.getPrototypeOf((async function(){}).constructor)===Function],
      typeof absent?.nested.eval,typeof globalThis.value]` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [[41,41,41,41,41,41],41,41,[true,true,true,true],'undefined','undefined'])
})
