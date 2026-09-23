import { runtimeIntrinsics as internal } from './runtime-intrinsics.js'

const { Error, TypeError, includes, objectFreeze,
  objectGetOwnPropertyDescriptor, objectHasOwn, toString, Reflect: privateReflect } = internal

export const WORKER_REALM_MUTATION = objectFreeze({
  STABLE: 'stable-native-divergence',
  TEMPORARY: 'temporary-compiler-name',
  PROGRAM: 'per-cell-program-binding',
  USER: 'user-declaration-binding',
  RESTORE: 'restoration-only',
})

const MUTATION_CLASSES = objectFreeze([
  WORKER_REALM_MUTATION.STABLE,
  WORKER_REALM_MUTATION.TEMPORARY,
  WORKER_REALM_MUTATION.PROGRAM,
  WORKER_REALM_MUTATION.USER,
  WORKER_REALM_MUTATION.RESTORE,
])

export const PROCESS_CONTROL_ERROR_CODE = 'ERR_PTC_PROCESS_CONTROL'
export const WORKER_REALM_SURFACE_CONTRACT = objectFreeze([
  objectFreeze({
    surface: 'console',
    owner: 'internal/kernel-worker.js and internal/user-binding-console-worker.js',
    classification: WORKER_REALM_MUTATION.STABLE,
    contract: 'native Console methods; output enters the per-cell log budget',
    reference: 'plain Node worker console methods',
    verification: 'console-methods',
  }),
  objectFreeze({
    surface: 'process.stdout.write/process.stderr.write',
    owner: 'internal/kernel-worker.js',
    classification: WORKER_REALM_MUTATION.STABLE,
    contract: 'captured per cell as writable own methods; direct descriptor output remains covered by the helper transport',
    reference: 'plain Node worker stream descriptors',
    verification: 'stream-descriptors',
  }),
  objectFreeze({
    surface: 'process.cwd',
    owner: 'internal/worker-cwd-virtualization.js',
    classification: WORKER_REALM_MUTATION.STABLE,
    contract: 'recorded cwd; immutable and non-configurable when a session cwd exists',
    reference: 'plain Node worker process descriptor',
    verification: 'cwd-descriptor',
  }),
  objectFreeze({
    surface: 'cwd-projected Node builtins',
    owner: 'internal/worker-cwd-virtualization.js',
    classification: WORKER_REALM_MUTATION.STABLE,
    contract: 'relative fs, path, and child-process calls use the recorded cwd while retaining callable descriptors',
    reference: 'plain Node worker fs, fs/promises, path, and child_process callable descriptors',
    verification: 'cwd-projected-builtins',
  }),
  objectFreeze({
    surface: 'process.exit/abort/kill/chdir',
    owner: 'internal/worker-realm-surfaces.js',
    classification: WORKER_REALM_MUTATION.STABLE,
    contract: `immutable lifecycle guards; failures use ${PROCESS_CONTROL_ERROR_CODE}`,
    reference: 'plain Node worker process descriptors',
    verification: 'process-controls',
  }),
  objectFreeze({
    surface: 'fd 1/2 and inherited child output',
    owner: 'internal/worker-client.js and internal/worker-output-capture.js',
    classification: 'transport-boundary',
    contract: 'captured in the acknowledged per-cell dual-stream fence window; out-of-round output resets the worker',
    reference: 'helper stdout/stderr transport contract in ADR 0027',
    verification: 'descriptor-output',
  }),
  objectFreeze({
    surface: 'cell module metadata',
    owner: 'internal/session-cell-executor.js and internal/kernel-worker.js and internal/user-binding-console-worker.js',
    classification: WORKER_REALM_MUTATION.STABLE,
    contract: 'current cells expose import.meta url/filename/dirname; require subset exists without ambient CommonJS wrapper globals',
    reference: 'plain Node worker CommonJS surface and the session module parent',
    verification: 'module-surface',
  }),
  objectFreeze({
    surface: 'private AsyncLocalStorage receiver methods',
    owner: 'internal/async-local-storage-intrinsics.js',
    classification: WORKER_REALM_MUTATION.STABLE,
    contract: 'immutable captured getStore, enterWith, and run methods on plugin-private receivers',
    reference: 'the corresponding native AsyncLocalStorage methods bound to a fresh receiver',
    verification: 'private-async-local-storage',
  }),
  objectFreeze({
    surface: 'AsyncLocalStorage.prototype.run',
    owner: 'internal/async-local-storage-intrinsics.js',
    classification: WORKER_REALM_MUTATION.TEMPORARY,
    contract: 'native at rest; synchronously replaced only during private REPL bootstrap',
    reference: 'plain Node worker AsyncLocalStorage descriptors',
    verification: 'async-local-storage',
  }),
])

function assertMutation(classification, surface) {
  if (!includes(MUTATION_CLASSES, classification)) {
    throw new TypeError(`unknown worker realm mutation classification: ${classification}`)
  }
  if (classification !== WORKER_REALM_MUTATION.STABLE) return
  let registered = false
  for (let index = 0; index < WORKER_REALM_SURFACE_CONTRACT.length; index += 1) {
    const entry = WORKER_REALM_SURFACE_CONTRACT[index]
    if (entry.surface === surface && entry.classification === classification) registered = true
  }
  if (!registered) {
    throw new TypeError(`stable worker realm mutation requires a matching registered classification: ${surface}`)
  }
}

/** The only supported write boundary for worker globals, process surfaces and native prototypes. */
export function defineWorkerRealmProperty(classification, surface, owner, property, descriptor) {
  assertMutation(classification, surface)
  if (!privateReflect.defineProperty(owner, property, descriptor)) {
    throw new TypeError(`worker realm property ${toString(property)} could not be defined`)
  }
  return owner
}

export function assignWorkerRealmProperty(classification, surface, owner, property, value) {
  assertMutation(classification, surface)
  if (!privateReflect.set(owner, property, value)) {
    throw new TypeError(`worker realm property ${toString(property)} could not be assigned`)
  }
  return value
}

export function deleteWorkerRealmProperty(classification, surface, owner, property) {
  assertMutation(classification, surface)
  return privateReflect.deleteProperty(owner, property)
}

function codedError(code, message) {
  const error = new Error(message)
  privateReflect.defineProperty(error, 'code', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: code,
  })
  return error
}

export function installProjectedProcessCwd(processObject, cwd) {
  defineWorkerRealmProperty(WORKER_REALM_MUTATION.STABLE, 'process.cwd', processObject, 'cwd', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: () => cwd,
  })
}

export function installProcessControlGuards(processObject, properties) {
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index]
    const descriptor = objectGetOwnPropertyDescriptor(processObject, property)
    defineWorkerRealmProperty(
      WORKER_REALM_MUTATION.STABLE,
      'process.exit/abort/kill/chdir',
      processObject,
      property,
      {
      configurable: false,
      enumerable: descriptor?.enumerable ?? true,
      writable: false,
      value: () => {
        throw codedError(PROCESS_CONTROL_ERROR_CODE, `process.${property} is forbidden inside the REPL kernel`)
      },
      },
    )
  }
}

/** Stable facts consumed by the conformance test and runtime documentation. */
export function workerRealmSurfaceFacts(processObject) {
  const descriptor = (owner, name) => {
    const value = objectGetOwnPropertyDescriptor(owner, name)
    return value === undefined ? undefined : {
      configurable: value.configurable,
      enumerable: value.enumerable,
      writable: value.writable,
      own: true,
    }
  }
  const controls = []
  for (const name of ['exit', 'abort', 'kill', 'chdir']) controls.push([name, descriptor(processObject, name)])
  return {
    cwd: descriptor(processObject, 'cwd'),
    controls,
    stdoutWrite: descriptor(processObject.stdout, 'write'),
    stderrWrite: descriptor(processObject.stderr, 'write'),
    stdoutWriteOwn: objectHasOwn(processObject.stdout, 'write'),
    stderrWriteOwn: objectHasOwn(processObject.stderr, 'write'),
  }
}
