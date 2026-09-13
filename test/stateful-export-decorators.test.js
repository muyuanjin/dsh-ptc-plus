import assert from 'node:assert/strict'
import test from 'node:test'
import { loadManagedSource } from './managed-module-fixture.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { normalizeStatefulScopes } from '../internal/repl-scope-normalizer.js'
import { LEGACY_USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { createUserBindingsSnapshot, normalizeUserBindingEntry, userBindingsDeclaration } from '../internal/user-bindings.js'
import { fixture } from './plugin-fixture.js'
import { PROTECTED_MODULE_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/module-transform-contract.js'

const decoration = `
  const effects=[];
  function decorate(value, context){effects.push(context.name);return value}
`
const body = '{ @decorate method(){return 42} }'

test('decorated anonymous classes infer arbitrary property names and preserve prototype setters', () => {
  const source = `function example(){
    const names=[]; function d(value,context){names.push(context.name);return value}
    const value={default:@d class {}, 'not identifier':@d class {}, __proto__:@d class {}};
    return [value.default.name,value['not identifier'].name,Object.getPrototypeOf(value).name,
      Object.hasOwn(value,'__proto__'),names];
  };return example()`
  assert.deepEqual(Function(normalizeStatefulScopes(source).code)(),
    ['default','not identifier','',false,['default','not identifier','']])
  const wrapped=source.replace('default:@d class {}','default:((@d class {}) as unknown)')
  assert.deepEqual(Function(normalizeStatefulScopes(wrapped).code)(),
    ['default','not identifier','',false,['default','not identifier','']])
  const members=`function example(){
    const names=[]; function d(value,context){names.push(context.name);return value}
    const value={default:class { @d method(){return 42} }};
    return [value.default.name,new value.default().method(),names];
  };return example()`
  assert.deepEqual(Function(normalizeStatefulScopes(members).code)(),['default',42,['method']])
})

test('class definition names follow source value positions through transparent type wrappers', () => {
  const contexts = [
    ['variable', value => `const C=${value};return C`],
    ['assignment', value => `let C;C=${value};return C`],
    ['parameter', value => `function read(C=${value}){return C};return read()`],
    ['property', value => `return {default:${value}}.default`],
    ['computed property', value => `return {[Symbol.for('key')]:${value}}[Symbol.for('key')]`],
    ['prototype setter', value => `return Object.getPrototypeOf({__proto__:${value}})`],
    ['field', value => `class Holder{C=${value}};return new Holder().C`],
    ['private field', value => `class Holder{#C=${value};read(){return this.#C}};return new Holder().read()`],
    ['computed field', value => `class Holder{[Symbol.for('key')]=${value}};return new Holder()[Symbol.for('key')]`],
    ['key expression', value => `return Object.keys({[${value}]:0})`],
  ]
  const wrappers = [value => `(${value})`, value => `(${value} as unknown)`,
    value => `(${value} satisfies unknown)`, value => `(${value}!)`, value => `(<unknown>${value})`,
    value => `(((${value} as unknown)!) satisfies unknown)`]
  const body = `class {static seen=this.name;static contextName=this.name;
    static [Symbol.toPrimitive](){return this.name||'empty'}}`
  const observe = build => `function build(){${build}};const value=build();
    return typeof value==='function'?[value.name,value.seen,value.contextName]:value`
  for (const [label, context] of contexts) {
    const expected = Function(observe(context(body)))()
    for (const wrap of wrappers) {
      const source = `function d(value,context){value.contextName=context.name;return value};`
        + observe(context(wrap('@d '+body)))
      assert.deepEqual(Function(normalizeStatefulScopes(source).code)(), expected, label+': '+wrap('class'))
    }
  }
  const source = `const Holder=class {accessor C=((@((value)=>value) class {}) as unknown)};
    return new Holder().C.name`
  assert.equal(Function(normalizeStatefulScopes(source).code)(), 'C')
})

test('wrapped definition keys retain per-class state through cells, modules and callable reconstruction', async t => {
  const build = wrapped => `function build(key, Holder=class {
    [key]=${wrapped ? '((@((value)=>value) class {}) as unknown)' : 'class {}'};
    static [key]=${wrapped ? '((@((value)=>value) class {}) satisfies unknown)' : 'class {}'};
  }){return Holder}`
  const observe = `const effects=[];const key=name=>({[Symbol.toPrimitive](){effects.push(name);return name}});
    const A=build(key('a')),B=build(key('b'));
    return [new A().a.name,new B().b.name,new A().a.name,A.a.name,B.b.name,effects]`
  const expected = Function(build(false)+';'+observe)()
  assert.deepEqual(expected, ['a','b','a','a','b',['a','a','b','b']])
  for (const bindingUpdates of ['stateful','protected']) {
    const state = fixture({bindingUpdates})
    t.after(() => state.dispose())
    const source = build(true)+';'+observe
    const direct = await state.run('wrapped-definition-direct', source)
    assert.equal(direct.error, undefined, direct.error?.message)
    assert.deepEqual(direct.value, expected)
    const detached = await state.run('wrapped-definition-detached', build(true).replace('build(', 'original(')
      + `;const build=Function('return ('+original.toString()+')')();`+observe)
    assert.equal(detached.error, undefined, detached.error?.message)
    assert.deepEqual(detached.value, expected)
    const module = await loadManagedSource(t, 'export function run(){'+source+'}', {
      transform: bindingUpdates === 'protected' ? PROTECTED_MODULE_TRANSFORM : USER_BINDING_TRANSFORM,
    })
    assert.deepEqual(module.run(), expected)
  }
})

test('decorator reference parentheses retain member receivers in both cell policies', async t => {
  for (const bindingUpdates of ['stateful','protected']) {
    const state = fixture({bindingUpdates})
    t.after(() => state.dispose())
    const result = await state.run('decorator-receiver', `
      const effects=[];
      const owner={decorate(value,context){effects.push([this===owner,context.name]);return value}};
      @owner.decorate class C { @owner.decorate method(){return 42} }
      return [new C().method(),effects];
    `)
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value,[42,[[true,'method'],[true,'C']]])
  }
})

test('computed decorator references and factories evaluate once with their source receiver', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    const state = fixture({ bindingUpdates })
    t.after(() => state.dispose())
    const result = await state.run('decorator-reference-effects', `
      const observations={keys:0,gets:0,factory:false,receiver:false,names:[]};
      const owner={
        get decorate(){observations.gets++;return function(value,context){
          observations.receiver=this===owner;observations.names.push(context.name);return value
        }},
        factory(){observations.factory=this===owner;return (value,context)=>{
          observations.names.push(context.name);return value
        }}
      };
      function key(){observations.keys++;return 'decorate'}
      @(owner[key()]) class C { @owner.factory() method(){return 42} }
      return [new C().method(),observations];
    `)
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [42, { keys: 1, gets: 1, factory: true, receiver: true, names: ['method', 'C'] }])
  }
})

test('cell export modifiers preserve either decorator placement and default identity', async t => {
  for (const bindingUpdates of ['stateful', 'protected']) {
    for (const declaration of ['@decorate /* export */ export class C',
      'export @decorate class C', '@decorate export /* default */ default abstract class C',
      'export default @decorate class C']) {
      const state = fixture({ bindingUpdates })
      t.after(() => state.dispose())
      const result = await state.run('decorated-export', decoration+declaration+body+
        `; return [C.name,new C().method(),effects${declaration.includes('default') ? ',__default===C' : ''}];`)
      assert.equal(result.error, undefined, `${bindingUpdates}: ${declaration}: ${result.error?.message}`)
      assert.deepEqual(result.value, ['C',42,['method','C'], ...(declaration.includes('default') ? [true] : [])])
    }
  }
})

test('module export modifiers retain decorator effects and native class names', async t => {
  for (const declaration of ['@decorate /* export */ export class C',
    'export @decorate class C', '@decorate export /* default */ default abstract class C',
    'export default @decorate class C', '@decorate export default class']) {
    const source = decoration+declaration+body+'; export {effects};'
    const namespace = await loadManagedSource(t, source)
    const value = namespace.default ?? namespace.C
    assert.equal(new value().method(), 42)
    assert.equal(value.name, declaration.endsWith(' C') ? 'C' : 'default')
    assert.deepEqual(namespace.effects, ['method', value.name])
  }
})

test('global binding metadata and activation share current decorator grammar', async t => {
  for (const declaration of ['@decorate export class C', 'export @decorate class C']) {
    const source = decoration+declaration+body+'; export {effects};'
    const entry = {id:'decorated', name:'decorated', scope:'namespace', source, enabled:true, purpose:''}
    const normalized = normalizeUserBindingEntry(entry)
    const bindings = createUserBindingsSnapshot({ entries:[entry] }, 1)
    assert.match(userBindingsDeclaration(bindings), /C: \{ new\(.*method\(\): unknown/)
    assert.equal(normalized.source, source)
    assert.throws(() => normalizeUserBindingEntry(entry, { transform:LEGACY_USER_BINDING_TRANSFORM }), /decorator|parsed/i)
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    const result = await runtime.run('decorated-binding', {
      program:'return [new decorated.C().method(),decorated.effects]', bindings:[], userBindings:bindings,
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [42,['method','C']])
  }
})
