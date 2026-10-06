import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uncoveredEnvironment } from '../subprocess-environment.js'

test('deployment environment cannot redirect compiler cache loading', async t => {
  const directory = process.env.NODE_V8_COVERAGE ?? await mkdtemp(join(tmpdir(), 'ptc-compiler-coverage-'))
  if (!process.env.NODE_V8_COVERAGE) t.after(() => rm(directory, { recursive: true, force: true }))
  const source = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    const service=await import(${JSON.stringify(new URL('../../internal/compiler-service.js', import.meta.url).href)});
    assert.equal(typeof service.prepareProgram('return 42',{languageSemantics:'stateful-v1'}).code,'string');
    assert.ok(service.compilerWorkerCache().data instanceof Uint8Array);
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NODE_V8_COVERAGE: directory, DSH_PTC_COMPILER_BYTECODE: join(directory, 'missing-bytecode') },
  })
  assert.equal(result.status, 0, result.stderr)
})

test('coverage entry keeps compiler instrumentation out of cached bytecode', () => {
  const source = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    vm.Script.prototype.createCachedData=function(){throw new Error('instrumented bytecode extraction')};
    await import(${JSON.stringify(new URL('../../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});
    const service=await import(${JSON.stringify(new URL('../../internal/compiler-service.js', import.meta.url).href)});
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
      ${covered ? `await import(${JSON.stringify(new URL('../../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});
      await import(${JSON.stringify(new URL('../../scripts/instrument-worker-coverage.mjs', import.meta.url).href)});` : ''}
      const {SessionRuntime}=await import(${JSON.stringify(new URL('../../internal/session-runtime.js', import.meta.url).href)});
      const runtime=new SessionRuntime({durableReplay:false,maxWallMs:10000});
      try {
        const result=await runtime.run('worker-entry',{bindings:[],program:
          'return {argv:process.argv,bytecodePath:process.env.DSH_PTC_COMPILER_BYTECODE ?? null}'});
        assert.equal(result.error,undefined,JSON.stringify(result.error));
        assert.equal(result.value.argv[1],fileURLToPath(${JSON.stringify(new URL('../../internal/kernel-worker.js', import.meta.url).href)}));
        assert.equal(result.value.bytecodePath,null);
        console.log(JSON.stringify(result.value));
      } finally { await runtime.dispose(); }
      const {UserBindingConsole}=await import(${JSON.stringify(new URL('../../internal/user-binding-console.js', import.meta.url).href)});
      const consoleOwner=new UserBindingConsole({cwd:process.cwd(),maxWallMs:10000,maxOutputBytes:65536,maxOldGenerationSizeMb:128});
      try {
        const result=await consoleOwner.run({source:'export const answer: number=42',code:
          'process.argv[1] === '+JSON.stringify(fileURLToPath(${JSON.stringify(new URL('../../internal/user-binding-console-worker.js', import.meta.url).href)}))});
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

test('coverage compiler seam preserves absent option isolation and real worker entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-covered-boundary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = `
    import assert from 'node:assert/strict';
    await import(${JSON.stringify(new URL('../../scripts/instrument-compiler-coverage.mjs', import.meta.url).href)});
    await import(${JSON.stringify(new URL('../../scripts/instrument-worker-coverage.mjs', import.meta.url).href)});
    const service=await import(${JSON.stringify(new URL('../../internal/compiler-service.js', import.meta.url).href)});
    Object.defineProperty(Object.prototype,'lineOffset',{configurable:true,get(){throw new Error('user lineOffset getter')}});
    try { assert.equal(typeof service.prepareProgram('return 42',{languageSemantics:'stateful-v1'}).code,'string'); }
    finally { delete Object.prototype.lineOffset; }
    const {UserBindingConsole}=await import(${JSON.stringify(new URL('../../internal/user-binding-console.js', import.meta.url).href)});
    const consoleOwner=new UserBindingConsole({cwd:process.cwd(),maxWallMs:10000,maxOutputBytes:65536,maxOldGenerationSizeMb:128});
    try {
      const result=await consoleOwner.run({source:'export const answer: number=42',code:'answer'});
      assert.equal(result.error,undefined,result.error);
      assert.equal(result.output,'42');
    } finally { await consoleOwner.dispose(); }
    const {SessionRuntime}=await import(${JSON.stringify(new URL('../../internal/session-runtime.js', import.meta.url).href)});
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
