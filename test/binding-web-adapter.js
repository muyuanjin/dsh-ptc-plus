import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { rpcDescriptor } from '../internal/rpc-contract.js'
import { readFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const scenario = JSON.parse(readFileSync(new URL('../scripts/binding-workflow-scenario.json', import.meta.url), 'utf8'))
// A settled answer near the desktop viewport height exercises process disclosure across the scroll boundary.
const answer = Array.from({ length: 14 }, (_, index) => `Review item ${index + 1}: the binding draft is ready for review.`).join('\n\n')
// The probe marker lets the acceptance start a turn the fixture itself holds open.
export const probeMarker = '[[ptc-approval-probe]]'
export const probeReason = 'fixture probe requires one Host approval decision'
export const inject = ['llm', 'typert', 'settings', 'workspaceRegistry', 'tools']

/** Deterministic Web fixture: no HTTP provider, credentials, or model requests. */
export function apply(ctx) {
  // The acceptance arms, holds, and releases one probe through the fixture Remote so the
  // workbench can hold unsaved text while the real Host approval owns the composer.
  let probesArmed = 0
  let probesHolding = 0
  let probeCredits = 0
  const probeWaiters = []
  const waitForProbeCredit = () => new Promise(resolve => {
    if (probeCredits > 0) {
      probeCredits -= 1
      resolve()
      return
    }
    probeWaiters.push(resolve)
  })
  const releaseProbe = () => {
    const waiter = probeWaiters.shift()
    if (waiter === undefined) probeCredits += 1
    else waiter()
  }
  const service = { async invoke(method, args) {
    if (method === 'settings/update') {
      await ctx.settings.update(args.ns, args.patch)
    } else if (method === 'workspace/create') {
      await ctx.workspaceRegistry.create(args.request.path)
    } else if (method === 'probe/arm') {
      probesArmed += 1
    } else if (method === 'probe/release') {
      releaseProbe()
    } else if (method === 'probe/status') {
      return { ok: true, value: { armed: probesArmed, holding: probesHolding } }
    } else {
      throw new Error(`Unknown Web fixture method: ${method}`)
    }
    return { ok: true, value: null }
  } }
  service.typertRemote = bindTypertRemote(service, 'ptcWebFixture')
  ctx.effect(() => ctx.provide('ptcWebFixture', service))
  ctx.effect(() => ctx.typert.register({
    package: 'ptc-binding-web-fixture', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [{ ...rpcDescriptor({ service: 'ptcWebFixture' }), id: 'ptc-binding-web-fixture#ptcWebFixture/invoke' }],
  }))
  // One scoped ask source: only this probe reaches the real Host approval seam, so every
  // other tool keeps the profile's approval policy and the Host owns the decision.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ptcSmokeApprovalProbe',
    description: 'Deterministic fixture probe that always requires one Host approval decision.',
    parameters: { note: { type: 'string', description: 'Opaque marker echoed back in the result.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return { note: args.note ?? '' } },
  })))
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'ptcSmokeApprovalProbe'
    ? { kind: 'ask', reason: probeReason }
    : next())
  const submitted = new Set()
  let callSequence = 0
  let probeSequence = 0
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const text = options.messages.flatMap(message => message.content ?? [])
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.includes(probeMarker) && probesArmed > 0) {
        probesArmed -= 1
        probesHolding += 1
        try {
          await waitForProbeCredit()
        } finally {
          probesHolding -= 1
        }
        const block = { type: 'tool-call', id: `web-probe-${++probeSequence}`, name: 'run_code',
          arguments: JSON.stringify({ code: 'return await tools.ptcSmokeApprovalProbe({ note: "probe" })',
            description: 'Approval probe' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const request = [...text.matchAll(/requestId: ("[^"\n]+")/g)].at(-1)
      if (request && !submitted.has(request[1])) {
        submitted.add(request[1])
        await new Promise(resolve => setTimeout(resolve, 800))
        const entry = callSequence === 0 ? scenario.entry : { ...scenario.entry,
          source: Array.from({ length: 180 }, (_, index) => `// Source review line ${index + 1}`).join('\n')
            + `\n${scenario.entry.source}\n// End of long binding source`,
          modelContext: { includeDeclaration: true, instructions: 'Use this helper to return a number.' },
        }
        const block = { type: 'tool-call', id: `web-binding-${++callSequence}`, name: 'run_code',
          arguments: JSON.stringify({ code: `const previewNumber = await Promise.resolve(42); const previewText = "hello"; const previewBigint = 123n; return code.submitBindingDraft(${JSON.stringify({ requestId: JSON.parse(request[1]), entry })})`, description: 'Submit binding draft' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['binding-web-fixture'], new Adapter()))
}
