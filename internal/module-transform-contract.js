export const LEGACY_USER_BINDING_TRANSFORM = 'amaro@1.1.11'
export const PREVIOUS_USER_BINDING_TRANSFORM = 'stateful-module-v1+amaro@1.1.11'
export const USER_BINDING_TRANSFORM = 'stateful-module-v2+amaro@1.1.11'
export const PROTECTED_MODULE_TRANSFORM = 'protected-module-v1+amaro@1.1.11'
export const MODULE_TRANSFORMS = new Set([
  LEGACY_USER_BINDING_TRANSFORM,
  PREVIOUS_USER_BINDING_TRANSFORM,
  USER_BINDING_TRANSFORM,
  PROTECTED_MODULE_TRANSFORM,
])

export function isStatefulUserBindingTransform(transform) {
  return transform === USER_BINDING_TRANSFORM || transform === PREVIOUS_USER_BINDING_TRANSFORM
}

export function moduleTransformForLanguage(languageSemantics) {
  return languageSemantics === 'stateful-v1' ? USER_BINDING_TRANSFORM
    : languageSemantics === 'protected-v1' ? PROTECTED_MODULE_TRANSFORM : LEGACY_USER_BINDING_TRANSFORM
}

export function historicalModuleTransformForLanguage(languageSemantics) {
  return languageSemantics === 'stateful-v1' ? PREVIOUS_USER_BINDING_TRANSFORM
    : languageSemantics === 'protected-v1' ? PROTECTED_MODULE_TRANSFORM : LEGACY_USER_BINDING_TRANSFORM
}

export function moduleTransformMatchesLanguage(transform, languageSemantics) {
  return languageSemantics === 'stateful-v1' ? isStatefulUserBindingTransform(transform)
    : languageSemantics === 'protected-v1' ? transform === PROTECTED_MODULE_TRANSFORM
      : languageSemantics === 'legacy-v1' ? transform === LEGACY_USER_BINDING_TRANSFORM : false
}

export function normalizeModuleTransform(transform, languageSemantics) {
  if (!MODULE_TRANSFORMS.has(transform)) throw new TypeError('invalid dsh-ptc-plus journal module transform')
  if (!moduleTransformMatchesLanguage(transform, languageSemantics)) {
    throw new TypeError('dsh-ptc-plus journal module transform does not match its language semantics')
  }
  return transform
}

export function supportedUserBindingTransform(transform) {
  return isStatefulUserBindingTransform(transform) || transform === LEGACY_USER_BINDING_TRANSFORM
}
