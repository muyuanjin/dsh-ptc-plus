import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatefulScopes, lowerStatefulDecorators } from '../internal/repl-scope-normalizer.js'
import { compileStatefulRoot } from '../internal/stateful-root-compiler.js'
import { createStatefulRootRuntime } from '../internal/stateful-root-runtime.js'
import { mapSourcePosition } from '../internal/source-position-map.js'
import { parseExecutableCell } from '../internal/cell-parser.js'

const compile = (source, options) => normalizeStatefulScopes(source, undefined, options)
const run = (source, options) => Function(parseExecutableCell(compile(source, options).code, { eraseTypes: true }).code)()

test('Annex B block functions promote only along executed declarations', () => {
  assert.equal(run('if(true){function inside(){return 4}};return inside()'), 4)
  assert.equal(run('if(true)function inside(){return 4};return inside()'), 4)
  assert.equal(run('if(false){function inside(){return 4}};return inside'), undefined)
  assert.equal(run('function f(){if(true){function inside(){return 4}};return inside()}return f()'), 4)
  assert.equal(run('let inside=3;if(true){function inside(){return 4}};return inside'), 3)
  assert.equal(run('function f(inside){if(true){function inside(){return 4}};return inside}return f(3)'), 3)
  assert.equal(run('"use strict";if(true){function inside(){return 4}};return typeof inside'), 'undefined')
  assert.equal(run('function f(){var inside=1;{return inside;function inside(){return 4}}}return typeof f()'), 'function')
  assert.equal(run('function f(){var inside=1;{if(true)return ()=>inside;function inside(){return 4}}}return f()()()'), 4)
  assert.equal(run('function f(){var inside=1;{if(false){function inside(){return 4}}}return inside}return f()'), 1)
})

test('protected TypeScript runtime declarations lower before native execution', () => {
  const source = 'enum E{A=1};enum E{B=2};namespace N{export const x=E.B};return [E.A,E.B,N.x]'
  assert.deepEqual(run(source, { mode: 'protected-v1' }), [1, 2, 2])
})

test('abstract class modifiers erase before logical class expression lowering', () => {
  for (const mode of ['stateful-v1', 'protected-v1']) {
    assert.deepEqual(run(`const effects=[];const decorate=C=>{effects.push(C.name);return C};
      function create(){
        @decorate /* abstract */ abstract /* class */ class Example {
          abstract method(): number; value:number=4
        }
        return [Example.name,new Example().value];
      }
      return [create(),effects];`, { mode }), [['Example',4],['Example']])
  }
  assert.equal(run(`function create(){abstract class Current{value=1};
    abstract class Current{value=2};return new Current().value}return create()`), 2)
})

test('erased default types and abstract classes preserve actual root execution and persistence', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const first = await state.run(`erased-default-${bindingUpdates}`, `
      export default interface Hidden { value: number }
      export default function signature(): void;
      abstract class Root { abstract read(): number; static value=3 }
      function local(){abstract class Local{value=4};return new Local().value}
      return [Root.name,Root.value,local(),typeof __default,typeof signature]
    `)
    assert.deepEqual(first.value, ['Root',3,4,'undefined','undefined'], JSON.stringify(first.error))
    assert.equal((await state.run(`erased-default-${bindingUpdates}`, 'return Root.value')).value, 3)
  }
})

test('private call, method naming and TDZ helpers ignore user intrinsic shadows', () => {
  const source = `function example(){
    const Object=0,Reflect=0,TypeError=0,ReferenceError=0;
    class C{#m(){return 1}static #m(){return 2}static read(value){return value.#m()}}
    return [C.read(new C()),C.read(C)];
  }return example()`
  assert.deepEqual(run(source), [1, 2])
  assert.throws(() => run('function f(){const ReferenceError=0;return x;let x=1}return f()'), ReferenceError)
  assert.throws(() => run('const TypeError=0;class C{#m(){}#m(){}static read(o){return o.#m}}return C.read({})'), TypeError)
})

test('decorated private replacements retain evaluation, application and initializer effects', () => {
  assert.deepEqual(run(`function example(){
    const events=[];
    function decorate(label){events.push('eval '+label);return (value,context)=>{
      events.push('apply '+label+' '+context.name+' '+value.name);
      context.addInitializer(function(){events.push('init '+label)});
      return function(){return value.call(this)+10};
    }}
    class C{
      @decorate('first') #m(){return 1}
      @decorate('last') #m(){return 2}
      read(){return this.#m()}
    }
    const c=new C();return [events,c.read()];
  }return example()`), [[
    'eval first', 'eval last', 'apply first #m #m', 'apply last #m #m', 'init first', 'init last',
  ], 12])
})

test('decorators support classes, fields and auto-accessors under intrinsic shadows', () => {
  const source = `function example(){
    const Object=0,Reflect=0,Symbol=0,TypeError=0,Error=0,String=0,Number=0;
    const events=[];
    function field(value,context){context.addInitializer(function(){events.push(context.name)});return x=>x+1}
    function accessor(value,context){return {init:x=>x+2}}
    function decorated(C){return class extends C{extra=4}}
    @decorated class C{ @field value:number=1; @accessor accessor count=2 }
    const c=new C();return [c.value,c.count,c.extra,events];
  }return example()`
  assert.deepEqual(run(source), [2, 4, 4, ['value']])
})

test('overwritten public decorators see the original members and receiver', () => {
  assert.deepEqual(run(`function example(){
    const events=[];
    const decorators={decorate(value,context){events.push([this===decorators,value(),value.name,context.name,context.private]);return ()=>9}};
    class C{@decorators.decorate m(){return 1}m(){return 2}}
    return [events,new C().m()];
  }return example()`), [[[true, 1, 'm', 'm', false]], 2])
  assert.deepEqual(run(`function example(){const seen=[];const d=(v,c)=>{seen.push(c.name)};
    class C{@d ['m'](){return 1}['m'](){return 2}}return [seen,new C().m()]}
    return example()`), [['m'], 2])
})

test('discarded decorated private fields preserve initialization and application phases', () => {
  assert.deepEqual(run(`function example(){
    const events=[];
    function decorator(label){events.push('evaluate '+label);return (value,context)=>{
      events.push('apply '+label+' '+context.kind+' '+context.name);
      context.addInitializer(function(){events.push('extra '+label)});
      return value=>{events.push('initialize '+label);return value+10};
    }}
    class C{
      @decorator('first') #x=(events.push('field first'),1);
      @decorator('last') #x=(events.push('field last'),2);
      read(){return this.#x}
    }
    return [new C().read(),events];
  }return example()`), [12, [
    'evaluate first', 'evaluate last', 'apply first field #x', 'apply last field #x',
    'field first', 'initialize first', 'extra first', 'field last', 'initialize last', 'extra last',
  ]])
})

test('decorator failures stop later execution without dropping completed effects', () => {
  assert.deepEqual(run(`function example(){
    const events=[];
    const decorate=(value,context)=>{events.push(context.name);throw new Error('application')};
    try{class C{@decorate #x(){} #x(){}}}catch(error){events.push(error.message)}
    return events;
  }return example()`), ['#x', 'application'])
})

test('decorated anonymous classes preserve their private dispatch and class replacement', () => {
  assert.equal(run('const dec=C=>C;const C=(@dec class {#x=1;#x=2;read(){return this.#x}});return new C().read()'), 2)
})

test('decorated repeated static methods and accessor pairs retain selected shapes', () => {
  assert.deepEqual(run(`function example(){
    const names=[];const d=(value,context)=>{names.push(context.name+':'+context.kind)};
    class C{
      @d static #m(){return 1} @d #m(){return 2}
      @d get #x(){return 3} @d get #x(){return 4} @d set #x(value){this.value=value}
      static read(value){return value.#m()}
      read(){this.#x=8;return [this.#x,this.value]}
    }
    return [C.read(C),C.read(new C()),new C().read(),names];
  }return example()`), [1, 2, [4, 8], ['#m:method', '#m:method', '#x:getter', '#x:getter', '#x:setter']])
  assert.throws(() => run('const d=x=>x;class C{@d #x(){}#x(){}write(){this.#x=1}}new C().write()'), /not writable/)
  assert.deepEqual(run('const d=()=>function replacement(){};class C{@d #x(){}@d static #x(){}static read(o){return o.#x.name}}return [C.read(C),C.read(new C())]'), ['replacement', 'replacement'])
  assert.deepEqual(run(`function example(){const seen=[];const d=(v,c)=>{seen.push(c.kind)};
    class C{#value=0;get #x(){return this.#value}set #x(v){this.#value=v}
      @d get x(){return this.#x}@d set x(v){this.#x=v}}
    const c=new C();c.x=6;return [seen,c.x]}return example()`), [['getter', 'setter'], 6])
})

test('decorator source maps point back to the source method body', () => {
  const source = 'function example(){\nconst d=value=>value;\nclass C{@d method(){throw new Error("marker")}}\nreturn C;\n}return example()'
  const result = compile(source)
  const offset = result.code.indexOf('throw new Error("marker")')
  assert.ok(offset >= 0)
  const prefix = result.code.slice(0, offset).split('\n')
  const mapped = mapSourcePosition({ line: prefix.length, column: prefix.at(-1).length + 1 }, result.code, source, result.sourceMap)
  assert.equal(mapped.line, 3)
})

test('deferred decorators preserve root update identities and compiler bootstrap names', async () => {
  const source = 'const n=1;const n=n+1;const decorate=C=>class extends C{value=n};@decorate class C{};return new C().value'
  const normalized = compile(source, { deferDecorators: true })
  const context = {}
  const root = compileStatefulRoot(normalized.code, { sourceMap: normalized.sourceMap,
    internalBindings: normalized.internalBindings, originalSource: source })
  const lowered = lowerStatefulDecorators(root)
  const runtime = createStatefulRootRuntime({ readAmbient: name => context[name] ?? globalThis[name] })
  context[root.rootRuntimeName] = runtime.begin({ ...root.rootPlan, committed() {} })
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.equal(await new AsyncFunction(lowered.code).call(context), 2)
  assert.equal(new (runtime.read('C'))().value, 2)
  assert.ok(!root.declarations.some(declaration => declaration.name.includes('intrinsics')))
})

test('root decorated bindings and Annex B promotion remain available in subsequent cells', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const first = await state.run('f100-decorator', 'const decorate=C=>class extends C{value=7}; @decorate class C{}; return new C().value')
  assert.equal(first.value, 7, JSON.stringify(first.error))
  const second = await state.run('f100-decorator', 'return [new C().value, C.name]')
  assert.equal(second.value?.[0], 7, JSON.stringify(second.error))
  const block = await state.run('f100-annex', 'if(true){function inside(){return 4}}; return inside()')
  assert.equal(block.value, 4, JSON.stringify(block.error))
  assert.equal((await state.run('f100-annex', 'return inside()')).value, 4)
})

test('computed duplicate decorators retain keys, applications, replacements and initializers', () => {
  assert.deepEqual(run(`const events=[];
    const key=label=>({[Symbol.toPrimitive](hint){events.push('key '+label+' '+hint);return 'm'}});
    const decorate=label=>{events.push('evaluate '+label);return (value,context)=>{
      events.push('apply '+label+' '+context.name+' '+value.name+' '+value());
      context.addInitializer(function(){events.push('initialize '+label+' '+this.m())});
      return ()=>value()+10;
    }};
    class C{@decorate('first') [key('first')](){return 1}@decorate('last') [key('last')](){return 2}}
    return [events,new C().m(),Object.getOwnPropertyNames(C.prototype),Object.getOwnPropertySymbols(C.prototype)];`), [[
    'evaluate first', 'key first string', 'evaluate last', 'key last string',
    'apply first m m 1', 'apply last m m 2', 'initialize first 12', 'initialize last 12',
  ], 12, ['constructor', 'm'], []])
})

test('computed public decorators preserve access, symbols, receiver and class initialization order', () => {
  assert.deepEqual(run(`const events=[],symbol=Symbol('m');const key=()=>symbol;
    const decorators={decorate(value,context){events.push([this===decorators,context.name===symbol,context.private,value.name]);
      context.addInitializer(function(){events.push(context.access.has(this));events.push(context.access.get(this)())});return ()=>value()+10}};
    const classDecorator=C=>{events.push(C[symbol]());return C};
    @classDecorator class C{
      @decorators.decorate static [key()](){return 1}
      @(decorators['decorate']) static [key()](){return 2}
      static value=(events.push('field'),this[symbol]());
    }
    return [events,C.value,Object.getOwnPropertySymbols(C).filter(s=>s===symbol).length];`), [[
    [true, true, false, '[m]'], [true, true, false, '[m]'], 12, true, 12, true, 12, 'field',
  ], 12, 1])
  assert.deepEqual(run(`const names=[],key=()=>Symbol.for('pair');const d=(v,c)=>{names.push(c.kind+':'+v.name)};
    class C{@d get [key()](){return 1}@d get [key()](){return this.value??2}
      @d set [key()](value){this.value=value}}
    const c=new C();c[Symbol.for('pair')]=7;return [names,c[Symbol.for('pair')]];`), [
    ['getter:get [pair]', 'getter:get [pair]', 'setter:set [pair]'], 7,
  ])
  assert.deepEqual(run(`const seen=[],key=()=>'m',d=(v,c)=>{seen.push(v());return ()=>10};
    class C{@d [key()](){return 1}[key()](){return 2}}
    return [seen,new C().m(),new C().m.name];`), [[1], 2, 'm'])
})

test('computed decorator errors retain completed effects and skip later phases', () => {
  assert.deepEqual(run(`const events=[],key=()=>'m';
    const d=label=>{events.push('evaluate '+label);return ()=>{events.push('apply '+label);throw new Error('stop')}};
    try{class C{@d('first') [key()](){}@d('last') [key()](){}static x=events.push('field')}}catch(e){events.push(e.message)}
    return events;`), ['evaluate first', 'evaluate last', 'apply first', 'stop'])
  assert.deepEqual(run(`const events=[],key=()=>'m',d=()=>{events.push('apply');return 1};
    try{class C{@d [key()](){}@d [key()](){}}}catch(e){events.push(e instanceof TypeError)}return events;`), ['apply', true])
  assert.deepEqual(run(`const events=[],key=()=>'m',d=(v,c)=>{c.addInitializer(()=>{events.push('init');throw Error('stop')})};
    class C{@d [key()](){}@d [key()](){}value=events.push('field')}
    try{new C()}catch(e){events.push(e.message)}return events;`), ['init', 'stop'])
})

test('private normalization leaves anonymous class naming to the native expression context', async () => {
  assert.deepEqual(run(`const C=class{#x=1;#x=2;static seen=this.name;read(){return this.#x}};
    let assigned;assigned=class{#x(){}#x(){}};
    const {fallback=class{#x=1;#x=2}}={};
    const key=Symbol('named'),object={[key]:class{#x=1;#x=2;static seen=this.name}};
    return [C.name,C.seen,new C().read(),assigned.name,fallback.name,object[key].name,object[key].seen,
      (class{#x=1;#x=2}).name,Object.getOwnPropertySymbols(C).length];`), ['C', 'C', 2, 'assigned', 'fallback', '[named]', '[named]', '', 0])
  assert.deepEqual(run(`const classes=[];for(let key of ['a','b'])classes.push(class{[key]=class{#x=1;#x=2;static seen=this.name}});
    return [new classes[0]().a.name,new classes[0]().a.seen,new classes[1]().b.name];`), ['a', 'a', 'b'])
  assert.deepEqual(run(`const events=[],d=C=>{events.push(C.name);return C};
    const C=(@d class{#x=1;#x=2;static seen=this.name});return [events,C.name,C.seen];`), [['C'], 'C', 'C'])
  const source = 'export default class{#x=1;#x=2;static seen=this.name;read(){return this.#x}}'
  const compiled = compile(source, { target: 'module' })
  const module = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`)
  assert.deepEqual([module.default.name,module.default.seen,new module.default().read()], ['default','default',2])
})

test('parameter properties retain parameter ownership, field definitions and every super path', () => {
  for (const mode of ['stateful-v1','protected-v1']) {
    assert.equal(run('enum Step{Start=2,Next};const box=new(class{constructor(public value:number){}})(Step.Next);return box.value', { mode }), 3)
    assert.deepEqual(run(`const events=[];class Base{set value(v){events.push(v)}}
      class C extends Base{constructor(public value:number,flag:boolean){if(flag)super();else return super()}}
      return [new C(3,true).value,new C(4,false).value,events];`, { mode }), [3,4,[]])
  }
  assert.deepEqual(run(`class C{constructor(public value=2){const value=value+1;this.next=value}}
    const c=new C();return [c.value,c.next,C.length];`), [2,3,0])
  assert.deepEqual(run('class C{constructor(public discarded:number){}constructor(public kept:number){}}return Object.keys(new C(3))'), ['kept'])
  assert.equal(run('class C{constructor(public value:number,public value:number){}}return new C(2,3).value'), 3)
})

test('legacy parameter decorators use TypeScript targets, source ordering and lexical owners', () => {
  assert.deepEqual(run(`const events=[];
    const parameter=label=>{events.push('evaluate '+label);return (target,key,index)=>events.push([label,typeof target,key,index])};
    const method=(target,key,descriptor)=>{events.push('method '+key);return descriptor};
    const klass=C=>{events.push('class '+C.name);return C};
    @klass class C{
      constructor(@parameter('constructor') public value:number){}
      @method run(@parameter('first') value:number,@parameter('last') next:number){return value+next}
      static run(@parameter('static') value:number){return value}
    }
    return [events,new C(3).value,new C(0).run(2,4),C.run(5)];`), [[
    'evaluate first', 'evaluate last', ['last','object','run',1], ['first','object','run',0], 'method run',
    'evaluate static', ['static','function','run',0], 'evaluate constructor', ['constructor','function',undefined,0], 'class C',
  ], 3,6,5])
  assert.deepEqual(run(`function example(){const seen=[];const d=(target,key,index)=>seen.push([key,index]);
    class C{run(@d d:number){return d}}return [seen,new C().run(4)]}return example()`), [[['run',0]],4])
  assert.deepEqual(run(`const Object=0,Reflect=0,Array=0,Function=0,undefined=0,__decorate=0,__param=0;const seen=[];
    const d=(target,key,index)=>seen.push(index);class C{constructor(@d public value:number){}}
    return [seen,new C(6).value,__decorate,__param];`), [[0],6,0,0])
  assert.deepEqual(run(`const seen=[];const d=(target,key,index)=>{seen.push(index);throw Error('parameter')};
    try{class C{run(@d value){}}seen.push('after')}catch(e){seen.push(e.message)}return seen;`), [0,'parameter'])
  assert.deepEqual(run(`const p=()=>{},d=(value,context)=>context.kind==='accessor'?{init:x=>x+1}:value;
    @d class Modern{@d m(){return 2}@d accessor value=3}
    class Legacy{constructor(@p value){}}
    return [new Modern().m(),new Modern().value];`), [2,4])
  const imported = compile('import {__param as userHelper} from "tslib";const p=()=>{};class C{constructor(@p value){}}')
  assert.match(imported.code, /import\s*\{\s*__param as userHelper\s*\}\s*from "tslib"/)
  assert.ok(!imported.internalBindings.has('userHelper'))
})

test('deferred legacy helpers retain native scopes after root compilation', async () => {
  const source = 'const p=()=>{};class Legacy{constructor(@p public value:number){}};return new Legacy(4).value'
  const normalized = compile(source, { deferDecorators: true })
  const root = compileStatefulRoot(normalized.code, { sourceMap: normalized.sourceMap,
    internalBindings: normalized.internalBindings, originalSource: source })
  const lowered = lowerStatefulDecorators({ ...root, deferredHelpers: normalized.deferredHelpers })
  const context = {}
  const runtime = createStatefulRootRuntime({ readAmbient: name => context[name] ?? globalThis[name] })
  context[root.rootRuntimeName] = runtime.begin({ ...root.rootPlan, committed() {} })
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.equal(await new AsyncFunction(lowered.code).call(context), 4)
  assert.equal(new (runtime.read('Legacy'))(5).value, 5)
  assert.ok(!root.declarations.some(declaration => normalized.internalBindings.has(declaration.name)))
})

test('legacy parameter decorators on class expressions preserve outer evaluation and native classes', () => {
  assert.deepEqual(run(`const events=[];
    const parameter=label=>{events.push('evaluate '+label);return (target,key,index)=>events.push([label,target.name??target.constructor.name,key,index])};
    const method=(target,key,descriptor)=>{events.push('method '+key);return descriptor};
    const klass=C=>{events.push('class '+C.name);return class extends C{extra=9}};
    const C=(@klass class {
      static seen=this.name;
      constructor(@parameter('constructor') value){this.value=value}
      @method run(@parameter('method') value){return value+this.value}
    });
    return [events,C.seen,new C(2).run(3),new C().extra];`), [[
    'evaluate method', ['method','C','run',0], 'method run',
    'evaluate constructor', ['constructor','C',undefined,0], 'class C',
  ], 'C',5,9])
  assert.deepEqual(run(`const seen=[];const Self=(target,key,index)=>seen.push(index);
    const C=class Self{constructor(@Self value){}self(){return Self}};
    return [seen,C.name,new C().self()===C];`), [[0],'Self',true])
  assert.deepEqual(run(`const events=[];class Base{static get parameter(){events.push('lookup');return (target,key,index)=>events.push(index)}}
    class Maker extends Base{static create(){return class{constructor(@super.parameter value){}}}}
    const C=Maker.create();return [events,C.name];`), [['lookup',0],''])
  assert.deepEqual(run(`const seen=[];const d=(target,key,index)=>seen.push([key,index]);
    const holder={create(){return class{constructor(@this.decorator value){}}},decorator:d};
    const C=holder.create();return [seen,new C() instanceof C,C.name];`), [[[undefined,0]],true,''])
  assert.deepEqual(run(`const seen=[];const d=(target,key,index)=>seen.push(index);
    let Assigned;Assigned=class{constructor(@d value){}};
    const {Fallback=class{constructor(@d value){}}}={};
    const object={Value:class{static seen=this.name;constructor(@d value){}}};
    return [seen,Assigned.name,Fallback.name,object.Value.name,object.Value.seen];`), [[0,0,0],'Assigned','Fallback','Value','Value'])
})

test('simple catch promotion and parameter defaults retain their separate owners', () => {
  assert.equal(run('return (()=>{try{throw 1}catch(process){{function process(){}}}return typeof process})()'), 'function')
  assert.equal(run('function f(value=process){{function process(){}}return typeof value}return f()'), 'object')
  assert.equal(run('function f(value=()=>process){{function process(){}}return value()}return f()===process'), true)
})

test('legacy class expressions retain outer async and generator evaluation', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const source = `const events=[],parameter=(target,key,index)=>events.push(['parameter',target.name,index]);
    const C=class extends(await Promise.resolve(class{})){
      static seen=this.name;constructor(@parameter value){super()}
    };
    class Base{static get decorator(){events.push(['receiver',this.name]);return parameter}}
    class Maker extends Base{static* create(){
      return class extends(yield 'heritage'){
        constructor(@super.decorator value){super()}
      }
    }}
    const iterator=Maker.create();
    const first=iterator.next();const next=iterator.next(class{});
    return [C.name,C.seen,first.value,typeof next.value,next.done,events];`
  assert.deepEqual(await new AsyncFunction(parseExecutableCell(compile(source).code, { eraseTypes: true }).code)(),
    ['C','C','heritage','function',true,[['parameter','C',0],['receiver','Maker'],['parameter','',0]]])
  assert.deepEqual(run(`const seen=[];
    function* create(){return class extends(yield class{}){
      constructor(@(arguments[0]) value){super()}
    }}
    const iterator=create((target,key,index)=>seen.push(index));iterator.next();
    return [typeof iterator.next(class{}).value,seen];`), ['function',[0]])
  assert.deepEqual(run(`const seen=[],parameter=(target,key,index)=>seen.push(index);
    const C=class extends((()=>class{})()){
      constructor(@parameter value){super()}
    };return [C.name,new C() instanceof C,seen];`), ['C',true,[0]])
})

test('legacy class expressions preserve once-coerced keys across delayed field initialization', () => {
  assert.deepEqual(run(`const seen=[],parameter=()=>{},classes=[];
    for(let i=0;i<2;i++)classes.push(class{
      [{[Symbol.toPrimitive](){seen.push(i);return Symbol.for('field'+i)}}]=class{
        static seen=this.name;constructor(@parameter value){}
      }
    });
    const result=classes.map((C,i)=>{const value=new C()[Symbol.for('field'+i)];return [value.name,value.seen]});
    return [seen,result];`), [[0,1],[['[field0]','[field0]'],['[field1]','[field1]']]])
  assert.deepEqual(run(`const seen=[],parameter=()=>{},key={
    [Symbol.toPrimitive](){seen.push('key');return Symbol.for('object')}
  };const object={[key]:class{static seen=this.name;constructor(@parameter value){}}};
    class Holder{[key]=class{static seen=this.name;constructor(@parameter value){}}}
    const value=new Holder()[Symbol.for('object')];
    return [seen,object[Symbol.for('object')].name,value.name,value.seen,Holder.name];`),
  [['key','key'],'[object]','[object]','[object]','Holder'])
})

test('decorated expression suspension preserves native microtasks and per-class field names', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('decorated-native-suspension', `const events=[],parameter=()=>{};
    const C=class extends(await Promise.resolve(class{})){
      static{queueMicrotask(()=>events.push('queued'))}
      constructor(@parameter value){super()}
    };
    events.push('after');await Promise.resolve();
    const classes=[];
    for(let i=0;i<2;i++)classes.push(class extends(await Promise.resolve(class{})){
      [{[Symbol.toPrimitive](){events.push(i);return Symbol.for('field'+i)}}]=class{
        static seen=this.name;constructor(@parameter value){}
      }
    });
    const fields=classes.map((Class,i)=>{const field=new Class()[Symbol.for('field'+i)];return [field.name,field.seen]});
    return [events,C.name,classes.map(Class=>Class.name),fields];`)
  assert.deepEqual(result.value, [['after','queued',0,1],'C',['',''],
    [['[field0]','[field0]'],['[field1]','[field1]']]], JSON.stringify(result.error))
})

test('suspended anonymous classes retain their computed inferred name while delayed fields retain keys', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const result = await state.run('suspended-computed-name', `
    const parameter=()=>{},key=Symbol.for('outer'),field=Symbol.for('inner');
    const holder={[key]:class extends(await Promise.resolve(class{})){
      [field]=class{constructor(@parameter value){}};
    }};
    return [holder[key].name,new holder[key]()[field].name];`)
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, ['[outer]', '[inner]'])
})

test('residual class forms run through the shared cell pipeline and persist', async t => {
  const { fixture } = await import('./plugin-fixture.js')
  const state = fixture({ bindingUpdates: 'stateful' })
  t.after(() => state.dispose())
  const first = await state.run('f100-residual', `const key=()=>'m',d=value=>()=>value()+10;
    class C{@d [key()](){return 1}@d [key()](){return 2}}
    const box=new(class{constructor(public value:number){}})(3);
    const events=[],parameter=(target,key,index)=>events.push(index);
    class Legacy{constructor(@parameter public value:number){}}
    const Anonymous=class{#x=1;#x=2;read(){return this.#x}};
    return [new C().m(),box.value,new Legacy(4).value,new Anonymous().read(),Anonymous.name,events]`)
  assert.deepEqual(first.value, [12,3,4,2,'Anonymous',[0]], JSON.stringify(first.error))
  const next = await state.run('f100-residual', 'return [new C().m(),box.value,new Legacy(5).value,Anonymous.name]')
  assert.deepEqual(next.value, [12,3,5,'Anonymous'], JSON.stringify(next.error))
})
