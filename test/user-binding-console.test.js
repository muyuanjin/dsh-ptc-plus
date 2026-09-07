import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UserBindingConsole } from '../internal/user-binding-console.js'

const options = { cwd: process.cwd(), maxWallMs: 10_000, maxOutputBytes: 64 * 1024, maxOldGenerationSizeMb: 128 }
const source = 'export const answer: number = 42'

test('the draft console preserves declarations, await, expression values and ordinary error effects', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ptc-console-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'value.mjs'), 'export const value = "hello"')
  const owner = new UserBindingConsole({ ...options, cwd })
  t.after(() => owner.dispose())
  assert.equal(owner.environments.size, 0)
  const draft = 'export async function readText() { return (await import("./value.mjs")).value }'
  let environment
  const run = async code => {
    const result = await owner.run({ source: draft, code, environment })
    environment = result.environment
    return result
  }
  assert.equal((await run('const text: string = await readText()')).output, 'undefined')
  const first = environment
  assert.equal((await run('text.slice(0, 3)')).output, "'hel'")
  assert.equal((await run('await import("./value.mjs").then(m => m.value)')).output, "'hello'")
  assert.equal((await run('({ value: text, n: 42n })')).output, "{ value: 'hello', n: 42n }")
  assert.match((await run('let n = 1; n = 2; throw new Error("oops")')).error, /oops/)
  assert.equal((await run('n')).output, '2')
  assert.match((await run('let = ;')).error, /SyntaxError/)
  assert.equal((await run('n')).output, '2')
  for (const value of ['null', 'undefined', '"failed"']) {
    assert.equal((await run(`await Promise.reject(${value})`)).error, value === '"failed"' ? "'failed'" : value)
    assert.equal((await run(`throw ${value}`)).error, value === '"failed"' ? "'failed'" : value)
  }
  assert.equal((await run('await Promise.resolve(42)')).output, '42')
  assert.equal((await run('"use strict"')).output, "'use strict'")
  assert.equal((await run('// no statement')).output, 'undefined')
  const logged = await run('console.log("hello"); console.error("notice"); text')
  assert.equal(logged.output, "'hello'")
  assert.match(logged.logs.map(log => log.text).join(''), /hello/)
  assert.match(logged.logs.map(log => log.text).join(''), /notice/)
  assert.equal(environment, first)
  const replaced = await owner.run({ environment, source, code: 'typeof text + ":" + answer' })
  assert.equal(replaced.output, "'undefined:42'")
  assert.equal(replaced.reset, true)
  assert.notEqual(replaced.environment, environment)
  assert.equal(owner.environments.size, 1)
  owner.release(replaced.environment)
  assert.equal(owner.environments.size, 0)
  const fresh = await owner.run({ environment: replaced.environment, source, code: 'answer' })
  assert.equal(fresh.reset, true)
  assert.equal(fresh.output, '42')
})

test('draft execution validates requests and releases failed, stopped, timed-out and noisy workers', async t => {
  const owner = new UserBindingConsole(options)
  t.after(() => owner.dispose())
  for (const [key, value] of [['code', ''], ['source', 1], ['code', 'x'.repeat(1024 * 1024 + 1)]]) {
    await assert.rejects(owner.run({ source, code: 'answer', [key]: value }), /within 1 MiB/)
  }
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(owner.run({ source, code: 'answer' }, cancelled.signal), { name: 'AbortError' })
  assert.equal(owner.environments.size, 0)
  const initialized = await owner.run({ source, code: 'answer' })
  const controller = new AbortController()
  const active = owner.run({ environment: initialized.environment, source, code: 'await new Promise(() => {})' }, controller.signal)
  await assert.rejects(owner.run({ environment: initialized.environment, source, code: 'answer' }), /already running/)
  controller.abort()
  assert.equal((await active).error, 'stopped')
  assert.equal(owner.environments.size, 0)
  for (const [draft, code, expected] of [
    ['throw new Error("initializer"); export const answer = 1', 'answer', /initializer/],
    [source, 'process.exit(7)', /exited \(7\)/],
    [source, 'process.stdout.write("x".repeat(100000)); await new Promise(() => {})', /output limit/],
    [source, 'Array.from({length: 40}, () => "x".repeat(8192))', /output limit/],
  ]) {
    const result = await owner.run({ source: draft, code })
    assert.match(result.error, expected)
    assert.equal(result.environment, null)
    assert.equal(owner.environments.size, 0)
  }
  owner.reconfigure({ ...options, maxWallMs: 20 })
  assert.match((await owner.run({ source, code: 'while(true) {}' })).error, /timed out/)
})
