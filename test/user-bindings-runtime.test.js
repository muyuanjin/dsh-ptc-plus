import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'
import { LEGACY_USER_BINDING_TRANSFORM } from '../internal/typescript-transform.js'
import { LIVE_USER_BINDINGS_SHADOW_POLICY } from '../internal/session-journal-schema.js'
import { interceptWorkerMessages, interceptWorkerPosts, restartWorker } from './runtime-observation.js'

function withoutReuse(entry) {
  const { reuseCount, ...rest } = entry
  return rest
}

function binding(id, name, scope, source) {
  return { id, name, scope, source, purpose: '', enabled: true }
}

function snapshot(entries, revision = 1) {
  return createUserBindingsSnapshot({ entries }, revision)
}

function perNameRuntime(t, entries, config = {}) {
  const runtime = new SessionRuntime(config)
  t.after(() => runtime.dispose())
  const selected = snapshot(entries)
  return async (program, userBindings = selected, bindings = []) => {
    const execution = await runtime.runTentative('per-name', { program, userBindings, bindings })
    runtime.finalize(execution.settlement, true)
    return execution
  }
}

function nameStates(execution) {
  assert.equal(execution.settlement.journal.userBindingsShadowPolicy, LIVE_USER_BINDINGS_SHADOW_POLICY)
  return Object.fromEntries(execution.settlement.journal.userBindingNames.map(fact => [fact.name, fact.state]))
}

test('runtime TypeScript value exports activate through both binding scopes', async t => {
  for (const scope of ['namespace', 'top-level']) await t.test(scope, async t => {
    const run = perNameRuntime(t, [binding('typed', 'typed', scope, `
      export const enum Kind { A=1 }; export const enum Kind { B=2 };
      export namespace Helpers { export function read(){return Kind.A} };
      export namespace Helpers { export const count=2 };
    `)])
    const prefix = scope === 'namespace' ? 'typed.' : ''
    const first = await run(`return [${prefix}Kind.A,${prefix}Kind.B,${prefix}Helpers.read(),${prefix}Helpers.count]`)
    assert.equal(first.result.error, undefined, first.result.error?.message)
    assert.deepEqual(first.result.value, [1,2,1,2])
    const later = await run(`${prefix}Kind.A=3;return ${prefix}Helpers.read()`)
    assert.equal(later.result.error, undefined, later.result.error?.message)
    assert.equal(later.result.value, 3)
  })
})

test('retained provider setters can restore local values after disabled cells without losing other bindings', async t => {
  for (const [label, disabled] of [['feature disabled', undefined], ['empty catalog', snapshot([])]]) {
    await t.test(label, async t => {
      const runtime = new SessionRuntime()
      t.after(() => runtime.dispose())
      const selected = snapshot([binding('alpha', 'alpha', 'top-level', 'export const alpha = 1')])
      const run = async (program, userBindings) => {
        const execution = await runtime.runTentative('retained-setter', { program, userBindings, bindings: [] })
        runtime.finalize(execution.settlement, true)
        assert.equal(execution.result.error, undefined, execution.result.error?.message)
        return execution
      }
      await run('const savedSetter = Object.getOwnPropertyDescriptor(this, "alpha").set; const retained = 42; return alpha', selected)
      for (let index = 0; index < 2; index++) {
        const idle = await run('return [typeof alpha, retained]', disabled)
        assert.deepEqual(idle.result.value, ['undefined', 42])
        assert.deepEqual(nameStates(idle), {})
        assert.equal(idle.settlement.replMemory.entries.some(entry => entry.name === 'alpha'), false)
      }
      const assigned = await run('savedSetter.call(this, 7); return [alpha, retained]', disabled)
      assert.deepEqual(assigned.result.value, [7, 42])
      assert.deepEqual(nameStates(assigned), { alpha: 'local' })
      assert.deepEqual((await run('return [alpha, retained]', disabled)).result.value, [7, 42])
    })
  }
})

test('retained setters preserve receivers and local values through source replacement and reactivation', async t => {
  const initial = snapshot([binding('alpha', 'alpha', 'top-level', 'export const alpha = 1')])
  const replacements = [
    ['removed entry', snapshot([binding('other', 'other', 'top-level', 'export const beta = 2')], 2), 'undefined'],
    ['removed export', snapshot([binding('alpha', 'alpha', 'top-level', 'export const beta = 2')], 2), 'undefined'],
    ['changed source', snapshot([binding('alpha', 'alpha', 'top-level', 'export const alpha = 10')], 2), 'number'],
  ]
  for (const [label, replacement, type] of replacements) await t.test(label, async t => {
    const run = perNameRuntime(t, [])
    await run('const savedSetter = Object.getOwnPropertyDescriptor(this, "alpha").set; const retained = 42;', initial)
    const changed = await run('return typeof alpha', replacement)
    assert.equal(changed.result.value, type)
    const other = await run('const receiver = {}; savedSetter.call(receiver, 8); return [receiver.alpha, typeof alpha, retained]', replacement)
    assert.deepEqual(other.result.value, [8, type, 42])
    assert.equal(nameStates(other).alpha, type === 'undefined' ? undefined : 'provider')
    const assigned = await run('savedSetter.call(this, 7); return [alpha, retained]', replacement)
    assert.equal(assigned.result.error, undefined)
    assert.deepEqual(assigned.result.value, [7, 42])
    assert.equal(nameStates(assigned).alpha, 'local')
    const absent = await run('delete this.alpha; return [typeof alpha, retained]', snapshot([], 3))
    assert.deepEqual(absent.result.value, ['undefined', 42])
    assert.deepEqual(nameStates(absent), { alpha: 'absent' })
    assert.equal(absent.settlement.replMemory.entries.some(entry => entry.name === 'alpha'), false)
    const restored = await run('savedSetter.call(this, 9); return [alpha, retained]', initial)
    assert.deepEqual(restored.result.value, [9, 42])
    assert.deepEqual(nameStates(restored), { alpha: 'local' })
    assert.deepEqual((await run('return [alpha, retained]', initial)).result.value, [9, 42])
  })
})

test('historical setter eligibility neither accepts stale providers nor survives unproved activation or reset', async t => {
  const selected = snapshot([binding('alpha', 'alpha', 'top-level', 'export const alpha = 1')])
  for (const mode of ['unknown name', 'stale provider', 'failed activation', 'preflight rejection', 'unconfirmed activation after reset', 'worker reset']) {
    await t.test(mode, async t => {
      const runtime = new SessionRuntime({ durableReplay: mode === 'unconfirmed activation after reset' })
      t.after(() => runtime.dispose())
      const run = async (program, userBindings) => {
        const execution = await runtime.runTentative('unproved-setter', { program, userBindings, bindings: [] })
        runtime.finalize(execution.settlement, true)
        return execution
      }
      await run('void 0', undefined)
      if (mode === 'failed activation') {
        const failed = await run('void 0', snapshot([binding('alpha', 'alpha', 'top-level', 'throw new Error("init failed"); export const alpha = 1')]))
        assert.match(failed.result.logs.join('\n'), /init failed/)
        assert.deepEqual(failed.settlement.userBindings.entries, [])
      } else if (mode === 'preflight rejection') {
        const rejected = await run('const =', selected)
        assert.equal(rejected.result.error.kind, 'exception')
        assert.equal(rejected.settlement.journal.status, 'noop')
      } else if (mode === 'unconfirmed activation after reset') {
        const discarded = await runtime.runTentative('unproved-setter', { program: 'const savedSetter = Object.getOwnPropertyDescriptor(this, "alpha").set', userBindings: selected, bindings: [] })
        assert.equal(discarded.result.error, undefined)
        runtime.finalize(discarded.settlement, false)
        await restartWorker(runtime, 'unproved-setter')
      } else {
        await run('const savedSetter = Object.getOwnPropertyDescriptor(this, "alpha").set;', selected)
        if (mode === 'worker reset') await restartWorker(runtime, 'unproved-setter')
      }
      const idle = await run('return [typeof alpha, typeof savedSetter]', undefined)
      assert.deepEqual(idle.result.value, ['undefined', ['unknown name', 'stale provider'].includes(mode) ? 'function' : 'undefined'])
      const intercepted = interceptWorkerMessages(runtime, 'unproved-setter', (message, deliver) => {
        if (message.type === 'done') message.userBindingNames.push(mode === 'stale provider'
          ? { name: 'alpha', state: 'provider', entryId: 'alpha' }
          : { name: mode === 'unknown name' ? 'neverInstalled' : 'alpha', state: 'local' })
        deliver(message)
      })
      const forged = await run('void 0', undefined)
      intercepted.restore()
      assert.equal(forged.result.error.kind, 'worker-exit')
      assert.match(forged.result.error.message, /invalid ownership/)
      assert.equal(forged.settlement.journal.status, 'discarded')
      assert.equal(forged.settlement.journal.userBindingNames, null)
    })
  }
})

test('preserves imported alias provenance when a refreshed user binding snapshot is attached', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const first = snapshot([])
  const second = snapshot([binding('pair', 'pair', 'top-level', 'export const alpha = 1; export const beta = 2')], 2)
  const imported = await runtime.runTentative('import-alias', {
    program: 'import { basename as alpha } from "node:path"; return alpha("/a")',
    userBindings: first, bindings: [],
  })
  runtime.finalize(imported.settlement, true)
  assert.equal(imported.result.value, 'a')
  const attached = await runtime.runTentative('import-alias', {
    program: 'return [alpha("/b"), beta]',
    userBindings: second, bindings: [],
  })
  runtime.finalize(attached.settlement, true)
  assert.deepEqual(attached.result.value, ['b', 2])
  const definition = withoutReuse(imported.settlement.replMemory.entries.find(entry => entry.name === 'alpha'))
  assert.deepEqual(definition, {
    name: 'alpha', kind: 'import',
    definition: { source: 'import { basename as alpha } from "node:path";', line: 1, column: 1 },
  })
  assert.deepEqual(nameStates(attached), { alpha: 'local', beta: 'provider' })
  assert.deepEqual(withoutReuse(attached.settlement.replMemory.entries.find(entry => entry.name === 'alpha')), definition)
  const continued = await runtime.runTentative('import-alias', {
    program: 'return [alpha("/c"), beta]',
    userBindings: second, bindings: [],
  })
  runtime.finalize(continued.settlement, true)
  assert.deepEqual(continued.result.value, ['c', 2])
  assert.deepEqual(nameStates(continued), { alpha: 'local', beta: 'provider' })
  assert.deepEqual(withoutReuse(continued.settlement.replMemory.entries.find(entry => entry.name === 'alpha')), definition)
})

test('protected import aliases keep live values, readonly writes and definitions through provider lifecycle changes', async t => {
  for (const style of ['named', 'default', 'namespace']) await t.test(style, async t => {
    const run = perNameRuntime(t, [], { bindingUpdates: 'protected' })
    const moduleUrl = `data:text/javascript,${encodeURIComponent(`
let current = { count: 1 }
export { current as named, current as default }
export function bump() { current = { count: current.count + 1 } }
`)}`
    const declaration = style === 'named' ? `import { named as alpha, bump } from ${JSON.stringify(moduleUrl)};`
      : style === 'default' ? `import alpha, { bump } from ${JSON.stringify(moduleUrl)};`
        : `import * as alpha from ${JSON.stringify(moduleUrl)};`
    const read = style === 'namespace' ? 'alpha.named' : 'alpha'
    const bump = style === 'namespace' ? 'alpha.bump()' : 'bump()'
    const imported = await run(`${declaration} const saved = ${read}; const read = () => ${read}; const savedAlias = alpha;`)
    assert.equal(imported.result.error, undefined)
    const definition = { name: 'alpha', kind: 'import', definition: { source: declaration, line: 1, column: 1 } }
    assert.deepEqual(withoutReuse(imported.settlement.replMemory.entries.find(entry => entry.name === 'alpha')), definition)
    const provider = seed => binding('pair', 'pair', 'top-level',
      `export const alpha = ${seed}; export let beta = ${seed}; export function step() { return ++beta }`)
    const initial = snapshot([provider(2)])
    const updated = snapshot([provider(20)], 2)
    const assertSources = (execution, enabled) => {
      assert.equal(execution.result.error, undefined)
      assert.deepEqual(nameStates(execution), enabled
        ? { alpha: 'local', beta: 'provider', step: 'provider' } : { alpha: 'local' })
      assert.deepEqual(withoutReuse(execution.settlement.replMemory.entries.find(entry => entry.name === 'alpha')), definition)
    }
    const attached = await run(`${bump}; const savedStep = step; return [${read}.count, read() === ${read}, saved.count, alpha === savedAlias, step(), beta]`, initial)
    assert.deepEqual(attached.result.value, [2, true, 1, style === 'namespace', 3, 3])
    assertSources(attached, true)
    const next = await run(`return [${read}.count, read() === ${read}, step === savedStep, beta]`, initial)
    assert.deepEqual(next.result.value, [2, true, true, 3])
    assertSources(next, true)
    const readonly = await run('alpha = 42', initial)
    assert.equal(readonly.result.error.kind, 'exception')
    assert.match(readonly.result.error.message, /constant variable|read.?only/i)
    assert.deepEqual(nameStates(readonly), { alpha: 'local', beta: 'provider', step: 'provider' })
    assert.deepEqual(withoutReuse(readonly.settlement.replMemory.entries.find(entry => entry.name === 'alpha')), definition)
    const changed = await run(`return [${read}.count, step === savedStep, step(), savedStep(), beta]`, updated)
    assert.deepEqual(changed.result.value, [2, false, 21, 4, 21])
    assertSources(changed, true)
    for (const removed of [snapshot([{ ...provider(20), enabled: false }], 3), snapshot([], 4)]) {
      const inactive = await run(`return [${read}.count, read() === ${read}, typeof beta, savedStep()]`, removed)
      assert.deepEqual(inactive.result.value.slice(0, 3), [2, true, 'undefined'])
      assertSources(inactive, false)
    }
    const enabled = await run(`${bump}; return [${read}.count, saved.count, read() === ${read}, beta, step(), savedStep()]`, updated)
    assert.deepEqual(enabled.result.value, [3, 1, true, 20, 21, 7])
    assertSources(enabled, true)
  })
})

test('stateful import overrides retain their actual source through provider updates and reimport', async t => {
  const run = perNameRuntime(t, [])
  const source = 'import {sep as alpha} from "node:path"'
  await run(`${source}; const read=()=>alpha`)
  const selected = seed => snapshot([binding('pair', 'pair', 'top-level', `export const alpha=${seed}; export const beta=${seed+1}`)], seed)
  const written = await run('alpha=42; return [read(),beta]', selected(1))
  assert.deepEqual(written.result.value, [42,2])
  assert.equal(withoutReuse(written.settlement.replMemory.entries.find(entry => entry.name === 'alpha')).definition.source, 'alpha=42')
  assert.deepEqual(nameStates(written), {alpha:'local',beta:'provider'})
  assert.deepEqual((await run('return [read(),beta]', selected(10))).result.value, [42,11])
  assert.deepEqual((await run('return [read(),typeof beta]', snapshot([]))).result.value, [42,'undefined'])
  const restored = await run(`${source}; return [typeof read(),beta]`, selected(20))
  assert.deepEqual(restored.result.value, ['string',21])
  assert.equal(withoutReuse(restored.settlement.replMemory.entries.find(entry => entry.name === 'alpha')).kind, 'import')
  assert.deepEqual(nameStates(restored), {alpha:'local',beta:'provider'})
})

test('synthetic default aliases retain their original definition and live readonly association beside providers', async t => {
  const run = perNameRuntime(t, [], { looseTopLevelRedeclarations: false })
  const declaration = 'export default { count: 1 }'
  const imported = await run(`${declaration}\nconst saved = __default; const read = () => __default;`)
  assert.equal(imported.result.error, undefined)
  const definition = withoutReuse(imported.settlement.replMemory.entries.find(entry => entry.name === '__default'))
  assert.equal(definition.definition.source, declaration)
  const selected = snapshot([binding('pair', 'pair', 'top-level', 'export const __default = 10; export const beta = 2')])
  const attached = await run('return [__default === saved, read() === saved, beta]', selected)
  assert.deepEqual(attached.result.value, [true, true, 2])
  assert.deepEqual(nameStates(attached), { __default: 'local', beta: 'provider' })
  assert.deepEqual(withoutReuse(attached.settlement.replMemory.entries.find(entry => entry.name === '__default')), definition)
  const rejected = await run('__default = 42', selected)
  assert.match(rejected.result.error.message, /constant variable|read.?only/i)
  assert.deepEqual(nameStates(rejected), { __default: 'local', beta: 'provider' })
  assert.deepEqual(withoutReuse(rejected.settlement.replMemory.entries.find(entry => entry.name === '__default')), definition)
  const continued = await run('__default.count++; return [__default.count, read() === saved, beta]', selected)
  assert.deepEqual(continued.result.value, [2, true, 2])
  assert.deepEqual(nameStates(continued), { __default: 'local', beta: 'provider' })
  assert.deepEqual(withoutReuse(continued.settlement.replMemory.entries.find(entry => entry.name === '__default')), definition)
})

test('synthetic import source proof never invokes a namespace member accessor', async t => {
  const runtime = new SessionRuntime({ legacyBindingSettings: true })
  t.after(() => runtime.dispose())
  const run = async (program, userBindings) => {
    const execution = await runtime.runTentative('import-getter-proof', { program, userBindings, bindings: [] })
    runtime.finalize(execution.settlement, true)
    return execution
  }
  const imported = await run('export default 1\nlet getterCalls = 0;', snapshot([]))
  assert.equal(imported.result.error, undefined)
  const definition = withoutReuse(imported.settlement.replMemory.entries.find(entry => entry.name === '__default'))
  // Replace the synthetic namespace member through its structured compiler
  // association. Source proof must read only the initialized lexical slot.
  const intercepted = interceptWorkerPosts(runtime, 'import-getter-proof', message => {
    if (message.type !== 'run') return message
    const namespace = message.importBindingNamespaces.get('__default')
    return { ...message, program: `Object.defineProperty(${namespace}, "default", { get() { getterCalls++; throw new Error("export getter invoked") } }); ${message.program}` }
  })
  t.after(intercepted.restore)
  const armed = await run('void 0', snapshot([]))
  intercepted.restore()
  assert.equal(armed.result.error, undefined)
  const selected = snapshot([binding('pair', 'pair', 'top-level', 'export const __default = 10; export const beta = 2')])
  for (let index = 0; index < 2; index++) {
    const observed = await run('return [getterCalls, beta]', selected)
    assert.deepEqual(observed.result.value, [0, 2])
    assert.deepEqual(nameStates(observed), { __default: 'local', beta: 'provider' })
    assert.deepEqual(withoutReuse(observed.settlement.replMemory.entries.find(entry => entry.name === '__default')), definition)
  }
  const read = await run('return __default', selected)
  assert.match(read.result.error.message, /export getter invoked/)
  assert.deepEqual(nameStates(read), { __default: 'local', beta: 'provider' })
  assert.deepEqual(withoutReuse(read.settlement.replMemory.entries.find(entry => entry.name === '__default')), definition)
  assert.equal((await run('return getterCalls', selected)).result.value, 1)
})

test('import aliases with uninitialized compiler namespace slots stay unknown and unavailable', async t => {
  for (const storage of ['absent', 'tdz', 'property']) {
    await t.test(storage, async t => {
      const runtime = new SessionRuntime({ legacyBindingSettings: true })
      t.after(() => runtime.dispose())
      await runtime.run('missing-import-slot', { program: 'void 0', bindings: [] })
      // Fail before namespace capture while retaining the authoritative import
      // plan, so a static alias alone cannot prove runtime initialization.
      const intercepted = interceptWorkerPosts(runtime, 'missing-import-slot', message => {
        if (message.type !== 'run') return message
        const namespace = message.preparedImportBindingNamespaces.get('alpha')
        const program = storage === 'tdz'
          ? `throw new Error("namespace capture failed"); const ${namespace} = {};`
          : storage === 'property'
            ? `globalThis.storageGetterCalls = 0; Object.defineProperty(globalThis, ${JSON.stringify(namespace)}, { configurable: true, get() { globalThis.storageGetterCalls++; throw new Error("storage getter invoked") } }); throw new Error("namespace capture failed");`
            : 'throw new Error("namespace capture failed");'
        return { ...message, program }
      })
      t.after(intercepted.restore)
      const failed = await runtime.runTentative('missing-import-slot', {
        program: 'import { basename as alpha } from "node:path";', userBindings: snapshot([]), bindings: [],
      })
      runtime.finalize(failed.settlement, true)
      intercepted.restore()
      assert.match(failed.result.error.message, /namespace capture failed/)
      const selected = snapshot([binding('pair', 'pair', 'top-level', 'export const alpha = 1; export const beta = 2')])
      const attached = await runtime.runTentative('missing-import-slot', { program: 'return [beta, globalThis.storageGetterCalls ?? 0]', userBindings: selected, bindings: [] })
      runtime.finalize(attached.settlement, true)
      assert.deepEqual(attached.result.value, [2, 0])
      assert.deepEqual(nameStates(attached), { alpha: 'unknown', beta: 'provider' })
      assert.equal(attached.settlement.replMemory.entries.some(entry => entry.name === 'alpha'), false)
      const read = await runtime.runTentative('missing-import-slot', { program: 'return alpha', userBindings: selected, bindings: [] })
      runtime.finalize(read.settlement, true)
      assert.equal(read.result.error.kind, 'exception')
      assert.deepEqual(nameStates(read), { alpha: 'unknown', beta: 'provider' })
      assert.equal(read.settlement.replMemory.entries.some(entry => entry.name === 'alpha'), false)
    })
  }
})

test('same-value writes detach one export while module closures, aliases and sibling live reads retain identity', async t => {
  const run = perNameRuntime(t, [binding('pair', 'pair', 'top-level', `
export let alpha = { count: 1 }
export let beta = 0
export const current = () => alpha
export function bump() { alpha = { count: alpha.count + 1 }; return ++beta }
`)])
  const first = await run('const saved = alpha; const read = () => alpha; const oldBump = bump; alpha.count++; return [current() === saved, saved.count]')
  assert.deepEqual(first.result.value, [true, 2])
  assert.equal(nameStates(first).alpha, 'provider')
  const same = await run('alpha = alpha; bump(); return [alpha === saved, read() === saved, current() === saved, beta, bump === oldBump]')
  assert.deepEqual(same.result.value, [true, true, false, 1, true])
  assert.equal(nameStates(same).alpha, 'local')
  assert.equal(nameStates(same).beta, 'provider')
  const next = await run('bump(); return [beta, alpha.count, current().count, bump === oldBump]')
  assert.deepEqual(next.result.value, [2, 2, 4, true])
  assert.deepEqual(next.settlement.userBindings.entries[0].symbols, ['alpha', 'beta', 'current', 'bump'])
  assert.ok(next.settlement.replMemory.entries.some(entry => entry.name === 'alpha'))
})

test('logical short circuits and failing initializers never turn a planned declaration into a provider override', async t => {
  const run = perNameRuntime(t, [binding('pair', 'pair', 'top-level', 'export let alpha = 7; export let beta = 0')])
  for (const program of [
    'alpha ||= 99; beta &&= 99;',
    'alpha ??= 99;',
    'return; const alpha = 99;',
    'throw new Error("before"); const alpha = 99;',
    'const alpha = (() => { throw new Error("rhs") })();',
    'alpha = (() => { throw new Error("assignment-rhs") })();',
    'class alpha extends (() => { throw new Error("class") })() {}',
    'if (false) { var alpha = 99 }',
    '{ let alpha = 99; alpha++ }',
  ]) {
    const result = await run(program)
    assert.notEqual(result.result.error?.kind, 'worker-exit', program)
    assert.deepEqual(nameStates(result), { alpha: 'provider', beta: 'provider' }, program)
  }
  assert.deepEqual((await run('return [alpha, beta]')).result.value, [7, 0])
  const written = await run('alpha &&= 7; beta ||= 0;')
  assert.deepEqual(nameStates(written), { alpha: 'local', beta: 'local' })
})

test('nullish same-value writes and invalid result encoding preserve actual name facts and live state', async t => {
  const run = perNameRuntime(t, [binding('pair', 'pair', 'top-level', 'export let alpha = null; export let beta = 2')])
  const invalid = await run('alpha ??= null; return () => beta;')
  assert.equal(invalid.result.error.kind, 'invalid-output')
  assert.deepEqual(nameStates(invalid), { alpha: 'local', beta: 'provider' })
  assert.deepEqual((await run('return [alpha, beta]')).result.value, [null, 2])
})

test('legacy: current declaration generation retains actual all-old partial writes and leaves failed mixed candidates attached', async t => {
  const run = perNameRuntime(t, [binding('pair', 'pair', 'top-level', 'export let alpha = 1; export let beta = 2')], { legacyBindingSettings: true })
  const mixed = await run('let [alpha, fresh = (() => { throw new Error("mixed") })()] = [10];')
  assert.match(mixed.result.error.message, /mixed/)
  assert.deepEqual(nameStates(mixed), { alpha: 'provider', beta: 'provider' })
  const allOld = await run('let [alpha, beta = (() => { throw new Error("old") })()] = [10];')
  assert.match(allOld.result.error.message, /old/)
  assert.deepEqual(nameStates(allOld), { alpha: 'local', beta: 'provider' })
  assert.deepEqual((await run('return [alpha, beta]')).result.value, [10, 2])
})

test('legacy: pre-existing initialized lexicals remain local and failed native lexicals remain explicitly unknown', async t => {
  const run = perNameRuntime(t, [], { legacyBindingSettings: true })
  assert.match((await run('let ready = 4; throw new Error("stop"); let pending = 9;')).result.error.message, /stop/)
  const selected = snapshot([binding('pair', 'pair', 'top-level', 'export let ready = 40; export let pending = 90; export let peer = 2')])
  const result = await run('return [ready, peer]', selected)
  assert.deepEqual(result.result.value, [4, 2])
  assert.deepEqual(nameStates(result), { peer: 'provider', pending: 'unknown', ready: 'local' })
  assert.equal(result.settlement.replMemory.entries.some(entry => entry.name === 'pending'), false)
  assert.match((await run('return pending', selected)).result.error.message, /ReferenceError/)
})

test('legacy: an all-new failed pattern exposes its actual initialized prefix when a provider is later selected', async t => {
  const run = perNameRuntime(t, [], { legacyBindingSettings: true })
  const failed = await run('let [alpha, beta = (() => { throw new Error("new-pattern") })()] = [5];')
  assert.match(failed.result.error.message, /new-pattern/)
  const selected = snapshot([binding('pair', 'pair', 'top-level', 'export let alpha = 10; export let beta = 20; export let peer = 30')])
  const attached = await run('return [alpha, peer]', selected)
  assert.deepEqual(attached.result.value, [5, 30])
  assert.deepEqual(nameStates(attached), { alpha: 'local', beta: 'unknown', peer: 'provider' })
})

test('stateful declarations publish all-old and mixed provider candidates only after the whole declarator succeeds', async t => {
  const run = perNameRuntime(t, [binding('pair', 'pair', 'top-level', 'export let alpha=1; export let beta=2')])
  for (const pattern of ['alpha,beta', 'alpha,fresh']) {
    const failed = await run(`let [${pattern.split(',')[0]},${pattern.split(',')[1]}=(()=>{throw new Error("pattern")})()]=[10]`)
    assert.match(failed.result.error.message, /pattern/)
    assert.deepEqual(nameStates(failed), {alpha:'provider', beta:'provider'})
    assert.deepEqual((await run('return [alpha,beta,typeof fresh]')).result.value, [1,2,'undefined'])
  }
  const assigned = await run('[alpha,beta=(()=>{throw new Error("assignment")})()]=[10]')
  assert.match(assigned.result.error.message, /assignment/)
  assert.deepEqual(nameStates(assigned), {alpha:'local',beta:'provider'})
  assert.deepEqual((await run('return [alpha,beta]')).result.value, [10,2])
})

test('failed stateful declarations leave later provider activation available', async t => {
  const run = perNameRuntime(t, [])
  assert.match((await run('let ready=4; throw new Error("stop"); let pending=9')).result.error.message, /stop/)
  assert.match((await run('let [alpha,beta=(()=>{throw new Error("pattern")})()]=[5]')).result.error.message, /pattern/)
  const selected = snapshot([binding('pair', 'pair', 'top-level', 'export const ready=40; export const pending=90; export const alpha=10; export const beta=20')])
  const attached = await run('return [ready,pending,alpha,beta]', selected)
  assert.deepEqual(attached.result.value, [4,90,10,20])
  assert.deepEqual(nameStates(attached), {alpha:'provider',beta:'provider',pending:'provider',ready:'local'})
})

test('bare declarations initialize names whose requested provider failed activation', async t => {
  const run = perNameRuntime(t, [binding('failed', 'failed', 'top-level', 'throw new Error("activation"); export const missing=1')])
  const result = await run('let missing; return typeof missing')
  assert.equal(result.result.error, undefined)
  assert.equal(result.result.value, 'undefined')
  assert.ok(result.settlement.replMemory.entries.some(entry => entry.name === 'missing'))
  assert.equal((await run('missing=2; return missing')).result.value, 2)
})

test('each actual assignment API changes only the written name and preserves sibling identity', async t => {
  const mutations = [
    'alpha = 1',
    'alpha += 0',
    'alpha++',
    '++alpha',
    '[alpha] = [1]',
    '({ value: alpha } = { value: 1 })',
    'globalThis.alpha = 1',
    'Object.assign(globalThis, { alpha: 1 })',
    'Reflect.set(globalThis, "alpha", 1)',
    'Object.defineProperty(globalThis, "alpha", { configurable: true, enumerable: true, writable: true, value: 1 })',
    'Object.defineProperties(globalThis, { alpha: { configurable: true, writable: true, value: 1 } })',
    'Reflect.defineProperty(globalThis, "alpha", { configurable: true, value: 1 })',
    'Object.defineProperty(globalThis, "alpha", { configurable: false, value: 1 })',
    'if (true) { var alpha = 1 }',
  ]
  for (const mutation of mutations) {
    await t.test(mutation, async t => {
      const run = perNameRuntime(t, [binding('pair', 'pair', 'top-level', 'export let alpha = 1; export const beta = {};')])
      await run('const savedBeta = beta;')
      const changed = await run(`${mutation}; return [alpha, beta === savedBeta]`)
      assert.equal(changed.result.error, undefined)
      assert.deepEqual(nameStates(changed), { alpha: 'local', beta: 'provider' })
      const retained = await run('return [alpha, beta === savedBeta]', snapshot([]))
      assert.equal(retained.result.error?.kind, 'exception')
      assert.match(retained.result.error.message, /beta is not defined/)
      const local = await run('return alpha', snapshot([]))
      assert.equal(local.result.value, changed.result.value[0])
    })
  }
})

test('provider lifecycle preserves local objects and deletion masks while still initializing fully masked entries', async t => {
  let initialized = 0
  const bindings = [{ global: 'tools', functions: { init: async () => ++initialized } }]
  const source = offset => `await tools.init({}); export let alpha = { n: ${offset} }; export let beta = ${offset}; export const read = () => alpha;`
  const first = snapshot([binding('pair', 'pair', 'top-level', source(1))])
  const second = snapshot([binding('pair', 'pair', 'top-level', source(2))], 2)
  const third = snapshot([binding('pair', 'pair', 'top-level', source(3))], 3)
  const run = perNameRuntime(t, [])
  await run('const saved = alpha; const oldRead = read; alpha = saved; delete globalThis.beta; read = read;', first, bindings)
  assert.equal(initialized, 1)
  const changed = await run('return [alpha === saved, oldRead() === saved, read === oldRead, typeof beta]', second, bindings)
  assert.deepEqual(changed.result.value, [true, true, true, 'undefined'])
  assert.equal(initialized, 2)
  assert.deepEqual(nameStates(changed), { alpha: 'local', beta: 'absent', read: 'local' })
  const removed = await run('return [alpha === saved, typeof beta, read === oldRead]', snapshot([]), bindings)
  assert.deepEqual(removed.result.value, [true, 'undefined', true])
  const enabled = await run('return [alpha === saved, typeof beta, read === oldRead]', third, bindings)
  assert.deepEqual(enabled.result.value, [true, 'undefined', true])
  assert.equal(initialized, 3)
  assert.equal(enabled.settlement.userBindings.entries.length, 1)
  assert.equal(enabled.settlement.replMemory.entries.some(entry => entry.name === 'beta'), false)
})

test('uncovered sibling names follow source updates and disable-reenable independently of local overrides', async t => {
  const run = perNameRuntime(t, [])
  const make = value => snapshot([binding('pair', 'pair', 'top-level', `export let alpha = ${value}; export let beta = ${value}`)], value)
  await run('alpha = 8;', make(1))
  assert.deepEqual((await run('return [alpha, beta]', make(2))).result.value, [8, 2])
  assert.deepEqual((await run('return [alpha, typeof beta]', snapshot([]))).result.value, [8, 'undefined'])
  assert.deepEqual((await run('return [alpha, beta]', make(3))).result.value, [8, 3])
})

test('reflective writes distinguish the actual receiver, preserve same-value detachment and never invoke replacement getters', async t => {
  const run = perNameRuntime(t, [binding('pair', 'pair', 'top-level', 'export let alpha = 1; export let beta = 2')])
  const alias = await run('const descriptor = Object.getOwnPropertyDescriptor(globalThis, "alpha"); const receiver = {}; Reflect.set(globalThis, "alpha", 9, receiver); return [receiver.alpha, alpha]')
  assert.deepEqual(alias.result.value, [9, 1])
  assert.equal(nameStates(alias).alpha, 'provider')
  const detached = await run('Reflect.set(globalThis, "alpha", alpha); Object.defineProperty(globalThis, "alpha", descriptor); let getters = 0; Object.defineProperty(globalThis, "beta", { configurable: true, get() { getters++; return 20 } });')
  assert.deepEqual(nameStates(detached), { alpha: 'local', beta: 'local' })
  assert.equal((await run('return getters')).result.value, 0)
  const updated = snapshot([binding('pair', 'pair', 'top-level', 'export let alpha = 30; export let beta = 40')], 2)
  assert.deepEqual((await run('return [alpha, beta, getters]', updated)).result.value, [1, 20, 1])
})

test('namespace member mutations stay on the saved namespace and whole-name assignment alone detaches it', async t => {
  const run = perNameRuntime(t, [binding('api', 'api', 'namespace', 'export const object = { n: 1 }; export function read() { return object.n }')])
  const member = await run('const savedApi = api; api.object.n = 5; return savedApi.read()')
  assert.equal(member.result.value, 5)
  assert.equal(nameStates(member).api, 'provider')
  assert.equal(nameStates(await run('api = api;')).api, 'local')
  const updated = snapshot([binding('api', 'api', 'namespace', 'export const object = { n: 20 }; export function read() { return object.n }')], 2)
  assert.deepEqual((await run('return [api === savedApi, api.read()]', updated)).result.value, [true, 5])
})

test('request overlays never restore a stale same-ID provider getter and restore local getter identity', async t => {
  const run = perNameRuntime(t, [])
  const first = snapshot([binding('pair', 'pair', 'top-level', 'export const service = { value: 1 }; export let beta = 2')])
  const second = snapshot([binding('pair', 'pair', 'top-level', 'export const service = { value: 3 }; export let beta = 4')], 2)
  const overlay = [{ global: 'service', functions: { value: async () => 8 } }]
  await run('const oldService = service;', first)
  const covered = await run('return [await service.value(), typeof beta]', second, overlay)
  assert.deepEqual(covered.result.value, [8, 'undefined'])
  assert.deepEqual(covered.settlement.userBindings.entries, [])
  const restored = await run('return [service === oldService, service.value, beta]', second)
  assert.deepEqual(restored.result.value, [false, 3, 4])
  await run('let reads = 0; const localGetter = () => { reads++; return oldService }; Object.defineProperty(globalThis, "service", { configurable: true, get: localGetter });', second)
  await run('return service.value()', second, overlay)
  const local = await run('return [Object.getOwnPropertyDescriptor(globalThis, "service").get === localGetter, reads]', snapshot([]))
  assert.deepEqual(local.result.value, [true, 0])
})

test('a missing selected runtime export rejects its complete entry and preserves the successful peer snapshot', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  await runtime.run('missing-export', { program: 'return 1', bindings: [] })
  let calls = 0
  const intercepted = interceptWorkerPosts(runtime, 'missing-export', message => message.type === 'run'
    ? { ...message, userBindings: { ...message.userBindings, entries: message.userBindings.entries.map(entry => (
      entry.id === 'pair' ? { ...entry, source: 'await tools.init({}); export const beta = 2' } : entry
    )) } } : message)
  t.after(intercepted.restore)
  const userBindings = snapshot([
    binding('pair', 'pair', 'top-level', 'await tools.init({}); export const alpha = 1; export const beta = 2'),
    binding('peer', 'peer', 'namespace', 'export const value = 3'),
  ])
  const execution = await runtime.runTentative('missing-export', {
    program: 'return [typeof alpha, typeof beta, peer.value]', userBindings,
    bindings: [{ global: 'tools', functions: { init: async () => ++calls } }],
  })
  runtime.finalize(execution.settlement, true)
  assert.deepEqual(execution.result.value, ['undefined', 'undefined', 3])
  assert.match(execution.result.logs[0], /named export "alpha" is unavailable after evaluation/)
  assert.equal(calls, 1)
  assert.equal(execution.settlement.journal.status, 'volatile')
  assert.deepEqual(execution.settlement.userBindings.entries.map(entry => entry.id), ['peer'])
  assert.deepEqual(nameStates(execution), { peer: 'provider' })
})

test('settlement requires closed, complete name evidence and complete entry activation outcomes', async t => {
  const corruptions = [
    ['missing evidence', message => { delete message.userBindingNames }],
    ['incomplete evidence', message => { message.userBindingNames.pop() }],
    ['duplicate evidence', message => { message.userBindingNames.push(message.userBindingNames[0]) }],
    ['unknown name', message => { message.userBindingNames.push({ name: 'foreign', state: 'local' }) }],
    ['wrong provider', message => { message.userBindingNames[0].entryId = 'wrong' }],
    ['extra field', message => { message.userBindingNames[0].extra = true }],
    ['invalid state', message => { message.userBindingNames[0].state = 'initialized' }],
    ['missing activation failure', message => { message.activatedUserBindings = []; message.userBindingNames = [] }],
    ['duplicate activation outcome', message => { message.userBindingFailures.push({ id: 'pair', error: 'duplicate' }) }],
  ]
  for (const [label, corrupt] of corruptions) {
    await t.test(label, async t => {
      const runtime = new SessionRuntime()
      t.after(() => runtime.dispose())
      const userBindings = snapshot([binding('pair', 'pair', 'top-level', 'export let alpha = 1; export let beta = 2')])
      await runtime.run('invalid-proof', { program: 'return beta', bindings: [], userBindings })
      const intercepted = interceptWorkerMessages(runtime, 'invalid-proof', (message, deliver) => {
        if (message.type === 'done') corrupt(message)
        deliver(message)
      })
      const invalid = await runtime.runTentative('invalid-proof', { program: 'return;', bindings: [], userBindings })
      intercepted.restore()
      runtime.finalize(invalid.settlement, true)
      assert.equal(invalid.result.error.kind, 'worker-exit')
      assert.equal(invalid.settlement.journal.status, 'discarded')
      assert.equal(invalid.settlement.journal.userBindingNames, null)
      assert.equal((await runtime.run('invalid-proof', { program: 'return beta', bindings: [], userBindings })).value, 2)
    })
  }
})

test('module-held members resolve current capabilities and report proved removal separately from lexical errors', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('current', 'current', 'namespace', 'const member = tools.value; export const invoke = () => member({})'),
  ])
  const run = async functions => {
    const execution = await runtime.runTentative('current-capability', {
      program: 'return current.invoke()', bindings: [{ global: 'tools', functions }], userBindings,
    })
    runtime.finalize(execution.settlement, true)
    return execution
  }
  assert.equal((await run({ value: async () => 1 })).result.value, 1)
  assert.equal((await run({ value: async () => 2 })).result.value, 2)
  for (let index = 0; index < 3; index++) {
    const missing = await run({})
    assert.match(missing.result.error.message, /unknown binding tools.value/)
    assert.match(missing.result.error.message, /availability may have changed/)
    if (index === 2) {
      const warning = missing.settlement.journal.diagnostics.at(-1)
      assert.equal(warning.code, 'PTC-W001')
      assert.equal(warning.cause.code, 'PTC-CAPABILITY')
      assert.equal(warning.stateEffect, 'partially-applied')
    }
  }
  assert.equal((await run({ value: async () => 3 })).result.value, 3)
})

test('activates namespace and top-level helpers as ordinary REPL values', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const bindings = snapshot([
    binding('math', 'math', 'namespace', 'export function add(a: number, b: number) { return a + b }'),
    binding('text', 'text', 'top-level', 'export const upper = (value: string) => value.toUpperCase()'),
  ])
  assert.deepEqual(await runtime.run('activation', {
    program: 'return [math.add(2, 3), upper("ok")]',
    bindings: [],
    userBindings: bindings,
  }), { logs: [], value: [5, 'OK'] })
  assert.deepEqual(await runtime.run('activation', {
    program: 'return [math.add(4, 5), upper("next")]',
    bindings: [],
    userBindings: bindings,
  }), { logs: [], value: [9, 'NEXT'] })
})

test('binding activation uses the same module updates as candidate execution', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('revised', 'revised', 'namespace', 'export const value = 1; export const value = 2; export function read(input: number) { const input = input + 1; const local = 1; const local = 2; return input + local + value }'),
  ])
  const result = await runtime.run('revised-module', { program: 'return [revised.value, revised.read(3)]', bindings: [], userBindings })
  assert.deepEqual(result.value, [2, 8])
})

test('binding activation preserves historical transforms and reinstalls a changed generation', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const current = snapshot([
    binding('generation', 'generation', 'namespace', 'export function read() { const value = 1; try { value = 2 } catch {} return value }'),
  ])
  const transform = LEGACY_USER_BINDING_TRANSFORM
  const legacy = { ...current, transform, fingerprint: createHash('sha256').update(JSON.stringify({
    revision: current.revision, entries: current.entries.map(entry => entry.fingerprint), transform,
  })).digest('hex') }
  const run = userBindings => runtime.run('module-generation', { program: 'return generation.read()', bindings: [], userBindings })
  assert.equal((await run(legacy)).value, 1)
  assert.equal((await run(current)).value, 2)
})

test('Unicode binding declarations identify the installed and reusable values exactly', async t => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('unicode', '\u540d\u79f0', 'namespace', 'export const answer = 42'),
    binding('unicode-export', 'Unicode exports', 'top-level', 'export const \u503c = 7'),
  ])
  assert.match(userBindings.entries[0].declaration, /declare const \u540d\u79f0:/)
  assert.match(userBindings.entries[1].declaration, /declare const \u503c:/)
  for (let index = 0; index < 2; index++) {
    const result = await runtime.run('unicode', {
      program: 'return [\u540d\u79f0.answer, \u503c, globalThis["\u540d\u79f0"] === \u540d\u79f0]',
      bindings: [], userBindings,
    })
    assert.equal(result.error, undefined)
    assert.deepEqual(result.value, [42, 7, true])
  }
})

test('rolls back every top-level name when one entry name cannot be installed', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  await runtime.run('atomic-activation', {
    program: `
Object.defineProperty(globalThis, 'right', {
  configurable: false,
  enumerable: true,
  value: 'session',
})
return right
`,
    bindings: [],
  })
  const userBindings = snapshot([
    binding('pair', 'pair', 'top-level', 'export const left = 1; export const right = 2'),
  ])
  const execution = await runtime.runTentative('atomic-activation', {
    program: 'return [typeof left, right]', bindings: [], userBindings,
  })
  runtime.finalize(execution.settlement, true)

  assert.deepEqual(execution.result.value, ['undefined', 'session'])
  assert.match(execution.result.logs[0], /Global binding "pair" was not activated/)
  assert.deepEqual(execution.settlement.userBindings.entries, [])
  assert.deepEqual((await runtime.run('atomic-activation', {
    program: 'return [typeof left, right]', bindings: [], userBindings: snapshot([]),
  })).value, ['undefined', 'session'])
})

test('retains session-local redeclarations across global updates, disable, and removal', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const first = snapshot([
    binding('fn', 'fn', 'top-level', 'export function greet() { return "global-one" }'),
    binding('ns', 'helpers', 'namespace', 'export function greet() { return "namespace-one" }'),
    binding('gone', 'gone', 'namespace', 'export const value = 1'),
  ])
  assert.equal((await runtime.run('shadow', {
    program: 'return `${greet()}:${helpers.greet()}:${gone.value}`', bindings: [], userBindings: first,
  })).value, 'global-one:namespace-one:1')
  const redeclared = await runtime.run('shadow', {
    program: 'function greet() { return "session" }; const helpers = { greet: () => "session-ns" }; return undefined',
    bindings: [],
    userBindings: first,
  })
  assert.equal(redeclared.error, undefined)

  const updated = snapshot([
    binding('fn', 'fn', 'top-level', 'export function greet() { return "global-two" }'),
    binding('ns', 'helpers', 'namespace', 'export function greet() { return "namespace-two" }'),
  ], 2)
  assert.equal((await runtime.run('shadow', {
    program: 'return `${greet()}:${helpers.greet()}:${typeof gone}`', bindings: [], userBindings: updated,
  })).value, 'session:session-ns:undefined')
  assert.equal((await runtime.run('shadow', {
    program: 'return `${greet()}:${helpers.greet()}`', bindings: [],
  })).value, 'session:session-ns')
})

test('contains entry activation failures and excludes unavailable declarations from live state', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const bindings = snapshot([
    binding('broken', 'broken', 'namespace', 'throw new Error("initialization failed"); export const value = 1'),
    binding('healthy', 'healthy', 'namespace', 'export const value = 2'),
  ])
  const result = await runtime.run('failure', {
    program: 'return healthy.value', bindings: [], userBindings: bindings,
  })
  assert.equal(result.value, 2)
  assert.equal(result.logs.length, 1)
  assert.match(result.logs[0], /Global binding "broken" was not activated: initialization failed/)
  assert.equal((await runtime.run('failure', {
    program: 'return typeof broken', bindings: [], userBindings: bindings,
  })).value, 'undefined')
})

test('marks failed binding initializers with host calls as volatile', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('broken-call', 'brokenCall', 'namespace', `
void tools.observe({ value: 1 }).then(() => tools.observe({ value: 2 }))
throw new Error('initialization failed')
export const value = 1
`),
    binding('healthy-call-peer', 'healthyCallPeer', 'namespace', 'export const value = 2'),
  ])
  let calls = 0
  const execution = await runtime.runTentative('failed-binding-call', {
    program: 'await tools.pause({}); const liveOnly = healthyCallPeer.value + 1; return liveOnly',
    bindings: [{
      global: 'tools',
      functions: {
        observe: async ({ value }) => {
          calls += 1
          if (value === 1) await new Promise(resolve => setTimeout(resolve, 5))
          return 'observed'
        },
        pause: async () => new Promise(resolve => setTimeout(resolve, 20)),
      },
    }],
    userBindings,
  })
  runtime.finalize(execution.settlement, true)
  assert.equal(execution.result.value, 3)
  assert.match(execution.result.logs[0], /broken-call.*initialization failed/)
  assert.equal(execution.settlement.journal.status, 'volatile')
  assert.match(execution.settlement.journal.volatileReason, /failed user binding "broken-call" issued a host call/)
  assert.equal(calls, 2)
  assert.deepEqual(execution.settlement.userBindings.entries.map(entry => entry.id), ['healthy-call-peer'])
})

test('keeps request-owned namespaces and error classes authoritative across cells', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('service-default', 'service', 'namespace', 'export function value() { return "global" }'),
    binding('error-default', 'errors', 'top-level', 'export class ServiceError extends Error {}'),
    binding('healthy', 'healthy', 'namespace', 'export const value = 7'),
  ])
  const request = marker => ({
    program: 'return [await service.value(), new ServiceError("value", "program").name, healthy.value]',
    userBindings,
    bindings: [{
      global: 'service',
      functions: { value: async () => marker },
      errorClass: { name: 'ServiceError', memberNameProperty: 'operation' },
    }],
  })

  for (const marker of ['first', 'second']) {
    const execution = await runtime.runTentative('reserved-user-bindings', request(marker))
    runtime.finalize(execution.settlement, true)
    const result = execution.result
    assert.deepEqual(result.value, [marker, 'ServiceError', 7])
    assert.equal(result.logs.length, 2)
    assert.match(result.logs[0], /request-owned program binding "service"/)
    assert.match(result.logs[1], /request-owned program binding "ServiceError"/)
    assert.deepEqual(
      execution.settlement.userBindings.entries.map(entry => entry.id),
      ['healthy'],
    )
  }
})

test('does not restore a removed user global after a request namespace covers it', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('service-default', 'service', 'namespace', 'export function value() { return "global" }'),
  ])
  assert.equal((await runtime.run('removed-request-shadow', {
    program: 'return service.value()', bindings: [], userBindings,
  })).value, 'global')
  assert.equal((await runtime.run('removed-request-shadow', {
    program: 'return service.value()',
    bindings: [{ global: 'service', functions: { value: async () => 'request' } }],
    userBindings,
  })).value, 'request')
  assert.equal((await runtime.run('removed-request-shadow', {
    program: 'return typeof service', bindings: [],
  })).value, 'undefined')
})

test('restores a session-local shadow after a request namespace covers it', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('service-default', 'service', 'namespace', 'export function value() { return "global" }'),
  ])
  assert.equal((await runtime.run('local-request-shadow', {
    program: 'service = { value: () => "session" }; return service.value()',
    bindings: [],
    userBindings,
  })).value, 'session')
  assert.equal((await runtime.run('local-request-shadow', {
    program: 'return service.value()',
    bindings: [{ global: 'service', functions: { value: async () => 'request' } }],
    userBindings,
  })).value, 'request')
  assert.equal((await runtime.run('local-request-shadow', {
    program: 'return service.value()', bindings: [],
  })).value, 'session')
})

test('resolves delayed activation imports from the stable binding directory instead of session cwd', async (t) => {
  const bindingsCwd = await mkdtemp(join(tmpdir(), 'ptc-plus-binding-cwd-'))
  const sessionCwd = await mkdtemp(join(tmpdir(), 'ptc-plus-session-cwd-'))
  t.after(() => Promise.all([
    rm(bindingsCwd, { recursive: true, force: true }),
    rm(sessionCwd, { recursive: true, force: true }),
  ]))
  await writeFile(join(bindingsCwd, 'dependency.mjs'), 'export const base = 40\n')
  await writeFile(join(sessionCwd, 'dependency.mjs'), 'export const base = 100\n')
  const runtime = new SessionRuntime({ durableReplay: false }, { userBindingsCwd: bindingsCwd })
  t.after(() => runtime.dispose())
  const bindings = snapshot([
    binding('relative', 'relative', 'namespace', `
export async function add(value: number) {
  const { base } = await import('./dependency.mjs')
  return base + value
}
`),
  ])
  for (const value of [2, 3]) {
    const result = await runtime.run({ id: 'relative', session: { header: { cwd: sessionCwd } } }, {
      program: `return relative.add(${value})`, bindings: [], userBindings: bindings,
    })
    assert.equal(result.value, 40 + value)
  }
})

test('rejects a relative user binding storage directory at runtime construction', () => {
  assert.throws(() => new SessionRuntime({}, { userBindingsCwd: 'relative' }), /must be an absolute path/)
})

test('uses the current request tools from long-lived user helper closures', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('tool-helper', 'toolHelper', 'namespace', `
export async function invoke(value: string) {
  return tools.echo({ value })
}
`),
  ])
  const request = marker => ({
    program: `return toolHelper.invoke(${JSON.stringify(marker)})`,
    userBindings,
    bindings: [{
      global: 'tools',
      functions: { echo: async ({ value }) => `${marker}:${value}` },
      errorClass: { name: 'ToolCallError', memberNameProperty: 'tool' },
    }],
  })
  assert.equal((await runtime.run('tools', request('first'))).value, 'first:first')
  assert.equal((await runtime.run('tools', request('second'))).value, 'second:second')
})

test('binds delayed helper calls to the cell that created their continuation', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  let secretCalls = 0
  const userBindings = snapshot([
    binding('delayed-helper', 'delayedHelper', 'namespace', `
let outcome = 'pending'
export function schedule() {
  setTimeout(async () => {
    try { outcome = await tools.secret({}) }
    catch (error) { outcome = error.message }
  }, 30)
}
export function result() { return outcome }
`),
  ])
  await runtime.run('delayed-tools', {
    program: 'delayedHelper.schedule(); return undefined',
    userBindings,
    bindings: [{ global: 'tools', functions: { echo: async () => 'echo' } }],
  })
  const result = await runtime.run('delayed-tools', {
    program: 'await new Promise(resolve => setTimeout(resolve, 80)); return delayedHelper.result()',
    userBindings,
    bindings: [{
      global: 'tools',
      functions: { secret: async () => { secretCalls += 1; return 'borrowed' } },
    }],
  })
  assert.equal(result.value, 'PTC execution lease expired')
  assert.equal(secretCalls, 0)
})

test('bridges every live custom program namespace into retained helpers', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('service-helper', 'serviceHelper', 'namespace', `
export function current() { return service.value() }
export function introduced() { return later.value() }
`),
  ])
  const first = await runtime.run('custom-namespace', {
    program: 'return serviceHelper.current()',
    userBindings,
    bindings: [{ global: 'service', functions: { value: async () => 'first' } }],
  })
  assert.equal(first.value, 'first')

  const second = await runtime.run('custom-namespace', {
    program: 'return [await serviceHelper.current(), await serviceHelper.introduced()]',
    userBindings,
    bindings: [
      { global: 'service', functions: { value: async () => 'second' } },
      { global: 'later', functions: { value: async () => 'new' } },
    ],
  })
  assert.deepEqual(second.value, ['second', 'new'])

  const removed = await runtime.run('custom-namespace', {
    program: 'return serviceHelper.current()', userBindings, bindings: [],
  })
  assert.match(removed.error.message, /service\.value is not a function/)
})

test('fails explicitly when a retained helper cannot bridge a program namespace global', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('conflict-helper', 'conflictHelper', 'namespace', 'export const value = 1'),
  ])
  const result = await runtime.run('namespace-conflict', {
    program: 'return conflictHelper.value',
    userBindings,
    bindings: [{ global: 'NaN', functions: { value: async () => 1 } }],
  })
  // Native non-configurable intrinsics can reject before the module bridge is reached.
  assert.match(result.error.message, /namespace "NaN" cannot be bridged.*already exists|Cannot redefine property: NaN/)

  const bufferConflict = await runtime.run('namespace-conflict', {
    program: 'return conflictHelper.value',
    userBindings,
    bindings: [{ global: 'Buffer', functions: { value: async () => 1 } }],
  })
  assert.match(bufferConflict.error.message, /namespace "Buffer" cannot be bridged.*already exists/)
  assert.deepEqual((await runtime.run('namespace-conflict', {
    program: 'return [Buffer.byteLength("ok"), Number.isNaN(NaN)]', userBindings: snapshot([]), bindings: [],
  })).value, [2, true])
})

test('preserves mutable module exports until a session-local assignment shadows them', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('state', 'state', 'namespace', `
export let count = 0
export function increment() { count += 1; return count }
`),
    binding('top-state', 'top state', 'top-level', `
export let topCount = 0
export function incrementTop() { topCount += 1; return topCount }
`),
  ])
  const first = await runtime.run('mutable-exports', {
    program: 'return [state.count, state.increment(), state.count, topCount, incrementTop(), topCount]',
    bindings: [],
    userBindings,
  })
  assert.deepEqual(first.value, [0, 1, 1, 0, 1, 1])
  const shadow = await runtime.run('mutable-exports', {
    program: 'topCount = 9; state = { count: 20 }; incrementTop(); return [topCount, state.count]',
    bindings: [],
    userBindings,
  })
  assert.deepEqual(shadow.value, [9, 20])
})

test('reuses modules across presentation updates and reinitializes changed execution inputs', async t => {
  for (const scope of ['namespace', 'top-level']) {
    const runtime = new SessionRuntime()
    t.after(() => runtime.dispose())
    let initializations = 0
    let revision = 0
    let entry = binding('counter', 'counter', scope,
      'await tools.observe({}); export let count = 0; export function next() { return ++count }')
    const program = scope === 'namespace' ? 'return counter.next()' : 'return next()'
    const run = async (source = program) => {
      const userBindings = snapshot([entry], ++revision)
      const execution = await runtime.runTentative(`presentation-${scope}`, {
        program: source, userBindings,
        bindings: [{ global: 'tools', functions: { observe: async () => { initializations++; return null } } }],
      })
      runtime.finalize(execution.settlement, true)
      assert.equal(execution.result.error, undefined)
      assert.deepEqual(execution.settlement.userBindings, userBindings)
      return execution.result.value
    }
    assert.equal(await run(), 1)
    assert.equal(await run(), 2)
    for (const [index, modelContext] of [
      { includeDeclaration: true, instructions: 'Use next() for the next count.' },
      { includeDeclaration: false, instructions: 'Use next() for the next count.' },
      { includeDeclaration: false, instructions: '' },
      { enabled: true, instructions: 'Legacy prompt.', declaration: 'declare const legacy: never' },
      { enabled: false, instructions: 'Legacy prompt.', declaration: '' },
      undefined,
    ].entries()) {
      entry = { ...entry, modelContext }
      assert.equal(await run(), index + 3)
      assert.equal(initializations, 1)
    }
    entry = { ...entry, purpose: 'Updated presentation.' }
    assert.equal(await run(), 9)
    if (scope === 'top-level') entry = { ...entry, name: 'Updated display name' }
    assert.equal(await run(), 10)
    assert.equal(initializations, 1)

    entry = { ...entry, source: `${entry.source}\n// Updated source.` }
    assert.equal(await run(), 1)
    assert.equal(initializations, 2)
    entry = { ...entry, symbols: ['next'] }
    assert.equal(await run(), 1)
    assert.equal(initializations, 3)
    entry = { ...entry, symbols: ['count'] }
    assert.equal(await run(scope === 'namespace' ? 'return counter.count' : 'return count'), 0)
    assert.equal(initializations, 4)
    entry = { ...entry, scope: scope === 'namespace' ? 'top-level' : 'namespace', name: 'renamed' }
    assert.equal(await run(entry.scope === 'namespace' ? 'return renamed.count' : 'return count'), 0)
    assert.equal(initializations, 5)
    if (entry.scope === 'namespace') {
      entry = { ...entry, name: 'renamedAgain' }
      assert.deepEqual(await run('return [typeof renamed, renamedAgain.count]'), ['undefined', 0])
      assert.equal(initializations, 6)
    }
    const installedName = entry.scope === 'namespace' ? entry.name : 'count'
    const beforeDisable = initializations
    entry = { ...entry, enabled: false }
    assert.equal(await run(`return typeof ${installedName}`), 'undefined')
    assert.equal(initializations, beforeDisable)
    entry = { ...entry, enabled: true }
    assert.equal(await run(`return ${installedName}${entry.scope === 'namespace' ? '.count' : ''}`), 0)
    assert.equal(initializations, beforeDisable + 1)
  }
})

test('retains closure support after a global entry is removed', async (t) => {
  const bindingsCwd = await mkdtemp(join(tmpdir(), 'ptc-plus-retained-binding-'))
  t.after(() => rm(bindingsCwd, { recursive: true, force: true }))
  await writeFile(join(bindingsCwd, 'dependency.mjs'), 'export const suffix = "dependency"\n')
  const runtime = new SessionRuntime({ durableReplay: false }, { userBindingsCwd: bindingsCwd })
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('retained', 'retained', 'namespace', `
export async function invoke(value: string) {
  const { suffix } = await import('./dependency.mjs')
  return tools.echo({ value: value + ':' + suffix })
}
`),
  ])
  const requestBindings = marker => [{
    global: 'tools',
    functions: { echo: async ({ value }) => `${marker}:${value}` },
    errorClass: { name: 'ToolCallError', memberNameProperty: 'tool' },
  }]
  const first = await runtime.run('retained-closure', {
    program: 'const savedInvoke = retained.invoke; return savedInvoke("one")',
    bindings: requestBindings('first'),
    userBindings,
  })
  assert.equal(first.value, 'first:one:dependency')
  const removed = await runtime.run('retained-closure', {
    program: 'return savedInvoke("two")',
    bindings: requestBindings('second'),
  })
  assert.equal(removed.value, 'second:two:dependency')
})

test('records only complete worker-proved entries in settled snapshots', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('broken', 'broken', 'namespace', 'throw new Error("broken"); export const value = 1'),
    binding('healthy', 'healthy', 'namespace', 'export const value = 2'),
    binding('pair', 'pair', 'top-level', 'export const left = 1; export const right = 2'),
  ])
  const run = async (program, requested = userBindings) => {
    const execution = await runtime.runTentative('proved-bindings', {
      program, bindings: [], userBindings: requested,
    })
    runtime.finalize(execution.settlement, true)
    return execution
  }
  const activated = await run('return healthy.value + left + right')
  assert.equal(activated.result.value, 5)
  assert.deepEqual(
    activated.settlement.userBindings.entries.map(entry => entry.id),
    ['healthy', 'pair'],
  )
  const shadowed = await run('const left = 10; return left')
  assert.equal(shadowed.result.value, 10)
  const continued = await run('return healthy.value + left')
  assert.deepEqual(
    continued.settlement.userBindings.entries.map(entry => entry.id),
    ['healthy', 'pair'],
  )
  assert.deepEqual(continued.settlement.userBindings.entries.find(entry => entry.id === 'pair').symbols, ['left', 'right'])
  const updated = snapshot([
    binding('healthy', 'healthy', 'namespace', 'export const value = 3'),
    binding('pair', 'pair', 'top-level', 'export const left = 1; export const right = 2'),
  ], 2)
  const changed = await run('return healthy.value + left', updated)
  assert.equal(changed.result.value, 13)
  assert.deepEqual(changed.settlement.userBindings.entries.map(entry => entry.id), ['healthy', 'pair'])
})

test('treats reflective deletion and redefinition as session-local shadows', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('namespace', 'shared', 'namespace', 'export const value = 7'),
    binding('pair', 'pair', 'top-level', 'export const left = 1; export const right = 2'),
  ])
  assert.deepEqual((await runtime.run('reflective-shadow', {
    program: 'return [shared.value, left, right]', bindings: [], userBindings,
  })).value, [7, 1, 2])

  const shadowed = await runtime.run('reflective-shadow', {
    program: [
      'delete globalThis.shared',
      "Object.defineProperty(globalThis, 'left', {",
      '  configurable: true,',
      '  enumerable: true,',
      '  writable: true,',
      '  value: 10,',
      '})',
      'delete globalThis.right',
      'return [typeof shared, left, typeof right]',
    ].join('\n'),
    bindings: [],
    userBindings,
  })
  assert.deepEqual(shadowed.value, ['undefined', 10, 'undefined'])

  const retained = await runtime.run('reflective-shadow', {
    program: 'return [typeof shared, left, typeof right]', bindings: [], userBindings,
  })
  assert.deepEqual(retained.value, ['undefined', 10, 'undefined'])
})

test('keeps worker-global namespaces dark until a binding value has been exposed', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  let probe = 0
  const observe = async (userBindings) => {
    const source = `export default [typeof tools, typeof capabilities, typeof code, typeof repl]#${++probe}`
    return runtime.run('namespace-darkness', {
      program: `const observed = await import(${JSON.stringify(`data:text/javascript,${source}`)}); return observed.default`,
      bindings: [],
      ...(userBindings === undefined ? {} : { userBindings }),
    })
  }
  const hidden = ['undefined', 'undefined', 'undefined', 'undefined']
  assert.deepEqual((await observe()).value, hidden)
  assert.deepEqual((await observe(snapshot([]))).value, hidden)

  const failed = await observe(snapshot([
    binding('broken-only', 'brokenOnly', 'namespace', 'throw new Error("broken"); export const value = 1'),
  ], 2))
  assert.deepEqual(failed.value, hidden)
  assert.match(failed.logs[0], /broken-only/)

  const currentOnly = ['undefined', 'undefined', 'undefined', 'object']
  assert.deepEqual((await observe(snapshot([
    binding('active', 'active', 'namespace', 'export const value = 1'),
  ], 3))).value, currentOnly)
  assert.deepEqual((await observe()).value, currentOnly)
})

test('rejects a malformed user binding snapshot before worker execution', async (t) => {
  const runtime = new SessionRuntime()
  t.after(() => runtime.dispose())
  const result = await runtime.run('malformed-snapshot', {
    program: 'return 1', bindings: [], userBindings: { version: 1 },
  })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /invalid user binding snapshot/)
})
