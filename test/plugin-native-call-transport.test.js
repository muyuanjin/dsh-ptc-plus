import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from '../index.js'
import { CONFIG_DEFAULTS } from '../internal/config-spec.js'
import { createDirectSurfaceOwner } from '../internal/direct-surface-owner.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { projectSessionLog } from '../internal/session-log-view.js'
import { SessionRuntime } from '../internal/session-runtime.js'
import { decodeValue, encodeValue, renderValueWire } from '../internal/value-wire.js'
import { JOURNAL_POLICY, appendRunCodeEvents, fixture, ptcAgent } from './plugin-fixture.js'

test('canonicalizes proven native miscalls while declared edit calls keep their identity', async (t) => {
  const readSchema = {
    name: 'read',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  }
  const state = fixture({}, { scopedSchemas: [readSchema] })
  t.after(() => state.dispose())
  assert.equal(state.listeners.has('llm/stream'), true)
  assert.deepEqual(state.listenerOptions.get(state.listeners.get('llm/stream')[0]), { global: true })
  const sessionId = 'direct-call-session'
  const signal = new AbortController().signal
  const agent = ptcAgent('agent-id', { id: sessionId, events: [] })
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal },
  )
  assert.equal(state.ctx.tools.schemas().some(schema => schema.name === 'read'), false)
  assert.equal(state.ctx.tools.schemas(agent).some(schema => schema.name === 'read'), true)
  const nativeArguments = JSON.stringify({ file_path: 'README.md' })
  const source = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 0, id: 'native-call-id', name: 'read',
      argumentsDelta: nativeArguments,
    },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'native-call-id', name: 'read', arguments: nativeArguments },
    },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { opaque: true } },
  ]
  const transformed = await state.stream({
    sessionId, signal,
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
  }, source)
  const delta = transformed.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal(delta.name, 'run_code')
  const generated = JSON.parse(delta.argumentsDelta)
  assert.match(generated.code, /tools\.read\(/)
  assert.doesNotMatch(generated.code, /JSON\.parse|__ptcArgs/)
  assert.equal(generated.description, 'Call read inside the session REPL')

  const deepDepth = 1_500
  const deepArguments = `${'['.repeat(deepDepth)}"leaf"${']'.repeat(deepDepth)}`
  const deepSource = source.map(chunk => {
    if (chunk.type === 'tool-call-delta') {
      return { ...chunk, id: 'deep-native-call', argumentsDelta: deepArguments }
    }
    if (chunk.type === 'block-end') {
      return {
        ...chunk,
        block: { ...chunk.block, id: 'deep-native-call', arguments: deepArguments },
      }
    }
    return chunk
  })
  const deepTransport = await state.stream({
    sessionId, signal,
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
  }, deepSource)
  const deepCode = JSON.parse(
    deepTransport.find(chunk => chunk.type === 'tool-call-delta').argumentsDelta,
  ).code
  assert.match(deepCode, /tools\.read\(JSON\.parse\(/)
  const deepExecution = await state.executeRun(sessionId, deepCode, {
    read: async value => {
      let depth = 0
      while (Array.isArray(value)) {
        depth += 1
        value = value[0]
      }
      return { depth, leaf: value }
    },
  }, {})
  assert.deepEqual(deepExecution.raw, {
    logs: [],
    value: { depth: deepDepth, leaf: 'leaf' },
  })

  const persistedSession = { id: 'canonical-transparent-session', events: [] }
  const persisted = await state.executeRun(persistedSession.id, 'return 1', {}, { session: persistedSession })
  persistedSession.events.push(
    { seq: 10, type: 'turn/start', data: {} },
    { seq: 11, type: 'tool/call', data: { name: 'run_code', callId: 'native-call-id', arguments: delta.argumentsDelta } },
    { seq: 12, type: 'tool/result', sourceEventSeqs: [11], data: { message: { source: { callId: 'native-call-id' } }, meta: persisted.result.meta } },
  )
  const projected = projectSessionLog({ session: persistedSession })
  assert.equal(projected.latestRun.callSeq, 11)
  assert.equal(projected.latestRun.args.code, generated.code)
  assert.ok(projected.latestRun.source.includes(nativeArguments))

  const qualifiedSource = source.map(chunk => {
    if (chunk.type === 'tool-call-delta') return { ...chunk, name: 'tools.read' }
    if (chunk.type === 'block-end') {
      return { ...chunk, block: { ...chunk.block, name: 'tools.read' } }
    }
    return chunk
  })
  const qualified = await state.stream({
    sessionId, signal,
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
  }, qualifiedSource)
  const qualifiedDelta = qualified.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal(qualifiedDelta.id, 'native-call-id')
  assert.equal(qualifiedDelta.name, 'run_code')
  const qualifiedArguments = JSON.parse(qualifiedDelta.argumentsDelta)
  assert.match(qualifiedArguments.code, /tools\.read\(/)
  assert.ok(qualifiedArguments.code.includes(nativeArguments))

  const parallelSource = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 0, id: 'bare-parallel-id', name: 'read',
      argumentsDelta: nativeArguments,
    },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 1, id: 'qualified-parallel-id', name: 'tools.read',
      argumentsDelta: nativeArguments,
    },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'bare-parallel-id', name: 'read', arguments: nativeArguments },
    },
    {
      type: 'block-end', index: 1,
      block: { type: 'tool-call', id: 'qualified-parallel-id', name: 'tools.read', arguments: nativeArguments },
    },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { opaque: true } },
  ]
  const parallel = await state.stream({
    sessionId, signal,
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
  }, parallelSource)
  const parallelDeltas = parallel.filter(chunk => chunk.type === 'tool-call-delta')
  assert.deepEqual(parallelDeltas.map(chunk => [chunk.id, chunk.name]), [
    ['bare-parallel-id', 'run_code'],
    ['qualified-parallel-id', 'run_code'],
  ])
  for (const deltaChunk of parallelDeltas) {
    const argumentsValue = JSON.parse(deltaChunk.argumentsDelta)
    assert.match(argumentsValue.code, /tools\.read\(/)
    assert.ok(argumentsValue.code.includes(nativeArguments))
  }

  const editSource = source.map(chunk => {
    if (chunk.type === 'tool-call-delta') {
      return { ...chunk, id: 'edit-id', name: 'edit_run_code', argumentsDelta: '{"edits":[]}' }
    }
    if (chunk.type === 'block-end') {
      return { ...chunk, block: { type: 'tool-call', id: 'edit-id', name: 'edit_run_code', arguments: '{"edits":[]}' } }
    }
    return chunk
  })
  assert.deepEqual(await state.stream({
    sessionId, signal, tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
  }, editSource), editSource)
  assert.deepEqual(await state.stream({
    sessionId: 'different-session', signal,
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
  }, source), source)

  const execute = state.listeners.get('tools/execute')[0]
  for (const name of ['code', 'run', 'mystery']) {
    const rejected = await execute({ name, callId: `${name}-id`, arguments: { code: 'return 1' }, agent }, async () => ({ value: 'must not run' }))
    assert.equal(rejected.isError, true)
    assert.match(rejected.error.message, /not a direct PTC tool/)
    assert.equal(rejected.content.length, 1)
    assert.match(rejected.content[0].text, /not a direct PTC tool/)
    assert.match(rejected.content[0].text, new RegExp(`use run_code or edit_run_code`))
  }
  let nestedEditDispatched = false
  const nestedEdit = await execute({ name: 'edit_run_code', parent: { name: 'run_code' }, agent }, async () => {
    nestedEditDispatched = true
    return { value: 'must not run' }
  })
  assert.equal(nestedEdit.isError, true)
  assert.equal(nestedEditDispatched, false)
  assert.match(nestedEdit.content[0].text, /edit_run_code is only callable directly/)
  assert.deepEqual(await execute({ name: 'read', parent: {}, agent }, async () => ({ value: 'nested' })), {
    value: 'nested',
  })
})

test('keeps run_code description strict by default and derives valid execution arguments when enabled', async (t) => {
  const session = { id: 'description-policy-session', events: [] }
  let validatedArguments
  const strictRunCode = defineTool({
    name: 'run_code',
    description: 'Execute one standalone program.',
    parameters: {
      code: { type: 'string', required: true },
      description: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'integer' },
      render: () => [],
    },
    async execute(args) {
      validatedArguments = args
      return args.code.length
    },
  })
  for (const enabled of [false, true]) {
    const state = fixture({ autoDescribeRunCode: enabled })
    state.runCodeDefinition.execute = strictRunCode.execute
    const agent = ptcAgent(`description-policy-agent-${enabled}`, session)
    const signal = new AbortController().signal
    const assembly = {
      sections: [{ name: 'tools:code-only', text: 'code-only' }],
      contexts: [], variables: {}, tools: [state.runCodeDefinition],
    }
    const projected = await state.assemble(assembly, { agent, scope: agent, signal })
    const runSchema = projected.tools.find(tool => tool.name === 'run_code')
    assert.equal(runSchema.parameters.required.includes('description'), !enabled)
    const execute = state.listeners.get('tools/execute')[0]
    const exec = {
      name: 'run_code', callId: `missing-description-${enabled}`,
      arguments: { code: 'return tools.read({ description: "inner" })' }, agent, signal,
    }
    const originalArguments = exec.arguments
    validatedArguments = undefined
    const result = await execute(exec, async () => {
      assert.equal(exec.arguments, originalArguments)
      assert.equal(Object.hasOwn(exec.arguments, 'description'), false)
      try {
        const value = await state.runCodeDefinition.execute(exec.arguments)
        return { isError: false, value }
      } catch (error) {
        return {
          isError: true,
          error: { message: error.message },
          content: [{ type: 'text', text: `Error: ${error.message}` }],
        }
      }
    })
    assert.equal(exec.arguments, originalArguments)
    assert.equal(Object.hasOwn(exec.arguments, 'description'), false)
    assert.equal(exec.arguments.code, 'return tools.read({ description: "inner" })')
    assert.equal(result.isError, !enabled)
    assert.deepEqual(
      validatedArguments,
      enabled
        ? {
            code: originalArguments.code,
            description: 'Execute the next TypeScript cell in this session',
          }
        : undefined,
    )
    assert.equal(
      result.meta?.dshPtcPlusRunCodeDescription,
      enabled ? 'Execute the next TypeScript cell in this session' : undefined,
    )
    if (!enabled) {
      assert.match(result.additionalContexts?.[0]?.text ?? '', /outer transport arguments.*nested inside a native-tool argument/)
    }
    await state.dispose()
    assert.equal(state.runCodeDefinition.execute, strictRunCode.execute)
  }
})

test('keeps generated run_code summaries in the supported success presentation projection', async (t) => {
  const state = fixture({ autoDescribeRunCode: true })
  t.after(() => state.dispose())
  const session = { id: 'generated-description-success-session', events: [] }
  const agent = ptcAgent('generated-description-success-agent', session)
  const signal = new AbortController().signal
  await state.assemble({
    sections: [{ name: 'tools:code-only', text: 'code-only' }],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }, { agent, scope: agent, signal })
  const execute = state.listeners.get('tools/execute')[0]
  const exec = {
    name: 'run_code', callId: 'generated-description-success-call',
    arguments: { code: 'return 1' }, agent, signal,
  }
  const result = await execute(exec, async () => ({ isError: false, value: 1 }))
  assert.equal(
    result.meta.dshPtcPlusRunCodeDescription,
    'Execute the next TypeScript cell in this session',
  )
  const persistedMeta = state.runCodeDefinition.output.presentationMeta(exec.arguments, 1)
  assert.equal(
    persistedMeta.dshPtcPlusRunCodeDescription,
    'Execute the next TypeScript cell in this session',
  )
})

test('annotates generated descriptions and nested missing-description paths', async (t) => {
  const state = fixture({ autoDescribeRunCode: true })
  t.after(() => state.dispose())
  const session = { id: 'generated-description-meta-session', events: [] }
  const agent = ptcAgent('generated-description-meta-agent', session)
  const signal = new AbortController().signal
  await state.assemble({
    sections: [{ name: 'tools:code-only', text: 'code-only' }],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }, { agent, scope: agent, signal })
  const execute = state.listeners.get('tools/execute')[0]
  const result = await execute({
    name: 'run_code', callId: 'generated-description-meta-call',
    arguments: { code: 'return 1' }, agent, signal,
  }, async () => ({
    isError: true,
    error: {
      message: 'missing required property "options.command"; missing required property "options.description"',
    },
  }))
  assert.equal(result.meta.dshPtcPlusRunCodeDescription, 'Execute the next TypeScript cell in this session')
  assert.match(result.additionalContexts[0].text, /options\.description/)
})

test('pins auto-description behavior to the request assembly despite live setting changes', async (t) => {
  const assembly = {
    sections: [{ name: 'tools:code-only', text: 'code-only' }],
    contexts: [], variables: {}, tools: [{
      name: 'run_code',
      description: 'Execute one standalone program.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['code', 'description'],
      },
    }],
  }
  for (const initiallyEnabled of [true, false]) {
    const runtimeConfig = { ...CONFIG_DEFAULTS, autoDescribeRunCode: initiallyEnabled }
    const owner = createDirectSurfaceOwner({
      editTransport: {
        isInstalled: () => true,
        ensureInstalled() {},
      },
      runtimeConfig,
      canonicalizeToolCalls: false,
      sessionId: agent => agent.id,
      toolSchemasForAgent: () => [],
    })
    t.after(() => owner.dispose())
    const agent = { id: `description-race-${initiallyEnabled}` }
    const signal = new AbortController().signal
    const projected = await owner.assemble(assembly, { agent, signal }, async () => assembly)
    assert.equal(
      projected.tools[0].parameters.required.includes('description'),
      !initiallyEnabled,
    )

    owner.reconfigure({ ...runtimeConfig, autoDescribeRunCode: !initiallyEnabled })
    const exec = {
      name: 'run_code',
      callId: `description-race-call-${initiallyEnabled}`,
      arguments: { code: 'return 1' },
      agent,
      signal,
    }
    const originalArguments = exec.arguments
    owner.executionRejection(exec)
    const executionArguments = owner.executionArguments(exec)
    assert.equal(exec.arguments, originalArguments)
    assert.equal(Object.hasOwn(exec.arguments, 'description'), false)
    assert.equal(
      executionArguments.description,
      initiallyEnabled ? 'Execute the next TypeScript cell in this session' : undefined,
    )
    const result = owner.argumentDiagnostic(exec, { isError: false })
    assert.equal(
      result.meta?.dshPtcPlusRunCodeDescription,
      initiallyEnabled ? 'Execute the next TypeScript cell in this session' : undefined,
    )

    const explicitArguments = { code: 'return 2', description: 'Keep this summary' }
    const explicitExec = { ...exec, arguments: explicitArguments }
    assert.equal(owner.executionArguments(explicitExec), explicitArguments)
    assert.equal(explicitExec.arguments, explicitArguments)
  }
})

test('rejects a later native assembly without changing the captured code request', async (t) => {
  const readSchema = {
    name: 'read',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
  }
  const state = fixture({}, { scopedSchemas: [readSchema] })
  t.after(() => state.dispose())
  const session = { id: 'scope-change-session', events: [] }
  const agent = ptcAgent('scope-change-agent', session)
  const codeSignal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: codeSignal },
  )

  const nativeAssembly = {
    sections: [], contexts: [], variables: {}, tools: [readSchema],
  }
  const nativeSignal = new AbortController().signal
  await assert.rejects(state.assemble(nativeAssembly, {
    agent, scope: agent, signal: nativeSignal,
  }), /ptc agent composition assembled without run_code/)

  const execute = state.listeners.get('tools/execute')[0]
  let dispatched = false
  const direct = await execute({ name: 'read', callId: 'scope-change-read', agent }, async () => {
    dispatched = true
    return { value: 'native' }
  })
  assert.equal(direct.isError, true)
  assert.equal(dispatched, false)

  const source = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 0, id: 'request-bound-signal', name: 'read',
      argumentsDelta: '{"file_path":"README.md"}',
    },
    {
      type: 'block-end', index: 0,
      block: {
        type: 'tool-call', id: 'request-bound-signal', name: 'read',
        arguments: '{"file_path":"README.md"}',
      },
    },
  ]
  const codeRequest = await state.stream({
    sessionId: session.id, signal: codeSignal, tools: [{ name: 'run_code' }],
  }, source)
  assert.equal(codeRequest.find(chunk => chunk.type === 'tool-call-delta').name, 'run_code')
})

test('keeps native tools inside run_code after a later broader assembly', async (t) => {
  const readSchema = {
    name: 'read',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
  }
  const state = fixture({}, { scopedSchemas: [readSchema] })
  t.after(() => state.dispose())
  const session = { id: 'code-only-to-broader-session', events: [] }
  const agent = ptcAgent('code-only-to-broader-agent', session)

  const codeSignal = new AbortController().signal
  await state.assemble(
    { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
    { agent, scope: agent, signal: codeSignal },
  )
  assert.equal(agent.ctx.tools.get('edit_run_code') !== undefined, true)

  const mixedAssembly = {
    sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition, readSchema],
  }
  const broadSignal = new AbortController().signal
  const mixed = await state.assemble(mixedAssembly, {
    agent, scope: agent, signal: broadSignal,
  })
  assert.deepEqual(mixed.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.equal(agent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  const edit = await state.ctx.tools.execute({
    name: 'edit_run_code', callId: 'active-code-only-edit', arguments: { edits: [] },
    agent, signal: codeSignal,
  })
  assert.equal(edit.isError, false)
  assert.equal(edit.value.edited, false)
  assert.match(edit.value.reason, /no run_code cell/)

  const broadEdit = await state.ctx.tools.execute({
    name: 'edit_run_code', callId: 'mixed-request-edit', arguments: { edits: [] },
    agent, signal: broadSignal,
  })
  assert.equal(broadEdit.isError, false)
  assert.equal(broadEdit.value.edited, false)

  const execute = state.listeners.get('tools/execute')[0]
  let dispatched = false
  const native = await execute({
    name: 'read', callId: 'new-direct-read', agent, signal: broadSignal,
  }, async () => {
    dispatched = true
    return { value: 'native' }
  })
  assert.equal(native.isError, true)
  assert.equal(dispatched, false)
  assert.match(native.error.message, /not a direct PTC tool/)
})

test('preserves both as a distinct PTC presentation across native capability views', async (t) => {
  const readSchema = {
    name: 'read',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
  }
  for (const { id, nativeSchemas } of [
    { id: 'restricted', nativeSchemas: [] },
    { id: 'native', nativeSchemas: [readSchema] },
  ]) {
    const state = fixture({}, { scopedSchemas: nativeSchemas })
    t.after(() => state.dispose())
    const session = { id: `both-mode-${id}-session`, events: [{ type: 'turn/start' }] }
    const agent = ptcAgent(`both-mode-${id}-agent`, session)
    const code = `export const ${id}Value = 1\nreturn ${id}Value`
    const run = await state.runDurable(session.id, code, {}, { session })
    assert.equal(run.isError, false)
    appendRunCodeEvents(session.events, `both-mode-${id}-run`, code, run)
    const signal = new AbortController().signal
    const assembly = {
      sections: [
        { name: 'tools:ptc-only', text: '' },
        { name: 'tools:sdk', text: 'declare const tools: unknown' },
      ],
      contexts: [], variables: {}, tools: [state.runCodeDefinition, ...nativeSchemas],
    }
    const projected = await state.assemble(assembly, { agent, scope: agent, signal })
    assert.deepEqual(projected.tools.map(tool => tool.name), ['run_code', ...nativeSchemas.map(tool => tool.name)])
    assert.equal(projected.sections.find(section => section.name === 'tools:ptc-only').text, '')
    assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
    const repeated = await state.assemble(assembly, {
      agent, scope: agent, signal: new AbortController().signal,
    })
    assert.deepEqual(repeated.tools, projected.tools)
    assert.equal(agent.ctx.tools.get('edit_run_code'), undefined)
    const sdk = projected.sections.find(section => section.name === 'tools:sdk').text
    assert.match(sdk, /^declare const tools: unknown/)
    assert.match(sdk, /declare const capabilities:/)
    assert.equal(
      projected.contexts.some(context => context.name === 'tools:ptc-plus-rewrite-info'),
      false,
    )

    const callId = `both-mode-${id}-read`
    const source = [
      {
        type: 'tool-call-delta', index: 0, id: callId, name: 'read',
        argumentsDelta: '{"file_path":"README.md"}',
      },
      {
        type: 'block-end', index: 0,
        block: {
          type: 'tool-call', id: callId, name: 'read',
          arguments: '{"file_path":"README.md"}',
        },
      },
    ]
    assert.deepEqual(await state.stream({
      sessionId: session.id, signal, tools: projected.tools,
    }, source), source)

    if (nativeSchemas.length > 0) {
      let dispatched = false
      const result = await state.listeners.get('tools/execute')[0]({
        name: 'read', callId, agent, signal,
      }, async () => {
        dispatched = true
        return { value: 'native' }
      })
      assert.deepEqual(result, { value: 'native' })
      assert.equal(dispatched, true)
    }
  }
})

test('prefers the current PTC collapse section when both generations are present', async (t) => {
  const readSchema = { name: 'read', parameters: { type: 'object', properties: {} } }
  for (const { id, currentText, legacyText, expectedTools } of [
    {
      id: 'current-both', currentText: '', legacyText: 'legacy PTC-only guidance',
      expectedTools: ['run_code', 'read'],
    },
    {
      id: 'current-ptc', currentText: 'current PTC-only guidance', legacyText: '',
      expectedTools: ['run_code', 'edit_run_code'],
    },
  ]) {
    const state = fixture({}, { scopedSchemas: [readSchema] })
    t.after(() => state.dispose())
    const session = { id: `${id}-session`, events: [] }
    const agent = ptcAgent(`${id}-agent`, session)
    const assembly = {
      sections: [
        { name: 'tools:code-only', text: legacyText },
        { name: 'tools:ptc-only', text: currentText },
      ],
      contexts: [], variables: {}, tools: [state.runCodeDefinition, readSchema],
    }
    const projected = await state.assemble(assembly, { agent, scope: agent })
    assert.deepEqual(projected.tools.map(tool => tool.name), expectedTools)
    assert.equal(
      projected.sections.find(section => section.name === 'tools:code-only').text,
      legacyText,
    )
    assert.equal(
      projected.sections.find(section => section.name === 'tools:ptc-only').text,
      currentText === ''
        ? ''
        : '`run_code` and `edit_run_code` are the only tools callable directly. Call every native tool declared by the SDK from inside a program.',
    )
  }
})

test('preserves code-only projection after edit registration expands the base schemas', async (t) => {
  const readSchema = { name: 'read', parameters: { type: 'object', properties: {} } }
  const state = fixture({}, { scopedSchemas: [readSchema] })
  t.after(() => state.dispose())
  const session = { id: 'registered-code-only-session', events: [] }
  const agent = ptcAgent('registered-code-only-agent', session)
  const signal = new AbortController().signal
  const initial = {
    sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  await state.assemble(initial, { agent, scope: agent, signal })

  const expanded = {
    sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
    contexts: [], variables: {},
    tools: [state.runCodeDefinition, agent.ctx.tools.get('edit_run_code'), readSchema],
  }
  const projected = await state.assemble(expanded, { agent, scope: agent, signal })
  assert.deepEqual(projected.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.equal(projected.sections.find(section => section.name === 'tools:code-only').text,
    '`run_code` and `edit_run_code` are the only tools callable directly. Call every native tool declared by the SDK from inside a program.')
})

test('binds execution policy to call identity when dispatch replaces the request signal', async (t) => {
  const readSchema = { name: 'read', parameters: { type: 'object', properties: {} } }
  const state = fixture({ canonicalizeToolCalls: false }, { scopedSchemas: [readSchema] })
  t.after(() => state.dispose())
  const session = { id: 'replaced-signal-session', events: [] }
  const agent = ptcAgent('replaced-signal-agent', session)
  const signal = new AbortController().signal
  const assembly = {
    sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  const projected = await state.assemble(assembly, { agent, scope: agent, signal })
  const streamOptions = { sessionId: session.id, signal, tools: projected.tools }
  const toolCall = (id, name, argumentsValue) => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsValue },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id, name, arguments: argumentsValue },
    },
  ]
  const editSource = toolCall('replaced-signal-edit', 'edit_run_code', '{"edits":[]}')
  const nativeSource = toolCall('replaced-signal-read', 'read', '{}')
  assert.deepEqual(await state.stream(streamOptions, editSource), editSource)
  assert.deepEqual(await state.stream(streamOptions, nativeSource), nativeSource)

  const replacementSignal = new AbortController().signal
  const edit = await state.ctx.tools.execute({
    name: 'edit_run_code', callId: 'replaced-signal-edit', arguments: { edits: [] },
    agent, signal: replacementSignal,
  })
  assert.equal(edit.isError, false)
  assert.equal(edit.value.edited, false)

  const retired = await state.listeners.get('tools/execute')[0]({
    name: 'edit_run_code', callId: 'replaced-signal-edit', arguments: { edits: [] },
    agent, signal: replacementSignal,
  }, async () => ({ value: 'must not run' }))
  assert.equal(retired.isError, true)

  const execute = state.listeners.get('tools/execute')[0]
  let dispatched = false
  const native = await execute({
    name: 'read', callId: 'replaced-signal-read', agent, signal: replacementSignal,
  }, async () => {
    dispatched = true
    return { value: 'must not run' }
  })
  assert.equal(native.isError, true)
  assert.equal(dispatched, false)
  assert.match(native.error.message, /not a direct PTC tool/)
})

test('does not publish execution policy for an interrupted partial tool call', async (t) => {
  const state = fixture({ canonicalizeToolCalls: false })
  t.after(() => state.dispose())
  const session = { id: 'interrupted-call-session', events: [] }
  const agent = ptcAgent('interrupted-call-agent', session)
  const signal = new AbortController().signal
  await state.assemble(
    {
      sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
      contexts: [], variables: {}, tools: [state.runCodeDefinition],
    },
    { agent, scope: agent, signal },
  )

  const source = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta', index: 0, id: 'interrupted-edit', name: 'edit_run_code',
      argumentsDelta: '{"edits":',
    }
  }
  const stream = state.listeners.get('llm/stream')[0]({
    sessionId: session.id,
    signal,
    tools: [{ name: 'run_code' }, { name: 'edit_run_code' }],
  }, source)
  for await (const chunk of stream) {
    if (chunk.type === 'tool-call-delta') break
  }

  let dispatched = false
  const result = await state.listeners.get('tools/execute')[0]({
    name: 'edit_run_code', callId: 'interrupted-edit', arguments: { edits: [] },
    agent, signal: new AbortController().signal,
  }, async () => {
    dispatched = true
    return { value: 'must not run' }
  })
  assert.equal(result.isError, true)
  assert.equal(dispatched, false)
  assert.match(result.error.message, /not declared for this request/)
})

test('keeps one code composition across both overlapping assembly completion orders', async (t) => {
  const readSchema = { name: 'read', parameters: { type: 'object', properties: {} } }
  const state = fixture({}, { scopedSchemas: [readSchema] })
  t.after(() => state.dispose())

  for (const codeCompletesFirst of [true, false]) {
    const suffix = codeCompletesFirst ? 'code-first' : 'broad-first'
    const session = { id: `overlap-${suffix}`, events: [] }
    const agent = ptcAgent(`overlap-${suffix}`, session)
    const codeSignal = new AbortController().signal
    const broadSignal = new AbortController().signal
    let finishCode
    let finishBroad
    const codeNext = new Promise(resolve => { finishCode = resolve })
    const broadNext = new Promise(resolve => { finishBroad = resolve })
    const codeInput = {
      sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition],
    }
    const code = state.assemble(codeInput, { agent, scope: agent, signal: codeSignal }, () => codeNext)
    const broadInput = {
      sections: [], contexts: [], variables: {},
      tools: [state.runCodeDefinition, agent.ctx.tools.get('edit_run_code'), readSchema],
    }
    const broad = state.assemble(broadInput, {
      agent, scope: agent, signal: broadSignal,
    }, () => broadNext)

    if (codeCompletesFirst) {
      finishCode(codeInput)
      assert.deepEqual((await code).tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
      finishBroad(broadInput)
      assert.deepEqual((await broad).tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
    } else {
      finishBroad(broadInput)
      assert.deepEqual((await broad).tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
      finishCode(codeInput)
      assert.deepEqual((await code).tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
    }

    const edit = await state.ctx.tools.execute({
      name: 'edit_run_code', callId: `overlap-edit-${suffix}`, arguments: { edits: [] },
      agent, signal: codeSignal,
    })
    assert.equal(edit.isError, false)
    assert.equal(edit.value.edited, false)
    const broadEdit = await state.ctx.tools.execute({
      name: 'edit_run_code', callId: `overlap-broad-edit-${suffix}`, arguments: { edits: [] },
      agent, signal: broadSignal,
    })
    assert.equal(broadEdit.isError, false)
    assert.equal(broadEdit.value.edited, false)
    assert.equal(agent.registration.disposals, 0)
    await state.emit('agent/disposed', { agent })
    assert.equal(agent.registration.disposals, 1)
    assert.equal(agent.presentation.disposals, 1)
  }
})

test('keeps the first captured composition when an earlier inconclusive assembly resumes', async (t) => {
  const readSchema = { name: 'read', parameters: { type: 'object', properties: {} } }
  const state = fixture({}, { scopedSchemas: [readSchema] })
  t.after(() => state.dispose())
  const session = { id: 'overlap-inconclusive', events: [] }
  const agent = ptcAgent('overlap-inconclusive', session)
  let finishMixed
  const mixedResult = {
    sections: [], contexts: [], variables: {},
    tools: [state.runCodeDefinition, readSchema],
  }
  const mixed = state.assemble(mixedResult, { agent, scope: agent }, () => (
    new Promise(resolve => { finishMixed = () => resolve(mixedResult) })
  ))

  const codeInput = {
    sections: [{ name: 'tools:code-only', text: 'upstream code-only guidance' }],
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
  }
  const code = await state.assemble(codeInput, { agent, scope: agent })
  assert.deepEqual(code.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])

  finishMixed()
  assert.deepEqual((await mixed).tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  const repeated = await state.assemble(mixedResult, { agent, scope: agent })
  assert.deepEqual(repeated.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
})

test('invalidates request-bound direct policy when its owner is disposed', async () => {
  const readSchema = { name: 'read', parameters: { type: 'object', properties: {} } }
  const source = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 0, id: 'disposed-read', name: 'read',
      argumentsDelta: '{}',
    },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'disposed-read', name: 'read', arguments: '{}' },
    },
  ]

  for (const disposal of ['agent', 'session', 'plugin']) {
    const state = fixture({}, { scopedSchemas: [readSchema] })
    const session = { id: `disposed-${disposal}`, events: [] }
    const agent = ptcAgent(`disposed-${disposal}`, session)
    const signal = new AbortController().signal
    await state.assemble(
      { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] },
      { agent, scope: agent, signal },
    )
    const streamOptions = { sessionId: session.id, signal, tools: [{ name: 'run_code' }] }
    assert.equal((await state.stream(streamOptions, source))[1].name, 'run_code')
    const execute = state.listeners.get('tools/execute')[0]
    const stream = state.listeners.get('llm/stream')[0]

    if (disposal === 'agent') await state.emit('agent/disposed', { agent })
    else if (disposal === 'session') await state.emit('session/disposed', session)
    else await state.dispose()

    const staleStream = async function* () { yield* source }
    const streamed = []
    for await (const chunk of stream(streamOptions, staleStream)) streamed.push(chunk)
    assert.deepEqual(streamed, source)
    let dispatched = false
    const edit = await execute({
      name: 'edit_run_code', callId: `disposed-edit-${disposal}`, arguments: { edits: [] },
      agent, signal,
    }, async () => {
      dispatched = true
      return { value: 'must not run' }
    })
    assert.equal(edit.isError, true)
    assert.equal(dispatched, false)
    if (disposal !== 'plugin') await state.dispose()
  }
})

test('keeps unrelated model streams byte-stable', async (t) => {
  const state = fixture({}, { schemas: [{ name: 'read' }] })
  t.after(() => state.dispose())
  const sessionId = 'canonical-disabled'
  const signal = new AbortController().signal
  const assembly = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  await state.assemble(assembly, { scope: {}, signal })
  const source = [
    {
      type: 'tool-call-delta', index: 0, id: 'read-id', name: 'read',
      argumentsDelta: '{"file_path":"README.md"}',
    },
  ]
  assert.deepEqual(await state.stream({ sessionId, signal, tools: [{ name: 'run_code' }] }, source), source)
  assert.deepEqual(await state.stream({ tools: [{ name: 'run_code' }] }, source), source)

})

test('keeps section rendering pure and retains per-agent edit ownership after assembly', async (t) => {
  const read = { name: 'read', parameters: { type: 'object', properties: {} } }
  const state = fixture({}, { schemas: [read] })
  t.after(() => state.dispose())
  const section = state.sections.find(entry => entry.name === 'tools:ptc-plus-repl')
  const mixedAgent = ptcAgent('render-before-mixed', { id: 'render-before-mixed', events: [] })
  mixedAgent.ctx.tools.bindFixtureRegistry(
    name => state.ctx.tools.get(name),
    () => state.ctx.tools.schemas(),
  )

  assert.match(section.text({ scope: mixedAgent, agent: mixedAgent }), /persistent PTC REPL/)
  assert.deepEqual(mixedAgent.registration.calls, [])
  const mixedAssembly = {
    sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition, read],
  }
  const mixedResult = await state.assemble(mixedAssembly, {
    agent: mixedAgent, scope: mixedAgent,
  })
  assert.deepEqual(mixedResult.tools.map(tool => tool.name), ['run_code', 'read'])
  assert.equal(mixedAgent.ctx.tools.get('edit_run_code'), undefined)

  const provisionalAgent = ptcAgent('provisional-mixed', { id: 'provisional-mixed', events: [] })
  const initial = { sections: [], contexts: [], variables: {}, tools: [state.runCodeDefinition] }
  const final = { ...initial, tools: [state.runCodeDefinition, read] }
  const provisionalResult = await state.assemble(initial, {
    agent: provisionalAgent, scope: provisionalAgent,
  }, async () => final)
  assert.deepEqual(provisionalResult.tools.map(tool => tool.name), ['run_code', 'edit_run_code'])
  assert.deepEqual(provisionalAgent.registration.calls, ['edit_run_code'])
  assert.equal(provisionalAgent.registration.disposals, 0)
  assert.equal(provisionalAgent.presentation.disposals, 0)
  assert.equal(provisionalAgent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  const failingAgent = ptcAgent('provisional-error', { id: 'provisional-error', events: [] })
  await assert.rejects(state.assemble(initial, {
    agent: failingAgent, scope: failingAgent,
  }, async () => {
    throw new Error('assembly failed')
  }), /assembly failed/)
  assert.equal(failingAgent.registration.disposals, 0)
  assert.equal(failingAgent.presentation.disposals, 0)
  assert.equal(failingAgent.ctx.tools.get('edit_run_code')?.name, 'edit_run_code')

  await state.emit('agent/disposed', { agent: provisionalAgent })
  await state.emit('agent/disposed', { agent: failingAgent })
  assert.equal(provisionalAgent.registration.disposals, 1)
  assert.equal(failingAgent.registration.disposals, 1)
})

test('preserves native tool guidance while adding only the capability explorer declaration', async (t) => {
  const state = fixture({}, {
    schemas: [
      {
        name: 'read',
        description: 'Native read.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string' },
            offset: { type: 'integer' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'echo',
        description: 'Echo.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
      {
        name: 'glob',
        description: 'Find files by path pattern.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, path: { type: 'string' } },
          required: ['pattern'],
        },
      },
      { name: 'get_goal', parameters: { type: 'object', properties: {} } },
      {
        name: 'update_goal',
        parameters: {
          type: 'object',
          properties: { goal_id: { type: 'string', description: 'Exact id returned by get_goal.' } },
          required: ['goal_id'],
        },
      },
      { name: 'job_output', parameters: { type: 'object', properties: { job_id: { type: 'string' } } } },
    ],
  })
  t.after(() => state.dispose())
  const assembly = {
    sections: [
      { name: 'tools:code-only', text: 'Only run_code is direct.' },
      { name: 'tool:read', text: 'Use the read tool.' },
      { name: 'tool:echo', text: 'Use the echo tool.' },
      {
        name: 'tool:glob',
        text: 'Use the glob tool — not shell find — to discover files. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level.',
      },
      {
        name: 'rules',
        text: 'Use the read tool when inspecting files. Call get_goal before update_goal. Collect with job_output. Use goal tools for long-running work.\nKeep this rule.',
      },
      { name: 'tools:sdk', text: 'declare const tools: unknown' },
    ],
    contexts: [],
    variables: {},
    tools: [state.runCodeDefinition],
  }
  const adapted = await state.assemble(assembly, { scope: { id: 'code-only-scope' } })
  assert.deepEqual(adapted.tools.map(tool => tool.name), ['run_code'])
  assert.equal(adapted.sections.find(section => section.name === 'tool:read').text, 'Use the read tool.')
  assert.equal(adapted.sections.find(section => section.name === 'tool:echo').text, 'Use the echo tool.')
  assert.match(adapted.sections.find(section => section.name === 'tool:glob').text, /Use the glob tool.*not shell find/)
  const rules = adapted.sections.find(section => section.name === 'rules').text
  assert.equal(rules, assembly.sections.find(section => section.name === 'rules').text)
  const sdk = adapted.sections.find(section => section.name === 'tools:sdk').text
  assert.match(sdk, /^declare const tools: unknown/)
  assert.match(sdk, /declare const capabilities:/)
  assert.doesNotMatch(sdk, /declare const repl:|declare const code:/)
  assert.doesNotMatch(sdk, /`tools\.read`|bounded inspection API/)
  assert.doesNotMatch(sdk, /declare const workspace:|declare const host:|HostCapabilityArgs/)
})

test('does not reinterpret owner-provided native tool guidance', async (t) => {
  const state = fixture({}, { schemas: [{ name: 'glob' }] })
  t.after(() => state.dispose())
  const base = {
    contexts: [], variables: {}, tools: [state.runCodeDefinition],
    sections: [{ name: 'tools:sdk', text: 'native sdk' }],
  }
  const rendered = await state.assemble({
    ...base,
    sections: [{ name: 'tool:glob', text: null }, ...base.sections],
  })
  assert.equal(rendered.sections[0].text, null)
  const named = await state.assemble({
    ...base,
    sections: [{ name: 'tool:glob', text: 'Use the Glob tool.' }, ...base.sections],
  })
  assert.equal(named.sections[0].text, 'Use the Glob tool.')
})

test('leaves absent run_code assemblies unchanged and rejects incompatible schemas', async (t) => {
  const state = fixture()
  t.after(() => state.dispose())
  const assembly = {
    sections: [], contexts: [], variables: {},
    tools: [{ name: 'other', description: 'Other.', parameters: { type: 'object', properties: {} } }],
  }
  assert.equal(await state.assemble(assembly), assembly)
  await assert.rejects(state.assemble({
    ...assembly,
    tools: [{
      name: 'run_code',
      description: 'Wrong.',
      parameters: { type: 'object', properties: { code: { type: 'string' } } },
    }],
  }), /ptc-plus: incompatible run_code schema/)
})
