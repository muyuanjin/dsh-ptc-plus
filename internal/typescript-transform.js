import loadAmaro from './compiler-amaro.cjs'

export { LEGACY_USER_BINDING_TRANSFORM, PREVIOUS_USER_BINDING_TRANSFORM, USER_BINDING_TRANSFORM,
  PROTECTED_MODULE_TRANSFORM, isStatefulUserBindingTransform,
  historicalModuleTransformForLanguage, moduleTransformForLanguage, moduleTransformMatchesLanguage,
  normalizeModuleTransform, supportedUserBindingTransform } from './module-transform-contract.js'

/** Keep binding-module lowering independent of the Host's experimental transform API. */
export function transformTypeScriptModule(source) {
  return transformTypeScriptSource(source).code
}

export function transformTypeScriptSource(source, options = {}) {
  try {
    return loadAmaro().transformSync(source, { mode: 'transform', sourceMap: false, ...options })
  } catch (error) {
    if (error instanceof Error) throw error
    throw new SyntaxError(error.message, { cause: error })
  }
}

let nativeUsingSupport

/** Node 22.19 does not parse explicit resource declarations by default. Keep
 * one compiler-owned fallback so every source entry gets the same disposal
 * semantics until the host parser proves native support. */
export function supportsNativeUsing() {
  if (nativeUsingSupport !== undefined) return nativeUsingSupport
  try { Function('using __ptc_resource = null')(); nativeUsingSupport = true } catch { nativeUsingSupport = false }
  return nativeUsingSupport
}
