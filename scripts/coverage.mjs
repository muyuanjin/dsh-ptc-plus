import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { resolve, join, basename, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coveredSource } from './coverage-inputs.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const reporter = fileURLToPath(new URL('./coverage-report.mjs', import.meta.url))
const bytecodeCompiler = fileURLToPath(new URL('./compiler-bytecode.mjs', import.meta.url))
const workerCoverageSetup = new URL('./instrument-worker-coverage.mjs', import.meta.url).href

// The `finally` in runCoverage covers failures, but not signals: with no listener
// Node terminates on the spot, so an interrupted run would strand the worker
// output it had already collected.
const INTERRUPTION_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }

// Test diagnostics outlive the run that wrote them, because a failed run is
// investigated afterwards. They are therefore pruned by recency rather than by
// liveness: keeping a few preserves the post-mortem of a recent failure, while
// keeping every one would grow a file per run forever.
const DIAGNOSTIC_RETENTION = 3

export function testConcurrency(value, parallelism = availableParallelism()) {
  // Each test process can also own compiler realms and runtime workers.
  if (value === undefined) return Math.max(1, Math.min(4, Math.floor(parallelism / 2)))
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('DSH_PTC_TEST_CONCURRENCY must be a positive integer')
  }
  return Number(value)
}

export function focusedCoverageArguments(argv) {
  const options = { sources: [], tests: [], testArguments: [] }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--') {
      options.testArguments = argv.slice(index + 1)
      break
    }
    if (argument === '--help') {
      options.help = true
      continue
    }
    if (!['--source', '--test', '--concurrency'].includes(argument)) {
      throw new Error(`unknown focused coverage argument: ${argument}`)
    }
    const value = argv[++index]
    if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`)
    if (argument === '--source') options.sources.push(value)
    else if (argument === '--test') options.tests.push(value)
    else options.concurrency = value
  }
  if (options.help) return options
  if (options.sources.length === 0) throw new Error('focused coverage requires at least one --source')
  if (options.tests.length === 0) throw new Error('focused coverage requires at least one --test')
  if (options.testArguments.some(argument => !argument.startsWith('-'))) {
    throw new Error('arguments after -- must be Node test options; select files with --test')
  }
  return options
}

async function selectedPath(input, kind) {
  if (isAbsolute(input)) throw new Error(`${kind} path must be relative to the project root: ${input}`)
  let fullPath
  try {
    fullPath = await realpath(resolve(root, input))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${kind} path does not exist: ${input}`)
    throw error
  }
  const name = relative(root, fullPath)
  if (name.length === 0 || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
    throw new Error(`${kind} path escapes the project root: ${input}`)
  }
  return { fullPath, name: name.split(sep).join('/') }
}

export async function validateFocusedCoverage(options) {
  const sources = []
  for (const input of options.sources) {
    const selected = await selectedPath(input, 'source')
    if (!coveredSource(selected.fullPath, root)) {
      throw new Error(`source is outside the project coverage gate: ${input}`)
    }
    sources.push(selected.name)
  }
  const tests = []
  for (const input of options.tests) {
    const selected = await selectedPath(input, 'test')
    if (!selected.name.startsWith('test/') || !selected.name.endsWith('.test.js')) {
      throw new Error(`test must be a test/*.test.js file: ${input}`)
    }
    tests.push(selected.name)
  }
  return {
    sources: [...new Set(sources)],
    tests: [...new Set(tests)],
    concurrency: testConcurrency(options.concurrency ?? process.env.DSH_PTC_TEST_CONCURRENCY),
    testArguments: options.testArguments,
  }
}

function focusedCoverageUsage() {
  return `Usage:
  npm run coverage:focus -- --source <gate-source> --test <test-file> [options] [-- <node-test-options>]

Repeat --source and --test to select the smallest set that distinguishes the change.
--concurrency is diagnostic-only; without it the project default applies.`
}

export async function runCoverage({
  concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY),
  directory = join(root, 'coverage'),
  testArguments = [],
  selectedTestFiles,
  coverageSources,
  execute = executeNode,
} = {}) {
  await mkdir(directory, { recursive: true })
  await reclaimAbandonedEvidence(directory)
  // Worker evidence belongs to this invocation, including failed runs.
  // Independent runs must never erase or merge each other's evidence.
  const temporary = await mkdtemp(join(directory, `run-${process.pid}-`))
  const bytecode = join(temporary, 'compiler-bytecode.bin')
  const customReporters = testArguments.some(argument => /^--test-reporter(?:=|$)/.test(argument))
  const diagnosticPath = label => join(directory, `${basename(temporary)}-${label}.tap`)
  const reportersFor = label => customReporters ? [] : [
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${diagnosticPath(label)}`,
  ]
  const diagnostics = ['mock', 'instrumented'].map(diagnosticPath)
  const stopHandlingInterruptions = handleInterruptions(temporary)
  try {
    const started = performance.now()
    console.log('Coverage stage: preparing compiler bytecode')
    const preparationCode = await execute([bytecodeCompiler, bytecode], {
      env: { ...process.env, NODE_V8_COVERAGE: '', DSH_PTC_COMPILER_BYTECODE: undefined },
    })
    if (preparationCode !== 0) return preparationCode
    const testFiles = selectedTestFiles ?? (await readdir(join(root, 'test')))
      .filter(name => name.endsWith('.test.js'))
      .map(name => `test/${name}`)
      .sort()
    // Tests that install module mocks before importing the transport must not
    // preload the real transport through the coverage setup. Run those first
    // without the instrumentation preload, then run the rest with it. Both
    // groups write worker evidence into the same coverage directory.
    const mockPreloadFiles = new Set([
      'isolated-worker.test.js',
      'session-runtime-faults.test.js',
      'user-binding-console-transport.test.js',
      'user-bindings-owner-faults.test.js',
    ])
    const runTestGroup = (files, { instrumented, label }) => execute([
      ...(instrumented ? ['--import', workerCoverageSetup] : []),
      '--test', '--experimental-test-module-mocks', `--test-concurrency=${concurrency}`,
      ...reportersFor(label),
      ...testArguments,
      ...files,
    ], { env: {
      ...process.env,
      NODE_V8_COVERAGE: temporary,
      DSH_PTC_COMPILER_BYTECODE: bytecode,
      ...(instrumented ? { DSH_PTC_TEST_WORKER_COVERAGE: '1' } : {}),
    } })
    const mockPreload = testFiles.filter(file => mockPreloadFiles.has(basename(file)))
    const instrumented = testFiles.filter(file => !mockPreloadFiles.has(basename(file)))
    let testCode = 0
    if (mockPreload.length > 0) {
      console.log(`Coverage stage: mock-dependent tests (${mockPreload.length} files)`)
      testCode = await runTestGroup(mockPreload, { instrumented: false, label: 'mock' })
    }
    if (testCode === 0 && instrumented.length > 0) {
      console.log(`Coverage stage: instrumented tests (${instrumented.length} files)`)
      testCode = await runTestGroup(instrumented, { instrumented: true, label: 'instrumented' })
    }
    console.log(`Coverage tests: ${((performance.now() - started) / 1000).toFixed(1)}s`)
    if (!customReporters) console.log(`Test diagnostics: ${diagnostics.join(', ')}`)
    await rm(bytecode, { force: true })
    console.log('Coverage stage: merging report')
    const reportArguments = coverageSources?.flatMap(source => ['--include', source]) ?? []
    const reportCode = await execute([reporter, temporary, ...reportArguments], {
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    })
    return testCode || reportCode
  } finally {
    stopHandlingInterruptions()
    await rm(temporary, { recursive: true, force: true })
    await pruneTestDiagnostics(directory)
  }
}

// The name records which run owns the evidence, so a later run can tell an
// abandoned directory from a live one without reading anything inside it.
function evidenceOwner(name) {
  const match = /^run-(\d+)-/.exec(name)
  return match === null ? null : Number(match[1])
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only a missing process proves abandonment. Permission and platform
    // lookup failures cannot establish that another run has stopped.
    return error.code !== 'ESRCH'
  }
}

// A run killed outright cannot clean up after itself, so the next run reclaims
// what it left. Evidence we cannot prove abandoned stays: an entry without a
// recorded owner might belong to a run that is still writing to it.
async function reclaimAbandonedEvidence(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const owner = evidenceOwner(entry.name)
    if (owner === null || isRunning(owner)) continue
    await rm(join(directory, entry.name), { recursive: true, force: true })
  }
}

// Diagnostics are named after the run that produced them, so the pattern keeps
// unrelated `.tap` output that happens to sit in the directory out of reach.
async function pruneTestDiagnostics(directory) {
  const diagnostics = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^run-.*\.tap$/.test(entry.name)) continue
    const owner = evidenceOwner(entry.name)
    if (owner !== null && isRunning(owner)) continue
    try {
      diagnostics.push({ name: entry.name, modified: (await stat(join(directory, entry.name))).mtimeMs })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  diagnostics.sort((left, right) => right.modified - left.modified)
  for (const { name } of diagnostics.slice(DIAGNOSTIC_RETENTION)) {
    await rm(join(directory, name), { force: true })
  }
}

function handleInterruptions(temporary) {
  const handlers = new Map()
  for (const [signal, code] of Object.entries(INTERRUPTION_EXIT_CODES)) {
    const handler = () => {
      const exit = () => process.exit(code)
      // A removal that fails anyway must not keep an interrupted run alive.
      rm(temporary, { recursive: true, force: true }).then(exit, exit)
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}

function executeNode(args, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal !== null) reject(new Error(`coverage terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = performance.now()
  try {
    const argumentsAfterScript = process.argv.slice(2)
    if (argumentsAfterScript[0] === '--focus') {
      const options = focusedCoverageArguments(argumentsAfterScript.slice(1))
      if (options.help) console.log(focusedCoverageUsage())
      else {
        const selection = await validateFocusedCoverage(options)
        console.log(`Focused sources: ${selection.sources.join(', ')}`)
        console.log(`Focused tests: ${selection.tests.join(', ')}`)
        console.log(`Coverage: file concurrency ${selection.concurrency}`)
        process.exitCode = await runCoverage({
          concurrency: selection.concurrency,
          testArguments: selection.testArguments,
          selectedTestFiles: selection.tests,
          coverageSources: selection.sources,
        })
      }
    } else {
      const concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY)
      console.log(`Coverage: default file concurrency ${concurrency} (DSH_PTC_TEST_CONCURRENCY to override)`)
      process.exitCode = await runCoverage({ concurrency, testArguments: argumentsAfterScript })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    console.log(`Coverage completed in ${((performance.now() - started) / 1000).toFixed(1)}s`)
  }
}
