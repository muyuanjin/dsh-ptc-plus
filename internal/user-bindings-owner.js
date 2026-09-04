import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { decodeValue } from './value-wire.js'
import { UserBindingsStore } from './user-bindings-store.js'
import {
  createUserBindingsSnapshot,
  normalizeUserBindingEntry,
  normalizeUserBindingsDocument,
  storedUserBindingsDocument,
} from './user-bindings.js'

const RPC_CHANNEL = '/ptc-plus-bindings'
const RUNNER_URL = new URL('./user-binding-runner.js', import.meta.url)
const AUTHORING_SKILL_PREFIX = 'ptc-plus-binding-authoring'
const SUBMIT_DRAFT_TOOL = 'submitBindingDraft'
const COMMAND_USAGE = '/binding new <requirement> or /binding edit <id> <requirement>'

const AUTHORING_SKILL = `Create exactly one Global User Binding candidate for the user's request.

- Return the candidate only by calling \`tools.submitBindingDraft({ entry })\` from \`run_code\`.
- \`entry\` contains \`id\`, \`name\`, \`scope\`, optional \`symbols\`, \`purpose\`, and \`source\`. The Host accepts the candidate only as a disabled in-memory draft.
- Use \`namespace\` scope unless a small top-level API materially improves repeated use.
- Source is TypeScript and exposes one or more named value exports. Do not use default exports or re-exports.
- Preserve explicit parameter and return types that help a later model call the binding correctly. Keep purpose to one factual line.
- Do not save, enable, run, import, remove, or otherwise mutate persistent bindings. The user reviews those actions separately.
- Submit once. Do not describe a candidate that was not accepted by the tool.`

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorResult(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'bindings/error',
      message: error instanceof Error ? error.message : String(error),
      details: {},
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

function skillMessage(name) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `<skill_content name="${name}">\n<skill_resources>\nNo external resources.\n</skill_resources>\n\n<skill_instructions>\n${AUTHORING_SKILL}\n</skill_instructions>\n</skill_content>`,
    }],
    source: { kind: 'skill-invocation', name, form: 'instructions' },
  })
}

function authoringTask(command, current) {
  if (command.kind === 'new') {
    return `Create a Global User Binding draft for this requirement:\n\n${command.requirement}`
  }
  return `Revise the following Global User Binding for this requirement:\n\n${command.requirement}\n\nExisting entry:\n${JSON.stringify(current, null, 2)}`
}

function taskMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'ptc-plus' },
  })
}

function draftToolDefinition(submit) {
  return {
    name: SUBMIT_DRAFT_TOOL,
    description: 'Submit the one Global User Binding candidate requested by the user. This stores an in-memory disabled draft for user review and cannot persist, run, or enable it.',
    parameters: {
      entry: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          scope: { type: 'string', enum: ['namespace', 'top-level'], required: true },
          symbols: { type: 'array', items: { type: 'string' } },
          purpose: { type: 'string', required: true },
          source: { type: 'string', required: true },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', const: true, required: true },
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Draft ${JSON.stringify(value.id)} is ready for user review. Do not submit another draft.`,
      }],
    },
    execute: submit,
  }
}

function candidateInvocation(value) {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.symbol !== 'string' || !Array.isArray(value.args)) {
    throw new TypeError('candidate invocation must contain a symbol string and args array')
  }
  return { symbol: value.symbol, args: value.args }
}

function runCandidate(source, invocation, options, signal) {
  if (typeof source !== 'string' || source.length === 0) throw new TypeError('candidate source must be a non-empty string')
  return new Promise((resolve, reject) => {
    let settled = false
    let outputBytes = 0
    const logs = []
    const worker = new Worker(RUNNER_URL, {
      workerData: { source, invocation, valueLimits: options.valueLimits, cwd: options.cwd },
      resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb },
      stdout: true,
      stderr: true,
    })
    const finish = (operation) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      void worker.terminate()
      operation()
    }
    const fail = error => finish(() => reject(error))
    const outputLimitError = () => Object.assign(
      new Error('candidate output exceeded the configured limit'),
      { code: 'bindings/output-limit' },
    )
    const exceedsOutputLimit = payload => (
      Buffer.byteLength(JSON.stringify(payload), 'utf8') > options.maxOutputBytes
    )
    const timer = setTimeout(() => fail(
      new Error(`candidate execution exceeded ${options.maxWallMs}ms`),
    ), options.maxWallMs)
    const abort = () => {
      fail(Object.assign(new Error('candidate execution was cancelled'), { code: 'gateway/cancelled' }))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) {
      abort()
      return
    }
    const capture = (stream, channel) => stream?.on('data', chunk => {
      const text = String(chunk)
      outputBytes += Buffer.byteLength(text, 'utf8')
      if (outputBytes > options.maxOutputBytes) {
        fail(outputLimitError())
        return
      }
      logs.push({ channel, text })
    })
    capture(worker.stdout, 'stdout')
    capture(worker.stderr, 'stderr')
    worker.once('message', (message) => {
      if (message?.ok === true) {
        if (exceedsOutputLimit({ logs, value: message.value })) {
          fail(outputLimitError())
          return
        }
        let value
        try {
          value = decodeValue(message.value, options.valueLimits)
        } catch (error) {
          /* c8 ignore next */
          fail(error)
          /* c8 ignore next */
          return
        }
        finish(() => resolve({ logs, value }))
      } else {
        const error = typeof message?.error === 'string' ? message.error : 'candidate execution failed'
        if (exceedsOutputLimit({ logs, error })) fail(outputLimitError())
        else fail(new Error(error))
      }
    })
    worker.once('error', fail)
    worker.once('exit', code => {
      if (!settled) fail(new Error(`candidate worker exited before returning a result (code ${code})`))
    })
  })
}

/** Own user-binding persistence and the optional authenticated Client RPC surface. */
export function createUserBindingsOwner(ctx, options = {}) {
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
  const commandRegistrations = new Map()
  const agentPresentations = new Map()
  const sessionAgents = new Map()
  const activeAuthoring = new Map()
  const pendingAuthoring = new Map()
  const drafts = new Map()
  const draftsByCapability = new Map()
  let rpcMount
  let authoringInjection
  let draftRevision = 0
  let lifecycleGeneration = 0

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
  const removeDraft = (current) => {
    draftsByCapability.delete(current.capability)
    if (drafts.get(current.sessionId) === current) drafts.delete(current.sessionId)
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
    removeDraft(current)
    return null
  }
  const saveDraft = async (capability, version, expectedRevision) => {
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
    const entry = { ...current.entry, enabled: false }
    try {
      const result = current.mode === 'new'
        ? await store.create(entry, expectedRevision)
        : await store.save(entry, expectedRevision)
      removeDraft(current)
      return result
    } catch (error) {
      if (drafts.get(current.sessionId) === current && current.state === 'saving') {
        current.state = 'ready'
      }
      throw error
    }
  }
  const handler = async (endpoint, payload, signal) => {
    try {
      if (disposed) throw new Error('Global User Bindings owner is disposed')
      requireEnabled()
      const input = isRecord(payload) ? payload : {}
      let value
      if (endpoint === 'list') value = await store.list()
      else if (endpoint === 'load') value = await store.entry(input.id)
      else if (endpoint === 'reload') value = await store.reload()
      else if (endpoint === 'save') value = await store.save(input.entry, input.expectedRevision)
      else if (endpoint === 'enable') value = await store.setEnabled(input.id, true, input.expectedRevision)
      else if (endpoint === 'disable') value = await store.setEnabled(input.id, false, input.expectedRevision)
      else if (endpoint === 'remove') value = await store.remove(input.id, input.expectedRevision)
      else if (endpoint === 'import') value = await store.importFile(input.path, input.expectedRevision, input.options)
      else if (endpoint === 'validate') {
        const entry = normalizeUserBindingEntry(input.entry)
        value = {
          id: entry.id,
          name: entry.name,
          scope: entry.scope,
          symbols: [...entry.symbols],
          purpose: entry.purpose,
          enabled: entry.enabled,
          source: entry.source,
          declaration: entry.declaration,
        }
      } else if (endpoint === 'run') {
        value = await runCandidate(input.source, candidateInvocation(input.invocation), currentOptions, signal)
      } else if (endpoint === 'draft') value = draftView(draftFor(input.capability))
      else if (endpoint === 'save-draft') {
        value = await saveDraft(input.capability, input.version, input.expectedRevision)
      }
      else if (endpoint === 'discard-draft') value = clearDraft(input.capability, input.version)
      else throw new Error(`unknown user binding operation ${JSON.stringify(endpoint)}`)
      return { ok: true, value }
    } catch (error) {
      return errorResult(error)
    }
  }

  const stopAuthoring = (sessionId) => {
    pendingAuthoring.delete(sessionId)
    const current = activeAuthoring.get(sessionId)
    if (current === undefined) return
    activeAuthoring.delete(sessionId)
    for (const release of current.releases.reverse()) release()
  }

  const beginAuthoring = async (agent, command, signal) => {
    signal?.throwIfAborted?.()
    requireEnabled()
    if (!draftProjectionAvailable) {
      throw new Error('binding authoring requires the session draft projection')
    }
    if (disposed) throw new Error('Global User Bindings owner is disposed')
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) throw new Error('binding authoring requires a live session identity')
    stopAuthoring(sessionId)
    const attempt = Object.freeze({ generation: lifecycleGeneration })
    pendingAuthoring.set(sessionId, attempt)
    const requireCurrentAttempt = () => {
      if (disposed || !enabled || lifecycleGeneration !== attempt.generation
        || pendingAuthoring.get(sessionId) !== attempt) {
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
      const name = `${AUTHORING_SKILL_PREFIX}-${randomUUID().replaceAll('-', '')}`
      active = {
        accepted: false,
        submitting: false,
        releases: [],
        generation: lifecycleGeneration,
      }
      activeAuthoring.set(sessionId, active)
      const release = () => stopAuthoring(sessionId)
      const requireActive = () => {
        if (disposed || !enabled || lifecycleGeneration !== active.generation
          || activeAuthoring.get(sessionId) !== active || active.accepted) {
          throw new Error('this binding draft handoff is no longer active')
        }
      }
      const abort = () => release()
      signal?.addEventListener?.('abort', abort, { once: true })
      active.releases.push(() => signal?.removeEventListener?.('abort', abort))
      signal?.throwIfAborted?.()
      active.releases.push(agent.ctx.effect(() => agent.ctx.skills.register({
        name,
        description: 'Author one Global User Binding candidate for the current explicit user request.',
        source: 'runtime',
        invocation: { modelInvocable: false, userInvocable: false },
        content: AUTHORING_SKILL,
      }), 'ptc-plus binding authoring skill'))
      active.releases.push(agent.ctx.effect(() => agent.ctx.tools.register(draftToolDefinition(async ({ entry }) => {
        requireActive()
        if (active.submitting) throw new Error('this binding draft handoff is already processing a submission')
        active.submitting = true
        try {
          const candidate = normalizeUserBindingEntry({ ...entry, enabled: false })
          if (command.kind === 'edit' && candidate.id !== command.id) {
            throw new Error(`edited binding id must remain ${JSON.stringify(command.id)}`)
          }
          const document = await store.validationDocument()
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
            capability: randomUUID(),
            sessionId,
            version: ++draftRevision,
            mode: command.kind,
            entry: Object.freeze(storedEntry(candidate)),
            state: 'ready',
          }
          drafts.set(sessionId, draft)
          draftsByCapability.set(draft.capability, draft)
          queueMicrotask(release)
          return { accepted: true, id: candidate.id }
        } finally {
          active.submitting = false
        }
      })), 'ptc-plus binding draft handoff'))
      agent.inject(skillMessage(name))
      agent.steer(taskMessage(authoringTask(command, current)))
    } catch (error) {
      if (pendingAuthoring.get(sessionId) === attempt) pendingAuthoring.delete(sessionId)
      if (active !== undefined && activeAuthoring.get(sessionId) === active) stopAuthoring(sessionId)
      throw error
    }
  }

  const commandHandler = async ({ agent, rawInput, signal }) => {
    signal?.throwIfAborted?.()
    const command = parseAuthoringCommand(rawInput)
    if (command.kind === 'help') return { kind: 'error', text: `Usage: ${COMMAND_USAGE}` }
    try {
      await beginAuthoring(agent, command, signal)
      return {
        kind: 'success',
        text: 'Binding draft requested. Review the submitted draft in the PTC Plus session panel.',
      }
    } catch (error) {
      signal?.throwIfAborted?.()
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  const registerCommandFor = (agent) => {
    const sessionId = sessionIdOf(agent)
    if (!enabled || !draftProjectionAvailable || disposed || sessionId === undefined
      || agentPresentations.get(sessionId) !== 'ptc'
      || typeof agent?.ctx?.effect !== 'function'
      || typeof agent?.ctx?.commands?.register !== 'function'
      || commandRegistrations.has(sessionId)) return
    const release = agent.ctx.effect(() => agent.ctx.commands.register({
      name: 'binding',
      description: 'Create or revise a Global User Binding draft with the current agent',
      input: { hint: 'new <requirement> | edit <id> <requirement>' },
      handler: commandHandler,
    }), 'ptc-plus binding command')
    commandRegistrations.set(sessionId, release)
  }

  const setAgentPresentation = async (agent, presentation) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    sessionAgents.set(sessionId, agent)
    agentPresentations.set(sessionId, presentation)
    if (presentation === 'ptc') {
      registerCommandFor(agent)
      return
    }
    stopAuthoring(sessionId)
    const release = commandRegistrations.get(sessionId)
    if (release === undefined) return
    commandRegistrations.delete(sessionId)
    await release()
  }

  const clearSessionPresentation = async (sessionId) => {
    if (sessionId === undefined || sessionId === null) return
    const id = String(sessionId)
    agentPresentations.delete(id)
    sessionAgents.delete(id)
    stopAuthoring(id)
    const draft = drafts.get(id)
    if (draft !== undefined) removeDraft(draft)
    const release = commandRegistrations.get(id)
    if (release === undefined) return
    commandRegistrations.delete(id)
    await release()
  }

  const unmountAuthoring = async () => {
    const currentInjection = authoringInjection
    pendingAuthoring.clear()
    for (const sessionId of [...activeAuthoring.keys()]) stopAuthoring(sessionId)
    const operations = [...commandRegistrations].map(async ([sessionId, release]) => {
      await release()
      if (commandRegistrations.get(sessionId) === release) commandRegistrations.delete(sessionId)
    })
    if (typeof currentInjection === 'function') {
      operations.push(Promise.resolve(currentInjection()).then(() => {
        if (authoringInjection === currentInjection) authoringInjection = undefined
      }))
    } else if (typeof currentInjection?.dispose === 'function') {
      operations.push(Promise.resolve(currentInjection.dispose()).then(() => {
        if (authoringInjection === currentInjection) authoringInjection = undefined
      }))
    }
    const results = await Promise.allSettled(operations)
    const failures = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Global User Bindings authoring unmount failed')
  }

  const mountAuthoring = () => {
    if (!enabled || disposed || authoringInjection !== undefined || typeof ctx.inject !== 'function') return
    const generation = lifecycleGeneration
    authoringInjection = ctx.inject(['commands', 'skills'], (scope) => {
      if (!enabled || disposed || lifecycleGeneration !== generation) return
      for (const agent of scope.agents?.list?.() ?? []) registerCommandFor(agent)
      scope.on?.('agent/created', ({ agent }) => registerCommandFor(agent))
      scope.on?.('agent/disposed', ({ agent }) => {
        const sessionId = sessionIdOf(agent)
        if (sessionId === undefined) return
        stopAuthoring(sessionId)
        commandRegistrations.delete(sessionId)
        agentPresentations.delete(sessionId)
        sessionAgents.delete(sessionId)
        const draft = drafts.get(sessionId)
        if (draft !== undefined) removeDraft(draft)
      })
      scope.on?.('agent/turn-stopping', ({ agent }) => {
        const sessionId = sessionIdOf(agent)
        if (sessionId !== undefined) stopAuthoring(sessionId)
      })
      scope.on?.('agent/error', ({ agent }) => {
        const sessionId = sessionIdOf(agent)
        if (sessionId !== undefined) stopAuthoring(sessionId)
      })
    })
  }

  const mountRpcRegistration = (state, record) => {
    if (!enabled || disposed || rpcMount !== state || record.registration !== undefined
      || typeof record.scope.connection?.rpc?.handle !== 'function') return
    const registration = ctx.effect(() => record.scope.connection.rpc.handle(
      RPC_CHANNEL,
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
    state.injection = ctx.inject(['connection'], (scope) => {
      if (!enabled || disposed || rpcMount !== state) return
      const record = { scope, registration: undefined }
      state.records.add(record)
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
        Promise.resolve().then(() => record.registration()).then(() => {
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
    clearSessionPresentation,
    async setDraftProjectionAvailable(available) {
      const next = available === true
      if (draftProjectionAvailable === next) return
      draftProjectionAvailable = next
      lifecycleGeneration += 1
      if (next) {
        for (const agent of sessionAgents.values()) registerCommandFor(agent)
        return
      }
      pendingAuthoring.clear()
      for (const sessionId of [...activeAuthoring.keys()]) stopAuthoring(sessionId)
      for (const draft of [...drafts.values()]) removeDraft(draft)
      const releases = [...commandRegistrations.values()]
      commandRegistrations.clear()
      const results = await Promise.allSettled(releases.map(release => Promise.resolve().then(release)))
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Global User Bindings command projection cleanup failed')
      }
    },
    draftCapabilityForAgent(agent) {
      const sessionId = sessionIdOf(agent)
      return sessionId === undefined ? null : drafts.get(sessionId)?.capability ?? null
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
        valueLimits: {
          maxNodes: nextConfig.maxValueNodes,
          maxEdges: nextConfig.maxValueEdges,
          maxArrayLength: nextConfig.maxValueArrayLength,
          maxBigIntDigits: nextConfig.maxValueBigIntDigits,
          maxStringBytes: nextConfig.maxOutputBytes,
        },
      }
      if (nextEnabled === previousEnabled) {
        currentOptions = nextOptions
        return
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
          try {
            await Promise.all([unmountRpc(), unmountAuthoring()])
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
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
      } catch (error) {
        enabled = previousEnabled
        currentOptions = previousOptions
        lifecycleGeneration += 1
        try {
          mountRpc()
          mountAuthoring()
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Global User Bindings disablement and rollback failed',
            { cause: error },
          )
        }
        throw error
      }
    },
    async dispose() {
      disposed = true
      enabled = false
      lifecycleGeneration += 1
      for (const draft of [...drafts.values()]) removeDraft(draft)
      await Promise.all([unmountRpc(), unmountAuthoring()])
    },
  })
}

export { RPC_CHANNEL as USER_BINDINGS_RPC_CHANNEL }
