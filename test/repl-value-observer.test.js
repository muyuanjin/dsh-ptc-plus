import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createReplValueObserver, previewBindingValue, supportsAwaitLexicals } from '../internal/repl-value-observer.js'
import { SessionRuntime } from '../internal/session-runtime.js'

test('observes bounded descriptors without invoking getters, Proxy traps or formatters', () => {
  const calls = []
  const context = createContext({ touched: () => calls.push('user code') })
  const observer = createReplValueObserver(context)
  const program = `
    let scalar = 42
    globalThis.scalar = 99
    let lexicalAccessor = 3
    Object.defineProperty(globalThis, 'lexicalAccessor', { get() { touched(); return 99 } })
    let text = 'x'.repeat(4000)
    let missing = undefined
    let nothing = null
    let special = NaN
    let negativeZero = -0
    let bigint = 123n
    let symbol = Symbol('test')
    let fn = () => touched()
    let object = { n: 1, get accessor() { touched(); return 3 },
      toJSON() { touched(); return 9 },
      [Symbol.for('nodejs.util.inspect.custom')]() { touched(); return 8 },
      get [Symbol.toStringTag]() { touched(); return 'Object' }
    }
    let array = [1, , { nested: true }]
    Object.defineProperty(array, '3', { get() { touched(); return 3 } })
    let proxy = new Proxy({}, {
      get() { touched() }, ownKeys() { touched(); return [] },
      getOwnPropertyDescriptor() { touched() }, getPrototypeOf() { touched(); return null }
    })
    let revoked = Proxy.revocable({}, {}); revoked.revoke(); let revokedProxy = revoked.proxy
    var accessor = 1
    Object.defineProperty(globalThis, 'accessor', { get() { touched(); return 42 } })
    var own = 7
    let unicode名 = 1
    let [arrayHead = 5, , ...arrayTail] = [5, 6, 7, 8]
    let { nested: { objectValue }, ...objectRest } = { nested: { objectValue: 9 }, extra: 10 }
  `
  runInContext(program, context)
  observer.record(program)
  const names = ['scalar', 'text', 'missing', 'nothing', 'special', 'negativeZero', 'bigint', 'symbol', 'fn', 'object', 'array', 'proxy', 'revokedProxy', 'accessor', 'own', 'unknown', 'unicode名', 'touched()', 'lexicalAccessor', 'arrayHead', 'arrayTail', 'objectValue', 'objectRest']
  const before = Object.getOwnPropertyNames(context)
  const observed = observer.observe(names)
  const values = new Map(observed.entries.map(entry => [entry.name, entry]))
  for (const [name, text] of [['scalar', '42'], ['own', '7'], ['missing', 'undefined'], ['nothing', 'null'], ['special', 'NaN'], ['negativeZero', '-0'], ['unicode名', '1'], ['lexicalAccessor', '3'], ['bigint', '123n'], ['arrayHead', '5'], ['objectValue', '9']]) {
    assert.equal(values.get(name).text, text)
  }
  assert.equal(values.get('text').truncated, true)
  assert.match(values.get('array').text, /accessor: unreadable/)
  assert.equal(values.get('array').truncated, true)
  assert.match(values.get('array').text, /\[object\]/)
  assert.match(values.get('array').text, /\[empty\]/)
  assert.equal(values.get('arrayTail').text, 'array { "0": 7, "1": 8 }')
  for (const name of ['object', 'proxy', 'revokedProxy', 'accessor', 'unknown', 'touched()', 'symbol', 'fn', 'objectRest']) {
    assert.equal(values.get(name).status, 'unreadable', name)
  }
  assert.ok(observed.entries.every(entry => entry.text.length <= 512))
  assert.deepEqual(calls, [])
  assert.deepEqual(Object.getOwnPropertyNames(context), before)
  runInContext('scalar += 1', context)
  assert.equal(observer.observe(['scalar']).entries[0].text, '43')
  assert.equal(observer.observe(Array.from({ length: 200 }, (_, index) => `a${index}`)).entries.length, 128)
})

test('previews remain shallow and reject module namespaces and nested unsafe objects', async () => {
  const proxy = Proxy.revocable({}, {}); proxy.revoke()
  const preview = previewBindingValue(['hello', proxy.proxy, Symbol(), 1n, () => {}, 'omitted'])
  for (const type of ['proxy', 'symbol', 'function']) assert.match(preview.text, new RegExp(`${type}: unreadable`))
  assert.match(preview.text, /1n/)
  assert.doesNotMatch(preview.text, /omitted/)
  assert.equal(previewBindingValue(await import('node:path')).status, 'unreadable')
  assert.equal(previewBindingValue('short').truncated, false)
})

test('primitive previews bound BigInt conversion and array previews remain incomplete', () => {
  for (const value of [0n, -123n, 10n ** 127n]) {
    assert.deepEqual(previewBindingValue(value), { status: 'readable', text: `${value}n`, truncated: false })
  }
  for (const value of [10n ** 128n, -(10n ** 128n), 1n << 1000000n]) {
    assert.deepEqual(previewBindingValue(value), { status: 'readable', text: '[bigint: more than 128 digits]', truncated: true })
  }
  assert.equal(previewBindingValue([1, 'two', null, , true]).truncated, true)
  assert.equal(previewBindingValue([1n, -123n]).truncated, true)
  assert.equal(previewBindingValue([10n ** 128n]).truncated, true)
  assert.equal(previewBindingValue(['x'.repeat(512)]).truncated, true)
  assert.equal(previewBindingValue(['x'.repeat(513)]).truncated, true)
  assert.equal(previewBindingValue([{}, 1]).truncated, true)
  assert.equal(previewBindingValue([]).truncated, true)
})

test('short array previews preserve uncertainty about uninspected own properties', () => {
  let reads = 0
  const extended = Object.assign([1], { meta: 42 })
  Object.defineProperties(extended, {
    hidden: { value: 'not enumerable' },
    accessor: { get() { reads++; return 7 } },
    [Symbol('metadata')]: { value: 'symbol property' },
  })
  for (const [value, text] of [
    [/(?<letter>a)/.exec('cat'), 'array { "0": "a", "1": "a" }'],
    [extended, 'array { "0": 1 }'],
  ]) {
    assert.deepEqual(previewBindingValue(value), { status: 'readable', text, truncated: true })
  }
  assert.equal(reads, 0)
})

test('await lexical capability is proved against the evaluator and degrades independently', async () => {
  for (const mode of ['lexical', 'global', 'wrong', 'failure']) {
    const context = createContext({ untouched: 7 })
    const before = Object.getOwnPropertyNames(context)
    const supported = await supportsAwaitLexicals(context, async program => {
      if (mode === 'failure') throw new Error('unsupported evaluator')
      let source = program.replace('await Promise.resolve(41)', mode === 'wrong' ? '99' : '41')
      if (mode === 'global') source = source.replace('let ', 'var ').replace('const ', 'var ')
      runInContext(source, context)
    })
    assert.equal(supported, mode === 'lexical')
    assert.deepEqual(Object.getOwnPropertyNames(context), before)
    assert.equal(context.untouched, 7)
  }
})

test('real async REPL previews preserve lexical identity, values and side-effect counters', async t => {
  const runtime = new SessionRuntime({}, { observeSession: () => true })
  t.after(() => runtime.dispose())
  const first = await runtime.runTentative('async-preview', { bindings: [], program: `
let reads = 0
const answer = await Promise.resolve(42)
Object.defineProperty(globalThis, 'answer', { get() { reads++; return 99 } })
const [text, count] = await Promise.resolve(['hello', 123n])
var own = await Promise.resolve(7)
const nullable = null
const list = [1, 2, 3]
return answer
` })
  assert.equal(first.result.value, 42)
  const entries = new Map(first.settlement.replMemory.observation.entries.map(entry => [entry.name, entry]))
  for (const [name, text] of [['answer', '42'], ['reads', '0'], ['text', '"hello"'], ['count', '123n'], ['own', '7'], ['nullable', 'null']]) {
    assert.equal(entries.get(name).text, text, name)
  }
  assert.equal(entries.get('list').truncated, true)
  runtime.finalize(first.settlement, true)
  assert.deepEqual((await runtime.run('async-preview', { bindings: [], program: 'return [answer, reads, own]' })).value, [42, 0, 7])
  const nested = await runtime.runTentative('nested-await', { bindings: [], program: `
const answer = 42
async function helper() { await Promise.resolve() }
const arrow = async () => { await Promise.resolve() }
const expression = async function() { await Promise.resolve() }
return answer
` })
  assert.equal(nested.settlement.replMemory.observation.entries.find(entry => entry.name === 'answer').text, '42')
  runtime.finalize(nested.settlement, true)
  const context = createContext()
  const observer = createReplValueObserver(context)
  const program = 'const answer = 42; async function helper() { await 1 }; const arrow = async () => await 2; const expr = async function() { await 3 }'
  runInContext(program, context)
  observer.record(program)
  assert.equal(observer.observe(['answer']).entries[0].text, '42')
})

test('typed arrays and buffers are unreadable without consulting user properties', () => {
  const values = [new Uint8Array(8), Buffer.alloc(8), new Float64Array(8), new BigInt64Array(8),
    runInContext('new Uint16Array(8)', createContext())]
  let reads = 0
  for (const value of values) {
    Object.defineProperties(value, {
      length: { get() { reads++; return 8 } },
      [Symbol.toStringTag]: { get() { reads++; return 'Object' } },
    })
    assert.deepEqual(previewBindingValue(value), { status: 'unreadable', text: '', truncated: false })
  }
  assert.equal(reads, 0)
})

test('boxed strings are unreadable without invoking getters or conversion methods', () => {
  const values = [new String('abc'), runInContext('new String("abc")', createContext()),
    new (class extends String {})('abc'), Object.setPrototypeOf(new String('abc'), null)]
  let reads = 0
  for (const value of values) {
    Object.defineProperties(value, {
      [Symbol.toStringTag]: { get() { reads++; return 'Object' } },
      [Symbol.toPrimitive]: { value() { reads++; return 'abc' } },
      toString: { value() { reads++; return 'abc' } },
      valueOf: { value() { reads++; return 'abc' } },
    })
    assert.deepEqual(previewBindingValue(value), { status: 'unreadable', text: '', truncated: false })
  }
  assert.equal(reads, 0)
  assert.deepEqual(previewBindingValue('abc'), { status: 'readable', text: '"abc"', truncated: false })
})

test('large binary previews preserve the worker and subsequent REPL binding reuse', () => {
  // Keep a native OOM regression inside its own process so the test runner survives.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { SessionRuntime } from ${JSON.stringify(new URL('../internal/session-runtime.js', import.meta.url).href)}
    import { workerOf } from ${JSON.stringify(new URL('./runtime-observation.js', import.meta.url).href)}
    const runtime = new SessionRuntime({ maxOldGenerationSizeMb: 512 }, { observeSession: () => true })
    try {
      for (const allocation of ['new Uint8Array(12000000)', 'Buffer.alloc(12000000)']) {
        const first = await runtime.runTentative(allocation, {
          program: 'let bytes = ' + allocation + '; return bytes.length', bindings: [],
        })
        assert.equal(first.result.error, undefined)
        assert.equal(first.result.value, 12000000)
        assert.deepEqual(first.settlement.replMemory.observation.entries, [
          { name: 'bytes', status: 'unreadable', text: '', truncated: false },
        ])
        runtime.finalize(first.settlement, true)
        const worker = workerOf(runtime, allocation)
        const next = await runtime.run(allocation, {
          program: 'bytes[0] = 7; return [bytes.length, bytes[0], bytes[11999999]]', bindings: [],
        })
        assert.equal(next.error, undefined)
        assert.deepEqual(next.value, [12000000, 7, 0])
        assert.equal(workerOf(runtime, allocation), worker)
      }
    } finally {
      await runtime.dispose()
    }
  `], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.equal(child.signal, null)
})

test('large boxed string previews preserve a 128 MiB worker and subsequent binding reuse', () => {
  // Native index enumeration failures must remain isolated from the test runner.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { SessionRuntime } from ${JSON.stringify(new URL('../internal/session-runtime.js', import.meta.url).href)}
    import { workerOf } from ${JSON.stringify(new URL('./runtime-observation.js', import.meta.url).href)}
    const runtime = new SessionRuntime({ maxOldGenerationSizeMb: 128 }, { observeSession: () => true })
    try {
      const first = await runtime.runTentative('boxed-string', {
        program: 'let boxed = new String("x".repeat(5000000)); return boxed.length', bindings: [],
      })
      assert.equal(first.result.error, undefined)
      assert.equal(first.result.value, 5000000)
      assert.deepEqual(first.settlement.replMemory.observation.entries, [
        { name: 'boxed', status: 'unreadable', text: '', truncated: false },
      ])
      runtime.finalize(first.settlement, true)
      const worker = workerOf(runtime, 'boxed-string')
      const next = await runtime.run('boxed-string', {
        program: 'boxed.marker = 7; return [boxed.length, boxed[0], boxed[4999999], boxed.marker]', bindings: [],
      })
      assert.equal(next.error, undefined)
      assert.deepEqual(next.value, [5000000, 'x', 'x', 7])
      assert.equal(workerOf(runtime, 'boxed-string'), worker)
    } finally {
      await runtime.dispose()
    }
  `], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.equal(child.signal, null)
})

test('large plain objects preserve a 128 MiB worker, execution budgets and binding reuse', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { SessionRuntime } from ${JSON.stringify(new URL('../internal/session-runtime.js', import.meta.url).href)}
    import { workerOf } from ${JSON.stringify(new URL('./runtime-observation.js', import.meta.url).href)}
    for (const observing of [false, true]) {
    const runtime = new SessionRuntime({ maxOldGenerationSizeMb: 128, computeMs: 30000, maxWallMs: 30000 }, { observeSession: () => observing })
    const session = 'large-object'
    try {
      const first = await runtime.runTentative(session, {
        program: 'let big = {}; for (let i = 0; i < 4000000; i++) big[i] = i; return 1',
        bindings: [],
      })
      assert.equal(first.result.error, undefined)
      assert.equal(first.result.value, 1)
      assert.deepEqual(first.settlement.replMemory.observation?.entries, observing
        ? [{ name: 'big', status: 'unreadable', text: '', truncated: false }] : undefined)
      runtime.finalize(first.settlement, true)
      const worker = workerOf(runtime, session)
      runtime.reconfigure({ maxOldGenerationSizeMb: 128, computeMs: 100, maxWallMs: 100 })
      for (const [program, value] of [
        ['let alias = big; return 2', 2],
        ['return 3', 3],
        ['return alias === big && big[3999999] === 3999999', true],
      ]) {
        const next = await runtime.run(session, { program, bindings: [] })
        assert.equal(next.error, undefined)
        assert.equal(next.value, value)
        assert.equal(workerOf(runtime, session), worker)
      }
    } finally {
      await runtime.dispose()
    }
    }
  `], { encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.equal(child.signal, null)
})

test('unproved bindings do not expose unrelated same-name global properties', () => {
  const context = createContext({ failed: 'unrelated', unknown: 'unrelated' })
  const observer = createReplValueObserver(context)
  assert.throws(() => runInContext('let failed = 1; throw 1', context))
  const program = 'class Example {}; globalThis.Example = 3'
  runInContext(program, context)
  observer.record(program)
  assert.ok(observer.observe(['failed', 'unknown', 'Example']).entries.every(entry => entry.status === 'unreadable'))
})

test('unproved storage and TDZs stay unreadable without probing inherited globals', () => {
  const context = createContext({ tdz: 7 })
  const observer = createReplValueObserver(context)
  const program = 'let proved = 1; throw 1; let tdz = 2'
  assert.throws(() => runInContext(program, context))
  // A successful CellReturn can also leave a declaration in its TDZ.
  observer.record(program)
  observer.record('let invalid =')
  observer.record('let unprovedAwait = await Promise.resolve(1)')
  assert.ok(observer.observe(['tdz', 'unprovedAwait']).entries.every(entry => entry.status === 'unreadable'))
  let reads = 0
  Object.setPrototypeOf(context, new Proxy({}, { get() { reads++; return 42 } }))
  assert.equal(observer.observe(['inherited']).entries[0].status, 'unreadable')
  assert.equal(reads, 0)
  assert.equal(observer.observe(['proved']).entries[0].text, '1')
})
