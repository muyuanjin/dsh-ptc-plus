import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { backendTestFiles, runBackendTests } from '../scripts/test-suite-files.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-backend-tests-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'test'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  return root
}

test('ordinary backend execution runs the shared suite without inherited coverage instrumentation', async t => {
  const root = await fixture(t)
  const markers = ['NODE_V8_COVERAGE', 'DSH_PTC_TEST_WORKER_COVERAGE', 'DSH_PTC_COMPILER_BYTECODE', 'DSH_PTC_TEST_COVERAGE_SUITE']
  const saved = markers.map(name => process.env[name])
  t.after(() => markers.forEach((name, index) => {
    if (saved[index] === undefined) delete process.env[name]
    else process.env[name] = saved[index]
  }))
  process.env.NODE_V8_COVERAGE = join(root, 'unexpected-coverage')
  process.env.DSH_PTC_TEST_WORKER_COVERAGE = '1'
  process.env.DSH_PTC_COMPILER_BYTECODE = join(root, 'missing-bytecode')
  process.env.DSH_PTC_TEST_COVERAGE_SUITE = '1'

  await writeFile(join(root, 'test', 'environment.test.js'), `
    import assert from 'node:assert/strict'
    import test from 'node:test'
    test('ordinary environment', () => {
      assert.equal(process.env.NODE_V8_COVERAGE, '')
      assert.equal(process.env.DSH_PTC_TEST_WORKER_COVERAGE, undefined)
      assert.equal(process.env.DSH_PTC_COMPILER_BYTECODE, undefined)
      assert.equal(process.env.DSH_PTC_TEST_COVERAGE_SUITE, undefined)
    })
  `)
  await writeFile(join(root, 'test', 'dependency.js'), 'export const value = "original"')
  await writeFile(join(root, 'test', 'isolated-worker.test.js'), `
    import assert from 'node:assert/strict'
    import test, { mock } from 'node:test'
    mock.module('./dependency.js', { namedExports: { value: 'mocked' } })
    const { value } = await import('./dependency.js')
    test('module mocks remain available', () => assert.equal(value, 'mocked'))
  `)
  await writeFile(join(root, 'test', 'client.spec.js'), 'throw new Error("outside backend inventory")')
  await mkdir(join(root, 'test', 'fixtures'))
  await writeFile(join(root, 'test', 'fixtures', 'excluded.test.js'), 'throw new Error("nested fixture")')
  await mkdir(join(root, 'test', 'coverage'))
  await writeFile(join(root, 'test', 'coverage', 'forbidden.test.js'), 'throw new Error("daily runner selected coverage tests")')

  const ordinary = await backendTestFiles(root)
  const release = await backendTestFiles(root, { coverage: true })
  assert.deepEqual(ordinary, ['test/environment.test.js', 'test/isolated-worker.test.js'])
  assert.deepEqual(release, ['test/coverage/forbidden.test.js', ...ordinary])

  assert.equal(await runBackendTests({ root, concurrency: 1 }), 0)
  assert.ok(!(await readdir(root)).includes('unexpected-coverage'))
})

test('ordinary backend execution rejects an empty suite and propagates a failed test', async t => {
  const root = await fixture(t)
  await assert.rejects(runBackendTests({ root, concurrency: 1 }), /contains no test files/)
  await writeFile(join(root, 'test', 'failure.test.js'), `
    import assert from 'node:assert/strict'
    import test from 'node:test'
    test('failure must reach the verification gate', () => assert.fail('canary failure'))
  `)
  assert.equal(await runBackendTests({ root, concurrency: 1 }), 1)
})

test('ordinary backend execution reports signal termination as a failure', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'test', 'signal.test.js'), 'process.kill(process.ppid, "SIGKILL")')
  await assert.rejects(runBackendTests({ root, concurrency: 1 }), /terminated by SIGKILL/)
})
