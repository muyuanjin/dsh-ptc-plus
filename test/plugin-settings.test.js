import assert from 'node:assert/strict'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { apply, Config } from '../index.js'
import { CONFIG_FIELDS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import { resolveConfig } from '../internal/runtime-config.js'

const TEST_CORDIS_TOOL_NAMES = Object.freeze([
  'test_cordis_inspect',
  'test_cordis_run',
])
const CORDIS_PRESET_PATH = '/dsh/presets/cordis/cordis.yml'
const CORDIS_SKILL_DIRECTORY = join(dirname(CORDIS_PRESET_PATH), 'skills')

function errorMessages(error) {
  return error instanceof AggregateError
    ? error.errors.flatMap(errorMessages)
    : [error?.message]
}

function settingsScope(value) {
  let current = value
  const watchers = []
  const commit = next => {
    const previous = current
    current = next
    for (const callback of watchers) callback(current, previous)
  }
  return {
    get: () => current,
    watch: callback => {
      watchers.push(callback)
      return () => {}
    },
    set(next) {
      commit(next)
    },
    async update(patch) {
      commit({ ...current, ...patch })
    },
    watchers,
  }
}

function settingsContext(scope) {
  const context = {
    settings: {
      register: () => scope,
      update: (_namespace, patch) => scope.update(patch),
    },
    effect(register) {
      register()
    },
  }
  context.settings.installSection = (owner, _namespace, _schema, entry, hooks) => {
    const registered = context.settings.register()
    hooks.setSource(() => registered.get())
    context.effect(() => () => {
      if (owner.fiber.state === 4 || owner.fiber.state === 5) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    registered.watch(() => {
      if (owner.fiber.state === 4 || owner.fiber.state === 5) return
      hooks.onChange()
    })
  }
  return context
}

function hostContext(settings = undefined, agents = [], options = {}) {
  const listeners = new Map()
  const cleanups = []
  const sections = []
  const projectionDefinitions = []
  const projectionInjections = []
  const inheritedRun = async () => ({ logs: [] })
  const runtime = Object.assign(Object.create({ run: inheritedRun }), {
    language: options.language ?? 'typescript',
    isolation: 'worker-thread',
  })
  const definition = { name: 'run_code', output: {} }
  const ctx = {
    fiber: { state: 2 },
    agents: { list: () => agents },
    codeRuntime: runtime,
    tools: {
      get: () => definition,
      schemas: () => [],
      register: () => () => {},
    },
    systemPrompt: {
      section: value => {
        if (options.failPromptSection === true) throw new Error('prompt section unavailable')
        sections.push(value)
        return () => {
          const finish = () => {
            if (options.throwSectionDispose === true) throw new Error('prompt section disposal failed')
            sections.splice(sections.indexOf(value), 1)
          }
          options.onSectionDispose?.()
          return options.sectionDisposeGate === undefined
            ? finish()
            : Promise.resolve(options.sectionDisposeGate).then(finish)
        }
      },
      async assemble(context = {}) {
        const assembly = {
          sections: sections.map(section => ({
            name: section.name,
            text: typeof section.text === 'function' ? section.text(context) : section.text,
          })),
          contexts: [],
          tools: TEST_CORDIS_TOOL_NAMES
            .filter(name => context.scope?.definitions.has(name))
            .map(name => ({ name })),
          variables: {},
        }
        const entries = [...listeners.get('system-prompt/assemble') ?? []]
        const dispatch = index => entries[index]?.(
          assembly,
          context,
          () => dispatch(index + 1),
        ) ?? Promise.resolve(assembly)
        return dispatch(0)
      },
    },
    on(name, listener) {
      if (options.failHook === name) throw new Error(`hook unavailable: ${name}`)
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      return () => {
        entries.splice(entries.indexOf(listener), 1)
        if (entries.length === 0) listeners.delete(name)
      }
    },
    effect(register) {
      cleanups.push(register())
    },
    logger: {
      warnings: [],
      warn(message, error) { this.warnings.push([message, error]) },
    },
    ...(settings === undefined ? {} : {
      inject(services, callback) {
        if (services.length === 1 && services[0] === 'sessionProjections') {
          let disposed = false
          let childDisposers = []
          const unload = async () => {
            for (const dispose of childDisposers.reverse()) await dispose()
            childDisposers = []
          }
          const injection = {
            async activate() {
              await Promise.resolve()
              if (disposed) return
              callback({
                sessionProjections: {
                  register(definition) {
                    if (options.invalidProjectionDisposer === true) return undefined
                    projectionDefinitions.push(definition)
                    let registered = true
                    const unregister = () => {
                      if (!registered) return
                      registered = false
                      const index = projectionDefinitions.indexOf(definition)
                      if (index !== -1) projectionDefinitions.splice(index, 1)
                    }
                    childDisposers.push(unregister)
                    return unregister
                  },
                },
              })
            },
            async reload() {
              await unload()
              await this.activate()
            },
            async dispose() {
              if (disposed) return
              disposed = true
              await unload()
              const index = projectionInjections.indexOf(injection)
              if (index !== -1) projectionInjections.splice(index, 1)
            },
          }
          projectionInjections.push(injection)
          void injection.activate()
          return injection
        }
        assert.deepEqual(services, ['settings'])
        settings.fiber ??= { state: 2 }
        callback(settings)
      },
    }),
  }
  return {
    ctx,
    listeners,
    sections,
    cleanups,
    runtime,
    definition,
    projectionDefinitions,
    projectionInjections,
  }
}

function cordisAgent(disposeGate = undefined, options = {}) {
  const definitions = new Map([
    ['run_code', { name: 'run_code' }],
    ['skill', { name: 'skill' }],
  ])
  const skillCatalog = new Map()
  let pluginCalls = 0
  let skillPluginCalls = 0
  let disposeFailuresRemaining = options.disposeFailures ?? 0
  const agent = {
    id: 'settings-cordis-agent',
    definitions,
    session: { header: { cwd: '/workspace' } },
    ctx: {
      tools: {
        get: name => definitions.get(name),
      },
      get(name) {
        if (name === 'dynamicCordisRunner' || name === 'cordisInspect') return {}
        if (name === 'agentPresets') {
          return {
            resolve: async id => {
              assert.equal(id, 'cordis')
              return { id, trust: 'system', path: CORDIS_PRESET_PATH }
            },
          }
        }
        if (name === 'skills') {
          return {
            registerProvider() { return () => {} },
            list: async ({ scope }) => {
              assert.equal(scope, agent)
              return [...skillCatalog.values()].map(({ content: _content, ...summary }) => summary)
            },
            get: async (skillName, { scope }) => {
              assert.equal(scope, agent)
              return skillCatalog.get(skillName)
            },
          }
        }
      },
      plugin(plugin, config) {
        const skillFiber = plugin.name === 'skill-filesystem'
        if (skillFiber) skillPluginCalls += 1
        else pluginCalls += 1
        const activationIndex = pluginCalls - 1
        const activationError = skillFiber
          ? options.skillActivationError
          : options.activationErrors?.[activationIndex] ?? options.activationError
        const activationGate = skillFiber
          ? options.skillActivationGate
          : options.activationGates?.[activationIndex] ?? options.activationGate
        assert.equal(plugin.name, skillFiber ? 'skill-filesystem' : 'tool-cordis')
        if (skillFiber) {
          assert.deepEqual(config, {
            providerName: 'ptc-plus-cordis',
            includeDefaultRoots: false,
            customSkillDirs: [CORDIS_SKILL_DIRECTORY],
          })
        }
        let disposed = false
        const activate = () => {
          if (activationError !== undefined) throw activationError
          if (disposed || options.activate === false) return
          if (skillFiber) {
            skillCatalog.set('cordis-plugin-development', {
              name: 'cordis-plugin-development',
              provider: 'ptc-plus-cordis',
              invocation: { modelInvocable: true, userInvocable: true },
              content: '# Cordis plugin development',
            })
          } else {
            for (const name of TEST_CORDIS_TOOL_NAMES) definitions.set(name, { name })
          }
        }
        const activation = activationGate === undefined
          ? (activate(), undefined)
          : Promise.resolve(activationGate).then(activate)
        const fiber = {
          inject: skillFiber
            ? { skills: null }
            : { dynamicCordisRunner: null, cordisInspect: null },
          async dispose() {
            disposed = true
            if (options.disposeWithoutActivation !== true) {
              try {
                await activation
              } catch {}
            }
            if (disposeGate !== undefined) await disposeGate
            if (skillFiber) skillCatalog.delete('cordis-plugin-development')
            else for (const name of TEST_CORDIS_TOOL_NAMES) definitions.delete(name)
            if (!skillFiber && (options.throwDispose === true || disposeFailuresRemaining > 0)) {
              if (disposeFailuresRemaining > 0) disposeFailuresRemaining -= 1
              throw new Error('Cordis disposal failed')
            }
          },
        }
        if (activation !== undefined) {
          fiber.then = (onFulfilled, onRejected) => activation.then(onFulfilled, onRejected)
        }
        return fiber
      },
    },
  }
  return {
    agent,
    definitions,
    skillCatalog,
    get pluginCalls() {
      return pluginCalls
    },
    get skillPluginCalls() {
      return skillPluginCalls
    },
  }
}

async function openSessionWorker(host, agent) {
  const exec = { name: 'run_code', callId: 'settings-worker', agent }
  const result = await host.listeners.get('tools/execute')[0](exec, async () => {
    const raw = await host.runtime.run({ program: 'return 1', bindings: [] })
    return {
      isError: raw.error !== undefined,
      content: [],
      ...(raw.error === undefined ? { value: raw.value } : { error: raw.error }),
      meta: host.definition.output.presentationMeta?.({}, raw.value),
    }
  })
  for (const listener of host.listeners.get('tools/result') ?? []) await listener(exec, result)
  assert.equal(result.isError, false)
}

test('settings kill switch leaves no runtime side effects when disabled', async () => {
  const scope = settingsScope({ enabled: false })
  const {
    ctx,
    listeners,
    sections,
    cleanups,
    runtime,
    projectionDefinitions,
    projectionInjections,
  } = hostContext(settingsContext(scope))
  apply(ctx)
  assert.deepEqual(projectionDefinitions, [])
  assert.deepEqual(projectionInjections, [])
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('degrades an incompatible session projection without disabling the runtime', async () => {
  const scope = settingsScope({ enabled: true })
  const host = hostContext(
    settingsContext(scope),
    [],
    { invalidProjectionDisposer: true },
  )
  assert.doesNotThrow(() => apply(host.ctx))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, true)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.ok(host.listeners.has('tools/execute'))
  assert.ok(host.sections.some(section => section.name === 'tools:ptc-plus-repl'))
  assert.deepEqual(host.projectionDefinitions, [])
  assert.equal(host.projectionInjections.length, 1)
  assert.match(
    String(host.ctx.logger.warnings[0]?.[1]?.message),
    /sessionProjections\.register did not return a disposer/,
  )
  for (const cleanup of host.cleanups.reverse()) await cleanup()
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.deepEqual(host.projectionInjections, [])
})

test('handles projection registration through the real asynchronous Cordis inject fiber', async (t) => {
  const cordis = new CordisContext()
  t.after(() => cordis.fiber.dispose())
  let registerCalls = 0
  const removeProjectionService = cordis.provide('sessionProjections', {
    register() {
      registerCalls += 1
      return undefined
    },
  })
  t.after(removeProjectionService)
  const host = hostContext()
  host.ctx.inject = cordis.inject.bind(cordis)

  const activation = apply(host.ctx)
  assert.equal(registerCalls, 0)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  await activation
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(registerCalls, 1)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.ok(host.listeners.has('tools/execute'))
  assert.match(
    String(host.ctx.logger.warnings[0]?.[1]?.message),
    /sessionProjections\.register did not return a disposer/,
  )

  for (const cleanup of host.cleanups.reverse()) await cleanup()
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
})

test('disabled settings can load on hosts without a TypeScript runtime', async () => {
  const scope = settingsScope({ enabled: false })
  const { ctx, listeners, sections, cleanups, runtime } = hostContext(
    settingsContext(scope),
    [],
    { language: 'python' },
  )

  assert.doesNotThrow(() => apply(ctx))
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)

  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(ctx.logger.warnings.length > 0, true)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('settings kill switch installs and removes the runtime live', async () => {
  const scope = settingsScope({
    enabled: true,
    durableReplay: false,
    autoRewriteImports: true,
    autoStripExports: true,
    autoSplitRedeclarations: true,
    looseTopLevelRedeclarations: true,
    canonicalizeToolCalls: true,
    tipsEnabled: true,
    tipCooldownMessages: 3,
    tipEscalationFailures: 2,
  })
  const {
    ctx,
    listeners,
    sections,
    cleanups,
    runtime,
    projectionDefinitions,
    projectionInjections,
  } = hostContext(settingsContext(scope))
  apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(projectionDefinitions.map(definition => definition.key), ['ptcPlusRepl'])
  assert.equal(projectionInjections.length, 1)
  await projectionInjections[0].reload()
  assert.deepEqual(projectionDefinitions.map(definition => definition.key), ['ptcPlusRepl'])
  assert.equal(projectionInjections.length, 1)
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  assert.ok(listeners.has('tools/execute'))
  assert.ok(sections.some(section => section.name === 'tools:ptc-plus-repl'))

  scope.set({ ...scope.get(), enabled: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)
  assert.deepEqual(projectionDefinitions, [])
  assert.deepEqual(projectionInjections, [])

  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  assert.ok(listeners.has('tools/execute'))
  assert.deepEqual(projectionDefinitions.map(definition => definition.key), ['ptcPlusRepl'])
  assert.equal(projectionInjections.length, 1)

  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.deepEqual(projectionDefinitions, [])
  assert.deepEqual(projectionInjections, [])
})

test('late settings mount reconciles and detaches against composition config', async () => {
  const { ctx, listeners, sections, cleanups, runtime } = hostContext()
  let injectSettings
  ctx.inject = (services, callback) => {
    if (services.length === 1 && services[0] === 'sessionProjections') return
    assert.deepEqual(services, ['settings'])
    injectSettings = callback
  }
  apply(ctx)
  assert.equal(Object.hasOwn(runtime, 'run'), true)

  const scope = settingsScope({ enabled: false })
  let detach
  const settings = settingsContext(scope)
  settings.fiber = { state: 2 }
  settings.effect = (register) => { detach = register() }
  injectSettings(settings)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.equal(listeners.size, 0)
  assert.equal(sections.length, 0)

  detach()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('late settings hydration applies persisted non-enabled configuration', async () => {
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(undefined, [agent])
  let injectSettings
  ctx.inject = (services, callback) => {
    if (services.length === 1 && services[0] === 'sessionProjections') return
    injectSettings = callback
  }
  apply(ctx)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)

  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const settings = settingsContext(scope)
  settings.fiber = { state: 2 }
  settings.effect = register => register()
  injectSettings(settings)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('startup settings mount Cordis tools before the first PTC request', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const { agent, definitions, skillCatalog } = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(assembly.tools.map(tool => tool.name), TEST_CORDIS_TOOL_NAMES)
  assert.deepEqual(TEST_CORDIS_TOOL_NAMES.filter(name => definitions.has(name)), TEST_CORDIS_TOOL_NAMES)
  assert.equal(skillCatalog.has('cordis-plugin-development'), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)
  assert.equal(skillCatalog.has('cordis-plugin-development'), false)
})

test('propagates asynchronous composition activation failure without settings', async () => {
  const cordis = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed without settings'),
  })
  const host = hostContext(undefined, [cordis.agent])

  await assert.rejects(
    apply(host.ctx, { cordisToolsEnabled: true }),
    /Cordis activation failed without settings/,
  )

  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('adds Cordis failed-cell binding reuse guidance only when Cordis is enabled', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const { agent } = cordisAgent()
  const host = hostContext(settingsContext(scope), [agent])
  apply(host.ctx)
  const guidance = host.sections.find(section => section.name === 'tools:ptc-plus-repl')?.text({})
  assert.match(guidance, /When using Cordis tools, keep large host or client source in a top-level binding before the Cordis call\./)
  assert.match(guidance, /bindings assigned before that failure remain live, so retry only the Cordis call with the existing binding instead of resending the source/)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('keeps disabled REPL guidance byte-stable without Cordis recovery text', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const host = hostContext(settingsContext(scope))
  apply(host.ctx)
  const guidance = host.sections.find(section => section.name === 'tools:ptc-plus-repl')?.text({})
  assert.equal(guidance.endsWith(' '), false)
  assert.doesNotMatch(guidance, /When using Cordis tools/)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('asynchronous initial Cordis failure rolls back the enabled setting', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const { agent, definitions } = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed'),
    activationGate,
  })
  const host = hostContext(settingsContext(scope), [agent])
  apply(host.ctx)

  assert.equal(scope.get().enabled, true)
  releaseActivation()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().enabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('does not let a stale initial Cordis failure disable newer settings', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed'),
    activationGate,
  })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))

  scope.set({ enabled: true, cordisToolsEnabled: false })
  releaseActivation()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(scope.get(), { enabled: true, cordisToolsEnabled: false })
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length, 0)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('failed activation rolls back every mount created before the failing hook', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [cordis.agent], {
    failPromptSection: true,
  })
  apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(cordis.pluginCalls, 1)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(Object.hasOwn(ctx.codeRuntime, 'run'), false)
  assert.equal(ctx.logger.warnings.length > 0, true)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('live enable failure is persisted as disabled and can recover after the host is restored', async () => {
  const scope = settingsScope({ enabled: false, cordisToolsEnabled: false })
  const host = hostContext(settingsContext(scope), [], { failPromptSection: true })
  apply(host.ctx)

  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)

  host.ctx.systemPrompt.section = value => {
    host.sections.push(value)
    return () => host.sections.splice(host.sections.indexOf(value), 1)
  }
  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, true)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)

  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('serializes a newer activation behind failed-install cleanup', async () => {
  let releaseTeardown
  const teardown = new Promise(resolve => { releaseTeardown = resolve })
  const scope = settingsScope({ enabled: false, cordisToolsEnabled: true })
  const options = { failPromptSection: true }
  const cordis = cordisAgent(teardown)
  const host = hostContext(settingsContext(scope), [cordis.agent], options)
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  options.failPromptSection = false
  scope.set({ enabled: true, cordisToolsEnabled: true, tipsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 1)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)

  releaseTeardown()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 2)
  assert.equal(scope.get().enabled, true)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('serializes a newer activation behind rejected-readiness cleanup', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  let releaseCleanup
  const sectionDisposeGate = new Promise(resolve => { releaseCleanup = resolve })
  let cleanupStarted
  const cleanupStart = new Promise(resolve => { cleanupStarted = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed'),
    activationGate,
  })
  const host = hostContext(settingsContext(scope), [cordis.agent], {
    sectionDisposeGate,
    onSectionDispose: cleanupStarted,
  })
  apply(host.ctx)

  releaseActivation()
  await cleanupStart
  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(host.sections.length, 1)
  assert.equal(cordis.pluginCalls, 1)

  releaseCleanup()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, true)
  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.equal(host.sections.length, 1)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('surfaces a settings rollback failure after activation cleanup', async () => {
  const scope = settingsScope({ enabled: false, cordisToolsEnabled: false })
  scope.update = async () => { throw new Error('settings offline') }
  const host = hostContext(settingsContext(scope), [], {
    failHook: 'llm/stream',
    throwSectionDispose: true,
  })
  apply(host.ctx)
  scope.set({ ...scope.get(), enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, true)
  assert.equal(host.ctx.logger.warnings.length >= 2, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('continues rollback after one owner disposer rejects', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [cordis.agent], {
    failHook: 'system-prompt/assemble',
    throwSectionDispose: true,
  })
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('contains rejecting owner disposal during a live disable', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    apply(host.ctx)
    scope.set({ enabled: false, cordisToolsEnabled: true })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(Object.hasOwn(host.runtime, 'run'), false)
    assert.equal(unhandled.length, 0)
    assert.equal(host.ctx.logger.warnings.length > 0, true)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    for (const cleanup of host.cleanups.reverse()) await cleanup()
  }
})

test('Cordis setting applies immediately across live kill-switch toggles', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  scope.set({ enabled: false, cordisToolsEnabled: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('reconfigures Cordis immediately while the runtime stays enabled', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)

  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('keeps Cordis and settings atomic when an active worker rejects reconfiguration', async () => {
  for (const initiallyEnabled of [false, true]) {
    const scope = settingsScope({
      enabled: true,
      cordisToolsEnabled: initiallyEnabled,
      maxOldGenerationSizeMb: 64,
    })
    const cordis = cordisAgent()
    const host = hostContext(settingsContext(scope), [cordis.agent])
    apply(host.ctx)
    await openSessionWorker(host, cordis.agent)

    scope.set({
      ...scope.get(),
      cordisToolsEnabled: !initiallyEnabled,
      maxOldGenerationSizeMb: 128,
    })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(scope.get().cordisToolsEnabled, initiallyEnabled)
    assert.equal(scope.get().maxOldGenerationSizeMb, 64)
    assert.equal(
      TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)),
      initiallyEnabled,
    )
    assert.equal(cordis.pluginCalls, initiallyEnabled ? 1 : 0)
    assert.equal(host.ctx.logger.warnings.length > 0, true)
    for (const cleanup of host.cleanups.reverse()) await cleanup()
  }
})

test('rolls back a failed live Cordis reconfiguration', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const agent = cordisAgent(undefined, { missingServices: true })
  agent.agent.ctx.get = () => undefined
  const host = hostContext(settingsContext(scope), [agent.agent])
  apply(host.ctx)
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.equal(host.ctx.logger.warnings.length > 0, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('rolls back an asynchronous live Cordis activation after clean disposal', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const cordis = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed'),
    activationGate,
  })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  releaseActivation()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('contains rejecting cleanup after asynchronous live Cordis activation fails', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const failing = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed'),
    activationGate,
  })
  const rejecting = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [failing.agent, rejecting.agent])
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  releaseActivation()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => failing.definitions.has(name)), false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => rejecting.definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)
  const messages = host.ctx.logger.warnings.flatMap(([, error]) => errorMessages(error))
  assert.equal(messages.includes('Cordis activation failed'), true)
  assert.equal(messages.includes('Cordis disposal failed'), true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('aggregates initial readiness and runtime owner cleanup failures', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed'),
    activationGate,
  })
  const host = hostContext(settingsContext(scope), [cordis.agent], { throwSectionDispose: true })
  apply(host.ctx)
  releaseActivation()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  const messages = host.ctx.logger.warnings.flatMap(([, error]) => errorMessages(error))
  assert.equal(messages.includes('Cordis activation failed'), true)
  assert.equal(messages.includes('prompt section disposal failed'), true)
  assert.equal(scope.get().enabled, false)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('fails closed when provisional Cordis activation cannot be disposed', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
})

test('restores a committed Cordis configuration after live disposal rejects', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { disposeFailures: 1 })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))

  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().cordisToolsEnabled, true)
  assert.equal(cordis.pluginCalls, 2)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('retains the committed Cordis owner when disposal and compensation both reject', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, {
    activationErrors: [undefined, new Error('Cordis compensation failed')],
    disposeFailures: 1,
  })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))

  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().cordisToolsEnabled, true, JSON.stringify(scope.get()))
  assert.equal(cordis.pluginCalls, 2)
  assert.equal(host.ctx.logger.warnings.length > 0, true)

  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 3)
  assert.equal(scope.get().cordisToolsEnabled, true)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), true)
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
})

test('surfaces a live configuration rollback write failure', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  scope.update = async () => { throw new Error('settings offline') }
  const agent = cordisAgent()
  agent.agent.ctx.get = () => undefined
  const host = hostContext(settingsContext(scope), [agent.agent])
  apply(host.ctx)
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.ctx.logger.warnings.length >= 2, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('does not roll back a newer live update after an older update fails', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { disposeFailures: 1 })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: false })
  scope.set({ enabled: true, cordisToolsEnabled: false, tipsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(scope.get().tipsEnabled, false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('serializes re-enable behind a pending Cordis teardown', async () => {
  let releaseTeardown
  const teardown = new Promise(resolve => { releaseTeardown = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(teardown)
  const { agent, definitions } = cordis
  const { ctx, cleanups } = hostContext(settingsContext(scope), [agent])
  apply(ctx)
  await ctx.systemPrompt.assemble({ scope: agent })

  assert.equal(cordis.pluginCalls, 1)
  assert.deepEqual(
    TEST_CORDIS_TOOL_NAMES.filter(name => definitions.has(name)),
    TEST_CORDIS_TOOL_NAMES,
  )

  scope.set({ enabled: false, cordisToolsEnabled: true })
  scope.set({ enabled: false, cordisToolsEnabled: true })
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 1)
  assert.deepEqual(
    TEST_CORDIS_TOOL_NAMES.filter(name => definitions.has(name)),
    TEST_CORDIS_TOOL_NAMES,
  )

  releaseTeardown()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 2)
  assert.deepEqual(
    TEST_CORDIS_TOOL_NAMES.filter(name => definitions.has(name)),
    TEST_CORDIS_TOOL_NAMES,
  )

  scope.set({ enabled: false, cordisToolsEnabled: true })
  scope.set({ enabled: true, cordisToolsEnabled: true })
  scope.set({ enabled: false, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 2)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => definitions.has(name)), false)

  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('rolls back a queued live enable when installation rejects asynchronously', async () => {
  let releaseTeardown
  const teardown = new Promise(resolve => { releaseTeardown = resolve })
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(teardown)
  const options = {}
  const host = hostContext(settingsContext(scope), [cordis.agent], options)
  apply(host.ctx)

  scope.set({ enabled: false, cordisToolsEnabled: true })
  options.failPromptSection = true
  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 1)

  releaseTeardown()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(host.ctx.logger.warnings.length > 0, true)

  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('disables and disposes while initial Cordis readiness never settles', async () => {
  const activationGate = new Promise(() => {})
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { activationGate, disposeWithoutActivation: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)

  scope.set({ enabled: false, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  await Promise.all(host.cleanups.reverse().map(cleanup => cleanup()))
})

test('host disposal cancels initial Cordis readiness without a settings transition', async () => {
  const activationGate = new Promise(() => {})
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { activationGate, disposeWithoutActivation: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)

  await Promise.all(host.cleanups.reverse().map(cleanup => cleanup()))
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(host.listeners.size, 0)
  assert.equal(host.sections.length, 0)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
})

test('disables a never-ready provisional Cordis owner during live reconfiguration', async () => {
  const activationGate = new Promise(() => {})
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const cordis = cordisAgent(undefined, { activationGate, disposeWithoutActivation: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 1)
  scope.set({ enabled: true, cordisToolsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  await Promise.all(host.cleanups.reverse().map(cleanup => cleanup()))
})

test('host disposal cancels a never-ready live Cordis reconfiguration', async () => {
  const activationGate = new Promise(() => {})
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const cordis = cordisAgent(undefined, { activationGate, disposeWithoutActivation: true })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 1)
  await Promise.all(host.cleanups.reverse().map(cleanup => cleanup()))

  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(host.listeners.size, 0)
  assert.equal(host.sections.length, 0)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
})

test('rolls back consecutive failed Cordis updates to the committed configuration', async () => {
  let releaseFirstActivation
  const firstActivation = new Promise(resolve => { releaseFirstActivation = resolve })
  const scope = settingsScope({
    enabled: true,
    cordisToolsEnabled: false,
    durableReplay: true,
    tipsEnabled: true,
  })
  const cordis = cordisAgent(undefined, {
    activationErrors: [new Error('first Cordis activation failed'), new Error('second Cordis activation failed')],
    activationGates: [firstActivation, Promise.resolve()],
  })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))

  scope.set({ ...scope.get(), cordisToolsEnabled: true, durableReplay: false })
  scope.set({ ...scope.get(), cordisToolsEnabled: true, durableReplay: false, tipsEnabled: false })
  releaseFirstActivation()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 2)
  assert.equal(scope.get().enabled, true)
  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(scope.get().durableReplay, true)
  assert.equal(scope.get().tipsEnabled, true)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('config schema defaults expose the settings switches', async () => {
  const expectedOrder = [
    'enabled',
    'enhancedToolView',
    'canonicalizeToolCalls',
    'autoDescribeRunCode',
    'looseTopLevelRedeclarations',
    'autoRewriteImports',
    'autoStripExports',
    'autoSplitRedeclarations',
    'durableReplay',
    'tipsEnabled',
    'cordisToolsEnabled',
    'computeMs',
    'maxWallMs',
    'maxOldGenerationSizeMb',
    'maxNestedRunCodeDepth',
    'maxOutputBytes',
    'maxValueNodes',
    'maxValueEdges',
    'maxValueArrayLength',
    'maxValueBigIntDigits',
    'tipCooldownMessages',
    'tipEscalationFailures',
  ]
  assert.deepEqual(CONFIG_FIELDS.map(field => field.key), expectedOrder)
  const firstInteger = CONFIG_FIELDS.findIndex(field => field.type === 'integer')
  assert.ok(CONFIG_FIELDS.slice(0, firstInteger).every(field => field.type === 'boolean'))
  assert.ok(CONFIG_FIELDS.slice(firstInteger).every(field => field.type === 'integer'))

  const featuredSwitches = CONFIG_FIELDS.filter(field => [
    'enhancedToolView',
    'autoDescribeRunCode',
    'cordisToolsEnabled',
  ].includes(field.key))
  assert.deepEqual(
    featuredSwitches.map(field => field.key),
    ['enhancedToolView', 'autoDescribeRunCode', 'cordisToolsEnabled'],
  )
  const displayWidth = value => Array.from(value).reduce(
    (width, character) => width + (character.codePointAt(0) <= 0xff ? 1 : 2),
    0,
  )
  for (const property of ['label', 'labelEn', 'description', 'descriptionEn']) {
    const widths = featuredSwitches.map(field => displayWidth(field[property]))
    assert.ok(widths.every((width, index) => index === 0 || widths[index - 1] <= width))
  }
  const defaults = await Config['~standard'].validate({})
  assert.equal(defaults.value.enabled, true)
  assert.equal(defaults.value.enhancedToolView, true)
  assert.equal(defaults.value.autoDescribeRunCode, true)
  assert.equal(defaults.value.cordisToolsEnabled, false)
  const invalid = await Config['~standard'].validate({ enabled: 'yes' })
  assert.equal(invalid.issues[0].path[0], 'enabled')
  const ns = await Config['~standard'].validate({ enabled: false })
  assert.equal(ns.value.enabled, false)
  const native = await Config['~standard'].validate({ enhancedToolView: false })
  assert.equal(native.value.enhancedToolView, false)
  const autoDescribe = await Config['~standard'].validate({ autoDescribeRunCode: true })
  assert.equal(autoDescribe.value.autoDescribeRunCode, true)
  const cordis = await Config['~standard'].validate({ cordisToolsEnabled: true })
  assert.equal(cordis.value.cordisToolsEnabled, true)
})

test('runtime config rejects an invalid enabled value', () => {
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ enhancedToolView: 'yes' }), /enhancedToolView must be a boolean/)
  assert.throws(() => resolveConfig({ autoDescribeRunCode: 'yes' }), /autoDescribeRunCode must be a boolean/)
  assert.throws(() => resolveConfig({ cordisToolsEnabled: 'yes' }), /cordisToolsEnabled must be a boolean/)
})
