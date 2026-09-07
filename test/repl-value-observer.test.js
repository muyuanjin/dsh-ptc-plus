import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { createReplValueObserver, previewBindingValue } from '../internal/repl-value-observer.js'

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
    let proxy = new Proxy({}, {
      get() { touched() }, ownKeys() { touched(); return [] },
      getOwnPropertyDescriptor() { touched() }, getPrototypeOf() { touched(); return null }
    })
    let revoked = Proxy.revocable({}, {}); revoked.revoke(); let revokedProxy = revoked.proxy
    var accessor = 1
    Object.defineProperty(globalThis, 'accessor', { get() { touched(); return 42 } })
    var own = 7
    let unicode名 = 1
  `
  runInContext(program, context)
  observer.record(program)
  const names = ['scalar', 'text', 'missing', 'nothing', 'special', 'negativeZero', 'bigint', 'symbol', 'fn', 'object', 'array', 'proxy', 'revokedProxy', 'accessor', 'own', 'unknown', 'unicode名', 'touched()', 'lexicalAccessor']
  const before = Object.getOwnPropertyNames(context)
  const observed = observer.observe(names)
  const values = new Map(observed.entries.map(entry => [entry.name, entry]))
  for (const [name, text] of [['scalar', '42'], ['own', '7'], ['missing', 'undefined'], ['nothing', 'null'], ['special', 'NaN'], ['negativeZero', '-0'], ['unicode名', '1'], ['lexicalAccessor', '3']]) {
    assert.equal(values.get(name).text, text)
  }
  assert.equal(values.get('text').truncated, true)
  assert.match(values.get('object').text, /accessor: unreadable/)
  assert.equal(values.get('object').truncated, true)
  assert.match(values.get('array').text, /\[object\]/)
  assert.match(values.get('array').text, /\[empty\]/)
  for (const name of ['proxy', 'revokedProxy', 'accessor', 'unknown', 'touched()', 'symbol', 'fn', 'bigint']) {
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
  const preview = previewBindingValue({ a: 'hello', b: proxy.proxy, c: Symbol(), d: 1n, e: () => {}, f: 'omitted' })
  for (const type of ['proxy', 'symbol', 'bigint', 'function']) assert.match(preview.text, new RegExp(`${type}: unreadable`))
  assert.doesNotMatch(preview.text, /omitted/)
  assert.equal(previewBindingValue(await import('node:path')).status, 'unreadable')
  assert.equal(previewBindingValue('short').truncated, false)
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
        const worker = runtime.kernels.get(allocation).client.worker
        const next = await runtime.run(allocation, {
          program: 'bytes[0] = 7; return [bytes.length, bytes[0], bytes[11999999]]', bindings: [],
        })
        assert.equal(next.error, undefined)
        assert.deepEqual(next.value, [12000000, 7, 0])
        assert.equal(runtime.kernels.get(allocation).client.worker, worker)
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
      const worker = runtime.kernels.get('boxed-string').client.worker
      const next = await runtime.run('boxed-string', {
        program: 'boxed.marker = 7; return [boxed.length, boxed[0], boxed[4999999], boxed.marker]', bindings: [],
      })
      assert.equal(next.error, undefined)
      assert.deepEqual(next.value, [5000000, 'x', 'x', 7])
      assert.equal(runtime.kernels.get('boxed-string').client.worker, worker)
    } finally {
      await runtime.dispose()
    }
  `], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.equal(child.signal, null)
})

test('slow object observation cannot consume the next cell execution budgets', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { SessionRuntime } from ${JSON.stringify(new URL('../internal/session-runtime.js', import.meta.url).href)}
    const runtime = new SessionRuntime({ computeMs: 30000, maxWallMs: 30000 }, { observeSession: () => true })
    const session = 'slow-observation'
    try {
      const first = await runtime.run(session, {
        program: 'let big = {}; for (let i = 0; i < 2000000; i++) big["key" + i] = i; return 1',
        bindings: [],
      })
      assert.equal(first.error, undefined)
      assert.equal(first.value, 1)
      const kernel = runtime.kernels.get(session)
      const worker = kernel.client.worker
      runtime.reconfigure({ computeMs: 100, maxWallMs: 100 })
      for (const [program, value] of [
        ['let alias = big; return 2', 2],
        ['return 3', 3],
        ['return alias === big && big.key1999999 === 1999999', true],
      ]) {
        const next = await runtime.run(session, { program, bindings: [] })
        assert.equal(next.error, undefined)
        assert.equal(next.value, value)
        assert.equal(kernel.client.worker, worker)
      }
    } finally {
      await runtime.dispose()
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
