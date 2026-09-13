import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { messageOf } from './failure-reporting.js'

const WINDOWS_ENVIRONMENT_NAMES = new Map([
  ['appdata', 'APPDATA'],
  ['comspec', 'ComSpec'],
  ['home', 'HOME'],
  ['homedrive', 'HOMEDRIVE'],
  ['homepath', 'HOMEPATH'],
  ['localappdata', 'LOCALAPPDATA'],
  ['path', 'PATH'],
  ['pathext', 'PATHEXT'],
  ['programdata', 'ProgramData'],
  ['programfiles', 'ProgramFiles'],
  ['programfiles(x86)', 'ProgramFiles(x86)'],
  ['systemdrive', 'SystemDrive'],
  ['systemroot', 'SystemRoot'],
  ['temp', 'TEMP'],
  ['tmp', 'TMP'],
  ['userprofile', 'USERPROFILE'],
  ['windir', 'windir'],
])
const HOST_ONLY_ENVIRONMENT_NAMES = new Set(['node_test_context', 'node_v8_coverage', 'dsh_ptc_compiler_bytecode'])

/** Project the host environment once without losing Windows case variants. */
export function normalizeWorkerEnvironment(source, platform = process.platform) {
  if (platform !== 'win32') {
    return Object.fromEntries(Object.entries(source).filter(([name, value]) => (
      value !== undefined && !HOST_ONLY_ENVIRONMENT_NAMES.has(name.toLowerCase())
    )))
  }
  const normalized = new Map()
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    if (HOST_ONLY_ENVIRONMENT_NAMES.has(key)) continue
    const canonicalName = WINDOWS_ENVIRONMENT_NAMES.get(key) ?? name
    const current = normalized.get(key)
    if (current === undefined || name === canonicalName) {
      normalized.set(key, [canonicalName, value])
    }
  }
  return Object.fromEntries(normalized.values())
}

/** Owns one session kernel's worker process, private port, and scratch directory. */
export class WorkerClient {
  constructor({ workerUrl, cwd, onMessage, onFailure, compilerCache }) {
    this.workerUrl = workerUrl
    this.cwd = cwd
    this.onMessage = onMessage
    this.onFailure = onFailure
    this.compilerCache = compilerCache
    this.worker = undefined
    this.workerLimit = undefined
    this.workerReady = undefined
    this.port = undefined
    this.scratchReady = undefined
    this.stderrTails = new WeakMap()
    this.terminations = new Set()
    this.disposed = false
  }

  /** Last non-empty stderr line of a failed worker, capped for diagnostics. */
  stderrDetail(worker) {
    const tail = this.stderrTails.get(worker)?.join('').trim()
    if (tail === undefined || tail.length === 0) return undefined
    const lastLine = tail.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).slice(-1)[0]
    return lastLine === undefined ? undefined : lastLine.slice(0, 300)
  }

  async ensure(maxOldGenerationSizeMb) {
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
      worker = new Worker(this.workerUrl, {
        env: {
          ...environment,
          TEMP: scratchDirectory,
          TMP: scratchDirectory,
          TMPDIR: scratchDirectory,
        },
        execArgv: [],
        workerData: { cwd: this.cwd, compilerCache: this.compilerCache?.() },
        resourceLimits: { maxOldGenerationSizeMb: this.workerLimit },
        stdout: true,
        stderr: true,
      })
    } catch (error) {
      this.workerLimit = undefined
      throw error
    }
    worker.stdout.resume()
    worker.stderr.resume()
    const stderrTail = []
    worker.stderr.on?.('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      stderrTail.push(text)
      const bounded = Buffer.from(stderrTail.join('')).subarray(-2048).toString('utf8')
      stderrTail.splice(0, stderrTail.length, bounded)
    })
    this.stderrTails.set(worker, stderrTail)
    worker.on('error', error => this.fail(worker, `worker error: ${messageOf(error)}`))
    worker.on('exit', code => this.fail(worker, `worker exited with code ${code}`))
    this.worker = worker
    this.workerReady = new Promise((resolve, reject) => {
      const onError = error => reject(error)
      const onExit = (code) => {
        const detail = this.stderrDetail(worker)
        reject(new Error(detail === undefined
          ? `worker exited with code ${code} before opening its private channel`
          : `worker exited with code ${code} before opening its private channel; last stderr: ${detail}`))
      }
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.once('message', (message) => {
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
        if (message?.type === 'startup-error' && typeof message.error === 'string') {
          reject(new Error(message.error))
          void this.reset(worker)
          return
        }
        if (message?.type !== 'ready' || typeof message.port?.postMessage !== 'function') {
          reject(new Error('kernel worker returned an invalid private channel'))
          void this.reset(worker)
          return
        }
        this.port = message.port
        this.port.on('message', (value) => {
          if (worker === this.worker) this.onMessage(value)
        })
        resolve(worker)
      })
    })
    return this.workerReady
  }

  post(message) {
    this.port.postMessage(message)
  }

  /** Best-effort reply for a request whose lease may outlive a worker reset. */
  postIfAlive(message) {
    this.port?.postMessage(message)
  }

  fail(worker, message) {
    if (worker !== this.worker) return
    this.worker = undefined
    this.workerLimit = undefined
    this.workerReady = undefined
    this.port?.close()
    this.port = undefined
    const detail = this.stderrDetail(worker)
    this.onFailure(detail === undefined ? message : `${message}; last stderr: ${detail}`)
  }

  async reset(worker) {
    if (this.worker === worker) {
      this.worker = undefined
      this.workerLimit = undefined
      this.workerReady = undefined
      this.port?.close()
      this.port = undefined
    }
    const termination = worker.terminate()
    this.terminations.add(termination)
    try {
      await termination
    } finally {
      this.terminations.delete(termination)
    }
  }

  async dispose() {
    this.disposed = true
    const worker = this.worker
    if (worker !== undefined) await this.reset(worker)
    await Promise.all([...this.terminations])
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
