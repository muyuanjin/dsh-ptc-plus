import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const reporter = fileURLToPath(new URL('./coverage-report.mjs', import.meta.url))
const bytecodeCompiler = fileURLToPath(new URL('./compiler-bytecode.mjs', import.meta.url))

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

export async function runCoverage({
  concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY),
  directory = join(root, 'coverage'),
  testArguments = [],
  execute = executeNode,
} = {}) {
  await mkdir(directory, { recursive: true })
  await reclaimAbandonedEvidence(directory)
  // Worker evidence belongs to this invocation, including failed runs.
  // Independent runs must never erase or merge each other's evidence.
  const temporary = await mkdtemp(join(directory, `run-${process.pid}-`))
  const diagnostics = join(directory, `${basename(temporary)}.tap`)
  const bytecode = join(temporary, 'compiler-bytecode.bin')
  const reporters = testArguments.some(argument => /^--test-reporter(?:=|$)/.test(argument)) ? [] : [
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${diagnostics}`,
  ]
  const stopHandlingInterruptions = handleInterruptions(temporary)
  try {
    const started = performance.now()
    const preparationCode = await execute([bytecodeCompiler, bytecode], {
      env: { ...process.env, NODE_V8_COVERAGE: '', DSH_PTC_COMPILER_BYTECODE: undefined },
    })
    if (preparationCode !== 0) return preparationCode
    const testCode = await execute([
      '--test', '--experimental-test-module-mocks', `--test-concurrency=${concurrency}`,
      ...reporters,
      'test/*.test.js', ...testArguments,
    ], { env: { ...process.env, NODE_V8_COVERAGE: temporary, DSH_PTC_COMPILER_BYTECODE: bytecode } })
    console.log(`Coverage tests: ${((performance.now() - started) / 1000).toFixed(1)}s`)
    if (reporters.length > 0) console.log(`Test diagnostics: ${diagnostics}`)
    await rm(bytecode, { force: true })
    const reportCode = await execute([reporter, temporary], { env: { ...process.env, NODE_V8_COVERAGE: '' } })
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
    const concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY)
    console.log(`Coverage: default file concurrency ${concurrency} (DSH_PTC_TEST_CONCURRENCY to override)`)
    process.exitCode = await runCoverage({ concurrency, testArguments: process.argv.slice(2) })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    console.log(`Coverage completed in ${((performance.now() - started) / 1000).toFixed(1)}s`)
  }
}
