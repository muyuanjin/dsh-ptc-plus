import { apply } from '../index.js'
import { sessionEvents } from '../internal/session-events.js'
import { normalizeJournal } from '../internal/session-journal.js'
import { readRuntimeMessage } from '../internal/runtime-messages.js'
import { createHostContext, runHookChain, serviceInjector } from './host-fixture.js'

export const JOURNAL_POLICY = { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }

function visibleEventSeqs(events) {
  return events.filter(event => (
    event.type === 'user/message'
    || event.type === 'assistant/message'
    || event.type === 'tool/result'
  )).map(event => event.seq)
}

export function orderedSurfaceSession(id, events = []) {
  const session = { id, events }
  session.surface = {
    replaceGeneration: 0,
    get nodes() { return visibleEventSeqs(session.events) },
  }
  return session
}

export function appendOnlySession(id, events = []) {
  return {
    id,
    header: { cwd: process.cwd() },
    surface: {
      replaceGeneration: 0,
      get nodes() { return visibleEventSeqs(events) },
    },
    get events() {
      return Object.freeze([...events])
    },
    append(type, data) {
      const event = Object.freeze({
        type,
        seq: events.length,
        time: events.length,
        data: structuredClone(data),
      })
      events.push(event)
      return event
    },
    appendEvent(event) {
      if (event?.seq !== events.length) throw new Error('fixture event sequence must be contiguous')
      events.push(event)
      return event
    },
  }
}

function appendSessionEvents(session, appended) {
  if (typeof session.appendEvent === 'function') {
    for (const event of appended) session.appendEvent(event)
    return
  }
  if (typeof session.append === 'function') {
    for (const event of appended) {
      session.append(event.type, event.data, {
        ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
        ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
      })
    }
    return
  }
  session.events.push(...appended)
}

export function ptcAgent(id, session = { id, events: [] }) {
  const presentation = { mode: undefined, calls: [], disposals: 0 }
  const registration = { calls: [], disposals: 0 }
  const definitions = new Map()
  let inheritedGet = () => undefined
  let inheritedSchemas = () => []
  let agent
  const tools = {
    bindFixtureRegistry(get, schemas) {
      inheritedGet = get
      inheritedSchemas = schemas
    },
    get(name) {
      return definitions.get(name) ?? inheritedGet(name)
    },
    schemas(scope) {
      const inherited = inheritedSchemas(scope).filter(definition => !definitions.has(definition.name))
      return scope === agent ? [...inherited, ...definitions.values()] : inherited
    },
    register(definition) {
      if (definitions.has(definition.name)) throw new Error(`duplicate scoped tool ${definition.name}`)
      definitions.set(definition.name, definition)
      registration.calls.push(definition.name)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
        registration.disposals += 1
      }
    },
    presentAs(mode) {
      if (presentation.mode !== undefined) {
        throw new Error(`presentation already declared as ${presentation.mode}`)
      }
      presentation.mode = mode
      presentation.calls.push(mode)
      let active = true
      return () => {
        if (!active) return
        active = false
        presentation.mode = undefined
        presentation.disposals += 1
      }
    },
  }
  agent = {
    id,
    session,
    presentation,
    registration,
    ctx: {
      tools,
    },
  }
  return agent
}

export function fixture(config = {}, fixtureOptions = {}) {
  const host = createHostContext({ onListener: fixtureOptions.onListener })
  const { listeners, sections, contexts, cleanups } = host
  let disposal
  const upstreamCalls = []
  const defaultSessions = new Map()
  let nextCallId = 0
  const runCodeDefinition = {
    name: 'run_code',
    description: 'Execute one standalone program.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Standalone program source.' },
        description: { type: 'string', description: 'Program summary.' },
      },
      required: ['code', 'description'],
    },
    output: {},
  }
  const definitions = host.toolDefinitions
  definitions.set('run_code', runCodeDefinition)
  // The execution seam the host registers. The current generation resolves a
  // request before running it; the preceding one runs the request as given.
  const seamServiceName = fixtureOptions.seamService ?? 'ptcRuntime'
  const runtime = {
    language: 'typescript',
    isolation: 'process',
    get executionInstructions() {
      return fixtureOptions.executionInstructions ?? 'PROVIDER TEXT'
    },
    get sandboxMode() {
      return fixtureOptions.sandboxMode ?? 'workspace-write'
    },
    get timeout() {
      return { defaultMs: 1_000, maxMs: 2_000 }
    },
    resolve(request) {
      if (fixtureOptions.resolveSeam !== undefined) return fixtureOptions.resolveSeam(request)
      return { ...request, cwd: '/fixture-workspace', timeoutMs: request.timeoutMs ?? null }
    },
    async run(request) {
      upstreamCalls.push(request)
      if (fixtureOptions.upstreamRun !== undefined) return fixtureOptions.upstreamRun(request)
      return { logs: ['upstream'], value: 'upstream' }
    },
  }
  const services = { [seamServiceName]: runtime }
  const seamInject = serviceInjector(services, () => ctx)
  const ctx = {
    inject(names, callback) {
      if (names.length === 1 && names[0] === 'ptcPlusRpc') {
        if (fixtureOptions.bindingRpc === undefined) return () => {}
        callback({ ptcPlusRpc: {
          register(_channel, handler) {
            fixtureOptions.bindingRpc(handler)
            return () => {}
          },
        } })
        return () => {}
      }
      return seamInject(names, callback)
    },
    [seamServiceName]: runtime,
    tools: {
      get: (name, scope) => scope?.ctx?.tools?.get(name) ?? definitions.get(name),
      register: host.ctx.tools.register,
      async execute(options) {
        const definition = options.agent?.ctx?.tools?.get(options.name) ?? definitions.get(options.name)
        if (options.name === 'run_code') {
          const observed = await executeRun(
            options.agent?.id,
            options.arguments.code,
            options.bindings ?? {},
            {
              session: options.agent?.session,
              callId: options.callId,
              recordSession: false,
            },
          )
          return observed.result
        }
        const dispatch = async () => {
          if (definition === undefined || typeof definition.execute !== 'function') {
            return { isError: true, content: [], error: { message: `unknown tool ${options.name}` } }
          }
          try {
            const value = await definition.execute(options.arguments, options)
            return { isError: false, value, content: [], meta: definition.output?.presentationMeta?.(options.arguments, value) }
          } catch (error) {
            return { isError: true, content: [], error: { message: error.message } }
          }
        }
        const execute = listeners.get('tools/execute')?.[0]
        const result = execute === undefined ? await dispatch() : await execute(options, dispatch)
        for (const listener of listeners.get('tools/result') ?? []) await listener(options, result)
        return result
      },
      schemas: scope => typeof scope?.ctx?.tools?.schemas === 'function'
        ? scope.ctx.tools.schemas(scope)
        : [...definitions.values(), ...(fixtureOptions.schemas ?? [])],
    },
    ...(fixtureOptions.agents === undefined ? {} : { agents: fixtureOptions.agents }),
    systemPrompt: {
      context: host.ctx.systemPrompt.context,
      section: host.ctx.systemPrompt.section,
    },
    on: host.ctx.on,
    effect: host.ctx.effect,
  }
  const invokeSeam = request => (seamServiceName === 'ptcRuntime'
    ? runtime.run(runtime.resolve(request))
    : runtime.run(request))
  // These tests run cells that compile and import modules in-process, and the
  // compute budget counts event-loop active time, including synchronous
  // blocking. A budget tuned for one deployment therefore turns a loaded CI
  // runner into a semantic failure, because runner scheduling inflates the
  // measure the budget reads. The defaults keep that measurement out of what a
  // semantic test asserts; a test that asserts budget or deadline behavior
  // states the budget it asserts. The shipped defaults remain `computeMs`
  // 60_000 and `maxWallMs` 600_000, so this is still far below deployment.
  apply(ctx, {
    // Cell tests isolate language behavior from the user's saved helpers.
    // Binding integration tests explicitly enable their isolated store.
    userBindingsEnabled: false,
    computeMs: 5_000,
    maxWallMs: 20_000,
    maxOldGenerationSizeMb: 64,
    ...config,
  })

  async function executeRun(session, program, functions, options) {
    const execute = listeners.get('tools/execute')[0]
    const controller = options.controller ?? new AbortController()
    let agentSession = options.session
    const recordSession = options.recordSession !== false
    const deferResult = options.recordSession === 'deferred-result'
    if (agentSession === undefined) {
      agentSession = defaultSessions.get(session)
      if (agentSession === undefined) {
        agentSession = orderedSurfaceSession(session)
        defaultSessions.set(session, agentSession)
      }
    }
    const callId = options.callId ?? `fixture-call-${++nextCallId}`
    let call
    if (recordSession) {
      const argumentsValue = JSON.stringify({ code: program, description: options.description ?? 'test cell' })
      const currentEvents = sessionEvents(agentSession)
      if (!Array.isArray(currentEvents)) {
        throw new TypeError('fixture session must expose snapshotEvents() or an events array')
      }
      const existingCalls = currentEvents.filter(event => (
        event?.type === 'tool/call'
        && event.data?.callId === callId
        && event.data?.name === 'run_code'
        && !currentEvents.some(candidate => candidate?.type === 'tool/result'
          && candidate.sourceEventSeqs?.includes(event.seq))
      ))
      if (existingCalls.length > 1) {
        throw new Error(`fixture found multiple unpaired run_code calls for callId ${JSON.stringify(callId)}`)
      }
      const [existingCall] = existingCalls
      if (existingCall !== undefined) {
        if (existingCall.data.arguments !== argumentsValue) {
          throw new Error('fixture pending run_code call does not match the requested arguments')
        }
        const assistantSources = currentEvents.filter(event => (
          event?.type === 'assistant/message' && event.seq === existingCall.seq - 1
        ))
        const [assistant] = assistantSources
        const sameIdBlocks = assistant?.data?.message?.content?.filter(block => (
          block?.type === 'tool-call' && block.id === callId
        )) ?? []
        if (assistantSources.length !== 1
          || sameIdBlocks.length !== 1
          || sameIdBlocks[0].name !== 'run_code'
          || sameIdBlocks[0].arguments !== argumentsValue) {
          throw new Error('fixture pending run_code call has no exact assistant source')
        }
        call = { callSeq: existingCall.seq }
      } else {
        const pendingEvents = []
        const localCall = appendRunCodeCall(pendingEvents, callId, program, options.description)
        const offset = currentEvents.length
        for (const event of pendingEvents) {
          event.seq += offset
          event.time += offset
        }
        call = {
          assistantSeq: localCall.assistantSeq + offset,
          callSeq: localCall.callSeq + offset,
        }
        appendSessionEvents(agentSession, pendingEvents)
      }
    }
    const exec = {
      name: 'run_code',
      callId,
      agent: { id: session, session: agentSession },
    }
    let raw
    let result = await execute(exec, async () => {
      raw = await invokeSeam({
        program,
        bindings: [{
          global: 'tools',
          functions,
          ...(options.toolEmptyObjectMembers === undefined
            ? {}
            : { emptyObjectMembers: options.toolEmptyObjectMembers }),
          errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
        }, ...(options.bindings ?? [])],
        signal: controller.signal,
      })
      const meta = runCodeDefinition.output.presentationMeta?.({}, raw.value)
      if (raw.error) {
        return { isError: true, content: [], error: { message: raw.error.message }, meta }
      }
      return { isError: false, value: raw.value, content: [], meta }
    })
    if (options.finalizeResult !== undefined) result = options.finalizeResult(result)
    for (const listener of listeners.get('tools/result') ?? []) await listener(exec, result)
    if (call !== undefined && !deferResult) {
      const resultEvents = []
      appendRunCodeResult(resultEvents, callId, 0, result)
      resultEvents[0].seq = call.callSeq + 1
      resultEvents[0].time = call.callSeq + 1
      resultEvents[0].sourceEventSeqs = [call.callSeq]
      appendSessionEvents(agentSession, resultEvents)
    }
    return { raw, result }
  }

  async function run(session, program, functions = {}, options = {}) {
    return (await executeRun(session, program, functions, options)).raw
  }

  async function runDurable(session, program, functions = {}, options = {}) {
    return (await executeRun(session, program, functions, options)).result
  }

  async function assemble(assembly, context = {}, next) {
    context.agent?.ctx?.tools?.bindFixtureRegistry?.(
      name => definitions.get(name),
      scope => [
        ...definitions.values(),
        ...(fixtureOptions.schemas ?? []),
        ...(scope === context.agent ? fixtureOptions.scopedSchemas ?? [] : []),
      ],
    )
    const initial = Array.isArray(assembly.contexts) ? {
      ...assembly, contexts: [...assembly.contexts, ...contexts],
    } : assembly
    const entries = [...listeners.get('system-prompt/assemble') ?? []]
    return runHookChain(entries, [initial, context], () => (
      next === undefined ? Promise.resolve(initial) : next()
    ))
  }

  async function assembleStep(assembly, context) {
    const session = context.agent?.session
    // These legacy test fixtures declare an append-only, fully visible surface.
    // Real compaction and admission behavior is covered with DSH Session/AgentLoop.
    if (session !== undefined && session.surface === undefined && Array.isArray(session.events)) {
      session.snapshotEvents = () => session.events.map((event, index) => ({ seq: index, ...event }))
      session.surface = {
        replaceGeneration: 0,
        get nodes() {
          return session.snapshotEvents().filter(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type))
            .map(event => event.seq)
        },
      }
    }
    const result = await assemble(assembly, context)
    const payload = { agent: context.agent, signal: context.signal, turn: 1, step: 1, messages: [] }
    const entries = [...listeners.get('agent/pre-step') ?? []]
    const dispatch = index => entries[index] === undefined
      ? Promise.resolve({ kind: 'enter', messages: [] })
      : entries[index](payload, () => dispatch(index + 1))
    const decision = await dispatch(0)
    return { ...result, messages: decision.messages, ptcContexts: decision.messages.flatMap(message => {
      const record = readRuntimeMessage(message)
      return record?.sections ?? (record?.form === 'notice' ? [{ name: record.name, text: record.text }] : [])
    }) }
  }

  async function stream(options, chunks) {
    const listener = listeners.get('llm/stream')?.[0]
    const source = async function* () { yield* chunks }
    const output = []
    const transformed = listener === undefined ? source() : listener(options, source)
    for await (const chunk of transformed) output.push(chunk)
    return output
  }

  return {
    ctx,
    listeners,
    runtime,
    runCodeDefinition,
    sections,
    upstreamCalls,
    assemble,
    assembleStep,
    stream,
    executeRun,
    runDurable,
    run,
    async emit(name, value) {
      await Promise.all((listeners.get(name) ?? []).map(listener => listener(value)))
    },
    async dispose() {
      disposal ??= (async () => {
        while (cleanups.length > 0) await cleanups.pop()()
      })()
      await disposal
    },
  }
}

export function appendRunCodeCall(events, callId, code, description = 'test cell') {
  const argumentsValue = JSON.stringify({ code, description })
  const assistantSeq = events.length
  events.push({
    type: 'assistant/message',
    seq: assistantSeq,
    time: assistantSeq,
    surfaceOp: 'append',
    data: {
      turn: 0,
      step: 0,
      message: {
        id: `message-assistant-${callId}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: argumentsValue }],
      },
    },
  })
  const callSeq = events.length
  events.push({
    type: 'tool/call',
    seq: callSeq,
    time: callSeq,
    data: {
      turn: 0,
      step: 0,
      callId,
      name: 'run_code',
      arguments: argumentsValue,
    },
  })
  return Object.freeze({ assistantSeq, callSeq })
}

export function appendRunCodeResult(events, callId, callSeq, result) {
  const resultSeq = callSeq + 1
  if (events.length > 0 && resultSeq !== events.length) {
    throw new Error('run_code fixture result must immediately follow its call')
  }
  events.push({
    type: 'tool/result',
    seq: resultSeq,
    time: resultSeq,
    sourceEventSeqs: [callSeq],
    surfaceOp: 'append',
    data: {
      message: {
        id: `message-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
      },
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    },
  })
  return Object.freeze({ callSeq, resultSeq })
}

export function appendRunCodeEvents(events, callId, code, result, description = 'test cell') {
  const argumentsValue = JSON.stringify({ code, description })
  const [assistant, pendingCall] = events.slice(-2)
  const block = assistant?.data?.message?.content?.[0]
  if (assistant?.type === 'assistant/message'
    && pendingCall?.type === 'tool/call'
    && pendingCall.seq === assistant.seq + 1
    && pendingCall.data?.callId === callId
    && pendingCall.data?.name === 'run_code'
    && pendingCall.data?.arguments === argumentsValue
    && block?.type === 'tool-call'
    && block.id === callId
    && block.name === 'run_code'
    && block.arguments === argumentsValue) {
    return Object.freeze({
      assistantSeq: assistant.seq,
      callSeq: pendingCall.seq,
      ...appendRunCodeResult(events, callId, pendingCall.seq, result),
    })
  }
  const call = appendRunCodeCall(events, callId, code, description)
  return Object.freeze({
    ...call,
    ...appendRunCodeResult(events, callId, call.callSeq, result),
  })
}

export async function runRecordedCell(
  runtime,
  session,
  callId,
  request,
  { description = 'test cell', confirmed = true } = {},
) {
  const pending = []
  const localCall = appendRunCodeCall(pending, callId, request.program, description)
  const currentEvents = sessionEvents(session)
  if (!Array.isArray(currentEvents)) {
    throw new TypeError('recorded cell session must expose snapshotEvents() or an events array')
  }
  const offset = currentEvents.length
  for (const event of pending) {
    event.seq += offset
    event.time += offset
  }
  appendSessionEvents(session, pending)
  const callSeq = localCall.callSeq + offset
  const execution = await runtime.runTentative(
    { id: session.id, session, callId },
    request,
  )
  if (execution.settlement !== undefined) runtime.finalize(execution.settlement, confirmed)
  const recorded = execution.settlement === undefined ? execution.result : {
    ...execution.result,
    meta: { dshPtcPlus: normalizeJournal(execution.settlement.journal) },
  }
  const resultEvents = []
  appendRunCodeResult(resultEvents, callId, 0, recorded)
  resultEvents[0].seq = callSeq + 1
  resultEvents[0].time = callSeq + 1
  resultEvents[0].sourceEventSeqs = [callSeq]
  appendSessionEvents(session, resultEvents)
  return execution.result
}
