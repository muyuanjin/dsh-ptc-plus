import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionRuntime } from '../internal/session-runtime.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'

function binding(id, name, scope, source) {
  return { id, name, scope, source, purpose: '', enabled: true }
}

function snapshot(entries, revision = 1) {
  return createUserBindingsSnapshot({ entries }, revision)
}

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
  assert.deepEqual(
    runtime.modelVisibleUserBindings('atomic-activation', userBindings)?.entries ?? [],
    [],
  )
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
    const result = await runtime.run('reserved-user-bindings', request(marker))
    assert.deepEqual(result.value, [marker, 'ServiceError', 7])
    assert.equal(result.logs.length, 2)
    assert.match(result.logs[0], /request-owned program binding "service"/)
    assert.match(result.logs[1], /request-owned program binding "ServiceError"/)
    assert.deepEqual(
      runtime.modelVisibleUserBindings('reserved-user-bindings', userBindings).entries.map(entry => entry.id),
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
  assert.match(result.error.message, /namespace "NaN" cannot be bridged.*already exists/)

  const bufferConflict = await runtime.run('namespace-conflict', {
    program: 'return conflictHelper.value',
    userBindings,
    bindings: [{ global: 'Buffer', functions: { value: async () => 1 } }],
  })
  assert.match(bufferConflict.error.message, /namespace "Buffer" cannot be bridged.*already exists/)
  assert.equal((await runtime.run('namespace-conflict', {
    program: 'return Buffer.byteLength("ok")', userBindings: snapshot([]), bindings: [],
  })).value, 2)
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
  assert.equal(runtime.modelVisibleUserBindings('mutable-exports', userBindings).entries.length, 0)
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
      assert.deepEqual(runtime.modelVisibleUserBindings(`presentation-${scope}`, userBindings), userBindings)
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

test('exposes only complete worker-proved entries to later model requests', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const userBindings = snapshot([
    binding('broken', 'broken', 'namespace', 'throw new Error("broken"); export const value = 1'),
    binding('healthy', 'healthy', 'namespace', 'export const value = 2'),
    binding('pair', 'pair', 'top-level', 'export const left = 1; export const right = 2'),
  ])
  assert.equal(runtime.modelVisibleUserBindings('model-visible', userBindings), undefined)
  const activated = await runtime.run('model-visible', {
    program: 'return healthy.value + left + right', bindings: [], userBindings,
  })
  assert.equal(activated.value, 5)
  assert.deepEqual(
    runtime.modelVisibleUserBindings('model-visible', userBindings).entries.map(entry => entry.id),
    ['healthy', 'pair'],
  )
  await runtime.run('model-visible', {
    program: 'const left = 10; return left', bindings: [], userBindings,
  })
  assert.deepEqual(
    runtime.modelVisibleUserBindings('model-visible', userBindings).entries.map(entry => entry.id),
    ['healthy'],
  )
  const updated = snapshot([
    binding('healthy', 'healthy', 'namespace', 'export const value = 3'),
    binding('pair', 'pair', 'top-level', 'export const left = 1; export const right = 2'),
  ], 2)
  assert.equal(runtime.modelVisibleUserBindings('model-visible', updated).entries.length, 0)
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
  assert.equal(runtime.modelVisibleUserBindings('reflective-shadow', userBindings).entries.length, 0)

  const retained = await runtime.run('reflective-shadow', {
    program: 'return [typeof shared, left, typeof right]', bindings: [], userBindings,
  })
  assert.deepEqual(retained.value, ['undefined', 10, 'undefined'])
  assert.equal(runtime.modelVisibleUserBindings('reflective-shadow', userBindings).entries.length, 0)
})

test('suppresses a model projection when the session surface generation is unreadable', async (t) => {
  const runtime = new SessionRuntime({ durableReplay: false })
  t.after(() => runtime.dispose())
  const session = {
    get surface() { throw new Error('surface unavailable') },
  }
  const userBindings = snapshot([
    binding('visible', 'visible', 'namespace', 'export const value = 1'),
  ])
  const context = { id: 'unreadable-surface', session }
  assert.equal((await runtime.run(context, {
    program: 'return visible.value', bindings: [], userBindings,
  })).value, 1)
  assert.equal(runtime.modelVisibleUserBindings(context, userBindings), undefined)
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
