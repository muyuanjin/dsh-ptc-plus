import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { helperProcessEnvironment, isElectronHost } from './worker-environment.js'

/**
 * Fallback bound for a helper that answers the stop request and then keeps the
 * process alive with unrelated work of its own.
 */
const ISOLATED_RELEASE_MS = 1000
/** Absolute bound after which an unresponsive helper is killed. */
const ISOLATED_STOP_MS = 5000
/** Bound on the helper's output pipes really ending after its process exited. */
const ISOLATED_OUTPUT_MS = 5000

/**
 * A worker-shaped transport whose worker lives in a killable helper process.
 *
 * Callers keep the worker_threads surface they already use: message, error and
 * exit events, stdout/stderr platform pipes, postMessage to the worker's parent
 * port, and terminate. The private kernel channel is exposed as the ready
 * handshake's port adapter. Killing this transport targets the helper process,
 * so a kernel that never answers is reclaimed without ending the host.
 */
export class IsolatedWorker extends EventEmitter {
  constructor({ helper, entry, workerData, resourceLimits, env, protocol = 'kernel' }) {
    super()
    // The entry follows the worker constructor's contract: a URL or a string
    // filename. Anything else fails here, before a helper process exists.
    if (!(entry instanceof URL) && (typeof entry !== 'string' || entry.length === 0)) {
      throw new TypeError('isolated worker entry must be a URL or a non-empty string filename')
    }
    // The init message crosses advanced IPC, which cannot rebuild a URL object, so
    // the boundary normalizes it to one absolute file URL string. A path follows
    // the worker constructor's rule: resolved from the current working directory.
    const entrySpec = entry instanceof URL
      ? entry.href
      : entry.slice(0, 5).toLowerCase() === 'file:'
        ? new URL(entry).href
        : pathToFileURL(resolve(entry)).href
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.protocol = protocol
    this.exited = false
    this.exitedPromise = new Promise(resolve => { this.resolveExited = resolve })
    this.exitCode = undefined
    this.exitSignal = undefined
    this.released = false
    this.stop = undefined
    this.reclamationFailure = undefined
    this.kernel = new EventEmitter()
    this.utilization = { idle: 0, active: 0 }
    this.utilizationSequence = 0
    this.utilizationRequests = new Map()
    this.pendingErrors = []
    this.performance = {
      /** Utilization reported by the helper, in the shape callers already use. */
      eventLoopUtilization: (first) => {
        const current = this.utilization
        if (first === undefined) return { ...current }
        return { idle: current.idle - first.idle, active: current.active - first.active }
      },
    }
    // child_process.fork mutates the env object it receives by copying
    // NODE_V8_COVERAGE into it. Snapshot the caller's projection first so the
    // inner Worker receives exactly the projected user environment. An Electron
    // Host also needs a helper-only startup override; it must not reach user code.
    const electronHost = isElectronHost()
    const projectedEnvironment = env === undefined && electronHost ? process.env : env
    const workerEnvironment = projectedEnvironment === undefined ? undefined : { ...projectedEnvironment }
    const forkEnvironment = helperProcessEnvironment(projectedEnvironment, process.platform, electronHost)
    this.child = fork(helper, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: forkEnvironment,
      serialization: 'advanced',
      // The helper starts with the host's own startup arguments removed, matching
      // the isolation the in-host worker had with execArgv: [].
      execArgv: [],
    })
    this.child.stdout.pipe(this.stdout)
    this.child.stderr.pipe(this.stderr)
    this.child.on('exit', (code, signal) => {
      this.exited = true
      this.exitCode = code
      this.exitSignal = signal
      this.resolveExited()
      this.#rejectUtilizationRequests(new Error('kernel helper exited before answering utilization sampling'))
    })
    // A ChildProcess 'close' follows 'exit' once its stdio has really ended, which
    // is the only fact that proves the pipes are drained.
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
    this.child.on('close', () => {
      this.ioClosed = true
      this.resolveClosed()
      this.stdout.end()
      this.stderr.end()
      for (const error of this.pendingErrors) this.emit('error', error)
      this.pendingErrors.length = 0
      // Consumers publish process failures from exit. Delay that worker-shaped
      // event until close proves every platform output pipe has drained, while
      // retaining the real child exit fact above for stop deadlines.
      if (this.exited) this.emit('exit', this.exitCode, this.exitSignal)
      this.emit('close')
    })
    this.child.on('error', error => {
      this.#rejectUtilizationRequests(error)
      this.pendingErrors.push(error)
      this.emit('fault', error)
    })
    // A helper that loses its IPC channel while still running is an instance the
    // owner must reclaim, so the disconnect is forwarded as its own fact.
    this.child.on('disconnect', () => {
      // A helper that already exited disconnects as part of its normal end; that is
      // its exit fact, not a transport failure.
      if (!this.exited) {
        this.#rejectUtilizationRequests(new Error('kernel helper disconnected before answering utilization sampling'))
        this.emit('disconnect')
      }
    })
    this.child.on('message', message => {
      if (message?.type === 'child-error') {
        const error = new Error(message.message)
        if (message.name !== undefined) error.name = message.name
        if (message.code !== undefined) error.code = message.code
        if (message.stack !== undefined) error.stack = message.stack
        this.#rejectUtilizationRequests(error)
        this.pendingErrors.push(error)
        // The owner needs the control failure now so it can reclaim a helper
        // that remains alive. Consumers receive error only after child close,
        // once the platform output pipes have drained.
        this.emit('fault', error)
        return
      }
      if (message?.type === 'inner-worker-exit') { this.emit('inner-worker-exit', message.code); return }
      if (message?.type === 'utilization-sample') {
        const pending = this.utilizationRequests.get(message.id)
        if (pending !== undefined) {
          this.utilizationRequests.delete(message.id)
          clearTimeout(pending.timer)
          this.utilization = message.utilization
          pending.resolve(message.utilization)
        }
        return
      }
      if (message?.type === 'child-utilization') { this.utilization = message.utilization; return }
      if (message?.type === 'child-limits') { this.resourceLimits = message.limits; return }
      if (message?.type === 'ready') {
        this.ready = true
        // The helper samples the inner worker when it becomes ready. Adopt that
        // fresh baseline so a later compute-budget delta never counts startup
        // work that already happened before the worker was ready.
        if (message.utilization !== undefined) this.utilization = message.utilization
        // Only the private-channel protocol carries a port to the caller; a
        // parent-port caller must never see the transport handshake as its first
        // own result message.
        if (this.protocol === 'kernel') this.emit('message', { type: 'ready', port: this.#portAdapter() })
        return
      }
      if (message?.type === 'worker-message') {
        // The stop acknowledgement belongs to this transport, not to the caller's
        // own protocol, which only sees its own request/result messages.
        if (message.value?.type === 'shutdown-released') { this.released = true; return }
        this.emit('message', message.value)
        return
      }
      if (message?.type === 'kernel-message') {
        if (message.utilization !== undefined) this.utilization = message.utilization
        this.kernel.emit('message', message.value)
      }
    })
    try {
      this.child.send({ type: 'init', entry: entrySpec, workerData, resourceLimits, protocol, env: workerEnvironment })
    } catch (error) {
      // The forked helper already exists here, so the failure carries its handle:
      // the owner has to reclaim that child instead of treating it as never started.
      // Keep the transport itself: it owns the child handle, the exit listeners
      // and terminate(), so the owner can reclaim this instance through the same
      // close path instead of a parallel raw-child implementation.
      error.transport = this
      error.child = this.child
      throw error
    }
  }

  /** Port-shaped adapter over this process's IPC channel to the helper. */
  #portAdapter() {
    return {
      postMessage: value => {
        if (this.exited || this.child.connected === false) return
        this.child.send({ type: 'kernel-message', value })
      },
      on: (event, handler) => { if (event === 'message') this.kernel.on('message', handler) },
      once: (event, handler) => { if (event === 'message') this.kernel.once('message', handler) },
      off: (event, handler) => { if (event === 'message') this.kernel.off('message', handler) },
      close: () => {},
    }
  }

  /** Send one message to the kernel worker's own parent port. */
  postMessage(value) {
    if (this.exited || this.child.connected === false) return
    this.child.send({ type: 'worker-message', value })
  }

  /**
   * Read the inner worker's current event-loop utilization from the helper.
   *
   * Periodic helper samples are not a request-start baseline: user callbacks
   * can finish after the last sample and before the next cell is submitted.
   * The helper answers this request from its own loop without waiting for the
   * inner worker, so the returned sample includes work that has already run.
   *
   * @returns {Promise<{idle: number, active: number}>} Current utilization.
   *   Rejects when the helper cannot answer before its bounded deadline.
   */
  sampleUtilization() {
    if (this.exited || this.child.connected === false) {
      return Promise.reject(new Error('kernel helper is not available for utilization sampling'))
    }
    const id = ++this.utilizationSequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.utilizationRequests.delete(id)
        reject(new Error('kernel helper did not answer utilization sampling before its deadline'))
      }, ISOLATED_RELEASE_MS)
      this.utilizationRequests.set(id, { resolve, reject, timer })
      try {
        this.child.send({ type: 'sample-utilization', id })
      } catch (error) {
        clearTimeout(timer)
        this.utilizationRequests.delete(id)
        reject(error)
      }
    })
  }

  /** Fail every request that still needs the helper's utilization answer. */
  #rejectUtilizationRequests(error) {
    for (const pending of this.utilizationRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.utilizationRequests.clear()
  }

  /**
   * Stop the kernel worker and wait for the helper process to exit.
   *
   * An answering helper gets the release bound to leave on its own; a helper
   * that keeps running anyway, or that never answers, is killed at the absolute
   * bound. Only the real child exit is reported, and a kill that the platform
   * refuses stays observable as a rejected stop.
   *
   * @returns {Promise<void>} Resolves after the helper process exited.
   */
  terminate() {
    // One close per transport: concurrent callers share the same outcome, so a
    // failure is reported to every caller instead of leaving one of them pending.
    this.stop ??= this.#stop()
    return this.stop
  }

  async #stop() {
    if (this.exited) return
    // Both cutoffs are anchored at the moment the close starts: an acknowledgement
    // never postpones the kill, and a kill still leaves a positive bounded window
    // for the helper's real exit to arrive.
    const started = Date.now()
    const killAt = started + ISOLATED_RELEASE_MS
    const confirmBy = started + ISOLATED_STOP_MS
    const exited = this.exitedPromise
    const onReleased = message => {
      if (message?.type === 'worker-message' && message.value?.type === 'shutdown-released') this.released = true
    }
    this.child.on('message', onReleased)
    try {
      // A channel that refuses the stop request must not skip the kill and exit
      // confirmation: the helper is still this instance's responsibility.
      try {
        if (this.child.connected !== false) this.child.send({ type: 'worker-message', value: { type: 'shutdown' } })
      } catch {
        // The channel is closed; the kill path below owns the instance.
      }
      if (!await leftWithin(this, remaining(killAt))) {
        let killFailure
        if (!this.exited) {
          try {
            await this.kill()
          } catch (error) {
            // On Windows a process that has already left can report a refused
            // kill before Node delivers its exit event. The real exit observation
            // decides whether this instance was reclaimed.
            killFailure = error
          }
        }
        if (!this.exited && !await leftWithin(this, remaining(confirmBy))) {
          const failure = killFailure ?? new Error('kernel helper did not exit before the close deadline')
          this.reclamationFailure = failure
          throw failure
        }
      }
      await exited
    } finally {
      this.child.off('message', onReleased)
    }
  }

  /** Kill the helper process; a refused kill stays a visible failure. */
  async kill() {
    const killed = this.child.kill()
    if (killed === false && !this.exited) throw new Error('kernel helper could not be killed')
  }
}

/**
 * Own every plugin transport instance until its real exit and cleanup.
 *
 * Instances are registered before they start, so a fork failure, a control
 * error, a close refusal and a late real exit all keep their responsibility
 * here instead of disappearing behind a swallowed rejection.
 */
export class IsolatedOwner {
  /**
   * @param {object} [options] - Transport factory, injectable for tests.
   * @param {(options: object) => object} [options.create] - Builds one transport.
   */
  constructor({ create = options => new IsolatedWorker(options) } = {}) {
    this.create = create
    this.instances = new Map()
    this.nextId = 0
    this.disposal = undefined
    this.disposed = false
  }

  /** Register one instance before it starts and observe its lifecycle facts. */
  start(options) {
    if (this.disposed) throw new Error('isolated owner is disposing')
    const id = String(++this.nextId)
    const record = { id, state: 'starting', failure: undefined, stopping: undefined, transport: undefined, exitObserved: false, neverStarted: false, cleanup: options.cleanup }
    this.instances.set(id, record)
    let transport
    try {
      transport = this.create(options)
    } catch (error) {
      record.failure = error
      if (error?.transport !== undefined) {
        // The helper process exists even though startup threw, and the transport
        // that owns it is adopted so the close path can still reclaim it.
        record.transport = error.transport
        record.state = 'failed'
        error.transport.on('error', transportError => this.#onInstanceError(record, transportError))
        error.transport.on('fault', transportError => this.#onInstanceError(record, transportError))
        error.transport.once('exit', () => this.#onExit(record))
        error.transport.once('disconnect', () => this.#onInstanceError(record, new Error('helper disconnected')))
        error.transport.once('close', () => { void this.#settle(record) })
        // A startup that threw after the fork already owns a live helper, so the
        // owner reclaims it now instead of waiting for an external dispose.
        void this.stop(record.id).catch(() => {})
      } else {
        // No child was created: this instance's own terminal fact, released after
        // its cleanup, without inventing an exit.
        record.neverStarted = true
        record.state = 'never-started'
        this.#settle(record)
      }
      throw error
    }
    record.transport = transport
    record.state = 'running'
    // Persistent, so a second error event can never become an uncaught exception
    // once the first listener was consumed.
    transport.on('error', error => this.#onInstanceError(record, error))
    transport.on('fault', error => this.#onInstanceError(record, error))
    transport.once('exit', () => this.#onExit(record))
    transport.once('disconnect', () => this.#onInstanceError(record, new Error('helper disconnected')))
    // The real stream close is a terminal fact of its own: an instance retained
    // because its output had not drained yet must be released when it does.
    transport.once('close', () => { void this.#settle(record) })
    return { id, transport, record }
  }

  #onInstanceError(record, error) {
    // Once the instance really exited, a later transport error cannot replace that
    // fact; the exit observation owns the release.
    if (record.exitObserved === true || record.transport?.exited === true) return
    record.failure ??= error
    record.state = 'failed'
    // A control error still leaves an instance to reclaim, so the owner takes over
    // its close instead of waiting for an external dispose.
    void this.stop(record.id).catch(() => {})
  }

  #onExit(record) {
    record.exitObserved = true
    void this.#settle(record)
  }

  #settle(record) {
    // Release needs this instance's own terminal fact (a real exit, or the
    // never-started outcome) and this instance's own cleanup to succeed.
    if (record.neverStarted !== true && record.exitObserved !== true) return
    if (record.settling !== undefined) return record.settling
    // Queue user cleanup so the shared attempt is installed before cleanup can
    // synchronously finish or throw and clear the marker for a later retry.
    const settling = Promise.resolve().then(async () => {
      if (record.neverStarted !== true && record.transport !== undefined) {
        const closed = await outputClosed(record.transport, ISOLATED_OUTPUT_MS)
        if (!closed) {
          // Output never drained: keep the instance and say so instead of
          // pretending the pipes ended naturally.
          record.failure = new Error('helper output did not end before the release deadline')
          record.state = 'output-pending'
          // A retained failure must not latch the attempt: a later real terminal
          // fact (or a later disposal) has to try again and stay visible.
          record.settling = undefined
          return
        }
      }
      try {
        if (typeof record.cleanup === 'function') await record.cleanup()
      } catch (error) {
        // Cleanup failure keeps the instance and its responsibility visible.
        record.failure = error
        record.state = 'cleanup-failed'
        record.settling = undefined
        return
      }
      record.state = 'reclaimed'
      this.instances.delete(record.id)
    })
    record.settling = settling
    return settling
  }

  /** Stop one instance; concurrent calls share an in-flight attempt. */
  stop(id) {
    const record = this.instances.get(id)
    if (record === undefined) return Promise.resolve()
    if (record.stopping !== undefined) return record.stopping
    const operation = this.#stop(record)
    record.stopping = operation
    // A retained cleanup failure or pending output must not latch stop: after
    // the operation settles, a later call has to retry #settle. Concurrent
    // callers still share the in-flight promise above.
    operation.then(
      () => { if (record.stopping === operation) record.stopping = undefined },
      () => { if (record.stopping === operation) record.stopping = undefined },
    )
    return operation
  }

  async #stop(record) {
    if (record.neverStarted === true || record.transport === undefined) {
      await this.#settle(record)
      return
    }
    if (record.transport.exited === true) record.exitObserved = true
    // A retained cleanup/output attempt already owns the transport's exit. Do
    // not terminate it again; just retry its cleanup/output settlement.
    if (record.state === 'cleanup-failed'
      || record.state === 'output-pending'
      || record.transport.exited === true) {
      await this.#settle(record)
      return
    }
    record.state = 'closing'
    try {
      await record.transport.terminate()
    } catch (error) {
      // The instance stays registered: a refusal is visible again on the next
      // stop or dispose, and a late real exit still releases it.
      record.failure = error
      record.state = 'unreclaimed'
      throw error
    }
    if (record.transport.exited === true) record.exitObserved = true
    // Await the instance's own cleanup so stop() never reports done before its
    // cleanup outcome (success or retained failure) is known.
    await this.#settle(record)
  }

  /**
   * Stop every owned instance but keep the owner usable for later starts.
   *
   * Reconfiguration releases the current instances without ending the owner's
   * life, while dispose() stays the terminal operation that refuses new starts.
   *
   * @returns {Promise<Error[]>} Every instance that could not be reclaimed.
   */
  async releaseAll() {
    return this.#releaseOwned()
  }

  /** Stop every owned instance and report each one that could not be reclaimed. */
  dispose() {
    this.disposed = true
    if (this.disposal !== undefined) return this.disposal
    const operation = this.#dispose()
    this.disposal = operation
    // Keep concurrent dispose calls on one operation, but let a later call
    // retry instances retained by cleanup-failed or output-pending states.
    operation.then(
      () => { if (this.disposal === operation) this.disposal = undefined },
      () => { if (this.disposal === operation) this.disposal = undefined },
    )
    return operation
  }

  async #dispose() {
    return this.#releaseOwned()
  }

  async #releaseOwned() {
    const selected = [...this.instances.keys()].map((id) => {
      const record = this.instances.get(id)
      return { record, operation: this.stop(id) }
    })
    const results = await Promise.allSettled(selected.map(instance => instance.operation))
    const failures = []
    for (const [index, selectedInstance] of selected.entries()) {
      const result = results[index]
      if (result.status === 'rejected') failures.push(result.reason)
      const { record } = selectedInstance
      // Only #settle releases an instance; a retained cleanup failure is reported
      // here once, without a second release decision.
      if ((record?.state === 'cleanup-failed' || record?.state === 'output-pending') && record.failure !== undefined) {
        failures.push(record.failure)
      }
    }
    return failures
  }
}

function outputClosed(transport, ms) {
  if (transport.ioClosed === true) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => { resolve(false) }, ms)
    Promise.resolve(transport.closed).then(() => { clearTimeout(timer); resolve(true) }, () => { clearTimeout(timer); resolve(false) })
  })
}

function remaining(deadline) {
  return Math.max(0, deadline - Date.now())
}

function leftWithin(worker, ms) {
  if (worker.exited) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => { worker.child.off('exit', onExit); resolve(false) }, ms)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    worker.child.once('exit', onExit)
  })
}
