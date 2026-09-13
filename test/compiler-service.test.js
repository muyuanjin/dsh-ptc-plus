import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { Script } from 'node:vm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModuleSource, compileDynamicSource, prepareProgram, prepareConsoleProgram, classifyDurability, compilerWorkerCache } from '../internal/compiler-service.js'
import { ModuleRewriteError } from '../internal/cell-rewriter.js'
import { PreflightError } from '../internal/cell-analysis-contract.js'
import { copyCompilerData } from '../internal/compiler-data.js'
import { SourceMapRuns, sourceOffsetAt } from '../internal/source-position-map.js'
import { loadManagedSource } from './managed-module-fixture.js'
import { uncoveredEnvironment } from './subprocess-environment.js'

test('compiler parsing waits for first use and keeps its captured constructor', () => {
  const source = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import {syncBuiltinESMExports} from 'node:module';
    const NativeScript=vm.Script;
    let parsed=0;
    vm.Script=class extends NativeScript {
      constructor(source,options){
        super(source,options);
        if(options?.filename?.endsWith('compiler-core.cjs'))parsed++;
      }
    };
    syncBuiltinESMExports();
    const service=await import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)});
    assert.equal(service.compilerWorkerCache(),undefined);
    assert.equal(parsed,0,'importing a runtime dependency parsed the compiler');
    vm.Script=class {constructor(){throw new Error('uncaptured Script')}};
    syncBuiltinESMExports();
    Object.defineProperty(Object.prototype,'cachedData',{configurable:true,
      get(){throw new Error('compiler read inherited Script options')}});
    assert.equal(typeof service.prepareProgram('return 42',{languageSemantics:'stateful-v1'}).code,'string');
    assert.equal(parsed,1);
    assert.equal(typeof service.prepareProgram('return 43',{languageSemantics:'stateful-v1'}).code,'string');
    assert.equal(parsed,1,'repeated operations reparsed the compiler');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(result.status, 0, result.stderr)
})

test('compiler bytecode matches exact source, isolates bytes and preserves coverage instrumentation', async t => {
  prepareProgram('const value=42; return value', { languageSemantics: 'stateful-v1' })
  const cache = compilerWorkerCache()
  const independent = compilerWorkerCache()
  assert.notEqual(cache.data, independent.data)
  independent.data.fill(0)
  assert.deepEqual(compilerWorkerCache().data, cache.data)
  const directory = process.env.NODE_V8_COVERAGE ?? await mkdtemp(join(tmpdir(), 'ptc-compiler-coverage-'))
  if (!process.env.NODE_V8_COVERAGE) t.after(() => rm(directory, { recursive: true, force: true }))
  const source = `
    const vm=require('node:vm');
    const {syncBuiltinESMExports}=require('node:module');
    const {parentPort,workerData}=require('node:worker_threads');
    const inherited=workerData.compilerCache;
    const NativeScript=vm.Script;
    let used=false,rejected=false;
    vm.Script=class extends NativeScript {constructor(source,options){
      super(source,options);
      if(options?.filename?.endsWith('compiler-core.cjs')){
        used=options.cachedData!==undefined;rejected=this.cachedDataRejected===true;
      }
    }};
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)}).then(service=>{
      if(workerData.compilerCache!==undefined)throw new Error('compiler cache was exposed');
      inherited.data.fill(0);
      const cell=service.prepareProgram('return 42',{languageSemantics:'stateful-v1'});
      parentPort.postMessage({used,rejected,code:typeof cell.code});
    });
  `
  for (const [name, compilerCache, covered, expected] of [
    ['matching', cache, false, { used: true, rejected: false }],
    ['changed source of equal length', { ...cache, source: `!${cache.source.slice(1)}` }, false, { used: false, rejected: false }],
    ['incompatible bytecode', { ...cache, data: new Script('1').createCachedData() }, false, { used: true, rejected: true }],
    ['coverage', cache, true, { used: false, rejected: false }],
  ]) {
    const worker = new Worker(source, { eval: true, workerData: { compilerCache },
      env: covered ? { ...process.env, NODE_V8_COVERAGE: directory } : uncoveredEnvironment() })
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', code => reject(new Error(`compiler probe exited before its result: ${code}`)))
      })
      assert.deepEqual(result, { ...expected, code: 'string' }, name)
      // Natural exit flushes the covered probe's actual implementation evidence.
      await new Promise((resolve, reject) => worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`compiler probe exited: ${code}`))))
    } finally { await worker.terminate() }
  }
})

test('coverage never extracts bytecode from an instrumented compiler instance', async t => {
  const directory = process.env.NODE_V8_COVERAGE ?? await mkdtemp(join(tmpdir(), 'ptc-compiler-coverage-'))
  if (!process.env.NODE_V8_COVERAGE) t.after(() => rm(directory, { recursive: true, force: true }))
  const source = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    vm.Script.prototype.createCachedData=function(){throw new Error('instrumented bytecode extraction')};
    const service=await import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)});
    assert.equal(typeof service.prepareProgram('return 42',{languageSemantics:'stateful-v1'}).code,'string');
    assert.equal(service.compilerWorkerCache(),undefined);
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NODE_V8_COVERAGE: directory, DSH_PTC_COMPILER_BYTECODE: undefined },
  })
  assert.equal(result.status, 0, result.stderr)
})

test('runtime entry imports keep compiler dependencies inside the private realm', () => {
  const source = String.raw`
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    registerHooks({load(url,context,next){
      if (/\/(?:node_modules\/(?:@babel\/(?:core|parser|traverse)|amaro|typescript)|internal\/(?:cell-analysis|module-compilation|native-root-compilation|commonjs-source-evidence)\.js)(?:\/|$)/.test(url))
        throw new Error('runtime loaded compiler source: '+url);
      return next(url,context);
    }});
    const {createNativeRootDynamic}=await import(${JSON.stringify(new URL('../internal/native-root-dynamic.js', import.meta.url).href)});
    assert.equal(typeof createNativeRootDynamic,'function');
    const {createReplValueObserver}=await import(${JSON.stringify(new URL('../internal/repl-value-observer.js', import.meta.url).href)});
    assert.equal(typeof createReplValueObserver,'function');
    const {createCommonJsEvidence}=await import(${JSON.stringify(new URL('../internal/commonjs-export-evidence.js', import.meta.url).href)});
    assert.match(createCommonJsEvidence().attach('file:///evidence.cjs','exports.value=1','exports.value=1'),/exports.value/);
    const {compileStatefulModule}=await import(${JSON.stringify(new URL('../internal/stateful-module-compiler.js', import.meta.url).href)});
    assert.equal(typeof compileStatefulModule('export const value=42').code,'string');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, result.stderr)
})

test('compiler data preserves collections, sparse arrays and packed source mappings without caller protocols', () => {
  const source = { map: new Map([['value', new Set([1, 2])]]), array: [1, , 3],
    mapping: new SourceMapRuns(new Uint32Array([0, 3, 5, 8])) }
  const copied = copyCompilerData(source)
  assert.deepEqual(copied, source)
  assert.notEqual(copied.map, source.map)
  assert.equal(sourceOffsetAt(copied.mapping, 2), 7)
  assert.throws(() => copyCompilerData({ callback() {} }), /must contain data/u)
  assert.throws(() => copyCompilerData({ get value() { throw new Error('must not run') } }), /must not contain accessors/u)
})

test('private compiler retains host error classes, source positions and binding facts', () => {
  assert.throws(() => prepareProgram('let value = ;', { languageSemantics: 'stateful-v1' }), error =>
    error instanceof ModuleRewriteError && error.cellPosition.line === 1)
  assert.throws(() => compileDynamicSource('const ='), SyntaxError)
  assert.throws(() => compileModuleSource('export const ='), SyntaxError)
  assert.throws(() => compileModuleSource('export const answer=42', { transform: 'unknown' }), TypeError)
  assert.throws(() => classifyDurability('import value from "node:worker_threads"', undefined, { sourceType: 'module' }), PreflightError)
  const cell = prepareProgram('const value=1;const value=2;value', { languageSemantics: 'stateful-v1',
    knownBindings: new Set(['existing']), establishedRoots: new Map([['existing', 'lexical']]) })
  assert.ok(cell.declared instanceof Set)
  assert.ok(cell.declared.has('value'))
  assert.ok(cell.imports instanceof Map)
})

test('console completion preserves common compilation facts and only returns the final expression', () => {
  const options = { languageSemantics: 'stateful-v1' }
  const consoleResult = prepareConsoleProgram('const value:number=41;value+1 // tail', options)
  const explicit = prepareProgram('const value:number=41;return (value+1); // tail', options)
  assert.deepEqual(consoleResult, explicit)
  assert.deepEqual(prepareConsoleProgram('const value:number=41;', options), prepareProgram('const value:number=41;', options))
  assert.throws(() => prepareConsoleProgram('const value=;', options), SyntaxError)
})

test('owned module eval and Function compile synchronously while the user changes Array.prototype.map', async t => {
  const module = await loadManagedSource(t, `export function evaluate(){
    const original=Array.prototype.map;
    try {Array.prototype.map=function(){throw new Error('user map called')};
      const direct=eval('1+1');const built=Function('return 6*7')();return [direct,built];
    } finally {Array.prototype.map=original}
  }`)
  assert.deepEqual(module.evaluate(), [2, 42])
})

test('cell results retain data after decorator and resource phases rebuild regions', () => {
  for (const languageSemantics of ['stateful-v1', 'protected-v1']) {
    for (const source of ['const decorate=v=>v;class Box{@decorate read(){return 1}}',
      'using value = {[Symbol.dispose](){}}; value']) {
      const prepared = prepareProgram(source, { languageSemantics, nativeUsing: false })
      assert.equal(structuredClone(prepared).code, prepared.code)
      assert.equal(prepared.sourceRegions?.allocate, undefined)
      assert.ok(prepared.rootBindings.callableSources.length > 0)
    }
  }
})

test('subsequent module and cell compilation do not invoke mutated caller collection operations', () => {
  const original = Array.prototype.map
  let module, cell, error
  try {
    Array.prototype.map = function () { throw new Error('user map called') }
    module = compileModuleSource('export const answer:number=42')
    cell = prepareProgram('const answer=42', { languageSemantics: 'stateful-v1' })
  } catch (failure) { error = failure } finally { Array.prototype.map = original }
  assert.ifError(error)
  assert.match(module.code, /answer/u)
  assert.ok(cell.declared.has('answer'))
})
