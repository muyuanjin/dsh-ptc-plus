import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  focusedCoverageArguments,
  runCoverage,
  testConcurrency,
  validateFocusedCoverage,
} from '../scripts/coverage.mjs'

const posixOnly = process.platform === 'win32'
  ? 'a catchable SIGINT cannot be delivered to another process on Windows'
  : false

test('coverage limits default process fanout and validates explicit concurrency', () => {
  assert.equal(testConcurrency(undefined, 1), 1)
  assert.equal(testConcurrency(undefined, 2), 1)
  assert.equal(testConcurrency(undefined, 4), 2)
  assert.equal(testConcurrency(undefined, 24), 4)
  assert.equal(testConcurrency('1', 24), 1)
  assert.equal(testConcurrency('4', 2), 4)
  for (const value of ['', '0', '-1', '1.5', '2x', 'Infinity', '9007199254740992']) {
    assert.throws(() => testConcurrency(value), /positive integer/)
  }
})

test('coverage CLI rejects invalid concurrency before starting the suite', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/coverage.mjs', import.meta.url))], {
    env: { ...process.env, DSH_PTC_TEST_CONCURRENCY: 'invalid' },
    encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /DSH_PTC_TEST_CONCURRENCY must be a positive integer/)
  assert.doesNotMatch(result.stdout, /default file concurrency/)
})

test('focused coverage requires explicit gate sources and test files', async () => {
  assert.deepEqual(focusedCoverageArguments([
    '--source', 'internal/source-position-map.js',
    '--source', 'internal/source-position-map.js',
    '--test', 'test/source-position-map.test.js',
    '--concurrency', '2',
    '--', '--test-name-pattern=source anchors',
  ]), {
    sources: ['internal/source-position-map.js', 'internal/source-position-map.js'],
    tests: ['test/source-position-map.test.js'],
    concurrency: '2',
    testArguments: ['--test-name-pattern=source anchors'],
  })
  assert.throws(() => focusedCoverageArguments(['--test', 'test/source-position-map.test.js']),
    /at least one --source/)
  assert.throws(() => focusedCoverageArguments(['--source', 'internal/source-position-map.js']),
    /at least one --test/)
  assert.throws(() => focusedCoverageArguments(['--source', 'internal/source-position-map.js',
    '--test', 'test/source-position-map.test.js', '--unknown']), /unknown focused coverage argument/)

  const selected = await validateFocusedCoverage(focusedCoverageArguments([
    '--source', 'internal/source-position-map.js',
    '--source', 'internal/source-position-map.js',
    '--test', 'test/source-position-map.test.js',
  ]))
  assert.deepEqual(selected.sources, ['internal/source-position-map.js'])
  assert.deepEqual(selected.tests, ['test/source-position-map.test.js'])
  await assert.rejects(validateFocusedCoverage(focusedCoverageArguments([
    '--source', 'README.md', '--test', 'test/source-position-map.test.js',
  ])), /outside the project coverage gate/)
  await assert.rejects(validateFocusedCoverage(focusedCoverageArguments([
    '--source', 'internal/source-position-map.js',
    '--test', fileURLToPath(new URL('../package.json', import.meta.url)),
  ])), /must be relative to the project root/)
})

test('focused coverage runs only selected tests and scopes the report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = []
  assert.equal(await runCoverage({
    directory,
    concurrency: 3,
    selectedTestFiles: ['test/source-position-map.test.js'],
    coverageSources: ['internal/source-position-map.js'],
    execute: async (args, { env }) => {
      calls.push({ args, env })
      return 0
    },
  }), 0)
  assert.equal(calls.length, 3)
  assert.match(calls[0].args[0], /compiler-bytecode\.mjs$/)
  assert.ok(calls[1].args.includes('--test-concurrency=3'))
  assert.ok(calls[1].args.includes('test/source-position-map.test.js'))
  assert.equal(calls[1].args.filter(argument => /^test\/.*\.test\.js$/.test(argument)).length, 1)
  assert.deepEqual(calls[2].args.slice(-2), ['--include', 'internal/source-position-map.js'])
  assert.equal(calls[2].env.NODE_V8_COVERAGE, '')
})

test('overlapping coverage runs keep worker evidence separate and propagate failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const paths = []
  let release
  const bothStarted = new Promise(resolve => { release = resolve })
  const codes = await Promise.all([0, 17].map(code => runCoverage({
    directory,
    concurrency: 2,
    testArguments: ['--test-name-pattern=worker evidence'],
    async execute(args, { env }) {
      if (args[0].endsWith('compiler-bytecode.mjs')) {
        assert.equal(env.NODE_V8_COVERAGE, '')
        assert.equal(env.DSH_PTC_COMPILER_BYTECODE, undefined)
        return 0
      }
      if (!args.includes('--test')) {
        assert.equal(env.NODE_V8_COVERAGE, '')
        assert.match(args[0], /coverage-report\.mjs$/)
        assert.ok(paths.includes(args[1]))
        return 0
      }
      const path = env.NODE_V8_COVERAGE
      assert.equal(env.DSH_PTC_COMPILER_BYTECODE, join(path, 'compiler-bytecode.bin'))
      assert.ok(args.includes('--test-reporter=tap'))
      assert.ok(args.some(argument => argument.startsWith(`--test-reporter-destination=${path}`)
        && argument.endsWith('.tap')))
      paths.push(path)
      await writeFile(join(path, 'worker.json'), String(code))
      if (paths.length === 2) release()
      await bothStarted
      assert.equal(await readFile(join(path, 'worker.json'), 'utf8'), String(code))
      for (const required of ['--test-concurrency=2',
        '--test-name-pattern=worker evidence']) {
        assert.ok(args.includes(required), `missing coverage requirement: ${required}`)
      }
      assert.ok(args.some(argument => /^test\/.*\.test\.js$/.test(argument)),
        'missing coverage test file selection')
      const patternIndex = args.indexOf('--test-name-pattern=worker evidence')
      const fileIndex = args.findIndex(argument => /^test\/.*\.test\.js$/.test(argument))
      assert.ok(patternIndex >= 0 && fileIndex > patternIndex, 'test arguments must precede file selection')
      return code
    },
  })))
  assert.notEqual(paths[0], paths[1])
  assert.deepEqual(codes, [0, 17])
  assert.deepEqual(await readdir(directory), [])
})

test('coverage removes only its own temporary evidence when launch fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'other-run.json'), 'retained')
  await assert.rejects(runCoverage({
    directory,
    execute: async () => { throw new Error('cannot launch coverage') },
  }), /cannot launch coverage/)
  assert.deepEqual(await readdir(directory), ['other-run.json'])
})

test('a coverage gate failure fails the command after successful tests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let calls = 0
  assert.equal(await runCoverage({ directory, execute: async () => ++calls <= 2 ? 0 : 19 }), 19)
  assert.equal(calls, 4)
  assert.deepEqual(await readdir(directory), [])
})

test('failed bytecode preparation prevents tests and reporting from starting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let calls = 0
  assert.equal(await runCoverage({ directory, execute: async args => {
    calls++
    assert.match(args[0], /compiler-bytecode\.mjs$/)
    return 7
  } }), 7)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(directory), [])
})

test('coverage reclaims evidence abandoned by a dead run and keeps what it cannot prove dead', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // 2147483647 is outside every platform's pid range, so it can never be running.
  const abandoned = join(directory, 'run-2147483647-abandoned')
  await mkdir(join(abandoned, 'nested'), { recursive: true })
  await writeFile(join(abandoned, 'nested', 'coverage-1-0-0.json'), '{}')
  await mkdir(join(directory, `run-${process.pid}-live`), { recursive: true })
  await mkdir(join(directory, 'run-unowned'), { recursive: true })

  assert.equal(await runCoverage({ directory, execute: async () => 0 }), 0)
  assert.deepEqual((await readdir(directory)).sort(),
    [`run-${process.pid}-live`, 'run-unowned'].sort())
})

test('coverage retains recent completed diagnostics and every live run log', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [index, label] of ['oldest', 'second', 'third', 'newest'].entries()) {
    const file = join(directory, `run-2147483647-${label}.tap`)
    await writeFile(file, label)
    // Recency decides retention, so the order must not depend on how fast the
    // loop above happens to run.
    await utimes(file, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  await writeFile(join(directory, 'unrelated.tap'), 'a diagnostic this run does not own')
  await writeFile(join(directory, 'run-1000-notes.txt'), 'not a diagnostic')
  const live = `run-${process.pid}-live.tap`
  await writeFile(join(directory, live), 'still being written')
  await utimes(join(directory, live), 1, 1)

  assert.equal(await runCoverage({ directory, execute: async () => 0 }), 0)
  assert.deepEqual((await readdir(directory)).sort(), [
    'run-2147483647-newest.tap', 'run-1000-notes.txt', 'run-2147483647-second.tap', 'run-2147483647-third.tap',
    'unrelated.tap', live,
  ].sort())
})

test('an interrupted run removes its evidence before exiting', { skip: posixOnly, timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-coverage-'))
  const module = pathToFileURL(fileURLToPath(new URL('../scripts/coverage.mjs', import.meta.url))).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runCoverage } from ${JSON.stringify(module)}
    // A live run keeps its event loop busy waiting on test workers. Without that
    // the process is already tearing down when the signal lands, and the signal
    // takes its default path instead of reaching the listener.
    setInterval(() => {}, 1000)
    await runCoverage({
      directory: ${JSON.stringify(directory)},
      execute: () => { console.log('started'); return new Promise(() => {}) },
    })
  `], {
    // This probe executes no code included by the plugin coverage gate, so it
    // must not append its own V8 output to the run that is collecting.
    env: { ...process.env, NODE_V8_COVERAGE: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  })

  // The evidence directory exists by the time the run reaches its first child.
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('exit', code => reject(new Error(`coverage exited before reaching its first child: ${code}`)))
  })
  child.kill('SIGINT')

  assert.deepEqual(await once(child, 'exit'), [130, null])
  assert.deepEqual(await readdir(directory), [])
})
