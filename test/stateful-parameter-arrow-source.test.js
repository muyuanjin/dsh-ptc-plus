import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createDynamicEnvironmentRuntime } from '../internal/dynamic-environment-runtime.js'
import { SessionRuntime } from '../internal/session-runtime.js'

const originals = ['(a=eval("1974"))=>a', 'async (a=eval("1975"))=>a']

async function worker(t, bindingUpdates = 'stateful', files = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-parameter-arrow-source-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all(Object.entries(files).map(([name, source]) => writeFile(join(directory, name), source)))
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const session = { id: 'parameter-arrow-source', session: { header: { cwd: directory } } }
  return async program => {
    const result = await runtime.run(session, { bindings: [], program })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
}

const inspect = `async function inspect(fn){
  const texts=[fn.toString(),Function.prototype.toString.call(fn),
    Reflect.apply(Function.prototype.toString,fn,[]),[0].map(Function.prototype.toString.bind(fn))[0]];
  const copy=Function('return ('+texts[0]+')')();
  return [texts,await fn(),await copy(),fn.length,Object.hasOwn(fn,'prototype')]
}`
const expected = originals.map((source, index) => [[source,source,source,source],1974+index,1974+index,0,false])

for (const bindingUpdates of ['stateful','protected']) test(`computed parameter arrow names retain key effects and sources (${bindingUpdates})`, async t => {
  const run = await worker(t, bindingUpdates)
  const body = `const effects=[];
    const symbol=Symbol('actual');
    const key={[Symbol.toPrimitive](hint){effects.push(hint);return symbol}};
    const object={[key]:(value=eval('7'))=>value,
      __proto__:(value=eval('8'))=>value,['__proto__']:(value=eval('9'))=>value};
    const fn=object[symbol],saved=fn,descriptor=Object.getOwnPropertyDescriptor(fn,'name');
    const text=fn.toString(),copy=Function('return ('+text+')')();
    function create(first=eval('10'),holder={['nested']:(next=eval('first'))=>next}){return holder}
    const nested=create();
    return [fn.name,fn.length,fn(),copy(),descriptor.value,descriptor.writable,descriptor.enumerable,
      descriptor.configurable,effects,fn===saved,Object.getPrototypeOf(object).name,object.__proto__.name,
      nested.nested.name,nested.nested(),text];`
  const expected = ['[actual]',0,7,7,'[actual]',false,false,true,['string'],true,'','__proto__','nested',10,"(value=eval('7'))=>value"]
  for (const source of [body, `return eval(${JSON.stringify(`(()=>{${body}})()`)});`,
    `return Function(${JSON.stringify(body)})();`,
    `const module=await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(`export function inspect(){${body}}`))});return module.inspect();`]) {
    assert.deepEqual(await run(source), expected)
  }
})

for (const bindingUpdates of ['stateful','protected']) {
  test(`parameter arrow source round trips across cells, eval and Function (${bindingUpdates})`, async t => {
    const run = await worker(t, bindingUpdates)
    const expression = `[${originals.join(',')}]`
    await run(`${inspect};const local=${expression};
      const dynamic=eval(${JSON.stringify(expression)});
      const constructed=Function(${JSON.stringify('return '+expression)})();
      const retained=local.slice();void 0`)
    assert.deepEqual(await run('return await Promise.all([local,dynamic,constructed].map(group=>Promise.all(group.map(inspect))))'),
      [expected,expected,expected])
    assert.deepEqual(await run('return [retained.every((fn,index)=>fn===local[index]),await inspect(local[1])]'), [true,expected[1]])
  })
}

for (const extension of ['mjs','cjs']) {
  test(`parameter arrows retain sources across ${extension} and owned realm observers`, async t => {
    const finish = extension === 'mjs' ? 'export {arrows,inspect}' : 'module.exports={arrows,inspect}'
    const run = await worker(t, 'stateful', {
      [`source.${extension}`]: `const arrows=[${originals.join(',')}];${inspect};${finish}`,
    })
    const load = extension === 'mjs' ? 'await import("./source.mjs")' : 'require("./source.cjs")'
    await run(`${inspect};const source=${load};const saved=source.arrows.slice();void 0`)
    assert.deepEqual(await run(`return [await Promise.all(source.arrows.map(source.inspect)),
      await Promise.all(source.arrows.map(inspect)),saved.every((fn,index)=>fn===source.arrows[index])]`),
    [expected,expected,true])
  })
}

test('parameter arrow source adapters retain per-invocation environments and native proxy boundaries', async t => {
  const run = await worker(t)
  const original = '(a=eval("1"),read=eval("()=>a"))=>[value=>a=value,read]'
  assert.deepEqual(await run(`const make=${original};const first=make();const second=make();
    const initial=first[1]();first[0](4);
    const copy=Function('return ('+make.toString()+')')();
    const restored=copy();
    const same=make;const source=Function.prototype.toString;
    const proxy=new Proxy(make,{get(){throw new Error('unexpected get')}});
    const revoked=Proxy.revocable(make,{});revoked.revoke();
    const nativeText='function () { [native code] }';
    let invalid=false;try{Reflect.apply(source,{},[])}catch(error){invalid=error instanceof TypeError}
    let construct=false;try{new make()}catch(error){construct=error instanceof TypeError}
    make.toString=()=> 'custom source';
    return [initial,first[1](),second[1](),restored[1](),make===same,make.name,make.length,
      source.call(proxy)===nativeText,source.call(revoked.proxy)===nativeText,invalid,construct,
      make.toString(),source.call(make)]`),
  [1,4,1,1,true,'make',0,true,true,true,true,'custom source',original])
})

function realm() {
  const context = createContext({})
  const native = source => runInContext(source, context)
  const intrinsics = native('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})')
  const runtime = createDynamicEnvironmentRuntime(intrinsics).installIntrinsics()
  return { runtime, native, environment: runtime.environment(),
    observe: runtime.exposedIntrinsic(native('Function.prototype.toString')) }
}

test('compiler-owned adapter source targets resolve late facts across owned realms', () => {
  const first = realm()
  const second = realm()
  const target = first.native('(key,value=1984)=>value')
  const nativeSource = first.native('Function.prototype.toString').call(target)
  const adapter = first.environment.parameterArrow(target, 'retained')
  assert.equal(second.observe.call(adapter), nativeSource)
  const original = '(value=eval("1984"))=>value'
  second.runtime.registerSources([[nativeSource,original]])
  assert.equal(first.observe.call(adapter), original)
  assert.equal(second.observe.call(adapter), original)
  assert.equal(adapter(), 1984)
  assert.equal(adapter.name, 'retained')
  assert.equal(adapter.length, 0)
  assert.equal(first.native('Function.prototype.toString').call(adapter), 'function () { [native code] }')
})
