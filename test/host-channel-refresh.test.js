import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { spawnFailure } from '../scripts/npm-cli.mjs'
import { refreshDevelopmentGraph, resolveChannel, satisfiesRange } from '../scripts/host-channel-manifest.mjs'

/** One temp root with a package.json and a package-lock.json. */
async function developmentRoot(t, { manifest, lock }) {
  const root = await mkdtemp(join(tmpdir(), 'ptc-channel-refresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  return root
}

test('a wildcard host range admits releases and never admits a prerelease', () => {
  // A release that declares `*` for a package it does not publish at its own version
  // is an ordinary supply shape, so resolving it must answer rather than throw.
  assert.equal(satisfiesRange('3.0.0', '*'), true)
  assert.equal(satisfiesRange('3.0.0-rc.1', '*'), false)
  assert.equal(satisfiesRange('3.0.0', 'x'), true)
  assert.equal(satisfiesRange('3.0.0-rc.1', 'x'), false)
  const packuments = {
    '@deepseek-ai/dsh': { 'dist-tags': { next: '8.0.0' }, versions: {
      '8.0.0': { version: '8.0.0', dist: { integrity: 'sha512-dsh' },
        dependencies: { '@deepseek-ai/cordis': '*' } },
    } },
    '@deepseek-ai/cordis': { 'dist-tags': { latest: '4.0.6-alpha.2' }, versions: {
      '4.0.5': { version: '4.0.5', dist: { integrity: 'sha512-4.0.5' } },
      '4.0.6-alpha.2': { version: '4.0.6-alpha.2', dist: { integrity: 'sha512-4.0.6-alpha.2' } },
    } },
  }
  const record = resolveChannel(packuments, { channel: 'next', distTag: 'next', blocks: true },
    ['@deepseek-ai/dsh', '@deepseek-ai/cordis'])
  // The published release wins over the newer prerelease, exactly as npm resolves it.
  assert.deepEqual(record.offTrain, { '@deepseek-ai/cordis': { version: '4.0.5', integrity: 'sha512-4.0.5' } })
  assert.deepEqual(record.absent, [])
})

test('a development-graph move that cannot finish restores the files it rewrote', async t => {
  // The transition pass rewrites the checkout's lock. A move that then fails must put
  // both files back: the next command must not run against a graph npm refuses.
  const manifest = { devDependencies: { '@deepseek-ai/dsh': 'next', '@deepseek-ai/dsh-tools': 'next' } }
  const lock = { packages: { 'node_modules/@deepseek-ai/dsh': { version: '0.2.0-rc.2' } } }
  const root = await developmentRoot(t, { manifest, lock })
  const manifestBefore = await readFile(join(root, 'package.json'), 'utf8')
  const lockBefore = await readFile(join(root, 'package-lock.json'), 'utf8')
  const steps = []
  const runNpm = async args => {
    steps.push(args.slice(0, 2).join(' '))
    if (args.includes('--save-dev')) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: {
        '@deepseek-ai/dsh': '^9.0.0', '@deepseek-ai/dsh-tools': '^9.0.0',
      } }, null, 2) + '\n')
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
        'node_modules/@deepseek-ai/dsh': { version: '9.0.0' },
        'node_modules/@deepseek-ai/dsh-agent': { version: '0.2.0-rc.2' },
      } }, null, 2) + '\n')
      return
    }
    if (args[0] === 'install') {
      throw new Error('ERESOLVE: the moved cohort contradicts the graph it left behind')
    }
  }
  await assert.rejects(() => refreshDevelopmentGraph({ root, record: { channel: 'next', version: '9.0.0' }, runNpm }),
    /ERESOLVE/)
  assert.deepEqual(steps, ['install --package-lock-only', 'install --package-lock-only'],
    'the transition ran, the ordinary resolver pass failed')
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifestBefore)
  assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), lockBefore,
    'a failed move leaves the development graph exactly as it found it')
})

test('a child process that never produced an exit status is reported as that', () => {
  // spawnSync reports a process it could not start, one a budget killed and one a
  // signal killed without an exit status. Calling any of those an exit sends the
  // maintainer looking at the command instead of at how it ended.
  assert.match(spawnFailure('npm', ['install'], { status: 1 }).message,
    /^npm install failed with exit 1$/u)
  assert.match(spawnFailure('npm', ['install'], { status: null, error: new Error('spawnSync npm.cmd EINVAL') }).message,
    /^npm install failed with no exit status \(spawnSync npm\.cmd EINVAL\)$/u)
  assert.match(spawnFailure('npm', ['ci'], { status: null, signal: 'SIGKILL' }).message,
    /^npm ci failed with no exit status \(signal SIGKILL\)$/u)
  assert.match(spawnFailure('dsh-rpc-contract-smoke.mjs', [], { status: null,
    error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }).message,
  /^dsh-rpc-contract-smoke\.mjs failed with no exit status \(ETIMEDOUT\)$/u)
})
