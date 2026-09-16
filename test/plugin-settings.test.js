import assert from 'node:assert/strict'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { apply, Config, inject } from '../index.js'
import { CONFIG_FIELDS, CONFIG_GROUPS, SETTINGS_NAMESPACE } from '../internal/config-spec.js'
import { resolveConfig } from '../internal/runtime-config.js'
import { executionPolicies } from '../internal/binding-update-policy.js'
import { Session } from '@deepseek-ai/dsh-session'
import { readRuntimeMessage, runtimeStateMessage } from '../internal/runtime-messages.js'
import { createHostContext, describeSections, runHookChain } from './host-fixture.js'

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
  const host = createHostContext()
  const { listeners, cleanups, sections, contexts } = host
  const projectionDefinitions = []
  const projectionInjections = []
  const inheritedRun = async () => ({ logs: [] })
  const runtime = Object.assign(Object.create({ run: inheritedRun }), {
    language: options.language ?? 'typescript',
    isolation: 'worker-thread',
  })
  const definition = { name: 'run_code', output: {} }
  const on = options.failHook === undefined
    ? host.ctx.on
    : (name, listener, registrationOptions) => {
        if (options.failHook === name) throw options.hookError ?? new Error(`hook unavailable: ${name}`)
        return host.ctx.on(name, listener, registrationOptions)
      }
  const section = value => {
    if (options.failPromptSection === true) throw new Error('prompt section unavailable')
    const dispose = host.ctx.systemPrompt.section(value)
    return () => {
      const finish = () => {
        if ((options.sectionDisposeFailures ?? 0) > 0) {
          options.sectionDisposeFailures -= 1
          throw new Error('prompt section disposal failed')
        }
        if (options.throwSectionDispose === true) throw new Error('prompt section disposal failed')
        return dispose()
      }
      options.onSectionDispose?.()
      return options.sectionDisposeGate === undefined
        ? finish()
        : Promise.resolve(options.sectionDisposeGate).then(finish)
    }
  }
  const ctx = {
    fiber: { state: 2 },
    agents: { list: () => agents },
    codeRuntime: runtime,
    tools: {
      get: () => definition,
      schemas: () => [],
      register: host.ctx.tools.register,
    },
    systemPrompt: {
      context: host.ctx.systemPrompt.context,
      section,
      async assemble(context = {}) {
        const assembly = {
          sections: describeSections(sections, context),
          contexts: [...contexts],
          tools: TEST_CORDIS_TOOL_NAMES
            .filter(name => context.scope?.definitions.has(name))
            .map(name => ({ name })),
          variables: {},
        }
        const entries = [...listeners.get('system-prompt/assemble') ?? []]
        return runHookChain(entries, [assembly, context], () => Promise.resolve(assembly))
      },
    },
    on,
    effect: host.ctx.effect,
    logger: {
      warnings: [],
      warn(message, error) { this.warnings.push([message, error]) },
    },
    ...(settings === undefined ? {
      inject(names, callback) {
        if (names.includes('codeRuntime')) callback(ctx)
        return () => {}
      },
    } : {
      inject(services, callback) {
        if (services.includes('ptcRuntime')) return () => {}
        if (services.includes('codeRuntime')) {
          callback(ctx)
          return () => {}
        }
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
              const childScope = {
                sessionProjections: {
                  register(definition) {
                    if (options.invalidProjectionDisposer === true
                      || (options.invalidDraftProjectionDisposer === true
                        && definition.key === 'ptcPlusBindingDraft')) return undefined
                    projectionDefinitions.push(definition)
                    let registered = true
                    let unregistering
                    const unregister = () => {
                      if (!registered) return
                      if (unregistering !== undefined) return unregistering
                      if (definition.key === 'ptcPlusBindingDraft') {
                        options.onDraftProjectionDispose?.()
                      }
                      const finish = () => {
                        if (definition.key !== 'ptcPlusBindingDraft') {
                          registered = false
                          const index = projectionDefinitions.indexOf(definition)
                          if (index !== -1) projectionDefinitions.splice(index, 1)
                          return
                        }
                        if ((options.draftProjectionDisposeFailures ?? 0) > 0) {
                          options.draftProjectionDisposeFailures -= 1
                          throw new Error('draft projection disposal failed')
                        }
                        registered = false
                        const index = projectionDefinitions.indexOf(definition)
                        if (index !== -1) projectionDefinitions.splice(index, 1)
                      }
                      const result = definition.key === 'ptcPlusBindingDraft'
                        && options.draftProjectionDisposeGate !== undefined
                        ? Promise.resolve(options.draftProjectionDisposeGate).then(finish)
                        : finish()
                      if (result === undefined || typeof result?.then !== 'function') return result
                      const operation = Promise.resolve(result)
                      unregistering = operation
                      operation.then(
                        () => { if (unregistering === operation) unregistering = undefined },
                        () => { if (unregistering === operation) unregistering = undefined },
                      )
                      return operation
                    }
                    childDisposers.push(unregister)
                    return unregister
                  },
                },
                effect(register) {
                  const dispose = register()
                  childDisposers.push(dispose)
                  return dispose
                },
              }
              callback(childScope)
            },
            suspend: unload,
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
        if (services.length === 1 && services[0] === 'ptcPlusRpc') {
          callback({ ptcPlusRpc: { register: () => () => {} } })
          return () => {}
        }
        if (services.length === 1 && services[0] === 'tools') {
          const childDisposers = []
          callback({
            tools: ctx.tools,
            on(name, listener) {
              const dispose = ctx.on(name, listener)
              childDisposers.push(dispose)
              return dispose
            },
          })
          return async () => {
            for (const dispose of childDisposers.reverse()) await dispose()
          }
        }
        if (services[0] === 'typert') return () => {}
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
    contexts,
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
  let disposeCalls = 0
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
            if (!skillFiber) disposeCalls += 1
            options.onDisposeStart?.(skillFiber)
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
    get disposeCalls() {
      return disposeCalls
    },
  }
}

async function openSessionWorker(host, agent, program = 'return 1') {
  const exec = { name: 'run_code', callId: 'settings-worker', agent }
  const result = await host.listeners.get('tools/execute')[0](exec, async () => {
    const raw = await host.runtime.run({ program, bindings: [] })
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

function bindingCommandAgent(options = {}) {
  let command
  let draftTool
  const messages = []
  let commandDisposeFailures = options.commandDisposeFailures ?? 0
  const events = []
  const agent = {
    id: 'settings-binding-agent',
    session: {
      id: 'settings-binding-session',
      header: { cwd: '/workspace' },
      append(type, data) { events.push({ type, data }) },
    },
    inject() {},
    steer(message) { messages.push(message) },
    ctx: {
      inject(services, callback) {
        const disposers = []
        const child = {}
        for (const service of services) {
          if (service === 'commands') {
            child.commands = {
              register(definition) {
                if (options.throwCommandRegister === true) {
                  throw new Error('binding command registration failed')
                }
                command = definition
                const dispose = async () => {
                  if (command === definition) command = undefined
                  if (commandDisposeFailures > 0) {
                    commandDisposeFailures -= 1
                    throw new Error('binding command disposal failed')
                  }
                }
                return dispose
              },
            }
          } else if (service === 'skills') {
            child.skills = { register: () => () => {} }
          } else if (service === 'tools') {
            child.tools = {
              register(definition) {
                draftTool = definition
                return () => { if (draftTool === definition) draftTool = undefined }
              },
            }
          }
        }
        child.effect = register => {
          const dispose = register()
          disposers.push(dispose)
          return dispose
        }
        callback(child)
        let active = true
        return {
          async dispose() {
            if (!active) return
            active = false
            for (const dispose of disposers.reverse()) await dispose()
          },
        }
      },
      effect(register) {
        const dispose = register()
        let active = true
        return async () => {
          if (!active) return
          active = false
          await dispose?.()
        }
      },
      commands: {
        register(definition) {
          if (options.throwCommandRegister === true) {
            throw new Error('binding command registration failed')
          }
          command = definition
          return async () => {
            if (command === definition) command = undefined
            if (commandDisposeFailures > 0) {
              commandDisposeFailures -= 1
              throw new Error('binding command disposal failed')
            }
          }
        },
      },
      tools: {
        register: () => () => {},
        presentAs: () => () => {},
      },
    },
  }
  return {
    agent,
    events,
    messages,
    get command() { return command },
    get draftTool() { return draftTool },
  }
}

async function assemblePtc(host, agent, signal) {
  const assembly = {
    sections: [{ name: 'tools:ptc-only', text: 'PTC mode' }],
    contexts: [...host.contexts],
    tools: [{
      name: 'run_code',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
        },
      },
    }],
    variables: {},
  }
  const entries = host.listeners.get('system-prompt/assemble')
  const context = { agent, scope: agent, signal }
  return runHookChain(entries, [assembly, context], () => Promise.resolve(assembly))
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
  assert.deepEqual([...listeners.keys()].sort(), ['agent/disposed', 'agent/pre-step', 'system-prompt/assemble'])
  assert.equal(sections.length, 0)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('plugin disable clears committed declarations and re-enable reconciles current facts', async t => {
  const scope = settingsScope({ enabled: true })
  const host = hostContext(settingsContext(scope))
  apply(host.ctx)
  t.after(async () => { for (const cleanup of host.cleanups.reverse()) await cleanup() })
  const agent = bindingCommandAgent().agent
  agent.session = Session.create('settings-message-lifecycle')
  const append = message => agent.session.append('user/message', message, { surfaceOp: 'append' })
  append(runtimeStateMessage([{ name: 'tools:ptc-plus-user-bindings', text: 'Earlier activated helper.' }]))
  async function step() {
    const signal = new AbortController().signal
    if (scope.get().enabled) await assemblePtc(host, agent, signal)
    else await host.ctx.systemPrompt.assemble({ agent, signal })
    const entries = [...host.listeners.get('agent/pre-step') ?? []]
    const dispatch = index => entries[index] === undefined
      ? Promise.resolve({ kind: 'enter', messages: [] })
      : entries[index]({ agent, signal }, () => dispatch(index + 1))
    const { messages } = await dispatch(0)
    messages.forEach(append)
    return messages.map(readRuntimeMessage)
  }
  scope.set({ enabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.deepEqual(await step(), [{ form: 'snapshot', sections: [] }])
  assert.deepEqual(await step(), [])
  scope.set({ enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)
  assert.deepEqual(await step(), [])
  agent.session.append('turn/start', {})
  agent.session.append('tool/call', { callId: 'rewrite', name: 'run_code', arguments: '{"code":"export const value = 1"}' })
  agent.session.append('tool/result', { message: { source: { callId: 'rewrite' } }, meta: {
    dshPtcPlusRewrites: [{ kind: 'export', description: 'export modifier removed' }],
  } }, { surfaceOp: 'append' })
  const current = await step()
  assert.equal(current.length, 1)
  assert.deepEqual(current[0].sections.map(section => section.name), ['tools:ptc-plus-rewrite-info'])
  assert.deepEqual(await step(), [])
  scope.set({ enabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await step(), [{ form: 'snapshot', sections: [] }])
})

test('degrades an incompatible session projection and releases its callable injection', async () => {
  const scope = settingsScope({ enabled: true })
  const host = hostContext(
    settingsContext(scope),
    [],
    { invalidProjectionDisposer: true },
  )
  const injectService = host.ctx.inject.bind(host.ctx)
  host.ctx.inject = (services, callback) => {
    const injection = injectService(services, callback)
    return services.length === 1 && services[0] === 'sessionProjections'
      ? () => injection.dispose()
      : injection
  }
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

test('binds the session binding command to live draft projection availability', async () => {
  const unavailableAgent = bindingCommandAgent()
  const unavailable = hostContext(
    settingsContext(settingsScope({ enabled: true, userBindingsEnabled: true })),
    [unavailableAgent.agent],
    { invalidDraftProjectionDisposer: true },
  )
  apply(unavailable.ctx)
  await new Promise(resolve => setImmediate(resolve))
  await assemblePtc(unavailable, unavailableAgent.agent)
  assert.deepEqual(
    unavailable.projectionDefinitions.map(definition => definition.key),
    ['ptcPlusRepl'],
  )
  assert.equal(unavailableAgent.command, undefined)
  assert.equal(Object.hasOwn(unavailable.runtime, 'run'), true)
  assert.ok(unavailable.listeners.has('tools/execute'))
  for (const cleanup of unavailable.cleanups.reverse()) await cleanup()

  const availableAgent = bindingCommandAgent()
  const available = hostContext(
    settingsContext(settingsScope({ enabled: true, userBindingsEnabled: true })),
    [availableAgent.agent],
  )
  apply(available.ctx)
  await new Promise(resolve => setImmediate(resolve))
  await assemblePtc(available, availableAgent.agent)
  assert.equal(availableAgent.command?.name, 'binding')
  assert.deepEqual(
    available.projectionDefinitions.map(definition => definition.key),
    ['ptcPlusRepl', 'ptcPlusBindingDraft'],
  )

  await available.projectionInjections[0].suspend()
  assert.equal(availableAgent.command, undefined)
  assert.deepEqual(available.projectionDefinitions, [])
  assert.equal(Object.hasOwn(available.runtime, 'run'), true)
  assert.ok(available.listeners.has('tools/execute'))

  await available.projectionInjections[0].activate()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(availableAgent.command?.name, 'binding')
  assert.deepEqual(
    available.projectionDefinitions.map(definition => definition.key),
    ['ptcPlusRepl', 'ptcPlusBindingDraft'],
  )
  for (const cleanup of available.cleanups.reverse()) await cleanup()
})

test('invalidates a draft during Agent cleanup without appending presentation events', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ptc-plus-settings-bindings-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  const binding = bindingCommandAgent()
  const host = hostContext(
    settingsContext(settingsScope({ enabled: true, userBindingsEnabled: true })),
    [binding.agent],
  )
  apply(host.ctx)
  t.after(async () => {
    for (const cleanup of host.cleanups.reverse()) await cleanup()
  })
  await new Promise(resolve => setImmediate(resolve))
  await assemblePtc(host, binding.agent)
  const commandResult = binding.command.handler({
    agent: binding.agent,
    rawInput: 'new integration reset helper',
    signal: new AbortController().signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await commandResult).kind, 'success')
  const requestId = JSON.parse(/requestId: ("[^"\n]+")/.exec(binding.messages.at(-1).content[0].text)[1])
  await openSessionWorker(host, binding.agent, `return code.submitBindingDraft(${JSON.stringify({ requestId, entry: {
    id: 'integration-reset',
    name: 'integrationReset',
    scope: 'namespace',
    purpose: '',
    source: 'export const value = 1',
  } })})`)

  for (const listener of [...host.listeners.get('agent/disposed') ?? []]) {
    await listener({ agent: binding.agent })
  }
  assert.deepEqual(binding.events, [])
})

test('contains binding command registration and projection cleanup failures', async () => {
  const registrationOptions = { invalidDraftProjectionDisposer: true }
  const registrationAgent = bindingCommandAgent({ throwCommandRegister: true })
  const registrationHost = hostContext(
    settingsContext(settingsScope({ enabled: true, userBindingsEnabled: true })),
    [registrationAgent.agent],
    registrationOptions,
  )
  apply(registrationHost.ctx)
  await new Promise(resolve => setImmediate(resolve))
  await assemblePtc(registrationHost, registrationAgent.agent)
  registrationOptions.invalidDraftProjectionDisposer = false
  await registrationHost.projectionInjections[0].reload()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registrationAgent.command, undefined)
  assert.deepEqual(
    registrationHost.projectionDefinitions.map(definition => definition.key),
    ['ptcPlusRepl'],
  )
  assert.ok(registrationHost.ctx.logger.warnings.some(([message, error]) => (
    message === 'ptc-plus: binding draft projection unavailable'
      && error?.message === 'binding command registration failed'
  )))
  for (const cleanup of registrationHost.cleanups.reverse()) await cleanup()

  const cleanupAgent = bindingCommandAgent({ commandDisposeFailures: 1 })
  const cleanupHost = hostContext(
    settingsContext(settingsScope({ enabled: true, userBindingsEnabled: true })),
    [cleanupAgent.agent],
  )
  apply(cleanupHost.ctx)
  await new Promise(resolve => setImmediate(resolve))
  await assemblePtc(cleanupHost, cleanupAgent.agent)
  await assert.rejects(
    cleanupHost.projectionInjections[0].suspend(),
    error => error instanceof AggregateError
      && error.message === 'ptc-plus: binding draft projection cleanup failed'
      && error.errors.some(cause => (
        cause instanceof AggregateError
          && cause.message === 'Global User Bindings command projection cleanup failed'
      )),
  )
  assert.equal(cleanupAgent.command, undefined)
  assert.equal(Object.hasOwn(cleanupHost.runtime, 'run'), true)
  for (const cleanup of cleanupHost.cleanups.reverse()) await cleanup()
})

test('retries draft projection unregister before reloading its injected service', async () => {
  let draftDisposals = 0
  const options = {
    draftProjectionDisposeFailures: 1,
    onDraftProjectionDispose: () => { draftDisposals += 1 },
  }
  const scope = settingsScope({ enabled: true, userBindingsEnabled: true })
  const host = hostContext(
    settingsContext(scope),
    [],
    options,
  )
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.projectionDefinitions.map(definition => definition.key).sort(), [
    'ptcPlusBindingDraft',
    'ptcPlusRepl',
  ])

  await assert.rejects(
    host.projectionInjections[0].suspend(),
    error => error instanceof AggregateError
      && error.errors.some(cause => cause.message === 'draft projection disposal failed'),
  )
  assert.equal(draftDisposals, 1)
  assert.equal(host.projectionDefinitions.some(definition => definition.key === 'ptcPlusBindingDraft'), true)

  await host.projectionInjections[0].suspend()
  assert.equal(draftDisposals, 2)
  assert.deepEqual(host.projectionDefinitions, [])
  await host.projectionInjections[0].reload()
  assert.deepEqual(host.projectionDefinitions.map(definition => definition.key).sort(), [
    'ptcPlusBindingDraft',
    'ptcPlusRepl',
  ])

  const gate = Promise.withResolvers()
  options.draftProjectionDisposeGate = gate.promise
  scope.set({ ...scope.get(), enabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(draftDisposals, 3)
  gate.resolve()
  for (let index = 0; index < 4; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.projectionDefinitions, [])
  options.draftProjectionDisposeGate = undefined
  scope.set({ ...scope.get(), enabled: true })
  for (let index = 0; index < 4; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.projectionDefinitions.map(definition => definition.key).sort(), [
    'ptcPlusBindingDraft',
    'ptcPlusRepl',
  ])

  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
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
  // Only the projection injection needs the real Cordis fiber; the execution
  // seam belongs to this mock host, which registers it as a plain service.
  const mockInject = host.ctx.inject
  host.ctx.inject = (names, callback) => (names[0] === 'sessionProjections'
    ? cordis.inject(names, callback)
    : mockInject(names, callback))

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
  assert.deepEqual([...listeners.keys()].sort(), ['agent/disposed', 'agent/pre-step', 'system-prompt/assemble'])
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

  scope.set({ ...scope.get(), userBindingsEnabled: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(projectionDefinitions.map(definition => definition.key), [
    'ptcPlusRepl', 'ptcPlusBindingDraft',
  ])
  scope.set({ ...scope.get(), userBindingsEnabled: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(projectionDefinitions.map(definition => definition.key), ['ptcPlusRepl'])

  scope.set({ ...scope.get(), enabled: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), false)
  assert.deepEqual([...listeners.keys()].sort(), ['agent/disposed', 'agent/pre-step', 'system-prompt/assemble'])
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
    if (services.length === 1 && ['sessionProjections', 'ptcPlusRpc', 'typert', 'ptcRuntime'].includes(services[0])) return
    if (services.includes('ptcRuntime')) return
    if (services.includes('codeRuntime')) {
      callback(ctx)
      return
    }
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
  assert.deepEqual([...listeners.keys()].sort(), ['agent/disposed', 'agent/pre-step', 'system-prompt/assemble'])
  assert.equal(sections.length, 0)

  detach()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(Object.hasOwn(runtime, 'run'), true)
  for (const cleanup of cleanups.reverse()) await cleanup()
})

test('Host schema and settings hydration preserve omitted new policy during migration', async () => {
  const cases = [
    [{}, 'stateful-v1'],
    [{ looseTopLevelRedeclarations: false }, 'legacy-v1'],
    [{ autoRewriteImports: false }, 'legacy-v1'],
    [{ looseTopLevelRedeclarations: false, looseTopLevelFunctionClassRedeclarations: false,
      autoSplitRedeclarations: false }, 'protected-v1'],
    [{ autoRewriteImports: false, bindingUpdates: 'stateful' }, 'stateful-v1'],
  ]
  for (const [raw, expected] of cases) {
    const validated = await Config['~standard'].validate(raw)
    assert.equal(validated.issues, undefined)
    assert.equal(Object.hasOwn(validated.value, 'bindingUpdates'), Object.hasOwn(raw, 'bindingUpdates'))
    assert.equal(executionPolicies(resolveConfig(validated.value)).languageSemantics, expected)
    const scope = settingsScope(validated.value)
    const { ctx, sections, cleanups } = hostContext(settingsContext(scope))
    try {
      await apply(ctx, (await Config['~standard'].validate({})).value)
      const text = describeSections(sections).map(section => section.text).join('\n')
      if (expected === 'protected-v1') assert.match(text, /protect|read.only/i)
      if (raw.autoRewriteImports === false && expected === 'legacy-v1') assert.doesNotMatch(text, /Static import\/export syntax is always available/)
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup()
    }
  }
})

test('late settings hydration applies persisted non-enabled configuration', async () => {
  const { agent, definitions } = cordisAgent()
  const { ctx, cleanups } = hostContext(undefined, [agent])
  let injectSettings
  ctx.inject = (services, callback) => {
    if (services.length === 1 && ['sessionProjections', 'ptcPlusRpc', 'typert'].includes(services[0])) return
    if (services.includes('ptcRuntime')) return
    if (services.includes('codeRuntime')) {
      callback(ctx)
      return
    }
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
  assert.match(guidance, /Keep large Cordis plugin source in a binding before the tool call/)
  assert.match(guidance, /can be reused after an error/)
  assert.match(guidance, /repeat the call only when its retry rules and current results establish that it is safe/)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('keeps disabled REPL guidance byte-stable without Cordis recovery text', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: false })
  const host = hostContext(settingsContext(scope))
  apply(host.ctx)
  const guidance = host.sections.find(section => section.name === 'tools:ptc-plus-repl')?.text({})
  assert.equal(guidance.endsWith(' '), false)
  assert.doesNotMatch(guidance, /Cordis plugin source|Cordis parse/)
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
  // Concurrent rollback cancels the not-yet-started asynchronous owner before
  // it can install a plugin.
  assert.equal(cordis.pluginCalls, 0)
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
  const options = { failHook: 'tools/execute', sectionDisposeGate: teardown }
  const cordis = cordisAgent()
  const host = hostContext(settingsContext(scope), [cordis.agent], options)
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  options.failHook = undefined
  scope.set({ enabled: true, cordisToolsEnabled: true, tipsEnabled: false })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(cordis.pluginCalls, 0)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)

  releaseTeardown()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 1)
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
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
})

test('retries a synchronously failed installation before publishing its replacement', async () => {
  let sectionDisposals = 0
  const options = {
    failHook: 'llm/stream',
    hookError: Object.freeze(new Error('hook unavailable: llm/stream')),
    sectionDisposeFailures: 2,
    onSectionDispose: () => { sectionDisposals += 1 },
  }
  const scope = settingsScope({ enabled: false, cordisToolsEnabled: false })
  const host = hostContext(settingsContext(scope), [], options)
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: false })
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(sectionDisposals, 2)
  assert.equal(host.sections.length, 1)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)

  options.failHook = undefined
  scope.set({ enabled: true, cordisToolsEnabled: false })
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(sectionDisposals, 3)
  assert.equal(host.sections.length, 1)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)

  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('preserves cleanup ownership when installation throws a primitive', async () => {
  const scope = settingsScope({ enabled: false, cordisToolsEnabled: false })
  const host = hostContext(settingsContext(scope), [], {
    failHook: 'llm/stream',
    hookError: 'primitive hook failure',
  })
  apply(host.ctx)

  scope.set({ enabled: true, cordisToolsEnabled: false })
  for (let index = 0; index < 3; index += 1) await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().enabled, false)
  assert.equal(host.sections.length, 0)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)
  assert.equal(host.ctx.logger.warnings.some(([, error]) => (
    error?.message === 'primitive hook failure' && error?.cause === 'primitive hook failure'
  )), true)
  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('continues rollback after one owner disposer rejects', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { throwDispose: true })
  const host = hostContext(settingsContext(scope), [cordis.agent], {
    failHook: 'tools/execute',
    throwSectionDispose: true,
  })
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().enabled, false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
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
    await new Promise(resolve => setImmediate(resolve))
    scope.set({ enabled: false, cordisToolsEnabled: true })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(Object.hasOwn(host.runtime, 'run'), false)
    assert.equal(unhandled.length, 0)
    assert.equal(host.ctx.logger.warnings.length > 0, true)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    for (const cleanup of host.cleanups.reverse()) {
      try { await cleanup() } catch {}
    }
  }
})

test('retries a failed runtime owner before settings re-enable creates a replacement', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { disposeFailures: 1 })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 1)

  scope.set({ enabled: false, cordisToolsEnabled: true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.disposeCalls, 1)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)

  scope.set({ enabled: true, cordisToolsEnabled: true })
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(cordis.disposeCalls, 2, JSON.stringify({
    scope: scope.get(),
    warnings: host.ctx.logger.warnings.map(([, error]) => errorMessages(error)),
  }))
  assert.equal(cordis.pluginCalls, 2)
  assert.equal(Object.hasOwn(host.runtime, 'run'), true)

  for (const cleanup of host.cleanups.reverse()) await cleanup()
})

test('starts independent top-level owner cleanup before awaiting either one', async () => {
  const sectionGate = Promise.withResolvers()
  const cordisGate = Promise.withResolvers()
  const sectionStarted = Promise.withResolvers()
  const cordisStarted = Promise.withResolvers()
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(cordisGate.promise, {
    onDisposeStart(skillFiber) {
      if (!skillFiber) cordisStarted.resolve()
    },
  })
  const host = hostContext(settingsContext(scope), [cordis.agent], {
    sectionDisposeGate: sectionGate.promise,
    onSectionDispose: () => sectionStarted.resolve(),
  })
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))

  scope.set({ enabled: false, cordisToolsEnabled: true })
  await Promise.all([sectionStarted.promise, cordisStarted.promise])
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)

  sectionGate.resolve()
  cordisGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  for (const cleanup of host.cleanups.reverse()) await cleanup()
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
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
})

test('retains a failed provisional Cordis owner until a later cleanup succeeds', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, {
    activationError: new Error('Cordis activation failed'),
    activationGate: Promise.resolve(),
    disposeWithoutActivation: true,
    disposeFailures: 2,
  })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve))

  assert.equal(scope.get().enabled, false)
  assert.equal(cordis.disposeCalls, 3)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  assert.equal(Object.hasOwn(host.runtime, 'run'), false)

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
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
})

test('fails closed when provisional Cordis activation cannot be disposed', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, {
    activationGate: new Promise(() => {}),
    disposeWithoutActivation: true,
    throwDispose: true,
  })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.pluginCalls, 1)
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

test('retries the committed Cordis owner after disposal and compensation reject', async () => {
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
  assert.equal(cordis.pluginCalls, 2)
  assert.equal(scope.get().cordisToolsEnabled, false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => cordis.definitions.has(name)), false)
  for (const cleanup of host.cleanups.reverse()) {
    try { await cleanup() } catch {}
  }
})

test('reclaims a not-ready committed Cordis owner before replacing it', async () => {
  const scope = settingsScope({ enabled: true, cordisToolsEnabled: true })
  const cordis = cordisAgent(undefined, { disposeFailures: 2 })
  const host = hostContext(settingsContext(scope), [cordis.agent])
  apply(host.ctx)
  await new Promise(resolve => setImmediate(resolve))

  scope.set({ enabled: true, cordisToolsEnabled: false })
  for (let index = 0; index < 3; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(scope.get().cordisToolsEnabled, true)
  assert.equal(cordis.disposeCalls, 2)
  assert.equal(cordis.pluginCalls, 1)

  scope.set({ enabled: true, cordisToolsEnabled: true, tipsEnabled: false })
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(cordis.disposeCalls, 3)
  assert.equal(cordis.pluginCalls, 2)
  assert.equal(scope.get().tipsEnabled, false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.every(name => cordis.definitions.has(name)), true)

  for (const cleanup of host.cleanups.reverse()) await cleanup()
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
  await new Promise(resolve => setImmediate(resolve))

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
  await new Promise(resolve => setImmediate(resolve))

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
    'legacyBindingSettings',
    'enabled',
    'enhancedToolView',
    'replViewEnabled',
    'bindingAuthorButtonVisible',
    'autoDescribeRunCode',
    'bindingUpdates',
    'canonicalizeToolCalls',
    'cordisToolsEnabled',
    'userBindingsEnabled',
    'looseTopLevelRedeclarations',
    'looseTopLevelFunctionClassRedeclarations',
    'autoRewriteImports',
    'autoStripExports',
    'autoSplitRedeclarations',
    'durableReplay',
    'tipsEnabled',
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
  assert.deepEqual(CONFIG_GROUPS.map(group => group.key), ['switch', 'calls', 'syntax', 'recovery', 'extensions', 'interface', 'limits'])
  assert.deepEqual(CONFIG_GROUPS.flatMap(group => group.fields).sort(), [...expectedOrder]
    .filter(key => !['legacyBindingSettings', 'looseTopLevelRedeclarations', 'looseTopLevelFunctionClassRedeclarations', 'autoRewriteImports', 'autoStripExports', 'autoSplitRedeclarations'].includes(key))
    .sort())
  const fieldByKey = new Map(CONFIG_FIELDS.map(field => [field.key, field]))
  for (const group of CONFIG_GROUPS) {
    assert.ok(group.fields.every(key => fieldByKey.has(key)))
  }
  assert.deepEqual(CONFIG_GROUPS.find(group => group.key === 'switch').fields, ['enabled'])
  assert.deepEqual(
    CONFIG_GROUPS.find(group => group.key === 'interface').fields,
    ['enhancedToolView', 'replViewEnabled', 'bindingAuthorButtonVisible'],
  )
  assert.deepEqual(
    CONFIG_GROUPS.find(group => group.key === 'calls').fields,
    ['autoDescribeRunCode', 'canonicalizeToolCalls'],
  )
  assert.deepEqual(
    CONFIG_GROUPS.find(group => group.key === 'syntax').fields,
    ['bindingUpdates'],
  )
  assert.deepEqual(
    CONFIG_GROUPS.find(group => group.key === 'recovery').fields,
    ['durableReplay', 'tipsEnabled', 'tipCooldownMessages', 'tipEscalationFailures'],
  )
  assert.deepEqual(
    CONFIG_GROUPS.find(group => group.key === 'extensions').fields,
    ['userBindingsEnabled', 'cordisToolsEnabled'],
  )
  const defaults = await Config['~standard'].validate({})
  assert.equal(inject.includes('commands'), false)
  assert.equal(defaults.value.enabled, true)
  assert.equal(defaults.value.enhancedToolView, true)
  assert.equal(defaults.value.autoDescribeRunCode, true)
  assert.equal(defaults.value.cordisToolsEnabled, false)
  assert.equal(defaults.value.userBindingsEnabled, false)
  assert.equal(defaults.value.looseTopLevelFunctionClassRedeclarations, true)
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
