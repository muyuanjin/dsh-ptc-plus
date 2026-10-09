import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { toolSdkSchemas } from '../internal/program-bindings.js'
import { SpillStore } from '@deepseek-ai/dsh-spill'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import * as spillPolicy from '@deepseek-ai/dsh-spill-policy'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createCapabilityEnvironment } from '../internal/capability-environment.js'

class ObservedLocalSpillStore extends LocalSpillStore {
  saved = []

  async saveText(input) {
    const reference = await super.saveText(input)
    this.saved.push({ input, reference })
    return reference
  }
}

class FailedSpillStore extends SpillStore {
  async saveText() { throw new Error('fixture storage unavailable') }
}

async function fixture(t, storage, managed = true) {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false,
    personaPrefix: '', personaSuffix: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  const root = await mkdtemp(join(tmpdir(), 'ptc-context-preview-'))
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const store = storage === 'failed' ? new FailedSpillStore(ctx)
    : storage === 'absent' ? undefined : new ObservedLocalSpillStore(ctx, { root, cleanupPeriodDays: 0 })
  let executions = 0
  const canonical = { body: '完整文本😀 result '.repeat(2_000), count: 2_000 }
  const content = [{ type: 'text', text: JSON.stringify(canonical) }]
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'preview_probe', description: 'Return a large canonical object.', parameters: {},
    output: { schema: { type: 'object', properties: { body: { type: 'string' }, count: { type: 'integer' } },
      additionalProperties: false }, render: () => content },
    async execute() { executions += 1; return canonical },
  })))
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  await ctx.plugin(SessionQueryEngine).await()
  const agent = { id: 'preview-agent', session: ctx.sessions.create('preview-session') }
  const env = createCapabilityEnvironment({ ctx, config: { capabilityManagementEnabled: managed,
    capabilityBaseline: '[]', capabilityOverrides: '{}', capabilityStatistics: '{"enabled":false}',
    modelPreviewTokens: 256 }, toolSchemasForAgent: target => toolSdkSchemas(ctx.tools, target),
    modelSchemasForAgent: target => ctx.tools.schemas(target) })
  t.after(() => env.dispose())
  await env.prepare(agent, [])
  ctx.on('tools/post-execute', (exec, result, next) => env.postExecute(exec, result, next), { prepend: true })
  ctx.on('tools/ptc-dispatch-log', (dispatch, next) => env.dispatchLog(dispatch, next), { prepend: true })
  const execute = () => ctx.tools.execute({ name: 'preview_probe', callId: 'preview-call', arguments: {},
    agent, signal: new AbortController().signal })
  return { ctx, agent, canonical, content, store, execute, executions: () => executions }
}

test('session preview adapter bounds the accepted presentation and preserves canonical values and retrieval', async t => {
  const state = await fixture(t, 'local')
  const result = await state.execute()
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, state.canonical)
  assert.ok(estimateContent(result.content) <= 256)
  assert.match(result.content.map(block => block.text).join(''), /Full formatted result stored at:/)
  assert.equal(state.store.saved.length, 1)
  const saved = state.store.saved[0]
  assert.equal(saved.input.owner.sessionId, state.agent.session.id)
  assert.equal(await readFile(saved.reference.locator, 'utf8'), state.content[0].text)
  assert.equal(saved.reference.bytes, Buffer.byteLength(state.content[0].text))
  assert.deepEqual(JSON.parse(await readFile(saved.reference.locator, 'utf8')), result.value)
  assert.equal(result.value.body.length, state.canonical.body.length)
  assert.equal(state.executions(), 1, 'Reading retained presentation never executes the capability again.')
})

test('session preview adapter keeps the successful full presentation when recovery storage cannot retain it', async t => {
  for (const storage of ['failed', 'absent']) {
    await t.test(storage, async subtest => {
      const state = await fixture(subtest, storage)
      const result = await state.execute()
      assert.equal(result.isError, false)
      assert.deepEqual(result.value, state.canonical)
      assert.deepEqual(result.content, state.content)
      assert.equal(state.executions(), 1)
    })
  }
})

test('session preview adapter bounds dispatch-log copies without changing the completed program value', async t => {
  const state = await fixture(t, 'local')
  const result = await state.execute()
  const copiesBefore = state.store.saved.length
  const original = [{ type: 'text', text: state.canonical.body }]
  const dispatch = { exec: { agent: state.agent }, name: 'preview_probe', subCallId: 'nested-preview' }
  const bounded = await state.ctx.waterfall('tools/ptc-dispatch-log', dispatch, async () => original)
  assert.ok(estimateContent(bounded) <= 256)
  assert.equal(state.store.saved.length, copiesBefore + 1)
  assert.equal(await readFile(state.store.saved.at(-1).reference.locator, 'utf8'), original[0].text)
  assert.deepEqual(result.value, state.canonical)
  assert.equal(state.executions(), 1)
})

test('management off preserves native previews and an installed host policy does not duplicate spill', async t => {
  const native = await fixture(t, 'local', false)
  assert.deepEqual((await native.execute()).content, native.content)
  assert.equal(native.store.saved.length, 0)
  const managed = await fixture(t, 'local')
  await managed.ctx.plugin(spillPolicy, { maxInlineTokens: 512 }).await()
  assert.ok(estimateContent((await managed.execute()).content) <= 256)
  assert.equal(managed.store.saved.length, 1)
})
