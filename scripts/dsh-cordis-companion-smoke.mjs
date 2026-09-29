/** Exercise a packed Cordis owner against an active-host package resource. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SKILL_NAME = 'cordis-plugin-development'
const PROVIDER_NAME = 'ptc-plus-cordis'

async function main() {
  const activePackage = process.env.DSH_PTC_ACTIVE_PRESET_PACKAGE
  if (activePackage === undefined) {
    throw new Error('dsh-cordis-companion-smoke: DSH_PTC_ACTIVE_PRESET_PACKAGE is required')
  }
  const activeSkillDirectory = join(activePackage, 'skills')
  const activeSkillFile = join(activeSkillDirectory, SKILL_NAME, 'SKILL.md')
  const activeContent = readFileSync(activeSkillFile, 'utf8')

  const require = createRequire(join(process.cwd(), 'noop.cjs'))
  const pluginRoot = dirname(require.resolve('dsh-ptc-plus/package.json'))
  const ownerUrl = pathToFileURL(join(pluginRoot, 'internal', 'cordis-tools-owner.js'))
  const ownerRequire = createRequire(ownerUrl)
  const staleManifest = ownerRequire.resolve('@deepseek-ai/dsh-agent-presets/package.json')
  assert.match(readFileSync(staleManifest, 'utf8'), /0\.0\.0-stale/)
  const { createCordisToolsOwner } = await import(ownerUrl.href)

  const definitions = new Map([
    ['run_code', { name: 'run_code' }],
    ['skill', { name: 'skill' }],
  ])
  let provider
  const skills = {
    registerProvider(create) {
      provider = create({ signal: new AbortController().signal, invalidate() {} })
      return () => { provider = undefined }
    },
    async list() {
      if (provider === undefined) return []
      const candidates = await provider.list({})
      return candidates.map(({ content: _content, ...candidate }) => candidate)
    },
    async get(name) {
      if (provider === undefined) return undefined
      const candidates = await provider.list({})
      const candidate = candidates.find(item => item.name === name)
      return candidate === undefined ? undefined : provider.get(candidate, {})
    },
  }
  const services = new Map([
    ['agentPresets', { resolve: async id => ({ id }) }],
    ['skills', skills],
  ])
  const agentContext = {
    tools: {
      get(name) { return definitions.get(name) },
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    get(name) { return services.get(name) },
    extend(meta) { return Object.assign(Object.create(this), meta) },
    plugin(plugin, config) {
      const disposers = []
      const pluginContext = this.extend({
        effect(setup) {
          const dispose = setup()
          disposers.push(dispose)
          return dispose
        },
      })
      plugin.apply(pluginContext, config)
      return {
        inject: Object.fromEntries((plugin.inject ?? []).map(name => [name, null])),
        async dispose() {
          for (const dispose of disposers.reverse()) await dispose()
        },
      }
    },
  }
  const agent = {
    id: 'packed-pathless-cordis',
    session: { header: { cwd: process.cwd() } },
    ctx: agentContext,
  }
  const listeners = new Map()
  const hostBaseUrl = pathToFileURL(join(process.cwd(), 'active-profile', 'cordis.yml')).href
  const pluginPackages = {
    packageOf(name, parentURL) {
      assert.equal(parentURL, hostBaseUrl)
      if (name !== '@deepseek-ai/dsh-agent-preset') return undefined
      return { name, dir: activePackage }
    },
  }
  const host = {
    baseUrl: hostBaseUrl,
    agents: { list: () => [agent] },
    get(name) {
      if (name === 'pluginPackages') return pluginPackages
      return undefined
    },
    on(name, listener) {
      const owned = listeners.get(name) ?? new Set()
      owned.add(listener)
      listeners.set(name, owned)
      return () => owned.delete(listener)
    },
    logger: { warn() {} },
    systemPrompt: { async assemble(value) { return value } },
  }
  const fakeCordisPlugin = {
    name: 'packed-cordis-tool',
    apply(ctx) {
      ctx.effect(() => ctx.tools.register({ name: 'cordis_probe' }))
    },
  }
  const fakeSkillPlugin = {
    name: 'packed-skill-filesystem',
    inject: ['skills'],
    apply(ctx, config) {
      assert.equal(config.bundledSkillDir, activeSkillDirectory)
      assert.equal(config.watch, false)
      ctx.effect(() => ctx.skills.registerProvider(() => ({
        name: config.providerName,
        async list() {
          return [{
            name: SKILL_NAME,
            provider: config.providerName,
            invocation: { modelInvocable: true },
            content: activeContent,
          }]
        },
        async get(candidate) {
          return { ...candidate, content: activeContent }
        },
      })))
    },
  }

  const owner = createCordisToolsOwner(host, fakeCordisPlugin, fakeSkillPlugin)
  await owner.ready
  assert.equal(definitions.has('cordis_probe'), true)
  const mounted = await skills.get(SKILL_NAME)
  assert.equal(mounted?.provider, PROVIDER_NAME)
  assert.equal(mounted?.content, activeContent)
  assert.doesNotMatch(mounted.content, /stale companion/)
  await owner.dispose()
  assert.equal(definitions.has('cordis_probe'), false)
  assert.equal(provider, undefined)
  console.log(`mounted the active Host's pathless Cordis companion Skill from ${activeSkillDirectory}`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
