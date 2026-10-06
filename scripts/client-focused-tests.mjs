import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmCliCommand } from './npm-cli.mjs'

export function clientTestPattern(arguments_) {
  if (arguments_.length !== 1 || !arguments_[0].trim()) {
    throw new Error('focused Client diagnostics require one nonempty test-name pattern')
  }
  return arguments_[0]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pattern = clientTestPattern(process.argv.slice(2))
  const command = npmCliCommand(['run', 'test:client', '--', `--testNamePattern=${pattern}`])
  const started = performance.now()
  await new Promise((resolveRun, reject) => {
    const child = spawn(command.executable, command.args, { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      console.log(`Focused Client completed in ${((performance.now() - started) / 1000).toFixed(1)} s (${signal ?? code})`)
      if (signal !== null) reject(new Error(`focused Client terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`focused Client exited ${code}`))
      else resolveRun()
    })
  })
}
