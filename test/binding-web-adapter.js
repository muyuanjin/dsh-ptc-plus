import { readFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const scenario = JSON.parse(readFileSync(new URL('../scripts/binding-workflow-scenario.json', import.meta.url), 'utf8'))
// A settled answer near the desktop viewport height exercises process disclosure across the scroll boundary.
const answer = Array.from({ length: 14 }, (_, index) => `Review item ${index + 1}: the binding draft is ready for review.`).join('\n\n')
export const inject = ['llm']

/** Deterministic Web fixture: no HTTP provider, credentials, or model requests. */
export function apply(ctx) {
  const submitted = new Set()
  let callSequence = 0
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const text = options.messages.flatMap(message => message.content ?? [])
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      const request = [...text.matchAll(/requestId: ("[^"\n]+")/g)].at(-1)
      if (request && !submitted.has(request[1])) {
        submitted.add(request[1])
        await new Promise(resolve => setTimeout(resolve, 800))
        const block = { type: 'tool-call', id: `web-binding-${++callSequence}`, name: 'run_code',
          arguments: JSON.stringify({ code: `return code.submitBindingDraft(${JSON.stringify({ requestId: JSON.parse(request[1]), entry: scenario.entry })})`, description: 'Submit binding draft' }) }
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
