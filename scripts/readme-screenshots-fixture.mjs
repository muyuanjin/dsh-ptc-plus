/**
 * Deterministic Host fixture for the README screenshot capture.
 *
 * This plugin exists only for `scripts/readme-screenshots.mjs`. It replaces the model route
 * with a local adapter and exposes the two settings/workspace operations the capture drives,
 * so a capture run needs no provider credentials, makes no model request, and never touches
 * the operator's profile. It carries no product behavior.
 *
 * The adapter answers the captured turn with one `run_code` call and then one short reply.
 * Every later request, including title or summary requests, receives the reply text, so the
 * captured transcript stays deterministic.
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { rpcDescriptor } from '../internal/rpc-contract.js'

export const SERVICE = 'ptcReadmeScreenshot'
const PACKAGE = 'dsh-ptc-plus-readme-screenshot'

/**
 * Prompts the capture submits, one per README locale. The session title is the first user
 * message, so each locale's frame carries a title in its own language.
 */
export const CAPTURE_PROMPTS = Object.freeze({
  zh: '把示例清单里的文件名整理成汇总报告',
  en: 'Summarize the sample manifest into a small report',
})

/** Reply text the capture waits for before it photographs the session. */
export const CAPTURE_REPLY = 'The manifest summary is ready and the retained names stay available for the next cell.'

/**
 * Cell the fixture runs. It is self-contained module-syntax TypeScript: the capture must keep
 * working when an operator changes the seeded global catalog.
 */
export const CAPTURE_CELL = [
  'import { basename, extname } from "node:path"',
  '',
  'const manifest = ["reports/q3.csv", "logs/app.log", "notes/todo.md"]',
  'const label = (files: readonly string[]) =>',
  '  files.map(file => basename(file, extname(file)).toUpperCase()).join(", ")',
  '',
  'export const summary = { label: label(manifest), count: manifest.length }',
  'return summary',
].join('\n')

export const inject = ['llm', 'typert', 'settings', 'workspaceRegistry']

export function apply(ctx) {
  const service = {
    async invoke(method, args) {
      if (method === 'settings/update') await ctx.settings.update(args.ns, args.patch)
      else if (method === 'workspace/create') await ctx.workspaceRegistry.create(args.request.path)
      else throw new Error(`Unknown readme screenshot fixture method: ${method}`)
      return { ok: true, value: null }
    },
  }
  service.typertRemote = bindTypertRemote(service, SERVICE)
  ctx.effect(() => ctx.provide(SERVICE, service))
  ctx.effect(() => ctx.typert.register({
    package: PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [{ ...rpcDescriptor({ service: SERVICE }), id: `${PACKAGE}#${SERVICE}/invoke` }],
  }))

  class ScreenshotAdapter extends LlmAdapter {
    async *stream(options) {
      // Each captured session runs the cell on its own first turn; a later request in the
      // same session, and every title or summary request, receives the reply text instead.
      const answered = (options.messages ?? []).some(message => message.role === 'assistant' || message.role === 'tool')
      if (answered) {
        yield { type: 'text-delta', index: 0, text: CAPTURE_REPLY }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: CAPTURE_REPLY } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const block = {
        type: 'tool-call', id: 'readme-screenshot-cell', name: 'run_code',
        arguments: JSON.stringify({ code: CAPTURE_CELL, description: 'Summarize the sample manifest' }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['readme-screenshot-fixture'], new ScreenshotAdapter()))
}
