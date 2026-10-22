import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { diagnostic, renderDiagnostic } from './diagnostic.js'
import { createFailureTracker, messageOf } from './failure-reporting.js'
import {
  createJournal,
  isCanonicalSequence,
  liveToolCallSeq,
  normalizeJournal,
  reduceStateOperations,
} from './session-journal.js'
import {
  foldSessionTimeline,
  pathToHead,
  recoveryBoundaryForHistory,
  recoverJournal,
  visibleExecutableCallSeqs,
} from './session-journal-recovery.js'
import { valueLimitsFromConfig } from './value-wire-schema.js'
import { encodeValueAtBoundary, valueWiresEqual } from './value-wire.js'
import { normalizeBindingDescriptors } from './binding-descriptors.js'
import { resolveConfig } from './runtime-config.js'
import { WorkerClient } from './worker-client.js'
import { compilerWorkerCache } from './compiler-service.js'
import { BindingCatalog, durabilityState, transitionDurability } from './session-state.js'
import { SessionCellExecutor } from './session-cell-executor.js'
import { CellAdmissionBlocked } from './cell-error.js'
import { executionPolicies } from './binding-update-policy.js'
import {
  createReplMemorySnapshot,
  normalizeReplMemorySnapshot,
  REPL_MEMORY_META_KEY,
  unavailableReplMemorySnapshot,
} from './repl-memory-projection.js'

const WORKER_URL = new URL('./kernel-worker.js', import.meta.url)
const UNAVAILABLE_SURFACE_GENERATION = Symbol('unavailableSurfaceGeneration')

function surfaceGeneration(session, provenanceRequired = true) {
  try {
    const surface = session?.surface
    const generation = surface?.replaceGeneration
    if (generation === undefined) return provenanceRequired ? UNAVAILABLE_SURFACE_GENERATION : undefined
    return surface.contentGeneration === undefined
      ? generation
      : `${generation}:${surface.contentGeneration}`
  } catch {
    return provenanceRequired ? UNAVAILABLE_SURFACE_GENERATION : undefined
  }
}

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

/**
 * Fallback for `unmeasuredCellLimit`: consecutive cells that may end before
 * they reach the runtime while the live worker is kept.
 *
 * One such cell is not evidence about the worker: the host may simply have been
 * unable to observe it. The configured limit (default two) ends the sequence, so
 * a worker that never becomes dispatchable cannot stay in charge of every later
 * cell; reaching it drops the live worker and lets the next cell replay the
 * proved frontier.
 */
const UNMEASURED_CELL_LIMIT = 2

class ReplayCancelled extends Error {
  constructor(result) {
    super(result.error?.message ?? 'session replay cancelled')
    this.result = result
  }
}

/**
 * A recorded cell whose execution could not be measured.
 *
 * The cell never ran, so the recorded history remains exactly as proved and the
 * replay may be attempted again through a fresh worker.
 */
class ReplayUnmeasured extends Error {
  constructor(result) {
    super(result.error?.message ?? 'session replay could not be measured')
    this.result = result
  }
}

class SessionKernel {
  constructor({ config, history, cwd, session, surfaceProvenanceRequired, userBindingsCwd, withInitiator, observeValues }) {
    this.config = config
    this.history = history
    this.initialRecoveryBoundary = recoveryBoundaryForHistory(history)
    this.surfaceGeneration = surfaceGeneration(session, surfaceProvenanceRequired)
    this.cwd = cwd
    this.userBindingsCwd = userBindingsCwd
    this.observeValues = observeValues
    this.session = session
    this.surfaceProvenanceRequired = surfaceProvenanceRequired
    this.withInitiator = withInitiator
    this.durability = durabilityState()
    this.bindingCatalog = new BindingCatalog()
    this.replayed = false
    this.unmeasuredCells = 0
    this.liveCallSeqs = new Set()
    this.recoveryNotice = history.volatileSuffix.length === 0
      ? undefined
      : recoveryDiagnostic(history.volatileSuffix.length)
    this.recoveryNoticeShown = false
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
      onUnmatchedOutputFailure: message => {
        const active = this.active
        if (active === undefined) return false
        active.resolve({ logs: [], error: { kind: 'worker-exit', message } }, true)
        return true
      },
      onFailure: message => {
        this.pendingInspection?.finish()
        this.workerObservation = undefined
        const active = this.active
        if (active === undefined) return false
        active.resolve({ logs: [], error: { kind: 'worker-exit', message } }, true)
        return true
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
      return Promise.resolve(record)
    }
    const attempt = Promise.resolve(reset).then(
      () => { this.reclamationRecords.delete(sequence); return record },
      error => {
        record.failed = true
        record.reason = error
        return record
      },
    )
    this.reclamationAttempts.add(attempt)
    attempt.then(() => { this.reclamationAttempts.delete(attempt) })
    return attempt
  }

  /**
   * Start the session worker with the bounds the kernel holds now.
   *
   * The worker serves later cells as well as the one that starts it, so its
   * close rule and startup bound follow the kernel's current configuration even
   * when the starting cell was admitted before a settings change. Calibrating
   * the transport after ensure covers a worker that already existed.
   */
  async ensureWorker(maxOldGenerationSizeMb) {
    // A live worker already took its bounds at creation and reconfigure keeps it
    // current. The client reads this projection only when it actually starts a
    // worker, after its scratch wait, so a settings change in that window still
    // reaches the startup and close bounds.
    return this.client.ensure(maxOldGenerationSizeMb, () => ({
      reclaimBoundMs: this.config.workerReclaimMs,
      startupProbeMs: this.config.startupProbeMs,
    }))
  }

  async prepareWorker() {
    await Promise.all([...this.reclamationAttempts])
    const failures = [...this.reclamationRecords.values()].filter(record => record.failed).map(record => record.reason)
    if (failures.length) throw new CellAdmissionBlocked(failures)
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
    // The close path reads the bound the transport carries, and a live worker can
    // be dropped outside resetWorker (idle disposal, owner auto-close), so the
    // current configuration has to reach the transport as soon as it is applied.
    const worker = this.client.worker
    if (worker !== undefined && Number.isSafeInteger(config.workerReclaimMs)) {
      worker.reclaimBoundMs = config.workerReclaimMs
    }
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
      return surfaceGeneration(this.session, this.surfaceProvenanceRequired) === this.surfaceGeneration
        && (!this.surfaceProvenanceRequired
          || this.surfaceGeneration !== UNAVAILABLE_SURFACE_GENERATION)
        && isDeepStrictEqual(expected, createReplMemorySnapshot(this.bindingCatalog.snapshot()))
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
    const observedSession = request.sessionLog ?? this.session
    const recoveryBoundaries = this.initialRecoveryBoundary === undefined
      ? []
      : [this.initialRecoveryBoundary]
    this.initialRecoveryBoundary = undefined
    const finishResult = result => recoveryBoundaries.length === 0
      ? result
      : { ...result, recoveryBoundaries: recoveryBoundaries.map(boundary => ({ ...boundary })) }
    const currentGeneration = surfaceGeneration(this.session, this.surfaceProvenanceRequired)
    const hasLiveState = this.liveCallSeqs.size > 0
    if (this.surfaceProvenanceRequired
      && (currentGeneration !== this.surfaceGeneration || hasLiveState)) {
      this.surfaceGeneration = currentGeneration
      const visibleCallSeqs = visibleExecutableCallSeqs(observedSession)
      const contractsLiveState = [...this.liveCallSeqs].some(callSeq => (
        !(visibleCallSeqs instanceof Set) || !visibleCallSeqs.has(callSeq)
      ))
      if ((config.durableReplay && !this.replayed) || contractsLiveState) {
        const worker = this.client.worker
        // A refused stop stays recorded here, so the later admission check in
        // prepareWorker() blocks computation beside an unreclaimed helper.
        if (worker !== undefined) await this.resetWorker(worker)
        this.rollbackToDurable()
        if (config.durableReplay) {
          this.recoveryNotice = undefined
          try {
            this.history = recoverJournal(observedSession, request.callSeq, {
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
      let recoveryAttempted = false
      // A replay pass can end before the loop settles either because it was
      // cancelled or because a recorded cell could not be measured; a front it
      // already contracted still has to reach the model in those cases.
      const leavingReplay = result => {
        if (skipped === 0) return result
        const notice = recoveryDiagnostic(skipped)
        if (request.journal !== undefined) request.journal.diagnostics.push(notice)
        return { ...result, logs: [...result.logs, renderDiagnostic(notice, request.program)] }
      }
      while (!this.replayed) {
        try {
          await this.replayHistory(request, config)
          this.replayed = true
        } catch (error) {
          // Reclamation goes through the kernel's owner so a refused stop stays
          // recorded: prepareWorker() then blocks later computation until that
          // failure is handled, instead of admitting it beside a live helper.
          const retainedReasons = () => [...this.reclamationRecords.values()]
            .filter(record => record.failed)
            .map(record => record.reason)
          const worker = this.client.worker
          // A refusal may predate this catch: the abandoned cell that ended the
          // previous attempt already reset its worker, so no worker is reachable
          // here while the failure stays recorded. A retained refusal keeps the
          // helper until disposal, so a second attempt would record the same
          // refusal again; the guidance below follows the retained outcome, which
          // is also what the admission gate enforces.
          if (worker !== undefined && retainedReasons().length === 0) await this.resetWorker(worker)
          const reasons = retainedReasons()
          const unreclaimed = reasons.length === 0
            ? ''
            : `; helper reclamation failed: ${String(reasons[0]?.message ?? reasons[0])}`
          if (error instanceof CellAdmissionBlocked) {
            // The replay could not start because an earlier helper was not
            // reclaimed. That says nothing about the recorded cells, so the
            // frontier keeps what this pass proved, including a contraction it
            // already performed, whose notice therefore still has to be reported.
            const blocked = { logs: [], error: { kind: 'worker-exit', message: error.message } }
            this.completeJournal(request.journal, 'discarded', blocked)
            return finishResult(leavingReplay(blocked))
          }
          if (error instanceof ReplayCancelled) {
            this.completeJournal(request.journal, 'noop', error.result)
            return finishResult(leavingReplay(error.result))
          }
          // A historical cell that could not be measured never ran, so it proves
          // nothing against the recorded frontier. The reset above left an empty
          // worker, so the replay is retried once; a second unmeasured replay
          // through a fresh worker still says nothing about the recorded history,
          // which therefore stays intact for the next cell to replay again.
          if (error instanceof ReplayUnmeasured) {
            if (!recoveryAttempted && unreclaimed === '') {
              recoveryAttempted = true
              this.durability = durabilityState()
              continue
            }
            this.rollbackToDurable()
            const blocked = unreclaimed !== ''
            // The sampled cell's own message tells the model to retry that cell and
            // may already carry the refusal. Neither holds here: the admission gate
            // will refuse the retry, and one refusal must not be reported twice.
            const facts = blocked ? messageOf(error).replace('; retry the cell', '') : messageOf(error)
            const repeated = blocked && facts.includes(unreclaimed)
            const unmeasured = {
              logs: error.result.logs,
              error: {
                kind: 'budget-unavailable',
                // A refusal leaves later computation blocked, so the result must
                // not promise a replay that the admission gate will refuse.
                message: `${facts}; ${skipped === 0
                  ? 'the recorded frontier is unchanged'
                  : 'the recorded frontier contracted as the recovery notice reports'}, ${blocked
                  ? 'later computation stays blocked until the session is disposed'
                  : 'the kernel worker was reset, and the next cell replays the remaining frontier'}${repeated ? '' : unreclaimed}`,
              },
            }
            this.completeJournal(request.journal, 'noop', unmeasured)
            return finishResult(leavingReplay(unmeasured))
          }
          try {
            if (!(error instanceof ReplayFailure)) throw error
            const previousPathLength = pathToHead(this.history).length
            const boundary = recoveryBoundaryForHistory(this.history, error.node)
            const recovered = recoverJournal(observedSession, request.callSeq, {
              extraBoundaries: [boundary],
              visibleCallSeqs: visibleExecutableCallSeqs(observedSession),
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
    const leadingDiagnostics = this.recoveryNotice === undefined || this.recoveryNoticeShown
      ? [] : [this.recoveryNotice]
    this.recoveryNoticeShown = this.recoveryNotice !== undefined
    this.recoveryNotice = undefined
    if (request.journal !== undefined) request.journal.diagnostics.push(...leadingDiagnostics)
    let result
    try {
      result = await this.cellExecutor.executeCell(request, undefined, config)
    } catch (error) {
      // The kernel refused to admit this cell because an earlier helper was not
      // reclaimed. Nothing ran and nothing about the recorded history changed, so
      // the cell settles on its own terms instead of blaming the source; the
      // recovery notice prepared above is still attached below.
      if (!(error instanceof CellAdmissionBlocked)) throw error
      result = { logs: [], error: { kind: 'worker-exit', message: error.message } }
      this.completeJournal(request.journal, 'discarded', result)
    }
    if (result.error === undefined) {
      this.failures.reset()
    } else {
      const primary = request.journal?.diagnostics.find(item => item.severity === 'error')
      // A no-op journal is this cell's own record that nothing it could have done
      // is in the REPL state, so a repeated-failure hint must not describe that
      // state as unknown.
      const stateEffect = primary?.stateEffect
        ?? (request.journal?.status === 'noop' ? 'unchanged' : undefined)
      const hint = this.failures.hint(result.error, stateEffect)
      if (hint !== undefined) {
        result.logs = [...result.logs, renderDiagnostic(hint, request.program)]
        if (request.journal !== undefined) request.journal.diagnostics.push(hint)
      }
    }
    if (leadingDiagnostics.length > 0) {
      const rendered = leadingDiagnostics.map(item => renderDiagnostic(item, request.program))
      if (result.error === undefined) result.logs = [...rendered, ...result.logs]
      else result.error = { ...result.error, message: [result.error.message, ...rendered].join('\n') }
    }
    return finishResult(result)
  }

  async replayHistory(request, config) {
    this.bindingCatalog = new BindingCatalog()
    const limits = this.valueLimits(config)
    const emptyArgsWire = encodeValueAtBoundary({}, limits, 'parameter')
    const path = pathToHead(this.history)
    for (const node of path) {
      const bindings = replayBindingNamespaces(request.bindings, node.journal, limits, emptyArgsWire)
      const bindingDescriptors = bindings === request.bindings
        ? request.bindingDescriptors : normalizeBindingDescriptors(bindings)
      try {
        const result = await this.cellExecutor.executeCell(
          {
            ...request,
            bindings: bindingDescriptors.namespaces,
            bindingDescriptors,
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
          // An unmeasured cell never ran: it disproves nothing about the recorded
          // frontier, and the replay can be attempted again through a fresh worker.
          if (result.error.kind === 'budget-unavailable') throw new ReplayUnmeasured(result)
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
        // A blocked admission is not a fact about this recorded cell, so it is
        // rethrown unchanged and never wrapped as a replay failure.
        if (error instanceof ReplayCancelled || error instanceof ReplayUnmeasured
          || error instanceof CellAdmissionBlocked) throw error
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
    // Every path that drops the live worker replaces it, so the next cell starts
    // its own sequence of unmeasured cells on a worker that has not failed yet.
    this.unmeasuredCells = 0
    this.bindingCatalog = new BindingCatalog()
    this.liveCallSeqs.clear()
  }

  /**
   * Settle a cell that never reached the runtime.
   *
   * A cell that was never dispatched has nothing to discard, no binding to roll
   * back and no reason to rebuild the worker, so its journal records a no-op
   * outcome and the live worker keeps the state earlier cells proved. Consecutive
   * such cells are the evidence that this worker does not become dispatchable:
   * the live worker is then dropped while the proved frontier stays, and the next
   * cell replays it. Budgets and the cancellation listener end with the cell
   * exactly as they do on any other settlement.
   */
  abandonCell(active, result) {
    if (this.active !== active) return
    active.settled = true
    clearInterval(active.computeTimer)
    clearTimeout(active.wallTimer)
    active.request.signal?.removeEventListener('abort', active.onAbort)
    this.active = undefined
    this.completeJournal(active.journal, 'noop', result)
    this.unmeasuredCells += 1
    // The cell was submitted under its own configuration snapshot, and that
    // snapshot decides its settlement even if the setting changed while it ran.
    const limit = Number.isSafeInteger(active.config?.unmeasuredCellLimit)
      ? active.config.unmeasuredCellLimit
      : Number.isSafeInteger(this.config?.unmeasuredCellLimit)
        ? this.config.unmeasuredCellLimit
        : UNMEASURED_CELL_LIMIT
    if (this.unmeasuredCells < limit) {
      active.finish(result)
      return
    }
    this.rollbackToDurable()
    // The model has to learn that the state this worker held is gone; only the
    // proved frontier survives for the next cell to replay.
    result = { ...result, error: { ...result.error,
      message: `${result.error?.message ?? 'cell could not be measured'}; this worker was dropped after consecutive unmeasured cells, so bindings outside the proved recovery frontier are no longer available` } }
    this.completeJournal(active.journal, 'noop', result)
    // A refused reclamation stays recorded on this kernel instead of becoming an
    // unhandled rejection; the kernel keeps the worker until dispose.
    void this.resetWorker(active.worker).then(record => {
      if (record.failed) {
        result = { ...result, error: { ...result.error,
          message: `${result.error?.message ?? 'cell could not be measured'}; helper reclamation failed: ${String(record.reason?.message ?? record.reason)}` } }
        if (active.journal !== undefined && active.replay === undefined) {
          this.completeJournal(active.journal, 'noop', result)
        }
      }
      active.finish(result)
    })
  }

  settleCell(active, result, terminate = false) {
    /* c8 ignore next */
    if (this.active !== active) return
    active.settled = true
    // Any cell that settles on a normal path disproves the sequence of cells that
    // never reached the runtime, whichever way it ended.
    this.unmeasuredCells = 0
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
      void this.resetWorker(worker).then(record => {
        if (record.failed) {
          result = { ...result, error: { ...result.error,
            message: `${result.error?.message ?? 'cell terminated'}; helper reclamation failed: ${String(record.reason?.message ?? record.reason)}` } }
          if (journal !== undefined && replay === undefined) {
            this.completeJournal(journal, 'discarded', result, journal.volatileReason, active.diagnostics)
          }
        }
        active.finish(result)
      })
      return
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
      surfaceProvenanceRequired: false,
    }
  }
  const session = sessionContext.session
  return {
    id: String(sessionContext.id),
    session,
    callId: sessionContext.callId,
    persistedCallSeq: sessionContext.persistedCallSeq,
    sourceCallSeq: sessionContext.sourceCallSeq,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
    surfaceProvenanceRequired: true,
  }
}

/**
 * Recorded-value replay settles a host call from its journal entry without
 * dispatching it. A member the Host no longer supplies must therefore stay
 * visible to the replayed cell as a replay-only stub; otherwise a routine
 * capability removal would make an otherwise provable cell unreconstructable
 * and contract the durable frontier. Zero-argument calls keep their recorded
 * empty-object form so the args wire still matches the journal.
 */
function replayBindingNamespaces(namespaces, journal, limits, emptyArgsWire) {
  const calls = journal?.calls ?? []
  let changed = false
  const next = namespaces.map(namespace => {
    const recorded = calls.filter(call => call.global === namespace.global)
    const missing = [...new Set(recorded.map(call => call.member))]
      .filter(member => !namespace.members.includes(member))
    if (missing.length === 0) return namespace
    changed = true
    const functions = { ...namespace.functions }
    const emptyObjectMembers = [...(namespace.emptyObjectMembers ?? [])]
    for (const member of missing) {
      // The replay executor settles or rejects every host-binding call from the
      // recorded journal, so the placeholder keeps the member visible without
      // ever running; the throw only guards a dispatch path that would bypass
      // recorded-value interception.
      /* c8 ignore next -- replay interception precedes invocation */
      functions[member] = () => { throw new Error(`replay-only member ${namespace.global}.${member}`) }
      if (recorded.some(call => call.member === member && valueWiresEqual(call.args, emptyArgsWire, limits))) {
        emptyObjectMembers.push(member)
      }
    }
    return { ...namespace, functions, emptyObjectMembers }
  })
  return changed ? next : namespaces
}

export class SessionRuntime {
  constructor(config = {}, options = {}) {
    this.config = resolvedRuntimeConfig(config)
    this.kernels = new Map()
    this.pendingNoops = new Map()
    this.settlements = new WeakSet()
    this.preparingCells = new Set()
    this.submissions = new WeakSet()
    this.disposed = false
    this.userBindingsCwd = options.userBindingsCwd ?? process.cwd()
    if (typeof this.userBindingsCwd !== 'string' || !isAbsolute(this.userBindingsCwd)) {
      throw new TypeError('userBindingsCwd must be an absolute path')
    }
    this.withInitiator = typeof options.withInitiator === 'function' ? options.withInitiator : undefined
    this.observeSession = options.observeSession ?? (() => false)
    this.readSessionLog = options.readSessionLog ?? (async session => session)
    this.sessionForId = options.sessionForId
    this.disposal = undefined
  }

  async run(sessionContext, request) {
    const execution = await this.runTentative(sessionContext, request)
    if (execution.settlement !== undefined) this.finalize(execution.settlement, true)
    return execution.result
  }

  beginSubmission(sessionContext, signal) {
    const admission = { sessionId: sessionOf(sessionContext).id, config: this.config,
      signal, cancelled: this.disposed }
    this.submissions.add(admission)
    if (!this.disposed) this.preparingCells.add(admission)
    return admission
  }

  releaseSubmission(admission) {
    this.preparingCells.delete(admission)
    this.submissions.delete(admission)
  }

  assertSubmission(admission) {
    if (this.disposed) throw new Error('PTC runtime disposed')
    if (admission.cancelled || !this.submissions.has(admission)) throw new Error('PTC session disposed')
  }

  reconfigure(config) {
    const resolved = resolvedRuntimeConfig(config)
    for (const admission of this.preparingCells) {
      if (!admission.signal?.aborted && resolved.maxOldGenerationSizeMb !== admission.config.maxOldGenerationSizeMb) {
        throw new Error('ptc-plus: maxOldGenerationSizeMb cannot change while a session worker is active; retry after the session is disposed')
      }
    }
    const kernels = [...this.kernels.values()]
    for (const kernel of kernels) kernel.assertReconfigurationAllowed(resolved)
    for (const kernel of kernels) kernel.reconfigure(resolved)
    this.config = resolved
  }

  async observe(sessionId, memory, signal) {
    if (this.disposed || !this.config.replViewEnabled) return undefined
    const { observation: _observation, ...expected } = normalizeReplMemorySnapshot(memory)
    if (!expected.available || expected.entries.length === 0) return undefined
    const kernel = this.kernels.get(sessionId)
    const session = kernel?.session ?? this.sessionForId?.(sessionId)
    if (session !== undefined && kernel?.surfaceProvenanceRequired !== false) {
      const observed = await this.readSessionLog(session, signal)
      signal?.throwIfAborted()
      const visible = visibleExecutableCallSeqs(observed)
      if (kernel !== undefined) {
        if ([...kernel.liveCallSeqs].some(seq => !visible.has(seq))) return unavailableReplMemorySnapshot()
        kernel.surfaceGeneration = surfaceGeneration(session)
      } else {
        const timeline = foldSessionTimeline(observed.events)
        const history = recoverJournal(observed, undefined, { visibleCallSeqs: visible })
        const head = history.nodes[history.head]
        if (head === undefined) return unavailableReplMemorySnapshot()
        // A cold inventory can describe a proved recorded frontier without
        // instantiating a worker. It cannot describe a discarded suffix.
        const resultSeq = timeline.results.get(head.callSeq)?.eventSeq
        const result = observed.events.find(event => event.type === 'tool/result' && event.seq === resultSeq)
        const recorded = result?.data?.meta?.[REPL_MEMORY_META_KEY]?.memory
        if (!isDeepStrictEqual(recorded, memory)) return unavailableReplMemorySnapshot()
      }
    }
    return kernel?.observe(expected, signal)
  }

  async runTentative(sessionContext, request, { programCompletion = false } = {}) {
    const completed = result => Object.freeze({ result, settlement: undefined })
    if (this.disposed) return completed({ logs: [], error: { kind: 'abort', message: 'PTC runtime disposed' } })
    let bindingDescriptors
    try {
      bindingDescriptors = normalizeBindingDescriptors(request?.bindings)
    } catch (error) {
      return completed({ logs: [], error: { kind: 'exception', message: messageOf(error) } })
    }
    request = { ...request, bindings: bindingDescriptors.namespaces, bindingDescriptors }
    if (request.cwd !== undefined && (typeof request.cwd !== 'string' || !isAbsolute(request.cwd))) {
      return completed({ logs: [], error: { kind: 'exception', message: 'PTC execution cwd must be an absolute path' } })
    }
    const {
      id: sessionId,
      session,
      callId,
      persistedCallSeq,
      sourceCallSeq: provedSourceCallSeq,
      cwd,
      surfaceProvenanceRequired,
    } = sessionOf(sessionContext)
    let callSeq
    let sourceCallSeq
    let sessionLog
    const admission = sessionContext?.submission ?? this.beginSubmission(sessionContext, request.signal)
    if (!this.submissions.has(admission) || admission.sessionId !== sessionId) {
      return completed({ logs: [], error: { kind: 'exception', message: 'PTC submission does not belong to this session runtime' } })
    }
    const cellConfig = admission.config
    const aborted = () => this.disposed || admission.cancelled
    const abortResult = () => completed({ logs: [], error: { kind: 'abort',
      message: request.signal?.aborted ? String(request.signal.reason)
        : this.disposed ? 'PTC runtime disposed' : 'PTC session disposed' } })
    try {
      sessionLog = sessionContext?.sessionLog ?? await this.readSessionLog(session, request.signal)
      if (aborted()) return abortResult()
      if (persistedCallSeq !== undefined
        && !isCanonicalSequence(persistedCallSeq)) {
        throw new Error('persisted tool call sequence must be a non-negative safe integer')
      }
      if (provedSourceCallSeq !== undefined
        && !isCanonicalSequence(provedSourceCallSeq)) {
        throw new Error('source tool call sequence must be a non-negative safe integer')
      }
      if (cellConfig.durableReplay) {
        sourceCallSeq = provedSourceCallSeq ?? liveToolCallSeq(sessionLog, callId, 'run_code')
        callSeq = persistedCallSeq ?? sourceCallSeq
      } else {
        sourceCallSeq = provedSourceCallSeq ?? persistedCallSeq
        if (sourceCallSeq === undefined) {
          try {
            sourceCallSeq = liveToolCallSeq(sessionLog, callId, 'run_code')
          } catch {
            sourceCallSeq = undefined
          }
        }
      }
    } catch (error) {
      if (aborted() || request.signal?.aborted) return abortResult()
      return completed({ logs: [], error: { kind: 'recovery', message: `cannot identify current run_code call in session log: ${messageOf(error)}` } })
    } finally {
      this.releaseSubmission(admission)
    }
    let kernel = this.kernels.get(sessionId)
    if (kernel === undefined) {
      let history
      try {
        history = cellConfig.durableReplay
          ? recoverJournal(sessionLog, callSeq, {
            visibleCallSeqs: visibleExecutableCallSeqs(sessionLog),
          })
          : emptyHistory()
      } catch (error) {
        // Malformed PTC metadata is contracted by the ordered recovery owner.
        // Failure to read DSH's session source cannot prove a reset boundary.
        return completed({ logs: [], error: { kind: 'recovery', message: `cannot reconstruct REPL from session log: ${messageOf(error)}` } })
      }
      kernel = new SessionKernel({
        // The kernel owns the worker and the sessions it serves, so it takes the
        // configuration current when the session starts; this cell's own budgets
        // still come from the submitted snapshot passed to run().
        config: this.config,
        history,
        cwd,
        session,
        surfaceProvenanceRequired,
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
      policies.moduleTransform,
      request.cwd ?? cwd ?? null,
    )
    const workerReservation = kernel.reserveWorkerConfiguration(cellConfig)
    let result
    try {
      result = await kernel.run({ ...request, journal, callSeq, sourceCallSeq, sessionLog, programCompletion }, cellConfig)
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
    for (const admission of this.preparingCells) {
      if (admission.sessionId === id) {
        admission.cancelled = true
        this.preparingCells.delete(admission)
      }
    }
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
    this.preparingCells.clear()
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
