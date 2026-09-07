import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

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
