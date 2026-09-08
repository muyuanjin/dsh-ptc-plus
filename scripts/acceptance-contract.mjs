import { normalizeJournal } from '../internal/session-journal.js'
import { decodeValue } from '../internal/value-wire.js'
import { PTC_BINDING_CATALOG, readRuntimeMessage, recoveryTipIdentity } from '../internal/runtime-messages.js'
import { HOST_HEADER_REASONS, hostAssistantUsageEvents } from './dsh-host-contract.mjs'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import { editRejectedCell, EXPECTED_TARGET_CALL_SEQ } from '../internal/rejected-cell-editor.js'
import { editTargetForCall } from '../internal/session-log-view.js'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { createUserBindingDraftProjection, readBindingAction } from '../internal/user-binding-draft-projection.js'
import { normalizeUserBindingEntry, userBindingsSnapshotFromMeta } from '../internal/user-bindings.js'
import { constantExportProof, proveStatusSource, workflowSymbol } from './binding-status-proof.mjs'

const traverse = traverseModule.default ?? traverseModule

/** Conservative scenario oracle, not runtime policy or inferred effect metadata. */
export function auditBindingWorkflow(events, scenario = {}) {
  const failures = []
  const incomplete = []
  const observations = []
  const command = events.find(event => event.type === 'command/run' && event.data?.name === 'binding'
    && (scenario.command === undefined || event.data.args?.trim() === scenario.command.trim()))
  const authoringStart = command?.seq ?? -1
  const question = events.find(event => event.type === 'user/message' && event.data?.source?.kind === 'user'
    && event.seq > authoringStart && (scenario.statusQuestionSeq === undefined || event.seq === scenario.statusQuestionSeq)
    && typeof scenario.statusQuestion === 'string' && collectModelText(event.data.content).join('\n') === scenario.statusQuestion)
  const statusQuestionSeq = question?.seq
  const statusEnd = events.find(event => event.seq > statusQuestionSeq && event.type === 'user/message'
    && event.data?.source?.kind === 'user')?.seq ?? Infinity
  const relevant = events.filter(event => event.seq >= authoringStart && event.seq < statusEnd)
  const facts = collectTrajectoryFacts(relevant, { compareUsageChunks: false })
  const calls = facts.timeline
  failures.push(...facts.failures)
  if (command === undefined) incomplete.push('binding workflow has no matching command')
  if (!relevant.some(event => event.type === 'command/done' && event.data?.commandId === command?.data.commandId
    && event.data.kind === 'success')) incomplete.push('binding workflow has no successful command admission')
  if (question === undefined) incomplete.push('binding workflow did not ask its declared availability question')
  const projection = createUserBindingDraftProjection('workflow-audit')
  let state = projection.init()
  const actions = []
  for (const event of relevant) {
    const next = projection.apply(state, event)
    const action = event.type === 'user/message' ? readBindingAction(event.data) : undefined
    if (action !== undefined && next.history?.some(record => record.action !== null
      && record.candidate.requestId === action.requestId && event.sourceEventSeqs?.includes(record.acceptedSeq)
      && !state.history?.some(previous => previous.candidate.requestId === action.requestId && previous.action !== null))) {
      actions.push({ seq: event.seq, ...action })
    }
    state = next
  }
  const accepted = state.history?.find(record => record.commandId === command?.data.commandId
    && (scenario.entry === undefined || record.candidate.entry.id === scenario.entry.id))
  const acceptingCall = calls.find(call => call.resultSeq === accepted?.acceptedSeq)
  const entry = accepted?.candidate.entry
  const acceptedResult = relevant.find(event => event.seq === accepted?.acceptedSeq)
  const candidateMatches = submitted => {
    try {
      const normalized = normalizeUserBindingEntry({ ...submitted, enabled: false })
      return ['id', 'name', 'scope', 'source', 'purpose'].every(key => normalized[key] === entry[key])
        && isDeepStrictEqual(normalized.symbols, entry.symbols)
    } catch { return false }
  }
  const acceptanceProved = accepted !== undefined && acceptedResult !== undefined && acceptingCall !== undefined && !acceptingCall.isError
    && acceptedResult.sourceEventSeqs?.includes(acceptingCall.seq)
    && acceptingCall.nestedCalls.some(call => call.global === 'code' && call.member === 'submitBindingDraft'
      && call.ok && call.value?.accepted === true && call.value.requestId === accepted.candidate.requestId
      && call.args?.requestId === accepted.candidate.requestId && candidateMatches(call.args.entry)
      && call.value.id === entry.id)
  if (!acceptanceProved) incomplete.push('binding workflow has no verified accepted candidate and source call')
  const saved = actions.find(action => action.requestId === accepted?.candidate.requestId && action.state === 'saved'
    && action.enabled === (scenario.userAction !== 'save-disabled') && action.seq < statusQuestionSeq)
  if (saved === undefined) incomplete.push('binding workflow has no verified user save receipt before the status question')
  const closing = relevant.findLast(event => event.type === 'assistant/message' && event.seq > statusQuestionSeq
    && event.data.message?.content?.some(block => block.type === 'text' && block.text.trim() !== '')
    && !event.data.message.content.some(block => block.type === 'tool-call'))
  const ended = relevant.find(event => event.type === 'turn/end' && event.seq > closing?.seq
    && event.data?.turn === closing.data.turn)
  if (closing === undefined || ended === undefined) incomplete.push('binding workflow has no completed availability answer')
  if (calls.some(call => call.seq > statusQuestionSeq && (call.resultMissing || call.resultSeq >= statusEnd))) {
    incomplete.push('binding workflow has unsettled availability calls')
  }
  for (const call of calls) {
    if (call.seq < authoringStart || call.seq >= statusEnd) continue
    const source = call.derivedRun?.code ?? call.code
    const status = Number.isSafeInteger(statusQuestionSeq) && call.seq > statusQuestionSeq
    if (typeof source !== 'string') {
      if (status) {
        observations.push({ seq: call.seq, target: call.name, evidence: 'recorded-dispatch' })
        failures.push(`seq ${call.seq}: availability query has no provable cell source`)
      }
      continue
    }
    if (status && call.isError) failures.push(`seq ${call.seq}: availability cell failed`)
    try {
      const ast = parse(source, { sourceType: 'module', allowReturnOutsideFunction: true, plugins: ['typescript'] })
      if (status) {
        let activeEntry
        let constants = new Map()
        try {
          const result = relevant.find(event => event.seq === call.resultSeq)
          const snapshot = userBindingsSnapshotFromMeta(result?.data.meta)
          if (acceptanceProved && saved !== undefined && result?.sourceEventSeqs?.includes(call.seq)
            && snapshot?.fingerprint === call.journal?.userBindingsFingerprint) {
            activeEntry = snapshot.entries.find(item => item.id === entry.id && item.name === entry.name
              && item.scope === entry.scope && item.source === entry.source)
          }
          if (activeEntry !== undefined) constants = constantExportProof(activeEntry, scenario.constantExports)
        } catch (error) {
          failures.push(`seq ${call.seq}: invalid binding source evidence: ${error.message}`)
        }
        const proof = proveStatusSource(source, activeEntry, constants)
        observations.push(...proof.observations.map(observation => ({ seq: call.seq, ...observation })))
        failures.push(...proof.problems.map(problem => `seq ${call.seq}: availability effect evidence is insufficient: ${problem}`))
      }
      traverse(ast, {
        StringLiteral(path) {
          if (status || path.findParent(parent => parent.isCallExpression()
            && ['code.submitBindingDraft', 'tools.submitBindingDraft'].includes(workflowSymbol(parent.node.callee)))) return
          if (/(?:[\\/]\.dsh(?:[\\/]|$)|bindings\.json|deepseek-harness|dsh-ptc-plus)/i.test(path.node.value)) {
            failures.push(`seq ${call.seq}: routine authoring inspects host or binding-storage implementation`)
          }
        },
      })
      for (const nested of call.nestedCalls ?? []) {
        if (status) {
          const target = `${nested.global}.${nested.member}`
          observations.push({ seq: call.seq, target, evidence: 'recorded-dispatch' })
          if (nested.global !== 'capabilities' || !['tree', 'find', 'inspect'].includes(nested.member)) {
            failures.push(`seq ${call.seq}: availability query dispatches an unproved program capability ${target}`)
          }
        }
      }
    } catch {
      failures.push(`seq ${call.seq}: source cannot prove the workflow effect boundary`)
    }
  }
  failures.push(...incomplete)
  return { status: incomplete.length > 0 ? 'incomplete' : failures.length > 0 ? 'unproved' : 'machine-passed',
    failures: [...new Set(failures)], incomplete, actions, observations,
    finalAnswer: { seq: closing?.seq ?? null, review: 'semantic-review-required' } }
}

export const PTC_DIRECT_TOOLS = Object.freeze(['run_code', 'edit_run_code'])

export function isRuntimeContextSource(source) {
  return [
    'plugin:@deepseek-ai/dsh-system-prompt:snapshot',
    'plugin:@deepseek-ai/dsh-system-prompt',
    'plugin:ptc-plus:snapshot', 'plugin:ptc-plus:notice', 'plugin:ptc-plus:catalog',
  ].includes(source)
}

export const MACHINE_BUDGET_KEYS = Object.freeze([
  'maxModelRequests',
  'maxDirectCalls',
  'maxSourceChars',
  'maxRepeatedSourceCalls',
  'maxResultChars',
  'maxAssistantChars',
  'maxTokenTraffic',
  'maxRuntimeContextChars',
])

const BUDGET_METRICS = Object.freeze({
  maxModelRequests: 'modelRequests',
  maxDirectCalls: 'directCalls',
  maxSourceChars: 'sourceChars',
  maxRepeatedSourceCalls: 'repeatedSourceCalls',
  maxResultChars: 'resultChars',
  maxAssistantChars: 'assistantChars',
  maxTokenTraffic: 'tokenTraffic',
  maxRuntimeContextChars: 'runtimeContextChars',
})

const EDIT_NARRATION = /\bedit_run_code\b|dshPtcPlusEdit|derived run_code|edit target|repair target/i
const HEADER_TRANSITION_CONDITIONS = Object.freeze(['route', 'configuration', 'capability'])
const TRAJECTORY_USAGE_KEYS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
])
const MAX_TRAJECTORY_OUTPUT_CHARS = 20_000

function boundedTrajectoryOutput(output) {
  if (output.length <= MAX_TRAJECTORY_OUTPUT_CHARS) return output
  return `${output.slice(0, 10_000)}\n...<truncated>...\n${output.slice(-5_000)}`
}

export function positiveInteger(value, label, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

export function pendingBlindApproval(infrastructureFailures, taskFailures, packetCount) {
  const machinePassed = infrastructureFailures.length === 0 && taskFailures.length === 0
  return {
    machineAcceptance: { status: machinePassed ? 'pass' : 'fail' },
    blindReview: { status: 'pending', packets: packetCount },
    approval: {
      status: machinePassed ? 'pending' : 'blocked',
      reason: machinePassed
        ? 'machine acceptance passed; blind trajectory review is incomplete'
        : 'machine acceptance failed',
    },
  }
}

export function collectModelText(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectModelText(item, output)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'text' && typeof item === 'string') output.push(item)
      else collectModelText(item, output)
    }
  }
  return output
}

/** Normalize the event facts shared by every headless acceptance report. */
export function collectTrajectoryFacts(events, options = {}) {
  if (!Array.isArray(events)) throw new TypeError('trajectory events must be an array')
  const usageKeys = options.usageKeys ?? TRAJECTORY_USAGE_KEYS
  const compareUsageChunks = options.compareUsageChunks ?? true
  if (!Array.isArray(usageKeys) || usageKeys.some(key => typeof key !== 'string' || key.length === 0)) {
    throw new TypeError('trajectory usage keys must be non-empty strings')
  }
  const failures = []
  const calls = new Map()
  const results = new Map()
  const assistantTexts = []
  const usage = Object.fromEntries(usageKeys.map(key => [key, 0]))
  const messageUsages = []
  const chunkUsages = []
  const standaloneUsages = []
  let turnStartedAt
  let turnEndedAt
  let finalTurn

  const decode = (value, label) => {
    try {
      return decodeValue(value)
    } catch (error) {
      failures.push(`${label} contains an invalid PTC value: ${error.message}`)
      return undefined
    }
  }

  for (const event of events) {
    if (event?.type === 'assistant/message') {
      assistantTexts.push(...collectModelText(event.data?.message?.content))
      if (event.data?.usage !== undefined) messageUsages.push(event.data.usage)
      for (const key of usageKeys) {
        const value = event.data?.usage?.[key]
        if (Number.isSafeInteger(value) && value >= 0) usage[key] += value
      }
    }
    if (['assistant/message', 'assistant/attempt'].includes(event?.type)) {
      try {
        const bundled = hostAssistantUsageEvents(event)
        if (bundled !== undefined) {
          const linked = standaloneUsages.filter(item => !item.claimed && event.sourceEventSeqs?.includes(item.seq))
          if (linked.length > 0) {
            if (!isDeepStrictEqual(linked.map(item => item.usage), bundled)) {
              failures.push(`assistant stream at seq ${event.seq} conflicts with linked usage chunks`)
            }
            for (const item of linked) {
              item.claimed = true
              chunkUsages.splice(chunkUsages.indexOf(item.usage), 1)
            }
          }
          for (const item of bundled) {
            if (!isRecord(item) || usageKeys.some(key => item[key] !== undefined
              && (!Number.isSafeInteger(item[key]) || item[key] < 0))) {
              throw new TypeError('usage must contain non-negative safe integer token counts')
            }
          }
          const last = bundled.at(-1)
          if (event.type === 'assistant/message') {
            if (compareUsageChunks && !isDeepStrictEqual(event.data.usage, last)) {
              failures.push(`assistant message usage does not match usage chunks at seq ${event.seq}`)
            }
            if (last !== undefined) chunkUsages.push(last)
          } else if (last !== undefined) {
            // Attempts without a surface message still consume reported quota.
            for (const key of usageKeys) {
              if (Number.isSafeInteger(last[key]) && last[key] >= 0) usage[key] += last[key]
            }
          }
        }
      } catch (error) {
        failures.push(`invalid assistant stream at seq ${event.seq}: ${error.message}`)
      }
    }
    if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
      standaloneUsages.push({ seq: event.seq, usage: event.data.chunk.usage, claimed: false })
      chunkUsages.push(event.data.chunk.usage)
    }
    if (event?.type === 'turn/start' && Number.isFinite(event.time)) turnStartedAt ??= event.time
    if (event?.type === 'turn/end') {
      finalTurn = event
      if (Number.isFinite(event.time)) turnEndedAt = event.time
    }
    if (event?.type === 'tool/call') {
      const data = event.data ?? {}
      if (typeof data.callId !== 'string') {
        failures.push(`tool call at seq ${event.seq} has no call id`)
        continue
      }
      let args
      try {
        args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
      } catch {
        failures.push(`tool call ${data.callId} has invalid JSON arguments`)
      }
      if (calls.has(data.callId)) failures.push(`duplicate tool call id ${data.callId}`)
      calls.set(data.callId, {
        seq: event.seq,
        callId: data.callId,
        name: data.name,
        arguments: args,
        code: args?.code,
        description: args?.description,
      })
    }
    if (event?.type === 'tool/result') {
      const data = event.data ?? {}
      const message = data.message ?? {}
      const content = Array.isArray(message.content) ? message.content : []
      const callId = message.source?.callId ?? data.callId
      const output = collectModelText(content).join('\n')
      const isError = data.isError === true || data.error !== undefined
        || content.some(item => item?.isError === true)
      let journal
      if (data.meta?.dshPtcPlus !== undefined) {
        try {
          journal = normalizeJournal(data.meta.dshPtcPlus)
        } catch (error) {
          failures.push(`invalid PTC journal for ${String(callId ?? 'unknown')}: ${error.message}`)
        }
      }
      const nestedCalls = Array.isArray(journal?.calls)
        ? journal.calls.map((call, index) => Object.defineProperty({
            global: String(call.global),
            member: String(call.member),
            argsWire: call.args,
            ok: call.ok === true,
            ...(call.ok === true ? { value: decode(call.value, `journal call ${index + 1}`) } : {}),
            ...(call.ok === false ? { error: String(call.error ?? 'unknown error') } : {}),
          }, 'args', {
            // Reports retain the wire graph; decoded args may contain cycles or bigint.
            value: decode(call.args, `journal call ${index + 1} arguments`),
          }))
        : []
      const completion = journal?.completion?.kind === 'return'
        ? {
            kind: 'return',
            hasValue: journal.completion.hasValue,
            ...(journal.completion.hasValue ? { value: decode(journal.completion.value, 'journal completion') } : {}),
          }
        : journal?.completion
      if (typeof callId !== 'string') {
        failures.push(`tool result at seq ${event.seq} has no call id`)
        continue
      }
      if (results.has(callId)) failures.push(`duplicate tool result id ${callId}`)
      results.set(callId, {
        resultSeq: event.seq,
        callId,
        isError,
        resultError: isError,
        output: boundedTrajectoryOutput(output),
        outputChars: output.length,
        journal,
        journalStatus: journal?.status,
        diagnostics: journal?.diagnostics ?? [],
        nestedCalls,
        completion,
        editTarget: data.meta?.dshPtcPlusEdit,
        derivedRun: data.meta?.dshPtcPlusDerivedRun,
      })
    }
  }

  for (const [callId, call] of calls) {
    const result = results.get(callId)
    if (result === undefined) failures.push(`tool call ${callId} has no matching result`)
    else if (result.resultSeq <= call.seq) failures.push(`tool result ${callId} does not follow its call`)
  }
  for (const callId of results.keys()) if (!calls.has(callId)) failures.push(`tool result ${callId} has no matching call`)
  if (compareUsageChunks && !isDeepStrictEqual(messageUsages, chunkUsages)) {
    failures.push('assistant message usage does not match usage chunks')
  }
  if (events.some(event => event?.type === 'session/title-llm-request')) {
    failures.push('session-title auxiliary model call was not disabled')
  }
  const timeline = [...calls.values()].sort((left, right) => left.seq - right.seq).map(call => ({
    ...call,
    ...(results.get(call.callId) ?? { resultMissing: true }),
  }))
  return {
    failures: [...new Set(failures)],
    calls,
    results,
    assistantTexts,
    usage,
    messageUsages,
    chunkUsages,
    turnStartedAt,
    turnEndedAt,
    turnWallMs: turnStartedAt === undefined || turnEndedAt === undefined
      ? undefined
      : turnEndedAt - turnStartedAt,
    finalTurn,
    timeline,
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateProgramWork(policy = {}) {
  if (!isRecord(policy) || Object.keys(policy).some(key => !['inspectionSymbols', 'callLimits'].includes(key))) {
    throw new TypeError('programWork must contain only inspectionSymbols and callLimits')
  }
  if (policy.inspectionSymbols !== undefined
    && (!Array.isArray(policy.inspectionSymbols) || policy.inspectionSymbols.length === 0
      || policy.inspectionSymbols.some(symbol => typeof symbol !== 'string' || symbol === '')
      || new Set(policy.inspectionSymbols).size !== policy.inspectionSymbols.length)) {
    throw new TypeError('programWork.inspectionSymbols must contain unique non-empty symbols')
  }
  const limits = policy.callLimits ?? []
  if (!Array.isArray(limits)) throw new TypeError('programWork.callLimits must be an array')
  const members = new Set()
  for (const limit of limits) {
    if (!isRecord(limit)
      || Object.keys(limit).some(key => !['global', 'member', 'maxCalls', 'maxCallsPerArguments'].includes(key))
      || typeof limit.global !== 'string' || limit.global === ''
      || typeof limit.member !== 'string' || limit.member === ''
      || !Number.isSafeInteger(limit.maxCalls) || limit.maxCalls < 0
      || (limit.maxCallsPerArguments !== undefined
        && (!Number.isSafeInteger(limit.maxCallsPerArguments) || limit.maxCallsPerArguments < 1))) {
      throw new TypeError('programWork.callLimits requires global/member, non-negative maxCalls and optional positive maxCallsPerArguments')
    }
    const key = JSON.stringify([limit.global, limit.member])
    if (members.has(key)) throw new TypeError('programWork.callLimits contains a duplicate member')
    members.add(key)
  }
  return policy
}

/** Workload limits describe observations, never permission to suppress a live call. */
export function auditProgramWork(timeline, policy = {}) {
  validateProgramWork(policy)
  const failures = []
  const calls = timeline.flatMap(cell => cell.nestedCalls ?? [])
  const decoded = new Map()
  for (const [index, call] of calls.entries()) {
    try {
      decoded.set(call, decodeValue(call.argsWire))
    } catch (error) {
      failures.push(`program call ${index + 1} has invalid argument evidence: ${error.message}`)
    }
  }
  if (policy.inspectionSymbols !== undefined) {
    const allowed = new Set(policy.inspectionSymbols)
    for (const call of calls.filter(call => call.global === 'capabilities' && call.member === 'inspect')) {
      const args = decoded.get(call)
      if (!isRecord(args) || !Array.isArray(args.symbols) || args.symbols.length === 0) {
        failures.push('focused inspection requires explicit non-empty symbols')
        continue
      }
      for (const symbol of args.symbols) {
        if (!allowed.has(symbol)) failures.push(`unrelated capability inspection: ${String(symbol)}`)
      }
    }
  }
  const observations = (policy.callLimits ?? []).map(limit => {
    const matching = calls.filter(call => call.global === limit.global && call.member === limit.member)
    const groups = []
    for (const call of matching) {
      if (!decoded.has(call)) continue
      const args = decoded.get(call)
      const group = groups.find(group => isDeepStrictEqual(group.args, args))
      if (group === undefined) groups.push({ args, count: 1 })
      else group.count += 1
    }
    const symbol = `${limit.global}.${limit.member}`
    if (matching.length > limit.maxCalls) {
      failures.push(`${symbol} has ${matching.length} calls; workload maximum is ${limit.maxCalls}`)
    }
    const maxArgumentCalls = Math.max(0, ...groups.map(group => group.count))
    if (limit.maxCallsPerArguments !== undefined && maxArgumentCalls > limit.maxCallsPerArguments) {
      failures.push(`${symbol} repeats identical arguments ${maxArgumentCalls} times; workload maximum is ${limit.maxCallsPerArguments}`)
    }
    return {
      global: limit.global, member: limit.member, calls: matching.length,
      repeatedArgumentCalls: groups.reduce((total, group) => total + group.count - 1, 0),
    }
  })
  return { observations, failures: [...new Set(failures)] }
}

export function validateGuardMismatchEdits(ordinals = []) {
  if (!Array.isArray(ordinals) || ordinals.some(value => !Number.isSafeInteger(value) || value < 1)
    || new Set(ordinals).size !== ordinals.length) {
    throw new TypeError('guardMismatchEdits must contain unique positive edit ordinals')
  }
  return ordinals
}

/** Audit the canonical editor and dispatch-time target, independently of task deltas. */
export function auditEditCalls(events, timeline, guardMismatchEdits = []) {
  const expectedMismatches = new Set(validateGuardMismatchEdits(guardMismatchEdits))
  const rejectedCallIds = new Set()
  const failures = []
  const edits = timeline.filter(call => call.name === 'edit_run_code')
  for (const [index, edit] of edits.entries()) {
    const label = `edit_run_code call ${edit.callId}`
    const target = editTargetForCall({ session: { events } }, edit.callId, edit.seq)
    const correction = editRejectedCell(edit.arguments, target?.source)
    if (!correction.edited) {
      failures.push(`${label} fails canonical edit validation: ${correction.reason}`)
      continue
    }
    const guard = edit.arguments[EXPECTED_TARGET_CALL_SEQ]
    const mismatch = guard !== undefined && guard !== target.callSeq
    let value
    try { value = JSON.parse(edit.output) } catch { /* The editor renders one JSON result. */ }
    if (expectedMismatches.has(index + 1)) {
      if (!mismatch || edit.isError || !isRecord(value) || value.edited !== false
        || typeof value.reason !== 'string' || value.reason === ''
        || Object.keys(value).some(key => !['edited', 'reason'].includes(key))
        || edit.journal !== undefined || edit.editTarget !== undefined || edit.derivedRun !== undefined) {
        failures.push(`${label} did not prove guard rejection without derived execution`)
      } else rejectedCallIds.add(edit.callId)
    } else {
      if (mismatch) failures.push(`${label} guard does not match its captured target`)
      if (!isRecord(value) || value.edited !== true) failures.push(`${label} result does not report an applied edit`)
      if (edit.editTarget?.targetCallSeq !== target.callSeq) {
        failures.push(`${label} result does not identify its captured target`)
      }
      if (edit.derivedRun?.code !== correction.code || edit.derivedRun?.description !== correction.description) {
        failures.push(`${label} derived run does not match the canonical edit`)
      }
    }
  }
  for (const ordinal of expectedMismatches) {
    if (ordinal > edits.length) failures.push(`guardMismatchEdits names missing edit ${ordinal}`)
  }
  return { failures, rejectedCallIds }
}

function canonicalRequestHeader(header) {
  if (!isRecord(header) || !isRecord(header.config)) {
    throw new TypeError('request header must contain an object config')
  }
  if (header.system !== undefined && typeof header.system !== 'string') {
    throw new TypeError('request header system must be a string')
  }
  if (header.tools !== undefined && !Array.isArray(header.tools)) {
    throw new TypeError('request header tools must be an array')
  }
  if (header.adapterDefaults !== undefined && !isRecord(header.adapterDefaults)) {
    throw new TypeError('request header adapterDefaults must be an object')
  }
  const adapterDefaults = header.adapterDefaults
  return {
    config: header.config,
    ...adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true
      ? { adapterDefaults }
      : {},
    ...header.system !== undefined && header.system.length > 0 ? { system: header.system } : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}

function jsonValuesEqual(left, right, orderedRecords = false) {
  return firstJsonDifference(left, right, '', orderedRecords) === undefined
}

function appendPath(path, key, array) {
  if (array) return `${path}[${key}]`
  return path === '' ? key : `${path}.${key}`
}

function firstJsonDifference(left, right, path, orderedRecords = false) {
  if (Object.is(left, right)) return undefined
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path
    if (left.length !== right.length) return `${path}.length`
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstJsonDifference(
        left[index], right[index], appendPath(path, index, true), orderedRecords,
      )
      if (difference !== undefined) return difference
    }
    return undefined
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return path
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (!orderedRecords) {
      leftKeys.sort()
      rightKeys.sort()
    }
    const length = Math.max(leftKeys.length, rightKeys.length)
    for (let index = 0; index < length; index += 1) {
      if (leftKeys[index] !== rightKeys[index]) return `${path || 'header'} keys[${index}]`
      const key = leftKeys[index]
      const difference = firstJsonDifference(
        left[key], right[key], appendPath(path, key, false), orderedRecords,
      )
      if (difference !== undefined) return difference
    }
    return undefined
  }
  return path
}

function firstRequestHeaderDifference(before, after) {
  for (const [field, orderedRecords] of [
    ['config', false],
    ['adapterDefaults', false],
    ['system', false],
    ['tools', true],
  ]) {
    const difference = firstJsonDifference(before[field], after[field], field, orderedRecords)
    if (difference !== undefined) return difference
  }
  return undefined
}

function configWithoutRoute(config) {
  return Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'provider' && key !== 'model'))
}

function changedHeaderConditions(before, after) {
  const conditions = []
  const routeChanged = before.config.provider !== after.config.provider
    || before.config.model !== after.config.model
  const configChanged = !jsonValuesEqual(before.config, after.config)
  const nonRouteConfigChanged = !jsonValuesEqual(
    configWithoutRoute(before.config),
    configWithoutRoute(after.config),
  )
  if (routeChanged) conditions.push('route')
  if ((configChanged && (!routeChanged || nonRouteConfigChanged))
    || !jsonValuesEqual(before.adapterDefaults, after.adapterDefaults)
    || before.system !== after.system) conditions.push('configuration')
  if (!jsonValuesEqual(before.tools ?? [], after.tools ?? [], true)) conditions.push('capability')
  return conditions
}

export function validateRequestHeaderPolicy(policy = {}) {
  if (!isRecord(policy)) throw new TypeError('request header policy must be an object')
  const extra = Object.keys(policy).filter(key => !['allowedTransitions', 'historyReplacements'].includes(key))
  if (extra.length > 0) throw new TypeError(`request header policy contains unknown field ${extra[0]}`)
  const historyReplacements = policy.historyReplacements ?? 0
  if (!Number.isSafeInteger(historyReplacements) || historyReplacements < 0) {
    throw new TypeError('request header policy historyReplacements must be a non-negative safe integer')
  }
  const transitions = policy.allowedTransitions ?? []
  if (!Array.isArray(transitions)) {
    throw new TypeError('request header policy allowedTransitions must be an array')
  }
  const allowed = new Map()
  for (const [index, transition] of transitions.entries()) {
    if (!isRecord(transition)
      || !Number.isSafeInteger(transition.epoch) || transition.epoch < 2
      || !HEADER_TRANSITION_CONDITIONS.includes(transition.condition)) {
      throw new TypeError(`request header policy transition ${index + 1} requires an epoch >= 2 and a known condition`)
    }
    const transitionExtra = Object.keys(transition).filter(key => !['epoch', 'condition'].includes(key))
    if (transitionExtra.length > 0) {
      throw new TypeError(`request header policy transition ${index + 1} contains unknown field ${transitionExtra[0]}`)
    }
    const conditions = allowed.get(transition.epoch) ?? new Set()
    if (conditions.has(transition.condition)) {
      throw new TypeError(`duplicate request header transition ${transition.epoch}/${transition.condition}`)
    }
    conditions.add(transition.condition)
    allowed.set(transition.epoch, conditions)
  }
  return { allowed, historyReplacements }
}

/** Compare every canonical request envelope and require explicit non-stable transitions. */
export function auditRequestHeaders(events, policy = {}) {
  if (!Array.isArray(events)) throw new TypeError('request header events must be an array')
  const { allowed, historyReplacements: expectedHistoryReplacements } = validateRequestHeaderPolicy(policy)
  const failures = []
  const headers = []
  const historyReplacements = events.filter(event => event?.surfaceOp?.op === 'replace').length
  if (historyReplacements !== expectedHistoryReplacements) {
    failures.push(`history replacements are ${historyReplacements}; scenario policy requires ${expectedHistoryReplacements}`)
  }
  let previous
  let headerEpochs = 0
  let headerChanges = 0
  for (const event of events) {
    if (event?.type !== 'request/header') continue
    const epoch = ++headerEpochs
    const reason = event.data?.reason
    if (reason === 'change') headerChanges += 1
    let header
    try {
      header = canonicalRequestHeader(event.data?.header)
    } catch (error) {
      failures.push(`request header epoch ${epoch} is invalid: ${error.message}`)
      continue
    }
    headers.push({ epoch, seq: event.seq, reason, header })
    if (!HOST_HEADER_REASONS.includes(reason)) {
      failures.push(`request header epoch ${epoch} has invalid reason ${String(reason)}`)
    } else if (epoch === 1 && ['change', 'series'].includes(reason)) {
      failures.push(`request header epoch 1 cannot have reason ${reason}`)
    } else if (epoch > 1 && reason === 'initial') {
      failures.push(`request header epoch ${epoch} cannot have reason initial`)
    }
    if (previous !== undefined) {
      const difference = firstRequestHeaderDifference(previous, header)
      const changed = changedHeaderConditions(previous, header)
      const approved = allowed.get(epoch) ?? new Set()
      if (difference === undefined && reason === 'change') {
        failures.push(`request header epoch ${epoch} has reason change but its canonical header is unchanged`)
      } else if (difference !== undefined) {
        if (reason === 'series') failures.push(`request header epoch ${epoch} has reason series but its canonical header changed`)
        const unapproved = changed.filter(condition => !approved.has(condition))
        const unused = [...approved].filter(condition => !changed.includes(condition))
        if (unapproved.length > 0 || unused.length > 0) {
          const conditions = changed.join(', ') || 'unclassified'
          failures.push(`request header epoch ${epoch} changed ${difference} under ${conditions} without an exact scenario policy`)
        }
      } else if (approved.size > 0) {
        failures.push(`request header epoch ${epoch} declared a transition but its canonical header is unchanged`)
      }
    }
    previous = header
  }
  for (const epoch of allowed.keys()) {
    if (epoch > headerEpochs) failures.push(`request header policy names missing epoch ${epoch}`)
  }
  if (headerEpochs === 0) failures.push('session log contains no request/header epoch')
  return {
    headers,
    headerEpochs,
    headerChanges,
    historyReplacements,
    failures: [...new Set(failures)],
  }
}

/** Count logical model loop steps without inferring physical adapter attempts. */
export function auditModelRequests(events) {
  if (!Array.isArray(events)) throw new TypeError('model request events must be an array')
  const steps = events.filter(event => event?.type === 'step/start').map(event => ({
    seq: event.seq,
    turn: event.data?.turn,
    step: event.data?.step,
  }))
  return { modelRequests: steps.length, steps }
}

export function validateEditTransports(transports, label = 'editTransports', options = {}) {
  if (!Array.isArray(transports) || transports.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  for (const [index, transport] of transports.entries()) {
    const itemLabel = `${label}[${index}]`
    if (transport === null || typeof transport !== 'object' || Array.isArray(transport)) {
      throw new TypeError(`${itemLabel} must be an object`)
    }
    const fields = ['originalSource', 'oldString', 'newString', 'repairedSource']
    for (const field of fields) {
      if (typeof transport[field] !== 'string' || transport[field].length === 0) {
        throw new TypeError(`${itemLabel}.${field} must be a non-empty string`)
      }
    }
    if (transport.oldString === transport.newString) {
      throw new TypeError(`${itemLabel} edit must change the source`)
    }
    if (options.allowTemplates !== true) {
      const match = transport.originalSource.indexOf(transport.oldString)
      if (match < 0 || match !== transport.originalSource.lastIndexOf(transport.oldString)) {
        throw new TypeError(`${itemLabel}.oldString must occur exactly once in originalSource`)
      }
      const repaired = transport.originalSource.slice(0, match)
        + transport.newString
        + transport.originalSource.slice(match + transport.oldString.length)
      if (repaired !== transport.repairedSource) {
        throw new TypeError(`${itemLabel}.repairedSource does not equal the declared edit`)
      }
    }
    if (transport.targetStatus !== undefined
      && !['durable', 'volatile', 'discarded', 'noop'].includes(transport.targetStatus)) {
      throw new TypeError(`${itemLabel}.targetStatus is invalid`)
    }
    const extra = Object.keys(transport).filter(field => ![...fields, 'targetStatus'].includes(field))
    if (extra.length > 0) throw new TypeError(`${itemLabel} contains unknown field ${extra[0]}`)
  }
  return transports
}

function visibleTextContainsSource(text, source) {
  if (typeof text !== 'string') return false
  const encoded = JSON.stringify(source).slice(1, -1)
  return text.includes(source) || text.includes(encoded)
}

/** Verify truthful ordered edit calls while keeping materialized sources private. */
export function auditEditTransports(timeline, transports) {
  validateEditTransports(transports)
  if (!Array.isArray(timeline)) throw new TypeError('edit transport timeline must be an array')
  const failures = []
  let cursor = 0
  for (const [index, transport] of transports.entries()) {
    const label = `edit transport ${index + 1}`
    const runIndex = timeline.findIndex((call, candidate) => candidate >= cursor
      && call?.name === 'run_code' && call.code === transport.originalSource)
    if (runIndex < 0) {
      failures.push(`${label} did not send its exact original source`)
      continue
    }
    const run = timeline[runIndex]
    const edit = timeline[runIndex + 1]
    cursor = runIndex + 2
    if (timeline.some(call => call?.name === 'run_code' && call.seq > run.seq
      && call.code === transport.repairedSource)) {
      failures.push(`${label} was resent as a model-authored run_code`)
    }
    if (edit?.name !== 'edit_run_code') {
      failures.push(`${label} was not followed by edit_run_code`)
      continue
    }
    if (transport.targetStatus !== undefined && run.journalStatus !== transport.targetStatus) {
      failures.push(`${label} target status is ${String(run.journalStatus)} instead of ${transport.targetStatus}`)
    }
    const delta = edit.arguments?.edits
    if (!Array.isArray(delta) || delta.length !== 1
      || delta[0]?.old_string !== transport.oldString
      || delta[0]?.new_string !== transport.newString) {
      failures.push(`${label} did not preserve its literal delta`)
    }
    if (edit.derivedRun?.code !== transport.repairedSource
      || typeof edit.derivedRun?.description !== 'string') {
      failures.push(`${label} result omitted its private materialized derived run`)
    }
    if (edit.editTarget?.targetCallSeq !== run.seq) {
      failures.push(`${label} result does not identify its source call`)
    }
    const editArguments = JSON.stringify(edit.arguments ?? {})
    if (editArguments.includes(transport.originalSource)
      || editArguments.includes(transport.repairedSource)) {
      failures.push(`${label} resent materialized source in its arguments`)
    }
    if (visibleTextContainsSource(edit.output, transport.originalSource)
      || visibleTextContainsSource(edit.output, transport.repairedSource)) {
      failures.push(`${label} exposed materialized source in its model-visible result`)
    }
  }
  return [...new Set(failures)]
}

function sourceLabel(source) {
  return [source?.kind, source?.plugin, source?.form]
    .filter(value => typeof value === 'string').join(':') || 'unknown'
}

function sectionOwner(name) {
  if (name.startsWith('tools:ptc-plus-')) return 'ptc-plus'
  const separator = name.indexOf(':')
  return separator < 0 ? name : name.slice(0, separator)
}

function allowedSections(config) {
  const entries = config?.allowed ?? []
  if (!Array.isArray(entries)) throw new TypeError('runtimeContexts.allowed must be an array')
  const allowed = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.name !== 'string' || !entry.name.startsWith('tools:ptc-plus-')
      || !Number.isSafeInteger(entry.maxChars) || entry.maxChars < 1) {
      throw new TypeError('runtimeContexts.allowed entries require a PTC Plus name and positive maxChars')
    }
    const extra = Object.keys(entry).filter(key => !['name', 'maxChars'].includes(key))
    if (extra.length > 0) throw new TypeError(`runtimeContexts.allowed entry contains unknown field ${extra[0]}`)
    if (allowed.has(entry.name)) throw new TypeError(`duplicate allowed runtime context ${entry.name}`)
    allowed.set(entry.name, entry.maxChars)
  }
  return allowed
}

function requiredTransitions(config, allowed) {
  const entries = config?.requiredTransitions ?? []
  if (!Array.isArray(entries)) throw new TypeError('runtimeContexts.requiredTransitions must be an array')
  const seen = new Set()
  return entries.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.name !== 'string' || !['append', 'update', 'clear'].includes(entry.type)) {
      throw new TypeError('runtimeContexts.requiredTransitions entries require name and append, update, or clear type')
    }
    const extra = Object.keys(entry).filter(key => !['name', 'type'].includes(key))
    if (extra.length > 0) throw new TypeError(`runtimeContexts.requiredTransitions entry contains unknown field ${extra[0]}`)
    if (!allowed.has(entry.name)) {
      throw new TypeError(`runtimeContexts.requiredTransitions names unallowed context ${entry.name}`)
    }
    const key = `${entry.name}\0${entry.type}`
    if (seen.has(key)) throw new TypeError(`duplicate required runtime context transition ${entry.name}/${entry.type}`)
    seen.add(key)
    return { name: entry.name, type: entry.type }
  })
}

export function validateRuntimeContextConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('runtimeContexts must be an object')
  }
  const extra = Object.keys(config).filter(key => !['allowed', 'requiredTransitions', 'maxSnapshotChars'].includes(key))
  if (extra.length > 0) throw new TypeError(`runtimeContexts contains unknown field ${extra[0]}`)
  const allowed = allowedSections(config)
  const required = requiredTransitions(config, allowed)
  const maxSnapshotChars = config.maxSnapshotChars ?? 16_384
  if (!Number.isSafeInteger(maxSnapshotChars) || maxSnapshotChars < 1) {
    throw new TypeError('runtimeContexts.maxSnapshotChars must be a positive safe integer')
  }
  return { allowed, required, maxSnapshotChars }
}

function snapshotSections(event, failures, allowed, maxSnapshotChars) {
  const raw = event.data?.source?.sections
  if (!Array.isArray(raw)) {
    failures.push(`runtime snapshot at seq ${String(event.seq ?? 'unknown')} has no named sections`)
    return []
  }
  const names = new Set()
  const sections = []
  let snapshotChars = 0
  for (const section of raw) {
    const name = section?.name
    const text = section?.text
    if (typeof name !== 'string' || name.length === 0 || typeof text !== 'string') {
      failures.push(`runtime snapshot at seq ${String(event.seq ?? 'unknown')} contains an unnamed or non-text section`)
      continue
    }
    if (names.has(name)) failures.push(`runtime snapshot at seq ${String(event.seq ?? 'unknown')} duplicates section ${name}`)
    names.add(name)
    snapshotChars += text.length
    const owner = sectionOwner(name)
    if (owner === 'ptc-plus') {
      const bound = allowed.get(name)
      if (bound === undefined) failures.push(`runtime snapshot contains disallowed PTC Plus section ${name}`)
      else if (text.length > bound) failures.push(`runtime context ${name} has ${text.length} chars; budget is ${bound}`)
      if (EDIT_NARRATION.test(`${name}\n${text}`)) {
        failures.push(`runtime context ${name} narrates edit execution already represented by its tool call and result`)
      }
    }
    sections.push({ name, owner, text, chars: text.length })
  }
  if (snapshotChars > maxSnapshotChars) {
    failures.push(`runtime snapshot has ${snapshotChars} section chars; budget is ${maxSnapshotChars}`)
  }
  return sections
}

/** Audit independently owned state and notices alongside historical aggregates. */
export function auditRuntimeContexts(events, config = {}) {
  const failures = []
  const { allowed, required, maxSnapshotChars } = validateRuntimeContextConfig(config)
  const snapshots = []
  const requests = []
  const sources = []
  let effective = new Map()
  const priorSignatures = new Map()
  const deliveredNotices = new Set()
  const producerStates = new Map()
  const committedSnapshots = new Map()
  const sourceEvents = []
  const combinedState = () => new Map([
    ...[...(producerStates.get('aggregate') ?? [])].filter(([name]) => (
      !producerStates.has('ptc-plus') || !name.startsWith('tools:ptc-plus-')
    )),
    ...(producerStates.get('ptc-plus') ?? []),
    ...(producerStates.get('ptc-plus/catalog') ?? []),
  ])
  const restoreSurface = nodes => {
    producerStates.clear()
    priorSignatures.clear()
    for (const seq of nodes) {
      const record = committedSnapshots.get(seq)
      if (record === undefined) continue
      producerStates.set(record.producer, record.state)
      priorSignatures.set(record.producer, record.signature)
    }
  }
  let nextRequestIndex = 1
  for (const event of events) {
    if (Number.isSafeInteger(event.seq)) sourceEvents.push(event)
    let replacementNodes
    if (event.surfaceOp?.op === 'replace') {
      try {
        replacementNodes = foldSurface(sourceEvents).nodes
        restoreSurface(replacementNodes)
        effective = combinedState()
      } catch {
        failures.push(`cannot verify runtime context surface at seq ${String(event.seq)}`)
        producerStates.clear()
        priorSignatures.clear()
        effective.clear()
      }
    }
    const source = event.data?.source
    const aggregate = event.type === 'user/message' && source?.kind === 'plugin'
      && source.plugin === '@deepseek-ai/dsh-system-prompt'
    const aggregateClear = aggregate && source.form === undefined
      && collectModelText(event.data?.content).join('\n') === 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
    const ptc = event.type === 'user/message' ? readRuntimeMessage(event.data) : undefined
    if (event.type === 'user/message' && source?.plugin === 'ptc-plus'
      && ['snapshot', 'notice', 'catalog'].includes(source.form) && ptc === undefined
      && readBindingAction(event.data) === undefined) {
      failures.push(`malformed PTC runtime message at seq ${String(event.seq ?? 'unknown')}`)
    }
    const isSnapshot = aggregate && source.form === 'snapshot' || aggregateClear || ptc !== undefined
    if (event.type === 'user/message' && source?.kind !== 'user') sources.push(sourceLabel(source))
    if (isSnapshot) {
      const rawSections = aggregateClear ? [] : ptc?.form === 'notice' ? [{ name: ptc.name, text: ptc.text }]
        : ptc?.sections ?? event.data.source.sections
      const sections = snapshotSections({ ...event, data: { source: { sections: rawSections } } }, failures, allowed, maxSnapshotChars)
      const producer = aggregate ? 'aggregate' : ptc?.form === 'catalog' ? 'ptc-plus/catalog' : 'ptc-plus'
      const signature = JSON.stringify(sections.map(({ name, text }) => [name, text]))
      if (ptc?.form === 'notice' ? deliveredNotices.has(ptc.name) : signature === priorSignatures.get(producer)) {
        failures.push(ptc?.form === 'notice'
          ? `PTC notice at seq ${String(event.seq ?? 'unknown')} repeats a delivered identity`
          : `runtime snapshot at seq ${String(event.seq ?? 'unknown')} repeats an unchanged ${producer === 'aggregate' ? 'aggregate' : 'PTC state'}`)
      }
      if (ptc?.form === 'notice') deliveredNotices.add(ptc.name)
      else priorSignatures.set(producer, signature)
      if (aggregate) {
        for (const section of sections) {
          if (recoveryTipIdentity(section.name) !== undefined) deliveredNotices.add(section.name)
        }
      }
      const current = new Map(sections.map(section => [section.name, section]))
      const transitions = []
      const previousBinding = effective.get(PTC_BINDING_CATALOG)?.text
      if (previousBinding !== undefined && current.get(PTC_BINDING_CATALOG)?.text === previousBinding) {
        failures.push(`runtime context at seq ${event.seq} repeats unchanged binding documentation`)
      }
      if (ptc?.form !== 'notice') {
        producerStates.set(producer, current)
        committedSnapshots.set(event.seq, { producer, state: current, signature })
        if (replacementNodes !== undefined) restoreSurface(replacementNodes)
      }
      const combined = combinedState()
      const ptcNames = new Set([
        ...[...effective.keys()].filter(name => name.startsWith('tools:ptc-plus-')),
        ...[...combined.keys()].filter(name => name.startsWith('tools:ptc-plus-')),
      ])
      for (const name of ptcNames) {
        const before = effective.get(name)?.text
        const after = combined.get(name)?.text
        if (before === undefined && after !== undefined) transitions.push({ name, type: 'append' })
        else if (before !== undefined && after === undefined) transitions.push({ name, type: 'clear' })
        else if (before !== after) transitions.push({ name, type: 'update' })
      }
      if (ptc?.form === 'notice') transitions.push({ name: ptc.name, type: 'append' })
      effective = combined
      const messageChars = collectModelText(event.data?.content).join('\n').length
      const ptcPlusSectionChars = sections
        .filter(section => section.owner === 'ptc-plus')
        .reduce((total, section) => total + section.chars, 0)
      snapshots.push({
        seq: event.seq,
        producer,
        form: ptc?.form ?? 'snapshot',
        nextRequestIndex,
        messageChars,
        ptcPlusSectionChars,
        otherSectionChars: sections.reduce((total, section) => total + section.chars, 0) - ptcPlusSectionChars,
        sections,
        transitions,
      })
      continue
    }
    if (event.type === 'request/header') {
      requests.push({
        index: nextRequestIndex,
        seq: event.seq,
        sections: [...effective.values()].map(section => ({ ...section })),
      })
      nextRequestIndex += 1
    }
  }
  const observedTransitions = snapshots.flatMap(snapshot => snapshot.transitions)
  for (const expected of required) {
    if (!observedTransitions.some(item => item.name === expected.name && item.type === expected.type)) {
      failures.push(`runtime context ${expected.name} never performed required ${expected.type}`)
    }
  }
  return {
    sources,
    snapshots,
    requests,
    totalMessageChars: snapshots.reduce((total, snapshot) => total + snapshot.messageChars, 0),
    failures: [...new Set(failures)],
  }
}

export function validateMachineBudget(budget, label = 'machine budget') {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    throw new TypeError(`${label} must be an object`)
  }
  for (const key of MACHINE_BUDGET_KEYS) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 0) {
      throw new TypeError(`${label}.${key} must be a non-negative safe integer`)
    }
  }
  const extra = Object.keys(budget).filter(key => !MACHINE_BUDGET_KEYS.includes(key))
  if (extra.length > 0) throw new TypeError(`${label} contains unknown field ${extra[0]}`)
  return budget
}

export function machineBudgetFailures(metrics, budget, label = 'trajectory') {
  validateMachineBudget(budget)
  const failures = []
  for (const [limit, metric] of Object.entries(BUDGET_METRICS)) {
    const observed = metrics[metric]
    if (!Number.isSafeInteger(observed) || observed < 0) {
      throw new TypeError(`${label} metric ${metric} must be a non-negative safe integer`)
    }
    if (observed > budget[limit]) {
      failures.push(`${label} ${metric} is ${observed}; budget is ${budget[limit]}`)
    }
  }
  return failures
}
