import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmCliCommand } from './npm-cli.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIRECTORY, '..')
const LATEST_ROOT = join(ROOT, 'compat', 'latest')
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'

async function json(filename) {
  return JSON.parse(await readFile(filename, 'utf8'))
}

function npmCommand(args, options = {}) {
  const command = npmCliCommand(args)
  return execFileSync(command.executable, command.args, {
    cwd: options.cwd ?? ROOT,
    encoding: options.encoding,
    stdio: options.encoding === undefined ? 'inherit' : ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      NPM_CONFIG_REGISTRY: OFFICIAL_REGISTRY,
    },
  })
}

function dshDevelopmentPackages(manifest) {
  return Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .sort(([left], [right]) => left.localeCompare(right))
}

function lockedPackage(lock, name, owner) {
  const entry = lock.packages?.[`node_modules/${name}`]
  if (typeof entry?.version !== 'string' || entry.version.length === 0) {
    throw new Error(`${owner} does not lock ${name}`)
  }
  return entry
}

function dshLockEntries(lock) {
  const pattern = /(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/
  return Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => pattern.test(packagePath))
    .sort(([left], [right]) => left.localeCompare(right))
}

function installedVersion(root, name) {
  const require = createRequire(join(root, 'package.json'))
  try {
    return require(`${name}/package.json`).version
  } catch (error) {
    throw new Error(`${name} is not installed under ${root}; run npm ci (${error.message})`)
  }
}

async function verifyRoot({ installed, root = ROOT }) {
  const manifest = await json(join(root, 'package.json'))
  const lock = await json(join(root, 'package-lock.json'))
  const packages = dshDevelopmentPackages(manifest)
  if (!packages.some(([name]) => name === '@deepseek-ai/dsh')) {
    throw new Error('package.json must include @deepseek-ai/dsh as the next-channel graph owner')
  }
  const rootLock = lock.packages?.['']
  for (const [name, requested] of packages) {
    if (requested !== 'next' || rootLock?.devDependencies?.[name] !== 'next') {
      throw new Error(`${name} must declare and lock the next channel`)
    }
    const locked = lockedPackage(lock, name, 'package-lock.json')
    if (installed && installedVersion(root, name) !== locked.version) {
      throw new Error(`${name} does not match package-lock.json; run npm ci`)
    }
  }
  const hostVersion = lockedPackage(lock, '@deepseek-ai/dsh', 'package-lock.json').version
  const mismatched = []
  for (const [packagePath, entry] of dshLockEntries(lock)) {
    if (entry.version !== hostVersion) {
      mismatched.push(`${packagePath}@${entry.version}`)
      continue
    }
    if (!installed) continue
    let version
    try {
      version = (await json(join(root, packagePath, 'package.json'))).version
    } catch (error) {
      throw new Error(`${packagePath} is not installed under ${root}; run npm ci (${error.message})`)
    }
    if (version !== entry.version) {
      mismatched.push(`${packagePath}: installed ${version}, locked ${entry.version}`)
    }
  }
  if (mismatched.length > 0) {
    throw new Error(`next-channel DSH graph does not match @deepseek-ai/dsh@${hostVersion}: ${mismatched.join(', ')}`)
  }
  return hostVersion
}

async function verifyLatest({ installed, root = LATEST_ROOT }) {
  const manifest = await json(join(root, 'package.json'))
  const lock = await json(join(root, 'package-lock.json'))
  if (manifest.dependencies?.['@deepseek-ai/dsh'] !== 'latest'
    || lock.packages?.['']?.dependencies?.['@deepseek-ai/dsh'] !== 'latest') {
    throw new Error('compat/latest must declare and lock the latest DSH channel')
  }
  const version = lockedPackage(lock, '@deepseek-ai/dsh', 'compat/latest/package-lock.json').version
  const mismatched = dshLockEntries(lock)
    .filter(([, entry]) => entry.version !== version)
    .map(([packagePath, entry]) => `${packagePath}@${entry.version}`)
  if (mismatched.length > 0) {
    throw new Error(`latest-channel DSH graph does not match @deepseek-ai/dsh@${version}: ${mismatched.join(', ')}`)
  }
  if (installed && installedVersion(root, '@deepseek-ai/dsh') !== version) {
    throw new Error('@deepseek-ai/dsh under compat/latest does not match its lock; run npm ci --prefix compat/latest')
  }
  return version
}

function tags() {
  return JSON.parse(npmCommand([
    'view', '@deepseek-ai/dsh', 'dist-tags', '--json', `--registry=${OFFICIAL_REGISTRY}`,
  ], { encoding: 'utf8' }))
}

async function update() {
  const before = tags()
  if (typeof before.latest !== 'string' || typeof before.next !== 'string') {
    throw new Error('official @deepseek-ai/dsh dist-tags must include latest and next')
  }
  const currentNext = await verifyRoot({ installed: false })
  const currentLatest = await verifyLatest({ installed: false })
  if (currentNext === before.next && currentLatest === before.latest) {
    console.log(`frozen DSH baselines are current: latest=${currentLatest}, next=${currentNext}`)
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ptc-dsh-baseline-'))
  const nextCandidate = join(scratch, 'next')
  const latestCandidate = join(scratch, 'latest')
  try {
    await Promise.all([mkdir(nextCandidate), mkdir(latestCandidate)])
    await Promise.all([
      copyFile(join(ROOT, 'package.json'), join(nextCandidate, 'package.json')),
      copyFile(join(ROOT, 'package-lock.json'), join(nextCandidate, 'package-lock.json')),
      copyFile(join(LATEST_ROOT, 'package.json'), join(latestCandidate, 'package.json')),
      copyFile(join(LATEST_ROOT, 'package-lock.json'), join(latestCandidate, 'package-lock.json')),
      copyFile(join(LATEST_ROOT, '.npmrc'), join(latestCandidate, '.npmrc')),
    ])
    if (currentNext !== before.next) {
      const manifest = await json(join(ROOT, 'package.json'))
      const specifications = dshDevelopmentPackages(manifest).map(([name]) => `${name}@next`)
      // npm cannot atomically move a complete peer cohort away from an old lock.
      // Resolve that transition in isolation, restore the tag declarations, then
      // require an ordinary resolver pass before publishing the candidate lock.
      npmCommand([
        'install', '--package-lock-only', '--ignore-scripts', '--force', '--loglevel=error',
        '--save-dev', ...specifications,
      ], { cwd: nextCandidate })
      await copyFile(join(ROOT, 'package.json'), join(nextCandidate, 'package.json'))
      npmCommand(['install', '--package-lock-only', '--ignore-scripts'], { cwd: nextCandidate })
      npmCommand(['ci', '--dry-run', '--ignore-scripts'], { cwd: nextCandidate })
    }
    if (currentLatest !== before.latest) {
      npmCommand([
        'install', '--package-lock-only', '--ignore-scripts', '--save-exact',
        '@deepseek-ai/dsh@latest',
      ], { cwd: latestCandidate })
      await copyFile(join(LATEST_ROOT, 'package.json'), join(latestCandidate, 'package.json'))
      npmCommand(['install', '--package-lock-only', '--ignore-scripts'], { cwd: latestCandidate })
      npmCommand(['ci', '--dry-run', '--ignore-scripts'], { cwd: latestCandidate })
    }
    const after = tags()
    if (after.latest !== before.latest || after.next !== before.next) {
      throw new Error('official DSH dist-tags changed during baseline refresh; retry the update')
    }
    const nextVersion = await verifyRoot({ installed: false, root: nextCandidate })
    const latestVersion = await verifyLatest({ installed: false, root: latestCandidate })
    if (nextVersion !== before.next || latestVersion !== before.latest) {
      throw new Error(`resolved DSH baselines do not match captured tags (latest=${before.latest}, next=${before.next})`)
    }
    await Promise.all([
      copyFile(join(nextCandidate, 'package-lock.json'), join(ROOT, 'package-lock.json')),
      copyFile(join(latestCandidate, 'package-lock.json'), join(LATEST_ROOT, 'package-lock.json')),
    ])
    console.log(`updated frozen DSH baselines: latest=${latestVersion}, next=${nextVersion}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main() {
  const command = process.argv[2]
  if (command === 'update') return update()
  if (command !== 'verify') throw new Error('usage: dsh-dependency-baseline.mjs <update|verify>')
  const nextVersion = await verifyRoot({ installed: true })
  const latestVersion = await verifyLatest({ installed: false })
  console.log(`verified frozen DSH baselines: latest=${latestVersion}, next=${nextVersion}`)
}

main().catch(error => {
  console.error(`dsh-dependency-baseline: ${error.message}`)
  process.exitCode = 1
})
