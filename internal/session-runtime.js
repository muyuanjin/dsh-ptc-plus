import { createHash } from 'node:crypto'
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
  bindingNamesOfOperations,
  recoveryBoundaryForHistory,
  recoverJournal,
  visibleExecutableCallSeqs,
} from './session-journal-recovery.js'
import { sessionEvents } from './session-events.js'
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

/**
 * Tell "the surface proves this call is gone" apart from "the surface cannot be
 * read right now".
 *
 * A queued message, a mid-flight surface replacement or any transient host
 * state can leave `session.surface.nodes` unreadable for one request. Reading
 * that as an empty visible set made every live binding look contracted, so the
 * worker was reset and the journal replayed; a replay that cannot reproduce an
 * old completion then contracted the whole suffix and the user lost the REPL.
 * Only a readable surface may decide that a live binding lost its provenance.
 */
function surfaceReadable(session) {
  try {
    if (!Array.isArray(session?.surface?.nodes)) return false
    return Array.isArray(session?.events)
  } catch {
    return false
  }
}

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

/**
 * Per-call source digest of the visible surface.
 *
 * A surface republish appends or re-renders; a history change removes a call or
 * rewrites its source. Distinguishing the two needs the call set plus each
 * call's own bytes, not the whole message tree: digests stay cheap, and an
 * unchanged call keeps its digest across a re-render.
 */
function visibleCallSources(session) {
  const seqs = visibleExecutableCallSeqs(session)
  if (!(seqs instanceof Set)) return undefined
  const sources = new Map()
  let events
  try {
    events = sessionEvents(session)
  } catch {
    return undefined
  }
  for (const event of events ?? []) {
    if (!seqs.has(event?.seq) || event?.type !== 'tool/call') continue
    const source = typeof event.data?.arguments === 'string' ? event.data.arguments : ''
    sources.set(event.seq, createHash('sha256').update(source).digest('hex'))
  }
  return { seqs, sources }
}

/**
 * Whether a surface republish actually rewrote history.
 *
 * Only a removed call or a changed call source is a history change; a superset
 * of the previous call set (an append, or a re-render of the same history) keeps
 * every binding, so it must not reset the worker. An unreadable surface decides
 * nothing, as before.
 */
export function surfaceRewroteHistory(previous, current) {
  if (previous === undefined || current === undefined) {
    // No comparable snapshot: keep the older, conservative rule.
    return undefined
  }
  for (const seq of previous.seqs) {
    if (!current.seqs.has(seq)) return true
    const before = previous.sources.get(seq)
    const after = current.sources.get(seq)
    if (before !== undefined && after !== undefined && before !== after) return true
  }
  return false
}

/**
 * Wording of the contraction notice.
 *
 * A count of cells tells the model nothing it can act on; the binding names are
 * what it must stop referencing. When no journal names them, the notice
 * describes the contraction without pretending to know which bindings went away.
 */
export function recoveryDiagnosticMessage(bindings, count) {
  const names = [...new Set(bindings ?? [])].filter(name => typeof name === 'string' && name !== '')
  if (names.length === 0) {
    return `Restored the durable head and skipped ${count ?? 1} unreconstructable historical cell(s); their source remains in the session log.`
  }
  return `Restored the durable head and dropped ${names.length} binding(s) (${names.join(', ')}) that no recorded value proves; their source remains in the session log.`
}

/**
 * Notice for a replay whose completions diverged.
 *
 * The bindings exist because the replay produced them; what cannot be certified
 * is the recorded completion payload. Saying so keeps the model from trusting a
 * recorded result while leaving the live bindings in place.
 */
/**
 * Notice for cells restored from their recorded values.
 *
 * A volatile cell cannot be replayed: running it again would redispatch the
 * ambient source that made it volatile. Recovery installs the values it
 * recorded instead, so the bindings are live while the recorded completions
 * were never re-derived.
 */
export function restoredFromRecordDiagnostic(count, live, failed, continuation = false) {
  // The cell count and the binding names describe different things: one cell can
  // install several bindings, and an install can fail. Saying "restored N cells
  // (a, b)" invites the model to read the names as the count and to trust a name
  // that never made it into the worker, so the two facts stay separate and a
  // failed name is never called live.
  const livePart = live.length === 0
    ? 'no binding was live'
    : `${live.length} binding(s) live: ${live.join(', ')}`
  const failedPart = failed.length === 0
    ? ''
    : `; ${failed.length} could not be installed and are NOT live: ${failed.join(', ')}`
  return diagnostic({
    code: 'PTC-R004',
    severity: 'warning',
    phase: 'recover',
    message: `Restored ${continuation ? 'another ' : ''}${count} cell(s) from recorded values; ${livePart}${failedPart}. The recorded completions were not replayed.`,
    stateEffect: 'unchanged',
    help: [
      'continue from the bindings listed as live',
      'do not assume the recorded cells ran again; external effects they performed were not repeated',
    ],
  })
}

/**
 * Notice for a binding that was announced as live and then stopped existing.
 *
 * Reporting it when it happens keeps the model from reading a later
 * `x is not defined` as its own mistake: the binding went away outside the
 * cell that names it.
 */
export function vanishedBindingDiagnostic(names) {
  const list = names.join(', ')
  return diagnostic({
    code: 'PTC-R006',
    severity: 'warning',
    phase: 'recover',
    message: `${names.length} binding(s) reported live earlier are no longer available: ${list}. The REPL state lost them without a cell asking for it.`,
    stateEffect: 'unchanged',
    help: [`redeclare ${list} before using them again`],
  })
}

function unverifiedCompletionDiagnostic(count) {
  return diagnostic({
    code: 'PTC-R003',
    severity: 'warning',
    phase: 'recover',
    message: `Replayed ${count} historical cell(s) whose completion differs from the record; their bindings are live and their recorded results stay unverified.`,
    stateEffect: 'unchanged',
    help: [
      'continue from the restored bindings',
      'do not rely on the recorded result values of the cells named here',
    ],
  })
}

/**
 * Notice for bindings a recorded rewind ended.
 *
 * They are not missing: the record says they are gone, because the cell that
 * restored an earlier durable state abandoned them. Reporting them apart from a
 * genuine loss keeps the two costs distinguishable.
 */
export function rewindEndedDiagnostic(bindings) {
  const names = bindings.length === 0 ? '' : ` (${bindings.join(', ')})`
  return diagnostic({
    code: 'PTC-R005',
    severity: 'warning',
    phase: 'recover',
    message: `Dropped ${bindings.length} binding(s)${names} because a recorded rewind ended them.`,
    stateEffect: 'rolled-back',
    help: [
      'this is not a recovery failure: the cell that restored an earlier durable state ended these bindings on purpose',
    ],
  })
}

function recoveryDiagnostic(bindings, count) {
  return diagnostic({
    code: 'PTC-R002',
    severity: 'warning',
    phase: 'recover',
    message: recoveryDiagnosticMessage(bindings, count),
    stateEffect: 'rolled-back',
    help: [
      'continue from the restored bindings',
      'do not reference values created only in the skipped suffix',
    ],
  })
}

/** Every binding name the folded history no longer proves. */
function droppedBindingNames(history) {
  const names = []
  for (const item of history?.volatileSuffix ?? []) {
    for (const name of item.bindings ?? []) names.push(name)
  }
  return names
}

/**
 * A replayed cell whose completion no longer matches its record.
 *
 * The bindings the replay produced are real; only the recorded completion
 * payload cannot be certified. Contracting here used to drop every later
 * binding the log still proves, so a divergence is recorded and the replay
 * continues instead.
 */
class ReplayDivergence extends Error {}

function resolvedRuntimeConfig(config) {
  return Object.freeze(resolveConfig(config))
}

function emptyHistory() {
  return { nodes: [], head: undefined, checkpoints: new Map(), volatileSuffix: [], available: true }
}

/**
 * How many historical REPL cells a disposed identity leaves behind.
 *
 * A disposed owner's environment is not resumed, so the count only sizes the
 * one notice that tells the model how much history is gone. Prefer the proven
 * executable calls and fall back to one so the notice is never silent.
 */
function disposedHistoryCells(sessionLog, callSeq) {
  try {
    const visible = visibleExecutableCallSeqs(sessionLog)
    if (!(visible instanceof Set)) return 1
    // The submitted cell already appears in the log; it is not history.
    const historical = [...visible].filter(seq => seq !== callSeq)
    return historical.length > 0 ? historical.length : 1
  } catch {
    return 1
  }
}

/**
 * Decide whether the live worker's bindings lost their provenance.
 *
 * Returns true only when the surface was read and proves that a live call is no
 * longer part of it. An unreadable surface is undecidable: a queued message or a
 * mid-flight replacement must not cost the user the REPL, so the decision stays
 * false and the worker keeps its state.
 */
export function contractsLiveBindings({ liveCallSeqs, visibleCallSeqs, surfaceIsReadable }) {
  if (!surfaceIsReadable) return false
  if (!(visibleCallSeqs instanceof Set)) return false
  for (const callSeq of liveCallSeqs) {
    if (!visibleCallSeqs.has(callSeq)) return true
  }
  return false
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
  constructor({ config, history, cwd, session, surfaceProvenanceRequired, userBindingsCwd, withInitiator, observeValues, disposedCells = 0 }) {
    this.config = config
    this.history = history
    this.initialRecoveryBoundary = recoveryBoundaryForHistory(history)
    this.surfaceGeneration = surfaceGeneration(session, surfaceProvenanceRequired)
    // Snapshot of the last readable surface: the call set plus each call's source
    // digest, so a republish that only appends or re-renders is not mistaken for
    // a history change.
    this.visibleSurfaceCalls = undefined
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
    this.unverifiedCompletions = []
    this.restoredFromRecord = []
    this.offPathRestores = 0
    this.recoveryNotice = disposedCells > 0
      // A kernel whose owning agent or session was disposed must not resurrect
      // the disposed environment: the history is gone by contract, and a later
      // cell starts from an empty REPL with the loss reported once.
      ? recoveryDiagnostic([], disposedCells)
      : history.volatileSuffix.length === 0
        ? undefined
        : recoveryDiagnostic(droppedBindingNames(history), history.volatileSuffix.length)
    this.recoveryNoticeShown = false
    // Bindings a recovery told the model were live, and the last help pair that
    // explained a recovery. Both exist to keep one event from being reported
    // twice and to notice a binding that stops existing afterwards.
    this.announcedLive = new Set()
    this.recoveryHelpSignature = undefined
    this.recoveryEventCount = 0
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
      // An unreadable surface is undecidable, not proof of contraction: keep the
      // worker and its bindings instead of dropping them on a transient read.
      const surfaceIsReadable = surfaceReadable(observedSession)
      const visibleCallSeqs = surfaceIsReadable ? visibleExecutableCallSeqs(observedSession) : undefined
      // A republish that only appends or re-renders the same history keeps every
      // binding: only a removed call or a rewritten source is a history change.
      const currentSurface = surfaceIsReadable ? visibleCallSources(observedSession) : undefined
      const rewroteHistory = surfaceRewroteHistory(this.visibleSurfaceCalls, currentSurface)
      if (currentSurface !== undefined) this.visibleSurfaceCalls = currentSurface
      const contractsLiveState = contractsLiveBindings({
        liveCallSeqs: this.liveCallSeqs,
        visibleCallSeqs,
        surfaceIsReadable,
      })
      // Without a comparable snapshot the older, conservative rule decides; with
      // one, a superset (append or re-render) is explicitly not a rebuild reason.
      const historyChanged = rewroteHistory === undefined
        ? contractsLiveState
        : rewroteHistory || contractsLiveState
      if ((config.durableReplay && !this.replayed) || historyChanged) {
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
            this.recoveryNotice = recoveryDiagnostic([], 1)
            this.initialRecoveryBoundary = undefined
          }
          if (this.history.volatileSuffix.length > 0) {
            this.recoveryNotice = recoveryDiagnostic(droppedBindingNames(this.history), this.history.volatileSuffix.length)
          }
          this.initialRecoveryBoundary = recoveryBoundaryForHistory(this.history)
          if (this.initialRecoveryBoundary !== undefined) {
            recoveryBoundaries.push(this.initialRecoveryBoundary)
            this.initialRecoveryBoundary = undefined
          }
        } else {
          this.history = emptyHistory()
          this.replayed = true
          this.recoveryNotice = recoveryDiagnostic([], 1)
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
        const notice = recoveryDiagnostic([], skipped)
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
      // One recovery event produces one notice. The four facts below describe the
      // same event, so they are composed once instead of overwriting each other:
      // an earlier overwrite dropped the restored-name list whenever a later fact
      // arrived, and a repeat entry re-emitted the same sentence.
      const restoredCount = this.restoredFromRecord.length
      const allLive = [...new Set(this.restoredFromRecord.flatMap(item => item.bindings))]
      // Report only what this recovery added. A later recovery that installs
      // nothing new (same bindings, same count) would otherwise repeat a sentence
      // the model already acted on.
      const liveNames = allLive.filter(name => !this.announcedLive.has(name))
      const failedNames = [...new Set(this.restoredFromRecord.flatMap(item => item.failed))]
      const droppedNames = this.missingBindings === undefined ? [] : [...new Set(this.missingBindings)]
      const endedNames = this.rewindEndedBindings === undefined ? [] : [...new Set(this.rewindEndedBindings)]
      const alreadyReported = this.recoveryEventCount > 0
      // A complete restore is invisible to the model. Every recorded binding was
      // installed, nothing was dropped or ended, and the next cell behaves exactly
      // as it would have without the recovery, so a notice would only report plugin
      // mechanics: in the audited session one such line cost two reasoning blocks of
      // source-code investigation and changed no decision. The names stay tracked so
      // that a later disappearance can still be named; only the announcement goes.
      const completeRestore = failedNames.length === 0
        && droppedNames.length === 0
        && endedNames.length === 0
      if (restoredCount > 0 && completeRestore) {
        this.restoredFromRecord = []
      } else if (restoredCount > 0 && liveNames.length === 0 && failedNames.length === 0 && alreadyReported) {
        this.restoredFromRecord = []
      } else if (restoredCount > 0) {
        this.recoveryEventCount += 1
        this.recoveryNotice = restoredFromRecordDiagnostic(
          restoredCount,
          liveNames,
          failedNames,
          alreadyReported,
        )
      }
      if (droppedNames.length > 0) {
        this.recoveryNotice = recoveryDiagnostic(droppedNames, droppedNames.length)
      } else if (restoredCount === 0 && skipped > 0) {
        this.recoveryNotice = recoveryDiagnostic([], skipped)
      }
      // A rewind that ended a binding is recorded, not a loss: report it only when
      // the replay installed nothing under that name anywhere (path, off-path or
      // catalog), so a correct value never carries a "dropped" notice.
      if (this.recoveryNotice === undefined && endedNames.length > 0) {
        this.recoveryNotice = rewindEndedDiagnostic(endedNames)
      }
      if (this.recoveryNotice === undefined && this.unverifiedCompletions.length > 0) {
        this.recoveryNotice = unverifiedCompletionDiagnostic(this.unverifiedCompletions.length)
      }
      // A completion the replay could not certify is not a lost binding: the
      // replay established them, and only the recorded payload stays unproved.
      if (this.recoveryNotice !== undefined) {
        // Remember what was promised as live, so a binding that disappears later
        // is reported by name instead of surfacing as an unexplained ReferenceError.
        for (const name of liveNames) this.announcedLive.add(name)
        // The help pair explains the recovery once. Repeating it on every later
        // recovery in the same session is noise the model cannot act on twice.
        const signature = this.recoveryNotice.message
        if (this.recoveryHelpSignature === signature) this.recoveryNotice = { ...this.recoveryNotice, help: [] }
        else this.recoveryHelpSignature = signature
      }
      this.restoredFromRecord = []
      this.missingBindings = undefined
      this.rewindEndedBindings = undefined
    }
    const leadingDiagnostics = [
      ...(this.recoveryNotice === undefined || this.recoveryNoticeShown ? [] : [this.recoveryNotice]),
    ]
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
      // A binding announced as live by a recovery, now reported missing by the
      // engine itself, went away outside this cell. Naming it here keeps the
      // model from reading its own correct reference as a mistake it made.
      const vanished = this.vanishedAnnouncedBindings(result.error, request.program)
      if (vanished.length > 0) {
        result.logs = [...result.logs, renderDiagnostic(vanished[0], request.program)]
        if (request.journal !== undefined) request.journal.diagnostics.push(...vanished)
      }
    }
    if (leadingDiagnostics.length > 0) {
      const rendered = leadingDiagnostics.map(item => renderDiagnostic(item, request.program))
      if (result.error === undefined) result.logs = [...rendered, ...result.logs]
      else result.error = { ...result.error, message: [result.error.message, ...rendered].join('\n') }
    }
    return finishResult(result)
  }

  /**
   * Bindings a recovery promised as live that the engine now reports missing.
   *
   * Each name is reported once: the set is drained when it is named, so a later
   * cell repeating the same reference does not repeat the notice.
   */
  vanishedAnnouncedBindings(error, program) {
    if (this.announcedLive.size === 0) return []
    const message = String(error?.message ?? '')
    const match = /(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined/.exec(message)
    if (match === null) return []
    const name = match[1]
    if (!this.announcedLive.has(name)) return []
    this.announcedLive.delete(name)
    void program
    return [vanishedBindingDiagnostic([name])]
  }

  async replayHistory(request, config) {
    this.bindingCatalog = new BindingCatalog()
    const limits = this.valueLimits(config)
    const emptyArgsWire = encodeValueAtBoundary({}, limits, 'parameter')
    const path = pathToHead(this.history)
    // Every binding the session log proves has to come back or be named. A node
    // that is not on the path to the head never replays, so its bindings would
    // otherwise disappear without a diagnostic.
    const replayedNames = new Set()
    for (const node of path) {
      for (const value of node.journal.values ?? []) replayedNames.add(value.name)
      for (const name of bindingNamesOfOperations(node.journal.operations)) replayedNames.add(name)
    }
    // A recorded rewind ended these bindings on purpose: they are gone by record,
    // not by omission, so they are reported apart from the ones recovery failed to
    // install. Nothing else may report them as missing.
    const endedBindings = new Set(this.history.deletedBindings ?? [])
    // A node off the path to the head never replays, so its bindings would vanish.
    // Its recorded values are the only evidence they existed, and installing them is
    // not a replay: no cell code runs, so no ambient effect is redispatched. Install
    // them before the path replay so a later cell on the path still wins, and skip
    // anything a recorded rewind ended.
    const pathNodes = new Set(path)
    for (const node of this.history.nodes ?? []) {
      if (pathNodes.has(node)) continue
      const values = (node.journal.values ?? []).filter(value => !endedBindings.has(value.name))
      if (values.length === 0) continue
      const bindings = replayBindingNamespaces(request.bindings, node.journal, limits, emptyArgsWire)
      const bindingDescriptors = bindings === request.bindings
        ? request.bindingDescriptors : normalizeBindingDescriptors(bindings)
      const installed = await this.cellExecutor.executeCell(
        {
          ...request,
          bindings: bindingDescriptors.namespaces,
          bindingDescriptors,
          program: node.code,
          journal: undefined,
          restoreValues: values,
          ...(node.userBindings === undefined ? { userBindings: undefined } : { userBindings: node.userBindings }),
        },
        node.journal,
        config,
      )
      if (installed.error !== undefined) continue
      // Off-path restoration is a repair of evidence the head chain cannot reach, not
      // a replay of the session: it stays silent. The cells the path did replay own
      // the notice, and anything this repair could not install is still named by the
      // contraction diagnostic.
      this.offPathRestores += 1
      for (const value of values) replayedNames.add(value.name)
    }
    for (const node of path) {
      const bindings = replayBindingNamespaces(request.bindings, node.journal, limits, emptyArgsWire)
      const bindingDescriptors = bindings === request.bindings
        ? request.bindingDescriptors : normalizeBindingDescriptors(bindings)
      // A cell the journal recorded as volatile keeps the values it produced.
      // Installing them is the only replay that does not redispatch the ambient
      // source that made the cell volatile, so its completion stays unverified
      // while its bindings stay live.
      if (node.restoredFromRecord === true) {
        const restored = await this.cellExecutor.executeCell(
          {
            ...request,
            bindings: bindingDescriptors.namespaces,
            bindingDescriptors,
            program: node.code,
            journal: undefined,
            restoreValues: node.journal.values,
            ...(node.userBindings === undefined ? { userBindings: undefined } : { userBindings: node.userBindings }),
          },
          node.journal,
          config,
        )
        if (restored.error !== undefined) throw new ReplayFailure(node, new Error(restored.error.message))
        this.restoredFromRecord.push({ callSeq: node.callSeq,
          bindings: restored.restored ?? [], failed: restored.failed ?? [] })
        continue
      }
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
          throw new ReplayDivergence(`recorded cell returned a value and the replay failed: ${result.error.message}`)
        }
        if (completion.kind === 'throw') {
          if (result.error === undefined) throw new Error('cell replay succeeded where the recorded cell failed')
          if (result.error.kind !== completion.error.kind || result.error.message !== completion.error.message) {
            throw new ReplayDivergence('cell replay produced a different semantic failure')
          }
        }
      } catch (error) {
        // A blocked admission is not a fact about this recorded cell, so it is
        // rethrown unchanged and never wrapped as a replay failure.
        if (error instanceof ReplayCancelled || error instanceof ReplayUnmeasured
          || error instanceof CellAdmissionBlocked) throw error
        // The replay produced real bindings and a different completion. Contracting
        // here dropped every later binding the log still proves, which is how a
        // diverging completion cost the user the whole REPL; certify the divergence
        // and keep replaying from the bindings the replay established.
        if (error instanceof ReplayDivergence) {
          this.unverifiedCompletions.push({ callSeq: node.callSeq, reason: error.message })
          continue
        }
        throw new ReplayFailure(node, error)
      }
    }
    for (const node of path) this.liveCallSeqs.add(node.callSeq)
    // Names the replay installed include the ones the binding catalog supplies: a
    // binding can come back through the catalog without any cell executing, so the
    // arithmetic below counts that evidence too. Without it a rewound branch whose
    // binding returned through the catalog was reported as ended while its value was
    // correct.
    const installed = new Set(replayedNames)
    for (const name of this.bindingCatalog.inputs().knownBindings) installed.add(name)
    this.rewindEndedBindings = [...endedBindings].filter(name => !installed.has(name))
    this.missingBindings = (this.history.provenBindings ?? [])
      .filter(name => !installed.has(name) && !endedBindings.has(name))
  }

  completeJournal(journal, status, result, volatileReason, diagnostics = [], completion = undefined, values = undefined) {
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
    // A volatile cell keeps the values it produced so recovery can install them
    // without running the cell again; a value the codec could not transfer is
    // named instead of being omitted silently.
    if (values !== undefined && (values.values.length > 0 || values.unrecorded.length > 0)) {
      journal.values = values.values
      if (values.unrecorded.length > 0) journal.unrecordedBindings = values.unrecorded
    }
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
          active.bindingValues,
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
    // Identities whose owning agent or session was disposed. Their environment is
    // gone by contract, so a later cell in the same identity must start empty
    // instead of replaying bindings the disposed owner once held.
    this.disposedSessions = new Set()
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
      // A disposed agent or session loses its live environment by contract: the
      // next cell in that identity starts empty and is told how many historical
      // cells the disposed environment held. Replaying them would hand the
      // disposed owner's bindings to whoever runs next in the same identity.
      const disposedCells = this.disposedSessions.has(sessionId)
        ? disposedHistoryCells(sessionLog, callSeq)
        : 0
      let history
      try {
        history = disposedCells > 0 || !cellConfig.durableReplay
          ? emptyHistory()
          : recoverJournal(sessionLog, callSeq, {
            visibleCallSeqs: visibleExecutableCallSeqs(sessionLog),
          })
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
        disposedCells,
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
    // Recorded before the early return: an identity whose owner was disposed has
    // no environment to resume, whether or not a kernel still existed here.
    this.disposedSessions.add(id)
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
