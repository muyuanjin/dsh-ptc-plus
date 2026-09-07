import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hostToolRuntime, ptcToolsMode } from '../scripts/dsh-host-contract.mjs'
import { headlessConfigPatch, parseConfigDump, validateHeadlessRuntimeConfig } from '../scripts/headless-host.mjs'

test('public tool schemas choose current presentation, then legacy, and reject unsupported hosts', () => {
  const runtime = allowed => ({ Config({ mode }) {
    if (!allowed.includes(mode)) throw new Error('unsupported mode')
  } })
  assert.equal(ptcToolsMode(runtime(['ptc', 'code'])), 'ptc')
  assert.equal(ptcToolsMode(runtime(['code'])), 'code')
  assert.throws(() => ptcToolsMode(runtime(['native'])), /neither ptc nor code/)
})

test('headless config uses the selected installation schema instead of checkout dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ptc-host-schema-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tools = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
  await mkdir(tools, { recursive: true })
  await writeFile(join(tools, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', main: 'index.cjs' }))
  await writeFile(join(tools, 'index.cjs'), `exports.ToolRuntime = { Config(config) {
    if (config.mode !== 'code') throw new Error('fixture requires code'); return config
  } }`)
  const dshEntry = join(root, 'bin.js')
  assert.equal(ptcToolsMode(hostToolRuntime(dshEntry)), 'code')
  const runtime = { dshEntry, toolsMode: 'ptc', permissionMode: 'danger-full-access',
    provider: 'fixture', model: 'fixture' }
  const rows = parseConfigDump(headlessConfigPatch([{ id: 'system-prompt', config: { persona: '' } }], runtime))
  assert.equal(rows.find(row => row.id === 'tools').config.mode, 'code')
  assert.equal(validateHeadlessRuntimeConfig(rows, 'selected Host', runtime), true)
  rows.find(row => row.id === 'tools').config.mode = 'ptc'
  assert.throws(() => validateHeadlessRuntimeConfig(rows, 'wrong Host', runtime), /fixture requires code/)
})
