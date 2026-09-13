import { loadManagedSource } from './managed-module-fixture.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { normalizeStatefulScopes, analyzeLogicalScopes } from '../internal/repl-scope-normalizer.js'
import { identitySourceMap, mapSourcePosition } from '../internal/source-position-map.js'
import { parseExecutableCell } from '../internal/cell-parser.js'

function compile(code, options) {
  return normalizeStatefulScopes(code, identitySourceMap(code.length), options)
}

function run(body, args = []) {
  const code = `function example() { ${body} } return example(...input)`
  return Function('input', compile(code).code)(args)
}

test('empty local patterns preserve initializer, coercion and iterator effects among updated bindings', () => {
  assert.deepEqual(run(`
    const effects=[];
    function* input(){try{effects.push('start');yield 1}finally{effects.push('close')}}
    const []=input(), {}=(effects.push('object'), {}), x=(effects.push('value'), 1);
    const x=x+1;
    for(let []=input(), {}={}, i=0;i<1;i++) effects.push(i);
    for(const [] of [input()]) effects.push('body');
    for(const {} in {key:1}) effects.push('key');
    return [x,effects];
  `), [2,['object','value',0,'body','key']])
  assert.deepEqual(run(`
    const effects=[];
    const input={ [Symbol.iterator](){effects.push('iterator');return {
      next(){effects.push('next');return {value:1,done:false}},
      return(){effects.push('return');return {done:true}}
    }}};
    const []=input, x=1;
    for(let []=input, i=0;i<1;i++) effects.push('body');
    return effects;
  `), ['iterator','return','iterator','return','body'])
  assert.deepEqual(run(`
    let later=false, failure;
    try { const {}=null, value=(later=true); } catch(error) { failure=error instanceof TypeError }
    return [failure,later];
  `), [true,false])
})

test('stateful local declarations share an identity while nested var retains its function owner', () => {
  assert.deepEqual(run(`
    const x = 1; const read = () => x;
    { const x = 10; var x = 2; x++; if (x !== 11) throw new Error('shadow'); }
    const x = x + 1; x++; const x; let x; var x;
    return [x, read()];
  `), [4, 4])
  assert.equal(run('const x; return x'), undefined)
  assert.throws(() => run('return x; const x = 1'), /before initialization/)
})

test('local declarators publish candidates atomically and keep real assignment effects', () => {
  assert.deepEqual(run(`
    let a = 1, b = 2, escaped;
    const old = () => a;
    try { const [a, b = (escaped = () => a, (() => { throw 1 })())] = [3, undefined]; } catch {}
    const before = [a, b, old(), escaped()];
    try { [a, b = (() => { throw 1 })()] = [4, undefined]; } catch {}
    return [...before, a, b];
  `), [1, 2, 1, 3, 4, 2])
  assert.deepEqual(run(`
    let a=1,b=2;
    try { const a=3,b=(()=>{throw 1})(); } catch {}
    return [a,b];
  `), [1, 2])
  assert.deepEqual(run(`
    let a=1,b=2;
    try { var a=3,b=(()=>{throw 1})(); } catch {}
    return [a,b];
  `), [3, 2])
})

test('candidate defaults see acquired values and candidate closures follow committed updates', () => {
  assert.equal(run('const [x,x=x+1]=[1,undefined];return x'), 2)
  assert.equal(run('let x=1; const [x=x+1]=[];return x'), 2)
  assert.equal(run('let x=1,f;const [x,f=()=>x]=[2,undefined]; x=9;return f()'), 9)
  assert.deepEqual(run('const {a:x,b:x=x+1,...rest}={a:1,c:4};return {x,rest}'), { x: 2, rest: { c: 4 } })
})

test('local parameters retain length, rest, defaults and mapped arguments', () => {
  assert.deepEqual(run(`
    function mapped(x) { const x=2; arguments[0]=3; return [x,arguments[0]]; }
    function defaults(x=1,x=x+1,...rest) { return [x,rest,defaults.length]; }
    function repeated(x,x) { x=8; return [x,arguments[0],arguments[1],repeated.length]; }
    return [mapped(1), defaults(undefined,undefined,4), repeated(1,2)];
  `), [[3, 3], [2, [4], 0], [8, 1, 8, 2]])
  assert.deepEqual(run('const f=({x},...rest)=>({x,rest});return f({x:1},2)'), { x: 1, rest: [2] })
})

test('catch and switch activations update only reached declarations', () => {
  assert.equal(run('try{throw {x:1}}catch({x}){const x=2;return x}'), 2)
  assert.equal(run('try{throw 1}catch(x){const x=2;return x}'), 2)
  assert.equal(run('try{throw 1}catch{} return 2'), 2)
  assert.deepEqual(run(`
    let result=[];
    switch(2){case 1:const x=1;throw 1;case 2:const x=2;result.push(()=>x);case 3:const x=3;result.push(x)}
    return [result[0](),result[1]];
  `), [3, 3])
})

test('loop lexical activations preserve closures and var writes retain their outer owner', () => {
  assert.deepEqual(run(`
    let readers=[];for(let i=0,i=0;i<3;i++){readers.push(()=>i)}
    for(const i of [4,5]) { readers.push(()=>i); }
    for(const k in {a:1,b:2}) { readers.push(()=>k); }
    return readers.map(f=>f());
  `), [0, 1, 2, 4, 5, 'a', 'b'])
  assert.deepEqual(run('let i=0;for(var i=1;i<2;i++){} return [i]'), [2])
  assert.deepEqual(run('let i=0;for(var i of [1,2]){}return [i]'), [2])
  assert.deepEqual(run('let readers=[];for(let i;;){i=1;readers.push(()=>i);break}return readers.map(f=>f())'), [1])
  assert.deepEqual(run('let values=[];for(let i=0,initial=()=>i;i<2;i++){i+=1;values.push(initial(),i)}return values'),[0,1])
})

test('function and class values retain calls, recursion, names, and separate self identities', () => {
  assert.deepEqual(run(`
    const before = current();
    function current(){return 1} function current(){return 2}
    const saved=current;function current(){return 3}
    const bare=function(){return this};
    class C { static self(){return C} }; const old=C; C=1;
    const recur=function fact(n){return n===0?1:n*fact(n-1)};
    return [before,saved(),current(),bare.call(null),bare.name,old.self()===old,recur(4)];
  `).slice(0, 3), [3, 3, 3])
  assert.deepEqual(run('const fn=()=>1; const fn=function replacement(){return 2};return [fn(),fn.name]'), [2, 'replacement'])
  assert.equal(run('let current=1; function current(){return 2} return current()'), 2)
  assert.deepEqual(run('const bare=function(){return this};const C=class {};const fn=()=>1;return [bare.name,C.name,fn.name]'),['bare','C','fn'])
  assert.equal(run('class C {static self(){return C}}const old=C;C=1;return old.self()===old'),true)
  assert.equal(run('const fn=function fact(n){return n===0?1:n*fact(n-1)};return fn(4)'),24)
  assert.equal(run('class C { static { const x=1;const x=2;this.x=x } }return C.x'),2)
  assert.deepEqual(run('function* g(x){const x=2;yield x}return [...g(1)]'),[2])
})

test('resource acquisition retains original resources and reverse disposal after name updates', () => {
  assert.deepEqual(run(`
    let events=[];
    { using resource={[Symbol.dispose](){events.push(1)}};
      using resource={[Symbol.dispose](){events.push(2)}};
      resource=0;events.push(resource); }
    return events;
  `), [0, 2, 1])
})

test('versioned policy preserves protected source and rejects malformed syntax', () => {
  const code='function f(){const x=1;x=2}'
  assert.equal(compile(code,{mode:'protected-v1'}).code, code)
  assert.throws(()=>compile(code,{mode:'unknown'}), /unsupported scope semantics/)
  assert.throws(()=>compile('function f(){const x=;}'), SyntaxError)
  assert.equal(compile('return 1').code,'return 1')
})

test('formal scope facts distinguish lexical shadows and retain original names and mappings', () => {
  const code='function f(){const x=1;{let x=2;var x=3}return x}'
  const facts=analyzeLogicalScopes(code)
  const groups=[...facts.scopes.values()].flatMap(scope=>[...scope.values()]).filter(group=>group.name==='x')
  assert.deepEqual(groups.map(group=>[group.scope.block.type,group.occurrences.length]), [['FunctionDeclaration',2],['BlockStatement',1]])
  const result=compile(code)
  const generated=result.code.lastIndexOf('.v')
  const prefix=result.code.slice(0,generated)
  const lines=prefix.split('\n')
  const mapped=mapSourcePosition({line:lines.length,column:lines.at(-1).length+1},result.code,code,result.sourceMap)
  assert.equal(mapped.line,1)
  assert.ok(mapped.column>=code.lastIndexOf('return'))
})

test('module and CommonJS activations preserve managed live exports and last explicit mappings', async t => {
  const load=code=>loadManagedSource(t,code)
  const namespace=await load(`
    import {basename} from 'node:path';
    export const value=1; export const value=value+1;
    export const filename=basename('/a/b');
    export function increment(){value++}
    const other=8;export {value as selected};export {other as selected};
    export default function entry(){return value}
  `)
  assert.equal(namespace.value,2)
  namespace.increment()
  assert.deepEqual([namespace.value,namespace.default(),namespace.selected,namespace.filename],[3,3,8,'b'])
  assert.equal((await load('export default (1,2);export default 3')).default,3)
  assert.equal((await load('export default function (x){return x}')).default(4),4)
  assert.equal((await load("export {basename as base} from 'node:path';export * from 'node:path';export const x=1")).base('/a/b'),'b')
  assert.deepEqual(Function('module','require',compile('const x=1;const x=2;module.exports={x}',{target:'commonjs'}).code+';return module.exports')({},createRequire(import.meta.url)),{x:2})
})

test('duplicate labels retain nearest jump targets and constructors select the last implementation',()=>{
  assert.equal(run('let x=0;outer:outer:for(;;){x=1;break outer}return x'),1)
  assert.equal(run('let x=0;outer:for(let i=0;i<2;i++){x++;continue outer}return x'),2)
  assert.equal(run('class C{constructor(){throw 1}constructor(){this.x=2}}return new C().x'),2)
})

test('private member plans retain every field effect and the final member shape',()=>{
  assert.deepEqual(run(`
    let effects=[];
    class C {
      #x=(effects.push('first'),1);
      #x(){return 'discarded'}
      #x=(effects.push('last'),2);
      get #y(){throw new Error('discarded')}
      get #y(){return this.#x}
      set #y(value){this.#x=value}
      read(){return [this.#x,this.#y]}
      write(value){this.#y=value}
    }
    const c=new C();c.write(5);return [effects,c.read()];
  `),[['first','last'],[5,5]])
  assert.deepEqual(run(`
    let effects=[];
    class C {static #x=(effects.push(1),1);static #x(){return this};static value(){return this.#x()}}
    return [effects,C.value()===C];
  `),[[1],true])
  assert.equal(run('const C=class {#x=1;#x=2;read(){return this.#x}};return new C().read()'),2)
  assert.equal(run('class C{#x=1;#x=2;read(){class D{#x=3;read(){return this.#x}}return new D().read()}}return new C().read()'),3)
})

test('cross-target private accesses select real brands with one receiver evaluation',()=>{
  assert.deepEqual(run(`
    let reads=0;
    class Base{constructor(value){return value}}
    class C extends Base{
      #x=1; static #x=2;
      static read(value){return (reads++,value).#x}
      static update(value){return (reads++,value).#x++}
      static has(value){return #x in (reads++,value)}
    }
    let instance=new C({});new C(C);
    const result=[C.read(C),C.read(instance),C.update(instance),C.read(instance),C.has({}),C.has(C)];
    let failed=false;try{C.read({})}catch(error){failed=error instanceof TypeError}
    return [result,reads,failed];
  `),[[2,1,1,2,false,true],7,true])
  assert.equal(run('class Base{constructor(x){return x}}class C extends Base{static #x=2;#x=1;static read(x){return x.#x}}new C(C);return C.read(C)'),1)
  assert.deepEqual(run('class C{#m(){}static #m(){}static read(o){return o.#m}}const a=C.read(new C()),b=C.read(C);Object.defineProperty(a,"name",{value:"custom"});return [C.read(new C()).name,b.name]'),['custom','#m'])
})

test('private calls preserve this, optional effects, tags and raw method values',()=>{
  assert.deepEqual(run(`
    let effects=0;
    class C{
      #method(){throw 1} #method(...args){return [this,args]}
      #empty=1;#empty=null;
      call(){return this.#method(3)}
      tag(){return this.#method\`value\`}
      raw(){return this.#method}
      optional(value){return [value?.#method(++effects),this.#empty?.(++effects)]}
    }
    const c=new C();const call=c.call();const tagged=c.tag();
    return [call[0]===c,call[1],tagged[0]===c,tagged[1][0][0],c.optional(null),effects,c.raw()===c.raw()];
  `),[true,[3],true,'value',[undefined,undefined],0,true])
  assert.throws(()=>compile('class C{#x=1;#x=2;remove(){delete this.#x}}'),SyntaxError)
})

test('enum and namespace runtime values enter the ordinary scope plan',async t=>{
  assert.deepEqual(run('enum E{A=1};enum E{B=2};const E=E;namespace N{export let a=E.A}namespace N{export let b=E.B}return [E.A,E.B,N.a,N.b]'),[1,2,1,2])
  const code='export enum E{A=1};export enum E{B=2};export namespace N{export const x=E.B}'
  const namespace=await loadManagedSource(t,code)
  assert.equal(namespace.E.A,1)
  assert.equal(namespace.E.B,2)
  assert.equal(namespace.N.x,2)
})

test('default-parameter closures follow the most recently initialized parameter identity',()=>{
  assert.deepEqual(run('function f(x=1,read=()=>x,x=2,y=read()){x=3;return [read(),y]}return f()'),[3,2])
  assert.deepEqual(run('function f(x=1,write=value=>x=value,x=2){write(3);return x}return f()'),3)
  assert.equal(run('function f(x=1,x=(()=>x+1)()){return x}return f()'),2)
})

test('await using keeps original async resources and reverse disposal order',async()=>{
  const code=`async function example(){let events=[];{await using x={[Symbol.asyncDispose]:async()=>{events.push(1)}};await using x={[Symbol.asyncDispose]:async()=>{events.push(2)}};x=0;events.push(x)}return events}return example()`
  assert.deepEqual(await Function(compile(code).code)(),[0,2,1])
})

test('an imported binding exported without a local write remains live through managed entry',async t=>{
  const source='export let value=1;export function increment(){value++}'
  const url=`data:text/javascript,${encodeURIComponent(source)}`
  await import(url)
  const code=`import {value,increment} from ${JSON.stringify(url)};export {value,increment};`
  const namespace=await loadManagedSource(t,code)
  assert.equal(namespace.value,1)
  namespace.increment()
  assert.equal(namespace.value,2)
})

test('erased type declarations and annotations cannot become runtime binding writes',()=>{
  const source=`function example(){type X=1;type X=2;interface Y{a:number}interface Y{b:number};declare const ambient:number;const X=3;const {x}:{x:number}={x:X};return x as number}return example()`
  const executable=parseExecutableCell(compile(source).code,{eraseTypes:true}).code
  assert.equal(Function(executable)(),3)
  assert.equal(Function(compile('export type X=1;export interface X{};export declare class C{}').code)(),undefined)
})

test('type-only imports disappear before runtime alias planning',async t=>{
  const code="import type {Fake} from 'missing-package';import {basename,type Another,type Last} from 'node:path';export const x=basename('/a/b')"
  const namespace=await loadManagedSource(t,code)
  assert.equal(namespace.x,'b')
})

test('program and function directives continue to govern native this and arguments',()=>{
  const source='"use strict";function f(a){return this};return f()'
  assert.equal(Function(compile(source).code)(),undefined)
  assert.deepEqual(run('function f(a){"use strict";a=2;return [this,arguments[0]]}return f(1)'),[undefined,1])
  assert.equal(run('class C{#m(){}#m(){}read(){return this.#m.name}}return new C().read()'),'#m')
})
