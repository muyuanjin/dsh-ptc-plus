/** Own PTC direct presentation, prompt projection, and stream normalization. */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
import { canonicalizeToolCallStream } from './tool-call-canonicalizer.js'
import { editRunCodeSchema } from './rejected-cell-editor.js'
import { sessionRuntimeContexts } from './runtime-contexts.js'
import { projectProgramSdk } from './sdk-projection.js'
import { EDIT_RUN_CODE } from './edit-transport-owner.js'
import { RUN_CODE } from './runtime-bridge-owner.js'
import { isRecord } from './record-utils.js'
import { missingDescriptionPath } from './failure-reporting.js'
import {
  generatedRunCodeExecutionArguments,
  generatedRunCodeDescriptionMeta,
} from './run-code-description.js'
import { userBindingsConfiguredContext } from './user-bindings.js'
import { BINDING_AUTHORING_SDK } from './user-binding-authoring.js'

const RUN_CODE_TOOL_DESCRIPTION = 'Evaluate the next TypeScript cell in this session-bound persistent REPL, reusing earlier top-level bindings. Use `code` for the async-function body and `description` for its short UI summary. Successful image-bearing subtool results are attached after the cell.'
const RUN_CODE_CODE_DESCRIPTION = 'Code for the next REPL cell, parsed as the body of an async TypeScript function.'
const RUN_CODE_DESCRIPTION_DESCRIPTION = 'Short active-voice summary of what this cell does, 5-10 words (shown in the UI).'
const CODE_TRANSPORT_INSTRUCTION = '`run_code` and `edit_run_code` are the only tools callable directly. Call every native tool declared by the SDK from inside a program.'
const PTC_COLLAPSE_SECTION_NAMES = Object.freeze(['tools:ptc-only', 'tools:code-only'])
const INVALID_TOOL_JSON_FAILURE = Object.freeze({
  code: 'MALFORMED_RESPONSE',
  message: 'DeepSeek Messages stream: tool input is invalid JSON',
})
const MALFORMED_TOOL_REJECTION_ID = 'dsh-ptc-plus-malformed-tool-json'
const MALFORMED_TOOL_REJECTION_ARGUMENTS = '{"dsh_ptc_plus_malformed_tool_json":'

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

function capabilitySdk(nativeSdk, userBindingsEnabled) {
  return `${projectProgramSdk(nativeSdk)}

## PTC Plus program capabilities

Discover program APIs without calling them. \`tree()\` lists namespaces and members; \`inspect()\` describes selected \`namespace.member\` symbols. \`find()\` matches case-insensitive symbols or contiguous words, separating CamelCase and punctuation. Use short queries such as \`"read"\`; if none match, shorten the query or check \`tree()\`. Missing metadata is unknown.

\`\`\`ts
declare class CapabilityExplorationError extends Error { readonly operation: "tree" | "find" | "inspect" }
declare const capabilities: {
  tree(): Promise<Array<{ namespace: string; members: string[] }>>
  find(query: string): Promise<Array<{ symbol: string; description?: string; completeness: string; effect: string; replay: string }>>
  inspect(args?: { symbols?: string[]; budget?: number }): Promise<{ symbols: unknown[]; omitted: number; unknown: string[]; budget: number }>
}
\`\`\`${userBindingsEnabled ? `\n${BINDING_AUTHORING_SDK}` : ''}`
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

function invalidToolJsonFinish(chunk) {
  const failure = chunk?.reason?.failure
  return chunk?.type === 'finish'
    && chunk.reason.kind === 'error'
    && failure?.code === INVALID_TOOL_JSON_FAILURE.code
    && failure?.message === INVALID_TOOL_JSON_FAILURE.message
}

function invalidToolJsonError(error) {
  const failure = error?.failure ?? error
  return failure?.code === INVALID_TOOL_JSON_FAILURE.code
    && failure?.message === INVALID_TOOL_JSON_FAILURE.message
}

function directToolSchemas(tools) {
  const schemas = new Map()
  if (!Array.isArray(tools)) return schemas
  for (const tool of tools) {
    if (tool?.name !== RUN_CODE && tool?.name !== EDIT_RUN_CODE) continue
    if (schemas.has(tool.name) || !isRecord(tool.parameters)) return new Map()
    schemas.set(tool.name, tool.parameters)
  }
  return schemas
}

function repairableDirectCall(chunks, tools) {
  const finish = chunks.at(-1)
  if (!invalidToolJsonFinish(finish)) return undefined
  const completed = completedToolBlocks(chunks)
  if (completed?.length !== 1) return undefined
  const body = chunks.slice(0, -1)
  const starts = body.filter(chunk => chunk?.type === 'block-start' && chunk.blockType === 'tool-call')
  const deltas = body.filter(chunk => chunk?.type === 'tool-call-delta')
  const ends = body.filter(chunk => chunk?.type === 'block-end' && chunk.block?.type === 'tool-call')
  const usages = body.filter(chunk => chunk?.type === 'usage')
  if (starts.length !== 1 || deltas.length === 0 || ends.length !== 1
    || usages.length > 1
    || body.some(chunk => chunk?.type !== 'usage' && !toolStreamChunk(chunk))) {
    return undefined
  }
  const index = starts[0].index
  const end = ends[0]
  const id = end.block.id
  const name = end.block.name
  if (!Number.isSafeInteger(index) || index < 0 || typeof id !== 'string' || id.length === 0
    || (name !== RUN_CODE && name !== EDIT_RUN_CODE)
    || end.index !== index
    || typeof end.block.arguments !== 'string'
    || deltas.some(chunk => chunk.index !== index || chunk.id !== id
      || (chunk.name !== undefined && chunk.name !== name)
      || typeof chunk.argumentsDelta !== 'string')) {
    return undefined
  }
  const raw = deltas.map(chunk => chunk.argumentsDelta).join('')
  if (raw !== end.block.arguments || !raw.endsWith('}')) return undefined
  const candidate = raw.slice(0, -1)
  let value
  try {
    value = JSON.parse(candidate)
  } catch {
    return undefined
  }
  const schema = directToolSchemas(tools).get(name)
  if (!isRecord(value) || schema === undefined
    || validateJsonSchemaValue(schema, value).length !== 0) return undefined
  return { index, candidate }
}

function canonicalToolBlock(index, block) {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index, id: block.id, name: block.name,
      argumentsDelta: block.arguments,
    },
    { type: 'block-end', index, block },
  ]
}

function repairedDirectChunks(chunks, repair, usageAlreadyEmitted) {
  const end = chunks.find(chunk => chunk?.type === 'block-end'
    && chunk.index === repair.index && chunk.block?.type === 'tool-call')
  const block = { ...end.block, arguments: repair.candidate }
  const usage = usageAlreadyEmitted ? undefined : firstUsageChunk(chunks)
  return [
    ...canonicalToolBlock(repair.index, block),
    ...usage === undefined ? [] : [usage],
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function completedToolBlocks(chunks) {
  const body = chunks.slice(0, -1)
  if (body.filter(chunk => chunk?.type === 'usage').length > 1
    || body.some(chunk => chunk?.type !== 'usage' && !toolStreamChunk(chunk))) {
    return undefined
  }
  const calls = new Map()
  for (const chunk of chunks) {
    if (chunk?.type === 'block-start' && chunk.blockType === 'tool-call') {
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) return undefined
      const call = calls.get(chunk.index)
      if (call?.started === true || call?.block !== undefined) return undefined
      if (call === undefined) calls.set(chunk.index, {
        arguments: '', hasDelta: false, started: true,
      })
      else call.started = true
    } else if (chunk?.type === 'tool-call-delta') {
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) return undefined
      let call = calls.get(chunk.index)
      if (call === undefined) {
        call = { arguments: '', hasDelta: false, started: false }
        calls.set(chunk.index, call)
      }
      if (call.block !== undefined
        || typeof chunk.id !== 'string' || chunk.id.length === 0
        || (call.id !== undefined && call.id !== chunk.id)
        || (chunk.name !== undefined && (typeof chunk.name !== 'string' || chunk.name.length === 0
          || (call.name !== undefined && call.name !== chunk.name)))
        || typeof chunk.argumentsDelta !== 'string') return undefined
      call.id ??= chunk.id
      if (chunk.name !== undefined) call.name ??= chunk.name
      call.hasDelta = true
      call.arguments += chunk.argumentsDelta
    } else if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') {
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) return undefined
      let call = calls.get(chunk.index)
      if (call === undefined) {
        call = { arguments: '', hasDelta: false, started: false }
        calls.set(chunk.index, call)
      }
      if (call.block !== undefined
        || typeof chunk.block.id !== 'string' || chunk.block.id.length === 0
        || typeof chunk.block.name !== 'string' || chunk.block.name.length === 0
        || typeof chunk.block.arguments !== 'string'
        || (call.id !== undefined && call.id !== chunk.block.id)
        || (call.name !== undefined && call.name !== chunk.block.name)
        || (call.hasDelta && call.arguments !== chunk.block.arguments)) return undefined
      call.block = chunk.block
    }
  }
  if (calls.size === 0 || [...calls.values()].some(call => call.block === undefined)) {
    return undefined
  }
  const completed = [...calls].map(([index, call]) => ({ index, block: call.block }))
  if (new Set(completed.map(call => call.block.id)).size !== completed.length) return undefined
  return completed
}

function firstUsageChunk(chunks) {
  return chunks.find(chunk => chunk?.type === 'usage')
}

function settleMalformedToolCalls(chunks, priorIndexes, usageAlreadyEmitted) {
  if (!invalidToolJsonFinish(chunks.at(-1))) return undefined
  const calls = completedToolBlocks(chunks)
  if (calls === undefined || calls.some(call => priorIndexes.has(call.index))) return undefined
  const usage = usageAlreadyEmitted ? undefined : firstUsageChunk(chunks)
  return [
    ...calls.flatMap(call => canonicalToolBlock(call.index, call.block)),
    ...usage === undefined ? [] : [usage],
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function toolStreamChunk(chunk) {
  return chunk?.type === 'tool-call-delta'
    || (chunk?.type === 'block-start' && chunk.blockType === 'tool-call')
    || (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call')
}

function unusedString(base, used) {
  let value = base
  for (let suffix = 2; used.has(value); suffix++) value = `${base}-${suffix}`
  return value
}

function visibleBlockClosures(openBlocks, chunks) {
  const closing = new Map([...openBlocks].map(([index, block]) => [index, { ...block }]))
  for (const chunk of chunks) {
    const block = closing.get(chunk?.index)
    if (block === undefined) continue
    if (chunk.type === `${block.type}-delta` && typeof chunk.text === 'string') {
      block.text += chunk.text
    } else if (chunk.type === 'block-end' && chunk.block?.type === block.type) {
      block.final = chunk.block
    }
  }
  return [...closing].map(([index, block]) => ({
    type: 'block-end',
    index,
    block: block.final ?? { type: block.type, text: block.text },
  }))
}

function rejectedMalformedToolStream(
  chunks,
  priorIndexes = new Set(),
  openBlocks = new Map(),
  usageAlreadyEmitted = false,
) {
  const usedIndexes = new Set(priorIndexes)
  const usedIds = new Set()
  for (const chunk of chunks) {
    if (Number.isSafeInteger(chunk?.index) && chunk.index >= 0) usedIndexes.add(chunk.index)
    if (typeof chunk?.id === 'string') usedIds.add(chunk.id)
    if (typeof chunk?.block?.id === 'string') usedIds.add(chunk.block.id)
  }
  let index = 0
  while (usedIndexes.has(index)) index++
  const id = unusedString(MALFORMED_TOOL_REJECTION_ID, usedIds)
  const usage = usageAlreadyEmitted ? undefined : firstUsageChunk(chunks)
  return [
    ...visibleBlockClosures(openBlocks, chunks),
    { type: 'block-start', index, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index, id, name: RUN_CODE,
      argumentsDelta: MALFORMED_TOOL_REJECTION_ARGUMENTS,
    },
    {
      type: 'block-end', index,
      block: {
        type: 'tool-call', id, name: RUN_CODE,
        arguments: MALFORMED_TOOL_REJECTION_ARGUMENTS,
      },
    },
    ...usage === undefined ? [] : [usage],
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function recoveredMalformedChunks(chunks, tools, priorIndexes, openBlocks, usageAlreadyEmitted) {
  if (usageAlreadyEmitted && firstUsageChunk(chunks) !== undefined) {
    return rejectedMalformedToolStream(chunks, priorIndexes, openBlocks, true)
  }
  const repair = repairableDirectCall(chunks, tools)
  const settled = repair !== undefined && !priorIndexes.has(repair.index)
    ? repairedDirectChunks(chunks, repair, usageAlreadyEmitted)
    : settleMalformedToolCalls(chunks, priorIndexes, usageAlreadyEmitted)
  return settled === undefined
    ? rejectedMalformedToolStream(chunks, priorIndexes, openBlocks, usageAlreadyEmitted)
    : [...visibleBlockClosures(openBlocks, chunks), ...settled]
}

function observeVisibleBlock(openBlocks, chunk) {
  if (chunk?.type === 'block-start'
    && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
    openBlocks.set(chunk.index, { type: chunk.blockType, text: '' })
  } else if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
    const block = openBlocks.get(chunk.index)
    const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
    if (block?.type === type) block.text += chunk.text
  } else if (chunk?.type === 'block-end') {
    openBlocks.delete(chunk.index)
  }
}

async function* recoverMalformedToolCallStream(source, tools) {
  let pending = []
  const priorIndexes = new Set()
  const openBlocks = new Map()
  let usageSeen = false
  try {
    for await (const chunk of source) {
      if (pending.length === 0) {
        if (toolStreamChunk(chunk)) pending.push(chunk)
        else if (chunk?.type === 'usage' && usageSeen) pending.push(chunk)
        else if (invalidToolJsonFinish(chunk)) {
          yield* rejectedMalformedToolStream([chunk], priorIndexes, openBlocks, usageSeen)
          openBlocks.clear()
        } else {
          if (Number.isSafeInteger(chunk?.index) && chunk.index >= 0) priorIndexes.add(chunk.index)
          observeVisibleBlock(openBlocks, chunk)
          if (chunk?.type === 'usage') usageSeen = true
          yield chunk
        }
        continue
      }
      pending.push(chunk)
      if (chunk?.type !== 'finish') continue
      const output = invalidToolJsonFinish(chunk)
        ? recoveredMalformedChunks(pending, tools, priorIndexes, openBlocks, usageSeen)
        : pending
      for (const outputChunk of output) {
        if (Number.isSafeInteger(outputChunk?.index) && outputChunk.index >= 0) {
          priorIndexes.add(outputChunk.index)
        }
        if (outputChunk?.type === 'usage') usageSeen = true
        yield outputChunk
      }
      if (invalidToolJsonFinish(chunk)) openBlocks.clear()
      pending = []
    }
  } catch (error) {
    if (invalidToolJsonError(error)) {
      yield* recoveredMalformedChunks([
        ...pending,
        { type: 'finish', reason: { kind: 'error', failure: INVALID_TOOL_JSON_FAILURE } },
      ], tools, priorIndexes, openBlocks, usageSeen)
      return
    } else {
      yield* pending
      throw error
    }
  }
  yield* pending
}

export function createDirectSurfaceOwner({
  editTransport,
  runtimeConfig,
  canonicalizeToolCalls,
  sessionId,
  toolSchemasForAgent,
  userBindingsForAgent = async () => undefined,
  setAgentPresentation = async () => {},
  sessionLogView,
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
  let disposed = false
  let currentCanonicalizeToolCalls = canonicalizeToolCalls
  let currentAutoDescribeRunCode = runtimeConfig.autoDescribeRunCode
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

  // One dispatch resolves the policy captured for its exact call, then the
  // request bound to its signal, then the session's latest request.
  const dispatchPolicy = (exec) => {
    const id = sessionId(exec.agent)
    return executionPolicy(id, exec.callId) ?? requestPolicy(exec?.signal, id)
  }

  const rememberRequest = (
    id,
    signal,
    presentation,
    nativeSchemas,
    autoDescribeRunCode,
    userBindings,
    contexts = [],
  ) => {
    const owner = sessionOwner(id)
    const request = {
      presentation,
      nativeSchemas,
      autoDescribeRunCode,
      owner,
      contexts,
      ...(userBindings === undefined ? {} : { userBindings }),
    }
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
      currentAutoDescribeRunCode = nextConfig.autoDescribeRunCode
      cordisRecovery.reconfigure(nextConfig.cordisToolsEnabled)
      tipConfig.enabled = nextConfig.tipsEnabled
      tipConfig.cooldownMessages = nextConfig.tipCooldownMessages
      tipConfig.escalationFailures = nextConfig.tipEscalationFailures
    },
    async assemble(initialAssembly, context, next) {
      // Keep schema projection and later execution on one configuration snapshot.
      const autoDescribeRunCode = currentAutoDescribeRunCode
      const agent = context?.agent
      const id = sessionId(agent)
      const requestOwner = id === undefined ? undefined : sessionOwner(id)
      const isCurrent = () => !disposed && (requestOwner === undefined
        || (requestOwner.active && sessions.get(id) === requestOwner))
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
      if (!isCurrent()) return assembly
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
        await setAgentPresentation(agent, presentation)
        if (!isCurrent()) return assembly
        if (id !== undefined) {
          rememberRequest(id, requestSignal, 'native', new Map(), autoDescribeRunCode, undefined)
        }
        return assembly
      }
      if (presentation === 'native') {
        throw new Error('ptc-plus: native agent composition assembled with run_code')
      }
      await setAgentPresentation(agent, presentation)
      if (!isCurrent()) return assembly
      const sessionPtc = presentation !== 'native' && id !== undefined
      const sessionPtcProjection = presentation === 'ptc' && id !== undefined
      const userBindings = sessionPtc ? await userBindingsForAgent(agent) : undefined
      if (!isCurrent()) return assembly
      const runCode = tools.find(tool => tool?.name === RUN_CODE)
      let directTools = tools
      if (sessionPtcProjection) {
        editTransport.ensureInstalled(agent)
        directTools = [adaptRunCodeSchema(runCode), editRunCodeSchema()]
      }
      const runtimeContexts = sessionPtc
        ? sessionRuntimeContexts(agent, tipConfig, {
          sessionLogView,
          cordisRecoveryRequired(view) {
            return cordisRecovery.required(agent, view)
          },
        })
        : { contexts: [] }
      const bindingDefaults = userBindings === undefined ? undefined : userBindingsConfiguredContext(userBindings)
      const contexts = [
        ...runtimeContexts.contexts,
        ...(bindingDefaults === undefined ? [] : [bindingDefaults]),
      ]
      const projectsSections = presentation !== 'native' && Array.isArray(assembly.sections)
        && assembly.sections.some(section => section?.name === 'tools:sdk'
          || (sessionPtcProjection && section?.name === completedState.collapseSectionName))
      const sections = projectsSections
        ? assembly.sections.map(section => {
            if (section?.name === 'tools:sdk') {
              return { ...section, text: capabilitySdk(section.text, userBindings !== undefined) }
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
        rememberRequest(
          id,
          requestSignal,
          presentation,
          nativeSchemas,
          autoDescribeRunCode,
          userBindings,
          contexts,
        )
      }

      return {
        ...assembly,
        tools: sessionPtcProjection
          ? directTools
          : directTools.map(tool => tool?.name === RUN_CODE
            ? adaptRunCodeSchema(tool)
            : tool),
        sections,
      }
    },
    contextsForRequest(context) {
      return requestPolicy(context.signal, sessionId(context.agent))?.contexts ?? []
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
      const recovered = recoverMalformedToolCallStream(source, options.tools)
      return bindCallPolicies(recovered, policy, policy.owner.calls)
    },
    executionRejection(exec) {
      if (exec.name === EDIT_RUN_CODE && exec.parent !== undefined) {
        return rejection(`tool ${EDIT_RUN_CODE} is only callable directly in PTC mode; call native tools from inside run_code`)
      }
      const policy = dispatchPolicy(exec)
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
    executionArguments(exec) {
      const policy = dispatchPolicy(exec)
      const originalArguments = exec.arguments
      if (exec.name !== RUN_CODE || exec.parent !== undefined
        || policy?.autoDescribeRunCode !== true || policy.presentation === 'native'
        || !isRecord(originalArguments) || Object.hasOwn(originalArguments, 'description')
        || typeof originalArguments.code !== 'string') {
        return originalArguments
      }
      return generatedRunCodeExecutionArguments(originalArguments)
    },
    executionUserBindings(exec) {
      const policy = dispatchPolicy(exec)
      return policy?.presentation === 'native' ? undefined : policy?.userBindings
    },
    argumentDiagnostic(exec, result) {
      // DSH uses success-result identity to avoid re-running output projectors
      // after this middleware's settlement scope has ended.
      if (exec?.name !== RUN_CODE || result?.isError !== true) return result
      const meta = generatedRunCodeDescriptionMeta(exec.arguments, result.meta)
      const diagnosed = meta === result.meta
        ? result
        : { ...result, ...(meta === undefined ? {} : { meta }) }
      const missingPath = missingDescriptionPath(diagnosed.error)
      if (missingPath === undefined) return diagnosed
      const policy = dispatchPolicy(exec)
      const outer = missingPath === 'description'
        && policy?.autoDescribeRunCode !== true
        && !(isRecord(exec.arguments) && typeof exec.arguments.description === 'string')
      const text = outer
        ? 'The run_code outer transport arguments are invalid at JSON path $.description. Add a sibling string `description` field to run_code; a description nested inside a native-tool argument does not satisfy this outer requirement.'
        : `A nested native-tool argument is missing required property "${missingPath}". Add a string description at that path in the native-tool arguments; the outer run_code description does not satisfy this nested requirement.`
      // additionalContexts enter the durable inbox as messages, not prompt sections.
      const context = createUserMessage({
        source: {
          kind: PTC_MESSAGE_SOURCE_KIND,
          form: 'notice',
          summary: boundContextSummary('tools:ptc-plus-run-code-arguments'),
        },
        content: [{ type: 'text', text }],
      })
      return {
        ...diagnosed,
        additionalContexts: [...diagnosed.additionalContexts ?? [], context],
      }
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
    resetSessionComposition(session) {
      const id = String(session.id ?? session)
      clearCompositionsForSession(id)
      clearSession(id)
    },
    dispose() {
      disposed = true
      compositions.clear()
      for (const owner of sessions.values()) owner.active = false
      sessions.clear()
    },
  })
}
