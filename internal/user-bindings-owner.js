import { PTC_MESSAGE_SOURCE_KIND } from './message-sources.js'
import { RPC_CONTRACTS } from './rpc-contract.js'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { IsolatedOwner } from './isolated-worker.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  createBoundedWorkerRound,
  ROUND_CANCELLED,
  ROUND_OUTPUT_LIMIT,
  ROUND_TIMEOUT,
} from './bounded-worker-round.js'
import { BINDING_SUBMISSION, bindingAuthoringInstructions } from './user-binding-authoring.js'
import { bindingActionNotice, USER_BINDING_DRAFT_META_KEY } from './user-binding-draft-projection.js'
import { bindingModelPreferences } from './user-binding-model-context.js'
import { sessionEvents } from './session-events.js'
import { processExitDescription } from './failure-reporting.js'
import { decodeValue } from './value-wire.js'
import { valueLimitsFromConfig } from './value-wire-schema.js'
import { normalizeWorkerEnvironment } from './worker-client.js'
import { UserBindingsStore } from './user-bindings-store.js'
import { UserBindingConsole } from './user-binding-console.js'
import {
  createUserBindingsSnapshot,
  normalizeUserBindingEntry,
  normalizeUserBindingsDocument,
  storedUserBindingsDocument,
} from './user-bindings.js'

const RPC_CONTRACT = RPC_CONTRACTS.bindings
const RUNNER_URL = new URL('./user-binding-runner.js', import.meta.url)
const RUNNER_HELPER = new URL('./kernel-child.js', import.meta.url)
const COMMAND_USAGE = '/binding new <requirement> or /binding edit <id> <requirement>'
const CANDIDATE_FAILURE_LOGS = Symbol('candidate failure logs')

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorResult(error) {
  const logs = error?.[CANDIDATE_FAILURE_LOGS]
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'bindings/error',
      message: error instanceof Error ? error.message : String(error),
      details: Array.isArray(logs) ? { logs } : {},
    },
  }
}

function storedEntry(entry) {
  return storedUserBindingsDocument({ entries: [entry] }).entries[0]
}

function sessionIdOf(agent) {
  const value = agent?.session?.id ?? agent?.id
  return value === undefined ? undefined : String(value)
}

function parseAuthoringCommand(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (input === '') return { kind: 'help' }
  const newMatch = /^new(?:\s+([\s\S]+))?$/.exec(input)
  if (newMatch !== null) {
    const requirement = newMatch[1]?.trim() ?? ''
    return requirement === '' ? { kind: 'help' } : { kind: 'new', requirement }
  }
  const editMatch = /^edit\s+(\S+)(?:\s+([\s\S]+))?$/.exec(input)
  if (editMatch !== null) {
    const requirement = editMatch[2]?.trim() ?? ''
    return requirement === ''
      ? { kind: 'help' }
      : { kind: 'edit', id: editMatch[1], requirement }
  }
  return { kind: 'help' }
}

function authoringTask(command, current) {
  if (command.kind === 'new') {
    return `Create a Global User Binding draft for this requirement:\n\n${command.requirement}`
  }
  const entry = { ...current, modelContext: bindingModelPreferences(current.modelContext) }
  return `Revise the following Global User Binding for this requirement:\n\n${command.requirement}\n\nExisting entry:\n${JSON.stringify(entry, null, 2)}`
}

function taskMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: PTC_MESSAGE_SOURCE_KIND, form: 'instructions' },
  })
}

function candidateInvocation(value) {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.symbol !== 'string' || !Array.isArray(value.args)) {
    throw new TypeError('candidate invocation must contain a symbol string and args array')
  }
  return { symbol: value.symbol, args: value.args }
}

function runCandidate(source, invocation, options, signal, owner) {
  if (typeof source !== 'string' || source.length === 0) throw new TypeError('candidate source must be a non-empty string')
  return new Promise((resolve, reject) => {
    const started = owner.start({
      helper: RUNNER_HELPER,
      entry: RUNNER_URL.href,
      protocol: 'parent-port',
      workerData: { source, invocation, valueLimits: options.valueLimits, cwd: options.cwd },
      env: normalizeWorkerEnvironment(process.env),
      resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb },
    })
    const worker = started.transport
    const outputLimitError = () => Object.assign(
      new Error('candidate output exceeded the configured limit'),
      { code: 'bindings/output-limit' },
    )
    const round = createBoundedWorkerRound({
      maxOutputBytes: options.maxOutputBytes,
      maxWallMs: options.maxWallMs,
      signal,
      settle: ({ ok, result, reason }) => {
        // The shared owner owns this close: the release request, the kill deadline
        // and the real exit, with any refusal kept until a late exit arrives.
        void owner.stop(started.id).catch(() => {})
        if (ok) { resolve(result); return }
        if (reason === ROUND_TIMEOUT) reject(new Error(`candidate execution exceeded ${options.maxWallMs}ms`))
        else if (reason === ROUND_CANCELLED) {
          reject(Object.assign(new Error('candidate execution was cancelled'), { code: 'gateway/cancelled' }))
        } else if (reason === ROUND_OUTPUT_LIMIT) reject(outputLimitError())
        else reject(reason)
      },
    })
    const capture = (stream, channel) => stream?.on('data', chunk => round.capture(channel, String(chunk)))
    capture(worker.stdout, 'stdout')
    capture(worker.stderr, 'stderr')
    worker.once('message', (message) => {
      if (message?.ok === true) {
        if (round.exceeds({ value: message.value }, { envelope: true })) {
          round.fail(ROUND_OUTPUT_LIMIT)
          return
        }
        let value
        try {
          value = decodeValue(message.value, options.valueLimits)
        } catch (error) {
          /* c8 ignore next */
          round.fail(error)
          /* c8 ignore next */
          return
        }
        round.succeed({ logs: round.logs, value })
      } else {
        const error = typeof message?.error === 'string' ? message.error : 'candidate execution failed'
        if (round.exceeds({ error }, { envelope: true })) round.fail(ROUND_OUTPUT_LIMIT)
        else round.fail(new Error(error))
      }
    })
    worker.once('error', error => {
      error[CANDIDATE_FAILURE_LOGS] = round.logs.map(log => ({ ...log }))
      round.fail(error)
    })
    worker.once('exit', (code, signal) => {
      const error = new Error(`candidate worker exited before returning a result (${processExitDescription(code, signal)})`)
      error[CANDIDATE_FAILURE_LOGS] = round.logs.map(log => ({ ...log }))
      round.fail(error)
    })
  })
}

/** Own user-binding persistence and the optional authenticated Client RPC surface. */
export function createUserBindingsOwner(ctx, options = {}) {
  // This owner instance keeps its candidate transports only until real exit.
  const candidateOwner = options.candidateOwner ?? new IsolatedOwner()
  const store = options.store ?? new UserBindingsStore(options)
  const bindingsCwd = options.cwd ?? dirname(store.filename)
  let enabled = options.enabled === true
  let draftProjectionAvailable = options.draftProjectionAvailable === true
  let currentOptions = {
    cwd: bindingsCwd,
    maxWallMs: options.maxWallMs,
    maxOutputBytes: options.maxOutputBytes,
    maxOldGenerationSizeMb: options.maxOldGenerationSizeMb,
    valueLimits: options.valueLimits,
  }
  let disposed = false
  const codeConsole = new UserBindingConsole(currentOptions)
  const commandRegistrations = new Map()
  const sessionAgents = new Map()
  const sessionGenerations = new Map()
  const agentLifecycles = new WeakMap()
  const activeAuthoring = new Map()
  const pendingAuthoring = new Map()
  const drafts = new Map()
  const draftsByCapability = new Map()
  const reviewsByCapability = new Map()
  let rpcMount
  let authoringInjection
  let authoringGeneration = 0
  let draftRevision = 0
  let lifecycleGeneration = 0

  const lifecycleFor = (agent) => {
    let lifecycle = agentLifecycles.get(agent)
    if (lifecycle === undefined) {
      lifecycle = { active: false, generation: 0 }
      agentLifecycles.set(agent, lifecycle)
    }
    return lifecycle
  }

  const activateAgent = (agent) => {
    const lifecycle = lifecycleFor(agent)
    if (!lifecycle.active) {
      lifecycle.active = true
      lifecycle.generation += 1
    }
    return lifecycle.generation
  }

  const invalidateAgent = (agent) => {
    const lifecycle = lifecycleFor(agent)
    lifecycle.active = false
    lifecycle.generation += 1
  }

  const agentIsCurrent = (agent, sessionId, generation) => {
    const lifecycle = lifecycleFor(agent)
    return lifecycle.active && lifecycle.generation === generation
      && sessionAgents.get(sessionId) === agent
  }

  const disposeFiber = async (fiber) => {
    if (typeof fiber === 'function') await fiber()
    else if (typeof fiber?.dispose === 'function') await fiber.dispose()
  }

  const registerOwned = (scope, registry, definition, label) => {
    if (typeof scope?.effect !== 'function') {
      throw new Error(`Global User Bindings ${label} registration requires an effect owner`)
    }
    return scope.effect(() => registry.register(definition), `ptc-plus: ${label}`)
  }

  const reportContainedFailure = (message, error) => {
    try {
      ctx.logger?.warn?.(message, error)
    } catch {
      // A contained failure must not regain control through its reporter.
    }
  }

  const contain = (task, message) => Promise.resolve(task).catch((error) => {
    reportContainedFailure(message, error)
  })

  const detach = (task, message) => {
    void contain(task, message)
  }

  const requireEnabled = () => {
    if (!enabled) throw new Error('Global User Bindings are disabled')
  }
  const draftFor = (capability) => {
    if (typeof capability !== 'string' || capability === '') {
      throw new TypeError('draft capability must be a non-empty string')
    }
    return draftsByCapability.get(capability) ?? null
  }
  const draftView = current => current === null ? null : Object.freeze({
    version: current.version,
    mode: current.mode,
    entry: current.entry,
  })
  const candidateView = current => Object.freeze({ requestId: current.requestId, commandId: current.commandId, ...draftView(current) })
  const settleDraft = (current, state, enabled = false) => {
    const retainReview = draftsByCapability.get(current.capability) === current
    removeDraft(current)
    const action = Object.freeze({ requestId: current.requestId, id: current.entry.id, state, enabled })
    if (retainReview) {
      reviewsByCapability.set(current.capability, { agent: current.agent, candidate: candidateView(current), action })
    }
    try {
      const accepting = sessionEvents(current.agent.session)?.find(event => (
        event.type === 'tool/result' && event.surfaceOp === 'append'
        && event.data?.meta?.[USER_BINDING_DRAFT_META_KEY]?.candidate?.requestId === current.requestId
      ))
      if (accepting === undefined) throw new Error('binding acceptance is not yet present in the session log')
      current.agent.session.append('user/message', createUserMessage(bindingActionNotice(action)), {
        surfaceOp: 'append', sourceEventSeqs: [accepting.seq],
      })
    } catch (error) {
      // Storage settlement is final even when its separate presentation append fails.
      reportContainedFailure('ptc-plus: binding action completed but its session receipt could not be appended', error)
    }
  }
  const removeDraft = (current) => {
    if (draftsByCapability.get(current.capability) === current) {
      draftsByCapability.delete(current.capability)
    }
    if (drafts.get(current.sessionId) === current) {
      drafts.delete(current.sessionId)
    }
  }
  const clearDraft = (capability, version) => {
    const current = draftFor(capability)
    if (current === null) return null
    if (!Number.isSafeInteger(version) || version < 1 || version !== current.version) {
      throw Object.assign(new Error('binding draft changed; refresh and retry'), {
        code: 'BINDINGS_CONFLICT',
      })
    }
    if (current.state !== 'ready') {
      throw Object.assign(new Error('binding draft is being saved'), { code: 'BINDINGS_BUSY' })
    }
    settleDraft(current, 'discarded')
    return null
  }
  const saveDraft = async (capability, version, expectedRevision, activate = false) => {
    const current = draftFor(capability)
    if (current === null || !Number.isSafeInteger(version) || version < 1 || version !== current.version) {
      throw Object.assign(new Error('binding draft changed; refresh and retry'), {
        code: 'BINDINGS_CONFLICT',
      })
    }
    if (current.state !== 'ready') {
      throw Object.assign(new Error('binding draft is being saved'), { code: 'BINDINGS_BUSY' })
    }
    current.state = 'saving'
    const entry = { ...current.entry, enabled: activate === true }
    try {
      const result = current.mode === 'new'
        ? await store.create(entry, expectedRevision)
        : await store.update(entry, expectedRevision)
      settleDraft(current, 'saved', activate === true)
      return result
    } catch (error) {
      if (drafts.get(current.sessionId) === current && current.state === 'saving') {
        current.state = 'ready'
      }
      throw error
    }
  }
  const validateEntry = (value) => {
    const entry = normalizeUserBindingEntry(value)
    return {
      id: entry.id,
      name: entry.name,
      scope: entry.scope,
      symbols: [...entry.symbols],
      purpose: entry.purpose,
      enabled: entry.enabled,
      source: entry.source,
      declaration: entry.declaration,
      ...(entry.modelContext === undefined ? {} : { modelContext: entry.modelContext }),
    }
  }
  const saveEntry = async (input) => {
    if (input.intent === 'create') return store.create(input.entry, input.expectedRevision)
    if (input.intent !== 'update') {
      throw new TypeError('binding save requires an explicit create or update intent')
    }
    const entry = normalizeUserBindingEntry(input.entry)
    if (typeof input.originalId !== 'string' || input.originalId !== entry.id) {
      throw new Error('binding update requires the original id of the entry it replaces')
    }
    // The store owns entry normalization and accepts only raw entry fields;
    // the normalized product carries derived fingerprint/declaration state.
    return store.update(input.entry, input.expectedRevision)
  }
  const reviewDraft = (capability) => {
    const current = draftFor(capability)
    if (current !== null) return { candidate: candidateView(current), action: null }
    const review = reviewsByCapability.get(capability)
    return review === undefined ? null : { candidate: review.candidate, action: review.action }
  }
  // Fixed endpoint tables grouped by domain; the dispatcher only looks up the
  // operation, rejects unknown endpoints and hands over the validated input.
  const storageEndpoints = Object.freeze({
    list: () => store.list(),
    load: input => store.entry(input.id),
    reload: () => store.reload(),
    save: saveEntry,
    enable: input => store.setEnabled(input.id, true, input.expectedRevision),
    disable: input => store.setEnabled(input.id, false, input.expectedRevision),
    remove: input => store.remove(input.id, input.expectedRevision),
    import: input => store.importFile(input.path, input.expectedRevision, input.options),
    validate: input => validateEntry(input.entry),
  })
  const candidateEndpoints = Object.freeze({
    run: (input, signal) => runCandidate(
      input.source,
      candidateInvocation(input.invocation),
      currentOptions,
      signal,
      candidateOwner,
    ),
  })
  const consoleEndpoints = Object.freeze({
    'console-run': (input, signal) => codeConsole.run(input, signal),
    'console-release': (input) => {
      codeConsole.release(input.environment)
      return null
    },
  })
  const draftEndpoints = Object.freeze({
    draft: input => draftView(draftFor(input.capability)),
    'draft-review': input => reviewDraft(input.capability),
    'save-draft': input => saveDraft(
      input.capability,
      input.version,
      input.expectedRevision,
      input.activate === true,
    ),
    'discard-draft': input => clearDraft(input.capability, input.version),
  })
  const ENDPOINTS = Object.freeze(Object.assign(
    Object.create(null),
    storageEndpoints,
    candidateEndpoints,
    consoleEndpoints,
    draftEndpoints,
  ))

  const handler = async (endpoint, payload, signal) => {
    try {
      if (disposed) throw new Error('Global User Bindings owner is disposed')
      requireEnabled()
      const operation = ENDPOINTS[endpoint]
      if (typeof operation !== 'function') {
        throw new Error(`unknown user binding operation ${JSON.stringify(endpoint)}`)
      }
      return { ok: true, value: await operation(isRecord(payload) ? payload : {}, signal) }
    } catch (error) {
      return errorResult(error)
    }
  }

  const stopAuthoring = async (
    sessionId,
    _reason = 'Agent authoring ended before a Global User Binding draft was accepted.',
    expected,
  ) => {
    const current = activeAuthoring.get(sessionId)
    if (current === undefined || (expected !== undefined && current !== expected)) return
    activeAuthoring.delete(sessionId)
    current.abortCleanup?.()
    current.abortCleanup = undefined
  }

  const beginAuthoring = async (agent, command, signal, commandId) => {
    signal?.throwIfAborted?.()
    requireEnabled()
    if (!draftProjectionAvailable) {
      throw new Error('binding authoring requires the session draft projection')
    }
    if (disposed) throw new Error('Global User Bindings owner is disposed')
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) throw new Error('binding authoring requires a live session identity')
    const agentGeneration = lifecycleFor(agent).generation
    const requireCurrentAgent = () => {
      if (!agentIsCurrent(agent, sessionId, agentGeneration)
        || commandRegistrations.get(sessionId)?.agent !== agent
        || ctx.tools.get('run_code', agent) === undefined) {
        throw new Error('this binding authoring Agent is no longer active')
      }
    }
    requireCurrentAgent()
    await stopAuthoring(
      sessionId,
      'A newer Global User Binding authoring request replaced this one before a draft was accepted.',
    )
    requireCurrentAgent()
    const attempt = Object.freeze({ agent, agentGeneration, generation: lifecycleGeneration })
    pendingAuthoring.set(sessionId, attempt)
    const requireCurrentAttempt = () => {
      if (disposed || !enabled || lifecycleGeneration !== attempt.generation
        || pendingAuthoring.get(sessionId) !== attempt
        || !agentIsCurrent(agent, sessionId, attempt.agentGeneration)) {
        throw new Error('this binding authoring request is no longer active')
      }
      signal?.throwIfAborted?.()
    }
    let active
    try {
      const current = command.kind === 'edit'
        ? storedEntry((await store.entry(command.id)).entry)
        : undefined
      requireCurrentAttempt()
      pendingAuthoring.delete(sessionId)
      active = {
        agent,
        requestId: randomUUID(),
        accepted: false,
        submitting: false,
        agentGeneration,
        generation: lifecycleGeneration,
        abortCleanup: undefined,
      }
      activeAuthoring.set(sessionId, active)
      const requireActive = () => {
        if (disposed || !enabled || lifecycleGeneration !== active.generation
          || activeAuthoring.get(sessionId) !== active || active.accepted
          || !agentIsCurrent(agent, sessionId, active.agentGeneration)) {
          throw new Error('this binding draft handoff is no longer active')
        }
      }
      signal?.throwIfAborted?.()
      active.submit = async (value, ensureLease, onAccepted) => {
          ensureLease()
          requireActive()
          const errors = validateJsonSchemaValue(BINDING_SUBMISSION.parameters, value)
          if (errors.length > 0) throw new TypeError(`invalid binding submission: ${JSON.stringify(errors)}`)
          if (value.requestId !== active.requestId) {
            throw new Error('this binding draft request identity is no longer active')
          }
          const { entry } = value
          if (active.submitting) throw new Error('this binding draft handoff is already processing a submission')
          active.submitting = true
          try {
            const candidate = normalizeUserBindingEntry({ ...entry, enabled: false })
            if (command.kind === 'edit' && candidate.id !== command.id) {
              throw new Error(`edited binding id must remain ${JSON.stringify(command.id)}`)
            }
            const document = await store.validationDocument()
            ensureLease()
            requireActive()
            if (command.kind === 'new' && document.entries.some(item => item.id === candidate.id)) {
              throw new Error(`binding entry ${JSON.stringify(candidate.id)} already exists; choose a new id`)
            }
            const candidateEntry = storedEntry(candidate)
            const entries = [
              ...document.entries.filter(item => item.id !== candidate.id),
              candidateEntry,
            ]
            normalizeUserBindingsDocument({ entries })
            createUserBindingsSnapshot({
              entries: entries.map(item => item.id === candidate.id
                ? { ...item, enabled: true }
                : item),
            }, document.revision)
            active.accepted = true
            const previous = drafts.get(sessionId)
            if (previous !== undefined) removeDraft(previous)
            const draft = {
              agent,
              capability: randomUUID(),
              sessionId,
              version: ++draftRevision,
              mode: command.kind,
              requestId: active.requestId,
              commandId: commandId ?? null,
              entry: Object.freeze(storedEntry(candidate)),
              state: 'ready',
            }
            drafts.set(sessionId, draft)
            draftsByCapability.set(draft.capability, draft)
            onAccepted(candidateView(draft))
            queueMicrotask(() => {
              detach(
                stopAuthoring(sessionId, undefined, active),
                'ptc-plus: failed to clean up accepted Global User Bindings authoring',
              )
            })
            return { accepted: true, id: candidate.id, requestId: active.requestId }
          } finally {
            active.submitting = false
          }
      }
      signal?.throwIfAborted?.()
      if (typeof signal?.addEventListener === 'function') {
        const abort = () => {
          detach(
            stopAuthoring(sessionId, 'The binding authoring request was cancelled.', active),
            'ptc-plus: failed to cancel Global User Bindings authoring',
          )
        }
        active.abortCleanup = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }
      agent.steer(taskMessage(`${bindingAuthoringInstructions(active.requestId, bindingsCwd)}\n\n${authoringTask(command, current)}`))
      return { kind: 'success' }
    } catch (error) {
      if (pendingAuthoring.get(sessionId) === attempt) pendingAuthoring.delete(sessionId)
      if (active !== undefined && activeAuthoring.get(sessionId) === active) {
        await stopAuthoring(
          sessionId,
          error instanceof Error ? error.message : String(error),
          active,
        )
      }
      throw error
    }
  }

  const commandHandler = async ({ agent, rawInput, signal, commandId }) => {
    signal?.throwIfAborted?.()
    const command = parseAuthoringCommand(rawInput)
    if (command.kind === 'help') return { kind: 'error', text: `Usage: ${COMMAND_USAGE}` }
    try {
      return await beginAuthoring(agent, command, signal, commandId)
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  const removeCommandFor = async (sessionId, expected) => {
    const current = commandRegistrations.get(sessionId)
    if (current === undefined || (expected !== undefined && current !== expected)) return
    if (current.disposing !== undefined) return current.disposing
    current.disposing = (async () => {
      try {
        await disposeFiber(current.fiber)
      } finally {
        if (commandRegistrations.get(sessionId) === current) commandRegistrations.delete(sessionId)
      }
    })()
    return current.disposing
  }

  const registerCommandFor = (agent) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined || commandRegistrations.has(sessionId)) return
    if (typeof agent?.ctx?.inject !== 'function') {
      throw new Error('Global User Bindings command requires agent-scoped Cordis injection')
    }
    const agentGeneration = lifecycleFor(agent).generation
    const registration = { agent, fiber: undefined, generation: lifecycleGeneration }
    commandRegistrations.set(sessionId, registration)
    let fiber
    try {
      fiber = agent.ctx.inject(['commands'], (commandCtx) => {
        // This callback runs whenever the command service becomes available, not
        // necessarily before inject() returns. When eligibility changed before it
        // ran, the registration is stale: fail the activation explicitly so the
        // fiber rejection below removes the placeholder registration. A silent
        // return would leave the fiber alive with no command and the map entry
        // still claiming one.
        if (disposed || !enabled || lifecycleGeneration !== registration.generation
          || !agentIsCurrent(agent, sessionId, agentGeneration)
          || ctx.tools.get('run_code', agent) === undefined
          || commandRegistrations.get(sessionId) !== registration) {
          throw new Error('Global User Bindings binding command registration is no longer eligible')
        }
        registerOwned(commandCtx, commandCtx.commands, {
          name: 'binding',
          description: 'Create or revise a Global User Binding draft with the current agent',
          input: { hint: 'new <requirement> | edit <id> <requirement>' },
          handler: commandHandler,
        }, 'binding command')
      })
    } catch (error) {
      if (commandRegistrations.get(sessionId) === registration) {
        commandRegistrations.delete(sessionId)
      }
      throw error
    }
    registration.fiber = fiber
    // A fiber that settles without running its callback is still pending on the
    // command service; its registration must survive so the callback can install
    // the command later. Only rejected fibers remove the placeholder registration.
    detach(Promise.resolve(fiber).catch(async (error) => {
      if (commandRegistrations.get(sessionId) === registration) {
        commandRegistrations.delete(sessionId)
      }
      try {
        await disposeFiber(fiber)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Global User Bindings command activation and rollback failed',
        )
      }
      throw error
    }), 'ptc-plus: failed to roll back Global User Bindings command injection')
  }

  const reconcileAgent = async (agent) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const agentGeneration = activateAgent(agent)
    const previousAgent = sessionAgents.get(sessionId)
    if (previousAgent !== agent) {
      sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1)
      sessionAgents.set(sessionId, agent)
      if (previousAgent !== undefined) {
        invalidateAgent(previousAgent)
        await clearAgentPresentation(previousAgent)
      }
    }
    if (!agentIsCurrent(agent, sessionId, agentGeneration)) return
    const eligible = enabled && draftProjectionAvailable && !disposed
      && ctx.tools.get('run_code', agent) !== undefined
    const current = commandRegistrations.get(sessionId)
    if (eligible && current?.agent === agent) return
    if (current !== undefined) await removeCommandFor(sessionId, current)
    if (!agentIsCurrent(agent, sessionId, agentGeneration)) return
    const stillEligible = enabled && draftProjectionAvailable && !disposed
      && ctx.tools.get('run_code', agent) !== undefined
    if (stillEligible) {
      registerCommandFor(agent)
      return
    }
    const active = activeAuthoring.get(sessionId)
    if (active?.agent === agent) {
      await stopAuthoring(
        sessionId,
        'This agent no longer exposes run_code; no Global User Binding draft was accepted.',
        active,
      )
    }
  }

  const setAgentPresentation = agent => reconcileAgent(agent)

  const clearAgentPresentation = async (agent) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    invalidateAgent(agent)
    if (sessionAgents.get(sessionId) === agent) sessionAgents.delete(sessionId)
    const pending = pendingAuthoring.get(sessionId)
    if (pending?.agent === agent) pendingAuthoring.delete(sessionId)
    const active = activeAuthoring.get(sessionId)
    if (active?.agent === agent) {
      await stopAuthoring(
        sessionId,
        'The Agent ended before a Global User Binding draft was accepted.',
        active,
      )
    }
    const draft = drafts.get(sessionId)
    if (draft?.agent === agent) removeDraft(draft)
    for (const [capability, review] of reviewsByCapability) {
      if (review.agent === agent) reviewsByCapability.delete(capability)
    }
    const registration = commandRegistrations.get(sessionId)
    if (registration?.agent === agent) await removeCommandFor(sessionId, registration)
  }

  const clearSessionPresentation = async (sessionId) => {
    if (sessionId === undefined || sessionId === null) return
    const id = String(sessionId)
    const generation = sessionGenerations.get(id) ?? 0
    const pending = pendingAuthoring.get(id)
    const sessionDrafts = [...drafts.values()].filter(draft => draft.sessionId === id)
    const agents = new Set()
    const known = [
      sessionAgents.get(id),
      pending?.agent,
      activeAuthoring.get(id)?.agent,
      commandRegistrations.get(id)?.agent,
      ...sessionDrafts.map(draft => draft.agent),
    ]
    for (const agent of known) if (agent !== undefined) agents.add(agent)
    if (pendingAuthoring.get(id) === pending) pendingAuthoring.delete(id)
    for (const draft of sessionDrafts) {
      if (drafts.get(id) === draft) removeDraft(draft)
    }
    const results = await Promise.allSettled([...agents].map(agent => clearAgentPresentation(agent)))
    if ((sessionGenerations.get(id) ?? 0) !== generation) return
    activeAuthoring.delete(id)
    sessionAgents.delete(id)
    sessionGenerations.delete(id)
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Global User Bindings session cleanup failed')
    }
  }

  const unmountAuthoring = async () => {
    authoringGeneration += 1
    const currentInjection = authoringInjection
    const operations = [
      ...[...activeAuthoring.keys()].map(sessionId => stopAuthoring(
        sessionId,
        'Global User Bindings were disabled before a draft was accepted.',
      )),
      ...[...commandRegistrations.keys()].map(sessionId => removeCommandFor(sessionId)),
      Promise.resolve().then(() => disposeFiber(currentInjection)).finally(() => {
        if (authoringInjection === currentInjection) authoringInjection = undefined
      }),
    ]
    pendingAuthoring.clear()
    const results = await Promise.allSettled(operations)
    const failures = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Global User Bindings authoring unmount failed')
  }

  const mountAuthoring = () => {
    if (!enabled || disposed || authoringInjection !== undefined || typeof ctx.inject !== 'function') return
    const generation = ++authoringGeneration
    authoringInjection = ctx.inject(['tools'], (scope) => {
      if (!enabled || disposed || authoringGeneration !== generation) return
      const reconcile = agent => {
        detach(
          reconcileAgent(agent),
          'ptc-plus: failed to reconcile Global User Bindings authoring',
        )
      }
      for (const agent of ctx.agents?.list?.() ?? []) reconcile(agent)
      scope.on?.('agent/created', ({ agent }) => reconcile(agent))
      scope.on?.('tools/change', () => {
        for (const agent of ctx.agents?.list?.() ?? []) reconcile(agent)
      })
      scope.on?.('agent/disposed', ({ agent }) => {
        return contain(
          clearAgentPresentation(agent),
          'ptc-plus: failed to dispose Global User Bindings authoring',
        )
      })
      scope.on?.('agent/turn-stopping', ({ agent }) => {
        const sessionId = sessionIdOf(agent)
        const active = sessionId === undefined ? undefined : activeAuthoring.get(sessionId)
        if (active?.agent === agent) return stopAuthoring(sessionId, undefined, active)
      })
      scope.on?.('agent/error', ({ agent }) => {
        const sessionId = sessionIdOf(agent)
        const active = sessionId === undefined ? undefined : activeAuthoring.get(sessionId)
        if (active?.agent === agent) return stopAuthoring(
          sessionId,
          'The Agent failed before a Global User Binding draft was accepted.',
          active,
        )
      })
    })
  }

  const mountRpcRegistration = (state, record) => {
    if (!enabled || disposed || rpcMount !== state || record.registration !== undefined
      || typeof record.scope.ptcPlusRpc?.register !== 'function') return
    const effectOwner = typeof record.scope.effect === 'function' ? record.scope : ctx
    const registration = effectOwner.effect(() => record.scope.ptcPlusRpc.register(
      RPC_CONTRACT,
      handler,
    ), 'ptc-plus user bindings RPC')
    if (typeof registration !== 'function') {
      throw new Error('Global User Bindings RPC registration did not return a disposer')
    }
    record.registration = registration
  }
  const mountRpc = () => {
    if (!enabled || disposed || typeof ctx.inject !== 'function') return
    if (rpcMount !== undefined) {
      for (const record of rpcMount.records) mountRpcRegistration(rpcMount, record)
      return
    }
    const state = { injection: undefined, records: new Set() }
    rpcMount = state
    state.injection = ctx.inject(['ptcPlusRpc'], (scope) => {
      if (!enabled || disposed || rpcMount !== state) return
      const record = { scope, registration: undefined }
      state.records.add(record)
      scope.effect?.(() => () => { state.records.delete(record) }, 'ptc-plus: binding RPC scope')
      try {
        mountRpcRegistration(state, record)
      } catch (error) {
        state.records.delete(record)
        throw error
      }
    })
  }
  const unmountRpc = async () => {
    const state = rpcMount
    if (state === undefined) return
    const operations = [...state.records].flatMap(record => (
      typeof record.registration !== 'function' ? [] : [
        Promise.resolve().then(() => record.registration()).finally(() => {
          record.registration = undefined
        }),
      ]
    ))
    const results = await Promise.allSettled(operations)
    const failures = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Global User Bindings RPC unmount failed')
    try {
      if (typeof state.injection === 'function') await state.injection()
      else if (typeof state.injection?.dispose === 'function') await state.injection.dispose()
    } catch (error) {
      throw new AggregateError([error], 'Global User Bindings RPC unmount failed')
    }
    if (rpcMount === state) rpcMount = undefined
    state.records.clear()
  }
  mountRpc()
  mountAuthoring()

  return Object.freeze({
    path: store.filename,
    cwd: bindingsCwd,
    async snapshot() {
      return enabled ? store.snapshot() : undefined
    },
    async list() {
      requireEnabled()
      return store.list()
    },
    setAgentPresentation,
    clearAgentPresentation,
    clearSessionPresentation,
    async setDraftProjectionAvailable(available) {
      const next = available === true
      if (draftProjectionAvailable === next) return
      draftProjectionAvailable = next
      lifecycleGeneration += 1
      if (next) {
        await Promise.all([...new Set([
          ...(ctx.agents?.list?.() ?? []),
          ...sessionAgents.values(),
        ])].map(reconcileAgent))
        return
      }
      pendingAuthoring.clear()
      for (const draft of [...drafts.values()]) removeDraft(draft)
      reviewsByCapability.clear()
      const results = await Promise.allSettled([
        ...[...activeAuthoring.keys()].map(sessionId => stopAuthoring(
          sessionId,
          'The binding draft projection became unavailable before a draft was accepted.',
        )),
      ...[...commandRegistrations.keys()].map(sessionId => removeCommandFor(sessionId)),
      ])
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Global User Bindings command projection cleanup failed')
      }
    },
    draftCapabilityForAgent(agent) {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return null
      const draft = drafts.get(sessionId)
      return draft?.agent === agent ? draft.capability : null
    },
    submissionForAgent(agent, ensureLease, onAccepted) {
      const current = activeAuthoring.get(sessionIdOf(agent))
      return async value => {
        ensureLease()
        if (current === undefined || current.agent !== agent) {
          throw new Error('binding submission requires an active /binding request in the requesting Agent')
        }
        return current.submit(value, ensureLease, onAccepted)
      }
    },
    async reconfigure(nextConfig) {
      const nextEnabled = nextConfig.userBindingsEnabled === true
      const previousEnabled = enabled
      const previousOptions = currentOptions
      const nextOptions = {
        ...currentOptions,
        maxWallMs: nextConfig.maxWallMs,
        maxOutputBytes: nextConfig.maxOutputBytes,
        maxOldGenerationSizeMb: nextConfig.maxOldGenerationSizeMb,
        valueLimits: valueLimitsFromConfig(nextConfig),
      }
      if (nextEnabled === previousEnabled) {
        await codeConsole.reconfigure(nextOptions)
        currentOptions = nextOptions
        return
      }
      try {
        await codeConsole.reconfigure(nextOptions)
        if (!nextEnabled) {
          const failures = await codeConsole.releaseAll('disabled')
          if (failures.length > 0) {
            throw new AggregateError(failures, 'Global User Bindings console release failed')
          }
        }
      } catch (error) {
        try {
          await codeConsole.reconfigure(previousOptions)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Global User Bindings console reconfiguration and rollback failed',
            { cause: error },
          )
        }
        throw error
      }
      enabled = nextEnabled
      currentOptions = nextOptions
      lifecycleGeneration += 1
      if (nextEnabled) {
        try {
          mountRpc()
          mountAuthoring()
        } catch (error) {
          enabled = previousEnabled
          currentOptions = previousOptions
          lifecycleGeneration += 1
          const rollbackResults = await Promise.allSettled([
            codeConsole.reconfigure(previousOptions),
            unmountRpc(),
            unmountAuthoring(),
          ])
          const rollbackFailures = rollbackResults
            .filter(result => result.status === 'rejected')
            .map(result => result.reason)
          if (rollbackFailures.length > 0) {
            throw new AggregateError(
              [error, ...rollbackFailures],
              'Global User Bindings enablement and rollback failed',
              { cause: error },
            )
          }
          throw error
        }
        return
      }
      try {
        await Promise.all([unmountRpc(), unmountAuthoring()])
        for (const draft of [...drafts.values()]) removeDraft(draft)
        reviewsByCapability.clear()
      } catch (error) {
        enabled = previousEnabled
        currentOptions = previousOptions
        lifecycleGeneration += 1
        const rollbackResults = await Promise.allSettled([
          codeConsole.reconfigure(previousOptions),
          Promise.resolve().then(() => mountRpc()),
          Promise.resolve().then(() => mountAuthoring()),
        ])
        const rollbackFailures = rollbackResults
          .filter(result => result.status === 'rejected')
          .map(result => result.reason)
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            'Global User Bindings disablement and rollback failed',
            { cause: error },
          )
        }
        throw error
      }
    },
    async dispose() {
      disposed = true
      const ownerResults = await Promise.allSettled([candidateOwner.dispose(), codeConsole.dispose()])
      const failures = []
      for (const result of ownerResults) {
        if (result.status === 'rejected') failures.push(result.reason)
        else failures.push(...result.value)
      }
      enabled = false
      lifecycleGeneration += 1
      for (const draft of [...drafts.values()]) removeDraft(draft)
      reviewsByCapability.clear()
      const unmountResults = await Promise.allSettled([unmountRpc(), unmountAuthoring()])
      for (const result of unmountResults) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Global User Bindings disposal failed')
      }
    },
  })
}

export { RPC_CONTRACT as USER_BINDINGS_RPC_CONTRACT }
