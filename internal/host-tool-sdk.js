/**
 * The host package that renders tool schemas for the model has moved between
 * releases: 0.2.2-alpha.2 publishes `jsonSchemaToTs`, `renderToolsSdk`,
 * `jsonSchemaToPy` and `CodeRunFailedError` from `@deepseek-ai/dsh-tool-executor-ptc`
 * and no longer exports them from `@deepseek-ai/dsh-tools`; earlier hosts publish
 * them only from `@deepseek-ai/dsh-tools`. A static import from either path makes
 * the plugin fail to load on the other, so the binding is resolved once, at load
 * time, from whichever package actually provides it.
 */
const CANDIDATES = [
  '@deepseek-ai/dsh-tool-executor-ptc',
  '@deepseek-ai/dsh-tools',
]

let api
let loadedFrom
for (const specifier of CANDIDATES) {
  try {
    const candidate = await import(specifier)
    if (typeof candidate.jsonSchemaToTs === 'function' && typeof candidate.renderToolsSdk === 'function') {
      api = candidate
      loadedFrom = specifier
      break
    }
  } catch {
    // The package is absent on this host; try the next candidate.
  }
}

if (api === undefined) {
  throw new Error('ptc-plus: no host package provides the tool schema renderers')
}

export const hostToolSdkPackage = loadedFrom
export const jsonSchemaToTs = api.jsonSchemaToTs
export const renderToolsSdk = api.renderToolsSdk
export const ToolNotFoundError = api.ToolNotFoundError
