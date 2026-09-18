import { apply } from '../index.js'
import { readRuntimeMessage } from '../internal/runtime-messages.js'
import { createHostContext, runHookChain, serviceInjector } from './host-fixture.js'

export const JOURNAL_POLICY = { autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }

export function appendOnlySession(id, events = []) {
  return {
    id,
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
  }
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
            { session: options.agent?.session, callId: options.callId },
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
    computeMs: 5_000,
    maxWallMs: 20_000,
    maxOldGenerationSizeMb: 64,
    ...config,
  })

  async function executeRun(session, program, functions, options) {
    const execute = listeners.get('tools/execute')[0]
    const controller = options.controller ?? new AbortController()
    const exec = {
      name: 'run_code',
      callId: options.callId ?? `fixture-call-${++nextCallId}`,
      agent: { id: session, session: options.session },
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

export function appendRunCodeEvents(events, callId, code, result, description = 'test cell') {
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
      arguments: JSON.stringify({ code, description }),
    },
  })
  events.push({
    type: 'tool/result',
    seq: callSeq + 1,
    time: callSeq + 1,
    sourceEventSeqs: [callSeq],
    surfaceOp: 'append',
    data: {
      message: {
        id: `message-${callId}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
      },
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    },
  })
}
