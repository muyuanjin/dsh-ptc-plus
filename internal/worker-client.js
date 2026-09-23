import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { messageOf, processExitDescription } from './failure-reporting.js'
import { IsolatedOwner } from './isolated-worker.js'
import { normalizeWorkerEnvironment } from './worker-environment.js'
import { WorkerOutputCapture } from './worker-output-capture.js'
import { stripOutputFenceMarkers } from './worker-output-fence.js'

export { normalizeWorkerEnvironment }

const KERNEL_HELPER = new URL('./kernel-child.js', import.meta.url)

/** Owns one session kernel's worker process, private port, and scratch directory. */
export class WorkerClient {
  constructor({ workerUrl, cwd, onMessage, onFailure, onUnmatchedOutputFailure, compilerCache }) {
    this.workerUrl = workerUrl
    this.cwd = cwd
    this.onMessage = onMessage
    this.onFailure = onFailure
    this.onUnmatchedOutputFailure = onUnmatchedOutputFailure ?? (() => false)
    this.compilerCache = compilerCache
    this.worker = undefined
    this.workerLimit = undefined
    this.workerReady = undefined
    this.port = undefined
    this.outputCapture = undefined
    this.outputCompletionPending = undefined
    this.deferredOutputMessages = []
    this.pendingOutputFailure = undefined
    this.scratchReady = undefined
    this.stderrTails = new WeakMap()
    // One owner keeps every started kernel transport, including startup failures
    // and closes that were refused, until its real exit is observed.
    this.owner = new IsolatedOwner()
    this.hostIds = new WeakMap()
    this.disposed = false
  }

  /** Last non-empty stderr line of a failed worker, capped for diagnostics. */
  stderrDetail(worker) {
    const tail = stripOutputFenceMarkers(this.stderrTails.get(worker)?.join('')).trim()
    if (tail === undefined || tail.length === 0) return undefined
    const lastLine = tail.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).slice(-1)[0]
    return lastLine === undefined ? undefined : lastLine.slice(0, 300)
  }

  async ensure(maxOldGenerationSizeMb) {
    if (this.pendingOutputFailure !== undefined) {
      const message = this.pendingOutputFailure
      this.pendingOutputFailure = undefined
      throw new Error(`worker output attribution failed: ${message}`)
    }
    if (this.workerLimit !== undefined && this.workerLimit !== maxOldGenerationSizeMb) {
      throw new Error('ptc-plus: session worker memory limit differs from the submitted cell configuration')
    }
    if (this.worker !== undefined) return this.workerReady
    if (this.scratchReady === undefined) {
      const scratchRoot = tmpdir()
      if (!isAbsolute(scratchRoot)) {
        throw new Error(`ptc-plus: host temporary directory must be absolute, got ${JSON.stringify(scratchRoot)}`)
      }
      this.scratchReady = mkdtemp(join(scratchRoot, 'dsh-ptc-plus-'))
    }
    this.workerLimit = maxOldGenerationSizeMb
    let scratchDirectory
    try {
      scratchDirectory = await this.scratchReady
    } catch (error) {
      if (this.worker === undefined) this.workerLimit = undefined
      throw error
    }
    /* c8 ignore next */
    if (this.disposed) {
      this.workerLimit = undefined
      throw new Error('session kernel disposed')
    }
    /* c8 ignore next */
    if (this.worker !== undefined) return this.workerReady
    const environment = normalizeWorkerEnvironment(process.env)
    let worker
    try {
      const started = this.owner.start({
        helper: KERNEL_HELPER,
        entry: this.workerUrl,
        workerData: { cwd: this.cwd, compilerCache: this.compilerCache?.() },
        resourceLimits: { maxOldGenerationSizeMb: this.workerLimit },
        env: {
          ...environment,
          TEMP: scratchDirectory,
          TMP: scratchDirectory,
          TMPDIR: scratchDirectory,
        },
      })
      worker = started.transport
      this.hostIds.set(worker, started.id)
    } catch (error) {
      this.workerLimit = undefined
      throw error
    }
    const outputCapture = new WorkerOutputCapture()
    this.outputCapture = outputCapture
    const stderrTail = []
    worker.stdout.on?.('data', chunk => {
      this.handleCapturedOutput(worker, outputCapture.push('stdout', chunk))
    })
    worker.stderr.on?.('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      stderrTail.push(text)
      const bounded = Buffer.from(stderrTail.join('')).subarray(-2048).toString('utf8')
      stderrTail.splice(0, stderrTail.length, bounded)
      this.handleCapturedOutput(worker, outputCapture.push('stderr', chunk))
    })
    worker.stdout.resume()
    worker.stderr.resume()
    this.stderrTails.set(worker, stderrTail)
    worker.on('error', error => this.fail(worker, `worker error: ${messageOf(error)}`))
    worker.on('exit', (code, signal) => {
      this.fail(worker, `worker exited with ${processExitDescription(code, signal)}`)
    })
    this.worker = worker
    this.workerReady = new Promise((resolve, reject) => {
      const onError = error => {
        const detail = this.stderrDetail(worker)
        reject(detail === undefined
          ? error
          : new Error(`${messageOf(error)}; last stderr: ${detail}`, { cause: error }))
      }
      const onExit = (code, signal) => {
        const detail = this.stderrDetail(worker)
        const exit = processExitDescription(code, signal)
        reject(new Error(detail === undefined
          ? `worker exited with ${exit} before opening its private channel`
          : `worker exited with ${exit} before opening its private channel; last stderr: ${detail}`))
      }
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.once('message', (message) => {
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
        if (message?.type === 'startup-error' && typeof message.error === 'string') {
          reject(new Error(message.error))
          // The owner keeps a refused reclamation, so this must not surface as an
          // unhandled rejection after the caller already handled the startup error.
          void this.reset(worker).catch(() => {})
          return
        }
        if (message?.type !== 'ready' || typeof message.port?.postMessage !== 'function') {
          reject(new Error('kernel worker returned an invalid private channel'))
          // The owner keeps a refused reclamation, so this must not surface as an
          // unhandled rejection after the caller already handled the startup error.
          void this.reset(worker).catch(() => {})
          return
        }
        this.port = message.port
        this.port.on('message', value => this.handleWorkerMessage(worker, outputCapture, value))
        resolve(worker)
      })
    })
    return this.workerReady
  }

  post(message) {
    if (message?.type !== 'run') {
      this.port.postMessage(message)
      return
    }
    const outputFence = randomBytes(24).toString('hex')
    const failure = this.outputCapture?.begin(message.id, message.maxOutputBytes, outputFence)
    if (failure !== undefined) {
      this.handleCapturedOutput(this.worker, failure)
      return
    }
    this.port.postMessage({ ...message, outputFence })
  }

  /** Best-effort reply for a request whose lease may outlive a worker reset. */
  postIfAlive(message) {
    this.port?.postMessage(message)
  }

  handleWorkerMessage(worker, outputCapture, value) {
    if (worker !== this.worker) return
    const outputProtocol = value?.type === 'output-start'
      || value?.type === 'late-output'
      || value?.type === 'done'
    if (this.outputCompletionPending !== undefined && !outputProtocol) {
      this.deferredOutputMessages.push(value)
      return
    }
    const captured = value?.type === 'output-start'
      ? outputCapture.start(value)
      : value?.type === 'late-output'
        ? outputCapture.lateOutput()
        : value?.type === 'done'
          ? outputCapture.complete(value)
          : value
    if (value?.type === 'done' && captured === undefined) {
      this.outputCompletionPending = value.id
      return
    }
    this.handleCapturedOutput(worker, captured)
  }

  handleCapturedOutput(worker, message) {
    if (message === undefined || worker !== this.worker) return
    if (message.type === 'worker-output-started') {
      this.port?.postMessage({
        type: 'output-start-ack',
        id: message.id,
        outputFence: message.outputFence,
      })
      return
    }
    const releasesDeferred = message.type === 'done' && message.id === this.outputCompletionPending
    const discardsDeferred = message.id === this.outputCompletionPending
      && (message.type === 'worker-output-error' || message.type === 'output-limit')
    if (releasesDeferred || discardsDeferred) this.outputCompletionPending = undefined
    const consumed = this.onMessage(message) === true
    if (message.type === 'worker-output-error' && worker === this.worker) {
      const failureConsumed = consumed || this.onUnmatchedOutputFailure(
        `worker output attribution failed: ${message.message}`,
      ) === true
      if (!failureConsumed) this.pendingOutputFailure = message.message
      void this.reset(worker).catch(error => this.onFailure(`worker output reset failed: ${messageOf(error)}`))
      return
    }
    if (releasesDeferred) {
      const deferred = this.deferredOutputMessages
      this.deferredOutputMessages = []
      for (const value of deferred) this.onMessage(value)
    } else if (discardsDeferred) this.deferredOutputMessages = []
  }

  fail(worker, message) {
    if (worker !== this.worker) return
    this.worker = undefined
    this.workerLimit = undefined
    this.workerReady = undefined
    this.outputCapture = undefined
    this.outputCompletionPending = undefined
    this.deferredOutputMessages = []
    this.pendingOutputFailure = undefined
    this.port?.close()
    this.port = undefined
    const detail = this.stderrDetail(worker)
    this.onFailure(detail === undefined ? message : `${message}; last stderr: ${detail}`)
  }

  async reset(worker) {
    const port = this.worker === worker ? this.port : undefined
    if (this.worker === worker) {
      this.worker = undefined
      this.workerLimit = undefined
      this.workerReady = undefined
      this.outputCapture = undefined
      this.outputCompletionPending = undefined
      this.deferredOutputMessages = []
      this.port = undefined
    }
    await this.owner.stop(this.hostIds.get(worker))
    this.hostIds.delete(worker)
    port?.close()
  }

  async dispose() {
    this.disposed = true
    const worker = this.worker
    const port = this.port
    this.worker = undefined
    this.workerLimit = undefined
    this.workerReady = undefined
    this.outputCapture = undefined
    this.outputCompletionPending = undefined
    this.deferredOutputMessages = []
    this.pendingOutputFailure = undefined
    this.port = undefined
    if (worker !== undefined) this.hostIds.delete(worker)
    const failures = []
    try {
      port?.close()
    } catch (error) {
      failures.push(error)
    }
    failures.push(...await this.owner.dispose())
    if (failures.length > 0) {
      throw new AggregateError(failures, 'ptc-plus kernel worker disposal failed')
    }
    if (this.scratchReady !== undefined) {
      try {
        const scratchDirectory = await this.scratchReady
        await rm(scratchDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        // Scratch cleanup is best-effort after all worker handles are closed.
      }
    }
  }
}
