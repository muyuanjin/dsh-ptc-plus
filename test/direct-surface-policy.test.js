import assert from 'node:assert/strict'
import test from 'node:test'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply as applyLlmInvariant } from '@deepseek-ai/dsh-llm/invariant'
import { Session } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { CONFIG_DEFAULTS } from '../internal/config-spec.js'
import { createDirectSurfaceOwner } from '../internal/direct-surface-owner.js'
import { createUserBindingsSnapshot } from '../internal/user-bindings.js'
import { recordedSessionEvents as sessionEvents } from './session-observation-fixture.js'

function assembly() {
  return {
    sections: [{ name: 'tools:code-only', text: 'code-only' }],
    contexts: [],
    variables: {},
    tools: [{
      name: 'run_code',
      description: 'Execute one standalone program.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' }, description: { type: 'string' } },
        required: ['code'],
      },
    }],
  }
}

function createOwner(overrides = {}) {
  return createDirectSurfaceOwner({
    editTransport: { isInstalled: () => true, ensureInstalled() {} },
    runtimeConfig: { ...CONFIG_DEFAULTS },
    canonicalizeToolCalls: false,
    sessionId: agent => agent.id,
    toolSchemasForAgent: () => [],
    ...overrides,
  })
}

async function collect(stream) {
  const output = []
  for await (const chunk of stream) output.push(chunk)
  return output
}

async function invariantContext(t) {
  const ctx = new CordisContext()
  ctx.provide('invariants', {
    register(_packageName, install) {
      install(ctx, message => { throw new Error(message) })
      return () => {}
    },
  })
  await applyLlmInvariant(ctx)
  t.after(() => ctx.fiber.dispose())
  return ctx
}

const INVALID_TOOL_JSON_FINISH = Object.freeze({
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      message: 'DeepSeek Messages stream: tool input is invalid JSON',
      code: 'MALFORMED_RESPONSE',
    },
  },
})

function malformedToolCall(name, raw, options = {}) {
  const index = options.index ?? 1
  const id = options.id ?? 'malformed-direct-call'
  const split = options.split ?? Math.max(1, raw.length - 1)
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: '' },
    { type: 'tool-call-delta', index, id, argumentsDelta: raw.slice(0, split) },
    { type: 'tool-call-delta', index, id, argumentsDelta: raw.slice(split) },
    {
      type: 'block-end', index,
      block: { type: 'tool-call', id, name, arguments: raw },
    },
    INVALID_TOOL_JSON_FINISH,
  ]
}

test('recovers the archived trailing-brace edit call only after schema validation', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-edit-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const raw = '{"edits": [{"old_string": "3", "new_string": "3]"}], "expected_target_call_seq": 109}}'
  const prefix = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Apply the validated edit.' },
    {
      type: 'block-end', index: 0,
      block: { type: 'reasoning', text: 'Apply the validated edit.' },
    },
  ]
  const usage = { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } }
  const malformed = malformedToolCall('edit_run_code', raw)
  malformed.splice(-1, 0, usage)
  const chunks = [...prefix, ...malformed]
  const streamed = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () { yield* chunks },
  ))

  assert.deepEqual(streamed.slice(0, prefix.length), prefix)
  const toolChunks = streamed.slice(prefix.length)
  assert.equal(toolChunks.filter(chunk => chunk.type === 'tool-call-delta')
    .map(chunk => chunk.argumentsDelta).join(''), raw.slice(0, -1))
  assert.deepEqual(toolChunks.find(chunk => chunk.type === 'block-end').block, {
    type: 'tool-call',
    id: 'malformed-direct-call',
    name: 'edit_run_code',
    arguments: raw.slice(0, -1),
  })
  assert.deepEqual(toolChunks.at(-2), usage)
  assert.deepEqual(toolChunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const invariantCtx = await invariantContext(t)
  assert.deepEqual(await collect(invariantCtx.waterfall(
    invariantCtx,
    'llm/stream',
    {},
    async function* () { yield* streamed },
  )), streamed)
  assert.equal(owner.executionRejection({
    name: 'edit_run_code', callId: 'malformed-direct-call', agent,
  }), undefined)
})

test('recovers the same bounded trailing delimiter shape for run_code', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-run-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const raw = '{"code":"return 1"}}'
  const streamed = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () { yield* malformedToolCall('run_code', raw) },
  ))
  assert.equal(streamed.find(chunk => chunk.type === 'block-end').block.arguments, raw.slice(0, -1))
  assert.deepEqual(streamed.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('rejects repairable calls whose block index violates the DSH stream contract', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-invalid-index-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const invariantCtx = await invariantContext(t)

  for (const [index, thrown] of [
    [-1, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    [-1, true],
    [Number.MAX_SAFE_INTEGER + 1, true],
  ]) {
    const chunks = malformedToolCall('run_code', '{"code":"return 1"}}', {
      index,
      id: `invalid-index-${index}`,
    })
    const streamed = await collect(owner.stream(
      { sessionId: agent.id, signal, tools: projected.tools },
      async function* () {
        yield* (thrown ? chunks.slice(0, -1) : chunks)
        if (thrown) {
          const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
          error.code = 'MALFORMED_RESPONSE'
          throw error
        }
      },
    ))

    assert.equal(streamed.find(chunk => chunk.type === 'block-end').block.id,
      'dsh-ptc-plus-malformed-tool-json')
    assert.deepEqual(await collect(invariantCtx.waterfall(
      invariantCtx,
      'llm/stream',
      {},
      async function* () { yield* streamed },
    )), streamed)
  }
})

test('rejects repairable calls interleaved with non-tool block framing', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-conflicting-framing-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const invariantCtx = await invariantContext(t)
  const cases = [
    [{ type: 'block-start', index: 2, blockType: 'text' }, false],
    [{ type: 'block-start', index: 2, blockType: 'reasoning' }, true],
    [{ type: 'block-end', index: 2, block: { type: 'text', text: 'conflict' } }, false],
    [{ type: 'block-end', index: 2, block: { type: 'reasoning', text: 'conflict' } }, true],
  ]

  for (const [conflict, thrown] of cases) {
    const chunks = malformedToolCall('run_code', '{"code":"return 1"}}', {
      id: `conflicting-framing-${conflict.blockType ?? conflict.block.type}`,
    })
    chunks.splice(-1, 0, conflict)
    const streamed = await collect(owner.stream(
      { sessionId: agent.id, signal, tools: projected.tools },
      async function* () {
        yield* (thrown ? chunks.slice(0, -1) : chunks)
        if (thrown) {
          const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
          error.code = 'MALFORMED_RESPONSE'
          throw error
        }
      },
    ))

    assert.equal(streamed.find(chunk => chunk.type === 'block-end').block.id,
      'dsh-ptc-plus-malformed-tool-json')
    assert.deepEqual(await collect(invariantCtx.waterfall(
      invariantCtx,
      'llm/stream',
      {},
      async function* () { yield* streamed },
    )), streamed)
  }
})

test('rejects repairable calls that violate complete-call ordering', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-call-order-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const invariantCtx = await invariantContext(t)
  const raw = '{"code":"return 1"}}'
  const orders = [
    ['start', 'end', 'delta'],
    ['delta', 'end', 'start'],
    ['end', 'start', 'delta'],
    ['end', 'delta', 'start'],
  ]

  for (const [orderIndex, order] of orders.entries()) {
    for (const thrown of [false, true]) {
      const id = `invalid-order-${orderIndex}-${thrown}`
      const chunksByKind = {
        start: { type: 'block-start', index: 1, blockType: 'tool-call' },
        delta: { type: 'tool-call-delta', index: 1, id, name: 'run_code', argumentsDelta: raw },
        end: {
          type: 'block-end', index: 1,
          block: { type: 'tool-call', id, name: 'run_code', arguments: raw },
        },
      }
      const chunks = [...order.map(kind => chunksByKind[kind]), INVALID_TOOL_JSON_FINISH]
      const streamed = await collect(owner.stream(
        { sessionId: agent.id, signal, tools: projected.tools },
        async function* () {
          yield* (thrown ? chunks.slice(0, -1) : chunks)
          if (thrown) {
            const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
            error.code = 'MALFORMED_RESPONSE'
            throw error
          }
        },
      ))

      assert.equal(streamed.find(chunk => chunk.type === 'block-end').block.id,
        'dsh-ptc-plus-malformed-tool-json')
      assert.deepEqual(await collect(invariantCtx.waterfall(
        invariantCtx,
        'llm/stream',
        {},
        async function* () { yield* streamed },
      )), streamed)
    }
  }
})

test('rejects complete calls that reuse one call ID across indexes', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-duplicate-call-id-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const invariantCtx = await invariantContext(t)

  for (const thrown of [false, true]) {
    const first = malformedToolCall('run_code', '{"code":"must not execute 1"}', {
      index: 1,
      id: 'duplicate-call-id',
    }).slice(0, -1)
    const second = malformedToolCall('run_code', '{"code":"must not execute 2"}', {
      index: 2,
      id: 'duplicate-call-id',
    }).slice(0, -1)
    const streamed = await collect(owner.stream(
      { sessionId: agent.id, signal, tools: projected.tools },
      async function* () {
        yield* first
        yield* second
        if (thrown) {
          const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
          error.code = 'MALFORMED_RESPONSE'
          throw error
        }
        yield INVALID_TOOL_JSON_FINISH
      },
    ))

    const toolEnds = streamed.filter(chunk => chunk.type === 'block-end'
      && chunk.block.type === 'tool-call')
    assert.equal(toolEnds.length, 1)
    assert.equal(toolEnds[0].block.id, 'dsh-ptc-plus-malformed-tool-json')
    assert.deepEqual(await collect(invariantCtx.waterfall(
      invariantCtx,
      'llm/stream',
      {},
      async function* () { yield* streamed },
    )), streamed)
  }
})

test('settles malformed responses without emitting duplicate usage', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-usage-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const firstUsage = { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
  const laterUsage = { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } }
  const complete = malformedToolCall('run_code', '{"code":"return 1"}')
  complete.splice(-1, 0, laterUsage)
  const streamed = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () { yield firstUsage; yield* complete },
  ))

  assert.deepEqual(streamed.filter(chunk => chunk.type === 'usage'), [firstUsage])
  assert.equal(streamed.find(chunk => chunk.type === 'block-end').block.id,
    'dsh-ptc-plus-malformed-tool-json')
  const invariantCtx = await invariantContext(t)
  assert.deepEqual(await collect(invariantCtx.waterfall(
    invariantCtx,
    'llm/stream',
    {},
    async function* () { yield* streamed },
  )), streamed)

  const duplicateBuffered = malformedToolCall('run_code', '{"code":"return 2"}}', {
    id: 'duplicate-buffered-usage',
  })
  duplicateBuffered.splice(-1, 0, firstUsage, laterUsage)
  const rejected = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () { yield* duplicateBuffered },
  ))
  assert.deepEqual(rejected.filter(chunk => chunk.type === 'usage'), [firstUsage])
  assert.equal(rejected.find(chunk => chunk.type === 'block-end').block.id,
    'dsh-ptc-plus-malformed-tool-json')
  assert.deepEqual(await collect(invariantCtx.waterfall(
    invariantCtx,
    'llm/stream',
    {},
    async function* () { yield* rejected },
  )), rejected)
})

test('settles duplicate usage emitted before tool material or the exact failure', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-pre-tool-usage-session' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const firstUsage = { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
  const duplicateUsage = { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } }
  const invariantCtx = await invariantContext(t)

  for (const [withTool, thrown] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    const toolChunks = withTool
      ? malformedToolCall('run_code', '{"code":"must not execute"}', {
          id: `pre-tool-usage-${thrown}`,
        }).slice(0, -1)
      : []
    const streamed = await collect(owner.stream(
      { sessionId: agent.id, signal, tools: projected.tools },
      async function* () {
        yield firstUsage
        yield duplicateUsage
        yield* toolChunks
        if (thrown) {
          const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
          error.code = 'MALFORMED_RESPONSE'
          throw error
        }
        yield INVALID_TOOL_JSON_FINISH
      },
    ))

    assert.deepEqual(streamed.filter(chunk => chunk.type === 'usage'), [firstUsage])
    assert.equal(streamed.find(chunk => chunk.type === 'block-end').block.id,
      'dsh-ptc-plus-malformed-tool-json')
    assert.deepEqual(await collect(invariantCtx.waterfall(
      invariantCtx,
      'llm/stream',
      {},
      async function* () { yield* streamed },
    )), streamed)
  }

  const unrelatedFinish = { type: 'finish', reason: { kind: 'stop' } }
  const unchanged = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () { yield firstUsage; yield duplicateUsage; yield unrelatedFinish },
  ))
  assert.deepEqual(unchanged, [firstUsage, duplicateUsage, unrelatedFinish])
})

test('settles unrepairable completed tool JSON as ordinary DSH tool calls', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-counterexamples' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const invariantCtx = await invariantContext(t)
  const schemaInvalid = malformedToolCall('edit_run_code', '{"edits":1}}')
  const parseInvalid = malformedToolCall('run_code', '{"code":]}')
  const unknown = malformedToolCall('read', '{"path":"README.md"}}')
  const otherFailure = malformedToolCall('run_code', '{"code":"return 1"}}')
  otherFailure[otherFailure.length - 1] = {
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'another failure' } },
  }
  const second = malformedToolCall('run_code', '{"code":"return 2"}}', {
    index: 2, id: 'second-call',
  })
  const mixed = [...malformedToolCall('run_code', '{"code":"return 1"}}').slice(0, -1),
    ...second.slice(0, -1), INVALID_TOOL_JSON_FINISH]
  const endOnly = [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    {
      type: 'block-end', index: 1,
      block: {
        type: 'tool-call', id: 'end-only-call', name: 'run_code', arguments: '{bad json',
      },
    },
    INVALID_TOOL_JSON_FINISH,
  ]
  const blockEndOnly = endOnly.slice(1)
  const deltaOnly = malformedToolCall('run_code', '{bad json')
    .filter(chunk => chunk.type !== 'block-start')
  const deltaThenStart = malformedToolCall('run_code', '{bad json')
  deltaThenStart.splice(1, 0, deltaThenStart.shift())
  const optionalDeltaName = malformedToolCall('run_code', '{bad json')
  delete optionalDeltaName.find(chunk => chunk.type === 'tool-call-delta' && chunk.name).name

  for (const chunks of [
    schemaInvalid, parseInvalid, unknown, mixed, endOnly, blockEndOnly,
    deltaOnly, deltaThenStart, optionalDeltaName,
  ]) {
    const streamed = await collect(owner.stream(
      { sessionId: agent.id, signal, tools: projected.tools },
      async function* () { yield* chunks },
    ))
    assert.deepEqual(streamed.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
    assert.deepEqual(await collect(invariantCtx.waterfall(
      invariantCtx,
      'llm/stream',
      {},
      async function* () { yield* streamed },
    )), streamed)
    const assembler = new BlockAssembler()
    for (const chunk of streamed) assembler.push(chunk)
    assert.deepEqual(assembler.blocks().filter(block => block.type === 'tool-call'),
      chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
        .map(chunk => chunk.block))
  }

  const streamedOther = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () { yield* otherFailure },
  ))
  assert.deepEqual(streamedOther, otherFailure)

  const noLiveSchema = malformedToolCall('run_code', '{"code":"return 1"}}')
  const streamedWithoutSchema = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: [{ name: 'run_code' }] },
    async function* () { yield* noLiveSchema },
  ))
  const withoutSchemaAssembler = new BlockAssembler()
  for (const chunk of streamedWithoutSchema) withoutSchemaAssembler.push(chunk)
  assert.deepEqual(withoutSchemaAssembler.blocks(), [{
    type: 'tool-call', id: 'malformed-direct-call', name: 'run_code',
    arguments: '{"code":"return 1"}}',
  }])
  assert.deepEqual(streamedWithoutSchema.at(-1), {
    type: 'finish', reason: { kind: 'tool-calls' },
  })
})

test('turns unsafe malformed-response streams into one guaranteed rejected tool call', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-no-tool' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const invariantCtx = await invariantContext(t)
  const incomplete = malformedToolCall('run_code', '{bad json')
    .filter(chunk => chunk.type !== 'block-end')
  const invalidIdentity = malformedToolCall('run_code', '{bad json')
  invalidIdentity.find(chunk => chunk.type === 'block-end').block.id = ''
  const inconsistentIdentity = malformedToolCall('run_code', '{"code":"return 1"}}')
  inconsistentIdentity[2] = { ...inconsistentIdentity[2], id: 'different-call' }
  const duplicateStart = malformedToolCall('run_code', '{bad json')
  duplicateStart.splice(1, 0, { type: 'block-start', index: 1, blockType: 'tool-call' })
  const completeThenIncomplete = [
    ...malformedToolCall('run_code', '{bad json', { index: 0, id: 'complete' }).slice(0, -1),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 1, id: 'incomplete', name: 'edit_run_code',
      argumentsDelta: '{"edits":',
    },
    INVALID_TOOL_JSON_FINISH,
  ]
  const mismatchedDelta = [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'text-delta', index: 1, text: 'must not leak' },
    INVALID_TOOL_JSON_FINISH,
  ]
  const mismatchedEnd = [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    {
      type: 'block-end', index: 1,
      block: { type: 'text', text: 'must not leak' },
    },
    INVALID_TOOL_JSON_FINISH,
  ]
  const unknownChunk = malformedToolCall('run_code', '{"code":"must not execute"}')
  unknownChunk.splice(-1, 0, { type: 'provider-extension', value: 'unsafe' })
  const openReasoningThenTool = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'preserved reasoning' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 1, id: 'after-open-reasoning',
      name: 'run_code', argumentsDelta: '{"code":',
    },
    { type: 'reasoning-delta', index: 0, text: ' completed after tool start' },
    {
      type: 'block-end', index: 0,
      block: { type: 'reasoning', text: 'preserved reasoning completed after tool start' },
    },
    INVALID_TOOL_JSON_FINISH,
  ]
  const noToolBlock = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'broken tool input' },
    {
      type: 'block-end', index: 0,
      block: { type: 'reasoning', text: 'broken tool input' },
    },
    INVALID_TOOL_JSON_FINISH,
  ]

  for (const chunks of [
    incomplete, invalidIdentity, inconsistentIdentity, duplicateStart, completeThenIncomplete,
    mismatchedDelta, mismatchedEnd, unknownChunk, openReasoningThenTool, noToolBlock,
  ]) {
    const streamed = await collect(owner.stream(
      { sessionId: agent.id, signal, tools: projected.tools },
      async function* () { yield* chunks },
    ))
    const invariantChecked = await collect(invariantCtx.waterfall(
      invariantCtx,
      'llm/stream',
      {},
      async function* () { yield* streamed },
    ))
    assert.deepEqual(invariantChecked, streamed)
    assert.deepEqual(streamed.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
    const assembler = new BlockAssembler()
    for (const chunk of streamed) assembler.push(chunk)
    const calls = assembler.blocks().filter(block => block.type === 'tool-call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'run_code')
    assert.equal(calls[0].arguments, '{"dsh_ptc_plus_malformed_tool_json":')
    const parsedArguments = (() => {
      try { return JSON.parse(calls[0].arguments) } catch { return calls[0].arguments }
    })()
    const runCodeSchema = projected.tools.find(tool => tool.name === 'run_code').parameters
    assert.notEqual(validateJsonSchemaValue(runCodeSchema, parsedArguments).length, 0)
    assert.equal(streamed.some(chunk => chunk.type === 'tool-call-delta'
      && chunk.id === 'incomplete'), false)
    assert.equal(streamed.some(chunk => chunk.type === 'text-delta'), false)
    assert.equal(streamed.some(chunk => chunk.type === 'block-end'
      && chunk.block.type === 'text'), false)
  }
})

test('settles malformed tool JSON for a captured both-mode request', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'malformed-both-mode' }
  const signal = new AbortController().signal
  const broadAssembly = {
    ...assembly(),
    sections: [],
    tools: [
      ...assembly().tools,
      { name: 'read', parameters: { type: 'object', properties: {} } },
    ],
  }
  const projected = await owner.assemble(
    broadAssembly,
    { agent, signal },
    async () => broadAssembly,
  )
  const chunks = malformedToolCall('read', '{"path":}')
  const streamed = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () { yield* chunks },
  ))

  assert.deepEqual(streamed.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const assembler = new BlockAssembler()
  for (const chunk of streamed) assembler.push(chunk)
  assert.deepEqual(assembler.blocks(), [{
    type: 'tool-call', id: 'malformed-direct-call', name: 'read', arguments: '{"path":}',
  }])
})

test('preserves buffered direct chunks before propagating an upstream stream error', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'throwing-direct-stream' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const start = { type: 'block-start', index: 0, blockType: 'tool-call' }
  const stream = owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () {
      yield start
      throw new Error('upstream stream failed')
    },
  )[Symbol.asyncIterator]()

  assert.deepEqual(await stream.next(), { done: false, value: start })
  await assert.rejects(stream.next(), /upstream stream failed/)
})

test('settles a thrown invalid-tool-JSON provider failure without ending the turn', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'throwing-malformed-tool-stream' }
  const signal = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal }, async () => assembly())
  const streamed = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta', index: 0, id: 'truncated', name: 'edit_run_code',
        argumentsDelta: '{"edits":',
      }
      const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
      error.code = 'MALFORMED_RESPONSE'
      throw error
    },
  ))

  assert.deepEqual(streamed.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const assembler = new BlockAssembler()
  for (const chunk of streamed) assembler.push(chunk)
  assert.deepEqual(assembler.blocks().map(block => block.type), ['tool-call'])
  assert.equal(assembler.blocks()[0].name, 'run_code')
  assert.equal(assembler.blocks()[0].arguments, '{"dsh_ptc_plus_malformed_tool_json":')

  const repairableRaw = '{"code":"return 7"}}'
  const repaired = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () {
      yield* malformedToolCall('run_code', repairableRaw, {
        index: 2, id: 'thrown-repairable',
      }).slice(0, -1)
      const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
      error.code = 'MALFORMED_RESPONSE'
      throw error
    },
  ))
  assert.equal(repaired.find(chunk => chunk.type === 'block-end').block.arguments,
    repairableRaw.slice(0, -1))
  assert.deepEqual(repaired.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

  const noTool = await collect(owner.stream(
    { sessionId: agent.id, signal, tools: projected.tools },
    async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'reason before failure' }
      const error = new Error('DeepSeek Messages stream: tool input is invalid JSON')
      error.code = 'MALFORMED_RESPONSE'
      throw error
    },
  ))
  const invariantCtx = await invariantContext(t)
  assert.deepEqual(await collect(invariantCtx.waterfall(
    invariantCtx,
    'llm/stream',
    {},
    async function* () { yield* noTool },
  )), noTool)
  assert.deepEqual(noTool.slice(0, 3), [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'reason before failure' },
    {
      type: 'block-end', index: 0,
      block: { type: 'reasoning', text: 'reason before failure' },
    },
  ])
  assert.deepEqual(noTool.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('a captured call policy outranks the request policy resolved from the signal', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'pinned-call-session' }
  const signalA = new AbortController().signal
  const projected = await owner.assemble(assembly(), { agent, signal: signalA }, async () => assembly())
  assert.deepEqual(projected.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])

  const chunks = [
    { type: 'tool-call-delta', index: 0, id: 'pinned-call' },
    { type: 'block-end', block: { type: 'tool-call', id: 'pinned-call' } },
  ]
  const streamed = await collect(owner.stream(
    { sessionId: agent.id, signal: signalA, tools: projected.tools },
    async function* () { yield* chunks },
  ))
  assert.equal(streamed.length, chunks.length)

  owner.reconfigure({ ...CONFIG_DEFAULTS, autoDescribeRunCode: false })
  const signalB = new AbortController().signal
  await owner.assemble(assembly(), { agent, signal: signalB }, async () => assembly())

  const pinned = {
    name: 'run_code', callId: 'pinned-call', arguments: { code: 'return 1' }, agent, signal: signalB,
  }
  assert.equal(Object.hasOwn(owner.executionArguments(pinned), 'description'), true)

  const fresh = {
    name: 'run_code', callId: 'fresh-call', arguments: { code: 'return 2' }, agent, signal: signalB,
  }
  assert.equal(owner.executionArguments(fresh), fresh.arguments)
})

test('concurrent requests keep their own captured policy', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const agent = { id: 'concurrent-session' }
  const signalA = new AbortController().signal
  await owner.assemble(assembly(), { agent, signal: signalA }, async () => assembly())
  owner.reconfigure({ ...CONFIG_DEFAULTS, autoDescribeRunCode: false })
  const signalB = new AbortController().signal
  await owner.assemble(assembly(), { agent, signal: signalB }, async () => assembly())

  const withA = {
    name: 'run_code', callId: 'concurrent-a', arguments: { code: 'return 1' }, agent, signal: signalA,
  }
  const withB = {
    name: 'run_code', callId: 'concurrent-b', arguments: { code: 'return 2' }, agent, signal: signalB,
  }
  assert.equal(Object.hasOwn(owner.executionArguments(withA), 'description'), true)
  assert.equal(owner.executionArguments(withB), withB.arguments)
})

test('a missing signal falls back to the session request policy', async (t) => {
  const snapshot = createUserBindingsSnapshot({ entries: [] }, 1)
  const owner = createOwner({ userBindingsForAgent: async () => snapshot })
  t.after(() => owner.dispose())
  const agent = { id: 'no-signal-session' }
  await owner.assemble(assembly(), { agent }, async () => assembly())

  assert.equal(owner.executionUserBindings({ name: 'run_code', agent }), snapshot)
  assert.match(
    owner.executionRejection({ name: 'read', callId: 'no-signal-read', agent }).error.message,
    /not a direct PTC tool/,
  )
  assert.equal(owner.executionRejection({ name: 'run_code', callId: 'no-signal-run', agent }), undefined)
  assert.equal(
    owner.executionRejection({ name: 'read', callId: 'unknown-session-read', agent: { id: 'other' } }),
    undefined,
  )
})

test('each session resolves its own request policy', async (t) => {
  const bindings = new Map([
    ['session-one', createUserBindingsSnapshot({ entries: [] }, 1)],
    ['session-two', createUserBindingsSnapshot({ entries: [] }, 2)],
  ])
  const owner = createOwner({ userBindingsForAgent: async agent => bindings.get(agent.id) })
  t.after(() => owner.dispose())
  const first = { id: 'session-one' }
  const second = { id: 'session-two' }
  await owner.assemble(assembly(), { agent: first }, async () => assembly())
  await owner.assemble(assembly(), { agent: second }, async () => assembly())

  assert.equal(owner.executionUserBindings({ name: 'run_code', agent: first }), bindings.get('session-one'))
  assert.equal(owner.executionUserBindings({ name: 'run_code', agent: second }), bindings.get('session-two'))
  assert.equal(
    owner.executionUserBindings({ name: 'run_code', agent: { id: 'session-unknown' } }),
    undefined,
  )
})

test('argumentDiagnostic resolves the same policy for its context choice', async (t) => {
  const owner = createOwner()
  t.after(() => owner.dispose())
  const tolerant = { id: 'diagnostic-tolerant' }
  await owner.assemble(assembly(), { agent: tolerant }, async () => assembly())
  owner.reconfigure({ ...CONFIG_DEFAULTS, autoDescribeRunCode: false })
  const strict = { id: 'diagnostic-strict' }
  await owner.assemble(assembly(), { agent: strict }, async () => assembly())

  const result = { isError: true, error: { message: 'missing required property "description"' } }
  const tolerantResult = owner.argumentDiagnostic({
    name: 'run_code', callId: 'diagnostic-tolerant-call', arguments: { code: 'return 1', description: 5 }, agent: tolerant,
  }, result)
  assert.match(tolerantResult.additionalContexts[0].content[0].text, /nested native-tool argument/)

  const strictResult = owner.argumentDiagnostic({
    name: 'run_code', callId: 'diagnostic-strict-call', arguments: { code: 'return 1' }, agent: strict,
  }, result)
  assert.match(strictResult.additionalContexts[0].content[0].text, /outer transport arguments/)
})

test('argument diagnostics survive inbox persistence and complete session restoration', async (t) => {
  const owner = createOwner({ runtimeConfig: { ...CONFIG_DEFAULTS, autoDescribeRunCode: false } })
  t.after(() => owner.dispose())
  const agent = { id: 'diagnostic-persistence' }
  await owner.assemble(assembly(), { agent }, async () => assembly())
  const previous = createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this context.' }],
  })
  const session = Session.create(agent.id)
  const messages = []
  for (const [args, path, expected] of [
    [{ code: 'return 1' }, 'description', /outer transport arguments/],
    [{ code: 'return tools.read({})', description: 'Read' }, 'description', /nested native-tool argument/],
    [{ code: 'return tools.read({})', description: 'Read' }, 'options.description', /options\.description/],
  ]) {
    const result = { isError: true, error: { message: `missing required property "${path}"` }, additionalContexts: [previous] }
    const diagnosed = owner.argumentDiagnostic({ name: 'run_code', arguments: args, agent }, result)
    assert.equal(diagnosed.error, result.error)
    assert.deepEqual(result.additionalContexts, [previous])
    assert.equal(diagnosed.additionalContexts[0], previous)
    const message = diagnosed.additionalContexts[1]
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0)
    assert.deepEqual(message.source, {
      kind: 'plugin:ptc-plus', form: 'notice', summary: 'tools:ptc-plus-run-code-arguments',
    })
    assert.equal(message.content[0].type, 'text')
    assert.match(message.content[0].text, expected)
    messages.push(message)
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
  }
  assert.equal(new Set(messages.map(message => message.id)).size, messages.length)
  session.append('user/message', previous, { surfaceOp: 'append' })
  const header = sessionFormatCatalog.encodeCurrentHeader({ ...session.header, delegationDepth: 0 }, 0)
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'none', validation: 'current' })
  for (const event of sessionEvents(session)) {
    restore.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
  }
  assert.deepEqual(restore.finish().events, sessionEvents(session))
})
