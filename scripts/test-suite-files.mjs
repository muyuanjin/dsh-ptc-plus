import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function testConcurrency(value, parallelism = availableParallelism()) {
  // Each test process can also own compiler realms and runtime workers.
  if (value === undefined) return Math.max(1, Math.min(4, Math.floor(parallelism / 2)))
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

export async function runBackendTests({
  root = projectRoot,
  concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY),
  testArguments = [],
} = {}) {
  const files = await backendTestFiles(root)
  if (files.length === 0) throw new Error('backend test suite contains no test files')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--test', '--experimental-test-module-mocks', `--test-concurrency=${concurrency}`,
      ...testArguments, ...files,
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
      if (signal !== null) reject(new Error(`backend tests terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY)
    console.log(`Backend tests: file concurrency ${concurrency}`)
    process.exitCode = await runBackendTests({ concurrency, testArguments: process.argv.slice(2) })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
