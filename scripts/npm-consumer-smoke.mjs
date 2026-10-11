import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { verifyInstalledHostGraph } from './dsh-dependency-baseline.mjs'
import { npmCliCommand } from './npm-cli.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Select actual Host peers, rather than resolving each package's dist-tag. */
export async function consumerManifest(archive, plugin, host) {
  const lock = JSON.parse(await readFile(join(host, 'package-lock.json'), 'utf8'))
  await verifyInstalledHostGraph(host, lock)
  const require = createRequire(join(host, 'package.json'))
  const dependencies = {}
  for (const name of Object.keys(plugin.peerDependencies ?? {})) {
    const filename = require.resolve(`${name}/package.json`)
    const installed = JSON.parse(await readFile(filename, 'utf8'))
    const packagePath = relative(host, dirname(filename)).replaceAll('\\', '/')
    if (installed.name !== name || lock.packages?.[packagePath]?.version !== installed.version) {
      throw new Error(`Host peer ${name} is not proved by its installed frozen graph`)
    }
    dependencies[name] = installed.version
  }
  dependencies[plugin.name] = pathToFileURL(resolve(archive)).href
  return { private: true, type: 'module', dependencies }
}

/** Install and import the same tarball with its Host's required peer cohort. */
export async function smokePackedConsumer(archive, { host = ROOT } = {}) {
  archive = resolve(archive)
  if (!(await stat(archive)).isFile()) throw new Error('consumer smoke requires a tarball file')
  const plugin = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const manifest = await consumerManifest(archive, plugin, resolve(host))
  const consumer = await mkdtemp(join(tmpdir(), 'ptc-packed-consumer-'))
  try {
    await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const npm = npmCliCommand(['install', '--ignore-scripts', '--no-audit', '--no-fund'])
    execFileSync(npm.executable, npm.args, { cwd: consumer, stdio: 'inherit' })
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const require = createRequire(process.cwd() + '/package.json');
      const metadata = require(${JSON.stringify(plugin.name + '/package.json')});
      const installed = await import(${JSON.stringify(plugin.name)});
      if (metadata.version !== ${JSON.stringify(plugin.version)} || installed.name !== 'ptc-plus' || typeof installed.apply !== 'function') {
        throw new Error('packed consumer resolved an unexpected plugin artifact');
      }
      console.log('Packed consumer installation and ESM import passed');
    `], { cwd: consumer, stdio: 'inherit' })
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { host: { type: 'string' } } })
  if (positionals.length !== 1) throw new Error('usage: npm-consumer-smoke.mjs <tarball> [--host <installed-frozen-host>]')
  await smokePackedConsumer(positionals[0], { host: values.host })
}
