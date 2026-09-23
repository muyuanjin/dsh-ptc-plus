import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
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
  const disposeAttempts = []
  const disposeEffects = (entry) => {
    const pending = []
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      const record = cleanups[index]
      if (entry !== undefined && record.entry !== entry) continue
      cleanups.splice(index, 1)
      pending.push(record.dispose())
    }
    return Promise.all(pending)
  }
  const registerEffect = (entry, register) => {
    const owned = register()
    let active = true
    const dispose = () => {
      if (!active) return undefined
      active = false
      return owned?.()
    }
    cleanups.push({ entry, dispose })
    return dispose
  }
  const createScope = entry => {
    const scope = {
      effect(register) {
        return registerEffect(entry, register)
      },
    }
    scope.fiber = {
      dispose() {
        disposeAttempts.push(entry.names)
        if (entry.disposeError !== undefined) throw entry.disposeError
        if (entry.disposed) return undefined
        entry.disposed = true
        const index = injections.indexOf(entry)
        if (index !== -1) injections.splice(index, 1)
        return disposeEffects(entry)
      },
    }
    return scope
  }
  const flush = provided => {
    for (const entry of [...injections]) {
      if (entry.disposed) continue
      if (provided !== undefined && !entry.names.includes(provided)) continue
      if (!entry.names.every(name => services[name] !== undefined)) continue
      try {
        const result = entry.callback({ ...entry.scope, ...services })
        Promise.resolve(result).catch(error => failures.push(error))
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
    disposeAttempts,
    provide(name, service) {
      services[name] = service
      flush(name)
    },
    unprovide(name) {
      delete services[name]
      for (const entry of [...injections]) {
        if (entry.names.includes(name)) void disposeEffects(entry)
      }
    },
    failDispose(name, error) {
      const entry = injections.find(item => item.names.includes(name))
      entry.disposeError = error
    },
    unload() {
      return disposeEffects()
    },
    stop() {
      const pending = []
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        const record = cleanups[index]
        if (record.entry !== undefined) continue
        cleanups.splice(index, 1)
        pending.push(record.dispose())
      }
      return Promise.all(pending)
    },
    ctx: {
      get: name => services[name],
      effect(register) {
        return registerEffect(undefined, register)
      },
      inject(names, callback) {
        const entry = { names, callback, disposed: false }
        entry.scope = createScope(entry)
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
  // The preceding generation's contract defines none of these members, and the
  // takeover still leaves no provider capability claim in place.
  assert.equal(service.executionInstructions, '')
  assert.equal(service.sandboxMode, undefined)
  assert.equal(service.timeout, undefined)

  const request = { program: 'return 1', bindings: [] }
  assert.deepEqual(await service.run(request), { logs: [], value: 'plugin' })
  assert.deepEqual(seen, [request])
  assert.deepEqual(requests, [])

  release()
  assert.deepEqual(await service.run(request), { logs: [], value: 'upstream' })
  assert.deepEqual(requests, [request])
  assert.equal(Object.hasOwn(service, 'run'), true)
  assert.equal(Object.hasOwn(service, 'executionInstructions'), false)
  assert.equal(Object.hasOwn(service, 'sandboxMode'), false)
  assert.equal(Object.hasOwn(service, 'timeout'), false)

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

test('a failed takeover leaves every execution service descriptor unchanged', () => {
  const service = new NodeRuntimeProvider()
  Object.defineProperty(service, 'timeout', {
    configurable: false,
    enumerable: true,
    value: { defaultMs: 1_000, maxMs: 2_000 },
  })
  const names = ['run', 'executionInstructions', 'sandboxMode', 'timeout']
  const before = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(service, name)]))
  const seam = createExecutionSeam(service, EXECUTION_SEAM_SERVICE)

  assert.throws(() => seam.takeOver(() => Promise.resolve({ logs: [], value: 'plugin' })),
    /Cannot redefine property: timeout/)
  for (const name of names) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(service, name), before.get(name))
  }
})

test('a non-extensible provider can be taken over when every descriptor already exists', () => {
  const service = {
    language: 'typescript',
    executionInstructions: 'provider',
    sandboxMode: 'workspace-write',
    timeout: { defaultMs: 1_000 },
    resolve: request => request,
    run() {},
  }
  Object.preventExtensions(service)
  const seam = createExecutionSeam(service, EXECUTION_SEAM_SERVICE)
  const release = seam.takeOver(() => Promise.resolve({ logs: [] }))

  assert.equal(service.executionInstructions, '')
  assert.equal(service.sandboxMode, undefined)
  assert.equal(service.timeout, undefined)
  release()
  assert.equal(service.executionInstructions, 'provider')
  assert.equal(service.sandboxMode, 'workspace-write')
  assert.deepEqual(service.timeout, { defaultMs: 1_000 })
  assert.equal(Object.isExtensible(service), false)
})

test('a write failure after preflight rolls back descriptors already installed', () => {
  const target = new NodeRuntimeProvider()
  Object.defineProperty(target, 'run', {
    configurable: true,
    writable: true,
    value: target.run,
  })
  const before = Object.getOwnPropertyDescriptor(target, 'run')
  const service = new Proxy(target, {
    defineProperty(object, name, descriptor) {
      if (name === 'sandboxMode') throw new Error('injected descriptor failure')
      return Reflect.defineProperty(object, name, descriptor)
    },
  })
  const seam = createExecutionSeam(service, EXECUTION_SEAM_SERVICE)

  assert.throws(() => seam.takeOver(() => Promise.resolve({ logs: [] })), /injected descriptor failure/)
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'run'), before)
  assert.equal(Object.hasOwn(target, 'executionInstructions'), false)
})

test('takeover rollback does not overwrite a concurrent descriptor owner', () => {
  const target = new NodeRuntimeProvider()
  const replacement = async () => ({ logs: ['replacement'] })
  const service = new Proxy(target, {
    defineProperty(object, name, descriptor) {
      if (name === 'executionInstructions') {
        Object.defineProperty(object, 'run', {
          configurable: true,
          writable: true,
          value: replacement,
        })
        throw new Error('injected descriptor failure')
      }
      return Reflect.defineProperty(object, name, descriptor)
    },
  })
  const seam = createExecutionSeam(service, EXECUTION_SEAM_SERVICE)

  assert.throws(() => seam.takeOver(() => Promise.resolve({ logs: [] })), /injected descriptor failure/)
  assert.equal(target.run, replacement)
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

test('normalizes asynchronous activation to a valid injected effect', async () => {
  const service = { language: 'typescript', run() {} }
  let injectedResult
  const ctx = {
    get: name => name === 'codeRuntime' ? service : undefined,
    inject(names, callback) {
      if (names.includes('codeRuntime')) injectedResult = callback({ codeRuntime: service })
      return () => {}
    },
    effect() {},
  }
  const activation = Promise.resolve({ status: 'applied' })
  assert.equal(await installExecutionSeam(ctx, { attach: () => activation }), undefined)
  assert.equal(await injectedResult, undefined)
})

test('returns a valid effect through the official Cordis plugin lifecycle', async (t) => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  root.provide('codeRuntime', { language: 'typescript', run() {} })
  const fiber = root.plugin({
    apply(ctx) {
      return installExecutionSeam(ctx, {
        attach: () => Promise.resolve({ status: 'applied' }),
      })
    },
  })
  await fiber.await()
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

test('settles with a diagnostic when the deployment never registers a seam', async () => {
  const host = seamHost()
  // A deployment without a code runtime cannot be served, and its activation
  // promise must settle: the host awaits loader settlement before it starts.
  await assert.rejects(
    installExecutionSeam(host.ctx, {
      services: CORE_SERVICES,
      attach: () => undefined,
      attachmentTimeoutMs: 20,
    }),
    /no host execution seam \(ptcRuntime or codeRuntime\) is registered/,
  )
})

test('an unbounded wait still attaches to a seam that appears later', async () => {
  const host = seamHost()
  const attached = []
  const activation = installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (scope, seam) => attached.push(seam.serviceName),
    attachmentTimeoutMs: 0,
  })
  host.provide('codeRuntime', { language: 'typescript', run() {} })
  assert.deepEqual(attached, ['codeRuntime'])
  assert.equal(await activation, undefined)
})

test('prefers the current generation when a host registers both', () => {
  const host = seamHost()
  host.provide('codeRuntime', { language: 'typescript', run() {} })
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  const attached = []
  installExecutionSeam(host.ctx, { services: CORE_SERVICES, attach: (scope, seam) => attached.push(seam.serviceName) })
  assert.deepEqual(attached, ['ptcRuntime'])
})

test('a later current generation supersedes and disposes the live legacy scope', async () => {
  const legacy = { language: 'typescript', run() {} }
  const current = { language: 'typescript', resolve: request => request, run() {} }
  const host = seamHost({ codeRuntime: legacy })
  const attached = []
  const released = []
  await installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (scope, seam) => {
      attached.push(seam.serviceName)
      scope.effect(() => () => released.push(seam.serviceName))
      return seam.serviceName
    },
  })
  assert.deepEqual(attached, ['codeRuntime'])

  host.provide('ptcRuntime', current)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime'])
  assert.deepEqual(released, ['codeRuntime'])

  host.unprovide('ptcRuntime')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime', 'codeRuntime'])
  assert.deepEqual(released, ['codeRuntime', 'ptcRuntime'])

  host.provide('ptcRuntime', current)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime', 'codeRuntime', 'ptcRuntime'])
  assert.deepEqual(released, ['codeRuntime', 'ptcRuntime', 'codeRuntime'])
})

test('current-generation supersession reports missing and failed legacy disposal', async () => {
  let currentCallback
  let currentLive
  const services = {
    codeRuntime: { language: 'typescript', run() {} },
    ptcRuntime: { language: 'typescript', resolve: request => request, run() {} },
  }
  const ctx = {
    get: name => name === 'ptcRuntime' ? currentLive : services[name],
    inject(names, callback) {
      if (names.includes('ptcRuntime')) currentCallback = callback
      else callback({ codeRuntime: services.codeRuntime, core: {} })
      return () => {}
    },
  }
  await installExecutionSeam(ctx, { services: CORE_SERVICES, attach: () => 'legacy' })
  currentLive = services.ptcRuntime
  assert.throws(() => currentCallback({ ptcRuntime: services.ptcRuntime, core: {} }), /disposable injected scope/)

  const host = seamHost({ codeRuntime: services.codeRuntime })
  const attached = []
  await installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (_scope, seam) => attached.push(seam.serviceName),
  })
  host.failDispose('codeRuntime', new Error('legacy disposal failed'))
  host.provide('ptcRuntime', services.ptcRuntime)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(host.failures.at(-1).message, /legacy disposal failed/)
  assert.deepEqual(attached, ['codeRuntime'])

  host.failDispose('codeRuntime', undefined)
  host.provide('ptcRuntime', services.ptcRuntime)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime'])
  assert.equal(host.disposeAttempts.filter(names => names.includes('codeRuntime')).length, 2)
})

test('current-generation retries share one pending legacy retirement', async () => {
  const host = seamHost({ codeRuntime: { language: 'typescript', run() {} } })
  const attached = []
  let releaseRetirement
  const retirement = new Promise(resolve => { releaseRetirement = resolve })
  await installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (scope, seam) => {
      attached.push(seam.serviceName)
      if (seam.serviceName === 'codeRuntime') scope.effect(() => () => retirement)
      return seam.serviceName
    },
  })
  const current = { language: 'typescript', resolve: request => request, run() {} }
  host.provide('ptcRuntime', current)
  host.provide('ptcRuntime', current)
  assert.deepEqual(attached, ['codeRuntime'])
  assert.equal(host.disposeAttempts.filter(names => names.includes('codeRuntime')).length, 1)

  releaseRetirement()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime'])
  assert.equal(host.disposeAttempts.filter(names => names.includes('codeRuntime')).length, 1)
})

test('current-generation attach failure immediately restores the legacy attachment', async () => {
  const host = seamHost({ codeRuntime: { language: 'typescript', run() {} } })
  const failure = new Error('current attach failed')
  const attached = []
  let failCurrentAttach = true
  await installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (_scope, seam) => {
      attached.push(seam.serviceName)
      return seam.serviceName === 'ptcRuntime' && failCurrentAttach
        ? Promise.reject(failure)
        : seam.serviceName
    },
  })
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.failures.includes(failure), true)
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime', 'codeRuntime'])
  // The failed service object is never retried while it stays registered.
  const failed = host.services.ptcRuntime
  host.provide('ptcRuntime', failed)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime', 'codeRuntime'])
  // A replacement current service still supersedes the restored legacy seam.
  failCurrentAttach = false
  host.unprovide('ptcRuntime')
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime', 'codeRuntime', 'ptcRuntime'])
})

test('a failed current attach keeps the legacy seam through the official Cordis lifecycle', async (t) => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  root.provide('core', {})
  const legacy = {
    language: 'typescript',
    isolation: 'worker-thread',
    run() { return { logs: ['upstream'], value: 'upstream' } },
  }
  root.provide('codeRuntime', legacy)
  const attached = []
  const reported = []
  const fiber = root.plugin({
    apply(ctx) {
      return installExecutionSeam(ctx, {
        services: CORE_SERVICES,
        attach: (scope, seam) => {
          attached.push(seam.serviceName)
          if (seam.serviceName === 'ptcRuntime') throw new Error('incompatible current seam')
          const release = seam.takeOver(request => Promise.resolve({
            logs: ['plugin'],
            value: request.program,
          }))
          scope.effect(() => () => release())
          return release
        },
        reportFailure: error => reported.push(error.message),
      })
    },
  })
  await fiber.await()
  assert.deepEqual(attached, ['codeRuntime'])
  assert.deepEqual(await legacy.run({ program: 'legacy-live', bindings: [] }), {
    logs: ['plugin'],
    value: 'legacy-live',
  })

  const provider = root.plugin({
    apply(scope) {
      scope.provide('ptcRuntime', { language: 'typescript', run() {} })
    },
  })
  await provider.await()
  for (let index = 0; index < 20 && attached.length < 3; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(attached, ['codeRuntime', 'codeRuntime'])
  assert.deepEqual(reported, ['ptc-plus: ptcRuntime.resolve must be a function'])
  assert.deepEqual(await legacy.run({ program: 'still-live', bindings: [] }), {
    logs: ['plugin'],
    value: 'still-live',
  })

  await provider.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'codeRuntime'])
  assert.deepEqual(await legacy.run({ program: 'after-withdraw', bindings: [] }), {
    logs: ['plugin'],
    value: 'after-withdraw',
  })
})

test('a throwing seam-failure reporter cannot suppress legacy recovery', async () => {
  const host = seamHost({ codeRuntime: { language: 'typescript', run() {} } })
  const failure = new Error('current attach failed')
  const attached = []
  await installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (_scope, seam) => {
      attached.push(seam.serviceName)
      return seam.serviceName === 'ptcRuntime' ? Promise.reject(failure) : 'legacy'
    },
    reportFailure: () => { throw new Error('reporter failed') },
  })
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attached, ['codeRuntime', 'ptcRuntime', 'codeRuntime'])
  assert.equal(host.failures.includes(failure), true)
})

test('a failing legacy fallback watcher is reported beside the seam failure', async () => {
  const host = seamHost({ codeRuntime: { language: 'typescript', run() {} } })
  const failure = new Error('current attach failed')
  const fallbackFailure = new Error('legacy rearm failed')
  const reported = []
  await installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (_scope, seam) => (
      seam.serviceName === 'ptcRuntime' ? Promise.reject(failure) : 'legacy'
    ),
    reportFailure: error => { reported.push(error.message) },
  })
  const inject = host.ctx.inject
  host.ctx.inject = (names, callback) => {
    if (names.includes(LEGACY_EXECUTION_SEAM_SERVICE)) throw fallbackFailure
    return inject(names, callback)
  }
  host.provide('ptcRuntime', { language: 'typescript', resolve: request => request, run() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reported, ['legacy rearm failed', 'current attach failed'])
  assert.equal(host.failures.includes(failure), true)
})

test('does not restart a legacy watcher after the plugin lifecycle stops', async () => {
  const host = seamHost({
    codeRuntime: { language: 'typescript', run() {} },
    ptcRuntime: { language: 'typescript', resolve: request => request, run() {} },
  })
  const attached = []
  await installExecutionSeam(host.ctx, {
    services: CORE_SERVICES,
    attach: (_scope, seam) => attached.push(seam.serviceName),
  })
  assert.deepEqual(attached, ['ptcRuntime'])

  await host.stop()
  host.unprovide('ptcRuntime')
  await new Promise(resolve => setImmediate(resolve))
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
