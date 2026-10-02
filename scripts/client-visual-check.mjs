import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { npmCliCommand } from './npm-cli.mjs'

const { values } = parseArgs({ options: { 'browser-channel': { type: 'string' } } })
const parent = resolve('artifacts/client-visual')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(resolve(parent, 'candidate-'))
const channel = values['browser-channel'] ? ['--browser-channel', values['browser-channel']] : []
async function run(executable, args, env = process.env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { env, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Client visual gate failed: ${code ?? signal}`)))
  })
}
try {
  const command = npmCliCommand(['run', 'test:client'])
  await run(command.executable, command.args, { ...process.env, PTC_BINDING_UI_FIXTURE: directory })
  await run(process.execPath, ['scripts/client-binding-layout.mjs', '--fixtures-dir', directory, ...channel])
  await run(process.execPath, ['scripts/client-fallback-smoke.mjs', ...channel])
} finally {
  await rm(directory, { recursive: true, force: true })
}
