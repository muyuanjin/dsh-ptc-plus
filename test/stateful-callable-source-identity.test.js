import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { mapSourceSpan } from '../internal/source-position-map.js'

const traverse = traverseModule.default ?? traverseModule
const originals = ['() => 1801', '()=>1801', 'method () { return 1802 }', 'method(){return 1802}',
  'class { read () { return 1803 } }', 'class{read(){return 1803}}']

async function worker(t, files, bindingUpdates = 'stateful') {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-callable-source-identity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all(Object.entries(files).map(([name, source]) => writeFile(join(directory, name), source)))
  const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
  t.after(() => runtime.dispose())
  const session = { id: 'callable-source-identity', session: { header: { cwd: directory } } }
  return async program => {
    const result = await runtime.run(session, { bindings: [], program })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  }
}

for (const extension of ['mjs','cjs']) for (const reverse of [false,true]) {
  test(`callable sources remain distinct across ${extension} modules and load order (reverse=${reverse})`, async t => {
    const finish = names => extension === 'mjs' ? `export {${names}}` : `module.exports={${names}}`
    const source = `const a=${originals[0]};const b=${originals[1]};
const first={${originals[2]}};const second={${originals[3]}};
const First=${originals[4]};const Second=${originals[5]};
const values=[a,b,first.method,second.method,First,Second];
function read(){return values.map(value=>value.toString())}
function check(){return [a(),b(),first.method(),second.method(),new First().read(),new Second().read(),
  a===values[0],First.prototype.constructor===First]}
${finish('values,read,check')}`
    const other = '() /* other source */=>1801'
    const run = await worker(t, { [`source.${extension}`]: source,
      [`other.${extension}`]: `const a=${other};function read(){return a.toString()};${finish('a,read')}` })
    const load = name => extension === 'mjs' ? `await import('./${name}.mjs')` : `require('./${name}.cjs')`
    if (reverse) await run(`const other=${load('other')}`)
    assert.deepEqual(await run(`const main=${load('source')}; const retained=main.values.slice();return main.read()`), originals)
    if (!reverse) await run(`const other=${load('other')}`)
    assert.deepEqual(await run('return [main.read(),other.read(),main.check(),retained.every((value,index)=>value===main.values[index])]'),
      [originals,other,[1801,1801,1802,1802,1803,1803,true,true],true])
  })
}

for (const bindingUpdates of ['stateful','protected']) test(`cyclic ESM hoisted exports publish distinct source identities before evaluation (${bindingUpdates})`, async t => {
  const first = 'function same () { return 1811 }'
  const second = 'function same(){return 1811}'
  const run = await worker(t, {
    'first.mjs': `import {before,same as other} from './second.mjs';export ${first};export {before,other}`,
    'second.mjs': `import {same as first} from './first.mjs';export ${second};export const before=[first.toString(),same.toString()]`,
  }, bindingUpdates)
  assert.deepEqual(await run('const module=await import("./first.mjs");return [module.before,module.same.toString(),module.other.toString(),module.same(),module.other()]'),
    [[first,second],first,second,1811,1811])
})

test('native anonymous defaults retain source identity without a dynamic factory dependency', async t => {
  const first = 'function () { return 1821 }'
  const second = 'function(){return 1821}'
  const runtime = new URL('../internal/dynamic-environment-runtime.js', import.meta.url).href
  const literal = `function(){return ${JSON.stringify(runtime)}}`
  const run = await worker(t, {
    'first.mjs': `export default ${first}`,
    'second.mjs': `export default ${second}`,
    'literal.mjs': `export default ${literal}`,
  })
  assert.deepEqual(await run(`const first=await import('./first.mjs');const second=await import('./second.mjs');
    const literal=await import('./literal.mjs');
    return [first.default.toString(),second.default.toString(),first.default(),second.default(),
      first.default.name,first.default===(await import('./first.mjs')).default,
      literal.default(),literal.default.toString()]`),
  [first,second,1821,1821,'default',true,runtime,literal])
})

test('root, local and dynamic functions retain their own source identities', async t => {
  const run = await worker(t, {})
  const program = `const a=${originals[0]};const b=${originals[1]};
function local(){const a=${originals[0]};const b=${originals[1]};return [a.toString(),b.toString()]}
const dynamic=eval(${JSON.stringify(`const a=${originals[0]};const b=${originals[1]};[a.toString(),b.toString()]`)});
return [[a.toString(),b.toString()],local(),dynamic]`
  assert.deepEqual(await run(program), [originals.slice(0,2),originals.slice(0,2),originals.slice(0,2)])
})

const staticMethodSource = `class C{
  static["m"](){let value=7;return value}
  static/* modifier trivia */get["value"](){return 8}
  static/* generator */*["items"](){yield 9}
  static/* async */async["promise"](){return 10}
  static/* async generator */async*["stream"](){yield 11}
  ["static"](){return 12}
}
const methods=[C.m,Object.getOwnPropertyDescriptor(C,'value').get,C.items,C.promise,C.stream,C.prototype.static];
const sources=methods.map(method=>method.toString());
const copies=sources.map(source=>Function('return ({'+source+'})')());
return [sources,[copies[0].m(),copies[1].value,copies[2].items().next().value,
  await copies[3].promise(),(await copies[4].stream().next()).value,copies[5].static()]]`

for (const bindingUpdates of ['stateful', 'protected']) {
  test(`TypeScript modifier-only members erase before reflection (${bindingUpdates})`, async t => {
    const run = await worker(t, {}, bindingUpdates)
    assert.deepEqual(await run(`class C{public m(){return 1}protected n(){return 2}private p(){return 3}optional?(){return 4}}
      const methods=['m','n','p','optional'];return methods.map(name=>Function('return ({'+C.prototype[name].toString()+'})')()[name]())`),
    [1,2,3,4])
    assert.equal(await run(`abstract class Base{abstract missing():number;readonly value=5;public read(){return this.value}}
      const Copy=Function('return ('+Base.toString()+')')();return new Copy().read()`), 5)
    assert.equal(await run(`class Parent{m(){return 1}}class Child extends Parent{override m(){return 6}}
      return Function('return ({'+Child.prototype.m.toString()+'})')().m()`), 6)
  })

  test(`static method reflection follows parsed token boundaries (${bindingUpdates})`, async t => {
    const AsyncFunction = (async function () {}).constructor
    const expected = await new AsyncFunction(staticMethodSource)()
    const run = await worker(t, {
      'static.mjs': `export async function read(){${staticMethodSource}}`,
      'static.cjs': `exports.read=async function(){${staticMethodSource}}`,
    }, bindingUpdates)
    assert.deepEqual(await run(`return (async function(){${staticMethodSource}})()`), expected)
    assert.deepEqual(await run('return (await import("./static.mjs")).read()'), expected)
    assert.deepEqual(await run('return require("./static.cjs").read()'), expected)
    assert.equal(await run(`function decorate(value){return value}
      class Typed{@decorate public static/* typed */["typed"]():number {return 13}}
      return Function('return ({'+Typed.typed.toString()+'}).typed()')()`), 13)
  })
}

for (const target of ['module','commonjs']) {
  test(`final ${target} source positions include restored identities and registration`, () => {
    const body = 'function run(){\n  throw new Error("position marker");\n}'
    const source = target === 'module' ? 'export ' + body : body + '\nmodule.exports={run};'
    const prepared = compileStatefulModule(source, { target })
    let position
    traverse(parse(prepared.code, { sourceType: target }), { noScope: true, StringLiteral(path) {
      if (path.node.value === 'position marker') position = { line: path.node.loc.start.line, column: path.node.loc.start.column + 1 }
    } })
    assert.ok(position)
    assert.ok(prepared.sourceMap.emission)
    assert.deepEqual(mapSourceSpan(position, prepared.code, source, prepared.sourceMap.emission), { line: 2, column: 19 })
  })
}
