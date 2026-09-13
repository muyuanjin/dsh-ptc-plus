import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { JOURNAL_KEY } from '../internal/session-journal.js'
import { encodeValue } from '../internal/value-wire.js'
import { appendRunCodeEvents } from './plugin-fixture.js'

const modes = [
  ['stateful', { bindingUpdates: 'stateful' }],
  ['protected', { bindingUpdates: 'protected' }],
  ['legacy', { legacyBindingSettings: true }],
]

const memberOrder = `
  const events=[];
  Object.defineProperty(String.prototype,'memberRealmProbe',{configurable:true,
    get:function(){'use strict';events.push(['get',typeof this,this==='value']);
      return function(argument){'use strict';events.push(['invoke',typeof this,this==='value']);return argument}}
  });
  function receiver(){events.push('receiver');return 'value'}
  const key={[Symbol.toPrimitive](hint){events.push(['key',hint]);return 'memberRealmProbe'}};
  const result=receiver()[key]((events.push('argument'),7));
  const optional=receiver()[key]?.((events.push('optional-argument'),8));
  const absent=null;
  const skipped=absent?.[(events.push('skipped-key'),key)](events.push('skipped-argument'));
  const missing='value'.absentMember?.(events.push('missing-argument'));
  let nullError;
  try{absent[(events.push('null-key-expression'),key)](events.push('null-argument'))}
  catch(error){nullError=error instanceof TypeError}
  delete String.prototype.memberRealmProbe;
  return [result,optional,skipped===undefined,missing===undefined,nullError,events]
`

for (const bindingUpdates of ['stateful', 'protected']) test(`member getters and proxy traps retain source callers (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const program = `
    const observations=[];
    function getter(){observations.push(getter.caller===caller);return function(){return this===object}}
    const object={};Object.defineProperty(object,'method',{get:getter});
    const proxy=new Proxy(object,{get:function trap(target,key,receiver){observations.push(trap.caller===inspectProxy);return Reflect.get(target,key,receiver)}});
    function caller(){return object.method()};
    const direct=caller();
    function inspectProxy(){return proxy.method()};
    const proxied=inspectProxy();
    return [direct,proxied,observations]
  `
  const result = await runtime.run('member-caller', { bindings: [], program })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, Function(program)())
})

for (const bindingUpdates of ['stateful', 'protected']) test(`member receiver transport preserves reentrancy, suspension and primitive callers (${bindingUpdates})`, async t => {
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const result = await runtime.run('member-receiver', { bindings: [], program: `
    const a={id:1,method(){return this.id}},b={id:2,method(){return this.id}};
    let nested;function invoke(object,key){return object[key]()};
    const key={toString(){nested=invoke(b,'method');return 'method'}};
    const direct=invoke(a,key);
    function parameter(object,result=object.method()){return result}
    let resume;const pending=new Promise(resolve=>resume=resolve);
    async function suspended(object,key){return object[await key]()}
    const first=suspended(a,pending);const second=await suspended(b,Promise.resolve('method'));
    resume('method');const completed=await first;
    Object.defineProperty(String.prototype,'memberCallerProbe',{configurable:true,get:function getter(){
      const source=getter.caller===primitiveCaller;return function(){'use strict';return [source,this==='value']}}});
    function primitiveCaller(){return 'value'.memberCallerProbe()}
    let primitive;try{primitive=primitiveCaller()}finally{delete String.prototype.memberCallerProbe}
    class Private{get #method(){return function(){return this===instance}};read(){return this.#method()}}
    const instance=new Private();
    return [direct,nested,parameter(a),second,completed,primitive,instance.read()]
  ` })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [1,2,1,2,1,[true,true],true])
})

for (const [mode, configuration] of modes) {
  test(`${mode} primitive member calls retain their realm intrinsics and prototype extensions`, async t => {
    const runtime = new SessionRuntime({ ...configuration, durableReplay: false })
    t.after(() => runtime.dispose())
    const result = await runtime.run(`member-realm-${mode}`, { bindings: [], program: `
      const symbol=Symbol('value');
      const prototypes=[String.prototype,Number.prototype,Boolean.prototype,BigInt.prototype,Symbol.prototype];
      prototypes.forEach(prototype=>Object.defineProperty(prototype,'memberRealmProbe',{
        configurable:true,value:function(){'use strict';return typeof this}
      }));
      const methods=['value',2,true,3n,symbol].map(value=>value.memberRealmProbe());
      const boxed=Object('value');
      const array='a,b'.split(',');
      const direct=eval('"a,b".split(",") instanceof Array');
      const constructed=Function('return "a,b".split(",") instanceof Array')();
      const identities=['value'.constructor===String,(2).constructor===Number,
        true.constructor===Boolean,(3n).constructor===BigInt,symbol.constructor===Symbol,
        array instanceof Array,Object.getPrototypeOf(array)===Array.prototype,
        'value'.split===String.prototype.split,boxed.memberRealmProbe()==='object'];
      prototypes.forEach(prototype=>delete prototype.memberRealmProbe);
      return [methods,identities,direct,constructed]
    ` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [['string','number','boolean','bigint','symbol'],Array(9).fill(true),true,true])
  })

  test(`${mode} member calls preserve property coercion, receiver and optional argument ordering`, async t => {
    const runtime = new SessionRuntime({ ...configuration, durableReplay: false })
    t.after(() => runtime.dispose())
    const result = await runtime.run(`member-order-${mode}`, { program: memberOrder, bindings: [] })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, Function(memberOrder)())
  })

  test(`${mode} nullish member errors use the source TypeError constructor`, async t => {
    const runtime = new SessionRuntime({ ...configuration, durableReplay: false })
    t.after(() => runtime.dispose())
    const result = await runtime.run(`member-errors-${mode}`, { bindings: [], program: `
      const checks=[];
      for(const read of [()=>null.foo(),()=>undefined.foo(),()=>null.foo?.(),
        ()=>eval('null.foo()'),()=>Function('return undefined.foo()')()]){
        try{read()}catch(error){checks.push([error instanceof TypeError,Object.getPrototypeOf(error)===TypeError.prototype])}
      }
      return checks
    ` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, Array.from({ length: 5 }, () => [true,true]))
  })
}

test('member reads retain foreign object ownership and exact getter errors', () => {
  const context = createContext()
  const intrinsics = runInContext('({realmFunction:Function,intrinsicEval:eval,reflect:Reflect,object:Object,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError}})', context)
  const foreign = createContext()
  const foreignObject = runInContext(`({get method(){return function(){return [this===object]}}})`, foreign)
  foreign.object = foreignObject
  const foreignArray = runInContext('Array', foreign)
  const marker = runInContext('new TypeError("foreign getter")', foreign)
  const runtime = createDynamicEnvironmentRuntime(intrinsics).installIntrinsics()
  const root = runtime.environment()
  const result = root.beginInvocation(root.prepareMemberInvocation(foreignObject, foreignObject.method), [])()
  assert.equal(result[0], true)
  assert.ok(result instanceof foreignArray)
  assert.equal(result instanceof Array, false)
  const getter = { get method() { throw marker } }
  assert.throws(() => root.prepareMemberInvocation(getter, getter.method), error => error === marker)
})

test('valid v8 member-call replay retains its verified frontier and escaped native values', async t => {
  const session = { id: 'legacy-member-realm-replay', events: [] }
  const cells = [
    ['let kept=17;let fields="a,b".split(",");return fields instanceof Array', true],
    ['let read=()=>[kept,fields instanceof Array,fields.join("-")];return read()', [17,true,'a-b']],
  ]
  for (const [index, [source, value]] of cells.entries()) {
    appendRunCodeEvents(session.events, `member-replay-${index}`, source, { meta: { [JOURNAL_KEY]: {
      version: 8,
      bindingPolicy: { variableRedeclarations: true, functionClassRedeclarations: true },
      rewritePolicy: { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true },
      moduleSemantics: { defaultExportBinding: 'live-readonly', importExpressionBoundary: 'statement-safe' },
      userBindingsFingerprint: null, userBindingsReusePolicy: 'implementation-v1',
      userBindingsShadowPolicy: 'per-name', userBindingNames: [],
      status: 'durable', calls: [], operations: [], confirms: [], diagnostics: [],
      completion: { kind: 'return', hasValue: true, value: encodeValue(value) },
    } } })
  }
  const runtime = new SessionRuntime({ bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  const execution = await runtime.runTentative({ id: session.id, session, persistedCallSeq: session.events.length }, {
    program: 'return [kept,fields instanceof Array,read()]', bindings: [],
  })
  assert.equal(execution.result.error, undefined, execution.result.error?.message)
  assert.deepEqual(execution.result.value, [17,true,[17,true,'a-b']])
  assert.equal(execution.settlement.recoveryBoundaries, undefined)
  runtime.finalize(execution.settlement, true)
})
