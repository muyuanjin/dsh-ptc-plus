import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { extractPackFilename } from './npm-pack-filename.mjs'
import { npmCliCommand, spawnFailure } from './npm-cli.mjs'
import { MANIFEST_PATH, OFFICIAL_REGISTRY, readManifest, verifyInstalledChannel } from './host-channel-manifest.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Installed channel hosts are cache, not source: the manifest is the record. */
const CHANNEL_CACHE = join(ROOT, 'compat', '.channels')
const HOST_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-ptc-runtime',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-util-values',

]
const PROFILE_HOST_PACKAGES = [
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-working-directory',
  '@deepseek-ai/dsh-tool-working-directory',
  '@deepseek-ai/dsh-ptc-runtime-node',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
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
    const failure = spawnFailure(executable, args, result)
    throw new Error(`${failure.message}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
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
  // An optional peer is optional: the plugin resolves whichever host packages
  // exist and probes their shapes, so an absent one is not a contract failure.
  const optional = new Set(Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name))
  const names = [...new Set([...Object.keys(manifest.peerDependencies ?? {}), ...HOST_PACKAGES, ...PROFILE_HOST_PACKAGES])]
  for (const name of names) {
    let targetManifest
    try { targetManifest = resolveHostPackage(requires, name) } catch (error) {
      if ((!lifecycleOnly && PROFILE_HOST_PACKAGES.includes(name) || optional.has(name))
        && error.message === `official DSH graph does not provide ${name}`) continue
      throw error
    }
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
  const manifest = JSON.parse(await readFile(require.resolve('dsh-ptc-plus/package.json'), 'utf8'))
  const { evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const issue = evaluatePluginCompatibility(manifest)
  if (issue !== undefined) {
    throw new Error(`${label} rejected the packed plugin manifest: ${JSON.stringify(issue)}`)
  }
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
  for (const script of lifecycleOnly ? ['dsh-packed-lifecycle-smoke.mjs'] : executionOnly ? ['dsh-execution-seam-smoke.mjs'] : scripts) {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script), 'dsh-ptc-plus'], {
      cwd: consumer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: lifecycleOnly ? 120_000 : 30_000,
      env: {
        ...process.env,
        DSH_PTC_ACTIVE_PRESET_PACKAGE: activePresetPackage,
      },
    })
    if (result.status !== 0) {
      // A contract script the spawn budget killed has no exit status. Naming the
      // outcome and its cause keeps a killed contract distinguishable from a failing
      // one in the text that is the operator's only attribution for a channel.
      const failure = spawnFailure(script, [], result)
      throw new Error(`${label}: ${failure.message}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
    }
    process.stdout.write(result.stdout)
  }
  console.log(`${label}: official DSH ${hostVersion} ${lifecycleOnly ? 'packed lifecycle contract' : executionOnly ? 'packed public execution contract' : 'bounded host contracts'} passed`)
}

/**
 * Install one channel host on demand, from the version the manifest resolved.
 * A cache hit is proven against the manifest; a miss installs that exact version,
 * so refreshing a channel never needs a lockfile edit.
 * @param {object} record - the channel record from the manifest.
 * @returns {Promise<string>} the installed host root.
 */
async function installChannelHost(record) {
  const host = join(CHANNEL_CACHE, record.channel)
  try {
    await verifyInstalledChannel(host, record)
    console.log(`channel ${record.channel}: reusing @deepseek-ai/dsh@${record.version} from ${CHANNEL_CACHE}`)
    return host
  } catch {
    // Nothing usable is cached; install the resolved version below.
  }
  await rm(host, { recursive: true, force: true })
  await mkdir(host, { recursive: true })
  await writeFile(join(host, 'package.json'), `${JSON.stringify({
    name: `dsh-ptc-plus-${record.channel}-host-contract`, private: true, type: 'module',
    dependencies: { '@deepseek-ai/dsh': record.version },
  }, null, 2)}\n`)
  // Pin the official registry: a channel record names bytes the official release
  // published, so the install must come from the same source.
  await writeFile(join(host, '.npmrc'), `ignore-scripts=true\ninstall-links=true\nregistry=${OFFICIAL_REGISTRY}\n`)
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], { cwd: host, timeout: 900_000 })
  await verifyInstalledChannel(host, record)
  return host
}

/**
 * Use an already-installed host, after proving it is the channel the manifest
 * resolved. Equality of inputs alone does not prove which packages load, so the
 * installed versions are checked too.
 * @param {object} record - the channel record from the manifest.
 * @param {string} host - installed host root supplied by the caller.
 * @returns {Promise<string>} the verified host root.
 */
async function verifyExistingHost(record, host) {
  const require = createRequire(join(host, 'package.json'))
  require.resolve('@deepseek-ai/dsh/package.json')
  await verifyInstalledChannel(host, record)
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

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'execution-only': { type: 'boolean', default: false },
  'lifecycle-only': { type: 'boolean', default: false },
  'existing-host': { type: 'string' },
} })
const executionOnly = values['execution-only']
const lifecycleOnly = values['lifecycle-only']
const { channels, document } = await readManifest(ROOT)
const selection = positionals[0] ?? 'blocking'
const chosen = selection === 'all' ? [...channels.values()]
  : selection === 'blocking' || selection === 'channels' ? [...channels.values()].filter(record => record.blocks !== false)
  : [channels.get(selection)]
if (chosen.some(record => record === undefined)) {
  throw new Error(`usage: dsh-host-contract-suite.mjs [all|blocking|${[...channels.keys()].join('|')}] [--execution-only|--lifecycle-only] [--existing-host <path>]`)
}
if (positionals.length > 1 || executionOnly && lifecycleOnly || values['existing-host'] && chosen.length !== 1) {
  throw new Error('invalid host contract selection')
}
console.log(`host channels from ${MANIFEST_PATH}: ${chosen.map(record => `${record.channel}=${record.version}`).join(', ')}`)
const temporary = await mkdtemp(join(tmpdir(), 'ptc-host-contracts-'))
try {
  const report = npm(['pack', '--silent', '--json', '--pack-destination', temporary], {
    cwd: ROOT,
    capture: true,
  })
  const archive = join(temporary, extractPackFilename(JSON.parse(report)))
  console.log(`packed candidate SHA256 ${createHash('sha256').update(await readFile(archive)).digest('hex')}`)
  for (const record of chosen) {
    const host = values['existing-host'] === undefined
      ? await installChannelHost(record)
      : await verifyExistingHost(record, resolve(values['existing-host']))
    await verifyPackedConsumer(temporary, `${record.channel} channel`, host, archive)
  }
  console.log(`host contract manifest SHA256 ${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
