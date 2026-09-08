import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as hostLlm from '@deepseek-ai/dsh-llm'

// Public RequestHeaderReason vocabulary; values describe events, never releases.
export const HOST_HEADER_REASONS = Object.freeze(['initial', 'resume', 'change', 'series'])

/** Usage chunks are never delta-packed in the public AssistantStreamRecord format. */
export function hostAssistantUsageEvents(event) {
  if (!['assistant/message', 'assistant/attempt'].includes(event?.type)
    || event.data?.stream === undefined) return undefined
  if (!Array.isArray(event.data.stream)) throw new TypeError('assistant stream must be an array')
  if (typeof hostLlm.expandAssistantStream === 'function') {
    return hostLlm.expandAssistantStream(event.data.stream)
      .filter(({ chunk }) => chunk.type === 'usage').map(({ chunk }) => chunk.usage)
  }
  const usage = []
  for (const record of event.data.stream) {
    if (record?.type === 'chunk') {
      if (!Number.isSafeInteger(record.time) || typeof record.chunk?.type !== 'string') {
        throw new TypeError('invalid assistant stream chunk')
      }
      if (record.chunk.type === 'usage') usage.push(record.chunk.usage)
    } else {
      // Older hosts have no compact-stream reader. Only raw records carry usage;
      // check the public run envelope without expanding its text or tool deltas.
      if (!['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record?.type)) {
        throw new TypeError('unsupported assistant stream record')
      }
      const members = record.type === 'tool-call-chunks' ? record.args : record.texts
      if (!Number.isSafeInteger(record.time0) || !Number.isSafeInteger(record.index) || record.index < 0
        || !Array.isArray(members) || members.length === 0 || members.some(item => typeof item !== 'string')
        || !Array.isArray(record.dt) || record.dt.length !== members.length - 1
        || record.dt.some(gap => !Number.isSafeInteger(gap))
        || (record.type === 'tool-call-chunks' && (typeof record.id !== 'string' || record.id === ''))) {
        throw new TypeError('invalid assistant stream run')
      }
    }
  }
  return usage
}

export function hostRequire(dshEntry) {
  if (dshEntry === undefined) return createRequire(import.meta.url)
  const filename = process.platform !== 'win32'
    ? dshEntry.replace(/^([a-zA-Z]):[\\/]/, (_match, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/')
    : dshEntry
  return createRequire(resolve(filename))
}

/** Read the selected host's public tools schema without mounting a runtime. */
export function hostToolRuntime(dshEntry) {
  return dshEntry === undefined ? ToolRuntime : hostRequire(dshEntry)('@deepseek-ai/dsh-tools').ToolRuntime
}

/** PTC presentation was previously named code; the host schema owns the spelling. */
export function ptcToolsMode(runtime = ToolRuntime) {
  for (const mode of ['ptc', 'code']) {
    try {
      runtime.Config({ mode })
      return mode
    } catch {}
  }
  throw new Error('The DSH tools schema supports neither ptc nor code presentation')
}

function personaFields(config) {
  return config?.personaPrefix !== undefined || config?.personaSuffix !== undefined
    ? ['personaPrefix', 'personaSuffix'] : ['persona']
}

/** Preserve missing fields so callers can reject an incomplete Host configuration. */
export function readHostPersona(config) {
  const [prefix, suffix] = personaFields(config)
  return { prefix: config?.[prefix], suffix: suffix === undefined ? '' : config[suffix] }
}

/** Replace the whole persona, including any deployment-supplied suffix. */
export function hostPersonaPatch(config, text) {
  return Object.fromEntries(personaFields(config).map((field, index) => [field, index === 0 ? text : '']))
}
