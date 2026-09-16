import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXECUTION_SEAM_SERVICE,
  LEGACY_EXECUTION_SEAM_SERVICE,
  createExecutionSeam,
  installExecutionSeam,
} from '../internal/execution-seam-compat.js'

// The services the plugin itself requires beside the seam it waits for.
const CORE_SERVICES = ['core']

// A provider with prototype accessors: the descriptors this module withholds
// are inherited, so a correct release has to remove the own property it wrote
// rather than restore an own descriptor that never existed.
class NodeRuntimeProvider {
  language = 'typescript'
  isolation = 'process'

  get executionInstructions() {
    return 'PROVIDER TEXT'
  }

  get sandboxMode() {
    return 'workspace-write'
  }

  get timeout() {
    return { defaultMs: 1_000, maxMs: 2_000 }
  }

  resolve(request) {
    return { ...request, cwd: '/provider-workspace', timeoutMs: 5 }
  }

  async run() {
    return { logs: ['provider'], value: 'provider' }
  }
}

// A host that registers services whenever a scenario provides them. An
// injection stays registered like a Cordis fiber, so providing the service it
// named runs its callback again; a scenario that unloads the injected fiber
// clears the lifecycle cleanups it registered.
function seamHost(initial = {}) {
  // Both the plugin's own required services and the seam it waits for are
  // registered through the same injection, so every scenario provides `core`.
  const services = { core: {}, ...initial }
  const injections = []
  const cleanups = []
  const failures = []
  const scope = {
    effect(register) {
      const dispose = register()
      cleanups.push(dispose)
      return dispose
    },
  }
  const flush = provided => {
    for (const entry of [...injections]) {
      if (provided !== undefined && !entry.names.includes(provided)) continue
      if (!entry.names.every(name => services[name] !== undefined)) continue
      try {
        entry.callback({ ...scope, ...services })
      } catch (error) {
        // Cordis contains a plugin callback's failure in the injected fiber.
        failures.push(error)
      }
    }
  }
  return {
    services,
    injections,
    failures,
    provide(name, service) {
      services[name] = service
      flush(name)
    },
    unprovide(name) {
      delete services[name]
    },
    unload() {
      while (cleanups.length > 0) cleanups.pop()()
    },
    ctx: {
      get: name => services[name],
      inject(names, callback) {
        const entry = { names, callback }
        injections.push(entry)
        flush()
        return () => {
          const index = injections.indexOf(entry)
          if (index !== -1) injections.splice(index, 1)
        }
      },
    },
  }
}

// A provider that records which of its two call shapes the seam reached.
class RecordingProvider extends NodeRuntimeProvider {
  calls = []

  resolve(request) {
    this.calls.push('resolve')
    return super.resolve(request)
  }

  async run(spec) {
    this.calls.push('run')
    return super.run(spec)
  }
}

test('the current seam runs a resolved spec through the plugin entry', async () => {
  const service = new RecordingProvider()
  const seam = createExecutionSeam(service, EXECUTION_SEAM_SERVICE)
  assert.equal(seam.serviceName, 'ptcRuntime')
  assert.equal(seam.language, 'typescript')

  const seen = []
  const release = seam.takeOver(request => {
    seen.push(request)
    return Promise.resolve({ logs: [], value: 'plugin' })
  })
  assert.equal(service.executionInstructions, '')
  assert.equal(service.sandboxMode, undefined)
  assert.equal(service.timeout, undefined)

  const result = await service.run(service.resolve({ program: 'return 1', bindings: [], signal: undefined }))
  assert.deepEqual(result, { logs: [], value: 'plugin' })
  // Only the plugin entry ran, and it received the seam-neutral request rather
  // than the resolved directory, deadline, and authority.
  assert.deepEqual(seen, [{ program: 'return 1', bindings: [], signal: undefined }])
  assert.deepEqual(service.calls, ['resolve'])

  // The wrapped provider is still reachable through the original call shape.
  assert.deepEqual(await seam.invokeUpstream({ program: 'return 2', bindings: [] }), {
    logs: ['provider'],
    value: 'provider',
  })
  assert.deepEqual(service.calls, ['resolve', 'resolve', 'run'])

  release()
  assert.equal(service.executionInstructions, 'PROVIDER TEXT')
  assert.equal(service.sandboxMode, 'workspace-write')
  assert.deepEqual(service.timeout, { defaultMs: 1_000, maxMs: 2_000 })
  assert.equal(Object.hasOwn(service, 'executionInstructions'), false)
  assert.equal(Object.hasOwn(service, 'sandboxMode'), false)
  assert.equal(Object.hasOwn(service, 'timeout'), false)
  assert.equal(Object.hasOwn(service, 'run'), false)
})

test('the preceding seam keeps its own call shape and descriptors', async () => {
  const requests = []
  const service = {
    language: 'typescript',
    isolation: 'worker-thread',
    async run(request) {
      requests.push(request)
      return { logs: [], value: 'upstream' }
    },
  }
  const seam = createExecutionSeam(service, LEGACY_EXECUTION_SEAM_SERVICE)
  const seen = []
  const release = seam.takeOver(request => {
    seen.push(request)
    return Promise.resolve({ logs: [], value: 'plugin' })
  })
  // The preceding generation publishes no descriptors to withhold.
  assert.equal(Object.hasOwn(service, 'sandboxMode'), false)
  assert.equal(Object.hasOwn(service, 'executionInstructions'), false)

  const request = { program: 'return 1', bindings: [] }
  assert.deepEqual(await service.run(request), { logs: [], value: 'plugin' })
  assert.deepEqual(seen, [request])
  assert.deepEqual(requests, [])

  release()
  assert.deepEqual(await service.run(request), { logs: [], value: 'upstream' })
  assert.deepEqual(requests, [request])
  assert.equal(Object.hasOwn(service, 'run'), true)

  // The wrapped provider stays reachable through the preceding generation's own
  // call shape: the request goes straight to `run`, with no resolve step.
  assert.deepEqual(await seam.invokeUpstream(request), { logs: [], value: 'upstream' })
  assert.deepEqual(requests, [request, request])
})

test('a release leaves a descriptor that another owner replaced', () => {
  const service = new NodeRuntimeProvider()
  const seam = createExecutionSeam(service, EXECUTION_SEAM_SERVICE)
  const release = seam.takeOver(() => Promise.resolve({ logs: [] }))
  const replacement = async () => ({ logs: ['replacement'] })
  Object.defineProperty(service, 'run', { configurable: true, writable: true, value: replacement })
  release()
  assert.equal(service.run, replacement)
  // The withheld descriptors this module wrote are still restored.
  assert.equal(service.executionInstructions, 'PROVIDER TEXT')
})

test('a second takeover of the same seam is rejected until it is released', () => {
  const service = new NodeRuntimeProvider()
  const seam = createExecutionSeam(service, EXECUTION_SEAM_SERVICE)
  const release = seam.takeOver(() => Promise.resolve({ logs: [] }))
  assert.throws(() => seam.takeOver(() => Promise.resolve({ logs: [] })), /already taken over/)
  release()
  const second = seam.takeOver(() => Promise.resolve({ logs: [] }))
  second()
  second()
  assert.equal(Object.hasOwn(service, 'run'), false)
})

test('an unusable execution service is rejected with its own name', () => {
  assert.throws(() => createExecutionSeam(null, 'ptcRuntime'), /ptcRuntime must be an execution service object/)
  assert.throws(() => createExecutionSeam({}, 'codeRuntime'), /codeRuntime\.run must be a function/)
  assert.throws(
    () => createExecutionSeam({ language: 'typescript', run() {} }, 'ptcRuntime'),
    /ptcRuntime\.resolve must be a function/,
  )
})

test('attaches to the seam the host registered', () => {
  const host = seamHost({ codeRuntime: { language: 'typescript', run() {} } })
  const attached = []
  installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (scope, seam) => attached.push([scope.core, seam.serviceName]),
  })
  assert.deepEqual(attached.map(entry => entry[1]), ['codeRuntime'])
  // The current generation's injection stays registered for a later provide.
  assert.equal(host.injections.length, 2)
})

test('waits for a seam the host has not registered yet, then attaches once', () => {
  const host = seamHost()
  const attached = []
  installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, [])
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  // The preceding-generation injection is still registered, and the current
  // generation already owns the seam.
  assert.deepEqual(attached, ['ptcRuntime'])
  host.provide('codeRuntime', { language: 'typescript', run() {} })
  assert.deepEqual(attached, ['ptcRuntime'])
})

test('prefers the current generation when a host registers both', () => {
  const host = seamHost()
  host.provide('codeRuntime', { language: 'typescript', run() {} })
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  const attached = []
  installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['ptcRuntime'])
})

test('attaches to the preceding generation when it is the only one registered', () => {
  const host = seamHost({ codeRuntime: { language: 'typescript', run() {} } })
  host.provide('codeRuntime', { language: 'typescript', run() {} })
  const attached = []
  installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['codeRuntime'])
})

test('ignores the preceding generation when the current one is already live', () => {
  const host = seamHost({ ptcRuntime: { language: 'typescript', resolve: request => request, run() {} } })
  host.provide('codeRuntime', { language: 'typescript', run() {} })
  const attached = []
  installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['ptcRuntime'])
})

test('reattaches after the host unloads and registers the seam again', () => {
  const host = seamHost()
  const attached = []
  installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  assert.deepEqual(attached, ['ptcRuntime'])
  // Cordis unloads the injected fiber with the service it injected.
  host.unload()
  host.unprovide('ptcRuntime')
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  assert.deepEqual(attached, ['ptcRuntime', 'ptcRuntime'])
})

test('reports an unusable seam as a load failure', async () => {
  const host = seamHost({ ptcRuntime: { language: 'typescript', run() {} } })
  await assert.rejects(
    installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: () => undefined }),
    /ptcRuntime\.resolve must be a function/,
  )
  // The failed selection is not retained, so a repaired service attaches.
  const attached = []
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  await installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['ptcRuntime'])
})

test('reports an attach failure and accepts the next injection', async () => {
  const host = seamHost({ codeRuntime: { language: 'typescript', run() {} } })
  const failure = new Error('attach failed')
  await assert.rejects(installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: () => { throw failure } }), failure)
  assert.deepEqual(host.failures, [failure])
  const attached = []
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  await installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['ptcRuntime'])
})

test('reads a service from a host context that has no accessor', () => {
  const service = { language: 'typescript', run() {} }
  const attached = []
  const ctx = {
    get codeRuntime() {
      return service
    },
    inject(names, callback) {
      if (names.includes('codeRuntime')) callback({ codeRuntime: service, core: {} })
      return () => {}
    },
  }
  installExecutionSeam(ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['codeRuntime'])
})

test('reads the injected service from the host when the scope does not carry it', () => {
  const service = { language: 'typescript', run() {} }
  const attached = []
  const ctx = {
    get: name => (name === 'codeRuntime' ? service : undefined),
    inject(names, callback) {
      // A host whose injected scope is not the service-bearing context.
      if (names.includes('codeRuntime')) callback({})
      return () => {}
    },
  }
  installExecutionSeam(ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['codeRuntime'])
})

test('attaches without a lifecycle hook when the injected scope has none', () => {
  const service = { language: 'typescript', run() {} }
  const attached = []
  const ctx = {
    get: name => (name === 'codeRuntime' ? service : undefined),
    inject(names, callback) {
      if (names.includes('codeRuntime')) callback({ codeRuntime: service, core: {} })
      return () => {}
    },
  }
  installExecutionSeam(ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['codeRuntime'])
})
