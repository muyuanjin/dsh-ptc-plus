import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { normalizeUserBindingEntry } from '../internal/user-bindings.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'

const typedClass = `class Box {
  constructor(public value:number=3){this.value+=2}
  read(){return this.value}
}`

for (const bindingUpdates of ['stateful', 'protected']) test(`const enum values share execution and reflected source (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const declarations = `
    const enum Choice { A=1 }; Choice.A=3;
    function local(){const enum Kind { A=1 };Kind.A=4;return Kind.A}
    namespace Space { const enum Kind { A=1 }; export function read(){Kind.A=5;return Kind.A} }
  `
  const inspect = `const copy=Function('return ('+local.toString()+')')();return [Choice.A,local(),copy(),Space.read()]`
  const cell = await runtime.run('const-enum', { bindings: [], program: declarations + inspect })
  assert.equal(cell.error, undefined, cell.error?.message)
  assert.deepEqual(cell.value, [3,4,4,5])
  const later = await runtime.run('const-enum', { bindings: [], program: 'Choice.A=6;return [Choice.A,local(),Space.read()]' })
  assert.equal(later.error, undefined, later.error?.message)
  assert.deepEqual(later.value, [6,4,5])
  const source = `${declarations};export {Choice,local,Space}`
  const module = await runtime.run('const-enum-module', { bindings: [], program:
    `const ns=await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(source)}`)});
     const copy=Function('return ('+ns.local.toString()+')')();return [ns.Choice.A,ns.local(),copy(),ns.Space.read()]` })
  assert.equal(module.error, undefined, module.error?.message)
  assert.deepEqual(module.value, [3,4,4,5])
})

for (const bindingUpdates of ['stateful','protected']) test(`decorator source reconstruction owns helpers and definition effects (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const declarations = `
    function ordinary(){const effects=[];const decorate=(value,context)=>{effects.push(context.name);return function(){return value.call(this)+1}};
      class Box{@decorate read(){return 3}};return [new Box().read(),effects]}
    const arrow=()=>{const decorate=value=>value;class Box{@decorate read(){return 5}}return new Box().read()};
    function parameters(decorate=value=>value,Box=class {@decorate read(){return 7}}){return new Box().read()}
    const object={method(){const decorate=value=>value;class Box{@decorate read(){return 9}}return new Box().read()}};
    const decorate=value=>value;
    class Value{@decorate read(){return 11}}
  `
  const inspect = `
    const copies=[ordinary,arrow,parameters].map(fn=>Function('return ('+fn.toString()+')')());
    const twice=copies.map(fn=>Function('return ('+fn.toString()+')')());
    const methodCopy=Function('return ({'+object.method.toString()+'})')();
    const methodOnly=Function('return ({'+Value.prototype.read.toString()+'})')();
    const Copy=Function('decorate','return ('+Value.toString()+')')(decorate);
    const Again=Function('decorate','return ('+Copy.toString()+')')(decorate);
    return [ordinary(),arrow(),parameters(),copies.map(fn=>fn()),twice.map(fn=>fn()),
      object.method(),methodCopy.method(),methodOnly.read(),new Copy().read(),new Again().read()];`
  const expected = [[4,['read']],5,7,[[4,['read']],5,7],[[4,['read']],5,7],9,9,11,11,11]
  const actual = await runtime.run('decorator-source', { program: declarations + inspect, bindings: [] })
  assert.equal(actual.error, undefined, actual.error?.message)
  assert.deepEqual(actual.value, expected)
  const moduleSource = `export function inspect(){${declarations}${inspect}}`
  const imported = await runtime.run('decorator-source-module', { bindings: [], program:
    `const source=await import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(moduleSource))});return source.inspect()` })
  assert.equal(imported.error, undefined, imported.error?.message)
  assert.deepEqual(imported.value, expected)
})

for (const bindingUpdates of ['stateful','protected']) test(`decorator helper lifetimes follow their cell frames (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const programs = [
    'const firstDecorator=value=>value;class First{@firstDecorator read(){return 1}};const saved=()=>new First().read();return saved()',
    'const failingDecorator=()=>{throw new Error("decoration")};class Failed{@failingDecorator read(){return 2}}',
    'const lastDecorator=value=>value;class Last{@lastDecorator read(){return 3}};return [saved(),new Last().read()]',
  ]
  const first = await runtime.run('decorator-frames', { program: programs[0], bindings: [] })
  assert.equal(first.error, undefined, first.error?.message)
  assert.equal(first.value, 1)
  const failed = await runtime.run('decorator-frames', { program: programs[1], bindings: [] })
  assert.match(failed.error?.message ?? '', /decoration/)
  const last = await runtime.run('decorator-frames', { program: programs[2], bindings: [] })
  assert.equal(last.error, undefined, last.error?.message)
  assert.deepEqual(last.value, [1,3])
})

for (const bindingUpdates of ['stateful','protected']) test(`decorated parameter classes retain their own initialization state (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const source = `
    const events=[];
    function decorate(n){return (value,context)=>{context.addInitializer(function(){this.n=n});return value}}
    function create(n,C=class {@decorate(n) read(){return this.n}}){return C}
    const A=create(1),B=create(2);
    function keyed(n,key={toString(){events.push(n);return 'actual'}},object={
      [key]:class {@decorate(n) read(){return this.n}},
      __proto__:class {@decorate(n) read(){return this.n}}
    }){return object}
    const a=keyed(3),b=keyed(4);
    function named(n,C=class Named{@decorate(n) read(){return [this.n,Named.name]}}){return C}
    const NamedA=named(5),NamedB=named(6);
    return [new A().read(),new B().read(),A.name,B.name,
      new a.actual().read(),new b.actual().read(),a.actual.name,b.actual.name,
      Object.getPrototypeOf(a).name,events,new NamedA().read(),new NamedB().read()];`
  const expected = [1,2,'C','C',3,4,'actual','actual','',[3,4],[5,'Named'],[6,'Named']]
  for (const [entry, program] of [['cell', source], ['module',
    `const ns=await import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(`export function inspect(){${source}}`))});return ns.inspect()`]]) {
    const result = await runtime.run(`parameter-class-${entry}`, { bindings: [], program })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, expected)
  }
})

test('suspended class source reconstruction retains its native compilation context', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runtime.run('suspended-class-source', { bindings: [], program: `
    const parameter=()=>{};
    const Original=class extends(await Promise.resolve(class{})){constructor(@parameter value){super();this.value=value}};
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    const Copy=await AsyncFunction('parameter','return ('+Original.toString()+')')(parameter);
    function* create(parameter){return class extends(yield this.Base){constructor(@(arguments[0]) value){super();this.value=value}}}
    const original=create.call({Base:class{}},parameter);const base=original.next().value;const Generated=original.next(base).value;
    const GeneratorFunction=Object.getPrototypeOf(function*(){}).constructor;
    const restored=GeneratorFunction('parameter','return ('+Generated.toString()+')').call({Base:base},parameter);
    const inherited=restored.next().value;const Restored=restored.next(inherited).value;
    return [new Original(1).value,new Copy(2).value,new Generated(3).value,new Restored(4).value];
  ` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [1,2,3,4])
})

for (const bindingUpdates of ['stateful','protected']) test(`reflected sources retain creation context and nested callable provenance (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const source = `
    function names(C=class{static nameSeen=this.name;@((v)=>v) read(){return 1}}){return [C.name,C.nameSeen]}
    const namesCopy=Function('return ('+names.toString()+')')();
    function make(d=v=>v,build=()=>{class Other{@d read(){return 2}};return class{@d read(){return 3}}}){return build()}
    const makeCopy=Function('return ('+make.toString()+')')();const Returned=makeCopy();
    const Again=Function('d','return ('+Returned.toString()+')')(v=>v);
    class Outer{#value=4;read(){class Inner{@((v)=>v) read(owner){return owner.#value}}return new Inner().read(this)}}
    const OuterCopy=Function('return ('+Outer.toString()+')')();
    class Base{read(){return 5}}
    class Child extends Base{read(){const fn=()=>{class Inner{@((v)=>v) read(){}};return super.read()};return fn()}}
    const ChildCopy=Function('Base','return ('+Child.toString()+')')(Base);
    function sloppy(){with({value:6}){return (value as number)}}
    const sloppyCopy=Function('return ('+sloppy.toString()+')')();
    return [names(),namesCopy(),new Returned().read(),new Again().read(),
      new Outer().read(),new OuterCopy().read(),new Child().read(),new ChildCopy().read(),sloppyCopy()];`
  const expected = [['C','C'],['C','C'],3,3,4,4,5,5,6]
  const result = await runtime.run('source-context', { bindings: [], program: source })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, expected)
  // Native modules are strict, so the independent sloppy function case is cell-only.
  const moduleSource = source.replace('function sloppy(){with({value:6}){return (value as number)}}', 'function sloppy(){return 6}')
  const imported = await runtime.run('source-context-module', { bindings: [], program:
    `const ns=await import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(`export function inspect(){${moduleSource}}`))});return ns.inspect()` })
  assert.equal(imported.error, undefined, imported.error?.message)
  assert.deepEqual(imported.value, expected)
})

for (const bindingUpdates of ['stateful','protected']) test(`parameter properties preserve decorator expression boundaries (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const source = `const events=[];const owner={decorate(value,context){events.push(context.name);return value}};
    const decorate=owner.decorate;class Box{constructor(public value:number){}@decorate read(){return this.value}}
    class Other{constructor(public value:number){}@owner.decorate read(){return this.value}}
    return [new Box(3).read(),new Other(4).read(),events]`
  for (const [entry,program] of [['cell',source],['module',
    `const ns=await import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(`export function inspect(){${source}}`))});return ns.inspect()`]]) {
    const result = await runtime.run(`typed-decorators-${entry}`,{bindings:[],program})
    assert.equal(result.error,undefined,result.error?.message)
    assert.deepEqual(result.value,[3,4,['read','read']])
  }
})

test('parameter-property class reflection preserves the class and executable initialization', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  for (const [entry, declaration] of [
    ['root', typedClass],
    ['module', `const mod=await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(typedClass + ';export {Box}'))});const Box=mod.Box`],
  ]) {
    const result = await runtime.run(`typed-source-${entry}`, { bindings: [], program: `
      ${declaration};
      const source=Box.toString();
      const Copy=Function('return ('+source+')')();
      const original=new Box(),copy=new Copy(),explicit=new Copy(7);
      return [source.startsWith('class Box'),Box.prototype.constructor===Box,
        Box.prototype.constructor.toString()===source,original.read(),copy.read(),explicit.read(),
        Object.keys(original),Object.keys(copy)]
    ` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [true,true,true,5,5,9,['value'],['value']], entry)
  }
})

test('reflected derived parameter properties keep super ordering and real source dependencies', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runtime.run('typed-derived-source', { bindings: [], program: `
    class Parent{constructor(){this.target=new.target.name}}
    class Child extends Parent{constructor(public value:number=4){super();this.value++}}
    const source=Child.toString();
    const Copy=Function('Parent','return ('+source+')')(Parent);
    const original=new Child(),copy=new Copy();
    return [original.value,copy.value,original.target,copy.target,source.startsWith('class Child')]
  ` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [5,5,'Child','Child',true])
})

test('reflected TypeScript callable bodies lower runtime constructs to executable JavaScript', async t => {
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runtime.run('typed-callable-source', { bindings: [], program: `
    function ordinary(){enum Choice{Value=11};return Choice.Value}
    const arrow=()=>{class Box{constructor(public value:number=12){}};return new Box().value};
    const object={method(){enum Choice{Value=13};return Choice.Value}};
    const methods=object.method.toString();
    const copies=[ordinary,arrow].map(fn=>Function('return ('+fn.toString()+')')());
    const methodCopy=Function('return ({'+methods+'})')();
    return [ordinary(),arrow(),object.method(),copies[0](),copies[1](),methodCopy.method()]
  ` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [11,12,13,11,12,13])
})

test('typed callable ownership survives final module emission and binding validation', async t => {
  const declarations = `let count=0;
    function next():number{return ++count}
    function identity<T>(value:T):T{return value}
    function pair({value}:{value:number}):[number]{return [value]}`
  const source = declarations + ';export {next,identity,pair}'
  const entry = normalizeUserBindingEntry({ id: 'typed', name: 'typed', scope: 'namespace', enabled: true, source })
  assert.match(entry.declaration, /next\(\): number/)
  assert.match(entry.declaration, /identity<T>\(value: T\): T/)
  assert.equal(entry.durability, 'durable')
  assert.doesNotThrow(() => compileStatefulModule(declarations + ';module.exports={next,identity,pair}', { target: 'commonjs' }))
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful', durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runtime.run('typed-module-source', { bindings: [], program: `
    const typed=await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(source))});
    const identity=Function('return ('+typed.identity.toString()+')')();
    const pair=Function('return ('+typed.pair.toString()+')')();
    return [typed.next(),typed.next(),identity(17),pair({value:18})]
  ` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [1,2,17,[18]])
})
