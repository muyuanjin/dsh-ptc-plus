import assert from 'node:assert/strict'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { isPtcMessageSource } from '../internal/message-sources.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import * as ptc from '../index.js'
import { ptcToolsMode } from '../scripts/dsh-host-contract.mjs'
import { sessionEvents } from '../internal/session-events.js'

export async function bindingWorkflowHost(t) {
  const home = await mkdtemp(join(tmpdir(), 'ptc-binding-workflow-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const fibers = []
  let handle
  t.after(async () => {
    await handle?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  const upstreamRuntime = {
    language: 'typescript', isolation: 'worker-thread',
    async run() { throw new Error('unexpected isolated runtime') },
  }
  ctx.provide('codeRuntime', upstreamRuntime)
  ctx.provide('ptcRuntime', {
    ...upstreamRuntime,
    resolve(request) {
      return { ...request, cwd: request.cwd ?? home, timeoutMs: request.timeoutMs ?? null }
    },
  })
  for (const plugin of [TypertRegistry, SystemPrompt, SessionStore, AgentRegistry, LlmRuntime,
    SessionProjectionRegistry, ToolRuntime, CommandRuntime, AgentLoop]) {
    const config = plugin === ToolRuntime ? { mode: ptcToolsMode() }
      : plugin === SystemPrompt ? { includeHarnessIdentity: false, persona: '' } : undefined
    const fiber = ctx.plugin(plugin, config)
    fibers.push(fiber)
    await fiber.await()
  }
  const requests = []
  const programs = []
  let callId = 0
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const operation = programs.shift()
      if (operation !== undefined) {
        const code = typeof operation === 'function' ? operation(options) : operation
        const block = { type: 'tool-call', id: `binding-call-${++callId}`, name: 'run_code',
          arguments: JSON.stringify({ code, description: 'Verify binding workflow contract' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const adapter = ctx.plugin({ inject: ['llm'], apply(scope) {
    scope.effect(() => scope.llm.registerAdapter(['binding-fixture'], new Adapter()))
  } })
  fibers.push(adapter)
  await adapter.await()
  const config = { userBindingsEnabled: true, computeMs: 3000, maxWallMs: 5000 }
  let feature = ctx.plugin(ptc, config)
  fibers.push(feature)
  await feature.await()
  handle = await ctx.agents.create({ sessionId: 'binding-workflow',
    meta: { cwd: home },
    agentOptions: { provider: 'binding-fixture', model: 'binding-fixture' } })
  const agent = handle.agent
  await new Promise(resolve => setImmediate(resolve))
  const idleAfter = async operation => {
    let release
    let failure
    const idle = new Promise(resolve => {
      release = ctx.on('agent/status', payload => {
        if (payload.agent === agent && payload.status === 'idle') resolve()
      })
    })
    const releaseError = ctx.on('agent/error', payload => {
      if (payload.agent === agent) failure = payload.error
    })
    try {
      const value = await operation()
      await idle
      if (failure !== undefined) throw failure
      return value
    } finally {
      releaseError()
      release()
    }
  }
  const events = () => sessionEvents(agent.session).map(event => {
    sessionFormatCatalog.encodeCurrentEvent(event)
    return event
  })
  const run = async (program, text = 'Execute the requested verification cell.') => {
    programs.push(program)
    await idleAfter(() => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })))
    return events().filter(event => event.type === 'tool/result').at(-1)
  }
  const begin = async (requirement = 'new simple helper', program) => {
    if (program !== undefined) programs.push(...(Array.isArray(program) ? program : [program]))
    return idleAfter(() => ctx.commands.execute(agent, `/binding ${requirement}`, [], new AbortController().signal))
  }
  const requestId = () => {
    const message = events().filter(event => event.type === 'user/message'
      && isPtcMessageSource(event.data.source) && event.data.source.form === 'instructions').at(-1).data
    return JSON.parse(/requestId: ("[^"\n]+")/.exec(message.content[0].text)[1])
  }
  return { ctx, agent, requests, events, run, begin, requestId, home,
    async restart() {
      await feature.dispose()
      feature = ctx.plugin(ptc, config)
      fibers.push(feature)
      await feature.await()
      await new Promise(resolve => setImmediate(resolve))
    },
    rpc: (endpoint, payload = {}) => ctx.get('ptcPlusBindings').invoke(endpoint, payload, new AbortController().signal) }
}
