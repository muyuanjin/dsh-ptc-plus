import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

/**
 * Files that observe the verification tooling itself: they spawn their own
 * subprocesses and one of them fails by construction when run outside its
 * harness. They belong to the complete gate, never to the fast tier.
 */
const FAST_TIER_EXCLUDED = new Set([
  'test/test-suite-files.test.js',
  'test/verification-workflow.test.js',
  'test/deterministic-test-groups.test.js',
])

export function testConcurrency(value, parallelism = availableParallelism()) {
  // Default file fanout is half the available CPUs, capped at eight; each
  // file may also create compiler realms and runtime workers.
  if (value === undefined) return Math.max(1, Math.min(8, Math.floor(parallelism / 2)))
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('DSH_PTC_TEST_CONCURRENCY must be a positive integer')
  }
  return Number(value)
}

export const MOCK_PRELOAD_FILE_NAMES = new Set([
  'isolated-worker.test.js',
  'session-runtime-faults.test.js',
  'user-binding-console-transport.test.js',
  'user-bindings-owner-faults.test.js',
])

export async function backendTestFiles(root, { coverage = false } = {}) {
  const files = (await readdir(join(root, 'test')))
    .filter(name => name.endsWith('.test.js'))
    .map(name => `test/${name}`)
  if (coverage) {
    let coverageFiles
    try {
      coverageFiles = await readdir(join(root, 'test', 'coverage'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      coverageFiles = []
    }
    files.push(...coverageFiles.filter(name => name.endsWith('.test.js'))
      .map(name => `test/coverage/${name}`))
  }
  return files.sort()
}

export function splitBackendTestFiles(files) {
  return {
    mockPreload: files.filter(file => MOCK_PRELOAD_FILE_NAMES.has(basename(file))),
    ordinary: files.filter(file => !MOCK_PRELOAD_FILE_NAMES.has(basename(file))),
  }
}

/**
 * Fast tier: the test files the semantic ownership graph names as evidence for
 * at least one obligation. `npm run check` runs this tier so a commit gate stays
 * inside its time budget; `npm run verify` keeps the complete ordinary inventory.
 * Coverage-only paths and the verification-tooling probes are excluded: they
 * either require instrumentation or fail by construction outside their harness.
 */
export async function fastTierTestFiles(root) {
  const graph = JSON.parse(await readFile(join(root, 'semantic-obligations.json'), 'utf8'))
  const files = new Set()
  for (const obligation of graph.obligations ?? []) {
    for (const entry of obligation.evidence ?? []) {
      if (typeof entry !== 'string' || !entry.endsWith('.test.js')) continue
      if (!entry.startsWith('test/') || entry.startsWith('test/coverage/')) continue
      if (FAST_TIER_EXCLUDED.has(entry)) continue
      files.add(entry)
    }
  }
  return [...files].sort()
}

export function selectBackendTestFiles(files, requested = []) {
  if (requested.length === 0) return files
  const selected = new Set(requested)
  for (const file of selected) {
    if (!files.includes(file)) throw new Error(`not an ordinary backend test file: ${file}`)
  }
  return files.filter(file => selected.has(file))
}

export function backendArguments(arguments_) {
  const { values, tokens } = parseArgs({
    args: arguments_, tokens: true, allowPositionals: false,
    options: {
      file: { type: 'string', multiple: true },
      list: { type: 'boolean' },
      focus: { type: 'boolean' },
      fast: { type: 'boolean' },
      'test-name-pattern': { type: 'string', multiple: true },
      'test-skip-pattern': { type: 'string', multiple: true },
      'test-reporter': { type: 'string', multiple: true },
      'test-reporter-destination': { type: 'string', multiple: true },
      'test-timeout': { type: 'string' },
      'test-concurrency': { type: 'string' },
      'test-only': { type: 'boolean' },
      'test-force-exit': { type: 'boolean' },
    },
  })
  if (values.focus && !values.file?.length && !values.list) {
    throw new Error('focused backend diagnostics require --file <test/path.test.js>; use --list to inspect the inventory')
  }
  // Diagnostic options cannot introduce another test-file input or enable
  // coverage. Node retains ownership of the accepted option values.
  const testArguments = tokens.filter(token => token.kind === 'option' && !['file', 'list', 'focus', 'fast'].includes(token.name))
    .map(token => token.value === undefined ? `--${token.name}` : `--${token.name}=${token.value}`)
  if (values.fast && values.file?.length) throw new Error('--fast selects the semantic-evidence tier; do not combine it with --file')
  return { files: values.file ?? [], testArguments, list: values.list ?? false, fast: values.fast ?? false }
}

export async function runBackendTests({
  root = projectRoot,
  concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY),
  testArguments = [],
  files: requestedFiles = [],
  fast = false,
} = {}) {
  const diagnostic = backendArguments(testArguments)
  if (diagnostic.files.length > 0 || diagnostic.list) throw new Error('file selection belongs in the files option')
  const files = selectBackendTestFiles(await backendTestFiles(root),
    fast ? await fastTierTestFiles(root) : requestedFiles)
  if (files.length === 0) throw new Error('backend test suite contains no test files')
  const started = performance.now()
  console.log(`Backend inventory: ${files.length} files; concurrency ${concurrency}`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--test', '--experimental-test-module-mocks', `--test-concurrency=${concurrency}`,
      ...diagnostic.testArguments, ...files,
    ], {
      cwd: root,
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        NODE_V8_COVERAGE: '',
        DSH_PTC_TEST_WORKER_COVERAGE: undefined,
        DSH_PTC_TEST_COVERAGE_SUITE: undefined,
        DSH_PTC_COMPILER_BYTECODE: undefined,
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      console.log(`Backend completed in ${((performance.now() - started) / 1000).toFixed(1)} s (${signal ?? code ?? 1})`)
      if (signal !== null) reject(new Error(`backend tests terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { files, testArguments, list, fast } = backendArguments(process.argv.slice(2))
    const concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY)
    if (list) console.log(selectBackendTestFiles(await backendTestFiles(projectRoot),
      fast ? await fastTierTestFiles(projectRoot) : files).join('\n'))
    else {
      console.log(`Backend tests: ${fast ? 'semantic-evidence tier, ' : files.length ? 'focused files, ' : ''}file concurrency ${concurrency}`)
      process.exitCode = await runBackendTests({ concurrency, testArguments, files, fast })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
