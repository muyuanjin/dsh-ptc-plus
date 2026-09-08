import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hostAssistantUsageEvents, hostPersonaPatch, hostToolRuntime, ptcToolsMode, readHostPersona } from '../scripts/dsh-host-contract.mjs'
import { headlessConfigPatch, parseConfigDump, validateHeadlessRuntimeConfig } from '../scripts/headless-host.mjs'

test('compact usage inspection rejects malformed evidence and delegates to the public stream reader', async t => {
  assert.equal(hostAssistantUsageEvents({ type: 'user/message' }), undefined)
  for (const stream of [
    [{ type: 'text-chunks', time0: 0, index: 0, texts: ['text'], dt: [1] }],
    [{ type: 'reasoning-chunks', time0: 0, index: 0, texts: [], dt: [] }],
    [{ type: 'tool-call-chunks', time0: 0, index: 0, args: ['{}'], dt: [], id: '' }],
  ]) assert.throws(() => hostAssistantUsageEvents({ type: 'assistant/message', data: { stream } }))
  const { default: defaultExport, ...llm } = await import('@deepseek-ai/dsh-llm')
  const stream = [{ type: 'future-public-record' }]
  t.mock.module('@deepseek-ai/dsh-llm', { defaultExport, namedExports: { ...llm, expandAssistantStream(value) {
    assert.equal(value, stream)
    return [{ time: 1, chunk: { type: 'text-delta', text: 'hello' } },
      { time: 2, chunk: { type: 'usage', usage: { inputTokens: 5 } } }]
  } } })
  const current = await import('../scripts/dsh-host-contract.mjs?public-stream-reader')
  assert.deepEqual(current.hostAssistantUsageEvents({ type: 'assistant/message', data: { stream } }), [{ inputTokens: 5 }])
})

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
