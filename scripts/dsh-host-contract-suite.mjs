import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractPackFilename } from './npm-pack-filename.mjs'
import { npmCliCommand } from './npm-cli.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LATEST_FIXTURE = join(ROOT, 'compat', 'latest')
const HOST_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-typert-registry',
]
const scripts = [
  'dsh-cordis-companion-smoke.mjs',
  'dsh-execution-seam-smoke.mjs',
  'dsh-rpc-contract-smoke.mjs',
  'dsh-message-persistence-smoke.mjs',
]

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  })
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return result.stdout
}

function npm(args, options = {}) {
  const command = npmCliCommand(args)
  return run(command.executable, command.args, options)
}

function resolveHostPackage(requires, name) {
  for (const require of requires) {
    try {
      return require.resolve(`${name}/package.json`)
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`official DSH graph does not provide ${name}`)
}

async function exposeHostPackages(consumer, host) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const hostRequire = createRequire(join(host, 'package.json'))
  const dshRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh/package.json'))
  const baseRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-base/package.json'))
  const requires = [hostRequire, dshRequire, baseRequire]
  const names = [...new Set([...Object.keys(manifest.peerDependencies ?? {}), ...HOST_PACKAGES])]
  for (const name of names) {
    const targetManifest = resolveHostPackage(requires, name)
    const target = dirname(targetManifest)
    const link = join(consumer, 'node_modules', ...name.split('/'))
    try {
      const installed = JSON.parse(await readFile(join(link, 'package.json'), 'utf8'))
      const selected = JSON.parse(await readFile(targetManifest, 'utf8'))
      if (installed.version === selected.version) continue
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await rm(link, { recursive: true, force: true })
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

async function exposePluginDependencies(consumer) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const target = join(ROOT, 'node_modules', ...name.split('/'))
    await readFile(join(target, 'package.json'))
    const link = join(consumer, 'node_modules', ...name.split('/'))
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

async function verifyConsumer(consumer, label, host) {
  const require = createRequire(join(consumer, 'package.json'))
  const plugin = await import(pathToFileURL(require.resolve('dsh-ptc-plus')).href)
  if (plugin.name !== 'ptc-plus' || typeof plugin.apply !== 'function') {
    throw new Error(`${label} resolved invalid dsh-ptc-plus exports`)
  }
  const hostVersion = require('@deepseek-ai/dsh/package.json').version
  const hostRequire = createRequire(join(host, 'package.json'))
  const dshRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh/package.json'))
  const baseRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-base/package.json'))
  const activePresetPackage = dirname(resolveHostPackage(
    [hostRequire, dshRequire, baseRequire],
    '@deepseek-ai/dsh-agent-preset',
  ))
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script), 'dsh-ptc-plus'], {
      cwd: consumer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        ...process.env,
        DSH_PTC_ACTIVE_PRESET_PACKAGE: activePresetPackage,
      },
    })
    if (result.status !== 0) {
      throw new Error(`${label} / ${script} failed\n${result.stdout}${result.stderr}`)
    }
    process.stdout.write(result.stdout)
  }
  console.log(`${label}: official DSH ${hostVersion} host contracts passed`)
}

async function installLatestHost(temporary) {
  const host = join(temporary, 'latest-host')
  await mkdir(host)
  for (const filename of ['package.json', 'package-lock.json', '.npmrc']) {
    await copyFile(join(LATEST_FIXTURE, filename), join(host, filename))
  }
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: host })
  return host
}

async function verifyPackedConsumer(temporary, label, host, archive) {
  const consumer = join(temporary, `${label.split(' ')[0]}-consumer`)
  const plugin = join(consumer, 'node_modules', 'dsh-ptc-plus')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', plugin])
  await exposePluginDependencies(consumer)
  await exposeHostPackages(consumer, host)
  const stalePackage = join(consumer, 'node_modules', '@deepseek-ai', 'dsh-agent-presets')
  await mkdir(join(stalePackage, 'presets', 'cordis', 'skills', 'cordis-plugin-development'), { recursive: true })
  await writeFile(join(stalePackage, 'package.json'), '{"name":"@deepseek-ai/dsh-agent-presets","version":"0.0.0-stale"}\n')
  await writeFile(
    join(stalePackage, 'presets', 'cordis', 'skills', 'cordis-plugin-development', 'SKILL.md'),
    '# stale companion must never be mounted\n',
  )
  await verifyConsumer(consumer, label, host)
}

const selection = process.argv[2] ?? 'all'
if (!['all', 'next', 'latest'].includes(selection)) {
  throw new Error('usage: dsh-host-contract-suite.mjs [all|next|latest]')
}
const temporary = await mkdtemp(join(tmpdir(), 'ptc-host-contracts-'))
try {
  const report = npm(['pack', '--silent', '--json', '--pack-destination', temporary], {
    cwd: ROOT,
    capture: true,
  })
  const archive = join(temporary, extractPackFilename(JSON.parse(report)))
  if (selection !== 'latest') {
    await verifyPackedConsumer(temporary, 'next baseline', ROOT, archive)
  }
  if (selection !== 'next') {
    const latestHost = await installLatestHost(temporary)
    await verifyPackedConsumer(temporary, 'latest baseline', latestHost, archive)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
