import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import { parse as parseJavaScript } from '@babel/parser'
import { isHostServicePackageName, manifestDigest, probePackages, readManifest, refreshDevelopmentGraph, resolveChannel, satisfiesRange, serializeManifest, validateManifest, verifyInstalledChannel, verifyInstalledHostGraph, describeDevelopmentGraph } from '../scripts/host-channel-manifest.mjs'

const DSH_RUNTIME_PEERS = [
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
]

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_BUILTINS = new Set(builtinModules)
const MODULE_SOURCE = /\.(?:js|mjs|cjs)$/
// esbuild bundles whose bare specifiers resolve through the DSH client module
// loader (client.cjs) or the compiler platform contract (compiler-*.cjs);
// the bundle build check owns their contents. Every other shipped module is
// parsed so its specifiers resolve through the package dependency graph.
const HOST_RESOLVED_BUNDLES = new Set([
  'client.cjs', 'compiler-core.cjs', 'compiler-platform.cjs',
  'compiler-typescript.cjs', 'compiler-amaro.cjs',
])

/** Visit every AST node without assuming a specific production grammar. */
function eachNode(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) eachNode(item, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const value of Object.values(node)) eachNode(value, visit)
}

/**
 * Literal references a shipped runtime module resolves: relative specifiers are
 * local modules, bare specifiers resolve through the package dependency graph.
 * Bundles expose local references only here; their internal specifiers belong
 * to the compiler platform contract and the bundle build check.
 */
function runtimeReferences(source, { bundle = false } = {}) {
  const local = new Set()
  const bare = new Set()
  const record = specifier => {
    if (specifier.startsWith('.')) local.add(specifier.split(/[?#]/, 1)[0])
    else if (!specifier.startsWith('node:') && !NODE_BUILTINS.has(specifier)
      && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) bare.add(specifier)
  }
  if (bundle) {
    for (const match of source.matchAll(/(?:require|import)\s*\(\s*['"](\.[^'"]+)['"]/g)) record(match[1])
    return { local, bare }
  }
  const importMetaUrl = node => node?.type === 'MemberExpression'
    && node.object?.type === 'MetaProperty' && node.property?.name === 'url'
  eachNode(parseJavaScript(source, { sourceType: 'module' }).program, node => {
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration') && node.source?.type === 'StringLiteral') record(node.source.value)
    else if (node.type === 'ImportExpression' && node.source?.type === 'StringLiteral') record(node.source.value)
    else if (node.type === 'CallExpression' && node.arguments?.[0]?.type === 'StringLiteral') {
      const callee = node.callee
      if (callee?.type === 'Import' || callee?.name === 'import' || callee?.name === 'require') {
        record(node.arguments[0].value)
      } else if (callee?.type === 'MemberExpression' && callee.object?.name === 'require'
        && callee.property?.name === 'resolve') {
        record(node.arguments[0].value)
      }
    } else if (node.type === 'NewExpression' && (node.callee?.name === 'URL' || node.callee?.name === 'NativeURL')
      && node.arguments?.[0]?.type === 'StringLiteral' && importMetaUrl(node.arguments?.[1])) {
      record(node.arguments[0].value)
    }
  })
  return { local, bare }
}

/** Every tracked or untracked non-ignored file: the set npm packlist selects from. */
async function workingTreePaths() {
  const listed = spawnSync('git', ['-C', PACKAGE_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(listed.status, 0, listed.error ? listed.error.message : listed.stderr)
  return listed.stdout.split('\0').filter(Boolean)
}

/** Follow every module the packaged entries load from the working tree. */
async function runtimeModuleGraph() {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const entries = [manifest.main, ...Object.values(manifest.exports ?? {})]
    .filter(value => typeof value === 'string' && !value.includes('*') && MODULE_SOURCE.test(value))
    .map(value => value.replace(/^\.\//, ''))
  const present = new Set(await workingTreePaths())
  const graph = new Map()
  const queue = [...new Set(entries)]
  while (queue.length > 0) {
    const path = queue.pop()
    if (graph.has(path)) continue
    assert.ok(present.has(path), `packed entry is outside the working tree: ${path}`)
    const references = runtimeReferences(await readFile(join(PACKAGE_ROOT, path), 'utf8'),
      { bundle: HOST_RESOLVED_BUNDLES.has(path) })
    const targets = []
    for (const reference of references.local) {
      const target = posix.normalize(posix.join(posix.dirname(path), reference))
      assert.ok(!target.startsWith('..'), `${path} resolves outside the package root: ${reference}`)
      assert.ok(present.has(target), `${path} loads a file the working tree does not contain: ${target}`)
      targets.push(target)
    }
    graph.set(path, { targets, bare: references.bare })
    // Non-JavaScript targets stay surface evidence; only modules are parsed.
    queue.push(...targets.filter(target => MODULE_SOURCE.test(target)))
  }
  return graph
}

/** Match one npm files selector: literal paths, directories, and segment globs. */
function packageFileSelector(selector) {
  const pattern = selector.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
  return new RegExp(`^${pattern}$`)
}

// macOS CI can hand the process a TMPDIR whose directory does not exist yet,
// which makes mkdtemp fail with ENOENT. Create the root once, then retry.
async function mkdtempUnderTmp(prefix) {
  const root = tmpdir()
  try {
    return await mkdtemp(join(root, prefix))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(root, { recursive: true })
    return mkdtemp(join(root, prefix))
  }
}
test('execution smoke rejects a plugin that never installs the entry and accepts the real plugin', async t => {
  const directory = await mkdtempUnderTmp('ptc-seam-smoke-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const smoke = fileURLToPath(new URL('../scripts/dsh-execution-seam-smoke.mjs', import.meta.url))
  const run = plugin => spawnSync(process.execPath, [smoke, plugin], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
  })
  const fake = join(directory, 'fake.mjs')
  // Both variants mutate a shallow copy of the provider, so neither installs the
  // public execution entry. That is the fact this case proves; the capability
  // contract itself (sandboxMode/timeout/instructions withheld) is asserted by the
  // smoke's own run against the real plugin below and by execution-seam-compat.
  for (const mutation of ['', 'runtime.run = null']) {
    await writeFile(fake, `export function apply(ctx) {
      const runtime = { ...(ctx.get('ptcRuntime') ?? ctx.get('codeRuntime')) }
      delete runtime.executionInstructions
      delete runtime.sandboxMode
      delete runtime.timeout
      ${mutation}
    }`)
    const result = run(fake)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /did not install the public execution entry/)
  }
  const result = run(fileURLToPath(new URL('../index.js', import.meta.url)))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /official profile Include bundle\/provider execution installed; frozen original preserved/)
  assert.match(result.stdout, /session run_code\/edit_run_code continuous state proved/)
})

test('keeps host-owned DSH service packages out of plugin dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const packageName of DSH_RUNTIME_PEERS) {
    assert.equal(manifest.dependencies?.[packageName], undefined)
    assert.equal(manifest.peerDependencies?.[packageName], '*')
    assert.equal(manifest.devDependencies?.[packageName], 'next')
  }
})

test('declares directly imported DSH utility packages for clean installs', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const packageName = '@deepseek-ai/dsh-util-values'

  assert.equal(manifest.dependencies?.[packageName], '^0.2.0-rc.2 || ^0.2.1-alpha.1')
  assert.equal(lock.packages[''].dependencies[packageName], manifest.dependencies[packageName])
  assert.equal(lock.packages[`node_modules/${packageName}`].dev, undefined)
})

test('packed production imports declare Host peers and runtime dependencies instead of depending on incidental hoisting', async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package-lock.json'), 'utf8'))
  const imports = new Map()
  for (const [path, { bare }] of await runtimeModuleGraph()) {
    for (const specifier of bare) {
      const packageName = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
      if (!imports.has(packageName)) imports.set(packageName, new Set())
      imports.get(packageName).add(`${path} imports ${specifier}`)
    }
  }
  for (const [packageName, sources] of imports) {
    assert.ok(manifest.dependencies?.[packageName] || manifest.peerDependencies?.[packageName],
      `${[...sources][0]}, which is not declared in dependencies or peerDependencies`)
    const role = manifest.dependencies?.[packageName] ? 'dependencies' : 'peerDependencies'
    assert.equal(lock.packages[''][role]?.[packageName], manifest[role][packageName])
  }
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(imports.has(packageName),
      `dependencies.${packageName} is not imported by any packed runtime module; build-only packages belong in devDependencies`)
  }
})

test('packed surface ships every artifact the runtime loads', async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    assert.equal(typeof value, 'string', `exports.${key} must be a literal path string for surface auditing`)
  }
  const tree = await workingTreePaths()
  const present = new Set(tree)
  const shipped = new Set()
  for (const selector of manifest.files ?? []) {
    const normalized = selector.replace(/^\.\//, '').replace(/\/+$/, '')
    const matched = normalized.includes('*')
      ? tree.filter(path => packageFileSelector(normalized).test(path))
      : present.has(normalized)
        ? [normalized]
        : tree.filter(path => path.startsWith(`${normalized}/`))
    assert.ok(matched.length > 0, `manifest files entry matches no working-tree file: ${selector}`)
    for (const path of matched) shipped.add(path)
  }
  // npm always includes the manifest and root notices even when files omits them.
  for (const path of tree) {
    if (path === 'package.json' || /^(?:README|LICEN[CS]E|COPYING)(?:\.[^/]*)?$/i.test(path)) shipped.add(path)
  }
  const declared = [manifest.main, manifest.icon, manifest.dsh?.bundle?.patch, ...Object.values(manifest.exports ?? {})]
    .filter(value => typeof value === 'string')
    .map(value => value.replace(/^\.\//, ''))
  for (const target of new Set(declared)) {
    const matched = target.includes('*')
      ? [...shipped].some(path => packageFileSelector(target).test(path))
      : shipped.has(target)
    assert.ok(matched, `declared runtime artifact is not shipped: ${target}`)
  }
  for (const [path, { targets }] of await runtimeModuleGraph()) {
    for (const target of targets) {
      assert.ok(shipped.has(target), `${path} loads ${target}, which the packaged files list omits`)
    }
  }
  const assets = JSON.parse(await readFile(join(PACKAGE_ROOT, 'compiler-assets.json'), 'utf8'))
  for (const [name, file] of Object.entries(assets)) {
    assert.ok(shipped.has(file), `compiler asset ${name} is not shipped: ${file}`)
  }
})

test('reused frozen Host rejects installed service drift despite unchanged lock inputs', async t => {
  const root = await mkdtempUnderTmp('ptc-installed-host-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = { 'node_modules/@deepseek-ai/dsh': { version: '8.0.0' },
    'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools': { version: '8.0.0' } }
  for (const path of Object.keys(packages)) {
    await mkdir(join(root, path), { recursive: true })
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ name: path.slice(path.lastIndexOf('@deepseek-ai/')), version: '8.0.0' }))
  }
  await verifyInstalledHostGraph(root, { packages })
  for (const path of Object.keys(packages)) {
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ name: path.slice(path.lastIndexOf('@deepseek-ai/')), version: '0.0.0-stale' }))
    await assert.rejects(() => verifyInstalledHostGraph(root, { packages }), /installed Host .* differs from its frozen lock/)
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ name: path.slice(path.lastIndexOf('@deepseek-ai/')), version: '8.0.0' }))
  }
})

test('generates one channel manifest from dist-tags and installs it on demand', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const generated = JSON.parse(await readFile(new URL('../compat/channels.json', import.meta.url), 'utf8'))
  const hostSuite = await readFile(new URL('../scripts/dsh-host-contract-suite.mjs', import.meta.url), 'utf8')

  // The development graph declares the in-flight release-candidate channel; the
  // graph it actually materializes is a separate layer that host:channels:graph
  // moves, and ordinary gates only ever read the lock they find.
  const dshDevelopmentPackages = Object.entries(manifest.devDependencies)
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(dshDevelopmentPackages.some(([name]) => name === '@deepseek-ai/dsh'))
  assert.ok(dshDevelopmentPackages.every(([, version]) => version === 'next'))
  assert.ok(dshDevelopmentPackages.every(([name]) => lock.packages[''].devDependencies[name] === 'next'))
  const nextVersion = lock.packages['node_modules/@deepseek-ai/dsh'].version
  assert.ok(dshDevelopmentPackages.every(([name]) => lock.packages[`node_modules/${name}`].version === nextVersion))

  // The tracked manifest is the only record of the channels, so it must cover
  // every probed host package and state which channel may block a release.
  const packages = probePackages(manifest)
  const stored = validateManifest(generated, packages)
  assert.deepEqual([...stored.keys()], ['latest', 'next', 'alpha'])
  assert.deepEqual([...stored.values()].filter(record => record.blocks).map(record => record.channel), ['latest', 'next'])
  assert.deepEqual(JSON.parse(await readFile(new URL('../compat/channels.json', import.meta.url), 'utf8')),
    JSON.parse(serializeManifest(stored)))

  // Refreshing is one command: the suite installs the resolved version on demand
  // and never rewrites a lock to change channels.
  assert.match(hostSuite, /readManifest\(ROOT\)/)
  assert.match(hostSuite, /installChannelHost\(record\)/)
  assert.doesNotMatch(hostSuite, /package-lock\.json/)
  assert.match(hostSuite, /run\('tar', \['-xzf'/)
  assert.match(hostSuite, /exposePluginDependencies\(consumer\)/)
})

test('the declared range a channel install resolves is read the way npm reads it', () => {
  const cases = [
    ['4.0.5', '~4.0.5', true],
    ['4.1.0', '~4.0.5', false],
    ['4.0.4', '~4.0.5', false],
    ['4.0.5', '4.0.5', true],
    ['4.0.5', '=4.0.5', true],
    ['4.0.5', '4.0.6', false],
    ['4.0.6', '>4.0.5', true],
    ['4.0.5', '>4.0.5', false],
    ['4.0.5', '<=4.0.5', true],
    ['4.0.4', '<4.0.5', true],
    ['4.5.0', '^4.0.5', true],
    ['4.0.4', '^4.0.5', false],
    ['0.2.1', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['0.0.2', '^0.0.2', true],
    ['0.0.3', '^0.0.2', false],
    ['3.0.0', '*', true],
    ['3.0.0', 'x', true],
    ['3.0.0', '>=2.0.0 <4.0.0', true],
    ['4.0.0', '>=2.0.0 <4.0.0', false],
    ['2.5.0', '^3.0.0 || ^2.0.0', true],
    // A prerelease only joins a range that names a prerelease of the same release.
    ['4.0.6-alpha.1', '~4.0.5', false],
    ['4.0.6-alpha.2', '~4.0.6-alpha.1', true],
    ['4.0.6-beta.1', '~4.0.6-alpha.1', true],
    ['4.0.6', '~4.0.6-alpha.1', true],
    ['4.1.0-alpha.1', '~4.0.6-alpha.1', false],
    ['4.0.6-alpha', '~4.0.6-alpha.1', false],
    ['4.0.6-alpha.1', '~4.0.6-alpha', true],
    ['4.0.6-2', '~4.0.6-alpha', false],
  ]
  for (const [version, range, expected] of cases) {
    assert.equal(satisfiesRange(version, range), expected, `${version} against ${range}`)
  }
  // A range this file cannot read must not silently pin the wrong bytes.
  assert.throws(() => satisfiesRange('4.0.5', '^4'), /not a semantic version/)
  assert.throws(() => satisfiesRange('not-a-version', '*'), /not a semantic version/)
})

test('resolves each channel from its own dist-tag and pins the off-train packages it installs', () => {
  const packages = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tools', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-tool-executor-ptc']
  const packument = (tags, versions, extra = () => ({})) => ({ 'dist-tags': tags, versions: Object.fromEntries(
    versions.map(version => [version, { version, dist: { integrity: `sha512-${version}` }, ...extra(version) }]),
  ) })
  const packuments = {
    // The release declares the cordis range an install of this channel resolves.
    '@deepseek-ai/dsh': packument({ latest: '7.0.0', next: '8.0.0-beta.3', alpha: '9.0.0-alpha.1' },
      ['7.0.0', '8.0.0-beta.3', '9.0.0-alpha.1'],
      () => ({ dependencies: { '@deepseek-ai/cordis': '~4.0.5' } })),
    // A package whose own dist-tags lag the release train joins at the release version.
    '@deepseek-ai/dsh-tools': packument({ latest: '0.0.1-rc.1', next: '0.0.1-rc.1' }, ['0.0.1-rc.1', '8.0.0-beta.3']),
    // A package outside the release train is pinned at the version that range resolves to.
    '@deepseek-ai/cordis': packument({ latest: '4.0.6-alpha.2', next: '4.0.6-alpha.2' },
      ['4.0.5', '4.0.6-alpha.1', '4.0.6-alpha.2']),
    // A package the release neither publishes nor depends on is not part of an install.
    '@deepseek-ai/dsh-tool-executor-ptc': packument({ latest: '9.0.0-alpha.1' }, ['9.0.0-alpha.1']),
  }
  const alpha = resolveChannel(packuments, { channel: 'alpha', distTag: 'alpha', blocks: false }, packages)
  assert.deepEqual(alpha, {
    channel: 'alpha', distTag: 'alpha', blocks: false, version: '9.0.0-alpha.1',
    packages: {
      '@deepseek-ai/dsh': { version: '9.0.0-alpha.1', integrity: 'sha512-9.0.0-alpha.1' },
      '@deepseek-ai/dsh-tool-executor-ptc': { version: '9.0.0-alpha.1', integrity: 'sha512-9.0.0-alpha.1' },
    },
    offTrain: { '@deepseek-ai/cordis': { version: '4.0.5', integrity: 'sha512-4.0.5' } },
    absent: ['@deepseek-ai/dsh-tools'],
  })
  const next = resolveChannel(packuments, { channel: 'next', distTag: 'next', blocks: true }, packages)
  assert.deepEqual(Object.keys(next.packages), ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tools'])
  assert.deepEqual(next.offTrain, { '@deepseek-ai/cordis': { version: '4.0.5', integrity: 'sha512-4.0.5' } })
  assert.deepEqual(next.absent, ['@deepseek-ai/dsh-tool-executor-ptc'])
  assert.throws(() => resolveChannel(packuments, { channel: 'beta', distTag: 'beta', blocks: true }, packages),
    /publishes no "beta" dist-tag/)
  assert.throws(() => resolveChannel({ ...packuments,
    '@deepseek-ai/dsh': packument({}, []) }, { channel: 'latest', distTag: 'latest', blocks: true }, packages),
  /publishes no "latest" dist-tag/)
  // An off-train range no published version satisfies is a supply defect, not a pin.
  assert.throws(() => resolveChannel({ ...packuments,
    '@deepseek-ai/cordis': packument({}, ['3.9.0']) },
  { channel: 'latest', distTag: 'latest', blocks: true }, packages),
  /no version satisfying the latest release range "~4\.0\.5"/)
})

test('refresh is idempotent and rejects a manifest that drops a probed package', () => {
  const definition = { channel: 'latest', distTag: 'latest', blocks: true }
  const packages = ['@deepseek-ai/dsh', '@deepseek-ai/cordis']
  const packuments = {
    '@deepseek-ai/dsh': { 'dist-tags': { latest: '7.0.0' },
      versions: { '7.0.0': { dist: { integrity: 'sha512-dsh' },
        dependencies: { '@deepseek-ai/cordis': '~4.0.5' } } } },
    '@deepseek-ai/cordis': { 'dist-tags': { latest: '4.0.5' },
      versions: { '4.0.5': { version: '4.0.5', dist: { integrity: 'sha512-cordis' } } } },
  }
  const record = resolveChannel(packuments, definition, packages)
  const document = serializeManifest(new Map([
    ['latest', record],
    ['next', { ...record, channel: 'next', distTag: 'next', blocks: true }],
    ['alpha', { ...record, channel: 'alpha', distTag: 'alpha', blocks: false }],
  ]))
  assert.equal(document, serializeManifest(new Map([
    ['alpha', { ...record, channel: 'alpha', distTag: 'alpha', blocks: false }],
    ['next', { ...record, channel: 'next', distTag: 'next', blocks: true }],
    ['latest', record],
  ])), 'channel order must not depend on insertion order')
  const stored = validateManifest(JSON.parse(document), packages)
  assert.equal(manifestDigest(JSON.parse(document)), manifestDigest(JSON.parse(serializeManifest(stored))))
  assert.throws(() => validateManifest({ schema: 'dsh-host-channels/v1', channels: {
    ...JSON.parse(document).channels,
    latest: { ...record, offTrain: [] },
  } }, packages), /does not account for every probed host package/)
  assert.throws(() => validateManifest({ schema: 'dsh-host-channels/v1', channels: {
    ...JSON.parse(document).channels,
    latest: { ...record, blocks: false },
  } }, packages), /does not match its declared dist-tag or blocking role/)
  // An off-train pin is a record of the bytes an install receives, so it must carry
  // both halves.
  for (const [mutate, message] of [
    [entry => ({ ...entry, version: '' }), /records no version for off-train @deepseek-ai\/cordis/],
    [entry => ({ ...entry, integrity: '' }), /records no integrity for off-train @deepseek-ai\/cordis/],
  ]) {
    const stored = structuredClone(record)
    stored.offTrain['@deepseek-ai/cordis'] = mutate(stored.offTrain['@deepseek-ai/cordis'])
    assert.throws(() => validateManifest({ schema: 'dsh-host-channels/v1', channels: {
      ...JSON.parse(document).channels,
      latest: stored,
    } }, packages), message)
  }
  assert.throws(() => validateManifest({ schema: 'dsh-other/v1', channels: {} }, packages), /must declare schema/)
})

test('the development graph refresh keeps the channel declarations it started from', async t => {
  const root = await mkdtempUnderTmp('ptc-development-graph-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const channel = { channel: 'next', version: '9.0.0', packages: {}, offTrain: [] }
  const manifest = { devDependencies: { '@deepseek-ai/dsh': 'next', '@deepseek-ai/dsh-tools': 'next' } }
  const lock = { packages: { 'node_modules/@deepseek-ai/dsh': { version: '8.0.0' } } }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
  const steps = []
  // npm's --save-dev rewrites the declarations to pinned ranges; the refresh must
  // restore them before it commits the lock.
  const runNpm = async args => {
    await mkdir(root, { recursive: true })
    steps.push(args.slice(0, 2).join(' '))
    if (args.includes('--save-dev')) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: {
        '@deepseek-ai/dsh': '^9.0.0', '@deepseek-ai/dsh-tools': '^9.0.0',
      } }, null, 2) + '\n')
      return
    }
    if (args[0] === 'install') {
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
        'node_modules/@deepseek-ai/dsh': { version: '9.0.0' },
      } }, null, 2) + '\n')
    }
  }
  assert.equal(await refreshDevelopmentGraph({ root, record: channel, runNpm }), '9.0.0')
  assert.deepEqual(steps, ['install --package-lock-only', 'install --package-lock-only', 'ci --dry-run'])
  assert.deepEqual(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), manifest,
    'the channel declarations must survive the refresh')

  // A development graph that is already current is not touched at all.
  const untouched = []
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/@deepseek-ai/dsh': { version: '9.0.0' },
  } }, null, 2) + '\n')
  assert.equal(await refreshDevelopmentGraph({ root, record: channel, runNpm: args => untouched.push(args) }), undefined)
  assert.deepEqual(untouched, [])
})

test('an installed channel is proven against the manifest that selected it', async t => {
  const root = await mkdtempUnderTmp('ptc-channel-install-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = { channel: 'latest', version: '7.0.0',
    packages: { '@deepseek-ai/dsh': { version: '7.0.0', integrity: 'sha512-7.0.0' } },
    offTrain: { '@deepseek-ai/cordis': { version: '4.0.5', integrity: 'sha512-4.0.5' } },
    absent: [] }
  const install = async version => {
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  }
  const integrity = 'sha512-7.0.0'
  const writeInstallRecord = async (value, cordis = { version: '4.0.5', integrity: 'sha512-4.0.5' }) => writeFile(
    join(root, 'node_modules', '.package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: {
      'node_modules/@deepseek-ai/dsh': { version: '7.0.0', integrity: value },
      'node_modules/@deepseek-ai/cordis': cordis,
    } }),
  )
  const installCordis = async version => {
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
    await writeFile(join(root, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/cordis', version }))
  }
  await install('7.0.0')
  await installCordis('4.0.5')
  await writeInstallRecord(integrity)
  assert.deepEqual(await verifyInstalledChannel(root, record), [
    { name: '@deepseek-ai/dsh', version: '7.0.0' },
    { name: '@deepseek-ai/cordis', version: '4.0.5' },
  ])
  // The recorded digest is the identity of the pinned bytes, not a note.
  await writeInstallRecord('sha512-someone-elses-tarball')
  await assert.rejects(() => verifyInstalledChannel(root, record), /manifest records sha512-7\.0\.0/)
  await writeInstallRecord(integrity)
  await install('0.0.0-stale')
  await assert.rejects(() => verifyInstalledChannel(root, record), /installed @deepseek-ai\/dsh@0\.0\.0-stale/)
  await install('7.0.0')
  // An off-train package is proved the same way: the host range resolves it, so a
  // publish inside that range changes the bytes an install receives.
  await installCordis('4.0.6')
  await assert.rejects(() => verifyInstalledChannel(root, record),
    /installed @deepseek-ai\/cordis@4\.0\.6, manifest records 4\.0\.5/)
  await installCordis('4.0.5')
  await writeInstallRecord(integrity, { version: '4.0.5', integrity: 'sha512-other-cordis' })
  await assert.rejects(() => verifyInstalledChannel(root, record),
    /installed @deepseek-ai\/cordis with integrity sha512-other-cordis, manifest records sha512-4\.0\.5/)
  // A package recorded as absent is a claim about the install too: the channel does
  // not receive it, and only the installed graph can prove that.
  await writeInstallRecord(integrity)
  const absentRecord = { ...record, absent: ['@deepseek-ai/dsh-tool-executor-ptc'] }
  assert.equal((await verifyInstalledChannel(root, absentRecord)).length, 2)
  await writeInstallRecord(integrity, { version: '4.0.5', integrity: 'sha512-4.0.5' })
  await writeFile(join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/@deepseek-ai/dsh': { version: '7.0.0', integrity },
    'node_modules/@deepseek-ai/cordis': { version: '4.0.5', integrity: 'sha512-4.0.5' },
    'node_modules/@deepseek-ai/dsh-tool-executor-ptc': { version: '0.2.1-rc.2', integrity: 'sha512-executor' },
  } }))
  await assert.rejects(() => verifyInstalledChannel(root, absentRecord),
    /records @deepseek-ai\/dsh-tool-executor-ptc as absent, but the install contains 0\.2\.1-rc\.2/)
  await writeInstallRecord(integrity)
})

test('a channel record labelled with another channel is rejected', async () => {
  // The record carries its own channel name because an installed graph is described
  // by the record, not by the key it was stored under. A document whose key says one
  // channel and whose record says another describes two supplies, and reading only
  // the key would install the bytes of one while reporting the other.
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const packages = probePackages(manifest)
  const tracked = JSON.parse(await readFile(new URL('../compat/channels.json', import.meta.url), 'utf8'))
  assert.deepEqual([...validateManifest(tracked, packages).keys()], ['latest', 'next', 'alpha'])
  for (const channel of ['latest', 'next', 'alpha']) {
    const mislabelled = structuredClone(tracked)
    mislabelled.channels[channel].channel = channel === 'next' ? 'latest' : 'next'
    assert.throws(() => validateManifest(mislabelled, packages),
      new RegExp(`channel ${channel} does not match its declared dist-tag or blocking role`, 'u'), channel)
  }
  // The label is compared with the key, so relabelling every record consistently is
  // still a document that answers for another channel.
  const relabelled = structuredClone(tracked)
  relabelled.channels.alpha.channel = 'alpha'
  relabelled.channels.alpha.distTag = 'next'
  assert.throws(() => validateManifest(relabelled, packages),
    /channel alpha does not match its declared dist-tag or blocking role/u)
})

test('a development install that differs from its lock is refused', async t => {
  const root = await mkdtempUnderTmp('ptc-development-describe-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const channels = new Map([['next', { channel: 'next', version: '9.0.0' }]])
  const lock = async version => writeFile(join(root, 'package-lock.json'),
    JSON.stringify({ packages: { 'node_modules/@deepseek-ai/dsh': { version } } }, null, 2) + '\n')
  const install = async version => {
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  }
  await lock('9.0.0')
  await install('9.0.0')
  assert.equal(await describeDevelopmentGraph(channels, root),
    '@deepseek-ai/dsh@9.0.0 (the next channel; materialized as locked)')
  // A release no channel resolves to is a materialization fact the graph reports
  // rather than a manifest error, so the same version on both sides still describes.
  await lock('9.5.0')
  await install('9.5.0')
  assert.equal(await describeDevelopmentGraph(channels, root),
    '@deepseek-ai/dsh@9.5.0 (no channel resolves to this release; host:channels:graph moves it onto next; materialized as locked)')
  // An install that disagrees with the lock is not the graph the lock describes, and
  // no channel claim derived from that lock is true of the host the gates run on.
  await install('8.0.0')
  await assert.rejects(() => describeDevelopmentGraph(channels, root),
    /installed @deepseek-ai\/dsh@8\.0\.0 differs from package-lock\.json \(9\.5\.0\); run npm ci/u)
})

test('keeps npm release authority stage-only and bound to a verified tag', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const refresh = parse(await readFile(new URL('../.github/workflows/dsh-baseline-refresh.yml', import.meta.url), 'utf8'))
  const release = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))

  assert.deepEqual(manifest.allowScripts, { esbuild: false })
  assert.deepEqual(ci.on.push.branches, ['main'])
  assert.equal(ci.on.push.tags, undefined)
  assert.equal(ci.on.workflow_dispatch, null)
  assert.deepEqual(release.on.workflow_dispatch, {})
  assert.deepEqual(release.permissions, { actions: 'read', contents: 'read' })
  assert.equal(
    release.jobs['validate-target'].steps[0].with.ref,
    '${{ github.sha }}',
  )
  assert.equal(
    release.jobs.stage.steps[0].with.ref,
    '${{ needs.validate-target.outputs.release-sha }}',
  )
  assert.equal(release.jobs.stage.environment, 'npm-release')
  assert.deepEqual(release.jobs.stage.permissions, {
    contents: 'read',
    'id-token': 'write',
  })

  const verifyStep = ci.jobs.check.steps.find(step => step.name === 'Verify portable runtime contracts')
  assert.equal(verifyStep.run, 'npm run verify:ci')
  assert.equal(verifyStep.if, undefined)
  // The five-platform matrix carries no host-channel work of its own: channels
  // are one job each, so an alpha report cannot hide behind a platform row.
  assert.equal(ci.jobs.check.strategy.matrix.include.length, 5)
  assert.deepEqual(ci.jobs.check.strategy.matrix.include.map(entry => [entry.os, entry.node]), [
    ['ubuntu-latest', '22.19.0'], ['ubuntu-latest', 24], ['ubuntu-latest', 26],
    ['windows-latest', 24], ['macos-latest', 24],
  ])
  assert.ok(ci.jobs.check.strategy.matrix.include.every(entry => Object.keys(entry).length === 2))
  assert.deepEqual(ci.jobs['host-contracts'].strategy.matrix.channel, ['latest', 'next', 'alpha'])
  assert.equal(ci.jobs['host-contracts']['continue-on-error'], "${{ matrix.channel == 'alpha' }}")
  const hostStep = ci.jobs['host-contracts'].steps.find(step => step.name === 'Verify the ${{ matrix.channel }} host channel')
  assert.equal(hostStep.run, 'npm run test:host-contract -- ${{ matrix.channel }}')

  const serializedCi = JSON.stringify(ci)
  const serializedRelease = JSON.stringify(release)
  const validateTarget = release.jobs['validate-target'].steps.find(step => step.id === 'target')
  const revalidateTarget = release.jobs.stage.steps.find(
    step => step.name === 'Revalidate immutable release target',
  )
  assert.doesNotMatch(serializedCi, /npm install|for channel|@deepseek-ai\/dsh@\$channel/)
  assert.doesNotMatch(serializedCi, /npm run (?:check|verify:platform)|NODE_V8_COVERAGE/)
  const serializedRefresh = JSON.stringify(refresh)
  assert.match(serializedRefresh, /npm run host:channels:update/)
  assert.match(serializedRefresh, /GITHUB_TOKEN suppresses workflow runs/)
  assert.match(serializedRefresh, /gh workflow run ci\.yml/)
  assert.doesNotMatch(serializedRefresh, /npm run (?:check|verify|test:host-contract)/)
  assert.match(validateTarget.run, /GITHUB_REF/)
  assert.match(validateTarget.run, /GITHUB_SHA/)
  assert.match(revalidateTarget.run, /GITHUB_REF/)
  assert.match(revalidateTarget.run, /GITHUB_SHA/)
  assert.doesNotMatch(serializedRelease, /inputs\.tag/)
  assert.match(serializedRelease, /actions\/workflows\/ci\.yml\/runs/)
  assert.match(serializedRelease, /head_branch == \\"main\\"/)
  assert.match(serializedRelease, /npm stage publish/)
  const packStep = release.jobs.stage.steps.find(step => step.id === 'pack')
  assert.match(packStep.run, /npm run coverage/)
  assert.ok(packStep.run.indexOf('npm run coverage') < packStep.run.indexOf('archive='))
  assert.match(packStep.run, /npm run test:package:consumer -- "\$archive_path"/)
  assert.doesNotMatch(packStep.run, /npm install[^\n]*archive_path/)
  assert.match(serializedRelease, /npm audit --omit=dev/)
  assert.match(serializedRelease, /node scripts\/npm-pack-filename\.mjs/)
  assert.match(serializedRelease, /npm@12\.0\.2/)
  assert.match(serializedRelease, /node-version":"24\.15\.0/)
  assert.doesNotMatch(serializedRelease, /NODE_AUTH_TOKEN|NPM_TOKEN/)
  assert.doesNotMatch(serializedRelease, /(?:^|[^\w])npm publish(?:[^\w]|$)/)
})

test('daily verification retains ordinary backend tests and leaves coverage to release preparation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts['test:backend'], 'node scripts/test-suite-files.mjs')
  assert.match(manifest.scripts.verify, /node scripts\/deterministic-test-groups\.mjs$/)
  assert.match(manifest.scripts['verify:ci'], /node scripts\/deterministic-test-groups\.mjs --ci$/)
  assert.doesNotMatch(manifest.scripts.verify, /coverage/)
  assert.doesNotMatch(manifest.scripts['verify:ci'], /coverage/)
  assert.equal(manifest.scripts.coverage, 'node scripts/coverage.mjs')
})
