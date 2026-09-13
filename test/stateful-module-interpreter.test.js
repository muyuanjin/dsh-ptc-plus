import assert from 'node:assert/strict'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { mapSourcePosition } from '../internal/source-position-map.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { LEGACY_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { managedGraph } from './managed-module-fixture.js'

const interpreter = '#!/usr/bin/env node'
const lineEndings = ['\n', '\r\n', '\r', '\u2028', '\u2029']
const traverse = traverseModule.default ?? traverseModule

for (const transform of [USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]) {
  test(`module interpreter directives precede all preparation (${transform})`, async t => {
    const files = {}
    for (const [index, ending] of lineEndings.entries()) {
      files[`value${index}.mjs`] = `${interpreter}${ending}export let value: number = 41;\nexport function read(){return eval('value + 1')}`
      files[`value${index}.cjs`] = `${interpreter}${ending}const value: number = 41;\nmodule.exports={read(){return eval('value + 1')},target:new.target};return;throw new Error('past return')`
    }
    files['empty.mjs'] = interpreter
    files['empty.cjs'] = interpreter
    const graph = await managedGraph(t, files, 'value0.mjs')
    for (const file of Object.keys(files)) graph.compilation.mark(graph.url(file), { transform })
    for (const [index] of lineEndings.entries()) {
      const esm = await graph.load(`value${index}.mjs`)
      assert.equal(esm.read(), 42)
      const commonjs = (await graph.load(`value${index}.cjs`)).default
      assert.equal(commonjs.read(), 42)
      assert.equal(commonjs.target, undefined)
    }
    assert.deepEqual(Object.keys(await graph.load('empty.mjs')), [])
    assert.deepEqual((await graph.load('empty.cjs')).default, {})
  })

  test(`interpreter normalization retains source positions (${transform})`, () => {
    for (const target of ['module', 'commonjs']) for (const ending of lineEndings) {
      const body = 'function read(){throw new Error("original position")}'
      const source = interpreter + ending + (target === 'module' ? `export ${body}` : `${body};module.exports={read}`)
      const prepared = compileStatefulModule(source, { transform, target })
      const legacy = transform === LEGACY_USER_BINDING_TRANSFORM
      // Legacy's published map ends at transform input; current modules also
      // provide a composed final emission map including callable registration.
      const generated = legacy
        ? target === 'commonjs' ? `function __ptc_commonjs__(){\n${prepared.classificationCode}\n}` : prepared.classificationCode
        : prepared.code
      const mapping = legacy ? prepared.sourceMap.normalization : prepared.sourceMap.emission
      let position
      traverse(parse(generated, { sourceType: target }), { noScope: true, StringLiteral(path) {
        if (path.node.value === 'original position') position = { line: path.node.loc.start.line, column: path.node.loc.start.column + 1 }
      } })
      assert.ok(position)
      const expectedColumn = source.slice(source.indexOf('function read')).indexOf('"original position"') + 1
        + (target === 'module' ? 'export '.length : 0)
      assert.deepEqual(mapSourcePosition(position, generated, source, mapping),
        { line: 2, column: expectedColumn }, JSON.stringify({ target, ending }))
    }
  })

  test(`interpreter handling preserves native syntax goals (${transform})`, () => {
    for (const target of ['module', 'commonjs']) {
      assert.throws(() => compileStatefulModule(`\n${interpreter}\nlet value=1`, { transform, target }), SyntaxError)
      assert.throws(() => compileStatefulModule(`${interpreter}\n${interpreter}`, { transform, target }), SyntaxError)
    }
    assert.throws(() => compileStatefulModule(`${interpreter}\nreturn`, { transform }), SyntaxError)
    assert.throws(() => compileStatefulModule(`${interpreter}\nnew.target`, { transform }), SyntaxError)
    assert.throws(() => compileStatefulModule(`${interpreter}\nawait Promise.resolve()`, { transform, target: 'commonjs' }), SyntaxError)
  })
}

const policies = {
  stateful: { bindingUpdates: 'stateful' },
  protected: { bindingUpdates: 'protected' },
  legacy: { legacyBindingSettings: true, looseTopLevelRedeclarations: false },
  'legacy-loose': { legacyBindingSettings: true, looseTopLevelRedeclarations: true },
}

for (const [policy, options] of Object.entries(policies)) {
  test(`worker imports interpreter modules through every entry (${policy})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'ptc-interpreter-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    await Promise.all([
      writeFile(join(directory, 'value.mjs'), `${interpreter}\r\nexport let value: number=41;export function read(){return eval('value + 1')}`),
      writeFile(join(directory, 'value.cjs'), `${interpreter}\nmodule.exports={value:41,read(){return eval('this.value + 1')}}`),
      writeFile(join(directory, 'empty.mjs'), interpreter),
      writeFile(join(directory, 'empty.cjs'), interpreter),
    ])
    const runtime = new SessionRuntime({ durableReplay: false, ...options })
    t.after(() => runtime.dispose())
    const session = { id: `interpreter-${policy}`, session: { header: { cwd: directory } } }
    const result = await runtime.run(session, { bindings: [], program: `
import * as esm from './value.mjs';import cjs from './value.cjs';
const dynamic=await import('./value.mjs');const required=require('./value.mjs');
const dynamicCjs=await import('./value.cjs');const requiredCjs=require('./value.cjs');
const empty=await import('./empty.mjs');const emptyCjs=require('./empty.cjs');
return [esm.read(),cjs.read(),esm===dynamic,esm===required,cjs===dynamicCjs.default,cjs===requiredCjs,
  Object.keys(empty).length,Object.keys(emptyCjs).length]` })
    assert.equal(result.error, undefined, result.error?.message)
    assert.deepEqual(result.value, [42,42,true,true,true,true,0,0])
  })
}
