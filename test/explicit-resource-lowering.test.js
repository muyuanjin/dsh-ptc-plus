import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { prepareProgram } from '../internal/cell-analysis.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'
import { CELL_PARSER_PLUGINS, lowerNativeLanguageSource, lowerStatefulResources, normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { markCallableSources } from '../internal/callable-source-facts.js'
import { fixture } from './plugin-fixture.js'
import { supportsNativeUsing, USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM } from '../internal/typescript-transform.js'
import { identitySourceMap } from '../internal/source-position-map.js'
import { loadManagedSource } from './managed-module-fixture.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function observeRealmPromise(promise, then) {
  // This is the test driver's private completion, not a disposer result. Keep
  // cross-realm observation from consulting the source's mutated species.
  Object.defineProperty(promise, 'constructor', {value:undefined})
  return new Promise((resolve, reject) => Reflect.apply(then, promise, [resolve, reject]))
}

function runResourceRealm(source) {
  const realm = createContext()
  const then = runInContext('Promise.prototype.then', realm)
  return observeRealmPromise(runInContext(`(async function(){${source}})()`, realm), then)
}

const namedResources = `const events=[];
  using resource=class {static{events.push(this.name)} static [Symbol.dispose](){events.push(this.name)}};
  await using asyncResource=class {static observed=this.name;static async [Symbol.asyncDispose](){events.push(this.name)}};
  using named=class Explicit {static [Symbol.dispose](){events.push(this.name)}};
  using expression=(0,class {static [Symbol.dispose](){events.push(this.name)}});
  events.push(resource.name,asyncResource.observed,named.name,expression.name);return events`
const resourceNames = ['resource','resource','asyncResource','Explicit','','','Explicit','asyncResource','resource']

test('resource acquisition and disposal preserve source activations and original receivers', async t => {
  for (const kind of ['sync','async','fallback']) {
    const asynchronous = kind !== 'sync'
    const source = `${asynchronous ? 'async ' : ''}function f(){
      const observations=[],value={};
      function dispose(){observations.push(dispose.caller===f,this===value);return {get then(){throw Error('ignored sync result')}}}
      function get(){observations.push(get.caller===f,this===value);return dispose}
      Object.defineProperty(value,Symbol.${kind === 'async' ? 'asyncDispose' : 'dispose'},{get});
      ${kind === 'fallback' ? 'Object.defineProperty(value,Symbol.asyncDispose,{get:function missing(){observations.push(missing.caller===f,this===value);return null}});' : ''}
      {${asynchronous ? 'await ' : ''}using resource=value;observations.push(resource===value)}
      return observations;
    }return ${asynchronous ? 'await ' : ''}f()`
    // An async disposer result is assimilated; sync and async-from-sync ignore it.
    const program = kind === 'async' ? source.replace("return {get then(){throw Error('ignored sync result')}}",'return undefined') : source
    const expected = Array(kind === 'fallback' ? 7 : 5).fill(true)
    if (supportsNativeUsing()) assert.deepEqual(await new AsyncFunction(program)(), expected)
    for (const policy of ['stateful-v1','protected-v1']) {
      assert.deepEqual(await resourceSession(policy)(program),expected)
      const state = fixture({bindingUpdates:policy.split('-')[0]})
      t.after(()=>state.dispose())
      const result = await state.run(`resource-activation-${kind}`,program)
      assert.equal(result.error,undefined,result.error?.message)
      assert.deepEqual(result.value,expected)
      // A module activation is strict. Sloppy native callbacks can still
      // observe its null caller, while the module itself owns resource syntax.
      const moduleBody = `const observations=[],value={};
        const dispose=Function('observations','value','return function dispose(){observations.push(dispose.caller===null,this===value)}')(observations,value);
        const get=Function('observations','value','dispose','return function get(){observations.push(get.caller===null,this===value);return dispose}')(observations,value,dispose);
        Object.defineProperty(value,Symbol.${kind === 'async' ? 'asyncDispose' : 'dispose'},{get});
        ${kind === 'fallback' ? "Object.defineProperty(value,Symbol.asyncDispose,{get:Function('observations','value','return function missing(){observations.push(missing.caller===null,this===value);return null}')(observations,value)});" : ''}
        {${asynchronous ? 'await ' : ''}using resource=value;observations.push(resource===value)}
        return observations`
      const module = `export ${asynchronous ? 'async ' : ''}function run(){${moduleBody}}`
      if (supportsNativeUsing()) {
        const native = await import(`data:text/javascript,${encodeURIComponent(module)}`)
        assert.deepEqual(await native.run(),expected)
      }
      const fromModule = await loadManagedSource(t,module, { nativeUsing:false,
        transform:policy === 'protected-v1' ? PROTECTED_MODULE_TRANSFORM : USER_BINDING_TRANSFORM,
      })
      assert.deepEqual(await fromModule.run(),expected)
    }
    const lowered = lowerStatefulResources({code:program,sourceMap:identitySourceMap(program.length)},{nativeUsing:false})
    assert.deepEqual(await new AsyncFunction(lowered.code)(),expected)
    const reflected = lowerNativeLanguageSource(`async function reconstructed(){${program}}`,{nativeUsing:false})
    assert.deepEqual(await Function(`${reflected};return reconstructed`)()(),expected)
  }
})

test('resource async fallback preserves await gaps and suppression for throwing source calls', async () => {
  const outcomes = [
    { code: 'return undefined', steps: ['last','tick1'] },
    { code: 'return {then(resolve){events.push("then");resolve()}}', steps: ['last','tick1','then','tick2'] },
    { code: 'throw failure', steps: ['last'], failing: true },
  ]
  const patterns = ['', 'await using empty=null;',
    'using first={[Symbol.dispose](){events.push("first")}};await using empty=null;']
  for (const fallback of [false,true]) for (const outcome of outcomes) {
    for (const [patternIndex,pattern] of patterns.entries()) for (const bodyFailure of [false,true]) {
      const source = `const events=[],body={},failure={};let result;
        queueMicrotask(()=>{events.push('tick1');queueMicrotask(()=>{
          events.push('tick2');queueMicrotask(()=>events.push('tick3'))})});
        try{
          ${pattern}
          await using last={[Symbol.${fallback ? 'dispose' : 'asyncDispose'}](){events.push('last');${outcome.code}}};
          ${bodyFailure ? 'throw body' : ''}
        }catch(error){result=error===body?'body':error===failure?'dispose':error.error===failure&&error.suppressed===body?'suppressed':'unknown'}
        events.push('after');return [events.slice(),result]`
      const steps = fallback || outcome.failing && patternIndex > 0 ? ['last','tick1'] : outcome.steps
      const expected = [[...steps,...patternIndex === 2 ? ['first'] : [],'after'],
        outcome.failing ? bodyFailure ? 'suppressed' : 'dispose' : bodyFailure ? 'body' : undefined]
      if (supportsNativeUsing()) assert.deepEqual(await new AsyncFunction(source)(),expected)
      for (const policy of ['stateful-v1','protected-v1']) assert.deepEqual(await resourceSession(policy)(source),expected)
    }
  }
})

test('reflected decorated classes and resource methods close their own language helpers', async t => {
  const sources = [
    `function build(){const decorate=value=>value;
      @decorate class C{@decorate method(){using resource=null;return 42}}return new C().method()}`,
    `async function build(){const decorate=value=>value;
      const C=class extends(await Promise.resolve(class{})){@decorate method(){return 42}};return new C().method()}`,
    `function* build(){const decorate=value=>value;
      const C=class extends(yield class{}){@decorate method(){return 42}};return new C().method()}`,
  ]
  for (const [index,source] of sources.entries()) {
    const marked = markCallableSources(source,undefined,{plugins:CELL_PARSER_PLUGINS},
      {nativeUsing:false,lowerNativeSource:lowerNativeLanguageSource})
    const reflected = [...marked.callableSources][0][1]
    assert.doesNotMatch(reflected, /\busing resource\b|@decorate/)
    const result = Function(`return (${reflected})`)()()
    if (index === 2) {
      assert.equal(typeof result.next().value,'function')
      assert.deepEqual(result.next(class{}),{value:42,done:true})
    } else assert.equal(await result,42)
  }
  for (const bindingUpdates of ['stateful','protected']) {
    const state = fixture({bindingUpdates})
    t.after(()=>state.dispose())
    for (const [index,source] of sources.entries()) {
      const body = source + (index === 2
        ? ';const iterator=build();const first=iterator.next();return [typeof first.value,iterator.next(class{}).value]'
        : ';return await build()')
      const expected = index === 2 ? ['function',42] : 42
      const result = await state.run(`reflected-context-${index}`,body)
      assert.equal(result.error,undefined,`${bindingUpdates} / source ${index}: ${result.error?.message}`)
      assert.deepEqual(result.value,expected)
      const module = await loadManagedSource(t,`export async function run(){${body}}`, {
        transform:bindingUpdates === 'protected' ? PROTECTED_MODULE_TRANSFORM : USER_BINDING_TRANSFORM,
      })
      assert.deepEqual(await module.run(),expected)
    }
  }
})

test('callable grammar inspection leaves repeated declarations to the selected language owner', async t => {
  const sources = [
    'function build(){using resource=null;let value=1;let value=2;return value}',
    `function build(){const decorate=value=>value;
      @decorate class C{};let value=1;let value=2;return value}`,
  ]
  const state = fixture({bindingUpdates:'stateful'})
  const protectedState = fixture({bindingUpdates:'protected'})
  t.after(()=>state.dispose())
  t.after(()=>protectedState.dispose())
  for (const [index,source] of sources.entries()) {
    const marked = markCallableSources(source,undefined,{plugins:CELL_PARSER_PLUGINS},
      {nativeUsing:false,lowerNativeSource:lowerNativeLanguageSource})
    const reflected = [...marked.callableSources][0][1]
    assert.equal(Function(`return (${reflected})`)()(),2)
    const program = `${source};return build()`
    assert.equal(await resourceSession('stateful-v1')(program),2)
    const result = await state.run(`repeated-callable-${index}`,program)
    assert.equal(result.error,undefined,result.error?.message)
    assert.equal(result.value,2)
    const moduleSource = `${source};export {build}`
    const module = await loadManagedSource(t,moduleSource,{nativeUsing:false})
    assert.equal(module.build(),2)
    const rejected = await protectedState.run(`repeated-callable-${index}`,program)
    assert.match(rejected.error?.message ?? '', /Duplicate declaration|already been declared/)
    await assert.rejects(async () => loadManagedSource(t,moduleSource,
      {nativeUsing:false,transform:PROTECTED_MODULE_TRANSFORM}), /Duplicate declaration|already been declared/)
  }
})

test('method reflection containers remain expressions through dialect normalization', async t => {
  const sources = [
    ['yield', `function* build(){const C=class{[yield 'method'](){using r=null;let x=1;let x=2;return x}};
      return new C().method()}`],
    ['yield', `function* build(){const decorate=value=>value;
      const C=class{@decorate [yield 'method'](){using r=null;let x=1;let x=2;return x}};
      return new C().method()}`],
    ['await', `async function build(){const decorate=value=>value;
      const C=class{@decorate [await Promise.resolve('method')](){using r=null;let x=1;let x=2;return x}};
      return new C().method()}`],
    ['sync', `function build(){class C{#value=1;#read(){using r=null;let x=this.#value;let x=2;return x}
      read(){return this.#read()}};return new C().read()}`],
    ['sync', `function build(){class C extends class{read(){return 1}}{
      read(){using r=null;let x=super.read();let x=2;return x}};return new C().read()}`],
  ]
  const state = fixture({bindingUpdates:'stateful'})
  t.after(()=>state.dispose())
  for (const [index,[kind,source]] of sources.entries()) {
    const marked = markCallableSources(source,undefined,{plugins:CELL_PARSER_PLUGINS},
      {nativeUsing:false,lowerNativeSource:lowerNativeLanguageSource})
    const reflected = [...marked.callableSources][0][1]
    const result = Function(`return (${reflected})`)()()
    if (kind === 'yield') {
      assert.deepEqual(result.next(),{value:'method',done:false})
      assert.deepEqual(result.next('method'),{value:2,done:true})
    } else assert.equal(await result,2)
    const continuation = kind === 'yield'
      ? "const iterator=build();iterator.next();return iterator.next('method').value"
      : 'return await build()'
    const cell = await state.run(`method-container-${index}`,`${source};${continuation}`)
    assert.equal(cell.error,undefined,`source ${index}: ${cell.error?.message}`)
    assert.equal(cell.value,2)
    const module = await loadManagedSource(t,`${source};export {build}`,{nativeUsing:false})
    const value = module.build()
    if (kind === 'yield') {
      assert.deepEqual(value.next(),{value:'method',done:false})
      assert.deepEqual(value.next('method'),{value:2,done:true})
    } else assert.equal(await value,2)
    await assert.rejects(async () => loadManagedSource(t,`${source};export {build}`,
      {nativeUsing:false,transform:PROTECTED_MODULE_TRANSFORM}), /Duplicate declaration|already been declared/)
  }
})

test('definition-time callable reflection owns helpers before method invocation', async t => {
  const definitions = [
    ['sync', "(()=>{const decorate=value=>value;@decorate class C{};return 'm'})()"],
    ['sync', "(()=>{using resource=null;return 'm'})()"],
    ['sync', "(0,@((value)=>value) class C{},'m')"],
    ['sync', "({read(){using resource=null;return 'm'}}).read()"],
    ['sync', "(function read(C=class{@((value)=>value) read(){}}){return 'm'})()"],
    ['sync', "({[{toString(){return 'm'}}]:class{@((value)=>value) read(){}}}).m.name"],
    ['async', "await(async()=>{await using resource=null;return 'm'})()"],
    ['async', "(class extends(await Promise.resolve(class{})){@((value)=>value) read(){}},'m')"],
    ['generator', "(yield 'key',@((value)=>value) class C{},'m')"],
    ['generator', "(class extends(yield class{}){@((value)=>value) read(){}},'m')"],
  ]
  for (const bindingUpdates of ['stateful','protected']) {
    const state = fixture({bindingUpdates})
    t.after(()=>state.dispose())
    for (const [index,[kind,key]] of definitions.entries()) {
      const rebuilt = kind === 'async'
        ? "const Compile=Object.getPrototypeOf(async function(){}).constructor;return (await Compile('return ({'+reflected+'})')()).m()"
        : kind === 'generator'
          ? "const Compile=Object.getPrototypeOf(function*(){}).constructor;const values=Compile('return ({'+reflected+'})')();values.next();return values.next(class{}).value.m()"
          : "return Function('\"use strict\";return ({'+reflected+'})')().m()"
      const body = `const object={ [${key}](){return 2}};const reflected=object.m.toString();${rebuilt}`
      const source = kind === 'generator'
        ? `function* build(){${body}};const values=build();values.next();return values.next(class{}).value`
        : body
      const result = await state.run(`definition-helper-${index}`,source)
      assert.equal(result.error,undefined,`${bindingUpdates}/${kind}/${index}: ${result.error?.message}`)
      assert.equal(result.value,2)
      const module = await loadManagedSource(t,`export async function run(){${source}}`,{nativeUsing:false,
        transform:bindingUpdates === 'protected' ? PROTECTED_MODULE_TRANSFORM : USER_BINDING_TRANSFORM})
      assert.equal(await module.run(),2)
    }
  }
})

test('computed class field key captures stay per class evaluation across reconstruction', async t => {
  const keyOf = 'const keyOf = description => ({ toString() { return description } });'
  const keys = "const A = build(keyOf('a')); const B = build(keyOf('b'));"
  const decorated = '@((value) => value) '
  const shapes = [
    ['instance', value => 'function build(k, Holder=class{[k]=class{' + value + 'method(){}}}){return Holder}',
      'new A().a.name, new B().b.name, new A().a.name', ['a', 'b', 'a'], build => {
        const A = build({ toString() { return 'a' } }), B = build({ toString() { return 'b' } })
        return [new A().a.name, new B().b.name, new A().a.name]
      }],
    ['body', value => 'function build(k){return class{[k]=class{' + value + 'method(){}}}}',
      'new A().a.name, new B().b.name, new A().a.name', ['a', 'b', 'a'], build => {
        const A = build({ toString() { return 'a' } }), B = build({ toString() { return 'b' } })
        return [new A().a.name, new B().b.name, new A().a.name]
      }],
    ['static', value => 'function build(k, Holder=class{static [k]=class{' + value + 'method(){}}}){return Holder}',
      'A.a.name, B.b.name, A.a.name', ['a', 'b', 'a'], build => {
        const A = build({ toString() { return 'a' } }), B = build({ toString() { return 'b' } })
        return [A.a.name, B.b.name, A.a.name]
      }],
  ]
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    for (const [index, [label, declaration, selection, expectedValues, observe]] of shapes.entries()) {
      const native = Function('"use strict";return (' + declaration('') + ')')()
      const expected = observe(native)
      assert.deepEqual(expected, expectedValues, label)
      const direct = declaration(decorated) + '\n' + keyOf + keys + ' return [' + selection + ']'
      const result = await state.run('computed-field-key-' + index, direct)
      assert.equal(result.error, undefined, bindingUpdates + '/' + label + ': ' + result.error?.message)
      assert.deepEqual(result.value, expected, bindingUpdates + '/' + label)
      // A detached callable shares no program storage, so its key must travel in its own frame.
      const method = declaration(decorated).slice('function build'.length).replace(/^\(/, 'm(')
      const detached = 'const object={' + method + '};const reflected = object.m.toString();'
        + 'const build = Function(\'"use strict";return ({\' + reflected + \'}).m\')();'
        + keyOf + keys + ' return [' + selection + ']'
      const reflectedResult = await state.run('computed-field-detached-' + index, detached)
      assert.equal(reflectedResult.error, undefined,
        bindingUpdates + '/detached/' + label + ': ' + reflectedResult.error?.message)
      assert.deepEqual(reflectedResult.value, expected, bindingUpdates + '/detached/' + label)
      const module = await loadManagedSource(t, 'export async function run(){' + direct + '}', { nativeUsing: false,
        transform: bindingUpdates === 'protected' ? PROTECTED_MODULE_TRANSFORM : USER_BINDING_TRANSFORM })
      assert.deepEqual(await module.run(), expected, bindingUpdates + '/module/' + label)
    }
  }
})

test('anonymous decorated classes in non-name positions keep the empty native name', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const source = `function build(){ return class{ @((value)=>value) method(){} } }
      const take = value => value
      return [build().name, take(class{ @((value)=>value) method(){} }).name,
        [class{ @((value)=>value) method(){} }][0].name]`
    const result = await state.run('decorated-class-name', source)
    assert.equal(result.error, undefined, bindingUpdates + ': ' + result.error?.message)
    assert.deepEqual(result.value, ['', '', ''], bindingUpdates)
  }
})

test('computed class names retain source key coercion, property order and descriptors', () => {
  const property = `object={first:(events.push('first'),0),[key]:class{@((value)=>value) read(){}},
    last:(events.push('last'),0)}`
  for (const expression of [property, `({[(${property},'m')](){}})`]) {
    const source = `function build(){
    const results=[];
    for(const selected of ['m','__proto__',Symbol('m')]){
      const events=[];
      const key={toString:function convert(){events.push(convert.caller===build);return selected}};
      let object;
      ${expression};
      const descriptor=Object.getOwnPropertyDescriptor(object,selected);
      results.push([events,object[selected].name,Reflect.ownKeys(object).map(String),
        descriptor.enumerable,descriptor.configurable,descriptor.writable,Object.getPrototypeOf(object)===Object.prototype]);
    }
    return results;
  }`
    const marked = markCallableSources(source,undefined,{plugins:CELL_PARSER_PLUGINS},
      {nativeUsing:false,lowerNativeSource:lowerNativeLanguageSource})
    const reflected = [...marked.callableSources][0][1]
    const build = Function(`return (${reflected})`)()
    assert.deepEqual(build(),[
      [['first',true,'last'],'m',['first','m','last'],true,true,true,true],
      [['first',true,'last'],'__proto__',['first','__proto__','last'],true,true,true,true],
      [['first',true,'last'],'[m]',['first','last','Symbol(m)'],true,true,true,true],
    ])
  }
})

test('resource GetMethod keeps native validation order, proxy receivers and failed initialization', async () => {
  const sources = [
    `const events=[],failure={};let result;
      const target={[Symbol.dispose](){events.push(this===proxy)}};
      const proxy=new Proxy(target,{get(target,key,receiver){events.push(key===Symbol.asyncDispose?'async':'sync');return Reflect.get(target,key,receiver)}});
      {await using resource=proxy;events.push(resource===proxy)}
      try{await using bad={[Symbol.asyncDispose]:1,get [Symbol.dispose](){throw failure}}}
      catch(error){result=error instanceof TypeError}
      return [events,result]`,
    `let reads=0,result;const descriptor=Object.getOwnPropertyDescriptor(Number.prototype,Symbol.dispose);
      try{Object.defineProperty(Number.prototype,Symbol.dispose,{configurable:true,get(){reads++;return ()=>{}}});
        try{using invalid=1}catch(error){result=error instanceof TypeError}
      }finally{if(descriptor===undefined)delete Number.prototype[Symbol.dispose];else Object.defineProperty(Number.prototype,Symbol.dispose,descriptor)}
      return [reads,result]`,
    `const failure={};let read,result;
      try{using resource={get [Symbol.dispose](){read=()=>resource;throw failure}}}
      catch(error){result=error===failure}
      let tdz=false;try{read()}catch(error){tdz=error instanceof ReferenceError}return [result,tdz]`,
  ]
  const expectedValues = [[['async','sync',true,true],true],[0,true],[true,true]]
  for (const [i,source] of sources.entries()) {
    const expected = expectedValues[i]
    if (supportsNativeUsing()) assert.deepEqual(await new AsyncFunction(source)(),expected)
    for (const policy of ['stateful-v1','protected-v1']) assert.deepEqual(await resourceSession(policy)(source),expected)
  }
})

test('resource helpers own stack, binding and promise protocols while preserving source effects', async () => {
  for (const asynchronous of [false, true]) {
    const source = `const events=[],failure=Error('body'),disposeFailure=Error('dispose');
      const owners=[[Array.prototype,'push'],[Array.prototype,'pop'],[Function.prototype,'bind'],[Promise.prototype,'then']];
      const saved=owners.map(([object,key])=>object[key]);let result;
      try{
        for(let i=0;i<owners.length;i++)owners[i][0][owners[i][1]]=null;
        let explicit=false;try{[].pop()}catch(error){explicit=error instanceof TypeError}
        try{
          using first={[Symbol.dispose](){events[events.length]='first';throw disposeFailure}};
          ${asynchronous ? `await using empty=null;
            await using second={[Symbol.asyncDispose]:async function(){events[events.length]='second'}};`
            : "using second={[Symbol.dispose](){events[events.length]='second'}};"}
          events[events.length]='body';throw failure;
        }catch(error){result=[events,explicit,error.name,error.error===disposeFailure,error.suppressed===failure]}
      }finally{for(let i=0;i<owners.length;i++)owners[i][0][owners[i][1]]=saved[i]}
      return result`
    const expected = [['body', 'second', 'first'], true, 'SuppressedError', true, true]
    if (supportsNativeUsing()) assert.deepEqual(structuredClone(await runResourceRealm(source)), expected)
    for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
      assert.deepEqual(structuredClone(await resourceSession(languageSemantics, createContext())(source)), expected)
    }
    const moduleSource = `return await (async function(){${source}})()`
    const lowered = lowerStatefulResources({ code: moduleSource, sourceMap: identitySourceMap(moduleSource.length) },
      { nativeUsing: false })
    assert.deepEqual(structuredClone(await runResourceRealm(lowered.code)), expected)
  }
})

test('resource stack index writes ignore inherited numeric setters', async () => {
  const source = `let disposed=0;
    const previous=Object.getOwnPropertyDescriptor(Array.prototype,'0');
    try{
      Object.defineProperty(Array.prototype,'0',{configurable:true,set(){throw Error('source index')}});
      { using resource={[Symbol.dispose](){disposed+=1}}; }
    }finally{
      if(previous===undefined)delete Array.prototype['0'];
      else Object.defineProperty(Array.prototype,'0',previous);
    }
    return disposed`
  for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
    assert.equal(await resourceSession(languageSemantics, createContext())(source), 1)
  }
  if (supportsNativeUsing()) assert.equal(await runResourceRealm(source), 1)
})

test('resource Await ignores species but preserves disposer assimilation and suppression', async () => {
  for (const rejected of [false, true]) {
    const source = `let events='',reads=0,result;const failure=Error('disposer');
      const species=Object.getOwnPropertyDescriptor(Promise,Symbol.species);
      try{
        Object.defineProperty(Promise,Symbol.species,{configurable:true,get(){throw Error('source species')}});
        try{
          using first={[Symbol.dispose](){events+='first;'}};
          await using empty=null;
          await using last={[Symbol.asyncDispose](){events+='last;';return {
            get then(){reads++;return (resolve,reject)=>${rejected ? 'reject(failure)' : 'resolve()'}}
          }}};
          events+='body;';
        }catch(error){result=error===failure}
      }finally{Object.defineProperty(Promise,Symbol.species,species)}
      return [events,reads,result===${rejected ? 'true' : 'undefined'}]`
    const expected = ['body;last;first;', 1, true]
    if (supportsNativeUsing()) assert.deepEqual(structuredClone(await runResourceRealm(source)), expected)
    for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
      assert.deepEqual(structuredClone(await resourceSession(languageSemantics, createContext())(source)), expected)
    }
    const wrapped = `return await (async function(){${source}})()`
    const lowered = lowerStatefulResources({code:wrapped,sourceMap:identitySourceMap(wrapped.length)}, {nativeUsing:false})
    assert.deepEqual(structuredClone(await runResourceRealm(lowered.code)), expected)
  }
})

function resourceSession(languageSemantics = 'stateful-v1', realm) {
  const context = Object.create(null)
  const executionGlobal = realm === undefined ? globalThis : runInContext('globalThis', realm)
  const Execute = realm === undefined ? AsyncFunction : runInContext('(async function(){}).constructor', realm)
  const ExecuteScript = realm === undefined ? Function : runInContext('Function', realm)
  const then = realm === undefined ? Promise.prototype.then : runInContext('Promise.prototype.then', realm)
  const known = new Set()
  const writable = new Set()
  const runtime = createStatefulRootRuntime({
    ...(realm === undefined ? {} : { dynamicIntrinsics: runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', realm) }),
    typeofAmbient: name => typeof (Object.hasOwn(context, name) ? context[name] : executionGlobal[name]),
    readAmbient(name) {
      if (Object.hasOwn(context, name)) return context[name]
      if (name in executionGlobal) return executionGlobal[name]
      throw new ReferenceError(`${name} is not defined`)
    },
    publish(name, get, set) { Object.defineProperty(context, name, { configurable: true, get, set }) },
  })
  return async source => {
    const prepared = prepareProgram(source, { languageSemantics, nativeUsing: false,
      knownBindings: known, writableBindings: writable })
    const committed = new Set()
    context[prepared.rootRuntimeName] = runtime.begin({ ...prepared.rootPlan, committed: name => committed.add(name) })
    class Returned { constructor(value) { this.value = value } }
    context[prepared.returnSignal] = Returned
    try {
      const executable = prepared.asyncCompletion
        ? new ExecuteScript(`return ${prepared.code}`) : new Execute(prepared.code)
      return await observeRealmPromise(executable.call(context), then)
    }
    catch (error) { if (error instanceof Returned) return error.value; throw error }
    finally {
      for (const declaration of prepared.declarations) if (committed.has(declaration.commitDependency)) {
        known.add(declaration.name)
        if (declaration.writable) writable.add(declaration.name)
        else writable.delete(declaration.name)
      }
      delete context[prepared.rootRuntimeName]
      delete context[prepared.returnSignal]
    }
  }
}

test('resource fallback keeps protected root lexical policy, source locations and failed initialization', async () => {
  const source = 'using resource=null;\nconst value=1;return value'
  const prepared = prepareProgram(source, { languageSemantics: 'protected-v1', nativeUsing: false })
  assert.deepEqual(prepared.declarations.map(item => [item.name, item.writable, item.span.line]),
    [['resource', false, 1], ['value', false, 2]])
  const run = resourceSession('protected-v1')
  assert.equal(await run(source), 1)
  await assert.rejects(run('value=2'), /constant variable/)
  await assert.rejects(run('using next=null; return late; const late=1'), /before initialization/)
  assert.equal(await run('return typeof late'), 'undefined')
})

test('resource fallback retains dynamic binding metadata and executes local direct eval', async () => {
  const source = 'function f(){using resource=null;let value=1;return eval("value")};return f()'
  const normalized = normalizeStatefulScopes(source, undefined, { nativeUsing: false })
  assert.ok(normalized.dynamicBindings.some(item => item.name === 'value'))
  assert.ok(normalized.sourceRegions)
  assert.equal(await resourceSession()(source), 1)
  const untouched = { code: 'const usingName="using";', internalBindings: new Set(['existing']) }
  assert.equal(lowerStatefulResources(untouched, { nativeUsing: false }), untouched)
})

test('resource fallback captures compiler intrinsics and invokes disposal without reading a method call property', async () => {
  const run = resourceSession()
  await run('const NativeSymbol=Symbol; const events=[]')
  assert.deepEqual(await run(`
    const Symbol={}, Promise={}, Object={}, TypeError={};
    const dispose=()=>events.push('disposed'); dispose.call=()=>events.push('wrong');
    using resource={[NativeSymbol.dispose]:dispose};
    await using other={[NativeSymbol.asyncDispose]:async()=>events.push('async')};
    events.push('body');return events
  `), ['body', 'async', 'disposed'])
  assert.deepEqual(await run(`try {
    using broken={[NativeSymbol.dispose](){throw new Error('dispose')}};
    throw new Error('body')
  } catch(error){return [error.name,error.error.message,error.suppressed.message]}`),
  ['SuppressedError', 'dispose', 'body'])
})

test('resource-bearing callable source reconstructs in a native compiler without private dependencies', async () => {
  const source = 'async function read(Symbol){await using resource=null;return Symbol}'
  const marked = markCallableSources(source, undefined, {}, { nativeUsing: false, lowerNativeSource: lowerNativeLanguageSource })
  const reflected = [...marked.callableSources][0][1]
  assert.doesNotMatch(reflected, /await using/)
  assert.equal(await Function(`return (${reflected})`)()(7), 7)
  const code = 'using resource=null;return 3'
  const block = lowerStatefulResources({ code, sourceMap: identitySourceMap(code.length) }, { nativeUsing: false, target: 'commonjs' })
  assert.equal(Function(block.code)(), 3)
})

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`resource initializers infer source names before acquisition and disposal (${bindingUpdates})`, async t => {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    if (supportsNativeUsing()) assert.deepEqual(await new AsyncFunction(namedResources)(), resourceNames)
    const run = resourceSession(`${bindingUpdates}-v1`)
    for (const [i, source] of [namedResources, `return (async function(){${namedResources}})()`].entries()) {
      assert.deepEqual(await run(source), resourceNames)
      const result = await state.run(`resource-names-${bindingUpdates}-${i}`, source)
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, resourceNames)
    }
    assert.equal(await run(`using typed:any=(class {static [Symbol.dispose](){}} as any);return typed.name`), 'typed')
  })

  test(`cell returns preserve native resource disposal and finally completion (${bindingUpdates})`, async t => {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const sources = [
      `try {using r={[Symbol.dispose](){throw Error('dispose')}};return 1}
        catch(error){return [error.name,error.message,error.suppressed===undefined]}`,
      `try {await using r={[Symbol.asyncDispose]:async()=>{throw Error('dispose')}};return 1}
        catch({name,message}){return [name,message]}`,
      `const events=[];using r={[Symbol.dispose](){events.push('dispose')}};
        return {then(resolve){events.push('then');resolve(events)}}`,
      `const events=[];for(let i=0;i<2;i++){try{using r={[Symbol.dispose](){events.push(i)}};return 1}
        finally{continue}};return events`,
      `label:{try{using r=null;return 1}finally{break label}};return 2`,
      `try{using r=null;return 1}finally{return 2}`,
      `try{using r={[Symbol.dispose](){throw Error('dispose')}};return 1}catch{return 3}`,
    ]
    const expectedValues = [['Error','dispose',true], ['Error','dispose'], ['dispose','then'], [0,1], 2, 2, 3]
    for (const [i, source] of sources.entries()) {
      const expected = expectedValues[i]
      if (supportsNativeUsing()) assert.deepEqual(await new AsyncFunction(source)(), expected)
      const result = await state.run(`resource-completion-${bindingUpdates}-${i}`, source)
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value, expected, source)
    }
    const failed = await state.run(`resource-failure-${bindingUpdates}`,
      `const retained=41;using r={[Symbol.dispose](){throw Error('dispose')}};return 1`)
    assert.match(failed.error.message, /uncaught Error: dispose/)
    assert.doesNotMatch(failed.error.message, /SuppressedError|CellReturn/)
    assert.equal((await state.run(`resource-failure-${bindingUpdates}`, 'return retained+1')).value, 42)
  })

  test(`nested async resource declarations select the cell async goal (${bindingUpdates})`, async t => {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const resource = `{[Symbol.asyncDispose]:async()=>events.push('dispose')}`
    const sources = [
      `const events=[];{await using r=${resource};events.push('body')};return events`,
      `const events=[];try{throw 1}catch{await using r=${resource};events.push('body')};return events`,
      `const events=[];for(await using r of [${resource}]){events.push('body')};return events`,
      `const events=[];outer:for(let i=0;i<2;i++){await using r=${resource};events.push(i);continue outer};return events`,
    ]
    for (const [i, source] of sources.entries()) {
      const result = await state.run(`nested-resource-${bindingUpdates}-${i}`, source)
      assert.equal(result.error, undefined, result.error?.message)
      const expected = i === 3 ? [0,'dispose',1,'dispose'] : ['body','dispose']
      if (supportsNativeUsing()) assert.deepEqual(await new AsyncFunction(source)(), expected)
      assert.deepEqual(result.value, expected)
    }
    assert.throws(() => prepareProgram('function ordinary(){await using resource=null}',
      { languageSemantics: `${bindingUpdates}-v1` }), SyntaxError)
  })
}

test('resource return lowering retains expression completions after finally cancels return', async t => {
  const state = fixture()
  t.after(() => state.dispose())
  for (const [i, source] of [
    'label:{try{using r=null;return 1}finally{break label}};42',
    'for(let i=0;i<2;i++){try{using r=null;return 1}finally{continue}};42',
    'using r=null;42;const value=1',
  ].entries()) assert.equal((await state.run(`resource-expression-${i}`, source)).value, 42)
  assert.deepEqual(await state.run('cancelled-resource-return',
    'label:{try{using r=null;return 1}finally{break label}}'), { logs: [] })
})

test('resource fallback retains async loop disposal, head TDZ and nested lexical shadowing', async () => {
  for (const policy of ['stateful-v1','protected-v1']) {
    const run = resourceSession(policy)
    const source = `const events=[];for(await using r of [{[Symbol.asyncDispose]:async()=>events.push('dispose')}]){
      const r=7;events.push(r)};return events`
    assert.deepEqual(await run(source), [7,'dispose'])
    await assert.rejects(run('for(await using missing of [missing]){}'), /before initialization/)
  }
})
