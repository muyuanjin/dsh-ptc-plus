import assert from 'node:assert/strict'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import test from 'node:test'
import { collectCallableSources, markCallableSources } from '../internal/callable-source-facts.js'
import { adaptDynamicCell } from '../internal/dynamic-environment-integration.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { identitySourceMap, mappedSourceTransform, mapSourcePosition, sourceLineStarts } from '../internal/source-position-map.js'
import { transformTypeScriptSource } from '../internal/typescript-transform.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { managedGraph } from './managed-module-fixture.js'

const traverse = traverseModule.default ?? traverseModule
const endings = ['\n', '\r\n', '\r', '\u2028', '\u2029']

function stringPosition(code, value, sourceType = 'script') {
  let position
  traverse(parse(code, { sourceType,
    ...(sourceType === 'commonjs' ? {} : { allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }) }), {
    noScope: true,
    StringLiteral(path) {
      if (path.node.value === value) position = { line: path.node.loc.start.line, column: path.node.loc.start.column + 1 }
    },
  })
  assert.ok(position, `missing string ${value}`)
  return position
}

function literalPosition(code, value) {
  const offset = code.indexOf(`"${value}"`)
  assert.notEqual(offset, -1, `missing string ${value}`)
  const starts = sourceLineStarts(code)
  const line = starts.findLastIndex(start => start <= offset)
  return { line: line + 1, column: offset - starts[line] + 1 }
}

test('shared transform maps retain all JavaScript line boundaries in both directions', () => {
  const source = 'zero\r\none\rtwo\nthree\u2028four\u2029five'
  assert.deepEqual(sourceLineStarts(source), [0,6,10,14,20,25])
  assert.deepEqual(sourceLineStarts(''), [0])
  const nativeMap = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA' }
  for (const ending of endings) for (const serialize of [false,true]) {
    const generated = ['zero','one','two','three','four','five'].join(ending)
    const result = mappedSourceTransform(source, identitySourceMap(source.length),
      { code: generated, map: serialize ? JSON.stringify(nativeMap) : nativeMap })
    for (let line = 1; line <= 6; line++) {
      assert.deepEqual(mapSourcePosition({ line, column: 1 }, result.code, source, result.sourceMap), { line, column: 1 })
    }
  }
  const sparse = mappedSourceTransform('x', identitySourceMap(1), { code: '\nx',
    map: { version: 3, sources: ['input.js'], names: [], mappings: ';AAAA' } })
  assert.deepEqual(mapSourcePosition({ line: 2, column: 1 }, sparse.code, 'x', sparse.sourceMap), { line: 1, column: 1 })
})

for (const ending of endings) {
  test(`TypeScript declaration bodies preserve source coordinates across ${JSON.stringify(ending)}`, () => {
    for (const [kind, source] of [
      ['enum', `export enum E {${ending}Value=(()=>{throw new Error("enum position")})()${ending}}`],
      ['namespace', `export namespace N {${ending}export const value=(()=>{throw new Error("namespace position")})()${ending}}`],
    ]) {
      const prepared = compileStatefulModule(source, { target: 'module' })
      const value = `${kind} position`
      assert.deepEqual(mapSourcePosition(stringPosition(prepared.code, value, 'module'),
        prepared.code, source, prepared.sourceMap.emission), literalPosition(source, value))
    }
  })

  test(`module emission preserves source coordinates across ${JSON.stringify(ending)}`, () => {
    for (const target of ['module','commonjs']) {
      for (const prefix of ['', 'enum Mode { Value=1 };', 'function decorate(value){return value};@decorate class Box{};']) {
        const body = 'function read(){throw new Error("original position")}'
        const source = prefix + ending + (target === 'module' ? `export ${body}` : `${body};module.exports={read}`)
        const prepared = compileStatefulModule(source, { target })
        assert.deepEqual(mapSourcePosition(stringPosition(prepared.code, 'original position', target),
          prepared.code, source, prepared.sourceMap.emission), { line: 2, column: target === 'module' ? 40 : 33 })
      }
    }
  })

  test(`callable source ownership survives native lowering across ${JSON.stringify(ending)}`, () => {
    const original = `function read () {${ending}  return 42${ending}}`
    const source = ending + original
    const marked = markCallableSources(source)
    const transformed = transformTypeScriptSource(marked.code, { sourceMap: true, module: false })
    const sources = collectCallableSources(transformed.code, marked.callableSources, {}, { code: marked.code, map: transformed.map })
    assert.equal(sources.length, 1)
    assert.equal(sources[0][1], original)
  })

  test(`dynamic preparation maps source and eval origin across ${JSON.stringify(ending)}`, () => {
    const source = `let value=1;${ending}eval('value+=1');${ending}throw new Error('dynamic position')`
    const result = adaptDynamicCell(source, identitySourceMap(source.length), {
      nativeRoot: true, environmentGlobal: '__test_environment', originalSource: source,
    })
    assert.deepEqual(mapSourcePosition(stringPosition(result.code, 'dynamic position'), result.code, source, result.sourceMap),
      { line: 3, column: 17 })
    assert.deepEqual(result.dynamicOrigins.filter(origin => origin.definitionSpan.line === 2).map(origin => origin.definitionSpan),
      [{ line: 2, column: 1, end: { line: 2, column: 17 } }])
  })
}

test('worker errors retain positions inside a lone-CR enum transform', async t => {
  const runtime = new SessionRuntime({ durableReplay: false, bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  const session = { id: 'source-position-enum-cr', session: { header: { cwd: process.cwd() } } }
  const result = await runtime.run(session, { bindings: [],
    program: 'enum E {\r A=(()=>{throw new Error("boom")})()\r}\rreturn E' })
  assert.match(result.error?.message ?? '', /current:2:16/)
  assert.match(result.error.message, /boom/)
})

test('native module functions retain exact callable source through mixed line endings', async t => {
  const sources = endings.map(ending => `function read () {${ending}  return 42${ending}}`)
  const files = Object.fromEntries(sources.flatMap((source, index) => [
    [`source${index}.mjs`, `${endings[index]}export ${source}`],
    [`source${index}.cjs`, `${endings[index]}${source};module.exports={read}`],
  ]))
  const graph = await managedGraph(t, files, 'source0.mjs')
  const runtime = new SessionRuntime({ durableReplay: false, bindingUpdates: 'stateful' })
  t.after(() => runtime.dispose())
  const session = { id: 'module-line-sources', session: { header: { cwd: graph.directory } } }
  for (const [index, source] of sources.entries()) {
    const result = await runtime.run(session, { bindings: [], program: `
const esm=await import('./source${index}.mjs');const commonjs=require('./source${index}.cjs');
return [esm.read.toString(),commonjs.read.toString(),esm.read(),commonjs.read()]` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [source,source,42,42])
  }
})

for (const bindingUpdates of ['stateful','protected']) {
  test(`worker errors retain original cell positions across native line endings (${bindingUpdates})`, async t => {
    const runtime = new SessionRuntime({ durableReplay: false, bindingUpdates })
    t.after(() => runtime.dispose())
    for (const [index, ending] of endings.entries()) {
      const session = { id: `source-position-${index}`, session: { header: { cwd: process.cwd() } } }
      const program = `const value=1;${ending}eval('value');${ending}throw new Error('worker position')`
      const result = await runtime.run(session, { bindings: [], program })
      assert.match(result.error?.message ?? '', /current:3:7/)
      assert.match(result.error.message, /worker position/)
    }
  })
}
