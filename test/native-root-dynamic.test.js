import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createNativeRootDynamic } from '../internal/native-root-dynamic.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'
import { orderedSurfaceSession, runRecordedCell } from './plugin-fixture.js'

test('native root eval validates declarations atomically and preserves actual realm properties', () => {
  const context = createContext()
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const owner = createNativeRootDynamic({ intrinsics,
    read: name => runInContext(name, context),
    typeOf: name => runInContext(`typeof ${name}`, context),
    remove: name => runInContext(`delete ${name}`, context),
    write(name, value, strict) {
      runInContext(`${strict ? '"use strict";' : ''}value=>${name}=value`, context)(value)
    },
  })
  const environment = owner.environment([])
  const run = source => environment.reference('eval').evalInvocation(environment, [source])()
  assert.equal(run('var removable=7;removable'), 7)
  assert.equal(runInContext('removable', context), 7)
  assert.equal(run('delete removable'), true)
  assert.equal(run('typeof removable'), 'undefined')
  assert.throws(() => run('removable'), intrinsics.errors.ReferenceError)
  runInContext('let protectedName=3', context)
  assert.throws(() => run('var neverCreated,protectedName'), intrinsics.errors.SyntaxError)
  assert.equal(runInContext('typeof neverCreated', context), 'undefined')
  assert.equal(run('Function("return protectedName")()'), 3)
  assert.throws(() => run('"use strict";missing=1'), intrinsics.errors.ReferenceError)
  assert.equal(runInContext('eval', context), intrinsics.intrinsicEval)
  assert.equal(runInContext('Function', context), intrinsics.realmFunction)
})

test('native await frames separate persistent roots from eval vars and retain inner lexical precedence', () => {
  const context = createContext()
  runInContext('let value=1;var ordinary=2;function hoisted(){return 3}', context)
  const intrinsics = runInContext('({intrinsicEval:eval,realmFunction:Function,globalObject:globalThis,errors:{ReferenceError,TypeError,SyntaxError},reflect:Reflect,object:Object})', context)
  const owner = createNativeRootDynamic({ intrinsics,
    read: name => runInContext(name, context),
    typeOf: name => runInContext(`typeof ${name}`, context),
    remove: name => runInContext(`delete ${name}`, context),
    write(name, value, strict) { runInContext(`${strict ? '"use strict";' : ''}value=>${name}=value`, context)(value) },
  })
  const bindings = new Map([['value', 'let'], ['ordinary', 'var'], ['hoisted', 'hoisted']].map(([name, kind]) => [name, {
    kind, get: () => runInContext(name, context), set: value => runInContext(`value=>${name}=value`, context)(value),
  }]))
  const root = owner.environment([], true).capture([bindings], false, 0)
  const evaluate = (environment, source) => environment.reference('eval').evalInvocation(environment, [source])()
  assert.equal(evaluate(root, 'var value=4,ordinary=5;value+ordinary'), 9)
  assert.equal(runInContext('value+ordinary', context), 3)
  assert.equal(root.initialize('value', 6), 6)
  assert.equal(evaluate(root, 'value'), 6)
  assert.equal(runInContext('value', context), 1)
  assert.equal(evaluate(root.capture([bindings], false, 0), 'hoisted()'), 3)
  assert.equal(evaluate(root, 'var hoisted=7;hoisted'), 7)
  assert.equal(runInContext('hoisted', context), 7)
  assert.equal(evaluate(root, 'delete value'), true)
  assert.equal(evaluate(root, 'value'), 1)
  const block = root.capture([[['value', { kind: 'let', get: () => 8 }]]])
  assert.equal(evaluate(block.at('block').context({ strict: false }), 'value'), 8)
  assert.throws(() => evaluate(block, 'var value=9'), intrinsics.errors.SyntaxError)
  const withObject = root.withObject({ ordinary: 10 })
  assert.equal(evaluate(withObject, 'ordinary'), 10)
  assert.equal(evaluate(owner.environment([], true), 'typeof value'), 'number')
})

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-native-dynamic-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'value.mjs'), 'export const value=42')
  const runtime = new SessionRuntime({ legacyBindingSettings: true, durableReplay: false, maxWallMs: 10_000 }, { userBindingsCwd: cwd })
  t.after(() => runtime.dispose())
  const userBindings = createUserBindingsSnapshot({ entries: [{ id: 'helpers', name: 'helpers', scope: 'namespace',
    enabled: true, purpose: '', source: `import {value as imported} from './value.mjs';export const value=imported` }] })
  const session = orderedSurfaceSession('native-root-dynamic')
  session.header = { cwd }
  let call = 0
  return { runtime, async run(program) {
    const result = await runRecordedCell(runtime, session, `native-root-${++call}`, {
      program, bindings: [], userBindings,
    })
    assert.equal(result.error, undefined, result.error?.message)
    return result.value
  } }
}

test('legacy runtime-created imports use managed namespaces through direct and opaque native calls', async t => {
  const { run } = await fixture(t)
  assert.deepEqual(await run(`
    const evaluated=eval("import('./value.mjs')");
    const constructed=Function("return import('./value.mjs')")();
    const mapped=["import('./value.mjs')"].map(eval)[0];
    const continued=Promise.resolve("import('./value.mjs')").then(eval);
    const all=await Promise.all([evaluated,constructed,mapped,continued]);
    return [helpers.value,...all.map(ns=>ns.value),all.every(ns=>ns===all[0]),
      evaluated instanceof Promise,constructed instanceof Promise,mapped instanceof Promise,continued instanceof Promise]`),
  [42,42,42,42,42,true,true,true,true,true])
})

test('legacy direct eval preserves native lexical, var, strict and custom callee semantics', async t => {
  const { run } = await fixture(t)
  assert.deepEqual(await run(`
    let outer=4;const fixed=7;
    function local(){let value=3;eval('value++;var introduced=8');return [value,introduced]}
    function strict(){'use strict';eval('var hidden=1');return typeof hidden}
    function custom(){const eval=value=>value;return eval('import(1)')}
    eval('var created=9');
    let readonly=false,syntax=false;
    try{eval('const fixed=7;fixed=8')}catch(error){readonly=error instanceof TypeError}
    try{eval('const value=1;const value=2')}catch(error){syntax=error instanceof SyntaxError}
    return [local(),strict(),custom(),created,readonly,syntax,eval('outer'),Function('return outer')()]`),
  [[4,8],'undefined','import(1)',9,true,true,4,4])
  assert.deepEqual(await run(`return [created,outer,Function('return eval')()===eval,
    Function===Object.getOwnPropertyDescriptor(Function.prototype,'constructor').value]`), [9,4,true,true])
  assert.deepEqual(await run(`eval('var removable=1');const before=removable;
    const removed=eval('delete removable');return [before,removed,eval('typeof removable')]`), [1,true,'undefined'])
})

test('escaped legacy interfaces and closures keep native roots across stateful activation', async t => {
  const { run, runtime } = await fixture(t)
  assert.deepEqual(await run(`
    let value=7;const savedEval=eval,savedFunction=Function,savedSource=Function.prototype.toString;
    function identities(){return [savedEval===eval,savedFunction===Function,savedSource===Function.prototype.toString]}
    function previous(){const local=41;return eval('local')}
    function indirect(){return ['value','typeof logicalOnly'].map(eval)}
    async function escaped(signal){await signal;return [await Promise.resolve('value').then(eval),previous(),identities()]}
    const source=previous.toString();
    return [previous(),indirect(),identities()]`), [41,[7,'undefined'],[true,true,true]])
  runtime.reconfigure({ bindingUpdates: 'stateful', durableReplay: false, maxWallMs: 10_000 })
  assert.deepEqual(await run(`let logicalOnly=99;return [logicalOnly,indirect(),await escaped(Promise.resolve()),identities(),previous.toString()===source]`),
    [99,[7,'undefined'],[7,41,[true,true,true]],[true,true,true],true])
  runtime.reconfigure({ legacyBindingSettings: true, durableReplay: false, maxWallMs: 10_000 })
  assert.deepEqual(await run(`return [previous(),indirect(),identities(),savedFunction===Function,savedEval===eval,
    Function('return eval')()===eval]`), [41,[7,'undefined'],[true,true,true],true,true,true])
})
