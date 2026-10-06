import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmCliCommand } from './npm-cli.mjs'

export async function runDeterministicTestGroups({
  ci = false, parallelism = availableParallelism(), spawnProcess = spawn,
} = {}) {
  const groups = ['test:client:visual', ci ? 'test:ci:runtime' : 'test:backend']
  const run = name => new Promise((resolveRun, reject) => {
    const started = performance.now()
    console.log(`Starting ${name}`)
    const command = npmCliCommand(['run', name])
    const child = spawnProcess(command.executable, command.args, { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      console.log(`${name} completed in ${((performance.now() - started) / 1000).toFixed(1)} s (${signal ?? code})`)
      if (signal !== null) reject(new Error(`${name} terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`${name} exited ${code}`))
      else resolveRun()
    })
  })
  // The backend owns bounded file fanout; browsers own a separate bounded
  // pool. Small runners retain serial phases rather than oversubscribing both.
  const parallel = parallelism >= 12
  console.log(`Deterministic test groups: ${parallel ? 'parallel' : 'serial'} (${parallelism} available CPUs)`)
  if (!parallel) {
    for (const name of groups) await run(name)
    return
  }
  const results = await Promise.allSettled(groups.map(run))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'deterministic test groups failed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2)
  if (arguments_.some(value => value !== '--ci') || arguments_.length > 1) {
    throw new Error('usage: deterministic-test-groups.mjs [--ci]')
  }
  await runDeterministicTestGroups({ ci: arguments_[0] === '--ci' })
}
