import * as CordisTools from '@deepseek-ai/dsh-tool-cordis'
import * as CordisSkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { RUN_CODE } from './runtime-bridge-owner.js'

const CORDIS_PRESET_ID = 'cordis'
const CORDIS_SKILL_NAME = 'cordis-plugin-development'
const CORDIS_SKILL_PROVIDER = 'ptc-plus-cordis'

function exactCompanionCandidates(observation) {
  if (Array.isArray(observation)) {
    return observation.filter(candidate => candidate?.name === CORDIS_SKILL_NAME)
  }
  if (observation === null || typeof observation !== 'object'
    || !Array.isArray(observation.candidates)) return observation
  return {
    ...observation,
    candidates: observation.candidates.filter(candidate => candidate?.name === CORDIS_SKILL_NAME),
  }
}

function exactCompanionProvider(provider) {
  if (provider === null || typeof provider !== 'object'
    || typeof provider.name !== 'string'
    || typeof provider.list !== 'function'
    || typeof provider.get !== 'function') {
    throw new Error('ptc-plus: DSH Cordis Skill provider is incompatible')
  }
  return {
    ...provider,
    async list(options) {
      return exactCompanionCandidates(await Reflect.apply(provider.list, provider, [options]))
    },
    async get(candidate, options) {
      if (candidate?.name !== CORDIS_SKILL_NAME) return undefined
      const skill = await Reflect.apply(provider.get, provider, [candidate, options])
      return skill?.name === CORDIS_SKILL_NAME ? skill : undefined
    },
  }
}

function exactCompanionSkillPlugin(skillFilesystemPlugin) {
  return {
    ...skillFilesystemPlugin,
    apply(pluginCtx, config) {
      if (typeof pluginCtx?.extend !== 'function') {
        throw new Error('ptc-plus: cordisToolsEnabled requires the DSH Context.extend API')
      }
      const skills = pluginCtx.get?.('skills')
      if (typeof skills?.registerProvider !== 'function') {
        throw new Error('ptc-plus: cordisToolsEnabled requires the DSH skills.registerProvider API')
      }
      const facade = new Proxy(skills, {
        get(target, property) {
          if (property === 'registerProvider') {
            return create => target.registerProvider(control => exactCompanionProvider(create(control)))
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return skillFilesystemPlugin.apply(pluginCtx.extend({ skills: facade }), config)
    },
  }
}

function requireFiberServices(agent, fiber, owner) {
  if (typeof agent?.ctx?.get !== 'function') {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agent Context.get API')
  }
  if (fiber.inject === null || typeof fiber.inject !== 'object' || Array.isArray(fiber.inject)) {
    throw new Error(`ptc-plus: DSH Context.plugin did not expose resolved ${owner} service dependencies`)
  }
  const missing = Object.keys(fiber.inject).filter(service => agent.ctx.get(service) === undefined)
  if (missing.length > 0) {
    throw new Error(
      `ptc-plus: cordisToolsEnabled requires DSH services: ${missing.join(', ')}`,
    )
  }
}

function requireCompanionServices(agent) {
  if (typeof agent?.ctx?.get !== 'function') {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agent Context.get API')
  }
  const agentPresets = agent.ctx.get('agentPresets')
  if (typeof agentPresets?.resolve !== 'function') {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agentPresets.resolve API')
  }
  const skills = agent.ctx.get('skills')
  if (typeof skills?.registerProvider !== 'function'
    || typeof skills.list !== 'function' || typeof skills.get !== 'function') {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH skills registerProvider/list/get APIs')
  }
  if (agent.ctx.tools?.get?.('skill', agent) === undefined) {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH skill tool in the PTC agent scope')
  }
  return { agentPresets, skills }
}

async function companionSkillDirectory(agentPresets) {
  const preset = await agentPresets.resolve(CORDIS_PRESET_ID)
  if (typeof preset?.path !== 'string' || !isAbsolute(preset.path)) {
    throw new Error('ptc-plus: DSH cordis preset did not expose an absolute composition path')
  }
  if (typeof preset.broken === 'string' && preset.broken.length > 0) {
    throw new Error(`ptc-plus: DSH cordis preset is unavailable: ${preset.broken}`)
  }
  return join(dirname(preset.path), 'skills')
}

async function requireCompanionSkill(agent, skills) {
  const lookup = {
    cwd: agent.session?.header?.cwd,
    scope: agent,
  }
  const owned = (await skills.list(lookup)).filter(skill => skill?.provider === CORDIS_SKILL_PROVIDER)
  const summary = owned[0]
  if (owned.length !== 1 || summary?.name !== CORDIS_SKILL_NAME
    || summary.invocation?.modelInvocable !== true) {
    throw new Error(`ptc-plus: official Cordis Skill provider must publish exactly ${JSON.stringify(CORDIS_SKILL_NAME)} as model-invocable`)
  }
  const skill = await skills.get(CORDIS_SKILL_NAME, lookup)
  if (skill?.provider !== CORDIS_SKILL_PROVIDER
    || skill.invocation?.modelInvocable !== true
    || typeof skill.content !== 'string'
    || skill.content.length === 0) {
    throw new Error(`ptc-plus: official Cordis companion Skill ${JSON.stringify(CORDIS_SKILL_NAME)} is not loadable`)
  }
}

function createCordisInspectLeases(ctx) {
  let cordisInspect
  const requireCordisInspect = () => {
    if (typeof ctx?.get !== 'function') {
      throw new Error('ptc-plus: cordisToolsEnabled requires the DSH Context.get API')
    }
    cordisInspect ??= ctx.get('cordisInspect')
    if (typeof cordisInspect?.register !== 'function') {
      throw new Error('ptc-plus: cordisToolsEnabled requires the DSH cordisInspect.register API')
    }
    return cordisInspect
  }
  const providers = new Map()

  const register = (registration) => {
    const id = registration?.manifest?.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('ptc-plus: Cordis inspect registration requires a non-empty manifest id')
    }
    let provider = providers.get(id)
    if (provider === undefined) {
      const registrations = new Set([registration])
      const delegated = {
        ...registration,
        query(...args) {
          const current = registrations.values().next().value
          return Reflect.apply(current.query, current, args)
        },
      }
      provider = {
        manifest: registration.manifest,
        registrations,
        dispose: requireCordisInspect().register(delegated),
      }
      if (typeof provider.dispose !== 'function') {
        throw new Error(`ptc-plus: Cordis inspect provider "${id}" did not return a disposer`)
      }
      providers.set(id, provider)
    } else {
      if (!isDeepStrictEqual(provider.manifest, registration.manifest)) {
        throw new Error(`ptc-plus: Cordis inspect provider "${id}" changed its manifest across agent scopes`)
      }
      provider.registrations.add(registration)
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      provider.registrations.delete(registration)
      if (provider.registrations.size > 0) return
      providers.delete(id)
      provider.dispose()
    }
  }

  const facade = new Proxy({}, {
    get(_target, property) {
      if (property === 'register') return register
      const target = requireCordisInspect()
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return Object.freeze({
    plugin(cordisPlugin) {
      return {
        ...cordisPlugin,
        apply(pluginCtx, config) {
          if (typeof pluginCtx?.extend !== 'function') {
            throw new Error('ptc-plus: cordisToolsEnabled requires the DSH Context.extend API')
          }
          return cordisPlugin.apply(pluginCtx.extend({ cordisInspect: facade }), config)
        },
      }
    },
    dispose() {
      const failures = []
      for (const provider of providers.values()) {
        try {
          provider.dispose()
        } catch (error) {
          failures.push(error)
        }
      }
      providers.clear()
      if (failures.length > 0) {
        throw new AggregateError(failures, 'ptc-plus Cordis inspect lease disposal failed')
      }
    },
  })
}

/** Own the official Cordis tool and companion Skill fibers in PTC agent scopes. */
export function createCordisToolsOwner(
  ctx,
  cordisPlugin = CordisTools,
  skillFilesystemPlugin = CordisSkillFilesystem,
) {
  if (typeof ctx?.agents?.list !== 'function') {
    throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agents.list API')
  }
  const mounts = new Map()
  const pending = new Set()
  const cordisInspectLeases = createCordisInspectLeases(ctx)
  const scopedCordisPlugin = cordisInspectLeases.plugin(cordisPlugin)
  const scopedSkillPlugin = exactCompanionSkillPlugin(skillFilesystemPlugin)
  let disposed = false

  const leafErrors = error => error instanceof AggregateError
    ? error.errors.flatMap(leafErrors)
    : [error]
  const activationCleanupError = (activationError, cleanupError) => new AggregateError(
    [...new Set([...leafErrors(activationError), ...leafErrors(cleanupError)])],
    'ptc-plus: Cordis activation and cleanup failed',
    { cause: activationError },
  )

  const disposeMount = (agent, mount) => {
    mount.disposed = true
    if (mount.disposal === undefined) {
      const operation = (async () => {
        const failures = []
        const fibers = [...mount.fibers].reverse()
        const results = await Promise.allSettled(fibers.map(fiber => {
          try {
            return Promise.resolve(fiber.dispose())
          } catch (error) {
            return Promise.reject(error)
          }
        }))
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]
          const fiber = fibers[index]
          if (result.status === 'rejected') failures.push(result.reason)
          else {
            const ownedIndex = mount.fibers.indexOf(fiber)
            if (ownedIndex !== -1) mount.fibers.splice(ownedIndex, 1)
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'ptc-plus Cordis agent mount disposal failed')
        }
      })()
      mount.disposal = operation
      operation.then(
        () => { if (mount.disposal === operation) mount.disposal = undefined },
        () => { if (mount.disposal === operation) mount.disposal = undefined },
      )
    }
    return mount.disposal.then(() => {
      if (mounts.get(agent) === mount) mounts.delete(agent)
    })
  }

  const disposeAgent = async (agent) => {
    pending.delete(agent)
    const mount = mounts.get(agent)
    if (mount === undefined) return
    await disposeMount(agent, mount)
  }

  const installAgent = (agent) => {
    if (disposed) return Promise.resolve()
    const mounted = mounts.get(agent)
    if (mounted !== undefined) return mounted.activation
    if (agent?.ctx?.tools?.get?.(RUN_CODE, agent) === undefined) {
      pending.add(agent)
      return Promise.resolve()
    }
    pending.delete(agent)
    if (typeof agent.ctx.plugin !== 'function') {
      throw new Error('ptc-plus: cordisToolsEnabled requires the DSH agent Context.plugin API')
    }
    const mount = {
      fibers: [],
      activation: undefined,
      disposal: undefined,
      activated: false,
      disposed: false,
    }
    mounts.set(agent, mount)
    mount.activation = Promise.resolve().then(async () => {
      const { agentPresets, skills } = requireCompanionServices(agent)
      const skillDirectory = await companionSkillDirectory(agentPresets)
      if (mount.disposed) return

      const skillFiber = agent.ctx.plugin(scopedSkillPlugin, {
        providerName: CORDIS_SKILL_PROVIDER,
        includeDefaultRoots: false,
        customSkillDirs: [skillDirectory],
      })
      if (typeof skillFiber?.dispose !== 'function') {
        throw new Error('ptc-plus: DSH Context.plugin did not return a disposable Cordis Skill fiber')
      }
      mount.fibers.push(skillFiber)
      requireFiberServices(agent, skillFiber, 'Cordis Skill')
      await Promise.resolve(skillFiber)
      if (mount.disposed) return

      const cordisFiber = agent.ctx.plugin(scopedCordisPlugin)
      if (typeof cordisFiber?.dispose !== 'function') {
        throw new Error('ptc-plus: DSH Context.plugin did not return a disposable Cordis tool fiber')
      }
      mount.fibers.push(cordisFiber)
      requireFiberServices(agent, cordisFiber, 'Cordis tool')
      await Promise.resolve(cordisFiber)
      if (mount.disposed) return

      await requireCompanionSkill(agent, skills)
      if (mount.disposed) return
      mount.activated = true
    }).catch(async error => {
      if (!mount.disposed) {
        try {
          await disposeMount(agent, mount)
        } catch (cleanupError) {
          throw activationCleanupError(error, cleanupError)
        }
      }
      throw error
    })
    return mount.activation
  }

  const promptAssembly = async (_assembly, context, next) => {
    const agent = context?.scope
    if (agent === undefined || mounts.get(agent)?.activated === true) return next()
    await installAgent(agent)
    if (disposed || mounts.get(agent)?.activated !== true) return next()
    if (typeof ctx.systemPrompt?.assemble !== 'function') {
      throw new Error('ptc-plus: cordisToolsEnabled requires the DSH systemPrompt.assemble API')
    }
    return ctx.systemPrompt.assemble(context)
  }
  const retryPending = () => {
    if (disposed || pending.size === 0) return
    queueMicrotask(() => {
      if (disposed) return
      for (const agent of [...pending]) {
        void Promise.resolve().then(() => installAgent(agent)).catch(error => {
          pending.delete(agent)
          ctx.logger?.warn?.('ptc-plus: deferred Cordis activation failed', error)
        })
      }
    })
  }
  let stopCreated
  let stopDisposed
  let stopPromptAssembly
  let stopToolsChange
  let initialActivations
  try {
    stopPromptAssembly = ctx.on('system-prompt/assemble', promptAssembly, { prepend: true })
    stopCreated = ctx.on('agent/created', ({ agent }) => installAgent(agent))
    stopDisposed = ctx.on('agent/disposed', ({ agent }) => disposeAgent(agent))
    stopToolsChange = ctx.on('tools/change', retryPending)
    initialActivations = ctx.agents.list().map(installAgent)
  } catch (error) {
    stopToolsChange?.()
    stopDisposed?.()
    stopCreated?.()
    stopPromptAssembly?.()
    for (const [agent, mount] of mounts) {
      void mount.activation?.catch(() => {})
      void disposeMount(agent, mount)
    }
    cordisInspectLeases.dispose()
    throw error
  }

  let disposal
  let leasesDisposed = false
  const dispose = () => {
    if (disposal !== undefined) return disposal
    disposed = true
    stopToolsChange?.()
    stopToolsChange = undefined
    stopDisposed?.()
    stopDisposed = undefined
    stopCreated?.()
    stopCreated = undefined
    stopPromptAssembly?.()
    stopPromptAssembly = undefined
    pending.clear()
    const owned = [...mounts.entries()]
    const attempts = owned.map(([agent, mount]) => disposeMount(agent, mount))
    const operation = Promise.allSettled(attempts).then(results => {
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (!leasesDisposed) {
        try {
          cordisInspectLeases.dispose()
          leasesDisposed = true
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'ptc-plus Cordis disposal failed')
    })
    disposal = operation
    operation.then(
      () => { if (disposal === operation) disposal = undefined },
      () => { if (disposal === operation) disposal = undefined },
    )
    return operation
  }
  const ready = Promise.all(initialActivations).then(() => undefined).catch(async error => {
    try {
      await dispose()
    } catch (cleanupError) {
      throw activationCleanupError(error, cleanupError)
    }
    throw error
  })
  return Object.freeze({
    ready,
    dispose,
  })
}
