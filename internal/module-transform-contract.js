export const LEGACY_USER_BINDING_TRANSFORM = 'amaro@1.1.11'
export const USER_BINDING_TRANSFORM = 'stateful-module-v1+amaro@1.1.11'
export const PROTECTED_MODULE_TRANSFORM = 'protected-module-v1+amaro@1.1.11'

export function moduleTransformForLanguage(languageSemantics) {
  return languageSemantics === 'stateful-v1' ? USER_BINDING_TRANSFORM
    : languageSemantics === 'protected-v1' ? PROTECTED_MODULE_TRANSFORM : LEGACY_USER_BINDING_TRANSFORM
}

export function supportedUserBindingTransform(transform) {
  return transform === USER_BINDING_TRANSFORM || transform === LEGACY_USER_BINDING_TRANSFORM
}
