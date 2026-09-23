import {
  OUTPUT_FENCE_ALLOWANCE_BYTES,
  outputFenceMarker,
  validOutputFenceToken,
} from './worker-output-fence.js'

function bytes(value) {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value ?? ''))
}

function nonEmptyText(value) {
  return value.length === 0 ? [] : [value.toString('utf8')]
}

/** Correlate helper stdout/stderr with one kernel completion using dual fences. */
export class WorkerOutputCapture {
  constructor() {
    this.armed = false
    this.round = undefined
    this.settledId = undefined
  }

  begin(id, maxOutputBytes, outputFence) {
    this.armed = true
    if (this.round !== undefined) {
      return { type: 'worker-output-error', id, message: 'worker output rounds overlapped' }
    }
    if (!validOutputFenceToken(outputFence)) {
      return { type: 'worker-output-error', id, message: 'host created an invalid worker output fence' }
    }
    this.round = {
      id,
      maxOutputBytes,
      outputFence,
      stdout: [],
      stderr: [],
      bytes: 0,
      started: false,
      startMessage: false,
      completion: undefined,
    }
    return undefined
  }

  push(channel, chunk) {
    if (!this.armed) return undefined
    if (this.round === undefined) {
      this.armed = false
      return {
        type: 'worker-output-error',
        id: this.settledId,
        message: 'a settled cell produced descriptor output after its output fence; the worker was reset to stop unattributed output',
      }
    }
    const value = bytes(chunk)
    this.round[channel].push(value)
    this.round.bytes += value.length
    if (this.round.bytes > this.round.maxOutputBytes + OUTPUT_FENCE_ALLOWANCE_BYTES) {
      const id = this.round.id
      this.round = undefined
      return { type: 'output-limit', id, logs: [] }
    }
    return this.round.started ? this.#finish() : this.#start()
  }

  start(message) {
    if (this.round === undefined || message?.id !== this.round.id) {
      const id = this.round?.id ?? message?.id
      this.round = undefined
      return { type: 'worker-output-error', id, message: 'kernel output start has no matching output round' }
    }
    if (message.outputFence !== this.round.outputFence) {
      const id = this.round.id
      this.round = undefined
      return { type: 'worker-output-error', id, message: 'kernel output start has a mismatched output fence' }
    }
    if (this.round.startMessage) {
      const id = this.round.id
      this.round = undefined
      return { type: 'worker-output-error', id, message: 'kernel repeated an output start' }
    }
    this.round.startMessage = true
    return this.#start()
  }

  complete(message) {
    if (this.round === undefined || message?.id !== this.round.id) {
      const id = this.round?.id ?? message?.id
      this.round = undefined
      return { type: 'worker-output-error', id, message: 'kernel completion has no matching output round' }
    }
    if (!this.round.started || message.outputFence !== this.round.outputFence) {
      const id = this.round.id
      this.round = undefined
      return { type: 'worker-output-error', id, message: 'kernel completion has a mismatched output fence' }
    }
    if (this.round.completion !== undefined) {
      const id = this.round.id
      this.round = undefined
      return { type: 'worker-output-error', id, message: 'kernel repeated a completion' }
    }
    this.round.completion = message
    return this.#finish()
  }

  lateOutput() {
    if (this.round !== undefined) {
      const id = this.round.id
      this.round = undefined
      return {
        type: 'worker-output-error',
        id,
        message: 'a settled cell produced background output during this cell; the worker was reset to prevent cross-cell attribution',
      }
    }
    if (this.armed) {
      this.armed = false
      return {
        type: 'worker-output-error',
        id: this.settledId,
        message: 'a settled cell produced background output after its output fence; the worker was reset to prevent cross-cell attribution',
      }
    }
    return undefined
  }

  #start() {
    const round = this.round
    if (round?.startMessage !== true) return undefined
    const stdout = Buffer.concat(round.stdout)
    const stderr = Buffer.concat(round.stderr)
    const stdoutFence = Buffer.from(outputFenceMarker(round.outputFence, 'stdout', 'start'))
    const stderrFence = Buffer.from(outputFenceMarker(round.outputFence, 'stderr', 'start'))
    const stdoutAt = stdout.indexOf(stdoutFence)
    const stderrAt = stderr.indexOf(stderrFence)
    if (stdoutAt < 0 || stderrAt < 0) return undefined
    const stdoutAfter = stdout.subarray(stdoutAt + stdoutFence.length)
    const stderrAfter = stderr.subarray(stderrAt + stderrFence.length)
    if (stdoutAt > 0 || stderrAt > 0 || stdoutAfter.length > 0 || stderrAfter.length > 0) {
      const id = round.id
      this.round = undefined
      return {
        type: 'worker-output-error',
        id,
        message: 'a settled cell produced descriptor output before the next cell started; the worker was reset to prevent cross-cell attribution',
      }
    }
    round.stdout = []
    round.stderr = []
    round.bytes = 0
    round.started = true
    return { type: 'worker-output-started', id: round.id, outputFence: round.outputFence }
  }

  #finish() {
    const round = this.round
    if (round?.completion === undefined) return undefined
    const stdout = Buffer.concat(round.stdout)
    const stderr = Buffer.concat(round.stderr)
    const stdoutFence = Buffer.from(outputFenceMarker(round.outputFence, 'stdout', 'end'))
    const stderrFence = Buffer.from(outputFenceMarker(round.outputFence, 'stderr', 'end'))
    const stdoutAt = stdout.indexOf(stdoutFence)
    const stderrAt = stderr.indexOf(stderrFence)
    if (stdoutAt < 0 || stderrAt < 0) return undefined
    const stdoutAfter = stdout.subarray(stdoutAt + stdoutFence.length)
    const stderrAfter = stderr.subarray(stderrAt + stderrFence.length)
    if (stdoutAfter.length > 0 || stderrAfter.length > 0) {
      this.round = undefined
      this.armed = false
      return {
        type: 'worker-output-error',
        id: round.id,
        message: 'a settled cell produced descriptor output after its output fence; the worker was reset to prevent cross-cell attribution',
      }
    }
    const descriptorLogs = [
      ...nonEmptyText(stdout.subarray(0, stdoutAt)),
      ...nonEmptyText(stderr.subarray(0, stderrAt)),
    ]
    const rawBytes = descriptorLogs.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0)
    this.round = undefined
    this.settledId = round.id
    if (rawBytes > round.maxOutputBytes) return { type: 'output-limit', id: round.id, logs: [] }
    const logs = Array.isArray(round.completion.logs) ? [...round.completion.logs, ...descriptorLogs] : descriptorLogs
    return { ...round.completion, logs }
  }
}
