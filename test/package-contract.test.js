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
      const runtime = ctx.get('ptcRuntime') ?? ctx.get('codeRuntime')
      delete runtime.executionInstructions
      delete runtime.sandboxMode
      delete runtime.timeout
      ${mutation}
    }`)
    const result = run(fake)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /did not take over the execution entry/)
  }
  const result = run(fileURLToPath(new URL('../index.js', import.meta.url)))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /took over its execution entry/)
})

test('keeps host-owned DSH runtime packages out of plugin dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const ordinaryDshDependencies = Object.keys(manifest.dependencies ?? {})
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))

  assert.deepEqual(ordinaryDshDependencies, [])
  for (const packageName of DSH_RUNTIME_PEERS) {
    assert.equal(manifest.peerDependencies?.[packageName], '*')
    assert.equal(manifest.devDependencies?.[packageName], 'next')
  }
})

test('keeps npm release authority stage-only and bound to a verified tag', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const release = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))

  assert.deepEqual(manifest.allowScripts, { esbuild: false })
  assert.deepEqual(ci.on.push.branches, ['main'])
  assert.equal(ci.on.push.tags, undefined)
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

  const verifyStep = ci.jobs.check.steps.find(step => step.name === 'Verify the reviewed candidate')
  assert.equal(verifyStep.run, 'npm run check')
  assert.equal(verifyStep.env.DSH_PTC_TEST_CONCURRENCY, 1)

  const serializedCi = JSON.stringify(ci)
  const serializedRelease = JSON.stringify(release)
  const validateTarget = release.jobs['validate-target'].steps.find(step => step.id === 'target')
  const revalidateTarget = release.jobs.stage.steps.find(
    step => step.name === 'Revalidate immutable release target',
  )
  assert.match(serializedCi, /node scripts\/npm-pack-filename\.mjs/)
  assert.match(serializedCi, /for channel in latest alpha/)
  assert.ok(serializedCi.includes('@deepseek-ai/dsh@$channel'))
  for (const packageName of DSH_RUNTIME_PEERS) {
    assert.ok(serializedCi.includes(packageName))
    assert.ok(!serializedCi.includes(`${packageName}@$channel`))
  }
  assert.match(validateTarget.run, /GITHUB_REF/)
  assert.match(validateTarget.run, /GITHUB_SHA/)
  assert.match(revalidateTarget.run, /GITHUB_REF/)
  assert.match(revalidateTarget.run, /GITHUB_SHA/)
  assert.doesNotMatch(serializedRelease, /inputs\.tag/)
  assert.match(serializedRelease, /actions\/workflows\/ci\.yml\/runs/)
  assert.match(serializedRelease, /head_branch == \\"main\\"/)
  assert.match(serializedRelease, /npm stage publish/)
  assert.match(serializedRelease, /node scripts\/npm-pack-filename\.mjs/)
  assert.match(serializedRelease, /npm@12\.0\.2/)
  assert.match(serializedRelease, /node-version":"24\.15\.0/)
  assert.doesNotMatch(serializedRelease, /NODE_AUTH_TOKEN|NPM_TOKEN/)
  assert.doesNotMatch(serializedRelease, /(?:^|[^\w])npm publish(?:[^\w]|$)/)
})
