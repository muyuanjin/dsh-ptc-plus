import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { types as t } from '@babel/core'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { collectCallableSources, markCallableSources } from '../internal/callable-source-facts.js'
import { createCallableSourceRegistry } from '../internal/callable-source-catalog.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { transformTypeScriptSource } from '../internal/typescript-transform.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM } from '../internal/module-transform-contract.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'

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
const lineEndings = ['\n', '\r\n', '\r', '\u2028', '\u2029']

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
    const agentSession = orderedSurfaceSession(`callable-source-${extension}`)
    agentSession.header = { cwd: directory }
    const imported = extension === 'mjs' ? 'await import("./source.mjs")' : 'require("./source.cjs")'
    const result = await runRecordedCell(runtime, agentSession, 'load-source', {
      bindings: [],
      program: `const source=${imported}; return await source.inspect()`,
    }, { description: 'callable source integration cell' })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value[0], [arrow,anonymous,named,asyncNamed,generator,asyncGenerator,
      method,getter,setter,asyncMethod,generatorMethod,shape,outer,nested,dependent,
      'read(){return this.value}','read(){return 1712}'])
    assert.deepEqual(result.value[1], [1701,1702,1703,1704,1705,1706,1707,1708,1715,1709,1710,1711,1712,1713,1713,1716,1712])
    assert.equal(result.value[2][0], 'ReferenceError')
    assert.match(result.value[2][1], /offset/)
    assert.doesNotMatch(result.value[2][1], /__dsh_ptc/)
    const next = await runRecordedCell(runtime, agentSession, 'inspect-source', {
      bindings: [],
      program: 'return (await source.inspect())[1]',
    }, { description: 'callable source integration cell' })
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

test('TypeScript namespace functions retain module callable ownership across targets and line endings', () => {
  for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM]) {
    for (const target of ['module', 'commonjs']) {
      for (const ending of lineEndings) {
        const callable = `function read () {${ending}return secret${ending}}`
        const source = `namespace N {${ending}export let secret=42;${ending}export ${callable}${ending}}`
        const prepared = compileStatefulModule(source, { target, transform })
        const registry = createCallableSourceRegistry()
        registry.register(prepared.callableSources)
        const tree = parse(prepared.code, { sourceType: target, errorRecovery: true })
        let emitted
        t.traverseFast(tree, node => {
          if (emitted === undefined && t.isFunction(node) && node.id?.name === 'read') {
            emitted = prepared.code.slice(node.start, node.end)
          }
        })
        assert.ok(emitted)
        assert.equal(registry.get(emitted), callable)
        assert.doesNotMatch(registry.get(emitted), /__dsh_ptc_/)
      }
    }
  }
})

test('typed namespace callable catalogs exclude compiler ownership marks', () => {
  const expected = 'function read(value       )       {return value+42}'
  for (const transform of [USER_BINDING_TRANSFORM, PROTECTED_MODULE_TRANSFORM]) {
    for (const target of ['module', 'commonjs']) {
      const prepared = compileStatefulModule(
        'namespace N {export function read(value:number):number{return value+42}}', { target, transform })
      const registry = createCallableSourceRegistry()
      registry.register(prepared.callableSources)
      const tree = parse(prepared.code, { sourceType: target, errorRecovery: true })
      let reflected
      t.traverseFast(tree, node => {
        if (reflected === undefined && t.isFunction(node) && node.id?.name === 'read') {
          reflected = registry.get(prepared.code.slice(node.start, node.end))
        }
      })
      assert.equal(reflected, expected)
      assert.equal(Function(`return (${reflected})`)()(0), 42)
      assert.doesNotMatch(reflected, /__dsh_ptc_/)
    }
  }
})
