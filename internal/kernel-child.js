import { Worker } from 'node:worker_threads'
import { relayWorkerOutput } from './worker-output-relay.js'

/**
 * Host one session kernel worker inside a killable helper process.
 *
 * Boundary: the host reaches this process over the process IPC channel, this
 * process owns the kernel worker and its private MessagePort, and that port
 * never crosses the process boundary. Kernel output reaches the host through the
 * helper's own platform stdio pipes, so no byte is duplicated into IPC messages
 * and counting stays with the host's output budget owner.
 */
const send = message => { if (typeof process.send === 'function') process.send(message) }

function sendBeforeDisconnect(message) {
  return new Promise(resolve => {
    if (typeof process.send !== 'function' || !process.connected) { resolve(); return }
    process.send(message, () => resolve())
  })
}

function errorWire(error) {
  return {
    type: 'child-error',
    message: error?.message ?? String(error),
    name: error?.name,
    code: error?.code,
    stack: error?.stack,
  }
}

let kernelPort
let worker
let stopping = false
let utilizationTimer

function releaseHelper() {
  if (stopping) return
  stopping = true
  clearInterval(utilizationTimer)
  utilizationTimer = undefined
  kernelPort?.close()
  kernelPort = undefined
  process.removeAllListeners('message')
  if (typeof process.disconnect === 'function' && process.connected) process.disconnect()
}

process.on('message', message => {
  if (worker !== undefined) {
    // Host budget baselines must be sampled after any work that finished before
    // this request. The helper answers directly without waiting for the worker,
    // so a busy inner loop cannot hide the current utilization.
    if (message?.type === 'sample-utilization') {
      send({ type: 'utilization-sample', id: message.id, utilization: worker.performance.eventLoopUtilization() })
      return
    }
    // Routed by ownership, not by handshake shape: parent-port requests reach the
    // worker whenever it exists, and private messages need the port to be ready.
    if (message?.type === 'kernel-message') kernelPort?.postMessage(message.value)
    if (message?.type === 'worker-message') worker.postMessage(message.value)
    return
  }
  if (message?.type !== 'init' || typeof message.workerData !== 'object' || message.workerData === null) {
    send({ type: 'child-error', message: 'helper requires one init message before the kernel worker starts' })
    return
  }
  // The host boundary already normalized the entry to an absolute file URL and
  // supplied an explicit, pre-fork snapshot of the user worker's environment.
  // That projection is the user Worker contract; the helper's own coverage
  // variable is deliberately not reused here.
  worker = new Worker(message.entry === undefined ? new URL('./kernel-worker.js', import.meta.url) : new URL(message.entry), {
    workerData: message.workerData,
    resourceLimits: message.resourceLimits,
    execArgv: [],
    stdout: true,
    stderr: true,
    env: message.env,
  })
  // The inner worker reports its own effective limits; the host never echoes back
  // what it requested.
  send({ type: 'child-limits', limits: worker.resourceLimits })
  const relayedOutput = Promise.allSettled([
    relayWorkerOutput(worker.stdout, process.stdout),
    relayWorkerOutput(worker.stderr, process.stderr),
  ])
  let workerFailure
  const failStartup = error => {
    workerFailure ??= error
    // A protocol-level startup failure can leave the Worker alive under
    // coverage or another runtime hook. End it here so direct transport users
    // also reach process close and receive the drained public error.
    void worker.terminate().catch(terminationError => { workerFailure ??= terminationError })
  }
  worker.on('error', error => { workerFailure = error })
  worker.on('exit', async code => {
    const outputResults = await relayedOutput
    const outputFailure = outputResults.find(result => result.status === 'rejected')?.reason
    if (workerFailure !== undefined) await sendBeforeDisconnect(errorWire(workerFailure))
    else if (outputFailure !== undefined) await sendBeforeDisconnect(errorWire(outputFailure))
    await sendBeforeDisconnect({ type: 'inner-worker-exit', code })
    releaseHelper()
    process.exitCode = code ?? 0
  })
  // Battery of samples taken here, on this process's main thread: the inner
  // worker's utilization stays readable while its own loop is blocked, which is
  // what the host's compute budget needs.
  utilizationTimer = setInterval(() => {
    send({ type: 'child-utilization', utilization: worker.performance.eventLoopUtilization() })
  }, 50)
  if (message.protocol === 'parent-port') {
    // Workbench and candidate workers speak on their own parent port instead of
    // opening a private channel; both directions are relayed unchanged.
    worker.on('message', value => send({ type: 'worker-message', value }))
    send({ type: 'ready', utilization: worker.performance.eventLoopUtilization() })
    return
  }
  worker.once('message', message => {
    if (message?.type === 'startup-error' && typeof message.error === 'string') {
      failStartup(new Error(message.error))
      return
    }
    if (message?.type !== 'ready' || typeof message.port?.postMessage !== 'function') {
      failStartup(new Error('kernel worker returned an invalid private channel'))
      return
    }
    kernelPort = message.port
    kernelPort.on('message', value => send({
      type: 'kernel-message',
      value,
      // Fresh baseline for the inner worker at every relayed message, on top of
      // the main thread's periodic sampling below.
      utilization: worker.performance.eventLoopUtilization(),
    }))
    worker.on('message', value => {
      if (value?.type !== 'ready') send({ type: 'worker-message', value })
    })
    send({ type: 'ready', utilization: worker.performance.eventLoopUtilization() })
  })
})
