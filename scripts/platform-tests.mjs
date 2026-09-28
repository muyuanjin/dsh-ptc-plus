import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testConcurrency } from './coverage.mjs'
import { backendTestFiles, splitBackendTestFiles } from './test-suite-files.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const bytecodeCompiler = fileURLToPath(new URL('./compiler-bytecode.mjs', import.meta.url))

function runNode(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal !== null) reject(new Error(`platform tests terminated by ${signal}`))
      else resolveRun(code ?? 1)
    })
  })
}

export async function runPlatformTests({
  concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY),
  files,
  execute = runNode,
  environment = process.env,
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'ptc-platform-tests-'))
  const bytecode = join(temporary, 'compiler-bytecode.bin')
  const removedKeys = new Set([
    'NODE_V8_COVERAGE',
    'DSH_PTC_TEST_WORKER_COVERAGE',
    'DSH_PTC_COMPILER_BYTECODE',
  ])
  const env = Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !removedKeys.has(key.toUpperCase())))
  try {
    let code = await execute([bytecodeCompiler, bytecode], env)
    if (code !== 0) return code
    const selection = splitBackendTestFiles(files ?? await backendTestFiles(root))
    const runGroup = group => execute([
      '--test', '--experimental-test-module-mocks', `--test-concurrency=${concurrency}`, ...group,
    ], { ...env, DSH_PTC_COMPILER_BYTECODE: bytecode })
    if (selection.mockPreload.length > 0) code = await runGroup(selection.mockPreload)
    if (code === 0 && selection.ordinary.length > 0) code = await runGroup(selection.ordinary)
    return code
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const concurrency = testConcurrency(process.env.DSH_PTC_TEST_CONCURRENCY)
  console.log(`Platform tests: file concurrency ${concurrency} without coverage`)
  process.exitCode = await runPlatformTests({ concurrency })
}
