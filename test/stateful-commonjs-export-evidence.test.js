import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { commonJsExportEvidence } from '../internal/commonjs-source-evidence.js'
import { compileStatefulModule } from '../internal/stateful-module-compiler.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { LEGACY_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { managedGraph } from './managed-module-fixture.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'

const transforms = [USER_BINDING_TRANSFORM, LEGACY_USER_BINDING_TRANSFORM]
const cases = {
  assignment: 'exports.answer=42; exports.answer++; exports.answer+=1; exports.default="own default"',
  strings: 'exports["with space"]=42;exports["雪"]=43;exports["a\\nb"]=44;exports[""]=45;exports["__esModule"]=true',
  literal: 'const answer=42; module.exports={answer,renamed:answer,undetected:43};',
  parenthesized: 'const answer=42; module.exports={undetected:(answer),alsoUndetected:answer};',
  scopes: 'function dormant(exports){exports.shadowed=1} if(false) exports.unreachable=2;exports.answer=42',
  replacement: 'exports.abandoned=1;const answer=42;module.exports={answer};module.exports.answer++',
  getter: 'const answer=42;Object.defineProperty(exports,"answer",{enumerable:true,get(){return answer}})',
  'unsafe getter': 'exports.answer=42;Object.defineProperty(exports,"answer",{get(){throw Error("getter ran")}})',
  'excluded getter': 'const answer=42;Object.defineProperty(exports,"answer",{get(){return answer}});if(false)Object.defineProperty(exports,"answer",{get(){return 0}})',
  computed: 'const name="computed";exports[name]=42;Object.assign(exports,{assigned:43});exports.count=0;exports.count++',
  tokens: '/* exports.comment=1 */const text="exports.string=2";const template=`exports.template=3`;const regex=/exports.regex=4/;exports.answer=42',
  return: '"use strict";exports.answer=42;return;exports.unreachable=43;throw Error("past return")',
  'literal getter': 'module.exports={get actual(){return 1}}',
  'getter shorthand': 'const get=1;module.exports={get}',
  'literal getter boundary': 'const x=1;module.exports={x,get actual(){return 1},after:x}',
  'unicode whitespace': 'exports.answer\u00a0=42',
  'octal escape': 'exports["\\141"]=42',
  'nested descriptor evidence': 'if(false)Object.defineProperty(exports,"answer",{value:()=>Object.defineProperty(exports,"answer",{get(){return 0}})});exports.answer=42',
}

for (const transform of transforms) {
  for (const [name, source] of Object.entries(cases)) {
    test(`CommonJS namespace matches native lexical detection: ${name} (${transform})`, async t => {
      const graph = await managedGraph(t, { 'root.cjs': source, 'native.cjs': source }, 'root.cjs', ['native.cjs'])
      graph.compilation.mark(graph.url('root.cjs'), { transform })
      const native = graph.opaque['native.cjs']
      const managed = await graph.load()
      assert.deepEqual(Object.keys(managed), Object.keys(native))
      for (const key of Object.keys(native)) {
        if (key === 'default' || key === 'module.exports') continue
        assert.equal(managed[key], native[key], key)
      }
      assert.equal(managed.default, createRequire(import.meta.url)(join(graph.directory, 'root.cjs')))
      assert.equal(await graph.load(), managed)
      assert.deepEqual(Object.getOwnPropertyNames(managed.default), Object.getOwnPropertyNames(native.default))
    })
  }

  test(`CommonJS reexports retain native selection, transitive names and cycles (${transform})`, async t => {
    const sources = {}
    for (const prefix of ['native', 'managed']) {
      sources[`${prefix}-first.cjs`] = 'exports.first=1'
      sources[`${prefix}-second.cjs`] = 'exports.second=2'
      sources[`${prefix}-last.cjs`] = `module.exports=require('./${prefix}-first.cjs');module.exports=require('./${prefix}-second.cjs')`
      sources[`${prefix}-spread.cjs`] = `module.exports={...require('./${prefix}-first.cjs'),...require('./${prefix}-second.cjs')}`
      sources[`${prefix}-star.cjs`] = `function __exportStar(value,target){Object.assign(target,value)};__exportStar(require('./${prefix}-spread.cjs'),exports)`
      sources[`${prefix}-babel.cjs`] = `var value=require('./${prefix}-spread.cjs');Object.keys(value).forEach(function(key){if(key==='default'||key==='__esModule')return;exports[key]=value[key]})`
      sources[`${prefix}-cycle.cjs`] = `exports.cycle=3;module.exports={...require('./${prefix}-loop.cjs'),...exports}`
      sources[`${prefix}-loop.cjs`] = `exports.loop=4;module.exports={...require('./${prefix}-cycle.cjs'),...exports}`
      sources[`${prefix}-dead.cjs`] = `if(false)module.exports=require('./${prefix}-unexecuted.cjs');exports.own=5`
      sources[`${prefix}-unexecuted.cjs`] = 'exports.unexecuted=6;throw Error("link evidence executed")'
      sources[`${prefix}-missing.cjs`] = 'if(false)module.exports=require("./absent.cjs");exports.present=7'
      sources[`${prefix}-property.cjs`] = `module.exports={first:require('./${prefix}-first.cjs')}`
      sources[`${prefix}-repeated.cjs`] = `module.exports={...require('./${prefix}-first.cjs'),...require('./${prefix}-first.cjs')}`
      sources[`${prefix}-extension.cjs`] = `module.exports=require('./${prefix}-extension-dep')`
      sources[`${prefix}-extension-dep.js`] = 'exports.extension=8'
    }
    const names = ['last', 'spread', 'star', 'babel', 'cycle', 'dead', 'missing', 'property', 'repeated', 'extension']
    const graph = await managedGraph(t, sources, 'managed-last.cjs', names.map(name => `native-${name}.cjs`))
    for (const file of Object.keys(sources)) graph.compilation.mark(graph.url(file), { transform })
    for (const name of names) {
      const native = graph.opaque[`native-${name}.cjs`]
      const managed = await graph.load(`managed-${name}.cjs`)
      assert.deepEqual(Object.keys(managed), Object.keys(native), name)
      for (const key of Object.keys(native)) {
        if (key !== 'default' && key !== 'module.exports') assert.deepEqual(managed[key], native[key], `${name}.${key}`)
      }
      assert.deepEqual(managed.default, native.default, name)
    }
    const require = createRequire(import.meta.url)
    assert.notEqual(require.cache[join(graph.directory, 'managed-unexecuted.cjs')]?.loaded, true)
  })

  test(`CommonJS evidence survives TypeScript erasure and runtime lowering (${transform})`, async t => {
    const source = 'const value:number=42;module.exports={answer:value as number,second:value};exports.detached=1'
    const graph = await managedGraph(t, { 'root.cts': source,
      'native.cjs': 'const value       =42;module.exports={answer:value          ,second:value};exports.detached=1',
      'enum.cts': 'enum Kind{First};exports.Kind=Kind;exports.answer=42',
    }, 'root.cts', ['native.cjs'])
    graph.compilation.mark(graph.url('root.cts'), { transform })
    graph.compilation.mark(graph.url('enum.cts'), { transform })
    const managed = await graph.load()
    assert.deepEqual(Object.keys(managed), Object.keys(graph.opaque['native.cjs']))
    assert.equal(managed.answer, 42)
    assert.equal(managed.second, graph.opaque['native.cjs'].second)
    assert.equal(managed.default.second, 42)
    assert.equal(managed.detached, undefined)
    const lowered = await graph.load('enum.cts')
    assert.equal(lowered.Kind.First, 0)
    assert.equal(lowered.answer, 42)
  })

  test(`CommonJS linking preserves assignment snapshots, strict context and function source (${transform})`, async t => {
    const callable = 'function answer(){return 42}'
    const source = `"use strict";exports.answer=${callable};exports.value=1;exports.update=function(){exports.value++};exports.context=[this===exports,new.target===undefined];`
    const graph = await managedGraph(t, { 'root.cjs': source }, 'root.cjs')
    graph.compilation.mark(graph.url('root.cjs'), { transform })
    const ns = await graph.load()
    assert.equal(ns.answer, ns.default.answer)
    assert.equal(ns.answer(), 42)
    assert.deepEqual(ns.context, [true, true])
    ns.update()
    assert.equal(ns.value, 1)
    assert.equal(ns.default.value, 2)
    const reflected = ns.answer.toString()
    assert.equal(reflected, ns.default.answer.toString())
    assert.equal(reflected.includes('if(false)'), false)
  })
}

test('CommonJS evidence preparation keeps grammar errors and erases type-only imports', async t => {
  for (const legacy of [false, true]) assert.throws(() => commonJsExportEvidence('return ( ', { legacy }), SyntaxError)
  const graph = await managedGraph(t, { 'root.cts': 'import type {Missing} from "absent";exports.answer=42' }, 'root.cts')
  assert.equal((await graph.load()).answer, 42)
  for (const transform of transforms) assert.doesNotThrow(() => compileStatefulModule('', { target: 'commonjs', transform }))
})

test('CommonJS export evidence accepts dialect source without changing lexical export detection', async t => {
  const sources = {
    'with.cjs': 'with({x:2}){module.exports=x}',
    'bare.cjs': 'const x;module.exports={x}',
    'constructors.cjs': 'class C{constructor(){this.x=1}constructor(){this.x=2}};exports.answer=new C().x',
    'labels.cjs': 'a:a:{break a}exports.answer=2',
    'typed.cts': 'with({x:2}){const y:number=x;module.exports={answer:y as number,undetected:(y),other:y}}',
    'native.cjs': 'with({x:2}){const y       =x;module.exports={answer:y          ,undetected:(y),other:y}}',
    'repeated.cts': 'const x:number=1;const x:number=2;exports.answer=x',
  }
  const graph = await managedGraph(t, sources, 'with.cjs', ['native.cjs'])
  assert.equal((await graph.load()).default, 2)
  assert.deepEqual((await graph.load('bare.cjs')).default, { x: undefined })
  for (const name of ['constructors.cjs','labels.cjs','repeated.cts']) assert.equal((await graph.load(name)).answer, 2)
  const typed = await graph.load('typed.cts')
  assert.equal(typed.answer, 2)
  assert.equal(typed.default.undetected, 2)
  assert.equal(Object.hasOwn(typed, 'undetected'), false)
  assert.deepEqual(Object.keys(typed), Object.keys(graph.opaque['native.cjs']))
})

test('managed module Function lookup retains intrinsic unscopables during global mutation', async t => {
  const graph = await managedGraph(t, { 'root.mjs': `
    const nativeSymbol=Symbol,box={x:2,[Symbol.unscopables]:{x:true}};
    const read=Function('box','let x=1;with(box){return x}');
    let answer;try{globalThis.Symbol=1;answer=read(box)}finally{globalThis.Symbol=nativeSymbol}
    export {answer};` }, 'root.mjs')
  assert.equal((await graph.load()).answer, 1)
})

for (const late of [false, true]) test(`CommonJS evidence retains original public resolution context (${late ? 'late' : 'early'} hook)`, async t => {
  let graph
  const calls = []
  const install = () => {
    const hook = registerHooks({ resolve(specifier, context, next) {
      if (specifier !== 'evidence-choice') return next(specifier, context)
      calls.push({ parent: context.parentURL, conditions: [...context.conditions] })
      return next(fileURLToPath(graph.url('selected.cjs')), context)
    } })
    t.after(() => hook.deregister())
  }
  if (!late) install()
  graph = await managedGraph(t, {
    'root.cjs': 'if(false)module.exports={...require("evidence-choice"),...require("evidence-choice")};exports.own=1',
    'selected.cjs': 'exports.value=2;throw Error("evidence must not execute")',
    'native.cjs': 'exports.own=1;if(false)exports.value=2',
  }, 'root.cjs', ['native.cjs'])
  if (late) install()
  const result = await graph.load()
  assert.deepEqual(Object.keys(result), Object.keys(graph.opaque['native.cjs']))
  assert.equal(result.own, 1)
  assert.equal(result.value, undefined)
  assert.ok(calls.length >= 1)
  for (const call of calls) {
    assert.equal(call.parent, graph.url('root.cjs'))
    assert.ok(call.conditions.includes('require'))
  }
})

test('prepared CommonJS evidence is carried as metadata until actual loading', async t => {
  const require = createRequire(import.meta.url)
  const before = Object.keys(require.cache).filter(name => name.includes('.__ptc_commonjs_evidence_'))
  const prepared = compileStatefulModule('exports.answer=42', { target: 'commonjs' })
  assert.deepEqual(Object.keys(require.cache).filter(name => name.includes('.__ptc_commonjs_evidence_')), before)
  const graph = await managedGraph(t, { 'prepared.cjs': prepared.code }, 'prepared.cjs')
  graph.compilation.mark(graph.url('prepared.cjs'), { compiled: true, commonJsSource: prepared.commonJsSource })
  assert.equal((await graph.load()).answer, 42)
  assert.equal(await graph.load(), await graph.load())
})

test('CommonJS evidence follows source changes before the first native import', async t => {
  const graph = await managedGraph(t, { 'root.cjs': 'exports.first=1', 'native.cjs': 'exports.second=2' }, 'root.cjs', ['native.cjs'])
  const require = createRequire(graph.url('root.cjs'))
  const filename = fileURLToPath(graph.url('root.cjs'))
  assert.equal(require(filename).first, 1)
  await writeFile(filename, 'exports.second=2')
  delete require.cache[filename]
  assert.equal(require(filename).second, 2)
  const current = await graph.load()
  assert.deepEqual(Object.keys(current), Object.keys(graph.opaque['native.cjs']))
  assert.equal(current.second, 2)
  assert.equal(current.default, require(filename))
})

const policies = {
  stateful: { bindingUpdates: 'stateful' },
  protected: { bindingUpdates: 'protected' },
  legacy: { legacyBindingSettings: true, looseTopLevelRedeclarations: false },
  'legacy-loose': { legacyBindingSettings: true, looseTopLevelRedeclarations: true },
}

for (const [policy, options] of Object.entries(policies)) {
  for (const first of ['import', 'require']) {
    test(`worker static/dynamic CommonJS imports share effects and cache (${policy}, ${first} first)`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'ptc-cjs-evidence-'))
      t.after(() => rm(directory, { recursive: true, force: true }))
      await Promise.all([
        writeFile(join(directory, 'counter.cjs'), 'module.exports={runs:0}'),
        writeFile(join(directory, 'value.cjs'), `const counter=require('./counter.cjs');counter.runs++;
          exports.answer=42;exports.value=1;exports.update=function(){exports.value++};exports.runs=function runs(){return counter.runs}`),
        writeFile(join(directory, 'forward.cjs'), 'module.exports=require("./value.cjs")'),
        writeFile(join(directory, 'consumer.mjs'), `import value,{answer} from './forward.cjs';export {answer};export default value;
          export async function dynamic(){return (await import('./forward.cjs')).answer}`),
      ])
      const runtime = new SessionRuntime({ durableReplay: false, ...options })
      t.after(() => runtime.dispose())
      const session = orderedSurfaceSession(`cjs-evidence-${policy}-${first}`)
      session.header = { cwd: directory }
      if (first === 'require') {
        const initial = await runRecordedCell(runtime, session, 'initial-require', {
          bindings: [], program: 'const initiallyRequired=require("./value.cjs");return initiallyRequired.answer',
        })
        assert.equal(initial.error, undefined, initial.error?.message)
        assert.equal(initial.value, 42)
      }
      const result = await runRecordedCell(runtime, session, 'load-commonjs-evidence', { bindings: [], program: `
import consumer,{answer} from './consumer.mjs';import {answer as direct} from './value.cjs';
const dynamic=await import('./value.cjs');const forwarded=await import('./forward.cjs');const required=require('./value.cjs');
const indirect=await import('./consumer.mjs');required.update();
return [answer,direct,dynamic.answer,forwarded.answer,await indirect.dynamic(),
  required===dynamic.default,required===consumer,required===forwarded.default,dynamic===await import('./value.cjs'),
  required.runs(),dynamic.value,required.value,required.runs.toString()]` })
      assert.equal(result.error, undefined, result.error?.message)
      assert.deepEqual(result.value.slice(0, -1), [42,42,42,42,42,true,true,true,true,1,1,2])
      if (policy === 'stateful') assert.equal(result.value.at(-1), 'function runs(){return counter.runs}')
      assert.equal(result.value.at(-1).includes('if(false)'), false)
      const later = await runRecordedCell(runtime, session, 'reuse-commonjs-evidence', {
        bindings: [], program: 'return [(await import("./value.cjs")).value,required.value,required.runs()]',
      })
      assert.equal(later.error, undefined, later.error?.message)
      assert.deepEqual(later.value, [1,2,1])
    })
  }
}
