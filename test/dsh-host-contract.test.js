import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hostPersonaPatch, hostToolRuntime, ptcToolsMode, readHostPersona } from '../scripts/dsh-host-contract.mjs'
import { headlessConfigPatch, parseConfigDump, validateHeadlessRuntimeConfig } from '../scripts/headless-host.mjs'

test('public tool schemas choose current presentation, then legacy, and reject unsupported hosts', () => {
  const runtime = allowed => ({ Config({ mode }) {
    if (!allowed.includes(mode)) throw new Error('unsupported mode')
  } })
  assert.equal(ptcToolsMode(runtime(['ptc', 'code'])), 'ptc')
  assert.equal(ptcToolsMode(runtime(['code'])), 'code')
  assert.throws(() => ptcToolsMode(runtime(['native'])), /neither ptc nor code/)
})

test('persona adaptation preserves unknown fields and replaces the complete selected format', () => {
  const text = 'Render {{model}} and "quoted" text.\nKeep this newline.'
  const cases = [
    { config: undefined, expected: { prefix: undefined, suffix: '' }, fields: { persona: text } },
    { config: { persona: 'old' }, expected: { prefix: 'old', suffix: '' }, fields: { persona: text } },
    { config: { persona: 'stale', personaPrefix: 'first', personaSuffix: 'last' },
      expected: { prefix: 'first', suffix: 'last' }, fields: { personaPrefix: text, personaSuffix: '' } },
    { config: { persona: 'stale', personaPrefix: 'first' },
      expected: { prefix: 'first', suffix: undefined }, fields: { personaPrefix: text, personaSuffix: '' } },
    { config: { persona: 'stale', personaSuffix: 'last' },
      expected: { prefix: undefined, suffix: 'last' }, fields: { personaPrefix: text, personaSuffix: '' } },
  ]
  for (const { config, expected, fields } of cases) {
    const before = structuredClone(config)
    assert.deepEqual(readHostPersona(config), expected)
    const patch = hostPersonaPatch(config, text)
    assert.deepEqual(patch, fields)
    assert.deepEqual(readHostPersona({ ...config, ...patch }), { prefix: text, suffix: '' })
    assert.deepEqual(config, before)
  }
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
