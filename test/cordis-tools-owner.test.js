import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createCordisToolsOwner as createCordisToolsOwnerRaw } from '../internal/cordis-tools-owner.js'
import { createHostContext, describeSections, runHookChain } from './host-fixture.js'

const TEST_CORDIS_TOOL_NAMES = Object.freeze([
  'test_cordis_inspect',
  'test_cordis_run',
])
const TEST_CORDIS_GUIDANCE = 'Use the test Cordis tools.'

const fakeCordisPlugin = {
  name: 'fake-tool-cordis',
  inject: ['dynamicCordisRunner', 'cordisInspect'],
  apply(ctx) {
    for (const name of TEST_CORDIS_TOOL_NAMES) ctx.tools.register({ name })
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'tool:test-cordis',
      order: 100,
      text: TEST_CORDIS_GUIDANCE,
    }))
  },
}

const CORDIS_SKILL_NAME = 'cordis-plugin-development'
const EXTRA_CORDIS_SKILL_NAME = 'editing-cordis-compositions'
const CORDIS_PRESET_PATH = '/dsh/presets/cordis/cordis.yml'
const CORDIS_SKILL_DIRECTORY = join(dirname(CORDIS_PRESET_PATH), 'skills')

const fakeSkillFilesystemPlugin = {
  name: 'fake-skill-filesystem',
  inject: ['skills'],
  apply(ctx, config) {
    assert.equal(typeof ctx.skills.list, 'function')
    assert.deepEqual(config, {
      providerName: 'ptc-plus-cordis',
      includeDefaultRoots: false,
      customSkillDirs: [CORDIS_SKILL_DIRECTORY],
    })
    const definitions = new Map([
      [CORDIS_SKILL_NAME, '# Cordis plugin development'],
      [EXTRA_CORDIS_SKILL_NAME, '# Editing Cordis compositions'],
    ])
    ctx.effect(() => ctx.skills.registerProvider(() => ({
      name: config.providerName,
      async list() {
        return [...definitions].map(([name, content]) => ({
          name,
          description: name,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: config.providerName,
          rank: 300,
          locator: name,
          content,
        }))
      },
      async get(candidate) {
        const content = definitions.get(candidate.name)
        return content === undefined ? undefined : { ...candidate, content }
      },
    })))
  },
}

function createCordisToolsOwner(ctx, cordisPlugin = fakeCordisPlugin, skillPlugin = fakeSkillFilesystemPlugin) {
  return createCordisToolsOwnerRaw(ctx, cordisPlugin, skillPlugin)
}

function errorMessages(error) {
  return error instanceof AggregateError
    ? error.errors.flatMap(errorMessages)
    : [error?.message]
}

function inspectRegistry(options = {}) {
  const providers = new Map()
  return {
    providers,
    register(registration) {
      const id = registration.manifest.id
      if (providers.has(id)) throw new Error(`Host Cordis inspect provider "${id}" is already registered`)
      providers.set(id, registration)
      if (options.invalidDisposer === true) return undefined
      return () => {
        if (providers.get(id) === registration) providers.delete(id)
        if (options.throwDispose === true) throw new Error('inspect registry disposal failed')
      }
    },
    query(id, ...args) {
      return providers.get(id).query(...args)
    },
  }
}

function scopedAgent(id, options = {}) {
  const definitions = new Map()
  const promptSections = new Map()
  if (options.ptc !== false) definitions.set('run_code', { name: 'run_code' })
  if (options.skillTool !== false) definitions.set('skill', { name: 'skill' })
  for (const name of options.existingTools ?? []) definitions.set(name, { name })
  const skillCatalog = new Map()
  const skillProviders = new Map()
  const skillObservations = []
  const agentPresets = {
    async resolve(presetId) {
      if (options.presetError !== undefined) throw options.presetError
      assert.equal(presetId, 'cordis')
      const preset = options.preset ?? {
        id: 'cordis',
        trust: 'system',
        path: CORDIS_PRESET_PATH,
      }
      if (options.removeGetAfterPreset === true) delete ctx.get
      return preset
    },
  }
  const skills = {
    registerProvider(create) {
      const controller = new AbortController()
      const provider = create({ signal: controller.signal, invalidate() {} })
      if (skillProviders.has(provider.name)) throw new Error(`duplicate Skill provider ${provider.name}`)
      skillProviders.set(provider.name, provider)
      return () => {
        controller.abort()
        skillProviders.delete(provider.name)
        for (const [name, skill] of skillCatalog) {
          if (skill.provider === provider.name) skillCatalog.delete(name)
        }
      }
    },
    async list({ scope }) {
      assert.equal(scope?.id, id)
      const summaries = []
      for (const provider of skillProviders.values()) {
        const observation = await provider.list({})
        skillObservations.push(observation)
        const candidates = Array.isArray(observation) ? observation : observation.candidates
        for (const candidate of candidates) {
          const { content: _content, locator: _locator, rank: _rank, ...summary } = candidate
          summaries.push(options.skillSummaryTransform?.(summary) ?? summary)
        }
      }
      return summaries
    },
    async get(name, { scope }) {
      assert.equal(scope?.id, id)
      let skill
      for (const provider of skillProviders.values()) {
        const observation = await provider.list({})
        skillObservations.push(observation)
        const candidates = Array.isArray(observation) ? observation : observation.candidates
        const candidate = candidates.find(item => item.name === name)
        if (candidate === undefined) continue
        skill = await provider.get(candidate, {})
        if (skill !== undefined) skillCatalog.set(name, skill)
        break
      }
      return options.skillDefinitionTransform?.(skill) ?? skill
    },
  }
  const services = new Map([
    ['dynamicCordisRunner', {}],
    ['cordisInspect', options.cordisInspect ?? inspectRegistry()],
    ['agentPresets', agentPresets],
    ['skills', skills],
  ])
  for (const missing of options.missingServices ?? []) services.delete(missing)
  for (const malformed of options.malformedServices ?? []) services.set(malformed, {})
  let pluginCalls = 0
  let skillPluginCalls = 0
  const ctx = {
    agentId: id,
    skillCatalog,
    tools: {
      get(name) {
        return definitions.get(name)
      },
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    systemPrompt: {
      section(definition) {
        promptSections.set(definition.name, definition)
        return () => promptSections.delete(definition.name)
      },
    },
    get(name) {
      return services.get(name)
    },
    extend(meta) {
      return Object.assign(Object.create(this), meta)
    },
    plugin(plugin, config) {
      const skillFiber = plugin.name === fakeSkillFilesystemPlugin.name
      if (skillFiber) skillPluginCalls += 1
      else pluginCalls += 1
      const invalidFiber = skillFiber ? options.invalidSkillFiber : options.invalidFiber
      const activationGate = skillFiber ? options.skillActivationGate : options.activationGate
      const activationError = skillFiber ? options.skillActivationError : options.activationError
      const throwDispose = skillFiber ? options.throwSkillDispose : options.throwDispose
      const throwDisposeSynchronously = skillFiber
        ? options.throwSkillDisposeSynchronously
        : options.throwDisposeSynchronously
      const fiberInject = skillFiber ? options.skillFiberInject : options.fiberInject
      const before = new Set(definitions.keys())
      if (invalidFiber) return {}
      const effectDisposers = []
      const pluginMeta = {
        effect(setup) {
          const dispose = setup()
          effectDisposers.push(dispose)
          return dispose
        },
      }
      const pluginCtx = options.withoutExtend
        ? Object.assign(Object.create(ctx), pluginMeta)
        : ctx.extend({
            ...pluginMeta,
            ...(!skillFiber && options.withoutCordisPluginExtend === true
              ? { extend: undefined }
              : {}),
          })
      let disposed = false
      const activation = Promise.resolve(activationGate).then(() => {
        if (activationError !== undefined) throw activationError
        if (disposed) return
        plugin.apply(pluginCtx, config)
      })
      const fiber = {
        inject: fiberInject !== undefined
          ? fiberInject
          : Object.fromEntries((plugin.inject ?? []).map(name => [name, null])),
        then(onFulfilled, onRejected) {
          return activation.then(onFulfilled, onRejected)
        },
        async dispose() {
          disposed = true
          if (options.disposeWithoutActivation === true) {
            for (const dispose of effectDisposers.reverse()) await dispose()
            if (throwDispose === true) throw new Error('Cordis disposal failed')
            return
          }
          try {
            await activation
          } catch {}
          for (const dispose of effectDisposers.reverse()) await dispose()
          for (const name of definitions.keys()) {
            if (!before.has(name)) definitions.delete(name)
          }
          if (throwDispose === true) throw new Error('Cordis disposal failed')
        },
      }
      if (throwDisposeSynchronously === true) {
        fiber.dispose = () => { throw new Error('Cordis disposal failed synchronously') }
      }
      return fiber
    },
  }
  if (options.withoutGet) delete ctx.get
  if (options.withoutExtend) delete ctx.extend
  if (options.withoutPlugin) delete ctx.plugin
  return {
    id,
    ctx,
    definitions,
    promptSections,
    skillCatalog,
    skillProviders,
    skillObservations,
    get pluginCalls() {
      return pluginCalls
    },
    get skillPluginCalls() {
      return skillPluginCalls
    },
  }
}

function ownerContext(initialAgents = [], options = {}) {
  const host = createHostContext()
  const { listeners } = host
  const warnings = []
  const cordisInspect = options.cordisInspect ?? inspectRegistry()
  return {
    ctx: {
      agents: { list: () => initialAgents },
      get(name) {
        return name === 'cordisInspect' ? cordisInspect : undefined
      },
      on: host.ctx.on,
      logger: { warn(message, error) { warnings.push([message, error]) } },
      systemPrompt: {
        async assemble(context = {}) {
          const assembly = {
            sections: describeSections(context.scope?.promptSections.values() ?? [], context),
            tools: TEST_CORDIS_TOOL_NAMES.filter(name => context.scope?.definitions.has(name)),
          }
          const entries = [...listeners.get('system-prompt/assemble') ?? []]
          return runHookChain(entries, [assembly, context], () => Promise.resolve(assembly))
        },
      },
    },
    cordisInspect,
    listeners,
    warnings,
    async emit(name, payload, next = () => undefined) {
      for (const listener of [...listeners.get(name) ?? []]) await listener(payload, next)
    },
  }
}

test('Cordis owner scopes official tools to current and future PTC agents', async () => {
  const current = scopedAgent('current')
  const native = scopedAgent('native', { ptc: false })
  const host = ownerContext([current, native])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  await owner.ready

  assert.equal(current.pluginCalls, 1)
  assert.equal(current.skillPluginCalls, 1)
  assert.equal(native.pluginCalls, 0)
  assert.equal(native.skillPluginCalls, 0)
  assert.deepEqual(TEST_CORDIS_TOOL_NAMES.filter(name => current.definitions.has(name)), TEST_CORDIS_TOOL_NAMES)
  assert.equal(current.skillCatalog.has(CORDIS_SKILL_NAME), true)
  assert.equal(current.skillCatalog.has(EXTRA_CORDIS_SKILL_NAME), false)
  assert.deepEqual((await current.ctx.get('skills').list({ scope: current })).map(skill => skill.name), [CORDIS_SKILL_NAME])

  const future = scopedAgent('future')
  await host.emit('agent/created', { agent: future })
  await host.emit('agent/created', { agent: future })
  assert.equal(future.pluginCalls, 1)
  assert.equal(future.skillCatalog.has(CORDIS_SKILL_NAME), true)

  await host.emit('agent/disposed', { agent: native })
  await host.emit('agent/disposed', { agent: future })
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => future.definitions.has(name)), false)
  assert.equal(future.skillCatalog.has(CORDIS_SKILL_NAME), false)

  await owner.dispose()
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => current.definitions.has(name)), false)
  assert.equal(current.skillCatalog.has(CORDIS_SKILL_NAME), false)
})

test('Cordis owner preserves incomplete observations while filtering and guarding companion loads', async () => {
  const upstreamGets = []
  const incompleteSkillPlugin = {
    ...fakeSkillFilesystemPlugin,
    apply(ctx, config) {
      assert.equal(typeof ctx.skills.list, 'function')
      ctx.effect(() => ctx.skills.registerProvider(() => ({
        name: config.providerName,
        async list() {
          return {
            candidates: [CORDIS_SKILL_NAME, EXTRA_CORDIS_SKILL_NAME].map(name => ({
              name,
              invocation: { modelInvocable: true, userInvocable: true },
              provider: config.providerName,
            })),
            complete: false,
          }
        },
        async get(candidate) {
          upstreamGets.push(candidate.name)
          return { ...candidate, content: `# ${candidate.name}` }
        },
      })))
    },
  }
  const agent = scopedAgent('incomplete-observation')
  const owner = createCordisToolsOwner(
    ownerContext([agent]).ctx,
    fakeCordisPlugin,
    incompleteSkillPlugin,
  )
  await owner.ready

  assert.equal(agent.skillObservations.length > 0, true)
  for (const observation of agent.skillObservations) {
    assert.equal(observation.complete, false)
    assert.deepEqual(observation.candidates.map(candidate => candidate.name), [CORDIS_SKILL_NAME])
  }
  const [provider] = agent.skillProviders.values()
  assert.equal(await provider.get({ name: EXTRA_CORDIS_SKILL_NAME }, {}), undefined)
  assert.deepEqual(upstreamGets, [CORDIS_SKILL_NAME])
  await owner.dispose()
})

test('Cordis owner leaves the host dispatchers their own outcome', async () => {
  const root = new Context()
  root.provide('agents', { list: () => [] })
  root.provide('cordisInspect', inspectRegistry())
  const owner = createCordisToolsOwner(root, fakeCordisPlugin)
  await owner.ready

  // The public serial agent-created dispatch rejects the agents.create() that
  // requested the agent when a listener fails. A scope this owner cannot serve
  // must not become that failure, and the parallel form must hold too.
  const omitted = scopedAgent('host-dispatch-omitted-tool', { skillTool: false })
  await root.serial(root, 'agent/created', { agent: omitted })
  await root.parallel(root, 'agent/created', { agent: omitted })
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => omitted.definitions.has(name)), false)

  // A scope whose exposed surface contradicts the host contract withdraws from
  // that scope, and the prompt assembly it still reaches keeps its own result.
  const broken = scopedAgent('host-dispatch-broken-preset', { preset: { path: 'cordis.yml' } })
  const assembly = await root.waterfall(root, 'system-prompt/assemble', { sections: [], tools: [] },
    { scope: broken }, () => 'assembled')
  assert.equal(assembly, 'assembled')
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => broken.definitions.has(name)), false)

  // A contradiction found before the mount exists is contained the same way.
  const unavailable = scopedAgent('host-dispatch-omitted-context-api', { withoutPlugin: true })
  await root.serial(root, 'agent/created', { agent: unavailable })
  await owner.dispose()
})

test('Cordis owner rejects incompatible provider results without leaving a partial mount', async () => {
  for (const [label, createProvider, expected] of [
    ['invalid provider', () => null, /Skill provider is incompatible/],
    ['invalid observation', () => ({
      name: 'ptc-plus-cordis',
      async list() { return null },
      async get() {},
    }), /Cannot read properties of null/],
    ['mismatched load', () => ({
      name: 'ptc-plus-cordis',
      async list() {
        return [{
          name: CORDIS_SKILL_NAME,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'ptc-plus-cordis',
        }]
      },
      async get(candidate) {
        return { ...candidate, name: EXTRA_CORDIS_SKILL_NAME, content: '# wrong Skill' }
      },
    }), /is not loadable/],
  ]) {
    const skillPlugin = {
      ...fakeSkillFilesystemPlugin,
      apply(ctx) {
        ctx.effect(() => ctx.skills.registerProvider(createProvider))
      },
    }
    const agent = scopedAgent(label)
    const owner = createCordisToolsOwner(ownerContext([agent]).ctx, fakeCordisPlugin, skillPlugin)
    await assert.rejects(owner.ready, expected)
    assert.equal(agent.skillProviders.size, 0)
    assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => agent.definitions.has(name)), false)
    await owner.dispose()
  }
})

test('Cordis owner retries agents once run_code becomes visible', async () => {
  const late = scopedAgent('late', { ptc: false })
  const host = ownerContext([late])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  assert.equal(late.pluginCalls, 0)

  late.definitions.set('run_code', { name: 'run_code' })
  await host.emit('tools/change')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.pluginCalls, 1)
  assert.deepEqual(TEST_CORDIS_TOOL_NAMES.filter(name => late.definitions.has(name)), TEST_CORDIS_TOOL_NAMES)
  await owner.dispose()
})

test('Cordis owner rolls back both contributions when the companion Skill cannot publish', async () => {
  const activationFailure = scopedAgent('skill-activation-failure', {
    skillActivationError: new Error('Skill activation failed'),
  })
  const activationOwner = createCordisToolsOwner(ownerContext([activationFailure]).ctx)
  await assert.rejects(activationOwner.ready, /Skill activation failed/)
  assert.equal(activationFailure.skillCatalog.has(CORDIS_SKILL_NAME), false)
  assert.equal(activationFailure.pluginCalls, 0)
  await activationOwner.dispose()

  const missingSkillPlugin = {
    ...fakeSkillFilesystemPlugin,
    apply() {},
  }
  const missingSkill = scopedAgent('missing-skill')
  const missingOwner = createCordisToolsOwner(
    ownerContext([missingSkill]).ctx,
    fakeCordisPlugin,
    missingSkillPlugin,
  )
  await assert.rejects(missingOwner.ready, /must publish exactly/)
  assert.equal(missingSkill.skillCatalog.has(CORDIS_SKILL_NAME), false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => missingSkill.definitions.has(name)), false)
  await missingOwner.dispose()
})

test('Cordis owner defers an agent scope that omits a companion service or tool', async () => {
  for (const [label, options] of [
    ['preset service', { missingServices: ['agentPresets'] }],
    ['skills service', { missingServices: ['skills'] }],
    ['skill tool', { skillTool: false }],
  ]) {
    const agent = scopedAgent(`absent-${label}`, options)
    const owner = createCordisToolsOwner(ownerContext([agent]).ctx)
    await owner.ready
    assert.equal(agent.skillPluginCalls, 0)
    assert.equal(agent.pluginCalls, 0)
    assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => agent.definitions.has(name)), false)
    await owner.dispose()
  }
})

test('Cordis owner contains a created agent scope that omits the companion tool', async () => {
  const host = ownerContext([])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  await owner.ready

  // The public serial `agent/created` dispatch turns a listener rejection into
  // an agents.create() failure, so another plugin's subagent creation has to
  // survive an agent scope this owner cannot serve.
  const agent = scopedAgent('serial-without-companion-tool', { skillTool: false })
  await host.emit('agent/created', { agent })

  assert.equal(agent.skillPluginCalls, 0)
  assert.equal(agent.pluginCalls, 0)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => agent.definitions.has(name)), false)
  assert.equal(agent.skillCatalog.has(CORDIS_SKILL_NAME), false)
  assert.deepEqual(host.warnings, [])
  await owner.dispose()
})

test('Cordis owner mounts a created agent once its companion tool appears', async () => {
  const host = ownerContext([])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  await owner.ready
  const agent = scopedAgent('late-companion-tool', { skillTool: false })
  await host.emit('agent/created', { agent })
  assert.equal(agent.pluginCalls, 0)

  agent.definitions.set('skill', { name: 'skill' })
  await host.emit('tools/change')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(agent.pluginCalls, 1)
  assert.deepEqual(TEST_CORDIS_TOOL_NAMES.filter(name => agent.definitions.has(name)), TEST_CORDIS_TOOL_NAMES)
  await owner.dispose()
})

test('Cordis owner withdraws from an unusable created agent scope without failing its creation', async () => {
  const host = ownerContext([])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  await owner.ready

  const agent = scopedAgent('created-with-broken-preset', { preset: { path: 'cordis.yml' } })
  await host.emit('agent/created', { agent })
  assert.equal(agent.pluginCalls, 0)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => agent.definitions.has(name)), false)
  assert.equal(host.warnings.length, 1)
  assert.match(errorMessages(host.warnings[0][1]).join('\n'), /absolute composition path/)

  // The same withdrawn scope must neither report again nor fail the prompt it
  // still has to assemble.
  await host.emit('agent/created', { agent })
  await host.emit('tools/change')
  const assembly = await host.ctx.systemPrompt.assemble({ scope: agent })
  assert.equal(host.warnings.length, 1)
  assert.deepEqual(assembly.tools, [])
  await owner.dispose()
})

test('Cordis owner never retries a withdrawn asynchronous activation', async () => {
  const host = ownerContext([])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  await owner.ready
  const agent = scopedAgent('created-with-failed-activation', {
    activationError: new Error('created activation failed'),
  })
  await host.emit('agent/created', { agent })
  assert.equal(agent.skillPluginCalls, 1)
  assert.equal(agent.pluginCalls, 1)
  assert.equal(host.warnings.length, 1)

  await host.emit('agent/created', { agent })
  await host.emit('tools/change')
  await host.ctx.systemPrompt.assemble({ scope: agent })
  assert.equal(agent.skillPluginCalls, 1)
  assert.equal(agent.pluginCalls, 1)
  assert.equal(host.warnings.length, 1)
  await owner.dispose()
})

test('Cordis owner rejects unavailable companion Skill capabilities before publication', async () => {
  for (const [label, options, expected] of [
    ['broken preset', { preset: { broken: 'invalid composition' } }, /preset is unavailable/],
    ['preset generation without a composition path', { preset: { id: 'cordis' } },
      /publishes no composition path for the "cordis" preset/],
    ['relative preset path', { preset: { path: 'cordis.yml' } }, /absolute composition path/],
    ['preset service without resolve', { malformedServices: ['agentPresets'] }, /agentPresets\.resolve API/],
    ['skills service without its APIs', { malformedServices: ['skills'] }, /skills registerProvider\/list\/get APIs/],
  ]) {
    const agent = scopedAgent(`missing-${label}`, options)
    const owner = createCordisToolsOwner(ownerContext([agent]).ctx)
    await assert.rejects(owner.ready, expected)
    assert.equal(agent.skillPluginCalls, 0)
    assert.equal(agent.pluginCalls, 0)
    await owner.dispose()
  }

  const lostGet = scopedAgent('lost-get', { removeGetAfterPreset: true })
  const lostGetOwner = createCordisToolsOwner(ownerContext([lostGet]).ctx)
  await assert.rejects(lostGetOwner.ready, /agent Context\.get API/)
  await lostGetOwner.dispose()

  const invalidSkillFiber = scopedAgent('invalid-skill-fiber', { invalidSkillFiber: true })
  const invalidSkillOwner = createCordisToolsOwner(ownerContext([invalidSkillFiber]).ctx)
  await assert.rejects(invalidSkillOwner.ready, /disposable Cordis Skill fiber/)
  await invalidSkillOwner.dispose()
})

test('Cordis owner verifies the exact scoped companion Skill provider and body', async () => {
  for (const [label, options, expected] of [
    ['foreign summary', {
      skillSummaryTransform: summary => ({ ...summary, provider: 'foreign-provider' }),
    }, /must publish exactly/],
    ['disabled summary', {
      skillSummaryTransform: summary => ({
        ...summary,
        invocation: { ...summary.invocation, modelInvocable: false },
      }),
    }, /must publish exactly/],
    ['foreign definition', {
      skillDefinitionTransform: skill => ({ ...skill, provider: 'foreign-provider' }),
    }, /is not loadable/],
    ['disabled definition', {
      skillDefinitionTransform: skill => ({
        ...skill,
        invocation: { ...skill.invocation, modelInvocable: false },
      }),
    }, /is not loadable/],
    ['non-string body', {
      skillDefinitionTransform: skill => ({ ...skill, content: null }),
    }, /is not loadable/],
    ['empty body', {
      skillDefinitionTransform: skill => ({ ...skill, content: '' }),
    }, /is not loadable/],
  ]) {
    const agent = scopedAgent(`invalid-${label}`, options)
    const owner = createCordisToolsOwner(ownerContext([agent]).ctx)
    await assert.rejects(owner.ready, expected)
    assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => agent.definitions.has(name)), false)
    assert.equal(agent.skillCatalog.has(CORDIS_SKILL_NAME), false)
    await owner.dispose()
  }
})

test('Cordis owner diagnoses a deferred activation failure', async () => {
  const late = scopedAgent('late-missing-services', {
    ptc: false,
    missingServices: ['dynamicCordisRunner'],
  })
  const host = ownerContext([late])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  late.definitions.set('run_code', { name: 'run_code' })
  await host.emit('tools/change')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.pluginCalls, 1)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => late.definitions.has(name)), false)
  assert.equal(host.warnings.length, 1)
  await host.emit('tools/change')
  await host.emit('tools/change')
  await host.ctx.systemPrompt.assemble({ scope: late })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.pluginCalls, 1)
  assert.equal(host.warnings.length, 1)
  await owner.dispose()
})

test('Cordis owner cancels a queued deferred retry when disposed', async () => {
  const late = scopedAgent('late-disposed-retry', { ptc: false })
  const host = ownerContext([late])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  await owner.ready
  late.definitions.set('run_code', { name: 'run_code' })
  const retry = [...host.listeners.get('tools/change')][0]
  retry()
  const disposal = owner.dispose()
  assert.equal(owner.dispose(), disposal)
  await disposal
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.pluginCalls, 0)
  assert.equal(host.warnings.length, 0)
})

test('Cordis owner follows the official plugin tool names without a local manifest', async () => {
  const renamedPlugin = {
    ...fakeCordisPlugin,
    apply(ctx) {
      ctx.tools.register({ name: 'future_cordis_entry' })
    },
  }
  const agent = scopedAgent('renamed')
  const host = ownerContext([agent])
  const owner = createCordisToolsOwner(host.ctx, renamedPlugin)
  await owner.ready
  assert.equal(agent.definitions.has('future_cordis_entry'), true)
  await owner.dispose()
  assert.equal(agent.definitions.has('future_cordis_entry'), false)
})

test('Cordis owner shares process-global inspect providers across agent fibers and re-enables cleanly', async () => {
  const inspectingPlugin = {
    ...fakeCordisPlugin,
    apply(ctx) {
      ctx.effect(() => ctx.cordisInspect.register({
        manifest: { id: 'Service', methods: [] },
        query() { return ctx.agentId },
      }))
      fakeCordisPlugin.apply(ctx)
    },
  }
  const first = scopedAgent('first')
  const second = scopedAgent('second')
  const host = ownerContext([first, second])
  const owner = createCordisToolsOwner(host.ctx, inspectingPlugin)
  await owner.ready

  assert.equal(host.cordisInspect.providers.size, 1)
  assert.equal(host.cordisInspect.query('Service'), 'first')
  await host.emit('agent/disposed', { agent: first })
  assert.equal(host.cordisInspect.query('Service'), 'second')

  await owner.dispose()
  assert.equal(host.cordisInspect.providers.size, 0)

  const replacement = createCordisToolsOwner(host.ctx, inspectingPlugin)
  await replacement.ready
  assert.equal(host.cordisInspect.providers.size, 1)
  await replacement.dispose()
  assert.equal(host.cordisInspect.providers.size, 0)
})

test('Cordis owner rejects inconsistent process-global inspect provider manifests', async () => {
  const plugin = {
    ...fakeCordisPlugin,
    apply(ctx) {
      ctx.effect(() => ctx.cordisInspect.register({
        manifest: { id: 'Service', methods: [ctx.agentId] },
        query() {},
      }))
    },
  }
  const host = ownerContext([scopedAgent('first'), scopedAgent('second')])
  const owner = createCordisToolsOwner(host.ctx, plugin)
  await assert.rejects(owner.ready, /changed its manifest across agent scopes/)
  await owner.dispose()
  assert.equal(host.cordisInspect.providers.size, 0)
})

test('Cordis owner rejects incompatible host and agent capabilities', async () => {
  assert.throws(
    () => createCordisToolsOwner({ agents: {}, on() {} }, fakeCordisPlugin),
    /agents\.list API/,
  )

  const registeringPlugin = {
    ...fakeCordisPlugin,
    apply(ctx) {
      ctx.cordisInspect.register({ manifest: { id: 'Service' }, query() {} })
    },
  }
  const missingHostGet = createCordisToolsOwner({
    agents: { list: () => [scopedAgent('missing-host-get')] },
    on() { return () => {} },
  }, registeringPlugin)
  await assert.rejects(missingHostGet.ready, /Context\.get API/)
  await missingHostGet.dispose()

  const missingHostInspect = createCordisToolsOwner({
    agents: { list: () => [scopedAgent('missing-host-inspect')] },
    get: () => ({}),
    on() { return () => {} },
  }, registeringPlugin)
  await assert.rejects(missingHostInspect.ready, /cordisInspect\.register API/)
  await missingHostInspect.dispose()

  const missingGetOwner = createCordisToolsOwner(
    ownerContext([scopedAgent('missing-get', { withoutGet: true })]).ctx,
    fakeCordisPlugin,
  )
  await assert.rejects(
    missingGetOwner.ready,
    /Context\.get API/,
  )
  await missingGetOwner.dispose()

  const missingServicesOwner = createCordisToolsOwner(ownerContext([scopedAgent('missing-services', {
    missingServices: ['dynamicCordisRunner', 'cordisInspect'],
  })]).ctx, fakeCordisPlugin)
  await assert.rejects(
    missingServicesOwner.ready,
    /dynamicCordisRunner, cordisInspect/,
  )
  await missingServicesOwner.dispose()

  const missingServicesCleanupOwner = createCordisToolsOwner(ownerContext([scopedAgent(
    'missing-services-cleanup-failure',
    { missingServices: ['cordisInspect'], throwDisposeSynchronously: true },
  )]).ctx, fakeCordisPlugin)
  await assert.rejects(
    missingServicesCleanupOwner.ready,
    error => error instanceof AggregateError
      && error.errors.some(cause => /requires DSH services: cordisInspect/.test(cause.message))
      && error.errors.some(cause => cause.message === 'Cordis disposal failed synchronously'),
  )
  await assert.rejects(missingServicesCleanupOwner.dispose(), /Cordis disposal failed/)

  const missingPlugin = scopedAgent('missing-plugin', { withoutPlugin: true })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([missingPlugin]).ctx, fakeCordisPlugin),
    /Context\.plugin API/,
  )

  const missingExtend = scopedAgent('missing-extend', { withoutExtend: true })
  const missingExtendOwner = createCordisToolsOwner(ownerContext([missingExtend]).ctx, fakeCordisPlugin)
  await assert.rejects(missingExtendOwner.ready, /Context\.extend API/)
  await missingExtendOwner.dispose()

  const lostExtend = scopedAgent('lost-extend', { withoutCordisPluginExtend: true })
  const lostExtendOwner = createCordisToolsOwner(ownerContext([lostExtend]).ctx, fakeCordisPlugin)
  await assert.rejects(lostExtendOwner.ready, /Context\.extend API/)
  await lostExtendOwner.dispose()

  const invalidFiber = scopedAgent('invalid-fiber', { invalidFiber: true })
  const invalidFiberOwner = createCordisToolsOwner(ownerContext([invalidFiber]).ctx, fakeCordisPlugin)
  await assert.rejects(
    invalidFiberOwner.ready,
    /did not return a disposable Cordis tool fiber/,
  )
  await invalidFiberOwner.dispose()

  const invalidInjectOwner = createCordisToolsOwner(
    ownerContext([scopedAgent('invalid-inject', { fiberInject: null })]).ctx,
    fakeCordisPlugin,
  )
  await assert.rejects(
    invalidInjectOwner.ready,
    /did not expose resolved Cordis tool service dependencies/,
  )
  await invalidInjectOwner.dispose()
})

test('Cordis owner rejects malformed inspect registrations and keeps lease disposal idempotent', async () => {
  const malformed = {
    ...fakeCordisPlugin,
    apply(ctx) {
      ctx.cordisInspect.register({ manifest: { id: '' }, query() {} })
    },
  }
  const malformedOwner = createCordisToolsOwner(ownerContext([scopedAgent('malformed')]).ctx, malformed)
  await assert.rejects(malformedOwner.ready, /non-empty manifest id/)
  await malformedOwner.dispose()

  const idempotent = {
    ...fakeCordisPlugin,
    apply(ctx) {
      const dispose = ctx.cordisInspect.register({
        manifest: { id: 'Service', methods: [] },
        query() {},
      })
      assert.equal(ctx.cordisInspect.providers.size, 1)
      assert.equal(ctx.cordisInspect.query('Service'), undefined)
      dispose()
      dispose()
    },
  }
  const host = ownerContext([scopedAgent('idempotent')])
  const owner = createCordisToolsOwner(host.ctx, idempotent)
  await owner.ready
  assert.equal(host.cordisInspect.providers.size, 0)
  await owner.dispose()

  const invalidDisposerHost = ownerContext([], {
    cordisInspect: inspectRegistry({ invalidDisposer: true }),
  })
  const invalidDisposer = scopedAgent('invalid-inspect-disposer')
  const originalGet = invalidDisposer.ctx.get.bind(invalidDisposer.ctx)
  invalidDisposer.ctx.get = name => name === 'cordisInspect'
    ? invalidDisposerHost.cordisInspect
    : originalGet(name)
  const registering = {
    ...fakeCordisPlugin,
    apply(ctx) {
      ctx.cordisInspect.register({ manifest: { id: 'BadDisposer' }, query() {} })
    },
  }
  const invalidDisposerOwner = createCordisToolsOwner(
    ownerContext([invalidDisposer], { cordisInspect: invalidDisposerHost.cordisInspect }).ctx,
    registering,
  )
  await assert.rejects(invalidDisposerOwner.ready, /did not return a disposer/)
  await invalidDisposerOwner.dispose()
})

test('Cordis owner aggregates final process-global inspect lease cleanup failures', async () => {
  const cordisInspect = inspectRegistry({ throwDispose: true })
  const agent = scopedAgent('inspect-disposal-failure', { cordisInspect })
  const plugin = {
    ...fakeCordisPlugin,
    apply(ctx) {
      ctx.cordisInspect.register({ manifest: { id: 'ThrowingDispose' }, query() {} })
      fakeCordisPlugin.apply(ctx)
    },
  }
  const host = ownerContext([agent], { cordisInspect })
  const owner = createCordisToolsOwner(host.ctx, plugin)
  await owner.ready

  await assert.rejects(
    owner.dispose(),
    error => error instanceof AggregateError
      && errorMessages(error).includes('inspect registry disposal failed'),
  )
})

test('Cordis owner surfaces an official plugin activation failure', async () => {
  const agent = scopedAgent('pending', { activationError: new Error('Cordis activation failed') })
  const owner = createCordisToolsOwner(ownerContext([agent]).ctx, fakeCordisPlugin)
  await assert.rejects(
    owner.ready,
    /Cordis activation failed/,
  )
  await owner.dispose()
})

test('Cordis owner recollects the first prompt after an asynchronous fiber is ready', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  const agent = scopedAgent('async', { activationGate })
  const host = ownerContext([agent])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  let assembled = false
  const request = host.ctx.systemPrompt.assemble({ scope: agent }).then(value => {
    assembled = true
    return value
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(assembled, false)

  releaseActivation()
  const assembly = await request
  await owner.ready
  assert.deepEqual(assembly.tools, TEST_CORDIS_TOOL_NAMES)
  assert.deepEqual(assembly.sections, [{ name: 'tool:test-cordis', text: TEST_CORDIS_GUIDANCE }])
  await owner.dispose()
})

test('Cordis owner rejects recollection when the public assembler disappears', async () => {
  const agent = scopedAgent('missing-assembler')
  const host = ownerContext([])
  const owner = createCordisToolsOwner(host.ctx, fakeCordisPlugin)
  delete host.ctx.systemPrompt.assemble
  const [assemble] = host.listeners.get('system-prompt/assemble')

  await assert.rejects(
    assemble({}, { scope: agent }, () => Promise.resolve({ tools: [] })),
    /systemPrompt\.assemble API/,
  )
  await owner.dispose()
})

test('Cordis owner rolls back earlier current-agent mounts after a later service failure', async () => {
  const mounted = scopedAgent('mounted')
  const conflict = scopedAgent('conflict', { missingServices: ['cordisInspect'] })
  const owner = createCordisToolsOwner(ownerContext([mounted, conflict]).ctx, fakeCordisPlugin)
  await assert.rejects(
    owner.ready,
    /requires DSH services: cordisInspect/,
  )
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => mounted.definitions.has(name)), false)
  await owner.dispose()
})

test('Cordis owner contains pending activation when initial agent enumeration fails synchronously', async () => {
  const pending = scopedAgent('pending-before-sync-failure', {
    presetError: new Error('preset resolution failed during rollback'),
  })
  const invalid = scopedAgent('sync-failure', { withoutPlugin: true })
  assert.throws(
    () => createCordisToolsOwner(ownerContext([pending, invalid]).ctx),
    /Context\.plugin API/,
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.skillCatalog.has(CORDIS_SKILL_NAME), false)
  assert.equal(TEST_CORDIS_TOOL_NAMES.some(name => pending.definitions.has(name)), false)
})

test('Cordis activation propagates its own failure together with cleanup failure', async () => {
  let releaseActivation
  const activationGate = new Promise(resolve => { releaseActivation = resolve })
  const failing = scopedAgent('activation-cleanup-failure', {
    activationError: new Error('Cordis activation failed'),
    activationGate,
    disposeWithoutActivation: true,
    throwDispose: true,
  })
  const owner = createCordisToolsOwner(ownerContext([failing]).ctx, fakeCordisPlugin)
  releaseActivation()
  await assert.rejects(
    owner.ready,
    error => error instanceof AggregateError
      && error.errors.some(cause => cause.message === 'Cordis activation failed')
      && error.errors.some(cause => cause.message === 'Cordis disposal failed'),
  )
  await assert.rejects(owner.dispose(), error => error instanceof AggregateError
    && errorMessages(error).includes('Cordis disposal failed'))
})

test('Cordis activation rollback reports a synchronously throwing fiber disposer', async () => {
  const mounted = scopedAgent('sync-disposal-failure', {
    activationError: new Error('Cordis activation failed before rollback'),
    throwDisposeSynchronously: true,
  })
  const owner = createCordisToolsOwner(ownerContext([mounted]).ctx, fakeCordisPlugin)
  await assert.rejects(
    owner.ready,
    error => error instanceof AggregateError
      && errorMessages(error).includes('Cordis activation failed before rollback')
      && errorMessages(error).includes('Cordis disposal failed synchronously'),
  )
  await assert.rejects(owner.dispose(), /Cordis disposal failed/)
})
