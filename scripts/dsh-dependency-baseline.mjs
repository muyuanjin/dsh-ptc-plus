import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { npmCliCommand } from './npm-cli.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIRECTORY, '..')
const LATEST_ROOT = join(ROOT, 'compat', 'latest')
const CURRENT_ROOT = join(ROOT, 'compat', 'current')
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

export function isHostServicePackageName(name) {
  return /^@deepseek-ai\/(?:dsh(?:-[^/]+)?|cordis(?:-[^/]+)?|schemastery)$/.test(name)
}

/** Validate the actual Host service cohort, including nested copies, before reuse. */
export async function verifyInstalledHostGraph(root, lock) {
  lock ??= await json(join(root, 'package-lock.json'))
  const verified = []
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    const match = /(?:^|\/)node_modules\/(@[^/]+\/[^/]+)$/.exec(packagePath)
    if (!match || !isHostServicePackageName(match[1])) continue
    const installed = await json(join(root, packagePath, 'package.json'))
    if (installed.name !== match[1] || installed.version !== entry.version) {
      throw new Error(`installed Host ${packagePath} differs from its frozen lock; run npm ci`)
    }
    verified.push({ packagePath, name: installed.name, version: installed.version })
  }
  return verified
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

/** Published release identity selects a registry channel; service tags do not select a cohort. */
export function selectPublishedRelease(distTags, releases) {
  const release = releases.filter(item => item.draft === false
    && typeof item.tag_name === 'string' && item.tag_name.startsWith('dsh-v')
    && typeof item.published_at === 'string')
    .sort((left, right) => right.published_at.localeCompare(left.published_at))[0]
  if (release === undefined) throw new Error('official DSH has no published release')
  const version = release.tag_name.slice('dsh-v'.length)
  const channels = Object.entries(distTags).filter(([, value]) => value === version)
    .map(([name]) => name).sort()
  if (channels.length === 0) throw new Error(`published DSH release ${release.tag_name} has no official npm channel`)
  return validatePublishedRelease({ version, channel: channels[0], releaseTag: release.tag_name, publishedAt: release.published_at })
}

/** One normalized identity owns both offline provenance and refresh equality. */
export function validatePublishedRelease(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)
    || ['version', 'channel', 'releaseTag', 'publishedAt'].some(key => typeof source[key] !== 'string' || !source[key].trim()
      || source[key] !== source[key].trim())
    || source.releaseTag !== `dsh-v${source.version}` || !Number.isFinite(Date.parse(source.publishedAt))
    || new Date(source.publishedAt).toISOString().replace('.000Z', 'Z') !== source.publishedAt) {
    throw new Error('invalid frozen published DSH release provenance')
  }
  return { version: source.version, channel: source.channel, releaseTag: source.releaseTag, publishedAt: source.publishedAt }
}

async function publishedRelease(distTags) {
  const response = await fetch('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100', {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`official DSH release discovery failed: HTTP ${response.status}`)
  const releases = await response.json()
  if (!Array.isArray(releases)) throw new Error('official DSH releases response is not an array')
  return selectPublishedRelease(distTags, releases)
}

export async function verifyCurrent(root = CURRENT_ROOT) {
  const manifest = await json(join(root, 'package.json'))
  const lock = await json(join(root, 'package-lock.json'))
  const source = validatePublishedRelease(await json(join(root, 'release.json')))
  if (manifest.dependencies?.['@deepseek-ai/dsh'] !== source.channel
    || lock.packages?.['']?.dependencies?.['@deepseek-ai/dsh'] !== source.channel) {
    throw new Error('compat/current declaration must match its captured release channel')
  }
  const version = lockedPackage(lock, '@deepseek-ai/dsh', 'compat/current/package-lock.json').version
  if (version !== source.version || dshLockEntries(lock).some(([, entry]) => entry.version !== version)) {
    throw new Error('compat/current must freeze the complete published official DSH cohort')
  }
  return source
}

export async function update({ root = ROOT, latestRoot = LATEST_ROOT, currentRoot = CURRENT_ROOT,
  readTags = tags, readRelease = publishedRelease, runNpm = npmCommand } = {}) {
  const before = readTags()
  if (typeof before.latest !== 'string' || typeof before.next !== 'string') {
    throw new Error('official @deepseek-ai/dsh dist-tags must include latest and next')
  }
  const currentNext = await verifyRoot({ installed: false, root })
  const currentLatest = await verifyLatest({ installed: false, root: latestRoot })
  const release = validatePublishedRelease(await readRelease(before))
  let currentPublished
  try { currentPublished = await verifyCurrent(currentRoot) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (currentNext === before.next && currentLatest === before.latest && JSON.stringify(currentPublished) === JSON.stringify(release)) {
    console.log(`frozen DSH baselines are current: latest=${currentLatest}, next=${currentNext}`)
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ptc-dsh-baseline-'))
  const nextCandidate = join(scratch, 'next')
  const latestCandidate = join(scratch, 'latest')
  const publishedCandidate = join(scratch, 'current')
  try {
    await Promise.all([mkdir(nextCandidate), mkdir(latestCandidate), mkdir(publishedCandidate)])
    await Promise.all([
      copyFile(join(root, 'package.json'), join(nextCandidate, 'package.json')),
      copyFile(join(root, 'package-lock.json'), join(nextCandidate, 'package-lock.json')),
      copyFile(join(latestRoot, 'package.json'), join(latestCandidate, 'package.json')),
      copyFile(join(latestRoot, 'package-lock.json'), join(latestCandidate, 'package-lock.json')),
      copyFile(join(latestRoot, '.npmrc'), join(latestCandidate, '.npmrc')),
    ])
    if (currentNext !== before.next) {
      const manifest = await json(join(root, 'package.json'))
      const specifications = dshDevelopmentPackages(manifest).map(([name]) => `${name}@next`)
      // npm cannot atomically move a complete peer cohort away from an old lock.
      // Resolve that transition in isolation, restore the tag declarations, then
      // require an ordinary resolver pass before publishing the candidate lock.
      runNpm([
        'install', '--package-lock-only', '--ignore-scripts', '--force', '--loglevel=error',
        '--save-dev', ...specifications,
      ], { cwd: nextCandidate })
      await copyFile(join(root, 'package.json'), join(nextCandidate, 'package.json'))
      runNpm(['install', '--package-lock-only', '--ignore-scripts'], { cwd: nextCandidate })
      runNpm(['ci', '--dry-run', '--ignore-scripts'], { cwd: nextCandidate })
    }
    if (currentLatest !== before.latest) {
      runNpm([
        'install', '--package-lock-only', '--ignore-scripts', '--save-exact',
        '@deepseek-ai/dsh@latest',
      ], { cwd: latestCandidate })
      await copyFile(join(latestRoot, 'package.json'), join(latestCandidate, 'package.json'))
      runNpm(['install', '--package-lock-only', '--ignore-scripts'], { cwd: latestCandidate })
      runNpm(['ci', '--dry-run', '--ignore-scripts'], { cwd: latestCandidate })
    }
    const publishedManifest = {
      name: 'dsh-ptc-plus-published-host-contract', private: true, type: 'module',
      dependencies: { '@deepseek-ai/dsh': release.channel },
    }
    await writeFile(join(publishedCandidate, 'package.json'), JSON.stringify(publishedManifest, null, 2) + '\n')
    await writeFile(join(publishedCandidate, 'release.json'), JSON.stringify(release, null, 2) + '\n')
    await copyFile(join(latestRoot, '.npmrc'), join(publishedCandidate, '.npmrc'))
    if (currentPublished?.version === release.version) {
      const publishedLock = await json(join(currentRoot, 'package-lock.json'))
      publishedLock.packages[''].dependencies['@deepseek-ai/dsh'] = release.channel
      await writeFile(join(publishedCandidate, 'package-lock.json'), JSON.stringify(publishedLock, null, 2) + '\n')
      if (currentPublished.channel !== release.channel) runNpm(['ci', '--dry-run', '--ignore-scripts'], { cwd: publishedCandidate })
    } else {
      runNpm(['install', '--package-lock-only', '--ignore-scripts'], { cwd: publishedCandidate })
      runNpm(['ci', '--dry-run', '--ignore-scripts'], { cwd: publishedCandidate })
    }
    const after = readTags()
    const finalRelease = validatePublishedRelease(await readRelease(after))
    if (after.latest !== before.latest || after.next !== before.next
      || JSON.stringify(finalRelease) !== JSON.stringify(release)) {
      throw new Error('official DSH dist-tags changed during baseline refresh; retry the update')
    }
    const nextVersion = await verifyRoot({ installed: false, root: nextCandidate })
    const latestVersion = await verifyLatest({ installed: false, root: latestCandidate })
    const publishedVersion = (await verifyCurrent(publishedCandidate)).version
    if (nextVersion !== before.next || latestVersion !== before.latest) {
      throw new Error(`resolved DSH baselines do not match captured tags (latest=${before.latest}, next=${before.next})`)
    }
    await mkdir(currentRoot, { recursive: true })
    await Promise.all([
      copyFile(join(nextCandidate, 'package-lock.json'), join(root, 'package-lock.json')),
      copyFile(join(latestCandidate, 'package-lock.json'), join(latestRoot, 'package-lock.json')),
      ...['package.json', 'package-lock.json', 'release.json', '.npmrc'].map(filename =>
        copyFile(join(publishedCandidate, filename), join(currentRoot, filename))),
    ])
    console.log(`updated frozen DSH baselines: latest=${latestVersion}, next=${nextVersion}, published=${publishedVersion}`)
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
  const publishedVersion = (await verifyCurrent()).version
  console.log(`verified frozen DSH baselines: latest=${latestVersion}, next=${nextVersion}, published=${publishedVersion}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(`dsh-dependency-baseline: ${error.message}`)
  process.exitCode = 1
})
