import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { consumerManifest } from '../scripts/npm-consumer-smoke.mjs'

async function hostFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-consumer-cohort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = { 'node_modules/@deepseek-ai/dsh-tools': { name: '@deepseek-ai/dsh-tools', version: '1.0.0' },
    'node_modules/@deepseek-ai/cordis': { name: '@deepseek-ai/cordis', version: '2.0.0' } }
  await writeFile(join(root, 'package.json'), '{"private":true}\n')
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
  for (const [path, metadata] of Object.entries(packages)) {
    await mkdir(join(root, path), { recursive: true })
    await writeFile(join(root, path, 'package.json'), JSON.stringify(metadata))
  }
  return root
}

const plugin = { name: 'dsh-ptc-plus', peerDependencies: { '@deepseek-ai/dsh-tools': '*', '@deepseek-ai/cordis': '*' } }

test('packed consumer selects installed frozen peers without changing plugin ranges or picking dist-tags', async t => {
  const host = await hostFixture(t)
  const archive = join(host, 'archive with spaces.tgz')
  const before = JSON.stringify(plugin)
  const manifest = await consumerManifest(archive, plugin, host)
  assert.deepEqual(manifest.dependencies, {
    '@deepseek-ai/dsh-tools': '1.0.0', '@deepseek-ai/cordis': '2.0.0',
    'dsh-ptc-plus': pathToFileURL(archive).href,
  })
  assert.equal(manifest.private, true)
  assert.equal(JSON.stringify(plugin), before)
})

test('packed consumer refuses missing, drifted and unrecorded Host peer evidence', async t => {
  const host = await hostFixture(t)
  const archive = join(host, 'candidate.tgz')
  const filename = join(host, 'node_modules/@deepseek-ai/dsh-tools/package.json')
  const original = await readFile(filename, 'utf8')
  await writeFile(filename, JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '9.0.0' }))
  await assert.rejects(consumerManifest(archive, plugin, host), /differs from its frozen lock/)
  await writeFile(filename, original)
  await assert.rejects(consumerManifest(archive, { ...plugin, peerDependencies: { '@deepseek-ai/dsh-missing': '*' } }, host), /Cannot find module/)
  const lockPath = join(host, 'package-lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  delete lock.packages['node_modules/@deepseek-ai/cordis']
  await writeFile(lockPath, JSON.stringify(lock))
  await assert.rejects(consumerManifest(archive, plugin, host), /Host peer @deepseek-ai\/cordis is not proved/)
})
