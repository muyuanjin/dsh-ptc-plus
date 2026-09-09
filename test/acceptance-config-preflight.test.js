import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { stringify } from 'yaml'
import * as host from '../scripts/headless-host.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('acceptance config-only uses a shared private overlay and cleans it on success or failure', async t => {
  const artifactRoots = new Set()
  t.after(async () => {
    for (const root of artifactRoots) await fs.rm(root, { recursive: true, force: true })
  })
  t.mock.module('node:fs/promises', { namedExports: { ...fs, async writeFile(path, ...args) {
    if (path.endsWith('manifest.json')) artifactRoots.add(dirname(path))
    return fs.writeFile(path, ...args)
  } } })
  t.mock.method(console, 'log', () => {})
  const secret = 'synthetic-private-route'
  const baseRows = [
    { id: 'system-prompt', config: { persona: '' } },
    { id: 'ptc-plus' },
    { id: 'llm-pi-ai', config: { providers: {
      fixture: { models: [], headers: { 'x-route': secret } },
    } } },
  ]
  let failPreflight = false
  let overlay
  let calls
  t.mock.module('../scripts/headless-host.mjs', { namedExports: {
    ...host,
    async preflightHeadlessHost(root) {
      host.windowsPath(root)
      return { dshHome: root }
    },
    dshInvocation: () => "& 'dsh-fixture'",
    resolveHeadlessProvider: (rows, runtime, home) => host.resolveHeadlessProvider(rows, runtime, home, { Config: value => value }),
    createProcessRunner: () => async (_command, args) => {
      calls++
      if (args.includes('-File')) return { code: 0, stdout: '', stderr: '' }
      const command = args.at(-1)
      assert.match(command, /--dump-config$/)
      const patch = command.match(/--patch '((?:[^']|'')+)'/)
      if (!patch) return { code: 0, stdout: stringify(baseRows), stderr: '' }
      const windowsOverlay = patch[1].replaceAll("''", "'")
      overlay = process.platform === 'win32' ? windowsOverlay : host.wslPath(windowsOverlay)
      assert.equal(host.windowsPath(overlay), windowsOverlay)
      const rows = host.parseConfigDump(await fs.readFile(overlay, 'utf8'))
      assert.equal(rows.find(row => row.id === 'llm-pi-ai').config.providers.fixture.headers['x-route'], secret)
      if (failPreflight) return { code: 1, stdout: '', stderr: 'synthetic preflight failure' }
      return { code: 0, stdout: stringify([...baseRows.filter(base => !rows.some(row => row.id === base.id)), ...rows]), stderr: '' }
    },
  } })
  const { main } = await import('../scripts/expensive-headless-acceptance.mjs?config-preflight')
  const env = {
    DSH_PTC_ACCEPTANCE_PROVIDER: 'fixture',
    DSH_PTC_ACCEPTANCE_MODEL: 'model',
    DSH_PTC_ACCEPTANCE_API_KEY_ENV: 'FIXTURE_KEY',
    FIXTURE_KEY: 'synthetic-credential',
    DSH_PTC_ACCEPTANCE_CONFIG_ONLY: '1',
    DSH_PTC_ACCEPTANCE_SCENARIOS: 'durable-repl-continuity',
  }
  for (failPreflight of [false, true]) {
    calls = 0
    if (failPreflight) await assert.rejects(main(env), /acceptance DSH config preflight failed/)
    else await main(env)
    assert.equal(calls, 3)
    await assert.rejects(fs.stat(dirname(overlay)), { code: 'ENOENT' })
  }
  assert.equal(artifactRoots.size, 2)
  for (const root of artifactRoots) {
    assert.ok(relative(repoRoot, root).startsWith(`artifacts`))
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isFile()) assert.equal((await fs.readFile(join(root, entry.name), 'utf8')).includes(secret), false, entry.name)
    }
  }
})
