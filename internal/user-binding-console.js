import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { normalizeWorkerEnvironment } from './worker-client.js'

export const CONSOLE_IDLE_MS = 10 * 60 * 1000
const WORKER_URL = new URL('./user-binding-console-worker.js', import.meta.url)
const MAX_CONSOLES = 4
const MAX_SOURCE_BYTES = 1024 * 1024

/** Own only user workbench workers; no Agent state, replay or persistence. */
export class UserBindingConsole {
  constructor(options) {
    this.options = options
    this.environments = new Map()
  }

  release(capability, reason = 'reset') {
    const environment = this.environments.get(capability)
    if (environment === undefined) return
    this.environments.delete(capability)
    clearTimeout(environment.idleTimer)
    environment.active?.finish({ error: reason, released: true })
    void environment.worker.terminate()
  }

  dispose() {
    for (const capability of this.environments.keys()) this.release(capability, 'disposed')
  }

  reconfigure(options) {
    if (['maxWallMs', 'maxOutputBytes', 'maxOldGenerationSizeMb'].some(key => this.options[key] !== options[key])) this.dispose()
    this.options = options
  }

  async run({ environment: capability, source, code }, signal) {
    for (const [label, value] of [['source', source], ['code', code]]) {
      if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > MAX_SOURCE_BYTES) {
        throw new TypeError(`console ${label} must be non-empty TypeScript within 1 MiB`)
      }
    }
    signal?.throwIfAborted()
    let environment = this.environments.get(capability)
    if (environment?.active !== undefined) throw new Error('console is already running')
    const reset = capability !== undefined && (environment === undefined || environment.source !== source)
    if (environment !== undefined && environment.source !== source) {
      this.release(capability, 'source changed')
      environment = undefined
    }
    if (environment === undefined) {
      if (this.environments.size >= MAX_CONSOLES) throw new Error('too many active code consoles')
      capability = randomUUID()
      const worker = new Worker(WORKER_URL, {
        workerData: { source, cwd: this.options.cwd, maxOutputBytes: this.options.maxOutputBytes },
        env: normalizeWorkerEnvironment(process.env),
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb },
        stdout: true, stderr: true,
      })
      environment = { worker, source, logs: [], outputBytes: 0, sequence: 0 }
      this.environments.set(capability, environment)
      const fail = reason => this.release(capability, reason)
      for (const [stream, channel] of [[worker.stdout, 'stdout'], [worker.stderr, 'stderr']]) {
        stream.on('data', chunk => {
          const text = String(chunk)
          environment.outputBytes += Buffer.byteLength(text)
          if (environment.outputBytes > this.options.maxOutputBytes) fail('console output limit exceeded')
          else environment.logs.push({ channel, text })
        })
      }
      worker.on('error', error => fail(error.message))
      worker.on('exit', code => fail(`console worker exited (${code})`))
      worker.on('message', message => {
        if (message === null || typeof message !== 'object') { fail('invalid console result'); return }
        if (message.fatal === true) { fail(message.error); return }
        if (message.id !== environment.active?.id) return
        if (typeof message.output !== 'string' && typeof message.error !== 'string') {
          fail('invalid console result'); return
        }
        const result = typeof message.error === 'string' ? { error: message.error } : { output: message.output }
        const bytes = Buffer.byteLength(JSON.stringify(result)) + environment.outputBytes
        if (bytes > this.options.maxOutputBytes) fail('console output limit exceeded')
        else environment.active.finish(result)
      })
    }
    clearTimeout(environment.idleTimer)
    const id = ++environment.sequence
    return new Promise(resolve => {
      const abort = () => this.release(capability, 'stopped')
      const timer = setTimeout(() => this.release(capability, 'execution timed out'), this.options.maxWallMs)
      const started = Date.now()
      environment.active = { id, finish: result => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        environment.active = undefined
        const live = this.environments.get(capability) === environment
        const expiresAt = live ? Date.now() + CONSOLE_IDLE_MS : null
        if (live) {
          environment.idleTimer = setTimeout(() => this.release(capability, 'idle'), CONSOLE_IDLE_MS)
          environment.idleTimer.unref()
        }
        const logs = environment.logs
        environment.logs = []
        environment.outputBytes = 0
        resolve({ ...result, id: undefined, environment: live ? capability : null,
          reset, expiresAt, logs, durationMs: Date.now() - started })
      } }
      signal?.addEventListener('abort', abort, { once: true })
      try { environment.worker.postMessage({ id, code }) }
      catch (error) { this.release(capability, error.message) }
    })
  }
}
