import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

const DSH_RUNTIME_PEERS = [
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tools',
]

test('keeps host-owned DSH runtime packages out of plugin dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const ordinaryDshDependencies = Object.keys(manifest.dependencies ?? {})
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))

  assert.deepEqual(ordinaryDshDependencies, [])
  for (const packageName of DSH_RUNTIME_PEERS) {
    assert.equal(manifest.peerDependencies?.[packageName], '*')
    assert.equal(manifest.devDependencies?.[packageName], 'alpha')
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

  const serializedCi = JSON.stringify(ci)
  const serializedRelease = JSON.stringify(release)
  const validateTarget = release.jobs['validate-target'].steps.find(step => step.id === 'target')
  const revalidateTarget = release.jobs.stage.steps.find(
    step => step.name === 'Revalidate immutable release target',
  )
  assert.match(serializedCi, /node scripts\/npm-pack-filename\.mjs/)
  assert.match(serializedCi, /for channel in alpha next/)
  for (const packageName of DSH_RUNTIME_PEERS) {
    assert.match(serializedCi, new RegExp(`${packageName.replaceAll('/', '\\/')}@\\\$channel`))
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
