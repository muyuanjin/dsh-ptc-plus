/**
 * Host compatibility channels.
 *
 * A channel is a named host line resolved from a registry dist-tag, not a
 * version: `latest` is the newest published release, `next` the in-flight
 * release-candidate line, and `alpha` a pre-adaptation for a line the host has
 * not released yet. What a channel decides is whether the host-contract suite
 * blocks a release (`blocks`) or only reports; it never decides which behaviour
 * the plugin implements, because behaviour is detected from host shapes.
 *
 * The generated manifest replaces checked-in dependency snapshots: it records,
 * per channel, the resolved host version, the tarball integrity of every host
 * package whose published surface the plugin probes, and nothing else. The
 * official host publishes those packages as one cohort, so one version per
 * channel identifies the whole graph and refreshing is one command.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { npmCliCommand, spawnFailure } from './npm-cli.mjs'

export const SCHEMA = 'dsh-host-channels/v1'
export const MANIFEST_PATH = 'compat/channels.json'
/** Dist-tags that identify a supported channel, with whether it may block a release. */
export const CHANNELS = Object.freeze([
  Object.freeze({ channel: 'latest', distTag: 'latest', blocks: true }),
  Object.freeze({ channel: 'next', distTag: 'next', blocks: true }),
  Object.freeze({ channel: 'alpha', distTag: 'alpha', blocks: false }),
])
/** The package whose dist-tag selects the cohort, and the package every install is rooted at. */
export const COHORT_PACKAGE = '@deepseek-ai/dsh'

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)))
}

/**
 * Read the host packages whose published surface the plugin probes: every
 * declared peer plus the cohort root. An optional peer is included, because the
 * manifest must record what the host actually publishes on each channel.
 * @param {object} manifest - this package's parsed `package.json`.
 * @returns {string[]} package names, sorted.
 */
export function probePackages(manifest) {
  return [...new Set([COHORT_PACKAGE, ...Object.keys(manifest.peerDependencies ?? {})])].sort()
}

/** One registry packument request, independent of the npm client's cache. */
async function fetchPackument(registry, name) {
  const response = await fetch(`${registry}${name.replace('/', '%2F')}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`host channel resolution failed for ${name}: HTTP ${response.status}`)
  return response.json()
}

/** The official registry is the supply authority for a channel record: a mirror
 * could resolve the same tag to bytes the official release never published. */
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'

async function officialRegistry() {
  return OFFICIAL_REGISTRY
}

/**
 * Parse one registry version into the components a range comparator reads.
 * @param {string} version - a published semver version.
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]}}
 */
function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version))
  if (match === null) throw new Error(`host channel version ${JSON.stringify(version)} is not a semantic version`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Total order over parsed versions, prereleases below their release. */
function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : (left.prerelease.length === 0 ? 1 : -1)
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart)
    const rightNumber = /^\d+$/.test(rightPart)
    if (leftNumber && rightNumber) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/**
 * One range comparator: which versions it admits and the upper bound it implies.
 *
 * The ranges this file resolves are the ones a host release declares on the packages
 * an install receives, so the operators that occur there — a caret, a tilde, a bare
 * version and the four ordered comparisons — are the ones implemented. Anything else
 * throws: a range this script cannot read must not silently pin the wrong bytes.
 */
function comparator(token) {
  if (token === '' || token === '*' || token === 'x') return () => true
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
  const operator = match[1] ?? '='
  const base = parseVersion(match[2])
  switch (operator) {
    case '=': return version => compareVersions(version, base) === 0
    case '>': return version => compareVersions(version, base) > 0
    case '>=': return version => compareVersions(version, base) >= 0
    case '<': return version => compareVersions(version, base) < 0
    case '<=': return version => compareVersions(version, base) <= 0
    case '~': return version => compareVersions(version, base) >= 0
      && version.major === base.major && version.minor === base.minor
    // `^` is the one operator the pattern above can produce that is not listed here;
    // a range spelling anything else fails in parseVersion before this point.
    default: return version => compareVersions(version, base) >= 0 && (base.major > 0
      ? version.major === base.major
      : base.minor > 0
        ? version.major === 0 && version.minor === base.minor
        : version.major === 0 && version.minor === 0 && version.patch === base.patch)
  }
}

/**
 * Whether a published version satisfies a declared range.
 *
 * A prerelease only satisfies a range that itself names a prerelease of the same
 * release, which is how npm keeps an in-flight line from entering a settled one.
 * @param {string} version - the published version being considered.
 * @param {string} range - the range the host release declares.
 * @returns {boolean} whether an install of that range could receive this version.
 */
export function satisfiesRange(version, range) {
  const candidate = parseVersion(version)
  return String(range).split('||').some(alternative => {
    const tokens = alternative.trim().split(/\s+/).filter(token => token.length > 0)
    if (!tokens.every(token => comparator(token)(candidate))) return false
    if (candidate.prerelease.length === 0) return true
    return tokens.some(token => {
      // A wildcard names no release, so it admits no prerelease — and it has no
      // version to parse either.
      if (token === '*' || token === 'x') return false
      const base = parseVersion(/^(?:>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)[1])
      return base.prerelease.length > 0 && base.major === candidate.major
        && base.minor === candidate.minor && base.patch === candidate.patch
    })
  })
}

/** The highest published version of a package that satisfies a declared range. */
function highestSatisfying(packument, range) {
  const versions = Object.keys(packument?.versions ?? {})
    .filter(version => satisfiesRange(version, range))
    .map(version => ({ version, parsed: parseVersion(version) }))
  if (versions.length === 0) return undefined
  versions.sort((left, right) => compareVersions(left.parsed, right.parsed))
  return versions.at(-1).version
}

/**
 * Resolve one channel from its dist-tag.
 *
 * The host release is the `@deepseek-ai/dsh` version that tag names. Packages
 * published in that same release join the channel at that exact version, which is
 * what identifies their bytes. A probe package that publishes no such version is
 * not on the release train — its dist-tag tracks its own versioning — so the
 * channel records the version that host release's own dependency range resolves
 * to, with that tarball's integrity. A probed package the release neither publishes
 * nor depends on is not part of an install of that channel at all, which is a
 * different fact from a pinned one and is recorded as absent.
 * @param {object} packuments - one packument per probe package.
 * @param {object} definition - the channel definition from {@link CHANNELS}.
 * @param {string[]} packages - probe package names.
 * @returns {object} the channel record to store.
 */
export function resolveChannel(packuments, definition, packages) {
  const version = packuments[COHORT_PACKAGE]?.['dist-tags']?.[definition.distTag]
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`@deepseek-ai/dsh publishes no ${JSON.stringify(definition.distTag)} dist-tag`)
  }
  const cohort = packuments[COHORT_PACKAGE]?.versions?.[version]
  const entries = []
  const offTrain = []
  const absent = []
  for (const name of packages) {
    const published = packuments[name]?.versions?.[version]
    if (published === undefined) {
      const range = cohort?.dependencies?.[name] ?? cohort?.peerDependencies?.[name]
        ?? cohort?.optionalDependencies?.[name]
      if (range === undefined) {
        absent.push(name)
        continue
      }
      const resolved = highestSatisfying(packuments[name], range)
      if (resolved === undefined) {
        throw new Error(`${name} publishes no version satisfying the ${definition.distTag} release range ${JSON.stringify(range)}`)
      }
      const integrity = packuments[name].versions[resolved]?.dist?.integrity
      if (typeof integrity !== 'string' || integrity.length === 0) {
        throw new Error(`${name}@${resolved} publishes no tarball integrity`)
      }
      offTrain.push([name, { version: resolved, integrity }])
      continue
    }
    const integrity = published.dist?.integrity
    if (typeof integrity !== 'string' || integrity.length === 0) {
      throw new Error(`${name}@${version} publishes no tarball integrity`)
    }
    entries.push([name, { version, integrity }])
  }
  if (!entries.some(([name]) => name === COHORT_PACKAGE)) {
    throw new Error(`the ${definition.distTag} channel does not resolve ${COHORT_PACKAGE}@${version}`)
  }
  return {
    channel: definition.channel,
    distTag: definition.distTag,
    blocks: definition.blocks,
    version,
    packages: sortedObject(entries),
    offTrain: sortedObject(offTrain),
    absent: [...absent].sort(),
  }
}

/**
 * Validate a stored manifest without touching the network.
 * @param {object} manifest - parsed manifest document.
 * @param {string[]} packages - probe package names that must be covered.
 * @returns {Map<string, object>} channel name to record.
 */
export function validateManifest(manifest, packages) {
  if (manifest?.schema !== SCHEMA) throw new Error(`${MANIFEST_PATH} must declare schema ${SCHEMA}`)
  const channels = new Map()
  for (const definition of CHANNELS) {
    const record = manifest.channels?.[definition.channel]
    if (record === undefined) throw new Error(`${MANIFEST_PATH} does not record channel ${definition.channel}`)
    if (record.channel !== definition.channel || record.distTag !== definition.distTag || record.blocks !== definition.blocks) {
      throw new Error(`${MANIFEST_PATH} channel ${definition.channel} does not match its declared dist-tag or blocking role`)
    }
    const pinned = Object.keys(record.packages ?? {})
    const offTrain = Object.keys(record.offTrain ?? {})
    const absent = record.absent ?? []
    if (pinned.length + offTrain.length + absent.length !== packages.length
      || packages.some(name => !pinned.includes(name)
        && !offTrain.includes(name) && !absent.includes(name))) {
      throw new Error(`${MANIFEST_PATH} channel ${definition.channel} does not account for every probed host package`)
    }
    if (!pinned.includes(COHORT_PACKAGE)) {
      throw new Error(`${MANIFEST_PATH} channel ${definition.channel} does not pin ${COHORT_PACKAGE}`)
    }
    for (const name of pinned) {
      const entry = record.packages[name]
      if (entry.version !== record.version) {
        throw new Error(`${MANIFEST_PATH} channel ${definition.channel} pins ${name} outside its release ${record.version}`)
      }
      if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
        throw new Error(`${MANIFEST_PATH} channel ${definition.channel} records no integrity for ${name}`)
      }
    }
    // A package the release does not publish is pinned at the version its own
    // dependency range resolves to, so the channel still names the bytes an install
    // receives rather than only naming the package.
    for (const name of offTrain) {
      const entry = record.offTrain[name]
      if (typeof entry?.version !== 'string' || entry.version.length === 0) {
        throw new Error(`${MANIFEST_PATH} channel ${definition.channel} records no version for off-train ${name}`)
      }
      if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
        throw new Error(`${MANIFEST_PATH} channel ${definition.channel} records no integrity for off-train ${name}`)
      }
    }
    channels.set(definition.channel, record)
  }
  return channels
}

/** Deterministic serialization: one refresh with unchanged tags produces no diff. */
export function serializeManifest(channels) {
  return `${JSON.stringify({
    schema: SCHEMA,
    channels: sortedObject(CHANNELS.map(definition => [definition.channel, channels.get(definition.channel)])),
  }, null, 2)}\n`
}

/**
 * Resolve every channel from its dist-tag and write the manifest.
 *
 * The manifest is supply: which host release each channel resolves to. What the
 * development checkout has installed is a separate layer, so moving the root
 * lock onto the `next` release is its own command ({@link refreshDevelopmentGraph}).
 * @param {object} options - repository root, registry reader and network seams.
 * @returns {Promise<string>} the generated document.
 */
export async function updateManifest(options = {}) {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const registry = options.registry ?? await officialRegistry()
  const fetchOne = options.fetchPackument ?? (name => fetchPackument(registry, name))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const packages = probePackages(manifest)
  const packuments = Object.fromEntries(await Promise.all(
    packages.map(async name => [name, await fetchOne(name)]),
  ))
  const channels = new Map(CHANNELS.map(definition => [
    definition.channel, resolveChannel(packuments, definition, packages),
  ]))
  const document = serializeManifest(channels)
  validateManifest(JSON.parse(document), packages)
  await writeFile(join(root, MANIFEST_PATH), document)
  return document
}

/**
 * Move the root development lock onto the `next` channel release when it lags.
 *
 * The development graph is the materialized host the ordinary gates run against,
 * so leaving it behind while `next` moves would make local verification test a
 * host no channel resolves to. Only the scheduled channel workflow calls this:
 * ordinary verification never resolves a floating tag.
 * @param {object} options - repository root, npm seam and an already-read record.
 * @returns {Promise<string|undefined>} the version it moved to, or undefined when
 *   the development graph already matched.
 */
export async function refreshDevelopmentGraph(options = {}) {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const runNpm = options.runNpm ?? (args => {
    const command = npmCliCommand(args)
    // The development lock records official bytes too, so every resolving step
    // reads the official registry rather than a configured mirror.
    const result = spawnSync(command.executable, command.args, {
      cwd: root, stdio: 'inherit', env: { ...process.env, NPM_CONFIG_REGISTRY: OFFICIAL_REGISTRY },
    })
    // A process that never started has no exit status. Reporting that as an npm
    // failure hides the cause (on Windows a `.cmd` fallback cannot be spawned
    // without a shell), so the spawn error is stated instead.
    if (result.error !== undefined || result.status !== 0) throw spawnFailure(command.executable, command.args, result)
  })
  const record = options.record ?? (await readManifest(root)).channels.get('next')
  const manifestPath = join(root, 'package.json')
  const lockPath = join(root, 'package-lock.json')
  const manifestText = await readFile(manifestPath, 'utf8')
  const lockText = await readFile(lockPath, 'utf8')
  const manifest = JSON.parse(manifestText)
  const lock = JSON.parse(lockText)
  if (lock.packages?.['node_modules/@deepseek-ai/dsh']?.version === record.version) return undefined
  const specifications = Object.keys(manifest.devDependencies ?? {})
    .filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .map(name => `${name}@next`)
  // npm cannot atomically move a complete peer cohort away from an old lock, and
  // `--save-dev` rewrites the channel declarations to pinned ranges. Resolve the
  // transition, restore the declarations, then require an ordinary resolver pass
  // so the committed lock still declares the channel instead of one release.
  //
  // Every step below runs in the checkout, so a move that cannot finish restores the
  // two files it rewrote. A refresh that leaves a half-moved lock behind would make the
  // next command run against a graph npm refuses to resolve, and the failure would then
  // look like a defect of that command instead of this one.
  try {
    await runNpm(['install', '--package-lock-only', '--ignore-scripts', '--force', '--loglevel=error',
      '--save-dev', ...specifications])
    await writeFile(manifestPath, manifestText)
    await runNpm(['install', '--package-lock-only', '--ignore-scripts'])
    await runNpm(['ci', '--dry-run', '--ignore-scripts'])
    const restored = JSON.parse(await readFile(manifestPath, 'utf8'))
    const drifted = Object.entries(manifest.devDependencies ?? {})
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .filter(([name, spec]) => restored.devDependencies?.[name] !== spec)
    if (drifted.length > 0) {
      throw new Error(`refreshing the development graph rewrote its channel declarations: ${drifted.map(([name]) => name).join(', ')}`)
    }
    const moved = JSON.parse(await readFile(lockPath, 'utf8'))
    if (moved.packages?.['node_modules/@deepseek-ai/dsh']?.version !== record.version) {
      throw new Error(`the development graph did not move onto the next channel release ${record.version}`)
    }
  } catch (error) {
    await writeFile(manifestPath, manifestText)
    await writeFile(lockPath, lockText)
    throw error
  }
  return record.version
}

/** Read and validate the tracked manifest. */
export async function readManifest(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const packages = probePackages(manifest)
  const stored = JSON.parse(await readFile(join(root, MANIFEST_PATH), 'utf8'))
  return { packages, channels: validateManifest(stored, packages), document: stored }
}

/** Digest a manifest document, so an install can prove which channel set it used. */
export function manifestDigest(document) {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex')
}

/** Whether a package name is part of the host service cohort rather than the plugin's own dependencies. */
export function isHostServicePackageName(name) {
  return /^@deepseek-ai\/(?:dsh(?:-[^/]+)?|cordis(?:-[^/]+)?|schemastery)$/.test(name)
}

/**
 * Validate an installed host graph against its lock, including nested copies.
 * A consumer install decides its own cohort, so the lock it produced is the only
 * record of what was asked for; this proves the tree matches it.
 * @param {string} root - installation root containing `package.json` and `package-lock.json`.
 * @param {object} [lock] - parsed lock, read from the root when omitted.
 * @returns {Promise<object[]>} the verified entries.
 */
export async function verifyInstalledHostGraph(root, lock) {
  lock ??= JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const verified = []
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    const match = /(?:^|\/)node_modules\/(@[^/]+\/[^/]+)$/.exec(packagePath)
    if (!match || !isHostServicePackageName(match[1])) continue
    const installed = JSON.parse(await readFile(join(root, packagePath, 'package.json'), 'utf8'))
    if (installed.name !== match[1] || installed.version !== entry.version) {
      throw new Error(`installed Host ${packagePath} differs from its frozen lock; run npm ci`)
    }
    verified.push({ packagePath, name: installed.name, version: installed.version })
  }
  return verified
}

/**
 * Validate an installed channel graph against the manifest that selected it.
 *
 * The recorded integrity is the identity of the bytes that channel resolved to,
 * so it is compared with what npm actually installed rather than kept as a note.
 * An off-train package is recorded the same way: the channel install receives it
 * through the host release's own dependency range, so its bytes are proved too.
 * @param {string} root - installation root.
 * @param {object} record - the channel record that was installed.
 * @returns {Promise<object[]>} the verified entries.
 */
export async function verifyInstalledChannel(root, record) {
  const installed = JSON.parse(await readFile(join(root, 'node_modules', '.package-lock.json'), 'utf8'))
  const verified = []
  const recorded = [
    ...Object.entries(record.packages),
    ...Object.entries(record.offTrain ?? {}),
  ]
  for (const [name, entry] of recorded) {
    const manifest = JSON.parse(await readFile(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    if (manifest.name !== name || manifest.version !== entry.version) {
      throw new Error(`channel ${record.channel} installed ${name}@${manifest.version}, manifest records ${entry.version}`)
    }
    // npm records where each installed package came from; a recorded digest that
    // does not match means the pinned bytes are not what is on disk.
    const installedEntry = installed.packages?.[`node_modules/${name}`]
    if (installedEntry === undefined) {
      throw new Error(`channel ${record.channel} has no install record for ${name}`)
    }
    if (installedEntry.integrity !== entry.integrity) {
      throw new Error(`channel ${record.channel} installed ${name} with integrity ${String(installedEntry.integrity)}, manifest records ${entry.integrity}`)
    }
    verified.push({ name, version: entry.version })
  }
  // A package recorded as absent is a claim about the install too: the channel does
  // not receive it, so an install that contains one contradicts the record.
  for (const name of record.absent ?? []) {
    const installedEntry = installed.packages?.[`node_modules/${name}`]
    if (installedEntry !== undefined) {
      throw new Error(`channel ${record.channel} records ${name} as absent, but the install contains ${String(installedEntry.version)}`)
    }
  }
  return verified
}

async function main() {
  const command = process.argv[2]
  if (command === 'update') {
    const document = await updateManifest()
    const channels = JSON.parse(document).channels
    console.log(`host channels refreshed from their dist-tags: ${Object.values(channels)
      .map(record => `${record.channel}=${record.version}`).join(', ')}`)
    return
  }
  if (command === 'graph') {
    const moved = await refreshDevelopmentGraph()
    console.log(moved === undefined
      ? 'the development graph already matches the next channel'
      : `the development graph moved onto the next channel release ${moved}`)
    return
  }
  if (command !== 'verify') throw new Error('usage: host-channel-manifest.mjs <update|graph|verify>')
  const { channels } = await readManifest()
  console.log(`host channels verified offline: ${[...channels.values()]
    .map(record => `${record.channel}=${record.version}${record.blocks ? '' : ' (reports only)'}`).join(', ')}`)
  console.log(`development graph: ${await describeDevelopmentGraph(channels)}`)
}

/**
 * State which channel the development lock materializes. A graph no channel
 * resolves to is a materialization fact, not a manifest error, so it is reported
 * rather than rejected: only `host:channels:graph` can move it.
 */
export async function describeDevelopmentGraph(channels, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const version = lock.packages?.['node_modules/@deepseek-ai/dsh']?.version
  const matched = [...channels.values()].find(record => record.version === version)
  const installed = await installedHostVersion(root)
  if (installed !== version) {
    throw new Error(`installed @deepseek-ai/dsh@${String(installed)} differs from package-lock.json (${String(version)}); run npm ci`)
  }
  const materialization = 'materialized as locked'
  const channel = matched === undefined
    ? 'no channel resolves to this release; host:channels:graph moves it onto next'
    : `the ${matched.channel} channel`
  return `@deepseek-ai/dsh@${String(version)} (${channel}; ${materialization})`
}

async function installedHostVersion(root) {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return manifest.version
  } catch {
    // Nothing is installed; that is reported as a mismatch, not as a load error.
    return undefined
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`host-channels: ${error.message}`)
    process.exitCode = 1
  })
}
