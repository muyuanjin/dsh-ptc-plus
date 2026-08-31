/** Own PTC direct presentation, prompt projection, and stream normalization. */
import { canonicalizeToolCallStream } from './tool-call-canonicalizer.js'
import { editRunCodeSchema } from './rejected-cell-editor.js'
import { sessionRuntimeContexts } from './runtime-contexts.js'
import { projectProgramSdk } from './sdk-projection.js'
import { EDIT_RUN_CODE } from './edit-transport-owner.js'
import { RUN_CODE } from './runtime-bridge-owner.js'
import { isRecord } from './record-utils.js'

const RUN_CODE_TOOL_DESCRIPTION = 'Evaluate the next TypeScript cell in this session-bound persistent REPL. Earlier top-level bindings remain available, so this call extends the current environment instead of creating a fresh one. Use `code` for the async-function body and `description` for its short UI summary. Successful image-bearing subtool results are attached after the cell.'
const RUN_CODE_CODE_DESCRIPTION = 'Code for the next REPL cell, parsed as the body of an async TypeScript function.'
const RUN_CODE_DESCRIPTION_DESCRIPTION = 'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).'
const CODE_TRANSPORT_INSTRUCTION = '`run_code` and `edit_run_code` are the only tools callable directly. Call every native tool declared by the SDK from inside a program.'
const PTC_COLLAPSE_SECTION_NAMES = Object.freeze(['tools:ptc-only', 'tools:code-only'])

function adaptRunCodeSchema(tool) {
  const parameters = tool.parameters
  const properties = isRecord(parameters) ? parameters.properties : undefined
  const code = isRecord(properties) ? properties.code : undefined
  const description = isRecord(properties) ? properties.description : undefined
  if (!isRecord(parameters) || parameters.type !== 'object' || !isRecord(properties)
    || !isRecord(code) || code.type !== 'string'
    || !isRecord(description) || description.type !== 'string') {
    throw new Error('ptc-plus: incompatible run_code schema; expected object parameters with string code and description properties')
  }
  return {
    ...tool,
    description: RUN_CODE_TOOL_DESCRIPTION,
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        code: { ...code, description: RUN_CODE_CODE_DESCRIPTION },
        description: { ...description, description: RUN_CODE_DESCRIPTION_DESCRIPTION },
      },
    },
  }
}

function capabilitySdk(nativeSdk) {
  return `${projectProgramSdk(nativeSdk)}

## PTC Plus program capabilities

\`\`\`ts
declare class CapabilityExplorationError extends Error { readonly operation: "tree" | "find" | "inspect" }
declare const capabilities: {
  tree(): Promise<Array<{ namespace: string; members: string[] }>>
  find(query: string): Promise<Array<{ symbol: string; description?: string; completeness: string; effect: string; replay: string }>>
  inspect(args?: { symbols?: string[]; budget?: number }): Promise<{ symbols: unknown[]; omitted: number; unknown: string[]; budget: number }>
}
\`\`\``
}

function rejection(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    error: { message },
  }
}

export function createCordisRecoveryPolicy(initiallyEnabled) {
  const states = new WeakMap()
  let enabled = initiallyEnabled
  let generation = enabled ? 1 : 0
  return Object.freeze({
    reconfigure(nextEnabled) {
      if (!enabled && nextEnabled) generation += 1
      enabled = nextEnabled
    },
    required(agent, view) {
      if (!enabled) return false
      let state = states.get(agent)
      if (state?.generation !== generation) {
        state = {
          generation,
          baselineInspections: view.cordisTranscript.inspections,
          required: view.cordisTranscript.calls > 0,
        }
        states.set(agent, state)
      }
      if (state.required
        && view.cordisTranscript.inspections > state.baselineInspections) {
        state.required = false
      }
      return state.required
    },
    disposeAgent(agent) {
      states.delete(agent)
    },
  })
}

function presentationState(assembly) {
  const tools = Array.isArray(assembly?.tools) ? assembly.tools : []
  if (!tools.some(tool => tool?.name === RUN_CODE)) {
    return { presentation: 'native', ownerProven: false, collapseSectionName: undefined }
  }
  const collapse = PTC_COLLAPSE_SECTION_NAMES
    .map(name => assembly?.sections?.find(section => section?.name === name))
    .find(section => section !== undefined)
  if (collapse !== undefined) {
    const presentation = typeof collapse.text === 'string' && collapse.text.trim().length > 0
      ? 'ptc'
      : 'both'
    return { presentation, ownerProven: true, collapseSectionName: collapse.name }
  }
  const presentation = tools.every(tool => tool?.name === RUN_CODE || tool?.name === EDIT_RUN_CODE)
    ? 'ptc'
    : 'both'
  return { presentation, ownerProven: false, collapseSectionName: undefined }
}

async function* bindCallPolicies(source, policy, calls) {
  const pending = new Map()
  for await (const chunk of source) {
    if (chunk?.type === 'tool-call-delta'
      && typeof chunk.id === 'string' && chunk.id.length > 0) {
      pending.set(chunk.index, chunk.id)
    } else if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const callId = chunk.block.id
      if (typeof callId === 'string' && callId.length > 0) calls.set(callId, policy)
      pending.delete(chunk.index)
    } else if (chunk?.type === 'finish') {
      for (const callId of pending.values()) calls.set(callId, policy)
      pending.clear()
    }
    yield chunk
  }
}

export function createDirectSurfaceOwner({
  editTransport,
  runtimeConfig,
  canonicalizeToolCalls,
  sessionId,
  toolSchemasForAgent,
}) {
  // Composition is anchored to Agent identity because DSH selects presentation
  // once per composed agent. Request signals bind the exact assembly to stream
  // execution, while session identity is the fallback for hosts that replace a
  // signal between those stages. Calls retain the resolved request policy by id
  // so a later assembly cannot reinterpret an in-flight dispatch.
  const compositions = new Map()
  const canonicalRequests = new WeakMap()
  const sessions = new Map()
  const cordisRecovery = createCordisRecoveryPolicy(runtimeConfig.cordisToolsEnabled)
  let currentCanonicalizeToolCalls = canonicalizeToolCalls
  const tipConfig = {
    enabled: runtimeConfig.tipsEnabled,
    cooldownMessages: runtimeConfig.tipCooldownMessages,
    escalationFailures: runtimeConfig.tipEscalationFailures,
  }

  const sessionOwner = (id) => {
    let owner = sessions.get(id)
    if (owner === undefined) {
      owner = { active: true, calls: new Map(), id, latestRequest: undefined }
      sessions.set(id, owner)
    }
    return owner
  }

  const clearSession = (id) => {
    const owner = sessions.get(id)
    if (owner !== undefined) owner.active = false
    sessions.delete(id)
  }

  const requestPolicy = (signal, id) => {
    if (signal !== null && typeof signal === 'object') {
      const request = canonicalRequests.get(signal)
      return request?.owner.active === true && (id === undefined || request.owner.id === id)
        ? request
        : undefined
    }
    return id === undefined ? undefined : sessions.get(id)?.latestRequest
  }

  const executionPolicy = (id, callId) => {
    if (id === undefined) return undefined
    const owner = sessions.get(id)
    if (typeof callId === 'string' && owner?.calls.has(callId)) {
      return owner.calls.get(callId)
    }
    return undefined
  }

  const rememberRequest = (id, signal, presentation, nativeSchemas) => {
    const owner = sessionOwner(id)
    const request = { presentation, nativeSchemas, owner }
    owner.latestRequest = request
    if (signal !== undefined) canonicalRequests.set(signal, request)
  }

  const captureComposition = (agent, id, presentation) => {
    let composition = compositions.get(agent)
    if (composition !== undefined) return composition
    composition = { presentation, sessionId: id }
    compositions.set(agent, composition)
    return composition
  }

  const clearCompositionsForSession = (id) => {
    for (const [agent, composition] of compositions) {
      if (composition.sessionId === id) compositions.delete(agent)
    }
  }

  return Object.freeze({
    reconfigure(nextConfig) {
      currentCanonicalizeToolCalls = nextConfig.canonicalizeToolCalls
      cordisRecovery.reconfigure(nextConfig.cordisToolsEnabled)
      tipConfig.enabled = nextConfig.tipsEnabled
      tipConfig.cooldownMessages = nextConfig.tipCooldownMessages
      tipConfig.escalationFailures = nextConfig.tipEscalationFailures
    },
    async assemble(initialAssembly, context, next) {
      const agent = context?.agent
      const id = sessionId(agent)
      const initialState = presentationState(initialAssembly)
      let composition = compositions.get(agent)
      if (composition === undefined && id !== undefined
        && (initialState.ownerProven || initialState.presentation === 'ptc')) {
        composition = captureComposition(agent, id, initialState.presentation)
      }
      if (composition?.presentation === 'ptc' && !editTransport.isInstalled(agent)) {
        editTransport.ensureInstalled(agent)
      }

      const assembly = await next()
      const tools = assembly.tools
      if (!Array.isArray(tools)) {
        throw new Error('ptc-plus: incompatible prompt assembly; expected a tools array')
      }
      const completedState = presentationState(assembly)
      if (composition === undefined && id !== undefined) {
        const state = initialState.ownerProven ? initialState : completedState
        composition = captureComposition(agent, id, state.presentation)
        if (composition.presentation === 'ptc' && !editTransport.isInstalled(agent)) {
          editTransport.ensureInstalled(agent)
        }
      }
      const presentation = composition?.presentation
        ?? (initialState.ownerProven ? initialState.presentation : completedState.presentation)
      const requestSignal = context?.signal !== null && typeof context?.signal === 'object'
        ? context.signal
        : undefined
      if (!tools.some(tool => tool?.name === RUN_CODE)) {
        if (presentation !== 'native') {
          throw new Error(`ptc-plus: ${presentation} agent composition assembled without run_code`)
        }
        if (id !== undefined) {
          rememberRequest(id, requestSignal, 'native', new Map())
        }
        return assembly
      }
      if (presentation === 'native') {
        throw new Error('ptc-plus: native agent composition assembled with run_code')
      }
      const sessionPtc = presentation !== 'native' && id !== undefined
      const sessionPtcProjection = presentation === 'ptc' && id !== undefined
      const runCode = tools.find(tool => tool?.name === RUN_CODE)
      let directTools = tools
      if (sessionPtcProjection) {
        editTransport.ensureInstalled(agent)
        directTools = [adaptRunCodeSchema(runCode), editRunCodeSchema()]
      }
      const runtimeContexts = sessionPtc
        ? sessionRuntimeContexts(agent, tipConfig, {
          cordisRecoveryRequired(view) {
            return cordisRecovery.required(agent, view)
          },
        })
        : { contexts: [] }
      const contexts = sessionPtc && Array.isArray(assembly.contexts)
        && runtimeContexts.contexts.length > 0
        ? [...assembly.contexts, ...runtimeContexts.contexts]
        : assembly.contexts
      const projectsSections = presentation !== 'native' && Array.isArray(assembly.sections)
        && assembly.sections.some(section => section?.name === 'tools:sdk'
          || (sessionPtcProjection && section?.name === completedState.collapseSectionName))
      const sections = projectsSections
        ? assembly.sections.map(section => {
            if (section?.name === 'tools:sdk') {
              return { ...section, text: capabilitySdk(section.text) }
            }
            if (sessionPtcProjection && section?.name === completedState.collapseSectionName) {
              return { ...section, text: CODE_TRANSPORT_INSTRUCTION }
            }
            return section
          })
        : assembly.sections

      if (id !== undefined) {
        const nativeSchemas = presentation === 'ptc'
          ? new Map(toolSchemasForAgent(agent)
            .filter(schema => typeof schema?.name === 'string'
              && schema.name !== RUN_CODE && schema.name !== EDIT_RUN_CODE)
            .map(schema => [schema.name, schema]))
          : new Map()
        rememberRequest(id, requestSignal, presentation, nativeSchemas)
      }

      return {
        ...assembly,
        tools: sessionPtcProjection
          ? directTools
          : directTools.map(tool => tool?.name === RUN_CODE ? adaptRunCodeSchema(tool) : tool),
        sections,
        contexts,
      }
    },
    stream(options, next) {
      const optionSessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
      const policy = requestPolicy(options?.signal, optionSessionId)
      if (policy === undefined || optionSessionId === undefined) return next()
      const source = policy.presentation === 'ptc'
        ? canonicalizeToolCallStream(next(), {
          tools: options.tools,
          nativeSchemas: currentCanonicalizeToolCalls ? policy.nativeSchemas : new Map(),
          editToolName: EDIT_RUN_CODE,
        })
        : next()
      return bindCallPolicies(source, policy, policy.owner.calls)
    },
    executionRejection(exec) {
      if (exec.name === EDIT_RUN_CODE && exec.parent !== undefined) {
        return rejection(`tool ${EDIT_RUN_CODE} is only callable directly in PTC mode; call native tools from inside run_code`)
      }
      const id = sessionId(exec.agent)
      const policy = executionPolicy(id, exec.callId)
        ?? requestPolicy(exec?.signal, id)
      if (exec.name === EDIT_RUN_CODE) {
        return policy?.presentation === 'ptc'
          ? undefined
          : rejection(`tool ${EDIT_RUN_CODE} is not declared for this request`)
      }
      if (exec.name === RUN_CODE || exec.parent !== undefined) {
        return undefined
      }
      if (policy?.presentation !== 'ptc') return undefined
      return rejection(`tool ${exec.name} is not a direct PTC tool; use run_code or edit_run_code directly, and call native tools from inside run_code`)
    },
    handleResult(exec) {
      const id = sessionId(exec.agent)
      if (id === undefined || typeof exec.callId !== 'string') return
      sessions.get(id)?.calls.delete(exec.callId)
    },
    disposeAgent(agent) {
      const id = sessionId(agent)
      compositions.delete(agent)
      cordisRecovery.disposeAgent(agent)
      if (id !== undefined) clearSession(id)
    },
    disposeSession(session) {
      const id = String(session.id)
      clearCompositionsForSession(id)
      clearSession(id)
    },
    dispose() {
      compositions.clear()
      for (const owner of sessions.values()) owner.active = false
      sessions.clear()
    },
  })
}
