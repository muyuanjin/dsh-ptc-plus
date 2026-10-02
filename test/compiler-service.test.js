import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { Script } from 'node:vm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModuleSource, compileDynamicSource, prepareProgram, prepareConsoleProgram, classifyDurability, compilerWorkerCache } from '../internal/compiler-service.js'
import { isCompilerSyntaxError, detectModuleSourceFormat, identifier, exportedSymbols,
  sourceDurability, deflateText, inflateText, createCallableSourceCatalog } from '../internal/compiler-service.js'
import { USER_BINDING_TRANSFORM } from '../internal/module-transform-contract.js'
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
    ['coverage environment without a testing preload', cache, true, { used: true, rejected: false }],
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

test('deployment environment cannot redirect compiler cache loading', async t => {
  const directory = process.env.NODE_V8_COVERAGE ?? await mkdtemp(join(tmpdir(), 'ptc-compiler-coverage-'))
  if (!process.env.NODE_V8_COVERAGE) t.after(() => rm(directory, { recursive: true, force: true }))
  const source = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    const service=await import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)});
    assert.equal(typeof service.prepareProgram('return 42',{languageSemantics:'stateful-v1'}).code,'string');
    assert.ok(service.compilerWorkerCache().data instanceof Uint8Array);
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NODE_V8_COVERAGE: directory, DSH_PTC_COMPILER_BYTECODE: join(directory, 'missing-bytecode') },
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

test('coverage entry keeps compiler instrumentation out of cached bytecode', () => {
  const source = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    vm.Script.prototype.createCachedData=function(){throw new Error('instrumented bytecode extraction')};
    await import(${JSON.stringify(new URL('../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});
    const service=await import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)});
    assert.equal(typeof service.prepareProgram('return 42',{languageSemantics:'stateful-v1'}).code,'string');
    assert.equal(service.compilerWorkerCache().data.length,0);
    assert.throws(()=>new vm.Script('1').createCachedData(),/instrumented bytecode extraction/);
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, DSH_PTC_COMPILER_BYTECODE: '' },
  })
  assert.equal(result.status, 0, result.stderr)
})

test('covered runtime preserves ordinary worker argv and clears testing locators', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-worker-entry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const results = []
  for (const covered of [false, true]) {
    const source = `
      import assert from 'node:assert/strict';
      import {fileURLToPath} from 'node:url';
      ${covered ? `await import(${JSON.stringify(new URL('../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});
      await import(${JSON.stringify(new URL('../scripts/instrument-worker-coverage.mjs', import.meta.url).href)});` : ''}
      const {SessionRuntime}=await import(${JSON.stringify(new URL('../internal/session-runtime.js', import.meta.url).href)});
      const runtime=new SessionRuntime({durableReplay:false,maxWallMs:10000});
      try {
        const result=await runtime.run('worker-entry',{bindings:[],program:
          'return {argv:process.argv,bytecodePath:process.env.DSH_PTC_COMPILER_BYTECODE ?? null}'});
        assert.equal(result.error,undefined,JSON.stringify(result.error));
        assert.equal(result.value.argv[1],fileURLToPath(${JSON.stringify(new URL('../internal/kernel-worker.js', import.meta.url).href)}));
        assert.equal(result.value.bytecodePath,null);
        console.log(JSON.stringify(result.value));
      } finally { await runtime.dispose(); }
      const {UserBindingConsole}=await import(${JSON.stringify(new URL('../internal/user-binding-console.js', import.meta.url).href)});
      const consoleOwner=new UserBindingConsole({cwd:process.cwd(),maxWallMs:10000,maxOutputBytes:65536,maxOldGenerationSizeMb:128});
      try {
        const result=await consoleOwner.run({source:'export const answer: number=42',code:
          'process.argv[1] === '+JSON.stringify(fileURLToPath(${JSON.stringify(new URL('../internal/user-binding-console-worker.js', import.meta.url).href)}))});
        assert.equal(result.error,undefined,result.error);
        assert.equal(result.output,'true');
      } finally { await consoleOwner.dispose(); }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...uncoveredEnvironment(), DSH_PTC_TEST_WORKER_COVERAGE: covered ? '1' : '0',
        ...(covered ? { NODE_V8_COVERAGE: directory, DSH_PTC_COMPILER_BYTECODE: '' } : {}) },
    })
    assert.equal(result.status, 0, result.stderr)
    results.push(JSON.parse(result.stdout.trim()))
  }
  assert.deepEqual(results[1], results[0])
})

test('cold TypeScript platform encoding and decoding ignore caller typed-array length protocols', () => {
  for (const instrumented of [false, true]) {
    for (const mode of ['observe', 'zero', 'throw']) {
      const source = `
        import assert from 'node:assert/strict';
        ${instrumented ? `await import(${JSON.stringify(new URL('../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});` : ''}
        const service=await import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)});
        const {compilerPlatformBridge:platform}=await import(${JSON.stringify(new URL('../internal/compiler-platform.js', import.meta.url).href)});
        service.prepareProgram('return 42',{languageSemantics:'stateful-v1'});
        const prototype=Object.getPrototypeOf(Uint8Array.prototype);
        const descriptor=Object.getOwnPropertyDescriptor(prototype,'length');
        const apply=Reflect.apply;
        let calls=0,result,roundTrips;
        Object.defineProperty(prototype,'length',{__proto__:null,configurable:true,get(){
          calls++;
          if(${JSON.stringify(mode)}==='zero')this.fill(0);
          if(${JSON.stringify(mode)}==='throw')throw new Error('caller typed-array length');
          return apply(descriptor.get,this,[]);
        }});
        try{
          result=service.compileModuleSource('export const answer:number=42');
          roundTrips=['utf8','utf16le','base64'].map(encoding=>{
            const source=encoding==='base64'?'YW5zd2Vy':'answer';
            return platform.decode(platform.encode(source,encoding).buffer,encoding);
          });
        }finally{Object.defineProperty(prototype,'length',descriptor)}
        assert.equal(calls,0);
        assert.equal(typeof result.code,'string');
        assert.deepEqual(result,service.compileModuleSource('export const answer:number=42'));
        assert.deepEqual(roundTrips,['answer','answer','YW5zd2Vy']);
      `
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
        encoding: 'utf8', timeout: 30_000, env: { ...uncoveredEnvironment(), DSH_PTC_COMPILER_BYTECODE: '' },
      })
      assert.equal(result.status, 0, `${instrumented}/${mode}: ${result.stderr}`)
    }
  }
})

test('prepared testing cache export never consults caller typed-array length protocols', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-prepared-cache-export-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cachePath = join(directory, 'compiler-cache.bin')
  const prepared = spawnSync(process.execPath, ['scripts/compiler-bytecode.mjs', cachePath], {
    encoding: 'utf8', timeout: 30_000, env: { ...uncoveredEnvironment(), DSH_PTC_COMPILER_BYTECODE: '' },
  })
  assert.equal(prepared.status, 0, prepared.stderr)
  for (const instrumented of [false, true]) {
    for (const mode of ['observe', 'zero', 'throw']) {
      const source = `
        import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';
        import {deserialize} from 'node:v8';
        ${instrumented ? `await import(${JSON.stringify(new URL('../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});` : ''}
        const service=await import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)});
        service.prepareProgram('return 42',{languageSemantics:'stateful-v1'});
        const prototype=Object.getPrototypeOf(Uint8Array.prototype);
        const descriptor=Object.getOwnPropertyDescriptor(prototype,'length');
        const apply=Reflect.apply;
        let calls=0, exported;
        Object.defineProperty(prototype,'length',{configurable:true,get(){
          calls++;
          if(${JSON.stringify(mode)}==='zero')this.fill(0);
          if(${JSON.stringify(mode)}==='throw')throw new Error('user typed-array length');
          return apply(descriptor.get,this,[]);
        }});
        try{exported=service.compilerWorkerCache()}finally{Object.defineProperty(prototype,'length',descriptor)}
        assert.equal(calls,0);
        assert.ok(exported.data.some(value=>value!==0));
        const expected=deserialize(readFileSync(process.env.DSH_PTC_COMPILER_BYTECODE));
        if(${instrumented})assert.deepEqual(exported.data,new Uint8Array(expected.data));
        const independent=service.compilerWorkerCache();
        independent.data.fill(0);
        assert.deepEqual(service.compilerWorkerCache().data,exported.data);
      `
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
        encoding: 'utf8', timeout: 30_000, env: { ...uncoveredEnvironment(), DSH_PTC_COMPILER_BYTECODE: cachePath },
      })
      assert.equal(result.status, 0, `${instrumented}/${mode}: ${result.stderr}`)
    }
  }
})

test('coverage compiler seam preserves absent option isolation and real worker entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-covered-boundary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = `
    import assert from 'node:assert/strict';
    await import(${JSON.stringify(new URL('../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});
    await import(${JSON.stringify(new URL('../scripts/instrument-worker-coverage.mjs', import.meta.url).href)});
    const service=await import(${JSON.stringify(new URL('../internal/compiler-service.js', import.meta.url).href)});
    Object.defineProperty(Object.prototype,'lineOffset',{configurable:true,get(){throw new Error('user lineOffset getter')}});
    try { assert.equal(typeof service.prepareProgram('return 42',{languageSemantics:'stateful-v1'}).code,'string'); }
    finally { delete Object.prototype.lineOffset; }
    const {UserBindingConsole}=await import(${JSON.stringify(new URL('../internal/user-binding-console.js', import.meta.url).href)});
    const consoleOwner=new UserBindingConsole({cwd:process.cwd(),maxWallMs:10000,maxOutputBytes:65536,maxOldGenerationSizeMb:128});
    try {
      const result=await consoleOwner.run({source:'export const answer: number=42',code:'answer'});
      assert.equal(result.error,undefined,result.error);
      assert.equal(result.output,'42');
    } finally { await consoleOwner.dispose(); }
    const {SessionRuntime}=await import(${JSON.stringify(new URL('../internal/session-runtime.js', import.meta.url).href)});
    const runtime=new SessionRuntime({durableReplay:false,maxWallMs:10000});
    try {
      const result=await runtime.run('covered-prototype',{bindings:[],program:\`
        Object.defineProperty(Object.prototype,'lineOffset',{configurable:true,get(){throw new Error('user lineOffset getter')}});
        try { return eval('40+2'); } finally { delete Object.prototype.lineOffset; }
      \`});
      assert.equal(result.error,undefined,JSON.stringify(result.error));
      assert.equal(result.value,42);
      for (const member of ['Object.create','Object.getPrototypeOf','Object.getOwnPropertyDescriptors',
        'WeakSet.prototype.add','WeakSet.prototype.has','Buffer.from']) {
        const changed=await runtime.run('covered-intrinsic-'+member,{bindings:[],program:
          'const original='+member+';'+member+'=()=>{throw new Error("user intrinsic")};'+
          'try{return eval("40+2")}finally{'+member+'=original}'});
        assert.equal(changed.error,undefined,member+': '+JSON.stringify(changed.error));
        assert.equal(changed.value,42,member);
      }
      const descriptors=await runtime.run('covered-descriptors',{bindings:[],program:
        'Object.prototype.get=()=>7;try{return eval("40+2")}finally{delete Object.prototype.get}'});
      assert.equal(descriptors.error,undefined,JSON.stringify(descriptors.error));
      assert.equal(descriptors.value,42);
    } finally { await runtime.dispose(); }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...uncoveredEnvironment(), NODE_V8_COVERAGE: directory,
      DSH_PTC_TEST_WORKER_COVERAGE: '1', DSH_PTC_COMPILER_BYTECODE: '' },
  })
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

test('compiler service preserves source facts and transported error identity across its public operations', () => {
  const source = 'export function answer() { return 42 }'
  assert.equal(detectModuleSourceFormat(source), 'module')
  assert.equal(detectModuleSourceFormat('module.exports = 42'), 'commonjs')
  assert.equal(identifier('answer', 'binding name'), 'answer')
  assert.equal(exportedSymbols(source, USER_BINDING_TRANSFORM).get('answer').name, 'answer')
  assert.equal(sourceDurability(source, USER_BINDING_TRANSFORM).durability, 'durable')
  const text = '中文\u0000\ud800 callable source'
  assert.equal(inflateText(deflateText(text), text.length * 2), text)
  assert.equal(createCallableSourceCatalog([source], [[0, 0, source.length, 0, 0, source.length]]).length, 1)
  assert.equal(isCompilerSyntaxError(new SyntaxError('native')), true)
  assert.equal(isCompilerSyntaxError(new TypeError('native')), false)
  assert.throws(() => inflateText('invalid compressed input', 32), error =>
    error instanceof Error && Number.isInteger(error.code))
  assert.throws(() => compileDynamicSource('(function transportFault(){return 42})', {
    resolveOriginalSource() {
      const error = new Error('source resolver failed')
      error.name = 'SourceResolverFault'
      throw error
    },
  }), error => error instanceof Error && error.name === 'SourceResolverFault'
    && error.message === 'source resolver failed')
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
