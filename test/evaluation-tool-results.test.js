import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply, canonicalRunCodeResults, readEvaluationToolResults } from '../scripts/evaluation-tool-results.mjs'
import { validateTask } from '../scripts/ab-headless-trajectories.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ptc-canonical-result-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let listener
  let disposed = false
  const disposer = apply({ on(event, callback) {
    assert.equal(event, 'tools/result')
    listener = callback
    return () => { disposed = true }
  } }, { directory })
  const exec = { name: 'run_code', callId: 'call', rootCallId: 'call', agent: { sessionId: 'session' }, arguments: { code: 'source' } }
  const analysis = { session: { id: 'session' }, timeline: [{ name: 'run_code', callId: 'call', code: 'source', resultError: false, output: 'pkg' }] }
  return { directory, exec, analysis, emit: (result, overrides = {}) => listener({ ...exec, ...overrides }, result),
    disposer, disposed: () => disposed }
}

test('public final observer preserves canonical strings independently of renderer and logs', async t => {
  for (const [body, expected] of [
    [{ logs: [], result: 'pkg' }, 'pass'],
    [{ logs: ['pkg'], result: '"pkg"' }, 'fail'],
    [{ logs: ['pkg'] }, 'fail'],
    [{ logs: [], result: { name: 'pkg' } }, 'fail'],
    [{ logs: [], result: 123 }, 'fail'],
    [{ logs: [], result: null }, 'fail'],
    [{ logs: [], result: false }, 'fail'],
    [{ logs: [], result: 'x'.repeat(2049) }, 'incomplete'],
    [{ logs: 'invalid', result: 'pkg' }, 'incomplete'],
  ]) {
    const f = await fixture(t)
    const result = Object.freeze({ isError: false, value: Object.freeze(body), content: [{ type: 'text', text: 'pkg' }] })
    f.emit(result)
    f.analysis.canonicalToolResults = await readEvaluationToolResults(f.directory, 'session')
    const validation = await validateTask({ validator: 'package-name' }, 'pkg', f.analysis, '')
    assert.equal(validation.machineEvidence.status, expected, JSON.stringify(body))
    assert.equal(result.value, body)
    f.disposer()
    assert.equal(f.disposed(), true)
  }
  const f = await fixture(t)
  f.emit({ isError: false, value: { logs: [], result: '"123"' } })
  f.analysis.canonicalToolResults = await readEvaluationToolResults(f.directory, 'session')
  assert.equal((await validateTask({ validator: 'package-name' }, '"123"', f.analysis, '')).machineEvidence.status, 'pass')
})

test('records failures without successful values and ignores nested or unowned results', async t => {
  const f = await fixture(t)
  for (const overrides of [{ name: 'shell' }, { parent: Symbol() }, { agent: undefined },
    { callId: '' }, { rootCallId: 'other' }, { arguments: {} }]) {
    f.emit({ isError: false, value: { logs: [], result: 'pkg' } }, overrides)
  }
  assert.deepEqual(await readdir(f.directory), [])
  f.emit({ isError: true, error: { reason: 'synthetic' } })
  const evidence = await readEvaluationToolResults(f.directory, 'session')
  assert.equal(evidence.records[0].resultError, true)
  assert.equal(evidence.records[0].hasValue, false)
  assert.equal(Object.hasOwn(evidence.records[0], 'value'), false)
  assert.throws(() => apply({ on() {} }, { directory: 'relative' }), /must be absolute/)
  assert.throws(() => apply({ on() {} }), /must be absolute/)
})

test('evidence failure is incomplete and never changes the tool outcome', async t => {
  const f = await fixture(t)
  await rm(f.directory, { recursive: true })
  const result = Object.freeze({ isError: false, value: { logs: [], result: 'pkg' } })
  assert.doesNotThrow(() => f.emit(result))
  assert.equal(result.isError, false)
  assert.equal((await readEvaluationToolResults(f.directory, 'session')).status, 'incomplete')
  assert.equal((await readEvaluationToolResults(f.directory, undefined)).status, 'incomplete')
})

test('bounded reader rejects duplicate, malformed, mismatched and oversized evidence', async t => {
  const f = await fixture(t)
  f.emit({ isError: false, value: { logs: [], result: 'pkg' } })
  const file = join(f.directory, (await readdir(f.directory))[0])
  const original = await readFile(file, 'utf8')
  const record = JSON.parse(original)
  for (const text of [original + original, '{', JSON.stringify({ ...record, sessionId: 'other' }),
    JSON.stringify({ ...record, rootCallId: 'other' }), JSON.stringify({ ...record, value: 123 }),
    JSON.stringify({ ...record, unexpected: 'private' }), '\n'.repeat(129), 'x'.repeat(1024 * 1024 + 1)]) {
    await writeFile(file, text)
    assert.equal((await readEvaluationToolResults(f.directory, 'session')).status, 'incomplete')
  }
  await writeFile(file, original)
  const evidence = await readEvaluationToolResults(f.directory, 'session')
  for (const modified of [undefined, { ...evidence, sessionId: 'other' }, { ...evidence, records: undefined },
    { ...evidence, records: [...evidence.records, ...evidence.records] },
    { ...evidence, records: [{ ...record, callId: 'other', rootCallId: 'other' }] },
    { ...evidence, records: [{ ...record, sourceSha256: '0'.repeat(64) }] },
    { ...evidence, records: [{ ...record, resultError: true, hasValue: false, returnType: 'absent', logCount: undefined, value: undefined }] },
    { ...evidence, records: [{ ...record, complete: false, value: undefined }] }]) {
    f.analysis.canonicalToolResults = modified
    assert.equal(canonicalRunCodeResults(f.analysis)[0].status, 'incomplete')
  }
  f.analysis.canonicalToolResults = evidence
  f.analysis.timeline[0].code = 'changed'
  assert.equal(canonicalRunCodeResults(f.analysis)[0].status, 'incomplete')
  f.analysis.timeline[0].resultError = undefined
  assert.equal(canonicalRunCodeResults(f.analysis)[0].status, 'incomplete')
  assert.deepEqual(canonicalRunCodeResults({}), [])
})

test('observer caps records without throwing or serializing arbitrary canonical objects', async t => {
  const f = await fixture(t)
  const body = { logs: [], result: { providerPrivate: 'not retained' } }
  for (let index = 0; index < 130; index++) {
    f.emit({ isError: false, value: body }, { callId: `call-${index}`, rootCallId: `call-${index}` })
  }
  const evidence = await readEvaluationToolResults(f.directory, 'session')
  assert.equal(evidence.records.length, 128)
  assert.equal(JSON.stringify(evidence).includes('providerPrivate'), false)
  assert.equal(JSON.stringify(evidence).includes('not retained'), false)
})

test('actual public tools/result notifies final canonical result and ctx.on disposer removes capture', async t => {
  const f = await fixture(t)
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
  const tools = new ToolRuntime(ctx, { mode: 'ptc' })
  class FixtureRuntime extends PtcRuntime {
    language = 'typescript'
    output = { logs: ['pkg'], value: '"pkg"' }
    resolve(request) { return request }
    async run() { return this.output }
  }
  const runtime = new FixtureRuntime(ctx)
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href }).await()
  const before = JSON.stringify(await ctx.systemPrompt.assemble({ signal: new AbortController().signal }))
  const observerId = await ctx.loader.create({ id: 'ptc-evaluation-tool-results',
    name: new URL('../scripts/evaluation-tool-results.mjs', import.meta.url).href, config: { directory: f.directory } })
  await ctx.loader.await()
  assert.equal(JSON.stringify(await ctx.systemPrompt.assemble({ signal: new AbortController().signal })), before)
  const exec = { ...f.exec, arguments: { code: 'source', description: 'fixture' },
    agent: { sessionId: 'session', session: { header: {} } }, signal: new AbortController().signal }
  const result = await tools.execute(exec)
  assert.equal(result.isError, false)
  const evidence = await readEvaluationToolResults(f.directory, 'session')
  assert.equal(evidence.records[0].value, '"pkg"')
  assert.equal(evidence.records[0].logCount, 1)
  assert.equal(evidence.records[0].sourceSha256, createHash('sha256').update('source').digest('hex'))
  for (const [output, expected] of [[{ logs: [], value: 'pkg' }, 'pass'],
    [{ logs: ['pkg'] }, 'fail'], [{ logs: [], value: '"123"' }, 'pass']]) {
    runtime.output = output
    const sessionId = `session-${expected}-${output.value ?? 'none'}`
    const current = await tools.execute({ ...exec, agent: { sessionId, session: { header: {} } } })
    assert.equal(current.isError, false)
    const analysis = { ...f.analysis, session: { id: sessionId },
      canonicalToolResults: await readEvaluationToolResults(f.directory, sessionId) }
    assert.equal((await validateTask({ validator: 'package-name' }, output.value === '"123"' ? '"123"' : 'pkg', analysis, '')).machineEvidence.status, expected)
  }
  ctx.loader.remove(observerId)
  await ctx.loader.await()
  assert.equal(JSON.stringify(await ctx.systemPrompt.assemble({ signal: new AbortController().signal })), before)
  await tools.execute({ ...exec, callId: 'other', rootCallId: 'other', signal: new AbortController().signal })
  assert.equal((await readEvaluationToolResults(f.directory, 'session')).records.length, 1)
})
