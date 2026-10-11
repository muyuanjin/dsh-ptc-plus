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
import { selectPublishedRelease, update, validatePublishedRelease, verifyCurrent, verifyInstalledHostGraph } from '../scripts/dsh-dependency-baseline.mjs'

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

test('execution smoke rejects capability-only changes and accepts the real plugin', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-seam-smoke-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const smoke = fileURLToPath(new URL('../scripts/dsh-execution-seam-smoke.mjs', import.meta.url))
  const run = plugin => spawnSync(process.execPath, [smoke, plugin], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
  })
  const fake = join(directory, 'fake.mjs')
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
  const root = await mkdtemp(join(tmpdir(), 'ptc-installed-host-'))
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

test('freezes official latest and next host baselines without changing ordinary installs', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const latestManifest = JSON.parse(await readFile(new URL('../compat/latest/package.json', import.meta.url), 'utf8'))
  const latestLock = JSON.parse(await readFile(new URL('../compat/latest/package-lock.json', import.meta.url), 'utf8'))
  const hostSuite = await readFile(new URL('../scripts/dsh-host-contract-suite.mjs', import.meta.url), 'utf8')

  const dshDevelopmentPackages = Object.entries(manifest.devDependencies)
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(dshDevelopmentPackages.some(([name]) => name === '@deepseek-ai/dsh'))
  assert.ok(dshDevelopmentPackages.every(([, version]) => version === 'next'))
  assert.ok(dshDevelopmentPackages.every(([name]) => lock.packages[''].devDependencies[name] === 'next'))
  const nextVersion = lock.packages['node_modules/@deepseek-ai/dsh'].version
  assert.ok(dshDevelopmentPackages.every(([name]) => lock.packages[`node_modules/${name}`].version === nextVersion))
  assert.deepEqual(latestManifest.dependencies, { '@deepseek-ai/dsh': 'latest' })
  assert.equal(latestLock.packages[''].dependencies['@deepseek-ai/dsh'], 'latest')
  assert.match(latestLock.packages['node_modules/@deepseek-ai/dsh'].version, /^\d+\.\d+\.\d+/)
  assert.doesNotMatch(hostSuite, /npm\(\[['"]install['"]/)
  assert.match(hostSuite, /run\('tar', \['-xzf'/)
  assert.match(hostSuite, /exposePluginDependencies\(consumer\)/)
  const current = JSON.parse(await readFile(new URL('../compat/current/package.json', import.meta.url), 'utf8'))
  const currentLock = JSON.parse(await readFile(new URL('../compat/current/package-lock.json', import.meta.url), 'utf8'))
  const source = JSON.parse(await readFile(new URL('../compat/current/release.json', import.meta.url), 'utf8'))
  assert.equal(current.dependencies['@deepseek-ai/dsh'], source.channel)
  assert.equal(currentLock.packages[''].dependencies['@deepseek-ai/dsh'], source.channel)
  assert.equal(currentLock.packages['node_modules/@deepseek-ai/dsh'].version, source.version)
  assert.ok(Object.entries(currentLock.packages).filter(([name]) => /node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(name))
    .every(([, value]) => value.version === source.version))
})

test('published release discovery follows a moved prerelease channel while latest and next remain unchanged', () => {
  const tags = { latest: '7.0.0', next: '7.0.0', preview: '8.0.0-beta.3', canary: '9.0.0-dev.1' }
  const releases = [
    { draft: false, tag_name: 'dsh-v7.0.0', published_at: '2020-01-01T00:00:00Z' },
    { draft: true, tag_name: 'dsh-v9.0.0-dev.1', published_at: '2020-03-01T00:00:00Z' },
    { draft: false, tag_name: 'dsh-v8.0.0-beta.3', published_at: '2020-02-01T00:00:00Z', prerelease: true },
  ]
  assert.deepEqual(selectPublishedRelease(tags, releases), {
    version: tags.preview, channel: 'preview', releaseTag: 'dsh-v8.0.0-beta.3', publishedAt: '2020-02-01T00:00:00Z',
  })
  assert.throws(() => selectPublishedRelease({ latest: tags.latest, next: tags.next }, releases), /has no official npm channel/)
})

test('published baseline refresh captures channel and provenance changes without rediscovering an unchanged cohort', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-published-baseline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const latestRoot = join(root, 'latest')
  const currentRoot = join(root, 'current')
  await Promise.all([mkdir(latestRoot), mkdir(currentRoot)])
  const host = '@deepseek-ai/dsh'
  const writeJson = (folder, filename, value) => writeFile(join(folder, filename), JSON.stringify(value, null, 2) + '\n')
  const lock = (channel, dependencyKey, version) => ({ lockfileVersion: 3, packages: {
    '': { [dependencyKey]: { [host]: channel } }, [`node_modules/${host}`]: { version, resolved: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz` },
  } })
  const release = { version: '8.0.0-beta.3', channel: 'beta', releaseTag: 'dsh-v8.0.0-beta.3', publishedAt: '2020-02-01T00:00:00Z' }
  await Promise.all([
    writeJson(root, 'package.json', { devDependencies: { [host]: 'next' } }), writeJson(root, 'package-lock.json', lock('next', 'devDependencies', '7.0.0')),
    writeJson(latestRoot, 'package.json', { dependencies: { [host]: 'latest' } }), writeJson(latestRoot, 'package-lock.json', lock('latest', 'dependencies', '7.0.0')),
    writeFile(join(latestRoot, '.npmrc'), 'registry=https://registry.npmjs.org/\n'),
    writeJson(currentRoot, 'package.json', { dependencies: { [host]: 'beta' } }), writeJson(currentRoot, 'package-lock.json', lock('beta', 'dependencies', release.version)),
    writeJson(currentRoot, 'release.json', release),
  ])
  let selected = release
  let lookups = 0
  const calls = []
  const options = { root, latestRoot, currentRoot, readTags: () => ({ latest: '7.0.0', next: '7.0.0', [selected.channel]: selected.version }),
    readRelease: async () => { lookups++; return selected }, runNpm: (args, options) => calls.push({ args, options }) }
  await update(options)
  assert.equal(lookups, 1)
  assert.deepEqual(calls, [])
  selected = { ...release, channel: 'preview' }
  await update(options)
  assert.deepEqual(await verifyCurrent(currentRoot), selected)
  const changedLock = JSON.parse(await readFile(join(currentRoot, 'package-lock.json'), 'utf8'))
  assert.equal(changedLock.packages[''].dependencies[host], 'preview')
  assert.deepEqual(changedLock.packages[`node_modules/${host}`], lock('beta', 'dependencies', release.version).packages[`node_modules/${host}`])
  assert.deepEqual(calls.map(call => call.args), [['ci', '--dry-run', '--ignore-scripts']])
  selected = { ...selected, publishedAt: '2020-02-02T00:00:00Z' }
  await update(options)
  assert.deepEqual(await verifyCurrent(currentRoot), selected)
  assert.equal(calls.length, 1, 'Provenance-only updates reuse the frozen graph without running npm.')
  const before = await readFile(join(currentRoot, 'release.json'), 'utf8')
  await update(options)
  assert.equal(await readFile(join(currentRoot, 'release.json'), 'utf8'), before)
  assert.equal(calls.length, 1)
  for (const invalid of [{ ...selected, releaseTag: 'unrelated-tag' }, { ...selected, publishedAt: 42 },
    { ...selected, publishedAt: '2020-02-31T00:00:00Z' }, { ...selected, publishedAt: undefined }, { ...selected, channel: '' }]) {
    assert.throws(() => validatePublishedRelease(invalid), /invalid frozen published/)
    await writeJson(currentRoot, 'release.json', invalid)
    await assert.rejects(() => verifyCurrent(currentRoot), /invalid frozen published/)
  }
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
  assert.equal(ci.jobs.check.strategy.matrix.include.filter(entry => entry['host-contracts']).length, 1)
  assert.deepEqual(ci.jobs.check.strategy.matrix.include.find(entry => entry['host-contracts']), {
    os: 'ubuntu-latest', node: 24, 'host-contracts': true,
  })
  const hostStep = ci.jobs.check.steps.find(step => step.name === 'Verify frozen latest and next host contracts')
  assert.equal(hostStep.run, 'npm run test:host-contract')
  assert.equal(hostStep.if, 'matrix.host-contracts')

  const serializedCi = JSON.stringify(ci)
  const serializedRelease = JSON.stringify(release)
  const validateTarget = release.jobs['validate-target'].steps.find(step => step.id === 'target')
  const revalidateTarget = release.jobs.stage.steps.find(
    step => step.name === 'Revalidate immutable release target',
  )
  assert.doesNotMatch(serializedCi, /npm install|for channel|@deepseek-ai\/dsh@\$channel/)
  assert.doesNotMatch(serializedCi, /npm run (?:check|verify:platform)|NODE_V8_COVERAGE/)
  const serializedRefresh = JSON.stringify(refresh)
  assert.match(serializedRefresh, /npm run host:baseline:update/)
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
