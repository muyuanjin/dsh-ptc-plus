import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { collectCallableSources, markCallableSources } from '../internal/callable-source-facts.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { transformTypeScriptSource } from '../internal/typescript-transform.js'

const arrow = '() => { const local=1701; return local }'
const anonymous = 'function(){const local=1702;return local}'
const named = 'function named(){const local=1703;return local}'
const asyncNamed = 'async function asyncNamed(){return 1704}'
const generator = 'function* generator(){yield 1705}'
const asyncGenerator = 'async function* asyncGenerator(){yield 1706}'
const method = 'method(){return 1707}'
const getter = 'get value(){return 1708}'
const setter = 'set value(next){this.stored=next}'
const asyncMethod = 'async method(){return 1709}'
const generatorMethod = '*method(){yield 1710}'
const shape = 'class Shape{value=1711;read(){return this.value}static read(){return 1712}}'
const outer = 'function outer(){return ()=>1713}'
const nested = '()=>1713'
const dependent = '()=>offset'

for (const bindingUpdates of ['stateful','protected']) for (const extension of ['mjs','cjs']) for (const lexicalDynamic of [false,true]) {
  test(`isolated ${extension} module reflection and recompilation use original callable ownership (${bindingUpdates}, eval=${lexicalDynamic})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'ptc-module-callable-source-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const source = `
${lexicalDynamic ? 'eval("0")' : ''}
const arrow=${arrow}
const anonymous=${anonymous}
${named}
${asyncNamed}
${generator}
${asyncGenerator}
const object={${method},${getter},${setter}}
const asyncObject={${asyncMethod}}
const generatorObject={${generatorMethod}}
${shape}
${outer}
const nested=outer()
const offset=1714
const dependent=${dependent}
async function inspect(){
  const get=Object.getOwnPropertyDescriptor(object,'value').get
  const set=Object.getOwnPropertyDescriptor(object,'value').set
  const originals=[arrow,anonymous,named,asyncNamed,generator,asyncGenerator,
    object.method,get,set,asyncObject.method,generatorObject.method,Shape,outer,nested,dependent,
    Shape.prototype.read,Shape.read]
    .map(value=>value.toString())
  const restored=originals.map((source,index)=>Function('return ('+(index>=6&&index<=10||index>=15?'{'+source+'}':source)+')')())
  restored[8].value=1715
  let missing
  try{restored[14]()}catch(error){missing=[error.name,error.message]}
  return [originals,[restored[0](),restored[1](),restored[2](),await restored[3](),
    restored[4]().next().value,(await restored[5]().next()).value,restored[6].method(),
    restored[7].value,restored[8].stored,await restored[9].method(),restored[10].method().next().value,
    new restored[11]().read(),restored[11].read(),restored[12]()(),restored[13](),
    restored[15].read.call({value:1716}),restored[16].read()],missing]
}

${extension === 'mjs' ? 'export {inspect}' : 'module.exports={inspect}'}
`
    await writeFile(join(directory, `source.${extension}`), source)
    const runtime = new SessionRuntime({ bindingUpdates, durableReplay: false })
    t.after(() => runtime.dispose())
    const session = { id: `callable-source-${extension}`, session: { header: { cwd: directory } } }
    const imported = extension === 'mjs' ? 'await import("./source.mjs")' : 'require("./source.cjs")'
    const result = await runtime.run(session, { bindings: [], program: `const source=${imported}; return await source.inspect()` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value[0], [arrow,anonymous,named,asyncNamed,generator,asyncGenerator,
      method,getter,setter,asyncMethod,generatorMethod,shape,outer,nested,dependent,
      'read(){return this.value}','read(){return 1712}'])
    assert.deepEqual(result.value[1], [1701,1702,1703,1704,1705,1706,1707,1708,1715,1709,1710,1711,1712,1713,1713,1716,1712])
    assert.equal(result.value[2][0], 'ReferenceError')
    assert.match(result.value[2][1], /offset/)
    assert.doesNotMatch(result.value[2][1], /__dsh_ptc/)
    const next = await runtime.run(session, { bindings: [], program: 'return (await source.inspect())[1]' })
    assert.equal(next.error, undefined, next.error?.message)
    assert.deepEqual(next.value, result.value[1])
  })
}

test('final transform mappings prove callable ownership and exclude unmapped neighboring functions', () => {
  const forms = [
    'async () => 1771',
    'async function* () { yield 1772 }',
    '(value=1773) => value',
    'function outer(value=1774){ return () => value }',
    'class { method () { return 1775 } }',
  ]
  const input = `const values=[${forms.join(',')}];`
  const marked = markCallableSources(input)
  const transformed = transformTypeScriptSource(marked.code, { sourceMap: true, module: false,
    transform: { noEmptyExport: true } })
  const code = transformed.code + '\nvalues.push(function unowned(){ return "helper" });'
  const facts = new Map(collectCallableSources(code, marked.callableSources, {},
    { code: marked.code, map: transformed.map }))
  const values = runInNewContext(code + '\nvalues')
  for (const [index, original] of forms.entries()) {
    assert.equal(facts.get(Function.prototype.toString.call(values[index])), original)
  }
  assert.equal(facts.has(Function.prototype.toString.call(values.at(-1))), false)
})
