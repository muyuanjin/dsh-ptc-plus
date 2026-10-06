import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { browserConcurrency, runBrowserCases, selectBrowserCases } from '../scripts/browser-case-runner.mjs'

test('public browser inventories retain all layout and fallback combinations without generating fixtures', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const list = (script, arguments_ = []) => execFileSync(process.execPath, [script, '--list', ...arguments_], {
    cwd: root, encoding: 'utf8', timeout: 5000,
  }).trim().split('\n')
  const layouts = list('scripts/client-binding-layout.mjs')
  const fallbacks = list('scripts/client-fallback-smoke.mjs')
  assert.equal(layouts.length, 156)
  assert.equal(new Set(layouts).size, 156)
  assert.equal(fallbacks.length, 61)
  assert.equal(new Set(fallbacks).size, 61)
  assert.equal(fallbacks.filter(id => id.startsWith('dock/')).length, 24)
  assert.equal(fallbacks.filter(id => id.startsWith('catalog/')).length, 24)
  assert.equal(list('scripts/client-fallback-smoke.mjs', ['--menu-only']).length, 32)
  assert.deepEqual(list('scripts/client-binding-layout.mjs', ['--case', '320/light/ready-en']), ['320/light/ready-en'])
})

test('browser pools reserve CPU headroom and exact case selection cannot silently drop unknown cases', () => {
  for (const [cpus, expected] of [[1, 1], [4, 1], [8, 2], [12, 3], [24, 3]]) {
    assert.equal(browserConcurrency(undefined, cpus), expected)
  }
  assert.equal(browserConcurrency('2', 1), 2)
  for (const value of ['0', '-1', '1.5', 'Infinity', '9007199254740992']) {
    assert.throws(() => browserConcurrency(value), /positive integer/)
  }
  const cases = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.throws(() => selectBrowserCases(cases, [], { focus: true }), /require --case/)
  assert.deepEqual(selectBrowserCases(cases, [], { focus: true, list: true }), cases)
  assert.deepEqual(selectBrowserCases(cases), cases)
  assert.deepEqual(selectBrowserCases(cases, ['c', 'a', 'a']), [cases[0], cases[2]])
  assert.throws(() => selectBrowserCases(cases, ['unknown']), /unknown browser case/)
  assert.throws(() => selectBrowserCases([{ id: 'a' }, { id: 'a' }]), /unique/)
})

test('browser cases overlap on separate owned pages, preserve output order and close every worker', { timeout: 2000 }, async () => {
  const pages = []
  const visited = []
  let active = 0
  let peak = 0
  const cases = Array.from({ length: 7 }, (_, id) => ({ id }))
  const results = await runBrowserCases(cases, async (page, item) => {
    assert.equal(page.busy, false)
    page.busy = true
    active += 1
    peak = Math.max(peak, active)
    await setImmediate()
    visited.push(item.id)
    active -= 1
    page.busy = false
    return item.id * 2
  }, {
    concurrency: 3,
    createWorker: async () => {
      const page = { busy: false, closed: false }
      pages.push(page)
      return { page, close: async () => { page.closed = true } }
    },
  })
  assert.equal(peak, 3)
  assert.equal(pages.length, 3)
  assert.ok(pages.every(page => page.closed))
  assert.deepEqual(visited.sort((a, b) => a - b), cases.map(item => item.id))
  assert.deepEqual(results, cases.map(item => item.id * 2))
})

test('a failed browser case drains in-flight work, stops queued cases and retains cleanup failures', async () => {
  const primary = new Error('assertion failed')
  const cleanup = new Error('browser close failed')
  let closed = 0
  const visited = []
  await assert.rejects(runBrowserCases([{ id: 0 }, { id: 1 }, { id: 2 }], async (page, item) => {
    visited.push(item.id)
    if (item.id === 0) throw primary
    await setImmediate()
  }, {
    concurrency: 2,
    createWorker: async () => ({ page: {}, close: async () => { if (++closed === 1) throw cleanup } }),
  }), error => error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(cleanup))
  assert.deepEqual(visited, [0, 1])
  assert.equal(closed, 2)
})
