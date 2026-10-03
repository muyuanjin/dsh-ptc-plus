import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'

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
  assert.match(serializedRelease, /npm audit --omit=dev/)
  assert.match(serializedRelease, /node scripts\/npm-pack-filename\.mjs/)
  assert.match(serializedRelease, /npm@12\.0\.2/)
  assert.match(serializedRelease, /node-version":"24\.15\.0/)
  assert.doesNotMatch(serializedRelease, /NODE_AUTH_TOKEN|NPM_TOKEN/)
  assert.doesNotMatch(serializedRelease, /(?:^|[^\w])npm publish(?:[^\w]|$)/)
})
