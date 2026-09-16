import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { diagnostic, renderDiagnostic } from './diagnostic.js'
import { createFailureTracker, messageOf } from './failure-reporting.js'
import {
  createJournal,
  liveToolCallSeq,
  normalizeJournal,
  reduceStateOperations,
} from './session-journal.js'
import {
  pathToHead,
  recoveryBoundaryForHistory,
  recoverJournal,
  visibleExecutableCallSeqs,
} from './session-journal-recovery.js'
import { valueLimitsFromConfig } from './value-wire-schema.js'
import { normalizeBindingDescriptors } from './binding-descriptors.js'
import { resolveConfig } from './runtime-config.js'
import { WorkerClient } from './worker-client.js'
import { compilerWorkerCache } from './compiler-service.js'
import { BindingCatalog, durabilityState, transitionDurability } from './session-state.js'
import { SessionCellExecutor } from './session-cell-executor.js'
import { executionPolicies } from './binding-update-policy.js'
import {
  createReplMemorySnapshot,
  normalizeReplMemorySnapshot,
  unavailableReplMemorySnapshot,
} from './repl-memory-projection.js'

const WORKER_URL = new URL('./kernel-worker.js', import.meta.url)
function recoveryDiagnostic(count) {
  return diagnostic({
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    message: `Restored the durable head and skipped ${count} unreconstructable historical cell(s); their source remains in the session log.`,
    stateEffect: 'rolled-back',
    help: [
      'continue from the restored bindings',
      'do not reference values created only in the skipped suffix',
    ],
  })
}

function resolvedRuntimeConfig(config) {
  return Object.freeze(resolveConfig(config))
}

function emptyHistory() {
  return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
}

class ReplayFailure extends Error {
  constructor(node, cause) {
    super(messageOf(cause))
    this.node = node
  }
}

class ReplayCancelled extends Error {
  constructor(result) {
    super(result.error?.message ?? 'session replay cancelled')
    this.result = result
  }
}

class SessionKernel {
  constructor({ config, history, cwd, session, userBindingsCwd, withInitiator, observeValues }) {
    this.config = config
    this.history = history
    this.initialRecoveryBoundary = recoveryBoundaryForHistory(history)
    this.surfaceGeneration = undefined
    try {
      this.surfaceGeneration = session?.surface?.replaceGeneration
    } catch {
      this.surfaceGeneration = undefined
    }
    this.cwd = cwd
    this.userBindingsCwd = userBindingsCwd
    this.observeValues = observeValues
    this.session = session
    this.withInitiator = withInitiator
    this.durability = durabilityState()
    this.bindingCatalog = new BindingCatalog()
    this.replayed = false
    this.liveCallSeqs = new Set()
    this.recoveryNotice = history.volatileSuffix.length === 0
      ? undefined
      : recoveryDiagnostic(history.volatileSuffix.length)
    this.active = undefined
    this.sequence = 0
    this.tail = Promise.resolve()
    this.tentatives = new WeakMap()
    this.unsettledCells = 0
    this.pendingInspection = undefined
    this.pendingObservation = undefined
    this.workerObservation = undefined
    this.workerReservations = new Set()
    this.cellExecutor = new SessionCellExecutor(this)
    this.client = new WorkerClient({
      workerUrl: WORKER_URL,
      cwd,
      compilerCache: compilerWorkerCache,
      onMessage: message => this.cellExecutor.onMessage(message),
      onFailure: message => {
        this.pendingInspection?.finish()
        this.workerObservation = undefined
        this.active?.resolve({ logs: [], error: { kind: 'worker-exit', message } }, true)
      },
    })
    this.failures = createFailureTracker()
    this.reclamationSequence = 0
    this.reclamationRecords = new Map()
    this.reclamationAttempts = new Set()
    this.disposed = false
    this.disposal = undefined
  }

  resetWorker(worker) {
    const sequence = ++this.reclamationSequence
    const record = { failed: false, reason: undefined }
    this.reclamationRecords.set(sequence, record)
    let reset
    try {
      reset = this.client.reset(worker)
    } catch (error) {
      record.failed = true
      record.reason = error
      return
    }
    const attempt = Promise.resolve(reset).then(
      () => { this.reclamationRecords.delete(sequence) },
      error => {
        record.failed = true
        record.reason = error
      },
    )
    this.reclamationAttempts.add(attempt)
    attempt.then(() => { this.reclamationAttempts.delete(attempt) })
  }

  valueLimits(config = this.config) {
    return valueLimitsFromConfig(config)
  }

  assertReconfigurationAllowed(config) {
    if ((this.client.workerLimit !== undefined || this.workerReservations.size > 0)
      && config.maxOldGenerationSizeMb !== this.config.maxOldGenerationSizeMb) {
      throw new Error(
        'ptc-plus: maxOldGenerationSizeMb cannot change while a session worker is active; retry after the session is disposed',
      )
    }
  }

  reconfigure(config) {
    this.assertReconfigurationAllowed(config)
    this.config = config
  }

  reserveWorkerConfiguration(config) {
    const reservation = Object.freeze({ maxOldGenerationSizeMb: config.maxOldGenerationSizeMb })
    this.workerReservations.add(reservation)
    return reservation
  }

  releaseWorkerConfiguration(reservation) {
    this.workerReservations.delete(reservation)
  }

  run(request, config = this.config) {
    const execute = () => this.execute(request, config)
    const result = this.tail.then(execute, execute)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Observe only the existing, settled live worker; never recover or execute a cell for the UI. */
  observe(expected, signal) {
    if (this.pendingInspection !== undefined) return Promise.resolve(undefined)
    const current = () => {
      if (this.disposed || !this.config.replViewEnabled || signal?.aborted
        || this.client.worker === undefined || this.unsettledCells > 0) return false
      try {
        return this.session?.surface?.replaceGeneration === this.surfaceGeneration
          && isDeepStrictEqual(expected, createReplMemorySnapshot(this.bindingCatalog.snapshot()))
      } catch { return false }
    }
    return new Promise(resolve => {
      let finished = false
      let releaseQueue
      const id = ++this.sequence
      const finish = observation => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.pendingInspection?.id === id) this.pendingInspection = undefined
        resolve(current() && observation !== undefined
          ? createReplMemorySnapshot(this.bindingCatalog.snapshot(), observation) : undefined)
        releaseQueue?.()
      }
      const onAbort = () => finish()
      const timer = setTimeout(onAbort, 250)
      signal?.addEventListener('abort', onAbort, { once: true })
      const inspect = () => {
        if (finished) return
        if (!current()) { finish(); return }
        return new Promise(done => {
          releaseQueue = done
          const worker = this.client.worker
          let started = false
          this.pendingInspection = { id, finish, start: () => {
            if (started) return
            started = true
            if (!current() || this.client.worker !== worker) { finish(); return }
            try {
              this.client.post({ type: 'observe', id, names: expected.entries.map(entry => entry.name) })
              this.workerObservation = { id, worker, started: false }
            } catch { finish() }
          } }
          try { this.client.post({ type: 'prepare', id }) } catch { finish() }
        })
      }
      this.tail = this.tail.then(inspect, inspect)
    })
  }

  async execute(request, config) {
    const recoveryBoundaries = this.initialRecoveryBoundary === undefined
      ? []
      : [this.initialRecoveryBoundary]
    this.initialRecoveryBoundary = undefined
    const finishResult = result => recoveryBoundaries.length === 0
      ? result
      : { ...result, recoveryBoundaries: recoveryBoundaries.map(boundary => ({ ...boundary })) }
    let currentGeneration
    try {
      currentGeneration = this.session?.surface?.replaceGeneration
    } catch {
      currentGeneration = undefined
    }
    if (currentGeneration !== undefined && currentGeneration !== this.surfaceGeneration) {
      this.surfaceGeneration = currentGeneration
      const visibleCallSeqs = visibleExecutableCallSeqs(this.session)
      const contractsLiveState = [...this.liveCallSeqs].some(callSeq => (
        !(visibleCallSeqs instanceof Set) || !visibleCallSeqs.has(callSeq)
      ))
      if ((config.durableReplay && !this.replayed) || contractsLiveState) {
        const worker = this.client.worker
        if (worker !== undefined) await this.client.reset(worker)
        this.rollbackToDurable()
        if (config.durableReplay) {
          this.recoveryNotice = undefined
          try {
            this.history = recoverJournal(this.session, request.callSeq, {
              visibleCallSeqs,
            })
          } catch (error) {
            const boundary = recoveryBoundaryForHistory(this.history, undefined, { reset: true })
            if (boundary !== undefined) recoveryBoundaries.push(boundary)
            this.history = emptyHistory()
            this.recoveryNotice = recoveryDiagnostic(1)
            this.initialRecoveryBoundary = undefined
          }
          if (this.history.volatileSuffix.length > 0) {
            this.recoveryNotice = recoveryDiagnostic(this.history.volatileSuffix.length)
          }
          this.initialRecoveryBoundary = recoveryBoundaryForHistory(this.history)
          if (this.initialRecoveryBoundary !== undefined) {
            recoveryBoundaries.push(this.initialRecoveryBoundary)
            this.initialRecoveryBoundary = undefined
          }
        } else {
          this.history = emptyHistory()
          this.replayed = true
          this.recoveryNotice = recoveryDiagnostic(1)
        }
      }
    }
    if (!this.replayed && config.durableReplay) {
      let skipped = 0
      while (!this.replayed) {
        try {
          await this.replayHistory(request, config)
          this.replayed = true
        } catch (error) {
          const worker = this.client.worker
          if (worker !== undefined) await this.client.reset(worker)
          if (error instanceof ReplayCancelled) {
            this.completeJournal(request.journal, 'noop', error.result)
            return finishResult(error.result)
          }
          try {
            if (!(error instanceof ReplayFailure)) throw error
            const previousPathLength = pathToHead(this.history).length
            const boundary = recoveryBoundaryForHistory(this.history, error.node)
            const recovered = recoverJournal(this.session, request.callSeq, {
              extraBoundaries: [boundary],
              visibleCallSeqs: visibleExecutableCallSeqs(this.session),
            })
            const nextPathLength = pathToHead(recovered).length
            if (nextPathLength >= previousPathLength) throw new Error('recovery did not contract the historical frontier')
            recoveryBoundaries.push(boundary)
            this.history = recovered
            skipped += previousPathLength - nextPathLength
          } catch {
            // Unproved historical metadata cannot gate the current request.
            // A failed or noncontracting recovery has no reusable frontier.
            const boundary = recoveryBoundaryForHistory(this.history, undefined, { reset: true })
            if (boundary !== undefined) recoveryBoundaries.push(boundary)
            this.history = emptyHistory()
            this.replayed = true
            skipped++
          }
          this.durability = durabilityState()
        }
      }
      if (skipped > 0) this.recoveryNotice = recoveryDiagnostic(skipped)
    }
    const leadingDiagnostics = this.recoveryNotice === undefined ? [] : [this.recoveryNotice]
    this.recoveryNotice = undefined
    if (request.journal !== undefined) request.journal.diagnostics.push(...leadingDiagnostics)
    const result = await this.cellExecutor.executeCell(request, undefined, config)
    if (leadingDiagnostics.length > 0) {
      const rendered = leadingDiagnostics.map(item => renderDiagnostic(item, request.program))
      result.logs = [...rendered, ...result.logs]
    }
    if (result.error === undefined) {
      this.failures.reset()
    } else {
      const primary = request.journal?.diagnostics.find(item => item.severity === 'error')
      const hint = this.failures.hint(result.error, primary?.stateEffect)
      if (hint !== undefined) {
        result.logs = [...result.logs, renderDiagnostic(hint, request.program)]
        if (request.journal !== undefined) request.journal.diagnostics.push(hint)
      }
    }
    return finishResult(result)
  }

  async replayHistory(request, config) {
    this.bindingCatalog = new BindingCatalog()
    const path = pathToHead(this.history)
    for (const node of path) {
      try {
        const result = await this.cellExecutor.executeCell(
          {
            ...request,
            program: node.code,
            journal: undefined,
            ...(node.userBindings === undefined ? { userBindings: undefined } : { userBindings: node.userBindings }),
          },
          node.journal,
          config,
        )
        const completion = node.journal.completion
        if (result.error !== undefined && !['exception', 'invalid-output'].includes(result.error.kind)) {
          if (result.error.kind === 'abort') throw new ReplayCancelled(result)
          throw new Error(`cell replay infrastructure failed (${result.error.kind}): ${result.error.message}`)
        }
        if (completion.kind === 'return' && result.error !== undefined) {
          throw new Error(`cell replay failed: ${result.error.message}`)
        }
        if (completion.kind === 'throw') {
          if (result.error === undefined) throw new Error('cell replay succeeded where the recorded cell failed')
          if (result.error.kind !== completion.error.kind || result.error.message !== completion.error.message) {
            throw new Error('cell replay produced a different semantic failure')
          }
        }
      } catch (error) {
        if (error instanceof ReplayCancelled) throw error
        throw new ReplayFailure(node, error)
      }
    }
    for (const node of path) this.liveCallSeqs.add(node.callSeq)
  }

  completeJournal(journal, status, result, volatileReason, diagnostics = [], completion = undefined) {
    if (journal === undefined) return
    journal.status = status
    journal.completion = result.error === undefined
      ? {
          kind: 'return',
          hasValue: completion?.hasValue === true,
          ...(completion?.hasValue === true ? { value: completion.value } : {}),
        }
      : { kind: 'throw', error: { kind: result.error.kind, message: result.error.message } }
    if (volatileReason !== undefined) journal.volatileReason = volatileReason
    if (diagnostics.length > 0) journal.diagnostics.push(...diagnostics)
    if (status === 'volatile') {
      journal.operations = journal.operations.filter(operation => operation.action !== 'save')
    }
    if (status === 'discarded' || status === 'noop') {
      journal.userBindingNames = null
      journal.calls.length = 0
      journal.operations.length = 0
    }
  }

  rollbackToDurable() {
    this.workerObservation = undefined
    this.durability = durabilityState()
    this.replayed = false
    this.bindingCatalog = new BindingCatalog()
    this.liveCallSeqs.clear()
  }

  settleCell(active, result, terminate = false) {
    /* c8 ignore next */
    if (this.active !== active) return
    active.settled = true
    const { request, journal, replay, worker } = active
    clearInterval(active.computeTimer)
    clearTimeout(active.wallTimer)
    request.signal?.removeEventListener('abort', active.onAbort)
    if (active.rewrites !== undefined && active.rewrites.length > 0) {
      result = { ...result, rewrites: active.rewrites }
    }
    if (journal !== undefined && replay === undefined) {
      journal.userBindingsFingerprint = terminate
        ? null
        : active.userBindingSnapshot?.fingerprint ?? null
      journal.userBindingNames = terminate ? null : active.userBindingNames ?? null
      if (terminate) {
        const volatileReason = active.pendingBindings.values().next().value ?? active.durability.reason
        this.completeJournal(journal, 'discarded', result, volatileReason, active.diagnostics)
        this.rollbackToDurable()
        if (volatileReason !== undefined) {
          this.durability = transitionDurability(this.durability, {
            type: 'volatile',
            reason: volatileReason,
          })
        }
      } else {
        const status = active.durability.status
        this.completeJournal(
          journal, status, result, active.durability.reason, active.diagnostics, active.completion,
        )
        this.tentatives.set(journal, {
          callSeq: request.callSeq,
          program: request.program,
          bindingCatalog: active.appliedBindingCatalog,
          userBindings: active.userBindingSnapshot,
          worker,
        })
        this.unsettledCells++
      }
    }
    if (!terminate) {
      this.bindingCatalog = active.appliedBindingCatalog
    }
    if (replay === undefined && !terminate) {
      // A live cell establishes this worker's timeline even when historical
      // replay was disabled. Only a reset may reopen its recovery boundary.
      this.replayed = true
      this.liveCallSeqs.add(request.callSeq ?? request.sourceCallSeq)
    }
    this.active = undefined
    if (terminate) {
      this.workerObservation = undefined
      // A refused reclamation stays recorded on this kernel instead of becoming
      // an unhandled rejection; the kernel keeps the worker until dispose.
      this.resetWorker(worker)
    }
    if (!terminate && active.observing && replay === undefined) {
      // Computation and journal settlement are complete. Observation cannot change either.
      // done with observing=true precedes synchronous observation in the same worker turn.
      this.workerObservation = { id: active.id, worker, started: true }
      const timer = setTimeout(() => this.finishObservation({ id: active.id }), 250)
      this.pendingObservation = { id: active.id, timer, journal, finish: () => active.finish(result) }
    } else active.finish(result)
  }

  finishObservation(message) {
    const inspection = this.pendingInspection
    if (inspection !== undefined && inspection.id === message.id) {
      inspection.finish(message.observation)
      return
    }
    const pending = this.pendingObservation
    if (pending === undefined || pending.id !== message.id) return
    this.pendingObservation = undefined
    clearTimeout(pending.timer)
    const tentative = this.tentatives.get(pending.journal)
    if (tentative !== undefined) tentative.observation = message.observation
    pending.finish()
  }

  finalizeJournal(journal, confirmed) {
    const tentative = this.tentatives.get(journal)
    if (tentative === undefined) return
    this.tentatives.delete(journal)
    this.unsettledCells--
    if (!confirmed) {
      if (journal.status === 'durable' || journal.status === 'volatile') {
        const reason = journal.volatileReason ?? 'run_code journal was not preserved in the final tool result'
        this.durability = transitionDurability(this.durability, {
          type: 'volatile',
          reason,
        })
      }
      return
    }
    if (journal.status === 'durable') {
      const normalized = normalizeJournal(journal)
      const node = Object.freeze({
        code: tentative.program,
        journal: normalized,
        ...(tentative.callSeq === undefined ? {} : { callSeq: tentative.callSeq }),
        ...(tentative.userBindings === undefined ? {} : { userBindings: tentative.userBindings }),
        parent: this.history.head,
      })
      const index = this.history.nodes.push(node) - 1
      this.history.head = index
      this.finishStateOperations(journal.operations, index, tentative.worker)
      return
    }
    if (journal.status === 'volatile') {
      this.durability = transitionDurability(this.durability, {
        type: 'volatile',
        reason: journal.volatileReason,
      })
      this.finishStateOperations(journal.operations, undefined, tentative.worker)
    }
  }

  replMemoryFor(journal) {
    const tentative = this.tentatives.get(journal)
    if (journal.status === 'discarded'
      || journal.operations.some(operation => operation.action === 'restore')) {
      return unavailableReplMemorySnapshot()
    }
    if (tentative === undefined) {
      return createReplMemorySnapshot(this.bindingCatalog.snapshot())
    }
    return createReplMemorySnapshot(tentative.bindingCatalog.snapshot(), tentative.observation)
  }

  userBindingsFor(journal) {
    return this.tentatives.get(journal)?.userBindings
  }

  finishStateOperations(operations, index, worker) {
    const transition = reduceStateOperations(this.history, operations, index)
    this.history.head = transition.head
    this.history.checkpoints = transition.checkpoints
    if (transition.restored) {
      this.rollbackToDurable()
      this.resetWorker(worker)
    }
  }

  dispose() {
    if (this.disposal !== undefined) return this.disposal
    const operation = this.#dispose()
    this.disposal = operation
    operation.then(
      () => { if (this.disposal === operation) this.disposal = undefined },
      () => { if (this.disposal === operation) this.disposal = undefined },
    )
    return operation
  }

  async #dispose() {
    this.disposed = true
    this.pendingInspection?.finish()
    this.workerObservation = undefined
    // Keep any refused reclamation observable through this kernel's dispose.
    const worker = this.client.worker
    if (worker !== undefined) {
      /* c8 ignore next */
      this.active?.resolve({ logs: [], error: { kind: 'abort', message: 'session kernel disposed' } }, true)
    }
    await this.client.dispose()
    await this.tail
    await Promise.all([...this.reclamationAttempts])
    // A successful client disposal proves its owner no longer retains the
    // helpers. Report every earlier refusal once, then let a later terminal
    // retry release this already reclaimed kernel.
    const reclamationFailures = [...this.reclamationRecords.values()]
      .filter(record => record.failed)
      .map(record => record.reason)
    this.reclamationRecords.clear()
    if (reclamationFailures.length === 1) throw reclamationFailures[0]
    if (reclamationFailures.length > 1) {
      throw new AggregateError(reclamationFailures, 'ptc-plus session kernel reclamation failed')
    }
  }
}

function sessionOf(sessionContext) {
  if (typeof sessionContext !== 'object' || sessionContext === null) {
    return {
      id: String(sessionContext),
      session: undefined,
      callId: undefined,
      persistedCallSeq: undefined,
      cwd: undefined,
    }
  }
  const session = sessionContext.session
  return {
    id: String(sessionContext.id),
    session,
    callId: sessionContext.callId,
    persistedCallSeq: sessionContext.persistedCallSeq,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
  }
}

export class SessionRuntime {
  constructor(config = {}, options = {}) {
    this.config = resolvedRuntimeConfig(config)
    this.kernels = new Map()
    this.pendingNoops = new Map()
    this.settlements = new WeakSet()
    this.disposed = false
    this.userBindingsCwd = options.userBindingsCwd ?? process.cwd()
    if (typeof this.userBindingsCwd !== 'string' || !isAbsolute(this.userBindingsCwd)) {
      throw new TypeError('userBindingsCwd must be an absolute path')
    }
    this.withInitiator = typeof options.withInitiator === 'function' ? options.withInitiator : undefined
    this.observeSession = options.observeSession ?? (() => false)
    this.disposal = undefined
  }

  async run(sessionContext, request) {
    const execution = await this.runTentative(sessionContext, request)
    if (execution.settlement !== undefined) this.finalize(execution.settlement, true)
    return execution.result
  }

  reconfigure(config) {
    const resolved = resolvedRuntimeConfig(config)
    const kernels = [...this.kernels.values()]
    for (const kernel of kernels) kernel.assertReconfigurationAllowed(resolved)
    for (const kernel of kernels) kernel.reconfigure(resolved)
    this.config = resolved
  }

  async observe(sessionId, memory, signal) {
    if (this.disposed || !this.config.replViewEnabled) return undefined
    const { observation: _observation, ...expected } = normalizeReplMemorySnapshot(memory)
    if (!expected.available || expected.entries.length === 0) return undefined
    return this.kernels.get(sessionId)?.observe(expected, signal)
  }

  async runTentative(sessionContext, request) {
    const completed = result => Object.freeze({ result, settlement: undefined })
    if (this.disposed) return completed({ logs: [], error: { kind: 'abort', message: 'PTC runtime disposed' } })
    const cellConfig = this.config
    let bindingDescriptors
    try {
      bindingDescriptors = normalizeBindingDescriptors(request?.bindings)
    } catch (error) {
      return completed({ logs: [], error: { kind: 'exception', message: messageOf(error) } })
    }
    request = { ...request, bindings: bindingDescriptors.namespaces, bindingDescriptors }
    const { id: sessionId, session, callId, persistedCallSeq, cwd } = sessionOf(sessionContext)
    let callSeq
    let sourceCallSeq
    try {
      if (persistedCallSeq !== undefined
        && (!Number.isSafeInteger(persistedCallSeq) || persistedCallSeq < 0)) {
        throw new Error('persisted tool call sequence must be a non-negative safe integer')
      }
      if (cellConfig.durableReplay) {
        sourceCallSeq = liveToolCallSeq(session, callId, 'run_code')
        callSeq = persistedCallSeq ?? sourceCallSeq
      } else {
        sourceCallSeq = persistedCallSeq
        if (sourceCallSeq === undefined) {
          try {
            sourceCallSeq = liveToolCallSeq(session, callId, 'run_code')
          } catch {
            sourceCallSeq = undefined
          }
        }
      }
    } catch (error) {
      return completed({ logs: [], error: { kind: 'recovery', message: `cannot identify current run_code call in session log: ${messageOf(error)}` } })
    }
    let kernel = this.kernels.get(sessionId)
    if (kernel === undefined) {
      let history
      try {
        history = cellConfig.durableReplay
          ? recoverJournal(session, callSeq, {
            visibleCallSeqs: visibleExecutableCallSeqs(session),
          })
          : emptyHistory()
      } catch (error) {
        // Malformed PTC metadata is contracted by the ordered recovery owner.
        // Failure to read DSH's session source cannot prove a reset boundary.
        return completed({ logs: [], error: { kind: 'recovery', message: `cannot reconstruct REPL from session log: ${messageOf(error)}` } })
      }
      kernel = new SessionKernel({
        config: cellConfig,
        history,
        cwd,
        session,
        userBindingsCwd: this.userBindingsCwd,
        withInitiator: this.withInitiator,
        observeValues: () => this.config.replViewEnabled && this.observeSession(sessionId),
      })
      this.kernels.set(sessionId, kernel)
    }
    const policies = executionPolicies(cellConfig)
    const journal = createJournal(
      /* c8 ignore next */
      this.pendingNoops.get(sessionId) ?? [],
      policies.bindingPolicy,
      policies.rewritesEnabled,
      policies.languageSemantics,
    )
    const workerReservation = kernel.reserveWorkerConfiguration(cellConfig)
    let result
    try {
      result = await kernel.run({ ...request, journal, callSeq, sourceCallSeq }, cellConfig)
    } finally {
      kernel.releaseWorkerConfiguration(workerReservation)
    }
    const settlement = Object.freeze({
      journal,
      kernel,
      sessionId,
      replMemory: kernel.replMemoryFor(journal),
      userBindings: kernel.userBindingsFor(journal),
      ...(result.recoveryBoundaries === undefined
        ? {}
        : { recoveryBoundaries: result.recoveryBoundaries }),
      ...(result.rewrites === undefined ? {} : { rewrites: result.rewrites }),
    })
    this.settlements.add(settlement)
    const {
      journal: _ignored,
      recoveryBoundaries: _recoveryBoundaries,
      ...publicResult
    } = result
    return Object.freeze({ result: publicResult, settlement })
  }

  noteNoop(sessionId, session, callId) {
    const callSeq = liveToolCallSeq(session, String(callId), 'run_code')
    if (callSeq === undefined) return
    const id = String(sessionId)
    let calls = this.pendingNoops.get(id)
    if (calls === undefined) {
      calls = new Set()
      this.pendingNoops.set(id, calls)
    }
    calls.add(callSeq)
  }

  finalize(settlement, confirmed) {
    if (settlement === null || typeof settlement !== 'object' || !this.settlements.delete(settlement)) {
      throw new TypeError('ptc-plus: finalize requires one unsettled SessionRuntime settlement handle')
    }
    const { journal, kernel, sessionId } = settlement
    kernel.finalizeJournal(journal, confirmed)
    if (!confirmed) return
    const noops = this.pendingNoops.get(sessionId)
    if (noops === undefined) return
    for (const callSeq of journal.confirms ?? []) noops.delete(callSeq)
    if (noops.size === 0) this.pendingNoops.delete(sessionId)
  }

  async disposeSession(sessionId) {
    const id = String(sessionId)
    const kernel = this.kernels.get(id)
    this.pendingNoops.delete(id)
    if (kernel === undefined) return
    // The entry survives a failed dispose so a repeated dispose reports the same
    // unreclaimed instance instead of appearing to succeed.
    await kernel.dispose()
    this.kernels.delete(id)
  }

  dispose() {
    if (this.disposal !== undefined) return this.disposal
    const operation = this.#dispose()
    this.disposal = operation
    operation.then(
      () => { if (this.disposal === operation) this.disposal = undefined },
      () => { if (this.disposal === operation) this.disposal = undefined },
    )
    return operation
  }

  async #dispose() {
    this.disposed = true
    const entries = [...this.kernels]
    const results = await Promise.allSettled(entries.map(async ([id, kernel]) => {
      await kernel.dispose()
      this.kernels.delete(id)
    }))
    const failures = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'ptc-plus session runtime disposal failed')
    }
  }
}
