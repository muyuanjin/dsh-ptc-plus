/**
 * Fixture seam for the worker identity and protocol delivery of one live
 * session kernel.
 *
 * `SessionRuntime` deliberately exposes no transport accessor, but the runtime
 * tests still have to prove two real behaviors: a session keeps or replaces
 * its worker, and late, missing, or duplicated protocol frames cannot change a
 * settled cell. The tests that use this module reach the kernel container and
 * the transport object only through it, so renaming either one changes this
 * file instead of every assertion.
 *
 * This is a test fixture seam, not a runtime API. Nothing here is exported
 * from the package, and no production code depends on it.
 */

function kernelOf(runtime, sessionId) {
  return runtime.kernels.get(String(sessionId))
}

function clientOf(runtime, sessionId) {
  return kernelOf(runtime, sessionId)?.client
}

/** Kernel-owned facts (durable history, rollback, journal completion) for one session. */
export function sessionKernel(runtime, sessionId) {
  return kernelOf(runtime, sessionId)
}

/** True when the runtime already owns a kernel; observation must never create one. */
export function hasSessionKernel(runtime, sessionId) {
  return runtime.kernels.has(String(sessionId))
}

/** Cell executor seam for controls that only exist outside a running cell. */
export function sessionCellExecutor(runtime, sessionId) {
  return kernelOf(runtime, sessionId)?.cellExecutor
}

export function workerOf(runtime, sessionId) {
  return clientOf(runtime, sessionId)?.worker
}

export function workerLimitOf(runtime, sessionId) {
  return clientOf(runtime, sessionId)?.workerLimit
}

export function workerMemoryLimitMb(worker) {
  return worker?.resourceLimits?.maxOldGenerationSizeMb
}

export function scratchDirectoryOf(runtime, sessionId) {
  return clientOf(runtime, sessionId)?.scratchReady
}

/**
 * Replace the scratch-directory promise so disposal has to tolerate a read
 * failure. The replacement is pre-observed, exactly as the transport does.
 */
export function failScratchDirectory(runtime, sessionId, error) {
  const client = clientOf(runtime, sessionId)
  const ready = Promise.reject(error)
  void ready.catch(() => {})
  client.scratchReady = ready
}

const originalPosts = new WeakMap()

function originalPostOf(client) {
  let post = originalPosts.get(client)
  if (post === undefined) {
    post = client.post.bind(client)
    originalPosts.set(client, post)
  }
  return post
}

/**
 * Replace outbound frame delivery for one session. `intercept(message)` returns
 * the frame to forward or `undefined` to hold it. Interceptors always forward
 * through the transport itself, so replacing one interceptor with another does
 * not stack them; the returned `post` releases a held frame directly.
 */
export function interceptWorkerPosts(runtime, sessionId, intercept) {
  const client = clientOf(runtime, sessionId)
  const post = originalPostOf(client)
  client.post = message => {
    const forwarded = intercept(message)
    if (forwarded !== undefined) post(forwarded)
  }
  return { post, restore: () => { client.post = post } }
}

/**
 * Replace inbound frame handling for one session. `intercept(message, deliver)`
 * may forward, rewrite, duplicate, or drop the frame through `deliver`.
 */
export function interceptWorkerMessages(runtime, sessionId, intercept) {
  const executor = sessionCellExecutor(runtime, sessionId)
  const deliver = executor.onMessage.bind(executor)
  executor.onMessage = message => intercept(message, deliver)
  return { deliver, restore: () => { executor.onMessage = deliver } }
}

/** True while the session kernel owns a cell that has not settled. */
export function isCellActive(runtime, sessionId) {
  return kernelOf(runtime, sessionId)?.active !== undefined
}

/** Budget timers of the cell currently owned by the session, if any. */
export function activeTimers(runtime, sessionId) {
  const active = kernelOf(runtime, sessionId)?.active
  return active === undefined
    ? undefined
    : { compute: active.computeTimer, wall: active.wallTimer }
}

export function workerObservationOf(runtime, sessionId) {
  return kernelOf(runtime, sessionId)?.workerObservation
}

/**
 * Install the DSH session surface the kernel compares its recorded generation
 * against, or clear it with `undefined`. `acknowledged` records that the
 * kernel has already observed the installed generation; pass `false` for a
 * replacement that happened after the last observation, which leaves the
 * kernel's previous record in place. The generation is read only when
 * `acknowledged` is true, so a surface whose generation read throws must be
 * installed with `false`.
 */
export function setSessionSurface(runtime, sessionId, surface, acknowledged = true) {
  const kernel = kernelOf(runtime, sessionId)
  kernel.session = surface === undefined ? undefined : { surface }
  if (acknowledged) kernel.surfaceGeneration = surface?.replaceGeneration
}

/** Report a failure for a worker that is no longer the current one. */
export function failWorker(runtime, sessionId, worker, message) {
  clientOf(runtime, sessionId).fail(worker, message)
}

/** Deliver an output-attribution failure that does not belong to the active output round. */
export function failUnmatchedOutput(runtime, sessionId, message) {
  return clientOf(runtime, sessionId).onUnmatchedOutputFailure(message)
}

/**
 * Drop the transport slot as if its worker had failed without a live port.
 * Returns a restore callback so the real worker can still be terminated.
 */
export function detachWorker(runtime, sessionId, message) {
  const client = clientOf(runtime, sessionId)
  const previous = client.worker
  client.worker = {}
  client.port = undefined
  client.fail(client.worker, message)
  return () => { client.worker = previous }
}

export async function resetWorker(runtime, sessionId) {
  const client = clientOf(runtime, sessionId)
  await client.reset(client.worker)
}

/** Terminate the current worker as the host would when the session ends. */
export async function terminateWorker(runtime, sessionId) {
  await workerOf(runtime, sessionId)?.terminate()
}

/** Drop the live worker and its live bindings while keeping durable history. */
export async function restartWorker(runtime, sessionId) {
  const kernel = kernelOf(runtime, sessionId)
  await resetWorker(runtime, sessionId)
  kernel.rollbackToDurable()
}

export function durableHistoryNodeCount(runtime, sessionId) {
  return kernelOf(runtime, sessionId)?.history.nodes.length
}

/** Durable history as one comparable string, for before/after identity. */
export function durableHistorySnapshot(runtime, sessionId) {
  return JSON.stringify(kernelOf(runtime, sessionId).history)
}

/** Make the next kernel request reject before any cell reaches the worker. */
export function failKernelExecute(runtime, sessionId, error) {
  kernelOf(runtime, sessionId).execute = async () => { throw error }
}

/** Submit a raw kernel request, bypassing the session tool path. */
export function runKernelRequest(runtime, sessionId, request) {
  return kernelOf(runtime, sessionId).run(request)
}

/** Settle the kernel queue after a rejected request. */
export function awaitKernelTail(runtime, sessionId) {
  return kernelOf(runtime, sessionId).tail
}

/**
 * Hold the kernel queue behind a pending promise, as a request that has been
 * admitted but cannot start yet. `release` settles it and `tail` is the held
 * queue itself.
 */
export function holdKernelQueue(runtime, sessionId) {
  const kernel = kernelOf(runtime, sessionId)
  const held = Promise.withResolvers()
  kernel.tail = held.promise
  return { tail: held.promise, release: () => held.resolve() }
}
